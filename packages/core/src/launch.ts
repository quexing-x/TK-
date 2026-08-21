import { z } from "zod";
import { WriteTaskActorSchema } from "./write-task.js";
import { LaunchBudgetModeSchema, type LaunchBudgetMode } from "./budget-mode.js";

export const LaunchInitialStatusSchema = z.enum(["enabled", "disabled"]);
export type LaunchInitialStatus = z.infer<typeof LaunchInitialStatusSchema>;

export const LaunchModeSchema = z.enum(["single", "multi", "copy"]);
export type LaunchMode = z.infer<typeof LaunchModeSchema>;

export const LaunchTemplateModeSchema = z.enum(["none", "copy"]);
export type LaunchTemplateMode = z.infer<typeof LaunchTemplateModeSchema>;

export const LaunchGenderSchema = z.enum(["all", "male", "female"]);
export type LaunchGender = z.infer<typeof LaunchGenderSchema>;

export const LaunchAgeRangeValues = [
  "13-17",
  "18-24",
  "25-34",
  "35-44",
  "45-54",
  "55-100",
] as const;
export const LaunchAgeRangeSchema = z.enum(LaunchAgeRangeValues);
export type LaunchAgeRange = z.infer<typeof LaunchAgeRangeSchema>;

export const LaunchPlanItemStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
]);
export type LaunchPlanItemStatus = z.infer<typeof LaunchPlanItemStatusSchema>;

export const LaunchCreationPhaseSchema = z.enum([
  "validation",
  "campaign_draft",
  "adgroup_draft",
  "creative_draft",
  "publishing",
  "readback",
  "sync",
]);
export type LaunchCreationPhase = z.infer<typeof LaunchCreationPhaseSchema>;

export const LaunchCreationEvidenceSchema = z.object({
  resolvedAdGroupName: z.string().min(1).nullable().default(null),
  providerRequestId: z.string().min(1).nullable().default(null),
  campaignSnapId: z.string().min(1).nullable().default(null),
  campaignSketchId: z.string().min(1).nullable().default(null),
  adGroupSnapId: z.string().min(1).nullable().default(null),
  adGroupSketchId: z.string().min(1).nullable().default(null),
  creativeSnapId: z.string().min(1).nullable().default(null),
  creativeSketchId: z.string().min(1).nullable().default(null),
  asyncRequestId: z.string().min(1).nullable().default(null),
});
export type LaunchCreationEvidence = z.infer<typeof LaunchCreationEvidenceSchema>;

export const LaunchCreationProgressSchema = z.object({
  phase: LaunchCreationPhaseSchema,
  evidence: LaunchCreationEvidenceSchema.partial().default({}),
});
export type LaunchCreationProgress = z.infer<typeof LaunchCreationProgressSchema>;

export const LaunchOriginalPostSchema = z.object({
  itemId: z.string().min(1),
  identityId: z.string().min(1),
  identityType: z.number().int(),
  identityBcId: z.string().min(1).nullable().default(null),
  vid: z.string().min(1),
  videoId: z.string().min(1).nullable().default(null),
  displayName: z.string().min(1).nullable().default(null),
  coverUrl: z.string().url().nullable().default(null),
  promotable: z.boolean().default(true),
});
export type LaunchOriginalPost = z.infer<typeof LaunchOriginalPostSchema>;

export const LaunchProductInfoSchema = z.object({
  promo_code_infos: z.array(z.object({
    code: z.string().default(""),
    code_type: z.number().int(),
    value: z.number(),
    currency: z.string().min(1),
    include_type: z.number().int(),
  })).max(50).default([]),
  is_auto_use: z.number().int().default(2),
  auto_select_toggle: z.number().int().default(0),
  image_infos: z.array(z.unknown()).max(50).default([]),
  selling_points_by_types: z.array(z.object({
    text: z.string().min(1),
    material_tag: z.number().int(),
  })).max(100).default([]),
});
export type LaunchProductInfo = z.infer<typeof LaunchProductInfoSchema>;

