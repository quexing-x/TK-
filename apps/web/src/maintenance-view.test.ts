import { describe, expect, it } from "vitest";
import { backupKindLabel, signatureLabel, updateStateLabel } from "./MaintenancePage";

describe("maintenance presentation", () => {
  it("shows verified update and backup states in user language", () => {
    expect(signatureLabel("valid")).toBe("有效");
    expect(backupKindLabel("pre-upgrade")).toBe("升级前");
    expect(updateStateLabel({
      configured: true,
      state: "downloaded",
      currentVersion: "1.3.2",
      availableVersion: "1.3.3",
      signatureStatus: "valid",
      message: null,
      checkedAt: "2026-07-18T00:00:00.000Z",
    })).toBe("已验证待安装");
  });

  it("does not describe an invalid signature as installable", () => {
    expect(signatureLabel("invalid")).toBe("无效");
    expect(updateStateLabel({
      configured: true,
      state: "error",
      currentVersion: "1.3.2",
      availableVersion: "1.3.3",
      signatureStatus: "invalid",
      message: "签名校验失败",
      checkedAt: "2026-07-18T00:00:00.000Z",
    })).toBe("升级异常");
  });
});
