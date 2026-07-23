import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConnection } from "@tk-auto/core";
import { ProviderRegistry } from "./registry.js";
import type { ProviderContext } from "./types.js";

afterEach(() => vi.unstubAllGlobals());

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
    }
    expect(registry.get("cookie").capabilities).toContain("create-campaigns");
    expect(registry.get("cookie").capabilities).toContain("copy-ads");
    expect(registry.get("official-api").capabilities).not.toContain("create-campaigns");
  });

  const statusContractCases: Array<{
    kind: "cookie" | "official-api";
    context: ProviderContext;
  }> = [
    {
      kind: "cookie",
      context: {
        accountId: "cookie-account",
        settings: { kind: "cookie", advertiserId: "1001", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
        credential: {
          kind: "cookie",
          cookie: "sessionid=test-session",
          csrfHeaderName: "x-csrftoken",
          requestTemplates: [{
            target: "ad-group-status",
            action: "disable",
            url: "https://ads.tiktok.com/api/v4/i18n/adgroup/status/update/?aadvid=1001",
            method: "POST",
            body: '{"ad_id":"old-id","status":0}',
            contentType: "application/json",
          }],
        },
      },
    },
    {
      kind: "official-api",
      context: {
        accountId: "official-account",
        settings: { kind: "official-api", advertiserId: "1002" },
        credential: { kind: "official-api", accessToken: "test-access-token" },
      },
    },
  ];

  it.each(statusContractCases)("runs the real status-mutation contract for $kind", async ({ kind, context }) => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));
    const result = await new ProviderRegistry().changeStatus(
      kind,
      context,
      [{ entityType: "ad-group", externalId: "group-1", action: "disable" }],
    );

    expect(result).toEqual([
      expect.objectContaining({
        entityType: "ad-group",
        externalId: "group-1",
        action: "disable",
        ok: true,
      }),
    ]);
  });

  it("derives account availability from authorization and contract version", () => {
    const registry = new ProviderRegistry();
    const connection: ProviderConnection = {
      accountId: "account-1",
      kind: "cookie",
      settings: {
        kind: "cookie",
        advertiserId: "1001",
        healthUrl: "",
        campaignsUrl: "",
        adGroupsUrl: "",
        adsUrl: "",
      },
      hasCredential: true,
      status: "ready",
      authorizationStatus: "active",
      capabilityVersion: registry.capabilityVersion("cookie"),
      authorizedCapabilities: [...registry.get("cookie").capabilities],
      authorizedAt: "2026-07-18T00:00:00.000Z",
      authorizationExpiresAt: null,
      lastMessage: "ready",
      lastTestedAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    };

    const profile = registry.describeAccount("account-1", "cookie", connection);
    expect(profile.capabilities).toEqual(expect.arrayContaining([
      { capability: "create-campaigns", available: true, reason: "当前账户可用。" },
      { capability: "copy-ads", available: true, reason: "当前账户可用。" },
      { capability: "appeal-ads", available: true, reason: "当前账户可用。" },
    ]));

    const stale = registry.describeAccount("account-1", "cookie", {
      ...connection,
      capabilityVersion: "old-contract",
    });
    expect(stale.capabilities.find((item) => item.capability === "create-campaigns"))
      .toMatchObject({ available: false, reason: "Provider 能力契约已更新，请重新检测连接。" });
    expect(() => registry.requireAccountCapability(
      "account-1",
      "cookie",
      { ...connection, capabilityVersion: "old-contract" },
      "create-campaigns",
    )).toThrow();
    expect(() => registry.requireAccountCapability(
      "account-1",
      "cookie",
      connection,
      "create-campaigns",
    )).not.toThrow();
  });

  it("keeps unavailable Official API creation behind the creation contract", async () => {
    const registry = new ProviderRegistry();
    await expect(registry.create("official-api", {
      accountId: "official-1",
      settings: { kind: "official-api", advertiserId: "1001" },
      credential: { kind: "official-api", accessToken: "test-access-token" },
    }, [])).rejects.toThrow("暂不支持从零创建广告");
  });
});
