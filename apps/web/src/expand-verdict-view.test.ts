import { describe, expect, it } from "vitest";
import { VERDICT_LABELS, matchesVerdictFilter, shouldSuggestRecreate } from "./ExpandGroupsPanel.js";

describe("建议重扩名单", () => {
  // 名单是行动清单：今天已经复制过的再摆上去，只会被「全部带到复制页」原样带走、复制第二遍。
  it("今天已经复制过的不再建议", () => {
    expect(shouldSuggestRecreate({ recreatedToday: true })).toBe(false);
  });

  it("没复制过的照常建议", () => {
    expect(shouldSuggestRecreate({ recreatedToday: false })).toBe(true);
  });

  // 老版本服务端不返回这个字段。缺失时必须照常建议——把名单藏空的代价（当天一条都不重扩）
  // 远大于偶尔多提示一次。
  it("字段缺失时照常建议，不让名单凭空变空", () => {
    expect(shouldSuggestRecreate({})).toBe(true);
  });
});

describe("系列判定筛选", () => {
  it("「全部」放行所有判定", () => {
    for (const verdict of ["expand", "recreate-campaign", "excluded", null] as const) {
      expect(matchesVerdictFilter("all", verdict)).toBe(true);
    }
  });

  it("「可扩组」只留判定为可扩的", () => {
    expect(matchesVerdictFilter("expand", "expand")).toBe(true);
    expect(matchesVerdictFilter("expand", "recreate-campaign")).toBe(false);
    expect(matchesVerdictFilter("expand", "excluded")).toBe(false);
  });

  it("「需重扩系列」只留判定为重扩的", () => {
    expect(matchesVerdictFilter("recreate", "recreate-campaign")).toBe(true);
    expect(matchesVerdictFilter("recreate", "expand")).toBe(false);
    expect(matchesVerdictFilter("recreate", "excluded")).toBe(false);
  });

  // 这条是这次改动最要紧的一条：分类接口挂掉时列表必须照常显示。空列表会被读成
  // 「今天没得扩」，而真相是「判定没算出来」——照着前者操作等于当天什么都不扩。
  it("判定缺失时一律放行，不让列表凭空变空", () => {
    expect(matchesVerdictFilter("expand", null)).toBe(true);
    expect(matchesVerdictFilter("recreate", null)).toBe(true);
  });
});

describe("判定文案", () => {
  // 服务端返回的每个 reason 都必须有对应文案，否则表格里会露出英文枚举名。
  it("覆盖服务端所有 reason", () => {
    for (const reason of [
      "cost-per-conversion-ok",
      "observing",
      "cost-per-conversion-high",
      "no-conversion-overspent",
      "not-enabled",
      "non-operational",
    ]) {
      expect(VERDICT_LABELS[reason], reason).toBeDefined();
      expect(VERDICT_LABELS[reason]?.short, reason).toBeTruthy();
      expect(VERDICT_LABELS[reason]?.hint, reason).toBeTruthy();
    }
  });

  it("两种重扩原因都用同一个短标签，但原因说明不同", () => {
    expect(VERDICT_LABELS["cost-per-conversion-high"]?.short)
      .toBe(VERDICT_LABELS["no-conversion-overspent"]?.short);
    expect(VERDICT_LABELS["cost-per-conversion-high"]?.hint)
      .not.toBe(VERDICT_LABELS["no-conversion-overspent"]?.hint);
  });
});
