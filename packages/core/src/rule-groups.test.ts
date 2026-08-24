import { describe, expect, it } from "vitest";
import {
  applyGroupEnabled,
  applyGroupValue,
  automationRuleGroups,
  getAutomationRuleGroup,
  groupedRuleCodes,
  isGroupEnabled,
  isGroupMixed,
  minimumGroupValue,
  readGroupValue,
  ungroupedRuleDefinitions,
} from "./rule-groups.js";
import {
  RuleConfigurationInputSchema,
  automationRuleDefinitions,
  defaultRuleConfiguration,
} from "./rules.js";

const rules = () => defaultRuleConfiguration.rules.map((rule) => ({
  ...rule,
  values: { ...rule.values },
}));

describe("规则分组（仅界面表述）", () => {
  // 分组只是展示层的整理。任何让底层规则少一条、多一条、或改了代码的写法，
  // 都会被 schema 的固定九条校验挡下——这条测试就是那道闸。
  it("合并只影响展示，底层仍然是完整的九条", () => {
    expect([...groupedRuleCodes].length + ungroupedRuleDefinitions.length)
      .toBe(automationRuleDefinitions.length);
    for (const group of automationRuleGroups) {
      for (const code of [...group.closeCodes, ...group.openCodes]) {
        expect(automationRuleDefinitions.some((d) => d.code === code)).toBe(true);
      }
    }
  });

  // 分组里声明的参数必须真的存在于它要写入的每条规则上，否则保存时会被
  // validateRuleConfiguration 判为「不支持的参数」，整份配置存不进去。
  it("每个输入框声明的目标规则都确实有这个参数", () => {
    for (const group of automationRuleGroups) {
      for (const parameter of group.parameters) {
        for (const code of parameter.appliesTo) {
          const definition = automationRuleDefinitions.find((d) => d.code === code)!;
          expect(
            definition.parameters.some((item) => item.key === parameter.key),
            `${code} 应当有参数 ${parameter.key}`,
          ).toBe(true);
        }
      }
    }
  });

  // 单次转化那组是三条合一：CPA 恢复同时是 CPC 关闭的恢复出口，
  // 只合并两条 CPA 会把 CPC 的恢复路径弄丢。
  it("单次转化组覆盖 CPC 关闭、CPA 关闭、达标恢复三条", () => {
    const group = getAutomationRuleGroup("CV1");
    expect([...group.closeCodes, ...group.openCodes].sort()).toEqual(
      ["CV1_CPA_CLOSE", "CV1_CPA_OPEN", "CV1_CPC_CLOSE"],
    );
    expect(group.parameters.find((p) => p.key === "cpc")?.appliesTo)
      .toEqual(["CV1_CPC_CLOSE", "CV1_CPA_OPEN"]);
  });

  it("改一次 CPA，关闭与恢复两个方向一起改", () => {
    const updated = applyGroupValue(getAutomationRuleGroup("CV1"), "cpa", 4.25, rules());

    expect(updated.find((r) => r.code === "CV1_CPA_CLOSE")?.values.cpa).toBe(4.25);
    expect(updated.find((r) => r.code === "CV1_CPA_OPEN")?.values.cpa).toBe(4.25);
    // 没声明 cpa 的成员不能被误伤
    expect(updated.find((r) => r.code === "CV1_CPC_CLOSE")?.values.cpa).toBeUndefined();
    // 别的分组更不能动
    expect(updated.find((r) => r.code === "CV2_CPA_CLOSE")?.values.cpa)
      .toBe(defaultRuleConfiguration.rules.find((r) => r.code === "CV2_CPA_CLOSE")!.values.cpa);
  });

  it("改 CPC 会同时写进关闭规则和恢复规则", () => {
    const updated = applyGroupValue(getAutomationRuleGroup("CV1"), "cpc", 0.55, rules());

    expect(updated.find((r) => r.code === "CV1_CPC_CLOSE")?.values.cpc).toBe(0.55);
    expect(updated.find((r) => r.code === "CV1_CPA_OPEN")?.values.cpc).toBe(0.55);
  });

  it("一个开关同时开关整组", () => {
    const off = applyGroupEnabled(getAutomationRuleGroup("CV1"), false, rules());

    for (const code of ["CV1_CPC_CLOSE", "CV1_CPA_CLOSE", "CV1_CPA_OPEN"]) {
      expect(off.find((r) => r.code === code)?.enabled).toBe(false);
    }
    expect(off.find((r) => r.code === "CV2_CPA_CLOSE")?.enabled).toBe(true);
    expect(isGroupEnabled(getAutomationRuleGroup("CV1"), off)).toBe(false);
  });

  // 存量配置里两个方向的值可能不一致（生产上 Meta 就是 8/9）。关闭方向才是实际
  // 生效的那个——恢复阈值不低于它时会被关闭规则先拦下并 break，永远够不着。
  // 界面必须显示真正起作用的数。
  it("两个方向的值不一致时，显示关闭方向的值", () => {
    const mixed = rules().map((rule) =>
      rule.code === "CV1_CPA_CLOSE" ? { ...rule, values: { ...rule.values, cpa: 8 } }
      : rule.code === "CV1_CPA_OPEN" ? { ...rule, values: { ...rule.values, cpa: 9 } }
      : rule);

    expect(readGroupValue(getAutomationRuleGroup("CV1"), "cpa", mixed)).toBe(8);
  });

  // 旧界面可以做出「只开关闭、不开恢复」这种配置，合并后一个开关表达不了，
  // 必须能识别出来提示用户，不能静默统一。
  it("成员开关不一致时能被识别为混合状态", () => {
    const partial = rules().map((rule) =>
      rule.code === "CV1_CPA_OPEN" ? { ...rule, enabled: false } : rule);

    expect(isGroupMixed(getAutomationRuleGroup("CV1"), partial)).toBe(true);
    expect(isGroupMixed(getAutomationRuleGroup("CV1"), rules())).toBe(false);
    // 整组关掉不算混合
    expect(isGroupMixed(
      getAutomationRuleGroup("CV1"),
      applyGroupEnabled(getAutomationRuleGroup("CV1"), false, rules()),
    )).toBe(false);
  });

  // 最终闸门：经分组改过的配置必须仍然能通过后端那份 schema 校验。
  it("分组改出来的配置仍然通过完整配置校验", () => {
    let next = rules();
    for (const group of automationRuleGroups) {
      for (const parameter of group.parameters) {
        next = applyGroupValue(group, parameter.key, parameter.step >= 1 ? 2 : 1.5, next);
      }
      next = applyGroupEnabled(group, true, next);
    }

    // 独立卡片的规则不归分组管，但校验会跨规则查约束：「单次转化且加购不足」的
    // CPA 不得高于分组里的「单次转化 CPA 过高」，所以要一起调下来。
    next = next.map((rule) => rule.code === "CV1_LOW_CART_CPA_CLOSE"
      ? { ...rule, values: { ...rule.values, cpa: 1.5 } }
      : rule);

    const parsed = RuleConfigurationInputSchema.safeParse({
      layers: defaultRuleConfiguration.layers,
      rules: next,
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  // 没有恢复方向的规则无从合并，必须留在独立卡片里。
  it("没有恢复方向的规则保持独立", () => {
    const codes = ungroupedRuleDefinitions.map((d) => d.code);
    expect(codes).toEqual([
      // 更严的关闭条件，没有对应的恢复方向；卡片上单独一条，阈值也独立于分组
      "CV1_LOW_CART_CPA_CLOSE",
      "NO_CONV_SPEND_CLOSE",
      "NO_CONV_CPC_CLOSE",
    ]);
  });

  describe("加购组", () => {
    const cart = () => getAutomationRuleGroup("CART");

    // 界面上只给「最低加购」一个输入框，写的是开启侧。关闭侧是「加购 === Y」的
    // 等于判据，只有 Y=0 说得通，所以不做成输入框。
    it("最低加购只写开启侧，关闭侧固定为零加购", () => {
      const updated = applyGroupValue(cart(), "carts", 3, rules());

      expect(updated.find((r) => r.code === "HAS_CART_OPEN")?.values.carts).toBe(3);
      expect(updated.find((r) => r.code === "NO_CART_CLOSE")?.values.carts).toBe(0);
    });

    // 关键的钱包安全：填 0 会让开启判据变成 carts >= 0 恒真，
    // 把所有达到消耗门槛的对象全部开启。
    it("最低加购不接受 0，会被抬到 1", () => {
      const updated = applyGroupValue(cart(), "carts", 0, rules());

      expect(updated.find((r) => r.code === "HAS_CART_OPEN")?.values.carts).toBe(1);
      expect(minimumGroupValue(cart(), "carts")).toBe(1);
    });

    it("最低消耗两个方向一起改", () => {
      const updated = applyGroupValue(cart(), "spend", 1.25, rules());

      expect(updated.find((r) => r.code === "NO_CART_CLOSE")?.values.spend).toBe(1.25);
      expect(updated.find((r) => r.code === "HAS_CART_OPEN")?.values.spend).toBe(1.25);
    });

    // 界面已经不显示关闭侧的 carts，库里若存着怪值就再也看不见却仍在改变判定
    // （比如 2 会让加购 0 个和 1 个的对象两条都不匹配）。编辑时顺手钉回 0。
    it("历史上存进去的怪值会在编辑时被钉回零", () => {
      const weird = rules().map((rule) =>
        rule.code === "NO_CART_CLOSE" ? { ...rule, values: { ...rule.values, carts: 2 } } : rule);

      const updated = applyGroupValue(cart(), "spend", 1, weird);

      expect(updated.find((r) => r.code === "NO_CART_CLOSE")?.values.carts).toBe(0);
    });

    it("显示的最低加购取开启侧的值", () => {
      expect(readGroupValue(cart(), "carts", rules())).toBe(1);
    });
  });
});
