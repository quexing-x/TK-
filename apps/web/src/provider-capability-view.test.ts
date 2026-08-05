import { describe, expect, it } from "vitest";
import type { AccountProviderCapabilities, ProviderConnection, ReadOnlySyncResult } from "@tk-auto/core";
import {
  accountAccessStatus,
  canEnableAccountAutomation,
  canUseCopySource,
  canUseLaunchTarget,
  hasProviderCapability,
  providerCapabilitySummary,
} from "./provider-capability-view";

const connection: ProviderConnection = {
  accountId: "account-1",
  kind: "cookie",
  settings: { kind: "cookie", advertiserId: "123", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
  hasCredential: true,
  status: "ready",
  authorizationStatus: "active",
  capabilityVersion: "cookie-v2",
  authorizedCapabilities: ["read-campaigns", "read-ad-groups", "change-status"],
  authorizedAt: "2026-07-18T00:00:00.000Z",
  authorizationExpiresAt: null,
  lastMessage: "ready",
  lastTestedAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

const latestSync: ReadOnlySyncResult = {
  startedAt: "2026-07-18T00:00:00.000Z",
  finishedAt: "2026-07-18T00:01:00.000Z",
  counts: { campaign: 1, "ad-group": 1, ad: 1 },
  warnings: [],
  quality: {
    status: "healthy",
    paginationComplete: true,
    requiredMetricsComplete: true,
    contractValid: true,
    providerContractVersion: "cookie-v2",
    coverage: { startDate: "2026-07-18", endDate: "2026-07-18", timezone: "Asia/Shanghai" },
    missingMetrics: [],
    partialFailures: [],
    lastHealthyAt: "2026-07-18T00:01:00.000Z",
  },
};

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

  // 删除曾经没有 label，被摘要的 filter 整条丢掉，界面上永远看不到"删除"，
  // 让已授权删除的账户看起来像缺了这项能力。
  it("shows the delete capability instead of silently dropping it", () => {
    const deleteProfile: AccountProviderCapabilities = {
      ...profile,
      capabilities: [
        ...profile.capabilities,
        { capability: "delete-ad-groups", available: true, reason: "当前账户可用。" },
      ],
    };

    expect(providerCapabilitySummary(deleteProfile)).toBe("读取 · 报表 · 启停 · 删除");
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

  it("does not call an account healthy when creation or copy is unavailable", () => {
    const access = accountAccessStatus({ connection, latestSync, capabilities: {
      ...profile,
      capabilities: [
        ...profile.capabilities,
        { capability: "read-ad-groups", available: true, reason: "当前账户可用。" },
      ],
    } });

    expect(access).toMatchObject({
      tone: "warning",
      label: "待完善",
      readReady: true,
      statusReady: true,
      createReady: false,
      copyReady: false,
      recovery: "recheck",
    });
    expect(access.blockers).toContain("需要重新检测。");
  });

  it("uses the same healthy result only when every operational lane is ready", () => {
    const complete = {
      ...profile,
      capabilities: [
        ...profile.capabilities.map((item) => ({ ...item, available: true })),
        { capability: "read-ad-groups" as const, available: true, reason: "当前账户可用。" },
        { capability: "copy-ads" as const, available: true, reason: "当前账户可用。" },
      ],
    };
    expect(accountAccessStatus({ connection, latestSync, capabilities: complete })).toMatchObject({
      tone: "healthy",
      label: "健康",
      recovery: null,
    });
  });
});
