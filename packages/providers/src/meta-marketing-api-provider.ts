import {
  MetaMarketingApiConnectionSettingsSchema,
  MetaAccessSecretBundleInputSchema,
  MetaAdCreationInputSchema,
  type MetaMarketingApiLiveMode,
  type MetaCreationProgress,
  type ProviderEntity,
  type SyncEntityType,
} from "@tk-auto/core";
import { buildSyncDataQuality, formatDateInTimezone } from "./sync-quality.js";
import {
  RetryableStatusMutationError,
  UnknownStatusMutationStateError,
} from "./types.js";
import type {
  AdsProvider,
  ProviderCapability,
  ProviderContext,
  ProviderHealth,
  ProviderSyncOutput,
  MetaAdAccountDiscoveryContext,
  DiscoveredMetaAdAccount,
  ResolvedMetaAccessProfile,
  StatusMutation,
  StatusMutationResult,
  MetaAdCreationMutation,
  MetaAdCreationResult,
} from "./types.js";

export const META_MARKETING_API_NETWORK_DISABLED_MESSAGE =
  "Meta Marketing API 正向合同已建立，但真实网络总开关仍关闭。";

const META_SYNC_CONTRACT_VERSION = "meta-marketing-api-account-today-v2-2026-08";
const META_INSIGHTS_FIELDS = [
  "campaign_id",
  "adset_id",
  "ad_id",
  "spend",
  "cpc",
  "actions",
  "cost_per_action_type",
].join(",");
const META_CONVERSION_ACTION_PRIORITY = [
  "omni_purchase",
  "offsite_conversion.fb_pixel_purchase",
  "purchase",
  "onsite_conversion.purchase",
  "mobile_app_purchase",
] as const;
const META_CART_ACTION_PRIORITY = [
  "omni_add_to_cart",
  "offsite_conversion.fb_pixel_add_to_cart",
  "add_to_cart",
  "onsite_conversion.add_to_cart",
] as const;
const readCapabilities: ReadonlySet<ProviderCapability> = new Set([
  "read-campaigns",
  "read-ad-groups",
  "read-ads",
]);
const noCapabilities: ReadonlySet<ProviderCapability> = new Set();
const capabilities: ReadonlySet<ProviderCapability> = new Set([
  ...readCapabilities,
  "change-status",
  "create-campaigns",
]);

export interface MetaMarketingApiStatusTestScope {
  localAccountId: string;
  adAccountId: string;
  entityType: "campaign" | "ad-group" | "ad";
  externalId: string;
  expectedCurrency: string;
  expectedTimezone: string;
  expiresAt: string;
}

export interface MetaMarketingApiTransportRequest {
  version: string;
  path: string;
  params: Readonly<Record<string, string>>;
  accessToken: string;
  appSecretProof: string;
}

export interface MetaMarketingApiTransportMutationRequest {
  version: string;
  path: string;
  body: Readonly<Record<string, string>>;
  accessToken: string;
  appSecretProof: string;
}

/**
 * Transport is injected so the provider contract can be exercised with fixtures
 * while the desktop build remains physically unable to contact Meta.
 */
export interface MetaMarketingApiTransport {
  get(input: MetaMarketingApiTransportRequest): Promise<unknown>;
  post(input: MetaMarketingApiTransportMutationRequest): Promise<unknown>;
}

export interface MetaMarketingApiTransportFactoryInput {
  purpose: "account-discovery" | "account-operation";
  accountId: string | null;
  adAccountId: string | null;
  profileId: string;
  liveMode: Exclude<MetaMarketingApiLiveMode, "disabled">;
  /** Exact object ids authorized for this single provider operation. */
  allowedMutationExternalIds: readonly string[];
  /** Exact account edges authorized for this single paused-only create task. */
  allowedCreationPaths?: readonly string[];
}

export type MetaMarketingApiTransportFactory = (
  input: MetaMarketingApiTransportFactoryInput,
) => MetaMarketingApiTransport;

export class MetaMarketingApiNetworkDisabledError extends Error {
  override readonly name = "MetaMarketingApiNetworkDisabledError";
}

export class MetaMarketingApiMutationRejectedError extends RetryableStatusMutationError {
}

export class MetaMarketingApiMutationUnknownError extends UnknownStatusMutationStateError {
}

class DisabledMetaMarketingApiTransport implements MetaMarketingApiTransport {
  async get(_input: MetaMarketingApiTransportRequest): Promise<never> {
    throw new MetaMarketingApiNetworkDisabledError(
      META_MARKETING_API_NETWORK_DISABLED_MESSAGE,
    );
  }

  async post(_input: MetaMarketingApiTransportMutationRequest): Promise<never> {
    throw new MetaMarketingApiNetworkDisabledError(
      META_MARKETING_API_NETWORK_DISABLED_MESSAGE,
    );
  }
}

export class MetaMarketingApiAdsProvider implements AdsProvider {
  readonly kind = "meta-marketing-api" as const;
  readonly platform = "meta" as const;
  readonly displayName: string;
  readonly implementationStatus: "scaffolded" | "available";
  readonly capabilityVersion = "meta-marketing-api-live-create-v3-2026-08";
  readonly capabilities = capabilities;
  private readonly transport: MetaMarketingApiTransport | null;
  private readonly transportFactory: MetaMarketingApiTransportFactory | null;

  constructor(
    transportOrFactory?: MetaMarketingApiTransport | MetaMarketingApiTransportFactory,
    private readonly statusTestScope: MetaMarketingApiStatusTestScope | null = null,
  ) {
    this.displayName = transportOrFactory
      ? "Meta Marketing API（官方接入）"
      : "Meta Marketing API（网络未启用）";
    this.implementationStatus = transportOrFactory ? "available" : "scaffolded";
    this.transport = typeof transportOrFactory === "function"
      ? null
      : transportOrFactory ?? null;
    this.transportFactory = typeof transportOrFactory === "function"
      ? transportOrFactory
      : null;
  }

  resolveCapabilities(context: ProviderContext): ReadonlySet<ProviderCapability> {
    try {
      const settings = MetaMarketingApiConnectionSettingsSchema.parse(context.settings);
      resolveMetaAccessProfile(context, settings);
      if (this.statusTestScope) {
        return statusTestScopeContextIssue(this.statusTestScope, context, settings)
          ? readCapabilities
          : capabilities;
      }
      const resolved = new Set<ProviderCapability>(readCapabilities);
      if (
        isStatusLiveMode(settings.liveMode)
        && (settings.allowedStatusEntityTypes?.length ?? 0) > 0
      ) {
        resolved.add("change-status");
      }
      if (settings.creationMode === "paused-only") {
        resolved.add("create-campaigns");
      }
      return resolved;
    } catch {
      return noCapabilities;
    }
  }

