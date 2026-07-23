import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieAdsProvider, resolveTemplateCampaignId } from "./cookie-provider.js";
import type { CreationMutation, ProviderContext } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CookieAdsProvider", () => {
  it("replays the imported appeal template with the target ad, creative, and reason", async () => {
    let sentBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ code: 0, data: { appeal_success: true } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }));

    const results = await new CookieAdsProvider().appeal({
      accountId: "test-account",
      timezone: "Asia/Taipei",
      settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [{
          target: "appeal",
          url: "https://ads.tiktok.com/api/v4/i18n/creation/audit/appeal_creative/?aadvid=123456",
          method: "POST",
          body: JSON.stringify({ ad_id: "old-ad", creative_id: "old-creative", appeal_reason: "old", appeal_reason_type: 1, attachment_list: [] }),
          contentType: "application/json",
        }],
      },
    }, [{ externalId: "ad-1", creativeId: "creative-1", reason: "我认为我的视频没有违规。" }]);

    expect(JSON.parse(sentBody)).toMatchObject({
      ad_id: "ad-1",
      creative_id: "creative-1",
      appeal_reason: "我认为我的视频没有违规。",
      appeal_reason_type: 1,
    });
    expect(results).toEqual([expect.objectContaining({ ok: true })]);
  });

  it("overrides a captured range with the account's current local date", async () => {
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

  it("rewrites TikTok st/et and requests the cart metric required by the safety gate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T02:30:00.000Z"));
    let sentBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        code: 0,
        data: { table: [], page_info: { page: 1, total_page: 1 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const output = await new CookieAdsProvider().syncReadOnly({
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
          body: JSON.stringify({ common_req: { st: "2026-07-12", et: "2026-07-19", metrics: ["stat_cost"] } }),
          contentType: "application/json",
        }],
      },
    });

    expect(JSON.parse(sentBody)).toMatchObject({
      common_req: {
        st: "2026-07-19",
        et: "2026-07-19",
        metrics: expect.arrayContaining(["stat_cost", "time_attr_on_web_cart"]),
      },
    });
    expect(output.result.quality.partialFailures).not.toContain("ad-group:coverage-unknown");
  });

  it("recognizes TikTok data.pagination page_count as a complete first page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        code: 0,
        data: { table: [], pagination: { page: 1, page_count: 1, total_count: 0 } },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    ));

    const context = cookieSyncContext();
    const credential = context.credential as Extract<typeof context.credential, { kind: "cookie" }>;
    credential.requestTemplates = credential.requestTemplates?.map((request) => ({
      ...request,
      body: JSON.stringify({ common_req: { page: 1, st: "2026-07-19", et: "2026-07-19" } }),
    }));

    const output = await new CookieAdsProvider().syncReadOnly(context);

    expect(output.result.quality.paginationComplete).toBe(true);
  });

  it("does not rewrite st/et or metrics outside TikTok statistics endpoints", async () => {
    let sentBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        code: 0,
        data: { table: [], pagination: { page: 1, page_count: 1 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const body = { common_req: { st: "2026-07-12", et: "2026-07-19", metrics: ["stat_cost"] } };

    await new CookieAdsProvider().syncReadOnly({
      accountId: "test-account",
      timezone: "Asia/Taipei",
      settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [{
          target: "ad-group",
          url: "https://ads.tiktok.com/api/v4/i18n/creation/campaign/list/?aadvid=123456",
          method: "POST",
          body: JSON.stringify(body),
          contentType: "application/json",
        }],
      },
    });

    expect(JSON.parse(sentBody)).toEqual(body);
  });

  it("treats contradictory has_more false and page_count above one as incomplete", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        code: 0,
        data: {
          table: [],
          has_more: false,
          pagination: { page: 1, page_count: 2, total_count: 101 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    ));

    const output = await new CookieAdsProvider().syncReadOnly(cookieSyncContext());

    expect(output.result.quality.paginationComplete).toBe(false);
  });

  it("loads every Cookie list page before declaring pagination complete", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as { page?: number };
      const page = body.page ?? Number(new URL(url).searchParams.get("page") ?? 1);
      const prefix = url.includes("adgroup/list") ? "g" : url.includes("campaign/list") ? "c" : "a";
      return new Response(JSON.stringify({
        code: 0,
        data: {
          table: [{
            campaign_id: `c${page}`,
            adgroup_id: `g${page}`,
            creative_id: `a${page}`,
            [`${prefix === "g" ? "adgroup" : prefix === "c" ? "campaign" : "ad"}_name`]: `${prefix}${page}`,
            spend: "1",
          }],
          page_info: { page, total_page: 2 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const output = await new CookieAdsProvider().syncReadOnly(cookieSyncContext());

    expect(output.result.quality.paginationComplete).toBe(true);
    expect(output.result.counts).toMatchObject({ campaign: 2, "ad-group": 2, ad: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("marks Cookie response contract drift invalid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, data: { unexpected: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    const output = await new CookieAdsProvider().syncReadOnly(cookieSyncContext());

    expect(output.result.quality).toMatchObject({
      status: "invalid",
      contractValid: false,
    });
  });

  it("does not claim pagination completeness when metadata is absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, data: { table: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    const output = await new CookieAdsProvider().syncReadOnly(cookieSyncContext());

    expect(output.result.quality.paginationComplete).toBe(false);
    expect(output.result.quality.status).toBe("partial");
  });

  it.each([
    {
      label: "URL-encoded",
      contentType: "application/x-www-form-urlencoded",
      body: "page=2&page_size=100",
    },
    {
      label: "multipart",
      contentType: "multipart/form-data; boundary=----PageBoundary",
      body: [
        "------PageBoundary",
        'Content-Disposition: form-data; name="page"',
        "",
        "2",
        "------PageBoundary--",
        "",
      ].join("\r\n"),
    },
  ])("does not accept a captured $label non-first page as complete", async ({ contentType, body }) => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        code: 0,
        data: { table: [], has_more: false, page_info: { page: 1, total_page: 1 } },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));
    const context = cookieSyncContext();
    const credential = context.credential as Extract<typeof context.credential, { kind: "cookie" }>;
    credential.requestTemplates = credential.requestTemplates?.map((request) => ({
      ...request,
      contentType,
      body,
    }));

    const output = await new CookieAdsProvider().syncReadOnly(context);

    expect(output.result.quality.paginationComplete).toBe(false);
    expect(output.result.quality.status).toBe("partial");
  });

  it("treats list rows without stable IDs as contract drift", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        code: 0,
        data: { table: [{ renamed_identifier: "x" }], page_info: { page: 1, total_page: 1 } },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    const output = await new CookieAdsProvider().syncReadOnly(cookieSyncContext());

    expect(output.result.quality).toMatchObject({ status: "invalid", contractValid: false });
  });

  it.each(["", "   ", Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects malformed Cookie stable ID %p",
    async (campaignId) => {
      vi.stubGlobal("fetch", vi.fn(async () =>
        new Response(JSON.stringify({
          code: 0,
          data: { table: [{ campaign_id: campaignId }], page_info: { page: 1, total_page: 1 } },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ));

      const output = await new CookieAdsProvider().syncReadOnly(cookieSyncContext());

      expect(output.result.quality).toMatchObject({ status: "invalid", contractValid: false });
    },
  );

  it("skips an invalid preferred ID and extracts a valid fallback ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        code: 0,
        data: {
          table: [{
            campaign_id: " ",
            adgroup_id: " ",
            creative_id: " ",
            id: "valid-fallback-id",
            spend: "1",
            cpc: "1",
            cost_per_conversion: "1",
            conversion: "1",
            onsite_on_web_cart: "1",
          }],
          page_info: { page: 1, total_page: 1 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    ));

    const output = await new CookieAdsProvider().syncReadOnly(cookieSyncContext());

    expect(output.entities).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: " " }),
    ]));
    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: "valid-fallback-id" }),
    ]));
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

  it("keeps a single imported ad-group cURL fully usable by deriving the other read layers", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const table = url.includes("campaign/list")
        ? [{ campaign_id: "c1", campaign_name: "系列" }]
        : url.includes("adgroup/list")
          ? [{ campaign_id: "c1", adgroup_id: "g1", adgroup_name: "广告组", spend: "1" }]
          : [{ campaign_id: "c1", adgroup_id: "g1", creative_id: "a1", ad_name: "广告", spend: "1" }];
      return new Response(JSON.stringify({
        code: 0,
        data: { table, pagination: { page: 1, page_count: 1 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const output = await new CookieAdsProvider().syncReadOnly({
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
          body: JSON.stringify({ start_date: "2026-07-01", end_date: "2026-07-07" }),
          contentType: "application/json",
        }],
      },
    });

    expect(output.result.quality.status).toBe("healthy");
    expect(output.result.counts).toEqual({ campaign: 1, "ad-group": 1, ad: 1 });
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
    const progress: Array<Parameters<NonNullable<CreationMutation["onProgress"]>>[0]> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const body = url.includes("adgroup/list") || url.includes("campaign/list")
        ? { data: { table: [], pagination: { page: 1, page_count: 1 } }, code: 0 }
        : url.includes("campaign_snap/save")
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
      row: { rowNumber: 2, campaignName: "测试系列", adGroupName: "测试广告组", adName: "260716:001", videoCode: "#authorization-code", productUrl: "https://example.com", region: "US", dailyBudget: 100, bid: null, startAt: null, endAt: null, initialStatus: "enabled" },
      preset: { objectiveType: 1, buyingType: 1, campaignBudgetMode: 0, adBudgetMode: 0, pricing: 1, optimizeGoal: 1, externalAction: 1, pixelId: null, identityType: 1, identityId: "identity", callToActionId: "SHOP_NOW", countryCodes: [840], placementIds: [1], smartTargeting: true, commentDisabled: false, shareDisabled: false, videoPostMappings: [{ advertiserId: "different-account", videoCode: "#authorization-code", postId: "7663403524864167176" }] },
      initialStatus: "enabled",
      templateMode: "none",
      operationId: "operation-1",
      attemptId: "attempt-1",
      correlationId: "correlation-1",
      onProgress: (event) => progress.push(event),
    }]);

    expect(result[0]).toMatchObject({ ok: true, campaignId: "campaign", adGroupId: "adgroup", adId: "creative" });
    expect(requested.map((item) => new URL(item.url).pathname)).toEqual([
      "/api/v3/i18n/statistics/op/adgroup/list/",
      "/api/v3/i18n/statistics/op/campaign/list/",
      "/api/v4/i18n/creation/campaign_snap/save/",
      "/api/v4/i18n/creation/ad_snap/save/",
      "/api/v4/i18n/creation/creative_snap/save/",
      "/api/v4/i18n/creation/snap/cbo_consistency_check/",
      "/api/v4/i18n/creation/campaign_snap/check/",
      "/api/v4/i18n/creation/snap/batch_create_cta_id/",
      "/api/v4/i18n/creation/ad_creative_snap/check/",
      "/api/v4/i18n/creation/async_creation/create_by_snap/",
    ]);
    expect(requested[9]?.body).toMatchObject({ is_status_disabled: false });
    expect(requested[4]?.body).toMatchObject({
      asset_group_sketch_form_data_list: [{ image_list: [{ aweme_item_id: "7663403524864167176" }] }],
    });
    expect(progress).toEqual(expect.arrayContaining([
      { phase: "validation", evidence: {} },
      { phase: "campaign_draft", evidence: expect.objectContaining({ campaignSnapId: "campaign-snap", campaignSketchId: "campaign-sketch" }) },
      { phase: "adgroup_draft", evidence: expect.objectContaining({ adGroupSnapId: "ad-snap", adGroupSketchId: "ad-sketch" }) },
      { phase: "creative_draft", evidence: expect.objectContaining({ creativeSnapId: "creative-snap", creativeSketchId: "creative-sketch" }) },
      { phase: "publishing", evidence: {} },
      { phase: "readback", evidence: {} },
    ]));
  });

  it("creates one ad-group with several ads from a multi-code cell", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    let creativeSaves = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const body = url.includes("adgroup/list") || url.includes("campaign/list")
        ? { data: { table: [], pagination: { page: 1, page_count: 1 } }, code: 0 }
        : url.includes("campaign_snap/save")
        ? { data: { campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" }, code: 0 }
        : url.includes("ad_snap/save")
          ? { data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" }, code: 0 }
          : url.includes("creative_snap/save")
            ? (creativeSaves += 1, { data: { creative_snap_id: `creative-snap-${creativeSaves}`, creative_sketch_id: `creative-sketch-${creativeSaves}` }, code: 0 })
            : { data: { campaign_id: "campaign", adgroup_id: "adgroup", creative_id: "creative" }, code: 0 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const result = await new CookieAdsProvider().createFromPreset!({
      accountId: "test-account", settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: { kind: "cookie", cookie: "sessionid=test-cookie", csrfHeaderName: "x-csrftoken", requestTemplates: [{ target: "ad-group", url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=123456&msToken=session", method: "POST", body: "{}", contentType: "application/json" }] },
    }, [{
      row: { rowNumber: 2, campaignName: "测试系列", adGroupName: "测试广告组", adName: "260716:001", videoCode: "#codeA;#codeB", productUrl: "https://example.com", region: "US", dailyBudget: 100, bid: null, startAt: null, endAt: null, initialStatus: "enabled" },
      preset: { objectiveType: 1, buyingType: 1, campaignBudgetMode: 0, adBudgetMode: 0, pricing: 1, optimizeGoal: 1, externalAction: 1, pixelId: null, identityType: 1, identityId: "identity", callToActionId: "SHOP_NOW", countryCodes: [840], placementIds: [1], smartTargeting: true, commentDisabled: false, shareDisabled: false, videoPostMappings: [{ advertiserId: "x", videoCode: "#codeA", postId: "1111" }, { advertiserId: "x", videoCode: "#codeB", postId: "2222" }] },
      initialStatus: "enabled",
      templateMode: "none",
      operationId: "operation-1",
      attemptId: "attempt-1",
      correlationId: "correlation-1",
    }]);

    expect(result[0]).toMatchObject({ ok: true, campaignId: "campaign" });
    // One ad-group, several ads = ONE creative whose image_list carries both
    // videos (not two separate creatives).
    expect(creativeSaves).toBe(1);
    expect(requested.filter((item) => item.url.includes("ad_snap/save"))).toHaveLength(1);
    const creativeBody = requested.find((item) => item.url.includes("creative_snap/save"));
    const asset = (creativeBody?.body.asset_group_sketch_form_data_list as Array<{ image_list: Array<{ aweme_item_id: string }>; title_list: Array<{ aweme_item_id: string }> }>)[0]!;
    expect(asset.image_list.map((image) => image.aweme_item_id)).toEqual(["1111", "2222"]);
    expect(asset.title_list.map((title) => title.aweme_item_id)).toEqual(["1111", "2222"]);
    // One ad_snap with one creative_snap in the publish; the two ads come from
    // the two videos inside that creative's image_list.
    const publish = requested.find((item) => item.url.includes("create_by_snap"));
    const adInfo = (publish?.body.ad_and_creative_snap_info_list as Array<{ ad_snap_id: string; creative_snap_info_list: Array<{ creative_snap_id: string }> }>);
    expect(adInfo).toHaveLength(1);
    expect(adInfo[0]!.creative_snap_info_list.map((c) => c.creative_snap_id)).toEqual(["creative-snap-1"]);
  });

  it("classifies a dispatched status request network loss as unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("socket closed");
    }));

    const result = await new CookieAdsProvider().changeStatus(
      statusTestContext(),
      [{ entityType: "ad-group", externalId: "new-id", action: "disable" }],
    );

    expect(result[0]).toMatchObject({ ok: false, failureKind: "unknown" });
  });

  it("classifies a structured TikTok status rejection as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: 40100, msg: "rejected" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    const result = await new CookieAdsProvider().changeStatus(
      statusTestContext(),
      [{ entityType: "ad-group", externalId: "new-id", action: "disable" }],
    );

    expect(result[0]).toMatchObject({ ok: false, failureKind: "retryable" });
  });

  it("classifies local status credential validation before dispatch as retryable", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const context = statusTestContext();
    context.credential = { kind: "cookie", cookie: "" } as typeof context.credential;

    const result = await new CookieAdsProvider().changeStatus(
      context,
      [{ entityType: "ad-group", externalId: "new-id", action: "disable" }],
    );

    expect(result[0]).toMatchObject({ ok: false, failureKind: "retryable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses a verified profile without copying when templateMode is none", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requested.push({ url, body });
      const response = url.includes("adgroup/list") || url.includes("campaign/list")
        ? { data: { table: [{ campaign_id: "source-campaign", campaign_name: "old", campaign_status: "disabled" }], pagination: { page: 1, page_count: 1 } }, code: 0 }
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
        ? { data: { campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" }, code: 0 }
        : url.includes("ad_snap/save")
          ? { data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" }, code: 0 }
          : url.includes("creative_snap/save")
            ? { data: { creative_snap_id: "creative-snap", creative_sketch_id: "creative-sketch" }, code: 0 }
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
      templateMode: "none",
    }]);

    expect(result[0]).toMatchObject({ ok: true });
    expect(requested.map((item) => new URL(item.url).pathname)).toEqual([
      "/api/v3/i18n/statistics/op/adgroup/list/",
      "/api/v3/i18n/statistics/op/campaign/list/",
      "/api/v4/i18n/creation/campaign_snap/save/",
      "/api/v4/i18n/creation/ad_snap/save/",
      "/api/v4/i18n/creation/creative_snap/save/",
      "/api/v4/i18n/creation/snap/cbo_consistency_check/",
      "/api/v4/i18n/creation/campaign_snap/check/",
      "/api/v4/i18n/creation/snap/batch_create_cta_id/",
      "/api/v4/i18n/creation/ad_creative_snap/check/",
      "/api/v4/i18n/creation/async_creation/create_by_snap/",
      "/api/v4/i18n/creation/async_creation/detail/",
    ]);
    expect(requested[3]?.body).toMatchObject({ campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" });
    expect(requested[9]?.body).toMatchObject({ is_status_disabled: true });
    expect(result[0]).toMatchObject({ campaignId: "campaign", adGroupId: "adgroup", adId: "creative" });
  });

  it("blocks a code the material library cannot resolve, before any creation request", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      // The library returns no entry for the unknown code.
      const body = url.includes("material/tt_video/bulk/info")
        ? { data: { tt_video_map: {} }, code: 0 }
        : { data: {}, code: 0 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const mutation = creationTestMutation("none");
    mutation.row.videoCode = "#unmapped-code";

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result).toMatchObject({ ok: false, failureKind: "retryable" });
    // The only network call is the library lookup — no creation was dispatched.
    expect(requested.some((url) => url.includes("material/tt_video/bulk/info"))).toBe(true);
    expect(requested.some((url) => url.includes("campaign_snap/save"))).toBe(false);
  });

  it("auto-resolves a #code from the material library and creates without a manual mapping", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const body = url.includes("material/tt_video/bulk/info")
        ? { data: { tt_video_map: { "#lib-code": { item_id: "9998887776665" } } }, code: 0 }
        : url.includes("adgroup/list") || url.includes("campaign/list")
        ? { data: { table: [], pagination: { page: 1, page_count: 1 } }, code: 0 }
        : url.includes("campaign_snap/save")
        ? { data: { campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" }, code: 0 }
        : url.includes("ad_snap/save")
          ? { data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" }, code: 0 }
          : url.includes("creative_snap/save")
            ? { data: { creative_snap_id: "creative-snap", creative_sketch_id: "creative-sketch" }, code: 0 }
            : { data: { campaign_id: "campaign", adgroup_id: "adgroup", creative_id: "creative" }, code: 0 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const mutation = creationTestMutation("none");
    mutation.row.videoCode = "#lib-code";
    mutation.preset.videoPostMappings = [];

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result).toMatchObject({ ok: true });
    // The library-resolved item_id is what lands in the creative's aweme_item_id.
    const creativeSave = requested.find((item) => item.url.includes("creative_snap/save"));
    expect((creativeSave?.body.asset_group_sketch_form_data_list as Array<{ image_list: Array<{ aweme_item_id: string }> }>)[0]!.image_list[0]!.aweme_item_id).toBe("9998887776665");
  });

  it("reuses the unique exact-name campaign instead of creating another campaign", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    const progress: Array<Parameters<NonNullable<CreationMutation["onProgress"]>>[0]> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (url.includes("adgroup/list")) {
        return jsonResponse({ code: 0, data: { table: [
          { campaign_id: "source-campaign", campaign_name: "source", campaign_status: "enabled", adgroup_id: "existing-group", adgroup_name: "group" },
          { campaign_id: "source-campaign", campaign_name: "source", campaign_status: "enabled", adgroup_id: "existing-group-001", adgroup_name: "group-001" },
        ], pagination: { page: 1, page_count: 1 } } });
      }
      return jsonResponse(successfulCreationPayload(url));
    }));
    const mutation = creationTestMutation("none");
    mutation.row.campaignName = "source";
    mutation.onProgress = (event) => progress.push(event);

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result).toMatchObject({ ok: true });
    const bodyFor = (fragment: string) => requested.find((item) => item.url.includes(fragment))?.body;
    expect(bodyFor("campaign_snap/save")).toBeUndefined();
    expect(bodyFor("ad_snap/save")).toMatchObject({ campaign_id: "source-campaign" });
    expect(bodyFor("ad_snap/save")).toMatchObject({ campaign_snap_id: "", campaign_sketch_id: "" });
    expect(bodyFor("ad_snap/save")?.ad_sketch_form_data).toMatchObject({
      origin_ad_id: 0,
      ad_name: "group-002",
      ad_snap_id: "ad-snap",
      ad_sketch_id: "ad-sketch",
    });
    const creativeBody = bodyFor("creative_snap/save")?.asset_group_sketch_form_data_list as Array<Record<string, unknown>>;
    expect(creativeBody[0]).toMatchObject({
      origin_creative_id: 0,
      creative_snap_id: "creative-snap",
      creative_sketch_id: "creative-sketch",
    });
    expect(bodyFor("create_by_snap")).toMatchObject({ campaign_id: "source-campaign" });
    expect(progress).toContainEqual({
      phase: "validation",
      evidence: { resolvedAdGroupName: "group-002" },
    });
  });

  it("checks every campaign and ad-group page before reusing and auto-naming", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      if (url.includes("campaign/list")) {
        return jsonResponse({ code: 0, data: {
          table: page === 1
            ? [{ campaign_id: "other", campaign_name: "other", campaign_status: "disabled" }]
            : [{ campaign_id: "source-campaign", campaign_name: "source", campaign_status: "disabled" }],
          pagination: { page, page_count: 2 },
        } });
      }
      if (url.includes("adgroup/list")) {
        return jsonResponse({ code: 0, data: {
          table: [{
            campaign_id: "source-campaign",
            campaign_name: "source",
            campaign_status: "disabled",
            adgroup_id: `group-${page}`,
            adgroup_name: page === 1 ? "group" : "group-001",
          }],
          pagination: { page, page_count: 2 },
        } });
      }
      return jsonResponse(successfulCreationPayload(url));
    }));
    const mutation = creationTestMutation("none");
    mutation.row.campaignName = "source";

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result).toMatchObject({ ok: true });
    const adSave = requested.find((item) => item.url.includes("ad_snap/save"));
    expect(adSave?.body).toMatchObject({ campaign_id: "source-campaign" });
    expect(adSave?.body.ad_sketch_form_data).toMatchObject({ ad_name: "group-002" });
    expect(requested.filter((item) => item.url.includes("/campaign/list/")).length).toBe(2);
    expect(requested.filter((item) => item.url.includes("/adgroup/list/")).length).toBe(2);
  });

  it("blocks creation when list pagination completeness cannot be proven", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 0, data: { table: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [creationTestMutation("none")],
    );

    expect(result).toMatchObject({ ok: false, failureKind: "retryable" });
    expect(result?.message).toContain("分页结束信息");
  });

  it("reserves campaign and ad-group names across rows in one batch", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (url.includes("campaign/list") || url.includes("adgroup/list")) {
        return jsonResponse({ code: 0, data: { table: [], pagination: { page: 1, page_count: 1 } } });
      }
      return jsonResponse(successfulCreationPayload(url));
    }));
    const first = creationTestMutation("none");
    const second = creationTestMutation("none");
    first.batchId = "plan-1";
    second.batchId = "plan-1";
    second.row.adName = "260717:002";
    const provider = new CookieAdsProvider();

    const [firstResults, secondResults] = await Promise.all([
      provider.createFromPreset!(creationTestContext(false), [first]),
      provider.createFromPreset!(creationTestContext(false), [second]),
    ]);
    const results = [...firstResults, ...secondResults];

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(requested.filter((item) => item.url.includes("campaign_snap/save"))).toHaveLength(1);
    const adNames = requested
      .filter((item) => item.url.includes("ad_snap/save"))
      .map((item) => (item.body.ad_sketch_form_data as Record<string, unknown>).ad_name);
    expect(adNames).toEqual(["group", "group-001"]);
  });

  it("stops later same-campaign calls after an unknown result in the same plan", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("campaign/list") || url.includes("adgroup/list")) {
        return jsonResponse({ code: 0, data: { table: [], pagination: { page: 1, page_count: 1 } } });
      }
      if (url.includes("campaign_snap/save")) throw new TypeError("connection lost");
      return jsonResponse(successfulCreationPayload(url));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CookieAdsProvider();
    const first = creationTestMutation("none");
    const second = creationTestMutation("none");
    first.batchId = "plan-unknown";
    second.batchId = "plan-unknown";

    const [unknown] = await provider.createFromPreset!(creationTestContext(false), [first]);
    const callsAfterUnknown = fetchMock.mock.calls.length;
    const [blocked] = await provider.createFromPreset!(creationTestContext(false), [second]);

    expect(unknown).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(blocked).toMatchObject({ ok: false, failureKind: "retryable" });
    expect(blocked?.message).toContain("前一条同系列任务结果未知");
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterUnknown);
  });

  it("bootstraps a zero-create draft from a stable campaign template when no verified profile exists", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requested.push({ url, body });
      const payload = url.includes("campaign_snap/copy")
        ? { code: 0, data: {
            new_campaign_snap_info_item: {
              campaign_snap_id: "campaign-snap",
              campaign_snap_form_data: {
                campaign_name: "source",
                objective_type: 999,
                industry_audit_form_data: { industry_type: 42 },
              },
            },
            new_campaign_sketch_id: "campaign-sketch",
            new_ad_snap_info_item_list: [{
              ad_snap_id: "ad-snap",
                ad_snap_form_data: {
                  ad_name: "source",
                  budget: "1",
                  pricing: 999,
                  creative_material_mode: 999,
                  product_platform_id: "source-catalog",
                  product_set_id: "source-product-set",
                  catalog_authorized_bc: "source-bc",
                  supply_catalog_id: "source-catalog",
                  promotion_catalog_type: 1,
                  product_specific_type: 2,
                },
            }],
            new_ad_and_creative_snap_info_item_map: {
              "ad-snap": [{
                creative_snap_id: "creative-snap",
                asset_group_creative_snap_form_data: {
                  creative_name: "source",
                  identity_type: 999,
                  external_url: "https://old.example",
                  image_list: [{ aweme_item_id: "old-video" }],
                },
              }],
            },
            new_ad_and_creative_sketch_ids_map: { "ad-sketch": ["creative-sketch"] },
          } }
        : successfulCreationPayload(url);
      return jsonResponse(payload);
    }));
    const mutation = creationTestMutation("none");
    mutation.preset = {
      ...mutation.preset,
      templateCampaignId: "source-campaign",
    } as typeof mutation.preset;

    const result = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result[0]).toMatchObject({ ok: true });
    expect(requested.map((item) => new URL(item.url).pathname)[2]).toBe(
      "/mi/api/v4/i18n/creation/campaign_snap/copy/",
    );
    const campaignSave = requested.find((item) => item.url.includes("campaign_snap/save"));
    expect(campaignSave?.body.campaign_sketch_form_data).toMatchObject({
      campaign_name: "campaign",
      objective_type: 1,
      industry_audit_form_data: { industry_type: 42 },
    });
    const adSave = requested.find((item) => item.url.includes("ad_snap/save"));
    expect(adSave?.body.ad_sketch_form_data).toMatchObject({
      ad_name: "group",
      pricing: 1,
      creative_material_mode: 6,
      product_platform_id: "0",
      product_set_id: "",
      catalog_authorized_bc: "0",
      supply_catalog_id: "0",
      promotion_catalog_type: 0,
      product_specific_type: 0,
      budget_auto_adjust: { is_enabled: 0, initial_budget: "0" },
    });
    const creativeSave = requested.find((item) => item.url.includes("creative_snap/save"));
    expect((creativeSave?.body.asset_group_sketch_form_data_list as Array<Record<string, unknown>>)[0]).toMatchObject({
      creative_name: "260717:001",
      identity_type: 1,
    });
  });

  it("falls back to the account's own campaign when the preset template is missing (multi-account)", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return jsonResponse(successfulCreationPayload(url));
    }));
    const mutation = creationTestMutation("none");
    // The preset points at a template campaign that lives in a different account;
    // this account only has "source-campaign" in its list.
    mutation.preset = { ...mutation.preset, templateCampaignId: "campaign-from-another-account" } as typeof mutation.preset;

    const result = await new CookieAdsProvider().createFromPreset!(creationTestContext(false), [mutation]);

    expect(result[0]).toMatchObject({ ok: true });
    // Bootstrap copies this account's own campaign instead of erroring on the
    // missing preset template.
    const copy = requested.find((item) => item.url.includes("campaign_snap/copy"));
    expect(copy?.body).toMatchObject({ campaign_id: "source-campaign" });
  });

  it("publishes every copied ad group when the source campaign contains multiple groups", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requested.push({ url, body });
      const response = url.includes("adgroup/list")
        ? { data: { table: [
            { campaign_id: "wrong-same-name", campaign_name: "source", campaign_status: "disabled" },
            { campaign_id: "source-campaign", campaign_name: "source", campaign_status: "disabled" },
          ], pagination: { page: 1, page_count: 1 } }, code: 0 }
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
      templateMode: "copy",
      templateCampaignId: "source-campaign",
    }]);

    expect(result[0]).toMatchObject({ ok: true, campaignId: "campaign" });
    expect(requested[1]?.body).toMatchObject({ campaign_id: "source-campaign" });
    expect(requested.map((item) => new URL(item.url).pathname)).toEqual([
      "/api/v3/i18n/statistics/op/adgroup/list/",
      "/mi/api/v4/i18n/creation/campaign_snap/copy/",
      "/api/v4/i18n/creation/campaign_snap/save/",
      "/api/v4/i18n/creation/snap/cbo_consistency_check/",
      "/api/v4/i18n/creation/campaign_snap/check/",
      "/api/v4/i18n/creation/snap/batch_create_cta_id/",
      "/api/v4/i18n/creation/ad_creative_snap/check/",
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
    expect(requested[5]?.body.ad_and_creative_snap_info_list).toHaveLength(2);
    expect(requested[6]?.body.ad_creative_snap_check_info).toHaveLength(2);
    const published = requested[7]?.body.ad_and_creative_snap_info_list as Array<Record<string, unknown>>;
    expect(published).toHaveLength(2);
    expect(published.map((item) => item.ad_snap_id)).toEqual(["ad-snap-1", "ad-snap-2"]);
    expect(requested[7]?.body).toMatchObject({ is_partial_publish: false, is_status_disabled: true });
  });

  it("refuses copy creation when the explicitly requested source campaign is missing", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: { table: [{ campaign_id: "other", campaign_name: "other", campaign_status: "disabled" }], pagination: { page: 1, page_count: 1 } },
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
      templateMode: "copy",
      templateCampaignId: "missing",
    }]);
    expect(result[0]).toMatchObject({ ok: false });
    expect(result[0]?.message).toContain("未找到模板系列 ID");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects copy mode without templateCampaignId before any provider request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const [result] = await new CookieAdsProvider().createFromPreset!({
      accountId: "test-account",
      settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie", cookie: "sessionid=test-cookie", csrfHeaderName: "x-csrftoken",
        requestTemplates: [{ target: "ad-group", url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=123456", method: "POST", body: "{}", contentType: "application/json" }],
      },
    }, [{
      row: { rowNumber: 2, campaignName: "copy", adGroupName: "unused", adName: "unused", videoCode: "video", productUrl: "https://example.com", region: "US", dailyBudget: 1, bid: null, startAt: null, endAt: null, initialStatus: "disabled" },
      preset: { objectiveType: 1, buyingType: 1, campaignBudgetMode: 0, adBudgetMode: 0, pricing: 1, optimizeGoal: 1, externalAction: 1, pixelId: null, identityType: 1, identityId: "identity", callToActionId: "SHOP_NOW", countryCodes: [840], placementIds: [1], smartTargeting: true, commentDisabled: false, shareDisabled: false },
      initialStatus: "disabled",
      templateMode: "copy",
    }]);
    expect(result).toMatchObject({ ok: false });
    expect(result?.message).toContain("templateCampaignId");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes the legacy creationProfile source field to templateCampaignId", () => {
    expect(resolveTemplateCampaignId({
      kind: "cookie",
      cookie: "sessionid=test-cookie",
      csrfHeaderName: "x-csrftoken",
      creationProfile: {
        version: 1,
        verifiedAt: null,
        campaignPayload: { campaign_sketch_form_data: { origin_campaign_id: "template-42", campaign_name: "not-an-identifier" } },
        adGroupPayload: {},
        creativePayload: {},
        publishPayload: {},
      },
    })).toBe("template-42");
  });

  it.each([
    ["transport failure after dispatch", "unknown"],
    ["explicit provider rejection", "retryable"],
    ["polling API structured rejection after acceptance", "unknown"],
    ["confirmed asynchronous rejection", "retryable"],
    ["completed response with failed creative", "retryable"],
    ["completed response with partial success", "unknown"],
  ] as const)("classifies %s without guessing the creation outcome", async (scenario, expected) => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("create_by_snap")) {
        if (scenario === "transport failure after dispatch") throw new TypeError("connection reset");
        const payload = scenario === "explicit provider rejection"
          ? { code: 40001, msg: "budget rejected" }
          : { code: 0, data: { async_request_id: "async" } };
        return new Response(JSON.stringify(payload), {
          status: scenario === "explicit provider rejection" ? 422 : 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("async_creation/detail")) {
        const payload = scenario === "polling API structured rejection after acceptance"
          ? { code: 50001, msg: "detail temporarily unavailable" }
          : scenario === "completed response with failed creative"
            ? { code: 0, data: { status: 1, result: { operation: 5, ad_and_creative: { 0: { asset_group_result: { 0: { is_success: false, creative_items: [{ is_success: false, snap_create_source: 1 }] } } } } } } }
          : scenario === "completed response with partial success"
            ? { code: 0, data: { status: 1, result: { ad_and_creative: {
                0: { asset_group_result: { 0: { is_success: false, creative_items: [{ is_success: false }] } } },
                1: { ad_id: "created-adgroup", asset_group_result: { 0: { creative_items: [{ id: "created-creative" }] } } },
              } } } }
          : { code: 0, data: { status: -1 } };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const data = url.includes("adgroup/list") || url.includes("campaign/list")
        ? { table: [], pagination: { page: 1, page_count: 1 } }
        : url.includes("campaign_snap/save")
        ? { campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" }
        : url.includes("ad_snap/save")
          ? { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" }
          : url.includes("creative_snap/save")
            ? { creative_snap_id: "creative-snap", creative_sketch_id: "creative-sketch" }
            : {};
      return new Response(JSON.stringify({ code: 0, data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const [result] = await new CookieAdsProvider().createFromPreset!({
      accountId: "test-account",
      settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie", cookie: "sessionid=test-cookie", csrfHeaderName: "x-csrftoken",
        requestTemplates: [{ target: "ad-group", url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=123456", method: "POST", body: "{}", contentType: "application/json" }],
      },
    }, [{
      row: { rowNumber: 2, campaignName: "campaign", adGroupName: "group", adName: "260717:001", videoCode: "video", productUrl: "https://example.com", region: "US", dailyBudget: 1, bid: null, startAt: null, endAt: null, initialStatus: "disabled" },
      preset: { objectiveType: 1, buyingType: 1, campaignBudgetMode: 0, adBudgetMode: 0, pricing: 1, optimizeGoal: 1, externalAction: 1, pixelId: null, identityType: 1, identityId: "identity", callToActionId: "SHOP_NOW", countryCodes: [840], placementIds: [1], smartTargeting: true, commentDisabled: false, shareDisabled: false },
      initialStatus: "disabled",
      templateMode: "none",
    }]);
    expect(result).toMatchObject({ ok: false, failureKind: expected });
  });

  it("treats a failed ad under a reused campaign as confirmed failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("adgroup/list") || url.includes("campaign/list")) {
        return jsonResponse({ code: 0, data: { table: [
          { campaign_id: "existing-campaign", campaign_name: "campaign", campaign_status: "enabled" },
        ], pagination: { page: 1, page_count: 1 } } });
      }
      if (url.includes("async_creation/detail")) {
        return jsonResponse({ code: 0, data: { status: 1, result: {
          campaign_id: "existing-campaign",
          ad_and_creative: { 0: {
            ad_error_items: [{ message: "duplicate ad group" }],
            asset_group_result: { 0: { is_success: false, creative_items: [{ is_success: false }] } },
          } },
        } } });
      }
      return jsonResponse(successfulCreationPayload(url));
    }));

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [creationTestMutation("none")],
    );

    expect(result).toMatchObject({ ok: false, failureKind: "retryable" });
  });

  it.each([
    ["campaign_snap/save", "campaign_snap/save", "none"],
    ["ad_snap/save", "ad_snap/save", "none"],
    ["creative_snap/save", "creative_snap/save", "none"],
    ["campaign_snap/copy", "campaign_snap/copy", "copy"],
    ["create_by_snap", "create_by_snap", "none"],
    ["async_creation/detail", "async_creation/detail", "none"],
  ] as const)("marks %s transport loss after dispatch as unknown", async (_label, fragment, mode) => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(fragment)) throw new TypeError("connection reset after dispatch");
      return jsonResponse(successfulCreationPayload(url));
    }));

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(mode === "copy"),
      [creationTestMutation(mode)],
    );

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
  });

  it.each([
    ["campaign_snap/save", "campaign_snap/save", "none"],
    ["ad_snap/save", "ad_snap/save", "none"],
    ["creative_snap/save", "creative_snap/save", "none"],
    ["campaign_snap/copy", "campaign_snap/copy", "copy"],
    ["create_by_snap", "create_by_snap", "none"],
    ["async_creation/detail", "async_creation/detail", "none"],
  ] as const)("marks %s JSON parse failure after dispatch as unknown", async (_label, fragment, mode) => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(fragment)) {
        return new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } });
      }
      return jsonResponse(successfulCreationPayload(url));
    }));

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(mode === "copy"),
      [creationTestMutation(mode)],
    );

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
  });

  it("keeps local validation and structured TikTok rejection retryable", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("campaign_snap/save")) {
        return jsonResponse({ code: 40001, msg: "budget rejected" });
      }
      return jsonResponse(successfulCreationPayload(url));
    });
    vi.stubGlobal("fetch", fetchMock);

    const invalidCopyMutation = creationTestMutation("copy");
    delete invalidCopyMutation.templateCampaignId;
    const [localFailure] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(true),
      [invalidCopyMutation],
    );
    expect(localFailure).toMatchObject({ ok: false, failureKind: "retryable" });
    expect(fetchMock).not.toHaveBeenCalled();

    const [providerRejection] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [creationTestMutation("none")],
    );
    expect(providerRejection).toMatchObject({ ok: false, failureKind: "retryable" });
  });

  it("marks a local payload-processing error after a draft save as unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      jsonResponse(successfulCreationPayload(String(input))),
    ));
    const context = creationTestContext(true);
    if (context.credential.kind !== "cookie" || !context.credential.creationProfile) {
      throw new Error("test fixture must include a creation profile");
    }
    context.credential.creationProfile.publishPayload = {};

    const [result] = await new CookieAdsProvider().createFromPreset!(
      context,
      [creationTestMutation("none")],
    );

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(result?.message).toContain("不会自动重试");
  });

  it("persists the campaign snap evidence before a missing sketch id becomes unknown", async () => {
    const progress: Array<Parameters<NonNullable<CreationMutation["onProgress"]>>[0]> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("campaign_snap/save")) {
        return jsonResponse({ code: 0, data: { campaign_snap_id: "partial-campaign-snap" } });
      }
      return jsonResponse(successfulCreationPayload(url));
    });
    vi.stubGlobal("fetch", fetchMock);
    const mutation = creationTestMutation("none");
    mutation.onProgress = (event) => progress.push(event);

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(progress).toContainEqual({
      phase: "campaign_draft",
      evidence: { campaignSnapId: "partial-campaign-snap" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects a copy-derived creation profile in none mode before dispatch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const context = creationTestContext(true);
    if (context.credential.kind !== "cookie" || !context.credential.creationProfile) {
      throw new Error("test fixture must include a creation profile");
    }
    context.credential.creationProfile.campaignPayload = {
      campaign_sketch_form_data: {
        campaign_name: "copied source",
        origin_campaign_id: "source-campaign",
        campaign_snap_id: "copied-snap",
        campaign_sketch_id: "copied-sketch",
      },
    };

    const [result] = await new CookieAdsProvider().createFromPreset!(
      context,
      [creationTestMutation("none")],
    );

    expect(result).toMatchObject({ ok: false, failureKind: "retryable" });
    expect(result?.message).toContain("copy");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["transport", "parse"] as const)(
    "keeps copy preflight adgroup/list %s failure retryable before any write dispatch",
    async (failure) => {
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("adgroup/list")) {
          if (failure === "transport") throw new TypeError("preflight connection reset");
          return new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } });
        }
        return jsonResponse(successfulCreationPayload(url));
      }));

      const [result] = await new CookieAdsProvider().createFromPreset!(
        creationTestContext(true),
        [creationTestMutation("copy")],
      );

      expect(result).toMatchObject({ ok: false, failureKind: "retryable" });
    },
  );

  it.each(["transport", "parse", "structure"] as const)(
    "keeps new-creation preflight adgroup/list %s failure retryable before any write dispatch",
    async (failure) => {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (failure === "transport") throw new TypeError("preflight connection reset");
        return failure === "parse"
          ? new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } })
          : jsonResponse({ code: 0 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const [result] = await new CookieAdsProvider().createFromPreset!(
        creationTestContext(false),
        [creationTestMutation("none")],
      );

      expect(result).toMatchObject({ ok: false, failureKind: "retryable" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

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

  it("derives account capabilities from the captured Cookie templates", () => {
    const capabilities = new CookieAdsProvider().resolveCapabilities(
      creationTestContext(false),
    );

    expect(capabilities.has("read-campaigns")).toBe(true);
    expect(capabilities.has("create-campaigns")).toBe(true);
    expect(capabilities.has("copy-ads")).toBe(true);
    expect(capabilities.has("change-status")).toBe(false);
  });
});

function cookieSyncContext(): ProviderContext {
  const requestTemplates = (["campaign", "ad-group", "ad"] as const).map((target) => ({
    target,
    url: `https://ads.tiktok.com/api/v4/i18n/statistics/op/${target === "ad-group" ? "adgroup" : target}/list/?aadvid=123456`,
    method: "POST" as const,
    body: "{}",
    contentType: "application/json",
  }));
  return {
    accountId: "test-account",
    timezone: "Asia/Taipei",
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
      requestTemplates,
    },
  };
}

function statusTestContext(): ProviderContext {
  return {
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
      requestTemplates: [{
        target: "ad-group-status",
        action: "disable",
        url: "https://ads.tiktok.com/api/v4/i18n/adgroup/status/update/?aadvid=123456",
        method: "POST",
        body: '{"ad_id":"old-id","status":0}',
        contentType: "application/json",
      }],
    },
  };
}

