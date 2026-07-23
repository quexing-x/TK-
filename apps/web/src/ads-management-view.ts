import type { ManagedEntityRecord } from "@tk-auto/core";

export const ADS_MANAGEMENT_DEFAULT_LEVEL = "ad-group" as const;
export const ADS_MANAGEMENT_DEFAULT_STATUS = "enabled" as const;
export const ADS_MANAGEMENT_WINDOW_HOURS = 48 as const;
export const ADS_MANAGEMENT_PAGE_SIZE = 15 as const;

export function compareAdsManagementSpend(
  left: ManagedEntityRecord,
  right: ManagedEntityRecord,
): number {
  return (right.metrics.spend ?? 0) - (left.metrics.spend ?? 0);
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
  },
): ManagedEntityRecord[] {
  const normalizedQuery = input.query.trim().toLowerCase();
  const cutoff = (input.now ?? new Date()).getTime() - ADS_MANAGEMENT_WINDOW_HOURS * 60 * 60_000;
  return entities
    .map((entity, index) => ({ entity, index }))
    .filter(({ entity }) => {
      const createdAt = entity.createdAt ? new Date(entity.createdAt).getTime() : Number.NaN;
      if (!Number.isFinite(createdAt) || createdAt < cutoff) return false;
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