  async checkHealth(context: ProviderContext): Promise<ProviderHealth> {
    const settings = MetaMarketingApiConnectionSettingsSchema.parse(context.settings);
    const credential = MetaAccessSecretBundleInputSchema.parse(context.credential);
    const profile = resolveMetaAccessProfile(context, settings);
    const appSecretProof = await createMetaAppSecretProof(
      credential.appSecret,
      credential.accessToken,
    );
    const scopeIssue = this.statusTestScope
      ? statusTestScopeContextIssue(this.statusTestScope, context, settings)
      : null;
    if (scopeIssue) throw new Error(scopeIssue);
    const statusEnabled = this.statusTestScope !== null
      || isStatusLiveMode(settings.liveMode);
    const creationEnabled = settings.creationMode === "paused-only";
    const transport = this.resolveTransport(context, settings, []);
    const permissionPayload = asRecord(await transport.get({
      version: profile.graphApiVersion,
      path: "me/permissions",
      params: { limit: "100" },
      accessToken: credential.accessToken,
      appSecretProof,
    }));
    const grantedPermissions = readGrantedPermissions(permissionPayload);
    if (
      !grantedPermissions.has("ads_read")
      && !grantedPermissions.has("ads_management")
    ) {
      throw new Error("Meta Token 未授予 ads_read 或 ads_management。");
    }
    if ((statusEnabled || creationEnabled) && !grantedPermissions.has("ads_management")) {
      throw new Error("Meta 写入 Token 未授予 ads_management。");
    }
    const verifiedPermission = statusEnabled || creationEnabled
      ? "ads_management"
      : grantedPermissions.has("ads_read")
        ? "ads_read"
        : "ads_management（含读取）";
    const discovered = await this.readDiscoveredAdAccounts(
      transport,
      profile,
      credential.accessToken,
      appSecretProof,
    );
    const expectedId = normalizeAdAccountId(settings.adAccountId);
    const account = discovered.find((candidate) => candidate.adAccountId === expectedId);
    if (!account) {
      throw new Error("Meta 绑定广告账户不属于当前共享凭据 Profile。");
    }
    if (account.accountStatus !== 1) {
      throw new Error("Meta 广告账户不是可投放的 ACTIVE 状态。");
    }
    if (account.currency !== "USD") {
      throw new Error("Meta 广告账户币种必须为 USD。");
    }
    if (account.timezone !== "Asia/Shanghai") {
      throw new Error("Meta 广告账户时区必须为 Asia/Shanghai。");
    }
    if (!context.timezone || account.timezone !== context.timezone) {
      throw new Error("Meta 广告账户时区与本地账户时区不一致。");
    }
    if (this.statusTestScope) {
      if (account.currency !== this.statusTestScope.expectedCurrency) {
        throw new Error("Meta 广告账户币种与状态实测 Scope 不一致。");
      }
      if (account.timezone !== this.statusTestScope.expectedTimezone) {
        throw new Error("Meta 广告账户时区与状态实测 Scope 不一致。");
      }
    }
    return {
      ok: true,
      status: "ready",
      message: `Meta 广告账户与 ${verifiedPermission} 验证成功（${account.currency} / ${account.timezone}）。`,
    };
  }

  async discoverAdAccounts(
    context: MetaAdAccountDiscoveryContext,
  ): Promise<DiscoveredMetaAdAccount[]> {
    const profile = validateResolvedMetaAccessProfile(context.resolvedMetaAccessProfile);
    const credential = MetaAccessSecretBundleInputSchema.parse(context.credential);
    const appSecretProof = await createMetaAppSecretProof(
      credential.appSecret,
      credential.accessToken,
    );
    const transport = this.resolveDiscoveryTransport(profile);
    return this.readDiscoveredAdAccounts(
      transport,
      profile,
      credential.accessToken,
      appSecretProof,
    );
  }

  async syncReadOnly(context: ProviderContext): Promise<ProviderSyncOutput> {
    const settings = MetaMarketingApiConnectionSettingsSchema.parse(context.settings);
    const credential = MetaAccessSecretBundleInputSchema.parse(context.credential);
    const profile = resolveMetaAccessProfile(context, settings);
    const appSecretProof = await createMetaAppSecretProof(
      credential.appSecret,
      credential.accessToken,
    );
    const transport = this.resolveTransport(context, settings, []);
    const startedAt = new Date().toISOString();
    const entities: ProviderEntity[] = [];
    let paginationComplete = true;
    let contractValid = true;

    const edgeConfigs: Array<{
      edge: "campaigns" | "adsets" | "ads";
      entityType: SyncEntityType;
      fields: string;
    }> = [
      {
        edge: "campaigns",
        entityType: "campaign",
        fields: "id,name,status,effective_status,objective,buying_type,special_ad_categories,created_time,updated_time",
      },
      {
        edge: "adsets",
        entityType: "ad-group",
        fields: "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,start_time,end_time,optimization_goal,billing_event,bid_strategy,targeting,created_time,updated_time",
      },
      {
        edge: "ads",
        entityType: "ad",
        fields: "id,name,adset_id,campaign_id,status,effective_status,creative{id,name},created_time,updated_time",
      },
    ];

    for (const config of edgeConfigs) {
      const result = await this.readEdge(
        transport,
        profile.graphApiVersion,
        normalizeAdAccountId(settings.adAccountId),
        config,
        credential.accessToken,
        appSecretProof,
      );
      entities.push(...result.entities);
      paginationComplete &&= result.paginationComplete;
      contractValid &&= result.contractValid;
    }

    const entityByKey = new Map(
      entities.map((entity) => [`${entity.entityType}:${entity.externalId}`, entity]),
    );
    for (const entity of entities) {
      entity.payload = {
        ...entity.payload,
        spend: 0,
        cpc: 0,
        conversions: 0,
        carts: 0,
        cost_per_conversion: 0,
      };
    }
    const insightConfigs = [
      { level: "campaign", entityType: "campaign", idField: "campaign_id" },
      { level: "adset", entityType: "ad-group", idField: "adset_id" },
      { level: "ad", entityType: "ad", idField: "ad_id" },
    ] as const;
    for (const config of insightConfigs) {
      const result = await this.readInsights(
        transport,
        profile.graphApiVersion,
        normalizeAdAccountId(settings.adAccountId),
        config,
        credential.accessToken,
        appSecretProof,
        entityByKey,
      );
      paginationComplete &&= result.paginationComplete;
      contractValid &&= result.contractValid;
    }

    const finishedAt = new Date().toISOString();
    const timezone = context.timezone ?? "UTC";
    const date = formatDateInTimezone(new Date(finishedAt), timezone);
    const partialFailures: string[] = [];
    return {
      entities,
      result: {
        startedAt,
        finishedAt,
        counts: {
          campaign: entities.filter((item) => item.entityType === "campaign").length,
          "ad-group": entities.filter((item) => item.entityType === "ad-group").length,
          ad: entities.filter((item) => item.entityType === "ad").length,
          material: 0,
        },
        warnings: ["Meta 指标来自广告账户时区的 account-today Insights。"],
        quality: buildSyncDataQuality({
          entities,
          paginationComplete,
          contractValid,
          providerContractVersion: META_SYNC_CONTRACT_VERSION,
          coverage: { startDate: date, endDate: date, timezone },
          partialFailures,
          completeEntityTypes: ["campaign", "ad-group", "ad"],
        }),
      },
    };
  }

