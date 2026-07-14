import { z } from "zod";
import { SyncEntityTypeSchema } from "./connection.js";

export const ThresholdMetricSchema = z.enum([
  "cost_per_conversion",
  "cost_per_click",
  "cost_per_cart",
  "budget",
  "spend",
  "conversions",
  "clicks",
  "custom",
]);

export const ThresholdOperatorSchema = z.enum(["gt", "gte", "lt", "lte"]);
export const ThresholdStageSchema = z.enum(["stage-1", "stage-2", "global"]);
export const ThresholdActionSchema = z.enum(["enable", "disable"]);

export const ThresholdConfigSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  code: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[A-Z0-9_]+$/, "配置代码只能包含大写字母、数字和下划线"),
  label: z.string().trim().min(1).max(80),
  metric: ThresholdMetricSchema,
  operator: ThresholdOperatorSchema,
  value: z.number().finite().min(0),
  unit: z.string().trim().min(1).max(20),
  stage: ThresholdStageSchema,
  enabled: z.boolean(),
  entityType: SyncEntityTypeSchema,
  action: ThresholdActionSchema,
  automationEnabled: z.boolean(),
  minimumSpend: z.number().finite().min(0),
  cooldownMinutes: z.number().int().min(0).max(43_200),
  updatedAt: z.string().datetime(),
});

export type ThresholdConfig = z.infer<typeof ThresholdConfigSchema>;

export const ThresholdInputSchema = ThresholdConfigSchema.omit({
  id: true,
  accountId: true,
  updatedAt: true,
});

export type ThresholdInput = z.infer<typeof ThresholdInputSchema>;

export const defaultThresholds: readonly ThresholdInput[] = [
  {
    code: "TIME_ATTR_CONVERSION_COST",
    label: "平均转化成本",
    metric: "cost_per_conversion",
    operator: "gte",
    value: 7.5,
    unit: "账户币种",
    stage: "stage-1",
    enabled: true,
    entityType: "ad-group",
    action: "disable",
    automationEnabled: false,
    minimumSpend: 0,
    cooldownMinutes: 60,
  },
  {
    code: "CPC",
    label: "平均点击成本",
    metric: "cost_per_click",
    operator: "gte",
    value: 0.5,
    unit: "账户币种",
    stage: "stage-1",
    enabled: true,
    entityType: "ad-group",
    action: "disable",
    automationEnabled: false,
    minimumSpend: 0,
    cooldownMinutes: 60,
  },
  {
    code: "TIME_ATTR_COST_PER_ON_WEB_CART",
    label: "平均加购成本",
    metric: "cost_per_cart",
    operator: "gte",
    value: 0.5,
    unit: "账户币种",
    stage: "stage-1",
    enabled: true,
    entityType: "ad-group",
    action: "disable",
    automationEnabled: false,
    minimumSpend: 0,
    cooldownMinutes: 60,
  },
  {
    code: "CPC_LEVEL2",
    label: "平均点击成本-2阶段",
    metric: "cost_per_click",
    operator: "gte",
    value: 0.8,
    unit: "账户币种",
    stage: "stage-2",
    enabled: true,
    entityType: "ad-group",
    action: "disable",
    automationEnabled: false,
    minimumSpend: 0,
    cooldownMinutes: 60,
  },
  {
    code: "TIME_ATTR_CONVERSION_COST_LEVEL2",
    label: "平均转化成本-2阶段",
    metric: "cost_per_conversion",
    operator: "gte",
    value: 9,
    unit: "账户币种",
    stage: "stage-2",
    enabled: true,
    entityType: "ad-group",
    action: "disable",
    automationEnabled: false,
    minimumSpend: 0,
    cooldownMinutes: 60,
  },
  {
    code: "BUDGET",
    label: "预算",
    metric: "budget",
    operator: "gte",
    value: 200,
    unit: "账户币种",
    stage: "global",
    enabled: true,
    entityType: "campaign",
    action: "disable",
    automationEnabled: false,
    minimumSpend: 0,
    cooldownMinutes: 60,
  },
] as const;
