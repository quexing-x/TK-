import {
  CookieConnectionSettingsSchema,
  CookieCredentialInputSchema,
  buildDraftPayloads,
  buildProfileDraftPayloads,
  buildPublishInput,
  TikTokCreationPublishSource,
  splitVideoCodes,
  deriveTikTokCreationRequest,
  normalizeProviderEntity,
  type CapturedCookieRequest,
  type ProviderEntity,
  type SyncEntityType,
} from "@tk-auto/core";
import type {
  AdsProvider,
  ProviderCapability,
  ProviderContext,
  ProviderHealth,
  ProviderSyncOutput,
  StatusMutation,
  StatusMutationResult,
  CreationMutation,
  CreationMutationResult,
  NewCreationMutation,
  TemplateCopyMutation,
  DeleteAdGroupMutation,
  DeleteAdGroupMutationResult,
} from "./types.js";
import {
  ConfirmedCreationFailureError,
  RetryableCreationError,
  RetryableStatusMutationError,
  UnknownCreationStateError,
  UnknownStatusMutationStateError,
} from "./types.js";
import { buildSyncDataQuality } from "./sync-quality.js";
import {
  isMultipartBody,
  parseMultipartFields,
  rewriteMultipartFields,
} from "./multipart.js";

const capabilities = new Set<ProviderCapability>([
  "read-campaigns",
  "read-ad-groups",
  "read-ads",
  "read-reports",
  "change-status",
  "create-campaigns",
  "copy-ads",
  "appeal-ads",
  "delete-ad-groups",
]);

const COOKIE_SYNC_CONTRACT_VERSION = "cookie-statistics-v5-2026-07";

type ParsedCookieCredential = ReturnType<
  typeof CookieCredentialInputSchema.parse
>;

interface CreationBatchReservations {
  campaignIds: Map<string, string>;
  adGroupNames: Map<string, Set<string>>;
  uncertainCampaigns: Set<string>;
}

export class CookieAdsProvider implements AdsProvider {
  readonly kind = "cookie" as const;
  readonly displayName = "Cookie 会话";
  readonly capabilityVersion = "cookie-capabilities-v3-2026-07";
  readonly capabilities = capabilities;
  private readonly creationBatchReservations = new Map<string, CreationBatchReservations>();
  private readonly creationBatchLocks = new Map<string, Promise<void>>();

  resolveCapabilities(context: ProviderContext): ReadonlySet<ProviderCapability> {
    const credential = CookieCredentialInputSchema.parse(context.credential);
    const templates = credential.requestTemplates ?? [];
    const hasListSession = templates.some(
      (item) => item.target === "ad-group" && !item.derived,
    );
    const hasCompleteStatusTemplates = (
      ["campaign-status", "ad-group-status", "ad-status"] as const
    ).every((target) =>
      (["enable", "disable"] as const).every((action) =>
        templates.some((item) => item.target === target && item.action === action),
      ),
    );
    const hasAdGroupDeleteSession = templates.some(
      (item) => item.target === "ad-group-status" && item.action === "disable",
    );
    return new Set<ProviderCapability>([
      ...(hasListSession
        ? [
            "read-campaigns",
            "read-ad-groups",
            "read-ads",
            "read-reports",
            "create-campaigns",
            "copy-ads",
          ] as const
        : []),
      ...(hasCompleteStatusTemplates ? ["change-status"] as const : []),
      // The appeal endpoint and body shape are shared. Authorization and
      // advertiser-specific query parameters still come from this account's
      // imported list session, so no per-account appeal cURL is required.
      ...(hasListSession ? ["appeal-ads"] as const : []),
      ...(hasAdGroupDeleteSession ? ["delete-ad-groups"] as const : []),
    ]);
  }

  async checkHealth(context: ProviderContext): Promise<ProviderHealth> {
    const settings = CookieConnectionSettingsSchema.parse(context.settings);
    const credential = CookieCredentialInputSchema.parse(context.credential);
    const readTemplates = credential.requestTemplates?.filter((item) =>
      ["health", "campaign", "ad-group", "ad"].includes(item.target),
    );
    const captured =
      readTemplates?.find((item) => !item.derived) ?? readTemplates?.[0];
    const request = captured ?? legacyRequest(settings.healthUrl);
    if (!request) {
      throw new Error("尚未配置连接检测请求，请使用 cURL 快速导入或高级设置。");
    }
    await requestCookieJson(request, credential);
    return {
      ok: true,
      status: "ready",
      message: `Cookie 会话验证成功（${request.method} 只读请求）。`,
    };
  }

  async appeal(context: ProviderContext, mutations: import("./types.js").AppealMutation[]) {
    const settings = CookieConnectionSettingsSchema.parse(context.settings);
    const credential = CookieCredentialInputSchema.parse(context.credential);
    const sessionRequest = credential.requestTemplates?.find(
      (item) => item.target === "ad-group" && !item.derived,
    );
    if (!sessionRequest) {
      throw new RetryableCreationError("尚未导入广告组列表 cURL，无法建立当前账户的申诉会话。");
    }
    return Promise.all(mutations.map(async (mutation) => {
      let request: CapturedCookieRequest;
      try {
        request = buildReusableAppealRequest(
          sessionRequest,
          settings.advertiserId,
          mutation,
        );
      } catch (cause) {
        return {
          ...mutation,
          ok: false,
          failureKind: "retryable" as const,
          message: cause instanceof Error ? cause.message : "申诉请求构造失败。",
        };
      }
      try {
        const payload = await requestCookieJson(request, credential);
        const data = isRecord(payload.data) ? payload.data : {};
        const ok = payload.code === 0 && data.appeal_success === true;
        return {
          ...mutation,
          ok,
          ...(!ok && { failureKind: "retryable" as const }),
          message: ok ? "申诉提交成功" : "申诉提交未获成功确认",
        };
      } catch (cause) {
        return {
          ...mutation,
          ok: false,
          failureKind: cause instanceof RetryableCreationError
            ? "retryable" as const
            : "unknown" as const,
          message: cause instanceof Error ? cause.message : "申诉结果无法确认。",
        };
      }
    }));
  }

  async deleteAdGroups(
    context: ProviderContext,
    mutations: DeleteAdGroupMutation[],
  ): Promise<DeleteAdGroupMutationResult[]> {
    let credential: ParsedCookieCredential;
    try {
      CookieConnectionSettingsSchema.parse(context.settings);
      credential = CookieCredentialInputSchema.parse(context.credential);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Cookie 删除请求参数无效。";
      return mutations.map((mutation) => ({ ...mutation, ok: false, failureKind: "retryable", message }));
    }
    const template = credential.requestTemplates?.find(
      (item) => item.target === "ad-group-status" && item.action === "disable",
    );
    if (!template) {
      return mutations.map((mutation) => ({
        ...mutation,
        ok: false,
        failureKind: "retryable",
        message: "缺少广告组关闭 cURL，无法安全派生删除请求。",
      }));
    }
    const results: DeleteAdGroupMutationResult[] = [];
    for (const mutation of mutations) {
      let request: CapturedCookieRequest;
      try {
        request = materializeDeletionRequest(template, mutation.externalId);
      } catch (cause) {
        results.push({
          ...mutation,
          ok: false,
          failureKind: "retryable",
          message: cause instanceof Error ? cause.message : "删除请求构造失败。",
        });
        continue;
      }
      try {
        const payload = await requestCookieJson(request, credential);
        if (payload.code !== 0) {
          results.push({
            ...mutation,
            ok: false,
            failureKind: "unknown",
            message: "删除请求已发送，但 TikTok 响应缺少明确成功代码。",
          });
          continue;
        }
        results.push({ ...mutation, ok: true, message: "TikTok 已明确确认删除广告组。" });
      } catch (cause) {
        results.push({
          ...mutation,
          ok: false,
          failureKind: cause instanceof RetryableCreationError ? "retryable" : "unknown",
          message: cause instanceof Error ? cause.message : "删除结果无法确认。",
        });
      }
    }
    return results;
  }

  async syncReadOnly(context: ProviderContext): Promise<ProviderSyncOutput> {
    const settings = CookieConnectionSettingsSchema.parse(context.settings);
    const credential = CookieCredentialInputSchema.parse(context.credential);
    const startedAt = new Date().toISOString();
    const entities: ProviderEntity[] = [];
    const warnings: string[] = [];
    const partialFailures: string[] = [];
    const emptyResponses = new Set<SyncEntityType>();
    let paginationComplete = true;
    let contractValid = true;
    let coverageKnown = true;
    const legacyEndpoints: Record<SyncEntityType, string> = {
      campaign: settings.campaignsUrl,
      "ad-group": settings.adGroupsUrl,
      ad: settings.adsUrl,
    };
    const importedAdGroupRead = credential.requestTemplates?.find(
      (item) => item.target === "ad-group" && !item.derived,
    );

    for (const entityType of ["campaign", "ad-group", "ad"] as const) {
      const captured = credential.requestTemplates?.find(
        (item) => item.target === entityType,
      );
      const request =
        captured ??
        (entityType === "campaign" && importedAdGroupRead
          ? siblingListRequest(importedAdGroupRead, "campaign")
          : entityType === "ad"
            ? deriveFinalAdReadRequest(importedAdGroupRead)
            : undefined) ??
        legacyRequest(legacyEndpoints[entityType]);
      if (!request) {
        warnings.push(`${entityType} 尚未导入只读请求。`);
        partialFailures.push(`${entityType}:request-missing`);
        continue;
      }
      // A captured list cURL may have been copied while the TikTok UI was set
      // to 3/7/30 days.  When a report window is explicitly present, rewrite
      // it on every poll in the account's timezone instead of trusting the
      // captured range. Some valid TikTok list requests do not expose a date
      // parameter at all; those must still be replayed with the platform's
      // request defaults rather than blocking the complete polling cycle.
      const entityRequest = entityType === "campaign"
        ? campaignMetricsListRequest(request)
        : request;
      const windowedRequest = withTodayMetricWindow(
        entityRequest,
        context.timezone ?? "UTC",
        new Date(),
      );
      if (!hasExplicitMetricWindow(windowedRequest)) {
        coverageKnown = false;
        warnings.push(`${entityType} 请求未提供日期范围，已沿用 TikTok 默认数据范围。`);
      }
      let pages: Record<string, unknown>[];
      let entityPaginationComplete = false;
      try {
        const result = await requestAllCookieListPages(windowedRequest, credential);
        pages = result.pages;
        entityPaginationComplete = result.complete;
      } catch (cause) {
        if (!entityRequest.derived) throw cause;
        warnings.push(
          `${entityType} 自动补全请求失败；如需该层级数据，请补充一条真实列表 cURL。`,
        );
        partialFailures.push(`${entityType}:derived-request-failed`);
        continue;
      }
      contractValid &&= pages.every((payload) => hasRecognizedEntityList(payload, entityType));
      paginationComplete &&= entityPaginationComplete;
      const extracted = pages.flatMap((payload) => extractEntities(payload, entityType));
      entities.push(...extracted);
      if (entityType === "ad-group") {
        entities.push(...pages.flatMap((payload) => extractEntities(payload, "campaign")));
      }
      if (extracted.length === 0) {
        emptyResponses.add(entityType);
      }
    }

    const uniqueEntities = dedupeEntities(entities);
    const counts = countEntities(uniqueEntities);
    for (const entityType of emptyResponses) {
      if (counts[entityType] === 0) {
        warnings.push(`${entityType} 响应成功，但暂未识别到列表数据。`);
      }
    }
    const timezone = context.timezone ?? "UTC";
    const now = new Date();
    const endDate = formatDateInTimezone(now, timezone);
    const startDate = formatDateInTimezone(now, timezone);
    return {
      entities: uniqueEntities,
      result: {
        startedAt,
        finishedAt: new Date().toISOString(),
        counts,
        warnings,
        quality: buildSyncDataQuality({
          entities: uniqueEntities,
          paginationComplete,
          contractValid,
          providerContractVersion: COOKIE_SYNC_CONTRACT_VERSION,
          coverage: {
            startDate: coverageKnown ? startDate : "",
            endDate: coverageKnown ? endDate : "",
            timezone,
          },
          partialFailures,
        }),
      },
    };
  }

  async changeStatus(
    context: ProviderContext,
    mutations: StatusMutation[],
  ): Promise<StatusMutationResult[]> {
    let credential: ParsedCookieCredential;
    try {
      CookieConnectionSettingsSchema.parse(context.settings);
      credential = CookieCredentialInputSchema.parse(context.credential);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Cookie 状态请求参数无效。";
      return mutations.map((mutation) => ({
        ...mutation,
        ok: false,
        failureKind: "retryable",
        message,
      }));
    }
    const results: StatusMutationResult[] = [];

    for (const mutation of mutations) {
      const target = `${mutation.entityType}-status` as const;
      const template = credential.requestTemplates?.find(
        (item) => item.target === target && item.action === mutation.action,
      );
      if (!template) {
        results.push({
          ...mutation,
          ok: false,
          failureKind: "retryable",
          message: `缺少 ${mutation.entityType} ${mutation.action} 的状态 cURL 模板。`,
        });
        continue;
      }
      let request: CapturedCookieRequest;
      try {
        request = materializeStatusRequest(template, mutation);
      } catch (cause) {
        results.push({
          ...mutation,
          ok: false,
          failureKind: "retryable",
          message: cause instanceof Error ? cause.message : "状态请求构造失败。",
        });
        continue;
      }
      try {
        await requestCookieJson(request, credential);
        results.push({
          ...mutation,
          ok: true,
          message: `Cookie 状态请求执行成功：${mutation.action}${template.derived ? "（自动扩展模板）" : ""}。`,
        });
      } catch (cause) {
        const detail =
          cause instanceof Error ? cause.message : "Cookie 状态请求失败。";
        const classified = cause instanceof RetryableCreationError
          ? new RetryableStatusMutationError(detail)
          : new UnknownStatusMutationStateError(detail);
        results.push({
          ...mutation,
          ok: false,
          failureKind: classified instanceof UnknownStatusMutationStateError
            ? "unknown"
            : "retryable",
          message: template.derived
            ? `${classified.message} 自动扩展模板被拒绝；请只补充此层级的一条真实开关 cURL。`
            : classified.message,
        });
      }
    }
    return results;
  }

  async createFromPreset(
    context: ProviderContext,
    mutations: CreationMutation[],
  ): Promise<CreationMutationResult[]> {
    let credential: ParsedCookieCredential;
    try {
      CookieConnectionSettingsSchema.parse(context.settings);
      credential = CookieCredentialInputSchema.parse(context.credential);
    } catch (cause) {
      throw new RetryableCreationError(
        cause instanceof Error ? cause.message : "创建接入配置无效。",
      );
    }
    const sessionRequest = credential.requestTemplates?.find(
      (item) => item.target === "ad-group" && !item.derived,
    );
    if (!sessionRequest) {
      return mutations.map((mutation) => ({
        ...mutation,
        ok: false,
        failureKind: "retryable" as const,
        message: "缺少第 1 步 /adgroup/list/ cURL，无法建立创建会话。",
      }));
    }
    const campaignObjectRequest = campaignObjectListRequest(sessionRequest);
    const results: CreationMutationResult[] = [];
    const batchId = mutations[0]?.batchId;
    const reservationKey = batchId ? `${context.accountId}:${batchId}` : null;
    const releaseBatchLock = reservationKey ? await this.acquireBatchLock(reservationKey) : null;
    try {
      const reservations = reservationKey
        ? this.creationBatchReservations.get(reservationKey) ?? this.createBatchReservations(reservationKey)
        : { campaignIds: new Map<string, string>(), adGroupNames: new Map<string, Set<string>>(), uncertainCampaigns: new Set<string>() };
      for (const mutation of mutations) {
        const campaignKey = mutation.row.campaignName.trim();
        if (mutation.batchCampaignId) reservations.campaignIds.set(campaignKey, mutation.batchCampaignId);
        if (mutation.batchAdGroupNames?.length) {
          const names = reservations.adGroupNames.get(campaignKey) ?? new Set<string>();
          for (const name of mutation.batchAdGroupNames) names.add(name.trim());
          reservations.adGroupNames.set(campaignKey, names);
        }
        if (mutation.templateMode === "none" && reservations.uncertainCampaigns.has(campaignKey)) {
          results.push({
            ...mutation,
            ok: false,
            failureKind: "retryable",
            message: "同批次前一条同系列任务结果未知，已停止后续创建以避免重复系列或广告组。",
          });
          continue;
        }
        try {
          const result = await createCookieDraftChain(
            sessionRequest,
            campaignObjectRequest,
            credential,
            mutation,
            context.timezone ?? "UTC",
            {
              // copy 模式也需要该预留：带 batchCampaignId 时复用现有系列（同账户同系列），
              // 不带时 campaignId 为空、按原逻辑新建系列（跨账户复制不受影响）。
              ...(reservations.campaignIds.get(campaignKey)
                ? { campaignId: reservations.campaignIds.get(campaignKey)! }
                : {}),
              adGroupNames: reservations.adGroupNames.get(campaignKey) ?? new Set<string>(),
            },
          );
          results.push(result);
          if (mutation.templateMode === "none" && result.ok && result.campaignId) {
            reservations.campaignIds.set(campaignKey, result.campaignId);
            const names = reservations.adGroupNames.get(campaignKey) ?? new Set<string>();
            names.add(result.row.adGroupName.trim());
            reservations.adGroupNames.set(campaignKey, names);
          }
        } catch (cause) {
          if (mutation.templateMode === "none" && cause instanceof UnknownCreationStateError) {
            reservations.uncertainCampaigns.add(campaignKey);
          }
          results.push({
            ...mutation,
            ok: false,
            failureKind: cause instanceof UnknownCreationStateError
              ? "unknown"
              : "retryable",
            retrySafe: cause instanceof ConfirmedCreationFailureError
              ? cause.retrySafe
              : !(cause instanceof UnknownCreationStateError),
            message: cause instanceof Error ? cause.message : "TikTok 创建请求失败。",
          });
        }
      }
      return results;
    } finally {
      releaseBatchLock?.();
    }
  }