  async changeStatus(
    context: ProviderContext,
    mutations: StatusMutation[],
  ): Promise<StatusMutationResult[]> {
    if (mutations.length === 0) return [];
    let settings: ReturnType<typeof MetaMarketingApiConnectionSettingsSchema.parse>;
    let credential: ReturnType<typeof MetaAccessSecretBundleInputSchema.parse>;
    let profile: NonNullable<ProviderContext["resolvedMetaAccessProfile"]>;
    let appSecretProof: string;
    try {
      settings = MetaMarketingApiConnectionSettingsSchema.parse(context.settings);
      credential = MetaAccessSecretBundleInputSchema.parse(context.credential);
      profile = resolveMetaAccessProfile(context, settings);
      appSecretProof = await createMetaAppSecretProof(
        credential.appSecret,
        credential.accessToken,
      );
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "Meta Marketing API 状态请求参数无效。";
      return mutations.map((mutation) => ({
        ...mutation,
        ok: false,
        failureKind: "retryable",
        message,
      }));
    }

    const scopeIssue = statusMutationPolicyIssue(
      this.statusTestScope,
      context,
      settings,
      mutations,
    );
    if (scopeIssue) {
      return mutations.map((mutation) => ({
        ...mutation,
        ok: false,
        failureKind: "retryable",
        message: `${scopeIssue} 未发送任何请求。`,
      }));
    }

    const results: StatusMutationResult[] = [];
    const mutation = mutations[0];
    if (!mutation) return [];
    let transport: MetaMarketingApiTransport;
    try {
      transport = this.resolveTransport(context, settings, [mutation.externalId]);
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "Meta 手动启停 Transport 初始化失败。";
      return mutations.map((item) => ({
        ...item,
        ok: false,
        failureKind: "retryable" as const,
        message: `${message} 未发送任何请求。`,
      }));
    }
    for (const mutation of mutations) {
      if (mutation.entityType === "material") {
        results.push({
          ...mutation,
          ok: false,
          failureKind: "retryable",
          message: "Meta Marketing API 不支持素材层启停；未发送任何请求。",
        });
        continue;
      }
      if (!/^\d+$/.test(mutation.externalId)) {
        results.push({
          ...mutation,
          ok: false,
          failureKind: "retryable",
          message: "Meta 对象 ID 必须是数字；未发送任何请求。",
        });
        continue;
      }

      let postResolved = false;
      try {
        const targetStatus = mutation.action === "enable" ? "ACTIVE" : "PAUSED";
        const response = await transport.post({
          version: profile.graphApiVersion,
          path: mutation.externalId,
          body: { status: targetStatus },
          accessToken: credential.accessToken,
          appSecretProof,
        });
        postResolved = true;
        const acknowledged = isRecord(response) && response.success === true;

        const readback = asRecord(await transport.get({
          version: profile.graphApiVersion,
          path: mutation.externalId,
          params: { fields: "id,status,effective_status" },
          accessToken: credential.accessToken,
          appSecretProof,
        }));
        const actualId = readEntityId(readback);
        const actualStatus = typeof readback.status === "string"
          ? readback.status
          : null;
        if (actualId !== mutation.externalId || actualStatus !== targetStatus) {
          throw new MetaMarketingApiMutationUnknownError(
            `Meta 写后回读不一致（期望 ${targetStatus}，ACK=${acknowledged ? "success" : "ambiguous"}），远端结果待确认。`,
          );
        }
        const effectiveStatus = typeof readback.effective_status === "string"
          ? `，effective_status=${readback.effective_status}`
          : "";
        results.push({
          ...mutation,
          ok: true,
          message: `Meta 状态更新已写后确认：status=${targetStatus}${effectiveStatus}。`,
        });
      } catch (cause) {
        const retryable = !postResolved && (
          cause instanceof RetryableStatusMutationError
          || cause instanceof MetaMarketingApiNetworkDisabledError
        );
        results.push({
          ...mutation,
          ok: false,
          failureKind: retryable ? "retryable" : "unknown",
          message: cause instanceof Error
            ? cause.message
            : "Meta 状态更新失败，远端结果待确认。",
        });
      }
    }
    return results;
  }

