/**
 * TikTok 的广告组列表里，草稿和已发布的对象都在，靠 `ad_status` 区分：
 * 草稿是 `ad_create`，提交审核后变 `ad_audit`，之后才是投放/关停等状态。
 *
 * 实测 2026-08-25 生产快照：1088 个广告组里 `ad_create` 只有 1 个，正是那条只建了草稿
 * 没发布成功的记录，且零消耗。
 */
export const DRAFT_AD_STATUS = "ad_create";

export interface ExpandSnapshotEntity {
  name: string;
  /** 平台原始的 ad_status。 */
  adStatus?: string | null | undefined;
}

export type ExpandReconcileVerdict = "confirmed" | "draft-only" | "not-found";

/**
 * 拿一条「结果未知」的扩组记录去快照里对账。
 *
 * 「结果未知」意味着写请求发出去了但没拿到回音，只能人工去 TikTok 后台核实。可只要下一轮
 * 同步把真实对象拉回来了，机器其实就能替人回答这个问题——**前提是判据不能只看名字在不在**。
 *
 * 名字在不在**不足以**证明建成功：草稿也带名字、也出现在广告组列表里。2026-08-25 那批 4 条
 * 未知记录，4 条的名字在快照里全都找得到，但其中 1 条只是草稿——只按名字判就会把它误判成
 * 成功、把红条清掉，而它恰恰是唯一真正需要人处理的那条。
 *
 * 三种结论分开返回，因为它们的后续动作完全不同：
 * - `confirmed`：确实建成并已提交，可以自动清掉记录
 * - `draft-only`：停在草稿，**必须留着红条**，等人去发布或删除
 * - `not-found`：快照里没有，可能是还没同步到，也可能真的没建成——继续等，不做结论
 */
export function reconcileExpandTask(
  generatedNames: readonly string[],
  snapshot: readonly ExpandSnapshotEntity[],
): ExpandReconcileVerdict {
  const wanted = generatedNames.map((name) => name.trim()).filter(Boolean);
  if (wanted.length === 0) return "not-found";

  const byName = new Map<string, ExpandSnapshotEntity>();
  for (const entity of snapshot) {
    const key = entity.name.trim();
    if (key) byName.set(key, entity);
  }

  const found = wanted.map((name) => byName.get(name));
  // 一条记录可能对应多个组（requestedCount > 1）。只要还有没出现的，就不下结论——
  // 部分建成也是「没建全」，清掉记录等于把剩下那些永久藏起来。
  if (found.some((entity) => entity === undefined)) return "not-found";
  // 只要有一个还停在草稿，整条都不算成功。
  if (found.some((entity) => entity!.adStatus === DRAFT_AD_STATUS)) return "draft-only";
  return "confirmed";
}
