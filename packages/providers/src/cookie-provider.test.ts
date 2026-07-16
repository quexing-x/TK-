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

  it("runs the four-step draft chain from the imported list-session request", async () => {
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
      "/api/v4/i18n/creation/campaign_snap/save/", "/api/v4/i18n/creation/ad_snap/save/", "/api/v4/i18n/creation/creative_snap/save/", "/api/v4/i18n/creation/async_creation/create_by_snap/",
    ]);
    expect(requested[3]?.body).toMatchObject({ is_status_disabled: false });
  });
});
