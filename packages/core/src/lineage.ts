import { stripGeneratedNameSuffixes } from "./copy-naming.js";
import type { EntityOperationalStatus } from "./decision.js";
import { isNonOperationalCampaignName } from "./expand-classify.js";

/**
 * 谱系：一条系列 / 广告组是原始建的，还是从别的对象扩/复制出来的，源头是谁。
 *
 * 填批量创建表时真正难的不是判断哪条跑得好——那件事 expand-classify 已经做了——而是
 * 在一堆名字相近的对象里认出「哪条是原组、哪条是它重扩出来的、哪条已经废了」。账户里
 * 同一个品常见的样子是：`八寶茶`（人工建的原组）、`八寶茶-0805-143052`（复制出来的）、
 * `八寶茶-0812-091530-1`（在那条上又扩的）。肉眼分不出来，写错就是把新素材上到废组上。
 *
 * 判据分两级，**可信度必须分开标注**，不能混成一个「看起来对」的答案：
 *
 * - **确证**（`confirmed`）：这个 ID 或名字出现在某条复制/扩组任务的产物列表里。源头是
 *   软件自己记下来的，不是猜的。
 * - **推断**（`inferred`）：名字能被 `stripGeneratedNameSuffixes` 剥出后缀，说明是本软件
 *   生成的，但找不到对应任务记录——操作历史只保留 30 天，更早的记录已被清理。知道它是
 *   生成的，但不知道从谁生成。
 *
 * 归并只用**确定性的后缀剥离**。品名模糊归并刻意不做，理由见 expand-classify.ts 的开头
 * 注释：靠名字猜品会把 `DM003142八寶人蔘枸杞茶` / `八寶人蔘枸杞茶` / `八寶茶` 拆成三个品，
 * 猜错的代价比不猜大。根名不同就是不同品，不做二次归并。
 */

/** 这个对象是怎么来的。 */
export type LineageOrigin =
  /** 名字剥不出自动后缀，也不在任何任务的产物列表里——人工建的。 */
  | "original"
  /** 由一键扩组 / 自动扩组建出来的广告组。 */
  | "expanded"
  /** 由系列复制建出来的系列或广告组。 */
  | "copied"
  /** 名字带自动后缀，但找不到任务记录（多半已过 30 天清理期）。 */
  | "generated-unknown-source";

/** 判据可信度。`confirmed` 来自任务记录，`inferred` 来自名字形状。 */
export type LineageConfidence = "confirmed" | "inferred";

/** 确证时，是靠 ID 还是靠名字对上的。 */
export type LineageMatch = "id" | "name";

export interface LineageEntityInput {
  entityType: "campaign" | "ad-group";
  externalId: string;
  name: string;
  status: EntityOperationalStatus;
  /** 广告组所属系列；系列层为 null。 */
  parentCampaignId?: string | null;
  createdAt?: string | null;
}

/** 一条系列复制任务。复制同时产出一条新系列和它下面的广告组，两层都要认。 */
export interface LineageCopyTaskInput {
  taskKey: string;
  sourceCampaignId: string;
  /** 任务记下来的系列名。源系列已被删时，这是唯一还能读到的源名。 */
  campaignName: string;
  generatedCampaignId?: string | null;
  generatedAdGroupIds?: readonly string[];
  generatedAdGroupNames?: readonly string[];
  status: "running" | "succeeded";
  uncertain: boolean;
  updatedAt: string;
}

/** 一条扩组任务。扩组产出的是广告组，不产出系列。 */
export interface LineageExpandTaskInput {
  taskKey: string;
  sourceAdGroupId: string;
  sourceCampaignId?: string | null;
  generatedIds?: readonly string[];
  generatedNames?: readonly string[];
  status: "running" | "succeeded";
  uncertain: boolean;
  updatedAt: string;
  /** `manual-expand` / 自动扩组执行器，用于解释这批是谁发起的。 */
  executorKind?: string;
}

export interface LineageNode {
  entityType: "campaign" | "ad-group";
  externalId: string;
  name: string;
  status: EntityOperationalStatus;
  parentCampaignId: string | null;
  createdAt: string | null;
  /** 剥掉自动后缀后的品根名，同一个品的对象共用它。 */
  rootName: string;
  origin: LineageOrigin;
  confidence: LineageConfidence;
  /** 确证时是靠 ID 还是名字对上的；推断时为 null。 */
  matchedBy: LineageMatch | null;
  /** 直接源对象的 ID。推断和原组为 null。 */
  sourceId: string | null;
  /** 直接源对象的名字。源已被删时取自任务记录。 */
  sourceName: string | null;
  /**
   * 从直接源一路回溯到最远祖先的 ID 链。
   *
   * 链断在哪就到哪为止——源对象已被删、或它自己的任务记录已过期，回溯就停下。
   * 不去补一个「大概是从谁来的」，断了就让它断着，读的人能看出这里没有证据。
   */
  ancestorIds: string[];
  /** 出自哪条任务，方便回查执行记录。 */
  taskKey: string | null;
  /** 这条任务停在「结果未知」——线上到底建没建出来需要人工核实。 */
  uncertain: boolean;
}

