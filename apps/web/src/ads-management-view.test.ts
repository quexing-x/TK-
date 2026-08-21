import { describe, expect, it } from "vitest";
import type { EntityRangeMetricRecord, ManagedEntityRecord } from "@tk-auto/core";
import {
  ADS_MANAGEMENT_DEFAULT_CREATED_WINDOW,
  ADS_MANAGEMENT_DEFAULT_LEVEL,
  ADS_MANAGEMENT_DEFAULT_STATUS,
  ADS_MANAGEMENT_PAGE_SIZE,
  ADS_MANAGEMENT_DEFAULT_SPEND_RANGE,
  ADS_MANAGEMENT_RECENT_WINDOW_HOURS,
  adsManagementParticipation,
  adsManagementSpendRangeDays,
  adsManagementSpendRangeLabel,
  applyEntityRangeMetrics,
  adsManagementParticipationLabel,
  filterAdsManagementEntities,
  paginateAdsManagementItems,
  sumAdsManagementConversions,
} from "./ads-management-view";

const entity = (
  externalId: string,
  status: ManagedEntityRecord["status"],
  syncedAt: string,
  spend: number | null = null,
  createdAt = syncedAt,
): ManagedEntityRecord => ({
  entityType: "ad-group",
  externalId,
  name: externalId,
  status,
  createdAt,
  parentCampaignId: null,
  parentAdGroupId: null,
  campaignBudget: null,
  campaignBudgetOptimized: false,
  metrics: {
    spend,
    cost_per_click: null,
    cost_per_conversion: null,
    cost_per_cart: null,
    conversions: null,
    carts: null,
    budget: null,
    clicks: null,
    impressions: null,
  },
  ignored: false,
  automationManaged: false,
  syncedAt,
});

