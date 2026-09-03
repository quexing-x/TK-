/**
 * 发布 TikTok 后台已经存在的草稿广告组。
 *
 * 扩组是「建草稿 → 发布」两步。发布那步失败时草稿留在 TikTok 后台，本地记一条
 * 「结果未知」——对账判成 `draft-only` 的就是这类。此前没有任何入口能把这些草稿收口：
 * 发布需要 snap/sketch 标识，而那是建草稿时的临时产物，失败记录里的 generated_ids_json
 * 是空的。
 *
 * 好在草稿能按名字反查，再由 `snap/save_by_sketch` 重新生成 snap，于是三步就能发布：
 *   statistics/sketch/ad/list（按名字找到 sketch）
 *   → creation/snap/save_by_sketch（sketch → snap 映射）
 *   → creation/async_creation/create_by_snap（sketch_publish_source=2）
 *
 * 接口契约见 docs/PUBLISH_DRAFT_CONTRACT.md（2026-08-25 真机抓包）。这里只放与账户无关
 * 的载荷与判据；Cookie、签名参数一律留在 provider 的凭据里。
 */

/**
 * 从草稿发布的来源标记。**与新建不同**：新建走
 * `TikTokCreationPublishSource`（coming_source_type 1 / sketch_publish_source 1），
 * 从已有草稿发布走这一组。用错会让 TikTok 把它当成一次新建。
 */
export const TikTokDraftPublishSource = {
  coming_source_type: 6,
  sketch_publish_source: 2,
} as const;

/** 一条草稿广告组。字段名取自真机响应，`data.table[]`（注意是 table 不是 list）。 */
export interface DraftSketchEntry {
  adSketchId: string;
  adSketchName: string;
  campaignId: string;
  campaignSketchId: string;
  /** 最后一次被动过的时刻（秒级 Unix 时间戳）；取不到时为 null。 */
  touchedAt: number | null;
}

/** 草稿列表分页请求体。排序固定按修改时间倒序，最近失败的那批排在最前。 */
export function buildDraftSketchListPayload(page: number, limit: number): Record<string, unknown> {
  return {
    query_list: [],
    page: Math.max(1, Math.trunc(page)),
    limit: Math.max(1, Math.min(100, Math.trunc(limit))),
    sort_order: 1,
    sort_stat: "modify_time",
    filters: [],
  };
}

export function parseDraftSketchList(payload: unknown): DraftSketchEntry[] {
  const table = tableOf(payload);
  const entries: DraftSketchEntry[] = [];
  for (const row of table) {
    const adSketchId = idAt(row, "ad_sketch_id");
    const adSketchName = String(row.ad_sketch_name ?? "").trim();
    if (!adSketchId || !adSketchName) continue;
    entries.push({
      adSketchId,
      adSketchName,
      campaignId: idAt(row, "campaign_id") ?? "",
      // "0" 是「不属于任何系列草稿」的占位，等价于没有。
      campaignSketchId: idAt(row, "campaign_sketch_id") ?? "",
      // 取最晚的那个：判「有没有人正在动它」要看最后一次改动，不是创建。
      touchedAt: latestTimestamp(row, ["ad_modify_time", "modify_time", "ad_create_time", "create_time"]),
    });
  }
  return entries;
}

export interface DraftSketchMatch {
  matched: DraftSketchEntry[];
  missing: string[];
}

export interface DraftPublishTargets {
  /** 还停在草稿、这一次要发的。 */
  matched: DraftSketchEntry[];
  /** 已经是正式广告组，不必再发——上一次部分成功建出来的就是这些。 */
  alreadyPublished: string[];
  /** 既不是草稿、也不是正式组。不知道去哪了，不下结论。 */
  missing: string[];
}

/**
 * 把一批组名分成「要发的草稿」「已经建成的」「不知去向的」。
 *
 * 只按草稿匹配是不够的，因为**部分成功是常态**：一次扩 3 个组，TikTok 的终态回来
 * 「广告组 2/3」，于是 2 个成了正式组、1 个停在草稿。此时若要求 3 个名字都能对上草稿，
 * 整批就会被拒，那 1 个草稿永远发不出去——而它恰恰是唯一还需要处理的。
 *
 * `publishedNames` 是调用方**已经证明**为正式广告组的那些名字（同一个系列下、且状态不是
 * `ad_create`）。「证明」这两个字是这里的全部安全性：
 *
 * - 名字在草稿里 → 发它。草稿优先于快照，理由同 `reconcileExpandTask`：同名的正式组只能
 *   说明「重试过、有一次成功了」，不能说明这一条已经收口。
 * - 名字不在草稿里、但已证明是正式组 → 跳过。它已经建成了，再发一次就是建第二个。
 * - 两者都不是 → 进 `missing`，**调用方必须停手**。「不在草稿里」本身证明不了任何事：
 *   可能已被人手动发布，也可能已被删除，还可能是同名草稿有多份而无从挑选。少了这一条，
 *   一个被删掉的草稿会被当成「已经建成」而悄悄收口，那批组就永远没人认领了。
 */
