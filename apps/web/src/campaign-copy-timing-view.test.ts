import { describe, expect, it } from "vitest";
import { resolveCampaignCopyLaunchTiming } from "./CopyCampaignPanel";

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
