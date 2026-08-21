import { z } from "zod";
import type { ProviderKind } from "./account.js";
import { AutomationActionSchema, type ManagedEntitySnapshot } from "./decision.js";
import { SyncEntityTypeSchema, type SyncEntityType } from "./connection.js";
import type {
  WriteTaskActor,
  WriteTaskIdentity,
  WriteTaskPhase,
  WriteTaskStatus,
} from "./write-task.js";

export const ManualStatusInputSchema = z.object({
  entityType: SyncEntityTypeSchema,
  externalId: z.string().min(1).max(128),
  action: AutomationActionSchema,
});
export type ManualStatusInput = z.infer<typeof ManualStatusInputSchema>;

export const IgnoreEntityInputSchema = z.object({
  entityType: SyncEntityTypeSchema,
  externalId: z.string().min(1).max(128),
  reason: z.string().trim().max(500).default("手动忽略"),
});
export type IgnoreEntityInput = z.infer<typeof IgnoreEntityInputSchema>;

export const AppealQueueInputSchema = z.object({
  externalId: z.string().min(1).max(128),
  reason: z.string().trim().min(1).max(1000),
});
export type AppealQueueInput = z.infer<typeof AppealQueueInputSchema>;

export interface ManagedEntityRecord extends ManagedEntitySnapshot {
  ignored: boolean;
  syncedAt: string;
  /**
   * 该广告组当前在持久管辖集里：自动化自己关停、且尚未被自动开回。
   *
   * 界面判断"是否参与自动化"绕不开这一条：这类组即便建得早、当天零消耗，规则引擎
   * 仍会评估它（好让归因延迟回传的转化把它开回来）。只按创建窗口判定会把它错标成
   * 不参与。人工暂停的组不在此集内。非广告组层恒为 false。
   */
  automationManaged: boolean;
  /** Meta configured status returned by the object endpoint (for example ACTIVE/PAUSED). */
  configuredStatus?: string | null;
  /** Meta effective delivery status after parent-level effects are applied. */
  effectiveStatus?: string | null;
}

export interface IgnoredEntityRecord {
  accountId: string;
  providerKind: ProviderKind;
  entityType: SyncEntityType;
  externalId: string;
  reason: string;
  createdAt: string;
}

export interface AdOperationRecord extends WriteTaskIdentity {
  id: string;
  accountId: string;
  providerKind: ProviderKind;
  entityType: SyncEntityType;
  externalId: string;
  entityName: string;
  action: "enable" | "disable" | "ignore" | "unignore" | "appeal" | "delete";
  source: "manual" | "automation" | "scheduled";
  status: WriteTaskStatus;
  phase: WriteTaskPhase;
  actor: WriteTaskActor;
  claimedBy: string | null;
  claimedAt: string | null;
  message: string | null;
  syncWarning: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AdOperationAttemptRecord {
  attemptId: string;
  operationId: string;
  correlationId: string;
  attemptNumber: number;
  actor: WriteTaskActor;
  phase: WriteTaskPhase;
  status: Exclude<WriteTaskStatus, "pending" | "cancelled">;
  message: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export const StatusManualVerificationInputSchema = z.object({
  decision: z.enum(["confirmed-succeeded", "confirmed-failed"]),
  observedStatus: z.enum(["enabled", "disabled"]),
  evidence: z.string().trim().min(10).max(4_000),
  note: z.string().trim().max(2_000).default(""),
});
export type StatusManualVerificationInput = z.infer<typeof StatusManualVerificationInputSchema>;

export interface StatusManualVerificationRecord extends StatusManualVerificationInput {
  id: string;
  taskId: string;
  operationId: string;
  actor: WriteTaskActor;
  previousStatus: "unknown";
  nextStatus: "succeeded" | "failed";
  createdAt: string;
}

export interface EntityMetricSnapshotRecord {
  id: string;
  accountId: string;
  providerKind: ProviderKind;
  entityType: SyncEntityType;
  externalId: string;
  entityName: string;
  status: "enabled" | "disabled" | "unknown";
  metrics: ManagedEntitySnapshot["metrics"];
  capturedAt: string;
}

export interface MetricBatchRecord {
  capturedAt: string;
  count: number;
  spend: number;
  clicks: number;
  conversions: number;
}

/**
 * 一个自然日（账户时区）的指标真值。
 *
 * 平台回传的 spend/clicks/conversions 是**当日累计**：同一天里每轮同步都会写一条快照，
 * 值从零点起单调递增，过零点归零。把这些快照当成增量点相加会把一天的消耗重复计上几十遍
 * ——旧的「批次」口径正是这么错的。这里改为按 (实体, 自然日) 取当天最后一个健康快照，
 * 也就是该实体那天的累计终值，再跨实体求和。
 */
export interface DailyMetricRecord {
  /** 账户时区下的自然日，YYYY-MM-DD。 */
  date: string;
  /** 当天有数据的实体数。 */
  count: number;
  spend: number;
  clicks: number;
  conversions: number;
  /**
   * 当天最后一个被采纳的快照时间（UTC ISO）。同步中断的日子会停在中途，
   * 该日数值因此偏低——界面据此标注「截止至 HH:MM」，不静默当成真值。
   */
  lastCapturedAt: string;
  /** lastCapturedAt 在账户时区下的时刻，HH:MM。时区换算在服务端做，界面不必再猜。 */
  lastLocalTime: string;
  /** 该自然日就是账户当地的今天，数据仍在累积中。 */
  isCurrentDay: boolean;
}
