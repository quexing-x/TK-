import { cpSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface DesktopRuntimePaths {
  dataDirectory: string;
  downloadDirectory: string;
  legacyDataDirectory: string;
}

export function resolveDesktopRuntimePaths(input: {
  downloadsDirectory: string;
  legacyUserDataDirectory: string;
  userDataDirectory: string;
}): DesktopRuntimePaths {
  return {
    dataDirectory: join(input.userDataDirectory, "data"),
    downloadDirectory: join(input.downloadsDirectory, "TK Ads Automation", "updates"),
    legacyDataDirectory: join(input.legacyUserDataDirectory, "data"),
  };
}

/**
 * Copies a pre-1.3.6 local data directory out of AppData without touching the
 * original. A temporary sibling makes an interrupted migration recoverable.
 */
export function migrateLegacyRuntimeData(paths: DesktopRuntimePaths): boolean {
  const source = resolve(paths.legacyDataDirectory);
  const destination = resolve(paths.dataDirectory);
  if (source === destination || existsSync(destination) || !existsSync(source)) {
    return false;
  }

  const temporary = `${destination}.migrating`;
  if (existsSync(temporary)) {
    throw new Error(`发现未完成的数据迁移目录：${temporary}`);
  }

  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, temporary, { recursive: true, errorOnExist: true });
  renameSync(temporary, destination);
  return true;
}
