import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname);
await mkdir(resolve(root, "dist"), { recursive: true });

// 打成单个 CJS 文件，由已安装的 Electron 以纯 Node 模式运行
// （ELECTRON_RUN_AS_NODE=1）。这样用户不需要另外装 Node 运行时。
await build({
  entryPoints: [resolve(root, "src/server.ts")],
  outfile: resolve(root, "dist/mcp-server.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  minify: false,
  legalComments: "none",
});

console.log("Built MCP stdio server.");
