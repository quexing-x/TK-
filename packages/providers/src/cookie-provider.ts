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
} from "./types.js";
import {
  isMultipartBody,
  rewriteMultipartFields,
} from "./multipart.js";

const capabilities = new Set<ProviderCapability>([
  "read-campaigns",
  "read-ad-groups",
  "read-ads",
  "read-reports",
  "change-status",
  "create-campaigns",
]);

type ParsedCookieCredential = ReturnType<
  typeof CookieCredentialInputSchema.parse
>;

export class CookieAdsProvider implements AdsProvider {
  readonly kind = "cookie" as const;
  readonly displayName = "Cookie 会话";
  readonly capabilities = capabilities;

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
    const emptyResponses = new Set<SyncEntityType>();
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
      let payload: Record<string, unknown>;
      try {
        payload = await requestCookieJson(todayRequest, credential);
      } catch (cause) {
        if (!request.derived) throw cause;
        warnings.push(
          `${entityType} 自动补全请求失败；如需该层级数据，请补充一条真实列表 cURL。`,
        );
        continue;
      }
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
    return {
      entities: uniqueEntities,
      result: {
        startedAt,
        finishedAt: new Date().toISOString(),
        counts,
        warnings,
      },
    };
  }

  async changeStatus(
    context: ProviderContext,
    mutations: StatusMutation[],
  ): Promise<StatusMutationResult[]> {
    CookieConnectionSettingsSchema.parse(context.settings);
    const credential = CookieCredentialInputSchema.parse(context.credential);
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
          message: `缺少 ${mutation.entityType} ${mutation.action} 的状态 cURL 模板。`,
        });
        continue;
      }
      try {
        const request = materializeStatusRequest(template, mutation);
        await requestCookieJson(request, credential);
        results.push({
          ...mutation,
          ok: true,
          message: `Cookie 状态请求执行成功：${mutation.action}${template.derived ? "（自动扩展模板）" : ""}。`,
        });
      } catch (cause) {
        const detail =
          cause instanceof Error ? cause.message : "Cookie 状态请求失败。";
        results.push({
          ...mutation,
          ok: false,
          message: template.derived
            ? `${detail} 自动扩展模板被拒绝；请只补充此层级的一条真实开关 cURL。`
            : detail,
        });
      }
    }
    return results;
  }

  async createFromPreset(
    context: ProviderContext,
    mutations: CreationMutation[],
  ): Promise<CreationMutationResult[]> {
    CookieConnectionSettingsSchema.parse(context.settings);
    const credential = CookieCredentialInputSchema.parse(context.credential);
    const sessionRequest = credential.requestTemplates?.find(
      (item) => item.target === "ad-group" && !item.derived,
    );
    if (!sessionRequest) {
      return mutations.map((mutation) => ({
        ...mutation,
        ok: false,
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
          message: cause instanceof Error ? cause.message : "TikTok 创建请求失败。",
        });
      }
    }
    return results;
  }
}

