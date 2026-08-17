import type { AdOperationRecord, AutomationDecisionRecord } from "@tk-auto/core";
import type { MetaAssetEntityType, MetaAssetRecord } from "./api";

export type MetaAssetLevelFilter = "all" | MetaAssetEntityType;
export type MetaAssetStatusFilter = "all" | "ACTIVE" | "PAUSED" | "unknown";

export function metaAssetLevelLabel(entityType: MetaAssetEntityType): string {
  return {
    campaign: "广告系列",
    "ad-group": "广告组",
    ad: "广告",
  }[entityType];
}

export function metaStatusLabel(status: string): string {
  return {
    ACTIVE: "已开启",
    PAUSED: "已暂停",
    unknown: "待核验",
  }[status] ?? status;
}

const metaAssetLevelOrder: Record<MetaAssetEntityType, number> = {
  campaign: 0,
  "ad-group": 1,
  ad: 2,
};

/**
 * Keep the hierarchy readable even when the provider returns pages in an
 * arbitrary order: campaign first, then its ad sets, then ads. Within a
 * level, preserve the sync order so a refresh does not make the table jump.
 */
export function sortMetaAssetsForDisplay(
  assets: readonly MetaAssetRecord[],
): MetaAssetRecord[] {
  return assets
    .map((asset, index) => ({ asset, index }))
    .sort((left, right) => (
      metaAssetLevelOrder[left.asset.entityType] - metaAssetLevelOrder[right.asset.entityType]
      || left.index - right.index
    ))
    .map(({ asset }) => asset);
}

export function configuredMetaStatus(asset: MetaAssetRecord): string {
  if (asset.configuredStatus?.trim()) return asset.configuredStatus.trim().toUpperCase();
  if (asset.status === "enabled") return "ACTIVE";
  if (asset.status === "disabled") return "PAUSED";
  return "unknown";
}

export function filterMetaAssets(
  assets: readonly MetaAssetRecord[],
  filters: {
    level: MetaAssetLevelFilter;
    status: MetaAssetStatusFilter;
    query: string;
  },
): MetaAssetRecord[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return assets.filter((asset) => {
    const configuredStatus = configuredMetaStatus(asset);
    return (filters.level === "all" || asset.entityType === filters.level)
      && (filters.status === "all" || configuredStatus === filters.status)
      && (!query || `${asset.name} ${asset.externalId}`.toLocaleLowerCase().includes(query));
  });
}

export function latestMetaOperationByEntity(
  operations: readonly AdOperationRecord[],
): Map<string, AdOperationRecord> {
  const result = new Map<string, AdOperationRecord>();
  for (const operation of operations) {
    if (operation.providerKind !== "meta-marketing-api") continue;
    const key = `${operation.entityType}:${operation.externalId}`;
    const current = result.get(key);
    if (!current || Date.parse(operation.createdAt) > Date.parse(current.createdAt)) {
      result.set(key, operation);
    }
  }
  return result;
}

export function isMetaOperationPending(operation: AdOperationRecord | undefined): boolean {
  return operation?.status === "pending" || operation?.status === "running";
}

export interface MetaAssetPage {
  items: MetaAssetRecord[];
  page: number;
  pageCount: number;
  total: number;
}

export function paginateMetaAssets(
  assets: readonly MetaAssetRecord[],
  requestedPage: number,
  pageSize = 20,
): MetaAssetPage {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(assets.length / safePageSize));
  const page = Math.min(Math.max(0, Math.floor(requestedPage)), pageCount - 1);
  const start = page * safePageSize;
  return {
    items: assets.slice(start, start + safePageSize),
    page,
    pageCount,
    total: assets.length,
  };
}

export function selectMetaExecutionReports(
  decisions: readonly AutomationDecisionRecord[],
): AutomationDecisionRecord[] {
  return decisions
    .filter((decision) => decision.providerKind === "meta-marketing-api")
    .slice()
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}
