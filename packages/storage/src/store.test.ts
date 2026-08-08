import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createDefaultAutomationSwitches, defaultAutomationFeatureSettings, type LaunchCopyPreviewInput, type LaunchOriginalPost } from "@tk-auto/core";
import { AutomationStore } from "./store.js";
import { MigrationRunner } from "./migration-runner.js";
import {
  applyPendingDatabaseRestore,
  finalizePendingDatabaseRestore,
} from "./database-maintenance.js";

function healthySyncQuality(finishedAt: string) {
  return {
    status: "healthy" as const,
    paginationComplete: true,
    requiredMetricsComplete: true,
    contractValid: true,
    providerContractVersion: "test-v1",
    coverage: { startDate: "2026-07-16", endDate: "2026-07-16", timezone: "UTC" },
    missingMetrics: [],
    partialFailures: [],
    lastHealthyAt: finishedAt,
  };
}

describe("AutomationStore", () => {
  let store: AutomationStore;

  beforeEach(() => {
    store = new AutomationStore(":memory:");
    store.seed();
  });

  afterEach(() => {
    store.close();
    vi.restoreAllMocks();
  });

  it("seeds an account and the fixed global rules", () => {
    expect(store.listAccounts()).toHaveLength(1);
    expect(store.getRuleConfiguration()).toMatchObject({
      lookbackHours: 48,
      layers: { campaign: false, adGroup: true, ad: true },
    });
    expect(store.getRuleConfiguration().rules).toHaveLength(9);
    expect(store.getGlobalAutomationSettings()).toMatchObject({
      pollingIntervalMinutes: 5,
      maxActionsPerRun: 15,
    });
  });

  it("never reclaims an expansion task whose remote result is unknown, while confirmed failures remain retryable", () => {
    expect(store.claimAdGroupExpandTask("unknown-task", "demo-account", "adgroup-1")).toBe("claimed");
    store.finishAdGroupExpandTask("unknown-task", "unknown");
    expect(store.claimAdGroupExpandTask("unknown-task", "demo-account", "adgroup-1")).toBe("unknown");

    expect(store.claimAdGroupExpandTask("failed-task", "demo-account", "adgroup-2")).toBe("claimed");
    store.finishAdGroupExpandTask("failed-task", "failed");
    expect(store.claimAdGroupExpandTask("failed-task", "demo-account", "adgroup-2")).toBe("claimed");

    expect(store.claimAdGroupExpandTask("crash-task", "demo-account", "adgroup-3")).toBe("claimed");
    store.markAdGroupExpandTaskDispatching("crash-task");
    expect(store.claimAdGroupExpandTask("crash-task", "demo-account", "adgroup-3")).toBe("unknown");
  });

  it("reserves automatic copies atomically, enforces the daily cap, and remembers generated destinations", () => {
    expect(store.claimAutomaticCopyTask({
      taskKey: "auto-copy-1",
      accountId: "demo-account",
      sourceCampaignId: "campaign-1",
      sourceAdGroupId: "source-1",
      localDate: "2026-07-24",
      requestedCount: 2,
      generatedNames: ["source-0724-1", "source-0724-2"],
      dailyLimit: 3,
    })).toBe("claimed");
    expect(store.claimAutomaticCopyTask({
      taskKey: "auto-copy-2",
      accountId: "demo-account",
      sourceCampaignId: "campaign-1",
      sourceAdGroupId: "source-2",
      localDate: "2026-07-24",
      requestedCount: 2,
      generatedNames: ["other-0724-1", "other-0724-2"],
      dailyLimit: 3,
    })).toBe("daily-limit");
    // 结果回读之前只有预留的名称可用来排除。
    expect(store.listAutomaticCopyGeneratedRefs("demo-account").names)
      .toContain("source-0724-1");
    store.finishAutomaticCopyTask(
      "auto-copy-1",
      "succeeded",
      ["generated-1", "generated-2"],
    );
    // 回读到真实 ID 后，即使用户把组改了名也照样排除。
    expect(store.listAutomaticCopyGeneratedRefs("demo-account").ids)
      .toContain("generated-1");
    expect(store.claimAutomaticCopyTask({
      taskKey: "auto-copy-1",
      accountId: "demo-account",
      sourceCampaignId: "campaign-1",
      sourceAdGroupId: "source-1",
      localDate: "2026-07-24",
      requestedCount: 2,
      generatedNames: ["source-0724-1", "source-0724-2"],
      dailyLimit: 3,
    })).toBe("succeeded");

    expect(store.claimAutomaticCopyTask({
      taskKey: "auto-copy-failed",
      accountId: "demo-account",
      sourceCampaignId: "campaign-1",
      sourceAdGroupId: "source-failed",
      localDate: "2026-07-25",
      requestedCount: 2,
      generatedNames: ["failed-1", "failed-2"],
      dailyLimit: 20,
    })).toBe("claimed");
    store.finishAutomaticCopyTask("auto-copy-failed", "failed");
    expect(store.claimAutomaticCopyTask({
      taskKey: "auto-copy-failed",
      accountId: "demo-account",
      sourceCampaignId: "campaign-1",
      sourceAdGroupId: "source-failed",
      localDate: "2026-07-25",
      requestedCount: 2,
      generatedNames: ["failed-1", "failed-2"],
      dailyLimit: 20,
    })).toBe("failed");
    // 失败的任务也可能已经部分创建成功，它预留过的名称同样要排除在复制源之外，
    // 否则那些组会反过来成为下一轮的源。
    expect(store.listAutomaticCopyGeneratedRefs("demo-account").names)
      .toContain("failed-1");
  });

  it("claims a daily executor once and allows only stale unfinished scans to resume", () => {
    expect(store.claimDailyAutomationRun(
      "demo-account",
      "delete-ad-groups",
      "2026-07-24",
    )).toBe("claimed");
    expect(store.claimDailyAutomationRun(
      "demo-account",
      "delete-ad-groups",
      "2026-07-24",
    )).toBe("running");
    store.finishDailyAutomationRun("demo-account", "delete-ad-groups", "2026-07-24");
    expect(store.claimDailyAutomationRun(
      "demo-account",
      "delete-ad-groups",
      "2026-07-24",
    )).toBe("completed");
  });

  it("migrates the expansion uncertainty guard into an existing database", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-expand-migration-"));
    const databasePath = join(directory, "automation.db");
    store.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE ad_group_expand_tasks (
        task_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        source_ad_group_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded')),
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO ad_group_expand_tasks (
        task_key, account_id, source_ad_group_id, status, claimed_at, updated_at
      ) VALUES (
        'legacy-running-task', 'demo-account', 'adgroup-legacy', 'running',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    try {
      store = new AutomationStore(databasePath);
      expect(store.claimAdGroupExpandTask("legacy-running-task", "demo-account", "adgroup-legacy")).toBe("unknown");
      expect(store.claimAdGroupExpandTask("legacy-crash-task", "demo-account", "adgroup-1")).toBe("claimed");
      store.markAdGroupExpandTaskDispatching("legacy-crash-task");
      expect(store.claimAdGroupExpandTask("legacy-crash-task", "demo-account", "adgroup-1")).toBe("unknown");
      store.close();
      rmSync(directory, { recursive: true, force: true });
      store = new AutomationStore(":memory:");
    } catch (cause) {
      try {
        store.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
        store = new AutomationStore(":memory:");
      }
      throw cause;
    }
  });

  it("updates only the global rule configuration", () => {
    const configuration = store.getRuleConfiguration();
    configuration.layers.campaign = true;
    configuration.rules[0]!.enabled = false;
    configuration.rules[0]!.values.cpc = 0.9;

    const updated = store.updateRuleConfiguration(configuration);

    expect(updated.layers.campaign).toBe(true);
    expect(updated.rules[0]).toMatchObject({
      code: "CV1_CPC_CLOSE",
      enabled: false,
      values: { cpc: 0.9 },
    });
  });

  it("stores notification settings without exposing credential references", () => {
    expect(store.listNotificationChannels()).toHaveLength(3);
    store.saveNotificationChannelSettings({
      kind: "email",
      enabled: true,
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      secure: true,
      from: "sender@example.com",
      recipients: ["owner@example.com"],
    });
    store.setNotificationCredentialReference("email", "vault-reference");

    const channel = store
      .listNotificationChannels()
      .find((item) => item.kind === "email");
    expect(channel).toMatchObject({
      hasCredential: true,
      status: "untested",
    });
    expect(JSON.stringify(channel)).not.toContain("vault-reference");
  });

  it("persists poll results and queues one delivery per ready channel", () => {
    store.saveNotificationChannelSettings({
      kind: "wecom",
      enabled: true,
      mentionAll: false,
    });
    store.setNotificationCredentialReference("wecom", "vault-reference");
    store.updateNotificationChannelStatus("wecom", "ready", "ready");
    const cycle = store.createPollCycle();
    store.savePollAccountResult(cycle.id, {
      accountId: "demo-account",
      accountName: "演示广告账户",
      runId: null,
      status: "no-action",
      enabledCount: 0,
      disabledCount: 0,
      failureCount: 0,
      message: null,
    });
    const completed = store.finishPollCycle(cycle.id);
    const deliveries = store.enqueueNotificationDeliveries(cycle.id);

    expect(completed.accounts[0]?.status).toBe("no-action");
    expect(deliveries).toHaveLength(1);
    expect(store.listDueNotificationDeliveries()).toHaveLength(1);
  });

  // 2026-08-06：三条自动申诉因 TikTok 后端解包失败被判 unknown，而 blocked 把
  // unknown 也当成永久占坑，于是这三条广告被永久踢出候选池。申诉是可安全重复提交
  // 的操作，代价远低于"永远不再申诉"，改为与明确失败一样受 retryLimit 约束。
  describe("申诉的执行门禁", () => {
    const appeal = (externalId: string, status: "succeeded" | "failed" | "unknown") => {
      const task = store.queueAppeal("demo-account", "cookie", externalId, "理由", "automation");
      store.completeAppeal(task.id, status, "消息");
    };

    it("结果未知不再永久拉黑，而是计入次数交给 retryLimit", () => {
      appeal("ad-unknown", "unknown");

      const state = store.getAppealExecutionState("demo-account", "ad-unknown");
      expect(state.blocked).toBe(false);
      expect(state.confirmedFailureCount).toBe(1);
    });

    it("明确失败与结果未知累加进同一个计数", () => {
      appeal("ad-mixed", "failed");
      appeal("ad-mixed", "unknown");

      expect(store.getAppealExecutionState("demo-account", "ad-mixed")).toMatchObject({
        blocked: false,
        confirmedFailureCount: 2,
      });
    });

    // 成功过的不再重复申诉，这条边界不因为放宽 unknown 而松掉。
    it("申诉成功过的仍然永久占坑", () => {
      appeal("ad-done", "succeeded");

      expect(store.getAppealExecutionState("demo-account", "ad-done").blocked).toBe(true);
    });

    // 还在排队/执行中的不并发提交第二次。
    it("还没收口的申诉仍然占坑", () => {
      store.queueAppeal("demo-account", "cookie", "ad-inflight", "理由", "automation");

      expect(store.getAppealExecutionState("demo-account", "ad-inflight").blocked).toBe(true);
    });

    it("按账户和广告分别计数，不互相污染", () => {
      appeal("ad-a", "unknown");

      expect(store.getAppealExecutionState("demo-account", "ad-b").confirmedFailureCount).toBe(0);
      expect(store.getAppealExecutionState("demo-account", "ad-b").blocked).toBe(false);
    });
  });

  // 客户端 24 小时跑着、每 30 秒一轮，这些流水表增长很快：上线 25 天就攒了
  // 3.6 万条审计、1.4 万轮轮询。只保留 30 天。
  describe("操作历史保留 30 天", () => {

    it("超过 30 天的操作记录连同它的尝试记录一起清掉", () => {
      const old = store.queueAppeal("demo-account", "cookie", "ad-old", "理由", "automation");
      store.completeAppeal(old.id, "failed", "旧记录");
      const fresh = store.queueAppeal("demo-account", "cookie", "ad-fresh", "理由", "automation");
      store.completeAppeal(fresh.id, "failed", "新记录");
      // 把其中一条改成 40 天前。
      store.pruneOperationHistory(new Date());
      expect(store.getAdOperation(old.id)).toBeTruthy();

      const deleted = store.pruneOperationHistory(new Date(Date.now() + 40 * 86_400_000));

      expect(deleted.ad_operations).toBeGreaterThanOrEqual(2);
      expect(() => store.getAdOperation(old.id)).toThrow();
    });

    // 还没收口的写任务是待办不是历史，多老都得留着。
    it("pending / running 的写任务不清", () => {
      const pending = store.queueAppeal("demo-account", "cookie", "ad-pending", "理由", "automation");

      store.pruneOperationHistory(new Date(Date.now() + 400 * 86_400_000));

      expect(store.getAdOperation(pending.id)).toMatchObject({ status: "pending" });
    });

    it("30 天以内的一条都不动", () => {
      const recent = store.queueAppeal("demo-account", "cookie", "ad-recent", "理由", "automation");
      store.completeAppeal(recent.id, "failed", "近期");

      const deleted = store.pruneOperationHistory(new Date());

      expect(deleted.ad_operations ?? 0).toBe(0);
      expect(store.getAdOperation(recent.id)).toBeTruthy();
    });

    // 指标快照是界面上 90 天日历的数据源，不能跟着一起删。
    it("不碰指标快照", () => {
      const before = store.listCurrentProviderEntities("demo-account", "cookie").length;

      store.pruneOperationHistory(new Date(Date.now() + 400 * 86_400_000));

      expect(store.listCurrentProviderEntities("demo-account", "cookie").length).toBe(before);
    });
  });

  // SQLite 不能改 CHECK 约束，存量库必须重建表；不做的话素材写进去会被直接拒绝。
  describe("素材层的数据库放行", () => {
    it("素材实体能落库并读回", () => {
      store.saveReadOnlySync("demo-account", "cookie", [
        { entityType: "campaign", externalId: "c1", payload: { campaign_name: "系列" } },
        { entityType: "ad-group", externalId: "g1", payload: { campaign_id: "c1", ad_name: "组" } },
        { entityType: "ad", externalId: "a1", payload: { campaign_id: "c1", adgroup_id: "g1", creative_name: "广告" } },
        {
          entityType: "material",
          externalId: "1872777743628513",
          payload: { campaign_id: "c1", ad_id: "g1", creative_id: "a1", main_entity_name: "素材", stat_cost: "26.82" },
        },
      ], {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        counts: { campaign: 1, "ad-group": 1, ad: 1, material: 1 },
        warnings: [],
        // 素材层只覆盖"当天有消耗的广告"，一轮里本来就不是全量，所以只有本轮
        // 确实取全时才会刷新这一层——Provider 会把 material 放进 completeEntityTypes。
        quality: { ...healthySyncQuality(new Date().toISOString()), completeEntityTypes: ["material"] },
      });

      const materials = store
        .listCurrentProviderEntities("demo-account", "cookie")
        .filter((entity) => entity.entityType === "material");

      expect(materials).toHaveLength(1);
      expect(materials[0]).toMatchObject({ externalId: "1872777743628513" });
    });

    // 同一个 ID 在不同层级各自独立：主键含 entity_type，不能互相顶掉。
    it("素材与广告同名 ID 互不覆盖", () => {
      store.saveReadOnlySync("demo-account", "cookie", [
        { entityType: "ad", externalId: "same-id", payload: { creative_name: "广告" } },
        { entityType: "material", externalId: "same-id", payload: { main_entity_name: "素材" } },
      ], {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        counts: { campaign: 0, "ad-group": 0, ad: 1, material: 1 },
        warnings: [],
        quality: { ...healthySyncQuality(new Date().toISOString()), completeEntityTypes: ["material"] },
      });

      const rows = store.listCurrentProviderEntities("demo-account", "cookie")
        .filter((entity) => entity.externalId === "same-id");
      expect(rows.map((entity) => entity.entityType).sort()).toEqual(["ad", "material"]);
    });
  });

  it("persists automation switches", () => {
    const switches = createDefaultAutomationSwitches();
    switches.closeNoConversion = true;

    store.updateAutomationSwitches("demo-account", switches);

    expect(store.getAutomationSwitches("demo-account").closeNoConversion).toBe(
      true,
    );
  });

  it("does not re-enable a status permission after the one-time migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-store-"));
    const databasePath = join(directory, "automation.db");
    const firstStore = new AutomationStore(databasePath);
    firstStore.seed();
    const switches = firstStore.getAutomationSwitches("demo-account");
    switches.manageAdStatus = false;
    firstStore.updateAutomationSwitches("demo-account", switches);
    firstStore.close();

    const reopenedStore = new AutomationStore(databasePath);
    expect(
      reopenedStore.getAutomationSwitches("demo-account").manageAdStatus,
    ).toBe(false);
    reopenedStore.close();
    rmSync(directory, { recursive: true, force: true });
  }, 15_000);

  it("removes legacy account modes while preserving run audit intent", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-store-"));
    const databasePath = join(directory, "automation.db");
    const firstStore = new AutomationStore(databasePath);
    firstStore.seed();
    firstStore.createAutomationRun("demo-account", "cookie", "manual", true);
    firstStore.close();

    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(
      "ALTER TABLE accounts ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'observe' CHECK (length(execution_mode) > 0)",
    );
    legacyDatabase.exec("ALTER TABLE automation_runs DROP COLUMN automatic");
    legacyDatabase.exec(
      "ALTER TABLE automation_runs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'observe'",
    );
    legacyDatabase.prepare(
      "UPDATE automation_runs SET execution_mode = 'automatic'",
    ).run();
    legacyDatabase.prepare(
      "DELETE FROM schema_migrations WHERE migration_key = 'remove-account-execution-mode-v1'",
    ).run();
    legacyDatabase.close();

    const reopenedStore = new AutomationStore(databasePath);
    expect(reopenedStore.listAutomationRuns("demo-account")[0]?.automatic).toBe(true);
    const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    expect(migratedDatabase.prepare("PRAGMA table_info(accounts)").all())
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "execution_mode" })]));
    expect(migratedDatabase.prepare("PRAGMA table_info(automation_runs)").all())
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "execution_mode" })]));
    migratedDatabase.close();
    reopenedStore.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps cookie and official API connections independent", () => {
    store.saveProviderConnectionSettings("demo-account", {
      kind: "cookie",
      advertiserId: "123",
      healthUrl: "https://ads.tiktok.com/api/read-only",
      campaignsUrl: "",
      adGroupsUrl: "",
      adsUrl: "",
    });
    store.saveProviderConnectionSettings("demo-account", {
      kind: "official-api",
      advertiserId: "456",
    });
    store.setProviderCredentialReference("demo-account", "cookie", "ref-cookie");
    store.setProviderCredentialReference(
      "demo-account",
      "official-api",
      "ref-api",
    );

    const connections = store.listProviderConnections("demo-account");
    expect(connections).toHaveLength(2);
    expect(connections.every((item) => item.hasCredential)).toBe(true);
  });

  it("persists provider authorization lifecycle and resets it with new credentials", () => {
    store.saveProviderConnectionSettings("demo-account", {
      kind: "official-api",
      advertiserId: "456",
    });
    store.setProviderCredentialReference("demo-account", "official-api", "ref-api");
    store.updateProviderStatus("demo-account", "official-api", "ready", "ready");
    const active = store.updateProviderAuthorization("demo-account", "official-api", {
      status: "active",
      capabilityVersion: "official-contract-v1",
      capabilities: ["read-campaigns", "read-reports", "change-status"],
      expiresAt: "2026-08-18T00:00:00.000Z",
    });
    expect(active).toMatchObject({
      authorizationStatus: "active",
      capabilityVersion: "official-contract-v1",
      authorizedCapabilities: ["read-campaigns", "read-reports", "change-status"],
      authorizationExpiresAt: "2026-08-18T00:00:00.000Z",
    });
    expect(active.authorizedAt).not.toBeNull();

    const reset = store.setProviderCredentialReference(
      "demo-account",
      "official-api",
      "ref-api-replaced",
    );
    expect(reset).toMatchObject({
      status: "untested",
      authorizationStatus: "not-authorized",
      capabilityVersion: "legacy-unversioned",
      authorizedCapabilities: [],
      authorizedAt: null,
      authorizationExpiresAt: null,
    });
  });

  it("creates an independent advertising account", () => {
    const account = store.createAccount({
      displayName: "第二广告账户",
      accountType: "agency",
      enabled: true,
      providerKind: "official-api",
    });

    expect(account.accountType).toBe("agency");
    expect(store.listGlobalThresholds()).toHaveLength(6);
    expect(store.getAutomationSwitches(account.id)).toMatchObject({
      manageCampaignStatus: true,
      manageAdGroupStatus: true,
      manageAdStatus: true,
    });
  });

  it("stores metric snapshots and excludes ignored entities", () => {
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
            row_data: { stat_cost: "12.5", cpc: "1.25", click_cnt: "10" },
          },
        },
      ],
      {
        startedAt: now,
        finishedAt: now,
        counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
        warnings: [],
        quality: healthySyncQuality(now),
      },
    );

    expect(
      store.listMetricSnapshots("demo-account", "cookie", "2020-01-01T00:00:00.000Z"),
    ).toHaveLength(1);
    store.setEntityIgnored(
      "demo-account",
      "cookie",
      "ad-group",
      "adgroup-1",
      "人工排除",
    );
    expect(store.listManagedEntities("demo-account", "cookie")[0]).toMatchObject({
      name: "测试组",
      ignored: true,
      metrics: { spend: 12.5, cost_per_click: 1.25 },
    });
  });

  // 广告层的派生请求在 TikTok 侧慢且不稳。此前只要它失败，整轮同步就一个实体都不写，
  // 广告组快照原地不动——删除和自动复制读到的要么是旧数据，要么被整轮跳过。
  it("refreshes the layers a partial sync completed without wiping the layer that failed", () => {
    const first = new Date("2026-08-05T00:00:00.000Z").toISOString();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      [
        { entityType: "ad-group", externalId: "adgroup-1", payload: { ad_name: "旧名字", ad_primary_status: "enable" } },
        { entityType: "ad", externalId: "ad-1", payload: { ad_name: "广告一", creative_id: "ad-1" } },
      ],
      {
        startedAt: first,
        finishedAt: first,
        counts: { campaign: 0, "ad-group": 1, ad: 1, material: 0 },
        warnings: [],
        quality: healthySyncQuality(first),
      },
    );

    // 第二轮：广告层超时，只有广告组层取全。
    const second = new Date("2026-08-05T00:05:00.000Z").toISOString();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      [
        { entityType: "ad-group", externalId: "adgroup-1", payload: { ad_name: "新名字", ad_primary_status: "disable" } },
      ],
      {
        startedAt: second,
        finishedAt: second,
        counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
        warnings: ["ad 层超时"],
        quality: {
          ...healthySyncQuality(first),
          status: "partial" as const,
          partialFailures: ["ad:derived-request-failed"],
          completeEntityTypes: ["ad-group" as const],
        },
      },
    );

    const current = store.listCurrentProviderEntities("demo-account", "cookie");
    const adGroup = current.find((entity) => entity.entityType === "ad-group");
    const ad = current.find((entity) => entity.entityType === "ad");

    // 取全的层级刷新到了本轮的新值。
    expect(adGroup?.payload).toMatchObject({ ad_name: "新名字", ad_primary_status: "disable" });
    // 失败的层级保持上一轮的数据，不被下线，也不被清空。
    expect(ad?.payload).toMatchObject({ ad_name: "广告一" });
  });

  // 2026-08-06：66 个广告组的删除停在 validation 阶段（请求都没构造出来），却按
  // "已尝试过" 被永久排除，根因修好也永远轮不到它们。发出去过的才该占坑。
  it("keeps an ad group deletable after a failure that never left validation", () => {
    const disabledAt = new Date(Date.now() - 48 * 3600_000).toISOString();
    const setup = (externalId: string) => {
      const op = store.recordAdOperation({
        accountId: "demo-account",
        providerKind: "cookie",
        entityType: "ad-group",
        externalId,
        entityName: externalId,
        action: "disable",
        source: "automation",
        status: "succeeded",
        message: "disabled",
      });
      (store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } }).db
        .prepare("UPDATE ad_operations SET completed_at = ? WHERE id = ?")
        .run(disabledAt, op.id);
    };
    const now = new Date().toISOString();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      ["never-sent", "dispatched"].map((id) => ({
        entityType: "ad-group" as const,
        externalId: id,
        payload: { campaign_id: "campaign-1", ad_name: id, ad_primary_status: "disable" },
      })),
      {
        startedAt: now,
        finishedAt: now,
        counts: { campaign: 0, "ad-group": 2, ad: 0, material: 0 },
        warnings: [],
        quality: healthySyncQuality(now),
      },
    );
    setup("never-sent");
    setup("dispatched");

    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } }).db;
    for (const [externalId, phase] of [["never-sent", "validation"], ["dispatched", "dispatch"]]) {
      const task = store.queueAdGroupDeletionIfAbsent("demo-account", "cookie", externalId!)!;
      store.completeAdGroupDeletion(task.id, "failed", "失败");
      db.prepare("UPDATE ad_operations SET phase = ? WHERE id = ?").run(phase, task.id);
    }

    const ready = store
      .listDeletionReadyAdGroups("demo-account", "cookie", new Date().toISOString())
      .map((entity) => entity.externalId);

    expect(ready).toContain("never-sent");
    expect(ready).not.toContain("dispatched");
    // 重新排队也必须放行，否则选出来了照样下不了单。
    expect(store.queueAdGroupDeletionIfAbsent("demo-account", "cookie", "never-sent")).not.toBeNull();
    expect(store.queueAdGroupDeletionIfAbsent("demo-account", "cookie", "dispatched")).toBeNull();
  });

  it("refreshes nothing when the provider contract drifted", () => {
    const first = new Date("2026-08-05T00:00:00.000Z").toISOString();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      [{ entityType: "ad-group", externalId: "adgroup-1", payload: { ad_name: "旧名字" } }],
      {
        startedAt: first,
        finishedAt: first,
        counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
        warnings: [],
        quality: healthySyncQuality(first),
      },
    );

    const second = new Date("2026-08-05T00:05:00.000Z").toISOString();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      [{ entityType: "ad-group", externalId: "adgroup-1", payload: { ad_name: "不该被采信" } }],
      {
        startedAt: second,
        finishedAt: second,
        counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
        warnings: [],
        quality: { ...healthySyncQuality(first), status: "invalid" as const, contractValid: false },
      },
    );

    expect(
      store.listCurrentProviderEntities("demo-account", "cookie")[0]?.payload,
    ).toMatchObject({ ad_name: "旧名字" });
  });

  it("returns the newest three-level sync result for automation observability", () => {
    const finishedAt = new Date().toISOString();
    store.saveReadOnlySync("demo-account", "cookie", [], {
      startedAt: finishedAt,
      finishedAt,
      counts: { campaign: 1, "ad-group": 1, ad: 1, material: 0 },
      warnings: [],
      quality: healthySyncQuality(finishedAt),
    });

    expect(store.getLatestReadOnlySync("demo-account", "cookie")).toEqual({
      startedAt: finishedAt,
      finishedAt,
      counts: { campaign: 1, "ad-group": 1, ad: 1, material: 0 },
      warnings: [],
      quality: healthySyncQuality(finishedAt),
    });
  });

  it("defaults missing fields when reading a legacy automation feature settings row", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tk-legacy-")), "legacy.db");
    const seedStore = new AutomationStore(dbPath);
    seedStore.seed();
    seedStore.close();

    // Simulate a row written before appeal.enabled existed.
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE automation_feature_settings SET settings_json = ? WHERE id = 1").run(
      JSON.stringify({
        appeal: { textTemplate: "旧模板", retryLimit: 1 },
        copy: { namingTemplate: "{source_name}", startPaused: true, copyBudget: false },
        deletion: { onlyDisabled: true, gracePeriodHours: 24 },
      }),
    );
    raw.close();

    const reopened = new AutomationStore(dbPath);
    expect(() => reopened.getAutomationFeatureSettings()).not.toThrow();
    const settings = reopened.getAutomationFeatureSettings();
    expect(settings.appeal.enabled).toBe(defaultAutomationFeatureSettings.appeal.enabled);
    expect(settings.appeal.scheduleHours).toEqual([1, 12]);
    expect(settings.appeal.textTemplate).toBe("旧模板");
    expect(settings.copy.autoCopyEnabled).toBe(false);
    expect(settings.copy.autoCopyCount).toBe(2);
    expect(settings.copy.autoCopyDailyAccountLimit).toBe(20);
    expect(settings.copy.autoCopyCutoffHour).toBe(12);
    expect(settings.deletion.enabled).toBe(false);
    expect(settings.deletion.maxConversions).toBe(0);
    expect(settings.deletion.maxCarts).toBe(4);
    expect(settings.deletion.scheduleHour).toBe(6);
    reopened.close();
    rmSync(dbPath, { force: true });
  });

  it("persists the global runtime, extension settings, and ad-group schedules", () => {
    expect(store.getSystemRuntimeState().enabled).toBe(true);
    expect(store.updateSystemRuntimeState({ enabled: false }).enabled).toBe(false);

    const features = store.getAutomationFeatureSettings();
    features.appeal.retryLimit = 2;
    expect(store.updateAutomationFeatureSettings(features).appeal.retryLimit).toBe(2);

    saveEntity(store, "ad-group", "group-1", "测试广告组");
    const once = store.createOneTimeSchedule("demo-account", {
      externalId: "group-1",
      action: "disable",
      runAt: "2026-07-16T15:00:00.000Z",
    });
    const overnight = store.createOvernightSchedule("demo-account", {
      externalId: "group-1",
      disableAt: "2026-07-16T15:30:00.000Z",
      enableAt: "2026-07-17T00:00:00.000Z",
    });
    expect(once.scheduleType).toBe("once");
    expect(overnight).toHaveLength(2);
    expect(store.listScheduledActions("demo-account")).toHaveLength(3);
    expect(
      store.listDueScheduledActions(
        "demo-account",
        "2026-07-16T16:00:00.000Z",
      ),
    ).toHaveLength(2);
  });

  it("serializes same-plan same-account campaign creation scopes", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-creation-lock-"));
    const databasePath = join(directory, "shared.db");
    const first = new AutomationStore(databasePath);
    const second = new AutomationStore(databasePath);
    try {
      first.seed();
      const plan = first.createMultiAccountLaunchPlan({
        mode: "single",
        sourceAccountId: "demo-account",
        sourceAdGroupId: null,
        targetAccountIds: ["demo-account"],
        launchPresetId: "default-launch-preset",
        launchRows: [launchItemRow(2)],
      });

      expect(first.claimLaunchCreationScope(plan.id, "demo-account", "系列", "owner-1"))
        .toEqual({ campaignId: null, adGroupNames: [] });
      expect(second.claimLaunchCreationScope(plan.id, "demo-account", "系列", "owner-2")).toBeNull();
      expect(second.renewLaunchCreationScope(plan.id, "demo-account", "系列", "owner-2")).toBe(false);
      expect(first.renewLaunchCreationScope(plan.id, "demo-account", "系列", "owner-1")).toBe(true);
      second.releaseLaunchCreationScope(plan.id, "demo-account", "系列", "owner-2");
      expect(second.claimLaunchCreationScope(plan.id, "demo-account", "系列", "owner-2")).toBeNull();
      first.releaseLaunchCreationScope(plan.id, "demo-account", "系列", "owner-1");
      expect(second.claimLaunchCreationScope(plan.id, "demo-account", "系列", "owner-2"))
        .toEqual({ campaignId: null, adGroupNames: [] });
      expect(second.completeLaunchCreationScope(
        plan.id, "demo-account", "系列", "owner-2", "campaign-1", "group-001",
      )).toBe(true);
      expect(first.claimLaunchCreationScope(plan.id, "demo-account", "系列", "owner-3"))
        .toEqual({ campaignId: "campaign-1", adGroupNames: ["group-001"] });
      first.markLaunchCreationScopeUncertain(plan.id, "demo-account", "系列", "owner-3");
      expect(second.claimLaunchCreationScope(plan.id, "demo-account", "系列", "owner-4")).toBeNull();
    } finally {
      second.close();
      first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates legacy creation locks fail-closed and makes owner nullable", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-creation-lock-migration-"));
    const databasePath = join(directory, "shared.db");
    const original = new AutomationStore(databasePath);
    original.seed();
    const plan = original.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdGroupId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    });
    original.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DELETE FROM schema_migrations WHERE migration_key = 'launch-creation-locks-v2';
      DROP TABLE launch_creation_locks;
      CREATE TABLE launch_creation_locks (
        plan_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        campaign_name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY (plan_id, account_id, campaign_name)
      );
    `);
    legacy.prepare(
      "INSERT INTO launch_creation_locks VALUES (?, ?, ?, ?, ?)",
    ).run(plan.id, "demo-account", "campaign-2", "legacy-owner", new Date().toISOString());
    legacy.close();

    const migrated = new AutomationStore(databasePath);
    const inspection = new DatabaseSync(databasePath);
    const columns = inspection.prepare("PRAGMA table_info(launch_creation_locks)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(columns.find((column) => column.name === "owner_id")?.notnull).toBe(0);
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "campaign_id", "ad_group_names_json", "uncertain",
    ]));
    expect(migrated.claimLaunchCreationScope(
      plan.id, "demo-account", "campaign-2", "new-owner",
    )).toBeNull();
    inspection.close();
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("stores a non-executing multi-account launch plan", () => {
    const target = store.createAccount({
      displayName: "目标账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    saveCopySource(store, "ad-1", "video-source");
    saveTargetAsset(store, target.id, "video-001");
    const input = {
      sourceAccountId: "demo-account",
      sourceAdGroupId: "ad-1",
      targetAccountIds: [target.id],
      launchPresetId: "default-launch-preset",
      launchRows: [{
        rowNumber: 2,
        campaignName: "测试系列",
        videoCode: "video-001",
        productUrl: "https://example.com/product",
        adGroupName: "测试广告组",
        adName: "260716:001",
        region: "未设置",
        dailyBudget: 100,
        bid: null,
        startAt: null,
        endAt: null,
        initialStatus: "disabled" as const,
      }],
    };
    const preview = createLaunchCopyPreview(store, input);
    const plan = store.createMultiAccountLaunchPlan({
      mode: "copy",
      ...input,
      copyPreviewId: preview.id,
    });
    expect(plan.status).toBe("blocked");
    expect(plan.message).toContain("等待创建执行器发布");
    expect(store.listLaunchPlanItems(plan.id)[0]).toMatchObject({
      templateMode: "none",
      templateCampaignId: null,
      sourceSnapshot: { adGroupId: "ad-1", campaignId: "campaign-template" },
      targetPostMapping: {
        posts: [expect.objectContaining({ itemId: "post-ad-1" })],
      },
      idempotencyKey: expect.any(String),
    });
  });

  it("stores spreadsheet launch rows without duplicating account selection", () => {
    const target = store.createAccount({
      displayName: "表格目标账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    saveCopySource(store, "ad-sheet", "video-source");
    saveTargetAsset(store, target.id, "video-001");
    const input = {
      sourceAccountId: "demo-account",
      sourceAdGroupId: "ad-sheet",
      targetAccountIds: [target.id],
      launchPresetId: "default-launch-preset",
      launchRows: [{
        rowNumber: 2,
        campaignName: "测试系列",
        videoCode: "video-001",
        productUrl: "https://example.com/product",
        adGroupName: "测试组",
        adName: "测试广告",
        region: "未设置",
        dailyBudget: 100,
        bid: null,
        startAt: null,
        endAt: null,
        initialStatus: "disabled" as const,
      }],
    };
    const preview = createLaunchCopyPreview(store, input);
    const plan = store.createMultiAccountLaunchPlan({
      mode: "copy",
      ...input,
      copyPreviewId: preview.id,
    });

    expect(plan.launchRows).toHaveLength(1);
    expect(plan.launchRows[0]?.campaignName).toBe("测试系列");
    expect(store.listMultiAccountLaunchPlans()[0]?.launchRows).toEqual(plan.launchRows);
  });

  it("deduplicates repeated plan submissions by client request id", () => {
    const target = store.createAccount({
      displayName: "幂等目标账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    const input = {
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      mode: "multi" as const,
      sourceAccountId: target.id,
      sourceAdGroupId: null,
      targetAccountIds: [target.id],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    };

    const first = store.createMultiAccountLaunchPlan(input);
    const repeated = store.createMultiAccountLaunchPlan(input);

    expect(repeated.id).toBe(first.id);
    expect(store.listLaunchPlanItems(first.id)).toHaveLength(1);
    expect(() => store.createMultiAccountLaunchPlan({
      ...input,
      launchRows: [{ ...input.launchRows[0]!, adGroupName: "不同广告组" }],
    })).toThrow("同一创建请求标识已用于不同的表格或账户范围");
  });

  it("blocks copy migration when a target account has no synced asset evidence", () => {
    const target = store.createAccount({
      displayName: "无素材目标账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    saveCopySource(store, "source-for-missing-asset", "source-video");
    saveTargetAsset(store, target.id, "different-video");
    const input = {
      sourceAccountId: "demo-account",
      sourceAdGroupId: "source-for-missing-asset",
      targetAccountIds: [target.id],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    };

    const preview = createLaunchCopyPreview(store, input, { missingAccountIds: [target.id] });

    expect(preview.safeToCreate).toBe(false);
    expect(preview.blockers.join(" ")).toContain("无法使用帖子");
    // 唯一的目标账户都没产出条目，计划里一条都没有，此时才拒绝——并且把原因说清楚，
    // 而不是笼统一句「仍有阻断项」。
    expect(() => store.createMultiAccountLaunchPlan({
      ...input,
      mode: "copy",
      copyPreviewId: preview.id,
    })).toThrow("没有产出任何可创建的广告组");
  });

  // 跨账户复制最常见的阻断项就是「某个目标账户没授权到这条原帖」。没授权的本来就
  // 复制不过去，不该因此把整个计划挡在创建之前——能建的先建，建不了的执行时自己
  // 失败（系列批次已改为逐条隔离）。
  it("部分目标账户缺素材时照常建计划，只跳过缺的那个账户", () => {
    const good = store.createAccount({
      displayName: "有素材目标账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    const bad = store.createAccount({
      displayName: "无素材目标账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    saveCopySource(store, "source-for-partial", "source-video");
    saveTargetAsset(store, good.id, "source-video");
    saveTargetAsset(store, bad.id, "different-video");
    const input = {
      sourceAccountId: "demo-account",
      sourceAdGroupId: "source-for-partial",
      targetAccountIds: [good.id, bad.id],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    };

    const preview = createLaunchCopyPreview(store, input, { missingAccountIds: [bad.id] });
    expect(preview.safeToCreate).toBe(false);

    const plan = store.createMultiAccountLaunchPlan({
      ...input,
      mode: "copy",
      copyPreviewId: preview.id,
    });

    const items = store.listLaunchPlanItems(plan.id);
    expect(items.length).toBeGreaterThan(0);
    // 缺素材的那个账户一条都没进来，有素材的照常建。
    expect(items.every((item) => item.accountId === good.id)).toBe(true);
  });

  // 预览过期只说明冻结的证据可能变旧，执行时会重新回读并逐条校验；为此把人挡在
  // 创建之前、要求重新生成一遍，是拿确定的麻烦去防执行时本来就会发现的问题。
  it("预览过期不再阻断创建", () => {
    saveCopySource(store, "source-for-expired", "source-video");
    const target = store.createAccount({
      displayName: "过期预览目标账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    saveTargetAsset(store, target.id, "source-video");
    const input = {
      sourceAccountId: "demo-account",
      sourceAdGroupId: "source-for-expired",
      targetAccountIds: [target.id],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    };
    const preview = createLaunchCopyPreview(store, input);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(new Date(preview.expiresAt).getTime() + 60_000));
    // 时间确实推过了有效期，否则这条用例什么都没测。
    expect(Date.now()).toBeGreaterThan(new Date(preview.expiresAt).getTime());

    const plan = store.createMultiAccountLaunchPlan({
      ...input,
      mode: "copy",
      copyPreviewId: preview.id,
    });

    expect(store.listLaunchPlanItems(plan.id).length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("limits a copy preview to 100 generated ad groups", () => {
    const accountIds = ["target-a", "target-b", "target-c", "target-d", "target-e", "target-f"];
    expect(() => createLaunchCopyPreview(store, {
      sourceAccountId: "demo-account",
      sourceAdGroupId: "source-ad",
      targetAccountIds: accountIds,
      launchPresetId: "default-launch-preset",
      launchRows: [],
      targetConfigs: accountIds.map((accountId) => ({
        accountId,
        quantity: 20,
        dailyBudget: 100,
        bid: null,
        initialStatus: "enabled" as const,
        startAtRule: "absolute" as const,
        startAt: null,
      })),
    })).toThrow("单次迁移最多创建 100 个广告组");
  });

  it("expands each target configuration into frozen original-post migration items", () => {
    const target = store.createAccount({
      displayName: "逐账户配置目标",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    saveCopySource(store, "source-configured-copy", "source-video");
    saveTargetAsset(store, target.id, "target-video");
    const defaultPreset = store.listLaunchPresets().find((item) => item.id === "default-launch-preset")!;
    store.updateLaunchPreset(defaultPreset.id, { ...defaultPreset, initialStatus: "disabled" });
    const targetConfigs = [{
      accountId: target.id,
      quantity: 2,
      dailyBudget: 345,
      bid: 6.7,
      initialStatus: "enabled" as const,
      startAtRule: "next-six" as const,
      startAt: null,
    }];
    const preview = createLaunchCopyPreview(store, {
      sourceAccountId: "demo-account",
      sourceAdGroupId: "source-configured-copy",
      targetAccountIds: [target.id],
      launchPresetId: "default-launch-preset",
      launchRows: [],
      targetConfigs,
    });

    expect(preview.safeToCreate).toBe(true);
    expect(preview.items).toHaveLength(2);
    expect(preview.targetConfigs[0]?.initialStatus).toBe("enabled");
    expect(preview.items.every((item) => item.launchRow.initialStatus === "enabled")).toBe(true);
    expect(preview.items.every((item) => item.launchRow.dailyBudget === 345 && item.launchRow.bid === 6.7)).toBe(true);
    expect(preview.items.every((item) => item.launchRow.startAt !== null)).toBe(true);
    expect(new Set(preview.items.map((item) => item.launchRow.adGroupName)).size).toBe(2);
    expect(preview.items.map((item) => item.launchRow.adGroupName)).toEqual([
      expect.stringMatching(/^源广告组-\d{4}-1$/),
      expect.stringMatching(/^源广告组-\d{4}-2$/),
    ]);
    expect(createLaunchCopyPreview(store, {
      sourceAccountId: "demo-account",
      sourceAdGroupId: "source-configured-copy",
      targetAccountIds: [target.id],
      launchPresetId: "default-launch-preset",
      launchRows: [],
      targetConfigs,
    }).id).toBe(preview.id);

    const plan = store.createMultiAccountLaunchPlan({
      mode: "copy",
      sourceAccountId: "demo-account",
      sourceAdGroupId: "source-configured-copy",
      copyPreviewId: preview.id,
      targetAccountIds: [target.id],
      launchPresetId: "default-launch-preset",
      launchRows: preview.launchRows,
      copyTargetConfigs: targetConfigs,
    });
    expect(store.listLaunchPlanItems(plan.id)).toHaveLength(2);
  });

  it("multiplies each target quantity across multiple selected source ad groups", () => {
    const target = store.createAccount({
      displayName: "多源迁移目标",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    const sourceAdGroupIds = ["source-multi-a", "source-multi-b"];
    saveTargetAsset(store, target.id, "target-video");
    const targetConfigs = [{
      accountId: target.id,
      quantity: 2,
      dailyBudget: 200,
      bid: null,
      initialStatus: "enabled" as const,
      startAtRule: "absolute" as const,
      startAt: null,
    }];
    const input = {
      sourceAccountId: "demo-account",
      sourceAdGroupId: sourceAdGroupIds[0]!,
      sourceAdGroupIds,
      targetAccountIds: [target.id],
      launchPresetId: "default-launch-preset",
      launchRows: [],
      targetConfigs,
    };

    const preview = createLaunchCopyPreview(store, input);
    expect(preview.sourceSnapshots).toHaveLength(2);
    expect(preview.items).toHaveLength(4);
    expect(new Set(preview.items.map((item) => item.launchRow.adGroupName)).size).toBe(4);
    expect(preview.items.filter((item) => item.sourceSnapshot.adGroupId === sourceAdGroupIds[0])).toHaveLength(2);
    expect(preview.items.filter((item) => item.sourceSnapshot.adGroupId === sourceAdGroupIds[1])).toHaveLength(2);

    const plan = store.createMultiAccountLaunchPlan({
      ...input,
      mode: "copy",
      copyPreviewId: preview.id,
      launchRows: preview.launchRows,
      copyTargetConfigs: targetConfigs,
    });
    const items = store.listLaunchPlanItems(plan.id);
    expect(items).toHaveLength(4);
    expect(items.map((item) => [
      item.sourceSnapshot?.adGroupId,
      item.targetPostMapping?.sourceAdGroupId,
    ])).toEqual([
      [sourceAdGroupIds[0], sourceAdGroupIds[0]],
      [sourceAdGroupIds[0], sourceAdGroupIds[0]],
      [sourceAdGroupIds[1], sourceAdGroupIds[1]],
      [sourceAdGroupIds[1], sourceAdGroupIds[1]],
    ]);
  });

  it("freezes the reviewed preset content before a copy plan is confirmed", () => {
    const target = store.createAccount({
      displayName: "预设冻结目标账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    saveCopySource(store, "source-preset-snapshot", "source-video");
    saveTargetAsset(store, target.id, "video-2");
    const originalPreset = store.listLaunchPresets()
      .find((preset) => preset.id === "default-launch-preset")!;
    const input = {
      sourceAccountId: "demo-account",
      sourceAdGroupId: "source-preset-snapshot",
      targetAccountIds: [target.id],
      launchPresetId: originalPreset.id,
      launchRows: [launchItemRow(2)],
    };
    const preview = createLaunchCopyPreview(store, input);

    store.updateLaunchPreset(originalPreset.id, {
      name: originalPreset.name,
      region: originalPreset.region,
      dailyBudget: originalPreset.dailyBudget + 999,
      bid: originalPreset.bid,
      startAt: originalPreset.startAt,
      endAt: originalPreset.endAt,
      initialStatus: originalPreset.initialStatus,
      creationConfig: {
        ...originalPreset.creationConfig,
        objectiveType: 999,
      },
    });
    const plan = store.createMultiAccountLaunchPlan({
      ...input,
      mode: "copy",
      copyPreviewId: preview.id,
    });

    expect(preview.presetSnapshotHash).toEqual(expect.any(String));
    expect(preview.presetSnapshot.dailyBudget).toBe(originalPreset.dailyBudget);
    expect(plan.presetSnapshot).toEqual(preview.presetSnapshot);
    expect(plan.launchRows[0]?.dailyBudget).toBe(originalPreset.dailyBudget);
    expect(plan.presetSnapshot?.creationConfig.objectiveType)
      .toBe(originalPreset.creationConfig.objectiveType);
  });

  it("uses one copy preview as the idempotency boundary and detects frozen evidence corruption", () => {
    const target = store.createAccount({
      displayName: "幂等目标账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    saveCopySource(store, "source-idempotent", "source-video");
    saveTargetAsset(store, target.id, "video-2");
    const input = {
      sourceAccountId: "demo-account",
      sourceAdGroupId: "source-idempotent",
      targetAccountIds: [target.id],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    };
    const preview = createLaunchCopyPreview(store, input);

    const first = store.createMultiAccountLaunchPlan({ ...input, mode: "copy", copyPreviewId: preview.id });
    const second = store.createMultiAccountLaunchPlan({ ...input, mode: "copy", copyPreviewId: preview.id });
    expect(second.id).toBe(first.id);
    expect(() => store.createMultiAccountLaunchPlan({
      ...input,
      mode: "copy",
      copyPreviewId: preview.id,
      launchRows: [{ ...input.launchRows[0]!, campaignName: "changed-after-preview" }],
    })).toThrow("表格内容在预览后已变化");

    const database = (store as unknown as { db: DatabaseSync }).db;
    const item = store.listLaunchPlanItems(first.id)[0]!;
    database.prepare("UPDATE launch_plan_items SET source_snapshot_json = ? WHERE item_id = ?")
      .run(JSON.stringify({
        ...item.sourceSnapshot,
        posts: item.sourceSnapshot!.posts.map((post) => ({ ...post, vid: "tampered" })),
      }), item.itemId);
    expect(() => store.validateLaunchCopyItem(store.listLaunchPlanItems(first.id)[0]!))
      .toThrow("源广告组原帖快照校验失败");
  });

  it("keeps legacy plans with no imported rows readable after an upgrade", () => {
    (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare(`INSERT INTO multi_account_launch_plans (
        id, source_account_id, source_ad_id, source_ad_name, target_account_ids_json,
        naming_template, start_paused, launch_mode, launch_preset_id, preset_name, preset_snapshot_json,
        launch_rows_json, status, message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "legacy-empty-plan", "demo-account", "__new__", "从零创建", JSON.stringify(["demo-account"]),
        "YYMMDD:XXX", 1, "single", "default-launch-preset", "基础预设", null,
        "[]", "blocked", "旧版本计划", "2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z",
      );

    expect(store.listMultiAccountLaunchPlans().find((plan) => plan.id === "legacy-empty-plan"))
      .toMatchObject({ sourceAdGroupId: null, launchRows: [] });
  });

  it("keeps historical video-code copy items readable but permanently blocks dispatch", () => {
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdGroupId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    });
    const database = (store as unknown as { db: DatabaseSync }).db;
    database.prepare(
      "UPDATE launch_plan_items SET source_snapshot_json = ?, target_asset_mapping_json = ? WHERE plan_id = ?",
    ).run(
      JSON.stringify({
        accountId: "demo-account",
        adId: "legacy-source-ad",
        videoCode: "legacy-video-code",
      }),
      JSON.stringify({
        accountId: "demo-account",
        sourceVideoCode: "legacy-video-code",
        targetVideoCode: "legacy-video-code",
        evidenceAdId: "legacy-target-ad",
      }),
      plan.id,
    );

    const item = store.listLaunchPlanItems(plan.id)[0]!;
    expect(item).toMatchObject({
      legacyCopyUnsupported: true,
      sourceSnapshot: null,
      targetPostMapping: null,
    });
    expect(() => store.validateLaunchCopyItem(item)).toThrow("旧版视频代码复制流程已停用");
  });

  it("atomically claims a status write task and allows only failed tasks to retry", () => {
    const task = store.createStatusWriteTask({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "adgroup-1",
      entityName: "测试广告组",
      action: "disable",
      source: "manual",
    }, { id: "user-1", name: "验收员", kind: "user" });

    expect(store.claimStatusWriteTask(task.id, "executor-1")).toMatchObject({
      status: "running",
      attemptCount: 1,
    });
    expect(store.claimStatusWriteTask(task.id, "executor-2")).toBeNull();
    store.completeStatusWriteTask(task.id, "executor-1", "failed", "明确拒绝");
    expect(store.claimStatusWriteTask(task.id, "executor-2", "failed")).toMatchObject({
      status: "running",
      attemptCount: 2,
    });
    store.completeStatusWriteTask(task.id, "executor-2", "unknown", "结果待确认");
    expect(store.claimStatusWriteTask(task.id, "executor-3", "failed")).toBeNull();
    expect(store.listAdOperationAttempts(task.operationId).map((attempt) => attempt.status))
      .toEqual(["failed", "unknown"]);
  });

  it("marks an old healthy sync stale without losing its last healthy timestamp", () => {
    const finishedAt = "2020-01-01T00:00:00.000Z";
    store.saveReadOnlySync("demo-account", "cookie", [], {
      startedAt: finishedAt,
      finishedAt,
      counts: { campaign: 0, "ad-group": 0, ad: 0, material: 0 },
      warnings: [],
      quality: healthySyncQuality(finishedAt),
    });

    expect(store.getLatestReadOnlySync("demo-account", "cookie")?.quality).toMatchObject({
      status: "stale",
      lastHealthyAt: finishedAt,
    });
  });

  it("records partial diagnostics without replacing last-known-good entities or metrics", () => {
    const healthyAt = new Date().toISOString();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      [{ entityType: "ad-group", externalId: "healthy-group", payload: { metrics: { spend: "1" } } }],
      {
        startedAt: healthyAt,
        finishedAt: healthyAt,
        counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
        warnings: [],
        quality: healthySyncQuality(healthyAt),
      },
    );
    const partialAt = new Date(Date.now() + 1_000).toISOString();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      [{ entityType: "ad-group", externalId: "partial-group", payload: {} }],
      {
        startedAt: partialAt,
        finishedAt: partialAt,
        counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
        warnings: ["page incomplete"],
        quality: {
          ...healthySyncQuality(partialAt),
          status: "partial",
          paginationComplete: false,
          partialFailures: ["ad-group:pagination"],
        },
      },
    );

    expect(store.listProviderEntities("demo-account", "cookie").map((entity) => entity.externalId))
      .toEqual(["healthy-group"]);
    expect(store.listMetricSnapshots("demo-account", "cookie", "2020-01-01T00:00:00.000Z"))
      .toHaveLength(1);
    expect(store.getLatestReadOnlySync("demo-account", "cookie")?.quality).toMatchObject({
      status: "partial",
      lastHealthyAt: healthyAt,
    });
  });

  it("keeps healthy entities seen within the last 48 hours when a later page omits them", () => {
    const firstAt = new Date(Date.now() - 60 * 60_000).toISOString();
    store.saveReadOnlySync("demo-account", "cookie", [
      { entityType: "ad-group", externalId: "g1", payload: { adgroup_name: "组 1" } },
    ], {
      startedAt: firstAt,
      finishedAt: firstAt,
      counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
      warnings: [],
      quality: healthySyncQuality(firstAt),
    });
    const secondAt = new Date().toISOString();
    store.saveReadOnlySync("demo-account", "cookie", [
      { entityType: "ad-group", externalId: "g2", payload: { adgroup_name: "组 2" } },
    ], {
      startedAt: secondAt,
      finishedAt: secondAt,
      counts: { campaign: 0, "ad-group": 1, ad: 0, material: 0 },
      warnings: [],
      quality: healthySyncQuality(secondAt),
    });

    expect(store.listManagedEntities("demo-account", "cookie").map((entity) => entity.externalId))
      .toEqual(["g1", "g2"]);
    expect(store.listCurrentManagedEntities("demo-account", "cookie").map((entity) => entity.externalId))
      .toEqual(["g2"]);
  });

  it("blocks only executable legacy plans and preserves completed or cancelled history", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-launch-migration-"));
    const databasePath = join(directory, "automation.db");
    const original = new AutomationStore(databasePath);
    original.seed();
    const input = {
      mode: "single" as const,
      sourceAccountId: "demo-account",
      sourceAdGroupId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    };
    const blockedPlan = original.createMultiAccountLaunchPlan(input);
    const completedPlan = original.createMultiAccountLaunchPlan(input);
    const cancelledPlan = original.createMultiAccountLaunchPlan(input);
    original.close();

    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.prepare("DELETE FROM launch_plan_items").run();
    legacyDatabase.prepare("DELETE FROM schema_migrations WHERE migration_key = 'launch-plan-items-v1'").run();
    legacyDatabase.prepare("UPDATE multi_account_launch_plans SET status = 'completed', message = 'completed history' WHERE id = ?").run(completedPlan.id);
    legacyDatabase.prepare("UPDATE multi_account_launch_plans SET status = 'cancelled', message = 'cancelled history' WHERE id = ?").run(cancelledPlan.id);
    legacyDatabase.close();

    const migrated = new AutomationStore(databasePath);
    expect(migrated.listLaunchPlanItems(blockedPlan.id)).toEqual([]);
    expect(migrated.getMultiAccountLaunchPlan(blockedPlan.id)).toMatchObject({
      status: "blocked",
      message: expect.stringContaining("旧版计划没有逐项执行记录"),
    });
    expect(migrated.getMultiAccountLaunchPlan(completedPlan.id)).toMatchObject({
      status: "completed",
      message: "completed history",
    });
    expect(migrated.getMultiAccountLaunchPlan(cancelledPlan.id)).toMatchObject({
      status: "cancelled",
      message: "cancelled history",
    });
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("adds the launch item idempotency column before creating its index", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-launch-column-migration-"));
    const databasePath = join(directory, "automation.db");
    const original = new AutomationStore(databasePath);
    original.close();

    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`
      DROP INDEX launch_plan_items_idempotency;
      ALTER TABLE launch_plan_items DROP COLUMN idempotency_key;
    `);
    legacyDatabase.close();

    const migrated = new AutomationStore(databasePath);
    const inspectionDatabase = new DatabaseSync(databasePath);
    const columns = inspectionDatabase
      .prepare("PRAGMA table_info(launch_plan_items)")
      .all() as Array<{ name: string }>;

    expect(columns.some((column) => column.name === "idempotency_key")).toBe(true);
    inspectionDatabase.close();
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("backs up an existing database before migration and aborts on failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-store-failed-migration-"));
    const databasePath = join(directory, "automation.db");
    writeFileSync(databasePath, "not a sqlite database", "utf8");

    expect(() => new AutomationStore(databasePath)).toThrow(
      "数据库迁移失败，服务未启动",
    );
    expect(
      readdirSync(directory).some((name) =>
        name.startsWith("automation.db.pre-migration-") && name.endsWith(".bak"),
      ),
    ).toBe(true);

    rmSync(directory, { recursive: true, force: true });
  });

  it("does not replace the source database when consistent snapshot promotion fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-snapshot-promotion-"));
    const databasePath = join(directory, "automation.db");
    const writer = new DatabaseSync(databasePath);
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE committed_in_wal (value TEXT NOT NULL);
      INSERT INTO committed_in_wal (value) VALUES ('preserve-me');
    `);
    expect(existsSync(`${databasePath}-wal`)).toBe(true);

    const originalPrepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === "VACUUM INTO ?") throw new Error("simulated snapshot promotion failure");
      return originalPrepare.call(this, sql);
    });

    expect(() => new AutomationStore(databasePath)).toThrow("simulated snapshot promotion failure");
    expect(existsSync(`${databasePath}-wal`)).toBe(true);
    expect(writer.prepare("SELECT value FROM committed_in_wal").get()).toEqual({
      value: "preserve-me",
    });

    writer.close();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("records the authenticated audit actor and request correlation", () => {
    store.enterAuditContext({
      actor: { id: "admin-1", name: "审计管理员", kind: "user" },
      requestId: "request-123",
      correlationId: "correlation-123",
    });
    store.updateSystemRuntimeState({ enabled: false });

    expect(store.listAuditLogs({ limit: 10, actorId: "admin-1" })[0]).toMatchObject({
      actor: { id: "admin-1", name: "审计管理员", kind: "user" },
      action: "global.runtime.updated",
      correlationId: "correlation-123",
      requestId: "request-123",
    });
  });

  it("creates a consistent backup and restores it on the next startup", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-restore-drill-"));
    const databasePath = join(directory, "automation.db");
    const original = new AutomationStore(databasePath, { appVersion: "1.3.2" });
    original.seed();
    const backup = original.createDatabaseBackup("manual");
    const added = original.createAccount({
      displayName: "备份后新增账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    expect(original.verifyDatabaseBackup(backup.id).status).toBe("verified");
    original.requestDatabaseRestore(backup.id);
    original.close();

    const applied = applyPendingDatabaseRestore(databasePath);
    expect(applied).not.toBeNull();
    const restored = new AutomationStore(databasePath, { appVersion: "1.3.2" });
    expect(restored.getAccount(added.id)).toBeNull();
    restored.close();
    finalizePendingDatabaseRestore(applied!);
    rmSync(directory, { recursive: true, force: true });
  });

  it("counts a restore rollback snapshot inside the five-backup retention limit", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-restore-retention-"));
    const databasePath = join(directory, "automation.db");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T00:00:00.000Z"));
    const original = new AutomationStore(databasePath, { appVersion: "1.3.2" });
    original.seed();
    let restoreSource = original.createDatabaseBackup("manual");
    for (let index = 1; index < 5; index += 1) {
      vi.setSystemTime(new Date(`2026-07-18T00:00:0${index}.000Z`));
      restoreSource = original.createDatabaseBackup("manual");
    }
    original.requestDatabaseRestore(restoreSource.id);
    original.close();
    copyFileSync(
      databasePath,
      `${databasePath}.restore-rollback-2026-07-17T23-59-00-000Z.bak`,
    );

    vi.setSystemTime(new Date("2026-07-18T00:01:00.000Z"));
    const applied = applyPendingDatabaseRestore(databasePath)!;
    const restored = new AutomationStore(databasePath, { appVersion: "1.3.2" });
    const rollback = restored.registerRestoreRollbackBackup(applied.rollbackPath!);
    finalizePendingDatabaseRestore(applied);

    expect(rollback).toMatchObject({ kind: "restore-rollback", status: "verified" });
    expect(restored.listDatabaseBackups().length).toBeLessThanOrEqual(5);
    expect(restored.listDatabaseBackups()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: rollback!.id }),
    ]));
    expect(readdirSync(directory).filter((name) => name.endsWith(".bak")).length)
      .toBeLessThanOrEqual(5);
    restored.close();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  it("never re-certifies a modified but structurally valid backup", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-backup-immutable-"));
    const databasePath = join(directory, "automation.db");
    const original = new AutomationStore(databasePath, { appVersion: "1.3.2" });
    original.seed();
    const backup = original.createDatabaseBackup("manual");
    const backupPath = join(directory, backup.fileName);
    const modified = new DatabaseSync(backupPath);
    modified.exec("CREATE TABLE tampered_but_valid (id TEXT PRIMARY KEY)");
    modified.close();

    const verified = original.verifyDatabaseBackup(backup.id);
    expect(verified).toMatchObject({
      status: "invalid",
      sha256: backup.sha256,
      sizeBytes: backup.sizeBytes,
    });
    expect(verified.errorMessage).toContain("创建时记录");
    expect(() => original.requestDatabaseRestore(backup.id)).toThrow("创建时记录");

    original.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("clears a rejected restore marker without changing the current database", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-restore-rejected-"));
    const databasePath = join(directory, "automation.db");
    const original = new AutomationStore(databasePath, { appVersion: "1.3.2" });
    original.seed();
    const account = original.createAccount({
      displayName: "必须保留的账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    const backup = original.createDatabaseBackup("manual");
    original.requestDatabaseRestore(backup.id);
    original.close();
    writeFileSync(join(directory, backup.fileName), "corrupted-after-request", "utf8");

    expect(() => applyPendingDatabaseRestore(databasePath)).toThrow();
    expect(existsSync(`${databasePath}.restore-request.json`)).toBe(false);
    const reopened = new AutomationStore(databasePath, { appVersion: "1.3.2" });
    expect(reopened.getAccount(account.id)?.displayName).toBe("必须保留的账户");
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("rolls the database file back when an old-version upgrade fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-upgrade-rollback-"));
    const databasePath = join(directory, "automation.db");
    const original = new AutomationStore(databasePath);
    original.seed();
    original.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("DROP TABLE database_backups");
    legacy.close();

    vi.spyOn(MigrationRunner.prototype, "apply").mockImplementationOnce(() => {
      throw new Error("simulated upgrade failure");
    });
    expect(() => new AutomationStore(databasePath)).toThrow("数据库迁移失败，服务未启动");

    const inspected = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspected.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'database_backups'",
    ).get()).toBeUndefined();
    expect(inspected.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    inspected.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("uses the saved preset as the server authority and allocates unique automatic names", () => {
    const target = store.createAccount({ displayName: "预设目标", accountType: "standard", enabled: true, providerKind: "cookie" });
    const preset = store.createLaunchPreset({
      name: "美国预设", region: "US", dailyBudget: 250, bid: 2.5,
      startAt: "2026-07-20T08:00:00.000Z", endAt: null, initialStatus: "disabled",
    });
    const input = {
      mode: "multi" as const,
      sourceAccountId: target.id, sourceAdGroupId: null, targetAccountIds: [target.id], launchPresetId: preset.id,
      launchRows: [{ rowNumber: 2, campaignName: "系列", adGroupName: "组", videoCode: "v-1", productUrl: "https://example.com/p", adName: "client-provided", region: "wrong", dailyBudget: 1, bid: 99, startAt: null, endAt: null, initialStatus: "enabled" as const }],
    };
    const first = store.createMultiAccountLaunchPlan(input);
    const second = store.createMultiAccountLaunchPlan(input);

    expect(first.launchRows[0]).toMatchObject({ region: "US", dailyBudget: 250, bid: 2.5, startAt: "2026-07-20T08:00:00.000Z", initialStatus: "disabled" });
    expect(first.launchRows[0]?.adName).toMatch(/^\d{6}:\d{3}$/);
    expect(second.launchRows[0]?.adName).not.toBe(first.launchRows[0]?.adName);

    // Databases written before the region field was introduced must remain readable.
    const legacyRows = first.launchRows.map(({ region: _region, ...row }) => row);
    (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE multi_account_launch_plans SET launch_rows_json = ? WHERE id = ?")
      .run(JSON.stringify(legacyRows), first.id);
    expect(store.listMultiAccountLaunchPlans().find((plan) => plan.id === first.id)?.launchRows[0]?.region).toBe("未设置");
  });

  it("resolves a relative preset time per target account timezone when persisting launch items", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T09:15:00.000Z"));
    try {
      const preset = store.createLaunchPreset({
        name: "次日早上",
        region: "CN",
        dailyBudget: 50,
        bid: null,
        startAt: null,
        endAt: null,
        startAtRule: "tomorrow-morning",
        initialStatus: "enabled",
      });
      const plan = store.createMultiAccountLaunchPlan({
        mode: "single",
        sourceAccountId: "demo-account",
        sourceAdGroupId: null,
        targetAccountIds: ["demo-account"],
        launchPresetId: preset.id,
        launchRows: [launchItemRow(2)],
      });

      expect(store.listLaunchPlanItems(plan.id)[0]?.launchRow.startAt).toBe("2026-07-23T22:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("freezes and reuses each target account's reviewed relative launch time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T09:15:00.000Z"));
    try {
      const east = store.createAccount({
        displayName: "东八区目标",
        accountType: "standard",
        enabled: true,
        providerKind: "cookie",
      });
      const west = store.createAccount({
        displayName: "纽约目标",
        accountType: "standard",
        enabled: true,
        providerKind: "cookie",
      });
      const db = (store as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
      }).db;
      db.prepare("UPDATE accounts SET timezone = ? WHERE id = ?").run("Asia/Taipei", east.id);
      db.prepare("UPDATE accounts SET timezone = ? WHERE id = ?").run("America/New_York", west.id);
      saveCopySource(store, "source-relative-preview", "source-video");
      saveTargetAsset(store, east.id, "video-2");
      saveTargetAsset(store, west.id, "video-2");
      const preset = store.createLaunchPreset({
        name: "每账户次日早上",
        region: "US",
        dailyBudget: 50,
        bid: null,
        startAt: null,
        endAt: null,
        startAtRule: "tomorrow-morning",
        initialStatus: "enabled",
      });
      const input = {
        sourceAccountId: "demo-account",
        sourceAdGroupId: "source-relative-preview",
        targetAccountIds: [east.id, west.id],
        launchPresetId: preset.id,
        launchRows: [launchItemRow(2)],
      };

      const preview = createLaunchCopyPreview(store, input);
      const reviewedTimes = Object.fromEntries(
        preview.items.map((item) => [item.accountId, item.launchRow.startAt]),
      );
      expect(reviewedTimes).toEqual({
        [east.id]: "2026-07-23T22:00:00.000Z",
        [west.id]: "2026-07-24T10:00:00.000Z",
      });

      const plan = store.createMultiAccountLaunchPlan({
        ...input,
        mode: "copy",
        copyPreviewId: preview.id,
      });
      const persistedTimes = Object.fromEntries(
        store.listLaunchPlanItems(plan.id).map((item) => [item.accountId, item.launchRow.startAt]),
      );
      expect(persistedTimes).toEqual(reviewedTimes);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes metric snapshots older than the 90-day retention window", () => {
    const old = new Date(Date.now() - 91 * 24 * 60 * 60_000).toISOString();
    saveEntity(store, "ad-group", "old-group", "旧广告组", old);
    expect(
      store.listMetricSnapshots(
        "demo-account",
        "cookie",
        "2020-01-01T00:00:00.000Z",
      ),
    ).toHaveLength(0);
  });

  it("aggregates a complete detection batch beyond the old 5000-row limit", () => {
    const capturedAt = new Date().toISOString();
    const entities = Array.from({ length: 5_101 }, (_, index) => ({
      entityType: "ad-group" as const,
      externalId: `large-${index}`,
      payload: {
        adgroup_name: `广告组 ${index}`,
        adgroup_primary_status: "enable",
        row_data: { stat_cost: "1", click_cnt: "2", time_attr_convert_cnt: "3" },
      },
    }));
    store.saveReadOnlySync("demo-account", "cookie", entities, {
      startedAt: capturedAt,
      finishedAt: capturedAt,
      counts: { campaign: 0, "ad-group": entities.length, ad: 0, material: 0 },
      warnings: [],
      quality: healthySyncQuality(capturedAt),
    });

    expect(store.listMetricBatches("demo-account", "cookie", "2020-01-01T00:00:00.000Z")[0]).toMatchObject({
      capturedAt,
      count: 5_101,
      spend: 5_101,
      clicks: 10_202,
      conversions: 15_303,
    });
  });

  it("creates one durable launch item per target account and spreadsheet row", () => {
    const second = store.createAccount({
      displayName: "second target",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    const plan = store.createMultiAccountLaunchPlan({
      mode: "multi",
      sourceAccountId: "demo-account",
      sourceAdGroupId: null,
      targetAccountIds: ["demo-account", second.id],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2), launchItemRow(3)],
    }, { id: "user-creator", name: "创建人", kind: "user" });

    expect(store.listLaunchPlanItems(plan.id)).toHaveLength(4);
    expect(store.listLaunchPlanItems(plan.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: "demo-account", itemIndex: 0, templateMode: "none", status: "pending", attemptCount: 0, actor: { id: "user-creator", name: "创建人", kind: "user" } }),
      expect.objectContaining({ accountId: "demo-account", itemIndex: 1, templateMode: "none", status: "pending", attemptCount: 0 }),
      expect.objectContaining({ accountId: second.id, itemIndex: 0, templateMode: "none", status: "pending", attemptCount: 0 }),
      expect.objectContaining({ accountId: second.id, itemIndex: 1, templateMode: "none", status: "pending", attemptCount: 0 }),
    ]));
  });

  it("atomically claims a launch item and never reclaims a succeeded item", () => {
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdGroupId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    });
    const pending = store.listLaunchPlanItems(plan.id)[0]!;

    const claimed = store.claimLaunchPlanItem(pending.itemId, "executor-a", "pending");
    expect(claimed).toMatchObject({ status: "running", attemptCount: 1, claimedBy: "executor-a" });
    expect(store.claimLaunchPlanItem(pending.itemId, "executor-b", "pending")).toBeNull();
    expect(store.listLaunchPlanItemAttempts(pending.itemId)[0]?.actor).toEqual({
      id: "local-user",
      name: "本地用户",
      kind: "user",
    });

    store.completeLaunchPlanItemSuccess(pending.itemId, "executor-a", {
      campaignId: "campaign-1",
      adGroupId: "group-1",
      adId: "ad-1",
    });
    expect(store.claimLaunchPlanItem(pending.itemId, "executor-b", "pending")).toBeNull();
    expect(store.listLaunchPlanItems(plan.id)[0]).toMatchObject({
      status: "succeeded",
      campaignId: "campaign-1",
      adGroupId: "group-1",
      adId: "ad-1",
      errorMessage: null,
    });
  });

  it("allows only a failed item to be claimed for a later retry", () => {
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdGroupId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2), launchItemRow(3)],
    });
    const [first, second] = store.listLaunchPlanItems(plan.id);
    store.claimLaunchPlanItem(first!.itemId, "executor-a", "pending");
    store.completeLaunchPlanItemSuccess(first!.itemId, "executor-a", { campaignId: "c1", adGroupId: "g1", adId: "a1" });
    store.claimLaunchPlanItem(second!.itemId, "executor-a", "pending");
    store.completeLaunchPlanItemFailure(second!.itemId, "executor-a", "provider rejected row");

    expect(store.claimLaunchPlanItem(second!.itemId, "executor-b", "pending")).toBeNull();
    expect(store.claimLaunchPlanItem(second!.itemId, "executor-b", "failed")).toMatchObject({
      itemId: second!.itemId,
      status: "running",
      attemptCount: 2,
    });
    expect(store.listLaunchPlanItems(plan.id).find((item) => item.itemId === first!.itemId)).toMatchObject({
      status: "succeeded",
      attemptCount: 1,
    });
  });

  it("does not automatically retry an interrupted item but permits an explicit retry", () => {
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdGroupId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    });
    const pending = store.listLaunchPlanItems(plan.id)[0]!;
    store.claimLaunchPlanItem(pending.itemId, "terminated-executor", "pending");
    store.updateLaunchPlanItemProgress(pending.itemId, "terminated-executor", {
      phase: "creative_draft",
      evidence: {
        campaignSketchId: "owned-campaign-sketch",
        adGroupSketchId: "owned-ad-sketch",
        creativeSketchId: "owned-creative-sketch",
      },
    });
    const firstScopeOwner = `terminated-executor:${pending.itemId}`;
    expect(store.claimLaunchCreationScope(
      plan.id,
      "demo-account",
      pending.launchRow.campaignName,
      firstScopeOwner,
    )).not.toBeNull();

    expect(store.recoverInterruptedLaunchPlanItems(
      new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    )).toBe(0);
    expect(store.listLaunchPlanItems(plan.id)[0]).toMatchObject({ status: "running" });
    expect(store.recoverInterruptedLaunchPlanItems(new Date().toISOString())).toBe(1);
    expect(store.listLaunchPlanItems(plan.id)[0]).toMatchObject({
      status: "unknown",
      attemptCount: 1,
      errorMessage: expect.stringContaining("不会自动重试"),
    });
    expect(store.claimLaunchPlanItem(pending.itemId, "new-executor", "failed")).toBeNull();
    store.markLaunchCreationScopeUncertain(
      plan.id,
      "demo-account",
      pending.launchRow.campaignName,
      firstScopeOwner,
    );
    expect(store.claimLaunchPlanItem(pending.itemId, "new-executor", "unknown")).toMatchObject({
      status: "running",
      attemptCount: 2,
      evidence: {
        campaignSketchId: "owned-campaign-sketch",
        adGroupSketchId: "owned-ad-sketch",
        creativeSketchId: "owned-creative-sketch",
      },
    });
    expect(store.claimLaunchCreationScope(
      plan.id,
      "demo-account",
      pending.launchRow.campaignName,
      `new-executor:${pending.itemId}`,
    )).not.toBeNull();
  });

  it("summarizes retryable failures separately from unknown outcomes", () => {
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdGroupId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2), launchItemRow(3)],
    });
    const [failed, unknown] = store.listLaunchPlanItems(plan.id);
    store.claimLaunchPlanItem(failed!.itemId, "executor-a", "pending");
    store.completeLaunchPlanItemFailure(failed!.itemId, "executor-a", "provider rejected");
    store.claimLaunchPlanItem(unknown!.itemId, "executor-a", "pending");
    store.completeLaunchPlanItemUnknown(unknown!.itemId, "executor-a", "response lost");

    const refreshed = store.refreshLaunchPlanResult(plan.id);

    expect(refreshed.executionResults[0]).toMatchObject({
      createdCount: 0,
      failedCount: 1,
      unknownCount: 1,
    });
    expect(refreshed.message).toContain("明确失败 1 条，可单独重试");
    expect(refreshed.message).toContain("结果核验失败 1 条，可执行只读重新核验");
    expect(store.claimLaunchPlanItem(unknown!.itemId, "executor-b", "failed")).toBeNull();
  });

  it("migrates legacy series-lock failures back to pending without touching Provider", () => {
    const row = { ...launchItemRow(2), campaignName: "legacy-series" };
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdGroupId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: [row],
    });
    const item = store.listLaunchPlanItems(plan.id)[0]!;
    store.claimLaunchPlanItem(item.itemId, "legacy-executor", "pending");
    const scopeOwner = `legacy-executor:${item.itemId}`;
    expect(store.claimLaunchCreationScope(
      plan.id,
      "demo-account",
      row.campaignName,
      scopeOwner,
    )).not.toBeNull();
    store.markLaunchCreationScopeUncertain(
      plan.id,
      "demo-account",
      row.campaignName,
      scopeOwner,
    );
    store.completeLaunchPlanItemFailure(
      item.itemId,
      "legacy-executor",
      "同计划同账户的同系列任务正在创建，当前任务未发送 Provider 请求，请稍后重试。",
    );

    expect(store.recoverLegacySeriesCoordinationFailures()).toEqual({
      resumedItemCount: 1,
      planIds: [plan.id],
    });
    expect(store.listLaunchPlanItems(plan.id)[0]).toMatchObject({
      status: "pending",
      errorMessage: null,
    });
    expect(store.claimLaunchCreationScope(
      plan.id,
      "demo-account",
      row.campaignName,
      "new-executor:batch",
    )).not.toBeNull();
  });

  it("persists stable operation identity, per-attempt identity, phases and provider evidence", () => {
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdGroupId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    });
    const pending = store.listLaunchPlanItems(plan.id)[0]!;
    expect(pending).toMatchObject({
      phase: "validation",
      attemptId: null,
      evidence: {},
    });
    expect(pending.operationId).toBeTruthy();
    expect(pending.correlationId).toContain(plan.id);

    const first = store.claimLaunchPlanItem(pending.itemId, "executor-a", "pending")!;
    store.updateLaunchPlanItemProgress(pending.itemId, "executor-a", {
      phase: "campaign_draft",
      evidence: { campaignSnapId: "snap-1", campaignSketchId: "sketch-1" },
    });
    store.updateLaunchPlanItemProgress(pending.itemId, "executor-a", {
      phase: "publishing",
      evidence: { asyncRequestId: "async-1" },
    });
    store.completeLaunchPlanItemFailure(pending.itemId, "executor-a", "confirmed rejection");
    const second = store.claimLaunchPlanItem(pending.itemId, "executor-b", "failed")!;

    expect(second.operationId).toBe(first.operationId);
    expect(second.correlationId).toBe(first.correlationId);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(store.listLaunchPlanItemAttempts(pending.itemId)).toEqual([
      expect.objectContaining({
        attemptId: first.attemptId,
        attemptNumber: 1,
        phase: "publishing",
        status: "failed",
        evidence: expect.objectContaining({
          campaignSnapId: "snap-1",
          campaignSketchId: "sketch-1",
          asyncRequestId: "async-1",
        }),
      }),
      expect.objectContaining({
        attemptId: second.attemptId,
        attemptNumber: 2,
        phase: "validation",
        status: "running",
      }),
    ]);
  });

  it("rolls back the item terminal state when attempt persistence fails", () => {
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdGroupId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    });
    const item = store.listLaunchPlanItems(plan.id)[0]!;
    store.claimLaunchPlanItem(item.itemId, "executor-a", "pending");
    const database = (store as unknown as { db: DatabaseSync }).db;
    database.exec(`CREATE TRIGGER reject_attempt_completion
      BEFORE UPDATE ON launch_plan_item_attempts
      BEGIN SELECT RAISE(ABORT, 'attempt persistence failed'); END`);

    expect(() => store.completeLaunchPlanItemSuccess(item.itemId, "executor-a", {
      campaignId: "campaign-1",
      adGroupId: "group-1",
      adId: "ad-1",
    })).toThrow("attempt persistence failed");
    expect(store.listLaunchPlanItems(plan.id)[0]).toMatchObject({
      status: "running",
      campaignId: null,
      adGroupId: null,
      adId: null,
    });
    expect(store.listLaunchPlanItemAttempts(item.itemId)[0]).toMatchObject({ status: "running" });
    database.exec("DROP TRIGGER reject_attempt_completion");
  });

  it("refuses to cancel a plan while an item is running", () => {
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdGroupId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    });
    const item = store.listLaunchPlanItems(plan.id)[0]!;
    store.claimLaunchPlanItem(item.itemId, "executor-a", "pending");

    expect(() => store.cancelMultiAccountLaunchPlan(plan.id)).toThrow("正在创建");
    expect(store.getMultiAccountLaunchPlan(plan.id)?.status).not.toBe("cancelled");
    expect(store.listLaunchPlanItems(plan.id)[0]?.status).toBe("running");
  });

  it("renews launch and status leases so another instance cannot recover active work", () => {
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdGroupId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    });
    const launch = store.listLaunchPlanItems(plan.id)[0]!;
    store.claimLaunchPlanItem(launch.itemId, "executor-a", "pending");
    const status = store.createStatusWriteTask({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "group-lease",
      entityName: "lease group",
      action: "disable",
      source: "manual",
    }, { id: "operator-1", name: "Operator", kind: "user" });
    store.claimStatusWriteTask(status.id, "executor-a", "pending");

    const database = (store as unknown as { db: DatabaseSync }).db;
    const old = "2020-01-01T00:00:00.000Z";
    database.prepare("UPDATE launch_plan_items SET claimed_at = ? WHERE item_id = ?").run(old, launch.itemId);
    database.prepare("UPDATE ad_operations SET claimed_at = ? WHERE id = ?").run(old, status.id);

    expect(store.renewLaunchPlanItemLease(launch.itemId, "executor-a")).toBe(true);
    expect(store.renewStatusWriteTaskLease(status.id, "executor-a")).toBe(true);
    const staleBefore = new Date(Date.now() - 60_000).toISOString();
    expect(store.recoverInterruptedLaunchPlanItems(staleBefore)).toBe(0);
    expect(store.recoverInterruptedStatusWriteTasks(staleBefore)).toBe(0);
    expect(store.renewLaunchPlanItemLease(launch.itemId, "executor-b")).toBe(false);
    expect(store.renewStatusWriteTaskLease(status.id, "executor-b")).toBe(false);
  });

  it("records evidence when an unknown status write is manually verified", () => {
    const task = store.createStatusWriteTask({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "group-verify",
      entityName: "verification group",
      action: "disable",
      source: "manual",
    }, { id: "operator-1", name: "Operator", kind: "user" });
    store.claimStatusWriteTask(task.id, "executor-a", "pending");
    store.completeStatusWriteTask(task.id, "executor-a", "unknown", "response lost");

    expect(() => store.verifyUnknownStatusWriteTask(task.id, {
      decision: "confirmed-succeeded",
      observedStatus: "enabled",
      evidence: "TikTok object still enabled at 10:00 UTC",
      note: "mismatch",
    }, { id: "reviewer-1", name: "Reviewer", kind: "user" })).toThrow("disabled");

    const record = store.verifyUnknownStatusWriteTask(task.id, {
      decision: "confirmed-succeeded",
      observedStatus: "disabled",
      evidence: "TikTok object disabled at 10:01 UTC",
      note: "checked by external id",
    }, { id: "reviewer-1", name: "Reviewer", kind: "user" });

    expect(record).toMatchObject({
      taskId: task.id,
      operationId: task.operationId,
      previousStatus: "unknown",
      nextStatus: "succeeded",
      actor: { id: "reviewer-1", name: "Reviewer", kind: "user" },
    });
    expect(store.getAdOperation(task.id)).toMatchObject({
      status: "succeeded",
      phase: "readback",
      syncWarning: expect.stringContaining("人工核验"),
    });
    expect(store.listStatusWriteTaskVerifications(task.id)).toEqual([record]);
    expect(store.claimStatusWriteTask(task.id, "executor-b", "failed")).toBeNull();
  });

  it("exposes filtered task history and never claims cancelled launch work", () => {
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdGroupId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    });
    const launch = store.listLaunchPlanItems(plan.id)[0]!;
    const status = store.createStatusWriteTask({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "group-history",
      entityName: "history group",
      action: "enable",
      source: "manual",
    }, { id: "operator-1", name: "Operator", kind: "user" });
    store.claimStatusWriteTask(status.id, "executor-a", "pending");
    store.completeStatusWriteTask(status.id, "executor-a", "failed", "platform rejected");

    expect(store.listWriteTaskSummaries({ kind: "status", status: "failed" })).toEqual([
      expect.objectContaining({
        kind: "status",
        taskId: status.id,
        retryable: true,
        requiresVerification: false,
      }),
    ]);
    expect(store.listWriteTaskSummaries({ kind: "launch", accountId: "demo-account" })).toEqual([
      expect.objectContaining({ kind: "launch", taskId: launch.itemId, status: "pending" }),
    ]);

    expect(store.cancelMultiAccountLaunchPlan(plan.id)).toBe(true);
    expect(store.listLaunchPlanItems(plan.id)[0]?.status).toBe("cancelled");
    expect(store.claimLaunchPlanItem(launch.itemId, "executor-b", "pending")).toBeNull();
  });

  it("applies task history status filters before the query limit", () => {
    const oldFailure = store.recordAdOperation({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "old-failure",
      entityName: "old failure",
      action: "disable",
      source: "manual",
      status: "failed",
      message: "old failure",
    });
    const database = (store as unknown as { db: DatabaseSync }).db;
    database.prepare("UPDATE ad_operations SET created_at = ?, updated_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", oldFailure.id);
    for (let index = 0; index < 1_001; index += 1) {
      store.recordAdOperation({
        accountId: "demo-account",
        providerKind: "cookie",
        entityType: "ad-group",
        externalId: `recent-success-${index}`,
        entityName: `recent success ${index}`,
        action: "disable",
        source: "manual",
        status: "succeeded",
        message: "ok",
      });
    }

    expect(store.listWriteTaskSummaries({ kind: "status", status: "failed", limit: 10 }))
      .toEqual([expect.objectContaining({ taskId: oldFailure.id, status: "failed" })]);
  });

  it("uses the database claim as the authority across two store instances", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-dual-instance-"));
    const databasePath = join(directory, "automation.db");
    const first = new AutomationStore(databasePath);
    first.seed();
    const second = new AutomationStore(databasePath);
    try {
      const plan = first.createMultiAccountLaunchPlan({
        mode: "single",
        sourceAccountId: "demo-account",
        sourceAdGroupId: null,
        targetAccountIds: ["demo-account"],
        launchPresetId: "default-launch-preset",
        launchRows: [launchItemRow(2)],
      });
      const item = first.listLaunchPlanItems(plan.id)[0]!;

      expect(first.claimLaunchPlanItem(item.itemId, "instance-a", "pending")).toMatchObject({
        status: "running",
        claimedBy: "instance-a",
      });
      expect(second.claimLaunchPlanItem(item.itemId, "instance-b", "pending")).toBeNull();
      expect(() => second.cancelMultiAccountLaunchPlan(plan.id)).toThrow("正在创建");

      const statusTask = first.createStatusWriteTask({
        accountId: "demo-account",
        providerKind: "cookie",
        entityType: "ad-group",
        externalId: "dual-instance-group",
        entityName: "dual instance group",
        action: "disable",
        source: "manual",
      }, { id: "operator-1", name: "Operator", kind: "user" });
      expect(first.claimStatusWriteTask(statusTask.id, "instance-a", "pending")).toMatchObject({
        status: "running",
        claimedBy: "instance-a",
      });
      expect(second.claimStatusWriteTask(statusTask.id, "instance-b", "pending")).toBeNull();
    } finally {
      second.close();
      first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("atomically deduplicates automatic actions and enforces the daily limit across instances", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-action-claims-"));
    const databasePath = join(directory, "automation.db");
    const first = new AutomationStore(databasePath);
    first.seed();
    const second = new AutomationStore(databasePath);
    try {
      expect(first.reserveAutomaticAction({
        accountId: "demo-account",
        actionKey: "same-action",
        localDate: "2026-07-18",
        dailyLimit: 1,
      })).toBe("claimed");
      expect(second.reserveAutomaticAction({
        accountId: "demo-account",
        actionKey: "same-action",
        localDate: "2026-07-18",
        dailyLimit: 1,
      })).toBe("duplicate");
      expect(second.reserveAutomaticAction({
        accountId: "demo-account",
        actionKey: "different-action",
        localDate: "2026-07-18",
        dailyLimit: 1,
      })).toBe("limit-reached");
      expect(first.countAutomaticActions("demo-account", "2026-07-18")).toBe(1);
    } finally {
      second.close();
      first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not redispatch an interrupted scheduled write and blocks cancellation races", () => {
    saveEntity(store, "ad-group", "scheduled-group", "scheduled group");
    const schedule = store.createOneTimeSchedule("demo-account", {
      externalId: "scheduled-group",
      action: "disable",
      runAt: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(store.claimDueScheduledAction(schedule.id, "instance-a")).toMatchObject({
      id: schedule.id,
      status: "scheduled",
    });
    expect(store.claimDueScheduledAction(schedule.id, "instance-b")).toBeNull();
    expect(() => store.cancelScheduledAction("demo-account", schedule.id)).toThrow("正在执行");

    const task = store.createStatusWriteTask({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "scheduled-group",
      entityName: "scheduled group",
      action: "disable",
      source: "scheduled",
    }, { id: "scheduler", name: "Scheduler", kind: "system" });
    store.bindScheduledActionOperation(schedule.id, "instance-a", task.operationId);
    store.claimStatusWriteTask(task.id, "instance-a", "pending", {
      id: "scheduler",
      name: "Scheduler",
      kind: "system",
    });
    const database = (store as unknown as { db: DatabaseSync }).db;
    database.prepare("UPDATE scheduled_entity_actions SET claimed_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", schedule.id);
    const staleBefore = new Date(Date.now() - 60_000).toISOString();

    expect(store.recoverInterruptedScheduledActions(staleBefore)).toBe(0);
    database.prepare("UPDATE ad_operations SET claimed_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", task.id);
    expect(store.recoverInterruptedStatusWriteTasks(staleBefore)).toBe(1);
    expect(store.recoverInterruptedScheduledActions(staleBefore)).toBe(1);

    expect(store.getAdOperation(task.id).status).toBe("unknown");
    expect(store.listScheduledActions("demo-account").find((item) => item.id === schedule.id))
      .toMatchObject({
        status: "failed",
        lastResult: "failed",
        lastMessage: expect.stringContaining("禁止自动重放"),
      });
    expect(store.listDueScheduledActions("demo-account")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: schedule.id })]),
    );
  });

  it("does not reschedule a repeating action whose linked write becomes unknown", () => {
    saveEntity(store, "ad-group", "overnight-group", "overnight group");
    const [schedule] = store.createOvernightSchedule("demo-account", {
      externalId: "overnight-group",
      disableAt: new Date(Date.now() - 2_000).toISOString(),
      enableAt: new Date(Date.now() + 60_000).toISOString(),
    });
    store.claimDueScheduledAction(schedule!.id, "instance-a");
    const task = store.createStatusWriteTask({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "overnight-group",
      entityName: "overnight group",
      action: "disable",
      source: "scheduled",
    }, { id: "scheduler", name: "Scheduler", kind: "system" });
    store.bindScheduledActionOperation(schedule!.id, "instance-a", task.operationId);
    store.claimStatusWriteTask(task.id, "instance-a", "pending", {
      id: "scheduler",
      name: "Scheduler",
      kind: "system",
    });
    const database = (store as unknown as { db: DatabaseSync }).db;
    database.prepare("UPDATE scheduled_entity_actions SET claimed_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", schedule!.id);
    database.prepare("UPDATE ad_operations SET claimed_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", task.id);
    const staleBefore = new Date(Date.now() - 60_000).toISOString();

    expect(store.recoverInterruptedStatusWriteTasks(staleBefore)).toBe(1);
    expect(store.recoverInterruptedScheduledActions(staleBefore)).toBe(1);
    expect(store.listScheduledActions("demo-account").find((item) => item.id === schedule!.id))
      .toMatchObject({ status: "failed", lastResult: "failed" });
    expect(store.listDueScheduledActions("demo-account")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: schedule!.id })]),
    );
  });
});

function launchItemRow(rowNumber: number) {
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

function createLaunchCopyPreview(
  store: AutomationStore,
  input: LaunchCopyPreviewInput,
  options: { missingAccountIds?: string[] } = {},
) {
  const hash = (posts: LaunchOriginalPost[]) => createHash("sha256")
    .update(JSON.stringify(posts.map((item) => ({
      itemId: item.itemId,
      identityId: item.identityId,
      identityType: item.identityType,
      identityBcId: item.identityBcId,
      vid: item.vid,
      videoId: item.videoId,
      promotable: item.promotable,
    }))))
    .digest("hex");
  const sourceIds = input.sourceAdGroupIds?.length ? input.sourceAdGroupIds : [input.sourceAdGroupId];
  const sourceSnapshots = sourceIds.map((sourceId, index) => {
    const post: LaunchOriginalPost = {
      itemId: `post-${sourceId}`,
      identityId: "source-identity",
      identityType: 2,
      identityBcId: "0",
      vid: `source-vid-${sourceId}`,
      videoId: null,
      displayName: "源原帖",
      coverUrl: null,
      promotable: true,
    };
    return {
      accountId: input.sourceAccountId,
      campaignId: sourceIds.length === 1 ? "campaign-template" : `campaign-template-${index}`,
      campaignName: sourceIds.length === 1 ? "源系列" : `源系列${index + 1}`,
      adGroupId: sourceId,
      adGroupName: "源广告组",
      posts: [post],
      productUrl: "https://source.example/product",
      productInfo: null,
      catalogSetup: null,
      structuralHash: hash([post]),
      fetchedAt: new Date().toISOString(),
    };
  });
  const missing = new Set(options.missingAccountIds ?? []);
  const mappings = input.targetAccountIds.flatMap((accountId) => sourceSnapshots.map((snapshot) => {
    const posts = missing.has(accountId) ? [] : snapshot.posts.map((post) => ({
      ...post,
      identityId: `target-identity-${accountId}`,
      vid: `target-vid-${accountId}-${snapshot.adGroupId}`,
    }));
    return { accountId, sourceAdGroupId: snapshot.adGroupId, posts, evidenceHash: hash(posts), verifiedAt: new Date().toISOString() };
  }));
  return store.createLaunchCopyPreview(input, sourceSnapshots, mappings);
}

function saveCopySource(
  store: AutomationStore,
  adId: string,
  videoCode: string,
): void {
  const capturedAt = new Date().toISOString();
  store.saveReadOnlySync(
    "demo-account",
    "cookie",
    [
      {
        entityType: "campaign",
        externalId: "campaign-template",
        payload: { campaign_name: "源系列" },
      },
      {
        entityType: "ad-group",
        externalId: "group-template",
        payload: { campaign_id: "campaign-template", adgroup_name: "源广告组" },
      },
      {
        entityType: "ad",
        externalId: adId,
        payload: {
          campaign_id: "campaign-template",
          adgroup_id: "group-template",
          ad_name: "源广告",
          asset: { image_list: [{ aweme_item_id: videoCode }] },
          external_url: "https://source.example/product",
        },
      },
    ],
    {
      startedAt: capturedAt,
      finishedAt: capturedAt,
      counts: { campaign: 1, "ad-group": 1, ad: 1, material: 0 },
      warnings: [],
      quality: healthySyncQuality(capturedAt),
    },
  );
}

function saveTargetAsset(
  store: AutomationStore,
  accountId: string,
  videoCode: string,
): void {
  const capturedAt = new Date().toISOString();
  store.saveProviderConnectionSettings(accountId, {
    kind: "cookie",
    advertiserId: accountId,
    healthUrl: "",
    campaignsUrl: "",
    adGroupsUrl: "",
    adsUrl: "",
  });
  store.updateProviderStatus(accountId, "cookie", "ready", "ready");
  store.saveReadOnlySync(
    accountId,
    "cookie",
    [{
      entityType: "ad",
      externalId: `asset-evidence-${videoCode}`,
      payload: { asset: { image_list: [{ aweme_item_id: videoCode }] } },
    }],
    {
      startedAt: capturedAt,
      finishedAt: capturedAt,
      counts: { campaign: 0, "ad-group": 0, ad: 1, material: 0 },
      warnings: [],
      quality: healthySyncQuality(capturedAt),
    },
  );
}

function saveEntity(
  store: AutomationStore,
  entityType: "ad-group" | "ad",
  externalId: string,
  name: string,
  capturedAt = new Date().toISOString(),
): void {
  store.saveReadOnlySync(
    "demo-account",
    "cookie",
    [{
      entityType,
      externalId,
      payload: {
        campaign_id: "campaign-template",
        ad_name: name,
        adgroup_name: name,
        ad_primary_status: "enable",
        row_data: { stat_cost: "1" },
      },
    }],
    {
      startedAt: capturedAt,
      finishedAt: capturedAt,
      counts: {
        campaign: 0,
        "ad-group": entityType === "ad-group" ? 1 : 0,
        ad: entityType === "ad" ? 1 : 0,
        material: 0,
      },
      warnings: [],
      quality: healthySyncQuality(capturedAt),
    },
  );
}
