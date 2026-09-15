import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANALYSIS_PRESET,
  resolveAnalysisRange,
  toSecondPrecision,
} from "./analytics";

describe("analytics ranges", () => {
  it("resolves yesterday as a closed local calendar day", () => {
    const range = resolveAnalysisRange(
      "yesterday",
      "",
      "",
      new Date("2026-07-15T12:00:00+08:00"),
    );
    const from = new Date(range.from);
    const to = new Date(range.to);
    expect(from.getDate()).toBe(14);
    expect(from.getHours()).toBe(0);
    expect(to.getHours()).toBe(23);
  });

  it("preset today starts at local midnight and ends now", () => {
    const now = new Date("2026-07-15T12:00:00+08:00");
    const range = resolveAnalysisRange("today", "", "", now);

    expect(new Date(range.from).getHours()).toBe(0);
    expect(new Date(range.from).getDate()).toBe(15);
    expect(range.to).toBe(now.toISOString());
  });

  // 2026-09-16：分析页默认「今天」——打开页面问的就是今天跑到什么程度。
  it("opens on today", () => {
    expect(DEFAULT_ANALYSIS_PRESET).toBe("today");
    const range = resolveAnalysisRange(DEFAULT_ANALYSIS_PRESET, "", "", new Date());
    expect(new Date(range.from).getHours()).toBe(0);
  });
});

// 这一段是回归测试：分析页曾经一直在加载，根因就是区间右端带着毫秒进了 effect 依赖，
// 每次渲染都算出一个新值，于是请求反复重发。裁到秒之后，同一秒内多次渲染必须得到
// 同一个字符串——这正是"依赖不再无端变化"的硬判据。
describe("toSecondPrecision", () => {
  it("is stable across renders within the same second", () => {
    const a = toSecondPrecision(new Date("2026-09-16T06:12:33.001Z"));
    const b = toSecondPrecision(new Date("2026-09-16T06:12:33.997Z"));
    expect(a).toBe(b);
    expect(a).toBe("2026-09-16T06:12:33.000Z");
  });

  it("still advances when the second changes, so data stays fresh", () => {
    const a = toSecondPrecision(new Date("2026-09-16T06:12:33.500Z"));
    const b = toSecondPrecision(new Date("2026-09-16T06:12:34.100Z"));
    expect(a).not.toBe(b);
  });

  it("produces a value the API's datetime validator accepts", () => {
    // 端点用的是 z.string().datetime()，秒级 ISO 串必须能过；这里只做形状断言，
    // 真正的接受与否由 API 的 schema 测试覆盖。
    expect(toSecondPrecision(new Date("2026-09-16T06:12:33.123Z")))
      .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
