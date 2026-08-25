import type { ManagedEntitySnapshot } from "./decision.js";

/**
 * 自动删除执行器用到的那部分配置。这里只收判据相关的字段，不牵扯 enabled /
 * scheduleHour 那些「什么时候跑」的开关——候选集合本身跟时机无关。
 */
export interface DeletionCandidateSettings {
  maxConversions: number;
  maxCarts: number;
  minCpa: number;
}

export interface DeletionCandidateInput {
  /** 已过保护期、可考虑删除的广告组快照。 */
  readyAdGroups: readonly ManagedEntitySnapshot[];
  /** 账户当前still存在的广告组，用来算每个系列还剩几个组。 */
  currentAdGroups: readonly Pick<ManagedEntitySnapshot, "entityType" | "parentCampaignId">[];
  settings: DeletionCandidateSettings;
}

/**
 * 删除优先级：转化少的先删，其次加购少的，再次 CPA 高的，最后按创建时间与 ID 定序。
 * 末两级不是为了「更该删」，而是为了**结果稳定**——同样的输入必须给出同样的顺序，
 * 否则预览列表和真正执行时删掉的不是同一批。
 */
export function compareDeletionPriority(
  left: ManagedEntitySnapshot,
  right: ManagedEntitySnapshot,
): number {
  const conversionOrder = (left.metrics.conversions ?? Number.POSITIVE_INFINITY)
    - (right.metrics.conversions ?? Number.POSITIVE_INFINITY);
  if (conversionOrder !== 0) return conversionOrder;
  const cartOrder = (left.metrics.carts ?? Number.POSITIVE_INFINITY)
    - (right.metrics.carts ?? Number.POSITIVE_INFINITY);
  if (cartOrder !== 0) return cartOrder;
  const leftCpa = left.metrics.cost_per_conversion ?? Number.POSITIVE_INFINITY;
  const rightCpa = right.metrics.cost_per_conversion ?? Number.POSITIVE_INFINITY;
  if (leftCpa !== rightCpa) return rightCpa - leftCpa;
  const createdOrder = new Date(left.createdAt ?? 0).getTime()
    - new Date(right.createdAt ?? 0).getTime();
  return createdOrder || left.externalId.localeCompare(right.externalId);
}

/**
 * 挑出这一刻该删的广告组。
 *
 * **界面上的「待清理」列表和定时执行器必须共用这个函数**：判据一旦各写一份就会漂移，
 * 而这里漂移的后果是「列表里看到的」和「真正被删掉的」不是同一批——删除不可恢复，
 * 这种不一致没有补救余地。
 *
 * 每个系列至少留一个组：把一个系列删空等于让它彻底停投，而删除的本意只是清理表现差的
 * 组。留几个由账户当前实际存在的组数决定，不看历史。
 */
export function selectDeletionCandidates(
  input: DeletionCandidateInput,
): ManagedEntitySnapshot[] {
  const { readyAdGroups, currentAdGroups, settings } = input;

  const currentCountByCampaign = new Map<string, number>();
  for (const entity of currentAdGroups) {
    if (entity.entityType !== "ad-group" || !entity.parentCampaignId) continue;
    currentCountByCampaign.set(
      entity.parentCampaignId,
      (currentCountByCampaign.get(entity.parentCampaignId) ?? 0) + 1,
    );
  }

  const byCampaign = new Map<string, ManagedEntitySnapshot[]>();
  for (const entity of readyAdGroups) {
    const conversions = entity.metrics.conversions;
    const carts = entity.metrics.carts;
    if (
      entity.status !== "disabled"
      || !entity.parentCampaignId
      // 指标缺失时一律不删：拿不到数就不知道它表现如何，删了没法回头。
      || conversions === null
      || carts === null
      || conversions > settings.maxConversions
      || carts > settings.maxCarts
      // 有转化的组只在 CPA 也差到超过下限时才删；CPA 缺失同样按「不确定就不删」处理。
      || (conversions > 0
        && (entity.metrics.cost_per_conversion === null
          || entity.metrics.cost_per_conversion < settings.minCpa))
    ) continue;
    const list = byCampaign.get(entity.parentCampaignId) ?? [];
    list.push(entity);
    byCampaign.set(entity.parentCampaignId, list);
  }

  return [...byCampaign.entries()].flatMap(([campaignId, entries]) => {
    const maximumDeletions = Math.max(0, (currentCountByCampaign.get(campaignId) ?? 0) - 1);
    return [...entries].sort(compareDeletionPriority).slice(0, maximumDeletions);
  });
}
