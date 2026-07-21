import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BACKGROUND_PROGRAM_NAME } from "./background-program.js";

const execFileAsync = promisify(execFile);
const startupKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

export function backgroundStartupRegistryValue(programPath: string): {
  key: string;
  name: string;
  command: string;
} {
  return {
    key: startupKey,
    name: BACKGROUND_PROGRAM_NAME,
    command: `"${programPath}" --scheduler`,
  };
}

export async function setBackgroundStartup(programPath: string, enabled: boolean): Promise<void> {
  const value = backgroundStartupRegistryValue(programPath);
  if (enabled) {
    await execFileAsync("reg.exe", ["ADD", value.key, "/v", value.name, "/t", "REG_SZ", "/d", value.command, "/f"], { windowsHide: true });
    return;
  }
  try {
    await execFileAsync("reg.exe", ["DELETE", value.key, "/v", value.name, "/f"], { windowsHide: true });
  } catch (cause: unknown) {
    const code = typeof cause === "object" && cause && "code" in cause ? Number(cause.code) : undefined;
    if (code !== 1) throw cause;
  }
}
