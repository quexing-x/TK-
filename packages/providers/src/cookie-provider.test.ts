import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieAdsProvider } from "./cookie-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CookieAdsProvider", () => {
  it("overrides a captured multi-day range with the account's current day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T02:30:00.000Z"));
    let sentBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ data: { table: [] }, code: 0 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }));

    await new CookieAdsProvider().syncReadOnly({
      accountId: "test-account", timezone: "Asia/Taipei",
      settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: { kind: "cookie", cookie: "sessionid=test-cookie", csrfHeaderName: "x-csrftoken", requestTemplates: [{
        target: "ad-group", url: "https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=123456",
        method: "POST", body: '{"date_range":{"start_date":"2026-07-01","end_date":"2026-07-15"}}', contentType: "application/json",
      }] },
    });

    expect(JSON.parse(sentBody)).toMatchObject({
      date_range: { start_date: "2026-07-16", end_date: "2026-07-16" },
    });
  });

  it("replays a valid list cURL without explicit dates instead of stopping polling", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: { table: [] }, code: 0 }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(new CookieAdsProvider().syncReadOnly({
      accountId: "test-account",
      timezone: "Asia/Taipei",
      settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [{
          target: "ad-group",
          url: "https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=123456",
          method: "POST",
          body: "{}",
          contentType: "application/json",
        }],
      },
    })).resolves.toMatchObject({ result: { counts: { "ad-group": 0 } } });

    expect(fetchMock).toHaveBeenCalled();
  });

  it("recognizes TikTok table rows and derives campaigns from the ad-group response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        const table = url.includes("adgroup/list")
          ? [
              {
                campaign_id: "campaign-test",
                campaign_name: "测试",
                campaign_primary_status: "disable",
                ad_id: "adgroup-test",
                ad_name: "Ad group test",
                ad_primary_status: "disable",
              },
            ]
          : [];
        return new Response(
          JSON.stringify({ data: { table }, code: 0, msg: "OK" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const provider = new CookieAdsProvider();
    const output = await provider.syncReadOnly({
      accountId: "test-account",
      settings: {
        kind: "cookie",
        advertiserId: "123456",
        healthUrl: "",
        campaignsUrl: "",
        adGroupsUrl: "",
        adsUrl: "",
      },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [
          {
            target: "campaign",
            url: "https://ads.tiktok.com/api/v4/i18n/statistics/op/campaign/list/?aadvid=123456",
            method: "POST",
            body: '{"start_date":"2026-07-01","end_date":"2026-07-07"}',
            contentType: "application/json",
          },
          {
            target: "ad-group",
            url: "https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=123456",
            method: "POST",
            body: '{"start_date":"2026-07-01","end_date":"2026-07-07"}',
            contentType: "application/json",
          },
        ],
      },
    });

    expect(output.result.counts).toEqual({
      campaign: 1,
      "ad-group": 1,
      ad: 0,
    });
    expect(output.result.warnings).not.toContain(
      "campaign 响应成功，但暂未识别到列表数据。",
    );
    expect(output.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "campaign",
          externalId: "campaign-test",
        }),
        expect.objectContaining({
          entityType: "ad-group",
          externalId: "adgroup-test",
        }),
      ]),
    );
  });

  it("derives the final-ad read request from the only imported adgroup-list cURL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        const table = url.includes("ad/list")
          ? [
              {
                creative_id: "creative-test",
                creative_name: "Final ad test",
                creative_primary_status: "disable",
              },
            ]
          : [];
        return new Response(JSON.stringify({ data: { table }, code: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const provider = new CookieAdsProvider();
    const output = await provider.syncReadOnly({
      accountId: "test-account",
      settings: {
        kind: "cookie",
        advertiserId: "123456",
        healthUrl: "",
        campaignsUrl: "",
        adGroupsUrl: "",
        adsUrl: "",
      },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [
          {
            target: "ad-group",
            url: "https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=123456",
            method: "POST",
            body: '{"start_date":"2026-07-01","end_date":"2026-07-07"}',
            contentType: "application/json",
          },
        ],
      },
    });

    expect(output.result.counts.ad).toBe(1);
    expect(output.entities).toContainEqual(
      expect.objectContaining({
        entityType: "ad",
        externalId: "creative-test",
      }),
    );
  });

  it("replays an encrypted status template with the target entity id", async () => {
    let requestBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ code: 0, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const provider = new CookieAdsProvider();
    const result = await provider.changeStatus(
      {
        accountId: "test-account",
        settings: {
          kind: "cookie",
          advertiserId: "123456",
          healthUrl: "",
          campaignsUrl: "",
          adGroupsUrl: "",
          adsUrl: "",
        },
        credential: {
          kind: "cookie",
          cookie: "sessionid=test-cookie",
          csrfHeaderName: "x-csrftoken",
          requestTemplates: [
            {
              target: "ad-group-status",
              action: "disable",
              url: "https://ads.tiktok.com/api/v4/i18n/adgroup/status/update/?aadvid=123456",
              method: "POST",
              body: '{"ad_id":"old-id","status":0}',
              contentType: "application/json",
            },
          ],
        },
      },
      [{ entityType: "ad-group", externalId: "new-id", action: "disable" }],
    );

    expect(result[0]).toMatchObject({ ok: true, externalId: "new-id" });
    expect(JSON.parse(requestBody)).toMatchObject({
      ad_id: "new-id",
      status: 0,
    });
  });

  it("replays an overture ad template as an ad-group request", async () => {
    let requestBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ code: 0, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const body = [
      "------TestBoundary\r\n",
      'Content-Disposition: form-data; name="ad_list"\r\n\r\n',
      '["old-id"]\r\n',
      "------TestBoundary\r\n",
      'Content-Disposition: form-data; name="operation"\r\n\r\n',
      "enable\r\n",
      "------TestBoundary--\r\n",
    ].join("");

    const provider = new CookieAdsProvider();
    const result = await provider.changeStatus(
      {
        accountId: "test-account",
        settings: {
          kind: "cookie",
          advertiserId: "123456",
          healthUrl: "",
          campaignsUrl: "",
          adGroupsUrl: "",
          adsUrl: "",
        },
        credential: {
          kind: "cookie",
          cookie: "sessionid=test-cookie",
          csrfHeaderName: "x-csrftoken",
          requestTemplates: [
            {
              target: "ad-group-status",
              action: "enable",
              url: "https://ads.tiktok.com/api/v3/i18n/overture/ad/update_status/?aadvid=123456",
              method: "POST",
              body,
              contentType: "multipart/form-data; boundary=----TestBoundary",
            },
          ],
        },
      },
      [{ entityType: "ad-group", externalId: "new-id", action: "enable" }],
    );

    expect(result[0]).toMatchObject({ ok: true, externalId: "new-id" });
    expect(requestBody).toContain('name="ad_list"\r\n\r\n["new-id"]');
    expect(requestBody).toContain('name="operation"\r\n\r\nenable');
  });

  it("replaces both confirmed final-ad creative id lists", async () => {
    let requestBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ code: 0, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const body = [
      "------CreativeBoundary\r\n",
      'Content-Disposition: form-data; name="creative_list"\r\n\r\n',
      '["old-id"]\r\n',
      "------CreativeBoundary\r\n",
      'Content-Disposition: form-data; name="aco_creative_list"\r\n\r\n',
      '["old-id"]\r\n',
      "------CreativeBoundary\r\n",
      'Content-Disposition: form-data; name="operation"\r\n\r\n',
      "disable\r\n",
      "------CreativeBoundary--\r\n",
    ].join("");

    const provider = new CookieAdsProvider();
    const result = await provider.changeStatus(
      {
        accountId: "test-account",
        settings: {
          kind: "cookie",
          advertiserId: "123456",
          healthUrl: "",
          campaignsUrl: "",
          adGroupsUrl: "",
          adsUrl: "",
        },
        credential: {
          kind: "cookie",
          cookie: "sessionid=test-cookie",
          csrfHeaderName: "x-csrftoken",
          requestTemplates: [
            {
              target: "ad-status",
              action: "disable",
              url: "https://ads.tiktok.com/api/v2/i18n/overture/creative/update_status/?aadvid=123456",
              method: "POST",
              body,
              contentType:
                "multipart/form-data; boundary=----CreativeBoundary",
            },
          ],
        },
      },
      [{ entityType: "ad", externalId: "new-id", action: "disable" }],
    );

    expect(result[0]).toMatchObject({ ok: true, externalId: "new-id" });
    expect(requestBody).toContain('name="creative_list"\r\n\r\n["new-id"]');
    expect(requestBody).toContain(
      'name="aco_creative_list"\r\n\r\n["new-id"]',
    );
  });

  it("runs the checked draft-to-publish chain from the imported list-session request", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const body = url.includes("campaign_snap/save")
        ? { data: { campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" }, code: 0 }
        : url.includes("ad_snap/save")
          ? { data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" }, code: 0 }
          : url.includes("creative_snap/save")
            ? { data: { creative_snap_id: "creative-snap", creative_sketch_id: "creative-sketch" }, code: 0 }
            : { data: { campaign_id: "campaign", adgroup_id: "adgroup", creative_id: "creative" }, code: 0 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const result = await new CookieAdsProvider().createFromPreset!({
      accountId: "test-account", settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: { kind: "cookie", cookie: "sessionid=test-cookie", csrfHeaderName: "x-csrftoken", requestTemplates: [{ target: "ad-group", url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=123456&msToken=session", method: "POST", body: "{}", contentType: "application/json" }] },
    }, [{
      row: { rowNumber: 2, campaignName: "测试系列", adGroupName: "测试广告组", adName: "260716:001", videoCode: "video", productUrl: "https://example.com", region: "US", dailyBudget: 100, bid: null, startAt: null, endAt: null, initialStatus: "enabled" },
      preset: { objectiveType: 1, buyingType: 1, campaignBudgetMode: 0, adBudgetMode: 0, pricing: 1, optimizeGoal: 1, externalAction: 1, pixelId: null, identityType: 1, identityId: "identity", callToActionId: "SHOP_NOW", countryCodes: [840], placementIds: [1], smartTargeting: true, commentDisabled: false, shareDisabled: false },
      initialStatus: "enabled",
    }]);

    expect(result[0]).toMatchObject({ ok: true, campaignId: "campaign", adGroupId: "adgroup", adId: "creative" });
    expect(requested.map((item) => new URL(item.url).pathname)).toEqual([
      "/api/v4/i18n/creation/campaign_snap/save/",
      "/api/v4/i18n/creation/ad_snap/save/",
      "/api/v4/i18n/creation/creative_snap/save/",
      "/api/v4/i18n/creation/snap/cbo_consistency_check/",
      "/api/v4/i18n/creation/campaign_snap/check/",
      "/api/v4/i18n/creation/ad_creative_snap/check/",
      "/api/v4/i18n/creation/snap/batch_create_cta_id/",
      "/api/v4/i18n/creation/async_creation/create_by_snap/",
    ]);
    expect(requested[7]?.body).toMatchObject({ is_status_disabled: false });
  });

  it("initializes verified-profile draft IDs through TikTok before saving and publishing", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requested.push({ url, body });
      const response = url.includes("adgroup/list")
        ? { data: { table: [{ campaign_id: "source-campaign", campaign_name: "old", campaign_status: "disabled" }] }, code: 0 }
        : url.includes("campaign_snap/copy")
          ? { data: {
              new_campaign_snap_info_item: { campaign_snap_id: "campaign-snap", campaign_snap_form_data: { campaign_name: "copied", campaign_snap_id: "campaign-snap" } },
              new_campaign_sketch_id: "campaign-sketch",
              new_ad_snap_info_item_list: [{ ad_snap_id: "ad-snap", ad_snap_form_data: { ad_name: "copied", budget: "2", image_list: [] } }],
              new_ad_and_creative_snap_info_item_map: { "ad-snap": [{ creative_snap_id: "creative-snap", asset_group_creative_snap_form_data: { creative_name: "copied", external_url: "https://copied.example", image_list: [{ aweme_item_id: "copied-video" }] } }] },
              new_ad_and_creative_sketch_ids_map: { "ad-sketch": ["creative-sketch"] },
            }, code: 0 }
          : url.includes("async_creation/detail")
            ? { data: { status: 1, result: { campaign_id: "campaign", ad_and_creative: { 0: { ad_id: "adgroup", asset_group_result: { 0: { creative_items: [{ id: "creative" }] } } } } } }, code: 0 }
          : url.includes("cbo_consistency_check")
            ? { data: { is_all_success: true }, code: 0 }
          : url.includes("campaign_snap/check")
            ? { data: { success: true, fake_campaign_id: "campaign-sketch" }, code: 0 }
          : url.includes("ad_creative_snap/check")
            ? { data: { creative_success: true }, code: 0 }
          : url.includes("batch_create_cta_id")
            ? { data: { cta_id_map: {} }, code: 0 }
          : url.includes("campaign_snap/save")
        ? { data: { campaign_snap_id: (body.campaign_sketch_form_data as Record<string, unknown>).campaign_snap_id }, code: 0 }
        : url.includes("ad_snap/save")
          ? { data: { ad_snap_id: ((body.ad_sketch_form_data as Record<string, unknown>).ad_snap_id) }, code: 0 }
          : url.includes("creative_snap/save")
            ? { data: {}, code: 0 }
            : { data: { async_request_id: "async" }, code: 0 };
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const result = await new CookieAdsProvider().createFromPreset!({
      accountId: "test-account",
      settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [
          { target: "ad-group", url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=123456&msToken=session", method: "POST", body: "{}", contentType: "application/json" },
          { target: "campaign-status", action: "disable", url: "https://ads.tiktok.com/api/v4/i18n/campaign/update_status/?aadvid=123456", method: "POST", body: '{"campaign_id":"old"}', contentType: "application/json" },
          { target: "ad-group-status", action: "disable", url: "https://ads.tiktok.com/api/v4/i18n/adgroup/update_status/?aadvid=123456", method: "POST", body: '{"adgroup_id":"old"}', contentType: "application/json" },
          { target: "ad-status", action: "disable", url: "https://ads.tiktok.com/api/v4/i18n/ad/update_status/?aadvid=123456", method: "POST", body: '{"creative_id":"old"}', contentType: "application/json" },
        ],
        creationProfile: {
          version: 1,
          verifiedAt: null,
          campaignPayload: { campaign_sketch_form_data: { campaign_name: "old" } },
          adGroupPayload: { campaign_id: "", ad_sketch_form_data: { ad_name: "old", budget: "1" } },
          creativePayload: { asset_group_sketch_form_data_list: [{ creative_name: "old", external_url: "https://old.example", image_list: [{ aweme_item_id: "old-video" }] }] },
          publishPayload: { campaign_id: "", campaign_snap_id: "", campaign_sketch_id: "", ad_and_creative_snap_info_list: [{ ad_id: "", ad_snap_id: "", ad_sketch_id: "", creative_snap_info_list: [{ creative_id: "", creative_snap_id: "", creative_sketch_id: "" }] }] },
        },
      },
    }, [{
      row: { rowNumber: 2, campaignName: "测试系列", adGroupName: "测试广告组", adName: "260716:001", videoCode: "video", productUrl: "https://example.com", region: "US", dailyBudget: 1, bid: null, startAt: null, endAt: null, initialStatus: "disabled" },
      preset: { objectiveType: 1, buyingType: 1, campaignBudgetMode: 0, adBudgetMode: 0, pricing: 1, optimizeGoal: 1, externalAction: 1, pixelId: null, identityType: 1, identityId: "identity", callToActionId: "SHOP_NOW", countryCodes: [840], placementIds: [1], smartTargeting: true, commentDisabled: false, shareDisabled: false },
      initialStatus: "disabled",
    }]);

    expect(result[0]).toMatchObject({ ok: true });
    expect(requested.map((item) => new URL(item.url).pathname)).toEqual([
      "/api/v3/i18n/statistics/op/adgroup/list/",
      "/mi/api/v4/i18n/creation/campaign_snap/copy/",
      "/api/v4/i18n/creation/campaign_snap/save/",
      "/api/v4/i18n/creation/ad_snap/save/",
      "/api/v4/i18n/creation/creative_snap/save/",
      "/api/v4/i18n/creation/snap/cbo_consistency_check/",
      "/api/v4/i18n/creation/campaign_snap/check/",
      "/api/v4/i18n/creation/ad_creative_snap/check/",
      "/api/v4/i18n/creation/snap/batch_create_cta_id/",
      "/api/v4/i18n/creation/async_creation/create_by_snap/",
      "/api/v4/i18n/creation/async_creation/detail/",
    ]);
    const campaignForm = requested[2]?.body.campaign_sketch_form_data as Record<string, string>;
    const adForm = requested[3]?.body.ad_sketch_form_data as Record<string, string>;
    const creativeForm = (requested[4]?.body.asset_group_sketch_form_data_list as Array<Record<string, string>>)[0]!;
    expect(campaignForm).toMatchObject({ campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" });
    expect(adForm).toMatchObject({ ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch", by_ad_sketch_id: "ad-sketch" });
    expect(requested[3]?.body).toMatchObject({ campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" });
    expect(creativeForm).toMatchObject({ creative_snap_id: "creative-snap", creative_sketch_id: "creative-sketch" });
    expect(requested[9]?.body).toMatchObject({ is_status_disabled: true });
    expect(result[0]).toMatchObject({ campaignId: "campaign", adGroupId: "adgroup", adId: "creative" });
  });

  it("publishes every copied ad group when the source campaign contains multiple groups", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requested.push({ url, body });
      const response = url.includes("adgroup/list")
        ? { data: { table: [{ campaign_id: "source-campaign", campaign_name: "source", campaign_status: "disabled" }] }, code: 0 }
        : url.includes("campaign_snap/copy")
          ? { data: {
              new_campaign_snap_info_item: { campaign_snap_id: "campaign-snap", campaign_snap_form_data: { campaign_name: "copied" } },
              new_campaign_sketch_id: "campaign-sketch",
              new_ad_snap_info_item_list: [
                { ad_snap_id: "ad-snap-1", ad_snap_form_data: { ad_name: "group-1" } },
                { ad_snap_id: "ad-snap-2", ad_snap_form_data: { ad_name: "group-2" } },
              ],
              new_ad_and_creative_snap_info_item_map: {
                "ad-snap-1": [{ creative_snap_id: "creative-snap-1", asset_group_creative_snap_form_data: { creative_name: "creative-1", image_list: [{ aweme_item_id: "video-1" }] } }],
                "ad-snap-2": [{ creative_snap_id: "creative-snap-2", asset_group_creative_snap_form_data: { creative_name: "creative-2", image_list: [{ aweme_item_id: "video-2" }] } }],
              },
              new_ad_and_creative_sketch_ids_map: {
                "ad-sketch-1": ["creative-sketch-1"],
                "ad-sketch-2": ["creative-sketch-2"],
              },
            }, code: 0 }
          : url.includes("campaign_snap/save")
            ? { data: { campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" }, code: 0 }
            : url.includes("cbo_consistency_check")
              ? { data: { is_all_success: true }, code: 0 }
              : url.includes("campaign_snap/check")
                ? { data: { success: true, fake_campaign_id: "campaign-sketch" }, code: 0 }
                : url.includes("ad_creative_snap/check")
                  ? { data: { creative_success: true }, code: 0 }
                  : url.includes("batch_create_cta_id")
                    ? { data: { cta_id_map: {} }, code: 0 }
                    : url.includes("async_creation/detail")
                      ? { data: { status: 1, result: { campaign_id: "campaign", ad_and_creative: { 0: { ad_id: "adgroup", asset_group_result: { 0: { creative_items: [{ id: "creative" }] } } } } } }, code: 0 }
                      : { data: { async_request_id: "async" }, code: 0 };
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const result = await new CookieAdsProvider().createFromPreset!({
      accountId: "test-account",
      settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie", cookie: "sessionid=test-cookie", csrfHeaderName: "x-csrftoken",
        requestTemplates: [{ target: "ad-group", url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=123456", method: "POST", body: "{}", contentType: "application/json" }],
      },
    }, [{
      row: { rowNumber: 2, campaignName: "copy-all", adGroupName: "unused", adName: "unused", videoCode: "__COPY_SOURCE__", productUrl: "https://example.com", region: "US", dailyBudget: 1, bid: null, startAt: null, endAt: null, initialStatus: "disabled" },
      preset: { objectiveType: 1, buyingType: 1, campaignBudgetMode: 0, adBudgetMode: 0, pricing: 1, optimizeGoal: 1, externalAction: 1, pixelId: null, identityType: 1, identityId: "identity", callToActionId: "SHOP_NOW", countryCodes: [840], placementIds: [1], smartTargeting: true, commentDisabled: false, shareDisabled: false },
      initialStatus: "disabled",
      sourceCampaignName: "source",
    }]);

    expect(result[0]).toMatchObject({ ok: true, campaignId: "campaign" });
    expect(requested.map((item) => new URL(item.url).pathname)).toEqual([
      "/api/v3/i18n/statistics/op/adgroup/list/",
      "/mi/api/v4/i18n/creation/campaign_snap/copy/",
      "/api/v4/i18n/creation/campaign_snap/save/",
      "/api/v4/i18n/creation/snap/cbo_consistency_check/",
      "/api/v4/i18n/creation/campaign_snap/check/",
      "/api/v4/i18n/creation/ad_creative_snap/check/",
      "/api/v4/i18n/creation/snap/batch_create_cta_id/",
      "/api/v4/i18n/creation/async_creation/create_by_snap/",
      "/api/v4/i18n/creation/async_creation/detail/",
    ]);
    expect(requested[3]?.body).toMatchObject({
      adgroup_snap_ids: ["ad-snap-1", "ad-snap-2"],
      ad_snap_ids: ["ad-snap-1", "ad-snap-2"],
    });
    expect(requested[2]?.body.campaign_sketch_form_data).toMatchObject({
      campaign_name: "copy-all",
      campaign_snap_id: "campaign-snap",
      campaign_sketch_id: "campaign-sketch",
    });
    expect(requested[5]?.body.ad_creative_snap_check_info).toHaveLength(2);
    expect(requested[6]?.body.ad_and_creative_snap_info_list).toHaveLength(2);
    const published = requested[7]?.body.ad_and_creative_snap_info_list as Array<Record<string, unknown>>;
    expect(published).toHaveLength(2);
    expect(published.map((item) => item.ad_snap_id)).toEqual(["ad-snap-1", "ad-snap-2"]);
    expect(requested[7]?.body).toMatchObject({ is_partial_publish: false, is_status_disabled: true });
  });

  it("refuses copy creation when the explicitly requested source campaign is missing", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: { table: [{ campaign_id: "other", campaign_name: "other", campaign_status: "disabled" }] },
      code: 0,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new CookieAdsProvider().createFromPreset!({
      accountId: "test-account",
      settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie", cookie: "sessionid=test-cookie", csrfHeaderName: "x-csrftoken",
        requestTemplates: [{ target: "ad-group", url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=123456", method: "POST", body: "{}", contentType: "application/json" }],
      },
    }, [{
      row: { rowNumber: 2, campaignName: "copy", adGroupName: "unused", adName: "unused", videoCode: "__COPY_SOURCE__", productUrl: "https://example.com", region: "US", dailyBudget: 1, bid: null, startAt: null, endAt: null, initialStatus: "disabled" },
      preset: { objectiveType: 1, buyingType: 1, campaignBudgetMode: 0, adBudgetMode: 0, pricing: 1, optimizeGoal: 1, externalAction: 1, pixelId: null, identityType: 1, identityId: "identity", callToActionId: "SHOP_NOW", countryCodes: [840], placementIds: [1], smartTargeting: true, commentDisabled: false, shareDisabled: false },
      initialStatus: "disabled",
      sourceCampaignName: "missing",
    }]);
    expect(result[0]).toMatchObject({ ok: false });
    expect(result[0]?.message).toContain("未找到指定的源系列");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("redacts token-like values and URLs from provider errors", async () => {
    const secret = "abcdefghijklmnopqrstuvwxyz123456";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: 123,
      msg: `token=${secret} inspect https://ads.tiktok.com/private?token=${secret}`,
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(new CookieAdsProvider().checkHealth({
      accountId: "test-account",
      settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie", cookie: "sessionid=test-cookie", csrfHeaderName: "x-csrftoken",
        requestTemplates: [{ target: "ad-group", url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=123456", method: "POST", body: "{}", contentType: "application/json" }],
      },
    })).rejects.toThrow("敏感值已隐藏");
    await expect(new CookieAdsProvider().checkHealth({
      accountId: "test-account",
      settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie", cookie: "sessionid=test-cookie", csrfHeaderName: "x-csrftoken",
        requestTemplates: [{ target: "ad-group", url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=123456", method: "POST", body: "{}", contentType: "application/json" }],
      },
    })).rejects.not.toThrow(secret);
  });
});