  private createBatchReservations(key: string): CreationBatchReservations {
    const reservations: CreationBatchReservations = {
      campaignIds: new Map(),
      adGroupNames: new Map(),
      uncertainCampaigns: new Set(),
    };
    this.creationBatchReservations.set(key, reservations);
    return reservations;
  }

  private async acquireBatchLock(key: string): Promise<() => void> {
    const previous = this.creationBatchLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.creationBatchLocks.set(key, tail);
    await previous;
    return () => {
      release();
      if (this.creationBatchLocks.get(key) === tail) this.creationBatchLocks.delete(key);
    };
  }

  async create(
    context: ProviderContext,
    mutations: NewCreationMutation[],
  ): Promise<CreationMutationResult[]> {
    return this.createFromPreset(
      context,
      mutations.map((mutation) => ({ ...mutation, templateMode: "none" })),
    );
  }

  async copy(
    context: ProviderContext,
    mutations: TemplateCopyMutation[],
  ): Promise<CreationMutationResult[]> {
    return this.createFromPreset(
      context,
      mutations.map((mutation) => ({ ...mutation, templateMode: "copy" })),
    );
  }

  // 广告组级复制进现有系列（同账户同系列）：直接调 TikTok ad_snap/copy，
  // 用 copy_ad_id_to_existing_campaign 把源广告组连同创意克隆进指定现有系列。
  async copyAdGroupToExistingCampaign(
    context: ProviderContext,
    input: {
      sourceAdGroupId: string;
      existingCampaignId: string;
      names: string[];
      initialStatus: "enabled" | "disabled";
      scheduledStartAt?: string | null;
      dailyBudget?: number;
      bid?: number | null;
      // 源系列为系列预算(CBO)：跳过组预算覆盖，新组继承系列预算。
      sourceCampaignBudgetOptimized?: boolean;
      onBeforeDispatch?: () => void;
    },
  ): Promise<{ ok: boolean; message: string; adGroupSnapIds?: string[]; adGroupIds?: string[]; failureKind?: "failed" | "unknown"; retrySafe?: boolean }> {
    const credential = CookieCredentialInputSchema.parse(context.credential);
    const sessionRequest = credential.requestTemplates?.find(
      (item) => item.target === "ad-group" && !item.derived,
    );
    if (!sessionRequest) {
      return { ok: false, message: "缺少第 1 步 /adgroup/list/ cURL，无法建立创建会话。" };
    }
    const profile = credential.creationProfile;
    const riskInfo = profile && isRecord(profile.publishPayload) && isRecord(profile.publishPayload.risk_info)
      ? profile.publishPayload.risk_info
      : {};
    const dispatchState: CreationDispatchState = {
      mutationDispatched: false,
      acceptedMutationCount: 0,
      ...(input.onBeforeDispatch ? { onBeforeMutationDispatch: input.onBeforeDispatch } : {}),
    };
    const scheduledStart = input.scheduledStartAt
      ? parseNativeScheduleStart(input.scheduledStartAt)
      : null;
    let copyAccepted = false;
    try {
      // 1) ad_snap/copy：把源广告组连同创意克隆进现有系列，返回草稿 snap/sketch。
      const copied = await requestCreationStep(
        "ad_snap/copy",
        () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/ad_snap/copy/", {
          with_sketch: true,
          resp_with_detail: true,
          with_creative: true,
          is_batch_copy: true,
          ad_params: [{ ad_id: input.sourceAdGroupId, name_list: input.names }],
          copy_ad_id_to_existing_campaign: true,
          is_manual_upgrade_to_splusplus: false,
          converter_mode: 0,
          existing_campaign_id: input.existingCampaignId,
          risk_info: riskInfo,
        }),
        credential,
        { semantics: "mutation", dispatchState },
      );
      // A structured code:0 response proves TikTok accepted the copy step. Any
      // later failure leaves remote draft state behind, so rerunning the whole
      // expansion could create duplicates even when the later step was a
      // structured rejection or a local payload error.
      copyAccepted = true;
      const data = isRecord(copied.data) ? copied.data : undefined;
      const allCopy = data && isRecord(data.all_copy_result) ? data.all_copy_result : undefined;
      let list = allCopy && Array.isArray(allCopy.ad_and_creative_copy_result_list)
        ? allCopy.ad_and_creative_copy_result_list.filter(isRecord)
        : [];
      const simpleAdSnapId = data ? nonEmptyId(data.ad_snap_id) : undefined;
      const simpleAdSketchId = data ? nonEmptyId(data.ad_sketch_id) : undefined;
      const simpleCopyResult = list.length === 0 && Boolean(simpleAdSnapId && simpleAdSketchId);
      if (simpleCopyResult) {
        list = [{
          new_ad_snap_info_item: { ad_snap_id: simpleAdSnapId },
          new_ad_sketch_id: simpleAdSketchId,
          new_creative_snap_info_item_list: [],
          new_creative_sketch_ids: [],
        }];
      }
      if (list.length === 0) {
        throw new UnknownCreationStateError("ad_snap/copy 未返回可识别的草稿标识。");
      }
      if (list.length !== input.names.length) {
        throw new UnknownCreationStateError(
          `ad_snap/copy 仅返回 ${list.length}/${input.names.length} 个广告组草稿，已停止发布。`,
        );
      }
      // 2) 用复制响应拼 publishItems（结构不同于 campaign_snap/copy）。
      let publishItems: DraftPublishItem[] = list.map((item) => {
        const adSnap = isRecord(item.new_ad_snap_info_item) ? item.new_ad_snap_info_item : {};
        const adSnapId = nonEmptyId(adSnap.ad_snap_id);
        const adSketchId = nonEmptyId(item.new_ad_sketch_id);
        const creatives = Array.isArray(item.new_creative_snap_info_item_list)
          ? item.new_creative_snap_info_item_list.filter(isRecord)
          : [];
        const creativeSketchIds = Array.isArray(item.new_creative_sketch_ids)
          ? item.new_creative_sketch_ids
          : [];
        if (!adSnapId || !adSketchId || creatives.length !== creativeSketchIds.length) {
          throw new UnknownCreationStateError("复制草稿缺少完整的 snap/sketch 标识。");
        }
        const creativeSnapInfoList = creatives.map((creative, creativeIndex) => ({
          creative_id: "",
          creative_snap_id: nonEmptyId(creative.creative_snap_id) ?? "",
          creative_sketch_id: nonEmptyId(creativeSketchIds[creativeIndex]) ?? "",
          need_publish: true as const,
        }));
        if (creativeSnapInfoList.some((creative) => !creative.creative_snap_id || !creative.creative_sketch_id)) {
          throw new UnknownCreationStateError("复制草稿包含空的创意 snap/sketch 标识，已停止发布。");
        }
        return {
          ad_id: "",
          ad_snap_id: adSnapId,
          ad_sketch_id: adSketchId,
          need_publish: true as const,
          creative_snap_info_list: creativeSnapInfoList,
        };
      });
      await applyCopiedAdGroupOverrides({
          sessionRequest,
          credential,
          dispatchState,
          campaignId: input.existingCampaignId,
          publishItems,
          scheduledStart,
          timezone: context.timezone ?? "UTC",
          riskInfo,
          ...(input.dailyBudget !== undefined ? { dailyBudget: input.dailyBudget } : {}),
          ...(input.bid !== undefined ? { bid: input.bid } : {}),
          ...(input.sourceCampaignBudgetOptimized ? { skipBudgetOverride: true } : {}),
        });
      if (simpleCopyResult) {
        publishItems = await materializeSimpleCopyCreativeDrafts({
          sessionRequest,
          credential,
          dispatchState,
          publishItems,
          riskInfo,
        });
      }
      if (publishItems.some((item) => item.creative_snap_info_list.length === 0)) {
        throw new UnknownCreationStateError(
          `ad_snap/copy 仅返回广告组草稿，未返回可发布的创意草稿标识；${scheduledStart ? "排期" : "广告组设置"}已保存，但已停止发布且禁止自动重试。`,
        );
      }
      // 2.5) 生成 CTA（程序化创意必需，否则发布报缺少行动引导/URL）。
      const checkInfo = publishItems.map((item) => ({
        ad_id: "",
        ad_snap_id: item.ad_snap_id,
        creative_snap_ids: item.creative_snap_info_list.map((creative) => creative.creative_snap_id),
      }));
      await requestCreationStep(
        "snap/batch_create_cta_id",
        () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/snap/batch_create_cta_id/", {
          campaign_id: input.existingCampaignId,
          campaign_snap_id: "",
          ad_and_creative_snap_info_list: checkInfo,
        }),
        credential,
        { semantics: "mutation", dispatchState },
      );
      // 3) 发布进现有系列（campaign_snap/sketch 置空，用 campaign_id）。
      const publishPayload = profile
        ? materializePublishProfile(profile.publishPayload, {
            campaignId: input.existingCampaignId,
            campaignSnapId: "",
            campaignSketchId: "",
            publishItems,
            initialStatus: scheduledStart ? "enabled" : input.initialStatus,
          })
        : buildPublishInput({
            campaignSnapId: input.existingCampaignId,
            campaignSketchId: input.existingCampaignId,
            adAndCreativeSnapInfoList: publishItems,
          }, scheduledStart ? "enabled" : input.initialStatus);
      publishPayload.campaign_id = input.existingCampaignId;
      publishPayload.campaign_snap_id = "";
      publishPayload.campaign_sketch_id = "";
      if (scheduledStart && scheduledStart.getTime() <= Date.now()) {
        throw new UnknownCreationStateError("TikTok 原生排期在发布前已到期；草稿已创建，已停止发布并禁止自动重试。");
      }
      const published = await requestCreationStep(
        "create_by_snap",
        () => creationRequest(sessionRequest, "async_creation/create_by_snap", publishPayload),
        credential,
        { semantics: "mutation", dispatchState },
      );
      const completed = await awaitCreationResult(sessionRequest, credential, published, input.existingCampaignId);
      const completedCounts = completedCreationCounts(completed);
      const officialAdGroupIds = completedAdGroupIds(completed);
      const expectedCreativeCount = publishItems.reduce(
        (total, item) => total + item.creative_snap_info_list.length,
        0,
      );
      const expectedCreativeCountsByAdGroup = publishItems
        .map((item) => item.creative_snap_info_list.length)
        .sort((left, right) => left - right);
      const completedCreativeCountsByAdGroup = [...completedCounts.creativeCountsByAdGroup]
        .sort((left, right) => left - right);
      if (
        completedCounts.adGroupCount !== publishItems.length
        || completedCounts.creativeCount !== expectedCreativeCount
        || completedCreativeCountsByAdGroup.length !== expectedCreativeCountsByAdGroup.length
        || officialAdGroupIds.length !== publishItems.length
        || completedCreativeCountsByAdGroup.some(
          (count, index) => count !== expectedCreativeCountsByAdGroup[index],
        )
      ) {
        throw new UnknownCreationStateError(
          `TikTok 创建终态不完整：广告组 ${completedCounts.adGroupCount}/${publishItems.length}，广告 ${completedCounts.creativeCount}/${expectedCreativeCount}，每组广告 ${completedCreativeCountsByAdGroup.join(",") || "无"}（预期 ${expectedCreativeCountsByAdGroup.join(",") || "无"}）；禁止自动重试。`,
        );
      }
      return {
        ok: true,
        message: `同系列复制已发布 ${publishItems.length} 个广告组`,
        adGroupSnapIds: publishItems.map((item) => item.ad_snap_id),
        adGroupIds: officialAdGroupIds,
      };
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : "同系列复制失败",
        failureKind: cause instanceof ConfirmedCreationFailureError
          ? "failed"
          : cause instanceof UnknownCreationStateError || copyAccepted
            ? "unknown"
            : "failed",
        retrySafe: cause instanceof ConfirmedCreationFailureError
          ? cause.retrySafe && dispatchState.acceptedMutationCount === 0
          : !copyAccepted,
      };
    }
  }
}

async function materializeSimpleCopyCreativeDrafts(input: {
  sessionRequest: CapturedCookieRequest;
  credential: ParsedCookieCredential;
  dispatchState: CreationDispatchState;
  publishItems: DraftPublishItem[];
  riskInfo: Record<string, unknown>;
}): Promise<DraftPublishItem[]> {
  const rows = await listAllCreativeSketchRows(input);

  const result: DraftPublishItem[] = [];
  for (const publishItem of input.publishItems) {
    const creativeSketchIds = [...new Set(rows
      .filter((row) => nonEmptyId(row.ad_sketch_id) === publishItem.ad_sketch_id)
      .map((row) => nonEmptyId(row.creative_sketch_id))
      .filter((id): id is string => Boolean(id)))];
    if (creativeSketchIds.length === 0) {
      throw new UnknownCreationStateError(
        `TikTok 已复制广告组草稿 ${publishItem.ad_sketch_id}，但未能定位其创意草稿；禁止自动重试。`,
      );
    }

    const detail = await requestCreationStep(
      "creative_sketch/detail",
      () => creationPathGetRequest(
        input.sessionRequest,
        "/mi/api/v4/i18n/creation/creative_sketch/detail/",
        { creative_sketch_ids: creativeSketchIds.join(",") },
      ),
      input.credential,
      { semantics: "preflight-read", dispatchState: input.dispatchState },
    );
    const detailData = isRecord(detail.data) ? detail.data : undefined;
    const detailMap = detailData && isRecord(detailData.creative_sketch_info_map)
      ? detailData.creative_sketch_info_map
      : undefined;
    const forms = creativeSketchIds.map((creativeSketchId) => {
      const info = detailMap && isRecord(detailMap[creativeSketchId])
        ? detailMap[creativeSketchId]
        : undefined;
      const rawForm = info && isRecord(info.asset_group_sketch_form_data)
        ? info.asset_group_sketch_form_data
        : undefined;
      if (!rawForm) {
        throw new UnknownCreationStateError(
          `TikTok 创意草稿详情缺少 ${creativeSketchId}，已停止发布。`,
        );
      }
      return {
        ...cloneRecord(rawForm),
        creative_snap_id: "",
        creative_sketch_id: creativeSketchId,
      };
    });

    const saved = await requestCreationStep(
      "creative_snap/save",
      () => creationRequest(input.sessionRequest, "creative_snap/save", {
        asset_group_sketch_form_data_list: forms,
        spc_upgrade_mode: 1,
        with_sketch: true,
        ad_snap_id: publishItem.ad_snap_id,
        ad_sketch_id: publishItem.ad_sketch_id,
        risk_info: input.riskInfo,
      }),
      input.credential,
      { semantics: "mutation", dispatchState: input.dispatchState },
    );
    const savedData = isRecord(saved.data) ? saved.data : undefined;
    const creativeSnapIds = savedData && Array.isArray(savedData.creative_snap_ids)
      ? savedData.creative_snap_ids.map(nonEmptyId).filter((id): id is string => Boolean(id))
      : [];
    const savedSketchIds = savedData && Array.isArray(savedData.creative_sketch_ids)
      ? savedData.creative_sketch_ids.map(nonEmptyId).filter((id): id is string => Boolean(id))
      : [];
    if (
      creativeSnapIds.length !== creativeSketchIds.length
      || savedSketchIds.length !== creativeSketchIds.length
    ) {
      throw new UnknownCreationStateError(
        "creative_snap/save 未返回完整的 creative_snap_ids / creative_sketch_ids，已停止发布。",
      );
    }
    result.push({
      ...publishItem,
      creative_snap_info_list: creativeSnapIds.map((creativeSnapId, index) => ({
        creative_id: "",
        creative_snap_id: creativeSnapId,
        creative_sketch_id: savedSketchIds[index]!,
        need_publish: true as const,
      })),
    });
  }
  return result;
}

async function listAllCreativeSketchRows(input: {
  sessionRequest: CapturedCookieRequest;
  credential: ParsedCookieCredential;
  dispatchState: CreationDispatchState;
}): Promise<Record<string, unknown>[]> {
  const limit = 100;
  const maxPages = 100;
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const sketchList = await requestCreationStep(
      "statistics/sketch/creative/list",
      () => creationPathRequest(
        input.sessionRequest,
        "/api/v4/i18n/statistics/sketch/creative/list/",
        {
          query_list: [],
          page,
          limit,
          sort_order: 1,
          sort_stat: "modify_time",
          filters: [],
        },
      ),
      input.credential,
      { semantics: "preflight-read", dispatchState: input.dispatchState },
    );
    const listData = isRecord(sketchList.data) ? sketchList.data : undefined;
    const pageRows = listData && Array.isArray(listData.table)
      ? listData.table.filter(isRecord)
      : [];
    rows.push(...pageRows);
    if (!hasNextCreativeSketchPage(listData, page, pageRows.length, limit, rows.length)) {
      return rows;
    }
  }
  throw new UnknownCreationStateError(
    `TikTok 创意草稿列表超过 ${maxPages} 页，无法确认已获取全部复制结果；已停止发布。`,
  );
}

