import { describe, expect, it } from "vitest";
import { taskStatusPresentation } from "./TaskCenterPage";

describe("task center status presentation", () => {
  it("keeps unknown non-retryable and requires manual verification", () => {
    expect(taskStatusPresentation({
      status: "unknown",
      retryable: false,
      requiresVerification: true,
      syncWarning: null,
    })).toEqual({
      label: "结果待确认",
      tone: "warning",
      showRetry: false,
      showVerification: true,
      syncWarning: null,
    });
  });

  it("offers retry only for an explicitly retryable failed task", () => {
    expect(taskStatusPresentation({
      status: "failed",
      retryable: true,
      requiresVerification: false,
      syncWarning: null,
    })).toMatchObject({
      label: "明确失败",
      tone: "danger",
      showRetry: true,
      showVerification: false,
    });
  });

  it("keeps a synchronization warning separate from success", () => {
    expect(taskStatusPresentation({
      status: "succeeded",
      retryable: false,
      requiresVerification: false,
      syncWarning: "readback delayed",
    })).toEqual({
      label: "已成功",
      tone: "active",
      showRetry: false,
      showVerification: false,
      syncWarning: "readback delayed",
    });
  });
});
