import { describe, expect, it } from "vitest";
import {
  CookieConnectionSettingsSchema,
  MetaMarketingApiConnectionSettingsSchema,
  ProviderCredentialInputSchema,
  syncLayerComplete,
  type SyncDataQuality,
} from "./connection.js";

function quality(patch: Partial<SyncDataQuality>): SyncDataQuality {
  return {
    status: "partial",
    paginationComplete: true,
    requiredMetricsComplete: true,
    contractValid: true,
    providerContractVersion: "test-v1",
    coverage: { startDate: "2026-08-05", endDate: "2026-08-05", timezone: "Asia/Shanghai" },
    missingMetrics: [],
    partialFailures: [],
    lastHealthyAt: null,
    ...patch,
  };
}

describe("syncLayerComplete", () => {
  it("treats every layer as usable when the whole sync is healthy", () => {
    const healthy = quality({ status: "healthy" });
    expect(syncLayerComplete(healthy, "ad-group")).toBe(true);
    expect(syncLayerComplete(healthy, "ad")).toBe(true);
  });

  it("trusts only the layers a partial sync actually completed", () => {
    const partial = quality({
      status: "partial",
      partialFailures: ["ad:derived-request-failed"],
      completeEntityTypes: ["campaign", "ad-group"],
    });
    expect(syncLayerComplete(partial, "ad-group")).toBe(true);
    expect(syncLayerComplete(partial, "campaign")).toBe(true);
    expect(syncLayerComplete(partial, "ad")).toBe(false);
  });

  // 契约漂移说明我们对响应结构的理解已经过时，任何一层的解析结果都不可信。
  it("trusts no layer when the provider contract drifted", () => {
    const invalid = quality({
      status: "invalid",
      contractValid: false,
      completeEntityTypes: ["campaign", "ad-group", "ad"],
    });
    expect(syncLayerComplete(invalid, "ad-group")).toBe(false);
  });

  // 升级前写下的 partial 记录没有 completeEntityTypes，必须继续按"整轮不可用"处理，
  // 否则升级瞬间会把一批历史 partial 追认为可删除的依据。
  it("falls back to the old all-or-nothing rule for records written before per-layer tracking", () => {
    const legacy = quality({ status: "partial", partialFailures: ["ad:derived-request-failed"] });
    expect(legacy.completeEntityTypes).toBeUndefined();
    expect(syncLayerComplete(legacy, "ad-group")).toBe(false);
  });

  it("treats a missing sync as not usable", () => {
    expect(syncLayerComplete(undefined, "ad-group")).toBe(false);
    expect(syncLayerComplete(null, "ad-group")).toBe(false);
  });
});

describe("provider connection validation", () => {
  it("accepts TikTok HTTPS URLs", () => {
    expect(
      CookieConnectionSettingsSchema.parse({
        kind: "cookie",
        advertiserId: "123",
        healthUrl: "https://ads.tiktok.com/api/example",
        campaignsUrl: "",
        adGroupsUrl: "",
        adsUrl: "",
      }).advertiserId,
    ).toBe("123");
  });

  it("rejects a non-TikTok endpoint", () => {
    expect(() =>
      CookieConnectionSettingsSchema.parse({
        kind: "cookie",
        advertiserId: "123",
        healthUrl: "https://example.com/collect",
        campaignsUrl: "",
        adGroupsUrl: "",
        adsUrl: "",
      }),
    ).toThrow();
  });

  it("validates both credential shapes", () => {
    expect(
      ProviderCredentialInputSchema.parse({
        kind: "official-api",
        accessToken: "token-with-enough-length",
      }).kind,
    ).toBe("official-api");
  });

  it("validates Meta IDs without accepting endpoints or secrets in settings", () => {
    expect(MetaMarketingApiConnectionSettingsSchema.parse({
      kind: "meta-marketing-api",
      profileId: "11111111-1111-4111-8111-111111111111",
      adAccountId: "act_300000000000003",
      pageId: "400000000000004",
    })).toMatchObject({
      profileId: "11111111-1111-4111-8111-111111111111",
      adAccountId: "act_300000000000003",
    });
    expect(MetaMarketingApiConnectionSettingsSchema.parse({
      kind: "meta-marketing-api",
      profileId: "11111111-1111-4111-8111-111111111111",
      adAccountId: "act_300000000000003",
      pageId: "400000000000004",
      liveMode: "manual-status",
      allowedStatusEntityTypes: ["campaign", "ad-group", "ad"],
    })).toMatchObject({
      liveMode: "manual-status",
      allowedStatusEntityTypes: ["campaign", "ad-group", "ad"],
    });
    expect(MetaMarketingApiConnectionSettingsSchema.parse({
      kind: "meta-marketing-api",
      profileId: "11111111-1111-4111-8111-111111111111",
      adAccountId: "act_300000000000003",
      pageId: "400000000000004",
      liveMode: "automation-status",
      allowedStatusEntityTypes: ["ad"],
    }).liveMode).toBe("automation-status");
    expect(MetaMarketingApiConnectionSettingsSchema.parse({
      kind: "meta-marketing-api",
      profileId: "11111111-1111-4111-8111-111111111111",
      adAccountId: "act_300000000000003",
      pageId: "",
    }).pageId).toBeNull();
    const legacy = MetaMarketingApiConnectionSettingsSchema.parse({
      kind: "meta-marketing-api",
      appId: "100000000000001",
      businessId: "200000000000002",
      adAccountId: "act_300000000000003",
      pageId: "400000000000004",
      graphApiVersion: "v26.0",
    });
    expect(legacy).toEqual({
      kind: "meta-marketing-api",
      adAccountId: "act_300000000000003",
      pageId: "400000000000004",
    });
    expect(legacy).not.toHaveProperty("appId");
    expect(legacy).not.toHaveProperty("businessId");
    expect(legacy).not.toHaveProperty("graphApiVersion");
    expect(() => MetaMarketingApiConnectionSettingsSchema.parse({
      kind: "meta-marketing-api",
      profileId: "invalid profile id",
      adAccountId: "act_3",
      pageId: "4",
    })).toThrow();
    expect(() => MetaMarketingApiConnectionSettingsSchema.parse({
      kind: "meta-marketing-api",
      profileId: "11111111-1111-4111-8111-111111111111",
      adAccountId: "3",
      pageId: "4",
      liveMode: "manual-status",
      allowedStatusEntityTypes: ["ad", "ad"],
    })).toThrow("启停对象层级不能重复");
  });
});
