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
 *
 * **已知局限：已关停的系列判 `excluded`，等于从名单里消失。**
 * 站在「扫账户、逐条系列判该做什么」的视角这是对的——系列已经停了，对它本身没有动作可做。
 * 但站在「这个品明天该不该有组在跑」的视角就是漏扩：品还在品库里，它的系列全关停了，
 * 恰恰说明明天得给它开一条新的，而这里判 excluded 之后它既不在可扩名单、也不在重扩名单。
 *
 * 这条局限**刻意不在这里修**。修它要把判定单位从「系列」改成「品」，而品的识别（编码、
 * 繁简、别名、一品多组）是模糊判断，写死进这里只会猜错。正确的补法是让 agent 按品库逐行
 * 遍历、用 MCP 把关停系列一并读出来自己判——见 `.claude/skills/tk-expand-sheet`。
 * 客户端自己跑一键扩组时仍会漏这批，靠 agent 定期出表纠偏。
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
  /**
   * 最近连续几个**完整**自然日零转化（从昨天往前数，遇到有转化的那天就断）。
   *
   * 只数完整日：今天是半天，早上跑判定时几乎恒为零转化，把今天算进去等于每天早上
   * 把所有系列都判一遍死刑。
   *
   * 只数**当天确实花过钱**的日子：没花钱的那天零转化是必然的，不构成「不出货」的证据。
   */
  consecutiveZeroConversionDays?: number;
  /**
   * 今天已经从这条系列复制出新系列了。
   *
   * **只是一个标记，不参与任何判定。** 一条系列该不该重扩，取决于它自己跑得怎么样，
   * 跟「今天复制过没有」无关——复制过的源系列照样是跑不出来的那条，「每早关掉跑不出来
   * 又已经停跑的系列」仍然该关它。所以这里只把事实原样带出去，由界面决定要不要在
   * 「建议重扩」名单里把它藏起来（藏起来是对的：名单是行动清单，今天已经做过的不该再
   * 让人做一次）。
   *
   * 把它做成判据会顺手关掉自动关停：那条链路正是靠 `recreate-campaign` 挑出关停对象的。
   */
  recreatedToday?: boolean;
}

export interface ExpandThresholds {
  /** 单转上限，超过就不再在这条系列上扩组。 */
  maxCostPerConversion: number;
  /**
   * 零转化时容忍的累计花费上限。
   *
   * 2026-09-07 口径变更后零转化一律判重扩，这个阈值**不再改变 verdict**，只用来分
   * reason（`observing` / `no-conversion-overspent`），让人一眼看出这条是刚起步还是
   * 已经烧过一笔。
   */
  maxSpendWithoutConversion: number;
  /**
   * 连续多少个自然日零转化就判重扩。
   *
   * 与累计口径互补：累计单转可能被早期的好成绩撑着，但连着几天一个转化都没有，
   * 说明这条系列**现在**已经不出货了。
   */
  maxConsecutiveZeroConversionDays: number;
}