export const LaunchSourceSnapshotSchema = z.object({
  accountId: z.string().min(1),
  campaignId: z.string().min(1),
  campaignName: z.string().min(1),
  adGroupId: z.string().min(1),
  adGroupName: z.string().min(1),
  posts: z.array(LaunchOriginalPostSchema).min(1).max(500),
  productUrl: z.string().url().nullable(),
  productInfo: LaunchProductInfoSchema.nullable().default(null),
  catalogSetup: z.number().int().min(0).max(1).nullable().default(null),
  structuralHash: z.string().min(1),
  fetchedAt: z.string().datetime(),
});
export type LaunchSourceSnapshot = z.infer<typeof LaunchSourceSnapshotSchema>;

export const LaunchTargetPostMappingSchema = z.object({
  accountId: z.string().min(1),
  sourceAdGroupId: z.string().min(1).nullable().default(null),
  posts: z.array(LaunchOriginalPostSchema).min(1).max(500),
  evidenceHash: z.string().min(1),
  verifiedAt: z.string().datetime(),
});
export type LaunchTargetPostMapping = z.infer<typeof LaunchTargetPostMappingSchema>;

export const LaunchCopyDifferenceSchema = z.object({
  field: z.enum(["campaignName", "adGroupName", "productUrl"]),
  sourceValue: z.string().nullable(),
  targetValue: z.string().nullable(),
});
export type LaunchCopyDifference = z.infer<typeof LaunchCopyDifferenceSchema>;

export const LaunchCopyPreviewItemSchema = z.object({
  accountId: z.string().min(1),
  itemIndex: z.number().int().nonnegative(),
  launchRow: z.lazy(() => LaunchConfigurationRowSchema),
  sourceSnapshot: LaunchSourceSnapshotSchema,
  targetPostMapping: LaunchTargetPostMappingSchema,
  differences: z.array(LaunchCopyDifferenceSchema),
});
export type LaunchCopyPreviewItem = z.infer<typeof LaunchCopyPreviewItemSchema>;

export const LaunchMigrationStartRuleSchema = z.enum(["absolute", "next-six", "tonight"]);
export type LaunchMigrationStartRule = z.infer<typeof LaunchMigrationStartRuleSchema>;

/** Per-account settings frozen by the original-post migration confirmation. */
export const LaunchMigrationTargetConfigSchema = z.object({
  accountId: z.string().trim().min(1),
  quantity: z.number().int().min(1).max(20),
  dailyBudget: z.number().positive().max(100_000_000),
  bid: z.number().nonnegative().max(100_000_000).nullable(),
  // 原帖迁移默认创建后直接投放；旧客户端未传该字段时也按开启处理。
  initialStatus: LaunchInitialStatusSchema.default("enabled"),
  startAtRule: LaunchMigrationStartRuleSchema,
  startAt: z.string().datetime().nullable(),
});
export type LaunchMigrationTargetConfig = z.infer<typeof LaunchMigrationTargetConfigSchema>;

/** Values TikTok needs in addition to each spreadsheet row.  They are saved
 * once in a preset rather than repeatedly typed into the import sheet. */
export const CreationPresetConfigSchema = z.object({
  templateCampaignId: z.string().trim().min(1).max(128).nullable().optional(),
  objectiveType: z.number().int().nullable().default(null),
  buyingType: z.number().int().nullable().default(null),
  /**
   * 预算模式。缺省时按旧配置的 campaignBudgetMode 推导，保证已保存的预设行为不变。
   * 新配置只写这一个字段，两层的 budget_mode 由 resolveBudgetFields 派生。
   */
  budgetMode: LaunchBudgetModeSchema.optional(),
  /** @deprecated 由 budgetMode 派生；仅为读取旧预设保留。 */
  campaignBudgetMode: z.number().int().nullable().default(null),
  /** @deprecated 由 budgetMode 派生；仅为读取旧预设保留。 */
  adBudgetMode: z.number().int().nullable().default(null),
  pricing: z.number().int().nullable().default(null),
  optimizeGoal: z.number().int().nullable().default(null),
  externalAction: z.number().int().nullable().default(null),
  /**
   * User-facing Pixel Code or exact pixel name. The provider resolves this to
   * the target account's numeric ad_ref_pixel_id only after execution starts.
   */
  pixelKey: z.string().trim().max(256).nullable().optional(),
  /** @deprecated Numeric account-internal ID retained for old saved presets. */
  pixelId: z.string().trim().max(256).nullable().default(null),
  identityType: z.number().int().nullable().default(null),
  identityId: z.string().trim().max(256).nullable().default(null),
  callToActionId: z.string().trim().max(256).nullable().default(null),
  countryCodes: z.array(z.number().int()).max(100).default([]),
  placementIds: z.array(z.number().int()).max(100).default([]),
  gender: LaunchGenderSchema.optional(),
  ageRanges: z.array(LaunchAgeRangeSchema).min(1).max(LaunchAgeRangeValues.length)
    .optional(),
  smartTargeting: z.boolean().default(true),
  commentDisabled: z.boolean().default(false),
  shareDisabled: z.boolean().default(false),
  /** Shared authorization-code to TikTok Post mappings. advertiserId is legacy-only. */
  videoPostMappings: z.array(z.object({
    advertiserId: z.string().trim().max(128).optional(),
    videoCode: z.string().trim().min(1).max(512),
    postId: z.string().trim().regex(/^\d+$/).max(128),
  })).max(500).optional(),
});
export type CreationPresetConfig = z.infer<typeof CreationPresetConfigSchema>;
export const defaultCreationPresetConfig: CreationPresetConfig =
  CreationPresetConfigSchema.parse({
    objectiveType: 3,
    buyingType: 1,
    campaignBudgetMode: -1,
    adBudgetMode: 3,
    pricing: 1,
    optimizeGoal: 100,
    externalAction: 96,
    pixelKey: null,
    pixelId: null,
    identityType: 0,
    identityId: null,
    callToActionId: "0",
    countryCodes: [1668284],
    placementIds: [3000],
    gender: "all",
    ageRanges: [...LaunchAgeRangeValues],
  });

