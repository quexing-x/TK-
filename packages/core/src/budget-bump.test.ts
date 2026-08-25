import { describe, expect, it } from "vitest";
import { selectBudgetBumpCandidate, type BudgetBumpSettings } from "./budget-bump.js";
import type { ManagedEntitySnapshot } from "./decision.js";

const settings: BudgetBumpSettings = {
  minConversions: 3,
  maxCpa: 9,
  targetBudget: 100,
  sourceBudget: 50,
};

function adGroup(overrides: {
  budget?: number | null;
  conversions?: number | null;
  cpa?: number | null;
  status?: string;
  cbo?: boolean;
  ignored?: boolean;
  entityType?: string;
} = {}) {
  return {
    entityType: overrides.entityType ?? "ad-group",
    externalId: "g1",
    name: "g1",
    status: overrides.status ?? "enabled",
    parentCampaignId: "c1",
    parentAdGroupId: null,
    campaignBudgetOptimized: overrides.cbo ?? false,
    ignored: overrides.ignored ?? false,
    metrics: {
      budget: overrides.budget === undefined ? 50 : overrides.budget,
      spend: 20,
      conversions: overrides.conversions === undefined ? 5 : overrides.conversions,
      clicks: 100,
      carts: 3,
      impressions: 1000,
      cost_per_conversion: overrides.cpa === undefined ? 4 : overrides.cpa,
      cost_per_click: 0.2,
    },
  } as unknown as ManagedEntitySnapshot & { ignored?: boolean };
}

describe("跑得好的广告组自动提额", () => {
  it("预算 50、转化达标、CPA 够低时命中", () => {
    expect(selectBudgetBumpCandidate(adGroup(), settings)).toBe(true);
  });

  // 这条限制同时就是幂等机制：调完预算不再等于 50，下一轮自然不命中。
  it("预算不是 50 的一律不动", () => {
    expect(selectBudgetBumpCandidate(adGroup({ budget: 100 }), settings)).toBe(false);
    expect(selectBudgetBumpCandidate(adGroup({ budget: 30 }), settings)).toBe(false);
  });

  // 平台回传金额可能带浮点误差。用 === 比会让整条规则一个都命中不了，而且不报错，
  // 看起来就像「规则没生效」——这是最难查的那类。
  it("预算带浮点误差时仍算 50", () => {
    expect(selectBudgetBumpCandidate(adGroup({ budget: 49.999999996 }), settings)).toBe(true);
    expect(selectBudgetBumpCandidate(adGroup({ budget: 50.000000004 }), settings)).toBe(true);
  });

  it("转化不足或 CPA 超标都不动", () => {
    expect(selectBudgetBumpCandidate(adGroup({ conversions: 2 }), settings)).toBe(false);
    expect(selectBudgetBumpCandidate(adGroup({ cpa: 9 }), settings)).toBe(false);
    expect(selectBudgetBumpCandidate(adGroup({ cpa: 20 }), settings)).toBe(false);
  });

  it("CPA 判据是严格小于", () => {
    expect(selectBudgetBumpCandidate(adGroup({ cpa: 8.99 }), settings)).toBe(true);
    expect(selectBudgetBumpCandidate(adGroup({ cpa: 9 }), settings)).toBe(false);
  });

  // 提额是花钱的动作，拿不到数就不知道它表现如何，不确定时一律不动。
  it("指标缺失一律不动", () => {
    expect(selectBudgetBumpCandidate(adGroup({ conversions: null }), settings)).toBe(false);
    expect(selectBudgetBumpCandidate(adGroup({ cpa: null }), settings)).toBe(false);
    expect(selectBudgetBumpCandidate(adGroup({ budget: null }), settings)).toBe(false);
  });

  // CBO 的组没有自己的日预算，预算在系列上；读到的 budget 可能是系列的，会误判。
  it("系列预算的组一律跳过", () => {
    expect(selectBudgetBumpCandidate(adGroup({ cbo: true }), settings)).toBe(false);
  });

  // 命中这条规则的本来就是表现最好的那批，它们关着通常只是被别的规则临时关停、随时会被
  // 「达标恢复」开回来。跳过的后果是它被开回来时仍带着旧预算，而它恰恰最该放量。
  it("关着的组照样提额", () => {
    expect(selectBudgetBumpCandidate(adGroup({ status: "disabled" }), settings)).toBe(true);
  });

  // 被忽略 = 人工声明「这个对象不参与自动化」，那是另一回事，仍然要跳过。
  it("被忽略的对象仍然不动", () => {
    expect(selectBudgetBumpCandidate(adGroup({ ignored: true }), settings)).toBe(false);
  });

  it("只作用于广告组层", () => {
    expect(selectBudgetBumpCandidate(adGroup({ entityType: "ad" }), settings)).toBe(false);
    expect(selectBudgetBumpCandidate(adGroup({ entityType: "campaign" }), settings)).toBe(false);
  });

  // 目标和当前一样时写了也没变化，白白发一次真实写入。
  it("目标预算与来源预算相同时不写", () => {
    expect(selectBudgetBumpCandidate(adGroup(), { ...settings, targetBudget: 50 })).toBe(false);
  });
});
