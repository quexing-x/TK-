import { createHash, randomUUID } from "node:crypto";
import {
  MetaAccessSecretBundleInputSchema,
  ProviderCredentialInputSchema,
  assertCampaignNameAvailable,
  dateKeyInTimeZone,
  dateTimeSuffix,
  monthDaySuffix,
  stripGeneratedNameSuffixes,
  getCreationTemplateReadiness,
  defaultCreationPresetConfig,
  planCampaignCopy,
  selectStaleDrafts,
  stripAutomaticAdGroupNameSuffixes,
  brandRootName,
  buildExpandSheetPlan,
  buildLineageReport,
  collectReservedNames,
  LaunchAgeRangeValues,
  DRAFT_AD_STATUS,
  DRAFT_CLEANUP_MIN_AGE_HOURS,
  type ExpandSheetPlan,
  type ExpandSheetSource,
  type LaunchAgeRange,
  type LineageInput,
  type ProviderKind,
  type ReadOnlySyncResult,
  type LaunchPlanItemRecord,
  type CreationPresetConfig,
  type LaunchConfigurationRow,
  type LaunchCreationProgress,
  type LaunchCopyPreviewInput,
  type LaunchCopyPreviewRecord,
  type LaunchOriginalPost,
  type LaunchSourceSnapshot,
  type LaunchTargetPostMapping,
  type WriteTaskActor,
  allocateExpandBaseName,
} from "@tk-auto/core";
import type { CredentialVault } from "@tk-auto/credentials";
import {
  ProviderRegistry,
  RetryableCreationError,
  UnknownCreationStateError,
  type CreationMutation,
  type ProviderContext,
} from "@tk-auto/providers";
import { AutomationStore, LaunchPlanStore } from "@tk-auto/storage";
import { WriteTaskKernel, withLeaseHeartbeat } from "./write-task-kernel.js";

const launchLeaseTimeoutMs = 30 * 60 * 1000;
const launchLeaseHeartbeatMs = 60 * 1000;

export interface LaunchExecutionItemResult {
  itemId: string;
  accountId: string;
  status: LaunchPlanItemRecord["status"];
  message: string;
  syncWarning: string | null;
  /** Legacy response compatibility for callers that still inspect ok/created/sync. */
  ok: boolean;
  created: Array<{
    ok: boolean;
    campaignId?: string;
    adGroupId?: string;
    adId?: string;
    message: string;
  }>;
  sync: ReadOnlySyncResult | null;
  /** TikTok accepted the publish mutation; the ordinary account poll owns readback. */
  pendingReadback?: boolean;
}

export class LaunchService {
  private readonly launchStore: LaunchPlanStore;
  private readonly tasks: WriteTaskKernel<
    LaunchPlanItemRecord,
    { campaignId: string; adGroupId: string; adId?: string; warning?: string },
    "pending" | "failed" | "unknown"
  >;

  constructor(
    private readonly store: AutomationStore,
    private readonly vault: CredentialVault,
    private readonly providers: ProviderRegistry,
  ) {
    this.launchStore = new LaunchPlanStore(this.store);
    this.tasks = new WriteTaskKernel({
      claim: (taskId, executorId, expectedStatus, actor) =>
        this.launchStore.claim(taskId, executorId, expectedStatus, actor),
      succeed: (taskId, executorId, ids) =>
        this.launchStore.succeed(taskId, executorId, ids),
      fail: (taskId, executorId, message) =>
        this.launchStore.fail(taskId, executorId, message),
      unknown: (taskId, executorId, message) =>
        this.launchStore.unknown(taskId, executorId, message),
    });
    // A second local API instance or hot reload can overlap an active request.
    // Only an expired lease is treated as interrupted; progress callbacks renew
    // claimedAt while the provider chain advances.
    this.recoverExpiredLeases();
  }

