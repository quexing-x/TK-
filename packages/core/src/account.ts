import { z } from "zod";

export const ProviderKindSchema = z.enum(["cookie", "official-api"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ExecutionModeSchema = z.enum([
  "observe",
  "manual-approval",
  "automatic",
]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const AccountConfigSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  providerKind: ProviderKindSchema,
  credentialRef: z.string().trim().min(1).nullable(),
  timezone: z.string().trim().min(1),
  pollingIntervalMinutes: z.number().int().min(1).max(1440),
  executionMode: ExecutionModeSchema,
  updatedAt: z.string().datetime(),
});

export type AccountConfig = z.infer<typeof AccountConfigSchema>;

export const AccountSettingsUpdateSchema = AccountConfigSchema.pick({
  displayName: true,
  enabled: true,
  providerKind: true,
  timezone: true,
  pollingIntervalMinutes: true,
  executionMode: true,
});

export type AccountSettingsUpdate = z.infer<typeof AccountSettingsUpdateSchema>;