  async createMetaAd(
    context: ProviderContext,
    mutation: MetaAdCreationMutation,
  ): Promise<MetaAdCreationResult> {
    let settings: ReturnType<typeof MetaMarketingApiConnectionSettingsSchema.parse>;
    let credential: ReturnType<typeof MetaAccessSecretBundleInputSchema.parse>;
    let profile: NonNullable<ProviderContext["resolvedMetaAccessProfile"]>;
    let input: ReturnType<typeof MetaAdCreationInputSchema.parse>;
    let appSecretProof: string;
    try {
      settings = MetaMarketingApiConnectionSettingsSchema.parse(context.settings);
      credential = MetaAccessSecretBundleInputSchema.parse(context.credential);
      profile = resolveMetaAccessProfile(context, settings);
      input = MetaAdCreationInputSchema.parse(mutation.input);
      appSecretProof = await createMetaAppSecretProof(
        credential.appSecret,
        credential.accessToken,
      );
      if (settings.creationMode !== "paused-only") {
        throw new Error("Meta 账户未开启 PAUSED-only 创建模式。");
      }
      if (input.targetLevel === "ad" && !settings.pageId) {
        throw new Error("Meta 创建广告必须绑定 Page ID。");
      }
    } catch (cause) {
      return {
        ok: false,
        failureKind: "retryable",
        message: cause instanceof Error ? cause.message : "Meta 创建参数无效。",
      };
    }

    const accountPath = normalizeAdAccountId(settings.adAccountId);
    const creationPaths = (input.targetLevel === "ad"
      ? ["campaigns", "adsets", "adcreatives", "ads"]
      : ["campaigns", "adsets"])
      .map((edge) => `${accountPath}/${edge}`);
    let transport: MetaMarketingApiTransport;
    try {
      transport = this.resolveTransport(context, settings, [], creationPaths);
    } catch (cause) {
      return {
        ok: false,
        failureKind: "retryable",
        message: cause instanceof Error ? cause.message : "Meta 创建 Transport 初始化失败。",
      };
    }

    const ids = { ...mutation.existing };
    const campaignBody = {
      name: input.campaignName,
      objective: input.objective,
      status: "PAUSED",
      buying_type: "AUCTION",
      special_ad_categories: "[]",
      is_adset_budget_sharing_enabled: "false",
    };
    const progress = (value: MetaCreationProgress): void => mutation.onProgress?.(value);
    const create = async (
      edge: "campaigns" | "adsets" | "adcreatives" | "ads",
      body: Record<string, string>,
      phase: MetaCreationProgress["phase"],
      rememberAcceptedId: (id: string) => void,
      readbackFields: string,
      requestToken = credential.accessToken,
      requestProof = appSecretProof,
    ): Promise<void> => {
      const expectedName = body.name;
      if (!expectedName) {
        throw new MetaMarketingApiMutationRejectedError("Meta 创建名称为空，未发送请求。");
      }
      mutation.onBeforeDispatch?.();
      const payload = asRecord(await transport.post({
        version: profile.graphApiVersion,
        path: `${accountPath}/${edge}`,
        body,
        accessToken: requestToken,
        appSecretProof: requestProof,
      }));
      const id = readCreatedId(payload, phase);
      rememberAcceptedId(id);
      progress({
        phase,
        ...ids,
        message: `Meta ${phase} 已返回 ID，正在执行写后回读。`,
      });
      const readback = asRecord(await transport.get({
        version: profile.graphApiVersion,
        path: id,
        params: { fields: readbackFields },
        accessToken: requestToken,
        appSecretProof: requestProof,
      }));
      if (
        readEntityId(readback) !== id
        || !createdObjectNameMatches(readback.name, expectedName, phase === "creative")
        || (phase !== "creative" && readback.status !== "PAUSED")
      ) {
        throw new MetaMarketingApiMutationUnknownError(
          `Meta ${phase} 创建已返回 ID，但写后回读不一致。`,
        );
      }
    };

    try {
      const validate = async (
        edge: "campaigns" | "adcreatives" | "ads",
        body: Record<string, string>,
        requestToken: string,
        requestProof: string,
      ): Promise<void> => {
        const payload = asRecord(await transport.post({
          version: profile.graphApiVersion,
          path: `${accountPath}/${edge}`,
          body: { ...body, execution_options: '["validate_only"]' },
          accessToken: requestToken,
          appSecretProof: requestProof,
        }));
        if (payload.success !== true) {
          throw new MetaMarketingApiMutationUnknownError(
            `Meta ${edge} validate_only 未返回 success=true。`,
          );
        }
      };
      await validate("campaigns", campaignBody, credential.accessToken, appSecretProof);

      let adContext: {
        creativeBody: Record<string, string>;
        pageAccessToken: string;
        pageAppSecretProof: string;
      } | null = null;
      if (input.targetLevel === "ad") {
        if (!settings.pageId) {
          throw new MetaMarketingApiMutationRejectedError("Meta 创建广告必须绑定 Page ID。");
        }
        const pageAccessToken = await this.readPageAccessToken(
          transport,
          profile.graphApiVersion,
          settings.pageId,
          credential.accessToken,
          appSecretProof,
        );
        const pageAppSecretProof = await createMetaAppSecretProof(
          credential.appSecret,
          pageAccessToken,
        );
        const linkData: Record<string, unknown> = {
          link: input.destinationUrl,
          message: input.primaryText,
          name: input.headline,
          description: input.description,
          ...(input.callToAction === "NO_BUTTON"
            ? {}
            : {
                call_to_action: {
                  type: input.callToAction,
                  value: { link: input.destinationUrl },
                },
              }),
          ...(input.imageHash ? { image_hash: input.imageHash } : {}),
        };
        const creativeBody = {
          name: input.creativeName,
          object_story_spec: JSON.stringify({
            page_id: settings.pageId,
            link_data: linkData,
          }),
        };
        await validate("adcreatives", creativeBody, pageAccessToken, pageAppSecretProof);
        adContext = { creativeBody, pageAccessToken, pageAppSecretProof };
      }

      if (!ids.campaignId) {
        await create(
          "campaigns",
          campaignBody,
          "campaign",
          (id) => { ids.campaignId = id; },
          "id,name,status,effective_status",
        );
        progress({
          phase: "campaign",
          campaignId: ids.campaignId,
          message: "Campaign 已创建并回读确认。",
        });
      }
      if (!ids.campaignId) {
        throw new MetaMarketingApiMutationUnknownError("Meta Campaign ID 未能持久化。");
      }
      if (!ids.adSetId) {
        await create("adsets", {
          name: input.adSetName,
          campaign_id: ids.campaignId,
          daily_budget: String(input.dailyBudgetMinorUnits),
          billing_event: input.billingEvent,
          optimization_goal: input.optimizationGoal,
          destination_type: input.destinationType,
          targeting: JSON.stringify({ geo_locations: { countries: input.countries } }),
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
          status: "PAUSED",
        }, "ad-set", (id) => { ids.adSetId = id; }, "id,name,status,effective_status");
        progress({
          phase: "ad-set",
          campaignId: ids.campaignId,
          adSetId: ids.adSetId,
          message: "Ad Set 已创建并回读确认。",
        });
      }
      if (!ids.adSetId) {
        throw new MetaMarketingApiMutationUnknownError("Meta Ad Set ID 未能持久化。");
      }
      if (input.targetLevel === "ad-set") {
        return {
          ok: true,
          campaignId: ids.campaignId,
          adSetId: ids.adSetId,
          message: "Meta Campaign 与 Ad Set 已按 PAUSED 状态创建并回读确认。",
        };
      }
      if (!adContext) {
        throw new MetaMarketingApiMutationRejectedError("Meta Ad 创建前置校验未完成。");
      }
      const { creativeBody, pageAccessToken, pageAppSecretProof } = adContext;
      if (!ids.creativeId) {
        await create(
          "adcreatives",
          creativeBody,
          "creative",
          (id) => { ids.creativeId = id; },
          "id,name",
          pageAccessToken,
          pageAppSecretProof,
        );
        progress({
          phase: "creative",
          campaignId: ids.campaignId,
          adSetId: ids.adSetId,
          creativeId: ids.creativeId,
          message: "Creative 已创建并回读确认。",
        });
      }
      if (!ids.creativeId) {
        throw new MetaMarketingApiMutationUnknownError("Meta Creative ID 未能持久化。");
      }
      if (!ids.adId) {
        const adBody = {
          name: input.adName,
          adset_id: ids.adSetId,
          creative: JSON.stringify({ creative_id: ids.creativeId }),
          status: "PAUSED",
        };
        await validate("ads", adBody, pageAccessToken, pageAppSecretProof);
        await create(
          "ads",
          adBody,
          "ad",
          (id) => { ids.adId = id; },
          "id,name,status,effective_status",
          pageAccessToken,
          pageAppSecretProof,
        );
        progress({
          phase: "ad",
          campaignId: ids.campaignId,
          adSetId: ids.adSetId,
          creativeId: ids.creativeId,
          adId: ids.adId,
          message: "Ad 已创建并回读确认。",
        });
      }
      return {
        ok: true,
        ...ids,
        message: "Meta Campaign、Ad Set、Creative 与 Ad 已按 PAUSED 状态创建并回读确认。",
      };
    } catch (cause) {
      return {
        ok: false,
        ...ids,
        failureKind: cause instanceof MetaMarketingApiMutationRejectedError
          || cause instanceof MetaMarketingApiNetworkDisabledError
          ? "retryable"
          : "unknown",
        message: cause instanceof Error ? cause.message : "Meta 创建结果待确认。",
      };
    }
  }

