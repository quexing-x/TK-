import { createHash, randomUUID } from "node:crypto";
import {
  ProviderCredentialInputSchema,
  automationRuleDefinitions,
  evaluateRuleConfiguration,
  filterEntitiesToRecentWindow,
  type AutomationCandidate,
  type AutomationRunRecord,
  type AutomationTrigger,
  type ManualStatusInput,
  type PollCycleRecord,
  type RuleConfiguration,
  type AdOperationRecord,
  type AutomationApprovalRecord,
  type WriteTaskActor,
  normalizeProviderEntity,
} from "@tk-auto/core";
import type { CredentialVault } from "@tk-auto/credentials";
import {
  ProviderRegistry,
  type ProviderContext,
  type StatusMutation,
  type StatusMutationResult,
} from "@tk-auto/providers";
import { AutomationStore } from "@tk-auto/storage";
import { WriteTaskKernel, withLeaseHeartbeat } from "./write-task-kernel.js";

const statusLeaseHeartbeatMs = 60 * 1000;
const writeLeaseTimeoutMs = 30 * 60 * 1000;
const verifiedDisableRuleCodes = new Set([
  "CV1_CPC_CLOSE",
  "CV1_CPA_CLOSE",
  "CV2_CPA_CLOSE",
  "NO_CONV_SPEND_CLOSE",
  "NO_CONV_CPC_CLOSE",
  "NO_CART_CLOSE",
]);

export class AutomationBusyError extends Error {}
class WriteBlockedBeforeDispatchError extends Error {}

interface CredentialGeneration {
  credentialRef: string | null;
  updatedAt: string;
}

export interface PollNotificationDispatcher {
  flushPending(): Promise<void>;
  enqueueAndDispatch(cycle: PollCycleRecord): Promise<void>;
}

export class AutomationService {
  private readonly runningAccounts = new Set<string>();
  private readonly manualStatusQueues = new Map<string, Promise<void>>();
  private readonly statusTasks: WriteTaskKernel<AdOperationRecord, string>;

  constructor(
    private readonly store: AutomationStore,
    private readonly vault: CredentialVault,
    private readonly providers: ProviderRegistry,
  ) {
    this.statusTasks = new WriteTaskKernel({
      claim: (taskId, executorId, expectedStatus, actor) =>
        this.store.claimStatusWriteTask(taskId, executorId, expectedStatus, actor),
      succeed: (taskId, executorId, message) =>
        this.store.completeStatusWriteTask(taskId, executorId, "succeeded", message, "readback"),
      fail: (taskId, executorId, message) =>
        this.store.completeStatusWriteTask(taskId, executorId, "failed", message),
      unknown: (taskId, executorId, message) =>
        this.store.completeStatusWriteTask(taskId, executorId, "unknown", message),
    });
    this.store.recoverInterruptedStatusWriteTasks(
      new Date(Date.now() - writeLeaseTimeoutMs).toISOString(),
    );
    this.store.recoverInterruptedScheduledActions(
      new Date(Date.now() - writeLeaseTimeoutMs).toISOString(),
    );
    this.store.recoverInterruptedAutomationApprovals(
      new Date(Date.now() - writeLeaseTimeoutMs).toISOString(),
    );
    for (const task of this.store.listPendingManualStatusWriteTasks()) {
      this.queuePersistedManualStatusTask(task);
    }
  }

