import { describe, expect, it } from "vitest";
import {
  getTikTokCookieImportReadiness,
  parseTikTokCurl,
  parseTikTokReadCurl,
  parseTikTokStatusCurl,
  TikTokCurlImportError,
} from "./curl-import.js";
import { parseMultipartFields } from "./multipart.js";

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
        expect.objectContaining({
          target: "ad",
          derived: true,
          url: expect.stringContaining("/ad/list/"),
        }),
      ]),
    );
    const campaignTemplate = imported.credential.requestTemplates?.find(
      (item) => item.target === "campaign",
    );
    expect(JSON.parse(campaignTemplate?.body ?? "{}")).toMatchObject({
      common_req: {
        dimensions: ["campaign_id"],
        filters: [
          { field: "campaign_status", in_field_values: ["delete"], filter_type: 10 },
          { field: "campaign_system_origin", in_field_values: ["100000"], filter_type: 0 },
        ],
      },
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

  it("keeps the two onboarding steps separate", () => {
    const listCommand = `curl 'https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=123456' -H 'cookie: sessionid=test'`;
    const statusCommand = `curl 'https://ads.tiktok.com/api/v4/i18n/ad/update_status/?aadvid=123456' -H 'cookie: sessionid=test' -H 'content-type: application/json' --data-raw '{"ad_ids":["old-id"],"operation_status":"ENABLE"}'`;

    expect(() => parseTikTokStatusCurl(listCommand)).toThrow("第 2 段只接受真实启停请求");
    expect(() => parseTikTokReadCurl(statusCommand)).toThrow("第 1 段只接受");
  });

  it("labels a captured switch request by entity level and action", () => {
    const imported = parseTikTokCurl(
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
          derived: true,
        }),
      ]),
    );
  });

  it("accepts the documented ad update_status cURL as the three-level source", () => {
    const imported = parseTikTokStatusCurl(
      `curl 'https://ads.tiktok.com/api/v4/i18n/ad/update_status/?aadvid=123456&req_src=bidding' -H 'cookie: sessionid=authorized-test-cookie' -H 'content-type: application/json' --data-raw '{"ad_ids":["old-id"],"operation_status":"DISABLE"}'`,
    );

    expect(imported.credential.requestTemplates).toHaveLength(6);
    expect(imported.credential.requestTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "campaign-status", action: "enable" }),
        expect.objectContaining({ target: "ad-group-status", action: "disable" }),
        expect.objectContaining({ target: "ad-status", action: "enable" }),
      ]),
    );
  });

  it("reports the five documented fields only after both cURLs are merged", () => {
    const read = parseTikTokReadCurl(
      `curl 'https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=123456&req_src=bidding' -H 'cookie: sessionid=authorized-test-cookie' -H 'x-csrftoken: csrf-value'`,
    );
    const status = parseTikTokStatusCurl(
      `curl 'https://ads.tiktok.com/api/v4/i18n/ad/update_status/?aadvid=123456&req_src=bidding' -H 'cookie: sessionid=authorized-test-cookie' -H 'content-type: application/json' --data-raw '{"ad_ids":["old-id"],"operation_status":"DISABLE"}'`,
    );
    const readiness = getTikTokCookieImportReadiness({
      ...read.credential,
      requestTemplates: [
        ...(read.credential.requestTemplates ?? []),
        ...(status.credential.requestTemplates ?? []),
      ],
    });

    expect(readiness).toEqual({
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
    });
  });

  it("decodes Chrome ANSI-C multipart update_status cURL", () => {
    const multipart = [
      "------TestBoundary\\r\\n",
      'Content-Disposition: form-data; name="ad_list"\\r\\n\\r\\n',
      '["old-id"]\\r\\n',
      "------TestBoundary\\r\\n",
      'Content-Disposition: form-data; name="operation"\\r\\n\\r\\n',
      "enable\\r\\n",
      "------TestBoundary--\\r\\n",
    ].join("");
    const imported = parseTikTokStatusCurl(
      `curl 'https://ads.tiktok.com/api/v3/i18n/overture/ad/update_status/?aadvid=123456' -H 'content-type: multipart/form-data; boundary=----TestBoundary' -b 'sessionid=authorized-test-cookie' --data-raw $'${multipart}'`,
    );

    expect(imported.summary.target).toBe("ad-group-status");
    const templates = imported.credential.requestTemplates ?? [];
    expect(templates).toHaveLength(6);
    const enable = templates.find(
      (item) => item.target === "ad-group-status" && item.action === "enable",
    );
    const disable = templates.find(
      (item) => item.target === "ad-group-status" && item.action === "disable",
    );
    const campaignDisable = templates.find(
      (item) => item.target === "campaign-status" && item.action === "disable",
    );
    const creativeDisable = templates.find(
      (item) => item.target === "ad-status" && item.action === "disable",
    );
    expect(enable?.body).toContain('name="operation"\r\n\r\nenable');
    expect(disable?.body).toContain('name="operation"\r\n\r\ndisable');
    expect(campaignDisable?.url).toContain("/campaign/update_status/");
    expect(campaignDisable?.body).toContain('name="campaign_list"');
    expect(creativeDisable?.url).toContain("/creative/update_status/");
    expect(creativeDisable?.url).toContain("/api/v2/i18n/overture/");
    expect(creativeDisable?.body).toContain('name="creative_list"');
    expect(creativeDisable?.body).toContain('name="aco_creative_list"');
    expect(campaignDisable?.body).not.toContain("$------TestBoundary");
  });

  it("recognizes the confirmed final-ad creative status request", () => {
    const multipart = [
      "------CreativeBoundary\\r\\n",
      'Content-Disposition: form-data; name="creative_list"\\r\\n\\r\\n',
      '["creative-old"]\\r\\n',
      "------CreativeBoundary\\r\\n",
      'Content-Disposition: form-data; name="aco_creative_list"\\r\\n\\r\\n',
      '["creative-old"]\\r\\n',
      "------CreativeBoundary\\r\\n",
      'Content-Disposition: form-data; name="operation"\\r\\n\\r\\n',
      "enable\\r\\n",
      "------CreativeBoundary--\\r\\n",
    ].join("");
    const imported = parseTikTokStatusCurl(
      `curl 'https://ads.tiktok.com/api/v2/i18n/overture/creative/update_status/?aadvid=123456' -H 'content-type: multipart/form-data; boundary=----CreativeBoundary' -b 'sessionid=authorized-test-cookie' --data-raw $'${multipart}'`,
    );

    expect(imported.summary.target).toBe("ad-status");
    const templates = imported.credential.requestTemplates ?? [];
    expect(templates).toHaveLength(2);
    expect(templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "ad-status",
          action: "enable",
          derived: false,
        }),
        expect.objectContaining({
          target: "ad-status",
          action: "disable",
          derived: false,
        }),
      ]),
    );
  });

  it("requires all confirmed final-ad multipart fields", () => {
    const multipart = [
      "------CreativeBoundary\r\n",
      'Content-Disposition: form-data; name="creative_list"\r\n\r\n',
      '["creative-old"]\r\n',
      "------CreativeBoundary\r\n",
      'Content-Disposition: form-data; name="operation"\r\n\r\n',
      "disable\r\n",
      "------CreativeBoundary--\r\n",
    ].join("");

    expect(() =>
      parseTikTokStatusCurl(
        `curl 'https://ads.tiktok.com/api/v2/i18n/overture/creative/update_status/?aadvid=123456' -H 'content-type: multipart/form-data; boundary=----CreativeBoundary' -b 'sessionid=authorized-test-cookie' --data-raw $'${multipart}'`,
      ),
    ).toThrow("aco_creative_list");
  });

  it("requires confirmed status routes to use POST", () => {
    const multipart = [
      "------TestBoundary\r\n",
      'Content-Disposition: form-data; name="ad_list"\r\n\r\n',
      '["old-id"]\r\n',
      "------TestBoundary\r\n",
      'Content-Disposition: form-data; name="operation"\r\n\r\n',
      "enable\r\n",
      "------TestBoundary--\r\n",
    ].join("");

    expect(() =>
      parseTikTokStatusCurl(
        `curl 'https://ads.tiktok.com/api/v3/i18n/overture/ad/update_status/?aadvid=123456' -X GET -H 'content-type: multipart/form-data; boundary=----TestBoundary' -b 'sessionid=authorized-test-cookie' --data-raw $'${multipart}'`,
      ),
    ).toThrow("必须使用 POST");
  });

  it("keeps the documented list cURL focused on adgroup/list", () => {
    expect(() =>
      parseTikTokReadCurl(
        `curl 'https://ads.tiktok.com/api/v4/i18n/statistics/op/creative/material/list/?aadvid=123456' -H 'cookie: sessionid=authorized-test-cookie'`,
      ),
    ).toThrow("/adgroup/list/?");
  });
});

