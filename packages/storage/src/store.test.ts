import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDefaultAutomationSwitches } from "@tk-auto/core";
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

  it("migrates existing accounts to the safe manual-approval execution mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-store-"));
    const databasePath = join(directory, "automation.db");
    const firstStore = new AutomationStore(databasePath);
    firstStore.seed();
    firstStore.close();

    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase
      .prepare("UPDATE accounts SET execution_mode = 'automatic'")
      .run();
    legacyDatabase
      .prepare(
        "DELETE FROM schema_migrations WHERE migration_key = 'safe-manual-approval-execution-v1'",
      )
      .run();
    legacyDatabase.close();

    const reopenedStore = new AutomationStore(databasePath);
    expect(reopenedStore.getAccount("demo-account")?.executionMode).toBe(
      "manual-approval",
    );
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
    expect(account.executionMode).toBe("manual-approval");
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
        counts: { campaign: 0, "ad-group": 1, ad: 0 },
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

  it("returns the newest three-level sync result for automation observability", () => {
    const finishedAt = new Date().toISOString();
    store.saveReadOnlySync("demo-account", "cookie", [], {
      startedAt: finishedAt,
      finishedAt,
      counts: { campaign: 1, "ad-group": 1, ad: 1 },
      warnings: [],
      quality: healthySyncQuality(finishedAt),
    });

    expect(store.getLatestReadOnlySync("demo-account", "cookie")).toEqual({
      startedAt: finishedAt,
      finishedAt,
      counts: { campaign: 1, "ad-group": 1, ad: 1 },
      warnings: [],
      quality: healthySyncQuality(finishedAt),
    });
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
        sourceAdId: null,
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
      sourceAdId: null,
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
      sourceAdId: "ad-1",
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
    const preview = store.createLaunchCopyPreview(input);
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
      sourceSnapshot: { adId: "ad-1", campaignId: "campaign-template" },
      targetAssetMapping: { targetVideoCode: "video-001" },
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
      sourceAdId: "ad-sheet",
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
    const preview = store.createLaunchCopyPreview(input);
    const plan = store.createMultiAccountLaunchPlan({
      mode: "copy",
      ...input,
      copyPreviewId: preview.id,
    });

    expect(plan.launchRows).toHaveLength(1);
    expect(plan.launchRows[0]?.campaignName).toBe("测试系列");
    expect(store.listMultiAccountLaunchPlans()[0]?.launchRows).toEqual(plan.launchRows);
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
      sourceAdId: "source-for-missing-asset",
      targetAccountIds: [target.id],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    };

    const preview = store.createLaunchCopyPreview(input);

    expect(preview.safeToCreate).toBe(false);
    expect(preview.blockers.join(" ")).toContain("无法证明该账户素材库可用");
    expect(() => store.createMultiAccountLaunchPlan({
      ...input,
      mode: "copy",
      copyPreviewId: preview.id,
    })).toThrow("差异预览仍有阻断项");
  });

  it("limits a copy preview to three account-by-row tasks", () => {
    expect(() => store.createLaunchCopyPreview({
      sourceAccountId: "demo-account",
      sourceAdId: "source-ad",
      targetAccountIds: ["target-a", "target-b"],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2), launchItemRow(3)],
    })).toThrow("1–3 个逐项任务");
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
      sourceAdId: "source-preset-snapshot",
      targetAccountIds: [target.id],
      launchPresetId: originalPreset.id,
      launchRows: [launchItemRow(2)],
    };
    const preview = store.createLaunchCopyPreview(input);

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

  it("uses one copy preview as the idempotency boundary and detects source drift", () => {
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
      sourceAdId: "source-idempotent",
      targetAccountIds: [target.id],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    };
    const preview = store.createLaunchCopyPreview(input);

    const first = store.createMultiAccountLaunchPlan({ ...input, mode: "copy", copyPreviewId: preview.id });
    const second = store.createMultiAccountLaunchPlan({ ...input, mode: "copy", copyPreviewId: preview.id });
    expect(second.id).toBe(first.id);
    expect(() => store.createMultiAccountLaunchPlan({
      ...input,
      mode: "copy",
      copyPreviewId: preview.id,
      launchRows: [{ ...input.launchRows[0]!, campaignName: "changed-after-preview" }],
    })).toThrow("表格内容在预览后已变化");

    saveCopySource(store, "source-idempotent", "changed-source-video");
    expect(() => store.validateLaunchCopyItem(store.listLaunchPlanItems(first.id)[0]!))
      .toThrow("源广告结构在预览后已变化");
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
      .toMatchObject({ sourceAdId: null, launchRows: [] });
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
      counts: { campaign: 0, "ad-group": 0, ad: 0 },
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
        counts: { campaign: 0, "ad-group": 1, ad: 0 },
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
        counts: { campaign: 0, "ad-group": 1, ad: 0 },
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

  it("refuses to create a copy plan when the source ad has no stable campaign id", () => {
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      [{ entityType: "ad", externalId: "ad-without-campaign", payload: { ad_name: "源广告" } }],
      {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        counts: { campaign: 0, "ad-group": 0, ad: 1 },
        warnings: [],
        quality: healthySyncQuality(new Date().toISOString()),
      },
    );
    const target = store.createAccount({
      displayName: "目标账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });

    expect(() => store.createLaunchCopyPreview({
      sourceAccountId: "demo-account",
      sourceAdId: "ad-without-campaign",
      targetAccountIds: [target.id],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    })).toThrow("稳定的 Campaign ID");
  });

  it("blocks only executable legacy plans and preserves completed or cancelled history", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-launch-migration-"));
    const databasePath = join(directory, "automation.db");
    const original = new AutomationStore(databasePath);
    original.seed();
    const input = {
      mode: "single" as const,
      sourceAccountId: "demo-account",
      sourceAdId: null,
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
      sourceAccountId: target.id, sourceAdId: null, targetAccountIds: [target.id], launchPresetId: preset.id,
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
      counts: { campaign: 0, "ad-group": entities.length, ad: 0 },
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
      sourceAdId: null,
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
      sourceAdId: null,
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
      sourceAdId: null,
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

  it("recovers an interrupted running item as unknown instead of retryable", () => {
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2)],
    });
    const pending = store.listLaunchPlanItems(plan.id)[0]!;
    store.claimLaunchPlanItem(pending.itemId, "terminated-executor", "pending");

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
  });

  it("summarizes retryable failures separately from unknown outcomes", () => {
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdId: null,
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
    expect(refreshed.message).toContain("结果未知 1 条，禁止重试，需人工核验");
    expect(store.claimLaunchPlanItem(unknown!.itemId, "executor-b", "failed")).toBeNull();
  });

  it("persists stable operation identity, per-attempt identity, phases and provider evidence", () => {
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdId: null,
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
      sourceAdId: null,
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

  it("requires evidence to resolve unknown items and records actor plus before/after state", () => {
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdId: null,
      targetAccountIds: ["demo-account"],
      launchPresetId: "default-launch-preset",
      launchRows: [launchItemRow(2), launchItemRow(3), launchItemRow(4)],
    });
    const [confirmed, notCreated, legacyUnknown] = store.listLaunchPlanItems(plan.id);
    store.claimLaunchPlanItem(confirmed!.itemId, "executor-a", "pending");
    store.updateLaunchPlanItemProgress(confirmed!.itemId, "executor-a", {
      phase: "validation",
      evidence: { resolvedAdGroupName: `${confirmed!.launchRow.adGroupName}-001` },
    });
    store.completeLaunchPlanItemUnknown(confirmed!.itemId, "executor-a", "response lost");
    store.claimLaunchCreationScope(plan.id, "demo-account", confirmed!.launchRow.campaignName, "scope-seed");
    store.completeLaunchCreationScope(
      plan.id,
      "demo-account",
      confirmed!.launchRow.campaignName,
      "scope-seed",
      "campaign-existing",
      confirmed!.launchRow.adGroupName,
    );
    store.claimLaunchCreationScope(plan.id, "demo-account", confirmed!.launchRow.campaignName, "scope-a");
    store.markLaunchCreationScopeUncertain(plan.id, "demo-account", confirmed!.launchRow.campaignName, "scope-a");
    store.claimLaunchPlanItem(notCreated!.itemId, "executor-a", "pending");
    store.completeLaunchPlanItemUnknown(notCreated!.itemId, "executor-a", "response lost");
    store.claimLaunchCreationScope(plan.id, "demo-account", notCreated!.launchRow.campaignName, "scope-b");
    store.markLaunchCreationScopeUncertain(plan.id, "demo-account", notCreated!.launchRow.campaignName, "scope-b");
    store.claimLaunchPlanItem(legacyUnknown!.itemId, "executor-a", "pending");
    store.completeLaunchPlanItemUnknown(legacyUnknown!.itemId, "executor-a", "legacy response lost");

    expect(() => store.verifyUnknownLaunchPlanItem(confirmed!.itemId, {
      decision: "confirmed-succeeded",
      evidence: "后台已经显示创建成功",
      note: "",
      campaignId: null,
      adGroupId: null,
      adId: null,
    }, { id: "user-1", name: "reviewer" })).toThrow("必须填写");

    expect(() => store.verifyUnknownLaunchPlanItem(legacyUnknown!.itemId, {
      decision: "confirmed-succeeded",
      evidence: "TikTok 后台可见但旧任务没有记录实际广告组名称",
      note: "legacy unknown",
      campaignId: "campaign-legacy",
      adGroupId: "group-legacy",
      adId: "ad-legacy",
    }, { id: "user-1", name: "reviewer" })).toThrow("缺少实际广告组名称");

    const success = store.verifyUnknownLaunchPlanItem(confirmed!.itemId, {
      decision: "confirmed-succeeded",
      evidence: "TikTok 后台按操作时间查询到三个对象且状态关闭",
      note: "人工核验",
      campaignId: "campaign-1",
      adGroupId: "group-1",
      adId: "ad-1",
    }, { id: "user-1", name: "reviewer" });
    const failed = store.verifyUnknownLaunchPlanItem(notCreated!.itemId, {
      decision: "confirmed-not-created",
      evidence: "TikTok 后台按账户和时间范围查询，没有找到对应对象",
      note: "允许稍后显式重试",
      campaignId: null,
      adGroupId: null,
      adId: null,
    }, { id: "user-1", name: "reviewer" });

    expect(success).toMatchObject({ previousStatus: "unknown", nextStatus: "succeeded", actorId: "user-1" });
    expect(failed).toMatchObject({ previousStatus: "unknown", nextStatus: "failed", actorName: "reviewer" });
    expect(store.listLaunchPlanItems(plan.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: confirmed!.itemId, status: "succeeded", campaignId: "campaign-1", adGroupId: "group-1", adId: "ad-1" }),
      expect.objectContaining({ itemId: notCreated!.itemId, status: "failed", errorMessage: expect.stringContaining("人工核验确认未创建") }),
    ]));
    expect(store.listLaunchPlanItemVerifications(confirmed!.itemId)).toHaveLength(1);
    expect(store.claimLaunchCreationScope(
      plan.id, "demo-account", confirmed!.launchRow.campaignName, "scope-c",
    )).toEqual({
      campaignId: "campaign-1",
      adGroupNames: [confirmed!.launchRow.adGroupName, `${confirmed!.launchRow.adGroupName}-001`],
    });
    store.releaseLaunchCreationScope(plan.id, "demo-account", confirmed!.launchRow.campaignName, "scope-c");
    expect(store.claimLaunchCreationScope(
      plan.id, "demo-account", notCreated!.launchRow.campaignName, "scope-d",
    )).toEqual({ campaignId: null, adGroupNames: [] });
    store.releaseLaunchCreationScope(plan.id, "demo-account", notCreated!.launchRow.campaignName, "scope-d");
    expect(store.claimLaunchPlanItem(notCreated!.itemId, "executor-b", "failed")).toMatchObject({ attemptCount: 2 });
  });

  it("refuses to cancel a plan while an item is running", () => {
    const plan = store.createMultiAccountLaunchPlan({
      mode: "single",
      sourceAccountId: "demo-account",
      sourceAdId: null,
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
      sourceAdId: null,
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
      sourceAdId: null,
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
        sourceAdId: null,
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

  it("keeps low-risk automation off by default and persists an explicit daily limit", () => {
    expect(store.getLowRiskAutomationPolicy("demo-account")).toMatchObject({
      enabled: false,
      policyVersion: "disable-only-v1",
      dailyActionLimit: 5,
    });
    expect(() => store.updateLowRiskAutomationPolicy("demo-account", {
      enabled: true,
      dailyActionLimit: 2,
    })).toThrow("automatic");
    store.setAccountExecutionMode("demo-account", "automatic", "test opt-in");
    expect(store.updateLowRiskAutomationPolicy("demo-account", {
      enabled: true,
      dailyActionLimit: 2,
    })).toMatchObject({ enabled: true, dailyActionLimit: 2 });
    store.setAccountExecutionMode("demo-account", "manual-approval", "circuit opened");
    expect(store.getLowRiskAutomationPolicy("demo-account").enabled).toBe(false);
  });

  it("atomically deduplicates automatic actions and enforces the daily limit across instances", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-low-risk-"));
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
      counts: { campaign: 1, "ad-group": 1, ad: 1 },
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
      counts: { campaign: 0, "ad-group": 0, ad: 1 },
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
      },
      warnings: [],
      quality: healthySyncQuality(capturedAt),
    },
  );
}
