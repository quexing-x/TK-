import { describe, expect, it } from "vitest";
import {
  CookieConnectionReadinessSchema,
  CookieConnectionSettingsSchema,
  ProviderCredentialInputSchema,
} from "./connection.js";

describe("provider connection validation", () => {
  it("accepts TikTok HTTPS URLs", () => {
    expect(
      CookieConnectionSettingsSchema.parse({
        kind: "cookie",
        advertiserId: "123",
        healthUrl: "https://ads.tiktok.com/api/example",
        campaignsUrl: "",
        adGroupsUrl: "",
        adsUrl: "",
      }).advertiserId,
    ).toBe("123");
  });

  it("rejects a non-TikTok endpoint", () => {
    expect(() =>
      CookieConnectionSettingsSchema.parse({
        kind: "cookie",
        advertiserId: "123",
        healthUrl: "https://example.com/collect",
        campaignsUrl: "",
        adGroupsUrl: "",
        adsUrl: "",
      }),
    ).toThrow();
  });

  it("validates both credential shapes", () => {
    expect(
      ProviderCredentialInputSchema.parse({
        kind: "official-api",
        accessToken: "token-with-enough-length",
      }).kind,
    ).toBe("official-api");
  });

  it("validates the five documented Cookie fields", () => {
    expect(
      CookieConnectionReadinessSchema.parse({
        dataRequestImported: true,
        statusRequestImported: true,
        requiredFields: {
          listQuery: true,
          updateQuery: true,
          copyQuery: true,
          csrfToken: true,
          cookie: true,
        },
        completedFields: 5,
        totalFields: 5,
        fieldsComplete: true,
      }).fieldsComplete,
    ).toBe(true);
  });
});
