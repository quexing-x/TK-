import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieAdsProvider } from "./cookie-provider.js";
import type { ProviderContext } from "./types.js";

/**
 * 素材层。程序化创意下一个广告内含多条素材，投放实际按素材粒度停开。
 * 报文与字段形状全部对照 2026-08-08 的真机抓包。
 */
function context(): ProviderContext {
  return {
    accountId: "test-account",
    timezone: "Asia/Shanghai",
    settings: { kind: "cookie", advertiserId: "654321", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
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
        derived: false,
      }],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("素材启停", () => {
  const capture = () => {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ code: 0, msg: "success", data: {} }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }));
    return sent;
  };

  it("按真机抓包构造素材启停报文", async () => {
    const sent = capture();

    const [result] = await new CookieAdsProvider().changeStatus!(context(), [{
      entityType: "material",
      externalId: "1872777743627569",
      parentAdGroupId: "1872777456951841",
      action: "disable",
    }]);

    expect(result).toMatchObject({ ok: true });
    expect(new URL(sent[0]!.url).pathname)
      .toBe("/api/v3/i18n/overture/procedural_material/update_status/");
    expect(new URL(sent[0]!.url).searchParams.get("req_src")).toBe("bidding");
    expect(sent[0]!.body).toEqual({
      // ad_id 装的是广告组，不是广告——与申诉接口同一套口径。
      ad_id: "1872777456951841",
      material_list: ["1872777743627569"],
      carousel_id_list: [],
      operation: "disable",
      ad_channel: 1,
      risk_info: {},
    });
  });

  // 光有素材 ID 发不出去；构造不出来就不该发请求。
  it("缺广告组 ID 时明确报错且不发请求", async () => {
    const sent = capture();

    const [result] = await new CookieAdsProvider().changeStatus!(context(), [{
      entityType: "material",
      externalId: "1872777743627569",
      action: "disable",
    }]);

    expect(result).toMatchObject({ ok: false, failureKind: "retryable" });
    expect(result?.message).toContain("广告组 ID");
    expect(sent).toHaveLength(0);
  });

  it("没有会话 cURL 时判为可重试，而不是静默跳过", async () => {
    const sent = capture();
    const bare = context();
    if (bare.credential.kind !== "cookie") throw new Error("fixture");
    bare.credential.requestTemplates = [];

    const [result] = await new CookieAdsProvider().changeStatus!(bare, [{
      entityType: "material",
      externalId: "1872777743627569",
      parentAdGroupId: "1872777456951841",
      action: "enable",
    }]);

    expect(result).toMatchObject({ ok: false, failureKind: "retryable" });
    expect(sent).toHaveLength(0);
  });
});

describe("素材同步", () => {
  /** 真机 expand/material/list 的一行，字段名照抄抓包。 */
  const materialRow = (patch: Record<string, unknown> = {}) => ({
    ad_id: "1872777456951841",
    creative_id: "1872777482921138",
    campaign_id: "1872777412254065",
    ad_material_draft_id: "[1872777743628513]",
    main_entity_id: "7662275916806049042",
    main_entity_name: "Pocketalk國際超多國語言「快速翻譯機」",
    main_entity_type: "post_video",
    material_primary_status: "delivery_ok",
    material_second_status_list: '["creative_delivery_ok"]',
    stat_cost: "26.82",
    click_cnt: "115",
    time_attr_convert_cnt: "5",
    time_attr_on_web_cart: "3",
    show_cnt: "9586",
    ...patch,
  });

  const stub = (adRows: Record<string, unknown>[], materialRows: Record<string, unknown>[]) => {
    const requested: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requested.push({ path: url.pathname, body });
      const table = url.pathname.includes("expand/material/list") ? materialRows : adRows;
      return new Response(
        JSON.stringify({ code: 0, data: { table, pagination: { page: 1, page_count: 1 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }));
    return requested;
  };

  it("只对当天有消耗的广告拉素材", async () => {
    const requested = stub(
      [
        { campaign_id: "c1", ad_id: "g1", creative_id: "spending-ad", stat_cost: "26.82" },
        { campaign_id: "c1", ad_id: "g2", creative_id: "idle-ad", stat_cost: "0" },
      ],
      [materialRow()],
    );

    await new CookieAdsProvider().syncReadOnly!(context());

    const materialCalls = requested.filter((item) => item.path.includes("expand/material/list"));
    // 零消耗的广告不查：素材列表只能按广告逐个查，全查会把一轮轮询拖垮，
    // 而九条规则全都要消耗，零消耗的素材永远触发不了。
    expect(materialCalls).toHaveLength(1);
    const filters = (materialCalls[0]!.body.common_req as Record<string, unknown>).filters as Array<Record<string, unknown>>;
    expect(filters.find((item) => item.field === "creative_id")?.in_field_values)
      .toEqual(["spending-ad"]);
  });

  it("素材 ID 从字符串包着的数组里取出裸数字", async () => {
    stub([{ campaign_id: "c1", ad_id: "g1", creative_id: "spending-ad", stat_cost: "5" }], [materialRow()]);

    const output = await new CookieAdsProvider().syncReadOnly!(context());

    const material = output.entities.find((entity) => entity.entityType === "material");
    // 真机写成 "[1872777743628513]"，连方括号发出去会被 TikTok 拒收。
    expect(material?.externalId).toBe("1872777743628513");
  });

  it("素材 ID 不是单个时跳过，不猜一个", async () => {
    stub(
      [{ campaign_id: "c1", ad_id: "g1", creative_id: "spending-ad", stat_cost: "5" }],
      [materialRow({ ad_material_draft_id: "[111,222]" }), materialRow({ ad_material_draft_id: "[]" })],
    );

    const output = await new CookieAdsProvider().syncReadOnly!(context());

    expect(output.entities.filter((entity) => entity.entityType === "material")).toHaveLength(0);
  });

  it("素材带上自己的消耗与转化，规则才判得动", async () => {
    stub([{ campaign_id: "c1", ad_id: "g1", creative_id: "spending-ad", stat_cost: "5" }], [materialRow()]);

    const output = await new CookieAdsProvider().syncReadOnly!(context());

    const material = output.entities.find((entity) => entity.entityType === "material");
    expect(material?.payload).toMatchObject({
      stat_cost: "26.82",
      time_attr_convert_cnt: "5",
      time_attr_on_web_cart: "3",
      ad_id: "1872777456951841",
    });
  });
});
