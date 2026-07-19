import { createHash, verify as verifySignature } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { MaintenanceUpdateRuntime } from "@tk-auto/api";
import type { UpdateRuntimeStatus } from "@tk-auto/core";

const execFileAsync = promisify(execFile);

interface SignedUpdateManifest {
  version: string;
  url: string;
  sha256: string;
  signature: string;
  signatureAlgorithm: "ed25519" | "rsa-sha256";
}

interface SignedUpdateRuntimeOptions {
  currentVersion: string;
  packaged: boolean;
  currentExecutable: string;
  downloadDirectory: string;
  manifestUrl?: string;
  publicKey?: string;
  expectedPublisher?: string;
  fetchImpl?: typeof fetch;
  verifyManifest?: (manifest: SignedUpdateManifest, publicKey: string) => boolean;
  verifyAuthenticode?: (path: string, expectedPublisher?: string) => Promise<boolean>;
  install: (installerPath: string) => void | Promise<void>;
}

export class SignedUpdateRuntime implements MaintenanceUpdateRuntime {
  private readonly fetchImpl: typeof fetch;
  private readonly verifyManifestImpl: NonNullable<SignedUpdateRuntimeOptions["verifyManifest"]>;
  private readonly verifyAuthenticodeImpl: NonNullable<SignedUpdateRuntimeOptions["verifyAuthenticode"]>;
  private manifest: SignedUpdateManifest | null = null;
  private installerPath: string | null = null;
  private status: UpdateRuntimeStatus;

  constructor(private readonly options: SignedUpdateRuntimeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.verifyManifestImpl = options.verifyManifest ?? verifySignedManifest;
    this.verifyAuthenticodeImpl = options.verifyAuthenticode ?? verifyWindowsAuthenticode;
    this.status = {
      configured: this.isConfigured(),
      state: this.isConfigured() ? "idle" : "not-configured",
      currentVersion: options.currentVersion,
      availableVersion: null,
      signatureStatus: options.packaged ? "unknown" : "not-packaged",
      message: this.isConfigured() ? null : "未配置签名升级清单地址或公钥。",
      checkedAt: null,
    };
  }

  isConfigured(): boolean {
    return Boolean(this.options.manifestUrl && this.options.publicKey);
  }

  async getStatus(): Promise<UpdateRuntimeStatus> {
    if (this.options.packaged && this.status.signatureStatus === "unknown") {
      const valid = await this.verifyAuthenticodeImpl(
        this.options.currentExecutable,
        this.options.expectedPublisher,
      );
      this.status = {
        ...this.status,
        signatureStatus: valid ? "valid" : "invalid",
        message: valid ? this.status.message : "当前程序未通过 Windows 代码签名校验。",
      };
    }
    return { ...this.status };
  }

  async checkForUpdates(): Promise<UpdateRuntimeStatus> {
    this.assertConfigured();
    this.status = { ...this.status, state: "checking", message: null };
    try {
      const response = await this.fetchImpl(this.options.manifestUrl!, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`升级清单请求失败（HTTP ${response.status}）。`);
      const manifest = parseManifest(await response.json());
      if (!this.verifyManifestImpl(manifest, this.options.publicKey!)) {
        throw new Error("升级清单签名无效。");
      }
      this.manifest = manifest;
      const available = compareVersions(manifest.version, this.options.currentVersion) > 0;
      this.status = {
        ...this.status,
        state: available ? "available" : "up-to-date",
        availableVersion: available ? manifest.version : null,
        message: available ? `发现签名版本 ${manifest.version}。` : "当前已是最新版本。",
        checkedAt: new Date().toISOString(),
      };
    } catch (cause) {
      this.fail(cause);
    }
    return { ...this.status };
  }

