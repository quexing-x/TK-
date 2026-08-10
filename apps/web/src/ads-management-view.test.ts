import { describe, expect, it } from "vitest";
import type { ManagedEntityRecord } from "@tk-auto/core";
import {
  ADS_MANAGEMENT_DEFAULT_LEVEL,
  ADS_MANAGEMENT_DEFAULT_STATUS,
  ADS_MANAGEMENT_PAGE_SIZE,
  filterAdsManagementEntities,
  paginateAdsManagementItems,
  sumAdsManagementConversions,
} from "./ads-management-view";

const entity = (
  externalId: string,
  status: ManagedEntityRecord["status"],
  syncedAt: string,
  spend: number | null = null,
  createdAt = syncedAt,
): ManagedEntityRecord => ({
  entityType: "ad-group",
  externalId,
  name: externalId,
  status,
  createdAt,
  parentCampaignId: null,
  parentAdGroupId: null,
  campaignBudget: null,
  campaignBudgetOptimized: false,
  metrics: {
    spend,
    cost_per_click: null,
    cost_per_conversion: null,
    cost_per_cart: null,
    conversions: null,
    carts: null,
    budget: null,
    clicks: null,
    impressions: null,
  },
  ignored: false,
  syncedAt,
});

describe("ads management view", () => {
  it("defaults to enabled ad groups", () => {
    expect(ADS_MANAGEMENT_DEFAULT_LEVEL).toBe("ad-group");
    expect(ADS_MANAGEMENT_DEFAULT_STATUS).toBe("enabled");
    expect(ADS_MANAGEMENT_PAGE_SIZE).toBe(15);
  });

  it("sums conversion metrics without counting missing values", () => {
    expect(sumAdsManagementConversions([
      {
        ...entity("one", "enabled", "2026-07-21T11:00:00.000Z"),
        metrics: { ...entity("one", "enabled", "2026-07-21T11:00:00.000Z").metrics, conversions: 2 },
      },
      {
        ...entity("two", "enabled", "2026-07-21T11:00:00.000Z"),
        metrics: { ...entity("two", "enabled", "2026-07-21T11:00:00.000Z").metrics, conversions: 1.5 },
      },
      entity("missing", "enabled", "2026-07-21T11:00:00.000Z"),
    ])).toBe(3.5);
  });

  it("keeps older live entities visible instead of treating 48 hours as their lifetime", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const result = filterAdsManagementEntities([
      entity("enabled", "enabled", "2026-07-21T11:00:00.000Z"),
      entity("disabled", "disabled", "2026-07-21T11:00:00.000Z", null, "2026-07-20T11:00:00.000Z"),
      entity("expired", "disabled", "2026-07-21T11:00:00.000Z", null, "2026-07-19T11:59:59.000Z"),
    ], { level: "ad-group", status: "all", query: "", now });

    expect(result.map((item) => item.externalId)).toEqual(["enabled", "disabled", "expired"]);
  });

  it("orders matching entities by spend from highest to lowest", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const result = filterAdsManagementEntities([
      entity("zero", "enabled", "2026-07-21T11:00:00.000Z", null),
      entity("medium", "enabled", "2026-07-21T11:00:00.000Z", 12.5),
      entity("high", "enabled", "2026-07-21T11:00:00.000Z", 99),
      entity("same-medium", "enabled", "2026-07-21T11:00:00.000Z", 12.5),
    ], { level: "ad-group", status: "enabled", query: "", now });

    expect(result.map((item) => item.externalId)).toEqual([
      "high",
      "medium",
      "same-medium",
      "zero",
    ]);
  });

  it("paginates sorted results in groups of 15", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const sorted = filterAdsManagementEntities(
      Array.from({ length: 16 }, (_, index) => (
        entity(`group-${index + 1}`, "enabled", "2026-07-21T11:00:00.000Z", index + 1)
      )),
      { level: "ad-group", status: "enabled", query: "", now },
    );

    expect(paginateAdsManagementItems(sorted, 0)).toMatchObject({
      currentPage: 0,
      pageCount: 2,
      items: sorted.slice(0, 15),
    });
    expect(paginateAdsManagementItems(sorted, 1)).toMatchObject({
      currentPage: 1,
      pageCount: 2,
      items: [sorted[15]],
    });
    expect(paginateAdsManagementItems(sorted.slice(0, 15), 1)).toMatchObject({
      currentPage: 0,
      pageCount: 1,
      items: sorted.slice(0, 15),
    });
  });
});
