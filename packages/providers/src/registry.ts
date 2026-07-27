import {
  ProviderCapabilitySchema,
  type AccountProviderCapabilities,
  type ProviderCapability,
  type ProviderConnection,
  type ProviderKind,
  type LaunchOriginalPost,
} from "@tk-auto/core";
import { CookieAdsProvider } from "./cookie-provider.js";
import { OfficialApiAdsProvider } from "./official-api-provider.js";
import { RetryableCreationError } from "./types.js";
import type {
  AdsProvider,
  ProviderDescriptor,
  ProviderHealth,
  ProviderContext,
  ProviderSyncOutput,
  StatusMutation,
  StatusMutationResult,
  CreationMutation,
  CreationMutationResult,
  DeleteAdGroupMutation,
  DeleteAdGroupMutationResult,
  NewCreationMutation,
  TemplateCopyMutation,
} from "./types.js";

export class ProviderRegistry {
  private readonly providers = new Map<ProviderKind, AdsProvider>();

  constructor(providers: AdsProvider[] = defaultProviders()) {
    for (const provider of providers) {
      this.providers.set(provider.kind, provider);
    }
  }

  get(kind: ProviderKind): AdsProvider {
    const provider = this.providers.get(kind);
    if (!provider) {
      throw new Error(`Provider not registered: ${kind}`);
    }
    return provider;
  }

  list(): ProviderDescriptor[] {
    return [...this.providers.values()].map((provider) => ({
      kind: provider.kind,
      displayName: provider.displayName,
      implementationStatus: "available",
      capabilityVersion: provider.capabilityVersion,
      capabilities: [...provider.capabilities],
    }));
  }

  describeAccount(
    accountId: string,
    kind: ProviderKind,
    connection: ProviderConnection | null,
  ): AccountProviderCapabilities {
    const provider = this.get(kind);
    const authorizationExpired = connection?.authorizationExpiresAt
      ? new Date(connection.authorizationExpiresAt).getTime() <= Date.now()
      : false;
    const authorizationStatus = authorizationExpired
      ? "expired" as const
      : connection?.authorizationStatus ?? "not-authorized";
    const contractCurrent = connection?.capabilityVersion === provider.capabilityVersion;
    const authorizedCapabilities = new Set(connection?.authorizedCapabilities ?? []);
    const ready = connection?.status === "ready"
      && authorizationStatus === "active"
      && contractCurrent;
    return {
      accountId,
      providerKind: kind,
      providerDisplayName: provider.displayName,
      capabilityVersion: provider.capabilityVersion,
      authorizationStatus,
      authorizedAt: connection?.authorizedAt ?? null,
      authorizationExpiresAt: connection?.authorizationExpiresAt ?? null,
      capabilities: ProviderCapabilitySchema.options.map((capability) => {
        const implemented = provider.capabilities.has(capability);
        return {
          capability,
          available: implemented && ready && authorizedCapabilities.has(capability),
          reason: !implemented
            ? "当前 Provider 未实现此能力。"
            : !connection?.hasCredential
              ? "尚未保存授权凭据。"
              : connection.status !== "ready"
                ? "连接尚未通过检测。"
                : authorizationStatus !== "active"
                  ? `授权状态为 ${authorizationStatus}。`
                  : !contractCurrent
                    ? "Provider 能力契约已更新，请重新检测连接。"
                    : !authorizedCapabilities.has(capability)
                      ? "当前账户凭据未开放此能力。"
                    : "当前账户可用。",
        };
      }),
    };
  }

  capabilityVersion(kind: ProviderKind): string {
    return this.get(kind).capabilityVersion;
  }

  resolveAuthorizedCapabilities(
    kind: ProviderKind,
    context: ProviderContext,
  ): ProviderCapability[] {
    const provider = this.get(kind);
    const resolved = provider.resolveCapabilities?.(context) ?? provider.capabilities;
    return ProviderCapabilitySchema.options.filter(
      (capability) => provider.capabilities.has(capability) && resolved.has(capability),
    );
  }

  requireAccountCapability(
    accountId: string,
    kind: ProviderKind,
    connection: ProviderConnection | null,
    capability: ProviderCapability,
  ): void {
    const state = this.describeAccount(accountId, kind, connection)
      .capabilities.find((candidate) => candidate.capability === capability);
    if (!state?.available) {
      throw new Error(state?.reason ?? `Provider capability is unavailable: ${capability}`);
    }
  }

  checkHealth(
    kind: ProviderKind,
    context: ProviderContext,
  ): Promise<ProviderHealth> {
    return this.get(kind).checkHealth(context);
  }

  syncReadOnly(
    kind: ProviderKind,
    context: ProviderContext,
  ): Promise<ProviderSyncOutput> {
    const provider = this.get(kind);
    if (!provider.syncReadOnly || !provider.capabilities.has("read-campaigns")) {
      throw new Error(`${provider.displayName} 暂不支持读取广告数据。`);
    }
    return provider.syncReadOnly(context);
  }

