import { createHash, randomUUID } from "node:crypto";
import {
  AUTOMATION_MANAGED_LOOKBACK_HOURS,
  METRIC_RETENTION_DAYS,
  ProviderCredentialInputSchema,
  automationRuleDefinitions,
  classifyCampaignsForExpand,
  dateKeyInTimeZone,
  dateTimeSuffix,
  buildMetaRulePredicate,
  evaluateMetaRuleConfiguration,
  evaluateRuleConfiguration,
  filterEntitiesToRecentWindow,
  mapWithConcurrency,
  networkUnreachableMessagePrefix,
  MetaAccessSecretBundleInputSchema,
  stripAutomaticAdGroupNameSuffixes,
  type AutomationCandidate,
  type AutomationRunRecord,
  type AutomationTrigger,
  type ManualStatusInput,
  type MetaRuleConfiguration,
  type ManagedEntityRecord,
  type PollCycleRecord,
  type PollFailureKind,
  type RuleConfiguration,
  type AdOperationRecord,
  type SyncDataQuality,
  type SyncEntityType,
  type ProviderKind,
  type WriteTaskActor,
  type ManagedEntitySnapshot,
  normalizeProviderEntity,
  reconcileExpandTask,
  selectBudgetBumpCandidate,
  selectDeletionCandidates,
  syncLayerComplete,
  creativeNeedsAppeal,
} from "@tk-auto/core";
import type { CredentialVault } from "@tk-auto/credentials";
import {
  ProviderRegistry,
  withCauseDetail,
  type ProviderContext,
  type StatusMutation,
  type StatusMutationResult,
} from "@tk-auto/providers";
import { AutomationStore } from "@tk-auto/storage";
import { WriteTaskKernel, withLeaseHeartbeat } from "./write-task-kernel.js";

const statusLeaseHeartbeatMs = 60 * 1000;
const writeLeaseTimeoutMs = 30 * 60 * 1000;
const destructiveSyncFreshnessMs = 5 * 60 * 1000;
/**
 * 自动补发布最多试几次。
 *
 * 3 次覆盖得住会自己好的那些原因（凭据刚过期、TikTok 抖动、同步慢一拍），又不至于让一条
 * 永远发不出去的草稿（被人删了、同名重复、连系列都没建）一直敲创建接口。试满就停手，
 * 红条留着交人工——那才是这个上限真正要保住的东西。
 */
const DRAFT_PUBLISH_MAX_ATTEMPTS = 3;
/**
 * 任务领取多久之后才允许自动补发布。
 *
 * 与幂等表判「租约过期」的 30 分钟对齐——过了那个点，系统本来就认为这条任务不在跑了。
 * 见 publishDraftOnly 里为什么这道闸门是必需的。
 */
const DRAFT_PUBLISH_MIN_TASK_AGE_MS = 30 * 60_000;
/**
 * 指标快照保留几天的完整（日内）粒度。
 *
 * 只有「最近状况」那两个诊断视图（listMetricSnapshots / listMetricBatches）需要日内数据，
 * 而它们都带 LIMIT、只看最近一小段。2 天而不是 1 天，是给跨本地日边界留的余量。
 */
const METRIC_FULL_RESOLUTION_DAYS = 2;
/**
 * 单账户单轮最多降采样掉多少行。
 *
 * 稳态下每账户每轮只有几百行要删，这个上限是给积压准备的护栏：一次删太多会长时间持写锁
 * 把同步卡住。实测删除速度约 1.5 万行/秒，2 万行约 1.4 秒，摊在几十秒的一轮同步里可以忽略。
 */
