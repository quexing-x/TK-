import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CopyPlus, Inbox, Info, RefreshCcw, XCircle } from "lucide-react";
import type {
  AccountConfig,
  AccountProviderCapabilities,
  ManagedEntityRecord,
  ProviderConnection,
  ReadOnlySyncResult,
} from "@tk-auto/core";
import { api } from "./api";
import { hasProviderCapability } from "./provider-capability-view";

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

function withinWindow(createdAt: string | null | undefined, filter: TimeFilter, now: number): boolean {
  if (filter === "all") return true;
  if (!createdAt) return false;
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return false;
  const hours = filter === "24h" ? 24 : 24 * 7;
  return created >= now - hours * 60 * 60_000;
}

export function ExpandGroupsPanel({
  accounts,
  connectionStates,
  onError,
}: {
  accounts: AccountConfig[];
  connectionStates: ConnectionState[];
  onError: (message: string | null) => void;
}) {
  const [entitiesByAccount, setEntitiesByAccount] = useState<Record<string, ManagedEntityRecord[]>>({});
  const [loadingAccounts, setLoadingAccounts] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [conversionFilter, setConversionFilter] = useState<ConversionFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(1);
  const [dailyBudget, setDailyBudget] = useState(100);
  const [bidText, setBidText] = useState("");
  const [launchImmediately, setLaunchImmediately] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const accountName = useMemo(
    () => new Map(accounts.map((account) => [account.id, account.displayName])),
    [accounts],
  );

  // 可扩组账户：已连接 ready、具备 copy-ads 能力、且最近同步为 healthy。
  const eligibleStates = useMemo(
    () => connectionStates.filter((state) =>
      state.connection?.status === "ready"
      && hasProviderCapability(state.capabilities, "copy-ads")
      && state.latestSync?.quality.status === "healthy",
    ),
    [connectionStates],
  );
  const excludedStates = useMemo(
    () => connectionStates.filter((state) => !eligibleStates.includes(state)),
    [connectionStates, eligibleStates],
  );

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

  useEffect(() => {
    for (const state of eligibleStates) {
      if (!(state.accountId in entitiesByAccount)) void loadAccount(state.accountId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibleStates]);

  // 每个账户：解析系列名映射 + 过滤后的广告组列表。
  const groups = useMemo(() => {
    const now = Date.now();
    const normalizedQuery = query.trim().toLowerCase();
    return eligibleStates.map((state) => {
      const entities = entitiesByAccount[state.accountId] ?? [];
      const campaignNames = new Map(
        entities
          .filter((entity) => entity.entityType === "campaign")
          .map((entity) => [entity.externalId, entity.name]),
      );
      const adGroups = entities
        .filter((entity) => entity.entityType === "ad-group" && !entity.ignored)
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
        .sort((left, right) => (right.metrics.spend ?? 0) - (left.metrics.spend ?? 0));
      return {
        accountId: state.accountId,
        displayName: accountName.get(state.accountId) ?? state.accountId,
        providerKind: state.connection?.kind ?? "cookie",
        campaignNames,
        adGroups,
      };
    });
  }, [accountName, conversionFilter, eligibleStates, entitiesByAccount, query, statusFilter, timeFilter]);

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
    setBusy(true);
    setFeedback(null);
    onError(null);
    try {
      const result = await api.batchExpandAdGroups({
        sources,
        count,
        dailyBudget,
        bid,
        launchImmediately,
        sameCampaign: true,
      });
      const lines: string[] = [];
      if (result.failed.length > 0) {
        for (const failure of result.failed) lines.push(`${failure.name} 失败：${failure.message}`);
      }
      if (result.skipped > 0) lines.push(`${result.skipped} 个已扩过或进行中，已跳过。`);
      const created = result.createdGroups > 0;
      setFeedback({
        tone: created ? "success" : "danger",
        title: created ? "创建成功" : "创建失败",
        lines,
      });
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

  return <div className="panel expand-groups-panel">
    <div className="panel-heading"><div><span className="panel-icon"><CopyPlus size={18} /></span><div><h2>一键扩组</h2><p>按账户勾选目标广告组，按预设为每个源组各复制 N 个新组（挂原系列、克隆源创意）。</p></div></div></div>

    <div className="expand-toolbar">
      <label className="expand-filter"><span>时间范围</span><select value={timeFilter} onChange={(event) => setTimeFilter(event.target.value as TimeFilter)}><option value="all">全部</option><option value="24h">近 24 小时</option><option value="7d">近 7 天</option></select></label>
      <label className="expand-filter"><span>转化</span><select value={conversionFilter} onChange={(event) => setConversionFilter(event.target.value as ConversionFilter)}><option value="all">全部</option><option value="has">有转化</option><option value="none">无转化</option></select></label>
      <label className="expand-filter"><span>状态</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}><option value="all">全部</option><option value="enabled">投放中</option><option value="disabled">已暂停</option></select></label>
      <label className="expand-filter grow"><span>搜索</span><input placeholder="广告组名称或 ID" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    </div>

    {excludedStates.length > 0 && <p className="expand-excluded-note"><Info size={14} /> <span>{excludedStates.length} 个账户不可扩组（未连接、无复制能力或同步非健康），已隐藏：{excludedStates.map((state) => accountName.get(state.accountId) ?? state.accountId).join("、")}。</span></p>}

    {groups.length === 0 ? <div className="expand-empty"><Inbox size={30} /><strong>没有可扩组的账户</strong><span>请确认账户已接入、具备复制能力，并在“用户管理”完成一次健康的只读同步。</span></div> : <div className="expand-account-list">
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

    <div className="expand-preset">
      <div className="expand-preset-head"><CopyPlus size={15} /> 扩组预设</div>
      <div className="expand-preset-grid">
        <label className="field"><span>每个源组复制份数</span><input max={10} min={1} type="number" value={count} onChange={(event) => setCount(Math.max(1, Math.min(10, Number(event.target.value) || 1)))} /><small>1–10，命名为“原组名-投放日期-序号”。</small></label>
        <label className="field"><span>日预算</span><input min={1} type="number" value={dailyBudget} onChange={(event) => setDailyBudget(Number(event.target.value))} /><small>覆盖新组的日预算。</small></label>
        <label className="field"><span>出价</span><input placeholder="留空继承源组" value={bidText} onChange={(event) => setBidText(event.target.value)} /><small>留空则继承源组出价。</small></label>
        <label className="expand-toggle"><input checked={launchImmediately} onChange={(event) => setLaunchImmediately(event.target.checked)} type="checkbox" /><span>创建后立即投放</span></label>
      </div>
    </div>

    {feedback && <div className={`expand-feedback ${feedback.tone}`}>{feedback.tone === "success" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}<div><strong>{feedback.title}</strong>{feedback.lines.length > 0 && <ul>{feedback.lines.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul>}</div></div>}

    <div className="expand-actions">
      <span className="expand-summary">已选 <b>{selectedValid.length}</b>{totalSelectable > 0 ? ` / ${totalSelectable}` : ""} 个源组 · 预计新增 <b>{selectedValid.length * count}</b> 个广告组</span>
      <button className="expand-submit" disabled={busy || selectedValid.length === 0} onClick={() => void submit()} type="button"><CopyPlus size={16} /> {busy ? "扩组中…" : "一键扩组"}</button>
    </div>
  </div>;
}
