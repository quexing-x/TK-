import { describe, expect, it } from "vitest";
import { TikTokCreationSteps, buildDraftPayloads, buildProfileDraftPayloads, buildPublishInput, CreationPresetIncompleteError, deriveTikTokCreationRequest, getCreationTemplateReadiness } from "./creation-protocol.js";

describe("creation protocol", () => {
  it("reports template readiness without exposing internal field names", () => {
    expect(getCreationTemplateReadiness()).toEqual({ ready: false, missingFieldCount: 8 });
    expect(getCreationTemplateReadiness({
      objectiveType: null, buyingType: null, campaignBudgetMode: null, adBudgetMode: null,
      pricing: null, optimizeGoal: null, externalAction: null, pixelId: null,
      identityType: null, identityId: null, callToActionId: null, countryCodes: [],
      placementIds: [], smartTargeting: true, commentDisabled: false, shareDisabled: false,
    })).toEqual({ ready: false, missingFieldCount: 8 });
  });
  it("uses the confirmed four-step draft chain and makes the initial state explicit", () => {
    expect(TikTokCreationSteps).toEqual(["campaign_snap/save", "ad_snap/save", "creative_snap/save", "async_creation/create_by_snap"]);
    const input = { campaignSnapId: "campaign-snap", campaignSketchId: "campaign-sketch", adAndCreativeSnapInfoList: [{ ad_snap_id: "ad-snap" }] };
    expect(buildPublishInput(input, "disabled")).toMatchObject({ campaign_id: "", is_status_disabled: true, is_partial_publish: false, coming_source_type: 1, sketch_publish_source: 1 });
    expect(buildPublishInput(input, "enabled")).toMatchObject({ campaign_id: "", is_status_disabled: false, is_partial_publish: false, coming_source_type: 1, sketch_publish_source: 1 });
  });

  it("derives each fixed creation path from the two-cURL session without retaining credentials", () => {
    const request = deriveTikTokCreationRequest({
      target: "ad-group",
      url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=123&msToken=session-value",
      method: "GET",
      headers: { "x-csrftoken": "kept-in-vault" },
    }, "campaign_snap/save");

    expect(new URL(request.url).pathname).toBe("/api/v4/i18n/creation/campaign_snap/save/");
    expect(new URL(request.url).searchParams.get("aadvid")).toBe("123");
    expect(request.method).toBe("POST");
    expect(request).not.toHaveProperty("cookie");
  });

  it("builds three draft payloads from one spreadsheet row and the saved preset", () => {
    const payloads = buildDraftPayloads({
      rowNumber: 2, campaignName: "夏季系列", adGroupName: "夏季广告组", adName: "260716:001",
      videoCode: "video-001", productUrl: "https://example.com/product", region: "US",
      dailyBudget: 100, bid: 2.5, startAt: "2026-07-16T16:00:00.000Z", endAt: null, initialStatus: "enabled",
    }, {
      objectiveType: 1, buyingType: 1, campaignBudgetMode: 0, adBudgetMode: 0,
      pricing: 1, optimizeGoal: 1, externalAction: 1, pixelId: "pixel", identityType: 1,
      identityId: "identity", callToActionId: "SHOP_NOW", countryCodes: [840], placementIds: [1],
      smartTargeting: true, commentDisabled: false, shareDisabled: false,
    });

    expect(payloads.campaign.campaign_sketch_form_data.campaign_name).toBe("夏季系列");
    expect(payloads.campaign.campaign_sketch_form_data.industry_types).toEqual([]);
    expect(payloads.adGroup.ad_sketch_form_data.budget).toBe("100");
    expect(payloads.adGroup.ad_sketch_form_data.inventory_flow).toEqual([1]);
    expect(payloads.adGroup.ad_sketch_form_data.start_time).toBe("2026-07-16 16:00:00");
    expect(payloads.adGroup.ad_sketch_form_data.end_time).toBe("2036-07-16 16:00:00");
    expect(payloads.creative.asset_group_sketch_form_data_list[0]).toMatchObject({
      creative_name: "260716:001", external_url: "https://example.com/product",
      image_list: [{ aweme_item_id: "video-001" }],
    });
  });

  it("rejects an incomplete preset before any provider request is attempted", () => {
    expect(() => buildDraftPayloads({
      rowNumber: 2, campaignName: "系列", adGroupName: "组", adName: "260716:001", videoCode: "v", productUrl: "https://example.com", region: "US", dailyBudget: 1, bid: null, startAt: null, endAt: null, initialStatus: "disabled",
    }, { objectiveType: null, buyingType: null, campaignBudgetMode: null, adBudgetMode: null, pricing: null, optimizeGoal: null, externalAction: null, pixelId: null, identityType: null, identityId: null, callToActionId: null, countryCodes: [], placementIds: [], smartTargeting: true, commentDisabled: false, shareDisabled: false }))
      .toThrow(CreationPresetIncompleteError);
  });

  it("does not require an identity id for the account-default identity type", () => {
    const config = {
      objectiveType: 3, buyingType: 1, campaignBudgetMode: -1, adBudgetMode: 3,
      pricing: 1, optimizeGoal: 100, externalAction: 96, pixelId: "pixel",
      identityType: 0, identityId: null, callToActionId: "0", countryCodes: [1668284],
      placementIds: [3000], smartTargeting: false, commentDisabled: false, shareDisabled: false,
    };
    expect(getCreationTemplateReadiness(config)).toEqual({ ready: true, missingFieldCount: 0 });
    const payloads = buildDraftPayloads({
      rowNumber: 2, campaignName: "campaign", adGroupName: "group", adName: "ad",
      videoCode: "video", productUrl: "https://example.com", region: "TW",
      dailyBudget: 100, bid: 7, startAt: null, endAt: null, initialStatus: "enabled",
    }, config);
    expect(payloads.creative.asset_group_sketch_form_data_list[0]).toMatchObject({
      identity_type: 0,
      identity_id: "",
      call_to_action_id: "",
    });
  });

  it("defers pixel resolution until account execution instead of blocking create", () => {
    expect(getCreationTemplateReadiness({
      objectiveType: 3, buyingType: 1, campaignBudgetMode: -1, adBudgetMode: 3,
      pricing: 9, optimizeGoal: 100, externalAction: 96,
      pixelKey: "D2LUO4BC77U67ECJGK00", pixelId: null,
      identityType: 0, identityId: null, callToActionId: "0",
      countryCodes: [1668284], placementIds: [3000], smartTargeting: false,
      commentDisabled: false, shareDisabled: false,
    })).toEqual({ ready: true, missingFieldCount: 0 });
  });

  it("builds a current Smart+ oCPM form without under-18, dynamic-budget, or first-phase conflicts", () => {
    const payloads = buildDraftPayloads({
      rowNumber: 2, campaignName: "campaign", adGroupName: "group", adName: "ad",
      videoCode: "video", productUrl: "https://example.com", region: "TW",
      dailyBudget: 50, bid: 7, startAt: null, endAt: null, initialStatus: "disabled",
    }, {
      objectiveType: 3, buyingType: 1, campaignBudgetMode: -1, adBudgetMode: 3,
      pricing: 9, optimizeGoal: 100, externalAction: 96, pixelId: "pixel",
      identityType: 2, identityId: "identity", callToActionId: "0",
      countryCodes: [1668284], placementIds: [3000], smartTargeting: false,
      commentDisabled: false, shareDisabled: false,
    });

    expect(payloads.campaign.campaign_sketch_form_data).toMatchObject({
      dedicate_type: 0,
      app_campaign_type: 0,
      rf_campaign_type: 0,
      brand_campaign_type: 0,
      spc_automation_type: 1,
      spc_upgrade_mode: 1,
      spc_multi_ad_mode: 1,
      budget_auto_adjust: { is_enabled: 0, initial_budget: "0", strategy: 0 },
    });
    expect(payloads.campaign.is_skip_check_fields).toBe(true);
    expect(payloads.adGroup).toMatchObject({
      spc_upgrade_mode: 1,
      is_skip_check_fields: true,
      ad_sketch_form_data: {
        coming_source_type: 1,
        sketch_publish_source: 1,
        pricing: 9,
        bid: "0",
        cpa_bid: "7",
        smart_bid_type: 0,
        optimization_source: 0,
        cpa_skip_first_phrase: 1,
        exclude_age_under_eighteen: 0,
        age: [],
        limited_audience: { age: [[13, 17], [18, 24], [25, 34], [35, 44], [45, 54], [55, 100]] },
        smart_age: 3,
        smart_audience: 3,
        smart_gender: 3,
        budget_auto_adjust: {
          is_enabled: 2,
          initial_budget: "0",
          strategy: 1,
          increase_percentage: 20,
          max_increase_times: 10,
          auto_reset_next_day: false,
        },
      },
    });
    expect(payloads.adGroup.ad_sketch_form_data).toMatchObject({
      spc_upgrade_mode: 1,
      spc_multi_ad_mode: 1,
    });
    expect(payloads.creative.asset_group_sketch_form_data_list[0]).toMatchObject({
      creative_material_mode: 6,
      creative_automation_type: 1,
      is_smart_creative: false,
      spc_upgrade_mode: 0,
      spc_multi_ad_mode: 0,
      auto_pull_by_destination_toggle: 2,
      auto_pull_by_aigc_toggle: 2,
      aigc_approval_auto_pull_toggle: 2,
      auto_pull_toggle: 0,
      catalog_setup: 0,
      product_info_type: 1,
      product_info: {
        promo_code_infos: [],
        is_auto_use: 2,
        auto_select_toggle: 0,
        image_infos: [],
        selling_points_by_types: [],
      },
      need_create_cta_id: true,
      call_to_action_id: "",
      call_to_action_asset_list: [{ asset_ids: [202046, 201641], cta_content: "立即下单" }],
    });
  });

  it("maps preset gender and age ranges into the Smart+ audience form", () => {
    const payloads = buildDraftPayloads({
      rowNumber: 2, campaignName: "campaign", adGroupName: "group", adName: "ad",
      videoCode: "video", productUrl: "https://example.com", region: "TW",
      dailyBudget: 50, bid: 7, startAt: null, endAt: null, initialStatus: "disabled",
    }, {
      objectiveType: 3, buyingType: 1, campaignBudgetMode: -1, adBudgetMode: 3,
      pricing: 9, optimizeGoal: 100, externalAction: 96, pixelId: "pixel",
      identityType: 0, identityId: null, callToActionId: "0",
      countryCodes: [1668284], placementIds: [3000], smartTargeting: false,
      commentDisabled: false, shareDisabled: false,
      gender: "female", ageRanges: ["25-34", "35-44", "45-54", "55-100"],
    });

    expect(payloads.adGroup.ad_sketch_form_data).toMatchObject({
      gender: 2,
      age: [],
      exclude_age_under_eighteen: 1,
      limited_audience: { age: [[25, 34], [35, 44], [45, 54], [55, 100]] },
    });
  });

  it("applies preset gender and age ranges to an account snapshot", () => {
    const payloads = buildProfileDraftPayloads({ version: 1, verifiedAt: null,
      campaignPayload: { campaign_sketch_form_data: {} },
      adGroupPayload: { ad_sketch_form_data: { gender: 0, age: [], limited_audience: { age: [] } } },
      creativePayload: { asset_group_sketch_form_data_list: [{ image_list: [{}] }] },
      publishPayload: {},
    }, {
      rowNumber: 2, campaignName: "campaign", adGroupName: "group", adName: "ad",
      videoCode: "video", productUrl: "https://example.com", region: "TW",
      dailyBudget: 50, bid: 7, startAt: null, endAt: null, initialStatus: "disabled",
    }, "UTC", new Date("2026-08-21T00:00:00.000Z"), {
      objectiveType: 3, buyingType: 1, campaignBudgetMode: -1, adBudgetMode: 3,
      pricing: 9, optimizeGoal: 100, externalAction: 96, pixelId: "pixel",
      identityType: 0, identityId: null, callToActionId: "0",
      countryCodes: [1668284], placementIds: [3000], smartTargeting: false,
      commentDisabled: false, shareDisabled: false,
      gender: "female", ageRanges: ["25-34", "35-44", "45-54", "55-100"],
    });

    expect(payloads.adGroup.ad_sketch_form_data).toMatchObject({
      gender: 2,
      age: [],
      exclude_age_under_eighteen: 1,
      limited_audience: { age: [[25, 34], [35, 44], [45, 54], [55, 100]] },
    });
  });

  it("preserves snapshot gender for a legacy preset without a gender field", () => {
    const payloads = buildProfileDraftPayloads({ version: 1, verifiedAt: null,
      campaignPayload: { campaign_sketch_form_data: {} },
      adGroupPayload: { ad_sketch_form_data: { gender: 2 } },
      creativePayload: { asset_group_sketch_form_data_list: [{ image_list: [{}] }] },
      publishPayload: {},
    }, {
      rowNumber: 2, campaignName: "campaign", adGroupName: "group", adName: "ad",
      videoCode: "video", productUrl: "https://example.com", region: "TW",
      dailyBudget: 50, bid: 7, startAt: null, endAt: null, initialStatus: "disabled",
    }, "UTC", new Date("2026-08-21T00:00:00.000Z"), {
      objectiveType: 1, buyingType: 1, campaignBudgetMode: -1, adBudgetMode: 3,
      pricing: 9, optimizeGoal: 100, externalAction: 96, pixelId: "pixel",
      identityType: 0, identityId: null, callToActionId: "0",
      countryCodes: [1668284], placementIds: [3000], smartTargeting: false,
      commentDisabled: false, shareDisabled: false,
    });

    expect(payloads.adGroup.ad_sketch_form_data).toMatchObject({ gender: 2 });
  });

  it("uses an encrypted account snapshot while replacing only creation inputs", () => {
    const payloads = buildProfileDraftPayloads({ version: 1, verifiedAt: null,
      campaignPayload: { campaign_sketch_form_data: { campaign_name: "old", objective_type: 9, campaign_id: "old-id" }, risk_info: { browser_name: "saved" } },
      adGroupPayload: { ad_sketch_form_data: { ad_name: "old", budget: "1", cpa_bid: "1", identity_only: "kept", origin_ad_id: 0, ad_snap_id: "captured-ad-snap", ad_sketch_id: "captured-ad-sketch", by_ad_sketch_id: "captured-ad-sketch" }, risk_info: { browser_name: "saved" } },
      creativePayload: { asset_group_sketch_form_data_list: [{ creative_name: "old", external_url: "https://old.example", creative_snap_id: "captured-creative-snap", creative_sketch_id: "captured-creative-sketch", image_list: [{ aweme_item_id: "old-video", identity_id: "kept" }] }] },
      publishPayload: {},
    }, { rowNumber: 2, campaignName: "new campaign", adGroupName: "new group", adName: "260716:001", videoCode: "new-video", productUrl: "https://example.com/product", region: "US", dailyBudget: 25, bid: 2.5, startAt: null, endAt: null, initialStatus: "disabled" });
    expect(payloads.campaign.campaign_sketch_form_data).toMatchObject({ campaign_name: "new campaign", campaign_id: "", objective_type: 9, industry_types: [] });
    expect(payloads.adGroup.ad_sketch_form_data).toMatchObject({ ad_name: "new group", budget: "25", cpa_bid: "2.5", identity_only: "kept", origin_ad_id: 0, ad_snap_id: "", ad_sketch_id: "", by_ad_sketch_id: "" });
    expect((payloads.creative.asset_group_sketch_form_data_list as Array<unknown>)[0]).toMatchObject({ creative_name: "260716:001", external_url: "https://example.com/product", creative_snap_id: "", creative_sketch_id: "", image_list: [{ aweme_item_id: "new-video", identity_id: "kept" }] });
  });

  it("applies a complete advanced preset as an explicit override of the account snapshot", () => {
    const payloads = buildProfileDraftPayloads({ version: 1, verifiedAt: null,
      campaignPayload: { campaign_sketch_form_data: { objective_type: 9, buying_type: 9, budget_mode: 9 } },
      adGroupPayload: { ad_sketch_form_data: { budget_mode: 9, pricing: 9, optimize_goal: 9, external_action: 9, country: [999] } },
      creativePayload: { asset_group_sketch_form_data_list: [{ image_list: [{}], identity_type: 9, identity_id: "old", call_to_action_id: "old" }] },
      publishPayload: {},
    }, { rowNumber: 2, campaignName: "campaign", adGroupName: "group", adName: "ad", videoCode: "video", productUrl: "https://example.com", region: "US", dailyBudget: 10, bid: null, startAt: null, endAt: null, initialStatus: "disabled" }, "UTC", new Date("2026-07-20T00:00:00.000Z"), {
      objectiveType: 1, buyingType: 2, campaignBudgetMode: -1, adBudgetMode: 3,
      pricing: 5, optimizeGoal: 6, externalAction: 7, pixelId: "pixel", identityType: 8,
      identityId: "identity", callToActionId: "SHOP_NOW", countryCodes: [840], placementIds: [11],
      smartTargeting: false, commentDisabled: true, shareDisabled: true,
    });
    // 预算模式由 budgetMode 派生：组预算模式下系列层为 -1、组层为 3，
    // 不再把预设里的原始 budget_mode 数字透传给 TikTok。
    expect(payloads.campaign.campaign_sketch_form_data).toMatchObject({ objective_type: 1, buying_type: 2, budget_mode: -1, budget: "" });
    expect(payloads.adGroup.ad_sketch_form_data).toMatchObject({ budget_mode: 3, budget: "10", pricing: 5, optimize_goal: 6, external_action: 7, ad_ref_pixel_id: "pixel", country: [840], platform: [0], inventory_flow: [11] });
    expect((payloads.creative.asset_group_sketch_form_data_list as Array<unknown>)[0]).toMatchObject({ identity_type: 8, identity_id: "identity", call_to_action_id: "SHOP_NOW", is_comment_disable: 1, is_share_disable: 1 });
  });

  it("preserves the verified programmatic CTA assets instead of replacing them with preset id zero", () => {
    const payloads = buildProfileDraftPayloads({ version: 1, verifiedAt: null,
      campaignPayload: { campaign_sketch_form_data: { objective_type: 9 } },
      adGroupPayload: { ad_sketch_form_data: { budget: "1" } },
      creativePayload: { asset_group_sketch_form_data_list: [{
        image_list: [{}],
        call_to_action_id: "",
        need_create_cta_id: true,
        creative_automation_type: 2,
        call_to_action_asset_list: [{ asset_ids: [202046, 201641], cta_content: "立即下单" }],
      }] },
      publishPayload: {},
    }, { rowNumber: 2, campaignName: "campaign", adGroupName: "group", adName: "ad", videoCode: "video", productUrl: "https://example.com", region: "US", dailyBudget: 10, bid: null, startAt: null, endAt: null, initialStatus: "disabled" }, "UTC", new Date("2026-07-20T00:00:00.000Z"), {
      objectiveType: 1, buyingType: 2, campaignBudgetMode: -1, adBudgetMode: 3,
      pricing: 5, optimizeGoal: 6, externalAction: 7, pixelId: "pixel", identityType: 8,
      identityId: "identity", callToActionId: "0", countryCodes: [840], placementIds: [11],
      smartTargeting: false, commentDisabled: true, shareDisabled: true,
    });

    expect((payloads.creative.asset_group_sketch_form_data_list as Array<unknown>)[0]).toMatchObject({
      call_to_action_id: "",
      need_create_cta_id: true,
      creative_automation_type: 2,
      call_to_action_asset_list: [{ asset_ids: [202046, 201641], cta_content: "立即下单" }],
    });
  });

  it("keeps direct-link mode disabled while replacing the normal landing-page URL", () => {
    const payloads = buildProfileDraftPayloads({
      version: 1,
      verifiedAt: null,
      campaignPayload: { campaign_sketch_form_data: {} },
      adGroupPayload: { ad_sketch_form_data: {} },
      creativePayload: { asset_group_sketch_form_data_list: [{
        image_list: [{}],
        external_url: "https://old.example/landing",
        open_url: "",
        is_open_url: 0,
        auto_open: 0,
      }] },
      publishPayload: {},
    }, {
      rowNumber: 2,
      campaignName: "campaign",
      adGroupName: "group",
      adName: "ad",
      videoCode: "video",
      productUrl: "https://example.com/product",
      region: "US",
      dailyBudget: 10,
      bid: null,
      startAt: null,
      endAt: null,
      initialStatus: "disabled",
    });

    expect((payloads.creative.asset_group_sketch_form_data_list as Array<unknown>)[0]).toMatchObject({
      external_url: "https://example.com/product",
      open_url: "",
      is_open_url: 0,
      auto_open: 0,
    });
  });

});
