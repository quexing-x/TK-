import { z } from "zod";
import type { CapturedCookieRequest, CookieCreationProfile } from "./connection.js";
import type { CreationPresetConfig, LaunchConfigurationRow } from "./launch.js";

/** Confirmed TikTok draft-to-publish sequence.  Values are deliberately
 * account-neutral; credentials and dynamic signatures never belong here. */
export const TikTokCreationSteps = [
  "campaign_snap/save",
  "ad_snap/save",
  "creative_snap/save",
  "async_creation/create_by_snap",
] as const;
export type TikTokCreationStep = (typeof TikTokCreationSteps)[number];

/** Provider-owned source markers used by TikTok for a fresh draft publish. */
export const TikTokCreationPublishSource = {
  coming_source_type: 6,
  sketch_publish_source: 1,
} as const;

/**
 * A creation request has a different path from the two onboarding requests,
 * but belongs to the same authenticated advertiser session.  This deliberately
 * preserves only the session-bound request metadata already protected by the
 * credential vault; it never copies Cookie values into a plan or source file.
 *
 * TikTok can change how a query signature is scoped.  A caller must therefore
 * send the request and accept success only after TikTok responds with code 0;
 * deriving a URL alone is not considered a connection check.
 */
export interface TikTokCreationRequestTemplate {
  step: TikTokCreationStep;
  url: string;
  method: "POST";
  headers?: Record<string, string>;
}

export function deriveTikTokCreationRequest(
  sessionRequest: CapturedCookieRequest,
  step: TikTokCreationStep,
): TikTokCreationRequestTemplate {
  const url = new URL(sessionRequest.url);
  url.pathname = `/api/v4/i18n/creation/${step}/`;
  return {
    step,
    url: url.toString(),
    method: "POST",
    ...(sessionRequest.headers ? { headers: sessionRequest.headers } : {}),
  };
}

export const CreationPresetSchema = z.object({
  campaign: z.object({ objectiveType: z.number().int().nullable(), buyingType: z.number().int().nullable(), budgetMode: z.number().int().nullable(), budget: z.number().nonnegative().nullable() }),
  adGroup: z.object({ budgetMode: z.number().int().nullable(), dailyBudget: z.number().positive().nullable(), pricing: z.number().int().nullable(), bid: z.number().nonnegative().nullable(), optimizeGoal: z.number().int().nullable(), pixelId: z.string().trim().nullable(), countries: z.array(z.number().int()).default([]), startAt: z.string().datetime().nullable(), endAt: z.string().datetime().nullable() }),
  creative: z.object({ identityType: z.number().int().nullable(), identityId: z.string().trim().nullable(), callToActionId: z.string().trim().nullable(), commentDisabled: z.boolean().default(false), shareDisabled: z.boolean().default(false), utms: z.array(z.object({ field: z.string().trim().min(1), value: z.string().trim() })).default([]) }),
});
export type CreationPreset = z.infer<typeof CreationPresetSchema>;

export const DisabledPublishInputSchema = z.object({
  campaignSnapId: z.string().trim().min(1),
  campaignSketchId: z.string().trim().min(1),
  adAndCreativeSnapInfoList: z.array(z.unknown()).min(1),
});

/** Initial delivery is explicit, never inherited from the copied template. */
export function buildPublishInput(
  input: z.input<typeof DisabledPublishInputSchema>,
  initialStatus: "enabled" | "disabled",
) {
  const value = DisabledPublishInputSchema.parse(input);
  // Publish only the explicitly supplied snap list. TikTok accounts can retain
  // unrelated unfinished drafts; a full-draft-tree publish may otherwise pull
  // those objects into this batch.
  return { campaign_id: "", campaign_snap_id: value.campaignSnapId, campaign_sketch_id: value.campaignSketchId, ad_and_creative_snap_info_list: value.adAndCreativeSnapInfoList, ...TikTokCreationPublishSource, is_status_disabled: initialStatus === "disabled", is_partial_publish: true };
}

export class CreationPresetIncompleteError extends Error {
  constructor(fields: string[]) {
    super(`创建预设缺少必填字段：${fields.join("、")}`);
    this.name = "CreationPresetIncompleteError";
  }
}

export interface CreationTemplateReadiness {
  ready: boolean;
  missingFieldCount: number;
}

/**
 * Keeps the UI independent from TikTok's unstable internal field names.  The
 * UI only needs to know whether a verified account template exists; exact
 * fields stay inside the creation adapter.
 */
