import { describe, expect, it } from "vitest";
import {
  DuplicateNameError,
  allocateExpandBaseName,
  assertCampaignNameAvailable,
  dateTimeSuffix,
  planGeneratedNames,
  stripGeneratedNameSuffixes,
  truncateGeneratedName,
} from "./copy-naming.js";

const at = new Date("2026-07-30T12:00:00.000Z");

describe("planGeneratedNames", () => {
  it("生成 {源名}-{MMDD}-{HHMMSS}，同批按秒递增", () => {
    const plan = planGeneratedNames({ sourceName: "夏季系列", count: 2, at, timeZone: "UTC" });
    expect(plan.baseName).toBe("夏季系列-0730");
    expect(plan.names).toEqual(["夏季系列-0730-120000", "夏季系列-0730-120001"]);
  });

  it("名字不再依赖账户已有名称定序号：快照过期也不影响结果", () => {
    // 旧规则会把这些已有名称当成序号起点；新规则只按投放时刻取名，传入过期
    // 快照与传空必须得到完全一样的结果——这正是移除发布前强制刷新的前提。
    const withStaleSnapshot = planGeneratedNames({
      sourceName: "夏季系列",
      count: 2,
      at,
      timeZone: "UTC",
      existingNames: ["夏季系列-0730-1", "夏季系列-0730-2", "无关系列"],
    });
    const withoutSnapshot = planGeneratedNames({
      sourceName: "夏季系列", count: 2, at, timeZone: "UTC",
    });
    expect(withStaleSnapshot.names).toEqual(withoutSnapshot.names);
  });

  it("定时投放取排期时刻，与立即投放区分开", () => {
    const scheduled = planGeneratedNames({
      sourceName: "夏季系列",
      count: 1,
      at: new Date("2026-08-06T01:00:00.000Z"),
      timeZone: "UTC",
    });
    expect(scheduled.names).toEqual(["夏季系列-0806-010000"]);
  });

  it("对已生成的名字再次复制时清洗掉旧时间戳，不会累积", () => {
    const plan = planGeneratedNames({
      sourceName: "夏季系列-0730-120000",
      count: 1,
      at: new Date("2026-07-31T12:00:00.000Z"),
      timeZone: "UTC",
    });
    expect(plan.names).toEqual(["夏季系列-0731-120000"]);
  });

  it("旧格式的名字（-MMDD-序号）同样能清洗干净", () => {
    const plan = planGeneratedNames({
      sourceName: "夏季系列-0730-3",
      count: 1,
      at: new Date("2026-07-31T12:00:00.000Z"),
      timeZone: "UTC",
    });
    expect(plan.names).toEqual(["夏季系列-0731-120000"]);
  });

  it("撞上用户手工起的同名对象时顺延一秒", () => {
    const plan = planGeneratedNames({
      sourceName: "夏季系列",
      count: 1,
      at,
      timeZone: "UTC",
      existingNames: ["夏季系列-0730-120000"],
    });
    expect(plan.names).toEqual(["夏季系列-0730-120001"]);
  });

  it("本批次预留的名称参与去重", () => {
    const plan = planGeneratedNames({
      sourceName: "夏季系列",
      count: 1,
      at,
      timeZone: "UTC",
      reservedNames: ["夏季系列-0730-120000"],
    });
    expect(plan.names).toEqual(["夏季系列-0730-120001"]);
  });

  it("像型号一样的四位数字不会被误当成日期清洗掉", () => {
    const plan = planGeneratedNames({ sourceName: "耳机2024", count: 1, at, timeZone: "UTC" });
    expect(plan.names).toEqual(["耳机2024-0730-120000"]);
  });

  it("跨午夜的秒递增会带着日期一起进位", () => {
    const plan = planGeneratedNames({
      sourceName: "夏季系列",
      count: 2,
      at: new Date("2026-07-30T23:59:59.000Z"),
      timeZone: "UTC",
    });
    expect(plan.names).toEqual(["夏季系列-0730-235959", "夏季系列-0731-000000"]);
  });
});

describe("dateTimeSuffix", () => {
  it("按账户时区取投放日期与时间", () => {
    expect(dateTimeSuffix(at, "UTC")).toBe("0730-120000");
    // 台北 +8：UTC 12:00 是当地 20:00，仍是同一天。
    expect(dateTimeSuffix(at, "Asia/Taipei")).toBe("0730-200000");
  });

  it("时区跨日时日期跟着走", () => {
    expect(dateTimeSuffix(new Date("2026-07-30T17:00:00.000Z"), "Asia/Taipei"))
      .toBe("0731-010000");
  });

  it("用 24 小时制，不会把 00 点写成 24", () => {
    expect(dateTimeSuffix(new Date("2026-07-30T00:00:00.000Z"), "UTC")).toBe("0730-000000");
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

// 2026-08-25 07:47–07:49 那一批 8 条扩组废了 2 条，两条的生成名都跟同批先成功的一条一字不差。
// 根因：后缀取的是【投放档位】而非创建时刻，同一批共用；两个源组本身就是同一产品在不同档位
// 扩出来的，旧后缀被 strip 掉后基名完全相同，于是新名撞死。
describe("扩组基名在批内唯一", () => {
  const deliveryAt = new Date("2026-08-25T09:00:00.000Z"); // 台北 17:00
  const timeZone = "Asia/Taipei";

  it("第一个源组拿到不带偏移的名字", () => {
    expect(allocateExpandBaseName({
      cleanedSourceName: "FY13011雙頭唇綫筆低价测试1",
      deliveryAt,
      timeZone,
      usedBaseNames: new Set(),
    })).toBe("FY13011雙頭唇綫筆低价测试1-0825-170000");
  });

  // 生产上真实发生的那一对：源组分别是 -0825-130000-1 和 -0825-060000-1，洗完基名相同。
  it("同批第二个同基名的源组往后推一秒，不再撞名", () => {
    const first = "FY13011雙頭唇綫筆低价测试1-0825-170000";
    expect(allocateExpandBaseName({
      cleanedSourceName: "FY13011雙頭唇綫筆低价测试1",
      deliveryAt,
      timeZone,
      usedBaseNames: new Set([first]),
    })).toBe("FY13011雙頭唇綫筆低价测试1-0825-170001");
  });

  it("连撞多个就一直往后排，各不相同", () => {
    const used = new Set<string>();
    const names = [1, 2, 3, 4].map(() => {
      const name = allocateExpandBaseName({
        cleanedSourceName: "同名产品",
        deliveryAt,
        timeZone,
        usedBaseNames: used,
      });
      used.add(name);
      return name;
    });

    expect(new Set(names).size).toBe(4);
    expect(names[0]).toBe("同名产品-0825-170000");
    expect(names[3]).toBe("同名产品-0825-170003");
  });

  // 账户里已经有 `${基名}-1` 时也要让开——实际创建出来的是带序号的那个名字。
  it("账户里已存在同名的第一个副本时跳过", () => {
    expect(allocateExpandBaseName({
      cleanedSourceName: "早餐機_新",
      deliveryAt,
      timeZone,
      usedBaseNames: new Set(),
      existingNames: new Set(["早餐機_新-0825-170000-1"]),
    })).toBe("早餐機_新-0825-170001");
  });

  it("不同源组之间互不影响", () => {
    const used = new Set(["甲-0825-170000"]);
    expect(allocateExpandBaseName({
      cleanedSourceName: "乙",
      deliveryAt,
      timeZone,
      usedBaseNames: used,
    })).toBe("乙-0825-170000");
  });
});