const DOWNSAMPLE_ROW_LIMIT = 20_000;
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
    /**
     * 对账判出「只建了草稿」后，用来补发布那最后一步。注入而不是直接依赖 LaunchService：
     * 两个 service 互相持有会绕成环，而这里要的只是一个按 taskKey 发布的动作。
     */
    private readonly draftPublishers?: {
      expand: (taskKey: string) => Promise<unknown>;
      campaignCopy: (taskKey: string) => Promise<unknown>;
    },
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
      // 判据与排序都在 core 的 selectDeletionCandidates 里，界面上的「待清理」列表走的是
      // 同一个函数——各写一份就会漂移，而删除不可恢复，「看到的」和「删掉的」不一致
      // 没有补救余地。
      const candidates = selectDeletionCandidates({
        readyAdGroups: this.store
          .listDeletionReadyAdGroups(accountId, account.providerKind, disabledBefore)
          .map(normalizeProviderEntity),
        currentAdGroups: this.store.listCurrentManagedEntities(accountId, account.providerKind),
        settings,
      });
      await this.deleteAdGroupCandidates(accountId, account.providerKind, context, candidates);
    } finally {
      this.store.finishDailyAutomationRun(accountId, "delete-ad-groups", localDate);
    }
  }

  /**
   * 界面上的「待清理」列表。与定时执行器同一批候选、同一个排序，只是不写。
   *
   * 这里刻意不套执行器的那些前置闸门（连接就绪、同步新鲜度、能力契约、计划小时）：
   * 那些决定的是「现在能不能安全地删」，而列表要回答的是「按当前配置，哪些组够格删」。
   * 把两者混在一起，用户会在闸门没过时看到一张空列表，误以为没有待清理对象。
   */
  listCleanupCandidates(accountId: string, asOf = new Date()): ManagedEntitySnapshot[] {
    const account = this.store.getAccount(accountId);
    if (!account) return [];
    const settings = this.store.getAutomationFeatureSettings().deletion;
    const disabledBefore = new Date(
      asOf.getTime() - settings.gracePeriodHours * 60 * 60 * 1000,
    ).toISOString();
    return selectDeletionCandidates({
      readyAdGroups: this.store
        .listDeletionReadyAdGroups(accountId, account.providerKind, disabledBefore)
        .map(normalizeProviderEntity),
      currentAdGroups: this.store.listCurrentManagedEntities(accountId, account.providerKind),
      settings,
    });
  }

  /**
   * 「一键删除」：立刻删掉待清理列表里的广告组。
   *
   * 与定时执行器的区别只有两点——不看计划小时、不占当日的日任务名额（人工点了就该执行，
   * 而且不该让当天的定时那一轮因为名额被占而跳过）。**其余闸门一个都不能少**：
   * 连接、能力契约、同步新鲜度决定的是「现在删安不安全」，跟谁触发的无关。
   */
  async deleteCleanupCandidatesNow(accountId: string, asOf = new Date()): Promise<{
    deleted: number;
    skipped: number;
  }> {
    const account = this.store.getAccount(accountId);
    if (!account?.enabled) throw new Error("账号不存在或已停用。");
    if (!this.store.getSystemRuntimeState().enabled) throw new Error("自动化总开关已关闭。");
    const localDate = dateKeyInTimeZone(asOf, account.timezone);
    const connection = this.store.getProviderConnection(accountId, account.providerKind);
    const latestSync = this.store.getLatestReadOnlySync(accountId, account.providerKind);
    const syncAge = latestSync
      ? asOf.getTime() - new Date(latestSync.finishedAt).getTime()
      : Number.POSITIVE_INFINITY;
    if (connection?.status !== "ready") throw new Error("账户连接未就绪，暂不能删除。");
    if (
      !syncLayerComplete(latestSync?.quality, "ad-group")
      || !syncLayerComplete(latestSync?.quality, "campaign")
      || !hasCurrentDayMetricCoverage(latestSync, localDate, account.timezone)
      || syncAge < 0
      || syncAge > destructiveSyncFreshnessMs
    ) {
      throw new Error("最近一次同步不完整或已过期，删除前需要先同步到最新数据。");
    }
    this.providers.requireAccountCapability(
      accountId,
      account.providerKind,
      connection,
      "delete-ad-groups",
    );
    const context = await this.loadContext(accountId, account.providerKind, account.timezone);
    const provider = this.providers.get(account.providerKind);
    if (!provider.deleteAdGroups || !provider.resolveCapabilities?.(context).has("delete-ad-groups")) {
      throw new Error("当前账户不具备删除广告组的能力。");
    }
    const candidates = this.listCleanupCandidates(accountId, asOf);
    return this.deleteAdGroupCandidates(accountId, account.providerKind, context, candidates);
  }

  private async deleteAdGroupCandidates(
    accountId: string,
    providerKind: ProviderKind,
    context: ProviderContext,
    candidates: readonly ManagedEntitySnapshot[],
  ): Promise<{ deleted: number; skipped: number }> {
    let deleted = 0;
    let skipped = 0;
    for (const entity of candidates) {
      const task = this.store.queueAdGroupDeletionIfAbsent(
        accountId,
        providerKind,
        entity.externalId,
      );
      // 没排上队意味着这个组已经有一条未了结的删除记录（含「结果未知」），不再重复发。
      if (!task) {
        skipped += 1;
        continue;
      }
      try {
        const [result] = await this.providers.deleteAdGroups(
          providerKind,
          context,
          [{ externalId: entity.externalId }],
        );
        if (result?.ok) {
          this.store.completeAdGroupDeletion(task.id, "succeeded", result.message);
          deleted += 1;
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
    return { deleted, skipped };
  }

  /**
   * 每早定点回看前一自然日：转化达标就把关着的对象开回来。
   *
   * 为什么不做成规则链上的一条：规则链是 48 小时滚动窗口、每轮轮询即时评估、命中第一条
   * 就 break。这条用自然日口径、一天只该生效一次，塞进链里既会被反复评估，又会占位置
   * 让后面的规则 break 不到（#86 刚踩过这个坑）。所以按 deletion / copy 的样子做成独立
   * 的每日执行器，由 claimDailyAutomationRun 保证每账户每个本地日只跑一次。
   *
   * 开启的闸门与规则链上的 OPEN 规则保持一致：只看父级是否关着，不查「是不是本工具
   * 关的」。两套口径不一致更难解释，代价是人工暂停过的对象也可能被开回来。
   */
  async runScheduledDailyEnables(accountId: string, asOf = new Date()): Promise<void> {
    const settings = this.store.getAutomationFeatureSettings().dailyEnable;
    const account = this.store.getAccount(accountId);
    if (
      !settings.enabled
      || !account?.enabled
      || !this.store.getSystemRuntimeState().enabled
    ) return;
    // 与删除执行器同理：整个计划小时内都可触发，靠日任务保证只跑一次。锁死在第 0
    // 分钟会因为前面账户跑得久而整点错过。
    if (timePartsInTimeZone(asOf, account.timezone).hour !== settings.scheduleHour) return;
    const connection = this.store.getProviderConnection(accountId, account.providerKind);
    if (connection?.status !== "ready") return;

    const localDate = dateKeyInTimeZone(asOf, account.timezone);
    // 「前一日」按账户时区退一天。用 UTC 减 24 小时会在跨时区账户上错开一整天。
    const previousDate = dateKeyInTimeZone(
      new Date(asOf.getTime() - 24 * 60 * 60 * 1000),
      account.timezone,
    );
    if (this.store.claimDailyAutomationRun(accountId, "daily-enable", localDate) !== "claimed") {
      return;
    }
    try {
      const managed = this.store.listCurrentManagedEntities(accountId, account.providerKind);
      const statusOf = new Map(managed.map((entity) => [
        `${entity.entityType}:${entity.externalId}`,
        entity.status,
      ]));
      const parentOf = new Map(managed.map((entity) => [
        `${entity.entityType}:${entity.externalId}`,
        entity,
      ]));
      const metrics = this.store.listEntityMetricsForLocalDate(
        accountId,
        account.providerKind,
        previousDate,
      );
      for (const record of metrics) {
        if (record.entityType !== "ad-group" && record.entityType !== "ad") continue;
        if (record.conversions < settings.minConversions) continue;
        const key = `${record.entityType}:${record.externalId}`;
        // 已经开着的不必再写：一次真实写入换不到任何变化，还会占掉写入配额。
        if (statusOf.get(key) !== "disabled") continue;
        const entity = parentOf.get(key);
        if (!entity) continue;
        // 父级关着时不开子级，口径与 getSkipReason 里那两条一致：广告组开着而广告关着
        // 这种状态投不出去，界面上还看不出来。
        if (
          entity.parentCampaignId
          && statusOf.get(`campaign:${entity.parentCampaignId}`) === "disabled"
        ) continue;
        if (
          record.entityType === "ad"
          && entity.parentAdGroupId
          && statusOf.get(`ad-group:${entity.parentAdGroupId}`) === "disabled"
        ) continue;
        try {
          await this.changeStatus(
            accountId,
            { entityType: record.entityType, externalId: record.externalId, action: "enable" },
            "scheduled",
            { id: "automation-scheduler", name: "自动化调度器", kind: "system" },
            undefined,
            true,
            undefined,
            `前一日（${previousDate}）转化 ${record.conversions} 次达到 ${settings.minConversions}，自动开启。`,
          );
        } catch {
          // 单个对象写失败不该带走整轮，后面的对象照常处理。这里不另外记一笔：
          // changeStatus 失败时写入内核已经把任务连同失败原因落了库，界面上查得到。
        }
      }
    } finally {
      this.store.finishDailyAutomationRun(accountId, "daily-enable", localDate);
    }
  }

  /**
   * 每早定点关掉「跑不出来又已经停跑」的系列。
   *
   * 判据整段复用扩组分类，不另起一套：判为需重扩（单转超标，或零转化且花超，或零转化
   * 且组已关光）、**且系列下已经没有在投的广告组**。组还在跑的绝不碰——那说明系列还在
   * 产生数据，关系列会连带掐掉正在投放的组。
   *
   * 为什么不进规则链：规则链是单实体 + 当日指标 + 单阈值，而这条要「自创建以来累计」
   * 加「跨实体的组状态」，表达不了。按 deletion / dailyEnable 做成每日执行器，
   * 由 claimDailyAutomationRun 保证每账户每个本地日只跑一次。
   */
  async runScheduledStalledCampaignClose(accountId: string, asOf = new Date()): Promise<void> {
    const settings = this.store.getAutomationFeatureSettings().closeStalledCampaigns;
    const account = this.store.getAccount(accountId);
    if (
      !settings.enabled
      || !account?.enabled
      || !this.store.getSystemRuntimeState().enabled
    ) return;
    if (timePartsInTimeZone(asOf, account.timezone).hour !== settings.scheduleHour) return;
    const connection = this.store.getProviderConnection(accountId, account.providerKind);
    if (connection?.status !== "ready") return;

    const localDate = dateKeyInTimeZone(asOf, account.timezone);
    if (
      this.store.claimDailyAutomationRun(accountId, "close-stalled-campaigns", localDate)
        !== "claimed"
    ) return;
    try {
      const managed = this.store.listCurrentManagedEntities(accountId, account.providerKind);
      const campaignsWithActiveAdGroups = new Set(
        managed
          .filter((entity) => entity.entityType === "ad-group"
            && entity.status === "enabled"
            && entity.parentCampaignId)
          .map((entity) => entity.parentCampaignId as string),
      );
      // 与扩组分类同一口径：自系列创建以来累计，回看整个保留期。窗口取短了会把老系列
      // 的成绩截掉，把还在跑的系列误判成跑不出来。
      const until = asOf.toISOString();
      const since = new Date(
        asOf.getTime() - METRIC_RETENTION_DAYS * 24 * 60 * 60_000,
      ).toISOString();
      const metrics = new Map(
        this.store
          .listEntityRangeMetrics(accountId, account.providerKind, since, "campaign", until)
          .map((row) => [row.externalId, row]),
      );
      // 连续零转化天数与分类接口走同一个 store 方法，两边算法不会漂。
      const zeroStreaks = this.store.listCampaignZeroConversionStreaks(
        accountId,
        account.providerKind,
        asOf,
      );
      const { recreateCampaign } = classifyCampaignsForExpand(
        managed
          .filter((entity) => entity.entityType === "campaign")
          .map((entity) => {
            const metric = metrics.get(entity.externalId);
            return {
              externalId: entity.externalId,
              name: entity.name,
              status: entity.status,
              hasActiveAdGroups: campaignsWithActiveAdGroups.has(entity.externalId),
              consecutiveZeroConversionDays: zeroStreaks.get(entity.externalId) ?? 0,
              spend: metric?.spend ?? 0,
              conversions: metric?.conversions ?? 0,
              days: metric?.days ?? 0,
            };
          }),
        {
          maxCostPerConversion: settings.maxCostPerConversion,
          maxSpendWithoutConversion: settings.maxSpendWithoutConversion,
          maxConsecutiveZeroConversionDays: settings.maxConsecutiveZeroConversionDays,
        },
      );
      // 只关组已经全停的那批。dailyLimit 是判据出错时的兜底：一次关光整个账户的代价
      // 比漏关几条大得多。
      const closable = recreateCampaign
        .filter((item) => item.hasActiveAdGroups === false)
        .slice(0, settings.dailyLimit);
      for (const item of closable) {
        try {
          await this.changeStatus(
            accountId,
            { entityType: "campaign", externalId: item.externalId, action: "disable" },
            "scheduled",
            { id: "automation-scheduler", name: "自动化调度器", kind: "system" },
            undefined,
            true,
            undefined,
            item.reason === "no-conversion-days-exceeded"
              ? `连续 ${item.consecutiveZeroConversionDays} 个自然日零转化，且组已全部停跑，自动关闭系列。`
              : item.conversions > 0
                ? `累计单转 ${item.costPerConversion?.toFixed(2)} 超过 ${settings.maxCostPerConversion}，且组已全部停跑，自动关闭系列。`
                : `累计花费 ${item.spend.toFixed(2)} 零转化，且组已全部停跑，自动关闭系列。`,
          );
        } catch {
          // 单条写失败不带走整轮；changeStatus 失败时写入内核已把原因落库。
        }
      }
    } finally {
      this.store.finishDailyAutomationRun(accountId, "close-stalled-campaigns", localDate);
    }
  }

  /**
   * 跑得好的广告组自动提额：转化量 ≥ N 且 CPA < M 时，把日预算改成设定值。
   *
   * **只作用于日预算恰好等于 sourceBudget 的广告组**（默认 50）。这条限制同时就是幂等
   * 机制——调完预算不再等于 50，下一轮自然不命中，不需要额外的「已处理」台账。
   *
   * 判据用当天累计口径，与自动复制一致：两者触发条件几乎相同（转化达标 + CPA 够低），
   * 只是动作不同，口径再分家只会让人对着两套数字猜。
   *
   * 系列预算(CBO)的广告组一律跳过：它们没有自己的日预算，预算在系列上，
   * 往组上写预算既无意义也可能被拒。
   */
  async runScheduledBudgetBumps(accountId: string, asOf = new Date()): Promise<void> {
    const settings = this.store.getAutomationFeatureSettings().budgetBump;
    const account = this.store.getAccount(accountId);
    if (
      !settings.enabled
      || !account?.enabled
      || !this.store.getSystemRuntimeState().enabled
    ) return;
    const localDate = dateKeyInTimeZone(asOf, account.timezone);
    const connection = this.store.getProviderConnection(accountId, account.providerKind);
    const latestSync = this.store.getLatestReadOnlySync(accountId, account.providerKind);
    const syncAge = latestSync
      ? asOf.getTime() - new Date(latestSync.finishedAt).getTime()
      : Number.POSITIVE_INFINITY;
    if (
      connection?.status !== "ready"
      // 判据全部来自广告组层，不因广告层拉不到而跳过整轮；但广告组层本身必须取全，
      // 否则「没看到的组」和「不达标的组」分不出来。
      || !syncLayerComplete(latestSync?.quality, "ad-group")
      || !hasCurrentDayMetricCoverage(latestSync, localDate, account.timezone)
      || syncAge < 0
      || syncAge > destructiveSyncFreshnessMs
    ) return;
    try {
      this.providers.requireAccountCapability(
        accountId,
        account.providerKind,
        connection,
        "update-ad-group-budget",
      );
    } catch {
      return;
    }
    const context = await this.loadContext(accountId, account.providerKind, account.timezone);
    const provider = this.providers.get(account.providerKind);
    if (
      !provider.updateAdGroupBudgets
      || !provider.resolveCapabilities?.(context).has("update-ad-group-budget")
    ) return;

    const candidates = this.store
      .listCurrentManagedEntities(accountId, account.providerKind)
      .filter((entity) => selectBudgetBumpCandidate(entity, settings));

    for (const entity of candidates) {
      // **不设每日闸、不因结果未知跳过，命中就写。**
      //
      // 这跟创建类操作是两回事：建广告组时重试可能建出第二个，所以「结果未知」必须锁死；
      // 而预算写的是绝对值，重复写收敛到同一个数，最坏情况只是多发一笔一模一样的请求。
      // 反过来，预算没改成等于什么都没做——为了一个没有副作用的重试而把它锁到明天，
      // 代价完全不对等。
      //
      // 自然的收敛条件是判据本身：改成功后预算不再等于 sourceBudget，下一轮同步一到就
      // 不再命中。代价是从写入到快照刷新之间可能重复发一两笔，这是可以接受的。
      try {
        await this.providers.updateAdGroupBudgets(
          account.providerKind,
          context,
          [{ externalId: entity.externalId, budget: settings.targetBudget }],
        );
      } catch {
        // 单个组失败不带走整轮。失败原因由 provider 结果带出；这条动作今天不会再重试
        // ——预算写入结果不确定时重发的风险高于晚一天调整。
      }
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
      // 同步成功就是一次成功的连接检测——它比 checkHealth 走的路更长、更能说明
      // 会话可用。调度器因此不再为 ready 账户单独探一次健康检查；这里必须把「最近
      // 检查」时间补上，否则界面上的连接状态会一直停在上一次真正探测的时刻。
      // 失败方向由上面的 catch 覆盖，两个方向合起来才是完整的连接状态。
      try {
        this.store.updateProviderStatus(
          accountId,
          account.providerKind,
          "ready",
          account.providerKind === "cookie"
            ? "Cookie 会话可用：只读同步成功。"
            : "API 连接可用：只读同步成功。",
        );
      } catch {
        // 纯记账：连接在同步期间被重置或删除都会走到这里。数据已经取回来了，
        // 规则该照常判，不能让一次状态回写把成功的一轮翻成失败。
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
      await this.reconcileUncertainExpands(accountId, account.providerKind, account.timezone);
      this.downsampleMetricSnapshots(accountId, account.providerKind);

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
      // undici 的网络失败一律只留一句 `fetch failed`，真正的错误码藏在 cause 链上。
      const message = withCauseDetail(safeMessage(cause), cause);
      const networkUnreachable = isTransientHealthCheckFailure(cause);
      if (
        connection.status === "ready"
        && connection.authorizationStatus === "active"
        && networkUnreachable
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
          message: networkUnreachable
            ? `${networkUnreachableMessagePrefix}：${message}`
            : account.providerKind === "cookie"
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
      const desiredStatus = input.action === "enable" ? "enabled" : "disabled";
      // 先试定向回读：只拉这一个实体，实测 1～2 秒 / 1 个请求，而全量同步是
      // 89.8 秒 / 15 个请求 / 1618 个实体——只为核对其中 1 个。自动启停是逐条串行
      // 的，全量的代价会乘以条数。provider 不支持（如素材层）或没读到时退回全量。
      const targeted = isTargetedReadbackEntity(input.entityType)
        ? await this.providers
          .readEntityById(account.providerKind, context, input.entityType, input.externalId)
          .catch(() => null)
        : null;
      let readbackUsable = true;
      if (targeted) {
        this.store.refreshProviderEntity(task.accountId, account.providerKind, targeted);
      } else {
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
        // 覆盖度闸门只对全量同步有意义：它回答的是「这一层本轮取全了吗」。
        // 定向回读拿的就是目标实体本身，不存在漏取。
        readbackUsable = this.isEntitySyncUsable(
          task.accountId,
          account.providerKind,
          refreshed.result.quality,
          input,
        );
        if (!readbackUsable) {
          syncWarning = `状态写入后同步数据不完整：${refreshed.result.warnings.join("；")}`;
        }
      }
      const observedStatus = this.store.listManagedEntities(
        task.accountId,
        account.providerKind,
      ).find(
        (entity) => entity.entityType === input.entityType && entity.externalId === input.externalId,
      )?.status;
      if (!readbackUsable) {
        // 警告已在上面写好，这里不覆盖。
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

  /**
   * 拿刚同步回来的快照，替人回答那些「结果未知」的扩组记录到底建成没有。
   *
   * 这类记录禁止自动重试、只能人工去 TikTok 后台核实，于是只进不出、越攒越多，攒到没人
   * 再看那条红色横幅——真正需要处理的新记录也跟着被淹掉。但绝大多数其实是「建成了，只是
   * 我们没收到回音」，机器完全答得出来。
   *
   * **判据不能只看名字在不在**：草稿也带名字。只按名字判会把「只建了草稿」误判成成功、
   * 把红条清掉，而那恰恰是唯一真正需要人处理的情形。判据放在 core 的 reconcileExpandTask
   * 里，三种结论分开处理。
   *
   * **草稿要单独去 TikTok 查，本地快照里没有。** 2026-08-26 实测：本地 1066 个广告组里
   * `ad_status='ad_create'` 一个都没有，而后台躺着 9 条 sketch 草稿——它们在独立命名空间，
   * 广告组列表根本不返回。少了这一步，重试过的扩组（后台留下一个同名正式组 + 一个同名草稿）
   * 会被判成 confirmed，红条清掉、草稿永久没人认领。生产上 9 条草稿里有 3 条正是这个状态。
   *
   * **查不到草稿就整轮不下结论。** 宁可让红条多留一轮，也不能在看不见草稿的情况下收口——
   * 那等于把上面那个 bug 原样放回来。
   *
   * 两种结论各有出路：`confirmed` 直接收口；`draft-only` 交给 publishDraftOnly 自动补最后
   * 一步。其余（`not-found`）一律原样留着，继续等下一轮。系列复制走同一套判据——它的
   * 「结果未知」记录同样只是缺一次发布。
   */
  private async reconcileUncertainExpands(
    accountId: string,
    providerKind: ProviderKind,
    timezone: string,
  ): Promise<void> {
    const pendingExpands = this.store.listUncertainAdGroupExpandTasks(accountId);
    const pendingCopies = this.store.listUncertainCampaignCopyTasks(accountId);
    if (pendingExpands.length === 0 && pendingCopies.length === 0) return;
    let draftNames: string[];
    try {
      const context = await this.loadContext(accountId, providerKind, timezone);
      const drafts = await this.providers.listDraftAdGroups(providerKind, context);
      if (!drafts) return;
      draftNames = drafts.map((draft) => draft.adSketchName);
    } catch {
      // 读草稿失败：这一轮什么都不判。
      return;
    }
    const snapshot = this.store.listAdGroupPlatformStatuses(accountId, providerKind);
    for (const task of pendingExpands) {
      const verdict = reconcileExpandTask(task.generatedNames, snapshot, draftNames);
      if (verdict === "confirmed") {
        this.store.confirmAdGroupExpandTask(task.taskKey);
      } else if (verdict === "draft-only") {
        await this.publishDraftOnly({
          taskKey: task.taskKey,
          attempts: task.draftPublishAttempts,
          claimedAt: task.claimedAt,
          publish: this.draftPublishers?.expand,
          recordFailure: (message) =>
            this.store.recordAdGroupExpandDraftPublishFailure(task.taskKey, message),
        });
      }
    }
    for (const task of pendingCopies) {
      const verdict = reconcileExpandTask(task.generatedNames, snapshot, draftNames);
      if (verdict === "confirmed") {
        this.store.confirmCampaignCopyTask(task.taskKey);
      } else if (verdict === "draft-only") {
        await this.publishDraftOnly({
          taskKey: task.taskKey,
          attempts: task.draftPublishAttempts,
          claimedAt: task.claimedAt,
          publish: this.draftPublishers?.campaignCopy,
          recordFailure: (message) =>
            this.store.recordCampaignCopyDraftPublishFailure(task.taskKey, message),
        });
      }
    }
  }

  /**
   * 把过了保留期的指标快照降采样成「每对象每本地日一条」。
   *
   * 每轮同步给每个对象存一条快照，而所有业务查询只读每本地日的最后一条——中间那几百条
   * 纯占地方。2026-09-03 实测生产库 1394 万行里 84.5% 属于这类，7.6GB 里的绝大部分；
   * 不收口的话 90 天保留期跑满约 1 亿行 / 60GB，磁盘会撑爆。判据在 store 那边，与
   * `day_last` 的口径逐字对齐。
   *
   * 每轮跑一点而不是每天跑一次：`DOWNSAMPLE_ROW_LIMIT` 已经是护栏，摊到每轮反而比攒到
   * 一次删更平滑，不会有某一轮突然卡住几十秒。稳态下每账户每轮只有几百行要删。
   *
   * 失败只吞掉：这是省磁盘的后台清理，它出问题不该让整轮同步失败。
   */
  private downsampleMetricSnapshots(accountId: string, providerKind: ProviderKind): void {
    try {
      this.store.downsampleMetricSnapshots(accountId, providerKind, {
        keepFullDays: METRIC_FULL_RESOLUTION_DAYS,
        limit: DOWNSAMPLE_ROW_LIMIT,
      });
    } catch {
      // 下一轮还会再来，不值得把整轮同步打掉。
    }
  }

  /**
   * 对账确认「只建了草稿」之后，自动把发布这最后一步补上。
   *
   * 此前这里只能留着红条等人去点「发布草稿」。但 `draft-only` 这个结论本身已经把最危险的
   * 不确定性消掉了：机器亲眼看到草稿还在后台，也就证明了那批组**没有**被建成正式对象——
   * 这一发不会建出重复的组。剩下的就是一次已经授权过的扩组/复制没做完的最后一步。
   *
   * **必须先等任务真的不在跑了。** `uncertain = 1` 是在**发第一个写请求之前**就打上的，
   * 所以一个正在跑的扩组和一个卡死的扩组在这里长得一模一样；而扩组本身就是「先建草稿再
   * 发布」，正在跑的那一刻后台必然有草稿。不加这道闸门，一次与轮询撞上的手动扩组会被这里
   * 抢先把它自己的草稿发掉，然后它自己再发一次——同一批组建成两份。判据用领取时间，阈值
   * 与幂等表判「租约过期」的那个 30 分钟对齐：那个时刻之后，系统本来就认为这条任务不在跑了。
   *
   * **失败要计次。** 发不出去的草稿是有的：被人手动删了、同名草稿有多份、连系列都还没建。
   * 不计次，这类记录会在每一轮轮询里重敲一次 TikTok 的创建接口。试满就停手，把最后一次的
   * 原因留在记录上，红条继续挂着交人工。
   *
   * 整个过程绝不让异常冒出去：这是轮询里的收尾动作，它失败不该把整轮同步打掉。
   */
  private async publishDraftOnly(input: {
    taskKey: string;
    attempts: number;
    claimedAt: string;
    publish: ((taskKey: string) => Promise<unknown>) | undefined;
    recordFailure: (message: string) => void;
  }): Promise<void> {
    if (!input.publish) return;
    if (input.attempts >= DRAFT_PUBLISH_MAX_ATTEMPTS) return;
    const claimedAt = Date.parse(input.claimedAt);
    // 时间戳读不出来 = 不知道这条是不是还在跑 = 不碰。宁可红条多留一轮。
    if (!Number.isFinite(claimedAt)) return;
    if (Date.now() - claimedAt < DRAFT_PUBLISH_MIN_TASK_AGE_MS) return;
    try {
      await input.publish(input.taskKey);
    } catch (cause) {
      try {
        input.recordFailure(safeMessage(cause));
      } catch {
        // 记账失败也只是少一行解释，不值得把整轮同步打掉。
      }
    }
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

/**
 * 一个轮询批次里同时处理多少个账户。
 *
 * 账户之间没有任何数据依赖：各自的 Cookie、各自的实体、各自的写入熔断器，
 * 每账户的重入由 runningAccounts 单独兜着。串行纯粹是在排队等网络。
 *
 * 不拉满的理由是出口：所有账户共用同一个出口 IP（还可能是同一个代理），真正打到
 * TikTok 的峰值是「账户并发 × 层内并发」。3 × 5 = 15，接近一个普通浏览器同域并发
 * 的量级。要加并发优先动这个数，层内那两个受单账户数据量约束，上界更难预测。
 */
const pollAccountConcurrency = 3;

/** 定时执行器（申诉、定时启停、过夜排期、删除）的评估间隔。 */
const maintenanceTickIntervalMs = 30_000;
/** 轮询到期检查的间隔。真正的每账户节奏由各自的轮询间隔设置决定。 */
const pollTickIntervalMs = 30_000;
/** 进程刚起来时先让存储和连接就绪，别在启动瞬间抢跑。 */
const initialTickDelayMs = 5_000;

export class AutomationScheduler {
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private maintaining = false;
  private polling = false;
  /**
   * 每账户最近一次轮询**结束**的时刻。
   *
   * 到期判定原先读的是连接上的 lastTestedAt，而它是在每个账户轮询**开头**的连接
   * 检测里刷新的，于是这一轮自身的耗时被算进了下一轮的间隔里：一轮跑 6 分钟、间隔
   * 设 5 分钟，跑完立刻又到期，轮询退化成「跑完马上再跑」，设置里的间隔形同虚设。
   * 排在队尾的账户还要额外背上前面所有账户的耗时。
   *
   * 改成从本轮结束起算，并与连接检测彻底解耦——后者现在不是每轮都跑了。
   * 只存在内存里：轮询节奏不需要持久化，重启后按 lastTestedAt 重新起算即可。
   */
  private readonly lastPolledAt = new Map<string, number>();

  constructor(
    private readonly store: AutomationStore,
    private readonly service: AutomationService,
    private readonly notifications?: PollNotificationDispatcher,
  ) {}

  start(): void {
    if (this.maintenanceTimer || this.pollTimer) return;
    // 两条独立的循环，各自有各自的重入锁。
    //
    // 合成一条的代价是实测过的：轮询长跑期间，新的一跳会被重入锁整个丢掉，而定时
    // 执行器和轮询同在那一跳里，于是一起被丢。自动申诉只在每个整点的第 0 分钟这一
    // 分钟内有机会（30 秒一跳 = 2 次机会），一轮长跑跨过整点，这一小时的申诉就整个
    // 不跑；定时启停（含过夜零点开回来）同样被推迟到长跑结束。
    // 定时执行器全是本地判定 + 少量写，跟慢速的只读同步没有任何理由绑在一起。
    this.maintenanceTimer = setInterval(
      () => void this.runMaintenance(),
      maintenanceTickIntervalMs,
    );
    this.maintenanceTimer.unref?.();
    this.pollTimer = setInterval(() => void this.runPollCycle(), pollTickIntervalMs);
    this.pollTimer.unref?.();
    setTimeout(() => void this.tick(), initialTickDelayMs).unref?.();
  }

  stop(): void {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.maintenanceTimer = null;
    this.pollTimer = null;
  }

  /** 两条循环各跑一次。生产上由 start() 分别驱动，这里供手动触发与测试使用。 */
  async tick(): Promise<void> {
    await this.runMaintenance();
    await this.runPollCycle();
  }

  /**
   * 定时执行器：过夜排期、自动申诉、到期定时启停、自动删除。
   *
   * 全部按账户本地时间判定窗口，窗口最窄的（自动申诉）只有一分钟，所以这条循环
   * 必须准时，且不能被只读同步的耗时挤掉。
   */
  async runMaintenance(): Promise<void> {
    if (this.maintaining) return;
    this.maintaining = true;
    try {
      if (!this.store.getSystemRuntimeState().enabled) return;
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
          // 同理待在这里而不是 dueAccounts 循环里：它也靠「整点小时内任意一轮」触发，
          // 挂在轮询到期过滤之后会几乎永远错过计划小时。
          await this.service.runScheduledDailyEnables(account.id);
          // 同理：靠「整点小时内任意一轮」触发，必须待在轮询到期过滤之前的全账户循环里。
          await this.service.runScheduledStalledCampaignClose(account.id);
        }
      }
    } finally {
      this.maintaining = false;
    }
  }

  /** 只读同步 + 规则执行。慢的那条，被跳过只影响数据新鲜度，不影响定时执行器。 */
  async runPollCycle(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      if (!this.store.getSystemRuntimeState().enabled) return;
      const metaRuntime = this.store.getMetaAutomationRuntime();
      const accounts = this.store.listAccounts();
      this.forgetRemovedAccounts(accounts);
      const dueAccounts = accounts.filter((account) => {
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
        // 存的是「上一轮结束时刻」而不是「下一次到期时刻」：间隔设置改小之后要立刻
        // 生效，存到期时刻会让新间隔等一个旧周期才开始起作用。
        const startedFrom = this.lastPolledAt.get(account.id)
          ?? (connection.lastTestedAt
            ? new Date(connection.lastTestedAt).getTime()
            : null);
        if (startedFrom === null) return true;
        return Date.now() >= startedFrom + pollingIntervalMinutes * 60_000;
      });
      if (dueAccounts.length === 0) return;

      const cycle = this.store.createPollCycle();
      // 账户之间并发，但仍然是同一个批次。
      //
      // 「一个账户一个批次」也能做，但会改掉消息推送的契约：现在是每个存在到期账户
      // 的批次结束后各渠道发一份账户汇总，拆开就变成每账户一条，用户那边的推送量
      // 直接乘以账户数。批次内并发已经把该拿的都拿到了——一轮的耗时从「所有账户
      // 相加」变成「最慢的那条链」，而账户之间本来就没有任何数据依赖。
      //
      // 上限的意义和素材层一样：这些请求最终从同一个出口 IP 发出去，账户并发 ×
      // 层内并发才是真正打到 TikTok 的峰值（3 × 5 = 15）。要调先调这里，别去调
      // 层内的，层内那两个的上界受单账户数据量约束，更难预测。
      await mapWithConcurrency(dueAccounts, pollAccountConcurrency, async (account) => {
        try {
          await this.pollAccount(cycle.id, account);
        } catch (cause) {
          // 一个账户失败不能带走整批：这里必须自己吞掉，否则会把其余账户的结果
          // 一起拒绝掉。失败如实记进本批次的账户结果里。
          const message = safeMessage(cause);
          // 撞上账户锁说明上一轮还没跑完，这一轮本来就不该跑，不是失败。记成 skipped
          // 才不会污染「连续失败」的计数，也不会在报表里显示成执行失败。
          const busy = cause instanceof AutomationBusyError;
          this.store.savePollAccountResult(cycle.id, {
            accountId: account.id,
            accountName: account.displayName,
            runId: null,
            status: busy ? "skipped" : "failed",
            enabledCount: 0,
            disabledCount: 0,
            failureCount: busy ? 0 : 1,
            message,
            failureKind: busy ? null : pollFailureKind(message),
          });
        } finally {
          this.lastPolledAt.set(account.id, Date.now());
        }
        return null;
      });
      const completed = this.store.finishPollCycle(cycle.id);
      try {
        await this.notifications?.enqueueAndDispatch(completed);
      } catch {
        // The completed poll cycle remains available for audit and retry.
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollAccount(
    cycleId: string,
    account: ReturnType<AutomationStore["listAccounts"]>[number],
  ): Promise<void> {
    // 连接检测原先每个到期账户每轮都跑一次，紧接着就是一次真实的只读同步——同一
    // 个会话连查两遍，每账户白白多一次往返。同步成功本身就是最强的连接检测（见
    // runAccount 里同步成功后的状态回写），所以 ready 的账户不再单独探。
    // 非 ready 的必须探：那是失效连接自动恢复的唯一入口，省掉就再也回不来了。
    if (this.store.getProviderConnection(account.id, account.providerKind)?.status !== "ready") {
      await this.service.checkAccountConnection(account.id);
    }
    const connection = this.store.getProviderConnection(
      account.id,
      account.providerKind,
    );
    if (!account.enabled) {
      this.store.savePollAccountResult(cycleId, {
        accountId: account.id,
        accountName: account.displayName,
        runId: null,
        status: "skipped",
        enabledCount: 0,
        disabledCount: 0,
        failureCount: 0,
        message: "账户自动化已关闭。",
      });
      return;
    }
    if (connection?.status !== "ready") {
      const message = connection?.lastMessage ?? "账户连接检测失败。";
      this.store.savePollAccountResult(cycleId, {
        accountId: account.id,
        accountName: account.displayName,
        runId: null,
        status: "failed",
        enabledCount: 0,
        disabledCount: 0,
        failureCount: 1,
        message,
        failureKind: pollFailureKind(message),
      });
      return;
    }
    const run = await this.service.runAccount(account.id, "scheduler");
    if (account.platform === "tiktok") {
      await this.service.runScheduledAutoCopies(account.id);
      // 与自动复制同一处触发：两者判据同源（当天转化 + CPA），跟着同一批新鲜数据走，
      // 免得一个用刚同步的数、另一个用上一轮的。
      await this.service.runScheduledBudgetBumps(account.id);
    }
    const counts = this.store.summarizeAutomationRun(run.id);
    const failed = run.status === "failed" || counts.failureCount > 0;
    this.store.savePollAccountResult(cycleId, {
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
      failureKind: failed ? pollFailureKind(run.errorMessage) : null,
    });
  }

  private forgetRemovedAccounts(
    accounts: ReturnType<AutomationStore["listAccounts"]>,
  ): void {
    if (this.lastPolledAt.size === 0) return;
    const known = new Set(accounts.map((account) => account.id));
    for (const accountId of this.lastPolledAt.keys()) {
      if (!known.has(accountId)) this.lastPolledAt.delete(accountId);
    }
  }
}

/**
 * 能走定向回读的层级。素材不在其列：它没有独立的列表筛选接口，只能跟着广告一起
 * 拉（见 cookie-provider 的 mix_material 报表），退回全量同步。
 */
function isTargetedReadbackEntity(
  entityType: SyncEntityType,
): entityType is "campaign" | "ad-group" | "ad" {
  return entityType === "campaign" || entityType === "ad-group" || entityType === "ad";
}

function safeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "自动化任务失败。";
}

/**
 * 「抖一下」而不是「真的坏了」——只认错误文本，这样轮询结果落库之后还能再判一次。
 *
 * 连接健康检查用它决定要不要保留 ready；轮询结果用它给 failure_kind 打标，账户失效
 * 提醒再据此决定要不要 @所有人。两处必须同源：否则会出现健康检查判定「暂时的网络
 * 问题、保留最近验证成功状态」而提醒仍然喊「连接失效、投放停摆」的矛盾。
 */
function isTransientFailureMessage(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes("timed out")
    || text.includes("timeout")
    || text.includes("operation was aborted")
    || text.includes("fetch failed")
    || text.includes("econnreset")
    || text.includes("econnrefused")
    || text.includes("socket hang up")
    // 上一轮还没跑完，下一轮又到点了：被账户锁挡下来，跟连接本身无关。
    || text.includes("已有检测任务正在运行")
    || text.includes("已有任务正在执行");
}

function isTransientHealthCheckFailure(cause: unknown): boolean {
  const name = cause instanceof Error ? cause.name.toLowerCase() : "";
  return name === "aborterror"
    || name === "timeouterror"
    || isTransientFailureMessage(safeMessage(cause));
}

/** 轮询结果落库时给失败分类，供账户失效提醒判断要不要惊动所有人。 */
function pollFailureKind(message: string | null): PollFailureKind {
  return message && isTransientFailureMessage(message) ? "transient" : "persistent";
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
