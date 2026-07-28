import { z } from "zod";
import type { AutomationSwitchKey, AutomationSwitches } from "./automation.js";
import type { ProviderEntity, SyncEntityType } from "./connection.js";
import type { ThresholdConfig } from "./threshold.js";
import type { WriteTaskActor } from "./write-task.js";

export const EntityOperationalStatusSchema = z.enum([
  "enabled",
  "disabled",
  "unknown",
]);
export type EntityOperationalStatus = z.infer<
  typeof EntityOperationalStatusSchema
>;

export const AutomationActionSchema = z.enum(["enable", "disable"]);
export type AutomationAction = z.infer<typeof AutomationActionSchema>;

export const AutomationTriggerSchema = z.enum(["scheduler", "manual", "preview"]);
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

export const AutomationDecisionStatusSchema = z.enum([
  "preview",
  "pending",
  "succeeded",
  "failed",
  "unknown",
  "skipped",
]);
export type AutomationDecisionStatus = z.infer<
  typeof AutomationDecisionStatusSchema
>;

export type AutomationRunStatus = "running" | "completed" | "failed";

export interface AutomationRunRecord {
  id: string;
  accountId: string;
  providerKind: "cookie" | "official-api";
  trigger: AutomationTrigger;
  automatic: boolean;
  status: AutomationRunStatus;
  startedAt: string;
  finishedAt: string | null;
  candidateCount: number;
  actionCount: number;
  successCount: number;
  failureCount: number;
  errorMessage: string | null;
}

export interface AutomationDecisionRecord {
  id: string;
  runId: string;
  accountId: string;
  providerKind: "cookie" | "official-api";
  thresholdId: string;
  thresholdCode: string;
  entityType: SyncEntityType;
  externalId: string;
  entityName: string;
  action: AutomationAction;
  metric: ThresholdConfig["metric"];
  metricValue: number;
  operator: ThresholdConfig["operator"];
  thresholdValue: number;
  reason: string;
  suggestionKey: string;
  ruleVersion: string;
  rulePredicate: Record<string, unknown>;
  metricSnapshot: NormalizedMetrics;
  dataQualityStatus: "healthy" | "partial" | "stale" | "invalid";
  dataQualityWarnings: string[];
  status: AutomationDecisionStatus;
  errorMessage: string | null;
  createdAt: string;
  executedAt: string | null;
}

export interface NormalizedMetrics {
  cost_per_conversion: number | null;
  cost_per_click: number | null;
  cost_per_cart: number | null;
  budget: number | null;
  spend: number | null;
  conversions: number | null;
  clicks: number | null;
  carts: number | null;
  impressions: number | null;
}

export interface ManagedEntitySnapshot {
  entityType: SyncEntityType;
  externalId: string;
  name: string;
  /** Provider creation time, normalized to ISO-8601 when it is available. */
  createdAt?: string | null;
  /** Planned delivery start time, normalized to ISO-8601 when it is available. */
  scheduledStartAt?: string | null;
  status: EntityOperationalStatus;
  parentCampaignId: string | null;
  parentAdGroupId: string | null;
  /** Owning campaign's budget (系列预算); 0 when the campaign holds no budget. */
  campaignBudget: number | null;
  /** True when the owning campaign runs 系列预算优化 (CBO); such ad groups cannot carry their own budget. */
  campaignBudgetOptimized: boolean;
  metrics: NormalizedMetrics;
}

export interface AutomationCandidate {
  thresholdId: string;
  thresholdCode: string;
  entity: ManagedEntitySnapshot;
  action: AutomationAction;
  metric: ThresholdConfig["metric"];
  metricValue: number;
  operator: ThresholdConfig["operator"];
  thresholdValue: number;
  cooldownMinutes: number;
  reason: string;
}

export interface AutomationEvaluation {
  candidates: AutomationCandidate[];
  skipped: Array<{
    thresholdId: string;
    entityType?: SyncEntityType;
    externalId?: string;
    reason: string;
  }>;
}

