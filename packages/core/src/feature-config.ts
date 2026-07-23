import { z } from "zod";

const PlaceholderTemplateSchema = z.string().trim().min(1).max(4000);

export const AutomationFeatureSettingsInputSchema = z.object({
  appeal: z.object({
    enabled: z.boolean(),
    textTemplate: PlaceholderTemplateSchema,
    retryLimit: z.number().int().min(0).max(3),
  }),
  copy: z.object({
    namingTemplate: z.string().trim().min(1).max(300),
    startPaused: z.boolean(),
    copyBudget: z.boolean(),
    // 独立账户广告组自动复制：命中规则时在同账户/同系列自动复制 N 个广告组。
    // 新增字段带默认值以兼容旧配置。
    autoCopyEnabled: z.boolean().default(false),
    autoCopyTriggerRuleCode: z.string().trim().max(64).default(""),
    autoCopyCount: z.number().int().min(1).max(10).default(1),
    autoCopyBudget: z.number().min(0).nullable().default(null),
    autoCopyBid: z.number().min(0).nullable().default(null),
    autoCopyLaunchImmediately: z.boolean().default(true),
    autoCopySameCampaign: z.boolean().default(true),
  }),
  deletion: z.object({
    onlyDisabled: z.boolean(),
    gracePeriodHours: z.number().int().min(1).max(720),
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
  },
  copy: {
    namingTemplate: "{source_name}-{account_name}-{date}",
    startPaused: true,
    copyBudget: false,
    autoCopyEnabled: false,
    autoCopyTriggerRuleCode: "",
    autoCopyCount: 1,
    autoCopyBudget: null,
    autoCopyBid: null,
    autoCopyLaunchImmediately: true,
    autoCopySameCampaign: true,
  },
  deletion: {
    onlyDisabled: true,
    gracePeriodHours: 24,
  },
};