  readAdGroupOriginalPosts(
    kind: ProviderKind,
    context: ProviderContext,
    input: { campaignId: string; adGroupId: string },
  ): Promise<{ posts: LaunchOriginalPost[]; productUrl: string | null }> {
    const provider = this.get(kind);
    if (!provider.readAdGroupOriginalPosts) {
      throw new Error(`${provider.displayName} 暂不支持读取广告组原帖。`);
    }
    return provider.readAdGroupOriginalPosts(context, input);
  }

  readAccessibleOriginalPosts(
    kind: ProviderKind,
    context: ProviderContext,
    sourcePosts: LaunchOriginalPost[],
  ): Promise<LaunchOriginalPost[]> {
    const provider = this.get(kind);
    if (!provider.readAccessibleOriginalPosts) {
      throw new Error(`${provider.displayName} 暂不支持读取账户帖子。`);
    }
    return provider.readAccessibleOriginalPosts(context, sourcePosts);
  }

  changeStatus(
    kind: ProviderKind,
    context: ProviderContext,
    mutations: StatusMutation[],
  ): Promise<StatusMutationResult[]> {
    const provider = this.get(kind);
    if (!provider.changeStatus || !provider.capabilities.has("change-status")) {
      throw new Error(`${provider.displayName} 暂不支持广告启停。`);
    }
    return provider.changeStatus(context, mutations);
  }

  deleteAdGroups(
    kind: ProviderKind,
    context: ProviderContext,
    mutations: DeleteAdGroupMutation[],
  ): Promise<DeleteAdGroupMutationResult[]> {
    const provider = this.get(kind);
    if (!provider.deleteAdGroups || !provider.capabilities.has("delete-ad-groups")) {
      throw new Error(`${provider.displayName} 暂不支持删除广告组。`);
    }
    return provider.deleteAdGroups(context, mutations);
  }

  async create(
    kind: ProviderKind,
    context: ProviderContext,
    mutations: NewCreationMutation[],
  ): Promise<CreationMutationResult[]> {
    const provider = this.get(kind);
    if (!provider.create || !provider.capabilities.has("create-campaigns")) {
      throw new RetryableCreationError(`${provider.displayName} 暂不支持从零创建广告。`);
    }
    return provider.create(context, mutations);
  }

  async copy(
    kind: ProviderKind,
    context: ProviderContext,
    mutations: TemplateCopyMutation[],
  ): Promise<CreationMutationResult[]> {
    const provider = this.get(kind);
    if (!provider.copy || !provider.capabilities.has("copy-ads")) {
      throw new RetryableCreationError(`${provider.displayName} 暂不支持按稳定 ID 复制广告。`);
    }
    return provider.copy(context, mutations);
  }

  async copyAdGroupToExistingCampaign(
    kind: ProviderKind,
    context: ProviderContext,
    input: {
      sourceAdGroupId: string;
      existingCampaignId: string;
      names: string[];
      initialStatus: "enabled" | "disabled";
      scheduledStartAt?: string | null;
      dailyBudget?: number;
      bid?: number | null;
      sourceCampaignBudgetOptimized?: boolean;
      onBeforeDispatch?: () => void;
    },
  ): Promise<{ ok: boolean; message: string; adGroupSnapIds?: string[]; adGroupIds?: string[]; failureKind?: "failed" | "unknown"; retrySafe?: boolean }> {
    const provider = this.get(kind) as unknown as {
      copyAdGroupToExistingCampaign?: (
        context: ProviderContext,
        input: {
          sourceAdGroupId: string;
          existingCampaignId: string;
          names: string[];
          initialStatus: "enabled" | "disabled";
          scheduledStartAt?: string | null;
          dailyBudget?: number;
          bid?: number | null;
          sourceCampaignBudgetOptimized?: boolean;
          onBeforeDispatch?: () => void;
        },
      ) => Promise<{ ok: boolean; message: string; adGroupSnapIds?: string[]; adGroupIds?: string[]; failureKind?: "failed" | "unknown"; retrySafe?: boolean }>;
    };
    if (!provider.copyAdGroupToExistingCampaign) {
      throw new RetryableCreationError("当前接入不支持广告组级复制。");
    }
    return provider.copyAdGroupToExistingCampaign(context, input);
  }

  async createFromPreset(
    kind: ProviderKind,
    context: ProviderContext,
    mutations: CreationMutation[],
  ): Promise<CreationMutationResult[]> {
    if (mutations.every((mutation) => mutation.templateMode === "none")) {
      return this.create(kind, context, mutations);
    }
    if (mutations.every((mutation) => mutation.templateMode === "copy")) {
      return this.copy(kind, context, mutations.map((mutation) => ({
        ...mutation,
        templateCampaignId: mutation.templateCampaignId ?? "",
      })));
    }
    const results: CreationMutationResult[] = [];
    for (const mutation of mutations) {
      const [result] = mutation.templateMode === "copy"
        ? await this.copy(kind, context, [{
            ...mutation,
            templateCampaignId: mutation.templateCampaignId ?? "",
          }])
        : await this.create(kind, context, [mutation]);
      if (result) results.push(result);
    }
    return results;
  }
}

function defaultProviders(): AdsProvider[] {
  return [new CookieAdsProvider(), new OfficialApiAdsProvider()];
}
