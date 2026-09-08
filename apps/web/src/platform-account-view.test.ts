import { describe, expect, it } from "vitest";
import type { AccountConfig, AccountCreateInput } from "@tk-auto/core";
import {
  applyAccountPlatformSelection,
  filterTikTokOperationalAccounts,
} from "./platform-account-view";

const account = (over: Partial<AccountConfig> = {}): AccountConfig => ({
  id: "acc-1",
  displayName: "纵姿-251128-1",
  platform: "tiktok",
  accountType: "standard",
  enabled: true,
  providerKind: "cookie",
  credentialRef: null,
  timezone: "Asia/Shanghai",
  pollingIntervalMinutes: 5,
  maxActionsPerRun: 15,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
} as AccountConfig);

describe("platform account view", () => {
  it("只放行 TikTok 账户", () => {
    const accounts = [
      account({ id: "a" }),
      account({ id: "b", displayName: "余杭茵未-24HP" }),
    ];

    expect(filterTikTokOperationalAccounts(accounts).map((item) => item.id))
      .toEqual(["a", "b"]);
    expect(filterTikTokOperationalAccounts([])).toEqual([]);
  });

  // Meta 移除后这里只剩一条路径，但选择动作仍然要把 providerKind 落到 cookie：
  // 表单可能带着上一次编辑残留的值，不重置会建出一个平台与接入方式不匹配的账户，
  // 而那个组合会被 AccountCreateInputSchema 直接拒掉。
  it("选择平台后把接入方式重置为 Cookie", () => {
    const form = {
      displayName: "新账户",
      platform: "tiktok",
      accountType: "standard",
      enabled: true,
      providerKind: "official-api",
    } as AccountCreateInput;

    expect(applyAccountPlatformSelection(form, "tiktok")).toMatchObject({
      platform: "tiktok",
      providerKind: "cookie",
      displayName: "新账户",
      enabled: true,
    });
  });
});
