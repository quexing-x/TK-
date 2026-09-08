import type { AccountConfig } from "@tk-auto/core";
import type { BootstrapPayload } from "./api";
import { accountAccessStatus } from "./provider-capability-view";

export type AccountConnectionState = BootstrapPayload["accountConnectionStates"][number];
export type ConnectionMap = Record<string, Omit<AccountConnectionState, "accountId">>;
export function accountHealth(state: ConnectionMap[string] | undefined) {
  return state ? accountAccessStatus(state) : { label: "待检测", tone: "warning" as const, connectionReady: false, readReady: false, createReady: false, statusReady: false, blockers: ["尚未取得账户接入状态。"] };
}
export function accountLocalDate(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map((key) => parts.find((p) => p.type === key)!.value).join("-");
}
export function filterManagedAccounts(accounts: AccountConfig[], states: ConnectionMap, query: string, platform: string, status: string, scope: string) {
  const term = query.trim().toLocaleLowerCase();
  return accounts.filter((a) => (!term || `${a.displayName} ${a.id}`.toLocaleLowerCase().includes(term))
    && (platform === "all" || a.platform === platform)
    && (status === "all" || accountHealth(states[a.id]).tone === status)
    && (scope === "all" || (scope === "enabled" ? a.enabled : !a.enabled)));
}
export const accountTypeNames = { standard: "普通广告账户", agency: "代理账户", shop: "TikTok Shop" };
export const providerNames = { cookie: "Cookie 会话", "official-api": "TikTok Marketing API" };
