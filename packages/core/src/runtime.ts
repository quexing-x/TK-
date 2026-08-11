import { z } from "zod";

export const METRIC_RETENTION_DAYS = 90;

// 自动化自己关停一个广告组后，把它继续留在评估范围内多久，好让「关停之后才回传的
// 转化」（TikTok 归因延迟）仍能触发开启规则、把它自动开回来。仅按当天消耗（spend>0）
// 判存活会在过零点后归零，跨天回传的转化就永远够不着——所以对"自动化在管、当前被
// 自动关停"的广告组，用这个更长的窗口兜底。7 天覆盖常见归因回看窗口。
export const AUTOMATION_MANAGED_LOOKBACK_HOURS = 7 * 24;

export const SystemRuntimeUpdateSchema = z.object({
  enabled: z.boolean(),
});
export type SystemRuntimeUpdate = z.infer<typeof SystemRuntimeUpdateSchema>;

export const SystemRuntimeStateSchema = SystemRuntimeUpdateSchema.extend({
  updatedAt: z.string().datetime(),
});
export type SystemRuntimeState = z.infer<typeof SystemRuntimeStateSchema>;

