import { describe, expect, it } from "vitest";
import { renderBalanceAlert, renderPollCycle } from "./format.js";

describe("renderPollCycle", () => {
  it("renders enable, disable and no-action account summaries", () => {
    const rendered = renderPollCycle({
      id: "cycle-1",
      status: "completed",
      startedAt: "2026-07-15T00:00:00.000Z",
      finishedAt: "2026-07-15T00:01:00.000Z",
      accounts: [
        {
          accountId: "a",
          accountName: "账户 A",
          runId: "run-a",
          status: "changed",
          enabledCount: 2,
          disabledCount: 1,
          failureCount: 0,
          message: null,
          failureKind: null,
        },
        {
          accountId: "b",
          accountName: "账户 B",
          runId: "run-b",
          status: "no-action",
          enabledCount: 0,
          disabledCount: 0,
          failureCount: 0,
          message: null,
          failureKind: null,
        },
      ],
    });

    expect(rendered.subject).toContain("开启 2 / 关闭 1 / 无操作 1");
    expect(rendered.text).toContain("账户 B：无操作");
    expect(rendered.html).toContain("账户 A");
  });
});

describe("renderBalanceAlert", () => {
  it("强制 @所有人，带账户名、余额、币种与阈值", () => {
    const rendered = renderBalanceAlert({
      accountName: "余杭茵未-24HP",
      totalAmount: "139.50",
      currency: "USD",
      threshold: "30",
    });

    // 单条消息强制 @所有人，覆盖渠道自身的 mentionAll 设置。
    expect(rendered.mentionAll).toBe(true);
    expect(rendered.subject).toContain("余杭茵未-24HP");
    expect(rendered.subject).toContain("低于 30");
    // 金额原样进入消息：不能被浮点化（139.5）也不能四舍五入（140）。
    expect(rendered.text).toContain("139.50 USD");
    expect(rendered.text).not.toMatch(/139\.50\d/);
    expect(rendered.text).not.toContain("139.5 USD");
    expect(rendered.text).not.toContain("140 USD");
  });
});