export interface LineageBrand {
  /** 品根名。 */
  rootName: string;
  campaigns: LineageNode[];
  adGroups: LineageNode[];
}

export interface DuplicateNameGroup {
  name: string;
  externalIds: string[];
  /** 广告组重名时限定在这个系列内；系列重名为 null。 */
  parentCampaignId: string | null;
}

export interface LineageReport {
  /** 按品根名归并，根名字典序。 */
  brands: LineageBrand[];
  /** 诊断 / 空名 / 名为 `0` 的脏数据，不参与归并。 */
  nonOperational: LineageNode[];
  /** 账户内同名的系列。TikTok 拒重名系列，这份清单是撞名的直接来源。 */
  duplicateCampaignNames: DuplicateNameGroup[];
  /** 同一系列下同名的广告组。 */
  duplicateAdGroupNames: DuplicateNameGroup[];
  /**
   * 停在「结果未知」的任务。
   *
   * 它们的产物**可能已经在线上但没被快照捕获**，据此起名会撞车。所以单独列出来，
   * 而不是混进 brands 里当成普通节点。
   */
  uncertainTasks: Array<{
    taskKey: string;
    kind: "copy" | "expand";
    sourceId: string;
    generatedNames: string[];
    updatedAt: string;
  }>;
}

/** 名字被自动生成过后缀——`八寶茶-0805-143052` 会剥成 `八寶茶`。 */
export function hasGeneratedNameSuffix(name: string): boolean {
  const trimmed = name.trim();
  return trimmed !== "" && stripGeneratedNameSuffixes(trimmed) !== trimmed;
}

/** 品根名：剥掉所有自动后缀后剩下的部分。剥不动就是它自己。 */
export function brandRootName(name: string): string {
  const cleaned = stripGeneratedNameSuffixes(name.trim());
  return cleaned === "" ? name.trim() : cleaned;
}

interface SourceHit {
  origin: Extract<LineageOrigin, "expanded" | "copied">;
  sourceId: string;
  sourceName: string | null;
  taskKey: string;
  matchedBy: LineageMatch;
  uncertain: boolean;
}

/**
 * 建产物 → 源 的反查索引。
 *
 * 同时按 ID 和按名字建索引：任务在发布环节失败或结果未知时，`generatedIds` 可能是空的，
 * 而 `generatedNames` 已经写下了。名字是带秒级时间戳生成的、账户内唯一，对上就是它——
 * 只把 `matchedBy` 记成 `name`，让读的人知道这条是靠名字认的。
 */
function indexTaskOutputs(
  copyTasks: readonly LineageCopyTaskInput[],
  expandTasks: readonly LineageExpandTaskInput[],
): { byId: Map<string, SourceHit>; byName: Map<string, SourceHit> } {
  const byId = new Map<string, SourceHit>();
  const byName = new Map<string, SourceHit>();
  const put = (
    ids: readonly string[],
    names: readonly string[],
    hit: Omit<SourceHit, "matchedBy">,
  ) => {
    for (const id of ids) {
      const key = id.trim();
      // 先写的赢：任务按 updatedAt 倒序传入，最近一次记录最可信。
      if (key && !byId.has(key)) byId.set(key, { ...hit, matchedBy: "id" });
    }
    for (const name of names) {
      const key = name.trim();
      if (key && !byName.has(key)) byName.set(key, { ...hit, matchedBy: "name" });
    }
  };

  for (const task of copyTasks) {
    const campaignIds = task.generatedCampaignId ? [task.generatedCampaignId] : [];
    put(campaignIds, [], {
      origin: "copied",
      sourceId: task.sourceCampaignId,
      sourceName: task.campaignName || null,
      taskKey: task.taskKey,
      uncertain: task.uncertain,
    });
    put(task.generatedAdGroupIds ?? [], task.generatedAdGroupNames ?? [], {
      origin: "copied",
      sourceId: task.sourceCampaignId,
      sourceName: task.campaignName || null,
      taskKey: task.taskKey,
      uncertain: task.uncertain,
    });
  }
  for (const task of expandTasks) {
    put(task.generatedIds ?? [], task.generatedNames ?? [], {
      origin: "expanded",
      sourceId: task.sourceAdGroupId,
      sourceName: null,
      taskKey: task.taskKey,
      uncertain: task.uncertain,
    });
  }
  return { byId, byName };
}