// 用两条真实抓包样本钉死派生结果：广告组那条（/api/v3/…/overture/ad/update_status/，
// 字段 ad_list / operation / ad_channel / risk_info）必须能推出与真实广告层请求
// （/api/v2/…/overture/creative/update_status/，字段 creative_list /
// aco_creative_list=[] / operation / ad_channel / risk_info）逐字段一致的模板。
// 此前 aco_creative_list 被复制成 creative_list 的副本，普通广告 ID 落进 ACO 列表，
// TikTok 一律以 code 4「Smart+ 推广系列不支持特定界面」拒绝，广告层启停 67 次全败。
describe("从广告组开关 cURL 派生广告层开关", () => {
  const boundary = "----WebKitFormBoundary19xPn7uLj44yh0iu";
  const adGroupCurl = [
    `curl 'https://ads.tiktok.com/api/v3/i18n/overture/ad/update_status/?aadvid=123456&req_src=bidding'`,
    `-H 'content-type: multipart/form-data; boundary=${boundary}'`,
    `-b 'sessionid=test-cookie'`,
    `-H 'x-csrftoken: test-csrf'`,
    `--data-raw $'--${boundary}\r\nContent-Disposition: form-data; name="ad_list"\r\n\r\n["1872677118817330"]\r\n--${boundary}\r\nContent-Disposition: form-data; name="operation"\r\n\r\nenable\r\n--${boundary}\r\nContent-Disposition: form-data; name="ad_channel"\r\n\r\n1\r\n--${boundary}\r\nContent-Disposition: form-data; name="risk_info"\r\n\r\n{"cookie_enabled":true}\r\n--${boundary}--\r\n'`,
  ].join(" ");

  it("路径、版本号与字段全部对齐真实广告层请求", () => {
    const templates = parseTikTokStatusCurl(adGroupCurl).credential.requestTemplates ?? [];
    const adDisable = templates.find(
      (item) => item.target === "ad-status" && item.action === "disable",
    );

    expect(adDisable).toBeDefined();
    // 层级 ad → creative，且 overture 广告层是 v2 而非 v3。
    expect(new URL(adDisable!.url).pathname).toBe(
      "/api/v2/i18n/overture/creative/update_status/",
    );
    expect(new URL(adDisable!.url).searchParams.get("req_src")).toBe("bidding");

    const fields = new Map(
      parseMultipartFields(adDisable!.body!).map((f) => [f.name, f.value.trim()]),
    );
    expect([...fields.keys()].sort()).toEqual(
      ["aco_creative_list", "ad_channel", "creative_list", "operation", "risk_info"],
    );
    // 关键：ACO 列表必须是空数组，不是 creative_list 的副本。
    expect(fields.get("aco_creative_list")).toBe("[]");
    expect(fields.get("creative_list")).toBe('["1872677118817330"]');
    expect(fields.get("operation")).toBe("disable");
    // 与开关无关的字段原样保留。
    expect(fields.get("ad_channel")).toBe("1");
  });

  it("广告组自身的模板不受影响", () => {
    const templates = parseTikTokStatusCurl(adGroupCurl).credential.requestTemplates ?? [];
    const groupDisable = templates.find(
      (item) => item.target === "ad-group-status" && item.action === "disable",
    );

    expect(new URL(groupDisable!.url).pathname).toBe(
      "/api/v3/i18n/overture/ad/update_status/",
    );
    const fields = new Map(
      parseMultipartFields(groupDisable!.body!).map((f) => [f.name, f.value.trim()]),
    );
    expect(fields.has("aco_creative_list")).toBe(false);
    expect(fields.get("ad_list")).toBe('["1872677118817330"]');
    expect(fields.get("operation")).toBe("disable");
  });
});