/**
 * 解析预设实际使用的预算模式。新配置直接读 `budgetMode`；旧配置没有这个字段，
 * 按 TikTok 的 `campaignBudgetMode`（>0 表示系列持有日预算）反推，保证升级前
 * 保存的预设行为完全不变。
 */
export function resolveConfiguredBudgetMode(
  config: Pick<CreationPresetConfig, "budgetMode" | "campaignBudgetMode"> | undefined,
): LaunchBudgetMode {
  if (config?.budgetMode) return config.budgetMode;
  const legacy = config?.campaignBudgetMode ?? null;
  return legacy !== null && legacy > 0 ? "campaign" : "ad-group";
}

/**
 * 系列预算模式下，同名系列只能有一份系列预算。导入表里同一个系列名的多行如果
 * 填了不同金额，必须在保存计划之前拦下——真机会用最后写入的那份，而用户看到的
 * 是表格里的另一份。
 */
export function assertCampaignBudgetConsistency(
  rows: Array<Pick<LaunchConfigurationRow, "campaignName" | "campaignBudget">>,
  budgetMode: LaunchBudgetMode,
): void {
  if (budgetMode !== "campaign") return;
  const byCampaign = new Map<string, number | null>();
  for (const row of rows) {
    const name = row.campaignName.trim();
    const budget = row.campaignBudget ?? null;
    if (budget === null) {
      throw new Error(`系列预算模式下推广系列“${name}”缺少系列日预算。`);
    }
    const seen = byCampaign.get(name);
    if (seen === undefined) {
      byCampaign.set(name, budget);
      continue;
    }
    if (seen !== budget) {
      throw new Error(
        `推广系列“${name}”在本批次里出现了两个不同的系列日预算（${seen} 与 ${budget}）；系列预算属于整个系列，请统一后重试。`,
      );
    }
  }
}

export const LaunchPresetInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  region: z.string().trim().min(1).max(120),
  /** 广告组日预算。系列预算模式下不下发，但保留取值以便切回组预算。 */
  dailyBudget: z.number().positive().max(100_000_000),
  /** 系列日预算；仅 creationConfig.budgetMode 为 campaign 时使用。 */
  campaignBudget: z.number().positive().max(100_000_000).nullish(),
  bid: z.number().nonnegative().max(100_000_000).nullable(),
  startAt: z.string().datetime().nullable(),
  endAt: z.string().datetime().nullable(),
  // 创建时间规则：absolute 用固定 startAt；tonight/tomorrow-morning 为相对规则，
  // 每次使用预设时按当时时间重算，不冻结日期。
  startAtRule: z.enum(["absolute", "tonight", "tomorrow-morning"]).default("absolute"),
  initialStatus: LaunchInitialStatusSchema,
  creationConfig: CreationPresetConfigSchema.default({}),
});
/** API input may omit advanced creation fields; schema defaults fill them. */
export type LaunchPresetInput = z.input<typeof LaunchPresetInputSchema>;

