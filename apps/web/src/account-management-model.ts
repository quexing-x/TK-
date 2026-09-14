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

/**
 * 账户时区下「今天」这一整天，转成接口要的 ISO 时刻区间。
 *
 * `accountLocalDate` 返回的是裸日期 `2026-09-15`，只适合展示和比较；直接丢给
 * metric-days 会被 AnalyticsQuerySchema 的 `z.string().datetime()` 判不合格，
 * 后端返回 400，账户列表的「今日消耗」就整列显示「读取失败」。
 *
 * 这两个边界是 **UTC 时刻**，不是当地墙上时间。后端拿它们去筛 `captured_at`
 * （一个 UTC 时间戳），再按账户时区折算自然日；所以必须把「当地 00:00 / 24:00」
 * 反解成真正的 UTC 时刻。简单地在裸日期后面接一个 `Z`（`2026-09-15T00:00:00Z`）
 * 对 UTC 账户看着没问题，但对 Asia/Shanghai 会整体偏 8 小时——当地 08:00 之前
 * 的消耗会被算到前一天，而当天早上的数据又落不进窗口，得到一份少一截的合计。
 *
 * 偏移按目标时刻实时计算，不写死：有夏令时的时区（如 America/Los_Angeles）
 * 冬夏差一小时，取当天正午做基准，可避开换季当天午夜附近的边界抖动。
 */
export function accountLocalDayRange(
  timezone: string,
  now = new Date(),
): { from: string; to: string } {
  // accountLocalDate 对无效时区名会直接抛 RangeError，所以这里先自行兜住，
  // 退回 UTC——脏数据（手填/迁移残留）不该让整列查询一起失败。
  let date: string;
  try {
    date = accountLocalDate(timezone, now);
  } catch {
    date = accountLocalDate("UTC", now);
  }
  // 用当天正午定位偏移：离午夜足够远，换季日的偏移切换不会落在这个采样点上。
  const noon = new Date(`${date}T12:00:00.000Z`);
  const offsetMinutes = resolveOffsetMinutes(timezone, noon);
  const startUtc = Date.parse(`${date}T00:00:00.000Z`) - offsetMinutes * 60_000;
  return {
    from: new Date(startUtc).toISOString(),
    to: new Date(startUtc + 24 * 60 * 60_000 - 1).toISOString(),
  };
}

/** 某个 IANA 时区在给定时刻相对 UTC 的偏移分钟数；时区名无效时退回 UTC。 */
function resolveOffsetMinutes(timeZone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at);
    const value = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value ?? "0");
    const asUtc = Date.UTC(
      value("year"), value("month") - 1, value("day"),
      value("hour"), value("minute"), value("second"),
    );
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return 0;
  }
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

/**
 * 当前处于「跌破余额告警阈值」状态的账户，供顶栏告警浮窗展示。
 *
 * 只信服务端维护的 balanceAlerted 状态（与群消息告警是同一状态机），不在前端
 * 重新拿阈值比较——两处口径一旦漂移，会出现「消息说没钱、浮窗不亮」或反之。
 * 有告警状态的账户若无余额快照（历史遗留），也照常列出，金额显示 —。
 */
export function balanceAlertAccounts(
  accounts: AccountConfig[],
  states: ConnectionMap,
): Array<{
  id: string;
  displayName: string;
  totalAmount: string | null;
  currency: string;
}> {
  return accounts
    .filter((account) => states[account.id]?.balanceAlerted === true)
    .map((account) => ({
      id: account.id,
      displayName: account.displayName,
      totalAmount: states[account.id]?.balance?.totalAmount ?? null,
      currency: states[account.id]?.balance?.currency ?? "",
    }));
}
