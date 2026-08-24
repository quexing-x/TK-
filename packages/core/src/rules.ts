import { z } from "zod";

export const RULE_LOOKBACK_HOURS = 48 as const;

export const AutomationRuleCodeSchema = z.enum([
  "CV1_LOW_CART_CPA_CLOSE",
  "CV1_CPC_CLOSE",
  "CV1_CPA_CLOSE",
  "CV1_CPA_OPEN",
  "CV2_CPA_CLOSE",
  "CV2_CPA_OPEN",
  "NO_CONV_SPEND_CLOSE",
  "NO_CONV_CPC_CLOSE",
  "NO_CART_CLOSE",
  "HAS_CART_OPEN",
]);
export type AutomationRuleCode = z.infer<typeof AutomationRuleCodeSchema>;

export interface AutomationRuleDefinition {
  code: AutomationRuleCode;
  label: string;
  description: string;
  priority: number;
  action: "enable" | "disable";
  parameters: ReadonlyArray<{
    key: string;
    label: string;
    unit: string;
    step: number;
  }>;
}

export const automationRuleDefinitions: readonly AutomationRuleDefinition[] = [
  {
    // 必须排在其余单次转化规则**之前**。
    //
    // 评估器命中第一条就 break，而转化量等于设定值时，CPC过高 / CPA过高 / 达标恢复
    // 三条是穷尽的（cpa 与 cpc 都有值时必命中其一）。这条若排在它们之后，永远轮不到
    // ——哪怕不产生动作，break 也已经发生。放在最前面，它才能用更严的 CPA 标准先行
    // 拦下「有转化但加购也少」的广告组。
    code: "CV1_LOW_CART_CPA_CLOSE",
    label: "单次转化且加购不足",
    description: "转化量等于设定值、加购不超过上限、且 CPA 超过上限时关闭。",
    priority: 1,
    action: "disable",
    parameters: [
      { key: "conversions", label: "转化量", unit: "次", step: 1 },
      { key: "carts", label: "加购上限", unit: "次", step: 1 },
      { key: "cpa", label: "CPA 上限", unit: "账户币种", step: 0.01 },
    ],
  },
  {
    code: "CV1_CPC_CLOSE",
    label: "单次转化 CPC 过高",
    description: "转化量等于设定值，且 CPC 超过上限时关闭。",
    priority: 1,
    action: "disable",
    parameters: [
      { key: "conversions", label: "转化量", unit: "次", step: 1 },
      { key: "cpc", label: "CPC 上限", unit: "账户币种", step: 0.01 },
    ],
  },
  {
    code: "CV1_CPA_CLOSE",
    label: "单次转化 CPA 过高",
    description: "转化量等于设定值，且 CPA 超过上限时关闭。",
    priority: 2,
    action: "disable",
    parameters: [
      { key: "conversions", label: "转化量", unit: "次", step: 1 },
      { key: "cpa", label: "CPA 上限", unit: "账户币种", step: 0.01 },
    ],
  },
  {
    code: "CV1_CPA_OPEN",
    label: "单次转化达标恢复",
    description: "转化量等于设定值，且 CPA、CPC 均不超过上限时开启。",
    priority: 2,
    action: "enable",
    parameters: [
      { key: "conversions", label: "转化量", unit: "次", step: 1 },
      { key: "cpa", label: "CPA 上限", unit: "账户币种", step: 0.01 },
      { key: "cpc", label: "CPC 上限", unit: "账户币种", step: 0.01 },
    ],
  },
  {
    code: "CV2_CPA_CLOSE",
    label: "多次转化 CPA 过高",
    description: "转化量达到设定值，且 CPA 超过上限时关闭。",
    priority: 3,
    action: "disable",
    parameters: [
      { key: "conversions", label: "最低转化", unit: "次", step: 1 },
      { key: "cpa", label: "CPA 上限", unit: "账户币种", step: 0.01 },
    ],
  },
  {
    code: "CV2_CPA_OPEN",
    label: "多次转化达标恢复",
    description: "转化量达到设定值，且 CPA 不超过上限时开启。",
    priority: 3,
    action: "enable",
    parameters: [
      { key: "conversions", label: "最低转化", unit: "次", step: 1 },
      { key: "cpa", label: "CPA 上限", unit: "账户币种", step: 0.01 },
    ],
  },
  {
    code: "NO_CONV_SPEND_CLOSE",
    label: "零转化消耗过高",
    description: "转化量等于设定值，且消耗超过上限时关闭。",
    priority: 4,
    action: "disable",
    parameters: [
      { key: "conversions", label: "转化量", unit: "次", step: 1 },
      { key: "spend", label: "消耗上限", unit: "账户币种", step: 0.01 },
    ],
  },
  {
    code: "NO_CONV_CPC_CLOSE",
    label: "零转化 CPC 过高",
    description: "转化量等于设定值，且 CPC 超过上限时关闭。",
    priority: 5,
    action: "disable",
    parameters: [
      { key: "conversions", label: "转化量", unit: "次", step: 1 },
      { key: "cpc", label: "CPC 上限", unit: "账户币种", step: 0.01 },
    ],
  },
  {
    code: "NO_CART_CLOSE",
    label: "有消耗无加购",
    description: "消耗达到设定值，且加购量等于设定值时关闭。",
    priority: 6,
    action: "disable",
    parameters: [
      { key: "spend", label: "最低消耗", unit: "账户币种", step: 0.01 },
      { key: "carts", label: "加购量", unit: "次", step: 1 },
    ],
  },
  {
    code: "HAS_CART_OPEN",
    label: "有加购恢复",
    description: "消耗和加购量均达到设定值时开启。",
    priority: 6,
    action: "enable",
    parameters: [
      { key: "spend", label: "最低消耗", unit: "账户币种", step: 0.01 },
      { key: "carts", label: "最低加购", unit: "次", step: 1 },
    ],
  },
] as const;

