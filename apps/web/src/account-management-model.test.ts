import { describe, expect, it } from "vitest";
import type { AccountConfig } from "@tk-auto/core";
import { accountHealth, accountLocalDate, filterManagedAccounts } from "./account-management-model";

describe("production account list", () => {
  const accounts = [
    { id: "abc-01", displayName: "SEA 主账户", platform: "tiktok", enabled: true },
    { id: "abc-02", displayName: "Meta 备用", platform: "meta", enabled: false },
  ] as AccountConfig[];
  it("uses account timezone across UTC day boundaries", () => {
    const now = new Date("2026-09-06T01:00:00Z");
    expect(accountLocalDate("Asia/Shanghai", now)).toBe("2026-09-06");
    expect(accountLocalDate("America/Los_Angeles", now)).toBe("2026-09-05");
  });
  it("combines text, platform, health and automation scope filters", () => {
    expect(filterManagedAccounts(accounts, {}, " ABC-01 ", "tiktok", "warning", "enabled")).toEqual([accounts[0]]);
    expect(filterManagedAccounts(accounts, {}, "", "meta", "all", "disabled")).toEqual([accounts[1]]);
    expect(filterManagedAccounts(accounts, {}, "SEA", "meta", "all", "all")).toEqual([]);
    expect(filterManagedAccounts(accounts, {}, "", "all", "healthy", "all")).toEqual([]);
  });
  it("does not invent healthy status when connection state is missing", () => {
    expect(accountHealth(undefined)).toMatchObject({ label: "待检测", tone: "warning", readReady: false, createReady: false });
  });
});
