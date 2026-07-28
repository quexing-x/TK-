import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProviderEntity } from "@tk-auto/core";
import type { SyncDataQualityStatus } from "@tk-auto/core";
import { InMemoryCredentialVault } from "@tk-auto/credentials";
import {
  ProviderRegistry,
  type AppealMutation,
  type AdsProvider,
  type DeleteAdGroupMutation,
  type StatusMutation,
} from "@tk-auto/providers";
import { AutomationStore } from "@tk-auto/storage";
import {
  AutomationScheduler,
  AutomationService,
  type PollNotificationDispatcher,
} from "./automation-service.js";

function dateKeyInTimeZoneForTest(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: "year" | "month" | "day") =>
    parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function futureShanghaiTime(hour: number, minute = 0): Date {
  const value = new Date(Date.now() + 24 * 60 * 60_000);
  value.setUTCHours((hour + 16) % 24, minute, 0, 0);
  return value;
}

class FakeProvider implements AdsProvider {
  readonly kind = "cookie" as const;
  readonly displayName = "Fake Cookie";
  readonly capabilityVersion = "fake-cookie-v1";
  readonly capabilities = new Set(["read-campaigns", "read-ad-groups", "change-status", "appeal-ads", "copy-ads", "delete-ad-groups"] as const);
  readonly mutations: StatusMutation[] = [];
  readonly appeals: AppealMutation[] = [];
  readonly appealOutcomes: boolean[] = [];
  readonly deletions: DeleteAdGroupMutation[] = [];
  deleteFailureKind: "retryable" | "unknown" | null = null;
  shouldFail = false;
  statusFailureKind: "retryable" | "unknown" | null = null;
  throwStatusError = false;
  statusDelayMs = 0;
  adGroupStatus = "enable";
  priorityHighStatus = "enable";
  shouldSyncFail = false;
  ignoreStatusWrites = false;
  failReadbackAfterStatus = false;
  failNextSync = false;
  afterSync: (() => void | Promise<void>) | null = null;
  campaignCreatedAt = new Date().toISOString();
  scheduledStartAt = "2026-07-19T00:00:00.000Z";
  adGroupConversions = 0;
  adGroupCpa: number | null = null;
  adGroupCpc = 1.5;
  adGroupCarts = 0;
  scenario: "default" | "parent-child" | "campaign-parent-child" | "disabled-parent" | "priority" | "recovery" | "appeal" = "default";
  qualityStatus: SyncDataQualityStatus = "healthy";
  syncCount = 0;

  async checkHealth(): Promise<{
    ok: boolean;
    status: "ready" | "failed";
    message: string;
  }> {
    return { ok: true, status: "ready" as const, message: "ready" };
  }

  async syncReadOnly() {
    this.syncCount += 1;
    if (this.failNextSync) {
      this.failNextSync = false;
      throw new Error("post-write sync unavailable");
    }
    if (this.shouldSyncFail) throw new Error("sync unavailable");
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
        ad_primary_status: this.adGroupStatus,
        create_time: this.campaignCreatedAt,
        start_time: this.scheduledStartAt,
        row_data: {
          campaign_id: "campaign-1",
          stat_cost: "20",
          cpc: String(this.adGroupCpc),
          click_cnt: "10",
          time_attr_convert_cnt: String(this.adGroupConversions),
          ...(this.adGroupCpa === null
            ? {}
            : { time_attr_conversion_cost: String(this.adGroupCpa) }),
          time_attr_on_web_cart: String(this.adGroupCarts),
        },
      },
    };
    const entities: ProviderEntity[] = [campaign, defaultGroup];
    if (this.scenario === "campaign-parent-child") {
      campaign.payload.row_data = {
        campaign_id: "campaign-1",
        stat_cost: "20",
        cpc: "1.5",
        time_attr_convert_cnt: "0",
        time_attr_on_web_cart: "0",
      };
      defaultGroup.payload.ad_primary_status = "disable";
      defaultGroup.payload.row_data = {
        campaign_id: "campaign-1",
        stat_cost: "20",
        cpc: "0.1",
        time_attr_convert_cnt: "1",
        time_attr_conversion_cost: "1",
        time_attr_on_web_cart: "1",
      };
    }
    if (this.scenario === "recovery") {
      defaultGroup.payload.ad_primary_status = this.adGroupStatus;
      defaultGroup.payload.row_data = {
        campaign_id: "campaign-1",
        stat_cost: "20",
        cpc: "0.1",
        click_cnt: "10",
        time_attr_convert_cnt: "1",
        time_attr_conversion_cost: "1",
        time_attr_on_web_cart: "1",
      };
    }
    if (this.scenario === "disabled-parent") {
      campaign.payload.campaign_status = "disable";
      defaultGroup.payload.ad_primary_status = "disable";
      defaultGroup.payload.row_data = {
        campaign_id: "campaign-1",
        stat_cost: "20",
        cpc: "0.1",
        click_cnt: "10",
        time_attr_convert_cnt: "1",
        time_attr_conversion_cost: "1",
        time_attr_on_web_cart: "1",
      };
    }
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
    if (this.scenario === "appeal") {
      entities.push({
        entityType: "ad",
        externalId: "ad-appeal-1",
        payload: {
          ad_id: "ad-appeal-1",
          creative_id: "creative-appeal-1",
          creative_status: "creative_offline_audit",
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
          ad_primary_status: this.priorityHighStatus,
          create_time: this.campaignCreatedAt,
          start_time: this.scheduledStartAt,
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
    await this.afterSync?.();
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
        quality: {
          status: this.qualityStatus,
          paginationComplete: this.qualityStatus === "healthy",
          requiredMetricsComplete: this.qualityStatus === "healthy",
          contractValid: this.qualityStatus !== "invalid",
          providerContractVersion: "test-v1",
          coverage: {
            startDate: dateKeyInTimeZoneForTest(new Date(now), "Asia/Shanghai"),
            endDate: dateKeyInTimeZoneForTest(new Date(now), "Asia/Shanghai"),
            timezone: "Asia/Shanghai",
          },
          missingMetrics: this.qualityStatus === "healthy" ? [] : ["cost_per_conversion"],
          partialFailures: this.qualityStatus === "healthy" ? [] : ["test-quality"],
          lastHealthyAt: now,
        },
      },
    };
  }

  async changeStatus(_context: unknown, mutations: StatusMutation[]) {
    if (this.statusDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.statusDelayMs));
    }
    this.mutations.push(...mutations);
    if (this.throwStatusError) throw new Error("connection lost after dispatch");
    for (const mutation of mutations) {
      if (mutation.entityType === "ad-group" && this.statusFailureKind === null && !this.shouldFail && !this.ignoreStatusWrites) {
        const status = mutation.action === "enable" ? "enable" : "disable";
        if (this.scenario === "priority" && mutation.externalId === "adgroup-high-priority") {
          this.priorityHighStatus = status;
        } else {
          this.adGroupStatus = status;
        }
      }
    }
    if (this.failReadbackAfterStatus) this.failNextSync = true;
    return mutations.map((mutation) => ({
      ...mutation,
      ok: !this.shouldFail && this.statusFailureKind === null,
      ...((this.shouldFail || this.statusFailureKind) && {
        failureKind: this.statusFailureKind ?? "retryable" as const,
      }),
      message: this.shouldFail || this.statusFailureKind ? "rejected" : "accepted",
    }));
  }

  resolveCapabilities() {
    return this.capabilities;
  }

  async appeal(_context: unknown, mutations: AppealMutation[]) {
    this.appeals.push(...mutations);
    return mutations.map((mutation) => {
      const ok = this.appealOutcomes.shift() ?? true;
      return { ...mutation, ok, message: ok ? "appealed" : "appeal rejected" };
    });
  }

  async deleteAdGroups(_context: unknown, mutations: DeleteAdGroupMutation[]) {
    this.deletions.push(...mutations);
    return mutations.map((mutation) => ({
      ...mutation,
      ok: this.deleteFailureKind === null,
      ...(this.deleteFailureKind && { failureKind: this.deleteFailureKind }),
      message: this.deleteFailureKind ? "delete failed" : "deleted",
    }));
  }
}

