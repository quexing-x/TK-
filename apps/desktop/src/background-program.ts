import { dirname, join } from "node:path";

export const BACKGROUND_PROGRAM_NAME = "tk自动化后台程序";
export const BACKGROUND_SCHEDULER_PORT = 31373;

export function schedulerProgramPath(input: {
  packaged: boolean;
  executablePath: string;
  appPath: string;
}): string {
  if (input.packaged) {
    return join(dirname(input.executablePath), `${BACKGROUND_PROGRAM_NAME}.exe`);
  }
  return input.executablePath;
}

export function schedulerLaunchCommand(command: string): {
  command: string;
  args: string[];
} {
  return { command, args: ["--scheduler"] };
}

export function schedulerOrigin(port = BACKGROUND_SCHEDULER_PORT): string {
  return `http://127.0.0.1:${port}`;
}
