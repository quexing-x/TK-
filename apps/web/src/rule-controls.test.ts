import { describe, expect, it } from "vitest";
import {
  adjustRuleValue,
  formatRuleValue,
  getRuleSliderMaximum,
  resolveRuleSliderMaximum,
} from "./rule-controls";

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

  describe("被别的规则约束出来的硬上限", () => {
    it("没有约束时用原本的量程", () => {
      expect(resolveRuleSliderMaximum(null, 18)).toBe(18);
    });

    // 这条是重点：量程默认铺到 18，硬上限 9 必须把它压下去。改成和量程取大就等于
    // 没封顶，滑块又能拉到 18，回到「保存时才报错」的老毛病。
    it("有约束时压过原本的量程，而不是取大", () => {
      expect(resolveRuleSliderMaximum(9, 18)).toBe(9);
    });

    it("存量配置里超限的值也照样封顶，只能往下调", () => {
      // 已存下 12、上限 9：量程按 9 铺，上调键因 value >= maximum 而禁用。
      expect(resolveRuleSliderMaximum(9, getRuleSliderMaximum("cpa", 12))).toBe(9);
      expect(adjustRuleValue(12, 0.1, 1, 0, 9)).toBe(9);
      expect(adjustRuleValue(12, 0.1, -1, 0, 9)).toBe(9);
    });

    it("上限为 0 时滑块就锁死在 0", () => {
      expect(resolveRuleSliderMaximum(0, 18)).toBe(0);
    });
  });
});
