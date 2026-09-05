import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 本地 API 的客户端。
 *
 * 全部能力都走 HTTP 打到 `tk自动化后台程序`，一个数据库连接都不开。这不是绕远路：
 * 审计、权限、写熔断、幂等闸门、Provider 连接检测全在那一侧，直接开库等于把它们
 * 一次绕过干净——而这个 MCP 是能下单扩组的。
 */

const PRODUCT_NAME = "TK Ads Automation";
/** 后台程序的固定端口，与 `BACKGROUND_SCHEDULER_PORT` 一致。 */
const DEFAULT_ORIGIN = "http://127.0.0.1:31373";

export interface McpEndpoint {
  origin: string;
  token: string;
  csrfToken: string;
}

export class LocalApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "LocalApiError";
  }
}

/**
 * 接入信息的落点，与桌面端写入的位置一致。
 *
 * `APPDATA` 优先：数据库住在「文档」目录、且随版本迁移过，而这里需要一个跨版本稳定、
 * 也不会被 OneDrive 重定向的地址。环境变量留给开发模式（仓库里的 `data/`）。
 */
export function endpointFilePath(): string {
  const override = process.env.TK_AUTO_MCP_ENDPOINT_FILE;
  if (override) return override;
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, PRODUCT_NAME, "mcp-endpoint.json");
}

function readEndpoint(): McpEndpoint | null {
  const path = endpointFilePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<McpEndpoint>;
    if (
      typeof parsed.origin === "string"
      && typeof parsed.token === "string"
      && typeof parsed.csrfToken === "string"
    ) {
      return { origin: parsed.origin, token: parsed.token, csrfToken: parsed.csrfToken };
    }
  } catch {
    // 半写入或被改坏：当作没有，走下面的拉起流程重来一次。
  }
  return null;
}

async function isHealthy(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 后台程序没在跑就把它拉起来。
 *
 * 不直接报错了事：后台程序是开机自启的常驻进程，它没在跑通常意味着被安全软件拦了、
 * 或刚装完还没重启。让人去手工双击一个他多半找不到的 exe，等于把这个 MCP 变成
 * 「有一半时候用不了」的东西。
 */
function launchBackgroundProgram(): boolean {
  const executable = process.env.TK_AUTO_DESKTOP_EXECUTABLE
    ?? join(
      process.env["ProgramFiles"] ?? "C:\\Program Files",
      PRODUCT_NAME,
      `${PRODUCT_NAME}.exe`,
    );
  if (!existsSync(executable)) return false;
  try {
    const child = spawn(executable, ["--scheduler"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const SCHEDULER_BOOT_TIMEOUT_MS = 120_000;
const SCHEDULER_POLL_INTERVAL_MS = 500;

export class LocalApiClient {
  private endpoint: McpEndpoint | null = null;

  /**
   * 确保拿得到一个能用的接入点。
   *
   * 顺序是刻意的：先读文件（正常情况一次就成），读不到才判断是不是「后台没起来」，
   * 拉起来之后再读一次——接入信息正是后台程序启动时写下的，所以必须等它起完。
   */
  private async ensureEndpoint(): Promise<McpEndpoint> {
    if (this.endpoint) return this.endpoint;
    const existing = readEndpoint();
    if (existing && await isHealthy(existing.origin)) {
      this.endpoint = existing;
      return existing;
    }
    if (!await isHealthy(existing?.origin ?? DEFAULT_ORIGIN)) {
      if (!launchBackgroundProgram()) {
        throw new LocalApiError(
          `连不上 TK 自动化本地服务（${existing?.origin ?? DEFAULT_ORIGIN}），也没能找到程序把它拉起来。`
          + "请先打开一次 TK Ads Automation 客户端；若已安装在非默认目录，"
          + "把主程序 exe 的完整路径写进环境变量 TK_AUTO_DESKTOP_EXECUTABLE。",
          503,
        );
      }
      // 冷启动要开库 + seed + 监听，库越大越久，用宽上限轮询而不是写死几秒。
      const deadline = Date.now() + SCHEDULER_BOOT_TIMEOUT_MS;
      let ready = false;
      while (Date.now() < deadline) {
        if (await isHealthy(existing?.origin ?? DEFAULT_ORIGIN)) { ready = true; break; }
        await new Promise((resolve) => setTimeout(resolve, SCHEDULER_POLL_INTERVAL_MS));
      }
      if (!ready) {
        throw new LocalApiError(
          "已尝试启动 TK 自动化后台程序，但两分钟内没有就绪；请检查是否被安全软件阻止。",
          503,
        );
      }
    }
    const endpoint = readEndpoint();
    if (!endpoint) {
      throw new LocalApiError(
        "本地服务在跑，但还没有写下 MCP 接入信息。请升级到支持 MCP 的客户端版本后重启一次程序。",
        503,
      );
    }
    this.endpoint = endpoint;
    return endpoint;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const endpoint = await this.ensureEndpoint();
    const headers: Record<string, string> = {
      authorization: `Bearer ${endpoint.token}`,
      // 写请求的 CSRF 校验一条不放松，它和 Cookie 那条路走的是同一段代码。
      "x-csrf-token": endpoint.csrfToken,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${endpoint.origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // 只读列表接口在大账户上要拉几十秒，与本地 API 自己的 45 秒预算对齐。
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) {
      // 令牌失效（换过身份、库被还原）时重新读一次文件，下一次调用即可自愈。
      if (response.status === 401) this.endpoint = null;
      let message = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        // 非 JSON 错误体原样截断带出，总比丢掉强。
      }
      throw new LocalApiError(message || `本地服务返回 HTTP ${response.status}。`, response.status);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
}
