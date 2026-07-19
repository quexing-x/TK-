import { describe, expect, it } from "vitest";
import { TikTokCreationSteps, buildDraftPayloads, buildProfileDraftPayloads, buildPublishInput, CreationPresetIncompleteError, deriveTikTokCreationRequest, getCreationTemplateReadiness } from "./creation-protocol.js";

describe("creation protocol", () => {
  it("reports template readiness without exposing internal field names", () => {
    expect(getCreationTemplateReadiness({
      objectiveType: null, buyingType: null, campaignBudgetMode: null, adBudgetMode: null,
      pricing: null, optimizeGoal: null, externalAction: null, pixelId: null,
      identityType: null, identityId: null, callToActionId: null, countryCodes: [],
      placementIds: [], smartTargeting: true, commentDisabled: false, shareDisabled: false,
    })).toEqual({ ready: false, missingFieldCount: 10 });
  });
  it("uses the confirmed four-step draft chain and makes the initial state explicit", () => {
    expect(TikTokCreationSteps).toEqual(["campaign_snap/save", "ad_snap/save", "creative_snap/save", "async_creation/create_by_snap"]);
    const input = { campaignSnapId: "campaign-snap", campaignSketchId: "campaign-sketch", adAndCreativeSnapInfoList: [{ ad_snap_id: "ad-snap" }] };
    expect(buildPublishInput(input, "disabled")).toMatchObject({ campaign_id: "", is_status_disabled: true, is_partial_publish: false });
    expect(buildPublishInput(input, "enabled")).toMatchObject({ campaign_id: "", is_status_disabled: false, is_partial_publish: false });
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
    expect(payloads.adGroup.ad_sketch_form_data.budget).toBe("100");
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

  it("uses an encrypted account snapshot while replacing only creation inputs", () => {
    const payloads = buildProfileDraftPayloads({ version: 1, verifiedAt: null,
      campaignPayload: { campaign_sketch_form_data: { campaign_name: "old", objective_type: 9, campaign_id: "old-id" }, risk_info: { browser_name: "saved" } },
      adGroupPayload: { ad_sketch_form_data: { ad_name: "old", budget: "1", cpa_bid: "1", identity_only: "kept" }, risk_info: { browser_name: "saved" } },
      creativePayload: { asset_group_sketch_form_data_list: [{ creative_name: "old", external_url: "https://old.example", image_list: [{ aweme_item_id: "old-video", identity_id: "kept" }] }] },
      publishPayload: {},
    }, { rowNumber: 2, campaignName: "new campaign", adGroupName: "new group", adName: "260716:001", videoCode: "new-video", productUrl: "https://example.com/product", region: "US", dailyBudget: 25, bid: 2.5, startAt: null, endAt: null, initialStatus: "disabled" });
    expect(payloads.campaign.campaign_sketch_form_data).toMatchObject({ campaign_name: "new campaign", campaign_id: "", objective_type: 9 });
    expect(payloads.adGroup.ad_sketch_form_data).toMatchObject({ ad_name: "new group", budget: "25", cpa_bid: "2.5", identity_only: "kept" });
    expect((payloads.creative.asset_group_sketch_form_data_list as Array<unknown>)[0]).toMatchObject({ creative_name: "260716:001", external_url: "https://example.com/product", image_list: [{ aweme_item_id: "new-video", identity_id: "kept" }] });
  });

});
