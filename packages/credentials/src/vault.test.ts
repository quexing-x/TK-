import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemoryCredentialVault,
  WindowsDpapiCredentialVault,
} from "./vault.js";

describe("CredentialVault", () => {
  it("stores secrets behind an opaque reference", async () => {
    const vault = new InMemoryCredentialVault();
    const reference = await vault.create("sensitive-cookie");

    expect(reference).not.toContain("sensitive-cookie");
    await expect(vault.read(reference)).resolves.toBe("sensitive-cookie");

    await vault.delete(reference);
    await expect(vault.read(reference)).resolves.toBeNull();
    await vault.restore(reference, "top-secret");
    await expect(vault.read(reference)).resolves.toBe("top-secret");
  });

  if (process.platform === "win32") {
    it("round-trips a secret through Windows DPAPI", async () => {
      const directory = await mkdtemp(join(tmpdir(), "tk-auto-dpapi-"));
      const vault = new WindowsDpapiCredentialVault(directory);

      try {
        const reference = await vault.create("synthetic-validation-secret");
        await expect(vault.read(reference)).resolves.toBe(
          "synthetic-validation-secret",
        );
        await vault.delete(reference);
        await expect(vault.read(reference)).resolves.toBeNull();
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
      });

    it("round-trips a large Unicode creation profile without JSON corruption", async () => {
      const directory = await mkdtemp(join(tmpdir(), "tk-auto-dpapi-large-"));
      try {
        const vault = new WindowsDpapiCredentialVault(directory);
        const secret = JSON.stringify({ name: "测试创建模板", body: "素材参数；".repeat(10_000) });
        const reference = await vault.create(secret);
        const restored = await vault.read(reference);
        expect(restored).toBe(secret);
        expect(() => JSON.parse(restored!)).not.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
