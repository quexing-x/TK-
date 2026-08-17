import type { AdOperationRecord } from "@tk-auto/core";
import type { MetaAssetEntityType, MetaAssetRecord } from "./api";

export type MetaAssetLevelFilter = "all" | MetaAssetEntityType;
export type MetaAssetStatusFilter = "all" | "ACTIVE" | "PAUSED" | "unknown";

export function metaAssetLevelLabel(entityType: MetaAssetEntityType): string {
  return {
    campaign: "Campaign",
    "ad-group": "Ad Set",
    ad: "Ad",
  }[entityType];
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
