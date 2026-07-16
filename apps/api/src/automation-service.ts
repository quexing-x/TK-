import {
  ProviderCredentialInputSchema,
  automationRuleDefinitions,
  evaluateRuleConfiguration,
  filterEntitiesToRecentCampaigns,
  type AutomationCandidate,
  type AutomationRunRecord,
  type AutomationTrigger,
  type ManualStatusInput,
  type PollCycleRecord,
} from "@tk-auto/core";
import type { CredentialVault } from "@tk-auto/credentials";
import {
  ProviderRegistry,
  type ProviderContext,
  type StatusMutation,
  type StatusMutationResult,
} from "@tk-auto/providers";
import { AutomationStore } from "@tk-auto/storage";

export class AutomationBusyError extends Error {}

export interface PollNotificationDispatcher {
  flushPending(): Promise<void>;
  enqueueAndDispatch(cycle: PollCycleRecord): Promise<void>;
}

export class AutomationService {
  private readonly runningAccounts = new Set<string>();

  constructor(
    private readonly store: AutomationStore,
    private readonly vault: CredentialVault,
    private readonly providers: ProviderRegistry,
  ) {}

  async runAccount(
    accountId: string,
    trigger: AutomationTrigger,
  ): Promise<AutomationRunRecord> {
    if (!this.store.getSystemRuntimeState().enabled) {
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
    const executionMode = trigger === "preview" ? "observe" : "automatic";
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
      const context = await this.loadContext(
        accountId,
        account.providerKind,
        account.timezone,
      );
      const output = await this.providers.syncReadOnly(
        account.providerKind,
        context,
      );
      const ruleConfiguration = this.store.getRuleConfiguration();
      const recent = filterEntitiesToRecentCampaigns(
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
                `已排除 ${recent.excludedCount} 个不属于最近 ${ruleConfiguration.lookbackHours} 小时推广系列的对象。`,
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
        recent.entities,
        ruleConfiguration,
      );
      const eligible: AutomationCandidate[] = [];
      for (const candidate of evaluation.candidates) {
        const skipReason = this.getSkipReason(accountId, candidate);
        if (skipReason) {
          this.store.saveAutomationDecision(run, candidate, "skipped", skipReason);
        } else {
          eligible.push(candidate);
        }
      }

      const { maxActionsPerRun } = this.store.getGlobalAutomationSettings();
      const orderedEligible = eligible.sort(compareAutomationCandidates);
      const cappedCandidates = orderedEligible.slice(0, maxActionsPerRun);
      const closingAdGroups = new Set(
        cappedCandidates
          .filter(
            (candidate) =>
              candidate.action === "disable" &&
              candidate.entity.entityType === "ad-group",
          )
          .map((candidate) => candidate.entity.externalId),
      );
      const selected: AutomationCandidate[] = [];
      for (const candidate of cappedCandidates) {
        if (
          candidate.action === "enable" &&
          candidate.entity.entityType === "ad" &&
          candidate.entity.parentAdGroupId &&
          closingAdGroups.has(candidate.entity.parentAdGroupId)
        ) {
          this.store.saveAutomationDecision(
            run,
            candidate,
            "skipped",
            "父广告组将在本轮关闭，不执行子广告开启。",
          );
        } else {
          selected.push(candidate);
        }
      }
      for (const candidate of orderedEligible.slice(maxActionsPerRun)) {
        this.store.saveAutomationDecision(
          run,
          candidate,
          "skipped",
          `超过全局单轮最大操作数 ${maxActionsPerRun}。`,
        );
      }

      let successCount = 0;
      let failureCount = 0;
      let actionCount = 0;
      if (executionMode === "observe") {
        for (const candidate of selected) {
          this.store.saveAutomationDecision(run, candidate, "preview");
        }
      } else {
        let consecutiveFailures = 0;
        for (const candidate of selected) {
          const decision = this.store.saveAutomationDecision(
            run,
            candidate,
            "pending",
          );
          actionCount += 1;
          let result: StatusMutationResult;
          try {
            result = await this.executeCandidate(context, candidate);
          } catch (cause) {
            result = {
              entityType: candidate.entity.entityType,
              externalId: candidate.entity.externalId,
              action: candidate.action,
              ok: false,
              message: safeMessage(cause),
            };
          }
          if (result.ok) {
            successCount += 1;
            consecutiveFailures = 0;
            this.store.updateAutomationDecision(decision.id, "succeeded");
          } else {
            failureCount += 1;
            consecutiveFailures += 1;
            this.store.updateAutomationDecision(
              decision.id,
              "failed",
              result.message,
            );
          }
          this.store.recordAdOperation({
            accountId,
            providerKind: account.providerKind,
            entityType: candidate.entity.entityType,
            externalId: candidate.entity.externalId,
            entityName: candidate.entity.name,
            action: candidate.action,
            source: "automation",
            status: result.ok ? "succeeded" : "failed",
            message: result.message,
          });
          if (consecutiveFailures >= 3) {
            for (const remaining of selected.slice(actionCount)) {
              this.store.saveAutomationDecision(
                run,
                remaining,
                "skipped",
                "连续 3 次写入失败，本轮已熔断。",
              );
            }
            break;
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
    }
  }

  async changeStatusManually(
    accountId: string,
    input: ManualStatusInput,
  ): Promise<StatusMutationResult> {
    if (this.runningAccounts.has(accountId)) {
      throw new AutomationBusyError("该账户已有任务正在执行，请稍后重试。");
    }
    this.runningAccounts.add(accountId);
    try {
      return await this.changeStatus(accountId, input, "manual");
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
    this.runningAccounts.add(accountId);
    try {
      for (const schedule of this.store.listDueScheduledActions(accountId, asOf)) {
        try {
          const result = await this.changeStatus(
            accountId,
            {
              entityType: "ad-group",
              externalId: schedule.externalId,
              action: schedule.action,
            },
            "scheduled",
          );
          this.store.completeScheduledAction(
            schedule.id,
            result.ok ? "succeeded" : "failed",
            result.message,
            asOf,
          );
        } catch (cause) {
          this.store.completeScheduledAction(
            schedule.id,
            "failed",
            safeMessage(cause),
            asOf,
          );
        }
      }
    } finally {
      this.runningAccounts.delete(accountId);
    }
  }

  private async changeStatus(
    accountId: string,
    input: ManualStatusInput,
    source: "manual" | "scheduled",
  ): Promise<StatusMutationResult> {
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
    const results = await this.changeProviderStatus(
      context,
      [input],
      source === "scheduled",
    );
    const result =
      results[0] ?? { ...input, ok: false, message: "Provider 未返回执行结果。" };
    const entity = this.store
      .listManagedEntities(accountId, account.providerKind)
      .find(
        (item) =>
          item.entityType === input.entityType &&
          item.externalId === input.externalId,
      );
    this.store.recordAdOperation({
      accountId,
      providerKind: account.providerKind,
      entityType: input.entityType,
      externalId: input.externalId,
      entityName: entity?.name ?? input.externalId,
      action: input.action,
      source,
      status: result.ok ? "succeeded" : "failed",
      message: result.message,
    });
    if (result.ok) {
      try {
        const refreshed = await this.providers.syncReadOnly(
          account.providerKind,
          context,
        );
        this.store.saveReadOnlySync(
          accountId,
          account.providerKind,
          refreshed.entities,
          refreshed.result,
        );
      } catch {
        // The write was accepted; a later scheduler cycle will retry the readback.
      }
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
    if (
      candidate.action === "enable" &&
      candidate.entity.entityType === "ad" &&
      candidate.entity.parentAdGroupId
    ) {
      const parent = this.store
        .listManagedEntities(accountId, providerKind ?? "cookie")
        .find(
          (entity) =>
            entity.entityType === "ad-group" &&
            entity.externalId === candidate.entity.parentAdGroupId,
        );
      if (parent?.status === "disabled") {
        return "父广告组处于关闭状态，不执行子广告开启。";
      }
    }
    return null;
  }

  private async executeCandidate(
    context: ProviderContext,
    candidate: AutomationCandidate,
  ): Promise<StatusMutationResult> {
    const results = await this.changeProviderStatus(context, [
      {
        entityType: candidate.entity.entityType,
        externalId: candidate.entity.externalId,
        action: candidate.action,
      },
    ], true);
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
    requireAccountEnabled = false,
  ): Promise<StatusMutationResult[]> {
    this.assertWriteAllowed(context.accountId, requireAccountEnabled);
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
      return results;
    } catch (cause) {
      this.markProviderWriteFailure(context, safeMessage(cause));
      throw cause;
    }
  }

  private assertWriteAllowed(
    accountId: string,
    requireAccountEnabled: boolean,
  ): void {
    if (!this.store.getSystemRuntimeState().enabled) {
      throw new Error("软件总开关已关闭，真实广告写入已暂停。");
    }
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("账号不存在。");
    if (requireAccountEnabled && !account.enabled) {
      throw new Error("账户自动化已关闭，真实广告写入已暂停。");
    }
  }

  private markProviderWriteFailure(
    context: ProviderContext,
    message: string,
  ): void {
    this.store.updateProviderStatus(
      context.accountId,
      context.settings.kind,
      "failed",
      `真实启停失败：${message}`,
    );
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
  return (
    layerOrder[left.entity.entityType] - layerOrder[right.entity.entityType]
  );
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
