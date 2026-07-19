import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const releaseDirectory = resolve(import.meta.dirname, "../release");
const installers = (await readdir(releaseDirectory))
  .filter((name) => /^TK-Ads-Automation-Setup-.*\.exe$/i.test(name))
  .sort();
const installer = installers.at(-1);
if (!installer) throw new Error("没有找到待校验的 Windows 安装包。");
const target = resolve(releaseDirectory, installer);
const script = [
  "$s=Get-AuthenticodeSignature -LiteralPath $env:TK_SIGNATURE_TARGET",
  "$o=[pscustomobject]@{Status=[string]$s.Status;Subject=[string]$s.SignerCertificate.Subject}",
  "$o|ConvertTo-Json -Compress",
].join(";");
const { stdout } = await execFileAsync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", script],
  { env: { ...process.env, TK_SIGNATURE_TARGET: target }, windowsHide: true },
);
const result = JSON.parse(stdout.trim());
if (result.Status !== "Valid") throw new Error(`安装包代码签名无效：${result.Status ?? "unknown"}。`);
if (!String(result.Subject ?? "").includes(process.env.TK_SIGNING_PUBLISHER ?? "")) {
  throw new Error("安装包签名发布者与 TK_SIGNING_PUBLISHER 不匹配。");
}
console.log(`Verified signed installer: ${installer}`);
