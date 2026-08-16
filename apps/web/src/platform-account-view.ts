import type {
  AccountConfig,
  AccountCreateInput,
  PlatformKind,
} from "@tk-auto/core";

export function filterTikTokOperationalAccounts(
  accounts: readonly AccountConfig[],
): AccountConfig[] {
  return accounts.filter((account) => account.platform === "tiktok");
}

export function filterMetaAccounts(
  accounts: readonly AccountConfig[],
): AccountConfig[] {
  return accounts.filter((account) => account.platform === "meta");
}

export function applyAccountPlatformSelection(
  form: AccountCreateInput,
  platform: PlatformKind,
): AccountCreateInput {
  return {
    ...form,
    platform,
    enabled: platform === "meta" ? false : form.enabled,
    accountType: platform === "meta" && form.accountType === "shop"
      ? "standard"
      : form.accountType,
    providerKind: platform === "meta" ? "meta-marketing-api" : "cookie",
  };
}
