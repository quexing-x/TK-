import { z } from "zod";
import { AutomationActionSchema, type ManagedEntitySnapshot } from "./decision.js";
import { SyncEntityTypeSchema, type SyncEntityType } from "./connection.js";

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
}

export interface IgnoredEntityRecord {
  accountId: string;
  providerKind: "cookie" | "official-api";
  entityType: SyncEntityType;
  externalId: string;
  reason: string;
  createdAt: string;
}

export interface AdOperationRecord {
  id: string;
  accountId: string;
  providerKind: "cookie" | "official-api";
  entityType: SyncEntityType;
  externalId: string;
  entityName: string;
  action: "enable" | "disable" | "ignore" | "unignore" | "appeal";
  source: "manual" | "automation";
  status: "succeeded" | "failed" | "pending";
  message: string | null;
  createdAt: string;
}

export interface EntityMetricSnapshotRecord {
  id: string;
  accountId: string;
  providerKind: "cookie" | "official-api";
  entityType: SyncEntityType;
  externalId: string;
  entityName: string;
  status: "enabled" | "disabled" | "unknown";
  metrics: ManagedEntitySnapshot["metrics"];
  capturedAt: string;
}
