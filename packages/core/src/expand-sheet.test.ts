import { describe, expect, it } from "vitest";
import { buildExpandSheetPlan, expandSheetTable, type ExpandSheetSource } from "./expand-sheet.js";
import { stripGeneratedNameSuffixes } from "./copy-naming.js";
import { parseLaunchSheetTable, type LaunchPresetInput } from "./launch.js";

const deliveryAt = new Date("2026-08-12T09:15:30.000Z");

const source = (over: Partial<ExpandSheetSource> = {}): ExpandSheetSource => ({
  sourceAdGroupId: "g1",
  sourceAdGroupName: "八寶茶",
  sourceCampaignId: "c1",
  sourceCampaignName: "八寶茶系列",
  productUrl: "https://example.com/tea",
  ageRanges: ["25-34", "18-24"],
  gender: "all",
  inheritedFrom: "launch-history",
  ...over,
});

const preset: LaunchPresetInput = {
  name: "默认预设",
  region: "台湾",
  dailyBudget: 30,
  bid: null,
  startAt: null,
  endAt: null,
  initialStatus: "enabled",
};

describe("扩组导入表命名", () => {
  it("组名按扩组的同一套规则生成：清洗后源名-MMDD-HHMMSS-序号", () => {
    const plan = buildExpandSheetPlan({
      sources: [source()],
      countPerSource: 2,
      deliveryAt,
      timeZone: "UTC",
      sameCampaign: true,
    });
    expect(plan.rows.map((row) => row.adGroupName)).toEqual([
      "八寶茶-0812-091530-1",
      "八寶茶-0812-091530-2",
    ]);
  });

  it("生成的名字能被后缀剥离认回源名——谱系判定靠这一点闭环", () => {
    // 换一套命名写法，从表里建出来的组会在谱系里被判成「原组」，
    // 等于把这个功能要解决的问题又造回去一遍。
    const plan = buildExpandSheetPlan({
      sources: [source({ sourceAdGroupName: "八寶茶-0805-143052-3" })],
      countPerSource: 1,
      deliveryAt,
      timeZone: "UTC",
      sameCampaign: true,
    });
    const generated = plan.rows[0]?.adGroupName ?? "";
    expect(generated).toBe("八寶茶-0812-091530-1");
    expect(stripGeneratedNameSuffixes(generated)).toBe("八寶茶");
  });

  it("洗出同名基名的两个源组不会撞名", () => {
    // 常见情形：两个源组本来就是同一个产品在不同档位扩出来的，旧后缀剥掉后完全一样。
    const plan = buildExpandSheetPlan({
      sources: [
        source({ sourceAdGroupId: "g1", sourceAdGroupName: "八寶茶-0805-143052-1" }),
        source({ sourceAdGroupId: "g2", sourceAdGroupName: "八寶茶-0806-101010-2" }),
      ],
      countPerSource: 1,
      deliveryAt,
      timeZone: "UTC",
      sameCampaign: true,
    });
    const names = plan.rows.map((row) => row.adGroupName);
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(["八寶茶-0812-091530-1", "八寶茶-0812-091531-1"]);
  });

  it("账户里已经占着的名字会被跳过", () => {
    const plan = buildExpandSheetPlan({
      sources: [source()],
      countPerSource: 1,
      deliveryAt,
      timeZone: "UTC",
      sameCampaign: true,
      existingAdGroupNames: new Set(["八寶茶-0812-091530-1"]),
    });
    expect(plan.rows[0]?.adGroupName).toBe("八寶茶-0812-091531-1");
  });

  it("同系列模式下系列名逐字原样，不清洗后缀", () => {
    // 现有系列必须精确匹配才能被复用，洗掉一个字就变成新建系列了。
    const plan = buildExpandSheetPlan({
      sources: [source({ sourceCampaignName: "八寶茶系列-0805-143052" })],
      countPerSource: 1,
      deliveryAt,
      timeZone: "UTC",
      sameCampaign: true,
    });
    expect(plan.rows[0]?.campaignName).toBe("八寶茶系列-0805-143052");
  });

  it("新建系列模式下给每个源组另起唯一系列名", () => {
    const plan = buildExpandSheetPlan({
      sources: [
        source({ sourceAdGroupId: "g1", sourceCampaignName: "八寶茶系列" }),
        source({ sourceAdGroupId: "g2", sourceCampaignName: "八寶茶系列" }),
      ],
      countPerSource: 1,
      deliveryAt,
      timeZone: "UTC",
      sameCampaign: false,
    });
    const names = plan.rows.map((row) => row.campaignName);
    expect(names).toEqual(["八寶茶系列-0812-091530", "八寶茶系列-0812-091531"]);
  });

  it("同系列模式撞上重名系列时明确告警", () => {
    // 账户里有两条同名系列时，按名复用无从判定该并入哪一条，创建会直接报错。
    const plan = buildExpandSheetPlan({
      sources: [source()],
      countPerSource: 1,
      deliveryAt,
      timeZone: "UTC",
      sameCampaign: true,
      duplicateCampaignNames: new Set(["八寶茶系列"]),
    });
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("八寶茶系列");
  });
});

