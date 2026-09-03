import {
  CookieConnectionSettingsSchema,
  CookieCredentialInputSchema,
  buildDraftPayloads,
  buildDraftPublishPayload,
  buildDraftSketchListPayload,
  buildProfileDraftPayloads,
  buildPublishInput,
  matchDraftSketchesByName,
  parseDraftCreativeOwners,
  parseDraftSketchList,
  parseSketchSnapMapping,
  resolveDraftPublishTargets,
  DefaultTikTokCreativeAutomationStrategyIds,
  TikTokCreationPublishSource,
  splitVideoCodes,
  deriveTikTokCreationRequest,
  formatCampaignBudgetAmount,
  mapWithConcurrency,
  normalizeProviderEntity,
  SENT_REQUEST_BODY_LIMIT,
  SENT_REQUEST_MAX_ENTRIES,
  type CapturedCookieRequest,
  type DraftSketchEntry,
  type DraftSketchPublishItem,
  type ProviderEntity,
  type SketchSnapMapping,
  type SyncEntityType,
  type LaunchCreationProgress,
  type LaunchOriginalPost,
  type LaunchProductInfo,
  type LaunchSentRequest,
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
  AdGroupBudgetMutation,
  AdGroupBudgetMutationResult,
} from "./types.js";
import {
  resolveLegacyTargetAccountPixelId,
  resolveAccountPixelIdFromAdGroups,
} from "./pixel-resolver.js";
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
import { isStatusKey, matchCase } from "./curl-import.js";
import {
  isDefinitelyUnsentNetworkError,
  isRequestTimeoutError,
  withCauseDetail,
} from "./network-error.js";

const capabilities = new Set<ProviderCapability>([
  "update-ad-group-budget",
  "read-campaigns",
  "read-ad-groups",
  "read-ads",
  "read-reports",
  "change-status",
  "create-campaigns",
  "copy-ads",
  "copy-campaigns",
  "appeal-ads",
  "delete-ad-groups",
]);

const COOKIE_SYNC_CONTRACT_VERSION = "cookie-statistics-v5-2026-07";

type ParsedCookieCredential = ReturnType<
  typeof CookieCredentialInputSchema.parse
>;

