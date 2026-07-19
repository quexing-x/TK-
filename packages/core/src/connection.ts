import { z } from "zod";
import { ProviderKindSchema } from "./account.js";

export const ProviderCapabilitySchema = z.enum([
  "read-campaigns",
  "read-ad-groups",
  "read-ads",
  "read-reports",
  "create-campaigns",
  "copy-ads",
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

export const ProviderConnectionSettingsSchema = z.discriminatedUnion("kind", [
  CookieConnectionSettingsSchema,
  OfficialApiConnectionSettingsSchema,
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

export const ProviderCredentialInputSchema = z.discriminatedUnion("kind", [
  CookieCredentialInputSchema,
  OfficialApiCredentialInputSchema,
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
  /** Most recent fully healthy sync, enriched by storage when available. */
  lastHealthyAt: string | null;
}

export interface ReadOnlySyncResult {
  startedAt: string;
  finishedAt: string;
  counts: Record<SyncEntityType, number>;
  warnings: string[];
  quality: SyncDataQuality;
}
