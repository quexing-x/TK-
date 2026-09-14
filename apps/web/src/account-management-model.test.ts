import { describe, expect, it } from "vitest";
import type { AccountConfig } from "@tk-auto/core";
import { accountHealth, accountLocalDate, accountLocalDayRange, balanceAlertAccounts, filterManagedAccounts } from "./account-management-model";

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

  /**
   * 「今日消耗」整列显示「读取失败」的回归测试。
   *
   * accountLocalDate 返回裸日期，直接当查询区间发给 metric-days 会被后端的
   * `z.string().datetime()` 判不合格 → 400。这里钉死两点：必须是可解析的完整
   * ISO datetime，且必须是把当地一整天换算出来的 UTC 时刻区间。
   */
  describe("accountLocalDayRange", () => {
    it("产出完整 ISO datetime，而不是后端的 400 会拒掉的裸日期", () => {
      const range = accountLocalDayRange("Asia/Shanghai", new Date("2026-09-06T01:00:00Z"));
      expect(range.from).not.toBe("2026-09-06");
      expect(Number.isNaN(Date.parse(range.from))).toBe(false);
      expect(Number.isNaN(Date.parse(range.to))).toBe(false);
      // 后端用 z.string().datetime() 校验，必须带时区标记。
      expect(range.from).toMatch(/Z$|[+-]\d{2}:\d{2}$/);
      expect(range.to).toMatch(/Z$|[+-]\d{2}:\d{2}$/);
    });

    it("把账户当地的 00:00–24:00 换算成 UTC 时刻，而不是直接当成 UTC", () => {
      // 上海比 UTC 快 8 小时：当地 09-06 一整天 = UTC 09-05T16:00 ~ 09-06T15:59:59.999。
      // 若错误地写成 09-06T00:00Z，当天 08:00 前的消耗会被漏掉，早上的数据也会算错日。
      const range = accountLocalDayRange("Asia/Shanghai", new Date("2026-09-06T01:00:00Z"));
      expect(range.from).toBe("2026-09-05T16:00:00.000Z");
      expect(range.to).toBe("2026-09-06T15:59:59.999Z");
    });

    it("UTC 账户的窗口就是当天 UTC 整天", () => {
      const range = accountLocalDayRange("UTC", new Date("2026-09-06T01:00:00Z"));
      expect(range.from).toBe("2026-09-06T00:00:00.000Z");
      expect(range.to).toBe("2026-09-06T23:59:59.999Z");
    });

    it("有夏令时的时区按当天实际偏移换算", () => {
      // 洛杉矶夏令时（PDT, UTC-7）：当地 07-15 一整天 = UTC 07-15T07:00 ~ 07-16T06:59:59.999。
      const summer = accountLocalDayRange("America/Los_Angeles", new Date("2026-07-15T20:00:00Z"));
      expect(summer.from).toBe("2026-07-15T07:00:00.000Z");
      // 冬令时（PST, UTC-8）：当地 01-15 一整天 = UTC 01-15T08:00 ~ 01-16T07:59:59.999。
      const winter = accountLocalDayRange("America/Los_Angeles", new Date("2026-01-15T20:00:00Z"));
      expect(winter.from).toBe("2026-01-15T08:00:00.000Z");
    });

    it("时区名无效时退回 UTC，不让整列查询失败", () => {
      const range = accountLocalDayRange("Not/AZone", new Date("2026-09-06T01:00:00Z"));
      expect(Number.isNaN(Date.parse(range.from))).toBe(false);
      expect(range.from).toBe("2026-09-06T00:00:00.000Z");
    });
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

  describe("balanceAlertAccounts", () => {
    it("只列服务端标记为跌破阈值的账户，带名称与原币金额", () => {
      const list = [
        { id: "low", displayName: "余杭茵未-24HP", platform: "tiktok", enabled: true },
        { id: "fine", displayName: "纵姿0830-1", platform: "tiktok", enabled: true },
      ] as never;
      const states = {
        low: { balance: { totalAmount: "139.50", currency: "USD" }, balanceAlerted: true },
        fine: { balance: { totalAmount: "371.61", currency: "USD" }, balanceAlerted: false },
      } as never;
      expect(balanceAlertAccounts(list, states)).toEqual([
        { id: "low", displayName: "余杭茵未-24HP", totalAmount: "139.50", currency: "USD" },
      ]);
    });

    it("有告警状态但快照缺失的账户照常列出，金额为 null（浮窗显示 —）", () => {
      const list = [{ id: "x", displayName: "纵姿0918-1", platform: "tiktok", enabled: true }] as never;
      const states = { x: { balanceAlerted: true } } as never;
      expect(balanceAlertAccounts(list, states)).toEqual([
        { id: "x", displayName: "纵姿0918-1", totalAmount: null, currency: "" },
      ]);
    });

    it("没有标记的账户一律不出现，哪怕它有余额", () => {
      const list = [{ id: "y", displayName: "健康账户", platform: "tiktok", enabled: true }] as never;
      expect(balanceAlertAccounts(list, { y: { balance: { totalAmount: "300" } } } as never)).toEqual([]);
    });
  });
});