function alignSyncTo(
  output: Awaited<ReturnType<FakeProvider["syncReadOnly"]>>,
  asOf: Date,
): Awaited<ReturnType<FakeProvider["syncReadOnly"]>> {
  const timestamp = asOf.toISOString();
  const localDate = dateKeyInTimeZoneForTest(asOf, "Asia/Shanghai");
  output.result.startedAt = timestamp;
  output.result.finishedAt = timestamp;
  output.result.quality.coverage = {
    startDate: localDate,
    endDate: localDate,
    timezone: "Asia/Shanghai",
  };
  output.result.quality.lastHealthyAt = timestamp;
  return output;
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
    store.updateProviderAuthorization("demo-account", "cookie", {
      status: "active",
      capabilityVersion: provider.capabilityVersion,
      capabilities: [
        "read-campaigns",
        "read-ad-groups",
        "change-status",
        "appeal-ads",
        "copy-ads",
        "delete-ad-groups",
      ],
    });
    const account = store.getAccount("demo-account")!;
    store.updateAccountSettings("demo-account", {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: account.enabled,
      providerKind: account.providerKind,
    });
    store.setAccountExecutionMode("demo-account", "automatic", "test-setup");
    const initialSync = await provider.syncReadOnly();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      initialSync.entities,
      initialSync.result,
    );

  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  it("previews matching decisions without writing", async () => {
    const run = await service.runAccount("demo-account", "preview");

    expect(run.candidateCount).toBe(1);
    expect(provider.mutations).toHaveLength(0);
    expect(store.listAutomationDecisions("demo-account")[0]?.status).toBe(
      "preview",
    );
  });

  it("explains which account needs connection verification before a preview", async () => {
    store.updateProviderStatus("demo-account", "cookie", "failed", "expired");

    await expect(service.runAccount("demo-account", "preview")).resolves.toMatchObject({
      status: "failed",
      errorMessage:
        "账户「演示广告账户」当前Cookie 接入状态：Cookie 已失效或连接异常。请到「用户管理」查看接入状态后再运行。",
    });
  });

  it("downgrades automatic mode when connection health is not ready", async () => {
    vi.spyOn(provider, "checkHealth").mockResolvedValue({
      ok: false,
      status: "failed",
      message: "expired",
    });

    await service.checkAccountConnection("demo-account");

    expect(store.getAccount("demo-account")?.executionMode).toBe("automatic");
    expect(store.getProviderConnection("demo-account", "cookie")?.status).toBe("failed");
  });

  it("preserves the last verified connection state on a transient health-check timeout", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    vi.spyOn(provider, "checkHealth").mockRejectedValueOnce(timeout);

    await service.checkAccountConnection("demo-account");

    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({
      status: "ready",
      authorizationStatus: "active",
      lastMessage: expect.stringContaining("timeout"),
    });
  });

  it("still invalidates the connection on an explicit non-transient health failure", async () => {
    vi.spyOn(provider, "checkHealth").mockRejectedValueOnce(
      new Error("TikTok explicitly rejected the credential"),
    );

    await service.checkAccountConnection("demo-account");

    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({
      status: "failed",
      authorizationStatus: "failed",
    });
  });

  it("refreshes a stale provider capability contract after a successful background health check", async () => {
    const authorizationExpiresAt = new Date(Date.now() + 60_000).toISOString();
    store.updateProviderAuthorization("demo-account", "cookie", {
      status: "active",
      capabilityVersion: "fake-cookie-v0",
      capabilities: ["read-campaigns"],
      expiresAt: authorizationExpiresAt,
    });

    await service.checkAccountConnection("demo-account");

    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({
      status: "ready",
      authorizationStatus: "active",
      authorizationExpiresAt,
      capabilityVersion: provider.capabilityVersion,
      authorizedCapabilities: expect.arrayContaining([
        "read-campaigns",
        "read-ad-groups",
        "change-status",
      ]),
    });
    await expect(service.runAccount("demo-account", "preview")).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("downgrades automatic mode when provider data synchronization fails", async () => {
    provider.shouldSyncFail = true;

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run.status).toBe("failed");
    expect(store.getAccount("demo-account")?.executionMode).toBe("automatic");
    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({
      status: "failed",
      lastMessage: "Cookie 已失效或数据同步异常：sync unavailable",
    });
    expect(provider.mutations).toHaveLength(0);
  });

  it("blocks automatic writes for partial data but keeps suggestions visible", async () => {
    provider.qualityStatus = "partial";

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run.candidateCount).toBe(1);
    expect(provider.mutations).toHaveLength(0);
    expect(store.getAccount("demo-account")?.executionMode).toBe("automatic");
    expect(store.listAutomationDecisions("demo-account")[0]).toMatchObject({
      status: "preview",
      dataQualityStatus: "partial",
      dataQualityWarnings: expect.arrayContaining(["test-quality", "缺少指标 cost_per_conversion"]),
    });
  });

  it("stops rule evaluation when the provider contract is invalid", async () => {
    provider.qualityStatus = "invalid";

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run.candidateCount).toBe(0);
    expect(provider.mutations).toHaveLength(0);
    expect(store.getAccount("demo-account")?.executionMode).toBe("automatic");
  });

  it("rechecks stored quality at the write boundary after automatic mode is re-enabled", async () => {
    provider.qualityStatus = "partial";
    const partial = await provider.syncReadOnly();
    const partialAt = new Date(Date.now() + 1_000).toISOString();
    partial.result.startedAt = partialAt;
    partial.result.finishedAt = partialAt;
    store.saveReadOnlySync("demo-account", "cookie", partial.entities, partial.result);
    store.setAccountExecutionMode("demo-account", "automatic", "attempted bypass");

    await expect(service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    })).rejects.toThrow("状态写入已阻止");
    expect(provider.mutations).toHaveLength(0);
  });

  it("marks the status task unknown when status write readback fails", async () => {
    provider.shouldSyncFail = true;

    const result = await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(store.getAccount("demo-account")?.executionMode).toBe("automatic");
    expect(store.getProviderConnection("demo-account", "cookie")?.status).toBe("failed");
    expect(store.listAdOperations("demo-account")[0]).toMatchObject({
      status: "unknown",
      message: "sync unavailable",
    });
  });

  it("allows a manual status write while the account uses manual approval", async () => {
    const account = store.getAccount("demo-account")!;
    store.updateAccountSettings("demo-account", {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: true,
      providerKind: account.providerKind,
    });

    const result = await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });

    expect(result.ok).toBe(true);
    expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
    ]);
  });

  it("queues manual status requests without waiting for cookie I/O", async () => {
    provider.statusDelayMs = 30;

    const first = service.enqueueManualStatusChange("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });
    const second = service.enqueueManualStatusChange("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "enable",
    });

    expect(first.status).toBe("pending");
    expect(second.status).toBe("pending");
    await vi.waitFor(() => expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
      { entityType: "ad-group", externalId: "adgroup-1", action: "enable" },
    ]));
    expect(store.getAdOperation(first.id).status).toBe("succeeded");
    expect(store.getAdOperation(second.id).status).toBe("succeeded");
  });

  it("resumes a persisted pending manual status task after service restart", async () => {
    const task = store.createStatusWriteTask({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "adgroup-1",
      entityName: "测试广告组",
      action: "disable",
      source: "manual",
    }, { id: "user-1", name: "tester", kind: "user" });

    new AutomationService(store, vault, new ProviderRegistry([provider]));

    await vi.waitFor(() => expect(store.getAdOperation(task.id).status).toBe("succeeded"));
    expect(provider.mutations).toContainEqual({
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });
  });

  it("marks an accepted status write unknown until the readback reaches its target", async () => {
    provider.ignoreStatusWrites = true;

    const result = await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(store.listAdOperations("demo-account")[0]).toMatchObject({
      status: "unknown",
      message: expect.stringContaining("回读未确认目标状态"),
    });
  });

  it("persists actor, correlation and one successful attempt for a manual status write", async () => {
    const result = await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    }, { id: "user-1", name: "验收员", kind: "user" });

    expect(result.ok).toBe(true);
    const [task] = store.listAdOperations("demo-account");
    expect(task).toMatchObject({
      status: "succeeded",
      phase: "sync",
      attemptCount: 1,
      actor: { id: "user-1", name: "验收员", kind: "user" },
    });
    expect(task?.operationId).toBeTruthy();
    expect(task?.correlationId).toBeTruthy();
    expect(store.listAdOperationAttempts(task!.operationId)).toEqual([
      expect.objectContaining({
        status: "succeeded",
        attemptNumber: 1,
        phase: "sync",
        actor: { id: "user-1", name: "验收员", kind: "user" },
      }),
    ]);
  });

  it("keeps a dispatched status write with an uncertain result in unknown", async () => {
    provider.statusFailureKind = "unknown";

    const result = await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });

    expect(result).toMatchObject({ ok: false, failureKind: "unknown" });
    expect(store.listAdOperations("demo-account")[0]).toMatchObject({
      status: "unknown",
      attemptCount: 1,
    });
  });

  it("keeps an explicit provider rejection retryable as failed", async () => {
    provider.statusFailureKind = "retryable";

    const result = await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });

    expect(result).toMatchObject({ ok: false, failureKind: "retryable" });
    expect(store.listAdOperations("demo-account")[0]).toMatchObject({ status: "failed" });
  });

  it("blocks a status write before dispatch when credentials rotate while context loads", async () => {
    const originalRead = vault.read.bind(vault);
    vi.spyOn(vault, "read").mockImplementationOnce(async (reference) => {
      const staleSecret = await originalRead(reference);
      const replacement = await vault.create(JSON.stringify({
        kind: "cookie",
        cookie: "sessionid=rotated-cookie",
        csrfHeaderName: "x-csrftoken",
      }));
      store.setProviderCredentialReference("demo-account", "cookie", replacement);
      store.updateProviderStatus("demo-account", "cookie", "ready", "rotated and ready");
      store.updateProviderAuthorization("demo-account", "cookie", {
        status: "active",
        capabilityVersion: provider.capabilityVersion,
        capabilities: ["read-campaigns", "read-ad-groups", "change-status"],
      });
      return staleSecret;
    });

    await expect(service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    })).rejects.toThrow("凭据已变更");

    expect(provider.mutations).toHaveLength(0);
    expect(store.listAdOperations("demo-account")[0]).toMatchObject({
      status: "failed",
      attemptCount: 1,
    });
  });

  it("retries only an explicitly failed status task and preserves its operation identity", async () => {
    provider.statusFailureKind = "retryable";
    await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });
    const failed = store.listAdOperations("demo-account")[0]!;
    provider.statusFailureKind = null;

    const result = await service.retryStatusOperation(
      "demo-account",
      failed.operationId,
      { id: "user-2", name: "重试操作员", kind: "user" },
    );

    expect(result.ok).toBe(true);
    expect(store.getAdOperation(failed.id)).toMatchObject({
      operationId: failed.operationId,
      correlationId: failed.correlationId,
      status: "succeeded",
      attemptCount: 2,
    });
    expect(store.listAdOperationAttempts(failed.operationId)[1]?.actor).toEqual({
      id: "user-2",
      name: "重试操作员",
      kind: "user",
    });
  });

  it("never retries a status task whose provider result is unknown", async () => {
    provider.statusFailureKind = "unknown";
    await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });
    const unknown = store.listAdOperations("demo-account")[0]!;

    await expect(service.retryStatusOperation("demo-account", unknown.operationId))
      .rejects.toThrow("结果待确认");
    expect(provider.mutations).toHaveLength(1);
  });

  it("directly closes matched ad groups for automatic accounts", async () => {
    const run = await service.runAccount("demo-account", "manual");

    expect(run).toMatchObject({ executionMode: "automatic", actionCount: 1, successCount: 1, failureCount: 0 });
    expect(provider.mutations).toEqual([{ entityType: "ad-group", externalId: "adgroup-1", action: "disable" }]);
    expect(store.listAutomationDecisions("demo-account")[0]).toMatchObject({
      status: "succeeded",
      dataQualityStatus: "healthy",
      ruleVersion: expect.any(String),
      metricSnapshot: expect.objectContaining({ spend: expect.any(Number) }),
      suggestionKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("clears stale open decision reminders after an ad group is closed", async () => {
    await service.runAccount("demo-account", "preview");
    const stale = store.listAutomationDecisions("demo-account").find((item) => item.status === "preview")!;

    await service.runAccount("demo-account", "manual");

    expect(store.getAutomationDecision(stale.id)).toMatchObject({
      status: "skipped",
      errorMessage: "对象状态已更新，已清除过期决策提醒",
    });
    expect(store.listAutomationDecisions("demo-account").find((item) => item.id !== stale.id))
      .toMatchObject({ status: "succeeded" });
  });

  it("records a direct automation write failure", async () => {
    provider.shouldFail = true;

    const run = await service.runAccount("demo-account", "manual");

    expect(run.failureCount).toBe(1);
    expect(provider.mutations).toHaveLength(1);
    expect(store.getProviderConnection("demo-account", "cookie")).toMatchObject({
      status: "ready",
      lastMessage: "ready",
    });
    expect(store.getAccount("demo-account")?.executionMode).toBe("automatic");
  });

  it("downgrades an account after three consecutive provider write failures", async () => {
    provider.shouldFail = true;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.changeStatusManually("demo-account", {
        entityType: "ad-group",
        externalId: `adgroup-${attempt}`,
        action: "disable",
      });
    }

    expect(store.getAccount("demo-account")?.executionMode).toBe("automatic");
  });

  it("does not evaluate campaigns older than 48 hours", async () => {
    provider.campaignCreatedAt = new Date(Date.now() - 49 * 60 * 60 * 1_000).toISOString();

    const run = await service.runAccount("demo-account", "preview");

    expect(run.candidateCount).toBe(0);
    expect(provider.mutations).toHaveLength(0);
    expect(store.listCurrentManagedEntities("demo-account", "cookie").map((entity) => entity.externalId))
      .toEqual(expect.arrayContaining(["campaign-1", "adgroup-1"]));
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

  it("keeps preview read-only but stops writes while the software master switch is off", async () => {
    store.updateSystemRuntimeState({ enabled: false });
    await expect(service.runAccount("demo-account", "preview")).resolves.toMatchObject({
      candidateCount: 1,
    });
    await expect(service.runAccount("demo-account", "manual")).rejects.toThrow(
      "软件总开关已关闭",
    );
    const scheduler = new AutomationScheduler(store, service);
    await scheduler.tick();
    expect(provider.mutations).toHaveLength(0);
    expect(store.listPollCycles()).toHaveLength(0);
  });

  it("keeps automatic accounts in direct execution mode", async () => {
    store.setAccountExecutionMode("demo-account", "automatic", "test");

    const run = await service.runAccount("demo-account", "manual");

    expect(run.candidateCount).toBe(1);
    expect(run.successCount).toBe(1);
    expect(provider.mutations).toHaveLength(1);
    expect(store.listAutomationDecisions("demo-account")[0]?.status).toBe("succeeded");
  });

  it("does not turn a suggestion into a write when the master switch changes", async () => {
    provider.afterSync = () => {
      store.updateSystemRuntimeState({ enabled: false });
    };

    const run = await service.runAccount("demo-account", "manual");

    expect(run.failureCount).toBe(1);
    expect(provider.mutations).toHaveLength(0);
    expect(store.listAutomationDecisions("demo-account")[0]).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("软件总开关"),
    });
  });

  it("executes a due one-time ad-group schedule and records its source", async () => {
    await service.runAccount("demo-account", "preview");
    const schedule = store.createOneTimeSchedule("demo-account", {
      externalId: "adgroup-1",
      action: "disable",
      runAt: new Date(Date.now() - 1_000).toISOString(),
    });

    await service.runDueScheduledActions("demo-account");

    expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
    ]);
    expect(
      store.listScheduledActions("demo-account").find((item) => item.id === schedule.id),
    ).toMatchObject({ status: "completed", lastResult: "succeeded" });
    expect(store.listAdOperations("demo-account")[0]).toMatchObject({
      source: "scheduled",
      action: "disable",
    });
  });

  it("puts converting groups into overnight and closes non-converting groups at 23:45", async () => {
    provider.scenario = "priority";
    await service.runAccount("demo-account", "preview");
    // demo-account is in Asia/Shanghai, so 23:45 local is 15:45 UTC.
    const atNightWindow = "2026-07-20T15:45:00.000Z";

    expect(service.enrollNightlyAdGroups("demo-account", atNightWindow)).toEqual({
      overnight: 1,
      closing: 1,
    });
    await service.runDueScheduledActions("demo-account", atNightWindow);

    expect(provider.mutations).toEqual(expect.arrayContaining([
      { entityType: "ad-group", externalId: "adgroup-low-priority", action: "disable" },
      { entityType: "ad-group", externalId: "adgroup-high-priority", action: "disable" },
    ]));
    expect(store.listScheduledActions("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: "adgroup-high-priority", scheduleType: "overnight", action: "enable", status: "scheduled" }),
      expect.objectContaining({ externalId: "adgroup-low-priority", scheduleType: "once", action: "disable", status: "completed" }),
    ]));
    expect(service.enrollNightlyAdGroups("demo-account", atNightWindow)).toEqual({
      overnight: 0,
      closing: 0,
    });
  });

  it("submits only offline-audit creatives at 01:00 or 12:00 and never repeats them", async () => {
    provider.scenario = "appeal";
    const synced = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", synced.entities, synced.result);

    await service.runScheduledAppeals("demo-account", new Date("2026-07-20T17:00:00.000Z"));
    await service.runScheduledAppeals("demo-account", new Date("2026-07-20T17:00:30.000Z"));
    await service.runScheduledAppeals("demo-account", new Date("2026-07-21T04:00:00.000Z"));

    expect(provider.appeals).toEqual([{
      externalId: "ad-appeal-1",
      creativeId: "creative-appeal-1",
      reason: "我认为我的视频没有违规。",
    }]);
    expect(store.listAdOperations("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "appeal", source: "automation", status: "succeeded" }),
    ]));
  });

  it("copies qualifying current-day groups before noon once per source and uses the configured count", async () => {
    const autoCopyRunner = vi.fn(async (input: { onBeforeDispatch?: () => void }) => {
      input.onBeforeDispatch?.();
      return [{ ok: true, adGroupIds: ["generated-copy-1", "generated-copy-2"] }];
    });
    const copyService = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider]),
      autoCopyRunner,
    );
    const settings = store.getAutomationFeatureSettings();
    settings.copy.autoCopyEnabled = true;
    settings.copy.namingTemplate = "{source_name}";
    settings.copy.autoCopyBudget = 25;
    settings.copy.autoCopyBid = 4;
    store.updateAutomationFeatureSettings(settings);
    provider.adGroupConversions = 2;
    provider.adGroupCpa = 5;
    provider.adGroupCpc = 0.5;
    const qualifying = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", qualifying.entities, qualifying.result);

    const beforeNoon = futureShanghaiTime(10);
    vi.useFakeTimers();
    vi.setSystemTime(beforeNoon);
    const fresh = alignSyncTo(await provider.syncReadOnly(), beforeNoon);
    store.saveReadOnlySync("demo-account", "cookie", fresh.entities, fresh.result);
    await copyService.runScheduledAutoCopies("demo-account", beforeNoon);
    await copyService.runScheduledAutoCopies("demo-account", beforeNoon);

    expect(autoCopyRunner).toHaveBeenCalledTimes(1);
    expect(autoCopyRunner).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "demo-account",
      sourceCampaignId: "campaign-1",
      sourceAdGroupId: "adgroup-1",
      baseAdGroupName: "测试广告组",
      count: 2,
      dailyBudget: 25,
      bid: 4,
      launchImmediately: true,
      sameCampaign: true,
      onBeforeDispatch: expect.any(Function),
    }));
    expect(autoCopyRunner).toHaveBeenCalledTimes(1);

    autoCopyRunner.mockClear();
    const nextDay = new Date(beforeNoon.getTime() + 24 * 60 * 60_000);
    vi.setSystemTime(nextDay);
    const nextDaySync = alignSyncTo(await provider.syncReadOnly(), nextDay);
    nextDaySync.entities.push({
      entityType: "ad-group",
      externalId: "generated-copy-1",
      payload: {
        campaign_id: "campaign-1",
        ad_name: "用户已重命名",
        ad_primary_status: "enable",
        row_data: {
          campaign_id: "campaign-1",
          time_attr_convert_cnt: "2",
          time_attr_conversion_cost: "5",
          time_attr_on_web_cart: "2",
          cpc: "0.5",
        },
      },
    });
    store.saveReadOnlySync("demo-account", "cookie", nextDaySync.entities, nextDaySync.result);

    await copyService.runScheduledAutoCopies("demo-account", nextDay);

    expect(autoCopyRunner).toHaveBeenCalledTimes(1);
    expect(autoCopyRunner).toHaveBeenCalledWith(expect.objectContaining({
      sourceAdGroupId: "adgroup-1",
    }));
  });

  it("does not start new automatic copies at or after 12:00 account time", async () => {
    const autoCopyRunner = vi.fn(async () => [{ ok: true }]);
    const copyService = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider]),
      autoCopyRunner,
    );
    const settings = store.getAutomationFeatureSettings();
    settings.copy.autoCopyEnabled = true;
    store.updateAutomationFeatureSettings(settings);
    provider.adGroupConversions = 2;
    provider.adGroupCpa = 5;
    provider.adGroupCpc = 0.5;
    const atNoon = new Date();
    atNoon.setUTCHours(4, 0, 0, 0); // 12:00 in Asia/Shanghai.
    vi.useFakeTimers();
    vi.setSystemTime(atNoon);
    const fresh = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", fresh.entities, fresh.result);

    await copyService.runScheduledAutoCopies("demo-account", atNoon);

    expect(autoCopyRunner).not.toHaveBeenCalled();
  });

  it("requires conversions, CPA, and CPC to all satisfy the automatic-copy rule", async () => {
    const autoCopyRunner = vi.fn(async () => [{ ok: true }]);
    const copyService = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider]),
      autoCopyRunner,
    );
    const settings = store.getAutomationFeatureSettings();
    settings.copy.autoCopyEnabled = true;
    store.updateAutomationFeatureSettings(settings);
    provider.adGroupConversions = 2;
    provider.adGroupCpa = 10;
    provider.adGroupCpc = 0.5;
    const beforeNoon = new Date();
    beforeNoon.setUTCHours(2, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(beforeNoon);
    const fresh = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", fresh.entities, fresh.result);

    await copyService.runScheduledAutoCopies("demo-account", beforeNoon);

    expect(autoCopyRunner).not.toHaveBeenCalled();
  });

  it("rejects a healthy automatic-copy snapshot whose coverage is not exactly the account's current day", async () => {
    const autoCopyRunner = vi.fn(async () => [{ ok: true }]);
    const copyService = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider]),
      autoCopyRunner,
    );
    const settings = store.getAutomationFeatureSettings();
    settings.copy.autoCopyEnabled = true;
    store.updateAutomationFeatureSettings(settings);
    provider.adGroupConversions = 2;
    provider.adGroupCpa = 5;
    provider.adGroupCpc = 0.5;
    const beforeNoon = new Date("2026-07-24T02:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(beforeNoon);
    const sync = await provider.syncReadOnly();
    sync.result.quality.coverage = {
      startDate: "2026-07-23",
      endDate: "2026-07-24",
      timezone: "Asia/Shanghai",
    };
    store.saveReadOnlySync("demo-account", "cookie", sync.entities, sync.result);

    await copyService.runScheduledAutoCopies("demo-account", beforeNoon);

    expect(autoCopyRunner).not.toHaveBeenCalled();
  });

  it("does not enter deletion selection when healthy metrics cover an unknown or multi-day window", async () => {
    const settings = store.getAutomationFeatureSettings();
    settings.deletion.enabled = true;
    store.updateAutomationFeatureSettings(settings);
    const atSix = new Date("2026-07-24T22:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(atSix);
    const sync = await provider.syncReadOnly();
    sync.result.quality.coverage = {
      startDate: "2026-07-24",
      endDate: "2026-07-25",
      timezone: "Asia/Shanghai",
    };
    store.saveReadOnlySync("demo-account", "cookie", sync.entities, sync.result);
    const selection = vi.spyOn(store, "listDeletionReadyAdGroups");

    await service.runScheduledDeletions("demo-account", atSix);

    expect(selection).not.toHaveBeenCalled();
    expect(provider.deletions).toEqual([]);
  });

  it("does not submit an automatic appeal while the account is in observe mode", async () => {
    provider.scenario = "appeal";
    const synced = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", synced.entities, synced.result);
    store.setAccountExecutionMode("demo-account", "observe", "test");

    await service.runScheduledAppeals("demo-account", new Date("2026-07-20T17:00:00.000Z"));

    expect(provider.appeals).toEqual([]);
    expect(store.listAdOperations("demo-account").filter((item) => item.action === "appeal"))
      .toEqual([]);
  });

  it("uses the configured appeal hours and retries only the configured number of confirmed failures", async () => {
    provider.scenario = "appeal";
    provider.appealOutcomes.push(false, true);
    const synced = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", synced.entities, synced.result);
    const settings = store.getAutomationFeatureSettings();
    settings.appeal.scheduleHours = [8];
    settings.appeal.retryLimit = 1;
    store.updateAutomationFeatureSettings(settings);

    await service.runScheduledAppeals("demo-account", new Date("2026-07-21T00:00:00.000Z"));
    await service.runScheduledAppeals("demo-account", new Date("2026-07-21T00:01:00.000Z"));
    await service.runScheduledAppeals("demo-account", new Date("2026-07-22T00:00:00.000Z"));

    expect(provider.appeals).toHaveLength(2);
    expect(store.listAdOperations("demo-account").filter((item) => item.action === "appeal"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "failed" }),
        expect.objectContaining({ status: "succeeded" }),
      ]));
  });

  it("deletes only a software-confirmed disabled ad group after the protection period and never retries unknown", async () => {
    const asOf = futureShanghaiTime(6);
    vi.useFakeTimers();
    vi.setSystemTime(asOf);
    provider.adGroupStatus = "disable";
    const synced = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", synced.entities, synced.result);
    const disabled = store.recordAdOperation({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "adgroup-1",
      entityName: "测试广告组",
      action: "disable",
      source: "automation",
      status: "succeeded",
      message: "confirmed disabled",
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    (store as unknown as {
      db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
    }).db.prepare(
      "UPDATE ad_operations SET created_at = ?, updated_at = ?, completed_at = ? WHERE id = ?",
    ).run(twoHoursAgo, twoHoursAgo, twoHoursAgo, disabled.id);
    const settings = store.getAutomationFeatureSettings();
    settings.deletion.enabled = true;
    settings.deletion.gracePeriodHours = 1;
    store.updateAutomationFeatureSettings(settings);
    const fresh = alignSyncTo(await provider.syncReadOnly(), asOf);
    fresh.entities.push({
      entityType: "ad-group",
      externalId: "adgroup-retained",
      payload: {
        campaign_id: "campaign-1",
        ad_name: "系列保留组",
        ad_primary_status: "enable",
        row_data: {
          campaign_id: "campaign-1",
          time_attr_convert_cnt: "3",
          time_attr_conversion_cost: "3",
          time_attr_on_web_cart: "5",
          cpc: "0.3",
        },
      },
    });
    store.saveReadOnlySync("demo-account", "cookie", fresh.entities, fresh.result);
    provider.deleteFailureKind = "unknown";

    expect(store.listDeletionReadyAdGroups(
      "demo-account",
      "cookie",
      new Date(asOf.getTime() - 60 * 60 * 1000).toISOString(),
    )).toEqual([expect.objectContaining({ externalId: "adgroup-1" })]);

    await service.runScheduledDeletions("demo-account", asOf);
    await service.runScheduledDeletions("demo-account", asOf);

    expect(provider.deletions).toEqual([{ externalId: "adgroup-1" }]);
    expect(store.listAdOperations("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "delete", status: "unknown" }),
    ]));
  });

  it("keeps one group per campaign and applies cart plus positive-conversion CPA checks at 06:00 only", async () => {
    const autoCopyRunner = vi.fn(async () => [{ ok: true }]);
    const guardedService = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider]),
      autoCopyRunner,
    );
    const settings = store.getAutomationFeatureSettings();
    settings.deletion.enabled = true;
    settings.deletion.gracePeriodHours = 1;
    settings.deletion.maxConversions = 1;
    settings.deletion.maxCarts = 4;
    settings.deletion.minCpa = 9;
    store.updateAutomationFeatureSettings(settings);
    const asOf = futureShanghaiTime(6);
    vi.useFakeTimers();
    vi.setSystemTime(asOf);

    const groups = [
      { id: "delete-carts-4", name: "低质量组", conversions: 0, carts: 4, cpa: null },
      { id: "delete-cpa-10", name: "高 CPA 组", conversions: 1, carts: 2, cpa: 10 },
      { id: "keep-converting", name: "保留组", conversions: 2, carts: 5, cpa: 3 },
    ];
    const finishedAt = asOf.toISOString();
    store.saveReadOnlySync("demo-account", "cookie", [
      { entityType: "campaign", externalId: "campaign-1", payload: { campaign_id: "campaign-1", campaign_name: "系列" } },
      ...groups.map((group) => ({
        entityType: "ad-group" as const,
        externalId: group.id,
        payload: {
          campaign_id: "campaign-1",
          ad_name: group.name,
          ad_primary_status: "disable",
          row_data: {
            campaign_id: "campaign-1",
            time_attr_convert_cnt: String(group.conversions),
            time_attr_on_web_cart: String(group.carts),
            ...(group.cpa === null ? {} : { time_attr_conversion_cost: String(group.cpa) }),
          },
        },
      })),
    ], {
      startedAt: finishedAt,
      finishedAt,
      counts: { campaign: 1, "ad-group": 3, ad: 0 },
      warnings: [],
      quality: {
        status: "healthy",
        paginationComplete: true,
        requiredMetricsComplete: true,
        contractValid: true,
        providerContractVersion: "test-v1",
        coverage: {
          startDate: dateKeyInTimeZoneForTest(asOf, "Asia/Shanghai"),
          endDate: dateKeyInTimeZoneForTest(asOf, "Asia/Shanghai"),
          timezone: "Asia/Shanghai",
        },
        missingMetrics: [],
        partialFailures: [],
        lastHealthyAt: finishedAt,
      },
    });
    const disabledAt = new Date(asOf.getTime() - 2 * 60 * 60_000).toISOString();
    for (const group of groups) {
      const operation = store.recordAdOperation({
        accountId: "demo-account",
        providerKind: "cookie",
        entityType: "ad-group",
        externalId: group.id,
        entityName: group.name,
        action: "disable",
        source: "automation",
        status: "succeeded",
        message: "disabled",
      });
      (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        .prepare("UPDATE ad_operations SET completed_at = ? WHERE id = ?")
        .run(disabledAt, operation.id);
    }

    await guardedService.runScheduledDeletions("demo-account", new Date(asOf.getTime() - 60 * 60_000));
    await guardedService.runScheduledDeletions("demo-account", new Date(asOf.getTime() + 5 * 60_000));
    expect(provider.deletions).toEqual([]);
    await guardedService.runScheduledDeletions("demo-account", asOf);
    await guardedService.runScheduledDeletions("demo-account", asOf);

    expect(provider.deletions).toEqual([
      { externalId: "delete-carts-4" },
      { externalId: "delete-cpa-10" },
    ]);
  });

  it("does not delete from a stale snapshot or an outdated capability authorization", async () => {
    provider.adGroupStatus = "disable";
    const synced = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", synced.entities, synced.result);
    const disabled = store.recordAdOperation({
      accountId: "demo-account",
      providerKind: "cookie",
      entityType: "ad-group",
      externalId: "adgroup-1",
      entityName: "测试广告组",
      action: "disable",
      source: "automation",
      status: "succeeded",
      message: "confirmed disabled",
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const database = (store as unknown as {
      db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
    }).db;
    database.prepare(
      "UPDATE ad_operations SET created_at = ?, updated_at = ?, completed_at = ? WHERE id = ?",
    ).run(twoHoursAgo, twoHoursAgo, twoHoursAgo, disabled.id);
    const settings = store.getAutomationFeatureSettings();
    settings.deletion.enabled = true;
    settings.deletion.gracePeriodHours = 1;
    store.updateAutomationFeatureSettings(settings);

    await service.runScheduledDeletions(
      "demo-account",
      new Date(Date.now() + 10 * 60 * 1000),
    );
    expect(provider.deletions).toEqual([]);

    store.updateProviderAuthorization("demo-account", "cookie", {
      status: "active",
      capabilityVersion: "outdated",
      capabilities: ["delete-ad-groups"],
    });
    await service.runScheduledDeletions("demo-account", new Date());
    expect(provider.deletions).toEqual([]);
  });

  it("does not close an enabled ad group scheduled to start the next day", async () => {
    provider.scheduledStartAt = "2026-07-21T00:00:00.000Z";
    const refreshed = await provider.syncReadOnly();
    store.saveReadOnlySync("demo-account", "cookie", refreshed.entities, refreshed.result);

    expect(service.enrollNightlyAdGroups("demo-account", "2026-07-20T15:45:00.000Z")).toEqual({
      overnight: 0,
      closing: 0,
    });
    expect(store.listScheduledActions("demo-account")).toEqual([]);
  });

  it("executes a user-created schedule while the account is in automatic mode", async () => {
    const account = store.getAccount("demo-account")!;
    store.updateAccountSettings("demo-account", {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: true,
      providerKind: account.providerKind,
    });
    const schedule = store.createOneTimeSchedule("demo-account", {
      externalId: "adgroup-1",
      action: "disable",
      runAt: new Date(Date.now() - 1_000).toISOString(),
    });

    await service.runDueScheduledActions("demo-account");

    expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
    ]);
    expect(store.listScheduledActions("demo-account").find((item) => item.id === schedule.id))
      .toMatchObject({ status: "completed", lastResult: "succeeded" });
  });

  it("does not reschedule a repeating action after an unknown live write result", async () => {
    await service.runAccount("demo-account", "preview");
    const [schedule] = store.createOvernightSchedule("demo-account", {
      externalId: "adgroup-1",
      disableAt: new Date(Date.now() - 1_000).toISOString(),
      enableAt: new Date(Date.now() + 60_000).toISOString(),
    });
    provider.statusFailureKind = "unknown";

    await service.runDueScheduledActions("demo-account");

    expect(store.listScheduledActions("demo-account").find((item) => item.id === schedule!.id))
      .toMatchObject({
        status: "failed",
        lastResult: "failed",
        lastMessage: expect.stringContaining("unknown"),
      });
    expect(store.listDueScheduledActions("demo-account")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: schedule!.id })]),
    );
  });

  it("lets only one service instance dispatch the same due schedule", async () => {
    await service.runAccount("demo-account", "preview");
    const schedule = store.createOneTimeSchedule("demo-account", {
      externalId: "adgroup-1",
      action: "disable",
      runAt: new Date(Date.now() - 1_000).toISOString(),
    });
    provider.statusDelayMs = 30;
    const secondService = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider]),
    );

    await Promise.all([
      service.runDueScheduledActions("demo-account"),
      secondService.runDueScheduledActions("demo-account"),
    ]);

    expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "disable" },
    ]);
    expect(store.listAdOperations("demo-account").filter((item) => item.source === "scheduled"))
      .toHaveLength(1);
    expect(store.listScheduledActions("demo-account").find((item) => item.id === schedule.id))
      .toMatchObject({ status: "completed", lastResult: "succeeded" });
  });

  it("does not run a due schedule while the same account is syncing", async () => {
    await service.runAccount("demo-account", "preview");
    const schedule = store.createOneTimeSchedule("demo-account", {
      externalId: "adgroup-1",
      action: "disable",
      runAt: new Date(Date.now() - 1_000).toISOString(),
    });
    let releaseSync!: () => void;
    let syncStarted!: () => void;
    const started = new Promise<void>((resolve) => { syncStarted = resolve; });
    provider.afterSync = () => new Promise<void>((resolve) => {
      releaseSync = resolve;
      syncStarted();
    });

    const running = service.runAccount("demo-account", "preview");
    await started;
    await service.runDueScheduledActions("demo-account");

    expect(store.listScheduledActions("demo-account").find((item) => item.id === schedule.id)?.status).toBe("scheduled");
    expect(provider.mutations).toHaveLength(0);
    releaseSync();
    await running;
  });

  it("keeps higher-priority direct closures before applying the per-run limit", async () => {
    provider.scenario = "priority";
    store.updateGlobalAutomationSettings({
      pollingIntervalMinutes: 5,
      maxActionsPerRun: 1,
    });

    await service.runAccount("demo-account", "manual");

    expect(provider.mutations).toEqual([{ entityType: "ad-group", externalId: "adgroup-high-priority", action: "disable" }]);
    expect(store.listAutomationDecisions("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: "adgroup-high-priority", status: "succeeded" }),
      expect.objectContaining({ externalId: "adgroup-low-priority", status: "skipped" }),
    ]));
  });

  it("filters parent-child conflicts before applying the per-run limit", async () => {
    provider.scenario = "parent-child";
    store.updateGlobalAutomationSettings({
      pollingIntervalMinutes: 5,
      maxActionsPerRun: 1,
    });

    await service.runAccount("demo-account", "preview");

    expect(store.listAutomationDecisions("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        externalId: "ad-1",
        action: "enable",
        status: "skipped",
        errorMessage: "父广告组建议关闭，本轮不建议开启子广告。",
      }),
      expect.objectContaining({
        externalId: "adgroup-1",
        action: "disable",
        status: "preview",
      }),
    ]));
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

  it("reports a verified automatic recovery enable in the scheduler summary", async () => {
    provider.scenario = "recovery";
    provider.adGroupStatus = "disable";
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 6 * 60_000));

    await scheduler.tick();

    vi.useRealTimers();
    expect(provider.mutations).toEqual([
      { entityType: "ad-group", externalId: "adgroup-1", action: "enable" },
    ]);
    expect(store.listAutomationDecisions("demo-account")[0]).toMatchObject({
      externalId: "adgroup-1",
      action: "enable",
      status: "succeeded",
    });
    expect(store.listPollCycles()[0]?.accounts[0]).toMatchObject({
      status: "changed",
      enabledCount: 1,
      disabledCount: 0,
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
    expect(provider.mutations).toEqual([{ entityType: "ad-group", externalId: "adgroup-1", action: "disable" }]);
    expect(
      store
        .listAutomationDecisions("demo-account")
        .find((decision) => decision.externalId === "ad-1"),
    ).toMatchObject({
      status: "skipped",
      errorMessage: "父广告组建议关闭，本轮不建议开启子广告。",
    });
  });

  it("skips a child enable suggestion when its parent campaign is suggested to close", async () => {
    provider.scenario = "campaign-parent-child";
    const configuration = store.getRuleConfiguration();
    store.updateRuleConfiguration({
      layers: { ...configuration.layers, campaign: true },
      rules: configuration.rules,
    });

    const run = await service.runAccount("demo-account", "preview");

    expect(run.candidateCount).toBe(2);
    expect(provider.mutations).toEqual([]);
    expect(store.listAutomationDecisions("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "campaign", externalId: "campaign-1", action: "disable", status: "preview" }),
      expect.objectContaining({ entityType: "ad-group", externalId: "adgroup-1", action: "enable", status: "skipped", errorMessage: "父推广系列建议关闭，本轮不建议开启子对象。" }),
    ]));
  });

  it("skips a child enable suggestion when its existing parent campaign is disabled", async () => {
    provider.scenario = "disabled-parent";

    await service.runAccount("demo-account", "preview");

    expect(provider.mutations).toEqual([]);
    expect(store.listAutomationDecisions("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: "ad-group",
        externalId: "adgroup-1",
        action: "enable",
        status: "skipped",
        errorMessage: "父推广系列处于关闭状态，不建议开启子对象。",
      }),
    ]));
  });

  it("produces the same semantic suggestion key for identical inputs", async () => {
    await service.runAccount("demo-account", "preview");
    const first = store.listAutomationDecisions("demo-account")[0]!;

    await service.runAccount("demo-account", "preview");
    const second = store.listAutomationDecisions("demo-account")[0]!;

    expect(second.suggestionKey).toBe(first.suggestionKey);
    expect(second.ruleVersion).toBe(first.ruleVersion);
    expect(second.rulePredicate).toEqual(first.rulePredicate);
    expect(first.rulePredicate).toMatchObject({
      code: first.thresholdCode,
      enabled: true,
      lookbackHours: 48,
      values: expect.any(Object),
    });
    expect(second.metricSnapshot).toEqual(first.metricSnapshot);
    expect(provider.mutations).toEqual([]);
  });

  it("keeps the suggestion key stable when the same rule configuration is resaved", async () => {
    await service.runAccount("demo-account", "preview");
    const first = store.listAutomationDecisions("demo-account")[0]!;
    const configuration = store.getRuleConfiguration();
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.updateRuleConfiguration({
      layers: configuration.layers,
      rules: configuration.rules,
    });

    await service.runAccount("demo-account", "preview");
    const second = store.listAutomationDecisions("demo-account")[0]!;

    expect(second.suggestionKey).toBe(first.suggestionKey);
  });

  it("changes the suggestion key when the matched rule predicate changes", async () => {
    await service.runAccount("demo-account", "preview");
    const first = store.listAutomationDecisions("demo-account")[0]!;
    expect(first.thresholdCode).toBe("NO_CONV_SPEND_CLOSE");
    const configuration = store.getRuleConfiguration();
    store.updateRuleConfiguration({
      layers: configuration.layers,
      rules: configuration.rules.map((rule) =>
        rule.code === first.thresholdCode
          ? { ...rule, values: { ...rule.values, spend: 3 } }
          : rule,
      ),
    });

    await service.runAccount("demo-account", "preview");
    const second = store.listAutomationDecisions("demo-account")[0]!;

    expect(second.suggestionKey).not.toBe(first.suggestionKey);
  });
});
