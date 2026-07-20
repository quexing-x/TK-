import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationStore } from "@tk-auto/storage";
import { createApp } from "./app.js";
import { LaunchService } from "./launch-service.js";
import type { FastifyInstance } from "fastify";
import { InMemoryCredentialVault } from "@tk-auto/credentials";
import {
  ProviderRegistry,
  type AdsProvider,
  type CreationMutation,
  type CreationMutationResult,
  type ProviderContext,
} from "@tk-auto/providers";

function testSyncQuality(finishedAt: string) {
  return {
    status: "healthy" as const,
    paginationComplete: true,
    requiredMetricsComplete: true,
    contractValid: true,
    providerContractVersion: "test-v1",
    coverage: { startDate: "2026-07-17", endDate: "2026-07-17", timezone: "UTC" },
    missingMetrics: [],
    partialFailures: [],
    lastHealthyAt: finishedAt,
  };
}

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
    expect(response.json().accountConnectionStates).toEqual([
      expect.objectContaining({ accountId: "demo-account" }),
    ]);
    expect(response.json().providers).toHaveLength(2);
    expect(response.json()).not.toHaveProperty("switchDefinitions");
    expect(response.json().globalAutomationSettings).toMatchObject({
      pollingIntervalMinutes: 5,
      maxActionsPerRun: 15,
    });
  });

  it("creates a launch preset from the default launch-page form payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/launch-presets",
      payload: {
        name: "基础预设",
        region: "未设置",
        dailyBudget: 100,
        bid: null,
        startAt: null,
        endAt: null,
        initialStatus: "enabled",
        creationConfig: {},
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      name: "基础预设",
      region: "未设置",
      dailyBudget: 100,
      initialStatus: "enabled",
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

  it("persists the explicit account automation mode", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/accounts/demo-account/settings",
      payload: {
        displayName: "演示广告账户",
        accountType: "standard",
        enabled: false,
        providerKind: "cookie",
        executionMode: "manual-approval",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: false,
      executionMode: "manual-approval",
    });

    const run = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/automation/run",
    });
    expect(run.statusCode).toBe(409);
    expect(run.json().message).toContain("账户自动化已关闭");
  });

  it("deletes only the selected account and its encrypted credentials", async () => {
    const other = store.createAccount({
      displayName: "保留账户",
      accountType: "standard",
      enabled: false,
      providerKind: "cookie",
    });
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
        cookie: "sessionid=delete-test-cookie",
        csrfHeaderName: "x-csrftoken",
      },
    });
    expect(credential.statusCode).toBe(200);
    const reference = store.getProviderConnection("demo-account", "cookie")?.credentialRef;
    expect(reference).toBeTruthy();

    const removed = await app.inject({ method: "DELETE", url: "/api/accounts/demo-account" });

    expect(removed.statusCode).toBe(204);
    expect(store.getAccount("demo-account")).toBeNull();
    expect(store.getProviderConnection("demo-account", "cookie")).toBeNull();
    await expect(vault.read(reference!)).resolves.toBeNull();
    expect(store.getAccount(other.id)).toMatchObject({ displayName: "保留账户" });
    expect(store.getGlobalAutomationSettings()).toMatchObject({ pollingIntervalMinutes: 5 });

    const missing = await app.inject({ method: "DELETE", url: "/api/accounts/demo-account" });
    expect(missing.statusCode).toBe(404);
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
      executionMode: "manual-approval",
    });
    expect(store.listAccounts()).toHaveLength(2);
  });

  it("creates a validated spreadsheet launch plan", async () => {
    const now = new Date().toISOString();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      [{ entityType: "ad", externalId: "source-ad", payload: { ad_name: "源广告" } }],
      { startedAt: now, finishedAt: now, counts: { campaign: 0, "ad-group": 0, ad: 1 }, warnings: [], quality: testSyncQuality(now) },
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
    for (const accountId of ["demo-account", second.id]) {
      store.setAccountExecutionMode(accountId, "automatic", "launch test");
    }
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
      store.updateProviderAuthorization(accountId, "cookie", {
        status: "active",
        capabilityVersion: new ProviderRegistry().capabilityVersion("cookie"),
        capabilities: ["read-campaigns", "read-ad-groups", "read-ads", "read-reports", "create-campaigns", "copy-ads"],
      });
      const syncAt = new Date().toISOString();
      store.saveReadOnlySync(accountId, "cookie", [], {
        startedAt: syncAt,
        finishedAt: syncAt,
        counts: { campaign: 0, "ad-group": 0, ad: 0 },
        warnings: [],
        quality: testSyncQuality(syncAt),
      });
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
    expect(executed.json().plan).toMatchObject({ status: "completed", executionResults: [{ accountId: "demo-account", ok: true, createdCount: 1, failedCount: 0 }, { accountId: second.id, ok: true, createdCount: 1, failedCount: 0 }] });
    expect(executed.json().results).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: "demo-account", status: "succeeded" }),
      expect.objectContaining({ accountId: second.id, status: "succeeded" }),
    ]));
    expect(cookies).toContain("sessionid=first-test-session");
    expect(cookies).toContain("sessionid=second-test-session");
  });

  it("queues batch creation for the background worker without waiting for provider completion", async () => {
    let releaseProvider!: () => void;
    const providerStarted = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) => {
      await providerStarted;
      return mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "queued-campaign",
        adGroupId: "queued-group",
        adId: "queued-ad",
        message: "created in worker",
      }));
    });
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);

    const queued = await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/queue` });

    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ queued: true, plan: { id: planId } });
    await vi.waitFor(() => expect(createFromPreset).toHaveBeenCalledTimes(1));
    expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({ status: "running", attemptCount: 1 });

    releaseProvider();
    await vi.waitFor(() => expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({ status: "succeeded" }));
  });

  it("does not persist a launch queue request while the master switch is off", async () => {
    const planId = await installLaunchTestProvider(
      async (_context, mutations) => mutations.map((mutation) => ({ ...mutation, ok: true, campaignId: "c", adGroupId: "g", adId: "a", message: "created" })),
      [apiLaunchRow(2)],
    );
    store.updateSystemRuntimeState({ enabled: false });

    const queued = await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/queue` });

    expect(queued.statusCode).toBe(409);
    expect(queued.json().message).toContain("再次确认");
    expect(store.listQueuedLaunchPlans()).toEqual([]);
  });

  it("keeps a queued interrupted worker item visible until lease recovery marks it unknown", async () => {
    vi.useFakeTimers();
    try {
      const planId = await installLaunchTestProvider(
        async (_context, mutations) => mutations.map((mutation) => ({ ...mutation, ok: true, campaignId: "c", adGroupId: "g", adId: "a", message: "created" })),
        [apiLaunchRow(2)],
      );
      await app.close();
      const item = store.listLaunchPlanItems(planId)[0]!;
      store.claimLaunchPlanItem(item.itemId, "interrupted-worker", "pending", { id: "worker", name: "Worker", kind: "system" });
      store.enqueueLaunchPlan(planId, { id: "worker", name: "Worker", kind: "system" });

      expect(store.listQueuedLaunchPlans()).toEqual(expect.arrayContaining([
        expect.objectContaining({ planId }),
      ]));
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);
      new LaunchService(store, vault, new ProviderRegistry());

      expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({ status: "unknown", attemptCount: 1 });
      expect(store.listQueuedLaunchPlans()).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ planId }),
      ]));
    } finally {
      vi.useRealTimers();
    }
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
        quality: testSyncQuality(now),
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
      quality: testSyncQuality(now),
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
      { startedAt: capturedAt, finishedAt: capturedAt, counts: { campaign: 0, "ad-group": 2, ad: 0 }, warnings: [], quality: testSyncQuality(capturedAt) },
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/accounts/demo-account/analytics?from=${encodeURIComponent(new Date(new Date(capturedAt).getTime() - 86_400_000).toISOString())}&to=${encodeURIComponent(capturedAt)}&entityType=ad-group`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ capturedAt, count: 2, spend: 8, clicks: 6, conversions: 0 }]);
  });

  it("exposes maintenance status and creates a verified backup before update install", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-api-maintenance-"));
    const maintenanceStore = new AutomationStore(join(directory, "automation.db"), {
      appVersion: "1.3.2",
    });
    maintenanceStore.seed();
    const installUpdate = vi.fn(async () => ({
      configured: true,
      state: "installing" as const,
      currentVersion: "1.3.2",
      availableVersion: "1.3.3",
      signatureStatus: "valid" as const,
      message: "installing",
      checkedAt: new Date().toISOString(),
    }));
    const updateStatus = {
      configured: true,
      state: "downloaded" as const,
      currentVersion: "1.3.2",
      availableVersion: "1.3.3",
      signatureStatus: "valid" as const,
      message: "ready",
      checkedAt: new Date().toISOString(),
    };
    const maintenanceApp = await createApp({
      store: maintenanceStore,
      vault: new InMemoryCredentialVault(),
      disableAuth: true,
      appVersion: "1.3.2",
      packaged: true,
      maintenanceUpdates: {
        getStatus: () => updateStatus,
        checkForUpdates: () => updateStatus,
        downloadUpdate: () => updateStatus,
        installUpdate,
      },
    });
    try {
      const status = await maintenanceApp.inject({ method: "GET", url: "/api/maintenance/status" });
      expect(status.json()).toMatchObject({
        appVersion: "1.3.2",
        packaged: true,
        update: { state: "downloaded", signatureStatus: "valid" },
      });
      const install = await maintenanceApp.inject({
        method: "POST",
        url: "/api/maintenance/updates/install",
      });
      expect(install.statusCode).toBe(200);
      expect(installUpdate).toHaveBeenCalledTimes(1);
      expect(maintenanceStore.listDatabaseBackups()).toEqual([
        expect.objectContaining({ kind: "pre-upgrade", status: "verified" }),
      ]);
    } finally {
      await maintenanceApp.close();
      maintenanceStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exposes the low-risk automation opt-in, daily usage and circuit reset", async () => {
    const initial = await app.inject({
      method: "GET",
      url: "/api/accounts/demo-account/low-risk-automation",
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      policy: { enabled: false, policyVersion: "disable-only-v1", dailyActionLimit: 5 },
      todayUsage: 0,
      circuit: null,
    });

    store.setAccountExecutionMode("demo-account", "automatic", "test opt-in");
    const updated = await app.inject({
      method: "PUT",
      url: "/api/accounts/demo-account/low-risk-automation",
      payload: { enabled: true, dailyActionLimit: 2 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().policy).toMatchObject({ enabled: true, dailyActionLimit: 2 });

    await app.inject({
      method: "PUT",
      url: "/api/accounts/demo-account/low-risk-automation",
      payload: { enabled: false, dailyActionLimit: 2 },
    });
    store.recordProviderWriteFailure("demo-account", "cookie", "one");
    store.recordProviderWriteFailure("demo-account", "cookie", "two");
    store.recordProviderWriteFailure("demo-account", "cookie", "three");
    const reset = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/low-risk-automation/reset-circuit",
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().circuit).toBeNull();
  });

  it("allows read-only automation preview while the software master switch is off", async () => {
    store.updateSystemRuntimeState({ enabled: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/automation/preview",
    });

    expect(response.statusCode).not.toBe(423);
  });

  it("retries only the explicitly selected failed item", async () => {
    const attempts = new Map<number, number>();
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => {
        const attempt = (attempts.get(mutation.row.rowNumber) ?? 0) + 1;
        attempts.set(mutation.row.rowNumber, attempt);
        const ok = mutation.row.rowNumber === 2 || attempt > 1;
        return {
          ...mutation,
          ok,
          ...(ok ? { campaignId: `c-${mutation.row.rowNumber}`, adGroupId: `g-${mutation.row.rowNumber}`, adId: `a-${mutation.row.rowNumber}` } : {}),
          ...(!ok ? { failureKind: "retryable" as const } : {}),
          message: ok ? "created" : "rejected",
        };
      }),
    );
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2), apiLaunchRow(3)]);

    const first = await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    const second = await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    const failedItem = store.listLaunchPlanItems(planId).find((item) => item.status === "failed")!;
    const retried = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/items/${failedItem.itemId}/retry`,
    });
    store.updateSystemRuntimeState({ enabled: false });
    const replayedCompleted = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/execute`,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().results).toEqual([]);
    expect(retried.statusCode).toBe(200);
    expect(replayedCompleted.statusCode).toBe(200);
    expect(replayedCompleted.json().results).toEqual([]);
    expect(first.json().results).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "failed", message: "rejected" }),
    ]));
    expect(createFromPreset.mock.calls.map((call) => call[1][0]!.row.rowNumber)).toEqual([2, 3, 3]);
    expect(store.listLaunchPlanItems(planId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemIndex: 0, status: "succeeded", attemptCount: 1 }),
      expect.objectContaining({ itemIndex: 1, status: "succeeded", attemptCount: 2 }),
    ]));
  });

  it("prevents concurrent execute requests from claiming the same item", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "campaign-once",
        adGroupId: "group-once",
        adId: "ad-once",
        message: "created",
      }));
    });
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);

    await Promise.all([
      app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` }),
      app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` }),
    ]);

    expect(createFromPreset).toHaveBeenCalledTimes(1);
    expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({ status: "succeeded", attemptCount: 1 });
  });

  it("blocks launch provider writes while the software master switch is off", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "campaign-created",
        adGroupId: "group-created",
        adId: "ad-created",
        message: "created",
      })),
    );
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);
    store.updateSystemRuntimeState({ enabled: false });

    const response = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/execute`,
    });

    expect(response.statusCode).toBe(409);
    expect(createFromPreset).not.toHaveBeenCalled();
    expect(store.listLaunchPlanItems(planId)[0]?.status).toBe("pending");
  });

  it("allows an explicitly requested launch when the account remains in manual-approval mode", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "campaign-created",
        adGroupId: "group-created",
        adId: "ad-created",
        message: "created",
      })),
    );
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);
    store.setAccountExecutionMode("demo-account", "manual-approval", "manual launch test");

    const response = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/execute`,
    });

    expect(response.statusCode).toBe(200);
    expect(createFromPreset).toHaveBeenCalledTimes(1);
    expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({ status: "succeeded" });
  });

  it("keeps an item succeeded when post-create synchronization fails", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "campaign-created",
        adGroupId: "group-created",
        adId: "ad-created",
        message: "created",
      })),
    );
    const planId = await installLaunchTestProvider(
      createFromPreset,
      [apiLaunchRow(2)],
      async () => { throw new Error("sync unavailable"); },
    );

    const executed = await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });

    expect(executed.statusCode).toBe(200);
    expect(executed.json().results[0]).toMatchObject({ status: "succeeded", syncWarning: "sync unavailable" });
    expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({
      status: "succeeded",
      campaignId: "campaign-created",
      adGroupId: "group-created",
      adId: "ad-created",
      errorMessage: null,
    });
    expect(store.getAccount("demo-account")?.executionMode).toBe("manual-approval");
    expect(store.getProviderConnection("demo-account", "cookie")?.status).toBe("failed");
  });

  it("keeps an item succeeded when post-create failure-counter cleanup fails", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "campaign-created",
        adGroupId: "group-created",
        adId: "ad-created",
        message: "created",
      })),
    );
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);
    vi.spyOn(store, "resetProviderWriteFailures").mockImplementationOnce(() => {
      throw new Error("cleanup unavailable");
    });

    const executed = await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });

    expect(executed.statusCode).toBe(200);
    expect(executed.json().results[0]).toMatchObject({
      status: "succeeded",
      syncWarning: expect.stringContaining("cleanup unavailable"),
    });
    expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({ status: "succeeded" });
  });

  it("returns a conflict when an unknown status write is retried", async () => {
    const task = store.createStatusWriteTask({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "adgroup-unknown",
      entityName: "unknown group",
      action: "disable",
      source: "manual",
    }, { id: "user-1", name: "验收员", kind: "user" });
    store.claimStatusWriteTask(task.id, "executor-1");
    store.completeStatusWriteTask(task.id, "executor-1", "unknown", "result unknown");

    const response = await app.inject({
      method: "POST",
      url: `/api/accounts/demo-account/status-operations/${task.operationId}/retry`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("禁止自动重试");
  });

  it("keeps creation succeeded but downgrades when created IDs are missing from readback", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "campaign-created",
        adGroupId: "group-created",
        adId: "ad-created",
        message: "created",
      })),
    );
    const planId = await installLaunchTestProvider(
      createFromPreset,
      [apiLaunchRow(2)],
      async () => ({
        entities: [],
        result: {
          startedAt: "2026-07-17T00:00:00.000Z",
          finishedAt: "2026-07-17T00:00:01.000Z",
          counts: { campaign: 0, "ad-group": 0, ad: 0 },
          warnings: [],
          quality: testSyncQuality("2026-07-17T00:00:01.000Z"),
        },
      }),
    );

    const executed = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/execute`,
    });

    expect(executed.json().results[0]).toMatchObject({
      status: "succeeded",
      syncWarning: expect.stringContaining("创建后未回读到"),
    });
    expect(store.getAccount("demo-account")?.executionMode).toBe("manual-approval");
  });

  it("keeps creation succeeded but warns and downgrades on non-healthy readback quality", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "campaign-created",
        adGroupId: "group-created",
        adId: "ad-created",
        message: "created",
      })),
    );
    const planId = await installLaunchTestProvider(
      createFromPreset,
      [apiLaunchRow(2)],
      async () => {
        const finishedAt = new Date().toISOString();
        return {
          entities: [
            { entityType: "campaign" as const, externalId: "campaign-created", payload: {} },
            { entityType: "ad-group" as const, externalId: "group-created", payload: {} },
            { entityType: "ad" as const, externalId: "ad-created", payload: {} },
          ],
          result: {
            startedAt: finishedAt,
            finishedAt,
            counts: { campaign: 1, "ad-group": 1, ad: 1 },
            warnings: [],
            quality: {
              ...testSyncQuality(finishedAt),
              status: "partial" as const,
              paginationComplete: false,
              partialFailures: ["pagination"],
            },
          },
        };
      },
    );

    const executed = await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });

    expect(executed.json().results[0]).toMatchObject({
      status: "succeeded",
      syncWarning: expect.stringContaining("partial"),
    });
    expect(store.getAccount("demo-account")?.executionMode).toBe("manual-approval");
  });

  it("downgrades automatic mode when direct connection testing fails", async () => {
    await installLaunchTestProvider(
      async (_context, mutations) => mutations.map((mutation) => ({
        ...mutation,
        ok: true,
        campaignId: "campaign",
        adGroupId: "group",
        adId: "ad",
        message: "created",
      })),
      [apiLaunchRow(2)],
      undefined,
      async () => ({ ok: false, status: "failed", message: "expired" }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/connections/cookie/test",
    });

    expect(response.statusCode).toBe(200);
    expect(store.getAccount("demo-account")?.executionMode).toBe("manual-approval");
    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({
      authorizationStatus: "failed",
      capabilityVersion: "launch-test-v1",
    });
  });

  it("returns account-scoped capabilities after a successful authorization check", async () => {
    await installLaunchTestProvider(
      async (_context, mutations) => mutations.map((mutation) => ({
        ...mutation,
        ok: true,
        campaignId: "campaign",
        adGroupId: "group",
        adId: "ad",
        message: "created",
      })),
      [apiLaunchRow(2)],
    );

    const tested = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/connections/cookie/test",
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      authorizationStatus: "active",
      capabilityVersion: "launch-test-v1",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/accounts/demo-account/capabilities",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "create-campaigns", available: true }),
      expect.objectContaining({ capability: "copy-ads", available: true }),
    ]));
  });

  it("does not apply a stale health result after the credential generation changes", async () => {
    let signalHealthStarted!: () => void;
    let releaseHealth!: () => void;
    const healthStarted = new Promise<void>((resolve) => {
      signalHealthStarted = resolve;
    });
    const healthGate = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    await installLaunchTestProvider(
      async (_context, mutations) => mutations.map((mutation) => ({
        ...mutation,
        ok: true,
        campaignId: "campaign",
        adGroupId: "group",
        adId: "ad",
        message: "created",
      })),
      [apiLaunchRow(2)],
      undefined,
      async () => {
        signalHealthStarted();
        await healthGate;
        return { ok: true, status: "ready", message: "old credential ready" };
      },
    );

    const pending = app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/connections/cookie/test",
    });
    await healthStarted;
    const replacement = await vault.create(JSON.stringify({
      kind: "cookie",
      cookie: "sessionid=replacement-session",
      csrfHeaderName: "x-csrftoken",
      requestTemplates: [],
    }));
    store.setProviderCredentialReference("demo-account", "cookie", replacement);
    releaseHealth();

    const response = await pending;
    expect(response.statusCode).toBe(409);
    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({
      credentialRef: replacement,
      authorizationStatus: "not-authorized",
      authorizedCapabilities: [],
    });
  });

  it("downgrades automatic mode when direct synchronization fails", async () => {
    await installLaunchTestProvider(
      async (_context, mutations) => mutations.map((mutation) => ({
        ...mutation,
        ok: true,
        campaignId: "campaign",
        adGroupId: "group",
        adId: "ad",
        message: "created",
      })),
      [apiLaunchRow(2)],
      async () => { throw new Error("sync unavailable"); },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/connections/cookie/sync",
    });

    expect(response.statusCode).toBe(500);
    expect(store.getAccount("demo-account")?.executionMode).toBe("manual-approval");
    expect(store.getProviderConnection("demo-account", "cookie")?.status).toBe("failed");
  });

  it("downgrades automatic mode when direct synchronization is non-healthy without warnings", async () => {
    const finishedAt = new Date().toISOString();
    await installLaunchTestProvider(
      async (_context, mutations) => mutations.map((mutation) => ({
        ...mutation,
        ok: true,
        message: "created",
      })),
      [apiLaunchRow(2)],
      async () => ({
        entities: [],
        result: {
          startedAt: finishedAt,
          finishedAt,
          counts: { campaign: 0, "ad-group": 0, ad: 0 },
          warnings: [],
          quality: {
            ...testSyncQuality(finishedAt),
            status: "invalid",
            contractValid: false,
          },
        },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/connections/cookie/sync",
    });

    expect(response.statusCode).toBe(200);
    expect(store.getAccount("demo-account")?.executionMode).toBe("manual-approval");
  });

  it("marks a provider success with incomplete IDs as unknown and never retries it", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "campaign-only",
        message: "provider accepted",
      })),
    );
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);

    await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });

    expect(createFromPreset).toHaveBeenCalledTimes(1);
    expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({
      status: "unknown",
      attemptCount: 1,
      errorMessage: expect.stringContaining("不会自动重试"),
    });
  });

  it("marks an unclassified provider exception as unknown and never retries it", async () => {
    const createFromPreset = vi.fn(async () => {
      throw new Error("connection reset after request dispatch");
    });
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);

    await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    const unknownItem = store.listLaunchPlanItems(planId)[0]!;
    const retry = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/items/${unknownItem.itemId}/retry`,
    });

    expect(createFromPreset).toHaveBeenCalledTimes(1);
    expect(retry.statusCode).toBe(409);
    expect(retry.json().message).toContain("禁止重试");
    expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({
      status: "unknown",
      attemptCount: 1,
      errorMessage: "connection reset after request dispatch",
    });
  });

  it("marks a persistence failure after confirmed creation as unknown", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "campaign-created",
        adGroupId: "group-created",
        adId: "ad-created",
        message: "created",
      })),
    );
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);
    vi.spyOn(store, "completeLaunchPlanItemSuccess").mockImplementationOnce(() => {
      throw new Error("database write interrupted");
    });

    await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });

    expect(createFromPreset).toHaveBeenCalledTimes(1);
    expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({
      status: "unknown",
      attemptCount: 1,
      errorMessage: "database write interrupted",
    });
  });

  it("persists provider progress evidence under the claimed attempt", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => {
        mutation.onProgress?.({
          phase: "campaign_draft",
          evidence: { campaignSnapId: "campaign-snap", campaignSketchId: "campaign-sketch" },
        });
        mutation.onProgress?.({
          phase: "publishing",
          evidence: { asyncRequestId: "async-request" },
        });
        mutation.onProgress?.({ phase: "readback", evidence: {} });
        return {
          ...mutation,
          ok: true,
          campaignId: "campaign-created",
          adGroupId: "group-created",
          adId: "ad-created",
          message: "created",
        };
      }),
    );
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);

    const response = await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    const item = store.listLaunchPlanItems(planId)[0]!;
    const attempts = store.listLaunchPlanItemAttempts(item.itemId);
    const mutation = createFromPreset.mock.calls[0]![1][0]!;

    expect(response.statusCode).toBe(200);
    expect(mutation).toMatchObject({
      operationId: item.operationId,
      correlationId: item.correlationId,
      attemptId: item.attemptId,
    });
    expect(item).toMatchObject({
      status: "succeeded",
      phase: "sync",
      evidence: expect.objectContaining({
        campaignSnapId: "campaign-snap",
        campaignSketchId: "campaign-sketch",
        asyncRequestId: "async-request",
      }),
    });
    expect(attempts).toEqual([
      expect.objectContaining({
        attemptId: item.attemptId,
        status: "succeeded",
        phase: "sync",
        evidence: expect.objectContaining({ asyncRequestId: "async-request" }),
      }),
    ]);
  });

  it("resolves an unknown item only through an evidence-backed manual verification", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: false,
        failureKind: "unknown",
        message: "response lost after dispatch",
      })),
    );
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);
    await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    const item = store.listLaunchPlanItems(planId)[0]!;

    const rejected = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/items/${item.itemId}/verify`,
      payload: {
        decision: "confirmed-succeeded",
        evidence: "TikTok backend checked",
        note: "",
        campaignId: null,
        adGroupId: null,
        adId: null,
      },
    });
    const verified = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/items/${item.itemId}/verify`,
      payload: {
        decision: "confirmed-succeeded",
        evidence: "TikTok backend checked by time and operation identity",
        note: "manual verification",
        campaignId: "campaign-confirmed",
        adGroupId: "group-confirmed",
        adId: "ad-confirmed",
      },
    });

    expect(rejected.statusCode).toBe(409);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({
      verification: {
        previousStatus: "unknown",
        nextStatus: "succeeded",
        actorId: "isolated-test",
      },
      item: {
        status: "succeeded",
        campaignId: "campaign-confirmed",
        adGroupId: "group-confirmed",
        adId: "ad-confirmed",
      },
    });
    expect(store.listLaunchPlanItemVerifications(item.itemId)).toHaveLength(1);
  });

  it("allows an explicit manual launch when the latest sync is not healthy", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "campaign-created",
        adGroupId: "adgroup-created",
        adId: "ad-created",
        message: "created",
      })),
    );
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);
    const partialAt = new Date(Date.now() + 1_000).toISOString();
    store.saveReadOnlySync("demo-account", "cookie", [], {
      startedAt: partialAt,
      finishedAt: partialAt,
      counts: { campaign: 0, "ad-group": 0, ad: 0 },
      warnings: ["incomplete"],
      quality: {
        ...testSyncQuality(partialAt),
        status: "partial",
        paginationComplete: false,
        partialFailures: ["pagination"],
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/execute`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({ status: "succeeded" });
    expect(createFromPreset).toHaveBeenCalledOnce();
  });

  it("does not let a concurrent sync-quality downgrade block an explicit manual launch", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "campaign-created",
        adGroupId: "adgroup-created",
        adId: "ad-created",
        message: "created",
      })),
    );
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(3)]);
    const originalRead = vault.read.bind(vault);
    vi.spyOn(vault, "read").mockImplementation(async (reference) => {
      const value = await originalRead(reference);
      const partialAt = new Date(Date.now() + 1_000).toISOString();
      store.saveReadOnlySync("demo-account", "cookie", [], {
        startedAt: partialAt,
        finishedAt: partialAt,
        counts: { campaign: 0, "ad-group": 0, ad: 0 },
        warnings: ["concurrent contract drift"],
        quality: {
          ...testSyncQuality(partialAt),
          status: "partial",
          paginationComplete: false,
          partialFailures: ["pagination"],
        },
      });
      return value;
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/execute`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({ status: "succeeded" });
    expect(createFromPreset).toHaveBeenCalledOnce();
  });

  it("rechecks the exact authorization and credential generation before launch dispatch", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        message: "created",
      })),
    );
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(3)]);
    const originalRead = vault.read.bind(vault);
    vi.spyOn(vault, "read").mockImplementation(async (reference) => {
      const value = await originalRead(reference);
      store.setProviderCredentialReference("demo-account", "cookie", reference);
      return value;
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/execute`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({ status: "failed" });
    expect(createFromPreset).not.toHaveBeenCalled();
  });

  it("previews and executes a cross-account migration without calling template copy", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "new-campaign",
        adGroupId: "new-group",
        adId: "new-ad",
        message: "created",
      })),
    );
    const fixture = await installCopyLaunchProvider(createFromPreset);
    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/launch-plans/copy-preview",
      payload: fixture.input,
    });
    expect(previewResponse.statusCode).toBe(201);
    expect(previewResponse.json()).toMatchObject({ safeToCreate: true, blockers: [] });

    const planPayload = {
      ...fixture.input,
      mode: "copy",
      copyPreviewId: previewResponse.json().id,
    };
    const first = await app.inject({ method: "POST", url: "/api/launch-plans", payload: planPayload });
    const duplicate = await app.inject({ method: "POST", url: "/api/launch-plans", payload: planPayload });
    expect(first.statusCode).toBe(201);
    expect(duplicate.json().id).toBe(first.json().id);

    const execution = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${first.json().id}/execute`,
    });
    expect(execution.statusCode).toBe(200);
    expect(execution.json().results[0]).toMatchObject({ status: "succeeded" });
    expect(createFromPreset).toHaveBeenCalledTimes(1);
    expect(createFromPreset.mock.calls[0]?.[1][0]).toMatchObject({
      templateMode: "none",
      row: { videoCode: "video-2" },
    });
    expect(createFromPreset.mock.calls[0]?.[1][0]).not.toHaveProperty("templateCampaignId");
  });

  it("blocks a copy item before provider dispatch when the frozen source drifts", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "should-not-create",
        adGroupId: "should-not-create",
        adId: "should-not-create",
        message: "created",
      })),
    );
    const fixture = await installCopyLaunchProvider(createFromPreset);
    const preview = await app.inject({
      method: "POST",
      url: "/api/launch-plans/copy-preview",
      payload: fixture.input,
    });
    const plan = await app.inject({
      method: "POST",
      url: "/api/launch-plans",
      payload: { ...fixture.input, mode: "copy", copyPreviewId: preview.json().id },
    });
    fixture.setRemoteSourceVideoCode("changed-source-video");

    const execution = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${plan.json().id}/execute`,
    });

    expect(execution.statusCode).toBe(200);
    expect(execution.json().results[0]).toMatchObject({ status: "failed" });
    expect(execution.json().results[0].message).toContain("源广告结构在预览后已变化");
    expect(createFromPreset).not.toHaveBeenCalled();
  });

  it("blocks a copy item when a fresh target sync no longer proves the asset mapping", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "should-not-create",
        adGroupId: "should-not-create",
        adId: "should-not-create",
        message: "created",
      })),
    );
    const fixture = await installCopyLaunchProvider(createFromPreset);
    const preview = await app.inject({
      method: "POST",
      url: "/api/launch-plans/copy-preview",
      payload: fixture.input,
    });
    const plan = await app.inject({
      method: "POST",
      url: "/api/launch-plans",
      payload: { ...fixture.input, mode: "copy", copyPreviewId: preview.json().id },
    });
    fixture.setRemoteTargetVideoCode("different-target-video");

    const execution = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${plan.json().id}/execute`,
    });

    expect(execution.statusCode).toBe(200);
    expect(execution.json().results[0]).toMatchObject({ status: "failed" });
    expect(execution.json().results[0].message).toContain("目标账户素材证据在预览后已失效");
    expect(createFromPreset).not.toHaveBeenCalled();
  });

  it("lists unified write tasks and resolves an unknown status task with evidence", async () => {
    const task = store.createStatusWriteTask({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "group-task-center",
      entityName: "Task center group",
      action: "disable",
      source: "manual",
    }, { id: "operator-1", name: "Operator", kind: "user" });
    store.claimStatusWriteTask(task.id, "executor-a", "pending", {
      id: "operator-1",
      name: "Operator",
      kind: "user",
    });
    store.completeStatusWriteTask(task.id, "executor-a", "unknown", "response lost");

    const listed = await app.inject({
      method: "GET",
      url: "/api/write-tasks?kind=status&status=unknown&accountId=demo-account",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([
      expect.objectContaining({
        taskId: task.id,
        operationId: task.operationId,
        status: "unknown",
        retryable: false,
        requiresVerification: true,
      }),
    ]);

    const attempts = await app.inject({
      method: "GET",
      url: `/api/write-tasks/status/${task.id}/attempts`,
    });
    expect(attempts.statusCode).toBe(200);
    expect(attempts.json()).toEqual([
      expect.objectContaining({ status: "unknown", attemptNumber: 1 }),
    ]);

    const verified = await app.inject({
      method: "POST",
      url: `/api/accounts/demo-account/status-operations/${task.operationId}/verify`,
      payload: {
        decision: "confirmed-succeeded",
        observedStatus: "disabled",
        evidence: "TikTok object disabled at 10:01 UTC",
        note: "checked by external id",
      },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({
      verification: { taskId: task.id, nextStatus: "succeeded" },
      task: { status: "succeeded", phase: "readback" },
    });

    const verifications = await app.inject({
      method: "GET",
      url: `/api/write-tasks/status/${task.id}/verifications`,
    });
    expect(verifications.statusCode).toBe(200);
    expect(verifications.json()).toHaveLength(1);
  });

  async function installLaunchTestProvider(
    createFromPreset: (
      context: ProviderContext,
      mutations: CreationMutation[],
    ) => Promise<CreationMutationResult[]>,
    rows: ReturnType<typeof apiLaunchRow>[],
    syncReadOnly?: AdsProvider["syncReadOnly"],
    checkHealth: AdsProvider["checkHealth"] = async () => ({
      ok: true,
      status: "ready",
      message: "ready",
    }),
  ): Promise<string> {
    let latestCreated: CreationMutationResult | null = null;
    const resolvedSyncReadOnly: AdsProvider["syncReadOnly"] = syncReadOnly ?? (async () => {
      const entities = latestCreated?.ok
        ? [
            { entityType: "campaign" as const, externalId: latestCreated.campaignId!, payload: {} },
            { entityType: "ad-group" as const, externalId: latestCreated.adGroupId!, payload: {} },
            { entityType: "ad" as const, externalId: latestCreated.adId!, payload: {} },
          ]
        : [];
      return {
        entities,
        result: {
          startedAt: "2026-07-17T00:00:00.000Z",
          finishedAt: "2026-07-17T00:00:01.000Z",
          counts: {
            campaign: entities.filter((item) => item.entityType === "campaign").length,
            "ad-group": entities.filter((item) => item.entityType === "ad-group").length,
            ad: entities.filter((item) => item.entityType === "ad").length,
          },
          warnings: [],
          quality: testSyncQuality("2026-07-17T00:00:01.000Z"),
        },
      };
    });
    store.saveProviderConnectionSettings("demo-account", {
      kind: "cookie", advertiserId: "1001", healthUrl: "",
      campaignsUrl: "", adGroupsUrl: "", adsUrl: "",
    });
    const reference = await vault.create(JSON.stringify({
      kind: "cookie",
      cookie: "sessionid=test-session",
      csrfHeaderName: "x-csrftoken",
      requestTemplates: [],
    }));
    store.setProviderCredentialReference("demo-account", "cookie", reference);
    store.updateProviderStatus("demo-account", "cookie", "ready", "ready");
    store.updateProviderAuthorization("demo-account", "cookie", {
      status: "active",
      capabilityVersion: "launch-test-v1",
      capabilities: ["read-campaigns", "create-campaigns", "copy-ads", "change-status"],
    });
    store.setAccountExecutionMode("demo-account", "automatic", "launch test");
    const syncAt = new Date().toISOString();
    store.saveReadOnlySync("demo-account", "cookie", [], {
      startedAt: syncAt,
      finishedAt: syncAt,
      counts: { campaign: 0, "ad-group": 0, ad: 0 },
      warnings: [],
      quality: testSyncQuality(syncAt),
    });
    const provider: AdsProvider = {
      kind: "cookie",
      displayName: "launch test provider",
      capabilityVersion: "launch-test-v1",
      capabilities: new Set(["read-campaigns", "create-campaigns", "copy-ads", "change-status"]),
      checkHealth,
      syncReadOnly: resolvedSyncReadOnly,
      changeStatus: async (_context, mutations) => mutations.map((mutation) => ({ ...mutation, ok: true, message: "ok" })),
      create: async (context, mutations) => {
        const results = await createFromPreset(
          context,
          mutations.map((mutation) => ({ ...mutation, templateMode: "none" })),
        );
        latestCreated = results[0] ?? null;
        return results;
      },
      copy: async (context, mutations) => {
        const results = await createFromPreset(
          context,
          mutations.map((mutation) => ({ ...mutation, templateMode: "copy" })),
        );
        latestCreated = results[0] ?? null;
        return results;
      },
    };
    await app.close();
    app = await createApp({ store, vault, providers: new ProviderRegistry([provider]), disableAuth: true });
    return store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: rows,
    }).id;
  }

  async function installCopyLaunchProvider(
    createFromPreset: (
      context: ProviderContext,
      mutations: CreationMutation[],
    ) => Promise<CreationMutationResult[]>,
  ): Promise<{
    input: {
      sourceAccountId: string;
      sourceAdId: string;
      targetAccountIds: string[];
      launchPresetId: string;
      launchRows: ReturnType<typeof apiLaunchRow>[];
    };
    setRemoteSourceVideoCode: (videoCode: string) => void;
    setRemoteTargetVideoCode: (videoCode: string) => void;
  }> {
    saveApiCopySource(store, "source-ad", "source-video");
    let remoteSourceVideoCode = "source-video";
    let remoteTargetVideoCode = "video-2";
    let creationDispatched = false;
    store.saveProviderConnectionSettings("demo-account", {
      kind: "cookie", advertiserId: "copy-source", healthUrl: "",
      campaignsUrl: "", adGroupsUrl: "", adsUrl: "",
    });
    const sourceReference = await vault.create(JSON.stringify({
      kind: "cookie",
      cookie: "sessionid=copy-source-session",
      csrfHeaderName: "x-csrftoken",
      requestTemplates: [],
    }));
    store.setProviderCredentialReference("demo-account", "cookie", sourceReference);
    store.updateProviderStatus("demo-account", "cookie", "ready", "ready");
    store.updateProviderAuthorization("demo-account", "cookie", {
      status: "active",
      capabilityVersion: "copy-test-v1",
      capabilities: ["read-campaigns", "create-campaigns", "copy-ads"],
    });
    const target = store.createAccount({
      displayName: "copy target",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    store.saveProviderConnectionSettings(target.id, {
      kind: "cookie", advertiserId: "copy-target", healthUrl: "",
      campaignsUrl: "", adGroupsUrl: "", adsUrl: "",
    });
    const reference = await vault.create(JSON.stringify({
      kind: "cookie",
      cookie: "sessionid=copy-target-session",
      csrfHeaderName: "x-csrftoken",
      requestTemplates: [],
    }));
    store.setProviderCredentialReference(target.id, "cookie", reference);
    store.updateProviderStatus(target.id, "cookie", "ready", "ready");
    store.updateProviderAuthorization(target.id, "cookie", {
      status: "active",
      capabilityVersion: "copy-test-v1",
      capabilities: ["read-campaigns", "create-campaigns"],
    });
    store.setAccountExecutionMode(target.id, "automatic", "copy test");
    const syncAt = new Date().toISOString();
    store.saveReadOnlySync(target.id, "cookie", [{
      entityType: "ad",
      externalId: "target-asset-evidence",
      payload: { asset: { image_list: [{ aweme_item_id: "video-2" }] } },
    }], {
      startedAt: syncAt,
      finishedAt: syncAt,
      counts: { campaign: 0, "ad-group": 0, ad: 1 },
      warnings: [],
      quality: testSyncQuality(syncAt),
    });
    const provider: AdsProvider = {
      kind: "cookie",
      displayName: "copy test provider",
      capabilityVersion: "copy-test-v1",
      capabilities: new Set(["read-campaigns", "create-campaigns", "copy-ads"]),
      checkHealth: async () => ({ ok: true, status: "ready", message: "ready" }),
      syncReadOnly: async (context) => {
        const refreshedAt = new Date().toISOString();
        if (context.accountId === "demo-account") {
          return {
            entities: [
              { entityType: "campaign" as const, externalId: "source-campaign", payload: { campaign_name: "source campaign" } },
              { entityType: "ad-group" as const, externalId: "source-group", payload: { campaign_id: "source-campaign", adgroup_name: "source group" } },
              {
                entityType: "ad" as const,
                externalId: "source-ad",
                payload: {
                  campaign_id: "source-campaign",
                  adgroup_id: "source-group",
                  ad_name: "source ad",
                  asset: { image_list: [{ aweme_item_id: remoteSourceVideoCode }] },
                  external_url: "https://source.example/product",
                },
              },
            ],
            result: {
              startedAt: refreshedAt,
              finishedAt: refreshedAt,
              counts: { campaign: 1, "ad-group": 1, ad: 1 },
              warnings: [],
              quality: testSyncQuality(refreshedAt),
            },
          };
        }
        const entities = creationDispatched
          ? [
            { entityType: "campaign" as const, externalId: "new-campaign", payload: {} },
            { entityType: "ad-group" as const, externalId: "new-group", payload: {} },
            { entityType: "ad" as const, externalId: "new-ad", payload: {} },
          ]
          : [{
            entityType: "ad" as const,
            externalId: "target-asset-evidence",
            payload: { asset: { image_list: [{ aweme_item_id: remoteTargetVideoCode }] } },
          }];
        return {
          entities,
          result: {
            startedAt: refreshedAt,
            finishedAt: refreshedAt,
            counts: creationDispatched
              ? { campaign: 1, "ad-group": 1, ad: 1 }
              : { campaign: 0, "ad-group": 0, ad: 1 },
            warnings: [],
            quality: testSyncQuality(refreshedAt),
          },
        };
      },
      changeStatus: async (_context, mutations) => mutations.map((mutation) => ({ ...mutation, ok: true, message: "ok" })),
      create: async (context, mutations) => {
        creationDispatched = true;
        return createFromPreset(
          context,
          mutations.map((mutation) => ({ ...mutation, templateMode: "none" })),
        );
      },
      copy: async (context, mutations) => {
        creationDispatched = true;
        return createFromPreset(
          context,
          mutations.map((mutation) => ({ ...mutation, templateMode: "copy" })),
        );
      },
    };
    await app.close();
    app = await createApp({ store, vault, providers: new ProviderRegistry([provider]), disableAuth: true });
    return {
      input: {
        sourceAccountId: "demo-account",
        sourceAdId: "source-ad",
        targetAccountIds: [target.id],
        launchPresetId: "default-launch-preset",
        launchRows: [apiLaunchRow(2)],
      },
      setRemoteSourceVideoCode: (videoCode) => {
        remoteSourceVideoCode = videoCode;
      },
      setRemoteTargetVideoCode: (videoCode) => {
        remoteTargetVideoCode = videoCode;
      },
    };
  }
});

function apiLaunchRow(rowNumber: number) {
  return {
    rowNumber,
    campaignName: `campaign-${rowNumber}`,
    adGroupName: `group-${rowNumber}`,
    adName: `260717:${String(rowNumber).padStart(3, "0")}`,
    videoCode: `video-${rowNumber}`,
    productUrl: "https://example.com/product",
    region: "US",
    dailyBudget: 100,
    bid: null,
    startAt: null,
    endAt: null,
    initialStatus: "disabled" as const,
  };
}

function saveApiCopySource(store: AutomationStore, adId: string, videoCode: string): void {
  const syncAt = new Date().toISOString();
  store.saveReadOnlySync("demo-account", "cookie", [
    { entityType: "campaign", externalId: "source-campaign", payload: { campaign_name: "source campaign" } },
    { entityType: "ad-group", externalId: "source-group", payload: { campaign_id: "source-campaign", adgroup_name: "source group" } },
    {
      entityType: "ad",
      externalId: adId,
      payload: {
        campaign_id: "source-campaign",
        adgroup_id: "source-group",
        ad_name: "source ad",
        asset: { image_list: [{ aweme_item_id: videoCode }] },
        external_url: "https://source.example/product",
      },
    },
  ], {
    startedAt: syncAt,
    finishedAt: syncAt,
    counts: { campaign: 1, "ad-group": 1, ad: 1 },
    warnings: [],
    quality: testSyncQuality(syncAt),
  });
}
