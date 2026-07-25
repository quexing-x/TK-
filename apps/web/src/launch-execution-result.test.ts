import { describe, expect, it } from "vitest";
import type { AccountConfig, ManagedEntityRecord } from "@tk-auto/core";
import type { LaunchExecutionResult } from "./api";
import { buildSourceAdGroupOptions, summarizeExecution, summarizePlanAccountResult } from "./LaunchPage";

const accounts = [{ id: "account-1", displayName: "测试账户" }] as AccountConfig[];
const plan = {} as LaunchExecutionResult["plan"];

describe("launch item result presentation", () => {
  it("shows one source option per ad group using only the ad-group name", () => {
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
      { sourceAdId: "ad-1", adGroupId: "group-1", name: "K歌耳机组" },
      { sourceAdId: "ad-2", adGroupId: "group-2", name: "蓝牙音响组" },
    ]));
  });

  it("presents succeeded items as success instead of an error", () => {
    expect(summarizeExecution({ plan, results: [{
      itemId: "item-1", accountId: "account-1", status: "succeeded",
      message: "创建完成", syncWarning: null,
    }] }, accounts)).toEqual({
      tone: "success",
      title: "创建成功 1 条",
      lines: ["测试账户：成功"],
    });
  });

  it("presents failed items as failures", () => {
    expect(summarizeExecution({ plan, results: [{
      itemId: "item-1", accountId: "account-1", status: "failed",
      message: "预算无效", syncWarning: null,
    }] }, accounts)).toMatchObject({
      tone: "danger",
      title: "创建失败 1 条",
      lines: ["测试账户：失败"],
    });
  });

  it("keeps a confirmed creation successful when readback has a warning", () => {
    expect(summarizeExecution({ plan, results: [{
      itemId: "item-1", accountId: "account-1", status: "succeeded",
      message: "创建完成", syncWarning: "列表暂时不可用",
    }] }, accounts)).toMatchObject({
      tone: "success",
      lines: ["测试账户：成功"],
    });
  });

  it("presents legacy unknown creation results as failures without a verification form", () => {
    const feedback = summarizeExecution({ plan, results: [{
      itemId: "item-unknown", accountId: "account-1", status: "unknown",
      message: "响应在请求发送后丢失", syncWarning: null,
    }] }, accounts);

    expect(feedback).toMatchObject({
      tone: "danger",
      title: "创建失败 1 条",
      lines: ["测试账户：失败"],
    });
    expect(feedback.lines.join(" ")).not.toContain("人工核验");
  });

  it("does not surface readback warnings as a creation failure", () => {
    const feedback = summarizeExecution({ plan, results: [{
      itemId: "item-success", accountId: "account-1", status: "succeeded",
      message: "创建完成", syncWarning: "同步暂时不可用",
    }] }, accounts);

    expect(feedback.tone).toBe("success");
    expect(feedback.lines).toEqual([
      "测试账户：成功",
    ]);
    expect(feedback.lines[0]).not.toContain("创建结果待确认");
  });

  it("folds legacy unknown counts into failed account summaries", () => {
    expect(summarizePlanAccountResult({
      accountId: "account-1", ok: false, message: "创建结果待确认：响应丢失",
      createdCount: 0, failedCount: 0, unknownCount: 1,
    })).toEqual({
      tone: "danger",
      text: "失败 1 条",
    });
    expect(summarizePlanAccountResult({
      accountId: "account-1", ok: false, message: "明确失败：预算被拒绝",
      createdCount: 0, failedCount: 1, unknownCount: 0,
    })).toEqual({
      tone: "danger",
      text: "失败 1 条",
    });
  });
});
