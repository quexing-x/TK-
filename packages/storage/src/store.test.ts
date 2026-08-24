import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { automationRuleDefinitions, createDefaultAutomationSwitches, defaultAutomationFeatureSettings, type LaunchCopyPreviewInput, type LaunchOriginalPost } from "@tk-auto/core";
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

  it("creates Meta offline accounts disabled and preserves the platform", () => {
    const account = store.createAccount({
      displayName: "Meta 内部测试",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "meta-offline",
    });

    expect(account).toMatchObject({
      platform: "meta",
      providerKind: "meta-offline",
      enabled: false,
    });
    expect(() => store.saveProviderConnectionSettings(account.id, {
      kind: "meta-offline",
      businessId: "business-1",
      adAccountId: "act-1",
    })).toThrow("Meta 当前仅提供离线架构，不能保存接入参数。");
    expect(() => store.setProviderCredentialReference(
      account.id,
      "meta-offline",
      "meta-credential-ref",
    )).toThrow("Meta 当前仅提供离线架构，不能修改接入连接。");
    expect(() => store.setProviderCredentialReference(
      account.id,
      "cookie",
      "cross-platform-credential-ref",
    )).toThrow("Meta 当前仅提供离线架构，不能修改接入连接。");
    expect(() => store.clearProviderCredential(account.id, "meta-offline"))
      .toThrow("Meta 当前仅提供离线架构，不能修改接入连接。");
    expect(() => store.updateProviderStatus(account.id, "meta-offline", "ready", "ready"))
      .toThrow("Meta 当前仅提供离线架构，不能修改接入连接。");
    expect(() => store.updateProviderAuthorization(account.id, "meta-offline", {
      status: "active",
      capabilityVersion: "meta-offline-v1",
      capabilities: [],
    })).toThrow("Meta 当前仅提供离线架构，不能修改接入连接。");
    expect(() => store.completeProviderHealthCheckIfCurrent(
      account.id,
      "meta-offline",
      {} as never,
      {
        connectionStatus: "ready",
        message: "ready",
        authorizationStatus: "active",
        capabilityVersion: "meta-offline-v1",
        capabilities: [],
      },
    )).toThrow("Meta 当前仅提供离线架构，不能修改接入连接。");
    expect(store.listProviderConnections(account.id)).toEqual([]);
    expect(() => store.updateAccountSettings(account.id, {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: true,
      providerKind: account.providerKind,
    })).toThrow("Meta 离线架构不能开启账户自动化");
  });

  it("binds Meta accounts to a reusable App credential profile", () => {
    const account = store.createAccount({
      displayName: "Meta 只读测试",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "meta-marketing-api",
    });
    const profile = store.createMetaAccessProfile({
      name: "主 Meta App",
      appId: "100000000000001",
      businessId: null,
      graphApiVersion: "v26.0",
    });
    store.setMetaAccessProfileSecretReference(profile.id, "vault-meta-secret-bundle");
    const settings = {
      kind: "meta-marketing-api" as const,
      profileId: profile.id,
      adAccountId: "act_300000000000003",
      pageId: "400000000000004",
      liveMode: "read-only" as const,
      allowedStatusEntityTypes: [] as ("campaign" | "ad-group" | "ad")[],
    };

    expect(store.saveProviderConnectionSettings(account.id, settings)).toMatchObject({
      kind: "meta-marketing-api",
      settings,
      hasCredential: true,
      status: "untested",
    });
    expect(() => store.setProviderCredentialReference(
      account.id,
      "meta-marketing-api",
      "legacy-account-token",
    )).toThrow("必须通过共享凭据档案管理");
    expect(() => store.updateAccountSettings(account.id, {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: true,
      providerKind: account.providerKind,
    })).toThrow("连接检测通过");
    const automaticSettings = {
      ...settings,
      liveMode: "automation-status" as const,
      allowedStatusEntityTypes: ["campaign", "ad-group", "ad"] as (
        "campaign" | "ad-group" | "ad"
      )[],
    };
    store.saveProviderConnectionSettings(account.id, automaticSettings);
    store.updateProviderStatus(account.id, "meta-marketing-api", "ready", "ready");
    store.updateProviderAuthorization(account.id, "meta-marketing-api", {
      status: "active",
      capabilityVersion: "test-meta-v1",
      capabilities: ["read-campaigns", "read-ad-groups", "read-ads", "change-status"],
    });
    expect(store.updateAccountSettings(account.id, {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: true,
      providerKind: account.providerKind,
    })).toMatchObject({ enabled: true, providerKind: "meta-marketing-api" });
    expect(() => store.setProviderCredentialReference(
      account.id,
      "cookie",
      "cross-platform-ref",
    )).toThrow("接入方式与账户平台不匹配");
    expect(store.listMetaAccessProfiles()).toMatchObject([{
      id: profile.id,
      appId: "100000000000001",
      businessId: null,
      hasAppSecret: true,
      hasAccessToken: true,
      referenceCount: 1,
    }]);
    expect(JSON.stringify(store.listMetaAccessProfiles())).not.toContain(
      "vault-meta-secret-bundle",
    );
    expect(() => store.deleteMetaAccessProfile(profile.id)).toThrow(
      "still referenced by 1 account",
    );
  });

  it("enforces one reusable profile per Meta App ID", () => {
    const first = store.createMetaAccessProfile({
      name: "App A",
      appId: "100000000000001",
      businessId: "200000000000002",
      graphApiVersion: "v26.0",
    });

    expect(() => store.createMetaAccessProfile({
      name: "Duplicate App",
      appId: first.appId,
      businessId: null,
      graphApiVersion: "v26.0",
    })).toThrow("already has an access profile");
    store.setMetaAccessProfileSecretReference(first.id, "vault-secret-bundle");
    expect(store.clearMetaAccessProfileSecret(first.id)).toBe("vault-secret-bundle");
    expect(store.deleteMetaAccessProfile(first.id)).toBeNull();
  });

  it("preserves the shared secret bundle and blocks ordinary App ID replacement", () => {
    const profile = store.createMetaAccessProfile({
      name: "App A",
      appId: "100000000000010",
      businessId: null,
      graphApiVersion: "v26.0",
    });
    store.setMetaAccessProfileSecretReference(profile.id, "vault-secret-bundle");

    expect(store.updateMetaAccessProfile(profile.id, {
      name: "App A with BM",
      appId: profile.appId,
      businessId: "200000000000010",
      graphApiVersion: "v26.0",
    })).toMatchObject({
      profile: { hasAppSecret: true, hasAccessToken: true },
      invalidatedSecretRef: null,
    });
    expect(store.getStoredMetaAccessProfile(profile.id)?.secretRef).toBe("vault-secret-bundle");

    expect(() => store.updateMetaAccessProfile(profile.id, {
      name: "App B",
      appId: "100000000000011",
      businessId: "200000000000010",
      graphApiVersion: "v26.0",
    })).toThrow("不会因普通档案保存而自动清除");
    expect(store.getStoredMetaAccessProfile(profile.id)).toMatchObject({
      appId: "100000000000010",
      secretRef: "vault-secret-bundle",
    });
  });

  it("keeps Meta connections ready for a profile rename but retests discovery changes", () => {
    const profile = store.createMetaAccessProfile({
      name: "Meta Profile",
      appId: "100000000000012",
      businessId: null,
      graphApiVersion: "v26.0",
    });
    store.setMetaAccessProfileSecretReference(profile.id, "vault-meta-secret-bundle");
    const account = store.createAccount({
      displayName: "Meta Profile rename account",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "meta-marketing-api",
    });
    store.saveProviderConnectionSettings(account.id, {
      kind: "meta-marketing-api",
      profileId: profile.id,
      adAccountId: "act_300000000000012",
      pageId: null,
      liveMode: "read-only",
      allowedStatusEntityTypes: [],
    });
    store.updateProviderStatus(account.id, "meta-marketing-api", "ready", "ready");
    store.updateProviderAuthorization(account.id, "meta-marketing-api", {
      status: "active",
      capabilityVersion: "test-meta-v1",
      capabilities: ["read-campaigns", "read-ad-groups", "read-ads"],
    });

    store.updateMetaAccessProfile(profile.id, {
      name: "Meta Profile renamed",
      appId: profile.appId,
      businessId: profile.businessId,
      graphApiVersion: profile.graphApiVersion,
    });
    expect(store.getProviderConnection(account.id, "meta-marketing-api")?.status)
      .toBe("ready");

    store.updateMetaAccessProfile(profile.id, {
      name: "Meta Profile renamed",
      appId: profile.appId,
      businessId: "200000000000012",
      graphApiVersion: profile.graphApiVersion,
    });
    expect(store.getProviderConnection(account.id, "meta-marketing-api")?.status)
      .toBe("untested");
  });

  it("preserves Meta configured and effective status as separate read-model fields", () => {
    const account = store.createAccount({
      displayName: "Meta status read model",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "meta-marketing-api",
    });
    const profile = store.createMetaAccessProfile({
      name: "Meta status app",
      appId: "100000000000009",
      businessId: null,
      graphApiVersion: "v26.0",
    });
    store.setMetaAccessProfileSecretReference(profile.id, "vault-meta-bundle");
    store.saveProviderConnectionSettings(account.id, {
      kind: "meta-marketing-api",
      profileId: profile.id,
      adAccountId: "act_300000000000009",
      pageId: null,
      liveMode: "read-only",
      allowedStatusEntityTypes: [],
    });
    const finishedAt = new Date().toISOString();
    store.saveReadOnlySync(account.id, "meta-marketing-api", [{
      entityType: "ad",
      externalId: "900000000000001",
      payload: {
        name: "Meta ad",
        operation_status: "ACTIVE",
        status: "ACTIVE",
        effective_status: "CAMPAIGN_PAUSED",
      },
    }], {
      startedAt: finishedAt,
      finishedAt,
      counts: { campaign: 0, "ad-group": 0, ad: 1, material: 0 },
      warnings: [],
      quality: healthySyncQuality(finishedAt),
    });

    expect(store.listCurrentManagedEntities(account.id, "meta-marketing-api")).toMatchObject([{
      externalId: "900000000000001",
      status: "enabled",
      configuredStatus: "ACTIVE",
      effectiveStatus: "CAMPAIGN_PAUSED",
    }]);
  });

  it("migrates existing TikTok accounts to the explicit platform without data loss", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-platform-migration-"));
    const databasePath = join(directory, "legacy.db");
    const original = new AutomationStore(databasePath);
    original.seed();
    original.close();

    const legacy = new DatabaseSync(databasePath);
    const childRecord = legacy.prepare(
      `SELECT account_id, switch_key, enabled, updated_at
       FROM automation_switches
       WHERE account_id = 'demo-account'
       ORDER BY switch_key
       LIMIT 1`,
    ).get();
    expect(childRecord).toBeDefined();
    legacy.prepare("DELETE FROM schema_migrations WHERE migration_key IN ('accounts-platform-meta-provider-v1', 'meta-marketing-api-provider-v1')").run();
    legacy.exec("PRAGMA foreign_keys = OFF");
    legacy.exec(`
      CREATE TABLE accounts_legacy (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        account_type TEXT NOT NULL DEFAULT 'standard',
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        provider_kind TEXT NOT NULL CHECK (provider_kind IN ('cookie', 'official-api')),
        credential_ref TEXT,
        timezone TEXT NOT NULL,
        polling_interval_minutes INTEGER NOT NULL,
        max_actions_per_run INTEGER NOT NULL DEFAULT 15,
        updated_at TEXT NOT NULL
      );
      INSERT INTO accounts_legacy (
        id, display_name, account_type, enabled, provider_kind, credential_ref,
        timezone, polling_interval_minutes, max_actions_per_run, updated_at
      ) SELECT id, display_name, account_type, enabled, provider_kind, credential_ref,
        timezone, polling_interval_minutes, max_actions_per_run, updated_at FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_legacy RENAME TO accounts;
    `);
    legacy.close();

    const migrated = new AutomationStore(databasePath);
    expect(migrated.getAccount("demo-account")).toMatchObject({
      platform: "tiktok",
      providerKind: "cookie",
      displayName: "演示广告账户",
    });
    const migratedDatabase = (migrated as unknown as { db: DatabaseSync }).db;
    expect(migratedDatabase.prepare(
      `SELECT account_id, switch_key, enabled, updated_at
       FROM automation_switches
       WHERE account_id = 'demo-account' AND switch_key = ?`,
    ).get(String((childRecord as Record<string, unknown>).switch_key))).toEqual(childRecord);
    expect(migratedDatabase.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(migratedDatabase.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(migratedDatabase.prepare(
      "SELECT migration_key FROM schema_migrations WHERE migration_key = 'accounts-platform-meta-provider-v1'",
    ).get()).toEqual({ migration_key: "accounts-platform-meta-provider-v1" });
    expect(migratedDatabase.prepare(
      "SELECT migration_key FROM schema_migrations WHERE migration_key = 'meta-marketing-api-provider-v1'",
    ).get()).toEqual({ migration_key: "meta-marketing-api-provider-v1" });
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("migrates historical provider connections for Meta Marketing API without losing credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-meta-provider-migration-"));
    const databasePath = join(directory, "historical.db");
    const original = new AutomationStore(databasePath);
    original.seed();
    original.saveProviderConnectionSettings("demo-account", {
      kind: "official-api",
      advertiserId: "historical-advertiser",
    });
    original.setProviderCredentialReference(
      "demo-account",
      "official-api",
      "historical-vault-reference",
    );
    original.close();

    const historical = new DatabaseSync(databasePath);
    historical.prepare(
      "DELETE FROM schema_migrations WHERE migration_key = 'meta-marketing-api-provider-v1'",
    ).run();
    historical.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE provider_connections_historical (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_kind TEXT NOT NULL CHECK (provider_kind IN ('cookie', 'official-api')),
        settings_json TEXT NOT NULL,
        credential_ref TEXT,
        status TEXT NOT NULL CHECK (status IN ('not-configured', 'untested', 'ready', 'failed')),
        authorization_status TEXT NOT NULL DEFAULT 'not-authorized'
          CHECK (authorization_status IN ('not-authorized', 'active', 'expired', 'revoked', 'failed')),
        capability_version TEXT NOT NULL DEFAULT 'legacy-unversioned',
        authorized_capabilities_json TEXT NOT NULL DEFAULT '[]',
        authorized_at TEXT,
        authorization_expires_at TEXT,
        last_message TEXT,
        last_tested_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, provider_kind)
      );
      INSERT INTO provider_connections_historical SELECT * FROM provider_connections;
      DROP TABLE provider_connections;
      ALTER TABLE provider_connections_historical RENAME TO provider_connections;
    `);
    historical.close();

    const migrated = new AutomationStore(databasePath);
    expect(migrated.getProviderConnection("demo-account", "official-api")).toMatchObject({
      credentialRef: "historical-vault-reference",
      hasCredential: true,
      settings: { kind: "official-api", advertiserId: "historical-advertiser" },
    });
    const migratedDatabase = (migrated as unknown as { db: DatabaseSync }).db;
    const providerTableSql = String((migratedDatabase.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'provider_connections'",
    ).get() as { sql: string }).sql);
    expect(providerTableSql).toContain("'meta-marketing-api'");
    expect(migratedDatabase.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(migratedDatabase.prepare(
      "SELECT migration_key FROM schema_migrations WHERE migration_key = 'meta-marketing-api-provider-v1'",
    ).get()).toEqual({ migration_key: "meta-marketing-api-provider-v1" });
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("rolls back foreign-key migrations and restores enforcement when validation fails", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (
        migration_key TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE migration_parents (id TEXT PRIMARY KEY);
      CREATE TABLE migration_children (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES migration_parents(id)
      );
      INSERT INTO migration_parents (id) VALUES ('parent-1');
      INSERT INTO migration_children (id, parent_id) VALUES ('child-1', 'parent-1');
    `);

    const runner = new MigrationRunner(database);
    expect(() => runner.applyWithForeignKeysDisabled("failing-foreign-key-migration", () => {
      database.prepare("DELETE FROM migration_parents WHERE id = 'parent-1'").run();
    })).toThrow("Foreign key check failed during migration failing-foreign-key-migration");

    expect(database.prepare("SELECT * FROM migration_parents").all()).toEqual([{ id: "parent-1" }]);
    expect(database.prepare("SELECT * FROM migration_children").all()).toEqual([
      { id: "child-1", parent_id: "parent-1" },
    ]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare(
      "SELECT migration_key FROM schema_migrations WHERE migration_key = 'failing-foreign-key-migration'",
    ).get()).toBeUndefined();
    database.close();
  });

  it("seeds an account and the fixed global rules", () => {
    expect(store.listAccounts()).toHaveLength(1);
    expect(store.getRuleConfiguration()).toMatchObject({
      lookbackHours: 48,
      layers: { campaign: false, adGroup: true, ad: true },
    });
    // 跟定义数联动，加规则时不用改这个数字
    expect(store.getRuleConfiguration().rules).toHaveLength(automationRuleDefinitions.length);
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

  it("扩组活动查询只回「进行中 + 今日已扩过」：过期租约、往日记录、别的源组都不算", () => {
    const today = "2026-08-22";
    // 今天已扩过：组名与份数都要能回读，预检要靠它们说清楚「扩了哪几个」。
    store.claimAdGroupExpandTask("today-task", "demo-account", "adgroup-today", {
      sourceCampaignId: "campaign-1",
      localDate: today,
      requestedCount: 2,
      generatedNames: ["蓝牙音响-0822-101500-1", "蓝牙音响-0822-101500-2"],
    });
    store.finishAdGroupExpandTask("today-task", "succeeded");

    // 昨天扩过的不该再提示，否则天天扩组的账户会变成每次都弹窗。
    store.claimAdGroupExpandTask("yesterday-task", "demo-account", "adgroup-yesterday", {
      localDate: "2026-08-21",
      requestedCount: 1,
      generatedNames: ["旧组-0821-101500-1"],
    });
    store.finishAdGroupExpandTask("yesterday-task", "succeeded");

    // 租约过期的 running 是上次进程被杀留下的残骸，不算「进行中」，
    // 否则用户会被一条永远消不掉的提示挡住。
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() - 45 * 60_000));
      store.claimAdGroupExpandTask("stale-task", "demo-account", "adgroup-stale", { localDate: today });
    } finally {
      vi.useRealTimers();
    }
    store.claimAdGroupExpandTask("fresh-task", "demo-account", "adgroup-fresh", { localDate: today });

    const activity = store.listAdGroupExpandActivity(
      "demo-account",
      ["adgroup-today", "adgroup-yesterday", "adgroup-stale", "adgroup-fresh"],
      today,
    );
    expect(activity.map((row) => row.sourceAdGroupId).sort()).toEqual(["adgroup-fresh", "adgroup-today"]);
    expect(activity.find((row) => row.sourceAdGroupId === "adgroup-today")).toMatchObject({
      status: "succeeded",
      uncertain: false,
      requestedCount: 2,
      generatedNames: ["蓝牙音响-0822-101500-1", "蓝牙音响-0822-101500-2"],
      sourceCampaignId: "campaign-1",
    });
    expect(activity.find((row) => row.sourceAdGroupId === "adgroup-fresh")).toMatchObject({
      status: "running",
      uncertain: false,
    });

    // 结果未知的任务无论多久都要报出来：这类必须由人工去后台核实。
    store.markAdGroupExpandTaskDispatching("fresh-task");
    expect(store.listAdGroupExpandActivity("demo-account", ["adgroup-fresh"], today)[0])
      .toMatchObject({ uncertain: true });
    // 别的账户查不到这些记录。
    expect(store.listAdGroupExpandActivity("other-account", ["adgroup-today"], today)).toEqual([]);
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
    // 按规则码定位，不按下标：下标会随规则顺序变动而指到别的规则上，
    // 而不同规则支持的参数不同，写进去会被 schema 判为「不支持的参数」。
    const target = configuration.rules.find((rule) => rule.code === "CV1_CPC_CLOSE")!;
    target.enabled = false;
    target.values.cpc = 0.9;

    const updated = store.updateRuleConfiguration(configuration);

    expect(updated.layers.campaign).toBe(true);
    expect(updated.rules.find((rule) => rule.code === "CV1_CPC_CLOSE")).toMatchObject({
      enabled: false,
      values: { cpc: 0.9 },
    });
  });

  it("keeps Meta rules and runtime independent from TikTok", () => {
    const tiktokBefore = store.getRuleConfiguration();
    const metaBefore = store.getMetaRuleConfiguration();
    const runtimeBefore = store.getMetaAutomationRuntime();

    expect(metaBefore).toMatchObject({
      schemaVersion: "meta-v1",
      metricWindow: "account-today",
      layers: { campaign: false, adGroup: false, ad: false },
    });
    expect(metaBefore.rules).toHaveLength(9);
    expect(metaBefore.rules.every((rule) => !rule.enabled)).toBe(true);
    expect(runtimeBefore).toMatchObject({
      enabled: false,
      pollingIntervalMinutes: 5,
      maxActionsPerRun: 15,
    });

    const metaInput = structuredClone(metaBefore);
    metaInput.layers.campaign = true;
    metaInput.rules[0]!.enabled = true;
    const metaAfter = store.updateMetaRuleConfiguration(
      metaInput,
      metaBefore.updatedAt,
    );
    const runtimeAfter = store.updateMetaAutomationRuntime(
      {
        enabled: true,
        pollingIntervalMinutes: 10,
        maxActionsPerRun: 6,
      },
      runtimeBefore.updatedAt,
    );

    expect(metaAfter.layers.campaign).toBe(true);
    expect(metaAfter.rules[0]!.enabled).toBe(true);
    expect(runtimeAfter).toMatchObject({
      enabled: true,
      pollingIntervalMinutes: 10,
      maxActionsPerRun: 6,
    });
    expect(store.getRuleConfiguration()).toEqual(tiktokBefore);
  });

  it("rejects stale Meta rule and runtime updates", () => {
    const meta = store.getMetaRuleConfiguration();
    const runtime = store.getMetaAutomationRuntime();

    store.updateMetaRuleConfiguration(meta, meta.updatedAt);
    store.updateMetaAutomationRuntime(runtime, runtime.updatedAt);

    expect(() => store.updateMetaRuleConfiguration(meta, meta.updatedAt)).toThrow(
      "configuration was updated by another request",
    );
    expect(() => store.updateMetaAutomationRuntime(runtime, runtime.updatedAt)).toThrow(
      "configuration was updated by another request",
    );
  });

  it("persists idempotent Meta creation progress and resumes only explicit failures", () => {
    const account = store.createAccount({
      displayName: "Meta creation fixture",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "meta-marketing-api",
    });
    const input = {
      idempotencyKey: "meta-create-fixture-0001",
      campaignName: "campaign",
      adSetName: "ad set",
      creativeName: "creative",
      adName: "ad",
      objective: "OUTCOME_TRAFFIC" as const,
      optimizationGoal: "LINK_CLICKS" as const,
      billingEvent: "IMPRESSIONS" as const,
      destinationType: "WEBSITE" as const,
      dailyBudgetMinorUnits: 500,
      countries: ["US"],
      destinationUrl: "https://example.com/product",
      primaryText: "primary text",
      headline: "headline",
      description: "description",
      callToAction: "LEARN_MORE" as const,
      imageHash: null,
    };

    const created = store.createMetaCreationTask(account.id, input);
    expect(created.input.targetLevel).toBe("ad");
    const database = (store as unknown as { db: DatabaseSync }).db;
    database.prepare(
      "UPDATE meta_creation_tasks SET input_json = ? WHERE id = ?",
    ).run(JSON.stringify(input), created.id);
    expect(store.getMetaCreationTask(created.id).input.targetLevel).toBe("ad");
    expect(store.createMetaCreationTask(account.id, input).id).toBe(created.id);
    expect(() => store.createMetaCreationTask(account.id, {
      targetLevel: "ad-set",
      idempotencyKey: input.idempotencyKey,
      campaignName: input.campaignName,
      adSetName: input.adSetName,
      objective: input.objective,
      optimizationGoal: input.optimizationGoal,
      billingEvent: input.billingEvent,
      destinationType: input.destinationType,
      dailyBudgetMinorUnits: input.dailyBudgetMinorUnits,
      countries: input.countries,
    })).toThrow("相同幂等键已用于不同的 Meta 创建请求");
    expect(() => store.createMetaCreationTask(account.id, {
      ...input,
      headline: "different headline",
    })).toThrow("相同幂等键已用于不同的 Meta 创建请求");
    expect(store.claimMetaCreationTask(created.id)).toMatchObject({
      status: "running",
      attemptCount: 1,
    });
    store.updateMetaCreationProgress(created.id, {
      phase: "campaign",
      campaignId: "120000000000101",
      message: "campaign confirmed",
    });
    expect(store.completeMetaCreationTask(created.id, "failed", "ad set rejected"))
      .toMatchObject({
        status: "failed",
        phase: "campaign",
        campaignId: "120000000000101",
      });
    expect(store.claimMetaCreationTask(created.id)).toMatchObject({
      status: "running",
      attemptCount: 2,
      campaignId: "120000000000101",
    });
    store.updateMetaCreationProgress(created.id, {
      phase: "ad",
      adSetId: "120000000000102",
      creativeId: "120000000000103",
      adId: "120000000000104",
      message: "ad confirmed",
    });
    expect(store.completeMetaCreationTask(created.id, "succeeded", "done"))
      .toMatchObject({
        status: "succeeded",
        phase: "completed",
        campaignId: "120000000000101",
        adId: "120000000000104",
      });
    expect(store.claimMetaCreationTask(created.id)).toBeNull();
    expect(store.listMetaCreationTasks(account.id)).toHaveLength(1);

    const twoLevel = store.createMetaCreationTask(account.id, {
      targetLevel: "ad-set",
      idempotencyKey: "meta-create-fixture-two-level-0002",
      campaignName: input.campaignName,
      adSetName: input.adSetName,
      objective: input.objective,
      optimizationGoal: input.optimizationGoal,
      billingEvent: input.billingEvent,
      destinationType: input.destinationType,
      dailyBudgetMinorUnits: input.dailyBudgetMinorUnits,
      countries: input.countries,
    });
    expect(store.claimMetaCreationTask(twoLevel.id)).toMatchObject({
      status: "running",
      input: { targetLevel: "ad-set" },
    });
    store.updateMetaCreationProgress(twoLevel.id, {
      phase: "ad-set",
      campaignId: "120000000000151",
      adSetId: "120000000000152",
      message: "two layers confirmed",
    });
    expect(store.completeMetaCreationTask(twoLevel.id, "succeeded", "done"))
      .toMatchObject({
        status: "succeeded",
        phase: "completed",
        campaignId: "120000000000151",
        adSetId: "120000000000152",
        creativeId: null,
        adId: null,
      });

    const unknown = store.createMetaCreationTask(account.id, {
      ...input,
      idempotencyKey: "meta-create-fixture-unknown-0002",
    });
    store.claimMetaCreationTask(unknown.id);
    store.updateMetaCreationProgress(unknown.id, {
      phase: "ad-set",
      campaignId: "120000000000201",
      adSetId: "120000000000202",
      message: "ad set confirmed",
    });
    store.completeMetaCreationTask(unknown.id, "unknown", "creative readback unknown");
    expect(store.resolveUnknownMetaCreationTask(
      unknown.id,
      "failed",
      "creative confirmed absent",
    )).toMatchObject({
      status: "failed",
      phase: "ad-set",
      campaignId: "120000000000201",
      adSetId: "120000000000202",
    });
    expect(store.claimMetaCreationTask(unknown.id)).toMatchObject({
      status: "running",
      attemptCount: 2,
    });

    const notStaleBefore = new Date(Date.now() - 1_000).toISOString();
    expect(store.recoverInterruptedMetaCreationTasks(notStaleBefore)).toBe(0);
    expect(store.getMetaCreationTask(unknown.id).status).toBe("running");
    const staleBefore = new Date(Date.now() + 1_000).toISOString();
    expect(store.recoverInterruptedMetaCreationTasks(staleBefore)).toBe(1);
    expect(store.getMetaCreationTask(unknown.id)).toMatchObject({
      status: "unknown",
      phase: "ad-set",
      campaignId: "120000000000201",
      adSetId: "120000000000202",
      attemptCount: 2,
    });
    expect(store.getMetaCreationTask(unknown.id).message).toContain("只读对账");
    expect(store.recoverInterruptedMetaCreationTasks(staleBefore)).toBe(0);
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

  // 账户失效提醒只在**跳变**时发。失效会持续几小时甚至几天，而轮询最短 45 秒一轮，
  // 按「当前所有失效账户」推送等于持续 @所有人 刷群。
  describe("账户失效提醒的跳变判定", () => {
    const runCycle = (status: "no-action" | "failed", message: string | null = null) => {
      const cycle = store.createPollCycle();
      store.savePollAccountResult(cycle.id, {
        accountId: "demo-account",
        accountName: "演示广告账户",
        runId: null,
        status,
        enabledCount: 0,
        disabledCount: 0,
        failureCount: status === "failed" ? 1 : 0,
        message,
      });
      store.finishPollCycle(cycle.id);
      return cycle.id;
    };

    it("第一次失效会报出来", () => {
      const id = runCycle("failed", "Cookie 已失效");

      const invalid = store.listNewlyInvalidAutomationAccounts(id);
      expect(invalid).toHaveLength(1);
      expect(invalid[0]).toMatchObject({
        accountId: "demo-account",
        message: "Cookie 已失效",
      });
    });

    it("连续失效不再重复报", () => {
      runCycle("failed", "Cookie 已失效");
      const second = runCycle("failed", "Cookie 已失效");

      expect(store.listNewlyInvalidAutomationAccounts(second)).toEqual([]);
    });

    it("恢复之后再次失效，会重新报一次", () => {
      runCycle("failed", "Cookie 已失效");
      runCycle("no-action");
      const again = runCycle("failed", "又失效了");

      expect(store.listNewlyInvalidAutomationAccounts(again)).toHaveLength(1);
    });

    it("正常的批次不报", () => {
      const id = runCycle("no-action");

      expect(store.listNewlyInvalidAutomationAccounts(id)).toEqual([]);
    });

    // 自动化没开的账户失效不影响投放，不值得把所有人叫起来。
    it("自动化未开启的账户失效不报", () => {
      const account = store.getAccount("demo-account")!;
      store.updateAccountSettings("demo-account", {
        displayName: account.displayName,
        accountType: account.accountType,
        enabled: false,
        providerKind: account.providerKind,
      });

      const id = runCycle("failed", "Cookie 已失效");

      expect(store.listNewlyInvalidAutomationAccounts(id)).toEqual([]);
    });
  });

  describe("自动化在管的关停广告组", () => {
    const recordDecision = (
      externalId: string,
      action: "disable" | "enable",
      status: "succeeded" | "failed" = "succeeded",
    ) => {
      const run = store.createAutomationRun("demo-account", "cookie", "scheduler", true);
      const decision = store.saveAutomationDecision(
        run,
        {
          thresholdId: "NO_CONV_SPEND_CLOSE",
          thresholdCode: "NO_CONV_SPEND_CLOSE",
          entity: {
            entityType: "ad-group",
            externalId,
            name: externalId,
            status: "disabled",
            parentCampaignId: null,
            parentAdGroupId: null,
            campaignBudget: null,
            campaignBudgetOptimized: false,
            metrics: {
              cost_per_conversion: null, cost_per_click: null, cost_per_cart: null,
              budget: null, spend: 0, conversions: 0, clicks: 0, carts: 0, impressions: 0,
            },
          },
          action,
          metric: "spend",
          metricValue: 2,
          operator: "gt",
          thresholdValue: 2,
          cooldownMinutes: 60,
          reason: "test",
        },
        "pending",
      );
      store.updateAutomationDecision(decision.id, status);
    };
    const since = () => new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();

    it("列出自动化关停、且此后未被自动重开的广告组", () => {
      recordDecision("ag-still-closed", "disable");
      expect(store.listAutomationDisabledAdGroupIds("demo-account", since()))
        .toContain("ag-still-closed");
    });

    it("已被自动重新开启的不再算在管关停", () => {
      // 真实场景里关停与重开相隔数分钟以上；用假时钟给出可区分的 executed_at，
      // 否则同毫秒记录会让"enable 晚于 disable"的判定退化。
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-11T00:00:00.000Z"));
      recordDecision("ag-reopened", "disable");
      vi.setSystemTime(new Date("2026-08-11T01:00:00.000Z"));
      recordDecision("ag-reopened", "enable");
      const cutoff = new Date("2026-08-04T00:00:00.000Z").toISOString();
      vi.useRealTimers();
      expect(store.listAutomationDisabledAdGroupIds("demo-account", cutoff))
        .not.toContain("ag-reopened");
    });

    it("关停失败的不算（只认 succeeded）", () => {
      recordDecision("ag-failed", "disable", "failed");
      expect(store.listAutomationDisabledAdGroupIds("demo-account", since()))
        .not.toContain("ag-failed");
    });

    it("超出回看窗口的不再兜底", () => {
      recordDecision("ag-old", "disable");
      const futureSince = new Date(Date.now() + 60_000).toISOString();
      expect(store.listAutomationDisabledAdGroupIds("demo-account", futureSince))
        .not.toContain("ag-old");
    });

    it("在管关停的广告组在实体快照上标出 automationManaged，供界面判定是否参与自动化", () => {
      recordDecision("ag-managed", "disable");
      store.saveReadOnlySync("demo-account", "cookie", [
        { entityType: "ad-group", externalId: "ag-managed", payload: { ad_name: "在管关停" } },
        { entityType: "ad-group", externalId: "ag-untouched", payload: { ad_name: "自动化没碰过" } },
      ], {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        counts: { campaign: 0, "ad-group": 2, ad: 0, material: 0 },
        warnings: [],
        quality: healthySyncQuality(new Date().toISOString()),
      });

      const byId = new Map(
        store.listCurrentManagedEntities("demo-account", "cookie")
          .map((entity) => [entity.externalId, entity]),
      );
      expect(byId.get("ag-managed")?.automationManaged).toBe(true);
      expect(byId.get("ag-untouched")?.automationManaged).toBe(false);
    });
  });

  describe("按自然日汇总指标", () => {
    // 平台回传的是当日累计值，一天里写几十条快照。按批次相加会把一天重复计几十遍，
    // 正确口径是每个实体取当天最后一条。demo-account 是 Asia/Shanghai(+8)，因此
    // UTC 16:00 之后已经属于第二个自然日——这条边界是整段逻辑最容易错的地方。
    const capture = (finishedAt: string, spends: Record<string, number>) => {
      store.saveReadOnlySync("demo-account", "cookie",
        Object.entries(spends).map(([externalId, stat_cost]) => ({
          entityType: "ad-group" as const,
          externalId,
          payload: { ad_name: externalId, stat_cost },
        })),
        {
          startedAt: finishedAt,
          finishedAt,
          counts: { campaign: 0, "ad-group": Object.keys(spends).length, ad: 0, material: 0 },
          warnings: [],
          quality: healthySyncQuality(finishedAt),
        },
      );
    };

    it("每个实体取当天最后一条累计值，跨自然日按账户时区切分", () => {
      capture("2026-08-19T01:00:00.000Z", { g1: 1, g2: 0.5 });   // 当地 08-19 09:00
      capture("2026-08-19T10:00:00.000Z", { g1: 6, g2: 2 });     // 当地 08-19 18:00
      capture("2026-08-19T15:30:00.000Z", { g1: 9, g2: 3 });     // 当地 08-19 23:30
      capture("2026-08-19T16:30:00.000Z", { g1: 0.4, g2: 0.1 }); // 当地 08-20 00:30，累计已归零

      const days = store.listDailyMetricTotals(
        "demo-account", "cookie", "2026-08-18T00:00:00.000Z", "ad-group", "2026-08-21T00:00:00.000Z",
      );

      expect(days.map((day) => [day.date, Number(day.spend.toFixed(2))])).toEqual([
        ["2026-08-20", 0.5],  // 归零后的新一天，不是 12 + 0.5
        ["2026-08-19", 12],   // 9 + 3，取当天最后一条，而不是四个批次相加
      ]);
      expect(days.find((day) => day.date === "2026-08-19")?.lastLocalTime).toBe("23:30");
    });

    it("同步中断的日子把截止时刻如实带出来，供界面标注偏低", () => {
      capture("2026-08-19T00:06:00.000Z", { g1: 4.6 }); // 当地 08-19 08:06 之后再无快照

      const day = store.listDailyMetricTotals(
        "demo-account", "cookie", "2026-08-18T00:00:00.000Z", "ad-group", "2026-08-21T00:00:00.000Z",
      ).find((item) => item.date === "2026-08-19");

      expect(day?.lastLocalTime).toBe("08:06");
      expect(day?.isCurrentDay).toBe(false);
    });
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

  it("aborts startup on an unreadable database without destroying the original file", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-store-failed-migration-"));
    const databasePath = join(directory, "automation.db");
    writeFileSync(databasePath, "not a sqlite database", "utf8");

    expect(() => new AutomationStore(databasePath)).toThrow(
      "数据库迁移失败，服务未启动",
    );

    // 迁移前备份改为按需（VACUUM INTO），一个根本打不开的文件既无法快照、也没有
    // 有价值的数据可保——不再无脑复制一份垃圾。关键安全性质是：原文件原样保留，
    // 供人工排查，而不是被启动流程改动或删掉。
    expect(readFileSync(databasePath, "utf8")).toBe("not a sqlite database");

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

  it("keeps the database consistent and data intact when an upgrade migration fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-upgrade-rollback-"));
    const databasePath = join(directory, "automation.db");
    const original = new AutomationStore(databasePath);
    original.seed();
    const account = original.createAccount({
      displayName: "回滚哨兵",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    original.close();

    // 模拟一次会失败的升级迁移。核心安全性质：失败必须让服务拒绝启动，且既有数据
    // 不被破坏——迁移前的 CREATE TABLE/INDEX IF NOT EXISTS 都是非破坏性的，真正的
    // 数据迁移在 apply 的事务里，失败即回滚。
    vi.spyOn(MigrationRunner.prototype, "apply").mockImplementationOnce(() => {
      throw new Error("simulated upgrade failure");
    });
    expect(() => new AutomationStore(databasePath)).toThrow("数据库迁移失败，服务未启动");
    vi.restoreAllMocks();

    const inspected = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspected.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    inspected.close();
    // 库仍能被正常打开，且哨兵账户还在——失败的升级没有吞掉数据。
    const recovered = new AutomationStore(databasePath);
    expect(recovered.getAccount(account.id)?.displayName).toBe("回滚哨兵");
    recovered.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("skips the pre-migration backup on startups with no pending migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-lazy-backup-"));
    const databasePath = join(directory, "automation.db");
    const backupCount = () =>
      readdirSync(directory).filter(
        (name) => name.startsWith("automation.db.pre-migration-") && name.endsWith(".bak"),
      ).length;

    // 全新库首次初始化：没有既有数据要保护 → 不做迁移前备份（与旧的 !existsSync 一致）。
    const first = new AutomationStore(databasePath);
    first.seed();
    first.close();
    expect(backupCount()).toBe(0);

    // 已迁移到最新的库再开一次：无待跑迁移 → 一次备份都不做。这正是 800MB 库不再
    // 每次启动都拷贝 + VACUUM 整库、冷启动从 30 秒降到秒级的关键。
    // （既有库遇到待跑迁移时仍会备份——由 rollback 与 snapshot-promotion 两个用例覆盖。）
    const second = new AutomationStore(databasePath);
    second.close();
    expect(backupCount()).toBe(0);

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
      // 06:00 取【未来最近的那个】，因此两个账户会落在不同的日历日：
      //   台北当地 17:15，已过 06:00 -> 次日早上（UTC 7/23 22:00）
      //   纽约当地 05:15，还没到     -> 当天早上（UTC 7/23 10:00），只等 45 分钟
      // 旧逻辑无条件 +1 天，会把纽约排到第二天早上，白等 24 小时。
      expect(reviewedTimes).toEqual({
        [east.id]: "2026-07-23T22:00:00.000Z",
        [west.id]: "2026-07-23T10:00:00.000Z",
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

  it("resolves an unknown status write from a read-only provider readback", () => {
    const succeededTask = store.createStatusWriteTask({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "group-readback-success",
      entityName: "readback success group",
      action: "disable",
      source: "manual",
    }, { id: "operator-1", name: "Operator", kind: "user" });
    store.claimStatusWriteTask(succeededTask.id, "executor-a", "pending");
    store.completeStatusWriteTask(succeededTask.id, "executor-a", "unknown", "response lost");

    expect(store.resolveUnknownStatusWriteTaskFromReadback(
      succeededTask.id,
      "disabled",
      { id: "meta-readback", name: "Meta readback", kind: "system" },
    )).toMatchObject({
      status: "succeeded",
      phase: "readback",
      syncWarning: null,
      message: expect.stringContaining("只读回读确认"),
    });

    const failedTask = store.createStatusWriteTask({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "group-readback-failed",
      entityName: "readback failed group",
      action: "enable",
      source: "manual",
    }, { id: "operator-1", name: "Operator", kind: "user" });
    store.claimStatusWriteTask(failedTask.id, "executor-b", "pending");
    store.completeStatusWriteTask(failedTask.id, "executor-b", "unknown", "response lost");

    expect(store.resolveUnknownStatusWriteTaskFromReadback(
      failedTask.id,
      "disabled",
      { id: "meta-readback", name: "Meta readback", kind: "system" },
    )).toMatchObject({
      status: "unknown",
    });
    expect(store.hasBlockingStatusOperationForEntity(
      "demo-account",
      "cookie",
      "ad-group",
      "group-readback-failed",
    )).toBe(true);
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

/**
 * 新增固有规则时，存量库里那份旧配置必须能自动补齐。
 *
 * 没有回填的话，getRuleConfiguration 的 schema 校验（规则数必须等于定义数、每个码都
 * 要在）会直接抛错——不是少一条规则，是规则页和规则引擎一起读不出来。用真实文件库
 * 加独立连接改写 rules_json 来模拟升级前的状态，不给生产 API 开测试专用后门。
 */
describe("规则码回填", () => {
  const legacyStore = (mutate: (rules: unknown[]) => unknown[]) => {
    const directory = mkdtempSync(join(tmpdir(), "tk-rule-backfill-"));
    const databasePath = join(directory, "legacy.db");
    const seeded = new AutomationStore(databasePath);
    seeded.seed();
    const before = seeded.getRuleConfiguration().rules;
    seeded.close();

    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE global_rule_configuration SET rules_json = ? WHERE id = 1")
      .run(JSON.stringify(mutate(structuredClone(before) as unknown[])));
    raw.close();

    const reopened = new AutomationStore(databasePath);
    reopened.seed();
    return { store: reopened, directory };
  };

  const drop = (code: string) => (rules: unknown[]) =>
    rules.filter((rule) => (rule as { code: string }).code !== code);

  it("旧配置缺新规则码时自动补上，且不动用户调过的值", () => {
    const { store, directory } = legacyStore((rules) =>
      drop("CV1_LOW_CART_CPA_CLOSE")(rules).map((rule) =>
        (rule as { code: string }).code === "CV1_CPC_CLOSE"
          ? { ...(rule as object), values: { conversions: 1, cpc: 0.55 } }
          : rule));

    const loaded = store.getRuleConfiguration();

    expect(loaded.rules.some((rule) => rule.code === "CV1_LOW_CART_CPA_CLOSE")).toBe(true);
    expect(loaded.rules.find((rule) => rule.code === "CV1_CPC_CLOSE")?.values.cpc).toBe(0.55);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("补进来的新规则默认关闭，升级不会自己开始关广告组", () => {
    const { store, directory } = legacyStore(drop("CV1_LOW_CART_CPA_CLOSE"));

    expect(
      store.getRuleConfiguration().rules
        .find((rule) => rule.code === "CV1_LOW_CART_CPA_CLOSE")?.enabled,
    ).toBe(false);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  // 生产上「单次转化 CPA 过高」是 5，而新规则的默认值是 9。直接落默认值会当场违反
  // 「不得高于」的约束，整份配置在升级后连读都读不出来。
  it("新规则的 CPA 跟随存量里的单次转化 CPA，不会因为默认值更高而违反约束", () => {
    const { store, directory } = legacyStore((rules) =>
      drop("CV1_LOW_CART_CPA_CLOSE")(rules).map((rule) =>
        (rule as { code: string }).code === "CV1_CPA_CLOSE"
          ? { ...(rule as object), values: { conversions: 1, cpa: 5 } }
          : rule));

    // 读得出来本身就是断言：读不出来会在这里抛错
    const loaded = store.getRuleConfiguration();

    expect(loaded.rules.find((rule) => rule.code === "CV1_LOW_CART_CPA_CLOSE")?.values.cpa)
      .toBe(5);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  // 规则被删除时同样会让长度校验失败，一并兜住。
  it("配置里出现定义里没有的码时会被丢掉", () => {
    const { store, directory } = legacyStore((rules) =>
      [...rules, { code: "SOME_REMOVED_RULE", enabled: true, values: {} }]);

    const loaded = store.getRuleConfiguration();

    expect(loaded.rules.some((rule) => String(rule.code) === "SOME_REMOVED_RULE")).toBe(false);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
