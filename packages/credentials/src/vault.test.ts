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
  }
});