function withTodayMetricWindow(
  request: CapturedCookieRequest,
  timezone: string,
  now: Date,
): CapturedCookieRequest {
  const date = formatDateInTimezone(now, timezone);
  let changed = false;
  const url = new URL(request.url);
  for (const key of ["start_date", "end_date", "startDate", "endDate"]) {
    if (!url.searchParams.has(key)) continue;
    url.searchParams.set(key, date);
    changed = true;
  }

  let body = request.body;
  if (body && request.contentType?.toLowerCase().includes("json")) {
    try {
      const value = JSON.parse(body) as unknown;
      changed = rewriteJsonDateWindow(value, date) || changed;
      body = JSON.stringify(value);
    } catch {
      // Do not modify non-JSON bodies. The explicit check below prevents a
      // multi-day request from silently reaching the rule engine.
    }
  }
  return { ...request, url: url.toString(), ...(body === undefined ? {} : { body }) };
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
  const copyOnly = mutation.row.videoCode === "__COPY_SOURCE__";
  const drafts = credential.creationProfile
    ? buildProfileDraftPayloads(credential.creationProfile, mutation.row, timezone)
    : buildDraftPayloads(mutation.row, mutation.preset, timezone);
  const initializedIds = copyOnly || credential.creationProfile
    ? await initializeProfileDraftIds(sessionRequest, credential, mutation)
    : null;
  if (initializedIds) {
    applyCopiedDraftForms(drafts, initializedIds);
  }
  const campaign = await requestCreationStep("campaign_snap/save",
    creationRequest(sessionRequest, "campaign_snap/save", drafts.campaign),
    credential,
  );
  const campaignSnapId = responseId(campaign, "campaign_snap_id") ?? initializedIds?.campaignSnapId ?? requiredResponseId(campaign, "campaign_snap_id");
  const campaignSketchId = responseId(campaign, "campaign_sketch_id") ?? initializedIds?.campaignSketchId ?? requiredResponseId(campaign, "campaign_sketch_id");

  if (initializedIds) {
    const form = requireObjectField(drafts.adGroup, "ad_sketch_form_data");
    form.ad_snap_id = initializedIds.adSnapId;
    form.ad_sketch_id = initializedIds.adSketchId;
    form.by_ad_sketch_id = initializedIds.adSketchId;
  }

  const adGroup = copyOnly ? {} : await requestCreationStep("ad_snap/save",
    creationRequest(sessionRequest, "ad_snap/save", {
      ...drafts.adGroup,
      campaign_snap_id: campaignSnapId,
      campaign_sketch_id: campaignSketchId,
      campaign_id:
        responseId(campaign, "campaign_id") ??
        nonEmptyId(drafts.adGroup.campaign_id) ??
        "",
    }),
    credential,
  );
  const adSnapId = copyOnly && initializedIds ? initializedIds.adSnapId : responseId(adGroup, "ad_snap_id") ?? initializedIds?.adSnapId ?? requiredResponseId(adGroup, "ad_snap_id");
  const adSketchId = copyOnly && initializedIds ? initializedIds.adSketchId : responseId(adGroup, "ad_sketch_id") ?? initializedIds?.adSketchId ?? requiredResponseId(adGroup, "ad_sketch_id");
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
    creationRequest(sessionRequest, "creative_snap/save", creativeDraft),
    credential,
  );
  const creativeSnapId =
    (copyOnly && initializedIds ? initializedIds.creativeSnapId : responseId(creative, "creative_snap_id")) ??
    creativeSnapIdFromAd ??
    requiredResponseId(creativeDraft, "creative_snap_id");
  const creativeSketchId =
    (copyOnly && initializedIds ? initializedIds.creativeSketchId : responseId(creative, "creative_sketch_id")) ??
    creativeSketchIdFromAd ??
    requiredResponseId(creativeDraft, "creative_sketch_id");

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
        campaignSnapId, campaignSketchId, publishItems,
        initialStatus: mutation.initialStatus,
      })
    : buildPublishInput({
        campaignSnapId,
        campaignSketchId,
        adAndCreativeSnapInfoList: publishItems,
      }, mutation.initialStatus);
  await validateDraftChain(sessionRequest, credential, {
    campaignSnapId, campaignSketchId, publishItems,
    riskInfo: credential.creationProfile && isRecord(credential.creationProfile.publishPayload.risk_info)
      ? credential.creationProfile.publishPayload.risk_info
      : {},
  });
  let published: Record<string, unknown>;
  try {
    published = await requestCreationStep("create_by_snap",
      creationRequest(sessionRequest, "async_creation/create_by_snap", publishPayload),
      credential,
    );
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "未知错误";
    const diagnostics = {
      campaignSnapEcho: responseId(campaign, "campaign_snap_id") === initializedIds?.campaignSnapId,
      campaignSketchEcho: responseId(campaign, "campaign_sketch_id") === initializedIds?.campaignSketchId,
      adSnapEcho: responseId(adGroup, "ad_snap_id") === initializedIds?.adSnapId,
      adSketchEcho: responseId(adGroup, "ad_sketch_id") === initializedIds?.adSketchId,
      creativeSnapEcho: responseId(creative, "creative_snap_id") === creativeSnapId,
      creativeSketchEcho: responseId(creative, "creative_sketch_id") === creativeSketchId,
    };
    throw new Error(`${detail}；草稿回显=${JSON.stringify(diagnostics)}`);
  }
  const completed = await awaitCreationResult(sessionRequest, credential, published);
  const ids = creationResultIds(completed);
  if (!ids.campaignId || !ids.adGroupId || !ids.adId) {
    throw new Error(`TikTok 创建任务未生成完整对象：${JSON.stringify(creationResultSummary(completed))}`);
  }
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
    campaignSnapId: string;
    campaignSketchId: string;
    publishItems: DraftPublishItem[];
    riskInfo: Record<string, unknown>;
  },
): Promise<void> {
  const adSnapIds = ids.publishItems.map((item) => item.ad_snap_id);
  const consistency = await requestCreationStep("snap/cbo_consistency_check",
    creationPathRequest(sessionRequest, "/api/v4/i18n/creation/snap/cbo_consistency_check/", {
      campaign_snap_id: ids.campaignSnapId,
      adgroup_snap_ids: adSnapIds,
      ad_snap_ids: adSnapIds,
      is_budget_split_test: false,
    }), credential);
  if (isRecord(consistency.data) && consistency.data.is_all_success === false) {
    throw new Error("TikTok 系列与广告组草稿一致性检查失败。");
  }
  const campaignCheck = await requestCreationStep("campaign_snap/check",
    creationPathRequest(sessionRequest, "/api/v4/i18n/creation/campaign_snap/check/", {
      campaign_snap_id: ids.campaignSnapId,
    }), credential);
  const campaignData = isRecord(campaignCheck.data) ? campaignCheck.data : undefined;
  if (campaignData?.success === false) throw new Error("TikTok 系列草稿检查失败。");
  const fakeCampaignId = nonEmptyId(campaignData?.fake_campaign_id) ?? ids.campaignSketchId;
  const checkInfo = ids.publishItems.map((item) => ({
    ad_id: "",
    ad_snap_id: item.ad_snap_id,
    creative_snap_ids: item.creative_snap_info_list.map((creative) => creative.creative_snap_id),
  }));
  const adCheck = await requestCreationStep("ad_creative_snap/check",
    creationPathRequest(sessionRequest, "/api/v4/i18n/creation/ad_creative_snap/check/", {
      campaign_id: "",
      fake_campaign_id: fakeCampaignId,
      ad_creative_snap_check_info: checkInfo,
      risk_info: ids.riskInfo,
    }), credential);
  const adData = isRecord(adCheck.data) ? adCheck.data : undefined;
  if (adData?.creative_success === false) throw new Error("TikTok 广告素材草稿检查失败。");
  await requestCreationStep("snap/batch_create_cta_id",
    creationPathRequest(sessionRequest, "/api/v4/i18n/creation/snap/batch_create_cta_id/", {
      campaign_id: "",
      campaign_snap_id: ids.campaignSnapId,
      ad_and_creative_snap_info_list: checkInfo,
    }), credential);
}

