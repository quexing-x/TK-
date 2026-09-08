import { z } from "zod";

/*
 * 只剩 TikTok。枚举保留单成员形式而不是塌成字符串常量：存量数据库里仍有
 * platform / provider_kind 列和历史迁移，保留 schema 让读取路径继续走同一套校验。
 */
export const PlatformKindSchema = z.enum(["tiktok"]);
export type PlatformKind = z.infer<typeof PlatformKindSchema>;

export const ProviderKindSchema = z.enum([
  "cookie",
  "official-api",
]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export function platformForProvider(_providerKind: ProviderKind): PlatformKind {
  return "tiktok";
}

export function providerBelongsToPlatform(
  platform: PlatformKind,
  providerKind: ProviderKind,
): boolean {
  return platformForProvider(providerKind) === platform;
}

export const AccountTypeSchema = z.enum(["standard", "agency", "shop"]);
export type AccountType = z.infer<typeof AccountTypeSchema>;

const AccountConfigBaseSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().trim().min(1).max(80),
  platform: PlatformKindSchema,
  accountType: AccountTypeSchema,
  enabled: z.boolean(),
  providerKind: ProviderKindSchema,
  credentialRef: z.string().trim().min(1).nullable(),
  timezone: z.string().trim().min(1),
  pollingIntervalMinutes: z.number().int().min(1).max(1440),
  maxActionsPerRun: z.number().int().min(1).max(100),
  updatedAt: z.string().datetime(),
});

function validatePlatformProviderPair(
  input: { platform: PlatformKind; providerKind: ProviderKind; enabled: boolean },
  context: z.RefinementCtx,
): void {
  if (!providerBelongsToPlatform(input.platform, input.providerKind)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["providerKind"],
      message: "接入方式与广告平台不匹配。",
    });
  }
}

export const AccountConfigSchema = AccountConfigBaseSchema.superRefine(
  validatePlatformProviderPair,
);

export type AccountConfig = z.infer<typeof AccountConfigSchema>;

export const AccountSettingsUpdateSchema = AccountConfigBaseSchema.pick({
  displayName: true,
  accountType: true,
  enabled: true,
  providerKind: true,
});

export type AccountSettingsUpdate = z.infer<typeof AccountSettingsUpdateSchema>;

export const AccountCreateInputSchema = z.object({
  displayName: AccountConfigBaseSchema.shape.displayName,
  platform: PlatformKindSchema.optional(),
  accountType: AccountTypeSchema,
  enabled: z.boolean(),
  providerKind: ProviderKindSchema,
}).superRefine((input, context) => {
  const platform = input.platform ?? platformForProvider(input.providerKind);
  validatePlatformProviderPair({ ...input, platform }, context);
});
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

export const ProviderWriteCircuitSchema = z.object({
  accountId: z.string().min(1),
  providerKind: ProviderKindSchema,
  consecutiveFailures: z.number().int().min(0),
  lastError: z.string().nullable(),
  openedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});
export type ProviderWriteCircuit = z.infer<typeof ProviderWriteCircuitSchema>;
