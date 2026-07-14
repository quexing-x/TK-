import { z } from "zod";

export const ProviderKindSchema = z.enum(["cookie", "official-api"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ExecutionModeSchema = z.enum([
  "observe",
  "manual-approval",
  "automatic",
]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export const AccountTypeSchema = z.enum(["standard", "agency", "shop"]);
export type AccountType = z.infer<typeof AccountTypeSchema>;

export const AccountConfigSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().trim().min(1).max(80),
  accountType: AccountTypeSchema,
  enabled: z.boolean(),
  providerKind: ProviderKindSchema,
  credentialRef: z.string().trim().min(1).nullable(),
  timezone: z.string().trim().min(1),
  pollingIntervalMinutes: z.number().int().min(1).max(1440),
  maxActionsPerRun: z.number().int().min(1).max(100),
  executionMode: ExecutionModeSchema,
  updatedAt: z.string().datetime(),
});

export type AccountConfig = z.infer<typeof AccountConfigSchema>;

export const AccountSettingsUpdateSchema = AccountConfigSchema.pick({
  displayName: true,
  accountType: true,
  enabled: true,
  providerKind: true,
});

export type AccountSettingsUpdate = z.infer<typeof AccountSettingsUpdateSchema>;

export const AccountCreateInputSchema = AccountSettingsUpdateSchema;
export type AccountCreateInput = z.infer<typeof AccountCreateInputSchema>;

export const GlobalAutomationSettingsSchema = z.object({
  pollingIntervalMinutes: z.number().int().min(1).max(1440),
  maxActionsPerRun: z.number().int().min(1).max(100),
  updatedAt: z.string().datetime(),
});
export type GlobalAutomationSettings = z.infer<
  typeof GlobalAutomationSettingsSchema
>;

export const GlobalAutomationSettingsInputSchema =
  GlobalAutomationSettingsSchema.omit({ updatedAt: true });
export type GlobalAutomationSettingsInput = z.infer<
  typeof GlobalAutomationSettingsInputSchema
>;
