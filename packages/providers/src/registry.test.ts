import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConnection } from "@tk-auto/core";
import { MetaMarketingApiAdsProvider } from "./meta-marketing-api-provider.js";
import { ProviderRegistry } from "./registry.js";
import type { ProviderContext } from "./types.js";

afterEach(() => vi.unstubAllGlobals());

describe("ProviderRegistry", () => {
  it("keeps TikTok providers and the Meta scaffold behind the same interface", () => {
    const registry = new ProviderRegistry();

    expect(registry.list().map((provider) => provider.kind)).toEqual([
      "cookie",
      "official-api",
      "meta-offline",
      "meta-marketing-api",
    ]);
  });

  it("returns the selected provider", () => {
    const registry = new ProviderRegistry();
    expect(registry.get("cookie").displayName).toBe("Cookie 会话");
  });

  it("only advertises capabilities with an implemented provider operation", () => {
    const registry = new ProviderRegistry();
    for (const provider of registry.list().filter(({ platform }) => platform === "tiktok")) {
      expect(provider.capabilities).toContain("change-status");
    }
    expect(registry.get("cookie").capabilities).toContain("create-campaigns");
    expect(registry.get("cookie").capabilities).toContain("copy-ads");
    expect(registry.get("official-api").capabilities).not.toContain("create-campaigns");
  });

  it("describes Meta as a distinct unavailable scaffold, never as TikTok official API", () => {
    const registry = new ProviderRegistry();

    expect(registry.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "official-api",
        platform: "tiktok",
        implementationStatus: "available",
      }),
      expect.objectContaining({
        kind: "meta-offline",
        platform: "meta",
        implementationStatus: "scaffolded",
        capabilities: [],
      }),
      expect.objectContaining({
        kind: "meta-marketing-api",
        platform: "meta",
        implementationStatus: "scaffolded",
        capabilities: ["read-campaigns", "read-ad-groups", "read-ads", "change-status", "create-campaigns", "copy-campaigns"],
      }),
    ]));
    expect(registry.get("meta-offline")).not.toBe(registry.get("official-api"));
    expect(registry.get("meta-marketing-api")).not.toBe(registry.get("meta-offline"));
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

  it("routes the Meta status contract only through an explicitly injected transport", async () => {
    const provider = new MetaMarketingApiAdsProvider({
      async post() {
        return { success: true };
      },
      async get() {
        return { id: "500000000000005", status: "PAUSED" };
      },
    }, {
      localAccountId: "meta-account",
      adAccountId: "act_300000000000003",
      entityType: "campaign",
      externalId: "500000000000005",
      expectedCurrency: "USD",
      expectedTimezone: "Asia/Shanghai",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const result = await new ProviderRegistry([provider]).changeStatus(
      "meta-marketing-api",
      {
        accountId: "meta-account",
        settings: {
          kind: "meta-marketing-api",
          profileId: "11111111-1111-4111-8111-111111111111",
          adAccountId: "act_300000000000003",
          pageId: "400000000000004",
        },
        credential: {
          appSecret: "fixture-app-secret-with-enough-length",
          accessToken: "fixture-token-with-enough-length",
        },
        resolvedMetaAccessProfile: {
          profileId: "11111111-1111-4111-8111-111111111111",
          appId: "100000000000001",
          graphApiVersion: "v99.0",
        },
      },
      [{ entityType: "campaign", externalId: "500000000000005", action: "disable" }],
    );

    expect(result).toEqual([expect.objectContaining({
      externalId: "500000000000005",
      ok: true,
    })]);
  });

  it("builds the default Meta provider with a per-operation transport factory", async () => {
    const factory = vi.fn(({ allowedMutationExternalIds }) => ({
      async post(input: { path: string }) {
        if (!allowedMutationExternalIds.includes(input.path)) {
          throw new Error("fixture allowlist mismatch");
        }
        return { success: true };
      },
      async get(input: { path: string }) {
        return { id: input.path, status: "PAUSED" };
      },
    }));
    const registry = new ProviderRegistry(undefined, {
      metaMarketingApiTransportFactory: factory,
    });
    const result = await registry.changeStatus(
      "meta-marketing-api",
      {
        accountId: "meta-account",
        settings: {
          kind: "meta-marketing-api",
          profileId: "11111111-1111-4111-8111-111111111111",
          adAccountId: "act_300000000000003",
          pageId: "400000000000004",
          liveMode: "manual-status",
          allowedStatusEntityTypes: ["ad"],
        },
        credential: {
          appSecret: "fixture-app-secret-with-enough-length",
          accessToken: "fixture-token-with-enough-length",
        },
        resolvedMetaAccessProfile: {
          profileId: "11111111-1111-4111-8111-111111111111",
          appId: "100000000000001",
          graphApiVersion: "v99.0",
        },
      },
      [{ entityType: "ad", externalId: "500000000000005", action: "disable" }],
    );

    expect(result).toEqual([expect.objectContaining({ ok: true })]);
    expect(factory).toHaveBeenCalledWith({
      purpose: "account-operation",
      accountId: "meta-account",
      adAccountId: "act_300000000000003",
      profileId: "11111111-1111-4111-8111-111111111111",
      liveMode: "manual-status",
      allowedMutationExternalIds: ["500000000000005"],
      allowedCreationPaths: [],
    });
  });

  it("routes explicit Meta account discovery through a read-only profile transport", async () => {
    const factory = vi.fn(() => ({
      async get() {
        return { data: [{
          id: "act_300000000000003",
          name: "fixture",
          currency: "USD",
          timezone_name: "Asia/Shanghai",
          account_status: 1,
        }] };
      },
      async post() {
        throw new Error("unexpected write");
      },
    }));
    const registry = new ProviderRegistry(undefined, {
      metaMarketingApiTransportFactory: factory,
    });

    await expect(registry.discoverMetaAdAccounts({
      credential: {
        appSecret: "fixture-app-secret-with-enough-length",
        accessToken: "fixture-token-with-enough-length",
      },
      resolvedMetaAccessProfile: {
        profileId: "11111111-1111-4111-8111-111111111111",
        appId: "100000000000001",
        businessId: null,
        graphApiVersion: "v99.0",
      },
    })).resolves.toEqual([expect.objectContaining({
      adAccountId: "act_300000000000003",
    })]);
    expect(factory).toHaveBeenCalledWith({
      purpose: "account-discovery",
      accountId: null,
      adAccountId: null,
      profileId: "11111111-1111-4111-8111-111111111111",
      liveMode: "read-only",
      allowedMutationExternalIds: [],
      allowedCreationPaths: [],
    });
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
