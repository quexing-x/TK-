import {
  ProviderCredentialInputSchema,
  evaluateAutomation,
  type AutomationCandidate,
  type AutomationDecisionRecord,
  type AutomationRunRecord,
  type AutomationTrigger,
  type SyncEntityType,
} from "@tk-auto/core";
import type { CredentialVault } from "@tk-auto/credentials";
import {
  ProviderRegistry,
  type ProviderContext,
  type StatusMutationResult,
} from "@tk-auto/providers";
import { AutomationStore } from "@tk-auto/storage";

export class AutomationBusyError extends Error {}

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
    if (this.runningAccounts.has(accountId)) {
      throw new AutomationBusyError("该账户已有检测任务正在运行。");
    }
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("账号不存在。");
    if (!account.enabled) throw new Error("账户已停用，自动化不会运行。");

    this.runningAccounts.add(accountId);
    const executionMode = trigger === "preview" ? "observe" : account.executionMode;
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
        throw new Error("当前 Provider 尚未通过连接检测。");
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
      this.store.saveReadOnlySync(
        accountId,
        account.providerKind,
        output.entities,
        output.result,
      );

      const evaluation = evaluateAutomation(
        output.entities,
        this.store.listThresholds(accountId),
        this.store.getAutomationSwitches(accountId),
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

      const selected = eligible.slice(0, account.maxActionsPerRun);
      for (const candidate of eligible.slice(account.maxActionsPerRun)) {
        this.store.saveAutomationDecision(
          run,
          candidate,
          "skipped",
          `超过单轮最大操作数 ${account.maxActionsPerRun}。`,
        );
      }

      let successCount = 0;
      let failureCount = 0;
      let actionCount = 0;
      if (executionMode === "observe") {
        for (const candidate of selected) {
          this.store.saveAutomationDecision(run, candidate, "preview");
        }
      } else if (executionMode === "manual-approval") {
        for (const candidate of selected) {
          this.store.saveAutomationDecision(run, candidate, "pending");
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
          const result = await this.executeCandidate(context, candidate);
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

  async approveDecision(decisionId: string): Promise<AutomationDecisionRecord> {
    const decision = this.store.getAutomationDecision(decisionId);
    if (!decision) throw new Error("自动化决策不存在。");
    if (decision.status !== "pending") {
      throw new Error("只有等待确认的决策可以执行。");
    }
    const account = this.store.getAccount(decision.accountId);
    if (!account?.enabled) throw new Error("账户已停用，无法执行决策。");
    const switches = this.store.getAutomationSwitches(decision.accountId);
    if (!switches[levelSwitch(decision.entityType)]) {
      throw new Error("对应层级的状态管理能力未开启。");
    }
    if (
      decision.action === "enable" &&
      !this.store.wasDisabledByAutomation(
        decision.accountId,
        decision.entityType,
        decision.externalId,
      )
    ) {
      throw new Error("安全保护：只能自动恢复曾由本工具关闭的对象。");
    }
    const context = await this.loadContext(
      decision.accountId,
      decision.providerKind,
      account.timezone,
    );
    const result = await this.providers.changeStatus(
      decision.providerKind,
      context,
      [
        {
          entityType: decision.entityType,
          externalId: decision.externalId,
          action: decision.action,
        },
      ],
    );
    const first = result[0];
    return this.store.updateAutomationDecision(
      decision.id,
      first?.ok ? "succeeded" : "failed",
      first?.ok ? null : (first?.message ?? "Provider 未返回执行结果。"),
    );
  }

  private getSkipReason(
    accountId: string,
    candidate: AutomationCandidate,
  ): string | null {
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
      this.store.hasPendingDecision(
        accountId,
        candidate.thresholdId,
        candidate.entity.entityType,
        candidate.entity.externalId,
        candidate.action,
      )
    ) {
      return "已有相同决策等待人工确认。";
    }
    if (
      candidate.action === "enable" &&
      !this.store.wasDisabledByAutomation(
        accountId,
        candidate.entity.entityType,
        candidate.entity.externalId,
      )
    ) {
      return "安全保护：只能自动恢复曾由本工具关闭的对象。";
    }
    return null;
  }

  private async executeCandidate(
    context: ProviderContext,
    candidate: AutomationCandidate,
  ): Promise<StatusMutationResult> {
    const results = await this.providers.changeStatus(
      context.settings.kind,
      context,
      [
        {
          entityType: candidate.entity.entityType,
          externalId: candidate.entity.externalId,
          action: candidate.action,
        },
      ],
    );
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

export class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly store: AutomationStore,
    private readonly service: AutomationService,
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
      for (const account of this.store.listAccounts()) {
        if (!account.enabled) continue;
        const latest = this.store.listAutomationRuns(account.id, 1)[0];
        const dueAt = latest
          ? new Date(latest.startedAt).getTime() +
            account.pollingIntervalMinutes * 60_000
          : 0;
        if (Date.now() < dueAt) continue;
        await this.service.runAccount(account.id, "scheduler");
      }
    } finally {
      this.ticking = false;
    }
  }
}

function levelSwitch(
  entityType: SyncEntityType,
): "manageCampaignStatus" | "manageAdGroupStatus" | "manageAdStatus" {
  if (entityType === "campaign") return "manageCampaignStatus";
  if (entityType === "ad-group") return "manageAdGroupStatus";
  return "manageAdStatus";
}

function safeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "自动化任务失败。";
}
