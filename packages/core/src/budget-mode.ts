import { z } from "zod";

/**
 * 预算模式。TikTok 在系列层和广告组层各有一个 `budget_mode`，两者互斥：
 * 谁持有预算，谁的 `budget_mode` 就是 `3`（日预算），另一层为 `-1`（无预算）。
 *
 * - `ad-group` 组预算：系列不设预算，每个广告组各自持有日预算。
 * - `campaign` 系列预算(CBO)：系列持有日预算并在组间自动分配，广告组不能设预算。
 */
export const LaunchBudgetModeSchema = z.enum(["ad-group", "campaign"]);
export type LaunchBudgetMode = z.infer<typeof LaunchBudgetModeSchema>;

/** TikTok `budget_mode`：3 = 日预算，-1 = 该层不持有预算。 */
export const TIKTOK_BUDGET_MODE_DAILY = 3;
export const TIKTOK_BUDGET_MODE_NONE = -1;

export interface TikTokBudgetAutoAdjust {
  is_enabled: number;
  initial_budget: string;
  strategy: number;
  increase_percentage?: number;
  max_increase_times?: number;
  auto_reset_next_day?: boolean;
}

export interface ResolvedBudgetFields {
  campaign: {
    budget_mode: number;
    budget: string;
    budget_optimize_switch: number;
    budget_auto_adjust: TikTokBudgetAutoAdjust;
  };
  adGroup: {
    budget_mode: number;
    budget: string;
    budget_auto_adjust: TikTokBudgetAutoAdjust;
  };
}

/**
 * 系列预算金额：真机 `campaign_snap/save` 发的是两位小数字符串（`"88.00"`）。
 * 复制响应回读时可能是 `"88"`，回写前必须归一化，否则回读校验会误判为不一致。
 */
export function formatCampaignBudgetAmount(value: number): string {
  return value.toFixed(2);
}

/**
 * 广告组预算金额：沿用现网已验证的朴素字符串形式。HAR 里两次抓包的广告组都处于
 * 系列预算模式（组预算为空串），没有 ABO 组预算的真机样本，因此这里不改格式。
 */
export function formatAdGroupBudgetAmount(value: number): string {
  return String(value);
}

const inactiveAutoAdjust: TikTokBudgetAutoAdjust = {
  is_enabled: 0,
  initial_budget: "0",
  strategy: 0,
  increase_percentage: 20,
  max_increase_times: 10,
  auto_reset_next_day: false,
};

/**
 * 自动提预算块。它整块归属于【持有预算的那一层】：ABO 挂在广告组上，CBO 挂在
 * 系列上，并且 CBO 的 `auto_reset_next_day` 为 true（与 ABO 的 false 相反）。
 * 这两点在真机报文中确认过，漏掉不会报错，只会让投放行为与手工创建不一致。
 */
function activeAutoAdjust(autoResetNextDay: boolean): TikTokBudgetAutoAdjust {
  return {
    is_enabled: 2,
    initial_budget: "0",
    strategy: 1,
    increase_percentage: 20,
    max_increase_times: 10,
    auto_reset_next_day: autoResetNextDay,
  };
}

export class BudgetModeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetModeInputError";
  }
}

export interface ResolveBudgetFieldsInput {
  budgetMode: LaunchBudgetMode;
  /** 系列日预算；仅 `campaign` 模式使用。 */
  campaignBudget?: number | null;
  /** 广告组日预算；仅 `ad-group` 模式使用。 */
  adGroupBudget?: number | null;
  /**
   * 智能+ (Smart+) 系列。非智能+ 时 TikTok 不下发自动提预算块，两层都发关闭态。
   */
  smartPlus: boolean;
}

/**
 * 把「谁持有预算」这一个业务决策，翻译成 TikTok 两层表单上的四组字段。
 * 所有预算相关的魔数只在本函数内出现，调用方不需要知道 3 / -1 的含义。
 */
export function resolveBudgetFields(
  input: ResolveBudgetFieldsInput,
): ResolvedBudgetFields {
  const campaignHoldsBudget = input.budgetMode === "campaign";
  if (campaignHoldsBudget) {
    const amount = input.campaignBudget ?? null;
    if (amount === null || !Number.isFinite(amount) || amount <= 0) {
      throw new BudgetModeInputError(
        "系列预算模式必须填写大于 0 的系列日预算。若这是升级前保存的旧预设（系列预算方式填了非 -1 的数字），请在预设里补填系列日预算，或把预算模式切回广告组预算。",
      );
    }
    return {
      campaign: {
        budget_mode: TIKTOK_BUDGET_MODE_DAILY,
        budget: formatCampaignBudgetAmount(amount),
        budget_optimize_switch: 1,
        budget_auto_adjust: input.smartPlus
          ? activeAutoAdjust(true)
          : { is_enabled: 0, initial_budget: "0", strategy: 0 },
      },
      adGroup: {
        budget_mode: TIKTOK_BUDGET_MODE_NONE,
        budget: "",
        budget_auto_adjust: inactiveAutoAdjust,
      },
    };
  }
  const amount = input.adGroupBudget ?? null;
  if (amount === null || !Number.isFinite(amount) || amount <= 0) {
    throw new BudgetModeInputError("广告组预算模式必须填写大于 0 的广告组日预算。");
  }
  return {
    campaign: {
      budget_mode: TIKTOK_BUDGET_MODE_NONE,
      budget: "",
      budget_optimize_switch: 0,
      budget_auto_adjust: { is_enabled: 0, initial_budget: "0", strategy: 0 },
    },
    adGroup: {
      budget_mode: TIKTOK_BUDGET_MODE_DAILY,
      budget: formatAdGroupBudgetAmount(amount),
      budget_auto_adjust: input.smartPlus
        ? activeAutoAdjust(false)
        : { is_enabled: 0, initial_budget: "0", strategy: 0 },
    },
  };
}

/**
 * 从已同步的系列快照反推预算模式，供复制/迁移复用源系列的模式。
 */
export function budgetModeOfCampaign(
  campaignBudgetOptimized: boolean,
): LaunchBudgetMode {
  return campaignBudgetOptimized ? "campaign" : "ad-group";
}