describe("扩组导入表内容", () => {
  it("视频代码恒为空，其余列沿用源组的值", () => {
    const plan = buildExpandSheetPlan({
      sources: [source({ gender: "female", ageRanges: ["25-34", "18-24"] })],
      countPerSource: 1,
      deliveryAt,
      timeZone: "UTC",
      sameCampaign: true,
    });
    const row = plan.rows[0];
    expect(row?.videoCode).toBe("");
    expect(row?.productUrl).toBe("https://example.com/tea");
    // 年龄按枚举顺序输出，不按传入顺序——乱序会让人以为填错了。
    expect(row?.ageRanges).toBe("18-24;25-34");
    expect(row?.gender).toBe("女");
    expect(row?.inheritedFrom).toBe("launch-history");
  });

  it("没给年龄性别时按全选和不限填", () => {
    const plan = buildExpandSheetPlan({
      sources: [source({ ageRanges: null, gender: null })],
      countPerSource: 1,
      deliveryAt,
      timeZone: "UTC",
      sameCampaign: true,
    });
    expect(plan.rows[0]?.ageRanges).toBe("18-24;25-34;35-44;45-54;55-100");
    expect(plan.rows[0]?.gender).toBe("不限");
  });

  it("落地页取不到时点名哪一行要人补", () => {
    const plan = buildExpandSheetPlan({
      sources: [
        source({ sourceAdGroupId: "g1", productUrl: null, inheritedFrom: null }),
        source({ sourceAdGroupId: "g2", sourceAdGroupName: "隨身wifi" }),
      ],
      countPerSource: 1,
      deliveryAt,
      timeZone: "UTC",
      sameCampaign: true,
    });
    expect(plan.incomplete).toEqual([
      { rowNumber: 2, adGroupName: "八寶茶-0812-091530-1", missing: ["产品 URL"] },
    ]);
  });

  it("表头与批量创建模板一致", () => {
    const plan = buildExpandSheetPlan({
      sources: [source()],
      countPerSource: 1,
      deliveryAt,
      timeZone: "UTC",
      sameCampaign: true,
    });
    expect(plan.header).toEqual([
      "推广系列名称", "广告组名称", "视频代码", "产品 URL", "年龄", "性别", "编码",
    ]);
  });

  it("编码原样写进表，取不到时留空", () => {
    const plan = buildExpandSheetPlan({
      sources: [
        source({ sourceAdGroupId: "g1", productCode: "DM002451" }),
        source({ sourceAdGroupId: "g2", sourceAdGroupName: "隨身wifi" }),
      ],
      countPerSource: 1,
      deliveryAt,
      timeZone: "UTC",
      sameCampaign: true,
    });
    expect(plan.rows.map((row) => row.productCode)).toEqual(["DM002451", ""]);
    // 编码只是识别列：填了编码的那行和没填的那行，名字按同一套规则算出来，
    // 编码既不进名字、也不改变名字。
    expect(plan.rows.map((row) => row.adGroupName)).toEqual([
      "八寶茶-0812-091530-1",
      "隨身wifi-0812-091530-1",
    ]);
  });
});

describe("回读闭环", () => {
  it("补上视频代码后，导入页能原样解析这张表", () => {
    // 生成的表必须是导入页真吃得下的表，不能只是「看着像」。
    const plan = buildExpandSheetPlan({
      sources: [
        source({ sourceAdGroupId: "g1", gender: "male", ageRanges: ["25-34"] }),
        source({ sourceAdGroupId: "g2", sourceAdGroupName: "隨身wifi", sourceCampaignName: "wifi系列" }),
      ],
      countPerSource: 2,
      deliveryAt,
      timeZone: "UTC",
      sameCampaign: true,
    });
    const table = expandSheetTable(plan).map((row, index) =>
      index === 0 ? row : row.map((cell, column) => (column === 2 ? "视频代码_001" : cell)),
    );

    const result = parseLaunchSheetTable(table, preset, deliveryAt);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]?.campaignName).toBe("八寶茶系列");
    expect(result.rows[0]?.adGroupName).toBe("八寶茶-0812-091530-1");
    expect(result.rows[0]?.gender).toBe("male");
    expect(result.rows[0]?.ageRanges).toEqual(["25-34"]);
    expect(result.rows[2]?.adGroupName).toBe("隨身wifi-0812-091530-1");
  });

  it("视频代码没补时导入页会逐行报错——表本身仍然是合法结构", () => {
    const plan = buildExpandSheetPlan({
      sources: [source()],
      countPerSource: 1,
      deliveryAt,
      timeZone: "UTC",
      sameCampaign: true,
    });
    const result = parseLaunchSheetTable(expandSheetTable(plan), preset, deliveryAt);
    // 报的必须是「视频代码」这一列，而不是表头缺失或整表读不出来。
    expect(result.errors.map((issue) => issue.field)).toEqual(["视频代码"]);
  });
});