describe("ads management view", () => {
  it("defaults to enabled ad groups", () => {
    expect(ADS_MANAGEMENT_DEFAULT_LEVEL).toBe("ad-group");
    expect(ADS_MANAGEMENT_DEFAULT_STATUS).toBe("enabled");
    expect(ADS_MANAGEMENT_PAGE_SIZE).toBe(15);
  });

  it("sums conversion metrics without counting missing values", () => {
    expect(sumAdsManagementConversions([
      {
        ...entity("one", "enabled", "2026-07-21T11:00:00.000Z"),
        metrics: { ...entity("one", "enabled", "2026-07-21T11:00:00.000Z").metrics, conversions: 2 },
      },
      {
        ...entity("two", "enabled", "2026-07-21T11:00:00.000Z"),
        metrics: { ...entity("two", "enabled", "2026-07-21T11:00:00.000Z").metrics, conversions: 1.5 },
      },
      entity("missing", "enabled", "2026-07-21T11:00:00.000Z"),
    ])).toBe(3.5);
  });

  it("keeps older live entities visible instead of treating 48 hours as their lifetime", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const result = filterAdsManagementEntities([
      entity("enabled", "enabled", "2026-07-21T11:00:00.000Z"),
      entity("disabled", "disabled", "2026-07-21T11:00:00.000Z", null, "2026-07-20T11:00:00.000Z"),
      entity("expired", "disabled", "2026-07-21T11:00:00.000Z", null, "2026-07-19T11:59:59.000Z"),
    ], { level: "ad-group", status: "all", query: "", now, createdWindow: "all" });

    expect(result.map((item) => item.externalId)).toEqual(["enabled", "disabled", "expired"]);
  });

  it("defaults to the rule window and drops ad groups created outside it", () => {
    expect(ADS_MANAGEMENT_DEFAULT_CREATED_WINDOW).toBe("recent");
    expect(ADS_MANAGEMENT_RECENT_WINDOW_HOURS).toBe(48);

    const now = new Date("2026-07-21T12:00:00.000Z");
    const result = filterAdsManagementEntities([
      entity("fresh", "disabled", "2026-07-21T11:00:00.000Z", null, "2026-07-20T11:00:00.000Z"),
      entity("expired", "disabled", "2026-07-21T11:00:00.000Z", null, "2026-07-19T11:59:59.000Z"),
    ], { level: "ad-group", status: "all", query: "", now, createdWindow: "recent" });

    expect(result.map((item) => item.externalId)).toEqual(["fresh"]);
  });

  it("keeps an out-of-window ad group that still spent today, matching the rule engine", () => {
    // 引擎的存活判据之一：当天有消耗的老组不能掉出评估集，否则关停后再也开不回来。
    // 列表必须跟着留，不然界面上看不到自动化正在管的对象。
    const now = new Date("2026-07-21T12:00:00.000Z");
    const result = filterAdsManagementEntities([
      entity("old-but-spending", "disabled", "2026-07-21T11:00:00.000Z", 12.5, "2026-07-01T00:00:00.000Z"),
      entity("old-and-idle", "disabled", "2026-07-21T11:00:00.000Z", 0, "2026-07-01T00:00:00.000Z"),
    ], { level: "ad-group", status: "all", query: "", now, createdWindow: "recent" });

    expect(result.map((item) => item.externalId)).toEqual(["old-but-spending"]);
  });

  it("ignores syncedAt when applying the created window", () => {
    // 回归：原实现按 syncedAt 卡 48 小时，而 syncedAt 每轮轮询都会刷新成当前时间，
    // 条件恒为真，等于没过滤。创建时间早于窗口的对象必须被滤掉，哪怕刚同步过。
    const now = new Date("2026-07-21T12:00:00.000Z");
    const result = filterAdsManagementEntities([
      entity("just-synced-old-group", "enabled", now.toISOString(), null, "2026-06-01T00:00:00.000Z"),
    ], { level: "ad-group", status: "all", query: "", now, createdWindow: "recent" });

    expect(result).toEqual([]);
  });

  it("lets ads follow their parent ad group through the window", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const adGroup = entity("group", "enabled", "2026-07-21T11:00:00.000Z", null, "2026-07-20T11:00:00.000Z");
    // 广告自身没有创建时间时跟随所属广告组；素材层同理。
    const ad: ManagedEntityRecord = {
      ...entity("ad", "enabled", "2026-07-21T11:00:00.000Z", null, "2026-07-20T11:00:00.000Z"),
      entityType: "ad",
      createdAt: null,
      parentAdGroupId: "group",
    };
    const orphanAd: ManagedEntityRecord = { ...ad, externalId: "orphan", parentAdGroupId: "missing" };

    const result = filterAdsManagementEntities([adGroup, ad, orphanAd], {
      level: "all", status: "all", query: "", now, createdWindow: "recent",
    });

    expect(result.map((item) => item.externalId)).toEqual(["group", "ad"]);
  });

  it("reports participation from the same judgement the rule engine uses", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const fresh = entity("fresh", "enabled", "2026-07-21T11:00:00.000Z", null, "2026-07-20T11:00:00.000Z");
    const old = entity("old", "disabled", "2026-07-21T11:00:00.000Z", null, "2026-07-01T00:00:00.000Z");

    expect(adsManagementParticipation(fresh, { now })).toBe("participating");
    // 硬编码成 ignored ? 人工接管 : 参与 的年代，这一行也显示「参与」，但引擎够不着它。
    expect(adsManagementParticipation(old, { now })).toBe("outside-window");
    expect(adsManagementParticipation({ ...old, ignored: true }, { now })).toBe("manual-takeover");
    // 超窗但当天有消耗：引擎仍会评估，界面不能说它不参与。
    expect(adsManagementParticipation(
      { ...old, metrics: { ...old.metrics, spend: 3 } },
      { now },
    )).toBe("participating");
  });

  it("treats an automation-paused ad group as participating even outside the window", () => {
    // 持久管辖集：自动化自己关停、尚未开回的组。当天零消耗、建得早，但引擎靠更长的
    // 归因窗口仍在评估它——只按创建窗口判断会把它错标成「窗口外」。
    const now = new Date("2026-07-21T12:00:00.000Z");
    const managed = {
      ...entity("auto-paused", "disabled", "2026-07-21T11:00:00.000Z", 0, "2026-07-01T00:00:00.000Z"),
      automationManaged: true,
    };

    expect(adsManagementParticipation(managed, { now })).toBe("participating");
    expect(adsManagementParticipationLabel(adsManagementParticipation(managed, { now }))).toBe("参与");
  });

  it("keeps automation-managed ad groups in the default view, matching the 自动化 column", () => {
    // 过滤一度只看创建窗口、标签却认管辖集：自动化关停等着开回来的老组被标成「参与」，
    // 却在默认视图里看不见（实测 75 个）。两边必须用同一个判据。
    const now = new Date("2026-07-21T12:00:00.000Z");
    const managed = {
      ...entity("auto-paused", "disabled", "2026-07-21T11:00:00.000Z", 0, "2026-07-01T00:00:00.000Z"),
      automationManaged: true,
    };
    const idle = entity("old-and-idle", "disabled", "2026-07-21T11:00:00.000Z", 0, "2026-07-01T00:00:00.000Z");

    const result = filterAdsManagementEntities([managed, idle], {
      level: "ad-group", status: "all", query: "", now, createdWindow: "recent",
    });

    expect(result.map((item) => item.externalId)).toEqual(["auto-paused"]);
    expect(adsManagementParticipation(managed, { now })).toBe("participating");
  });

  it("keeps manual-takeover entities visible even when they fall outside the window", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const takenOver = {
      ...entity("taken-over", "disabled", "2026-07-21T11:00:00.000Z", 0, "2026-07-01T00:00:00.000Z"),
      ignored: true,
    };

    const result = filterAdsManagementEntities([takenOver], {
      level: "ad-group", status: "all", query: "", now, createdWindow: "recent",
    });

    expect(result.map((item) => item.externalId)).toEqual(["taken-over"]);
  });

  it("orders matching entities by spend from highest to lowest", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const result = filterAdsManagementEntities([
      entity("zero", "enabled", "2026-07-21T11:00:00.000Z", null),
      entity("medium", "enabled", "2026-07-21T11:00:00.000Z", 12.5),
      entity("high", "enabled", "2026-07-21T11:00:00.000Z", 99),
      entity("same-medium", "enabled", "2026-07-21T11:00:00.000Z", 12.5),
    ], { level: "ad-group", status: "enabled", query: "", now });

    expect(result.map((item) => item.externalId)).toEqual([
      "high",
      "medium",
      "same-medium",
      "zero",
    ]);
  });

  it("paginates sorted results in groups of 15", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const sorted = filterAdsManagementEntities(
      Array.from({ length: 16 }, (_, index) => (
        entity(`group-${index + 1}`, "enabled", "2026-07-21T11:00:00.000Z", index + 1)
      )),
      { level: "ad-group", status: "enabled", query: "", now },
    );

    expect(paginateAdsManagementItems(sorted, 0)).toMatchObject({
      currentPage: 0,
      pageCount: 2,
      items: sorted.slice(0, 15),
    });
    expect(paginateAdsManagementItems(sorted, 1)).toMatchObject({
      currentPage: 1,
      pageCount: 2,
      items: [sorted[15]],
    });
    expect(paginateAdsManagementItems(sorted.slice(0, 15), 1)).toMatchObject({
      currentPage: 0,
      pageCount: 1,
      items: sorted.slice(0, 15),
    });
  });
});

