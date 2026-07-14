import { z } from "zod";

export const LaunchInitialStatusSchema = z.enum(["enabled", "disabled"]);
export type LaunchInitialStatus = z.infer<typeof LaunchInitialStatusSchema>;

export const LaunchConfigurationRowSchema = z.object({
  rowNumber: z.number().int().min(2),
  taskName: z.string().trim().min(1).max(120),
  campaignName: z.string().trim().min(1).max(512),
  adGroupName: z.string().trim().min(1).max(512),
  adName: z.string().trim().min(1).max(512),
  dailyBudget: z.number().positive().max(100_000_000),
  bid: z.number().nonnegative().max(100_000_000).nullable(),
  startAt: z.string().datetime().nullable(),
  endAt: z.string().datetime().nullable(),
  initialStatus: LaunchInitialStatusSchema,
});
export type LaunchConfigurationRow = z.infer<
  typeof LaunchConfigurationRowSchema
>;

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
export type LaunchSheetImportResult = z.infer<
  typeof LaunchSheetImportResultSchema
>;

export const launchSheetColumns = [
  { key: "taskName", label: "任务名称", aliases: ["任务", "task"] },
  {
    key: "campaignName",
    label: "推广系列名称",
    aliases: ["系列名称", "广告系列名称", "campaign", "campaign name"],
  },
  {
    key: "adGroupName",
    label: "广告组名称",
    aliases: ["组名称", "adgroup", "ad group name"],
  },
  { key: "adName", label: "广告名称", aliases: ["ad", "ad name"] },
  {
    key: "dailyBudget",
    label: "广告组日预算",
    aliases: ["广告组预算", "日预算", "预算", "daily budget"],
  },
  { key: "bid", label: "出价", aliases: ["竞价", "bid"] },
  {
    key: "startAt",
    label: "创建时间",
    aliases: ["开始时间", "投放时间", "start time"],
  },
  { key: "endAt", label: "结束时间", aliases: ["停止时间", "end time"] },
  {
    key: "initialStatus",
    label: "初始状态",
    aliases: ["状态", "initial status"],
  },
] as const;

type LaunchSheetColumnKey = (typeof launchSheetColumns)[number]["key"];

const inheritableKeys: LaunchSheetColumnKey[] = [
  "campaignName",
  "adGroupName",
  "adName",
  "dailyBudget",
  "bid",
  "startAt",
  "endAt",
  "initialStatus",
];

/**
 * Converts a worksheet-shaped matrix into validated launch rows. The first row
 * contains headers; blank cells inherit the previous non-empty value only for
 * documented columns, so a user only needs to enter changed values.
 */
export function parseLaunchSheetTable(table: unknown[][]): LaunchSheetImportResult {
  const errors: LaunchSheetIssue[] = [];
  const warnings: LaunchSheetIssue[] = [];
  if (table.length === 0) {
    return { rows: [], errors: [{ rowNumber: 1, field: "文件", message: "表格为空。" }], warnings };
  }

  const headerMap = mapHeaders(table[0] ?? [], errors);
  const previous: Partial<Record<LaunchSheetColumnKey, unknown>> = {};
  const rows: LaunchConfigurationRow[] = [];

  for (let index = 1; index < table.length; index += 1) {
    const source = table[index] ?? [];
    if (source.every(isBlank)) continue;
    const rowNumber = index + 1;
    const raw: Partial<Record<LaunchSheetColumnKey, unknown>> = {};
    for (const column of launchSheetColumns) {
      const cellIndex = headerMap.get(column.key);
      if (cellIndex === undefined) continue;
      const value = source[cellIndex];
      if (!isBlank(value)) {
        raw[column.key] = value;
        if (inheritableKeys.includes(column.key)) previous[column.key] = value;
      } else if (inheritableKeys.includes(column.key)) {
        raw[column.key] = previous[column.key];
      }
    }

    const normalized = normalizeLaunchRow(raw, rowNumber, errors, warnings);
    if (normalized) rows.push(normalized);
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push({ rowNumber: 2, field: "数据", message: "没有可导入的任务行。" });
  }
  if (rows.length > 500) {
    errors.push({ rowNumber: 1, field: "文件", message: "单次最多导入 500 条任务。" });
  }
  return LaunchSheetImportResultSchema.parse({ rows: rows.slice(0, 500), errors, warnings });
}

export const MultiAccountLaunchPlanInputSchema = z.object({
  sourceAccountId: z.string().trim().min(1),
  sourceAdId: z.string().trim().min(1).max(128),
  targetAccountIds: z.array(z.string().trim().min(1)).min(1).max(100),
  namingTemplate: z.string().trim().min(1).max(300),
  startPaused: z.boolean(),
  launchRows: z.array(LaunchConfigurationRowSchema).max(500).optional(),
});
export type MultiAccountLaunchPlanInput = z.infer<
  typeof MultiAccountLaunchPlanInputSchema
>;

