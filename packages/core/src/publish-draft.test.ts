import { describe, expect, it } from "vitest";
import {
  buildDraftPublishPayload,
  buildDraftSketchListPayload,
  matchDraftSketchesByName,
  parseDraftCreativeOwners,
  parseDraftSketchList,
  parseSketchSnapMapping,
  resolveDraftPublishTargets,
  selectStaleDrafts,
  type DraftSketchEntry,
} from "./publish-draft.js";

const sketch = (name: string, id: string, campaignId = "1874278019329169"): DraftSketchEntry => ({
  adSketchId: id,
  adSketchName: name,
  campaignId,
  campaignSketchId: "",
  touchedAt: null,
});

describe("buildDraftSketchListPayload", () => {
  it("keeps the captured sort and clamps the page window", () => {
    expect(buildDraftSketchListPayload(1, 20)).toEqual({
      query_list: [], page: 1, limit: 20, sort_order: 1, sort_stat: "modify_time", filters: [],
    });
    expect(buildDraftSketchListPayload(0, 9999)).toMatchObject({ page: 1, limit: 100 });
  });
});

describe("parseDraftSketchList", () => {
  it("reads data.table, not data.list", () => {
    expect(parseDraftSketchList({
      data: {
        table: [{
          ad_sketch_id: "1874514740509986",
          ad_sketch_name: "DM003182 的副本 1",
          campaign_id: "1874278019329169",
          campaign_sketch_id: "0",
        }],
      },
    })).toEqual([{
      adSketchId: "1874514740509986",
      adSketchName: "DM003182 的副本 1",
      campaignId: "1874278019329169",
      // "0" 是占位，等价于没有系列草稿。
      campaignSketchId: "",
      touchedAt: null,
    }]);
  });

  it("取最晚的那个时间戳：判「有没有人正在动它」要看最后一次改动", () => {
    const [entry] = parseDraftSketchList({
      data: {
        table: [{
          ad_sketch_id: "1", ad_sketch_name: "A",
          ad_create_time: 1_787_000_000, ad_modify_time: 1_787_700_000,
        }],
      },
    });
    expect(entry?.touchedAt).toBe(1_787_700_000);
  });

  it("drops rows without a usable id or name instead of inventing one", () => {
    expect(parseDraftSketchList({
      data: { table: [{ ad_sketch_id: "0", ad_sketch_name: "x" }, { ad_sketch_id: "1", ad_sketch_name: "  " }] },
    })).toEqual([]);
  });

  it("survives a response that is not shaped like a list", () => {
    expect(parseDraftSketchList(null)).toEqual([]);
    expect(parseDraftSketchList({ data: { table: "nope" } })).toEqual([]);
  });
});

describe("matchDraftSketchesByName", () => {
  it("matches the failed record's generated names", () => {
    const result = matchDraftSketchesByName(
      ["A-0826-060000-1", "B-0826-060000-1"],
      [sketch("A-0826-060000-1", "11"), sketch("B-0826-060000-1", "12")],
    );
    expect(result.matched.map((entry) => entry.adSketchId)).toEqual(["11", "12"]);
    expect(result.missing).toEqual([]);
  });

  it("refuses to guess when the same name has more than one draft", () => {
    const result = matchDraftSketchesByName(
      ["A-0826-060000-1"],
      [sketch("A-0826-060000-1", "11"), sketch("A-0826-060000-1", "12")],
    );
    expect(result.matched).toEqual([]);
    expect(result.missing).toEqual(["A-0826-060000-1"]);
  });

  it("reports names with no draft at all", () => {
    const result = matchDraftSketchesByName(["A", "B"], [sketch("A", "11")]);
    expect(result.matched).toHaveLength(1);
    expect(result.missing).toEqual(["B"]);
  });

  it("trims and de-duplicates the wanted names", () => {
    const result = matchDraftSketchesByName([" A ", "A", ""], [sketch("A", "11")]);
    expect(result.matched).toHaveLength(1);
    expect(result.missing).toEqual([]);
  });
});

