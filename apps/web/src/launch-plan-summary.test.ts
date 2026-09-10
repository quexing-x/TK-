import { describe, expect, it } from "vitest";
import { summarizeLaunchPlan, type LaunchSummaryRow } from "./LaunchPage";

const row = (patch: Partial<LaunchSummaryRow> = {}): LaunchSummaryRow => ({
  campaignName: "系列A",
  videoCode: "#code1",
  startAt: null,
  dailyBudget: 100,
  campaignBudget: null,
  bid: null,
  initialStatus: "enabled",
  ...patch,
});

const summarize = (rows: LaunchSummaryRow[], patch: Partial<Parameters<typeof summarizeLaunchPlan>[0]> = {}) =>
  summarizeLaunchPlan({
    rows,
    accountNames: ["余杭茵未-1PHH"],
    timeZone: "Asia/Shanghai",
    budgetMode: "ad-group",
    ...patch,
  });

describe("summarizeLaunchPlan", () => {
  it("空表没有摘要可给", () => {
    expect(summarize([])).toBeNull();
  });

  it("按系列名去重数系列，按行数数广告组", () => {
    const summary = summarize([
      row({ campaignName: "系列A" }),
      row({ campaignName: "系列A" }),
      row({ campaignName: "系列B" }),
    ]);
    expect(summary?.campaigns).toBe(2);
    expect(summary?.groups).toBe(3);
  });

  it("续行的系列名为空时不算成一个系列", () => {
    // 一个品拆多组时，导入表只在首行写系列名，其余行留空并入同一条系列。
    const summary = summarize([row({ campaignName: "系列A" }), row({ campaignName: "  " })]);
    expect(summary?.campaigns).toBe(1);
    expect(summary?.groups).toBe(2);
  });

  it("一行有几个视频代码就算几条广告，与 5000 条上限同口径", () => {
    const summary = summarize([
      row({ videoCode: "#a;#b;#c" }),
      row({ videoCode: "#d" }),
    ]);
    expect(summary?.ads).toBe(4);
  });

  it("视频代码为空的行仍按一条广告计，不会把行漏掉", () => {
    expect(summarize([row({ videoCode: "" })])?.ads).toBe(1);
  });

  it("出价为 null 是「自动」，不是「各行不同」", () => {
    // bid 允许是 null，所以判定必须区分「值就是 null」和「各行不一致」。
    expect(summarize([row({ bid: null }), row({ bid: null })])?.bidLabel).toBe("自动");
    expect(summarize([row({ bid: 5 }), row({ bid: 5 })])?.bidLabel).toBe("5");
  });

  it("逐行不一致时点破，绝不取第一行糊弄过去", () => {
    const summary = summarize([
      row({ dailyBudget: 100, bid: 5, initialStatus: "enabled", startAt: "2026-09-11T01:00:00.000Z" }),
      row({ dailyBudget: 200, bid: 8, initialStatus: "disabled", startAt: "2026-09-12T01:00:00.000Z" }),
    ]);
    expect(summary?.budgetLabel).toBe("各行不同");
    expect(summary?.bidLabel).toBe("各行不同");
    expect(summary?.statusLabel).toBe("各行不同");
    expect(summary?.startLabel).toBe("各行不同");
  });

  it("系列预算模式读 campaignBudget，组预算模式读 dailyBudget", () => {
    const rows = [row({ dailyBudget: 100, campaignBudget: 500 })];
    expect(summarize(rows)?.budgetLabel).toBe("100 / 组");
    expect(summarize(rows, { budgetMode: "campaign" })?.budgetLabel).toBe("500 / 系列");
  });

  it("创建时间按账户时区显示，没设时间就是立即", () => {
    expect(summarize([row({ startAt: null })])?.startLabel).toBe("立即");
    const summary = summarize([row({ startAt: "2026-09-10T22:00:00.000Z" })]);
    // 22:00 UTC = 次日 06:00 北京时间，日期必须跟着时区走，不能显示成 09-10。
    expect(summary?.startLabel).toContain("2026/09/11 06:00");
    expect(summary?.startLabel).toContain("Asia/Shanghai");
  });

  it("多账户时报出账户数，供界面算总组数", () => {
    const summary = summarize([row(), row()], { accountNames: ["账户甲", "账户乙", "账户丙"] });
    expect(summary?.accountCount).toBe(3);
    expect(summary?.groups).toBe(2);
  });
});
