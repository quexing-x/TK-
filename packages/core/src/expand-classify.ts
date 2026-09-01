import type { EntityOperationalStatus } from "./decision.js";

/**
 * 扩组判定：一条系列今天该照常扩组，还是该停下来复制一条新系列重跑。
 *
 * 判定单位是**系列**，逐条独立判——同一个品下的多条系列各判各的，一条超标不牵连其它。
 * 品名归并（同品不同名的系列）刻意不在这里做，交给人工排除：靠名字猜品会把
 * `DM003142八寶人蔘枸杞茶` / `八寶人蔘枸杞茶` / `八寶茶` 拆成三个品，猜错的代价比不猜大。
 *
 * 指标口径是**自系列创建以来累计**，必须由 listEntityRangeMetrics 提供，不能拿实体上的
 * 当前 metrics 顶替：provider 每轮只拉当天（withTodayMetricWindow），实体上挂的是「今天到
 * 现在为止」的累计值，早上跑的时候几乎恒为 0。
 */

/** 一条系列的累计表现，字段来自 listEntityRangeMetrics。 */
export interface ExpandCampaignInput {
  externalId: string;
  name: string;
  status: EntityOperationalStatus;
  /** 自创建以来累计花费。 */
  spend: number;
  /** 自创建以来累计转化数。 */
  conversions: number;
  /** 累计值覆盖了几个自然日，用于在界面上提示样本厚薄。 */
  days?: number | null;
  /**
   * 这条系列下还有没有在投的广告组。
   *
   * 组被自动化规则一个个关光之后，系列就再也花不出钱了——继续等它「花够 3 块」
   * 永远等不到，那条零转化的观察期判据在这种系列上是死循环。
   */
  hasActiveAdGroups?: boolean;
}

export interface ExpandThresholds {
  /** 单转上限，超过就不再在这条系列上扩组。 */
  maxCostPerConversion: number;
  /** 零转化时容忍的累计花费上限，超过即判定这条系列跑不出来。 */
  maxSpendWithoutConversion: number;
}

export const DEFAULT_EXPAND_THRESHOLDS: ExpandThresholds = {
  maxCostPerConversion: 12,
  maxSpendWithoutConversion: 3,
};

export type ExpandVerdict =
  /** 照常扩组。 */
  | "expand"
  /** 今天别扩这条，复制一条新系列重跑。 */
  | "recreate-campaign"
  /** 不参与判定。 */
  | "excluded";

export type ExpandReason =
  /** 有转化且单转达标。 */
  | "cost-per-conversion-ok"
  /** 零转化，但累计花费还没到上限，继续观察。 */
  | "observing"
  /** 有转化但单转超标。 */
  | "cost-per-conversion-high"
  /** 零转化且累计花费已超上限。 */
  | "no-conversion-overspent"
  /** 零转化，且组已被规则关光——这条系列不会再有新数据了。 */
  | "no-conversion-stalled"
  /** 已关停，不该再往上扩。 */
  | "not-enabled"
  /** 诊断/占位系列，不是投放对象。 */
  | "non-operational";

export interface ExpandClassification {
  externalId: string;
  name: string;
  verdict: ExpandVerdict;
  reason: ExpandReason;
  spend: number;
  conversions: number;
  /**
   * 零转化时是 null，不用 0 或 Infinity 顶替——那两个值参与排序和展示时都会骗人：
   * 0 会排到「最优」，Infinity 在 JSON 里根本序列化不出来。
   */
  costPerConversion: number | null;
  days: number | null;
  /**
   * 这条系列下还有没有在投的广告组。null 表示调用方没提供该信息。
   *
   * 「关掉需重扩的系列」只对 false 的那批动手：组还在跑就说明系列还在产生数据，
   * 这时关掉系列会连带掐掉正在投放的组。
   */
  hasActiveAdGroups: boolean | null;
}

/**
 * 诊断系列、空名、以及名为 `0` 的脏行不参与判定。
 *
 * 这三类实测都在账户里出现过：`诊断0823E-选25到34` 这类是定向测试留下的，
 * 名为 `0` 的是同步落下的脏数据。它们混进「可扩」列表会被当成正经品扩量。
 */
export function isNonOperationalCampaignName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (trimmed === "0") return true;
  return trimmed.startsWith("诊断");
}

/** 单转。零转化时返回 null，调用方不要拿它做除法兜底。 */
export function costPerConversionOf(spend: number, conversions: number): number | null {
  if (!Number.isFinite(spend) || !Number.isFinite(conversions)) return null;
  if (conversions <= 0) return null;
  return spend / conversions;
}

