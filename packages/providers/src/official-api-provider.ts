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
} from "./types.js";

const capabilities = new Set<ProviderCapability>([
  "read-campaigns",
  "read-ad-groups",
  "read-ads",
  "read-reports",
  "create-campaigns",
  "copy-ads",
  "change-status",
]);

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
    for (const entityType of ["campaign", "ad-group", "ad"] as const) {
      entities.push(
        ...(await requestOfficialList(
          entityType,
          settings.advertiserId,
          credential.accessToken,
          1000,
        )),
      );
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
        warnings: [],
      },
    };
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
  const url = new URL(
    `https://business-api.tiktok.com/open_api/v1.3/${endpointName[entityType]}/get/`,
  );
  url.searchParams.set("advertiser_id", advertiserId);
  url.searchParams.set("page_size", String(pageSize));
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
  const data = isRecord(payload.data) ? payload.data : {};
  const list = Array.isArray(data.list) ? data.list : [];
  const idKeys: Record<SyncEntityType, string[]> = {
    campaign: ["campaign_id", "id"],
    "ad-group": ["adgroup_id", "id"],
    ad: ["ad_id", "id"],
  };
  return list.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = idKeys[entityType]
      .map((key) => item[key])
      .find((value) => typeof value === "string" || typeof value === "number");
    return id === undefined
      ? []
      : [{ entityType, externalId: String(id), payload: item }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