describe("resolveDraftPublishTargets", () => {
  // 部分成功是常态：一次扩 3 个，终态回来「广告组 2/3」。要求 3 个名字都对上草稿，
  // 整批就会被拒，那 1 个停在草稿的永远发不出去——而它恰恰是唯一还需要处理的。
  it("部分成功时只发还停在草稿的那些，已经建成的跳过", () => {
    const result = resolveDraftPublishTargets(
      ["A", "B", "C"],
      [sketch("C", "13")],
      ["A", "B"],
    );
    expect(result.matched.map((entry) => entry.adSketchId)).toEqual(["13"]);
    expect(result.alreadyPublished).toEqual(["A", "B"]);
    expect(result.missing).toEqual([]);
  });

  // 「不在草稿里」本身证明不了任何事：可能已被人手动发布，也可能已被删除。把没证明过的
  // 也当成「已经建成」，一个被删掉的草稿就会被悄悄收口，那批组永远没人认领。
  it("证不出来是正式组的一律进 missing，调用方必须停手", () => {
    const result = resolveDraftPublishTargets(["A", "B"], [sketch("A", "11")], []);
    expect(result.matched.map((entry) => entry.adSketchId)).toEqual(["11"]);
    expect(result.alreadyPublished).toEqual([]);
    expect(result.missing).toEqual(["B"]);
  });

  // 同名草稿有多份仍然拒绝：这是「挑哪个都可能挑错」，不是「已经建成」。名字碰巧也出现在
  // 正式组名单里（重试过就会这样）不能把它降级成可跳过。
  it("同名草稿有多份时不因为存在同名正式组就跳过", () => {
    const result = resolveDraftPublishTargets(
      ["A"],
      [sketch("A", "11"), sketch("A", "12")],
      ["A"],
    );
    expect(result.matched).toEqual([]);
    expect(result.alreadyPublished).toEqual(["A"]);
    expect(result.missing).toEqual([]);
  });

  // 草稿优先于快照，理由同 reconcileExpandTask：同名的正式组只能说明「重试过、有一次
  // 成功了」，不能说明这一条已经收口。
  it("既是草稿又有同名正式组时，发草稿", () => {
    const result = resolveDraftPublishTargets(["A"], [sketch("A", "11")], ["A"]);
    expect(result.matched.map((entry) => entry.adSketchId)).toEqual(["11"]);
    expect(result.alreadyPublished).toEqual([]);
  });

  it("全部都已经建成时没有可发的，也没有不知去向的", () => {
    const result = resolveDraftPublishTargets(["A", "B"], [], ["A", "B"]);
    expect(result.matched).toEqual([]);
    expect(result.alreadyPublished).toEqual(["A", "B"]);
    expect(result.missing).toEqual([]);
  });
});

describe("selectStaleDrafts", () => {
  const now = new Date("2026-08-26T12:00:00Z");
  const aged = (name: string, hoursAgo: number): DraftSketchEntry => ({
    ...sketch(name, `id-${name}`),
    touchedAt: (now.getTime() - hoursAgo * 3_600_000) / 1000,
  });

  it("只挑超过保护期没人动过的", () => {
    const result = selectStaleDrafts([aged("老", 4), aged("刚碰过", 1)], { now });
    expect(result.stale.map((entry) => entry.adSketchName)).toEqual(["老"]);
    expect(result.tooFresh).toBe(1);
  });

  // 保护期是这个功能的全部安全性所在：扩组本身就是先建草稿再发布，轮询正在跑的那一刻
  // 后台必然有草稿；人在界面上手搓广告组时后台也躺着一个。
  it("正好卡在保护期边界上的不删", () => {
    expect(selectStaleDrafts([aged("边界", 3)], { now }).stale).toHaveLength(1);
    expect(selectStaleDrafts([aged("差一点", 2.99)], { now }).stale).toHaveLength(0);
  });

  it("保护期可以调", () => {
    expect(selectStaleDrafts([aged("六小时", 6)], { now, minAgeHours: 12 }).stale).toHaveLength(0);
    expect(selectStaleDrafts([aged("六小时", 6)], { now, minAgeHours: 1 }).stale).toHaveLength(1);
  });

  // 宁可漏删，不可误删。
  it("取不到时间戳的一律保住", () => {
    const result = selectStaleDrafts([sketch("没时间戳", "x")], { now });
    expect(result.stale).toHaveLength(0);
    expect(result.tooFresh).toBe(1);
  });

  it("还挂着「结果未知」的组名不替人删——那是等人决定发布还是放弃的", () => {
    const result = selectStaleDrafts([aged("待决策", 99), aged("垃圾", 99)], {
      now, protectedNames: ["待决策"],
    });
    expect(result.stale.map((entry) => entry.adSketchName)).toEqual(["垃圾"]);
    expect(result.reserved).toBe(1);
  });

  it("待决策优先于保护期：刚建的也算保住，不重复计数", () => {
    const result = selectStaleDrafts([aged("待决策", 0.1)], { now, protectedNames: ["待决策"] });
    expect(result).toMatchObject({ tooFresh: 0, reserved: 1 });
    expect(result.stale).toHaveLength(0);
  });
});

