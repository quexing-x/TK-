import type {
  LineageNode,
  LineageOrigin,
  LineageReport,
  NameCheckResult,
} from "@tk-auto/core";

/**
 * 把本地服务的 JSON 渲染成给 agent 读的文本。
 *
 * 刻意不把原始 JSON 直接丢回去：一个账户的快照有上百条实体、每条十几个字段，整块塞进
 * 上下文既贵又难读，agent 还得自己去猜哪个字段是哪个意思。这里只留决策要用的列，
 * 并且**把判据的可信度写在明面上**——「确证」和「名字像」是两回事，混在一起就会被当成
 * 同一个事实来用。
 */

export interface Account {
  id: string;
  displayName: string;
  platform: string;
  providerKind: string;
  timezone: string;
  enabled: boolean;
}

export interface BootstrapResponse {
  accounts: Account[];
  accountConnectionStates: Array<{
    accountId: string;
    connection: { status: string; message?: string | null } | null;
    latestSync: {
      finishedAt?: string;
      quality?: { status?: string } | null;
      counts?: Record<string, number>;
    } | null;
  }>;
}

export interface EntityRecord {
  entityType: "campaign" | "ad-group" | "ad" | "material";
  externalId: string;
  name: string;
  status: "enabled" | "disabled" | "unknown";
  parentCampaignId: string | null;
  campaignBudget: number | null;
  campaignBudgetOptimized: boolean;
  createdAt?: string | null;
  ignored: boolean;
  metrics: { spend?: number; conversions?: number; clicks?: number; impressions?: number };
}

export interface ExpandClassification {
  externalId: string;
  name: string;
  verdict: "expand" | "recreate-campaign" | "excluded";
  reason: string;
  spend: number;
  conversions: number;
  costPerConversion: number | null;
  days: number | null;
  hasActiveAdGroups: boolean | null;
  consecutiveZeroConversionDays: number;
  recreatedToday: boolean;
}

export interface ExpandClassificationResponse {
  computedAt: string;
  thresholds: {
    maxCostPerConversion: number;
    maxSpendWithoutConversion: number;
    maxConsecutiveZeroConversionDays: number;
  };
  expand: ExpandClassification[];
  recreateCampaign: ExpandClassification[];
  excluded: ExpandClassification[];
}

export interface ExpandSheetPlanResponse {
  accountId: string;
  deliveryAt: string;
  header: string[];
  rows: Array<{
    campaignName: string;
    adGroupName: string;
    videoCode: string;
    productUrl: string;
    ageRanges: string;
    gender: string;
    sourceAdGroupName: string;
    inheritedFrom: string | null;
    missing: string[];
  }>;
  incomplete: Array<{ rowNumber: number; adGroupName: string; missing: string[] }>;
  warnings: string[];
  unresolvedSources: Array<{ sourceAdGroupId: string; reason: string }>;
}

const REASON_LABEL: Record<string, string> = {
  "cost-per-conversion-ok": "单转达标",
  observing: "零转化，累计花费还没到上限",
  "not-started": "还没开始投，一分钱没花",
  "cost-per-conversion-high": "单转超标",
  "no-conversion-overspent": "零转化且已花超上限",
  "no-conversion-stalled": "零转化，且组已被规则关光",
  "no-conversion-days-exceeded": "连续多日零转化",
  "not-enabled": "系列已关停",
  "non-operational": "诊断或占位系列",
};

const ORIGIN_LABEL: Record<LineageOrigin, string> = {
  original: "原组",
  expanded: "扩组产物",
  copied: "复制产物",
  "generated-unknown-source": "软件生成（源头已过期）",
};

const money = (value: number) => value.toFixed(2);

