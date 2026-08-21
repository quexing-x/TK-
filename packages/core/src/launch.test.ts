import { describe, expect, it } from "vitest";
import { automaticName, LaunchCopyPreviewInputSchema, LaunchMigrationTargetConfigSchema, parseLaunchSheetTable, resolveLaunchStartAt, resolveMigrationStartAt } from "./launch.js";

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

describe("resolveMigrationStartAt", () => {
  it("uses the nearest future 06:00 in the target account timezone", () => {
    expect(resolveMigrationStartAt("next-six", null, new Date("2026-07-26T16:30:00.000Z"), "Asia/Taipei"))
      .toBe("2026-07-26T22:00:00.000Z"); // July 27 00:30 -> July 27 06:00
    expect(resolveMigrationStartAt("next-six", null, new Date("2026-07-26T15:30:00.000Z"), "Asia/Taipei"))
      .toBe("2026-07-26T22:00:00.000Z"); // July 26 23:30 -> July 27 06:00
    expect(resolveMigrationStartAt("next-six", null, new Date("2026-07-26T23:00:00.000Z"), "Asia/Taipei"))
      .toBe("2026-07-27T22:00:00.000Z"); // July 27 07:00 -> July 28 06:00
  });
});

describe("LaunchMigrationTargetConfigSchema", () => {
  it("defaults original-post migration to enabled for old and new clients", () => {
    expect(LaunchMigrationTargetConfigSchema.parse({
      accountId: "target",
      quantity: 1,
      dailyBudget: 100,
      bid: null,
      startAtRule: "absolute",
      startAt: null,
    }).initialStatus).toBe("enabled");
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
  it("keeps old four-column sheets compatible and defaults targeting to unrestricted", () => {
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
      ageRanges: ["13-17", "18-24", "25-34", "35-44", "45-54", "55-100"],
      gender: "all",
      dailyBudget: 100,
      bid: 1.25,
      initialStatus: "disabled",
    })]);
  });

  it("imports age and gender independently for each ad-group row", () => {
    const result = parseLaunchSheetTable([
      ["推广系列名称", "广告组名称", "视频代码", "产品 URL", "年龄", "性别"],
      ["系列", "女性组", "video-1", "https://example.com/1", "25-34；35-44；55+", "女"],
      ["", "男性组", "video-2", "", "18-24;25-34", "男"],
    ], preset, new Date("2026-07-16T09:00:00.000Z"));

    expect(result.errors).toEqual([]);
    expect(result.rows.map((row) => ({
      name: row.adGroupName,
      ageRanges: row.ageRanges,
      gender: row.gender,
    }))).toEqual([
      { name: "女性组", ageRanges: ["25-34", "35-44", "55-100"], gender: "female" },
      { name: "男性组", ageRanges: ["18-24", "25-34"], gender: "male" },
    ]);
  });

  it("ignores template placeholder rows that only contain targeting defaults", () => {
    const result = parseLaunchSheetTable([
      ["推广系列名称", "广告组名称", "视频代码", "产品 URL", "年龄", "性别"],
      ["", "", "", "", "13-17;18-24;25-34;35-44;45-54;55-100", "不限"],
    ], preset);

    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      { rowNumber: 2, field: "数据", message: "没有可导入的任务行。" },
    ]);
  });

  it("rejects unsupported per-row targeting values", () => {
    const result = parseLaunchSheetTable([
      ["推广系列名称", "广告组名称", "视频代码", "产品 URL", "年龄", "性别"],
      ["系列", "广告组", "video", "https://example.com", "20-30", "其他"],
    ], preset);

    expect(result.rows).toEqual([]);
    expect(result.errors.map((issue) => issue.field)).toEqual(["年龄", "性别"]);
  });

  it("reports missing required columns and values", () => {
    const result = parseLaunchSheetTable([["推广系列名称", "广告组名称"], ["夏季系列", "夏季广告组"]], preset);
    expect(result.rows).toEqual([]);
    expect(result.errors.map((issue) => issue.field)).toContain("视频代码");
  });

  it("allows an empty video-code cell only for original-post migration", () => {
    const table = [
      ["推广系列名称", "广告组名称", "视频代码", "产品 URL"],
      ["迁移系列", "迁移广告组", "", "https://example.com/product"],
    ];
    const normal = parseLaunchSheetTable(table, preset);
    const migration = parseLaunchSheetTable(
      table,
      preset,
      new Date("2026-07-16T09:00:00.000Z"),
      undefined,
      { requireVideoCode: false },
    );
    expect(normal.errors.map((issue) => issue.field)).toContain("视频代码");
    expect(migration.errors).toEqual([]);
    expect(migration.rows[0]?.videoCode).toBe("");
  });

  it("keeps several video codes in one cell as one ad-group of several ads", () => {
    const result = parseLaunchSheetTable(
      [["推广系列名称", "广告组名称", "视频代码", "产品 URL"], ["夏季系列", "夏季广告组", "video-001； video-002;video-003", "https://example.com/product"]],
      preset,
      new Date("2026-07-16T09:00:00.000Z"),
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
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

  it("imports a 一组多广告 group whose joined video codes exceed 512 chars", () => {
    // 30 codes of ~30 chars each join to ~900 chars — a legitimate multi-ad
    // group that the old single-code 512 cap wrongly rejected.
    const codes = Array.from({ length: 30 }, (_unused, i) => `spark-auth-code-${String(i).padStart(12, "0")}`);
    expect(codes.join(";").length).toBeGreaterThan(512);
    const result = parseLaunchSheetTable(
      [
        ["推广系列名称", "广告组名称", "视频代码", "产品 URL"],
        ["系列", "多广告组", codes.join(";"), "https://example.com/p"],
      ],
      preset,
      new Date("2026-07-16T09:00:00.000Z"),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.videoCode).toBe(codes.join(";"));
    expect(result.warnings).toEqual([]);
  });

  it("formats automatic names as YYMMDD:XXX", () => {
    expect(automaticName(new Date("2026-07-16T09:00:00.000Z"), 7)).toBe("260716:007");
  });

  it("caps one copy preview at 100 generated ad groups", () => {
    const row = parseLaunchSheetTable(
      [["推广系列名称", "广告组名称", "视频代码", "产品 URL"], ["系列", "组", "video-1", "https://example.com/product"]],
      preset,
    ).rows[0]!;
    expect(() => LaunchCopyPreviewInputSchema.parse({
      sourceAccountId: "source",
      sourceAdGroupId: "source-ad",
      targetAccountIds: ["a"],
      launchPresetId: "preset",
      launchRows: [],
      targetConfigs: [{ accountId: "a", quantity: 20, dailyBudget: 100, bid: null, startAtRule: "absolute", startAt: null }],
    })).not.toThrow();
    expect(() => LaunchCopyPreviewInputSchema.parse({
      sourceAccountId: "source",
      sourceAdGroupId: "source-ad",
      targetAccountIds: ["a", "b", "c", "d", "e", "f"],
      launchPresetId: "preset",
      launchRows: [row],
      targetConfigs: ["a", "b", "c", "d", "e", "f"].map((accountId) => ({ accountId, quantity: 20, dailyBudget: 100, bid: null, startAtRule: "absolute", startAt: null })),
    })).toThrow();
  });
});
