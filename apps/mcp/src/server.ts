#!/usr/bin/env node
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { checkNames, type LineageReport } from "@tk-auto/core";
import { LocalApiClient, LocalApiError } from "./api-client.js";
import {
  defaultExportDirectory,
  markdownPreview,
  safeFileNamePart,
  writeExpandSheet,
  type SheetRow,
} from "./sheet.js";
import {
  formatAccounts,
  formatAdGroups,
  formatCampaigns,
  formatExpandHistory,
  formatLineage,
  formatNameChecks,
  formatSheetPlan,
  type Account,
  type BootstrapResponse,
  type EntityRecord,
  type ExpandClassificationResponse,
  type ExpandSheetPlanResponse,
} from "./format.js";

const api = new LocalApiClient();

/** 工具回调的统一出口：把本地服务的错误原样讲清楚，而不是抛一个空的 isError。 */
async function run(handler: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await handler() }] };
  } catch (cause) {
    const message = cause instanceof LocalApiError
      ? cause.message
      : cause instanceof Error
        ? cause.message
        : "本地服务调用失败。";
    return { content: [{ type: "text" as const, text: `失败：${message}` }], isError: true };
  }
}

const server = new McpServer(
  { name: "tk-ads-automation", version: "1.0.0" },
  {
    instructions: [
      "TK 自动化本地助手。用来读账户快照、判断广告组谱系、生成扩组导入表，以及执行扩组和系列复制。",
      "",
      "先用 list_accounts 拿到 accountId，其余工具都要它。",
      "分不清「哪条是原组、哪条是重扩出来的」时用 campaign_lineage：它按品根名把一个品的原组和历次重扩链串起来，",
      "并标出账户内的重名对象——重名是创建被 TikTok 拒的首要原因。",
      "",
      "扩组和系列复制会真实花钱。两个写工具默认只做预演（dryRun），必须由用户明确说要执行，才带 confirm=true 再调一次。",
      "不要替用户决定 confirm。",
    ].join("\n"),
  },
);

