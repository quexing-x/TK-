import type { CreationPresetConfig, ProviderEntity } from "@tk-auto/core";
import { RetryableCreationError } from "./types.js";

interface PixelCandidate {
  id: string;
  matchingObjectiveCount: number;
}

interface PixelDirectoryCandidate {
  id: string;
  name: string;
  code: string;
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

function pixelDirectoryCandidates(
  payloads: Record<string, unknown>[],
): PixelDirectoryCandidate[] {
  const candidates = new Map<string, PixelDirectoryCandidate>();
  for (const payload of payloads) {
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? payload.data as Record<string, unknown>
      : payload;
    if (!Array.isArray(data.pixel_list)) {
      throw new RetryableCreationError(
        "TikTok 实时像素目录响应缺少 pixel_list，已在发送创建请求前停止。",
      );
    }
    for (const item of data.pixel_list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const id = textValue(record.pixel_id);
      if (!id) continue;
      const previous = candidates.get(id);
      candidates.set(id, {
        id,
        name: textValue(record.pixel_name) ?? previous?.name ?? "",
        code: textValue(record.pixel_code) ?? previous?.code ?? "",
      });
    }
  }
  return [...candidates.values()];
}

/** Resolves a user-entered Pixel ID/Code/name from the target account's live directory. */
export function resolveLivePixelDirectoryId(
  payloads: Record<string, unknown>[],
  selector: string,
): string {
  const requested = selector.trim();
  const normalized = requested.toLocaleLowerCase();
  const matches = pixelDirectoryCandidates(payloads).filter((candidate) =>
    candidate.id === requested
    || candidate.code.toLocaleLowerCase() === normalized
    || candidate.name.toLocaleLowerCase() === normalized,
  );
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new RetryableCreationError(
      `当前账户的实时像素目录有多个像素匹配“${requested}”，已在发送创建请求前停止。请填写唯一的 Pixel ID / Code。`,
    );
  }
  throw new RetryableCreationError(
    `当前账户的实时像素目录未找到“${requested}”，已在发送创建请求前停止。请确认 Pixel ID / Code 属于该广告账户。`,
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
