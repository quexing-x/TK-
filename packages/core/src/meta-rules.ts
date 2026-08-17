import { z } from "zod";

export const META_RULE_SCHEMA_VERSION = "meta-v1" as const;
export const META_RULE_METRIC_WINDOW = "account-today" as const;

export const MetaAutomationRuleCodeSchema = z.enum([
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
export type MetaAutomationRuleCode = z.infer<
  typeof MetaAutomationRuleCodeSchema
>;

export interface MetaAutomationRuleDefinition {
  code: MetaAutomationRuleCode;
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

// Meta 与 TikTok 只共享指标语义，不共享配置、运行开关或执行策略。
// 独立定义可防止未来任一平台调整规则时隐式改变另一平台。
export const metaAutomationRuleDefinitions: readonly MetaAutomationRuleDefinition[] = [
  {
    code: "CV1_CPC_CLOSE",
    label: "单次转化 CPC 过高",
    description: "当日转化量等于设定值，且 CPC 超过上限时暂停。",
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
    description: "当日转化量等于设定值，且 CPA 超过上限时暂停。",
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
    description: "当日转化量等于设定值，且 CPA、CPC 均达标时恢复。",
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
    description: "当日转化达到设定值，且 CPA 超过上限时暂停。",
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
    description: "当日转化达到设定值，且 CPA 达标时恢复。",
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
    description: "当日零转化且消耗超过上限时暂停。",
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
    description: "当日零转化且 CPC 超过上限时暂停。",
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
    description: "当日消耗达到设定值且没有加购时暂停。",
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
    description: "当日消耗与加购均达到设定值时恢复。",
    priority: 6,
    action: "enable",
    parameters: [
      { key: "spend", label: "最低消耗", unit: "账户币种", step: 0.01 },
      { key: "carts", label: "最低加购", unit: "次", step: 1 },
    ],
  },
] as const;

export const MetaAutomationRuleSchema = z.object({
  code: MetaAutomationRuleCodeSchema,
  enabled: z.boolean(),
  values: z.record(z.string(), z.number().finite().min(0)),
});
export type MetaAutomationRule = z.infer<typeof MetaAutomationRuleSchema>;

export const MetaRuleLayerSettingsSchema = z.object({
  campaign: z.boolean(),
  adGroup: z.boolean(),
  ad: z.boolean(),
});
export type MetaRuleLayerSettings = z.infer<
  typeof MetaRuleLayerSettingsSchema
>;

const MetaRuleConfigurationBaseSchema = z.object({
  schemaVersion: z.literal(META_RULE_SCHEMA_VERSION),
  metricWindow: z.literal(META_RULE_METRIC_WINDOW),
  layers: MetaRuleLayerSettingsSchema,
  rules: z
    .array(MetaAutomationRuleSchema)
    .length(metaAutomationRuleDefinitions.length),
});
type MetaRuleConfigurationBase = z.infer<
  typeof MetaRuleConfigurationBaseSchema
>;

export const MetaRuleConfigurationInputSchema =
  MetaRuleConfigurationBaseSchema.superRefine(validateMetaRuleConfiguration);
export type MetaRuleConfigurationInput = z.infer<
  typeof MetaRuleConfigurationInputSchema
>;

export const MetaRuleConfigurationSchema =
  MetaRuleConfigurationBaseSchema.extend({
    updatedAt: z.string().datetime(),
  }).superRefine(validateMetaRuleConfiguration);
export type MetaRuleConfiguration = z.infer<
  typeof MetaRuleConfigurationSchema
>;

export const defaultMetaRuleConfiguration: MetaRuleConfigurationInput = {
  schemaVersion: META_RULE_SCHEMA_VERSION,
  metricWindow: META_RULE_METRIC_WINDOW,
  layers: { campaign: false, adGroup: false, ad: false },
  rules: [
    { code: "CV1_CPC_CLOSE", enabled: false, values: { conversions: 1, cpc: 0.8 } },
    { code: "CV1_CPA_CLOSE", enabled: false, values: { conversions: 1, cpa: 9 } },
    { code: "CV1_CPA_OPEN", enabled: false, values: { conversions: 1, cpa: 9, cpc: 0.8 } },
    { code: "CV2_CPA_CLOSE", enabled: false, values: { conversions: 2, cpa: 7.5 } },
    { code: "CV2_CPA_OPEN", enabled: false, values: { conversions: 2, cpa: 7.5 } },
    { code: "NO_CONV_SPEND_CLOSE", enabled: false, values: { conversions: 0, spend: 2 } },
    { code: "NO_CONV_CPC_CLOSE", enabled: false, values: { conversions: 0, cpc: 0.5 } },
    { code: "NO_CART_CLOSE", enabled: false, values: { spend: 1, carts: 0 } },
    { code: "HAS_CART_OPEN", enabled: false, values: { spend: 1, carts: 1 } },
  ],
};

export const MetaAutomationRuntimeInputSchema = z.object({
  enabled: z.boolean(),
  pollingIntervalMinutes: z.number().int().min(1).max(60),
  maxActionsPerRun: z.number().int().min(1).max(100),
});
export type MetaAutomationRuntimeInput = z.infer<
  typeof MetaAutomationRuntimeInputSchema
>;

export const MetaAutomationRuntimeSchema =
  MetaAutomationRuntimeInputSchema.extend({
    updatedAt: z.string().datetime(),
  });
export type MetaAutomationRuntime = z.infer<
  typeof MetaAutomationRuntimeSchema
>;

export const defaultMetaAutomationRuntime: MetaAutomationRuntimeInput = {
  enabled: false,
  pollingIntervalMinutes: 5,
  maxActionsPerRun: 15,
};

export function getMetaAutomationRuleDefinition(
  code: MetaAutomationRuleCode,
): MetaAutomationRuleDefinition {
  const definition = metaAutomationRuleDefinitions.find(
    (item) => item.code === code,
  );
  if (!definition) throw new Error(`Unknown Meta rule code: ${code}`);
  return definition;
}

function validateMetaRuleConfiguration(
  configuration: MetaRuleConfigurationBase,
  context: z.RefinementCtx,
): void {
  const actualCodes = new Set(configuration.rules.map((rule) => rule.code));
  for (const definition of metaAutomationRuleDefinitions) {
    if (!actualCodes.has(definition.code)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `缺少固定 Meta 规则 ${definition.code}`,
        path: ["rules"],
      });
    }
  }
  if (actualCodes.size !== configuration.rules.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Meta 固定规则代码不能重复",
      path: ["rules"],
    });
  }
  configuration.rules.forEach((rule, ruleIndex) => {
    const definition = getMetaAutomationRuleDefinition(rule.code);
    const expectedKeys = new Set(
      definition.parameters.map((parameter) => parameter.key),
    );
    for (const key of Object.keys(rule.values)) {
      if (!expectedKeys.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Meta 规则 ${rule.code} 不支持参数 ${key}`,
          path: ["rules", ruleIndex, "values", key],
        });
      }
    }
    for (const key of expectedKeys) {
      if (!(key in rule.values)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Meta 规则 ${rule.code} 缺少参数 ${key}`,
          path: ["rules", ruleIndex, "values", key],
        });
      }
    }
  });
}
