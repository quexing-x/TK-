import { describe, expect, it } from "vitest";
import { parseCsvTable, readLaunchSpreadsheet } from "./launch-sheet.js";

describe("parseCsvTable", () => {
  it("handles commas, escaped quotes and line breaks inside quoted cells", () => {
    expect(parseCsvTable('\uFEFF任务名称,推广系列名称\r\n"任务,一","夏季""系列"\r\n')).toEqual([
      ["任务名称", "推广系列名称"],
      ["任务,一", '夏季"系列'],
    ]);
  });

  it("reads the first worksheet of an xlsx file", async () => {
    const { Workbook } = await import("exceljs");
    const workbook = new Workbook();
    const worksheet = workbook.addWorksheet("批量创建");
    worksheet.addRow(["推广系列名称", "广告组日预算", "出价", "初始状态"]);
    worksheet.addRow(["测试系列", 120, "自动", "关闭"]);
    const buffer = await workbook.xlsx.writeBuffer();
    const file = new File([buffer as BlobPart], "测试.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    const result = await readLaunchSpreadsheet(file);

    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ campaignName: "测试系列", dailyBudget: 120, bid: null });
  });
});
