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
});