export const AutomationRuleSchema = z.object({
  code: AutomationRuleCodeSchema,
  enabled: z.boolean(),
  values: z.record(z.string(), z.number().finite().min(0)),
});
export type AutomationRule = z.infer<typeof AutomationRuleSchema>;

export const RuleLayerSettingsSchema = z.object({
  campaign: z.boolean(),
  adGroup: z.boolean(),
  ad: z.boolean(),
  // 素材层。存量配置里没有这个键，默认开——广告层的关停已经改为只作用于素材，
  // 默认关掉会让广告层的规则彻底没有落点。
  material: z.boolean().default(true),
});
export type RuleLayerSettings = z.infer<typeof RuleLayerSettingsSchema>;

const RuleConfigurationBaseSchema = z.object({
  layers: RuleLayerSettingsSchema,
  rules: z.array(AutomationRuleSchema).length(automationRuleDefinitions.length),
});
type RuleConfigurationBase = z.infer<typeof RuleConfigurationBaseSchema>;

export const RuleConfigurationInputSchema = RuleConfigurationBaseSchema.superRefine(
  validateRuleConfiguration,
);
export type RuleConfigurationInput = z.infer<
  typeof RuleConfigurationInputSchema
>;

export const RuleConfigurationSchema = RuleConfigurationBaseSchema.extend({
  lookbackHours: z.literal(RULE_LOOKBACK_HOURS),
  updatedAt: z.string().datetime(),
}).superRefine(validateRuleConfiguration);
export type RuleConfiguration = z.infer<typeof RuleConfigurationSchema>;