export function classifyCampaignForExpand(
  campaign: ExpandCampaignInput,
  thresholds: ExpandThresholds = DEFAULT_EXPAND_THRESHOLDS,
): ExpandClassification {
  const days = campaign.days ?? null;
  const spend = Number.isFinite(campaign.spend) ? campaign.spend : 0;
  const conversions = Number.isFinite(campaign.conversions) ? campaign.conversions : 0;
  const costPerConversion = costPerConversionOf(spend, conversions);
  const base = {
    externalId: campaign.externalId,
    name: campaign.name,
    spend,
    conversions,
    costPerConversion,
    days,
    hasActiveAdGroups: campaign.hasActiveAdGroups ?? null,
  };

  if (isNonOperationalCampaignName(campaign.name)) {
    return { ...base, verdict: "excluded", reason: "non-operational" };
  }
  // 已关停的系列不该再往上扩组，也不该因为历史成绩差就被判「重扩」——它已经停了，
  // 没有动作可做。
  if (campaign.status !== "enabled") {
    return { ...base, verdict: "excluded", reason: "not-enabled" };
  }

  if (costPerConversion !== null) {
    return costPerConversion <= thresholds.maxCostPerConversion
      ? { ...base, verdict: "expand", reason: "cost-per-conversion-ok" }
      : { ...base, verdict: "recreate-campaign", reason: "cost-per-conversion-high" };
  }

  // 零转化、组已被规则关光、且**确实花过钱**：直接判重扩，不再看消耗。
  //
  // 观察期的前提是「再花一点就能看出结果」。组全关了之后系列一分钱也花不出去，
  // 消耗永远停在当前值，那条 spend > 3 的线就再也跨不过去——系列会永久卡在
  // 「观察中」，既不会被扩、也不会被判重扩，等于从名单里静默消失。
  //
  // spend > 0 这个前提不能省：建好还没投的系列同样「无在投组」，但它不是跑不出来，
  // 只是还没开始。实测账户里有 4 条这种系列（如「八寶茶」「隨身wifi」），少了这个
  // 判据会被判成需重扩、进而被一键关掉。
  if (campaign.hasActiveAdGroups === false && spend > 0) {
    return { ...base, verdict: "recreate-campaign", reason: "no-conversion-stalled" };
  }

  // 零转化：花得还少就继续观察，花超了才判这条跑不出来。用 > 而不是 >=，
  // 阈值本身仍属于观察期。
  return spend > thresholds.maxSpendWithoutConversion
    ? { ...base, verdict: "recreate-campaign", reason: "no-conversion-overspent" }
    : { ...base, verdict: "expand", reason: "observing" };
}

export interface ExpandClassificationBuckets {
  /** 照常扩组。 */
  expand: ExpandClassification[];
  /** 今天别扩，复制新系列重跑。 */
  recreateCampaign: ExpandClassification[];
  /** 已关停 / 诊断脏数据。 */
  excluded: ExpandClassification[];
}

/**
 * 批量判定并分桶。
 *
 * 两个可扩桶各自按「最该先看的」排序：可扩桶把单转低的排前面（零转化的观察期排最后，
 * 它们还没有成绩可言）；重扩桶把亏得最多的排前面。
 */
export function classifyCampaignsForExpand(
  campaigns: readonly ExpandCampaignInput[],
  thresholds: ExpandThresholds = DEFAULT_EXPAND_THRESHOLDS,
): ExpandClassificationBuckets {
  const buckets: ExpandClassificationBuckets = {
    expand: [],
    recreateCampaign: [],
    excluded: [],
  };
  for (const campaign of campaigns) {
    const result = classifyCampaignForExpand(campaign, thresholds);
    if (result.verdict === "expand") buckets.expand.push(result);
    else if (result.verdict === "recreate-campaign") buckets.recreateCampaign.push(result);
    else buckets.excluded.push(result);
  }

  buckets.expand.sort((left, right) => {
    // 有成绩的排在观察期前面：单转已经达标是比「还没花够钱」更强的扩量依据。
    if (left.costPerConversion === null && right.costPerConversion === null) {
      return right.spend - left.spend;
    }
    if (left.costPerConversion === null) return 1;
    if (right.costPerConversion === null) return -1;
    return left.costPerConversion - right.costPerConversion;
  });
  buckets.recreateCampaign.sort((left, right) => right.spend - left.spend);
  return buckets;
}
