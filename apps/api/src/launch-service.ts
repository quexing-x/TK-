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
    { campaignId: string; adGroupId: string; adId: string }
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
    const executorId = randomUUID();
    const results: LaunchExecutionItemResult[] = [];

    for (const candidate of candidates) {
      const item = this.tasks.claim(candidate.itemId, executorId, "pending", actor);
      if (!item) continue;
      results.push(await this.executeItem(plan.presetSnapshot.creationConfig, item, executorId));
    }

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
    if (item.status === "unknown") {
      throw new Error("创建结果待确认，禁止重试，需人工核验。");
    }
    if (item.status !== "failed") throw new Error("只有明确失败的创建任务可以单项重试。");
    const executorId = randomUUID();
    const claimed = this.tasks.claim(itemId, executorId, "failed", actor);
    if (!claimed) throw new Error("创建任务正在执行或状态已经变化。");
    const result = await this.executeItem(plan.presetSnapshot.creationConfig, claimed, executorId);
    return {
      plan: this.launchStore.refresh(planId),
      results: [result],
    };
  }

  private async executeItem(
    preset: CreationPresetConfig,
    claimed: LaunchPlanItemRecord,
    executorId: string,
  ): Promise<LaunchExecutionItemResult> {
    let providerInvoked = false;
    let providerConfirmed = false;
    let creationScopeLocked = false;
    let creationScopeReservation: { campaignId: string | null; adGroupNames: string[] } | null = null;
    const campaignName = claimed.launchRow.campaignName.trim();
    const creationScopeOwner = `${executorId}:${claimed.itemId}`;
    try {
      creationScopeReservation = this.store.claimLaunchCreationScope(
        claimed.planId,
        claimed.accountId,
        campaignName,
        creationScopeOwner,
      );
      creationScopeLocked = creationScopeReservation !== null;
      if (!creationScopeLocked) {
        throw new RetryableCreationError("同计划同账户的同系列任务正在创建，当前任务未发送 Provider 请求，请稍后重试。");
      }
      const uncertainSibling = this.launchStore.listItems(claimed.planId).some((item) =>
        item.itemId !== claimed.itemId
        && item.accountId === claimed.accountId
        && item.launchRow.campaignName.trim() === claimed.launchRow.campaignName.trim()
        && item.status === "unknown",
      );
      if (uncertainSibling) {
        throw new RetryableCreationError("同计划内已有同系列任务结果未知，已停止后续创建以避免重复系列或广告组。");
      }
      const account = this.store.getAccount(claimed.accountId);
      if (!account) throw new Error("目标广告账户不存在。");
      // A launch plan is an explicit user-triggered write with its own audit,
      // confirmation and manual-verification path. It must not require the
      // account's background automation mode to be enabled.
      const connection = this.store.getProviderConnection(claimed.accountId, account.providerKind);
      if (!connection || connection.status !== "ready") {
        throw new Error("目标账户未通过连接验证。");
      }
      this.providers.requireAccountCapability(
        claimed.accountId,
        account.providerKind,
        connection,
        claimed.templateMode === "copy" ? "copy-ads" : "create-campaigns",
      );
      const latestSync = this.store.getLatestReadOnlySync(claimed.accountId, account.providerKind);
      if (claimed.templateMode === "copy" && (!latestSync || latestSync.quality.status !== "healthy")) {
        throw new Error(
          `目标账户同步数据不是 healthy，批量创建已阻止（当前：${latestSync?.quality.status ?? "none"}）。`,
        );
      }
      this.store.validateLaunchCopyItem(claimed);
      const context = await this.loadProviderContext(claimed.accountId, account.providerKind);
      if (!claimed.attemptId) throw new Error("创建任务缺少 attemptId，禁止调用 Provider。");
      const attemptId = claimed.attemptId;
      const templateCampaignId = claimed.templateCampaignId;
      if (claimed.templateMode === "copy" && !templateCampaignId) {
        throw new Error("复制计划没有冻结 templateCampaignId，禁止执行且不会按系列名称回退。");
      }

      if (!this.store.getSystemRuntimeState().enabled) {
        throw new Error("软件总开关已关闭，批量创建写入已暂停。");
      }
      // A copy preview is evidence from a prior sync. Refresh both the source
      // structure and the target-account asset evidence before the write. A
      // read failure is safe to retry because no creation request was sent.
      await this.refreshLaunchCopyEvidence(claimed, context);

      // Re-check all mutable local safety gates synchronously at the final
      // boundary. There is no await between these checks and Provider dispatch.
      if (!this.store.getSystemRuntimeState().enabled) {
        throw new Error("软件总开关已关闭，批量创建写入已暂停。");
      }
      const currentAccount = this.store.getAccount(claimed.accountId);
      if (!currentAccount) {
        throw new Error("目标广告账户不存在，批量创建已阻止。");
      }
      if (currentAccount.providerKind !== account.providerKind) {
        throw new Error("目标账户 Provider 已变更，批量创建已阻止。");
      }
      const currentSync = this.store.getLatestReadOnlySync(claimed.accountId, account.providerKind);
      if (claimed.templateMode === "copy" && (!currentSync || currentSync.quality.status !== "healthy")) {
        throw new Error(
          `目标账户同步数据已变化，批量创建已阻止（当前：${currentSync?.quality.status ?? "none"}）。`,
        );
      }
      this.store.validateLaunchCopyItem(claimed);

      // The evidence refresh above performs remote reads. Revalidate the
      // authorization and exact credential generation immediately before the
      // irreversible Provider write, with no await between this boundary and
      // dispatch.
      const dispatchConnection = this.store.getProviderConnection(
        claimed.accountId,
        currentAccount.providerKind,
      );
      if (
        !dispatchConnection
        || dispatchConnection.credentialRef !== connection.credentialRef
        || dispatchConnection.updatedAt !== connection.updatedAt
      ) {
        throw new Error("目标账户授权或凭据已变更，批量创建已阻止。");
      }
      this.providers.requireAccountCapability(
        claimed.accountId,
        currentAccount.providerKind,
        dispatchConnection,
        claimed.templateMode === "copy" ? "copy-ads" : "create-campaigns",
      );

      if (!this.store.renewLaunchCreationScope(
        claimed.planId,
        claimed.accountId,
        campaignName,
        creationScopeOwner,
      )) {
        throw new RetryableCreationError("同系列创建锁已失效，当前任务未发送 Provider 请求，请重新执行。");
      }

      providerInvoked = true;
      const creationMutation = {
        row: claimed.launchRow,
        preset,
        initialStatus: claimed.launchRow.initialStatus,
        operationId: claimed.operationId,
        attemptId,
        correlationId: claimed.correlationId,
        batchId: claimed.planId,
        ...(creationScopeReservation?.campaignId
          ? { batchCampaignId: creationScopeReservation.campaignId }
          : {}),
        ...(creationScopeReservation?.adGroupNames.length
          ? { batchAdGroupNames: creationScopeReservation.adGroupNames }
          : {}),
        onProgress: (progress: LaunchCreationProgress) => {
          this.launchStore.progress(claimed.itemId, executorId, progress);
        },
      };
      const [created] = await withLeaseHeartbeat(
        () => claimed.templateMode === "copy"
          ? this.providers.copy(account.providerKind, context, [{
              ...creationMutation,
              templateCampaignId: templateCampaignId!,
            }])
          : this.providers.create(account.providerKind, context, [creationMutation]),
        () => {
          const itemRenewed = this.launchStore.renew(claimed.itemId, executorId);
          const scopeRenewed = this.store.renewLaunchCreationScope(
            claimed.planId,
            claimed.accountId,
            campaignName,
            creationScopeOwner,
          );
          return itemRenewed && scopeRenewed;
        },
        launchLeaseHeartbeatMs,
      );
      if (!created?.ok) {
        const message = created?.message ?? "Provider 未返回创建结果。";
        if (created?.failureKind === "unknown" || created?.retrySafe === false) {
          throw new UnknownCreationStateError(
            created?.retrySafe === false
              ? `${message}；此前已有创建步骤被 TikTok 接受，禁止自动重试。`
              : message,
          );
        }
        throw new RetryableCreationError(message);
      }
      providerConfirmed = true;
      if (!created.campaignId || !created.adGroupId || !created.adId) {
        throw new UnknownCreationStateError(
          "Provider 报告成功，但没有返回完整的系列、广告组和广告 ID；为避免重复投放，系统不会自动重试。",
        );
      }
      if (!this.store.completeLaunchCreationScope(
        claimed.planId,
        claimed.accountId,
        campaignName,
        creationScopeOwner,
        created.campaignId,
        created.row.adGroupName,
      )) {
        throw new UnknownCreationStateError("Provider 已确认创建，但批次系列预留未能持久化；后续同系列任务已阻止。");
      }
      creationScopeLocked = false;

      this.tasks.succeed(claimed.itemId, executorId, {
        campaignId: created.campaignId,
        adGroupId: created.adGroupId,
        adId: created.adId,
      });
      let syncWarning: string | null = null;
      try {
        this.store.resetProviderWriteFailures(claimed.accountId, account.providerKind);
      } catch (cause) {
        syncWarning = `写入失败计数重置失败：${safeError(cause)}`;
      }
      let syncResult: ReadOnlySyncResult | null = null;
      try {
        const sync = await this.providers.syncReadOnly(account.providerKind, context);
        syncResult = sync.result;
        this.store.saveReadOnlySync(
          claimed.accountId,
          account.providerKind,
          sync.entities,
          sync.result,
        );
        const expectedEntities = [
          ["campaign", created.campaignId] as const,
          ["ad-group", created.adGroupId] as const,
          ["ad", created.adId] as const,
        ];
        const missingEntities = expectedEntities.filter(([entityType, externalId]) =>
          !sync.entities.some((entity) =>
            entity.entityType === entityType && entity.externalId === externalId,
          ),
        );
        const safetyWarnings = [
          ...(sync.result.quality.status !== "healthy"
            ? [`创建后同步质量为 ${sync.result.quality.status}，结果数据不可用于继续自动写入`]
            : []),
          ...sync.result.warnings,
          ...(missingEntities.length > 0
            ? [`创建后未回读到：${missingEntities.map(([entityType]) => entityType).join("、")}`]
            : []),
        ];
        if (safetyWarnings.length > 0) {
          syncWarning = [syncWarning, ...safetyWarnings].filter(Boolean).join("；");
        }
      } catch (cause) {
        syncWarning = [syncWarning, safeError(cause)].filter(Boolean).join("；");
        this.store.updateProviderStatus(
          claimed.accountId,
          account.providerKind,
          "failed",
          `创建后同步异常：${syncWarning}`,
        );
      }
      try {
        this.launchStore.sync(claimed.itemId, syncWarning);
      } catch (cause) {
        syncWarning = [syncWarning, `同步阶段记录失败：${safeError(cause)}`]
          .filter(Boolean)
          .join("；");
      }
      return {
        itemId: claimed.itemId,
        accountId: claimed.accountId,
        status: "succeeded",
        message: created.message,
        syncWarning,
        ok: true,
        created: [{
          ok: true,
          campaignId: created.campaignId,
          adGroupId: created.adGroupId,
          adId: created.adId,
          message: created.message,
        }],
        sync: syncResult,
      };
    } catch (cause) {
      const message = safeError(cause);
      if (providerInvoked && !providerConfirmed) {
        const providerKind = this.store.getAccount(claimed.accountId)?.providerKind;
        if (providerKind) this.recordCreationWriteFailure(claimed.accountId, providerKind, message);
      }
      const unknown = cause instanceof UnknownCreationStateError
        || providerConfirmed
        || (providerInvoked && !(cause instanceof RetryableCreationError));
      if (unknown && creationScopeLocked) {
        // Never release an unknown provider result, even if persisting the
        // explicit uncertain marker fails. The retained owner lease expires
        // into an uncertain scope on the next claim, which remains fail-closed.
        creationScopeLocked = false;
        try {
          this.store.markLaunchCreationScopeUncertain(
            claimed.planId,
            claimed.accountId,
            campaignName,
            creationScopeOwner,
          );
        } catch {
          // The item still transitions to unknown below; the scope must not be
          // reopened by the finally block.
        }
      }
      if (unknown) {
        this.tasks.unknown(
          claimed.itemId,
          executorId,
          message,
        );
      } else {
        this.tasks.fail(
          claimed.itemId,
          executorId,
          message,
        );
      }
      return {
        itemId: claimed.itemId,
        accountId: claimed.accountId,
        status: unknown ? "unknown" : "failed",
        message,
        syncWarning: null,
        ok: false,
        created: [{ ok: false, message }],
        sync: null,
      };
    } finally {
      if (creationScopeLocked) {
        this.store.releaseLaunchCreationScope(
          claimed.planId,
          claimed.accountId,
          campaignName,
          creationScopeOwner,
        );
      }
    }
  }

  private recordCreationWriteFailure(
    accountId: string,
    providerKind: ProviderKind,
    message: string,
  ): void {
    const failures = this.store.recordProviderWriteFailure(accountId, providerKind, message);
  }

  private recoverExpiredLeases(): void {
    this.launchStore.recover(
      new Date(Date.now() - launchLeaseTimeoutMs).toISOString(),
    );
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

function safeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "广告创建失败。";
}
