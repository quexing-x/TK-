import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, CopyPlus, History, Inbox, Info, RefreshCcw, XCircle } from "lucide-react";
import type {
  AccountConfig,
  AccountProviderCapabilities,
  ManagedEntityRecord,
  ProviderConnection,
  ReadOnlySyncResult,
} from "@tk-auto/core";
import { api, type AdGroupExpandTask } from "./api";
import { accountAccessStatus } from "./provider-capability-view";
import { useOverlays } from "./ui/overlays";

type ConnectionState = {
  accountId: string;
  connection: ProviderConnection | null;
  latestSync: ReadOnlySyncResult | null;
  capabilities: AccountProviderCapabilities;
};

export type TimeFilter = "today" | "yesterday" | "all";
type ConversionFilter = "all" | "has" | "none";
type StatusFilter = "all" | "enabled" | "disabled";

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

/**
 * 按**自然日**判定，不是滚动小时窗。
 *
 * 原来的「近 24 小时」在早上八点看会把昨天上午创建的组算进来，而人想的是「今天建的」。
 * 广告投放本来就是按天结算的，筛选口径跟着自然日走才对得上直觉。
 *
 * 用浏览器本地时区切日：这个面板是纯前端筛选，而账户时区与操作者时区在生产上一致
 * （都是 Asia/Shanghai）。真出现跨时区运营时这里要改成按账户时区切。
 */
