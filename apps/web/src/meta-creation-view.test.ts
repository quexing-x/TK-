import { describe, expect, it } from "vitest";
import {
  buildMetaCreationInput,
  defaultMetaCreationTargetLevel,
  metaCreationTargetCopy,
  metaCreationTaskTargetLevel,
} from "./meta-creation-view";

const adOnlyFields = {
  creativeName: "Creative",
  adName: "Ad",
  destinationUrl: "https://example.com/product",
  primaryText: "Text",
  headline: "Headline",
  description: "Description",
  callToAction: "LEARN_MORE" as const,
  imageHash: null,
};

const commonFields = {
  idempotencyKey: "request-12345678",
  campaignName: "Campaign",
  adSetName: "Ad Set",
  objective: "OUTCOME_TRAFFIC" as const,
  optimizationGoal: "LINK_CLICKS" as const,
  billingEvent: "IMPRESSIONS" as const,
  destinationType: "WEBSITE" as const,
  dailyBudgetMinorUnits: 500,
  countries: ["US"],
};

describe("Meta creation view", () => {
  it("defaults new creation tasks to Campaign + Ad Set", () => {
    expect(defaultMetaCreationTargetLevel).toBe("ad-set");
    expect(metaCreationTargetCopy(defaultMetaCreationTargetLevel)).toEqual({
      button: "创建 Campaign + Ad Set",
      description: "只创建 Campaign 与 Ad Set；两层固定 PAUSED，不创建 Creative 或 Ad",
      label: "两层",
      success: "Meta Campaign 与 Ad Set 已全部以 PAUSED 创建",
    });
  });

  it("keeps the full four-level creation option explicit", () => {
    expect(metaCreationTargetCopy("ad")).toEqual({
      button: "创建四层 PAUSED 广告",
      description: "创建 Campaign、Ad Set、Creative 与 Ad；四层固定 PAUSED，不会开始投放",
      label: "四层",
      success: "Meta Campaign、Ad Set、Creative、Ad 已全部以 PAUSED 创建",
    });
  });

  it("uses the target level persisted with each task", () => {
    expect(metaCreationTaskTargetLevel({
      input: buildMetaCreationInput("ad-set", commonFields, adOnlyFields),
    })).toBe("ad-set");
    expect(metaCreationTaskTargetLevel({
      input: buildMetaCreationInput("ad", commonFields, adOnlyFields),
    })).toBe("ad");
  });

  it("omits every Creative and Ad field from two-level requests", () => {
    expect(buildMetaCreationInput("ad-set", commonFields, adOnlyFields)).toEqual({
      ...commonFields,
      targetLevel: "ad-set",
    });
    expect(buildMetaCreationInput("ad", commonFields, adOnlyFields)).toEqual({
      ...commonFields,
      ...adOnlyFields,
      targetLevel: "ad",
    });
  });
});
