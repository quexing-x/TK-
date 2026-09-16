import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface BackupInspection {
  sizeBytes: number;
  sha256: string;
  valid: boolean;
  errorMessage: string | null;
}

interface RestoreRequest {
  backupPath: string;
  sha256: string;
  requestedAt: string;
}

export interface AppliedRestore {
  databasePath: string;
  markerPath: string;
  rollbackPath: string | null;
}

export function createConsistentSnapshot(
  database: DatabaseSync,
  backupPath: string,
): BackupInspection {
  mkdirSync(dirname(backupPath), { recursive: true });
  rmSync(backupPath, { force: true });
  database.prepare("VACUUM INTO ?").run(backupPath);
  return inspectDatabaseBackup(backupPath);
}

export function inspectDatabaseBackup(backupPath: string): BackupInspection {
  if (!existsSync(backupPath)) {
    return { sizeBytes: 0, sha256: "0".repeat(64), valid: false, errorMessage: "备份文件不存在。" };
  }
  const sizeBytes = statSync(backupPath).size;
  const sha256 = hashFile(backupPath);
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(backupPath, { readOnly: true });
    const integrity = database.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
    const result = String(Object.values(integrity)[0] ?? "");
    if (result.toLowerCase() !== "ok") {
      return { sizeBytes, sha256, valid: false, errorMessage: `完整性检查失败：${result || "unknown"}` };
    }
    const required = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('accounts', 'schema_migrations')",
    ).all() as Array<{ name: string }>;
    if (required.length !== 2) {
      return { sizeBytes, sha256, valid: false, errorMessage: "备份缺少必要的数据表。" };
    }
    return { sizeBytes, sha256, valid: true, errorMessage: null };
  } catch (cause) {
    return {
      sizeBytes,
      sha256,
      valid: false,
      errorMessage: cause instanceof Error ? cause.message : "备份无法打开。",
    };
  } finally {
    database?.close();
  }
}

export function restoreDatabaseFiles(databasePath: string, backupPath: string): void {
  const replacementPath = `${databasePath}.restore-replacement.tmp`;
  const displacedPath = `${databasePath}.restore-displaced.tmp`;
  rmSync(replacementPath, { force: true });
  rmSync(displacedPath, { force: true });
  copyFileSync(backupPath, replacementPath);
  if (existsSync(databasePath)) renameSync(databasePath, displacedPath);
  try {
    renameSync(replacementPath, databasePath);
  } catch (cause) {
    if (existsSync(displacedPath)) renameSync(displacedPath, databasePath);
    throw cause;
  }
  rmSync(displacedPath, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
}

export function stageDatabaseRestore(
  databasePath: string,
  backupPath: string,
  sha256: string,
): void {
  const inspection = inspectDatabaseBackup(backupPath);
  if (!inspection.valid || inspection.sha256 !== sha256) {
    throw new Error(inspection.errorMessage ?? "备份校验值不匹配，禁止恢复。");
  }
  const markerPath = restoreMarkerPath(databasePath);
  const temporaryPath = `${markerPath}.tmp`;
  const request: RestoreRequest = {
    backupPath,
    sha256,
    requestedAt: new Date().toISOString(),
  };
  writeFileSync(temporaryPath, JSON.stringify(request), "utf8");
  renameSync(temporaryPath, markerPath);
}

export function hasPendingDatabaseRestore(databasePath: string): boolean {
  return databasePath !== ":memory:" && existsSync(restoreMarkerPath(databasePath));
}

export function applyPendingDatabaseRestore(databasePath: string): AppliedRestore | null {
  const markerPath = restoreMarkerPath(databasePath);
  if (!existsSync(markerPath)) return null;
  let rollbackPath: string | null = null;
  let rollbackReady = false;
  try {
    const request = JSON.parse(readFileSync(markerPath, "utf8")) as RestoreRequest;
    const inspection = inspectDatabaseBackup(request.backupPath);
    if (!inspection.valid || inspection.sha256 !== request.sha256) {
      throw new Error(inspection.errorMessage ?? "待恢复备份校验失败。");
    }
    rollbackPath = existsSync(databasePath)
      ? `${databasePath}.restore-rollback-${fileTimestamp()}.bak`
      : null;
    if (rollbackPath) {
      const database = new DatabaseSync(databasePath);
      try {
        const rollbackInspection = createConsistentSnapshot(database, rollbackPath);
        if (!rollbackInspection.valid) {
          throw new Error(rollbackInspection.errorMessage ?? "恢复前回滚快照校验失败。");
        }
        rollbackReady = true;
      } finally {
        database.close();
      }
    }
    restoreDatabaseFiles(databasePath, request.backupPath);
    return { databasePath, markerPath, rollbackPath };
  } catch (cause) {
    try {
      if (rollbackReady && rollbackPath && existsSync(rollbackPath)) {
        restoreDatabaseFiles(databasePath, rollbackPath);
      }
    } finally {
      rmSync(markerPath, { force: true });
    }
    throw cause;
  }
}

export function finalizePendingDatabaseRestore(applied: AppliedRestore): void {
  rmSync(applied.markerPath, { force: true });
}

export function rollbackPendingDatabaseRestore(applied: AppliedRestore): void {
  if (applied.rollbackPath && existsSync(applied.rollbackPath)) {
    restoreDatabaseFiles(applied.databasePath, applied.rollbackPath);
  } else {
    rmSync(applied.databasePath, { force: true });
    rmSync(`${applied.databasePath}-wal`, { force: true });
    rmSync(`${applied.databasePath}-shm`, { force: true });
  }
  rmSync(applied.markerPath, { force: true });
}

/**
 * 分块读着算哈希，不把整个文件读进内存。
 *
 * 原来是 `readFileSync(path)` 一次性读完。Node 的单次读有 2 GiB 硬上限，超了直接
 * `ERR_FS_FILE_TOO_LARGE`，而这个哈希是**迁移前备份的校验步骤**——于是库一旦超过
 * 2 GiB，任何带新迁移的版本都会在启动时抛「数据库迁移失败，服务未启动」，客户端
 * 再也升不上去。2026-09-17 生产机上就是这样：库 4.13 GB，1.4.142 装完起不来，
 * 现象是端口不监听、迁移记录不落库，看起来像新版本崩了。
 *
 * 备份文件按定义就是整库大小，只会越来越大，所以这里必须流式。
 */
export function hashFile(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  const handle = openSync(path, "r");
  try {
    let bytesRead = readSync(handle, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      bytesRead = readSync(handle, buffer, 0, buffer.length, null);
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}

function restoreMarkerPath(databasePath: string): string {
  return `${databasePath}.restore-request.json`;
}

function fileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
