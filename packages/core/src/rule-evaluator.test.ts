import { describe, expect, it } from "vitest";
import {
  defaultRuleConfiguration,
  evaluateRuleConfiguration,
  filterEntitiesToRecentWindow,
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

function adGroup(campaignId: string, createdAt?: string, spend = 3): ProviderEntity {
  return {
    entityType: "ad-group",
    externalId: `group-${campaignId}`,
    payload: {
      campaign_id: campaignId,
      adgroup_id: `group-${campaignId}`,
      ad_primary_status: "enable",
      ...(createdAt ? { create_time: createdAt } : {}),
      row_data: {
        campaign_id: campaignId,
        time_attr_convert_cnt: 0,
        stat_cost: spend,
        cpc: 0.4,
        time_attr_on_web_cart: 0,
      },
    },
  };
}

function ad(adGroupId: string): ProviderEntity {
  return {
    entityType: "ad",
    externalId: `ad-${adGroupId}`,
    payload: {
      ad_id: `ad-${adGroupId}`,
      adgroup_id: adGroupId,
      ad_primary_status: "enable",
    },
  };
}

describe("48 hour ad-group window", () => {
  it("keeps a recent ad group even when its parent campaign predates the window", () => {
    const recent = campaign("recent", "2026-07-14T04:00:00.000Z");
    const old = campaign("old", "2026-07-12T03:59:59.000Z");

    const result = filterEntitiesToRecentWindow(
      [
        recent,
        adGroup("recent", "2026-07-14T04:00:00.000Z"),
        old,
        adGroup("old", "2026-07-15T03:00:00.000Z"),
        ad("group-old"),
      ],
      now,
    );

    expect(result.entities.map((entity) => entity.externalId)).toEqual([
      "recent",
      "group-recent",
      "group-old",
      "ad-group-old",
    ]);
    expect(result.excludedCount).toBe(1);
  });

  it("excludes entities when campaign creation time cannot be verified", () => {
    const result = filterEntitiesToRecentWindow([adGroup("missing")], now);

    expect(result.entities).toHaveLength(0);
    expect(result.excludedCount).toBe(1);
  });

  it("uses an ad group's own create time rather than its campaign's age", () => {
    const child = adGroup("old-campaign");
    child.payload.create_time = "2026-07-15T03:00:00.000Z";

    const result = filterEntitiesToRecentWindow([child], now);

    expect(result.entities).toEqual([child]);
    expect(result.excludedCount).toBe(0);
  });

  it("does not use a campaign timestamp carried by an ad group", () => {
    const child = adGroup("recent-campaign");
    child.payload.campaign_create_time = "2026-07-15T03:00:00.000Z";

    const result = filterEntitiesToRecentWindow([child], now);

    expect(result.entities).toHaveLength(0);
  });

  it("keeps an old ad group and its ads when it has spend today", () => {
    const oldGroup = adGroup("reactivated", "2026-07-12T04:00:00.000Z");
    const child = ad(oldGroup.externalId);

    const result = filterEntitiesToRecentWindow([oldGroup, child], now);

    expect(result.entities).toEqual([oldGroup, child]);
    expect(result.excludedCount).toBe(0);
  });

  it("still excludes an old ad group without spend today", () => {
    const oldGroup = adGroup("inactive", "2026-07-12T04:00:00.000Z", 0);

    const result = filterEntitiesToRecentWindow([oldGroup], now);

    expect(result.entities).toHaveLength(0);
    expect(result.excludedCount).toBe(1);
  });

  it("keeps a closed old ad group that still has spend today", () => {
    const oldGroup = adGroup("closed", "2026-07-12T04:00:00.000Z");
    oldGroup.payload.ad_primary_status = "disable";

    const result = filterEntitiesToRecentWindow([oldGroup], now);

    expect(result.entities).toEqual([oldGroup]);
    expect(result.excludedCount).toBe(0);
  });

  // 跨天场景：自动化自己关停的老广告组，次日当天消耗归零，只按 spend>0 会把它踢出
  // 评估集，归因延迟晚到的转化再也开不回来。持久管辖集把它兜住。
  it("keeps a zero-spend old ad group that automation still manages", () => {
    const oldGroup = adGroup("managed", "2026-07-12T04:00:00.000Z", 0);
    oldGroup.payload.ad_primary_status = "disable";

    const excluded = filterEntitiesToRecentWindow([oldGroup], now);
    expect(excluded.entities).toHaveLength(0);

    const kept = filterEntitiesToRecentWindow(
      [oldGroup],
      now,
      undefined,
      new Set(["group-managed"]),
    );
    expect(kept.entities).toEqual([oldGroup]);
    expect(kept.excludedCount).toBe(0);
  });

  it("does not keep a zero-spend old ad group outside the managed set", () => {
    const oldGroup = adGroup("unmanaged", "2026-07-12T04:00:00.000Z", 0);
    oldGroup.payload.ad_primary_status = "disable";

    const result = filterEntitiesToRecentWindow(
      [oldGroup],
      now,
      undefined,
      new Set(["group-something-else"]),
    );

    expect(result.entities).toHaveLength(0);
  });

  // 归因延迟的真实场景：老广告组上午按「零转化 + 消耗超上限」被自动关掉，
  // 转化随后才回传。窗口若要求对象当前开着，它就永久掉出评估集，开启规则
  // 再也够不着——线上 2026-08-10 的 `漆面去除_新-0807-085313-1` 就是这样
  // 只能人工开回来。
  it("re-opens a closed old ad group once its metrics meet an open rule", () => {
    const oldGroup = adGroup("late-conversion", "2026-07-12T04:00:00.000Z");
    oldGroup.payload.ad_primary_status = "disable";
    Object.assign(oldGroup.payload.row_data as Record<string, unknown>, {
      time_attr_convert_cnt: 1,
      time_attr_conversion_cost: 2.41,
      cpc: 0.06,
      stat_cost: 2.41,
    });

    const window = filterEntitiesToRecentWindow([oldGroup], now);
    const result = evaluateRuleConfiguration(window.entities, configuration());

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      thresholdCode: "CV1_CPA_OPEN",
      action: "enable",
    });
    expect(result.candidates[0]?.entity.externalId).toBe(oldGroup.externalId);
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
