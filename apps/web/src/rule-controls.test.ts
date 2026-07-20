import { describe, expect, it } from "vitest";
import { adjustRuleValue, formatRuleValue, getRuleSliderMaximum } from "./rule-controls";

describe("rule controls", () => {
  it("steps count values without going below zero", () => {
    expect(adjustRuleValue(1, 1, -1)).toBe(0);
    expect(adjustRuleValue(0, 1, -1)).toBe(0);
    expect(adjustRuleValue(2, 1, 1)).toBe(3);
  });

  it("keeps decimal thresholds precise", () => {
    expect(adjustRuleValue(0.8, 0.01, 1)).toBe(0.81);
    expect(adjustRuleValue(0.8, 0.1, 1)).toBe(0.9);
    expect(formatRuleValue(9, 0.01)).toBe("9.00");
  });

  it("uses the prototype ranges while expanding for larger saved values", () => {
    expect(getRuleSliderMaximum("cpc", 0.8)).toBe(1.6);
    expect(getRuleSliderMaximum("cpa", 12)).toBe(18);
    expect(getRuleSliderMaximum("cpa", 24)).toBe(24);
  });
});