export const MultiAccountLaunchPlanRecordSchema =
  MultiAccountLaunchPlanInputSchema.extend({
    id: z.string().min(1),
    sourceAdName: z.string().min(1),
    status: z.enum(["draft", "blocked", "cancelled", "completed"]),
    message: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    launchRows: z.array(LaunchConfigurationRowSchema).max(500),
  });
export type MultiAccountLaunchPlanRecord = z.infer<
  typeof MultiAccountLaunchPlanRecordSchema
>;

function mapHeaders(headers: unknown[], errors: LaunchSheetIssue[]): Map<LaunchSheetColumnKey, number> {
  const map = new Map<LaunchSheetColumnKey, number>();
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (!normalized) return;
    const definition = launchSheetColumns.find((column) =>
      [column.label, ...column.aliases].some((alias) => normalizeHeader(alias) === normalized),
    );
    if (definition && !map.has(definition.key)) map.set(definition.key, index);
  });
  for (const key of ["campaignName", "dailyBudget"] as const) {
    if (!map.has(key)) {
      const label = launchSheetColumns.find((column) => column.key === key)?.label ?? key;
      errors.push({ rowNumber: 1, field: label, message: `缺少必需表头“${label}”。` });
    }
  }
  return map;
}

function normalizeLaunchRow(
  raw: Partial<Record<LaunchSheetColumnKey, unknown>>,
  rowNumber: number,
  errors: LaunchSheetIssue[],
  warnings: LaunchSheetIssue[],
): LaunchConfigurationRow | null {
  const campaignName = asText(raw.campaignName);
  if (!campaignName) addError(errors, rowNumber, "推广系列名称", "请填写推广系列名称，或让该列继承上一行。 ");
  const dailyBudget = asNumber(raw.dailyBudget);
  if (dailyBudget === null || dailyBudget <= 0) addError(errors, rowNumber, "广告组日预算", "预算必须是大于 0 的数字。 ");
  const bidText = asText(raw.bid);
  const bid = !bidText || ["自动", "自动出价", "auto"].includes(bidText.toLowerCase()) ? null : asNumber(raw.bid);
  if (bidText && bid === null && !["自动", "自动出价", "auto"].includes(bidText.toLowerCase())) {
    addError(errors, rowNumber, "出价", "请输入不小于 0 的数字，或填写“自动”。");
  } else if (bid !== null && bid < 0) {
    addError(errors, rowNumber, "出价", "出价不能小于 0。 ");
  }

  const startAt = asDateTime(raw.startAt, rowNumber, "创建时间", errors);
  const endAt = asDateTime(raw.endAt, rowNumber, "结束时间", errors);
  if (startAt && endAt && endAt <= startAt) addError(errors, rowNumber, "结束时间", "结束时间必须晚于创建时间。 ");
  const initialStatus = asStatus(raw.initialStatus, rowNumber, errors);
  const adGroupName = asText(raw.adGroupName) || `${campaignName || "未命名系列"}-广告组`;
  const adName = asText(raw.adName) || `${adGroupName}-广告`;
  const taskName = asText(raw.taskName) || `任务-${rowNumber - 1}`;
  if (!asText(raw.adGroupName)) warnings.push({ rowNumber, field: "广告组名称", message: `未填写，自动使用“${adGroupName}”。` });
  if (!asText(raw.adName)) warnings.push({ rowNumber, field: "广告名称", message: `未填写，自动使用“${adName}”。` });

  if (errors.some((issue) => issue.rowNumber === rowNumber)) return null;
  return LaunchConfigurationRowSchema.parse({
    rowNumber,
    taskName,
    campaignName,
    adGroupName,
    adName,
    dailyBudget,
    bid,
    startAt,
    endAt,
    initialStatus,
  });
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = asText(value).replace(/[,，￥$]/g, "");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function asDateTime(value: unknown, rowNumber: number, field: string, errors: LaunchSheetIssue[]): string | null {
  if (isBlank(value)) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "number" && value > 0) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    const date = new Date(excelEpoch + value * 86_400_000);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  const date = new Date(asText(value).replace(/\//g, "-"));
  if (!Number.isFinite(date.getTime())) {
    addError(errors, rowNumber, field, "时间格式无法识别，建议使用 2026-07-16 09:00。 ");
    return null;
  }
  return date.toISOString();
}

function asStatus(value: unknown, rowNumber: number, errors: LaunchSheetIssue[]): LaunchInitialStatus {
  const normalized = asText(value).toLowerCase();
  if (!normalized || ["关闭", "暂停", "disabled", "off", "0"].includes(normalized)) return "disabled";
  if (["开启", "启用", "enabled", "on", "1"].includes(normalized)) return "enabled";
  addError(errors, rowNumber, "初始状态", "仅支持“开启”或“关闭”，留空默认关闭。 ");
  return "disabled";
}

function addError(issues: LaunchSheetIssue[], rowNumber: number, field: string, message: string): void {
  issues.push({ rowNumber, field, message: message.trim() });
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function normalizeHeader(value: unknown): string {
  return asText(value).toLowerCase().replace(/[\s_\-（）()]/g, "");
}
