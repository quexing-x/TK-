import { describe, expect, it } from "vitest";
import type { AccountConfig, ManagedEntityRecord } from "@tk-auto/core";
import type { LaunchExecutionResult } from "./api";
import {
  buildSourceAdGroupOptions,
  describeRepeatSubmission,
  launchSubmissionFingerprint,
  summarizeExecution,
  summarizeLaunchOutcomeToast,
  summarizePlanAccountResult,
} from "./LaunchPage";

const accounts = [{ id: "account-1", displayName: "测试账户" }] as AccountConfig[];
const plan = {} as LaunchExecutionResult["plan"];

describe("launch item result presentation", () => {
  it("shows one distinguishable source option per ad group", () => {
    const entities = [
      { entityType: "ad-group", externalId: "group-2", name: "蓝牙音响组", ignored: false },
      { entityType: "ad-group", externalId: "group-1", name: "K歌耳机组", ignored: false },
      { entityType: "ad-group", externalId: "group-without-name", name: "group-without-name", ignored: false },
      { entityType: "ad", externalId: "ad-2", name: "0", parentAdGroupId: "group-2", ignored: false },
      { entityType: "ad", externalId: "ad-1", name: "0", parentAdGroupId: "group-1", ignored: false },
      { entityType: "ad", externalId: "ad-1-duplicate", name: "0", parentAdGroupId: "group-1", ignored: false },
      { entityType: "ad", externalId: "ad-without-group-name", name: "0", parentAdGroupId: "group-without-name", ignored: false },
    ] as ManagedEntityRecord[];

    const options = buildSourceAdGroupOptions(entities);
    expect(options).toHaveLength(2);
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ adGroupId: "group-1", name: "K歌耳机组", campaignName: "未识别系列" }),
      expect.objectContaining({ adGroupId: "group-2", name: "蓝牙音响组", campaignName: "未识别系列" }),
    ]));
  });

  it("presents succeeded items as success instead of an error", () => {
    expect(summarizeExecution({ plan, results: [{
      itemId: "item-1", accountId: "account-1", status: "succeeded",
      message: "创建完成", syncWarning: null,
    }] }, accounts)).toEqual({
      tone: "success",
      title: "创建成功 1 个广告组",
      lines: ["测试账户：成功 1 个广告组"],
    });
  });

  it("presents failed items as failures", () => {
    expect(summarizeExecution({ plan, results: [{
      itemId: "item-1", accountId: "account-1", status: "failed",
      message: "预算无效", syncWarning: null,
    }] }, accounts)).toMatchObject({
      tone: "danger",
      title: "创建失败 1 个广告组",
      lines: ["测试账户：预算无效"],
    });
  });

  it("keeps a confirmed creation successful when readback has a warning", () => {
    expect(summarizeExecution({ plan, results: [{
      itemId: "item-1", accountId: "account-1", status: "succeeded",
      message: "创建完成", syncWarning: "列表暂时不可用",
    }] }, accounts)).toMatchObject({
      tone: "success",
      lines: ["测试账户：成功 1 个广告组"],
    });
  });

  it("presents unknown creation results as non-retryable remote verification", () => {
    const feedback = summarizeExecution({ plan, results: [{
      itemId: "item-unknown", accountId: "account-1", status: "unknown",
      message: "响应在请求发送后丢失", syncWarning: null,
    }] }, accounts);

    expect(feedback).toMatchObject({
      tone: "danger",
      title: "创建失败 1 个广告组",
      lines: ["测试账户：结果核验失败：响应在请求发送后丢失；可只读重新核验，不会重复创建"],
    });
    expect(feedback.lines.join(" ")).not.toContain("人工核验");
  });

  it("shows confirmed and readback failures together without hiding either node", () => {
    const feedback = summarizeExecution({ plan, results: [
      { itemId: "item-failed", accountId: "account-1", status: "failed", message: "预算无效", syncWarning: null },
      { itemId: "item-unknown", accountId: "account-1", status: "unknown", message: "Cookie 连接中断", syncWarning: null },
    ] }, accounts);

    expect(feedback).toMatchObject({
      tone: "danger",
      title: "创建失败 2 个广告组",
      lines: [
        "测试账户：预算无效",
        "测试账户：结果核验失败：Cookie 连接中断；可只读重新核验，不会重复创建",
      ],
    });
  });

  it("does not surface readback warnings as a creation failure", () => {
    const feedback = summarizeExecution({ plan, results: [{
      itemId: "item-success", accountId: "account-1", status: "succeeded",
      message: "创建完成", syncWarning: "同步暂时不可用",
    }] }, accounts);

    expect(feedback.tone).toBe("success");
    expect(feedback.lines).toEqual([
      "测试账户：成功 1 个广告组",
    ]);
    expect(feedback.lines[0]).not.toContain("创建结果待确认");
  });

  it("keeps the ad-group successful and reports skipped materials without a red result", () => {
    const results = [{
      itemId: "item-success", accountId: "account-1", status: "succeeded" as const,
      message: "广告组已创建", syncWarning: "素材提示：广告组已创建成功；已跳过 2 条素材。",
    }];

    expect(summarizeExecution({ plan, results }, accounts)).toEqual({
      tone: "success",
      title: "创建成功 1 个广告组（2 条素材失败，已跳过）",
      lines: ["测试账户：成功 1 个广告组"],
    });
    expect(summarizeLaunchOutcomeToast(results)).toEqual({
      message: "创建成功（2 条素材失败，已跳过）",
      tone: "success",
    });
  });

  it("uses a red toast only when an ad group failed or could not be verified", () => {
    expect(summarizeLaunchOutcomeToast([
      { status: "succeeded", syncWarning: null },
      { status: "failed", syncWarning: null },
    ])).toEqual({
      message: "创建完成：成功 1 个广告组，失败 1 个广告组",
      tone: "error",
    });
    expect(summarizeLaunchOutcomeToast([
      { status: "succeeded", syncWarning: "列表刷新稍慢" },
      { status: "succeeded", syncWarning: null },
    ])).toEqual({
      message: "创建任务全部成功（2 个广告组）",
      tone: "success",
    });
  });

  it("keeps unknown counts separate from confirmed failures", () => {
    expect(summarizePlanAccountResult({
      accountId: "account-1", ok: false, message: "创建结果待确认：响应丢失",
      createdCount: 0, failedCount: 0, unknownCount: 1,
    })).toEqual({
      tone: "danger",
      text: "结果核验失败 1 条：创建结果待确认：响应丢失",
    });
    expect(summarizePlanAccountResult({
      accountId: "account-1", ok: false, message: "明确失败：预算被拒绝",
      createdCount: 0, failedCount: 1, unknownCount: 0,
    })).toEqual({
      tone: "danger",
      text: "失败 1 条：明确失败：预算被拒绝",
    });
  });
});

