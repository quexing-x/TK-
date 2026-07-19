import { describe, expect, it } from "vitest";
import type { AccountConfig } from "@tk-auto/core";
import type { LaunchExecutionResult } from "./api";
import { launchVerificationIdentityLines, summarizeExecution, summarizePlanAccountResult } from "./LaunchPage";

const accounts = [{ id: "account-1", displayName: "测试账户" }] as AccountConfig[];
const plan = {} as LaunchExecutionResult["plan"];

describe("launch item result presentation", () => {
  it("presents succeeded items as success instead of an error", () => {
    expect(summarizeExecution({ plan, results: [{
      itemId: "item-1", accountId: "account-1", status: "succeeded",
      message: "创建完成", syncWarning: null,
    }] }, accounts)).toEqual({
      tone: "success",
      title: "创建成功 1 条",
      lines: ["测试账户：创建完成"],
    });
  });

  it("presents failed items as failures", () => {
    expect(summarizeExecution({ plan, results: [{
      itemId: "item-1", accountId: "account-1", status: "failed",
      message: "预算无效", syncWarning: null,
    }] }, accounts)).toMatchObject({
      tone: "danger",
      title: "创建失败 1 条",
      lines: ["测试账户：预算无效"],
    });
  });

  it("presents sync failures as warnings after creation success", () => {
    expect(summarizeExecution({ plan, results: [{
      itemId: "item-1", accountId: "account-1", status: "succeeded",
      message: "创建完成", syncWarning: "列表暂时不可用",
    }] }, accounts)).toMatchObject({
      tone: "warning",
      lines: ["测试账户：广告已创建，但同步警告：列表暂时不可用"],
    });
  });

  it("presents unknown separately without a safe-retry instruction", () => {
    const feedback = summarizeExecution({ plan, results: [{
      itemId: "item-unknown", accountId: "account-1", status: "unknown",
      message: "响应在请求发送后丢失", syncWarning: null,
    }] }, accounts);

    expect(feedback).toMatchObject({
      tone: "warning",
      lines: ["测试账户：创建结果待确认，响应在请求发送后丢失"],
    });
    expect(feedback.title).not.toContain("失败");
    expect(feedback.lines.join(" ")).not.toMatch(/可重试|安全重试/);
  });

  it("keeps syncWarning separate from the succeeded status message", () => {
    const feedback = summarizeExecution({ plan, results: [{
      itemId: "item-success", accountId: "account-1", status: "succeeded",
      message: "创建完成", syncWarning: "同步暂时不可用",
    }] }, accounts);

    expect(feedback.tone).toBe("warning");
    expect(feedback.lines).toEqual([
      "测试账户：广告已创建，但同步警告：同步暂时不可用",
    ]);
    expect(feedback.lines[0]).not.toContain("创建结果待确认");
  });

  it("separates unknown from failed in historical account summaries", () => {
    expect(summarizePlanAccountResult({
      accountId: "account-1", ok: false, message: "创建结果待确认：响应丢失",
      createdCount: 0, failedCount: 0, unknownCount: 1,
    })).toEqual({
      tone: "warning",
      text: "创建结果待确认 1 条，禁止重试，需人工核验；创建结果待确认：响应丢失",
    });
    expect(summarizePlanAccountResult({
      accountId: "account-1", ok: false, message: "明确失败：预算被拒绝",
      createdCount: 0, failedCount: 1, unknownCount: 0,
    })).toEqual({
      tone: "danger",
      text: "明确失败 1 条，可单项重试；明确失败：预算被拒绝",
    });
  });

  it("shows the account and stable operation identity before manual verification", () => {
    const lines = launchVerificationIdentityLines({
      accountId: "account-1",
      operationId: "operation-1",
      attemptId: "attempt-2",
      correlationId: "plan:account-1:0",
      phase: "publishing",
      claimedAt: "2026-07-17T01:00:00.000Z",
      evidence: { campaignSnapId: "campaign-snap", asyncRequestId: "async-1" },
    } as Parameters<typeof launchVerificationIdentityLines>[0], "测试账户");

    expect(lines).toEqual(expect.arrayContaining([
      "账户：测试账户（account-1）",
      "operationId：operation-1",
      "attemptId：attempt-2",
      "correlationId：plan:account-1:0",
      expect.stringContaining("阶段：publishing"),
      expect.stringContaining("campaignSnapId: campaign-snap"),
    ]));
  });
});
