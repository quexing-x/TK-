import { describe, expect, it } from "vitest";
import {
  BudgetModeInputError,
  budgetModeOfCampaign,
  resolveBudgetFields,
} from "./budget-mode.js";
import { buildDraftPayloads, buildProfileDraftPayloads } from "./creation-protocol.js";
import {
  assertCampaignBudgetConsistency,
  resolveConfiguredBudgetMode,
  type CreationPresetConfig,
  type LaunchConfigurationRow,
} from "./launch.js";

// 真机取值来自两份 HAR：从零创建（ABO→CBO 切换）与系列复制。
describe("resolveBudgetFields", () => {
  it("系列预算(CBO)：系列持有日预算，广告组不发预算", () => {
    const resolved = resolveBudgetFields({
      budgetMode: "campaign",
      campaignBudget: 88,
      adGroupBudget: 100,
      smartPlus: true,
    });

    expect(resolved.campaign).toEqual({
      budget_mode: 3,
      budget: "88.00",
      budget_optimize_switch: 1,
      budget_auto_adjust: {
        is_enabled: 2,
        initial_budget: "0",
        strategy: 1,
        increase_percentage: 20,
        max_increase_times: 10,
        auto_reset_next_day: true,
      },
    });
    expect(resolved.adGroup.budget_mode).toBe(-1);
    expect(resolved.adGroup.budget).toBe("");
    expect(resolved.adGroup.budget_auto_adjust.is_enabled).toBe(0);
  });

  it("广告组预算(ABO)：广告组持有日预算，系列不发预算", () => {
    const resolved = resolveBudgetFields({
      budgetMode: "ad-group",
      campaignBudget: 88,
      adGroupBudget: 100,
      smartPlus: true,
    });

    expect(resolved.campaign.budget_mode).toBe(-1);
    expect(resolved.campaign.budget).toBe("");
    expect(resolved.campaign.budget_optimize_switch).toBe(0);
    expect(resolved.campaign.budget_auto_adjust).toEqual({
      is_enabled: 0,
      initial_budget: "0",
      strategy: 0,
    });
    expect(resolved.adGroup.budget_mode).toBe(3);
    expect(resolved.adGroup.budget).toBe("100");
    expect(resolved.adGroup.budget_auto_adjust.is_enabled).toBe(2);
    expect(resolved.adGroup.budget_auto_adjust.auto_reset_next_day).toBe(false);
  });

  it("自动提预算整块跟随持有预算的那一层，且 auto_reset_next_day 两态相反", () => {
    const cbo = resolveBudgetFields({ budgetMode: "campaign", campaignBudget: 88, smartPlus: true });
    const abo = resolveBudgetFields({ budgetMode: "ad-group", adGroupBudget: 100, smartPlus: true });

    expect(cbo.campaign.budget_auto_adjust.is_enabled).toBe(2);
    expect(cbo.campaign.budget_auto_adjust.auto_reset_next_day).toBe(true);
    expect(cbo.adGroup.budget_auto_adjust.is_enabled).toBe(0);

    expect(abo.adGroup.budget_auto_adjust.is_enabled).toBe(2);
    expect(abo.adGroup.budget_auto_adjust.auto_reset_next_day).toBe(false);
    expect(abo.campaign.budget_auto_adjust.is_enabled).toBe(0);
  });

  it("非智能+ 两层都不开自动提预算", () => {
    const cbo = resolveBudgetFields({ budgetMode: "campaign", campaignBudget: 88, smartPlus: false });
    expect(cbo.campaign.budget_auto_adjust).toEqual({ is_enabled: 0, initial_budget: "0", strategy: 0 });
    expect(cbo.campaign.budget_optimize_switch).toBe(1);
  });

  it("持有预算的那一层缺金额时在发出任何请求前就报错", () => {
    expect(() => resolveBudgetFields({ budgetMode: "campaign", campaignBudget: null, smartPlus: true }))
      .toThrow(BudgetModeInputError);
    expect(() => resolveBudgetFields({ budgetMode: "campaign", campaignBudget: 0, smartPlus: true }))
      .toThrow(BudgetModeInputError);
    expect(() => resolveBudgetFields({ budgetMode: "ad-group", adGroupBudget: null, smartPlus: true }))
      .toThrow(BudgetModeInputError);
  });

  it("系列金额归一化成两位小数，组金额沿用现网朴素格式", () => {
    expect(resolveBudgetFields({ budgetMode: "campaign", campaignBudget: 88, smartPlus: true }).campaign.budget)
      .toBe("88.00");
    expect(resolveBudgetFields({ budgetMode: "ad-group", adGroupBudget: 2.5, smartPlus: true }).adGroup.budget)
      .toBe("2.5");
  });

  it("从已同步的系列快照反推预算模式", () => {
    expect(budgetModeOfCampaign(true)).toBe("campaign");
    expect(budgetModeOfCampaign(false)).toBe("ad-group");
  });
});

describe("resolveConfiguredBudgetMode", () => {
  it("新配置直接读 budgetMode", () => {
    expect(resolveConfiguredBudgetMode({ budgetMode: "campaign", campaignBudgetMode: -1 })).toBe("campaign");
    expect(resolveConfiguredBudgetMode({ budgetMode: "ad-group", campaignBudgetMode: 3 })).toBe("ad-group");
  });

  it("旧预设按 campaignBudgetMode 反推，默认组预算", () => {
    expect(resolveConfiguredBudgetMode({ campaignBudgetMode: -1 })).toBe("ad-group");
    expect(resolveConfiguredBudgetMode({ campaignBudgetMode: 0 })).toBe("ad-group");
    expect(resolveConfiguredBudgetMode({ campaignBudgetMode: null })).toBe("ad-group");
    expect(resolveConfiguredBudgetMode(undefined)).toBe("ad-group");
    expect(resolveConfiguredBudgetMode({ campaignBudgetMode: 3 })).toBe("campaign");
  });
});

