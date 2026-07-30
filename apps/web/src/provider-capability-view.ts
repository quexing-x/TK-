import type {
  AccountProviderCapabilities,
  ProviderConnection,
  ProviderCapability,
  ReadOnlySyncResult,
} from "@tk-auto/core";

export type AccountAccessTone = "healthy" | "warning" | "danger";

export interface AccountAccessState {
  connection: ProviderConnection | null;
  latestSync: ReadOnlySyncResult | null;
  capabilities: AccountProviderCapabilities;
}

export interface AccountAccessStatus {
  tone: AccountAccessTone;
  label: "健康" | "待完善" | "异常";
  connectionReady: boolean;
  readReady: boolean;
  statusReady: boolean;
  createReady: boolean;
  copyReady: boolean;
  blockers: string[];
  recovery: "connect" | "recheck" | "sync" | null;
}

export function hasProviderCapability(
  profile: AccountProviderCapabilities | undefined,
  capability: ProviderCapability,
): boolean {
  return profile?.capabilities.some((item) =>
    item.capability === capability && item.available,
  ) === true;
}

export function providerCapabilityReason(
  profile: AccountProviderCapabilities | undefined,
  capability: ProviderCapability,
): string {
  return profile?.capabilities.find((item) => item.capability === capability)?.reason
    ?? "能力状态尚未同步。";
}

/**
 * Canonical account access state for every UI surface. "Healthy" means the
 * account can read, change status, create and copy with a healthy snapshot;
 * individual pages may still require only a subset, but must not redefine the
 * account's overall health independently.
 */
export function accountAccessStatus(state: AccountAccessState): AccountAccessStatus {
  const { connection, latestSync, capabilities } = state;
  const authorizationFailed = ["expired", "revoked", "failed"].includes(
    capabilities.authorizationStatus,
  );
  const connectionReady = connection?.status === "ready"
    && capabilities.authorizationStatus === "active";
  const readCapabilityReady = hasProviderCapability(capabilities, "read-campaigns")
    && hasProviderCapability(capabilities, "read-ad-groups");
  const readReady = connectionReady
    && readCapabilityReady
    && latestSync?.quality.status === "healthy";
  const statusReady = connectionReady && hasProviderCapability(capabilities, "change-status");
  const createReady = connectionReady && hasProviderCapability(capabilities, "create-campaigns");
  const copyReady = connectionReady && hasProviderCapability(capabilities, "copy-ads");
  const blockers: string[] = [];

  if (!connection) {
    blockers.push("尚未建立账户接入。");
  } else if (connection.status !== "ready" || authorizationFailed) {
    blockers.push(connection.lastMessage || "账户连接未通过检测。");
  }
  if (connectionReady && !readCapabilityReady) {
    blockers.push(providerCapabilityReason(capabilities, "read-ad-groups"));
  } else if (connectionReady && !latestSync) {
    blockers.push("尚未完成只读同步。");
  } else if (connectionReady && latestSync?.quality.status !== "healthy") {
    blockers.push(`最近同步状态为 ${latestSync?.quality.status ?? "unknown"}。`);
  }
  for (const capability of ["change-status", "create-campaigns", "copy-ads"] as const) {
    if (connectionReady && !hasProviderCapability(capabilities, capability)) {
      blockers.push(providerCapabilityReason(capabilities, capability));
    }
  }

  const uniqueBlockers = [...new Set(blockers)];
  const failed = !connection || connection.status === "failed" || authorizationFailed;
  const fullyReady = readReady && statusReady && createReady && copyReady;
  const recovery = !connection?.hasCredential
    ? "connect" as const
    : !connectionReady || !statusReady || !createReady || !copyReady
      ? "recheck" as const
      : !readReady
        ? "sync" as const
        : null;

  return {
    tone: failed ? "danger" : fullyReady ? "healthy" : "warning",
    label: failed ? "异常" : fullyReady ? "健康" : "待完善",
    connectionReady,
    readReady,
    statusReady,
    createReady,
    copyReady,
    blockers: uniqueBlockers,
    recovery,
  };
}

export function canUseCopySource(
  profile: AccountProviderCapabilities | undefined,
): boolean {
  return hasProviderCapability(profile, "read-campaigns")
    && hasProviderCapability(profile, "read-ad-groups");
}

export function canUseLaunchTarget(
  profile: AccountProviderCapabilities | undefined,
  _mode: "create" | "copy",
): boolean {
  // Cross-account migration recreates the frozen source structure with the
  // target account's own asset IDs. It is a create operation, not TikTok's
  // same-account template-copy operation.
  return hasProviderCapability(profile, "create-campaigns");
}

export function canEnableAccountAutomation(
  profile: AccountProviderCapabilities | undefined,
): boolean {
  return hasProviderCapability(profile, "read-campaigns")
    && hasProviderCapability(profile, "change-status");
}

export function providerCapabilitySummary(
  profile: AccountProviderCapabilities | undefined,
): string {
  if (!profile) return "能力状态待同步";
  const labels: Partial<Record<ProviderCapability, string>> = {
    "read-campaigns": "读取",
    "read-reports": "报表",
    "change-status": "启停",
    "create-campaigns": "创建",
    "copy-ads": "复制",
    "appeal-ads": "申诉",
  };
  const available = profile.capabilities
    .filter((item) => item.available && labels[item.capability])
    .map((item) => labels[item.capability]);
  return available.length > 0 ? available.join(" · ") : "当前无可用能力";
}
