import { z } from "zod";
import { planGeneratedNames } from "./copy-naming.js";

/**
 * 系列复制的分配模型。
 *
 * 三个参数决定结果：
 * - K：勾选的源广告组数
 * - M（groupsPerCampaign）：每个新系列里放几个广告组
 * - N（campaignCopies）：生成几个系列
 *
 * 总共产出 N × M 个广告组，从 K 个源组里**按顺序轮转**取用。这一个模型同时覆盖
 * 两种常用意图：
 * - 拆分：K=2, M=1, N=2 → 两个系列各 1 组，每组各自持有一份系列预算（真正放量）
 * - 整体克隆：K=2, M=2, N=3 → 三个系列各含两个源组的副本
 */
export const CampaignCopyAllocationInputSchema = z.object({
  campaignCopies: z.number().int().min(1).max(20),
  groupsPerCampaign: z.number().int().min(1).max(20),
  sourceAdGroupIds: z.array(z.string().trim().min(1)).min(1).max(50),
}).superRefine((value, context) => {
  if (value.campaignCopies * value.groupsPerCampaign > 100) {
    context.addIssue({
      code: "custom",
      path: ["campaignCopies"],
      message: "单次系列复制最多创建 100 个广告组。",
    });
  }
});
export type CampaignCopyAllocationInput = z.infer<typeof CampaignCopyAllocationInputSchema>;

export interface PlannedCampaignCopyGroup {
  /** 该副本组克隆自哪个源广告组。 */
  sourceAdGroupId: string;
  /** 新广告组名称。 */
  name: string;
}

export interface PlannedCampaignCopy {
  /** 新系列名称。 */
  campaignName: string;
  groups: PlannedCampaignCopyGroup[];
}

export interface CampaignCopyPlan {
  campaigns: PlannedCampaignCopy[];
  /** 本次占用的系列名，供批内去重与预留。 */
  reservedCampaignNames: Set<string>;
  totalGroups: number;
}

export interface CampaignCopyPlanInput extends CampaignCopyAllocationInput {
  sourceCampaignName: string;
  /** 源广告组 id → 名称，用于生成组名。 */
  sourceAdGroupNames: ReadonlyMap<string, string>;
  at: Date;
  timeZone?: string;
  /** 账户内已有的系列名，用于计算序号起点并避免重名。 */
  existingCampaignNames?: Iterable<string>;
  /** 账户内已有的广告组名。 */
  existingAdGroupNames?: Iterable<string>;
}

/**
 * 生成完整的分配方案。返回结构可以直接渲染成「系列名 → 组名」的预览表——
 * M/N 组合出来的结果必须让用户在执行前看见，否则轮转规则只是个黑盒。
 */
export function planCampaignCopy(input: CampaignCopyPlanInput): CampaignCopyPlan {
  const allocation = CampaignCopyAllocationInputSchema.parse({
    campaignCopies: input.campaignCopies,
    groupsPerCampaign: input.groupsPerCampaign,
    sourceAdGroupIds: input.sourceAdGroupIds,
  });

  const campaignNamePlan = planGeneratedNames({
    sourceName: input.sourceCampaignName,
    count: allocation.campaignCopies,
    at: input.at,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    ...(input.existingCampaignNames ? { existingNames: input.existingCampaignNames } : {}),
  });

  // 组名按源组分别起编：同一个源组在不同系列副本里的多份，序号连续可追溯。
  const adGroupNameCursor = new Map<string, string[]>();
  const reservedAdGroupNames = new Set<string>();
  const takeAdGroupName = (sourceAdGroupId: string): string => {
    const queued = adGroupNameCursor.get(sourceAdGroupId);
    if (queued && queued.length > 0) return queued.shift()!;
    const sourceName = input.sourceAdGroupNames.get(sourceAdGroupId) ?? sourceAdGroupId;
    // 一次多取几个，避免逐个生成时反复扫描已有名称。
    const plan = planGeneratedNames({
      sourceName,
      count: allocation.campaignCopies * allocation.groupsPerCampaign,
      at: input.at,
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      existingNames: [...(input.existingAdGroupNames ?? []), ...reservedAdGroupNames],
    });
    for (const name of plan.names) reservedAdGroupNames.add(name);
    adGroupNameCursor.set(sourceAdGroupId, plan.names.slice(1));
    return plan.names[0]!;
  };

  const campaigns: PlannedCampaignCopy[] = [];
  let cursor = 0;
  for (let copyIndex = 0; copyIndex < allocation.campaignCopies; copyIndex += 1) {
    const groups: PlannedCampaignCopyGroup[] = [];
    for (let slot = 0; slot < allocation.groupsPerCampaign; slot += 1) {
      const sourceAdGroupId = allocation.sourceAdGroupIds[cursor % allocation.sourceAdGroupIds.length]!;
      cursor += 1;
      groups.push({ sourceAdGroupId, name: takeAdGroupName(sourceAdGroupId) });
    }
    campaigns.push({ campaignName: campaignNamePlan.names[copyIndex]!, groups });
  }

  return {
    campaigns,
    reservedCampaignNames: campaignNamePlan.reserved,
    totalGroups: allocation.campaignCopies * allocation.groupsPerCampaign,
  };
}

/**
 * 停在「结果未知」状态的系列复制任务。
 *
 * 这类任务在写请求发出之后失去了确认结果的能力（网络中断、超时等），系统
 * 无法自证是否安全重试，因此永久禁止自动重试——但也不能永远没有出路：人工
 * 在 TikTok 后台核实真实状态后，需要一个入口把它标记为已处理，允许下次重新
 * 领取执行。
 */
export const CampaignCopyStuckTaskSchema = z.object({
  taskKey: z.string().min(1),
  accountId: z.string().min(1),
  sourceCampaignId: z.string().min(1),
  campaignName: z.string().min(1),
  claimedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Provider 侧确认产生的系列 ID；发布前失败时为空。 */
  generatedCampaignId: z.string().nullable(),
  generatedAdGroupIds: z.array(z.string()),
  /** 计划中的新广告组名。卡住时只能按名字去后台反查草稿。 */
  generatedAdGroupNames: z.array(z.string()).default([]),
  /** 自动补发布已经试过几次，以及最后一次为什么没成——用来向人解释这条为什么还挂着。 */
  draftPublishAttempts: z.number().int().min(0).default(0),
  draftPublishError: z.string().nullable().default(null),
});
export type CampaignCopyStuckTask = z.infer<typeof CampaignCopyStuckTaskSchema>;

/**
 * 一条系列复制的流水记录。
 *
 * 比 CampaignCopyStuckTask 多 status / uncertain：那个只用于捞卡死的任务，这个要能
 * 把成功、进行中、结果未知三种都展示出来。
 */
export const CampaignCopyHistoryRecordSchema = CampaignCopyStuckTaskSchema.extend({
  status: z.enum(["running", "succeeded"]),
  uncertain: z.boolean(),
});
export type CampaignCopyHistoryRecord = z.infer<typeof CampaignCopyHistoryRecordSchema>;
