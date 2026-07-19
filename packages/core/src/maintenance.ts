import { z } from "zod";
import { WriteTaskActorSchema } from "./write-task.js";

export const AuditLogRecordSchema = z.object({
  id: z.string().min(1),
  actor: WriteTaskActorSchema,
  accountId: z.string().min(1),
  action: z.string().min(1),
  payload: z.unknown(),
  correlationId: z.string().min(1),
  requestId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
});
export type AuditLogRecord = z.infer<typeof AuditLogRecordSchema>;

export const AuditLogFilterSchema = z.object({
  accountId: z.string().trim().min(1).optional(),
  actorId: z.string().trim().min(1).optional(),
  action: z.string().trim().min(1).optional(),
  correlationId: z.string().trim().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type AuditLogFilter = z.infer<typeof AuditLogFilterSchema>;

export const DatabaseBackupKindSchema = z.enum([
  "pre-migration",
  "manual",
  "pre-upgrade",
  "restore-rollback",
]);
export type DatabaseBackupKind = z.infer<typeof DatabaseBackupKindSchema>;

export const DatabaseBackupStatusSchema = z.enum(["verified", "invalid"]);
export type DatabaseBackupStatus = z.infer<typeof DatabaseBackupStatusSchema>;

export const DatabaseBackupRecordSchema = z.object({
  id: z.string().min(1),
  kind: DatabaseBackupKindSchema,
  fileName: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  appVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  status: DatabaseBackupStatusSchema,
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
  verifiedAt: z.string().datetime().nullable(),
});
export type DatabaseBackupRecord = z.infer<typeof DatabaseBackupRecordSchema>;

export const UpdateRuntimeStatusSchema = z.object({
  configured: z.boolean(),
  state: z.enum([
    "not-configured",
    "idle",
    "checking",
    "up-to-date",
    "available",
    "downloading",
    "downloaded",
    "installing",
    "error",
  ]),
  currentVersion: z.string().min(1),
  availableVersion: z.string().min(1).nullable(),
  signatureStatus: z.enum(["not-packaged", "unknown", "valid", "invalid"]),
  message: z.string().nullable(),
  checkedAt: z.string().datetime().nullable(),
});
export type UpdateRuntimeStatus = z.infer<typeof UpdateRuntimeStatusSchema>;

export const MaintenanceStatusSchema = z.object({
  appVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  packaged: z.boolean(),
  pendingRestore: z.boolean(),
  update: UpdateRuntimeStatusSchema,
});
export type MaintenanceStatus = z.infer<typeof MaintenanceStatusSchema>;
