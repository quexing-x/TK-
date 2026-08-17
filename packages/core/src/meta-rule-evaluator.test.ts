import { describe, expect, it } from "vitest";
import type { ProviderEntity } from "./connection.js";
import { evaluateMetaRuleConfiguration } from "./meta-rule-evaluator.js";
import {
  MetaRuleConfigurationSchema,
  defaultMetaRuleConfiguration,
} from "./meta-rules.js";

function entity(
  entityType: ProviderEntity["entityType"],
  externalId: string,
  status: "ENABLE" | "DISABLE",
): ProviderEntity {
  return {
    entityType,
    externalId,
    payload: {
      name: externalId,
      operation_status: status,
      spend: 3,
      conversions: 0,
      clicks: 2,
      impressions: 100,
      cpc: 1.5,
      carts: 0,
    },
  };
}

describe("Meta rule evaluator", () => {
  it("evaluates only enabled Meta layers and never material", () => {
    const input = structuredClone(defaultMetaRuleConfiguration);
    input.layers = { campaign: true, adGroup: true, ad: true };
    input.rules.find((rule) => rule.code === "NO_CONV_SPEND_CLOSE")!.enabled =
      true;
    const configuration = MetaRuleConfigurationSchema.parse({
      ...input,
      updatedAt: new Date().toISOString(),
    });

    const result = evaluateMetaRuleConfiguration(
      [
        entity("campaign", "campaign-1", "ENABLE"),
        entity("ad-group", "adset-1", "ENABLE"),
        entity("ad", "ad-1", "ENABLE"),
        entity("material", "material-1", "ENABLE"),
      ],
      configuration,
    );

    expect(result.candidates.map((item) => item.entity.entityType)).toEqual([
      "campaign",
      "ad-group",
      "ad",
    ]);
  });

  it("fails closed when required metrics are missing", () => {
    const input = structuredClone(defaultMetaRuleConfiguration);
    input.layers.ad = true;
    input.rules.find((rule) => rule.code === "NO_CONV_SPEND_CLOSE")!.enabled =
      true;
    const configuration = MetaRuleConfigurationSchema.parse({
      ...input,
      updatedAt: new Date().toISOString(),
    });
    const row = entity("ad", "ad-1", "ENABLE");
    delete row.payload.spend;

    expect(
      evaluateMetaRuleConfiguration([row], configuration).candidates,
    ).toHaveLength(0);
  });
});
