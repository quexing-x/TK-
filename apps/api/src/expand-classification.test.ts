import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationStore } from "@tk-auto/storage";
import { InMemoryCredentialVault } from "@tk-auto/credentials";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";

function syncQuality(finishedAt: string) {
  return {
    status: "healthy" as const,
    paginationComplete: true,
    requiredMetricsComplete: true,
    contractValid: true,
    providerContractVersion: "test-v1",
    coverage: { startDate: "2026-08-25", endDate: "2026-08-26", timezone: "Asia/Shanghai" },
    missingMetrics: [],
    partialFailures: [],
    lastHealthyAt: finishedAt,
  };
}

interface SeedCampaign {
  externalId: string;
  name: string;
  /** 省略即视为投放中。仓库开了 exactOptionalPropertyTypes，显式写出 undefined。 */
  enabled?: boolean | undefined;
  spend: number;
  conversions: number;
  /** 组被规则全部关停。零转化时会走「不看消耗直接判重扩」那条。 */
  adGroupsStopped?: boolean | undefined;
}

describe("扩组分类接口", () => {
  let store: AutomationStore;
  let app: FastifyInstance;
  let vault: InMemoryCredentialVault;

  // demo-account 的时区是 Asia/Shanghai，TikTok 报表按账户本地日日切（本地 00:00 =
  // UTC 16:00）。这两个时刻刻意落在**不同的上海日**、且都在上海日切之后，这样两轮
  // 快照才会被算成两天分别累加；挑成同一上海日的话累计只会取到后一条。
  const DAY_ONE = "2026-08-25T02:00:00.000Z"; // 上海 08-25 10:00
  const DAY_TWO = "2026-08-26T02:00:00.000Z"; // 上海 08-26 10:00

  function seedDay(finishedAt: string, campaigns: SeedCampaign[]) {
    // 每条系列默认配一个在投的广告组。「组已被规则关光」是另一条判据（零转化时不看
    // 消耗直接判重扩），不给组的话所有系列都会落进那条，本文件其它用例就全失真了。
    const entities = [
      ...campaigns.map((campaign) => ({
        entityType: "campaign" as const,
        externalId: campaign.externalId,
        payload: {
          campaign_name: campaign.name,
          campaign_primary_status: campaign.enabled === false ? "disable" : "enable",
          stat_cost: String(campaign.spend),
          time_attr_convert_cnt: String(campaign.conversions),
        },
      })),
      ...campaigns.map((campaign) => ({
        entityType: "ad-group" as const,
        externalId: `${campaign.externalId}-g1`,
        payload: {
          campaign_id: campaign.externalId,
          adgroup_name: `${campaign.name}-组1`,
          ad_primary_status: campaign.adGroupsStopped ? "disable" : "enable",
        },
      })),
    ];
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      entities,
      {
        startedAt: finishedAt,
        finishedAt,
        counts: { campaign: campaigns.length, "ad-group": campaigns.length, ad: 0, material: 0 },
        warnings: [],
        quality: syncQuality(finishedAt),
      },
    );
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T06:00:00.000Z"));
    store = new AutomationStore(":memory:");
    store.seed();
    vault = new InMemoryCredentialVault();
    app = await createApp({ store, vault, disableAuth: true });
  });

  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  async function classify(query = "") {
    const response = await app.inject({
      method: "GET",
      url: `/api/accounts/demo-account/expand-classification${query}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      computedAt: string;
      thresholds: {
        maxCostPerConversion: number;
        maxSpendWithoutConversion: number;
        maxConsecutiveZeroConversionDays: number;
      };
      expand: Array<{ externalId: string; reason: string; spend: number; conversions: number; costPerConversion: number | null; hasActiveAdGroups: boolean | null; recreatedToday: boolean }>;
      recreateCampaign: Array<{ externalId: string; reason: string; spend: number; conversions: number; hasActiveAdGroups: boolean | null; recreatedToday: boolean }>;
      excluded: Array<{ externalId: string; reason: string }>;
    };
  }

  it("按自创建以来累计判定，并分成三桶", async () => {
    const day = (spendOne: number, convOne: number, spendTwo: number, convTwo: number) =>
      [spendOne, convOne, spendTwo, convTwo] as const;
    const plan: Array<[string, string, ReturnType<typeof day>, boolean?]> = [
      // 累计 24 / 3 转 -> 单转 8，达标
      ["camp-ok", "达标系列", day(10, 1, 14, 2)],
      // 累计 30 / 1 转 -> 单转 30，超标
      ["camp-high", "单转超标系列", day(10, 0, 20, 1)],
      // 累计 5 / 0 转 -> 超过零转化上限 3
      ["camp-zero-over", "零转化花超系列", day(2, 0, 3, 0)],
      // 累计 2 / 0 转 -> 还在观察期
      ["camp-zero-observe", "零转化观察系列", day(1, 0, 1, 0)],
      // 已关停：花得再多也不判，因为没有可做的动作
      ["camp-off", "已关停系列", day(50, 0, 50, 0), false],
      ["camp-diagnostic", "诊断0823E-选25到34", day(9, 0, 9, 0)],
    ];

    for (const [index, finishedAt] of [DAY_ONE, DAY_TWO].entries()) {
      seedDay(finishedAt, plan.map(([externalId, name, values, enabled]) => ({
        externalId,
        name,
        enabled,
        spend: index === 0 ? values[0] : values[2],
        conversions: index === 0 ? values[1] : values[3],
      })));
    }

    const body = await classify();

    expect(body.expand.map((item) => item.externalId)).toEqual([
      "camp-ok",
      "camp-zero-observe",
    ]);
    expect(body.recreateCampaign.map((item) => item.externalId)).toEqual([
      "camp-high",
      "camp-zero-over",
    ]);
    expect(body.excluded.map((item) => item.externalId).sort()).toEqual([
      "camp-diagnostic",
      "camp-off",
    ]);

    // 累计确实是两天相加，不是只取最后一天。
    const ok = body.expand.find((item) => item.externalId === "camp-ok");
    expect(ok?.spend).toBeCloseTo(24, 5);
    expect(ok?.conversions).toBe(3);
    expect(ok?.costPerConversion).toBeCloseTo(8, 5);
    expect(ok?.reason).toBe("cost-per-conversion-ok");

    expect(body.recreateCampaign.find((item) => item.externalId === "camp-high")?.reason)
      .toBe("cost-per-conversion-high");
    expect(body.recreateCampaign.find((item) => item.externalId === "camp-zero-over")?.reason)
      .toBe("no-conversion-overspent");
    expect(body.excluded.find((item) => item.externalId === "camp-off")?.reason)
      .toBe("not-enabled");
    expect(body.excluded.find((item) => item.externalId === "camp-diagnostic")?.reason)
      .toBe("non-operational");
  });

  it("默认阈值是 12 / 3，可由查询参数覆盖", async () => {
    seedDay(DAY_TWO, [
      { externalId: "camp-ten", name: "单转十块", spend: 10, conversions: 1 },
      { externalId: "camp-two", name: "零转化两块", spend: 2, conversions: 0 },
    ]);

    const relaxed = await classify();
    expect(relaxed.thresholds).toEqual({
      maxCostPerConversion: 12,
      maxSpendWithoutConversion: 3,
      maxConsecutiveZeroConversionDays: 3,
    });
    expect(relaxed.expand.map((item) => item.externalId).sort())
      .toEqual(["camp-ten", "camp-two"]);

    const strict = await classify("?maxCostPerConversion=8&maxSpendWithoutConversion=1");
    expect(strict.thresholds).toEqual({
      maxCostPerConversion: 8,
      maxSpendWithoutConversion: 1,
      maxConsecutiveZeroConversionDays: 3,
    });
    expect(strict.expand).toHaveLength(0);
    expect(strict.recreateCampaign.map((item) => item.externalId).sort())
      .toEqual(["camp-ten", "camp-two"]);
  });

  // 转化是延迟回传的，同一天早晚两次算出来的分桶会不一样。界面必须能说清「你看的
  // 是几点的账」，否则用户没法判断该不该信。
  it("返回计算时刻", async () => {
    seedDay(DAY_TWO, [{ externalId: "camp", name: "系列", spend: 1, conversions: 0 }]);
    expect((await classify()).computedAt).toBe("2026-08-26T06:00:00.000Z");
  });

  // listManagedEntities 不筛 is_current，用它会把已经下线的系列顶着历史累计带进判定
  // 结果。这类系列在账户里已经不存在，扩不扩都无从谈起，出现在名单上只会误导。
  it("已下线的系列不出现在判定结果里", async () => {
    seedDay(DAY_ONE, [
      { externalId: "camp-live", name: "还在的系列", spend: 24, conversions: 3 },
      { externalId: "camp-gone", name: "已下线的系列", spend: 40, conversions: 0 },
    ]);
    // 后一轮同步不再返回 camp-gone，它会被置为 is_current = 0。
    seedDay(DAY_TWO, [
      { externalId: "camp-live", name: "还在的系列", spend: 0, conversions: 0 },
    ]);

    const body = await classify();
    const everyId = [...body.expand, ...body.recreateCampaign, ...body.excluded]
      .map((item) => item.externalId);
    expect(everyId).toContain("camp-live");
    expect(everyId).not.toContain("camp-gone");
  });

  it("组被规则关光的零转化系列，不看消耗直接判重扩", async () => {
    seedDay(DAY_TWO, [
      // 花得很少，按消耗阈值本来还在观察期；但组已被规则全部关停，系列再也花不出钱，
      // 那条 spend > 3 的线永远跨不过去，会永久卡在「观察中」从名单里静默消失。
      { externalId: "camp-stalled", name: "停跑系列", spend: 1, conversions: 0, adGroupsStopped: true },
      // 组还在跑，同样的消耗仍属观察期。
      { externalId: "camp-running", name: "在跑系列", spend: 1, conversions: 0 },
      // 从没花过钱：无在投组只是还没开始投，不是跑不出来。
      { externalId: "camp-fresh", name: "新建未投系列", spend: 0, conversions: 0, adGroupsStopped: true },
    ]);

    const body = await classify();
    const stalled = body.recreateCampaign.find((item) => item.externalId === "camp-stalled");
    expect(stalled?.reason).toBe("no-conversion-stalled");
    expect(stalled?.hasActiveAdGroups).toBe(false);

    expect(body.expand.map((item) => item.externalId).sort())
      .toEqual(["camp-fresh", "camp-running"]);
    expect(body.expand.find((item) => item.externalId === "camp-running")?.hasActiveAdGroups).toBe(true);
  });

  describe("连续自然日零转化", () => {
    // 上海日切在 UTC 16:00，这三个时刻各自落在上海 08-23 / 08-24 / 08-25。
    // 系统时间是上海 08-26 14:00，所以这三天都是「完整日」，今天不参与计数。
    const SH_23 = "2026-08-23T02:00:00.000Z";
    const SH_24 = "2026-08-24T02:00:00.000Z";
    const SH_25 = "2026-08-25T02:00:00.000Z";

    it("连续三个完整自然日零转化就判重扩", async () => {
      for (const day of [SH_23, SH_24, SH_25]) {
        seedDay(day, [{ externalId: "camp-dry", name: "连续无转化", spend: 2, conversions: 0 }]);
      }
      const body = await classify();
      const item = body.recreateCampaign.find((row) => row.externalId === "camp-dry");
      expect(item?.reason).toBe("no-conversion-days-exceeded");
    });

    // 近况优先于累计：这条系列累计单转 8（远低于 12），按累计口径本该「可扩」，
    // 但最近三天一个转化都没有，说明它现在已经不出货了。
    it("盖过累计单转达标的判定", async () => {
      seedDay("2026-08-22T02:00:00.000Z", [
        { externalId: "camp-was-good", name: "曾经出货", spend: 24, conversions: 3 },
      ]);
      for (const day of [SH_23, SH_24, SH_25]) {
        seedDay(day, [{ externalId: "camp-was-good", name: "曾经出货", spend: 2, conversions: 0 }]);
      }
      const body = await classify();
      const item = body.recreateCampaign.find((row) => row.externalId === "camp-was-good");
      expect(item?.reason).toBe("no-conversion-days-exceeded");
      // 累计仍是 3 转化、单转 10，确实达标——判重扩靠的是近况而不是累计。
      expect(item?.conversions).toBe(3);
    });

    it("只有两天零转化不触发", async () => {
      for (const day of [SH_24, SH_25]) {
        seedDay(day, [{ externalId: "camp-two-days", name: "两天无转化", spend: 1, conversions: 0 }]);
      }
      const body = await classify();
      expect(body.expand.map((row) => row.externalId)).toContain("camp-two-days");
    });

    // 没花钱的那天零转化是必然的，不构成证据；但也不该重置连续性。
    // 单日花费压在 1，累计 2 不超过零转化上限 3——否则触发的是累计花费那条规则，
    // 测不到连续天数的行为。
    it("中间有一天没花钱不中断连续性", async () => {
      seedDay(SH_23, [{ externalId: "camp-gap", name: "中间停投", spend: 1, conversions: 0 }]);
      seedDay(SH_24, [{ externalId: "camp-gap", name: "中间停投", spend: 0, conversions: 0 }]);
      seedDay(SH_25, [{ externalId: "camp-gap", name: "中间停投", spend: 1, conversions: 0 }]);
      const body = await classify();
      // 只有两天真正花过钱，还差一天，不该触发。
      expect(body.expand.map((row) => row.externalId)).toContain("camp-gap");

      // 但连续性没有被那天中断：把阈值降到 2 就该命中，说明中间那天是「跳过」
      // 而不是「重置」。
      const strict = await classify("?maxConsecutiveZeroConversionDays=2");
      expect(strict.recreateCampaign.find((row) => row.externalId === "camp-gap")?.reason)
        .toBe("no-conversion-days-exceeded");
    });

    it("阈值可由查询参数覆盖", async () => {
      for (const day of [SH_24, SH_25]) {
        seedDay(day, [{ externalId: "camp-two-days", name: "两天无转化", spend: 1, conversions: 0 }]);
      }
      const body = await classify("?maxConsecutiveZeroConversionDays=2");
      expect(body.recreateCampaign.find((row) => row.externalId === "camp-two-days")?.reason)
        .toBe("no-conversion-days-exceeded");
    });
  });

  /**
   * 今天已经复制过的源系列要带上标记，好让界面把它从「建议重扩」名单里藏掉——那份名单是
   * 行动清单，今天已经做过的再摆上去只会被复制第二遍。
   */
  describe("今天已经复制过", () => {
    it("标记跟着系列一起返回，但不改判定", async () => {
      seedDay(DAY_TWO, [
        { externalId: "camp-copied", name: "已复制系列", spend: 30, conversions: 1 },
        { externalId: "camp-not-copied", name: "未复制系列", spend: 30, conversions: 1 },
      ]);
      store.claimCampaignCopyTask("copy-1", "demo-account", "camp-copied", "已复制系列-0826-100000");

      const body = await classify();

      // 判定不变：两条都还是「单转超标 → 需重扩」。改判会顺手关掉每早的自动关停，
      // 那条链路正是靠 recreateCampaign 桶挑关停对象的。
      const copied = body.recreateCampaign.find((row) => row.externalId === "camp-copied");
      const notCopied = body.recreateCampaign.find((row) => row.externalId === "camp-not-copied");
      expect(copied?.reason).toBe("cost-per-conversion-high");
      expect(notCopied?.reason).toBe("cost-per-conversion-high");
      // 差别只在标记上。
      expect(copied?.recreatedToday).toBe(true);
      expect(notCopied?.recreatedToday).toBe(false);
    });

    it("昨天复制的不算：源系列今天还是没起色，该再提示一次", async () => {
      seedDay(DAY_TWO, [{ externalId: "camp-copied", name: "已复制系列", spend: 30, conversions: 1 }]);
      // 当前系统时间是 2026-08-26T06:00Z（上海 14:00），往前 26 小时落在上海 8-25。
      vi.setSystemTime(new Date("2026-08-25T04:00:00.000Z"));
      store.claimCampaignCopyTask("copy-1", "demo-account", "camp-copied", "已复制系列-0825-120000");
      vi.setSystemTime(new Date("2026-08-26T06:00:00.000Z"));

      const body = await classify();

      expect(body.recreateCampaign.find((row) => row.externalId === "camp-copied")?.recreatedToday)
        .toBe(false);
    });
  });

  it("账号不存在时返回 404", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/accounts/not-there/expand-classification",
    });
    expect(response.statusCode).toBe(404);
  });
});