export function getCreationTemplateReadiness(
  config: Partial<CreationPresetConfig> = {},
): CreationTemplateReadiness {
  const missing = requiredCreationFields(config);
  return { ready: missing.length === 0, missingFieldCount: missing.length };
}

/**
 * Materializes the account-neutral portions of TikTok's confirmed four-step
 * draft chain.  Dynamic session material (Cookie, CSRF and signatures) stays
 * in the provider vault and is deliberately absent from these payloads.
 */
export function buildDraftPayloads(
  row: LaunchConfigurationRow,
  config: CreationPresetConfig,
  timezone = "UTC",
  now = new Date(),
) {
  const required = requiredCreationFields(config);
  if (required.length > 0) throw new CreationPresetIncompleteError(required);
  const { startTime, endTime } = materializeSchedule(row.startAt, row.endAt, timezone, now);
  return {
    campaign: {
      campaign_sketch_form_data: {
        campaign_name: row.campaignName,
        campaign_id: "",
        campaign_snap_id: "",
        campaign_sketch_id: "",
        objective_type: config.objectiveType,
        buying_type: config.buyingType,
        budget_mode: config.campaignBudgetMode,
        budget: "0",
        industry_types: [],
      },
      is_from_startup: false,
      with_sketch: true,
      is_skip_check_fields: false,
    },
    adGroup: {
      campaign_id: "",
      with_sketch: true,
      is_skip_check_fields: false,
      ad_sketch_form_data: {
        origin_ad_id: 0,
        ad_name: row.adGroupName,
        ad_snap_id: "",
        ad_sketch_id: "",
        schedule_type: 1,
        start_time: startTime,
        end_time: endTime,
        budget_mode: config.adBudgetMode,
        budget: String(row.dailyBudget),
        pricing: config.pricing,
        cpa_bid: row.bid === null ? "" : String(row.bid),
        optimize_goal: config.optimizeGoal,
        external_action: config.externalAction,
        ad_ref_pixel_id: config.pixelId ?? "",
        automated_targeting: config.smartTargeting ? 1 : 0,
        country: config.countryCodes,
        platform: config.placementIds,
      },
    },
    creative: {
      ad_snap_id: "",
      ad_sketch_id: "",
      with_sketch: true,
      asset_group_sketch_form_data_list: [{
        creative_name: row.adName,
        creative_snap_id: "",
        creative_sketch_id: "",
        external_url: row.productUrl,
        image_list: [{ aweme_item_id: row.videoCode }],
        identity_type: config.identityType,
        identity_id: config.identityId ?? "",
        call_to_action_id: config.callToActionId,
        is_comment_disable: config.commentDisabled ? 1 : 0,
        is_share_disable: config.shareDisabled ? 1 : 0,
      }],
    },
  };
}

/** Applies only user-controlled fields to a locally encrypted, account-verified
 * creation snapshot. Identity, pixel, targeting and provider risk fields are
 * retained verbatim instead of being guessed from a list/status cURL. */
