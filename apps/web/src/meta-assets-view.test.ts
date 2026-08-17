import { describe, expect, it } from "vitest";
import type { AdOperationRecord, AutomationDecisionRecord } from "@tk-auto/core";
import type { MetaAssetRecord } from "./api";
import {
  configuredMetaStatus,
  filterMetaAssets,
  latestMetaOperationByEntity,
  metaAssetLevelLabel,
  metaStatusLabel,
  paginateMetaAssets,
  selectMetaExecutionReports,
  sortMetaAssetsForDisplay,
} from "./meta-assets-view";

const assets = [
  {
    entityType: "campaign",
    externalId: "1",
    name: "Always paused campaign",
    status: "disabled",
    configuredStatus: "PAUSED",
  },
  {
    entityType: "ad-group",
    externalId: "2",
    name: "Reusable ad set",
    status: "enabled",
  },
  {
    entityType: "ad",
    externalId: "3",
    name: "Roundtrip ad",
    status: "unknown",
  },
] as MetaAssetRecord[];

describe("Meta assets view", () => {
  it("uses Meta terminology and preserves configured status", () => {
    expect(metaAssetLevelLabel("campaign")).toBe("广告系列");
    expect(metaAssetLevelLabel("ad-group")).toBe("广告组");
    expect(metaStatusLabel("ACTIVE")).toBe("已开启");
    expect(metaStatusLabel("PAUSED")).toBe("已暂停");
    expect(configuredMetaStatus(assets[0]!)).toBe("PAUSED");
    expect(configuredMetaStatus(assets[1]!)).toBe("ACTIVE");
    expect(configuredMetaStatus(assets[2]!)).toBe("unknown");
  });

  it("shows the campaign hierarchy before ad sets and ads", () => {
    expect(sortMetaAssetsForDisplay([assets[2]!, assets[1]!, assets[0]!]).map((asset) => asset.entityType))
      .toEqual(["campaign", "ad-group", "ad"]);
  });

  it("filters by all three levels without admitting materials", () => {
    expect(filterMetaAssets(assets, { level: "ad", status: "all", query: "" }))
      .toEqual([assets[2]]);
    expect(filterMetaAssets(assets, { level: "all", status: "PAUSED", query: "campaign" }))
      .toEqual([assets[0]]);
  });

  it("keeps only the latest Meta operation for each object", () => {
    const operations = [
      { providerKind: "meta-marketing-api", entityType: "ad", externalId: "3", status: "pending", createdAt: "2026-08-16T00:00:00.000Z" },
      { providerKind: "meta-marketing-api", entityType: "ad", externalId: "3", status: "succeeded", createdAt: "2026-08-16T00:01:00.000Z" },
      { providerKind: "cookie", entityType: "ad", externalId: "3", status: "failed", createdAt: "2026-08-16T00:02:00.000Z" },
    ] as AdOperationRecord[];
    expect(latestMetaOperationByEntity(operations).get("ad:3")?.status).toBe("succeeded");
  });

  it("paginates Meta objects at 20 rows and clamps an out-of-range page", () => {
    const manyAssets = Array.from({ length: 45 }, (_, index) => ({
      ...assets[0],
      externalId: String(index + 1),
    })) as MetaAssetRecord[];

    expect(paginateMetaAssets(manyAssets, 0)).toMatchObject({
      page: 0,
      pageCount: 3,
      total: 45,
    });
    expect(paginateMetaAssets(manyAssets, 0).items).toHaveLength(20);
    expect(paginateMetaAssets(manyAssets, 99).items.map((asset) => asset.externalId))
      .toEqual(["41", "42", "43", "44", "45"]);
  });

  it("keeps only Meta execution reports and shows the newest first", () => {
    const decisions = [
      { id: "older-meta", providerKind: "meta-marketing-api", createdAt: "2026-08-16T00:00:00.000Z" },
      { id: "tiktok", providerKind: "cookie", createdAt: "2026-08-16T00:02:00.000Z" },
      { id: "newer-meta", providerKind: "meta-marketing-api", createdAt: "2026-08-16T00:01:00.000Z" },
    ] as AutomationDecisionRecord[];

    expect(selectMetaExecutionReports(decisions).map((decision) => decision.id))
      .toEqual(["newer-meta", "older-meta"]);
  });
});