  async reconcileMetaAd(
    context: ProviderContext,
    mutation: Pick<MetaAdCreationMutation, "input" | "existing">,
  ): Promise<MetaAdCreationResult> {
    let settings: ReturnType<typeof MetaMarketingApiConnectionSettingsSchema.parse>;
    let credential: ReturnType<typeof MetaAccessSecretBundleInputSchema.parse>;
    let profile: NonNullable<ProviderContext["resolvedMetaAccessProfile"]>;
    let input: ReturnType<typeof MetaAdCreationInputSchema.parse>;
    let appSecretProof: string;
    try {
      settings = MetaMarketingApiConnectionSettingsSchema.parse(context.settings);
      credential = MetaAccessSecretBundleInputSchema.parse(context.credential);
      profile = resolveMetaAccessProfile(context, settings);
      input = MetaAdCreationInputSchema.parse(mutation.input);
      appSecretProof = await createMetaAppSecretProof(
        credential.appSecret,
        credential.accessToken,
      );
      if (settings.creationMode !== "paused-only") {
        throw new Error("Meta 账户未开启 PAUSED-only 创建模式。");
      }
    } catch (cause) {
      return {
        ok: false,
        failureKind: "unknown",
        message: cause instanceof Error ? cause.message : "Meta 创建对账参数无效。",
      };
    }

    const ids = { ...mutation.existing };
    let transport: MetaMarketingApiTransport;
    try {
      transport = this.resolveTransport(context, settings, []);
      const resolveOne = async (
        edge: "campaigns" | "adsets" | "adcreatives" | "ads",
        expectedName: string,
        fields: string,
        currentId: string | undefined,
      ): Promise<Record<string, unknown> | null> => {
        if (currentId) {
          const record = asRecord(await transport.get({
            version: profile.graphApiVersion,
            path: currentId,
            params: { fields },
            accessToken: credential.accessToken,
            appSecretProof,
          }));
          if (
            readEntityId(record) !== currentId
            || !createdObjectNameMatches(record.name, expectedName, edge === "adcreatives")
          ) {
            throw new Error(`Meta ${edge} 已记录 ID 与远端对象不一致。`);
          }
          return record;
        }
        const matches = await this.readExactNameMatches(
          transport,
          profile.graphApiVersion,
          settings.adAccountId,
          edge,
          expectedName,
          fields,
          credential.accessToken,
          appSecretProof,
        );
        if (matches.length > 1) {
          throw new Error(`Meta ${edge} 存在多个同名对象，创建结果保持 unknown。`);
        }
        return matches[0] ?? null;
      };

      const campaign = await resolveOne(
        "campaigns",
        input.campaignName,
        "id,name,status,effective_status",
        ids.campaignId,
      );
      if (!campaign) {
        return { ok: false, failureKind: "retryable", message: "只读对账确认 Campaign 不存在，可以安全继续创建。" };
      }
      ids.campaignId = readEntityId(campaign);
      if (campaign.status !== "PAUSED") throw new Error("对账 Campaign 已不再是 PAUSED。 ");

      const adSet = await resolveOne(
        "adsets",
        input.adSetName,
        "id,name,campaign_id,status,effective_status",
        ids.adSetId,
      );
      if (!adSet) {
        return { ok: false, ...ids, failureKind: "retryable", message: "只读对账确认 Ad Set 不存在，可以从 Campaign 继续。" };
      }
      ids.adSetId = readEntityId(adSet);
      if (adSet.status !== "PAUSED" || adSet.campaign_id !== ids.campaignId) {
        throw new Error("对账 Ad Set 的状态或父级不一致。");
      }

      if (input.targetLevel === "ad-set") {
        return {
          ok: true,
          campaignId: ids.campaignId,
          adSetId: ids.adSetId,
          message: "Meta Campaign 与 Ad Set 已通过只读对账确认，且均保持 PAUSED。",
        };
      }

      const creative = await resolveOne(
        "adcreatives",
        input.creativeName,
        "id,name",
        ids.creativeId,
      );
      if (!creative) {
        return { ok: false, ...ids, failureKind: "retryable", message: "只读对账确认 Creative 不存在，可以从 Ad Set 继续。" };
      }
      ids.creativeId = readEntityId(creative);

      const ad = await resolveOne(
        "ads",
        input.adName,
        "id,name,adset_id,creative,status,effective_status",
        ids.adId,
      );
      if (!ad) {
        return { ok: false, ...ids, failureKind: "retryable", message: "只读对账确认 Ad 不存在，可以从 Creative 继续。" };
      }
      ids.adId = readEntityId(ad);
      const adCreative = isRecord(ad.creative) ? ad.creative : null;
      if (
        ad.status !== "PAUSED"
        || ad.adset_id !== ids.adSetId
        || adCreative?.id !== ids.creativeId
      ) {
        throw new Error("对账 Ad 的状态、Ad Set 或 Creative 不一致。");
      }
      return {
        ok: true,
        ...ids,
        message: "Meta 四层对象已通过只读对账确认，且 Ad 保持 PAUSED。",
      };
    } catch (cause) {
      return {
        ok: false,
        ...ids,
        failureKind: "unknown",
        message: cause instanceof Error ? cause.message : "Meta 创建只读对账仍无法确认。",
      };
    }
  }