export class CookieAdsProvider implements AdsProvider {
  readonly kind = "cookie" as const;
  readonly platform = "tiktok" as const;
  readonly displayName = "Cookie 会话";
  readonly implementationStatus = "available" as const;
  // v4：新增 copy-campaigns（系列级复制）。契约版本变更会让所有已接入账户显示
  // “能力契约已更新，请重新检测连接”，重新检测后才会开放新能力。
  // v5：新增 update-ad-group-budget。
  //
  // **加能力必须同时升这个版本号。** authorizedCapabilities 是账户上次连接检测时记下的
  // 集合，新能力不在里面；而 available 要求 ready && authorizedCapabilities.has(...)，
  // 版本不升则 contractCurrent 仍为 true、界面不会提示重新检测，于是新能力对所有存量账户
  // 永久不可用——执行器每轮在能力闸门静默 return，开关打开了也毫无动静。
  // 2026-08-25 的提额规则就是这么白开了一整天。
  readonly capabilityVersion = "cookie-capabilities-v5-2026-08";
  readonly capabilities = capabilities;
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
    // 光有关闭模板还不够：删除请求是把这条模板里的开关字段改写成 delete 派生出来的，
    // 模板里没有可改写的开关字段就派生不出来。此前只检查模板存在与否，于是界面报
    // “删除：可用”、执行器领了当天任务，然后 66 次全部在发出前失败。
    const hasAdGroupStatusSession = templates.some(
      (item) => item.target === "ad-group-status" && item.action === "disable",
    );
    const hasAdGroupDeleteSession = templates.some(
      (item) => item.target === "ad-group-status"
        && item.action === "disable"
        && hasRewritableStatusField(item),
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
            // 系列级复制与广告组级复制共用同一条创建会话，没有额外的 cURL 要求。
            "copy-campaigns",
          ] as const
        : []),
      ...(hasCompleteStatusTemplates ? ["change-status"] as const : []),
      // The appeal endpoint and body shape are shared. Authorization and
      // advertiser-specific query parameters still come from this account's
      // imported list session, so no per-account appeal cURL is required.
      ...(hasListSession ? ["appeal-ads"] as const : []),
      ...(hasAdGroupDeleteSession ? ["delete-ad-groups"] as const : []),
      // 预算写入只需要广告组关闭那条 cURL 当会话载体（签名参数、Cookie 都在它身上），
      // 报文是另起的 multipart，不像删除那样要改写模板里的开关字段——所以这里只要模板
      // 存在即可，不叠加 hasRewritableStatusField。
      //
      // **这个列表是逐条列举的：加了新能力必须同时加进来。** 漏加的后果是它永远进不了
      // authorizedCapabilities，执行器每轮在能力闸门静默 return，而界面上一切正常——
      // 2026-08-25 的提额规则就是这么白开了一整天，重新检测多少次都没用。
      ...(hasAdGroupStatusSession ? ["update-ad-group-budget"] as const : []),
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

  async readAdGroupOriginalPosts(
    context: ProviderContext,
    input: { campaignId: string; adGroupId: string },
  ): Promise<{ posts: LaunchOriginalPost[]; productUrl: string | null; productInfo: LaunchProductInfo | null; catalogSetup: 0 | 1 | null }> {
    const { credential, sessionRequest } = originalPostReadSession(context);
    const sidebar = await requestCreationStep(
      "sidebar/brief_info_list",
      () => creationPathRequest(
        sessionRequest,
        "/api/v4/i18n/creation/sidebar/brief_info_list/",
        { campaign_id: input.campaignId },
      ),
      credential,
      { semantics: "preflight-read" },
    );
    const creativeId = findAssetGroupCreativeId(sidebar.data, input.adGroupId);
    if (!creativeId) {
      throw new RetryableCreationError(
        `源广告组 ${input.adGroupId} 没有可读取的创意详情，请刷新源账户后重试。`,
      );
    }
    const detail = await requestCreationStep(
      "creative/procedural_detail",
      () => creationPathGetRequest(
        sessionRequest,
        "/mi/api/v3/i18n/perf/creative/procedural_detail/",
        { creative_id: creativeId, creative_material_mode: "6" },
      ),
      credential,
      { semantics: "preflight-read" },
    );
    const data = isRecord(detail.data) ? detail.data : {};
    const imageList = Array.isArray(data.image_list) ? data.image_list : [];
    const posts = uniqueOriginalPosts(imageList.flatMap(parseOriginalPost));
    if (posts.length === 0) {
      throw new RetryableCreationError("源广告组没有可迁移的 TikTok 原帖。");
    }
    const productUrl = firstStringByKeys(data, new Set([
      "external_url",
      "product_url",
      "landing_page_url",
    ]));
    const catalogSetupValue = numericValue(data.catalog_setup);
    return {
      posts,
      productUrl: productUrl && isHttpUrlValue(productUrl) ? productUrl : null,
      productInfo: migrationProductInfo(data.product_info),
      catalogSetup: catalogSetupValue === 0 || catalogSetupValue === 1 ? catalogSetupValue : null,
    };
  }

  async readAccessibleOriginalPosts(
    context: ProviderContext,
    sourcePosts: LaunchOriginalPost[],
  ): Promise<LaunchOriginalPost[]> {
    if (sourcePosts.length === 0) return [];
    const { credential, sessionRequest } = originalPostReadSession(context);
    const identities: Array<Record<string, unknown>> = [];
    let identityCursor = "0";
    let identityPage = 1;
    let identityQueryMode = 8;
    let identityPaginationComplete = false;
    for (let page = 0; page < 50; page += 1) {
      const response = await requestCreationStep(
        "spark/identity/list",
        () => creationPathRequest(
          sessionRequest,
          "/api/v4/i18n/creation/spark/identity/list/",
          {
            cursor: identityCursor,
            page: identityPage,
            limit: 20,
            is_warm_up: page === 0,
            mix_mode: 5,
            identity_query_mode: identityQueryMode,
          },
        ),
        credential,
        { semantics: "preflight-read" },
      );
      const data = isRecord(response.data) ? response.data : {};
      const rows = Array.isArray(data.identity_list)
        ? data.identity_list.filter(isRecord)
        : [];
      identities.push(...rows.filter((row) => row.can_use_video_list !== false));
      if (data.has_more !== true) {
        identityPaginationComplete = true;
        break;
      }
      identityCursor = nonEmptyId(data.cursor) ?? identityCursor;
      identityPage = typeof data.next_page === "number" ? data.next_page : identityPage + 1;
      identityQueryMode = typeof data.next_query_mode === "number"
        ? data.next_query_mode
        : identityQueryMode;
    }
    if (!identityPaginationComplete) {
      throw new RetryableCreationError(
        "目标账户绑定身份超过 1000 个，无法在安全分页上限内完成原帖核对。",
      );
    }
    if (identities.length === 0) return [];

    const identityList = identities.flatMap((identity) => {
      const identityId = nonEmptyId(identity.identity_id);
      const identityType = numericValue(identity.identity_type);
      if (!identityId || identityType === null) return [];
      return [{
        identity_id: identityId,
        identity_type: identityType,
        identity_bc_id: nonEmptyId(identity.identity_bc_id) ?? "0",
      }];
    });
    const identityByKey = new Map(identityList.map((identity) => [
      `${identity.identity_id}:${identity.identity_type}`,
      identity,
    ]));
    const requests = sourcePosts.flatMap((post) => {
      const identity = identityByKey.get(`${post.identityId}:${post.identityType}`);
      if (!identity) return [];
      return [{
        itemId: post.itemId,
        identity,
        body: {
          aweme_item_ids: [post.itemId],
          identity_id: identity.identity_id,
          identity_type: identity.identity_type,
          identity_bc_id: identity.identity_bc_id,
          item_source: 2,
        },
      }];
    });
    const found = new Map<string, LaunchOriginalPost>();
    for (let offset = 0; offset < requests.length; offset += 50) {
      const batch = requests.slice(offset, offset + 50);
      const response = await requestCreationStep(
        "material/native_item_infos",
        () => creationPathRequest(
          sessionRequest,
          "/mi/api/v4/i18n/creation/material/native_item_infos/",
          { item_req_list: batch.map((item) => item.body) },
        ),
        credential,
        { semantics: "preflight-read" },
      );
      const data = isRecord(response.data) ? response.data : {};
      const itemInfoMap = isRecord(data.item_info_map) ? data.item_info_map : {};
      for (const request of batch) {
        const itemInfo = itemInfoMap[request.itemId];
        if (!isRecord(itemInfo)) continue;
        const [post] = parseOriginalPost({
          ...itemInfo,
          identity_id: request.identity.identity_id,
          identity_type: request.identity.identity_type,
          identity_bc_id: request.identity.identity_bc_id,
        });
        if (post?.promotable) found.set(post.itemId, post);
      }
    }
    return sourcePosts.flatMap((sourcePost) => {
      const post = found.get(sourcePost.itemId);
      return post ? [post] : [];
    });
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

  async updateAdGroupBudgets(
    context: ProviderContext,
    mutations: AdGroupBudgetMutation[],
  ): Promise<AdGroupBudgetMutationResult[]> {
    let credential: ParsedCookieCredential;
    try {
      CookieConnectionSettingsSchema.parse(context.settings);
      credential = CookieCredentialInputSchema.parse(context.credential);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Cookie 预算写入参数无效。";
      return mutations.map((mutation) => ({ ...mutation, ok: false, failureKind: "retryable", message }));
    }
    // 沿用广告组关闭那条 cURL 做会话载体：签名参数（msToken / X-Bogus / X-Gnarly）与
    // Cookie 都在它身上，我们只改路径、查询串与报文。
    const sessionRequest = credential.requestTemplates?.find(
      (item) => item.target === "ad-group-status" && item.action === "disable",
    );
    if (!sessionRequest) {
      return mutations.map((mutation) => ({
        ...mutation,
        ok: false,
        failureKind: "retryable",
        message: "缺少广告组关闭 cURL，无法安全派生预算写入请求。",
      }));
    }
    const advertiserId = new URL(sessionRequest.url).searchParams.get("aadvid")?.trim() ?? "";
    if (!advertiserId) {
      return mutations.map((mutation) => ({
        ...mutation,
        ok: false,
        failureKind: "retryable",
        message: "会话 cURL 上缺少 aadvid，无法定位广告账户。",
      }));
    }
    const profile = credential.creationProfile;
    const riskInfo = profile && isRecord(profile.publishPayload) && isRecord(profile.publishPayload.risk_info)
      ? profile.publishPayload.risk_info
      : {};

    const results: AdGroupBudgetMutationResult[] = [];
    for (const mutation of mutations) {
      let request: CapturedCookieRequest;
      try {
        request = buildAdGroupBudgetRequest(sessionRequest, advertiserId, mutation, riskInfo);
      } catch (cause) {
        results.push({
          ...mutation,
          ok: false,
          failureKind: "retryable",
          message: cause instanceof Error ? cause.message : "预算写入请求构造失败。",
        });
        continue;
      }
      try {
        const payload = await requestCookieJson(request, credential);
        if (payload.code !== 0) {
          // 预算改没改成不能靠猜：响应没给明确成功码就判 unknown，交人工核实。
          results.push({
            ...mutation,
            ok: false,
            failureKind: "unknown",
            message: "预算写入请求已发送，但 TikTok 响应缺少明确成功代码。",
          });
          continue;
        }
        results.push({ ...mutation, ok: true, message: `TikTok 已确认日预算改为 ${mutation.budget}。` });
      } catch (cause) {
        if (isDefinitelyUnsentNetworkError(cause)) {
          results.push({
            ...mutation,
            ok: false,
            failureKind: "retryable",
            message: `预算写入请求未发出：${cause instanceof Error ? cause.message : String(cause)}`,
          });
          continue;
        }
        results.push({
          ...mutation,
          ok: false,
          failureKind: "unknown",
          message: `预算写入结果无法确认：${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
    }
    return results;
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

  /**
   * 只回读一个实体，用于状态写入后的确认。
   *
   * 此前每改一条状态都跑一次 syncReadOnly：把系列/广告组/广告全部分页拉一遍，
   * 生产实测 64.8 秒、15 个请求、322 个实体，只为核对其中 1 个。自动启停是逐条
   * 串行的，20 条就是 20 分钟。
   *
   * 列表接口本身支持按 ID 精确筛选，字段名三层各不相同（实测：ad_id 会被静默
   * 忽略并返回整页，adgroup_id 直接报错 1300400001）：
   *   campaign -> campaign_ids
   *   ad-group -> ad_ids
   *   ad       -> creative_ids
   */
  async readEntityById(
    context: ProviderContext,
    entityType: "campaign" | "ad-group" | "ad",
    externalId: string,
  ): Promise<ProviderEntity | null> {
    const credential = CookieCredentialInputSchema.parse(context.credential);
    const importedAdGroupRead = credential.requestTemplates?.find(
      (item) => item.target === "ad-group" && !item.derived,
    );
    const captured = credential.requestTemplates?.find((item) => item.target === entityType)
      ?? (entityType === "campaign" && importedAdGroupRead
        ? siblingListRequest(importedAdGroupRead, "campaign")
        : entityType === "ad"
          ? deriveFinalAdReadRequest(importedAdGroupRead)
          : undefined);
    if (!captured?.body) return null;
    // 必须走与 syncReadOnly 相同的逐层规范化。广告层尤其关键：账户里存着的 ad 模板
    // 往往是早期从广告组派生的，只换了路径、仍带 dimensions:["ad_id"]，TikTok 会按
    // 广告组维度作答——每行 creative_id 是 "0" 占位，externalId 永远匹配不上。
    // 广告的身份在写入侧就是 creative_id（creative_list），读侧也必须是这个维度。
    const normalized = entityType === "campaign"
      ? campaignMetricsListRequest(captured)
      : entityType === "ad"
        ? adFinalListRequest(captured)
        : captured;
    if (!normalized.body) return null;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(normalized.body) as Record<string, unknown>;
    } catch {
      return null;
    }
    const commonReq = isRecord(body.common_req) ? body.common_req : null;
    if (!commonReq) return null;
    const filterField = ENTITY_ID_FILTER_FIELDS[entityType];
    // 保留原有的非 ID 筛选（例如 no_delete），只追加 ID 这一条。
    const existing = Array.isArray(commonReq.filters) ? commonReq.filters : [];
    commonReq.filters = [
      ...existing.filter((item) => !isRecord(item) || item.field !== filterField),
      { field: filterField, filter_type: 0, in_field_values: [externalId] },
    ];
    commonReq.page = 1;
    commonReq.page_size = 20;
    const request: CapturedCookieRequest = { ...normalized, body: JSON.stringify(body) };
    const windowed = withTodayMetricWindow(request, context.timezone ?? "UTC", new Date());
    const payload = await requestCookieJson(windowed, credential);
    const matched = extractEntities(payload, entityType)
      .find((entity) => entity.externalId === externalId);
    return matched ?? null;
  }

  async syncReadOnly(context: ProviderContext): Promise<ProviderSyncOutput> {
    const settings = CookieConnectionSettingsSchema.parse(context.settings);
    const credential = CookieCredentialInputSchema.parse(context.credential);
    const startedAt = new Date().toISOString();
    const entities: ProviderEntity[] = [];
    const warnings: string[] = [];
    const partialFailures: string[] = [];
    const materialUnavailableAdIds: string[] = [];
    const emptyResponses = new Set<SyncEntityType>();
    // 逐层记录"这一层本轮取全了吗"。全局的 paginationComplete / contractValid 是
    // 三层与出来的结果，无法回答某一层单独是否可信。
    const completeEntityTypes: SyncEntityType[] = [];
    let paginationComplete = true;
    let contractValid = true;
    let coverageKnown = true;
    const legacyEndpoints: Record<SyncEntityType, string> = {
      material: "",
      campaign: settings.campaignsUrl,
      "ad-group": settings.adGroupsUrl,
      ad: settings.adsUrl,
    };
    const importedAdGroupRead = credential.requestTemplates?.find(
      (item) => item.target === "ad-group" && !item.derived,
    );

    // 三个层级互不依赖，先各自把请求准备好，再并发打出去。串行时一轮 = 三层耗时
    // 相加（生产实测三层合计 89.8 秒），并发后 = 最慢的那一层，而最慢的广告层本来
    // 就是它们里的大头。
    //
    // 请求准备留在同步阶段、结果按固定层级顺序合并：告警文案和 partialFailures 会
    // 进快照并显示在界面上，顺序随网络快慢漂移会让同一份数据每轮看起来都不一样。
    const layerPlans = (["campaign", "ad-group", "ad"] as const).map((entityType) => {
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
        return { entityType, ready: false as const };
      }
      // A captured list cURL may have been copied while the TikTok UI was set
      // to 3/7/30 days.  When a report window is explicitly present, rewrite
      // it on every poll in the account's timezone instead of trusting the
      // captured range. Some valid TikTok list requests do not expose a date
      // parameter at all; those must still be replayed with the platform's
      // request defaults rather than blocking the complete polling cycle.
      // 广告层级同样要规范化：账户里可能已经存着一条早期派生的 ad 模板，它
      // 只换了路径、仍带广告组维度，直接重放会一行最终广告都取不到。
      const entityRequest = entityType === "campaign"
        ? campaignMetricsListRequest(request)
        : entityType === "ad"
          ? adFinalListRequest(request)
          : request;
      const windowedRequest = withTodayMetricWindow(
        entityRequest,
        context.timezone ?? "UTC",
        new Date(),
      );
      return {
        entityType,
        ready: true as const,
        derived: Boolean(entityRequest.derived),
        windowedRequest,
        coverageKnown: hasExplicitMetricWindow(windowedRequest),
      };
    });

    // 失败在这里只记录、不抛出：某一层该不该让整轮同步失败，取决于它是不是派生
    // 请求，而这个判定必须留到按层级顺序合并时再做，否则谁先失败谁说了算。
    const layerOutcomes = await mapWithConcurrency(
      layerPlans,
      LIST_LAYER_CONCURRENCY,
      async (plan) => {
        if (!plan.ready) return null;
        try {
          return {
            ok: true as const,
            ...(await requestAllCookieListPagesWithRetry(plan.windowedRequest, credential)),
          };
        } catch (cause) {
          return { ok: false as const, cause };
        }
      },
    );

    for (const [index, plan] of layerPlans.entries()) {
      const { entityType } = plan;
      if (!plan.ready) {
        warnings.push(`${entityType} 尚未导入只读请求。`);
        partialFailures.push(`${entityType}:request-missing`);
        continue;
      }
      if (!plan.coverageKnown) {
        coverageKnown = false;
        warnings.push(`${entityType} 请求未提供日期范围，已沿用 TikTok 默认数据范围。`);
      }
      const outcome = layerOutcomes[index]!;
      if (!outcome.ok) {
        // 导入的（非派生）请求失败仍然让整轮同步失败，和串行时一样。区别只是另外
        // 两层这时已经并发发出去了——多读一次没有副作用，结果丢弃即可。
        if (!plan.derived) throw outcome.cause;
        // 原因必须落库。此前这里直接丢掉 cause，只留一句泛化的"请求失败"，事后
        // 完全无法区分是限流、超时还是会话失效——39 条历史失败记录里一条线索都没有。
        // 加上之后第一时间就翻出了真凶：不是限流，是我们自己的超时预算到点。
        const reason = outcome.cause instanceof Error
          ? withCauseDetail(outcome.cause.message, outcome.cause).slice(0, 200)
          : "未知错误。";
        // 重试与否要如实说：超时走的是不重试那条分支，写死"已重试 1 次"会让日后
        // 排障的人以为重试机制在跑。
        const attempts = isRequestTimeoutError(outcome.cause)
          ? "未重试，超时不重试"
          : "已重试 1 次";
        warnings.push(
          `${entityType} 自动补全请求失败（${attempts}）：${reason} 如需该层级数据，请补充一条真实列表 cURL。`,
        );
        partialFailures.push(`${entityType}:derived-request-failed`);
        continue;
      }
      const pages = outcome.pages;
      const entityPaginationComplete = outcome.complete;
      const entityContractValid = pages.every(
        (payload) => hasRecognizedEntityList(payload, entityType),
      );
      contractValid &&= entityContractValid;
      paginationComplete &&= entityPaginationComplete;
      if (entityContractValid && entityPaginationComplete) {
        completeEntityTypes.push(entityType);
      }
      const extracted = pages.flatMap((payload) => extractEntities(payload, entityType));
      entities.push(...extracted);
      if (entityType === "ad-group") {
        entities.push(...pages.flatMap((payload) => extractEntities(payload, "campaign")));
      }
      if (extracted.length === 0) {
        emptyResponses.add(entityType);
      }
    }

    // 素材层：只对当天有消耗的广告拉。
    //
    // expand/material/list 只能按广告逐个查（"expand" 就是展开单个广告），没有
    // 全账户列表。生产上 300 多个广告逐个查会把一轮轮询彻底拖垮，而广告层本来
    // 就常因为慢而超时。同时，九条规则**全部**要消耗或转化才可能命中（最低门槛
    // 是 spend≥1，CPC 类还要有点击），零消耗的素材永远触发不了任何一条——所以
    // 按"当天有消耗"筛选不会漏掉任何本来会被处理的素材。
    if (importedAdGroupRead) {
      const materialTimezone = context.timezone ?? "UTC";
      const materialNow = new Date();
      // 按消耗从高到低排。截断本身不可能完全消灭（上限总有到顶的一天），所以留下
      // 的那批必须是消耗最低的：被截断的广告会进 materialUnavailableAdIds，而那份
      // 名单会让**这些广告和它们的素材本轮都不能自动写入**（见 automation-service
      // 的 isEntitySyncUsable）。换句话说截断等于给这些广告停一轮自动化，停在花钱
      // 最多的广告上代价最大。原先取的是 TikTok 列表顺序，等于随机挑谁停。
      const spendingAdIds = entities
        .filter((entity) => entity.entityType === "ad")
        .filter((entity) => entitySpend(entity.payload) > 0)
        .sort((left, right) => entitySpend(right.payload) - entitySpend(left.payload))
        .map((entity) => entity.externalId);
      let materialFailures = 0;
      // 失败原因必须留下来。原先这里是空 catch，素材整层拉不动时界面上只有
      // 「N 个广告的素材列表拉取失败」，看不出是 Cookie 过期、超时，还是请求
      // 体本身被 TikTok 拒收——2026-08-10 就是这样连查两轮都没抓到真因。
      const materialFailureReasons = new Set<string>();
      // 契约计数：响应里有行、却一行都解析不出素材 ID，说明字段形状变了。
      // 这跟"这些广告本来就没有素材"必须分开——后者返回 0 行是正常的，前者
      // 是整层失效，而两者在计数上都是 material:0。
      let materialRowsSeen = 0;
      let materialEntitiesExtracted = 0;
      const materialAdIdsToFetch = spendingAdIds.slice(0, MAX_MATERIAL_ADS_PER_SYNC);
      materialUnavailableAdIds.push(...spendingAdIds.slice(MAX_MATERIAL_ADS_PER_SYNC));
      // 这一层是目前单轮里最大的一块：按广告逐个查，上限 MAX_MATERIAL_ADS_PER_SYNC。
      // 限并发而不是全量并发——上百个请求同时打出去，同一个 Cookie 会话大概率被
      // TikTok 限流，而限流会让整轮同步降级成 partial，删除和自动复制随即跳过。
      const materialOutcomes = await mapWithConcurrency(
        materialAdIdsToFetch,
        MATERIAL_FETCH_CONCURRENCY,
        async (creativeId) => {
          try {
            // 过一遍 withTodayMetricWindow，和其它三层共用同一套日期改写 + 规则指标
            // 保障（ensureStatisticsMetric）。日期在 materialListRequest 里已设成当天，
            // 这里的改写是幂等的；真正的意义是：将来给规则加新指标时改
            // ensureStatisticsMetric，素材层会自动跟上，不再各写各的、悄悄落下。
            const payload = await requestCookieJson(
              withTodayMetricWindow(
                materialListRequest(importedAdGroupRead, creativeId, {
                  startDate: formatDateInTimezone(materialNow, materialTimezone),
                  endDate: formatDateInTimezone(materialNow, materialTimezone),
                }),
                materialTimezone,
                materialNow,
              ),
              credential,
            );
            return { ok: true as const, payload };
          } catch (cause) {
            return { ok: false as const, creativeId, cause };
          }
        },
      );
      // 按广告顺序合并，与串行时逐个 push 的结果完全一致：
      // materialUnavailableAdIds 会进同步快照，顺序漂移会让相同的一轮看着像变了。
      for (const outcome of materialOutcomes) {
        if (!outcome.ok) {
          materialFailures += 1;
          materialUnavailableAdIds.push(outcome.creativeId);
          // 和上面派生请求失败那段用同一套：undici 把网络错误一律写成
          // `fetch failed`，真正的 errno 挂在 cause 上，只取 message 会得到
          // 一句和原来的空 catch 一样没信息的话。
          materialFailureReasons.add(
            outcome.cause instanceof Error
              ? withCauseDetail(outcome.cause.message, outcome.cause).slice(0, 200)
              : "未知错误。",
          );
          continue;
        }
        const extracted = extractEntities(outcome.payload, "material");
        materialRowsSeen += countEntityListRows(outcome.payload, "material");
        materialEntitiesExtracted += extracted.length;
        entities.push(...extracted);
      }
      if (spendingAdIds.length > MAX_MATERIAL_ADS_PER_SYNC) {
        // 静默截断会让人以为素材都覆盖到了。宁可吵一点。
        warnings.push(
          `本轮有 ${spendingAdIds.length} 个广告有消耗，超过单轮素材拉取上限 ${MAX_MATERIAL_ADS_PER_SYNC}，其余广告的素材本轮未取。`,
        );
        partialFailures.push("material:truncated");
      }
      if (materialFailures > 0) {
        // 截断也要出声：只列前三类而不说还有别的，会让人把系统性拒收当成
        // 偶发超时——正是这次要消灭的误判。
        const shown = [...materialFailureReasons].slice(0, 3).join("；");
        const rest = materialFailureReasons.size > 3
          ? `（共 ${materialFailureReasons.size} 类，仅列前 3 类）`
          : "";
        warnings.push(
          `${materialFailures} 个广告的素材列表拉取失败，这些广告的素材本轮不参与规则判定。失败原因${rest}：${shown}`,
        );
        partialFailures.push("material:request-failed");
      }
      // 请求全部成功、响应里也有行，却一条素材都解析不出来 = 字段形状变了。
      // 这一层其它三层有 hasRecognizedEntityList 兜着，素材层没有；不拦下来的
      // 后果不只是漏判：completeEntityTypes 带上 material 会让 saveReadOnlySync
      // 清空整层已存快照（storage/src/store.ts 的 clearCurrentLayer），规则从此
      // 认为素材不存在，而同步质量仍然显示 healthy。
      const materialContractBroken =
        materialRowsSeen > 0 && materialEntitiesExtracted === 0;
      if (materialContractBroken) {
        warnings.push(
          `素材列表返回了 ${materialRowsSeen} 行，但没有一行能解析出素材 ID（ad_material_draft_id），本轮素材层判为契约不符，不刷新已存素材。`,
        );
        partialFailures.push("material:contract-invalid");
      }
      if (
        spendingAdIds.length > 0
        && materialFailures === 0
        && materialUnavailableAdIds.length === 0
        && !materialContractBroken
      ) {
        completeEntityTypes.push("material");
      }
    } else {
      // 素材请求是从广告组那条只读 cURL 派生出来的。没有它就整层不拉，
      // 而计数里的 material:0 和其它层的空结果长得一模一样，必须说出来。
      warnings.push("素材层尚未导入只读请求：素材请求由广告组列表 cURL 派生，缺它则整层不拉。");
      partialFailures.push("material:request-missing");
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
          materialUnavailableAdIds,
          completeEntityTypes,
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

    // 素材的启停不靠导入的开关模板：它的报文形状与三层通用模板完全不同（要同时
    // 带广告组 ID 与素材 ID），只能从会话请求派生。
    const materialSessionRequest = credential.requestTemplates?.find(
      (item) => item.target === "ad-group" && !item.derived,
    );

    for (const mutation of mutations) {
      if (mutation.entityType === "material") {
        if (!materialSessionRequest) {
          results.push({
            ...mutation,
            ok: false,
            failureKind: "retryable",
            message: "尚未导入广告组列表 cURL，无法建立素材启停会话。",
          });
          continue;
        }
        let request: CapturedCookieRequest;
        try {
          request = materializeMaterialStatusRequest(materialSessionRequest, mutation);
        } catch (cause) {
          results.push({
            ...mutation,
            ok: false,
            failureKind: "retryable",
            message: cause instanceof Error ? cause.message : "素材启停请求构造失败。",
          });
          continue;
        }
        try {
          await requestCookieJson(request, credential);
          results.push({
            ...mutation,
            ok: true,
            message: `素材${mutation.action === "enable" ? "开启" : "关闭"}成功。`,
          });
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : "素材启停请求失败。";
          results.push({
            ...mutation,
            ok: false,
            failureKind: cause instanceof RetryableCreationError ? "retryable" : "unknown",
            message: detail,
          });
        }
        continue;
      }
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
    const campaignKeys = new Set(mutations.map((mutation) => mutation.row.campaignName.trim()));
    const initialStatuses = new Set(mutations.map((mutation) => mutation.initialStatus));
    const canPublishAsSeriesBatch = mutations.length > 0
      && mutations.every((mutation) => mutation.templateMode === "none")
      && campaignKeys.size === 1
      && initialStatuses.size === 1;
    const seriesKey = campaignKeys.size === 1 ? [...campaignKeys][0] : "mixed";
    // Serialize only writes to the same account/series. The lock is deliberately
    // independent from a local plan id, so two UI requests cannot concurrently
    // attach drafts to the same TikTok series. Different series and accounts
    // remain concurrent.
    const reservationKey = `${context.accountId}:${seriesKey}`;
    const releaseBatchLock = reservationKey ? await this.acquireBatchLock(reservationKey) : null;
    try {
      // 数据连接（旧称 Pixel）在每条 mutation 自己的创建前解析，数据取自那次本来
      // 就要发的 adgroup/list 实时读取。不再预先拉事件管理器目录：那个接口已对所有
      // 账户返回 code 50002，而它一挂，整批创建会在发出任何写请求前全部失败。
      // Reservations are scoped to this invocation only. Persisting failed names
      // across retries was the source of unrequested `-001` ad groups.
      const reservations = {
        campaignIds: new Map<string, string>(),
        adGroupNames: new Map<string, Set<string>>(),
      };
      if (canPublishAsSeriesBatch) {
        const campaignKey = [...campaignKeys][0]!;
        const batchCampaignId = mutations.find((mutation) => mutation.batchCampaignId)?.batchCampaignId;
        if (batchCampaignId) reservations.campaignIds.set(campaignKey, batchCampaignId);
        const names = reservations.adGroupNames.get(campaignKey) ?? new Set<string>();
        for (const mutation of mutations) {
          for (const name of mutation.batchAdGroupNames ?? []) names.add(name.trim());
        }
        reservations.adGroupNames.set(campaignKey, names);
        const batchResults = await createCookieDraftBatch(
          sessionRequest,
          campaignObjectRequest,
          credential,
          mutations,
          context.timezone ?? "UTC",
          {
            ...(reservations.campaignIds.get(campaignKey)
              ? { campaignId: reservations.campaignIds.get(campaignKey)! }
              : {}),
            adGroupNames: names,
          },
        );
        const successful = batchResults.find((result) => result.ok && result.campaignId);
        if (successful?.campaignId) reservations.campaignIds.set(campaignKey, successful.campaignId);
        return batchResults;
      }
      for (const mutation of mutations) {
        const campaignKey = mutation.row.campaignName.trim();
        if (mutation.batchCampaignId) reservations.campaignIds.set(campaignKey, mutation.batchCampaignId);
        if (mutation.batchAdGroupNames?.length) {
          const names = reservations.adGroupNames.get(campaignKey) ?? new Set<string>();
          for (const name of mutation.batchAdGroupNames) names.add(name.trim());
          reservations.adGroupNames.set(campaignKey, names);
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
          const unsafeToRetry = cause instanceof UnknownCreationStateError
            || (cause instanceof ConfirmedCreationFailureError && !cause.retrySafe);
          results.push({
            ...mutation,
            ok: false,
            failureKind: unsafeToRetry
              ? "unknown"
              : "retryable",
            retrySafe: cause instanceof ConfirmedCreationFailureError
              ? cause.retrySafe
              : !(cause instanceof UnknownCreationStateError),
            message: cause instanceof Error
              ? `${cause.message}${unsafeToRetry && !cause.message.includes("不会自动重试") ? "；系统不会自动重试。" : ""}`
              : "TikTok 创建请求失败。",
          });
        }
      }
      return results;
    } finally {
      releaseBatchLock?.();
    }
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
      // 复制克隆的是源组的自动优化，这里改成与创建流程同一套组合。失败不阻断。
      publishItems = await applyCopiedCreativeAutomationStrategies({
        sessionRequest,
        credential,
        dispatchState,
        publishItems,
        riskInfo,
      });
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
      // 原生定时投放的组以 enabled 发布，由 TikTok 的排期决定何时放行。
      const publishedStatus = scheduledStart ? "enabled" as const : input.initialStatus;
      const publishPayload = profile
        ? materializePublishProfile(profile.publishPayload, {
            campaignId: input.existingCampaignId,
            campaignSnapId: "",
            campaignSketchId: "",
            publishItems,
            initialStatus: publishedStatus,
          })
        : buildPublishInput({
            campaignSnapId: input.existingCampaignId,
            campaignSketchId: input.existingCampaignId,
            adAndCreativeSnapInfoList: publishItems,
          }, publishedStatus);
      publishPayload.campaign_id = input.existingCampaignId;
      publishPayload.campaign_snap_id = "";
      publishPayload.campaign_sketch_id = "";
      publishPayload.is_partial_publish = true;
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
      // 克隆过来的广告会继承源广告的开关状态；广告组开着而里面的广告是关的，整组
      // 投不出去。广告的开关跟随广告组的发布状态：组以 disabled 发布就全部保持关闭。
      const enableFailures = publishedStatus === "enabled"
        ? await enableCreatedCreatives(credential, completedCreativeIds(completed))
        : [];
      return {
        ok: true,
        message: enableFailures.length > 0
          ? `同系列复制已发布 ${publishItems.length} 个广告组；${enableFailures.length} 条广告未能自动开启：${enableFailures.join("；")}`
          : `同系列复制已发布 ${publishItems.length} 个广告组`,
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

  /**
   * 发布 TikTok 后台已经存在的草稿广告组。
   *
   * 扩组失败在后台留下的草稿，此前没有任何入口能收口——发布要 snap/sketch 标识，而那是
   * 建草稿时的临时产物，失败记录里一个都没记下。草稿能按名字反查，`snap/save_by_sketch`
   * 能由 sketch 重新生成 snap，于是三步就能发布。契约见 docs/PUBLISH_DRAFT_CONTRACT.md。
   *
   * 与扩组共用 `copy-ads` 能力：同一条创建会话 cURL、同一个发布接口，本质上是把一次已经
   * 授权过的扩组做完最后一步，不是一项新的写入权限。
   *
   * **部分成功要能收口。** 一次扩 3 个组，TikTok 终态回来「广告组 2/3」是常见结果：2 个成了
   * 正式组、1 个停在草稿。`publishedNames` 就是给这种情况用的——调用方证明哪几个已经建成，
   * 这里跳过它们、只发还停在草稿的那些。证不出来的一个都不能跳，判据见
   * `resolveDraftPublishTargets`。
   *
   * **这是创建类写入**：`create_by_snap` 一旦发出，失败一律判 unknown。重试可能把同一个
   * 草稿发布成两个正式广告组。
   */
  async publishExistingDrafts(
    context: ProviderContext,
    input: {
      campaignId: string;
      names: string[];
      initialStatus: "enabled" | "disabled";
      /** 调用方已证明是正式广告组的组名（同系列下、状态不是 `ad_create`）。 */
      publishedNames?: string[];
      onBeforeDispatch?: () => void;
    },
  ): Promise<{ ok: boolean; message: string; adGroupIds?: string[]; failureKind?: "failed" | "unknown"; retrySafe?: boolean }> {
    const credential = CookieCredentialInputSchema.parse(context.credential);
    const sessionRequest = credential.requestTemplates?.find(
      (item) => item.target === "ad-group" && !item.derived,
    );
    if (!sessionRequest) {
      return { ok: false, message: "缺少第 1 步 /adgroup/list/ cURL，无法建立创建会话。", failureKind: "failed", retrySafe: true };
    }
    const profile = credential.creationProfile;
    const riskInfo = profile && isRecord(profile.publishPayload) && isRecord(profile.publishPayload.risk_info)
      ? profile.publishPayload.risk_info
      : {};
    // 两个 dispatchState 是刻意分开的：草稿上的改动（ad_snap/save）再怎么失败都不会产生
    // 正式广告组，只有 create_by_snap 会。把它们混在一起，一次草稿保存失败就会被误报成
    // 「结果未知」，而那正是最该留给真正危险情形的结论。
    const draftState: CreationDispatchState = { mutationDispatched: false, acceptedMutationCount: 0 };
    const publishState: CreationDispatchState = {
      mutationDispatched: false,
      acceptedMutationCount: 0,
      ...(input.onBeforeDispatch ? { onBeforeMutationDispatch: input.onBeforeDispatch } : {}),
    };
    try {
      // 1) 按名字反查草稿。列表是全账户的，翻页翻到把要的都找齐为止。
      const wanted = input.names.map((name) => name.trim()).filter(Boolean);
      if (wanted.length === 0) {
        throw new ConfirmedCreationFailureError("这条记录没有记下组名，无法定位草稿。", true);
      }
      const publishedNames = input.publishedNames ?? [];
      const entries = await readDraftSketches({
        sessionRequest,
        credential,
        dispatchState: draftState,
        // 已经建成的那些**永远不会**出现在草稿列表里。把它们算进停止条件，部分成功的记录
        // 就会每次都把整张草稿表翻到底才罢休。
        stopWhen: (collected) =>
          resolveDraftPublishTargets(wanted, collected, publishedNames).missing.length === 0,
      });
      const targets = resolveDraftPublishTargets(wanted, entries, publishedNames);
      if (targets.missing.length > 0) {
        throw new ConfirmedCreationFailureError(
          `TikTok 后台没有找到唯一对应的草稿：${targets.missing.join("、")}。可能已经发布或已被删除，也可能同名草稿有多份，需要先去后台确认。`,
          true,
        );
      }
      // 全部都已经是正式广告组了：没什么可发的，但这一条确实已经建成，该收口。这不是失败，
      // 报成失败会让调用方把红条继续挂着，而后台已经没有任何东西等着处理了。
      if (targets.matched.length === 0) {
        return {
          ok: true,
          message: `这批广告组已经全部建成，无需发布：${targets.alreadyPublished.join("、")}`,
          adGroupIds: [],
        };
      }
      const matched = targets.matched;
      const skipped = targets.alreadyPublished;
      // 有一类草稿连推广系列本身都还没建：campaign_id 为空、只有 campaign_sketch_id
      // （2026-08-26 生产账户里 9 条草稿中就有 2 条是这样）。发布它们要连系列一起建，
      // 是另一条链路，这里不猜。
      const campaignlessDrafts = matched.filter((entry) => !entry.campaignId);
      if (campaignlessDrafts.length > 0) {
        throw new ConfirmedCreationFailureError(
          `这些草稿连推广系列都还没建（${campaignlessDrafts.map((entry) => entry.adSketchName).join("、")}），需要在 TikTok 后台手动发布。`,
          true,
        );
      }
      // 草稿必须都在这条记录声明的系列下。名字对上但系列不对，说明找到的是另一个系列里
      // 的同名草稿，发下去就发错了地方。
      const foreign = matched.filter((entry) => entry.campaignId && entry.campaignId !== input.campaignId);
      if (foreign.length > 0) {
        throw new ConfirmedCreationFailureError(
          `找到的草稿不在系列 ${input.campaignId} 下（${foreign.map((entry) => entry.adSketchName).join("、")}），已停止发布。`,
          true,
        );
      }
      // 2) 由草稿生成 snap。响应直接给出 sketch → snap 的映射，不必重建表单。
      const saved = await requestCreationStep(
        "snap/save_by_sketch",
        () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/snap/save_by_sketch/", {
          campaign_id: input.campaignId,
          campaign_sketch_id: matched.find((entry) => entry.campaignSketchId)?.campaignSketchId ?? "",
        }),
        credential,
        { semantics: "support" },
      );
      const mapping = parseSketchSnapMapping(saved);
      const publishItems = await resolveDraftPublishItems({
        sessionRequest,
        credential,
        matched,
        mapping,
      });
      // 2.5) 把过期的开始时间顶到现在之后。
      //
      // 契约里说未改动的草稿可以跳过 ad_snap/save——那是对刚建出来的草稿而言。这里要发的
      // 草稿常常已经烂了几天甚至半个月，`start_time` 早就过去了，TikTok 会以
      // validate_start_time_before_now_error 明确拒绝（2026-08-26 真机实测，一条 8/13 的
      // 草稿正是这么被拒的）。只动排期，预算和出价原样保留。
      await refreshStaleDraftSchedules({
        sessionRequest,
        credential,
        dispatchState: draftState,
        campaignId: input.campaignId,
        items: publishItems,
        timezone: context.timezone ?? "UTC",
        riskInfo,
      });
      // 3) 程序化创意要先生成 CTA。抓包里的真机草稿发布没有这一步，因为界面建的草稿自带
      // CTA；而这里的草稿是 ad_snap/copy 克隆出来的，扩组流程正是在复制之后才补这一步，
      // 说明克隆不带可用的 CTA。省掉它会被 TikTok 以缺少行动引导拒绝。
      await requestCreationStep(
        "snap/batch_create_cta_id",
        () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/snap/batch_create_cta_id/", {
          campaign_id: input.campaignId,
          campaign_snap_id: "",
          ad_and_creative_snap_info_list: publishItems.map((item) => ({
            ad_id: "",
            ad_snap_id: item.adSnapId,
            creative_snap_ids: item.creatives.map((creative) => creative.creativeSnapId),
          })),
        }),
        credential,
        { semantics: "support" },
      );
      // 4) 发布。来源标记与新建不同，见 TikTokDraftPublishSource。
      const publishPayload = buildDraftPublishPayload({
        campaignId: input.campaignId,
        items: publishItems,
        initialStatus: input.initialStatus,
        riskInfo,
      });
      const published = await requestCreationStep(
        "create_by_snap",
        () => creationRequest(sessionRequest, "async_creation/create_by_snap", publishPayload),
        credential,
        { semantics: "mutation", dispatchState: publishState },
      );
      const completed = await awaitCreationResult(sessionRequest, credential, published, input.campaignId);
      const completedCounts = completedCreationCounts(completed);
      const officialAdGroupIds = completedAdGroupIds(completed);
      if (
        completedCounts.adGroupCount !== publishItems.length
        || officialAdGroupIds.length !== publishItems.length
      ) {
        throw new UnknownCreationStateError(
          `TikTok 创建终态不完整：广告组 ${completedCounts.adGroupCount}/${publishItems.length}，回读到 ${officialAdGroupIds.length} 个正式 ID；禁止自动重试。`,
        );
      }
      // 草稿是 ad_snap/copy 克隆出来的，里面的广告继承了源广告的开关状态。组开着而广告
      // 是关的，整组照样投不出去——扩组发布后补这一刀，草稿发布同理。
      const enableFailures = input.initialStatus === "enabled"
        ? await enableCreatedCreatives(credential, completedCreativeIds(completed))
        : [];
      return {
        ok: true,
        message: [
          `已发布 ${publishItems.length} 个草稿广告组${input.initialStatus === "disabled" ? "（暂停状态）" : ""}`,
          // 跳过了哪几个必须说出来：不然用户看到「发布了 1 个」而自己明明要的是 3 个，
          // 只会以为又出了问题。
          skipped.length > 0 ? `另有 ${skipped.length} 个此前已经建成，未重复发布：${skipped.join("、")}` : "",
          enableFailures.length > 0
            ? `${enableFailures.length} 条广告未能自动开启：${enableFailures.join("；")}`
            : "",
        ].filter(Boolean).join("；"),
        adGroupIds: officialAdGroupIds,
      };
    } catch (cause) {
      // publishState 只被 create_by_snap 用，所以这个标志正好等于「发布请求离开过本机」。
      // 前面几步都只在草稿上打转：没发出去就没有正式广告组，草稿原样留在后台，可以再点一次。
      const dispatched = publishState.mutationDispatched;
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : "发布草稿失败",
        failureKind: cause instanceof ConfirmedCreationFailureError
          ? "failed"
          : dispatched ? "unknown" : "failed",
        retrySafe: cause instanceof ConfirmedCreationFailureError
          ? cause.retrySafe && publishState.acceptedMutationCount === 0
          : !dispatched,
      };
    }
  }

  /**
   * TikTok 后台现存的草稿广告组。
   *
   * 两个用途：轮询后对账要靠它才判得出「只建了草稿」（草稿在独立命名空间里，**根本不出现在
   * 广告组列表**，只查广告组列表的话这个结论永远做不出来）；界面上的遗留草稿清理也靠它。
   *
   * 纯读，不写任何东西。
   */
  async listDraftAdGroups(context: ProviderContext): Promise<DraftSketchEntry[]> {
    const credential = CookieCredentialInputSchema.parse(context.credential);
    const sessionRequest = credential.requestTemplates?.find(
      (item) => item.target === "ad-group" && !item.derived,
    );
    if (!sessionRequest) {
      throw new RetryableCreationError("缺少第 1 步 /adgroup/list/ cURL，无法读取草稿列表。");
    }
    return readDraftSketches({
      sessionRequest,
      credential,
      dispatchState: { mutationDispatched: false, acceptedMutationCount: 0 },
    });
  }

  /**
   * 删掉指定的草稿广告组。
   *
   * **逐条删而不是一次批量删**：一个坏 ID 会让整批被拒，而这里的调用方是「一键清理」，
   * 半途失败必须能说清哪几条删掉了、哪几条没删。条数本来就小（生产上是个位数）。
   *
   * 只删草稿，不碰任何正式广告组。保护期由调用方（core 的 selectStaleDrafts）把关。
   *
   * **不要在这里加「删完立刻回读确认」**。草稿列表是最终一致的：2026-08-26 真机删掉 8 条，
   * 每条都回 code 0，紧接着回读却有 5 条还在；约一分钟后再查，8 条全都没了。加了立即回读
   * 只会稳定地报出根本不存在的失败。code 0 在这个接口上是可信的。
   */
  async deleteDraftAdGroups(
    context: ProviderContext,
    input: { adSketchIds: string[] },
  ): Promise<{ deleted: string[]; failed: Array<{ adSketchId: string; message: string }> }> {
    const credential = CookieCredentialInputSchema.parse(context.credential);
    const sessionRequest = credential.requestTemplates?.find(
      (item) => item.target === "ad-group" && !item.derived,
    );
    if (!sessionRequest) {
      throw new RetryableCreationError("缺少第 1 步 /adgroup/list/ cURL，无法删除草稿。");
    }
    const dispatchState: CreationDispatchState = { mutationDispatched: false, acceptedMutationCount: 0 };
    const deleted: string[] = [];
    const failed: Array<{ adSketchId: string; message: string }> = [];
    for (const adSketchId of input.adSketchIds.slice(0, DRAFT_DELETE_BATCH_LIMIT)) {
      try {
        await requestCreationStep(
          "ad_sketch/delete",
          () => creationPathRequest(sessionRequest, "/mi/api/v4/i18n/creation/ad_sketch/delete/", {
            ad_sketch_ids: [adSketchId],
          }),
          credential,
          { semantics: "mutation", dispatchState },
        );
        deleted.push(adSketchId);
      } catch (cause) {
        failed.push({
          adSketchId,
          message: cause instanceof Error ? cause.message : "删除草稿失败",
        });
      }
    }
    return { deleted, failed };
  }

  /**
   * 系列级复制：把一个完整推广系列复制成一个新系列，并在发布前把广告组数量调整
   * 到目标值。
   *
   * 链路（与真机后台一致）：
   *   campaign_snap/copy → campaign_snap/save（改名 + 预算）
   *   → ad_sketch/delete（删到目标组数）/ ad_snap/copy（补到目标组数）
   *   → 逐组 ad_snap/save（改名、排期）
   *   → snap/cbo_consistency_check（系列预算专属门禁）
   *   → snap/batch_create_cta_id → async_creation/create_by_snap（一次原子发布）
   *
   * 系列预算(CBO)天然随复制继承，不需要额外设置；只有显式覆盖时才改写金额。
   */
  async copyCampaign(
    context: ProviderContext,
    input: {
      sourceCampaignId: string;
      campaignName: string;
      /** 保留哪些源广告组，以及每个副本的新名称。顺序即发布顺序。 */
      adGroups: Array<{ sourceAdGroupId: string; name: string }>;
      initialStatus: "enabled" | "disabled";
      scheduledStartAt?: string | null;
      /** 覆盖系列日预算；留空表示继承源系列。 */
      campaignBudget?: number | null;
      /** 覆盖每个新广告组的日预算；留空继承源组。仅广告组预算口径适用。 */
      adGroupBudget?: number | null;
      bid?: number | null;
      onBeforeDispatch?: () => void;
    },
  ): Promise<{
    ok: boolean;
    message: string;
    campaignId?: string;
    adGroupIds?: string[];
    failureKind?: "failed" | "unknown";
    retrySafe?: boolean;
  }> {
    const credential = CookieCredentialInputSchema.parse(context.credential);
    const sessionRequest = credential.requestTemplates?.find(
      (item) => item.target === "ad-group" && !item.derived,
    );
    if (!sessionRequest) {
      return { ok: false, message: "缺少第 1 步 /adgroup/list/ cURL，无法建立创建会话。" };
    }
    if (input.adGroups.length === 0) {
      return { ok: false, message: "系列复制至少需要保留一个广告组。" };
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
    let published = false;
    try {
      // 1) 复制整个源系列（含全部广告组与创意）。
      const copied = await requestCreationStep(
        "campaign_snap/copy",
        () => creationPathRequest(sessionRequest, "/mi/api/v4/i18n/creation/campaign_snap/copy/", {
          campaign_id: input.sourceCampaignId,
          name: input.campaignName,
          resp_with_detail: true,
          with_ad: true,
          with_creative: true,
          with_sketch: true,
          risk_info: riskInfo,
        }),
        credential,
        { semantics: "mutation", dispatchState },
      );
      // 只是产生了草稿，尚未发布任何正式对象；此时重试仍是安全的。
      const draft = parseCopiedCampaignDraft(copied);
      copyAccepted = true;

      // 2) 按 origin_ad_id 把草稿组对回源广告组。这是响应里唯一显式的来源标识，
      //    不能退化成按下标猜测——猜错会把创意挂到别的组上且不会报错。
      const byOrigin = new Map<string, CopiedCampaignDraftGroup[]>();
      for (const group of draft.groups) {
        if (!group.originAdGroupId) continue;
        const list = byOrigin.get(group.originAdGroupId) ?? [];
        list.push(group);
        byOrigin.set(group.originAdGroupId, list);
      }
      if (byOrigin.size === 0) {
        throw new RetryableCreationError(
          "系列复制草稿没有回带 origin_ad_id，无法确认每个草稿组来自哪个源广告组；已在发布前停止。",
        );
      }

      const keptGroups: CopiedCampaignDraftGroup[] = [];
      const renames: Array<{ adSnapId: string; name: string }> = [];
      const consumed = new Set<string>();
      // 需要额外复制的（同一个源组要出现多份）留到下一步用 ad_snap/copy 补。
      const pendingDuplicates: Array<{ template: CopiedCampaignDraftGroup; name: string }> = [];
      for (const wanted of input.adGroups) {
        const candidates = byOrigin.get(wanted.sourceAdGroupId);
        if (!candidates || candidates.length === 0) {
          throw new RetryableCreationError(
            `源广告组 ${wanted.sourceAdGroupId} 不在本次系列复制的草稿中；已在发布前停止。`,
          );
        }
        const fresh = candidates.find((group) => !consumed.has(group.adSnapId));
        if (fresh) {
          consumed.add(fresh.adSnapId);
          keptGroups.push(fresh);
          renames.push({ adSnapId: fresh.adSnapId, name: wanted.name });
        } else {
          pendingDuplicates.push({ template: candidates[0]!, name: wanted.name });
        }
      }

      // 3) 删掉没被选中的草稿组。ad_sketch/delete 按 ad_sketch_id 删。
      const unused = draft.groups.filter((group) => !consumed.has(group.adSnapId));
      if (unused.length > 0) {
        await requestCreationStep(
          "ad_sketch/delete",
          () => creationPathRequest(sessionRequest, "/mi/api/v4/i18n/creation/ad_sketch/delete/", {
            ad_sketch_ids: unused.map((group) => group.adSketchId),
          }),
          credential,
          { semantics: "mutation", dispatchState },
        );
      }

      // 4) 需要更多份时，在草稿系列内部复制广告组（用 campaign_snap_id，而不是
      //    面向已发布系列的 existing_campaign_id 变体）。
      for (const duplicate of pendingDuplicates) {
        const copiedGroup = await requestCreationStep(
          "ad_snap/copy",
          () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/ad_snap/copy/", {
            ad_params: [{
              ad_snap_id: duplicate.template.adSnapId,
              name_list: [duplicate.name],
              with_creative_snap_ids: duplicate.template.creativeSnapIds,
            }],
            with_creative: true,
            with_sketch: true,
            resp_with_detail: true,
            is_batch_copy: true,
            campaign_snap_id: draft.campaignSnapId,
            campaign_sketch_id: draft.campaignSketchId,
            risk_info: riskInfo,
          }),
          credential,
          { semantics: "mutation", dispatchState },
        );
        const data = isRecord(copiedGroup.data) ? copiedGroup.data : undefined;
        const allCopy = data && isRecord(data.all_copy_result) ? data.all_copy_result : undefined;
        const list = allCopy && Array.isArray(allCopy.ad_and_creative_copy_result_list)
          ? allCopy.ad_and_creative_copy_result_list.filter(isRecord)
          : [];
        const item = list[0];
        if (!item) {
          throw new UnknownCreationStateError("草稿内广告组复制未返回结果，已停止发布。");
        }
        const adSnap = isRecord(item.new_ad_snap_info_item) ? item.new_ad_snap_info_item : {};
        const adSnapId = nonEmptyId(adSnap.ad_snap_id);
        const adSketchId = nonEmptyId(item.new_ad_sketch_id);
        const creatives = Array.isArray(item.new_creative_snap_info_item_list)
          ? item.new_creative_snap_info_item_list.filter(isRecord)
          : [];
        const creativeSketchIds = Array.isArray(item.new_creative_sketch_ids)
          ? item.new_creative_sketch_ids.map(nonEmptyId).filter((id): id is string => Boolean(id))
          : [];
        const creativeSnapIds = creatives
          .map((creative) => nonEmptyId(creative.creative_snap_id))
          .filter((id): id is string => Boolean(id));
        if (!adSnapId || !adSketchId
          || creativeSnapIds.length === 0
          || creativeSnapIds.length !== creativeSketchIds.length) {
          throw new UnknownCreationStateError("草稿内广告组复制返回的 snap/sketch 标识不完整，已停止发布。");
        }
        keptGroups.push({
          adSnapId,
          adSketchId,
          originAdGroupId: duplicate.template.originAdGroupId,
          creativeSnapIds,
          creativeSketchIds,
        });
        renames.push({ adSnapId, name: duplicate.name });
      }

      // 5) 系列改名 + 预算。复制响应已经带回源系列的完整表单（含 CBO 字段），
      //    只覆盖名称，金额仅在显式指定时归一化后改写。
      const campaignForm = cloneRecord(draft.campaignForm);
      campaignForm.campaign_name = input.campaignName;
      campaignForm.campaign_snap_id = draft.campaignSnapId;
      campaignForm.campaign_sketch_id = draft.campaignSketchId;
      campaignForm.campaign_id = "";
      if (input.campaignBudget !== undefined && input.campaignBudget !== null) {
        campaignForm.budget = formatCampaignBudgetAmount(input.campaignBudget);
      } else if (typeof campaignForm.budget === "string" && campaignForm.budget.trim() !== "") {
        // 复制响应回的是 "88"，而 save 需要 "88.00"。不归一化会让回读校验误判。
        const numeric = Number(campaignForm.budget);
        if (Number.isFinite(numeric) && numeric > 0) {
          campaignForm.budget = formatCampaignBudgetAmount(numeric);
        }
      }
      await requestCreationStep(
        "campaign_snap/save",
        () => creationRequest(sessionRequest, "campaign_snap/save", {
          campaign_sketch_form_data: campaignForm,
          is_from_startup: false,
          with_sketch: true,
          risk_info: riskInfo,
        }),
        credential,
        { semantics: "mutation", dispatchState },
      );

      // 6) 逐组改名/排期。复用既有的「回读 snap/detail 后再保存」逻辑，同时用
      //    回读到的 ad_sketch_id 校正发布项。系列预算下绝不覆盖组预算。
      const publishItems = keptGroups.map(draftGroupToPublishItem);
      await applyCopiedCampaignGroupOverrides({
        sessionRequest,
        credential,
        dispatchState,
        campaignSnapId: draft.campaignSnapId,
        campaignSketchId: draft.campaignSketchId,
        publishItems,
        renames,
        scheduledStart,
        timezone: context.timezone ?? "UTC",
        riskInfo,
        ...(input.bid !== undefined ? { bid: input.bid } : {}),
        ...(input.adGroupBudget !== undefined ? { adGroupBudget: input.adGroupBudget } : {}),
      });

      // 7) 系列预算一致性门禁。真机在每次结构变化后都会调；返回非 all_success
      //    时必须停在发布之前。
      const consistency = await requestCreationStep(
        "snap/cbo_consistency_check",
        () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/snap/cbo_consistency_check/", {
          campaign_snap_id: draft.campaignSnapId,
          adgroup_snap_ids: publishItems.map((item) => item.ad_snap_id),
          ad_snap_ids: publishItems.map((item) => item.ad_snap_id),
          is_budget_split_test: false,
        }),
        credential,
        { semantics: "support", dispatchState },
      );
      const consistencyData = isRecord(consistency.data) ? consistency.data : undefined;
      if (consistencyData && consistencyData.is_all_success === false) {
        throw new ConfirmedCreationFailureError(
          "系列预算一致性校验未通过，已在发布前停止。请检查系列预算与各广告组的出价设置。",
          true,
        );
      }

      // 8) CTA + 发布。新系列用 campaign_snap_id/campaign_sketch_id，整批发布。
      await requestCreationStep(
        "snap/batch_create_cta_id",
        () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/snap/batch_create_cta_id/", {
          campaign_id: "",
          campaign_snap_id: draft.campaignSnapId,
          ad_and_creative_snap_info_list: publishItems.map((item) => ({
            ad_id: "",
            ad_snap_id: item.ad_snap_id,
            creative_snap_ids: item.creative_snap_info_list.map((creative) => creative.creative_snap_id),
          })),
        }),
        credential,
        { semantics: "mutation", dispatchState },
      );
      // 原生定时投放的组以 enabled 发布，由 TikTok 的排期决定何时放行。
      const publishedStatus = scheduledStart ? "enabled" as const : input.initialStatus;
      const publishPayload = profile
        ? materializePublishProfile(profile.publishPayload, {
            campaignSnapId: draft.campaignSnapId,
            campaignSketchId: draft.campaignSketchId,
            publishItems,
            initialStatus: publishedStatus,
          })
        : buildPublishInput({
            campaignSnapId: draft.campaignSnapId,
            campaignSketchId: draft.campaignSketchId,
            adAndCreativeSnapInfoList: publishItems,
          }, publishedStatus);
      publishPayload.campaign_id = "";
      publishPayload.campaign_snap_id = draft.campaignSnapId;
      publishPayload.campaign_sketch_id = draft.campaignSketchId;
      publishPayload.is_partial_publish = false;
      if (scheduledStart && scheduledStart.getTime() <= Date.now()) {
        throw new UnknownCreationStateError("TikTok 原生排期在发布前已到期；草稿已创建，已停止发布并禁止自动重试。");
      }
      const publishedResponse = await requestCreationStep(
        "create_by_snap",
        () => creationRequest(sessionRequest, "async_creation/create_by_snap", publishPayload),
        credential,
        { semantics: "mutation", dispatchState },
      );
      published = true;
      const completed = await awaitCreationResult(sessionRequest, credential, publishedResponse);
      const completedCounts = completedCreationCounts(completed);
      const officialAdGroupIds = completedAdGroupIds(completed);
      const expectedCreativeCount = publishItems.reduce(
        (total, item) => total + item.creative_snap_info_list.length,
        0,
      );
      if (
        completedCounts.adGroupCount !== publishItems.length
        || completedCounts.creativeCount !== expectedCreativeCount
        || officialAdGroupIds.length !== publishItems.length
      ) {
        throw new UnknownCreationStateError(
          `TikTok 创建终态不完整：广告组 ${completedCounts.adGroupCount}/${publishItems.length}，广告 ${completedCounts.creativeCount}/${expectedCreativeCount}；禁止自动重试。`,
        );
      }
      // 同上：克隆出来的广告继承源广告的开关状态，需要显式打开。
      const enableFailures = publishedStatus === "enabled"
        ? await enableCreatedCreatives(credential, completedCreativeIds(completed))
        : [];
      return {
        ok: true,
        message: enableFailures.length > 0
          ? `系列复制已发布 1 个系列、${publishItems.length} 个广告组；${enableFailures.length} 条广告未能自动开启：${enableFailures.join("；")}`
          : `系列复制已发布 1 个系列、${publishItems.length} 个广告组`,
        adGroupIds: officialAdGroupIds,
      };
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : "系列复制失败",
        failureKind: cause instanceof ConfirmedCreationFailureError
          ? "failed"
          : cause instanceof UnknownCreationStateError || published
            ? "unknown"
            : "failed",
        // 只产生草稿时重试是安全的（草稿不投放，也不占用正式系列名）；一旦
        // create_by_snap 发出去，就不再允许自动重试。
        retrySafe: cause instanceof ConfirmedCreationFailureError
          ? cause.retrySafe && !published
          : !published,
      };
    }
  }
}

/**
 * 系列复制专用的逐组保存：只改名字与排期，绝不写组预算——新系列继承源系列的
 * 预算模式，写组预算会直接触发真机的
 * budget_auto_adjust_initial_budget_not_equal_campaign_budget。
 */
async function applyCopiedCampaignGroupOverrides(input: {
  sessionRequest: CapturedCookieRequest;
  credential: ParsedCookieCredential;
  dispatchState: CreationDispatchState;
  campaignSnapId: string;
  campaignSketchId: string;
  publishItems: DraftPublishItem[];
  renames: Array<{ adSnapId: string; name: string }>;
  scheduledStart: Date | null;
  timezone: string;
  riskInfo: Record<string, unknown>;
  bid?: number | null;
  /**
   * 覆盖每个新广告组的日预算。只在广告组预算口径下给值——系列预算(CBO)下组不持有
   * 独立预算，写进去会触发 budget_auto_adjust_initial_budget_not_equal_campaign_budget。
   */
  adGroupBudget?: number | null;
}): Promise<void> {
  const nameBySnapId = new Map(input.renames.map((item) => [item.adSnapId, item.name]));
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
    const formSnapId = nonEmptyId(form.ad_snap_id);
    if (formSnapId && formSnapId !== publishItem.ad_snap_id) {
      throw new UnknownCreationStateError("TikTok 草稿详情的广告组标识不一致，已停止发布。");
    }
    // 以回读到的 sketch id 为准：这是 ad_sketch/delete 与发布共同依赖的标识。
    const formSketchId = nonEmptyId(form.ad_sketch_id);
    if (formSketchId) {
      publishItem.ad_sketch_id = formSketchId;
    } else {
      form.ad_sketch_id = publishItem.ad_sketch_id;
    }
    const name = nameBySnapId.get(publishItem.ad_snap_id);
    if (name) form.ad_name = name;
    if (input.bid !== undefined && input.bid !== null) {
      form.cpa_bid = String(input.bid);
    }
    // 组预算只在显式给值时覆盖；不给就继承源组，保持既有行为。
    if (input.adGroupBudget !== undefined && input.adGroupBudget !== null) {
      form.budget = formatCampaignBudgetAmount(input.adGroupBudget);
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
        campaign_snap_id: input.campaignSnapId,
        campaign_sketch_id: input.campaignSketchId,
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
  for (const publishItem of input.publishItems) {
    const verified = verifiedForms.get(publishItem.ad_snap_id);
    if (!verified) {
      throw new UnknownCreationStateError("TikTok 广告组草稿修改未能回读确认，已停止发布。");
    }
    const name = nameBySnapId.get(publishItem.ad_snap_id);
    if (name && String(verified.ad_name) !== name) {
      throw new UnknownCreationStateError("TikTok 广告组名称未能回读确认，已停止发布。");
    }
    if (startTime && (Number(verified.schedule_type) !== 1 || verified.start_time !== startTime)) {
      throw new UnknownCreationStateError("TikTok 原生排期未能回读确认，已停止发布。");
    }
  }
}

/** 系列级复制里，一个草稿广告组连同它的创意草稿。 */
interface CopiedCampaignDraftGroup {
  adSnapId: string;
  adSketchId: string;
  /** 该草稿组克隆自哪个源广告组（TikTok 在草稿表单里显式回带）。 */
  originAdGroupId: string | null;
  creativeSnapIds: string[];
  creativeSketchIds: string[];
}

interface CopiedCampaignDraft {
  campaignSnapId: string;
  campaignSketchId: string;
  campaignForm: Record<string, unknown>;
  groups: CopiedCampaignDraftGroup[];
}

/**
 * 解析 campaign_snap/copy 的响应。
 *
 * 这里刻意不依赖「响应里两个平行集合按下标一一对应」这个假设——多组场景下一旦
 * 顺序错位，会把 A 组的创意挂到 B 组上，而且发布会成功、不报错。改用显式键：
 * - `new_ad_and_creative_snap_info_item_map` 以 ad_snap_id 为键；
 * - `new_ad_and_creative_sketch_ids_map` 以 ad_sketch_id 为键；
 * - 两者之间的 ad_snap_id ↔ ad_sketch_id 关系由 snap/detail 回读确定。
 */
function parseCopiedCampaignDraft(payload: Record<string, unknown>): CopiedCampaignDraft {
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (!data) throw new UnknownCreationStateError("系列复制响应缺少 data。");
  const campaignItem = isRecord(data.new_campaign_snap_info_item)
    ? data.new_campaign_snap_info_item
    : undefined;
  const campaignSnapId = campaignItem ? nonEmptyId(campaignItem.campaign_snap_id) : undefined;
  const campaignSketchId = nonEmptyId(data.new_campaign_sketch_id);
  const campaignForm = campaignItem && isRecord(campaignItem.campaign_snap_form_data)
    ? campaignItem.campaign_snap_form_data
    : undefined;
  if (!campaignSnapId || !campaignSketchId || !campaignForm) {
    throw new UnknownCreationStateError("系列复制响应缺少系列草稿的 snap/sketch 标识。");
  }
  const adItems = Array.isArray(data.new_ad_snap_info_item_list)
    ? data.new_ad_snap_info_item_list.filter(isRecord)
    : [];
  if (adItems.length === 0) {
    throw new UnknownCreationStateError("系列复制响应没有返回任何广告组草稿。");
  }
  const snapMap = isRecord(data.new_ad_and_creative_snap_info_item_map)
    ? data.new_ad_and_creative_snap_info_item_map
    : {};
  const adSketchIds = Array.isArray(data.new_ad_sketch_ids) ? data.new_ad_sketch_ids : [];
  const sketchMap = isRecord(data.new_ad_and_creative_sketch_ids_map)
    ? data.new_ad_and_creative_sketch_ids_map
    : {};
  if (adSketchIds.length !== adItems.length) {
    throw new UnknownCreationStateError(
      `系列复制响应的广告组草稿与 sketch 数量不一致（${adItems.length} / ${adSketchIds.length}）。`,
    );
  }
  const groups = adItems.map((item, index) => {
    const adSnapId = nonEmptyId(item.ad_snap_id);
    const adSketchId = nonEmptyId(adSketchIds[index]);
    if (!adSnapId || !adSketchId) {
      throw new UnknownCreationStateError(`系列复制响应第 ${index + 1} 个广告组草稿缺少标识。`);
    }
    const form = isRecord(item.ad_snap_form_data) ? item.ad_snap_form_data : {};
    const creativeItems = Array.isArray(snapMap[adSnapId])
      ? (snapMap[adSnapId] as unknown[]).filter(isRecord)
      : [];
    const creativeSketchIds = Array.isArray(sketchMap[adSketchId])
      ? (sketchMap[adSketchId] as unknown[]).map(nonEmptyId).filter((id): id is string => Boolean(id))
      : [];
    const creativeSnapIds = creativeItems
      .map((creative) => nonEmptyId(creative.creative_snap_id))
      .filter((id): id is string => Boolean(id));
    if (creativeSnapIds.length === 0 || creativeSnapIds.length !== creativeSketchIds.length) {
      throw new UnknownCreationStateError(
        `系列复制响应第 ${index + 1} 个广告组的创意草稿映射不完整（snap ${creativeSnapIds.length} / sketch ${creativeSketchIds.length}）。`,
      );
    }
    return {
      adSnapId,
      adSketchId,
      originAdGroupId: nonEmptyId(form.origin_ad_id) ?? null,
      creativeSnapIds,
      creativeSketchIds,
    };
  });
  return { campaignSnapId, campaignSketchId, campaignForm, groups };
}

function draftGroupToPublishItem(group: CopiedCampaignDraftGroup): DraftPublishItem {
  return {
    ad_id: "",
    ad_snap_id: group.adSnapId,
    ad_sketch_id: group.adSketchId,
    need_publish: true,
    creative_snap_info_list: group.creativeSnapIds.map((creativeSnapId, index) => ({
      creative_id: "",
      creative_snap_id: creativeSnapId,
      creative_sketch_id: group.creativeSketchIds[index] ?? "",
      need_publish: true as const,
    })),
  };
}

/**
 * 把复制出来的创意草稿改成与创建流程一致的自动优化组合。
 *
 * 扩组走的是 TikTok 的 `ad_snap/copy`（with_creative），新组的自动优化是从**源组
 * 克隆**来的，不是我们生成的。源组是早期建的时候，那套设置往往是空的或过时的，
 * 于是扩出来的新组也一直是老的——用户只能重新走一遍创建流程（导表格）才拿得到
 * 当前这套组合。这里在发布前直接改草稿，扩组就不必再绕这一圈。
 *
 * 组合取 DefaultTikTokCreativeAutomationStrategyIds，与创建路径同一个事实源。
 * 这里**不**先问 creative_automation_option 拿「账户支持哪些」：那个接口要按完整
 * 投放上下文提问（objective_type / optimize_goal / external_action / 版位…），而复制
 * 路径手里只有源组 ID，凑不出这些参数；问得不对反而会拿到一份更窄的列表。
 *
 * 刻意做成**失败不阻断**：自动优化是锦上添花，不该让一整批扩组因为它整批失败。
 * 任何一步出错就保持原样发布，与加这段之前的行为完全一致。
 */
async function applyCopiedCreativeAutomationStrategies(input: {
  sessionRequest: CapturedCookieRequest;
  credential: ParsedCookieCredential;
  dispatchState: CreationDispatchState;
  publishItems: DraftPublishItem[];
  riskInfo: Record<string, unknown>;
}): Promise<DraftPublishItem[]> {
  const strategyIds = [...new Set<string>(DefaultTikTokCreativeAutomationStrategyIds)];
  if (strategyIds.length === 0) return input.publishItems;

  const result: DraftPublishItem[] = [];
  for (const publishItem of input.publishItems) {
    try {
      const creativeSketchIds = publishItem.creative_snap_info_list
        .map((creative) => creative.creative_sketch_id)
        .filter(Boolean);
      if (creativeSketchIds.length === 0) { result.push(publishItem); continue; }

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
      if (!detailMap) { result.push(publishItem); continue; }

      const forms = publishItem.creative_snap_info_list.map((creative) => {
        const entry: unknown = detailMap[creative.creative_sketch_id];
        const info = isRecord(entry) ? entry : undefined;
        const rawForm = info && isRecord(info.asset_group_sketch_form_data)
          ? info.asset_group_sketch_form_data
          : undefined;
        if (!rawForm) return null;
        return {
          ...cloneRecord(rawForm),
          // 原地更新这份草稿，不是新建一份：带上它自己的 snap id。
          creative_snap_id: creative.creative_snap_id,
          creative_sketch_id: creative.creative_sketch_id,
          creative_automation_type: 2,
          creative_automation_list: [...strategyIds],
        };
      });
      if (forms.some((form) => form === null)) { result.push(publishItem); continue; }

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
      const snapIds = savedData && Array.isArray(savedData.creative_snap_ids)
        ? savedData.creative_snap_ids.map(nonEmptyId).filter((id): id is string => Boolean(id))
        : [];
      const sketchIds = savedData && Array.isArray(savedData.creative_sketch_ids)
        ? savedData.creative_sketch_ids.map(nonEmptyId).filter((id): id is string => Boolean(id))
        : [];
      // 保存成功但没回全 ID 时保持原样发布：拿半套 ID 去发布只会更糟。
      if (snapIds.length !== forms.length || sketchIds.length !== forms.length) {
        result.push(publishItem);
        continue;
      }
      result.push({
        ...publishItem,
        creative_snap_info_list: snapIds.map((creativeSnapId, index) => ({
          creative_id: "",
          creative_snap_id: creativeSnapId,
          creative_sketch_id: sketchIds[index]!,
          need_publish: true as const,
        })),
      });
    } catch {
      // 见上：自动优化改不动就按源组原样发布，绝不因此让扩组失败。
      result.push(publishItem);
    }
  }
  return result;
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

type CookieSketchKind = "campaign" | "ad" | "creative";

async function listAllSketchRows(input: {
  kind: CookieSketchKind;
  sessionRequest: CapturedCookieRequest;
  credential: ParsedCookieCredential;
  dispatchState: CreationDispatchState;
  semantics: "preflight-read" | "result-query";
}): Promise<Record<string, unknown>[]> {
  const limit = 100;
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const payload = await requestCreationStep(
      `statistics/sketch/${input.kind}/list 第 ${page} 页`,
      () => creationPathRequest(
        input.sessionRequest,
        `/api/v4/i18n/statistics/sketch/${input.kind}/list/`,
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
      { semantics: input.semantics, dispatchState: input.dispatchState },
    );
    const data = isRecord(payload.data) ? payload.data : undefined;
    const pagination = data && isRecord(data.pagination) ? data.pagination : undefined;
    const pageRows = data && Array.isArray(data.table) ? data.table.filter(isRecord) : undefined;
    if (!data || !pagination || !pageRows) {
      // Draft inspection is an isolation aid before publish. Some older Cookie
      // sessions do not expose these list contracts; partial publish plus the
      // mandatory post-publish six-list reconciliation remains authoritative.
      if (input.semantics === "preflight-read") return [];
      throw new RetryableCreationError(
        `statistics/sketch/${input.kind}/list 缺少完整列表或分页结构。`,
      );
    }
    const responsePage = Number(pagination.page);
    const pageCount = Number(pagination.page_count);
    const responseLimit = Number(pagination.limit);
    const totalCount = Number(pagination.total_count);
    const expectedPageCount = totalCount === 0 ? 0 : Math.ceil(totalCount / responseLimit);
    if (
      !Number.isInteger(responsePage)
      || responsePage !== page
      || !Number.isInteger(pageCount)
      || pageCount < 0
      || !Number.isInteger(responseLimit)
      || responseLimit < 1
      || !Number.isInteger(totalCount)
      || totalCount < 0
      || pageCount !== expectedPageCount
      || pageRows.length > responseLimit
    ) {
      if (input.semantics === "preflight-read") return [];
      throw new RetryableCreationError(
        `statistics/sketch/${input.kind}/list 分页结构不一致。`,
      );
    }
    rows.push(...pageRows);
    if (pageCount === 0 || page >= pageCount) {
      if (rows.length !== totalCount) {
        if (input.semantics === "preflight-read") return [];
        throw new RetryableCreationError(
          `statistics/sketch/${input.kind}/list 返回条数与 total_count 不一致。`,
        );
      }
      return rows;
    }
  }
  throw new RetryableCreationError(
    `statistics/sketch/${input.kind}/list 超过 100 页，无法确认草稿全集。`,
  );
}

function sketchRowIds(
  rows: Record<string, unknown>[],
  kind: CookieSketchKind,
): Set<string> {
  const key = kind === "campaign"
    ? "campaign_sketch_id"
    : kind === "ad" ? "ad_sketch_id" : "creative_sketch_id";
  return new Set(
    rows.map((row) => nonEmptyId(row[key])).filter((id): id is string => Boolean(id)),
  );
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

interface CookieDraftBatchState {
  campaignId?: string;
  campaignSnapId?: string;
  campaignSketchId?: string;
  checkedFakeCampaignId?: string;
  campaignResponse?: Record<string, unknown>;
}

interface CookieDraftReservation {
  campaignId?: string;
  adGroupNames: Set<string>;
  /** One account-scoped live-directory result, resolved before any draft write. */
}

interface PreparedCookieDraft {
  kind: "prepared";
  mutation: CreationMutation;
  row: CreationMutation["row"];
  existingCampaignId?: string;
  campaignSnapId: string;
  campaignSketchId: string;
  checkedFakeCampaignId: string;
  publishItem: DraftPublishItem;
  riskInfo: Record<string, unknown>;
  dispatchState: CreationDispatchState;
  /** 本行被跳过的授权码，随发布结果一起报给用户。 */
  skippedVideoCodes?: string[];
}

interface CookieDraftPreflight {
  adGroupPayloads: Record<string, unknown>[];
  campaignPayloads: Record<string, unknown>[];
  resolvedVideos: ResolvedVideo[];
  baseline: CookieCreationBaseline;
}

interface CookieCreationBaseline {
  campaignIds: Set<string>;
  adGroupIds: Set<string>;
  campaignSketchIds: Set<string>;
  adSketchIds: Set<string>;
  creativeSketchIds: Set<string>;
  campaignSketchRows: Record<string, unknown>[];
  adSketchRows: Record<string, unknown>[];
  creativeSketchRows: Record<string, unknown>[];
}

/**
 * 批量创建的外壳：只负责给整批攒请求体留证，然后无论成败都交出去。
 *
 * 留证放在这一层而不是逐个 return 点，是因为批量路径有七八个提前返回的分支，
 * 逐个补必然漏掉一两个——而漏掉的那个多半就是下次要查的那个。
 */
async function createCookieDraftBatch(
  sessionRequest: CapturedCookieRequest,
  campaignObjectRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  mutations: CreationMutation[],
  timezone: string,
  batchReservation: CookieDraftReservation,
): Promise<CreationMutationResult[]> {
  const recorder = createSentRequestRecorder();
  let lastPhase: LaunchCreationProgress["phase"] = "validation";
  const tracked = mutations.map((mutation): CreationMutation => ({
    ...mutation,
    onProgress: (progress) => {
      lastPhase = progress.phase;
      mutation.onProgress?.(progress);
    },
  }));
  try {
    return await runCookieDraftBatch(
      sessionRequest,
      campaignObjectRequest,
      credential,
      tracked,
      timezone,
      batchReservation,
      recorder,
    );
  } finally {
    const sentRequests = recorder.drain();
    if (sentRequests.length > 0) {
      // 整批共用同一份报文（一个系列草稿带 N 个广告组），逐条都交一份，
      // 这样任何一条失败记录单独拿出来都是自洽的。
      for (const mutation of mutations) {
        mutation.onProgress?.({ phase: lastPhase, evidence: { sentRequests } });
      }
    }
  }
}

async function runCookieDraftBatch(
  sessionRequest: CapturedCookieRequest,
  campaignObjectRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  mutations: CreationMutation[],
  timezone: string,
  batchReservation: CookieDraftReservation,
  recorder: ReturnType<typeof createSentRequestRecorder>,
): Promise<CreationMutationResult[]> {
  const batchState: CookieDraftBatchState = {
    ...(batchReservation.campaignId ? { campaignId: batchReservation.campaignId } : {}),
  };
  const prepared: PreparedCookieDraft[] = [];
  const failures: CreationMutationResult[] = [];
  const draftFailures: CreationMutationResult[] = [];
  const reconcileOnly = mutations.every((mutation) => mutation.reconcileOnly === true);
  if (!reconcileOnly && mutations.some((mutation) => mutation.reconcileOnly === true)) {
    const cause = new RetryableCreationError("同系列批次不能混合新建任务与只读核验任务。");
    return mutations.map((mutation) => creationFailureResult(mutation, cause, {
      mutationDispatched: false,
      acceptedMutationCount: 0,
    }));
  }

  // Resolve the complete remote object baseline and every spreadsheet material
  // before saving the first campaign/ad-group draft. A bad authorization code
  // must be a correctable row error, never an orphan TikTok draft.
  const preflightDispatchState: CreationDispatchState = {
    mutationDispatched: false,
    acceptedMutationCount: 0,
    recordRequest: recorder.record,
  };
  try {
    for (const mutation of mutations) assertStaticCreationMutation(credential, mutation);
  } catch (cause) {
    return mutations.map((mutation) => creationFailureResult(
      mutation,
      cause,
      preflightDispatchState,
    ));
  }
  const requestedNameCounts = new Map<string, number>();
  for (const mutation of mutations) {
    const name = mutation.row.adGroupName.trim();
    requestedNameCounts.set(name, (requestedNameCounts.get(name) ?? 0) + 1);
  }
  const duplicateNames = [...requestedNameCounts]
    .filter(([, count]) => count > 1)
    .map(([name]) => name);
  if (duplicateNames.length > 0) {
    const cause = new RetryableCreationError(
      `同系列批次存在重复广告组名称：${duplicateNames.join("、")}；系统不会擅自添加后缀，请修正表格后重试。`,
    );
    return mutations.map((mutation) => creationFailureResult(
      mutation,
      cause,
      preflightDispatchState,
    ));
  }
  let adGroupPayloads: Record<string, unknown>[];
  let campaignPayloads: Record<string, unknown>[];
  let reconcileAdPayloads: Record<string, unknown>[] = [];
  let baseline: CookieCreationBaseline;
  let library = new Map<string, ResolvedVideo>();
  try {
    adGroupPayloads = await requestCompleteListPages(
      "adgroup/list",
      sessionRequest,
      credential,
      preflightDispatchState,
    );
    campaignPayloads = await requestCompleteListPages(
      "campaign/list",
      campaignObjectRequest,
      credential,
      preflightDispatchState,
    );
    const campaignSketchRows = await listAllSketchRows({
      kind: "campaign",
      sessionRequest,
      credential,
      dispatchState: preflightDispatchState,
      semantics: "preflight-read",
    });
    const adSketchRows = await listAllSketchRows({
      kind: "ad",
      sessionRequest,
      credential,
      dispatchState: preflightDispatchState,
      semantics: "preflight-read",
    });
    const creativeSketchRows = await listAllSketchRows({
      kind: "creative",
      sessionRequest,
      credential,
      dispatchState: preflightDispatchState,
      semantics: "preflight-read",
    });
    if (reconcileOnly) {
      const adRequest = deriveFinalAdReadRequest(sessionRequest);
      if (!adRequest) {
        throw new RetryableCreationError("当前 Cookie 会话无法派生正式广告列表请求，不能执行只读结果核验。");
      }
      reconcileAdPayloads = await requestCompleteListPages(
        "ad/list",
        adRequest,
        credential,
        preflightDispatchState,
      );
    }
    baseline = {
      campaignIds: new Set(
        campaignPayloads
          .flatMap((payload) => extractEntities(payload, "campaign"))
          .map((entity) => entity.externalId),
      ),
      adGroupIds: new Set(
        adGroupPayloads
          .flatMap((payload) => extractEntities(payload, "ad-group"))
          .map((entity) => entity.externalId),
      ),
      campaignSketchIds: sketchRowIds(campaignSketchRows, "campaign"),
      adSketchIds: sketchRowIds(adSketchRows, "ad"),
      creativeSketchIds: sketchRowIds(creativeSketchRows, "creative"),
      campaignSketchRows,
      adSketchRows,
      creativeSketchRows,
    };
    const authorizationCodes = reconcileOnly ? [] : [...new Set(mutations.flatMap((mutation) => {
      if (mutation.originalPosts?.length) return [];
      const codes = splitVideoCodes(mutation.row.videoCode);
      return (codes.length > 0 ? codes : [mutation.row.videoCode])
        .filter((code) => code.startsWith("#"));
    }))];
    if (authorizationCodes.length > 0) {
      library = await resolveVideoCodesFromLibrary(
        sessionRequest,
        credential,
        authorizationCodes,
        preflightDispatchState,
      );
    }
  } catch (cause) {
    return mutations.map((mutation) => creationFailureResult(
      mutation,
      cause,
      preflightDispatchState,
    ));
  }

  if (reconcileOnly) {
    return reconcileExistingCookieBatch(
      mutations,
      campaignPayloads,
      adGroupPayloads,
      reconcileAdPayloads,
      baseline,
    );
  }

  const ready: Array<{ mutation: CreationMutation; resolvedVideos: ResolvedVideo[]; skippedCodes: string[] }> = [];
  for (const mutation of mutations) {
    const dispatchState: CreationDispatchState = {
      mutationDispatched: false,
      acceptedMutationCount: 0,
      recordRequest: recorder.record,
      ...(mutation.onBeforeDispatch
        ? { onBeforeMutationDispatch: mutation.onBeforeDispatch }
        : {}),
    };
    const skippedCodes: string[] = [];
    try {
      ready.push({
        mutation,
        skippedCodes,
        resolvedVideos: mutation.originalPosts?.length
          ? mutation.originalPosts.map((post) => ({
              itemId: post.itemId,
              identityId: post.identityId,
              identityType: post.identityType,
              ...(post.identityBcId ? { identityBcId: post.identityBcId } : {}),
              vid: post.vid,
            }))
          : await resolveTikTokVideos(
              mutation,
              sessionRequest,
              credential,
              library,
              dispatchState,
              skippedCodes,
            ),
      });
    } catch (cause) {
      failures.push(creationFailureResult(mutation, cause, dispatchState));
    }
  }

  for (const { mutation, resolvedVideos, skippedCodes } of ready) {
    const dispatchState: CreationDispatchState = {
      mutationDispatched: false,
      acceptedMutationCount: 0,
      recordRequest: recorder.record,
      ...(mutation.onBeforeDispatch
        ? { onBeforeMutationDispatch: mutation.onBeforeDispatch }
        : {}),
    };
    try {
      const preparedItem = await runCookieDraftChain(
        sessionRequest,
        campaignObjectRequest,
        credential,
        mutation,
        timezone,
        dispatchState,
        batchReservation,
        batchState,
        { adGroupPayloads, campaignPayloads, resolvedVideos, baseline },
      );
      // 跳过的素材必须跟着这条任务的结果一起报出去。
      if (skippedCodes.length > 0) preparedItem.skippedVideoCodes = skippedCodes;
      prepared.push(preparedItem);
    } catch (cause) {
      const failure = creationFailureResult(mutation, cause, dispatchState);
      failures.push(failure);
      draftFailures.push(failure);
    }
  }

  if (prepared.length === 0) return failures;
  if (draftFailures.length > 0) {
    const cause = new UnknownCreationStateError(
      "同系列草稿未全部完成，系统已停止发布；现有草稿必须先通过 Cookie 远端核验并收敛，禁止直接重试。",
    );
    return [
      ...prepared.map((item) => creationFailureResult(item.mutation, cause, item.dispatchState)),
      ...failures,
    ];
  }
  const first = prepared[0]!;
  const publishItems = prepared.map((item) => item.publishItem);
  const combinedDispatchState: CreationDispatchState = {
    mutationDispatched: prepared.some((item) => item.dispatchState.mutationDispatched),
    acceptedMutationCount: prepared.reduce(
      (total, item) => total + item.dispatchState.acceptedMutationCount,
      0,
    ),
    recordRequest: recorder.record,
    onBeforeMutationDispatch: () => {
      for (const item of prepared) item.dispatchState.onBeforeMutationDispatch?.();
    },
  };
  try {
    // 直接拿建草稿时的 snap 发布，不再走 snap/save_by_sketch 重铸。
    //
    // 重铸是 2026-08-08 为修 uaa_campaign_automation_inconsistent_error 加的，理由是
    // 「系列层的 automation 字段在建草稿之后才被归一化，发布时元组对不上」。而那个
    // 前提在 1.4.85 已经不成立了：dedicate_type / universal_type_default_on /
    // promotion_scenario 与 spc 模式的层级现在保存时就按真机取值，没有需要被归一化的
    // 漂移。
    //
    // 2026-08-27 的真机抓包证明这一步本身就是分歧：一次完整的成功创建里
    // snap/save_by_sketch 一次都没出现过，发布前调的是 snap/cbo_consistency_check、
    // campaign_snap/check、ad_creative_snap/check、snap/batch_create_cta_id。重铸还会
    // 连带把 sketch_publish_source 改成 2，而真机恒为 1——等于用另一套发布语义提交。
    const publishCampaignSnapId = first.campaignSnapId;
    const publishList = publishItems;
    const advisoryFailures = await runAdvisoryDraftSequence(sessionRequest, credential, {
      ...(first.existingCampaignId ? { campaignId: first.existingCampaignId } : {}),
      campaignSnapId: publishCampaignSnapId,
      campaignSketchId: first.campaignSketchId,
      publishItems: publishList,
      ...(first.checkedFakeCampaignId ? { fakeCampaignId: first.checkedFakeCampaignId } : {}),
      riskInfo: first.riskInfo,
    }, combinedDispatchState);
    if (advisoryFailures.length > 0) {
      for (const item of prepared) {
        item.mutation.onProgress?.({
          phase: "publishing",
          evidence: { advisoryFailures },
        });
      }
    }
    const publishPayload = credential.creationProfile
      ? materializePublishProfile(credential.creationProfile.publishPayload, {
          ...(first.existingCampaignId ? { campaignId: first.existingCampaignId } : {}),
          campaignSnapId: publishCampaignSnapId,
          campaignSketchId: first.campaignSketchId,
          publishItems: publishList,
          initialStatus: first.mutation.initialStatus,
        })
      : buildPublishInput({
          campaignSnapId: publishCampaignSnapId || first.existingCampaignId!,
          campaignSketchId: first.campaignSketchId || first.existingCampaignId!,
          adAndCreativeSnapInfoList: publishList,
        }, first.mutation.initialStatus);
    if (first.existingCampaignId) {
      publishPayload.campaign_id = first.existingCampaignId;
      publishPayload.campaign_snap_id = "";
      publishPayload.campaign_sketch_id = "";
    }
    publishPayload.is_partial_publish = Boolean(first.existingCampaignId);
    for (const item of prepared) item.mutation.onProgress?.({ phase: "publishing", evidence: {} });
    const published = await requestCreationStep(
      "create_by_snap",
      () => creationRequest(sessionRequest, "async_creation/create_by_snap", publishPayload),
      credential,
      { semantics: "mutation", dispatchState: combinedDispatchState },
    );
    const asyncRequestId = responseId(published, "async_request_id");
    const providerRequestId = responseId(published, "request_id");
    for (const item of prepared) {
      item.mutation.onProgress?.({
        phase: "publishing",
        evidence: {
          ...(asyncRequestId ? { asyncRequestId } : {}),
          ...(providerRequestId ? { providerRequestId } : {}),
        },
      });
    }
    let completed: Record<string, unknown> | undefined;
    let terminalError: unknown;
    try {
      completed = await awaitCreationResult(
        sessionRequest,
        credential,
        published,
        first.existingCampaignId,
      );
    } catch (cause) {
      // async_creation/detail is progress evidence, not the final authority.
      // A timeout or contradictory result must still be reconciled against the
      // Cookie formal-object and sketch lists before the item is classified.
      terminalError = cause;
    }
    for (const item of prepared) {
      item.mutation.onProgress?.({ phase: "readback", evidence: {} });
    }
    const readback = await verifyPublishedCookieBatch({
      sessionRequest,
      campaignObjectRequest,
      credential,
      prepared,
      baseline,
      dispatchState: combinedDispatchState,
      ...(completed ? { completed } : {}),
      ...(terminalError ? { terminalError } : {}),
    });
    // 收尾：把本次建出来的广告显式打开。
    //
    // 克隆出来的广告继承源广告的开关状态，广告组开着而广告关着，整组投不出去。
    // 1.4.31 只把这段接在 copyCampaign / copyAdGroupToExistingCampaign 上，漏了
    // createFromPreset——而跨账户迁移（launch plan mode=copy）走的正是这条，
    // 2026-08-08 生产上因此有 9 个广告组处于「组开着广告关着」。
    //
    // 安全边界与另外两条路一致：只处理本次发布回读到的广告 ID，不碰存量对象；
    // 只在广告组以 enabled 发布时才开；开启失败不推翻整次创建（广告组已经建好，
    // 判成失败会诱发重复创建），失败信息挂到对应条目的 warning 上。
    const createdAdIds = readback.flatMap((outcome) =>
      "error" in outcome || !outcome.ids.adId ? [] : [outcome.ids.adId]);
    const enableFailures = first.mutation.initialStatus === "enabled"
      ? await enableCreatedCreatives(credential, createdAdIds)
      : [];
    const enableWarning = enableFailures.length > 0
      ? `${enableFailures.length} 条广告未能自动开启：${enableFailures.join("；")}`
      : "";
    return [
      ...prepared.map((item, index): CreationMutationResult => {
        const outcome = readback[index]!;
        if ("error" in outcome) {
          return creationFailureResult(item.mutation, outcome.error, item.dispatchState);
        }
        const ids = outcome.ids;
        const warning = [
          ids.warning,
          enableWarning,
          item.skippedVideoCodes?.length ? skippedMaterialWarning(item.skippedVideoCodes) : "",
        ].filter(Boolean).join("；");
        return {
          ...item.mutation,
          row: item.row,
          ok: true,
          campaignId: ids.campaignId,
          adGroupId: ids.adGroupId,
          ...(ids.adId ? { adId: ids.adId } : {}),
          ...(warning ? { warning } : {}),
          message: `TikTok 已同步发布同系列 ${prepared.length} 个广告组。`,
        };
      }),
      ...failures,
    ];
  } catch (cause) {
    return [
      ...prepared.map((item) => creationFailureResult(item.mutation, cause, combinedDispatchState)),
      ...failures,
    ];
  }
}

interface CookieRemoteCreationSnapshot {
  campaigns: ProviderEntity[];
  adGroups: ProviderEntity[];
  ads: ProviderEntity[];
  campaignSketchIds: Set<string>;
  adSketchIds: Set<string>;
  creativeSketchIds: Set<string>;
}

type VerifiedCreationIds = {
  campaignId: string;
  adGroupId: string;
  adId?: string;
  warning?: string;
};

type VerifiedCreationOutcome =
  | { ids: VerifiedCreationIds }
  | { error: Error };

interface CookieSnapshotReconciliation {
  ids: Array<VerifiedCreationIds | null>;
  reasons: string[];
}

function reconcileExistingCookieBatch(
  mutations: CreationMutation[],
  campaignPayloads: Record<string, unknown>[],
  adGroupPayloads: Record<string, unknown>[],
  adPayloads: Record<string, unknown>[],
  baseline: CookieCreationBaseline,
): CreationMutationResult[] {
  const campaigns = campaignPayloads.flatMap((payload) => extractEntities(payload, "campaign"));
  const adGroups = adGroupPayloads.flatMap((payload) => extractEntities(payload, "ad-group"));
  const ads = adPayloads.flatMap((payload) => extractEntities(payload, "ad"));
  const campaignName = mutations[0]?.row.campaignName.trim() ?? "";
  const campaignCandidates = campaigns.filter(
    (entity) => normalizeProviderEntity(entity).name.trim() === campaignName,
  );
  const matchingCampaignDraft = reconciliationDraftExists(
    mutations[0]!,
    baseline,
    "campaign",
    campaignName,
  );
  if (campaignCandidates.length === 0) {
    return mutations.map((mutation) => matchingCampaignDraft
      ? unknownReconciliationResult(
          mutation,
          `系列“${campaignName}”仍存在本任务草稿，正式结果尚未收敛。`,
        )
      : retryableReconciliationResult(
          mutation,
          `系列“${campaignName}”没有正式对象且没有本任务草稿，已确认本次未创建成功。`,
        ));
  }
  if (campaignCandidates.length !== 1) {
    return mutations.map((mutation) => unknownReconciliationResult(
      mutation,
      `系列“${campaignName}”在 Cookie 正式列表中匹配 ${campaignCandidates.length} 个，尚不能确认创建成功。`,
    ));
  }
  const campaignId = campaignCandidates[0]!.externalId;
  return mutations.map((mutation): CreationMutationResult => {
    mutation.onProgress?.({ phase: "readback", evidence: {} });
    const groupCandidates = adGroups.filter((entity) => {
      const normalized = normalizeProviderEntity(entity);
      return normalized.parentCampaignId === campaignId
        && normalized.name.trim() === mutation.row.adGroupName.trim();
    });
    const matchingAdDraft = reconciliationDraftExists(
      mutation,
      baseline,
      "ad",
      mutation.row.adGroupName.trim(),
    );
    if (groupCandidates.length === 0) {
      return matchingAdDraft
        ? unknownReconciliationResult(
            mutation,
            `广告组“${mutation.row.adGroupName}”仍存在本任务草稿，正式结果尚未收敛。`,
          )
        : retryableReconciliationResult(
            mutation,
            `广告组“${mutation.row.adGroupName}”没有正式对象且没有本任务草稿，已确认本条未创建成功。`,
          );
    }
    if (groupCandidates.length !== 1) {
      return unknownReconciliationResult(
        mutation,
        `广告组“${mutation.row.adGroupName}”在 Cookie 正式列表中匹配 ${groupCandidates.length} 个，尚不能确认创建成功。`,
      );
    }
    const adGroupId = groupCandidates[0]!.externalId;
    const adCandidates = ads.filter((entity) => {
      const normalized = normalizeProviderEntity(entity);
      return normalized.parentAdGroupId === adGroupId
        && normalized.name.trim() === mutation.row.adName.trim();
    });
    const matchingCreativeDraft = reconciliationDraftExists(
      mutation,
      baseline,
      "creative",
      mutation.row.adName.trim(),
    );
    const warning = adCandidates.length === 0
      ? materialSkippedWarning(mutation, matchingCreativeDraft)
      : matchingCreativeDraft
        ? "素材提示：广告组已创建成功，TikTok 仍保留本任务的素材草稿。"
        : undefined;
    return {
      ...mutation,
      ok: true,
      campaignId,
      adGroupId,
      ...(adCandidates[0]?.externalId ? { adId: adCandidates[0].externalId } : {}),
      ...(warning ? { warning } : {}),
      message: warning
        ? "Cookie 远端重新核验已确认广告组创建成功，素材结果仅作提示。"
        : "Cookie 远端重新核验已确认系列和广告组创建成功。",
    };
  });
}

function materialSkippedWarning(
  mutation: CreationMutation,
  draftStillExists = false,
): string {
  const materialCount = mutation.originalPosts?.length
    ?? Math.max(1, splitVideoCodes(mutation.row.videoCode).length);
  return `素材提示：广告组已创建成功，但 TikTok 未生成广告“${mutation.row.adName}”；已跳过 ${materialCount} 条素材${draftStillExists ? "，远端仍可见素材草稿" : ""}。`;
}

function unknownReconciliationResult(
  mutation: CreationMutation,
  message: string,
): CreationMutationResult {
  return {
    ...mutation,
    ok: false,
    failureKind: "unknown",
    retrySafe: false,
    message: `${message} 本次只执行远端查询，未发送任何新建或发布请求。`,
  };
}

function retryableReconciliationResult(
  mutation: CreationMutation,
  message: string,
): CreationMutationResult {
  return {
    ...mutation,
    ok: false,
    failureKind: "retryable",
    retrySafe: true,
    reconciliationVerifiedAbsent: true,
    message: `${message} 本次只执行远端查询，未发送任何新建或发布请求。`,
  };
}

function sketchRowName(
  row: Record<string, unknown>,
  kind: CookieSketchKind,
): string {
  const keys = kind === "campaign"
    ? ["campaign_sketch_name", "campaign_name", "name"]
    : kind === "ad"
      ? ["ad_sketch_name", "ad_name", "adgroup_name", "name"]
      : ["creative_sketch_name", "creative_name", "name"];
  return keys.map((key) => row[key]).find((value) => typeof value === "string")?.toString().trim() ?? "";
}

function reconciliationDraftExists(
  mutation: CreationMutation,
  baseline: CookieCreationBaseline,
  kind: CookieSketchKind,
  legacyName: string,
): boolean {
  const trackedId = kind === "campaign"
    ? mutation.reconcileEvidence?.campaignSketchId
    : kind === "ad"
      ? mutation.reconcileEvidence?.adGroupSketchId
      : mutation.reconcileEvidence?.creativeSketchId;
  if (trackedId) {
    const rows = kind === "campaign"
      ? baseline.campaignSketchRows
      : kind === "ad" ? baseline.adSketchRows : baseline.creativeSketchRows;
    const idKeys = kind === "campaign"
      ? ["campaign_sketch_id"]
      : kind === "ad" ? ["ad_sketch_id"] : ["creative_sketch_id"];
    return rows.some((row) =>
      idKeys.some((key) => nonEmptyId(row[key]) === trackedId)
      && sketchRowName(row, kind) === legacyName,
    );
  }
  // Legacy unknown tasks did not persist sketch ids. Name matching is kept only
  // for those records; new tasks always use their exact tracked evidence.
  const rows = kind === "campaign"
    ? baseline.campaignSketchRows
    : kind === "ad" ? baseline.adSketchRows : baseline.creativeSketchRows;
  return rows.some((row) => sketchRowName(row, kind) === legacyName);
}

async function verifyPublishedCookieBatch(input: {
  sessionRequest: CapturedCookieRequest;
  campaignObjectRequest: CapturedCookieRequest;
  credential: ParsedCookieCredential;
  prepared: PreparedCookieDraft[];
  baseline: CookieCreationBaseline;
  dispatchState: CreationDispatchState;
  completed?: Record<string, unknown>;
  terminalError?: unknown;
}): Promise<VerifiedCreationOutcome[]> {
  const completedIds = input.completed
    ? creationBatchResultIds(input.completed, input.prepared[0]?.existingCampaignId)
    : [];
  const completedByAdSnapId = new Map(
    completedIds.map((ids) => [ids.byAdSnapId, ids]),
  );
  const attempts = input.terminalError instanceof ConfirmedCreationFailureError ? 1 : 8;
  let lastReason = "Cookie 远端列表尚未出现本批次的完整正式对象。";
  let lastReadError: unknown;
  let lastReconciliation: CookieSnapshotReconciliation | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0 && !process.env.VITEST) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    let snapshot: CookieRemoteCreationSnapshot;
    try {
      snapshot = await readCookieCreationSnapshot(input);
      lastReadError = undefined;
    } catch (cause) {
      lastReadError = cause;
      lastReason = cause instanceof Error ? cause.message : "Cookie 远端核验请求失败。";
      continue;
    }
    const reconciled = reconcileCookieCreationSnapshot(
      snapshot,
      input.prepared,
      input.baseline,
      completedByAdSnapId,
    );
    await Promise.all(reconciled.ids.map(async (ids, index) => {
      const prepared = input.prepared[index];
      if (!ids || ids.adId || !prepared?.mutation.originalPosts?.length) return;
      try {
        const assetGroupId = await readPublishedAssetGroupCreativeId(
          input.sessionRequest,
          input.credential,
          ids.adGroupId,
          prepared.mutation.originalPosts.map((post) => post.itemId),
        );
        if (!assetGroupId) return;
        reconciled.ids[index] = {
          campaignId: ids.campaignId,
          adGroupId: ids.adGroupId,
          adId: assetGroupId,
        };
        reconciled.reasons[index] = `广告组“${prepared.row.adGroupName}”及其原帖素材组已在 Cookie 正式接口确认。`;
      } catch {
        // The ordinary ad list remains the fallback. A transient read failure
        // must not turn an already confirmed campaign/ad-group into unknown.
      }
    }));
    lastReconciliation = reconciled;
    const allAdGroupsResolved = reconciled.ids.every(Boolean);
    const materialStillPending = reconciled.ids.some((ids) => ids && !ids.adId);
    if (allAdGroupsResolved && (!materialStillPending || attempt === attempts - 1)) {
      return reconciled.ids.map((ids) => ({ ids: ids! }));
    }
    lastReason = reconciled.reasons.find((reason, index) => !reconciled.ids[index])
      ?? reconciled.reasons[0]
      ?? lastReason;
  }

  const terminalDetail = input.terminalError instanceof Error
    ? `；异步任务回执：${input.terminalError.message}`
    : "";
  const readDetail = lastReadError instanceof Error
    ? `；Cookie 核验异常：${lastReadError.message}`
    : "";
  return input.prepared.map((_item, index): VerifiedCreationOutcome => {
    const ids = lastReconciliation?.ids[index];
    if (ids) return { ids };
    if (input.terminalError instanceof ConfirmedCreationFailureError) {
      return { error: input.terminalError };
    }
    const reason = lastReconciliation?.reasons[index] ?? lastReason;
    return {
      error: new UnknownCreationStateError(
        `${reason}${terminalDetail}${readDetail}；系统不会自动重试。`,
      ),
    };
  });
}

async function readCookieCreationSnapshot(input: {
  sessionRequest: CapturedCookieRequest;
  campaignObjectRequest: CapturedCookieRequest;
  credential: ParsedCookieCredential;
  dispatchState: CreationDispatchState;
}): Promise<CookieRemoteCreationSnapshot> {
  const adRequest = deriveFinalAdReadRequest(input.sessionRequest);
  if (!adRequest) {
    throw new UnknownCreationStateError("当前 Cookie 会话无法派生正式广告列表请求，不能确认真实创建结果。");
  }
  const campaignPayloads = await requestCompleteListPages(
    "campaign/list",
    input.campaignObjectRequest,
    input.credential,
    input.dispatchState,
    "result-query",
  );
  const adGroupPayloads = await requestCompleteListPages(
    "adgroup/list",
    input.sessionRequest,
    input.credential,
    input.dispatchState,
    "result-query",
  );
  const adPayloads = await requestCompleteListPages(
    "ad/list",
    adRequest,
    input.credential,
    input.dispatchState,
    "result-query",
  );
  const campaignSketchRows = await listAllSketchRows({
    kind: "campaign",
    ...input,
    semantics: "result-query",
  });
  const adSketchRows = await listAllSketchRows({
    kind: "ad",
    ...input,
    semantics: "result-query",
  });
  const creativeSketchRows = await listAllSketchRows({
    kind: "creative",
    ...input,
    semantics: "result-query",
  });
  return {
    campaigns: campaignPayloads.flatMap((payload) => extractEntities(payload, "campaign")),
    adGroups: adGroupPayloads.flatMap((payload) => extractEntities(payload, "ad-group")),
    ads: adPayloads.flatMap((payload) => extractEntities(payload, "ad")),
    campaignSketchIds: sketchRowIds(campaignSketchRows, "campaign"),
    adSketchIds: sketchRowIds(adSketchRows, "ad"),
    creativeSketchIds: sketchRowIds(creativeSketchRows, "creative"),
  };
}

function reconcileCookieCreationSnapshot(
  snapshot: CookieRemoteCreationSnapshot,
  prepared: PreparedCookieDraft[],
  baseline: CookieCreationBaseline,
  completedByAdSnapId: ReadonlyMap<string, ReturnType<typeof creationBatchResultIds>[number]>,
): CookieSnapshotReconciliation {
  const first = prepared[0];
  if (!first) return { ids: [], reasons: [] };
  const expectedCampaignId = first.existingCampaignId
    ?? completedByAdSnapId.get(first.publishItem.ad_snap_id)?.campaignId;
  const campaignCandidates = snapshot.campaigns.filter((entity) => {
    if (expectedCampaignId) return entity.externalId === expectedCampaignId;
    return !baseline.campaignIds.has(entity.externalId)
      && normalizeProviderEntity(entity).name.trim() === first.row.campaignName.trim();
  });
  if (campaignCandidates.length !== 1) {
    const reason = `Cookie 正式系列核验为 ${campaignCandidates.length} 个精确匹配，期望 1 个。`;
    return {
      ids: prepared.map(() => null),
      reasons: prepared.map(() => reason),
    };
  }
  const campaignId = campaignCandidates[0]!.externalId;
  const ids: Array<VerifiedCreationIds | null> = [];
  const reasons: string[] = [];
  for (const item of prepared) {
    const asyncIds = completedByAdSnapId.get(item.publishItem.ad_snap_id);
    const groupCandidates = snapshot.adGroups.filter((entity) => {
      const normalized = normalizeProviderEntity(entity);
      if (asyncIds?.adGroupId) {
        return entity.externalId === asyncIds.adGroupId
          && normalized.parentCampaignId === campaignId
          && normalized.name.trim() === item.row.adGroupName.trim();
      }
      return !baseline.adGroupIds.has(entity.externalId)
        && normalized.parentCampaignId === campaignId
        && normalized.name.trim() === item.row.adGroupName.trim();
    });
    if (groupCandidates.length !== 1) {
      ids.push(null);
      reasons.push(`广告组“${item.row.adGroupName}”在 Cookie 正式列表中匹配 ${groupCandidates.length} 个，期望 1 个。`);
      continue;
    }
    const adGroupId = groupCandidates[0]!.externalId;
    const adCandidates = snapshot.ads.filter((entity) => {
      const normalized = normalizeProviderEntity(entity);
      if (asyncIds?.adId) {
        return entity.externalId === asyncIds.adId
          && normalized.parentAdGroupId === adGroupId
          && normalized.name.trim() === item.row.adName.trim();
      }
      return normalized.parentAdGroupId === adGroupId
        && normalized.name.trim() === item.row.adName.trim();
    });
    const warning = adCandidates.length === 0
      ? materialSkippedWarning(item.mutation)
      : undefined;
    ids.push({
      campaignId,
      adGroupId,
      ...(adCandidates[0]?.externalId ? { adId: adCandidates[0].externalId } : {}),
      ...(warning ? { warning } : {}),
    });
    reasons.push(warning ?? `广告组“${item.row.adGroupName}”已在 Cookie 正式列表中确认。`);
  }

  const allowedAdGroupIds = new Set(ids.flatMap((item) => item ? [item.adGroupId] : []));
  const unexpectedAdGroups = snapshot.adGroups.filter((entity) => {
    const normalized = normalizeProviderEntity(entity);
    return normalized.parentCampaignId === campaignId
      && !baseline.adGroupIds.has(entity.externalId)
      && !allowedAdGroupIds.has(entity.externalId);
  });
  if (unexpectedAdGroups.length > 0) {
    const reason = `目标系列出现 ${unexpectedAdGroups.length} 个未列入任务的新广告组，已拒绝把批次标记为成功。`;
    return {
      ids: prepared.map(() => null),
      reasons: prepared.map(() => reason),
    };
  }

  return {
    ids: ids.map((item, index) => {
      if (!item) return null;
      const preparedItem = prepared[index]!;
      const relatedDraftStillExists = Boolean(
        (preparedItem.campaignSketchId
          && snapshot.campaignSketchIds.has(preparedItem.campaignSketchId)
          && !baseline.campaignSketchIds.has(preparedItem.campaignSketchId))
        || (snapshot.adSketchIds.has(preparedItem.publishItem.ad_sketch_id)
          && !baseline.adSketchIds.has(preparedItem.publishItem.ad_sketch_id))
        || preparedItem.publishItem.creative_snap_info_list.some((creative) =>
          snapshot.creativeSketchIds.has(creative.creative_sketch_id)
          && !baseline.creativeSketchIds.has(creative.creative_sketch_id)),
      );
      if (!relatedDraftStillExists) return item;
      return {
        ...item,
        warning: [item.warning, "素材提示：广告组已创建成功，但 Cookie 远端仍可见本任务草稿。"]
          .filter(Boolean)
          .join("；"),
      };
    }),
    reasons,
  };
}

function creationFailureResult(
  mutation: CreationMutation,
  cause: unknown,
  dispatchState: CreationDispatchState,
): CreationMutationResult {
  const acceptedMutation = dispatchState.acceptedMutationCount > 0;
  const confirmed = cause instanceof ConfirmedCreationFailureError;
  const failureKind = cause instanceof UnknownCreationStateError || acceptedMutation
    ? "unknown" as const
    : "retryable" as const;
  const detail = cause instanceof Error ? cause.message : "TikTok 创建请求失败。";
  return {
    ...mutation,
    ok: false,
    failureKind,
    retrySafe: confirmed ? !acceptedMutation && cause.retrySafe : !acceptedMutation,
    message: failureKind === "unknown" && !detail.includes("不会自动重试")
      ? `${detail}；此前已有创建请求被 TikTok 接受，系统不会自动重试。`
      : detail,
  };
}

async function createCookieDraftChain(
  sessionRequest: CapturedCookieRequest,
  campaignObjectRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  mutation: CreationMutation,
  timezone: string,
  batchReservation?: CookieDraftReservation,
): Promise<CreationMutationResult> {
  const recorder = createSentRequestRecorder();
  const dispatchState: CreationDispatchState = {
    mutationDispatched: false,
    acceptedMutationCount: 0,
    recordRequest: recorder.record,
    ...(mutation.onBeforeDispatch
      ? { onBeforeMutationDispatch: mutation.onBeforeDispatch }
      : {}),
  };
  // 记住最后一次上报的阶段，交报文时沿用它——留证本身不是一个新阶段，
  // 凭空造一个会让任务列表里多出一格看不懂的进度。
  let lastPhase: LaunchCreationProgress["phase"] = "validation";
  const tracked: CreationMutation = {
    ...mutation,
    onProgress: (progress) => {
      lastPhase = progress.phase;
      mutation.onProgress?.(progress);
    },
  };
  /**
   * 把攒下的请求体交出去。
   *
   * 成功和失败都交：失败时是为了定位，成功时是为了留一份「这样发是能过的」的样本，
   * 下次出问题可以直接和它对，而不必再等一份真机抓包。
   */
  const flushSentRequests = () => {
    const sentRequests = recorder.drain();
    if (sentRequests.length === 0) return;
    mutation.onProgress?.({ phase: lastPhase, evidence: { sentRequests } });
  };
  try {
    const result = await runCookieDraftChain(
      sessionRequest,
      campaignObjectRequest,
      credential,
      tracked,
      timezone,
      dispatchState,
      batchReservation,
    );
    flushSentRequests();
    return result;
  } catch (cause) {
    flushSentRequests();
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
  batchReservation?: CookieDraftReservation,
): Promise<CreationMutationResult>;
async function runCookieDraftChain(
  sessionRequest: CapturedCookieRequest,
  campaignObjectRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  mutation: CreationMutation,
  timezone: string,
  dispatchState: CreationDispatchState,
  batchReservation: CookieDraftReservation | undefined,
  batchState: CookieDraftBatchState,
  preflight: CookieDraftPreflight,
): Promise<PreparedCookieDraft>;
async function runCookieDraftChain(
  sessionRequest: CapturedCookieRequest,
  campaignObjectRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  mutation: CreationMutation,
  timezone: string,
  dispatchState: CreationDispatchState,
  batchReservation?: CookieDraftReservation,
  batchState?: CookieDraftBatchState,
  preflight?: CookieDraftPreflight,
): Promise<CreationMutationResult | PreparedCookieDraft> {
  mutation.onProgress?.({ phase: "validation", evidence: {} });
  assertStaticCreationMutation(credential, mutation);
  const copyOnly = mutation.templateMode === "copy";
  const preflightPayloads = preflight?.adGroupPayloads ?? await requestCompleteListPages(
    "adgroup/list",
    sessionRequest,
    credential,
    dispatchState,
  );
  const campaignPayloads = copyOnly
    ? preflightPayloads
    : preflight?.campaignPayloads ?? await requestCompleteListPages(
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
  const reservedCampaignId = batchState?.campaignId ?? batchReservation?.campaignId;
  if (reservedCampaignId && remoteCampaignId && reservedCampaignId !== remoteCampaignId) {
    throw new RetryableCreationError("同批次系列预留与远端同名系列不一致，已停止创建。");
  }
  const existingCampaignId = reservedCampaignId ?? remoteCampaignId;
  if (batchState && existingCampaignId) batchState.campaignId = existingCampaignId;
  assertAdGroupNameAvailable(
    preflightEntities,
    mutation.row.adGroupName,
    existingCampaignId ?? "",
    batchReservation?.adGroupNames,
  );
  const creationRow = mutation.row;
  if (batchState) batchReservation?.adGroupNames.add(creationRow.adGroupName.trim());
  // Persist the exact table name before the first creation mutation so the
  // execution record always identifies the value actually sent to TikTok.
  mutation.onProgress?.({
    phase: "validation",
    evidence: { resolvedAdGroupName: creationRow.adGroupName },
  });
  const pixelSelector = mutation.preset.pixelKey?.trim();
  let targetPixelId: string | undefined;
  if (pixelSelector) {
    // 用这次 adgroup/list 实时读回来的广告组来匹配：账户当前在用哪些数据连接、
    // 各自叫什么，广告组自己就带着（ad_ref_pixel_id / ad_pixel_name）。
    targetPixelId = resolveAccountPixelIdFromAdGroups(preflightEntities, pixelSelector);
  } else {
    targetPixelId = resolveLegacyTargetAccountPixelId(preflightEntities, mutation.preset);
  }
  const resolvedPreset = targetPixelId
    ? { ...mutation.preset, pixelId: targetPixelId }
    : mutation.preset;
  const drafts = credential.creationProfile
    ? buildProfileDraftPayloads(credential.creationProfile, creationRow, timezone, new Date(), resolvedPreset)
    : buildDraftPayloads(creationRow, resolvedPreset, timezone);
  // A new launch never copies a campaign. New campaign names save a fresh
  // campaign draft; exact-name matches skip that save and attach a fresh
  // ad-group to the existing campaign. Campaign copy is reserved for the
  // explicit templateMode="copy" operation only.
  const verifiedTargetTemplate = !credential.creationProfile
    && mutation.originalPosts?.length
    ? selectCompatibleTargetTemplate(
        campaignEntities,
        preflightEntities,
        mutation,
        existingCampaignId,
      )
    : undefined;
  if (!credential.creationProfile && mutation.originalPosts?.length
    && !verifiedTargetTemplate) {
    throw new RetryableCreationError(
      "目标账户没有可用于原帖迁移的同类型正式 Campaign，已在发送创建请求前停止。请先在该账户完成一条同类型广告创建。",
    );
  }
  const initializationTemplateCampaignId = copyOnly
    ? mutation.templateCampaignId
    : verifiedTargetTemplate?.campaignId;
  const initializedIds = initializationTemplateCampaignId
    ? existingCampaignId && !copyOnly && verifiedTargetTemplate
      ? await initializeExistingCampaignDraftIds(
          sessionRequest,
          credential,
          mutation,
          dispatchState,
          verifiedTargetTemplate.adGroupId,
          existingCampaignId,
        )
      : await initializeProfileDraftIds(
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
  const hasSharedCampaignDraft = Boolean(
    batchState?.campaignSnapId && batchState.campaignSketchId,
  );
  const campaign = existingCampaignId
    ? {}
    : hasSharedCampaignDraft
      ? batchState?.campaignResponse ?? {}
      : await requestCreationStep("campaign_snap/save",
          () => creationRequest(sessionRequest, "campaign_snap/save", drafts.campaign),
          credential,
          { semantics: "mutation", dispatchState },
        );
  const campaignSnapId = existingCampaignId
    ? ""
    : batchState?.campaignSnapId
      ?? responseId(campaign, "campaign_snap_id")
      ?? initializedIds?.campaignSnapId
      ?? requiredResponseId(campaign, "campaign_snap_id");
  if (!existingCampaignId) {
    mutation.onProgress?.({ phase: "campaign_draft", evidence: { campaignSnapId } });
  }
  let campaignSketchId = existingCampaignId
    ? ""
    : batchState?.campaignSketchId
      ?? responseId(campaign, "campaign_sketch_id")
      ?? initializedIds?.campaignSketchId
      ?? "";
  let checkedFakeCampaignId = "";
  if (!copyOnly && !existingCampaignId) {
    if (batchState?.checkedFakeCampaignId) {
      checkedFakeCampaignId = batchState.checkedFakeCampaignId;
    } else {
      const campaignCheck = await requestAdvisoryCreationStep(
        "campaign_snap/check",
        () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/campaign_snap/check/", {
          campaign_snap_id: campaignSnapId,
        }),
        credential,
      );
      const campaignData = campaignCheck && isRecord(campaignCheck.data) ? campaignCheck.data : {};
      checkedFakeCampaignId = nonEmptyId(campaignData.fake_campaign_id) ?? "";
      campaignSketchId ||= checkedFakeCampaignId;
      if (batchState) batchState.checkedFakeCampaignId = checkedFakeCampaignId;
    }
  }
  if (!existingCampaignId && !campaignSketchId) {
    throw new UnknownCreationStateError(
      "campaign_snap/save/check 未返回可用的 campaign_sketch_id / fake_campaign_id，已停止后续发布。",
    );
  }
  if (batchState && !existingCampaignId && !hasSharedCampaignDraft) {
    batchState.campaignSnapId = campaignSnapId;
    batchState.campaignSketchId = campaignSketchId;
    batchState.campaignResponse = campaign;
  }
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
  let adSketchId = copyOnly && initializedIds ? initializedIds.adSketchId : responseId(adGroup, "ad_sketch_id")
    ?? initializedIds?.adSketchId
    ?? "";
  let adCheckCandidates = "";
  // TikTok's ad_snap/bulk_check is scoped to a newly saved campaign draft and
  // requires the fake campaign id returned by campaign_snap/check. A formal
  // existing campaign has no such draft id; passing its real id is rejected as
  // stale page information. Reused campaigns continue to the later joint HAR
  // validations, which cover the ad-group and creatives before publish.
  if (!copyOnly && !existingCampaignId) {
    const bulkCheck = await requestAdvisoryCreationStep(
      "ad_snap/bulk_check",
      () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/ad_snap/bulk_check/", {
        ad_snap_ids: [adSnapId],
        fake_campaign_id: checkedFakeCampaignId || existingCampaignId || campaignSketchId,
      }),
      credential,
    );
    const bulkData = bulkCheck && isRecord(bulkCheck.data) ? bulkCheck.data : {};
    adCheckCandidates = responseIdKeys(bulkCheck).slice(0, 15).join(", ");
    const reportMap = isRecord(bulkData.ad_snap_check_report_map)
      ? bulkData.ad_snap_check_report_map
      : {};
    const matchingReport = isRecord(reportMap[adSnapId])
      ? reportMap[adSnapId]
      : Object.values(reportMap).find(isRecord);
    adSketchId ||= responseId(bulkCheck, "fake_ad_id")
      ?? responseId(bulkCheck, "ad_sketch_id")
      ?? (matchingReport
        ? nonEmptyId(matchingReport.fake_ad_id) ?? nonEmptyId(matchingReport.ad_sketch_id)
        : undefined)
      ?? "";
    if (!adSketchId
      && matchingReport
      && nonEmptyId(matchingReport.ad_snap_id) === adSnapId) {
      // Current TikTok responses can omit fake_ad_id after a successful check.
      // In that contract the accepted ad_snap_id is also the draft reference
      // required by the following creative and publish steps.
      adSketchId = adSnapId;
    }
  }
  if (!adSketchId && !copyOnly) {
    try {
      const detailForms = await readAdSnapForms(
        sessionRequest,
        credential,
        dispatchState,
        [adSnapId],
      );
      const detailForm = detailForms.get(adSnapId);
      if (detailForm) {
        adSketchId = nonEmptyId(detailForm.ad_sketch_id)
          ?? nonEmptyId(detailForm.by_ad_sketch_id)
          ?? "";
        if (!adCheckCandidates) {
          adCheckCandidates = responseIdKeys(detailForm).slice(0, 15).join(", ");
        }
      }
    } catch {
      // Some accounts do not expose a just-saved snap through snap/detail.
      // The sketch list below is the final read-only resolution path.
    }
  }
  if (!adSketchId && !copyOnly) {
    const refreshedAdSketchRows = await listAllSketchRows({
      kind: "ad",
      sessionRequest,
      credential,
      dispatchState,
      semantics: "preflight-read",
    });
    const baselineAdSketchIds = preflight?.baseline.adSketchIds ?? new Set<string>();
    const exactRows = refreshedAdSketchRows.filter((row) =>
      nonEmptyId(row.ad_snap_id) === adSnapId
      || (sketchRowName(row, "ad") === creationRow.adGroupName.trim()
        && Boolean(nonEmptyId(row.ad_sketch_id))
        && !baselineAdSketchIds.has(nonEmptyId(row.ad_sketch_id)!)),
    );
    const resolvedSketchIds = [...new Set(
      exactRows.map((row) => nonEmptyId(row.ad_sketch_id)).filter((id): id is string => Boolean(id)),
    )];
    if (resolvedSketchIds.length === 1) adSketchId = resolvedSketchIds[0]!;
    if (!adCheckCandidates) {
      adCheckCandidates = exactRows.flatMap((row) => responseIdKeys(row)).slice(0, 15).join(", ");
    }
  }
  if (!adSketchId) {
    throw new UnknownCreationStateError(
      `ad_snap/save/bulk_check 未返回可用的 ad_sketch_id / fake_ad_id，已停止后续发布。可用字段：${adCheckCandidates || responseIdKeys(adGroup).slice(0, 15).join(", ") || "无"}`,
    );
  }
  mutation.onProgress?.({
    phase: "adgroup_draft",
    evidence: { adGroupSnapId: adSnapId, adGroupSketchId: adSketchId },
  });
  const creativeSnapIdFromAd = initializedIds
    ? initializedIds.creativeSnapId
    : responseId(adGroup, "creative_snap_id");
  const creativeSketchIdFromAd = initializedIds
    ? initializedIds.creativeSketchId
    : responseId(adGroup, "creative_sketch_id");

  // 单条路径：被跳过的授权码在本函数末尾随结果一起报出。
  const skippedVideoCodes: string[] = [];
  const resolvedVideos = preflight?.resolvedVideos ?? await resolveTikTokVideos(
    { ...mutation, row: creationRow },
    sessionRequest,
    credential,
    undefined,
    dispatchState,
    skippedVideoCodes,
  );

  // One ad-group, several ads = ONE creative whose image_list carries every
  // video, each bound to its authorized creator identity. This mirrors TikTok's
  // real SPC multi-ad creative_snap/save (N videos in one image_list, not N
  // separate creatives).
  const creativeAssets = drafts.creative.asset_group_sketch_form_data_list;
  const singleAsset = Array.isArray(creativeAssets) && isRecord(creativeAssets[0])
    ? creativeAssets[0]
    : {};
  if (mutation.originalProductInfo) {
    singleAsset.product_info = structuredClone(mutation.originalProductInfo);
    singleAsset.product_info_type = 1;
    singleAsset.catalog_setup = mutation.originalCatalogSetup ?? 0;
  }
  const usesAccountPostIdentity = resolvedVideos.some(
    (video) => video.identityType === 5,
  );
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
      if (usesAccountPostIdentity) {
        delete singleAsset.identity_type;
        delete singleAsset.identity_id;
        delete singleAsset.item_source;
        // 账户原帖迁移沿用经过验证的 identity_type=5 结构；不要把普通
        // Spark 创意的自动优化列表塞进该结构。
        delete singleAsset.creative_automation_list;
        // 列表删掉后必须把 type 一并钉回这条路原本验证过的 1：普通 Spark 创意
        // 改用 2（自选列表）之后，这里如果跟着变成 2 就成了「标称自选却没有
        // 列表」，属于另一种自相矛盾。这条链路没有新证据，保持原样。
        singleAsset.creative_automation_type = 1;
        singleAsset.spc_upgrade_mode = 1;
        delete singleAsset.spc_multi_ad_mode;
      } else {
        singleAsset.identity_type = 2;
        singleAsset.identity_id = "";
        singleAsset.item_source = 2;
      }
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
      optimizeGoal: mutation.preset.optimizeGoal,
      externalAction: mutation.preset.externalAction,
      placementIds: mutation.preset.placementIds,
      externalUrl: creationRow.productUrl,
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
      // Current TikTok save responses can return only creative_snap_id. As
      // with ad drafts, the accepted snap id is then the reference consumed by
      // the subsequent check/publish endpoints.
      ?? creativeSnapId;
  }
  mutation.onProgress?.({
    phase: "creative_draft",
    evidence: { creativeSnapId, creativeSketchId },
  });

  let publishItems: DraftPublishItem[] = copyOnly && initializedIds
    ? initializedIds.publishItems
    : [{
        ad_id: "", ad_snap_id: adSnapId, ad_sketch_id: adSketchId,
        creative_snap_info_list: [{
          creative_id: "", creative_snap_id: creativeSnapId,
          creative_sketch_id: creativeSketchId, need_publish: true as const,
        }],
        need_publish: true as const,
      }];
  if (batchState) {
    return {
      kind: "prepared",
      mutation,
      row: creationRow,
      ...(existingCampaignId ? { existingCampaignId } : {}),
      campaignSnapId,
      campaignSketchId,
      checkedFakeCampaignId,
      publishItem: publishItems[0]!,
      riskInfo: credential.creationProfile && isRecord(credential.creationProfile.publishPayload.risk_info)
        ? credential.creationProfile.publishPayload.risk_info
        : {},
      dispatchState,
    };
  }
  // 不再走 snap/save_by_sketch 重铸，理由见批量发布那一处的注释。
  const publishCampaignSnapId = campaignSnapId;
  const publishPayload = credential.creationProfile
    ? materializePublishProfile(credential.creationProfile.publishPayload, {
        ...(existingCampaignId ? { campaignId: existingCampaignId } : {}),
        campaignSnapId: publishCampaignSnapId, campaignSketchId, publishItems,
        initialStatus: mutation.initialStatus,
      })
    : buildPublishInput({
      campaignSnapId: publishCampaignSnapId || existingCampaignId!,
      campaignSketchId: campaignSketchId || existingCampaignId!,
      adAndCreativeSnapInfoList: publishItems,
    }, mutation.initialStatus);
  if (existingCampaignId) {
    publishPayload.campaign_id = existingCampaignId;
    publishPayload.campaign_snap_id = "";
    publishPayload.campaign_sketch_id = "";
  }
  // TikTok's fresh-campaign flow validates Smart+ automation at the full
  // campaign-tree level. Partial publish is reserved for adding an ad group to
  // an already formal campaign; using it for a new campaign produces false
  // age, bidding, and automation inconsistency errors at publish time.
  publishPayload.is_partial_publish = Boolean(existingCampaignId);
  const advisoryFailures = await runAdvisoryDraftSequence(sessionRequest, credential, {
    ...(existingCampaignId ? { campaignId: existingCampaignId } : {}),
    campaignSnapId: publishCampaignSnapId, campaignSketchId, publishItems,
    ...(checkedFakeCampaignId ? { fakeCampaignId: checkedFakeCampaignId } : {}),
    riskInfo: credential.creationProfile && isRecord(credential.creationProfile.publishPayload.risk_info)
      ? credential.creationProfile.publishPayload.risk_info
      : {},
  }, dispatchState);
  if (advisoryFailures.length > 0) {
    mutation.onProgress?.({ phase: "publishing", evidence: { advisoryFailures } });
  }
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
    ...(skippedVideoCodes.length > 0
      ? { warning: skippedMaterialWarning(skippedVideoCodes) }
      : {}),
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
  /** 带上它，这四步才会进留证；不带则沿用旧行为（不记录）。 */
  dispatchState?: CreationDispatchState,
): Promise<string[]> {
  // 失败的步骤名。返回给调用方，让它跟着结果一起浮出来——这四步是「让草稿变得
  // 可发布」的一环，静默失败会表现成发布时的 automation 自相矛盾，现场却什么都不剩。
  const failed: string[] = [];
  const boundary: CreationRequestBoundary = dispatchState
    ? { semantics: "support", dispatchState }
    : {};
  const note = (step: string) => failed.push(step);

  const adSnapIds = ids.publishItems.map((item) => item.ad_snap_id);
  let fakeCampaignId = ids.fakeCampaignId ?? "";
  if (!ids.campaignId) {
    await requestAdvisoryCreationStep("snap/cbo_consistency_check",
      () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/snap/cbo_consistency_check/", {
        campaign_snap_id: ids.campaignSnapId,
        adgroup_snap_ids: adSnapIds,
        ad_snap_ids: adSnapIds,
        is_budget_split_test: false,
      }), credential, boundary, note);
    // campaign_snap/check 每次发布前都要跑，不能因为已经拿到 fake_campaign_id 就跳过。
    //
    // 此前它被当成「拿 fake_campaign_id 的手段」，缓存命中就不调了。但真机全程调它
    // 三次，其中一次紧挨着发布：
    //   09:14:43 cbo_consistency_check -> 09:14:44 campaign_snap/check
    //   -> 09:14:45 ad_creative_snap/check -> 09:14:49 batch_create_cta_id
    //   -> 09:15:36 create_by_snap
    // 它是发布前对系列快照的服务端校验，取 id 只是顺带。跳过它，系列层的 automation
    // 状态就没在服务端过这一遍，发布时被判 uaa_campaign_automation_inconsistent_error
    // ——错误名里的 campaign 指的正是这一层。
    //
    // 2026-08-31 的留证是直接证据：四步检查一个都没失败（advisoryFailures 为空），
    // 但序列里只有 cbo_consistency_check / ad_creative_snap/check /
    // batch_create_cta_id 三步，campaign_snap/check 因为缓存命中被跳掉了。
    const campaignCheck = await requestAdvisoryCreationStep("campaign_snap/check",
      () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/campaign_snap/check/", {
        campaign_snap_id: ids.campaignSnapId,
      }), credential, boundary, note);
    if (!fakeCampaignId) {
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
    }), credential, boundary, note);
  await requestAdvisoryCreationStep("snap/batch_create_cta_id",
    () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/snap/batch_create_cta_id/", {
      campaign_id: ids.campaignId ?? "",
      campaign_snap_id: ids.campaignSnapId,
      ad_and_creative_snap_info_list: checkInfo,
    }), credential, boundary, note);
  return failed;
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
            "TikTok 返回部分创建成功、部分失败，转入 Cookie 远端列表核验。",
          );
        }
        throw new ConfirmedCreationFailureError(
          `TikTok 已明确报告广告组或创意创建失败，未生成正式广告。原因：${describeCreationFailure(data.result)}`,
        );
      }
      return detail;
    }
    if (typeof data?.status === "number" && data.status < 0) {
      throw new ConfirmedCreationFailureError("TikTok 已明确报告创建失败，未生成正式广告。");
    }
  }
  throw new UnknownCreationStateError("TikTok 创建任务在 9 秒内未返回最终结果，转入 Cookie 远端列表核验。");
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
  identityType?: number;
  identityBcId?: string;
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
  preloadedLibrary?: ReadonlyMap<string, ResolvedVideo>,
  dispatchState?: CreationDispatchState,
  /** 出参：本行被跳过的授权码。调用方负责把它报给用户，不能默默吞掉。 */
  skippedCodes?: string[],
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
  const library = preloadedLibrary ?? (needLibrary.length > 0
    ? await resolveVideoCodesFromLibrary(
        sessionRequest,
        credential,
        needLibrary,
        dispatchState ?? { mutationDispatched: false, acceptedMutationCount: 0 },
      )
    : new Map<string, ResolvedVideo>());
  // 解析不到的授权码逐个跳过，不再让一颗坏码毙掉整行。
  //
  // 一行可以挂到 50 个码，人工排查「是哪一个没授权」成本极高，而其余素材本身是好
  // 的——把能建的建出来，再把跳过的码原样报给用户，比整行失败有用得多。跳过必须
  // 可见：调用方会把它写进 syncWarning，界面按「已跳过 N 条素材」汇总。
  const skipped: string[] = [];
  const videos: ResolvedVideo[] = [];
  for (const code of list) {
    const fromLibrary = library.get(code);
    if (code.startsWith("#")) {
      if (fromLibrary) {
        const mappedPostId = mutation.preset.videoPostMappings?.find((item) => item.videoCode === code)?.postId;
        if (mappedPostId && mappedPostId !== fromLibrary.itemId) {
          throw new RetryableCreationError("授权码解析结果与保存的 Post ID 不一致，请刷新授权关系后重试。");
        }
        videos.push(fromLibrary);
        continue;
      }
      skipped.push(code);
      continue;
    }
    const manualId = manual.get(code);
    videos.push({ itemId: manualId ?? code } satisfies ResolvedVideo);
  }
  if (videos.length === 0) {
    // 一个都解析不出来时仍然失败：没有素材就没有可创建的广告，
    // 静默建出一个空广告组比报错更糟。
    throw new RetryableCreationError(
      skipped.length > 0
        ? `本行 ${skipped.length} 个授权码全部无法在素材库中解析到帖子（${formatSkippedCodes(skipped)}）；请确认这些视频已授权到当前账户。`
        : "有授权码无法在素材库中解析到帖子；请确认该视频已授权到当前账户。",
    );
  }
  if (skippedCodes) skippedCodes.push(...skipped);
  return videos;
}

/** 报错/警告里列出被跳过的码，超过 10 个折成计数，避免把提示撑爆。 */
function formatSkippedCodes(codes: string[]): string {
  const shown = codes.slice(0, 10).join("、");
  return codes.length > 10 ? `${shown} 等 ${codes.length} 个` : shown;
}

/** 素材跳过提示。界面按「素材提示 / 已跳过 N 条素材」匹配并汇总，格式不要随意改。 */
function skippedMaterialWarning(skipped: string[]): string {
  return `素材提示：已跳过 ${skipped.length} 条素材（授权码无法在素材库中解析到帖子：${formatSkippedCodes(skipped)}），其余素材已正常创建。`;
}

/**
 * 素材库批量接口的单次查询码数上限。
 *
 * TikTok 后台手动导入授权码时一次也是 20 条，接口侧同一个限制；超了只回一句
 * 「Authorization codes queried at one time exceeds the upper limit」，不说上限是
 * 多少。生产数据与这个值一致：单请求 33 个码必被拒，16 个码可以过。
 *
 * 注意这与「一个广告组最多挂 50 条素材」是两个不同的限制——50 条素材的广告组是
 * 合法的，只是它的授权码要分 3 次查。
 */
const VIDEO_CODE_LOOKUP_CHUNK_SIZE = 20;

function chunkVideoCodes(codes: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < codes.length; index += VIDEO_CODE_LOOKUP_CHUNK_SIZE) {
    chunks.push(codes.slice(index, index + VIDEO_CODE_LOOKUP_CHUNK_SIZE));
  }
  return chunks;
}

/** Looks up `#…` authorization codes in the account's material library and maps
 * each to its item id and authorized creator identity (core_user_id). */
async function resolveVideoCodesFromLibrary(
  sessionRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  codes: string[],
  dispatchState: CreationDispatchState,
): Promise<Map<string, ResolvedVideo>> {
  const uniqueCodes = [...new Set(codes)];
  const out = new Map<string, ResolvedVideo>();
  // 逐批查询。素材库这两个接口有自己的单次查询上限，和「广告组最多 50 条素材」
  // 完全是两回事：生产实测单请求 33 个码就会被 TikTok 以
  // 「Authorization codes queried at one time exceeds the upper limit」拒掉，
  // 而一个 50 条素材的广告组本身是合法的。批量创建还会把整批所有行的码汇总成
  // 一个请求（曾出现 289 个码），不切分必炸。
  for (const chunk of chunkVideoCodes(uniqueCodes)) {
    const response = await requestCreationStep(
      "material/tt_video/bulk/info",
      () => creationPathRequest(
        sessionRequest,
        "/api/v4/i18n/creation/material/tt_video/bulk/info/",
        { video_code_list: chunk },
      ),
      credential,
      { semantics: "preflight-read", dispatchState },
    );
    const data = isRecord(response.data) ? response.data : {};
    const videoMap = isRecord(data.tt_video_map) ? data.tt_video_map : {};
    for (const code of chunk) {
      const entry = videoMap[code];
      if (!isRecord(entry)) continue;
      const itemId = nonEmptyId(entry.item_id);
      if (!itemId) continue;
      const identityId = nonEmptyId(entry.core_user_id);
      if (!identityId) {
        throw dispatchState.mutationDispatched
          ? new UnknownCreationStateError("TikTok 素材信息未返回可用的 Spark 身份；已有草稿请求发出，不能直接重试。")
          : new RetryableCreationError("TikTok 素材信息未返回可用的 Spark 身份，请更新授权后重试本条。");
      }
      const videoInfo = isRecord(entry.video_info) ? entry.video_info : {};
      const vid = nonEmptyId(videoInfo.vid) ?? nonEmptyId(videoInfo.video_id);
      out.set(code, {
        itemId,
        identityId,
        ...(vid ? { vid } : {}),
      });
    }
  }
  const resolvedCodes = uniqueCodes.filter((code) => out.has(code));
  if (resolvedCodes.length === 0) return out;
  for (const chunk of chunkVideoCodes(resolvedCodes)) {
    const authorized = await requestCreationStep(
      "material/tt_video/bulk/authorize",
      () => creationPathRequest(
        sessionRequest,
        "/api/v4/i18n/creation/material/tt_video/bulk/authorize/",
        { auth_code_info_list: chunk.map((auth_code) => ({ auth_code })), is_check: false },
      ),
      credential,
      { semantics: "preflight-read", dispatchState },
    );
    const authorizedData = isRecord(authorized.data) ? authorized.data : {};
    const identityMap = isRecord(authorizedData.identity_id_map) ? authorizedData.identity_id_map : {};
    for (const code of chunk) {
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
  // 自动优化能力查询要按投放上下文提问，少一个参数 TikTok 就换一套答案。
  optimizeGoal: unknown;
  externalAction: unknown;
  placementIds: number[];
  externalUrl: string;
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
    identity_type: video.identityType ?? 2,
    ...(video.identityBcId ? { identity_bc_id: video.identityBcId } : {}),
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

  const automationOptions = await requestAdvisoryCreationStep(
    "creative/creative_automation_option",
    () => creationPathRequest(
      sessionRequest,
      "/api/v4/i18n/creation/creative/creative_automation_option/",
      // 必须按真机那份完整提问：这个接口返回的「可用策略」取决于投放上下文，
      // 只发 identity_type 时 TikTok 会给出另一套列表（实测不含 CTA 优化 100001
      // 与生成广告卡片 100002），于是这两项被当成「账户不支持」过滤掉，
      // 广告建出来只剩视频质量一项。常量取自已验证抓包。
      {
        objective_type: context.objectiveType,
        universal_type: 1,
        app_campaign_type: 0,
        search_campaign_type: 0,
        web_all_in_one_catalog: 2,
        languages: [],
        country_ids: context.countryIds.map((id) => String(id)),
        external_type: 102,
        external_action: context.externalAction,
        optimize_goal: context.optimizeGoal,
        inventory_flows: [...context.placementIds],
        promotion_target_type: 0,
        external_url: context.externalUrl ? [context.externalUrl] : [],
        identity_type: sparkVideos[0]?.identityType ?? 2,
        material_types: [1],
        product_platform_id: null,
        catalog_setup: numericValue(context.creativeInfo.catalog_setup) ?? 0,
      },
    ),
    credential,
  );
  applySupportedCreativeAutomationStrategies(context.creativeInfo, automationOptions);

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

/**
 * 自动优化是执行期、账户级能力：仅发送当前账户接口明确支持的默认策略。
 * 接口不可用时保留已验证默认值，让后续 creative save 返回权威错误；不会把它
 * 升格成用户点击创建前的阻塞项。
 */
/**
 * 只保留当前账户接口明确支持的自动优化策略。
 *
 * 两条规则都是从真机成功抓包里读出来的，别凭感觉改：
 *
 * 1. **过滤的是产品选定的组合**（DefaultTikTokCreativeAutomationStrategyIds），
 *    不是模板里那份。模板的列表只反映抓包那一刻手动勾了什么，不是规格。
 *
 *    另外注意 creative_automation_option 必须按完整投放上下文提问：只发
 *    identity_type 时 TikTok 会返回另一套更小的可用列表（实测不含 100001/100002），
 *    于是 CTA 与生成广告卡片会被误判成「账户不支持」而过滤掉。
 *
 * 2. **非空列表必须配 `creative_automation_type = 2`**。真机成功那次就是 2；
 *    此前这里写死成 1，而 TikTok 对「type=1 且列表非空」直接回
 *    `creative_automation_list_should_be_nil_error`——自相矛盾的组合。
 *    列表为空时才是 0。
 */
function applySupportedCreativeAutomationStrategies(
  creativeInfo: Record<string, unknown>,
  response: Record<string, unknown> | undefined,
): void {
  if (!Array.isArray(creativeInfo.creative_automation_list)) return;
  const data = response && isRecord(response.data) ? response.data : response;
  if (!data || !Array.isArray(data.strategy_ids)) return;
  const supported = new Set(data.strategy_ids.map((value) => String(value)));
  // 用产品选定的组合，不是模板里那份。模板是从某次真机手动创建抓来的，它的
  // 自动优化列表只是「抓包那一刻那个人勾了什么」，不是规格；沿用它会把当时多勾
  // 的项（例如翻译和配音）一直带下去。账户不支持的照旧过滤掉。
  const selected = [...new Set<string>(DefaultTikTokCreativeAutomationStrategyIds)]
    .filter((strategyId) => supported.has(strategyId));
  creativeInfo.creative_automation_list = selected;
  creativeInfo.creative_automation_type = selected.length > 0 ? 2 : 0;
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
    ...(video.identityId ? {
      identity_type: video.identityType ?? 2,
      identity_id: video.identityId,
      ...(video.identityBcId ? { identity_bc_id: video.identityBcId } : {}),
    } : {}),
  }));
}

function assertAdGroupNameAvailable(
  preflightEntities: ProviderEntity[],
  requestedName: string,
  campaignId: string,
  reservedNames: ReadonlySet<string> = new Set(),
): void {
  const existingNames = new Set(
    preflightEntities
      .filter((entity) => nonEmptyId(entity.payload.campaign_id) === campaignId)
      .map((entity) => normalizeProviderEntity(entity).name.trim())
      .filter(Boolean),
  );
  for (const name of reservedNames) existingNames.add(name);
  if (existingNames.has(requestedName)) {
    throw new RetryableCreationError(
      `广告组名称“${requestedName}”已存在于目标系列或本批次中；系统不会擅自改名，请修正表格名称后重试。`,
    );
  }
}

function assertStaticCreationMutation(
  credential: ParsedCookieCredential,
  mutation: CreationMutation,
): void {
  const copyOnly = mutation.templateMode === "copy";
  if (copyOnly && !mutation.templateCampaignId) {
    throw new RetryableCreationError(
      "复制模板无效：缺少 templateCampaignId，不能按系列名称回退定位。",
    );
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
}

/**
 * 从创建结果里捞出 TikTok 真正说了什么。
 *
 * 之前这里是 `JSON.stringify(result).slice(0, 300)`：报错原因排在一堆 snap/sketch
 * id 后面，每次都正好被切掉，线上只能看到
 * 「detail={"campaign_name":…,"ad_error_items":[{"starling_key":"uaa_campaign_automa」
 * 这种断句，等于把唯一有用的信息扔了。改为先把 error item 抽出来放最前面。
 */
function collectCreationErrorItems(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectCreationErrorItems(item, out);
    return out;
  }
  if (!isRecord(value)) return out;
  const key = typeof value.starling_key === "string" ? value.starling_key.trim() : "";
  const message = typeof value.message === "string" ? value.message.trim() : "";
  if (key || message) {
    // key 与 message 常常互为补充：key 稳定可检索，message 才有细节。
    const line = key && message && !message.startsWith(key) ? `${key}: ${message}` : (message || key);
    if (line && !out.includes(line)) out.push(line);
  }
  for (const nested of Object.values(value)) collectCreationErrorItems(nested, out);
  return out;
}

function describeCreationFailure(result: Record<string, unknown>): string {
  const reasons = collectCreationErrorItems(result);
  const context = {
    campaign_name: result.campaign_name,
    by_campaign_snap_id: result.by_campaign_snap_id,
    by_campaign_sketch_id: result.by_campaign_sketch_id,
  };
  return reasons.length > 0
    ? `${reasons.join("；")}（${JSON.stringify(context)}）`
    : JSON.stringify(result).slice(0, 600);
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

function creationBatchResultIds(
  payload: Record<string, unknown>,
  existingCampaignId?: string,
): Array<{ campaignId: string; adGroupId: string; adId: string; byAdSnapId: string }> {
  const data = isRecord(payload.data) ? payload.data : payload;
  const result = isRecord(data.result) ? data.result : data;
  const campaignId = nonEmptyId(result.campaign_id) ?? existingCampaignId;
  if (!campaignId) return [];
  const adsValue = result.ad_and_creative;
  const ads = Array.isArray(adsValue)
    ? adsValue
    : isRecord(adsValue) ? Object.values(adsValue) : [];
  return ads.flatMap((value) => {
    if (!isRecord(value)) return [];
    const byAdSnapId = nonEmptyId(value.by_ad_snap_id);
    const adGroupId = nonEmptyId(value.ad_id)
      ?? nonEmptyId(value.adgroup_id)
      ?? nonEmptyId(value.ad_group_id);
    const groupsValue = value.asset_group_result;
    const groups = Array.isArray(groupsValue)
      ? groupsValue
      : isRecord(groupsValue) ? Object.values(groupsValue) : [];
    const firstGroup = groups.find(isRecord);
    const creativesValue = firstGroup?.creative_items;
    const creatives = Array.isArray(creativesValue)
      ? creativesValue
      : isRecord(creativesValue) ? Object.values(creativesValue) : [];
    const firstCreative = creatives.find(isRecord);
    const adId = firstCreative ? nonEmptyId(firstCreative.id) : undefined;
    return byAdSnapId && adGroupId && adId
      ? [{ campaignId, adGroupId, adId, byAdSnapId }]
      : [];
  });
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

async function initializeExistingCampaignDraftIds(
  sessionRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  mutation: CreationMutation,
  dispatchState: CreationDispatchState,
  templateAdGroupId: string,
  existingCampaignId: string,
): Promise<InitializedDraftIds> {
  const profile = credential.creationProfile;
  const riskInfo = profile && isRecord(profile.publishPayload.risk_info)
    ? profile.publishPayload.risk_info
    : profile && isRecord(profile.campaignPayload.risk_info)
      ? profile.campaignPayload.risk_info
      : {};
  const copied = await requestCreationStep(
    "ad_snap/copy",
    () => creationPathRequest(sessionRequest, "/api/v4/i18n/creation/ad_snap/copy/", {
      with_sketch: true,
      resp_with_detail: true,
      with_creative: true,
      is_batch_copy: true,
      ad_params: [{ ad_id: templateAdGroupId, name_list: [mutation.row.adGroupName] }],
      copy_ad_id_to_existing_campaign: true,
      is_manual_upgrade_to_splusplus: false,
      converter_mode: 0,
      existing_campaign_id: existingCampaignId,
      risk_info: riskInfo,
    }),
    credential,
    { semantics: "mutation", dispatchState },
  );
  return copiedExistingCampaignDraftIds(copied);
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
      // Pricing is validated by TikTok as one coherent bidding tuple. Keeping
      // only `pricing`/`cpa_bid` while retaining the freshly initialized
      // draft's bid-mode defaults can turn a verified oCPM profile into an
      // internally inconsistent form that is rejected only at publish time.
      "bid", "smart_bid_type", "bid_type_detail", "bid_display_mode",
      "deep_bid_type", "deep_cpabid", "optimization_source", "roas_bid",
      "cpa_skip_first_phrase", "flow_control_mode",
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

/** 草稿列表翻页上限：单页 100 条、最多 20 页。翻不到就当草稿不在，交人工。 */
const DRAFT_SKETCH_PAGE_SIZE = 100;
const DRAFT_SKETCH_PAGE_LIMIT = 20;
/** 一次清理最多删这么多条。够用且不至于把一次误操作放大成灾难。 */
const DRAFT_DELETE_BATCH_LIMIT = 200;

/**
 * 翻完草稿列表。
 *
 * `stopWhen` 是给「按名字找特定几条」用的提前退出：找齐就不再翻。清理与对账不传它，翻到底
 * 为止——少翻一页就是少看见一条草稿，对账那边会直接变成误判。
 */
async function readDraftSketches(input: {
  sessionRequest: CapturedCookieRequest;
  credential: ParsedCookieCredential;
  dispatchState: CreationDispatchState;
  stopWhen?: (collected: readonly DraftSketchEntry[]) => boolean;
}): Promise<DraftSketchEntry[]> {
  const entries: DraftSketchEntry[] = [];
  for (let page = 1; page <= DRAFT_SKETCH_PAGE_LIMIT; page += 1) {
    const listed = await requestCreationStep(
      "sketch/ad/list",
      () => creationPathRequest(
        input.sessionRequest,
        "/api/v4/i18n/statistics/sketch/ad/list/",
        buildDraftSketchListPayload(page, DRAFT_SKETCH_PAGE_SIZE),
      ),
      input.credential,
      { semantics: "preflight-read", dispatchState: input.dispatchState },
    );
    const pageEntries = parseDraftSketchList(listed);
    entries.push(...pageEntries);
    if (input.stopWhen?.(entries)) break;
    // 不足一页说明翻到底了，再翻也不会多出来。
    if (pageEntries.length < DRAFT_SKETCH_PAGE_SIZE) break;
  }
  return entries;
}

/**
 * 把匹配到的草稿配上 snap，并解决「这条创意属于哪个广告组」。
 *
 * `save_by_sketch` 返回的是整个系列下所有 sketch 的映射，
 * `creative_sketch_id_to_snap_id` 不带归属信息。系列里只有一个草稿时不会出错，多于一个
 * 时把别人的创意挂上来，发出去就是一条错的广告——所以归属拿不准时宁可不发。
 */
async function resolveDraftPublishItems(input: {
  sessionRequest: CapturedCookieRequest;
  credential: ParsedCookieCredential;
  matched: readonly DraftSketchEntry[];
  mapping: SketchSnapMapping;
}): Promise<DraftSketchPublishItem[]> {
  const missingSnap = input.matched.filter(
    (entry) => !input.mapping.adSnapBySketch.has(entry.adSketchId),
  );
  if (missingSnap.length > 0) {
    throw new ConfirmedCreationFailureError(
      `save_by_sketch 没有返回这些草稿的 snap：${missingSnap.map((entry) => entry.adSketchName).join("、")}，已停止发布。`,
      true,
    );
  }
  const creativeSketchIds = [...input.mapping.creativeSnapBySketch.keys()];
  if (creativeSketchIds.length === 0) {
    throw new ConfirmedCreationFailureError("草稿没有可发布的创意，已停止发布。", true);
  }
  const owners = await readDraftCreativeOwners(input.sessionRequest, input.credential);
  const fullyOwned = creativeSketchIds.every((id) => owners.has(id));
  // 归属查不到时唯一还能确定的情形：整个系列只有这一个广告组草稿，那些创意除了它没有
  // 别的归属可选。这个判据来自 save_by_sketch 自己的返回，不需要相信另一个接口。
  const soleDraft = input.matched.length === 1 && input.mapping.adSnapBySketch.size === 1;
  if (!fullyOwned && !soleDraft) {
    throw new ConfirmedCreationFailureError(
      "无法确定草稿创意归属于哪个广告组（系列下有多个草稿），已停止发布，请在 TikTok 后台手动发布。",
      true,
    );
  }
  return input.matched.map((entry) => {
    const mine = fullyOwned
      ? creativeSketchIds.filter((id) => owners.get(id) === entry.adSketchId)
      : creativeSketchIds;
    if (mine.length === 0) {
      throw new ConfirmedCreationFailureError(
        `草稿 ${entry.adSketchName} 没有可发布的创意，已停止发布。`,
        true,
      );
    }
    return {
      adSketchId: entry.adSketchId,
      adSnapId: input.mapping.adSnapBySketch.get(entry.adSketchId)!,
      creatives: mine.map((creativeSketchId) => ({
        creativeSketchId,
        creativeSnapId: input.mapping.creativeSnapBySketch.get(creativeSketchId)!,
      })),
    };
  });
}

/**
 * 把开始时间已经过去的草稿顶到现在之后。
 *
 * 契约里说「未改动的草稿可以跳过 `ad_snap/save`」，那是对刚建出来的草稿说的。要收口的草稿
 * 通常已经烂了几天到半个月，`start_time` 早就成了过去时，TikTok 会以
 * `validate_start_time_before_now_error` 明确拒绝——2026-08-26 真机上一条 8/13 的草稿正是
 * 这么被拒的，而那次拒绝没有产生任何对象，草稿原样还在。
 *
 * 只动排期：预算、出价、定向全部原样保留，那些是用户当初设好的。开始时间没过期就一个写请求
 * 都不发，回到契约描述的那条最短路径。
 */
async function refreshStaleDraftSchedules(input: {
  sessionRequest: CapturedCookieRequest;
  credential: ParsedCookieCredential;
  dispatchState: CreationDispatchState;
  campaignId: string;
  items: readonly DraftSketchPublishItem[];
  timezone: string;
  riskInfo: Record<string, unknown>;
  now?: Date;
}): Promise<void> {
  const adSnapIds = input.items.map((item) => item.adSnapId);
  const forms = await readAdSnapForms(
    input.sessionRequest,
    input.credential,
    input.dispatchState,
    adSnapIds,
  );
  // TikTok 的排期字符串是账户时区下的 "YYYY-MM-DD HH:mm:ss"，补零对齐，所以同一时区里
  // 直接按字符串比大小就是按时间比大小，不需要再解析回 Date（那反而要猜时区偏移）。
  const now = input.now ?? new Date();
  const nowText = formatProviderDateTime(now, input.timezone);
  const startText = formatProviderDateTime(new Date(now.getTime() + 300_000), input.timezone);
  const stale: string[] = [];
  for (const adSnapId of adSnapIds) {
    const form = forms.get(adSnapId);
    if (!form) {
      throw new UnknownCreationStateError(`TikTok 草稿详情缺少广告组 ${adSnapId}，已停止发布。`);
    }
    const currentStart = typeof form.start_time === "string" ? form.start_time.trim() : "";
    if (!currentStart || currentStart > nowText) continue;
    const updated = cloneRecord(form);
    updated.start_time = startText;
    const currentEnd = typeof updated.end_time === "string" ? updated.end_time.trim() : "";
    if (currentEnd && currentEnd <= startText) {
      const end = new Date(now.getTime() + 300_000);
      end.setUTCFullYear(end.getUTCFullYear() + 10);
      updated.end_time = formatProviderDateTime(end, input.timezone);
    }
    await requestCreationStep(
      "ad_snap/save",
      () => creationPathRequest(input.sessionRequest, "/api/v4/i18n/creation/ad_snap/save/", {
        ad_sketch_form_data: updated,
        spc_upgrade_mode: typeof updated.spc_upgrade_mode === "number" ? updated.spc_upgrade_mode : 1,
        with_sketch: true,
        is_skip_check_fields: false,
        campaign_id: input.campaignId,
        risk_info: input.riskInfo,
      }),
      input.credential,
      { semantics: "mutation", dispatchState: input.dispatchState },
    );
    stale.push(adSnapId);
  }
  if (stale.length === 0) return;
  // 回读确认改动真的落到了草稿上。省掉这一步，过期的排期会一路带到发布，再被拒一次。
  const verified = await readAdSnapForms(
    input.sessionRequest,
    input.credential,
    input.dispatchState,
    stale,
  );
  for (const adSnapId of stale) {
    const form = verified.get(adSnapId);
    if (!form || form.start_time !== startText) {
      throw new UnknownCreationStateError("TikTok 草稿开始时间未能回读确认，已停止发布。");
    }
  }
}

/**
 * creative_sketch_id → ad_sketch_id。查不到就返回空表，由调用方决定还能不能安全发布——
 * 这个接口只用来消除歧义，它本身不可用不该直接毙掉整次发布。
 */
async function readDraftCreativeOwners(
  sessionRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
): Promise<Map<string, string>> {
  try {
    const listed = await requestCreationStep(
      "sketch/creative/list",
      () => creationPathRequest(
        sessionRequest,
        "/api/v4/i18n/statistics/sketch/creative/list/",
        buildDraftSketchListPayload(1, DRAFT_SKETCH_PAGE_SIZE),
      ),
      credential,
      { semantics: "preflight-read" },
    );
    return parseDraftCreativeOwners(listed);
  } catch {
    return new Map<string, string>();
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
  /**
   * 记录实际发出的请求体，供失败后与真机抓包逐字段比对。
   *
   * 挂在 dispatchState 上而不是 boundary 上是有意的：真正需要留证的是 mutation
   * （campaign_snap/save、ad_snap/save、creative_snap/save、create_by_snap），
   * 而它们恰好都带 dispatchState；只读预检不带，也不需要留。
   */
  recordRequest?: (step: string, body: string | undefined) => void;
}

/**
 * 攒一次创建过程中发出的请求体。
 *
 * 只收请求体，**不碰请求头**——Cookie 与鉴权信息一律不落库。
 */
export function createSentRequestRecorder(): {
  record: (step: string, body: string | undefined) => void;
  drain: () => LaunchSentRequest[];
} {
  const entries: LaunchSentRequest[] = [];
  return {
    record(step, body) {
      if (body === undefined) return;
      if (entries.length >= SENT_REQUEST_MAX_ENTRIES) return;
      const trimmed = body.length > SENT_REQUEST_BODY_LIMIT
        ? `${body.slice(0, SENT_REQUEST_BODY_LIMIT)}…[已截断 ${body.length - SENT_REQUEST_BODY_LIMIT} 字符]`
        : body;
      entries.push({ step, body: trimmed });
    },
    drain: () => entries.slice(),
  };
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

  // 在发出之前记录：请求发出去之后再记，一旦 fetch 抛异常就什么都留不下，
  // 而那恰恰是最需要看报文的时候。
  boundary.dispatchState?.recordRequest?.(step, request.body);

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
      // Creative saves built from a server-copied Smart+ template routinely
      // take longer than 15 seconds. Keep the request alive long enough to
      // receive TikTok's authoritative response instead of manufacturing an
      // avoidable unknown state after the server has already accepted it.
      signal: AbortSignal.timeout(30_000),
    };
    if (request.method === "POST" && request.body !== undefined) requestInit.body = request.body;
  } catch (cause) {
    throw new RetryableCreationError(
      cause instanceof Error ? cause.message : "请求参数初始化失败。",
    );
  }

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

  // 传输层失败最多重试两次（共 3 次尝试），且仅在能从数学上证明「这次请求
  // 从未离开本机」时才重试——ECONNREFUSED / ENOTFOUND 等发生在 TCP 连接建立
  // 之前，重放同一个请求不存在产生重复写入的风险。凡是无法证明这一点的失败
  // （连接被重置、真正的超时等），维持原有行为：立即判定为结果未知，不自动
  // 重试，交由上层幂等表拦下等待人工确认。
  const retryDelaysMs = [500, 1500];
  let response: Response | undefined;
  for (let attempt = 0; response === undefined; attempt += 1) {
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

    try {
      // Once fetch returns a promise, transport rejection cannot prove whether
      // TikTok received the request.
      response = await pending;
    } catch (cause) {
      const delay = retryDelaysMs[attempt];
      if (delay !== undefined && isDefinitelyUnsentNetworkError(cause)) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw uncertainCreationRequestError(
        cause instanceof Error ? cause.message : "请求已发送，但响应丢失。",
        boundary,
      );
    }
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

function copiedExistingCampaignDraftIds(payload: Record<string, unknown>): InitializedDraftIds {
  const data = isRecord(payload.data) ? payload.data : undefined;
  const allCopy = data && isRecord(data.all_copy_result) ? data.all_copy_result : undefined;
  const list = allCopy && Array.isArray(allCopy.ad_and_creative_copy_result_list)
    ? allCopy.ad_and_creative_copy_result_list.filter(isRecord)
    : [];
  const item = list.length === 1 ? list[0] : undefined;
  const adItem = item && isRecord(item.new_ad_snap_info_item)
    ? item.new_ad_snap_info_item
    : undefined;
  const adSnapId = adItem ? nonEmptyId(adItem.ad_snap_id) : undefined;
  const adSketchId = item ? nonEmptyId(item.new_ad_sketch_id) : undefined;
  const adForm = adItem && isRecord(adItem.ad_snap_form_data)
    ? adItem.ad_snap_form_data
    : undefined;
  const creativeItems = item && Array.isArray(item.new_creative_snap_info_item_list)
    ? item.new_creative_snap_info_item_list.filter(isRecord)
    : [];
  const creativeItem = creativeItems.length === 1 ? creativeItems[0] : undefined;
  const creativeSnapId = creativeItem ? nonEmptyId(creativeItem.creative_snap_id) : undefined;
  const creativeForm = creativeItem && isRecord(creativeItem.asset_group_creative_snap_form_data)
    ? creativeItem.asset_group_creative_snap_form_data
    : undefined;
  const creativeSketchIds = item && Array.isArray(item.new_creative_sketch_ids)
    ? item.new_creative_sketch_ids
    : [];
  const creativeSketchId = nonEmptyId(creativeSketchIds[0]);
  if (!adSnapId || !adSketchId || !adForm || !creativeSnapId || !creativeSketchId || !creativeForm) {
    throw new UnknownCreationStateError(
      "TikTok 现有系列广告组初始化响应缺少广告组或创意的 snap/sketch/form 数据。",
    );
  }
  return {
    campaignSnapId: "",
    campaignSketchId: "",
    adSnapId,
    adSketchId,
    creativeSnapId,
    creativeSketchId,
    campaignForm: {},
    adForm,
    creativeForm,
    publishItems: [{
      ad_id: "",
      ad_snap_id: adSnapId,
      ad_sketch_id: adSketchId,
      creative_snap_info_list: [{
        creative_id: "",
        creative_snap_id: creativeSnapId,
        creative_sketch_id: creativeSketchId,
        need_publish: true,
      }],
      need_publish: true,
    }],
  };
}

function selectCompatibleTargetTemplate(
  campaigns: ProviderEntity[],
  adGroups: ProviderEntity[],
  mutation: CreationMutation,
  preferredCampaignId?: string,
): { campaignId: string; adGroupId: string } | undefined {
  const campaignIdsWithGroups = new Set(
    adGroups
      .map((entity) => normalizeProviderEntity(entity).parentCampaignId)
      .filter((id): id is string => Boolean(id)),
  );
  const desiredSmartPlus = mutation.preset.objectiveType === 3;
  const candidates = campaigns.filter((entity) => {
    if (!campaignIdsWithGroups.has(entity.externalId)) return false;
    const objectiveType = providerEntityNumber(entity, "objective_type");
    if (objectiveType !== undefined && objectiveType !== mutation.preset.objectiveType) return false;
    const universalType = providerEntityNumber(entity, "universal_type");
    if (universalType !== undefined && (universalType === 1) !== desiredSmartPlus) return false;
    const normalized = normalizeProviderEntity(entity);
    if (mutation.preset.campaignBudgetMode === -1 && normalized.campaignBudgetOptimized) return false;
    return true;
  });
  candidates.sort((left, right) => {
    if (left.externalId === preferredCampaignId) return -1;
    if (right.externalId === preferredCampaignId) return 1;
    const leftTime = Date.parse(normalizeProviderEntity(left).createdAt ?? "") || 0;
    const rightTime = Date.parse(normalizeProviderEntity(right).createdAt ?? "") || 0;
    return rightTime - leftTime || right.externalId.localeCompare(left.externalId);
  });
  const campaignId = candidates[0]?.externalId;
  if (!campaignId) return undefined;
  const templateAdGroup = adGroups
    .filter((entity) => normalizeProviderEntity(entity).parentCampaignId === campaignId)
    .sort((left, right) => {
      const leftTime = Date.parse(normalizeProviderEntity(left).createdAt ?? "") || 0;
      const rightTime = Date.parse(normalizeProviderEntity(right).createdAt ?? "") || 0;
      return rightTime - leftTime || right.externalId.localeCompare(left.externalId);
    })[0];
  return templateAdGroup
    ? { campaignId, adGroupId: templateAdGroup.externalId }
    : undefined;
}

function providerEntityNumber(entity: ProviderEntity, key: string): number | undefined {
  const statData = isRecord(entity.payload.stat_data) ? entity.payload.stat_data : {};
  const value = entity.payload[key] ?? statData[key];
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

async function readPublishedAssetGroupCreativeId(
  sessionRequest: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  adGroupId: string,
  expectedPostIds: string[],
): Promise<string | undefined> {
  const url = new URL(sessionRequest.url);
  const advertiserId = url.searchParams.get("aadvid");
  url.pathname = "/api/v4/i18n/creation/snap/get_creative_fields_by_ad";
  url.search = "";
  if (advertiserId) url.searchParams.set("aadvid", advertiserId);
  url.searchParams.set("ad_id", adGroupId);
  const payload = await requestCookieJson({
    ...sessionRequest,
    target: "ad",
    url: url.toString(),
    method: "GET",
    derived: true,
  }, credential);
  const data = isRecord(payload.data) ? payload.data : {};
  const resultMap = isRecord(data.result_map) ? data.result_map : {};
  const matches = Object.entries(resultMap).flatMap(([creativeId, raw]) => {
    const form = decodeJsonStrings(raw);
    if (!isRecord(form)) return [];
    const serialized = JSON.stringify(form);
    return expectedPostIds.every((itemId) => serialized.includes(itemId))
      ? [creativeId]
      : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function migrationProductInfo(value: unknown): LaunchProductInfo | null {
  if (!isRecord(value)) return null;
  const promoCodeInfos = Array.isArray(value.promo_code_infos)
    ? value.promo_code_infos.flatMap((candidate) => {
        if (!isRecord(candidate)) return [];
        const codeType = numericValue(candidate.code_type);
        const amount = numericValue(candidate.value);
        const includeType = numericValue(candidate.include_type);
        const currency = typeof candidate.currency === "string" ? candidate.currency.trim() : "";
        if (codeType === null || amount === null || includeType === null || !currency) return [];
        return [{
          code: typeof candidate.code === "string" ? candidate.code : "",
          code_type: codeType,
          value: amount,
          currency,
          include_type: includeType,
        }];
      })
    : [];
  const sellingPoints = Array.isArray(value.selling_points_by_types)
    ? value.selling_points_by_types.flatMap((candidate) => {
        if (!isRecord(candidate)) return [];
        const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
        const materialTag = numericValue(candidate.material_tag);
        return text && materialTag !== null ? [{ text, material_tag: materialTag }] : [];
      })
    : [];
  if (promoCodeInfos.length === 0 && sellingPoints.length === 0) return null;
  return {
    promo_code_infos: promoCodeInfos,
    is_auto_use: numericValue(value.is_auto_use) ?? 2,
    auto_select_toggle: numericValue(value.auto_select_toggle) ?? 0,
    image_infos: [],
    selling_points_by_types: sellingPoints,
  };
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

function originalPostReadSession(context: ProviderContext): {
  credential: ParsedCookieCredential;
  sessionRequest: CapturedCookieRequest;
} {
  CookieConnectionSettingsSchema.parse(context.settings);
  const credential = CookieCredentialInputSchema.parse(context.credential);
  const sessionRequest = credential.requestTemplates?.find(
    (item) => item.target === "ad-group" && !item.derived,
  );
  if (!sessionRequest) {
    throw new RetryableCreationError(
      "缺少广告组列表 cURL，无法建立原帖读取会话。",
    );
  }
  return { credential, sessionRequest };
}

function findAssetGroupCreativeId(value: unknown, adGroupId: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findAssetGroupCreativeId(item, adGroupId);
      if (result) return result;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const candidateId = nonEmptyId(value.id) ?? nonEmptyId(value.ad_id);
  if (candidateId === adGroupId && Array.isArray(value.asset_group_brief_info_item_list)) {
    for (const item of value.asset_group_brief_info_item_list) {
      if (!isRecord(item)) continue;
      const id = nonEmptyId(item.id);
      if (id) return id;
    }
  }
  for (const child of Object.values(value)) {
    const result = findAssetGroupCreativeId(child, adGroupId);
    if (result) return result;
  }
  return null;
}

function parseOriginalPost(value: unknown): LaunchOriginalPost[] {
  if (!isRecord(value)) return [];
  const postInfo = isRecord(value.post_info) ? value.post_info : value;
  const itemId = nonEmptyId(postInfo.item_id) ?? nonEmptyId(postInfo.aweme_item_id);
  const identityId = nonEmptyId(postInfo.identity_id);
  const identityType = numericValue(postInfo.identity_type);
  const videoInfo = isRecord(postInfo.video_info) ? postInfo.video_info : {};
  const authCodeInfo = isRecord(postInfo.auth_code_info) ? postInfo.auth_code_info : {};
  const vid = nonEmptyId(videoInfo.vid) ?? nonEmptyId(postInfo.vid);
  if (!itemId || !identityId || identityType === null || !vid) return [];
  const status = numericValue(postInfo.status);
  const authCodeStatus = numericValue(postInfo.auth_code_status)
    ?? numericValue(authCodeInfo.auth_code_status)
    ?? numericValue(authCodeInfo.ad_auth_status);
  const promotable = postInfo.can_preview !== false
    && postInfo.is_ccoc_ban !== true
    && (status === null || status >= 0)
    && (authCodeStatus === null || authCodeStatus >= 0);
  const coverUrl = nonEmptyString(videoInfo.cover_url)
    ?? nonEmptyString(videoInfo.cover_uri)
    ?? null;
  return [{
    itemId,
    identityId,
    identityType,
    identityBcId: nonEmptyId(postInfo.identity_bc_id) ?? null,
    vid,
    videoId: nonEmptyId(videoInfo.video_id) ?? null,
    displayName: nonEmptyString(postInfo.title)
      ?? nonEmptyString(postInfo.text)
      ?? nonEmptyString(postInfo.nick_name)
      ?? null,
    coverUrl: coverUrl && isHttpUrlValue(coverUrl) ? coverUrl : null,
    promotable,
  }];
}

function uniqueOriginalPosts(posts: LaunchOriginalPost[]): LaunchOriginalPost[] {
  const unique = new Map<string, LaunchOriginalPost>();
  for (const post of posts) if (!unique.has(post.itemId)) unique.set(post.itemId, post);
  return [...unique.values()];
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstStringByKeys(value: unknown, keys: ReadonlySet<string>): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = firstStringByKeys(item, keys);
      if (result) return result;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key)) {
      const result = nonEmptyString(child);
      if (result) return result;
    }
  }
  for (const child of Object.values(value)) {
    const result = firstStringByKeys(child, keys);
    if (result) return result;
  }
  return null;
}

function isHttpUrlValue(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}



/** 写请求和单发只读请求的超时预算。 */
const COOKIE_REQUEST_TIMEOUT_MS = 15_000;

/**
 * 只读列表请求单独的、更宽的超时预算。
 *
 * 15 秒对广告层级列表不够用：生产实测 100 条广告的账户会稳定卡在这个边界上，
 * 75 条的偶尔卡，62 条和 2 条的从来不卡——失败账户和广告条数完全对应。超时导致
 * 整轮同步被判 partial，而删除和自动复制都要求最近一次同步是 healthy。
 *
 * 只放宽只读列表这一条路径：requestAllCookieListPages 仅供 syncReadOnly 使用，
 * 写请求（创建、启停、删除）继续用 COOKIE_REQUEST_TIMEOUT_MS，它们的超时语义
 * 是"结果未知"，拖长只会扩大不确定窗口。
 */
const COOKIE_LIST_REQUEST_TIMEOUT_MS = 45_000;

async function requestCookieJson(
  request: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  timeoutMs: number = COOKIE_REQUEST_TIMEOUT_MS,
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
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (request.method === "POST" && request.body !== undefined) {
    requestInit.body = request.body;
  }
  const response = await fetch(request.url, requestInit);
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("json")) {
    throw new Error(`Cookie 请求验证失败（HTTP ${response.status}）。`);
  }
  // 先读文本再自己解析，而不是 response.json()。TikTok 会在 content-type 仍然写着
  // json 的情况下回一段纯文本错误（例如后端 JSON 解包失败时的 `json: cannot
  // unmarshal ...`），此时 response.json() 抛的是 JS 自己的 SyntaxError，只带
  // 十来个字符的预览——2026-08-06 的自动申诉就是这样连"哪个字段不对"都查不到，
  // 三条申诉全部判为结果未知且再也不会重试。真实响应必须进错误消息。
  const raw = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Cookie 请求返回的不是 JSON：${sanitizeProviderMessage(raw) || "（响应体为空）"}`,
    );
  }
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
        // ACO 创意列表永远留空：它和 creative_list 装的是不同类型的对象，普通广告
        // ID 落进来会被 TikTok 以 code 4「不支持特定界面」拒绝。这里强制置空而不是
        // 只靠导入时写对，是为了让升级前已经存下的模板（里面是 creative_list 的
        // 副本）不必重新导入就能自愈。
        if (field.name.toLowerCase() === "aco_creative_list") {
          return { value: "[]" };
        }
        return {
          value: replaceMultipartEntityList(field.value, mutation.externalId),
        };
      });
      // Use `matched` (field found), not `changes` (text actually differs).
      // When the target entity happens to be the very object whose id was
      // baked into the imported cURL at capture time, the replacement value
      // equals the existing value — a real match with zero text diff. Gating
      // on `changes` there falsely reports "no matching field" and blocks the
      // write for that one entity forever, even though the field was found.
      replacements += replaced.matched;
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

/**
 * 本次发布真正创建出来的广告（创意）ID。
 *
 * 复制和扩组都是让 TikTok 按源对象克隆，创意的开关状态一并被克隆过来：源广告组
 * 里的广告是关的，新组里的广告也是关的，于是组开着、广告关着，整组投不出去。
 * 发布载荷里只有 is_status_disabled 一个开关且只作用于广告组层，创意快照里没有
 * 状态字段，所以只能拿到这些 ID 之后再显式开一次。
 */

function completedCreativeIds(payload: Record<string, unknown>): string[] {
  const data = isRecord(payload.data) ? payload.data : payload;
  const result = isRecord(data.result) ? data.result : data;
  const ads = isRecord(result.ad_and_creative)
    ? Object.values(result.ad_and_creative)
    : Array.isArray(result.ad_and_creative) ? result.ad_and_creative : [];
  return [...new Set(ads.flatMap((ad) => {
    if (!isRecord(ad)) return [];
    const groups = isRecord(ad.asset_group_result)
      ? Object.values(ad.asset_group_result)
      : Array.isArray(ad.asset_group_result) ? ad.asset_group_result : [];
    return groups.flatMap((group) => {
      if (!isRecord(group)) return [];
      const creatives = Array.isArray(group.creative_items)
        ? group.creative_items
        : isRecord(group.creative_items) ? Object.values(group.creative_items) : [];
      return creatives.flatMap((creative) => {
        if (!isRecord(creative)) return [];
        const id = nonEmptyId(creative.id) ?? nonEmptyId(creative.creative_id);
        return id ? [id] : [];
      });
    });
  }))];
}

/**
 * 把刚创建出来的广告显式打开。
 *
 * 只处理本次发布返回的创意 ID，不碰任何存量对象；只在广告组以 enabled 发布时才执行，
 * 组以 disabled 发布就全部保持关闭。
 *
 * 原生定时投放的组也是以 enabled 发布的，同样要开：拦住投放的是 TikTok 按广告组排期
 * 判定的 ad_time_no_reach，不是广告自己的开关。生产快照里正常的定时批次广告本来就是
 * 开的（creative_opt_status=0 + creative_ad_time_no_reach），漏开的那几批反而投不出去。
 *
 * 开启失败不推翻整次创建：广告组已经建好了，把它判成失败会诱发重复创建。失败信息
 * 汇总返回给调用方记录。
 */
async function enableCreatedCreatives(
  credential: ParsedCookieCredential,
  creativeIds: string[],
): Promise<string[]> {
  if (creativeIds.length === 0) return [];
  const template = credential.requestTemplates?.find(
    (item) => item.target === "ad-status" && item.action === "enable",
  );
  if (!template) return ["缺少广告层开关模板，新建广告保持克隆自源广告的开关状态。"];
  const failures: string[] = [];
  for (const externalId of creativeIds) {
    try {
      await requestCookieJson(
        materializeStatusRequest(template, { entityType: "ad", externalId, action: "enable" }),
        credential,
      );
    } catch (cause) {
      failures.push(
        `广告 ${externalId} 开启失败：${cause instanceof Error ? cause.message : "未知错误"}`,
      );
    }
  }
  return failures;
}

/**
 * 广告组日预算的写入请求。
 *
 * 形状对照 2026-08-25 的真机抓包，逐项都有出处：
 *   POST /api/v3/i18n/overture/ad/{广告组 ID}/update_budget/?aadvid=...&req_src=ad_creation
 *   content-type: multipart/form-data
 *   budget=<数字>  ad_channel=1  risk_info[...]=<浏览器指纹>
 *
 * 三个要点：
 *
 * 1. 路径段写作 `ad`，装的却是**广告组** ID——与申诉、素材启停同一套口径（2026-08-06
 *    申诉全败就是把广告 ID 填进了这个位置）。
 * 2. 报文是 multipart，不是 JSON。抓包里就是 multipart，没有 JSON 版本的证据，因此
 *    这里不去猜服务端是否也收 JSON。
 * 3. `risk_info[...]` 在抓包里装的是真实浏览器指纹（分辨率、语言、UA）。**不伪造**：
 *    只透传账户创建档案里已有的那份；没有就整段不发。素材启停接口用空 risk_info 是
 *    能过的，但那是另一个接口，不能拿来给这个接口背书——所以这条留作真机验证项。
 */
function buildAdGroupBudgetRequest(
  sessionRequest: CapturedCookieRequest,
  advertiserId: string,
  mutation: AdGroupBudgetMutation,
  riskInfo: Record<string, unknown>,
): CapturedCookieRequest {
  const adGroupId = mutation.externalId.trim();
  if (!adGroupId) throw new Error("缺少广告组 ID，无法构造预算写入请求。");
  if (!Number.isFinite(mutation.budget) || mutation.budget <= 0) {
    throw new Error("预算必须是大于 0 的数字。");
  }
  const url = new URL(sessionRequest.url);
  url.pathname = `/api/v3/i18n/overture/ad/${encodeURIComponent(adGroupId)}/update_budget/`;
  url.searchParams.set("aadvid", advertiserId);
  url.searchParams.set("req_src", "ad_creation");

  const boundary = `----TkAutoBoundary${adGroupId}`;
  const fields: Array<[string, string]> = [
    ["budget", String(mutation.budget)],
    ["ad_channel", "1"],
  ];
  for (const [key, value] of Object.entries(riskInfo)) {
    if (value === null || value === undefined) continue;
    fields.push([`risk_info[${key}]`, String(value)]);
  }
  const body = `${fields
    .map(([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    .join("")}--${boundary}--\r\n`;

  return {
    ...sessionRequest,
    target: "ad-group-budget",
    derived: true,
    method: "POST",
    contentType: `multipart/form-data; boundary=${boundary}`,
    url: url.toString(),
    body,
  };
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
    if (isStatusKey(key)) {
      url.searchParams.set(key, matchCase(url.searchParams.get(key) ?? "", "delete"));
      replacements += 1;
    }
  }
  let body = materialized.body;
  if (body) {
    const contentType = materialized.contentType?.toLowerCase() ?? "";
    if (isMultipartBody(contentType, body)) {
      const replaced = rewriteMultipartFields(body, (field) =>
        isStatusKey(field.name)
          ? { value: matchCase(field.value.trim(), "delete") }
          : undefined,
      );
      // See the matching comment in materializeStatusRequest: `matched`, not
      // `changes` — a captured template whose operation_status already reads
      // "DELETE" is still a real match with zero text diff.
      replacements += replaced.matched;
      body = replaced.body;
    } else if (contentType.includes("json") || body.trim().startsWith("{")) {
      const parsed = JSON.parse(body) as unknown;
      const replaced = replaceOperationStatus(parsed);
      replacements += replaced.count;
      body = JSON.stringify(replaced.value);
    } else {
      const params = new URLSearchParams(body);
      for (const key of [...params.keys()]) {
        if (isStatusKey(key)) {
          params.set(key, matchCase(params.get(key) ?? "", "delete"));
          replacements += 1;
        }
      }
      body = params.toString();
    }
  }
  if (replacements === 0) {
    throw new Error("广告组关闭 cURL 中未找到开关字段，无法安全派生删除请求。");
  }
  return { ...materialized, url: url.toString(), body };
}

/**
 * 这条模板里是否存在可以改写成 delete 的开关字段。
 *
 * 判据必须和 materializeDeletionRequest 实际扫描的位置一一对应（URL 查询参数、
 * multipart 字段、JSON 键、表单键），否则能力上报又会和真实能力脱节。
 */
function hasRewritableStatusField(template: CapturedCookieRequest): boolean {
  const url = new URL(template.url);
  if ([...url.searchParams.keys()].some(isStatusKey)) return true;
  const body = template.body;
  if (!body) return false;
  const contentType = template.contentType?.toLowerCase() ?? "";
  if (isMultipartBody(contentType, body)) {
    return parseMultipartFields(body).some((field) => isStatusKey(field.name));
  }
  if (contentType.includes("json") || body.trim().startsWith("{")) {
    try {
      return replaceOperationStatus(JSON.parse(body) as unknown).count > 0;
    } catch {
      return false;
    }
  }
  return [...new URLSearchParams(body).keys()].some(isStatusKey);
}

function replaceOperationStatus(
  value: unknown,
): { value: unknown; count: number } {
  if (Array.isArray(value)) {
    let count = 0;
    const output = value.map((item) => {
      const replaced = replaceOperationStatus(item);
      count += replaced.count;
      return replaced.value;
    });
    return { value: output, count };
  }
  if (!isRecord(value)) return { value, count: 0 };
  let count = 0;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isStatusKey(key)) {
      output[key] = typeof item === "string" ? matchCase(item, "delete") : "delete";
      count += 1;
      continue;
    }
    const replaced = replaceOperationStatus(item);
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
    material: [],
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
    material: [],
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
      // 原本就是空数组的列表保持为空。广告层的开关请求同时带 creative_list 与
      // aco_creative_list，真实请求只填其中一个、另一个留空——两者装的是不同类型
      // 的对象。无差别填充会把普通广告 ID 塞进 ACO 列表，被 TikTok 以 code 4 拒绝。
      // 保持这条规则也让「抓的是 ACO 创意开关」那种捕获同样成立。
      return parsed.length === 0 ? trimmed : JSON.stringify([externalId]);
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

/**
 * 申诉请求。字段形状对照 2026-08-06 的真机抓包，逐项都有出处——此前这段报文是手写
 * 的，从未对过真机，三处不一致叠加导致 TikTok 在解 JSON 时就拒绝，连"哪个字段不对"
 * 都看不到（响应体是纯文本的 `json: cannot unmarshal ...`）：
 *
 * 1. `creative_id` 是**数字**字面量，其余 ID 都是字符串。此前发的是字符串。
 * 2. `ad_id` 装的是**广告组** ID，`creative_id` 才是广告自己。此前两处都填了广告 ID。
 * 3. `aadvid` / `advertiser_id` / `adv_entry` 三个必填字段此前根本没发。
 *
 * 查询串上的 `req_src=bidding` 同样照抓包补上。msToken / X-Bogus 之类的签名参数沿用
 * 会话 cURL 上原有的：这次失败发生在服务端解包阶段，说明鉴权本来就过得去。
 */
function buildReusableAppealRequest(
  sessionRequest: CapturedCookieRequest,
  advertiserId: string,
  mutation: import("./types.js").AppealMutation,
): CapturedCookieRequest {
  const url = new URL(sessionRequest.url);
  url.pathname = "/api/v4/i18n/creation/audit/appeal_creative/";
  url.searchParams.set("aadvid", advertiserId);
  url.searchParams.set("req_src", "bidding");
  return {
    target: "appeal",
    url: url.toString(),
    method: "POST",
    contentType: "application/json",
    headers: sessionRequest.headers,
    derived: true,
    body: appealRequestBody(advertiserId, mutation),
  };
}

/** `creative_id` 必须是数字字面量，占位后替换成裸数字再发。 */
const APPEAL_CREATIVE_ID_PLACEHOLDER = "__APPEAL_CREATIVE_ID__";

function appealRequestBody(
  advertiserId: string,
  mutation: import("./types.js").AppealMutation,
): string {
  const creativeId = mutation.creativeId.trim();
  if (!/^\d+$/.test(creativeId)) {
    throw new Error("广告 ID 不是纯数字，无法构造申诉请求。");
  }
  if (!mutation.adGroupId.trim()) {
    throw new Error("缺少广告所属的广告组 ID，无法构造申诉请求。");
  }
  const serialized = JSON.stringify({
    ad_id: mutation.adGroupId,
    aadvid: advertiserId,
    adv_entry: "ad review detail",
    appeal_reason: mutation.reason,
    attachment_list: [],
    appeal_reason_type: 1,
    creative_id: APPEAL_CREATIVE_ID_PLACEHOLDER,
    advertiser_id: advertiserId,
  });
  // 换成裸数字而不是走 Number()：TikTok 的 ID 可以长到 19 位，超过 2^53 之后
  // JSON.stringify(Number(id)) 会静默改写末几位，发出去的就不是这条广告了。
  return serialized.replace(`"${APPEAL_CREATIVE_ID_PLACEHOLDER}"`, creativeId);
}

/** 最终广告列表既要换路径，也要换统计维度。沿用广告组捕获里的
 * `dimensions: ["ad_id"]` 时，TikTok 按广告组维度作答：每行 universal_type=1
 * 且 creative_id 是 "0" 占位值，而 extractEntities 会刻意丢弃这类占位行，
 * 于是广告层级每轮都同步为空。改成 creative_id 维度才会返回真正的最终广告。 */
function adFinalListRequest(
  template: CapturedCookieRequest,
): CapturedCookieRequest {
  const url = new URL(template.url);
  url.pathname = url.pathname.replace(
    /\/adgroup\/list(?=\/|$)/i,
    "/ad/list",
  );
  let body = template.body;
  if (body && template.contentType?.toLowerCase().includes("json")) {
    try {
      const value = JSON.parse(body) as unknown;
      if (isRecord(value)) {
        const commonRequest = isRecord(value.common_req) ? value.common_req : {};
        commonRequest.dimensions = ["creative_id"];
        commonRequest.page = 1;
        commonRequest.page_size = 100;
        value.common_req = commonRequest;
        body = JSON.stringify(value);
      }
    } catch {
      // 与系列列表一致：解析不了的请求体保持原样，交由列表预检拦截。
    }
  }
  return { ...template, target: "ad", url: url.toString(), body };
}

function deriveFinalAdReadRequest(
  request: CapturedCookieRequest | undefined,
): CapturedCookieRequest | undefined {
  if (!request) return undefined;
  const url = new URL(request.url);
  // The two-step Cookie onboarding captures the statistics ad-group list.
  // The matching final-ad list for that endpoint family is ad/list.
  if (!url.pathname.toLowerCase().includes("/statistics/op/")) return undefined;
  if (!/\/adgroup\/list(?=\/|$)/i.test(url.pathname)) return undefined;
  return { ...adFinalListRequest(request), derived: true };
}

/**
 * 响应里"看起来是列表"的行数，跟能不能解析出 ID 无关。
 * 用来区分「这批广告本来就没有素材」（0 行，正常）和「字段形状变了」
 * （有行但一条都解析不出来，整层失效）。
 */
function countEntityListRows(
  payload: Record<string, unknown>,
  entityType: SyncEntityType,
): number {
  const data = isRecord(payload.data) ? payload.data : payload;
  for (const key of entityListKeys[entityType]) {
    if (Array.isArray(data[key])) return data[key].length;
  }
  return 0;
}

const entityListKeys: Record<SyncEntityType, string[]> = {
  material: ["table", "list", "items"],
  campaign: ["campaigns", "campaign_list", "table", "list", "items"],
  "ad-group": ["adgroups", "ad_groups", "adgroup_list", "table", "list", "items"],
  ad: ["ads", "ad_list", "table", "list", "items"],
};

/**
 * 这一行代表的对象是不是已经被删除了。
 *
 * 判据只看状态字段里的 delete 词根，不看 is_del：真机上 is_del 并不总是出现在列表
 * 响应里，而 *_primary_status 一直有。刻意只匹配 delete 这一个词根——宁可漏判，也
 * 不要把正常对象误滤出快照（对象凭空消失比多留一行难查得多）。
 */
function isDeletedEntityRow(lookup: (key: string) => unknown): boolean {
  const keys = [
    "ad_primary_status",
    "adgroup_primary_status",
    "campaign_primary_status",
    "creative_primary_status",
    "material_primary_status",
    "primary_status",
    "operation_status",
    "ad_status",
    "campaign_status",
  ];
  for (const key of keys) {
    const value = lookup(key);
    if (typeof value !== "string") continue;
    if (value.trim().toLowerCase().includes("delete")) return true;
  }
  return false;
}

function extractEntities(
  payload: Record<string, unknown>,
  entityType: SyncEntityType,
): ProviderEntity[] {
  const data = isRecord(payload.data) ? payload.data : payload;
  let list: unknown[] = [];
  for (const key of entityListKeys[entityType]) {
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
    // 已删除的对象不进快照。
    //
    // TikTok 的列表接口会把已删除的广告组和广告一起返回，状态字段写作 delete，而
    // normalizeStatus 只认 disable/paused 系的词，delete 会落进兜底的 "enabled"
    // 分支——2026-08-24 生产上因此有 166 个已删广告组 + 166 个已删广告被判为
    // 「已开启」堆在广告管理列表里。真正的危险不在界面：enrollNightlyAdGroups
    // 在 23:45 会把所有 enabled 的广告组排队关闭，对已删对象发写请求必被拒，连续
    // 失败会打开写入熔断器、停掉整个账户的自动化。
    //
    // 素材层当年在请求里加 is_del=0 解决同一个问题，但那依赖 TikTok 认这个筛选字段。
    // 这里在解析侧按状态判，不依赖对端行为，三个层级一致生效。
    if (isDeletedEntityRow(lookup)) return [];
    const idKeys: Record<SyncEntityType, string[]> = {
      // 素材的 ID 走 materialDraftId：真机把它写成 "[1872777743628513]"，
      // 是个字符串包着的数组，直接当 ID 用会连方括号一起发出去。
      material: [],
      campaign: ["campaign_id", "campaignId", "id"],
      "ad-group": ["adgroup_id", "ad_group_id", "adGroupId", "ad_id", "id"],
      ad: ["creative_id", "creativeId", "ad_id", "adId", "id"],
    };
    const id = entityType === "material"
      ? materialDraftId(lookup("ad_material_draft_id"))
      : idKeys[entityType].map(lookup).find(isStableExternalId);
    if (id === undefined) return [];
    // 两级系列里广告即广告组：回填 campaign_id / adgroup_id 到 payload，
    // 缺 adgroup_id 时用 ad_id 兜底，供父子关系解析与复制定位使用。
    const payload = entityType === "ad"
      ? {
          ...item,
          campaign_id: lookup("campaign_id") ?? item.campaign_id,
          adgroup_id:
            item.adgroup_id
            ?? item.ad_group_id
            ?? statData.adgroup_id
            ?? item.ad_id
            ?? statData.ad_id
            ?? id,
        }
      // 素材行里广告组落在 ad_id 上（creative_id 才是广告）。回填成 adgroup_id，
      // 父子关系解析与素材启停都从这里取——启停报文缺了它发不出去。
      : entityType === "material"
        ? { ...item, adgroup_id: item.adgroup_id ?? item.ad_id }
        : item;
    return [{ entityType, externalId: String(id), payload }];
  });
}

/**
 * 素材 ID。真机把它写成 `"[1872777743628513]"`——一个字符串包着的数组，直接拿来
 * 当 ID 会把方括号一起发出去，`procedural_material/update_status` 会拒收。
 *
 * 只接受单元素：一行素材对应一个可独立启停的对象，出现多个说明这行不是我们以为
 * 的那种素材行，宁可跳过也不要猜一个。
 */
/**
 * 单个广告的素材列表请求。
 *
 * 路径与报文形状对照 2026-08-08 的真机抓包。这个接口只能**按广告逐个查**
 * （`expand` 就是"展开某个广告"），没有全账户列表——所以调用方必须自己控制
 * 查哪些广告，不能对全部广告逐个调。
 */
/**
 * 单条素材的启停请求。
 *
 * 报文形状对照 2026-08-08 的真机抓包：
 *   {"ad_id":"<广告组 ID>","material_list":["<素材 ID>"],"carousel_id_list":[],
 *    "operation":"enable|disable","ad_channel":1,"risk_info":{...}}
 *
 * 注意 `ad_id` 装的是**广告组**，不是广告——与申诉接口同一套口径（2026-08-06
 * 申诉全败就是把广告 ID 填进了这个位置）。所以素材的启停必须带上父级广告组 ID，
 * 光有素材 ID 发不出去。
 */
function materializeMaterialStatusRequest(
  sessionRequest: CapturedCookieRequest,
  mutation: StatusMutation,
): CapturedCookieRequest {
  const adGroupId = mutation.parentAdGroupId?.trim();
  if (!adGroupId) {
    throw new Error("缺少素材所属的广告组 ID，无法构造素材启停请求。");
  }
  const url = new URL(sessionRequest.url);
  url.pathname = "/api/v3/i18n/overture/procedural_material/update_status/";
  url.searchParams.set("req_src", "bidding");
  return {
    ...sessionRequest,
    target: "material-status",
    action: mutation.action,
    derived: true,
    method: "POST",
    contentType: "application/json",
    url: url.toString(),
    body: JSON.stringify({
      ad_id: adGroupId,
      material_list: [mutation.externalId],
      carousel_id_list: [],
      operation: mutation.action,
      ad_channel: 1,
      risk_info: {},
    }),
  };
}

// 素材列表(expand/material/list, mix_material 报表)的请求形状，抽成命名常量做
// 单一事实源——手搓字段散在函数里最容易悄悄漂移（当初就是这么漏了 report_id、
// 整层从上线起一行没取到）。
//
// 注意：**不要**像 adFinalListRequest/campaignStatisticsListRequest 那样从广告组
// 抓包体派生 common_req。mix_material 是另一套报表契约，它的 dimensions/filters/
// metrics/sort 与广告组列表不同，继承广告组的字段（sort_stat=create_time、36 个
// 广告组指标等）会被素材报表拒收；而当初漏掉的 report_id 本就不在广告组请求里，
// 派生也救不了。能安全继承的只有 URL 查询参数（aadvid/msToken/风控串）与请求头，
// 这两样已经通过 new URL(template.url) 和 ...template 继承了。
const MATERIAL_LIST_DIMENSIONS = [
  "main_entity_id", "main_entity_type", "creative_id", "ad_id", "campaign_id",
] as const;

const MATERIAL_ORIGIN_TYPES = [
  "no_post_video", "post_video", "no_post_carousel", "post_carousel",
  "catalog_manual_video", "catalog_tpl_carousel", "catalog_tpl_video",
  "no_post_single_image", "catalog_tpl_multi_show",
] as const;

// 五个判定指标（消耗、转化、点击、加购、展示）+ 四个身份/状态字段，一个都不能删。
// 后四个不是"界面用的"：`ad_material_draft_id` 是素材自己的 ID（extractEntities
// 只认它，缺了整批行被当成没有 ID 丢掉）；`material_primary_status` 是启停状态
// （缺了 normalizeStatus 判成 unknown，规则一条不执行）；`material_second_status_list`
// 带审核态；`main_entity_name` 是素材名。真机 2026-08-10 验证：只发前十个指标时
// 请求成功但返回行里没有 ID 和状态，素材数依旧是 0。material-layer.test 钉死这份清单。
const MATERIAL_LIST_METRICS = [
  "stat_cost", "cpc", "cpm", "show_cnt", "click_cnt", "ctr",
  "time_attr_convert_cnt", "time_attr_conversion_cost",
  "time_attr_on_web_cart", "time_attr_cost_per_on_web_cart",
  "ad_material_draft_id", "material_primary_status",
  "material_second_status_list", "main_entity_name",
] as const;

function materialListRequest(
  template: CapturedCookieRequest,
  creativeId: string,
  window: { startDate: string; endDate: string },
): CapturedCookieRequest {
  const url = new URL(template.url);
  url.pathname = "/api/v4/i18n/statistics/op/expand/material/list/";
  url.searchParams.set("req_src", "bidding");
  return {
    ...template,
    target: "material",
    derived: true,
    method: "POST",
    contentType: "application/json",
    url: url.toString(),
    body: JSON.stringify({
      common_req: {
        dimensions: [...MATERIAL_LIST_DIMENSIONS],
        filters: [
          { field: "origin_material_type", filter_type: 0, in_field_values: [...MATERIAL_ORIGIN_TYPES] },
          // 只拉未删除的素材（is_del=0）。界面抓包发的是 ["0","1"]（列表里也显示
          // 已删项），但自动化不能把已删素材当规则对象：删除态会被 normalizeStatus
          // 误判成 enabled，零加购规则随即对已删素材发写入 → TikTok 拒收 → 连续
          // 失败打开写入熔断器停整账户。真机 2026-08-11 验证 is_del=["0"] 被接受。
          { field: "is_del", filter_type: 0, in_field_values: ["0"] },
          { field: "creative_id", filter_type: 0, in_field_values: [creativeId] },
        ],
        metrics: [...MATERIAL_LIST_METRICS],
        st: window.startDate,
        et: window.endDate,
        lifetime: 0,
        sort_stat: "stat_cost",
        sort_order: 1,
        page: 1,
        page_size: 100,
      },
      extra: { scene: "campaign_list_v2" },
      // 素材列表选的是 mix_material 这张报表。少了它 TikTok 直接拒收整个请求
      // （code 1300100001「无法加载。请尝试刷新。」），素材层从上线起一行都没
      // 取到过。字段来自 2026-08-10 的真实抓包。
      report_id: "mix_material",
    }),
  };
}

/**
 * 单轮同步最多为多少个广告拉素材。素材列表只能按广告逐个查，这是唯一的量级熔断。
 *
 * 从 40 提到 150 的依据（2026-08-24 生产实测，最大的那个账户）：当天有消耗的广告
 * 中位 68 个、峰值 130 个，40 这个值每一轮都在截断，24 小时里触发了 215 次。
 *
 * 截断的代价比"素材数据旧一点"重得多：被截断的广告会进 materialUnavailableAdIds，
 * 而 automation-service 的 isEntitySyncUsable 会因此**同时**禁掉这些广告和它们素材
 * 的自动写入。也就是说每一轮都有 28～90 个正在花钱的广告被停掉自动化。
 * （已存素材快照不会被清空——截断时 material 不进 completeEntityTypes——所以表现
 * 为自动化被挂起，而不是数据消失，这也是它一直没被发现的原因。）
 *
 * 之所以现在敢提：素材层已经改成并发 5。150 个广告 = 30 轮往返，仍然**少于**改成
 * 并发之前 40 个串行的 40 轮。也就是覆盖翻了近 4 倍，耗时反而比改动前低。
 */
const MAX_MATERIAL_ADS_PER_SYNC = 150;

/** 系列 / 广告组 / 广告三层一起打出去：它们互不依赖，串行只是白等。 */
const LIST_LAYER_CONCURRENCY = 3;

/**
 * 素材层的并发度。上限 40 个广告、逐个一次往返，是单轮里最大的一块。
 *
 * 取 5 而不是拉满：这些请求全部复用同一个 Cookie 会话，并发一高 TikTok 就限流，
 * 而限流的代价不只是慢——整轮同步会降级成 partial，删除和自动复制都要求最近一次
 * 同步取全，会连带跳过。5 已经把这一层压到原来的五分之一。
 */
const MATERIAL_FETCH_CONCURRENCY = 5;

/** 实体当天的消耗。列表接口可能把指标放在顶层，也可能放在 row_data / stat_data 里。 */
function entitySpend(payload: Record<string, unknown>): number {
  const rowData = isRecord(payload.row_data) ? payload.row_data : {};
  const statData = isRecord(payload.stat_data) ? payload.stat_data : {};
  const raw = payload.stat_cost ?? rowData.stat_cost ?? statData.stat_cost;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function materialDraftId(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return undefined;
  const inner = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  const parts = inner.split(",").map((item) => item.trim().replace(/^"|"$/g, ""));
  if (parts.length !== 1) return undefined;
  return isStableExternalId(parts[0]) ? parts[0] : undefined;
}

function hasRecognizedEntityList(
  payload: Record<string, unknown>,
  entityType: SyncEntityType,
): boolean {
  const data = isRecord(payload.data) ? payload.data : payload;
  const typeKeys: Record<SyncEntityType, string[]> = {
    material: ["table", "list", "items"],
    campaign: ["campaigns", "campaign_list", "table", "list", "items"],
    "ad-group": ["adgroups", "ad_groups", "adgroup_list", "table", "list", "items"],
    ad: ["ads", "ad_list", "table", "list", "items"],
  };
  const list = typeKeys[entityType]
    .map((key) => data[key])
    .find(Array.isArray);
  if (!list) return false;
  const idKeys: Record<SyncEntityType, string[]> = {
    material: [],
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
  step: "campaign/list" | "adgroup/list" | "ad/list",
  template: CapturedCookieRequest,
  credential: ParsedCookieCredential,
  dispatchState: CreationDispatchState,
  semantics: "preflight-read" | "result-query" = "preflight-read",
): Promise<Record<string, unknown>[]> {
  const pages: Record<string, unknown>[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const payload = await requestCreationStep(
      `${step} 第 ${page} 页`,
      () => page === 1 ? template : withRequestedPage(template, page),
      credential,
      { semantics, dispatchState },
    );
    assertListPreflight(payload, step, semantics);
    const responsePage = responsePageNumber(payload);
    if (responsePage !== null && responsePage !== page) {
      throw new RetryableCreationError(
        `${step} 未返回请求的第 ${page} 页，无法${semantics === "result-query" ? "确认创建结果" : "安全判断同名对象"}。`,
      );
    }
    pages.push(payload);
    if (hasExplicitAdditionalPages(payload)) continue;
    if (!hasExplicitPaginationEnd(payload)) {
      throw new RetryableCreationError(
        `${step} 缺少可验证的分页结束信息，无法${semantics === "result-query" ? "确认创建结果" : "安全判断同名对象"}。`,
      );
    }
    return pages;
  }
  throw new RetryableCreationError(
    `${step} 超过 100 页，无法${semantics === "result-query" ? "确认创建结果" : "在创建前完成安全查重"}。`,
  );
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
  /** 步骤失败时的去处。不给就仍然静默——但发布前那四步必须给。 */
  onFailure?: (step: string, cause: unknown) => void,
): Promise<Record<string, unknown> | undefined> {
  try {
    return await requestCreationStep(step, createRequest, credential, boundary);
  } catch (cause) {
    // 「advisory」的本意是「失败也不该拦住发布」，但此前连**失败发生过**这件事都
    // 不留痕：不带 dispatchState 所以不进留证，catch 里又直接吞掉。
    // 发布前那四步（cbo_consistency_check / campaign_snap/check /
    // ad_creative_snap/check / batch_create_cta_id）正是让草稿变得可发布的一环——
    // 8/8 的记录写着「草稿本身是好的，手动打开广告组页面等它加载完再点发布就能成功」，
    // 打开页面做的就是这几件事。它们静默失败时，发布照常发出去，然后被 TikTok 以
    // uaa_campaign_automation_inconsistent_error 拒掉，而现场什么都不剩。
    onFailure?.(step, cause);
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
      pages: [await requestCookieJson(template, credential, COOKIE_LIST_REQUEST_TIMEOUT_MS)],
      complete: false,
    };
  }
  const pages: Record<string, unknown>[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const request = page === 1 ? template : withRequestedPage(template, page);
    const payload = await requestCookieJson(request, credential, COOKIE_LIST_REQUEST_TIMEOUT_MS);
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

/** 只读列表请求的重试间隔，与创建链路的结果查询步骤保持一致。 */
const LIST_REQUEST_RETRY_DELAY_MS = 750;

/**
 * 只读列表请求失败后原地重试一次，但超时不重试。
 *
 * 可以无条件重试的理由：列表请求没有任何副作用，重放最坏只是多读一次，所以这里
 * 不适用 isDefinitelyUnsentNetworkError 那套「能否证明请求没发出去」的判据——那
 * 是为写请求防重复提交设的。
 *
 * 唯独超时要排除。生产实测，广告层级失败的真正原因是我们自己 45 秒预算到点撒手，
 * 而不是对端拒绝服务；一个已经等了 45 秒还没回话的请求，再等 45 秒也不会回话，
 * 重试只会把整轮轮询从 8 秒拖到 90 秒以上。重试留给 5xx、连接重置这类真正的抖动。
 *
 * 失败的代价不只是界面上一个黄标：那一轮同步会被判为 partial，而删除和自动复制
 * 都要求最近一次同步是 healthy，会连带跳过。
 */
/** 列表接口按 ID 精确筛选时，三个层级各自的字段名（实测确认）。 */
const ENTITY_ID_FILTER_FIELDS = {
  campaign: "campaign_ids",
  "ad-group": "ad_ids",
  ad: "creative_ids",
} as const;

async function requestAllCookieListPagesWithRetry(
  template: CapturedCookieRequest,
  credential: ParsedCookieCredential,
): Promise<{ pages: Record<string, unknown>[]; complete: boolean }> {
  try {
    return await requestAllCookieListPages(template, credential);
  } catch (cause) {
    if (isRequestTimeoutError(cause)) throw cause;
    await new Promise((resolve) => setTimeout(resolve, LIST_REQUEST_RETRY_DELAY_MS));
    return requestAllCookieListPages(template, credential);
  }
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
  step: "campaign/list" | "adgroup/list" | "ad/list",
  semantics: "preflight-read" | "result-query",
): void {
  const data = isRecord(payload.data) ? payload.data : undefined;
  const listKeys = step === "campaign/list"
    ? ["campaigns", "campaign_list", "table", "list", "items"]
    : step === "adgroup/list"
      ? ["adgroups", "ad_groups", "adgroup_list", "table", "list", "items"]
      : ["ads", "ad_list", "table", "list", "items"];
  if (!data || !listKeys.some((key) => Array.isArray(data[key]))) {
    throw new RetryableCreationError(
      semantics === "result-query"
        ? `${step} 结果核验响应缺少可识别的列表结构。`
        : `${step} 预检响应缺少可识别的列表结构，尚未发送任何创建请求。`,
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
    material: 0,
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
