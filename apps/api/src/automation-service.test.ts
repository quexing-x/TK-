import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProviderEntity } from "@tk-auto/core";
import type { SyncDataQualityStatus } from "@tk-auto/core";
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
  readonly capabilityVersion = "fake-cookie-v1";
  readonly capabilities = new Set(["read-campaigns", "read-ad-groups", "change-status"] as const);
  readonly mutations: StatusMutation[] = [];
  shouldFail = false;
  statusFailureKind: "retryable" | "unknown" | null = null;
  throwStatusError = false;
  statusDelayMs = 0;
  adGroupStatus = "enable";
  shouldSyncFail = false;
  failReadbackAfterStatus = false;
  failNextSync = false;
  afterSync: (() => void | Promise<void>) | null = null;
  campaignCreatedAt = new Date().toISOString();
  scenario: "default" | "parent-child" | "campaign-parent-child" | "disabled-parent" | "priority" | "recovery" = "default";
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
          coverage: { startDate: now.slice(0, 10), endDate: now.slice(0, 10), timezone: "UTC" },
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
      if (mutation.entityType === "ad-group" && this.statusFailureKind === null && !this.shouldFail) {
        this.adGroupStatus = mutation.action === "enable" ? "enable" : "disable";
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
      capabilities: ["read-campaigns", "read-ad-groups", "change-status"],
    });
    const account = store.getAccount("demo-account")!;
    store.updateAccountSettings("demo-account", {
      displayName: account.displayName,
      accountType: account.accountType,
      enabled: account.enabled,
      providerKind: account.providerKind,
      executionMode: "automatic",
    });
    const initialSync = await provider.syncReadOnly();
    store.saveReadOnlySync(
      "demo-account",
      "cookie",
      initialSync.entities,
      initialSync.result,
    );

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

    expect(store.getAccount("demo-account")?.executionMode).toBe("manual-approval");
    expect(store.getProviderConnection("demo-account", "cookie")?.status).toBe("failed");
  });

  it("downgrades automatic mode when provider data synchronization fails", async () => {
    provider.shouldSyncFail = true;

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run.status).toBe("failed");
    expect(store.getAccount("demo-account")?.executionMode).toBe("manual-approval");
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
    expect(store.getAccount("demo-account")?.executionMode).toBe("manual-approval");
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
    expect(store.getAccount("demo-account")?.executionMode).toBe("manual-approval");
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
    })).rejects.toThrow("自动写入已阻止");
    expect(provider.mutations).toHaveLength(0);
  });

  it("downgrades automatic mode when status write readback fails", async () => {
    provider.shouldSyncFail = true;

    const result = await service.changeStatusManually("demo-account", {
      entityType: "ad-group",
      externalId: "adgroup-1",
      action: "disable",
    });

    expect(result.ok).toBe(true);
    expect(store.getAccount("demo-account")?.executionMode).toBe("manual-approval");
    expect(store.getProviderConnection("demo-account", "cookie")?.status).toBe("failed");
    expect(store.listAdOperations("demo-account")[0]).toMatchObject({
      status: "succeeded",
      phase: "sync",
      syncWarning: "sync unavailable",
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

  it("keeps rule matches as suggestions even for automatic accounts", async () => {
    const run = await service.runAccount("demo-account", "manual");

    expect(run).toMatchObject({ executionMode: "observe", actionCount: 0, successCount: 0, failureCount: 0 });
    expect(provider.mutations).toEqual([]);
    expect(store.listAutomationDecisions("demo-account")[0]).toMatchObject({
      status: "preview",
      dataQualityStatus: "healthy",
      ruleVersion: expect.any(String),
      metricSnapshot: expect.objectContaining({ spend: expect.any(Number) }),
      suggestionKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("executes one approved suggestion once and persists the fixed approval snapshot", async () => {
    await service.runAccount("demo-account", "preview");
    const decision = store.listAutomationDecisions("demo-account").find((item) => item.status === "preview")!;
    store.setAccountExecutionMode("demo-account", "manual-approval", "approval test");
    provider.statusDelayMs = 20;
    const actor = { id: "approver-1", name: "审批员", kind: "user" as const };

    const [first, second] = await Promise.all([
      service.approveAutomationDecision("demo-account", decision.id, actor),
      service.approveAutomationDecision("demo-account", decision.id, actor),
    ]);

    expect(provider.mutations).toEqual([{
      entityType: decision.entityType,
      externalId: decision.externalId,
      action: decision.action,
    }]);
    expect([first.status, second.status]).toEqual(expect.arrayContaining(["succeeded"]));
    expect(store.listAutomationApprovals("demo-account")).toEqual([
      expect.objectContaining({
        decisionId: decision.id,
        accountId: "demo-account",
        suggestionKey: decision.suggestionKey,
        entityType: decision.entityType,
        externalId: decision.externalId,
        action: decision.action,
        expectedStatus: "enabled",
        beforeStatus: "enabled",
        afterStatus: "disabled",
        status: "succeeded",
        actor,
        statusOperationId: expect.any(String),
        providerMessage: "accepted",
      }),
    ]);
    expect(store.getAutomationDecision(decision.id)?.status).toBe("succeeded");
  });

  it("blocks an approved suggestion when the object status changed after preview", async () => {
    await service.runAccount("demo-account", "preview");
    const decision = store.listAutomationDecisions("demo-account").find((item) => item.status === "preview")!;
    provider.adGroupStatus = "disable";

    const approval = await service.approveAutomationDecision(
      "demo-account",
      decision.id,
      { id: "approver-1", name: "审批员", kind: "user" },
    );

    expect(approval).toMatchObject({
      status: "failed",
      beforeStatus: "disabled",
      statusOperationId: null,
      errorMessage: expect.stringContaining("旧建议已阻止执行"),
    });
    expect(provider.mutations).toHaveLength(0);
  });

  it("keeps scheduler rule matches read-only until low-risk automation is explicitly enabled", async () => {
    const run = await service.runAccount("demo-account", "scheduler");

    expect(run).toMatchObject({ executionMode: "observe", actionCount: 0 });
    expect(provider.mutations).toHaveLength(0);
    expect(store.getLowRiskAutomationPolicy("demo-account").enabled).toBe(false);
  });

  it("automatically executes only one verified disable per entity after account opt-in", async () => {
    store.updateLowRiskAutomationPolicy("demo-account", {
      enabled: true,
      dailyActionLimit: 5,
    });

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run).toMatchObject({
      executionMode: "automatic",
      actionCount: 1,
      successCount: 1,
      failureCount: 0,
    });
    expect(provider.mutations).toEqual([
      expect.objectContaining({
        entityType: "ad-group",
        externalId: "adgroup-1",
        action: "disable",
      }),
    ]);
    expect(store.listAutomationDecisions("demo-account")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "disable", status: "succeeded" }),
      ]),
    );
  });

  it("never automatically executes enable suggestions in the low-risk policy", async () => {
    provider.scenario = "recovery";
    store.updateLowRiskAutomationPolicy("demo-account", {
      enabled: true,
      dailyActionLimit: 5,
    });

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run.actionCount).toBe(0);
    expect(provider.mutations).toHaveLength(0);
    expect(store.listAutomationDecisions("demo-account")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "enable", status: "skipped" }),
      ]),
    );
  });

  it("does not cap automatic disable actions per day", async () => {
    provider.scenario = "priority";
    store.updateLowRiskAutomationPolicy("demo-account", {
      enabled: true,
      dailyActionLimit: 1,
    });

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run.actionCount).toBe(2);
    expect(provider.mutations).toHaveLength(2);
  });

  it("lets only one service instance claim an identical automatic disable", async () => {
    store.updateLowRiskAutomationPolicy("demo-account", {
      enabled: true,
      dailyActionLimit: 5,
    });
    const second = new AutomationService(
      store,
      vault,
      new ProviderRegistry([provider]),
    );

    const [firstRun, secondRun] = await Promise.all([
      service.runAccount("demo-account", "scheduler"),
      second.runAccount("demo-account", "scheduler"),
    ]);

    expect(firstRun.actionCount + secondRun.actionCount).toBe(1);
    expect(provider.mutations).toHaveLength(1);
  });

  it("does not reserve or dispatch automatic work while the write circuit is open", async () => {
    store.updateLowRiskAutomationPolicy("demo-account", {
      enabled: true,
      dailyActionLimit: 5,
    });
    store.recordProviderWriteFailure("demo-account", "cookie", "failure-1");
    store.recordProviderWriteFailure("demo-account", "cookie", "failure-2");
    store.recordProviderWriteFailure("demo-account", "cookie", "failure-3");

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run).toMatchObject({ executionMode: "observe", actionCount: 0 });
    expect(provider.mutations).toHaveLength(0);
    expect(service.getLowRiskAutomationState("demo-account").todayUsage).toBe(0);
  });

  it("rechecks the account rollout policy at the final Provider boundary", async () => {
    store.updateLowRiskAutomationPolicy("demo-account", {
      enabled: true,
      dailyActionLimit: 5,
    });
    provider.afterSync = () => {
      provider.afterSync = null;
      store.updateLowRiskAutomationPolicy("demo-account", {
        enabled: false,
        dailyActionLimit: 5,
      });
    };

    const run = await service.runAccount("demo-account", "scheduler");

    expect(run).toMatchObject({ actionCount: 1, successCount: 0, failureCount: 1 });
    expect(provider.mutations).toHaveLength(0);
    expect(store.listAutomationDecisions("demo-account")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          errorMessage: expect.stringContaining("请求发送前"),
        }),
      ]),
    );
  });

  it("blocks approval before dispatch when fresh data quality is not healthy", async () => {
    await service.runAccount("demo-account", "preview");
    const decision = store.listAutomationDecisions("demo-account").find((item) => item.status === "preview")!;
    provider.qualityStatus = "partial";

    const approval = await service.approveAutomationDecision(
      "demo-account",
      decision.id,
      { id: "approver-1", name: "审批员", kind: "user" },
    );

    expect(approval).toMatchObject({
      status: "failed",
      statusOperationId: null,
      errorMessage: expect.stringContaining("数据质量"),
    });
    expect(provider.mutations).toHaveLength(0);
  });

  it("marks the connection failed when approval preflight synchronization throws", async () => {
    await service.runAccount("demo-account", "preview");
    const decision = store.listAutomationDecisions("demo-account").find((item) => item.status === "preview")!;
    provider.shouldSyncFail = true;

    const approval = await service.approveAutomationDecision(
      "demo-account",
      decision.id,
      { id: "approver-1", name: "审批员", kind: "user" },
    );

    expect(approval.status).toBe("failed");
    expect(store.getProviderConnection("demo-account", "cookie")?.status).toBe("failed");
    expect(store.getAccount("demo-account")?.executionMode).toBe("manual-approval");
    expect(provider.mutations).toHaveLength(0);
  });

  it("blocks approval preflight reads after account authorization is revoked", async () => {
    await service.runAccount("demo-account", "preview");
    const decision = store.listAutomationDecisions("demo-account").find((item) => item.status === "preview")!;
    const syncCount = provider.syncCount;
    store.updateProviderAuthorization("demo-account", "cookie", {
      status: "revoked",
      capabilityVersion: provider.capabilityVersion,
      capabilities: [],
    });

    const approval = await service.approveAutomationDecision(
      "demo-account",
      decision.id,
      { id: "approver-1", name: "审批员", kind: "user" },
    );

    expect(approval).toMatchObject({ status: "failed", statusOperationId: null });
    expect(provider.syncCount).toBe(syncCount);
    expect(provider.mutations).toHaveLength(0);
  });

  it("rechecks authorization after loading the approval preflight credential", async () => {
    await service.runAccount("demo-account", "preview");
    const decision = store.listAutomationDecisions("demo-account").find((item) => item.status === "preview")!;
    const syncCount = provider.syncCount;
    const readCredential = vault.read.bind(vault);
    vi.spyOn(vault, "read").mockImplementationOnce(async (reference) => {
      const secret = await readCredential(reference);
      store.updateProviderAuthorization("demo-account", "cookie", {
        status: "revoked",
        capabilityVersion: provider.capabilityVersion,
        capabilities: [],
      });
      return secret;
    });

    const approval = await service.approveAutomationDecision(
      "demo-account",
      decision.id,
      { id: "approver-1", name: "审批员", kind: "user" },
    );

    expect(approval).toMatchObject({ status: "failed", statusOperationId: null });
    expect(provider.syncCount).toBe(syncCount);
    expect(provider.mutations).toHaveLength(0);
  });

  it("does not create an approval for a suggestion that is no longer previewable", async () => {
    await service.runAccount("demo-account", "preview");
    const decision = store.listAutomationDecisions("demo-account").find((item) => item.status === "preview")!;
    store.updateAutomationDecision(decision.id, "skipped", "superseded");

    await expect(service.approveAutomationDecision(
      "demo-account",
      decision.id,
      { id: "approver-1", name: "审批员", kind: "user" },
    )).rejects.toThrow("预览命中状态");
    expect(provider.mutations).toHaveLength(0);
    expect(store.listAutomationApprovals("demo-account")).toHaveLength(0);
  });

  it("blocks an approved suggestion while the software master switch is off", async () => {
    await service.runAccount("demo-account", "preview");
    const decision = store.listAutomationDecisions("demo-account").find((item) => item.status === "preview")!;
    store.updateSystemRuntimeState({ enabled: false });

    const approval = await service.approveAutomationDecision(
      "demo-account",
      decision.id,
      { id: "approver-1", name: "审批员", kind: "user" },
    );

    expect(approval).toMatchObject({
      status: "failed",
      statusOperationId: null,
      errorMessage: expect.stringContaining("总开关"),
    });
    expect(provider.mutations).toHaveLength(0);
  });

  it("keeps an approved provider write with an uncertain result in unknown", async () => {
    await service.runAccount("demo-account", "preview");
    const decision = store.listAutomationDecisions("demo-account").find((item) => item.status === "preview")!;
    provider.statusFailureKind = "unknown";

    const approval = await service.approveAutomationDecision(
      "demo-account",
      decision.id,
      { id: "approver-1", name: "审批员", kind: "user" },
    );
    const replay = await service.approveAutomationDecision(
      "demo-account",
      decision.id,
      { id: "approver-1", name: "审批员", kind: "user" },
    );

    expect(approval).toMatchObject({ status: "unknown", afterStatus: null });
    expect(replay.id).toBe(approval.id);
    expect(provider.mutations).toHaveLength(1);
  });

  it("does not reuse the preflight snapshot as afterStatus when Provider throws after dispatch", async () => {
    await service.runAccount("demo-account", "preview");
    const decision = store.listAutomationDecisions("demo-account").find((item) => item.status === "preview")!;
    provider.throwStatusError = true;

    const approval = await service.approveAutomationDecision(
      "demo-account",
      decision.id,
      { id: "approver-1", name: "审批员", kind: "user" },
    );

    expect(approval).toMatchObject({
      status: "unknown",
      beforeStatus: "enabled",
      afterStatus: null,
      errorMessage: expect.stringContaining("禁止重复批准"),
    });
    expect(store.getAutomationDecision(decision.id)?.status).toBe("unknown");
    expect(provider.mutations).toHaveLength(1);
  });

  it("atomically freezes the decision when an interrupted approval is recovered as unknown", async () => {
    await service.runAccount("demo-account", "preview");
    const decision = store.listAutomationDecisions("demo-account").find((item) => item.status === "preview")!;
    const approval = store.getOrCreateAutomationApproval(
      decision.id,
      { id: "approver-1", name: "审批员", kind: "user" },
    );
    store.claimAutomationApproval(approval.id, "stale-executor");

    expect(store.recoverInterruptedAutomationApprovals(new Date().toISOString())).toBe(1);
    expect(store.getAutomationApprovalByDecision(decision.id)).toMatchObject({
      status: "unknown",
      afterStatus: null,
    });
    expect(store.getAutomationDecision(decision.id)).toMatchObject({
      status: "unknown",
      errorMessage: expect.stringContaining("禁止重复批准"),
    });
  });

  it("marks an approved write unknown when Provider accepts but write-back cannot be confirmed", async () => {
    await service.runAccount("demo-account", "preview");
    const decision = store.listAutomationDecisions("demo-account").find((item) => item.status === "preview")!;
    provider.failReadbackAfterStatus = true;

    const approval = await service.approveAutomationDecision(
      "demo-account",
      decision.id,
      { id: "approver-1", name: "审批员", kind: "user" },
    );

    expect(approval).toMatchObject({
      status: "unknown",
      errorMessage: expect.stringContaining("禁止重复批准"),
    });
    expect(store.getAutomationDecision(decision.id)?.status).toBe("unknown");
    expect(provider.mutations).toHaveLength(1);

    provider.failReadbackAfterStatus = false;
    provider.adGroupStatus = "enable";
    store.updateProviderStatus("demo-account", "cookie", "ready", "restored for suggestion check");
    await service.runAccount("demo-account", "preview");
    expect(store.listAutomationDecisions("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "skipped",
        errorMessage: expect.stringContaining("结果待确认"),
      }),
    ]));
  });

  it("does not turn a confirmed approved write unknown when failure-counter cleanup fails", async () => {
    await service.runAccount("demo-account", "preview");
    const decision = store.listAutomationDecisions("demo-account").find((item) => item.status === "preview")!;
    vi.spyOn(store, "resetProviderWriteFailures").mockImplementationOnce(() => {
      throw new Error("cleanup unavailable");
    });

    const approval = await service.approveAutomationDecision(
      "demo-account",
      decision.id,
      { id: "approver-1", name: "审批员", kind: "user" },
    );

    expect(approval.status).toBe("succeeded");
    expect(store.getAutomationDecision(decision.id)?.status).toBe("succeeded");
  });

  it("never calls the rule Provider write path even when it would fail", async () => {
    provider.shouldFail = true;

    const run = await service.runAccount("demo-account", "manual");

    expect(run.failureCount).toBe(0);
    expect(provider.mutations).toEqual([]);
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

    expect(store.getAccount("demo-account")?.executionMode).toBe("manual-approval");
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
      executionMode: account.executionMode,
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

  it("keeps manual-approval accounts in suggestion mode without provider writes", async () => {
    store.setAccountExecutionMode("demo-account", "manual-approval", "test");

    const run = await service.runAccount("demo-account", "manual");

    expect(run.candidateCount).toBe(1);
    expect(run.successCount).toBe(0);
    expect(provider.mutations).toHaveLength(0);
    expect(store.listAutomationDecisions("demo-account")[0]?.status).toBe("preview");
  });

  it("does not turn a suggestion into a write when the master switch changes", async () => {
    provider.afterSync = () => {
      store.updateSystemRuntimeState({ enabled: false });
    };

    const run = await service.runAccount("demo-account", "manual");

    expect(run.failureCount).toBe(0);
    expect(provider.mutations).toHaveLength(0);
    expect(store.listAutomationDecisions("demo-account")[0]).toMatchObject({
      status: "preview",
      errorMessage: null,
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

  it("keeps higher-priority suggestions before applying the per-run limit", async () => {
    provider.scenario = "priority";
    store.updateGlobalAutomationSettings({
      pollingIntervalMinutes: 5,
      maxActionsPerRun: 1,
    });

    await service.runAccount("demo-account", "manual");

    expect(provider.mutations).toEqual([]);
    expect(store.listAutomationDecisions("demo-account")).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: "adgroup-high-priority", status: "preview" }),
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
      status: "no-action",
      enabledCount: 0,
      disabledCount: 0,
    });
  });

  it("suggests re-enabling a qualified closed ad group without writing", async () => {
    provider.scenario = "recovery";
    const scheduler = new AutomationScheduler(store, service);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 6 * 60_000));

    await scheduler.tick();

    vi.useRealTimers();
    expect(provider.mutations).toEqual([]);
    expect(store.listAutomationDecisions("demo-account")[0]).toMatchObject({
      externalId: "adgroup-1",
      action: "enable",
      status: "preview",
    });
    expect(store.listPollCycles()[0]?.accounts[0]).toMatchObject({
      status: "no-action",
      enabledCount: 0,
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
    expect(provider.mutations).toEqual([]);
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
