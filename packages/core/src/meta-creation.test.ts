import { describe, expect, it } from "vitest";
import { MetaAdCreationInputSchema } from "./meta-creation.js";

const validInput = {
  idempotencyKey: "meta-create-0001",
  campaignName: "Sandbox Campaign",
  adSetName: "Sandbox Ad Set",
  creativeName: "Sandbox Creative",
  adName: "Sandbox Ad",
  objective: "OUTCOME_TRAFFIC" as const,
  optimizationGoal: "LINK_CLICKS" as const,
  billingEvent: "IMPRESSIONS" as const,
  destinationType: "WEBSITE" as const,
  dailyBudgetMinorUnits: 500,
  countries: ["US"],
  destinationUrl: "https://example.com/product",
  primaryText: "Primary text",
  headline: "Headline",
  description: "",
  callToAction: "LEARN_MORE" as const,
  imageHash: null,
};

describe("Meta creation contract", () => {
  it("accepts the first production slice and keeps its scope explicit", () => {
    expect(MetaAdCreationInputSchema.parse(validInput)).toMatchObject({
      targetLevel: "ad",
      objective: "OUTCOME_TRAFFIC",
      destinationType: "WEBSITE",
      dailyBudgetMinorUnits: 500,
      imageHash: null,
    });
  });

  it("supports an explicit Ad Set terminal level while keeping old inputs on Ad", () => {
    const adSetOnlyInput = {
      idempotencyKey: validInput.idempotencyKey,
      targetLevel: "ad-set",
      campaignName: validInput.campaignName,
      adSetName: validInput.adSetName,
      objective: validInput.objective,
      optimizationGoal: validInput.optimizationGoal,
      billingEvent: validInput.billingEvent,
      destinationType: validInput.destinationType,
      dailyBudgetMinorUnits: validInput.dailyBudgetMinorUnits,
      countries: validInput.countries,
    } as const;
    expect(MetaAdCreationInputSchema.parse(adSetOnlyInput)).toEqual(adSetOnlyInput);
    expect(MetaAdCreationInputSchema.parse(validInput).targetLevel).toBe("ad");
    expect(() => MetaAdCreationInputSchema.parse({
      ...adSetOnlyInput,
      targetLevel: "ad",
    })).toThrow();
    expect(() => MetaAdCreationInputSchema.parse({
      ...adSetOnlyInput,
      creativeName: "hidden placeholder",
    })).toThrow();
    expect(() => MetaAdCreationInputSchema.parse({
      ...validInput,
      targetLevel: "creative",
    })).toThrow();
  });

  it("rejects non-HTTPS destinations, unsupported objectives and too-small budgets", () => {
    expect(() => MetaAdCreationInputSchema.parse({
      ...validInput,
      destinationUrl: "http://example.com/product",
    })).toThrow();
    expect(() => MetaAdCreationInputSchema.parse({
      ...validInput,
      objective: "OUTCOME_SALES",
    })).toThrow();
    expect(() => MetaAdCreationInputSchema.parse({
      ...validInput,
      dailyBudgetMinorUnits: 99,
    })).toThrow();
  });
});
