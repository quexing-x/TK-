import { describe, expect, it } from "vitest";
import { formatCampaigns, type ExpandClassification, type ExpandClassificationResponse } from "./format.js";

function campaign(
  name: string,
  reason: string,
  spend: number,
  overrides: Partial<ExpandClassification> = {},
): ExpandClassification {
  return {
    externalId: `id-${name}`,
    name,
    verdict: "excluded",
    reason,
    spend,
    conversions: 0,
    costPerConversion: null,
    days: 7,
    hasActiveAdGroups: false,
    consecutiveZeroConversionDays: 0,
    recreatedToday: false,
    ...overrides,
  };
}

function response(overrides: Partial<ExpandClassificationResponse> = {}): ExpandClassificationResponse {
  return {
    computedAt: "2026-09-07T00:00:00.000Z",
    thresholds: {
      maxCostPerConversion: 12,
      maxSpendWithoutConversion: 3,
      maxConsecutiveZeroConversionDays: 3,
    },
    expand: [],
    recreateCampaign: [],
    excluded: [],
    ...overrides,
  };
}

describe("已关停系列明细", () => {
  // 这是整块改动的理由：一个品的历史系列绝大多数是已关停的，只报个条数等于把
  // 「这个品现在还在不在跑」的唯一证据扣在本地不给 agent。
  it("verdict=stopped 列出已关停系列的明细", () => {
    const text = formatCampaigns(
      response({ excluded: [campaign("透氣彈力休閒褲", "not-enabled", 31.72)] }),
      "stopped",
    );
    expect(text).toContain("透氣彈力休閒褲");
    expect(text).toContain("31.72");
  });

  // 已关停和诊断系列都落在 excluded 桶里，但完全是两回事：诊断/占位系列不是投放对象，
  // 混进名单会被当成正经品去重扩。
  it("诊断系列不混进已关停明细", () => {
    const text = formatCampaigns(
      response({
        excluded: [
          campaign("诊断0823E-选25到34", "non-operational", 999),
          campaign("透氣彈力休閒褲", "not-enabled", 31.72),
        ],
      }),
      "stopped",
    );
    expect(text).toContain("透氣彈力休閒褲");
    expect(text).not.toContain("诊断0823E");
    expect(text).toContain("已关停（1）");
  });

  it("按累计花费降序，花过钱的排前面", () => {
    const text = formatCampaigns(
      response({
        excluded: [
          campaign("建了没投的", "not-enabled", 0),
          campaign("跑过一阵的", "not-enabled", 80.5),
        ],
      }),
      "stopped",
    );
    expect(text.indexOf("跑过一阵的")).toBeLessThan(text.indexOf("建了没投的"));
  });

  // 生产账户实测已关停 493 条，全量吐出会把上下文淹掉。截断必须说清楚截掉了什么，
  // 否则 agent 会把「前 60 条」当成「全部」。
  it("超过上限时截断并说明剩余条数与花费上界", () => {
    const many = Array.from({ length: 75 }, (_, index) =>
      campaign(`品-${index}`, "not-enabled", 100 - index));
    const text = formatCampaigns(response({ excluded: many }), "stopped");
    expect(text).toContain("已关停（75）");
    expect(text).toContain("另有 15 条");
    expect(text).toContain("品-0");
    expect(text).not.toContain("品-74");
  });

  // 默认调用不该被几百条已关停系列淹掉——要明细得显式要。
  it("verdict=all 只报条数并指路，不吐明细", () => {
    const text = formatCampaigns(
      response({
        excluded: [
          campaign("透氣彈力休閒褲", "not-enabled", 31.72),
          campaign("诊断0823E-选25到34", "non-operational", 0),
        ],
      }),
      "all",
    );
    expect(text).toContain("已关停（1）");
    expect(text).toContain('verdict="stopped"');
    expect(text).toContain("另有 1 条诊断/占位系列");
    expect(text).not.toContain("透氣彈力休閒褲");
  });

  it("expand / recreate 两栏行为不受影响", () => {
    const data = response({
      expand: [campaign("可扩的", "cost-per-conversion-ok", 82.57, { verdict: "expand" })],
      recreateCampaign: [
        campaign("要重扩的", "no-conversion-stalled", 1.12, { verdict: "recreate-campaign" }),
      ],
      excluded: [campaign("已关停的", "not-enabled", 50)],
    });
    const expandOnly = formatCampaigns(data, "expand");
    expect(expandOnly).toContain("可扩的");
    expect(expandOnly).not.toContain("要重扩的");
    expect(expandOnly).not.toContain("已关停的");

    const recreateOnly = formatCampaigns(data, "recreate");
    expect(recreateOnly).toContain("要重扩的");
    expect(recreateOnly).not.toContain("可扩的");
    expect(recreateOnly).not.toContain("已关停的");
  });
});
