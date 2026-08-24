import { describe, expect, it } from "vitest";
import {
  RuleConfigurationInputSchema,
  automationRuleDefinitions,
  defaultRuleConfiguration,
  ruleValueCeiling,
} from "./rules.js";

describe("global rule configuration", () => {
  // 不再写死条数：加规则时这条测试该跟着定义走，而不是逼人改一个魔法数字。
  // 真正要守的是「默认配置恰好覆盖全部定义、且没有重复码」——schema 也是按这个校验的。
  it("locks the configuration to exactly one rule per definition", () => {
    const parsed = RuleConfigurationInputSchema.parse(defaultRuleConfiguration);

    expect(parsed.rules).toHaveLength(automationRuleDefinitions.length);
    expect(new Set(parsed.rules.map((rule) => rule.code)).size)
      .toBe(automationRuleDefinitions.length);
    expect(new Set(parsed.rules.map((rule) => rule.code)))
      .toEqual(new Set(automationRuleDefinitions.map((definition) => definition.code)));
  });

  it("applies the shared rules to ad groups, ads and materials by default", () => {
    expect(defaultRuleConfiguration.layers).toEqual({
      campaign: false,
      adGroup: true,
      ad: true,
      // 素材层默认开：广告层的关停已改为只作用于素材，默认关掉会让这些规则
      // 彻底没有落点。
      material: true,
    });
  });

  // 存量配置里没有 material 键，解析时必须补上默认值而不是直接报错。
  it("补齐存量配置里缺失的素材层开关", () => {
    const parsed = RuleConfigurationInputSchema.parse({
      layers: { campaign: false, adGroup: true, ad: true },
      rules: defaultRuleConfiguration.rules,
    });

    expect(parsed.layers.material).toBe(true);
  });

  it("rejects extra editable parameters", () => {
    const invalid = structuredClone(defaultRuleConfiguration);
    invalid.rules[0]!.values.unknown = 1;

    expect(() => RuleConfigurationInputSchema.parse(invalid)).toThrow(
      "不支持参数 unknown",
    );
  });
});

// 「单次转化且加购不足」排在「单次转化 CPA 过高」之前、判据更宽，只有阈值更严才有
// 意义。设得更高会让 cpa 落在两者之间的广告组被这条以「加购不足」的名义误关，设得
// 再高则整条形同虚设。与其让人对着两个数字猜，不如锁死关系。
describe("单次转化 CPA 的跨规则约束", () => {
  const withCpa = (lowCart: number, cv1: number) => ({
    layers: defaultRuleConfiguration.layers,
    rules: defaultRuleConfiguration.rules.map((rule) =>
      rule.code === "CV1_LOW_CART_CPA_CLOSE"
        ? { ...rule, values: { ...rule.values, cpa: lowCart } }
        : rule.code === "CV1_CPA_CLOSE"
          ? { ...rule, values: { ...rule.values, cpa: cv1 } }
          : rule),
  });

  it("更严（更低）可以", () => {
    expect(RuleConfigurationInputSchema.safeParse(withCpa(3, 9)).success).toBe(true);
  });

  it("取齐可以", () => {
    expect(RuleConfigurationInputSchema.safeParse(withCpa(9, 9)).success).toBe(true);
  });

  it("高于单次转化 CPA 会被拒，并指到出错的那个字段", () => {
    const parsed = RuleConfigurationInputSchema.safeParse(withCpa(12, 9));

    expect(parsed.success).toBe(false);
    const issue = parsed.error?.issues[0];
    expect(issue?.message).toContain("不能高于");
    expect(issue?.path).toContain("cpa");
  });

  it("默认配置本身满足这条约束", () => {
    expect(RuleConfigurationInputSchema.safeParse(defaultRuleConfiguration).success).toBe(true);
  });

  // 界面靠 ruleValueCeiling 给滑块封顶，保存靠 schema 校验。两边一旦各写各的就会漂移：
  // 滑块拉得到的值保存时被拒，或者滑块封死了一个其实合法的值。这里把两者钉死在一起
  // ——封顶算出来允许的，schema 必须收；封顶不允许的，schema 必须拒。
  it("滑块封顶与保存校验对同一批取值给出一致结论", () => {
    const cv1 = 9;
    for (const lowCart of [0, 0.5, 3, 8.9, 9, 9.1, 12, 100]) {
      const configuration = withCpa(lowCart, cv1);
      const ceiling = ruleValueCeiling("CV1_LOW_CART_CPA_CLOSE", "cpa", configuration.rules);

      expect(ceiling).toBe(cv1);
      expect(RuleConfigurationInputSchema.safeParse(configuration).success)
        .toBe(lowCart <= ceiling!);
    }
  });

  it("封顶跟着「单次转化 CPA 过高」当前的值走，不是写死的数", () => {
    for (const cv1 of [0, 1.5, 9, 30]) {
      expect(ruleValueCeiling("CV1_LOW_CART_CPA_CLOSE", "cpa", withCpa(0, cv1).rules)).toBe(cv1);
    }
  });

  // 没有约束的参数必须返回 null，否则界面会给一条本无上限的滑块凭空封顶。
  it("不受约束的规则与参数返回 null", () => {
    const { rules } = withCpa(3, 9);

    expect(ruleValueCeiling("CV1_LOW_CART_CPA_CLOSE", "carts", rules)).toBeNull();
    expect(ruleValueCeiling("CV1_LOW_CART_CPA_CLOSE", "conversions", rules)).toBeNull();
    expect(ruleValueCeiling("CV1_CPA_CLOSE", "cpa", rules)).toBeNull();
    expect(ruleValueCeiling("CV2_CPA_CLOSE", "cpa", rules)).toBeNull();
  });
});
