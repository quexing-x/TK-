import { describe, expect, it } from "vitest";
import { TikTokCreationSteps, buildDraftPayloads, buildProfileDraftPayloads, buildPublishInput, CreationPresetIncompleteError, deriveTikTokCreationRequest, getCreationTemplateReadiness } from "./creation-protocol.js";
import { LANDING_PAGE_TRACKING_PARAMS } from "./tracking-url.js";

// 落地页在创建时会被补上归因参数（表里只填域名）。这里验的是「走了归因加工」，
// 参数串本身的内容由 tracking-url.test.ts 逐字守。
const tracked = (url: string) => `${url}?${LANDING_PAGE_TRACKING_PARAMS}`;

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
      creative_name: "260716:001", external_url: tracked("https://example.com/product"),
      image_list: [{ aweme_item_id: "video-001" }],
      creative_automation_type: 2,
      creative_automation_list: ["100001", "100002", "7455417586723028993"],
      need_create_cta_id: true,
      catalog_setup: 0,
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
      // 真机 Smart+ 7/7 取 1；此前发 0 是 uaa_campaign_automation_inconsistent_error
      // 的成因之一，详见文件下方那条针对系列层 automation 自述的断言。
      dedicate_type: 1,
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
        // limited_audience 是「可选范围」，Smart+ 必须原样带全池（含未成年档），
        // 少一档会被判成自定义年龄而拒绝；实际投放年龄走 age，空数组 = 不限。
        // 线上实测：age=[[25,34]] 时 TikTok 回读 ad_age="25-34"，age=[] 时为"全部"。
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
    expect(payloads.creative.asset_group_sketch_form_data_list[0]).toMatchObject({
      creative_material_mode: 6,
      creative_automation_type: 2,
      creative_automation_list: ["100001", "100002", "7455417586723028993"],
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
    const smartAsset = payloads.creative.asset_group_sketch_form_data_list[0] as Record<string, unknown>;
    expect(smartAsset.creative_automation_list)
      .not.toEqual(expect.arrayContaining(["200001", "7419232909960003601", "7478954523433500688"]));

    // 这三个字段一律不出现在创意层。toMatchObject 只校验列出的键，删掉断言等于没防住，
    // 必须显式断言「不存在」。
    //
    // 2026-08-27 生产留证：创意层带着 spc_upgrade_mode=0 发出，顶层却是 1，TikTok 判
    // uaa_campaign_automation_inconsistent_error。此前护栏挂在 identityType === 5 上，
    // 而授权码这条路真正用的是 identity_type=2，护栏从未生效；同一个错反复了 20 天，
    // 「把它归零」的补丁打过三次。同日真机抓包的 10 条 creative_snap/save
    // （identity_type 2 与 3 都有）创意层一次都没出现过这三个字段。
    for (const field of ["spc_upgrade_mode", "spc_multi_ad_mode", "is_smart_creative"]) {
      expect(smartAsset, field).not.toHaveProperty(field);
    }
    // 顶层的 spc_upgrade_mode 是另一回事，真机恒为 1，不受本条约束。

    // 广告组层同一个毛病：这两个只在请求顶层，不进 ad_sketch_form_data。
    // 真机 11/11 的 ad_snap/save 都是顶层有、form 里没有；spc_targeting_switch 才在 form 里。
    expect(payloads.adGroup).toMatchObject({ spc_upgrade_mode: 1 });
    const adForm = payloads.adGroup.ad_sketch_form_data as Record<string, unknown>;
    expect(adForm).toMatchObject({ spc_targeting_switch: 0 });
    for (const field of ["spc_upgrade_mode", "spc_multi_ad_mode"]) {
      expect(adForm, field).not.toHaveProperty(field);
    }

    // 系列层的 automation 自述：真机 Smart+（objective_type=3）7/7 取这组值。
    // 发错这三个，系列自述与 Smart+ 结构对不上，同样是
    // uaa_campaign_automation_inconsistent_error——错误名里的 campaign 指的就是这一层。
    expect(payloads.campaign.campaign_sketch_form_data).toMatchObject({
      dedicate_type: 1,
      universal_type_default_on: true,
      promotion_scenario: 0,
    });
  });

  it("maps spreadsheet-row gender and age ranges into the Smart+ audience form", () => {
    const payloads = buildDraftPayloads({
      rowNumber: 2, campaignName: "campaign", adGroupName: "group", adName: "ad",
      videoCode: "video", productUrl: "https://example.com", region: "TW",
      dailyBudget: 50, bid: 7, startAt: null, endAt: null, initialStatus: "disabled",
      gender: "female", ageRanges: ["25-34", "35-44", "45-54", "55-100"],
    }, {
      objectiveType: 3, buyingType: 1, campaignBudgetMode: -1, adBudgetMode: 3,
      pricing: 9, optimizeGoal: 100, externalAction: 96, pixelId: "pixel",
      identityType: 0, identityId: null, callToActionId: "0",
      countryCodes: [1668284], placementIds: [3000], smartTargeting: false,
      commentDisabled: false, shareDisabled: false,
      gender: "male", ageRanges: ["18-24"],
    });

    expect(payloads.adGroup.ad_sketch_form_data).toMatchObject({
      gender: 2,
      // 行里选了 4 档（不是全选）-> age 带这 4 档；可选范围恒为全池。
      age: [[25, 34], [35, 44], [45, 54], [55, 100]],
      exclude_age_under_eighteen: 0,
      limited_audience: { age: [[13, 17], [18, 24], [25, 34], [35, 44], [45, 54], [55, 100]] },
    });
  });

  it("选满全部可选档等同于不限：age 发空数组，而不是把五档逐个列出", () => {
    // 模板默认就是全选。真机「不限年龄」发的是空 age，TikTok 界面才显示「全部」；
    // 逐个列出会被显示成自定义档位。
    const payloads = buildDraftPayloads({
      rowNumber: 2, campaignName: "campaign", adGroupName: "group", adName: "ad",
      videoCode: "video", productUrl: "https://example.com", region: "TW",
      dailyBudget: 50, bid: 7, startAt: null, endAt: null, initialStatus: "disabled",
      gender: "all", ageRanges: ["18-24", "25-34", "35-44", "45-54", "55-100"],
    }, {
      objectiveType: 3, buyingType: 1, campaignBudgetMode: -1, adBudgetMode: 3,
      pricing: 9, optimizeGoal: 100, externalAction: 96, pixelId: "pixel",
      identityType: 0, identityId: null, callToActionId: "0",
      countryCodes: [1668284], placementIds: [3000], smartTargeting: false,
      commentDisabled: false, shareDisabled: false,
    });

    expect(payloads.adGroup.ad_sketch_form_data).toMatchObject({
      age: [],
      exclude_age_under_eighteen: 0,
      limited_audience: { age: [[13, 17], [18, 24], [25, 34], [35, 44], [45, 54], [55, 100]] },
    });
  });

  it("applies spreadsheet-row gender and age ranges to an account snapshot", () => {
    const payloads = buildProfileDraftPayloads({ version: 1, verifiedAt: null,
      campaignPayload: { campaign_sketch_form_data: {} },
      adGroupPayload: { ad_sketch_form_data: { gender: 0, age: [], limited_audience: { age: [] } } },
      creativePayload: { asset_group_sketch_form_data_list: [{ image_list: [{}] }] },
      publishPayload: {},
    }, {
      rowNumber: 2, campaignName: "campaign", adGroupName: "group", adName: "ad",
      videoCode: "video", productUrl: "https://example.com", region: "TW",
      dailyBudget: 50, bid: 7, startAt: null, endAt: null, initialStatus: "disabled",
      gender: "female", ageRanges: ["25-34", "35-44", "45-54", "55-100"],
    }, "UTC", new Date("2026-08-21T00:00:00.000Z"), {
      objectiveType: 3, buyingType: 1, campaignBudgetMode: -1, adBudgetMode: 3,
      pricing: 9, optimizeGoal: 100, externalAction: 96, pixelId: "pixel",
      identityType: 0, identityId: null, callToActionId: "0",
      countryCodes: [1668284], placementIds: [3000], smartTargeting: false,
      commentDisabled: false, shareDisabled: false,
      gender: "male", ageRanges: ["18-24"],
    });

    expect(payloads.adGroup.ad_sketch_form_data).toMatchObject({
      gender: 2,
      // 行里选了 4 档（不是全选）-> age 带这 4 档；可选范围恒为全池。
      age: [[25, 34], [35, 44], [45, 54], [55, 100]],
      exclude_age_under_eighteen: 0,
      limited_audience: { age: [[13, 17], [18, 24], [25, 34], [35, 44], [45, 54], [55, 100]] },
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
    expect((payloads.creative.asset_group_sketch_form_data_list as Array<unknown>)[0]).toMatchObject({ creative_name: "260716:001", external_url: tracked("https://example.com/product"), creative_snap_id: "", creative_sketch_id: "", image_list: [{ aweme_item_id: "new-video", identity_id: "kept" }] });
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
    expect((payloads.creative.asset_group_sketch_form_data_list as Array<unknown>)[0]).toMatchObject({
      identity_type: 8,
      identity_id: "identity",
      call_to_action_id: "",
      need_create_cta_id: true,
      creative_automation_list: ["100001", "100002", "7455417586723028993"],
      is_comment_disable: 1,
      is_share_disable: 1,
    });
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
      creative_automation_list: ["100001", "100002", "7455417586723028993"],
      catalog_setup: 0,
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
      external_url: tracked("https://example.com/product"),
      // 归因参数只进 external_url。open_url 是 TikTok 另一套直达链接功能，往里写落地页
      // 会让它启用一个不完整的直达链接、并卡在 ad_creative_snap/check。
      open_url: "",
      is_open_url: 0,
      auto_open: 0,
    });
  });

});