/**
 * 回溯祖先链，遇到环或链断就停。
 *
 * 环理论上不该出现（源永远早于产物），但索引是按名字兜底匹配的，一次误配就能造出环，
 * 而环会让这里死循环。见到重复 ID 立刻停，宁可少一截也不能挂住。
 */
function traceAncestors(
  startSourceId: string,
  sourceOf: Map<string, string>,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = startSourceId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    cursor = sourceOf.get(cursor);
  }
  return chain;
}

function duplicatesOf(
  nodes: readonly LineageNode[],
  scoped: boolean,
): DuplicateNameGroup[] {
  const buckets = new Map<string, { group: DuplicateNameGroup }>();
  for (const node of nodes) {
    const name = node.name.trim();
    if (!name) continue;
    const parent = scoped ? node.parentCampaignId : null;
    const key = `${parent ?? ""}::${name}`;
    const existing = buckets.get(key);
    if (existing) existing.group.externalIds.push(node.externalId);
    else {
      buckets.set(key, {
        group: { name, parentCampaignId: parent, externalIds: [node.externalId] },
      });
    }
  }
  return [...buckets.values()]
    .map((entry) => entry.group)
    .filter((group) => group.externalIds.length > 1)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export interface LineageInput {
  entities: readonly LineageEntityInput[];
  /** 系列复制任务，按 updatedAt 倒序。 */
  copyTasks?: readonly LineageCopyTaskInput[];
  /** 扩组任务，按 updatedAt 倒序。 */
  expandTasks?: readonly LineageExpandTaskInput[];
}

export function buildLineageReport(input: LineageInput): LineageReport {
  const copyTasks = input.copyTasks ?? [];
  const expandTasks = input.expandTasks ?? [];
  const { byId, byName } = indexTaskOutputs(copyTasks, expandTasks);
  const nameOf = new Map<string, string>();
  for (const entity of input.entities) nameOf.set(entity.externalId, entity.name);

  // 先把每个对象的直接源定下来，再统一回溯——回溯需要看到全图。
  const sourceOf = new Map<string, string>();
  const hits = new Map<string, SourceHit>();
  for (const entity of input.entities) {
    const hit = byId.get(entity.externalId) ?? byName.get(entity.name.trim());
    if (!hit) continue;
    // 自己指向自己是脏数据（名字兜底匹配到源自己身上），当作没匹配上。
    if (hit.sourceId === entity.externalId) continue;
    hits.set(entity.externalId, hit);
    sourceOf.set(entity.externalId, hit.sourceId);
  }

  const nodes: LineageNode[] = input.entities.map((entity) => {
    const hit = hits.get(entity.externalId);
    const base = {
      entityType: entity.entityType,
      externalId: entity.externalId,
      name: entity.name,
      status: entity.status,
      parentCampaignId: entity.parentCampaignId ?? null,
      createdAt: entity.createdAt ?? null,
      rootName: brandRootName(entity.name),
    };
    if (hit) {
      return {
        ...base,
        origin: hit.origin,
        confidence: "confirmed" as const,
        matchedBy: hit.matchedBy,
        sourceId: hit.sourceId,
        sourceName: nameOf.get(hit.sourceId) ?? hit.sourceName,
        ancestorIds: traceAncestors(hit.sourceId, sourceOf),
        taskKey: hit.taskKey,
        uncertain: hit.uncertain,
      };
    }
    // 没有任务记录：只能看名字。带自动后缀说明是软件生成的，但源头已无从查证。
    const generated = hasGeneratedNameSuffix(entity.name);
    return {
      ...base,
      origin: generated ? ("generated-unknown-source" as const) : ("original" as const),
      confidence: "inferred" as const,
      matchedBy: null,
      sourceId: null,
      sourceName: null,
      ancestorIds: [],
      taskKey: null,
      uncertain: false,
    };
  });

  const nonOperational = nodes.filter(
    (node) => node.entityType === "campaign" && isNonOperationalCampaignName(node.name),
  );
  const nonOperationalIds = new Set(nonOperational.map((node) => node.externalId));
  const operational = nodes.filter((node) => !nonOperationalIds.has(node.externalId));

  const brandMap = new Map<string, LineageBrand>();
  for (const node of operational) {
    let brand = brandMap.get(node.rootName);
    if (!brand) {
      brand = { rootName: node.rootName, campaigns: [], adGroups: [] };
      brandMap.set(node.rootName, brand);
    }
    if (node.entityType === "campaign") brand.campaigns.push(node);
    else brand.adGroups.push(node);
  }

  // 每个品内按「原组在前，然后按创建时间」排：读的人第一眼要看到的是源头。
  const byGeneration = (left: LineageNode, right: LineageNode) => {
    const rank = (node: LineageNode) => (node.origin === "original" ? 0 : 1);
    if (rank(left) !== rank(right)) return rank(left) - rank(right);
    const leftAt = left.createdAt ?? "";
    const rightAt = right.createdAt ?? "";
    if (leftAt !== rightAt) return leftAt.localeCompare(rightAt);
    return left.name.localeCompare(right.name);
  };
  const brands = [...brandMap.values()]
    .map((brand) => ({
      rootName: brand.rootName,
      campaigns: [...brand.campaigns].sort(byGeneration),
      adGroups: [...brand.adGroups].sort(byGeneration),
    }))
    .sort((left, right) => left.rootName.localeCompare(right.rootName));

  const campaigns = nodes.filter((node) => node.entityType === "campaign");
  const adGroups = nodes.filter((node) => node.entityType === "ad-group");

  const uncertainTasks = [
    ...copyTasks.filter((task) => task.uncertain).map((task) => ({
      taskKey: task.taskKey,
      kind: "copy" as const,
      sourceId: task.sourceCampaignId,
      generatedNames: [...(task.generatedAdGroupNames ?? [])],
      updatedAt: task.updatedAt,
    })),
    ...expandTasks.filter((task) => task.uncertain).map((task) => ({
      taskKey: task.taskKey,
      kind: "expand" as const,
      sourceId: task.sourceAdGroupId,
      generatedNames: [...(task.generatedNames ?? [])],
      updatedAt: task.updatedAt,
    })),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return {
    brands,
    nonOperational,
    duplicateCampaignNames: duplicatesOf(campaigns, false),
    duplicateAdGroupNames: duplicatesOf(adGroups, true),
    uncertainTasks,
  };
}

/**
 * 账户内已被占用的名字。
 *
 * 三个来源缺一不可：
 * - 当前快照里的对象——最明显的一类。
 * - **任务记录里的产物名**：刚建好、还没被同步捕获的对象在快照里查不到，但名字已经在
 *   线上占住了。只看快照会把它误判成可用，发布时才被 TikTok 判重名。
 * - 结果未知的任务的产物名：可能已经建出来了，同样不能再用。
 */
export function collectReservedNames(input: LineageInput): {
  campaignNames: Set<string>;
  adGroupNames: Set<string>;
} {
  const campaignNames = new Set<string>();
  const adGroupNames = new Set<string>();
  for (const entity of input.entities) {
    const name = entity.name.trim();
    if (!name) continue;
    if (entity.entityType === "campaign") campaignNames.add(name);
    else adGroupNames.add(name);
  }
  for (const task of input.copyTasks ?? []) {
    for (const name of task.generatedAdGroupNames ?? []) {
      const trimmed = name.trim();
      if (trimmed) adGroupNames.add(trimmed);
    }
  }
  for (const task of input.expandTasks ?? []) {
    for (const name of task.generatedNames ?? []) {
      const trimmed = name.trim();
      if (trimmed) adGroupNames.add(trimmed);
    }
  }
  return { campaignNames, adGroupNames };
}

export type NameAvailability = "available" | "taken-in-account" | "duplicate-in-batch";

export interface NameCheckResult {
  name: string;
  entityType: "campaign" | "ad-group";
  availability: NameAvailability;
  /** 被谁占了。账户内已存在时给出对象 ID，批内自撞时为 null。 */
  conflictingIds: string[];
}

/**
 * 逐个检查一批打算使用的名字。
 *
 * 这道检查存在的理由很具体：撞名在建草稿那步不报错，到发布那步才被 TikTok 拒，
 * 后台会留下一个草稿、本地记一条「结果未知」。必须在发出去之前就拦住。
 */
export function checkNames(
  input: LineageInput,
  wanted: ReadonlyArray<{ name: string; entityType: "campaign" | "ad-group" }>,
): NameCheckResult[] {
  const reserved = collectReservedNames(input);
  const idsByName = new Map<string, string[]>();
  for (const entity of input.entities) {
    const key = `${entity.entityType}::${entity.name.trim()}`;
    idsByName.set(key, [...(idsByName.get(key) ?? []), entity.externalId]);
  }
  const seenInBatch = new Set<string>();
  return wanted.map((item) => {
    const name = item.name.trim();
    const key = `${item.entityType}::${name}`;
    const pool = item.entityType === "campaign"
      ? reserved.campaignNames
      : reserved.adGroupNames;
    if (seenInBatch.has(key)) {
      return {
        name,
        entityType: item.entityType,
        availability: "duplicate-in-batch" as const,
        conflictingIds: [],
      };
    }
    seenInBatch.add(key);
    if (pool.has(name)) {
      return {
        name,
        entityType: item.entityType,
        availability: "taken-in-account" as const,
        conflictingIds: idsByName.get(key) ?? [],
      };
    }
    return {
      name,
      entityType: item.entityType,
      availability: "available" as const,
      conflictingIds: [],
    };
  });
}
