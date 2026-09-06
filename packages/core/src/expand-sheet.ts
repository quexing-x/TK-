import {
  allocateExpandBaseName,
  planGeneratedNames,
  stripGeneratedNameSuffixes,
} from "./copy-naming.js";
import {
  LaunchAgeRangeValues,
  launchSheetColumns,
  type LaunchAgeRange,
  type LaunchGender,
} from "./launch.js";

/**
 * 把「要给这几个组扩量」翻译成一张能直接导入的批量创建表。
 *
 * 存在的理由：扩量本身有一键扩组按钮，但**上新素材**没有——那条路必须走批量创建表，
 * 而表里的系列名和广告组名要人手填。账户里同一个品有一堆名字相近的对象，填错就是把
 * 新素材上到废组上；填重了 TikTok 直接拒。这里把这两列按扩组功能的同一套命名规则算好，
 * 人只需要补视频代码。
 *
 * 命名刻意复用 `allocateExpandBaseName` / `planGeneratedNames`，不另起一套：这两个函数
 * 生成的后缀正是 `stripGeneratedNameSuffixes` 认得的形状。换一套写法，从表里建出来的组
 * 在谱系里会被判成「原组」，等于把这个功能要解决的问题又造回去一遍。
 */

/** 这一行的定向和落地页是从哪儿沿用来的。 */
export type ExpandSheetInheritance =
  /** 这个源组之前用表建过，沿用那次填的值。 */
  | "launch-history"
  /** 从 TikTok 上把源广告组的落地页读回来的。 */
  | "source-ad-group";

export interface ExpandSheetSource {
  sourceAdGroupId: string;
  sourceAdGroupName: string;
  sourceCampaignId: string;
  sourceCampaignName: string;
  /** 沿用来的落地页。取不到时留空，由人补。 */
  productUrl?: string | null;
  ageRanges?: readonly LaunchAgeRange[] | null;
  gender?: LaunchGender | null;
  inheritedFrom?: ExpandSheetInheritance | null;
}

export interface ExpandSheetInput {
  sources: readonly ExpandSheetSource[];
  /** 每个源组扩几份。 */
  countPerSource: number;
  /** 投放时刻，决定名字里的 `MMDD-HHMMSS`。定时投放传排期时间，立即投放传当前时间。 */
  deliveryAt: Date;
  /** 账户时区。日期后缀按账户本地日历取，不用 UTC。 */
  timeZone?: string | undefined;
  /**
   * true = 新组加进源组所在的那条系列（系列名原样写，创建时按名复用）；
   * false = 每个源组另起一条唯一命名的新系列。
   */
  sameCampaign: boolean;
  /** 账户内已占用的系列名，用于兜底跳过。来自 `collectReservedNames`。 */
  existingCampaignNames?: ReadonlySet<string>;
  /** 账户内已占用的广告组名。 */
  existingAdGroupNames?: ReadonlySet<string>;
  /**
   * 账户内重名的系列名。
   *
   * `sameCampaign` 靠系列名精确匹配来复用现有系列，账户里有两条同名系列时创建会明确
   * 报错——发布后的终态核验无从判定哪条是本次建的。所以在生成表这一步就要标出来。
   */
  duplicateCampaignNames?: ReadonlySet<string>;
}

export interface ExpandSheetRow {
  campaignName: string;
  adGroupName: string;
  /** 恒为空：新素材代码只有人知道，这一列留给人填。 */
  videoCode: "";
  productUrl: string;
  /** 分号分隔，例如 `18-24;25-34`。 */
  ageRanges: string;
  /** `不限` / `男` / `女`。 */
  gender: string;
  sourceAdGroupId: string;
  sourceAdGroupName: string;
  sourceCampaignId: string;
  sourceCampaignName: string;
  inheritedFrom: ExpandSheetInheritance | null;
  /** 这一行还缺哪些列（用表头文案），空数组表示除视频代码外都齐了。 */
  missing: string[];
}

export interface ExpandSheetPlan {
  /** 表头，顺序与 `launchSheetColumns` 一致。 */
  header: string[];
  rows: ExpandSheetRow[];
  /** 缺字段的行汇总，`rowNumber` 是表格里的行号（表头占第 1 行）。 */
  incomplete: Array<{ rowNumber: number; adGroupName: string; missing: string[] }>;
  /** 会阻断创建的问题，必须在导入前处理。 */
  warnings: string[];
}

const GENDER_LABEL: Record<LaunchGender, string> = {
  all: "不限",
  male: "男",
  female: "女",
};

