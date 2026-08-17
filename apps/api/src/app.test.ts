import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationStore } from "@tk-auto/storage";
import { createApp } from "./app.js";
import {
  LaunchService,
  stripGeneratedAdGroupNameSuffixes,
} from "./launch-service.js";
import { LaunchWorker } from "./launch-worker.js";
import type { FastifyInstance } from "fastify";
import { InMemoryCredentialVault } from "@tk-auto/credentials";
import {
  ProviderRegistry,
  RetryableCreationError,
  UnknownCreationStateError,
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

  function createMetaOfflineAccount() {
    return store.createAccount({
      displayName: "Meta 离线测试账户",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "meta-offline",
    });
  }

  function seedMetaOfflineAdGroup(accountId: string, externalId = "meta-group-1") {
    const now = new Date().toISOString();
    store.saveReadOnlySync(accountId, "meta-offline", [{
      entityType: "ad-group",
      externalId,
      payload: { ad_name: "Meta 离线广告组", status: "ENABLE" },
    }], {
      startedAt: now,
      finishedAt: now,
      counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
      warnings: [],
      quality: testSyncQuality(now),
    });
  }

  it("returns bootstrap configuration", async () => {
    const response = await app.inject({ method: "GET", url: "/api/bootstrap" });

    expect(response.statusCode).toBe(200);
    expect(response.json().accounts).toHaveLength(1);
    expect(response.json().accountConnectionStates).toEqual([
      expect.objectContaining({ accountId: "demo-account" }),
    ]);
    expect(response.json().providers).toHaveLength(4);
    expect(response.json().providers).toContainEqual(expect.objectContaining({
      kind: "meta-offline",
      platform: "meta",
      implementationStatus: "scaffolded",
      capabilities: [],
    }));
    expect(response.json().providers).toContainEqual(expect.objectContaining({
      kind: "meta-marketing-api",
      platform: "meta",
      implementationStatus: "available",
      capabilities: [
        "read-campaigns",
        "read-ad-groups",
        "read-ads",
        "change-status",
        "create-campaigns",
        "copy-campaigns",
      ],
    }));
    expect(response.json()).not.toHaveProperty("switchDefinitions");
    expect(response.json().globalAutomationSettings).toMatchObject({
      pollingIntervalMinutes: 5,
      maxActionsPerRun: 15,
    });
  });

  it("keeps the existing session cookie name by default", async () => {
    await app.close();
    app = await createApp({ store, vault });

    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: {
        username: "default-cookie-developer",
        displayName: "默认 Cookie 开发者",
        password: "Default-Cookie-Developer-2026!",
      },
    });

    expect(setup.statusCode).toBe(201);
    expect(setup.headers["set-cookie"]).toMatch(/^tk_auto_session=/);
  });

  it("reads and clears an isolated custom session cookie", async () => {
    await app.close();
    const authCookieName = "tk_auto_meta_live_test_session";
    app = await createApp({ store, vault, authCookieName });

    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: {
        username: "custom-cookie-developer",
        displayName: "隔离 Cookie 开发者",
        password: "Custom-Cookie-Developer-2026!",
      },
    });
    const setCookie = String(setup.headers["set-cookie"]);
    const cookie = setCookie.split(";", 1)[0] as string;
    const token = cookie.slice(cookie.indexOf("=") + 1);
    const csrfToken = setup.json().csrfToken as string;

    expect(setCookie).toMatch(new RegExp(`^${authCookieName}=`));
    expect(setCookie).not.toContain("tk_auto_session=");
    const wrongNamespace = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { cookie: `tk_auto_session=${token}` },
    });
    expect(wrongNamespace.statusCode).toBe(401);
    const authenticated = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { cookie },
    });
    expect(authenticated.statusCode).toBe(200);

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, "x-csrf-token": csrfToken },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers["set-cookie"]).toMatch(
      new RegExp(`^${authCookieName}=;.*Max-Age=0`),
    );
    expect(logout.headers["set-cookie"]).not.toContain("tk_auto_session=");
  });

  it("rejects unsafe custom session cookie names before starting the app", async () => {
    await expect(createApp({
      store,
      vault,
      authCookieName: "unsafe; Path=/\r\nSet-Cookie: injected=1",
    })).rejects.toThrow("鉴权 Cookie 名称包含不安全字符");
  });

  it("fails closed without resetting users when local access recovery is disabled", async () => {
    await app.close();
    app = await createApp({ store, vault, allowAuthRecovery: false });

    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: {
        username: "recovery-disabled-developer",
        displayName: "禁用恢复开发者",
        password: "Recovery-Disabled-Developer-2026!",
      },
    });
    const cookie = String(setup.headers["set-cookie"]).split(";", 1)[0] as string;

    const recovery = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      payload: { confirmation: "RESET" },
    });
    expect(recovery.statusCode).toBe(404);
    expect(store.countLocalUsers()).toBe(1);

    const status = await app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { cookie },
    });
    expect(status.json()).toMatchObject({
      setupRequired: false,
      authenticated: true,
      user: { username: "recovery-disabled-developer" },
    });
  });

  it("keeps only the base name when stripping generated expansion fields", () => {
    expect(stripGeneratedAdGroupNameSuffixes("蓝牙音响0723-0724-1"))
      .toBe("蓝牙音响");
    expect(stripGeneratedAdGroupNameSuffixes("蓝牙音响0723-0724-1-0725-2"))
      .toBe("蓝牙音响");
    expect(stripGeneratedAdGroupNameSuffixes("A9音响-0724-1"))
      .toBe("A9音响");
    expect(stripGeneratedAdGroupNameSuffixes("蓝牙音响2024"))
      .toBe("蓝牙音响2024");
    expect(stripGeneratedAdGroupNameSuffixes("产品0230"))
      .toBe("产品0230");
  });

  it("按 M/N 分配把源系列复制成多个新系列，并对相同任务幂等跳过", async () => {
    const copyCampaign = vi.fn(async (
      _context: unknown,
      _input: { campaignName: string; adGroups: Array<{ sourceAdGroupId: string; name: string }> },
    ) => ({ ok: true, message: "copied", adGroupIds: ["g1"] }));
    const seedEntities = [
      { entityType: "campaign" as const, externalId: "campaign-1", payload: { campaign_id: "campaign-1", campaign_name: "夏季系列", budget: "88.00", budget_mode: 3, budget_optimize_switch: 1 } },
      { entityType: "ad-group" as const, externalId: "adgroup-1", payload: { campaign_id: "campaign-1", ad_name: "组A" } },
      { entityType: "ad-group" as const, externalId: "adgroup-2", payload: { campaign_id: "campaign-1", ad_name: "组B" } },
    ];
    const provider = {
      kind: "cookie",
      displayName: "campaign copy provider",
      capabilityVersion: "campaign-copy-v1",
      capabilities: new Set(["copy-campaigns", "read-campaigns"]),
      copyCampaign,
      // 系列复制发布前会强制刷新一次账户状态用于命名去重；测试里原样回放
      // 已灌好的快照即可，验证的是「确实调用了」，不是刷新出的新内容。
      syncReadOnly: async () => ({
        entities: seedEntities,
        result: { startedAt: syncedAt, finishedAt: syncedAt, counts: { campaign: 1, "ad-group": 2, ad: 0, material: 0 }, warnings: [], quality: testSyncQuality(syncedAt) },
      }),
    } as unknown as AdsProvider & { copyCampaign: typeof copyCampaign };
    store.saveProviderConnectionSettings("demo-account", {
      kind: "cookie",
      advertiserId: "1001",
      healthUrl: "",
      campaignsUrl: "",
      adGroupsUrl: "",
      adsUrl: "",
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
      capabilityVersion: "campaign-copy-v1",
      capabilities: ["copy-campaigns", "read-campaigns"],
    });
    const syncedAt = new Date().toISOString();
    store.saveReadOnlySync("demo-account", "cookie", seedEntities,
      { startedAt: syncedAt, finishedAt: syncedAt, counts: { campaign: 1, "ad-group": 2, ad: 0, material: 0 }, warnings: [], quality: testSyncQuality(syncedAt) });
    await app.close();
    app = await createApp({ store, vault, providers: new ProviderRegistry([provider]), disableAuth: true });

    const payload = {
      accountId: "demo-account",
      // 你的场景：1 个系列 2 个组 → 2 个系列各 1 个组。
      sources: [{ sourceCampaignId: "campaign-1", sourceAdGroupIds: ["adgroup-1", "adgroup-2"] }],
      campaignCopies: 2,
      groupsPerCampaign: 1,
      initialStatus: "disabled" as const,
    };
    const response = await app.inject({ method: "POST", url: "/api/campaigns/copy", payload });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ createdCampaigns: 2, createdGroups: 2, failed: [] });
    expect(copyCampaign).toHaveBeenCalledTimes(2);
    // 每个系列副本各拿一个源组，创意不会串组。
    expect(copyCampaign.mock.calls[0]?.[1]).toMatchObject({
      adGroups: [{ sourceAdGroupId: "adgroup-1" }],
      createNewPosts: true,
    });
    expect(copyCampaign.mock.calls[1]?.[1]).toMatchObject({
      adGroups: [{ sourceAdGroupId: "adgroup-2" }],
    });
    // 系列名带日期与序号，且两个副本互不重名。
    const names = copyCampaign.mock.calls.map((call) => call[1].campaignName);
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(name).toMatch(/^夏季系列-\d{4}-\d+$/);

    // 相同任务重放：幂等表命中，不再发出任何 Provider 请求。
    const replay = await app.inject({ method: "POST", url: "/api/campaigns/copy", payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ createdCampaigns: 0, skipped: 2 });
    expect(copyCampaign).toHaveBeenCalledTimes(2);
  });

  interface CampaignCopyMockResult {
    ok: boolean;
    message: string;
    campaignId?: string;
    adGroupIds?: string[];
    failureKind?: "failed" | "unknown";
    retrySafe?: boolean;
  }

  async function setupCampaignCopyAccount(
    copyCampaign: (...args: unknown[]) => Promise<CampaignCopyMockResult>,
  ) {
    const syncedAt = new Date().toISOString();
    const seedEntities = [
      { entityType: "campaign" as const, externalId: "campaign-1", payload: { campaign_id: "campaign-1", campaign_name: "夏季系列" } },
      { entityType: "ad-group" as const, externalId: "adgroup-1", payload: { campaign_id: "campaign-1", ad_name: "组A" } },
    ];
    const syncResult = { startedAt: syncedAt, finishedAt: syncedAt, counts: { campaign: 1, "ad-group": 1, ad: 0, material: 0 }, warnings: [], quality: testSyncQuality(syncedAt) };
    const provider = {
      kind: "cookie",
      displayName: "campaign copy provider",
      capabilityVersion: "campaign-copy-v1",
      capabilities: new Set(["copy-campaigns", "read-campaigns"]),
      copyCampaign,
      // 发布前会强制刷新账户状态用于命名去重；测试里原样回放已灌好的快照。
      syncReadOnly: async () => ({ entities: seedEntities, result: syncResult }),
    } as unknown as AdsProvider;
    store.saveProviderConnectionSettings("demo-account", {
      kind: "cookie", advertiserId: "1001", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "",
    });
    const reference = await vault.create(JSON.stringify({
      kind: "cookie", cookie: "sessionid=test-session", csrfHeaderName: "x-csrftoken", requestTemplates: [],
    }));
    store.setProviderCredentialReference("demo-account", "cookie", reference);
    store.updateProviderStatus("demo-account", "cookie", "ready", "ready");
    store.updateProviderAuthorization("demo-account", "cookie", {
      status: "active", capabilityVersion: "campaign-copy-v1", capabilities: ["copy-campaigns", "read-campaigns"],
    });
    store.saveReadOnlySync("demo-account", "cookie", seedEntities, syncResult);
    await app.close();
    app = await createApp({ store, vault, providers: new ProviderRegistry([provider]), disableAuth: true });
  }

  const singleCampaignCopyPayload = {
    accountId: "demo-account",
    sources: [{ sourceCampaignId: "campaign-1", sourceAdGroupIds: ["adgroup-1"] }],
    campaignCopies: 1,
    groupsPerCampaign: 1,
    initialStatus: "disabled" as const,
  };

  it("任务级自动重试：retrySafe=true 的失败会在同一次请求内自动重试直至成功，不需要人工再点一次", async () => {
    // 复现真实故障：campaign_snap/copy 本身的传输失败，Provider 明确知道
    // 还没有产生任何草稿（retrySafe: true），这类失败应当自动愈合。
    const copyCampaign = vi.fn<(...args: unknown[]) => Promise<CampaignCopyMockResult>>(async () => ({
      ok: false,
      message: "campaign_snap/copy: fetch failed",
      failureKind: "unknown",
      retrySafe: true,
    }));
    copyCampaign.mockResolvedValueOnce({
      ok: false, message: "campaign_snap/copy: fetch failed", failureKind: "unknown", retrySafe: true,
    });
    copyCampaign.mockResolvedValueOnce({ ok: true, message: "copied", adGroupIds: ["g1"] });
    await setupCampaignCopyAccount(copyCampaign);

    const response = await app.inject({ method: "POST", url: "/api/campaigns/copy", payload: singleCampaignCopyPayload });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ createdCampaigns: 1, createdGroups: 1, failed: [] });
    // 同一个任务被自动重试了一次，用户不需要自己再点一次。
    expect(copyCampaign).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("retrySafe=true 但自动重试耗尽后：判为 failed（可再次尝试）而不是 unknown（永久锁死）", async () => {
    const copyCampaign = vi.fn<(...args: unknown[]) => Promise<CampaignCopyMockResult>>(async () => ({
      ok: false,
      message: "campaign_snap/copy: fetch failed",
      failureKind: "unknown",
      retrySafe: true,
    }));
    await setupCampaignCopyAccount(copyCampaign);

    const response = await app.inject({ method: "POST", url: "/api/campaigns/copy", payload: singleCampaignCopyPayload });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.createdCampaigns).toBe(0);
    expect(body.failed).toHaveLength(1);
    // 明确不是「结果待确认，禁止自动重试」——这条路径已知没有产生任何写入。
    expect(body.failed[0].message).toContain("已自动重试仍未成功，未产生任何写入");
    expect(body.failed[0].message).not.toContain("禁止自动重试");
    // 一次请求内重试到了上限（3 次尝试）。
    expect(copyCampaign).toHaveBeenCalledTimes(3);

    // 因为判定是 failed 而不是 unknown，任务记录会被清除，之后可以重新领取——
    // 不需要人工去数据库或专门的重置入口才能再次尝试。
    copyCampaign.mockResolvedValue({ ok: true, message: "copied", adGroupIds: ["g1"] });
    const retry = await app.inject({ method: "POST", url: "/api/campaigns/copy", payload: singleCampaignCopyPayload });
    expect(retry.json()).toMatchObject({ createdCampaigns: 1, skipped: 0 });
  }, 20_000);

  it("retrySafe=false：立即停止，不做任何自动重试，安全边界不因优化而放松", async () => {
    const copyCampaign = vi.fn<(...args: unknown[]) => Promise<CampaignCopyMockResult>>(async () => ({
      ok: false,
      message: "TikTok 创建终态不完整",
      failureKind: "unknown",
      retrySafe: false,
    }));
    await setupCampaignCopyAccount(copyCampaign);

    const response = await app.inject({ method: "POST", url: "/api/campaigns/copy", payload: singleCampaignCopyPayload });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.failed[0].message).toContain("结果待确认，禁止自动重试");
    // 一次都没有重试——retrySafe:false 必须立刻停手。
    expect(copyCampaign).toHaveBeenCalledTimes(1);

    // 后续同一个任务应当仍然被锁死，不能自动重新领取。
    const replay = await app.inject({ method: "POST", url: "/api/campaigns/copy", payload: singleCampaignCopyPayload });
    expect(replay.json().failed[0].message).toContain("上次系列复制结果待人工确认");
    expect(copyCampaign).toHaveBeenCalledTimes(1);

    // 卡死的任务必须能被列出来，供人工去 TikTok 后台核实真实状态。
    const listed = await app.inject({ method: "GET", url: "/api/accounts/demo-account/campaign-copy-tasks" });
    expect(listed.statusCode).toBe(200);
    const stuck = listed.json();
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ accountId: "demo-account", sourceCampaignId: "campaign-1" });
    expect(stuck[0].campaignName).toMatch(/^夏季系列-\d{4}-\d+$/);

    // 人工核实后重置：清掉本地锁，下次可以重新领取——不需要我去手动改数据库。
    const reset = await app.inject({
      method: "POST",
      url: `/api/accounts/demo-account/campaign-copy-tasks/${stuck[0].taskKey}/reset`,
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ ok: true });

    const listedAfterReset = await app.inject({ method: "GET", url: "/api/accounts/demo-account/campaign-copy-tasks" });
    expect(listedAfterReset.json()).toEqual([]);

    copyCampaign.mockResolvedValue({ ok: true, message: "copied", adGroupIds: ["g1"] });
    const afterReset = await app.inject({ method: "POST", url: "/api/campaigns/copy", payload: singleCampaignCopyPayload });
    expect(afterReset.json()).toMatchObject({ createdCampaigns: 1, skipped: 0 });
  });

  it("重置一个不存在或未卡死的任务返回 404", async () => {
    const copyCampaign = vi.fn<(...args: unknown[]) => Promise<CampaignCopyMockResult>>(async () => ({
      ok: true, message: "copied",
    }));
    await setupCampaignCopyAccount(copyCampaign);

    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/campaign-copy-tasks/does-not-exist/reset",
    });
    expect(response.statusCode).toBe(404);
  });

  it("多选源系列时逐个套用同一套 N/M，且副本名不跨源撞名", async () => {
    const copyCampaign = vi.fn(async (
      _context: unknown,
      _input: { campaignName: string; adGroups: Array<{ sourceAdGroupId: string; name: string }> },
    ) => ({ ok: true, message: "copied" }));
    const syncedAt = new Date().toISOString();
    // 两个源系列同名前缀，用来验证跨源的名称预留确实累积。
    const seedEntities = [
      { entityType: "campaign" as const, externalId: "c1", payload: { campaign_id: "c1", campaign_name: "同名系列" } },
      { entityType: "ad-group" as const, externalId: "g1", payload: { campaign_id: "c1", ad_name: "组1" } },
      { entityType: "campaign" as const, externalId: "c2", payload: { campaign_id: "c2", campaign_name: "同名系列" } },
      { entityType: "ad-group" as const, externalId: "g2", payload: { campaign_id: "c2", ad_name: "组2" } },
    ];
    const syncResult = { startedAt: syncedAt, finishedAt: syncedAt, counts: { campaign: 2, "ad-group": 2, ad: 0, material: 0 }, warnings: [], quality: testSyncQuality(syncedAt) };
    const provider = {
      kind: "cookie",
      displayName: "campaign copy provider",
      capabilityVersion: "campaign-copy-v1",
      capabilities: new Set(["copy-campaigns", "read-campaigns"]),
      copyCampaign,
      syncReadOnly: async () => ({ entities: seedEntities, result: syncResult }),
    } as unknown as AdsProvider & { copyCampaign: typeof copyCampaign };
    store.saveProviderConnectionSettings("demo-account", {
      kind: "cookie", advertiserId: "1001", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "",
    });
    const reference = await vault.create(JSON.stringify({
      kind: "cookie", cookie: "sessionid=test-session", csrfHeaderName: "x-csrftoken", requestTemplates: [],
    }));
    store.setProviderCredentialReference("demo-account", "cookie", reference);
    store.updateProviderStatus("demo-account", "cookie", "ready", "ready");
    store.updateProviderAuthorization("demo-account", "cookie", {
      status: "active", capabilityVersion: "campaign-copy-v1", capabilities: ["copy-campaigns", "read-campaigns"],
    });
    store.saveReadOnlySync("demo-account", "cookie", seedEntities, syncResult);
    await app.close();
    app = await createApp({ store, vault, providers: new ProviderRegistry([provider]), disableAuth: true });

    const response = await app.inject({
      method: "POST",
      url: "/api/campaigns/copy",
      payload: {
        accountId: "demo-account",
        sources: [
          { sourceCampaignId: "c1", sourceAdGroupIds: ["g1"] },
          { sourceCampaignId: "c2", sourceAdGroupIds: ["g2"] },
        ],
        campaignCopies: 2,
        groupsPerCampaign: 1,
        initialStatus: "disabled",
      },
    });

    expect(response.statusCode).toBe(200);
    // 两个源系列 × 每个 2 个副本 = 4 个新系列。
    expect(response.json()).toMatchObject({ createdCampaigns: 4, createdGroups: 4, failed: [] });
    expect(copyCampaign).toHaveBeenCalledTimes(4);

    const names = copyCampaign.mock.calls.map((call) => call[1].campaignName);
    // 两个源系列名字相同，副本名必须靠序号累积区分开，不能撞名。
    expect(new Set(names).size).toBe(4);
  });

  it("拒绝不属于源系列的广告组", async () => {
    const copyCampaign = vi.fn(async () => ({ ok: true, message: "copied" }));
    const syncedAt = new Date().toISOString();
    const seedEntities = [
      { entityType: "campaign" as const, externalId: "campaign-1", payload: { campaign_id: "campaign-1", campaign_name: "夏季系列" } },
      { entityType: "ad-group" as const, externalId: "adgroup-1", payload: { campaign_id: "campaign-1", ad_name: "组A" } },
      { entityType: "ad-group" as const, externalId: "other-group", payload: { campaign_id: "campaign-9", ad_name: "别的系列的组" } },
    ];
    const syncResult = { startedAt: syncedAt, finishedAt: syncedAt, counts: { campaign: 1, "ad-group": 2, ad: 0, material: 0 }, warnings: [], quality: testSyncQuality(syncedAt) };
    const provider = {
      kind: "cookie",
      displayName: "campaign copy provider",
      capabilityVersion: "campaign-copy-v1",
      capabilities: new Set(["copy-campaigns", "read-campaigns"]),
      copyCampaign,
      syncReadOnly: async () => ({ entities: seedEntities, result: syncResult }),
    } as unknown as AdsProvider;
    store.saveProviderConnectionSettings("demo-account", {
      kind: "cookie", advertiserId: "1001", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "",
    });
    const reference = await vault.create(JSON.stringify({
      kind: "cookie", cookie: "sessionid=test-session", csrfHeaderName: "x-csrftoken", requestTemplates: [],
    }));
    store.setProviderCredentialReference("demo-account", "cookie", reference);
    store.updateProviderStatus("demo-account", "cookie", "ready", "ready");
    store.updateProviderAuthorization("demo-account", "cookie", {
      status: "active", capabilityVersion: "campaign-copy-v1", capabilities: ["copy-campaigns", "read-campaigns"],
    });
    store.saveReadOnlySync("demo-account", "cookie", seedEntities, syncResult);
    await app.close();
    app = await createApp({ store, vault, providers: new ProviderRegistry([provider]), disableAuth: true });

    const response = await app.inject({
      method: "POST",
      url: "/api/campaigns/copy",
      payload: {
        accountId: "demo-account",
        sources: [{ sourceCampaignId: "campaign-1", sourceAdGroupIds: ["other-group"] }],
        campaignCopies: 1,
        groupsPerCampaign: 1,
        initialStatus: "disabled",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("不属于源推广系列");
    expect(copyCampaign).not.toHaveBeenCalled();
  });

  it("passes scheduled expansion to the provider as enabled native scheduling without a software enable task", async () => {
    const scheduledStartAt = "2026-07-24T00:00:00.000Z";
    const copyAdGroupToExistingCampaign = vi.fn(async () => ({ ok: true, message: "scheduled" }));
    const provider = {
      kind: "cookie",
      displayName: "scheduled expansion provider",
      capabilityVersion: "scheduled-expansion-v1",
      capabilities: new Set(["copy-ads"]),
      copyAdGroupToExistingCampaign,
    } as unknown as AdsProvider & {
      copyAdGroupToExistingCampaign: typeof copyAdGroupToExistingCampaign;
    };
    store.saveProviderConnectionSettings("demo-account", {
      kind: "cookie",
      advertiserId: "1001",
      healthUrl: "",
      campaignsUrl: "",
      adGroupsUrl: "",
      adsUrl: "",
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
      capabilityVersion: "scheduled-expansion-v1",
      capabilities: ["copy-ads"],
    });
    await app.close();
    app = await createApp({ store, vault, providers: new ProviderRegistry([provider]), disableAuth: true });

    const response = await app.inject({
      method: "POST",
      url: "/api/ad-groups/batch-expand",
      payload: {
        sources: [{
          accountId: "demo-account",
          sourceCampaignId: "campaign-1",
          sourceCampaignName: "campaign",
          sourceAdGroupId: "adgroup-1",
          sourceAdGroupName: "蓝牙音响0723-0724-1",
        }],
        count: 2,
        dailyBudget: 50,
        bid: null,
        launchImmediately: false,
        sameCampaign: true,
        scheduledStartAt,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ createdGroups: 2, scheduled: 2, failed: [] });
    expect(copyAdGroupToExistingCampaign).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        // 排期 2026-07-24T00:00Z 在账户时区（Asia/Shanghai）是当天 08:00:00。
        names: ["蓝牙音响-0724-080000-1", "蓝牙音响-0724-080000-2"],
        initialStatus: "enabled",
        scheduledStartAt,
        dailyBudget: 50,
        bid: null,
      }),
    );
    expect(store.listScheduledActions("demo-account")).toEqual([]);

    const unsupported = await app.inject({
      method: "POST",
      url: "/api/ad-groups/batch-expand",
      payload: {
        sources: [{
          accountId: "demo-account",
          sourceCampaignId: "campaign-1",
          sourceCampaignName: "campaign",
          sourceAdGroupId: "adgroup-2",
          sourceAdGroupName: "adgroup 2",
        }],
        count: 1,
        dailyBudget: 50,
        bid: null,
        launchImmediately: false,
        sameCampaign: false,
        scheduledStartAt,
      },
    });
    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.json().message).toContain("定时扩组仅支持挂回原系列");
    expect(copyAdGroupToExistingCampaign).toHaveBeenCalledTimes(1);
  });

  it("does not automatically retry an expansion whose provider result is unknown", async () => {
    const copyAdGroupToExistingCampaign = vi.fn(async () => ({
      ok: false,
      message: "create_by_snap：请求已发出，但响应丢失",
      failureKind: "unknown" as const,
    }));
    const provider = {
      kind: "cookie",
      displayName: "unknown expansion provider",
      capabilityVersion: "scheduled-expansion-v1",
      capabilities: new Set(["copy-ads"]),
      copyAdGroupToExistingCampaign,
    } as unknown as AdsProvider & {
      copyAdGroupToExistingCampaign: typeof copyAdGroupToExistingCampaign;
    };
    store.saveProviderConnectionSettings("demo-account", {
      kind: "cookie",
      advertiserId: "1001",
      healthUrl: "",
      campaignsUrl: "",
      adGroupsUrl: "",
      adsUrl: "",
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
      capabilityVersion: "scheduled-expansion-v1",
      capabilities: ["copy-ads"],
    });
    await app.close();
    app = await createApp({ store, vault, providers: new ProviderRegistry([provider]), disableAuth: true });
    const payload = {
      sources: [{
        accountId: "demo-account",
        sourceCampaignId: "campaign-1",
        sourceCampaignName: "campaign",
        sourceAdGroupId: "adgroup-1",
        sourceAdGroupName: "adgroup",
      }],
      count: 1,
      dailyBudget: 50,
      bid: 7,
      launchImmediately: true,
      sameCampaign: true,
      scheduledStartAt: null,
    };

    const first = await app.inject({ method: "POST", url: "/api/ad-groups/batch-expand", payload });
    const second = await app.inject({ method: "POST", url: "/api/ad-groups/batch-expand", payload });

    expect(first.statusCode).toBe(200);
    expect(first.json().failed[0].message).toContain("禁止自动重试");
    expect(second.json()).toMatchObject({ createdGroups: 0, skipped: 0 });
    expect(second.json().failed[0].message).toContain("待人工确认");
    expect(copyAdGroupToExistingCampaign).toHaveBeenCalledTimes(1);
  });

  it("passes the dispatch guard through the non-same-campaign copy path", async () => {
    const copy = vi.fn(async (_context: ProviderContext, mutations: CreationMutation[]) => {
      mutations[0]?.onBeforeDispatch?.();
      throw new UnknownCreationStateError("response lost after dispatch");
    });
    const provider = {
      kind: "cookie",
      displayName: "guarded expansion provider",
      capabilityVersion: "guarded-expansion-v1",
      capabilities: new Set(["copy-ads"]),
      copy,
    } as unknown as AdsProvider;
    store.saveProviderConnectionSettings("demo-account", {
      kind: "cookie",
      advertiserId: "1001",
      healthUrl: "",
      campaignsUrl: "",
      adGroupsUrl: "",
      adsUrl: "",
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
      capabilityVersion: "guarded-expansion-v1",
      capabilities: ["copy-ads"],
    });
    await app.close();
    app = await createApp({ store, vault, providers: new ProviderRegistry([provider]), disableAuth: true });
    const payload = {
      sources: [{
        accountId: "demo-account",
        sourceCampaignId: "campaign-1",
        sourceCampaignName: "campaign",
        sourceAdGroupId: "adgroup-guarded",
        sourceAdGroupName: "adgroup guarded",
      }],
      count: 1,
      dailyBudget: 50,
      bid: 7,
      launchImmediately: true,
      sameCampaign: false,
      scheduledStartAt: null,
    };

    const first = await app.inject({ method: "POST", url: "/api/ad-groups/batch-expand", payload });
    const second = await app.inject({ method: "POST", url: "/api/ad-groups/batch-expand", payload });

    expect(first.statusCode).toBe(200);
    expect(first.json().failed[0].message).toContain("禁止自动重试");
    expect(second.json().failed[0].message).toContain("待人工确认");
    expect(copy).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-same-campaign expansion after a partial success", async () => {
    let copyCall = 0;
    const copy = vi.fn(async (_context: ProviderContext, mutations: CreationMutation[]) => {
      const mutation = mutations[0]!;
      mutation.onBeforeDispatch?.();
      copyCall += 1;
      return [{
        ...mutation,
        ok: copyCall === 1,
        message: copyCall === 1 ? "created" : "explicit rejection",
        ...(copyCall === 1
          ? { campaignId: "campaign-created", adGroupId: "group-created", adId: "ad-created" }
          : { failureKind: "retryable" as const, retrySafe: true }),
      } satisfies CreationMutationResult];
    });
    const provider = {
      kind: "cookie",
      displayName: "partial expansion provider",
      capabilityVersion: "partial-expansion-v1",
      capabilities: new Set(["copy-ads"]),
      copy,
    } as unknown as AdsProvider;
    store.saveProviderConnectionSettings("demo-account", {
      kind: "cookie",
      advertiserId: "1001",
      healthUrl: "",
      campaignsUrl: "",
      adGroupsUrl: "",
      adsUrl: "",
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
      capabilityVersion: "partial-expansion-v1",
      capabilities: ["copy-ads"],
    });
    await app.close();
    app = await createApp({ store, vault, providers: new ProviderRegistry([provider]), disableAuth: true });
    const payload = {
      sources: [{
        accountId: "demo-account",
        sourceCampaignId: "campaign-1",
        sourceCampaignName: "campaign",
        sourceAdGroupId: "adgroup-partial",
        sourceAdGroupName: "adgroup partial",
      }],
      count: 2,
      dailyBudget: 50,
      bid: 7,
      launchImmediately: true,
      sameCampaign: false,
      scheduledStartAt: null,
    };

    const first = await app.inject({ method: "POST", url: "/api/ad-groups/batch-expand", payload });
    const second = await app.inject({ method: "POST", url: "/api/ad-groups/batch-expand", payload });

    expect(first.statusCode).toBe(200);
    expect(first.json().failed[0].message).toContain("禁止自动重试");
    expect(second.json().failed[0].message).toContain("待人工确认");
    expect(copy).toHaveBeenCalledTimes(2);
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

  it("applies all three automation executor states and rules to every account", async () => {
    store.createAccount({
      displayName: "第二账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    const settings = store.getAutomationFeatureSettings();
    settings.appeal.enabled = false;
    settings.copy.autoCopyEnabled = true;
    settings.copy.autoCopyCount = 2;
    settings.copy.autoCopyMinConversions = 2;
    settings.deletion.enabled = true;
    settings.deletion.maxCarts = 4;

    const response = await app.inject({
      method: "POST",
      url: "/api/automation/features/apply-all",
      payload: settings,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accountCount: 2,
      settings: {
        appeal: { enabled: false },
        copy: {
          autoCopyEnabled: true,
          autoCopyCount: 2,
          autoCopyMinConversions: 2,
        },
        deletion: { enabled: true, maxCarts: 4 },
      },
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
    expect(body.layers).toEqual({ campaign: false, adGroup: true, ad: true, material: true });

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

  it("persists the account automation switch", async () => {
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
    expect(response.json()).toMatchObject({ enabled: false });

    const run = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/automation/run",
    });
    expect(run.statusCode).toBe(409);
    expect(run.json().message).toContain("账户自动化已关闭");
  });

  it("creates a Meta offline account but rejects API access and automation", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/accounts",
      payload: {
        displayName: "Meta 内部测试",
        platform: "meta",
        accountType: "standard",
        enabled: false,
        providerKind: "meta-offline",
      },
    });
    expect(created.statusCode).toBe(201);
    const account = created.json();
    expect(account).toMatchObject({ platform: "meta", providerKind: "meta-offline", enabled: false });

    const settings = await app.inject({
      method: "PUT",
      url: `/api/accounts/${account.id}/connections/meta-offline/settings`,
      payload: { kind: "meta-offline", businessId: "", adAccountId: "" },
    });
    expect(settings.statusCode).toBe(409);
    expect(store.listProviderConnections(account.id)).toEqual([]);

    const testConnection = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/connections/meta-offline/test`,
    });
    const sync = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/connections/meta-offline/sync`,
    });
    const run = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/automation/run`,
    });
    expect(testConnection.statusCode).toBe(409);
    expect(sync.statusCode).toBe(409);
    expect(run.statusCode).toBe(409);

    const unsafe = await app.inject({
      method: "POST",
      url: "/api/accounts",
      payload: {
        displayName: "Meta unsafe",
        platform: "meta",
        accountType: "standard",
        enabled: true,
        providerKind: "meta-offline",
      },
    });
    expect(unsafe.statusCode).toBe(400);
  });

  it("keeps Meta provider configuration, credentials, tests, and sync fail-closed", async () => {
    const account = createMetaOfflineAccount();
    const vaultCreate = vi.spyOn(vault, "create");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Meta offline tests must not use the network"),
    );

    const settings = await app.inject({
      method: "PUT",
      url: `/api/accounts/${account.id}/connections/meta-offline/settings`,
      payload: { kind: "meta-offline", businessId: "business-local", adAccountId: "act-local" },
    });
    const credential = await app.inject({
      method: "PUT",
      url: `/api/accounts/${account.id}/connections/meta-offline/credential`,
      payload: { kind: "meta-offline" },
    });
    const tested = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/connections/meta-offline/test`,
    });
    const synced = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/connections/meta-offline/sync`,
    });

    expect({
      statuses: [settings.statusCode, credential.statusCode, tested.statusCode, synced.statusCode],
      connections: store.listProviderConnections(account.id),
      vaultWrites: vaultCreate.mock.calls.length,
      networkCalls: fetchMock.mock.calls.length,
    }).toEqual({
      statuses: [409, 409, 409, 409],
      connections: [],
      vaultWrites: 0,
      networkCalls: 0,
    });
  });

  it("manages shared Meta access profiles without exposing the secret bundle", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/platforms/meta/access-profiles",
      payload: {
        name: "上海测试 Profile",
        appId: "100000000000001",
        businessId: null,
        graphApiVersion: "v23.0",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      hasAppSecret: false,
      hasAccessToken: false,
      referenceCount: 0,
    });
    const profileId = created.json().id as string;

    const saved = await app.inject({
      method: "PUT",
      url: `/api/platforms/meta/access-profiles/${profileId}/secret`,
      payload: {
        appSecret: "fixture-app-secret",
        accessToken: "fixture-access-token-long-enough",
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ hasAppSecret: true, hasAccessToken: true });
    expect(saved.body).not.toContain("fixture-app-secret");
    expect(saved.body).not.toContain("fixture-access-token");
    expect(saved.body).not.toContain("secretRef");
    expect(saved.body).not.toContain("credentialRef");

    const listed = await app.inject({
      method: "GET",
      url: "/api/platforms/meta/access-profiles",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([expect.objectContaining({ id: profileId })]);
    expect(listed.body).not.toContain("fixture-app-secret");
    expect(listed.body).not.toContain("fixture-access-token");
  });

  it("returns field-level Meta profile and secret validation without echoing credentials", async () => {
    const invalidProfile = await app.inject({
      method: "POST",
      url: "/api/platforms/meta/access-profiles",
      payload: {
        name: "Meta validation fixture",
        appId: "not-a-number",
        businessId: "bm-not-a-number",
        graphApiVersion: "26",
      },
    });

    expect(invalidProfile.statusCode).toBe(400);
    expect(invalidProfile.json()).toMatchObject({
      error: "VALIDATION_ERROR",
      details: {
        fieldErrors: {
          appId: ["App ID 必须是数字"],
          businessId: ["Business Portfolio ID 必须是数字"],
          graphApiVersion: ["Graph API 版本格式应为 vXX.X"],
        },
      },
    });

    const profile = store.createMetaAccessProfile({
      name: "Meta secret validation fixture",
      appId: "100000000000090",
      businessId: null,
      graphApiVersion: "v26.0",
    });
    const invalidAppSecret = "tiny";
    const invalidAccessToken = "short-token";
    const invalidSecret = await app.inject({
      method: "PUT",
      url: `/api/platforms/meta/access-profiles/${profile.id}/secret`,
      payload: {
        appSecret: invalidAppSecret,
        accessToken: invalidAccessToken,
      },
    });

    expect(invalidSecret.statusCode).toBe(400);
    expect(invalidSecret.json()).toMatchObject({
      error: "VALIDATION_ERROR",
      details: {
        fieldErrors: {
          appSecret: expect.any(Array),
          accessToken: expect.any(Array),
        },
      },
    });
    expect(invalidSecret.body).not.toContain(invalidAppSecret);
    expect(invalidSecret.body).not.toContain(invalidAccessToken);
    expect(store.getMetaAccessProfile(profile.id)).toMatchObject({
      hasAppSecret: false,
      hasAccessToken: false,
    });
  });

  it("rejects ordinary App ID replacement without deleting the saved secret bundle", async () => {
    const profile = store.createMetaAccessProfile({
      name: "App ID 变更测试",
      appId: "100000000000071",
      businessId: null,
      graphApiVersion: "v26.0",
    });
    const previousReference = await vault.create(JSON.stringify({
      appSecret: "previous-fixture-app-secret",
      accessToken: "previous-fixture-access-token-long-enough",
    }));
    store.setMetaAccessProfileSecretReference(profile.id, previousReference);

    const updated = await app.inject({
      method: "PUT",
      url: `/api/platforms/meta/access-profiles/${profile.id}`,
      payload: {
        name: "App ID 变更测试",
        appId: "100000000000072",
        businessId: null,
        graphApiVersion: "v26.0",
      },
    });

    expect(updated.statusCode).toBe(409);
    expect(updated.json()).toMatchObject({
      message: expect.stringContaining("不会因普通档案保存而自动清除"),
    });
    expect(updated.body).not.toContain("secretRef");
    expect(store.getStoredMetaAccessProfile(profile.id)).toMatchObject({
      appId: "100000000000071",
      secretRef: previousReference,
    });
    expect(await vault.read(previousReference)).not.toBeNull();
  });

  it("rejects deleting a referenced Meta access profile before touching its secret bundle", async () => {
    const profile = store.createMetaAccessProfile({
      name: "被引用的 Meta Profile",
      appId: "100000000000075",
      businessId: "200000000000075",
      graphApiVersion: "v26.0",
    });
    const reference = await vault.create(JSON.stringify({
      appSecret: "referenced-fixture-app-secret",
      accessToken: "referenced-fixture-access-token-long-enough",
    }));
    store.setMetaAccessProfileSecretReference(profile.id, reference);
    const account = store.createAccount({
      displayName: "引用 Profile 的 Meta 账户",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "meta-marketing-api",
    });
    store.saveProviderConnectionSettings(account.id, {
      kind: "meta-marketing-api",
      profileId: profile.id,
      adAccountId: "act_300000000000075",
      pageId: null,
      liveMode: "disabled",
      allowedStatusEntityTypes: [],
    });
    const deleteSecret = vi.spyOn(vault, "delete");

    const response = await app.inject({
      method: "DELETE",
      url: `/api/platforms/meta/access-profiles/${profile.id}`,
    });

    expect(response.statusCode).toBe(409);
    expect(store.getMetaAccessProfile(profile.id)).toMatchObject({
      referenceCount: 1,
      hasAppSecret: true,
      hasAccessToken: true,
    });
    expect(await vault.read(reference)).not.toBeNull();
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  it("reconciles an unknown Meta status operation through the API without replaying a write", async () => {
    const account = store.createAccount({
      displayName: "Meta reconcile account",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "meta-marketing-api",
    });
    const profile = store.createMetaAccessProfile({
      name: "Meta reconcile profile",
      appId: "100000000000073",
      businessId: null,
      graphApiVersion: "v26.0",
    });
    store.setMetaAccessProfileSecretReference(profile.id, await vault.create(JSON.stringify({
      appSecret: "fixture-app-secret",
      accessToken: "fixture-access-token-long-enough",
    })));
    store.saveProviderConnectionSettings(account.id, {
      kind: "meta-marketing-api",
      profileId: profile.id,
      adAccountId: "act_300000000000073",
      pageId: null,
      liveMode: "manual-status",
      allowedStatusEntityTypes: ["ad"],
    });
    store.updateProviderStatus(account.id, "meta-marketing-api", "ready", "ready");
    store.updateProviderAuthorization(account.id, "meta-marketing-api", {
      status: "active",
      capabilityVersion: "fixture-meta-v1",
      capabilities: ["read-campaigns", "read-ad-groups", "read-ads", "change-status"],
    });
    store.updateProviderStatus(
      account.id,
      "meta-marketing-api",
      "failed",
      "fixture post-write readback failure",
    );
    const task = store.createStatusWriteTask({
      accountId: account.id,
      providerKind: "meta-marketing-api",
      entityType: "ad",
      externalId: "meta-ad-1",
      entityName: "Meta Ad",
      action: "disable",
      source: "manual",
    }, { id: "operator-1", name: "Operator", kind: "user" });
    store.claimStatusWriteTask(task.id, "executor-a", "pending");
    store.completeStatusWriteTask(task.id, "executor-a", "unknown", "response lost");
    const changeStatus = vi.fn();
    const finishedAt = new Date().toISOString();
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: account.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(finishedAt));
    const syncReadOnly = vi.fn(async () => ({
      entities: [{
        entityType: "ad" as const,
        externalId: "meta-ad-1",
        payload: {
          name: "Meta Ad",
          campaign_id: "meta-campaign-1",
          adgroup_id: "meta-adset-1",
          operation_status: "PAUSED",
        },
      }],
      result: {
        startedAt: finishedAt,
        finishedAt,
        counts: { campaign: 0, "ad-group": 0, ad: 1, material: 0 },
        warnings: [],
        quality: {
          ...testSyncQuality(finishedAt),
          coverage: { startDate: localDate, endDate: localDate, timezone: account.timezone },
          completeEntityTypes: ["ad" as const],
        },
      },
    }));
    const capabilities = new Set([
      "read-campaigns",
      "read-ad-groups",
      "read-ads",
      "change-status",
    ] as const);
    const provider = {
      kind: "meta-marketing-api",
      platform: "meta",
      implementationStatus: "available",
      displayName: "Meta reconcile fixture",
      capabilityVersion: "fixture-meta-v1",
      capabilities,
      resolveCapabilities() {
        return capabilities;
      },
      syncReadOnly,
      changeStatus,
    } as unknown as AdsProvider;
    await app.close();
    app = await createApp({
      store,
      vault,
      providers: new ProviderRegistry([provider]),
      disableAuth: true,
    });

    const reconciled = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/meta/status-operations/${task.operationId}/reconcile`,
    });

    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toMatchObject({
      resolution: "succeeded",
      operation: { status: "succeeded", phase: "readback" },
      asset: { entityType: "ad", externalId: "meta-ad-1", status: "disabled" },
    });
    expect(syncReadOnly).toHaveBeenCalledTimes(1);
    expect(changeStatus).not.toHaveBeenCalled();
  });

  it("keeps the rotated Meta secret active when cleanup of the previous bundle fails", async () => {
    const profile = store.createMetaAccessProfile({
      name: "轮换测试 Profile",
      appId: "100000000000099",
      businessId: null,
      graphApiVersion: "v26.0",
    });
    const previousReference = await vault.create(JSON.stringify({
      appSecret: "previous-fixture-app-secret",
      accessToken: "previous-fixture-access-token-long-enough",
    }));
    store.setMetaAccessProfileSecretReference(profile.id, previousReference);
    const originalDelete = vault.delete.bind(vault);
    vi.spyOn(vault, "delete").mockImplementation(async (reference) => {
      if (reference === previousReference) {
        throw new Error("fixture old bundle cleanup failure");
      }
      await originalDelete(reference);
    });

    const rotated = await app.inject({
      method: "PUT",
      url: `/api/platforms/meta/access-profiles/${profile.id}/secret`,
      payload: {
        appSecret: "rotated-fixture-app-secret",
        accessToken: "rotated-fixture-access-token-long-enough",
      },
    });

    expect(rotated.statusCode).toBe(200);
    expect(rotated.body).not.toContain("rotated-fixture-app-secret");
    expect(rotated.body).not.toContain("rotated-fixture-access-token");
    expect(rotated.body).not.toContain("secretRef");
    const stored = store.getStoredMetaAccessProfile(profile.id);
    expect(stored?.secretRef).toBeTruthy();
    expect(stored?.secretRef).not.toBe(previousReference);
    expect(JSON.parse(await vault.read(stored?.secretRef as string) as string)).toEqual({
      appSecret: "rotated-fixture-app-secret",
      accessToken: "rotated-fixture-access-token-long-enough",
    });
    expect(await vault.read(previousReference)).not.toBeNull();
  });

  it("rejects a stale Meta secret save when the App ID changes concurrently", async () => {
    const profile = store.createMetaAccessProfile({
      name: "并发 App ID 测试",
      appId: "100000000000074",
      businessId: null,
      graphApiVersion: "v26.0",
    });
    const originalCreate = vault.create.bind(vault);
    let staleReference = "";
    vi.spyOn(vault, "create").mockImplementation(async (secret) => {
      staleReference = await originalCreate(secret);
      store.updateMetaAccessProfile(profile.id, {
        name: "并发 App ID 测试",
        appId: "100000000000075",
        businessId: null,
        graphApiVersion: "v26.0",
      });
      return staleReference;
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/platforms/meta/access-profiles/${profile.id}/secret`,
      payload: {
        appSecret: "stale-fixture-app-secret",
        accessToken: "stale-fixture-access-token-long-enough",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("已发生变化");
    expect(response.body).not.toContain("stale-fixture-app-secret");
    expect(response.body).not.toContain("stale-fixture-access-token");
    expect(store.getStoredMetaAccessProfile(profile.id)).toMatchObject({
      appId: "100000000000075",
      secretRef: null,
    });
    expect(await vault.read(staleReference)).toBeNull();
  });

  it("returns a conflict when Meta access profiles reuse the same App ID", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/platforms/meta/access-profiles",
      payload: {
        name: "唯一 App Profile",
        appId: "100000000000088",
        businessId: null,
        graphApiVersion: "v26.0",
      },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/platforms/meta/access-profiles",
      payload: {
        name: "待更新 Profile",
        appId: "100000000000089",
        businessId: null,
        graphApiVersion: "v26.0",
      },
    });
    const duplicateCreate = await app.inject({
      method: "POST",
      url: "/api/platforms/meta/access-profiles",
      payload: {
        name: "重复 App Profile",
        appId: "100000000000088",
        businessId: "200000000000088",
        graphApiVersion: "v26.0",
      },
    });
    const duplicateUpdate = await app.inject({
      method: "PUT",
      url: `/api/platforms/meta/access-profiles/${second.json().id as string}`,
      payload: {
        name: "更新为重复 App Profile",
        appId: "100000000000088",
        businessId: null,
        graphApiVersion: "v26.0",
      },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(duplicateCreate.statusCode).toBe(409);
    expect(duplicateUpdate.statusCode).toBe(409);
    expect(duplicateCreate.body).not.toContain("secretRef");
    expect(duplicateUpdate.body).not.toContain("secretRef");
  });

  it("discovers Meta ad accounts only through the explicit profile action", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [{
          id: "act_300000000000003",
          name: "上海测试账户",
          currency: "USD",
          timezone_name: "Asia/Shanghai",
          account_status: 1,
        }],
        paging: {},
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const profile = store.createMetaAccessProfile({
      name: "发现测试 Profile",
      appId: "100000000000002",
      businessId: null,
      graphApiVersion: "v23.0",
    });
    const reference = await vault.create(JSON.stringify({
      appSecret: "fixture-app-secret",
      accessToken: "fixture-access-token-long-enough",
    }));
    store.setMetaAccessProfileSecretReference(profile.id, reference);

    const listed = await app.inject({
      method: "GET",
      url: "/api/platforms/meta/access-profiles",
    });
    expect(listed.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();

    const discovered = await app.inject({
      method: "POST",
      url: `/api/platforms/meta/access-profiles/${profile.id}/discover-ad-accounts`,
    });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json()).toEqual([{
      adAccountId: "act_300000000000003",
      name: "上海测试账户",
      currency: "USD",
      timezone: "Asia/Shanghai",
      accountStatus: 1,
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.pathname).toBe("/v23.0/me/adaccounts");
    expect(requestUrl.searchParams.get("fields"))
      .toBe("id,name,currency,timezone_name,account_status");
    expect(requestUrl.searchParams.get("appsecret_proof")).toMatch(/^[a-f0-9]{64}$/);
    expect(discovered.body).not.toContain("fixture-app-secret");
    expect(discovered.body).not.toContain("fixture-access-token");
  });

  it("discovers owned Meta ad accounts through the optional Business Portfolio ID", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [{
          id: "act_300000000000099",
          name: "Business 下属账户",
          currency: "USD",
          timezone_name: "Asia/Shanghai",
          account_status: 1,
        }],
        paging: {},
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const profile = store.createMetaAccessProfile({
      name: "Business 发现测试 Profile",
      appId: "100000000000099",
      businessId: "200000000000099",
      graphApiVersion: "v26.0",
    });
    const reference = await vault.create(JSON.stringify({
      appSecret: "fixture-business-app-secret",
      accessToken: "fixture-business-access-token-long-enough",
    }));
    store.setMetaAccessProfileSecretReference(profile.id, reference);

    const discovered = await app.inject({
      method: "POST",
      url: `/api/platforms/meta/access-profiles/${profile.id}/discover-ad-accounts`,
    });

    expect(discovered.statusCode).toBe(200);
    expect(discovered.json()).toEqual([expect.objectContaining({
      adAccountId: "act_300000000000099",
      name: "Business 下属账户",
    })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.pathname).toBe(
      "/v26.0/200000000000099/owned_ad_accounts",
    );
    expect(requestUrl.searchParams.get("appsecret_proof")).toMatch(/^[a-f0-9]{64}$/);
    expect(discovered.body).not.toContain("fixture-business-app-secret");
    expect(discovered.body).not.toContain("fixture-business-access-token");
  });

  it("rejects stale concurrent Meta rules and runtime updates", async () => {
    const rules = store.getMetaRuleConfiguration();
    const runtime = store.getMetaAutomationRuntime();
    const firstRules = await app.inject({
      method: "PUT",
      url: "/api/platforms/meta/rules",
      payload: { ...rules, expectedUpdatedAt: rules.updatedAt },
    });
    const staleRules = await app.inject({
      method: "PUT",
      url: "/api/platforms/meta/rules",
      payload: { ...rules, expectedUpdatedAt: rules.updatedAt },
    });
    const firstRuntime = await app.inject({
      method: "PUT",
      url: "/api/platforms/meta/runtime",
      payload: { ...runtime, expectedUpdatedAt: runtime.updatedAt },
    });
    const staleRuntime = await app.inject({
      method: "PUT",
      url: "/api/platforms/meta/runtime",
      payload: { ...runtime, expectedUpdatedAt: runtime.updatedAt },
    });

    expect(firstRules.statusCode).toBe(200);
    expect(firstRuntime.statusCode).toBe(200);
    expect(staleRules.statusCode).toBe(409);
    expect(staleRuntime.statusCode).toBe(409);
    expect(staleRules.json().error).toBe("PLATFORM_CONFIGURATION_CONFLICT");
    expect(staleRuntime.json().error).toBe("PLATFORM_CONFIGURATION_CONFLICT");
  });

  it("stores the shared Meta provider contract while disabled mode keeps network and writes closed", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/accounts",
      payload: {
        displayName: "Meta read-only fixture",
        platform: "meta",
        accountType: "standard",
        enabled: false,
        providerKind: "meta-marketing-api",
      },
    });
    expect(created.statusCode).toBe(201);
    const account = created.json();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Meta architecture test must not use the network"),
    );

    const profileResponse = await app.inject({
      method: "POST",
      url: "/api/platforms/meta/access-profiles",
      payload: {
        name: "Meta fixture profile",
        appId: "100000000000001",
        businessId: "200000000000002",
        graphApiVersion: "v99.0",
      },
    });
    expect(profileResponse.statusCode).toBe(201);
    const profileId = profileResponse.json().id as string;
    const secret = await app.inject({
      method: "PUT",
      url: `/api/platforms/meta/access-profiles/${profileId}/secret`,
      payload: {
        appSecret: "fixture-meta-app-secret",
        accessToken: "fixture-meta-token-with-enough-length",
      },
    });
    expect(secret.statusCode).toBe(200);
    expect(secret.body).not.toContain("fixture-meta-app-secret");
    expect(secret.body).not.toContain("fixture-meta-token");

    const settings = await app.inject({
      method: "PUT",
      url: `/api/accounts/${account.id}/connections/meta-marketing-api/settings`,
      payload: {
        kind: "meta-marketing-api",
        profileId,
        adAccountId: "act_300000000000003",
        pageId: null,
        liveMode: "disabled",
        allowedStatusEntityTypes: [],
      },
    });
    const credential = await app.inject({
      method: "PUT",
      url: `/api/accounts/${account.id}/connections/meta-marketing-api/credential`,
      payload: {
        appSecret: "must-not-be-accepted-here",
        accessToken: "must-not-be-accepted-here-either",
      },
    });
    const tested = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/connections/meta-marketing-api/test`,
    });
    const synced = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/connections/meta-marketing-api/sync`,
    });
    const run = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/automation/run`,
    });
    const statusWrite = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/entities/status`,
      payload: {
        entityType: "campaign",
        externalId: "500000000000005",
        action: "disable",
      },
    });

    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ hasCredential: true, status: "untested" });
    expect(credential.statusCode).toBe(409);
    expect(credential.body).not.toContain("fixture-meta-token");
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      status: "failed",
      authorizationStatus: "failed",
      authorizedCapabilities: [],
    });
    expect(tested.json().lastMessage).toContain("真实网络总开关仍关闭");
    expect(synced.statusCode).toBe(409);
    expect(run.statusCode).toBe(409);
    expect(statusWrite.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.listProviderConnections(account.id)).toHaveLength(1);
    expect(store.listAdOperations(account.id)).toEqual([]);
  });

  it("creates and lists an idempotent Meta PAUSED ad task through the API", async () => {
    const account = store.createAccount({
      displayName: "Meta creation fixture",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "meta-marketing-api",
    });
    const profile = store.createMetaAccessProfile({
      name: "Meta creation profile",
      appId: "100000000000001",
      businessId: null,
      graphApiVersion: "v99.0",
    });
    store.setMetaAccessProfileSecretReference(profile.id, await vault.create(JSON.stringify({
      appSecret: "fixture-meta-app-secret",
      accessToken: "fixture-meta-token-with-enough-length",
    })));
    store.saveProviderConnectionSettings(account.id, {
      kind: "meta-marketing-api",
      profileId: profile.id,
      adAccountId: "act_300000000000003",
      pageId: "400000000000004",
      liveMode: "automation-status",
      creationMode: "paused-only",
      allowedStatusEntityTypes: ["campaign", "ad-group", "ad"],
    });
    store.updateProviderStatus(account.id, "meta-marketing-api", "ready", "ready");
    store.updateProviderAuthorization(account.id, "meta-marketing-api", {
      status: "active",
      capabilityVersion: "meta-create-test-v1",
      capabilities: [
        "read-campaigns",
        "read-ad-groups",
        "read-ads",
        "change-status",
        "create-campaigns",
      ],
    });
    store.updateSystemRuntimeState({ enabled: true });
    store.updateMetaAutomationRuntime({
      enabled: true,
      pollingIntervalMinutes: 5,
      maxActionsPerRun: 15,
    });
    store.updateAccountSettings(account.id, {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: true,
      providerKind: "meta-marketing-api",
    });
    const createMetaAd = vi.fn(async (_context, mutation) => {
      mutation.onProgress?.({
        phase: "campaign",
        campaignId: "120000000000101",
        message: "campaign confirmed",
      });
      mutation.onProgress?.({
        phase: "ad-set",
        campaignId: "120000000000101",
        adSetId: "120000000000102",
        message: "ad set confirmed",
      });
      if (mutation.input.targetLevel === "ad-set") {
        return {
          ok: true,
          campaignId: "120000000000101",
          adSetId: "120000000000102",
          message: "two layers confirmed",
        };
      }
      mutation.onProgress?.({
        phase: "creative",
        campaignId: "120000000000101",
        adSetId: "120000000000102",
        creativeId: "120000000000103",
        message: "creative confirmed",
      });
      mutation.onProgress?.({
        phase: "ad",
        campaignId: "120000000000101",
        adSetId: "120000000000102",
        creativeId: "120000000000103",
        adId: "120000000000104",
        message: "ad confirmed",
      });
      return {
        ok: true,
        campaignId: "120000000000101",
        adSetId: "120000000000102",
        creativeId: "120000000000103",
        adId: "120000000000104",
        message: "all confirmed",
      };
    });
    const reconcileMetaAd = vi.fn(async (_context, mutation) => ({
      ok: false,
      ...mutation.existing,
      failureKind: "retryable" as const,
      message: "next layer confirmed absent",
    }));
    const provider: AdsProvider = {
      kind: "meta-marketing-api",
      platform: "meta",
      implementationStatus: "available",
      displayName: "Meta creation test provider",
      capabilityVersion: "meta-create-test-v1",
      capabilities: new Set([
        "read-campaigns",
        "read-ad-groups",
        "read-ads",
        "change-status",
        "create-campaigns",
      ]),
      checkHealth: async () => ({ ok: true, status: "ready", message: "ready" }),
      syncReadOnly: async () => {
        const now = new Date().toISOString();
        return {
          entities: [],
          result: {
            startedAt: now,
            finishedAt: now,
            counts: { campaign: 0, "ad-group": 0, ad: 0, material: 0 },
            warnings: [],
            quality: testSyncQuality(now),
          },
        };
      },
      changeStatus: async (_context, mutations) => mutations.map((mutation) => ({
        ...mutation,
        ok: true,
        message: "status confirmed",
      })),
      createMetaAd,
      reconcileMetaAd,
    };
    await app.close();
    app = await createApp({
      store,
      vault,
      providers: new ProviderRegistry([provider]),
      disableAuth: true,
    });
    const payload = {
      idempotencyKey: "api-meta-create-0001",
      campaignName: "Sandbox Campaign",
      adSetName: "Sandbox Ad Set",
      creativeName: "Sandbox Creative",
      adName: "Sandbox Ad",
      objective: "OUTCOME_TRAFFIC",
      optimizationGoal: "LINK_CLICKS",
      billingEvent: "IMPRESSIONS",
      destinationType: "WEBSITE",
      dailyBudgetMinorUnits: 500,
      countries: ["US"],
      destinationUrl: "https://example.com/product",
      primaryText: "Primary text",
      headline: "Headline",
      description: "",
      callToAction: "LEARN_MORE",
      imageHash: null,
    } as const;
    const first = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/meta-creations`,
      payload,
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/meta-creations`,
      payload,
    });
    const conflictingReplay = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/meta-creations`,
      payload: { ...payload, headline: "Different request under the same key" },
    });
    const twoLevel = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/meta-creations`,
      payload: {
        targetLevel: "ad-set",
        idempotencyKey: "api-meta-create-two-level-0002",
        campaignName: payload.campaignName,
        adSetName: payload.adSetName,
        objective: payload.objective,
        optimizationGoal: payload.optimizationGoal,
        billingEvent: payload.billingEvent,
        destinationType: payload.destinationType,
        dailyBudgetMinorUnits: payload.dailyBudgetMinorUnits,
        countries: payload.countries,
      },
    });
    const listed = await app.inject({
      method: "GET",
      url: `/api/accounts/${account.id}/meta-creations`,
    });
    const missingRetry = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/meta-creations/00000000-0000-4000-8000-000000000000/retry`,
    });
    const automationRun = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/automation/run`,
    });
    const unknown = store.createMetaCreationTask(account.id, {
      ...payload,
      idempotencyKey: "api-meta-create-unknown-0002",
    });
    store.claimMetaCreationTask(unknown.id);
    store.updateMetaCreationProgress(unknown.id, {
      phase: "ad-set",
      campaignId: "120000000000201",
      adSetId: "120000000000202",
      message: "ad set confirmed",
    });
    store.completeMetaCreationTask(unknown.id, "unknown", "creative readback unknown");
    const reconciled = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/meta-creations/${unknown.id}/reconcile`,
    });

    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      status: "succeeded",
      phase: "completed",
      input: { targetLevel: "ad" },
      campaignId: "120000000000101",
      adSetId: "120000000000102",
      creativeId: "120000000000103",
      adId: "120000000000104",
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(first.json().id);
    expect(conflictingReplay.statusCode).toBe(409);
    expect(conflictingReplay.json()).toMatchObject({
      error: "META_CREATION_IDEMPOTENCY_CONFLICT",
    });
    expect(twoLevel.statusCode).toBe(201);
    expect(twoLevel.json()).toMatchObject({
      status: "succeeded",
      phase: "completed",
      input: { targetLevel: "ad-set" },
      campaignId: "120000000000101",
      adSetId: "120000000000102",
      creativeId: null,
      adId: null,
    });
    expect(createMetaAd).toHaveBeenCalledTimes(2);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(2);
    expect(missingRetry.statusCode).toBe(404);
    expect(automationRun.statusCode).toBe(200);
    expect(automationRun.json()).toMatchObject({
      accountId: account.id,
      automatic: true,
      candidateCount: 0,
      actionCount: 0,
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toMatchObject({
      status: "failed",
      phase: "ad-set",
      campaignId: "120000000000201",
      adSetId: "120000000000202",
    });
    expect(reconcileMetaAd).toHaveBeenCalledTimes(1);
  });

  it("keeps every launch and copy entry point fail-closed for Meta accounts", async () => {
    const account = createMetaOfflineAccount();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Meta offline launch tests must not use the network"),
    );
    const copyPreviewSpy = vi.spyOn(LaunchService.prototype, "createCopyPreview");
    const sameAccountSpy = vi.spyOn(LaunchService.prototype, "copyAdGroupWithinAccount");
    const campaignCopySpy = vi.spyOn(LaunchService.prototype, "copyCampaign");
    const batchExpandSpy = vi.spyOn(LaunchService.prototype, "batchExpandAdGroups");
    const executeSpy = vi.spyOn(LaunchService.prototype, "execute");
    const retrySpy = vi.spyOn(LaunchService.prototype, "retryItem");
    const launchRow = apiLaunchRow(2);
    const planPayload = {
      mode: "single" as const,
      sourceAccountId: account.id,
      sourceAdGroupId: null,
      targetAccountIds: [account.id],
      launchPresetId: "default-launch-preset",
      launchRows: [launchRow],
    };
    const plansBefore = store.listMultiAccountLaunchPlans(10_000);

    const createPlan = await app.inject({
      method: "POST",
      url: "/api/launch-plans",
      payload: planPayload,
    });
    const copyPreview = await app.inject({
      method: "POST",
      url: "/api/launch-plans/copy-preview",
      payload: {
        sourceAccountId: account.id,
        sourceAdGroupId: "source-group",
        targetAccountIds: [account.id],
        launchPresetId: "default-launch-preset",
        launchRows: [launchRow],
      },
    });
    const sameAccount = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/ad-groups/copy-same-account`,
      payload: {
        sourceCampaignId: "source-campaign",
        sourceCampaignName: "source",
        sourceAdGroupId: "source-group",
        baseAdGroupName: "copy",
        count: 1,
        dailyBudget: 10,
        bid: null,
        launchImmediately: false,
        sameCampaign: true,
      },
    });
    const campaignCopy = await app.inject({
      method: "POST",
      url: "/api/campaigns/copy",
      payload: {
        accountId: account.id,
        sources: [{ sourceCampaignId: "source-campaign", sourceAdGroupIds: ["source-group"] }],
        campaignCopies: 1,
        groupsPerCampaign: 1,
        initialStatus: "disabled",
      },
    });
    const batchExpand = await app.inject({
      method: "POST",
      url: "/api/ad-groups/batch-expand",
      payload: {
        sources: [{
          accountId: account.id,
          sourceCampaignId: "source-campaign",
          sourceCampaignName: "source",
          sourceAdGroupId: "source-group",
          sourceAdGroupName: "source group",
        }],
        count: 1,
        dailyBudget: 10,
        bid: null,
        launchImmediately: false,
        sameCampaign: true,
      },
    });

    expect([
      createPlan.statusCode,
      copyPreview.statusCode,
      sameAccount.statusCode,
      campaignCopy.statusCode,
      batchExpand.statusCode,
    ]).toEqual([409, 409, 409, 409, 409]);
    expect(store.listMultiAccountLaunchPlans(10_000)).toEqual(plansBefore);

    const persistedPlan = store.createMultiAccountLaunchPlan(planPayload);
    const planBefore = store.getMultiAccountLaunchPlan(persistedPlan.id);
    const itemsBefore = store.listLaunchPlanItems(persistedPlan.id);
    const execute = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${persistedPlan.id}/execute`,
    });
    const queue = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${persistedPlan.id}/queue`,
    });
    const retry = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${persistedPlan.id}/items/${itemsBefore[0]!.itemId}/retry`,
    });
    const resetCopyTask = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/campaign-copy-tasks/offline-task/reset`,
    });

    expect([execute.statusCode, queue.statusCode, retry.statusCode, resetCopyTask.statusCode])
      .toEqual([409, 409, 409, 409]);
    expect(store.getMultiAccountLaunchPlan(persistedPlan.id)).toEqual(planBefore);
    expect(store.listLaunchPlanItems(persistedPlan.id)).toEqual(itemsBefore);
    expect({
      copyPreviewCalls: copyPreviewSpy.mock.calls.length,
      sameAccountCalls: sameAccountSpy.mock.calls.length,
      campaignCopyCalls: campaignCopySpy.mock.calls.length,
      batchExpandCalls: batchExpandSpy.mock.calls.length,
      executeCalls: executeSpy.mock.calls.length,
      retryCalls: retrySpy.mock.calls.length,
      networkCalls: fetchMock.mock.calls.length,
    }).toEqual({
      copyPreviewCalls: 0,
      sameAccountCalls: 0,
      campaignCopyCalls: 0,
      batchExpandCalls: 0,
      executeCalls: 0,
      retryCalls: 0,
      networkCalls: 0,
    });
  });

  it("rejects Meta automation preview and run without persisting runs", async () => {
    const account = createMetaOfflineAccount();

    const preview = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/automation/preview`,
    });
    const run = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/automation/run`,
    });

    expect({
      statuses: [preview.statusCode, run.statusCode],
      runs: store.listAutomationRuns(account.id),
    }).toEqual({ statuses: [409, 409], runs: [] });
  });

  it("rejects Meta entity status writes without creating an operation", async () => {
    const account = createMetaOfflineAccount();
    seedMetaOfflineAdGroup(account.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/entities/status`,
      payload: { entityType: "ad-group", externalId: "meta-group-1", action: "disable" },
    });

    expect({ status: response.statusCode, operations: store.listAdOperations(account.id) })
      .toEqual({ status: 409, operations: [] });
  });

  it("rejects Meta ignore writes without creating ignore or operation records", async () => {
    const account = createMetaOfflineAccount();
    seedMetaOfflineAdGroup(account.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/entities/ad-group/meta-group-1/ignore`,
      payload: { reason: "Meta offline boundary" },
    });

    expect({
      status: response.statusCode,
      ignored: store.listIgnoredEntities(account.id, "meta-offline"),
      operations: store.listAdOperations(account.id),
    }).toEqual({ status: 409, ignored: [], operations: [] });
  });

  it("rejects Meta one-time schedules without persisting a schedule", async () => {
    const account = createMetaOfflineAccount();
    seedMetaOfflineAdGroup(account.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/schedules/once`,
      payload: {
        externalId: "meta-group-1",
        action: "disable",
        runAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    expect({ status: response.statusCode, schedules: store.listScheduledActions(account.id) })
      .toEqual({ status: 409, schedules: [] });
  });

  it("rejects Meta overnight schedules without persisting either schedule", async () => {
    const account = createMetaOfflineAccount();
    seedMetaOfflineAdGroup(account.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/schedules/overnight`,
      payload: {
        externalId: "meta-group-1",
        disableAt: new Date(Date.now() + 60_000).toISOString(),
        enableAt: new Date(Date.now() + 120_000).toISOString(),
      },
    });

    expect({ status: response.statusCode, schedules: store.listScheduledActions(account.id) })
      .toEqual({ status: 409, schedules: [] });
  });

  it("rejects retrying a Meta status task without changing the failed task", async () => {
    const account = createMetaOfflineAccount();
    const task = store.createStatusWriteTask({
      accountId: account.id,
      providerKind: "meta-offline",
      entityType: "ad-group",
      externalId: "meta-group-1",
      entityName: "Meta 离线广告组",
      action: "disable",
      source: "manual",
    }, { id: "offline-test", name: "Offline Test", kind: "user" });
    store.claimStatusWriteTask(task.id, "offline-executor");
    store.completeStatusWriteTask(task.id, "offline-executor", "failed", "offline boundary");

    const response = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/status-operations/${task.operationId}/retry`,
    });

    expect({
      status: response.statusCode,
      taskStatus: store.getAdOperation(task.id).status,
      operationCount: store.listAdOperations(account.id).length,
    }).toEqual({ status: 409, taskStatus: "failed", operationCount: 1 });
  });

  it("rejects verifying a Meta status task without changing the unknown task", async () => {
    const account = createMetaOfflineAccount();
    const task = store.createStatusWriteTask({
      accountId: account.id,
      providerKind: "meta-offline",
      entityType: "ad-group",
      externalId: "meta-group-1",
      entityName: "Meta 离线广告组",
      action: "disable",
      source: "manual",
    }, { id: "offline-test", name: "Offline Test", kind: "user" });
    store.claimStatusWriteTask(task.id, "offline-executor");
    store.completeStatusWriteTask(task.id, "offline-executor", "unknown", "offline boundary");

    const response = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/status-operations/${task.operationId}/verify`,
      payload: {
        decision: "confirmed-succeeded",
        observedStatus: "disabled",
        evidence: "Meta offline verification must be rejected",
        note: "offline boundary",
      },
    });

    expect({
      status: response.statusCode,
      taskStatus: store.getAdOperation(task.id).status,
      verificationCount: store.listStatusWriteTaskVerifications(task.id).length,
    }).toEqual({ status: 409, taskStatus: "unknown", verificationCount: 0 });
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

  it("keeps the account retriable when encrypted credential deletion fails", async () => {
    await app.inject({
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
    await app.inject({
      method: "PUT",
      url: "/api/accounts/demo-account/connections/cookie/credential",
      payload: { kind: "cookie", cookie: "sessionid=delete-failure", csrfHeaderName: "x-csrftoken" },
    });
    const reference = store.getProviderConnection("demo-account", "cookie")?.credentialRef;
    expect(reference).toBeTruthy();
    store.saveProviderConnectionSettings("demo-account", { kind: "official-api", advertiserId: "123" });
    const secondReference = await vault.create(JSON.stringify({ kind: "official-api", accessToken: "test-access-token" }));
    store.setProviderCredentialReference("demo-account", "official-api", secondReference);
    const originalDelete = vault.delete.bind(vault);
    let deleteCount = 0;
    vi.spyOn(vault, "delete").mockImplementation(async (credentialReference) => {
      deleteCount += 1;
      if (deleteCount === 2) throw new Error("vault unavailable");
      await originalDelete(credentialReference);
    });

    const response = await app.inject({ method: "DELETE", url: "/api/accounts/demo-account" });

    expect(response.statusCode).toBe(409);
    expect(store.getAccount("demo-account")).not.toBeNull();
    expect(store.getProviderConnection("demo-account", "cookie")?.credentialRef).toBe(reference);
    await expect(vault.read(reference!)).resolves.not.toBeNull();
    await expect(vault.read(secondReference)).resolves.not.toBeNull();
  });

  it("deletes account launch history by default", async () => {
    const other = store.createAccount({
      displayName: "保留账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdGroupId: null,
      targetAccountIds: ["demo-account", other.id],
      launchPresetId: "default-launch-preset",
      launchRows: [apiLaunchRow(2)],
    });

    const response = await app.inject({ method: "DELETE", url: "/api/accounts/demo-account" });

    expect(response.statusCode).toBe(204);
    expect(store.getAccount("demo-account")).toBeNull();
    expect(store.getMultiAccountLaunchPlan(plan.id)).toBeNull();
    expect(store.listLaunchPlanItems(plan.id)).toHaveLength(0);
    expect(store.getAccount(other.id)).toMatchObject({ displayName: "保留账户" });
  });

  it("deletes active account status tasks with the account", async () => {
    const task = store.createStatusWriteTask({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "group-1",
      entityName: "测试广告组",
      action: "disable",
      source: "manual",
    }, { id: "reviewer", name: "测试用户", kind: "user" });

    const response = await app.inject({ method: "DELETE", url: "/api/accounts/demo-account" });

    expect(response.statusCode).toBe(204);
    expect(store.getAccount("demo-account")).toBeNull();
    expect(() => store.getAdOperation(task.id)).toThrow("广告操作记录不存在");
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
      enabled: true,
    });
    expect(store.listAccounts()).toHaveLength(2);
  });

  it("creates a validated spreadsheet launch plan", async () => {
    const now = new Date().toISOString();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      [{ entityType: "ad", externalId: "source-ad", payload: { ad_name: "源广告" } }],
      { startedAt: now, finishedAt: now, counts: { campaign: 0, "ad-group": 0, ad: 1, material: 0 }, warnings: [], quality: testSyncQuality(now) },
    );
    const target = store.createAccount({ displayName: "目标", accountType: "standard", enabled: true, providerKind: "cookie" });
    const response = await app.inject({
      method: "POST",
      url: "/api/launch-plans",
      payload: {
        sourceAccountId: "demo-account",
        mode: "single",
        sourceAdGroupId: null,
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
      store.updateProviderAuthorization(accountId, "cookie", {
        status: "active",
        capabilityVersion: new ProviderRegistry().capabilityVersion("cookie"),
        capabilities: ["read-campaigns", "read-ad-groups", "read-ads", "read-reports", "create-campaigns", "copy-ads"],
      });
      const syncAt = new Date().toISOString();
      store.saveReadOnlySync(accountId, "cookie", [], {
        startedAt: syncAt,
        finishedAt: syncAt,
        counts: { campaign: 0, "ad-group": 0, ad: 0, material: 0 },
        warnings: [],
        quality: testSyncQuality(syncAt),
      });
    }
    const cookies: string[] = [];
    const publishedCookies = new Set<string>();
    const publishedAdNames = new Map<string, string>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const cookie = new Headers(init?.headers).get("cookie");
      if (cookie) cookies.push(cookie);
      if (url.includes("creative_snap/save") && cookie) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          asset_group_sketch_form_data_list?: Array<{ creative_name?: string }>;
        };
        const creativeName = body.asset_group_sketch_form_data_list?.[0]?.creative_name;
        if (creativeName) publishedAdNames.set(cookie, creativeName);
      }
      if (url.includes("create_by_snap") && cookie) publishedCookies.add(cookie);
      const published = cookie ? publishedCookies.has(cookie) : false;
      const data = url.includes("statistics/sketch/")
        ? { table: [], pagination: { page: 1, page_count: 0, total_count: 0, limit: 100 } }
        : url.includes("/statistics/op/campaign/list")
          ? { table: published ? [{ campaign_id: "campaign", campaign_name: "测试系列" }] : [], pagination: { page: 1, page_count: 1, total_count: published ? 1 : 0 } }
        : url.includes("/statistics/op/adgroup/list")
          ? { table: published ? [{ campaign_id: "campaign", ad_id: "adgroup", ad_name: "测试广告组" }] : [], pagination: { page: 1, page_count: 1, total_count: published ? 1 : 0 } }
        : url.includes("/statistics/op/ad/list")
          ? { table: published ? [{ campaign_id: "campaign", ad_id: "adgroup", creative_id: "ad", creative_name: publishedAdNames.get(cookie ?? "") }] : [], pagination: { page: 1, page_count: 1, total_count: published ? 1 : 0 } }
        // 发布前从 sketch 重铸整棵树的 snap，发布引用重铸出来的那套。
        : url.includes("snap/save_by_sketch")
         ? {
             campaign_sketch_id_to_snap_id: { "campaign-sketch": "campaign-snap-reminted" },
             ad_sketch_id_to_snap_id: { "ad-sketch": "ad-snap-reminted" },
             creative_sketch_id_to_snap_id: { "creative-sketch": "creative-snap-reminted" },
           }
        : url.includes("campaign_snap/save")
         ? { campaign_snap_id: "campaign-snap", campaign_sketch_id: "campaign-sketch" }
        : url.includes("campaign_snap/check")
          ? { success: true, fake_campaign_id: "campaign-sketch" }
         : url.includes("ad_snap/save")
           ? { ad_snap_id: "ad-snap", ad_sketch_id: "ad-sketch" }
          : url.includes("ad_snap/bulk_check")
            ? { ad_snap_check_report_map: { "ad-snap": { success: true, ad_snap_id: "ad-snap", fake_ad_id: "ad-sketch" } } }
           : url.includes("creative_snap/save")
             ? { creative_snap_id: "creative-snap", creative_sketch_id: "creative-sketch" }
            : url.includes("ad_creative_snap/check")
              ? { creative_success: true, ad_snap_check_report_map: { "ad-snap": { success: true, ad_snap_id: "ad-snap", fake_ad_id: "ad-sketch" } } }
            : url.includes("creative_snap/check")
              ? { success: true }
            : url.includes("cbo_consistency_check")
              ? { is_all_success: true }
            : url.includes("batch_create_cta_id")
              ? { cta_id_map: {} }
             : url.includes("create_by_snap")
              ? { async_request_id: "async" }
              : url.includes("async_creation/detail")
                ? { status: 1, result: { campaign_id: "campaign", ad_and_creative: { 0: { by_ad_snap_id: "ad-snap", ad_id: "adgroup", asset_group_result: { 0: { creative_items: [{ id: "ad" }] } } } } } }
              : { list: [], pagination: { page: 1, page_count: 1 } };
      return new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const created = await app.inject({ method: "POST", url: "/api/launch-plans", payload: {
      mode: "multi", sourceAccountId: "demo-account", sourceAdGroupId: null,
      targetAccountIds: ["demo-account", second.id], launchPresetId: "default-launch-preset",
      launchRows: [{ rowNumber: 2, campaignName: "测试系列", adGroupName: "测试广告组", adName: "260716:001", videoCode: "same-video-code", productUrl: "https://example.com/product", region: "US", dailyBudget: 1, bid: null, startAt: null, endAt: null, initialStatus: "disabled" }],
    } });
    expect(created.statusCode).toBe(201);
    const executed = await app.inject({ method: "POST", url: `/api/launch-plans/${created.json().id}/execute` });

    expect(executed.statusCode, executed.body).toBe(200);
    expect(executed.json().plan, JSON.stringify(executed.json(), null, 2)).toMatchObject({ status: "completed", executionResults: [{ accountId: "demo-account", ok: true, createdCount: 1, failedCount: 0 }, { accountId: second.id, ok: true, createdCount: 1, failedCount: 0 }] });
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

  it("keeps the launch worker fully disabled in an isolated test app", async () => {
    await app.close();
    const start = vi.spyOn(LaunchWorker.prototype, "start");
    const stop = vi.spyOn(LaunchWorker.prototype, "stop");
    app = await createApp({
      store,
      vault,
      disableAuth: true,
      startLaunchWorker: false,
    });

    expect(start).not.toHaveBeenCalled();
    const queued = await app.inject({
      method: "POST",
      url: "/api/launch-plans/not-present/queue",
    });
    expect(queued.statusCode).toBe(503);
    expect(queued.json()).toEqual({
      message: "当前隔离测试环境已关闭后台创建队列。",
    });
    expect(store.listQueuedLaunchPlans()).toEqual([]);

    await app.close();
    expect(stop).not.toHaveBeenCalled();
  });

  it("queues creation while the automation master switch is off", async () => {
    const planId = await installLaunchTestProvider(
      async (_context, mutations) => mutations.map((mutation) => ({ ...mutation, ok: true, campaignId: "c", adGroupId: "g", adId: "a", message: "created" })),
      [apiLaunchRow(2)],
    );
    store.updateSystemRuntimeState({ enabled: false });

    const queued = await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/queue` });

    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ queued: true, plan: { id: planId } });
    await vi.waitFor(() => expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({ status: "succeeded" }));
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
        counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
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
    const manualTakeovers = await app.inject({
      method: "GET",
      url: "/api/accounts/demo-account/manual-takeovers",
    });
    const restoreAll = await app.inject({
      method: "DELETE",
      url: "/api/accounts/demo-account/manual-takeovers",
    });
    const restoredEntities = await app.inject({
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
    expect(manualTakeovers.json()).toEqual([
      expect.objectContaining({ externalId: "adgroup-1", reason: "人工排除" }),
    ]);
    expect(restoreAll.json()).toEqual({ restoredCount: 1 });
    expect(restoredEntities.json()[0]).toMatchObject({
      externalId: "adgroup-1",
      ignored: false,
    });
    expect(latestSync.json()).toMatchObject({
      counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
      warnings: [],
      quality: testSyncQuality(now),
    });
  });

  it("excludes entities omitted by the latest healthy sync", async () => {
    const firstAt = new Date(Date.now() - 60_000).toISOString();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      [{
        entityType: "ad-group",
        externalId: "stale-adgroup",
        payload: { ad_name: "已关闭广告组", ad_primary_status: "pending" },
      }],
      {
        startedAt: firstAt,
        finishedAt: firstAt,
        counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
        warnings: [],
        quality: testSyncQuality(firstAt),
      },
    );

    const latestAt = new Date().toISOString();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      [{
        entityType: "ad-group",
        externalId: "current-adgroup",
        payload: { ad_name: "当前广告组", ad_primary_status: "enable" },
      }],
      {
        startedAt: latestAt,
        finishedAt: latestAt,
        counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
        warnings: [],
        quality: testSyncQuality(latestAt),
      },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/accounts/demo-account/entities",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().map((entity: { externalId: string }) => entity.externalId))
      .toEqual(["current-adgroup"]);
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
      { startedAt: capturedAt, finishedAt: capturedAt, counts: { campaign: 0, "ad-group": 2, ad: 0, material: 0 }, warnings: [], quality: testSyncQuality(capturedAt) },
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

  it("exposes daily usage and the provider write-circuit reset", async () => {
    const initial = await app.inject({
      method: "GET",
      url: "/api/accounts/demo-account/write-circuit",
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      todayUsage: 0,
      circuit: null,
    });

    store.recordProviderWriteFailure("demo-account", "cookie", "one");
    store.recordProviderWriteFailure("demo-account", "cookie", "two");
    store.recordProviderWriteFailure("demo-account", "cookie", "three");
    const reset = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/write-circuit/reset",
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

  it("executes creation while the automation master switch is off", async () => {
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

    expect(response.statusCode).toBe(200);
    expect(createFromPreset).toHaveBeenCalledTimes(1);
    expect(store.listLaunchPlanItems(planId)[0]?.status).toBe("succeeded");
  });

  it("allows a manual status change while the automation master switch is off", async () => {
    const changeStatus = vi.fn<NonNullable<AdsProvider["changeStatus"]>>(async (_context, mutations) =>
      mutations.map((mutation) => ({ ...mutation, ok: true, message: "ok" })),
    );
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
      async () => {
        const finishedAt = new Date().toISOString();
        return {
          entities: [{
            entityType: "ad-group" as const,
            externalId: "adgroup-1",
            payload: { status: "DISABLE" },
          }],
          result: {
            startedAt: finishedAt,
            finishedAt,
            counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
            warnings: [],
            quality: testSyncQuality(finishedAt),
          },
        };
      },
      undefined,
      changeStatus,
    );
    const syncedAt = new Date().toISOString();
    store.saveReadOnlySync("demo-account", "cookie", [{
      entityType: "ad-group",
      externalId: "adgroup-1",
      payload: { status: "ENABLE" },
    }], {
      startedAt: syncedAt,
      finishedAt: syncedAt,
      counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
      warnings: [],
      quality: testSyncQuality(syncedAt),
    });
    store.updateSystemRuntimeState({ enabled: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/entities/status",
      payload: { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
    });

    expect(response.statusCode, response.body).toBe(200);
    await vi.waitFor(() => expect(changeStatus).toHaveBeenCalledTimes(1));
    expect(store.listAdOperations("demo-account")[0]).toMatchObject({
      action: "disable",
      source: "manual",
    });
  });

  it("allows an explicitly requested launch while account automation is disabled", async () => {
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
    const account = store.getAccount("demo-account")!;
    store.updateAccountSettings("demo-account", {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: false,
      providerKind: account.providerKind,
    });

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
    expect(store.getAccount("demo-account")?.enabled).toBe(true);
    expect(store.getProviderConnection("demo-account", "cookie")?.status).toBe("failed");
  });

  it("persists ad-group success when the provider skips a missing material", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "campaign-created",
        adGroupId: "group-created",
        warning: "素材提示：广告组已创建成功；已跳过 1 条素材。",
        message: "ad group created",
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
          ],
          result: {
            startedAt: finishedAt,
            finishedAt,
            counts: { campaign: 1, "ad-group": 1, ad: 0, material: 0 },
            warnings: [],
            quality: testSyncQuality(finishedAt),
          },
        };
      },
    );

    const executed = await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    const item = store.listLaunchPlanItems(planId)[0];

    expect(executed.statusCode).toBe(200);
    expect(executed.json().results[0]).toMatchObject({
      status: "succeeded",
      syncWarning: expect.stringContaining("已跳过 1 条素材"),
    });
    expect(item).toMatchObject({
      status: "succeeded",
      campaignId: "campaign-created",
      adGroupId: "group-created",
      adId: null,
      syncWarning: expect.stringContaining("已跳过 1 条素材"),
    });
  });

  it("does not consult the automation write-failure counter after confirmed creation", async () => {
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
    const resetFailureCounter = vi.spyOn(store, "resetProviderWriteFailures").mockImplementationOnce(() => {
      throw new Error("cleanup unavailable");
    });

    const executed = await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });

    expect(executed.statusCode).toBe(200);
    expect(executed.json().results[0]).toMatchObject({
      status: "succeeded",
      syncWarning: null,
    });
    expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({ status: "succeeded" });
    expect(resetFailureCounter).not.toHaveBeenCalled();
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
          counts: { campaign: 0, "ad-group": 0, ad: 0, material: 0 },
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
    expect(store.getAccount("demo-account")?.enabled).toBe(true);
  });

  it("keeps creation succeeded and account automation unchanged on non-healthy readback quality", async () => {
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
            counts: { campaign: 1, "ad-group": 1, ad: 1, material: 0 },
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
    expect(store.getAccount("demo-account")?.enabled).toBe(true);
  });

  it("records direct connection test failure without changing account automation", async () => {
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
    expect(store.getAccount("demo-account")?.enabled).toBe(true);
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

    const matrix = await app.inject({
      method: "GET",
      url: "/api/accounts/demo-account/connection-capabilities",
    });
    expect(matrix.statusCode).toBe(200);
    expect(matrix.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerKind: "cookie",
        capabilityVersion: "launch-test-v1",
        capabilities: expect.arrayContaining([
          expect.objectContaining({ capability: "create-campaigns", available: true }),
        ]),
      }),
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

  it("records direct synchronization failure without changing account automation", async () => {
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
    expect(store.getAccount("demo-account")?.enabled).toBe(true);
    expect(store.getProviderConnection("demo-account", "cookie")?.status).toBe("failed");
  });

  it("returns an actionable conflict when direct synchronization uses a stale capability contract", async () => {
    store.saveProviderConnectionSettings("demo-account", {
      kind: "cookie",
      advertiserId: "123",
      healthUrl: "",
      campaignsUrl: "",
      adGroupsUrl: "",
      adsUrl: "",
    });
    const credentialRef = await vault.create(JSON.stringify({
      kind: "cookie",
      cookie: "sessionid=test-cookie",
      csrfHeaderName: "x-csrftoken",
    }));
    store.setProviderCredentialReference("demo-account", "cookie", credentialRef);
    store.updateProviderStatus("demo-account", "cookie", "ready", "ready");
    store.updateProviderAuthorization("demo-account", "cookie", {
      status: "active",
      capabilityVersion: "stale-cookie-capabilities",
      capabilities: ["read-campaigns"],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/connections/cookie/sync",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      message: "Provider 能力契约已更新，请重新检测连接。",
    });
  });

  it("keeps account automation unchanged when direct synchronization is non-healthy without warnings", async () => {
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
          counts: { campaign: 0, "ad-group": 0, ad: 0, material: 0 },
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
    expect(store.getAccount("demo-account")?.enabled).toBe(true);
  });

  it("keeps a provider result with incomplete IDs unknown and does not resend it", async () => {
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
      errorMessage: expect.stringContaining("真实结果仍需远端核验"),
    });
  });

  it("keeps an exception after provider dispatch unknown and makes explicit retry read-only", async () => {
    const createFromPreset = vi.fn(async (_context: ProviderContext, _mutations: CreationMutation[]) => {
      throw new Error("connection reset after request dispatch");
    });
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);

    await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    const failedItem = store.listLaunchPlanItems(planId)[0]!;
    const retry = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/items/${failedItem.itemId}/retry`,
    });

    expect(createFromPreset).toHaveBeenCalledTimes(2);
    expect(createFromPreset.mock.calls[1]?.[1]?.[0]).toMatchObject({ reconcileOnly: true });
    expect(retry.statusCode).toBe(200);
    expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({
      status: "unknown",
      attemptCount: 2,
      errorMessage: "connection reset after request dispatch",
    });
  });

  it("changes an unknown item to a correctable failure when read-only recheck proves nothing was created", async () => {
    const createFromPreset = vi.fn(async (_context: ProviderContext, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => mutation.reconcileOnly
        ? {
            ...mutation,
            ok: false,
            failureKind: "retryable",
            retrySafe: true,
            reconciliationVerifiedAbsent: true,
            message: "Cookie 正式列表和草稿列表均确认本条未创建",
          }
        : {
            ...mutation,
            ok: false,
            failureKind: "unknown",
            retrySafe: false,
            message: "响应在发布后丢失",
          }),
    );
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);

    await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    const unknownItem = store.listLaunchPlanItems(planId)[0]!;
    const rechecked = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/items/${unknownItem.itemId}/retry`,
    });

    expect(rechecked.statusCode).toBe(200);
    expect(createFromPreset).toHaveBeenCalledTimes(2);
    expect(createFromPreset.mock.calls[1]?.[1]?.[0]).toMatchObject({ reconcileOnly: true });
    expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({
      status: "failed",
      attemptCount: 2,
      errorMessage: "Cookie 正式列表和草稿列表均确认本条未创建",
    });
  });

  it("keeps an unknown item unknown when read-only reconciliation is inconclusive", async () => {
    const createFromPreset = vi.fn(async (_context: ProviderContext, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => mutation.reconcileOnly
        ? {
            ...mutation,
            ok: false,
            failureKind: "retryable",
            retrySafe: true,
            message: "adgroup/list timed out during read-only reconciliation",
          }
        : {
            ...mutation,
            ok: false,
            failureKind: "unknown",
            retrySafe: false,
            message: "response lost after publish",
          }),
    );
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);

    await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    const unknownItem = store.listLaunchPlanItems(planId)[0]!;
    await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/items/${unknownItem.itemId}/retry`,
    });

    expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({
      status: "unknown",
      attemptCount: 2,
      errorMessage: "adgroup/list timed out during read-only reconciliation",
    });
  });

  it("keeps a provider-declared pre-dispatch exception as a correctable failure", async () => {
    const createFromPreset = vi.fn(async (_context: ProviderContext, _mutations: CreationMutation[]) => {
      throw new RetryableCreationError("创建配置无效，尚未发送请求");
    });
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);

    await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    const failedItem = store.listLaunchPlanItems(planId)[0]!;

    expect(createFromPreset).toHaveBeenCalledTimes(1);
    expect(failedItem).toMatchObject({
      status: "failed",
      attemptCount: 1,
      errorMessage: "创建配置无效，尚未发送请求",
    });
  });

  it("keeps a draft-only provider rejection non-retryable without blocking sibling results", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => mutation.row.rowNumber === 3
        ? {
            ...mutation,
            ok: false,
            failureKind: "retryable",
            retrySafe: false,
            message: "TikTok 明确失败，只留下草稿",
          }
        : {
            ...mutation,
            ok: true,
            campaignId: "campaign-created",
            adGroupId: `group-${mutation.row.rowNumber}`,
            adId: `ad-${mutation.row.rowNumber}`,
            message: "created",
          }),
    );
    const rows = [apiLaunchRow(2), apiLaunchRow(3), apiLaunchRow(4)].map((row) => ({
      ...row,
      campaignName: "same-campaign",
    }));
    const planId = await installLaunchTestProvider(createFromPreset, rows);

    const executed = await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    const items = store.listLaunchPlanItems(planId);

    expect(executed.statusCode).toBe(200);
    expect(createFromPreset).toHaveBeenCalledTimes(1);
    expect(createFromPreset.mock.calls[0]![1]).toHaveLength(3);
    expect(items.map((item) => item.status)).toEqual(["succeeded", "unknown", "succeeded"]);
    expect(executed.json().plan.executionResults[0]).toMatchObject({
      createdCount: 2,
      failedCount: 0,
      unknownCount: 1,
    });
  });

  it("runs different campaign batches serially within one target account", async () => {
    let activeBatches = 0;
    let maxActiveBatches = 0;
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) => {
      activeBatches += 1;
      maxActiveBatches = Math.max(maxActiveBatches, activeBatches);
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeBatches -= 1;
      return mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: `campaign-${mutation.row.campaignName}`,
        adGroupId: `group-${mutation.row.rowNumber}`,
        adId: `ad-${mutation.row.rowNumber}`,
        message: "created",
      }));
    });
    const rows = [2, 3, 4, 5, 6].map((rowNumber, index) => ({
      ...apiLaunchRow(rowNumber),
      campaignName: `series-${index + 1}`,
    }));
    const planId = await installLaunchTestProvider(createFromPreset, rows);

    const executed = await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });

    expect(executed.statusCode).toBe(200);
    expect(createFromPreset).toHaveBeenCalledTimes(5);
    expect(createFromPreset.mock.calls.every((call) => call[1].length === 1)).toBe(true);
    expect(maxActiveBatches).toBe(1);
    expect(store.listLaunchPlanItems(planId).map((item) => item.status))
      .toEqual(Array.from({ length: 5 }, () => "succeeded"));
  });

  it("retries only the local transaction after confirmed creation", async () => {
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
      status: "succeeded",
      attemptCount: 1,
      campaignId: "campaign-created",
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

  it("retries an unknown launch only after an explicit user request", async () => {
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
    const row = apiLaunchRow(2);
    const planId = await installLaunchTestProvider(createFromPreset, [row]);
    const item = store.listLaunchPlanItems(planId)[0]!;
    store.claimLaunchPlanItem(item.itemId, "interrupted-executor", "pending");
    const scopeOwner = `interrupted-executor:${item.itemId}`;
    expect(store.claimLaunchCreationScope(
      planId,
      "demo-account",
      row.campaignName,
      scopeOwner,
    )).not.toBeNull();
    store.markLaunchCreationScopeUncertain(
      planId,
      "demo-account",
      row.campaignName,
      scopeOwner,
    );
    store.completeLaunchPlanItemUnknown(
      item.itemId,
      "interrupted-executor",
      "response lost after dispatch",
    );

    const retry = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/items/${item.itemId}/retry`,
    });

    expect(retry.statusCode).toBe(200);
    expect(createFromPreset).toHaveBeenCalledTimes(1);
    expect(store.listLaunchPlanItems(planId)[0]).toMatchObject({
      status: "succeeded",
      attemptCount: 2,
      campaignId: "campaign-created",
    });
  });

  it("removes the launch manual-verification endpoints", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => {
        mutation.onProgress?.({
          phase: "validation",
          evidence: { resolvedAdGroupName: mutation.row.adGroupName },
        });
        return {
          ...mutation,
          ok: false,
          failureKind: "unknown",
          message: "response lost after dispatch",
        };
      }),
    );
    const planId = await installLaunchTestProvider(createFromPreset, [apiLaunchRow(2)]);
    await app.inject({ method: "POST", url: `/api/launch-plans/${planId}/execute` });
    const item = store.listLaunchPlanItems(planId)[0]!;

    const list = await app.inject({
      method: "GET",
      url: `/api/launch-plans/${planId}/items/${item.itemId}/verifications`,
    });
    const verify = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${planId}/items/${item.itemId}/verify`,
      payload: {
        evidence: "removed",
      },
    });

    expect(list.statusCode).toBe(404);
    expect(verify.statusCode).toBe(404);
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
      counts: { campaign: 0, "ad-group": 0, ad: 0, material: 0 },
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
        counts: { campaign: 0, "ad-group": 0, ad: 0, material: 0 },
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
      originalPosts: [expect.objectContaining({
        itemId: "post-1",
        identityId: expect.stringContaining("target-identity"),
        vid: expect.stringContaining("target-vid"),
      })],
    });
    expect(createFromPreset.mock.calls[0]?.[1][0]).not.toHaveProperty("templateCampaignId");
  });

  it("accepts object-specific original-post asset readback when the ordinary ad list is empty", async () => {
    const createFromPreset = vi.fn(async (_context, mutations: CreationMutation[]) =>
      mutations.map((mutation): CreationMutationResult => ({
        ...mutation,
        ok: true,
        campaignId: "new-campaign",
        adGroupId: "new-group",
        adId: "new-asset-group",
        message: "created and verified",
      })),
    );
    const fixture = await installCopyLaunchProvider(createFromPreset, true);
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

    const execution = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${plan.json().id}/execute`,
    });

    expect(execution.statusCode).toBe(200);
    expect(execution.json().results[0]).toMatchObject({
      status: "succeeded",
      syncWarning: null,
      created: [expect.objectContaining({ adId: "new-asset-group" })],
    });
    expect(store.listLaunchPlanItems(plan.json().id)[0]).toMatchObject({
      status: "succeeded",
      adId: "new-asset-group",
      syncWarning: null,
    });
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
    fixture.setRemoteSourceVideoCode("changed-source-post");

    const execution = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${plan.json().id}/execute`,
    });

    expect(execution.statusCode).toBe(200);
    expect(execution.json().results[0]).toMatchObject({ status: "failed" });
    expect(execution.json().results[0].message).toContain("源广告组帖子在预览后已变化");
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
    fixture.setRemoteTargetVideoCode("different-target-post");

    const execution = await app.inject({
      method: "POST",
      url: `/api/launch-plans/${plan.json().id}/execute`,
    });

    expect(execution.statusCode).toBe(200);
    expect(execution.json().results[0]).toMatchObject({ status: "failed" });
    expect(execution.json().results[0].message).toContain("目标账户无法继续使用帖子");
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
    changeStatus: NonNullable<AdsProvider["changeStatus"]> = async (_context, mutations) =>
      mutations.map((mutation) => ({ ...mutation, ok: true, message: "ok" })),
  ): Promise<string> {
    store.updateLaunchPreset("default-launch-preset", {
      name: "创建测试预设",
      region: "US",
      dailyBudget: 100,
      bid: null,
      startAt: null,
      endAt: null,
      initialStatus: "disabled",
      creationConfig: apiCreationConfig(),
    });
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
            material: 0,
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
    const syncAt = new Date().toISOString();
    store.saveReadOnlySync("demo-account", "cookie", [], {
      startedAt: syncAt,
      finishedAt: syncAt,
      counts: { campaign: 0, "ad-group": 0, ad: 0, material: 0 },
      warnings: [],
      quality: testSyncQuality(syncAt),
    });
    const provider: AdsProvider = {
      kind: "cookie",
      platform: "tiktok",
      implementationStatus: "available",
      displayName: "launch test provider",
      capabilityVersion: "launch-test-v1",
      capabilities: new Set(["read-campaigns", "create-campaigns", "copy-ads", "change-status"]),
      checkHealth,
      syncReadOnly: resolvedSyncReadOnly,
      changeStatus,
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
      sourceAdGroupId: null,
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
    ordinaryAdListEmptyAfterCreation = false,
  ): Promise<{
    input: {
      sourceAccountId: string;
      sourceAdGroupId: string;
      targetAccountIds: string[];
      launchPresetId: string;
      launchRows: ReturnType<typeof apiLaunchRow>[];
    };
    setRemoteSourceVideoCode: (videoCode: string) => void;
    setRemoteTargetVideoCode: (videoCode: string) => void;
  }> {
    store.updateLaunchPreset("default-launch-preset", {
      name: "复制测试预设",
      region: "US",
      dailyBudget: 100,
      bid: null,
      startAt: null,
      endAt: null,
      initialStatus: "disabled",
      creationConfig: apiCreationConfig(),
    });
    saveApiCopySource(store, "source-ad", "post-1");
    let remoteSourceVideoCode = "post-1";
    let remoteTargetVideoCode = "post-1";
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
      capabilities: ["read-campaigns", "read-ad-groups", "create-campaigns"],
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
    const syncAt = new Date().toISOString();
    store.saveReadOnlySync(target.id, "cookie", [{
      entityType: "ad",
      externalId: "target-asset-evidence",
      payload: { asset: { image_list: [{ aweme_item_id: "video-2" }] } },
    }], {
      startedAt: syncAt,
      finishedAt: syncAt,
      counts: { campaign: 0, "ad-group": 0, ad: 1, material: 0 },
      warnings: [],
      quality: testSyncQuality(syncAt),
    });
    const provider: AdsProvider = {
      kind: "cookie",
      platform: "tiktok",
      implementationStatus: "available",
      displayName: "copy test provider",
      capabilityVersion: "copy-test-v1",
      capabilities: new Set(["read-campaigns", "read-ad-groups", "create-campaigns"]),
      checkHealth: async () => ({ ok: true, status: "ready", message: "ready" }),
      readAdGroupOriginalPosts: async (_context, input) => {
        if (input.campaignId !== "source-campaign" || input.adGroupId !== "source-group") {
          throw new Error("wrong source group");
        }
        return {
          posts: [{
            itemId: remoteSourceVideoCode,
            identityId: "source-identity",
            identityType: 2,
            identityBcId: "0",
            vid: `source-vid-${remoteSourceVideoCode}`,
            videoId: null,
            displayName: "source post",
            coverUrl: null,
            promotable: true,
          }],
          productUrl: "https://source.example/product",
          productInfo: null,
          catalogSetup: null,
        };
      },
      readAccessibleOriginalPosts: async (_context, sourcePosts) => sourcePosts.flatMap((sourcePost) =>
        sourcePost.itemId === remoteTargetVideoCode
          ? [{
              itemId: sourcePost.itemId,
              identityId: "target-identity",
              identityType: 2,
              identityBcId: "0",
              vid: `target-vid-${sourcePost.itemId}`,
              videoId: null,
              displayName: "target post",
              coverUrl: null,
              promotable: true,
            }]
          : []),
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
              counts: { campaign: 1, "ad-group": 1, ad: 1, material: 0 },
              warnings: [],
              quality: testSyncQuality(refreshedAt),
            },
          };
        }
        const entities = creationDispatched
          ? [
            { entityType: "campaign" as const, externalId: "new-campaign", payload: {} },
            { entityType: "ad-group" as const, externalId: "new-group", payload: {} },
            ...(!ordinaryAdListEmptyAfterCreation
              ? [{ entityType: "ad" as const, externalId: "new-ad", payload: {} }]
              : []),
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
              ? { campaign: 1, "ad-group": 1, ad: 1, material: 0 }
              : { campaign: 0, "ad-group": 0, ad: 1, material: 0 },
            warnings: creationDispatched && ordinaryAdListEmptyAfterCreation
              ? ["ad 响应成功，但暂未识别到列表数据。"]
              : [],
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
        sourceAdGroupId: "source-group",
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

function apiCreationConfig() {
  return {
    objectiveType: 1,
    buyingType: 1,
    campaignBudgetMode: 0,
    adBudgetMode: 0,
    pricing: 1,
    optimizeGoal: 1,
    externalAction: 1,
    pixelId: null,
    identityType: 1,
    identityId: "test-identity",
    callToActionId: "SHOP_NOW",
    countryCodes: [840],
    placementIds: [1],
    smartTargeting: true,
    commentDisabled: false,
    shareDisabled: false,
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
    counts: { campaign: 1, "ad-group": 1, ad: 1, material: 0 },
    warnings: [],
    quality: testSyncQuality(syncAt),
  });
}
