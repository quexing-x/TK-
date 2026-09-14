#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { LocalApiClient, readEndpointFile } from "./api-client.js";
import { createServer } from "./tools.js";

/**
 * HTTP 入口：给「只认 URL、不认 command」的宿主用。
 *
 * 豆包工作的连接器就是个 MCP 客户端，但它只能在界面里填一个 URL + API Key——
 * 没有地方能填 `command` 和 `args`，所以它接不了 stdio 版的 mcp-server.cjs。
 * 这个入口把同一套工具挂到 http://127.0.0.1:<port>/mcp 上，让它能连进来。
 *
 * 安全上的取舍，逐条讲清楚：
 *
 * 1. **只监听回环地址**，不监听 0.0.0.0。这套工具能真实下单扩组、花真钱；绑到所有网卡
 *    等于把「能操作广告账户的登录态」摆到局域网里，同一 WiFi 下谁都能扫到。
 * 2. **强制鉴权**，令牌就是 mcp-endpoint.json 里那张。不带或带错一律 401，不做「本地就免鉴权」
 *    那套——回环地址不是身份，本机上任何一个进程都能连 127.0.0.1。
 * 3. 比较令牌用 timingSafeEqual，避免按字符逐位比较泄漏出令牌前缀。
 *
 * 端口与后台程序的 31373 分开：那是 REST API，这是 MCP 协议，混在一个端口上
 * 会让「谁在处理这个路径」变得难查。
 */

const DEFAULT_PORT = 31374;
const HOST = "127.0.0.1";

function resolvePort(): number {
  const raw = process.env.TK_AUTO_MCP_HTTP_PORT;
  if (!raw) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : DEFAULT_PORT;
}

/**
 * 取当前该认的令牌。
 *
 * 每次都重新读文件而不是启动时读一次：令牌会因为「换了监听地址」「库被还原」而重签，
 * 缓存住旧令牌会让 HTTP 侧在后台重启后一直 401，而错误信息只会说「未授权」。
 */
function currentToken(): string | null {
  return readEndpointFile()?.token ?? null;
}

/** 定长比较，长度不同直接判否（timingSafeEqual 要求等长，否则会抛）。 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractBearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function deny(response: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * 每个会话一个 transport + 一个 server 实例。
 *
 * 有状态模式是刻意的：让宿主在 initialize 之后能一直复用同一批连接，
 * 否则每次工具调用都要重走一次握手和 listTools。
 */
const transports = new Map<string, StreamableHTTPServerTransport>();

async function handlePost(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const sessionId = request.headers["mcp-session-id"];
  const existing = typeof sessionId === "string" ? transports.get(sessionId) : undefined;

  if (existing) {
    await existing.handleRequest(request, response);
    return;
  }

  // 没有会话却收到非 initialize 的请求：拒绝，而不是悄悄开一个新会话。
  // 否则一个拼错的请求会被当成新会话接受，错误被藏到后面才暴露。
  const body: unknown = await readJsonBody(request);
  if (!isInitializeRequest(body)) {
    deny(response, 400, "没有可用的会话：请先发送 initialize 请求，或在请求头带上 mcp-session-id。");
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      transports.set(id, transport);
    },
  });
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) transports.delete(id);
  };

  // 每个会话一个 server：它持有自己的 LocalApiClient，避免并发会话在读令牌和
  // 重试状态上互相串。工具集本身是同一套。
  const server = createServer(new LocalApiClient());
  // SDK 1.30 把 onclose/onerror/onmessage 声明成「getter 返回 T | undefined、
  // setter 只收 T」的访问器对，在 exactOptionalPropertyTypes 下与 Transport 接口的
  // 同名可选属性不兼容（类型层面，运行期行为一致）。这里在调用点断言一次，
  // 不动全局的严格性设置——它为别的代码挡掉过真实的可选属性漏传。
  await server.connect(transport as Transport);
  await transport.handleRequest(request, response, body);
}

/** 读请求体。空体返回 undefined，交给 SDK 自己判。 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const httpServer = createHttpServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", `http://${HOST}`);
    if (url.pathname !== "/mcp") {
      deny(response, 404, "路径不存在。MCP 端点是 /mcp。");
      return;
    }

    const expected = currentToken();
    if (!expected) {
      deny(
        response,
        503,
        "还没有 MCP 接入信息。请先打开一次 TK Ads Automation 客户端，"
        + "让后台程序写出 mcp-endpoint.json。",
      );
      return;
    }
    const presented = extractBearer(request);
    if (!presented || !tokenMatches(presented, expected)) {
      deny(response, 401, "未授权：Authorization 头缺少或不是有效的 Bearer 令牌。");
      return;
    }

    if (request.method === "POST") {
      await handlePost(request, response);
      return;
    }
    // GET（SSE 流）与 DELETE（结束会话）都要带上有会话的 transport。
    const sessionId = request.headers["mcp-session-id"];
    const transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
    if (!transport) {
      deny(response, 400, "没有可用的会话：请先在 /mcp 发送 initialize 请求。");
      return;
    }
    await transport.handleRequest(request, response);
  })().catch((cause: unknown) => {
    // 到这里说明是没被 SDK 接住的意外。响应可能已经开始写，能写多少算多少。
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`TK 自动化 MCP HTTP 请求失败：${message}\n`);
    if (!response.headersSent) deny(response, 500, "内部错误。");
    else response.end();
  });
});

const port = resolvePort();
httpServer.listen(port, HOST, () => {
  // stdout 不是协议通道（这里没有 stdio 客户端），但状态一律走 stderr，
  // 与 stdio 版保持同一个约定，日志排查时不用想「这次看哪个流」。
  process.stderr.write(`TK 自动化 MCP HTTP 端点已监听 http://${HOST}:${port}/mcp\n`);
});

httpServer.on("error", (cause: NodeJS.ErrnoException) => {
  const hint = cause.code === "EADDRINUSE"
    ? `端口 ${port} 已被占用。设 TK_AUTO_MCP_HTTP_PORT 换一个端口。`
    : cause.message;
  process.stderr.write(`TK 自动化 MCP HTTP 端点启动失败：${hint}\n`);
  process.exit(1);
});
