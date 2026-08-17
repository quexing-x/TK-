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
      button: "创建广告系列 + 广告组",
      description: "只创建广告系列与广告组；两层固定为已暂停，不创建素材或广告",
      label: "两层",
      success: "Meta 广告系列与广告组已全部以已暂停状态创建",
    };
  }
  return {
    button: "创建四层已暂停广告",
    description: "创建广告系列、广告组、素材与广告；四层固定为已暂停，不会开始投放",
    label: "四层",
    success: "Meta 广告系列、广告组、素材与广告已全部以已暂停状态创建",
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
