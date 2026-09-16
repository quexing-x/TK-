import { describe, expect, it } from "vitest";
import { describeReconcileState, formatReconcileCountdown } from "./LaunchPage";

/**
 * 跑完之后界面还要静默 3 分钟才核对。这段时间不给提示的话，投手看到的就是一个
 * 「153/153 却还标着未全部完成」的界面，跟卡死没有区别——他明确要求过要能看出
 * 「后台在干吗」。
 */
describe("describeReconcileState", () => {
  const quietPeriodMs = 180_000;
  const settledAt = "2026-09-17T00:00:00.000Z";
  const at = (offsetMs: number) => new Date(Date.parse(settledAt) + offsetMs);

  it("还在建的时候不显示倒计时", () => {
    expect(describeReconcileState(
      { settledAt: null, reconciledAt: null, quietPeriodMs },
      at(0),
    )).toEqual({ phase: "creating", remainingMs: 0 });
  });

  it("静默期内给出剩余时间", () => {
    const state = describeReconcileState(
      { settledAt, reconciledAt: null, quietPeriodMs },
      at(30_000),
    );
    expect(state.phase).toBe("waiting");
    expect(state.remainingMs).toBe(150_000);
    expect(formatReconcileCountdown(state.remainingMs)).toBe("2:30");
  });

  it("静默期满但还没核对完，显示正在核对而不是负数倒计时", () => {
    expect(describeReconcileState(
      { settledAt, reconciledAt: null, quietPeriodMs },
      at(200_000),
    )).toEqual({ phase: "reconciling", remainingMs: 0 });
  });

  it("核对完成后收口", () => {
    expect(describeReconcileState(
      { settledAt, reconciledAt: "2026-09-17T00:03:05.000Z", quietPeriodMs },
      at(300_000),
    )).toEqual({ phase: "done", remainingMs: 0 });
  });

  // 时间戳坏了的话，宁可显示「正在核对」，也不要摆一个永远不动的倒计时。
  it("时间戳解析不了时按正在核对显示", () => {
    expect(describeReconcileState(
      { settledAt: "not-a-date", reconciledAt: null, quietPeriodMs },
      at(0),
    )).toEqual({ phase: "reconciling", remainingMs: 0 });
  });

  it("没有派发记录时当作还在建", () => {
    expect(describeReconcileState(null, at(0)).phase).toBe("creating");
  });
});

describe("formatReconcileCountdown", () => {
  it("补零到 m:ss", () => {
    expect(formatReconcileCountdown(125_000)).toBe("2:05");
    expect(formatReconcileCountdown(60_000)).toBe("1:00");
    expect(formatReconcileCountdown(5_000)).toBe("0:05");
  });

  it("负数收敛到 0:00，不显示负号", () => {
    expect(formatReconcileCountdown(-1)).toBe("0:00");
  });
});