function hasNextCreativeSketchPage(
  data: Record<string, unknown> | undefined,
  page: number,
  rowCount: number,
  limit: number,
  accumulatedRowCount: number,
): boolean {
  if (!data) {
    throw new UnknownCreationStateError("创意草稿列表缺少分页数据，无法确认结果完整；已停止发布。");
  }
  const pagination = isRecord(data.pagination) ? data.pagination : undefined;
  const pageInfo = isRecord(data.page_info) ? data.page_info : undefined;
  const paginationPageCount = pagination ? Number(pagination.page_count) : Number.NaN;
  const pageInfoPageCount = pageInfo ? Number(pageInfo.total_page) : Number.NaN;
  const paginationPage = pagination ? Number(pagination.page) : Number.NaN;
  const pageInfoPage = pageInfo ? Number(pageInfo.page) : Number.NaN;
  if (
    pagination
    && pageInfo
    && (
      paginationPageCount !== pageInfoPageCount
      || paginationPage !== pageInfoPage
    )
  ) {
    throw new UnknownCreationStateError("创意草稿列表的 pagination/page_info 互相矛盾；已停止发布。");
  }
  const pageCount = pagination ? paginationPageCount : pageInfoPageCount;
  const responsePage = pagination ? paginationPage : pageInfoPage;
  if (!Number.isInteger(pageCount) || pageCount < 1 || !Number.isInteger(responsePage) || responsePage !== page) {
    throw new UnknownCreationStateError("创意草稿列表分页元数据缺失或不一致；已停止发布。");
  }
  const responseLimit = pagination ? Number(pagination.limit) : limit;
  if (!Number.isInteger(responseLimit) || responseLimit < 1 || rowCount > responseLimit || page > pageCount) {
    throw new UnknownCreationStateError("创意草稿列表返回的分页范围无效；已停止发布。");
  }
  const hasNext = page < pageCount;
  const hasMoreFlags = [data.has_more, pageInfo?.has_more]
    .filter((value): value is boolean => typeof value === "boolean");
  if (hasMoreFlags.some((value) => value !== hasNext)) {
    throw new UnknownCreationStateError("创意草稿列表的分页标记互相矛盾；已停止发布。");
  }
  const paginationTotalCount = pagination ? Number(pagination.total_count) : Number.NaN;
  const pageInfoTotalCount = pageInfo ? Number(pageInfo.total_count) : Number.NaN;
  if (
    Number.isFinite(paginationTotalCount)
    && Number.isFinite(pageInfoTotalCount)
    && paginationTotalCount !== pageInfoTotalCount
  ) {
    throw new UnknownCreationStateError("创意草稿列表的分页总数互相矛盾；已停止发布。");
  }
  const totalCount = Number.isFinite(paginationTotalCount)
    ? paginationTotalCount
    : pageInfoTotalCount;
  if (!Number.isInteger(totalCount) || totalCount < 0) {
    throw new UnknownCreationStateError("创意草稿列表缺少可验证的 total_count；已停止发布。");
  }
  // TikTok's real creative list response can omit has_more. In that shape the
  // complete pagination tuple is the authoritative, count-backed equivalent.
  const hasCountBackedPagination = Boolean(
    pagination
    && Number.isInteger(paginationPage)
    && Number.isInteger(paginationPageCount)
    && Number.isInteger(responseLimit)
    && Number.isInteger(paginationTotalCount),
  );
  if (hasMoreFlags.length === 0 && !hasCountBackedPagination) {
    throw new UnknownCreationStateError("创意草稿列表缺少 has_more 或完整计数型分页证据；已停止发布。");
  }
  if (
    pageCount !== Math.max(1, Math.ceil(totalCount / responseLimit))
    || accumulatedRowCount > totalCount
    || (!hasNext && accumulatedRowCount !== totalCount)
  ) {
    throw new UnknownCreationStateError("创意草稿列表条数与分页总数不一致；已停止发布。");
  }
  return hasNext;
}

function parseNativeScheduleStart(value: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) {
    throw new RetryableCreationError("定时投放时间无效，已阻止复制发布。");
  }
  if (result.getTime() <= Date.now()) {
    throw new RetryableCreationError("定时投放时间必须晚于当前时间，已阻止复制发布。");
  }
  return result;
}

async function applyCopiedAdGroupOverrides(input: {
  sessionRequest: CapturedCookieRequest;
  credential: ParsedCookieCredential;
  dispatchState: CreationDispatchState;
  campaignId: string;
  publishItems: DraftPublishItem[];
  scheduledStart: Date | null;
  timezone: string;
  riskInfo: Record<string, unknown>;
  dailyBudget?: number;
  bid?: number | null;
  // 源系列为系列预算(CBO)时，广告组不能设与系列不同的预算（否则真机报
  // budget_auto_adjust_initial_budget_not_equal_campaign_budget）。此时跳过组预算覆盖，
  // 让新组继承系列预算。ABO 源不传该标志，行为与既有创建完全一致。
  skipBudgetOverride?: boolean;
}): Promise<void> {
  const overrideBudget = input.dailyBudget !== undefined && !input.skipBudgetOverride;
  const adSnapIds = input.publishItems.map((item) => item.ad_snap_id);
  const startTime = input.scheduledStart
    ? formatProviderDateTime(input.scheduledStart, input.timezone)
    : null;
  const forms = await readAdSnapForms(
    input.sessionRequest,
    input.credential,
    input.dispatchState,
    adSnapIds,
  );

  for (const publishItem of input.publishItems) {
    const sourceForm = forms.get(publishItem.ad_snap_id);
    if (!sourceForm) {
      throw new UnknownCreationStateError(
        `TikTok 草稿详情缺少广告组 ${publishItem.ad_snap_id}，已停止发布。`,
      );
    }
    const form = cloneRecord(sourceForm);
    // snap/detail is keyed by ad_snap_id, so `form` is authoritative for this
    // copied draft. TikTok can echo a different (or empty) ad_sketch_id here
    // than ad_snap/copy returned, and may omit ad_snap_id entirely — so only
    // reject a present-but-conflicting ad_snap_id. Adopt the detail's sketch id
    // (when provided) into the publish item so the ad_snap/save below and the
    // downstream create_by_snap publish reference the exact same draft; if the
    // detail omits it, keep the copy's id on the form we save.
    const formSnapId = nonEmptyId(form.ad_snap_id);
    if (formSnapId && formSnapId !== publishItem.ad_snap_id) {
      throw new UnknownCreationStateError("TikTok 草稿详情的广告组标识不一致，已停止发布。");
    }
    const formSketchId = nonEmptyId(form.ad_sketch_id);
    if (formSketchId) {
      publishItem.ad_sketch_id = formSketchId;
    } else {
      form.ad_sketch_id = publishItem.ad_sketch_id;
    }
    if (overrideBudget) {
      form.budget = String(input.dailyBudget);
    }
    if (input.bid !== undefined && input.bid !== null) {
      form.cpa_bid = String(input.bid);
    }
    if (input.scheduledStart && startTime) {
      form.schedule_type = 1;
      form.start_time = startTime;
      const existingEndTime = typeof form.end_time === "string" ? form.end_time.trim() : "";
      if (!existingEndTime || existingEndTime <= startTime) {
        const end = new Date(input.scheduledStart);
        end.setUTCFullYear(end.getUTCFullYear() + 10);
        form.end_time = formatProviderDateTime(end, input.timezone);
      }
    }

    await requestCreationStep(
      "ad_snap/save",
      () => creationPathRequest(input.sessionRequest, "/api/v4/i18n/creation/ad_snap/save/", {
        ad_sketch_form_data: form,
        spc_upgrade_mode: typeof form.spc_upgrade_mode === "number" ? form.spc_upgrade_mode : 1,
        with_sketch: true,
        is_skip_check_fields: false,
        campaign_id: input.campaignId,
        risk_info: input.riskInfo,
      }),
      input.credential,
      { semantics: "mutation", dispatchState: input.dispatchState },
    );
  }

  const verifiedForms = await readAdSnapForms(
    input.sessionRequest,
    input.credential,
    input.dispatchState,
    adSnapIds,
  );
  for (const adSnapId of adSnapIds) {
    const verified = verifiedForms.get(adSnapId);
    if (!verified) {
      throw new UnknownCreationStateError("TikTok 广告组草稿修改未能回读确认，已停止发布。");
    }
    if (overrideBudget && String(verified.budget) !== String(input.dailyBudget)) {
      throw new UnknownCreationStateError("TikTok 日预算未能回读确认，已停止发布。");
    }
    if (input.bid !== undefined && input.bid !== null && String(verified.cpa_bid) !== String(input.bid)) {
      throw new UnknownCreationStateError("TikTok 出价未能回读确认，已停止发布。");
    }
    if (startTime && (Number(verified.schedule_type) !== 1 || verified.start_time !== startTime)) {
      throw new UnknownCreationStateError("TikTok 原生排期未能回读确认，已停止发布。");
    }
  }
}

async function readAdSnapForms(
  sessionRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  dispatchState: CreationDispatchState,
  adSnapIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const detail = await requestCreationStep(
    "snap/detail",
    () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/snap/detail/", {
      ad_snap_ids: adSnapIds,
    }),
    credential,
    { semantics: "preflight-read", dispatchState },
  );
  const data = isRecord(detail.data) ? detail.data : undefined;
  const rawMap = data && isRecord(data.ad_snap_map) ? data.ad_snap_map : undefined;
  if (!rawMap) {
    throw new UnknownCreationStateError("TikTok 草稿详情未返回 ad_snap_map，已停止发布。");
  }
  return new Map(
    Object.entries(rawMap)
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      .map(([adSnapId, form]) => [adSnapId, form]),
  );
}