server.registerTool("list_accounts", {
  title: "列出广告账户",
  description: "列出本机管理的广告账户：ID、平台、时区、自动化开关、最近一次同步是否健康。其余工具都要用这里的 accountId。",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => run(async () => {
  const bootstrap = await api.get<BootstrapResponse>("/api/bootstrap");
  return formatAccounts(bootstrap);
}));

server.registerTool("list_campaigns", {
  title: "系列现状与扩组判定",
  description: [
    "列出一个账户的推广系列现状：累计花费、转化、单转，以及扩组判定（可扩 / 建议重扩 / 已关停）。",
    "指标口径是自系列创建以来累计，按账户时区日切。",
    "系列级判定只覆盖在投系列；已关停的不参与判定，要用 verdict=\"stopped\" 单独取明细。",
    "判某个品「现在还在不在跑、要不要重建一条」时必须取它——一个品的历史系列绝大多数是已关停的，",
    "只看在投系列会把整个品当成不存在。",
  ].join(""),
  inputSchema: {
    accountId: z.string().min(1).describe("账户 ID，来自 list_accounts"),
    verdict: z.enum(["all", "expand", "recreate", "stopped"]).default("all")
      .describe(
        "只看某一类：expand 可扩、recreate 建议重扩、stopped 已关停系列明细（按累计花费降序）；"
        + "默认 all 只给可扩与建议重扩两栏，已关停仅报条数",
      ),
  },
  annotations: { readOnlyHint: true },
}, async ({ accountId, verdict }) => run(async () => {
  const data = await api.get<ExpandClassificationResponse>(
    `/api/accounts/${encodeURIComponent(accountId)}/expand-classification`,
  );
  return formatCampaigns(data, verdict);
}));

server.registerTool("list_ad_groups", {
  title: "广告组现状与来源",
  description: [
    "列出广告组：状态、预算、当日指标、创建时间，以及它是原组还是扩/复制出来的、源组是谁。",
    "可按所属系列过滤。",
  ].join(""),
  inputSchema: {
    accountId: z.string().min(1).describe("账户 ID"),
    campaignId: z.string().min(1).optional().describe("只看这条系列下的广告组"),
    status: z.enum(["all", "enabled", "disabled"]).default("all"),
  },
  annotations: { readOnlyHint: true },
}, async ({ accountId, campaignId, status }) => run(async () => {
  const [entities, lineage] = await Promise.all([
    api.get<EntityRecord[]>(`/api/accounts/${encodeURIComponent(accountId)}/entities`),
    api.get<LineageReport>(`/api/accounts/${encodeURIComponent(accountId)}/lineage`),
  ]);
  return formatAdGroups(entities, lineage, { campaignId, status });
}));

server.registerTool("campaign_lineage", {
  title: "谱系：原组与重扩链",
  description: [
    "按品根名把一个账户里的对象归并成「原组 → 历次重扩链」，并列出账户内的重名系列 / 重名广告组、",
    "以及停在「结果未知」的任务。判据分两级：确证（来自复制/扩组任务记录）与推断（只看名字形状）。",
    "填导入表前先看这个，能避免把素材上到已经废掉的组上。",
  ].join(""),
  inputSchema: {
    accountId: z.string().min(1).describe("账户 ID"),
    rootName: z.string().min(1).optional().describe("只看某个品，填品根名（例如「八寶茶」）"),
  },
  annotations: { readOnlyHint: true },
}, async ({ accountId, rootName }) => run(async () => {
  const report = await api.get<LineageReport>(
    `/api/accounts/${encodeURIComponent(accountId)}/lineage`,
  );
  return formatLineage(report, rootName);
}));

server.registerTool("check_names", {
  title: "查名称是否可用",
  description: [
    "检查一批打算使用的系列名 / 广告组名：账户内是否已被占用、本批内是否自撞。",
    "已占用的判据包含还没被同步捕获、但任务记录里已经写下的名字——只看快照会漏掉刚建好的对象。",
  ].join(""),
  inputSchema: {
    accountId: z.string().min(1).describe("账户 ID"),
    campaignNames: z.array(z.string().min(1)).max(500).default([]),
    adGroupNames: z.array(z.string().min(1)).max(500).default([]),
  },
  annotations: { readOnlyHint: true },
}, async ({ accountId, campaignNames, adGroupNames }) => run(async () => {
  const report = await api.get<LineageReport & {
    entities?: never;
  }>(`/api/accounts/${encodeURIComponent(accountId)}/lineage`);
  const entities = [
    ...report.brands.flatMap((brand) => [...brand.campaigns, ...brand.adGroups]),
    ...report.nonOperational,
  ].map((node) => ({
    entityType: node.entityType,
    externalId: node.externalId,
    name: node.name,
    status: node.status,
    parentCampaignId: node.parentCampaignId,
  }));
  const results = checkNames({ entities }, [
    ...campaignNames.map((name) => ({ name, entityType: "campaign" as const })),
    ...adGroupNames.map((name) => ({ name, entityType: "ad-group" as const })),
  ]);
  return formatNameChecks(results);
}));

server.registerTool("list_expand_history", {
  title: "扩组与复制记录",
  description: "最近的扩组与系列复制记录，含停在「结果未知」的任务（那些必须人工去 TikTok 后台核实，系统不会自动重试）。",
  inputSchema: {
    accountId: z.string().min(1).describe("账户 ID"),
    limit: z.number().int().min(1).max(200).default(30),
  },
  annotations: { readOnlyHint: true },
}, async ({ accountId, limit }) => run(async () => {
  const id = encodeURIComponent(accountId);
  const [expand, copy] = await Promise.all([
    api.get<{ tasks: unknown[] }>(`/api/ad-group-expand-tasks?accountIds=${id}&limit=${limit}`),
    api.get<{ tasks: unknown[] }>(`/api/campaign-copy-history?accountIds=${id}&limit=${limit}`),
  ]);
  return formatExpandHistory(expand.tasks, copy.tasks);
}));

server.registerTool("build_expand_sheet", {
  title: "生成扩组导入表",
  description: [
    "给指定的源广告组生成一张批量创建导入表（.xlsx）并落盘：系列名、广告组名按扩组的同一套命名规则算好且避开已占用名称，",
    "产品 URL / 年龄 / 性别沿用同一个品上次填的值，**视频代码留空**由人补。",
    "只生成文件，不创建任何广告对象、也不占用名称。",
  ].join(""),
  inputSchema: {
    accountId: z.string().min(1).describe("账户 ID"),
    sourceAdGroupIds: z.array(z.string().min(1)).min(1).max(200)
      .describe("源广告组 ID，来自 list_ad_groups"),
    countPerSource: z.number().int().min(1).max(10).default(1)
      .describe("每个源组扩几份"),
    sameCampaign: z.boolean().default(true)
      .describe("true=新组加进源组所在的系列；false=每个源组另起一条新系列"),
    scheduledStartAt: z.string().datetime().nullable().default(null)
      .describe("投放时刻（ISO 时间）。名字里的日期时间后缀取它；不填按当前时间"),
    readSourceAdGroups: z.boolean().default(false)
      .describe("历史记录里查不到落地页时，是否去 TikTok 上现读源广告组。会变慢，默认不读"),
    outputPath: z.string().min(1).optional()
      .describe("输出文件的完整路径；不填则写到下载目录"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async (input) => run(async () => {
  const plan = await api.post<ExpandSheetPlanResponse>(
    `/api/accounts/${encodeURIComponent(input.accountId)}/expand-sheet/plan`,
    {
      sourceAdGroupIds: input.sourceAdGroupIds,
      countPerSource: input.countPerSource,
      sameCampaign: input.sameCampaign,
      scheduledStartAt: input.scheduledStartAt,
      readSourceAdGroups: input.readSourceAdGroups,
    },
  );
  if (plan.rows.length === 0) {
    return formatSheetPlan(plan, null);
  }
  const rows: SheetRow[] = plan.rows.map((row) => ({
    campaignName: row.campaignName,
    adGroupName: row.adGroupName,
    videoCode: row.videoCode,
    productUrl: row.productUrl,
    ageRanges: row.ageRanges,
    gender: row.gender,
  }));
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const filePath = input.outputPath ?? join(
    defaultExportDirectory(),
    `扩组导入表-${safeFileNamePart(input.accountId)}-${stamp}.xlsx`,
  );
  await writeExpandSheet({
    header: plan.header,
    rows,
    filePath,
    note: `源广告组 ${input.sourceAdGroupIds.length} 个，每个扩 ${input.countPerSource} 份。`,
  });
  return [
    formatSheetPlan(plan, filePath),
    "",
    markdownPreview(plan.header, rows),
  ].join("\n");
}));

server.registerTool("expand_ad_groups", {
  title: "扩组（复制广告组）",
  description: [
    "把选中的广告组各复制 N 份。**默认只做预演**：返回将要创建的内容和冲突检查结果，不发出任何写请求。",
    "用户明确要求执行后，才带 confirm=true 再调一次。这一步会真实花钱。",
  ].join(""),
  inputSchema: {
    accountId: z.string().min(1).describe("账户 ID"),
    sourceAdGroupIds: z.array(z.string().min(1)).min(1).max(200)
      .describe("源广告组 ID"),
    count: z.number().int().min(1).max(10).describe("每个源组扩几份"),
    dailyBudget: z.number().positive().describe("新广告组的日预算"),
    bid: z.number().nonnegative().nullable().default(null).describe("出价；不填按 null"),
    launchImmediately: z.boolean().default(false).describe("是否立即投放"),
    sameCampaign: z.boolean().default(true).describe("true=挂回源系列；false=新建系列"),
    scheduledStartAt: z.string().datetime().nullable().default(null).describe("定时投放时刻"),
    confirm: z.boolean().default(false)
      .describe("true 才真正创建。必须由用户明确同意后才可传 true"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, async (input) => run(async () => {
  const sources = await resolveExpandSources(input.accountId, input.sourceAdGroupIds);
  const preflight = await api.post<{ conflicts: unknown[] }>(
    "/api/ad-groups/batch-expand/preflight",
    { sources, scheduledStartAt: input.scheduledStartAt },
  );
  if (!input.confirm) {
    return [
      "【预演，未创建任何对象】",
      `账户 ${input.accountId}：${sources.length} 个源组 × ${input.count} 份 = ${sources.length * input.count} 个新广告组`,
      `日预算 ${input.dailyBudget}${input.bid === null ? "" : `，出价 ${input.bid}`}`,
      input.sameCampaign ? "挂回各自的源系列" : "为每个源组新建系列",
      input.scheduledStartAt ? `定时投放：${input.scheduledStartAt}` : (input.launchImmediately ? "立即投放" : "创建后保持关闭"),
      "",
      "源组：",
      ...sources.map((source) => `- ${source.sourceAdGroupName}（系列：${source.sourceCampaignName}）`),
      "",
      formatConflicts(preflight.conflicts),
      "",
      "确认无误后，让我带 confirm=true 再执行一次。",
    ].join("\n");
  }
  const result = await api.post<WriteOutcome>(
    "/api/ad-groups/batch-expand",
    {
      sources,
      count: input.count,
      dailyBudget: input.dailyBudget,
      bid: input.bid,
      launchImmediately: input.launchImmediately,
      sameCampaign: input.sameCampaign,
      scheduledStartAt: input.scheduledStartAt,
    },
  );
  return formatWriteResult("扩组", result);
}));

server.registerTool("copy_campaign", {
  title: "系列复制",
  description: [
    "把一条推广系列复制成 N 条新系列，每条新系列放 M 个广告组。**默认只做预演**，不发出写请求。",
    "系列预算(CBO)的放量路径——往同一个 CBO 系列里加组只会摊薄预算，复制成新系列才是真放量。",
    "用户明确要求执行后，才带 confirm=true。这一步会真实花钱。",
  ].join(""),
  inputSchema: {
    accountId: z.string().min(1).describe("账户 ID"),
    sources: z.array(z.object({
      sourceCampaignId: z.string().min(1),
      sourceAdGroupIds: z.array(z.string().min(1)).min(1).max(50)
        .describe("这条系列里作为模板的广告组"),
    })).min(1).max(200),
    campaignCopies: z.number().int().min(1).max(20).describe("每个源系列复制成几条"),
    groupsPerCampaign: z.number().int().min(1).max(20).describe("每条新系列放几个广告组"),
    initialStatus: z.enum(["enabled", "disabled"]).default("disabled"),
    scheduledStartAt: z.string().datetime().nullable().default(null),
    campaignBudget: z.number().positive().nullable().default(null).describe("系列日预算(CBO)"),
    adGroupBudget: z.number().positive().nullable().default(null).describe("广告组日预算"),
    bid: z.number().nonnegative().nullable().default(null),
    confirm: z.boolean().default(false)
      .describe("true 才真正创建。必须由用户明确同意后才可传 true"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, async (input) => run(async () => {
  const total = input.sources.length * input.campaignCopies;
  if (!input.confirm) {
    return [
      "【预演，未创建任何对象】",
      `账户 ${input.accountId}：${input.sources.length} 个源系列 × ${input.campaignCopies} 条 = ${total} 条新系列`,
      `每条新系列放 ${input.groupsPerCampaign} 个广告组，合计 ${total * input.groupsPerCampaign} 个组`,
      input.campaignBudget === null ? "" : `系列日预算 ${input.campaignBudget}`,
      input.adGroupBudget === null ? "" : `广告组日预算 ${input.adGroupBudget}`,
      `初始状态：${input.initialStatus === "enabled" ? "开启" : "关闭"}`,
      input.scheduledStartAt ? `定时投放：${input.scheduledStartAt}` : "",
      "",
      "新系列的名称由软件按「源系列名-投放日期-时间」生成，不会与账户内现有名称冲突。",
      "确认无误后，让我带 confirm=true 再执行一次。",
    ].filter(Boolean).join("\n");
  }
  const result = await api.post<WriteOutcome>(
    "/api/campaigns/copy",
    {
      accountId: input.accountId,
      sources: input.sources,
      campaignCopies: input.campaignCopies,
      groupsPerCampaign: input.groupsPerCampaign,
      initialStatus: input.initialStatus,
      scheduledStartAt: input.scheduledStartAt,
      campaignBudget: input.campaignBudget,
      adGroupBudget: input.adGroupBudget,
      bid: input.bid,
    },
  );
  return formatWriteResult("系列复制", result);
}));

/**
 * 补齐扩组接口要的源组信息。
 *
 * 接口要名称和所属系列，但让调用方（agent）自己抄一遍等于给它一个抄错的机会——
 * 名字错了就是扩到别的组上。这里一律从快照回查。
 */
async function resolveExpandSources(
  accountId: string,
  sourceAdGroupIds: string[],
): Promise<Array<{
  accountId: string;
  sourceCampaignId: string;
  sourceCampaignName: string;
  sourceAdGroupId: string;
  sourceAdGroupName: string;
}>> {
  const entities = await api.get<EntityRecord[]>(
    `/api/accounts/${encodeURIComponent(accountId)}/entities`,
  );
  const campaigns = new Map(
    entities.filter((entity) => entity.entityType === "campaign")
      .map((entity) => [entity.externalId, entity.name]),
  );
  const sources = [];
  const missing: string[] = [];
  for (const id of [...new Set(sourceAdGroupIds)]) {
    const adGroup = entities.find(
      (entity) => entity.entityType === "ad-group" && entity.externalId === id,
    );
    const campaignName = adGroup?.parentCampaignId
      ? campaigns.get(adGroup.parentCampaignId)
      : undefined;
    if (!adGroup?.parentCampaignId || campaignName === undefined) {
      missing.push(id);
      continue;
    }
    sources.push({
      accountId,
      sourceCampaignId: adGroup.parentCampaignId,
      sourceCampaignName: campaignName,
      sourceAdGroupId: adGroup.externalId,
      sourceAdGroupName: adGroup.name,
    });
  }
  if (missing.length > 0) {
    throw new Error(
      `这些广告组不在当前同步快照里，或缺少所属系列：${missing.join("、")}。请先同步账户。`,
    );
  }
  return sources;
}

function formatConflicts(conflicts: unknown[]): string {
  const rows = conflicts as Array<{
    sourceAdGroupName: string;
    inProgress: { kind: string; since: string } | null;
    expandedToday: { batches: number; groups: number } | null;
    existingNames: string[];
  }>;
  const noted = rows.filter(
    (row) => row.inProgress || row.expandedToday || row.existingNames.length > 0,
  );
  if (noted.length === 0) return "冲突检查：没有发现进行中的批次、今日重复扩组或重名。";
  return [
    "冲突检查：",
    ...noted.map((row) => {
      const notes = [
        row.inProgress ? `有批次进行中（${row.inProgress.kind}，自 ${row.inProgress.since}）` : "",
        row.expandedToday ? `今天已扩过 ${row.expandedToday.batches} 批 / ${row.expandedToday.groups} 个组` : "",
        row.existingNames.length > 0 ? `同名已存在：${row.existingNames.join("、")}` : "",
      ].filter(Boolean);
      return `- ${row.sourceAdGroupName}：${notes.join("；")}`;
    }),
  ].join("\n");
}

/** 扩组与系列复制共用的执行结果结构。 */
interface WriteOutcome {
  createdCampaigns?: number;
  createdGroups?: number;
  scheduled?: number;
  skipped?: number;
  failed?: Array<{ name: string; message: string }>;
}

/**
 * 讲清楚这次到底建出了什么。
 *
 * `skipped` 必须单独说，不能并进成功数：它是幂等闸门命中——同一个源今天已经扩过、
 * 或上一批还停在「结果未知」。把它读成「成功」会让人以为新组建出来了，进而在下一轮
 * 又扩一遍。全零也要明说，否则一句「成功 0 条，失败 0 条」看起来像什么都没发生。
 */
function formatWriteResult(action: string, outcome: WriteOutcome): string {
  const campaigns = outcome.createdCampaigns ?? 0;
  const groups = outcome.createdGroups ?? 0;
  const skipped = outcome.skipped ?? 0;
  const scheduled = outcome.scheduled ?? 0;
  const failed = outcome.failed ?? [];
  const created = [
    campaigns > 0 ? `新建系列 ${campaigns} 条` : "",
    `新建广告组 ${groups} 个`,
    scheduled > 0 ? `其中定时排期 ${scheduled} 个` : "",
  ].filter(Boolean).join("，");

  const lines = [`${action}结果：${created}。`];
  if (skipped > 0) {
    lines.push(
      `跳过 ${skipped} 个：幂等闸门命中——同一个源今天已经扩过，或上一批还停在「结果未知」。`
      + "这不是成功，也不是失败，是软件刻意没有重复下单。",
    );
  }
  if (failed.length > 0) {
    lines.push("", `失败 ${failed.length} 个：`, ...failed.map(
      (item) => `- ${item.name}：${item.message}`,
    ));
    // 只在真有「结果未知」时才提重试禁令。对「账户未通过连接检测」这类明确失败
    // （写请求根本没发出去）说这段话是误导，会让人以为线上可能已经建了东西。
    if (failed.some((item) => item.message.includes("待确认") || item.message.includes("待人工确认"))) {
      lines.push(
        "",
        "带「结果待确认」的那几条绝不会被自动重试——写请求已经发出去但没拿到确认，重复提交可能建出两份。"
        + "请到 TikTok 后台核实真实状态后再决定。",
      );
    }
  }
  if (groups === 0 && campaigns === 0 && failed.length === 0 && skipped === 0) {
    lines.push(
      "",
      "一个对象都没有创建，也没有报错。多半是源组没有通过前置校验（账户未通过连接检测、缺少复制能力授权等）；"
      + "请在客户端确认该账户的连接状态。",
    );
  }
  return lines.join("\n");
}

// stdout 是 MCP 的协议通道，任何多余输出都会让客户端解析失败。诊断信息一律走 stderr。
async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((cause: unknown) => {
  process.stderr.write(
    `TK 自动化 MCP 启动失败：${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exit(1);
});
