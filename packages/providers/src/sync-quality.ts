import {
  normalizeProviderEntity,
  type ProviderEntity,
  type SyncDataCoverage,
  type SyncDataQuality,
} from "@tk-auto/core";

const requiredMetrics = [
  "spend",
  "cost_per_click",
  "cost_per_conversion",
  "conversions",
  "carts",
] as const;

export function buildSyncDataQuality(input: {
  entities: ProviderEntity[];
  paginationComplete: boolean;
  contractValid: boolean;
  providerContractVersion: string;
  coverage: SyncDataCoverage;
  partialFailures: string[];
}): SyncDataQuality {
  const managed = input.entities
    .filter((entity) => entity.entityType === "ad-group" || entity.entityType === "ad")
    .map(normalizeProviderEntity);
  const missingMetrics = managed.length === 0
    ? [...requiredMetrics]
    : requiredMetrics.filter((metric) =>
        managed.some((entity) => entity.metrics[metric] === null),
      );
  const requiredMetricsComplete = missingMetrics.length === 0;
  const status = !input.contractValid
    ? "invalid"
    : input.paginationComplete &&
        input.partialFailures.length === 0
      ? "healthy"
      : "partial";

  return {
    status,
    paginationComplete: input.paginationComplete,
    requiredMetricsComplete,
    contractValid: input.contractValid,
    providerContractVersion: input.providerContractVersion,
    coverage: input.coverage,
    missingMetrics,
    partialFailures: [...input.partialFailures],
    lastHealthyAt: null,
  };
}

export function formatDateInTimezone(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