function formatProviderDateTime(value: Date, timezone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(value);
  } catch {
    throw new RetryableCreationError("账户时区无效，无法生成 TikTok 原生排期。");
  }
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`;
}

function hasNonEmptyOriginReference(
  profile: NonNullable<ParsedCookieCredential["creationProfile"]>,
): boolean {
  const copyLineageKeys = new Set([
    "origin_campaign_id",
    "origin_ad_id",
    "origin_creative_id",
  ]);
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (!isRecord(value)) return false;
    return Object.entries(value).some(([key, item]) => {
      const originId = copyLineageKeys.has(key) ? nonEmptyId(item) : undefined;
      return (originId !== undefined && !/^0+$/.test(originId)) || visit(item);
    });
  };
  return visit(profile.campaignPayload)
    || visit(profile.adGroupPayload)
    || visit(profile.creativePayload);
}

function withTodayMetricWindow(
  request: CapturedCookieRequest,
  timezone: string,
  now: Date,
): CapturedCookieRequest {
  const startDate = formatDateInTimezone(now, timezone);
  const endDate = formatDateInTimezone(now, timezone);
  let changed = false;
  const url = new URL(request.url);
  const isStatisticsRequest = url.pathname.includes("/statistics/");
  const urlDateKeys = isStatisticsRequest
    ? ["start_date", "end_date", "startDate", "endDate", "st", "et"]
    : ["start_date", "end_date", "startDate", "endDate"];
  for (const key of urlDateKeys) {
    if (!url.searchParams.has(key)) continue;
    url.searchParams.set(key, isStartDateKey(key) ? startDate : endDate);
    changed = true;
  }

  let body = request.body;
  if (body && request.contentType?.toLowerCase().includes("json")) {
    try {
      const value = JSON.parse(body) as unknown;
      changed = rewriteJsonDateWindow(value, startDate, endDate) || changed;
      if (isStatisticsRequest) {
        changed = rewriteStatisticsCommonRequest(value, startDate, endDate) || changed;
        changed = ensureStatisticsMetric(value, "time_attr_on_web_cart") || changed;
      }
      body = JSON.stringify(value);
    } catch {
      // Do not modify non-JSON bodies. The explicit check below prevents a
      // multi-day request from silently reaching the rule engine.
    }
  }
  return { ...request, url: url.toString(), ...(body === undefined ? {} : { body }) };
}

function hasExplicitMetricWindow(request: CapturedCookieRequest): boolean {
  const url = new URL(request.url);
  const isStatisticsRequest = url.pathname.includes("/statistics/");
  if (["start_date", "startDate", "st"].some((key) => url.searchParams.has(key)) &&
      ["end_date", "endDate", "et"].some((key) => url.searchParams.has(key))) {
    if (isStatisticsRequest || (!url.searchParams.has("st") && !url.searchParams.has("et"))) {
      return true;
    }
  }
  if (!request.body || !request.contentType?.toLowerCase().includes("json")) return false;
  try {
    const body = JSON.parse(request.body) as unknown;
    const standardWindow = hasJsonDateKey(body, ["start_date", "startDate"]) &&
      hasJsonDateKey(body, ["end_date", "endDate"]);
    return standardWindow || (isStatisticsRequest && hasStatisticsCommonWindow(body));
  } catch {
    return false;
  }
}

function hasJsonDateKey(value: unknown, keys: string[]): boolean {
  if (Array.isArray(value)) return value.some((item) => hasJsonDateKey(item, keys));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) =>
    keys.includes(key) || hasJsonDateKey(item, keys),
  );
}

function rewriteJsonDateWindow(value: unknown, startDate: string, endDate: string): boolean {
  if (Array.isArray(value)) {
    let changed = false;
    for (const item of value) changed = rewriteJsonDateWindow(item, startDate, endDate) || changed;
    return changed;
  }
  if (!isRecord(value)) return false;
  let changed = false;
  for (const [key, item] of Object.entries(value)) {
    if (["start_date", "end_date", "startDate", "endDate"].includes(key)) {
      value[key] = isStartDateKey(key) ? startDate : endDate;
      changed = true;
    } else if (isRecord(item) || Array.isArray(item)) {
      changed = rewriteJsonDateWindow(item, startDate, endDate) || changed;
    }
  }
  return changed;
}

function isStartDateKey(key: string): boolean {
  return key === "start_date" || key === "startDate" || key === "st";
}

function formatDateInTimezone(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date);
    const fields = Object.fromEntries(parts.map((item) => [item.type, item.value]));
    return `${fields.year}-${fields.month}-${fields.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

async function createCookieDraftChain(
  sessionRequest: CapturedCookieRequest,
  campaignObjectRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  mutation: CreationMutation,
  timezone: string,
  batchReservation?: { campaignId?: string; adGroupNames: Set<string> },
): Promise<CreationMutationResult> {
  const dispatchState: CreationDispatchState = {
    mutationDispatched: false,
    acceptedMutationCount: 0,
    ...(mutation.onBeforeDispatch
      ? { onBeforeMutationDispatch: mutation.onBeforeDispatch }
      : {}),
  };
  try {
    return await runCookieDraftChain(
      sessionRequest,
      campaignObjectRequest,
      credential,
      mutation,
      timezone,
      dispatchState,
      batchReservation,
    );
  } catch (cause) {
    if (cause instanceof ConfirmedCreationFailureError) {
      throw dispatchState.acceptedMutationCount > 0
        ? new ConfirmedCreationFailureError(cause.message, false)
        : cause;
    }
    if (cause instanceof UnknownCreationStateError) {
      throw cause;
    }
    const detail = cause instanceof Error ? cause.message : "创建链发生未知错误。";
    if (dispatchState.mutationDispatched) {
      throw new UnknownCreationStateError(
        `${detail}；此前已有创建或复制请求发出，系统不会自动重试。`,
      );
    }
    throw cause instanceof RetryableCreationError
      ? cause
      : new RetryableCreationError(detail);
  }
}

function rewriteStatisticsCommonRequest(value: unknown, startDate: string, endDate: string): boolean {
  if (!isRecord(value) || !isRecord(value.common_req)) return false;
  let changed = false;
  for (const key of ["st", "et"] as const) {
    if (!(key in value.common_req)) continue;
    value.common_req[key] = key === "st" ? startDate : endDate;
    changed = true;
  }
  return changed;
}

function hasStatisticsCommonWindow(value: unknown): boolean {
  return isRecord(value) && isRecord(value.common_req) &&
    "st" in value.common_req && "et" in value.common_req;
}

function ensureStatisticsMetric(value: unknown, metric: string): boolean {
  if (!isRecord(value) || !isRecord(value.common_req) || !Array.isArray(value.common_req.metrics)) {
    return false;
  }
  if (value.common_req.metrics.includes(metric)) return false;
  value.common_req.metrics.push(metric);
  return true;
}

async function runCookieDraftChain(
  sessionRequest: CapturedCookieRequest,
  campaignObjectRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  mutation: CreationMutation,
  timezone: string,
  dispatchState: CreationDispatchState,
  batchReservation?: { campaignId?: string; adGroupNames: Set<string> },
): Promise<CreationMutationResult> {
  mutation.onProgress?.({ phase: "validation", evidence: {} });
  const copyOnly = mutation.templateMode === "copy";
  if (copyOnly && !mutation.templateCampaignId) {
    throw new Error("复制模板无效：缺少 templateCampaignId，不能按系列名称回退定位。");
  }
  if (
    !copyOnly
    && credential.creationProfile
    && hasNonEmptyOriginReference(credential.creationProfile)
  ) {
    throw new RetryableCreationError(
      "当前创建样本来自 copy 流程，不能用于从零创建。请重新导入一次真正从空白页面创建广告时的创建请求。",
    );
  }
  const preflightPayloads = await requestCompleteListPages(
    "adgroup/list",
    sessionRequest,
    credential,
    dispatchState,
  );
  const campaignPayloads = copyOnly
    ? preflightPayloads
    : await requestCompleteListPages(
        "campaign/list",
        campaignObjectRequest,
        credential,
        dispatchState,
      );
  const preflightEntities = preflightPayloads.flatMap((payload) => extractEntities(payload, "ad-group"));
  const campaignEntities = campaignPayloads.flatMap((payload) => extractEntities(payload, "campaign"));
  const exactCampaigns = copyOnly ? [] : [...new Map(
    campaignEntities
      .filter((entity) => normalizeProviderEntity(entity).name.trim() === mutation.row.campaignName.trim())
      .map((entity) => [entity.externalId, entity]),
  ).values()];
  if (exactCampaigns.length > 1) {
    throw new RetryableCreationError("当前账户存在多个同名推广系列，无法确定应复用哪一个系列。");
  }
  const remoteCampaignId = exactCampaigns[0]?.externalId;
  if (batchReservation?.campaignId && remoteCampaignId && batchReservation.campaignId !== remoteCampaignId) {
    throw new RetryableCreationError("同批次系列预留与远端同名系列不一致，已停止创建。");
  }
  const existingCampaignId = batchReservation?.campaignId ?? remoteCampaignId;
  const creationRow = existingCampaignId
    ? { ...mutation.row, adGroupName: uniqueAdGroupName(
        preflightEntities,
        mutation.row.adGroupName,
        existingCampaignId,
        batchReservation?.adGroupNames,
      ) }
    : mutation.row;
  // Persist the exact auto-suffixed name before the first creation mutation.
  // Manual verification can then restore the same reservation after an
  // unknown provider result without guessing from the original spreadsheet.
  mutation.onProgress?.({
    phase: "validation",
    evidence: { resolvedAdGroupName: creationRow.adGroupName },
  });
  const drafts = credential.creationProfile
    ? buildProfileDraftPayloads(credential.creationProfile, creationRow, timezone, new Date(), mutation.preset)
    : buildDraftPayloads(creationRow, mutation.preset, timezone);
  // A new launch never copies a campaign. New campaign names save a fresh
  // campaign draft; exact-name matches skip that save and attach a fresh
  // ad-group to the existing campaign. Campaign copy is reserved for the
  // explicit templateMode="copy" operation only.
  const initializationTemplateCampaignId = copyOnly ? mutation.templateCampaignId : undefined;
  const initializedIds = initializationTemplateCampaignId
    ? await initializeProfileDraftIds(
        sessionRequest,
        credential,
        mutation,
        dispatchState,
        campaignEntities,
        initializationTemplateCampaignId,
        copyOnly,
      )
    : null;
  if (initializedIds) {
    applyCopiedDraftForms(drafts, initializedIds, !copyOnly, existingCampaignId);
  }
  const campaign = existingCampaignId ? {} : await requestCreationStep("campaign_snap/save",
    () => creationRequest(sessionRequest, "campaign_snap/save", drafts.campaign),
    credential,
    { semantics: "mutation", dispatchState },
  );
  const campaignSnapId = existingCampaignId ? "" : responseId(campaign, "campaign_snap_id")
    ?? initializedIds?.campaignSnapId
    ?? requiredResponseId(campaign, "campaign_snap_id");
  if (!existingCampaignId) {
    mutation.onProgress?.({ phase: "campaign_draft", evidence: { campaignSnapId } });
  }
  const campaignSketchId = existingCampaignId ? "" : responseId(campaign, "campaign_sketch_id")
    ?? initializedIds?.campaignSketchId
    ?? requiredResponseId(campaign, "campaign_sketch_id");
  if (!existingCampaignId) {
    mutation.onProgress?.({ phase: "campaign_draft", evidence: { campaignSnapId, campaignSketchId } });
  }
  let checkedFakeCampaignId = "";
  if (!copyOnly && !existingCampaignId) {
    const campaignCheck = await requestAdvisoryCreationStep(
      "campaign_snap/check",
      () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/campaign_snap/check/", {
        campaign_snap_id: campaignSnapId,
      }),
      credential,
    );
    const campaignData = campaignCheck && isRecord(campaignCheck.data) ? campaignCheck.data : {};
    checkedFakeCampaignId = nonEmptyId(campaignData.fake_campaign_id) ?? campaignSketchId;
  }

  if (initializedIds && !existingCampaignId) {
    const form = requireObjectField(drafts.adGroup, "ad_sketch_form_data");
    form.ad_snap_id = initializedIds.adSnapId;
    form.ad_sketch_id = initializedIds.adSketchId;
    form.by_ad_sketch_id = initializedIds.adSketchId;
  }

  const adGroup = copyOnly ? {} : await requestCreationStep("ad_snap/save",
    () => creationRequest(sessionRequest, "ad_snap/save", {
      ...drafts.adGroup,
      campaign_snap_id: campaignSnapId,
      campaign_sketch_id: campaignSketchId,
      campaign_id:
        responseId(campaign, "campaign_id") ??
        existingCampaignId ??
        nonEmptyId(drafts.adGroup.campaign_id) ??
        "",
    }),
    credential,
    { semantics: "mutation", dispatchState },
  );
  const adSnapId = copyOnly && initializedIds ? initializedIds.adSnapId : responseId(adGroup, "ad_snap_id")
    ?? initializedIds?.adSnapId
    ?? requiredResponseId(adGroup, "ad_snap_id");
  const adSketchId = copyOnly && initializedIds ? initializedIds.adSketchId : responseId(adGroup, "ad_sketch_id")
    ?? initializedIds?.adSketchId
    ?? requiredResponseId(adGroup, "ad_sketch_id");
  mutation.onProgress?.({
    phase: "adgroup_draft",
    evidence: { adGroupSnapId: adSnapId, adGroupSketchId: adSketchId },
  });
  // TikTok's ad_snap/bulk_check is scoped to a newly saved campaign draft and
  // requires the fake campaign id returned by campaign_snap/check. A formal
  // existing campaign has no such draft id; passing its real id is rejected as
  // stale page information. Reused campaigns continue to the later joint HAR
  // validations, which cover the ad-group and creatives before publish.
  if (!copyOnly && !existingCampaignId) {
    await requestAdvisoryCreationStep(
      "ad_snap/bulk_check",
      () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/ad_snap/bulk_check/", {
        ad_snap_ids: [adSnapId],
        fake_campaign_id: checkedFakeCampaignId || existingCampaignId || campaignSketchId,
      }),
      credential,
    );
  }
  const creativeSnapIdFromAd = initializedIds
    ? initializedIds.creativeSnapId
    : responseId(adGroup, "creative_snap_id");
  const creativeSketchIdFromAd = initializedIds
    ? initializedIds.creativeSketchId
    : responseId(adGroup, "creative_sketch_id");

  const resolvedVideos = await resolveTikTokVideos(
    { ...mutation, row: creationRow },
    sessionRequest,
    credential,
  );

  // One ad-group, several ads = ONE creative whose image_list carries every
  // video, each bound to its authorized creator identity. This mirrors TikTok's
  // real SPC multi-ad creative_snap/save (N videos in one image_list, not N
  // separate creatives).
  const creativeAssets = drafts.creative.asset_group_sketch_form_data_list;
  const singleAsset = Array.isArray(creativeAssets) && isRecord(creativeAssets[0])
    ? creativeAssets[0]
    : {};
  if (!copyOnly) {
    singleAsset.image_list = buildSparkImageList(resolvedVideos);
    singleAsset.title_list = resolvedVideos.map((video) => ({ title: "", aweme_item_id: video.itemId }));
    if (resolvedVideos.some((video) => video.identityId)) {
      // Match TikTok's real from-scratch Spark creative_snap/save. Spark posts
      // use a per-image (level-2) identity: the creative declares identity_type=2
      // with an empty id, each image carries its own authorized creator, and
      // ad_level2_identity_structure=1 tells the check to resolve the post via
      // that per-image identity. The structural fields below (coming_source_type
      // etc.) are what a fresh manual creative sends; without them the check
      // fails with "无法获取 Spark Ads 帖子信息".
      singleAsset.identity_type = 2;
      singleAsset.identity_id = "";
      singleAsset.item_source = 2;
      singleAsset.ad_level2_identity_structure = 1;
      Object.assign(singleAsset, TikTokCreationPublishSource);
      singleAsset.creative_material_mode = 6;
      singleAsset.struct_version = 1;
      singleAsset.asset_group_id = "";
      singleAsset.creative_assets_active_id = resolvedVideos[0]?.itemId ?? "";
      // A fresh creative has no copy lineage; a template's origin id makes the
      // check resolve the wrong post.
      delete singleAsset.origin_creative_id;
    }
    singleAsset.creative_snap_id = creativeSnapIdFromAd ?? "";
    singleAsset.creative_sketch_id = creativeSketchIdFromAd ?? "";
  }
  let creativeSnapId: string;
  let creativeSketchId: string;
  let lastCreativeResponse: Record<string, unknown> = {};
  if (copyOnly && initializedIds) {
    creativeSnapId = initializedIds.creativeSnapId;
    creativeSketchId = initializedIds.creativeSketchId;
  } else {
    const adForm = requireObjectField(drafts.adGroup, "ad_sketch_form_data");
    await prepareSparkPosts(sessionRequest, credential, resolvedVideos, {
      countryIds: mutation.preset.countryCodes,
      startTime: String(adForm.start_time ?? ""),
      endTime: String(adForm.end_time ?? ""),
      objectiveType: requireObjectField(drafts.campaign, "campaign_sketch_form_data").objective_type,
      campaignId: existingCampaignId ?? "",
      campaignSnapId,
      adSnapId,
      creativeInfo: singleAsset,
    });
    const creativeDraft: Record<string, unknown> = {
      ...drafts.creative,
      ad_snap_id: adSnapId,
      ad_sketch_id: adSketchId,
      asset_group_sketch_form_data_list: [singleAsset],
      ...(resolvedVideos.some((video) => video.identityId) ? { spc_upgrade_mode: 1 } : {}),
    };
    const creative = await requestCreationStep("creative_snap/save",
      () => creationRequest(sessionRequest, "creative_snap/save", creativeDraft),
      credential,
      { semantics: "mutation", dispatchState },
    );
    lastCreativeResponse = creative;
    creativeSnapId = responseId(creative, "creative_snap_id")
      ?? responseId(creative, "creative_snap_ids")
      ?? creativeSnapIdFromAd
      ?? requiredResponseId(creativeDraft, "creative_snap_id");
    creativeSketchId = responseId(creative, "creative_sketch_id")
      ?? responseId(creative, "creative_sketch_ids")
      ?? creativeSketchIdFromAd
      ?? requiredResponseId(creativeDraft, "creative_sketch_id");
  }
  mutation.onProgress?.({
    phase: "creative_draft",
    evidence: { creativeSnapId, creativeSketchId },
  });

  const publishItems = copyOnly && initializedIds
    ? initializedIds.publishItems
    : [{
        ad_id: "", ad_snap_id: adSnapId, ad_sketch_id: adSketchId,
        creative_snap_info_list: [{
          creative_id: "", creative_snap_id: creativeSnapId,
          creative_sketch_id: creativeSketchId, need_publish: true as const,
        }],
        need_publish: true as const,
      }];
  const publishPayload = credential.creationProfile
    ? materializePublishProfile(credential.creationProfile.publishPayload, {
        ...(existingCampaignId ? { campaignId: existingCampaignId } : {}), campaignSnapId, campaignSketchId, publishItems,
        initialStatus: mutation.initialStatus,
      })
    : buildPublishInput({
      campaignSnapId: campaignSnapId || existingCampaignId!,
      campaignSketchId: campaignSketchId || existingCampaignId!,
      adAndCreativeSnapInfoList: publishItems,
    }, mutation.initialStatus);
  if (existingCampaignId) {
    publishPayload.campaign_id = existingCampaignId;
    publishPayload.campaign_snap_id = "";
    publishPayload.campaign_sketch_id = "";
  }
  await runAdvisoryDraftSequence(sessionRequest, credential, {
    ...(existingCampaignId ? { campaignId: existingCampaignId } : {}), campaignSnapId, campaignSketchId, publishItems,
    ...(checkedFakeCampaignId ? { fakeCampaignId: checkedFakeCampaignId } : {}),
    riskInfo: credential.creationProfile && isRecord(credential.creationProfile.publishPayload.risk_info)
      ? credential.creationProfile.publishPayload.risk_info
      : {},
  });
  let published: Record<string, unknown>;
  mutation.onProgress?.({ phase: "publishing", evidence: {} });
  try {
    published = await requestCreationStep("create_by_snap",
      () => creationRequest(sessionRequest, "async_creation/create_by_snap", publishPayload),
      credential,
      { semantics: "mutation", dispatchState },
    );
    const asyncRequestId = responseId(published, "async_request_id");
    mutation.onProgress?.({
      phase: "publishing",
      evidence: {
        ...(asyncRequestId ? { asyncRequestId } : {}),
        ...(responseId(published, "request_id")
          ? { providerRequestId: responseId(published, "request_id") }
          : {}),
      },
    });
  } catch (cause) {
    if (cause instanceof ConfirmedCreationFailureError) throw cause;
    if (cause instanceof RetryableCreationError) throw cause;
    const detail = cause instanceof Error ? cause.message : "未知错误";
    const diagnostics = {
      campaignSnapEcho: responseId(campaign, "campaign_snap_id") === initializedIds?.campaignSnapId,
      campaignSketchEcho: responseId(campaign, "campaign_sketch_id") === initializedIds?.campaignSketchId,
      adSnapEcho: responseId(adGroup, "ad_snap_id") === initializedIds?.adSnapId,
      adSketchEcho: responseId(adGroup, "ad_sketch_id") === initializedIds?.adSketchId,
      creativeSnapEcho: responseId(lastCreativeResponse, "creative_snap_id") === creativeSnapId,
      creativeSketchEcho: responseId(lastCreativeResponse, "creative_sketch_id") === creativeSketchId,
    };
    throw new UnknownCreationStateError(`${detail}；草稿回显=${JSON.stringify(diagnostics)}`);
  }
  let completed: Record<string, unknown>;
  try {
    completed = await awaitCreationResult(sessionRequest, credential, published, existingCampaignId);
  } catch (cause) {
    if (cause instanceof ConfirmedCreationFailureError) throw cause;
    throw new UnknownCreationStateError(
      cause instanceof Error ? cause.message : "TikTok 创建结果无法确认。",
    );
  }
  const ids = creationResultIds(completed);
  if (!ids.campaignId && existingCampaignId) ids.campaignId = existingCampaignId;
  if (!ids.campaignId || !ids.adGroupId || !ids.adId) {
    throw new UnknownCreationStateError(`TikTok 创建任务未生成完整对象：${JSON.stringify(creationResultSummary(completed))}`);
  }
  mutation.onProgress?.({ phase: "readback", evidence: {} });
  return {
    ...mutation,
    row: creationRow,
    ok: true,
    ...(ids.campaignId ? { campaignId: ids.campaignId } : {}),
    ...(ids.adGroupId ? { adGroupId: ids.adGroupId } : {}),
    ...(ids.adId ? { adId: ids.adId } : {}),
    message: "TikTok 创建任务已完成，正在回读三层状态。",
  };
}

function creationResultSummary(payload: Record<string, unknown>): Record<string, unknown> {
  const data = isRecord(payload.data) ? payload.data : {};
  const result = isRecord(data.result) ? data.result : {};
  const adsValue = result.ad_and_creative;
  const ads = Array.isArray(adsValue) ? adsValue : isRecord(adsValue) ? Object.values(adsValue) : [];
  return {
    status: typeof data.status === "number" ? data.status : null,
    operation: typeof result.operation === "number" ? result.operation : null,
    ads: ads.filter(isRecord).map((ad) => {
      const groupsValue = ad.asset_group_result;
      const groups = Array.isArray(groupsValue) ? groupsValue : isRecord(groupsValue) ? Object.values(groupsValue) : [];
      return {
        operation: typeof ad.operation === "number" ? ad.operation : null,
        groups: groups.filter(isRecord).map((group) => ({
          fields: Object.keys(group).filter((key) => !/(?:^|_)(?:id|ids)$/i.test(key) && !/name/i.test(key)),
          isSuccess: typeof group.is_success === "boolean" ? group.is_success : null,
          failure: safeFailureFields(group),
          creatives: Array.isArray(group.creative_items) ? group.creative_items.filter(isRecord).map((creative) => ({
            fields: Object.keys(creative).filter((key) => !/(?:^|_)(?:id|ids)$/i.test(key) && !/name/i.test(key)),
            isSuccess: typeof creative.is_success === "boolean" ? creative.is_success : null,
            errorCode: typeof creative.error_code === "number" || typeof creative.error_code === "string" ? creative.error_code : null,
            errorMessage: typeof creative.error_message === "string" ? creative.error_message.slice(0, 200) : null,
            failure: safeFailureFields(creative),
          })) : [],
        })),
      };
    }),
  };
}

