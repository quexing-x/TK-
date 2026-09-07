import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPAND_THRESHOLDS,
  classifyCampaignForExpand,
  classifyCampaignsForExpand,
  costPerConversionOf,
  countConsecutiveZeroConversionDays,
  isNonOperationalCampaignName,
  type ExpandCampaignInput,
} from "./expand-classify.js";

const campaign = (over: Partial<ExpandCampaignInput> = {}): ExpandCampaignInput => ({
  externalId: "1874213867836770",
  name: "FY13095高分子速乾灌縫防水劑低价测试",
  status: "enabled",
  spend: 1,
  conversions: 0,
  days: 6,
  ...over,
});

describe("扩组判定", () => {
  describe("有转化时按单转判", () => {
    it("单转达标就照常扩", () => {
      const result = classifyCampaignForExpand(campaign({ spend: 24, conversions: 3 }));
      expect(result.verdict).toBe("expand");
      expect(result.reason).toBe("cost-per-conversion-ok");
      expect(result.costPerConversion).toBe(8);
    });

    it("单转超标就判重扩系列", () => {
      const result = classifyCampaignForExpand(campaign({ spend: 23.9, conversions: 1 }));
      expect(result.verdict).toBe("recreate-campaign");
      expect(result.reason).toBe("cost-per-conversion-high");
    });

    // 阈值本身算达标，不然 12 这个数说不清是「不超过 12」还是「低于 12」。
    it("正好等于阈值算达标", () => {
      expect(classifyCampaignForExpand(campaign({ spend: 12, conversions: 1 })).verdict)
        .toBe("expand");
      expect(classifyCampaignForExpand(campaign({ spend: 12.01, conversions: 1 })).verdict)
        .toBe("recreate-campaign");
    });

    // 花得多不等于该停：单转才是判据。实测 FY13095 累计 $65 但出了 5 单，单转 13.1，
    // 判重扩靠的是单转超标，不是花费大。
    it("花费很大但单转达标仍然照常扩", () => {
      expect(classifyCampaignForExpand(campaign({ spend: 240, conversions: 30 })).verdict)
        .toBe("expand");
    });
  });

  describe("零转化时按累计花费判", () => {
    // 2026-09-07 口径：花过钱但零转化的一律重扩，观察期不再是例外。
    it("花得还少也判重扩，但 reason 仍分得出它只是刚起步", () => {
      const result = classifyCampaignForExpand(campaign({ spend: 2.5, conversions: 0 }));
      expect(result.verdict).toBe("recreate-campaign");
      expect(result.reason).toBe("observing");
      expect(result.costPerConversion).toBeNull();
    });

    it("花超上限就判重扩系列", () => {
      const result = classifyCampaignForExpand(campaign({ spend: 16.17, conversions: 0 }));
      expect(result.verdict).toBe("recreate-campaign");
      expect(result.reason).toBe("no-conversion-overspent");
    });

    // 阈值本身仍属观察期，与单转那侧保持同一种边界语义。零转化一律重扩之后，
    // 这条线不再改变 verdict，只决定 reason 怎么说。
    it("消耗阈值只改 reason，不改 verdict", () => {
      const atThreshold = classifyCampaignForExpand(campaign({ spend: 3, conversions: 0 }));
      expect(atThreshold.verdict).toBe("recreate-campaign");
      expect(atThreshold.reason).toBe("observing");
      const over = classifyCampaignForExpand(campaign({ spend: 3.01, conversions: 0 }));
      expect(over.verdict).toBe("recreate-campaign");
      expect(over.reason).toBe("no-conversion-overspent");
    });

    it("零花费零转化是刚建的组，照常扩", () => {
      const result = classifyCampaignForExpand(campaign({ spend: 0, conversions: 0 }));
      expect(result.verdict).toBe("expand");
      expect(result.reason).toBe("not-started");
    });
  });

  describe("排除项", () => {
    it("已关停的系列不参与判定", () => {
      const result = classifyCampaignForExpand(
        campaign({ status: "disabled", spend: 99, conversions: 0 }),
      );
      expect(result.verdict).toBe("excluded");
      expect(result.reason).toBe("not-enabled");
    });

    it("状态未知的也不参与", () => {
      expect(classifyCampaignForExpand(campaign({ status: "unknown" })).verdict)
        .toBe("excluded");
    });

    // 诊断系列和名为 0 的脏行实测都在账户里出现过，混进可扩列表会被当正经品扩量。
    it("诊断系列与脏数据被排除", () => {
      for (const name of ["诊断0823E-选25到34", "诊断0823D-FY13392搓澡海綿", "0", "   "]) {
        const result = classifyCampaignForExpand(campaign({ name }));
        expect(result.verdict, name).toBe("excluded");
        expect(result.reason, name).toBe("non-operational");
      }
    });

    it("正常系列名不会被误判成诊断", () => {
      expect(isNonOperationalCampaignName("DM003182 130cm加大晴雨兩用傘低价测试")).toBe(false);
      expect(isNonOperationalCampaignName("超聲波潔牙器")).toBe(false);
    });
  });

  describe("单转计算", () => {
    it("零转化返回 null，不用 0 或 Infinity 顶替", () => {
      expect(costPerConversionOf(10, 0)).toBeNull();
      expect(costPerConversionOf(0, 0)).toBeNull();
    });

    it("脏数值返回 null 而不是 NaN", () => {
      expect(costPerConversionOf(Number.NaN, 1)).toBeNull();
      expect(costPerConversionOf(10, Number.NaN)).toBeNull();
    });
  });

  describe("分桶与排序", () => {
    it("按判定结果分三桶", () => {
      const buckets = classifyCampaignsForExpand([
        campaign({ externalId: "a", spend: 24, conversions: 3 }),
        campaign({ externalId: "b", spend: 23.9, conversions: 1 }),
        campaign({ externalId: "c", spend: 16.17, conversions: 0 }),
        campaign({ externalId: "d", status: "disabled" }),
      ]);
      expect(buckets.expand.map((item) => item.externalId)).toEqual(["a"]);
      expect(buckets.recreateCampaign.map((item) => item.externalId)).toEqual(["b", "c"]);
      expect(buckets.excluded.map((item) => item.externalId)).toEqual(["d"]);
    });

    it("可扩桶把有成绩的排在没成绩的前面", () => {
      const buckets = classifyCampaignsForExpand([
        campaign({ externalId: "没投过", spend: 0, conversions: 0 }),
        campaign({ externalId: "单转8", spend: 24, conversions: 3 }),
        campaign({ externalId: "单转2", spend: 2, conversions: 1 }),
      ]);
      expect(buckets.expand.map((item) => item.externalId)).toEqual(["单转2", "单转8", "没投过"]);
    });

    it("重扩桶按亏得最多排前面", () => {
      const buckets = classifyCampaignsForExpand([
        campaign({ externalId: "少", spend: 5, conversions: 0 }),
        campaign({ externalId: "多", spend: 65, conversions: 0 }),
      ]);
      expect(buckets.recreateCampaign.map((item) => item.externalId)).toEqual(["多", "少"]);
    });
  });

  it("阈值可改，默认是 12 / 3 / 3 天", () => {
    expect(DEFAULT_EXPAND_THRESHOLDS).toEqual({
      maxCostPerConversion: 12,
      maxSpendWithoutConversion: 3,
      maxConsecutiveZeroConversionDays: 3,
    });
    const strict = {
      maxCostPerConversion: 8,
      maxSpendWithoutConversion: 1,
      maxConsecutiveZeroConversionDays: 3,
    };
    expect(classifyCampaignForExpand(campaign({ spend: 10, conversions: 1 }), strict).verdict)
      .toBe("recreate-campaign");
    expect(classifyCampaignForExpand(campaign({ spend: 2, conversions: 0 }), strict).verdict)
      .toBe("recreate-campaign");
  });
});

