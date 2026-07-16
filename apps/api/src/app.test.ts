import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationStore } from "@tk-auto/storage";
import { createApp } from "./app.js";
import type { FastifyInstance } from "fastify";
import { InMemoryCredentialVault } from "@tk-auto/credentials";

describe("local API", () => {
  let store: AutomationStore;
  let app: FastifyInstance;
  let vault: InMemoryCredentialVault;

  beforeEach(async () => {
    store = new AutomationStore(":memory:");
    store.seed();
    vault = new InMemoryCredentialVault();
    app = await createApp({ store, vault, disableAuth: true });
  });

  afterEach(async () => {
    await app.close();
    store.close();
    vi.restoreAllMocks();
  });

  it("returns bootstrap configuration", async () => {
    const response = await app.inject({ method: "GET", url: "/api/bootstrap" });

    expect(response.statusCode).toBe(200);
    expect(response.json().accounts).toHaveLength(1);
    expect(response.json().providers).toHaveLength(2);
    expect(response.json()).not.toHaveProperty("switchDefinitions");
    expect(response.json().globalAutomationSettings).toMatchObject({
      pollingIntervalMinutes: 5,
      maxActionsPerRun: 15,
    });
  });

  it("updates global polling and operation limits", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/automation/settings",
      payload: { pollingIntervalMinutes: 8, maxActionsPerRun: 20 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      pollingIntervalMinutes: 8,
      maxActionsPerRun: 20,
    });
  });

  it("stores notification credentials without returning their plaintext", async () => {
    const initial = await app.inject({
      method: "GET",
      url: "/api/notifications/channels",
    });
    expect(initial.json()).toHaveLength(3);

    const settings = await app.inject({
      method: "PUT",
      url: "/api/notifications/channels/email/settings",
      payload: {
        kind: "email",
        enabled: true,
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        secure: true,
        from: "sender@example.com",
        recipients: ["owner@example.com"],
      },
    });
    expect(settings.statusCode).toBe(200);

    const credential = await app.inject({
      method: "PUT",
      url: "/api/notifications/channels/email/credential",
      payload: {
        kind: "email",
        username: "sender@example.com",
        password: "app-password-secret",
      },
    });
    expect(credential.statusCode).toBe(200);
    expect(credential.json()).toMatchObject({
      kind: "email",
      hasCredential: true,
      status: "untested",
    });
    expect(credential.body).not.toContain("app-password-secret");
  });

  it("returns and updates the nine global rules", async () => {
    const existing = await app.inject({ method: "GET", url: "/api/rules" });
    const body = existing.json();
    expect(body.lookbackHours).toBe(48);
    expect(body.rules).toHaveLength(9);
    expect(body.layers).toEqual({ campaign: false, adGroup: true, ad: true });

    body.layers.campaign = true;
    body.rules[0].enabled = false;
    body.rules[0].values.cpc = 0.9;
    const updated = await app.inject({
      method: "PUT",
      url: "/api/rules",
      payload: body,
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      lookbackHours: 48,
      layers: { campaign: true, adGroup: true, ad: true },
    });
    expect(updated.json().rules[0]).toMatchObject({
      code: "CV1_CPC_CLOSE",
      enabled: false,
      values: { conversions: 1, cpc: 0.9 },
    });
  });

  it("uses the account enabled flag as the only account automation switch", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/accounts/demo-account/settings",
      payload: {
        displayName: "演示广告账户",
        accountType: "standard",
        enabled: false,
        providerKind: "cookie",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: false,
      executionMode: "automatic",
    });

    const run = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/automation/run",
    });
    expect(run.statusCode).toBe(409);
    expect(run.json().message).toContain("账户自动化已关闭");
  });

  it("stores provider settings and an encrypted credential reference", async () => {
    const settings = await app.inject({
      method: "PUT",
      url: "/api/accounts/demo-account/connections/cookie/settings",
      payload: {
        kind: "cookie",
        advertiserId: "123",
        healthUrl: "https://ads.tiktok.com/api/read-only",
        campaignsUrl: "",
        adGroupsUrl: "",
        adsUrl: "",
      },
    });
    expect(settings.statusCode).toBe(200);

    const credential = await app.inject({
      method: "PUT",
      url: "/api/accounts/demo-account/connections/cookie/credential",
      payload: {
        kind: "cookie",
        cookie: "sessionid=authorized-test-cookie",
        csrfHeaderName: "x-csrftoken",
      },
    });
    expect(credential.statusCode).toBe(200);
    expect(credential.json().hasCredential).toBe(true);
    expect(credential.json()).not.toHaveProperty("credentialRef");
    expect(JSON.stringify(credential.json())).not.toContain("authorized-test-cookie");
  });

  it("imports one cURL command, encrypts secrets, and tests the connection", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { list: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const command = `curl 'https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=123456&msToken=ephemeral-secret' -H 'cookie: sessionid=authorized-test-cookie' -H 'x-csrftoken: csrf-value' -H 'content-type: application/json' --data-raw '{"page":1}'`;

    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/connections/cookie/import-curl",
      payload: { command, step: "read" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      hasCredential: true,
      status: "ready",
    });
    expect(response.json().lastMessage).toContain("第 1 段列表 cURL 已解码");
    expect(response.json()).not.toHaveProperty("credentialRef");
    expect(JSON.stringify(response.json())).not.toContain("ephemeral-secret");

    const stored = store.getProviderConnection("demo-account", "cookie");
    expect(JSON.stringify(stored?.settings)).not.toContain("ephemeral-secret");
    expect(await vault.read(stored!.credentialRef!)).toContain(
      "ephemeral-secret",
    );
  });

  it("imports one status cURL and stores both directions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { list: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const listCommand = `curl 'https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=123456&req_src=bidding' -H 'cookie: sessionid=authorized-test-cookie' -H 'x-csrftoken: csrf-from-list'`;
    await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/connections/cookie/import-curl",
      payload: { command: listCommand, step: "read" },
    });
    const wrongStep = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/connections/cookie/import-curl",
      payload: { command: listCommand, step: "status" },
    });
    expect(wrongStep.statusCode).toBe(400);
    expect(wrongStep.json().message).toContain("第 2 段只接受真实启停请求");
    const multipart = [
      "------TestBoundary\r\n",
      'Content-Disposition: form-data; name="ad_list"\r\n\r\n',
      '["old-id"]\r\n',
      "------TestBoundary\r\n",
      'Content-Disposition: form-data; name="operation"\r\n\r\n',
      "disable\r\n",
      "------TestBoundary--\r\n",
    ].join("");
    const statusCommand = `curl 'https://ads.tiktok.com/api/v3/i18n/overture/ad/update_status/?aadvid=123456' -H 'cookie: sessionid=authorized-test-cookie' -H 'content-type: multipart/form-data; boundary=----TestBoundary' --data-raw $'${multipart}'`;
    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/connections/cookie/import-curl",
      payload: { command: statusCommand, step: "status" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().lastMessage).toContain("第 2 段启停 cURL 已解码");
    const stored = store.getProviderConnection("demo-account", "cookie")!;
    const secret = JSON.parse((await vault.read(stored.credentialRef!))!) as {
      requestTemplates: Array<{ target: string; action?: string }>;
    };
    expect(secret.requestTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "campaign", derived: true }),
        expect.objectContaining({ target: "ad-group", derived: false }),
        expect.objectContaining({ target: "ad", derived: true }),
        expect.objectContaining({ target: "campaign-status", action: "disable" }),
        expect.objectContaining({ target: "campaign-status", action: "enable" }),
        expect.objectContaining({ target: "ad-group-status", action: "disable" }),
        expect.objectContaining({ target: "ad-group-status", action: "enable" }),
        expect.objectContaining({ target: "ad-status", action: "disable" }),
        expect.objectContaining({ target: "ad-status", action: "enable" }),
      ]),
    );
    const readiness = await app.inject({
      method: "GET",
      url: "/api/accounts/demo-account/connections/cookie/readiness",
    });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({
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

  it("creates an independent advertising account", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/accounts",
      payload: {
        displayName: "第二账户",
        accountType: "agency",
        enabled: true,
        providerKind: "official-api",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      displayName: "第二账户",
      accountType: "agency",
      executionMode: "automatic",
    });
    expect(store.listAccounts()).toHaveLength(2);
  });

  it("creates a validated spreadsheet launch plan", async () => {
    const now = new Date().toISOString();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      [{ entityType: "ad", externalId: "source-ad", payload: { ad_name: "源广告" } }],
      { startedAt: now, finishedAt: now, counts: { campaign: 0, "ad-group": 0, ad: 1 }, warnings: [] },
    );
    const target = store.createAccount({ displayName: "目标", accountType: "standard", enabled: true, providerKind: "cookie" });
    const response = await app.inject({
      method: "POST",
      url: "/api/launch-plans",
      payload: {
        sourceAccountId: "demo-account",
        mode: "single",
        sourceAdId: null,
        targetAccountIds: [target.id],
        launchPresetId: "default-launch-preset",
        launchRows: [{
          rowNumber: 2,
          campaignName: "系列 A",
          videoCode: "video-001",
          productUrl: "https://example.com/product",
          adGroupName: "组 A",
          adName: "广告 A",
          region: "malicious-region",
          dailyBudget: 100,
          bid: null,
          startAt: null,
          endAt: null,
          initialStatus: "disabled",
        }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "blocked",
      launchRows: [{ campaignName: "系列 A", videoCode: "video-001", productUrl: "https://example.com/product", region: "未设置", dailyBudget: 100, initialStatus: "enabled" }],
    });
  });

  it("executes a multi-account creation plan with each account's own Cookie session", async () => {
    const second = store.createAccount({ displayName: "第二测试账户", accountType: "standard", enabled: true, providerKind: "cookie" });
    const creationConfig = {
      objectiveType: 1, buyingType: 1, campaignBudgetMode: 0, adBudgetMode: 0,
      pricing: 1, optimizeGoal: 1, externalAction: 1, pixelId: null,
      identityType: 1, identityId: "test-identity", callToActionId: "SHOP_NOW",
      countryCodes: [840], placementIds: [1], smartTargeting: true,
      commentDisabled: false, shareDisabled: false,
    };
    store.updateLaunchPreset("default-launch-preset", {
      name: "创建测试预设", region: "US", dailyBudget: 100, bid: null,
      startAt: null, endAt: null, initialStatus: "enabled", creationConfig,
    });
    for (const [accountId, advertiserId, cookie] of [["demo-account", "1001", "sessionid=first-test-session"], [second.id, "1002", "sessionid=second-test-session"]] as const) {
      store.saveProviderConnectionSettings(accountId, {
        kind: "cookie", advertiserId, healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "",
      });
      const reference = await vault.create(JSON.stringify({
        kind: "cookie", cookie, csrfHeaderName: "x-csrftoken",
        requestTemplates: [{ target: "ad-group", url: `https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=${advertiserId}`, method: "POST", body: '{"start_date":"2026-07-01","end_date":"2026-07-07"}', contentType: "application/json" }],
      }));
      store.setProviderCredentialReference(accountId, "cookie", reference);
      store.updateProviderStatus(accountId, "cookie", "ready", "test ready");
    }
    const cookies: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const cookie = new Headers(init?.headers).get("cookie");
      if (cookie) cookies.push(cookie);
      const data = url.includes("campaign_snap/save")
        ? { campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" }
        : url.includes("ad_snap/save")
          ? { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" }
          : url.includes("creative_snap/save")
            ? { creative_snap_id: "creative-snap", creative_sketch_id: "creative-sketch" }
            : url.includes("create_by_snap")
              ? { campaign_id: "campaign", adgroup_id: "adgroup", creative_id: "ad" }
              : { list: [] };
      return new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const created = await app.inject({ method: "POST", url: "/api/launch-plans", payload: {
      mode: "multi", sourceAccountId: "demo-account", sourceAdId: null,
      targetAccountIds: ["demo-account", second.id], launchPresetId: "default-launch-preset",
      launchRows: [{ rowNumber: 2, campaignName: "测试系列", adGroupName: "测试广告组", adName: "260716:001", videoCode: "same-video-code", productUrl: "https://example.com/product", region: "US", dailyBudget: 1, bid: null, startAt: null, endAt: null, initialStatus: "disabled" }],
    } });
    expect(created.statusCode).toBe(201);
    const executed = await app.inject({ method: "POST", url: `/api/launch-plans/${created.json().id}/execute` });

    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ plan: { status: "completed", executionResults: [{ accountId: "demo-account", ok: true, createdCount: 1, failedCount: 0 }, { accountId: second.id, ok: true, createdCount: 1, failedCount: 0 }] }, results: [{ accountId: "demo-account", ok: true }, { accountId: second.id, ok: true }] });
    expect(cookies).toContain("sessionid=first-test-session");
    expect(cookies).toContain("sessionid=second-test-session");
  });

  it("lists detected entities and manages the ignore list", async () => {
    const now = new Date().toISOString();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      [
        {
          entityType: "ad-group",
          externalId: "adgroup-1",
          payload: {
            ad_name: "测试组",
            ad_primary_status: "enable",
            row_data: { stat_cost: "10" },
          },
        },
      ],
      {
        startedAt: now,
        finishedAt: now,
        counts: { campaign: 0, "ad-group": 1, ad: 0 },
        warnings: [],
      },
    );

    const ignore = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/entities/ad-group/adgroup-1/ignore",
      payload: { reason: "人工排除" },
    });
    const entities = await app.inject({
      method: "GET",
      url: "/api/accounts/demo-account/entities",
    });
    const latestSync = await app.inject({
      method: "GET",
      url: "/api/accounts/demo-account/automation/latest-sync",
    });

    expect(ignore.statusCode).toBe(200);
    expect(entities.json()[0]).toMatchObject({
      externalId: "adgroup-1",
      ignored: true,
    });
    expect(latestSync.json()).toMatchObject({
      counts: { campaign: 0, "ad-group": 1, ad: 0 },
      warnings: [],
    });
  });

  it("returns detection-batch aggregates for analytics", async () => {
    const capturedAt = new Date().toISOString();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      [
        { entityType: "ad-group", externalId: "g1", payload: { adgroup_name: "组 1", row_data: { stat_cost: "3", click_cnt: "2" } } },
        { entityType: "ad-group", externalId: "g2", payload: { adgroup_name: "组 2", row_data: { stat_cost: "5", click_cnt: "4" } } },
      ],
      { startedAt: capturedAt, finishedAt: capturedAt, counts: { campaign: 0, "ad-group": 2, ad: 0 }, warnings: [] },
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/accounts/demo-account/analytics?from=${encodeURIComponent(new Date(new Date(capturedAt).getTime() - 86_400_000).toISOString())}&to=${encodeURIComponent(capturedAt)}&entityType=ad-group`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ capturedAt, count: 2, spend: 8, clicks: 6, conversions: 0 }]);
  });
});
