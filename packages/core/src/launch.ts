import { z } from "zod";
import { WriteTaskActorSchema } from "./write-task.js";

export const LaunchInitialStatusSchema = z.enum(["enabled", "disabled"]);
export type LaunchInitialStatus = z.infer<typeof LaunchInitialStatusSchema>;

export const LaunchModeSchema = z.enum(["single", "multi", "copy"]);
export type LaunchMode = z.infer<typeof LaunchModeSchema>;

export const LaunchTemplateModeSchema = z.enum(["none", "copy"]);
export type LaunchTemplateMode = z.infer<typeof LaunchTemplateModeSchema>;

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

export const LaunchSourceSnapshotSchema = z.object({
  accountId: z.string().min(1),
  campaignId: z.string().min(1),
  campaignName: z.string().min(1),
  adGroupId: z.string().min(1),
  adGroupName: z.string().min(1),
  adId: z.string().min(1),
  adName: z.string().min(1),
  videoCode: z.string().min(1),
  productUrl: z.string().url().nullable(),
  structuralHash: z.string().min(1),
  syncedAt: z.string().datetime(),
});
export type LaunchSourceSnapshot = z.infer<typeof LaunchSourceSnapshotSchema>;

export const LaunchTargetAssetMappingSchema = z.object({
  accountId: z.string().min(1),
  sourceVideoCode: z.string().min(1),
  targetVideoCode: z.string().min(1),
  evidenceAdId: z.string().min(1),
  evidenceSyncedAt: z.string().datetime(),
});
export type LaunchTargetAssetMapping = z.infer<typeof LaunchTargetAssetMappingSchema>;

export const LaunchCopyDifferenceSchema = z.object({
  field: z.enum(["campaignName", "adGroupName", "adName", "videoCode", "productUrl"]),
  sourceValue: z.string().nullable(),
  targetValue: z.string().nullable(),
});
export type LaunchCopyDifference = z.infer<typeof LaunchCopyDifferenceSchema>;

export const LaunchCopyPreviewItemSchema = z.object({
  accountId: z.string().min(1),
  itemIndex: z.number().int().nonnegative(),
  launchRow: z.lazy(() => LaunchConfigurationRowSchema),
  sourceSnapshot: LaunchSourceSnapshotSchema,
  targetAssetMapping: LaunchTargetAssetMappingSchema,
  differences: z.array(LaunchCopyDifferenceSchema),
});
export type LaunchCopyPreviewItem = z.infer<typeof LaunchCopyPreviewItemSchema>;

/** Values TikTok needs in addition to each spreadsheet row.  They are saved
 * once in a preset rather than repeatedly typed into the import sheet. */
export const CreationPresetConfigSchema = z.object({
  templateCampaignId: z.string().trim().min(1).max(128).nullable().optional(),
  objectiveType: z.number().int().nullable().default(null),
  buyingType: z.number().int().nullable().default(null),
  campaignBudgetMode: z.number().int().nullable().default(null),
  adBudgetMode: z.number().int().nullable().default(null),
  pricing: z.number().int().nullable().default(null),
  optimizeGoal: z.number().int().nullable().default(null),
  externalAction: z.number().int().nullable().default(null),
  pixelId: z.string().trim().max(256).nullable().default(null),
  identityType: z.number().int().nullable().default(null),
  identityId: z.string().trim().max(256).nullable().default(null),
  callToActionId: z.string().trim().max(256).nullable().default(null),
  countryCodes: z.array(z.number().int()).max(100).default([]),
  placementIds: z.array(z.number().int()).max(100).default([]),
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
    identityType: 0,
    identityId: null,
    callToActionId: "0",
    countryCodes: [1668284],
    placementIds: [3000],
  });

export const LaunchPresetInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  region: z.string().trim().min(1).max(120),
  dailyBudget: z.number().positive().max(100_000_000),
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
  videoCode: z.string().trim().min(1).max(512),
  productUrl: z.string().url().max(2_048),
  adGroupName: z.string().trim().min(1).max(512),
  adName: z.string().trim().min(1).max(512),
  // Older locally saved plans did not contain a region.  Preserve their
  // readability while every newly saved plan receives it from its preset.
  region: z.string().trim().min(1).max(120).default("未设置"),
  dailyBudget: z.number().positive().max(100_000_000),
  bid: z.number().nonnegative().max(100_000_000).nullable(),
  startAt: z.string().datetime().nullable(),
  endAt: z.string().datetime().nullable(),
  initialStatus: LaunchInitialStatusSchema,
});
export type LaunchConfigurationRow = z.infer<typeof LaunchConfigurationRowSchema>;

