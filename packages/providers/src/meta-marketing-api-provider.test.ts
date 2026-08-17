import { afterEach, describe, expect, it, vi } from "vitest";
import {
  META_MARKETING_API_NETWORK_DISABLED_MESSAGE,
  MetaMarketingApiAdsProvider,
  MetaMarketingApiMutationRejectedError,
  MetaMarketingApiNetworkDisabledError,
  type MetaMarketingApiTransport,
  type MetaMarketingApiTransportMutationRequest,
  type MetaMarketingApiTransportRequest,
  type MetaMarketingApiStatusTestScope,
} from "./meta-marketing-api-provider.js";
import { normalizeProviderEntity } from "@tk-auto/core";
import type { ProviderContext } from "./types.js";

const context = {
  accountId: "meta-read-test",
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
  timezone: "Asia/Shanghai",
  resolvedMetaAccessProfile: {
    profileId: "11111111-1111-4111-8111-111111111111",
    appId: "100000000000001",
    businessId: "200000000000002",
    graphApiVersion: "v99.0",
  },
} satisfies ProviderContext;

const activeAccountDiscoveryPayload = {
  data: [{
    id: "act_300000000000003",
    name: "fixture account",
    currency: "USD",
    timezone_name: "Asia/Shanghai",
    account_status: 1,
  }],
};
const EXPECTED_APP_SECRET_PROOF =
  "997effed9cb216bf7d410d1948c46f384eb2ec855251b093a3b366af151e8fff";

