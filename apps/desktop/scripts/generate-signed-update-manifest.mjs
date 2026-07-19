import { createHash, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const installerArgument = args.get("--installer");
const url = args.get("--url");
const version = args.get("--version");
const outputArgument = args.get("--out") ?? "release/update-manifest.json";
const algorithm = args.get("--algorithm") ?? "ed25519";
const privateKey = process.env.TK_UPDATE_SIGNING_PRIVATE_KEY;
if (!installerArgument || !url || !version || !privateKey) {
  throw new Error("需要 --installer、--url、--version 和 TK_UPDATE_SIGNING_PRIVATE_KEY。");
}
if (!url.startsWith("https://")) throw new Error("升级安装包地址必须使用 HTTPS。");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("版本号必须是有效的语义版本。");
}
if (!["ed25519", "rsa-sha256"].includes(algorithm)) {
  throw new Error("签名算法只支持 ed25519 或 rsa-sha256。");
}
const installer = await readFile(resolve(installerArgument));
const unsigned = {
  version,
  url,
  sha256: createHash("sha256").update(installer).digest("hex"),
};
const signature = sign(
  algorithm === "ed25519" ? null : "sha256",
  Buffer.from(JSON.stringify(unsigned)),
  privateKey,
).toString("base64");
const output = resolve(outputArgument);
await writeFile(output, `${JSON.stringify({
  ...unsigned,
  signature,
  signatureAlgorithm: algorithm,
}, null, 2)}\n`, "utf8");
console.log(`Generated signed update manifest: ${output}`);
