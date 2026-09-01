import { z } from "zod";

const PlaceholderTemplateSchema = z.string().trim().min(1).max(4000);

export const AutomationFeatureSettingsInputSchema = z.object({
  appeal: z.object({
    enabled: z.boolean(),
    textTemplate: PlaceholderTemplateSchema,
    retryLimit: z.number().int().min(0).max(3),
    scheduleHours: z.array(z.number().int().min(0).max(23)).min(1).max(6)
      .default([1, 12]),
  }),
  copy: z.object({
    // 命名不再可配置：系列复制、扩组、自动复制统一用
    // {清洗后源名}-{投放日期}-{时间}，靠时间戳保证唯一。旧配置里残留的
    // namingTemplate 会被 zod 直接丢弃，不需要迁移。
    startPaused: z.boolean(),
    copyBudget: z.boolean(),
    // 独立账户广告组自动复制：命中规则时在同账户/同系列自动复制 N 个广告组。
    // 新增字段带默认值以兼容旧配置。
    autoCopyEnabled: z.boolean().default(false),
    autoCopyTriggerRuleCode: z.string().trim().max(64).default(""),
    autoCopyMinConversions: z.number().int().min(0).default(1),
    autoCopyMaxCpa: z.number().min(0).default(9),
    autoCopyMaxCpc: z.number().min(0).default(0.8),
    autoCopyCount: z.number().int().min(1).max(10).default(2),
    autoCopyBudget: z.number().min(0).nullable().default(null),
    autoCopyBid: z.number().min(0).nullable().default(null),
    autoCopyDailyAccountLimit: z.number().int().min(1).max(100).default(20),
    autoCopyCutoffHour: z.number().int().min(0).max(23).default(12),
    autoCopyLaunchImmediately: z.boolean().default(true),
    autoCopySameCampaign: z.boolean().default(true),
  }),
  // 跑得好的广告组自动提额：转化量达标且 CPA 够低时，把日预算改成设定值。
  //
  // **只作用于日预算恰好等于 sourceBudget 的广告组**（默认 50）。这一条同时也是幂等
  // 机制：调完预算就不再等于 50，下一轮自然不再命中，不需要额外的「已处理」台账。
  budgetBump: z.object({
    enabled: z.boolean().default(false),
    minConversions: z.number().int().min(1).max(1000).default(3),
    maxCpa: z.number().min(0).default(9),
    /** 命中后把日预算改成这个值。 */
    targetBudget: z.number().min(0.01).max(100000).default(100),
    /** 只处理当前日预算等于这个值的广告组。 */
    sourceBudget: z.number().min(0.01).max(100000).default(50),
  }).default({
    enabled: false,
    minConversions: 3,
    maxCpa: 9,
    targetBudget: 100,
    sourceBudget: 50,
  }),
  // 每早定点回看前一自然日：转化达标就把关着的对象开回来。
  //
  // 它**不进规则链**。规则链是 48 小时滚动窗口、每轮轮询即时评估、命中第一条就 break；
  // 这条用的是自然日口径且一天只该生效一次，塞进链里既会被反复评估，又会占位置让后面
  // 的规则 break 不到。所以按 deletion / copy 那样做成独立的每日执行器。
  dailyEnable: z.object({
    enabled: z.boolean().default(false),
    minConversions: z.number().int().min(1).max(1000).default(5),
    scheduleHour: z.number().int().min(0).max(23).default(6),
  }).default({ enabled: false, minConversions: 5, scheduleHour: 6 }),
  /**
   * 关掉「跑不出来又已经停跑」的系列。
   *
   * 判据复用扩组分类（classifyCampaignsForExpand）：判为需重扩、且系列下已经没有在投
   * 的广告组。组被规则一个个关光之后系列一分钱也花不出去，留着只是占列表。
   *
   * 同样不进规则链：规则链是单实体 + 当日指标 + 单阈值，而这条要「自创建以来累计」
   * 加「跨实体的组状态」，表达不了。按 deletion / dailyEnable 做成每日执行器。
   */
  closeStalledCampaigns: z.object({
    enabled: z.boolean().default(false),
    scheduleHour: z.number().int().min(0).max(23).default(6),
    /** 单转上限，与扩组分类同一口径。 */
    maxCostPerConversion: z.number().min(0).default(12),
    /** 零转化时容忍的累计花费上限。 */
    maxSpendWithoutConversion: z.number().min(0).default(3),
    /** 每账户每天最多关几条，防止判据出错时一次关光整个账户。 */
    dailyLimit: z.number().int().min(1).max(500).default(50),
  }).default({
    enabled: false,
    scheduleHour: 6,
    maxCostPerConversion: 12,
    maxSpendWithoutConversion: 3,
    dailyLimit: 50,
  }),
  deletion: z.object({
    enabled: z.boolean().default(false),
    onlyDisabled: z.boolean(),
    gracePeriodHours: z.number().int().min(1).max(720),
    maxConversions: z.number().int().min(0).default(0),
    maxCarts: z.number().int().min(0).default(4),
    minCpa: z.number().min(0).default(9),
    scheduleHour: z.number().int().min(0).max(23).default(6),
    retainOnePerCampaign: z.boolean().default(true),
  }),
});
export type AutomationFeatureSettingsInput = z.infer<
  typeof AutomationFeatureSettingsInputSchema
>;

export const AutomationFeatureSettingsSchema =
  AutomationFeatureSettingsInputSchema.extend({
    updatedAt: z.string().datetime(),
  });
export type AutomationFeatureSettings = z.infer<
  typeof AutomationFeatureSettingsSchema
>;

export const defaultAutomationFeatureSettings: AutomationFeatureSettingsInput = {
  appeal: {
    enabled: true,
    textTemplate: "我认为我的视频没有违规。",
    retryLimit: 0,
    scheduleHours: [1, 12],
  },
  copy: {
    startPaused: true,
    copyBudget: false,
    autoCopyEnabled: false,
    autoCopyTriggerRuleCode: "",
    autoCopyMinConversions: 1,
    autoCopyMaxCpa: 9,
    autoCopyMaxCpc: 0.8,
    autoCopyCount: 2,
    autoCopyBudget: null,
    autoCopyBid: null,
    autoCopyDailyAccountLimit: 20,
    autoCopyCutoffHour: 12,
    autoCopyLaunchImmediately: true,
    autoCopySameCampaign: true,
  },
  budgetBump: {
    enabled: false,
    minConversions: 3,
    maxCpa: 9,
    targetBudget: 100,
    sourceBudget: 50,
  },
  dailyEnable: {
    enabled: false,
    minConversions: 5,
    scheduleHour: 6,
  },
  closeStalledCampaigns: {
    enabled: false,
    scheduleHour: 6,
    maxCostPerConversion: 12,
    maxSpendWithoutConversion: 3,
    dailyLimit: 50,
  },
  deletion: {
    enabled: false,
    onlyDisabled: true,
    gracePeriodHours: 24,
    maxConversions: 0,
    maxCarts: 4,
    minCpa: 9,
    scheduleHour: 6,
    retainOnePerCampaign: true,
  },
};