function statusScope(
  entityType: MetaMarketingApiStatusTestScope["entityType"],
  externalId = "500000000000005",
): MetaMarketingApiStatusTestScope {
  return {
    localAccountId: context.accountId,
    adAccountId: context.settings.adAccountId,
    entityType,
    externalId,
    expectedCurrency: "USD",
    expectedTimezone: "Asia/Shanghai",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function statusProvider(
  transport: MetaMarketingApiTransport,
  entityType: MetaMarketingApiStatusTestScope["entityType"],
  externalId = "500000000000005",
): MetaMarketingApiAdsProvider {
  return new MetaMarketingApiAdsProvider(
    transport,
    statusScope(entityType, externalId),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("MetaMarketingApiAdsProvider", () => {
  it("keeps a registry factory unreachable while the account mode is disabled", async () => {
    const factory = vi.fn((): MetaMarketingApiTransport => ({
      async get() {
        throw new Error("unexpected network");
      },
      async post() {
        throw new Error("unexpected network");
      },
    }));
    const provider = new MetaMarketingApiAdsProvider(factory);

    await expect(provider.checkHealth(context))
      .rejects.toBeInstanceOf(MetaMarketingApiNetworkDisabledError);
    expect(factory).not.toHaveBeenCalled();
    expect(provider.resolveCapabilities(context)).not.toContain("change-status");
  });

  it("keeps read-only accounts free of status capability and ads_management", async () => {
    const factory = vi.fn((): MetaMarketingApiTransport => ({
      async get(input) {
        return input.path === "me/permissions"
          ? { data: [{ permission: "ads_read", status: "granted" }] }
          : activeAccountDiscoveryPayload;
      },
      async post() {
        throw new Error("unexpected write");
      },
    }));
    const provider = new MetaMarketingApiAdsProvider(factory);
    const readOnlyContext = {
      ...context,
      settings: {
        ...context.settings,
        liveMode: "read-only" as const,
        allowedStatusEntityTypes: ["ad" as const],
      },
    } satisfies ProviderContext;

    await expect(provider.checkHealth(readOnlyContext)).resolves.toMatchObject({
      ok: true,
      message: expect.not.stringContaining("ads_management"),
    });
    expect(provider.resolveCapabilities(readOnlyContext)).not.toContain("change-status");
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      accountId: context.accountId,
      liveMode: "read-only",
      allowedMutationExternalIds: [],
    }));
  });

  it("accepts ads_management as sufficient read access for a read-only account", async () => {
    const provider = new MetaMarketingApiAdsProvider({
      async get(input) {
        return input.path === "me/permissions"
          ? { data: [{ permission: "ads_management", status: "granted" }] }
          : activeAccountDiscoveryPayload;
      },
      async post() {
        throw new Error("unexpected write");
      },
    });
    const readOnlyContext = {
      ...context,
      settings: {
        ...context.settings,
        liveMode: "read-only" as const,
        allowedStatusEntityTypes: [],
      },
    } satisfies ProviderContext;

    await expect(provider.checkHealth(readOnlyContext)).resolves.toMatchObject({
      ok: true,
      status: "ready",
      message: expect.stringContaining("ads_management（含读取）"),
    });
    expect(provider.resolveCapabilities(readOnlyContext)).not.toContain("change-status");
  });

  it("exposes two-level creation readiness without requiring a Page binding or Page Token", async () => {
    const get = vi.fn(async (input: MetaMarketingApiTransportRequest) => input.path === "me/permissions"
      ? { data: [{ permission: "ads_management", status: "granted" }] }
      : activeAccountDiscoveryPayload);
    const provider = new MetaMarketingApiAdsProvider({
      get,
      async post() { throw new Error("unexpected write"); },
    });
    const creationContext = {
      ...context,
      settings: {
        kind: "meta-marketing-api" as const,
        profileId: context.settings.profileId,
        adAccountId: context.settings.adAccountId,
        pageId: null,
        liveMode: "read-only" as const,
        creationMode: "paused-only" as const,
      },
    } satisfies ProviderContext;

    await expect(provider.checkHealth(creationContext)).resolves.toMatchObject({
      ok: true,
      status: "ready",
      message: expect.stringContaining("ads_management"),
    });
    expect(provider.resolveCapabilities(creationContext)).toContain("create-campaigns");
    expect(get.mock.calls.map(([request]) => request.path)).toEqual([
      "me/permissions",
      "200000000000002/owned_ad_accounts",
    ]);
  });

  it.each(["manual-status", "automation-status"] as const)(
    "gates %s with ads_management and a single-object transport allowlist",
    async (liveMode) => {
      const factory = vi.fn(({ allowedMutationExternalIds }): MetaMarketingApiTransport => ({
        async get(input) {
          if (input.path === "me/permissions") {
            return { data: [
              { permission: "ads_read", status: "granted" },
              { permission: "ads_management", status: "granted" },
            ] };
          }
          if (input.path.endsWith("/owned_ad_accounts")) {
            return activeAccountDiscoveryPayload;
          }
          return { id: input.path, status: "PAUSED" };
        },
        async post(input) {
          if (!allowedMutationExternalIds.includes(input.path)) {
            throw new Error("fixture allowlist mismatch");
          }
          return { success: true };
        },
      }));
      const provider = new MetaMarketingApiAdsProvider(factory);
      const statusContext = {
        ...context,
        settings: {
          ...context.settings,
          liveMode,
          allowedStatusEntityTypes: ["ad" as const],
        },
      } satisfies ProviderContext;

      await expect(provider.checkHealth(statusContext)).resolves.toMatchObject({
        ok: true,
        message: expect.stringContaining("ads_management"),
      });
      expect(provider.resolveCapabilities(statusContext)).toContain("change-status");
      await expect(provider.changeStatus(statusContext, [{
        entityType: "ad",
        externalId: "500000000000005",
        action: "disable",
      }])).resolves.toEqual([expect.objectContaining({ ok: true })]);
      expect(factory).toHaveBeenLastCalledWith(expect.objectContaining({
        liveMode,
        allowedMutationExternalIds: ["500000000000005"],
      }));
    },
  );

  it.each(["manual-status", "automation-status"] as const)(
    "refuses %s health when ads_management is missing",
    async (liveMode) => {
      const provider = new MetaMarketingApiAdsProvider(() => ({
        async get(input) {
          return input.path === "me/permissions"
            ? { data: [{ permission: "ads_read", status: "granted" }] }
            : { id: "300000000000003" };
        },
        async post() {
          throw new Error("unexpected write");
        },
      }));
      const statusContext = {
        ...context,
        settings: {
          ...context.settings,
          liveMode,
          allowedStatusEntityTypes: ["ad" as const],
        },
      } satisfies ProviderContext;

      await expect(provider.checkHealth(statusContext)).rejects.toThrow("ads_management");
    },
  );

  it("rejects an entity type outside the per-account status policy before factory creation", async () => {
    const factory = vi.fn((): MetaMarketingApiTransport => ({
      async get() { return {}; },
      async post() { return { success: true }; },
    }));
    const provider = new MetaMarketingApiAdsProvider(factory);
    const statusContext = {
      ...context,
      settings: {
        ...context.settings,
        liveMode: "manual-status" as const,
        allowedStatusEntityTypes: ["ad" as const],
      },
    } satisfies ProviderContext;

    await expect(provider.changeStatus(statusContext, [{
      entityType: "campaign",
      externalId: "500000000000005",
      action: "disable",
    }])).resolves.toEqual([expect.objectContaining({
      ok: false,
      failureKind: "retryable",
      message: expect.stringContaining("允许范围"),
    })]);
    expect(factory).not.toHaveBeenCalled();
  });

  it("keeps the default desktop transport physically offline", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new MetaMarketingApiAdsProvider();

    await expect(provider.checkHealth(context)).rejects.toEqual(
      expect.objectContaining({
        name: "MetaMarketingApiNetworkDisabledError",
        message: META_MARKETING_API_NETWORK_DISABLED_MESSAGE,
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(provider.capabilities).toEqual(new Set([
      "read-campaigns",
      "read-ad-groups",
      "read-ads",
      "change-status",
      "create-campaigns",
      "copy-campaigns",
    ]));
    expect(provider.resolveCapabilities(context)).not.toContain("change-status");
    const statusTestProvider = new MetaMarketingApiAdsProvider(
      undefined,
      statusScope("campaign"),
    );
    await expect(statusTestProvider.changeStatus(context, [{
      entityType: "campaign",
      externalId: "500000000000005",
      action: "disable",
    }])).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        failureKind: "retryable",
        message: META_MARKETING_API_NETWORK_DISABLED_MESSAGE,
      }),
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("validates the selected account through an injected fixture transport", async () => {
    const requests: MetaMarketingApiTransportRequest[] = [];
    const transport: MetaMarketingApiTransport = {
      async get(input) {
        requests.push(input);
        return input.path === "me/permissions"
          ? { data: [{ permission: "ads_read", status: "granted" }] }
          : activeAccountDiscoveryPayload;
      },
      async post() {
        throw new Error("unexpected write");
      },
    };
    const provider = new MetaMarketingApiAdsProvider(transport);

    await expect(provider.checkHealth(context)).resolves.toMatchObject({
      ok: true,
      status: "ready",
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      version: "v99.0",
      path: "me/permissions",
    });
    expect(requests[1]).toMatchObject({
      version: "v99.0",
      path: "200000000000002/owned_ad_accounts",
    });
    expect(requests.every((request) => request.accessToken === context.credential.accessToken))
      .toBe(true);
    expect(requests.every((request) => request.appSecretProof === EXPECTED_APP_SECRET_PROOF))
      .toBe(true);
    expect(requests.every((request) => !("appSecret" in request))).toBe(true);
  });

  it("discovers paginated owned accounts without mutating or persisting a binding", async () => {
    const requests: MetaMarketingApiTransportRequest[] = [];
    const provider = new MetaMarketingApiAdsProvider({
      async get(input) {
        requests.push(input);
        return input.params.after
          ? { data: [{
              id: "act_300000000000004",
              name: "second",
              currency: "USD",
              timezone_name: "Asia/Shanghai",
              account_status: "1",
            }] }
          : {
              data: activeAccountDiscoveryPayload.data,
              paging: { cursors: { after: "next-account" }, next: "fixture-next" },
            };
      },
      async post() {
        throw new Error("unexpected write");
      },
    });

    const accounts = await provider.discoverAdAccounts({
      credential: context.credential,
      resolvedMetaAccessProfile: context.resolvedMetaAccessProfile,
    });
    expect(accounts).toEqual([
      expect.objectContaining({ adAccountId: "act_300000000000003", accountStatus: 1 }),
      expect.objectContaining({ adAccountId: "act_300000000000004", accountStatus: 1 }),
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      path: "200000000000002/owned_ad_accounts",
      params: expect.objectContaining({
        fields: "id,name,currency,timezone_name,account_status",
      }),
      appSecretProof: EXPECTED_APP_SECRET_PROOF,
    });
  });

  it("discovers /me/adaccounts when the shared profile has no Business Portfolio", async () => {
    const get = vi.fn(async () => ({ data: activeAccountDiscoveryPayload.data }));
    const provider = new MetaMarketingApiAdsProvider({
      get,
      async post() { throw new Error("unexpected write"); },
    });

    await expect(provider.discoverAdAccounts({
      credential: context.credential,
      resolvedMetaAccessProfile: {
        ...context.resolvedMetaAccessProfile,
        businessId: null,
      },
    })).resolves.toHaveLength(1);
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ path: "me/adaccounts" }));
  });

  it.each([
    {
      field: "currency",
      value: "EUR",
      message: "币种必须为 USD",
    },
    {
      field: "timezone_name",
      value: "UTC",
      message: "时区必须为 Asia/Shanghai",
    },
    {
      field: "account_status",
      value: 2,
      message: "不是可投放的 ACTIVE",
    },
  ] as const)("rejects an unhealthy bound account when $field drifts", async ({
    field,
    value,
    message,
  }) => {
    const provider = new MetaMarketingApiAdsProvider({
      async get(input) {
        if (input.path === "me/permissions") {
          return { data: [{ permission: "ads_read", status: "granted" }] };
        }
        return {
          data: [{ ...activeAccountDiscoveryPayload.data[0], [field]: value }],
        };
      },
      async post() { throw new Error("unexpected write"); },
    });
    await expect(provider.checkHealth(context)).rejects.toThrow(message);
  });

  it("fails closed before transport creation when the resolved profile mismatches the binding", async () => {
    const factory = vi.fn((): MetaMarketingApiTransport => ({
      async get() { throw new Error("unexpected network"); },
      async post() { throw new Error("unexpected network"); },
    }));
    const provider = new MetaMarketingApiAdsProvider(factory);
    const mismatch = {
      ...context,
      settings: {
        ...context.settings,
        profileId: "22222222-2222-4222-8222-222222222222",
      },
    } satisfies ProviderContext;

    await expect(provider.checkHealth(mismatch)).rejects.toThrow("Profile 与账户绑定不一致");
    expect(factory).not.toHaveBeenCalled();
  });

  it("authorizes change-status only when the fixed scope and ads_management are verified", async () => {
    const transport: MetaMarketingApiTransport = {
      async get(input) {
        if (input.path === "me/permissions") {
          return {
            data: [
              { permission: "ads_read", status: "granted" },
              { permission: "ads_management", status: "granted" },
            ],
          };
        }
        return {
          ...activeAccountDiscoveryPayload,
        };
      },
      async post() {
        throw new Error("unexpected write");
      },
    };
    const provider = statusProvider(transport, "ad");

    await expect(provider.checkHealth(context)).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining("ads_management"),
    });
    expect(provider.resolveCapabilities(context)).toContain("change-status");
  });

  it("refuses status authorization when ads_management is absent", async () => {
    const provider = statusProvider({
      async get(input) {
        return input.path === "me/permissions"
          ? { data: [{ permission: "ads_read", status: "granted" }] }
          : {
              id: "300000000000003",
              currency: "USD",
              timezone_name: "Asia/Shanghai",
            };
      },
      async post() {
        throw new Error("unexpected write");
      },
    }, "ad");

    await expect(provider.checkHealth(context)).rejects.toThrow("ads_management");
  });

  it("merges paginated account-today Insights into all three Meta layers", async () => {
    const requests: MetaMarketingApiTransportRequest[] = [];
    const transport: MetaMarketingApiTransport = {
      async get(input) {
        requests.push(input);
        if (input.path.endsWith("/campaigns")) {
          return input.params.after
            ? { data: [{ id: "c2", name: "Campaign 2", status: "PAUSED" }] }
            : {
                data: [{
                  id: "c1",
                  name: "Campaign 1",
                  status: "ACTIVE",
                  effective_status: "PAUSED",
                  created_time: "2026-08-16T01:02:03.000Z",
                }],
                paging: { cursors: { after: "next-campaign" }, next: "fixture-next" },
              };
        }
        if (input.path.endsWith("/adsets")) {
          return { data: [{ id: "s1", campaign_id: "c1", status: "PAUSED" }] };
        }
        if (input.path.endsWith("/ads")) {
          return { data: [{
            id: "a1",
            adset_id: "s1",
            campaign_id: "c1",
            status: "PAUSED",
            created_time: "2026-08-16T02:03:04.000Z",
          }] };
        }
        if (input.path.endsWith("/insights")) {
          if (input.params.level === "campaign") {
            return input.params.after
              ? { data: [{ campaign_id: "c2", spend: "0" }] }
              : {
                  data: [{
                    campaign_id: "c1",
                    spend: "10",
                    cpc: "0.5",
                    actions: [
                      { action_type: "offsite_conversion.fb_pixel_purchase", value: "2" },
                      { action_type: "omni_purchase", value: "2" },
                      { action_type: "purchase", value: "2" },
                      { action_type: "offsite_conversion.fb_pixel_add_to_cart", value: "3" },
                      { action_type: "omni_add_to_cart", value: "3" },
                    ],
                    cost_per_action_type: [
                      { action_type: "offsite_conversion.fb_pixel_purchase", value: "6" },
                      { action_type: "omni_purchase", value: "5" },
                    ],
                  }],
                  paging: { cursors: { after: "next-insight" }, next: "fixture-next" },
                };
          }
          if (input.params.level === "adset") {
            return { data: [{ adset_id: "s1", spend: "4", cpc: "1" }] };
          }
          return { data: [{ ad_id: "a1", spend: "4", cpc: "1" }] };
        }
        throw new Error(`unexpected path: ${input.path}`);
      },
      async post() {
        throw new Error("unexpected write");
      },
    };
    const provider = new MetaMarketingApiAdsProvider(transport);
    const output = await provider.syncReadOnly(context);

    expect(output.entities.map(({ entityType, externalId }) => ({ entityType, externalId })))
      .toEqual([
        { entityType: "campaign", externalId: "c1" },
        { entityType: "campaign", externalId: "c2" },
        { entityType: "ad-group", externalId: "s1" },
        { entityType: "ad", externalId: "a1" },
      ]);
    expect(output.result.counts).toMatchObject({ campaign: 2, "ad-group": 1, ad: 1 });
    expect(output.result.quality).toMatchObject({
      status: "healthy",
      paginationComplete: true,
      contractValid: true,
      requiredMetricsComplete: true,
      completeEntityTypes: ["campaign", "ad-group", "ad"],
      partialFailures: [],
    });
    const snapshots = output.entities.map(normalizeProviderEntity);
    expect(snapshots.map((entity) => entity.status))
      .toEqual(["enabled", "disabled", "disabled", "disabled"]);
    expect(snapshots[0]).toMatchObject({
      createdAt: "2026-08-16T01:02:03.000Z",
      metrics: {
        spend: 10,
        cost_per_click: 0.5,
        conversions: 2,
        carts: 3,
        cost_per_conversion: 5,
      },
    });
    expect(snapshots[3]).toMatchObject({
      parentCampaignId: "c1",
      parentAdGroupId: "s1",
      createdAt: "2026-08-16T02:03:04.000Z",
    });
    expect(output.entities[0]?.payload).toMatchObject({
      operation_status: "ACTIVE",
      effective_status: "PAUSED",
      metaConversionActionType: "omni_purchase",
      metaCartActionType: "omni_add_to_cart",
    });
    expect(requests.filter((item) => item.path.endsWith("/campaigns"))).toHaveLength(2);
    expect(requests.filter((item) => item.path.endsWith("/insights"))).toHaveLength(4);
    expect(requests.filter((item) => item.path.endsWith("/insights"))[0]).toMatchObject({
      params: expect.objectContaining({
        date_preset: "today",
        level: "campaign",
        fields: expect.stringContaining("cost_per_action_type"),
      }),
    });
  });

  it("invalidates sync when an Insights row does not match a synced object", async () => {
    const provider = new MetaMarketingApiAdsProvider({
      async get(input) {
        if (input.path.endsWith("/campaigns")) return { data: [{ id: "c1", status: "ACTIVE" }] };
        if (input.path.endsWith("/adsets")) return { data: [{ id: "s1", campaign_id: "c1", status: "ACTIVE" }] };
        if (input.path.endsWith("/ads")) return { data: [{ id: "a1", adset_id: "s1", campaign_id: "c1", status: "ACTIVE" }] };
        if (input.path.endsWith("/insights")) {
          if (input.params.level === "campaign") return { data: [{ campaign_id: "unknown", spend: "1" }] };
          if (input.params.level === "adset") return { data: [{ adset_id: "s1", spend: "1" }] };
          return { data: [{ ad_id: "a1", spend: "1" }] };
        }
        throw new Error(`unexpected path: ${input.path}`);
      },
      async post() {
        throw new Error("unexpected write");
      },
    });

    const output = await provider.syncReadOnly(context);
    expect(output.result.quality).toMatchObject({
      status: "invalid",
      contractValid: false,
      completeEntityTypes: [],
    });
  });

  it("treats omitted zero-delivery objects as healthy zero metrics", async () => {
    const provider = new MetaMarketingApiAdsProvider({
      async get(input) {
        if (input.path.endsWith("/campaigns")) return { data: [{ id: "c1", status: "ACTIVE" }] };
        if (input.path.endsWith("/adsets")) return { data: [{ id: "s1", campaign_id: "c1", status: "ACTIVE" }] };
        if (input.path.endsWith("/ads")) return { data: [{ id: "a1", adset_id: "s1", campaign_id: "c1", status: "ACTIVE" }] };
        if (input.path.endsWith("/insights")) return { data: [] };
        throw new Error(`unexpected path: ${input.path}`);
      },
      async post() { throw new Error("unexpected write"); },
    });

    const output = await provider.syncReadOnly(context);
    expect(output.result.quality).toMatchObject({
      status: "healthy",
      requiredMetricsComplete: true,
      contractValid: true,
    });
    for (const entity of output.entities.map(normalizeProviderEntity)) {
      expect(entity.metrics).toMatchObject({
        spend: 0,
        cost_per_click: 0,
        conversions: 0,
        carts: 0,
        cost_per_conversion: 0,
      });
    }
  });

  it("rejects a fixture account mismatch", async () => {
    const provider = new MetaMarketingApiAdsProvider({
      async get(input) {
        return input.path === "me/permissions"
          ? { data: [{ permission: "ads_read", status: "granted" }] }
          : { data: [{
              id: "act_999",
              name: "other account",
              currency: "USD",
              timezone_name: "Asia/Shanghai",
              account_status: 1,
            }] };
      },
      async post() {
        throw new Error("unexpected write");
      },
    });
    await expect(provider.checkHealth(context)).rejects.toThrow("不属于当前共享凭据 Profile");
    await expect(new MetaMarketingApiAdsProvider().checkHealth(context))
      .rejects.toBeInstanceOf(MetaMarketingApiNetworkDisabledError);
  });

  it.each([
    { entityType: "campaign" as const, action: "enable" as const, expectedStatus: "ACTIVE" },
    { entityType: "campaign" as const, action: "disable" as const, expectedStatus: "PAUSED" },
    { entityType: "ad-group" as const, action: "enable" as const, expectedStatus: "ACTIVE" },
    { entityType: "ad-group" as const, action: "disable" as const, expectedStatus: "PAUSED" },
    { entityType: "ad" as const, action: "enable" as const, expectedStatus: "ACTIVE" },
    { entityType: "ad" as const, action: "disable" as const, expectedStatus: "PAUSED" },
  ])("maps $entityType $action and requires a matching readback", async ({
    entityType,
    action,
    expectedStatus,
  }) => {
    const getRequests: MetaMarketingApiTransportRequest[] = [];
    const postRequests: MetaMarketingApiTransportMutationRequest[] = [];
    const provider = statusProvider({
      async post(input) {
        postRequests.push(input);
        return { success: true };
      },
      async get(input) {
        getRequests.push(input);
        return {
          id: "500000000000005",
          status: expectedStatus,
          effective_status: expectedStatus,
        };
      },
    }, entityType);

    const result = await provider.changeStatus(context, [{
      entityType,
      externalId: "500000000000005",
      action,
    }]);

    expect(result).toEqual([expect.objectContaining({
      entityType,
      action,
      ok: true,
      message: expect.stringContaining(`status=${expectedStatus}`),
    })]);
    expect(postRequests).toEqual([expect.objectContaining({
      version: "v99.0",
      path: "500000000000005",
      body: { status: expectedStatus },
      accessToken: context.credential.accessToken,
    })]);
    expect(getRequests).toEqual([expect.objectContaining({
      path: "500000000000005",
      params: { fields: "id,status,effective_status" },
    })]);
  });

  it("rejects material locally without dispatching a mutation or readback", async () => {
    const get = vi.fn(async () => ({}));
    const post = vi.fn(async () => ({ success: true }));
    const provider = statusProvider({ get, post }, "ad");

    await expect(provider.changeStatus(context, [{
      entityType: "material",
      externalId: "500000000000005",
      action: "enable",
    }])).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        failureKind: "retryable",
        message: expect.stringContaining("未发送任何请求"),
      }),
    ]);
    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric object ID locally without dispatching", async () => {
    const get = vi.fn(async () => ({}));
    const post = vi.fn(async () => ({ success: true }));
    const provider = statusProvider({ get, post }, "campaign", "campaign/unsafe");

    await expect(provider.changeStatus(context, [{
      entityType: "campaign",
      externalId: "campaign/unsafe",
      action: "disable",
    }])).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        failureKind: "retryable",
        message: expect.stringContaining("必须是数字"),
      }),
    ]);
    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects invalid connection settings and credentials locally without dispatching", async () => {
    const get = vi.fn(async () => ({}));
    const post = vi.fn(async () => ({ success: true }));
    const provider = statusProvider({ get, post }, "ad");
    const invalidContext = {
      ...context,
      resolvedMetaAccessProfile: {
        ...context.resolvedMetaAccessProfile,
        graphApiVersion: "latest",
      },
    } satisfies ProviderContext;

    await expect(provider.changeStatus(invalidContext, [{
      entityType: "ad",
      externalId: "500000000000005",
      action: "enable",
    }])).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        failureKind: "retryable",
      }),
    ]);
    const invalidCredentialContext = {
      ...context,
      credential: {
        ...context.credential,
        accessToken: "short",
      },
    } satisfies ProviderContext;
    await expect(provider.changeStatus(invalidCredentialContext, [{
      entityType: "ad-group",
      externalId: "500000000000005",
      action: "disable",
    }])).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        failureKind: "retryable",
      }),
    ]);
    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("classifies a transport failure after mutation dispatch as unknown and does not replay", async () => {
    const get = vi.fn(async () => ({
      id: "500000000000005",
      status: "PAUSED",
    }));
    const post = vi.fn(async () => {
      throw new Error("fixture timeout after dispatch");
    });
    const provider = statusProvider({ get, post }, "ad");

    await expect(provider.changeStatus(context, [{
      entityType: "ad",
      externalId: "500000000000005",
      action: "disable",
    }])).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        failureKind: "unknown",
        message: "fixture timeout after dispatch",
      }),
    ]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  it("classifies an explicit transport rejection as retryable because the write did not dispatch", async () => {
    const get = vi.fn(async () => ({}));
    const post = vi.fn(async () => {
      throw new MetaMarketingApiMutationRejectedError("fixture explicit rejection");
    });
    const provider = statusProvider({ get, post }, "ad-group");

    await expect(provider.changeStatus(context, [{
      entityType: "ad-group",
      externalId: "500000000000005",
      action: "enable",
    }])).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        failureKind: "retryable",
        message: "fixture explicit rejection",
      }),
    ]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  it("classifies readback mismatch as unknown", async () => {
    const provider = statusProvider({
      async post() {
        return { success: true };
      },
      async get() {
        return {
          id: "500000000000005",
          status: "PAUSED",
          effective_status: "PAUSED",
        };
      },
    }, "campaign");

    await expect(provider.changeStatus(context, [{
      entityType: "campaign",
      externalId: "500000000000005",
      action: "enable",
    }])).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        failureKind: "unknown",
        message: expect.stringContaining("写后回读不一致"),
      }),
    ]);
  });

  it("keeps a readback transport failure unknown after POST resolved", async () => {
    const provider = statusProvider({
      async post() {
        return { success: true };
      },
      async get() {
        throw new MetaMarketingApiNetworkDisabledError("fixture readback unavailable");
      },
    }, "ad-group");

    await expect(provider.changeStatus(context, [{
      entityType: "ad-group",
      externalId: "500000000000005",
      action: "disable",
    }])).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        failureKind: "unknown",
        message: "fixture readback unavailable",
      }),
    ]);
  });

  it("uses a matching readback to resolve an ambiguous POST acknowledgement", async () => {
    const provider = statusProvider({
      async post() {
        return { unexpected: "ack shape" };
      },
      async get() {
        return {
          id: "500000000000005",
          status: "ACTIVE",
          effective_status: "CAMPAIGN_PAUSED",
        };
      },
    }, "ad");

    await expect(provider.changeStatus(context, [{
      entityType: "ad",
      externalId: "500000000000005",
      action: "enable",
    }])).resolves.toEqual([
      expect.objectContaining({
        ok: true,
        message: expect.stringContaining("effective_status=CAMPAIGN_PAUSED"),
      }),
    ]);
  });

  it("creates and reads back only Campaign and Ad Set without Page access", async () => {
    const remoteIds = {
      campaigns: "120000000000091",
      adsets: "120000000000092",
    } as const;
    const post = vi.fn(async (input: MetaMarketingApiTransportMutationRequest) => {
      if (input.body.execution_options) return { success: true };
      const edge = input.path.split("/").at(-1) as keyof typeof remoteIds;
      return { id: remoteIds[edge] };
    });
    const get = vi.fn(async (input: MetaMarketingApiTransportRequest) => ({
      id: input.path,
      name: input.path === remoteIds.campaigns ? "two-level campaign" : "two-level ad set",
      status: "PAUSED",
      effective_status: "PAUSED",
    }));
    const factory = vi.fn((): MetaMarketingApiTransport => ({ get, post }));
    const provider = new MetaMarketingApiAdsProvider(factory);
    const onBeforeDispatch = vi.fn();
    const progress: string[] = [];

    const result = await provider.createMetaAd({
      ...context,
      settings: {
        kind: "meta-marketing-api",
        profileId: context.settings.profileId,
        adAccountId: context.settings.adAccountId,
        pageId: null,
        liveMode: "read-only",
        creationMode: "paused-only",
      },
    }, {
      input: {
        idempotencyKey: "fixture-two-level-create-0001",
        targetLevel: "ad-set",
        campaignName: "two-level campaign",
        adSetName: "two-level ad set",
        objective: "OUTCOME_TRAFFIC",
        optimizationGoal: "LINK_CLICKS",
        billingEvent: "IMPRESSIONS",
        destinationType: "WEBSITE",
        dailyBudgetMinorUnits: 500,
        countries: ["US"],
      },
      existing: {},
      onBeforeDispatch,
      onProgress: (item) => progress.push(item.phase),
    });

    expect(result).toEqual({
      ok: true,
      campaignId: remoteIds.campaigns,
      adSetId: remoteIds.adsets,
      message: "Meta Campaign 与 Ad Set 已按 PAUSED 状态创建并回读确认。",
    });
    expect(result).not.toHaveProperty("creativeId");
    expect(result).not.toHaveProperty("adId");
    expect(progress).toEqual(["campaign", "campaign", "ad-set", "ad-set"]);
    expect(onBeforeDispatch).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls.map(([request]) => request.path)).toEqual([
      "act_300000000000003/campaigns",
      "act_300000000000003/campaigns",
      "act_300000000000003/adsets",
    ]);
    expect(get.mock.calls.map(([request]) => request.path)).toEqual([
      remoteIds.campaigns,
      remoteIds.adsets,
    ]);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      allowedCreationPaths: [
        "act_300000000000003/campaigns",
        "act_300000000000003/adsets",
      ],
    }));
  });

  it("copies Campaign + Ad Set without a Page ID and never reads or creates posts", async () => {
    const sourceCampaignId = "120000000000201";
    const sourceAdSetId = "120000000000202";
    const remoteIds = {
      campaigns: "120000000000211",
      adsets: "120000000000212",
    } as const;
    const post = vi.fn(async (input: MetaMarketingApiTransportMutationRequest) => (
      input.body.execution_options ? { success: true } : { id: remoteIds[input.path.split("/").at(-1) as keyof typeof remoteIds] }
    ));
    const get = vi.fn(async (input: MetaMarketingApiTransportRequest) => {
      if (input.path === sourceCampaignId) {
        return {
          id: sourceCampaignId,
          name: "source campaign",
          objective: "OUTCOME_TRAFFIC",
          buying_type: "AUCTION",
          special_ad_categories: [],
          is_adset_budget_sharing_enabled: true,
          daily_budget: "1000",
        };
      }
      if (input.path === sourceAdSetId) {
        return {
          id: sourceAdSetId,
          name: "source ad set",
          campaign_id: sourceCampaignId,
          billing_event: "IMPRESSIONS",
          optimization_goal: "LINK_CLICKS",
          destination_type: "WEBSITE",
          targeting: { geo_locations: { countries: ["US"] } },
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
          daily_budget: "500",
        };
      }
      if (input.path === remoteIds.campaigns) {
        return { id: remoteIds.campaigns, name: "copied campaign", status: "PAUSED", effective_status: "PAUSED" };
      }
      if (input.path === remoteIds.adsets) {
        return { id: remoteIds.adsets, name: "copied ad set", campaign_id: remoteIds.campaigns, status: "PAUSED", effective_status: "CAMPAIGN_PAUSED" };
      }
      throw new Error(`unexpected GET ${input.path}`);
    });
    const factory = vi.fn((): MetaMarketingApiTransport => ({ get, post }));
    const provider = new MetaMarketingApiAdsProvider(factory);

    const result = await provider.copyCampaign({
      ...context,
      settings: {
        kind: "meta-marketing-api",
        profileId: context.settings.profileId,
        adAccountId: context.settings.adAccountId,
        pageId: null,
        liveMode: "read-only",
        creationMode: "paused-only",
      },
    }, {
      sourceCampaignId,
      campaignName: "copied campaign",
      adGroups: [{ sourceAdGroupId: sourceAdSetId, name: "copied ad set" }],
      initialStatus: "disabled",
      createNewPosts: false,
    });

    expect(result).toEqual({
      ok: true,
      campaignId: remoteIds.campaigns,
      adGroupIds: [remoteIds.adsets],
      message: "Meta Campaign 与 Ad Set 已按 PAUSED 状态复制并回读确认；未创建新帖子。",
    });
    expect(get.mock.calls.map(([request]) => request.path)).not.toContain("me/accounts");
    expect(get.mock.calls.map(([request]) => request.path)).not.toContain("ads");
    expect(post.mock.calls.map(([request]) => request.path)).toEqual([
      "act_300000000000003/campaigns",
      "act_300000000000003/campaigns",
      "act_300000000000003/adsets",
      "act_300000000000003/adsets",
    ]);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      allowedCreationPaths: [
        "act_300000000000003/campaigns",
        "act_300000000000003/adsets",
      ],
    }));
  });

  it("rejects Meta copy when the new-post gate is not explicitly closed", async () => {
    const get = vi.fn();
    const post = vi.fn();
    const provider = new MetaMarketingApiAdsProvider({ get, post });

    const result = await provider.copyCampaign({
      ...context,
      settings: {
        ...context.settings,
        pageId: null,
        liveMode: "read-only",
        creationMode: "paused-only",
      },
    }, {
      sourceCampaignId: "120000000000201",
      campaignName: "copy blocked",
      adGroups: [{ sourceAdGroupId: "120000000000202", name: "copy blocked group" }],
      initialStatus: "disabled",
      createNewPosts: true,
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "failed",
      message: expect.stringContaining("禁止创建新帖子"),
    });
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("marks a partial Campaign copy unknown and never auto-retryable", async () => {
    const sourceCampaignId = "120000000000301";
    const sourceAdSetId = "120000000000302";
    const createdCampaignId = "120000000000311";
    const post = vi.fn(async (input: MetaMarketingApiTransportMutationRequest) => {
      if (input.path.endsWith("/campaigns") && input.body.execution_options) return { success: true };
      if (input.path.endsWith("/campaigns")) return { id: createdCampaignId };
      throw new MetaMarketingApiMutationRejectedError("fixture Ad Set validate rejected");
    });
    const get = vi.fn(async (input: MetaMarketingApiTransportRequest) => {
      if (input.path === sourceCampaignId) return {
        id: sourceCampaignId,
        name: "source campaign",
        objective: "OUTCOME_TRAFFIC",
        special_ad_categories: [],
        daily_budget: "1000",
      };
      if (input.path === sourceAdSetId) return {
        id: sourceAdSetId,
        name: "source ad set",
        campaign_id: sourceCampaignId,
        targeting: {},
      };
      if (input.path === createdCampaignId) return {
        id: createdCampaignId,
        name: "partial campaign",
        status: "PAUSED",
      };
      throw new Error(`unexpected GET ${input.path}`);
    });
    const provider = new MetaMarketingApiAdsProvider({ get, post });

    const result = await provider.copyCampaign({
      ...context,
      settings: {
        ...context.settings,
        pageId: null,
        liveMode: "read-only",
        creationMode: "paused-only",
      },
    }, {
      sourceCampaignId,
      campaignName: "partial campaign",
      adGroups: [{ sourceAdGroupId: sourceAdSetId, name: "partial ad set" }],
      initialStatus: "disabled",
      createNewPosts: false,
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "unknown",
      retrySafe: false,
      message: "fixture Ad Set validate rejected",
    });
    expect(post.mock.calls.map(([request]) => request.path)).toEqual([
      "act_300000000000003/campaigns",
      "act_300000000000003/campaigns",
      "act_300000000000003/adsets",
    ]);
  });

  it("reconciles a two-level task as complete at a PAUSED Ad Set", async () => {
    const post = vi.fn();
    const get = vi.fn(async (input: MetaMarketingApiTransportRequest) => {
      if (input.path === "120000000000091") {
        return {
          id: input.path,
          name: "two-level campaign",
          status: "PAUSED",
          effective_status: "PAUSED",
        };
      }
      if (input.path === "120000000000092") {
        return {
          id: input.path,
          name: "two-level ad set",
          campaign_id: "120000000000091",
          status: "PAUSED",
          effective_status: "CAMPAIGN_PAUSED",
        };
      }
      throw new Error(`unexpected path ${input.path}`);
    });
    const provider = new MetaMarketingApiAdsProvider({ get, post });

    const result = await provider.reconcileMetaAd({
      ...context,
      settings: {
        kind: "meta-marketing-api",
        profileId: context.settings.profileId,
        adAccountId: context.settings.adAccountId,
        pageId: null,
        liveMode: "read-only",
        creationMode: "paused-only",
      },
    }, {
      input: {
        idempotencyKey: "fixture-two-level-reconcile-0001",
        targetLevel: "ad-set",
        campaignName: "two-level campaign",
        adSetName: "two-level ad set",
        objective: "OUTCOME_TRAFFIC",
        optimizationGoal: "LINK_CLICKS",
        billingEvent: "IMPRESSIONS",
        destinationType: "WEBSITE",
        dailyBudgetMinorUnits: 500,
        countries: ["US"],
      },
      existing: {
        campaignId: "120000000000091",
        adSetId: "120000000000092",
      },
    });

    expect(result).toEqual({
      ok: true,
      campaignId: "120000000000091",
      adSetId: "120000000000092",
      message: "Meta Campaign 与 Ad Set 已通过只读对账确认，且均保持 PAUSED。",
    });
    expect(post).not.toHaveBeenCalled();
    expect(get.mock.calls.map(([request]) => request.path)).toEqual([
      "120000000000091",
      "120000000000092",
    ]);
  });

  it("rejects an Ad-level task without a Page before any transport request", async () => {
    const get = vi.fn();
    const post = vi.fn();
    const provider = new MetaMarketingApiAdsProvider({ get, post });

    const result = await provider.createMetaAd({
      ...context,
      settings: {
        kind: "meta-marketing-api",
        profileId: context.settings.profileId,
        adAccountId: context.settings.adAccountId,
        pageId: null,
        liveMode: "read-only",
        creationMode: "paused-only",
      },
    }, {
      input: {
        idempotencyKey: "fixture-ad-without-page-0001",
        targetLevel: "ad",
        campaignName: "fixture campaign",
        adSetName: "fixture ad set",
        creativeName: "fixture creative",
        adName: "fixture ad",
        objective: "OUTCOME_TRAFFIC",
        optimizationGoal: "LINK_CLICKS",
        billingEvent: "IMPRESSIONS",
        destinationType: "WEBSITE",
        dailyBudgetMinorUnits: 500,
        countries: ["US"],
        destinationUrl: "https://example.com/product",
        primaryText: "fixture primary text",
        headline: "fixture headline",
        description: "",
        callToAction: "LEARN_MORE",
        imageHash: null,
      },
      existing: {},
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "retryable",
      message: expect.stringContaining("Page ID"),
    });
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("creates the full Meta website-ad chain as PAUSED and reports durable progress", async () => {
    const remoteIds = {
      campaigns: "120000000000101",
      adsets: "120000000000102",
      adcreatives: "120000000000103",
      ads: "120000000000104",
    } as const;
    const post = vi.fn(async (input: MetaMarketingApiTransportMutationRequest) => {
      if (input.body.execution_options) return { success: true };
      const edge = input.path.split("/").at(-1) as keyof typeof remoteIds;
      return { id: remoteIds[edge] };
    });
    const get = vi.fn(async (input: MetaMarketingApiTransportRequest) => {
      if (input.path === "me/accounts") {
        return {
          data: [{
            id: context.settings.pageId,
            access_token: "fixture-page-access-token-with-enough-length",
            tasks: ["ADVERTISE"],
          }],
        };
      }
      const names: Record<string, string> = {
        [remoteIds.campaigns]: "fixture campaign",
        [remoteIds.adsets]: "fixture ad set",
        [remoteIds.adcreatives]: "fixture creative 2026-08-17-c406ec5f16cc67b1851914b55cd55adf",
        [remoteIds.ads]: "fixture ad",
      };
      return {
        id: input.path,
        name: names[input.path],
        status: "PAUSED",
        effective_status: "PAUSED",
      };
    });
    const provider = new MetaMarketingApiAdsProvider({ get, post });
    const progress: string[] = [];
    const result = await provider.createMetaAd({
      ...context,
      settings: {
        ...context.settings,
        liveMode: "read-only",
        creationMode: "paused-only",
      },
    }, {
      input: {
        idempotencyKey: "fixture-create-0001",
        targetLevel: "ad",
        campaignName: "fixture campaign",
        adSetName: "fixture ad set",
        creativeName: "fixture creative",
        adName: "fixture ad",
        objective: "OUTCOME_TRAFFIC",
        optimizationGoal: "LINK_CLICKS",
        billingEvent: "IMPRESSIONS",
        destinationType: "WEBSITE",
        dailyBudgetMinorUnits: 500,
        countries: ["US"],
        destinationUrl: "https://example.com/product",
        primaryText: "fixture primary text",
        headline: "fixture headline",
        description: "fixture description",
        callToAction: "LEARN_MORE",
        imageHash: null,
      },
      existing: {},
      onProgress: (item) => progress.push(item.phase),
    });

    expect(result).toMatchObject({
      ok: true,
      campaignId: remoteIds.campaigns,
      adSetId: remoteIds.adsets,
      creativeId: remoteIds.adcreatives,
      adId: remoteIds.ads,
    });
    expect(progress).toEqual([
      "campaign", "campaign",
      "ad-set", "ad-set",
      "creative", "creative",
      "ad", "ad",
    ]);
    expect(post).toHaveBeenCalledTimes(7);
    expect(get).toHaveBeenCalledTimes(5);
    expect(post.mock.calls[2]?.[0]).toMatchObject({
      path: "act_300000000000003/campaigns",
      body: expect.objectContaining({ status: "PAUSED", objective: "OUTCOME_TRAFFIC" }),
    });
    expect(post.mock.calls[3]?.[0]).toMatchObject({
      path: "act_300000000000003/adsets",
      body: expect.objectContaining({
        campaign_id: remoteIds.campaigns,
        status: "PAUSED",
      }),
    });
    expect(post.mock.calls[5]?.[0]).toMatchObject({
      path: "act_300000000000003/ads",
      accessToken: "fixture-page-access-token-with-enough-length",
      body: expect.objectContaining({
        adset_id: remoteIds.adsets,
        status: "PAUSED",
        execution_options: '["validate_only"]',
      }),
    });
    expect(post.mock.calls[6]?.[0]).toMatchObject({
      path: "act_300000000000003/ads",
      accessToken: "fixture-page-access-token-with-enough-length",
      body: expect.objectContaining({
        adset_id: remoteIds.adsets,
        status: "PAUSED",
      }),
    });
  });

  it("reuses confirmed Campaign, Ad Set, and Creative IDs and dispatches only the final Ad write", async () => {
    const existing = {
      campaignId: "120000000000201",
      adSetId: "120000000000202",
      creativeId: "120000000000203",
    };
    const adId = "120000000000204";
    const onBeforeDispatch = vi.fn();
    const post = vi.fn(async (input: MetaMarketingApiTransportMutationRequest) => {
      if (input.body.execution_options) return { success: true };
      if (!input.path.endsWith("/ads")) {
        throw new Error(`unexpected resumed write: ${input.path}`);
      }
      return { id: adId };
    });
    const get = vi.fn(async (input: MetaMarketingApiTransportRequest) => {
      if (input.path === "me/accounts") {
        return {
          data: [{
            id: context.settings.pageId,
            access_token: "fixture-page-access-token-with-enough-length",
            tasks: ["ADVERTISE"],
          }],
        };
      }
      return {
        id: adId,
        name: "fixture resumed ad",
        status: "PAUSED",
        effective_status: "PAUSED",
      };
    });
    const provider = new MetaMarketingApiAdsProvider({ get, post });

    const result = await provider.createMetaAd({
      ...context,
      settings: {
        ...context.settings,
        creationMode: "paused-only",
      },
    }, {
      input: {
        idempotencyKey: "fixture-resume-ad-0001",
        targetLevel: "ad",
        campaignName: "fixture resumed campaign",
        adSetName: "fixture resumed ad set",
        creativeName: "fixture resumed creative",
        adName: "fixture resumed ad",
        objective: "OUTCOME_TRAFFIC",
        optimizationGoal: "LINK_CLICKS",
        billingEvent: "IMPRESSIONS",
        destinationType: "WEBSITE",
        dailyBudgetMinorUnits: 500,
        countries: ["US"],
        destinationUrl: "https://example.com/product",
        primaryText: "fixture primary text",
        headline: "fixture headline",
        description: "",
        callToAction: "LEARN_MORE",
        imageHash: null,
      },
      existing,
      onBeforeDispatch,
    });

    expect(result).toMatchObject({ ok: true, ...existing, adId });
    expect(onBeforeDispatch).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(4);
    expect(post.mock.calls.filter(([request]) => !request.body.execution_options))
      .toEqual([[expect.objectContaining({
        path: "act_300000000000003/ads",
        body: expect.objectContaining({
          adset_id: existing.adSetId,
          status: "PAUSED",
        }),
      })]]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("stops before every real creation write when the creative preflight is rejected", async () => {
    const post = vi.fn(async (input: MetaMarketingApiTransportMutationRequest) => {
      if (input.body.execution_options && input.path.endsWith("/campaigns")) {
        return { success: true };
      }
      if (input.body.execution_options && input.path.endsWith("/adcreatives")) {
        throw new MetaMarketingApiMutationRejectedError(
          "Meta App 仍处于开发模式，Creative validate_only 被拒绝。",
        );
      }
      return { id: "120000000000999" };
    });
    const get = vi.fn(async (input: MetaMarketingApiTransportRequest) => input.path === "me/accounts"
      ? {
          data: [{
            id: context.settings.pageId,
            access_token: "fixture-page-access-token-with-enough-length",
            tasks: ["ADVERTISE"],
          }],
        }
      : { id: input.path, status: "PAUSED", effective_status: "PAUSED" });
    const provider = new MetaMarketingApiAdsProvider({ get, post });

    const result = await provider.createMetaAd({
      ...context,
      settings: {
        ...context.settings,
        creationMode: "paused-only",
      },
    }, {
      input: {
        idempotencyKey: "fixture-preflight-0001",
        targetLevel: "ad",
        campaignName: "fixture campaign",
        adSetName: "fixture ad set",
        creativeName: "fixture creative",
        adName: "fixture ad",
        objective: "OUTCOME_TRAFFIC",
        optimizationGoal: "LINK_CLICKS",
        billingEvent: "IMPRESSIONS",
        destinationType: "WEBSITE",
        dailyBudgetMinorUnits: 500,
        countries: ["US"],
        destinationUrl: "https://example.com/product",
        primaryText: "fixture primary text",
        headline: "fixture headline",
        description: "",
        callToAction: "LEARN_MORE",
        imageHash: null,
      },
      existing: {},
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "retryable",
      message: expect.stringContaining("开发模式"),
    });
    expect(result).not.toHaveProperty("campaignId");
    expect(result).not.toHaveProperty("adSetId");
    expect(result).not.toHaveProperty("creativeId");
    expect(result).not.toHaveProperty("adId");
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.every(([request]) => request.body.execution_options === '["validate_only"]'))
      .toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("reconciles an unknown creation read-only and proves the missing next layer", async () => {
    const post = vi.fn();
    const get = vi.fn(async (input: MetaMarketingApiTransportRequest) => {
      if (input.path === "120000000000101") {
        return {
          id: input.path,
          name: "fixture campaign",
          status: "PAUSED",
          effective_status: "PAUSED",
        };
      }
      if (input.path === "120000000000102") {
        return {
          id: input.path,
          name: "fixture ad set",
          campaign_id: "120000000000101",
          status: "PAUSED",
          effective_status: "CAMPAIGN_PAUSED",
        };
      }
      if (input.path === "act_300000000000003/adcreatives") {
        return { data: [] };
      }
      throw new Error(`unexpected path ${input.path}`);
    });
    const provider = new MetaMarketingApiAdsProvider({ get, post });
    const result = await provider.reconcileMetaAd({
      ...context,
      settings: {
        ...context.settings,
        creationMode: "paused-only",
      },
    }, {
      input: {
        idempotencyKey: "fixture-reconcile-0001",
        targetLevel: "ad",
        campaignName: "fixture campaign",
        adSetName: "fixture ad set",
        creativeName: "fixture creative",
        adName: "fixture ad",
        objective: "OUTCOME_TRAFFIC",
        optimizationGoal: "LINK_CLICKS",
        billingEvent: "IMPRESSIONS",
        destinationType: "WEBSITE",
        dailyBudgetMinorUnits: 500,
        countries: ["US"],
        destinationUrl: "https://example.com/product",
        primaryText: "fixture primary text",
        headline: "fixture headline",
        description: "",
        callToAction: "LEARN_MORE",
        imageHash: null,
      },
      existing: {
        campaignId: "120000000000101",
        adSetId: "120000000000102",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "retryable",
      campaignId: "120000000000101",
      adSetId: "120000000000102",
      message: expect.stringContaining("Creative 不存在"),
    });
    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(3);
  });
});