describe("assertCampaignBudgetConsistency", () => {
  const row = (campaignName: string, campaignBudget: number | null) =>
    ({ campaignName, campaignBudget }) as Pick<LaunchConfigurationRow, "campaignName" | "campaignBudget">;

  it("组预算模式不做校验", () => {
    expect(() => assertCampaignBudgetConsistency([row("A", null)], "ad-group")).not.toThrow();
  });

  it("同名系列的多行必须携带同一份系列预算", () => {
    expect(() => assertCampaignBudgetConsistency(
      [row("A", 88), row("A", 88), row("B", 50)],
      "campaign",
    )).not.toThrow();

    expect(() => assertCampaignBudgetConsistency([row("A", 88), row("A", 120)], "campaign"))
      .toThrow(/两个不同的系列日预算/);
  });

  it("系列预算模式下缺金额直接拦下", () => {
    expect(() => assertCampaignBudgetConsistency([row("A", null)], "campaign"))
      .toThrow(/缺少系列日预算/);
  });
});

const cboConfig: CreationPresetConfig = {
  budgetMode: "campaign",
  objectiveType: 3, buyingType: 1, campaignBudgetMode: -1, adBudgetMode: 3,
  pricing: 9, optimizeGoal: 100, externalAction: 96, pixelId: "pixel",
  identityType: 0, identityId: null, callToActionId: "0",
  countryCodes: [1668284], placementIds: [3000], smartTargeting: false,
  commentDisabled: false, shareDisabled: false,
};

const cboRow: LaunchConfigurationRow = {
  rowNumber: 2, campaignName: "销量20260730231255", adGroupName: "广告组 20260730111311",
  adName: "ad", videoCode: "video", productUrl: "https://example.com", region: "TW",
  dailyBudget: 100, campaignBudget: 88, bid: 7, startAt: null, endAt: null,
  initialStatus: "enabled",
};

describe("系列预算模式下的完整草稿载荷", () => {
  it("从零创建：系列层持有 88.00，广告组层清空预算（对照真机 HAR）", () => {
    const payloads = buildDraftPayloads(cboRow, cboConfig);

    expect(payloads.campaign.campaign_sketch_form_data).toMatchObject({
      budget_mode: 3,
      budget: "88.00",
      budget_optimize_switch: 1,
      budget_auto_adjust: {
        is_enabled: 2,
        initial_budget: "0",
        strategy: 1,
        auto_reset_next_day: true,
      },
    });
    expect(payloads.adGroup.ad_sketch_form_data).toMatchObject({
      budget_mode: -1,
      budget: "",
      budget_auto_adjust: { is_enabled: 0, initial_budget: "0", strategy: 0 },
    });
  });

  it("抓包模板路径：预算字段压过模板里的旧值", () => {
    const payloads = buildProfileDraftPayloads({
      version: 1,
      verifiedAt: null,
      // 模板抓自一条 ABO 广告：系列无预算、组预算 25。
      campaignPayload: { campaign_sketch_form_data: { objective_type: 3, budget_mode: -1, budget: "", budget_optimize_switch: 0 } },
      adGroupPayload: { ad_sketch_form_data: { budget_mode: 3, budget: "25" } },
      creativePayload: { asset_group_sketch_form_data_list: [{ image_list: [{}] }] },
      publishPayload: {},
    }, cboRow, "UTC", new Date("2026-07-30T00:00:00.000Z"), cboConfig);

    expect(payloads.campaign.campaign_sketch_form_data).toMatchObject({
      budget_mode: 3,
      budget: "88.00",
      budget_optimize_switch: 1,
    });
    expect(payloads.adGroup.ad_sketch_form_data).toMatchObject({ budget_mode: -1, budget: "" });
  });

  it("模板不完整时仍然保证预算落在正确的一层", () => {
    const payloads = buildProfileDraftPayloads({
      version: 1,
      verifiedAt: null,
      campaignPayload: { campaign_sketch_form_data: { objective_type: 3 } },
      adGroupPayload: { ad_sketch_form_data: { budget: "25" } },
      creativePayload: { asset_group_sketch_form_data_list: [{ image_list: [{}] }] },
      publishPayload: {},
      // 故意传一个不完整的 config：applyCreationConfigOverrides 会被跳过，
      // 但预算字段必须照样正确，否则会发出「声明了系列预算却把金额留在组上」的表单。
    }, cboRow, "UTC", new Date("2026-07-30T00:00:00.000Z"), {
      ...cboConfig,
      pricing: null,
    });

    expect(payloads.campaign.campaign_sketch_form_data).toMatchObject({ budget_mode: 3, budget: "88.00" });
    expect(payloads.adGroup.ad_sketch_form_data).toMatchObject({ budget_mode: -1, budget: "" });
  });

  it("系列预算模式缺少系列日预算时，创建在发请求前就失败", () => {
    expect(() => buildDraftPayloads({ ...cboRow, campaignBudget: null }, cboConfig))
      .toThrow(BudgetModeInputError);
  });
});