  getLowRiskAutomationState(accountId: string) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("账号不存在。");
    const policy = this.store.getLowRiskAutomationPolicy(accountId);
    const localDate = dateKeyInTimeZone(new Date(), account.timezone);
    return {
      policy,
      todayUsage: this.store.countAutomaticActions(accountId, localDate),
      circuit: this.store.getProviderWriteCircuit(accountId, account.providerKind),
    };
  }

  resetProviderWriteCircuit(accountId: string) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("账号不存在。");
    if (this.store.getLowRiskAutomationPolicy(accountId).enabled) {
      throw new Error("请先关闭该账户的低风险自动化，再重置熔断状态。");
    }
    this.store.resetProviderWriteFailures(accountId, account.providerKind);
    return this.getLowRiskAutomationState(accountId);
  }

  async runAccount(
    accountId: string,
    trigger: AutomationTrigger,
  ): Promise<AutomationRunRecord> {
    if (trigger !== "preview" && !this.store.getSystemRuntimeState().enabled) {
      throw new Error("软件总开关已关闭，自动化检测和执行均已暂停。");
    }
    if (this.runningAccounts.has(accountId)) {
      throw new AutomationBusyError("该账户已有检测任务正在运行。");
    }
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("账号不存在。");
    if (trigger !== "preview" && !account.enabled) {
      throw new Error("账户自动化已关闭，不能执行真实启停。");
    }

    this.runningAccounts.add(accountId);
    const lowRiskPolicy = this.store.getLowRiskAutomationPolicy(accountId);
    const writeCircuit = this.store.getProviderWriteCircuit(accountId, account.providerKind);
    const automaticDisableRun =
      trigger === "scheduler" &&
      account.enabled &&
      account.executionMode === "automatic" &&
      lowRiskPolicy.enabled &&
      !writeCircuit?.openedAt;
    const executionMode = automaticDisableRun ? "automatic" as const : "observe" as const;
    const run = this.store.createAutomationRun(
      accountId,
      account.providerKind,
      trigger,
      executionMode,
    );

    try {
      const connection = this.store.getProviderConnection(
        accountId,
        account.providerKind,
      );
      if (!connection || connection.status !== "ready") {
        throw new Error(connectionUnavailableMessage(
          account.displayName,
          account.providerKind,
          connection?.status,
        ));
      }
      this.providers.requireAccountCapability(
        accountId,
        account.providerKind,
        connection,
        "read-campaigns",
      );
      const context = await this.loadContext(
        accountId,
        account.providerKind,
        account.timezone,
      );
      let output: Awaited<ReturnType<ProviderRegistry["syncReadOnly"]>>;
      try {
        output = await this.providers.syncReadOnly(
          account.providerKind,
          context,
        );
      } catch (cause) {
        const message = safeMessage(cause);
        this.store.updateProviderStatus(
          accountId,
          account.providerKind,
          "failed",
          account.providerKind === "cookie"
            ? `Cookie 已失效或数据同步异常：${message}`
            : `API 数据同步异常：${message}`,
        );
        if (account.executionMode === "automatic") {
          this.store.setAccountExecutionMode(
            accountId,
            "manual-approval",
            "Provider 数据同步失败，已自动熔断写入。",
          );
        }
        throw cause;
      }
      if (output.result.quality.status !== "healthy" && account.executionMode === "automatic") {
        this.store.setAccountExecutionMode(
          accountId,
          "manual-approval",
          `同步数据不完整：${output.result.warnings.join("；").slice(0, 500)}`,
        );
      }
      const ruleConfiguration = this.store.getRuleConfiguration();
      const dataQualityWarnings = [
        ...output.result.warnings,
        ...output.result.quality.partialFailures,
        ...output.result.quality.missingMetrics.map((metric) => `缺少指标 ${metric}`),
      ];
      const suggestionMetadata = {
        ruleVersion: ruleConfiguration.updatedAt,
        dataQualityStatus: output.result.quality.status,
        dataQualityWarnings: [...new Set(dataQualityWarnings)],
      };
      const saveSuggestion = (
        candidate: AutomationCandidate,
        status: "preview" | "pending" | "skipped",
        message: string | null = null,
      ) => this.store.saveAutomationDecision(
        run,
        candidate,
        status,
        message,
        {
          ...suggestionMetadata,
          rulePredicate: buildRulePredicate(ruleConfiguration, candidate),
        },
      );
      const recent = filterEntitiesToRecentWindow(
        output.entities,
        new Date(),
        ruleConfiguration.lookbackHours,
      );
      const filteredResult = {
        ...output.result,
        counts: {
          campaign: recent.entities.filter((item) => item.entityType === "campaign").length,
          "ad-group": recent.entities.filter((item) => item.entityType === "ad-group").length,
          ad: recent.entities.filter((item) => item.entityType === "ad").length,
        },
        warnings:
          recent.excludedCount > 0
            ? [
                ...output.result.warnings,
                `已排除 ${recent.excludedCount} 个不属于最近 ${ruleConfiguration.lookbackHours} 小时广告组窗口的对象。`,
              ]
            : output.result.warnings,
      };
      this.store.saveReadOnlySync(
        accountId,
        account.providerKind,
        recent.entities,
        filteredResult,
      );

      const evaluation = evaluateRuleConfiguration(
        output.result.quality.status === "invalid" ? [] : recent.entities,
        ruleConfiguration,
      );
      const eligible: AutomationCandidate[] = [];
      for (const candidate of evaluation.candidates) {
        const skipReason = this.getSkipReason(accountId, candidate);
        if (skipReason) {
          saveSuggestion(candidate, "skipped", skipReason);
        } else {
          eligible.push(candidate);
        }
      }

      const { maxActionsPerRun } = this.store.getGlobalAutomationSettings();
      const orderedEligible = eligible.sort(compareAutomationCandidates);
      const closingAdGroups = new Set(
        orderedEligible
          .filter(
            (candidate) =>
              candidate.action === "disable" &&
              candidate.entity.entityType === "ad-group",
          )
          .map((candidate) => candidate.entity.externalId),
      );
      const closingCampaigns = new Set(
        orderedEligible
          .filter(
            (candidate) =>
              candidate.action === "disable" &&
              candidate.entity.entityType === "campaign",
          )
          .map((candidate) => candidate.entity.externalId),
      );
      const conflictFree: AutomationCandidate[] = [];
      for (const candidate of orderedEligible) {
        const blockedByCampaign =
          candidate.action === "enable" &&
          candidate.entity.entityType !== "campaign" &&
          candidate.entity.parentCampaignId !== null &&
          closingCampaigns.has(candidate.entity.parentCampaignId);
        const blockedByAdGroup =
          candidate.action === "enable" &&
          candidate.entity.entityType === "ad" &&
          candidate.entity.parentAdGroupId !== null &&
          closingAdGroups.has(candidate.entity.parentAdGroupId);
        if (blockedByCampaign || blockedByAdGroup) {
          saveSuggestion(
            candidate,
            "skipped",
            blockedByCampaign
              ? "父推广系列建议关闭，本轮不建议开启子对象。"
              : "父广告组建议关闭，本轮不建议开启子广告。",
          );
        } else {
          conflictFree.push(candidate);
        }
      }
      const selected = conflictFree.slice(0, maxActionsPerRun);
      for (const candidate of conflictFree.slice(maxActionsPerRun)) {
        saveSuggestion(candidate, "skipped", `超过全局单轮最大建议数 ${maxActionsPerRun}。`);
      }

      let actionCount = 0;
      let successCount = 0;
      let failureCount = 0;
      if (!automaticDisableRun || output.result.quality.status !== "healthy") {
        for (const candidate of selected) saveSuggestion(candidate, "preview");
      } else {
        const localDate = dateKeyInTimeZone(new Date(), account.timezone);
        const automaticTargets = new Set<string>();
        for (const candidate of selected) {
          if (
            candidate.action !== "disable" ||
            !verifiedDisableRuleCodes.has(candidate.thresholdCode)
          ) {
            saveSuggestion(
              candidate,
              "skipped",
              "低风险自动化只允许已验证的关闭规则，开启建议必须人工批准。",
            );
            continue;
          }
          const targetKey = `${candidate.entity.entityType}:${candidate.entity.externalId}:disable`;
          if (automaticTargets.has(targetKey)) {
            saveSuggestion(
              candidate,
              "skipped",
              "同一对象本轮已有更高优先级的自动关闭操作。",
            );
            continue;
          }
          automaticTargets.add(targetKey);
          const decision = saveSuggestion(candidate, "pending");
          const reservation = this.store.reserveAutomaticAction({
            accountId,
            actionKey: buildAutomaticActionKey(accountId, suggestionMetadata.ruleVersion, candidate),
            localDate,
            dailyLimit: lowRiskPolicy.dailyActionLimit,
          });
          if (reservation !== "claimed") {
            this.store.updateAutomationDecision(
              decision.id,
              "skipped",
              reservation === "duplicate"
                ? "相同规则输入已被其他执行器领取，本轮跳过。"
                : `已达到每日自动关闭上限 ${lowRiskPolicy.dailyActionLimit}。`,
            );
            continue;
          }
          actionCount += 1;
          try {
            const { result } = await this.changeStatus(
              accountId,
              {
                entityType: candidate.entity.entityType,
                externalId: candidate.entity.externalId,
                action: "disable",
              },
              "automation",
              { id: "automation-scheduler", name: "低风险自动化", kind: "system" },
              undefined,
              true,
              undefined,
              `命中「${candidate.reason.split("：", 1)[0]}」规则，自动关闭`,
            );
            if (result.ok) {
              successCount += 1;
              this.store.updateAutomationDecision(decision.id, "succeeded");
            } else if (result.failureKind === "unknown") {
              failureCount += 1;
              this.store.updateAutomationDecision(decision.id, "unknown", result.message);
            } else {
              failureCount += 1;
              this.store.updateAutomationDecision(decision.id, "failed", result.message);
            }
          } catch (cause) {
            failureCount += 1;
            this.store.updateAutomationDecision(
              decision.id,
              cause instanceof WriteBlockedBeforeDispatchError ? "failed" : "unknown",
              cause instanceof WriteBlockedBeforeDispatchError
                ? `自动关闭在请求发送前被阻止：${safeMessage(cause)}`
                : `自动关闭结果无法确认：${safeMessage(cause)}`,
            );
          }
        }
      }

      return this.store.finishAutomationRun(run.id, {
        status: "completed",
        candidateCount: evaluation.candidates.length,
        actionCount,
        successCount,
        failureCount,
      });
    } catch (cause) {
      return this.store.finishAutomationRun(run.id, {
        status: "failed",
        candidateCount: 0,
        actionCount: 0,
        successCount: 0,
        failureCount: 0,
        errorMessage: safeMessage(cause),
      });
    } finally {
      this.runningAccounts.delete(accountId);
    }
  }

  async checkAccountConnection(accountId: string): Promise<void> {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("账号不存在。");
    const connection = this.store.getProviderConnection(
      accountId,
      account.providerKind,
    );
    if (!connection?.credentialRef) return;
    try {
      const context = await this.loadContext(
        accountId,
        account.providerKind,
        account.timezone,
      );
      const health = await this.providers.checkHealth(account.providerKind, context);
      this.store.updateProviderStatus(
        accountId,
        account.providerKind,
        health.status,
        health.message,
      );
      if (health.status !== "ready") {
        this.store.setAccountExecutionMode(
          accountId,
          "manual-approval",
          "Cookie 或 Provider 连接检测未通过，已自动熔断写入。",
        );
      }
    } catch (cause) {
      const message = safeMessage(cause);
      this.store.updateProviderStatus(
        accountId,
        account.providerKind,
        "failed",
        account.providerKind === "cookie"
          ? `Cookie 已失效或连接异常：${message}`
          : `API 连接异常：${message}`,
      );
      this.store.setAccountExecutionMode(
        accountId,
        "manual-approval",
        "Cookie 或 Provider 连接检测失败，已自动熔断写入。",
      );
    }
  }

  async changeStatusManually(
    accountId: string,
    input: ManualStatusInput,
    actor: WriteTaskActor = { id: "local-user", name: "本地用户", kind: "user" },
  ): Promise<StatusMutationResult> {
    if (this.runningAccounts.has(accountId)) {
      throw new AutomationBusyError("该账户已有任务正在执行，请稍后重试。");
    }
    this.runningAccounts.add(accountId);
    try {
      return (await this.changeStatus(
        accountId,
        input,
        "manual",
        actor,
        undefined,
        false,
      )).result;
    } finally {
      this.runningAccounts.delete(accountId);
    }
  }

  /** Persists the user intent first, then performs cookie I/O in a serial backend queue. */
  enqueueManualStatusChange(
    accountId: string,
    input: ManualStatusInput,
    actor: WriteTaskActor = { id: "local-user", name: "local-user", kind: "user" },
  ): AdOperationRecord {
    if (!this.store.getSystemRuntimeState().enabled) {
      throw new Error("System automation is paused.");
    }
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("Account does not exist.");
    const connection = this.store.getProviderConnection(accountId, account.providerKind);
    if (!connection || connection.status !== "ready") {
      throw new Error(connectionUnavailableMessage(
        account.displayName,
        account.providerKind,
        connection?.status,
      ));
    }
    this.assertWriteAllowed(accountId, false);
    const entity = this.store.listManagedEntities(accountId, account.providerKind).find(
      (item) => item.entityType === input.entityType && item.externalId === input.externalId,
    );
    if (!entity) throw new Error("Ad object is missing or has not been synced.");
    const task = this.store.createStatusWriteTask({
      accountId,
      providerKind: account.providerKind,
      entityType: input.entityType,
      externalId: input.externalId,
      entityName: entity.name,
      action: input.action,
      source: "manual",
    }, actor);
    this.queuePersistedManualStatusTask(task);
    return task;
  }

  private queuePersistedManualStatusTask(task: AdOperationRecord): void {
    const previous = this.manualStatusQueues.get(task.accountId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      try {
        await this.waitForAccountIdle(task.accountId);
        this.runningAccounts.add(task.accountId);
        await this.changeStatus(task.accountId, {
          entityType: task.entityType,
          externalId: task.externalId,
          action: task.action === "enable" ? "enable" : "disable",
        }, "manual", task.actor, undefined, false, task);
      } catch (cause) {
        this.failQueuedStatusTask(task, task.actor, cause);
      } finally {
        this.runningAccounts.delete(task.accountId);
      }
    });
    this.manualStatusQueues.set(task.accountId, queued);
    void queued.finally(() => {
      if (this.manualStatusQueues.get(task.accountId) === queued) {
        this.manualStatusQueues.delete(task.accountId);
      }
    });
  }

  async retryStatusOperation(
    accountId: string,
    operationId: string,
    actor: WriteTaskActor = { id: "local-user", name: "本地用户", kind: "user" },
  ): Promise<StatusMutationResult> {
    if (this.runningAccounts.has(accountId)) {
      throw new AutomationBusyError("该账户已有任务正在执行，请稍后重试。");
    }
    const task = this.store.getAdOperationByOperationId(operationId);
    if (task.accountId !== accountId) throw new Error("状态写任务不属于当前账户。");
    if (task.status === "unknown") {
      throw new Error("状态写入结果待确认，禁止自动重试。");
    }
    if (task.source === "automation") {
      throw new Error("人工批准建议为一次性操作；请重新检测并批准新建议，禁止直接重试旧任务。");
    }
    if (task.status !== "failed") throw new Error("只有明确失败的状态写任务可以重试。");
    this.runningAccounts.add(accountId);
    try {
      const account = this.store.getAccount(accountId);
      if (!account) throw new Error("账号不存在。");
      const connection = this.store.getProviderConnection(accountId, account.providerKind);
      if (!connection || connection.status !== "ready") {
        throw new Error(connectionUnavailableMessage(
          account.displayName,
          account.providerKind,
          connection?.status,
        ));
      }
      const context = await this.loadContext(accountId, account.providerKind, account.timezone);
      this.assertWriteAllowed(accountId, false);
      const executorId = randomUUID();
      const claimed = this.statusTasks.claim(task.id, executorId, "failed", actor);
      if (!claimed) throw new Error("状态写任务正在执行或状态已经变化。");
      return await this.executeStatusTask(context, {
        entityType: task.entityType,
        externalId: task.externalId,
        action: task.action === "enable" ? "enable" : "disable",
      }, claimed, executorId, connection, false);
    } finally {
      this.runningAccounts.delete(accountId);
    }
  }

  async approveAutomationDecision(
    accountId: string,
    decisionId: string,
    actor: WriteTaskActor,
  ): Promise<AutomationApprovalRecord> {
    const decision = this.store.getAutomationDecision(decisionId);
    if (!decision || decision.accountId !== accountId) {
      throw new Error("自动化建议不存在或不属于当前账户。");
    }
    const approval = this.store.getOrCreateAutomationApproval(decisionId, actor);
    if (approval.status !== "pending") return approval;
    const executorId = randomUUID();
    const claimed = this.store.claimAutomationApproval(approval.id, executorId);
    if (!claimed) return this.store.getAutomationApprovalByDecision(decisionId)!;
    if (this.runningAccounts.has(accountId)) {
      return this.store.completeAutomationApproval(claimed.id, executorId, "failed", {
        errorMessage: "该账户已有任务正在执行，请重新生成建议后再批准。",
      });
    }

    this.runningAccounts.add(accountId);
    let beforeStatus: "enabled" | "disabled" | "unknown" | null = null;
    let statusOperationId: string | null = null;
    try {
      if (!this.store.getSystemRuntimeState().enabled) {
        throw new Error("软件总开关已关闭，已阻止批准执行。");
      }
      const account = this.store.getAccount(accountId);
      if (!account?.enabled) throw new Error("账户自动化开关已关闭，已阻止批准执行。");
      if (account.providerKind !== claimed.providerKind) {
        throw new Error("账户 Provider 已变化，旧建议已阻止执行。");
      }
      const connection = this.store.getProviderConnection(accountId, account.providerKind);
      if (!connection || connection.status !== "ready") {
        throw new Error(connectionUnavailableMessage(
          account.displayName,
          account.providerKind,
          connection?.status,
        ));
      }
      const { maxActionsPerRun } = this.store.getGlobalAutomationSettings();
      if (this.store.countAutomationApprovals(
        decision.runId,
        ["running", "succeeded", "failed", "unknown"],
      ) > maxActionsPerRun) {
        throw new Error(`本轮批准执行已达到操作限额 ${maxActionsPerRun}。`);
      }

      const context = await this.loadContext(accountId, account.providerKind, account.timezone);
      const currentAccount = this.store.getAccount(accountId);
      const dispatchConnection = this.store.getProviderConnection(
        accountId,
        account.providerKind,
      );
      if (
        !currentAccount?.enabled
        || currentAccount.providerKind !== account.providerKind
        || !dispatchConnection
        || dispatchConnection.credentialRef !== connection.credentialRef
        || dispatchConnection.updatedAt !== connection.updatedAt
      ) {
        throw new Error("账户授权或凭据已变更，批准执行已阻止。");
      }
      this.providers.requireAccountCapability(
        accountId,
        account.providerKind,
        dispatchConnection,
        "read-campaigns",
      );
      let refreshed: Awaited<ReturnType<ProviderRegistry["syncReadOnly"]>>;
      try {
        refreshed = await this.providers.syncReadOnly(account.providerKind, context);
      } catch (cause) {
        const message = safeMessage(cause);
        this.store.updateProviderStatus(
          accountId,
          account.providerKind,
          "failed",
          `批准执行前同步异常：${message}`,
        );
        this.store.setAccountExecutionMode(
          accountId,
          "manual-approval",
          "批准执行前 Provider 同步失败，已自动熔断写入。",
        );
        throw cause;
      }
      if (refreshed.result.quality.status !== "healthy") {
        throw new Error(`最新数据质量为 ${refreshed.result.quality.status}，已阻止批准执行。`);
      }
      this.store.saveReadOnlySync(accountId, account.providerKind, refreshed.entities, refreshed.result);
      const currentEntity = refreshed.entities
        .filter((entity) => entity.entityType === decision.entityType)
        .map(normalizeProviderEntity)
        .find((entity) => entity.externalId === decision.externalId);
      if (!currentEntity) throw new Error("执行前未找到建议绑定的广告对象。");
      beforeStatus = currentEntity.status;
      this.store.updateAutomationApprovalPreflight(claimed.id, executorId, beforeStatus);
      if (beforeStatus !== claimed.expectedStatus) {
        throw new Error(
          `对象状态已从建议时预期的 ${claimed.expectedStatus} 变为 ${beforeStatus}，旧建议已阻止执行。`,
        );
      }

      const { result } = await this.changeStatus(
        accountId,
        {
          entityType: claimed.entityType,
          externalId: claimed.externalId,
          action: claimed.action,
        },
        "automation",
        actor,
        (task) => {
          statusOperationId = task.operationId;
          this.store.updateAutomationApprovalPreflight(
            claimed.id,
            executorId,
            beforeStatus!,
            statusOperationId,
          );
        },
        false,
      );
      const status = result.ok
        ? "succeeded"
        : result.failureKind === "unknown" ? "unknown" : "failed";
      const observedAfter = this.store
        .listManagedEntities(accountId, account.providerKind)
        .find((entity) =>
          entity.entityType === claimed.entityType
          && entity.externalId === claimed.externalId,
        )?.status ?? "unknown";
      const statusTask = statusOperationId
        ? this.store.getAdOperationByOperationId(statusOperationId)
        : null;
      const desiredStatus = claimed.action === "enable" ? "enabled" : "disabled";
      const approvalStatus = result.ok
        && (statusTask?.syncWarning || observedAfter !== desiredStatus)
        ? "unknown"
        : status;
      const confirmationError = approvalStatus === "unknown" && result.ok
        ? `Provider 已接受操作，但写后状态未确认（当前：${observedAfter}）；禁止重复批准。`
        : result.ok ? null : result.message;
      const recordedAfterStatus = result.ok && !statusTask?.syncWarning
        ? observedAfter
        : null;
      return this.store.completeAutomationApproval(claimed.id, executorId, approvalStatus, {
        afterStatus: recordedAfterStatus,
        statusOperationId,
        providerMessage: [result.message, statusTask?.syncWarning]
          .filter(Boolean)
          .join("；"),
        errorMessage: confirmationError,
      });
    } catch (cause) {
      const message = safeMessage(cause);
      const statusTask = statusOperationId
        ? this.store.getAdOperationByOperationId(statusOperationId)
        : null;
      const desiredStatus = claimed.action === "enable" ? "enabled" : "disabled";
      let confirmedAfter: "enabled" | "disabled" | "unknown" | null = null;
      if (statusTask?.status === "succeeded" && !statusTask.syncWarning) {
        try {
          confirmedAfter = this.store
            .listManagedEntities(accountId, claimed.providerKind)
            .find((entity) =>
              entity.entityType === claimed.entityType
              && entity.externalId === claimed.externalId,
            )?.status ?? "unknown";
        } catch {
          confirmedAfter = null;
        }
      }
      const terminalStatus = !statusTask
        ? "failed"
        : statusTask.status === "failed"
          ? "failed"
          : statusTask.status === "succeeded" && confirmedAfter === desiredStatus
            ? "succeeded"
            : "unknown";
      return this.store.completeAutomationApproval(claimed.id, executorId, terminalStatus, {
        afterStatus: terminalStatus === "succeeded"
          ? confirmedAfter
          : statusTask ? null : beforeStatus,
        statusOperationId,
        providerMessage: [statusTask?.message, statusTask?.syncWarning]
          .filter(Boolean)
          .join("；") || null,
        errorMessage: terminalStatus === "succeeded"
          ? null
          : terminalStatus === "unknown"
            ? `写入结果无法确认：${message}；禁止重复批准。`
            : message,
      });
    } finally {
      this.runningAccounts.delete(accountId);
    }
  }

  async runDueScheduledActions(
    accountId: string,
    asOf = new Date().toISOString(),
  ): Promise<void> {
    if (!this.store.getSystemRuntimeState().enabled) return;
    const account = this.store.getAccount(accountId);
    if (!account?.enabled) return;
    if (this.runningAccounts.has(accountId)) return;
    const staleBefore = new Date(Date.now() - writeLeaseTimeoutMs).toISOString();
    this.store.recoverInterruptedStatusWriteTasks(staleBefore);
    this.store.recoverInterruptedScheduledActions(staleBefore);
    this.runningAccounts.add(accountId);
    try {
      for (const schedule of this.store.listDueScheduledActions(accountId, asOf)) {
        const executorId = randomUUID();
        const claimed = this.store.claimDueScheduledAction(schedule.id, executorId, asOf);
        if (!claimed) continue;
        let result: "succeeded" | "failed" | "unknown" = "failed";
        let message = "定时状态写入未执行。";
        const linkedTask = { id: null as string | null };
        try {
          const changed = await this.changeStatus(
            accountId,
            {
              entityType: claimed.entityType,
              externalId: claimed.externalId,
              action: claimed.action,
            },
            "scheduled",
            { id: "automation-scheduler", name: "自动化调度器", kind: "system" },
            (task) => {
              linkedTask.id = task.id;
              this.store.bindScheduledActionOperation(
                claimed.id,
                executorId,
                task.operationId,
              );
            },
            false,
          );
          result = changed.result.ok
            ? "succeeded"
            : changed.result.failureKind === "unknown" ? "unknown" : "failed";
          message = result === "unknown"
            ? `写入结果 unknown，禁止自动续排：${changed.result.message}`
            : changed.result.message;
        } catch (cause) {
          const durableStatus = linkedTask.id
            ? this.store.getAdOperation(linkedTask.id).status
            : null;
          result = durableStatus === "unknown" || durableStatus === "running"
            ? "unknown"
            : "failed";
          message = safeMessage(cause);
        }
        try {
          this.store.completeScheduledAction(
            claimed.id,
            result,
            message,
            executorId,
            asOf,
          );
        } catch {
          // Leave the durable lease and linked status operation intact. A
          // recovery pass resolves it without dispatching the write again.
        }
      }
    } finally {
      this.runningAccounts.delete(accountId);
    }
  }

  /**
   * At 23:45 in the account timezone, preserve converting ad groups with the
   * daily overnight pair and queue a single close for every other open group.
   * Unknown and manually-taken-over groups never receive an automatic write.
   */
  enrollNightlyAdGroups(
    accountId: string,
    asOf = new Date().toISOString(),
  ): { overnight: number; closing: number } {
    if (!this.store.getSystemRuntimeState().enabled) return { overnight: 0, closing: 0 };
    const account = this.store.getAccount(accountId);
    if (!account?.enabled) return { overnight: 0, closing: 0 };
    const now = new Date(asOf);
    const localTime = timePartsInTimeZone(now, account.timezone);
    if (localTime.hour !== 23 || localTime.minute < 45) {
      return { overnight: 0, closing: 0 };
    }

    const minutesSinceWindowStart = (localTime.minute - 45) + localTime.second / 60;
    const windowStartedAt = new Date(
      now.getTime() - minutesSinceWindowStart * 60_000,
    ).toISOString();
    const nextMidnight = new Date(
      now.getTime() + (60 - localTime.minute) * 60_000 - localTime.second * 1_000,
    ).toISOString();
    let overnight = 0;
    let closing = 0;

    for (const entity of this.store.listManagedEntities(accountId, account.providerKind)) {
      if (
        entity.entityType !== "ad-group" ||
        entity.status !== "enabled" ||
        entity.ignored
      ) continue;

      if ((entity.metrics.conversions ?? 0) > 0) {
        if (this.store.hasScheduledOvernightForEntity(accountId, entity.externalId)) continue;
        this.store.createOvernightSchedule(accountId, {
          externalId: entity.externalId,
          disableAt: asOf,
          enableAt: nextMidnight,
        });
        overnight += 1;
        continue;
      }

      if (this.store.hasScheduledActionSince(
        accountId,
        entity.externalId,
        "disable",
        windowStartedAt,
      )) continue;
      this.store.createOneTimeSchedule(accountId, {
        externalId: entity.externalId,
        action: "disable",
        runAt: asOf,
      });
      closing += 1;
    }
    return { overnight, closing };
  }

  private async changeStatus(
    accountId: string,
    input: ManualStatusInput,
    source: "manual" | "scheduled" | "automation",
    actor: WriteTaskActor,
    onTaskCreated?: (task: AdOperationRecord) => void,
    requireAutomatic = true,
    existingTask?: AdOperationRecord,
    successMessage?: string,
  ): Promise<{ result: StatusMutationResult; task: AdOperationRecord }> {
    if (!this.store.getSystemRuntimeState().enabled) {
      throw new Error("软件总开关已关闭，广告启停操作已暂停。");
    }
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("账号不存在。");
    const connection = this.store.getProviderConnection(
      accountId,
      account.providerKind,
    );
    if (!connection || connection.status !== "ready") {
      throw new Error(connectionUnavailableMessage(
        account.displayName,
        account.providerKind,
        connection?.status,
      ));
    }
    const context = await this.loadContext(
      accountId,
      account.providerKind,
      account.timezone,
    );
    this.assertWriteAllowed(accountId, requireAutomatic);
    const entity = this.store
      .listManagedEntities(accountId, account.providerKind)
      .find(
        (item) =>
          item.entityType === input.entityType &&
          item.externalId === input.externalId,
      );
    const task = existingTask ?? this.store.createStatusWriteTask({
      accountId,
      providerKind: account.providerKind,
      entityType: input.entityType,
      externalId: input.externalId,
      entityName: entity?.name ?? input.externalId,
      action: input.action,
      source,
    }, actor);
    onTaskCreated?.(task);
    const executorId = randomUUID();
    const claimed = this.statusTasks.claim(task.id, executorId, "pending", actor);
    if (!claimed) throw new Error("状态写任务已被其他执行器领取。");
    return {
      result: await this.executeStatusTask(
        context,
        input,
        claimed,
        executorId,
        connection,
        requireAutomatic,
        source === "automation" && requireAutomatic,
        successMessage,
      ),
      task,
    };
  }

  private async waitForAccountIdle(accountId: string): Promise<void> {
    const deadline = Date.now() + 5 * 60_000;
    while (this.runningAccounts.has(accountId)) {
      if (Date.now() >= deadline) {
        throw new AutomationBusyError("Account queue timed out.");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  private failQueuedStatusTask(
    task: AdOperationRecord,
    actor: WriteTaskActor,
    cause: unknown,
  ): void {
    const executorId = randomUUID();
    const claimed = this.statusTasks.claim(task.id, executorId, "pending", actor);
    if (claimed) this.statusTasks.fail(task.id, executorId, safeMessage(cause));
  }

  private async executeStatusTask(
    context: ProviderContext,
    input: ManualStatusInput,
    task: AdOperationRecord,
    executorId: string,
    expectedCredentialGeneration: CredentialGeneration,
    requireAutomatic = true,
    requireLowRiskPolicy = false,
    successMessage?: string,
  ): Promise<StatusMutationResult> {
    const account = this.store.getAccount(task.accountId);
    if (!account) throw new Error("账号不存在。");
    let providerInvoked = false;
    let providerConfirmed = false;
    let result: StatusMutationResult;
    try {
      providerInvoked = true;
      const results = await withLeaseHeartbeat(
        () => this.changeProviderStatus(
          context,
          [input],
          expectedCredentialGeneration,
          requireAutomatic,
          requireLowRiskPolicy,
        ),
        () => this.store.renewStatusWriteTaskLease(task.id, executorId),
        statusLeaseHeartbeatMs,
      );
      result = results[0] ?? {
        ...input,
        ok: false,
        failureKind: "unknown",
        message: "Provider 未返回执行结果。",
      };
      if (!result.ok) {
        if (result.failureKind === "unknown") {
          this.statusTasks.unknown(task.id, executorId, result.message);
        } else {
          this.statusTasks.fail(task.id, executorId, result.message);
        }
        return result;
      }
      providerConfirmed = true;
    } catch (cause) {
      const message = safeMessage(cause);
      const unknown = !(cause instanceof WriteBlockedBeforeDispatchError)
        && (providerConfirmed || providerInvoked);
      try {
        if (unknown) this.statusTasks.unknown(task.id, executorId, message);
        else this.statusTasks.fail(task.id, executorId, message);
      } catch {
        // The original storage failure is preserved; a stale running task is
        // recovered as unknown on restart rather than retried automatically.
      }
      throw cause;
    }
    let syncWarning: string | null = null;
    try {
      const refreshed = await this.providers.syncReadOnly(
        account.providerKind,
        context,
      );
      this.store.saveReadOnlySync(
        task.accountId,
        account.providerKind,
        refreshed.entities,
        refreshed.result,
      );
      const desiredStatus = input.action === "enable" ? "enabled" : "disabled";
      const observedStatus = this.store.listManagedEntities(
        task.accountId,
        account.providerKind,
      ).find(
        (entity) => entity.entityType === input.entityType && entity.externalId === input.externalId,
      )?.status;
      if (refreshed.result.quality.status !== "healthy") {
        syncWarning = `状态写入后同步数据不完整：${refreshed.result.warnings.join("；")}`;
      } else if (observedStatus !== desiredStatus) {
        syncWarning = `状态写入后回读未确认目标状态：期望 ${desiredStatus}，实际 ${observedStatus ?? "未返回"}`;
      }
      if (syncWarning) {
        this.store.setAccountExecutionMode(
          task.accountId,
          "manual-approval",
          syncWarning.slice(0, 500),
        );
        this.statusTasks.unknown(task.id, executorId, syncWarning);
        return { ...result, ok: false, failureKind: "unknown", message: syncWarning };
      }
    } catch (cause) {
      syncWarning = safeMessage(cause);
      this.store.updateProviderStatus(
        task.accountId,
        account.providerKind,
        "failed",
        `状态写入后同步异常：${syncWarning}`,
      );
      this.store.setAccountExecutionMode(
        task.accountId,
        "manual-approval",
        "状态写入后 Provider 数据同步失败，已自动熔断写入。",
      );
      this.statusTasks.unknown(task.id, executorId, syncWarning);
      return { ...result, ok: false, failureKind: "unknown", message: syncWarning };
    }
    this.statusTasks.succeed(task.id, executorId, successMessage ?? result.message);
    try {
      this.store.completeStatusWriteTaskSync(task.id, null);
    } catch {
      // The state change and readback are already durable. Keep the successful
      // task rather than re-dispatching a confirmed provider write.
    }
    return result;
  }

  private getSkipReason(
    accountId: string,
    candidate: AutomationCandidate,
  ): string | null {
    const providerKind = this.store.getAccount(accountId)?.providerKind;
    if (
      providerKind &&
      this.store.isEntityIgnored(
        accountId,
        providerKind,
        candidate.entity.entityType,
        candidate.entity.externalId,
      )
    ) {
      return "对象在忽略名单中。";
    }
    if (
      this.store.hasUnknownDecision(
        accountId,
        candidate.entity.entityType,
        candidate.entity.externalId,
        candidate.action,
      )
    ) {
      return "该对象存在结果待确认的历史操作，已阻止生成新的同动作建议。";
    }
    if (
      this.store.isDecisionInCooldown(
        accountId,
        candidate.thresholdId,
        candidate.entity.entityType,
        candidate.entity.externalId,
        candidate.action,
        candidate.cooldownMinutes,
      )
    ) {
      return `仍在 ${candidate.cooldownMinutes} 分钟冷却期内。`;
    }
    if (candidate.action === "enable") {
      const managedEntities = this.store.listManagedEntities(
        accountId,
        providerKind ?? "cookie",
      );
      if (
        candidate.entity.entityType !== "campaign" &&
        candidate.entity.parentCampaignId
      ) {
        const parentCampaign = managedEntities.find(
          (entity) =>
            entity.entityType === "campaign" &&
            entity.externalId === candidate.entity.parentCampaignId,
        );
        if (parentCampaign?.status === "disabled") {
          return "父推广系列处于关闭状态，不建议开启子对象。";
        }
      }
      if (
        candidate.entity.entityType === "ad" &&
        candidate.entity.parentAdGroupId
      ) {
        const parentAdGroup = managedEntities.find(
          (entity) =>
            entity.entityType === "ad-group" &&
            entity.externalId === candidate.entity.parentAdGroupId,
        );
        if (parentAdGroup?.status === "disabled") {
          return "父广告组处于关闭状态，不建议开启子广告。";
        }
      }
    }
    return null;
  }

  private async executeCandidate(
    context: ProviderContext,
    candidate: AutomationCandidate,
    expectedCredentialGeneration: CredentialGeneration,
  ): Promise<StatusMutationResult> {
    const results = await this.changeProviderStatus(context, [
      {
        entityType: candidate.entity.entityType,
        externalId: candidate.entity.externalId,
        action: candidate.action,
      },
    ], expectedCredentialGeneration, true, false);
    return (
      results[0] ?? {
        entityType: candidate.entity.entityType,
        externalId: candidate.entity.externalId,
        action: candidate.action,
        ok: false,
        message: "Provider 未返回执行结果。",
      }
    );
  }

  private async changeProviderStatus(
    context: ProviderContext,
    mutations: StatusMutation[],
    expectedCredentialGeneration: CredentialGeneration,
    requireAutomatic = true,
    requireLowRiskPolicy = false,
  ): Promise<StatusMutationResult[]> {
    const dispatchConnection = this.store.getProviderConnection(
      context.accountId,
      context.settings.kind,
    );
    if (
      !dispatchConnection
      || dispatchConnection.credentialRef !== expectedCredentialGeneration.credentialRef
      || dispatchConnection.updatedAt !== expectedCredentialGeneration.updatedAt
    ) {
      throw new WriteBlockedBeforeDispatchError(
        "账户授权或凭据已变更，状态写入已在发送前阻止。",
      );
    }
    this.assertWriteAllowed(context.accountId, requireAutomatic, requireLowRiskPolicy);
    this.providers.requireAccountCapability(
      context.accountId,
      context.settings.kind,
      dispatchConnection,
      "change-status",
    );
    try {
      const results = await this.providers.changeStatus(
        context.settings.kind,
        context,
        mutations,
      );
      const failure = results.find((result) => !result.ok);
      if (failure || results.length < mutations.length) {
        this.markProviderWriteFailure(
          context,
          failure?.message ?? "Provider 未返回完整执行结果。",
        );
      }
      if (!failure && results.length === mutations.length) {
        try {
          this.store.resetProviderWriteFailures(
            context.accountId,
            context.settings.kind,
          );
        } catch {
          // Provider success is authoritative. Local failure-counter cleanup
          // must not turn a confirmed write into unknown or trigger a retry.
        }
      }
      return results;
    } catch (cause) {
      this.markProviderWriteFailure(context, safeMessage(cause));
      throw cause;
    }
  }

  private assertWriteAllowed(
    accountId: string,
    requireAutomatic: boolean,
    requireLowRiskPolicy = false,
  ): void {
    if (!this.store.getSystemRuntimeState().enabled) {
      throw new WriteBlockedBeforeDispatchError("软件总开关已关闭，真实广告写入已暂停。");
    }
    const account = this.store.getAccount(accountId);
    if (!account) throw new WriteBlockedBeforeDispatchError("账号不存在。");
    const latestSync = this.store.getLatestReadOnlySync(accountId, account.providerKind);
    if (!latestSync) {
      throw new WriteBlockedBeforeDispatchError("尚无可信同步记录，真实 Provider 写入已阻止。");
    }
    if (latestSync.quality.status === "invalid") {
      throw new WriteBlockedBeforeDispatchError("同步契约已失效，所有真实 Provider 写入已阻止。");
    }
    if (latestSync.quality.status !== "healthy") {
      throw new WriteBlockedBeforeDispatchError(`同步数据为 ${latestSync.quality.status}，状态写入已阻止。`);
    }
    if (!account.enabled) {
      throw new WriteBlockedBeforeDispatchError("账户未启用，真实 Provider 写入已阻止。");
    }
    if (requireAutomatic && account.executionMode !== "automatic") {
      throw new WriteBlockedBeforeDispatchError("账户没有明确启用 automatic 模式，真实 Provider 写入已阻止。");
    }
    if (requireLowRiskPolicy && !this.store.getLowRiskAutomationPolicy(accountId).enabled) {
      throw new WriteBlockedBeforeDispatchError("账户低风险自动化灰度策略已关闭，自动写入已阻止。");
    }
    if (requireAutomatic) {
      const circuit = this.store.getProviderWriteCircuit(accountId, account.providerKind);
      if (circuit?.openedAt) {
        throw new WriteBlockedBeforeDispatchError("Provider 连续写入失败熔断仍处于开启状态，请人工检查并重置后再试。");
      }
    }
  }

  private markProviderWriteFailure(
    context: ProviderContext,
    message: string,
  ): void {
    const failures = this.store.recordProviderWriteFailure(
      context.accountId,
      context.settings.kind,
      message,
    );
    if (failures >= 3) {
      this.store.setAccountExecutionMode(
        context.accountId,
        "manual-approval",
        "连续 3 次 Provider 写入失败，已自动熔断。",
      );
    }
  }

  private async loadContext(
    accountId: string,
    providerKind: "cookie" | "official-api",
    timezone: string,
  ): Promise<ProviderContext> {
    const connection = this.store.getProviderConnection(accountId, providerKind);
    if (!connection?.credentialRef) {
      throw new Error("接入参数或凭据尚未配置。");
    }
    const secret = await this.vault.read(connection.credentialRef);
    if (!secret) throw new Error("凭据引用已经失效，请重新保存凭据。");
    return {
      accountId,
      settings: connection.settings,
      credential: ProviderCredentialInputSchema.parse(JSON.parse(secret)),
      timezone,
    };
  }
}

const rulePriorities: ReadonlyMap<string, number> = new Map(
  automationRuleDefinitions.map((definition) => [
    definition.code,
    definition.priority,
  ]),
);

function compareAutomationCandidates(
  left: AutomationCandidate,
  right: AutomationCandidate,
): number {
  const priorityDifference =
    (rulePriorities.get(left.thresholdCode) ?? Number.MAX_SAFE_INTEGER) -
    (rulePriorities.get(right.thresholdCode) ?? Number.MAX_SAFE_INTEGER);
  if (priorityDifference !== 0) return priorityDifference;
  if (left.action !== right.action) return left.action === "disable" ? -1 : 1;
  const layerOrder = { campaign: 0, "ad-group": 1, ad: 2 } as const;
  const layerDifference =
    layerOrder[left.entity.entityType] - layerOrder[right.entity.entityType]
  ;
  if (layerDifference !== 0) return layerDifference;
  const externalIdDifference = left.entity.externalId.localeCompare(
    right.entity.externalId,
  );
  if (externalIdDifference !== 0) return externalIdDifference;
  return left.thresholdCode.localeCompare(right.thresholdCode);
}

function buildRulePredicate(
  configuration: RuleConfiguration,
  candidate: AutomationCandidate,
): Record<string, unknown> {
  const rule = configuration.rules.find(
    (item) => item.code === candidate.thresholdCode,
  );
  const layerEnabled =
    candidate.entity.entityType === "campaign"
      ? configuration.layers.campaign
      : candidate.entity.entityType === "ad-group"
        ? configuration.layers.adGroup
        : configuration.layers.ad;
  return {
    code: candidate.thresholdCode,
    enabled: rule?.enabled ?? false,
    values: Object.fromEntries(
      Object.entries(rule?.values ?? {}).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    lookbackHours: configuration.lookbackHours,
    layerEnabled,
    action: candidate.action,
    metric: candidate.metric,
    operator: candidate.operator,
    thresholdValue: candidate.thresholdValue,
  };
}

export class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly store: AutomationStore,
    private readonly service: AutomationService,
    private readonly notifications?: PollNotificationDispatcher,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref?.();
    setTimeout(() => void this.tick(), 5_000).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!this.store.getSystemRuntimeState().enabled) return;
      try {
        await this.notifications?.flushPending();
      } catch {
        // Notification delivery is best-effort and must never block ad polling.
      }
      const { pollingIntervalMinutes } =
        this.store.getGlobalAutomationSettings();
      for (const account of this.store.listAccounts()) {
        const connection = this.store.getProviderConnection(
          account.id,
          account.providerKind,
        );
        if (
          account.enabled &&
          connection?.hasCredential &&
          connection.status === "ready"
        ) {
          this.service.enrollNightlyAdGroups(account.id);
          await this.service.runDueScheduledActions(account.id);
        }
      }
      const dueAccounts = this.store.listAccounts().filter((account) => {
        const connection = this.store.getProviderConnection(
          account.id,
          account.providerKind,
        );
        if (!connection?.hasCredential) return false;
        const dueAt = connection.lastTestedAt
          ? new Date(connection.lastTestedAt).getTime() +
            pollingIntervalMinutes * 60_000
          : 0;
        return Date.now() >= dueAt;
      });
      if (dueAccounts.length === 0) return;

      const cycle = this.store.createPollCycle();
      for (const account of dueAccounts) {
        try {
          await this.service.checkAccountConnection(account.id);
          const refreshed = this.store.getProviderConnection(
            account.id,
            account.providerKind,
          );
          if (!account.enabled) {
            this.store.savePollAccountResult(cycle.id, {
              accountId: account.id,
              accountName: account.displayName,
              runId: null,
              status: "skipped",
              enabledCount: 0,
              disabledCount: 0,
              failureCount: 0,
              message: "账户自动化已关闭。",
            });
            continue;
          }
          if (refreshed?.status !== "ready") {
            this.store.savePollAccountResult(cycle.id, {
              accountId: account.id,
              accountName: account.displayName,
              runId: null,
              status: "failed",
              enabledCount: 0,
              disabledCount: 0,
              failureCount: 1,
              message: refreshed?.lastMessage ?? "账户连接检测失败。",
            });
            continue;
          }
          const run = await this.service.runAccount(account.id, "scheduler");
          const counts = this.store.summarizeAutomationRun(run.id);
          const failed = run.status === "failed" || counts.failureCount > 0;
          this.store.savePollAccountResult(cycle.id, {
            accountId: account.id,
            accountName: account.displayName,
            runId: run.id,
            status: failed
              ? "failed"
              : counts.enabledCount + counts.disabledCount > 0
                ? "changed"
                : "no-action",
            ...counts,
            failureCount: Math.max(counts.failureCount, run.failureCount),
            message: run.errorMessage,
          });
        } catch (cause) {
          this.store.savePollAccountResult(cycle.id, {
            accountId: account.id,
            accountName: account.displayName,
            runId: null,
            status: "failed",
            enabledCount: 0,
            disabledCount: 0,
            failureCount: 1,
            message: safeMessage(cause),
          });
        }
      }
      const completed = this.store.finishPollCycle(cycle.id);
      try {
        await this.notifications?.enqueueAndDispatch(completed);
      } catch {
        // The completed poll cycle remains available for audit and retry.
      }
    } finally {
      this.ticking = false;
    }
  }
}

function safeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "自动化任务失败。";
}

function dateKeyInTimeZone(value: Date, timeZone: string): string {
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

function timePartsInTimeZone(value: Date, timeZone: string): {
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: "hour" | "minute" | "second") => Number(
    parts.find((item) => item.type === type)?.value ?? "0",
  );
  return { hour: part("hour"), minute: part("minute"), second: part("second") };
}

function buildAutomaticActionKey(
  accountId: string,
  ruleVersion: string,
  candidate: AutomationCandidate,
): string {
  return createHash("sha256").update(JSON.stringify({
    accountId,
    ruleVersion,
    thresholdCode: candidate.thresholdCode,
    thresholdId: candidate.thresholdId,
    entityType: candidate.entity.entityType,
    externalId: candidate.entity.externalId,
    action: candidate.action,
    metric: candidate.metric,
    metricValue: candidate.metricValue,
    operator: candidate.operator,
    thresholdValue: candidate.thresholdValue,
    metrics: candidate.entity.metrics,
  })).digest("hex");
}

function connectionUnavailableMessage(
  accountName: string,
  providerKind: "cookie" | "official-api",
  status: string | undefined,
): string {
  const providerLabel = providerKind === "cookie" ? "Cookie 接入" : "API 接入";
  const stateLabel =
    status === "not-configured"
      ? "尚未接入"
      : status === "untested"
        ? "等待后台检测"
        : status === "failed"
          ? providerKind === "cookie"
            ? "Cookie 已失效或连接异常"
            : "API 连接异常"
          : "未通过连接检测";
  return `账户「${accountName}」当前${providerLabel}状态：${stateLabel}。请到「用户管理」查看接入状态后再运行。`;
}