export const defaultRuleConfiguration: RuleConfigurationInput = {
  layers: { campaign: false, adGroup: true, ad: true, material: true },
  rules: [
    // CPA 默认与「单次转化 CPA 过高」取齐（都是 9），用户再往下调成更严的值。
    // 不能默认给一个更高的数：约束要求它不得超过后者，否则存量配置一升级就非法。
    { code: "CV1_LOW_CART_CPA_CLOSE", enabled: false, values: { conversions: 1, carts: 1, cpa: 9 } },
    { code: "CV1_CPC_CLOSE", enabled: true, values: { conversions: 1, cpc: 0.8 } },
    { code: "CV1_CPA_CLOSE", enabled: true, values: { conversions: 1, cpa: 9 } },
    { code: "CV1_CPA_OPEN", enabled: true, values: { conversions: 1, cpa: 9, cpc: 0.8 } },
    { code: "CV2_CPA_CLOSE", enabled: true, values: { conversions: 2, cpa: 7.5 } },
    { code: "CV2_CPA_OPEN", enabled: true, values: { conversions: 2, cpa: 7.5 } },
    { code: "NO_CONV_SPEND_CLOSE", enabled: true, values: { conversions: 0, spend: 2 } },
    { code: "NO_CONV_CPC_CLOSE", enabled: true, values: { conversions: 0, cpc: 0.5 } },
    { code: "NO_CART_CLOSE", enabled: true, values: { spend: 1, carts: 0 } },
    { code: "HAS_CART_OPEN", enabled: true, values: { spend: 1, carts: 1 } },
  ],
};

export function getAutomationRuleDefinition(
  code: AutomationRuleCode,
): AutomationRuleDefinition {
  const definition = automationRuleDefinitions.find((item) => item.code === code);
  if (!definition) throw new Error(`Unknown rule code: ${code}`);
  return definition;
}

function validateRuleConfiguration(
  configuration: RuleConfigurationBase,
  context: z.RefinementCtx,
): void {
  const actualCodes = new Set(configuration.rules.map((rule) => rule.code));
  for (const definition of automationRuleDefinitions) {
    if (!actualCodes.has(definition.code)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `缺少固定规则 ${definition.code}`,
        path: ["rules"],
      });
    }
  }
  if (actualCodes.size !== configuration.rules.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "固定规则代码不能重复",
      path: ["rules"],
    });
  }
  // 「单次转化且加购不足」的 CPA 上限不得高于「单次转化 CPA 过高」。
  //
  // 它排在后者之前、判据更宽（还多一个加购条件），只有阈值更严才有存在意义：一旦设得
  // 更高，cpa 落在两者之间的广告组会先被这条以「加购不足」的名义关掉，而真正该负责的
  // 是后者；设得再高些则整条形同虚设，因为后者会先兜走所有超标的。两种情形都不是用户
  // 想要的，与其让人对着两个数字猜，不如直接锁死关系。
  const lowCart = configuration.rules.find((rule) => rule.code === "CV1_LOW_CART_CPA_CLOSE");
  const cv1Close = configuration.rules.find((rule) => rule.code === "CV1_CPA_CLOSE");
  const lowCartCpa = lowCart?.values.cpa;
  const cv1Cpa = cv1Close?.values.cpa;
  if (
    typeof lowCartCpa === "number"
    && typeof cv1Cpa === "number"
    && lowCartCpa > cv1Cpa
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `「单次转化且加购不足」的 CPA 上限（${lowCartCpa}）不能高于「单次转化 CPA 过高」的上限（${cv1Cpa}）：它排在前面且判据更宽，阈值不更严就没有意义。`,
      path: [
        "rules",
        configuration.rules.findIndex((rule) => rule.code === "CV1_LOW_CART_CPA_CLOSE"),
        "values",
        "cpa",
      ],
    });
  }

  configuration.rules.forEach((rule, ruleIndex) => {
    const definition = getAutomationRuleDefinition(rule.code);
    const expectedKeys = new Set(definition.parameters.map((item) => item.key));
    for (const key of Object.keys(rule.values)) {
      if (!expectedKeys.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `规则 ${rule.code} 不支持参数 ${key}`,
          path: ["rules", ruleIndex, "values", key],
        });
      }
    }
    for (const key of expectedKeys) {
      if (!(key in rule.values)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `规则 ${rule.code} 缺少参数 ${key}`,
          path: ["rules", ruleIndex, "values", key],
        });
      }
    }
  });
}
