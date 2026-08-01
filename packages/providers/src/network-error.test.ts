import { describe, expect, it } from "vitest";
import {
  describeErrorCause,
  isDefinitelyUnsentNetworkError,
  withCauseDetail,
} from "./network-error.js";

describe("describeErrorCause", () => {
  it("展开 undici 的 cause，而不是只留一句 fetch failed", () => {
    const underlying = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:10808"), {
      code: "ECONNREFUSED",
    });
    const failure = new Error("fetch failed", { cause: underlying });
    expect(describeErrorCause(failure)).toBe("ECONNREFUSED");
  });

  it("没有错误码时退回到 message 并截断", () => {
    const failure = new Error("fetch failed", {
      cause: new Error("x".repeat(400)),
    });
    expect(describeErrorCause(failure)).toHaveLength(120);
  });

  it("没有 cause 时返回空串", () => {
    expect(describeErrorCause(new Error("boom"))).toBe("");
  });

  it("串联多层 cause", () => {
    const inner = Object.assign(new Error("inner"), { code: "ENOTFOUND" });
    const middle = new Error("middle", { cause: inner });
    const outer = new Error("fetch failed", { cause: middle });
    expect(describeErrorCause(outer)).toBe("middle ← ENOTFOUND");
  });
});

describe("withCauseDetail", () => {
  it("有底层原因时附加在括号里", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const failure = new Error("fetch failed", { cause });
    expect(withCauseDetail("同系列复制失败", failure)).toBe("同系列复制失败（ECONNREFUSED）");
  });

  it("没有底层原因时原样返回", () => {
    expect(withCauseDetail("同系列复制失败", new Error("boom"))).toBe("同系列复制失败");
  });

  it("非 Error 时原样返回", () => {
    expect(withCauseDetail("同系列复制失败", "not an error")).toBe("同系列复制失败");
  });
});

describe("isDefinitelyUnsentNetworkError", () => {
  // 三个错误码用真实 fetch 实测过（node --version 24 内置 fetch/undici）：
  // ECONNREFUSED / ENOTFOUND 的顶层 error 是 TypeError("fetch failed")，
  // 真正的错误码在 error.cause.code 上，不在 error.code 上。
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
    it(`${code}：可以证明请求从未发出，判定为安全重试`, () => {
      const cause = Object.assign(new Error("underlying"), { code });
      const failure = new Error("fetch failed", { cause });
      expect(isDefinitelyUnsentNetworkError(failure)).toBe(true);
    });
  }

  it("ECONNRESET：连接已建立后才被重置，不能证明请求没发出，判定为不安全", () => {
    const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const failure = new Error("fetch failed", { cause });
    expect(isDefinitelyUnsentNetworkError(failure)).toBe(false);
  });

  it("真实超时：AbortSignal.timeout 触发的 TimeoutError 没有 cause，不能证明请求没发出", () => {
    // 实测过：AbortSignal.timeout 触发时 name 是 "TimeoutError"，message 是
    // "The operation was aborted due to timeout"，没有 .cause——完全不同于
    // "fetch failed" 那一类。连接可能已经建立、请求可能已经发出，只是本地
    // 等不到响应就放弃了，因此不能当作安全重试。
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    expect(isDefinitelyUnsentNetworkError(timeout)).toBe(false);
  });

  it("没有错误码时判定为不安全", () => {
    expect(isDefinitelyUnsentNetworkError(new Error("fetch failed"))).toBe(false);
  });

  it("非 Error 时判定为不安全", () => {
    expect(isDefinitelyUnsentNetworkError("not an error")).toBe(false);
  });
});
