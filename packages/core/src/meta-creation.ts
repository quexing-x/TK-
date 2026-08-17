import { z } from "zod";

const MetaCreationNameSchema = z.string().trim().min(1).max(400);
const MetaNumericIdSchema = z.string().trim().regex(/^\d+$/, "Meta ID 必须是数字");
const MetaImageHashSchema = z.string().trim().regex(/^[a-fA-F0-9]{32,128}$/, "图片 Hash 格式不正确");
const MetaHttpsUrlSchema = z.string().trim().url().max(2_048).refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "落地页必须是 HTTPS URL");

export const MetaCreationModeSchema = z.enum(["disabled", "paused-only"]);
export type MetaCreationMode = z.infer<typeof MetaCreationModeSchema>;

export const MetaCreationTargetLevelSchema = z.enum(["ad-set", "ad"]);
export type MetaCreationTargetLevel = z.infer<typeof MetaCreationTargetLevelSchema>;

export const MetaCallToActionSchema = z.enum([
  "LEARN_MORE",
  "SHOP_NOW",
  "SIGN_UP",
  "CONTACT_US",
  "APPLY_NOW",
  "BOOK_NOW",
  "GET_OFFER",
  "NO_BUTTON",
]);
export type MetaCallToAction = z.infer<typeof MetaCallToActionSchema>;

/**
 * First production Meta creation slice: website traffic ads only.
 * Broader objectives need objective-specific promoted_object / pixel / app
 * contracts and must not be accepted by this schema until implemented.
 */
const MetaAdCreationBaseInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  campaignName: MetaCreationNameSchema,
  adSetName: MetaCreationNameSchema,
  objective: z.literal("OUTCOME_TRAFFIC").default("OUTCOME_TRAFFIC"),
  optimizationGoal: z.enum(["LINK_CLICKS", "LANDING_PAGE_VIEWS"]).default("LINK_CLICKS"),
  billingEvent: z.literal("IMPRESSIONS").default("IMPRESSIONS"),
  destinationType: z.literal("WEBSITE").default("WEBSITE"),
  dailyBudgetMinorUnits: z.number().int().min(100).max(100_000_000),
  countries: z.array(z.string().trim().regex(/^[A-Z]{2}$/)).min(1).max(25),
});

const MetaAdCreationTerminalInputSchema = z.object({
  creativeName: MetaCreationNameSchema,
  adName: MetaCreationNameSchema,
  destinationUrl: MetaHttpsUrlSchema,
  primaryText: z.string().trim().min(1).max(500),
  headline: z.string().trim().min(1).max(255),
  description: z.string().trim().max(255).default(""),
  callToAction: MetaCallToActionSchema.default("LEARN_MORE"),
  imageHash: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? null : value,
    z.union([MetaImageHashSchema, z.null()]),
  ).default(null),
});

const MetaAdSetOnlyForbiddenTerminalFieldsSchema = z.object({
  creativeName: z.never().optional(),
  adName: z.never().optional(),
  destinationUrl: z.never().optional(),
  primaryText: z.never().optional(),
  headline: z.never().optional(),
  description: z.never().optional(),
  callToAction: z.never().optional(),
  imageHash: z.never().optional(),
});

const MetaAdCreationInputPayloadSchema = z.discriminatedUnion("targetLevel", [
  MetaAdCreationBaseInputSchema
    .merge(MetaAdSetOnlyForbiddenTerminalFieldsSchema)
    .extend({ targetLevel: z.literal("ad-set") }),
  MetaAdCreationBaseInputSchema
    .merge(MetaAdCreationTerminalInputSchema)
    .extend({ targetLevel: z.literal("ad") }),
]);

export const MetaAdCreationInputSchema = z.preprocess((value) => {
  if (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && !("targetLevel" in value)
  ) {
    return { ...value, targetLevel: "ad" };
  }
  return value;
}, MetaAdCreationInputPayloadSchema);
export type MetaAdCreationInput = z.infer<typeof MetaAdCreationInputSchema>;

export const MetaCreationTaskStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "unknown",
]);
export type MetaCreationTaskStatus = z.infer<typeof MetaCreationTaskStatusSchema>;

export const MetaCreationPhaseSchema = z.enum([
  "pending",
  "campaign",
  "ad-set",
  "creative",
  "ad",
  "completed",
]);
export type MetaCreationPhase = z.infer<typeof MetaCreationPhaseSchema>;

export const MetaCreationTaskRecordSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().min(1),
  input: MetaAdCreationInputSchema,
  status: MetaCreationTaskStatusSchema,
  phase: MetaCreationPhaseSchema,
  campaignId: MetaNumericIdSchema.nullable(),
  adSetId: MetaNumericIdSchema.nullable(),
  creativeId: MetaNumericIdSchema.nullable(),
  adId: MetaNumericIdSchema.nullable(),
  message: z.string().nullable(),
  attemptCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MetaCreationTaskRecord = z.infer<typeof MetaCreationTaskRecordSchema>;

export const MetaCreationProgressSchema = z.object({
  phase: MetaCreationPhaseSchema,
  campaignId: MetaNumericIdSchema.optional(),
  adSetId: MetaNumericIdSchema.optional(),
  creativeId: MetaNumericIdSchema.optional(),
  adId: MetaNumericIdSchema.optional(),
  message: z.string().min(1),
});
export type MetaCreationProgress = z.infer<typeof MetaCreationProgressSchema>;
