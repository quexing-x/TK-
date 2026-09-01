import { describe, expect, it } from "vitest";
import { belongsToBudgetKind, groupAdGroupsByCampaign, pickDefaultBudgetKind, resolveCampaignCopyLaunchTiming } from "./CopyCampaignPanel";

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

describe("复制系列的默认预算口径", () => {
  // 恒定默认「系列预算」对这些账户是错的：实测建德 142/142、余杭 29/29、般朵 34/34
  // 全是广告组预算，系列预算一条都没有。默认停在空 tab，用户就会以为「广告组预算的
  // 系列复制没有入口」。
  it("一侧为空时替用户停到有内容的那一侧", () => {
    expect(pickDefaultBudgetKind(0, 142)).toBe("adgroup");
    expect(pickDefaultBudgetKind(6, 0)).toBe("campaign");
  });

  // 两侧都有内容时不猜——猜错等于把用户从他要的那一栏挪走。
  it("两侧都有或都没有时保持原样", () => {
    expect(pickDefaultBudgetKind(6, 24)).toBeNull();
    expect(pickDefaultBudgetKind(0, 0)).toBeNull();
  });
});

describe("默认投放时机", () => {
  // 默认改成定时投放：复制出来的系列本来就是要投的，默认「关闭」等于每次都得多点一步，
  // 忘了点就是一批建好却不投的系列躺在后台。定时到最近的 06:00 由 TikTok 原生排期放行，
  // 不会在点下去的瞬间就开始花钱——这也是它比「立即投放」更适合做默认的原因。
  it("定时投放解析成 enabled + 排期时刻，而不是立刻开跑", () => {
    const now = new Date("2026-09-01T10:00:00.000Z");
    const result = resolveCampaignCopyLaunchTiming("scheduled", "2026-09-02T06:00", now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.initialStatus).toBe("enabled");
    expect(result.value.scheduledStartAt).not.toBeNull();
  });

  // 排期时刻过期时必须拦下来：TikTok 会直接拒收过期排期。
  it("过期的排期时刻被拒绝", () => {
    const now = new Date("2026-09-02T10:00:00.000Z");
    const result = resolveCampaignCopyLaunchTiming("scheduled", "2026-09-01T06:00", now);
    expect(result.ok).toBe(false);
  });
});

describe("按系列归堆广告组", () => {
  const group = (id: string, campaignId: string, ignored = false) => ({
    entityType: "ad-group" as const,
    externalId: id,
    name: id,
    status: "enabled" as const,
    parentCampaignId: campaignId,
    parentAdGroupId: null,
    campaignBudget: null,
    campaignBudgetOptimized: false,
    metrics: {} as never,
    ignored,
    syncedAt: "2026-09-01T00:00:00.000Z",
    automationManaged: false,
  });

  // 这条是本次改动的核心：ignored 的语义是「不让自动化规则动它」，不是「不让我手动
  // 复制它」。此前整片跳过，导致组全被接管过的系列显示「没有广告组」，怎么刷新都没用。
  it("人工接管的组照样归堆", () => {
    const map = groupAdGroupsByCampaign(
      [group("g1", "c1", true), group("g2", "c1")],
      ["c1"],
    );
    expect(map.get("c1")?.map((g) => g.externalId)).toEqual(["g1", "g2"]);
  });

  it("组全被接管的系列不再是空的", () => {
    const map = groupAdGroupsByCampaign([group("g1", "c1", true)], ["c1"]);
    expect(map.get("c1")).toHaveLength(1);
  });

  it("只归入被选中的系列，未选中的不建桶", () => {
    const map = groupAdGroupsByCampaign(
      [group("g1", "c1"), group("g2", "c2")],
      ["c1"],
    );
    expect(map.get("c1")).toHaveLength(1);
    expect(map.has("c2")).toBe(false);
  });

  it("缺少所属系列的组直接跳过", () => {
    const orphan = { ...group("g1", "c1"), parentCampaignId: null };
    const map = groupAdGroupsByCampaign([orphan], ["c1"]);
    expect(map.get("c1")).toHaveLength(0);
  });

  it("非广告组实体不参与归堆", () => {
    const campaign = { ...group("c1", "c1"), entityType: "campaign" as const };
    const map = groupAdGroupsByCampaign([campaign], ["c1"]);
    expect(map.get("c1")).toHaveLength(0);
  });
});