describe("组已被规则关光的系列", () => {
  const stalled = {
    externalId: "c",
    name: "零转化停跑系列",
    status: "enabled" as const,
    conversions: 0,
    hasActiveAdGroups: false,
  };

  // 观察期的前提是「再花一点就能看出结果」。组全关了之后系列一分钱也花不出去，
  // 消耗永远停在当前值，spend > 3 那条线再也跨不过去——系列会永久卡在「观察中」，
  // 既不被扩也不被判重扩，等于从名单里静默消失。
  it("零转化且组已关光，不看消耗直接判重扩", () => {
    const result = classifyCampaignForExpand({ ...stalled, spend: 0.5 });
    expect(result.verdict).toBe("recreate-campaign");
    expect(result.reason).toBe("no-conversion-stalled");
  });

  it("组还在跑时仍按消耗阈值分 reason", () => {
    const observing = classifyCampaignForExpand({ ...stalled, spend: 0.5, hasActiveAdGroups: true });
    expect(observing.verdict).toBe("recreate-campaign");
    expect(observing.reason).toBe("observing");
    const overspent = classifyCampaignForExpand({ ...stalled, spend: 9, hasActiveAdGroups: true });
    expect(overspent.reason).toBe("no-conversion-overspent");
  });

  // 没提供该信息时不能当成「已关光」——那会把一批还在跑的系列误判成需重扩。
  // 建好还没投的系列同样「无在投组」，但它不是跑不出来，只是还没开始。实测账户里
  // 有 4 条这种系列（如「八寶茶」「隨身wifi」），少了这个判据会被判重扩、进而被一键关掉。
  it("从没花过钱的系列不算停跑，也不判重扩", () => {
    const result = classifyCampaignForExpand({ ...stalled, spend: 0 });
    expect(result.verdict).toBe("expand");
    expect(result.reason).toBe("not-started");
  });

  // 守的是一次真实事故边界。「零转化即重扩」之后，建好还没投的系列同时满足
  // 零转化 + 无在投组，一旦判进重扩桶就会被每早的自动关停挑中（那条链路正是挑
  // verdict=recreate-campaign 且 hasActiveAdGroups===false 的那批），当天关掉。
  it("建好还没投的系列绝不进重扩桶", () => {
    const buckets = classifyCampaignsForExpand([{ ...stalled, spend: 0 }]);
    expect(buckets.recreateCampaign).toEqual([]);
    expect(buckets.expand.map((item) => item.reason)).toEqual(["not-started"]);
  });

  it("缺少该信息时不当成已关光", () => {
    const result = classifyCampaignForExpand({
      externalId: "c", name: "系列", status: "enabled", spend: 0.5, conversions: 0,
    });
    expect(result.hasActiveAdGroups).toBeNull();
    // 关键是别落到 stalled——那是「组被关光」的结论，没有依据不能下。
    expect(result.reason).toBe("observing");
  });

  // 有转化的系列不受这条影响：单转达标就该继续扩，组关光只是今天没在跑。
  it("有转化时不受组状态影响", () => {
    const result = classifyCampaignForExpand({ ...stalled, spend: 8, conversions: 2 });
    expect(result.verdict).toBe("expand");
    expect(result.reason).toBe("cost-per-conversion-ok");
  });

  it("把该信息透传出去，供界面决定哪些系列可以直接关", () => {
    expect(classifyCampaignForExpand({ ...stalled, spend: 5 }).hasActiveAdGroups).toBe(false);
    expect(classifyCampaignForExpand({ ...stalled, spend: 5, hasActiveAdGroups: true }).hasActiveAdGroups).toBe(true);
  });
});

