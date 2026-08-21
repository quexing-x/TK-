import { describe, expect, it } from "vitest";
import type { DailyMetricRecord } from "@tk-auto/core";
import {
  describeDailyCoverage,
  isDailyMetricIncomplete,
  mergeDailyMetricsAcrossAccounts,
  summarizeDailyMetrics,
} from "./metric-days";

const day = (
  date: string,
  spend: number,
  overrides: Partial<DailyMetricRecord> = {},
): DailyMetricRecord => ({
  date,
  count: 1,
  spend,
  clicks: 0,
  conversions: 0,
  lastCapturedAt: `${date}T15:59:00.000Z`,
  lastLocalTime: "23:59",
  isCurrentDay: false,
  ...overrides,
});

describe("按日指标", () => {
  it("跨账户按自然日相加，而不是把各账户的批次并排", () => {
    // 旧实现按 captured_at 对齐，而每个批次只属于一个账户，于是 664 个广告组的大账户
    // 和 45 个的小账户交替成柱，看着像消耗剧烈波动。
    const merged = mergeDailyMetricsAcrossAccounts([
      [day("2026-08-20", 153.5), day("2026-08-19", 20)],
      [day("2026-08-20", 20.7)],
    ]);

    expect(merged.map((item) => [item.date, Number(item.spend.toFixed(2))])).toEqual([
      ["2026-08-20", 174.2],
      ["2026-08-19", 20],
    ]);
  });

  it("区间合计是各日之和，而不是首尾累计值相减", () => {
    // 旧公式 latest - earliest 建立在"同一账户、同一天、累计不归零"三个前提上，
    // 七天窗口里三个前提都不成立，算出来的数和任何真实口径都对不上。
    const summary = summarizeDailyMetrics([
      day("2026-08-20", 100, { clicks: 400, conversions: 10 }),
      day("2026-08-19", 50, { clicks: 100, conversions: 0 }),
    ]);

    expect(summary.spend).toBe(150);
    expect(summary.clicks).toBe(500);
    expect(summary.cpc).toBeCloseTo(0.3);
    expect(summary.cpa).toBe(15);
  });

  it("没有点击或转化时不产出 0 分母的比率", () => {
    const summary = summarizeDailyMetrics([day("2026-08-20", 12)]);
    expect(summary.cpc).toBeNull();
    expect(summary.cpa).toBeNull();
  });

  it("同步中断的日子标为不完整，当天则标为仍在累积", () => {
    const broken = day("2026-08-19", 4.6, { lastLocalTime: "08:06" });
    const complete = day("2026-08-18", 88);
    const today = day("2026-08-21", 19.1, { lastLocalTime: "15:17", isCurrentDay: true });

    expect(isDailyMetricIncomplete(broken)).toBe(true);
    expect(isDailyMetricIncomplete(complete)).toBe(false);
    // 当天本来就没结束，不该被当成"同步中断"。
    expect(isDailyMetricIncomplete(today)).toBe(false);

    expect(describeDailyCoverage(broken)).toContain("08:06");
    expect(describeDailyCoverage(complete)).toBeNull();
    expect(describeDailyCoverage(today)).toContain("仍在累积");

    expect(summarizeDailyMetrics([broken, complete, today]).incompleteDates)
      .toEqual(["2026-08-19"]);
  });

  it("合并后按最早的截止时刻判定完整性：任一账户当天断供，这一天就不完整", () => {
    const merged = mergeDailyMetricsAcrossAccounts([
      [day("2026-08-19", 100)],
      [day("2026-08-19", 4.6, { lastLocalTime: "08:06" })],
    ]);

    expect(merged[0]?.lastLocalTime).toBe("08:06");
    expect(isDailyMetricIncomplete(merged[0]!)).toBe(true);
  });
});
