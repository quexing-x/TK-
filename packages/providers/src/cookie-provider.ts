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
} from "./types.js";

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
    const captured = credential.requestTemplates?.[0];
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
      const payload = await requestCookieJson(request, credential);
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
}

async function requestCookieJson(
  request: CapturedCookieRequest,
  credential: ParsedCookieCredential,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
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
    unique.set(`${entity.entityType}:${entity.externalId}`, entity);
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
