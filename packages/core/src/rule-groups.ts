import {
  automationRuleDefinitions,
  getAutomationRuleDefinition,
  type AutomationRule,
  type AutomationRuleCode,
} from "./rules.js";

/**
 * 规则分组：**只影响界面表述，不影响存储与判定**。
 *
 * 底层仍然是九条独立规则，schema、校验、评估器一律不动——这套配置直接驱动真实的
 * 广告启停，展示层的整理不该有能力改变判定结果。分组只做一件事：把"同一个指标的
 * 关闭方向与恢复方向"合并成界面上的一张卡片，一个开关、一组阈值。
 *
 * 为什么合并是安全的（2026-08-24 对照两份生产配置确认）：评估器按定义顺序逐条匹配、
 * 命中第一条就 break，而关闭规则永远排在恢复规则之前。因此**恢复阈值只要不低于
 * 关闭阈值，它就是不可达的**——中间区间会被关闭规则先拦下。生产上 TikTok 两个方向
 * 的值本来就相同，Meta 是 8/9（恢复那个够不着，等价于 8/8），合并成单一阈值后行为
 * 完全不变。
 *
 * 唯一会被合并改变语义的配置是"恢复阈值低于关闭阈值"（真正的滞回带），当前没有人
 * 这么配；真要支持滞回，应当另加显式的「恢复阈值」字段，而不是靠两条规则各填各的。
 */
export interface AutomationRuleGroupParameter {
  key: string;
  label: string;
  unit: string;
  step: number;
  /** 这个输入框要写进哪几条底层规则。必须显式写出，不靠推断。 */
  appliesTo: readonly AutomationRuleCode[];
}

export interface AutomationRuleGroup {
  key: string;
  label: string;
  description: string;
  /** 沿用成员里最高的优先级（数字最小），用于界面排序与展示。 */
  priority: number;
  closeCodes: readonly AutomationRuleCode[];
  openCodes: readonly AutomationRuleCode[];
  parameters: readonly AutomationRuleGroupParameter[];
}

/**
 * 合并了关闭 / 恢复两个方向的分组。
 *
 * 「有消耗无加购 / 有加购恢复」**刻意没有合并**：两条的 carts 参数含义不同——关闭是
 * `carts === 0`，恢复是 `carts >= 1`。合成一个输入框后填 0，恢复条件会变成 carts >= 0
 * 恒真，把所有有消耗的对象全部开启。这组要合得单独设计判据，不能套用本文件的模式。
 *
 * 「零转化消耗过高」「零转化 CPC 过高」没有对应的恢复规则，无从合并，保持独立。
 */
export const automationRuleGroups: readonly AutomationRuleGroup[] = [
  {
    key: "CV1",
    label: "单次转化达标",
    // 这句话要同时说清两个方向，因为卡片上只有一句描述。
    description: "转化量等于设定值时：CPA 与 CPC 都不超过上限则开启，任一超过上限则关闭。",
    priority: 1,
    closeCodes: ["CV1_CPC_CLOSE", "CV1_CPA_CLOSE"],
    openCodes: ["CV1_CPA_OPEN"],
    parameters: [
      {
        key: "conversions",
        label: "转化量",
        unit: "次",
        step: 1,
        appliesTo: ["CV1_CPC_CLOSE", "CV1_CPA_CLOSE", "CV1_CPA_OPEN"],
      },
      {
        key: "cpa",
        label: "CPA 上限",
        unit: "账户币种",
        step: 0.01,
        appliesTo: ["CV1_CPA_CLOSE", "CV1_CPA_OPEN"],
      },
      {
        key: "cpc",
        label: "CPC 上限",
        unit: "账户币种",
        step: 0.01,
        appliesTo: ["CV1_CPC_CLOSE", "CV1_CPA_OPEN"],
      },
    ],
  },
  {
    key: "CV2",
    label: "多次转化 CPA 达标",
    description: "转化量达到设定值时：CPA 不超过上限则开启，超过上限则关闭。",
    priority: 3,
    closeCodes: ["CV2_CPA_CLOSE"],
    openCodes: ["CV2_CPA_OPEN"],
    parameters: [
      {
        key: "conversions",
        label: "最低转化",
        unit: "次",
        step: 1,
        appliesTo: ["CV2_CPA_CLOSE", "CV2_CPA_OPEN"],
      },
      {
        key: "cpa",
        label: "CPA 上限",
        unit: "账户币种",
        step: 0.01,
        appliesTo: ["CV2_CPA_CLOSE", "CV2_CPA_OPEN"],
      },
    ],
  },
] as const;

