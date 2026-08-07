import { describe, expect, it } from "vitest";
import { resolveExistingCampaignIdByName } from "./launch-service.js";

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