export const LaunchCopyPreviewInputSchema = z.object({
  sourceAccountId: z.string().trim().min(1),
  sourceAdId: z.string().trim().min(1).max(128),
  targetAccountIds: z.array(z.string().trim().min(1)).min(1).max(3),
  launchPresetId: z.string().trim().min(1),
  launchRows: z.array(LaunchConfigurationRowSchema).min(1).max(3),
});
export type LaunchCopyPreviewInput = z.infer<typeof LaunchCopyPreviewInputSchema>;

export const LaunchCopyPreviewRecordSchema = z.object({
  id: z.string().min(1),
  sourceAccountId: z.string().min(1),
  sourceAdId: z.string().min(1),
  targetAccountIds: z.array(z.string().min(1)).min(1).max(3),
  launchPresetId: z.string().min(1),
  /** Immutable preset content that the user reviewed.  The final plan must
   * use this snapshot even if the named preset is edited before confirmation. */
  presetSnapshot: LaunchPresetInputSchema,
  presetSnapshotHash: z.string().min(1),
  inputHash: z.string().min(1),
  launchRowsHash: z.string().min(1),
  launchRows: z.array(LaunchConfigurationRowSchema).min(1).max(3),
  sourceSnapshot: LaunchSourceSnapshotSchema,
  items: z.array(LaunchCopyPreviewItemSchema).max(3),
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
  targetAssetMapping: LaunchTargetAssetMappingSchema.nullable().default(null),
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

const LaunchManualVerificationFieldsSchema = z.object({
  decision: z.enum(["confirmed-succeeded", "confirmed-not-created"]),
  evidence: z.string().trim().min(10).max(4_000),
  note: z.string().trim().max(2_000).default(""),
  campaignId: z.string().trim().min(1).max(256).nullable().default(null),
  adGroupId: z.string().trim().min(1).max(256).nullable().default(null),
  adId: z.string().trim().min(1).max(256).nullable().default(null),
});
export const LaunchManualVerificationInputSchema = LaunchManualVerificationFieldsSchema.superRefine((value, context) => {
  if (value.decision === "confirmed-succeeded" && (!value.campaignId || !value.adGroupId || !value.adId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "确认成功必须填写 campaignId、adGroupId 和 adId。",
      path: ["campaignId"],
    });
  }
});
export type LaunchManualVerificationInput = z.infer<typeof LaunchManualVerificationInputSchema>;

export const LaunchManualVerificationRecordSchema = LaunchManualVerificationFieldsSchema.extend({
  id: z.string().min(1),
  itemId: z.string().min(1),
  actorId: z.string().min(1),
  actorName: z.string().min(1),
  previousStatus: z.literal("unknown"),
  nextStatus: z.enum(["succeeded", "failed"]),
  createdAt: z.string().datetime(),
});
export type LaunchManualVerificationRecord = z.infer<typeof LaunchManualVerificationRecordSchema>;

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
    if (!videoCode) addError(errors, rowNumber, "视频代码", "请填写视频代码。");
    if (!isUrl(productUrl)) addError(errors, rowNumber, "产品 URL", "请填写有效的 http 或 https 产品 URL。");
    if (errors.some((issue) => issue.rowNumber === rowNumber)) continue;
    // One sheet row = one ad-group. Several video codes in the cell become
    // several ads *inside* that one ad-group; the codes stay joined here and
    // are split into per-ad creatives when the ad-group is created. This is the
    // "一个广告组多条广告" shape — do NOT split into separate ad-groups.
    const videoCodes = splitVideoCodes(videoCode);
    adCount += videoCodes.length;
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
    if (videoCodes.length > 1) {
      warnings.push({ rowNumber, field: "视频代码", message: `该广告组将创建 ${videoCodes.length} 条广告。` });
    }
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

export const MultiAccountLaunchPlanInputSchema = z.object({
  mode: LaunchModeSchema.default("copy"),
  sourceAccountId: z.string().trim().min(1),
  sourceAdId: z.string().trim().min(1).max(128).nullable().default(null),
  copyPreviewId: z.string().trim().min(1).nullable().default(null),
  targetAccountIds: z.array(z.string().trim().min(1)).min(1).max(100),
  launchPresetId: z.string().trim().min(1),
  launchRows: z.array(LaunchConfigurationRowSchema).min(1).max(500),
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
