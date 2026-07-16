import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const root = resolve(import.meta.dirname);
await mkdir(resolve(root, "dist"), { recursive: true });

const tsc = resolve(root, "../../node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc");
execSync(`"${process.execPath}" "${tsc}" -p "${resolve(root, "tsconfig.json")}" --outDir "${resolve(root, "dist")}"`, { stdio: "inherit" });
console.log("Built isolated login server test.");
