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
  readonly capabilities = capabilities;

  async checkHealth(context: ProviderContext): Promise<ProviderHealth> {
    const settings = OfficialApiConnectionSettingsSchema.parse(context.settings);
    const credential = OfficialApiCredentialInputSchema.parse(context.credential);
    await requestOfficialList("campaign", settings.advertiserId, credential.accessToken, 1);
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
    for (const entityType of ["campaign", "ad-group", "ad"] as const) {
      const listed = await requestOfficialList(
        entityType,
        settings.advertiserId,
        credential.accessToken,
        1000,
      );
      try {
        const report = await requestOfficialReport(
          entityType,
          settings.advertiserId,
          credential.accessToken,
          context.timezone ?? "UTC",
        );
        for (const entity of listed) {
          const metrics = report.get(entity.externalId);
          entities.push(
            metrics
              ? { ...entity, payload: { ...entity.payload, metrics } }
              : entity,
          );
        }
      } catch (cause) {
        entities.push(...listed);
        warnings.push(
          `${entityType} 报表读取失败：${cause instanceof Error ? cause.message : "未知错误"}`,
        );
      }
    }
    const finishedAt = new Date().toISOString();
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
      },
    };
  }

  async changeStatus(
    context: ProviderContext,
    mutations: StatusMutation[],
  ): Promise<StatusMutationResult[]> {
    const settings = OfficialApiConnectionSettingsSchema.parse(context.settings);
    const credential = OfficialApiCredentialInputSchema.parse(context.credential);
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
): Promise<ProviderEntity[]> {
  const endpointName: Record<SyncEntityType, string> = {
    campaign: "campaign",
    "ad-group": "adgroup",
    ad: "ad",
  };
  const all: ProviderEntity[] = [];
  let page = 1;
  let totalPages = 1;
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
    const list = Array.isArray(data.list) ? data.list : [];
    all.push(
      ...list.flatMap((item) => {
        if (!isRecord(item)) return [];
        const id = idKeys[entityType]
          .map((key) => item[key])
          .find(
            (value) =>
              typeof value === "string" || typeof value === "number",
          );
        return id === undefined
          ? []
          : [{ entityType, externalId: String(id), payload: item }];
      }),
    );
    const pageInfo = isRecord(data.page_info) ? data.page_info : {};
    totalPages = Math.max(1, Number(pageInfo.total_page ?? 1));
    page += 1;
  } while (page <= totalPages && page <= 100);
  return all;
}

async function requestOfficialReport(
  entityType: SyncEntityType,
  advertiserId: string,
  accessToken: string,
  timezone: string,
): Promise<Map<string, Record<string, unknown>>> {
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
    const list = Array.isArray(data.list) ? data.list : [];
    for (const item of list) {
      if (!isRecord(item)) continue;
      const itemDimensions = isRecord(item.dimensions) ? item.dimensions : {};
      const id = itemDimensions[dimensions[entityType]];
      if (typeof id !== "string" && typeof id !== "number") continue;
      output.set(String(id), isRecord(item.metrics) ? item.metrics : {});
    }
    const pageInfo = isRecord(data.page_info) ? data.page_info : {};
    totalPages = Math.max(1, Number(pageInfo.total_page ?? 1));
    page += 1;
  } while (page <= totalPages && page <= 100);
  return output;
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
  const response = await fetch(url, {
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
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok || payload.code !== 0) {
    throw new Error(
      `Marketing API 状态更新失败（HTTP ${response.status}，code ${String(payload.code ?? "-")}）。`,
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

function formatDateInTimezone(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
