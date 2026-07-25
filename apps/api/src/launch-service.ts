import { createHash, randomUUID } from "node:crypto";
import {
  ProviderCredentialInputSchema,
  getCreationTemplateReadiness,
  defaultCreationPresetConfig,
  type ProviderKind,
  type ReadOnlySyncResult,
  type LaunchPlanItemRecord,
  type CreationPresetConfig,
  type LaunchConfigurationRow,
  type LaunchCreationProgress,
  type WriteTaskActor,
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
    if (!this.store.getSystemRuntimeState().enabled) {
      throw new Error("软件总开关已关闭，批量创建写入已暂停。");
    }

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
      [...groupsByAccount.values()].map((groups) => Promise.all(
        groups.map((group) => this.executeSeriesBatch(
          plan.presetSnapshot!.creationConfig,
          group,
          actor,
        )),
      )),
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
    if (!this.store.getSystemRuntimeState().enabled) {
      throw new Error("软件总开关已关闭，批量创建写入已暂停。");
    }
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
        first.templateMode === "copy" ? "copy-ads" : "create-campaigns",
      );
      const latestSync = this.store.getLatestReadOnlySync(first.accountId, account.providerKind);
      if (first.templateMode === "copy" && (!latestSync || latestSync.quality.status !== "healthy")) {
        throw new Error(
          `目标账户同步数据不是 healthy，批量创建已阻止（当前：${latestSync?.quality.status ?? "none"}）。`,
        );
      }
      for (const item of claimed) {
        this.store.validateLaunchCopyItem(item);
        if (!item.attemptId) throw new Error("创建任务缺少 attemptId，禁止调用 Provider。");
        if (item.templateMode === "copy" && !item.templateCampaignId) {
          throw new Error("复制计划没有冻结 templateCampaignId，禁止执行且不会按系列名称回退。");
        }
      }
      const context = await this.loadProviderContext(first.accountId, account.providerKind);
      const connectionFingerprint = creationConnectionFingerprint(connection);
      for (const item of claimed) {
        await this.refreshLaunchCopyEvidence(item, context);
      }
      for (const item of claimed) this.store.validateLaunchCopyItem(item);

      const validateBeforeDispatch = () => {
        if (!this.store.getSystemRuntimeState().enabled) {
          throw new Error("软件总开关已关闭，批量创建写入已暂停。");
        }
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
          first.templateMode === "copy" ? "copy-ads" : "create-campaigns",
        );
        if (!claimed.every((item) => this.launchStore.renew(item.itemId, executorId))) {
          throw new Error("创建批次执行权已变化，当前请求未发送。");
        }
      };

      const mutations: CreationMutation[] = claimed.map((item) => ({
        row: item.launchRow,
        preset,
        initialStatus: item.launchRow.initialStatus,
        templateMode: item.templateMode,
        ...(item.templateCampaignId ? { templateCampaignId: item.templateCampaignId } : {}),
        operationId: item.operationId,
        attemptId: item.attemptId!,
        correlationId: item.correlationId,
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
        () => claimed.every((item) => this.launchStore.renew(item.itemId, executorId)),
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
      for (const [index, item] of claimed.entries()) {
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
            || created.retrySafe === false;
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
        let commonSyncWarning: string | null = null;
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
            commonSyncWarning = [
              commonSyncWarning,
              ...(sync.result.quality.status !== "healthy"
                ? [`创建后同步质量为 ${sync.result.quality.status}`]
                : []),
              ...sync.result.warnings,
            ].filter(Boolean).join("；");
          }
        } catch (cause) {
          commonSyncWarning = [commonSyncWarning, safeError(cause)].filter(Boolean).join("；");
          this.store.updateProviderStatus(
            first.accountId,
            account.providerKind,
            "failed",
            `创建后同步异常：${commonSyncWarning}`,
          );
        }
        for (const success of successes) {
          const missing = [
            ["campaign", success.created.campaignId] as const,
            ["ad-group", success.created.adGroupId] as const,
            ...(success.created.adId ? [["ad", success.created.adId] as const] : []),
          ].filter(([entityType, externalId]) =>
            syncCompleted
            && !syncEntities.some((entity) => entity.entityType === entityType && entity.externalId === externalId),
          );
          const itemWarning = [
            success.output.syncWarning,
            commonSyncWarning,
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
      return outputs;
    } catch (cause) {
      const message = safeError(cause);
      const unknown = providerInvoked && !(cause instanceof RetryableCreationError);
      const current = new Map(
        this.launchStore.listItems(claimed[0]!.planId).map((item) => [item.itemId, item]),
      );
      return claimed.map((item): LaunchExecutionItemResult => {
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
      });
    }
  }

  private recoverExpiredLeases(): void {
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
  ): Promise<void> {
    if (!item.sourceSnapshot && !item.targetAssetMapping) return;
    if (!item.sourceSnapshot || !item.targetAssetMapping) {
      throw new Error("复制迁移任务缺少冻结的源快照或目标素材映射。");
    }
    const accountIds = [...new Set([
      item.sourceSnapshot.accountId,
      item.accountId,
    ])];
    for (const accountId of accountIds) {
      const account = this.store.getAccount(accountId);
      if (!account) throw new Error("复制迁移的源账户或目标账户不存在。");
      const connection = this.store.getProviderConnection(accountId, account.providerKind);
      if (!connection || connection.status !== "ready") {
        throw new Error(`账户“${account.displayName}”未通过连接验证，已阻止复制迁移。`);
      }
      this.providers.requireAccountCapability(
        accountId,
        account.providerKind,
        connection,
        "read-campaigns",
      );
      const context = accountId === item.accountId
        ? targetContext
        : await this.loadProviderContext(accountId, account.providerKind);
      const sync = await this.providers.syncReadOnly(account.providerKind, context);
      this.store.saveReadOnlySync(accountId, account.providerKind, sync.entities, sync.result);
      if (sync.result.quality.status !== "healthy") {
        throw new Error(
          `账户“${account.displayName}”最终同步质量为 ${sync.result.quality.status}，已阻止复制迁移。`,
        );
      }
    }
  }

  private async loadProviderContext(
    accountId: string,
    providerKind: ProviderKind,
  ): Promise<ProviderContext> {
    const connection = this.store.getProviderConnection(accountId, providerKind);
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
    // 命名后缀按【投放日期】：定时投放取排期当天，立即投放取当天；用本地日期，
    // 与用户在界面选的投放时间一致（而非创建时间）。
    const deliveryDate = scheduledStartAt ? new Date(scheduledStartAt) : new Date();
    const dateSuffix = `${String(deliveryDate.getMonth() + 1).padStart(2, "0")}${String(deliveryDate.getDate()).padStart(2, "0")}`;
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

    for (const [, sources] of byAccount) {
      for (const source of sources) {
        const sourceBaseName = stripGeneratedAdGroupNameSuffixes(
          source.sourceAdGroupName,
        );
        const baseAdGroupName = `${sourceBaseName}-${dateSuffix}`;
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
  const original = sourceName.trim();
  let current = original;
  while (current) {
    const indexed = current.match(/^(.*?)-(\d{4})-([1-9]\d*)$/);
    if (indexed && indexed[1]?.trim() && isValidMonthDay(indexed[2]!)) {
      current = indexed[1].replace(/-+$/, "").trim();
      continue;
    }
    const dated = current.match(/^(.*?)-?(\d{4})$/);
    if (dated && dated[1]?.trim() && isValidMonthDay(dated[2]!)) {
      current = dated[1].replace(/-+$/, "").trim();
      continue;
    }
    break;
  }
  return current || original;
}

function isValidMonthDay(value: string): boolean {
  const month = Number(value.slice(0, 2));
  const day = Number(value.slice(2));
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  const lastDay = new Date(Date.UTC(2000, month, 0)).getUTCDate();
  return Number.isInteger(day) && day >= 1 && day <= lastDay;
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

function safeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "广告创建失败。";
}
