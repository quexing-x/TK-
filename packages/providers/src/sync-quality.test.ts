import { describe, expect, it } from "vitest";
import { buildSyncDataQuality } from "./sync-quality.js";

const coverage = {
  startDate: "2026-07-17",
  endDate: "2026-07-17",
  timezone: "Asia/Taipei",
};

describe("sync data quality", () => {
  it("is healthy only when pagination, contract and required metrics are complete", () => {
    const quality = buildSyncDataQuality({
      entities: [{
        entityType: "ad-group",
        externalId: "g1",
        payload: {
          metrics: {
            spend: "1",
            cpc: "0.5",
            cost_per_conversion: "1",
            conversion: "1",
            onsite_on_web_cart: "1",
          },
        },
      }],
      paginationComplete: true,
      contractValid: true,
      providerContractVersion: "test-v1",
      coverage,
      partialFailures: [],
    });

    expect(quality).toMatchObject({
      status: "healthy",
      paginationComplete: true,
      requiredMetricsComplete: true,
      contractValid: true,
      missingMetrics: [],
    });
  });

  it("marks missing CPA/CPC/conversion/cart metrics as partial", () => {
    const quality = buildSyncDataQuality({
      entities: [{ entityType: "ad", externalId: "a1", payload: { metrics: { spend: "1" } } }],
      paginationComplete: true,
      contractValid: true,
      providerContractVersion: "test-v1",
      coverage,
      partialFailures: [],
    });

    expect(quality.status).toBe("partial");
    expect(quality.missingMetrics).toEqual(expect.arrayContaining([
      "cost_per_click",
      "cost_per_conversion",
      "conversions",
      "carts",
    ]));
  });

  it("marks contract drift invalid regardless of other completeness", () => {
    const quality = buildSyncDataQuality({
      entities: [],
      paginationComplete: true,
      contractValid: false,
      providerContractVersion: "test-v1",
      coverage,
      partialFailures: [],
    });

    expect(quality.status).toBe("invalid");
  });
});
