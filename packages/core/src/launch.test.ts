import { describe, expect, it } from "vitest";
import { automaticName, LaunchCopyPreviewInputSchema, parseLaunchSheetTable, resolveLaunchStartAt } from "./launch.js";

describe("resolveLaunchStartAt", () => {
  const now = new Date("2026-07-23T09:15:00.000Z");

  it("keeps an absolute time unchanged", () => {
    expect(resolveLaunchStartAt("absolute", "2026-07-21T22:00:00.000Z", now)).toBe("2026-07-21T22:00:00.000Z");
    expect(resolveLaunchStartAt("absolute", null, now)).toBeNull();
    expect(resolveLaunchStartAt(undefined, "2026-07-21T22:00:00.000Z", now)).toBe("2026-07-21T22:00:00.000Z");
  });

  it("recomputes relative rules in the account timezone instead of the server timezone", () => {
    const tonight = resolveLaunchStartAt("tonight", "2026-01-01T00:00:00.000Z", now, "Asia/Taipei");
    const morning = resolveLaunchStartAt("tomorrow-morning", null, now, "Asia/Taipei");
    // At 17:15 in Taipei on July 23, the next local midnight/morning are
    // July 24 00:00 and 06:00 (UTC+8), independent of the test machine zone.
    expect(tonight).toBe("2026-07-23T16:00:00.000Z");
    expect(morning).toBe("2026-07-23T22:00:00.000Z");
  });
});

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

  it("keeps several video codes in one cell as one ad-group of several ads", () => {
    const result = parseLaunchSheetTable(
      [["推广系列名称", "广告组名称", "视频代码", "产品 URL"], ["夏季系列", "夏季广告组", "video-001； video-002;video-003", "https://example.com/product"]],
      preset,
      new Date("2026-07-16T09:00:00.000Z"),
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({ field: "视频代码" })]);
    // One row (one ad-group) whose cell holds all three codes; the create chain
    // later splits it into three ads under the same ad-group.
    expect(result.rows.map((row) => [row.videoCode, row.adGroupName, row.adName])).toEqual([
      ["video-001;video-002;video-003", "夏季广告组", "260716:001"],
    ]);
  });

  it("treats blank-campaign rows as extra ad-groups copying the block head's codes", () => {
    const result = parseLaunchSheetTable(
      [
        ["推广系列名称", "广告组名称", "视频代码", "产品 URL"],
        ["五代耳机_新", "五代耳机_新", "codeA;codeB", "https://muyyy.asia/a"],
        ["", "五代耳机_新1", "", ""],
        ["", "五代耳机_新2", "", ""],
        ["六代耳机_新", "六代耳机_新", "codeC;codeD", "https://muyyy.asia/b"],
        ["", "六代耳机_新1", "", ""],
      ],
      preset,
      new Date("2026-07-16T09:00:00.000Z"),
    );

    expect(result.errors).toEqual([]);
    // block 1: campaign 五代耳机_新 with 3 ad-groups, each carrying codeA+codeB
    const block1 = result.rows.filter((row) => row.campaignName === "五代耳机_新");
    expect(block1.map((row) => [row.adGroupName, row.videoCode, row.productUrl])).toEqual([
      ["五代耳机_新", "codeA;codeB", "https://muyyy.asia/a"],
      ["五代耳机_新1", "codeA;codeB", "https://muyyy.asia/a"],
      ["五代耳机_新2", "codeA;codeB", "https://muyyy.asia/a"],
    ]);
    // block 2: separate campaign inherits its own head codes/url
    const block2 = result.rows.filter((row) => row.campaignName === "六代耳机_新");
    expect(block2.map((row) => [row.adGroupName, row.videoCode, row.productUrl])).toEqual([
      ["六代耳机_新", "codeC;codeD", "https://muyyy.asia/b"],
      ["六代耳机_新1", "codeC;codeD", "https://muyyy.asia/b"],
    ]);
  });

  it("rejects a continuation row before any campaign head", () => {
    const result = parseLaunchSheetTable(
      [
        ["推广系列名称", "广告组名称", "视频代码", "产品 URL"],
        ["", "无头广告组", "", ""],
      ],
      preset,
    );
    expect(result.errors.map((issue) => issue.field)).toContain("推广系列名称");
  });

  it("lets a continuation row override the block head's codes when it fills them", () => {
    const result = parseLaunchSheetTable(
      [
        ["推广系列名称", "广告组名称", "视频代码", "产品 URL"],
        ["系列", "组1", "codeA", "https://example.com/a"],
        ["", "组2", "codeB", ""],
      ],
      preset,
      new Date("2026-07-16T09:00:00.000Z"),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows.map((row) => [row.adGroupName, row.videoCode, row.productUrl])).toEqual([
      ["组1", "codeA", "https://example.com/a"],
      ["组2", "codeB", "https://example.com/a"],
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
