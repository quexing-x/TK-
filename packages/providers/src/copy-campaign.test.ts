import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieAdsProvider } from "./cookie-provider.js";
import type { ProviderContext } from "./types.js";

function context(options: { adStatusTemplate?: boolean } = {}): ProviderContext {
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
      requestTemplates: [
        {
          target: "ad-group",
          url: "https://ads.tiktok.com/api/v3/i18n/statistics/op/adgroup/list/?aadvid=654321",
          method: "POST",
          body: "{}",
          contentType: "application/json",
        },
        ...(options.adStatusTemplate === false ? [] : [{
          target: "ad-status" as const,
          action: "enable" as const,
          url: "https://ads.tiktok.com/api/v4/i18n/ad/update_status/?aadvid=654321",
          method: "POST" as const,
          body: '{"creative_id":"captured-ad","operation":"enable"}',
          contentType: "application/json",
        }]),
      ],
    },
  };
}

/** 两个源广告组的系列复制草稿，字段形状对照真机 campaign_snap/copy 响应。 */
function copyResponse(creativesPerGroup = 1) {
  const creativeSnaps = (group: string) =>
    Array.from({ length: creativesPerGroup }, (_unused, index) => ({
      creative_snap_id: `cre-${group}${index === 0 ? "" : `-${index + 1}`}`,
    }));
  const creativeSketches = (group: string) =>
    Array.from({ length: creativesPerGroup }, (_unused, index) =>
      `cre-sketch-${group}${index === 0 ? "" : `-${index + 1}`}`);
  return {
    code: 0,
    msg: "success",
    data: {
      new_campaign_snap_info_item: {
        campaign_snap_id: "camp-snap",
        campaign_snap_form_data: {
          campaign_name: "源系列 的副本 1",
          budget: "88",
          budget_mode: 3,
          budget_optimize_switch: 1,
          origin_campaign_id: 90001,
        },
      },
      new_campaign_sketch_id: "camp-sketch",
      new_ad_snap_info_item_list: [
        { ad_snap_id: "snap-A", ad_snap_form_data: { ad_snap_id: "snap-A", origin_ad_id: "src-A" } },
        { ad_snap_id: "snap-B", ad_snap_form_data: { ad_snap_id: "snap-B", origin_ad_id: "src-B" } },
      ],
      new_ad_sketch_ids: ["sketch-A", "sketch-B"],
      new_ad_and_creative_snap_info_item_map: {
        "snap-A": creativeSnaps("A"),
        "snap-B": creativeSnaps("B"),
      },
      new_ad_and_creative_sketch_ids_map: {
        "sketch-A": creativeSketches("A"),
        "sketch-B": creativeSketches("B"),
      },
    },
  };
}

interface Call { path: string; body: Record<string, unknown> }

