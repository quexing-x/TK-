import { describe, expect, it } from "vitest";
import {
  createDefaultAutomationSwitches,
  evaluateAutomation,
  normalizeProviderEntity,
  type ProviderEntity,
  type ThresholdConfig,
} from "./index.js";

const entity: ProviderEntity = {
  entityType: "ad-group",
  externalId: "adgroup-1",
  payload: {
    ad_name: "高 CPC 测试组",
    ad_primary_status: "enable",
    row_data: {
      stat_cost: "12.50",
      cpc: "1.20",
      click_cnt: "10",
      time_attr_convert_cnt: "0",
    },
  },
};

const threshold: ThresholdConfig = {
  id: "threshold-1",
  accountId: "account-1",
  code: "CPC_STOP",
  label: "CPC 超限关闭",
  metric: "cost_per_click",
  operator: "gte",
  value: 1,
  unit: "账户币种",
  stage: "stage-1",
  enabled: true,
  entityType: "ad-group",
  action: "disable",
  automationEnabled: true,
  minimumSpend: 10,
  cooldownMinutes: 60,
  updatedAt: "2026-07-14T00:00:00.000Z",
};

describe("evaluateAutomation", () => {
  it("recognizes TikTok delivery_ok campaign status as enabled", () => {
    const snapshot = normalizeProviderEntity({
      entityType: "campaign",
      externalId: "campaign-delivery-ok",
      payload: {
        campaign_name: "status test",
        campaign_primary_status: "delivery_ok",
        campaign_status: "campaign_delivery_ok",
      },
    });

    expect(snapshot.status).toBe("enabled");
  });

  it("treats TikTok delivery-limited ad groups as enabled", () => {
    const snapshot = normalizeProviderEntity({
      entityType: "ad-group",
      externalId: "adgroup-delivery-limited",
      payload: {
        ad_primary_status: "delivery_limited",
        ad_status: "ads_review_partially_approved",
      },
    });

    expect(snapshot.status).toBe("enabled");
  });

  it("keeps an explicit paused provider state closed", () => {
    const snapshot = normalizeProviderEntity({
      entityType: "ad-group",
      externalId: "adgroup-paused",
      payload: { ad_primary_status: "paused" },
    });

    expect(snapshot.status).toBe("disabled");
  });

  it("creates a disable candidate when a guarded threshold matches", () => {
    const switches = createDefaultAutomationSwitches();
    switches.manageAdGroupStatus = true;

    const result = evaluateAutomation([entity], [threshold], switches);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      action: "disable",
      metricValue: 1.2,
      entity: { externalId: "adgroup-1", status: "enabled" },
    });
  });

  it("skips automatic writes when the provider status is unknown", () => {
    const switches = createDefaultAutomationSwitches();
    switches.manageAdGroupStatus = true;
    const unknown = {
      ...entity,
      payload: {
        ...entity.payload,
        ad_primary_status: undefined,
      },
    };

    const result = evaluateAutomation([unknown], [threshold], switches);

    expect(result.candidates).toEqual([]);
    expect(result.skipped).toContainEqual(expect.objectContaining({
      externalId: "adgroup-1",
      reason: "启停状态未确认，跳过自动写入。",
    }));
  });

  it("does not create a candidate below minimum spend", () => {
    const switches = createDefaultAutomationSwitches();
    switches.manageAdGroupStatus = true;

    const result = evaluateAutomation(
      [entity],
      [{ ...threshold, minimumSpend: 20 }],
      switches,
    );

    expect(result.candidates).toHaveLength(0);
  });

  it("requires the level write switch", () => {
    const switches = createDefaultAutomationSwitches();
    switches.manageAdGroupStatus = false;
    const result = evaluateAutomation(
      [entity],
      [threshold],
      switches,
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain("状态管理能力");
  });
});

describe("normalizeProviderEntity — 系列预算(CBO) 识别", () => {
  const adGroup = (payload: Record<string, unknown>): ProviderEntity => ({
    entityType: "ad-group",
    externalId: "adgroup-1",
    payload,
  });

  it("组预算(ABO)：campaign_budget_mode 为 -1，不视为 CBO", () => {
    const snapshot = normalizeProviderEntity(adGroup({
      campaign_budget_mode: "-1",
      campaign_budget: "0.00",
      budget_mode: 3,
      ad_budget: "50.00",
    }));
    expect(snapshot.campaignBudgetOptimized).toBe(false);
    expect(snapshot.campaignBudget).toBe(0);
  });

  it("系列预算(CBO)：campaign_budget_mode 非 -1 或 campaign_budget>0 视为 CBO", () => {
    expect(normalizeProviderEntity(adGroup({
      campaign_budget_mode: "2",
      campaign_budget: "0.00",
    })).campaignBudgetOptimized).toBe(true);

    const withBudget = normalizeProviderEntity(adGroup({
      campaign_budget_mode: "-1",
      campaign_budget: "200.00",
    }));
    expect(withBudget.campaignBudgetOptimized).toBe(true);
    expect(withBudget.campaignBudget).toBe(200);
  });

  it("缺少系列预算字段时保守判为非 CBO", () => {
    expect(normalizeProviderEntity(adGroup({ ad_budget: "50.00" })).campaignBudgetOptimized).toBe(false);
  });
});