  async createCopyPreview(input: LaunchCopyPreviewInput): Promise<LaunchCopyPreviewRecord> {
    const sourceAccount = this.store.getAccount(input.sourceAccountId);
    if (!sourceAccount) throw new Error("源广告账户不存在。");
    const sourceConnection = this.store.getProviderConnection(
      input.sourceAccountId,
      sourceAccount.providerKind,
    );
    if (!sourceConnection || sourceConnection.status !== "ready") {
      throw new Error(`源账户“${sourceAccount.displayName}”未通过连接检测。`);
    }
    this.providers.requireAccountCapability(
      sourceAccount.id,
      sourceAccount.providerKind,
      sourceConnection,
      "read-ad-groups",
    );
    const managed = this.store.listCurrentManagedEntities(sourceAccount.id, sourceAccount.providerKind);
    const sourceContext = await this.loadProviderContext(sourceAccount.id, sourceAccount.providerKind);
    const sourceAdGroupIds = [...new Set(input.sourceAdGroupIds?.length
      ? input.sourceAdGroupIds
      : [input.sourceAdGroupId])];
    const sourceSnapshots: LaunchSourceSnapshot[] = [];
    for (const sourceAdGroupId of sourceAdGroupIds) {
      const adGroup = managed.find(
        (entity) => entity.entityType === "ad-group" && entity.externalId === sourceAdGroupId,
      );
      if (!adGroup?.parentCampaignId) {
        throw new Error(`源广告组 ${sourceAdGroupId} 不存在或缺少稳定的 Campaign ID，请先同步源账户。`);
      }
      const campaign = managed.find(
        (entity) => entity.entityType === "campaign" && entity.externalId === adGroup.parentCampaignId,
      );
      if (!campaign) throw new Error(`源广告组“${adGroup.name}”所属推广系列不在当前同步快照中。`);
      const sourceDetail = await this.providers.readAdGroupOriginalPosts(
        sourceAccount.providerKind,
        sourceContext,
        { campaignId: campaign.externalId, adGroupId: adGroup.externalId },
      );
      const sourcePosts = sourceDetail.posts.filter((post) => post.promotable);
      if (sourcePosts.length !== sourceDetail.posts.length || sourcePosts.length === 0) {
        throw new Error(`源广告组“${adGroup.name}”包含不可推广或已失效的帖子，无法迁移。`);
      }
      if (sourcePosts.length > 500) {
        throw new Error(`源广告组“${adGroup.name}”有 ${sourcePosts.length} 条帖子，超过单组上限 500 条。`);
      }
      sourceSnapshots.push({
        accountId: sourceAccount.id,
        campaignId: campaign.externalId,
        campaignName: campaign.name,
        adGroupId: adGroup.externalId,
        adGroupName: adGroup.name,
        posts: sourcePosts,
        productUrl: sourceDetail.productUrl,
        productInfo: sourceDetail.productInfo,
        catalogSetup: sourceDetail.catalogSetup,
        structuralHash: originalPostsHash(sourcePosts),
        fetchedAt: new Date().toISOString(),
      });
    }
    const targetPostMappings: LaunchTargetPostMapping[] = await Promise.all(
      [...new Set(input.targetAccountIds)].map(async (accountId) => {
        const account = this.store.getAccount(accountId);
        if (!account) throw new Error(`目标账户 ${accountId} 不存在。`);
        const connection = this.store.getProviderConnection(account.id, account.providerKind);
        if (!connection || connection.status !== "ready") {
          throw new Error(`目标账户“${account.displayName}”未通过连接检测。`);
        }
        this.providers.requireAccountCapability(
          account.id,
          account.providerKind,
          connection,
          "create-campaigns",
        );
        try {
          const context = await this.loadProviderContext(account.id, account.providerKind);
          const mappings: LaunchTargetPostMapping[] = [];
          for (const snapshot of sourceSnapshots) {
            const posts = await this.providers.readAccessibleOriginalPosts(
              account.providerKind,
              context,
              snapshot.posts,
            );
            mappings.push({
              accountId,
              sourceAdGroupId: snapshot.adGroupId,
              posts,
              evidenceHash: originalPostsHash(posts),
              verifiedAt: new Date().toISOString(),
            });
          }
          return mappings;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`目标账户“${account.displayName}”原帖检查失败：${message}`);
        }
      }),
    ).then((mappings) => mappings.flat());
    return this.store.createLaunchCopyPreview(input, sourceSnapshots, targetPostMappings);
  }

  async execute(
    planId: string,
    actor: WriteTaskActor = { id: "local-user", name: "本地用户", kind: "user" },
  ): Promise<{
    plan: NonNullable<ReturnType<AutomationStore["getMultiAccountLaunchPlan"]>>;
    results: LaunchExecutionItemResult[];
  }> {
    this.recoverExpiredLeases();
    const plan = this.launchStore.getPlan(planId);
    if (!plan) throw new Error("投放计划不存在。");
    if (plan.status === "cancelled") throw new Error("投放计划已取消。");
    if (plan.status === "completed") return { plan, results: [] };
    const allItems = this.launchStore.listItems(planId);
    if (allItems.length === 0) {
      throw new Error("旧版计划没有逐项执行记录；为避免重复创建，请重新导入并创建计划。");
    }
    if (!plan.presetSnapshot) {
      throw new Error("旧版计划缺少冻结的创建预设，请重新导入并创建计划。");
    }
    const readiness = getCreationTemplateReadiness(plan.presetSnapshot.creationConfig);
    if (!readiness.ready) {
      throw new Error(`广告预设缺少 ${readiness.missingFieldCount} 项真实创建参数，批量创建已阻止。`);
    }

    // Plan execution claims only pending items. Failed items are retried only
    // through retryItem with an explicit itemId.
    const candidates = allItems.filter((item) => item.status === "pending");
    const groupsByAccount = groupLaunchItemsByAccountAndCampaign(candidates);
    const accountResults = await Promise.all(
      [...groupsByAccount.values()].map(async (groups) => {
        const results = [];
        // A Cookie account has one mutable Ads Manager draft/session context.
        // Different campaigns for the same account must therefore be created
        // serially; otherwise one source group can overwrite the draft state
        // another group is validating or reading back. Separate accounts stay
        // independent and may still execute in parallel.
        for (const group of groups) {
          results.push(await this.executeSeriesBatch(
            plan.presetSnapshot!.creationConfig,
            group,
            actor,
          ));
        }
        return results;
      }),
    );
    const itemOrder = new Map(candidates.map((item) => [item.itemId, item.itemIndex]));
    const results = accountResults
      .flat(2)
      .sort((left, right) => (itemOrder.get(left.itemId) ?? 0) - (itemOrder.get(right.itemId) ?? 0));

    return {
      plan: this.launchStore.refresh(planId),
      results,
    };
  }

  async retryItem(
    planId: string,
    itemId: string,
    actor: WriteTaskActor = { id: "local-user", name: "本地用户", kind: "user" },
  ): Promise<{
    plan: NonNullable<ReturnType<AutomationStore["getMultiAccountLaunchPlan"]>>;
    results: LaunchExecutionItemResult[];
  }> {
    this.recoverExpiredLeases();
    const plan = this.launchStore.getPlan(planId);
    if (!plan) throw new Error("投放计划不存在。");
    if (plan.status === "cancelled") throw new Error("投放计划已取消。");
    if (!plan.presetSnapshot) throw new Error("投放计划缺少冻结的创建预设。");
    const readiness = getCreationTemplateReadiness(plan.presetSnapshot.creationConfig);
    if (!readiness.ready) {
      throw new Error(`广告预设缺少 ${readiness.missingFieldCount} 项真实创建参数，重试已阻止。`);
    }
    const item = this.launchStore.listItems(planId).find((candidate) => candidate.itemId === itemId);
    if (!item) throw new Error("创建任务不存在或不属于当前计划。");
    if (item.status !== "failed" && item.status !== "unknown") {
      throw new Error("只有失败或待远端核验的创建任务可以单项处理。");
    }
    const results = await this.executeSeriesBatch(plan.presetSnapshot.creationConfig, [item], actor);
    if (results.length === 0) throw new Error("创建任务正在执行或状态已经变化。");
    return {
      plan: this.launchStore.refresh(planId),
      results,
    };
  }

  private async executeSeriesBatch(
    preset: CreationPresetConfig,
    candidates: LaunchPlanItemRecord[],
    actor: WriteTaskActor,
  ): Promise<LaunchExecutionItemResult[]> {
    const executorId = randomUUID();
    const reconcileOnlyItemIds = new Set(
      candidates.filter((item) => item.status === "unknown").map((item) => item.itemId),
    );
    const claimed = candidates.flatMap((candidate) => {
      if (!["pending", "failed", "unknown"].includes(candidate.status)) return [];
      const item = this.tasks.claim(
        candidate.itemId,
        executorId,
        candidate.status as "pending" | "failed" | "unknown",
        actor,
      );
      return item ? [item] : [];
    });
    if (claimed.length === 0) return [];

    // 提到 try 之外：catch 里要用它们收口。
    const preflightFailures: LaunchExecutionItemResult[] = [];
    const batch: LaunchPlanItemRecord[] = [];
    let providerInvoked = false;
    try {
      const first = claimed[0]!;
      if (claimed.some((item) => item.accountId !== first.accountId)) {
        throw new Error("系列批次包含多个账户，无法执行。");
      }
      if (claimed.some((item) => item.launchRow.campaignName.trim() !== first.launchRow.campaignName.trim())) {
        throw new Error("系列批次包含多个系列，无法执行。");
      }
      if (claimed.some((item) => item.templateMode !== first.templateMode)) {
        throw new Error("系列批次包含不同创建模式，无法执行。");
      }
      if (claimed.some((item) => item.launchRow.initialStatus !== first.launchRow.initialStatus)) {
        throw new Error("同系列广告组的初始状态不一致，无法同步发布。");
      }

      const account = this.store.getAccount(first.accountId);
      if (!account) throw new Error("目标广告账户不存在。");
      const connection = this.store.getProviderConnection(first.accountId, account.providerKind);
      if (!connection || connection.status !== "ready") {
        throw new Error("目标账户未通过连接验证。");
      }
      this.providers.requireAccountCapability(
        first.accountId,
        account.providerKind,
        connection,
        "create-campaigns",
      );
      // 逐条预检：坏的那条单独标失败并从批次里剔除，其余照常创建。此前这些校验
      // 直接 throw，任何一条不合格都会把整个系列批次拖垮——十条里有一条帖子证据
      // 对不上，另外九条明明没问题也一起判失败。
      const failItem = (item: LaunchPlanItemRecord, cause: unknown): void => {
        const message = safeError(cause);
        this.tasks.fail(item.itemId, executorId, message);
        preflightFailures.push({
          itemId: item.itemId,
          accountId: item.accountId,
          status: "failed",
          message,
          syncWarning: null,
          ok: false,
          created: [{ ok: false, message }],
          sync: null,
        });
      };

      const preflighted: LaunchPlanItemRecord[] = [];
      for (const item of claimed) {
        try {
          this.store.validateLaunchCopyItem(item);
          if (!item.attemptId) throw new Error("创建任务缺少 attemptId，禁止调用 Provider。");
          if (item.templateMode === "copy" && !item.templateCampaignId) {
            throw new Error("复制计划没有冻结 templateCampaignId，禁止执行且不会按系列名称回退。");
          }
          preflighted.push(item);
        } catch (cause) {
          failItem(item, cause);
        }
      }
      const context = await this.loadProviderContext(first.accountId, account.providerKind);
      const connectionFingerprint = creationConnectionFingerprint(connection);
      const refreshedPosts = new Map<string, LaunchOriginalPost[]>();
      // 回读原帖证据同样逐条隔离：某个目标账户没授权到这条帖子，只该跳过它自己。
      for (const item of preflighted) {
        try {
          const posts = await this.refreshLaunchCopyEvidence(item, context);
          if (posts) refreshedPosts.set(item.itemId, posts);
          this.store.validateLaunchCopyItem(item);
          batch.push(item);
        } catch (cause) {
          failItem(item, cause);
        }
      }
      // 全部都没过预检才算整批没得跑；此时不该再调用 Provider。
      if (batch.length === 0) return preflightFailures;

      const validateBeforeDispatch = () => {
        const currentAccount = this.store.getAccount(first.accountId);
        if (!currentAccount || currentAccount.providerKind !== account.providerKind) {
          throw new Error("目标账户配置已变化，批量创建已阻止。");
        }
        const dispatchConnection = this.store.getProviderConnection(
          first.accountId,
          currentAccount.providerKind,
        );
        if (
          !dispatchConnection
          || creationConnectionFingerprint(dispatchConnection) !== connectionFingerprint
        ) {
          throw new Error("目标账户授权或凭据已变更，批量创建已阻止。");
        }
        this.providers.requireAccountCapability(
          first.accountId,
          currentAccount.providerKind,
          dispatchConnection,
          "create-campaigns",
        );
        if (!batch.every((item) => this.launchStore.renew(item.itemId, executorId))) {
          throw new Error("创建批次执行权已变化，当前请求未发送。");
        }
      };

      // 同名系列自动复用：账户里已经有同名系列时，只往里面加广告组，不再新建系列。
      // 此前只在同一批次内按系列名复用（Provider 侧的 reservations.campaignIds），
      // 跨批次遇到线上已存在的同名系列仍会去新建，被 TikTok 判重名拒绝。
      const reusableCampaignId = resolveExistingCampaignIdByName(
        this.store.listCurrentManagedEntities(first.accountId, account.providerKind),
        first.launchRow.campaignName,
      );

      const mutations: CreationMutation[] = batch.map((item) => ({
        row: item.launchRow,
        preset,
        initialStatus: item.launchRow.initialStatus,
        templateMode: item.templateMode,
        ...(reusableCampaignId ? { batchCampaignId: reusableCampaignId } : {}),
        ...(item.templateCampaignId ? { templateCampaignId: item.templateCampaignId } : {}),
        ...(refreshedPosts.has(item.itemId)
          ? { originalPosts: refreshedPosts.get(item.itemId)! }
          : {}),
        ...(item.sourceSnapshot?.productInfo
          ? { originalProductInfo: item.sourceSnapshot.productInfo }
          : {}),
        ...(item.sourceSnapshot?.catalogSetup === 0 || item.sourceSnapshot?.catalogSetup === 1
          ? { originalCatalogSetup: item.sourceSnapshot.catalogSetup }
          : {}),
        operationId: item.operationId,
        attemptId: item.attemptId!,
        correlationId: item.correlationId,
        ...(account.providerKind === "cookie" ? { deferReadback: true } : {}),
        ...(reconcileOnlyItemIds.has(item.itemId)
          ? { reconcileOnly: true, reconcileEvidence: item.evidence }
          : {}),
        onBeforeDispatch: validateBeforeDispatch,
        onProgress: (progress: LaunchCreationProgress) => {
          this.launchStore.progress(item.itemId, executorId, progress);
        },
      }));

      validateBeforeDispatch();
      providerInvoked = true;
      const createdResults = await withLeaseHeartbeat(
        () => this.providers.createFromPreset(account.providerKind, context, mutations),
        () => batch.every((item) => this.launchStore.renew(item.itemId, executorId)),
        launchLeaseHeartbeatMs,
      );
      const byAttemptId = new Map(
        createdResults
          .filter((result) => result.attemptId)
          .map((result) => [result.attemptId!, result]),
      );
      const byOperationId = new Map(
        createdResults
          .filter((result) => result.operationId)
          .map((result) => [result.operationId!, result]),
      );
      const outputs: LaunchExecutionItemResult[] = [];
      const successes: Array<{
        item: LaunchPlanItemRecord;
        created: NonNullable<(typeof createdResults)[number]>;
        output: LaunchExecutionItemResult;
      }> = [];
      for (const [index, item] of batch.entries()) {
        const created = (item.attemptId ? byAttemptId.get(item.attemptId) : undefined)
          ?? byOperationId.get(item.operationId)
          ?? createdResults[index];
        if (!created?.ok || !created.campaignId || !created.adGroupId) {
          const message = created?.ok
            ? "Provider 已返回成功但缺少完整的系列或广告组 ID，真实结果仍需远端核验。"
            : created?.message ?? "Provider 未返回本广告组的创建结果。";
          const unknown = !created
            || created.ok
            || created.failureKind === "unknown"
            || created.retrySafe === false
            || (reconcileOnlyItemIds.has(item.itemId)
              && created.reconciliationVerifiedAbsent !== true);
          if (unknown) this.tasks.unknown(item.itemId, executorId, message);
          else this.tasks.fail(item.itemId, executorId, message);
          outputs.push({
            itemId: item.itemId,
            accountId: item.accountId,
            status: unknown ? "unknown" : "failed",
            message,
            syncWarning: null,
            ok: false,
            created: [{ ok: false, message }],
            sync: null,
            ...(created?.pendingReadback ? { pendingReadback: true } : {}),
          });
          continue;
        }
        const successIds = {
          campaignId: created.campaignId,
          adGroupId: created.adGroupId,
          ...(created.adId ? { adId: created.adId } : {}),
          ...(created.warning ? { warning: created.warning } : {}),
        };
        try {
          this.tasks.succeed(item.itemId, executorId, successIds);
        } catch {
          // Provider is already terminal-successful. Retry only the local
          // transaction; never resend the TikTok batch because of a transient
          // SQLite write failure.
          this.tasks.succeed(item.itemId, executorId, successIds);
        }
        const output: LaunchExecutionItemResult = {
          itemId: item.itemId,
          accountId: item.accountId,
          status: "succeeded",
          message: created.message,
          syncWarning: created.warning ?? null,
          ok: true,
          created: [{
            ok: true,
            campaignId: created.campaignId,
            adGroupId: created.adGroupId,
            ...(created.adId ? { adId: created.adId } : {}),
            message: created.message,
          }],
          sync: null,
        };
        outputs.push(output);
        successes.push({ item, created, output });
      }

      if (successes.length > 0) {
        let commonSyncWarnings: string[] = [];
        let syncResult: ReadOnlySyncResult | null = null;
        let syncEntities: Awaited<ReturnType<ProviderRegistry["syncReadOnly"]>>["entities"] = [];
        let syncCompleted = false;
        try {
          const sync = await this.providers.syncReadOnly(account.providerKind, context);
          syncResult = sync.result;
          syncEntities = sync.entities;
          this.store.saveReadOnlySync(first.accountId, account.providerKind, sync.entities, sync.result);
          syncCompleted = true;
          if (sync.result.quality.status !== "healthy" || sync.result.warnings.length > 0) {
            commonSyncWarnings = [
              ...(sync.result.quality.status !== "healthy"
                ? [`创建后同步质量为 ${sync.result.quality.status}`]
                : []),
              ...sync.result.warnings,
            ];
          }
        } catch (cause) {
          commonSyncWarnings.push(safeError(cause));
          this.store.updateProviderStatus(
            first.accountId,
            account.providerKind,
            "failed",
            `创建后同步异常：${commonSyncWarnings.join("；")}`,
          );
        }
        for (const success of successes) {
          // Original-post migration resolves its published asset-group id via
          // get_creative_fields_by_ad before the provider reports success.
          // That asset group is not guaranteed to appear in the ordinary ad
          // statistics list, so an empty ad list must not invalidate the
          // stronger object-specific readback evidence.
          const originalPostAssetVerified = Boolean(
            success.item.sourceSnapshot && success.created.adId,
          );
          const itemSyncWarnings = commonSyncWarnings.filter((warning) =>
            !(originalPostAssetVerified
              && warning === "ad 响应成功，但暂未识别到列表数据。"),
          );
          const missing = [
            ["campaign", success.created.campaignId] as const,
            ["ad-group", success.created.adGroupId] as const,
            ...(success.created.adId ? [["ad", success.created.adId] as const] : []),
          ].filter(([entityType, externalId]) =>
            syncCompleted
            && !(originalPostAssetVerified && entityType === "ad")
            && !syncEntities.some((entity) => entity.entityType === entityType && entity.externalId === externalId),
          );
          const itemWarning = [
            success.output.syncWarning,
            ...itemSyncWarnings,
            ...(missing.length > 0 ? [`创建后未回读到：${missing.map(([type]) => type).join("、")}`] : []),
          ].filter(Boolean).join("；") || null;
          try {
            this.launchStore.sync(success.item.itemId, itemWarning);
          } catch (cause) {
            success.output.syncWarning = [itemWarning, `同步阶段记录失败：${safeError(cause)}`]
              .filter(Boolean)
              .join("；");
          }
          success.output.syncWarning ??= itemWarning;
          success.output.sync = syncResult;
        }
      }
      // 预检被剔除的那些必须一起回给调用方，否则界面上会凭空少几条。
      return [...preflightFailures, ...outputs];
    } catch (cause) {
      const message = safeError(cause);
      const unknown = providerInvoked && !(cause instanceof RetryableCreationError);
      // 预检之前就抛出（账户/系列/模式不一致等批次级不变量）时 batch 还是空的，
      // 此时要收口的是全部 claimed。
      const failing = batch.length > 0 ? batch : claimed;
      const current = new Map(
        this.launchStore.listItems(claimed[0]!.planId).map((item) => [item.itemId, item]),
      );
      return [...preflightFailures, ...failing.map((item): LaunchExecutionItemResult => {
        if (current.get(item.itemId)?.status === "running") {
          if (unknown) this.tasks.unknown(item.itemId, executorId, message);
          else this.tasks.fail(item.itemId, executorId, message);
        }
        return {
          itemId: item.itemId,
          accountId: item.accountId,
          status: unknown ? "unknown" : "failed",
          message,
          syncWarning: null,
          ok: false,
          created: [{ ok: false, message }],
          sync: null,
        };
      })];
    }
  }

  private recoverExpiredLeases(): void {
    const accepted = this.launchStore.recoverAcceptedReadbacks(
      new Date(Date.now() - launchLeaseHeartbeatMs * 2).toISOString(),
    );
    for (const planId of new Set(accepted.planIds)) {
      this.launchStore.refresh(planId);
    }
    this.launchStore.recover(
      new Date(Date.now() - launchLeaseTimeoutMs).toISOString(),
    );
    const resumed = this.launchStore.recoverLegacySeriesBlocks();
    for (const planId of new Set(resumed.planIds)) {
      this.launchStore.refresh(planId);
    }
  }

  private async refreshLaunchCopyEvidence(
    item: LaunchPlanItemRecord,
    targetContext: ProviderContext,
  ): Promise<LaunchOriginalPost[] | undefined> {
    if (!item.sourceSnapshot && !item.targetPostMapping) return undefined;
    if (!item.sourceSnapshot || !item.targetPostMapping) {
      throw new Error("原帖迁移任务缺少冻结的源帖子或目标帖子证据。");
    }
    const sourceAccount = this.store.getAccount(item.sourceSnapshot.accountId);
    if (!sourceAccount) throw new Error("原帖迁移的源账户不存在。");
    const sourceConnection = this.store.getProviderConnection(
      sourceAccount.id,
      sourceAccount.providerKind,
    );
    if (!sourceConnection || sourceConnection.status !== "ready") {
      throw new Error(`源账户“${sourceAccount.displayName}”未通过连接验证。`);
    }
    this.providers.requireAccountCapability(
      sourceAccount.id,
      sourceAccount.providerKind,
      sourceConnection,
      "read-ad-groups",
    );
    const sourceContext = await this.loadProviderContext(sourceAccount.id, sourceAccount.providerKind);
    const sourceDetail = await this.providers.readAdGroupOriginalPosts(
      sourceAccount.providerKind,
      sourceContext,
      {
        campaignId: item.sourceSnapshot.campaignId,
        adGroupId: item.sourceSnapshot.adGroupId,
      },
    );
    const expectedIds = item.sourceSnapshot.posts.map((post) => post.itemId);
    const currentPosts = sourceDetail.posts;
    if (currentPosts.some((post) => !post.promotable)
      || originalPostsHash(currentPosts) !== item.sourceSnapshot.structuralHash
      || JSON.stringify(sourceDetail.productInfo) !== JSON.stringify(item.sourceSnapshot.productInfo)
      || sourceDetail.catalogSetup !== item.sourceSnapshot.catalogSetup) {
      throw new Error("源广告组帖子在预览后已变化，或商品信息已更新，请重新生成迁移预览。");
    }
    const targetAccount = this.store.getAccount(item.accountId);
    if (!targetAccount) throw new Error("原帖迁移的目标账户不存在。");
    const targetPosts = await this.providers.readAccessibleOriginalPosts(
      targetAccount.providerKind,
      targetContext,
      item.sourceSnapshot.posts,
    );
    if (targetPosts.length !== expectedIds.length
      || targetPosts.some((post, index) => post.itemId !== expectedIds[index] || !post.promotable)) {
      const available = new Set(targetPosts.map((post) => post.itemId));
      const missing = expectedIds.filter((itemId) => !available.has(itemId));
      throw new Error(`目标账户无法继续使用帖子：${missing.join("、") || "帖子状态已变化"}。`);
    }
    return targetPosts;
  }

  private async loadProviderContext(
    accountId: string,
    providerKind: ProviderKind,
  ): Promise<ProviderContext> {
    const connection = this.store.getProviderConnection(accountId, providerKind);
    if (providerKind === "meta-marketing-api") {
      if (
        !connection
        || connection.settings.kind !== "meta-marketing-api"
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
        timezone: this.store.getAccount(accountId)?.timezone ?? "UTC",
      };
    }
    if (!connection?.credentialRef) throw new Error("接入参数或凭据尚未配置。");
    const secret = await this.vault.read(connection.credentialRef);
    if (!secret) throw new Error("凭据引用已经失效，请重新保存凭据。");
    return {
      accountId,
      settings: connection.settings,
      credential: ProviderCredentialInputSchema.parse(JSON.parse(secret)),
      timezone: this.store.getAccount(accountId)?.timezone ?? "UTC",
    };
  }

  /**
   * 把一条「结果未知」的扩组记录留在 TikTok 后台的草稿发布掉。
   *
   * 这类记录此前只有两条出路：人工去后台手动发布，或者一键清除（清除只是把红条摘掉，
   * 草稿仍然烂在后台）。对账判成 `draft-only` 的正是这类——机器已经能确认草稿存在，只差
   * 一个把它发出去的入口。
   *
   * **发布后直接投放，不再发成暂停。** 早先一律发成暂停，理由是「原始扩组是不是立即投放
   * 没有记录在案，悄悄开起来烧钱更严重」。实测下来这个取舍是反的：扩组本来就是为了投，
   * 发成暂停等于把「机器没做完的最后一步」换成「人必须记得去后台开一遍」，而那一步一忘
   * 就是一批建好却不投的组躺在后台——比多花一点钱更贵。发布链路里连带把克隆过来的广告
   * 也开起来，否则组开着而广告是关的，整组照样投不出去。
   *
   * 成功才收口。失败一律保持 uncertain，红条留着——包括「发出去了但结果未知」，那种情况
   * 恰恰最需要人去后台看一眼。
   */
  async publishStuckExpandDraft(taskKey: string): Promise<{
    ok: boolean;
    message: string;
    adGroupIds: string[];
  }> {
    const task = this.store.getUncertainAdGroupExpandTask(taskKey);
    if (!task) throw new Error("该扩组记录不存在，或已不处于「结果未知」状态。");
    if (!task.sourceCampaignId) {
      throw new Error("这条记录没有记下所属推广系列，无法定位草稿，请在 TikTok 后台手动发布。");
    }
    if (task.generatedNames.length === 0) {
      throw new Error("这条记录没有记下组名，无法定位草稿，请在 TikTok 后台手动发布。");
    }
    const account = this.store.getAccount(task.accountId);
    if (!account) throw new Error("账号不存在。");
    const connection = this.store.getProviderConnection(task.accountId, account.providerKind);
    if (!connection || connection.status !== "ready") {
      throw new Error("账户未通过连接检测，已阻止发布。");
    }
    // 与扩组同一道闸门：同一条创建会话 cURL、同一个发布接口。
    this.providers.requireAccountCapability(
      task.accountId,
      account.providerKind,
      connection,
      "copy-ads",
    );
    const context = await this.loadProviderContext(task.accountId, account.providerKind);
    const result = await this.providers.publishExistingDrafts(account.providerKind, context, {
      campaignId: task.sourceCampaignId,
      names: task.generatedNames,
      initialStatus: "enabled",
      publishedNames: this.publishedAdGroupNames(
        task.accountId,
        account.providerKind,
        task.sourceCampaignId,
      ),
    });
    if (!result.ok) {
      throw new Error(result.failureKind === "unknown"
        ? `${result.message}（发布请求已发出但结果无法确认，这条记录继续保留，请到 TikTok 后台核实）`
        : result.message);
    }
    this.store.confirmAdGroupExpandTask(taskKey);
    return {
      ok: true,
      message: result.message,
      adGroupIds: result.adGroupIds ?? [],
    };
  }

  /**
   * 把一条「结果未知」的系列复制记录留在 TikTok 后台的草稿广告组发布掉。
   *
   * 与扩组共用同一条已验证的链路（`publishExistingDrafts`），但多一个前置条件：**系列本身
   * 必须已经建出来了**。系列复制是「建系列草稿 + 建组草稿 → 一次性发布」，失败停在哪一步
   * 决定了后台留下的是什么：
   *
   * - 发布被 TikTok 部分受理（终态回来 2/3 个组）：系列已是正式系列，剩下的组是挂在它下面的
   *   草稿——这条链路能收口，正是这里做的事。
   * - 发布压根没发出去：后台只有一个「草稿系列」（campaign_id 为空、只有 campaign_sketch_id），
   *   发布它要连系列一起建，是另一条**没有抓包依据**的链路。这里不猜，交人工。
   *
   * 系列 ID 从最近一次同步的快照里按系列名反查，而不是信任本地记的 generated_campaign_id
   * ——那个字段只在成功时才写，卡住的记录里必然是空的。
   */
  async publishStuckCampaignCopyDraft(taskKey: string): Promise<{
    ok: boolean;
    message: string;
    adGroupIds: string[];
  }> {
    const task = this.store.getUncertainCampaignCopyTask(taskKey);
    if (!task) throw new Error("该系列复制记录不存在，或已不处于「结果未知」状态。");
    if (task.generatedNames.length === 0) {
      throw new Error("这条记录没有记下组名，无法定位草稿，请在 TikTok 后台手动处理。");
    }
    const account = this.store.getAccount(task.accountId);
    if (!account) throw new Error("账号不存在。");
    const connection = this.store.getProviderConnection(task.accountId, account.providerKind);
    if (!connection || connection.status !== "ready") {
      throw new Error("账户未通过连接检测，已阻止发布。");
    }
    const campaignId = this.findCampaignIdByName(task.accountId, account.providerKind, task.campaignName);
    if (!campaignId) {
      throw new Error(
        `系列「${task.campaignName}」还没有在 TikTok 上建出来，后台留下的是一个草稿系列。`
        + "发布草稿系列是另一条链路，需要在 TikTok 后台手动完成。",
      );
    }
    // 与扩组同一道闸门：同一条创建会话 cURL、同一个发布接口。
    this.providers.requireAccountCapability(
      task.accountId,
      account.providerKind,
      connection,
      "copy-ads",
    );
    const context = await this.loadProviderContext(task.accountId, account.providerKind);
    const result = await this.providers.publishExistingDrafts(account.providerKind, context, {
      campaignId,
      names: task.generatedNames,
      initialStatus: "enabled",
      publishedNames: this.publishedAdGroupNames(task.accountId, account.providerKind, campaignId),
    });
    if (!result.ok) {
      throw new Error(result.failureKind === "unknown"
        ? `${result.message}（发布请求已发出但结果无法确认，这条记录继续保留，请到 TikTok 后台核实）`
        : result.message);
    }
    this.store.confirmCampaignCopyTask(taskKey, campaignId);
    return {
      ok: true,
      message: result.message,
      adGroupIds: result.adGroupIds ?? [],
    };
  }

  /**
   * 这个系列下**已经建成**的广告组名，用来在发布草稿时跳过它们。
   *
   * 部分成功是常态：一次扩 3 个组，终态回来「广告组 2/3」，2 个成了正式组、1 个停在草稿。
   * 没有这份名单，发布会因为那 2 个已经不是草稿而拒掉整批，剩下的 1 个永远发不出去。
   *
   * 三个条件缺一不可，因为这份名单的作用是**允许跳过一次创建**，判错就等于漏建一个组：
   * 必须在同一个系列下（只对名字会把别的系列里的同名组算进来）、状态不是 `ad_create`
   * （草稿也带名字，也在广告组列表里）、且系列 ID 读得出来（读不出就是证不出来）。
   *
   * 数据来自最近一次同步的快照。对账路径上它刚刚被刷新过——`saveReadOnlySync` 就在
   * `reconcileUncertainExpands` 前一行；人工点按钮时可能旧一些，但「旧」只会让名单更短、
   * 更保守，不会把没建成的算成建成了。
   */
  private publishedAdGroupNames(
    accountId: string,
    providerKind: ProviderKind,
    campaignId: string,
  ): string[] {
    return this.store
      .listAdGroupPlatformStatuses(accountId, providerKind)
      .filter((entity) =>
        entity.campaignId === campaignId && entity.adStatus !== DRAFT_AD_STATUS)
      .map((entity) => entity.name);
  }

  /** 按系列名在最近一次同步的快照里反查系列 ID。同名多个时不下结论。 */
  private findCampaignIdByName(
    accountId: string,
    providerKind: ProviderKind,
    campaignName: string,
  ): string | null {
    const wanted = campaignName.trim();
    if (!wanted) return null;
    const matches = this.store
      .listCurrentManagedEntities(accountId, providerKind)
      .filter((entity) => entity.entityType === "campaign" && entity.name.trim() === wanted);
    return matches.length === 1 ? matches[0]!.externalId : null;
  }

  /**
   * TikTok 后台遗留的草稿广告组：够格清理的，和被保护住的。
   *
   * 草稿会因为人工中途放弃、网络卡顿、自动化断联而留在后台，只进不出。但**扩组本身就是
   * 先建草稿再发布**，轮询正在跑的那一刻后台必然有草稿；人在 TikTok 界面上手搓广告组时，
   * 后台也一直躺着一个。保护期就是为这两件事留的。
   */
  async listStaleDraftAdGroups(accountId: string, asOf = new Date()): Promise<{
    minAgeHours: number;
    drafts: Array<{
      adSketchId: string;
      adSketchName: string;
      campaignId: string;
      touchedAt: string | null;
    }>;
    tooFresh: number;
    reserved: number;
  }> {
    const { account, context } = await this.requireDraftAccess(accountId);
    const drafts = await this.providers.listDraftAdGroups(account.providerKind, context);
    if (!drafts) throw new Error("当前接入不支持读取草稿列表。");
    const selection = selectStaleDrafts(drafts, {
      now: asOf,
      protectedNames: this.reservedDraftNames(accountId),
    });
    return {
      minAgeHours: DRAFT_CLEANUP_MIN_AGE_HOURS,
      drafts: selection.stale.map((draft) => ({
        adSketchId: draft.adSketchId,
        adSketchName: draft.adSketchName,
        campaignId: draft.campaignId,
        touchedAt: draft.touchedAt === null ? null : new Date(draft.touchedAt * 1000).toISOString(),
      })),
      tooFresh: selection.tooFresh,
      reserved: selection.reserved,
    };
  }

  /**
   * 删掉上面那批遗留草稿。
   *
   * **候选在这里重新算一遍，不接受调用方传 ID。** 界面上看到列表到点下删除之间可能过了很久，
   * 期间轮询会建新草稿——拿旧 ID 去删，删掉的就是正在用的那个。
   */
  async deleteStaleDraftAdGroups(accountId: string, asOf = new Date()): Promise<{
    deleted: number;
    failed: Array<{ adSketchName: string; message: string }>;
    reserved: number;
    tooFresh: number;
  }> {
    const { account, context } = await this.requireDraftAccess(accountId);
    const drafts = await this.providers.listDraftAdGroups(account.providerKind, context);
    if (!drafts) throw new Error("当前接入不支持读取草稿列表。");
    const selection = selectStaleDrafts(drafts, {
      now: asOf,
      protectedNames: this.reservedDraftNames(accountId),
    });
    if (selection.stale.length === 0) {
      return { deleted: 0, failed: [], reserved: selection.reserved, tooFresh: selection.tooFresh };
    }
    const nameById = new Map(selection.stale.map((draft) => [draft.adSketchId, draft.adSketchName]));
    const result = await this.providers.deleteDraftAdGroups(account.providerKind, context, {
      adSketchIds: selection.stale.map((draft) => draft.adSketchId),
    });
    return {
      deleted: result.deleted.length,
      failed: result.failed.map((item) => ({
        adSketchName: nameById.get(item.adSketchId) ?? item.adSketchId,
        message: item.message,
      })),
      reserved: selection.reserved,
      tooFresh: selection.tooFresh,
    };
  }

  /**
   * 还挂着「结果未知」的组名：等着被自动补发布或人工决定，不能替他删掉。
   *
   * 系列复制那一侧同样要保住——它的记录现在也会被对账自动补发布，清理把草稿删了，补发布
   * 就只剩「找不到草稿」这一个结局。
   */
  private reservedDraftNames(accountId: string): string[] {
    return [
      ...this.store.listUncertainAdGroupExpandTasks(accountId),
      ...this.store.listUncertainCampaignCopyTasks(accountId),
    ].flatMap((task) => task.generatedNames);
  }

  private async requireDraftAccess(accountId: string) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("账号不存在。");
    const connection = this.store.getProviderConnection(accountId, account.providerKind);
    if (!connection || connection.status !== "ready") {
      throw new Error("账户未通过连接检测，暂不能读写草稿。");
    }
    // 与扩组同一道闸门：草稿是扩组的中间产物。
    this.providers.requireAccountCapability(accountId, account.providerKind, connection, "copy-ads");
    return { account, context: await this.loadProviderContext(accountId, account.providerKind) };
  }

  // 同账户广告组复制：以 templateCampaignId 冻结源系列，克隆源创意，
  // 在同一账户/同系列创建 count 个广告组（自动命名，预算/出价可覆盖）。
  // 不走跨账户 copy-preview 管线（那套需要源→目标素材映射，两级系列无本地视频码）。
  async copyAdGroupWithinAccount(input: {
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
    scheduledStartAt?: string | null;
    onBeforeDispatch?: () => void;
  }): Promise<Array<{ ok: boolean; adGroupId?: string; adGroupIds?: string[]; adId?: string; message: string; failureKind?: "failed" | "unknown"; retrySafe?: boolean; raw?: unknown }>> {
    const sameCampaign = input.sameCampaign !== false;
    // 同系列：走广告组级复制（ad_snap/copy）克隆进现有系列，不新建系列。
    if (sameCampaign && input.sourceAdGroupId) {
      const account = this.store.getAccount(input.accountId);
      if (!account) throw new Error("账号不存在。");
      const connection = this.store.getProviderConnection(input.accountId, account.providerKind);
      if (!connection || connection.status !== "ready") throw new Error("账户未通过连接检测，已阻止复制。");
      this.providers.requireAccountCapability(input.accountId, account.providerKind, connection, "copy-ads");
      const context = await this.loadProviderContext(input.accountId, account.providerKind);
      const names = Array.from(
        { length: Math.max(1, Math.min(10, input.count)) },
        (_unused, index) => `${input.baseAdGroupName}-${index + 1}`,
      );
      // 源系列为系列预算(CBO)时，广告组不能设与系列不同的预算——跳过组预算覆盖，
      // 让新组继承系列预算，避免真机 budget_auto_adjust_initial_budget_not_equal_campaign_budget。
      const sourceCampaignBudgetOptimized = this.store
        .listCurrentManagedEntities(input.accountId, account.providerKind)
        .some((entity) => entity.entityType === "ad-group"
          && entity.externalId === input.sourceAdGroupId
          && entity.campaignBudgetOptimized);
      const result = await this.providers.copyAdGroupToExistingCampaign(account.providerKind, context, {
        sourceAdGroupId: input.sourceAdGroupId,
        existingCampaignId: input.sourceCampaignId,
        names,
        initialStatus: input.scheduledStartAt || input.launchImmediately ? "enabled" : "disabled",
        scheduledStartAt: input.scheduledStartAt ?? null,
        dailyBudget: input.dailyBudget,
        bid: input.bid,
        ...(sourceCampaignBudgetOptimized ? { sourceCampaignBudgetOptimized: true } : {}),
        ...(input.onBeforeDispatch ? { onBeforeDispatch: input.onBeforeDispatch } : {}),
      });
      return [{
        ok: result.ok,
        message: result.message,
        ...(result.adGroupIds ? { adGroupIds: result.adGroupIds } : {}),
        ...(result.failureKind ? { failureKind: result.failureKind } : {}),
        ...(result.retrySafe !== undefined ? { retrySafe: result.retrySafe } : {}),
      }];
    }
    const account = this.store.getAccount(input.accountId);
    if (!account) throw new Error("账号不存在。");
    const connection = this.store.getProviderConnection(input.accountId, account.providerKind);
    if (!connection || connection.status !== "ready") {
      throw new Error("账户未通过连接检测，已阻止复制。");
    }
    this.providers.requireAccountCapability(
      input.accountId,
      account.providerKind,
      connection,
      "copy-ads",
    );
    const context = await this.loadProviderContext(input.accountId, account.providerKind);
    const basePreset = this.store.listLaunchPresets()[0];
    const creationConfig: CreationPresetConfig = {
      ...(basePreset?.creationConfig ?? defaultCreationPresetConfig),
      templateCampaignId: input.sourceCampaignId,
    };
    const initialStatus: "enabled" | "disabled" = input.launchImmediately ? "enabled" : "disabled";
    const results: Array<{ ok: boolean; adGroupId?: string; adId?: string; message: string; failureKind?: "failed" | "unknown"; retrySafe?: boolean }> = [];
    for (let index = 1; index <= Math.max(1, Math.min(10, input.count)); index += 1) {
      const row: LaunchConfigurationRow = {
        rowNumber: index + 1,
        campaignName: sameCampaign
          ? input.sourceCampaignName
          : `${input.sourceCampaignName}-副本${index}`,
        adGroupName: `${input.baseAdGroupName}-${index}`,
        adName: `${input.baseAdGroupName}-${index}-广告`,
        videoCode: "copy",
        productUrl: "https://www.tiktok.com/",
        region: basePreset?.region ?? "未设置",
        dailyBudget: input.dailyBudget,
        bid: input.bid,
        startAt: null,
        endAt: null,
        initialStatus,
      };
      try {
        const [created] = await this.providers.copy(account.providerKind, context, [{
          row,
          preset: creationConfig,
          initialStatus,
          templateCampaignId: input.sourceCampaignId,
          ...(input.onBeforeDispatch ? { onBeforeDispatch: input.onBeforeDispatch } : {}),
          // 同系列：挂到现有源系列下，不新建系列；否则新建一个唯一命名的系列。
          ...(sameCampaign ? { batchCampaignId: input.sourceCampaignId } : {}),
        }]);
        results.push({
          ok: Boolean(created?.ok),
          ...(created?.adGroupId ? { adGroupId: created.adGroupId } : {}),
          ...(created?.adId ? { adId: created.adId } : {}),
          message: created?.message ?? (created?.ok ? "复制成功" : "Provider 未返回结果"),
          ...(!created?.ok
            ? {
                failureKind: created?.failureKind === "unknown" ? "unknown" as const : "failed" as const,
                retrySafe: created?.retrySafe ?? created?.failureKind !== "unknown",
              }
            : {}),
        });
      } catch (cause) {
        results.push({
          ok: false,
          message: safeError(cause),
          ...(cause instanceof UnknownCreationStateError ? { failureKind: "unknown" as const } : {}),
        });
      }
    }
    return results;
  }

  /**
   * 系列级复制：把一个源系列复制成 N 个新系列，每个新系列放 M 个广告组。
   *
   * 这是系列预算(CBO)的放量路径——往同一个 CBO 系列里加广告组不会增加预算，
   * 只会摊薄；每个系列副本各自持有一份系列预算才是真正的放量。
   *
   * 幂等：相同 (账户 + 源系列 + 系列名 + 分配 + 预算模式) 已成功则跳过。
   */
  async copyCampaign(input: {
    accountId: string;
    /** 多个源系列时逐个独立套用同一套 N/M 分配。 */
    sources: Array<{ sourceCampaignId: string; sourceAdGroupIds: string[] }>;
    campaignCopies: number;
    groupsPerCampaign: number;
    initialStatus: "enabled" | "disabled";
    scheduledStartAt?: string | null;
    /** Meta 复制必须显式关闭新帖子/广告创建；TK 旧调用默认保持原行为。 */
    createNewPosts?: boolean;
    /** 覆盖系列日预算；留空继承源系列。 */
    campaignBudget?: number | null;
    /** 覆盖每个新广告组的日预算；留空继承源组。仅广告组预算口径适用。 */
    adGroupBudget?: number | null;
    bid?: number | null;
  }): Promise<{
    createdCampaigns: number;
    createdGroups: number;
    skipped: number;
    failed: Array<{ name: string; message: string }>;
    plan: Array<{
      sourceCampaignId: string;
      sourceCampaignName: string;
      campaigns: ReturnType<typeof planCampaignCopy>["campaigns"];
    }>;
  }> {
    const account = this.store.getAccount(input.accountId);
    if (!account) throw new Error("账号不存在。");
    const createNewPosts = input.createNewPosts ?? true;
    if (account.platform === "meta" && createNewPosts) {
      throw new Error("Meta 系列复制禁止创建新帖子、素材与广告；请显式使用仅复制 Campaign + Ad Set 的模式。");
    }
    const connection = this.store.getProviderConnection(input.accountId, account.providerKind);
    if (!connection || connection.status !== "ready") {
      throw new Error("账户未通过连接检测，已阻止系列复制。");
    }
    this.providers.requireAccountCapability(
      input.accountId,
      account.providerKind,
      connection,
      "copy-campaigns",
    );

    const context = await this.loadProviderContext(input.accountId, account.providerKind);

    const managed = this.store.listCurrentManagedEntities(input.accountId, account.providerKind);

    // 名称带到秒之后天然唯一，不再依赖快照定序号；这里取到的已有名称只当兜底
    // 跳过集合用（应对用户手工起的同名对象），允许它滞后于账户真实状态。
    const existingCampaignNames = managed
      .filter((entity) => entity.entityType === "campaign")
      .map((entity) => entity.name);
    const existingAdGroupNames = managed
      .filter((entity) => entity.entityType === "ad-group")
      .map((entity) => entity.name);

    // 多个源系列时逐个规划。名称预留跨源累积，避免两个源系列生成同名副本。
    const reserved = new Set<string>();
    const reservedAdGroupNames = new Set<string>();
    const plannedSources: Array<{
      sourceCampaignId: string;
      sourceCampaignName: string;
      campaigns: ReturnType<typeof planCampaignCopy>["campaigns"];
    }> = [];

    for (const source of input.sources) {
      const sourceCampaign = managed.find(
        (entity) => entity.entityType === "campaign" && entity.externalId === source.sourceCampaignId,
      );
      if (!sourceCampaign) {
        throw new Error("源推广系列不在当前同步快照中，请先执行只读同步。");
      }
      const sourceAdGroups = new Map(
        managed
          .filter((entity) => entity.entityType === "ad-group"
            && entity.parentCampaignId === source.sourceCampaignId)
          .map((entity) => [entity.externalId, entity.name]),
      );
      for (const sourceAdGroupId of source.sourceAdGroupIds) {
        if (!sourceAdGroups.has(sourceAdGroupId)) {
          throw new Error(`广告组 ${sourceAdGroupId} 不属于源推广系列，请重新选择。`);
        }
      }

      const plan = planCampaignCopy({
        sourceCampaignName: sourceCampaign.name,
        sourceAdGroupNames: sourceAdGroups,
        sourceAdGroupIds: source.sourceAdGroupIds,
        campaignCopies: input.campaignCopies,
        groupsPerCampaign: input.groupsPerCampaign,
        // 命名时间取【投放时刻】：定时投放用排期时间，立即投放用当前时间。
        at: input.scheduledStartAt ? new Date(input.scheduledStartAt) : new Date(),
        timeZone: account.timezone,
        existingCampaignNames: [...existingCampaignNames, ...reserved],
        existingAdGroupNames: [...existingAdGroupNames, ...reservedAdGroupNames],
      });

      // 发出任何写请求之前，先把整批名称都验一遍：系列名在账户内必须唯一，
      // 否则发布后的终态核验无法判定哪个系列是本次创建的。
      for (const campaign of plan.campaigns) {
        assertCampaignNameAvailable(existingCampaignNames, campaign.campaignName, reserved);
        reserved.add(campaign.campaignName);
        for (const group of campaign.groups) reservedAdGroupNames.add(group.name);
      }
      plannedSources.push({
        sourceCampaignId: source.sourceCampaignId,
        sourceCampaignName: sourceCampaign.name,
        campaigns: plan.campaigns,
      });
    }

    const scheduledStartAt = input.scheduledStartAt ?? null;
    let createdCampaigns = 0;
    let createdGroups = 0;
    let skipped = 0;
    const failed: Array<{ name: string; message: string }> = [];

    // 账户内串行执行，降低 Provider 频控风险，也让重名预检始终基于最新状态。
    for (const { sourceCampaignId, campaigns } of plannedSources) {
    for (const campaign of campaigns) {
      const taskKey = createHash("sha256").update(JSON.stringify({
        executor: "campaign-copy",
        accountId: input.accountId,
        sourceCampaignId,
        campaignName: campaign.campaignName,
        groups: campaign.groups,
        initialStatus: input.initialStatus,
        scheduledStartAt,
        createNewPosts,
        campaignBudget: input.campaignBudget ?? null,
        // 组预算参与幂等指纹：同一批源系列换个组预算重跑，是另一次任务而不是重放。
        adGroupBudget: input.adGroupBudget ?? null,
        bid: input.bid ?? null,
      })).digest("hex");

      const claim = this.store.claimCampaignCopyTask(
        taskKey,
        input.accountId,
        sourceCampaignId,
        campaign.campaignName,
        // 组名必须在第一个写请求之前落库：任务卡成「结果未知」后，后台留下的草稿只能
        // 按名字反查，而那时这批名字只存在于内存里。
        campaign.groups.map((group) => group.name),
      );
      if (claim !== "claimed") {
        if (claim === "unknown") {
          failed.push({
            name: campaign.campaignName,
            message: "上次系列复制结果待人工确认，已禁止自动重试。",
          });
        } else {
          skipped += 1;
        }
        continue;
      }

      // 任务级重试：单条 HTTP 请求内的瞬时抖动已经由 Provider 自己的传输层重试
      // 吸收（几秒内的网络毛刺）；这里额外兜底更长的中断（真实故障持续过约
      // 90 秒）——只要 Provider 明确判断「安全重试」（没有产生任何写入），就在
      // 同一次请求里自动重跑整个任务，用户不需要自己再点一次。
      // 只有 Provider 明确判断「不安全」时才立刻停下来，交给人工确认；这条
      // 安全边界不因为重试而放松。
      const maxTaskAttempts = 3;
      const taskRetryDelaysMs = [2_000, 4_000];
      let result: Awaited<ReturnType<ProviderRegistry["copyCampaign"]>> | null = null;
      let thrown: unknown = null;
      for (let attempt = 0; attempt < maxTaskAttempts; attempt += 1) {
        thrown = null;
        try {
          result = await this.providers.copyCampaign(account.providerKind, context, {
            sourceCampaignId,
            campaignName: campaign.campaignName,
            adGroups: campaign.groups,
            initialStatus: input.initialStatus,
            scheduledStartAt,
            createNewPosts,
            ...(input.campaignBudget !== undefined ? { campaignBudget: input.campaignBudget } : {}),
            ...(input.adGroupBudget !== undefined ? { adGroupBudget: input.adGroupBudget } : {}),
            ...(input.bid !== undefined ? { bid: input.bid } : {}),
            onBeforeDispatch: () => this.store.markCampaignCopyTaskDispatching(taskKey),
          });
          if (result.ok) break;
          const retrySafe = result.retrySafe === true
            || (result.retrySafe === undefined && result.failureKind !== "unknown");
          if (!retrySafe || attempt === maxTaskAttempts - 1) break;
        } catch (cause) {
          result = null;
          thrown = cause;
          // RetryableCreationError 之外的一切都保守地当作不安全，不在这里重试。
          const retrySafe = !(cause instanceof UnknownCreationStateError);
          if (!retrySafe || attempt === maxTaskAttempts - 1) break;
        }
        await new Promise((resolve) => setTimeout(resolve, taskRetryDelaysMs[attempt] ?? 4_000));
      }

      if (result?.ok) {
        createdCampaigns += 1;
        createdGroups += campaign.groups.length;
        this.store.finishCampaignCopyTask(taskKey, "succeeded", {
          campaignId: result.campaignId ?? null,
          adGroupIds: result.adGroupIds ?? [],
        });
      } else if (result) {
        // retrySafe 是 Provider 对「能否安全重试」的直接判断，必须优先信任它：
        // failureKind==="unknown" 只表示「不确定 TikTok 侧最终状态」，不代表
        // 重试会有重复创建的风险——比如系列复制第一步 campaign_snap/copy 本身
        // 失败时，Provider 明确知道还没有产生任何草稿，retrySafe 会是 true。
        // 只有在 Provider 没给出明确判断时，才退回旧的保守逻辑。
        const unknown = result.retrySafe === false
          || (result.retrySafe === undefined && result.failureKind === "unknown");
        this.store.finishCampaignCopyTask(taskKey, unknown ? "unknown" : "failed");
        failed.push({
          name: campaign.campaignName,
          message: unknown
            ? `${result.message}（结果待确认，禁止自动重试）`
            : `${result.message}（已自动重试仍未成功，未产生任何写入）`,
        });
      } else {
        const unknown = thrown instanceof UnknownCreationStateError;
        this.store.finishCampaignCopyTask(taskKey, unknown ? "unknown" : "failed");
        failed.push({
          name: campaign.campaignName,
          message: `${safeError(thrown)}${unknown ? "（结果待确认，禁止自动重试）" : "（已自动重试仍未成功）"}`,
        });
      }
    }
    }

    return { createdCampaigns, createdGroups, skipped, failed, plan: plannedSources };
  }

  /**
   * 扩组重复提交预检：只报告，不拦截。
   *
   * 扩组的幂等 taskKey 是对「组名」取的哈希，而组名精确到秒，因此跨秒的重复提交在
   * 引擎看来永远是全新任务——闸门拦不住误重复点。与其把按钮锁死（一批要跑很久，
   * 锁死等于整个面板停摆），不如在发请求之前把「已经有什么」摆给用户看，让人来判
   * 断这一次是不是误点。
   *
   * 判定口径固定为「进行中 + 今日已扩过」：
   * - running / 待人工确认：这批还没跑完
   * - 今日已扩过：同一源组今天已经成功扩过（含扩了几个、组名）
   * - 目标组重名：计划组名的当日前缀已经出现在任务记录或本地快照里
   *
   * 快照可能滞后一轮轮询，所以快照命中只是「提示」的一个来源，不作为拒绝的依据。
   */
  /**
   * 谱系判定的输入：当前快照 + 复制/扩组任务记录。
   *
   * 快照必须走 `listCurrentManagedEntities`——不筛 `is_current` 会把已经下线的对象一并
   * 带出来，它们在账户里已经不存在，却会顶着历史名字出现在谱系里、还会占住一个本可用的名字。
   */
  loadLineageInput(accountId: string): LineageInput {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("账号不存在。");
    return {
      entities: this.store
        .listCurrentManagedEntities(accountId, account.providerKind)
        .filter((entity) => entity.entityType === "campaign" || entity.entityType === "ad-group")
        .map((entity) => ({
          entityType: entity.entityType as "campaign" | "ad-group",
          externalId: entity.externalId,
          name: entity.name,
          status: entity.status,
          parentCampaignId: entity.parentCampaignId,
          createdAt: entity.createdAt ?? null,
        })),
      copyTasks: this.store.listCampaignCopyHistory([accountId], 500).map((task) => ({
        taskKey: task.taskKey,
        sourceCampaignId: task.sourceCampaignId,
        campaignName: task.campaignName,
        generatedCampaignId: task.generatedCampaignId,
        generatedAdGroupIds: task.generatedAdGroupIds,
        generatedAdGroupNames: task.generatedAdGroupNames,
        status: task.status,
        uncertain: task.uncertain,
        updatedAt: task.updatedAt,
      })),
      expandTasks: this.store.listAdGroupExpandHistory([accountId], 500).map((task) => ({
        taskKey: task.taskKey,
        sourceAdGroupId: task.sourceAdGroupId,
        sourceCampaignId: task.sourceCampaignId,
        generatedIds: task.generatedIds,
        generatedNames: task.generatedNames,
        status: task.status,
        uncertain: task.uncertain,
        updatedAt: task.updatedAt,
        executorKind: task.executorKind,
      })),
    };
  }

  /**
   * 把「给这几个组扩量」翻译成一张能直接导入的批量创建表。
   *
   * 源组的名称和所属系列一律从快照里查，不让调用方传——传错一个字就是把新素材上到
   * 别的组上，而这份信息本地已经有了，没有理由再让人抄一遍。
   *
   * 落地页和定向按三级回退取：历史导入行 → 源广告组现读 → 留空由人补。中间那一级要发
   * 网络请求，默认不做（`readSourceAdGroups`）：一次要读几十个组，慢且会把源账户的
   * 会话额度耗在一个本可以先看看历史值的地方。
   */
  async planExpandSheet(input: {
    accountId: string;
    sourceAdGroupIds: string[];
    countPerSource: number;
    sameCampaign: boolean;
    scheduledStartAt?: string | null;
    readSourceAdGroups?: boolean;
  }): Promise<ExpandSheetPlan & {
    accountId: string;
    deliveryAt: string;
    unresolvedSources: Array<{ sourceAdGroupId: string; reason: string }>;
  }> {
    const account = this.store.getAccount(input.accountId);
    if (!account) throw new Error("账号不存在。");
    const managed = this.store.listCurrentManagedEntities(input.accountId, account.providerKind);
    const lineageInput = this.loadLineageInput(input.accountId);
    const lineage = buildLineageReport(lineageInput);
    const reserved = collectReservedNames(lineageInput);

    // 历史导入行按品根名索引：源组自己可能是扩出来的、从没在表里出现过，但同一个品
    // 上一次填的落地页仍然是最贴近意图的值。
    const historyByRoot = new Map<string, { productUrl: string; ageRanges: string[] | null; gender: string | null }>();
    for (const row of this.store.listSucceededLaunchRows(input.accountId)) {
      if (!row.productUrl) continue;
      const root = brandRootName(row.adGroupName);
      // 新到旧遍历，先写的赢：最近一次填的值最可信。
      if (!historyByRoot.has(root)) {
        historyByRoot.set(root, {
          productUrl: row.productUrl,
          ageRanges: row.ageRanges,
          gender: row.gender,
        });
      }
    }

    const deliveryAt = input.scheduledStartAt ? new Date(input.scheduledStartAt) : new Date();
    const sources: ExpandSheetSource[] = [];
    const unresolvedSources: Array<{ sourceAdGroupId: string; reason: string }> = [];
    let context: ProviderContext | null = null;

    for (const sourceAdGroupId of [...new Set(input.sourceAdGroupIds)]) {
      const adGroup = managed.find(
        (entity) => entity.entityType === "ad-group" && entity.externalId === sourceAdGroupId,
      );
      if (!adGroup) {
        unresolvedSources.push({ sourceAdGroupId, reason: "不在当前同步快照中，请先同步账户。" });
        continue;
      }
      const campaign = adGroup.parentCampaignId
        ? managed.find(
          (entity) => entity.entityType === "campaign"
            && entity.externalId === adGroup.parentCampaignId,
        )
        : undefined;
      if (!campaign) {
        unresolvedSources.push({
          sourceAdGroupId,
          reason: `广告组“${adGroup.name}”所属推广系列不在当前同步快照中。`,
        });
        continue;
      }

      const history = historyByRoot.get(brandRootName(adGroup.name));
      let productUrl = history?.productUrl ?? null;
      let inheritedFrom: ExpandSheetSource["inheritedFrom"] = history ? "launch-history" : null;
      if (!productUrl && input.readSourceAdGroups) {
        try {
          context ??= await this.loadProviderContext(input.accountId, account.providerKind);
          const detail = await this.providers.readAdGroupOriginalPosts(
            account.providerKind,
            context,
            { campaignId: campaign.externalId, adGroupId: adGroup.externalId },
          );
          if (detail.productUrl) {
            productUrl = detail.productUrl;
            inheritedFrom = "source-ad-group";
          }
        } catch (cause) {
          // 读不到就留空让人补，不让一个组的读取失败拖垮整张表。
          unresolvedSources.push({
            sourceAdGroupId,
            reason: `读取源广告组落地页失败：${safeError(cause)}`,
          });
        }
      }

      sources.push({
        sourceAdGroupId: adGroup.externalId,
        sourceAdGroupName: adGroup.name,
        sourceCampaignId: campaign.externalId,
        sourceCampaignName: campaign.name,
        productUrl,
        ageRanges: (history?.ageRanges?.filter(
          (value): value is LaunchAgeRange => (LaunchAgeRangeValues as readonly string[]).includes(value),
        )) ?? null,
        gender: history?.gender === "male" || history?.gender === "female" || history?.gender === "all"
          ? history.gender
          : null,
        inheritedFrom,
      });
    }

    const plan = buildExpandSheetPlan({
      sources,
      countPerSource: input.countPerSource,
      deliveryAt,
      timeZone: account.timezone,
      sameCampaign: input.sameCampaign,
      existingCampaignNames: reserved.campaignNames,
      existingAdGroupNames: reserved.adGroupNames,
      duplicateCampaignNames: new Set(
        lineage.duplicateCampaignNames.map((group) => group.name),
      ),
    });
    return {
      ...plan,
      accountId: input.accountId,
      deliveryAt: deliveryAt.toISOString(),
      unresolvedSources,
    };
  }

  previewBatchExpandConflicts(input: {
    sources: Array<{
      accountId: string;
      sourceCampaignId: string;
      sourceCampaignName: string;
      sourceAdGroupId: string;
      sourceAdGroupName: string;
    }>;
    scheduledStartAt?: string | null;
  }): {
    conflicts: Array<{
      accountId: string;
      sourceAdGroupId: string;
      sourceAdGroupName: string;
      /** 进行中：running 租约未过期，或上次结果待人工确认。 */
      inProgress: { kind: "running" | "pending-confirmation"; since: string } | null;
      /** 今天已经成功扩过的次数与组名。 */
      expandedToday: { batches: number; groups: number; names: string[] } | null;
      /** 与计划组名当日前缀相同的已有组名（来自任务记录或本地快照）。 */
      existingNames: string[];
    }>;
  } {
    const deliveryDate = input.scheduledStartAt ? new Date(input.scheduledStartAt) : new Date();
    const byAccount = new Map<string, typeof input.sources>();
    for (const source of input.sources) {
      const list = byAccount.get(source.accountId) ?? [];
      list.push(source);
      byAccount.set(source.accountId, list);
    }

    const conflicts: Array<{
      accountId: string;
      sourceAdGroupId: string;
      sourceAdGroupName: string;
      inProgress: { kind: "running" | "pending-confirmation"; since: string } | null;
      expandedToday: { batches: number; groups: number; names: string[] } | null;
      existingNames: string[];
    }> = [];

    for (const [accountId, sources] of byAccount) {
      const account = this.store.getAccount(accountId);
      // 账号不存在是提交时才该报的错；预检只负责「能查到什么就说什么」。
      if (!account) continue;
      const timeZone = account.timezone;
      const localDate = dateKeyInTimeZone(deliveryDate, timeZone);
      const activity = this.store.listAdGroupExpandActivity(
        accountId,
        sources.map((source) => source.sourceAdGroupId),
        localDate,
      );
      const activityBySource = new Map<string, typeof activity>();
      for (const row of activity) {
        const list = activityBySource.get(row.sourceAdGroupId) ?? [];
        list.push(row);
        activityBySource.set(row.sourceAdGroupId, list);
      }
      const snapshotAdGroupNames = this.store
        .listCurrentManagedEntities(accountId, account.providerKind)
        .filter((entity) => entity.entityType === "ad-group")
        .map((entity) => entity.name);

      for (const source of sources) {
        const rows = activityBySource.get(source.sourceAdGroupId) ?? [];
        const pending = rows.find((row) => row.uncertain);
        const running = rows.find((row) => !row.uncertain && row.status === "running");
        const succeededToday = rows.filter(
          (row) => !row.uncertain && row.status === "succeeded" && row.localDate === localDate,
        );

        // 当日前缀：`清洗后源组名-MMDD`。带秒的完整组名每次都不同，比前缀才看得出
        // 「今天已经扩过一轮」。
        const todayPrefix = `${stripGeneratedNameSuffixes(source.sourceAdGroupName)}-${monthDaySuffix(deliveryDate, timeZone)}`;
        const existingNames = [...new Set([
          ...succeededToday.flatMap((row) => row.generatedNames),
          ...snapshotAdGroupNames.filter((name) => name.trim().startsWith(todayPrefix)),
        ])];

        const inProgress = pending
          ? { kind: "pending-confirmation" as const, since: pending.updatedAt }
          : running
            ? { kind: "running" as const, since: running.claimedAt }
            : null;
        const expandedToday = succeededToday.length > 0
          ? {
            batches: succeededToday.length,
            groups: succeededToday.reduce(
              (total, row) => total + (row.requestedCount > 0 ? row.requestedCount : row.generatedNames.length),
              0,
            ),
            names: succeededToday.flatMap((row) => row.generatedNames),
          }
          : null;

        if (!inProgress && !expandedToday && existingNames.length === 0) continue;
        conflicts.push({
          accountId,
          sourceAdGroupId: source.sourceAdGroupId,
          sourceAdGroupName: source.sourceAdGroupName,
          inProgress,
          expandedToday,
          existingNames,
        });
      }
    }

    return { conflicts };
  }

  // 一键扩组：批量选中的源广告组，每个各扩 count 个新组。
  // 按账户串行、账户内逐源串行执行，复用 copyAdGroupWithinAccount。
  // 幂等：相同 (账户+源组+扩组预设指纹) 已成功则跳过，不重复建组。
  async batchExpandAdGroups(input: {
    sources: Array<{
      accountId: string;
      sourceCampaignId: string;
      sourceCampaignName: string;
      sourceAdGroupId: string;
      sourceAdGroupName: string;
    }>;
    count: number;
    dailyBudget: number;
    bid: number | null;
    launchImmediately: boolean;
    sameCampaign: boolean;
    // 定时投放时间（ISO）。Provider 在发布前写入并回读 TikTok 原生排期。
    scheduledStartAt?: string | null;
  }): Promise<{
    createdGroups: number;
    scheduled: number;
    failed: Array<{ name: string; message: string }>;
    skipped: number;
  }> {
    const count = Math.max(1, Math.min(10, input.count));
    const scheduledStartAt = input.scheduledStartAt ?? null;
    // 命名后缀按【投放日期+时间】：定时投放取排期时刻，立即投放取当前时刻。
    // 带到秒是为了让每次扩组的名字天然唯一——此前只到日、序号又固定从 1 重编，
    // 同一天对同一个源第二次扩组必然撞上第一次的名字，被 TikTok 判重名拒绝。
    const deliveryDate = scheduledStartAt ? new Date(scheduledStartAt) : new Date();
    if (scheduledStartAt && !input.sameCampaign) {
      throw new RetryableCreationError("定时扩组仅支持挂回原系列；已在发送任何创建请求前阻止执行。");
    }
    // 原生定时投放：新组以 enabled 发布，但 Provider 必须在发布前写入并回读 TikTok 排期。
    const launchImmediately = scheduledStartAt ? true : input.launchImmediately;
    let createdGroups = 0;
    let scheduled = 0;
    let skipped = 0;
    const failed: Array<{ name: string; message: string }> = [];

    // 按账户分组，账户串行，账户内逐源串行，降低 Provider 频控风险。
    const byAccount = new Map<string, typeof input.sources>();
    for (const source of input.sources) {
      const list = byAccount.get(source.accountId) ?? [];
      list.push(source);
      byAccount.set(source.accountId, list);
    }

    for (const [expandAccountId, sources] of byAccount) {
      // 投放日期按账户时区取，与用户在界面上看到的投放时间一致。
      const expandTimeZone = this.store.getAccount(expandAccountId)?.timezone;
      // 批内已占用的基名。
      //
      // 后缀取的是【投放档位】而不是创建时刻，同一批扩到同一档的所有源组共用它。于是两个
      // 源组只要洗出来的基名相同（常见：它们本身就是同一个产品在不同档位扩出来的，旧后缀
      // 被 strip 掉后完全一样），生成的新组名就会一字不差地撞上。
      //
      // 撞名在建草稿那步不报错、到发布那步才被 TikTok 拒——后台留下一个草稿，本地记一条
      // 「结果未知」。2026-08-25 07:47–07:49 那一批 8 条里就这么废了 2 条。
      //
      // 账户里已有的同名对象也一并跳过，但只当兜底：本地快照可能滞后一整轮轮询，不能靠它
      // 来定序号（与 planGeneratedNames 的取舍一致）。
      const usedBaseNames = new Set<string>();
      const existingNames = new Set(
        this.store
          .listCurrentManagedEntities(expandAccountId, this.store.getAccount(expandAccountId)?.providerKind ?? "cookie")
          .filter((entity) => entity.entityType === "ad-group")
          .map((entity) => entity.name.trim()),
      );
      for (const source of sources) {
        const sourceBaseName = stripGeneratedAdGroupNameSuffixes(
          source.sourceAdGroupName,
        );
        const baseAdGroupName = allocateExpandBaseName({
          cleanedSourceName: sourceBaseName,
          deliveryAt: deliveryDate,
          timeZone: expandTimeZone,
          usedBaseNames,
          existingNames,
        });
        usedBaseNames.add(baseAdGroupName);
        const taskKey = createHash("sha256").update(JSON.stringify({
          accountId: source.accountId,
          sourceAdGroupId: source.sourceAdGroupId,
          baseAdGroupName,
          count,
          dailyBudget: input.dailyBudget,
          bid: input.bid,
          launchImmediately,
          scheduledStartAt,
          sameCampaign: input.sameCampaign,
        })).digest("hex");

        const claim = this.store.claimAdGroupExpandTask(
          taskKey,
          source.accountId,
          source.sourceAdGroupId,
          {
            sourceCampaignId: source.sourceCampaignId,
            localDate: dateKeyInTimeZone(deliveryDate, expandTimeZone ?? "UTC"),
            requestedCount: count,
            // 组名规则与 copyAdGroupWithinAccount 一致（`基名-序号`），落库供重复提交
            // 预检回答「今天扩出来的是哪几个组」。
            generatedNames: Array.from(
              { length: count },
              (_unused, index) => `${baseAdGroupName}-${index + 1}`,
            ),
          },
        );
        if (claim !== "claimed") {
          if (claim === "unknown") {
            failed.push({
              name: source.sourceAdGroupName,
              message: "上次扩组结果待人工确认，已禁止自动重试。",
            });
          } else {
            skipped += 1;
          }
          continue;
        }

        try {
          const results = await this.copyAdGroupWithinAccount({
            accountId: source.accountId,
            sourceCampaignId: source.sourceCampaignId,
            sourceCampaignName: source.sourceCampaignName,
            sourceAdGroupId: source.sourceAdGroupId,
            baseAdGroupName,
            count,
            dailyBudget: input.dailyBudget,
            bid: input.bid,
            launchImmediately,
            sameCampaign: input.sameCampaign,
            scheduledStartAt,
            onBeforeDispatch: () => this.store.markAdGroupExpandTaskDispatching(taskKey),
          });
          const ok = results.length > 0 && results.every((result) => result.ok);
          if (ok) {
            createdGroups += count;
            this.store.finishAdGroupExpandTask(taskKey, "succeeded");
            if (scheduledStartAt) {
              scheduled += count;
            }
          } else {
            const partialSuccess = results.some((result) => result.ok)
              && results.some((result) => !result.ok);
            const unknown = partialSuccess || results.some(
              (result) => result.failureKind === "unknown" || result.retrySafe === false,
            );
            this.store.finishAdGroupExpandTask(taskKey, unknown ? "unknown" : "failed");
            failed.push({
              name: source.sourceAdGroupName,
              message: `${results.find((result) => !result.ok)?.message ?? "创建失败"}${unknown ? "（结果待确认，禁止自动重试）" : ""}`,
            });
          }
        } catch (cause) {
          const unknown = cause instanceof UnknownCreationStateError;
          this.store.finishAdGroupExpandTask(taskKey, unknown ? "unknown" : "failed");
          failed.push({
            name: source.sourceAdGroupName,
            message: `${safeError(cause)}${unknown ? "（结果待确认，禁止自动重试）" : ""}`,
          });
        }
      }

    }

    return { createdGroups, scheduled, failed, skipped };
  }

}