export function formatAccounts(bootstrap: BootstrapResponse): string {
  if (bootstrap.accounts.length === 0) return "本机还没有配置任何广告账户。";
  const states = new Map(
    bootstrap.accountConnectionStates.map((state) => [state.accountId, state]),
  );
  return [
    `共 ${bootstrap.accounts.length} 个账户：`,
    "",
    ...bootstrap.accounts.map((account) => {
      const state = states.get(account.id);
      const sync = state?.latestSync;
      const quality = sync?.quality?.status ?? "无记录";
      const counts = sync?.counts
        ? `系列 ${sync.counts.campaign ?? 0} / 组 ${sync.counts["ad-group"] ?? 0} / 广告 ${sync.counts.ad ?? 0}`
        : "无快照";
      return [
        `- ${account.displayName}（accountId: ${account.id}）`,
        `  平台 ${account.platform} · ${account.providerKind} · 时区 ${account.timezone} · 自动化${account.enabled ? "开" : "关"}`,
        `  连接 ${state?.connection?.status ?? "未配置"} · 同步质量 ${quality} · ${counts}`,
        sync?.finishedAt ? `  最近同步 ${sync.finishedAt}` : "",
      ].filter(Boolean).join("\n");
    }),
  ].join("\n");
}

export function formatCampaigns(
  data: ExpandClassificationResponse,
  filter: "all" | "expand" | "recreate",
): string {
  const line = (item: ExpandClassification) => {
    const cpa = item.costPerConversion === null ? "—" : money(item.costPerConversion);
    const notes = [
      item.hasActiveAdGroups === false ? "无在投组" : "",
      item.consecutiveZeroConversionDays > 0
        ? `连续 ${item.consecutiveZeroConversionDays} 天零转化`
        : "",
      item.recreatedToday ? "今天已重扩过" : "",
    ].filter(Boolean);
    return `- ${item.name}（${item.externalId}）花费 ${money(item.spend)} / 转化 ${item.conversions} / 单转 ${cpa}`
      + ` · ${REASON_LABEL[item.reason] ?? item.reason}`
      + (notes.length > 0 ? ` · ${notes.join("，")}` : "");
  };
  const sections: string[] = [
    `判定阈值：单转上限 ${data.thresholds.maxCostPerConversion}，零转化容忍花费 ${data.thresholds.maxSpendWithoutConversion}，`
    + `连续零转化天数上限 ${data.thresholds.maxConsecutiveZeroConversionDays}。指标为自系列创建以来累计。`,
    "",
  ];
  if (filter !== "recreate") {
    sections.push(`可扩（${data.expand.length}）：`, ...data.expand.map(line), "");
  }
  if (filter !== "expand") {
    sections.push(`建议重扩（${data.recreateCampaign.length}）：`, ...data.recreateCampaign.map(line), "");
  }
  if (filter === "all") {
    sections.push(`不参与判定（${data.excluded.length}）：已关停或诊断系列，此处省略明细。`);
  }
  return sections.join("\n");
}

export function formatAdGroups(
  entities: EntityRecord[],
  lineage: LineageReport,
  filter: { campaignId?: string | undefined; status: "all" | "enabled" | "disabled" },
): string {
  const nodes = new Map<string, LineageNode>();
  for (const brand of lineage.brands) {
    for (const node of brand.adGroups) nodes.set(node.externalId, node);
  }
  const campaignNames = new Map(
    entities.filter((entity) => entity.entityType === "campaign")
      .map((entity) => [entity.externalId, entity.name]),
  );
  const adGroups = entities
    .filter((entity) => entity.entityType === "ad-group")
    .filter((entity) => !filter.campaignId || entity.parentCampaignId === filter.campaignId)
    .filter((entity) => filter.status === "all" || entity.status === filter.status);
  if (adGroups.length === 0) return "没有符合条件的广告组。";
  return [
    `共 ${adGroups.length} 个广告组：`,
    "",
    ...adGroups.map((entity) => {
      const node = nodes.get(entity.externalId);
      const origin = node ? ORIGIN_LABEL[node.origin] : "未知";
      const confidence = node?.confidence === "confirmed" ? "确证" : "推断";
      const source = node?.sourceName ? ` ← ${node.sourceName}` : "";
      const spend = entity.metrics.spend ?? 0;
      const conversions = entity.metrics.conversions ?? 0;
      return [
        `- ${entity.name}（${entity.externalId}）${entity.status === "enabled" ? "投放中" : "已关闭"}`,
        `  系列：${campaignNames.get(entity.parentCampaignId ?? "") ?? entity.parentCampaignId ?? "—"}`,
        `  今日 花费 ${money(spend)} / 转化 ${conversions}`,
        `  来源：${origin}（${confidence}）${source}`,
        entity.ignored ? "  已加入忽略名单" : "",
      ].filter(Boolean).join("\n");
    }),
  ].join("\n");
}

