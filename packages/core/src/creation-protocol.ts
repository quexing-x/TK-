import { z } from "zod";
import type { CapturedCookieRequest, CookieCreationProfile } from "./connection.js";
import {
  LaunchAgeRangeValues,
  resolveConfiguredBudgetMode,
  type CreationPresetConfig,
  type LaunchAgeRange,
  type LaunchConfigurationRow,
} from "./launch.js";
import { resolveBudgetFields, type ResolvedBudgetFields } from "./budget-mode.js";

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
  coming_source_type: 1,
  sketch_publish_source: 1,
} as const;

/** TikTok 当前创建前端使用的自动优化策略 ID（2026-08-21 官方前端）。 */
export const TikTokCreativeAutomationStrategies = {
  ctaEnhancement: "100001",
  generatedAdCard: "100002",
  catalogProducts: "200001",
  translateAndDub: "7419232909960003601",
  videoQuality: "7455417586723028993",
  musicRefresh: "7478954523433500688",
} as const;

/** 用户确认的默认组合：CTA、生成广告卡片、视频质量开启；其余策略关闭。 */
export const DefaultTikTokCreativeAutomationStrategyIds = [
  TikTokCreativeAutomationStrategies.ctaEnhancement,
  TikTokCreativeAutomationStrategies.generatedAdCard,
  TikTokCreativeAutomationStrategies.videoQuality,
] as const;

const DefaultProgrammaticCtaAssets = [{
  asset_ids: [202046, 201641],
  asset_content: "立即下单",
  asset_content_key: "order_now",
  asset_source: 0,
  cta_content: "立即下单",
  material_id: "202046_201641",
}] as const;

function defaultCreativeAutomationFields(): Record<string, unknown> {
  return {
    // 2 = 自选策略列表。真机成功抓包用的就是 2；写 1 会被 TikTok 以
    // creative_automation_list_should_be_nil_error 拒绝（type=1 不允许带列表）。
    creative_automation_type: 2,
    creative_automation_list: [...DefaultTikTokCreativeAutomationStrategyIds],
    need_create_cta_id: true,
    call_to_action_id: "",
    call_to_action_asset_list: clone(DefaultProgrammaticCtaAssets),
    // “商品库显示设置”关闭；生成广告卡片由 100002 独立控制。
    catalog_setup: 0,
    catalog_authorized_bc: "0",
    spp_rebrand_catalog_switch: 0,
    product_info_type: 1,
    product_info: {
      promo_code_infos: [],
      is_auto_use: 2,
      auto_select_toggle: 0,
      image_infos: [],
      selling_points_by_types: [],
    },
  };
}

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
  return { campaign_id: "", campaign_snap_id: value.campaignSnapId, campaign_sketch_id: value.campaignSketchId, ad_and_creative_snap_info_list: value.adAndCreativeSnapInfoList, ...TikTokCreationPublishSource, is_status_disabled: initialStatus === "disabled", is_partial_publish: false };
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

const TikTokAgeRanges: Record<LaunchAgeRange, [number, number]> = {
  "18-24": [18, 24],
  "25-34": [25, 34],
  "35-44": [35, 44],
  "45-54": [45, 54],
  "55-100": [55, 100],
};

/**
 * TikTok 年龄档的**完整池子**，含未成年档。
 *
 * 这不是投放目标，而是 `limited_audience.age` 要求的「可选范围」——TikTok 用它表达
 * 「这个广告组允许在哪些档位里挑」。真机抓包与线上实测都确认：Smart+ 广告组必须原样
 * 带上全部六档，少一档就会被判成「自定义年龄」，以
 * audience_age_smart_age_validate_error（文案是「仅限向 18 岁以上投放」，具有误导性）
 * 拒绝创建。未成年是否投放由 TikTok 按政策自行排除，不由这里控制。
 *
 * 实际投放年龄走 `age` 字段（空数组 = 不限）。用户可选项见 LaunchAgeRangeValues，
 * 那里**不含**未成年档。
 */
const TIKTOK_AGE_RANGE_POOL: number[][] = [
  [13, 17], [18, 24], [25, 34], [35, 44], [45, 54], [55, 100],
];

