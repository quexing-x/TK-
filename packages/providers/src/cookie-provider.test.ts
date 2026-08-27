import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CookieAdsProvider,
  createSentRequestRecorder,
  resolveTemplateCampaignId,
} from "./cookie-provider.js";
import {
  SENT_REQUEST_BODY_LIMIT,
  SENT_REQUEST_MAX_ENTRIES,
  type LaunchCreationProgress,
} from "@tk-auto/core";
import type { CreationMutation, ProviderContext } from "./types.js";
import { parseMultipartFields } from "./multipart.js";

let successfulCreationCompleted = false;

function originalPostContext(): ProviderContext {
  return {
    accountId: "test-account",
    timezone: "Asia/Taipei",
    settings: {
      kind: "cookie",
      advertiserId: "654321",
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
        target: "ad-group",
        url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=654321",
        method: "POST",
        body: "{}",
        contentType: "application/json",
      }],
    },
  };
}

afterEach(() => {
  successfulCreationCompleted = false;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CookieAdsProvider", () => {
  it("reads original posts from a two-level ad group through its procedural creative", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const payload = url.includes("sidebar/brief_info_list")
        ? {
            code: 0,
            data: { campaign_brief_info: { ad_brief_info_list: [{
              id: "group-1",
              asset_group_brief_info_item_list: [{ id: "creative-1" }],
            }] } },
          }
        : {
            code: 0,
            data: {
              external_url: "https://example.com/product",
              catalog_setup: 0,
              product_info: {
                promo_code_infos: [{ code: "", code_type: 2, value: 718, currency: "TWD", include_type: 2, code_id: "source-only" }],
                is_auto_use: 2,
              },
              image_list: [{
                aweme_item_id: "post-1",
                identity_id: "identity-1",
                identity_type: 2,
                identity_bc_id: "0",
                title: "原帖一",
                video_info: { vid: "vid-1", video_id: "video-1" },
              }],
            },
          };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const result = await new CookieAdsProvider().readAdGroupOriginalPosts!(
      originalPostContext(),
      { campaignId: "campaign-1", adGroupId: "group-1" },
    );
    expect(requests[0]).toMatchObject({ body: { campaign_id: "campaign-1" } });
    expect(requests[1]?.url).toContain("creative_id=creative-1");
    expect(result).toEqual({
      productUrl: "https://example.com/product",
      catalogSetup: 0,
      productInfo: {
        promo_code_infos: [{ code: "", code_type: 2, value: 718, currency: "TWD", include_type: 2 }],
        is_auto_use: 2,
        auto_select_toggle: 0,
        image_infos: [],
        selling_points_by_types: [],
      },
      posts: [expect.objectContaining({
        itemId: "post-1",
        identityId: "identity-1",
        identityType: 2,
        identityBcId: "0",
        vid: "vid-1",
      })],
    });
  });

  it("revalidates exact item ids against a target identity in bounded batches", async () => {
    const nativeBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      let payload: Record<string, unknown>;
      if (url.includes("spark/identity/list")) {
        payload = { code: 0, data: { has_more: false, identity_list: [{
          identity_id: "target-identity",
          identity_type: 2,
          identity_bc_id: "77",
          can_use_video_list: true,
        }] } };
      } else {
        nativeBodies.push(JSON.parse(String(init?.body)));
        payload = { code: 0, data: {
          item_info_map: {
            "post-2": { item_id: "post-2", video_info: { vid: "target-vid-2" } },
            "post-1": { item_id: "post-1", video_info: { vid: "target-vid-1" } },
          },
        } };
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const posts = await new CookieAdsProvider().readAccessibleOriginalPosts!(
      originalPostContext(),
      ["post-1", "post-2"].map((itemId) => ({
        itemId,
        identityId: "target-identity",
        identityType: 2,
        identityBcId: "0",
        vid: `source-${itemId}`,
        videoId: null,
        displayName: null,
        coverUrl: null,
        promotable: true,
      })),
    );
    expect(nativeBodies).toEqual([{ item_req_list: [
      expect.objectContaining({ aweme_item_ids: ["post-1"], identity_bc_id: "77" }),
      expect.objectContaining({ aweme_item_ids: ["post-2"], identity_bc_id: "77" }),
    ] }]);
    expect(posts.map((post) => post.itemId)).toEqual(["post-1", "post-2"]);
    expect(posts.every((post) => post.identityId === "target-identity")).toBe(true);
  });

  it("keeps large post sets bounded instead of loading or dispatching them as one request", async () => {
    const batchSizes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("spark/identity/list")) {
        return new Response(JSON.stringify({ code: 0, data: {
          has_more: false,
          identity_list: [{
            identity_id: "target-identity",
            identity_type: 2,
            identity_bc_id: "0",
            can_use_video_list: true,
          }],
        } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as { item_req_list: Array<{ aweme_item_ids: string[] }> };
      batchSizes.push(body.item_req_list.length);
      const itemInfoMap = Object.fromEntries(body.item_req_list.map((request) => {
        const itemId = request.aweme_item_ids[0]!;
        return [itemId, { item_id: itemId, video_info: { vid: `target-${itemId}` } }];
      }));
      return new Response(JSON.stringify({ code: 0, data: { item_info_map: itemInfoMap } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const sourcePosts = Array.from({ length: 120 }, (_, index) => ({
      itemId: `post-${index}`,
      identityId: "target-identity",
      identityType: 2,
      identityBcId: "0",
      vid: `source-${index}`,
      videoId: null,
      displayName: null,
      coverUrl: null,
      promotable: true,
    }));
    const posts = await new CookieAdsProvider().readAccessibleOriginalPosts!(
      originalPostContext(),
      sourcePosts,
    );
    expect(batchSizes).toEqual([50, 50, 20]);
    expect(posts).toHaveLength(120);
  });

  it("fails clearly instead of looping or silently truncating an excessive identity list", async () => {
    let identityRequests = 0;
    let nativeRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("spark/identity/list")) {
        identityRequests += 1;
        return jsonResponse({
          code: 0,
          data: {
            has_more: true,
            cursor: String(identityRequests),
            next_page: identityRequests + 1,
            next_query_mode: 8,
            identity_list: [],
          },
        });
      }
      nativeRequests += 1;
      return jsonResponse({ code: 0, data: { item_info_map: {} } });
    }));
    const sourcePost = {
      itemId: "post-1",
      identityId: "identity-1",
      identityType: 2,
      identityBcId: "0",
      vid: "source-vid",
      videoId: null,
      displayName: null,
      coverUrl: null,
      promotable: true,
    };

    await expect(new CookieAdsProvider().readAccessibleOriginalPosts!(
      originalPostContext(),
      [sourcePost],
    )).rejects.toThrow("安全分页上限");
    expect(identityRequests).toBe(50);
    expect(nativeRequests).toBe(0);
  });

  it("reuses the ad-group status session to delete a disabled ad group without another cURL", async () => {
    const sentBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sentBodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const context: ProviderContext = {
      accountId: "test-account",
      timezone: "Asia/Taipei",
      settings: { kind: "cookie", advertiserId: "654321", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfToken: "test-csrf",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [{
          target: "ad-group-status",
          action: "disable",
          url: "https://ads.tiktok.com/api/v4/i18n/adgroup/update_status/?aadvid=654321",
          method: "POST",
          body: '{"adgroup_ids":["old-id"],"operation_status":"DISABLE"}',
          contentType: "application/json",
        }],
      },
    };
    const provider = new CookieAdsProvider();

    expect(provider.resolveCapabilities(context)).toContain("delete-ad-groups");
    await expect(provider.deleteAdGroups(context, [{ externalId: "adgroup-1" }]))
      .resolves.toEqual([expect.objectContaining({ externalId: "adgroup-1", ok: true })]);
    expect(JSON.parse(sentBodies[0]!)).toEqual({
      adgroup_ids: ["adgroup-1"],
      operation_status: "DELETE",
    });
  });

  // 生产事故：真实账户的关闭 cURL 是 multipart 且字段名叫 operation，而删除派生
  // 当时写死了 operation_status，2026-08-06 早上 66 个广告组全部在发出前失败。
  // 判据必须和导入时识别启停字段的 isStatusKey 完全一致。
  it("derives the deletion from a multipart operation field, not just operation_status", async () => {
    const sentBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sentBodies.push(String(init?.body ?? ""));
      return jsonResponse({ code: 0, data: {} });
    }));
    const boundary = "----WebKitFormBoundaryTest";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="operation"',
      "",
      "disable",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const context: ProviderContext = {
      accountId: "test-account",
      timezone: "Asia/Taipei",
      settings: { kind: "cookie", advertiserId: "654321", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfToken: "test-csrf",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [{
          target: "ad-group-status",
          action: "disable",
          url: "https://ads.tiktok.com/api/v2/i18n/overture/adgroup/update_status/?aadvid=654321&adgroup_id=old-id",
          method: "POST",
          body,
          contentType: `multipart/form-data; boundary=${boundary}`,
        }],
      },
    };
    const provider = new CookieAdsProvider();

    expect(provider.resolveCapabilities(context)).toContain("delete-ad-groups");
    await expect(provider.deleteAdGroups(context, [{ externalId: "adgroup-1" }]))
      .resolves.toEqual([expect.objectContaining({ externalId: "adgroup-1", ok: true })]);
    // 原值是小写 disable，改写后也应当是小写 delete。
    expect(sentBodies[0]).toContain("delete");
    expect(sentBodies[0]).not.toContain("disable");
    expect(sentBodies[0]).not.toContain("DELETE");
  });

  // 能力上报必须和真实要求一致：模板里没有可改写的开关字段时，删除派生不出来，
  // 就不该对外宣称删除可用——否则执行器会领走当天任务再整批失败。
  it("does not advertise deletion when the status template has no rewritable switch field", () => {
    const context: ProviderContext = {
      accountId: "test-account",
      timezone: "Asia/Taipei",
      settings: { kind: "cookie", advertiserId: "654321", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [{
          target: "ad-group-status",
          action: "disable",
          url: "https://ads.tiktok.com/api/v4/i18n/adgroup/update_status/?aadvid=654321",
          method: "POST",
          body: '{"adgroup_ids":["old-id"]}',
          contentType: "application/json",
        }],
      },
    };

    expect(new CookieAdsProvider().resolveCapabilities(context)).not.toContain("delete-ad-groups");
  });

  it("keeps a dispatched deletion with a lost response in unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("connection lost");
    }));
    const provider = new CookieAdsProvider();
    const context: ProviderContext = {
      accountId: "test-account",
      timezone: "Asia/Taipei",
      settings: { kind: "cookie", advertiserId: "654321", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [{
          target: "ad-group-status",
          action: "disable",
          url: "https://ads.tiktok.com/api/v4/i18n/adgroup/update_status/?aadvid=654321",
          method: "POST",
          body: '{"adgroup_ids":["old-id"],"operation_status":"DISABLE"}',
          contentType: "application/json",
        }],
      },
    };

    await expect(provider.deleteAdGroups(context, [{ externalId: "adgroup-1" }]))
      .resolves.toEqual([expect.objectContaining({ ok: false, failureKind: "unknown" })]);
  });

  it("keeps a dispatched deletion with an incomplete JSON response in unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const provider = new CookieAdsProvider();
    const context: ProviderContext = {
      accountId: "test-account",
      timezone: "Asia/Taipei",
      settings: { kind: "cookie", advertiserId: "654321", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [{
          target: "ad-group-status",
          action: "disable",
          url: "https://ads.tiktok.com/api/v4/i18n/adgroup/update_status/?aadvid=654321",
          method: "POST",
          body: '{"adgroup_ids":["old-id"],"operation_status":"DISABLE"}',
          contentType: "application/json",
        }],
      },
    };

    await expect(provider.deleteAdGroups(context, [{ externalId: "adgroup-1" }]))
      .resolves.toEqual([expect.objectContaining({ ok: false, failureKind: "unknown" })]);
  });

  // 报文形状按 2026-08-06 的真机抓包钉死；改这条测试前先重新抓一次包。
  it("按真机抓包构造申诉报文，并从会话 cURL 派生出请求", async () => {
    const sentRequests: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      sentRequests.push({
        url: String(input),
        body: String(init?.body ?? ""),
        headers: init?.headers as Record<string, string>,
      });
      return new Response(JSON.stringify({ code: 0, data: { appeal_success: true } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }));

    const provider = new CookieAdsProvider();
    const context: ProviderContext = {
      accountId: "test-account",
      timezone: "Asia/Taipei",
      settings: { kind: "cookie", advertiserId: "654321", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfToken: "test-csrf",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [{
          target: "ad-group",
          url: "https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=654321&msToken=session-query",
          method: "POST",
          body: "{}",
          contentType: "application/json",
          derived: false,
        }],
      },
    };

    expect(provider.resolveCapabilities(context)).toContain("appeal-ads");
    const results = await provider.appeal(context, [{
      externalId: "1872730776636513",
      creativeId: "1872730776636513",
      adGroupId: "1872730776636497",
      reason: "我认为我的视频没有违规。",
    }]);
    const secondResults = await provider.appeal({
      accountId: "second-account",
      timezone: "Asia/Taipei",
      settings: { kind: "cookie", advertiserId: "777888", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie",
        cookie: "sessionid=second-cookie",
        csrfToken: "second-csrf",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [{
          target: "ad-group",
          url: "https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=777888&msToken=second-query",
          method: "POST",
          body: "{}",
          contentType: "application/json",
          derived: false,
        }],
      },
    }, [{
      externalId: "1872597696454978",
      creativeId: "1872597696454978",
      adGroupId: "1872597696453938",
      reason: "第二个账户的申诉。",
    }]);

    const url = new URL(sentRequests[0]!.url);
    expect(url.pathname).toBe("/api/v4/i18n/creation/audit/appeal_creative/");
    expect(url.searchParams.get("aadvid")).toBe("654321");
    // 抓包里查询串带 req_src=bidding。
    expect(url.searchParams.get("req_src")).toBe("bidding");
    expect(sentRequests[0]!.headers).toMatchObject({
      cookie: "sessionid=test-cookie",
      "x-csrftoken": "test-csrf",
    });
    // 字段形状对照 2026-08-06 的真机抓包，逐字段钉死。此前这里断言的是手写报文
    // 自己（测试名还写着 "without an account appeal import"），等于没测。
    expect(JSON.parse(sentRequests[0]!.body)).toEqual({
      // ad_id 是广告组，creative_id 才是广告自己——这两个位置此前都填了广告 ID。
      ad_id: "1872730776636497",
      aadvid: "654321",
      adv_entry: "ad review detail",
      appeal_reason: "我认为我的视频没有违规。",
      attachment_list: [],
      appeal_reason_type: 1,
      creative_id: 1872730776636513,
      advertiser_id: "654321",
    });
    // creative_id 必须是数字字面量：发字符串会被 TikTok 在解 JSON 时以
    // `json: cannot unmarshal string into ... int64` 拒绝。
    expect(sentRequests[0]!.body).toContain('"creative_id":1872730776636513');
    expect(sentRequests[0]!.body).not.toContain('"creative_id":"');
    const secondUrl = new URL(sentRequests[1]!.url);
    expect(secondUrl.searchParams.get("aadvid")).toBe("777888");
    expect(sentRequests[1]!.headers).toMatchObject({
      cookie: "sessionid=second-cookie",
      "x-csrftoken": "second-csrf",
    });
    expect(JSON.parse(sentRequests[1]!.body)).toMatchObject({
      ad_id: "1872597696453938",
      creative_id: 1872597696454978,
      aadvid: "777888",
      advertiser_id: "777888",
      appeal_reason: "第二个账户的申诉。",
    });
    expect(results).toEqual([expect.objectContaining({ ok: true })]);
    expect(secondResults).toEqual([expect.objectContaining({ ok: true })]);
  });

  // TikTok 的 ID 可以长到 19 位，超过 2^53。creative_id 要发数字字面量，如果先过
  // Number() 再 stringify，末几位会被静默改写，申诉就打到别的广告上去了。
  it("19 位广告 ID 逐位原样发出，不经过 Number() 丢精度", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ code: 0, data: { appeal_success: true } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }));
    const hugeId = "7668973964592414740";

    await new CookieAdsProvider().appeal(appealTestContext(), [{
      externalId: hugeId,
      creativeId: hugeId,
      adGroupId: "7668973964592414739",
      reason: "理由",
    }]);

    expect(sent[0]).toContain(`"creative_id":${hugeId}`);
    // 这是走 Number() 会得到的结果，出现它就说明精度已经丢了。
    expect(sent[0]).not.toContain(String(Number(hugeId)));
  });

  it("拿不到广告组 ID 时明确报错，而不是发一个残缺报文出去", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const [result] = await new CookieAdsProvider().appeal(appealTestContext(), [{
      externalId: "1872730776636513",
      creativeId: "1872730776636513",
      adGroupId: "",
      reason: "理由",
    }]);

    expect(result).toMatchObject({ ok: false, failureKind: "retryable" });
    expect(result?.message).toContain("广告组 ID");
    // 报文构造不出来就不该发请求：TikTok 侧什么都不该发生。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a dispatched appeal with a lost response in unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("connection lost");
    }));
    const provider = new CookieAdsProvider();
    const context: ProviderContext = {
      accountId: "test-account",
      timezone: "Asia/Taipei",
      settings: { kind: "cookie", advertiserId: "654321", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [{
          target: "ad-group",
          url: "https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=654321",
          method: "POST",
          body: "{}",
          contentType: "application/json",
          derived: false,
        }],
      },
    };

    await expect(provider.appeal(context, [{
      externalId: "1872730776636513",
      creativeId: "1872730776636513",
      adGroupId: "1872730776636497",
      reason: "appeal",
    }])).resolves.toEqual([expect.objectContaining({
      ok: false,
      failureKind: "unknown",
    })]);
  });

  function appealTestContext(): ProviderContext {
    return {
      accountId: "test-account",
      timezone: "Asia/Taipei",
      settings: { kind: "cookie", advertiserId: "654321", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [{
          target: "ad-group",
          url: "https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=654321",
          method: "POST",
          body: "{}",
          contentType: "application/json",
          derived: false,
        }],
      },
    };
  }

  // 2026-08-06：三条自动申诉全部失败，但库里只留下 JS 自己截断的
  // `Unexpected token 'j', "json: cann"... is not valid JSON`——TikTok 到底说哪个
  // 字段不对被丢掉了，根因无从查起。响应体必须原样带进错误消息。
  it("把 TikTok 回的非 JSON 响应体带进错误消息，而不是只留 JS 的解析报错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      // content-type 仍然写着 json，body 却是后端的纯文本报错——真机就是这样。
      new Response("json: cannot unmarshal string into Go struct field .creative_id of type int64", {
        status: 200,
        headers: { "content-type": "application/json" },
      })));
    const provider = new CookieAdsProvider();
    const context: ProviderContext = {
      accountId: "test-account",
      timezone: "Asia/Taipei",
      settings: { kind: "cookie", advertiserId: "654321", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [{
          target: "ad-group",
          url: "https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=654321",
          method: "POST",
          body: "{}",
          contentType: "application/json",
          derived: false,
        }],
      },
    };

    const [result] = await provider.appeal(context, [{
      externalId: "1872730776636513",
      creativeId: "1872730776636513",
      adGroupId: "1872730776636497",
      reason: "appeal",
    }]);

    expect(result).toMatchObject({ ok: false });
    // 关键：服务端说的那句话必须完整可见，否则这类字段错永远查不出来。
    expect(result?.message).toContain("cannot unmarshal");
    expect(result?.message).toContain("creative_id");
    expect(result?.message).not.toContain("Unexpected token");
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
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        page?: number;
        common_req?: { page?: number };
      };
      const page = body.common_req?.page ?? body.page ?? Number(new URL(url).searchParams.get("page") ?? 1);
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

  it("retries a failed derived list request once instead of dropping the whole ad layer", async () => {
    let adAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/ad/list")) {
        adAttempts += 1;
        if (adAttempts === 1) return new Response("rate limited", { status: 429 });
      }
      return jsonResponse(derivedListPage());
    }));

    const output = await new CookieAdsProvider().syncReadOnly(derivedSyncContext());

    expect(adAttempts).toBe(2);
    expect(output.result.counts.ad).toBe(1);
    expect(output.result.quality.partialFailures).not.toContain("ad:derived-request-failed");
  });

  it("records why a derived list request failed instead of a generic warning", async () => {
    let adAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/ad/list")) {
        adAttempts += 1;
        return new Response("rate limited", { status: 429 });
      }
      return jsonResponse(derivedListPage());
    }));

    const output = await new CookieAdsProvider().syncReadOnly(derivedSyncContext());

    // 恰好两次：重试一次就放弃，不会退化成无界重试。
    expect(adAttempts).toBe(2);
    expect(output.result.quality.partialFailures).toContain("ad:derived-request-failed");
    expect(output.result.warnings.some((warning) => warning.includes("HTTP 429"))).toBe(true);
  });

  // 生产实测：广告层级失败的真正原因是我们自己的超时预算到点，而不是对端拒绝服务。
  // 一个已经等满预算还没回话的请求，再等一轮也不会回话，重试只会把整轮轮询拖长数十秒。
  it("does not retry a derived list request that timed out", async () => {
    let adAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/ad/list")) {
        adAttempts += 1;
        const timeout = new Error("The operation was aborted due to timeout");
        timeout.name = "TimeoutError";
        throw timeout;
      }
      return jsonResponse(derivedListPage());
    }));

    const output = await new CookieAdsProvider().syncReadOnly(derivedSyncContext());

    expect(adAttempts).toBe(1);
    expect(output.result.quality.partialFailures).toContain("ad:derived-request-failed");
    expect(output.result.warnings.some((warning) => warning.includes("timeout"))).toBe(true);
    // 警告要如实说明没有重试，不能沿用"已重试 1 次"的固定话术。
    expect(output.result.warnings.some((warning) => warning.includes("未重试"))).toBe(true);
    expect(output.result.warnings.some((warning) => warning.includes("已重试 1 次"))).toBe(false);
  });

  // 广告层拉不到时，系列和广告组这两层照样要被标记为可用，否则删除、自动复制会被
  // 无关层级的失败连坐跳过。
  it("reports which layers a partial sync still completed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/ad/list")) {
        const timeout = new Error("The operation was aborted due to timeout");
        timeout.name = "TimeoutError";
        throw timeout;
      }
      return jsonResponse(derivedListPage());
    }));

    const output = await new CookieAdsProvider().syncReadOnly(derivedSyncContext());

    expect(output.result.quality.status).toBe("partial");
    expect(output.result.quality.completeEntityTypes).toEqual(
      expect.arrayContaining(["campaign", "ad-group"]),
    );
    expect(output.result.quality.completeEntityTypes).not.toContain("ad");
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
      material: 0,
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
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requested.push({ url, body });
      const commonRequest = body.common_req as Record<string, unknown> | undefined;
      const campaignDimensionValid = JSON.stringify(commonRequest?.dimensions) === JSON.stringify(["campaign_id"]);
      const table = url.includes("campaign/list") && !campaignDimensionValid
        ? []
        : url.includes("campaign/list")
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
          body: JSON.stringify({
            common_req: {
              st: "2026-07-01",
              et: "2026-07-07",
              dimensions: ["ad_id"],
              metrics: ["stat_cost"],
              filters: [{ field: "ad_status", in_field_values: ["delete"], filter_type: 10 }],
              page: 1,
              page_size: 20,
            },
          }),
          contentType: "application/json",
        }],
      },
    });

    expect(output.result.quality.status).toBe("healthy");
    expect(output.result.counts).toEqual({ campaign: 1, "ad-group": 1, ad: 1, material: 0 });
    expect(requested.find((item) => item.url.includes("campaign/list"))?.body).toMatchObject({
      common_req: {
        dimensions: ["campaign_id"],
        metrics: ["stat_cost", "time_attr_on_web_cart"],
      },
    });
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

  it("rewrites a stored ad template that still carries the ad-group dimension", async () => {
    // 复刻线上账户的真实状态：凭据里存着一条早期派生的 ad 模板，路径已经是
    // ad/list，但请求体仍是广告组维度。TikTok 对该维度只回占位行
    // （universal_type=1、creative_id="0"），会被实体解析整行丢弃。
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requested.push({ url, body });
      const commonRequest = body.common_req as Record<string, unknown> | undefined;
      const byCreative = JSON.stringify(commonRequest?.dimensions) === JSON.stringify(["creative_id"]);
      const table = url.includes("/ad/list")
        ? byCreative
          ? [{
              campaign_id: "campaign-1",
              ad_id: "adgroup-1",
              creative_id: "creative-1",
              creative_name: "最终广告",
              universal_type: 1,
            }]
          : [{
              campaign_id: "campaign-1",
              ad_id: "adgroup-1",
              creative_id: "0",
              universal_type: 1,
            }]
        : url.includes("adgroup/list")
          ? [{ campaign_id: "campaign-1", ad_id: "adgroup-1", ad_name: "广告组" }]
          : [{ campaign_id: "campaign-1", campaign_name: "系列" }];
      return new Response(JSON.stringify({ data: { table }, code: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

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
            body: JSON.stringify({ common_req: { dimensions: ["ad_id"], page: 1, page_size: 20 } }),
            contentType: "application/json",
          },
          {
            target: "ad",
            derived: true,
            url: "https://ads.tiktok.com/api/v4/i18n/statistics/op/ad/list/?aadvid=123456",
            method: "POST",
            body: JSON.stringify({ common_req: { dimensions: ["ad_id"], page: 1, page_size: 20 } }),
            contentType: "application/json",
          },
        ],
      },
    });

    expect(requested.find((item) => item.url.includes("/ad/list"))?.body).toMatchObject({
      common_req: { dimensions: ["creative_id"] },
    });
    expect(output.result.counts.ad).toBe(1);
    expect(output.entities).toContainEqual(
      expect.objectContaining({ entityType: "ad", externalId: "creative-1" }),
    );
  });

  it("does not turn a two-level creative placeholder into a duplicate final ad", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const table = url.includes("campaign/list")
        ? [{ campaign_id: "campaign-1", campaign_name: "系列" }]
        : url.includes("adgroup/list")
          ? [{ campaign_id: "campaign-1", ad_id: "adgroup-1", ad_name: "广告组" }]
          : [{
              campaign_id: "campaign-1",
              adgroup_id: "adgroup-1",
              ad_id: "adgroup-1",
              creative_id: "0",
              creative_name: "0",
              ad_name: "广告组",
              universal_type: 1,
              stat_data: { ad_id: "adgroup-1", creative_id: "0" },
            }];
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
          body: "{}",
          contentType: "application/json",
        }],
      },
    });

    expect(output.result.quality.status).toBe("healthy");
    expect(output.result.counts).toEqual({ campaign: 1, "ad-group": 1, ad: 0, material: 0 });
    expect(output.entities).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "ad", externalId: "adgroup-1" }),
    ]));
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

  it("succeeds when the target id equals the id captured in the template (2026-08-01 incident)", async () => {
    // 真实故障复现：导入启停 cURL 时，被选中的正好就是这个广告组本身，所以模板
    // 里 ad_list 已经是 ["captured-id"]。以后再对同一个广告组做同样的启停操作，
    // 替换后的值和已有值完全相同——字段确实被匹配到了，只是没有产生文本差异。
    // 在修复前，这会被误判为“模板里没有可替换的广告对象 ID”而直接拒绝派发。
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
      '["captured-id"]\r\n',
      "------TestBoundary\r\n",
      'Content-Disposition: form-data; name="operation"\r\n\r\n',
      "disable\r\n",
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
              action: "disable",
              url: "https://ads.tiktok.com/api/v3/i18n/overture/ad/update_status/?aadvid=123456",
              method: "POST",
              body,
              contentType: "multipart/form-data; boundary=----TestBoundary",
            },
          ],
        },
      },
      // 目标广告组的 ID 与模板里已经写死的 ID 完全一样。
      [{ entityType: "ad-group", externalId: "captured-id", action: "disable" }],
    );

    expect(result[0]).toMatchObject({ ok: true, externalId: "captured-id" });
    expect(requestBody).toContain('name="ad_list"\r\n\r\n["captured-id"]');
  });

  it("still rejects a template with no matching entity-list field at all", async () => {
    // 反向校验：真正没有可替换字段时，仍然必须在派发前拒绝，不能被本次修复
    // 误放行。
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("不应该发出任何请求。");
    }));
    const body = [
      "------TestBoundary\r\n",
      'Content-Disposition: form-data; name="operation"\r\n\r\n',
      "disable\r\n",
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
              action: "disable",
              url: "https://ads.tiktok.com/api/v3/i18n/overture/ad/update_status/?aadvid=123456",
              method: "POST",
              body,
              contentType: "multipart/form-data; boundary=----TestBoundary",
            },
          ],
        },
      },
      [{ entityType: "ad-group", externalId: "any-id", action: "disable" }],
    );

    expect(result[0]).toMatchObject({ ok: false });
    expect(result[0]?.message).toContain("状态 cURL 中未找到可替换的广告对象 ID");
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
    // 这里原本断言 aco_creative_list 也被填成目标 ID，那正是让广告层启停 67 次
    // 全部被 TikTok 以 code 4 拒绝的原因：真实抓包里这个列表是空数组，它和
    // creative_list 装的是不同类型的对象。
    expect(requestBody).toContain('name="aco_creative_list"\r\n\r\n[]');
  });

  it("runs the checked draft-to-publish chain from the imported list-session request", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    const progress: Array<Parameters<NonNullable<CreationMutation["onProgress"]>>[0]> = [];
    let published = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const validation = successfulDraftValidationPayload(url);
      if (url.includes("async_creation/create_by_snap")) published = true;
      const body = url.includes("statistics/sketch/")
        ? emptySketchListPayload()
        : url.includes("/statistics/op/campaign/list")
        ? completeListPayload(published ? [{ campaign_id: "campaign", campaign_name: "测试系列" }] : [])
        : url.includes("/statistics/op/adgroup/list")
        ? completeListPayload(published ? [{ campaign_id: "campaign", ad_id: "adgroup", ad_name: "测试广告组" }] : [])
        : url.includes("/statistics/op/ad/list")
        ? completeListPayload(published ? [{ campaign_id: "campaign", ad_id: "adgroup", creative_id: "creative", creative_name: "260716:001" }] : [])
        : url.includes("adgroup/list") || url.includes("campaign/list")
        ? { data: { table: [], pagination: { page: 1, page_count: 1 } }, code: 0 }
        : url.includes("campaign_snap/save")
        ? { data: { campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" }, code: 0 }
        : url.includes("ad_snap/save")
          ? { data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" }, code: 0 }
          : url.includes("creative_snap/save")
            ? { data: { creative_snap_id: "creative-snap", creative_sketch_id: "creative-sketch" }, code: 0 }
            : validation ?? { data: { campaign_id: "campaign", adgroup_id: "adgroup", creative_id: "creative" }, code: 0 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const result = await new CookieAdsProvider().createFromPreset!({
      accountId: "test-account", settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: { kind: "cookie", cookie: "sessionid=test-cookie", csrfHeaderName: "x-csrftoken", requestTemplates: [{ target: "ad-group", url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=123456&msToken=session", method: "POST", body: "{}", contentType: "application/json" }] },
    }, [{
      row: { rowNumber: 2, campaignName: "测试系列", adGroupName: "测试广告组", adName: "260716:001", videoCode: "7663403524864167176", productUrl: "https://example.com", region: "US", dailyBudget: 100, bid: null, startAt: null, endAt: null, initialStatus: "enabled" },
      preset: { objectiveType: 1, buyingType: 1, campaignBudgetMode: 0, adBudgetMode: 0, pricing: 1, optimizeGoal: 1, externalAction: 1, pixelId: null, identityType: 1, identityId: "identity", callToActionId: "SHOP_NOW", countryCodes: [840], placementIds: [1], smartTargeting: true, commentDisabled: false, shareDisabled: false, videoPostMappings: [] },
      initialStatus: "enabled",
      templateMode: "none",
      operationId: "operation-1",
      attemptId: "attempt-1",
      correlationId: "correlation-1",
      onProgress: (event) => progress.push(event),
    }]);

    expect(result[0]).toMatchObject({ ok: true, campaignId: "campaign", adGroupId: "adgroup", adId: "creative" });
    expect(requested.map((item) => new URL(item.url).pathname)).toEqual(expect.arrayContaining([
      "/api/v3/i18n/statistics/op/adgroup/list/",
      "/api/v3/i18n/statistics/op/campaign/list/",
      "/api/v4/i18n/creation/campaign_snap/save/",
      "/api/v4/i18n/creation/campaign_snap/check/",
      "/api/v4/i18n/creation/ad_snap/save/",
      "/api/v4/i18n/creation/ad_snap/bulk_check/",
      "/api/v4/i18n/creation/creative_snap/save/",
      "/api/v4/i18n/creation/snap/cbo_consistency_check/",
      "/api/v4/i18n/creation/ad_creative_snap/check/",
      "/api/v4/i18n/creation/snap/batch_create_cta_id/",
      "/api/v4/i18n/creation/async_creation/create_by_snap/",
      "/api/v3/i18n/statistics/op/ad/list/",
      "/api/v4/i18n/statistics/sketch/ad/list/",
    ]));
    expect(requested.find((item) => item.url.includes("create_by_snap"))?.body)
      .toMatchObject({ is_status_disabled: false, is_partial_publish: false, coming_source_type: 1 });
    expect(requested.find((item) => item.url.includes("creative_snap/save"))?.body).toMatchObject({
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

  it("builds every same-campaign draft before one synchronized publish", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    let pixelDirectoryReads = 0;
    let campaignSaves = 0;
    let adGroupSaves = 0;
    let creativeSaves = 0;
    let completed = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requested.push({ url, body: requestBody });
      let body: Record<string, unknown>;
      if (url.includes("/mi/api/v2/i18n/pixel/list/")) {
        pixelDirectoryReads += 1;
        body = { code: 0, data: { pixel_list: [], pagination: { page: 1, page_count: 1 } } };
      } else if (url.includes("statistics/sketch/")) {
        body = emptySketchListPayload();
      } else if (url.includes("/statistics/op/campaign/list")) {
        body = completeListPayload(completed ? [{ campaign_id: "campaign", campaign_name: "campaign" }] : []);
      } else if (url.includes("/statistics/op/adgroup/list")) {
        // 账户里本来就有的广告组，带着它自己的数据连接——这就是「创建广告组的
        // 地方」能看到的东西，预设填的名称/ID 要从这里解析。
        body = completeListPayload([
          {
            campaign_id: "existing-campaign",
            ad_id: "existing-adgroup",
            ad_name: "既有组",
            ad_ref_pixel_id: "7542379322273447954",
            ad_pixel_name: "纵恣-lsh",
          },
          ...(completed ? [
            { campaign_id: "campaign", ad_id: "adgroup-1", ad_name: "group" },
            { campaign_id: "campaign", ad_id: "adgroup-2", ad_name: "group-2" },
          ] : []),
        ]);
      } else if (url.includes("/statistics/op/ad/list")) {
        body = completeListPayload(completed ? [
          { campaign_id: "campaign", ad_id: "adgroup-1", creative_id: "creative-1", creative_name: "260717:001" },
          { campaign_id: "campaign", ad_id: "adgroup-2", creative_id: "creative-2", creative_name: "260717:002" },
        ] : []);
      } else if (url.includes("adgroup/list") || url.includes("campaign/list")) {
        body = { data: { table: [], pagination: { page: 1, page_count: 1 } }, code: 0 };
      } else if (url.includes("campaign_snap/save")) {
        campaignSaves += 1;
        body = { data: { campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" }, code: 0 };
      } else if (url.includes("ad_snap/save")) {
        adGroupSaves += 1;
        body = { data: { ad_snap_id: `ad-snap-${adGroupSaves}`, ad_sketch_id: `ad-sketch-${adGroupSaves}` }, code: 0 };
      } else if (url.includes("creative_snap/save")) {
        creativeSaves += 1;
        body = { data: { creative_snap_id: `creative-snap-${creativeSaves}`, creative_sketch_id: `creative-sketch-${creativeSaves}` }, code: 0 };
      } else if (url.includes("async_creation/detail")) {
        completed = true;
        body = { code: 0, data: { status: 1, result: {
          campaign_id: "campaign",
          ad_and_creative: {
            // TikTok can return the terminal objects in a different order
            // than the submitted drafts. by_ad_snap_id is the stable join key.
            0: { by_ad_snap_id: "ad-snap-2", ad_id: "adgroup-2", asset_group_result: { 0: { creative_items: [{ id: "creative-2" }] } } },
            1: { by_ad_snap_id: "ad-snap-1", ad_id: "adgroup-1", asset_group_result: { 0: { creative_items: [{ id: "creative-1" }] } } },
          },
        } } };
      } else {
        body = successfulDraftValidationPayload(url, ["ad-snap-1", "ad-snap-2"])
          ?? { code: 0, data: { async_request_id: "async-batch" } };
      }
      return jsonResponse(body);
    }));

    const first = creationTestMutation("none");
    const second = creationTestMutation("none");
    first.operationId = "operation-1";
    first.attemptId = "attempt-1";
    second.operationId = "operation-2";
    second.attemptId = "attempt-2";
    // 一条按名称填、一条按数字 ID 填，两种写法都要解析到同一个数据连接。
    first.preset = { ...first.preset, pixelKey: "纵恣-lsh", pixelId: null };
    second.preset = { ...second.preset, pixelKey: "7542379322273447954", pixelId: null };
    second.row = { ...second.row, rowNumber: 3, adGroupName: "group-2", adName: "260717:002" };

    const result = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [first, second],
    );

    const publishes = requested.filter((item) => item.url.includes("async_creation/create_by_snap"));
    // 事件管理器目录接口已对所有账户返回 code 50002，创建链路一次都不该再碰它。
    expect(pixelDirectoryReads).toBe(0);
    expect(campaignSaves).toBe(1);
    expect(adGroupSaves).toBe(2);
    expect(creativeSaves).toBe(2);
    expect(publishes).toHaveLength(1);
    expect(publishes[0]?.body.ad_and_creative_snap_info_list).toHaveLength(2);
    for (const request of requested.filter((item) => item.url.includes("/ad_snap/save/"))) {
      expect(request.body).toMatchObject({
        ad_sketch_form_data: { ad_ref_pixel_id: "7542379322273447954" },
      });
    }
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: "operation-1", ok: true, campaignId: "campaign", adGroupId: "adgroup-1", adId: "creative-1" }),
      expect.objectContaining({ operationId: "operation-2", ok: true, campaignId: "campaign", adGroupId: "adgroup-2", adId: "creative-2" }),
    ]));
  });

  it("数据连接解析不出来时，一个草稿都不建", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      if (url.includes("statistics/sketch/")) return jsonResponse(emptySketchListPayload());
      if (url.includes("adgroup/list")) {
        return jsonResponse({ data: { table: [{
          campaign_id: "existing-campaign",
          ad_id: "existing-adgroup",
          ad_name: "既有组",
          ad_ref_pixel_id: "7542379322273447954",
          ad_pixel_name: "纵恣-lsh",
        }], pagination: { page: 1, page_count: 1 } }, code: 0 });
      }
      if (url.includes("campaign/list")) {
        return jsonResponse({ data: { table: [], pagination: { page: 1, page_count: 1 } }, code: 0 });
      }
      throw new Error(`数据连接解析失败后不应继续请求：${new URL(url).pathname}`);
    }));
    const mutation = creationTestMutation("none");
    mutation.preset = {
      ...mutation.preset,
      // 账户里只有「纵恣-lsh」，预设却指向另一个连接。
      pixelKey: "纵恣-czx",
      pixelId: null,
    };

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result).toMatchObject({ ok: false, failureKind: "retryable", retrySafe: true });
    expect(result?.message).toContain("找不到数据连接");
    // 报错要带上账户实际在用的连接，否则用户只能靠猜。
    expect(result?.message).toContain("纵恣-lsh(7542379322273447954)");
    // 这条是真正的安全边界：解析没通过，就不能有任何草稿/发布请求。
    expect(requests.some((request) => request.url.includes("/creation/"))).toBe(false);
    expect(requests.some((request) => request.url.includes("_snap/save"))).toBe(false);
  });

  it("填 Pixel Code 时直接说清楚不支持，而不是拿去查已经废掉的目录接口", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("statistics/sketch/")) return jsonResponse(emptySketchListPayload());
      if (url.includes("adgroup/list")) {
        return jsonResponse({ data: { table: [{
          campaign_id: "existing-campaign",
          ad_id: "existing-adgroup",
          ad_name: "既有组",
          ad_ref_pixel_id: "7542379322273447954",
          ad_pixel_name: "纵恣-lsh",
        }], pagination: { page: 1, page_count: 1 } }, code: 0 });
      }
      if (url.includes("campaign/list")) {
        return jsonResponse({ data: { table: [], pagination: { page: 1, page_count: 1 } }, code: 0 });
      }
      throw new Error(`不应继续请求：${new URL(url).pathname}`);
    }));
    const mutation = creationTestMutation("none");
    mutation.preset = { ...mutation.preset, pixelKey: "D2LUO4BC77U67ECJGK00", pixelId: null };

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result?.message).toContain("看起来是 Pixel Code");
    expect(result?.message).toContain("请改填数据连接名称或数字 ID");
    expect(requests.some((url) => url.includes("/pixel/list/"))).toBe(false);
  });

  it("keeps the requested formal ad-group successful when TikTok omits its ad material", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/statistics/op/ad/list") && successfulCreationCompleted) {
        return jsonResponse(completeListPayload([]));
      }
      return jsonResponse(successfulCreationPayload(url));
    }));

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [creationTestMutation("none")],
    );

    expect(result).toMatchObject({
      ok: true,
      campaignId: "campaign",
      adGroupId: "adgroup",
      warning: expect.stringContaining("已跳过 1 条素材"),
    });
    expect(result).not.toHaveProperty("adId");
  });

  it("does not report success when Cookie readback finds an unrequested new ad-group", async () => {
    const requestedPaths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedPaths.push(new URL(url).pathname);
      if (url.includes("/statistics/op/adgroup/list") && successfulCreationCompleted) {
        return jsonResponse(completeListPayload([
          { campaign_id: "campaign", ad_id: "adgroup", ad_name: "group" },
          { campaign_id: "campaign", ad_id: "unexpected-group", ad_name: "未安排广告组" },
        ]));
      }
      return jsonResponse(successfulCreationPayload(url));
    }));

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [creationTestMutation("none")],
    );

    expect(result).toMatchObject({ ok: false, failureKind: "unknown", retrySafe: false });
    expect(result?.message).toContain("未列入任务的新广告组");
    expect(requestedPaths).toContain("/api/v4/i18n/creation/async_creation/create_by_snap/");
  });

  it("reconciles an unknown item from Cookie lists without sending another creation request", async () => {
    const requestedPaths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const pathname = new URL(url).pathname;
      requestedPaths.push(pathname);
      if (url.includes("statistics/sketch/")) return jsonResponse(emptySketchListPayload());
      if (url.includes("/statistics/op/campaign/list")) {
        return jsonResponse(completeListPayload([{ campaign_id: "campaign", campaign_name: "campaign" }]));
      }
      if (url.includes("/statistics/op/adgroup/list")) {
        return jsonResponse(completeListPayload([{ campaign_id: "campaign", ad_id: "adgroup", ad_name: "group" }]));
      }
      if (url.includes("/statistics/op/ad/list")) {
        return jsonResponse(completeListPayload([{ campaign_id: "campaign", ad_id: "adgroup", creative_id: "creative", creative_name: "260717:001" }]));
      }
      throw new Error(`unexpected request: ${pathname}`);
    }));
    const mutation = creationTestMutation("none");
    mutation.reconcileOnly = true;

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result).toMatchObject({
      ok: true,
      campaignId: "campaign",
      adGroupId: "adgroup",
      adId: "creative",
    });
    expect(requestedPaths.some((path) => path.includes("/creation/campaign_snap/save"))).toBe(false);
    expect(requestedPaths.some((path) => path.includes("/creation/async_creation/create_by_snap"))).toBe(false);
  });

  it("turns a read-only recheck with no formal object and no draft into a safe failure", async () => {
    const requestedPaths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      requestedPaths.push(pathname);
      if (pathname.includes("/statistics/sketch/campaign/list")) {
        return jsonResponse(completeListPayload([{
          campaign_sketch_id: "unrelated-draft",
          campaign_sketch_name: "campaign",
        }]));
      }
      if (pathname.includes("/statistics/sketch/")) return jsonResponse(emptySketchListPayload());
      if (pathname.includes("/statistics/op/")) return jsonResponse(completeListPayload([]));
      throw new Error(`unexpected request: ${pathname}`);
    }));
    const mutation = creationTestMutation("none");
    mutation.reconcileOnly = true;
    mutation.reconcileEvidence = {
      resolvedAdGroupName: null,
      providerRequestId: null,
      campaignSnapId: null,
      campaignSketchId: "owned-draft-already-removed",
      adGroupSnapId: null,
      adGroupSketchId: null,
      creativeSnapId: null,
      creativeSketchId: null,
      asyncRequestId: null,
      sentRequests: null,
      advisoryFailures: null,
    };

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind: "retryable",
      retrySafe: true,
    });
    expect(result?.message).toContain("已确认本次未创建成功");
    expect(requestedPaths.some((path) => path.includes("/creation/"))).toBe(false);
  });

  it("does not treat a tracked ad draft id with a different name as the current task draft", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.includes("/statistics/sketch/ad/list")) {
        return jsonResponse(completeListPayload([{
          ad_sketch_id: "tracked-ad-draft",
          ad_sketch_name: "template-group",
        }]));
      }
      if (pathname.includes("/statistics/sketch/")) return jsonResponse(emptySketchListPayload());
      if (pathname.includes("/statistics/op/campaign/list")) {
        return jsonResponse(completeListPayload([{ campaign_id: "campaign", campaign_name: "campaign" }]));
      }
      if (pathname.includes("/statistics/op/")) return jsonResponse(completeListPayload([]));
      throw new Error(`unexpected request: ${pathname}`);
    }));
    const mutation = creationTestMutation("none");
    mutation.reconcileOnly = true;
    mutation.reconcileEvidence = {
      resolvedAdGroupName: "group",
      providerRequestId: null,
      campaignSnapId: null,
      campaignSketchId: null,
      adGroupSnapId: "tracked-ad-snap",
      adGroupSketchId: "tracked-ad-draft",
      creativeSnapId: null,
      creativeSketchId: null,
      asyncRequestId: null,
      sentRequests: null,
      advisoryFailures: null,
    };

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind: "retryable",
      retrySafe: true,
    });
  });

  it("creates one ad-group with several ads from a multi-code cell", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    let creativeSaves = 0;
    let published = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const validation = successfulDraftValidationPayload(url);
      if (url.includes("async_creation/create_by_snap")) published = true;
      const body = url.includes("statistics/sketch/")
        ? emptySketchListPayload()
        : url.includes("/statistics/op/campaign/list")
        ? completeListPayload(published ? [{ campaign_id: "campaign", campaign_name: "测试系列" }] : [])
        : url.includes("/statistics/op/adgroup/list")
        ? completeListPayload(published ? [{ campaign_id: "campaign", ad_id: "adgroup", ad_name: "测试广告组" }] : [])
        : url.includes("/statistics/op/ad/list")
        ? completeListPayload(published ? [{ campaign_id: "campaign", ad_id: "adgroup", creative_id: "creative", creative_name: "260716:001" }] : [])
        : url.includes("adgroup/list") || url.includes("campaign/list")
        ? { data: { table: [], pagination: { page: 1, page_count: 1 } }, code: 0 }
        : url.includes("campaign_snap/save")
        ? { data: { campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" }, code: 0 }
        : url.includes("ad_snap/save")
          ? { data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" }, code: 0 }
          : url.includes("creative_snap/save")
            ? (creativeSaves += 1, { data: { creative_snap_id: `creative-snap-${creativeSaves}`, creative_sketch_id: `creative-sketch-${creativeSaves}` }, code: 0 })
            : validation ?? { data: { campaign_id: "campaign", adgroup_id: "adgroup", creative_id: "creative" }, code: 0 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const result = await new CookieAdsProvider().createFromPreset!({
      accountId: "test-account", settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: { kind: "cookie", cookie: "sessionid=test-cookie", csrfHeaderName: "x-csrftoken", requestTemplates: [{ target: "ad-group", url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=123456&msToken=session", method: "POST", body: "{}", contentType: "application/json" }] },
    }, [{
      row: { rowNumber: 2, campaignName: "测试系列", adGroupName: "测试广告组", adName: "260716:001", videoCode: "1111;2222", productUrl: "https://example.com", region: "US", dailyBudget: 100, bid: null, startAt: null, endAt: null, initialStatus: "enabled" },
      preset: { objectiveType: 1, buyingType: 1, campaignBudgetMode: 0, adBudgetMode: 0, pricing: 1, optimizeGoal: 1, externalAction: 1, pixelId: null, identityType: 1, identityId: "identity", callToActionId: "SHOP_NOW", countryCodes: [840], placementIds: [1], smartTargeting: true, commentDisabled: false, shareDisabled: false, videoPostMappings: [] },
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
    // 发布直接引用建草稿时的 snap，不再经 snap/save_by_sketch 重铸——真机整个创建
    // 流程从不调那个接口。
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
    let completed = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requested.push({ url, body });
      const response = url.includes("statistics/sketch/")
        ? emptySketchListPayload()
        : url.includes("/statistics/op/campaign/list")
        ? completeListPayload([
            { campaign_id: "source-campaign", campaign_name: "old", campaign_status: "disabled" },
            ...(completed ? [{ campaign_id: "campaign", campaign_name: "测试系列" }] : []),
          ])
        : url.includes("/statistics/op/adgroup/list")
        ? completeListPayload(completed
            ? [{ campaign_id: "campaign", ad_id: "adgroup", ad_name: "测试广告组" }]
            : [])
        : url.includes("/statistics/op/ad/list")
        ? completeListPayload(completed
            ? [{ campaign_id: "campaign", ad_id: "adgroup", creative_id: "creative", creative_name: "260716:001" }]
            : [])
        : url.includes("adgroup/list") || url.includes("campaign/list")
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
            ? (completed = true, { data: { status: 1, result: { campaign_id: "campaign", ad_and_creative: { 0: { by_ad_snap_id: "ad-snap", ad_id: "adgroup", asset_group_result: { 0: { creative_items: [{ id: "creative" }] } } } } } }, code: 0 })
          : url.includes("cbo_consistency_check")
            ? { data: { is_all_success: true }, code: 0 }
          : url.includes("campaign_snap/check")
            ? { data: { success: true, fake_campaign_id: "campaign-sketch" }, code: 0 }
          : url.includes("ad_snap/bulk_check")
            ? { data: { ad_snap_check_report_map: { "ad-snap": { success: true, ad_snap_id: "ad-snap", fake_ad_id: "ad-sketch" } } }, code: 0 }
          : url.includes("ad_creative_snap/check")
            ? { data: { creative_success: true, ad_snap_check_report_map: { "ad-snap": { success: true, ad_snap_id: "ad-snap", fake_ad_id: "ad-sketch" } } }, code: 0 }
          : url.includes("creative_snap/check")
            ? { data: { success: true }, code: 0 }
          : url.includes("batch_create_cta_id")
            ? { data: { cta_id_map: {} }, code: 0 }
          : url.includes("snap/save_by_sketch")
        ? saveBySketchPayload()
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
    expect(requested.map((item) => new URL(item.url).pathname)).toEqual(expect.arrayContaining([
      "/api/v3/i18n/statistics/op/adgroup/list/",
      "/api/v3/i18n/statistics/op/campaign/list/",
      "/api/v4/i18n/creation/campaign_snap/save/",
      "/api/v4/i18n/creation/campaign_snap/check/",
      "/api/v4/i18n/creation/ad_snap/save/",
      "/api/v4/i18n/creation/ad_snap/bulk_check/",
      "/api/v4/i18n/creation/creative_snap/save/",
      "/api/v4/i18n/creation/snap/cbo_consistency_check/",
      "/api/v4/i18n/creation/ad_creative_snap/check/",
      "/api/v4/i18n/creation/snap/batch_create_cta_id/",
      "/api/v4/i18n/creation/async_creation/create_by_snap/",
      "/api/v4/i18n/creation/async_creation/detail/",
      "/api/v3/i18n/statistics/op/ad/list/",
    ]));
    expect(requested.find((item) => item.url.includes("ad_snap/save"))?.body)
      .toMatchObject({ campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" });
    expect(requested.find((item) => item.url.includes("create_by_snap"))?.body)
      .toMatchObject({ is_status_disabled: true, is_partial_publish: false, coming_source_type: 1 });
    expect(result[0]).toMatchObject({ campaignId: "campaign", adGroupId: "adgroup", adId: "creative" });

    // 创建流程不调 snap/save_by_sketch。
    //
    // 它是 2026-08-08 为修 uaa_campaign_automation_inconsistent_error 加的，前提是
    // 「automation 字段在建草稿之后才被归一化」；1.4.85 起保存时就按真机取值，前提没了。
    // 2026-08-27 真机抓包证明这一步本身就是分歧：一次完整成功创建里它一次都没出现，
    // 而且重铸会把 sketch_publish_source 带成 2，真机恒为 1。
    // （发布后台遗留草稿是另一条链路，那里用它是对的。）
    expect(requested.find((item) => item.url.includes("snap/save_by_sketch"))).toBeUndefined();
    expect(publishSource(requested)).toBe(1);
    const publish = requested.find((item) => item.url.includes("create_by_snap"))?.body as Record<string, unknown>;
    // 发布用的是建草稿时的那套 snap，不是重铸出来的。
    expect(publish).toMatchObject({
      campaign_snap_id: "campaign-snap",
      campaign_sketch_id: "campaign-sketch",
      sketch_publish_source: 1,
    });
    expect(publish.ad_and_creative_snap_info_list).toMatchObject([{
      ad_snap_id: "ad-snap",
      ad_sketch_id: "ad-sketch",
      creative_snap_info_list: [{
        creative_snap_id: "creative-snap",
        creative_sketch_id: "creative-sketch",
      }],
    }]);
  });

  // 克隆出来的广告继承源广告的开关状态，广告组开着而广告关着，整组投不出去。
  // 1.4.31 只把这段接在 copyCampaign / copyAdGroupToExistingCampaign 上，漏了
  // createFromPreset——而跨账户迁移走的正是这条，生产上因此有 9 个组「组开广告关」。
  it("createFromPreset 发布成功后显式开启新建的广告", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return jsonResponse(successfulCreationPayload(url));
    }));
    const context = creationTestContext(false);
    if (context.credential.kind !== "cookie" || !context.credential.requestTemplates) {
      throw new Error("test fixture must include cookie request templates");
    }
    context.credential.requestTemplates.push({
      target: "ad-status",
      action: "enable",
      url: "https://ads.tiktok.com/api/v4/i18n/ad/update_status/?aadvid=123456",
      method: "POST",
      body: '{"creative_id":"captured-ad","operation":"enable"}',
      contentType: "application/json",
    });

    const [result] = await new CookieAdsProvider().createFromPreset!(context, [{
      ...creationTestMutation("none"),
      initialStatus: "enabled",
    }]);

    expect(result).toMatchObject({ ok: true });
    const enables = requested.filter((item) => item.url.includes("/ad/update_status"));
    expect(enables).toHaveLength(1);
    // 开的是本次回读到的广告，不是广告组，也不是任何存量对象。
    expect(enables[0]?.body).toMatchObject({ creative_id: "creative", operation: "enable" });
  });

  it("createFromPreset 以 disabled 发布时不开启广告", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      return jsonResponse(successfulCreationPayload(url));
    }));
    const context = creationTestContext(false);
    if (context.credential.kind !== "cookie" || !context.credential.requestTemplates) {
      throw new Error("test fixture must include cookie request templates");
    }
    context.credential.requestTemplates.push({
      target: "ad-status",
      action: "enable",
      url: "https://ads.tiktok.com/api/v4/i18n/ad/update_status/?aadvid=123456",
      method: "POST",
      body: '{"creative_id":"captured-ad","operation":"enable"}',
      contentType: "application/json",
    });

    const [result] = await new CookieAdsProvider().createFromPreset!(
      context,
      [creationTestMutation("none")],
    );

    expect(result).toMatchObject({ ok: true });
    expect(requested.some((url) => url.includes("/ad/update_status"))).toBe(false);
  });

  it("stops before creative save when the HAR material lookup cannot resolve a code", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      // The library returns no entry for the unknown code.
      const body = url.includes("material/tt_video/bulk/info")
        ? { data: { tt_video_map: {} }, code: 0 }
        : successfulCreationPayload(url);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const mutation = creationTestMutation("none");
    mutation.row.videoCode = "#unmapped-code";

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result).toMatchObject({ ok: false, failureKind: "retryable", retrySafe: true });
    expect(requested.some((url) => url.includes("material/tt_video/bulk/info"))).toBe(true);
    expect(requested.some((url) => url.includes("ad_snap/save"))).toBe(false);
    expect(requested.some((url) => url.includes("creative_snap/save"))).toBe(false);
  });

  it("自动优化：按完整投放上下文提问，并只开启产品选定的三项", async () => {
    // 线上事故：只发 identity_type 时 TikTok 返回另一套可用列表（不含 CTA 100001
    // 与生成广告卡片 100002），这两项被误判成账户不支持而过滤掉，建出来的广告
    // 只剩「视频质量」。同账户同接口，参数不同答案就不同。
    let optionRequest: Record<string, unknown> | null = null;
    let creativeBody: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      let payload: Record<string, unknown>;
      if (url.includes("material/tt_video/bulk/info")) {
        payload = { code: 0, data: { tt_video_map: { "#lib-code": {
          item_id: "9998887776665", core_user_id: "spark-identity", video_info: { vid: "spark-video" },
        } } } };
      } else if (url.includes("material/tt_video/bulk/authorize")) {
        payload = { code: 0, data: { identity_id_map: { "#lib-code": "spark-identity" } } };
      } else if (url.includes("creative/creative_automation_option")) {
        optionRequest = body;
        payload = { code: 0, data: { strategy_ids: ["100001", "100002", "7419232909960003601", "7478954523433500688", "7455417586723028993"], group_strategies: [] } };
      } else {
        if (url.includes("creative_snap/save")) creativeBody = body;
        payload = sparkCreationPayload(url, body);
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const mutation = creationTestMutation("none");
    mutation.row.videoCode = "#lib-code";
    mutation.preset.videoPostMappings = [];
    mutation.preset.countryCodes = [1668284];
    mutation.preset.placementIds = [3000];

    await new CookieAdsProvider().createFromPreset!(creationTestContext(false), [mutation]);

    // 提问必须带上投放上下文，不能只有 identity_type。
    expect(optionRequest).toMatchObject({
      objective_type: expect.anything(),
      optimize_goal: mutation.preset.optimizeGoal,
      external_action: mutation.preset.externalAction,
      country_ids: ["1668284"],
      inventory_flows: [3000],
      identity_type: expect.anything(),
    });

    const asset = (creativeBody as unknown as {
      asset_group_sketch_form_data_list?: Array<Record<string, unknown>>;
    } | null)?.asset_group_sketch_form_data_list?.[0];
    // 只开 CTA(100001) + 生成广告卡片(100002) + 视频质量(7455…)；
    // 账户支持但产品没选的（翻译配音 7419…、音乐焕新 7478…）不得被带上。
    expect(asset?.creative_automation_list).toEqual(["100001", "100002", "7455417586723028993"]);
    expect(asset?.creative_automation_type).toBe(2);
  });

  it("自动优化：账户不支持的策略会被过滤，非空列表配 type=2", async () => {
    // 真机成功抓包：creative_automation_type=2 且列表 4 项（含翻译配音）。
    // 此前这里写死 type=1 并拿默认 3 项覆盖，TikTok 回
    // creative_automation_list_should_be_nil_error——type=1 不允许带列表。
    let creativeBody: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      let payload: Record<string, unknown>;
      if (url.includes("material/tt_video/bulk/info")) {
        payload = { code: 0, data: { tt_video_map: { "#lib-code": {
          item_id: "9998887776665", core_user_id: "spark-identity", video_info: { vid: "spark-video" },
        } } } };
      } else if (url.includes("material/tt_video/bulk/authorize")) {
        payload = { code: 0, data: { identity_id_map: { "#lib-code": "spark-identity" } } };
      } else if (url.includes("creative/creative_automation_option")) {
        // 账户支持这 4 项，其中 200001 不在创意列表里，不应被塞进去。
        payload = { code: 0, data: { strategy_ids: ["100001", "100002", "200001", "7419232909960003601", "7455417586723028993"], group_strategies: [] } };
      } else {
        if (url.includes("creative_snap/save")) creativeBody = body;
        payload = sparkCreationPayload(url, body);
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const mutation = creationTestMutation("none");
    mutation.row.videoCode = "#lib-code";
    mutation.preset.videoPostMappings = [];

    await new CookieAdsProvider().createFromPreset!(creationTestContext(false), [mutation]);

    const asset = (creativeBody as unknown as {
      asset_group_sketch_form_data_list?: Array<Record<string, unknown>>;
    } | null)?.asset_group_sketch_form_data_list?.[0];
    expect(asset?.creative_automation_type).toBe(2);
    // 账户支持但创意没选的策略不会被补进来。
    expect(asset?.creative_automation_list).not.toContain("200001");
    expect((asset?.creative_automation_list as string[]).length).toBeGreaterThan(0);
  });

  it("发布失败时把 TikTok 的原话带出来，而不是被 id 挤掉", async () => {
    // 线上事故：报错被 JSON.stringify(result).slice(0, 300) 从中间切断，
    // 真正的原因排在一堆 snap/sketch id 后面，每次都正好被切掉。
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const payload = url.includes("async_creation/detail")
        ? { code: 0, data: { status: 1, result: {
            campaign_name: "DM001636頸椎保護頸托低价测试",
            operation: 5,
            by_campaign_snap_id: "1874228203604017",
            by_campaign_sketch_id: "1874228215425474",
            ad_and_creative: { 0: {
              ad_name: "DM001636頸椎保護頸托低价测试",
              is_success: false,
              ad_error_items: [{
                starling_key: "uaa_campaign_automation_inconsistent_error",
                message: "自动优化设置与系列不一致，请检查后重试",
              }],
            } },
          } } }
        : successfulCreationPayload(url);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [creationTestMutation("none")],
    );

    expect(result?.ok).toBe(false);
    // starling_key 稳定可检索，message 才有细节，两个都要留下。
    expect(result?.message).toContain("uaa_campaign_automation_inconsistent_error");
    expect(result?.message).toContain("自动优化设置与系列不一致，请检查后重试");
    // 定位用的上下文仍然保留，但不再把原因挤出去。
    expect(result?.message).toContain("1874228203604017");
  });

  it("创建失败时留下实际发出的请求体，供与真机抓包逐字段比对", async () => {
    // 这条是「为什么改了无数次还是解决不掉」的解药。uaa_campaign_automation_inconsistent_error
    // 只说「这堆 automation 字段互相矛盾」，不说哪个字段错；此前失败记录里只有一串
    // snap/sketch id，报文长什么样全靠猜，于是每次补丁都是猜、每次都没治好。
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const payload = url.includes("async_creation/detail")
        ? { code: 0, data: { status: 1, result: {
            campaign_name: "campaign",
            operation: 5,
            ad_and_creative: { 0: {
              ad_name: "campaign",
              is_success: false,
              ad_error_items: [{
                starling_key: "uaa_campaign_automation_inconsistent_error",
                message: "自动优化设置与系列不一致，请检查后重试",
              }],
            } },
          } } }
        : successfulCreationPayload(url);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const progress: LaunchCreationProgress[] = [];
    const mutation = creationTestMutation("none");
    mutation.onProgress = (item) => progress.push(item);
    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );
    expect(result?.ok).toBe(false);

    const sent = progress.flatMap((item) => item.evidence.sentRequests ?? []);
    expect(sent.length).toBeGreaterThan(0);
    // 创意报文是 automation 元组的争议现场，必须在留证里。
    const creative = sent.find((item) => item.step.includes("creative_snap/save"));
    expect(creative, `留证里没有创意报文，实际步骤：${sent.map((s) => s.step).join(", ")}`)
      .toBeDefined();
    // 留的是报文原文，不是摘要——能直接 JSON.parse 出字段来比对才算数。
    const body = JSON.parse(creative!.body) as Record<string, unknown>;
    expect(Object.keys(body).length).toBeGreaterThan(0);

    // 绝不落库请求头：Cookie 与鉴权信息不能出现在留证里。
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain("Cookie");
    expect(serialized).not.toContain("sessionid");
  });

  it("发布前的检查步骤进留证；失败时不再静默消失", async () => {
    // 这四步（cbo_consistency_check / campaign_snap/check / ad_creative_snap/check /
    // batch_create_cta_id）是让草稿变得可发布的一环——8/8 的记录写着「草稿本身是好的，
    // 手动打开广告组页面等它加载完再点发布就能成功」，打开页面做的就是这几件事。
    // 此前它们不带 dispatchState（不进留证）且错误被 catch 吞掉，于是任何一步失败
    // 都表现成发布时的 automation 自相矛盾，现场却什么都不剩。
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("ad_creative_snap/check")) {
        return new Response(JSON.stringify({ code: 40001, message: "check rejected" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(successfulCreationPayload(url)), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }));

    const progress: LaunchCreationProgress[] = [];
    const mutation = creationTestMutation("none");
    mutation.onProgress = (item) => progress.push(item);
    await new CookieAdsProvider().createFromPreset!(creationTestContext(false), [mutation]);

    // 失败的那一步被点名报出来。
    const failures = progress.flatMap((item) => item.evidence.advisoryFailures ?? []);
    expect(failures).toContain("ad_creative_snap/check");
    // 四步全部进留证，而不是只在发布报文里留个结果。
    const steps = progress.flatMap((item) => item.evidence.sentRequests ?? []).map((s) => s.step);
    // campaign_snap/check 只在还没拿到 fake_campaign_id 时才跑，不是每次都有，故不断言。
    for (const step of [
      "snap/cbo_consistency_check",
      "ad_creative_snap/check",
      "snap/batch_create_cta_id",
    ]) {
      expect(steps, `${step} 不在留证里，实际：${steps.join(", ")}`).toContain(step);
    }
    // 它们必须排在发布之前——发布之后再对账没有意义。
    expect(steps.indexOf("ad_creative_snap/check")).toBeLessThan(steps.indexOf("create_by_snap"));
  });

  it("留证按上限截断，不让一条超长报文撑爆库", () => {
    const recorder = createSentRequestRecorder();
    recorder.record("huge", "x".repeat(SENT_REQUEST_BODY_LIMIT + 5_000));
    for (let index = 0; index < SENT_REQUEST_MAX_ENTRIES + 10; index += 1) {
      recorder.record(`step-${index}`, "{}");
    }
    const entries = recorder.drain();
    expect(entries.length).toBe(SENT_REQUEST_MAX_ENTRIES);
    expect(entries[0]?.body.length).toBeLessThan(SENT_REQUEST_BODY_LIMIT + 100);
    expect(entries[0]?.body).toContain("已截断 5000 字符");
    // undefined 请求体（GET）不占额度。
    const empty = createSentRequestRecorder();
    empty.record("get-step", undefined);
    expect(empty.drain()).toHaveLength(0);
  });

  it("授权码分批查询，不再一次性把整批码塞进一个请求", async () => {
    // 生产事故：一行 50 个码、或批量创建把 17 行的码汇总成 289 个，素材库接口回
    // 「Authorization codes queried at one time exceeds the upper limit」，整批全灭。
    // 广告组本身允许 50 条素材，但查询接口的单次上限小得多，两者不是一回事。
    const infoBatches: string[][] = [];
    const authorizeBatches: string[][] = [];
    const codes = Array.from({ length: 25 }, (_unused, index) => `#code-${index + 1}`);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      let payload: Record<string, unknown>;
      if (url.includes("material/tt_video/bulk/info")) {
        const list = body.video_code_list as string[];
        infoBatches.push(list);
        payload = { code: 0, data: { tt_video_map: Object.fromEntries(list.map((code) => [code, {
          item_id: `item-${code}`,
          core_user_id: "spark-identity",
          video_info: { vid: `vid-${code}` },
        }])) } };
      } else if (url.includes("material/tt_video/bulk/authorize")) {
        const list = (body.auth_code_info_list as Array<{ auth_code: string }>).map((item) => item.auth_code);
        authorizeBatches.push(list);
        payload = { code: 0, data: { identity_id_map: Object.fromEntries(list.map((code) => [code, "spark-identity"])) } };
      } else {
        payload = sparkCreationPayload(url, body);
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const mutation = creationTestMutation("none");
    mutation.row.videoCode = codes.join(";");
    mutation.preset.videoPostMappings = [];

    await new CookieAdsProvider().createFromPreset!(creationTestContext(false), [mutation]);

    // 25 个码切成 20 + 5，没有任何一批超过 TikTok 的单次 20 条上限。
    expect(infoBatches).toHaveLength(2);
    expect(infoBatches.map((batch) => batch.length)).toEqual([20, 5]);
    expect(authorizeBatches.map((batch) => batch.length)).toEqual([20, 5]);
    expect(infoBatches.every((batch) => batch.length <= 20)).toBe(true);
    // 切批不能丢码，也不能重复。
    expect(infoBatches.flat()).toEqual(codes);
    expect(authorizeBatches.flat()).toEqual(codes);
  });

  it("解析不到的授权码自动跳过，用其余素材继续创建并报出跳过的码", async () => {
    // 一行可以挂 50 个码，人工排查「是哪一个没授权」成本极高；坏码跳过、好码照建。
    let creativeBody: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      let payload: Record<string, unknown>;
      if (url.includes("material/tt_video/bulk/info")) {
        // #bad-code 在素材库里查不到，其余两个正常。
        const list = (body.video_code_list as string[]).filter((code) => code !== "#bad-code");
        payload = { code: 0, data: { tt_video_map: Object.fromEntries(list.map((code) => [code, {
          item_id: `item-${code}`,
          core_user_id: "spark-identity",
          video_info: { vid: `vid-${code}` },
        }])) } };
      } else if (url.includes("material/tt_video/bulk/authorize")) {
        const list = (body.auth_code_info_list as Array<{ auth_code: string }>).map((item) => item.auth_code);
        payload = { code: 0, data: { identity_id_map: Object.fromEntries(list.map((code) => [code, "spark-identity"])) } };
      } else {
        if (url.includes("creative_snap/save")) creativeBody = body;
        payload = sparkCreationPayload(url, body);
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const mutation = creationTestMutation("none");
    mutation.row.videoCode = "#good-1;#bad-code;#good-2";
    mutation.preset.videoPostMappings = [];

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    // 坏码没有毙掉整行。
    expect(result).toMatchObject({ ok: true });
    // 跳过必须可见：界面按「素材提示 / 已跳过 N 条素材」匹配汇总。
    expect(result?.warning).toContain("素材提示");
    expect(result?.warning).toContain("已跳过 1 条素材");
    expect(result?.warning).toContain("#bad-code");
    // 只有两条好素材进入创意，坏码不会以任何形式混进去。
    const assets = (creativeBody as unknown as { asset_group_sketch_form_data_list?: Array<Record<string, unknown>> } | null)
      ?.asset_group_sketch_form_data_list?.[0];
    expect((assets?.image_list as unknown[])?.length).toBe(2);
    expect(JSON.stringify(assets?.title_list)).not.toContain("bad-code");
  });

  it("整行授权码全部解析不到时仍然失败，不建空广告组", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const payload = url.includes("material/tt_video/bulk/info")
        ? { code: 0, data: { tt_video_map: {} } }
        : sparkCreationPayload(url);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const mutation = creationTestMutation("none");
    mutation.row.videoCode = "#bad-1;#bad-2";
    mutation.preset.videoPostMappings = [];

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result).toMatchObject({ ok: false, failureKind: "retryable" });
    expect(result?.message).toContain("全部无法在素材库中解析到帖子");
    expect(result?.message).toContain("#bad-1");
  });

  it("runs the successful HAR Spark authorization sequence before saving the creative", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const body = url.includes("material/tt_video/bulk/info")
        ? { data: { tt_video_map: { "#lib-code": {
            item_id: "9998887776665",
            core_user_id: "spark-identity",
            video_info: { vid: "spark-video" },
          } } }, code: 0 }
        : url.includes("material/tt_video/bulk/authorize")
          ? { data: { identity_id_map: { "#lib-code": "spark-identity" } }, code: 0 }
          : url.includes("spark/validate_promote_music")
            ? { data: { music_info_map: { "9998887776665": { status: 0 } } }, code: 0 }
            : url.includes("creative/creative_automation_option")
              ? { data: {
                  strategy_ids: [
                    "100001",
                    "100002",
                    "200001",
                    "7419232909960003601",
                    "7455417586723028993",
                    "7478954523433500688",
                  ],
                  group_strategies: [],
                }, code: 0 }
              : url.includes("spark/creative_fix_task/save")
                ? { data: { task_map: { "spark-video": "spark-task" } }, code: 0 }
                : url.includes("spark/creative_fix_task/info")
                  ? { data: { task_info_map: { "spark-task": { task_status: 2 } } }, code: 0 }
                  : url.includes("/creative_snap/check/")
                    ? { data: { success: true }, code: 0 }
                    : successfulCreationPayload(url);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const mutation = creationTestMutation("none");
    mutation.row.videoCode = "#lib-code";
    mutation.preset.videoPostMappings = [];
    mutation.preset.countryCodes = [1668284];

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result).toMatchObject({ ok: true });
    const paths = requested.map((item) => new URL(item.url).pathname);
    const indexOf = (path: string) => paths.indexOf(path);
    expect(indexOf("/api/v4/i18n/creation/material/tt_video/bulk/info/")).toBeLessThan(indexOf("/api/v4/i18n/creation/material/tt_video/bulk/authorize/"));
    expect(indexOf("/api/v4/i18n/creation/material/tt_video/bulk/authorize/")).toBeLessThan(indexOf("/api/v4/i18n/creation/campaign_snap/save/"));
    expect(indexOf("/api/v4/i18n/creation/campaign_snap/save/")).toBeLessThan(indexOf("/api/v4/i18n/creation/campaign_snap/check/"));
    expect(indexOf("/api/v4/i18n/creation/campaign_snap/check/")).toBeLessThan(indexOf("/api/v4/i18n/creation/ad_snap/save/"));
    expect(indexOf("/api/v4/i18n/creation/ad_snap/save/")).toBeLessThan(indexOf("/api/v4/i18n/creation/ad_snap/bulk_check/"));
    expect(indexOf("/api/v4/i18n/creation/ad_snap/bulk_check/")).toBeLessThan(indexOf("/api/v4/i18n/creation/spark/validate_promote_music/"));
    expect(indexOf("/api/v4/i18n/creation/spark/validate_promote_music/")).toBeLessThan(indexOf("/api/v4/i18n/creation/spark/creative_fix_task/save/"));
    expect(indexOf("/api/v4/i18n/creation/spark/creative_fix_task/save/")).toBeLessThan(indexOf("/api/v4/i18n/creation/roi2/auction_batch_item_roi2_validate/"));
    expect(indexOf("/api/v4/i18n/creation/roi2/auction_batch_item_roi2_validate/")).toBeLessThan(indexOf("/api/v4/i18n/creation/spark/creative_fix_task/info/"));
    expect(indexOf("/api/v4/i18n/creation/spark/creative_fix_task/info/")).toBeLessThan(indexOf("/api/v4/i18n/creation/creative_snap/save/"));
    expect(paths).not.toContain("/api/v4/i18n/creation/creative_snap/check/");
    expect(indexOf("/api/v4/i18n/creation/creative_snap/save/")).toBeLessThan(indexOf("/api/v4/i18n/creation/ad_creative_snap/check/"));
    expect(indexOf("/api/v4/i18n/creation/ad_creative_snap/check/")).toBeLessThan(indexOf("/api/v4/i18n/creation/snap/batch_create_cta_id/"));
    expect(indexOf("/api/v4/i18n/creation/snap/batch_create_cta_id/")).toBeLessThan(indexOf("/api/v4/i18n/creation/async_creation/create_by_snap/"));

    expect(requested.find((item) => item.url.includes("bulk/authorize"))?.body).toEqual({
      auth_code_info_list: [{ auth_code: "#lib-code" }],
      is_check: false,
    });
    expect(requested.find((item) => item.url.includes("validate_promote_music"))?.body).toMatchObject({
      countries: [1668284],
      post_list: [{ item_id: "9998887776665", identity_id: "spark-identity", identity_type: 2 }],
    });
    // 提问要带完整投放上下文；只发 identity_type 会让 TikTok 返回另一套可用列表。
    expect(requested.find((item) => item.url.includes("creative_automation_option"))?.body)
      .toMatchObject({ identity_type: 2, objective_type: expect.anything(), inventory_flows: expect.any(Array) });
    expect(requested.find((item) => item.url.includes("creative_fix_task/save"))?.body).toEqual({
      creative_fix_vid_list: ["spark-video"],
      country_list: ["TW"],
    });
    expect(requested.find((item) => item.url.includes("creative_fix_task/info"))?.body).toEqual({
      task_id_list: ["spark-task"],
    });
    expect(requested.find((item) => item.url.includes("auction_batch_item_roi2_validate"))?.body).toMatchObject({
      ad_infos: [],
      campaign_info: { objective_type: 1 },
      smart_plus_plus_info: {
        ad_id: "",
        ad_snap_id: "ad-snap",
        campaign_id: "",
        campaign_snap_id: "campaign-snap",
        creative_info: expect.objectContaining({ identity_type: 2, item_source: 2 }),
      },
    });

    const creativeSave = requested.find((item) => item.url.includes("creative_snap/save"));
    expect((creativeSave?.body.asset_group_sketch_form_data_list as Array<{ image_list: Array<Record<string, unknown>> }>)[0]!.image_list[0]).toMatchObject({
      aweme_item_id: "9998887776665",
      identity_id: "spark-identity",
      identity_type: 2,
      item_source: 2,
    });
    expect((creativeSave?.body.asset_group_sketch_form_data_list as Array<Record<string, unknown>>)[0]).toMatchObject({
      creative_automation_type: 2,
      creative_automation_list: ["100001", "100002", "7455417586723028993"],
      catalog_setup: 0,
      need_create_cta_id: true,
    });
    expect(requested.some((item) =>
      new URL(item.url).pathname === "/api/v4/i18n/creation/creative_snap/check/"
    )).toBe(false);
  });

  it("creates from verified target-account posts without video-code lookup or authorization fallback", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const body = url.includes("snap/get_creative_fields_by_ad")
        ? { code: 0, data: { result_map: {
            "formal-asset-group": { image_list: [{ aweme_item_id: "target-post" }] },
          } } }
        : url.includes("/statistics/op/ad/list") && successfulCreationCompleted
          ? completeListPayload([])
          : url.includes("spark/validate_promote_music")
        ? { data: { music_info_map: { "target-post": { status: 0 } } }, code: 0 }
        : url.includes("creative/creative_automation_option")
          ? { data: {
              strategy_ids: ["strategy-video", "strategy-image"],
              group_strategies: [],
            }, code: 0 }
          : url.includes("spark/creative_fix_task/save")
            ? { data: { task_map: { "target-vid": "spark-task" } }, code: 0 }
            : url.includes("spark/creative_fix_task/info")
              ? { data: { task_info_map: { "spark-task": { task_status: 2 } } }, code: 0 }
              : successfulCreationPayload(url);
      return jsonResponse(body);
    }));
    const mutation = creationTestMutation("none");
    mutation.preset = { ...mutation.preset, objectiveType: 3 };
    mutation.row.videoCode = "#must-not-be-resolved";
    mutation.originalPosts = [{
      itemId: "target-post",
      identityId: "target-identity",
      identityType: 5,
      identityBcId: "77",
      vid: "target-vid",
      videoId: null,
      displayName: "目标账户原帖",
      coverUrl: null,
      promotable: true,
    }];
    mutation.originalProductInfo = {
      promo_code_infos: [{ code: "", code_type: 2, value: 718, currency: "TWD", include_type: 2 }],
      is_auto_use: 2,
      auto_select_toggle: 0,
      image_infos: [],
      selling_points_by_types: [],
    };
    mutation.originalCatalogSetup = 0;

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result).toMatchObject({ ok: true, adId: "formal-asset-group" });
    expect(result).not.toHaveProperty("warning");
    const paths = requested.map((item) => new URL(item.url).pathname);
    expect(paths).toContain("/mi/api/v4/i18n/creation/campaign_snap/copy/");
    expect(paths.some((path) => path.includes("/material/tt_video/"))).toBe(false);
    expect(paths.some((path) => path.includes("/upload/"))).toBe(false);
    expect(requested.find((item) => item.url.includes("validate_promote_music"))?.body)
      .toMatchObject({
        post_list: [{
          item_id: "target-post",
          identity_id: "target-identity",
          identity_type: 5,
          identity_bc_id: "77",
        }],
      });
    expect(requested.find((item) => item.url.includes("creative_automation_option"))?.body)
      .toMatchObject({ identity_type: 5, objective_type: expect.anything() });
    const creativeBody = requested.find((item) => item.url.includes("creative_snap/save"));
    const asset = (creativeBody?.body.asset_group_sketch_form_data_list as Array<{
      image_list: Array<Record<string, unknown>>;
    }>)[0]!;
    expect(asset.image_list).toEqual([expect.objectContaining({
      aweme_item_id: "target-post",
      identity_id: "target-identity",
      identity_type: 5,
      identity_bc_id: "77",
    })]);
    expect(asset).not.toHaveProperty("identity_type");
    expect(asset).not.toHaveProperty("identity_id");
    expect(asset).not.toHaveProperty("item_source");
    expect(asset).not.toHaveProperty("spc_multi_ad_mode");
    expect(asset).toMatchObject({
      ad_level2_identity_structure: 1,
      spc_upgrade_mode: 1,
      creative_automation_type: 1,
      catalog_setup: 0,
      product_info: {
        promo_code_infos: [{ code: "", code_type: 2, value: 718, currency: "TWD", include_type: 2 }],
      },
    });
    expect(asset).not.toHaveProperty("creative_automation_list");
    expect(creativeBody?.body).toMatchObject({ spc_upgrade_mode: 1 });
  });

  it("initializes an account-post migration from the reused formal campaign before adding another ad group", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const body = url.includes("adgroup/list") && successfulCreationCompleted
        ? completeListPayload([{
            campaign_id: "source-campaign",
            ad_id: "adgroup",
            ad_name: "group",
          }])
        : url.includes("/statistics/op/ad/list") && successfulCreationCompleted
          ? completeListPayload([{
              campaign_id: "source-campaign",
              ad_id: "adgroup",
              creative_id: "creative",
              creative_name: "260717:001",
            }])
          : url.includes("spark/validate_promote_music")
        ? { data: { music_info_map: { "target-post": { status: 0 } } }, code: 0 }
        : url.includes("creative/creative_automation_option")
          ? { data: { strategy_ids: [], group_strategies: [] }, code: 0 }
          : url.includes("spark/creative_fix_task/save")
            ? { data: { task_map: { "target-vid": "spark-task" } }, code: 0 }
            : url.includes("spark/creative_fix_task/info")
              ? { data: { task_info_map: { "spark-task": { task_status: 2 } } }, code: 0 }
              : successfulCreationPayload(url);
      return jsonResponse(body);
    }));
    const mutation = creationTestMutation("none");
    mutation.row.campaignName = "source";
    mutation.row.videoCode = "#must-not-be-resolved";
    mutation.preset = { ...mutation.preset, objectiveType: 3 };
    mutation.originalPosts = [{
      itemId: "target-post",
      identityId: "target-identity",
      identityType: 5,
      identityBcId: "77",
      vid: "target-vid",
      videoId: null,
      displayName: "目标账户原帖",
      coverUrl: null,
      promotable: true,
    }];

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result).toMatchObject({ ok: true, campaignId: "source-campaign" });
    const paths = requested.map((item) => new URL(item.url).pathname);
    expect(paths).toContain("/api/v4/i18n/creation/ad_snap/copy/");
    expect(paths).not.toContain("/mi/api/v4/i18n/creation/campaign_snap/copy/");
    expect(paths).not.toContain("/api/v4/i18n/creation/campaign_snap/save/");
    expect(requested.find((item) => item.url.includes("ad_snap/copy"))?.body).toMatchObject({
      existing_campaign_id: "source-campaign",
      copy_ad_id_to_existing_campaign: true,
      ad_params: [{ ad_id: "source-adgroup", name_list: ["group"] }],
    });
    expect(requested.find((item) => item.url.includes("ad_snap/save"))?.body).toMatchObject({
      campaign_id: "source-campaign",
      campaign_snap_id: "",
      campaign_sketch_id: "",
    });
    expect(requested.find((item) => item.url.includes("async_creation/create_by_snap"))?.body)
      .toMatchObject({ campaign_id: "source-campaign", is_partial_publish: true });
  });

  it("does not save a creative when TikTok does not confirm the authorization identity", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("material/tt_video/bulk/info")) {
        return jsonResponse({ code: 0, data: { tt_video_map: { "#lib-code": {
          item_id: "9998887776665",
          core_user_id: "spark-identity",
          video_info: { vid: "spark-video" },
        } } } });
      }
      if (url.includes("material/tt_video/bulk/authorize")) {
        return jsonResponse({ code: 0, data: { identity_id_map: {} } });
      }
      return jsonResponse(successfulCreationPayload(url));
    }));
    const mutation = creationTestMutation("none");
    mutation.row.videoCode = "#lib-code";
    mutation.preset.videoPostMappings = [];

    const [result] = await new CookieAdsProvider().createFromPreset!(creationTestContext(false), [mutation]);

    expect(result).toMatchObject({ ok: false, failureKind: "retryable" });
    expect(requested.some((url) => url.includes("bulk/authorize"))).toBe(true);
    expect(requested.some((url) => url.includes("creative_fix_task"))).toBe(false);
    expect(requested.some((url) => url.includes("creative_snap/save"))).toBe(false);
  });

  it("does not authorize or save a creative when bulk info omits its Spark identity", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("material/tt_video/bulk/info")) {
        return jsonResponse({ code: 0, data: { tt_video_map: { "#lib-code": {
          item_id: "9998887776665",
          video_info: { vid: "spark-video" },
        } } } });
      }
      return jsonResponse(successfulCreationPayload(url));
    }));
    const mutation = creationTestMutation("none");
    mutation.row.videoCode = "#lib-code";
    mutation.preset.videoPostMappings = [];

    const [result] = await new CookieAdsProvider().createFromPreset!(creationTestContext(false), [mutation]);

    expect(result).toMatchObject({ ok: false, failureKind: "retryable", retrySafe: true });
    expect(requested.some((url) => url.includes("bulk/info"))).toBe(true);
    expect(requested.some((url) => url.includes("campaign_snap/save"))).toBe(false);
    expect(requested.some((url) => url.includes("bulk/authorize"))).toBe(false);
    expect(requested.some((url) => url.includes("creative_snap/save"))).toBe(false);
  });

  it.each([
    ["returns a failed item", "failed-item"],
    ["rejects the advisory request", "rejected-request"],
    ["cannot complete the advisory request", "request-error"],
  ])("continues the successful HAR flow when music validation %s", async (_label, musicOutcome) => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("material/tt_video/bulk/info")) {
        return jsonResponse({ code: 0, data: { tt_video_map: { "#lib-code": {
          item_id: "9998887776665",
          core_user_id: "spark-identity",
          video_info: { vid: "spark-video" },
        } } } });
      }
      if (url.includes("material/tt_video/bulk/authorize")) {
        return jsonResponse({ code: 0, data: { identity_id_map: { "#lib-code": "spark-identity" } } });
      }
      if (url.includes("spark/validate_promote_music")) {
        if (musicOutcome === "request-error") throw new TypeError("music validation unavailable");
        if (musicOutcome === "rejected-request") {
          return jsonResponse({ code: 40001, msg: "music validation rejected" });
        }
        return jsonResponse({ code: 0, data: { music_info_map: { "9998887776665": { status: 1 } } } });
      }
      if (url.includes("spark/creative_fix_task/save")) {
        return jsonResponse({ code: 0, data: { task_map: { "spark-video": "spark-task" } } });
      }
      if (url.includes("spark/creative_fix_task/info")) {
        return jsonResponse({ code: 0, data: { task_info_map: { "spark-task": { task_status: 2 } } } });
      }
      return jsonResponse(successfulCreationPayload(url));
    }));
    const mutation = creationTestMutation("none");
    mutation.row.videoCode = "#lib-code";
    mutation.preset.videoPostMappings = [];

    const [result] = await new CookieAdsProvider().createFromPreset!(creationTestContext(false), [mutation]);

    expect(result).toMatchObject({ ok: true, campaignId: "campaign", adGroupId: "adgroup", adId: "creative" });
    expect(requested.some((url) => url.includes("validate_promote_music"))).toBe(true);
    expect(requested.some((url) => url.includes("creative_fix_task"))).toBe(true);
    expect(requested.some((url) => url.includes("creative_snap/save"))).toBe(true);
    expect(requested.some((url) => url.includes("async_creation/create_by_snap"))).toBe(true);
  });

  it.each([
    ["creative automation option", "/api/v4/i18n/creation/creative/creative_automation_option/"],
    ["Spark fix task save", "/api/v4/i18n/creation/spark/creative_fix_task/save/"],
    ["ROI validation", "/api/v4/i18n/creation/roi2/auction_batch_item_roi2_validate/"],
    ["Spark fix task status", "/api/v4/i18n/creation/spark/creative_fix_task/info/"],
  ])("publishes when the advisory %s request is rejected", async (_label, rejectedPath) => {
    const requestedPaths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const pathname = new URL(url).pathname;
      requestedPaths.push(pathname);
      if (url.includes("material/tt_video/bulk/info")) {
        return jsonResponse({ code: 0, data: { tt_video_map: { "#lib-code": {
          item_id: "9998887776665",
          core_user_id: "spark-identity",
          video_info: { vid: "spark-video" },
        } } } });
      }
      if (url.includes("material/tt_video/bulk/authorize")) {
        return jsonResponse({ code: 0, data: { identity_id_map: { "#lib-code": "spark-identity" } } });
      }
      if (pathname === rejectedPath) return jsonResponse({ code: 40001, msg: "advisory rejected" });
      if (url.includes("spark/creative_fix_task/save")) {
        return jsonResponse({ code: 0, data: { task_map: { "spark-video": "spark-task" } } });
      }
      if (url.includes("spark/creative_fix_task/info")) {
        return jsonResponse({ code: 0, data: { task_info_map: { "spark-task": { task_status: 2 } } } });
      }
      return jsonResponse(successfulCreationPayload(url));
    }));
    const mutation = creationTestMutation("none");
    mutation.row.videoCode = "#lib-code";
    mutation.preset.videoPostMappings = [];

    const [result] = await new CookieAdsProvider().createFromPreset!(creationTestContext(false), [mutation]);

    expect(result).toMatchObject({ ok: true, campaignId: "campaign", adGroupId: "adgroup", adId: "creative" });
    expect(requestedPaths).toContain(rejectedPath);
    expect(requestedPaths).toContain("/api/v4/i18n/creation/creative_snap/save/");
    expect(requestedPaths).toContain("/api/v4/i18n/creation/async_creation/create_by_snap/");
  });

  it("publishes when the advisory final ad report is red", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("ad_creative_snap/check")) {
        return jsonResponse({ code: 0, data: {
          creative_success: true,
          ad_snap_check_report_map: { "ad-snap": { success: false, ad_snap_id: "ad-snap" } },
        } });
      }
      return jsonResponse(successfulCreationPayload(url));
    }));

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [creationTestMutation("none")],
    );

    expect(result).toMatchObject({ ok: true, campaignId: "campaign", adGroupId: "adgroup", adId: "creative" });
    expect(requested.some((url) => url.includes("ad_creative_snap/check"))).toBe(true);
    expect(requested.some((url) => url.includes("batch_create_cta_id"))).toBe(true);
    expect(requested.some((url) => url.includes("create_by_snap"))).toBe(true);
  });

  it.each([
    {
      label: "campaign check",
      pathname: "/api/v4/i18n/creation/campaign_snap/check/",
      response: { code: 0, data: { success: false } },
    },
    {
      label: "ad-group check",
      pathname: "/api/v4/i18n/creation/ad_snap/bulk_check/",
      response: { code: 0, data: { ad_snap_check_report_map: { "ad-snap": { success: false } } } },
    },
    {
      label: "campaign and ad-group consistency check",
      pathname: "/api/v4/i18n/creation/snap/cbo_consistency_check/",
      response: { code: 0, data: { is_all_success: false } },
    },
    {
      label: "final ad and creative check",
      pathname: "/api/v4/i18n/creation/ad_creative_snap/check/",
      response: { code: 0, data: { creative_success: true, ad_snap_check_report_map: {} } },
    },
    {
      label: "CTA helper",
      pathname: "/api/v4/i18n/creation/snap/batch_create_cta_id/",
      response: { code: 40001, msg: "advisory rejected" },
    },
  ])("continues when the HAR $label response is red or incomplete", async ({ pathname, response }) => {
    const requestedPaths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const currentPath = new URL(url).pathname;
      requestedPaths.push(currentPath);
      return jsonResponse(currentPath === pathname ? response : successfulCreationPayload(url));
    }));

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [creationTestMutation("none")],
    );

    expect(result).toMatchObject({ ok: true, campaignId: "campaign", adGroupId: "adgroup", adId: "creative" });
    expect(requestedPaths).toContain(pathname);
    expect(requestedPaths).toContain("/api/v4/i18n/creation/async_creation/create_by_snap/");
  });

  it("rejects an exact-name ad-group collision without silently adding a suffix", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (url.includes("adgroup/list")) {
        return jsonResponse({ code: 0, data: { table: [
          { campaign_id: "source-campaign", campaign_name: "source", campaign_status: "enabled", adgroup_id: "existing-group", adgroup_name: "group" },
          { campaign_id: "source-campaign", campaign_name: "source", campaign_status: "enabled", adgroup_id: "existing-group-001", adgroup_name: "group-001" },
        ], pagination: { page: 1, page_count: 1 } } });
      }
      if (url.includes("creative_snap/save")) {
        return jsonResponse({ code: 0, data: {
          creative_snap_ids: ["creative-snap"],
          creative_sketch_ids: ["creative-sketch"],
        } });
      }
      if (new URL(url).pathname === "/api/v4/i18n/creation/creative_snap/check/") {
        return jsonResponse({ code: 2, msg: "页面信息已过期。刷新页面重试。" });
      }
      return jsonResponse(successfulCreationPayload(url));
    }));
    const mutation = creationTestMutation("none");
    mutation.row.campaignName = "source";

    const [result] = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [mutation],
    );

    expect(result).toMatchObject({ ok: false, failureKind: "retryable", retrySafe: true });
    expect(result?.message).toContain("不会擅自改名");
    const bodyFor = (fragment: string) => requested.find((item) => item.url.includes(fragment))?.body;
    expect(bodyFor("campaign_snap/copy")).toBeUndefined();
    expect(bodyFor("campaign_snap/save")).toBeUndefined();
    expect(bodyFor("ad_snap/save")).toBeUndefined();
    expect(bodyFor("creative_snap/save")).toBeUndefined();
    expect(bodyFor("create_by_snap")).toBeUndefined();
  });

  it("discovers an exact-name formal campaign independently from the captured ad dimension", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    let completed = false;
    const context = creationTestContext(false);
    if (context.credential.kind !== "cookie" || !context.credential.requestTemplates?.[0]) {
      throw new Error("test fixture must include a list request");
    }
    context.credential.requestTemplates[0] = {
      ...context.credential.requestTemplates[0],
      body: JSON.stringify({
        common_req: {
          st: "2026-07-22",
          et: "2026-07-24",
          lifetime: 0,
          dimensions: ["ad_id"],
          metrics: ["stat_cost"],
          filters: [{ field: "ad_status", in_field_values: ["delete"], filter_type: 10 }],
          page: 1,
          page_size: 20,
        },
      }),
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requested.push({ url, body });
      if (url.includes("statistics/sketch/")) {
        return jsonResponse(emptySketchListPayload());
      }
      if (url.includes("/statistics/op/campaign/list")) {
        const commonRequest = body.common_req as Record<string, unknown> | undefined;
        const filters = Array.isArray(commonRequest?.filters)
          ? commonRequest.filters as Array<Record<string, unknown>>
          : [];
        const isCampaignObjectList = JSON.stringify(commonRequest?.dimensions) === JSON.stringify(["campaign_id"])
          && JSON.stringify(commonRequest?.metrics) === JSON.stringify([])
          && filters.some((item) => item.field === "campaign_status" && item.filter_type === 10)
          && filters.some((item) => item.field === "campaign_system_origin" && item.filter_type === 0);
        return jsonResponse({ code: 0, data: {
          table: isCampaignObjectList
            ? [{ campaign_id: "lifetime-campaign", campaign_name: "old-campaign" }]
            : [],
          pagination: { page: 1, page_count: 1, limit: 100, total_count: 1 },
        } });
      }
      if (url.includes("adgroup/list")) {
        return jsonResponse(completeListPayload(completed
          ? [{ campaign_id: "lifetime-campaign", ad_id: "adgroup", ad_name: "group" }]
          : []));
      }
      if (url.includes("/statistics/op/ad/list")) {
        return jsonResponse(completeListPayload(completed
          ? [{ campaign_id: "lifetime-campaign", ad_id: "adgroup", creative_id: "creative", creative_name: "260717:001" }]
          : []));
      }
      if (url.includes("async_creation/detail")) {
        completed = true;
        return jsonResponse({ code: 0, data: { status: 1, result: {
          campaign_id: "lifetime-campaign",
          ad_and_creative: { 0: { by_ad_snap_id: "ad-snap", ad_id: "adgroup", asset_group_result: {
            0: { creative_items: [{ id: "creative" }] },
          } } },
        } } });
      }
      return jsonResponse(successfulCreationPayload(url));
    }));
    const mutation = creationTestMutation("none");
    mutation.row.campaignName = "old-campaign";

    const [result] = await new CookieAdsProvider().createFromPreset!(context, [mutation]);

    expect(result).toMatchObject({ ok: true, campaignId: "lifetime-campaign" });
    expect(requested.find((item) => item.url.includes("/statistics/op/campaign/list"))?.body).toMatchObject({
      common_req: {
        dimensions: ["campaign_id"],
        metrics: [],
        lifetime: 0,
        filters: [
          { field: "campaign_status", in_field_values: ["delete"], filter_type: 10 },
          { field: "campaign_system_origin", in_field_values: ["100000"], filter_type: 0 },
        ],
      },
    });
    expect(requested.some((item) => item.url.includes("campaign_snap/save"))).toBe(false);
    expect(requested.find((item) => item.url.includes("ad_snap/save"))?.body).toMatchObject({
      campaign_id: "lifetime-campaign",
      campaign_snap_id: "",
      campaign_sketch_id: "",
    });
  });

  it("checks every campaign and ad-group page before rejecting an exact-name collision", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requested.push({ url, body: requestBody });
      const commonRequest = requestBody.common_req as Record<string, unknown> | undefined;
      const page = Number(commonRequest?.page ?? new URL(url).searchParams.get("page") ?? "1");
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

    expect(result).toMatchObject({ ok: false, failureKind: "retryable", retrySafe: true });
    expect(result?.message).toContain("不会擅自改名");
    const adSave = requested.find((item) => item.url.includes("ad_snap/save"));
    expect(adSave).toBeUndefined();
    expect(requested.filter((item) => item.url.includes("/statistics/op/campaign/list/")).length).toBe(2);
    expect(requested.filter((item) => item.url.includes("/statistics/op/adgroup/list/")).length).toBe(2);
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

  it("rejects duplicate ad-group names in one same-series batch before any remote request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const first = creationTestMutation("none");
    const second = creationTestMutation("none");
    second.row.adName = "260717:002";
    const results = await new CookieAdsProvider().createFromPreset!(
      creationTestContext(false),
      [first, second],
    );

    expect(results).toHaveLength(2);
    expect(results.every((result) => !result.ok && result.failureKind === "retryable")).toBe(true);
    expect(results[0]?.message).toContain("重复广告组名称");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("continues later same-campaign calls after a failed result in the same plan", async () => {
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

    const [unknown] = await provider.createFromPreset!(creationTestContext(false), [first]);
    const callsAfterFirst = fetchMock.mock.calls.length;
    const [continued] = await provider.createFromPreset!(creationTestContext(false), [second]);

    expect(unknown).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(continued).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(continued?.message).not.toContain("前一条同系列任务结果未知");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("creates a new campaign directly even when the preset still contains a template campaign id", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requested.push({ url, body });
      if (url.includes("ad_snap/save")) {
        return jsonResponse({ code: 0, data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" } });
      }
      if (url.includes("ad_snap/bulk_check")) {
        return jsonResponse({ code: 0, data: {
          ad_snap_check_report_map: { "ad-snap": { success: true, ad_snap_id: "ad-snap" } },
        } });
      }
      if (url.includes("creative_snap/save")) {
        return jsonResponse({ code: 0, data: { creative_snap_id: "creative-snap", creative_sketch_id: "creative-sketch" } });
      }
      return jsonResponse(successfulCreationPayload(url));
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
    expect(requested.some((item) => item.url.includes("campaign_snap/copy"))).toBe(false);
    const campaignSave = requested.find((item) => item.url.includes("campaign_snap/save"));
    expect(campaignSave?.body.campaign_sketch_form_data).toMatchObject({
      campaign_name: "campaign",
      objective_type: 1,
      industry_types: [],
    });
    const adSave = requested.find((item) => item.url.includes("ad_snap/save"));
    expect(adSave?.body.ad_sketch_form_data).toMatchObject({
      ad_name: "group",
      pricing: 1,
      bid: "",
      objective_type: 1,
      inventory_flow: [1],
      inventory_flow_type: 1,
      classify: 1,
      language_list: [],
      gender: 0,
      age: [],
      ac: [],
      ad_tag_v2: [],
      video_actions_v2: [],
      zipcode_ids: [],
      week_schedule: [[], [], [], [], [], [], []],
    });
    const creativeSave = requested.find((item) => item.url.includes("creative_snap/save"));
    expect((creativeSave?.body.asset_group_sketch_form_data_list as Array<Record<string, unknown>>)[0]).toMatchObject({
      creative_name: "260717:001",
      identity_type: 1,
    });
  });

  it("normalizes the verified oCPM bidding tuple when initialized draft defaults differ", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requested.push({ url, body });
      if (url.includes("campaign_snap/save")) {
        return jsonResponse({ code: 0, data: { campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" } });
      }
      if (url.includes("campaign_snap/check")) {
        return jsonResponse({ code: 0, data: { success: true, fake_campaign_id: "campaign-sketch" } });
      }
      if (url.includes("ad_snap/save")) {
        return jsonResponse({ code: 0, data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" } });
      }
      if (url.includes("ad_snap/bulk_check")) {
        return jsonResponse({ code: 0, data: {
          ad_snap_check_report_map: { "ad-snap": { success: true, ad_snap_id: "ad-snap" } },
        } });
      }
      if (url.includes("creative_snap/save")) {
        return jsonResponse({ code: 0, data: { creative_snap_id: "creative-snap", creative_sketch_id: "creative-sketch" } });
      }
      return jsonResponse(successfulCreationPayload(url));
    }));
    const context = creationTestContext(true);
    if (context.credential.kind !== "cookie" || !context.credential.creationProfile) {
      throw new Error("test setup requires a cookie creation profile");
    }
    const profileAd = context.credential.creationProfile!.adGroupPayload.ad_sketch_form_data as Record<string, unknown>;
    Object.assign(profileAd, {
      pricing: 9,
      bid: "",
      cpa_bid: "7",
      smart_bid_type: 0,
      bid_type_detail: 0,
      bid_display_mode: 0,
      deep_bid_type: 0,
      deep_cpabid: "0",
      optimization_source: 0,
      roas_bid: "0",
      cpa_skip_first_phrase: 1,
      flow_control_mode: 1,
    });
    const mutation = creationTestMutation("none");
    mutation.row.bid = 7;
    mutation.preset = { ...mutation.preset, pricing: 9 };

    const [result] = await new CookieAdsProvider().createFromPreset!(context, [mutation]);

    expect(result).toMatchObject({ ok: true });
    const adSave = requested.find((item) => item.url.includes("ad_snap/save"));
    expect(adSave?.body.ad_sketch_form_data).toMatchObject({
      pricing: 9,
      bid: "0",
      cpa_bid: "7",
      smart_bid_type: 0,
      bid_type_detail: 0,
      bid_display_mode: 0,
      deep_bid_type: 0,
      deep_cpabid: "0",
      optimization_source: 0,
      roas_bid: "0",
      cpa_skip_first_phrase: 1,
      flow_control_mode: 1,
    });
  });

  it("does not fall back to an account campaign when a new campaign preset template is missing", async () => {
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
    const copy = requested.find((item) => item.url.includes("campaign_snap/copy"));
    expect(copy).toBeUndefined();
    expect(requested.find((item) => item.url.includes("campaign_snap/save"))?.body).toMatchObject({
      campaign_sketch_form_data: { campaign_name: "campaign" },
    });
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
          : url.includes("snap/save_by_sketch")
            ? saveBySketchPayload()
          : url.includes("campaign_snap/save")
            ? { data: { campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" }, code: 0 }
            : url.includes("cbo_consistency_check")
              ? { data: { is_all_success: true }, code: 0 }
              : url.includes("campaign_snap/check")
                ? { data: { success: true, fake_campaign_id: "campaign-sketch" }, code: 0 }
                : url.includes("ad_creative_snap/check")
                  ? { data: { creative_success: true, ad_snap_check_report_map: {
                      "ad-snap-1": { success: true, ad_snap_id: "ad-snap-1", fake_ad_id: "ad-sketch-1" },
                      "ad-snap-2": { success: true, ad_snap_id: "ad-snap-2", fake_ad_id: "ad-sketch-2" },
                    } }, code: 0 }
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
    expect(requested[6]?.body.ad_and_creative_snap_info_list).toHaveLength(2);
    expect(requested[5]?.body.ad_creative_snap_check_info).toHaveLength(2);
    const published = requested[7]?.body.ad_and_creative_snap_info_list as Array<Record<string, unknown>>;
    expect(published).toHaveLength(2);
    expect(published.map((item) => item.ad_snap_id)).toEqual(["ad-snap-1", "ad-snap-2"]);
    expect(requested[7]?.body).toMatchObject({ is_partial_publish: false, is_status_disabled: true, coming_source_type: 1 });
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
    ["explicit provider rejection", "unknown"],
    ["polling API structured rejection after acceptance", "unknown"],
    ["confirmed asynchronous rejection", "unknown"],
    ["completed response with failed creative", "unknown"],
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
      const validation = successfulDraftValidationPayload(url);
      if (validation) return jsonResponse(validation);
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

  it("does not replay a failed ad under a reused campaign after drafts were accepted", async () => {
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

    expect(result).toMatchObject({ ok: false, failureKind: "unknown", retrySafe: false });
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

  it("uses campaign_snap/check fake_campaign_id when save omits the campaign sketch id", async () => {
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

    expect(result).toMatchObject({ ok: true });
    expect(progress).toContainEqual({
      phase: "campaign_draft",
      evidence: { campaignSnapId: "partial-campaign-snap" },
    });
    expect(progress).toContainEqual({
      phase: "campaign_draft",
      evidence: { campaignSnapId: "partial-campaign-snap", campaignSketchId: "campaign-sketch" },
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("campaign_snap/check"))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("ad_snap/save"))).toBe(true);
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

  it("accepts a from-scratch profile with zero lineage ids and unrelated origin metadata", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      jsonResponse(successfulCreationPayload(String(input))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const context = creationTestContext(true);
    if (context.credential.kind !== "cookie" || !context.credential.creationProfile) {
      throw new Error("test fixture must include a creation profile");
    }
    context.credential.creationProfile.adGroupPayload = {
      campaign_id: "",
      ad_sketch_form_data: { ad_name: "fresh", budget: "1", origin_ad_id: 0 },
    };
    context.credential.creationProfile.campaignPayload = {
      campaign_sketch_form_data: {
        campaign_name: "fresh",
        virtual_isolated: {
          validation: { extras: { origin_extra: "provider-validation-metadata" } },
        },
      },
    };

    const [result] = await new CookieAdsProvider().createFromPreset!(
      context,
      [creationTestMutation("none")],
    );

    expect(result).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalled();
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

  /**
   * 扩组的自动优化本来是从源组克隆的，老源组带来的就是老设置。这两条钉住
   * 「发布前改成创建流程那套」以及「改不动也不能让扩组失败」。
   */
  function stubExpandCopyFetch(overrides: {
    creativeSnapSave?: () => Response;
  } = {}): { requests: Array<{ path: string; body: Record<string, unknown> }> } {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url).pathname;
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>; } catch { body = {}; }
      requests.push({ path, body });
      if (url.includes("ad_snap/copy")) {
        return jsonResponse({ code: 0, data: { all_copy_result: { ad_and_creative_copy_result_list: [{
          new_ad_snap_info_item: { ad_snap_id: "ad-snap" },
          new_ad_sketch_id: "ad-sketch",
          new_creative_snap_info_item_list: [{ creative_snap_id: "creative-snap-old" }],
          new_creative_sketch_ids: ["creative-sketch"],
        }] } } });
      }
      if (url.includes("/snap/detail/")) {
        return jsonResponse({ code: 0, data: { ad_snap_map: { "ad-snap": {
          ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch", ad_name: "copied group",
          schedule_type: 0, budget: "50", cpa_bid: "7", spc_upgrade_mode: 1,
        } } } });
      }
      if (url.includes("ad_snap/save")) return jsonResponse({ code: 0, data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" } });
      if (url.includes("creative_sketch/detail")) {
        return jsonResponse({ code: 0, data: { creative_sketch_info_map: {
          "creative-sketch": { asset_group_sketch_form_data: {
            creative_sketch_id: "creative-sketch",
            creative_name: "copied creative",
            // 源组带来的旧设置：只开了翻译配音，正是要被覆盖掉的那种。
            creative_automation_type: 2,
            creative_automation_list: ["7419232909960003601"],
          } },
        } } });
      }
      if (url.includes("creative_snap/save")) {
        return overrides.creativeSnapSave?.() ?? jsonResponse({ code: 0, data: {
          creative_snap_ids: ["creative-snap-new"],
          creative_sketch_ids: ["creative-sketch"],
        } });
      }
      if (url.includes("batch_create_cta_id")) return jsonResponse({ code: 0, data: { cta_id_map: {} } });
      if (url.includes("async_creation/detail")) return jsonResponse({ code: 0, data: { status: 1, result: {
        campaign_id: "campaign",
        ad_and_creative: { 0: { ad_id: "adgroup", asset_group_result: { 0: { creative_items: { 0: { id: "creative" } } } } } },
      } } });
      return jsonResponse({ code: 0, data: { async_request_id: "async" } });
    }));
    return { requests };
  }

  it("扩组发布前把创意草稿的自动优化改成创建流程那套，而不是沿用源组克隆来的", async () => {
    const { requests } = stubExpandCopyFetch();

    const result = await new CookieAdsProvider().copyAdGroupToExistingCampaign(creationTestContext(false), {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group"],
      initialStatus: "disabled",
      dailyBudget: 50,
      bid: 7,
    });

    expect(result).toMatchObject({ ok: true });
    const save = requests.find((request) => request.path.includes("/creative_snap/save/"));
    const forms = save?.body.asset_group_sketch_form_data_list as Array<Record<string, unknown>>;
    expect(forms?.[0]).toMatchObject({
      creative_automation_type: 2,
      // 视频质量 + CTA 优化 + 生成广告卡片；源组那份翻译配音必须被换掉。
      creative_automation_list: ["100001", "100002", "7455417586723028993"],
      // 原地更新这份草稿，不是新建：带着它自己的 snap id。
      creative_snap_id: "creative-snap-old",
    });
    // 保存后返回的新 snap id 必须被采纳进发布报文，否则发布的是改之前那份。
    const publish = requests.find((request) => request.path.includes("/async_creation/create_by_snap/"));
    expect(JSON.stringify(publish?.body)).toContain("creative-snap-new");
  });

  it("自动优化改不动时按源组原样发布，不让一整批扩组因此失败", async () => {
    const { requests } = stubExpandCopyFetch({
      creativeSnapSave: () => jsonResponse({ code: 40000, msg: "creative_automation_not_supported" }),
    });

    const result = await new CookieAdsProvider().copyAdGroupToExistingCampaign(creationTestContext(false), {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group"],
      initialStatus: "disabled",
      dailyBudget: 50,
      bid: 7,
    });

    expect(result).toMatchObject({ ok: true });
    const publish = requests.find((request) => request.path.includes("/async_creation/create_by_snap/"));
    expect(JSON.stringify(publish?.body)).toContain("creative-snap-old");
  });

  it("writes and verifies TikTok native scheduling before publishing copied ad groups as enabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let detailReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ path, body });
      if (url.includes("ad_snap/copy")) {
        return jsonResponse({ code: 0, data: { all_copy_result: { ad_and_creative_copy_result_list: [{
          new_ad_snap_info_item: { ad_snap_id: "ad-snap" },
          new_ad_sketch_id: "ad-sketch",
          new_creative_snap_info_item_list: [{ creative_snap_id: "creative-snap" }],
          new_creative_sketch_ids: ["creative-sketch"],
        }] } } });
      }
      if (url.includes("/snap/detail/")) {
        detailReads += 1;
        return jsonResponse({ code: 0, data: { ad_snap_map: { "ad-snap": {
          ad_snap_id: "ad-snap",
          ad_sketch_id: "ad-sketch",
          ad_name: "copied group",
          schedule_type: detailReads === 1 ? 0 : 1,
          start_time: detailReads === 1 ? "2026-07-23 08:00:00" : "2026-07-24 06:00:00",
          end_time: "2036-07-24 06:00:00",
          budget: detailReads === 1 ? "20" : "50",
          cpa_bid: detailReads === 1 ? "3" : "7",
          spc_upgrade_mode: 1,
        } } } });
      }
      if (url.includes("ad_snap/save")) return jsonResponse({ code: 0, data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" } });
      if (url.includes("batch_create_cta_id")) return jsonResponse({ code: 0, data: { cta_id_map: {} } });
      if (url.includes("async_creation/detail")) return jsonResponse({ code: 0, data: { status: 1, result: {
        campaign_id: "campaign",
        ad_and_creative: { 0: { ad_id: "adgroup", asset_group_result: { 0: { creative_items: { 0: { id: "creative" } } } } } },
      } } });
      return jsonResponse({ code: 0, data: { async_request_id: "async" } });
    }));

    const context = creationTestContext(false);
    context.timezone = "Asia/Taipei";
    if (context.credential.kind !== "cookie" || !context.credential.requestTemplates) {
      throw new Error("test fixture must include cookie request templates");
    }
    context.credential.requestTemplates.push({
      target: "ad-status",
      action: "enable",
      url: "https://ads.tiktok.com/api/v4/i18n/ad/update_status/?aadvid=123456",
      method: "POST",
      body: '{"creative_id":"captured-ad","operation":"enable"}',
      contentType: "application/json",
    });
    const result = await new CookieAdsProvider().copyAdGroupToExistingCampaign(context, {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group"],
      initialStatus: "enabled",
      scheduledStartAt: "2026-07-23T22:00:00.000Z",
      dailyBudget: 50,
      bid: 7,
    });

    expect(result).toMatchObject({ ok: true, adGroupIds: ["adgroup"] });
    const save = requests.find((request) => request.path.includes("/ad_snap/save/"));
    expect(save?.body).toMatchObject({
      campaign_id: "campaign",
      with_sketch: true,
      is_skip_check_fields: false,
      ad_sketch_form_data: {
        ad_snap_id: "ad-snap",
        ad_sketch_id: "ad-sketch",
        schedule_type: 1,
        start_time: "2026-07-24 06:00:00",
        budget: "50",
        cpa_bid: "7",
      },
    });
    const publish = requests.find((request) => request.path.includes("/async_creation/create_by_snap/"));
    expect(publish?.body).toMatchObject({ is_status_disabled: false });
    expect(requests.filter((request) => request.path.includes("/snap/detail/"))).toHaveLength(2);
    // 组以 enabled 发布，组里克隆出来的广告也必须显式打开：拦住投放的是 TikTok 按
    // 广告组排期判定的 ad_time_no_reach，不是广告自己的开关。定时批次一样要开。
    const enables = requests.filter((request) => request.path.includes("/ad/update_status/"));
    expect(enables).toHaveLength(1);
    expect(enables[0]?.body).toMatchObject({ creative_id: "creative", operation: "enable" });
  });

  it("inherits the source 系列预算(CBO) instead of overriding the ad-group budget", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ path, body });
      if (url.includes("ad_snap/copy")) {
        return jsonResponse({ code: 0, data: { all_copy_result: { ad_and_creative_copy_result_list: [{
          new_ad_snap_info_item: { ad_snap_id: "ad-snap" },
          new_ad_sketch_id: "ad-sketch",
          new_creative_snap_info_item_list: [{ creative_snap_id: "creative-snap" }],
          new_creative_sketch_ids: ["creative-sketch"],
        }] } } });
      }
      if (url.includes("/snap/detail/")) {
        // CBO 源：草稿预算继承自系列(30)，与请求的组预算(50)不同。
        return jsonResponse({ code: 0, data: { ad_snap_map: { "ad-snap": {
          ad_snap_id: "ad-snap",
          ad_sketch_id: "ad-sketch",
          ad_name: "copied group",
          budget: "30",
          spc_upgrade_mode: 1,
        } } } });
      }
      if (url.includes("ad_snap/save")) return jsonResponse({ code: 0, data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" } });
      if (url.includes("async_creation/detail")) return jsonResponse({ code: 0, data: { status: 1, result: {
        campaign_id: "campaign",
        ad_and_creative: { 0: { ad_id: "adgroup", asset_group_result: { 0: { creative_items: { 0: { id: "creative" } } } } } },
      } } });
      return jsonResponse({ code: 0, data: { async_request_id: "async" } });
    }));

    const result = await new CookieAdsProvider().copyAdGroupToExistingCampaign(creationTestContext(false), {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group"],
      initialStatus: "disabled",
      dailyBudget: 50,
      sourceCampaignBudgetOptimized: true,
    });

    // 组预算未被覆盖、也未因回读不等而失败：新组沿用系列预算(30)。
    expect(result).toMatchObject({ ok: true });
    const save = requests.find((request) => request.path.includes("/ad_snap/save/"));
    expect((save?.body.ad_sketch_form_data as Record<string, unknown>).budget).toBe("30");
  });

  it("does not publish when TikTok native scheduling cannot be verified", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
    const requestedPaths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedPaths.push(new URL(url).pathname);
      if (url.includes("ad_snap/copy")) {
        return jsonResponse({ code: 0, data: { all_copy_result: { ad_and_creative_copy_result_list: [{
          new_ad_snap_info_item: { ad_snap_id: "ad-snap" },
          new_ad_sketch_id: "ad-sketch",
          new_creative_snap_info_item_list: [{ creative_snap_id: "creative-snap" }],
          new_creative_sketch_ids: ["creative-sketch"],
        }] } } });
      }
      if (url.includes("/snap/detail/")) {
        return jsonResponse({ code: 0, data: { ad_snap_map: { "ad-snap": {
          ad_snap_id: "ad-snap",
          ad_sketch_id: "ad-sketch",
          schedule_type: 0,
          start_time: "2026-07-23 08:00:00",
          end_time: "2036-07-24 06:00:00",
        } } } });
      }
      return jsonResponse({ code: 0, data: {} });
    }));

    const context = creationTestContext(false);
    context.timezone = "Asia/Taipei";
    const result = await new CookieAdsProvider().copyAdGroupToExistingCampaign(context, {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group"],
      initialStatus: "enabled",
      scheduledStartAt: "2026-07-23T22:00:00.000Z",
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("原生排期未能回读确认");
    expect(requestedPaths.some((path) => path.includes("/async_creation/create_by_snap/"))).toBe(false);
  });

  it("completes the real simple ad copy response with count-backed pagination, creative detail, and plural save ids", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
    const requestedPaths: string[] = [];
    const creativeListPages: number[] = [];
    let savedCreativeCount = 0;
    let detailReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requestedPaths.push(new URL(url).pathname);
      if (url.includes("ad_snap/copy")) {
        return jsonResponse({ code: 0, data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" } });
      }
      if (url.includes("statistics/sketch/creative/list")) {
        const page = Number(JSON.parse(String(init?.body)).page);
        creativeListPages.push(page);
        return jsonResponse({ code: 0, data: {
          table: [{
            ad_sketch_id: "ad-sketch",
            creative_sketch_id: `creative-sketch-${page}`,
          }],
          pagination: { page, page_count: 2, limit: 1, total_count: 2 },
        } });
      }
      if (url.includes("creative_sketch/detail")) {
        return jsonResponse({ code: 0, data: { creative_sketch_info_map: {
          "creative-sketch-1": { asset_group_sketch_form_data: {
            creative_sketch_id: "creative-sketch-1",
            creative_name: "copied creative 1",
            image_list: [{ aweme_item_id: "post-1" }],
          } },
          "creative-sketch-2": { asset_group_sketch_form_data: {
            creative_sketch_id: "creative-sketch-2",
            creative_name: "copied creative 2",
            image_list: [{ aweme_item_id: "post-2" }],
          } },
        } } });
      }
      if (url.includes("/snap/detail/")) {
        detailReads += 1;
        return jsonResponse({ code: 0, data: { ad_snap_map: { "ad-snap": {
          ad_snap_id: "ad-snap",
          ad_sketch_id: "ad-sketch",
          schedule_type: detailReads === 1 ? 0 : 1,
          start_time: detailReads === 1 ? "2026-07-23 08:00:00" : "2026-07-24 06:00:00",
          end_time: "2036-07-24 06:00:00",
          budget: "50",
          cpa_bid: "7",
        } } } });
      }
      if (url.includes("ad_snap/save")) {
        return jsonResponse({ code: 0, data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" } });
      }
      if (url.includes("creative_snap/save")) {
        savedCreativeCount = JSON.parse(String(init?.body)).asset_group_sketch_form_data_list.length;
        return jsonResponse({ code: 0, data: {
          creative_snap_ids: ["creative-snap-1", "creative-snap-2"],
          creative_sketch_ids: ["creative-sketch-1", "creative-sketch-2"],
        } });
      }
      if (url.includes("batch_create_cta_id")) return jsonResponse({ code: 0, data: {} });
      if (url.includes("async_creation/detail")) return jsonResponse({ code: 0, data: { status: 1, result: {
        campaign_id: "campaign",
        ad_and_creative: { 0: { ad_id: "adgroup", asset_group_result: { 0: { creative_items: {
          0: { id: "creative-1" },
          1: { id: "creative-2" },
        } } } } },
      } } });
      return jsonResponse({ code: 0, data: { async_request_id: "async" } });
    }));

    const context = creationTestContext(false);
    context.timezone = "Asia/Taipei";
    const result = await new CookieAdsProvider().copyAdGroupToExistingCampaign(context, {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group"],
      initialStatus: "enabled",
      scheduledStartAt: "2026-07-23T22:00:00.000Z",
      dailyBudget: 50,
      bid: 7,
    });

    expect(result).toMatchObject({ ok: true });
    expect(creativeListPages).toEqual([1, 2]);
    expect(savedCreativeCount).toBe(2);
    expect(requestedPaths.filter((path) => path.includes("/snap/detail/"))).toHaveLength(2);
    expect(requestedPaths.some((path) => path.includes("/ad_snap/save/"))).toBe(true);
    expect(requestedPaths.some((path) => path.includes("/creative_sketch/detail/"))).toBe(true);
    expect(requestedPaths.some((path) => path.includes("/creative_snap/save/"))).toBe(true);
    expect(requestedPaths.some((path) => path.includes("/async_creation/create_by_snap/"))).toBe(true);
  });

  it("keeps a simple copy unknown when its creative sketch cannot be located", async () => {
    const requestedPaths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedPaths.push(new URL(url).pathname);
      if (url.includes("ad_snap/copy")) {
        return jsonResponse({ code: 0, data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" } });
      }
      if (url.includes("/snap/detail/")) {
        return jsonResponse({ code: 0, data: { ad_snap_map: { "ad-snap": {
          ad_snap_id: "ad-snap",
          ad_sketch_id: "ad-sketch",
        } } } });
      }
      if (url.includes("ad_snap/save")) return jsonResponse({ code: 0, data: {} });
      if (url.includes("statistics/sketch/creative/list")) {
        return jsonResponse({
          code: 0,
          data: { table: [], pagination: { page: 1, page_count: 1, limit: 100, total_count: 0 } },
        });
      }
      return jsonResponse({ code: 0, data: {} });
    }));

    const result = await new CookieAdsProvider().copyAdGroupToExistingCampaign(creationTestContext(false), {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group"],
      initialStatus: "disabled",
    });

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(result.message).toContain("未能定位其创意草稿");
    expect(requestedPaths.some((path) => path.includes("/async_creation/create_by_snap/"))).toBe(false);
  });

  it("stops a simple copy when creative list pagination metadata is contradictory", async () => {
    const requestedPaths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedPaths.push(new URL(url).pathname);
      if (url.includes("ad_snap/copy")) {
        return jsonResponse({ code: 0, data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" } });
      }
      if (url.includes("/snap/detail/")) {
        return jsonResponse({ code: 0, data: { ad_snap_map: { "ad-snap": {
          ad_snap_id: "ad-snap",
          ad_sketch_id: "ad-sketch",
        } } } });
      }
      if (url.includes("ad_snap/save")) return jsonResponse({ code: 0, data: {} });
      if (url.includes("statistics/sketch/creative/list")) {
        return jsonResponse({ code: 0, data: {
          table: [{ ad_sketch_id: "ad-sketch", creative_sketch_id: "creative-sketch" }],
          pagination: { page: 1, page_count: 2, limit: 1, total_count: 2 },
          page_info: { page: 1, total_page: 2, total_count: 2, has_more: false },
        } });
      }
      return jsonResponse({ code: 0, data: {} });
    }));

    const result = await new CookieAdsProvider().copyAdGroupToExistingCampaign(creationTestContext(false), {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group"],
      initialStatus: "disabled",
    });

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(result.message).toContain("分页标记互相矛盾");
    expect(requestedPaths.some((path) => path.includes("/async_creation/create_by_snap/"))).toBe(false);
  });

  it("treats a partial ad copy result as unknown instead of reporting the requested count as created", async () => {
    const requestedPaths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedPaths.push(new URL(url).pathname);
      return jsonResponse({ code: 0, data: { all_copy_result: { ad_and_creative_copy_result_list: [{
        new_ad_snap_info_item: { ad_snap_id: "ad-snap" },
        new_ad_sketch_id: "ad-sketch",
        new_creative_snap_info_item_list: [{ creative_snap_id: "creative-snap" }],
        new_creative_sketch_ids: ["creative-sketch"],
      }] } } });
    }));

    const result = await new CookieAdsProvider().copyAdGroupToExistingCampaign(creationTestContext(false), {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group 1", "copied group 2"],
      initialStatus: "disabled",
    });

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(result.message).toContain("1/2");
    expect(requestedPaths.some((path) => path.includes("/async_creation/create_by_snap/"))).toBe(false);
  });

  it("preserves a dispatched ad copy transport loss as unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("connection reset");
    }));

    const result = await new CookieAdsProvider().copyAdGroupToExistingCampaign(creationTestContext(false), {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group"],
      initialStatus: "disabled",
    });

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
  });

  it("keeps a later structured TikTok rejection retryable after the copy draft was accepted", async () => {
    const onBeforeDispatch = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("ad_snap/copy")) {
        return jsonResponse({ code: 0, data: { all_copy_result: { ad_and_creative_copy_result_list: [{
          new_ad_snap_info_item: { ad_snap_id: "ad-snap" },
          new_ad_sketch_id: "ad-sketch",
          new_creative_snap_info_item_list: [{ creative_snap_id: "creative-snap" }],
          new_creative_sketch_ids: ["creative-sketch"],
        }] } } });
      }
      return jsonResponse({ code: 40001, msg: "draft detail rejected" });
    }));

    const result = await new CookieAdsProvider().copyAdGroupToExistingCampaign(creationTestContext(false), {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group"],
      initialStatus: "disabled",
      onBeforeDispatch,
    });

    expect(result).toMatchObject({ ok: false, failureKind: "failed", retrySafe: false });
    expect(onBeforeDispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit copy rejection retryable and does not mark local validation as dispatched", async () => {
    const rejectedDispatch = vi.fn();
    const fetchMock = vi.fn(async () => jsonResponse({ code: 40001, msg: "copy rejected" }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CookieAdsProvider();

    const rejected = await provider.copyAdGroupToExistingCampaign(creationTestContext(false), {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group"],
      initialStatus: "disabled",
      onBeforeDispatch: rejectedDispatch,
    });
    expect(rejected).toMatchObject({ ok: false, failureKind: "failed", retrySafe: true });
    expect(rejectedDispatch).toHaveBeenCalledTimes(1);

    const invalidDispatch = vi.fn();
    await expect(provider.copyAdGroupToExistingCampaign(creationTestContext(false), {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group"],
      initialStatus: "enabled",
      scheduledStartAt: "not-a-date",
      onBeforeDispatch: invalidDispatch,
    })).rejects.toThrow("定时投放时间无效");
    expect(invalidDispatch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats an accepted copy publish that never reaches a terminal result as unknown", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("ad_snap/copy")) {
        return jsonResponse({ code: 0, data: { all_copy_result: { ad_and_creative_copy_result_list: [{
          new_ad_snap_info_item: { ad_snap_id: "ad-snap" },
          new_ad_sketch_id: "ad-sketch",
          new_creative_snap_info_item_list: [{ creative_snap_id: "creative-snap" }],
          new_creative_sketch_ids: ["creative-sketch"],
        }] } } });
      }
      if (url.includes("/snap/detail/")) {
        return jsonResponse({ code: 0, data: { ad_snap_map: { "ad-snap": {
          ad_snap_id: "ad-snap",
          ad_sketch_id: "ad-sketch",
          budget: "50",
          cpa_bid: "7",
        } } } });
      }
      if (url.includes("ad_snap/save") || url.includes("batch_create_cta_id")) {
        return jsonResponse({ code: 0, data: {} });
      }
      if (url.includes("async_creation/detail")) {
        return jsonResponse({ code: 0, data: { status: 0 } });
      }
      return jsonResponse({ code: 0, data: { async_request_id: "async" } });
    }));

    const pending = new CookieAdsProvider().copyAdGroupToExistingCampaign(creationTestContext(false), {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group"],
      initialStatus: "enabled",
      dailyBudget: 50,
      bid: 7,
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(result.message).toContain("转入 Cookie 远端列表核验");
  });

  it("treats an incomplete terminal copy result as unknown instead of reporting success", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("ad_snap/copy")) {
        return jsonResponse({ code: 0, data: { all_copy_result: { ad_and_creative_copy_result_list: [{
          new_ad_snap_info_item: { ad_snap_id: "ad-snap" },
          new_ad_sketch_id: "ad-sketch",
          new_creative_snap_info_item_list: [{ creative_snap_id: "creative-snap" }],
          new_creative_sketch_ids: ["creative-sketch"],
        }] } } });
      }
      if (url.includes("/snap/detail/")) {
        return jsonResponse({ code: 0, data: { ad_snap_map: { "ad-snap": {
          ad_snap_id: "ad-snap",
          ad_sketch_id: "ad-sketch",
          budget: "50",
          cpa_bid: "7",
        } } } });
      }
      if (url.includes("ad_snap/save") || url.includes("batch_create_cta_id")) {
        return jsonResponse({ code: 0, data: {} });
      }
      if (url.includes("async_creation/detail")) {
        return jsonResponse({ code: 0, data: { status: 1, result: {
          campaign_id: "campaign",
          ad_and_creative: { 0: { ad_id: "adgroup", asset_group_result: {} } },
        } } });
      }
      return jsonResponse({ code: 0, data: { async_request_id: "async" } });
    }));

    const result = await new CookieAdsProvider().copyAdGroupToExistingCampaign(creationTestContext(false), {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group"],
      initialStatus: "enabled",
      dailyBudget: 50,
      bid: 7,
    });

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(result.message).toContain("广告 0/1");
    expect(result.message).toContain("禁止自动重试");
  });

  it("rejects a terminal result that concentrates all creatives in only one copied ad group", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("ad_snap/copy")) {
        return jsonResponse({ code: 0, data: { all_copy_result: { ad_and_creative_copy_result_list: [
          {
            new_ad_snap_info_item: { ad_snap_id: "ad-snap-1" },
            new_ad_sketch_id: "ad-sketch-1",
            new_creative_snap_info_item_list: [{ creative_snap_id: "creative-snap-1" }],
            new_creative_sketch_ids: ["creative-sketch-1"],
          },
          {
            new_ad_snap_info_item: { ad_snap_id: "ad-snap-2" },
            new_ad_sketch_id: "ad-sketch-2",
            new_creative_snap_info_item_list: [{ creative_snap_id: "creative-snap-2" }],
            new_creative_sketch_ids: ["creative-sketch-2"],
          },
        ] } } });
      }
      if (url.includes("/snap/detail/")) {
        return jsonResponse({ code: 0, data: { ad_snap_map: {
          "ad-snap-1": { ad_snap_id: "ad-snap-1", ad_sketch_id: "ad-sketch-1", budget: "50" },
          "ad-snap-2": { ad_snap_id: "ad-snap-2", ad_sketch_id: "ad-sketch-2", budget: "50" },
        } } });
      }
      if (url.includes("ad_snap/save") || url.includes("batch_create_cta_id")) {
        return jsonResponse({ code: 0, data: {} });
      }
      if (url.includes("async_creation/detail")) {
        return jsonResponse({ code: 0, data: { status: 1, result: {
          campaign_id: "campaign",
          ad_and_creative: {
            0: { ad_id: "adgroup-1", asset_group_result: { 0: { creative_items: {
              0: { id: "creative-1" },
              1: { id: "creative-2" },
            } } } },
            1: { ad_id: "adgroup-2", asset_group_result: { 0: { creative_items: {} } } },
          },
        } } });
      }
      return jsonResponse({ code: 0, data: { async_request_id: "async" } });
    }));

    const result = await new CookieAdsProvider().copyAdGroupToExistingCampaign(creationTestContext(false), {
      sourceAdGroupId: "source-adgroup",
      existingCampaignId: "campaign",
      names: ["copied group 1", "copied group 2"],
      initialStatus: "enabled",
      dailyBudget: 50,
    });

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(result.message).toContain("每组广告 0,2（预期 1,1）");
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

