import { describe, expect, it } from "vitest";
import { belongsToBudgetKind, resolveCampaignCopyLaunchTiming } from "./CopyCampaignPanel";

const now = new Date("2026-08-01T10:00:00.000Z");

/** datetime-local 的取值是不带时区的本地墙钟时间；测试同样按本地时区推导，避免与测试机时区耦合出错。 */
function toDatetimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe("resolveCampaignCopyLaunchTiming", () => {
  it("关闭：创建后暂停，不设定时", () => {
    const result = resolveCampaignCopyLaunchTiming("disabled", "", now);
    expect(result).toEqual({ ok: true, value: { initialStatus: "disabled", scheduledStartAt: null } });
  });

  it("立即投放：创建后开启，不设定时", () => {
    const result = resolveCampaignCopyLaunchTiming("immediate", "", now);
    expect(result).toEqual({ ok: true, value: { initialStatus: "enabled", scheduledStartAt: null } });
  });

  it("定时投放：合法的未来时间转成 ISO 并强制开启状态", () => {
    // datetime-local 的值按运行环境本地时区解析，因此期望值也用同样的方式算出，
    // 不写死 UTC 字符串，避免测试机时区不同导致误判。
    const localFuture = "2026-08-02T06:00";
    const expectedIso = new Date(localFuture).toISOString();
    const result = resolveCampaignCopyLaunchTiming("scheduled", localFuture, now);
    expect(result).toEqual({
      ok: true,
      value: { initialStatus: "enabled", scheduledStartAt: expectedIso },
    });
  });

  it("定时投放：非法日期在发出任何请求前就报错", () => {
    const result = resolveCampaignCopyLaunchTiming("scheduled", "not-a-date", now);
    expect(result).toEqual({ ok: false, error: "请填写有效的定时投放时间。" });
  });

  it("定时投放：不晚于当前时间也在发出任何请求前就报错", () => {
    const minuteAgoLocal = toDatetimeLocal(new Date(now.getTime() - 60_000));
    const past = resolveCampaignCopyLaunchTiming("scheduled", minuteAgoLocal, now);
    expect(past).toEqual({ ok: false, error: "定时投放时间必须晚于当前时间。" });

    const exactlyNow = resolveCampaignCopyLaunchTiming("scheduled", toDatetimeLocal(now), now);
    expect(exactlyNow.ok).toBe(false);
  });
});

// 系列复制拆成两个入口后，「哪个系列出现在哪个入口下」是新的分流点。分错的后果不是
// 报错，而是用户在错的口径下填了「系列日预算」——对组预算的系列而言那个值静默失效。
describe("系列复制的两个入口", () => {
  const modes = (
    optimized: Record<string, boolean>,
    undetermined: string[] = [],
  ) => ({
    optimizedByCampaignId: new Map(Object.entries(optimized)),
    undeterminedCampaignIds: new Set(undetermined),
  });

  it("系列预算的系列只出现在系列预算入口", () => {
    const m = modes({ cbo: true });

    expect(belongsToBudgetKind("campaign", "cbo", m)).toBe(true);
    expect(belongsToBudgetKind("adgroup", "cbo", m)).toBe(false);
  });

  it("广告组预算的系列只出现在广告组预算入口", () => {
    const m = modes({ abo: false });

    expect(belongsToBudgetKind("campaign", "abo", m)).toBe(false);
    expect(belongsToBudgetKind("adgroup", "abo", m)).toBe(true);
  });

  // 判定依据不足时用户比我们清楚，藏起来它就彻底够不着了。代价是两边都露面，所以
  // 列表项上标了「预算方式未知」。
  it("预算方式未知的系列两个入口下都出现", () => {
    const m = modes({ unknown: false }, ["unknown"]);

    expect(belongsToBudgetKind("campaign", "unknown", m)).toBe(true);
    expect(belongsToBudgetKind("adgroup", "unknown", m)).toBe(true);
  });

  // 快照里没有这个系列时不能默认归到系列预算：那会让它带上一个并不存在的系列预算框。
  it("完全没有记录的系列按广告组预算处理", () => {
    const m = modes({});

    expect(belongsToBudgetKind("campaign", "missing", m)).toBe(false);
    expect(belongsToBudgetKind("adgroup", "missing", m)).toBe(true);
  });
});
