import { describe, expect, it } from "vitest";
import { parseTikTokCurl, TikTokCurlImportError } from "./curl-import.js";

describe("parseTikTokCurl", () => {
  it("imports a Chrome POST request without exposing secrets in settings", () => {
    const imported = parseTikTokCurl(`curl 'https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=123456&msToken=ephemeral-token' \\
      -H 'content-type: application/json' \\
      -H 'cookie: sessionid=authorized-test-cookie' \\
      -H 'x-csrftoken: csrf-test-value' \\
      --data-raw '{"page":1}'`);

    expect(imported.settings.advertiserId).toBe("123456");
    expect(JSON.stringify(imported.settings)).not.toContain("ephemeral-token");
    expect(imported.credential.requestTemplates?.[0]).toMatchObject({
      target: "ad-group",
      method: "POST",
      body: '{"page":1}',
    });
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
});
