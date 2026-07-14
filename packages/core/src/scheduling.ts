import { z } from "zod";
import { ProviderKindSchema } from "./account.js";
import { AutomationActionSchema } from "./decision.js";

export const OneTimeScheduleInputSchema = z.object({
  externalId: z.string().trim().min(1).max(128),
  action: AutomationActionSchema,
  runAt: z.string().datetime(),
});
export type OneTimeScheduleInput = z.infer<typeof OneTimeScheduleInputSchema>;

export const OvernightScheduleInputSchema = z
  .object({
    externalId: z.string().trim().min(1).max(128),
    disableAt: z.string().datetime(),
    enableAt: z.string().datetime(),
  })
  .refine((value) => value.disableAt !== value.enableAt, {
    message: "过夜关闭和开启时间不能相同。",
  });
export type OvernightScheduleInput = z.infer<
  typeof OvernightScheduleInputSchema
>;

export const ScheduledActionStatusSchema = z.enum([
  "scheduled",
  "completed",
  "failed",
  "cancelled",
]);
export type ScheduledActionStatus = z.infer<
  typeof ScheduledActionStatusSchema
>;

export const ScheduledActionResultSchema = z.enum(["succeeded", "failed"]);
export type ScheduledActionResult = z.infer<
  typeof ScheduledActionResultSchema
>;

export const ScheduledEntityActionRecordSchema = z.object({
  id: z.string().min(1),
  groupId: z.string().nullable(),
  accountId: z.string().min(1),
  providerKind: ProviderKindSchema,
  entityType: z.literal("ad-group"),
  externalId: z.string().min(1),
  entityName: z.string().min(1),
  action: AutomationActionSchema,
  scheduleType: z.enum(["once", "overnight"]),
  repeatDaily: z.boolean(),
  nextRunAt: z.string().datetime(),
  status: ScheduledActionStatusSchema,
  lastResult: ScheduledActionResultSchema.nullable(),
  lastMessage: z.string().nullable(),
  lastRunAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ScheduledEntityActionRecord = z.infer<
  typeof ScheduledEntityActionRecordSchema
>;