async function awaitCreationResult(
  sessionRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  published: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const asyncRequestId = responseId(published, "async_request_id");
  if (!asyncRequestId) return published;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 750));
    const detail = await requestCreationStep("async_creation/detail",
      creationDetailRequest(sessionRequest, asyncRequestId),
      credential,
    );
    const data = isRecord(detail.data) ? detail.data : undefined;
    if (data?.status === 1 && isRecord(data.result)) return detail;
    if (typeof data?.status === "number" && data.status < 0) {
      throw new Error("TikTok 创建任务执行失败，未生成正式广告。");
    }
  }
  throw new Error("TikTok 创建任务在 9 秒内未返回最终结果，请稍后在投放结果中重新检查。");
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
): Promise<InitializedDraftIds> {
  const listPayload = await requestCreationStep("adgroup/list",
    sessionRequest,
    credential,
  );
  const profile = credential.creationProfile;
  const profileCampaignForm = profile && isRecord(profile.campaignPayload.campaign_sketch_form_data)
    ? profile.campaignPayload.campaign_sketch_form_data
    : undefined;
  const preferredName = mutation.sourceCampaignName
    ?? (typeof profileCampaignForm?.campaign_name === "string" ? profileCampaignForm.campaign_name : "");
  const campaigns = extractEntities(listPayload, "campaign");
  if (!preferredName) throw new Error("复制创建必须明确指定源系列名称。");
  const matchingCampaigns = campaigns.filter((entity) => entity.payload.campaign_name === preferredName);
  if (matchingCampaigns.length === 0) {
    throw new Error(`当前账户未找到指定的源系列“${preferredName}”。`);
  }
  if (matchingCampaigns.length > 1) {
    throw new Error(`当前账户存在多个同名源系列“${preferredName}”，请先为源系列设置唯一名称。`);
  }
  const sourceCampaign = matchingCampaigns[0]!;
  if (normalizeProviderEntity(sourceCampaign).status !== "disabled") {
    throw new Error("为了避免意外花费，只允许复制关闭状态的源系列。");
  }
  const riskInfo = profile && isRecord(profile.publishPayload.risk_info)
    ? profile.publishPayload.risk_info
    : profile && isRecord(profile.campaignPayload.risk_info)
      ? profile.campaignPayload.risk_info
      : {};
  const copied = await requestCreationStep("campaign_snap/copy",
    creationPathRequest(sessionRequest, "/mi/api/v4/i18n/creation/campaign_snap/copy/", {
      campaign_id: sourceCampaign.externalId,
      name: mutation.row.campaignName,
      resp_with_detail: true,
      with_ad: true,
      with_creative: true,
      with_sketch: true,
      risk_info: riskInfo,
    }),
    credential,
  );
  return copiedDraftIds(copied);
}

