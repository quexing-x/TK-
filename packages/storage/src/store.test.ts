import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDefaultAutomationSwitches } from "@tk-auto/core";
import { AutomationStore } from "./store.js";

describe("AutomationStore", () => {
  let store: AutomationStore;

  beforeEach(() => {
    store = new AutomationStore(":memory:");
    store.seed();
  });

  afterEach(() => {
    store.close();
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
  });

  it("migrates existing accounts to the default automatic execution mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "tk-auto-store-"));
    const databasePath = join(directory, "automation.db");
    const firstStore = new AutomationStore(databasePath);
    firstStore.seed();
    firstStore.close();

    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase
      .prepare("UPDATE accounts SET execution_mode = 'manual-approval'")
      .run();
    legacyDatabase
      .prepare(
        "DELETE FROM schema_migrations WHERE migration_key = 'default-automatic-execution-v1'",
      )
      .run();
    legacyDatabase.close();

    const reopenedStore = new AutomationStore(databasePath);
    expect(reopenedStore.getAccount("demo-account")?.executionMode).toBe(
      "automatic",
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

  it("creates an independent advertising account", () => {
    const account = store.createAccount({
      displayName: "第二广告账户",
      accountType: "agency",
      enabled: true,
      providerKind: "official-api",
    });

    expect(account.accountType).toBe("agency");
    expect(account.executionMode).toBe("automatic");
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
    store.saveReadOnlySync("demo-account", "cookie", [], {
      startedAt: "2026-07-16T01:00:00.000Z",
      finishedAt: "2026-07-16T01:01:00.000Z",
      counts: { campaign: 1, "ad-group": 1, ad: 1 },
      warnings: [],
    });

    expect(store.getLatestReadOnlySync("demo-account", "cookie")).toEqual({
      startedAt: "2026-07-16T01:00:00.000Z",
      finishedAt: "2026-07-16T01:01:00.000Z",
      counts: { campaign: 1, "ad-group": 1, ad: 1 },
      warnings: [],
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

  it("stores a non-executing multi-account launch plan", () => {
    saveEntity(store, "ad", "ad-1", "源广告");
    const target = store.createAccount({
      displayName: "目标账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    const plan = store.createMultiAccountLaunchPlan({
      mode: "copy",
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
        initialStatus: "disabled",
      }],
    });
    expect(plan.status).toBe("blocked");
    expect(plan.message).toContain("等待创建执行器发布");
  });

  it("stores spreadsheet launch rows without duplicating account selection", () => {
    saveEntity(store, "ad", "ad-sheet", "表格源广告");
    const target = store.createAccount({
      displayName: "表格目标账户",
      accountType: "standard",
      enabled: true,
      providerKind: "cookie",
    });
    const plan = store.createMultiAccountLaunchPlan({
      mode: "copy",
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
        initialStatus: "disabled",
      }],
    });

    expect(plan.launchRows).toHaveLength(1);
    expect(plan.launchRows[0]?.campaignName).toBe("测试系列");
    expect(store.listMultiAccountLaunchPlans()[0]?.launchRows).toEqual(plan.launchRows);
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

  it("uses the saved preset as the server authority and allocates unique automatic names", () => {
    saveEntity(store, "ad", "ad-preset", "预设源广告");
    const target = store.createAccount({ displayName: "预设目标", accountType: "standard", enabled: true, providerKind: "cookie" });
    const preset = store.createLaunchPreset({
      name: "美国预设", region: "US", dailyBudget: 250, bid: 2.5,
      startAt: "2026-07-20T08:00:00.000Z", endAt: null, initialStatus: "disabled",
    });
    const input = {
      mode: "copy" as const,
      sourceAccountId: "demo-account", sourceAdId: "ad-preset", targetAccountIds: [target.id], launchPresetId: preset.id,
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
    });

    expect(store.listMetricBatches("demo-account", "cookie", "2020-01-01T00:00:00.000Z")[0]).toMatchObject({
      capturedAt,
      count: 5_101,
      spend: 5_101,
      clicks: 10_202,
      conversions: 15_303,
    });
  });
});

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
    },
  );
}
