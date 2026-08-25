import { z } from "zod";
import type { ProviderKind } from "./account.js";
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
  providerKind: ProviderKind;
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
  providerKind: ProviderKind;
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
  material: "manageMaterialStatus",
};

/**
 * 需要申诉的审核状态。
 *
 * `creative_offline_audit` 是整条广告被审核下线；`creative_review_partially_approved`
 * 是部分版位未过审，界面上显示「未全部投放 · 审核问题」。生产快照里后者占绝对多数
 * （34 : 1），只认前者等于放过几乎所有真实情形。
 */
const appealWorthyCreativeStatuses = new Set([
  "creative_offline_audit",
  "creative_review_partially_approved",
  "ad_offline_audit",
  "ads_review_partially_approved",
]);

/**
 * 这条广告是否处于需要申诉的审核状态。
 *
 * 判据必须读**列表**字段。TikTok 用 `creative_status_list` / `ad_status_list` 表达
 * 「一个对象同时处于多个状态」，而单数的 `creative_status` 只是列表的第一项——生产
 * 数据里 35 条待申诉广告有 33 条长成 `["ad_disable","creative_review_partially_approved"]`，
 * 单数字段读出来是 `ad_disable`，于是候选集恒为空、自动申诉一次都没排过队。
 *
 * 列表缺失时才回退到单数字段，兼容不带列表的旧载荷。
 */
export function creativeNeedsAppeal(payload: Record<string, unknown>): boolean {
  const statuses = new Set<string>();
  for (const key of ["creative_status_list", "ad_status_list"] as const) {
    const raw = payload[key];
    if (typeof raw !== "string") continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") statuses.add(item);
        }
      }
    } catch {
      // 结构不认识就当作没有列表，交给下面的单数字段兜底。
    }
  }
  if (statuses.size === 0) {
    const single = payload.creative_status;
    if (typeof single === "string") statuses.add(single);
  }
  // 已经关停的广告不申诉：恢复过审也不会投放，真要重开时再申诉更合理。生产快照里
  // 35 条带审核问题的广告有 29 条是关停状态，其中不少是两周前的，批量补提陈年申诉
  // 对 TikTok 那边观感也不好。
  if (statuses.has("ad_disable")) return false;
  return [...statuses].some((status) => appealWorthyCreativeStatuses.has(status));
}

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

  // 广告组/广告行携带的是【父系列】的预算字段（campaign_budget*），而系列行自己的
  // 预算在 budget / budget_mode / budget_optimize_switch 上。两者不能混用别名，
  // 否则系列行读不到预算、广告组行又会把系列预算误当成组预算。
  const isCampaignRow = entity.entityType === "campaign";
  const campaignBudget = isCampaignRow
    ? firstNumber(source, ["campaign_budget", "budget"])
    : firstNumber(source, ["campaign_budget"]);
  const campaignBudgetMode = isCampaignRow
    ? firstNumber(source, ["campaign_budget_mode", "budget_mode"])
    : firstNumber(source, ["campaign_budget_mode"]);
  // 系列预算(CBO)：budget_optimize_switch=1 是真机上最直接的标志（见创建 HAR），
  // budget_mode>0 与 budget>0 作为旧载荷的兜底判据。
  const budgetOptimizeSwitch = isCampaignRow
    ? firstNumber(source, ["budget_optimize_switch"])
    : null;
  const campaignBudgetOptimized =
    (budgetOptimizeSwitch !== null && budgetOptimizeSwitch > 0)
    || (campaignBudgetMode !== null && campaignBudgetMode > 0)
    || (campaignBudget !== null && campaignBudget > 0);
  // 对象自身的预算：系列行取系列预算；广告组行只认组自己的字段，且 CBO 下广告组
  // 根本没有独立预算，必须留空——回退到 campaign_budget 会让组级预算规则拿整条
  // 系列的预算做判断，量级直接错一位。
  const ownBudget = isCampaignRow
    ? campaignBudget
    : campaignBudgetOptimized
      ? null
      : firstNumber(source, ["ad_budget", "budget"]);

  const spend = firstNumber(source, ["stat_cost", "spend", "cost"]);
  const clicks = firstNumber(source, ["click_cnt", "clicks"]);
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
    // 该字段在广告组行上即携带其所属系列的预算信息，无需回查系列实体。
    campaignBudget,
    campaignBudgetOptimized,
    metrics: {
      cost_per_conversion: firstNumber(source, [
        "time_attr_conversion_cost",
        "cost_per_conversion",
        "cost_per_result",
      ]),
      // TikTok 会间歇性地整个不回 cpc 这个键——实测生产库里「有消耗且有点击」的广告组
      // 86 条中缺 27 条，广告层同样，系列层 58 条缺 11 条；而消耗与点击两个字段一直都在。
      //
      // 这不只是界面上少个数字。**三条规则都以 `cpc !== null` 为前提**：CV1_CPC_CLOSE、
      // NO_CONV_CPC_CLOSE，以及 CV1_CPA_OPEN（要 cpa 与 cpc 同时达标才开）。平台不回这个
      // 键，这三条就对该对象**静默失效**——不报错，界面上也只是显示「—」。
      //
      // 平台给了就用平台的（与 TikTok 后台显示保持一致），没给才用 消耗÷点击 现算。
      // 点击为 0 时除不出来，仍然是 null，界面照旧显示「—」，那是正确的。
      cost_per_click: firstNumber(source, ["cpc", "cost_per_click"])
        ?? (spend !== null && clicks !== null && clicks > 0 ? spend / clicks : null),
      cost_per_cart: firstNumber(source, [
        "time_attr_cost_per_on_web_cart",
        "cost_per_cart",
      ]),
      budget: ownBudget,
      spend,
      conversions: firstNumber(source, [
        "time_attr_convert_cnt",
        "conversion",
        "conversions",
        "result",
      ]),
      clicks,
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
    // 素材只读它自己那个状态字段。刻意不回退到 ad_/creative_ 的状态：那两个是
    // 广告与广告组的状态，素材行里出现它们只说明素材在“继承”上层的关停，不代表
    // 素材自己被关。回退过去会把整批素材误判成已关而永远不处理。
    material: ["material_primary_status"],
  };
  let hasProviderStatus = false;
  for (const key of keys[entityType]) {
    const value = source[key];
    if (typeof value !== "string" || !value.trim()) continue;
    hasProviderStatus = true;
    const normalized = value.trim().toLowerCase();
    // 已删除的对象既不是「开着」也不是「关着」，判为 unknown。
    //
    // 这是最后一道网：正常路径上 provider 解析时就把已删行滤掉了，走不到这里。但
    // 兜底的 "enabled" 分支太宽——delete 落进去会让已删对象被当成开着的，规则会对
    // 它派发关闭、过夜排期会把它排进 23:45 的关停队列，写请求必被 TikTok 拒，连续
    // 失败会打开写入熔断器停掉整账户。判成 unknown 的好处是评估器会显式跳过并留下
    // 原因，而不是静默地把它当成正常对象。
    if (normalized.includes("delete")) return "unknown";
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
  // 素材行里可读的名字是被推广的帖子标题。
  material: ["main_entity_name", "mix_material_virtual_creative_name", "name"],
};
