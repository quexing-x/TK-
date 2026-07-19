import type {
  AccountProviderCapabilities,
  ProviderCapability,
} from "@tk-auto/core";

export function hasProviderCapability(
  profile: AccountProviderCapabilities | undefined,
  capability: ProviderCapability,
): boolean {
  return profile?.capabilities.some((item) =>
    item.capability === capability && item.available,
  ) === true;
}

export function canUseCopySource(
  profile: AccountProviderCapabilities | undefined,
): boolean {
  return hasProviderCapability(profile, "read-campaigns")
    && hasProviderCapability(profile, "read-ads");
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
