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

  it("applies the shared rules to ad groups and ads by default", () => {
    expect(defaultRuleConfiguration.layers).toEqual({
      campaign: false,
      adGroup: true,
      ad: true,
    });
  });

  it("rejects extra editable parameters", () => {
    const invalid = structuredClone(defaultRuleConfiguration);
    invalid.rules[0]!.values.unknown = 1;

    expect(() => RuleConfigurationInputSchema.parse(invalid)).toThrow(
      "不支持参数 unknown",
    );
  });
});
