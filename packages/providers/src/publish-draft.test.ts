import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieAdsProvider } from "./cookie-provider.js";
import type { ProviderContext } from "./types.js";

function context(): ProviderContext {
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

interface Call { path: string; body: Record<string, unknown> }

interface DraftRow { adSketchId: string; name: string; campaignId: string }

function stubTikTok(options: {
  calls: Call[];
  /** 每页返回的草稿；数组的每一项是一页，用来验证翻页。 */
  pages: DraftRow[][];
  /** ad_sketch_id → creative_sketch_id[]，决定 save_by_sketch 与归属查询的返回。 */
  creativesBySketch: Record<string, string[]>;
  /** 归属接口不可用（真机上它的形状未经验证，必须容忍）。 */
  creativeListBroken?: boolean;
  publishedAdGroups?: number;
  publishRejected?: boolean;
  /** 草稿的 start_time 已经过去——真机上放了几天的草稿就是这样。 */
  staleStart?: boolean;
}) {
  // 草稿的服务端排期状态：ad_snap/save 写什么，snap/detail 就回读什么。
  const draftForms = new Map<string, Record<string, unknown>>();
  const startTime = options.staleStart ? "2020-01-01 00:00:00" : "2099-01-01 00:00:00";
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    options.calls.push({ path, body });
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

    if (path.includes("statistics/sketch/ad/list")) {
      const page = Number(body.page ?? 1);
      const rows = options.pages[page - 1] ?? [];
      return json({
        code: 0,
        data: {
          table: rows.map((row) => ({
            ad_sketch_id: row.adSketchId,
            ad_sketch_name: row.name,
            campaign_id: row.campaignId,
            campaign_sketch_id: "0",
          })),
        },
      });
    }
    if (path.includes("statistics/sketch/creative/list")) {
      if (options.creativeListBroken) return json({ code: 40001, msg: "not available" });
      return json({
        code: 0,
        data: {
          table: Object.entries(options.creativesBySketch).flatMap(([adSketchId, creatives]) =>
            creatives.map((creativeSketchId) => ({
              creative_sketch_id: creativeSketchId,
              ad_sketch_id: adSketchId,
            }))),
        },
      });
    }
    if (path.includes("snap/save_by_sketch")) {
      return json({
        code: 0,
        data: {
          ad_sketch_id_to_snap_id: Object.fromEntries(
            Object.keys(options.creativesBySketch).map((id) => [id, `snap-${id}`]),
          ),
          creative_sketch_id_to_snap_id: Object.fromEntries(
            Object.values(options.creativesBySketch).flat().map((id) => [id, `snap-${id}`]),
          ),
        },
      });
    }
    if (path.includes("creation/snap/detail")) {
      const ids = (body.ad_snap_ids as string[] | undefined) ?? [];
      return json({
        code: 0,
        data: {
          ad_snap_map: Object.fromEntries(ids.map((id) => [
            id,
            draftForms.get(id) ?? { ad_snap_id: id, start_time: startTime, end_time: "2099-12-31 23:59:59", budget: "50" },
          ])),
        },
      });
    }
    if (path.includes("ad_snap/save")) {
      const form = body.ad_sketch_form_data as Record<string, unknown>;
      draftForms.set(String(form.ad_snap_id), form);
      return json({ code: 0, data: {} });
    }
    if (path.includes("create_by_snap")) {
      if (options.publishRejected) return json({ code: 40002, msg: "缺少行动引导" });
      const count = options.publishedAdGroups ?? 1;
      return json({
        code: 0,
        data: {
          result: {
            ad_and_creative: Array.from({ length: count }, (_unused, index) => ({
              ad_id: `new-group-${index + 1}`,
              adgroup_id: `new-group-${index + 1}`,
              asset_group_result: [{ creative_items: [{ id: `new-ad-${index + 1}` }] }],
            })),
          },
        },
      });
    }
    return json({ code: 0, msg: "success", data: {} });
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CookieAdsProvider.publishExistingDrafts", () => {
  it("按名字找到草稿，用 save_by_sketch 的映射发布，带草稿来源标记", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      pages: [[{ adSketchId: "ad-1", name: "A-0826-060000-1", campaignId: "camp-1" }]],
      creativesBySketch: { "ad-1": ["cre-1"] },
    });

    const result = await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1",
      names: ["A-0826-060000-1"],
      initialStatus: "disabled",
    });

    expect(result.ok).toBe(true);
    expect(result.adGroupIds).toEqual(["new-group-1"]);
    const publish = calls.find((call) => call.path.includes("create_by_snap"));
    expect(publish?.body).toMatchObject({
      campaign_id: "camp-1",
      campaign_snap_id: "",
      // 从草稿发布，不是新建。
      coming_source_type: 6,
      sketch_publish_source: 2,
      is_status_disabled: true,
    });
    expect(publish?.body.ad_and_creative_snap_info_list).toEqual([{
      ad_id: "",
      ad_snap_id: "snap-ad-1",
      ad_sketch_id: "ad-1",
      need_publish: true,
      creative_snap_info_list: [{
        creative_id: "",
        creative_snap_id: "snap-cre-1",
        creative_sketch_id: "cre-1",
        need_publish: true,
      }],
    }]);
  });

  it("发布前补 CTA：克隆出来的草稿不带可用的行动引导", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      pages: [[{ adSketchId: "ad-1", name: "A-1", campaignId: "camp-1" }]],
      creativesBySketch: { "ad-1": ["cre-1"] },
    });

    await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1", names: ["A-1"], initialStatus: "disabled",
    });

    const ctaIndex = calls.findIndex((call) => call.path.includes("batch_create_cta_id"));
    const publishIndex = calls.findIndex((call) => call.path.includes("create_by_snap"));
    expect(ctaIndex).toBeGreaterThanOrEqual(0);
    expect(ctaIndex).toBeLessThan(publishIndex);
  });

  it("翻页直到把要的草稿都找齐", async () => {
    const calls: Call[] = [];
    const filler = Array.from({ length: 100 }, (_unused, index) => ({
      adSketchId: `other-${index}`, name: `别的草稿-${index}`, campaignId: "camp-1",
    }));
    stubTikTok({
      calls,
      pages: [filler, [{ adSketchId: "ad-1", name: "A-1", campaignId: "camp-1" }]],
      creativesBySketch: { "ad-1": ["cre-1"] },
    });

    const result = await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1", names: ["A-1"], initialStatus: "disabled",
    });

    expect(result.ok).toBe(true);
    expect(calls.filter((call) => call.path.includes("statistics/sketch/ad/list"))).toHaveLength(2);
  });

  it("草稿找不到就不发，且明确可以重试", async () => {
    const calls: Call[] = [];
    stubTikTok({ calls, pages: [[]], creativesBySketch: {} });

    const result = await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1", names: ["A-1"], initialStatus: "disabled",
    });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("failed");
    expect(result.retrySafe).toBe(true);
    expect(result.message).toContain("没有找到唯一对应的草稿");
    expect(calls.some((call) => call.path.includes("create_by_snap"))).toBe(false);
  });

  it("同名草稿有多份时拒绝猜", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      pages: [[
        { adSketchId: "ad-1", name: "A-1", campaignId: "camp-1" },
        { adSketchId: "ad-2", name: "A-1", campaignId: "camp-1" },
      ]],
      creativesBySketch: { "ad-1": ["cre-1"], "ad-2": ["cre-2"] },
    });

    const result = await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1", names: ["A-1"], initialStatus: "disabled",
    });

    expect(result.ok).toBe(false);
    expect(calls.some((call) => call.path.includes("create_by_snap"))).toBe(false);
  });

  it("连系列都还没建的草稿不碰：那是另一条链路", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      // campaign_id 为空、只有 campaign_sketch_id——真机上确实存在这种草稿。
      pages: [[{ adSketchId: "ad-1", name: "A-1", campaignId: "" }]],
      creativesBySketch: { "ad-1": ["cre-1"] },
    });

    const result = await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1", names: ["A-1"], initialStatus: "disabled",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("连推广系列都还没建");
    expect(calls.some((call) => call.path.includes("create_by_snap"))).toBe(false);
  });

  it("名字对上但系列不对时停手：那是另一个系列里的同名草稿", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      pages: [[{ adSketchId: "ad-1", name: "A-1", campaignId: "camp-99" }]],
      creativesBySketch: { "ad-1": ["cre-1"] },
    });

    const result = await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1", names: ["A-1"], initialStatus: "disabled",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("不在系列");
    expect(calls.some((call) => call.path.includes("create_by_snap"))).toBe(false);
  });

  it("多个草稿并存且归属查不到时停手，绝不把别人的创意挂上来", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      creativeListBroken: true,
      pages: [[
        { adSketchId: "ad-1", name: "A-1", campaignId: "camp-1" },
        { adSketchId: "ad-2", name: "A-2", campaignId: "camp-1" },
      ]],
      creativesBySketch: { "ad-1": ["cre-1"], "ad-2": ["cre-2"] },
    });

    const result = await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1", names: ["A-1"], initialStatus: "disabled",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("无法确定草稿创意归属");
    expect(calls.some((call) => call.path.includes("create_by_snap"))).toBe(false);
  });

  it("系列下只有这一个草稿时，归属接口不可用也能安全发布", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      creativeListBroken: true,
      pages: [[{ adSketchId: "ad-1", name: "A-1", campaignId: "camp-1" }]],
      creativesBySketch: { "ad-1": ["cre-1", "cre-2"] },
    });

    const result = await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1", names: ["A-1"], initialStatus: "disabled",
    });

    expect(result.ok).toBe(true);
    const publish = calls.find((call) => call.path.includes("create_by_snap"));
    const items = publish?.body.ad_and_creative_snap_info_list as Array<Record<string, unknown>>;
    expect(items[0]?.creative_snap_info_list).toHaveLength(2);
  });

  it("多个草稿并存时按归属只带自己的创意", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      pages: [[
        { adSketchId: "ad-1", name: "A-1", campaignId: "camp-1" },
        { adSketchId: "ad-2", name: "A-2", campaignId: "camp-1" },
      ]],
      creativesBySketch: { "ad-1": ["cre-1"], "ad-2": ["cre-2"] },
    });

    const result = await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1", names: ["A-1"], initialStatus: "disabled",
    });

    expect(result.ok).toBe(true);
    const publish = calls.find((call) => call.path.includes("create_by_snap"));
    const items = publish?.body.ad_and_creative_snap_info_list as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    const creatives = items[0]?.creative_snap_info_list as Array<Record<string, unknown>>;
    expect(creatives.map((creative) => creative.creative_sketch_id)).toEqual(["cre-1"]);
  });

  it("开始时间过期的草稿先把排期顶到现在之后再发", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      staleStart: true,
      pages: [[{ adSketchId: "ad-1", name: "A-1", campaignId: "camp-1" }]],
      creativesBySketch: { "ad-1": ["cre-1"] },
    });

    const result = await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1", names: ["A-1"], initialStatus: "disabled",
    });

    expect(result.ok).toBe(true);
    const save = calls.find((call) => call.path.includes("ad_snap/save"));
    expect(save).toBeDefined();
    const form = save?.body.ad_sketch_form_data as Record<string, unknown>;
    expect(String(form.start_time) > "2026-01-01 00:00:00").toBe(true);
    // 只动排期：预算是用户当初设好的，不能顺手改掉。
    expect(form.budget).toBe("50");
    const saveIndex = calls.findIndex((call) => call.path.includes("ad_snap/save"));
    const publishIndex = calls.findIndex((call) => call.path.includes("create_by_snap"));
    expect(saveIndex).toBeLessThan(publishIndex);
  });

  it("开始时间没过期就一个写请求都不发，回到最短路径", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      pages: [[{ adSketchId: "ad-1", name: "A-1", campaignId: "camp-1" }]],
      creativesBySketch: { "ad-1": ["cre-1"] },
    });

    const result = await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1", names: ["A-1"], initialStatus: "disabled",
    });

    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.path.includes("ad_snap/save"))).toBe(false);
  });

  it("草稿保存失败不算「结果未知」：那一步产生不了正式广告组", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      staleStart: true,
      pages: [[{ adSketchId: "ad-1", name: "A-1", campaignId: "camp-1" }]],
      creativesBySketch: { "ad-1": ["cre-1"] },
    });
    const inner = globalThis.fetch as unknown as (input: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (new URL(String(input)).pathname.includes("ad_snap/save")) {
        calls.push({ path: "/api/v4/i18n/creation/ad_snap/save/", body: {} });
        return new Response(JSON.stringify({ code: 40003, msg: "草稿保存被拒" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return inner(input, init);
    }));

    const result = await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1", names: ["A-1"], initialStatus: "disabled",
    });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("failed");
    expect(result.retrySafe).toBe(true);
    expect(calls.some((call) => call.path.includes("create_by_snap"))).toBe(false);
  });

  it("TikTok 明确拒绝发布时判 failed，草稿原样留着可以再点", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      publishRejected: true,
      pages: [[{ adSketchId: "ad-1", name: "A-1", campaignId: "camp-1" }]],
      creativesBySketch: { "ad-1": ["cre-1"] },
    });

    const result = await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1", names: ["A-1"], initialStatus: "disabled",
    });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("failed");
  });

  it("发布出去但终态回读不齐时判 unknown，禁止自动重试", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      publishedAdGroups: 0,
      pages: [[{ adSketchId: "ad-1", name: "A-1", campaignId: "camp-1" }]],
      creativesBySketch: { "ad-1": ["cre-1"] },
    });

    const result = await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1", names: ["A-1"], initialStatus: "disabled",
    });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("unknown");
    expect(result.retrySafe).toBe(false);
  });

  it("发布请求发出之前才调幂等回调", async () => {
    const calls: Call[] = [];
    stubTikTok({ calls, pages: [[]], creativesBySketch: {} });
    const onBeforeDispatch = vi.fn();

    await new CookieAdsProvider().publishExistingDrafts(context(), {
      campaignId: "camp-1", names: ["A-1"], initialStatus: "disabled", onBeforeDispatch,
    });

    // 草稿都没找到，一个写请求都没发，回调不该被调用。
    expect(onBeforeDispatch).not.toHaveBeenCalled();
  });
});
