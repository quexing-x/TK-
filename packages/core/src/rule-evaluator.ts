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
  managedAdGroupIds: ReadonlySet<string> = new Set(),
): RecentWindowFilterResult {
  const cutoff = now.getTime() - lookbackHours * 60 * 60 * 1_000;
  const futureTolerance = now.getTime() + 5 * 60 * 1_000;
  const adGroupCreatedAt = new Map<string, number>();
  const eligibleAdGroups = new Set<string>();

  for (const entity of entities) {
    if (entity.entityType !== "ad-group") continue;
    const createdAt = extractEntityCreatedAt(entity.payload);
    if (createdAt === null) continue;
    adGroupCreatedAt.set(entity.externalId, createdAt);
    const normalized = normalizeProviderEntity(entity);
    const spend = normalized.metrics.spend;
    // 超龄广告组的存活判据有两条并列的路子：
    // 1) 当天有消耗（spend>0）——「今天在投的活对象」。**不能**再叠加
    //    status==="enabled"，否则窗口变单向门：老组被关掉就永久掉出评估集，
    //    开启规则再也够不着（归因延迟：先按零转化关、转化随后才回传）。
    // 2) 在持久管辖集里（managedAdGroupIds）——自动化自己关停、尚未被自动重开的
    //    广告组。spend>0 是当天指标，过零点归零，跨天回传的转化就够不着 (1)；这条
    //    用更长的归因窗口兜底，让这类组即便当天零消耗也留在评估范围，能被开回来。
    //    人工暂停的组不在此集里，不会被自动开回。
    if (
      createdAt <= futureTolerance &&
      (createdAt >= cutoff ||
        (spend !== null && spend > 0) ||
        managedAdGroupIds.has(entity.externalId))
    ) {
      eligibleAdGroups.add(entity.externalId);
    }
  }

  const filtered = entities.filter((entity) => {
    if (entity.entityType === "ad-group") {
      return eligibleAdGroups.has(entity.externalId);
    }
    // 素材与广告同样是广告组的子级：都跟随所属广告组的创建时间判定窗口。
    // 素材行里没有 create_time，按自身判定会被 48 小时窗口全部滤掉。
    const childOfAdGroup = entity.entityType === "ad" || entity.entityType === "material";
    if (childOfAdGroup) {
      const adGroupId = getAdGroupId(entity);
      if (adGroupId && eligibleAdGroups.has(adGroupId)) return true;
    }
    const createdAt = childOfAdGroup
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
    case "CV1_LOW_CART_CPA_CLOSE":
      // 加购用「不超过上限」（<=），跟「有消耗无加购」那条的等于零判据不是一回事：
      // 这条针对的是「有转化，但加购没跟上，而且单次转化还贵」。
      return conversions === value("conversions") &&
        carts !== null &&
        carts <= value("carts") &&
        cpa !== null &&
        cpa > value("cpa")
        ? primary("cost_per_conversion", cpa, "gt", value("cpa"))
        : null;
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
  // 素材有自己的开关。此前它悄悄落在 ad 那一档，关掉广告层会连素材一起关掉，
  // 而这两件事现在是分开的：广告总开关常开，真正停开的是素材。
  if (entityType === "material") return configuration.layers.material;
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
