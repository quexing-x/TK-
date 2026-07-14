import { z } from "zod";

export const automationSwitchDefinitions = [
  {
    key: "parseCampaigns",
    label: "解析系列",
    description: "同步推广系列及基础状态。",
    risk: "read" as const,
  },
  {
    key: "parseAdGroups",
    label: "解析广告组",
    description: "同步广告组、预算、出价及投放状态。",
    risk: "read" as const,
  },
  {
    key: "parseAds",
    label: "解析广告",
    description: "同步广告、素材及表现数据。",
    risk: "read" as const,
  },
  {
    key: "copyAds",
    label: "复制广告",
    description: "允许规则引擎创建广告副本。",
    risk: "write" as const,
  },
  {
    key: "overnightSchedule",
    label: "过夜",
    description: "按计划暂停并在指定时间恢复广告组。",
    risk: "write" as const,
  },
  {
    key: "newVersion",
    label: "新版本",
    description: "允许使用新版计划或素材处理流程。",
    risk: "write" as const,
  },
  {
    key: "deleteAdGroups",
    label: "删除广告组",
    description: "允许规则引擎删除广告组，属于高风险操作。",
    risk: "destructive" as const,
  },
  {
    key: "pauseHighOrderCampaigns",
    label: "暂停高单转系列",
    description: "保留原工具命名，具体业务语义需在执行阶段确认。",
    risk: "write" as const,
  },
  {
    key: "appealAds",
    label: "申诉",
    description: "允许把符合条件的广告加入申诉流程。",
    risk: "write" as const,
  },
  {
    key: "closeNoConversion",
    label: "无转化关闭",
    description: "达到阈值后暂停无转化广告或广告组。",
    risk: "write" as const,
  },
] as const;

export const AutomationSwitchKeySchema = z.enum(
  automationSwitchDefinitions.map((item) => item.key) as [
    (typeof automationSwitchDefinitions)[number]["key"],
    ...(typeof automationSwitchDefinitions)[number]["key"][],
  ],
);

export type AutomationSwitchKey = z.infer<typeof AutomationSwitchKeySchema>;
export type AutomationSwitchRisk =
  (typeof automationSwitchDefinitions)[number]["risk"];

export type AutomationSwitches = Record<AutomationSwitchKey, boolean>;

const automationSwitchShape = Object.fromEntries(
  automationSwitchDefinitions.map((item) => [item.key, z.boolean()]),
) as Record<AutomationSwitchKey, z.ZodBoolean>;

export const AutomationSwitchesSchema: z.ZodType<AutomationSwitches> =
  z.object(automationSwitchShape).strict();

export function createDefaultAutomationSwitches(): AutomationSwitches {
  return Object.fromEntries(
    automationSwitchDefinitions.map((item) => [
      item.key,
      item.risk === "read",
    ]),
  ) as AutomationSwitches;
}