function creationTestContext(withProfile: boolean): ProviderContext {
  return {
    accountId: "test-account",
    settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
    credential: {
      kind: "cookie",
      cookie: "sessionid=test-cookie",
      csrfHeaderName: "x-csrftoken",
      requestTemplates: [{ target: "ad-group", url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=123456", method: "POST", body: "{}", contentType: "application/json" }],
      ...(withProfile ? { creationProfile: {
        version: 1 as const,
        verifiedAt: null,
        campaignPayload: { campaign_sketch_form_data: { campaign_name: "source" } },
        adGroupPayload: { campaign_id: "", ad_sketch_form_data: { ad_name: "source", budget: "1" } },
        creativePayload: { asset_group_sketch_form_data_list: [{ creative_name: "source", external_url: "https://example.com", image_list: [{ aweme_item_id: "video" }] }] },
        publishPayload: { campaign_id: "", campaign_snap_id: "", campaign_sketch_id: "", ad_and_creative_snap_info_list: [{ ad_id: "", ad_snap_id: "", ad_sketch_id: "", creative_snap_info_list: [{ creative_id: "", creative_snap_id: "", creative_sketch_id: "" }] }] },
      } } : {}),
    },
  };
}

function creationTestMutation(mode: "none" | "copy"): CreationMutation {
  return {
    row: { rowNumber: 2, campaignName: "campaign", adGroupName: "group", adName: "260717:001", videoCode: mode === "copy" ? "__COPY_SOURCE__" : "video", productUrl: "https://example.com", region: "US", dailyBudget: 1, bid: null, startAt: null, endAt: null, initialStatus: "disabled" },
    preset: { objectiveType: 1, buyingType: 1, campaignBudgetMode: 0, adBudgetMode: 0, pricing: 1, optimizeGoal: 1, externalAction: 1, pixelId: null, identityType: 1, identityId: "identity", callToActionId: "SHOP_NOW", countryCodes: [840], placementIds: [1], smartTargeting: true, commentDisabled: false, shareDisabled: false },
    initialStatus: "disabled",
    templateMode: mode,
    ...(mode === "copy" ? { templateCampaignId: "source-campaign" } : {}),
  };
}

function successfulCreationPayload(url: string): Record<string, unknown> {
  if (url.includes("campaign/list")) return { code: 0, data: { table: [{ campaign_id: "source-campaign", campaign_name: "source", campaign_status: "disabled" }], pagination: { page: 1, page_count: 1 } } };
  if (url.includes("adgroup/list")) return { code: 0, data: { table: [{ campaign_id: "source-campaign", campaign_name: "source", campaign_status: "disabled" }], pagination: { page: 1, page_count: 1 } } };
  if (url.includes("campaign_snap/copy")) return { code: 0, data: {
    new_campaign_snap_info_item: { campaign_snap_id: "campaign-snap", campaign_snap_form_data: { campaign_name: "source", campaign_snap_id: "campaign-snap", objective_type: 9 } },
    new_campaign_sketch_id: "campaign-sketch",
    new_ad_snap_info_item_list: [{ ad_snap_id: "ad-snap", ad_snap_form_data: { ad_name: "source", budget: "1", image_list: [] } }],
    new_ad_and_creative_snap_info_item_map: { "ad-snap": [{ creative_snap_id: "creative-snap", asset_group_creative_snap_form_data: { creative_name: "source", external_url: "https://example.com", image_list: [{ aweme_item_id: "video" }] } }] },
    new_ad_and_creative_sketch_ids_map: { "ad-sketch": ["creative-sketch"] },
  } };
  if (url.includes("campaign_snap/save")) return { code: 0, data: { campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" } };
  if (url.includes("ad_snap/save")) return { code: 0, data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" } };
  if (url.includes("creative_snap/save")) return { code: 0, data: { creative_snap_id: "creative-snap", creative_sketch_id: "creative-sketch" } };
  if (url.includes("cbo_consistency_check")) return { code: 0, data: { is_all_success: true } };
  if (url.includes("campaign_snap/check")) return { code: 0, data: { success: true, fake_campaign_id: "campaign-sketch" } };
  if (url.includes("ad_creative_snap/check")) return { code: 0, data: { creative_success: true } };
  if (url.includes("batch_create_cta_id")) return { code: 0, data: { cta_id_map: {} } };
  if (url.includes("async_creation/detail")) return { code: 0, data: { status: 1, result: { campaign_id: "campaign", ad_and_creative: { 0: { ad_id: "adgroup", asset_group_result: { 0: { creative_items: [{ id: "creative" }] } } } } } } };
  return { code: 0, data: { async_request_id: "async" } };
}

function jsonResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}
