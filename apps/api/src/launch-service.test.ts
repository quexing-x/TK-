import { describe, expect, it } from "vitest";
import { UnknownCreationStateError } from "@tk-auto/providers";
import { ExpandDeadlineExceededError, resolveExistingCampaignIdByName, withExpandDeadline } from "./launch-service.js";

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

/**
 * 扩组的端到端超时。
 *
 * Provider 内部每一跳都有超时，但整条链没有天花板。2026-08-23 生产上出现过一次：
 * dispatch 标记写完 0.17 秒之后那一行再没有任何写入，而进程活得好好的（同期
 * sync_runs 一直在跑）。没有这道闸，幂等行就永远停在 running + uncertain=1。
 */
describe("withExpandDeadline", () => {
  it("正常返回时原样放行，不引入额外等待", async () => {
    await expect(withExpandDeadline(Promise.resolve("done"), 50)).resolves.toBe("done");
  });

  it("底下自己抛错时把原始错误透出去，不被超时掩盖", async () => {
    const cause = new Error("provider 明确拒绝");
    await expect(withExpandDeadline(Promise.reject(cause), 50)).rejects.toBe(cause);
  });

  it("永远不返回时到点唤醒调用方，让它能落库、能回话", async () => {
    await expect(withExpandDeadline(new Promise<never>(() => {}), 10))
      .rejects.toBeInstanceOf(ExpandDeadlineExceededError);
  });

  /**
   * 这条是整个改动的安全底线。超时只证明我们没等到回音，不证明 TikTok 没建组——
   * 判成 failed 会让 finishAdGroupExpandTask 删掉幂等行、放开重试，同一批组被建
   * 第二遍。继承 UnknownCreationStateError 就是为了让上层的 unknown 分支自动接住。
   */
  it("超时按「结果未知」归类，绝不能被当成可重试的失败", async () => {
    const cause = await withExpandDeadline(new Promise<never>(() => {}), 10).catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(UnknownCreationStateError);
  });

  it("输给超时的那条 promise 之后抛错也不会变成 unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let rejectLate: (cause: unknown) => void = () => {};
      const late = new Promise<never>((_resolve, reject) => { rejectLate = reject; });
      await expect(withExpandDeadline(late, 10)).rejects.toBeInstanceOf(ExpandDeadlineExceededError);
      rejectLate(new Error("迟到的传输层失败"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
