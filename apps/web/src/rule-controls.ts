export function adjustRuleValue(
  value: number,
  step: number,
  direction: -1 | 1,
  minimum = 0,
  maximum = Number.POSITIVE_INFINITY,
): number {
  const precision = step < 1 ? 2 : 0;
  const next = Math.min(maximum, Math.max(minimum, value + step * direction));
  return Number(next.toFixed(precision));
}

export function getRuleSliderMaximum(key: string, value: number): number {
  const referenceMaximum = key === "cpc" ? 1.6 : key === "cpa" ? 18 : key === "spend" ? 6 : 1;
  return Math.max(referenceMaximum, Math.ceil(value * 100) / 100);
}

/**
 * 滑块的量程上限。
 *
 * `ceiling` 是别的规则约束出来的硬上限（core 的 `ruleValueCeiling`），有它就一切以它
 * 为准。**不要和 `headroom` 取大**：headroom 只是「刻度铺到哪」，本身会随当前值往上
 * 棘轮，跟硬上限取大就等于没有封顶——这正是滑块拉得过头、要到保存时才报错的老毛病。
 */
export function resolveRuleSliderMaximum(ceiling: number | null, headroom: number): number {
  return ceiling ?? headroom;
}

export function formatRuleValue(value: number, step: number): string {
  return step < 1 ? value.toFixed(2) : String(value);
}
