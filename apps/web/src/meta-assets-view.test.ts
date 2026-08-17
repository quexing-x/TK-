import { describe, expect, it } from "vitest";
import type { AdOperationRecord } from "@tk-auto/core";
import type { MetaAssetRecord } from "./api";
import {
  configuredMetaStatus,
  filterMetaAssets,
  latestMetaOperationByEntity,
  metaAssetLevelLabel,
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
    expect(metaAssetLevelLabel("campaign")).toBe("Campaign");
    expect(metaAssetLevelLabel("ad-group")).toBe("Ad Set");
    expect(configuredMetaStatus(assets[0]!)).toBe("PAUSED");
    expect(configuredMetaStatus(assets[1]!)).toBe("ACTIVE");
    expect(configuredMetaStatus(assets[2]!)).toBe("unknown");
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
});