  private async readExactNameMatches(
    transport: MetaMarketingApiTransport,
    version: string,
    adAccountId: string,
    edge: "campaigns" | "adsets" | "adcreatives" | "ads",
    expectedName: string,
    fields: string,
    accessToken: string,
    appSecretProof: string,
  ): Promise<Record<string, unknown>[]> {
    const matches: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const payload = asRecord(await transport.get({
        version,
        path: `${adAccountId}/${edge}`,
        params: { fields, limit: "100", ...(after ? { after } : {}) },
        accessToken,
        appSecretProof,
      }));
      if (!Array.isArray(payload.data)) throw new Error(`Meta ${edge} 对账响应结构无效。`);
      for (const item of payload.data) {
        if (
          isRecord(item)
          && createdObjectNameMatches(item.name, expectedName, edge === "adcreatives")
        ) matches.push(item);
      }
      const paging = isRecord(payload.paging) ? payload.paging : null;
      const cursors = paging && isRecord(paging.cursors) ? paging.cursors : null;
      const next = typeof cursors?.after === "string" ? cursors.after : null;
      if (!next || seen.has(next) || typeof paging?.next !== "string") return matches;
      seen.add(next);
      after = next;
    }
    throw new Error(`Meta ${edge} 对账分页超过上限。`);
  }

  private async readPageAccessToken(
    transport: MetaMarketingApiTransport,
    version: string,
    pageId: string,
    userAccessToken: string,
    userAppSecretProof: string,
  ): Promise<string> {
    let after: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const payload = asRecord(await transport.get({
        version,
        path: "me/accounts",
        params: {
          fields: "id,access_token,tasks",
          limit: "100",
          ...(after ? { after } : {}),
        },
        accessToken: userAccessToken,
        appSecretProof: userAppSecretProof,
      }));
      if (!Array.isArray(payload.data)) {
        throw new Error("Meta Page 授权响应结构无效。");
      }
      for (const raw of payload.data) {
        if (!isRecord(raw) || raw.id !== pageId) continue;
        const tasks = Array.isArray(raw.tasks)
          ? raw.tasks.filter((item): item is string => typeof item === "string")
          : [];
        if (!tasks.includes("ADVERTISE")) {
          throw new Error("Meta Page 未向当前用户授予 ADVERTISE 任务。");
        }
        if (typeof raw.access_token !== "string" || raw.access_token.length < 20) {
          throw new Error("Meta Page Access Token 不可用。");
        }
        return raw.access_token;
      }
      const paging = isRecord(payload.paging) ? payload.paging : null;
      const cursors = paging && isRecord(paging.cursors) ? paging.cursors : null;
      const next = typeof cursors?.after === "string" ? cursors.after : null;
      if (!next || seen.has(next) || typeof paging?.next !== "string") break;
      seen.add(next);
      after = next;
    }
    throw new Error("绑定的 Meta Page 不在当前 Token 可广告投放的 Page 列表中。");
  }

  private async readEdge(
    transport: MetaMarketingApiTransport,
    version: string,
    adAccountId: string,
    config: {
      edge: "campaigns" | "adsets" | "ads";
      entityType: SyncEntityType;
      fields: string;
    },
    accessToken: string,
    appSecretProof: string,
  ): Promise<{
    entities: ProviderEntity[];
    paginationComplete: boolean;
    contractValid: boolean;
  }> {
    const entities: ProviderEntity[] = [];
    const seenCursors = new Set<string>();
    let after: string | undefined;
    let paginationComplete = true;
    let contractValid = true;

    for (let page = 0; page < 100; page += 1) {
      const response = asRecord(await transport.get({
        version,
        path: `${adAccountId}/${config.edge}`,
        params: {
          fields: config.fields,
          limit: "100",
          ...(after ? { after } : {}),
        },
        accessToken,
        appSecretProof,
      }));
      if (!Array.isArray(response.data)) {
        contractValid = false;
        paginationComplete = false;
        break;
      }
      for (const item of response.data) {
        if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) {
          contractValid = false;
          continue;
        }
        entities.push({
          entityType: config.entityType,
          externalId: item.id,
          payload: {
            ...item,
            ...(item.status === "ACTIVE" || item.status === "PAUSED"
              ? { operation_status: item.status }
              : {}),
            ...(typeof item.created_time === "string"
              ? { create_time: item.created_time }
              : {}),
            ...(config.entityType === "ad" && typeof item.adset_id === "string"
              ? { adgroup_id: item.adset_id }
              : {}),
            metaEntityType: config.edge,
          },
        });
      }
      const paging = isRecord(response.paging) ? response.paging : null;
      const cursors = paging && isRecord(paging.cursors) ? paging.cursors : null;
      const nextCursor = typeof cursors?.after === "string" && cursors.after.length > 0
        ? cursors.after
        : undefined;
      const hasNext = typeof paging?.next === "string" && paging.next.length > 0;
      if (!hasNext) break;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        paginationComplete = false;
        contractValid = false;
        break;
      }
      seenCursors.add(nextCursor);
      after = nextCursor;
      if (page === 99) paginationComplete = false;
    }
    return { entities, paginationComplete, contractValid };
  }

  private async readDiscoveredAdAccounts(
    transport: MetaMarketingApiTransport,
    profile: ResolvedMetaAccessProfile,
    accessToken: string,
    appSecretProof: string,
  ): Promise<DiscoveredMetaAdAccount[]> {
    const accounts: DiscoveredMetaAdAccount[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    const path = profile.businessId
      ? `${profile.businessId}/owned_ad_accounts`
      : "me/adaccounts";
    let after: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const response = asRecord(await transport.get({
        version: profile.graphApiVersion,
        path,
        params: {
          fields: "id,name,currency,timezone_name,account_status",
          limit: "100",
          ...(after ? { after } : {}),
        },
        accessToken,
        appSecretProof,
      }));
      if (!Array.isArray(response.data)) {
        throw new Error("Meta 广告账户发现响应结构无效。");
      }
      for (const item of response.data) {
        if (!isRecord(item)) throw new Error("Meta 广告账户发现行结构无效。");
        const id = typeof item.id === "string" ? normalizeAdAccountId(item.id) : null;
        const name = typeof item.name === "string" ? item.name : null;
        const currency = typeof item.currency === "string" ? item.currency : null;
        const timezone = typeof item.timezone_name === "string" ? item.timezone_name : null;
        const accountStatus = typeof item.account_status === "number"
          ? item.account_status
          : typeof item.account_status === "string" && /^\d+$/.test(item.account_status)
            ? Number(item.account_status)
            : null;
        if (
          !id
          || !/^act_\d+$/.test(id)
          || name === null
          || !currency
          || !/^[A-Z]{3}$/.test(currency)
          || !timezone
          || accountStatus === null
          || seenIds.has(id)
        ) {
          throw new Error("Meta 广告账户发现行不符合合同。");
        }
        seenIds.add(id);
        accounts.push({ adAccountId: id, name, currency, timezone, accountStatus });
      }
      const paging = isRecord(response.paging) ? response.paging : null;
      const cursors = paging && isRecord(paging.cursors) ? paging.cursors : null;
      const nextCursor = typeof cursors?.after === "string" && cursors.after.length > 0
        ? cursors.after
        : undefined;
      const hasNext = typeof paging?.next === "string" && paging.next.length > 0;
      if (!hasNext) break;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new Error("Meta 广告账户发现分页不完整。");
      }
      seenCursors.add(nextCursor);
      after = nextCursor;
      if (page === 99) throw new Error("Meta 广告账户发现分页超过安全上限。");
    }
    return accounts;
  }

  private async readInsights(
    transport: MetaMarketingApiTransport,
    version: string,
    adAccountId: string,
    config: {
      level: "campaign" | "adset" | "ad";
      entityType: "campaign" | "ad-group" | "ad";
      idField: "campaign_id" | "adset_id" | "ad_id";
    },
    accessToken: string,
    appSecretProof: string,
    entityByKey: Map<string, ProviderEntity>,
  ): Promise<{ paginationComplete: boolean; contractValid: boolean }> {
    const seenCursors = new Set<string>();
    const seenEntityIds = new Set<string>();
    let after: string | undefined;
    let paginationComplete = true;
    let contractValid = true;

    for (let page = 0; page < 100; page += 1) {
      const response = asRecord(await transport.get({
        version,
        path: `${adAccountId}/insights`,
        params: {
          fields: META_INSIGHTS_FIELDS,
          date_preset: "today",
          level: config.level,
          limit: "100",
          ...(after ? { after } : {}),
        },
        accessToken,
        appSecretProof,
      }));
      if (!Array.isArray(response.data)) {
        contractValid = false;
        paginationComplete = false;
        break;
      }
      for (const item of response.data) {
        if (!isRecord(item)) {
          contractValid = false;
          continue;
        }
        const rawExternalId = item[config.idField];
        const externalId = typeof rawExternalId === "string"
          ? rawExternalId
          : null;
        const entity = externalId
          ? entityByKey.get(`${config.entityType}:${externalId}`)
          : null;
        if (!externalId || !entity || seenEntityIds.has(externalId)) {
          contractValid = false;
          continue;
        }
        seenEntityIds.add(externalId);
        const metrics = readMetaInsightMetrics(item);
        contractValid &&= metrics.contractValid;
        if (!metrics.contractValid) continue;
        entity.payload = {
          ...entity.payload,
          ...metrics.payload,
          metaInsightLevel: config.level,
          metaInsightDatePreset: "today",
        };
      }
      const paging = isRecord(response.paging) ? response.paging : null;
      const cursors = paging && isRecord(paging.cursors) ? paging.cursors : null;
      const nextCursor = typeof cursors?.after === "string" && cursors.after.length > 0
        ? cursors.after
        : undefined;
      const hasNext = typeof paging?.next === "string" && paging.next.length > 0;
      if (!hasNext) break;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        paginationComplete = false;
        contractValid = false;
        break;
      }
      seenCursors.add(nextCursor);
      after = nextCursor;
      if (page === 99) paginationComplete = false;
    }
    return { paginationComplete, contractValid };
  }

  private resolveTransport(
    context: ProviderContext,
    settings: ReturnType<typeof MetaMarketingApiConnectionSettingsSchema.parse>,
    allowedMutationExternalIds: readonly string[],
    allowedCreationPaths: readonly string[] = [],
  ): MetaMarketingApiTransport {
    if (this.transport) return this.transport;
    const liveMode = settings.liveMode ?? "disabled";
    if (liveMode !== "disabled" && this.transportFactory) {
      return this.transportFactory({
        purpose: "account-operation",
        accountId: context.accountId,
        adAccountId: normalizeAdAccountId(settings.adAccountId),
        profileId: settings.profileId ?? "",
        liveMode,
        allowedMutationExternalIds,
        allowedCreationPaths,
      });
    }
    return new DisabledMetaMarketingApiTransport();
  }

  private resolveDiscoveryTransport(
    profile: ResolvedMetaAccessProfile,
  ): MetaMarketingApiTransport {
    if (this.transport) return this.transport;
    if (this.transportFactory) {
      return this.transportFactory({
        purpose: "account-discovery",
        accountId: null,
        adAccountId: null,
        profileId: profile.profileId,
        liveMode: "read-only",
        allowedMutationExternalIds: [],
        allowedCreationPaths: [],
      });
    }
    return new DisabledMetaMarketingApiTransport();
  }
}