function materializeAgeRanges(values: readonly LaunchAgeRange[]): number[][] {
  // 历史计划里可能存着已下线的年龄档，映射不到就丢弃——绝不能产出 undefined 元素
  // 塞进定向载荷。
  return values.flatMap((value) => {
    const range = TikTokAgeRanges[value];
    return range ? [[...range]] : [];
  });
}

function materializeGender(gender: CreationPresetConfig["gender"]): number {
  return gender === "male" ? 1 : gender === "female" ? 2 : 0;
}

/**
 * 新表格逐行定向优先；旧计划或非表格复制流程缺少行字段时，继续兼容旧预设。
 * 两处都没有值时只为载荷准备“不限”的数值，但不宣称显式覆盖已验证快照。
 */
function resolvedRowTargeting(
  row: Pick<LaunchConfigurationRow, "ageRanges" | "gender">,
  config: Pick<CreationPresetConfig, "ageRanges" | "gender">,
) {
  const selectedAgeRanges = row.ageRanges?.length
    ? row.ageRanges
    : config.ageRanges?.length ? config.ageRanges : undefined;
  const selectedGender = row.gender ?? config.gender;
  // 选满全部可选档 == 不限：真机「不限年龄」发的是空 age，保持一致，
  // 否则 TikTok 界面会把它显示成一串自定义档位而不是「全部」。
  const coversEveryBand = Boolean(selectedAgeRanges)
    && LaunchAgeRangeValues.every((band) => selectedAgeRanges!.includes(band));
  return {
    ageRanges: materializeAgeRanges(selectedAgeRanges ?? LaunchAgeRangeValues),
    // 实际投放年龄：空数组 = 不限。
    restrictedAgeRanges: !selectedAgeRanges?.length || coversEveryBand
      ? []
      : materializeAgeRanges(selectedAgeRanges),
    gender: materializeGender(selectedGender),
    hasExplicitAgeRanges: Boolean(selectedAgeRanges?.length),
    hasExplicitGender: selectedGender !== undefined,
  };
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
  const smartPlus = config.objectiveType === 3;
  const budget = resolveBudgetFields({
    budgetMode: resolveConfiguredBudgetMode(config),
    campaignBudget: row.campaignBudget ?? null,
    adGroupBudget: row.dailyBudget,
    smartPlus,
  });
  const { ageRanges, restrictedAgeRanges, gender, hasExplicitAgeRanges } = resolvedRowTargeting(row, config);
  return {
    campaign: {
      campaign_sketch_form_data: {
        campaign_name: row.campaignName,
        campaign_id: "",
        campaign_snap_id: "",
        campaign_sketch_id: "",
        objective_type: config.objectiveType,
        buying_type: config.buyingType,
        budget_mode: budget.campaign.budget_mode,
        budget: budget.campaign.budget,
        industry_types: [],
        // 非智能+ 系列的历史载荷不带预算优化字段，保持原样；但系列预算(CBO)必须
        // 显式声明开关，否则 budget_mode=3 会被当成未开启 CBO 处理。
        ...(!smartPlus && budget.campaign.budget_optimize_switch === 1
          ? {
              budget_optimize_switch: 1,
              budget_auto_adjust: budget.campaign.budget_auto_adjust,
            }
          : {}),
        ...(smartPlus ? {
          app_campaign_type: 0,
          ba_campaign_type: 0,
          bid_align_type: 0,
          brand_campaign_type: 0,
          brand_catalog_toggle: 0,
          campaign_app_profile_page_type: 0,
          cbo_uniform_bid: 0,
          dedicate_type: 0,
          ecomm_type: 0,
          has_selected_traffic_smart_plus: false,
          lead_catalog_toggle: 0,
          redesign_campaign_type: 1,
          rewarding_game_attestation: 0,
          rf_campaign_type: 0,
          rta_bid_type: 0,
          search_campaign_type: 0,
          skan4_campaign_structure_type: 0,
          skan_campaign_type: 0,
          universal_type: 1,
          universal_type_default_on: false,
          sales_destination: 3,
          virtual_objective_type: 1,
          vertical_market_campaign_type: 0,
          web_all_in_one_catalog: 2,
          spc_automation_type: 1,
          spc_simulated_mode: 0,
          auto_creation_product_type: 1,
          spc_upgrade_mode: 1,
          spc_multi_ad_mode: 1,
          support_traffic_smart_plus: true,
          traffic_catalog_toggle: 0,
          bid: "0",
          cpa_bid: "0",
          budget_optimize_switch: budget.campaign.budget_optimize_switch,
          budget_auto_adjust: budget.campaign.budget_auto_adjust,
        } : {}),
      },
      is_from_startup: false,
      with_sketch: true,
      // Ads Manager defers the complete Smart+ tree validation until the
      // campaign/ad/creative snaps have all been saved. Validating this first
      // isolated form strips newer automation fields such as dynamic budget.
      is_skip_check_fields: smartPlus,
    },
    adGroup: {
      campaign_id: "",
      with_sketch: true,
      is_skip_check_fields: smartPlus,
      ...(smartPlus && config.identityType !== 5 ? { spc_upgrade_mode: 1 } : {}),
      ad_sketch_form_data: {
        origin_ad_id: 0,
        coming_source_type: 1,
        sketch_publish_source: 1,
        ad_name: row.adGroupName,
        ad_snap_id: "",
        ad_sketch_id: "",
        schedule_type: 1,
        start_time: startTime,
        end_time: endTime,
        budget_mode: budget.adGroup.budget_mode,
        budget: budget.adGroup.budget,
        pricing: config.pricing,
        // For oCPM, the cost cap belongs to cpa_bid. `bid` is the legacy CPM
        // field and must stay empty; sending the CPA value in both fields makes
        // TikTok reject the form as a non-oCPM pricing tuple.
        bid: config.pricing === 9 ? "0" : row.bid === null ? "" : String(row.bid),
        cpa_bid: row.bid === null ? "" : String(row.bid),
        smart_bid_type: 0,
        bid_type_detail: 0,
        bid_display_mode: 0,
        deep_bid_type: 0,
        deep_cpabid: "0",
        optimization_source: 0,
        roas_bid: "0",
        cpa_skip_first_phrase: 1,
        objective_type: config.objectiveType,
        optimize_goal: config.optimizeGoal,
        external_action: config.externalAction,
        ad_ref_pixel_id: config.pixelId ?? "",
        automated_targeting: config.objectiveType === 3 ? 0 : config.smartTargeting ? 1 : 0,
        country: config.countryCodes,
        // TikTok uses `platform` for OS targeting (0 = all), while placement
        // selection belongs to `inventory_flow`.
        platform: [0],
        inventory_flow: config.placementIds,
        inventory_flow_type: 1,
        search_delivery_type: 5,
        classify: 1,
        promotion_website_type: 0,
        external_type: 102,
        app_type: 0,
        flow_control_mode: 1,
        language_list: [],
        gender,
        // Smart+ 与非 Smart+ 都走同一套语义：age 是实际投放年龄，空数组 = 不限。
        age: smartPlus ? restrictedAgeRanges : hasExplicitAgeRanges ? ageRanges : [],
        ac: [],
        ad_tag_v2: [],
        android_osv: "",
        ios_osv: "",
        launch_price: [],
        device_models: [],
        targeting_expansion: { expansion_enabled: false, expansion_types: [] },
        carriers: [],
        flow_package_include: [],
        flow_package_exclude: [],
        device_type: 0,
        retargeting_tags: [],
        retargeting_tags_exclude: [],
        zipcode_ids: [],
        province: [],
        city: [],
        districts: [],
        particle_locations: config.countryCodes,
        include_custom_actions: [],
        exclude_custom_actions: [],
        interest_keywords_i18n: [],
        interest_keywords_lang_i18n: [],
        in_market_tags: [],
        spending_power_v2: [],
        household_income: [],
        contextual_tags: [],
        action_categories_v2: [],
        action_days_v2: [],
        action_scenes_v2: [],
        video_actions_v2: [],
        daily_retention_ratio: 0,
        ios14_quota_type: 1,
        suitability_non_garm_category: [],
        anti_discrimination: 0,
        // 见 TIKTOK_AGE_RANGE_POOL：未成年由 TikTok 按政策排除，这里恒为 0。
        exclude_age_under_eighteen: 0,
        duration_time_range: 0,
        attribution_window_click: 7,
        attribution_window_view: 1,
        attribution_statistic_type: 2,
        statistic_type: 0,
        dc_postback_mode: 0,
        attribution_model: 1,
        smart_interest_behavior: smartPlus ? 3 : 0,
        smart_audience: smartPlus ? 3 : 0,
        smart_age: smartPlus ? 3 : 0,
        smart_gender: smartPlus ? 3 : 0,
        custom_audience_tag_relation: 0,
        suggestion_audience_toggle: smartPlus ? 3 : 0,
        limited_audience: { age: smartPlus ? TIKTOK_AGE_RANGE_POOL : [] },
        ad_ref_onsite_event_source_type: 0,
        auto_pull_toggle: 0,
        ttms_account_id: "",
        creative_material_mode: 6,
        ...(smartPlus ? {
          spc_targeting_switch: 0,
          ...(config.identityType !== 5 ? { spc_upgrade_mode: 1 } : {}),
          spc_multi_ad_mode: 1,
        } : {}),
        budget_auto_adjust: budget.adGroup.budget_auto_adjust,
        week_schedule: [[], [], [], [], [], [], []],
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
        ...defaultCreativeAutomationFields(),
        ...(smartPlus ? {
          creative_material_mode: 6,
          // spc_upgrade_mode / spc_multi_ad_mode / is_smart_creative 一律不在创意层出现。
          //
          // 这三个字段此前按 identityType === 5 加护栏，而授权码这条路真正用的是
          // identity_type=2（身份挂在 image_list 每一项上，不是 config.identityType），
          // 于是护栏从未生效：创意层带着 spc_upgrade_mode=0 发出去，顶层却是 1，
          // TikTok 判为 uaa_campaign_automation_inconsistent_error。同一个错从 08-07
          // 反复到 08-27，期间「把它归零」的补丁打过三次——归不归零都错，它根本
          // 不该出现在这一层。
          //
          // 依据是 2026-08-27 的真机抓包：一次成功创建里 10 条 creative_snap/save
          // （identity_type 2 与 3 都有）创意层一次都没出现过这三个字段，
          // spc_upgrade_mode 只在顶层出现且恒为 1。
          auto_pull_by_destination_toggle: 2,
          auto_pull_by_aigc_toggle: 2,
          aigc_approval_auto_pull_toggle: 2,
          auto_pull_toggle: 0,
          auto_open: 0,
          utm_auto_switch: 1,
          // No catalog/product metadata is migrated with an account post.
          // Advertising `catalog_setup=1` with an empty product_info makes the
          // creative automation tuple internally inconsistent at publish time.
          auto_follow_up_list: [],
          auto_selected_vids: [],
          struct_version: 1,
          featured_with_three_auto_enabled_in_copy: false,
        } : {}),
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
  adForm.ad_name = row.adGroupName;
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
    applyCreationConfigOverrides(campaignForm, adForm, asset, customConfig, row);
  }
  // 预算字段最后写，压过抓包模板和 config 覆盖里的旧值。它不依赖 config 是否完整：
  // 模板不完整时也必须保证「持有预算的那一层」正确，否则会发出一个声明了系列预算
  // 却把金额留在广告组上的畸形表单。
  applyResolvedBudgetFields(campaignForm, adForm, resolveBudgetFields({
    budgetMode: resolveConfiguredBudgetMode(customConfig),
    campaignBudget: row.campaignBudget ?? null,
    adGroupBudget: row.dailyBudget,
    smartPlus: (customConfig?.objectiveType ?? numberOrNull(campaignForm.objective_type)) === 3,
  }));
  if (campaignForm.industry_types === undefined) campaignForm.industry_types = [];
  return { campaign, adGroup, creative };
}

function numberOrNull(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** 把解析后的预算字段写进两层表单。两层互斥，必须成对写入。 */
function applyResolvedBudgetFields(
  campaignForm: Record<string, unknown>,
  adForm: Record<string, unknown>,
  budget: ResolvedBudgetFields,
): void {
  campaignForm.budget_mode = budget.campaign.budget_mode;
  campaignForm.budget = budget.campaign.budget;
  campaignForm.budget_optimize_switch = budget.campaign.budget_optimize_switch;
  campaignForm.budget_auto_adjust = budget.campaign.budget_auto_adjust;
  adForm.budget_mode = budget.adGroup.budget_mode;
  adForm.budget = budget.adGroup.budget;
  adForm.budget_auto_adjust = budget.adGroup.budget_auto_adjust;
}
function applyCreationConfigOverrides(
  campaignForm: Record<string, unknown>,
  adForm: Record<string, unknown>,
  asset: Record<string, unknown>,
  config: CreationPresetConfig,
  row: LaunchConfigurationRow,
) {
  const smartPlus = config.objectiveType === 3;
  const {
    ageRanges,
    restrictedAgeRanges,
    gender,
    hasExplicitGender,
    hasExplicitAgeRanges,
  } = resolvedRowTargeting(row, config);
  campaignForm.objective_type = config.objectiveType;
  campaignForm.buying_type = config.buyingType;
  // 预算字段由 applyResolvedBudgetFields 在本函数之后统一写入。
  if (smartPlus) {
    Object.assign(campaignForm, {
      app_campaign_type: 0,
      ba_campaign_type: 0,
      bid_align_type: 0,
      brand_campaign_type: 0,
      brand_catalog_toggle: 0,
      campaign_app_profile_page_type: 0,
      cbo_uniform_bid: 0,
      dedicate_type: 0,
      ecomm_type: 0,
      has_selected_traffic_smart_plus: false,
      lead_catalog_toggle: 0,
      redesign_campaign_type: 1,
      rewarding_game_attestation: 0,
      rf_campaign_type: 0,
      rta_bid_type: 0,
      search_campaign_type: 0,
      skan4_campaign_structure_type: 0,
      skan_campaign_type: 0,
      universal_type: 1,
      universal_type_default_on: false,
      sales_destination: 3,
      virtual_objective_type: 1,
      vertical_market_campaign_type: 0,
      web_all_in_one_catalog: 2,
      spc_automation_type: 1,
      spc_simulated_mode: 0,
      auto_creation_product_type: 1,
      spc_upgrade_mode: 1,
      spc_multi_ad_mode: 1,
      support_traffic_smart_plus: true,
      traffic_catalog_toggle: 0,
      bid: "0",
      cpa_bid: "0",
    });
  }
  adForm.coming_source_type = 1;
  adForm.sketch_publish_source = 1;
  adForm.pricing = config.pricing;
  adForm.optimize_goal = config.optimizeGoal;
  adForm.external_action = config.externalAction;
  if (config.pricing === 9) adForm.bid = "0";
  adForm.smart_bid_type = 0;
  adForm.bid_type_detail = 0;
  adForm.bid_display_mode = 0;
  adForm.deep_bid_type = 0;
  adForm.deep_cpabid = "0";
  adForm.optimization_source = 0;
  adForm.roas_bid = "0";
  adForm.cpa_skip_first_phrase = 1;
  adForm.ad_ref_pixel_id = config.pixelId ?? "";
  adForm.automated_targeting = config.objectiveType === 3 ? 0 : config.smartTargeting ? 1 : 0;
  if (smartPlus) {
    Object.assign(adForm, {
      // age = 实际投放年龄（空数组 = 不限）；limited_audience = 可选范围，恒为全池。
      age: restrictedAgeRanges,
      ...(hasExplicitGender ? { gender } : {}),
      exclude_age_under_eighteen: 0,
      limited_audience: { age: TIKTOK_AGE_RANGE_POOL },
      smart_interest_behavior: 3,
      smart_audience: 3,
      smart_age: 3,
      smart_gender: 3,
      suggestion_audience_toggle: 3,
      spc_targeting_switch: 0,
      spc_upgrade_mode: 1,
      spc_multi_ad_mode: 1,
    });
  }
  if (!smartPlus) {
    if (hasExplicitAgeRanges) adForm.age = ageRanges;
    if (hasExplicitGender) adForm.gender = gender;
    if (hasExplicitAgeRanges) {
      adForm.exclude_age_under_eighteen = 1;
    }
  }
  if (config.countryCodes.length > 0) adForm.country = [...config.countryCodes];
  if (config.placementIds.length > 0) {
    adForm.inventory_flow = [...config.placementIds];
  }
  adForm.platform = [0];
  if (adForm.week_schedule === undefined) {
    adForm.week_schedule = [[], [], [], [], [], [], []];
  }
  if (adForm.language_list === undefined) {
    adForm.language_list = [];
  }
  const neutralAdDefaults: Record<string, unknown> = {
    gender,
    age: !smartPlus && hasExplicitAgeRanges ? ageRanges : [],
    ac: [],
    ad_tag_v2: [],
    android_osv: "",
    ios_osv: "",
    launch_price: [],
    device_models: [],
    targeting_expansion: { expansion_enabled: false, expansion_types: [] },
    carriers: [],
    flow_package_include: [],
    flow_package_exclude: [],
    device_type: 0,
    retargeting_tags: [],
    retargeting_tags_exclude: [],
    zipcode_ids: [],
    province: [],
    city: [],
    districts: [],
    particle_locations: [...config.countryCodes],
    include_custom_actions: [],
    exclude_custom_actions: [],
    interest_keywords_i18n: [],
    interest_keywords_lang_i18n: [],
    in_market_tags: [],
    spending_power_v2: [],
    household_income: [],
    contextual_tags: [],
    action_categories_v2: [],
    action_days_v2: [],
    action_scenes_v2: [],
    video_actions_v2: [],
    daily_retention_ratio: 0,
    ios14_quota_type: 1,
    suitability_non_garm_category: [],
    anti_discrimination: 0,
    // 投放年龄不含未成年档，恒为排除。
    exclude_age_under_eighteen: 1,
    duration_time_range: 0,
    attribution_window_click: 7,
    attribution_window_view: 1,
    attribution_statistic_type: 2,
    statistic_type: 0,
    dc_postback_mode: 0,
    attribution_model: 1,
    smart_interest_behavior: 0,
    smart_audience: 0,
    smart_age: 0,
    smart_gender: 0,
    custom_audience_tag_relation: 0,
    suggestion_audience_toggle: 0,
    limited_audience: {
      // Smart+ 的可选范围恒为全池；非 Smart+ 沿用原有行为。
      age: smartPlus
        ? TIKTOK_AGE_RANGE_POOL
        : hasExplicitAgeRanges
          ? []
          : materializeAgeRanges(LaunchAgeRangeValues),
    },
    ad_ref_onsite_event_source_type: 0,
    auto_pull_toggle: 0,
    ttms_account_id: "",
    creative_material_mode: 6,
    inventory_flow_type: 1,
    search_delivery_type: 5,
    classify: 1,
    promotion_website_type: 0,
    external_type: 102,
    app_type: 0,
    flow_control_mode: 1,
  };
  for (const [key, value] of Object.entries(neutralAdDefaults)) {
    if (adForm[key] === undefined) adForm[key] = value;
  }
  if (adForm.bid === undefined) adForm.bid = adForm.cpa_bid ?? "";
  if (adForm.objective_type === undefined) adForm.objective_type = config.objectiveType;
  asset.identity_type = config.identityType;
  asset.identity_id = config.identityId;
  const existingCtaAssets = asset.call_to_action_asset_list;
  Object.assign(asset, defaultCreativeAutomationFields());
  if (Array.isArray(existingCtaAssets) && existingCtaAssets.length >= 1 && existingCtaAssets.length <= 3) {
    asset.call_to_action_asset_list = existingCtaAssets;
  }
  if (smartPlus) {
    Object.assign(asset, {
      creative_material_mode: 6,
      // 与 buildDraftPayloads 同一条结论：这三个字段不在创意层出现。理由见那边的注释。
      auto_pull_by_destination_toggle: 2,
      auto_pull_by_aigc_toggle: 2,
      aigc_approval_auto_pull_toggle: 2,
      auto_pull_toggle: 0,
      auto_open: 0,
      utm_auto_switch: 1,
      auto_follow_up_list: [],
      auto_selected_vids: [],
      struct_version: 1,
      featured_with_three_auto_enabled_in_copy: false,
    });
  }
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
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> { if (!isRecord(value[key])) throw new Error(`本地创建模板缺少 ${key}，请重新验证该账户的创建模板。`); return value[key]; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function requiredCreationFields(config: Partial<CreationPresetConfig>): string[] {
  const fields: Array<[string, unknown]> = [
    ["营销目标", config.objectiveType],
    ["购买方式", config.buyingType],
    // 两层的 budget_mode 已由 budgetMode 派生，不再要求用户填写原始数字。
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
