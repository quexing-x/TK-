import { z } from "zod";

export const LaunchInitialStatusSchema = z.enum(["enabled", "disabled"]);
export type LaunchInitialStatus = z.infer<typeof LaunchInitialStatusSchema>;

export const LaunchModeSchema = z.enum(["single", "multi", "copy"]);
export type LaunchMode = z.infer<typeof LaunchModeSchema>;

/** Values TikTok needs in addition to each spreadsheet row.  They are saved
 * once in a preset rather than repeatedly typed into the import sheet. */
export const CreationPresetConfigSchema = z.object({
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
});
export type CreationPresetConfig = z.infer<typeof CreationPresetConfigSchema>;
export const defaultCreationPresetConfig: CreationPresetConfig =
  CreationPresetConfigSchema.parse({});

export const LaunchPresetInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  region: z.string().trim().min(1).max(120),
  dailyBudget: z.number().positive().max(100_000_000),
  bid: z.number().nonnegative().max(100_000_000).nullable(),
  startAt: z.string().datetime().nullable(),
  endAt: z.string().datetime().nullable(),
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
export function parseLaunchSheetTable(
  table: unknown[][],
  preset: LaunchPresetInput,
  now = new Date(),
): LaunchSheetImportResult {
  const errors: LaunchSheetIssue[] = [];
  const warnings: LaunchSheetIssue[] = [];
  if (table.length === 0) {
    return { rows: [], errors: [{ rowNumber: 1, field: "文件", message: "表格为空。" }], warnings };
  }
  const headerMap = mapHeaders(table[0] ?? [], errors);
  const rows: LaunchConfigurationRow[] = [];
  let serial = 1;
  for (let index = 1; index < table.length; index += 1) {
    const source = table[index] ?? [];
    if (source.every(isBlank)) continue;
    const rowNumber = index + 1;
    const campaignName = asText(source[headerMap.get("campaignName") ?? -1]);
    const adGroupName = asText(source[headerMap.get("adGroupName") ?? -1]);
    const videoCode = asText(source[headerMap.get("videoCode") ?? -1]);
    const productUrl = asText(source[headerMap.get("productUrl") ?? -1]);
    if (!campaignName) addError(errors, rowNumber, "推广系列名称", "请填写推广系列名称。");
    if (!adGroupName) addError(errors, rowNumber, "广告组名称", "请填写广告组名称。");
    if (!videoCode) addError(errors, rowNumber, "视频代码", "请填写视频代码。");
    if (!isUrl(productUrl)) addError(errors, rowNumber, "产品 URL", "请填写有效的 http 或 https 产品 URL。");
    if (errors.some((issue) => issue.rowNumber === rowNumber)) continue;
    const name = automaticName(now, serial);
    serial += 1;
    rows.push(LaunchConfigurationRowSchema.parse({
      rowNumber,
      campaignName,
      videoCode,
      productUrl,
      adGroupName,
      adName: name,
      region: preset.region,
      dailyBudget: preset.dailyBudget,
      bid: preset.bid,
      startAt: preset.startAt,
      endAt: preset.endAt,
      initialStatus: preset.initialStatus,
    }));
  }
  if (rows.length === 0 && errors.length === 0) {
    errors.push({ rowNumber: 2, field: "数据", message: "没有可导入的任务行。" });
  }
  if (rows.length > 500) {
    errors.push({ rowNumber: 1, field: "文件", message: "单次最多导入 500 条任务。" });
  }
  return LaunchSheetImportResultSchema.parse({ rows: rows.slice(0, 500), errors, warnings });
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
  targetAccountIds: z.array(z.string().trim().min(1)).min(1).max(100),
  launchPresetId: z.string().trim().min(1),
  launchRows: z.array(LaunchConfigurationRowSchema).min(1).max(500),
});
export type MultiAccountLaunchPlanInput = z.infer<typeof MultiAccountLaunchPlanInputSchema>;

export const LaunchAccountExecutionResultSchema = z.object({
  accountId: z.string().min(1),
  ok: z.boolean(),
  message: z.string().max(2_000).nullable(),
  createdCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
});
export type LaunchAccountExecutionResult = z.infer<typeof LaunchAccountExecutionResultSchema>;

export const MultiAccountLaunchPlanRecordSchema = MultiAccountLaunchPlanInputSchema.extend({
  // Historical local plans were saved before spreadsheet rows existed.  Keep
  // them readable so an upgrade never breaks the whole plans list; new plans
  // still use MultiAccountLaunchPlanInputSchema and require at least one row.
  launchRows: z.array(LaunchConfigurationRowSchema).max(500),
  id: z.string().min(1),
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
