import { describe, expect, it } from "vitest";
import { selectDeletionCandidates } from "./cleanup.js";
import type { ManagedEntitySnapshot } from "./decision.js";

const settings = { maxConversions: 0, maxCarts: 4, minCpa: 9 };

function adGroup(
  externalId: string,
  overrides: {
    campaign?: string;
    status?: ManagedEntitySnapshot["status"];
    conversions?: number | null;
    carts?: number | null;
    cpa?: number | null;
    spend?: number | null;
    createdAt?: string | null;
  } = {},
): ManagedEntitySnapshot {
  return {
    entityType: "ad-group",
    externalId,
    name: externalId,
    status: overrides.status ?? "disabled",
    parentCampaignId: overrides.campaign ?? "c1",
    parentAdGroupId: null,
    createdAt: overrides.createdAt ?? "2026-08-01T00:00:00.000Z",
    metrics: {
      budget: null,
      spend: overrides.spend ?? 0,
      conversions: overrides.conversions === undefined ? 0 : overrides.conversions,
      clicks: 0,
      carts: overrides.carts === undefined ? 0 : overrides.carts,
      impressions: null,
      cost_per_conversion: overrides.cpa ?? null,
      cost_per_click: null,
    },
  } as unknown as ManagedEntitySnapshot;
}

const ids = (entities: ManagedEntitySnapshot[]) => entities.map((entity) => entity.externalId);

describe("待清理广告组的挑选", () => {
  // 把一个系列删空等于让它彻底停投，而删除的本意只是清理表现差的组。
  it("每个系列至少留一个组", () => {
    const ready = [adGroup("g1"), adGroup("g2"), adGroup("g3")];
    const current = [adGroup("g1"), adGroup("g2"), adGroup("g3")];

    expect(selectDeletionCandidates({ readyAdGroups: ready, currentAdGroups: current, settings }))
      .toHaveLength(2);
  });

  it("系列里只剩一个组时一个都不删", () => {
    const only = [adGroup("g1")];

    expect(selectDeletionCandidates({ readyAdGroups: only, currentAdGroups: only, settings }))
      .toEqual([]);
  });

  // 拿不到数就不知道它表现如何，删了没法回头。
  it("指标缺失的一律不删", () => {
    const ready = [
      adGroup("no-conv", { conversions: null }),
      adGroup("no-cart", { carts: null }),
      adGroup("ok"),
      adGroup("ok2"),
    ];

    expect(ids(selectDeletionCandidates({
      readyAdGroups: ready,
      currentAdGroups: ready,
      settings,
    }))).toEqual(["ok", "ok2"]);
  });

  it("还开着的不删，哪怕指标够差", () => {
    const ready = [adGroup("running", { status: "enabled" }), adGroup("g2"), adGroup("g3")];

    expect(ids(selectDeletionCandidates({
      readyAdGroups: ready,
      currentAdGroups: ready,
      settings,
    }))).not.toContain("running");
  });

  // 有转化的组只在 CPA 也差到超过下限时才删；CPA 缺失同样按「不确定就不删」处理。
  it("有转化时要 CPA 也超标才删，CPA 缺失不删", () => {
    const relaxed = { maxConversions: 2, maxCarts: 4, minCpa: 9 };
    const ready = [
      adGroup("cheap", { conversions: 1, cpa: 3 }),      // CPA 没超，不该删
      adGroup("unknown-cpa", { conversions: 1, cpa: null }), // 不确定，不该删
      adGroup("expensive", { conversions: 1, cpa: 20 }),  // 转化贵，该删
      adGroup("zero", { conversions: 0 }),                // 零转化不看 CPA
    ];

    expect(ids(selectDeletionCandidates({
      readyAdGroups: ready,
      currentAdGroups: ready,
      settings: relaxed,
    })).sort()).toEqual(["expensive", "zero"]);
  });

  it("超过阈值的不删", () => {
    const ready = [
      adGroup("too-many-carts", { carts: 5 }),
      adGroup("ok"),
      adGroup("ok2"),
    ];

    expect(ids(selectDeletionCandidates({
      readyAdGroups: ready,
      currentAdGroups: ready,
      settings,
    }))).toEqual(["ok", "ok2"]);
  });

  it("按系列各自算保留名额，不跨系列借", () => {
    const ready = [
      adGroup("a1", { campaign: "A" }), adGroup("a2", { campaign: "A" }),
      adGroup("b1", { campaign: "B" }),
    ];

    // A 有 2 个组，可删 1 个；B 只有 1 个，一个都不能删。
    expect(ids(selectDeletionCandidates({
      readyAdGroups: ready,
      currentAdGroups: ready,
      settings,
    }))).toEqual(["a1"]);
  });

  // 预览列表和真正执行必须删掉同一批，所以排序必须是确定的——同样的输入、不同的
  // 入参顺序，结果也要一致。
  it("排序确定：输入顺序不影响挑中的是哪一批", () => {
    const build = () => [
      adGroup("late", { carts: 3, createdAt: "2026-08-05T00:00:00.000Z" }),
      adGroup("worst", { carts: 0, createdAt: "2026-08-02T00:00:00.000Z" }),
      adGroup("middle", { carts: 1, createdAt: "2026-08-03T00:00:00.000Z" }),
    ];
    const forward = build();
    const reversed = [...build()].reverse();

    const a = ids(selectDeletionCandidates({
      readyAdGroups: forward, currentAdGroups: forward, settings,
    }));
    const b = ids(selectDeletionCandidates({
      readyAdGroups: reversed, currentAdGroups: reversed, settings,
    }));

    expect(a).toEqual(b);
    expect(a).toEqual(["worst", "middle"]); // 加购少的先删，留下加购最多的那个
  });
});
