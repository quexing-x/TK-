import { z } from "zod";
import type { CapturedCookieRequest } from "./connection.js";
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
  return { campaign_id: "", campaign_snap_id: value.campaignSnapId, campaign_sketch_id: value.campaignSketchId, ad_and_creative_snap_info_list: value.adAndCreativeSnapInfoList, is_status_disabled: initialStatus === "disabled", is_partial_publish: false };
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
  config: CreationPresetConfig,
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
) {
  const required = requiredCreationFields(config);
  if (required.length > 0) throw new CreationPresetIncompleteError(required);
  const startTime = row.startAt ? unixSeconds(row.startAt) : "";
  const endTime = row.endAt ? unixSeconds(row.endAt) : "";
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
        ad_name: row.adGroupName,
        ad_snap_id: "",
        ad_sketch_id: "",
        schedule_type: startTime ? 1 : 0,
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
        identity_id: config.identityId,
        call_to_action_id: config.callToActionId,
        is_comment_disable: config.commentDisabled ? 1 : 0,
        is_share_disable: config.shareDisabled ? 1 : 0,
      }],
    },
  };
}

function requiredCreationFields(config: CreationPresetConfig): string[] {
  const fields: Array<[string, unknown]> = [
    ["营销目标", config.objectiveType],
    ["购买方式", config.buyingType],
    ["系列预算方式", config.campaignBudgetMode],
    ["广告组预算方式", config.adBudgetMode],
    ["计费方式", config.pricing],
    ["优化目标", config.optimizeGoal],
    ["转化事件", config.externalAction],
    ["广告身份类型", config.identityType],
    ["广告身份 ID", config.identityId],
    ["行动号召", config.callToActionId],
  ];
  return fields.filter(([, value]) => value == null || value === "").map(([name]) => name);
}

function unixSeconds(value: string): string {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("创建时间无效。");
  return String(Math.floor(milliseconds / 1000));
}
