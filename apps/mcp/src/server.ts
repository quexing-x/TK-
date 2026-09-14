#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./tools.js";

/**
 * stdio 入口：本地进程型宿主走这条路。
 *
 * Codex（`~/.codex/config.toml`）、Claude 桌面端（`claude_desktop_config.json`）、
 * DSH（`$DSH_HOME/cordis.patch.yml`）、WorkBuddy（`~/.codebuddy/.mcp.json`）
 * 都是启动这个进程、用标准输入输出讲 JSON-RPC。
 *
 * 不认 command、只认 URL 的宿主（豆包工作的连接器）走 http.ts，工具集是同一套。
 */
async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

// stdout 是 MCP 的协议通道，任何多余输出都会让客户端解析失败。诊断信息一律走 stderr。
main().catch((cause: unknown) => {
  process.stderr.write(
    `TK 自动化 MCP 启动失败：${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exit(1);
});
