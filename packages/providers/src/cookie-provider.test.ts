import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieAdsProvider } from "./cookie-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CookieAdsProvider", () => {
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
            body: "{}",
            contentType: "application/json",
          },
          {
            target: "ad-group",
            url: "https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=123456",
            method: "POST",
            body: "{}",
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
});
