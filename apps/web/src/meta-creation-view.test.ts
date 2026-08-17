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
      button: "创建广告系列 + 广告组",
      description: "只创建广告系列与广告组；两层固定为已暂停，不创建素材或广告",
      label: "两层",
      success: "Meta 广告系列与广告组已全部以已暂停状态创建",
    });
  });

  it("keeps the full four-level creation option explicit", () => {
    expect(metaCreationTargetCopy("ad")).toEqual({
      button: "创建四层已暂停广告",
      description: "创建广告系列、广告组、素材与广告；四层固定为已暂停，不会开始投放",
      label: "四层",
      success: "Meta 广告系列、广告组、素材与广告已全部以已暂停状态创建",
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
