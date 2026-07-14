import { describe, expect, it } from "vitest";
import { renderPollCycle } from "./format.js";

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
        },
      ],
    });

    expect(rendered.subject).toContain("开启 2 / 关闭 1 / 无操作 1");
    expect(rendered.text).toContain("账户 B：无操作");
    expect(rendered.html).toContain("账户 A");
  });
});