export function buildProfileDraftPayloads(
  profile: CookieCreationProfile,
  row: LaunchConfigurationRow,
  timezone = "UTC",
  now = new Date(),
  customConfig?: CreationPresetConfig,
) {
  const campaign = clone(profile.campaignPayload);
  const adGroup = clone(profile.adGroupPayload);
  const creative = clone(profile.creativePayload);
  const campaignForm = objectAt(campaign, "campaign_sketch_form_data");
  const adForm = objectAt(adGroup, "ad_sketch_form_data");
  const list = creative.asset_group_sketch_form_data_list;
  if (!Array.isArray(list) || !isRecord(list[0])) throw new Error("本地创建模板缺少广告素材结构，请重新验证该账户的创建模板。");
  campaignForm.campaign_name = row.campaignName;
  campaignForm.campaign_id = ""; campaignForm.campaign_snap_id = ""; campaignForm.campaign_sketch_id = "";
  delete campaignForm.origin_campaign_id;
  adForm.ad_name = row.adGroupName; adForm.budget = String(row.dailyBudget);
  adForm.origin_ad_id = 0;
  adForm.ad_snap_id = "";
  adForm.ad_sketch_id = "";
  adForm.by_ad_sketch_id = "";
  if (row.bid !== null) adForm.cpa_bid = String(row.bid);
  const { startTime, endTime } = materializeSchedule(row.startAt, row.endAt, timezone, now);
  adForm.schedule_type = 1; adForm.start_time = startTime; adForm.end_time = endTime;
  const asset = list[0]; asset.creative_name = row.adName; asset.external_url = row.productUrl;
  asset.creative_snap_id = "";
  asset.creative_sketch_id = "";
  delete asset.origin_creative_id;
  // `open_url` is TikTok's separate direct-link feature, not the ordinary
  // landing page. The verified HAR keeps it empty with `is_open_url = 0`.
  // Writing the landing page here makes TikTok enable an incomplete direct
  // link and reject ad_creative_snap/check.
  if (!Array.isArray(asset.image_list) || !isRecord(asset.image_list[0])) throw new Error("本地创建模板缺少视频素材结构，请重新验证该账户的创建模板。");
  asset.image_list[0].aweme_item_id = row.videoCode;
  if (customConfig && requiredCreationFields(customConfig).length === 0) {
    applyCreationConfigOverrides(campaignForm, adForm, asset, customConfig);
  }
  if (campaignForm.industry_types === undefined) campaignForm.industry_types = [];
  return { campaign, adGroup, creative };
}
function applyCreationConfigOverrides(
  campaignForm: Record<string, unknown>,
  adForm: Record<string, unknown>,
  asset: Record<string, unknown>,
  config: CreationPresetConfig,
) {
  campaignForm.objective_type = config.objectiveType;
  campaignForm.buying_type = config.buyingType;
  campaignForm.budget_mode = config.campaignBudgetMode;
  adForm.budget_mode = config.adBudgetMode;
  adForm.pricing = config.pricing;
  adForm.optimize_goal = config.optimizeGoal;
  adForm.external_action = config.externalAction;
  adForm.ad_ref_pixel_id = config.pixelId ?? "";
  adForm.automated_targeting = config.smartTargeting ? 1 : 0;
  if (config.countryCodes.length > 0) adForm.country = [...config.countryCodes];
  if (config.placementIds.length > 0) adForm.platform = [...config.placementIds];
  asset.identity_type = config.identityType;
  asset.identity_id = config.identityId;
  if (asset.need_create_cta_id === true) {
    const ctaAssets = asset.call_to_action_asset_list;
    if (!Array.isArray(ctaAssets) || ctaAssets.length < 1 || ctaAssets.length > 3) {
      throw new Error("已验证的程序化创意模板必须包含 1 到 3 个行动引导文案。");
    }
    // Programmatic CTA uses the verified asset list. A static preset id such
    // as "0" makes TikTok ignore that list during ad_creative_snap/check.
    asset.call_to_action_id = "";
  } else {
    asset.call_to_action_id = config.callToActionId;
  }
  asset.is_comment_disable = config.commentDisabled ? 1 : 0;
  asset.is_share_disable = config.shareDisabled ? 1 : 0;
}
function clone(value: Record<string, unknown>): Record<string, unknown> { return JSON.parse(JSON.stringify(value)) as Record<string, unknown>; }
function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> { if (!isRecord(value[key])) throw new Error(`本地创建模板缺少 ${key}，请重新验证该账户的创建模板。`); return value[key]; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function requiredCreationFields(config: Partial<CreationPresetConfig>): string[] {
  const fields: Array<[string, unknown]> = [
    ["营销目标", config.objectiveType],
    ["购买方式", config.buyingType],
    ["系列预算方式", config.campaignBudgetMode],
    ["广告组预算方式", config.adBudgetMode],
    ["计费方式", config.pricing],
    ["优化目标", config.optimizeGoal],
    ["转化事件", config.externalAction],
    ["广告身份类型", config.identityType],
    ["广告身份 ID", config.identityType === 0 ? "account-default" : config.identityId],
    ["行动号召", config.callToActionId],
  ];
  return fields.filter(([, value]) => value == null || value === "").map(([name]) => name);
}

function materializeSchedule(startAt: string | null, endAt: string | null, timezone: string, now: Date) {
  const start = startAt ? new Date(startAt) : new Date(now.getTime() + 300_000);
  if (!Number.isFinite(start.getTime())) throw new Error("创建时间无效。");
  const end = endAt ? new Date(endAt) : new Date(start);
  if (endAt) {
    if (!Number.isFinite(end.getTime())) throw new Error("结束时间无效。");
  } else {
    end.setUTCFullYear(end.getUTCFullYear() + 10);
  }
  return { startTime: formatTikTokDateTime(start, timezone), endTime: formatTikTokDateTime(end, timezone) };
}

function formatTikTokDateTime(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`;
}