export function resolveDraftPublishTargets(
  names: readonly string[],
  entries: readonly DraftSketchEntry[],
  publishedNames: readonly string[] = [],
): DraftPublishTargets {
  const { matched, missing } = matchDraftSketchesByName(names, entries);
  const published = new Set(publishedNames.map((name) => name.trim()).filter(Boolean));
  const alreadyPublished: string[] = [];
  const stillMissing: string[] = [];
  for (const name of missing) {
    if (published.has(name)) alreadyPublished.push(name);
    else stillMissing.push(name);
  }
  return { matched, alreadyPublished, missing: stillMissing };
}

/**
 * 按名字把失败记录里的 generatedNames 对到草稿上。
 *
 * 同名草稿有多份时**不下结论**：那意味着之前重试过、后台留了不止一个草稿，机器挑哪一个
 * 都可能挑错，交给人去后台删到只剩一个。同名重复按「没找到」处理，理由一并带出来。
 */
export function matchDraftSketchesByName(
  names: readonly string[],
  entries: readonly DraftSketchEntry[],
): DraftSketchMatch {
  const byName = new Map<string, DraftSketchEntry[]>();
  for (const entry of entries) {
    const key = entry.adSketchName.trim();
    if (!key) continue;
    const bucket = byName.get(key);
    if (bucket) bucket.push(entry);
    else byName.set(key, [entry]);
  }
  const matched: DraftSketchEntry[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const bucket = byName.get(name);
    if (bucket?.length === 1) matched.push(bucket[0]!);
    else missing.push(name);
  }
  return { matched, missing };
}

/** 清理遗留草稿的默认保护期。 */
export const DRAFT_CLEANUP_MIN_AGE_HOURS = 3;

export interface StaleDraftSelection {
  /** 够格删的。 */
  stale: DraftSketchEntry[];
  /** 还在保护期内的条数——用来向用户解释名单为什么比后台看到的短。 */
  tooFresh: number;
  /** 被待决策的「结果未知」记录保住的条数。 */
  reserved: number;
}

/**
 * 挑出可以删掉的遗留草稿。
 *
 * 草稿会因为人工中途放弃、网络卡顿、自动化断联而留在后台，越攒越多。但「后台有一个草稿」
 * 和「这个草稿是垃圾」不是一回事——**扩组本身就是先建草稿再发布**，轮询正在跑的那一刻
 * 后台必然有草稿；人在 TikTok 界面上手搓一个广告组时，后台也一直躺着一个草稿。
 *
 * 所以保护期是这个功能的全部安全性所在：只删**超过 `minAgeHours` 没人动过**的。3 小时足够
 * 覆盖一轮扩组（实测 p99 29 秒）和一次人工编辑，又不至于让垃圾攒太久。取不到时间戳的一律
 * 当「刚碰过」保住——宁可漏删，不可误删。
 *
 * `protectedNames` 是还挂着「结果未知」的那些组名：它们等着人决定发布还是放弃，不能替人
 * 删掉。
 */
export function selectStaleDrafts(
  entries: readonly DraftSketchEntry[],
  options: {
    now: Date;
    minAgeHours?: number;
    protectedNames?: readonly string[];
  },
): StaleDraftSelection {
  const minAgeHours = options.minAgeHours ?? DRAFT_CLEANUP_MIN_AGE_HOURS;
  const cutoff = (options.now.getTime() - minAgeHours * 3_600_000) / 1000;
  const reservedNames = new Set(
    (options.protectedNames ?? []).map((name) => name.trim()).filter(Boolean),
  );
  const stale: DraftSketchEntry[] = [];
  let tooFresh = 0;
  let reserved = 0;
  for (const entry of entries) {
    if (reservedNames.has(entry.adSketchName.trim())) { reserved += 1; continue; }
    // 时间戳缺失 = 不知道多久没动过 = 保住。
    if (entry.touchedAt === null || entry.touchedAt > cutoff) { tooFresh += 1; continue; }
    stale.push(entry);
  }
  return { stale, tooFresh, reserved };
}

export interface SketchSnapMapping {
  /** ad_sketch_id → ad_snap_id */
  adSnapBySketch: Map<string, string>;
  /** creative_sketch_id → creative_snap_id */
  creativeSnapBySketch: Map<string, string>;
}

