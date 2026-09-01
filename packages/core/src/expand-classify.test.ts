import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPAND_THRESHOLDS,
  classifyCampaignForExpand,
  classifyCampaignsForExpand,
  costPerConversionOf,
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
    it("花得还少就继续观察", () => {
      const result = classifyCampaignForExpand(campaign({ spend: 2.5, conversions: 0 }));
      expect(result.verdict).toBe("expand");
      expect(result.reason).toBe("observing");
      expect(result.costPerConversion).toBeNull();
    });

    it("花超上限就判重扩系列", () => {
      const result = classifyCampaignForExpand(campaign({ spend: 16.17, conversions: 0 }));
      expect(result.verdict).toBe("recreate-campaign");
      expect(result.reason).toBe("no-conversion-overspent");
    });

    // 阈值本身仍属观察期，与单转那侧保持同一种边界语义。
    it("正好等于阈值仍在观察期", () => {
      expect(classifyCampaignForExpand(campaign({ spend: 3, conversions: 0 })).verdict)
        .toBe("expand");
      expect(classifyCampaignForExpand(campaign({ spend: 3.01, conversions: 0 })).verdict)
        .toBe("recreate-campaign");
    });

    it("零花费零转化是刚建的组，照常扩", () => {
      expect(classifyCampaignForExpand(campaign({ spend: 0, conversions: 0 })).verdict)
        .toBe("expand");
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

    it("可扩桶把有成绩的排在观察期前面", () => {
      const buckets = classifyCampaignsForExpand([
        campaign({ externalId: "观察", spend: 2, conversions: 0 }),
        campaign({ externalId: "单转8", spend: 24, conversions: 3 }),
        campaign({ externalId: "单转2", spend: 2, conversions: 1 }),
      ]);
      expect(buckets.expand.map((item) => item.externalId)).toEqual(["单转2", "单转8", "观察"]);
    });

    it("重扩桶按亏得最多排前面", () => {
      const buckets = classifyCampaignsForExpand([
        campaign({ externalId: "少", spend: 5, conversions: 0 }),
        campaign({ externalId: "多", spend: 65, conversions: 0 }),
      ]);
      expect(buckets.recreateCampaign.map((item) => item.externalId)).toEqual(["多", "少"]);
    });
  });

  it("阈值可改，默认是 12 / 3", () => {
    expect(DEFAULT_EXPAND_THRESHOLDS).toEqual({
      maxCostPerConversion: 12,
      maxSpendWithoutConversion: 3,
    });
    const strict = { maxCostPerConversion: 8, maxSpendWithoutConversion: 1 };
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

  it("组还在跑时仍按消耗阈值走观察期", () => {
    const observing = classifyCampaignForExpand({ ...stalled, spend: 0.5, hasActiveAdGroups: true });
    expect(observing.verdict).toBe("expand");
    expect(observing.reason).toBe("observing");
    const overspent = classifyCampaignForExpand({ ...stalled, spend: 9, hasActiveAdGroups: true });
    expect(overspent.reason).toBe("no-conversion-overspent");
  });

  // 没提供该信息时不能当成「已关光」——那会把一批还在跑的系列误判成需重扩。
  // 建好还没投的系列同样「无在投组」，但它不是跑不出来，只是还没开始。实测账户里
  // 有 4 条这种系列（如「八寶茶」「隨身wifi」），少了这个判据会被判重扩、进而被一键关掉。
  it("从没花过钱的系列不算停跑，仍在观察期", () => {
    const result = classifyCampaignForExpand({ ...stalled, spend: 0 });
    expect(result.verdict).toBe("expand");
    expect(result.reason).toBe("observing");
  });

  it("缺少该信息时保持原有判据", () => {
    const result = classifyCampaignForExpand({
      externalId: "c", name: "系列", status: "enabled", spend: 0.5, conversions: 0,
    });
    expect(result.verdict).toBe("expand");
    expect(result.hasActiveAdGroups).toBeNull();
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
