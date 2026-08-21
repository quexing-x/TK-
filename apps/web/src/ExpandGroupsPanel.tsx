import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, CopyPlus, Inbox, Info, RefreshCcw, XCircle } from "lucide-react";
import type {
  AccountConfig,
  AccountProviderCapabilities,
  ManagedEntityRecord,
  ProviderConnection,
  ReadOnlySyncResult,
} from "@tk-auto/core";
import { api } from "./api";
import { accountAccessStatus } from "./provider-capability-view";
import { useOverlays } from "./ui/overlays";

type ConnectionState = {
  accountId: string;
  connection: ProviderConnection | null;
  latestSync: ReadOnlySyncResult | null;
  capabilities: AccountProviderCapabilities;
};

type TimeFilter = "all" | "24h" | "7d";
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

// 次日 06:00（本地时区），返回 datetime-local 可用的 "YYYY-MM-DDTHH:mm"。
function defaultNextDaySix(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(6, 0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function withinWindow(createdAt: string | null | undefined, filter: TimeFilter, now: number): boolean {
  if (filter === "all") return true;
  if (!createdAt) return false;
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return false;
  const hours = filter === "24h" ? 24 : 24 * 7;
  return created >= now - hours * 60 * 60_000;
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
  const [scheduledAt, setScheduledAt] = useState<string>(defaultNextDaySix);
  const [visibleAccountIds, setVisibleAccountIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [recoveringAccountIds, setRecoveringAccountIds] = useState<string[]>([]);

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
    // 立即投放是不可逆的真实写入，二次确认避免误点。
    if (timingMode === "immediate") {
      const confirmed = await confirm({
        title: "立即投放确认",
        message: `将为 ${selectedValid.length} 个源组各创建 ${count} 个新组并【立即开始投放】（共 ${selectedValid.length * count} 个）。确认立即投放？`,
        confirmLabel: "确认立即投放",
        danger: true,
      });
      if (!confirmed) return;
    }
    setBusy(true);
    setFeedback(null);
    onError(null);
    try {
      const result = await api.batchExpandAdGroups({
        sources,
        count,
        dailyBudget,
        bid,
        launchImmediately: timingMode === "immediate",
        sameCampaign: true,
        scheduledStartAt,
      });
      const lines: string[] = [];
      if (result.failed.length > 0) {
        for (const failure of result.failed) lines.push(`${failure.name} 失败：${failure.message}`);
      }
      if (scheduledStartAt && result.scheduled > 0) {
        lines.push(`${result.scheduled} 个新组已设置 TikTok 原生定时投放：${new Date(scheduledStartAt).toLocaleString()}。`);
      }
      if (result.skipped > 0) lines.push(`${result.skipped} 个已扩过或进行中，已跳过。`);
      const created = result.createdGroups > 0;
      setFeedback({
        tone: created ? "success" : "danger",
        title: created ? "创建成功" : "创建失败",
        lines,
      });
      toast(
        result.failed.length > 0
          ? `扩组完成：成功 ${result.createdGroups} 个广告组，失败 ${result.failed.length} 个广告组`
          : `扩组任务全部成功（${result.createdGroups} 个广告组）`,
        result.failed.length > 0 ? "error" : "success",
      );
      setSelected([]);
      // 扩组后刷新涉及账户，展示新组。
      for (const accountId of new Set(sources.map((source) => source.accountId))) {
        void loadAccount(accountId);
      }
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setBusy(false);
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
        ? <label className="expand-timing-when"><input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} /><small>新组将以开启状态发布，并由 TikTok 在设定时间开始投放。默认次日 06:00，可改。</small></label>
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
      <label className="expand-filter"><span>时间范围</span><select value={timeFilter} onChange={(event) => setTimeFilter(event.target.value as TimeFilter)}><option value="all">全部</option><option value="24h">近 24 小时</option><option value="7d">近 7 天</option></select></label>
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
              <button className="secondary-button compact-button" disabled={busy || groupKeys.length === 0} onClick={() => toggleAccount(group.accountId, groupKeys)} type="button">{allSelected ? "取消本账户" : "全选本账户"}</button>
              <button className="secondary-button compact-button" disabled={isLoading} onClick={() => void loadAccount(group.accountId)} title="重新读取该账户已同步的广告组" type="button"><RefreshCcw size={14} /> {isLoading ? "刷新中" : "刷新"}</button>
            </div>
          </header>
          {group.adGroups.length === 0 ? <p className="expand-account-empty">{isLoading ? "读取中…" : "该账户在当前筛选下没有广告组。"}</p> : <div className="table-wrap expand-table"><table><thead><tr><th className="expand-check-col"><input aria-label="全选本账户" checked={allSelected} disabled={busy || groupKeys.length === 0} onChange={() => toggleAccount(group.accountId, groupKeys)} type="checkbox" /></th><th>广告组</th><th>所属系列</th><th>创建时间</th><th className="expand-num">花费</th><th className="expand-num">转化</th><th className="expand-num">CPA</th><th>状态</th></tr></thead><tbody>
            {group.adGroups.map((entity) => {
              const key = keyOf(group.accountId, entity.externalId);
              const selectable = Boolean(entity.parentCampaignId);
              const checked = selected.includes(key);
              return <tr key={key} className={checked ? "selected" : ""} onClick={() => selectable && !busy && toggle(key)}>
                <td className="expand-check-col"><input checked={checked} disabled={!selectable || busy} onChange={() => toggle(key)} onClick={(event) => event.stopPropagation()} title={selectable ? undefined : "缺少所属系列 ID，无法扩组"} type="checkbox" /></td>
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

    {presetHost ? createPortal(presetPanel, presetHost) : presetPanel}

    {feedback && <div className={`expand-feedback ${feedback.tone}`}>{feedback.tone === "success" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}<div><strong>{feedback.title}</strong>{feedback.lines.length > 0 && <ul>{feedback.lines.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul>}</div></div>}

    <div className="expand-actions">
      <span className="expand-summary">已选 <b>{selectedValid.length}</b>{totalSelectable > 0 ? ` / ${totalSelectable}` : ""} 个源组 · 预计新增 <b>{selectedValid.length * count}</b> 个广告组</span>
      <button className="expand-submit" disabled={busy || selectedValid.length === 0} onClick={() => void submit()} type="button"><CopyPlus size={16} /> {busy ? "扩组中…" : "一键扩组"}</button>
    </div>
  </div>;
}
