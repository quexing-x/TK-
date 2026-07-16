import { describe, expect, it } from "vitest";
import { parseCsvTable, readLaunchSpreadsheet } from "./launch-sheet.js";

const preset = { name: "测试预设", region: "US", dailyBudget: 120, bid: null, startAt: null, endAt: null, initialStatus: "disabled" as const };

describe("launch spreadsheet", () => {
  it("handles commas, escaped quotes and line breaks inside quoted cells", () => {
    expect(parseCsvTable('\uFEFF推广系列名称,广告组名称,视频代码\r\n"系列,一",广告组,video-001\r\n')).toEqual([
      ["推广系列名称", "广告组名称", "视频代码"],
      ["系列,一", "广告组", "video-001"],
    ]);
  });

  it("reads the first worksheet and applies the selected preset", async () => {
    const { Workbook } = await import("exceljs");
    const workbook = new Workbook();
    const worksheet = workbook.addWorksheet("批量创建");
    worksheet.addRow(["推广系列名称", "广告组名称", "视频代码", "产品 URL"]);
    worksheet.addRow(["测试系列", "测试广告组", "video-001", "https://example.com/product"]);
    const buffer = await workbook.xlsx.writeBuffer();
    const file = new File([buffer as BlobPart], "测试.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    const result = await readLaunchSpreadsheet(file, preset);

    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ campaignName: "测试系列", adGroupName: "测试广告组", videoCode: "video-001", productUrl: "https://example.com/product", region: "US", dailyBudget: 120, bid: null });
  });
});
