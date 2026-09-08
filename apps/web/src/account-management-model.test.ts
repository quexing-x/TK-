import { describe, expect, it } from "vitest";
import type { AccountConfig } from "@tk-auto/core";
import { accountHealth, accountLocalDate, filterManagedAccounts } from "./account-management-model";

describe("production account list", () => {
  const accounts = [
    { id: "abc-01", displayName: "SEA 主账户", platform: "tiktok", enabled: true },
    { id: "abc-02", displayName: "余杭茵未-24HP", platform: "tiktok", enabled: false },
  ] as AccountConfig[];
  it("uses account timezone across UTC day boundaries", () => {
    const now = new Date("2026-09-06T01:00:00Z");
    expect(accountLocalDate("Asia/Shanghai", now)).toBe("2026-09-06");
    expect(accountLocalDate("America/Los_Angeles", now)).toBe("2026-09-05");
  });
  it("combines text, platform, health and automation scope filters", () => {
    expect(filterManagedAccounts(accounts, {}, " ABC-01 ", "tiktok", "warning", "enabled")).toEqual([accounts[0]]);
    expect(filterManagedAccounts(accounts, {}, "", "tiktok", "all", "disabled")).toEqual([accounts[1]]);
    // 交叉条件必须同时成立：文字命中 SEA 主账户，但它是 enabled，筛 disabled 就该落空。
    // （原来这条用 platform="meta" 制造不匹配，Meta 移除后改用自动化范围这一维。）
    expect(filterManagedAccounts(accounts, {}, "SEA", "tiktok", "all", "disabled")).toEqual([]);
    expect(filterManagedAccounts(accounts, {}, "", "all", "healthy", "all")).toEqual([]);
  });
  it("does not invent healthy status when connection state is missing", () => {
    expect(accountHealth(undefined)).toMatchObject({ label: "待检测", tone: "warning", readReady: false, createReady: false });
  });
});
