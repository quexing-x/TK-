import {
  ProviderCapabilitySchema,
  type AccountProviderCapabilities,
  type ProviderCapability,
  type ProviderConnection,
  type ProviderKind,
  type LaunchOriginalPost,
  type LaunchProductInfo,
  type ProviderEntity,
} from "@tk-auto/core";
import { CookieAdsProvider } from "./cookie-provider.js";
import { OfficialApiAdsProvider } from "./official-api-provider.js";
import { MetaOfflineAdsProvider } from "./meta-offline-provider.js";
import {
  MetaMarketingApiAdsProvider,
  type MetaMarketingApiTransportFactory,
} from "./meta-marketing-api-provider.js";
import { RetryableCreationError } from "./types.js";
import type {
  AdsProvider,
  ReadProvider,
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
  MetaAdAccountDiscoveryContext,
  DiscoveredMetaAdAccount,
  MetaAdCreationMutation,
  MetaAdCreationResult,
} from "./types.js";

export interface CopyCampaignInput {
  sourceCampaignId: string;
  campaignName: string;
  /** 保留哪些源广告组，以及每个副本的新名称。顺序即发布顺序。 */
  adGroups: Array<{ sourceAdGroupId: string; name: string }>;
  initialStatus: "enabled" | "disabled";
  scheduledStartAt?: string | null;
  /** Meta 复制硬门禁：只能显式关闭新帖/广告创建。旧 TK 调用默认保持原行为。 */
  createNewPosts?: boolean;
  /** 覆盖系列日预算；留空表示继承源系列。 */
  campaignBudget?: number | null;
  bid?: number | null;
  onBeforeDispatch?: () => void;
}

export interface CopyCampaignResult {
  ok: boolean;
  message: string;
  campaignId?: string;
  adGroupIds?: string[];
  failureKind?: "failed" | "unknown";
  retrySafe?: boolean;
}

export interface ProviderRegistryOptions {
  /** Omitted in the desktop default so Meta remains physically unable to use the network. */
  metaMarketingApiTransportFactory?: MetaMarketingApiTransportFactory;
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderKind, AdsProvider>();

  constructor(
    providers?: AdsProvider[],
    options: ProviderRegistryOptions = {},
  ) {
    for (const provider of providers ?? defaultProviders(options)) {
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
      platform: provider.platform,
      displayName: provider.displayName,
      implementationStatus: provider.implementationStatus,
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

  /** 定向回读单个实体；provider 不支持时返回 null，由调用方决定退路。 */
  async readEntityById(
    kind: ProviderKind,
    context: ProviderContext,
    entityType: "campaign" | "ad-group" | "ad",
    externalId: string,
  ): Promise<ProviderEntity | null> {
    const provider = this.get(kind) as { readEntityById?: ReadProvider["readEntityById"] };
    if (!provider.readEntityById) return null;
    return provider.readEntityById(context, entityType, externalId);
  }

  discoverMetaAdAccounts(
    context: MetaAdAccountDiscoveryContext,
  ): Promise<DiscoveredMetaAdAccount[]> {
    const provider = this.get("meta-marketing-api") as AdsProvider & {
      discoverAdAccounts?: (
        input: MetaAdAccountDiscoveryContext,
      ) => Promise<DiscoveredMetaAdAccount[]>;
    };
    if (!provider.discoverAdAccounts) {
      throw new Error("Meta Marketing API Provider 未实现广告账户发现。");
    }
    return provider.discoverAdAccounts(context);
  }

  readAdGroupOriginalPosts(
    kind: ProviderKind,
    context: ProviderContext,
    input: { campaignId: string; adGroupId: string },
  ): Promise<{ posts: LaunchOriginalPost[]; productUrl: string | null; productInfo: LaunchProductInfo | null; catalogSetup: 0 | 1 | null }> {
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

  createMetaAd(
    context: ProviderContext,
    mutation: MetaAdCreationMutation,
  ): Promise<MetaAdCreationResult> {
    const provider = this.get("meta-marketing-api");
    if (!provider.createMetaAd || !provider.capabilities.has("create-campaigns")) {
      throw new RetryableCreationError("Meta Marketing API Provider 尚未实现广告创建。");
    }
    return provider.createMetaAd(context, mutation);
  }

  reconcileMetaAd(
    context: ProviderContext,
    mutation: Pick<MetaAdCreationMutation, "input" | "existing">,
  ): Promise<MetaAdCreationResult> {
    const provider = this.get("meta-marketing-api");
    if (!provider.reconcileMetaAd || !provider.capabilities.has("create-campaigns")) {
      throw new RetryableCreationError("Meta Marketing API Provider 尚未实现创建结果对账。");
    }
    return provider.reconcileMetaAd(context, mutation);
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

  async copyCampaign(
    kind: ProviderKind,
    context: ProviderContext,
    input: CopyCampaignInput,
  ): Promise<CopyCampaignResult> {
    const provider = this.get(kind) as unknown as {
      copyCampaign?: (
        context: ProviderContext,
        input: CopyCampaignInput,
      ) => Promise<CopyCampaignResult>;
    };
    if (!provider.copyCampaign || !this.get(kind).capabilities.has("copy-campaigns")) {
      throw new RetryableCreationError("当前接入不支持系列级复制。");
    }
    return provider.copyCampaign(context, input);
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

function defaultProviders(options: ProviderRegistryOptions): AdsProvider[] {
  return [
    new CookieAdsProvider(),
    new OfficialApiAdsProvider(),
    new MetaOfflineAdsProvider(),
    new MetaMarketingApiAdsProvider(options.metaMarketingApiTransportFactory),
  ];
}
