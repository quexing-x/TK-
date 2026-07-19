import { describe, expect, it } from "vitest";
import { syncQualityPresentation } from "./sync-quality-view";

describe("sync quality presentation", () => {
  it.each([
    ["partial", "部分可信", "warning"],
    ["stale", "已过期", "warning"],
    ["invalid", "契约失效", "danger"],
  ] as const)("shows %s as unsafe for automatic writes", (status, label, tone) => {
    expect(syncQualityPresentation(status)).toEqual({
      label,
      tone,
      automaticWritesAllowed: false,
    });
  });

  it("shows healthy data as the only automatic-write-safe state", () => {
    expect(syncQualityPresentation("healthy")).toEqual({
      label: "健康",
      tone: "active",
      automaticWritesAllowed: true,
    });
  });
});
