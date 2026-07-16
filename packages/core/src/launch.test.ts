import { describe, expect, it } from "vitest";
import { automaticName, parseLaunchSheetTable } from "./launch.js";

const preset = {
  name: "测试预设",
  region: "US",
  dailyBudget: 100,
  bid: 1.25,
  startAt: null,
  endAt: null,
  initialStatus: "disabled" as const,
};

describe("parseLaunchSheetTable", () => {
  it("only accepts campaign and video-code columns, then applies the preset", () => {
    const result = parseLaunchSheetTable(
      [["推广系列名称", "广告组名称", "视频代码", "产品 URL"], ["夏季系列", "夏季广告组", "video-001", "https://example.com/product"]],
      preset,
      new Date("2026-07-16T09:00:00.000Z"),
    );

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([expect.objectContaining({
      campaignName: "夏季系列",
      videoCode: "video-001",
      productUrl: "https://example.com/product",
      adGroupName: "夏季广告组",
      adName: "260716:001",
      region: "US",
      dailyBudget: 100,
      bid: 1.25,
      initialStatus: "disabled",
    })]);
  });

  it("reports missing required columns and values", () => {
    const result = parseLaunchSheetTable([["推广系列名称", "广告组名称"], ["夏季系列", "夏季广告组"]], preset);
    expect(result.rows).toEqual([]);
    expect(result.errors.map((issue) => issue.field)).toContain("视频代码");
  });

  it("formats automatic names as YYMMDD:XXX", () => {
    expect(automaticName(new Date("2026-07-16T09:00:00.000Z"), 7)).toBe("260716:007");
  });
});
