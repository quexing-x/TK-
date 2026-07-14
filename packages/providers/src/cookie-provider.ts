import {
  CookieConnectionSettingsSchema,
  CookieCredentialInputSchema,
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
  "create-campaigns",
  "copy-ads",
  "change-status",
  "delete-ad-groups",
  "appeal-ads",
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

    for (const entityType of ["campaign", "ad-group", "ad"] as const) {
      const captured = credential.requestTemplates?.find(
        (item) => item.target === entityType,
      );
      const request = captured ?? legacyRequest(legacyEndpoints[entityType]);
      if (!request) {
        warnings.push(`${entityType} 尚未导入只读请求。`);
        continue;
      }
      let payload: Record<string, unknown>;
      try {
        payload = await requestCookieJson(request, credential);
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
    throw new Error(`TikTok 接口返回失败状态（code ${payload.code}）。`);
  }
  return payload;
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
