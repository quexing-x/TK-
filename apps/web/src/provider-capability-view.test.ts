import { describe, expect, it } from "vitest";
import type { AccountProviderCapabilities } from "@tk-auto/core";
import {
  canEnableAccountAutomation,
  canUseCopySource,
  canUseLaunchTarget,
  hasProviderCapability,
  providerCapabilitySummary,
} from "./provider-capability-view";

const profile: AccountProviderCapabilities = {
  accountId: "account-1",
  providerKind: "cookie",
  providerDisplayName: "Cookie 会话",
  capabilityVersion: "cookie-v2",
  authorizationStatus: "active",
  authorizedAt: "2026-07-18T00:00:00.000Z",
  authorizationExpiresAt: null,
  capabilities: [
    { capability: "read-campaigns", available: true, reason: "当前账户可用。" },
    { capability: "read-reports", available: true, reason: "当前账户可用。" },
    { capability: "change-status", available: true, reason: "当前账户可用。" },
    { capability: "create-campaigns", available: false, reason: "需要重新检测。" },
  ],
};

describe("provider capability presentation", () => {
  it("shows only capabilities available to the selected account", () => {
    expect(providerCapabilitySummary(profile)).toBe("读取 · 报表 · 启停");
    expect(hasProviderCapability(profile, "create-campaigns")).toBe(false);
    expect(hasProviderCapability(profile, "change-status")).toBe(true);
  });

  it("does not claim capabilities before account state is loaded", () => {
    expect(providerCapabilitySummary(undefined)).toBe("能力状态待同步");
    expect(hasProviderCapability(undefined, "create-campaigns")).toBe(false);
  });

  it("keeps creation, copy source, copy target and automation contracts separate", () => {
    const copyProfile: AccountProviderCapabilities = {
      ...profile,
      capabilities: [
        ...profile.capabilities,
        { capability: "read-ad-groups", available: true, reason: "当前账户可用。" },
        { capability: "copy-ads", available: true, reason: "当前账户可用。" },
      ],
    };

    expect(canUseCopySource(copyProfile)).toBe(true);
    expect(canUseLaunchTarget(copyProfile, "copy")).toBe(false);
    expect(canUseLaunchTarget(copyProfile, "create")).toBe(false);
    const migrationTargetProfile: AccountProviderCapabilities = {
      ...copyProfile,
      capabilities: copyProfile.capabilities.map((item) =>
        item.capability === "create-campaigns"
          ? { ...item, available: true }
          : item.capability === "copy-ads"
            ? { ...item, available: false }
            : item,
      ),
    };
    expect(canUseLaunchTarget(migrationTargetProfile, "copy")).toBe(true);
    expect(canEnableAccountAutomation(copyProfile)).toBe(true);
    expect(canEnableAccountAutomation({
      ...copyProfile,
      capabilities: copyProfile.capabilities.filter((item) => item.capability !== "change-status"),
    })).toBe(false);
  });
});