/** `snap/save_by_sketch` 的响应。这一步是整条链路的关键：有它就不必重建表单。 */
export function parseSketchSnapMapping(payload: unknown): SketchSnapMapping {
  const source = unwrapData(payload);
  return {
    adSnapBySketch: idMapAt(source, "ad_sketch_id_to_snap_id"),
    creativeSnapBySketch: idMapAt(source, "creative_sketch_id_to_snap_id"),
  };
}

/**
 * creative_sketch_id → ad_sketch_id 的归属关系，取自
 * `statistics/sketch/creative/list/`。
 *
 * 为什么必须单独查：`save_by_sketch` 返回的是**该系列下全部** sketch 的映射，
 * `creative_sketch_id_to_snap_id` 不带「属于哪个广告组」的信息。一个系列只有一个草稿时
 * 看不出问题，多个草稿时把别人的创意挂到自己的广告组上，发出去就是一条错的广告。
 */
export function parseDraftCreativeOwners(payload: unknown): Map<string, string> {
  const owners = new Map<string, string>();
  for (const row of tableOf(payload)) {
    const creativeSketchId = idAt(row, "creative_sketch_id");
    const adSketchId = idAt(row, "ad_sketch_id");
    if (creativeSketchId && adSketchId) owners.set(creativeSketchId, adSketchId);
  }
  return owners;
}

export interface DraftSketchPublishCreative {
  creativeSketchId: string;
  creativeSnapId: string;
}

export interface DraftSketchPublishItem {
  adSketchId: string;
  adSnapId: string;
  creatives: DraftSketchPublishCreative[];
}

/**
 * 把匹配到的草稿组装成 `create_by_snap` 的发布报文。
 *
 * 与扩组发布同一个接口，差别只在来源标记和「带 sketch id」。系列走 campaign_id，
 * campaign_snap_id / campaign_sketch_id 一律置空——草稿是挂在已有系列下的。
 */
export function buildDraftPublishPayload(input: {
  campaignId: string;
  items: readonly DraftSketchPublishItem[];
  initialStatus: "enabled" | "disabled";
  riskInfo?: Record<string, unknown>;
}): Record<string, unknown> {
  if (input.items.length === 0) throw new Error("没有可发布的草稿广告组。");
  for (const item of input.items) {
    if (!item.adSketchId || !item.adSnapId) throw new Error("草稿缺少完整的 snap/sketch 标识。");
    if (item.creatives.length === 0) throw new Error("草稿广告组没有可发布的创意。");
    if (item.creatives.some((creative) => !creative.creativeSketchId || !creative.creativeSnapId)) {
      throw new Error("草稿创意缺少完整的 snap/sketch 标识。");
    }
  }
  return {
    campaign_id: input.campaignId,
    campaign_snap_id: "",
    campaign_sketch_id: "",
    ad_and_creative_snap_info_list: input.items.map((item) => ({
      ad_id: "",
      ad_snap_id: item.adSnapId,
      ad_sketch_id: item.adSketchId,
      need_publish: true,
      creative_snap_info_list: item.creatives.map((creative) => ({
        creative_id: "",
        creative_snap_id: creative.creativeSnapId,
        creative_sketch_id: creative.creativeSketchId,
        need_publish: true,
      })),
    })),
    ...TikTokDraftPublishSource,
    is_status_disabled: input.initialStatus === "disabled",
    is_partial_publish: false,
    risk_info: input.riskInfo ?? {},
  };
}

function tableOf(payload: unknown): Array<Record<string, unknown>> {
  const source = unwrapData(payload);
  const table = source.table ?? source.list;
  return Array.isArray(table) ? table.filter(isRecord) : [];
}

function unwrapData(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  return isRecord(payload.data) ? payload.data : payload;
}

function idMapAt(source: Record<string, unknown>, key: string): Map<string, string> {
  const result = new Map<string, string>();
  const value = source[key];
  if (!isRecord(value)) return result;
  for (const [sketchId, snapId] of Object.entries(value)) {
    const from = normalizeId(sketchId);
    const to = normalizeId(snapId);
    if (from && to) result.set(from, to);
  }
  return result;
}

function idAt(row: Record<string, unknown>, key: string): string | undefined {
  return normalizeId(row[key]);
}

/** 秒级 Unix 时间戳里最晚的一个。TikTok 各处字段名不统一，逐个试。 */
function latestTimestamp(row: Record<string, unknown>, keys: readonly string[]): number | null {
  let latest: number | null = null;
  for (const key of keys) {
    const value = row[key];
    const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    if (latest === null || numeric > latest) latest = numeric;
  }
  return latest;
}

/** TikTok 用 "0" 和 "" 表达「没有」，两者都不是可用标识。 */
function normalizeId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return text === "" || text === "0" ? undefined : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