export function formatLineage(report: LineageReport, rootName?: string): string {
  const brands = rootName
    ? report.brands.filter((brand) => brand.rootName === rootName)
    : report.brands;
  if (brands.length === 0) {
    return rootName
      ? `没有根名为「${rootName}」的对象。可以先不带 rootName 看全部品名。`
      : "当前快照里没有可归并的系列或广告组。";
  }
  const nodeLine = (node: LineageNode, indent: string) => {
    const confidence = node.confidence === "confirmed"
      ? (node.matchedBy === "name" ? "确证·按名匹配" : "确证")
      : "推断";
    const chain = node.ancestorIds.length > 1
      ? ` · 链路 ${node.ancestorIds.length} 级`
      : "";
    return `${indent}${node.name}（${node.externalId}）`
      + ` ${node.status === "enabled" ? "投放中" : "已关闭"}`
      + ` · ${ORIGIN_LABEL[node.origin]}（${confidence}）`
      + (node.sourceName ? ` ← ${node.sourceName}` : "")
      + chain
      + (node.uncertain ? " · ⚠ 该批次结果未知" : "");
  };

  const sections = [
    rootName ? `品「${rootName}」：` : `共 ${brands.length} 个品（按根名归并，根名不同即视为不同品）：`,
    "",
  ];
  for (const brand of brands) {
    sections.push(`【${brand.rootName}】`);
    if (brand.campaigns.length > 0) {
      sections.push("  系列：");
      sections.push(...brand.campaigns.map((node) => nodeLine(node, "    - ")));
    }
    if (brand.adGroups.length > 0) {
      sections.push("  广告组：");
      sections.push(...brand.adGroups.map((node) => nodeLine(node, "    - ")));
    }
    sections.push("");
  }

  if (report.duplicateCampaignNames.length > 0) {
    sections.push(
      "⚠ 账户内存在同名推广系列（按名复用时无法判定该并入哪一条，创建会被拒）：",
      ...report.duplicateCampaignNames.map(
        (group) => `- ${group.name}：${group.externalIds.join("、")}`,
      ),
      "",
    );
  }
  if (report.duplicateAdGroupNames.length > 0) {
    sections.push(
      "⚠ 同一系列下存在同名广告组：",
      ...report.duplicateAdGroupNames.map(
        (group) => `- ${group.name}（系列 ${group.parentCampaignId}）：${group.externalIds.join("、")}`,
      ),
      "",
    );
  }
  if (report.uncertainTasks.length > 0) {
    sections.push(
      "⚠ 停在「结果未知」的任务——线上可能已经建出来了，据此起名会撞车，需人工去 TikTok 后台核实：",
      ...report.uncertainTasks.map(
        (task) => `- ${task.kind === "copy" ? "系列复制" : "扩组"} ${task.taskKey}`
          + `（源 ${task.sourceId}，${task.updatedAt}）`
          + (task.generatedNames.length > 0 ? ` 计划名：${task.generatedNames.join("、")}` : ""),
      ),
    );
  }
  return sections.join("\n");
}

export function formatNameChecks(results: NameCheckResult[]): string {
  const label = {
    available: "可用",
    "taken-in-account": "账户内已被占用",
    "duplicate-in-batch": "本批内重复",
  } as const;
  const blocked = results.filter((result) => result.availability !== "available");
  return [
    ...results.map((result) => {
      const kind = result.entityType === "campaign" ? "系列" : "广告组";
      const conflict = result.conflictingIds.length > 0
        ? `（占用者：${result.conflictingIds.join("、")}）`
        : "";
      return `- ${kind}「${result.name}」：${label[result.availability]}${conflict}`;
    }),
    "",
    blocked.length === 0
      ? "全部可用。"
      : `${blocked.length} 个名称不可用；系统不会擅自改名，请调整后重试。`,
  ].join("\n");
}

