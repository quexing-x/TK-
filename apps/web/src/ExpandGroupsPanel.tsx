import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, CopyPlus, History, Inbox, Info, RefreshCcw, Trash2, XCircle } from "lucide-react";
import { DRAFT_CLEANUP_MIN_AGE_HOURS, withinExpandScope, type ExpandScope } from "@tk-auto/core";
import type {
  AccountConfig,
  AccountProviderCapabilities,
  ExpandClassification,
  ManagedEntityRecord,
  ProviderConnection,
  ReadOnlySyncResult,
} from "@tk-auto/core";
import { api, type AdGroupExpandTask, type ExpandClassificationResponse } from "./api";
import { accountAccessStatus } from "./provider-capability-view";
import { useOverlays } from "./ui/overlays";

type ConnectionState = {
  accountId: string;
  connection: ProviderConnection | null;
  latestSync: ReadOnlySyncResult | null;
  capabilities: AccountProviderCapabilities;
};


type ConversionFilter = "all" | "has" | "none";
type StatusFilter = "all" | "enabled" | "disabled";
/**
 * 按所属系列的扩组判定过滤。默认 `expand`——每天开这个页面就是来挑今天能扩的，
 * 默认摊开全部等于让人自己在几十条里挑，判定就白做了。切到 `all` 随时能看全。
 */
type VerdictFilter = "all" | "expand" | "recreate";

/** 判定文案集中在这里，表头、徽标、汇总条共用一套说法，避免三处各叫各的。 */
export const VERDICT_LABELS: Record<string, { short: string; tone: string; hint: string }> = {
  "cost-per-conversion-ok": { short: "可扩", tone: "active", hint: "单转达标" },
  observing: { short: "观察中", tone: "active", hint: "零转化，累计花费还没到上限" },
  "cost-per-conversion-high": { short: "重扩系列", tone: "warning", hint: "单转超标" },
  "no-conversion-overspent": { short: "重扩系列", tone: "warning", hint: "零转化且已花超上限" },
  "no-conversion-stalled": { short: "重扩系列", tone: "warning", hint: "零转化，且组已被规则关光" },
  "no-conversion-days-exceeded": { short: "重扩系列", tone: "warning", hint: "连续多日零转化" },
  "not-enabled": { short: "已关停", tone: "muted", hint: "系列已关停，不参与判定" },
  "non-operational": { short: "非投放", tone: "muted", hint: "诊断或占位系列" },
};

/**
 * 这个广告组该不该出现在当前的「系列判定」筛选下。
 *
 * 判定缺失时一律放行——分类接口挂了、或这条系列不在分类结果里（刚建、超出保留期），
 * 都不该让列表凭空变空：空列表会被读成「今天没得扩」，而真相是「判定没算出来」，
 * 这两件事的后果差得很远。
 */
export function matchesVerdictFilter(
  filter: VerdictFilter,
  verdict: ExpandClassification["verdict"] | null,
): boolean {
  if (filter === "all") return true;
  if (!verdict) return true;
  return filter === "expand" ? verdict === "expand" : verdict === "recreate-campaign";
}

type Feedback = { tone: "success" | "danger"; title: string; lines: string[] } | null;

const keyOf = (accountId: string, externalId: string) => `${accountId}::${externalId}`;

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "操作失败。";
}

function fmtMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