function safeFailureFields(value: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (/(?:^|_)(?:id|ids)$/i.test(key) || /name/i.test(key)) continue;
    if (isRecord(item)) Object.assign(output, safeFailureFields(item, path));
    else if (Array.isArray(item)) {
      for (const child of item) if (isRecord(child)) Object.assign(output, safeFailureFields(child, `${path}[]`));
    } else if (/error|fail|reason|message|code|status|is_success/i.test(key) && ["string", "number", "boolean"].includes(typeof item)) {
      output[path] = typeof item === "string" ? item.slice(0, 200) : item;
    }
  }
  return output;
}

async function runAdvisoryDraftSequence(
  sessionRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  ids: {
    campaignId?: string;
    fakeCampaignId?: string;
    campaignSnapId: string;
    campaignSketchId: string;
    publishItems: DraftPublishItem[];
    riskInfo: Record<string, unknown>;
  },
): Promise<void> {
  const adSnapIds = ids.publishItems.map((item) => item.ad_snap_id);
  let fakeCampaignId = ids.fakeCampaignId ?? "";
  if (!ids.campaignId) {
    await requestAdvisoryCreationStep("snap/cbo_consistency_check",
      () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/snap/cbo_consistency_check/", {
        campaign_snap_id: ids.campaignSnapId,
        adgroup_snap_ids: adSnapIds,
        ad_snap_ids: adSnapIds,
        is_budget_split_test: false,
      }), credential);
    if (!fakeCampaignId) {
      const campaignCheck = await requestAdvisoryCreationStep("campaign_snap/check",
        () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/campaign_snap/check/", {
          campaign_snap_id: ids.campaignSnapId,
        }), credential);
      const campaignData = campaignCheck && isRecord(campaignCheck.data) ? campaignCheck.data : undefined;
      fakeCampaignId = nonEmptyId(campaignData?.fake_campaign_id) ?? ids.campaignSketchId;
    }
  }
  const checkInfo = ids.publishItems.map((item) => ({
    ad_id: "",
    ad_snap_id: item.ad_snap_id,
    creative_snap_ids: item.creative_snap_info_list.map((creative) => creative.creative_snap_id),
  }));
  await requestAdvisoryCreationStep("ad_creative_snap/check",
    () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/ad_creative_snap/check/", {
      campaign_id: ids.campaignId ?? "",
      fake_campaign_id: fakeCampaignId,
      ad_creative_snap_check_info: checkInfo,
      risk_info: ids.riskInfo,
    }), credential);
  await requestAdvisoryCreationStep("snap/batch_create_cta_id",
    () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/snap/batch_create_cta_id/", {
      campaign_id: ids.campaignId ?? "",
      campaign_snap_id: ids.campaignSnapId,
      ad_and_creative_snap_info_list: checkInfo,
    }), credential);
}

async function awaitCreationResult(
  sessionRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  published: Record<string, unknown>,
  existingCampaignId?: string,
): Promise<Record<string, unknown>> {
  const asyncRequestId = responseId(published, "async_request_id");
  if (!asyncRequestId) return published;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 750));
    const detail = await requestCreationStep("async_creation/detail",
      () => creationDetailRequest(sessionRequest, asyncRequestId),
      credential,
      { semantics: "result-query" },
    );
    const data = isRecord(detail.data) ? detail.data : undefined;
    if (data?.status === 1 && isRecord(data.result)) {
      if (hasExplicitCreationFailure(data.result)) {
        if (hasAnyPublishedCreationId(data.result, existingCampaignId)) {
          throw new UnknownCreationStateError(
            "TikTok 返回部分创建成功、部分失败；为避免重复创建，必须人工核验后再处理。",
          );
        }
        throw new ConfirmedCreationFailureError(`TikTok 已明确报告广告组或创意创建失败，未生成正式广告。detail=${JSON.stringify(data.result).slice(0, 300)}`);
      }
      return detail;
    }
    if (typeof data?.status === "number" && data.status < 0) {
      throw new ConfirmedCreationFailureError("TikTok 已明确报告创建失败，未生成正式广告。");
    }
  }
  throw new UnknownCreationStateError("TikTok 创建任务在 9 秒内未返回最终结果；请求可能已被受理，禁止自动重试，请人工核验。");
}

/**
 * Resolves each video code in the cell to a TikTok item (Post) id. A code may
 * be resolved from either the account material library or a stored mapping.
 * A `#…` authorization code always uses the live material endpoints so Spark
 * identity is authorized and verified; mappings only guard against drift.
 * Bare numeric ids may use their stored mapping or pass through unchanged.
 */
interface ResolvedVideo {
  /** TikTok item id that goes into aweme_item_id. */
  itemId: string;
  /** Authorized creator identity (core_user_id from the material library); the
   * ad uses it as identity_type=2 / identity_id for a Spark post. */
  identityId?: string;
  /** Underlying video material id (video_info.vid); a Spark post must be
   * registered by vid via spark/creative_fix_task before the creative saves. */
  vid?: string;
}

/**
 * Resolves every video code in the cell to its TikTok item, in order. A `#…`
 * authorization code is always looked up and authorized live; a stored mapping
 * is only a consistency check. A bare numeric id may use its stored mapping.
 */
async function resolveTikTokVideos(
  mutation: CreationMutation,
  sessionRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
): Promise<ResolvedVideo[]> {
  const codes = splitVideoCodes(mutation.row.videoCode);
  const list = codes.length > 0 ? codes : [mutation.row.videoCode];
  const manual = new Map<string, string>();
  const needLibrary: string[] = [];
  for (const code of list) {
    const matches = mutation.preset.videoPostMappings?.filter(
      (item) => item.videoCode === code,
    ) ?? [];
    const postIds = [...new Set(matches.map((item) => item.postId))];
    if (postIds.length > 1) {
      throw new RetryableCreationError("同一授权码配置了多个 Post ID，请先统一映射。");
    }
    if (code.startsWith("#")) needLibrary.push(code);
    else if (postIds[0]) manual.set(code, postIds[0]);
  }
  const library = needLibrary.length > 0
    ? await resolveVideoCodesFromLibrary(sessionRequest, credential, needLibrary)
    : new Map<string, ResolvedVideo>();
  const videos = list.map((code) => {
    const fromLibrary = library.get(code);
    if (code.startsWith("#")) {
      if (fromLibrary) {
        const mappedPostId = mutation.preset.videoPostMappings?.find((item) => item.videoCode === code)?.postId;
        if (mappedPostId && mappedPostId !== fromLibrary.itemId) {
          throw new RetryableCreationError("授权码解析结果与保存的 Post ID 不一致，请刷新授权关系后重试。");
        }
        return fromLibrary;
      }
      throw new RetryableCreationError(
        "有授权码无法在素材库中解析到帖子；请确认该视频已授权到当前账户。",
      );
    }
    const manualId = manual.get(code);
    if (manualId) return { itemId: manualId } satisfies ResolvedVideo;
    return { itemId: code } satisfies ResolvedVideo;
  });
  return videos;
}

/** Looks up `#…` authorization codes in the account's material library and maps
 * each to its item id and authorized creator identity (core_user_id). */
async function resolveVideoCodesFromLibrary(
  sessionRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  codes: string[],
): Promise<Map<string, ResolvedVideo>> {
  const uniqueCodes = [...new Set(codes)];
  const response = await requestCreationStep(
    "material/tt_video/bulk/info",
    () => creationPathRequest(
      sessionRequest,
      "/api/v4/i18n/creation/material/tt_video/bulk/info/",
      { video_code_list: uniqueCodes },
    ),
    credential,
  );
  const data = isRecord(response.data) ? response.data : {};
  const videoMap = isRecord(data.tt_video_map) ? data.tt_video_map : {};
  const out = new Map<string, ResolvedVideo>();
  for (const code of uniqueCodes) {
    const entry = videoMap[code];
    if (!isRecord(entry)) continue;
    const itemId = nonEmptyId(entry.item_id);
    if (!itemId) continue;
    const identityId = nonEmptyId(entry.core_user_id);
    if (!identityId) {
      throw new UnknownCreationStateError("TikTok 素材信息未返回可核对的 Spark 身份；已停止授权和创意创建，请人工核验授权状态。");
    }
    const videoInfo = isRecord(entry.video_info) ? entry.video_info : {};
    const vid = nonEmptyId(videoInfo.vid) ?? nonEmptyId(videoInfo.video_id);
    out.set(code, {
      itemId,
      identityId,
      ...(vid ? { vid } : {}),
    });
  }
  if (out.size !== uniqueCodes.length) return out;
  const authorized = await requestCreationStep(
    "material/tt_video/bulk/authorize",
    () => creationPathRequest(
      sessionRequest,
      "/api/v4/i18n/creation/material/tt_video/bulk/authorize/",
      { auth_code_info_list: uniqueCodes.map((auth_code) => ({ auth_code })), is_check: false },
    ),
    credential,
  );
  const authorizedData = isRecord(authorized.data) ? authorized.data : {};
  const identityMap = isRecord(authorizedData.identity_id_map) ? authorizedData.identity_id_map : {};
  for (const code of uniqueCodes) {
    const video = out.get(code)!;
    const authorizedIdentity = nonEmptyId(identityMap[code]);
    if (!authorizedIdentity) {
      throw new ConfirmedCreationFailureError("TikTok 未返回授权码对应的 Spark 身份，已停止创建创意。");
    }
    if (video.identityId && video.identityId !== authorizedIdentity) {
      throw new ConfirmedCreationFailureError("TikTok 返回的 Spark 身份前后不一致，已停止创建创意。");
    }
    out.set(code, { ...video, identityId: authorizedIdentity });
  }
  return out;
}

/** Mirrors the successful Ads Manager Spark preparation sequence captured in
 * the verified from-scratch HAR. Every step completes before creative save. */
interface SparkPreparationContext {
  countryIds: number[];
  startTime: string;
  endTime: string;
  objectiveType: unknown;
  campaignId: string;
  campaignSnapId: string;
  adSnapId: string;
  creativeInfo: Record<string, unknown>;
}

async function prepareSparkPosts(
  sessionRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  videos: ResolvedVideo[],
  context: SparkPreparationContext,
): Promise<void> {
  const sparkVideos = videos.filter(
    (video): video is ResolvedVideo & { identityId: string; vid: string } => Boolean(video.identityId && video.vid),
  );
  if (sparkVideos.length === 0) return;
  if (sparkVideos.length !== videos.filter((video) => video.identityId).length) {
    throw new ConfirmedCreationFailureError("TikTok 未返回完整的 Spark 视频素材标识，已停止创建创意。");
  }

  const postList = sparkVideos.map((video) => ({
    item_id: video.itemId,
    identity_id: video.identityId,
    identity_type: 2,
  }));
  await requestAdvisoryCreationStep(
    "spark/validate_promote_music",
    () => creationPathRequest(
      sessionRequest,
      "/api/v4/i18n/creation/spark/validate_promote_music/",
      {
        countries: [...new Set(context.countryIds)],
        start_time: context.startTime,
        end_time: context.endTime,
        post_list: postList,
      },
    ),
    credential,
  );

  await requestAdvisoryCreationStep(
    "creative/creative_automation_option",
    () => creationPathRequest(
      sessionRequest,
      "/api/v4/i18n/creation/creative/creative_automation_option/",
      { identity_type: 2 },
    ),
    credential,
  );

  const uniqueVids = [...new Set(sparkVideos.map((video) => video.vid))];
  const countryList = [...new Set(
    context.countryIds
      .map((id) => TIKTOK_LOCATION_TO_ISO[id])
      .filter((code): code is string => Boolean(code)),
  )];
  if (uniqueVids.length === 0) return;
  const saved = await requestAdvisoryCreationStep(
    "spark/creative_fix_task/save",
    () => creationPathRequest(
      sessionRequest,
      "/api/v4/i18n/creation/spark/creative_fix_task/save/",
      { creative_fix_vid_list: uniqueVids, country_list: countryList },
    ),
    credential,
  );
  const savedData = saved && isRecord(saved.data) ? saved.data : {};
  const taskMap = isRecord(savedData.task_map) ? savedData.task_map : {};
  const taskIds = [...new Set(uniqueVids.map((vid) => nonEmptyId(taskMap[vid])).filter((id): id is string => Boolean(id)))];
  await requestAdvisoryCreationStep(
    "roi2/auction_batch_item_roi2_validate",
    () => creationPathRequest(
      sessionRequest,
      "/api/v4/i18n/creation/roi2/auction_batch_item_roi2_validate/",
      {
        ad_infos: [],
        campaign_info: { objective_type: context.objectiveType },
        smart_plus_plus_info: {
          ad_id: "",
          ad_snap_id: context.adSnapId,
          campaign_id: context.campaignId,
          campaign_snap_id: context.campaignSnapId,
          creative_info: context.creativeInfo,
        },
      },
    ),
    credential,
  );
  if (taskIds.length !== uniqueVids.length) return;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
    const info = await requestAdvisoryCreationStep(
      "spark/creative_fix_task/info",
      () => creationPathRequest(
        sessionRequest,
        "/api/v4/i18n/creation/spark/creative_fix_task/info/",
        { task_id_list: taskIds },
      ),
      credential,
      { semantics: "result-query" },
    );
    if (!info) return;
    const infoData = isRecord(info.data) ? info.data : {};
    const infoMap = isRecord(infoData.task_info_map) ? infoData.task_info_map : {};
    const statuses = taskIds.map((taskId) => {
      const task = isRecord(infoMap[taskId]) ? infoMap[taskId] : {};
      return typeof task.task_status === "number" ? task.task_status : null;
    });
    if (statuses.every((status) => status === 2)) return;
  }
}

/** Maps TikTok location ids used by the ad targeting to the ISO country codes
 * the Spark fix task expects. Falls back to nothing when a code is unknown. */
const TIKTOK_LOCATION_TO_ISO: Record<number, string> = {
  1668284: "TW", // 台湾
  6252001: "US",
  1814991: "CN",
};

/** Builds the multi-ad image_list for a Spark creative: one entry per resolved
 * video, each bound to the authorized creator identity. This is how one ad-group
 * carries several ads — N videos in one creative's image_list, not N creatives. */
function buildSparkImageList(videos: ResolvedVideo[]): Array<Record<string, unknown>> {
  return videos.map((video) => ({
    image_mode: 15,
    aweme_item_id: video.itemId,
    item_source: 2,
    media_tag: 0,
    ...(video.identityId ? { identity_type: 2, identity_id: video.identityId } : {}),
  }));
}