export function formatExpandHistory(expandTasks: unknown[], copyTasks: unknown[]): string {
  const expand = expandTasks as Array<{
    taskKey: string; sourceAdGroupId: string; status: string; uncertain: boolean;
    updatedAt: string; requestedCount: number; generatedNames: string[]; executorKind: string;
  }>;
  const copy = copyTasks as Array<{
    taskKey: string; sourceCampaignId: string; campaignName: string; status: string;
    uncertain: boolean; updatedAt: string; generatedAdGroupNames: string[];
  }>;
  const sections: string[] = [];
  sections.push(`扩组记录（${expand.length}）：`);
  sections.push(...expand.map((task) =>
    `- ${task.updatedAt} 源组 ${task.sourceAdGroupId} × ${task.requestedCount}`
    + ` · ${task.uncertain ? "⚠ 结果未知" : task.status === "succeeded" ? "成功" : "进行中"}`
    + ` · ${task.executorKind}`
    + (task.generatedNames.length > 0 ? ` · ${task.generatedNames.join("、")}` : "")));
  sections.push("", `系列复制记录（${copy.length}）：`);
  sections.push(...copy.map((task) =>
    `- ${task.updatedAt} 源系列 ${task.campaignName}（${task.sourceCampaignId}）`
    + ` · ${task.uncertain ? "⚠ 结果未知" : task.status === "succeeded" ? "成功" : "进行中"}`
    + (task.generatedAdGroupNames.length > 0 ? ` · ${task.generatedAdGroupNames.join("、")}` : "")));
  const uncertain = expand.filter((task) => task.uncertain).length
    + copy.filter((task) => task.uncertain).length;
  if (uncertain > 0) {
    sections.push(
      "",
      `⚠ 有 ${uncertain} 条停在「结果未知」。这类任务系统永不自动重试——写请求已经发出去了，`
      + "重复提交可能建出两份。请到 TikTok 后台核实真实状态后再处理。",
    );
  }
  return sections.join("\n");
}

export function formatSheetPlan(
  plan: ExpandSheetPlanResponse,
  filePath: string | null,
): string {
  const lines: string[] = [];
  if (filePath) {
    lines.push(`已生成导入表：${filePath}`, "");
  }
  lines.push(
    `账户 ${plan.accountId}，投放时刻 ${plan.deliveryAt}，共 ${plan.rows.length} 行。`,
    "视频代码列留空，需人工补填后在客户端「批量创建」页面导入。",
  );
  const inherited = plan.rows.filter((row) => row.inheritedFrom === "launch-history").length;
  const fromSource = plan.rows.filter((row) => row.inheritedFrom === "source-ad-group").length;
  if (inherited > 0 || fromSource > 0) {
    lines.push(
      `落地页与定向：${inherited} 行沿用历史导入记录`
      + (fromSource > 0 ? `，${fromSource} 行从源广告组现读` : "") + "。",
    );
  }
  if (plan.incomplete.length > 0) {
    lines.push(
      "",
      `⚠ ${plan.incomplete.length} 行还缺字段，导入前必须补：`,
      ...plan.incomplete.slice(0, 20).map(
        (entry) => `- 第 ${entry.rowNumber} 行 ${entry.adGroupName}：${entry.missing.join("、")}`,
      ),
    );
    if (plan.incomplete.length > 20) lines.push(`- …其余 ${plan.incomplete.length - 20} 行同理`);
  }
  if (plan.warnings.length > 0) {
    lines.push("", "⚠ 会阻断创建的问题：", ...plan.warnings.map((warning) => `- ${warning}`));
  }
  if (plan.unresolvedSources.length > 0) {
    lines.push(
      "",
      `⚠ ${plan.unresolvedSources.length} 个源组没能处理：`,
      ...plan.unresolvedSources.map((item) => `- ${item.sourceAdGroupId}：${item.reason}`),
    );
  }
  return lines.join("\n");
}
