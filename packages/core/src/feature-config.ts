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
  },
  deletion: {
    onlyDisabled: true,
    gracePeriodHours: 24,
  },
};

