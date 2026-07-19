import { z } from "zod";

export const WriteTaskStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
]);
export type WriteTaskStatus = z.infer<typeof WriteTaskStatusSchema>;

export const WriteTaskPhaseSchema = z.enum([
  "validation",
  "dispatch",
  "readback",
  "sync",
]);
export type WriteTaskPhase = z.infer<typeof WriteTaskPhaseSchema>;

export const WriteTaskActorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["user", "system"]),
});
export type WriteTaskActor = z.infer<typeof WriteTaskActorSchema>;

export interface WriteTaskIdentity {
  operationId: string;
  attemptId: string | null;
  correlationId: string;
  attemptCount: number;
}

export type WriteTaskKind = "launch" | "status";

export interface WriteTaskSummaryRecord extends WriteTaskIdentity {
  kind: WriteTaskKind;
  taskId: string;
  parentId: string | null;
  accountId: string;
  label: string;
  action: string;
  status: WriteTaskStatus;
  phase: WriteTaskPhase;
  actor: WriteTaskActor;
  claimedAt: string | null;
  message: string | null;
  syncWarning: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  retryable: boolean;
  requiresVerification: boolean;
}
