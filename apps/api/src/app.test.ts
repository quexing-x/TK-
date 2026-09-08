import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationRuleDefinitions } from "@tk-auto/core";
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
    vi.useRealTimers();
  });

  /**
   * 冻结时钟，供所有「同一批操作分成两次请求、断言它们被认成同一天/同一个任务」的
   * 用例使用。
   *
   * 系列复制与扩组的幂等 taskKey 都是对生成的副本名取的哈希，而副本名精确到秒
   * （`-MMDD-HHMMSS`）：两次请求只要落在不同的整秒里，本来就是两个不同的任务，
   * 第二次当然不会被跳过。同理，重复提交预检按账户本地日历日判「今天」，跨过午夜
   * 就不再是同一天。真实时钟下这类断言实际上依赖「两次 inject 恰好落在同一个秒/
   * 同一天里」——满载跑整个文件时第一次请求足够慢，跨边界就会偶发失败。
   *
   * 只冻 Date，定时器保持真实，避免 await 卡死；afterEach 统一恢复真实时钟。
   */
  function freezeClock() {
    vi.useFakeTimers({ toFake: ["Date"] });
  }

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
    expect(response.json().providers).toHaveLength(2);
    expect(response.json().providers.map((provider: { kind: string }) => provider.kind))
      .toEqual(["cookie", "official-api"]);
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
    freezeClock();
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
    freezeClock();
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
    freezeClock();
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

  it("publishes the draft an uncertain expansion left behind and closes the record", async () => {
    const publishExistingDrafts = vi.fn(async () => ({
      ok: true,
      message: "已发布 1 个草稿广告组",
      adGroupIds: ["published-1"],
    }));
    const provider = {
      kind: "cookie",
      displayName: "draft publish provider",
      capabilityVersion: "draft-publish-v1",
      capabilities: new Set(["copy-ads"]),
      publishExistingDrafts,
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
      status: "active", capabilityVersion: "draft-publish-v1", capabilities: ["copy-ads"],
    });
    store.claimAdGroupExpandTask("stuck-task", "demo-account", "adgroup-1", {
      sourceCampaignId: "campaign-1",
      requestedCount: 1,
      generatedNames: ["新组-0826-060000-1"],
    });
    store.finishAdGroupExpandTask("stuck-task", "unknown");
    await app.close();
    app = await createApp({ store, vault, providers: new ProviderRegistry([provider]), disableAuth: true });

    const response = await app.inject({
      method: "POST",
      url: "/api/ad-group-expand-tasks/stuck-task/publish-draft",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, adGroupIds: ["published-1"] });
    expect(publishExistingDrafts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      campaignId: "campaign-1",
      names: ["新组-0826-060000-1"],
      // 扩组本来就是为了投。发成暂停等于把最后一步换成「人必须记得去后台开一遍」，
      // 一忘就是一批建好却不投的组躺在后台。
      initialStatus: "enabled",
    }));
    // 收口：红条摘掉，记录保留成历史。
    expect(store.getUncertainAdGroupExpandTask("stuck-task")).toBeNull();
    const [task] = store.listAdGroupExpandHistory(["demo-account"], 10);
    expect(task).toMatchObject({ taskKey: "stuck-task", uncertain: false, status: "succeeded" });

    // 已经收口的记录不能再发一次，否则同一批组会被建成两份。
    const again = await app.inject({
      method: "POST",
      url: "/api/ad-group-expand-tasks/stuck-task/publish-draft",
    });
    expect(again.statusCode).toBe(404);
    expect(publishExistingDrafts).toHaveBeenCalledTimes(1);
  });

  /**
   * 部分成功的收口：终态回来「广告组 2/3」，2 个成了正式组、1 个停在草稿。
   *
   * 这里验的是那份「已经建成」名单怎么算出来的——它决定了哪几个可以跳过不发，算错就等于
   * 漏建一个组或者建出第二个同名组。三个条件缺一不可：同系列、状态不是 ad_create、
   * 系列 ID 读得出来。
   */
  it("发布草稿时只跳过同系列下已经建成的组，草稿和别的系列的同名组都不算", async () => {
    const publishExistingDrafts = vi.fn(async () => ({
      ok: true,
      message: "已发布 1 个草稿广告组；另有 1 个此前已经建成，未重复发布：新组-2",
      adGroupIds: ["published-3"],
    }));
    const provider = {
      kind: "cookie",
      displayName: "draft publish provider",
      capabilityVersion: "draft-publish-v1",
      capabilities: new Set(["copy-ads"]),
      publishExistingDrafts,
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
      status: "active", capabilityVersion: "draft-publish-v1", capabilities: ["copy-ads"],
    });
    const syncedAt = new Date().toISOString();
    store.saveReadOnlySync("demo-account", "cookie", [
      { entityType: "campaign" as const, externalId: "campaign-1", payload: { campaign_id: "campaign-1", campaign_name: "夏季系列" } },
      // 上一次部分成功建出来的：可以跳过。
      { entityType: "ad-group" as const, externalId: "g2", payload: { campaign_id: "campaign-1", ad_name: "新组-2", ad_status: "ad_disable" } },
      // 还停在草稿——草稿也在广告组列表里、也带名字，绝不能当成「已经建成」。
      { entityType: "ad-group" as const, externalId: "g3", payload: { campaign_id: "campaign-1", ad_name: "新组-3", ad_status: "ad_create" } },
      // 别的系列里的同名组：跟这条记录无关。
      { entityType: "ad-group" as const, externalId: "g9", payload: { campaign_id: "campaign-9", ad_name: "新组-9", ad_status: "ad_disable" } },
    ], {
      startedAt: syncedAt, finishedAt: syncedAt,
      counts: { campaign: 1, "ad-group": 3, ad: 0, material: 0 },
      warnings: [], quality: testSyncQuality(syncedAt),
    });
    store.claimAdGroupExpandTask("partial-task", "demo-account", "adgroup-1", {
      sourceCampaignId: "campaign-1",
      requestedCount: 3,
      generatedNames: ["新组-2", "新组-3", "新组-9"],
    });
    store.finishAdGroupExpandTask("partial-task", "unknown");
    await app.close();
    app = await createApp({ store, vault, providers: new ProviderRegistry([provider]), disableAuth: true });

    const response = await app.inject({
      method: "POST",
      url: "/api/ad-group-expand-tasks/partial-task/publish-draft",
    });

    expect(response.statusCode).toBe(200);
    const [, publishInput] = publishExistingDrafts.mock.calls[0] as unknown as [
      unknown,
      { names: string[]; publishedNames: string[] },
    ];
    expect(publishInput.names).toEqual(["新组-2", "新组-3", "新组-9"]);
    expect(publishInput.publishedNames).toEqual(["新组-2"]);
  });

  it("only lists drafts past the protection window, and never the ones awaiting a decision", async () => {
    const now = Date.now();
    const hoursAgo = (hours: number) => (now - hours * 3_600_000) / 1000;
    const listDraftAdGroups = vi.fn(async () => [
      { adSketchId: "old", adSketchName: "遗留草稿", campaignId: "c1", campaignSketchId: "", touchedAt: hoursAgo(9) },
      { adSketchId: "fresh", adSketchName: "刚建的", campaignId: "c1", campaignSketchId: "", touchedAt: hoursAgo(0.5) },
      { adSketchId: "pending", adSketchName: "待决策-1", campaignId: "c1", campaignSketchId: "", touchedAt: hoursAgo(9) },
    ]);
    const deleteDraftAdGroups = vi.fn(async (_context: unknown, input: { adSketchIds: string[] }) => ({
      deleted: input.adSketchIds, failed: [],
    }));
    const provider = {
      kind: "cookie",
      displayName: "draft cleanup provider",
      capabilityVersion: "draft-cleanup-v1",
      capabilities: new Set(["copy-ads"]),
      listDraftAdGroups,
      deleteDraftAdGroups,
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
      status: "active", capabilityVersion: "draft-cleanup-v1", capabilities: ["copy-ads"],
    });
    // 一条还挂着「结果未知」的记录，占住同名草稿。
    store.claimAdGroupExpandTask("await-decision", "demo-account", "adgroup-9", {
      sourceCampaignId: "c1", requestedCount: 1, generatedNames: ["待决策-1"],
    });
    store.finishAdGroupExpandTask("await-decision", "unknown");
    await app.close();
    app = await createApp({ store, vault, providers: new ProviderRegistry([provider]), disableAuth: true });

    const listed = await app.inject({ method: "GET", url: "/api/accounts/demo-account/draft-candidates" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().drafts.map((draft: { adSketchName: string }) => draft.adSketchName)).toEqual(["遗留草稿"]);
    // 保护期内的和待决策的各一条，用来向用户解释名单为什么比后台看到的短。
    expect(listed.json()).toMatchObject({ tooFresh: 1, reserved: 1, minAgeHours: 3 });

    const deleted = await app.inject({ method: "POST", url: "/api/accounts/demo-account/draft-candidates/delete" });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ deleted: 1 });
    // 只删够格的那条；刚建的和待决策的一个都不能碰。
    expect(deleteDraftAdGroups).toHaveBeenCalledWith(expect.anything(), { adSketchIds: ["old"] });
    // 候选在服务端重新算，不接受调用方传 ID。
    expect(listDraftAdGroups).toHaveBeenCalledTimes(2);
  });

  it("keeps the uncertain record when the draft publish result is unknown", async () => {
    const publishExistingDrafts = vi.fn(async () => ({
      ok: false,
      message: "create_by_snap：请求已发出，但响应丢失",
      failureKind: "unknown" as const,
      retrySafe: false,
    }));
    const provider = {
      kind: "cookie",
      displayName: "draft publish provider",
      capabilityVersion: "draft-publish-v1",
      capabilities: new Set(["copy-ads"]),
      publishExistingDrafts,
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
      status: "active", capabilityVersion: "draft-publish-v1", capabilities: ["copy-ads"],
    });
    store.claimAdGroupExpandTask("stuck-unknown", "demo-account", "adgroup-2", {
      sourceCampaignId: "campaign-1",
      requestedCount: 1,
      generatedNames: ["新组-0826-070000-1"],
    });
    store.finishAdGroupExpandTask("stuck-unknown", "unknown");
    await app.close();
    app = await createApp({ store, vault, providers: new ProviderRegistry([provider]), disableAuth: true });

    const response = await app.inject({
      method: "POST",
      url: "/api/ad-group-expand-tasks/stuck-unknown/publish-draft",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("到 TikTok 后台核实");
    // 结果未知的那条恰恰最需要人去看一眼，红条必须留着。
    expect(store.getUncertainAdGroupExpandTask("stuck-unknown")).not.toBeNull();
  });

  it("passes the dispatch guard through the non-same-campaign copy path", async () => {
    freezeClock();
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
    freezeClock();
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

  it("扩组重复提交预检：干净的源组不打扰，扩过之后报出今日已扩记录且不写任何东西", async () => {
    // 「今天」按账户本地日历日判定，冻结时钟避免跨午夜误判。
    freezeClock();
    const copyAdGroupToExistingCampaign = vi.fn(async () => ({ ok: true, message: "created" }));
    const provider = {
      kind: "cookie",
      displayName: "preflight expansion provider",
      capabilityVersion: "preflight-expansion-v1",
      capabilities: new Set(["copy-ads"]),
      copyAdGroupToExistingCampaign,
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
      status: "active", capabilityVersion: "preflight-expansion-v1", capabilities: ["copy-ads"],
    });
    await app.close();
    app = await createApp({ store, vault, providers: new ProviderRegistry([provider]), disableAuth: true });

    const source = {
      accountId: "demo-account",
      sourceCampaignId: "campaign-1",
      sourceCampaignName: "campaign",
      sourceAdGroupId: "adgroup-1",
      sourceAdGroupName: "蓝牙音响",
    };
    const preflight = () => app.inject({
      method: "POST",
      url: "/api/ad-groups/batch-expand/preflight",
      payload: { sources: [source] },
    });

    // 没有任何记录时保持安静：无谓的弹窗会把真正的重复提示训练成「无脑点确认」。
    const clean = await preflight();
    expect(clean.statusCode).toBe(200);
    expect(clean.json()).toEqual({ conflicts: [] });

    const expanded = await app.inject({
      method: "POST",
      url: "/api/ad-groups/batch-expand",
      payload: {
        sources: [source],
        count: 2,
        dailyBudget: 50,
        bid: null,
        launchImmediately: false,
        sameCampaign: true,
        scheduledStartAt: null,
      },
    });
    expect(expanded.json()).toMatchObject({ createdGroups: 2, failed: [] });

    const afterExpand = await preflight();
    const conflicts = afterExpand.json().conflicts as Array<{
      sourceAdGroupId: string;
      inProgress: { kind: string } | null;
      expandedToday: { batches: number; groups: number; names: string[] };
      existingNames: string[];
    }>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      sourceAdGroupId: "adgroup-1",
      // 已经跑完了，不该再报「进行中」。
      inProgress: null,
      expandedToday: { batches: 1, groups: 2 },
    });
    // 手动扩组也要落库真实组名，否则预检永远查不到自己刚建的东西。
    expect(conflicts[0]?.expandedToday.names).toEqual([
      expect.stringMatching(/^蓝牙音响-\d{4}-\d{6}-1$/),
      expect.stringMatching(/^蓝牙音响-\d{4}-\d{6}-2$/),
    ]);
    expect(conflicts[0]?.existingNames).toEqual(
      expect.arrayContaining(conflicts[0]!.expandedToday.names),
    );

    // 预检是只读的：连着调不产生任何新任务，也不改变已有判定。
    expect((await preflight()).json()).toEqual(afterExpand.json());
    expect(copyAdGroupToExistingCampaign).toHaveBeenCalledTimes(1);
  });

  it("扩组重复提交预检：进行中与待人工确认分别标出来", async () => {
    freezeClock();
    // 与引擎一致：本地日历日按账户时区取，不用 UTC。
    const localDate = new Date().toLocaleDateString("en-CA", {
      timeZone: store.getAccount("demo-account")!.timezone,
    });
    const source = {
      accountId: "demo-account",
      sourceCampaignId: "campaign-1",
      sourceCampaignName: "campaign",
      sourceAdGroupId: "adgroup-running",
      sourceAdGroupName: "在跑的组",
    };
    store.claimAdGroupExpandTask("running-task", "demo-account", "adgroup-running", {
      sourceCampaignId: "campaign-1",
      localDate,
      requestedCount: 1,
      generatedNames: ["在跑的组-0101-000000-1"],
    });

    const running = await app.inject({
      method: "POST",
      url: "/api/ad-groups/batch-expand/preflight",
      payload: { sources: [source] },
    });
    expect(running.json().conflicts[0]).toMatchObject({
      sourceAdGroupId: "adgroup-running",
      inProgress: { kind: "running" },
      // 还没跑完，不该算进「今天已扩过」。
      expandedToday: null,
    });

    // 写请求已发出、结果未知：必须升级成「待人工确认」，这是最需要拦住手的一类。
    store.markAdGroupExpandTaskDispatching("running-task");
    const pending = await app.inject({
      method: "POST",
      url: "/api/ad-groups/batch-expand/preflight",
      payload: { sources: [source] },
    });
    expect(pending.json().conflicts[0]).toMatchObject({
      inProgress: { kind: "pending-confirmation" },
    });
  });

  it("列出扩组历史：不限源组也不限日期，结果未知的那条要带着标记出来", async () => {
    store.claimAdGroupExpandTask("history-done", "demo-account", "adgroup-a", {
      sourceCampaignId: "campaign-1",
      localDate: "2026-01-01",
      requestedCount: 2,
      generatedNames: ["A组-0101-060000-1", "A组-0101-060000-2"],
    });
    store.finishAdGroupExpandTask("history-done", "succeeded");
    store.claimAdGroupExpandTask("history-unknown", "demo-account", "adgroup-b", {
      sourceCampaignId: "campaign-2",
      localDate: "2026-01-02",
      requestedCount: 1,
      generatedNames: ["B组-0102-060000-1"],
    });
    store.markAdGroupExpandTaskDispatching("history-unknown");

    const response = await app.inject({
      method: "GET",
      url: "/api/ad-group-expand-tasks?accountIds=demo-account",
    });

    expect(response.statusCode, response.body).toBe(200);
    const tasks = response.json().tasks as Array<Record<string, unknown>>;
    // 预检那条查询会把这两条都过滤掉（限定源组 + 只看当天），历史必须两条都在。
    expect(tasks.map((task) => task.taskKey).sort()).toEqual(["history-done", "history-unknown"]);
    expect(tasks.find((task) => task.taskKey === "history-done")).toMatchObject({
      status: "succeeded", uncertain: false, requestedCount: 2,
      generatedNames: ["A组-0101-060000-1", "A组-0101-060000-2"],
    });
    expect(tasks.find((task) => task.taskKey === "history-unknown")).toMatchObject({
      status: "running", uncertain: true,
    });
  });

  it("结果未知的扩组记录无视条数上限：被近期成功记录挤出 limit 也必须返回", async () => {
    // 先埋一条「结果未知」，再拿一批更新的成功记录把它挤到 limit 之外。
    store.claimAdGroupExpandTask("old-unknown", "demo-account", "adgroup-old", {
      sourceCampaignId: "campaign-1",
      localDate: "2026-01-01",
      requestedCount: 1,
      generatedNames: ["很久以前那组-0101-060000-1"],
    });
    store.markAdGroupExpandTaskDispatching("old-unknown");
    for (let index = 0; index < 5; index += 1) {
      store.claimAdGroupExpandTask(`recent-${index}`, "demo-account", `adgroup-${index}`, {
        sourceCampaignId: "campaign-1",
        localDate: "2026-02-01",
        requestedCount: 1,
        generatedNames: [`新组-0201-060000-${index}`],
      });
      store.finishAdGroupExpandTask(`recent-${index}`, "succeeded");
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/ad-group-expand-tasks?accountIds=demo-account&limit=3",
    });

    expect(response.statusCode, response.body).toBe(200);
    const tasks = response.json().tasks as Array<Record<string, unknown>>;
    // limit=3 只约束成功记录；那条未知的必须照样在，否则界面上永远看不见它。
    expect(tasks.filter((task) => task.uncertain === false)).toHaveLength(3);
    expect(tasks.map((task) => task.taskKey)).toContain("old-unknown");
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

  it("returns and updates the global rules", async () => {
    const existing = await app.inject({ method: "GET", url: "/api/rules" });
    const body = existing.json();
    expect(body.lookbackHours).toBe(48);
    // 跟定义数联动，加规则时不用改这个数字
    expect(body.rules).toHaveLength(automationRuleDefinitions.length);
    expect(body.layers).toEqual({ campaign: false, adGroup: true, ad: true, material: true });

    body.layers.campaign = true;
    // 按规则码定位，不按下标：下标会随规则顺序变动指到别的规则，而不同规则支持的
    // 参数不同，写进去会被 schema 判为「不支持的参数」。
    const target = body.rules.find(
      (rule: { code: string }) => rule.code === "CV1_CPC_CLOSE",
    );
    target.enabled = false;
    target.values.cpc = 0.9;
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
    expect(
      updated.json().rules.find((rule: { code: string }) => rule.code === "CV1_CPC_CLOSE"),
    ).toMatchObject({
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

  it("accepts a multi-account publish with each account's own Cookie session without waiting for readback", async () => {
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
    expect(executed.json().plan, JSON.stringify(executed.json(), null, 2)).toMatchObject({
      status: "blocked",
      executionResults: [
        { accountId: "demo-account", ok: false, createdCount: 0, failedCount: 0, unknownCount: 1 },
        { accountId: second.id, ok: false, createdCount: 0, failedCount: 0, unknownCount: 1 },
      ],
    });
    expect(executed.json().results).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: "demo-account", status: "unknown", pendingReadback: true }),
      expect.objectContaining({ accountId: second.id, status: "unknown", pendingReadback: true }),
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

  it("状态写入后只回读目标实体，不再为核对 1 个而全量同步整个账户", async () => {
    const syncReadOnly = vi.fn<NonNullable<AdsProvider["syncReadOnly"]>>(async () => {
      throw new Error("不应该走全量同步");
    });
    const readEntityById = vi.fn<NonNullable<AdsProvider["readEntityById"]>>(
      async (_context, entityType, externalId) => ({
        entityType,
        externalId,
        payload: { primary_status: "disable" },
      }),
    );
    await installLaunchTestProvider(
      async (_context, mutations) => mutations.map((mutation) => ({
        ...mutation, ok: true, campaignId: "campaign", adGroupId: "group", adId: "ad", message: "created",
      })),
      [apiLaunchRow(2)],
      syncReadOnly,
      undefined,
      undefined,
      readEntityById,
    );
    const syncedAt = new Date().toISOString();
    // 同层还有一个无关实体：定向回读绝不能像 saveReadOnlySync 那样把它整片下线。
    store.saveReadOnlySync("demo-account", "cookie", [
      { entityType: "ad-group", externalId: "adgroup-1", payload: { primary_status: "enable" } },
      { entityType: "ad-group", externalId: "adgroup-2", payload: { primary_status: "enable" } },
    ], {
      startedAt: syncedAt,
      finishedAt: syncedAt,
      counts: { campaign: 0, "ad-group": 2, ad: 0, material: 0 },
      warnings: [],
      quality: testSyncQuality(syncedAt),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/entities/status",
      payload: { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
    });

    expect(response.statusCode, response.body).toBe(200);
    await vi.waitFor(() => expect(readEntityById).toHaveBeenCalledTimes(1));
    expect(readEntityById).toHaveBeenCalledWith(
      expect.anything(), "ad-group", "adgroup-1",
    );
    expect(syncReadOnly).not.toHaveBeenCalled();
    // 看「当前集」而不是全表：单实体刷新如果误用了 saveReadOnlySync，同层其余实体
    // 会被 is_current=0 整片下线，只有这个接口能看出来。
    const entities = store.listCurrentManagedEntities("demo-account", "cookie");
    expect(entities.find((item) => item.externalId === "adgroup-1")?.status).toBe("disabled");
    expect(entities.find((item) => item.externalId === "adgroup-2")?.status).toBe("enabled");
  });

  it("定向回读拿不到实体时退回全量同步，而不是把状态判成未确认", async () => {
    const syncReadOnly = vi.fn<NonNullable<AdsProvider["syncReadOnly"]>>(async () => {
      const finishedAt = new Date().toISOString();
      return {
        entities: [{ entityType: "ad-group" as const, externalId: "adgroup-1", payload: { primary_status: "disable" } }],
        result: {
          startedAt: finishedAt,
          finishedAt,
          counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
          warnings: [],
          quality: testSyncQuality(finishedAt),
        },
      };
    });
    const readEntityById = vi.fn<NonNullable<AdsProvider["readEntityById"]>>(async () => null);
    await installLaunchTestProvider(
      async (_context, mutations) => mutations.map((mutation) => ({
        ...mutation, ok: true, campaignId: "campaign", adGroupId: "group", adId: "ad", message: "created",
      })),
      [apiLaunchRow(2)],
      syncReadOnly,
      undefined,
      undefined,
      readEntityById,
    );
    const syncedAt = new Date().toISOString();
    store.saveReadOnlySync("demo-account", "cookie", [
      { entityType: "ad-group", externalId: "adgroup-1", payload: { primary_status: "enable" } },
    ], {
      startedAt: syncedAt,
      finishedAt: syncedAt,
      counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
      warnings: [],
      quality: testSyncQuality(syncedAt),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/entities/status",
      payload: { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
    });

    expect(response.statusCode, response.body).toBe(200);
    await vi.waitFor(() => expect(syncReadOnly).toHaveBeenCalledTimes(1));
    // 回读落库发生在 syncReadOnly 返回之后，等状态本身而不是等调用次数。
    await vi.waitFor(() => expect(store.listManagedEntities("demo-account", "cookie")
      .find((item) => item.externalId === "adgroup-1")?.status).toBe("disabled"));
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
    readEntityById?: AdsProvider["readEntityById"],
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
      ...(readEntityById ? { readEntityById } : {}),
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

  describe("谱系与扩组导入表", () => {
    /** 一条原组 + 一条从它扩出来的组，扩组记录把两者钉死。 */
    function seedLineageAccount() {
      const syncedAt = new Date().toISOString();
      store.saveReadOnlySync("demo-account", "cookie", [
        { entityType: "campaign", externalId: "c1", payload: { campaign_id: "c1", campaign_name: "八寶茶系列" } },
        { entityType: "ad-group", externalId: "g1", payload: { campaign_id: "c1", adgroup_name: "八寶茶" } },
        { entityType: "ad-group", externalId: "g2", payload: { campaign_id: "c1", adgroup_name: "八寶茶-0812-091530-1" } },
      ], {
        startedAt: syncedAt,
        finishedAt: syncedAt,
        counts: { campaign: 1, "ad-group": 2, ad: 0, material: 0 },
        warnings: [],
        quality: testSyncQuality(syncedAt),
      });
      store.claimAdGroupExpandTask("task-1", "demo-account", "g1", {
        sourceCampaignId: "c1",
        localDate: "2026-08-12",
        requestedCount: 1,
        generatedNames: ["八寶茶-0812-091530-1"],
      });
      store.finishAutomaticCopyTask("task-1", "succeeded", ["g2"]);
      store.finishAdGroupExpandTask("task-1", "succeeded");
    }

    it("分得清原组和从它扩出来的组", async () => {
      seedLineageAccount();

      const response = await app.inject({
        method: "GET",
        url: "/api/accounts/demo-account/lineage",
      });

      expect(response.statusCode).toBe(200);
      const brand = response.json().brands.find(
        (item: { rootName: string }) => item.rootName === "八寶茶",
      );
      expect(brand.adGroups).toHaveLength(2);
      expect(brand.adGroups[0]).toMatchObject({
        externalId: "g1",
        origin: "original",
        confidence: "inferred",
      });
      expect(brand.adGroups[1]).toMatchObject({
        externalId: "g2",
        origin: "expanded",
        confidence: "confirmed",
        sourceId: "g1",
        sourceName: "八寶茶",
        taskKey: "task-1",
      });
    });

    it("列出账户内的同名系列", async () => {
      const syncedAt = new Date().toISOString();
      store.saveReadOnlySync("demo-account", "cookie", [
        { entityType: "campaign", externalId: "c1", payload: { campaign_id: "c1", campaign_name: "同名系列" } },
        { entityType: "campaign", externalId: "c2", payload: { campaign_id: "c2", campaign_name: "同名系列" } },
      ], {
        startedAt: syncedAt,
        finishedAt: syncedAt,
        counts: { campaign: 2, "ad-group": 0, ad: 0, material: 0 },
        warnings: [],
        quality: testSyncQuality(syncedAt),
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/accounts/demo-account/lineage",
      });

      expect(response.json().duplicateCampaignNames).toEqual([
        { name: "同名系列", parentCampaignId: null, externalIds: ["c1", "c2"] },
      ]);
    });

    it("生成的导入表带全系列名与组名，只留视频代码给人填", async () => {
      seedLineageAccount();

      const response = await app.inject({
        method: "POST",
        url: "/api/accounts/demo-account/expand-sheet/plan",
        payload: {
          sourceAdGroupIds: ["g1"],
          countPerSource: 2,
          sameCampaign: true,
          scheduledStartAt: "2026-08-20T02:30:00.000Z",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.header).toEqual(["推广系列名称", "广告组名称", "视频代码", "产品 URL", "年龄", "性别", "编码"]);
      expect(body.rows).toHaveLength(2);
      expect(body.rows[0].campaignName).toBe("八寶茶系列");
      expect(body.rows[0].adGroupName).toMatch(/^八寶茶-0820-\d{6}-1$/);
      expect(body.rows[1].adGroupName).toMatch(/^八寶茶-0820-\d{6}-2$/);
      expect(body.rows[0].videoCode).toBe("");
      // 快照里没有落地页，也没有历史导入行可沿用——必须点名让人补，而不是编一个。
      expect(body.rows[0].productUrl).toBe("");
      expect(body.incomplete).toEqual([
        expect.objectContaining({ rowNumber: 2, missing: ["产品 URL"] }),
        expect.objectContaining({ rowNumber: 3, missing: ["产品 URL"] }),
      ]);
    });

    it("快照里查不到的源组单独报出来，不拖垮整张表", async () => {
      seedLineageAccount();

      const response = await app.inject({
        method: "POST",
        url: "/api/accounts/demo-account/expand-sheet/plan",
        payload: { sourceAdGroupIds: ["g1", "不存在的组"], countPerSource: 1 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().rows).toHaveLength(1);
      expect(response.json().unresolvedSources).toEqual([
        { sourceAdGroupId: "不存在的组", reason: "不在当前同步快照中，请先同步账户。" },
      ]);
    });
  });
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
