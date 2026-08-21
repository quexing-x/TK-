import { RULE_LOOKBACK_HOURS, type ManagedEntityRecord } from "@tk-auto/core";

export const ADS_MANAGEMENT_DEFAULT_LEVEL = "ad-group" as const;
export const ADS_MANAGEMENT_DEFAULT_STATUS = "enabled" as const;
export const ADS_MANAGEMENT_PAGE_SIZE = 15 as const;

/**
 * 列表默认只看规则引擎真正会评估的对象。
 *
 * 48 小时是规则的评估窗口，不是对象的存活期——账户里三周前建的广告组只要没删就一直
 * 在同步结果里，全量铺在列表上会把当天要盯的十几个组淹掉（实测某账户 56 个在管广告组
 * 里只有 15 个落在窗口内）。默认收窄到窗口内，"全部"仍可切回去手动启停老组。
 */
export const ADS_MANAGEMENT_DEFAULT_CREATED_WINDOW = "recent" as const;
export type AdsManagementCreatedWindow = "recent" | "all";

/** 与规则引擎共用同一个回看窗口，避免两边各写一个 48。 */
export const ADS_MANAGEMENT_RECENT_WINDOW_HOURS = RULE_LOOKBACK_HOURS;

/**
 * 与 core 的 filterEntitiesToRecentWindow 对齐的可见性判据：
 *
 * - 广告组：创建时间落在窗口内；或当天有消耗（spend>0）——"今天还在投的活对象"不能
 *   因为建得早就从列表上消失。
 * - 广告 / 素材：跟随所属广告组，广告组可见则子级可见；素材层本身没有创建时间。
 * - 缺创建时间的对象按窗口外处理，与引擎一致（引擎对没有 create_time 的广告组直接跳过）。
 *
 * 引擎还有第三条存活路子——持久管辖集（自动化关停、尚未自动开回的广告组）。那是服务端
 * 状态，界面拿不到；这类组当天多半零消耗，因此可能落在"最近"之外，切"全部"能看到。
 */
export function isWithinAdsManagementCreatedWindow(
  entity: ManagedEntityRecord,
  input: {
    now: Date;
    visibleAdGroupIds?: ReadonlySet<string>;
  },
): boolean {
  if (entity.entityType === "ad" || entity.entityType === "material") {
    const adGroupId = entity.parentAdGroupId;
    if (adGroupId && input.visibleAdGroupIds?.has(adGroupId)) return true;
  }
  const createdAt = entity.createdAt ? Date.parse(entity.createdAt) : Number.NaN;
  if (!Number.isFinite(createdAt)) return false;
  // 上游偶尔回传略微超前于本机时钟的创建时间，留 5 分钟容差，与引擎同口径。
  if (createdAt > input.now.getTime() + 5 * 60_000) return false;
  if (createdAt >= input.now.getTime() - ADS_MANAGEMENT_RECENT_WINDOW_HOURS * 60 * 60_000) {
    return true;
  }
  return entity.entityType === "ad-group" && (entity.metrics.spend ?? 0) > 0;
}

export type AdsManagementParticipation =
  | "manual-takeover"
  | "participating"
  | "outside-window";

/**
 * 该对象当前是否真的会被规则引擎评估。
 *
 * 原先这一列硬编码成 `ignored ? "人工接管" : "参与"`，从不看窗口——账户里三周前建的
 * 广告组照样显示「参与」，而引擎根本够不着它。三条判据与 filterEntitiesToRecentWindow
 * 一一对应：人工接管出局；窗口内、当天有消耗、或在持久管辖集内都算参与；其余是窗口外。
 */
export function adsManagementParticipation(
  entity: ManagedEntityRecord,
  input: { now?: Date; visibleAdGroupIds?: ReadonlySet<string> } = {},
): AdsManagementParticipation {
  if (entity.ignored) return "manual-takeover";
  if (entity.automationManaged) return "participating";
  const now = input.now ?? new Date();
  return isWithinAdsManagementCreatedWindow(entity, {
    now,
    ...(input.visibleAdGroupIds ? { visibleAdGroupIds: input.visibleAdGroupIds } : {}),
  })
    ? "participating"
    : "outside-window";
}

export function adsManagementParticipationLabel(
  participation: AdsManagementParticipation,
): string {
  switch (participation) {
    case "manual-takeover":
      return "人工接管";
    case "participating":
      return "参与";
    case "outside-window":
      return "窗口外";
  }
}

/**
 * 按创建窗口筛出可见对象。先定广告组，再让广告/素材跟随其所属广告组。
 */
export function filterAdsManagementEntitiesByCreatedWindow(
  entities: ManagedEntityRecord[],
  input: { createdWindow: AdsManagementCreatedWindow; now?: Date },
): ManagedEntityRecord[] {
  if (input.createdWindow === "all") return entities;
  const now = input.now ?? new Date();
  const visibleAdGroupIds = new Set(
    entities
      .filter((entity) => entity.entityType === "ad-group")
      .filter((entity) => isWithinAdsManagementCreatedWindow(entity, { now }))
      .map((entity) => entity.externalId),
  );
  return entities.filter((entity) => (
    isWithinAdsManagementCreatedWindow(entity, { now, visibleAdGroupIds })
  ));
}

export function compareAdsManagementSpend(
  left: ManagedEntityRecord,
  right: ManagedEntityRecord,
): number {
  return (right.metrics.spend ?? 0) - (left.metrics.spend ?? 0);
}

export function sumAdsManagementConversions(entities: ManagedEntityRecord[]): number {
  return entities.reduce((total, entity) => total + (entity.metrics.conversions ?? 0), 0);
}

export function paginateAdsManagementItems<T>(
  items: T[],
  page: number,
): { items: T[]; pageCount: number; currentPage: number } {
  const pageCount = Math.max(1, Math.ceil(items.length / ADS_MANAGEMENT_PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  return {
    items: items.slice(
      currentPage * ADS_MANAGEMENT_PAGE_SIZE,
      currentPage * ADS_MANAGEMENT_PAGE_SIZE + ADS_MANAGEMENT_PAGE_SIZE,
    ),
    pageCount,
    currentPage,
  };
}

export function filterAdsManagementEntities(
  entities: ManagedEntityRecord[],
  input: {
    level: "all" | ManagedEntityRecord["entityType"];
    status: "all" | ManagedEntityRecord["status"];
    query: string;
    now?: Date;
    /** 省略即不按创建时间过滤，保持"同步里还在就看得到"的既有语义。 */
    createdWindow?: AdsManagementCreatedWindow;
  },
): ManagedEntityRecord[] {
  const normalizedQuery = input.query.trim().toLowerCase();
  return filterAdsManagementEntitiesByCreatedWindow(entities, {
    createdWindow: input.createdWindow ?? "all",
    ...(input.now ? { now: input.now } : {}),
  })
    .map((entity, index) => ({ entity, index }))
    .filter(({ entity }) => {
      if (input.level !== "all" && entity.entityType !== input.level) return false;
      if (input.status !== "all" && entity.status !== input.status) return false;
      return !normalizedQuery
        || entity.name.toLowerCase().includes(normalizedQuery)
        || entity.externalId.toLowerCase().includes(normalizedQuery);
    })
    .sort((left, right) => (
      compareAdsManagementSpend(left.entity, right.entity)
      || left.index - right.index
    ))
    .map(({ entity }) => entity);
}
