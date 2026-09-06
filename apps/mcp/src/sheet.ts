import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";

/**
 * 把行数据渲染成导入页真吃得下的 .xlsx。
 *
 * 格式与「下载模板」逐项对齐（同样六列、性别下拉、同样的填写规范页）：人拿到这张表之后
 * 会直接在 Excel 里补视频代码再导入，样子不一样只会让他怀疑自己下错了文件。
 *
 * 渲染放在 MCP 这一侧，后台程序不引入 exceljs——它开机自启常驻，为一个偶尔用一次的导出
 * 把进程做重不划算。
 */

const DEFAULT_EXPORT_DIRECTORY_NAME = "TK Ads Automation 导出";

export interface SheetRow {
  campaignName: string;
  adGroupName: string;
  videoCode: string;
  productUrl: string;
  ageRanges: string;
  gender: string;
}

/** 默认导出目录：`下载\TK Ads Automation 导出`，人最容易找回来的地方。 */
export function defaultExportDirectory(): string {
  return process.env.TK_AUTO_MCP_EXPORT_DIR
    ?? join(homedir(), "Downloads", DEFAULT_EXPORT_DIRECTORY_NAME);
}

/** 文件名里不能出现的字符换成下划线，账户名里带斜杠或冒号是常事。 */
export function safeFileNamePart(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "账户";
}

export async function writeExpandSheet(input: {
  header: string[];
  rows: SheetRow[];
  filePath: string;
  /** 写进表头下方备注页，说明这批表是给谁扩的。 */
  note?: string;
}): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("批量创建", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.addRow(input.header);
  for (const row of input.rows) {
    sheet.addRow([
      row.campaignName,
      row.adGroupName,
      row.videoCode,
      row.productUrl,
      row.ageRanges,
      row.gender,
    ]);
  }
  sheet.columns = [
    { width: 32 }, { width: 30 }, { width: 28 }, { width: 45 }, { width: 48 }, { width: 12 },
  ];
  for (let rowNumber = 2; rowNumber <= input.rows.length + 1; rowNumber += 1) {
    sheet.getCell(`F${rowNumber}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"不限,男,女"'],
      showErrorMessage: true,
      errorTitle: "性别填写错误",
      error: "请选择不限、男或女。",
    };
    // 待填的视频代码整列标黄。一眼看得出还差什么，比在另一页写一段说明有用。
    sheet.getCell(`C${rowNumber}`).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFFF3C4" },
    };
  }
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111820" } };
  header.alignment = { vertical: "middle", horizontal: "center" };
  sheet.autoFilter = { from: "A1", to: "F1" };
  sheet.getColumn(5).alignment = { vertical: "middle", wrapText: true };
  sheet.getColumn(6).alignment = { vertical: "middle", horizontal: "center" };

  const guide = workbook.addWorksheet("填写规范");
  guide.columns = [{ width: 20 }, { width: 90 }];
  guide.addRows([
    ["规则", "说明"],
    ["视频代码", "本表唯一需要填写的列（已标黄）。一个广告组可填多个代码，用中文分号（；）、英文分号（;）或换行分隔。"],
    ["推广系列名称", "已按扩组的命名规则填好，请勿修改：改动后会与账户里的现有系列对不上，或与已占用的名称撞车。"],
    ["广告组名称", "已按「源组名-投放日期-时间-序号」生成并避开了账户内已有名称，请勿修改。"],
    ["产品 URL", "已沿用同一个品上次填写的值；留空的行需要补填，必须以 http:// 或 https:// 开头。"],
    ["年龄 / 性别", "已沿用上次的定向，可按需修改。"],
    ["导入方式", "填完视频代码后，在客户端「批量创建」页面选择广告预设并导入本文件。"],
    ...(input.note ? [["本批说明", input.note]] : []),
  ]);
  const guideHeader = guide.getRow(1);
  guideHeader.font = { bold: true, color: { argb: "FFFFFFFF" } };
  guideHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111820" } };
  guideHeader.alignment = { vertical: "middle", horizontal: "center" };
  guide.eachRow((row) => { row.alignment = { vertical: "top", wrapText: true }; });

  mkdirSync(join(input.filePath, ".."), { recursive: true });
  const buffer = await workbook.xlsx.writeBuffer();
  writeFileSync(input.filePath, Buffer.from(buffer as ArrayBuffer));
  return input.filePath;
}

/** 表格内容的 Markdown 预览，便于在对话里直接核对而不用先去开文件。 */
export function markdownPreview(header: string[], rows: SheetRow[], limit = 20): string {
  const escape = (value: string) => (value === "" ? "—" : value.replace(/\|/g, "\\|"));
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.slice(0, limit).map((row) => `| ${[
      row.campaignName,
      row.adGroupName,
      row.videoCode,
      row.productUrl,
      row.ageRanges,
      row.gender,
    ].map(escape).join(" | ")} |`),
  ];
  if (rows.length > limit) lines.push(`| … | 其余 ${rows.length - limit} 行见文件 | | | | |`);
  return lines.join("\n");
}