function normalizeAdAccountId(value: string): string {
  return value.startsWith("act_") ? value : `act_${value}`;
}

function readId(value: Record<string, unknown>): string {
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("Meta 广告账户响应缺少 ID。");
  }
  return value.id.startsWith("act_") ? value.id.slice(4) : value.id;
}

function readEntityId(value: Record<string, unknown>): string {
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new MetaMarketingApiMutationUnknownError(
      "Meta 写后回读缺少对象 ID，远端结果待确认。",
    );
  }
  return value.id;
}

function readCreatedId(
  value: Record<string, unknown>,
  phase: MetaCreationProgress["phase"],
): string {
  if (typeof value.id !== "string" || !/^\d+$/.test(value.id)) {
    throw new MetaMarketingApiMutationUnknownError(
      `Meta ${phase} 创建响应缺少数字 ID，远端结果待确认。`,
    );
  }
  return value.id;
}

function createdObjectNameMatches(
  actual: unknown,
  expected: string,
  allowMetaCreativeSuffix: boolean,
): boolean {
  if (actual === expected) return true;
  if (
    !allowMetaCreativeSuffix
    || typeof actual !== "string"
    || !actual.startsWith(expected)
  ) return false;
  return /^ \d{4}-\d{2}-\d{2}-[a-f0-9]{32}$/.test(actual.slice(expected.length));
}

function readGrantedPermissions(payload: Record<string, unknown>): Set<string> {
  if (!Array.isArray(payload.data)) {
    throw new Error("Meta 权限响应结构无效。");
  }
  const granted = new Set<string>();
  for (const item of payload.data) {
    if (
      isRecord(item)
      && typeof item.permission === "string"
      && item.status === "granted"
    ) granted.add(item.permission);
  }
  return granted;
}

