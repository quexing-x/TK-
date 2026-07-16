import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "./registry.js";

describe("ProviderRegistry", () => {
  it("keeps cookie and official API behind the same interface", () => {
    const registry = new ProviderRegistry();

    expect(registry.list().map((provider) => provider.kind)).toEqual([
      "cookie",
      "official-api",
    ]);
  });

  it("returns the selected provider", () => {
    const registry = new ProviderRegistry();
    expect(registry.get("cookie").displayName).toBe("Cookie 会话");
  });

  it("only advertises capabilities with an implemented provider operation", () => {
    const registry = new ProviderRegistry();
    for (const provider of registry.list()) {
      expect(provider.capabilities).toContain("change-status");
      expect(provider.capabilities).not.toContain("copy-ads");
    }
    expect(registry.get("cookie").capabilities).toContain("create-campaigns");
    expect(registry.get("official-api").capabilities).not.toContain("create-campaigns");
  });
});