function copiedDraftIds(payload: Record<string, unknown>): InitializedDraftIds {
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (!data) throw new Error("TikTok 草稿初始化响应缺少 data。");
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
    throw new Error("TikTok 草稿初始化响应缺少系列、广告组或广告的 snap/sketch 标识。");
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
    throw new Error("TikTok 草稿初始化响应中的广告组 snap/sketch 数量不一致。");
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
      throw new Error(`TikTok 草稿初始化响应中的第 ${adIndex + 1} 个广告组映射不完整。`);
    }
    const creatives = creativeItems.map((creative, creativeIndex) => {
      const creativeSnapId = nonEmptyId(creative.creative_snap_id);
      const creativeSketchId = nonEmptyId(creativeSketchIds[creativeIndex]);
      if (!creativeSnapId || !creativeSketchId) {
        throw new Error(`TikTok 草稿初始化响应中的第 ${adIndex + 1} 个广告组素材映射不完整。`);
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
): void {
  const requestedCampaign = requireObjectField(drafts.campaign, "campaign_sketch_form_data");
  const requestedAd = requireObjectField(drafts.adGroup, "ad_sketch_form_data");
  const requestedCreatives = drafts.creative.asset_group_sketch_form_data_list;
  const requestedCreative = Array.isArray(requestedCreatives) && isRecord(requestedCreatives[0]) ? requestedCreatives[0] : undefined;
  if (!requestedCreative) throw new Error("创建模板缺少广告素材表单。");
  const campaignForm = { ...requestedCampaign, ...cloneRecord(initialized.campaignForm) };
  campaignForm.campaign_name = requestedCampaign.campaign_name;
  campaignForm.campaign_id = "";
  campaignForm.campaign_snap_id = initialized.campaignSnapId;
  campaignForm.campaign_sketch_id = initialized.campaignSketchId;
  drafts.campaign.campaign_sketch_form_data = campaignForm;

  const adForm = cloneRecord(initialized.adForm);
  for (const key of ["ad_name", "budget", "cpa_bid", "schedule_type", "start_time", "end_time"] as const) {
    if (requestedAd[key] !== undefined) adForm[key] = requestedAd[key];
  }
  adForm.origin_ad_id = initialized.adForm.origin_ad_id;
  adForm.ad_snap_id = initialized.adSnapId;
  adForm.ad_sketch_id = initialized.adSketchId;
  adForm.by_ad_sketch_id = initialized.adSketchId;
  drafts.adGroup.ad_sketch_form_data = adForm;

  const creativeForm = cloneRecord(initialized.creativeForm);
  for (const key of ["creative_name", "external_url", "open_url"] as const) {
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
  creativeForm.origin_creative_id = initialized.creativeForm.origin_creative_id;
  creativeForm.creative_snap_id = initialized.creativeSnapId;
  creativeForm.creative_sketch_id = initialized.creativeSketchId;
  drafts.creative.asset_group_sketch_form_data_list = [creativeForm];
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
    campaignSnapId: string;
    campaignSketchId: string;
    publishItems: DraftPublishItem[];
    initialStatus: "enabled" | "disabled";
  },
): Record<string, unknown> {
  const body = JSON.parse(JSON.stringify(template)) as Record<string, unknown>;
  body.campaign_id = "";
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

async function requestCreationStep(
  step: string,
  request: CapturedCookieRequest,
  credential: ParsedCookieCredential,
): Promise<Record<string, unknown>> {
  try {
    return await requestCookieJson(request, credential);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "未知错误";
    throw new Error(`${step}：${detail}`);
  }
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
    throw new Error(`TikTok 返回中缺少 ${key}，已停止后续发布。可用字段：${candidates || "无"}`);
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
    throw new Error(`TikTok 接口失败（code ${payload.code}）：${providerMessage}`);
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
      .find((value) => typeof value === "string" || typeof value === "number");
    return id === undefined
      ? []
      : [{ entityType, externalId: String(id), payload: item }];
  });
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
