import { z } from "zod";

const optionalBusinessId = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().regex(/^\d+$/, "Business Portfolio ID 必须是数字").nullable(),
);

export const MetaAccessProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  appId: z.string().trim().regex(/^\d+$/, "App ID 必须是数字"),
  businessId: optionalBusinessId,
  graphApiVersion: z
    .string()
    .trim()
    .regex(/^v\d+\.\d+$/, "Graph API 版本格式应为 vXX.X"),
});
export type MetaAccessProfileInput = z.infer<
  typeof MetaAccessProfileInputSchema
>;

export const MetaAccessProfileSchema = MetaAccessProfileInputSchema.extend({
  id: z.string().uuid(),
  hasAppSecret: z.boolean(),
  hasAccessToken: z.boolean(),
  referenceCount: z.number().int().min(0),
  updatedAt: z.string().datetime(),
});
export type MetaAccessProfile = z.infer<typeof MetaAccessProfileSchema>;

/**
 * 该对象只能在凭据写入边界短暂存在。API 响应、审计、数据库 JSON 与日志均不得保存它。
 */
export const MetaAccessSecretBundleInputSchema = z.object({
  appSecret: z.string().trim().min(8).max(512),
  accessToken: z.string().trim().min(20).max(8192),
});
export type MetaAccessSecretBundleInput = z.infer<
  typeof MetaAccessSecretBundleInputSchema
>;

export const MetaAccountBindingSchema = z.object({
  profileId: z.string().uuid(),
  adAccountId: z
    .string()
    .trim()
    .regex(/^act_\d+$/, "广告账户 ID 格式应为 act_数字"),
  pageId: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().regex(/^\d+$/, "Facebook Page ID 必须是数字").nullable(),
  ),
});
export type MetaAccountBinding = z.infer<typeof MetaAccountBindingSchema>;
