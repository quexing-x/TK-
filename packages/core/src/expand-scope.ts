import { RULE_LOOKBACK_HOURS } from "./rules.js";

/** 扩组面板的时间范围口径。 */
export type ExpandScope = "spending-today" | "created-recently" | "polling-range";

export interface ExpandScopeEntity {
  createdAt?: string | null | undefined;
  /** 当天累计消耗。 */
  spend?: number | null | undefined;
  /** 自动化自己关停、尚未被自动开回——引擎的持久管辖集。 */
  automationManaged?: boolean | undefined;
}

/**
 * 这个广告组该不该出现在所选范围里。
 *
 * 三个口径**故意不是同一个基准**，因为选源组时人问的本来就是三个不同的问题：
 *
 * - `spending-today`：今天在投的。选扩组源看的是「它现在跑得怎么样」，不是它哪天建的。
 *   原先「今天」按创建时间判，于是一个前天建、今天正在花钱的组根本不出现——实测某账户
 *   当天有消耗的 8 个组里，7 个是更早建的，全被挡在外面。
 * - `created-recently`：最近 48 小时新建的。找刚建的组时用。
 * - `polling-range`：自动化引擎真正在评估的那批，判据与 filterEntitiesToRecentWindow
 *   逐条对齐（见下）。看得到的就是规则管得着的。
 */
export function withinExpandScope(
  entity: ExpandScopeEntity,
  scope: ExpandScope,
  now: number,
): boolean {
  const spend = entity.spend ?? null;
  const spendingToday = spend !== null && spend > 0;
  if (scope === "spending-today") return spendingToday;

  const createdAt = entity.createdAt ? new Date(entity.createdAt).getTime() : null;
  const createdRecently = createdAt !== null
    && Number.isFinite(createdAt)
    && createdAt >= now - RULE_LOOKBACK_HOURS * 60 * 60 * 1000
    // 未来时间戳按不合法处理，留 5 分钟容忍时钟偏差，与引擎一致。
    && createdAt <= now + 5 * 60 * 1000;
  if (scope === "created-recently") return createdRecently;

  // 引擎的存活判据是三条**并列**的路：48 小时内建的、当天有消耗的、在持久管辖集里的。
  // 后两条缺一不可——只看创建时间会把老而在投的组漏掉；只看消耗则会把「自动化关停后
  // 当天零消耗、等着被转化回传开回来」的组漏掉，而那正是开启规则要够着的对象。
  return createdRecently || spendingToday || entity.automationManaged === true;
}