describe("连续自然日零转化", () => {
  it("连续天数达到阈值就判重扩", () => {
    const result = classifyCampaignForExpand({
      externalId: "c", name: "系列", status: "enabled",
      spend: 30, conversions: 5, consecutiveZeroConversionDays: 3,
    });
    expect(result.verdict).toBe("recreate-campaign");
    expect(result.reason).toBe("no-conversion-days-exceeded");
  });

  // 近况优先于累计：累计单转会被早期的好成绩撑着。一条前十天出过货、最近三天颗粒无收
  // 的系列，累计单转还漂亮（30/5 = 6，远低于 12），但它现在已经不出货了。
  it("排在累计单转之前判，不被历史好成绩盖住", () => {
    const healthy = classifyCampaignForExpand({
      externalId: "c", name: "系列", status: "enabled",
      spend: 30, conversions: 5, consecutiveZeroConversionDays: 0,
    });
    expect(healthy.reason).toBe("cost-per-conversion-ok");
  });

  it("没到阈值不触发", () => {
    const result = classifyCampaignForExpand({
      externalId: "c", name: "系列", status: "enabled",
      spend: 30, conversions: 5, consecutiveZeroConversionDays: 2,
    });
    expect(result.verdict).toBe("expand");
  });

  it("把天数透传出去，供界面解释判定理由", () => {
    expect(classifyCampaignForExpand({
      externalId: "c", name: "系列", status: "enabled",
      spend: 1, conversions: 0, consecutiveZeroConversionDays: 2,
    }).consecutiveZeroConversionDays).toBe(2);
  });
});

describe("countConsecutiveZeroConversionDays", () => {
  it("从最近的日子往前数，遇到有转化就断", () => {
    expect(countConsecutiveZeroConversionDays([
      { spend: 5, conversions: 0 },
      { spend: 5, conversions: 0 },
      { spend: 5, conversions: 1 },
      { spend: 5, conversions: 0 },
    ])).toBe(2);
  });

  // 没花钱的那天零转化是必然的，不构成「不出货」的证据；但也不该重置连续性——
  // 那样只要隔天投一次就永远数不满。
  it("没花钱的日子跳过，且不中断连续性", () => {
    expect(countConsecutiveZeroConversionDays([
      { spend: 5, conversions: 0 },
      { spend: 0, conversions: 0 },
      { spend: 5, conversions: 0 },
    ])).toBe(2);
  });

  it("最近一天就出过货则为 0", () => {
    expect(countConsecutiveZeroConversionDays([
      { spend: 5, conversions: 2 },
      { spend: 5, conversions: 0 },
    ])).toBe(0);
  });

  it("空数组为 0", () => {
    expect(countConsecutiveZeroConversionDays([])).toBe(0);
  });
});