  async downloadUpdate(): Promise<UpdateRuntimeStatus> {
    if (!this.manifest || this.status.state !== "available") {
      throw new Error("请先检查并确认存在可信的新版本。");
    }
    this.status = { ...this.status, state: "downloading", message: "正在下载签名安装包。" };
    const destination = join(
      this.options.downloadDirectory,
      `TK-Ads-Automation-Setup-${this.manifest.version}.exe`,
    );
    const temporary = `${destination}.tmp`;
    try {
      const response = await this.fetchImpl(this.manifest.url);
      if (!response.ok) throw new Error(`安装包下载失败（HTTP ${response.status}）。`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== this.manifest.sha256) throw new Error("安装包 SHA-256 与签名清单不一致。");
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(temporary, bytes);
      const signatureValid = await this.verifyAuthenticodeImpl(
        temporary,
        this.options.expectedPublisher,
      );
      if (!signatureValid) throw new Error("安装包未通过 Windows 代码签名校验。");
      renameSync(temporary, destination);
      this.installerPath = destination;
      this.status = {
        ...this.status,
        state: "downloaded",
        signatureStatus: "valid",
        message: "安装包哈希与 Windows 代码签名均已验证。",
      };
    } catch (cause) {
      rmSync(temporary, { force: true });
      this.fail(cause);
    }
    return { ...this.status };
  }

  async installUpdate(): Promise<UpdateRuntimeStatus> {
    if (!this.installerPath || !this.manifest || this.status.state !== "downloaded") {
      throw new Error("没有已验证且可安装的升级包。");
    }
    try {
      const digest = createHash("sha256")
        .update(readFileSync(this.installerPath))
        .digest("hex");
      if (digest !== this.manifest.sha256) {
        throw new Error("安装前复验失败：安装包 SHA-256 已发生变化。");
      }
      const signatureValid = await this.verifyAuthenticodeImpl(
        this.installerPath,
        this.options.expectedPublisher,
      );
      if (!signatureValid) {
        throw new Error("安装前复验失败：Windows 代码签名无效。");
      }
      this.status = { ...this.status, state: "installing", message: "升级程序已启动。" };
      await this.options.install(this.installerPath);
      return { ...this.status };
    } catch (cause) {
      this.fail(cause);
      throw cause;
    }
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) throw new Error("未配置签名升级清单地址或公钥。");
  }

  private fail(cause: unknown): void {
    this.status = {
      ...this.status,
      state: "error",
      message: cause instanceof Error ? cause.message : "升级操作失败。",
      checkedAt: new Date().toISOString(),
    };
  }
}

function parseManifest(value: unknown): SignedUpdateManifest {
  if (!value || typeof value !== "object") throw new Error("升级清单格式无效。");
  const item = value as Record<string, unknown>;
  if (
    typeof item.version !== "string"
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(item.version)
    || typeof item.url !== "string"
    || !item.url.startsWith("https://")
    || typeof item.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(item.sha256)
    || typeof item.signature !== "string"
    || !["ed25519", "rsa-sha256"].includes(String(item.signatureAlgorithm))
  ) {
    throw new Error("升级清单缺少有效的版本、HTTPS 地址、哈希或签名。");
  }
  return item as unknown as SignedUpdateManifest;
}

function verifySignedManifest(manifest: SignedUpdateManifest, publicKey: string): boolean {
  const data = Buffer.from(JSON.stringify({
    version: manifest.version,
    url: manifest.url,
    sha256: manifest.sha256,
  }));
  return verifySignature(
    manifest.signatureAlgorithm === "ed25519" ? null : "sha256",
    data,
    publicKey,
    Buffer.from(manifest.signature, "base64"),
  );
}

async function verifyWindowsAuthenticode(
  path: string,
  expectedPublisher?: string,
): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const script = [
    "$s=Get-AuthenticodeSignature -LiteralPath $env:TK_SIGNATURE_TARGET",
    "$o=[pscustomobject]@{Status=[string]$s.Status;Subject=[string]$s.SignerCertificate.Subject}",
    "$o|ConvertTo-Json -Compress",
  ].join(";");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { env: { ...process.env, TK_SIGNATURE_TARGET: path }, windowsHide: true },
    );
    const result = JSON.parse(stdout.trim()) as { Status?: string; Subject?: string };
    return result.Status === "Valid"
      && (!expectedPublisher || result.Subject?.includes(expectedPublisher) === true);
  } catch {
    return false;
  }
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(/[+-]/, 1)[0]!.split(".").map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
