import { afterEach, describe, expect, it, vi } from "vitest";
import { createLaunchTemplateBuffer, downloadLaunchTemplate, parseCsvTable, readLaunchSpreadsheet } from "./launch-sheet.js";

const preset = { name: "测试预设", region: "US", dailyBudget: 120, bid: null, startAt: null, endAt: null, initialStatus: "disabled" as const };

describe("launch spreadsheet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles commas, escaped quotes and line breaks inside quoted cells", () => {
    expect(parseCsvTable('\uFEFF推广系列名称,广告组名称,视频代码\r\n"系列,一",广告组,video-001\r\n')).toEqual([
      ["推广系列名称", "广告组名称", "视频代码"],
      ["系列,一", "广告组", "video-001"],
    ]);
  });

  // 整仓并行跑时这条会偶发超时（实测 6.8s / 9.0s，单跑该包只要 1.3s）：它要动态加载
  // 930KB 的 exceljs，多个测试进程同时抢 CPU 与磁盘时，5 秒的默认上限不够用。
  // 超时和真实回归长得一模一样，会掩盖真问题，所以按最慢一次的三倍给足余量。
  it("reads the first worksheet and applies the selected preset", { timeout: 30_000 }, async () => {
    const { Workbook } = await import("exceljs");
    const workbook = new Workbook();
    const worksheet = workbook.addWorksheet("批量创建");
    worksheet.addRow(["推广系列名称", "广告组名称", "视频代码", "产品 URL"]);
    worksheet.addRow(["测试系列", "测试广告组", "video-001", "https://example.com/product"]);
    const buffer = await workbook.xlsx.writeBuffer();
    const file = new File([buffer as BlobPart], "测试.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    const result = await readLaunchSpreadsheet(file, preset);

    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      campaignName: "测试系列",
      adGroupName: "测试广告组",
      videoCode: "video-001",
      productUrl: "https://example.com/product",
      region: "US",
      dailyBudget: 120,
      bid: null,
      // 模板预填 18 岁以上：Smart+ 系列禁止向 18 岁以下投放。
      ageRanges: ["18-24", "25-34", "35-44", "45-54", "55-100"],
      gender: "all",
    });
  });
  it("builds 500 editable rows with 18+ ages and unrestricted gender prefilled", async () => {
    const { Workbook } = await import("exceljs");
    const workbook = new Workbook();
    await workbook.xlsx.load(await createLaunchTemplateBuffer());
    const worksheet = workbook.getWorksheet("批量创建")!;

    expect(worksheet.getRow(1).values).toEqual([
      undefined,
      "推广系列名称",
      "广告组名称",
      "视频代码",
      "产品 URL",
      "年龄",
      "性别",
    ]);
    expect(worksheet.rowCount).toBe(501);
    expect(worksheet.getCell("E2").value).toBe("18-24;25-34;35-44;45-54;55-100");
    expect(worksheet.getCell("F2").value).toBe("不限");
    expect(worksheet.getCell("E501").value).toBe("18-24;25-34;35-44;45-54;55-100");
    expect(worksheet.getCell("F501").value).toBe("不限");
    expect(worksheet.getCell("F2").dataValidation.formulae).toEqual(['"不限,男,女"']);
    expect(workbook.getWorksheet("填写示例")?.getRow(2).values).toEqual([
      undefined,
      "夏季促销系列",
      "夏季广告组",
      "视频代码_001；视频代码_002",
      "https://example.com/product",
      "18-24;25-34;35-44;45-54;55-100",
      "不限",
    ]);
  });
  it("downloads a populated workbook template", async () => {
    const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    const appendChild = vi.fn();
    const createObjectURL = vi.fn(() => "blob:launch-template");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor), body: { appendChild } });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    await downloadLaunchTemplate();

    expect(anchor.download).toBe("TK广告批量创建模板.xlsx");
    expect(anchor.href).toBe("blob:launch-template");
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:launch-template");
  });
});