/** 只导入了广告组列表 cURL 的账户：系列和广告层级都靠派生请求补全。 */
function derivedSyncContext(): ProviderContext {
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
      requestTemplates: [{
        target: "ad-group",
        url: "https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=123456",
        method: "POST",
        body: "{}",
        contentType: "application/json",
      }],
    },
  };
}

function derivedListPage(): Record<string, unknown> {
  return {
    code: 0,
    data: {
      table: [{
        campaign_id: "c1",
        campaign_name: "系列",
        adgroup_id: "g1",
        adgroup_name: "广告组",
        creative_id: "a1",
        ad_name: "广告",
        spend: "1",
      }],
      page_info: { page: 1, total_page: 1 },
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

/** 发布请求实际用的 sketch_publish_source。真机创建流程恒为 1。 */
function publishSource(requested: Array<{ url: string; body: Record<string, unknown> }>): unknown {
  return requested.find((item) => item.url.includes("create_by_snap"))?.body.sketch_publish_source;
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

/**
 * Spark 从零创建的完整应答夹具：按请求体动态生成，因而与素材条数无关。
 * 需要断言「多素材 / 分批 / 跳过」这类行为的用例都用它，避免把 vid、task id
 * 写死成单条。
 */
function sparkCreationPayload(url: string, body: Record<string, unknown> = {}): Record<string, unknown> {
  if (url.includes("spark/validate_promote_music")) {
    const posts = Array.isArray(body.post_list) ? body.post_list : [];
    return { code: 0, data: { music_info_map: Object.fromEntries(
      posts.filter(isPlainRecord).map((post) => [String(post.item_id), { status: 0 }]),
    ) } };
  }
  if (url.includes("creative/creative_automation_option")) {
    return { code: 0, data: { strategy_ids: ["100001", "100002", "200001"], group_strategies: [] } };
  }
  if (url.includes("spark/creative_fix_task/save")) {
    const vids = Array.isArray(body.creative_fix_vid_list) ? body.creative_fix_vid_list : [];
    return { code: 0, data: { task_map: Object.fromEntries(vids.map((vid) => [String(vid), `task-${String(vid)}`])) } };
  }
  if (url.includes("spark/creative_fix_task/info")) {
    const taskIds = Array.isArray(body.task_id_list) ? body.task_id_list : [];
    return { code: 0, data: { task_info_map: Object.fromEntries(taskIds.map((id) => [String(id), { task_status: 2 }])) } };
  }
  if (url.includes("/creative_snap/check/")) return { code: 0, data: { success: true } };
  return successfulCreationPayload(url);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function successfulCreationPayload(url: string): Record<string, unknown> {
  if (url.includes("statistics/sketch/")) {
    return { code: 0, data: { table: [], pagination: { total_count: 0, page_count: 0, limit: 100, page: 1 } } };
  }
  if (url.includes("campaign/list")) return { code: 0, data: { table: [
    { campaign_id: "source-campaign", campaign_name: "source", campaign_status: "disabled" },
    ...(successfulCreationCompleted
      ? [{ campaign_id: "campaign", campaign_name: "campaign", campaign_status: "enabled" }]
      : []),
  ], pagination: { page: 1, page_count: 1 } } };
  if (url.includes("adgroup/list")) return { code: 0, data: { table: [
    { campaign_id: "source-campaign", ad_id: "source-adgroup", ad_name: "source-group", campaign_name: "source", campaign_status: "disabled" },
    ...(successfulCreationCompleted
      ? [{ campaign_id: "campaign", ad_id: "adgroup", ad_name: "group", ad_status: "enabled" }]
      : []),
  ], pagination: { page: 1, page_count: 1 } } };
  if (url.includes("/statistics/op/ad/list")) return { code: 0, data: { table: successfulCreationCompleted
    ? [{ campaign_id: "campaign", ad_id: "adgroup", creative_id: "creative", creative_name: "260717:001", creative_status: "enabled" }]
    : [], pagination: { page: 1, page_count: 1 } } };
  if (url.includes("ad_snap/copy")) return { code: 0, data: {
    all_copy_result: { ad_and_creative_copy_result_list: [{
      new_ad_snap_info_item: {
        ad_snap_id: "ad-snap",
        ad_snap_form_data: { ad_name: "source-group", budget: "1", image_list: [] },
      },
      new_ad_sketch_id: "ad-sketch",
      new_creative_snap_info_item_list: [{
        creative_snap_id: "creative-snap",
        asset_group_creative_snap_form_data: {
          creative_name: "source",
          external_url: "https://example.com",
          creative_automation_type: 1,
          spc_upgrade_mode: 1,
          image_list: [{ aweme_item_id: "video" }],
        },
      }],
      new_creative_sketch_ids: ["creative-sketch"],
    }] },
  } };
  if (url.includes("campaign_snap/copy")) return { code: 0, data: {
    new_campaign_snap_info_item: { campaign_snap_id: "campaign-snap", campaign_snap_form_data: { campaign_name: "source", campaign_snap_id: "campaign-snap", objective_type: 9 } },
    new_campaign_sketch_id: "campaign-sketch",
    new_ad_snap_info_item_list: [{ ad_snap_id: "ad-snap", ad_snap_form_data: { ad_name: "source", budget: "1", image_list: [] } }],
    new_ad_and_creative_snap_info_item_map: { "ad-snap": [{ creative_snap_id: "creative-snap", asset_group_creative_snap_form_data: { creative_name: "source", external_url: "https://example.com", creative_automation_type: 1, spc_upgrade_mode: 1, image_list: [{ aweme_item_id: "video" }] } }] },
    new_ad_and_creative_sketch_ids_map: { "ad-sketch": ["creative-sketch"] },
  } };
  // 真机在发布前用 sketch 重铸一整套 snap，返回三张 sketch→snap 映射表。
  // 这里刻意返回与建草稿时不同的 ID，取错了就会被断言抓到。
  if (url.includes("snap/save_by_sketch")) return { code: 0, data: {
    campaign_sketch_id_to_snap_id: { "campaign-sketch": "campaign-snap-reminted" },
    ad_sketch_id_to_snap_id: { "ad-sketch": "ad-snap-reminted" },
    creative_sketch_id_to_snap_id: { "creative-sketch": "creative-snap-reminted" },
  } };
  if (url.includes("campaign_snap/save")) return { code: 0, data: { campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" } };
  if (url.includes("ad_snap/save")) return { code: 0, data: { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" } };
  if (url.includes("creative_snap/save")) return { code: 0, data: { creative_snap_id: "creative-snap", creative_sketch_id: "creative-sketch" } };
  const validation = successfulDraftValidationPayload(url);
  if (validation) return validation;
  if (url.includes("async_creation/detail")) {
    successfulCreationCompleted = true;
    return { code: 0, data: { status: 1, result: { campaign_id: "campaign", ad_and_creative: { 0: { by_ad_snap_id: "ad-snap", ad_id: "adgroup", asset_group_result: { 0: { creative_items: [{ id: "creative" }] } } } } } } };
  }
  return { code: 0, data: { async_request_id: "async" } };
}

/**
 * 发布前从 sketch 重铸 snap 的响应。真机按 campaign_sketch_id 把整棵树重铸一遍，
 * 返回三张 sketch→snap 映射表。这里覆盖各用例用到的 sketch 命名，并刻意返回与建
 * 草稿时不同的 snap ID——发布时若还引用旧 snap，断言就会抓到。
 */
function saveBySketchPayload(): Record<string, unknown> {
  const remint = (base: string) => Object.fromEntries([
    [`${base}-sketch`, `${base}-snap-reminted`],
    ...Array.from({ length: 5 }, (_unused, index) => [
      `${base}-sketch-${index + 1}`,
      `${base}-snap-reminted-${index + 1}`,
    ]),
  ]);
  return { code: 0, data: {
    campaign_sketch_id_to_snap_id: remint("campaign"),
    ad_sketch_id_to_snap_id: remint("ad"),
    creative_sketch_id_to_snap_id: remint("creative"),
  } };
}

function successfulDraftValidationPayload(
  url: string,
  adSnapIds = ["ad-snap"],
): Record<string, unknown> | undefined {
  const reports = Object.fromEntries(adSnapIds.map((adSnapId, index) => [adSnapId, {
    success: true,
    ad_snap_id: adSnapId,
    fake_ad_id: adSnapIds.length === 1 ? "ad-sketch" : `ad-sketch-${index + 1}`,
  }]));
  if (url.includes("snap/save_by_sketch")) return saveBySketchPayload();
  if (url.includes("ad_snap/bulk_check")) return { code: 0, data: { ad_snap_check_report_map: reports } };
  if (url.includes("ad_creative_snap/check")) return { code: 0, data: { creative_success: true, ad_snap_check_report_map: reports } };
  if (url.includes("creative_snap/check")) return { code: 0, data: { success: true } };
  if (url.includes("cbo_consistency_check")) return { code: 0, data: { is_all_success: true } };
  if (url.includes("campaign_snap/check")) return { code: 0, data: { success: true, fake_campaign_id: "campaign-sketch" } };
  if (url.includes("batch_create_cta_id")) return { code: 0, data: { cta_id_map: {} } };
  return undefined;
}

function jsonResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function completeListPayload(table: Record<string, unknown>[]): Record<string, unknown> {
  return {
    code: 0,
    data: {
      table,
      pagination: { page: 1, page_count: 1, limit: Math.max(1, table.length), total_count: table.length },
    },
  };
}

function emptySketchListPayload(): Record<string, unknown> {
  return {
    code: 0,
    data: {
      table: [],
      pagination: { page: 1, page_count: 0, limit: 100, total_count: 0 },
    },
  };
}

// 升级前存下的广告层模板里，aco_creative_list 是 creative_list 的副本（导入时被
// 复制进去的）。执行时必须强制置空，否则这些账户不重新导入就永远修不好。
describe("广告层开关：ACO 创意列表", () => {
  it("即便模板里 aco_creative_list 带着 ID，发出时也置空", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const boundary = "----WebKitFormBoundaryAco";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="creative_list"',
      "",
      '["stale-id"]',
      `--${boundary}`,
      'Content-Disposition: form-data; name="aco_creative_list"',
      "",
      '["stale-id"]',
      `--${boundary}`,
      'Content-Disposition: form-data; name="operation"',
      "",
      "disable",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    await new CookieAdsProvider().changeStatus({
      accountId: "test-account",
      timezone: "Asia/Taipei",
      settings: { kind: "cookie", advertiserId: "123456", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
      credential: {
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
        requestTemplates: [{
          target: "ad-status",
          action: "disable",
          url: "https://ads.tiktok.com/api/v2/i18n/overture/creative/update_status/?aadvid=123456",
          method: "POST",
          body,
          contentType: `multipart/form-data; boundary=${boundary}`,
        }],
      },
    }, [{ entityType: "ad", externalId: "target-ad", action: "disable" }]);

    const fields = new Map(parseMultipartFields(sent[0]!).map((f) => [f.name, f.value.trim()]));
    expect(fields.get("creative_list")).toBe('["target-ad"]');
    expect(fields.get("aco_creative_list")).toBe("[]");
  });
});