/**
 * 账户里已存在的同名系列。命中就复用它、只建广告组，不再新建系列。
 *
 * 同名时**不允许**猜：TikTok 允许账户内存在多个同名系列，而发布后的终态核验是按
 * 系列名精确匹配的，多个同名会让核验无从判定哪个是本次创建的。所以命中多个时明确
 * 报错，交给人改名，而不是随便挑一个往里塞广告组。
 *
 * 快照可能滞后于账户真实状态（刚建好、还没被同步捕获的系列查不到）。那种情况下会
 * 走新建、被 TikTok 判重名——与改动前的行为一致，不构成回退。
 */
export function resolveExistingCampaignIdByName(
  managed: Array<{ entityType: string; externalId: string; name: string }>,
  campaignName: string,
): string | undefined {
  const wanted = campaignName.trim();
  if (!wanted) return undefined;
  const matches = managed.filter(
    (entity) => entity.entityType === "campaign" && entity.name.trim() === wanted,
  );
  if (matches.length > 1) {
    throw new Error(
      `账户内存在 ${matches.length} 个名为“${wanted}”的推广系列，无法判定该往哪个里加广告组；请先改名或合并。`,
    );
  }
  return matches[0]?.externalId;
}

function groupLaunchItemsByAccountAndCampaign(
  items: LaunchPlanItemRecord[],
): Map<string, LaunchPlanItemRecord[][]> {
  const accountGroups = new Map<string, Map<string, LaunchPlanItemRecord[]>>();
  for (const item of items) {
    const seriesKey = [
      item.launchRow.campaignName.trim(),
      item.templateMode,
      item.templateCampaignId ?? "",
    ].join("\u0000");
    const groups = accountGroups.get(item.accountId) ?? new Map<string, LaunchPlanItemRecord[]>();
    const group = groups.get(seriesKey) ?? [];
    group.push(item);
    groups.set(seriesKey, group);
    accountGroups.set(item.accountId, groups);
  }
  return new Map(
    [...accountGroups].map(([accountId, groups]) => [accountId, [...groups.values()]]),
  );
}

