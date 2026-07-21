import {
  normalizeProviderEntity,
  type AutomationCandidate,
  type AutomationEvaluation,
  type ManagedEntitySnapshot,
} from "./decision.js";
import type { ProviderEntity, SyncEntityType } from "./connection.js";
import {
  RULE_LOOKBACK_HOURS,
  automationRuleDefinitions,
  type AutomationRule,
  type RuleConfiguration,
} from "./rules.js";

export interface RecentWindowFilterResult {
  entities: ProviderEntity[];
  excludedCount: number;
}

export function filterEntitiesToRecentWindow(
  entities: ProviderEntity[],
  now = new Date(),
  lookbackHours = RULE_LOOKBACK_HOURS,
): RecentWindowFilterResult {
  const cutoff = now.getTime() - lookbackHours * 60 * 60 * 1_000;
  const futureTolerance = now.getTime() + 5 * 60 * 1_000;
  const adGroupCreatedAt = new Map<string, number>();

  for (const entity of entities) {
    if (entity.entityType !== "ad-group") continue;
    const createdAt = extractEntityCreatedAt(entity.payload);
    if (createdAt !== null) adGroupCreatedAt.set(entity.externalId, createdAt);
  }

  const filtered = entities.filter((entity) => {
    const createdAt = entity.entityType === "ad"
      ? adGroupCreatedAt.get(getAdGroupId(entity) ?? "") ??
        extractAdGroupCreatedAt(entity.payload)
      : extractEntityCreatedAt(entity.payload);
    return (
      createdAt !== null && createdAt >= cutoff && createdAt <= futureTolerance
    );
  });

  return { entities: filtered, excludedCount: entities.length - filtered.length };
}

export function evaluateRuleConfiguration(
  entities: ProviderEntity[],
  configuration: RuleConfiguration,
): AutomationEvaluation {
  const candidates: AutomationCandidate[] = [];
  const skipped: AutomationEvaluation["skipped"] = [];
  const rulesByCode = new Map(
    configuration.rules.map((rule) => [rule.code, rule]),
  );

  for (const entity of entities.map(normalizeProviderEntity)) {
    if (!layerEnabled(entity.entityType, configuration)) continue;

    for (const definition of automationRuleDefinitions) {
      const rule = rulesByCode.get(definition.code);
      if (!rule?.enabled) continue;
      const match = matchRule(rule, entity);
      if (!match) continue;

      const desiredStatus = definition.action === "enable" ? "enabled" : "disabled";
      if (entity.status === "unknown") {
        skipped.push({
          thresholdId: rule.code,
          entityType: entity.entityType,
          externalId: entity.externalId,
          reason: "无法识别当前启停状态。",
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

interface RuleMatch {
  metric: AutomationCandidate["metric"];
  metricValue: number;
  operator: AutomationCandidate["operator"];
  thresholdValue: number;
}

function matchRule(
  rule: AutomationRule,
  entity: ManagedEntitySnapshot,
): RuleMatch | null {
  const conversions = entity.metrics.conversions;
  const cpc = entity.metrics.cost_per_click;
  const cpa = entity.metrics.cost_per_conversion;
  const spend = entity.metrics.spend;
  const carts = entity.metrics.carts;
  const value = (key: string): number => rule.values[key] ?? Number.NaN;

  switch (rule.code) {
    case "CV1_CPC_CLOSE":
      return conversions === value("conversions") && cpc !== null && cpc > value("cpc")
        ? primary("cost_per_click", cpc, "gt", value("cpc"))
        : null;
    case "CV1_CPA_CLOSE":
      return conversions === value("conversions") && cpa !== null && cpa > value("cpa")
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
      return conversions === value("conversions") && cpc !== null && cpc > value("cpc")
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
): RuleMatch {
  return { metric, metricValue, operator, thresholdValue };
}

function layerEnabled(
  entityType: SyncEntityType,
  configuration: RuleConfiguration,
): boolean {
  if (entityType === "campaign") return configuration.layers.campaign;
  if (entityType === "ad-group") return configuration.layers.adGroup;
  return configuration.layers.ad;
}

function getAdGroupId(entity: ProviderEntity): string | null {
  if (entity.entityType === "ad-group") return entity.externalId;
  const source = flattenPayload(entity.payload);
  return firstString(source, ["adgroup_id", "ad_group_id", "adGroupId"]);
}

function extractEntityCreatedAt(payload: Record<string, unknown>): number | null {
  const source = flattenPayload(payload);
  const keys = ["create_time", "created_at", "createTime"];
  for (const key of keys) {
    const timestamp = parseTimestamp(source[key]);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

function extractAdGroupCreatedAt(payload: Record<string, unknown>): number | null {
  const source = flattenPayload(payload);
  const keys = [
    "adgroup_create_time",
    "adgroup_created_at",
    "adGroupCreateTime",
    "ad_group_create_time",
    "ad_group_created_at",
  ];
  for (const key of keys) {
    const timestamp = parseTimestamp(source[key]);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    return number < 10_000_000_000 ? number * 1_000 : number;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function flattenPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const rowData = isRecord(payload.row_data) ? payload.row_data : {};
  const metrics = isRecord(payload.metrics) ? payload.metrics : {};
  return { ...payload, ...rowData, ...metrics };
}

function firstString(
  source: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const candidate = source[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