function resolveMetaAccessProfile(
  context: ProviderContext,
  settings: ReturnType<typeof MetaMarketingApiConnectionSettingsSchema.parse>,
): NonNullable<ProviderContext["resolvedMetaAccessProfile"]> {
  if (!settings.profileId) {
    throw new Error("Meta 账户尚未绑定共享凭据 Profile，网络保持关闭。");
  }
  const profile = context.resolvedMetaAccessProfile;
  if (!profile) {
    throw new Error("Meta 共享凭据 Profile 未解析，网络保持关闭。");
  }
  if (profile.profileId !== settings.profileId) {
    throw new Error("Meta 共享凭据 Profile 与账户绑定不一致，网络保持关闭。");
  }
  return validateResolvedMetaAccessProfile(profile);
}

function validateResolvedMetaAccessProfile(
  profile: ResolvedMetaAccessProfile,
): ResolvedMetaAccessProfile {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profile.profileId)) {
    throw new Error("Meta 共享凭据 Profile ID 无效。");
  }
  if (!/^\d+$/.test(profile.appId)) {
    throw new Error("Meta 共享凭据 Profile 的 App ID 无效。");
  }
  if (profile.businessId != null && !/^\d+$/.test(profile.businessId)) {
    throw new Error("Meta 共享凭据 Profile 的 Business ID 无效。");
  }
  if (!/^v\d+\.\d+$/.test(profile.graphApiVersion)) {
    throw new Error("Meta 共享凭据 Profile 的 Graph API 版本无效。");
  }
  return profile;
}

async function createMetaAppSecretProof(
  appSecret: string,
  accessToken: string,
): Promise<string> {
  try {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(appSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await globalThis.crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(accessToken),
    );
    return [...new Uint8Array(signature)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    throw new Error("Meta appsecret_proof 生成失败，网络保持关闭。");
  }
}

function readMetaInsightMetrics(item: Record<string, unknown>): {
  contractValid: boolean;
  payload: Record<string, unknown>;
} {
  const spend = readOptionalNonNegativeNumber(item.spend);
  const cpc = readOptionalNonNegativeNumber(item.cpc);
  const actions = readMetaActionMap(item.actions);
  const costs = readMetaActionMap(item.cost_per_action_type);
  if (!spend.valid || !cpc.valid || !actions.valid || !costs.valid) {
    return { contractValid: false, payload: {} };
  }
  const conversion = selectMetaAction(actions.values, META_CONVERSION_ACTION_PRIORITY);
  const cart = selectMetaAction(actions.values, META_CART_ACTION_PRIORITY);
  const selectedCpa = conversion.actionType
    ? costs.values.get(conversion.actionType)
    : undefined;
  if (conversion.value > 0 && selectedCpa === undefined) {
    return { contractValid: false, payload: {} };
  }
  return {
    contractValid: true,
    payload: {
      spend: spend.value ?? 0,
      cpc: cpc.value ?? 0,
      conversions: conversion.value,
      carts: cart.value,
      cost_per_conversion: selectedCpa ?? 0,
      metaConversionActionType: conversion.actionType,
      metaCartActionType: cart.actionType,
    },
  };
}

function readOptionalNonNegativeNumber(value: unknown): {
  valid: boolean;
  value: number | null;
} {
  if (value === undefined || value === null || value === "") {
    return { valid: true, value: null };
  }
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0
    ? { valid: true, value: parsed }
    : { valid: false, value: null };
}

function readMetaActionMap(value: unknown): {
  valid: boolean;
  values: Map<string, number>;
} {
  const values = new Map<string, number>();
  if (value === undefined || value === null) return { valid: true, values };
  if (!Array.isArray(value)) return { valid: false, values };
  for (const item of value) {
    if (!isRecord(item) || typeof item.action_type !== "string") {
      return { valid: false, values };
    }
    const parsed = readOptionalNonNegativeNumber(item.value);
    if (!parsed.valid || parsed.value === null || values.has(item.action_type)) {
      return { valid: false, values };
    }
    values.set(item.action_type, parsed.value);
  }
  return { valid: true, values };
}

function selectMetaAction(
  values: ReadonlyMap<string, number>,
  priority: readonly string[],
): { actionType: string | null; value: number } {
  for (const actionType of priority) {
    const value = values.get(actionType);
    if (value !== undefined) return { actionType, value };
  }
  return { actionType: null, value: 0 };
}

function statusTestScopeContextIssue(
  scope: MetaMarketingApiStatusTestScope | null,
  context: ProviderContext,
  settings: ReturnType<typeof MetaMarketingApiConnectionSettingsSchema.parse>,
): string | null {
  if (!scope) return "Meta 状态实测总开关未开启。";
  const expiresAt = Date.parse(scope.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return "Meta 状态实测 Scope 已过期。";
  }
  if (scope.localAccountId !== context.accountId) {
    return "Meta 状态实测本地账户不匹配。";
  }
  if (normalizeAdAccountId(scope.adAccountId) !== normalizeAdAccountId(settings.adAccountId)) {
    return "Meta 状态实测广告账户不匹配。";
  }
  return null;
}

function statusMutationPolicyIssue(
  scope: MetaMarketingApiStatusTestScope | null,
  context: ProviderContext,
  settings: ReturnType<typeof MetaMarketingApiConnectionSettingsSchema.parse>,
  mutations: StatusMutation[],
): string | null {
  if (mutations.length !== 1) return "Meta 手动启停每次只允许一个对象。";
  const mutation = mutations[0];
  if (!mutation) return "Meta 手动启停对象缺失。";
  if (scope) {
    const contextIssue = statusTestScopeContextIssue(scope, context, settings);
    if (contextIssue) return contextIssue;
    if (mutation.entityType !== scope.entityType || mutation.externalId !== scope.externalId) {
      return "Meta 状态实测对象不在固定 Scope 内。";
    }
    return null;
  }
  if (!isStatusLiveMode(settings.liveMode)) {
    return "Meta 账户未开启状态写入模式。";
  }
  if (
    mutation.entityType === "material"
    || !settings.allowedStatusEntityTypes?.includes(mutation.entityType)
  ) {
    return "Meta 对象层级不在账户手动启停允许范围内。";
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Meta Graph 响应结构无效。");
  return value;
}

function isStatusLiveMode(
  liveMode: MetaMarketingApiLiveMode | undefined,
): liveMode is "manual-status" | "automation-status" {
  return liveMode === "manual-status" || liveMode === "automation-status";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
