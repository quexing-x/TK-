import { describe, expect, it } from "vitest";
import {
  RuleConfigurationInputSchema,
  automationRuleDefinitions,
  defaultRuleConfiguration,
} from "./rules.js";

describe("global rule configuration", () => {
  it("locks the configuration to nine unique rules", () => {
    const parsed = RuleConfigurationInputSchema.parse(defaultRuleConfiguration);

    expect(parsed.rules).toHaveLength(9);
    expect(new Set(parsed.rules.map((rule) => rule.code)).size).toBe(9);
    expect(automationRuleDefinitions).toHaveLength(9);
  });

  it("applies the shared rules to ad groups, ads and materials by default", () => {
    expect(defaultRuleConfiguration.layers).toEqual({
      campaign: false,
      adGroup: true,
      ad: true,
      // 素材层默认开：广告层的关停已改为只作用于素材，默认关掉会让这些规则
      // 彻底没有落点。
      material: true,
    });
  });

  // 存量配置里没有 material 键，解析时必须补上默认值而不是直接报错。
  it("补齐存量配置里缺失的素材层开关", () => {
    const parsed = RuleConfigurationInputSchema.parse({
      layers: { campaign: false, adGroup: true, ad: true },
      rules: defaultRuleConfiguration.rules,
    });

    expect(parsed.layers.material).toBe(true);
  });

  it("rejects extra editable parameters", () => {
    const invalid = structuredClone(defaultRuleConfiguration);
    invalid.rules[0]!.values.unknown = 1;

    expect(() => RuleConfigurationInputSchema.parse(invalid)).toThrow(
      "不支持参数 unknown",
    );
  });
});
