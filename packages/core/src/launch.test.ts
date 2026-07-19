import { describe, expect, it } from "vitest";
import { automaticName, LaunchCopyPreviewInputSchema, parseLaunchSheetTable } from "./launch.js";

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

  it("splits several video codes in one cell into separately named ads", () => {
    const result = parseLaunchSheetTable(
      [["推广系列名称", "广告组名称", "视频代码", "产品 URL"], ["夏季系列", "夏季广告组", "video-001； video-002;video-003", "https://example.com/product"]],
      preset,
      new Date("2026-07-16T09:00:00.000Z"),
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({ field: "视频代码" })]);
    expect(result.rows.map((row) => [row.videoCode, row.adName])).toEqual([
      ["video-001", "260716:001"],
      ["video-002", "260716:002"],
      ["video-003", "260716:003"],
    ]);
  });

  it("formats automatic names as YYMMDD:XXX", () => {
    expect(automaticName(new Date("2026-07-16T09:00:00.000Z"), 7)).toBe("260716:007");
  });

  it("caps one copy preview at three controlled target accounts and rows", () => {
    const row = parseLaunchSheetTable(
      [["推广系列名称", "广告组名称", "视频代码", "产品 URL"], ["系列", "组", "video-1", "https://example.com/product"]],
      preset,
    ).rows[0]!;
    expect(() => LaunchCopyPreviewInputSchema.parse({
      sourceAccountId: "source",
      sourceAdId: "source-ad",
      targetAccountIds: ["a", "b", "c", "d"],
      launchPresetId: "preset",
      launchRows: [row],
    })).toThrow();
    expect(() => LaunchCopyPreviewInputSchema.parse({
      sourceAccountId: "source",
      sourceAdId: "source-ad",
      targetAccountIds: ["a"],
      launchPresetId: "preset",
      launchRows: [row, row, row, row],
    })).toThrow();
  });
});
