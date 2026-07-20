import {
  CookieConnectionSettingsSchema,
  CookieCredentialInputSchema,
  buildDraftPayloads,
  buildProfileDraftPayloads,
  buildPublishInput,
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
]);

const COOKIE_SYNC_CONTRACT_VERSION = "cookie-statistics-v4-2026-07";

type ParsedCookieCredential = ReturnType<
  typeof CookieCredentialInputSchema.parse
>;

export class CookieAdsProvider implements AdsProvider {
  readonly kind = "cookie" as const;
  readonly displayName = "Cookie 会话";
  readonly capabilityVersion = "cookie-capabilities-v2-2026-07";
  readonly capabilities = capabilities;

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
        (entityType === "ad"
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
      const todayRequest = withTodayMetricWindow(
        request,
        context.timezone ?? "UTC",
        new Date(),
      );
      if (!hasExplicitMetricWindow(todayRequest)) {
        coverageKnown = false;
        partialFailures.push(`${entityType}:coverage-unknown`);
      }
      let payload: Record<string, unknown>;
      try {
        payload = await requestCookieJson(todayRequest, credential);
      } catch (cause) {
        if (!request.derived) throw cause;
        warnings.push(
          `${entityType} 自动补全请求失败；如需该层级数据，请补充一条真实列表 cURL。`,
        );
        partialFailures.push(`${entityType}:derived-request-failed`);
        continue;
      }
      contractValid &&= hasRecognizedEntityList(payload, entityType);
      paginationComplete &&= isCookiePaginationComplete(payload, todayRequest);
      const extracted = extractEntities(payload, entityType);
      entities.push(...extracted);
      if (entityType === "ad-group") {
        entities.push(...extractEntities(payload, "campaign"));
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
    const date = formatDateInTimezone(new Date(), timezone);
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
            startDate: coverageKnown ? date : "",
            endDate: coverageKnown ? date : "",
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
    const results: CreationMutationResult[] = [];
    for (const mutation of mutations) {
      try {
        results.push(await createCookieDraftChain(sessionRequest, credential, mutation, context.timezone ?? "UTC"));
      } catch (cause) {
        results.push({
          ...mutation,
          ok: false,
          failureKind: cause instanceof UnknownCreationStateError
            ? "unknown"
            : "retryable",
          message: cause instanceof Error ? cause.message : "TikTok 创建请求失败。",
        });
      }
    }
    return results;
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
}

function hasNonEmptyOriginReference(
  profile: NonNullable<ParsedCookieCredential["creationProfile"]>,
): boolean {
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (!isRecord(value)) return false;
    return Object.entries(value).some(([key, item]) =>
      (key.startsWith("origin_") && nonEmptyId(item) !== undefined) || visit(item),
    );
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
  const date = formatDateInTimezone(now, timezone);
  let changed = false;
  const url = new URL(request.url);
  const isStatisticsRequest = url.pathname.includes("/statistics/");
  const urlDateKeys = isStatisticsRequest
    ? ["start_date", "end_date", "startDate", "endDate", "st", "et"]
    : ["start_date", "end_date", "startDate", "endDate"];
  for (const key of urlDateKeys) {
    if (!url.searchParams.has(key)) continue;
    url.searchParams.set(key, date);
    changed = true;
  }

  let body = request.body;
  if (body && request.contentType?.toLowerCase().includes("json")) {
    try {
      const value = JSON.parse(body) as unknown;
      changed = rewriteJsonDateWindow(value, date) || changed;
      if (isStatisticsRequest) {
        changed = rewriteStatisticsCommonRequest(value, date) || changed;
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

function rewriteJsonDateWindow(value: unknown, date: string): boolean {
  if (Array.isArray(value)) {
    let changed = false;
    for (const item of value) changed = rewriteJsonDateWindow(item, date) || changed;
    return changed;
  }
  if (!isRecord(value)) return false;
  let changed = false;
  for (const [key, item] of Object.entries(value)) {
    if (["start_date", "end_date", "startDate", "endDate"].includes(key)) {
      value[key] = date;
      changed = true;
    } else if (isRecord(item) || Array.isArray(item)) {
      changed = rewriteJsonDateWindow(item, date) || changed;
    }
  }
  return changed;
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
  credential: ParsedCookieCredential,
  mutation: CreationMutation,
  timezone: string,
): Promise<CreationMutationResult> {
  const dispatchState = { mutationDispatched: false };
  try {
    return await runCookieDraftChain(sessionRequest, credential, mutation, timezone, dispatchState);
  } catch (cause) {
    if (cause instanceof ConfirmedCreationFailureError || cause instanceof UnknownCreationStateError) {
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

function rewriteStatisticsCommonRequest(value: unknown, date: string): boolean {
  if (!isRecord(value) || !isRecord(value.common_req)) return false;
  let changed = false;
  for (const key of ["st", "et"] as const) {
    if (!(key in value.common_req)) continue;
    value.common_req[key] = date;
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
  credential: ParsedCookieCredential,
  mutation: CreationMutation,
  timezone: string,
  dispatchState: CreationDispatchState,
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
  const bootstrapTemplateCampaignId = !copyOnly && !credential.creationProfile
    ? nonEmptyId(mutation.preset.templateCampaignId)
    : undefined;
  const resolvedRow = resolveTikTokPostRow(mutation);
  const preflightPayload = await requestCreationStep("adgroup/list",
    () => sessionRequest,
    credential,
    { semantics: "preflight-read", dispatchState },
  );
  assertAdGroupListPreflight(preflightPayload);
  const exactCampaigns = copyOnly ? [] : [...new Map(
    extractEntities(preflightPayload, "campaign")
      .filter((entity) => normalizeProviderEntity(entity).name.trim() === mutation.row.campaignName.trim())
      .map((entity) => [entity.externalId, entity]),
  ).values()];
  if (exactCampaigns.length > 1) {
    throw new RetryableCreationError("当前账户存在多个同名推广系列，无法确定应复用哪一个系列。");
  }
  if (!copyOnly && exactCampaigns.length === 0 && hasExplicitAdditionalPages(preflightPayload)) {
    throw new RetryableCreationError("推广系列列表未完整返回，无法安全判断同名系列是否已存在。");
  }
  const existingCampaignId = exactCampaigns[0]?.externalId;
  const creationRow = existingCampaignId
    ? { ...resolvedRow, adGroupName: uniqueAdGroupName(preflightPayload, resolvedRow.adGroupName, existingCampaignId) }
    : resolvedRow;
  const drafts = credential.creationProfile
    ? buildProfileDraftPayloads(credential.creationProfile, creationRow, timezone, new Date(), mutation.preset)
    : buildDraftPayloads(creationRow, mutation.preset, timezone);
  const initializationTemplateCampaignId = copyOnly
    ? mutation.templateCampaignId
    : existingCampaignId ?? bootstrapTemplateCampaignId;
  const initializedIds = initializationTemplateCampaignId
    ? await initializeProfileDraftIds(
        sessionRequest,
        credential,
        mutation,
        dispatchState,
        preflightPayload,
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
  let creativeSnapIdFromAd = responseId(adGroup, "creative_snap_id");
  let creativeSketchIdFromAd = responseId(adGroup, "creative_sketch_id");

  const creativeDraft: Record<string, unknown> = {
    ...drafts.creative,
    ad_snap_id: adSnapId,
    ad_sketch_id: adSketchId,
  };
  const creativeAssets = creativeDraft.asset_group_sketch_form_data_list;
  if (Array.isArray(creativeAssets) && isRecord(creativeAssets[0])) {
    if (initializedIds) {
      creativeSnapIdFromAd = initializedIds.creativeSnapId;
      creativeSketchIdFromAd = initializedIds.creativeSketchId;
    }
    creativeAssets[0].creative_snap_id = creativeSnapIdFromAd;
    creativeAssets[0].creative_sketch_id = creativeSketchIdFromAd;
  }
  const creative = copyOnly ? {} : await requestCreationStep("creative_snap/save",
    () => creationRequest(sessionRequest, "creative_snap/save", creativeDraft),
    credential,
    { semantics: "mutation", dispatchState },
  );
  const creativeSnapId =
    (copyOnly && initializedIds ? initializedIds.creativeSnapId : responseId(creative, "creative_snap_id")) ??
    creativeSnapIdFromAd ??
    requiredResponseId(creativeDraft, "creative_snap_id");
  const creativeSketchId =
    (copyOnly && initializedIds ? initializedIds.creativeSketchId : responseId(creative, "creative_sketch_id")) ??
    creativeSketchIdFromAd ??
    requiredResponseId(creativeDraft, "creative_sketch_id");
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
  await validateDraftChain(sessionRequest, credential, {
    ...(existingCampaignId ? { campaignId: existingCampaignId } : {}), campaignSnapId, campaignSketchId, publishItems,
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
      creativeSnapEcho: responseId(creative, "creative_snap_id") === creativeSnapId,
      creativeSketchEcho: responseId(creative, "creative_sketch_id") === creativeSketchId,
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

async function validateDraftChain(
  sessionRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  ids: {
    campaignId?: string;
    campaignSnapId: string;
    campaignSketchId: string;
    publishItems: DraftPublishItem[];
    riskInfo: Record<string, unknown>;
  },
): Promise<void> {
  const adSnapIds = ids.publishItems.map((item) => item.ad_snap_id);
  let fakeCampaignId = "";
  if (!ids.campaignId) {
    const consistency = await requestCreationStep("snap/cbo_consistency_check",
      () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/snap/cbo_consistency_check/", {
        campaign_snap_id: ids.campaignSnapId,
        adgroup_snap_ids: adSnapIds,
        ad_snap_ids: adSnapIds,
        is_budget_split_test: false,
      }), credential);
    if (isRecord(consistency.data) && consistency.data.is_all_success === false) {
      throw new ConfirmedCreationFailureError("TikTok 系列与广告组草稿一致性检查失败。");
    }
    const campaignCheck = await requestCreationStep("campaign_snap/check",
      () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/campaign_snap/check/", {
        campaign_snap_id: ids.campaignSnapId,
      }), credential);
    const campaignData = isRecord(campaignCheck.data) ? campaignCheck.data : undefined;
    if (campaignData?.success === false) throw new ConfirmedCreationFailureError("TikTok 系列草稿检查失败。");
    fakeCampaignId = nonEmptyId(campaignData?.fake_campaign_id) ?? ids.campaignSketchId;
  }
  const checkInfo = ids.publishItems.map((item) => ({
    ad_id: "",
    ad_snap_id: item.ad_snap_id,
    creative_snap_ids: item.creative_snap_info_list.map((creative) => creative.creative_snap_id),
  }));
  await requestCreationStep("snap/batch_create_cta_id",
    () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/snap/batch_create_cta_id/", {
      campaign_id: ids.campaignId ?? "",
      campaign_snap_id: ids.campaignSnapId,
      ad_and_creative_snap_info_list: checkInfo,
    }), credential);
  const adCheck = await requestCreationStep("ad_creative_snap/check",
    () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/ad_creative_snap/check/", {
      campaign_id: ids.campaignId ?? "",
      fake_campaign_id: fakeCampaignId,
      ad_creative_snap_check_info: checkInfo,
      risk_info: ids.riskInfo,
    }), credential);
  const adData = isRecord(adCheck.data) ? adCheck.data : undefined;
  if (adData?.creative_success === false) throw new ConfirmedCreationFailureError("TikTok 广告素材草稿检查失败。");
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
        throw new ConfirmedCreationFailureError("TikTok 已明确报告广告组或创意创建失败，未生成正式广告。");
      }
      return detail;
    }
    if (typeof data?.status === "number" && data.status < 0) {
      throw new ConfirmedCreationFailureError("TikTok 已明确报告创建失败，未生成正式广告。");
    }
  }
  throw new Error("TikTok 创建任务在 9 秒内未返回最终结果，请稍后在投放结果中重新检查。");
}

function resolveTikTokPostRow(
  mutation: CreationMutation,
): CreationMutation["row"] {
  const matches = mutation.preset.videoPostMappings?.filter(
    (item) => item.videoCode === mutation.row.videoCode,
  ) ?? [];
  const postIds = [...new Set(matches.map((item) => item.postId))];
  if (postIds.length > 1) {
    throw new RetryableCreationError("同一视频代码配置了多个 Post ID，请先统一映射。");
  }
  const mapping = matches[0];
  if (mapping) return { ...mutation.row, videoCode: mapping.postId };
  if (mutation.row.videoCode.startsWith("#")) {
    throw new RetryableCreationError(
      "该视频代码尚未映射到 TikTok Post；请先在高级自定义中保存共享 Post ID。",
    );
  }
  return mutation.row;
}

function uniqueAdGroupName(
  preflightPayload: Record<string, unknown>,
  requestedName: string,
  campaignId: string,
): string {
  const existingNames = new Set(
    extractEntities(preflightPayload, "ad-group")
      .filter((entity) => nonEmptyId(entity.payload.campaign_id) === campaignId)
      .map((entity) => normalizeProviderEntity(entity).name.trim())
      .filter(Boolean),
  );
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
    return groups.some((group) => isRecord(group) && Array.isArray(group.creative_items)
      && group.creative_items.some((creative) => isRecord(creative) && nonEmptyId(creative.id)));
  });
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
  const creatives = Array.isArray(firstGroup?.creative_items) ? firstGroup.creative_items : [];
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
  listPayload: Record<string, unknown>,
  templateCampaignId: string,
  requireDisabledSource: boolean,
): Promise<InitializedDraftIds> {
  const profile = credential.creationProfile;
  const campaigns = extractEntities(listPayload, "campaign");
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
  adForm.origin_ad_id = existingCampaignId ? 0 : initialized.adForm.origin_ad_id;
  adForm.ad_snap_id = initialized.adSnapId;
  adForm.ad_sketch_id = initialized.adSketchId;
  adForm.by_ad_sketch_id = initialized.adSketchId;
  drafts.adGroup.ad_sketch_form_data = adForm;

  const creativeForm = cloneRecord(initialized.creativeForm);
  const creativeOverrideKeys = ["creative_name", "external_url", "open_url"];
  if (applyPresetOverrides) {
    creativeOverrideKeys.push(
      "identity_type", "identity_id", "call_to_action_id", "is_comment_disable", "is_share_disable",
    );
  }
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
    return new ConfirmedCreationFailureError(message) as T;
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
  const id = nonEmptyId(direct);
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
    const idKeys: Record<SyncEntityType, string[]> = {
      campaign: ["campaign_id", "campaignId", "id"],
      "ad-group": ["adgroup_id", "ad_group_id", "adGroupId", "ad_id", "id"],
      ad: ["creative_id", "creativeId", "ad_id", "adId", "id"],
    };
    const id = idKeys[entityType]
      .map((key) => item[key])
      .find(isStableExternalId);
    return id === undefined
      ? []
      : [{ entityType, externalId: String(id), payload: item }];
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

function assertAdGroupListPreflight(payload: Record<string, unknown>): void {
  const data = isRecord(payload.data) ? payload.data : undefined;
  const listKeys = ["adgroups", "ad_groups", "adgroup_list", "table", "list", "items"];
  if (!data || !listKeys.some((key) => Array.isArray(data[key]))) {
    throw new RetryableCreationError(
      "adgroup/list 预检响应缺少可识别的列表结构，尚未发送任何创建请求。",
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