const DEFAULT_AGE_RANGES = [...LaunchAgeRangeValues];

function formatAgeRanges(ranges: readonly LaunchAgeRange[] | null | undefined): string {
  const selected = ranges && ranges.length > 0 ? ranges : DEFAULT_AGE_RANGES;
  // 按枚举顺序输出，不按传入顺序：表格是给人读的，年龄档乱序会让人以为填错了。
  return LaunchAgeRangeValues.filter((value) => selected.includes(value)).join(";");
}

/**
 * 生成导入表的行。
 *
 * 命名规则与一键扩组逐字对齐：
 * - 广告组名 = `{清洗后源组名}-{MMDD}-{HHMMSS}-{序号}`
 * - 新建系列时的系列名 = `{清洗后源系列名}-{MMDD}-{HHMMSS}`
 *
 * 账户现有名称只作兜底跳过，不参与定序号——本地快照最长可能滞后一整轮轮询，靠它定
 * 序号会把刚建好、还没同步到的对象误判成名字可用。
 */
export function buildExpandSheetPlan(input: ExpandSheetInput): ExpandSheetPlan {
  const count = Math.max(1, Math.floor(input.countPerSource));
  const existingAdGroupNames = new Set(input.existingAdGroupNames ?? []);
  const existingCampaignNames = new Set(input.existingCampaignNames ?? []);
  const usedBaseNames = new Set<string>();
  const rows: ExpandSheetRow[] = [];
  const warnings: string[] = [];

  for (const source of input.sources) {
    const cleanedAdGroupName = stripGeneratedNameSuffixes(source.sourceAdGroupName);
    const baseName = allocateExpandBaseName({
      cleanedSourceName: cleanedAdGroupName,
      deliveryAt: input.deliveryAt,
      timeZone: input.timeZone,
      usedBaseNames,
      existingNames: existingAdGroupNames,
    });
    usedBaseNames.add(baseName);

    let campaignName: string;
    if (input.sameCampaign) {
      // 现有系列必须逐字精确匹配才能被复用，一个字都不能清洗。
      campaignName = source.sourceCampaignName;
      if (input.duplicateCampaignNames?.has(campaignName.trim())) {
        warnings.push(
          `账户内存在多条名为“${campaignName}”的推广系列，按名复用无法判定该并入哪一条；请先在 TikTok 后台改名，或改用新建系列。`,
        );
      }
    } else {
      const plan = planGeneratedNames({
        sourceName: source.sourceCampaignName,
        count: 1,
        at: input.deliveryAt,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
        existingNames: existingCampaignNames,
      });
      campaignName = plan.names[0] ?? source.sourceCampaignName;
      existingCampaignNames.add(campaignName);
    }

    const productUrl = source.productUrl?.trim() ?? "";
    const inheritedFrom = source.inheritedFrom ?? null;
    for (let index = 0; index < count; index += 1) {
      const adGroupName = `${baseName}-${index + 1}`;
      // 同一批里后面的源组要看得见前面已占用的名字，否则两个洗出同名基名的源组会撞。
      existingAdGroupNames.add(adGroupName);
      const missing: string[] = [];
      if (!productUrl) missing.push("产品 URL");
      rows.push({
        campaignName,
        adGroupName,
        videoCode: "",
        productUrl,
        ageRanges: formatAgeRanges(source.ageRanges),
        gender: GENDER_LABEL[source.gender ?? "all"],
        sourceAdGroupId: source.sourceAdGroupId,
        sourceAdGroupName: source.sourceAdGroupName,
        sourceCampaignId: source.sourceCampaignId,
        sourceCampaignName: source.sourceCampaignName,
        inheritedFrom,
        missing,
      });
    }
  }

  const incomplete = rows
    .map((row, index) => ({ rowNumber: index + 2, adGroupName: row.adGroupName, missing: row.missing }))
    .filter((entry) => entry.missing.length > 0);

  return {
    header: launchSheetColumns.map((column) => column.label),
    rows,
    incomplete,
    // 同一条 warning 可能被多个源组触发，去重后再返回。
    warnings: [...new Set(warnings)],
  };
}

/** 表格主体，含表头，可直接写进 xlsx 或 CSV。 */
export function expandSheetTable(plan: ExpandSheetPlan): string[][] {
  return [
    plan.header,
    ...plan.rows.map((row) => [
      row.campaignName,
      row.adGroupName,
      row.videoCode,
      row.productUrl,
      row.ageRanges,
      row.gender,
    ]),
  ];
}