describe("parseSketchSnapMapping", () => {
  it("reads both maps from the save_by_sketch response", () => {
    const mapping = parseSketchSnapMapping({
      data: {
        ad_sketch_id_to_snap_id: { "1874514740509986": "1874514790077570" },
        creative_sketch_id_to_snap_id: { "1874514740510002": "1874514790079554" },
      },
    });
    expect(mapping.adSnapBySketch.get("1874514740509986")).toBe("1874514790077570");
    expect(mapping.creativeSnapBySketch.get("1874514740510002")).toBe("1874514790079554");
  });

  it("accepts a response whose maps sit at the top level", () => {
    const mapping = parseSketchSnapMapping({ ad_sketch_id_to_snap_id: { a: "b" } });
    expect(mapping.adSnapBySketch.get("a")).toBe("b");
  });

  it("drops placeholder ids rather than publishing against them", () => {
    const mapping = parseSketchSnapMapping({ data: { ad_sketch_id_to_snap_id: { a: "0", b: "" } } });
    expect(mapping.adSnapBySketch.size).toBe(0);
  });
});

describe("parseDraftCreativeOwners", () => {
  it("maps each creative sketch to the ad group it belongs to", () => {
    const owners = parseDraftCreativeOwners({
      data: { table: [{ creative_sketch_id: "c1", ad_sketch_id: "a1" }, { creative_sketch_id: "c2", ad_sketch_id: "a2" }] },
    });
    expect(owners.get("c1")).toBe("a1");
    expect(owners.get("c2")).toBe("a2");
  });

  it("ignores rows that cannot state both sides of the relation", () => {
    expect(parseDraftCreativeOwners({ data: { table: [{ creative_sketch_id: "c1" }] } }).size).toBe(0);
  });
});

describe("buildDraftPublishPayload", () => {
  const item = {
    adSketchId: "1874514740509986",
    adSnapId: "1874514790077570",
    creatives: [{ creativeSketchId: "1874514740510002", creativeSnapId: "1874514790079554" }],
  };

  it("uses the draft publish source, not the fresh-creation one", () => {
    const payload = buildDraftPublishPayload({
      campaignId: "1874278019329169", items: [item], initialStatus: "disabled",
    });
    expect(payload).toMatchObject({
      campaign_id: "1874278019329169",
      campaign_snap_id: "",
      campaign_sketch_id: "",
      coming_source_type: 6,
      sketch_publish_source: 2,
      is_partial_publish: false,
      is_status_disabled: true,
    });
  });

  it("carries snap and sketch ids on both layers", () => {
    const payload = buildDraftPublishPayload({
      campaignId: "c", items: [item], initialStatus: "enabled",
    });
    expect(payload.ad_and_creative_snap_info_list).toEqual([{
      ad_id: "",
      ad_snap_id: "1874514790077570",
      ad_sketch_id: "1874514740509986",
      need_publish: true,
      creative_snap_info_list: [{
        creative_id: "",
        creative_snap_id: "1874514790079554",
        creative_sketch_id: "1874514740510002",
        need_publish: true,
      }],
    }]);
    expect(payload.is_status_disabled).toBe(false);
  });

  it("passes the session risk info through", () => {
    const payload = buildDraftPublishPayload({
      campaignId: "c", items: [item], initialStatus: "disabled", riskInfo: { foo: "bar" },
    });
    expect(payload.risk_info).toEqual({ foo: "bar" });
  });

  it("refuses to publish an incomplete draft", () => {
    expect(() => buildDraftPublishPayload({ campaignId: "c", items: [], initialStatus: "disabled" }))
      .toThrow(/没有可发布/);
    expect(() => buildDraftPublishPayload({
      campaignId: "c", initialStatus: "disabled",
      items: [{ ...item, adSnapId: "" }],
    })).toThrow(/snap\/sketch/);
    expect(() => buildDraftPublishPayload({
      campaignId: "c", initialStatus: "disabled",
      items: [{ ...item, creatives: [] }],
    })).toThrow(/没有可发布的创意/);
    expect(() => buildDraftPublishPayload({
      campaignId: "c", initialStatus: "disabled",
      items: [{ ...item, creatives: [{ creativeSketchId: "c1", creativeSnapId: "" }] }],
    })).toThrow(/创意缺少/);
  });
});