function stubTikTok(options: {
  calls: Call[];
  cboAllSuccess?: boolean;
  adGroupCount?: number;
  /**
   * 在匹配路径命中真正返回响应之前，先制造 N 次网络失败——用来验证传输层
   * 重试。失败的尝试同样计入 calls，方便断言重试真的发生过。
   */
  failFirst?: { path: string; times: number; code: string };
  /** 每个广告组里的广告条数，默认 1。 */
  creativesPerGroup?: number;
  /**
   * 发布终态里 ad_and_creative / asset_group_result / creative_items 的容器形状。
   * 真机回的是以下标为键的对象映射，不是数组；数组形状只是历史桩的简化。
   */
  publishShape?: "array" | "map";
  /** 广告层开关请求返回业务失败（code≠0）。 */
  failAdStatus?: boolean;
}) {
  const creativesPerGroup = options.creativesPerGroup ?? 1;
  /** 数组或「下标为键」的对象映射——真机两种都出现过，解析必须都认。 */
  const shaped = <T,>(items: T[]): T[] | Record<string, T> =>
    options.publishShape === "map" ? Object.fromEntries(items.map((item, index) => [index, item])) : items;
  // 草稿的服务端状态：ad_snap/save 写入什么，snap/detail 就回读什么。
  // 回读校验是这条链路的安全网，桩必须真实反映它才有意义。
  const draftForms = new Map<string, Record<string, unknown>>([
    ["snap-A", { ad_snap_id: "snap-A", ad_sketch_id: "sketch-A", ad_name: "组A原名", budget: "", budget_mode: -1 }],
    ["snap-B", { ad_snap_id: "snap-B", ad_sketch_id: "sketch-B", ad_name: "组B原名", budget: "", budget_mode: -1 }],
  ]);
  let remainingFailures = options.failFirst?.times ?? 0;

  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    options.calls.push({ path, body });
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

    if (options.failFirst && path.includes(options.failFirst.path) && remainingFailures > 0) {
      remainingFailures -= 1;
      const cause = Object.assign(new Error("simulated"), { code: options.failFirst.code });
      throw new Error("fetch failed", { cause });
    }

    if (path.includes("campaign_snap/copy")) return json(copyResponse(creativesPerGroup));
    if (path.includes("/ad/update_status")) {
      return options.failAdStatus
        ? json({ code: 40100, msg: "广告状态更新被拒绝" })
        : json({ code: 0, msg: "success", data: {} });
    }
    if (path.includes("ad_sketch/delete")) {
      for (const sketchId of (body.ad_sketch_ids as string[] | undefined) ?? []) {
        for (const [snapId, form] of draftForms) {
          if (form.ad_sketch_id === sketchId) draftForms.delete(snapId);
        }
      }
      return json({ code: 0, msg: "success", data: {} });
    }
    if (path.includes("ad_snap/save")) {
      const form = body.ad_sketch_form_data as Record<string, unknown>;
      const snapId = String(form.ad_snap_id);
      draftForms.set(snapId, { ...draftForms.get(snapId), ...form });
      return json({ code: 0, data: { ad_snap_id: snapId, ad_sketch_id: form.ad_sketch_id } });
    }
    if (path.includes("snap/detail")) {
      const ids = (body.ad_snap_ids as string[] | undefined) ?? [];
      return json({
        code: 0,
        data: {
          ad_snap_map: Object.fromEntries(
            ids.filter((id) => draftForms.has(id)).map((id) => [id, draftForms.get(id)]),
          ),
        },
      });
    }
    if (path.includes("cbo_consistency_check")) {
      return json({ code: 0, data: { is_all_success: options.cboAllSuccess ?? true } });
    }
    if (path.includes("create_by_snap")) {
      const count = options.adGroupCount ?? 1;
      return json({
        code: 0,
        data: {
          result: {
            ad_and_creative: shaped(Array.from({ length: count }, (_unused, groupIndex) => ({
              ad_id: `new-group-${groupIndex + 1}`,
              adgroup_id: `new-group-${groupIndex + 1}`,
              asset_group_result: shaped([{
                creative_items: shaped(Array.from(
                  { length: creativesPerGroup },
                  (_ignored, creativeIndex) => ({
                    id: `new-ad-${groupIndex + 1}-${creativeIndex + 1}`,
                  }),
                )),
              }]),
            }))),
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

describe("CookieAdsProvider.copyCampaign", () => {
  it("按 origin_ad_id 对回源广告组，并删掉未选中的草稿组", async () => {
    const calls: Call[] = [];
    stubTikTok({ calls });
    const provider = new CookieAdsProvider();

    await provider.copyCampaign(context(), {
      sourceCampaignId: "90001",
      campaignName: "源系列-0730-1",
      // 只保留第二个源广告组：这正是「1 系列 2 组 → 2 系列各 1 组」的拆分场景。
      adGroups: [{ sourceAdGroupId: "src-B", name: "组B-0730-1" }],
      initialStatus: "disabled",
    });

    const deleteCall = calls.find((call) => call.path.includes("ad_sketch/delete"));
    expect(deleteCall).toBeDefined();
    // 删的是没被选中的 A 组，且用的是 ad_sketch_id 而不是 ad_snap_id。
    expect(deleteCall?.body.ad_sketch_ids).toEqual(["sketch-A"]);

    const publish = calls.find((call) => call.path.includes("create_by_snap"));
    const publishItems = publish?.body.ad_and_creative_snap_info_list as Array<Record<string, unknown>>;
    expect(publishItems).toHaveLength(1);
    expect(publishItems[0]?.ad_snap_id).toBe("snap-B");
    // 创意必须来自 B 组，串到 A 组的创意是本功能最危险的静默错误。
    const creatives = publishItems[0]?.creative_snap_info_list as Array<Record<string, unknown>>;
    expect(creatives[0]?.creative_snap_id).toBe("cre-B");
    expect(creatives[0]?.creative_sketch_id).toBe("cre-sketch-B");
  });

  it("走完整链路：复制 → 系列保存 → CBO 门禁 → CTA → 一次原子发布", async () => {
    const calls: Call[] = [];
    stubTikTok({ calls, adGroupCount: 2 });
    const provider = new CookieAdsProvider();

    const result = await provider.copyCampaign(context(), {
      sourceCampaignId: "90001",
      campaignName: "源系列-0730-1",
      adGroups: [
        { sourceAdGroupId: "src-A", name: "组A-0730-1" },
        { sourceAdGroupId: "src-B", name: "组B-0730-1" },
      ],
      initialStatus: "disabled",
    });

    expect(result.ok).toBe(true);
    const order = calls.map((call) => call.path.split("/creation/")[1]?.replace(/\/$/, ""));
    expect(order.filter(Boolean)).toEqual(expect.arrayContaining([
      "campaign_snap/copy",
      "campaign_snap/save",
      "snap/cbo_consistency_check",
      "snap/batch_create_cta_id",
      "async_creation/create_by_snap",
    ]));
    // 两组都保留时不应发出任何删除请求。
    expect(calls.some((call) => call.path.includes("ad_sketch/delete"))).toBe(false);

    const publish = calls.find((call) => call.path.includes("create_by_snap"));
    expect(publish?.body.campaign_id).toBe("");
    expect(publish?.body.campaign_snap_id).toBe("camp-snap");
    // 新系列是整批发布，不是往已有系列里补发。
    expect(publish?.body.is_partial_publish).toBe(false);
  });

  it("系列金额归一化成两位小数后再回写", async () => {
    const calls: Call[] = [];
    stubTikTok({ calls, adGroupCount: 2 });
    const provider = new CookieAdsProvider();

    await provider.copyCampaign(context(), {
      sourceCampaignId: "90001",
      campaignName: "源系列-0730-1",
      adGroups: [
        { sourceAdGroupId: "src-A", name: "组A" },
        { sourceAdGroupId: "src-B", name: "组B" },
      ],
      initialStatus: "disabled",
    });

    const save = calls.find((call) => call.path.includes("campaign_snap/save"));
    const form = save?.body.campaign_sketch_form_data as Record<string, unknown>;
    // 复制响应回的是 "88"，保存必须发 "88.00"。
    expect(form.budget).toBe("88.00");
    expect(form.budget_mode).toBe(3);
    expect(form.budget_optimize_switch).toBe(1);
    expect(form.campaign_name).toBe("源系列-0730-1");
  });

  it("显式覆盖系列预算时改写金额", async () => {
    const calls: Call[] = [];
    stubTikTok({ calls, adGroupCount: 2 });
    const provider = new CookieAdsProvider();

    await provider.copyCampaign(context(), {
      sourceCampaignId: "90001",
      campaignName: "源系列-0730-1",
      adGroups: [
        { sourceAdGroupId: "src-A", name: "组A" },
        { sourceAdGroupId: "src-B", name: "组B" },
      ],
      initialStatus: "disabled",
      campaignBudget: 200,
    });

    const save = calls.find((call) => call.path.includes("campaign_snap/save"));
    const form = save?.body.campaign_sketch_form_data as Record<string, unknown>;
    expect(form.budget).toBe("200.00");
  });

  it("CBO 一致性校验不通过时停在发布之前", async () => {
    const calls: Call[] = [];
    stubTikTok({ calls, cboAllSuccess: false, adGroupCount: 2 });
    const provider = new CookieAdsProvider();

    const result = await provider.copyCampaign(context(), {
      sourceCampaignId: "90001",
      campaignName: "源系列-0730-1",
      adGroups: [
        { sourceAdGroupId: "src-A", name: "组A" },
        { sourceAdGroupId: "src-B", name: "组B" },
      ],
      initialStatus: "disabled",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("系列预算一致性校验未通过");
    expect(calls.some((call) => call.path.includes("create_by_snap"))).toBe(false);
  });

  it("源广告组不在草稿里时，在发布前停止且允许重试", async () => {
    const calls: Call[] = [];
    stubTikTok({ calls });
    const provider = new CookieAdsProvider();

    const result = await provider.copyCampaign(context(), {
      sourceCampaignId: "90001",
      campaignName: "源系列-0730-1",
      adGroups: [{ sourceAdGroupId: "src-UNKNOWN", name: "组X" }],
      initialStatus: "disabled",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("不在本次系列复制的草稿中");
    // 只产生了草稿，没有发布任何正式对象，重试是安全的。
    expect(result.retrySafe).toBe(true);
    expect(calls.some((call) => call.path.includes("create_by_snap"))).toBe(false);
  });

  it("终态数量不符时判为未知结果，禁止自动重试", async () => {
    const calls: Call[] = [];
    // 请求发布 2 个组，但终态只回 1 个。
    stubTikTok({ calls, adGroupCount: 1 });
    const provider = new CookieAdsProvider();

    const result = await provider.copyCampaign(context(), {
      sourceCampaignId: "90001",
      campaignName: "源系列-0730-1",
      adGroups: [
        { sourceAdGroupId: "src-A", name: "组A" },
        { sourceAdGroupId: "src-B", name: "组B" },
      ],
      initialStatus: "disabled",
    });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("unknown");
    expect(result.retrySafe).toBe(false);
  });

  it("ECONNREFUSED 两次后自愈：传输层自动重试，系列复制仍然完成", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      adGroupCount: 2,
      failFirst: { path: "campaign_snap/copy", times: 2, code: "ECONNREFUSED" },
    });
    const provider = new CookieAdsProvider();

    const result = await provider.copyCampaign(context(), {
      sourceCampaignId: "90001",
      campaignName: "源系列-0730-1",
      adGroups: [
        { sourceAdGroupId: "src-A", name: "组A" },
        { sourceAdGroupId: "src-B", name: "组B" },
      ],
      initialStatus: "disabled",
    });

    expect(result.ok).toBe(true);
    // 前两次因 ECONNREFUSED 被吞掉重试，第三次才真正拿到响应。
    const copyAttempts = calls.filter((call) => call.path.includes("campaign_snap/copy"));
    expect(copyAttempts).toHaveLength(3);
  }, 10_000);

  it("ECONNREFUSED 超过重试上限：仍判定为可安全重试而非永久锁死", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      failFirst: { path: "campaign_snap/copy", times: 3, code: "ECONNREFUSED" },
    });
    const provider = new CookieAdsProvider();

    const result = await provider.copyCampaign(context(), {
      sourceCampaignId: "90001",
      campaignName: "源系列-0730-1",
      adGroups: [{ sourceAdGroupId: "src-A", name: "组A" }],
      initialStatus: "disabled",
    });

    expect(result.ok).toBe(false);
    // 一次都没有成功拿到响应：没有产生任何草稿，重试是安全的。
    expect(result.retrySafe).toBe(true);
    const copyAttempts = calls.filter((call) => call.path.includes("campaign_snap/copy"));
    expect(copyAttempts).toHaveLength(3);
  }, 10_000);

  // 复制是让 TikTok 按源对象克隆，广告的开关状态一并被克隆过来：源组里的广告是关的，
  // 新组里的广告也是关的，于是组开着、广告关着，整组投不出去。发布载荷里只有
  // is_status_disabled 一个开关且只作用于广告组层，创意快照里没有状态字段，所以只能
  // 在拿到新建的广告 ID 之后再显式开一次。
  describe("复制后显式开启新建的广告", () => {
    const enableCalls = (calls: Call[]) => calls.filter((call) => call.path.includes("/ad/update_status"));

    it("组以 enabled 发布时，逐条开启本次新建的广告", async () => {
      const calls: Call[] = [];
      stubTikTok({ calls, adGroupCount: 2 });
      const provider = new CookieAdsProvider();

      const result = await provider.copyCampaign(context(), {
        sourceCampaignId: "90001",
        campaignName: "源系列-0730-1",
        adGroups: [
          { sourceAdGroupId: "src-A", name: "组A" },
          { sourceAdGroupId: "src-B", name: "组B" },
        ],
        initialStatus: "enabled",
      });

      expect(result.ok).toBe(true);
      const enables = enableCalls(calls);
      // 只开本次发布回来的两条广告，不多也不少。
      expect(enables.map((call) => call.body.creative_id)).toEqual(["new-ad-1-1", "new-ad-2-1"]);
      // 开启必须发生在发布之后——广告 ID 是发布终态才有的。
      const publishIndex = calls.findIndex((call) => call.path.includes("create_by_snap"));
      expect(calls.indexOf(enables[0]!)).toBeGreaterThan(publishIndex);
      expect(enables[0]?.body.operation).toBe("enable");
    });

    it("终态用「下标为键」的对象映射回多条广告时，全部提取并开启", async () => {
      const calls: Call[] = [];
      // 真机回的 ad_and_creative / asset_group_result / creative_items 都是对象映射。
      stubTikTok({ calls, adGroupCount: 2, creativesPerGroup: 2, publishShape: "map" });
      const provider = new CookieAdsProvider();

      const result = await provider.copyCampaign(context(), {
        sourceCampaignId: "90001",
        campaignName: "源系列-0730-1",
        adGroups: [
          { sourceAdGroupId: "src-A", name: "组A" },
          { sourceAdGroupId: "src-B", name: "组B" },
        ],
        initialStatus: "enabled",
      });

      expect(result.ok).toBe(true);
      expect(enableCalls(calls).map((call) => call.body.creative_id)).toEqual([
        "new-ad-1-1", "new-ad-1-2", "new-ad-2-1", "new-ad-2-2",
      ]);
    });

    it("组以 disabled 发布时一条都不开", async () => {
      const calls: Call[] = [];
      stubTikTok({ calls, adGroupCount: 2 });
      const provider = new CookieAdsProvider();

      const result = await provider.copyCampaign(context(), {
        sourceCampaignId: "90001",
        campaignName: "源系列-0730-1",
        adGroups: [
          { sourceAdGroupId: "src-A", name: "组A" },
          { sourceAdGroupId: "src-B", name: "组B" },
        ],
        initialStatus: "disabled",
      });

      expect(result.ok).toBe(true);
      expect(enableCalls(calls)).toHaveLength(0);
    });

    // 原生定时投放的组同样是以 enabled 发布的，拦住投放的是 TikTok 按广告组排期判定的
    // ad_time_no_reach，不是广告自己的开关。生产快照里创建即为关闭的 6 条广告有 5 条
    // 属于定时批次，跳过定时批次等于这个修复基本没生效。
    it("定时投放的组也要开：组以 enabled 发布，排期由 TikTok 把关", async () => {
      const calls: Call[] = [];
      stubTikTok({ calls, adGroupCount: 2 });
      const provider = new CookieAdsProvider();

      const result = await provider.copyCampaign(context(), {
        sourceCampaignId: "90001",
        campaignName: "源系列-0730-1",
        adGroups: [
          { sourceAdGroupId: "src-A", name: "组A" },
          { sourceAdGroupId: "src-B", name: "组B" },
        ],
        initialStatus: "disabled",
        scheduledStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

      expect(result.ok).toBe(true);
      const publish = calls.find((call) => call.path.includes("create_by_snap"));
      expect(publish?.body.is_status_disabled).toBe(false);
      expect(enableCalls(calls).map((call) => call.body.creative_id)).toEqual(["new-ad-1-1", "new-ad-2-1"]);
    });

    it("开启失败不推翻整次创建，失败明细进返回消息", async () => {
      const calls: Call[] = [];
      stubTikTok({ calls, adGroupCount: 2, failAdStatus: true });
      const provider = new CookieAdsProvider();

      const result = await provider.copyCampaign(context(), {
        sourceCampaignId: "90001",
        campaignName: "源系列-0730-1",
        adGroups: [
          { sourceAdGroupId: "src-A", name: "组A" },
          { sourceAdGroupId: "src-B", name: "组B" },
        ],
        initialStatus: "enabled",
      });

      // 广告组已经建好了，把这次判成失败会诱发重复创建。
      expect(result.ok).toBe(true);
      expect(result.message).toContain("2 条广告未能自动开启");
      expect(result.message).toContain("new-ad-1-1");
      expect(result.message).toContain("new-ad-2-1");
      // 一条失败不能拖累后面的，两条都必须尝试过。
      expect(enableCalls(calls)).toHaveLength(2);
    });

    it("没有广告层开关模板时照常返回成功，并说明广告保持了克隆来的状态", async () => {
      const calls: Call[] = [];
      stubTikTok({ calls, adGroupCount: 2 });
      const provider = new CookieAdsProvider();

      const result = await provider.copyCampaign(context({ adStatusTemplate: false }), {
        sourceCampaignId: "90001",
        campaignName: "源系列-0730-1",
        adGroups: [
          { sourceAdGroupId: "src-A", name: "组A" },
          { sourceAdGroupId: "src-B", name: "组B" },
        ],
        initialStatus: "enabled",
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("缺少广告层开关模板");
      expect(enableCalls(calls)).toHaveLength(0);
    });
  });

  it("ECONNRESET 不重试：连接可能已经建立，安全边界不因优化而放松", async () => {
    const calls: Call[] = [];
    stubTikTok({
      calls,
      failFirst: { path: "campaign_snap/copy", times: 1, code: "ECONNRESET" },
    });
    const provider = new CookieAdsProvider();

    const result = await provider.copyCampaign(context(), {
      sourceCampaignId: "90001",
      campaignName: "源系列-0730-1",
      adGroups: [{ sourceAdGroupId: "src-A", name: "组A" }],
      initialStatus: "disabled",
    });

    expect(result.ok).toBe(false);
    // ECONNRESET 只失败了一次就该停手——不属于「证明请求从未发出」的安全类别。
    const copyAttempts = calls.filter((call) => call.path.includes("campaign_snap/copy"));
    expect(copyAttempts).toHaveLength(1);
  });
});
