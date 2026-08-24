import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeProviderEntity } from "@tk-auto/core";
import { CookieAdsProvider } from "./cookie-provider.js";
import type { ProviderContext } from "./types.js";

/**
 * 已删除的广告组 / 广告不进快照。
 *
 * 2026-08-24 生产实况：TikTok 的列表接口会把已删除对象一起返回，状态写作
 * delete，而 normalizeStatus 的兜底分支把它判成了 enabled——166 个已删广告组和
 * 166 个已删广告堆在广告管理列表里显示「已开启」。真正的危险不在界面：
 * enrollNightlyAdGroups 在 23:45 会把所有 enabled 的广告组排队关闭，对已删对象
 * 发写请求必被拒，连续失败会打开写入熔断器、停掉整个账户的自动化。
 */
function context(): ProviderContext {
  return {
    accountId: "test-account",
    timezone: "Asia/Shanghai",
    settings: { kind: "cookie", advertiserId: "654321", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
    credential: {
      kind: "cookie",
      cookie: "sessionid=test-cookie",
      csrfHeaderName: "x-csrftoken",
      requestTemplates: [{
        target: "ad-group",
        url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=654321",
        method: "POST",
        body: "{}",
        contentType: "application/json",
        derived: false,
      }],
    },
  };
}

const stub = (rows: Record<string, unknown>[]) => {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
    new Response(
      JSON.stringify({
        code: 0,
        data: {
          table: String(input).includes("expand/material/list") ? [] : rows,
          pagination: { page: 1, page_count: 1 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("已删除对象", () => {
  it("状态为 delete 的广告组不进快照", async () => {
    stub([
      { campaign_id: "c1", ad_id: "alive", creative_id: "alive-ad", ad_primary_status: "enable", stat_cost: "5" },
      { campaign_id: "c1", ad_id: "gone", creative_id: "gone-ad", ad_primary_status: "delete", stat_cost: "0" },
    ]);

    const output = await new CookieAdsProvider().syncReadOnly(context());

    const groups = output.entities.filter((e) => e.entityType === "ad-group").map((e) => e.externalId);
    expect(groups).toContain("alive");
    expect(groups).not.toContain("gone");
  });

  it("状态为 delete 的广告也不进快照", async () => {
    stub([
      { campaign_id: "c1", ad_id: "g1", creative_id: "alive-ad", creative_primary_status: "enable", stat_cost: "5" },
      { campaign_id: "c1", ad_id: "g1", creative_id: "gone-ad", creative_primary_status: "delete", stat_cost: "0" },
    ]);

    const output = await new CookieAdsProvider().syncReadOnly(context());

    const ads = output.entities.filter((e) => e.entityType === "ad").map((e) => e.externalId);
    expect(ads).toContain("alive-ad");
    expect(ads).not.toContain("gone-ad");
  });

  // 别把正常对象误滤掉——对象凭空消失比多留一行更难查。
  it("正常状态一个都不能少", async () => {
    stub([
      { campaign_id: "c1", ad_id: "g1", creative_id: "a1", ad_primary_status: "enable", stat_cost: "1" },
      { campaign_id: "c1", ad_id: "g2", creative_id: "a2", ad_primary_status: "disable", stat_cost: "1" },
      { campaign_id: "c1", ad_id: "g3", creative_id: "a3", ad_primary_status: "audit_deny", stat_cost: "1" },
      { campaign_id: "c1", ad_id: "g4", creative_id: "a4", ad_primary_status: "delivery_ok", stat_cost: "1" },
    ]);

    const output = await new CookieAdsProvider().syncReadOnly(context());

    const groups = output.entities.filter((e) => e.entityType === "ad-group").map((e) => e.externalId);
    expect(groups.sort()).toEqual(["g1", "g2", "g3", "g4"]);
  });

  // 最后一道网：万一有已删行绕过了 provider 的过滤，规则也不能把它当成开着的。
  // unknown 会让评估器显式跳过并留下原因，而不是静默当成正常对象派发关闭。
  it("normalizeStatus 把 delete 判为 unknown，而不是 enabled", () => {
    const deleted = normalizeProviderEntity({
      entityType: "ad-group",
      externalId: "gone",
      payload: { ad_primary_status: "delete" },
    });
    expect(deleted.status).toBe("unknown");

    const live = normalizeProviderEntity({
      entityType: "ad-group",
      externalId: "alive",
      payload: { ad_primary_status: "enable" },
    });
    expect(live.status).toBe("enabled");
  });
});