/** 已经被分组接管的规则代码，界面上不再单独出卡片。 */
export const groupedRuleCodes: ReadonlySet<AutomationRuleCode> = new Set(
  automationRuleGroups.flatMap((group) => [...group.closeCodes, ...group.openCodes]),
);

/** 没有进分组、仍然一条一张卡片的规则，保持原有顺序。 */
export const ungroupedRuleDefinitions = automationRuleDefinitions.filter(
  (definition) => !groupedRuleCodes.has(definition.code),
);

export function getAutomationRuleGroup(key: string): AutomationRuleGroup {
  const group = automationRuleGroups.find((item) => item.key === key);
  if (!group) throw new Error(`Unknown rule group: ${key}`);
  return group;
}

/**
 * 分组当前的展示值。
 *
 * 成员之间理论上应当一致，但存量配置可能不一致（例如 Meta 的 8/9），所以取值有明确
 * 判据：**用关闭方向的值**。关闭方向是实际生效的那个——恢复阈值不低于它时够不着。
 * 这样界面显示的就是真正在起作用的数，而不是一个看着有效、实则不可达的数。
 */
export function readGroupValue(
  group: AutomationRuleGroup,
  parameterKey: string,
  rules: readonly AutomationRule[],
): number {
  const parameter = group.parameters.find((item) => item.key === parameterKey);
  if (!parameter) return Number.NaN;
  const byCode = new Map(rules.map((rule) => [rule.code, rule]));
  const preferred = [
    ...parameter.appliesTo.filter((code) => group.closeCodes.includes(code)),
    ...parameter.appliesTo,
  ];
  for (const code of preferred) {
    const value = byCode.get(code)?.values[parameterKey];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return Number.NaN;
}

/** 分组整体是否启用：任一成员开着就算开着。 */
export function isGroupEnabled(
  group: AutomationRuleGroup,
  rules: readonly AutomationRule[],
): boolean {
  const codes = new Set([...group.closeCodes, ...group.openCodes]);
  return rules.some((rule) => codes.has(rule.code) && rule.enabled);
}

/**
 * 成员之间开关状态不一致（例如只开了关闭、没开恢复）。
 *
 * 这种配置在旧界面上是可以做出来的，合并之后一个开关表达不了，必须让用户看见——
 * 静默地把它们统一掉等于替用户改了规则。
 */
export function isGroupMixed(
  group: AutomationRuleGroup,
  rules: readonly AutomationRule[],
): boolean {
  const codes = new Set([...group.closeCodes, ...group.openCodes]);
  const states = rules.filter((rule) => codes.has(rule.code)).map((rule) => rule.enabled);
  return states.length > 0 && states.some(Boolean) && !states.every(Boolean);
}

/** 把一个分组输入框的值写回它覆盖的每一条底层规则。 */
export function applyGroupValue(
  group: AutomationRuleGroup,
  parameterKey: string,
  value: number,
  rules: readonly AutomationRule[],
): AutomationRule[] {
  const parameter = group.parameters.find((item) => item.key === parameterKey);
  if (!parameter) return [...rules];
  const targets = new Set<AutomationRuleCode>(parameter.appliesTo);
  return rules.map((rule) => {
    if (!targets.has(rule.code)) return rule;
    // 底层规则不认识的参数键会被 schema 拒收，这里按定义再挡一道。
    const supported = getAutomationRuleDefinition(rule.code).parameters
      .some((item) => item.key === parameterKey);
    if (!supported) return rule;
    return { ...rule, values: { ...rule.values, [parameterKey]: value } };
  });
}

/** 一个开关同时作用于分组里的全部成员。 */
export function applyGroupEnabled(
  group: AutomationRuleGroup,
  enabled: boolean,
  rules: readonly AutomationRule[],
): AutomationRule[] {
  const codes = new Set([...group.closeCodes, ...group.openCodes]);
  return rules.map((rule) => (codes.has(rule.code) ? { ...rule, enabled } : rule));
}
