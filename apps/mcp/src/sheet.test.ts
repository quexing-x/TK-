import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import {
  buildExpandSheetPlan,
  parseLaunchSheetTable,
  type LaunchPresetInput,
} from "@tk-auto/core";
import { markdownPreview, safeFileNamePart, writeExpandSheet, type SheetRow } from "./sheet.js";

const preset: LaunchPresetInput = {
  name: "回读预设",
  region: "台湾",
  dailyBudget: 30,
  bid: null,
  startAt: null,
  endAt: null,
  initialStatus: "enabled",
};

/** 按导入页的同一条路径把 .xlsx 读成二维表。 */
async function readSheetTable(filePath: string): Promise<{
  sheetNames: string[];
  table: unknown[][];
}> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("没有工作表");
  const table: unknown[][] = [];
  const width = Math.max(worksheet.actualColumnCount, worksheet.columnCount);
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const values: unknown[] = [];
    for (let column = 1; column <= width; column += 1) {
      const value = row.getCell(column).value;
      values.push(
        value && typeof value === "object" && "text" in value
          ? (value as { text: string }).text
          : value,
      );
    }
    table.push(values);
  });
  return { sheetNames: workbook.worksheets.map((sheet) => sheet.name), table };
}

describe("导入表回读闭环", () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "tk-sheet-"));
    filePath = join(directory, "扩组导入表.xlsx");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const plan = () => buildExpandSheetPlan({
    sources: [
      {
        sourceAdGroupId: "g1",
        sourceAdGroupName: "八寶茶",
        sourceCampaignId: "c1",
        sourceCampaignName: "八寶茶系列",
        productUrl: "https://shop.example.com/babaocha",
        ageRanges: ["25-34", "35-44"],
        gender: "female",
        inheritedFrom: "launch-history",
      },
      {
        sourceAdGroupId: "g3",
        sourceAdGroupName: "隨身wifi",
        sourceCampaignId: "c2",
        sourceCampaignName: "wifi系列",
        productUrl: "https://shop.example.com/wifi",
        ageRanges: null,
        gender: null,
        inheritedFrom: null,
      },
    ],
    countPerSource: 2,
    deliveryAt: new Date("2026-08-12T09:15:30.000Z"),
    timeZone: "UTC",
    sameCampaign: true,
  });

  const rowsOf = (): SheetRow[] => plan().rows.map((row) => ({
    campaignName: row.campaignName,
    adGroupName: row.adGroupName,
    videoCode: row.videoCode,
    productUrl: row.productUrl,
    ageRanges: row.ageRanges,
    gender: row.gender,
  }));

  it("写出来的 xlsx 补上视频代码后导入页能原样解析", async () => {
    // 这条断言是这个功能的地基：生成的表必须是导入页真吃得下的表，不能只是「看着像」。
    // 只在内存里比对二维数组会漏掉 exceljs 写入环节引入的问题（富文本单元格、空行、列错位）。
    await writeExpandSheet({ header: plan().header, rows: rowsOf(), filePath });
    const { table } = await readSheetTable(filePath);

    const filled = table.map((row, index) =>
      index === 0 ? row : row.map((cell, column) => (column === 2 ? "新代码_001" : cell)));
    const parsed = parseLaunchSheetTable(filled, preset);

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.rows[0]).toMatchObject({
      campaignName: "八寶茶系列",
      adGroupName: "八寶茶-0812-091530-1",
      productUrl: "https://shop.example.com/babaocha",
      gender: "female",
      ageRanges: ["25-34", "35-44"],
    });
    expect(parsed.rows[2]?.adGroupName).toBe("隨身wifi-0812-091530-1");
  });

  it("视频代码没补时报的是那一列，而不是表头读不出来", async () => {
    await writeExpandSheet({ header: plan().header, rows: rowsOf(), filePath });
    const { table } = await readSheetTable(filePath);

    const parsed = parseLaunchSheetTable(table, preset);

    expect([...new Set(parsed.errors.map((issue) => issue.field))]).toEqual(["视频代码"]);
  });

  it("带上填写规范页，且第一张表就是数据表", async () => {
    await writeExpandSheet({ header: plan().header, rows: rowsOf(), filePath, note: "本批说明" });
    const { sheetNames, table } = await readSheetTable(filePath);

    expect(sheetNames).toEqual(["批量创建", "填写规范"]);
    expect(table[0]).toEqual(["推广系列名称", "广告组名称", "视频代码", "产品 URL", "年龄", "性别"]);
  });
});

describe("导出辅助", () => {
  it("文件名里的非法字符换成下划线", () => {
    expect(safeFileNamePart("账户/A:B")).toBe("账户_A_B");
    expect(safeFileNamePart("   ")).toBe("账户");
  });

  it("Markdown 预览把空单元格写成破折号，超出部分折叠", () => {
    const rows: SheetRow[] = Array.from({ length: 3 }, (_unused, index) => ({
      campaignName: "系列",
      adGroupName: `组${index}`,
      videoCode: "",
      productUrl: "https://example.com",
      ageRanges: "18-24",
      gender: "不限",
    }));
    const preview = markdownPreview(["A", "B", "C", "D", "E", "F"], rows, 2);
    expect(preview).toContain("| 系列 | 组0 | — | https://example.com | 18-24 | 不限 |");
    expect(preview).toContain("其余 1 行见文件");
  });
});
