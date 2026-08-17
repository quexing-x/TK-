import { createHash, randomUUID } from "node:crypto";
import {
  AUTOMATION_MANAGED_LOOKBACK_HOURS,
  ProviderCredentialInputSchema,
  automationRuleDefinitions,
  dateTimeSuffix,
  buildMetaRulePredicate,
  evaluateMetaRuleConfiguration,
  evaluateRuleConfiguration,
  filterEntitiesToRecentWindow,
  MetaAccessSecretBundleInputSchema,
  stripAutomaticAdGroupNameSuffixes,
  type AutomationCandidate,
  type AutomationRunRecord,
  type AutomationTrigger,
  type ManualStatusInput,
  type MetaRuleConfiguration,
  type ManagedEntityRecord,
  type PollCycleRecord,
  type RuleConfiguration,
  type AdOperationRecord,
  type SyncDataQuality,
  type SyncEntityType,
  type ProviderKind,
  type WriteTaskActor,
  normalizeProviderEntity,
  syncLayerComplete,
  creativeNeedsAppeal,
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
const destructiveSyncFreshnessMs = 5 * 60 * 1000;
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
    private readonly autoCopyRunner?: (input: {
      accountId: string;
      sourceCampaignId: string;
      sourceCampaignName: string;
      sourceAdGroupId?: string | undefined;
      baseAdGroupName: string;
      count: number;
      dailyBudget: number;
      bid: number | null;
      launchImmediately: boolean;
      sameCampaign?: boolean | undefined;
      onBeforeDispatch?: () => void;
    }) => Promise<Array<{
      ok: boolean;
      adGroupId?: string;
      adGroupIds?: string[];
      failureKind?: "failed" | "unknown";
      retrySafe?: boolean;
    }>>,
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
    for (const task of this.store.listPendingManualStatusWriteTasks()) {
      this.queuePersistedManualStatusTask(task);
    }
  }

  getProviderWriteCircuitState(accountId: string) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("账号不存在。");
    const localDate = dateKeyInTimeZone(new Date(), account.timezone);
    return {
      todayUsage: this.store.countAutomaticActions(accountId, localDate),
      circuit: this.store.getProviderWriteCircuit(accountId, account.providerKind),
    };
  }

  resetProviderWriteCircuit(accountId: string) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("账号不存在。");
    this.store.resetProviderWriteFailures(accountId, account.providerKind);
    return this.getProviderWriteCircuitState(accountId);
  }

  async runScheduledAppeals(accountId: string, asOf = new Date()): Promise<void> {
    const account = this.store.getAccount(accountId);
    const settings = this.store.getAutomationFeatureSettings().appeal;
    if (
      !account
      || !account.enabled
      || !this.store.getSystemRuntimeState().enabled
      || !settings.enabled
    ) return;
    const local = timePartsInTimeZone(asOf, account.timezone);
    if (local.minute !== 0 || !settings.scheduleHours.includes(local.hour)) return;
    const connection = this.store.getProviderConnection(accountId, account.providerKind);
    if (!connection || connection.status !== "ready") return;
    try {
      this.providers.requireAccountCapability(
        accountId,
        account.providerKind,
        connection,
        "appeal-ads",
      );
    } catch {
      return;
    }
    const context = await this.loadContext(accountId, account.providerKind, account.timezone);
    const provider = this.providers.get(account.providerKind);
    if (!provider.appeal || !provider.resolveCapabilities?.(context).has("appeal-ads")) return;
    for (const entity of this.store.listCurrentProviderEntities(accountId, account.providerKind)) {
      if (entity.entityType !== "ad") continue;
      const payload = entity.payload as Record<string, unknown>;
      if (!creativeNeedsAppeal(payload)) continue;
      const creativeId = String(payload.creative_id ?? "");
      // 申诉报文里的 ad_id 是广告组，creative_id 才是广告自己；两者在广告实体上
      // 是不同字段，取错会被 TikTok 拒。
      const adGroupId = String(payload.adgroup_id ?? payload.ad_id ?? "");
      if (!creativeId || !adGroupId) continue;
      const execution = this.store.getAppealExecutionState(accountId, entity.externalId);
      if (execution.blocked || execution.confirmedFailureCount > settings.retryLimit) continue;
      const reason = renderAppealTemplate(settings.textTemplate, {
        adName: String(payload.ad_name ?? payload.name ?? entity.externalId),
        adId: entity.externalId,
        rejectReason: String(payload.reject_reason ?? payload.audit_reject_reason ?? "未提供"),
      });
      const task = this.store.queueAppeal(accountId, account.providerKind, entity.externalId, reason, "automation");
      try {
        const [result] = await provider.appeal(context, [{ externalId: entity.externalId, creativeId, adGroupId, reason }]);
        const outcome = result?.ok
          ? "succeeded" as const
          : result?.failureKind === "unknown"
            ? "unknown" as const
            : "failed" as const;
        this.store.completeAppeal(task.id, outcome, result?.message ?? "申诉未获确认");
      } catch (cause) { this.store.completeAppeal(task.id, "unknown", safeMessage(cause)); }
    }
  }

  async runScheduledDeletions(accountId: string, asOf = new Date()): Promise<void> {
    const settings = this.store.getAutomationFeatureSettings().deletion;
    const account = this.store.getAccount(accountId);
    if (
      !settings.enabled
      || !settings.onlyDisabled
      || !account?.enabled
      || !this.store.getSystemRuntimeState().enabled
    ) return;
    const localTime = timePartsInTimeZone(asOf, account.timezone);
    // 整个计划小时内都可触发，不锁死在第 0 分钟：调度器 30 秒一跳，而本执行器还要
    // 过「同步年龄 ≤ 5 分钟」这道门，一分钟窗口顶多给两次机会；真删起来一个账户几十
    // 个组要跑上一分钟以上，后面的账户必然错过整点那一分钟。改成整小时后由
    // claimDailyAutomationRun 保证每账户每个本地日仍然只跑一次。
    if (localTime.hour !== settings.scheduleHour) return;
    const localDate = dateKeyInTimeZone(asOf, account.timezone);
    const connection = this.store.getProviderConnection(accountId, account.providerKind);
    const latestSync = this.store.getLatestReadOnlySync(accountId, account.providerKind);
    const syncAge = latestSync
      ? asOf.getTime() - new Date(latestSync.finishedAt).getTime()
      : Number.POSITIVE_INFINITY;
    if (
      connection?.status !== "ready"
      // 删除是广告组层面的操作，只需要广告组与其所属系列的数据取全。广告层的派生
      // 请求在 TikTok 侧慢且不稳，让它连坐会白白跳过一整轮。注意这里能放心用
      // latestSync.finishedAt 量新鲜度，是因为 saveReadOnlySync 现在也会刷新
      // partial 同步里取全的层级——快照确实是这一刻的，不是上一次 healthy 的。
      || !syncLayerComplete(latestSync?.quality, "ad-group")
      || !syncLayerComplete(latestSync?.quality, "campaign")
      || !hasCurrentDayMetricCoverage(latestSync, localDate, account.timezone)
      || syncAge < 0
      || syncAge > destructiveSyncFreshnessMs
    ) return;
    try {
      this.providers.requireAccountCapability(
        accountId,
        account.providerKind,
        connection,
        "delete-ad-groups",
      );
    } catch {
      return;
    }
    const context = await this.loadContext(accountId, account.providerKind, account.timezone);
    const provider = this.providers.get(account.providerKind);
    if (
      !provider.deleteAdGroups
      || !provider.resolveCapabilities?.(context).has("delete-ad-groups")
    ) return;
    if (this.store.claimDailyAutomationRun(
      accountId,
      "delete-ad-groups",
      localDate,
    ) !== "claimed") return;
    const disabledBefore = new Date(
      asOf.getTime() - settings.gracePeriodHours * 60 * 60 * 1000,
    ).toISOString();
    try {
      const currentGroups = this.store
        .listCurrentManagedEntities(accountId, account.providerKind)
        .filter((entity) => entity.entityType === "ad-group" && entity.parentCampaignId);
      const currentCountByCampaign = new Map<string, number>();
      for (const entity of currentGroups) {
        currentCountByCampaign.set(
          entity.parentCampaignId!,
          (currentCountByCampaign.get(entity.parentCampaignId!) ?? 0) + 1,
        );
      }
      const candidatesByCampaign = new Map<string, ReturnType<typeof normalizeProviderEntity>[]>();
      for (const providerEntity of this.store.listDeletionReadyAdGroups(
        accountId,
        account.providerKind,
        disabledBefore,
      )) {
        const entity = normalizeProviderEntity(providerEntity);
        const conversions = entity.metrics.conversions;
        const carts = entity.metrics.carts;
        if (
          entity.status !== "disabled"
          || !entity.parentCampaignId
          || conversions === null
          || carts === null
          || conversions > settings.maxConversions
          || carts > settings.maxCarts
          || (conversions > 0
            && (entity.metrics.cost_per_conversion === null
              || entity.metrics.cost_per_conversion < settings.minCpa))
        ) continue;
        const list = candidatesByCampaign.get(entity.parentCampaignId) ?? [];
        list.push(entity);
        candidatesByCampaign.set(entity.parentCampaignId, list);
      }

      const candidates = [...candidatesByCampaign.entries()].flatMap(
        ([campaignId, entries]) => {
          const maximumDeletions = Math.max(
            0,
            (currentCountByCampaign.get(campaignId) ?? 0) - 1,
          );
          return entries
            .sort(compareDeletionPriority)
            .slice(0, maximumDeletions);
        },
      );
      for (const entity of candidates) {
        const task = this.store.queueAdGroupDeletionIfAbsent(
          accountId,
          account.providerKind,
          entity.externalId,
        );
        if (!task) continue;
        try {
          const [result] = await this.providers.deleteAdGroups(
            account.providerKind,
            context,
            [{ externalId: entity.externalId }],
          );
          if (result?.ok) {
            this.store.completeAdGroupDeletion(task.id, "succeeded", result.message);
          } else if (result?.failureKind === "unknown") {
            this.store.completeAdGroupDeletion(
              task.id,
              "unknown",
              result.message || "删除请求已发送，但结果无法确认。",
            );
          } else {
            this.store.completeAdGroupDeletion(
              task.id,
              "failed",
              result?.message || "TikTok 已明确拒绝删除广告组。",
            );
          }
        } catch (cause) {
          this.store.completeAdGroupDeletion(
            task.id,
            "unknown",
            `删除请求结果无法确认：${safeMessage(cause)}`,
          );
        }
      }
    } finally {
      this.store.finishDailyAutomationRun(accountId, "delete-ad-groups", localDate);
    }
  }

  async runScheduledAutoCopies(accountId: string, asOf = new Date()): Promise<void> {
    const account = this.store.getAccount(accountId);
    const copy = this.store.getAutomationFeatureSettings().copy;
    if (
      !this.autoCopyRunner
      || !copy.autoCopyEnabled
      || !account?.enabled
      || !this.store.getSystemRuntimeState().enabled
    ) return;
    const localTime = timePartsInTimeZone(asOf, account.timezone);
    if (localTime.hour >= 12) return;
    const localDate = dateKeyInTimeZone(asOf, account.timezone);
    const connection = this.store.getProviderConnection(accountId, account.providerKind);
    const latestSync = this.store.getLatestReadOnlySync(accountId, account.providerKind);
    const syncAge = latestSync
      ? asOf.getTime() - new Date(latestSync.finishedAt).getTime()
      : Number.POSITIVE_INFINITY;
    if (
      connection?.status !== "ready"
      // 同删除：自动复制的判据全部来自广告组层，不因广告层拉不到而跳过整轮。
      || !syncLayerComplete(latestSync?.quality, "ad-group")
      || !syncLayerComplete(latestSync?.quality, "campaign")
      || !hasCurrentDayMetricCoverage(latestSync, localDate, account.timezone)
      || syncAge < 0
      || syncAge > destructiveSyncFreshnessMs
    ) return;
    try {
      this.providers.requireAccountCapability(
        accountId,
        account.providerKind,
        connection,
        "copy-ads",
      );
    } catch {
      return;
    }

    const entities = this.store.listCurrentManagedEntities(accountId, account.providerKind);
    const campaignNames = new Map(
      entities
        .filter((entity) => entity.entityType === "campaign")
        .map((entity) => [entity.externalId, entity.name]),
    );
    // 复制出来的组永远不再当复制源：账户级全量排除，不限于同一个系列，也不放过
    // 标记为失败但可能已部分创建的任务。否则一个跑得好的组会每天派生新组、新组
    // 次日又符合阈值继续派生，账户被指数级铺满。
    const generated = this.store.listAutomaticCopyGeneratedRefs(accountId);
    const candidates = entities
      .filter((entity) => {
        if (
          entity.entityType !== "ad-group"
          || entity.ignored
          || entity.status !== "enabled"
          || !entity.parentCampaignId
          // 系列预算(CBO)不参与自动复制：往同一 CBO 系列里加组不增加任何预算，
          // 只会把系列预算摊薄到更多组上，与放量的目的相反。CBO 的放量路径是
          // 系列级复制，且只允许人工发起。
          || entity.campaignBudgetOptimized
          || entity.metrics.conversions === null
          || entity.metrics.cost_per_conversion === null
          || entity.metrics.cost_per_click === null
        ) return false;
        if (generated.ids.has(entity.externalId) || generated.names.has(entity.name)) return false;
        return entity.metrics.conversions >= copy.autoCopyMinConversions
          && entity.metrics.cost_per_conversion <= copy.autoCopyMaxCpa
          && entity.metrics.cost_per_click <= copy.autoCopyMaxCpc;
      })
      .sort((left, right) =>
        (right.metrics.conversions ?? 0) - (left.metrics.conversions ?? 0)
        || (left.metrics.cost_per_conversion ?? Number.POSITIVE_INFINITY)
          - (right.metrics.cost_per_conversion ?? Number.POSITIVE_INFINITY)
        || (left.metrics.cost_per_click ?? Number.POSITIVE_INFINITY)
          - (right.metrics.cost_per_click ?? Number.POSITIVE_INFINITY)
        || left.externalId.localeCompare(right.externalId));

    for (const entity of candidates) {
      const sourceCampaignId = entity.parentCampaignId!;
      // 与系列复制、扩组统一：{清洗后源名}-{投放日期}-{时间}。自动复制没有排期，
      // 投放时刻即本轮执行时刻。源名先清洗掉历史自动后缀，避免层层累积。
      const baseAdGroupName = `${stripAutomaticAdGroupNameSuffixes(entity.name)}-${
        dateTimeSuffix(asOf, account.timezone)
      }`;
      const generatedNames = Array.from(
        { length: copy.autoCopyCount },
        (_unused, index) => `${baseAdGroupName}-${index + 1}`,
      );
      // 任务键不含日期：同一个源广告组只自动复制一次，不是每天一次。
      const taskKey = createHash("sha256").update(JSON.stringify({
        executor: "scheduled-auto-copy",
        accountId,
        sourceAdGroupId: entity.externalId,
      })).digest("hex");
      const claim = this.store.claimAutomaticCopyTask({
        taskKey,
        accountId,
        sourceCampaignId,
        sourceAdGroupId: entity.externalId,
        localDate,
        requestedCount: copy.autoCopyCount,
        generatedNames,
        dailyLimit: 20,
      });
      if (claim !== "claimed") continue;

      let dispatched = false;
      try {
        const results = await this.autoCopyRunner({
          accountId,
          sourceCampaignId,
          sourceCampaignName: campaignNames.get(sourceCampaignId) ?? sourceCampaignId,
          sourceAdGroupId: entity.externalId,
          baseAdGroupName,
          count: copy.autoCopyCount,
          dailyBudget: copy.autoCopyBudget ?? entity.metrics.budget ?? 50,
          bid: copy.autoCopyBid,
          launchImmediately: true,
          sameCampaign: true,
          onBeforeDispatch: () => {
            dispatched = true;
            this.store.markAutomaticCopyTaskDispatching(taskKey);
          },
        });
        const succeeded = results.length > 0 && results.every((result) => result.ok);
        const partialSuccess = results.some((result) => result.ok)
          && results.some((result) => !result.ok);
        const unknown = partialSuccess || results.some(
          (result) => !result.ok
            && (result.failureKind === "unknown" || result.retrySafe === false),
        );
        const generatedIds = results.flatMap((result) => [
          ...(result.adGroupIds ?? []),
          ...(result.adGroupId ? [result.adGroupId] : []),
        ]);
        this.store.finishAutomaticCopyTask(
          taskKey,
          succeeded ? "succeeded" : unknown ? "unknown" : "failed",
          generatedIds,
        );
      } catch {
        this.store.finishAutomaticCopyTask(taskKey, dispatched ? "unknown" : "failed");
      }
    }
  }

  async runAccount(
    accountId: string,
    trigger: AutomationTrigger,
  ): Promise<AutomationRunRecord> {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("账号不存在。");
    if (account.platform === "meta" && account.providerKind !== "meta-marketing-api") {
      throw new Error("Meta 离线账户不能进入规则引擎。");
    }
    const systemRuntimeEnabled = this.store.getSystemRuntimeState().enabled;
    const platformRuntimeEnabled = account.platform === "meta"
      ? this.store.getMetaAutomationRuntime().enabled
      : true;
    if (trigger !== "preview" && !systemRuntimeEnabled) {
      throw new Error("全局自动化已关闭，总开关关闭时检测和执行均已暂停。");
    }
    if (trigger !== "preview" && !platformRuntimeEnabled) {
      throw new Error(account.platform === "meta"
        ? "Meta 自动化总开关已关闭，检测和执行均已暂停。"
        : "全局自动化已关闭，自动化检测和执行均已暂停。");
    }
    if (this.runningAccounts.has(accountId)) {
      throw new AutomationBusyError("该账户已有检测任务正在运行。");
    }
    if (trigger !== "preview" && !account.enabled) {
      throw new Error("账户自动化已关闭，不能执行真实启停。");
    }

    this.runningAccounts.add(accountId);
    const writeCircuit = this.store.getProviderWriteCircuit(accountId, account.providerKind);
    // 自动执行的唯一授权链：非预览 + 平台独立运行开关 + 账户开启 + Provider 写入保护未触发。
    // 广告创建和人工启停不使用这条授权链。
    const automaticRun =
      trigger !== "preview" &&
      account.enabled &&
      !writeCircuit?.openedAt;
    const run = this.store.createAutomationRun(
      accountId,
      account.providerKind,
      trigger,
      automaticRun,
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
      if (automaticRun) {
        this.providers.requireAccountCapability(
          accountId,
          account.providerKind,
          connection,
          "change-status",
        );
        if (
          account.platform === "meta"
          && (
            connection.settings.kind !== "meta-marketing-api"
            || connection.settings.liveMode !== "automation-status"
          )
        ) {
          throw new Error("Meta 自动启停必须在该账户显式开启 automation-status 模式。");
        }
      }
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
        throw cause;
      }
      const metaRuleConfiguration = account.platform === "meta"
        ? this.store.getMetaRuleConfiguration()
        : null;
      const ruleConfiguration = account.platform === "tiktok"
        ? this.store.getRuleConfiguration()
        : null;
      const ruleVersion = metaRuleConfiguration?.updatedAt
        ?? ruleConfiguration?.updatedAt;
      if (!ruleVersion) throw new Error("平台规则配置缺失。");
      const dataQualityWarnings = [
        ...output.result.warnings,
        ...output.result.quality.partialFailures,
        ...output.result.quality.missingMetrics.map((metric) => `缺少指标 ${metric}`),
      ];
      const suggestionMetadata = {
        ruleVersion,
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
          rulePredicate: metaRuleConfiguration
            ? buildMetaDecisionPredicate(metaRuleConfiguration, candidate)
            : buildRulePredicate(ruleConfiguration!, candidate),
        },
      );
      // 持久管辖集：自动化自己关停、尚未被自动重开的广告组。即便当天消耗归零，也留在
      // 评估范围里，让归因延迟、关停之后才回传的转化仍能触发开启规则把它开回来——
      // 只按当天 spend>0 判存活会在过零点后把这类组踢出、跨天再也开不回来。
      const evaluation = metaRuleConfiguration
        ? evaluateMetaRuleConfiguration(
            output.result.quality.status === "invalid" ? [] : output.entities,
            metaRuleConfiguration,
          )
        : (() => {
            const managedSince = new Date(
              Date.now() - AUTOMATION_MANAGED_LOOKBACK_HOURS * 60 * 60_000,
            ).toISOString();
            const managedAdGroupIds = new Set(
              this.store.listAutomationDisabledAdGroupIds(accountId, managedSince),
            );
            const recent = filterEntitiesToRecentWindow(
              output.entities,
              new Date(),
              ruleConfiguration!.lookbackHours,
              managedAdGroupIds,
            );
            return evaluateRuleConfiguration(
              output.result.quality.status === "invalid" ? [] : recent.entities,
              ruleConfiguration!,
            );
          })();
      this.store.saveReadOnlySync(
        accountId,
        account.providerKind,
        output.entities,
        output.result,
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

      // partial 不是整账户一刀切：素材列表按广告逐个请求，只有失败广告及其所属
      // 广告组本轮不具备安全写入条件；其余已取全的层级继续走自动执行。
      const qualityEligible: AutomationCandidate[] = [];
      for (const candidate of eligible) {
        const qualityBlock = automaticRun
          ? this.getAutomaticDataQualityBlockReason(
              accountId,
              account.providerKind,
              output.result.quality,
              candidate.entity,
            )
          : null;
        if (qualityBlock) {
          saveSuggestion(candidate, "skipped", qualityBlock);
        } else {
          qualityEligible.push(candidate);
        }
      }

      const { maxActionsPerRun } = account.platform === "meta"
        ? this.store.getMetaAutomationRuntime()
        : this.store.getGlobalAutomationSettings();
      const orderedEligible = qualityEligible.sort(compareAutomationCandidates);
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
        // 广告与素材都是广告组的子级：同一轮里父广告组正被关，就别开它的子级。
        // 只写 "ad" 会漏掉素材，造出「组开着、素材全关」且界面看不出来的状态。
        const blockedByAdGroup =
          candidate.action === "enable" &&
          (candidate.entity.entityType === "ad" ||
            candidate.entity.entityType === "material") &&
          candidate.entity.parentAdGroupId !== null &&
          closingAdGroups.has(candidate.entity.parentAdGroupId);
        if (blockedByCampaign || blockedByAdGroup) {
          saveSuggestion(
            candidate,
            "skipped",
            blockedByCampaign
              ? "父推广系列建议关闭，本轮不建议开启子对象。"
              : "父广告组建议关闭，本轮不建议开启子级。",
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
      if (!automaticRun) {
        for (const candidate of selected) saveSuggestion(candidate, "preview");
      } else {
        const localDate = dateKeyInTimeZone(new Date(), account.timezone);
        const automaticTargets = new Set<string>();
        for (const candidate of selected) {
          const targetKey = `${candidate.entity.entityType}:${candidate.entity.externalId}:${candidate.action}`;
          if (automaticTargets.has(targetKey)) {
            saveSuggestion(
              candidate,
              "skipped",
              `同一对象本轮已有更高优先级的自动${candidate.action === "enable" ? "开启" : "关闭"}操作。`,
            );
            continue;
          }
          automaticTargets.add(targetKey);
          // 广告总开关常开，规则不得关它。程序化创意下一个广告组只有 1 个广告、
          // 内含多个素材，关掉广告总开关等同于关掉整组；更糟的是它会造出「广告组
          // 开着、广告关着」——人工把广告组开回来也投不出去，而且界面上看不出来。
          // 真正该关的是广告里那一条素材（procedural_material/update_status），
          // 素材层做好之前这里一律不关。开启方向保留：它是纠正方向。
          if (
            account.platform === "tiktok"
            && candidate.entity.entityType === "ad"
            && candidate.action === "disable"
          ) {
            saveSuggestion(
              candidate,
              "skipped",
              "广告总开关保持常开：关闭它等同于关停整个广告组，且会造成广告组开着而广告关着；应改为关闭广告内的具体素材。",
            );
            continue;
          }
          const suppressed = account.platform === "tiktok"
            ? suppressedAutomationActions(new Date(), account.timezone)
            : "none";
          if (suppressed === "enable" && candidate.action === "enable") {
            saveSuggestion(
              candidate,
              "skipped",
              "过夜关停窗口（本地 23:45 至零点）内不自动开启；需要投放的由零点过夜排期统一打开。",
            );
            continue;
          }
          if (suppressed === "overnight-entities") {
            // 只保护过夜组本身及其下的广告：零点刚被排期开回来，当日数据从零
            // 开始，规则一判必关。其它对象照常。
            const overnightId = candidate.entity.entityType === "ad-group"
              ? candidate.entity.externalId
              : candidate.entity.parentAdGroupId;
            if (
              overnightId
              && this.store.hasScheduledOvernightForEntity(accountId, overnightId)
            ) {
              saveSuggestion(
                candidate,
                "skipped",
                "过夜组在本地零点至凌晨 3 点内不受规则调整：刚由排期开启，当日数据尚未积累。",
              );
              continue;
            }
          }
          const decision = saveSuggestion(candidate, "pending");
          const actionKey = buildAutomaticActionKey(
            accountId,
            suggestionMetadata.ruleVersion,
            candidate,
          );
          const reservation = this.store.reserveAutomaticAction({
            accountId,
            actionKey,
            localDate,
            // 0 = 不限每日次数；此处仅保留跨执行器幂等去重，防止并发重复启停。
            dailyLimit: 0,
          });
          if (reservation !== "claimed") {
            this.store.updateAutomationDecision(
              decision.id,
              "skipped",
              reservation === "duplicate"
                ? "相同规则输入已被其他执行器领取，本轮跳过。"
                : "已达到每日自动启停上限。",
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
                action: candidate.action,
              },
              "automation",
              { id: "automation-scheduler", name: "自动启停", kind: "system" },
              undefined,
              true,
              undefined,
              `命中「${candidate.reason.split("：", 1)[0]}」规则，自动${candidate.action === "enable" ? "开启" : "关闭"}`,
            );
            if (result.ok) {
              successCount += 1;
              if (candidate.entity.entityType === "ad-group") {
                this.store.expireAutomationDecisionsForEntity(
                  accountId,
                  candidate.entity.entityType,
                  candidate.entity.externalId,
                  decision.id,
                );
              }
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
            if (cause instanceof WriteBlockedBeforeDispatchError) {
              this.store.releaseAutomaticAction(actionKey);
            }
            this.store.updateAutomationDecision(
              decision.id,
              cause instanceof WriteBlockedBeforeDispatchError ? "failed" : "unknown",
              cause instanceof WriteBlockedBeforeDispatchError
                ? `自动启停在请求发送前被阻止：${safeMessage(cause)}`
                : `自动启停结果无法确认：${safeMessage(cause)}`,
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
      this.store.completeProviderHealthCheckIfCurrent(
        accountId,
        account.providerKind,
        connection,
        {
          connectionStatus: health.status,
          message: health.message,
          authorizationStatus: health.status === "ready" ? "active" : "failed",
          capabilityVersion: this.providers.capabilityVersion(account.providerKind),
          capabilities: health.status === "ready"
            ? this.providers.resolveAuthorizedCapabilities(account.providerKind, context)
            : [],
          expiresAt: connection.authorizationExpiresAt,
        },
      );
    } catch (cause) {
      const message = safeMessage(cause);
      if (
        connection.status === "ready"
        && connection.authorizationStatus === "active"
        && isTransientHealthCheckFailure(cause)
      ) {
        this.store.completeProviderHealthCheckIfCurrent(
          accountId,
          account.providerKind,
          connection,
          {
            connectionStatus: "ready",
            message: `连接检测暂时失败，已保留最近验证成功状态：${message}`,
            authorizationStatus: "active",
            capabilityVersion: connection.capabilityVersion,
            capabilities: connection.authorizedCapabilities,
            expiresAt: connection.authorizationExpiresAt,
          },
        );
        return;
      }
      this.store.completeProviderHealthCheckIfCurrent(
        accountId,
        account.providerKind,
        connection,
        {
          connectionStatus: "failed",
          message: account.providerKind === "cookie"
            ? `Cookie 已失效或连接异常：${message}`
            : `API 连接异常：${message}`,
          authorizationStatus: "failed",
          capabilityVersion: this.providers.capabilityVersion(account.providerKind),
          capabilities: [],
          expiresAt: connection.authorizationExpiresAt,
        },
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
    const entity = this.store.listCurrentManagedEntities(accountId, account.providerKind).find(
      (item) => item.entityType === input.entityType && item.externalId === input.externalId,
    );
    if (!entity) throw new Error("Ad object is missing or has not been synced.");
    this.assertWriteAllowed(accountId, false, input);
    if (this.store.hasBlockingStatusOperationForEntity(
      accountId,
      account.providerKind,
      input.entityType,
      input.externalId,
    )) {
      throw new Error("该对象存在结果待确认的历史启停操作；完成只读回读或人工核验前禁止再次写入。");
    }
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
      throw new Error("自动化启停为一次性执行；请重新检测生成新建议，禁止直接重试旧任务。");
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
      this.assertWriteAllowed(accountId, false, {
        entityType: task.entityType,
        externalId: task.externalId,
      });
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

  async reconcileMetaStatusOperation(
    accountId: string,
    operationId: string,
    actor: WriteTaskActor = {
      id: "meta-readback-reconcile",
      name: "Meta 只读回读核验",
      kind: "system",
    },
  ): Promise<{
    operation: AdOperationRecord;
    asset: ManagedEntityRecord | null;
    resolution: "succeeded" | "failed" | "unknown";
    message: string;
  }> {
    if (this.runningAccounts.has(accountId)) {
      throw new AutomationBusyError("该账户已有任务正在执行，请稍后再做只读回读核验。");
    }
    this.runningAccounts.add(accountId);
    try {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("账号不存在。");
    if (account.platform !== "meta" || account.providerKind !== "meta-marketing-api") {
      throw new Error("只有 Meta Marketing API 账户支持只读回读核验。");
    }
    const task = this.store.getAdOperationByOperationId(operationId);
    if (task.accountId !== accountId || task.providerKind !== account.providerKind) {
      throw new Error("状态写任务不属于当前 Meta 账户。");
    }
    if (task.status !== "unknown") {
      throw new Error("只有结果未知的 Meta 状态写任务可以执行只读回读核验。");
    }
    const connection = this.store.getProviderConnection(accountId, account.providerKind);
    if (!connection || (connection.status !== "ready" && connection.status !== "failed")) {
      throw new Error(connectionUnavailableMessage(
        account.displayName,
        account.providerKind,
        connection?.status,
      ));
    }
    if (connection.status === "ready") {
      this.providers.requireAccountCapability(
        accountId,
        account.providerKind,
        connection,
        "read-campaigns",
      );
    } else {
      const authorizationExpired = connection.authorizationExpiresAt
        ? new Date(connection.authorizationExpiresAt).getTime() <= Date.now()
        : false;
      const provider = this.providers.get(account.providerKind);
      if (
        !connection.hasCredential
        || connection.authorizationStatus !== "active"
        || authorizationExpired
        || connection.capabilityVersion !== provider.capabilityVersion
        || !provider.capabilities.has("read-campaigns")
        || !connection.authorizedCapabilities.includes("read-campaigns")
      ) {
        throw new Error("Meta 连接失败且未保留有效的只读授权，不能执行回读核验。");
      }
    }
    const context = await this.loadContext(accountId, account.providerKind, account.timezone);
    const refreshed = await this.providers.syncReadOnly(account.providerKind, context);
    this.store.saveReadOnlySync(
      accountId,
      account.providerKind,
      refreshed.entities,
      refreshed.result,
    );
    const asset = this.store.listCurrentManagedEntities(accountId, account.providerKind).find(
      (entity) => entity.entityType === task.entityType && entity.externalId === task.externalId,
    ) ?? null;
    const readbackUsable = asset !== null && this.isEntitySyncUsable(
      accountId,
      account.providerKind,
      refreshed.result.quality,
      { entityType: task.entityType, externalId: task.externalId },
    );
    if (!readbackUsable || (asset.status !== "enabled" && asset.status !== "disabled")) {
      const message = refreshed.result.warnings.length > 0
        ? `只读回读仍无法确认结果：${refreshed.result.warnings.join("；")}`
        : "只读回读仍未返回可确认的目标对象状态；任务保持 unknown，且不会自动重试。";
      return {
        operation: this.store.getAdOperation(task.id),
        asset,
        resolution: "unknown",
        message,
      };
    }
    const operation = this.store.resolveUnknownStatusWriteTaskFromReadback(
      task.id,
      asset.status,
      actor,
    );
    return {
      operation,
      asset,
      resolution: operation.status === "succeeded" ? "succeeded" : "unknown",
      message: operation.status === "succeeded"
        ? operation.message ?? "Meta 只读回读核验已完成。"
        : `只读回读当前为 ${asset.status}，但该状态可能仍处于 Meta 传播延迟；任务保持 unknown，且不会自动重试。`,
    };
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
    if (!isOvernightBlackout(now, account.timezone)) {
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

    for (const entity of this.store.listCurrentManagedEntities(accountId, account.providerKind)) {
      if (
        entity.entityType !== "ad-group" ||
        entity.status !== "enabled" ||
        entity.ignored ||
        !hasStartedBy(entity.scheduledStartAt, now)
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
    this.assertWriteAllowed(accountId, requireAutomatic, input);
    const entity = this.store
      .listCurrentManagedEntities(accountId, account.providerKind)
      .find(
        (item) =>
          item.entityType === input.entityType &&
          item.externalId === input.externalId,
      );
    if (!existingTask && this.store.hasBlockingStatusOperationForEntity(
      accountId,
      account.providerKind,
      input.entityType,
      input.externalId,
    )) {
      throw new Error("该对象存在结果待确认的历史启停操作；完成只读回读或人工核验前禁止再次写入。");
    }
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
        successMessage,
      ),
      task,
    };
  }

  /** 素材所属广告组的 ID。素材行里它落在 ad_id 上（adgroup_id 由同步时回填）。 */
  private resolveMaterialAdGroupId(
    accountId: string,
    providerKind: ProviderKind,
    externalId: string,
  ): string | undefined {
    const entity = this.store
      .listCurrentProviderEntities(accountId, providerKind)
      .find((item) => item.entityType === "material" && item.externalId === externalId);
    if (!entity) return undefined;
    const payload = entity.payload as Record<string, unknown>;
    const raw = payload.adgroup_id ?? payload.ad_id;
    const value = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
    return value || undefined;
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
    successMessage?: string,
  ): Promise<StatusMutationResult> {
    const account = this.store.getAccount(task.accountId);
    if (!account) throw new Error("账号不存在。");
    let providerInvoked = false;
    let providerConfirmed = false;
    let result: StatusMutationResult;
    try {
      providerInvoked = true;
      // 素材的启停报文要同时带广告组 ID 与素材 ID，光有素材 ID 发不出去
      // （procedural_material/update_status 的 ad_id 装的是广告组）。父级不随
      // 输入透传、而是在这里按当前快照解析：写任务落库后重建 mutation 时会丢掉
      // 额外字段，放在这一层能同时覆盖自动、人工与重试三条路。
      const mutation: StatusMutation = input.entityType === "material"
        ? {
            ...input,
            ...(this.resolveMaterialAdGroupId(task.accountId, account.providerKind, input.externalId)
              ? { parentAdGroupId: this.resolveMaterialAdGroupId(task.accountId, account.providerKind, input.externalId)! }
              : {}),
          }
        : input;
      const results = await withLeaseHeartbeat(
        () => this.changeProviderStatus(
          context,
          [mutation],
          expectedCredentialGeneration,
          requireAutomatic,
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
      const readbackUsable = this.isEntitySyncUsable(
        task.accountId,
        account.providerKind,
        refreshed.result.quality,
        input,
      );
      if (!readbackUsable) {
        syncWarning = `状态写入后同步数据不完整：${refreshed.result.warnings.join("；")}`;
      } else if (observedStatus !== desiredStatus) {
        syncWarning = `状态写入后回读未确认目标状态：期望 ${desiredStatus}，实际 ${observedStatus ?? "未返回"}`;
      }
      if (syncWarning) {
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
      ) ||
      this.store.hasUnresolvedStatusOperation(
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
      // 广告与素材都是广告组的子级：父广告组关着时不开子级。素材层此前是死的，
      // 只写了 "ad"；现在素材真有数据，漏掉它会向一个关停广告组里的素材发 enable
      // ——零投放效果的真实写入，且每轮重复。素材的父广告组 ID 回填在 adgroup_id
      // 上，normalizeProviderEntity 已解析进 parentAdGroupId。
      if (
        (candidate.entity.entityType === "ad" ||
          candidate.entity.entityType === "material") &&
        candidate.entity.parentAdGroupId
      ) {
        const parentAdGroup = managedEntities.find(
          (entity) =>
            entity.entityType === "ad-group" &&
            entity.externalId === candidate.entity.parentAdGroupId,
        );
        if (parentAdGroup?.status === "disabled") {
          return "父广告组处于关闭状态，不建议开启子级。";
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
    ], expectedCredentialGeneration, true);
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
    this.assertWriteAllowed(context.accountId, requireAutomatic, mutations[0]);
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

  private resolveMaterialAdId(
    accountId: string,
    providerKind: ProviderKind,
    externalId: string,
  ): string | undefined {
    const entity = this.store
      .listCurrentProviderEntities(accountId, providerKind)
      .find((item) => item.entityType === "material" && item.externalId === externalId);
    if (!entity) return undefined;
    const payload = entity.payload as Record<string, unknown>;
    const nested = [
      payload,
      ...(isRecordValue(payload.row_data) ? [payload.row_data] : []),
      ...(isRecordValue(payload.stat_data) ? [payload.stat_data] : []),
    ];
    for (const source of nested) {
      for (const key of ["creative_id", "creativeId"]) {
        const value = source[key];
        if (typeof value === "string" || typeof value === "number") {
          const normalized = String(value).trim();
          if (normalized) return normalized;
        }
      }
    }
    return undefined;
  }

  private materialUnavailableAdGroupIds(
    accountId: string,
    providerKind: ProviderKind,
    quality: SyncDataQuality,
  ): Set<string> {
    const unavailableAdIds = new Set(quality.materialUnavailableAdIds ?? []);
    if (unavailableAdIds.size === 0) return new Set();
    return new Set(
      this.store
        .listManagedEntities(accountId, providerKind)
        .filter((entity) => entity.entityType === "ad" && unavailableAdIds.has(entity.externalId))
        .map((entity) => entity.parentAdGroupId)
        .filter((externalId): externalId is string => Boolean(externalId)),
    );
  }

  private isEntitySyncUsable(
    accountId: string,
    providerKind: ProviderKind,
    quality: SyncDataQuality,
    entity: {
      entityType: SyncEntityType;
      externalId: string;
      parentAdGroupId?: string | null;
    },
  ): boolean {
    if (quality.status === "healthy") return true;
    if (quality.status !== "partial") return false;

    if (!syncLayerComplete(quality, entity.entityType)) {
      if (entity.entityType !== "material") return false;
      const materialAdId = this.resolveMaterialAdId(
        accountId,
        providerKind,
        entity.externalId,
      );
      // 没有按广告粒度的素材质量记录时，沿用旧的保守语义：素材不自动写。
      return Boolean(
        materialAdId
        && quality.materialUnavailableAdIds
        && !quality.materialUnavailableAdIds.includes(materialAdId),
      );
    }

    const unavailableAdIds = new Set(quality.materialUnavailableAdIds ?? []);
    if (unavailableAdIds.size === 0) return true;
    // 广告组只依赖自己的指标与状态。素材列表的局部失败不能阻断广告组
    // 的独立启停，否则“素材层独立”会退化成父级也不可用。
    if (entity.entityType === "ad-group") return true;
    if (entity.entityType === "material") {
      const materialAdId = this.resolveMaterialAdId(
        accountId,
        providerKind,
        entity.externalId,
      );
      return Boolean(materialAdId && !unavailableAdIds.has(materialAdId));
    }
    const unavailableAdGroupIds = this.materialUnavailableAdGroupIds(
      accountId,
      providerKind,
      quality,
    );
    if (entity.entityType === "ad") {
      return !unavailableAdIds.has(entity.externalId)
        && !unavailableAdGroupIds.has(entity.parentAdGroupId ?? "");
    }
    return true;
  }

  private getAutomaticDataQualityBlockReason(
    accountId: string,
    providerKind: ProviderKind,
    quality: SyncDataQuality,
    entity: {
      entityType: SyncEntityType;
      externalId: string;
      parentAdGroupId?: string | null;
    },
  ): string | null {
    if (this.isEntitySyncUsable(accountId, providerKind, quality, entity)) return null;
    if (quality.status === "partial" && quality.materialUnavailableAdIds?.length) {
      return "素材列表本轮部分抓取失败，已隔离受影响对象，本条自动状态写入跳过。";
    }
    return `数据质量为 ${quality.status}，${entity.entityType} 层本轮未取全，自动状态写入跳过。`;
  }

  private assertWriteAllowed(
    accountId: string,
    requireAutomatic: boolean,
    entity?: Pick<StatusMutation, "entityType" | "externalId">,
  ): void {
    const account = this.store.getAccount(accountId);
    if (!account) throw new WriteBlockedBeforeDispatchError("账号不存在。");
    const latestSync = this.store.getLatestReadOnlySync(accountId, account.providerKind);
    if (!latestSync) {
      throw new WriteBlockedBeforeDispatchError("尚无可信同步记录，真实 Provider 写入已阻止。");
    }
    if (latestSync.quality.status === "invalid") {
      throw new WriteBlockedBeforeDispatchError("同步契约已失效，所有真实 Provider 写入已阻止。");
    }
    if (account.platform === "meta") {
      const syncAge = Date.now() - new Date(latestSync.finishedAt).getTime();
      if (!Number.isFinite(syncAge) || syncAge < 0 || syncAge > destructiveSyncFreshnessMs) {
        throw new WriteBlockedBeforeDispatchError(
          "Meta 最新可信同步已超过 5 分钟，请先重新同步后再启停。",
        );
      }
      if (
        !entity
        || !this.store.listCurrentManagedEntities(accountId, account.providerKind).some(
          (item) => item.entityType === entity.entityType && item.externalId === entity.externalId,
        )
      ) {
        throw new WriteBlockedBeforeDispatchError(
          "Meta 对象不在最新可信同步快照中，状态写入已阻止。",
        );
      }
      const connection = this.store.getProviderConnection(accountId, account.providerKind);
      const liveMode = connection?.settings.kind === "meta-marketing-api"
        ? connection.settings.liveMode
        : "disabled";
      if (requireAutomatic && liveMode !== "automation-status") {
        throw new WriteBlockedBeforeDispatchError(
          "Meta 自动启停未获授 automation-status 账户级权限。",
        );
      }
      if (
        !requireAutomatic
        && liveMode !== "manual-status"
        && liveMode !== "automation-status"
      ) {
        throw new WriteBlockedBeforeDispatchError(
          "Meta 人工启停未获授账户级写入权限。",
        );
      }
      if (
        !entity
        || entity.entityType === "material"
        || connection?.settings.kind !== "meta-marketing-api"
        || !connection.settings.allowedStatusEntityTypes?.includes(entity.entityType)
      ) {
        throw new WriteBlockedBeforeDispatchError(
          "Meta 对象层级不在账户启停 allowlist，状态写入已阻止。",
        );
      }
    }
    if (
      latestSync.quality.status !== "healthy"
      && (
        !entity
        || !this.isEntitySyncUsable(accountId, account.providerKind, latestSync.quality, entity)
      )
    ) {
      throw new WriteBlockedBeforeDispatchError(`同步数据为 ${latestSync.quality.status}，状态写入已阻止。`);
    }
    if (requireAutomatic) {
      if (!this.store.getSystemRuntimeState().enabled) {
        throw new WriteBlockedBeforeDispatchError(
          "全局自动化总开关已关闭，自动状态写入已暂停。",
        );
      }
      const platformRuntimeEnabled = account.platform === "meta"
        ? this.store.getMetaAutomationRuntime().enabled
        : true;
      if (!platformRuntimeEnabled) {
        throw new WriteBlockedBeforeDispatchError(account.platform === "meta"
          ? "Meta 自动化总开关已关闭，自动状态写入已暂停。"
          : "全局自动化已关闭，自动状态写入已暂停。");
      }
      if (!account.enabled) {
        throw new WriteBlockedBeforeDispatchError("账户自动化已关闭，自动状态写入已阻止。");
      }
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
    }
  }

  private async loadContext(
    accountId: string,
    providerKind: ProviderKind,
    timezone: string,
  ): Promise<ProviderContext> {
    if (providerKind === "meta-offline") {
      throw new Error("Meta Marketing API 尚未接入；当前仅提供零网络离线架构。");
    }
    const connection = this.store.getProviderConnection(accountId, providerKind);
    if (!connection) {
      throw new Error("接入参数或凭据尚未配置。");
    }
    if (providerKind === "meta-marketing-api") {
      if (
        connection.settings.kind !== "meta-marketing-api"
        || !connection.settings.profileId
      ) {
        throw new Error("Meta 广告账户尚未绑定共享凭据 Profile。");
      }
      const profile = this.store.getStoredMetaAccessProfile(connection.settings.profileId);
      if (!profile?.secretRef) {
        throw new Error("Meta 共享凭据 Profile 尚未保存 App Secret 与 Access Token。");
      }
      const secret = await this.vault.read(profile.secretRef);
      if (!secret) throw new Error("Meta 共享凭据引用已失效，请重新保存。");
      return {
        accountId,
        settings: connection.settings,
        credential: MetaAccessSecretBundleInputSchema.parse(JSON.parse(secret)),
        resolvedMetaAccessProfile: {
          profileId: profile.id,
          appId: profile.appId,
          businessId: profile.businessId,
          graphApiVersion: profile.graphApiVersion,
        },
        timezone,
      };
    }
    if (!connection.credentialRef) {
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
  // 素材在广告之下，最后处理：先收口上层，避免上层被关之后还去动它的素材。
  const layerOrder = { campaign: 0, "ad-group": 1, ad: 2, material: 3 } as const;
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

function buildMetaDecisionPredicate(
  configuration: MetaRuleConfiguration,
  candidate: AutomationCandidate,
): Record<string, unknown> {
  const rule = configuration.rules.find(
    (item) => item.code === candidate.thresholdCode,
  );
  if (!rule) {
    throw new Error(`Meta 规则 ${candidate.thresholdCode} 不在当前配置中。`);
  }
  return {
    ...buildMetaRulePredicate(rule),
    schemaVersion: configuration.schemaVersion,
    action: candidate.action,
    metric: candidate.metric,
    operator: candidate.operator,
    thresholdValue: candidate.thresholdValue,
  };
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

/**
 * 过夜关停窗口：账户本地时间 23:45 到零点。
 *
 * enrollNightlyAdGroups 在这个窗口把开着的广告组全部关掉（有转化的排一对过夜
 * 开关，其余单纯关闭），零点由排期统一开回来。
 *
 * 判据与 suppressedAutomationActions 共用，两处各写各的正是 1.4.28 那个删除故障
 * 的成因：同一件事在两个地方判，早晚会漂移。
 */
export function isOvernightBlackout(at: Date, timeZone: string): boolean {
  const local = timePartsInTimeZone(at, timeZone);
  return local.hour === 23 && local.minute >= 45;
}

/**
 * 本时刻自动启停被禁止的动作范围。只约束规则引擎（source=automation），不影响
 * 过夜排期（source=scheduled）和人工操作。
 *
 * 两段窗口，禁止范围不同——2026-08-07 那一晚把两种病都犯了：
 *
 * - 23:45 至零点：**只禁开启**。这个窗口正是 enrollNightlyAdGroups 把组关掉的
 *   时段，规则再开回来等于把过夜关停整个抵消掉；关闭方向与窗口同向，放行。
 *   当晚 23:45 关掉 4 个组，23:50–23:52 规则又开回来。
 * - 零点至凌晨 3 点：**过夜组的全部动作**。过夜排期在零点把这些组统一开回来，
 *   此时当日数据从零开始，任何基于消耗/转化的规则都会立刻判它「零转化消耗过高」
 *   而关掉——当晚 00:00:40 开启的「翻譯機_新」，00:07:59 就被关了，开了不到 8
 *   分钟。这三小时是留给它们攒数据的。**只保护过夜组**：同一时段里其它广告组
 *   （比如刚创建的、或本来就在跑的）不受影响，规则照常判定。
 */
export function suppressedAutomationActions(
  at: Date,
  timeZone: string,
): "none" | "enable" | "overnight-entities" {
  const local = timePartsInTimeZone(at, timeZone);
  if (local.hour === 23 && local.minute >= 45) return "enable";
  if (local.hour < 3) return "overnight-entities";
  return "none";
}

function hasStartedBy(scheduledStartAt: string | null | undefined, now: Date): boolean {
  if (!scheduledStartAt) return false;
  const timestamp = new Date(scheduledStartAt).getTime();
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
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
      const systemRuntimeEnabled = this.store.getSystemRuntimeState().enabled;
      const metaRuntime = this.store.getMetaAutomationRuntime();
      if (!systemRuntimeEnabled) return;
      try {
        await this.notifications?.flushPending();
      } catch {
        // Notification delivery is best-effort and must never block ad polling.
      }
      for (const account of this.store.listAccounts()) {
        if (account.platform !== "tiktok") continue;
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
          await this.service.runScheduledAppeals(account.id);
          await this.service.runDueScheduledActions(account.id);
          // 删除必须跟自动申诉一样待在「轮询到期」过滤之前的全账户循环里。放在
          // dueAccounts 循环里意味着只有恰好在计划时刻到期的那一轮才有机会评估，
          // 实测 19 天里只命中过 7 次，删除因此一次都没跑起来。
          await this.service.runScheduledDeletions(account.id);
        }
      }
      const dueAccounts = this.store.listAccounts().filter((account) => {
        const connection = this.store.getProviderConnection(
          account.id,
          account.providerKind,
        );
        if (!connection?.hasCredential) return false;
        if (account.platform === "meta") {
          if (
            !metaRuntime.enabled
            || !account.enabled
            || account.providerKind !== "meta-marketing-api"
            || connection.settings.kind !== "meta-marketing-api"
            || connection.settings.liveMode !== "automation-status"
          ) return false;
        }
        const pollingIntervalMinutes = account.platform === "meta"
          ? metaRuntime.pollingIntervalMinutes
          : this.store.getGlobalAutomationSettings().pollingIntervalMinutes;
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
          if (account.platform === "tiktok") {
            await this.service.runScheduledAutoCopies(account.id);
          }
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

function isTransientHealthCheckFailure(cause: unknown): boolean {
  const name = cause instanceof Error ? cause.name.toLowerCase() : "";
  const message = safeMessage(cause).toLowerCase();
  return name === "aborterror"
    || name === "timeouterror"
    || message.includes("timed out")
    || message.includes("timeout")
    || message.includes("operation was aborted")
    || message.includes("fetch failed")
    || message.includes("econnreset")
    || message.includes("econnrefused")
    || message.includes("socket hang up");
}

function renderAppealTemplate(
  template: string,
  values: { adName: string; adId: string; rejectReason: string },
): string {
  return template
    .replaceAll("{ad_name}", values.adName)
    .replaceAll("{ad_id}", values.adId)
    .replaceAll("{reject_reason}", values.rejectReason);
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

function hasCurrentDayMetricCoverage(
  sync: ReturnType<AutomationStore["getLatestReadOnlySync"]>,
  localDate: string,
  timeZone: string,
): boolean {
  const coverage = sync?.quality.coverage;
  return Boolean(
    coverage
    && coverage.startDate === localDate
    && coverage.endDate === localDate
    && coverage.timezone === timeZone,
  );
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

function compareDeletionPriority(
  left: ReturnType<typeof normalizeProviderEntity>,
  right: ReturnType<typeof normalizeProviderEntity>,
): number {
  const conversionOrder = (left.metrics.conversions ?? Number.POSITIVE_INFINITY)
    - (right.metrics.conversions ?? Number.POSITIVE_INFINITY);
  if (conversionOrder !== 0) return conversionOrder;
  const cartOrder = (left.metrics.carts ?? Number.POSITIVE_INFINITY)
    - (right.metrics.carts ?? Number.POSITIVE_INFINITY);
  if (cartOrder !== 0) return cartOrder;
  const leftCpa = left.metrics.cost_per_conversion ?? Number.POSITIVE_INFINITY;
  const rightCpa = right.metrics.cost_per_conversion ?? Number.POSITIVE_INFINITY;
  if (leftCpa !== rightCpa) return rightCpa - leftCpa;
  const createdOrder = new Date(left.createdAt ?? 0).getTime()
    - new Date(right.createdAt ?? 0).getTime();
  return createdOrder || left.externalId.localeCompare(right.externalId);
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

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function connectionUnavailableMessage(
  accountName: string,
  providerKind: ProviderKind,
  status: string | undefined,
): string {
  const providerLabel = providerKind === "meta-offline"
    ? "Meta 离线架构"
    : providerKind === "cookie" ? "Cookie 接入" : "API 接入";
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
