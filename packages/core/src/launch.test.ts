import { describe, expect, it } from "vitest";
import { parseLaunchSheetTable } from "./launch.js";

describe("parseLaunchSheetTable", () => {
  it("accepts header aliases and inherits unchanged cells", () => {
    const result = parseLaunchSheetTable([
      ["任务", "系列名称", "广告组预算", "出价", "开始时间", "状态"],
      ["首批", "夏季系列", 100, "自动", "2026-07-16 09:00", "关闭"],
      ["第二批", "", "", 1.25, "", "开启"],
    ]);

    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]).toMatchObject({
      taskName: "第二批",
      campaignName: "夏季系列",
      dailyBudget: 100,
      bid: 1.25,
      initialStatus: "enabled",
    });
  });

  it("generates names and reports them as warnings", () => {
    const result = parseLaunchSheetTable([
      ["推广系列名称", "广告组日预算"],
      ["测试系列", 88],
    ]);

    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      adGroupName: "测试系列-广告组",
      adName: "测试系列-广告组-广告",
      initialStatus: "disabled",
    });
    expect(result.warnings).toHaveLength(2);
  });

  it("rejects missing required headers and invalid row values", () => {
    const result = parseLaunchSheetTable([
      ["广告名称", "广告组日预算", "结束时间", "创建时间"],
      ["无系列", -1, "2026-07-15 08:00", "2026-07-16 08:00"],
    ]);

    expect(result.rows).toEqual([]);
    expect(result.errors.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(["推广系列名称", "广告组日预算", "结束时间"]),
    );
  });
});