export function withinWindow(
  createdAt: string | null | undefined,
  filter: TimeFilter,
  now: number,
): boolean {
  if (filter === "all") return true;
  if (!createdAt) return false;
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return false;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  // today = 今天零点起；yesterday = 昨天零点起（即今天+昨天两天）
  if (filter === "yesterday") midnight.setDate(midnight.getDate() - 1);
  return created >= midnight.getTime();
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
}: {
  accounts: AccountConfig[];
  connectionStates: ConnectionState[];
  onConnectionStatesChanged?: (() => Promise<void>) | undefined;
  onManageConnection?: ((accountId: string) => void) | undefined;
  onError: (message: string | null) => void;
  presetHost?: HTMLElement | null;
}) {
  const { confirm, toast } = useOverlays();
  const [entitiesByAccount, setEntitiesByAccount] = useState<Record<string, ManagedEntityRecord[]>>({});
  const [loadingAccounts, setLoadingAccounts] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
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
      const entities = await api.getManagedEntities(accountId);
      setEntitiesByAccount((current) => ({ ...current, [accountId]: entities }));
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

  // 历史记录跟着「可扩组账户」走，而不是跟着当前展示的账户：刚扩完就把账户取消
  // 勾选，记录不该跟着消失。
  const historyAccountIds = useMemo(
    () => eligibleStates.map((state) => state.accountId),
    [eligibleStates],
  );
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

  const visibleStates = useMemo(
    () => eligibleStates.filter((state) => visibleAccountIds.includes(state.accountId)),
    [eligibleStates, visibleAccountIds],
  );

  // 每个账户：解析系列名映射 + 过滤后的广告组列表。
  const groups = useMemo(() => {
    const now = Date.now();
    const normalizedQuery = query.trim().toLowerCase();
    return visibleStates.map((state) => {
      const entities = entitiesByAccount[state.accountId] ?? [];
      const campaignNames = new Map(
        entities
          .filter((entity) => entity.entityType === "campaign")
          .map((entity) => [entity.externalId, entity.name]),
      );
      const adGroups = entities
        .filter((entity) => entity.entityType === "ad-group" && !entity.ignored)
        // 系列预算(CBO)广告组不能设与系列不同的组预算，扩组必然与 CBO 冲突，直接排除出名单。
        .filter((entity) => !entity.campaignBudgetOptimized)
        .filter((entity) => withinWindow(entity.createdAt, timeFilter, now))
        .filter((entity) => {
          const conversions = entity.metrics.conversions ?? 0;
          if (conversionFilter === "has") return conversions > 0;
          if (conversionFilter === "none") return conversions <= 0;
          return true;
        })
        .filter((entity) => statusFilter === "all" || entity.status === statusFilter)
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
      };
    });
  }, [accountName, conversionFilter, visibleStates, entitiesByAccount, query, statusFilter, timeFilter]);

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
      <label className="expand-filter"><span>时间范围</span><select value={timeFilter} onChange={(event) => setTimeFilter(event.target.value as TimeFilter)}><option value="today">今天</option><option value="yesterday">今天 + 昨天</option><option value="all">全部</option></select></label>
      <label className="expand-filter"><span>转化</span><select value={conversionFilter} onChange={(event) => setConversionFilter(event.target.value as ConversionFilter)}><option value="all">全部</option><option value="has">有转化</option><option value="none">无转化</option></select></label>
      <label className="expand-filter"><span>状态</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}><option value="all">全部</option><option value="enabled">投放中</option><option value="disabled">已暂停</option></select></label>
      <label className="expand-filter grow"><span>搜索</span><input placeholder="广告组名称或 ID" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    </div>

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
          {group.adGroups.length === 0 ? <p className="expand-account-empty">{isLoading ? "读取中…" : "该账户在当前筛选下没有广告组。"}</p> : <div className="table-wrap expand-table"><table><thead><tr><th className="expand-check-col"><input aria-label="全选本账户" checked={allSelected} disabled={groupKeys.length === 0} onChange={() => toggleAccount(group.accountId, groupKeys)} type="checkbox" /></th><th>广告组</th><th>所属系列</th><th>创建时间</th><th className="expand-num">花费</th><th className="expand-num">转化</th><th className="expand-num">CPA</th><th>状态</th></tr></thead><tbody>
            {group.adGroups.map((entity) => {
              const key = keyOf(group.accountId, entity.externalId);
              const selectable = Boolean(entity.parentCampaignId);
              const checked = selected.includes(key);
              return <tr key={key} className={checked ? "selected" : ""} onClick={() => selectable && toggle(key)}>
                <td className="expand-check-col"><input checked={checked} disabled={!selectable} onChange={() => toggle(key)} onClick={(event) => event.stopPropagation()} title={selectable ? undefined : "缺少所属系列 ID，无法扩组"} type="checkbox" /></td>
                <td className="expand-name">{entity.name}</td>
                <td className="expand-muted">{entity.parentCampaignId ? group.campaignNames.get(entity.parentCampaignId) ?? entity.parentCampaignId : "—"}</td>
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

    <section className="expand-history">
      <header className="expand-history-head">
        <span><History size={15} /> 扩组记录</span>
        <button className="secondary-button compact-button" disabled={historyLoading} onClick={() => void loadHistory(historyAccountIds)} type="button">
          <RefreshCcw className={historyLoading ? "spin" : ""} size={13} /> {historyLoading ? "读取中" : "刷新"}
        </button>
      </header>
      {history.length === 0
        ? <p className="expand-account-empty">{historyLoading ? "读取中…" : "还没有扩组记录。"}</p>
        : <div className="table-wrap expand-table"><table><thead><tr><th>时间</th><th>账户</th><th>新组名</th><th className="expand-num">个数</th><th>结果</th></tr></thead><tbody>
          {history.map((task) => {
            // 结果未知优先于成功/进行中显示：这类记录禁止自动重试，必须让人一眼看见。
            const tone = task.uncertain ? "danger" : task.status === "succeeded" ? "active" : "warning";
            const label = task.uncertain ? "结果未知，需人工核实" : task.status === "succeeded" ? "成功" : "进行中";
            return <tr key={task.taskKey}>
              <td className="expand-muted">{fmtDate(task.updatedAt)}</td>
              <td className="expand-muted">{accountName.get(task.accountId) ?? task.accountId}</td>
              <td className="expand-name">{task.generatedNames.join("、") || "—"}</td>
              <td className="expand-num">{task.requestedCount}</td>
              <td><span className={`status ${tone}`}>{task.uncertain && <AlertTriangle size={12} />} {label}</span></td>
            </tr>;
          })}
        </tbody></table></div>}
    </section>

    {presetHost ? createPortal(presetPanel, presetHost) : presetPanel}

    {feedback && <div className={`expand-feedback ${feedback.tone}`}>{feedback.tone === "success" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}<div><strong>{feedback.title}</strong>{feedback.lines.length > 0 && <ul>{feedback.lines.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul>}</div></div>}

    <div className="expand-actions">
      <span className="expand-summary">已选 <b>{selectedValid.length}</b>{totalSelectable > 0 ? ` / ${totalSelectable}` : ""} 个源组 · 预计新增 <b>{selectedValid.length * count}</b> 个广告组{runningBatches > 0 ? ` · ${runningBatches} 批进行中（同账户排队、跨账户并发）` : ""}</span>
      <button className="expand-submit" disabled={selectedValid.length === 0} onClick={() => void submit()} type="button"><CopyPlus size={16} /> 一键扩组</button>
    </div>
  </div>;
}
