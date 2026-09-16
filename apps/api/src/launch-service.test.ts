import { describe, expect, it } from "vitest";
import type { DraftSketchEntry, LaunchPlanItemRecord } from "@tk-auto/core";
import { classifyUncertainLaunchItems, resolveExistingCampaignIdByName } from "./launch-service.js";

/**
 * 跑完后的收尾核对：把「结果未知」拆成已建成 / 只剩草稿 / 还看不出来。
 *
 * 2026-09-16 实测：一个账户 10 条 unknown 里 7 条其实是「创建被明确拒绝、但此前发过
 * 创建请求」，它们永远不会自愈，只在后台留一个草稿，而界面上跟「等回读确认」长得一样。
 */
describe("classifyUncertainLaunchItems", () => {
  const item = (itemId: string, adGroupName: string) => ({
    itemId,
    launchRow: { adGroupName },
  }) as unknown as LaunchPlanItemRecord;
  const draft = (adSketchId: string, adSketchName: string): DraftSketchEntry => ({
    adSketchId,
    adSketchName,
    campaignId: "",
    campaignSketchId: "sketch-1",
    touchedAt: null,
  });

  it("正式广告组已经出现的判成功，并带出它的系列 ID", () => {
    const result = classifyUncertainLaunchItems(
      [item("i-1", "0917-DM002451吸塵器-CZX-0600")],
      [{ name: "0917-DM002451吸塵器-CZX-0600", campaignId: "camp-9" }],
      [],
      new Map(),
    );
    expect(result.confirmed).toEqual([
      { itemId: "i-1", name: "0917-DM002451吸塵器-CZX-0600", campaignId: "camp-9" },
    ]);
    expect(result.toClear).toEqual([]);
    expect(result.pending).toBe(0);
  });

  it("只剩草稿的交出草稿 ID 去清理", () => {
    const name = "0917-DM001019疏通劑-CZX-0600";
    const result = classifyUncertainLaunchItems(
      [item("i-2", name)],
      [],
      [name],
      new Map([[name, draft("sketch-2", name)]]),
    );
    expect(result.toClear).toEqual([{ itemId: "i-2", name, sketchId: "sketch-2" }]);
    expect(result.confirmed).toEqual([]);
  });

  // 草稿优先于正式对象：同名正式组只能说明「重试过、有一次成功了」，不能说明这一条收口。
  it("正式对象和草稿同时存在时按只剩草稿处理", () => {
    const name = "0917-FY12934眼影棒-CZX-0600";
    const result = classifyUncertainLaunchItems(
      [item("i-3", name)],
      [{ name, campaignId: "camp-1" }],
      [name],
      new Map([[name, draft("sketch-3", name)]]),
    );
    expect(result.toClear.map((entry) => entry.itemId)).toEqual(["i-3"]);
    expect(result.confirmed).toEqual([]);
  });

  // 两边都查不到：可能只是账户快照还没同步到。不下结论，绝不清理任何东西。
  it("正式对象和草稿都没有时不下结论", () => {
    const result = classifyUncertainLaunchItems(
      [item("i-4", "0917-DM002999五彈褲-CZX-0600")],
      [],
      [],
      new Map(),
    );
    expect(result.pending).toBe(1);
    expect(result.toClear).toEqual([]);
    expect(result.confirmed).toEqual([]);
  });

  // 判成 draft-only 却拿不到草稿 ID 就删不掉，而没删掉的草稿绝不能标成可重试——
  // 重试会撞上自己的残留。
  it("草稿名对上但拿不到草稿 ID 时归入待定，不进清理队列", () => {
    const name = "0917-HW00004手機支架-CZX-0600";
    const result = classifyUncertainLaunchItems(
      [item("i-5", name)],
      [],
      [name],
      new Map(),
    );
    expect(result.pending).toBe(1);
    expect(result.toClear).toEqual([]);
  });
});

/**
 * 同名系列自动复用：账户里已经有同名系列时，只往里面加广告组，不再新建系列。
 *
 * 此前只在同一批次内按系列名复用，跨批次遇到线上已存在的同名系列仍会去新建，被
 * TikTok 判重名拒绝——2026-08-08 凌晨那批就是先建了 單劑花香染，再想加第四个广告组
 * 时撞上自己。
 */
describe("resolveExistingCampaignIdByName", () => {
  const managed = [
    { entityType: "campaign", externalId: "1872880766292081", name: "單劑花香染" },
    { entityType: "campaign", externalId: "1872880958482017", name: "八寶茶" },
    { entityType: "ad-group", externalId: "1872880766294097", name: "單劑花香染" },
  ];

  it("命中同名系列时返回它的 ID，供发布走「只加广告组」", () => {
    expect(resolveExistingCampaignIdByName(managed, "單劑花香染")).toBe("1872880766292081");
  });

  it("没有同名系列时返回 undefined，照旧新建", () => {
    expect(resolveExistingCampaignIdByName(managed, "單劑花香染4")).toBeUndefined();
  });

  // 广告组和系列可以同名，取错层级会把广告组 ID 当成系列 ID 发出去。
  it("只认系列，同名的广告组不算数", () => {
    expect(resolveExistingCampaignIdByName(
      [{ entityType: "ad-group", externalId: "adgroup-1", name: "只有广告组同名" }],
      "只有广告组同名",
    )).toBeUndefined();
  });

  it("名称两侧空白不影响匹配", () => {
    expect(resolveExistingCampaignIdByName(managed, "  單劑花香染  ")).toBe("1872880766292081");
  });

  // TikTok 允许账户内存在多个同名系列，而终态核验按系列名精确匹配；这时候随便挑一个
  // 往里塞广告组，等于把广告发到不确定的地方去。
  it("账户内有多个同名系列时明确报错，不猜", () => {
    expect(() => resolveExistingCampaignIdByName([
      { entityType: "campaign", externalId: "camp-1", name: "撞名" },
      { entityType: "campaign", externalId: "camp-2", name: "撞名" },
    ], "撞名")).toThrow(/2 个名为“撞名”的推广系列/);
  });

  it("系列名为空时不复用任何系列", () => {
    expect(resolveExistingCampaignIdByName(managed, "   ")).toBeUndefined();
  });
});
