import {
  normalizeProviderEntity,
  type AutomationCandidate,
  type AutomationEvaluation,
  type ManagedEntitySnapshot,
} from "./decision.js";
import type { ProviderEntity, SyncEntityType } from "./connection.js";
import {
  getMetaAutomationRuleDefinition,
  metaAutomationRuleDefinitions,
  type MetaAutomationRule,
  type MetaRuleConfiguration,
} from "./meta-rules.js";

/**
 * Meta 专用规则入口。它只消费 Meta 当日 Insights，并且永远不产生素材层动作。
 * TikTok 的 48 小时窗口、素材保护与过夜策略不属于这个执行器。
 */
export function evaluateMetaRuleConfiguration(
  entities: ProviderEntity[],
  configuration: MetaRuleConfiguration,
): AutomationEvaluation {
  const candidates: AutomationCandidate[] = [];
  const skipped: AutomationEvaluation["skipped"] = [];
  const rulesByCode = new Map(
    configuration.rules.map((rule) => [rule.code, rule]),
  );

  for (const entity of entities.map(normalizeProviderEntity)) {
    if (!metaLayerEnabled(entity.entityType, configuration)) continue;

    for (const definition of metaAutomationRuleDefinitions) {
      const rule = rulesByCode.get(definition.code);
      if (!rule?.enabled) continue;
      const match = matchMetaRule(rule, entity);
      if (!match) continue;

      const desiredStatus =
        definition.action === "enable" ? "enabled" : "disabled";
      if (entity.status === "unknown") {
        skipped.push({
          thresholdId: rule.code,
          entityType: entity.entityType,
          externalId: entity.externalId,
          reason: "Meta configured status 无法识别，禁止自动写入。",
        });
      } else if (entity.status !== desiredStatus) {
        candidates.push({
          thresholdId: rule.code,
          thresholdCode: rule.code,
          entity,
          action: definition.action,
          metric: match.metric,
          metricValue: match.metricValue,
          operator: match.operator,
          thresholdValue: match.thresholdValue,
          cooldownMinutes: 60,
          reason: `${definition.label}：${definition.description}`,
        });
      }
      break;
    }
  }

  return { candidates, skipped };
}

interface MetaRuleMatch {
  metric: AutomationCandidate["metric"];
  metricValue: number;
  operator: AutomationCandidate["operator"];
  thresholdValue: number;
}

function matchMetaRule(
  rule: MetaAutomationRule,
  entity: ManagedEntitySnapshot,
): MetaRuleMatch | null {
  const conversions = entity.metrics.conversions;
  const cpc = entity.metrics.cost_per_click;
  const cpa = entity.metrics.cost_per_conversion;
  const spend = entity.metrics.spend;
  const carts = entity.metrics.carts;
  const value = (key: string): number => rule.values[key] ?? Number.NaN;

  switch (rule.code) {
    case "CV1_CPC_CLOSE":
      return conversions === value("conversions") &&
        cpc !== null &&
        cpc > value("cpc")
        ? primary("cost_per_click", cpc, "gt", value("cpc"))
        : null;
    case "CV1_CPA_CLOSE":
      return conversions === value("conversions") &&
        cpa !== null &&
        cpa > value("cpa")
        ? primary("cost_per_conversion", cpa, "gt", value("cpa"))
        : null;
    case "CV1_CPA_OPEN":
      return conversions === value("conversions") &&
        cpa !== null &&
        cpc !== null &&
        cpa <= value("cpa") &&
        cpc <= value("cpc")
        ? primary("cost_per_conversion", cpa, "lte", value("cpa"))
        : null;
    case "CV2_CPA_CLOSE":
      return conversions !== null &&
        conversions >= value("conversions") &&
        cpa !== null &&
        cpa > value("cpa")
        ? primary("cost_per_conversion", cpa, "gt", value("cpa"))
        : null;
    case "CV2_CPA_OPEN":
      return conversions !== null &&
        conversions >= value("conversions") &&
        cpa !== null &&
        cpa <= value("cpa")
        ? primary("cost_per_conversion", cpa, "lte", value("cpa"))
        : null;
    case "NO_CONV_SPEND_CLOSE":
      return conversions === value("conversions") &&
        spend !== null &&
        spend > value("spend")
        ? primary("spend", spend, "gt", value("spend"))
        : null;
    case "NO_CONV_CPC_CLOSE":
      return conversions === value("conversions") &&
        cpc !== null &&
        cpc > value("cpc")
        ? primary("cost_per_click", cpc, "gt", value("cpc"))
        : null;
    case "NO_CART_CLOSE":
      return spend !== null &&
        spend >= value("spend") &&
        carts === value("carts")
        ? primary("spend", spend, "gte", value("spend"))
        : null;
    case "HAS_CART_OPEN":
      return spend !== null &&
        spend >= value("spend") &&
        carts !== null &&
        carts >= value("carts")
        ? primary("spend", spend, "gte", value("spend"))
        : null;
  }
}

function primary(
  metric: AutomationCandidate["metric"],
  metricValue: number,
  operator: AutomationCandidate["operator"],
  thresholdValue: number,
): MetaRuleMatch {
  return { metric, metricValue, operator, thresholdValue };
}

function metaLayerEnabled(
  entityType: SyncEntityType,
  configuration: MetaRuleConfiguration,
): boolean {
  if (entityType === "campaign") return configuration.layers.campaign;
  if (entityType === "ad-group") return configuration.layers.adGroup;
  if (entityType === "ad") return configuration.layers.ad;
  return false;
}

export function buildMetaRulePredicate(
  rule: MetaAutomationRule,
): Record<string, unknown> {
  const definition = getMetaAutomationRuleDefinition(rule.code);
  return {
    platform: "meta",
    metricWindow: "account-today",
    ruleCode: rule.code,
    action: definition.action,
    values: { ...rule.values },
  };
}
