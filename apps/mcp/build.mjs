import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname);
await mkdir(resolve(root, "dist"), { recursive: true });

// 打成单个 CJS 文件，由已安装的 Electron 以纯 Node 模式运行
// （ELECTRON_RUN_AS_NODE=1）。这样用户不需要另外装 Node 运行时。
//
// 两个入口，同一套工具：
//   mcp-server.cjs —— stdio，给 Codex / Claude 桌面端 / DSH / WorkBuddy
//   mcp-http.cjs   —— Streamable HTTP，给豆包工作这类只认 URL 的宿主
const entries = {
  "mcp-server": "src/server.ts",
  "mcp-http": "src/http.ts",
};

for (const [name, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [resolve(root, entry)],
    outfile: resolve(root, `dist/${name}.cjs`),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: false,
    minify: false,
    legalComments: "none",
  });
}

console.log("Built MCP stdio + HTTP servers.");
