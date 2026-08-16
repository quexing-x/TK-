import { z } from "zod";
import { ProviderKindSchema } from "./account.js";

export const ProviderCapabilitySchema = z.enum([
  "read-campaigns",
  "read-ad-groups",
  "read-ads",
  "read-reports",
  "create-campaigns",
  "copy-ads",
  "copy-campaigns",
  "change-status",
  "delete-ad-groups",
  "appeal-ads",
]);
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;

export const ProviderAuthorizationStatusSchema = z.enum([
  "not-authorized",
  "active",
  "expired",
  "revoked",
  "failed",
]);
export type ProviderAuthorizationStatus = z.infer<
  typeof ProviderAuthorizationStatusSchema
>;

export const ProviderCapabilityStateSchema = z.object({
  capability: ProviderCapabilitySchema,
  available: z.boolean(),
  reason: z.string().min(1),
});
export type ProviderCapabilityState = z.infer<
  typeof ProviderCapabilityStateSchema
>;

export const AccountProviderCapabilitiesSchema = z.object({
  accountId: z.string().min(1),
  providerKind: ProviderKindSchema,
  providerDisplayName: z.string().min(1),
  capabilityVersion: z.string().min(1),
  authorizationStatus: ProviderAuthorizationStatusSchema,
  authorizedAt: z.string().datetime().nullable(),
  authorizationExpiresAt: z.string().datetime().nullable(),
  capabilities: z.array(ProviderCapabilityStateSchema),
});
export type AccountProviderCapabilities = z.infer<
  typeof AccountProviderCapabilitiesSchema
>;

const TikTokHttpsUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        (url.hostname === "tiktok.com" ||
          url.hostname.endsWith(".tiktok.com"))
      );
    } catch {
      return false;
    }
  }, "只允许使用 TikTok 官方 HTTPS 域名");

const OptionalTikTokUrlSchema = z.union([
  TikTokHttpsUrlSchema,
  z.literal(""),
]);

export const CookieConnectionSettingsSchema = z.object({
  kind: z.literal("cookie"),
  advertiserId: z.string().trim().min(1).max(64),
  healthUrl: OptionalTikTokUrlSchema,
  campaignsUrl: OptionalTikTokUrlSchema,
  adGroupsUrl: OptionalTikTokUrlSchema,
  adsUrl: OptionalTikTokUrlSchema,
});
export type CookieConnectionSettings = z.infer<
  typeof CookieConnectionSettingsSchema
>;

export const OfficialApiConnectionSettingsSchema = z.object({
  kind: z.literal("official-api"),
  advertiserId: z.string().trim().min(1).max(64),
});
export type OfficialApiConnectionSettings = z.infer<
  typeof OfficialApiConnectionSettingsSchema
>;

export const MetaOfflineConnectionSettingsSchema = z.object({
  kind: z.literal("meta-offline"),
  businessId: z.string().trim().max(64).default(""),
  adAccountId: z.string().trim().max(64).default(""),
});
export type MetaOfflineConnectionSettings = z.infer<
  typeof MetaOfflineConnectionSettingsSchema
>;

const MetaNumericIdSchema = z.string().trim().regex(/^\d+$/, "必须是数字 ID").max(64);
const MetaAdAccountIdSchema = z.string().trim()
  .regex(/^(?:act_)?\d+$/, "广告账户 ID 必须是数字或 act_数字")
  .max(68);
const MetaAccessProfileIdSchema = z.string().trim().uuid("共享凭据 Profile ID 必须是 UUID");
const MetaNullablePageIdSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? null : value,
  z.union([MetaNumericIdSchema, z.null()]),
);

export const MetaMarketingApiLiveModeSchema = z.enum([
  "disabled",
  "read-only",
  "manual-status",
  "automation-status",
]);
export type MetaMarketingApiLiveMode = z.infer<
  typeof MetaMarketingApiLiveModeSchema
>;

export const MetaStatusEntityTypeSchema = z.enum([
  "campaign",
  "ad-group",
  "ad",
]);
export type MetaStatusEntityType = z.infer<typeof MetaStatusEntityTypeSchema>;

