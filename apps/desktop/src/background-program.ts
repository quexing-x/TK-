import { dirname, join } from "node:path";

export const BACKGROUND_PROGRAM_NAME = "tk自动化后台程序";
export const BACKGROUND_SCHEDULER_PORT = 31373;

// 客户端等后台起来的上限。曾经是 10 秒（40 × 250ms）写死在 main.ts 里，库一大
// （生产已 800MB+）后台冷启动开库 + seed + 建服务就超过 10 秒，客户端等不及便报
// 「后台未能启动」并退出——而后台随后其实起来了，所以"重新拉一遍"就好。放到 120 秒
// 远高于实测冷启动，既消除误报又给真故障留出足够的失败判定时间。
export const SCHEDULER_HEALTH_TIMEOUT_MS = 120_000;
export const SCHEDULER_HEALTH_POLL_INTERVAL_MS = 250;

/**
 * 轮询后台健康检查直到通过或超时。抽成纯函数（注入 now/sleep）便于单测，不必真的
 * 等满两分钟。返回 true=已健康，false=到点仍不健康。
 */
export async function waitForSchedulerHealthy(
  isHealthy: () => Promise<boolean>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? SCHEDULER_HEALTH_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? SCHEDULER_HEALTH_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await isHealthy()) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/** 监听端口被占用（EADDRINUSE）。用于区分"端口已被另一个后台占着"与真正的启动失败。 */
export function isAddressInUseError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "EADDRINUSE"
  );
}

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