export const LaunchPresetRecordSchema = LaunchPresetInputSchema.extend({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LaunchPresetRecord = z.infer<typeof LaunchPresetRecordSchema>;

export const LaunchConfigurationRowSchema = z.object({
  rowNumber: z.number().int().min(2),
  campaignName: z.string().trim().min(1).max(512),
  // One ad-group row can hold every video code of a "一组多广告" group joined by
  // ";", so this is NOT a single-code field. Cap it to the worst case the sheet
  // already allows: up to 500 ads (see adCount check) × 512 chars per code.
  // Empty only for original-post migration. Normal creation validates this
  // field before a plan is persisted.
  videoCode: z.string().trim().max(262_144),
  productUrl: z.string().url().max(2_048),
  adGroupName: z.string().trim().min(1).max(512),
  adName: z.string().trim().min(1).max(512),
  // Older locally saved plans did not contain a region.  Preserve their
  // readability while every newly saved plan receives it from its preset.
  region: z.string().trim().min(1).max(120).default("未设置"),
  dailyBudget: z.number().positive().max(100_000_000),
  // 系列日预算。系列预算(CBO)模式下由本字段下发到系列层，广告组层不再发预算。
  // 旧计划没有这个字段，缺省即按组预算处理。同一个系列下的多行必须携带相同的
  // 值，由 assertCampaignBudgetConsistency 在保存计划前校验。
  campaignBudget: z.number().positive().max(100_000_000).nullish(),
  bid: z.number().nonnegative().max(100_000_000).nullable(),
  startAt: z.string().datetime().nullable(),
  endAt: z.string().datetime().nullable(),
  initialStatus: LaunchInitialStatusSchema,
});
export type LaunchConfigurationRow = z.infer<typeof LaunchConfigurationRowSchema>;

export const LaunchCopyPreviewInputSchema = z.object({
  sourceAccountId: z.string().trim().min(1),
  sourceAdGroupId: z.string().trim().min(1).max(128),
  sourceAdGroupIds: z.array(z.string().trim().min(1).max(128)).min(1).max(20).optional(),
  targetAccountIds: z.array(z.string().trim().min(1)).min(1).max(100),
  launchPresetId: z.string().trim().min(1),
  launchRows: z.array(LaunchConfigurationRowSchema).max(500).default([]),
  targetConfigs: z.array(LaunchMigrationTargetConfigSchema).max(100).optional(),
}).superRefine((value, context) => {
  const targetConfigs = value.targetConfigs ?? [];
  if (value.launchRows.length === 0 && targetConfigs.length === 0) {
    context.addIssue({ code: "custom", path: ["targetConfigs"], message: "请配置至少一个目标账户。" });
  }
  if (targetConfigs.reduce((sum, item) => sum + item.quantity, 0) > 100) {
    context.addIssue({ code: "custom", path: ["targetConfigs"], message: "单次迁移最多创建 100 个广告组。" });
  }
});
export type LaunchCopyPreviewInput = z.infer<typeof LaunchCopyPreviewInputSchema>;

export const LaunchCopyPreviewRecordSchema = z.object({
  id: z.string().min(1),
  sourceAccountId: z.string().min(1),
  sourceAdGroupId: z.string().min(1),
  sourceAdGroupIds: z.array(z.string().min(1)).max(20).default([]),
  targetAccountIds: z.array(z.string().min(1)).min(1).max(100),
  targetConfigs: z.array(LaunchMigrationTargetConfigSchema).max(100).default([]),
  launchPresetId: z.string().min(1),
  /** Immutable preset content that the user reviewed.  The final plan must
   * use this snapshot even if the named preset is edited before confirmation. */
  presetSnapshot: LaunchPresetInputSchema,
  presetSnapshotHash: z.string().min(1),
  inputHash: z.string().min(1),
  launchRowsHash: z.string().min(1),
  launchRows: z.array(LaunchConfigurationRowSchema).max(500),
  sourceSnapshot: LaunchSourceSnapshotSchema,
  sourceSnapshots: z.array(LaunchSourceSnapshotSchema).max(20).default([]),
  items: z.array(LaunchCopyPreviewItemSchema).max(100),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  safeToCreate: z.boolean(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type LaunchCopyPreviewRecord = z.infer<typeof LaunchCopyPreviewRecordSchema>;

export const LaunchPlanItemRecordSchema = z.object({
  itemId: z.string().min(1),
  planId: z.string().min(1),
  accountId: z.string().min(1),
  itemIndex: z.number().int().nonnegative(),
  launchRow: LaunchConfigurationRowSchema,
  templateMode: LaunchTemplateModeSchema,
  templateCampaignId: z.string().min(1).nullable(),
  sourceSnapshot: LaunchSourceSnapshotSchema.nullable().default(null),
  targetPostMapping: LaunchTargetPostMappingSchema.nullable().default(null),
  /** Historical video-code copy evidence is kept readable after upgrade, but
   * can never be dispatched through the original-post migration path. */
  legacyCopyUnsupported: z.boolean().default(false),
  idempotencyKey: z.string().min(1).nullable().default(null),
  status: LaunchPlanItemStatusSchema,
  phase: LaunchCreationPhaseSchema,
  operationId: z.string().min(1),
  attemptId: z.string().min(1).nullable(),
  correlationId: z.string().min(1),
  actor: WriteTaskActorSchema,
  evidence: LaunchCreationEvidenceSchema,
  campaignId: z.string().min(1).nullable(),
  adGroupId: z.string().min(1).nullable(),
  adId: z.string().min(1).nullable(),
  errorMessage: z.string().nullable(),
  syncWarning: z.string().nullable(),
  attemptCount: z.number().int().nonnegative(),
  claimedBy: z.string().min(1).nullable(),
  claimedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LaunchPlanItemRecord = z.infer<typeof LaunchPlanItemRecordSchema>;

export const LaunchPlanItemAttemptRecordSchema = z.object({
  attemptId: z.string().min(1),
  itemId: z.string().min(1),
  operationId: z.string().min(1),
  correlationId: z.string().min(1),
  actor: WriteTaskActorSchema,
  attemptNumber: z.number().int().positive(),
  phase: LaunchCreationPhaseSchema,
  status: z.enum(["running", "succeeded", "failed", "unknown"]),
  evidence: LaunchCreationEvidenceSchema,
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type LaunchPlanItemAttemptRecord = z.infer<typeof LaunchPlanItemAttemptRecordSchema>;

export const LaunchSheetIssueSchema = z.object({
  rowNumber: z.number().int().min(1),
  field: z.string().min(1),
  message: z.string().min(1),
});
export type LaunchSheetIssue = z.infer<typeof LaunchSheetIssueSchema>;

export const LaunchSheetImportResultSchema = z.object({
  rows: z.array(LaunchConfigurationRowSchema).max(500),
  errors: z.array(LaunchSheetIssueSchema),
  warnings: z.array(LaunchSheetIssueSchema),
});
export type LaunchSheetImportResult = z.infer<typeof LaunchSheetImportResultSchema>;

export const launchSheetColumns = [
  { key: "campaignName", label: "推广系列名称", aliases: ["系列名称", "广告系列名称", "campaign", "campaign name"] },
  { key: "adGroupName", label: "广告组名称", aliases: ["组名称", "adgroup", "ad group name"] },
  { key: "videoCode", label: "视频代码", aliases: ["视频ID", "视频id", "video", "video code", "video id"] },
  { key: "productUrl", label: "产品 URL", aliases: ["产品链接", "落地页", "product url", "url", "landing page"] },
] as const;
type LaunchSheetColumnKey = (typeof launchSheetColumns)[number]["key"];

/**
 * Parses the two fields that need manual spreadsheet input. Budget, bid and
 * timing are deliberately applied afterwards from the selected preset.
 */
/**
 * 把预设的创建时间规则解析成具体时间。相对规则（当天24:00 / 次日06:00）按传入
 * 的 now 重算，因此保存的预设不会冻结日期，每次使用都随当前时间变动。
 */
export function resolveLaunchStartAt(
  startAtRule: "absolute" | "tonight" | "tomorrow-morning" | undefined,
  absoluteStartAt: string | null,
  now = new Date(),
  timeZone?: string,
): string | null {
  if (!startAtRule || startAtRule === "absolute") return absoluteStartAt;
  if (timeZone) {
    const nowParts = dateTimePartsInZone(now, timeZone);
    const targetHour = startAtRule === "tonight" ? 0 : 6;
    const targetWallClock = Date.UTC(
      nowParts.year,
      nowParts.month - 1,
      nowParts.day + 1,
      targetHour,
      0,
      0,
    );
    // Convert the target wall-clock value in the account timezone to an
    // instant. Repeating once also handles a DST offset change at midnight.
    let candidate = targetWallClock;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const actual = dateTimePartsInZone(new Date(candidate), timeZone);
      const actualWallClock = Date.UTC(
        actual.year,
        actual.month - 1,
        actual.day,
        actual.hour,
        actual.minute,
        actual.second,
      );
      candidate += targetWallClock - actualWallClock;
    }
    return new Date(candidate).toISOString();
  }
  const date = new Date(now);
  date.setSeconds(0, 0);
  date.setDate(date.getDate() + 1);
  date.setHours(startAtRule === "tonight" ? 0 : 6, 0, 0, 0);
  return date.toISOString();
}

/** Resolve per-target migration timing in the target account timezone. */
export function resolveMigrationStartAt(
  startAtRule: LaunchMigrationStartRule,
  absoluteStartAt: string | null,
  now = new Date(),
  timeZone?: string,
): string | null {
  if (startAtRule === "absolute") return absoluteStartAt;
  if (startAtRule === "tonight") return resolveLaunchStartAt("tonight", null, now, timeZone);
  if (!timeZone) {
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setHours(6, 0, 0, 0);
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate.toISOString();
  }
  const parts = dateTimePartsInZone(now, timeZone);
  const dayOffset = parts.hour < 6 ? 0 : 1;
  const targetWallClock = Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, 6, 0, 0);
  let candidate = targetWallClock;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const actual = dateTimePartsInZone(new Date(candidate), timeZone);
    const actualWallClock = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate += targetWallClock - actualWallClock;
  }
  return new Date(candidate).toISOString();
}

function dateTimePartsInZone(value: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const partValue = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = Number(parts.find((part) => part.type === type)?.value);
    if (!Number.isInteger(value)) {
      throw new Error(`无法按账户时区解析 ${type}。`);
    }
    return value;
  };
  return {
    year: partValue("year"),
    month: partValue("month"),
    day: partValue("day"),
    hour: partValue("hour"),
    minute: partValue("minute"),
    second: partValue("second"),
  };
}

export function parseLaunchSheetTable(
  table: unknown[][],
  preset: LaunchPresetInput,
  now = new Date(),
  timeZone?: string,
  options: { requireVideoCode?: boolean } = {},
): LaunchSheetImportResult {
  const errors: LaunchSheetIssue[] = [];
  const warnings: LaunchSheetIssue[] = [];
  if (table.length === 0) {
    return { rows: [], errors: [{ rowNumber: 1, field: "文件", message: "表格为空。" }], warnings };
  }
  const headerMap = mapHeaders(table[0] ?? [], errors);
  const rows: LaunchConfigurationRow[] = [];
  let serial = 1;
  let adCount = 0;
  // A block starts on a row that fills 推广系列名称. Rows below it that leave
  // 系列名称 blank belong to the same campaign — each such row is another
  // ad-group. A blank 视频代码/产品 URL on a continuation row means "same as the
  // block head", i.e. an exact copy of the first ad-group's ads. This lets a
  // sheet express: one campaign → several ad-groups → each ad-group the same
  // set of video codes (= ads), without repeating the codes on every line.
  let block: { campaignName: string; videoCode: string; productUrl: string } | null = null;
  for (let index = 1; index < table.length; index += 1) {
    const source = table[index] ?? [];
    if (source.every(isBlank)) continue;
    const rowNumber = index + 1;
    let campaignName = asText(source[headerMap.get("campaignName") ?? -1]);
    const adGroupName = asText(source[headerMap.get("adGroupName") ?? -1]);
    let videoCode = asText(source[headerMap.get("videoCode") ?? -1]);
    let productUrl = asText(source[headerMap.get("productUrl") ?? -1]);
    if (campaignName) {
      // New block head: its own 系列/代码/URL become the defaults inherited by
      // the continuation rows below until the next filled 系列名称.
      block = { campaignName, videoCode, productUrl };
    } else if (block) {
      // Continuation row: inherit the campaign, and fall back to the block
      // head's video codes / URL when this row leaves them blank.
      campaignName = block.campaignName;
      if (!videoCode) videoCode = block.videoCode;
      if (!productUrl) productUrl = block.productUrl;
    }
    if (!campaignName) addError(errors, rowNumber, "推广系列名称", "请填写推广系列名称。");
    if (!adGroupName) addError(errors, rowNumber, "广告组名称", "请填写广告组名称。");
    if (options.requireVideoCode !== false && !videoCode) {
      addError(errors, rowNumber, "视频代码", "请填写视频代码。");
    }
    if (!isUrl(productUrl)) addError(errors, rowNumber, "产品 URL", "请填写有效的 http 或 https 产品 URL。");
    if (errors.some((issue) => issue.rowNumber === rowNumber)) continue;
    // One sheet row = one ad-group. Several video codes in the cell become
    // several ads *inside* that one ad-group; the codes stay joined here and
    // are split into per-ad creatives when the ad-group is created. This is the
    // "一个广告组多条广告" shape — do NOT split into separate ad-groups.
    const videoCodes = splitVideoCodes(videoCode);
    adCount += Math.max(1, videoCodes.length);
    const name = automaticName(now, serial);
    serial += 1;
    rows.push(LaunchConfigurationRowSchema.parse({
      rowNumber,
      campaignName,
      videoCode: videoCodes.join(";"),
      productUrl,
      adGroupName,
      adName: name,
      region: preset.region,
      dailyBudget: preset.dailyBudget,
      bid: preset.bid,
      startAt: resolveLaunchStartAt(preset.startAtRule, preset.startAt ?? null, now, timeZone),
      endAt: preset.endAt,
      initialStatus: preset.initialStatus,
    }));
  }
  if (rows.length === 0 && errors.length === 0) {
    errors.push({ rowNumber: 2, field: "数据", message: "没有可导入的任务行。" });
  }
  // The 500 cap counts ads (a multi-code ad-group counts as several ads), not
  // ad-group rows, matching the template's stated safety limit.
  if (adCount > 500) {
    errors.push({ rowNumber: 1, field: "文件", message: "单次最多创建 500 条广告。" });
  }
  return LaunchSheetImportResultSchema.parse({ rows: rows.slice(0, 500), errors, warnings });
}

/** A cell can contain several account-local video codes separated by ;、； or a new line. */
export function splitVideoCodes(value: string): string[] {
  return [...new Set(value.split(/[;；\r\n]+/).map((item) => item.trim()).filter(Boolean))];
}

export function automaticName(now: Date, serial: number): string {
  const year = String(now.getFullYear()).slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}${month}${day}:${String(serial).padStart(3, "0")}`;
}

/** Remove only suffixes generated by automatic ad-group naming. */
export function stripAutomaticAdGroupNameSuffixes(sourceName: string): string {
  const original = sourceName.trim();
  let current = original;
  while (current) {
    // -MMDD-HHMMSS[-序号]（投放日期+时间）。必须排在纯序号形式之前判定：像
    // 143052 这样的时间同时也匹配序号正则，先判序号会把时间当成序号、只剥掉
    // 一半后缀。扩组与自动复制会在时间戳后再接批内序号，因此两种都要认。
    const stampedIndexed = current.match(/^(.*?)-(\d{4})-(\d{6})-[1-9]\d*$/);
    if (
      stampedIndexed
      && stampedIndexed[1]?.trim()
      && isValidMonthDay(stampedIndexed[2]!)
      && isValidTimeOfDay(stampedIndexed[3]!)
    ) {
      current = stampedIndexed[1].replace(/-+$/, "").trim();
      continue;
    }
    const stamped = current.match(/^(.*?)-(\d{4})-(\d{6})$/);
    if (
      stamped
      && stamped[1]?.trim()
      && isValidMonthDay(stamped[2]!)
      && isValidTimeOfDay(stamped[3]!)
    ) {
      current = stamped[1].replace(/-+$/, "").trim();
      continue;
    }
    const indexed = current.match(/^(.*?)-(\d{4})-([1-9]\d*)$/);
    if (indexed && indexed[1]?.trim() && isValidMonthDay(indexed[2]!)) {
      current = indexed[1].replace(/-+$/, "").trim();
      continue;
    }
    const dated = current.match(/^(.*?)-?(\d{4})$/);
    if (dated && dated[1]?.trim() && isValidMonthDay(dated[2]!)) {
      current = dated[1].replace(/-+$/, "").trim();
      continue;
    }
    break;
  }
  return current || original;
}

/** Existing expansion-compatible rule: source-MMDD-1, source-MMDD-2, ... */
export function automaticAdGroupName(
  sourceName: string,
  deliveryAt: Date,
  index: number,
  timeZone?: string,
): string {
  const parts = timeZone ? dateTimePartsInZone(deliveryAt, timeZone) : {
    month: deliveryAt.getMonth() + 1,
    day: deliveryAt.getDate(),
  };
  const suffix = `${String(parts.month).padStart(2, "0")}${String(parts.day).padStart(2, "0")}`;
  return `${stripAutomaticAdGroupNameSuffixes(sourceName)}-${suffix}-${index + 1}`;
}

function isValidTimeOfDay(value: string): boolean {
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(2, 4));
  const second = Number(value.slice(4, 6));
  if (![hour, minute, second].every(Number.isInteger)) return false;
  return hour <= 23 && minute <= 59 && second <= 59;
}

function isValidMonthDay(value: string): boolean {
  const month = Number(value.slice(0, 2));
  const day = Number(value.slice(2, 4));
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(2024, month, 0).getDate();
}

export const MultiAccountLaunchPlanInputSchema = z.object({
  clientRequestId: z.string().uuid().optional(),
  mode: LaunchModeSchema.default("copy"),
  sourceAccountId: z.string().trim().min(1),
  sourceAdGroupId: z.string().trim().min(1).max(128).nullable().default(null),
  sourceAdGroupIds: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
  copyPreviewId: z.string().trim().min(1).nullable().default(null),
  targetAccountIds: z.array(z.string().trim().min(1)).min(1).max(100),
  launchPresetId: z.string().trim().min(1),
  launchRows: z.array(LaunchConfigurationRowSchema).min(1).max(500),
  copyTargetConfigs: z.array(LaunchMigrationTargetConfigSchema).max(100).default([]),
});
export type MultiAccountLaunchPlanInput = z.input<typeof MultiAccountLaunchPlanInputSchema>;

export const LaunchAccountExecutionResultSchema = z.object({
  accountId: z.string().min(1),
  ok: z.boolean(),
  message: z.string().max(2_000).nullable(),
  createdCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  unknownCount: z.number().int().nonnegative().default(0),
});
export type LaunchAccountExecutionResult = z.infer<typeof LaunchAccountExecutionResultSchema>;

export const MultiAccountLaunchPlanRecordSchema = MultiAccountLaunchPlanInputSchema.extend({
  // Historical local plans were saved before spreadsheet rows existed.  Keep
  // them readable so an upgrade never breaks the whole plans list; new plans
  // still use MultiAccountLaunchPlanInputSchema and require at least one row.
  launchRows: z.array(LaunchConfigurationRowSchema).max(500),
  id: z.string().min(1),
  copyPreviewId: z.string().min(1).nullable().default(null),
  sourceAdName: z.string().min(1),
  presetName: z.string().min(1),
  /** Immutable configuration used for this plan.  Editing a preset later must
   * never alter an already queued creation request. */
  presetSnapshot: LaunchPresetInputSchema.nullable(),
  status: z.enum(["draft", "blocked", "cancelled", "completed"]),
  message: z.string().nullable(),
  executionResults: z.array(LaunchAccountExecutionResultSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MultiAccountLaunchPlanRecord = z.infer<typeof MultiAccountLaunchPlanRecordSchema>;

function mapHeaders(headers: unknown[], errors: LaunchSheetIssue[]): Map<LaunchSheetColumnKey, number> {
  const map = new Map<LaunchSheetColumnKey, number>();
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const definition = launchSheetColumns.find((column) =>
      [column.label, ...column.aliases].some((alias) => normalizeHeader(alias) === normalized),
    );
    if (definition && !map.has(definition.key)) map.set(definition.key, index);
  });
  for (const column of launchSheetColumns) {
    if (!map.has(column.key)) errors.push({ rowNumber: 1, field: column.label, message: `缺少必需表头“${column.label}”。` });
  }
  return map;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}
function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}
function normalizeHeader(value: unknown): string {
  return asText(value).toLowerCase().replace(/[\s_\-（）()]/g, "");
}
function addError(issues: LaunchSheetIssue[], rowNumber: number, field: string, message: string): void {
  issues.push({ rowNumber, field, message });
}
function isUrl(value: string): boolean {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol); } catch { return false; }
}
