import { describe, expect, it } from "vitest";
import { OFFICIAL_REPORT_METRICS } from "./official-api-provider.js";

describe("OfficialApiAdsProvider reporting", () => {
  it("requests the Shop add-to-cart metric used by the shared rules", () => {
    expect(OFFICIAL_REPORT_METRICS).toContain("onsite_on_web_cart");
  });
});
