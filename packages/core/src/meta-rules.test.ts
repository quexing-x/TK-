import { describe, expect, it } from "vitest";
import {
  MetaRuleConfigurationInputSchema,
  defaultMetaAutomationRuntime,
  defaultMetaRuleConfiguration,
  metaAutomationRuleDefinitions,
} from "./meta-rules.js";

describe("Meta rule contract", () => {
  it("starts with an independent fail-closed three-level configuration", () => {
    const parsed = MetaRuleConfigurationInputSchema.parse(
      defaultMetaRuleConfiguration,
    );

    expect(parsed.schemaVersion).toBe("meta-v1");
    expect(parsed.metricWindow).toBe("account-today");
    expect(parsed.layers).toEqual({
      campaign: false,
      adGroup: false,
      ad: false,
    });
    expect(parsed.rules).toHaveLength(9);
    expect(parsed.rules.every((rule) => !rule.enabled)).toBe(true);
    expect("material" in parsed.layers).toBe(false);
    expect(defaultMetaAutomationRuntime.enabled).toBe(false);
  });

  it("rejects duplicate and unsupported Meta rule values", () => {
    const duplicate = structuredClone(defaultMetaRuleConfiguration);
    duplicate.rules[1]!.code = duplicate.rules[0]!.code;
    expect(() => MetaRuleConfigurationInputSchema.parse(duplicate)).toThrow();

    const unknownValue = structuredClone(defaultMetaRuleConfiguration);
    unknownValue.rules[0]!.values.unsupported = 1;
    expect(() => MetaRuleConfigurationInputSchema.parse(unknownValue)).toThrow(
      "不支持参数 unsupported",
    );
  });

  it("owns definitions separately from the TikTok rule contract", () => {
    expect(metaAutomationRuleDefinitions).toHaveLength(9);
    expect(metaAutomationRuleDefinitions.map((rule) => rule.code)).toEqual(
      defaultMetaRuleConfiguration.rules.map((rule) => rule.code),
    );
  });
});
