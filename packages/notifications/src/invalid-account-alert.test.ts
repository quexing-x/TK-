import { describe, expect, it } from "vitest";
import type { PollCycleRecord } from "@tk-auto/core";
import { renderPollCycle } from "./format.js";

/**
 * 账户失效提醒。
 *
 * 轮询汇总平时不该吵人，但「自动化开着的账户连不上了」意味着投放正在停摆，
 * 必须立刻有人看到——所以这条强制 @所有人，覆盖渠道自身的 mentionAll 设置。
 */
const cycle = (accounts: PollCycleRecord["accounts"]): PollCycleRecord => ({
  id: "cycle-1",
  status: "completed",
  startedAt: "2026-08-24T02:00:00.000Z",
  finishedAt: "2026-08-24T02:01:00.000Z",
  accounts,
});

const account = (
  patch: Partial<PollCycleRecord["accounts"][number]> = {},
): PollCycleRecord["accounts"][number] => ({
  accountId: "a1",
  accountName: "演示账户",
  runId: null,
  status: "no-action",
  enabledCount: 0,
  disabledCount: 0,
  failureCount: 0,
  message: null,
  failureKind: null,
  ...patch,
});

describe("账户失效提醒", () => {
  it("没有失效账户时，不 @所有人，标题是常规汇总", () => {
    const message = renderPollCycle(cycle([account()]));

    expect(message.mentionAll).toBeUndefined();
    expect(message.subject).toContain("轮询报告");
    expect(message.text).not.toContain("投放正在停摆");
  });

  it("有失效账户时强制 @所有人，并盖过常规标题", () => {
    const message = renderPollCycle(cycle([account({ status: "failed" })]), [
      { accountName: "双科-TD-全娘+8-TT-002", message: "Cookie 已失效" },
    ]);

    expect(message.mentionAll).toBe(true);
    expect(message.subject).toContain("账户失效");
    expect(message.subject).toContain("1 个");
  });

  it("提醒里带上账户名和失败原因，且排在汇总前面", () => {
    const message = renderPollCycle(cycle([account({ status: "failed" })]), [
      { accountName: "账户甲", message: "Cookie 已失效或连接异常" },
      { accountName: "账户乙", message: null },
    ]);

    for (const surface of [message.text, message.markdown, message.html]) {
      expect(surface).toContain("账户甲");
      expect(surface).toContain("账户乙");
    }
    expect(message.text).toContain("Cookie 已失效或连接异常");
    // 提醒必须在汇总之前，否则在群里被折叠就看不见了
    expect(message.text.indexOf("账户甲")).toBeLessThan(message.text.indexOf("轮询报告"));
    expect(message.markdown.indexOf("账户甲")).toBeLessThan(message.markdown.indexOf("轮询报告"));
  });

  it("HTML 里的账户名转义，不被内容带出标签", () => {
    const message = renderPollCycle(cycle([account({ status: "failed" })]), [
      { accountName: "<script>x</script>", message: "<b>坏了</b>" },
    ]);

    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
  });

  // 常规汇总本身不该改变行为：没有失效账户时一切照旧。
  it("失效提醒不影响原有的汇总内容", () => {
    const accounts = [account({ status: "changed", enabledCount: 1, disabledCount: 2 })];
    const plain = renderPollCycle(cycle(accounts));
    const alerted = renderPollCycle(cycle(accounts), [{ accountName: "甲", message: null }]);

    expect(plain.text).toContain("开启 1");
    expect(alerted.text).toContain("开启 1");
    expect(alerted.text).toContain("演示账户");
  });
});
