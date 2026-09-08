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

export function applyAccountPlatformSelection(
  form: AccountCreateInput,
  platform: PlatformKind,
): AccountCreateInput {
  return { ...form, platform, providerKind: "cookie" };
}