const MetaMarketingApiLivePolicyFields = {
  kind: z.literal("meta-marketing-api"),
  /** Missing on legacy records is interpreted as disabled by the provider. */
  liveMode: MetaMarketingApiLiveModeSchema.optional(),
  allowedStatusEntityTypes: z.array(MetaStatusEntityTypeSchema)
    .max(3)
    .refine((items) => new Set(items).size === items.length, "启停对象层级不能重复")
    .optional(),
} as const;

const MetaMarketingApiCurrentConnectionSettingsSchema = z.object({
  ...MetaMarketingApiLivePolicyFields,
  profileId: MetaAccessProfileIdSchema,
  adAccountId: z.string().trim()
    .regex(/^act_\d+$/, "广告账户 ID 必须是 act_数字")
    .max(68),
  pageId: MetaNullablePageIdSchema,
});

const MetaMarketingApiLegacyConnectionSettingsSchema = z.object({
  ...MetaMarketingApiLivePolicyFields,
  adAccountId: MetaAdAccountIdSchema,
  pageId: MetaNumericIdSchema,
  appId: MetaNumericIdSchema,
  businessId: MetaNumericIdSchema,
  graphApiVersion: z.string().trim()
    .regex(/^v\d+\.\d+$/, "Graph API 版本格式应为 v数字.数字")
    .max(16),
});

export const MetaMarketingApiConnectionSettingsSchema = z.union([
  MetaMarketingApiCurrentConnectionSettingsSchema,
  MetaMarketingApiLegacyConnectionSettingsSchema,
]).transform((settings) => ({
  kind: settings.kind,
  ...("profileId" in settings ? { profileId: settings.profileId } : {}),
  adAccountId: settings.adAccountId.startsWith("act_")
    ? settings.adAccountId
    : `act_${settings.adAccountId}`,
  pageId: settings.pageId,
  ...(settings.liveMode ? { liveMode: settings.liveMode } : {}),
  ...(settings.allowedStatusEntityTypes
    ? { allowedStatusEntityTypes: settings.allowedStatusEntityTypes }
    : {}),
}));
export type MetaMarketingApiConnectionSettings = z.infer<
  typeof MetaMarketingApiConnectionSettingsSchema
>;

export const ProviderConnectionSettingsSchema = z.union([
  CookieConnectionSettingsSchema,
  OfficialApiConnectionSettingsSchema,
  MetaOfflineConnectionSettingsSchema,
  MetaMarketingApiConnectionSettingsSchema,
]);

export type ProviderConnectionSettings = z.infer<
  typeof ProviderConnectionSettingsSchema
>;

export const CapturedCookieRequestSchema = z.object({
  target: z.enum([
    "health",
    "campaign",
    "ad-group",
    "ad",
    "campaign-status",
    "ad-group-status",
    "ad-status",
    "appeal",
    // 素材层：读用 expand/material/list，写用 procedural_material/update_status。
    // 两者都从会话请求派生，不需要用户单独导入 cURL。
    "material",
    "material-status",
  ]),
  action: z.enum(["enable", "disable"]).optional(),
  url: TikTokHttpsUrlSchema,
  method: z.enum(["GET", "POST"]),
  body: z.string().max(262_144).optional(),
  contentType: z.string().trim().max(256).optional(),
  headers: z.record(z.string(), z.string().max(8192)).optional(),
  derived: z.boolean().optional(),
});

export type CapturedCookieRequest = z.infer<
  typeof CapturedCookieRequestSchema
>;

/** Account-local, verified creation snapshots. They stay encrypted alongside
 * the Cookie and never appear in plans, presets or source control. */
export const CookieCreationProfileSchema = z.object({
  version: z.literal(1),
  campaignPayload: z.record(z.unknown()),
  adGroupPayload: z.record(z.unknown()),
  creativePayload: z.record(z.unknown()),
  publishPayload: z.record(z.unknown()),
  verifiedAt: z.string().datetime().nullable().default(null),
});
export type CookieCreationProfile = z.infer<typeof CookieCreationProfileSchema>;

export const CookieCredentialInputSchema = z.object({
  kind: z.literal("cookie"),
  cookie: z.string().trim().min(10),
  csrfToken: z.string().trim().max(4096).optional(),
  csrfHeaderName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]+$/)
    .default("x-csrftoken"),
  userAgent: z.string().trim().max(1024).optional(),
  requestTemplates: z.array(CapturedCookieRequestSchema).max(12).optional(),
  creationProfile: CookieCreationProfileSchema.optional(),
});

