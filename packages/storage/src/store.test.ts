import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    expect(store.getAutomationSwitches(account.id).manageAdStatus).toBe(false);
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
