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

  const stub = (
    adRows: Record<string, unknown>[],
    materialRows: Record<string, unknown>[],
    failedAdIds: string[] = [],
  ) => {
    const failed = new Set(failedAdIds);
    const requested: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requested.push({ path: url.pathname, body });
      if (url.pathname.includes("expand/material/list")) {
        const commonReq = body.common_req as Record<string, unknown> | undefined;
        const filters = commonReq?.filters as Array<Record<string, unknown>> | undefined;
        const creativeFilter = filters?.find((item) => item.field === "creative_id");
        const creativeId = (creativeFilter?.in_field_values as unknown[] | undefined)?.[0];
        if (typeof creativeId === "string" && failed.has(creativeId)) {
          throw new Error("material request failed");
        }
      }
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

  // 素材列表选的是 mix_material 报表。2026-08-10 的真机抓包证实：不带
  // report_id 时 TikTok 回 code 1300100001 拒收整个请求，素材层从上线到那天
  // 一行都没取到过（全库 material 实体数为 0），而空 catch 把原因吞了。
  it("请求体带上 report_id=mix_material，否则 TikTok 整条拒收", async () => {
    const requested = stub(
      [{ campaign_id: "c1", ad_id: "g1", creative_id: "spending-ad", stat_cost: "5" }],
      [materialRow()],
    );

    await new CookieAdsProvider().syncReadOnly!(context());

    const call = requested.find((item) => item.path.includes("expand/material/list"));
    expect(call?.body.report_id).toBe("mix_material");
  });

  // 请求成功不等于取到素材：ID 和状态本身就是 metrics，不点名要就不返回，
  // 于是 extractEntities 认不出 ID、normalizeStatus 判成 unknown，规则一条
  // 都执行不了。真机验证过：只发消耗类指标时 code=0 但素材数仍是 0。
  it("metrics 必须点名要素材 ID 与状态，不然拿回来也用不了", async () => {
    const requested = stub(
      [{ campaign_id: "c1", ad_id: "g1", creative_id: "spending-ad", stat_cost: "5" }],
      [materialRow()],
    );

    await new CookieAdsProvider().syncReadOnly!(context());

    const call = requested.find((item) => item.path.includes("expand/material/list"));
    const metrics = (call?.body.common_req as Record<string, unknown>).metrics as string[];
    expect(metrics).toEqual(expect.arrayContaining([
      "ad_material_draft_id",
      "material_primary_status",
      "material_second_status_list",
      "main_entity_name",
    ]));
  });

  // 已删素材不进管线：它的 material_primary_status 是删除态，normalizeStatus
  // 会误判成 enabled，零加购规则随即产出 disable 候选，向已删素材发写入必被
  // TikTok 拒收，连续失败会打开写入熔断器停掉整账户自动化。源头只拉 is_del=0。
  it("素材列表只请求未删除的素材（is_del=0）", async () => {
    const requested = stub(
      [{ campaign_id: "c1", ad_id: "g1", creative_id: "spending-ad", stat_cost: "5" }],
      [materialRow()],
    );

    await new CookieAdsProvider().syncReadOnly!(context());

    const call = requested.find((item) => item.path.includes("expand/material/list"));
    const filters = (call?.body.common_req as Record<string, unknown>).filters as Array<Record<string, unknown>>;
    expect(filters.find((item) => item.field === "is_del")?.in_field_values).toEqual(["0"]);
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

  // 有行却一条都解析不出来 = 字段形状变了，不是"这些广告没有素材"。
  // 另外三层有 hasRecognizedEntityList 兜底，素材层没有；不拦下来的话
  // completeEntityTypes 会带上 material，saveReadOnlySync 随即清空整层已存
  // 素材快照，而同步质量仍旧显示 healthy——比漏判更糟。
  it("响应有行但解析不出素材 ID 时判为契约不符，不宣称本层取全", async () => {
    stub(
      [{ campaign_id: "c1", ad_id: "g1", creative_id: "spending-ad", stat_cost: "5" }],
      [materialRow({ ad_material_draft_id: "[111,222]" })],
    );

    const output = await new CookieAdsProvider().syncReadOnly!(context());

    expect(output.result.quality.completeEntityTypes).not.toContain("material");
    expect(output.result.quality.partialFailures).toContain("material:contract-invalid");
    expect(output.result.warnings.some((warning) => warning.includes("契约不符"))).toBe(true);
  });

  // 这批广告本来就没有素材（0 行）是正常结果，不能跟上面的契约不符混为一谈，
  // 否则素材层永远宣称不了取全，已存快照再也不会刷新。
  it("响应就是 0 行时仍然算本层取全", async () => {
    stub([{ campaign_id: "c1", ad_id: "g1", creative_id: "spending-ad", stat_cost: "5" }], []);

    const output = await new CookieAdsProvider().syncReadOnly!(context());

    expect(output.result.quality.completeEntityTypes).toContain("material");
    expect(output.result.quality.partialFailures).not.toContain("material:contract-invalid");
  });

  it("记录素材请求失败的所属广告，并保持其他素材可用", async () => {
    stub(
      [
        { campaign_id: "c1", ad_id: "g1", creative_id: "failed-ad", stat_cost: "5" },
        { campaign_id: "c1", ad_id: "g1", creative_id: "healthy-ad", stat_cost: "5" },
      ],
      [materialRow({ creative_id: "healthy-ad" })],
      ["failed-ad"],
    );

    const output = await new CookieAdsProvider().syncReadOnly!(context());

    expect(output.result.quality.status).toBe("partial");
    expect(output.result.quality.partialFailures).toContain("material:request-failed");
    expect(output.result.quality.materialUnavailableAdIds).toEqual(["failed-ad"]);
    expect(output.result.quality.completeEntityTypes).toEqual(
      expect.arrayContaining(["campaign", "ad-group", "ad"]),
    );
    expect(output.result.quality.completeEntityTypes).not.toContain("material");
    expect(output.entities.find((entity) => entity.entityType === "material")?.payload)
      .toMatchObject({ creative_id: "healthy-ad" });
  });

  // 空 catch 让「素材整层拉不动」和「个别广告超时」在界面上长得一模一样。
  // 2026-08-10 线上每轮都报素材失败，真因是 TikTok 直接拒收请求体
  // （code 1300100001），但告警里一个字都没有，连查两轮都没定位到。
  it("把 TikTok 的拒收原因写进告警，而不是只说失败了", async () => {
    stub(
      [{ campaign_id: "c1", ad_id: "g1", creative_id: "failed-ad", stat_cost: "5" }],
      [],
      ["failed-ad"],
    );

    const output = await new CookieAdsProvider().syncReadOnly!(context());

    expect(
      output.result.warnings.find((warning) => warning.includes("素材列表拉取失败")),
    ).toContain("material request failed");
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

  // 素材行里广告组落在 ad_id 上；启停报文缺了广告组 ID 就发不出去，所以同步时
  // 必须回填成 adgroup_id，让父子解析和启停都能从同一个地方取。
  it("素材回填 adgroup_id，父级解析得出来", async () => {
    stub([{ campaign_id: "c1", ad_id: "g1", creative_id: "spending-ad", stat_cost: "5" }], [materialRow()]);

    const output = await new CookieAdsProvider().syncReadOnly!(context());

    const material = output.entities.find((entity) => entity.entityType === "material");
    expect(material?.payload).toMatchObject({ adgroup_id: "1872777456951841" });
  });
});
