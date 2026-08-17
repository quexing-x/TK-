import type {
  MetaAdCreationInput,
  MetaCreationTargetLevel,
  MetaCreationTaskRecord,
} from "@tk-auto/core";

type MetaAdSetCreationInput = Extract<MetaAdCreationInput, { targetLevel: "ad-set" }>;
type MetaFullAdCreationInput = Extract<MetaAdCreationInput, { targetLevel: "ad" }>;
export type MetaCreationCommonFields = Omit<MetaAdSetCreationInput, "targetLevel">;
export type MetaAdOnlyCreationFields = Pick<MetaFullAdCreationInput,
  | "creativeName"
  | "adName"
  | "destinationUrl"
  | "primaryText"
  | "headline"
  | "description"
  | "callToAction"
  | "imageHash"
>;

export const defaultMetaCreationTargetLevel: MetaCreationTargetLevel = "ad-set";

export function metaCreationTargetCopy(targetLevel: MetaCreationTargetLevel): {
  button: string;
  description: string;
  label: string;
  success: string;
} {
  if (targetLevel === "ad-set") {
    return {
      button: "创建 Campaign + Ad Set",
      description: "只创建 Campaign 与 Ad Set；两层固定 PAUSED，不创建 Creative 或 Ad",
      label: "两层",
      success: "Meta Campaign 与 Ad Set 已全部以 PAUSED 创建",
    };
  }
  return {
    button: "创建四层 PAUSED 广告",
    description: "创建 Campaign、Ad Set、Creative 与 Ad；四层固定 PAUSED，不会开始投放",
    label: "四层",
    success: "Meta Campaign、Ad Set、Creative、Ad 已全部以 PAUSED 创建",
  };
}

export function metaCreationTaskTargetLevel(
  task: Pick<MetaCreationTaskRecord, "input">,
): MetaCreationTargetLevel {
  return task.input.targetLevel;
}

export function buildMetaCreationInput(
  targetLevel: MetaCreationTargetLevel,
  commonFields: MetaCreationCommonFields,
  adOnlyFields: MetaAdOnlyCreationFields,
): MetaAdCreationInput {
  if (targetLevel === "ad-set") {
    return { ...commonFields, targetLevel: "ad-set" };
  }
  return { ...commonFields, ...adOnlyFields, targetLevel: "ad" };
}
