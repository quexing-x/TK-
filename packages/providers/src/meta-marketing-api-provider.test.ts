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
});
