import { describe, expect, it } from "vitest";
import type { LaunchCopyPreviewRecord } from "@tk-auto/core";
import { copyPreviewReadiness } from "./LaunchPage";

/**
 * 跨账户复制的原帖检查不再阻断创建：没授权到的原帖本来就复制不过去，执行时那一条
 * 自己失败即可。这里钉住「什么还该拦、什么不该拦」。
 */
const preview = (patch: Partial<LaunchCopyPreviewRecord> = {}) => ({
  items: [{ accountId: "target-1" }],
  blockers: [],
  warnings: [],
  safeToCreate: true,
  expiresAt: "2026-08-08T00:00:00.000Z",
} as unknown as LaunchCopyPreviewRecord);

const withPatch = (patch: Record<string, unknown>) =>
  ({ ...preview(), ...patch }) as unknown as LaunchCopyPreviewRecord;

describe("copyPreviewReadiness", () => {
  it("有可创建的条目就允许直接创建", () => {
    expect(copyPreviewReadiness(preview())).toEqual({ usable: true, blocker: null });
  });

  // 这是本次改动的核心：部分目标账户没授权到原帖，剩下的照常建。
  it("有阻断项但仍有可创建条目时照常允许", () => {
    const result = copyPreviewReadiness(withPatch({
      safeToCreate: false,
      blockers: ["目标账户“B”无法使用帖子 post-1。"],
    }));

    expect(result).toEqual({ usable: true, blocker: null });
  });

  // 过期只说明冻结的证据可能变旧，执行时会重新回读并逐条校验。
  it("预览过期不再阻断", () => {
    const result = copyPreviewReadiness(withPatch({
      expiresAt: "2000-01-01T00:00:00.000Z",
      safeToCreate: false,
    }));

    expect(result.usable).toBe(true);
  });

  it("一条可创建的条目都没有时仍然拦住，并说明原因", () => {
    const result = copyPreviewReadiness(withPatch({
      items: [],
      safeToCreate: false,
      blockers: ["目标账户“B”无法使用帖子 post-1。"],
    }));

    expect(result.usable).toBe(false);
    expect(result.blocker).toContain("没有产出任何可创建的广告组");
    // 具体原因要带出来，不能只说一句「有阻断项」。
    expect(result.blocker).toContain("无法使用帖子");
  });

  it("零条且没有阻断项时给出兜底说明", () => {
    const result = copyPreviewReadiness(withPatch({ items: [], blockers: [] }));

    expect(result.blocker).toContain("目标账户均无可用原帖");
  });

  it("还没生成预览时提示先生成", () => {
    expect(copyPreviewReadiness(null)).toEqual({
      usable: false,
      blocker: "请先生成并核对复制差异预览。",
    });
  });
});
