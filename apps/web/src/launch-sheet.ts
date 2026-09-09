import type { CellValue } from "exceljs";
import { loadExcelJs } from "./exceljs-loader.js";
import {
  LaunchAgeRangeValues,
  launchSheetColumns,
  parseLaunchSheetTable,
  type LaunchConfigurationRow,
  type LaunchPlanItemRecord,
  type LaunchPresetInput,
  type LaunchSheetImportResult,
} from "@tk-auto/core";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
// 模板预填 18 岁以上：Smart+ 推广系列禁止向 18 岁以下投放。
const DEFAULT_AGE_RANGES = "18-24;25-34;35-44;45-54;55-100";
const TEMPLATE_DATA_ROW_COUNT = 500;
const LAUNCH_SHEET_WIDTHS = [32, 30, 28, 45, 48, 12, 16] as const;

export async function readLaunchSpreadsheet(
  file: File,
  preset: LaunchPresetInput,
  options: { requireVideoCode?: boolean } = {},
): Promise<LaunchSheetImportResult> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  let table: unknown[][];
  if (extension === "csv") {
    table = parseCsvTable(await file.text());
  } else if (extension === "xlsx") {
    const { Workbook } = await loadExcelJs();
    const workbook = new Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error("Excel 文件中没有工作表。");
    table = [];
    const width = Math.max(worksheet.actualColumnCount, worksheet.columnCount);
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      const values: unknown[] = [];
      for (let column = 1; column <= width; column += 1) values.push(extractCellValue(row.getCell(column).value));
      table.push(values);
    });
  } else {
    throw new Error("仅支持 .xlsx 或 .csv 文件。");
  }
  return parseLaunchSheetTable(table, preset, new Date(), undefined, options);
}

export async function downloadLaunchTemplate(
  options: { originalPostMigration?: boolean } = {},
): Promise<void> {
  const output = await createLaunchTemplateBuffer(options);
  const blob = new Blob([output as BlobPart], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = options.originalPostMigration
    ? "TK广告原帖迁移模板.xlsx"
    : "TK广告批量创建模板.xlsx";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * 只选择平台已经明确判定为失败的项目。
 *
 * unknown 可能已经被 TikTok 受理，只是等待回读；把它混进重导表会有重复创建风险。
 */
export function selectFailedLaunchRows(
  items: readonly Pick<LaunchPlanItemRecord, "status" | "launchRow">[],
): LaunchConfigurationRow[] {
  return items
    .filter((item) => item.status === "failed")
    .map((item) => item.launchRow);
}

export async function downloadFailedLaunchItems(
  items: readonly Pick<LaunchPlanItemRecord, "status" | "launchRow">[],
  options: { fileLabel?: string; now?: Date } = {},
): Promise<number> {
  const rows = selectFailedLaunchRows(items);
  if (rows.length === 0) throw new Error("当前计划没有可导出的明确失败项。");
  const output = await createFailedLaunchRowsBuffer(rows);
  const blob = new Blob([output as BlobPart], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  const label = sanitizeFileNamePart(options.fileLabel ?? "");
  anchor.download = `TK广告失败列表${label ? `-${label}` : ""}-${formatFileTimestamp(options.now ?? new Date())}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return rows.length;
}

/** 生成七列导入表格式的失败数据；修改后可直接从第一张工作表重新导入。 */
export async function createFailedLaunchRowsBuffer(
  rows: readonly LaunchConfigurationRow[],
): Promise<ArrayBuffer> {
  const { Workbook } = await loadExcelJs();
  const workbook = new Workbook();
  const worksheet = workbook.addWorksheet("失败列表", { views: [{ state: "frozen", ySplit: 1 }] });
  worksheet.addRow(launchSheetColumns.map((column) => column.label));
  rows.forEach((row, index) => {
    const excelRow = index + 2;
    worksheet.addRow([
      row.campaignName,
      row.adGroupName,
      row.videoCode,
      row.productUrl,
      (row.ageRanges?.length ? row.ageRanges : LaunchAgeRangeValues).join(";"),
      formatGender(row.gender),
      row.productCode ?? "",
    ]);
    worksheet.getCell(`F${excelRow}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"不限,男,女"'],
      showErrorMessage: true,
      errorTitle: "性别填写错误",
      error: "请选择不限、男或女。",
    };
  });
  worksheet.columns = LAUNCH_SHEET_WIDTHS.map((width) => ({ width }));
  styleHeader(worksheet.getRow(1));
  worksheet.autoFilter = { from: "A1", to: "G1" };
  worksheet.getColumn(3).alignment = { vertical: "middle", wrapText: true };
  worksheet.getColumn(4).alignment = { vertical: "middle", wrapText: true };
  worksheet.getColumn(5).alignment = { vertical: "middle", wrapText: true };
  worksheet.getColumn(6).alignment = { vertical: "middle", horizontal: "center" };
  const output = await workbook.xlsx.writeBuffer();
  return output as ArrayBuffer;
}