const levelSwitches: Record<SyncEntityType, AutomationSwitchKey> = {
  campaign: "manageCampaignStatus",
  "ad-group": "manageAdGroupStatus",
  ad: "manageAdStatus",
};

export function evaluateAutomation(
  entities: ProviderEntity[],
  thresholds: ThresholdConfig[],
  switches: AutomationSwitches,
): AutomationEvaluation {
  const snapshots = entities.map(normalizeProviderEntity);
  const candidates: AutomationCandidate[] = [];
  const skipped: AutomationEvaluation["skipped"] = [];

  for (const threshold of thresholds) {
    if (!threshold.enabled || !threshold.automationEnabled) continue;
    if (!switches[levelSwitches[threshold.entityType]]) {
      skipped.push({
        thresholdId: threshold.id,
        reason: `未开启${threshold.entityType}状态管理能力。`,
      });
      continue;
    }

    for (const entity of snapshots) {
      if (entity.entityType !== threshold.entityType) continue;
      if (entity.status === "unknown") {
        skipped.push({
          thresholdId: threshold.id,
          entityType: entity.entityType,
          externalId: entity.externalId,
          reason: "启停状态未确认，跳过自动写入。",
        });
        continue;
      }
      const metricValue =
        threshold.metric === "custom"
          ? null
          : entity.metrics[threshold.metric];
      if (metricValue === null || !Number.isFinite(metricValue)) {
        skipped.push({
          thresholdId: threshold.id,
          entityType: entity.entityType,
          externalId: entity.externalId,
          reason: `缺少指标 ${threshold.metric}。`,
        });
        continue;
      }
      if (
        threshold.minimumSpend > 0 &&
        (entity.metrics.spend === null ||
          entity.metrics.spend < threshold.minimumSpend)
      ) {
        continue;
      }
      if (!compare(metricValue, threshold.operator, threshold.value)) continue;

      const desiredStatus = threshold.action === "enable" ? "enabled" : "disabled";
      if (entity.status === desiredStatus) continue;

      candidates.push({
        thresholdId: threshold.id,
        thresholdCode: threshold.code,
        entity,
        action: threshold.action,
        metric: threshold.metric,
        metricValue,
        operator: threshold.operator,
        thresholdValue: threshold.value,
        cooldownMinutes: threshold.cooldownMinutes,
        reason: `${threshold.label}：${threshold.metric} ${operatorLabel(threshold.operator)} ${threshold.value}，当前值 ${metricValue}。`,
      });
    }
  }

  return { candidates: dedupeCandidates(candidates), skipped };
}

