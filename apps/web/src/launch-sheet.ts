import type { CellValue } from "exceljs";
import {
  launchSheetColumns,
  parseLaunchSheetTable,
  type LaunchSheetImportResult,
} from "@tk-auto/core";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function readLaunchSpreadsheet(file: File): Promise<LaunchSheetImportResult> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  let table: unknown[][];
  if (extension === "csv") {
    table = parseCsvTable(await file.text());
  } else if (extension === "xlsx") {
    const { Workbook } = await import("exceljs");
    const workbook = new Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error("Excel 文件中没有工作表。");
    table = [];
    const width = Math.max(worksheet.actualColumnCount, worksheet.columnCount);
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      const values: unknown[] = [];
      for (let column = 1; column <= width; column += 1) {
        values.push(extractCellValue(row.getCell(column).value));
      }
      table.push(values);
    });
  } else {
    throw new Error("仅支持 .xlsx 或 .csv 文件。");
  }
  return parseLaunchSheetTable(table);
}

export async function downloadLaunchTemplate(): Promise<void> {
  const { Workbook } = await import("exceljs");
  const workbook = new Workbook();
  workbook.creator = "TK Ads Automation";
  workbook.created = new Date();
  const input = workbook.addWorksheet("批量创建", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  input.addRow(launchSheetColumns.map((column) => column.label));
  input.columns = [
    { width: 18 }, { width: 24 }, { width: 24 }, { width: 24 },
    { width: 16 }, { width: 12 }, { width: 22 }, { width: 22 }, { width: 14 },
  ];
  const header = input.getRow(1);
  header.height = 28;
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.alignment = { vertical: "middle", horizontal: "center" };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111820" } };
  header.eachCell((cell, columnNumber) => {
    cell.border = { bottom: { style: "thin", color: { argb: columnNumber % 2 ? "FF25F4EE" : "FFFE2C55" } } };
  });
  input.autoFilter = { from: "A1", to: "I1" };
  input.getColumn(5).numFmt = "0.00";
  input.getColumn(6).numFmt = "0.00";
  input.getColumn(7).numFmt = "yyyy-mm-dd hh:mm";
  input.getColumn(8).numFmt = "yyyy-mm-dd hh:mm";
  for (let row = 2; row <= 501; row += 1) {
    input.getCell(row, 9).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"关闭,开启"'],
    };
  }

  const example = workbook.addWorksheet("填写示例");
  example.addRow(launchSheetColumns.map((column) => column.label));
  example.addRow(["首批", "夏季系列", "夏季组", "素材A", 100, "自动", "2026-07-16 09:00", "", "关闭"]);
  example.addRow(["第二条", "", "", "素材B", "", 1.2, "", "", ""]);
  example.columns = input.columns.map((column) => ({ width: column.width ?? 12 }));
  example.getRow(1).font = { bold: true };

  const guide = workbook.addWorksheet("填写规范");
  guide.columns = [{ width: 20 }, { width: 92 }];
  guide.addRows([
    ["规则", "说明"],
    ["账户与源广告", "不写入表格。在软件中选择一次源账户、源广告和全部目标账户，应用到本次所有任务。"],
    ["必填", "第一条数据必须填写推广系列名称和广告组日预算；预算必须大于 0。"],
    ["空白继承", "推广系列、广告组、广告名称、预算、出价、创建/结束时间、初始状态留空时，继承上一条非空值。"],
    ["自动命名", "广告组或广告名称在第一条中留空时，软件按“系列-广告组-广告”生成名称。"],
    ["自动出价", "出价留空或填写“自动”表示自动出价；数字表示手动出价。"],
    ["时间", "推荐格式：2026-07-16 09:00。结束时间必须晚于创建时间；均留空表示保存后由执行器立即创建。"],
    ["初始状态", "支持“开启”或“关闭”，留空默认关闭。"],
    ["安全限制", "单次最多 500 条。导入只解析和保存计划；未接入真实创建接口时不会写入 TikTok。"],
  ]);
  guide.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  guide.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111820" } };
  guide.eachRow((row) => { row.alignment = { vertical: "top", wrapText: true }; });

  const output = await workbook.xlsx.writeBuffer();
  const blob = new Blob([output as BlobPart], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "TK广告批量创建模板.xlsx";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function extractCellValue(value: CellValue): unknown {
  if (value === null || value === undefined || typeof value !== "object" || value instanceof Date) return value;
  if ("result" in value) return value.result;
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("text" in value) return value.text;
  return String(value);
}