/** 生成可测试、可下载的工作簿内容；不会触发浏览器下载。 */
export async function createLaunchTemplateBuffer(
  options: { originalPostMigration?: boolean } = {},
): Promise<ArrayBuffer> {
  const { Workbook } = await loadExcelJs();
  const workbook = new Workbook();
  const input = workbook.addWorksheet("批量创建", { views: [{ state: "frozen", ySplit: 1 }] });
  input.addRow(launchSheetColumns.map((column) => column.label));
  for (let rowNumber = 2; rowNumber <= TEMPLATE_DATA_ROW_COUNT + 1; rowNumber += 1) {
    // 编码列（G）不预填：预填会让 500 行空白占位行看起来像有数据的行。
    input.addRow([null, null, null, null, DEFAULT_AGE_RANGES, "不限", null]);
    input.getCell(`F${rowNumber}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"不限,男,女"'],
      showErrorMessage: true,
      errorTitle: "性别填写错误",
      error: "请选择不限、男或女。",
    };
  }
  input.columns = LAUNCH_SHEET_WIDTHS.map((width) => ({ width }));
  styleHeader(input.getRow(1));
  input.autoFilter = { from: "A1", to: "G1" };
  input.getColumn(5).alignment = { vertical: "middle", wrapText: true };
  input.getColumn(6).alignment = { vertical: "middle", horizontal: "center" };

  const example = workbook.addWorksheet("填写示例");
  example.addRow(launchSheetColumns.map((column) => column.label));
  example.addRow([
    "夏季促销系列",
    "夏季广告组",
    options.originalPostMigration ? "" : "视频代码_001；视频代码_002",
    "https://example.com/product",
    DEFAULT_AGE_RANGES,
    "不限",
    "DM002451",
  ]);
  example.columns = LAUNCH_SHEET_WIDTHS.map((width) => ({ width }));
  styleHeader(example.getRow(1));
  example.getRow(2).alignment = { vertical: "middle", wrapText: true };

  const guide = workbook.addWorksheet("填写规范");
  guide.columns = [{ width: 20 }, { width: 90 }];
  guide.addRows([
    ["规则", "说明"],
    ["推广系列名称", "必填。同一行拆分出的多个视频代码共用此系列名称。"],
    ["广告组名称", "必填。同一行拆分出的多个视频代码共用此广告组名称。"],
    ["视频代码", options.originalPostMigration
      ? "原帖迁移无需填写。系统直接读取源广告组帖子，并按 item_id 核对目标账户。"
      : "普通创建必填。可填写一个代码，或用中文分号（；）、英文分号（;）或换行分隔多个代码；多个代码作为同一广告组的素材。"],
    ["产品 URL", "必填。必须以 http:// 或 https:// 开头；同一行拆分出的多个广告共用此 URL。只填到域名/商品页即可——创建时软件会自动在后面补上归因参数（utm_source/utm_medium/utm_id/utm_campaign），不用手填；已经带了 utm_source 的 URL 原样使用，不会重复拼。"],
    ["年龄", `每个广告组可单独设置。默认全选：${DEFAULT_AGE_RANGES}。多个年龄段用分号分隔；也可填“全部”或“不限”。`],
    ["性别", "每个广告组可单独设置。默认“不限”，可改为“男”或“女”。"],
    ["编码", "选填，不影响创建。只用于按品去重、跟品库对账、以及反查这一行属于哪个品。推广系列名称和广告组名称一律以表里填的为准，不会用编码去拼名字。"],
    ["广告预设", "普通创建的预算、出价、创建/结束时间和初始状态从所选广告预设读取；原帖迁移以目标账户配置为准。"],
    ["自动命名", "广告名称由软件自动生成：YYMMDD:XXX，例如 260716:001。"],
    ["安全限制", "单次最多 5000 条广告（一行有几个视频代码就算几条），且最多 500 行（一行 = 一个广告组）；创建结果以推广系列和广告组为主体，素材未生成时会跳过并在完成结果中提示。"],
  ]);
  styleHeader(guide.getRow(1));
  guide.eachRow((row) => { row.alignment = { vertical: "top", wrapText: true }; });

  const output = await workbook.xlsx.writeBuffer();
  return output as ArrayBuffer;
}

export function parseCsvTable(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(cell); cell = ""; }
    else if (character === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += character;
  }
  if (cell || row.length > 0) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

function styleHeader(row: { font: object; fill: object; alignment: object }): void {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111820" } };
  row.alignment = { vertical: "middle", horizontal: "center" };
}

function formatGender(gender: LaunchConfigurationRow["gender"]): string {
  return gender === "male" ? "男" : gender === "female" ? "女" : "不限";
}

function formatFileTimestamp(date: Date): string {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

function sanitizeFileNamePart(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/[. ]+$/g, "").slice(0, 48);
}

function extractCellValue(value: CellValue): unknown {
  if (value === null || value === undefined || typeof value !== "object" || value instanceof Date) return value;
  if ("result" in value) return value.result;
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("text" in value) return value.text;
  return String(value);
}
