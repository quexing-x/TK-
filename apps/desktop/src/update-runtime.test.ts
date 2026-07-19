import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignedUpdateRuntime } from "./update-runtime.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SignedUpdateRuntime", () => {
  it("rejects an update manifest that does not pass signature verification", async () => {
    const directory = temporaryDirectory();
    const runtime = new SignedUpdateRuntime({
      currentVersion: "1.3.2",
      packaged: false,
      currentExecutable: process.execPath,
      downloadDirectory: directory,
      manifestUrl: "https://updates.example/manifest.json",
      publicKey: "test-public-key",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(manifestFor(Buffer.from("installer"))), {
        status: 200,
        headers: { "content-type": "application/json" },
      })),
      verifyManifest: () => false,
      verifyAuthenticode: async () => true,
      install: vi.fn(),
    });

    await expect(runtime.checkForUpdates()).resolves.toMatchObject({
      state: "error",
      message: "升级清单签名无效。",
    });
  });

  it("downloads only a hash-matched Authenticode-valid installer before installation", async () => {
    const directory = temporaryDirectory();
    const installer = Buffer.from("signed-installer-content");
    const manifest = manifestFor(installer);
    const install = vi.fn();
    const runtime = new SignedUpdateRuntime({
      currentVersion: "1.3.2",
      packaged: true,
      currentExecutable: process.execPath,
      downloadDirectory: directory,
      manifestUrl: "https://updates.example/manifest.json",
      publicKey: "test-public-key",
      fetchImpl: vi.fn(async (input) => String(input).endsWith("manifest.json")
        ? new Response(JSON.stringify(manifest), { status: 200 })
        : new Response(installer, { status: 200 })),
      verifyManifest: () => true,
      verifyAuthenticode: async () => true,
      install,
    });

    await expect(runtime.checkForUpdates()).resolves.toMatchObject({
      state: "available",
      availableVersion: "1.3.3",
    });
    await expect(runtime.downloadUpdate()).resolves.toMatchObject({
      state: "downloaded",
      signatureStatus: "valid",
    });
    await expect(runtime.installUpdate()).resolves.toMatchObject({ state: "installing" });
    expect(install).toHaveBeenCalledWith(
      join(directory, "TK-Ads-Automation-Setup-1.3.3.exe"),
    );
  });

  it("blocks a downloaded installer whose Windows signature is invalid", async () => {
    const directory = temporaryDirectory();
    const installer = Buffer.from("unsigned-installer");
    const runtime = new SignedUpdateRuntime({
      currentVersion: "1.3.2",
      packaged: true,
      currentExecutable: process.execPath,
      downloadDirectory: directory,
      manifestUrl: "https://updates.example/manifest.json",
      publicKey: "test-public-key",
      fetchImpl: vi.fn(async (input) => String(input).endsWith("manifest.json")
        ? new Response(JSON.stringify(manifestFor(installer)), { status: 200 })
        : new Response(installer, { status: 200 })),
      verifyManifest: () => true,
      verifyAuthenticode: async () => false,
      install: vi.fn(),
    });

    await runtime.checkForUpdates();
    await expect(runtime.downloadUpdate()).resolves.toMatchObject({
      state: "error",
      message: "安装包未通过 Windows 代码签名校验。",
    });
    await expect(runtime.installUpdate()).rejects.toThrow("没有已验证且可安装的升级包");
  });

  it("rechecks the downloaded installer immediately before launching it", async () => {
    const directory = temporaryDirectory();
    const installer = Buffer.from("signed-installer-content");
    const install = vi.fn();
    const verifyAuthenticode = vi.fn(async () => true);
    const runtime = new SignedUpdateRuntime({
      currentVersion: "1.3.2",
      packaged: true,
      currentExecutable: process.execPath,
      downloadDirectory: directory,
      manifestUrl: "https://updates.example/manifest.json",
      publicKey: "test-public-key",
      fetchImpl: vi.fn(async (input) => String(input).endsWith("manifest.json")
        ? new Response(JSON.stringify(manifestFor(installer)), { status: 200 })
        : new Response(installer, { status: 200 })),
      verifyManifest: () => true,
      verifyAuthenticode,
      install,
    });

    await runtime.checkForUpdates();
    await runtime.downloadUpdate();
    writeFileSync(
      join(directory, "TK-Ads-Automation-Setup-1.3.3.exe"),
      "tampered-after-verification",
    );

    await expect(runtime.installUpdate()).rejects.toThrow("SHA-256 已发生变化");
    expect(install).not.toHaveBeenCalled();
    expect(await runtime.getStatus()).toMatchObject({ state: "error" });
    expect(verifyAuthenticode).toHaveBeenCalledTimes(1);
  });

  it("blocks installation when Authenticode changes after download verification", async () => {
    const directory = temporaryDirectory();
    const installer = Buffer.from("signed-installer-content");
    const install = vi.fn();
    const verifyAuthenticode = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const runtime = new SignedUpdateRuntime({
      currentVersion: "1.3.2",
      packaged: true,
      currentExecutable: process.execPath,
      downloadDirectory: directory,
      manifestUrl: "https://updates.example/manifest.json",
      publicKey: "test-public-key",
      fetchImpl: vi.fn(async (input) => String(input).endsWith("manifest.json")
        ? new Response(JSON.stringify(manifestFor(installer)), { status: 200 })
        : new Response(installer, { status: 200 })),
      verifyManifest: () => true,
      verifyAuthenticode,
      install,
    });

    await runtime.checkForUpdates();
    await runtime.downloadUpdate();

    await expect(runtime.installUpdate()).rejects.toThrow("Windows 代码签名无效");
    expect(install).not.toHaveBeenCalled();
    expect(verifyAuthenticode).toHaveBeenCalledTimes(2);
  });
});

function manifestFor(installer: Buffer) {
  return {
    version: "1.3.3",
    url: "https://updates.example/TK-Ads-Automation-Setup-1.3.3.exe",
    sha256: createHash("sha256").update(installer).digest("hex"),
    signature: Buffer.from("signature").toString("base64"),
    signatureAlgorithm: "ed25519",
  } as const;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "tk-auto-update-runtime-"));
  directories.push(directory);
  return directory;
}