export function normalizeProviderEntity(
  entity: ProviderEntity,
): ManagedEntitySnapshot {
  const rowData = isRecord(entity.payload.row_data)
    ? entity.payload.row_data
    : {};
  const reportMetrics = isRecord(entity.payload.metrics)
    ? entity.payload.metrics
    : {};
  const source = { ...entity.payload, ...rowData, ...reportMetrics };

  const campaignBudget = firstNumber(source, ["campaign_budget"]);
  const campaignBudgetMode = firstNumber(source, ["campaign_budget_mode"]);

  return {
    entityType: entity.entityType,
    externalId: entity.externalId,
    name: firstString(source, nameKeys[entity.entityType]) ?? entity.externalId,
    createdAt: firstTimestamp(source, ["create_time", "created_at", "createTime"]),
    scheduledStartAt: firstTimestamp(source, [
      "start_time",
      "start_at",
      "startTime",
      "schedule_start_time",
      "scheduleStartTime",
    ]),
    status: normalizeStatus(entity.entityType, source),
    parentCampaignId: firstString(source, ["campaign_id", "campaignId"]),
    parentAdGroupId: firstString(source, [
      "adgroup_id",
      "ad_group_id",
      "adGroupId",
    ]),
    // 系列预算(CBO)：campaign_budget_mode 非 -1（无系列预算）或 campaign_budget>0 即为 CBO。
    // 该字段在广告组行上即携带其所属系列的预算信息，无需回查系列实体。
    campaignBudget,
    campaignBudgetOptimized:
      (campaignBudgetMode !== null && campaignBudgetMode > 0)
      || (campaignBudget !== null && campaignBudget > 0),
    metrics: {
      cost_per_conversion: firstNumber(source, [
        "time_attr_conversion_cost",
        "cost_per_conversion",
        "cost_per_result",
      ]),
      cost_per_click: firstNumber(source, ["cpc", "cost_per_click"]),
      cost_per_cart: firstNumber(source, [
        "time_attr_cost_per_on_web_cart",
        "cost_per_cart",
      ]),
      budget: firstNumber(source, [
        "ad_budget",
        "campaign_budget",
        "budget",
      ]),
      spend: firstNumber(source, ["stat_cost", "spend", "cost"]),
      conversions: firstNumber(source, [
        "time_attr_convert_cnt",
        "conversion",
        "conversions",
        "result",
      ]),
      clicks: firstNumber(source, ["click_cnt", "clicks"]),
      carts: firstNumber(source, [
        "time_attr_on_web_cart",
        "onsite_on_web_cart",
        "on_web_cart",
        "carts",
      ]),
      impressions: firstNumber(source, ["show_cnt", "impressions"]),
    },
  };
}

function compare(
  actual: number,
  operator: ThresholdConfig["operator"],
  expected: number,
): boolean {
  if (operator === "gt") return actual > expected;
  if (operator === "gte") return actual >= expected;
  if (operator === "lt") return actual < expected;
  return actual <= expected;
}

function normalizeStatus(
  entityType: SyncEntityType,
  source: Record<string, unknown>,
): EntityOperationalStatus {
  const keys: Record<SyncEntityType, string[]> = {
    campaign: [
      "campaign_primary_status",
      "campaign_status",
      "primary_status",
      "operation_status",
    ],
    "ad-group": [
      "ad_primary_status",
      "adgroup_primary_status",
      "ad_status",
      "primary_status",
      "operation_status",
    ],
    ad: [
      "creative_primary_status",
      "ad_primary_status",
      "ad_status",
      "primary_status",
      "operation_status",
    ],
  };
  let hasProviderStatus = false;
  for (const key of keys[entityType]) {
    const value = source[key];
    if (typeof value !== "string" || !value.trim()) continue;
    hasProviderStatus = true;
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "disable" ||
      normalized === "disabled" ||
      normalized === "paused" ||
      normalized.includes("disable") ||
      normalized.includes("paused")
    ) {
      return "disabled";
    }
  }
  // TikTok primary status may describe delivery or review rather than the
  // enable/disable switch. Any non-disabled provider state is operationally on.
  return hasProviderStatus ? "enabled" : "unknown";
}

function firstNumber(
  source: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = source[key];
    if (value === "" || value === "-" || value === null || value === undefined) {
      continue;
    }
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function firstString(
  source: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function firstTimestamp(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    const timestamp = typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : Date.parse(typeof value === "string" ? value : "");
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    return new Date(timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp).toISOString();
  }
  return null;
}

function dedupeCandidates(
  candidates: AutomationCandidate[],
): AutomationCandidate[] {
  const unique = new Map<string, AutomationCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.entity.entityType}:${candidate.entity.externalId}:${candidate.action}`;
    const existing = unique.get(key);
    if (!existing || candidate.thresholdValue > existing.thresholdValue) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()];
}

function operatorLabel(operator: ThresholdConfig["operator"]): string {
  return { gt: ">", gte: "≥", lt: "<", lte: "≤" }[operator];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nameKeys: Record<SyncEntityType, string[]> = {
  campaign: ["campaign_name", "name"],
  "ad-group": ["adgroup_name", "ad_group_name", "ad_name", "name"],
  ad: ["creative_name", "ad_name", "name"],
};
