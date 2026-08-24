import { afterEach, describe, expect, it, vi } from "vitest";
import { withinWindow } from "./ExpandGroupsPanel";

/**
 * 时间范围从「滚动小时窗」改成「自然日」。
 *
 * 原来的「近 24 小时」在早上八点看会把昨天上午创建的组算进来，而人想的是「今天建的」。
 * 这两种口径在一天中的大部分时刻结果不同，改回去不会有任何编译错误，只会悄悄变味。
 */
const at = (iso: string) => new Date(iso).getTime();

afterEach(() => {
  vi.useRealTimers();
});

describe("一键扩组的时间范围", () => {
  // 用本地时间构造，跟实现里的 setHours(0,0,0,0) 同一套口径
  const localNoon = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const todayMorning = new Date(2026, 7, 24, 8, 30, 0).toISOString();
  const yesterdayMorning = new Date(2026, 7, 23, 8, 30, 0).toISOString();
  const yesterdayLateNight = new Date(2026, 7, 23, 23, 30, 0).toISOString();
  const threeDaysAgo = new Date(2026, 7, 21, 12, 0, 0).toISOString();

  it("今天：只要今天零点之后建的", () => {
    expect(withinWindow(todayMorning, "today", localNoon)).toBe(true);
    // 关键差异：昨晚 23:30 距今不到 24 小时，但不是今天
    expect(withinWindow(yesterdayLateNight, "today", localNoon)).toBe(false);
    expect(withinWindow(yesterdayMorning, "today", localNoon)).toBe(false);
  });

  it("今天+昨天：昨天零点之后都算", () => {
    expect(withinWindow(todayMorning, "yesterday", localNoon)).toBe(true);
    expect(withinWindow(yesterdayMorning, "yesterday", localNoon)).toBe(true);
    expect(withinWindow(yesterdayLateNight, "yesterday", localNoon)).toBe(true);
    expect(withinWindow(threeDaysAgo, "yesterday", localNoon)).toBe(false);
  });

  it("全部：不筛，连没有创建时间的也留下", () => {
    expect(withinWindow(threeDaysAgo, "all", localNoon)).toBe(true);
    expect(withinWindow(null, "all", localNoon)).toBe(true);
  });

  // 缺创建时间的对象在有筛选时不能蒙混过关——扩组是会真建广告组的操作。
  it("有筛选时，缺创建时间的对象不算命中", () => {
    expect(withinWindow(null, "today", localNoon)).toBe(false);
    expect(withinWindow(undefined, "yesterday", localNoon)).toBe(false);
    expect(withinWindow("不是日期", "today", localNoon)).toBe(false);
  });

  it("凌晨也按自然日切，不受滚动窗影响", () => {
    const justAfterMidnight = new Date(2026, 7, 24, 0, 20, 0).getTime();
    // 今天刚过零点：今天建的那条算，昨天 23:30 建的（20 分钟前）不算
    expect(withinWindow(new Date(2026, 7, 24, 0, 10, 0).toISOString(), "today", justAfterMidnight)).toBe(true);
    expect(withinWindow(yesterdayLateNight, "today", justAfterMidnight)).toBe(false);
    expect(withinWindow(yesterdayLateNight, "yesterday", justAfterMidnight)).toBe(true);
  });

  it("未来时间不会被今天挡掉（时钟漂移容错）", () => {
    expect(withinWindow(new Date(2026, 7, 24, 23, 0, 0).toISOString(), "today", localNoon)).toBe(true);
  });

  it("接受 ISO 字符串以外的可解析时间", () => {
    expect(withinWindow(new Date(at(todayMorning)).toString(), "today", localNoon)).toBe(true);
  });
});
