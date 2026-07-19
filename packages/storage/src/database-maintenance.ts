import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
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

export function createRawPreMigrationBackup(databasePath: string): string | null {
  if (databasePath === ":memory:" || !existsSync(databasePath)) return null;
  const backupPath = `${databasePath}.pre-migration-${fileTimestamp()}.bak`;
  copyFileSync(databasePath, backupPath);
  for (const suffix of ["-wal", "-shm"] as const) {
    const sidecarPath = `${databasePath}${suffix}`;
    if (existsSync(sidecarPath)) copyFileSync(sidecarPath, `${backupPath}${suffix}`);
  }
  return backupPath;
}

export function promoteToConsistentSnapshot(
  database: DatabaseSync,
  backupPath: string,
): void {
  const temporaryPath = `${backupPath}.consistent.tmp`;
  rmSync(temporaryPath, { force: true });
  database.prepare("VACUUM INTO ?").run(temporaryPath);
  renameSync(temporaryPath, backupPath);
  rmSync(`${backupPath}-wal`, { force: true });
  rmSync(`${backupPath}-shm`, { force: true });
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

export function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function restoreMarkerPath(databasePath: string): string {
  return `${databasePath}.restore-request.json`;
}

function fileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
