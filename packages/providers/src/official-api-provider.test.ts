import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeProviderEntity } from "@tk-auto/core";
import { OfficialApiAdsProvider, OFFICIAL_REPORT_METRICS } from "./official-api-provider.js";

afterEach(() => vi.unstubAllGlobals());

describe("OfficialApiAdsProvider reporting", () => {
  it("requests the Shop add-to-cart metric used by the shared rules", () => {
    expect(OFFICIAL_REPORT_METRICS).toContain("onsite_on_web_cart");
  });

  it("rejects health authorization when the list contract is incomplete", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, data: { list: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    await expect(new OfficialApiAdsProvider().checkHealth({
      accountId: "official-test",
      settings: { kind: "official-api", advertiserId: "123" },
      credential: { kind: "official-api", accessToken: "test-access-token" },
    })).rejects.toThrow();
  });

  it("authorizes health only with a valid list and pagination contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        code: 0,
        data: { list: [{ campaign_id: "campaign-1" }], page_info: { total_page: 1 } },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    await expect(new OfficialApiAdsProvider().checkHealth({
      accountId: "official-test",
      settings: { kind: "official-api", advertiserId: "123" },
      credential: { kind: "official-api", accessToken: "test-access-token" },
    })).resolves.toMatchObject({ status: "ready" });
  });

  it("classifies a dispatched status transport failure as unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("connection reset");
    }));

    const result = await new OfficialApiAdsProvider().changeStatus({
      accountId: "official-test",
      settings: { kind: "official-api", advertiserId: "123" },
      credential: { kind: "official-api", accessToken: "test-access-token" },
    }, [{ entityType: "ad-group", externalId: "group-1", action: "disable" }]);

    expect(result[0]).toMatchObject({ ok: false, failureKind: "unknown" });
  });

  it("classifies a structured status rejection as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: 40002, message: "rejected" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ));

    const result = await new OfficialApiAdsProvider().changeStatus({
      accountId: "official-test",
      settings: { kind: "official-api", advertiserId: "123" },
      credential: { kind: "official-api", accessToken: "test-access-token" },
    }, [{ entityType: "ad-group", externalId: "group-1", action: "disable" }]);

    expect(result[0]).toMatchObject({ ok: false, failureKind: "retryable" });
  });

  it("classifies conflicting HTTP failure with business code zero as unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: 0 }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
    ));

    const result = await new OfficialApiAdsProvider().changeStatus({
      accountId: "official-test",
      settings: { kind: "official-api", advertiserId: "123" },
      credential: { kind: "official-api", accessToken: "test-access-token" },
    }, [{ entityType: "ad-group", externalId: "group-1", action: "disable" }]);

    expect(result[0]).toMatchObject({ ok: false, failureKind: "unknown" });
  });

  it("emits the shared normalized entity and quality contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const report = url.pathname.includes("/report/integrated/get/");
      const endpoint = url.pathname.match(/\/(campaign|adgroup|ad)\/get\/$/)?.[1] ?? "ad";
      const idKey = endpoint === "campaign" ? "campaign_id" : endpoint === "adgroup" ? "adgroup_id" : "ad_id";
      const reportLevel = url.searchParams.get("data_level");
      const reportEntity = reportLevel === "AUCTION_CAMPAIGN" ? "campaign" : reportLevel === "AUCTION_ADGROUP" ? "adgroup" : "ad";
      const id = `${report ? reportEntity : endpoint}-1`;
      const data = report
        ? {
            list: [{
              dimensions: { [url.searchParams.get("data_level") === "AUCTION_CAMPAIGN" ? "campaign_id" : url.searchParams.get("data_level") === "AUCTION_ADGROUP" ? "adgroup_id" : "ad_id"]: id },
              metrics: {
                spend: "1",
                cpc: "0.5",
                cost_per_conversion: "1",
                conversion: "1",
                onsite_on_web_cart: "1",
              },
            }],
            page_info: { total_page: 1 },
          }
        : { list: [{ [idKey]: id }], page_info: { total_page: 1 } };
      return new Response(JSON.stringify({ code: 0, data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const output = await new OfficialApiAdsProvider().syncReadOnly({
      accountId: "official-test",
      timezone: "Asia/Taipei",
      settings: { kind: "official-api", advertiserId: "123" },
      credential: { kind: "official-api", accessToken: "test-access-token" },
    });

    expect(output.result.quality).toMatchObject({
      status: "healthy",
      paginationComplete: true,
      contractValid: true,
    });
    expect(output.entities.map(normalizeProviderEntity)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metrics: expect.objectContaining({ spend: 1, carts: 1 }) }),
      ]),
    );
  });

  it("does not claim pagination completeness without page metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, data: { list: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    const output = await new OfficialApiAdsProvider().syncReadOnly({
      accountId: "official-test",
      timezone: "UTC",
      settings: { kind: "official-api", advertiserId: "123" },
      credential: { kind: "official-api", accessToken: "test-access-token" },
    });

    expect(output.result.quality).toMatchObject({
      status: "partial",
      paginationComplete: false,
      contractValid: true,
    });
  });

  it.each([undefined, "", "   ", Number.NaN, Number.POSITIVE_INFINITY])(
    "marks malformed list stable ID %p as invalid contract data",
    async (campaignId) => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const report = url.pathname.includes("/report/integrated/get/");
      const data = report
        ? { list: [], page_info: { total_page: 1 } }
        : { list: [{ campaign_id: campaignId }], page_info: { total_page: 1 } };
      return new Response(JSON.stringify({ code: 0, data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const output = await new OfficialApiAdsProvider().syncReadOnly({
      accountId: "official-test",
      timezone: "UTC",
      settings: { kind: "official-api", advertiserId: "123" },
      credential: { kind: "official-api", accessToken: "test-access-token" },
    });

    expect(output.result.quality).toMatchObject({ status: "invalid", contractValid: false });
    },
  );

  it("skips an invalid preferred list ID and extracts the valid fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const report = url.pathname.includes("/report/integrated/get/");
      const level = url.searchParams.get("data_level");
      const dimension = level === "AUCTION_CAMPAIGN" ? "campaign_id" : level === "AUCTION_ADGROUP" ? "adgroup_id" : "ad_id";
      const endpoint = url.pathname.match(/\/(campaign|adgroup|ad)\/get\/$/)?.[1] ?? "ad";
      const primaryKey = endpoint === "campaign" ? "campaign_id" : endpoint === "adgroup" ? "adgroup_id" : "ad_id";
      const data = report
        ? {
            list: [{
              dimensions: { [dimension]: "valid-fallback-id" },
              metrics: { spend: "1", cpc: "1", cost_per_conversion: "1", conversion: "1", onsite_on_web_cart: "1" },
            }],
            page_info: { total_page: 1 },
          }
        : {
            list: [{ [primaryKey]: " ", id: "valid-fallback-id" }],
            page_info: { total_page: 1 },
          };
      return new Response(JSON.stringify({ code: 0, data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const output = await new OfficialApiAdsProvider().syncReadOnly({
      accountId: "official-test",
      timezone: "UTC",
      settings: { kind: "official-api", advertiserId: "123" },
      credential: { kind: "official-api", accessToken: "test-access-token" },
    });

    expect(output.result.quality.status).toBe("healthy");
    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: "valid-fallback-id" }),
    ]));
    expect(output.entities).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: " " }),
    ]));
  });
});
