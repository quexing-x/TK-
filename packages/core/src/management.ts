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
