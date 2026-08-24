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

/**
 * 单次转化且加购不足。
 *
 * 这条规则最大的风险不是判据写错，而是**位置写错**：评估器命中第一条就 break，而
 * 转化量等于设定值时，CPC过高 / CPA过高 / 达标恢复三条是穷尽的（cpa 与 cpc 都有值时
 * 必命中其一）。它一旦被挪到那三条之后就永远轮不到，且不会有任何报错——测试是唯一
 * 能守住这件事的地方。
 */
describe("单次转化且加购不足", () => {
  const entity = (input: {
    conversions: number;
    carts: number;
    cpa: number;
    cpc?: number;
    status?: string;
  }): ProviderEntity => ({
    entityType: "ad-group",
    externalId: "group-1",
    payload: {
      campaign_id: "c1",
      adgroup_id: "group-1",
      ad_primary_status: input.status ?? "enable",
      create_time: "2026-07-15T00:00:00.000Z",
      row_data: {
        campaign_id: "c1",
        stat_cost: 20,
        cpc: input.cpc ?? 0.4,
        click_cnt: 50,
        time_attr_convert_cnt: input.conversions,
        time_attr_conversion_cost: input.cpa,
        time_attr_on_web_cart: input.carts,
      },
    },
  });

  const withRule = (values: { conversions: number; carts: number; cpa: number }) => {
    const config = configuration();
    config.rules = config.rules.map((rule) =>
      rule.code === "CV1_LOW_CART_CPA_CLOSE" ? { ...rule, enabled: true, values } : rule);
    return config;
  };

  it("转化达标、加购不足、CPA 超标时关闭", () => {
    const evaluation = evaluateRuleConfiguration(
      [entity({ conversions: 1, carts: 1, cpa: 8 })],
      withRule({ conversions: 1, carts: 1, cpa: 6 }),
    );

    expect(evaluation.candidates[0]).toMatchObject({
      thresholdCode: "CV1_LOW_CART_CPA_CLOSE",
      action: "disable",
    });
  });

  // 位置正确性的守门测试：默认 CPA 上限是 5，这条设 3。CPA=4 时「CPA过高」不命中
  // （4 < 5），若这条排在它后面就轮不到；排在前面才会命中。
  it("排在其余单次转化规则之前，不会被它们抢先 break 掉", () => {
    const evaluation = evaluateRuleConfiguration(
      [entity({ conversions: 1, carts: 0, cpa: 4, cpc: 0.5 })],
      withRule({ conversions: 1, carts: 1, cpa: 3 }),
    );

    // CPA=4 <= 默认上限 5 且 CPC=0.5 <= 0.8，本来会被「达标恢复」命中并 break；
    // 这条排在前面，所以先按更严的标准关掉。
    expect(evaluation.candidates[0]).toMatchObject({
      thresholdCode: "CV1_LOW_CART_CPA_CLOSE",
      action: "disable",
    });
  });

  // cpa 取 12：默认配置里「单次转化 CPA 过高」的上限是 9，要真的超过它才会接手。
  it("加购超过上限就不归它管，交回原有规则", () => {
    const evaluation = evaluateRuleConfiguration(
      [entity({ conversions: 1, carts: 5, cpa: 12 })],
      withRule({ conversions: 1, carts: 1, cpa: 6 }),
    );

    expect(evaluation.candidates[0]?.thresholdCode).toBe("CV1_CPA_CLOSE");
  });

  it("CPA 没超标就不关", () => {
    const evaluation = evaluateRuleConfiguration(
      [entity({ conversions: 1, carts: 0, cpa: 2, cpc: 0.5 })],
      withRule({ conversions: 1, carts: 1, cpa: 6 }),
    );

    expect(
      evaluation.candidates.some((c) => c.thresholdCode === "CV1_LOW_CART_CPA_CLOSE"),
    ).toBe(false);
  });

  it("转化量对不上就不归它管", () => {
    const evaluation = evaluateRuleConfiguration(
      [entity({ conversions: 3, carts: 0, cpa: 8 })],
      withRule({ conversions: 1, carts: 1, cpa: 6 }),
    );

    expect(
      evaluation.candidates.some((c) => c.thresholdCode === "CV1_LOW_CART_CPA_CLOSE"),
    ).toBe(false);
  });

  // 缺加购数据时不能当成「加购为零」——那会把没数据的广告组误关。
  it("拿不到加购数据时不判定", () => {
    const noCart = entity({ conversions: 1, carts: 0, cpa: 8 });
    delete (noCart.payload.row_data as Record<string, unknown>).time_attr_on_web_cart;

    const evaluation = evaluateRuleConfiguration([noCart], withRule({
      conversions: 1, carts: 1, cpa: 6,
    }));

    expect(
      evaluation.candidates.some((c) => c.thresholdCode === "CV1_LOW_CART_CPA_CLOSE"),
    ).toBe(false);
  });

  it("默认关闭，不会在升级后自己开始关广告组", () => {
    const rule = defaultRuleConfiguration.rules
      .find((item) => item.code === "CV1_LOW_CART_CPA_CLOSE");

    expect(rule?.enabled).toBe(false);
  });
});
