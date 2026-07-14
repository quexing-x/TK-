import { z } from "zod";

export const METRIC_RETENTION_DAYS = 90;

export const SystemRuntimeUpdateSchema = z.object({
  enabled: z.boolean(),
});
export type SystemRuntimeUpdate = z.infer<typeof SystemRuntimeUpdateSchema>;

export const SystemRuntimeStateSchema = SystemRuntimeUpdateSchema.extend({
  updatedAt: z.string().datetime(),
});
export type SystemRuntimeState = z.infer<typeof SystemRuntimeStateSchema>;

