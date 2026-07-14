import { describe, expect, it } from "vitest";
import {
  parseTikTokCurl,
  parseTikTokStatusCurl,
  TikTokCurlImportError,
} from "./curl-import.js";

describe("parseTikTokCurl", () => {
  it("imports a Chrome POST request without exposing secrets in settings", () => {
    const imported = parseTikTokCurl(`curl 'https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=123456&msToken=ephemeral-token' \\
      -H 'content-type: application/json' \\
      -H 'cookie: sessionid=authorized-test-cookie' \\
      -H 'x-csrftoken: csrf-test-value' \\
      --data-raw '{"page":1}'`);

    expect(imported.settings.advertiserId).toBe("123456");
    expect(JSON.stringify(imported.settings)).not.toContain("ephemeral-token");
    expect(imported.credential.requestTemplates).toHaveLength(3);
    expect(imported.credential.requestTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "campaign",
          derived: true,
        }),
        expect.objectContaining({
          target: "ad-group",
          method: "POST",
          body: '{"page":1}',
          derived: false,
        }),
        expect.objectContaining({ target: "ad", derived: true }),
      ]),
    );
    expect(imported.credential.cookie).toBe(
      "sessionid=authorized-test-cookie",
    );
  });

  it("rejects non-TikTok destinations", () => {
    expect(() =>
      parseTikTokCurl(
        "curl 'https://example.com/list?aadvid=1' -H 'cookie: sessionid=test-value'",
      ),
    ).toThrow(TikTokCurlImportError);
  });

  it("labels a captured switch request by entity level and action", () => {
    const imported = parseTikTokStatusCurl(
      `curl 'https://ads.tiktok.com/api/v4/i18n/adgroup/status/update/?aadvid=123456' -H 'cookie: sessionid=authorized-test-cookie' -H 'content-type: application/json' --data-raw '{"ad_id":"old-id","status":0}'`,
    );

    expect(imported.credential.requestTemplates).toHaveLength(6);
    expect(imported.credential.requestTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "ad-group-status",
          action: "enable",
          body: '{"ad_id":"old-id","status":1}',
          derived: false,
        }),
        expect.objectContaining({
          target: "campaign-status",
          action: "disable",
          body: '{"campaign_id":"old-id","status":0}',
          derived: true,
        }),
        expect.objectContaining({
          target: "ad-status",
          action: "enable",
          body: '{"ad_id":"old-id","status":1}',
          derived: true,
        }),
      ]),
    );
  });
});