describe("消耗区间", () => {
  const range = (
    externalId: string,
    spend: number,
    extra: Partial<EntityRangeMetricRecord> = {},
  ): EntityRangeMetricRecord => ({
    entityType: "ad-group",
    externalId,
    spend,
    clicks: 0,
    conversions: 0,
    carts: 0,
    days: 1,
    ...extra,
  });

  it("用区间合计覆盖展示指标，并由合计现算 CPC/CPA", () => {
    const [applied] = applyEntityRangeMetrics(
      [entity("g1", "enabled", "2026-07-21T11:00:00.000Z", 5)],
      [range("g1", 120, { clicks: 400, conversions: 8, carts: 30 })],
    );

    expect(applied?.metrics.spend).toBe(120);
    // 比率必须由区间合计现算，不能沿用快照里的当日值或把各日比率相加。
    expect(applied?.metrics.cost_per_click).toBeCloseTo(0.3);
    expect(applied?.metrics.cost_per_conversion).toBe(15);
    expect(applied?.metrics.cost_per_cart).toBe(4);
  });

  it("区间内没有健康快照的对象计为 0，而不是留着当天的数", () => {
    const [applied] = applyEntityRangeMetrics(
      [entity("missing", "enabled", "2026-07-21T11:00:00.000Z", 9)],
      [],
    );

    expect(applied?.metrics.spend).toBe(0);
    expect(applied?.metrics.cost_per_click).toBeNull();
  });

  it("区间口径不参与可见性判定：规则引擎判的是当天数据", () => {
    // 一个今天零消耗的超窗老组，七天里花过钱。如果拿区间指标去过窗口，它会假装「参与」。
    const now = new Date("2026-07-21T12:00:00.000Z");
    const old = entity("old", "disabled", "2026-07-21T11:00:00.000Z", 0, "2026-07-01T00:00:00.000Z");
    const withRange = applyEntityRangeMetrics([old], [range("old", 88)])[0]!;

    expect(adsManagementParticipation(old, { now })).toBe("outside-window");
    // 展示指标变了，但判定必须仍按原始（当天）对象来做——调用方负责传原始对象。
    expect(withRange.metrics.spend).toBe(88);
    expect(adsManagementParticipation(old, { now })).toBe("outside-window");
  });

  it("区间天数换算与文案", () => {
    expect(ADS_MANAGEMENT_DEFAULT_SPEND_RANGE).toBe("today");
    expect(adsManagementSpendRangeDays("today")).toBe(1);
    expect(adsManagementSpendRangeDays("7d")).toBe(7);
    expect(adsManagementSpendRangeLabel("today")).toContain("今天");
    expect(adsManagementSpendRangeLabel("30d")).toBe("最近 30 天");
  });
});
