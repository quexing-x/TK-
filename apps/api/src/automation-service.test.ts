import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultAutomationSwitches,
  type ProviderEntity,
} from "@tk-auto/core";
import { InMemoryCredentialVault } from "@tk-auto/credentials";
import {
  ProviderRegistry,
  type AdsProvider,
  type StatusMutation,
} from "@tk-auto/providers";
import { AutomationStore } from "@tk-auto/storage";
import { AutomationService } from "./automation-service.js";

class FakeProvider implements AdsProvider {
  readonly kind = "cookie" as const;
  readonly displayName = "Fake Cookie";
  readonly capabilities = new Set(["read-ad-groups", "change-status"] as const);
  readonly mutations: StatusMutation[] = [];
  shouldFail = false;

  async checkHealth() {
    return { ok: true, status: "ready" as const, message: "ready" };
  }

  async syncReadOnly() {
    const entities: ProviderEntity[] = [
      {
        entityType: "ad-group",
        externalId: "adgroup-1",
        payload: {
          ad_name: "测试广告组",
          ad_primary_status: "enable",
          row_data: { stat_cost: "20", cpc: "1.5", click_cnt: "10" },
        },
      },
    ];
    const now = new Date().toISOString();
    return {
      entities,
      result: {
        startedAt: now,
        finishedAt: now,
        counts: { campaign: 0, "ad-group": 1, ad: 0 },
        warnings: [],
      },
    };
  }

  async changeStatus(_context: unknown, mutations: StatusMutation[]) {
    this.mutations.push(...mutations);
    return mutations.map((mutation) => ({
      ...mutation,
      ok: !this.shouldFail,
      message: this.shouldFail ? "rejected" : "accepted",
    }));
  }
}

describe("AutomationService", () => {
  let store: AutomationStore;
  let vault: InMemoryCredentialVault;
  let provider: FakeProvider;
  let service: AutomationService;

  beforeEach(async () => {
    store = new AutomationStore(":memory:");
    store.seed();
    vault = new InMemoryCredentialVault();
    provider = new FakeProvider();
    service = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider]),
    );

    store.saveProviderConnectionSettings("demo-account", {
      kind: "cookie",
      advertiserId: "123",
      healthUrl: "",
      campaignsUrl: "",
      adGroupsUrl: "",
      adsUrl: "",
    });
    const reference = await vault.create(
      JSON.stringify({
        kind: "cookie",
        cookie: "sessionid=test-cookie",
        csrfHeaderName: "x-csrftoken",
      }),
    );
    store.setProviderCredentialReference("demo-account", "cookie", reference);
    store.updateProviderStatus("demo-account", "cookie", "ready", "ready");

    const switches = createDefaultAutomationSwitches();
    switches.manageAdGroupStatus = true;
    store.updateAutomationSwitches("demo-account", switches);

    const threshold = store.listGlobalThresholds()[1]!;
    store.updateGlobalThreshold(threshold.id, {
      code: threshold.code,
      label: threshold.label,
      metric: "cost_per_click",
      operator: "gte",
      value: 1,
      unit: "账户币种",
      stage: "stage-1",
      enabled: true,
      entityType: "ad-group",
      action: "disable",
      automationEnabled: true,
      minimumSpend: 10,
      cooldownMinutes: 60,
    });
  });

  afterEach(() => store.close());

  it("previews matching decisions without writing", async () => {
    const run = await service.runAccount("demo-account", "preview");

    expect(run.candidateCount).toBe(1);
    expect(provider.mutations).toHaveLength(0);
    expect(store.listAutomationDecisions("demo-account")[0]?.status).toBe(
      "preview",
    );
  });

  it("executes matching decisions in automatic mode", async () => {
    const account = store.getAccount("demo-account")!;
    store.updateAccountSettings("demo-account", {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: true,
      providerKind: "cookie",
      executionMode: "automatic",
    });

    const run = await service.runAccount("demo-account", "manual");

    expect(run.successCount).toBe(1);
    expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
    ]);
    expect(store.listAutomationDecisions("demo-account")[0]?.status).toBe(
      "succeeded",
    );
  });

  it("marks the connection abnormal after a real status write fails", async () => {
    const account = store.getAccount("demo-account")!;
    store.updateAccountSettings("demo-account", {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: true,
      providerKind: "cookie",
      executionMode: "automatic",
    });
    provider.shouldFail = true;

    const run = await service.runAccount("demo-account", "manual");

    expect(run.failureCount).toBe(1);
    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({
      status: "failed",
      lastMessage: "真实启停失败：rejected",
    });
  });
});