// 未来最近的 06:00（本地时区），返回 datetime-local 可用的 "YYYY-MM-DDTHH:mm"。
// 现在是 00:10 就给今天早上 06:00；已经过了 06:00 才顺延到次日。
function defaultNextSixOClock(): string {
  const date = new Date();
  date.setHours(6, 0, 0, 0);
  if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type ExpandConflict = {
  accountId: string;
  sourceAdGroupId: string;
  sourceAdGroupName: string;
  inProgress: { kind: "running" | "pending-confirmation"; since: string } | null;
  expandedToday: { batches: number; groups: number; names: string[] } | null;
  existingNames: string[];
};

/**
 * 把预检结果写成人能一眼看懂的几行。
 *
 * 这段文案是「防重复」唯一的实际防线——按钮不再锁死，引擎那道幂等闸门又只拦得住
 * 同一秒内的重放，所以用户能不能认出「这是我刚才点过的那一批」，全看这里说得够不
 * 够具体：谁在跑、今天扩过几次、已经占了哪些组名。
 */
export function describeExpandConflicts(conflicts: ExpandConflict[]): string[] {
  return conflicts.map((conflict) => {
    const reasons: string[] = [];
    if (conflict.inProgress) {
      reasons.push(conflict.inProgress.kind === "running"
        ? `有一批仍在执行中（${fmtDate(conflict.inProgress.since)} 开始）`
        : `上次结果待人工确认（${fmtDate(conflict.inProgress.since)}）`);
    }
    if (conflict.expandedToday) {
      reasons.push(`今天已扩过 ${conflict.expandedToday.batches} 次、共 ${conflict.expandedToday.groups} 个组`);
    }
    if (conflict.existingNames.length > 0) {
      const shown = conflict.existingNames.slice(0, 3).join("、");
      const rest = conflict.existingNames.length > 3 ? ` 等 ${conflict.existingNames.length} 个` : "";
      reasons.push(`已有同日组名：${shown}${rest}`);
    }
    return `· ${conflict.sourceAdGroupName}：${reasons.join("；")}`;
  });
}

/** 弹窗里最多逐条列几个源组，其余折成计数。 */
const MAX_LISTED_CONFLICTS = 8;

/** 二次确认的完整文案：先列冲突，再说清这一次还要建多少个。 */
export function buildExpandConfirmMessage(input: {
  conflictLines: string[];
  sourceCount: number;
  countPerSource: number;
  immediate: boolean;
}): string {
  // 逐条列出是为了让用户认出「这是我刚点过的那批」，但一次列几十条只会变成一堵
  // 墙——真要逐条核对，任务列表里看得更清楚。
  const shown = input.conflictLines.slice(0, MAX_LISTED_CONFLICTS);
  const rest = input.conflictLines.length - shown.length;
  return [
    `${input.conflictLines.length} 个源组已经有进行中或今天扩过的记录：`,
    ...shown,
    ...(rest > 0 ? [`· 另有 ${rest} 个源组同样有记录（详见任务列表）`] : []),
    "",
    `继续将为 ${input.sourceCount} 个源组各创建 ${input.countPerSource} 个新组（共 ${input.sourceCount * input.countPerSource} 个）${input.immediate ? "并【立即开始投放】" : ""}。确认继续？`,
  ].join("\n");
}

/**
 * 历史默认只铺这么多行。一次扩几十组是常态，全铺出来表格能有五千多像素高
 * （实测 100 条 = 5617px），把「一键扩组」按钮推到几屏之外。
 */
const HISTORY_COLLAPSED_ROWS = 8;

/** 扩组预设的初始值，按当前投放习惯定；面板里仍可逐次改。 */
const DEFAULT_COPY_COUNT = 1;
const DEFAULT_DAILY_BUDGET = 50;
/** 空串表示继承源组出价；给了默认值就等于默认覆盖，需要继承时手动清空。 */
const DEFAULT_BID_TEXT = "7";

export function ExpandGroupsPanel({
  accounts,
  connectionStates,
  onConnectionStatesChanged,
  onManageConnection,
  onError,
  presetHost,
  onCopyCampaign,
}: {
  accounts: AccountConfig[];
  connectionStates: ConnectionState[];
  onConnectionStatesChanged?: (() => Promise<void>) | undefined;
  onManageConnection?: ((accountId: string) => void) | undefined;
  onError: (message: string | null) => void;
  presetHost?: HTMLElement | null;
  /**
   * 把「需重扩」的系列带到复制系列页。不给这个回调时该列只显示占位符——
   * 面板本身不做导航，跳转由挂载它的页面决定。
   */
  onCopyCampaign?: ((target: {
    accountId: string;
    campaignId?: string;
    campaignIds?: string[];
  }) => void) | undefined;
}) {
  const { confirm, toast } = useOverlays();
  const [entitiesByAccount, setEntitiesByAccount] = useState<Record<string, ManagedEntityRecord[]>>({});
  // null 表示该账户的分类没取到（接口失败），与「还没加载」区分开：前者要退回不带
  // 判定的原样列表，后者只是还在转圈。
  const [classificationByAccount, setClassificationByAccount] =
    useState<Record<string, ExpandClassificationResponse | null>>({});
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>("expand");
  const [loadingAccounts, setLoadingAccounts] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [timeFilter, setTimeFilter] = useState<ExpandScope>("polling-range");
  const [conversionFilter, setConversionFilter] = useState<ConversionFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(DEFAULT_COPY_COUNT);
  const [dailyBudget, setDailyBudget] = useState(DEFAULT_DAILY_BUDGET);
  const [bidText, setBidText] = useState(DEFAULT_BID_TEXT);
  const [timingMode, setTimingMode] = useState<"immediate" | "scheduled">("scheduled");
  const [scheduledAt, setScheduledAt] = useState<string>(defaultNextSixOClock);
  const [visibleAccountIds, setVisibleAccountIds] = useState<string[]>([]);
  // 正在跑的批次数。只用于显示进度，不再拿它去禁用任何东西——一批扩组可能跑很久，
  // 锁死按钮等于整个面板停摆。防重复靠提交前的预检二次确认。
  const [runningBatches, setRunningBatches] = useState(0);
  // 同账户排队、跨账户并发：每个账户一条 Promise 链，互不阻塞。
  const accountQueues = useRef(new Map<string, Promise<unknown>>());
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [recoveringAccountIds, setRecoveringAccountIds] = useState<string[]>([]);
  const [history, setHistory] = useState<AdGroupExpandTask[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [publishingTaskKey, setPublishingTaskKey] = useState<string | null>(null);
  type DraftScanRow = {
    accountId: string;
    minAgeHours: number;
    drafts: Array<{ adSketchId: string; adSketchName: string; touchedAt: string | null }>;
    tooFresh: number;
    reserved: number;
    error: string | null;
  };
  const [closingCampaigns, setClosingCampaigns] = useState(false);
  const [draftScan, setDraftScan] = useState<DraftScanRow[] | null>(null);
  const [draftScanning, setDraftScanning] = useState(false);
  const [draftCleaning, setDraftCleaning] = useState(false);

  const accountName = useMemo(
    () => new Map(accounts.map((account) => [account.id, account.displayName])),
    [accounts],
  );

  // All surfaces share the same canonical access model. Expanding only uses
  // the read and copy lanes, but the account's overall state is not redefined.
  const eligibleStates = useMemo(
    () => connectionStates.filter((state) => {
      const access = accountAccessStatus(state);
      return access.readReady && access.copyReady;
    }),
    [connectionStates],
  );
  const excludedStates = useMemo(
    () => connectionStates.filter((state) => !eligibleStates.includes(state)),
    [connectionStates, eligibleStates],
  );

  const recoverAccount = async (state: ConnectionState) => {
    const access = accountAccessStatus(state);
    if (access.recovery === "connect") {
      onManageConnection?.(state.accountId);
      return;
    }
    setRecoveringAccountIds((current) => [...new Set([...current, state.accountId])]);
    onError(null);
    try {
      if (access.recovery === "recheck") {
        const connection = state.connection;
        if (!connection) throw new Error("账户尚未建立接入。");
        const checked = await api.testConnection(state.accountId, connection.kind);
        if (checked.status !== "ready") {
          throw new Error(checked.lastMessage || "本地凭据重新检测失败，请重新接入。");
        }
      } else if (access.recovery === "sync") {
        const connection = state.connection;
        if (!connection) throw new Error("账户尚未建立接入。");
        await api.syncReadOnly(state.accountId, connection.kind);
      }
      await onConnectionStatesChanged?.();
      toast("账户状态已重新检测", "success");
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setRecoveringAccountIds((current) => current.filter((id) => id !== state.accountId));
    }
  };

  const loadAccount = async (accountId: string) => {
    setLoadingAccounts((current) => [...new Set([...current, accountId])]);
    try {
      // 分类失败不能连带广告组列表一起失败：分类只是给列表加一层判定，拿不到时
      // 面板退回「不带判定」的原样可用，而不是整个空掉。
      const [entities, classification] = await Promise.all([
        api.getManagedEntities(accountId),
        api.getExpandClassification(accountId).catch(() => null),
      ]);
      setEntitiesByAccount((current) => ({ ...current, [accountId]: entities }));
      setClassificationByAccount((current) => ({ ...current, [accountId]: classification }));
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setLoadingAccounts((current) => current.filter((id) => id !== accountId));
    }
  };

  // 仅按需加载被选中展示的账户，避免多账户一次性铺满。
  useEffect(() => {
    for (const accountId of visibleAccountIds) {
      if (!(accountId in entitiesByAccount)) void loadAccount(accountId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleAccountIds]);

  // 历史记录取**全部账户**，不看当前展示的是谁、也不看账户此刻能不能扩组：
  // 取消勾选账户、或者某个账户 Cookie 失效了，都不该让已经发生过的记录消失
  // ——尤其「结果未知」那类，正是账户出问题时最需要被看见的。
  const historyAccountIds = useMemo(
    () => accounts.map((account) => account.id),
    [accounts],
  );
  /**
   * 人工核实之后，把所有「结果未知」一次清掉。
   *
   * 这类记录禁止自动重试、只能靠人收口，而人是一次去 TikTok 后台把几条一起核实完的。
   * 逼他回来一条条点只会让他干脆不点——于是红色横幅只进不出，涨到没人再看它，真正需要
   * 处理的新记录也跟着被淹掉。
   *
   * 清除即释放幂等键，这些源组之后可以再次扩组。所以二次确认里把组名逐条列出来：让人
   * 对着具体清单确认，而不是一个空泛的「确定吗」。
   */
  const resolveAllStuckTasks = async () => {
    const names = needsReview
      .map((task) => task.generatedNames.join("、") || "（未记录组名）");
    const list = names.map((name, index) => `${index + 1}. ${name}`).join("\n");
    const confirmed = await confirm({
      title: `清除 ${needsReview.length} 条「结果未知」`,
      message: `请先在 TikTok 广告后台逐条确认下面这些组到底建成没有：\n\n${list}\n\n清除后这些记录消失，对应的源广告组也重新允许扩组——没核实就清除，可能把已经建好的组再建一遍。确认全部已核实？`,
      confirmLabel: `已全部核实，清除 ${needsReview.length} 条`,
      danger: true,
    });
    if (!confirmed) return;
    setResolving(true);
    onError(null);
    try {
      const { cleared } = await api.resolveUncertainAdGroupExpandTasks(historyAccountIds);
      toast(`已清除 ${cleared} 条`, "success");
      await loadHistory(historyAccountIds);
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setResolving(false);
    }
  };

  /**
   * 发布这条记录留在 TikTok 后台的草稿。
   *
   * 「全部清除」只是把红条摘掉，草稿仍然烂在后台——这里才是真正的收口。轮询对账确认「只
   * 建了草稿」后会自动补这一步，这个按钮是给自动重试试满之后再点一次用的。
   */
  const publishDraft = async (task: AdGroupExpandTask) => {
    const names = task.generatedNames.join("、") || "（未记录组名）";
    const confirmed = await confirm({
      title: "发布这条记录的草稿",
      message: `扩组失败时 TikTok 后台会留下草稿。这一步把下面这些草稿正式发布出去：\n\n${names}\n\n发布后直接投放（组和组里的广告都会开起来）。\n草稿如果已经被手动发布或删除，这里会直接报找不到，不会重复建。`,
      confirmLabel: "发布草稿",
    });
    if (!confirmed) return;
    setPublishingTaskKey(task.taskKey);
    onError(null);
    try {
      const result = await api.publishStuckExpandDraft(task.taskKey);
      toast(result.message, "success");
      await loadHistory(historyAccountIds);
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setPublishingTaskKey(null);
    }
  };

  /**
   * 去 TikTok 后台查一遍遗留草稿。
   *
   * 刻意做成按钮触发而不是进面板就查：一个账户一次请求，Cookie 失效的账户还会各报一次错，
   * 没人要看的时候不该替他去敲平台。
   */
  const scanStaleDrafts = async () => {
    setDraftScanning(true);
    onError(null);
    try {
      setDraftScan(await Promise.all(historyAccountIds.map(async (accountId): Promise<DraftScanRow> => {
        try {
          const result = await api.getStaleDraftCandidates(accountId);
          return { accountId, ...result, error: null };
        } catch (cause) {
          // 一个账户查不到不该把整张表打掉，把原因摆在它自己那一行。
          return { accountId, minAgeHours: 0, drafts: [], tooFresh: 0, reserved: 0, error: messageOf(cause) };
        }
      })));
    } finally {
      setDraftScanning(false);
    }
  };

  const cleanStaleDrafts = async () => {
    const total = (draftScan ?? []).reduce((sum, row) => sum + row.drafts.length, 0);
    const list = (draftScan ?? [])
      .flatMap((row) => row.drafts.map((draft) => `${accountName.get(row.accountId) ?? row.accountId}：${draft.adSketchName}`))
      .map((line, index) => `${index + 1}. ${line}`).join("\n");
    const confirmed = await confirm({
      title: `清理 ${total} 条遗留草稿`,
      message: `下面这些草稿超过保护期没人动过，将从 TikTok 后台删除：\n\n${list}\n\n删除不可恢复。还挂着「结果未知」的组名不在其中——那些要先决定发布还是放弃。`,
      confirmLabel: `删除 ${total} 条`,
      danger: true,
    });
    if (!confirmed) return;
    setDraftCleaning(true);
    onError(null);
    try {
      let deleted = 0;
      const failures: string[] = [];
      for (const row of draftScan ?? []) {
        if (row.drafts.length === 0) continue;
        try {
          const result = await api.deleteStaleDraftCandidates(row.accountId);
          deleted += result.deleted;
          failures.push(...result.failed.map((item) => `${item.adSketchName}：${item.message}`));
        } catch (cause) {
          failures.push(`${accountName.get(row.accountId) ?? row.accountId}：${messageOf(cause)}`);
        }
      }
      toast(failures.length > 0 ? `已删除 ${deleted} 条，${failures.length} 条失败` : `已删除 ${deleted} 条`,
        failures.length > 0 ? "error" : "success");
      if (failures.length > 0) onError(failures.join("；"));
      await scanStaleDrafts();
    } finally {
      setDraftCleaning(false);
    }
  };

  const loadHistory = async (accountIds: string[]) => {
    if (accountIds.length === 0) { setHistory([]); return; }
    setHistoryLoading(true);
    try {
      const { tasks } = await api.listAdGroupExpandHistory(accountIds);
      setHistory(tasks);
    } catch (cause) {
      // 历史读不出来不该把整个扩组面板拖垮，它只是回顾用的。
      onError(messageOf(cause));
    } finally {
      setHistoryLoading(false);
    }
  };
  useEffect(() => {
    void loadHistory(historyAccountIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyAccountIds.join(",")]);

  const staleDraftTotal = useMemo(
    () => (draftScan ?? []).reduce((sum, row) => sum + row.drafts.length, 0),
    [draftScan],
  );
  // 保护期内 + 被「结果未知」占着的：用来解释名单为什么比后台看到的短。
  const draftProtectedTotal = useMemo(
    () => (draftScan ?? []).reduce((sum, row) => sum + row.tooFresh + row.reserved, 0),
    [draftScan],
  );

  const needsReview = useMemo(() => history.filter((task) => task.uncertain), [history]);
  // 「结果未知」永远排在最前，与时间无关：99 条成功刷屏时，它按时间排会被挤到第
  // 65 行去（实测），而它恰恰是唯一需要人动手的那类。
  const sortedHistory = useMemo(
    () => [...needsReview, ...history.filter((task) => !task.uncertain)],
    [history, needsReview],
  );
  const shownHistory = historyExpanded ? sortedHistory : sortedHistory.slice(0, HISTORY_COLLAPSED_ROWS);

  const visibleStates = useMemo(
    () => eligibleStates.filter((state) => visibleAccountIds.includes(state.accountId)),
    [eligibleStates, visibleAccountIds],
  );

  /**
   * 系列 ID -> 该系列的扩组判定。
   *
   * 判定是**系列级**的，而这个面板选的是广告组，所以每个广告组的判定要顺着
   * parentCampaignId 去查它所属的系列。同一系列下的多个组共享同一个判定——这正是
   * 「不以组为单位」的意思：组交给自动化规则管，扩不扩看系列。
   */
  const verdictByCampaign = useMemo(() => {
    const byAccount = new Map<string, Map<string, ExpandClassificationResponse["expand"][number]>>();
    for (const [accountId, classification] of Object.entries(classificationByAccount)) {
      if (!classification) continue;
      const map = new Map<string, ExpandClassificationResponse["expand"][number]>();
      for (const item of [
        ...classification.expand,
        ...classification.recreateCampaign,
        ...classification.excluded,
      ]) {
        map.set(item.externalId, item);
      }
      byAccount.set(accountId, map);
    }
    return byAccount;
  }, [classificationByAccount]);

  // 每个账户：解析系列名映射 + 过滤后的广告组列表。
  const groups = useMemo(() => {
    const now = Date.now();
    const normalizedQuery = query.trim().toLowerCase();
    return visibleStates.map((state) => {
      const entities = entitiesByAccount[state.accountId] ?? [];
      const verdicts = verdictByCampaign.get(state.accountId);
      const campaignNames = new Map(
        entities
          .filter((entity) => entity.entityType === "campaign")
          .map((entity) => [entity.externalId, entity.name]),
      );
      const adGroups = entities
        .filter((entity) => entity.entityType === "ad-group" && !entity.ignored)
        // 系列预算(CBO)广告组不能设与系列不同的组预算，扩组必然与 CBO 冲突，直接排除出名单。
        .filter((entity) => !entity.campaignBudgetOptimized)
        .filter((entity) => withinExpandScope(
          { createdAt: entity.createdAt, spend: entity.metrics.spend, automationManaged: entity.automationManaged },
          timeFilter,
          now,
        ))
        .filter((entity) => {
          const conversions = entity.metrics.conversions ?? 0;
          if (conversionFilter === "has") return conversions > 0;
          if (conversionFilter === "none") return conversions <= 0;
          return true;
        })
        .filter((entity) => statusFilter === "all" || entity.status === statusFilter)
        .filter((entity) => matchesVerdictFilter(
          verdictFilter,
          (verdicts && entity.parentCampaignId
            ? verdicts.get(entity.parentCampaignId)?.verdict
            : null) ?? null,
        ))
        .filter((entity) => !normalizedQuery
          || entity.name.toLowerCase().includes(normalizedQuery)
          || entity.externalId.toLowerCase().includes(normalizedQuery))
        // 按创建时间由近到远（最新在上）。
        .sort((left, right) => {
          const leftAt = left.createdAt ? new Date(left.createdAt).getTime() : 0;
          const rightAt = right.createdAt ? new Date(right.createdAt).getTime() : 0;
          return rightAt - leftAt;
        });
      return {
        accountId: state.accountId,
        displayName: accountName.get(state.accountId) ?? state.accountId,
        providerKind: state.connection?.kind ?? "cookie",
        campaignNames,
        adGroups,
        verdicts,
      };
    });
  }, [accountName, conversionFilter, visibleStates, entitiesByAccount, query, statusFilter, timeFilter, verdictFilter, verdictByCampaign]);

  /** 汇总条：本次可见账户里各判定的系列条数，以及最早的一次计算时刻。 */
  const verdictSummary = useMemo(() => {
    let expand = 0;
    let recreate = 0;
    let computedAt: string | null = null;
    let missing = 0;
    for (const state of visibleStates) {
      const classification = classificationByAccount[state.accountId];
      if (!classification) {
        if (classification === null) missing += 1;
        continue;
      }
      expand += classification.expand.length;
      recreate += classification.recreateCampaign.length;
      // 多账户时取最早那次，汇总条上说的「算于」不能比其中任何一个账户更新。
      if (!computedAt || classification.computedAt < computedAt) {
        computedAt = classification.computedAt;
      }
    }
    return { expand, recreate, computedAt, missing };
  }, [visibleStates, classificationByAccount]);

  /**
   * 可以直接关掉的系列：判定为需重扩、且组已经被规则关光的。
   *
   * 组还在跑的不放进来——那说明系列还在产生数据，关系列会连带掐掉正在投放的组。
   */
  const closableCampaigns = useMemo(
    () => visibleStates.flatMap((state) => {
      const classification = classificationByAccount[state.accountId];
      if (!classification) return [];
      return classification.recreateCampaign
        .filter((item) => item.hasActiveAdGroups === false)
        .map((item) => ({ ...item, accountId: state.accountId }));
    }),
    [visibleStates, classificationByAccount],
  );

  const closeStalledCampaigns = async () => {
    if (closableCampaigns.length === 0) return;
    const confirmed = await confirm({
      title: "关闭需重扩的系列",
      message: [
        `将关闭 ${closableCampaigns.length} 条系列：它们都已判定为需重扩，且组已被规则全部关停。`,
        "",
        ...closableCampaigns.slice(0, 8).map((item) => `· ${item.name}`),
        ...(closableCampaigns.length > 8 ? [`· 另有 ${closableCampaigns.length - 8} 条`] : []),
        "",
        "关闭后不影响已复制出的新系列。确认？",
      ].join("\n"),
      confirmLabel: "确认关闭",
      danger: true,
    });
    if (!confirmed) return;
    setClosingCampaigns(true);
    onError(null);
    const failed: string[] = [];
    try {
      // 逐条发：批量接口没有系列层的入口，而一条失败不该拖垮其余条。
      for (const item of closableCampaigns) {
        try {
          await api.changeEntityStatus(item.accountId, {
            entityType: "campaign",
            externalId: item.externalId,
            action: "disable",
          });
        } catch (cause) {
          failed.push(`${item.name}：${messageOf(cause)}`);
        }
      }
      const ok = closableCampaigns.length - failed.length;
      setFeedback({
        tone: failed.length > 0 ? "danger" : "success",
        title: failed.length > 0 ? `已关闭 ${ok} 条，${failed.length} 条失败` : `已关闭 ${ok} 条系列`,
        lines: failed.slice(0, 8),
      });
      await Promise.all(visibleStates.map((state) => loadAccount(state.accountId)));
    } finally {
      setClosingCampaigns(false);
    }
  };

  /** 需要复制新系列的那批，按亏得最多排前面（服务端已排好序，这里只做跨账户拼接）。 */
  const recreateList = useMemo(
    () => visibleStates.flatMap((state) => {
      const classification = classificationByAccount[state.accountId];
      if (!classification) return [];
      return classification.recreateCampaign.map((item) => ({
        ...item,
        accountId: state.accountId,
        accountName: accountName.get(state.accountId) ?? state.accountId,
      }));
    }),
    [visibleStates, classificationByAccount, accountName],
  );

  // 因系列预算(CBO)被排除的广告组数量，用于向用户解释名单为何变短。
  const cboHiddenCount = useMemo(
    () => visibleStates.reduce((total, state) => total
      + (entitiesByAccount[state.accountId] ?? []).filter(
        (entity) => entity.entityType === "ad-group" && !entity.ignored && entity.campaignBudgetOptimized,
      ).length, 0),
    [visibleStates, entitiesByAccount],
  );

  const selectableKeys = useMemo(
    () => new Set(groups.flatMap((group) =>
      group.adGroups
        .filter((entity) => entity.parentCampaignId)
        .map((entity) => keyOf(group.accountId, entity.externalId)),
    )),
    [groups],
  );
  const selectedValid = selected.filter((key) => selectableKeys.has(key));

  const toggle = (key: string) => {
    setSelected((current) => current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key]);
  };
  const toggleAccount = (accountId: string, keys: string[]) => {
    const allSelected = keys.every((key) => selected.includes(key));
    setSelected((current) => allSelected
      ? current.filter((key) => !keys.includes(key))
      : [...new Set([...current, ...keys])]);
  };

  const submit = async () => {
    const bid = bidText.trim() === "" ? null : Number(bidText);
    if (bid !== null && (!Number.isFinite(bid) || bid < 0)) {
      onError("出价必须为非负数字，或留空继承源组。");
      return;
    }
    if (!Number.isFinite(dailyBudget) || dailyBudget <= 0) {
      onError("日预算必须为正数。");
      return;
    }
    const sources = groups.flatMap((group) =>
      group.adGroups
        .filter((entity) => selected.includes(keyOf(group.accountId, entity.externalId)))
        .filter((entity) => entity.parentCampaignId)
        .map((entity) => ({
          accountId: group.accountId,
          sourceCampaignId: entity.parentCampaignId as string,
          sourceCampaignName: group.campaignNames.get(entity.parentCampaignId as string) ?? entity.name,
          sourceAdGroupId: entity.externalId,
          sourceAdGroupName: entity.name,
        })),
    );
    if (sources.length === 0) {
      onError("请先勾选至少一个广告组。");
      return;
    }
    let scheduledStartAt: string | null = null;
    if (timingMode === "scheduled") {
      const when = new Date(scheduledAt);
      if (Number.isNaN(when.getTime())) {
        onError("请填写有效的定时投放时间。");
        return;
      }
      if (when.getTime() <= Date.now()) {
        onError("定时投放时间必须晚于当前时间。");
        return;
      }
      scheduledStartAt = when.toISOString();
    }
    // 重复提交预检：把「有没有在跑的、今天扩过没有、会不会撞上已有组名」摆出来，
    // 由用户判断这次是不是误点。预检失败不阻断提交——它只是提示，不是闸门。
    let conflictLines: string[] = [];
    try {
      const { conflicts } = await api.preflightBatchExpandAdGroups({ sources, scheduledStartAt });
      conflictLines = describeExpandConflicts(conflicts);
    } catch {
      // 预检本身出错不该挡住正常扩组，只是这次没有提示可给。
      conflictLines = [];
    }

    const immediate = timingMode === "immediate";
    if (conflictLines.length > 0) {
      const confirmed = await confirm({
        title: "这些源组可能是重复扩组",
        message: buildExpandConfirmMessage({
          conflictLines,
          sourceCount: selectedValid.length,
          countPerSource: count,
          immediate,
        }),
        confirmLabel: "确认继续扩组",
        danger: true,
      });
      if (!confirmed) return;
    } else if (immediate) {
      // 立即投放是不可逆的真实写入，二次确认避免误点。
      const confirmed = await confirm({
        title: "立即投放确认",
        message: `将为 ${selectedValid.length} 个源组各创建 ${count} 个新组并【立即开始投放】（共 ${selectedValid.length * count} 个）。确认立即投放？`,
        confirmLabel: "确认立即投放",
        danger: true,
      });
      if (!confirmed) return;
    }

    setFeedback(null);
    onError(null);
    setSelected([]);

    // 按账户拆分，各自挂到本账户的队列尾部：同账户串行避免叠加频控，不同账户并发。
    const byAccount = new Map<string, typeof sources>();
    for (const source of sources) {
      byAccount.set(source.accountId, [...(byAccount.get(source.accountId) ?? []), source]);
    }
    for (const [accountId, accountSources] of byAccount) {
      const previous = accountQueues.current.get(accountId) ?? Promise.resolve();
      // 入队即计数：排在同账户队列里还没轮到的批次同样是「待办」，不显示出来的话
      // 用户会以为自己那次点击丢了。
      setRunningBatches((current) => current + 1);
      const runBatch = async () => {
        try {
          const result = await api.batchExpandAdGroups({
            sources: accountSources,
            count,
            dailyBudget,
            bid,
            launchImmediately: immediate,
            sameCampaign: true,
            scheduledStartAt,
          });
          const label = accountName.get(accountId) ?? accountId;
          const lines: string[] = [];
          for (const failure of result.failed) lines.push(`${failure.name} 失败：${failure.message}`);
          if (scheduledStartAt && result.scheduled > 0) {
            lines.push(`${result.scheduled} 个新组已设置 TikTok 原生定时投放：${new Date(scheduledStartAt).toLocaleString()}。`);
          }
          if (result.skipped > 0) lines.push(`${result.skipped} 个已扩过或进行中，已跳过。`);
          const created = result.createdGroups > 0;
          // 多账户并发时逐批追加，后完成的不覆盖先完成的结果。
          setFeedback((current) => ({
            // 只要有一批失败，整体就保持失败态，后续成功的批次不把它洗白。
            tone: created && current?.tone !== "danger" ? "success" : "danger",
            title: created ? "创建成功" : "创建失败",
            lines: [...(current?.lines ?? []), `【${label}】成功 ${result.createdGroups} 个组`, ...lines],
          }));
          toast(
            result.failed.length > 0
              ? `${label} 扩组完成：成功 ${result.createdGroups} 个，失败 ${result.failed.length} 个`
              : `${label} 扩组全部成功（${result.createdGroups} 个广告组）`,
            result.failed.length > 0 ? "error" : "success",
          );
          void loadAccount(accountId);
          void loadHistory(historyAccountIds);
        } catch (cause) {
          onError(messageOf(cause));
        } finally {
          setRunningBatches((current) => Math.max(0, current - 1));
        }
      };
      // 前一批失败也要继续跑本批：队列只负责排序，不传播错误。
      const chained = previous.then(runBatch, runBatch);
      accountQueues.current.set(accountId, chained);
      void chained.finally(() => {
        if (accountQueues.current.get(accountId) === chained) accountQueues.current.delete(accountId);
      });
    }
  };

  const totalSelectable = selectableKeys.size;
  const presetPanel = <div className={presetHost ? "expand-preset sidebar" : "expand-preset"}>
    <div className="expand-preset-head"><CopyPlus size={15} /> 扩组预设</div>
    <div className="expand-preset-grid">
      <label className="field"><span>每个源组复制份数</span><input max={10} min={1} type="number" value={count} onChange={(event) => setCount(Math.max(1, Math.min(10, Number(event.target.value) || 1)))} /><small>1–10，命名为“原组名-投放日期-序号”。</small></label>
      <label className="field"><span>日预算</span><input min={1} type="number" value={dailyBudget} onChange={(event) => setDailyBudget(Number(event.target.value))} /><small>覆盖新组的日预算。</small></label>
      <label className="field"><span>出价</span><input placeholder="留空继承源组" value={bidText} onChange={(event) => setBidText(event.target.value)} /><small>留空则继承源组出价。</small></label>
    </div>
    <div className="expand-timing">
      <span className="expand-timing-label">投放时间</span>
      <div className="expand-timing-modes">
        <button className={timingMode === "immediate" ? "expand-timing-mode active" : "expand-timing-mode"} onClick={() => setTimingMode("immediate")} type="button">立即投放</button>
        <button className={timingMode === "scheduled" ? "expand-timing-mode active" : "expand-timing-mode"} onClick={() => setTimingMode("scheduled")} type="button">定时投放</button>
      </div>
      {timingMode === "scheduled"
        ? <label className="expand-timing-when"><input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} /><small>新组将以开启状态发布，并由 TikTok 在设定时间开始投放。默认最近的早上 06:00（未到 06:00 就是今天），可改。</small></label>
        : <small className="expand-timing-hint">新组创建后立即开启投放。</small>}
    </div>
  </div>;

  return <div className="panel expand-groups-panel">
    <div className="panel-heading"><div><span className="panel-icon"><CopyPlus size={18} /></span><div><h2>一键扩组</h2><p>先选账户，再勾选目标广告组，按预设为每个源组各复制 N 个新组（挂原系列、克隆源创意）。</p></div></div></div>

    {eligibleStates.length > 0 && <div className="expand-account-picker">
      <span className="expand-picker-label">账户</span>
      <div className="expand-picker-chips">
        {eligibleStates.map((state) => {
          const active = visibleAccountIds.includes(state.accountId);
          return <button className={active ? "expand-picker-chip active" : "expand-picker-chip"} key={state.accountId} onClick={() => setVisibleAccountIds((current) => active ? current.filter((id) => id !== state.accountId) : [...current, state.accountId])} type="button">{accountName.get(state.accountId) ?? state.accountId}</button>;
        })}
      </div>
      <div className="expand-picker-actions">
        <button className="secondary-button compact-button" disabled={visibleAccountIds.length === eligibleStates.length} onClick={() => setVisibleAccountIds(eligibleStates.map((state) => state.accountId))} type="button">全选</button>
        <button className="secondary-button compact-button" disabled={visibleAccountIds.length === 0} onClick={() => setVisibleAccountIds([])} type="button">清空</button>
      </div>
    </div>}

    <div className="expand-toolbar">
      <label className="expand-filter"><span>范围</span><select value={timeFilter} onChange={(event) => setTimeFilter(event.target.value as ExpandScope)}><option value="spending-today">今天在投（有消耗）</option><option value="created-recently">近 48 小时新建</option><option value="polling-range">轮询范围内全部</option></select></label>
      <label className="expand-filter"><span>转化</span><select value={conversionFilter} onChange={(event) => setConversionFilter(event.target.value as ConversionFilter)}><option value="all">全部</option><option value="has">有转化</option><option value="none">无转化</option></select></label>
      <label className="expand-filter"><span>状态</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}><option value="all">全部</option><option value="enabled">投放中</option><option value="disabled">已暂停</option></select></label>
      <label className="expand-filter"><span>系列判定</span><select value={verdictFilter} onChange={(event) => setVerdictFilter(event.target.value as VerdictFilter)}><option value="expand">可扩组</option><option value="recreate">需重扩系列</option><option value="all">全部</option></select></label>
      <label className="expand-filter grow"><span>搜索</span><input placeholder="广告组名称或 ID" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    </div>

    {(verdictSummary.expand > 0 || verdictSummary.recreate > 0) && <div className="expand-verdict-summary">
      <Info size={14} />
      <span>
        按自系列创建以来累计判定：<strong>{verdictSummary.expand}</strong> 条系列可扩组、
        <strong>{verdictSummary.recreate}</strong> 条建议今天别扩、改复制新系列重跑。
      </span>
      {/* 转化延迟回传，同一天早晚算出来的分桶会不一样，必须说清是几点的账。 */}
      {verdictSummary.computedAt && <small>算于 {fmtDate(verdictSummary.computedAt)}</small>}
    </div>}

    {verdictSummary.missing > 0 && <p className="expand-excluded-note"><AlertTriangle size={14} /> <span>{verdictSummary.missing} 个账户的系列判定没取到，这些账户的列表未按判定过滤。</span></p>}

    {excludedStates.length > 0 && <div className="expand-excluded-list">
      <div className="expand-excluded-summary"><Info size={14} /><span>{excludedStates.length} 个账户当前不可扩组。以下状态与总览、账户管理和接入页使用同一份能力结果。</span></div>
      {excludedStates.map((state) => {
        const access = accountAccessStatus(state);
        const recovering = recoveringAccountIds.includes(state.accountId);
        return <div className="expand-excluded-account" key={state.accountId}>
          <span><strong>{accountName.get(state.accountId) ?? state.accountId}</strong><small>{access.blockers[0] ?? "读取或复制能力尚未就绪。"}</small></span>
          <button className="secondary-button compact-button" disabled={recovering} onClick={() => void recoverAccount(state)} type="button">
            {recovering ? <><RefreshCcw className="spin" size={13} />检测中</> : access.recovery === "sync" ? "立即同步" : access.recovery === "connect" ? "前往账户接入" : "用本地凭据重新检测"}
          </button>
        </div>;
      })}
    </div>}

    {cboHiddenCount > 0 && <p className="expand-excluded-note"><Info size={14} /> <span>{cboHiddenCount} 个系列预算(CBO)广告组不支持扩组（组预算须与系列一致），已从名单中排除。</span></p>}

    {groups.length === 0 ? (eligibleStates.length === 0
      ? <div className="expand-empty"><Inbox size={30} /><strong>没有可扩组的账户</strong><span>请确认账户已接入、具备复制能力，并在“用户管理”完成一次健康的只读同步。</span></div>
      : <div className="expand-empty"><Inbox size={30} /><strong>请选择账户</strong><span>在上方选择一个或多个账户，查看其广告组后再勾选扩组。</span></div>
    ) : <div className="expand-account-list">
      {groups.map((group) => {
        const groupKeys = group.adGroups.filter((entity) => entity.parentCampaignId).map((entity) => keyOf(group.accountId, entity.externalId));
        const selectedInGroup = groupKeys.filter((key) => selected.includes(key)).length;
        const allSelected = groupKeys.length > 0 && selectedInGroup === groupKeys.length;
        const isLoading = loadingAccounts.includes(group.accountId);
        return <section className="expand-account-block" key={group.accountId}>
          <header className="expand-account-head">
            <div className="expand-account-title">
              <strong>{group.displayName}</strong>
              <div className="expand-account-meta">
                <span className="expand-chip">{group.providerKind === "cookie" ? "Cookie" : "Marketing API"}</span>
                <span>广告组 {group.adGroups.length}</span>
                {selectedInGroup > 0 && <span className="expand-chip selected">已选 {selectedInGroup}</span>}
              </div>
            </div>
            <div className="expand-account-actions">
              <button className="secondary-button compact-button" disabled={groupKeys.length === 0} onClick={() => toggleAccount(group.accountId, groupKeys)} type="button">{allSelected ? "取消本账户" : "全选本账户"}</button>
              <button className="secondary-button compact-button" disabled={isLoading} onClick={() => void loadAccount(group.accountId)} title="重新读取该账户已同步的广告组" type="button"><RefreshCcw size={14} /> {isLoading ? "刷新中" : "刷新"}</button>
            </div>
          </header>
          {group.adGroups.length === 0 ? <p className="expand-account-empty">{isLoading ? "读取中…" : "该账户在当前筛选下没有广告组。"}</p> : <div className="table-wrap expand-table"><table><thead><tr><th className="expand-check-col"><input aria-label="全选本账户" checked={allSelected} disabled={groupKeys.length === 0} onChange={() => toggleAccount(group.accountId, groupKeys)} type="checkbox" /></th><th>广告组</th><th>所属系列</th><th>系列判定</th><th>创建时间</th><th className="expand-num">花费</th><th className="expand-num">转化</th><th className="expand-num">CPA</th><th>状态</th></tr></thead><tbody>
            {group.adGroups.map((entity) => {
              const key = keyOf(group.accountId, entity.externalId);
              const selectable = Boolean(entity.parentCampaignId);
              const checked = selected.includes(key);
              const verdict = entity.parentCampaignId
                ? group.verdicts?.get(entity.parentCampaignId)
                : undefined;
              const label = verdict ? VERDICT_LABELS[verdict.reason] : undefined;
              // 判定只是提醒，不锁死勾选：用户说了「提醒我当天不要扩」，最终扩不扩
              // 由人定。行上加个底色让它在几十行里一眼能认出来就够了。
              const rowClass = [
                checked ? "selected" : "",
                verdict?.verdict === "recreate-campaign" ? "expand-row-warn" : "",
              ].filter(Boolean).join(" ");
              return <tr key={key} className={rowClass} onClick={() => selectable && toggle(key)}>
                <td className="expand-check-col"><input checked={checked} disabled={!selectable} onChange={() => toggle(key)} onClick={(event) => event.stopPropagation()} title={selectable ? undefined : "缺少所属系列 ID，无法扩组"} type="checkbox" /></td>
                <td className="expand-name">{entity.name}</td>
                <td className="expand-muted">{entity.parentCampaignId ? group.campaignNames.get(entity.parentCampaignId) ?? entity.parentCampaignId : "—"}</td>
                <td>{label
                  ? <span className={`status ${label.tone}`} title={`${label.hint}｜累计花费 ${fmtMoney(verdict?.spend)}、转化 ${verdict?.conversions ?? 0}${verdict?.costPerConversion !== null && verdict?.costPerConversion !== undefined ? `、单转 ${fmtMoney(verdict.costPerConversion)}` : ""}`}>{label.short}</span>
                  : <span className="expand-muted">—</span>}</td>
                <td className="expand-muted">{fmtDate(entity.createdAt)}</td>
                <td className="expand-num">{fmtMoney(entity.metrics.spend)}</td>
                <td className="expand-num">{entity.metrics.conversions ?? 0}</td>
                <td className="expand-num">{fmtMoney(entity.metrics.cost_per_conversion)}</td>
                <td><span className={`status ${entity.status === "enabled" ? "active" : "warning"}`}>{entity.status === "enabled" ? "投放中" : entity.status === "disabled" ? "已暂停" : entity.status}</span></td>
              </tr>;
            })}
          </tbody></table></div>}
        </section>;
      })}
    </div>}

    {recreateList.length > 0 && <section className="expand-history">
      <header className="expand-history-head">
        <span><AlertTriangle size={15} /> 建议重扩系列</span>
        <div className="expand-history-actions">
          <span className="expand-history-count">{recreateList.length} 条</span>
        </div>
      </header>
      <p className="expand-excluded-note"><Info size={14} /> <span>这些系列今天不建议再往上扩组。点「复制系列」直接带着它跳到复制页，不用自己再找一遍。</span></p>
      <div className="table-wrap expand-table expand-history-table"><table><thead><tr><th>账户</th><th>系列</th><th>原因</th><th className="expand-num">累计花费</th><th className="expand-num">转化</th><th className="expand-num">单转</th><th>操作</th></tr></thead><tbody>
        {recreateList.map((item) => <tr key={`${item.accountId}::${item.externalId}`}>
          <td className="expand-muted">{item.accountName}</td>
          <td className="expand-name">{item.name}</td>
          <td className="expand-muted">{VERDICT_LABELS[item.reason]?.hint ?? item.reason}</td>
          <td className="expand-num">{fmtMoney(item.spend)}</td>
          <td className="expand-num">{item.conversions}</td>
          <td className="expand-num">{item.costPerConversion === null ? "—" : fmtMoney(item.costPerConversion)}</td>
          <td>{onCopyCampaign
            ? <button className="secondary-button compact-button" type="button"
                onClick={() => onCopyCampaign({ accountId: item.accountId, campaignId: item.externalId })}>
                <CopyPlus size={13} /> 复制系列
              </button>
            : <span className="expand-muted">—</span>}</td>
        </tr>)}
      </tbody></table></div>
      {(recreateList.length > 1 || closableCampaigns.length > 0) && <div className="expand-actions">
        {/* 一次全带过去：几十条系列逐个点跳转，比手动对照好不了多少。 */}
        {recreateList.length > 1 && onCopyCampaign && <button className="secondary-button" type="button"
          onClick={() => onCopyCampaign({
            accountId: recreateList[0]!.accountId,
            campaignIds: recreateList
              .filter((item) => item.accountId === recreateList[0]!.accountId)
              .map((item) => item.externalId),
          })}>
          <CopyPlus size={14} /> 全部带到复制页（{recreateList.filter((item) => item.accountId === recreateList[0]!.accountId).length} 条）
        </button>}
        {/* 只关组已经全停的那批；组还在跑的不动，关系列会连带掐掉在投的组。 */}
        {closableCampaigns.length > 0 && <button className="secondary-button" disabled={closingCampaigns}
          type="button" onClick={() => void closeStalledCampaigns()}
          title="仅关闭组已被规则全部关停的系列">
          <XCircle size={14} /> {closingCampaigns ? "关闭中…" : `关闭已停跑的系列（${closableCampaigns.length} 条）`}
        </button>}
      </div>}
    </section>}

    <section className="expand-history">
      <header className="expand-history-head">
        <span><History size={15} /> 扩组记录</span>
        <div className="expand-history-actions">
          {history.length > 0 && <span className="expand-history-count">{history.length} 条</span>}
          <button className="secondary-button compact-button" disabled={historyLoading} onClick={() => void loadHistory(historyAccountIds)} type="button">
            <RefreshCcw className={historyLoading ? "spin" : ""} size={13} /> {historyLoading ? "读取中" : "刷新"}
          </button>
        </div>
      </header>
      {needsReview.length > 0 && <p className="expand-history-alert">
        <AlertTriangle size={15} />
        <span><strong>{needsReview.length} 条结果未知，需人工核实。</strong>写请求已发出但没拿到结果，禁止整批自动重试——请到 TikTok 后台确认这些组到底建成没有。轮询查到只建了草稿的会自动补发布（最多试 3 次）；试满还挂在这里的，用那一行的「发布草稿」再点一次。</span>
        <button className="secondary-button compact-button" disabled={resolving}
          onClick={() => void resolveAllStuckTasks()} type="button">
          {resolving ? "清除中…" : "已核实，全部清除"}
        </button>
      </p>}
      {history.length === 0
        ? <p className="expand-account-empty">{historyLoading ? "读取中…" : "还没有扩组记录。"}</p>
        : <><div className="table-wrap expand-table expand-history-table"><table><thead><tr><th>时间</th><th>账户</th><th>新组名</th><th className="expand-num">个数</th><th>结果</th><th>操作</th></tr></thead><tbody>
          {shownHistory.map((task) => {
            const tone = task.uncertain ? "danger" : task.status === "succeeded" ? "active" : "warning";
            const label = task.uncertain ? "结果未知，需人工核实" : task.status === "succeeded" ? "成功" : "进行中";
            return <tr className={task.uncertain ? "expand-history-flagged" : ""} key={task.taskKey}>
              <td className="expand-muted">{fmtDate(task.updatedAt)}</td>
              <td className="expand-muted">{accountName.get(task.accountId) ?? task.accountId}</td>
              <td className="expand-name">{task.generatedNames.join("、") || "—"}</td>
              <td className="expand-num">{task.requestedCount}</td>
              <td><span className={`status ${tone}`}>{task.uncertain && <AlertTriangle size={12} />} {label}</span></td>
              <td>{task.uncertain && <button className="secondary-button compact-button"
                disabled={publishingTaskKey !== null}
                onClick={() => void publishDraft(task)} type="button">
                {publishingTaskKey === task.taskKey ? "发布中…" : "发布草稿"}
              </button>}</td>
            </tr>;
          })}
        </tbody></table></div>
        {history.length > HISTORY_COLLAPSED_ROWS && <button className="expand-history-more" onClick={() => setHistoryExpanded((current) => !current)} type="button">
          {historyExpanded ? "收起" : `展开全部 ${history.length} 条`}
        </button>}</>}
    </section>

    <section className="expand-history">
      <header className="expand-history-head">
        <span><Trash2 size={15} /> 遗留草稿</span>
        <div className="expand-history-actions">
          {staleDraftTotal > 0 && <span className="expand-history-count">{staleDraftTotal} 条可清理</span>}
          <button className="secondary-button compact-button" disabled={draftScanning || draftCleaning || historyAccountIds.length === 0}
            onClick={() => void scanStaleDrafts()} type="button">
            <RefreshCcw className={draftScanning ? "spin" : ""} size={13} /> {draftScanning ? "检查中" : "检查后台草稿"}
          </button>
          {staleDraftTotal > 0 && <button className="secondary-button compact-button" disabled={draftCleaning}
            onClick={() => void cleanStaleDrafts()} type="button">
            {draftCleaning ? "清理中…" : `清理 ${staleDraftTotal} 条`}
          </button>}
        </div>
      </header>
      {draftScan === null
        ? <p className="expand-account-empty">扩组失败、人工中途放弃、断联，都会在 TikTok 后台留下草稿。点上面检查一次——超过 {DRAFT_CLEANUP_MIN_AGE_HOURS} 小时没人动过的才算遗留。</p>
        : staleDraftTotal === 0
          ? <p className="expand-account-empty">
              没有够格清理的草稿。
              {draftProtectedTotal > 0 && `${draftProtectedTotal} 条在保护期内或还挂着「结果未知」，先留着。`}
              {draftScan.some((row) => row.error) && "（部分账户没查成，见下）"}
            </p>
          : <div className="table-wrap expand-table expand-history-table"><table><thead><tr><th>账户</th><th>草稿名</th><th>最后改动</th></tr></thead><tbody>
              {draftScan.flatMap((row) => row.drafts.map((draft) => <tr key={draft.adSketchId}>
                <td className="expand-muted">{accountName.get(row.accountId) ?? row.accountId}</td>
                <td className="expand-name">{draft.adSketchName}</td>
                <td className="expand-muted">{fmtDate(draft.touchedAt)}</td>
              </tr>))}
            </tbody></table></div>}
      {draftScan?.filter((row) => row.error).map((row) => <p className="expand-account-empty" key={row.accountId}>
        <AlertTriangle size={13} /> {accountName.get(row.accountId) ?? row.accountId}：{row.error}
      </p>)}
    </section>

    {presetHost ? createPortal(presetPanel, presetHost) : presetPanel}

    {feedback && <div className={`expand-feedback ${feedback.tone}`}>{feedback.tone === "success" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}<div><strong>{feedback.title}</strong>{feedback.lines.length > 0 && <ul>{feedback.lines.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul>}</div></div>}

    <div className="expand-actions">
      <span className="expand-summary">已选 <b>{selectedValid.length}</b>{totalSelectable > 0 ? ` / ${totalSelectable}` : ""} 个源组 · 预计新增 <b>{selectedValid.length * count}</b> 个广告组{runningBatches > 0 ? ` · ${runningBatches} 批进行中（同账户排队、跨账户并发）` : ""}</span>
      <button className="expand-submit" disabled={selectedValid.length === 0} onClick={() => void submit()} type="button"><CopyPlus size={16} /> 一键扩组</button>
    </div>
  </div>;
}
