import { describe, expect, it } from "vitest";
import {
  defaultRuleConfiguration,
  evaluateRuleConfiguration,
  filterEntitiesToRecentCampaigns,
  type ProviderEntity,
  type RuleConfiguration,
} from "./index.js";

const now = new Date("2026-07-15T04:00:00.000Z");

function configuration(): RuleConfiguration {
  return {
    ...structuredClone(defaultRuleConfiguration),
    lookbackHours: 48,
    updatedAt: now.toISOString(),
  };
}

function campaign(id: string, createdAt: string): ProviderEntity {
  return {
    entityType: "campaign",
    externalId: id,
    payload: { campaign_id: id, create_time: createdAt, campaign_status: "enable" },
  };
}

function adGroup(campaignId: string): ProviderEntity {
  return {
    entityType: "ad-group",
    externalId: `group-${campaignId}`,
    payload: {
      campaign_id: campaignId,
      adgroup_id: `group-${campaignId}`,
      ad_primary_status: "enable",
      row_data: {
        campaign_id: campaignId,
        time_attr_convert_cnt: 0,
        stat_cost: 3,
        cpc: 0.4,
        time_attr_on_web_cart: 0,
      },
    },
  };
}

describe("48 hour campaign window", () => {
  it("keeps only campaigns created during the previous 48 hours and their children", () => {
    const recent = campaign("recent", "2026-07-14T04:00:00.000Z");
    const old = campaign("old", "2026-07-12T03:59:59.000Z");

    const result = filterEntitiesToRecentCampaigns(
      [recent, adGroup("recent"), old, adGroup("old")],
      now,
    );

    expect(result.entities.map((entity) => entity.externalId)).toEqual([
      "recent",
      "group-recent",
    ]);
    expect(result.excludedCount).toBe(2);
  });

  it("excludes entities when campaign creation time cannot be verified", () => {
    const result = filterEntitiesToRecentCampaigns([adGroup("missing")], now);

    expect(result.entities).toHaveLength(0);
    expect(result.excludedCount).toBe(1);
  });

  it("does not mistake a child create_time for the campaign creation time", () => {
    const child = adGroup("old-campaign");
    child.payload.create_time = "2026-07-15T03:00:00.000Z";

    const result = filterEntitiesToRecentCampaigns([child], now);

    expect(result.entities).toHaveLength(0);
    expect(result.excludedCount).toBe(1);
  });

  it("accepts an explicit campaign creation time carried by a child row", () => {
    const child = adGroup("recent-campaign");
    child.payload.campaign_create_time = "2026-07-15T03:00:00.000Z";

    const result = filterEntitiesToRecentCampaigns([child], now);

    expect(result.entities).toEqual([child]);
  });
});

describe("nine fixed rules", () => {
  it("uses one shared rule set for enabled layers", () => {
    const result = evaluateRuleConfiguration(
      [adGroup("recent")],
      configuration(),
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      thresholdCode: "NO_CONV_SPEND_CLOSE",
      action: "disable",
      entity: { entityType: "ad-group" },
    });
  });

  it("does not apply rules to campaigns by default", () => {
    const entity = campaign("recent", "2026-07-14T04:00:00.000Z");
    entity.payload = {
      ...entity.payload,
      row_data: { time_attr_convert_cnt: 0, stat_cost: 3 },
    };

    const result = evaluateRuleConfiguration(
      [entity],
      configuration(),
    );

    expect(result.candidates).toHaveLength(0);
  });

  it("stops after the first matching enabled rule", () => {
    const config = configuration();
    const group = adGroup("recent");
    group.payload.row_data = {
      campaign_id: "recent",
      time_attr_convert_cnt: 0,
      stat_cost: 3,
      cpc: 0.9,
      time_attr_on_web_cart: 0,
    };

    const result = evaluateRuleConfiguration(
      [group],
      config,
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.thresholdCode).toBe("NO_CONV_SPEND_CLOSE");
  });

  it("can reopen an entity that was disabled manually when an open rule matches", () => {
    const group = adGroup("recent");
    group.payload.ad_primary_status = "disable";
    group.payload.row_data = {
      campaign_id: "recent",
      time_attr_convert_cnt: 1,
      time_attr_conversion_cost: 5,
      stat_cost: 5,
      cpc: 0.5,
      time_attr_on_web_cart: 1,
    };

    const result = evaluateRuleConfiguration([group], configuration());

    expect(result.candidates[0]).toMatchObject({
      thresholdCode: "CV1_CPA_OPEN",
      action: "enable",
    });
  });

  it("uses the Official API Shop add-to-cart metric", () => {
    const group = adGroup("recent");
    group.payload.ad_primary_status = "disable";
    group.payload.row_data = {
      campaign_id: "recent",
      time_attr_convert_cnt: 0,
      stat_cost: 1,
      cpc: 0.2,
    };
    group.payload.metrics = { onsite_on_web_cart: "1" };

    const result = evaluateRuleConfiguration([group], configuration());

    expect(result.candidates[0]).toMatchObject({
      thresholdCode: "HAS_CART_OPEN",
      action: "enable",
    });
  });
});
