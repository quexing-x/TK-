import { describe, expect, it } from "vitest";
import {
  buildDraftPublishPayload,
  buildDraftSketchListPayload,
  matchDraftSketchesByName,
  parseDraftCreativeOwners,
  parseDraftSketchList,
  parseSketchSnapMapping,
  type DraftSketchEntry,
} from "./publish-draft.js";

const sketch = (name: string, id: string, campaignId = "1874278019329169"): DraftSketchEntry => ({
  adSketchId: id,
  adSketchName: name,
  campaignId,
  campaignSketchId: "",
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
    }]);
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
