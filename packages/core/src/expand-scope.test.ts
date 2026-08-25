import { describe, expect, it } from "vitest";
import { withinExpandScope } from "./expand-scope.js";

const now = new Date("2026-08-25T10:00:00.000Z").getTime();
const hoursAgo = (hours: number) => new Date(now - hours * 60 * 60 * 1000).toISOString();

describe("扩组面板的时间范围", () => {
  describe("今天在投（有消耗）", () => {
    // 这条是这次改动的起点：原先「今天」按创建时间判，于是一个前天建、今天正在花钱的
    // 组根本不出现。实测某账户当天有消耗的 8 个组里 7 个是更早建的，全被挡在外面。
    it("老组只要今天在花钱就算", () => {
      expect(withinExpandScope(
        { createdAt: hoursAgo(200), spend: 12.02 },
        "spending-today",
        now,
      )).toBe(true);
    });

    it("刚建但还没花钱的不算", () => {
      expect(withinExpandScope({ createdAt: hoursAgo(1), spend: 0 }, "spending-today", now))
        .toBe(false);
      expect(withinExpandScope({ createdAt: hoursAgo(1), spend: null }, "spending-today", now))
        .toBe(false);
    });

    it("没有创建时间也不影响判定——这个口径根本不看创建时间", () => {
      expect(withinExpandScope({ createdAt: null, spend: 3 }, "spending-today", now)).toBe(true);
    });
  });

  describe("近 48 小时新建", () => {
    it("按 48 小时切，与引擎的回看窗一致", () => {
      expect(withinExpandScope({ createdAt: hoursAgo(47) }, "created-recently", now)).toBe(true);
      expect(withinExpandScope({ createdAt: hoursAgo(49) }, "created-recently", now)).toBe(false);
    });

    it("缺创建时间或时间非法时不算", () => {
      expect(withinExpandScope({ createdAt: null }, "created-recently", now)).toBe(false);
      expect(withinExpandScope({ createdAt: "不是时间" }, "created-recently", now)).toBe(false);
    });

    // 时钟偏差留 5 分钟容忍，与引擎一致；再往后的时间戳按脏数据处理。
    it("未来时间戳不算", () => {
      expect(withinExpandScope({ createdAt: hoursAgo(-1) }, "created-recently", now)).toBe(false);
    });
  });

  describe("轮询范围内全部", () => {
    // 三条并列的路，逐条对齐 filterEntitiesToRecentWindow。
    it("48 小时内建的算", () => {
      expect(withinExpandScope({ createdAt: hoursAgo(10), spend: 0 }, "polling-range", now))
        .toBe(true);
    });

    it("老组当天有消耗也算", () => {
      expect(withinExpandScope({ createdAt: hoursAgo(500), spend: 0.5 }, "polling-range", now))
        .toBe(true);
    });

    // 这条最容易被漏掉：自动化关停后当天零消耗，正等着延迟回传的转化把它开回来。
    // 少了它，开启规则永远够不着这批组。
    it("在持久管辖集里的老组，零消耗也算", () => {
      expect(withinExpandScope(
        { createdAt: hoursAgo(500), spend: 0, automationManaged: true },
        "polling-range",
        now,
      )).toBe(true);
    });

    it("又老、又没消耗、又不在管辖集里的才排除", () => {
      expect(withinExpandScope(
        { createdAt: hoursAgo(500), spend: 0, automationManaged: false },
        "polling-range",
        now,
      )).toBe(false);
    });
  });
});
