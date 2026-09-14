export type AnalysisPreset = "today" | "yesterday" | "3d" | "7d" | "30d" | "custom";

/**
 * 分析页的默认时间范围。取「今天」——业务上打开分析页问的就是今天跑到什么程度；
 * 七天只作为需要回看时才切过去的选项。
 */
export const DEFAULT_ANALYSIS_PRESET: AnalysisPreset = "today";

export interface AnalysisRange {
  from: string;
  to: string;
}

export function resolveAnalysisRange(
  preset: AnalysisPreset,
  customFrom: string,
  customTo: string,
  now = new Date(),
): AnalysisRange {
  if (preset === "custom") {
    if (!customFrom || !customTo) throw new Error("请选择自定义开始和结束日期。");
    const from = startOfLocalDay(new Date(`${customFrom}T00:00:00`));
    const to = endOfLocalDay(new Date(`${customTo}T00:00:00`));
    if (from > to) throw new Error("开始日期不能晚于结束日期。");
    if (to.getTime() - from.getTime() > 90 * 24 * 60 * 60_000) {
      throw new Error("自定义分析范围最多为 90 天。");
    }
    return { from: from.toISOString(), to: to.toISOString() };
  }

  if (preset === "yesterday") {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return {
      from: startOfLocalDay(yesterday).toISOString(),
      to: endOfLocalDay(yesterday).toISOString(),
    };
  }

  const days = preset === "today" ? 1 : Number.parseInt(preset, 10);
  const from = startOfLocalDay(now);
  from.setDate(from.getDate() - (days - 1));
  return { from: from.toISOString(), to: now.toISOString() };
}

function startOfLocalDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfLocalDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

/**
 * 把「现在」对齐到秒。
 *
 * 分析区间里的 `to` 传的是当前时刻。带上毫秒后，每次渲染都会算出一个新的区间字符串，
 * 依赖它的请求副作用就会被反复触发——页面因此一直在加载。而秒级精度对本地 SQLite
 * 的快照查询毫无差别：快照密度远达不到每秒一条。端点、账户、层级、筛选都不变时，
 * 同一秒内的区间就是同一个 key。
 */
export function toSecondPrecision(date: Date): string {
  const rounded = new Date(date);
  rounded.setMilliseconds(0);
  return rounded.toISOString();
}
