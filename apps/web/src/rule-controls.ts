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

export function formatRuleValue(value: number, step: number): string {
  return step < 1 ? value.toFixed(2) : String(value);
}
