import { describe, expect, it } from "vitest";
import {
  DuplicateNameError,
  assertCampaignNameAvailable,
  nextNameSerial,
  planGeneratedNames,
  stripGeneratedNameSuffixes,
  truncateGeneratedName,
} from "./copy-naming.js";

const at = new Date("2026-07-30T12:00:00.000Z");

describe("planGeneratedNames", () => {
  it("生成 {源名}-{MMDD}-{序号}", () => {
    const plan = planGeneratedNames({ sourceName: "夏季系列", count: 2, at, timeZone: "UTC" });
    expect(plan.baseName).toBe("夏季系列-0730");
    expect(plan.names).toEqual(["夏季系列-0730-1", "夏季系列-0730-2"]);
  });

  it("序号从账户已有名称往后接，而不是固定从 1 开始", () => {
    const plan = planGeneratedNames({
      sourceName: "夏季系列",
      count: 2,
      at,
      timeZone: "UTC",
      existingNames: ["夏季系列-0730-1", "夏季系列-0730-2", "无关系列"],
    });
    expect(plan.names).toEqual(["夏季系列-0730-3", "夏季系列-0730-4"]);
  });

  it("同一天重复扩量不会撞上第一次生成的名字", () => {
    const first = planGeneratedNames({ sourceName: "夏季系列", count: 2, at, timeZone: "UTC" });
    const second = planGeneratedNames({
      sourceName: "夏季系列",
      count: 2,
      at,
      timeZone: "UTC",
      existingNames: first.names,
    });
    expect(second.names.some((name) => first.names.includes(name))).toBe(false);
  });

  it("对已生成的名字再次扩量时清洗掉旧后缀，不会累积", () => {
    const plan = planGeneratedNames({
      sourceName: "夏季系列-0730-1",
      count: 1,
      at: new Date("2026-07-31T12:00:00.000Z"),
      timeZone: "UTC",
    });
    expect(plan.names).toEqual(["夏季系列-0731-1"]);
  });

  it("跳过用户手工起的同名对象", () => {
    const plan = planGeneratedNames({
      sourceName: "夏季系列",
      count: 2,
      at,
      timeZone: "UTC",
      existingNames: ["夏季系列-0730-2"],
    });
    // 已有最大序号是 2，从 3 起编。
    expect(plan.names).toEqual(["夏季系列-0730-3", "夏季系列-0730-4"]);
  });

  it("本批次预留的名称参与去重", () => {
    const plan = planGeneratedNames({
      sourceName: "夏季系列",
      count: 1,
      at,
      timeZone: "UTC",
      reservedNames: ["夏季系列-0730-1", "夏季系列-0730-2"],
    });
    expect(plan.names).toEqual(["夏季系列-0730-3"]);
  });

  it("像型号一样的四位数字不会被误当成日期清洗掉", () => {
    const plan = planGeneratedNames({ sourceName: "耳机2024", count: 1, at, timeZone: "UTC" });
    expect(plan.names).toEqual(["耳机2024-0730-1"]);
  });
});

describe("nextNameSerial", () => {
  it("空账户从 1 起编", () => {
    expect(nextNameSerial([], "A", "0730")).toBe(1);
  });

  it("只认同前缀同日期的序号", () => {
    expect(nextNameSerial(["A-0730-5", "A-0731-9", "B-0730-7"], "A", "0730")).toBe(6);
  });

  it("忽略非序号后缀", () => {
    expect(nextNameSerial(["A-0730-abc", "A-0730-0"], "A", "0730")).toBe(1);
  });
});

describe("truncateGeneratedName", () => {
  it("超长时保留尾部的日期与序号", () => {
    const long = `${"名".repeat(600)}-0730-12`;
    const truncated = truncateGeneratedName(long);
    expect(truncated.length).toBe(512);
    expect(truncated.endsWith("-0730-12")).toBe(true);
  });

  it("未超长时原样返回", () => {
    expect(truncateGeneratedName("A-0730-1")).toBe("A-0730-1");
  });
});

describe("assertCampaignNameAvailable", () => {
  it("账户内已有同名系列时在发请求前拦下", () => {
    expect(() => assertCampaignNameAvailable(["夏季系列-0730-1"], "夏季系列-0730-1"))
      .toThrow(DuplicateNameError);
  });

  it("本批次预留重名同样拦下", () => {
    expect(() => assertCampaignNameAvailable([], "A", ["A"])).toThrow(DuplicateNameError);
  });

  it("不重名时通过", () => {
    expect(() => assertCampaignNameAvailable(["其他系列"], "夏季系列-0730-1", ["别的"]))
      .not.toThrow();
  });
});

describe("stripGeneratedNameSuffixes", () => {
  it("与广告组命名共用同一套清洗规则", () => {
    expect(stripGeneratedNameSuffixes("A-0730-1-0731-2")).toBe("A");
    expect(stripGeneratedNameSuffixes("A")).toBe("A");
  });
});
