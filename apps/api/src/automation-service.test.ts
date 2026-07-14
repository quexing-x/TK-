import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProviderEntity } from "@tk-auto/core";
import { InMemoryCredentialVault } from "@tk-auto/credentials";
import {
  ProviderRegistry,
  type AdsProvider,
  type StatusMutation,
} from "@tk-auto/providers";
import { AutomationStore } from "@tk-auto/storage";
import {
  AutomationScheduler,
  AutomationService,
  type PollNotificationDispatcher,
} from "./automation-service.js";

class FakeProvider implements AdsProvider {
  readonly kind = "cookie" as const;
  readonly displayName = "Fake Cookie";
  readonly capabilities = new Set(["read-ad-groups", "change-status"] as const);
  readonly mutations: StatusMutation[] = [];
  shouldFail = false;
  campaignCreatedAt = new Date().toISOString();
  scenario: "default" | "parent-child" | "priority" = "default";

  async checkHealth() {
    return { ok: true, status: "ready" as const, message: "ready" };
  }

  async syncReadOnly() {
    const campaign: ProviderEntity = {
      entityType: "campaign",
      externalId: "campaign-1",
      payload: {
        campaign_id: "campaign-1",
        campaign_name: "测试推广系列",
        campaign_status: "enable",
        create_time: this.campaignCreatedAt,
      },
    };
    const defaultGroup: ProviderEntity = {
      entityType: "ad-group",
      externalId: "adgroup-1",
      payload: {
        campaign_id: "campaign-1",
        ad_name: "测试广告组",
        ad_primary_status: "enable",
        row_data: {
          campaign_id: "campaign-1",
          stat_cost: "20",
          cpc: "1.5",
          click_cnt: "10",
          time_attr_convert_cnt: "0",
          time_attr_on_web_cart: "0",
        },
      },
    };
    const entities: ProviderEntity[] = [campaign, defaultGroup];
    if (this.scenario === "parent-child") {
      entities.push({
        entityType: "ad",
        externalId: "ad-1",
        payload: {
          campaign_id: "campaign-1",
          adgroup_id: "adgroup-1",
          ad_name: "测试子广告",
          ad_primary_status: "disable",
          row_data: {
            campaign_id: "campaign-1",
            adgroup_id: "adgroup-1",
            stat_cost: "5",
            cpc: "0.5",
            time_attr_convert_cnt: "1",
            time_attr_conversion_cost: "5",
            time_attr_on_web_cart: "1",
          },
        },
      });
    }
    if (this.scenario === "priority") {
      defaultGroup.externalId = "adgroup-low-priority";
      defaultGroup.payload.row_data = {
        campaign_id: "campaign-1",
        stat_cost: "3",
        cpc: "0.4",
        time_attr_convert_cnt: "0",
        time_attr_on_web_cart: "0",
      };
      entities.push({
        entityType: "ad-group",
        externalId: "adgroup-high-priority",
        payload: {
          campaign_id: "campaign-1",
          ad_name: "高优先级广告组",
          ad_primary_status: "enable",
          row_data: {
            campaign_id: "campaign-1",
            stat_cost: "5",
            cpc: "1",
            click_cnt: "10",
            time_attr_convert_cnt: "1",
            time_attr_conversion_cost: "5",
            time_attr_on_web_cart: "1",
          },
        },
      });
    }
    const now = new Date().toISOString();
    return {
      entities,
      result: {
        startedAt: now,
        finishedAt: now,
        counts: {
          campaign: entities.filter((entity) => entity.entityType === "campaign").length,
          "ad-group": entities.filter((entity) => entity.entityType === "ad-group").length,
          ad: entities.filter((entity) => entity.entityType === "ad").length,
        },
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

  it("executes matching decisions automatically by default", async () => {
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
    provider.shouldFail = true;

    const run = await service.runAccount("demo-account", "manual");

    expect(run.failureCount).toBe(1);
    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({
      status: "failed",
      lastMessage: "真实启停失败：rejected",
    });
  });

  it("does not evaluate campaigns older than 48 hours", async () => {
    provider.campaignCreatedAt = new Date(Date.now() - 49 * 60 * 60 * 1_000).toISOString();

    const run = await service.runAccount("demo-account", "preview");

    expect(run.candidateCount).toBe(0);
    expect(provider.mutations).toHaveLength(0);
  });

  it("does not run when the account automation switch is off", async () => {
    const account = store.getAccount("demo-account")!;
    store.updateAccountSettings("demo-account", {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: false,
      providerKind: account.providerKind,
    });

    await expect(service.runAccount("demo-account", "manual")).rejects.toThrow(
      "账户自动化已关闭",
    );
    expect(provider.mutations).toHaveLength(0);

    const preview = await service.runAccount("demo-account", "preview");
    expect(preview.candidateCount).toBe(1);
    expect(provider.mutations).toHaveLength(0);
  });

  it("executes higher-priority rules before applying the per-run limit", async () => {
    provider.scenario = "priority";
    store.updateGlobalAutomationSettings({
      pollingIntervalMinutes: 5,
      maxActionsPerRun: 1,
    });

    await service.runAccount("demo-account", "manual");

    expect(provider.mutations).toEqual([
      {
        entityType: "ad-group",
        externalId: "adgroup-high-priority",
        action: "disable",
      },
    ]);
  });

  it("summarizes one due scheduler cycle and dispatches it once", async () => {
    const cycles: Parameters<PollNotificationDispatcher["enqueueAndDispatch"]>[0][] = [];
    const dispatcher: PollNotificationDispatcher = {
      flushPending: vi.fn(async () => undefined),
      enqueueAndDispatch: vi.fn(async (cycle) => {
        cycles.push(cycle);
      }),
    };
    const scheduler = new AutomationScheduler(store, service, dispatcher);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 6 * 60_000));

    await scheduler.tick();
    await scheduler.tick();

    vi.useRealTimers();
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.accounts[0]).toMatchObject({
      accountName: "演示广告账户",
      status: "changed",
      enabledCount: 0,
      disabledCount: 1,
    });
  });

  it("continues polling when notification delivery is unavailable", async () => {
    const dispatcher: PollNotificationDispatcher = {
      flushPending: vi.fn(async () => {
        throw new Error("notification storage unavailable");
      }),
      enqueueAndDispatch: vi.fn(async () => {
        throw new Error("notification delivery unavailable");
      }),
    };
    const scheduler = new AutomationScheduler(store, service, dispatcher);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 6 * 60_000));

    await expect(scheduler.tick()).resolves.toBeUndefined();

    vi.useRealTimers();
    expect(store.listPollCycles()).toHaveLength(1);
    expect(store.listAutomationRuns("demo-account")).toHaveLength(1);
  });

  it("does not open a child ad when its parent ad group closes in the same run", async () => {
    provider.scenario = "parent-child";

    const run = await service.runAccount("demo-account", "manual");

    expect(run.candidateCount).toBe(2);
    expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
    ]);
    expect(
      store
        .listAutomationDecisions("demo-account")
        .find((decision) => decision.externalId === "ad-1"),
    ).toMatchObject({
      status: "skipped",
      errorMessage: "父广告组将在本轮关闭，不执行子广告开启。",
    });
  });
});