export const DEFAULT_EXPAND_THRESHOLDS: ExpandThresholds = {
  maxCostPerConversion: 12,
  maxSpendWithoutConversion: 3,
  maxConsecutiveZeroConversionDays: 3,
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
  /** 零转化，累计花费还没到上限。2026-09-07 起这也判重扩。 */
  | "observing"
  /** 一分钱都没花过——还没开始跑，不是跑不出来。 */
  | "not-started"
  /** 有转化但单转超标。 */
  | "cost-per-conversion-high"
  /** 零转化且累计花费已超上限。 */
  | "no-conversion-overspent"
  /** 零转化，且组已被规则关光——这条系列不会再有新数据了。 */
  | "no-conversion-stalled"
  /** 连续若干个自然日一个转化都没有——现在已经不出货了。 */
  | "no-conversion-days-exceeded"
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
  /** 最近连续零转化的完整自然日数，供界面解释「为什么判重扩」。 */
  consecutiveZeroConversionDays: number;
  /** 今天已经从这条系列复制出新系列了。原样透传，不影响 verdict。 */
  recreatedToday: boolean;
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

/** 某个完整自然日里，一条系列的表现。按日期倒序（昨天在前）传入。 */
export interface CampaignDailyMetric {
  spend: number;
  conversions: number;
}

/**
 * 从最近的完整自然日往前数，连续几天零转化。
 *
 * 三条规矩，缺一条都会误判：
 * - **只数完整日**：今天是半天，早上跑判定时几乎恒为零转化。调用方负责不要把今天传进来。
 * - **没花钱的那天跳过、且不中断连续性**：那天零转化是必然的，不构成「不出货」的证据；
 *   但也不该因为中间有一天没投就把连续性重置——那样只要隔天投一次就永远数不满。
 * - **遇到有转化的那天立刻停**：连续性从那天断开。
 *
 * 缺数据的日子（数组里没有的天）由调用方决定传不传；传进来的都当作有效观测日。
 */
export function countConsecutiveZeroConversionDays(
  daysNewestFirst: readonly CampaignDailyMetric[],
): number {
  let count = 0;
  for (const day of daysNewestFirst) {
    if (day.conversions > 0) break;
    // 没花钱的日子不算证据，也不算中断。
    if (day.spend <= 0) continue;
    count += 1;
  }
  return count;
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
    consecutiveZeroConversionDays: campaign.consecutiveZeroConversionDays ?? 0,
    recreatedToday: campaign.recreatedToday ?? false,
  };

  if (isNonOperationalCampaignName(campaign.name)) {
    return { ...base, verdict: "excluded", reason: "non-operational" };
  }
  // 已关停的系列不该再往上扩组，也不该因为历史成绩差就被判「重扩」——它已经停了，
  // 没有动作可做。
  if (campaign.status !== "enabled") {
    return { ...base, verdict: "excluded", reason: "not-enabled" };
  }

  // 连续若干天零转化：排在累计单转之前判。
  //
  // 两个口径互补，而近况优先：累计单转会被早期的好成绩撑着——一条前十天出过货、
  // 最近三天颗粒无收的系列，累计单转可能还漂亮，但它**现在**已经不出货了，
  // 继续往上扩组是在给一条死掉的系列加预算。
  const zeroDays = campaign.consecutiveZeroConversionDays ?? 0;
  if (zeroDays >= thresholds.maxConsecutiveZeroConversionDays) {
    return { ...base, verdict: "recreate-campaign", reason: "no-conversion-days-exceeded" };
  }

  if (costPerConversion !== null) {
    return costPerConversion <= thresholds.maxCostPerConversion
      ? { ...base, verdict: "expand", reason: "cost-per-conversion-ok" }
      : { ...base, verdict: "recreate-campaign", reason: "cost-per-conversion-high" };
  }

  // 一分钱都没花过：这条系列不是跑不出来，是还没开始跑。必须在「零转化即重扩」之前
  // 拦下来，且**绝不能判成重扩**。
  //
  // 建好还没投的系列同样「无在投组」，而每早的自动关停正是挑 verdict=recreate-campaign
  // 且 hasActiveAdGroups===false 的那批下手——判错等于把刚建好、还没来得及投的系列
  // 当天关掉。实测账户里有 4 条这种系列（如「八寶茶」「隨身wifi」）。
  if (spend <= 0) {
    return { ...base, verdict: "expand", reason: "not-started" };
  }

  // 零转化、且组已被规则关光：这条系列不会再有新数据了。
  //
  // 组全关了之后系列一分钱也花不出去，消耗永远停在当前值。单独列出来是为了让人知道
  // 它是「被关光的」而不是「还在烧」——两者都判重扩，但前者连关停动作都不用做。
  if (campaign.hasActiveAdGroups === false) {
    return { ...base, verdict: "recreate-campaign", reason: "no-conversion-stalled" };
  }

  // 花过钱、还没出转化，但组还在投：**留在可扩桶，不判重扩**。
  //
  // 2026-09-09 口径统一（投手确认），判重扩只剩两条：单转 > 上限，或「无在投组且无转化」。
  // 组还在投就说明这条系列还有机会，判死刑为时过早。
  //
  // 这是对 2026-09-07 那次「零转化一律重扩」的回退。那次改动的代价当晚就暴露了：
  // 两个纵姿账户在投的 160 条系列里有 140 多条卡在「花了几毛钱、还没出转化」，
  // 全被判成重扩——既让重扩名单虚高，又会让「判重扩即关闭」把刚起步的系列成片关掉。
  //
  // 仍然分两个 reason：花超上限的值得单独看一眼，它比纯观察期更接近该换一条的状态。
  return spend > thresholds.maxSpendWithoutConversion
    ? { ...base, verdict: "expand", reason: "no-conversion-overspent" }
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
