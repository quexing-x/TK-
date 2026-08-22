import type { CreationPresetConfig, ProviderEntity } from "@tk-auto/core";
import { RetryableCreationError } from "./types.js";

interface PixelCandidate {
  id: string;
  matchingObjectiveCount: number;
}

interface AdGroupPixelCandidate {
  id: string;
  name: string;
  /** 引用该数据连接的广告组数量，仅用于报错时按常用度排序。 */
  usageCount: number;
}

const pixelIdKeys = new Set(["ad_ref_pixel_id", "pixel_id", "pixelid", "tracking_pixel_id"]);

function textValue(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizedKey(value: string): string {
  return value.replaceAll("-", "_").toLowerCase();
}

function collectLegacyPixelIds(
  value: unknown,
  result = new Set<string>(),
): Set<string> {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    for (const item of value) collectLegacyPixelIds(item, result);
    return result;
  }
  for (const [rawKey, nested] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizedKey(rawKey);
    const text = textValue(nested);
    if (text && pixelIdKeys.has(key) && /^\d+$/.test(text)) result.add(text);
    collectLegacyPixelIds(nested, result);
  }
  return result;
}

function pixelCandidates(
  entities: ProviderEntity[],
  preset: CreationPresetConfig,
): PixelCandidate[] {
  const candidates = new Map<string, PixelCandidate>();
  for (const entity of entities) {
    if (entity.entityType !== "ad-group") continue;
    const pixelIds = collectLegacyPixelIds(entity.payload);
    const objectiveMatches = Number(entity.payload.objective_type) === preset.objectiveType
      && Number(entity.payload.optimize_goal) === preset.optimizeGoal
      && Number(entity.payload.external_action) === preset.externalAction;
    for (const id of pixelIds) {
      const candidate = candidates.get(id) ?? {
        id,
        matchingObjectiveCount: 0,
      };
      if (objectiveMatches) candidate.matchingObjectiveCount += 1;
      candidates.set(id, candidate);
    }
  }
  return [...candidates.values()];
}

/**
 * 目标账户当前在用的数据连接（旧称 Pixel），从广告组自身的字段里归纳。
 *
 * 数据来源刻意选广告组列表：创建广告组时要填的就是这个「数据连接」，账户里在用
 * 哪些、叫什么名字，广告组自己最清楚。事件管理器那套目录接口
 * （/mi/api/v2/i18n/pixel/list/）已经对所有账户返回 code 50002，不能再依赖。
 */
function adGroupPixelCandidates(entities: ProviderEntity[]): AdGroupPixelCandidate[] {
  const candidates = new Map<string, AdGroupPixelCandidate>();
  for (const entity of entities) {
    if (entity.entityType !== "ad-group") continue;
    const id = textValue(entity.payload.ad_ref_pixel_id);
    if (!id || !/^\d+$/.test(id)) continue;
    const name = textValue(entity.payload.ad_pixel_name) ?? "";
    const previous = candidates.get(id);
    candidates.set(id, {
      id,
      name: name || previous?.name || "",
      usageCount: (previous?.usageCount ?? 0) + 1,
    });
  }
  return [...candidates.values()];
}

/** 20 位大写字母数字混排：TikTok 事件管理器里展示的 Pixel Code。 */
function looksLikePixelCode(value: string): boolean {
  return /^[A-Z0-9]{16,32}$/.test(value) && /[A-Z]/.test(value) && !/^\d+$/.test(value);
}

/**
 * 把用户填的「数据连接」解析成 TikTok 的数字 ID。
 *
 * 只认**名称**与**数字 ID**：广告组字段里只有 ad_ref_pixel_id 和 ad_pixel_name，
 * 没有 pixel_code，所以 Code 无法在本地比对——与其拿 Code 去查那个已经废掉的目录
 * 接口（整批创建会在发出任何写请求前全灭），不如直接告诉用户改填名称或 ID。
 */
export function resolveAccountPixelIdFromAdGroups(
  entities: ProviderEntity[],
  selector: string,
): string {
  const requested = selector.trim();
  const normalized = requested.toLocaleLowerCase();
  const candidates = adGroupPixelCandidates(entities);
  const matched = candidates.filter((candidate) =>
    candidate.id === requested || candidate.name.toLocaleLowerCase() === normalized);
  if (matched.length === 1) return matched[0]!.id;
  if (matched.length > 1) {
    throw new RetryableCreationError(
      `目标账户有多个数据连接匹配“${requested}”：${matched.map((item) => `${item.name}(${item.id})`).join("、")}。请改填唯一的数字 ID。`,
    );
  }
  // 报错必须带上「这个账户实际有什么」，否则用户只能靠猜。
  const known = candidates
    .sort((left, right) => right.usageCount - left.usageCount)
    .slice(0, 8)
    .map((item) => `${item.name || "(未命名)"}(${item.id})`)
    .join("、");
  if (looksLikePixelCode(requested)) {
    throw new RetryableCreationError(
      `“${requested}”看起来是 Pixel Code，创建广告组时无法用 Code 匹配数据连接。`
      + `请改填数据连接名称或数字 ID。${known ? `该账户在用的有：${known}` : "该账户的广告组里没有任何数据连接可供匹配。"}`,
    );
  }
  throw new RetryableCreationError(
    `目标账户的广告组里找不到数据连接“${requested}”，已在发送创建请求前停止。`
    + `${known ? `该账户在用的有：${known}` : "该账户的广告组里没有任何数据连接可供匹配。"}`,
  );
}

/**
 * Compatibility path for numeric interface IDs saved by older presets. New
 * user-entered Pixel IDs/Codes are never inferred from historical ad groups.
 */
export function resolveLegacyTargetAccountPixelId(
  entities: ProviderEntity[],
  preset: CreationPresetConfig,
): string | undefined {
  const candidates = pixelCandidates(entities, preset);
  // Compatibility path for presets saved before pixelKey existed. Keep the
  // previous objective-based account inference, but prefer an exact local ID.
  const legacyId = preset.pixelId?.trim();
  if (!legacyId) return undefined;
  if (candidates.some((candidate) => candidate.id === legacyId)) return legacyId;
  const ranked = candidates
    .filter((candidate) => candidate.matchingObjectiveCount > 0)
    .sort((left, right) => right.matchingObjectiveCount - left.matchingObjectiveCount);
  if (ranked.length > 1 && ranked[0]!.matchingObjectiveCount === ranked[1]!.matchingObjectiveCount) {
    throw new RetryableCreationError("目标账户存在多个同等匹配的 Pixel，无法安全确定应使用哪一个。");
  }
  return ranked[0]?.id ?? legacyId;
}