describe("重复提交提醒", () => {
  const row = (campaignName: string, adGroupName: string, videoCode: string) =>
    ({ campaignName, adGroupName, videoCode });

  it("同一批内容指纹相同，账户顺序不影响", () => {
    const a = launchSubmissionFingerprint({ mode: "single", presetId: "p1", accountIds: ["b", "a"], rows: [row("c", "g", "#v")] });
    const b = launchSubmissionFingerprint({ mode: "single", presetId: "p1", accountIds: ["a", "b"], rows: [row("c", "g", "#v")] });
    expect(a).toBe(b);
  });

  it("换预设、换账户、换任意一行内容都算不同批次", () => {
    const base = { mode: "single", presetId: "p1", accountIds: ["a"], rows: [row("c", "g", "#v")] };
    const fingerprint = launchSubmissionFingerprint(base);
    expect(launchSubmissionFingerprint({ ...base, presetId: "p2" })).not.toBe(fingerprint);
    expect(launchSubmissionFingerprint({ ...base, accountIds: ["a", "b"] })).not.toBe(fingerprint);
    expect(launchSubmissionFingerprint({ ...base, rows: [row("c", "g", "#other")] })).not.toBe(fingerprint);
  });

  it("确认文案说清是同一张表、多少条、多久之前", () => {
    const seconds = describeRepeatSubmission({ rowCount: 17, accountCount: 2, secondsAgo: 40 });
    expect(seconds).toContain("40 秒前");
    expect(seconds).toContain("17 条 × 2 个账户");
    // 必须点明后果，否则用户只会无脑点确认。
    expect(seconds).toContain("重复创建同名广告组");

    const minutes = describeRepeatSubmission({ rowCount: 1, accountCount: 1, secondsAgo: 185 });
    expect(minutes).toContain("3 分钟前");
  });
});
