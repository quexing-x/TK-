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
    namingTemplate: z.string().trim().min(1).max(300),
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
    namingTemplate: "{source_name}-{account_name}-{date}",
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