/**
 * Remove only the date/index fields generated by batch expansion. Repeated
 * expansion can otherwise turn `name0723-0724-1` into
 * `name0723-0724-1-0725-1`. Date-shaped suffixes must be valid MMDD values so
 * ordinary model numbers such as `2024` are preserved.
 */
export function stripGeneratedAdGroupNameSuffixes(sourceName: string): string {
  return stripAutomaticAdGroupNameSuffixes(sourceName);
}

function creationConnectionFingerprint(
  connection: NonNullable<ReturnType<AutomationStore["getProviderConnection"]>>,
): string {
  // `updatedAt` also changes after harmless health/status refreshes. Freeze
  // only the fields that can change the actual Cookie request or credential.
  return createHash("sha256").update(JSON.stringify({
    credentialRef: connection.credentialRef,
    settings: connection.settings,
  })).digest("hex");
}

function originalPostsHash(posts: LaunchOriginalPost[]): string {
  return createHash("sha256").update(JSON.stringify(posts.map((post) => ({
    itemId: post.itemId,
    identityId: post.identityId,
    identityType: post.identityType,
    identityBcId: post.identityBcId,
    vid: post.vid,
    videoId: post.videoId,
    promotable: post.promotable,
  })))).digest("hex");
}

function safeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "广告创建失败。";
}
