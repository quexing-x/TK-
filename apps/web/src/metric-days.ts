import type { DailyMetricRecord } from "@tk-auto/core";

export interface DailyMetricSummary {
  spend: number;
  clicks: number;
  conversions: number;
  /** 区间总消耗 ÷ 区间总点击。不是各日 CPC 的平均——那会让小额日和大额日等权。 */
  cpc: number | null;
  cpa: number | null;
  /** 数据不完整的自然日（同步中断，当日快照停在中途）。 */
  incompleteDates: string[];
}

/**
 * 跨账户按自然日合并。
 *
 * 旧实现把各账户的同步批次按时间戳排在同一条轴上，于是 664 个广告组的大账户和 45 个的
 * 小账户交替出现，图上看着像消耗在剧烈波动——实际只是账户体量不同。按自然日对齐后，
 * 同一天各账户的值相加，才是当天全账户的消耗。
 */
export function mergeDailyMetricsAcrossAccounts(
  lists: readonly DailyMetricRecord[][],
): DailyMetricRecord[] {
  const byDate = new Map<string, DailyMetricRecord>();
  for (const list of lists) {
    for (const day of list) {
      const current = byDate.get(day.date);
      if (!current) {
        byDate.set(day.date, { ...day });
        continue;
      }
      byDate.set(day.date, {
        date: day.date,
        count: current.count + day.count,
        spend: current.spend + day.spend,
        clicks: current.clicks + day.clicks,
        conversions: current.conversions + day.conversions,
        // 合并后取最早的截止时刻：任一账户当天断供，这一天的合计就是不完整的。
        lastCapturedAt: day.lastCapturedAt < current.lastCapturedAt
          ? day.lastCapturedAt
          : current.lastCapturedAt,
        lastLocalTime: day.lastLocalTime < current.lastLocalTime
          ? day.lastLocalTime
          : current.lastLocalTime,
        isCurrentDay: current.isCurrentDay || day.isCurrentDay,
      });
    }
  }
  return [...byDate.values()].sort((left, right) => right.date.localeCompare(left.date));
}

/** 当天最后一个快照早于本地 23:00，说明同步在当天中途就停了，该日数值偏低。 */
export const DAILY_COVERAGE_COMPLETE_AFTER = "23:00";

export function isDailyMetricIncomplete(day: DailyMetricRecord): boolean {
  return !day.isCurrentDay && day.lastLocalTime < DAILY_COVERAGE_COMPLETE_AFTER;
}

export function describeDailyCoverage(day: DailyMetricRecord): string | null {
  if (day.isCurrentDay) return "今天，仍在累积";
  if (isDailyMetricIncomplete(day)) {
    return `该日同步截止至 ${day.lastLocalTime}，数值可能偏低`;
  }
  return null;
}

export function summarizeDailyMetrics(
  days: readonly DailyMetricRecord[],
): DailyMetricSummary {
  const spend = days.reduce((total, day) => total + day.spend, 0);
  const clicks = days.reduce((total, day) => total + day.clicks, 0);
  const conversions = days.reduce((total, day) => total + day.conversions, 0);
  return {
    spend,
    clicks,
    conversions,
    cpc: clicks > 0 ? spend / clicks : null,
    cpa: conversions > 0 ? spend / conversions : null,
    incompleteDates: days.filter(isDailyMetricIncomplete).map((day) => day.date),
  };
}
