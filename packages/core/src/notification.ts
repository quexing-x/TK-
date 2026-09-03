import { z } from "zod";

export const NotificationChannelKindSchema = z.enum([
  "email",
  "wecom",
  "feishu",
]);
export type NotificationChannelKind = z.infer<
  typeof NotificationChannelKindSchema
>;

const CommonNotificationSettingsSchema = z.object({
  enabled: z.boolean(),
});

export const EmailNotificationSettingsSchema =
  CommonNotificationSettingsSchema.extend({
    kind: z.literal("email"),
    smtpHost: z.string().trim().min(1).max(255),
    smtpPort: z.number().int().min(1).max(65_535),
    secure: z.boolean(),
    from: z.string().trim().email().max(320),
    recipients: z.array(z.string().trim().email().max(320)).min(1).max(20),
  });

export const WecomNotificationSettingsSchema =
  CommonNotificationSettingsSchema.extend({
    kind: z.literal("wecom"),
    mentionAll: z.boolean().default(false),
  });

export const FeishuNotificationSettingsSchema =
  CommonNotificationSettingsSchema.extend({
    kind: z.literal("feishu"),
    mentionAll: z.boolean().default(false),
  });

export const NotificationChannelSettingsSchema = z.discriminatedUnion(
  "kind",
  [
    EmailNotificationSettingsSchema,
    WecomNotificationSettingsSchema,
    FeishuNotificationSettingsSchema,
  ],
);
export type NotificationChannelSettings = z.infer<
  typeof NotificationChannelSettingsSchema
>;

export const EmailNotificationCredentialSchema = z.object({
  kind: z.literal("email"),
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(4096),
});

export const WecomNotificationCredentialSchema = z.object({
  kind: z.literal("wecom"),
  webhookUrl: z.string().trim().url().max(4096),
});

export const FeishuNotificationCredentialSchema = z.object({
  kind: z.literal("feishu"),
  webhookUrl: z.string().trim().url().max(4096),
  signingSecret: z.string().trim().max(4096).optional(),
});

export const NotificationCredentialInputSchema = z.discriminatedUnion(
  "kind",
  [
    EmailNotificationCredentialSchema,
    WecomNotificationCredentialSchema,
    FeishuNotificationCredentialSchema,
  ],
);
export type NotificationCredentialInput = z.infer<
  typeof NotificationCredentialInputSchema
>;

export const NotificationConnectionStatusSchema = z.enum([
  "not-configured",
  "untested",
  "ready",
  "failed",
]);
export type NotificationConnectionStatus = z.infer<
  typeof NotificationConnectionStatusSchema
>;

export const NotificationChannelRecordSchema = z.object({
  kind: NotificationChannelKindSchema,
  settings: NotificationChannelSettingsSchema.nullable(),
  hasCredential: z.boolean(),
  status: NotificationConnectionStatusSchema,
  lastMessage: z.string().nullable(),
  lastTestedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime().nullable(),
});
export type NotificationChannelRecord = z.infer<
  typeof NotificationChannelRecordSchema
>;

export const PollAccountResultStatusSchema = z.enum([
  "changed",
  "no-action",
  "failed",
  "skipped",
]);
export type PollAccountResultStatus = z.infer<
  typeof PollAccountResultStatusSchema
>;

/**
 * 这一轮的失败是「抖一下」还是「真的坏了」。
 *
 * 只影响账户失效提醒要不要发，不影响 result_status 本身：网络抖动、超时、上一轮
 * 没跑完撞上锁，这些下一轮就自己好了，不该 @所有人喊「投放停摆」。判据复用连接
 * 健康检查那套（isTransientHealthCheckFailure），两边对「瞬时」的定义必须一致，
 * 否则会出现连接状态判定「暂时的网络问题、保留 ready」而提醒仍然喊失效的情况。
 */
export const PollFailureKindSchema = z.enum(["transient", "persistent"]);
export type PollFailureKind = z.infer<typeof PollFailureKindSchema>;

export const PollAccountResultSchema = z.object({
  accountId: z.string().min(1),
  accountName: z.string().min(1),
  runId: z.string().min(1).nullable(),
  status: PollAccountResultStatusSchema,
  enabledCount: z.number().int().min(0),
  disabledCount: z.number().int().min(0),
  failureCount: z.number().int().min(0),
  message: z.string().nullable(),
  // 非 failed 的行没有失败性质，存 null。历史行读出来也是 null，按 persistent 处理。
  failureKind: PollFailureKindSchema.nullable().default(null),
});
export type PollAccountResult = z.infer<typeof PollAccountResultSchema>;
/** 写入侧类型：failureKind 可省略，成功的轮次本来就没有失败性质。 */
export type PollAccountResultInput = z.input<typeof PollAccountResultSchema>;

export const PollCycleStatusSchema = z.enum(["running", "completed"]);
export type PollCycleStatus = z.infer<typeof PollCycleStatusSchema>;

export const PollCycleRecordSchema = z.object({
  id: z.string().min(1),
  status: PollCycleStatusSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  accounts: z.array(PollAccountResultSchema),
});
export type PollCycleRecord = z.infer<typeof PollCycleRecordSchema>;

export const NotificationDeliveryStatusSchema = z.enum([
  "queued",
  "sending",
  "sent",
  "failed",
]);
export type NotificationDeliveryStatus = z.infer<
  typeof NotificationDeliveryStatusSchema
>;

export const NotificationDeliveryRecordSchema = z.object({
  id: z.string().min(1),
  cycleId: z.string().min(1),
  channelKind: NotificationChannelKindSchema,
  status: NotificationDeliveryStatusSchema,
  attemptCount: z.number().int().min(0),
  lastError: z.string().nullable(),
  nextAttemptAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  sentAt: z.string().datetime().nullable(),
});
export type NotificationDeliveryRecord = z.infer<
  typeof NotificationDeliveryRecordSchema
>;

export interface NotificationRenderedMessage {
  subject: string;
  text: string;
  markdown: string;
  html: string;
  /**
   * 这一条消息强制 @所有人，覆盖渠道自身的 mentionAll 设置。
   *
   * 账户失效提醒用它：轮询汇总平时不该吵人，但「自动化开着的账户连不上了」是投放
   * 正在停摆，必须有人立刻看到。渠道设置表达不了「按消息类型决定要不要 @」，所以
   * 放在消息上。不设时沿用渠道设置。
   */
  mentionAll?: boolean;
}
