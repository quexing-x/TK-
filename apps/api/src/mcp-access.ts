import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthService } from "./auth-service.js";

/**
 * 本机 MCP 接入点。
 *
 * MCP server 是个独立进程，既没有浏览器的 Cookie 罐，也不该让人手工配密码或密钥——
 * 那是一步注定被填错、且填错之后只会得到一句「401」的配置。做法是：后台程序启动时
 * 把「API 在哪、拿什么令牌」写进一个固定位置的发现文件，MCP server 自己去读。
 *
 * 文件放 `%APPDATA%`（`app.getPath("appData")`）而不是数据库所在的「文档」目录：
 * 数据库的位置是随版本迁移过的，而 MCP server 需要一个**跨版本稳定、且不会被 OneDrive
 * 重定向**的落脚点。这里只放接入信息，不放业务数据。
 */
export const MCP_AGENT_USERNAME = "mcp-agent";
export const MCP_AGENT_DISPLAY_NAME = "MCP 助手";

export interface McpEndpointFile {
  /** 本地 API 的 origin，例如 `http://127.0.0.1:31373`。 */
  origin: string;
  /** 会话令牌，按 `Authorization: Bearer` 发送。 */
  token: string;
  /** 写操作要带的 CSRF 令牌。 */
  csrfToken: string;
  issuedAt: string;
}

function readEndpointFile(path: string): McpEndpointFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<McpEndpointFile>;
    if (
      typeof parsed.origin === "string"
      && typeof parsed.token === "string"
      && typeof parsed.csrfToken === "string"
    ) {
      return parsed as McpEndpointFile;
    }
  } catch {
    // 文件不存在、被改坏、或权限不足：一律当成没有，重新签一张。
  }
  return null;
}

/**
 * 确保 MCP 身份存在，且发现文件里的令牌当前有效。
 *
 * 令牌仍然有效时**原样保留**，不每次启动都换一张：后台程序会因为升级、崩溃恢复、
 * 用户重启等原因反复启动，每次换令牌会让正连着的 MCP 会话在下一次调用时突然 401，
 * 而 agent 那一侧看到的只是一句没头没尾的「未登录」。
 *
 * 签发失败不抛出——MCP 接入是附加能力，它挂了不该连累后台调度器起不来。
 */
export async function ensureMcpEndpoint(input: {
  auth: AuthService;
  origin: string;
  endpointFilePath: string;
  /** 出错时的记录方式，默认吞掉。 */
  onError?: (cause: unknown) => void;
}): Promise<McpEndpointFile | null> {
  try {
    const existing = readEndpointFile(input.endpointFilePath);
    if (existing) {
      const session = input.auth.authenticate(existing.token);
      if (session?.user.username === MCP_AGENT_USERNAME && existing.origin === input.origin) {
        return existing;
      }
    }
    const created = await input.auth.ensureServiceSession({
      username: MCP_AGENT_USERNAME,
      displayName: MCP_AGENT_DISPLAY_NAME,
      // operator：读账户、生成表、扩组复制都够用，但改不了系统设置、也管不了本机账户。
      role: "operator",
    });
    const endpoint: McpEndpointFile = {
      origin: input.origin,
      token: created.token,
      csrfToken: created.csrfToken,
      issuedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(input.endpointFilePath), { recursive: true });
    writeFileSync(input.endpointFilePath, JSON.stringify(endpoint, null, 2), "utf8");
    return endpoint;
  } catch (cause) {
    input.onError?.(cause);
    return null;
  }
}
