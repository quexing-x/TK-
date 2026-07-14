import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("seeds an account and thresholds", () => {
    expect(store.listAccounts()).toHaveLength(1);
    expect(store.listGlobalThresholds()).toHaveLength(6);
    expect(store.getGlobalAutomationSettings()).toMatchObject({
      pollingIntervalMinutes: 5,
      maxActionsPerRun: 15,
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
      executionMode: "observe",
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
});