export const OfficialApiCredentialInputSchema = z.object({
  kind: z.literal("official-api"),
  accessToken: z.string().trim().min(10),
});

export const MetaOfflineCredentialInputSchema = z.object({
  kind: z.literal("meta-offline"),
});

export const ProviderCredentialInputSchema = z.discriminatedUnion("kind", [
  CookieCredentialInputSchema,
  OfficialApiCredentialInputSchema,
  MetaOfflineCredentialInputSchema,
]);

export type ProviderCredentialInput = z.infer<
  typeof ProviderCredentialInputSchema
>;

export const ConnectionStatusSchema = z.enum([
  "not-configured",
  "untested",
  "ready",
  "failed",
]);

export const ProviderConnectionSchema = z.object({
  accountId: z.string().min(1),
  kind: ProviderKindSchema,
  settings: ProviderConnectionSettingsSchema,
  hasCredential: z.boolean(),
  status: ConnectionStatusSchema,
  authorizationStatus: ProviderAuthorizationStatusSchema.default("not-authorized"),
  capabilityVersion: z.string().min(1).default("legacy-unversioned"),
  authorizedCapabilities: z.array(ProviderCapabilitySchema).default([]),
  authorizedAt: z.string().datetime().nullable().default(null),
  authorizationExpiresAt: z.string().datetime().nullable().default(null),
  lastMessage: z.string().nullable(),
  lastTestedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;

export const SyncEntityTypeSchema = z.enum([
  "campaign",
  "ad-group",
  "ad",
  // 程序化创意下一个广告内含多条素材，投放实际是按素材粒度停开的。广告层保留
  // 不动（自动申诉仍按 creative_id 走），素材单独成层。
  "material",
]);
export type SyncEntityType = z.infer<typeof SyncEntityTypeSchema>;

export interface ProviderEntity {
  entityType: SyncEntityType;
  externalId: string;
  payload: Record<string, unknown>;
}

export type SyncDataQualityStatus = "healthy" | "partial" | "stale" | "invalid";

export interface SyncDataCoverage {
  startDate: string;
  endDate: string;
  timezone: string;
}

export interface SyncDataQuality {
  status: SyncDataQualityStatus;
  paginationComplete: boolean;
  requiredMetricsComplete: boolean;
  contractValid: boolean;
  providerContractVersion: string;
  coverage: SyncDataCoverage;
  missingMetrics: string[];
  partialFailures: string[];
  /**
   * 本轮素材列表没有取到的所属广告 ID。
   *
   * 素材列表是按广告逐个请求的，所以一次 partial 同步仍可能有一批素材完整可用。
   * 记录到广告粒度，自动启停才能只隔离失败对象，不把整账户一起降级。
   */
  materialUnavailableAdIds?: string[];
  /** Most recent fully healthy sync, enriched by storage when available. */
  lastHealthyAt: string | null;
  /**
   * 本轮真正取全、且通过契约与分页校验的层级。
   *
   * 一层拉不到不代表其余层不可信：广告层的派生请求在 TikTok 侧慢且不稳，而同一轮
   * 里广告组层往往几秒就取全了。删除、自动复制都是广告组层面的操作，不该被广告层
   * 的失败连坐。
   *
   * 历史记录没有这个字段（undefined），syncLayerComplete 会把这种情况按旧语义处理。
   */
  completeEntityTypes?: SyncEntityType[];
}

/**
 * 某一层数据本轮是否可信。
 *
 * - healthy：全部层级都取全了。
 * - invalid：契约漂移是全局问题，任何层都不可信。
 * - partial：只认 completeEntityTypes 里列出的层级。
 * - 老记录缺少 completeEntityTypes 时退回旧语义（只有 healthy 才算数），保证升级
 *   前写下的 partial 记录不会被追认为可用。
 */
export function syncLayerComplete(
  quality: SyncDataQuality | undefined | null,
  entityType: SyncEntityType,
): boolean {
  if (!quality) return false;
  if (quality.status === "invalid") return false;
  if (quality.status === "healthy") return true;
  return quality.completeEntityTypes?.includes(entityType) === true;
}

export interface ReadOnlySyncResult {
  startedAt: string;
  finishedAt: string;
  counts: Record<SyncEntityType, number>;
  warnings: string[];
  quality: SyncDataQuality;
}
