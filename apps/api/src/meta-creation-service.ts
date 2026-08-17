import {
  MetaAccessSecretBundleInputSchema,
  MetaAdCreationInputSchema,
  type MetaAdCreationInput,
  type MetaCreationTaskRecord,
} from "@tk-auto/core";
import type { CredentialVault } from "@tk-auto/credentials";
import { ProviderRegistry, type ProviderContext } from "@tk-auto/providers";
import { AutomationStore } from "@tk-auto/storage";

const META_CREATION_LEASE_TIMEOUT_MS = 30 * 60_000;

export class MetaCreationService {
  constructor(
    private readonly store: AutomationStore,
    private readonly vault: CredentialVault,
    private readonly providers: ProviderRegistry,
  ) {
    this.recoverInterruptedTasks();
  }

  async execute(
    accountId: string,
    rawInput: unknown,
  ): Promise<MetaCreationTaskRecord> {
    const input = MetaAdCreationInputSchema.parse(rawInput);
    this.recoverInterruptedTasks();
    const existing = this.store.createMetaCreationTask(accountId, input);
    if (existing.status === "succeeded" || existing.status === "running") return existing;
    // Returning the persisted unknown record is not a replay. It lets the UI
    // immediately expose the read-only reconciliation action after a crash or
    // an uncertain response, while still avoiding every provider mutation.
    if (existing.status === "unknown") return existing;

    const account = this.store.getAccount(accountId);
    if (!account || account.platform !== "meta" || account.providerKind !== "meta-marketing-api") {
      throw new Error("目标账户不是 Meta Marketing API 账户。");
    }
    const connection = this.store.getProviderConnection(accountId, "meta-marketing-api");
    if (!connection || connection.status !== "ready" || connection.authorizationStatus !== "active") {
      throw new Error("Meta 创建前必须重新完成连接检测。");
    }
    this.providers.requireAccountCapability(
      accountId,
      "meta-marketing-api",
      connection,
      "create-campaigns",
    );
    const claimed = this.store.claimMetaCreationTask(existing.id);
    if (!claimed) return this.store.getMetaCreationTask(existing.id);
    const claimedIds = taskIds(claimed);

    try {
      const context = await this.loadContext(accountId);
      if (hasReachedTarget(claimed.input, claimedIds)) {
        const reconciliation = await this.providers.reconcileMetaAd(context, {
          input: claimed.input,
          existing: claimedIds,
        });
        const reconciledIds = taskIds({
          campaignId: reconciliation.campaignId ?? claimed.campaignId,
          adSetId: reconciliation.adSetId ?? claimed.adSetId,
          creativeId: reconciliation.creativeId ?? claimed.creativeId,
          adId: reconciliation.adId ?? claimed.adId,
        });
        if (reconciliation.ok && hasReachedTarget(claimed.input, reconciledIds)) {
          const completed = this.store.completeMetaCreationTask(
            claimed.id,
            "succeeded",
            reconciliation.message,
            reconciledIds,
          );
          await this.refreshReadOnlyBestEffort(accountId, context);
          return completed;
        }
        return this.store.completeMetaCreationTask(
          claimed.id,
          reconciliation.failureKind === "retryable" ? "failed" : "unknown",
          reconciliation.ok
            ? missingTargetIdsMessage(claimed.input.targetLevel)
            : reconciliation.message,
          reconciledIds,
        );
      }
      const result = await this.providers.createMetaAd(context, {
        input: claimed.input,
        existing: {
          ...(claimed.campaignId ? { campaignId: claimed.campaignId } : {}),
          ...(claimed.adSetId ? { adSetId: claimed.adSetId } : {}),
          ...(claimed.creativeId ? { creativeId: claimed.creativeId } : {}),
          ...(claimed.adId ? { adId: claimed.adId } : {}),
        },
        onBeforeDispatch: () => {
          this.store.markMetaCreationTaskDispatching(claimed.id);
        },
        onProgress: (progress) => {
          this.store.updateMetaCreationProgress(claimed.id, progress);
        },
      });
      const ids = taskIds({
        campaignId: result.campaignId ?? claimed.campaignId,
        adSetId: result.adSetId ?? claimed.adSetId,
        creativeId: result.creativeId ?? claimed.creativeId,
        adId: result.adId ?? claimed.adId,
      });
      if (!result.ok) {
        return this.store.completeMetaCreationTask(
          claimed.id,
          result.failureKind === "unknown" ? "unknown" : "failed",
          result.message,
          ids,
        );
      }
      if (hasReachedTarget(claimed.input, ids)) {
        const completed = this.store.completeMetaCreationTask(
          claimed.id,
          "succeeded",
          result.message,
          ids,
        );
        await this.refreshReadOnlyBestEffort(accountId, context);
        return completed;
      }
      return this.store.completeMetaCreationTask(
        claimed.id,
        "unknown",
        missingTargetIdsMessage(claimed.input.targetLevel),
        ids,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Meta 创建任务失败。";
      const latest = this.store.getMetaCreationTask(claimed.id);
      const ids = taskIds(latest);
      const dispatchMayHaveOccurred = latest.message !== null;
      return this.store.completeMetaCreationTask(
        claimed.id,
        dispatchMayHaveOccurred ? "unknown" : "failed",
        message,
        ids,
      );
    }
  }

  async reconcile(
    accountId: string,
    taskId: string,
  ): Promise<MetaCreationTaskRecord> {
    const task = this.store.getMetaCreationTask(taskId);
    if (task.accountId !== accountId) throw new Error("Meta 创建任务不属于当前账户。");
    if (task.status !== "unknown") {
      throw new Error("只有结果未知的 Meta 创建任务可以执行只读对账。");
    }
    const account = this.store.getAccount(accountId);
    if (!account || account.platform !== "meta" || account.providerKind !== "meta-marketing-api") {
      throw new Error("目标账户不是 Meta Marketing API 账户。");
    }
    const connection = this.store.getProviderConnection(accountId, "meta-marketing-api");
    if (!connection || connection.status !== "ready" || connection.authorizationStatus !== "active") {
      throw new Error("Meta 创建对账前必须重新完成连接检测。");
    }
    this.providers.requireAccountCapability(
      accountId,
      "meta-marketing-api",
      connection,
      "read-campaigns",
    );
    const context = await this.loadContext(accountId);
    const result = await this.providers.reconcileMetaAd(context, {
      input: task.input,
      existing: {
        ...(task.campaignId ? { campaignId: task.campaignId } : {}),
        ...(task.adSetId ? { adSetId: task.adSetId } : {}),
        ...(task.creativeId ? { creativeId: task.creativeId } : {}),
        ...(task.adId ? { adId: task.adId } : {}),
      },
    });
    const ids = taskIds({
      campaignId: result.campaignId ?? task.campaignId,
      adSetId: result.adSetId ?? task.adSetId,
      creativeId: result.creativeId ?? task.creativeId,
      adId: result.adId ?? task.adId,
    });
    const targetReached = result.ok && hasReachedTarget(task.input, ids);
    const reconciled = this.store.resolveUnknownMetaCreationTask(
      task.id,
      targetReached
        ? "succeeded"
        : result.ok
          ? "unknown"
          : result.failureKind === "retryable"
            ? "failed"
            : "unknown",
      targetReached
        ? result.message
        : result.ok
          ? missingTargetIdsMessage(task.input.targetLevel)
          : result.message,
      ids,
    );
    if (reconciled.status === "succeeded") {
      await this.refreshReadOnlyBestEffort(accountId, context);
    }
    return reconciled;
  }

  private async loadContext(accountId: string): Promise<ProviderContext> {
    const connection = this.store.getProviderConnection(accountId, "meta-marketing-api");
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

  private async refreshReadOnlyBestEffort(
    accountId: string,
    context: ProviderContext,
  ): Promise<void> {
    try {
      const sync = await this.providers.syncReadOnly("meta-marketing-api", context);
      this.store.saveReadOnlySync(accountId, "meta-marketing-api", sync.entities, sync.result);
    } catch {
      // The exact requested target is already write-after-read confirmed. A
      // transient follow-up list sync must not downgrade it or replay writes.
    }
  }

  private recoverInterruptedTasks(): void {
    this.store.recoverInterruptedMetaCreationTasks(
      new Date(Date.now() - META_CREATION_LEASE_TIMEOUT_MS).toISOString(),
    );
  }
}

function hasReachedTarget(
  input: MetaAdCreationInput,
  ids: {
    campaignId?: string;
    adSetId?: string;
    creativeId?: string;
    adId?: string;
  },
): boolean {
  if (!ids.campaignId || !ids.adSetId) return false;
  return input.targetLevel === "ad-set" || Boolean(ids.creativeId && ids.adId);
}

function taskIds(value: {
  campaignId?: string | null;
  adSetId?: string | null;
  creativeId?: string | null;
  adId?: string | null;
}): {
  campaignId?: string;
  adSetId?: string;
  creativeId?: string;
  adId?: string;
} {
  return {
    ...(value.campaignId ? { campaignId: value.campaignId } : {}),
    ...(value.adSetId ? { adSetId: value.adSetId } : {}),
    ...(value.creativeId ? { creativeId: value.creativeId } : {}),
    ...(value.adId ? { adId: value.adId } : {}),
  };
}

function missingTargetIdsMessage(targetLevel: MetaAdCreationInput["targetLevel"]): string {
  return targetLevel === "ad-set"
    ? "Meta Provider 报告成功，但未返回已确认的 Campaign 与 Ad Set ID；任务转为 unknown，需先只读对账。"
    : "Meta Provider 报告成功，但未返回完整四层 ID；任务转为 unknown，需先只读对账。";
}
