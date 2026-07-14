export type AnalysisPreset = "today" | "yesterday" | "3d" | "7d" | "30d" | "custom";

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
