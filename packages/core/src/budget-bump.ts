import type { ManagedEntitySnapshot } from "./decision.js";

export interface BudgetBumpSettings {
  minConversions: number;
  maxCpa: number;
  targetBudget: number;
  /** 只处理当前日预算等于这个值的广告组。 */
  sourceBudget: number;
}

/**
 * 预算是货币金额，平台回传时可能带浮点误差（50 回来成 49.999999996）。直接用 ===
 * 比会让整条规则一个都命中不了，而且不报错——看起来就像「规则没生效」。
 */
const BUDGET_EPSILON = 0.005;

export function isSameBudget(left: number, right: number): boolean {
  return Math.abs(left - right) < BUDGET_EPSILON;
}

/**
 * 这个广告组该不该提额。
 *
 * 判据：日预算恰好等于 sourceBudget、转化量 ≥ minConversions、CPA < maxCpa。
 *
 * 「日预算等于 sourceBudget」这条同时就是幂等机制——调完预算不再等于它，下一轮自然
 * 不命中，不需要额外的「已处理」台账。
 *
 * 两类对象一律排除：
 *
 * - **系列预算(CBO)的组**：它们没有自己的日预算，预算在系列上。往组上写预算既无意义，
 *   读到的 budget 也可能是系列的，会误判。
 * - **指标缺失的组**：拿不到转化或 CPA 就不知道它表现如何。提额是花钱的动作，
 *   不确定时一律不动。
 */
export function selectBudgetBumpCandidate(
  entity: ManagedEntitySnapshot & { ignored?: boolean },
  settings: BudgetBumpSettings,
): boolean {
  if (entity.entityType !== "ad-group") return false;
  if (entity.ignored) return false;
  // **关着的组照样提额。**
  //
  // 原先跳过它们，理由是「给关着的组提额没意义」。这个理由站不住：命中这条规则的本来就是
  // 表现最好的那批（转化达标 + CPA 够低），它们关着通常只是被别的规则临时关停，随时会被
  // 「达标恢复」开回来。跳过的实际后果是——它被开回来时仍然带着旧预算，而它恰恰是最该放量的
  // 那个。2026-08-25 实测：唯一命中阈值的对象（转化 6、CPA 3.16）正是这种情况，规则因此
  // 一次都没触发。
  //
  // 预算是「下次投放时用多少」的设定，不是「此刻正在花钱」的状态，对关闭对象设置它完全合法。
  if (entity.campaignBudgetOptimized) return false;

  const budget = entity.metrics.budget;
  const conversions = entity.metrics.conversions;
  const cpa = entity.metrics.cost_per_conversion;
  if (budget === null || conversions === null || cpa === null) return false;
  if (!isSameBudget(budget, settings.sourceBudget)) return false;

  // 目标与当前一致时不写：一次真实写入换不到任何变化。
  if (isSameBudget(settings.sourceBudget, settings.targetBudget)) return false;

  return conversions >= settings.minConversions && cpa < settings.maxCpa;
}
