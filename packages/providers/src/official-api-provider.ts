import {
  OfficialApiConnectionSettingsSchema,
  OfficialApiCredentialInputSchema,
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
import { buildSyncDataQuality, formatDateInTimezone } from "./sync-quality.js";
import {
  RetryableStatusMutationError,
  UnknownStatusMutationStateError,
} from "./types.js";

const OFFICIAL_SYNC_CONTRACT_VERSION = "official-api-v1.3-2026-07";

const capabilities = new Set<ProviderCapability>([
  "read-campaigns",
  "read-ad-groups",
  "read-ads",
  "read-reports",
  "change-status",
]);

export const OFFICIAL_REPORT_METRICS = [
  "spend",
  "impressions",
  "clicks",
  "cpc",
  "conversion",
  "cost_per_conversion",
  "onsite_on_web_cart",
] as const;

export class OfficialApiAdsProvider implements AdsProvider {
  readonly kind = "official-api" as const;
  readonly displayName = "TikTok Marketing API";
  readonly capabilityVersion = "official-api-capabilities-v1-2026-07";
  readonly capabilities = capabilities;

  resolveCapabilities(): ReadonlySet<ProviderCapability> {
    return capabilities;
  }

  async checkHealth(context: ProviderContext): Promise<ProviderHealth> {
    const settings = OfficialApiConnectionSettingsSchema.parse(context.settings);
    const credential = OfficialApiCredentialInputSchema.parse(context.credential);
    const listed = await requestOfficialList(
      "campaign",
      settings.advertiserId,
      credential.accessToken,
      1000,
    );
    if (!listed.contractValid || !listed.paginationComplete) {
      throw new Error("Marketing API 列表响应结构或分页信息无效，不会开放账户能力。");
    }
    return {
      ok: true,
      status: "ready",
      message: "Marketing API Token 和广告账户验证成功。",
    };
  }

  async syncReadOnly(context: ProviderContext): Promise<ProviderSyncOutput> {
    const settings = OfficialApiConnectionSettingsSchema.parse(context.settings);
    const credential = OfficialApiCredentialInputSchema.parse(context.credential);
    const startedAt = new Date().toISOString();
    const entities: ProviderEntity[] = [];
    const warnings: string[] = [];
    const partialFailures: string[] = [];
    let paginationComplete = true;
    let contractValid = true;
    const timezone = context.timezone ?? "UTC";
    for (const entityType of ["campaign", "ad-group", "ad"] as const) {
      const listed = await requestOfficialList(
        entityType,
        settings.advertiserId,
        credential.accessToken,
        1000,
      );
      paginationComplete &&= listed.paginationComplete;
      contractValid &&= listed.contractValid;
      try {
        const report = await requestOfficialReport(
          entityType,
          settings.advertiserId,
          credential.accessToken,
          timezone,
        );
        paginationComplete &&= report.paginationComplete;
        contractValid &&= report.contractValid;
        for (const entity of listed.entities) {
          const metrics = report.metrics.get(entity.externalId);
          entities.push(
            metrics
              ? { ...entity, payload: { ...entity.payload, metrics } }
              : entity,
          );
        }
      } catch (cause) {
        entities.push(...listed.entities);
        partialFailures.push(`${entityType}:report`);
        warnings.push(
          `${entityType} 报表读取失败：${cause instanceof Error ? cause.message : "未知错误"}`,
        );
      }
    }
    const finishedAt = new Date().toISOString();
    const date = formatDateInTimezone(new Date(finishedAt), timezone);
    return {
      entities,
      result: {
        startedAt,
        finishedAt,
        counts: {
          campaign: entities.filter((item) => item.entityType === "campaign").length,
          "ad-group": entities.filter((item) => item.entityType === "ad-group").length,
          ad: entities.filter((item) => item.entityType === "ad").length,
        },
        warnings,
        quality: buildSyncDataQuality({
          entities,
          paginationComplete,
          contractValid,
          providerContractVersion: OFFICIAL_SYNC_CONTRACT_VERSION,
          coverage: { startDate: date, endDate: date, timezone },
          partialFailures,
        }),
      },
    };
  }

  async changeStatus(
    context: ProviderContext,
    mutations: StatusMutation[],
  ): Promise<StatusMutationResult[]> {
    let settings: ReturnType<typeof OfficialApiConnectionSettingsSchema.parse>;
    let credential: ReturnType<typeof OfficialApiCredentialInputSchema.parse>;
    try {
      settings = OfficialApiConnectionSettingsSchema.parse(context.settings);
      credential = OfficialApiCredentialInputSchema.parse(context.credential);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Marketing API 状态请求参数无效。";
      return mutations.map((mutation) => ({
        ...mutation,
        ok: false,
        failureKind: "retryable",
        message,
      }));
    }
    const results: StatusMutationResult[] = [];
    for (const mutation of mutations) {
      try {
        await requestOfficialStatus(
          settings.advertiserId,
          credential.accessToken,
          mutation,
        );
        results.push({
          ...mutation,
          ok: true,
          message: `Marketing API 状态更新成功：${mutation.action}。`,
        });
      } catch (cause) {
        results.push({
          ...mutation,
          ok: false,
          failureKind: cause instanceof RetryableStatusMutationError
            ? "retryable"
            : "unknown",
          message:
            cause instanceof Error ? cause.message : "Marketing API 状态更新失败。",
        });
      }
    }
    return results;
  }
}

async function requestOfficialList(
  entityType: SyncEntityType,
  advertiserId: string,
  accessToken: string,
  pageSize: number,
): Promise<{
  entities: ProviderEntity[];
  paginationComplete: boolean;
  contractValid: boolean;
}> {
  const endpointName: Record<SyncEntityType, string> = {
    campaign: "campaign",
    "ad-group": "adgroup",
    ad: "ad",
  };
  const all: ProviderEntity[] = [];
  let page = 1;
  let totalPages = 1;
  let contractValid = true;
  let paginationMetadataValid = true;
  const idKeys: Record<SyncEntityType, string[]> = {
    campaign: ["campaign_id", "id"],
    "ad-group": ["adgroup_id", "id"],
    ad: ["ad_id", "id"],
  };
  do {
    const url = new URL(
      `https://business-api.tiktok.com/open_api/v1.3/${endpointName[entityType]}/get/`,
    );
    url.searchParams.set("advertiser_id", advertiserId);
    url.searchParams.set("page_size", String(pageSize));
    url.searchParams.set("page", String(page));
    const payload = await requestOfficialJson(url, accessToken);
    const data = isRecord(payload.data) ? payload.data : {};
    contractValid &&=
      isRecord(payload.data) &&
      Array.isArray(data.list) &&
      data.list.every((item) =>
        isRecord(item) && idKeys[entityType].some((key) => {
          const value = item[key];
          return isStableExternalId(value);
        }),
      );
    const list = Array.isArray(data.list) ? data.list : [];
    all.push(
      ...list.flatMap((item) => {
        if (!isRecord(item)) return [];
        const id = idKeys[entityType]
          .map((key) => item[key])
          .find(isStableExternalId);
        return id === undefined
          ? []
          : [{ entityType, externalId: String(id), payload: item }];
      }),
    );
    const pageInfo = isRecord(data.page_info) ? data.page_info : {};
    const totalPageValue = Number(pageInfo.total_page);
    const pageValue = pageInfo.page === undefined ? page : Number(pageInfo.page);
    const validPageInfo =
      Number.isInteger(totalPageValue) &&
      totalPageValue >= page &&
      Number.isInteger(pageValue) &&
      pageValue === page;
    paginationMetadataValid &&= validPageInfo;
    totalPages = validPageInfo ? totalPageValue : page;
    page += 1;
  } while (page <= totalPages && page <= 100);
  return {
    entities: all,
    paginationComplete: paginationMetadataValid && page > totalPages,
    contractValid,
  };
}

function isStableExternalId(value: unknown): value is string | number {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

async function requestOfficialReport(
  entityType: SyncEntityType,
  advertiserId: string,
  accessToken: string,
  timezone: string,
): Promise<{
  metrics: Map<string, Record<string, unknown>>;
  paginationComplete: boolean;
  contractValid: boolean;
}> {
  const levels: Record<SyncEntityType, string> = {
    campaign: "AUCTION_CAMPAIGN",
    "ad-group": "AUCTION_ADGROUP",
    ad: "AUCTION_AD",
  };
  const dimensions: Record<SyncEntityType, string> = {
    campaign: "campaign_id",
    "ad-group": "adgroup_id",
    ad: "ad_id",
  };
  const date = formatDateInTimezone(new Date(), timezone);
  const output = new Map<string, Record<string, unknown>>();
  let page = 1;
  let totalPages = 1;
  let contractValid = true;
  let paginationMetadataValid = true;
  do {
    const url = new URL(
      "https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/",
    );
    url.searchParams.set("advertiser_id", advertiserId);
    url.searchParams.set("report_type", "BASIC");
    url.searchParams.set("service_type", "AUCTION");
    url.searchParams.set("data_level", levels[entityType]);
    url.searchParams.set("dimensions", JSON.stringify([dimensions[entityType]]));
    url.searchParams.set(
      "metrics",
      JSON.stringify(OFFICIAL_REPORT_METRICS),
    );
    url.searchParams.set("start_date", date);
    url.searchParams.set("end_date", date);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", "1000");
    const payload = await requestOfficialJson(url, accessToken);
    const data = isRecord(payload.data) ? payload.data : {};
    contractValid &&=
      isRecord(payload.data) &&
      Array.isArray(data.list) &&
      data.list.every((item) => {
        if (!isRecord(item)) return false;
        const itemDimensions = isRecord(item.dimensions) ? item.dimensions : {};
        return isStableExternalId(itemDimensions[dimensions[entityType]]);
      });
    const list = Array.isArray(data.list) ? data.list : [];
    for (const item of list) {
      if (!isRecord(item)) continue;
      const itemDimensions = isRecord(item.dimensions) ? item.dimensions : {};
      const id = itemDimensions[dimensions[entityType]];
      if (!isStableExternalId(id)) continue;
      output.set(String(id), isRecord(item.metrics) ? item.metrics : {});
    }
    const pageInfo = isRecord(data.page_info) ? data.page_info : {};
    const totalPageValue = Number(pageInfo.total_page);
    const pageValue = pageInfo.page === undefined ? page : Number(pageInfo.page);
    const validPageInfo =
      Number.isInteger(totalPageValue) &&
      totalPageValue >= page &&
      Number.isInteger(pageValue) &&
      pageValue === page;
    paginationMetadataValid &&= validPageInfo;
    totalPages = validPageInfo ? totalPageValue : page;
    page += 1;
  } while (page <= totalPages && page <= 100);
  return {
    metrics: output,
    paginationComplete: paginationMetadataValid && page > totalPages,
    contractValid,
  };
}

async function requestOfficialStatus(
  advertiserId: string,
  accessToken: string,
  mutation: StatusMutation,
): Promise<void> {
  const endpoint: Record<SyncEntityType, string> = {
    campaign: "campaign",
    "ad-group": "adgroup",
    ad: "ad",
  };
  const idField: Record<SyncEntityType, string> = {
    campaign: "campaign_ids",
    "ad-group": "adgroup_ids",
    ad: "ad_ids",
  };
  const url = new URL(
    `https://business-api.tiktok.com/open_api/v1.3/${endpoint[mutation.entityType]}/status/update/`,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Access-Token": accessToken,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        advertiser_id: advertiserId,
        [idField[mutation.entityType]]: [mutation.externalId],
        operation_status: mutation.action === "enable" ? "ENABLE" : "DISABLE",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new UnknownStatusMutationStateError(
      cause instanceof Error ? cause.message : "Marketing API 状态请求传输失败。",
    );
  }
  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new UnknownStatusMutationStateError("Marketing API 状态响应无法解析，结果待确认。");
  }
  if (typeof payload.code !== "number") {
    throw new UnknownStatusMutationStateError("Marketing API 状态响应缺少 code，结果待确认。");
  }
  if (!response.ok && payload.code === 0) {
    throw new UnknownStatusMutationStateError(
      `Marketing API HTTP ${response.status} 与业务 code 0 冲突，结果待确认。`,
    );
  }
  if (payload.code !== 0) {
    throw new RetryableStatusMutationError(
      `Marketing API 明确拒绝状态更新（HTTP ${response.status}，code ${payload.code}）。`,
    );
  }
}

async function requestOfficialJson(
  url: URL,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { "Access-Token": accessToken, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Marketing API 请求失败（HTTP ${response.status}）。`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  if (payload.code !== 0) {
    throw new Error(`Marketing API 返回失败状态（code ${String(payload.code)}）。`);
  }
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