function uniqueAdGroupName(
  preflightEntities: ProviderEntity[],
  requestedName: string,
  campaignId: string,
  reservedNames: ReadonlySet<string> = new Set(),
): string {
  const existingNames = new Set(
    preflightEntities
      .filter((entity) => nonEmptyId(entity.payload.campaign_id) === campaignId)
      .map((entity) => normalizeProviderEntity(entity).name.trim())
      .filter(Boolean),
  );
  for (const name of reservedNames) existingNames.add(name);
  if (!existingNames.has(requestedName)) return requestedName;
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const candidate = `${requestedName}-${String(suffix).padStart(3, "0")}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  throw new RetryableCreationError("同一推广系列下的广告组名称已用尽 001-999 后缀，请修改表格中的广告组名称。");
}

function hasExplicitCreationFailure(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExplicitCreationFailure);
  if (!isRecord(value)) return false;
  if (value.is_success === false) return true;
  return Object.values(value).some(hasExplicitCreationFailure);
}

function hasAnyPublishedCreationId(
  result: Record<string, unknown>,
  existingCampaignId?: string,
): boolean {
  const campaignId = nonEmptyId(result.campaign_id);
  if (campaignId && campaignId !== existingCampaignId) return true;
  const ads = isRecord(result.ad_and_creative)
    ? Object.values(result.ad_and_creative)
    : Array.isArray(result.ad_and_creative) ? result.ad_and_creative : [];
  return ads.some((ad) => {
    if (!isRecord(ad)) return false;
    if (nonEmptyId(ad.ad_id)) return true;
    const groups = isRecord(ad.asset_group_result)
      ? Object.values(ad.asset_group_result)
      : Array.isArray(ad.asset_group_result) ? ad.asset_group_result : [];
    return groups.some((group) => {
      if (!isRecord(group)) return false;
      const creatives = Array.isArray(group.creative_items)
        ? group.creative_items
        : isRecord(group.creative_items) ? Object.values(group.creative_items) : [];
      return creatives.some((creative) => isRecord(creative) && nonEmptyId(creative.id));
    });
  });
}

function completedCreationCounts(payload: Record<string, unknown>): {
  adGroupCount: number;
  creativeCount: number;
  creativeCountsByAdGroup: number[];
} {
  const data = isRecord(payload.data) ? payload.data : payload;
  const result = isRecord(data.result) ? data.result : data;
  const ads = isRecord(result.ad_and_creative)
    ? Object.values(result.ad_and_creative)
    : Array.isArray(result.ad_and_creative) ? result.ad_and_creative : [];
  let adGroupCount = 0;
  let creativeCount = 0;
  const creativeCountsByAdGroup: number[] = [];
  for (const ad of ads) {
    if (!isRecord(ad) || !nonEmptyId(ad.ad_id)) continue;
    adGroupCount += 1;
    const groups = isRecord(ad.asset_group_result)
      ? Object.values(ad.asset_group_result)
      : Array.isArray(ad.asset_group_result) ? ad.asset_group_result : [];
    let adCreativeCount = 0;
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const creatives = Array.isArray(group.creative_items)
        ? group.creative_items
        : isRecord(group.creative_items) ? Object.values(group.creative_items) : [];
      adCreativeCount += creatives.filter(
        (creative) => isRecord(creative) && Boolean(nonEmptyId(creative.id)),
      ).length;
    }
    creativeCount += adCreativeCount;
    creativeCountsByAdGroup.push(adCreativeCount);
  }
  return { adGroupCount, creativeCount, creativeCountsByAdGroup };
}

function creationResultIds(payload: Record<string, unknown>): { campaignId?: string; adGroupId?: string; adId?: string } {
  const data = isRecord(payload.data) ? payload.data : payload;
  const result = isRecord(data.result) ? data.result : data;
  const campaignId = nonEmptyId(result.campaign_id);
  const adsValue = result.ad_and_creative;
  const ads = Array.isArray(adsValue) ? adsValue : isRecord(adsValue) ? Object.values(adsValue) : [];
  const firstAd = isRecord(ads[0]) ? ads[0] : undefined;
  const adGroupId = (firstAd ? nonEmptyId(firstAd.ad_id) : undefined)
    ?? nonEmptyId(data.adgroup_id)
    ?? nonEmptyId(data.ad_id);
  const groupsValue = firstAd?.asset_group_result;
  const groups = Array.isArray(groupsValue) ? groupsValue : isRecord(groupsValue) ? Object.values(groupsValue) : [];
  const firstGroup = isRecord(groups[0]) ? groups[0] : undefined;
  const creatives = Array.isArray(firstGroup?.creative_items)
    ? firstGroup.creative_items
    : isRecord(firstGroup?.creative_items) ? Object.values(firstGroup.creative_items) : [];
  const firstCreative = isRecord(creatives[0]) ? creatives[0] : undefined;
  const adId = (firstCreative ? nonEmptyId(firstCreative.id) : undefined)
    ?? nonEmptyId(data.creative_id);
  return {
    ...(campaignId ? { campaignId } : {}),
    ...(adGroupId ? { adGroupId } : {}),
    ...(adId ? { adId } : {}),
  };
}

interface InitializedDraftIds {
  campaignSnapId: string;
  campaignSketchId: string;
  adSnapId: string;
  adSketchId: string;
  creativeSnapId: string;
  creativeSketchId: string;
  campaignForm: Record<string, unknown>;
  adForm: Record<string, unknown>;
  creativeForm: Record<string, unknown>;
  publishItems: DraftPublishItem[];
}

interface DraftPublishItem {
  ad_id: string;
  ad_snap_id: string;
  ad_sketch_id: string;
  creative_snap_info_list: Array<{
    creative_id: string;
    creative_snap_id: string;
    creative_sketch_id: string;
    need_publish: true;
  }>;
  need_publish: true;
}

async function initializeProfileDraftIds(
  sessionRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  mutation: CreationMutation,
  dispatchState: CreationDispatchState,
  campaigns: ProviderEntity[],
  templateCampaignId: string,
  requireDisabledSource: boolean,
): Promise<InitializedDraftIds> {
  const profile = credential.creationProfile;
  const sourceCampaign = campaigns.find(
    (entity) => entity.externalId === templateCampaignId,
  );
  if (!sourceCampaign) {
    throw new Error(`当前账户未找到模板系列 ID：${templateCampaignId}。不会按系列名称回退定位。`);
  }
  if (requireDisabledSource && normalizeProviderEntity(sourceCampaign).status !== "disabled") {
    throw new Error("为了避免意外花费，只允许复制关闭状态的源系列。");
  }
  const riskInfo = profile && isRecord(profile.publishPayload.risk_info)
    ? profile.publishPayload.risk_info
    : profile && isRecord(profile.campaignPayload.risk_info)
      ? profile.campaignPayload.risk_info
      : {};
  const copied = await requestCreationStep("campaign_snap/copy",
    () => creationPathRequest(sessionRequest, "/mi/api/v4/i18n/creation/campaign_snap/copy/", {
      campaign_id: templateCampaignId,
      name: mutation.row.campaignName,
      resp_with_detail: true,
      with_ad: true,
      with_creative: true,
      with_sketch: true,
      risk_info: riskInfo,
    }),
    credential,
    { semantics: "mutation", dispatchState },
  );
  return copiedDraftIds(copied);
}

/** Normalize the provider-owned legacy source field at the credential edge. */
export function resolveTemplateCampaignId(
  credential: ProviderContext["credential"],
): string | null {
  if (credential.kind !== "cookie") return null;
  const parsed = CookieCredentialInputSchema.safeParse(credential);
  if (!parsed.success || !parsed.data.creationProfile) return null;
  const campaignForm = parsed.data.creationProfile.campaignPayload.campaign_sketch_form_data;
  if (!isRecord(campaignForm)) return null;
  return nonEmptyId(campaignForm.origin_campaign_id) ?? null;
}

function copiedDraftIds(payload: Record<string, unknown>): InitializedDraftIds {
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (!data) throw new UnknownCreationStateError("TikTok 草稿初始化响应缺少 data。");
  const campaignItem = isRecord(data.new_campaign_snap_info_item) ? data.new_campaign_snap_info_item : undefined;
  const campaignSnapId = campaignItem ? nonEmptyId(campaignItem.campaign_snap_id) : undefined;
  const campaignForm = campaignItem && isRecord(campaignItem.campaign_snap_form_data) ? campaignItem.campaign_snap_form_data : undefined;
  const campaignSketchId = nonEmptyId(data.new_campaign_sketch_id);
  const adItems = Array.isArray(data.new_ad_snap_info_item_list) ? data.new_ad_snap_info_item_list.filter(isRecord) : [];
  const firstAd = isRecord(adItems[0]) ? adItems[0] : undefined;
  const adSnapId = firstAd ? nonEmptyId(firstAd.ad_snap_id) : undefined;
  const adForm = firstAd && isRecord(firstAd.ad_snap_form_data) ? firstAd.ad_snap_form_data : undefined;
  const snapMap = isRecord(data.new_ad_and_creative_snap_info_item_map) ? data.new_ad_and_creative_snap_info_item_map : undefined;
  const creativeItems = adSnapId && snapMap && Array.isArray(snapMap[adSnapId]) ? snapMap[adSnapId] : [];
  const firstCreative = isRecord(creativeItems[0]) ? creativeItems[0] : undefined;
  const creativeSnapId = firstCreative ? nonEmptyId(firstCreative.creative_snap_id) : undefined;
  const creativeForm = firstCreative && isRecord(firstCreative.asset_group_creative_snap_form_data) ? firstCreative.asset_group_creative_snap_form_data : undefined;
  const sketchMap = isRecord(data.new_ad_and_creative_sketch_ids_map) ? data.new_ad_and_creative_sketch_ids_map : undefined;
  const firstSketchEntry = sketchMap ? Object.entries(sketchMap)[0] : undefined;
  const adSketchId = firstSketchEntry ? nonEmptyId(firstSketchEntry[0]) : undefined;
  const creativeSketchIds = firstSketchEntry && Array.isArray(firstSketchEntry[1]) ? firstSketchEntry[1] : [];
  const creativeSketchId = nonEmptyId(creativeSketchIds[0]);
  if (!campaignSnapId || !campaignSketchId || !adSnapId || !adSketchId || !creativeSnapId || !creativeSketchId || !campaignForm || !adForm || !creativeForm) {
    throw new UnknownCreationStateError("TikTok 草稿初始化响应缺少系列、广告组或广告的 snap/sketch 标识。");
  }
  const publishItems = copiedPublishItems(adItems, snapMap, sketchMap);
  return {
    campaignSnapId, campaignSketchId, adSnapId, adSketchId,
    creativeSnapId, creativeSketchId, campaignForm, adForm, creativeForm,
    publishItems,
  };
}

function copiedPublishItems(
  adItems: Record<string, unknown>[],
  snapMap: Record<string, unknown> | undefined,
  sketchMap: Record<string, unknown> | undefined,
): DraftPublishItem[] {
  // TikTok's copy response exposes ad snap items and the ad-sketch map as
  // parallel ordered collections; it provides no shared identifier between
  // the two. Preserve response order exactly and reject any count mismatch.
  const sketchEntries = sketchMap ? Object.entries(sketchMap) : [];
  if (adItems.length === 0 || adItems.length !== sketchEntries.length) {
    throw new UnknownCreationStateError("TikTok 草稿初始化响应中的广告组 snap/sketch 数量不一致。");
  }
  return adItems.map((ad, adIndex) => {
    const adSnapId = nonEmptyId(ad.ad_snap_id);
    const sketchEntry = sketchEntries[adIndex];
    const adSketchId = sketchEntry ? nonEmptyId(sketchEntry[0]) : undefined;
    const creativeSketchIds = sketchEntry && Array.isArray(sketchEntry[1]) ? sketchEntry[1] : [];
    const creativeItems = adSnapId && snapMap && Array.isArray(snapMap[adSnapId])
      ? snapMap[adSnapId].filter(isRecord)
      : [];
    if (!adSnapId || !adSketchId || creativeItems.length === 0 || creativeItems.length !== creativeSketchIds.length) {
      throw new UnknownCreationStateError(`TikTok 草稿初始化响应中的第 ${adIndex + 1} 个广告组映射不完整。`);
    }
    const creatives = creativeItems.map((creative, creativeIndex) => {
      const creativeSnapId = nonEmptyId(creative.creative_snap_id);
      const creativeSketchId = nonEmptyId(creativeSketchIds[creativeIndex]);
      if (!creativeSnapId || !creativeSketchId) {
        throw new UnknownCreationStateError(`TikTok 草稿初始化响应中的第 ${adIndex + 1} 个广告组素材映射不完整。`);
      }
      return {
        creative_id: "",
        creative_snap_id: creativeSnapId,
        creative_sketch_id: creativeSketchId,
        need_publish: true as const,
      };
    });
    return {
      ad_id: "",
      ad_snap_id: adSnapId,
      ad_sketch_id: adSketchId,
      creative_snap_info_list: creatives,
      need_publish: true as const,
    };
  });
}

function applyCopiedDraftForms(
  drafts: { campaign: Record<string, unknown>; adGroup: Record<string, unknown>; creative: Record<string, unknown> },
  initialized: InitializedDraftIds,
  applyPresetOverrides: boolean,
  existingCampaignId?: string,
): void {
  const requestedCampaign = requireObjectField(drafts.campaign, "campaign_sketch_form_data");
  const requestedAd = requireObjectField(drafts.adGroup, "ad_sketch_form_data");
  const requestedCreatives = drafts.creative.asset_group_sketch_form_data_list;
  const requestedCreative = Array.isArray(requestedCreatives) && isRecord(requestedCreatives[0]) ? requestedCreatives[0] : undefined;
  if (!requestedCreative) throw new Error("创建模板缺少广告素材表单。");
  const campaignForm = { ...requestedCampaign, ...cloneRecord(initialized.campaignForm) };
  if (!existingCampaignId) campaignForm.campaign_name = requestedCampaign.campaign_name;
  if (applyPresetOverrides && !existingCampaignId) {
    copyDefinedFields(requestedCampaign, campaignForm, ["objective_type", "buying_type", "budget_mode", "budget"]);
  }
  campaignForm.campaign_id = existingCampaignId ?? "";
  campaignForm.campaign_snap_id = existingCampaignId ? "" : initialized.campaignSnapId;
  campaignForm.campaign_sketch_id = existingCampaignId ? "" : initialized.campaignSketchId;
  drafts.campaign.campaign_sketch_form_data = campaignForm;

  const adForm = cloneRecord(initialized.adForm);
  const adOverrideKeys = ["ad_name", "budget", "cpa_bid", "schedule_type", "start_time", "end_time"];
  if (applyPresetOverrides) {
    adOverrideKeys.push(
      "budget_mode", "pricing", "optimize_goal", "external_action", "ad_ref_pixel_id",
      "automated_targeting", "country", "platform",
    );
  }
  for (const key of adOverrideKeys) {
    if (requestedAd[key] !== undefined) adForm[key] = requestedAd[key];
  }
  if (applyPresetOverrides) {
    applyManualAdSetup(adForm);
  }
  // 复用现有系列时，非复制(创建)清空 origin_ad_id；但复制模式必须保留源广告的
  // origin_ad_id，否则 CTA/创意克隆找不到原始草稿（code 1000505023）。
  adForm.origin_ad_id = existingCampaignId && applyPresetOverrides ? 0 : initialized.adForm.origin_ad_id;
  adForm.ad_snap_id = initialized.adSnapId;
  adForm.ad_sketch_id = initialized.adSketchId;
  adForm.by_ad_sketch_id = initialized.adSketchId;
  drafts.adGroup.ad_sketch_form_data = adForm;

  const creativeOverrideKeys = ["creative_name", "external_url", "open_url"];
  if (applyPresetOverrides) {
    creativeOverrideKeys.push(
      "identity_type", "identity_id", "call_to_action_id", "is_comment_disable", "is_share_disable",
    );
  }
  // A single creative form cloned from the template copy. The draft chain then
  // overwrites its image_list with every resolved video (one ad-group, several
  // ads), so we only need one form here.
  const creativeForm = cloneRecord(initialized.creativeForm);
  for (const key of creativeOverrideKeys) {
    if (requestedCreative[key] !== undefined) creativeForm[key] = requestedCreative[key];
  }
  const requestedImages = requestedCreative.image_list;
  const images = creativeForm.image_list;
  if (!Array.isArray(requestedImages) || !isRecord(requestedImages[0]) || !Array.isArray(images) || !isRecord(images[0])) {
    throw new Error("TikTok 草稿初始化响应缺少视频素材结构。");
  }
  if (requestedImages[0].aweme_item_id !== "__COPY_SOURCE__") {
    images[0].aweme_item_id = requestedImages[0].aweme_item_id;
  }
  creativeForm.origin_creative_id = existingCampaignId ? 0 : initialized.creativeForm.origin_creative_id;
  creativeForm.creative_snap_id = initialized.creativeSnapId;
  creativeForm.creative_sketch_id = initialized.creativeSketchId;
  drafts.creative.asset_group_sketch_form_data_list = [creativeForm];
}

function applyManualAdSetup(adForm: Record<string, unknown>): void {
  // TikTok's Sales/Website flow keeps web_all_in_one_catalog=OPTIONAL at the
  // campaign level. Manual creation is selected by clearing catalog bindings
  // on the ad form, not by changing that campaign field or the page URL.
  adForm.creative_material_mode = 6;
  adForm.product_platform_id = "0";
  adForm.product_set_id = "";
  adForm.catalog_authorized_bc = "0";
  adForm.supply_catalog_id = "0";
  adForm.promotion_catalog_type = 0;
  adForm.product_specific_type = 0;
  adForm.budget_auto_adjust = { is_enabled: 0, initial_budget: "0" };
}

function copyDefinedFields(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key];
  }
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return decodeJsonStrings(JSON.parse(JSON.stringify(value))) as Record<string, unknown>;
}

function decodeJsonStrings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeJsonStrings);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeJsonStrings(item)]));
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
  try {
    return decodeJsonStrings(JSON.parse(trimmed));
  } catch {
    return value;
  }
}

function materializePublishProfile(
  template: Record<string, unknown>,
  ids: {
    campaignId?: string;
    campaignSnapId: string;
    campaignSketchId: string;
    publishItems: DraftPublishItem[];
    initialStatus: "enabled" | "disabled";
  },
): Record<string, unknown> {
  const body = JSON.parse(JSON.stringify(template)) as Record<string, unknown>;
  body.campaign_id = ids.campaignId ?? "";
  body.campaign_snap_id = ids.campaignSnapId;
  body.campaign_sketch_id = ids.campaignSketchId;
  Object.assign(body, TikTokCreationPublishSource);
  body.is_status_disabled = ids.initialStatus === "disabled";
  const ads = body.ad_and_creative_snap_info_list;
  if (!Array.isArray(ads) || !isRecord(ads[0])) throw new Error("发布模板缺少广告组草稿结构。");
  const adTemplate = ads[0];
  const creatives = adTemplate.creative_snap_info_list;
  if (!Array.isArray(creatives) || !isRecord(creatives[0])) throw new Error("发布模板缺少素材草稿结构。");
  const creativeTemplates = creatives.filter(isRecord);
  body.ad_and_creative_snap_info_list = ids.publishItems.map((item, adIndex) => {
    const sourceAd = isRecord(ads[adIndex]) ? ads[adIndex] : adTemplate;
    const sourceCreatives = Array.isArray(sourceAd.creative_snap_info_list)
      ? sourceAd.creative_snap_info_list.filter(isRecord)
      : creativeTemplates;
    return {
      ...sourceAd,
      ...item,
      creative_snap_info_list: item.creative_snap_info_list.map((creative, creativeIndex) => ({
        ...(sourceCreatives[creativeIndex] ?? creativeTemplates[0]),
        ...creative,
      })),
    };
  });
  return body;
}

interface CreationDispatchState {
  mutationDispatched: boolean;
  acceptedMutationCount: number;
  onBeforeMutationDispatch?: () => void;
}

interface CreationRequestBoundary {
  semantics?: "mutation" | "result-query" | "preflight-read" | "support";
  dispatchState?: CreationDispatchState;
}

async function requestCreationStep(
  step: string,
  createRequest: () => CapturedCookieRequest,
  credential: ParsedCookieCredential,
  boundary: CreationRequestBoundary = {},
): Promise<Record<string, unknown>> {
  let request: CapturedCookieRequest;
  try {
    request = createRequest();
    // Validate everything that can fail locally before fetch is invoked. A
    // failure here proves that no remote request was dispatched.
    new URL(request.url);
    if (request.method === "POST" && request.body === undefined) {
      throw new Error("POST 请求缺少请求体。");
    }
  } catch (cause) {
    throw withCreationStep(
      new RetryableCreationError(cause instanceof Error ? cause.message : "请求构造失败。"),
      step,
    );
  }

  try {
    return await requestDispatchedCreationJson(request, credential, boundary);
  } catch (cause) {
    if (
      cause instanceof ConfirmedCreationFailureError
      || cause instanceof UnknownCreationStateError
      || cause instanceof RetryableCreationError
    ) {
      throw withCreationStep(cause, step);
    }
    // The dispatched request helper is required to emit a structured error.
    // Treat an unexpected post-dispatch exception conservatively.
    throw withCreationStep(
      new UnknownCreationStateError(cause instanceof Error ? cause.message : "请求结果无法确认。"),
      step,
    );
  }
}

function withCreationStep<T extends Error>(cause: T, step: string): T {
  const message = `${step}：${cause.message}`;
  if (cause instanceof ConfirmedCreationFailureError) {
    return new ConfirmedCreationFailureError(message, cause.retrySafe) as unknown as T;
  }
  if (cause instanceof UnknownCreationStateError) {
    return new UnknownCreationStateError(message) as T;
  }
  return new RetryableCreationError(message) as T;
}

async function requestDispatchedCreationJson(
  request: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  boundary: CreationRequestBoundary,
): Promise<Record<string, unknown>> {
  let requestInit: RequestInit;
  try {
    const headers: Record<string, string> = {
      ...(request.headers ?? {}),
      accept: "application/json, text/plain, */*",
      cookie: credential.cookie,
    };
    if (credential.csrfToken) headers[credential.csrfHeaderName] = credential.csrfToken;
    if (credential.userAgent) headers["user-agent"] = credential.userAgent;
    if (request.contentType) headers["content-type"] = request.contentType;
    requestInit = {
      method: request.method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    };
    if (request.method === "POST" && request.body !== undefined) requestInit.body = request.body;
  } catch (cause) {
    throw new RetryableCreationError(
      cause instanceof Error ? cause.message : "请求参数初始化失败。",
    );
  }

  let pending: Promise<Response>;
  try {
    if (
      boundary.semantics === "mutation"
      && boundary.dispatchState
      && !boundary.dispatchState.mutationDispatched
    ) {
      // Persist the idempotency guard at the narrowest safe boundary: request
      // construction and credential checks already succeeded, but fetch has
      // not yet been invoked. If this callback fails, no remote request is sent.
      boundary.dispatchState.onBeforeMutationDispatch?.();
    }
    // A synchronous exception proves fetch did not accept the request.
    pending = fetch(request.url, requestInit);
    if (boundary.semantics === "mutation" && boundary.dispatchState) {
      boundary.dispatchState.mutationDispatched = true;
    }
  } catch (cause) {
    throw new RetryableCreationError(
      cause instanceof Error ? cause.message : "请求未能发送。",
    );
  }

  let response: Response;
  try {
    // Once fetch returns a promise, transport rejection cannot prove whether
    // TikTok received the request.
    response = await pending;
  } catch (cause) {
    throw uncertainCreationRequestError(
      cause instanceof Error ? cause.message : "请求已发送，但响应丢失。",
      boundary,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw uncertainCreationRequestError(
      `已收到无法确认受理结果的响应（HTTP ${response.status}）。`,
      boundary,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw uncertainCreationRequestError(
      cause instanceof Error ? cause.message : "响应 JSON 解析失败。",
      boundary,
    );
  }
  if (!isRecord(payload) || typeof payload.code !== "number") {
    throw uncertainCreationRequestError("TikTok 响应结构不完整，无法确认请求是否受理。", boundary);
  }
  if (payload.code !== 0) {
    const providerMessage = typeof payload.msg === "string"
      ? sanitizeProviderMessage(payload.msg)
      : typeof payload.message === "string"
        ? sanitizeProviderMessage(payload.message)
        : "未提供错误说明";
    const message = `TikTok 接口明确拒绝（code ${payload.code}）：${providerMessage}`;
    if (boundary.semantics === "result-query") {
      throw new UnknownCreationStateError(
        `${message}；该拒绝仅针对结果查询，不能证明原创建任务失败。`,
      );
    }
    throw new ConfirmedCreationFailureError(message);
  }
  if (!response.ok) {
    throw uncertainCreationRequestError(
      `TikTok 响应状态与结构化结果冲突（HTTP ${response.status}，code 0）。`,
      boundary,
    );
  }
  if (boundary.semantics === "mutation" && boundary.dispatchState) {
    boundary.dispatchState.acceptedMutationCount += 1;
  }
  return payload;
}

function uncertainCreationRequestError(
  message: string,
  boundary: CreationRequestBoundary,
): RetryableCreationError | UnknownCreationStateError {
  if (
    boundary.semantics === "preflight-read"
    && !boundary.dispatchState?.mutationDispatched
  ) {
    return new RetryableCreationError(message);
  }
  return new UnknownCreationStateError(message);
}

function creationRequest(
  sessionRequest: CapturedCookieRequest,
  step: "campaign_snap/save" | "ad_snap/save" | "creative_snap/save" | "async_creation/create_by_snap",
  body: unknown,
): CapturedCookieRequest {
  const base = deriveTikTokCreationRequest(sessionRequest, step);
  return {
    target: "health",
    url: base.url,
    method: "POST",
    body: JSON.stringify(body),
    contentType: "application/json",
    ...(base.headers ? { headers: base.headers } : {}),
  };
}

function creationPathRequest(
  sessionRequest: CapturedCookieRequest,
  pathname: string,
  body: unknown,
): CapturedCookieRequest {
  const url = new URL(sessionRequest.url);
  url.pathname = pathname;
  return {
    target: "health",
    url: url.toString(),
    method: "POST",
    body: JSON.stringify(body),
    contentType: "application/json",
    ...(sessionRequest.headers ? { headers: sessionRequest.headers } : {}),
  };
}

function creationPathGetRequest(
  sessionRequest: CapturedCookieRequest,
  pathname: string,
  query: Record<string, string>,
): CapturedCookieRequest {
  const url = new URL(sessionRequest.url);
  url.pathname = pathname;
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return {
    target: "health",
    url: url.toString(),
    method: "GET",
    ...(sessionRequest.headers ? { headers: sessionRequest.headers } : {}),
  };
}

function creationDetailRequest(
  sessionRequest: CapturedCookieRequest,
  asyncRequestId: string,
): CapturedCookieRequest {
  const url = new URL(sessionRequest.url);
  url.pathname = "/api/v4/i18n/creation/async_creation/detail/";
  url.searchParams.set("async_request_id", asyncRequestId);
  return {
    target: "health",
    url: url.toString(),
    method: "GET",
    ...(sessionRequest.headers ? { headers: sessionRequest.headers } : {}),
  };
}

function requiredResponseId(payload: Record<string, unknown>, key: string): string {
  const value = responseId(payload, key);
  if (!value) {
    const candidates = responseIdKeys(payload).slice(0, 30).join(", ");
    throw new UnknownCreationStateError(`TikTok 返回中缺少 ${key}，已停止后续发布。可用字段：${candidates || "无"}`);
  }
  return value;
}

function responseIdKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => responseIdKeys(item, `${prefix}[]`));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [/(?:id|snap|sketch)$/i.test(key) ? path : "", ...responseIdKeys(item, path)].filter(Boolean);
  });
}

function responseId(value: unknown, key: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = responseId(item, key);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const direct = value[key];
  const id = Array.isArray(direct)
    ? direct.map(nonEmptyId).find((candidate): candidate is string => Boolean(candidate))
    : nonEmptyId(direct);
  if (id) return id;
  for (const nested of Object.values(value)) {
    const found = responseId(nested, key);
    if (found) return found;
  }
  return undefined;
}

function nonEmptyId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function requireObjectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (!isRecord(field)) throw new Error(`创建模板缺少 ${key}。`);
  return field;
}



async function requestCookieJson(
  request: CapturedCookieRequest,
  credential: ParsedCookieCredential,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    ...(request.headers ?? {}),
    accept: "application/json, text/plain, */*",
    cookie: credential.cookie,
  };
  if (credential.csrfToken) {
    headers[credential.csrfHeaderName] = credential.csrfToken;
  }
  if (credential.userAgent) headers["user-agent"] = credential.userAgent;
  if (request.contentType) headers["content-type"] = request.contentType;

  const requestInit: RequestInit = {
    method: request.method,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  };
  if (request.method === "POST" && request.body !== undefined) {
    requestInit.body = request.body;
  }
  const response = await fetch(request.url, requestInit);
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("json")) {
    throw new Error(`Cookie 请求验证失败（HTTP ${response.status}）。`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  if (typeof payload.code === "number" && payload.code !== 0) {
    const providerMessage = typeof payload.msg === "string"
      ? sanitizeProviderMessage(payload.msg)
      : typeof payload.message === "string"
        ? sanitizeProviderMessage(payload.message)
        : "未提供错误说明";
      throw new RetryableCreationError(`TikTok 接口失败（code ${payload.code}）：${providerMessage}`);
  }
  return payload;
}

function sanitizeProviderMessage(message: string): string {
  return message
    .slice(0, 300)
    .replace(/https?:\/\/\S+/gi, "[URL 已隐藏]")
    .replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{24,}\b/gi, "[敏感值已隐藏]")
    .replace(/\b(cookie|token|signature|session|csrf)\s*[:=]\s*[^\s,;]+/gi, "$1=[敏感值已隐藏]");
}

function materializeStatusRequest(
  template: CapturedCookieRequest,
  mutation: StatusMutation,
): CapturedCookieRequest {
  const url = new URL(template.url);
  let replacements = 0;
  for (const key of [...url.searchParams.keys()]) {
    if (isEntityIdKey(mutation.entityType, key)) {
      url.searchParams.set(key, mutation.externalId);
      replacements += 1;
    }
  }

  let body = template.body;
  if (body) {
    const contentType = template.contentType?.toLowerCase() ?? "";
    if (isMultipartBody(contentType, body)) {
      const replaced = rewriteMultipartFields(body, (field) => {
        if (
          !isMultipartEntityListKey(
            mutation.entityType,
            field.name,
            url.pathname,
          )
        ) {
          return undefined;
        }
        return {
          value: replaceMultipartEntityList(field.value, mutation.externalId),
        };
      });
      replacements += replaced.changes;
      body = replaced.body;
    } else if (contentType.includes("json") || body.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(body) as unknown;
        const replaced = replaceEntityIds(parsed, mutation);
        replacements += replaced.count;
        body = JSON.stringify(replaced.value);
      } catch {
        throw new Error("状态 cURL 的 JSON 请求体无法解析，请重新导入。");
      }
    } else {
      const params = new URLSearchParams(body);
      for (const key of [...params.keys()]) {
        if (isEntityIdKey(mutation.entityType, key)) {
          params.set(key, mutation.externalId);
          replacements += 1;
        }
      }
      body = params.toString();
    }
  }

  if (replacements === 0) {
    throw new Error("状态 cURL 中未找到可替换的广告对象 ID。");
  }
  return { ...template, url: url.toString(), body };
}

function completedAdGroupIds(payload: Record<string, unknown>): string[] {
  const data = isRecord(payload.data) ? payload.data : payload;
  const result = isRecord(data.result) ? data.result : data;
  const ads = isRecord(result.ad_and_creative)
    ? Object.values(result.ad_and_creative)
    : Array.isArray(result.ad_and_creative) ? result.ad_and_creative : [];
  return [...new Set(ads.flatMap((ad) => {
    if (!isRecord(ad)) return [];
    const id = nonEmptyId(ad.adgroup_id)
      ?? nonEmptyId(ad.ad_group_id)
      ?? nonEmptyId(ad.ad_id);
    return id ? [id] : [];
  }))];
}

function materializeDeletionRequest(
  template: CapturedCookieRequest,
  externalId: string,
): CapturedCookieRequest {
  const materialized = materializeStatusRequest(template, {
    entityType: "ad-group",
    externalId,
    action: "disable",
  });
  const url = new URL(materialized.url);
  let replacements = 0;
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === "operation_status") {
      url.searchParams.set(key, "DELETE");
      replacements += 1;
    }
  }
  let body = materialized.body;
  if (body) {
    const contentType = materialized.contentType?.toLowerCase() ?? "";
    if (isMultipartBody(contentType, body)) {
      const replaced = rewriteMultipartFields(body, (field) =>
        field.name.toLowerCase() === "operation_status"
          ? { value: "DELETE" }
          : undefined,
      );
      replacements += replaced.changes;
      body = replaced.body;
    } else if (contentType.includes("json") || body.trim().startsWith("{")) {
      const parsed = JSON.parse(body) as unknown;
      const replaced = replaceOperationStatus(parsed, "DELETE");
      replacements += replaced.count;
      body = JSON.stringify(replaced.value);
    } else {
      const params = new URLSearchParams(body);
      for (const key of [...params.keys()]) {
        if (key.toLowerCase() === "operation_status") {
          params.set(key, "DELETE");
          replacements += 1;
        }
      }
      body = params.toString();
    }
  }
  if (replacements === 0) {
    throw new Error("广告组关闭 cURL 中未找到 operation_status，无法安全派生删除请求。");
  }
  return { ...materialized, url: url.toString(), body };
}

function replaceOperationStatus(
  value: unknown,
  operationStatus: string,
): { value: unknown; count: number } {
  if (Array.isArray(value)) {
    let count = 0;
    const output = value.map((item) => {
      const replaced = replaceOperationStatus(item, operationStatus);
      count += replaced.count;
      return replaced.value;
    });
    return { value: output, count };
  }
  if (!isRecord(value)) return { value, count: 0 };
  let count = 0;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase() === "operation_status") {
      output[key] = operationStatus;
      count += 1;
      continue;
    }
    const replaced = replaceOperationStatus(item, operationStatus);
    output[key] = replaced.value;
    count += replaced.count;
  }
  return { value: output, count };
}

function replaceEntityIds(
  value: unknown,
  mutation: StatusMutation,
): { value: unknown; count: number } {
  if (Array.isArray(value)) {
    let count = 0;
    const output = value.map((item) => {
      const replaced = replaceEntityIds(item, mutation);
      count += replaced.count;
      return replaced.value;
    });
    return { value: output, count };
  }
  if (!isRecord(value)) return { value, count: 0 };

  let count = 0;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isEntityIdKey(mutation.entityType, key)) {
      count += 1;
      output[key] = Array.isArray(item)
        ? [mutation.externalId]
        : typeof item === "number"
          ? Number(mutation.externalId)
          : mutation.externalId;
      continue;
    }
    const replaced = replaceEntityIds(item, mutation);
    count += replaced.count;
    output[key] = replaced.value;
  }
  return { value: output, count };
}

function isEntityIdKey(entityType: SyncEntityType, key: string): boolean {
  const normalized = key.toLowerCase();
  const keys: Record<SyncEntityType, string[]> = {
    campaign: ["campaign_id", "campaign_ids"],
    "ad-group": [
      "adgroup_id",
      "adgroup_ids",
      "ad_group_id",
      "ad_group_ids",
      "ad_id",
      "ad_ids",
    ],
    ad: ["ad_id", "ad_ids", "creative_id", "creative_ids"],
  };
  return keys[entityType].includes(normalized);
}

function isMultipartEntityListKey(
  entityType: SyncEntityType,
  key: string,
  pathname: string,
): boolean {
  const normalized = key.toLowerCase();
  const isOverture = pathname.toLowerCase().includes("/overture/");
  const keys: Record<SyncEntityType, string[]> = {
    campaign: ["campaign_list"],
    "ad-group": isOverture
      ? ["ad_list"]
      : ["adgroup_list", "ad_group_list"],
    ad: isOverture
      ? ["creative_list", "aco_creative_list"]
      : ["ad_list"],
  };
  return keys[entityType].includes(normalized);
}

function replaceMultipartEntityList(value: string, externalId: string): string {
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return JSON.stringify([externalId]);
    }
  } catch {
    // Some TikTok variants send a plain identifier instead of a JSON array.
  }
  return externalId;
}

function legacyRequest(url: string): CapturedCookieRequest | undefined {
  return url
    ? { target: "health", url, method: "GET" }
    : undefined;
}

function buildReusableAppealRequest(
  sessionRequest: CapturedCookieRequest,
  advertiserId: string,
  mutation: import("./types.js").AppealMutation,
): CapturedCookieRequest {
  const url = new URL(sessionRequest.url);
  url.pathname = "/api/v4/i18n/creation/audit/appeal_creative/";
  url.searchParams.set("aadvid", advertiserId);
  return {
    target: "appeal",
    url: url.toString(),
    method: "POST",
    contentType: "application/json",
    headers: sessionRequest.headers,
    derived: true,
    body: JSON.stringify({
      ad_id: mutation.externalId,
      creative_id: mutation.creativeId,
      appeal_reason: mutation.reason,
      appeal_reason_type: 1,
      attachment_list: [],
    }),
  };
}

function deriveFinalAdReadRequest(
  request: CapturedCookieRequest | undefined,
): CapturedCookieRequest | undefined {
  if (!request) return undefined;
  const url = new URL(request.url);
  // The two-step Cookie onboarding captures the statistics ad-group list.
  // The matching final-ad list for that endpoint family is ad/list.
  if (!url.pathname.toLowerCase().includes("/statistics/op/")) return undefined;
  const pathname = url.pathname.replace(
    /\/adgroup\/list(?=\/|$)/i,
    "/ad/list",
  );
  if (pathname === url.pathname) return undefined;
  url.pathname = pathname;
  return { ...request, target: "ad", url: url.toString(), derived: true };
}

function extractEntities(
  payload: Record<string, unknown>,
  entityType: SyncEntityType,
): ProviderEntity[] {
  const data = isRecord(payload.data) ? payload.data : payload;
  const typeKeys: Record<SyncEntityType, string[]> = {
    campaign: ["campaigns", "campaign_list", "table", "list", "items"],
    "ad-group": ["adgroups", "ad_groups", "adgroup_list", "table", "list", "items"],
    ad: ["ads", "ad_list", "table", "list", "items"],
  };
  let list: unknown[] = [];
  for (const key of typeKeys[entityType]) {
    if (Array.isArray(data[key])) {
      list = data[key];
      break;
    }
  }
  return list.flatMap((item) => {
    if (!isRecord(item)) return [];
    // 列表统计接口可能把字段放在 stat_data 内。两级系列（universal_type:1）
    // 返回的 creative_id="0" 只是占位，ad_id 又等于广告组 ID；这类行不是
    // 可单独启停的最终广告，不能把它重复保存成 ad 实体。
    const statData = isRecord(item.stat_data) ? item.stat_data : {};
    const lookup = (key: string): unknown => item[key] ?? statData[key];
    if (
      entityType === "ad" &&
      Number(lookup("universal_type")) === 1 &&
      String(lookup("creative_id") ?? lookup("creativeId") ?? "").trim() === "0"
    ) {
      return [];
    }
    const idKeys: Record<SyncEntityType, string[]> = {
      campaign: ["campaign_id", "campaignId", "id"],
      "ad-group": ["adgroup_id", "ad_group_id", "adGroupId", "ad_id", "id"],
      ad: ["creative_id", "creativeId", "ad_id", "adId", "id"],
    };
    const id = idKeys[entityType].map(lookup).find(isStableExternalId);
    if (id === undefined) return [];
    // 两级系列里广告即广告组：回填 campaign_id / adgroup_id 到 payload，
    // 缺 adgroup_id 时用 ad_id 兜底，供父子关系解析与复制定位使用。
    const payload = entityType === "ad"
      ? {
          ...item,
          campaign_id: lookup("campaign_id") ?? item.campaign_id,
          adgroup_id:
            item.adgroup_id ?? item.ad_group_id ?? statData.adgroup_id ?? id,
        }
      : item;
    return [{ entityType, externalId: String(id), payload }];
  });
}

function hasRecognizedEntityList(
  payload: Record<string, unknown>,
  entityType: SyncEntityType,
): boolean {
  const data = isRecord(payload.data) ? payload.data : payload;
  const typeKeys: Record<SyncEntityType, string[]> = {
    campaign: ["campaigns", "campaign_list", "table", "list", "items"],
    "ad-group": ["adgroups", "ad_groups", "adgroup_list", "table", "list", "items"],
    ad: ["ads", "ad_list", "table", "list", "items"],
  };
  const list = typeKeys[entityType]
    .map((key) => data[key])
    .find(Array.isArray);
  if (!list) return false;
  const idKeys: Record<SyncEntityType, string[]> = {
    campaign: ["campaign_id", "campaignId", "id"],
    "ad-group": ["adgroup_id", "ad_group_id", "adGroupId", "ad_id", "id"],
    ad: ["creative_id", "creativeId", "ad_id", "adId", "id"],
  };
  return list.every((item) =>
    isRecord(item) && idKeys[entityType].some((key) => {
      const value = item[key];
      return isStableExternalId(value);
    }),
  );
}

function isStableExternalId(value: unknown): value is string | number {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

async function requestCompleteListPages(
  step: "campaign/list" | "adgroup/list",
  template: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  dispatchState: CreationDispatchState,
): Promise<Record<string, unknown>[]> {
  const pages: Record<string, unknown>[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const payload = await requestCreationStep(
      `${step} 第 ${page} 页`,
      () => page === 1 ? template : withRequestedPage(template, page),
      credential,
      { semantics: "preflight-read", dispatchState },
    );
    assertListPreflight(payload, step);
    const responsePage = responsePageNumber(payload);
    if (responsePage !== null && responsePage !== page) {
      throw new RetryableCreationError(`${step} 未返回请求的第 ${page} 页，无法安全判断同名对象。`);
    }
    pages.push(payload);
    if (hasExplicitAdditionalPages(payload)) continue;
    if (!hasExplicitPaginationEnd(payload)) {
      throw new RetryableCreationError(`${step} 缺少可验证的分页结束信息，无法安全判断同名对象。`);
    }
    return pages;
  }
  throw new RetryableCreationError(`${step} 超过 100 页，无法在创建前完成安全查重。`);
}

function withRequestedPage(template: CapturedCookieRequest, page: number): CapturedCookieRequest {
  const url = new URL(template.url);
  let replaced = false;
  for (const key of ["page", "page_num", "pageNum", "page_index", "pageIndex"]) {
    if (!url.searchParams.has(key)) continue;
    url.searchParams.set(key, String(page));
    replaced = true;
  }
  let body = template.body;
  const contentType = template.contentType?.toLowerCase() ?? "";
  if (body && (contentType.includes("json") || body.trim().startsWith("{"))) {
    const parsed = JSON.parse(body) as unknown;
    const rewritten = rewritePageValue(parsed, page);
    body = JSON.stringify(rewritten.value);
    replaced ||= rewritten.changed;
  } else if (body && contentType.includes("application/x-www-form-urlencoded")) {
    const fields = new URLSearchParams(body);
    for (const key of ["page", "page_num", "pageNum", "page_index", "pageIndex"]) {
      if (!fields.has(key)) continue;
      fields.set(key, String(page));
      replaced = true;
    }
    body = fields.toString();
  }
  if (!replaced) url.searchParams.set("page", String(page));
  return { ...template, url: url.toString(), body };
}

function siblingListRequest(
  template: CapturedCookieRequest,
  target: "campaign" | "ad-group",
): CapturedCookieRequest {
  const url = new URL(template.url);
  const segment = target === "campaign" ? "campaign" : "adgroup";
  url.pathname = url.pathname.replace(
    /\/(campaign|adgroup)\/list(?=\/|$)/i,
    `/${segment}/list`,
  );
  return { ...template, target, derived: true, url: url.toString() };
}

/** Runs a browser-side helper/check call in the captured HAR order without
 * turning its page-level result into an ad-creation outcome. The authoritative
 * result comes from draft saves and async_creation/create_by_snap + detail. */
async function requestAdvisoryCreationStep(
  step: string,
  createRequest: () => CapturedCookieRequest,
  credential: ParsedCookieCredential,
  boundary: CreationRequestBoundary = {},
): Promise<Record<string, unknown> | undefined> {
  try {
    return await requestCreationStep(step, createRequest, credential, boundary);
  } catch {
    return undefined;
  }
}

/** Campaign existence is independent from ad/report rows. The imported
 * ad-group request keeps the valid account/session query, while the body must
 * use the campaign object dimension captured in the verified HAR. */
function campaignObjectListRequest(
  template: CapturedCookieRequest,
): CapturedCookieRequest {
  return campaignStatisticsListRequest(template, false);
}

function campaignMetricsListRequest(
  template: CapturedCookieRequest,
): CapturedCookieRequest {
  return campaignStatisticsListRequest(template, true);
}

function campaignStatisticsListRequest(
  template: CapturedCookieRequest,
  includeMetrics: boolean,
): CapturedCookieRequest {
  const url = new URL(template.url);
  url.pathname = url.pathname.replace(
    /\/(campaign|adgroup)\/list(?=\/|$)/i,
    "/campaign/list",
  );
  let body = template.body;
  if (body && template.contentType?.toLowerCase().includes("json")) {
    try {
      const value = JSON.parse(body) as unknown;
      if (isRecord(value)) {
        const commonRequest = isRecord(value.common_req) ? value.common_req : {};
        commonRequest.dimensions = ["campaign_id"];
        if (!includeMetrics) commonRequest.metrics = [];
        commonRequest.filters = [
          { field: "campaign_status", in_field_values: ["delete"], filter_type: 10 },
          { field: "campaign_system_origin", in_field_values: ["100000"], filter_type: 0 },
        ];
        commonRequest.lifetime = 0;
        commonRequest.page = 1;
        commonRequest.page_size = 100;
        value.common_req = commonRequest;
        body = JSON.stringify(value);
      }
    } catch {
      // The normal list preflight will reject an unrecognized body/response
      // before any creation mutation is sent.
    }
  }
  return {
    ...template,
    target: "campaign",
    derived: true,
    url: url.toString(),
    body,
  };
}

function rewritePageValue(value: unknown, page: number): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map((item) => {
      const rewritten = rewritePageValue(item, page);
      changed ||= rewritten.changed;
      return rewritten.value;
    });
    return { value: output, changed };
  }
  if (!isRecord(value)) return { value, changed: false };
  let changed = false;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (["page", "page_num", "pageNum", "page_index", "pageIndex"].includes(key)) {
      output[key] = page;
      changed = true;
    } else {
      const rewritten = rewritePageValue(item, page);
      output[key] = rewritten.value;
      changed ||= rewritten.changed;
    }
  }
  return { value: output, changed };
}

function responsePageNumber(payload: Record<string, unknown>): number | null {
  const data = isRecord(payload.data) ? payload.data : payload;
  const pageInfo = isRecord(data.page_info)
    ? data.page_info
    : isRecord(data.pageInfo) ? data.pageInfo : isRecord(data.pagination) ? data.pagination : {};
  const value = pageInfo.page ?? pageInfo.current_page ?? pageInfo.currentPage;
  const page = Number(value);
  return value !== undefined && Number.isInteger(page) ? page : null;
}

async function requestAllCookieListPages(
  template: CapturedCookieRequest,
  credential: ParsedCookieCredential,
): Promise<{ pages: Record<string, unknown>[]; complete: boolean }> {
  const requestedPage = readRequestedPage(template);
  if (requestedPage !== null && requestedPage !== 1) {
    return {
      pages: [await requestCookieJson(template, credential)],
      complete: false,
    };
  }
  const pages: Record<string, unknown>[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const request = page === 1 ? template : withRequestedPage(template, page);
    const payload = await requestCookieJson(request, credential);
    const responsePage = responsePageNumber(payload);
    if (responsePage !== null && responsePage !== page) {
      pages.push(payload);
      return { pages, complete: false };
    }
    pages.push(payload);
    if (hasExplicitAdditionalPages(payload)) continue;
    return { pages, complete: hasExplicitPaginationEnd(payload) };
  }
  return { pages, complete: false };
}

function isCookiePaginationComplete(
  payload: Record<string, unknown>,
  request: CapturedCookieRequest,
): boolean {
  const data = isRecord(payload.data) ? payload.data : payload;
  const pageInfo = isRecord(data.page_info)
    ? data.page_info
    : isRecord(data.pageInfo)
      ? data.pageInfo
      : isRecord(data.pagination)
        ? data.pagination
        : {};
  const requestedPage = readRequestedPage(request);
  if (requestedPage !== 1) return false;
  const currentRaw = pageInfo.page ?? pageInfo.current_page ?? pageInfo.currentPage;
  const totalRaw = pageInfo.total_page ?? pageInfo.totalPage ?? pageInfo.page_count ?? pageInfo.pageCount;
  if (currentRaw !== undefined && totalRaw !== undefined) {
    const current = Number(currentRaw);
    const total = Number(totalRaw);
    return Number.isInteger(current) && Number.isInteger(total) && current === 1 && total === 1;
  }
  const hasMore = data.has_more ?? data.hasMore ?? pageInfo.has_more ?? pageInfo.hasMore;
  if (hasMore === true || hasMore === 1 || hasMore === "1") return false;
  if (hasMore === false || hasMore === 0 || hasMore === "0") return true;
  return false;
}

function hasExplicitAdditionalPages(payload: Record<string, unknown>): boolean {
  const data = isRecord(payload.data) ? payload.data : payload;
  const pageInfo = isRecord(data.page_info)
    ? data.page_info
    : isRecord(data.pageInfo) ? data.pageInfo : isRecord(data.pagination) ? data.pagination : {};
  const current = Number(pageInfo.page ?? pageInfo.current_page ?? pageInfo.currentPage);
  const total = Number(pageInfo.total_page ?? pageInfo.totalPage ?? pageInfo.page_count ?? pageInfo.pageCount);
  if (Number.isInteger(current) && Number.isInteger(total) && total > current) return true;
  const hasMore = data.has_more ?? data.hasMore ?? pageInfo.has_more ?? pageInfo.hasMore;
  return hasMore === true || hasMore === 1 || hasMore === "1";
}

function hasExplicitPaginationEnd(payload: Record<string, unknown>): boolean {
  const data = isRecord(payload.data) ? payload.data : payload;
  const pageInfo = isRecord(data.page_info)
    ? data.page_info
    : isRecord(data.pageInfo) ? data.pageInfo : isRecord(data.pagination) ? data.pagination : {};
  const current = Number(pageInfo.page ?? pageInfo.current_page ?? pageInfo.currentPage);
  const total = Number(pageInfo.total_page ?? pageInfo.totalPage ?? pageInfo.page_count ?? pageInfo.pageCount);
  if (Number.isInteger(current) && Number.isInteger(total) && current >= 1 && total >= 1 && current >= total) return true;
  const hasMore = data.has_more ?? data.hasMore ?? pageInfo.has_more ?? pageInfo.hasMore;
  return hasMore === false || hasMore === 0 || hasMore === "0";
}

function readRequestedPage(request: CapturedCookieRequest): number | null {
  const url = new URL(request.url);
  for (const key of ["page", "page_num", "pageNum", "page_index", "pageIndex"]) {
    if (!url.searchParams.has(key)) continue;
    const value = Number(url.searchParams.get(key));
    return Number.isInteger(value) ? value : null;
  }
  const contentType = request.contentType?.toLowerCase() ?? "";
  if (request.body && contentType.includes("json")) {
    try {
      const body = JSON.parse(request.body) as unknown;
      const found = findJsonPage(body);
      if (found !== null) return found;
    } catch {
      return null;
    }
  }
  if (request.body && contentType.includes("application/x-www-form-urlencoded")) {
    const fields = new URLSearchParams(request.body);
    for (const key of ["page", "page_num", "pageNum", "page_index", "pageIndex"]) {
      if (!fields.has(key)) continue;
      const value = Number(fields.get(key));
      return Number.isInteger(value) ? value : null;
    }
  }
  if (request.body && isMultipartBody(request.contentType, request.body)) {
    const pageField = parseMultipartFields(request.body).find((field) =>
      ["page", "page_num", "pagenum", "page_index", "pageindex"].includes(
        field.name.toLowerCase(),
      ),
    );
    if (pageField) {
      const value = Number(pageField.value.trim());
      return Number.isInteger(value) ? value : null;
    }
  }
  return 1;
}

function findJsonPage(value: unknown): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonPage(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    if (["page", "page_num", "pageNum", "page_index", "pageIndex"].includes(key)) {
      const page = Number(item);
      return Number.isInteger(page) ? page : null;
    }
    const found = findJsonPage(item);
    if (found !== null) return found;
  }
  return null;
}

function assertListPreflight(
  payload: Record<string, unknown>,
  step: "campaign/list" | "adgroup/list",
): void {
  const data = isRecord(payload.data) ? payload.data : undefined;
  const listKeys = step === "campaign/list"
    ? ["campaigns", "campaign_list", "table", "list", "items"]
    : ["adgroups", "ad_groups", "adgroup_list", "table", "list", "items"];
  if (!data || !listKeys.some((key) => Array.isArray(data[key]))) {
    throw new RetryableCreationError(
      `${step} 预检响应缺少可识别的列表结构，尚未发送任何创建请求。`,
    );
  }
}

function dedupeEntities(entities: ProviderEntity[]): ProviderEntity[] {
  const unique = new Map<string, ProviderEntity>();
  for (const entity of entities) {
    const key = `${entity.entityType}:${entity.externalId}`;
    if (!unique.has(key)) unique.set(key, entity);
  }
  return [...unique.values()];
}

function countEntities(
  entities: ProviderEntity[],
): Record<SyncEntityType, number> {
  const counts: Record<SyncEntityType, number> = {
    campaign: 0,
    "ad-group": 0,
    ad: 0,
  };
  for (const entity of entities) counts[entity.entityType] += 1;
  return counts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
