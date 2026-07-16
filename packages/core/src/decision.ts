import { z } from "zod";
import type { AutomationSwitchKey, AutomationSwitches } from "./automation.js";
import type { ProviderEntity, SyncEntityType } from "./connection.js";
import type { ThresholdConfig } from "./threshold.js";

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
  executionMode: "observe" | "manual-approval" | "automatic";
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
  status: EntityOperationalStatus;
  parentCampaignId: string | null;
  parentAdGroupId: string | null;
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
      if (entity.status === "unknown") {
        skipped.push({
          thresholdId: threshold.id,
          entityType: entity.entityType,
          externalId: entity.externalId,
          reason: "无法识别当前启停状态。",
        });
        continue;
      }
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

  return {
    entityType: entity.entityType,
    externalId: entity.externalId,
    name: firstString(source, nameKeys[entity.entityType]) ?? entity.externalId,
    status: normalizeStatus(entity.entityType, source),
    parentCampaignId: firstString(source, ["campaign_id", "campaignId"]),
    parentAdGroupId: firstString(source, [
      "adgroup_id",
      "ad_group_id",
      "adGroupId",
    ]),
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
  for (const key of keys[entityType]) {
    const value = source[key];
    if (typeof value !== "string") continue;
    const normalized = value.toLowerCase();
    if (
      normalized === "enable" ||
      normalized === "enabled" ||
      normalized === "active" ||
      normalized === "delivery_ok" ||
      normalized.endsWith("_delivery_ok") ||
      normalized.endsWith("_enable")
    ) {
      return "enabled";
    }
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
  return "unknown";
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
