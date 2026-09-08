import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, ArrowSquareOut, ClockCounterClockwise, MagnifyingGlass, Pause, PencilSimple, Play, Plug, Plus, Trash, UsersThree, WarningCircle } from "@phosphor-icons/react";
import type { AccountConfig, AdOperationRecord, AutomationRunRecord, DailyMetricRecord } from "@tk-auto/core";
import { api } from "./api";
import { accountHealth, accountLocalDate, accountTypeNames, filterManagedAccounts, providerNames, type ConnectionMap } from "./account-management-model";
import { Badge, Button, Checkbox, ControlRail, Drawer, EmptyState, Pagination } from "./ui/production/primitives";

type MetricState = { day?: DailyMetricRecord | undefined; error?: string; loading?: boolean };
type ActivityState = { loading: boolean; runs: AutomationRunRecord[]; operations: AdOperationRecord[]; error: string | null };
type DrawerAnomaly = { id: string; title: string; message: string; at: string };
type Props = {
  accounts: AccountConfig[]; states: ConnectionMap; canManage: boolean; saving: boolean; runtimeEnabled: boolean;
  canEnable: (account: AccountConfig) => boolean;
  onNew: () => void; onEdit: (account: AccountConfig) => void; onConnect: (account: AccountConfig) => void;
  onDelete: (account: AccountConfig) => Promise<void>; onToggle: (account: AccountConfig) => Promise<void>;
  onRefresh: () => Promise<void>; onBulk: (accounts: AccountConfig[], enabled: boolean) => Promise<void>;
};
function timestamp(value?: string) {
  if (!value) return "尚未同步";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间不可用" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
const runTriggerName: Record<AutomationRunRecord["trigger"], string> = { scheduler: "后台轮询", manual: "手动运行", preview: "检测预览" };
const runStatusName: Record<AutomationRunRecord["status"], string> = { running: "进行中", completed: "已完成", failed: "失败" };
const operationActionName: Record<AdOperationRecord["action"], string> = { enable: "开启", disable: "关闭", ignore: "加入忽略", unignore: "取消忽略", appeal: "申诉", delete: "删除广告组" };
const operationStatusName: Record<AdOperationRecord["status"], string> = { pending: "等待执行", running: "执行中", succeeded: "成功", failed: "失败", unknown: "待确认", cancelled: "已取消" };
function activityStatusTone(status: string): "neutral" | "healthy" | "warning" | "danger" {
  if (status === "completed" || status === "succeeded") return "healthy";
  if (status === "failed") return "danger";
  if (status === "unknown" || status === "running" || status === "pending") return "warning";
  return "neutral";
}
export function AccountManagement(props: Props) {
  const { accounts, states, canManage, canEnable, runtimeEnabled } = props;
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("all");
  const [status, setStatus] = useState("all");
  const [scope, setScope] = useState("all");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operationLock = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Record<string, MetricState>>({});
  const [activity, setActivity] = useState<ActivityState>({ loading: false, runs: [], operations: [], error: null });
  const [activityView, setActivityView] = useState<"anomalies" | "executions" | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const filtered = useMemo(() => filterManagedAccounts(accounts, states, query, platform, status, scope), [accounts, states, query, platform, status, scope]);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / size)));
  const visible = filtered.slice((currentPage - 1) * size, currentPage * size);
  const detail = accounts.find((a) => a.id === detailId);
  const selectedAccounts = accounts.filter((a) => selected.has(a.id));
  const visibleSelected = visible.filter((a) => selected.has(a.id)).length;
  const metricTargets = [...visible, ...(detail && !visible.some((a) => a.id === detail.id) ? [detail] : [])];
  const metricKey = JSON.stringify(metricTargets.map((a) => [a.id, a.timezone, states[a.id]?.latestSync?.finishedAt]));
  useEffect(() => { setPage(1); setSelected(new Set()); }, [query, platform, status, scope, size]);
  useEffect(() => { setSelected((previous) => new Set([...previous].filter((id) => accounts.some((a) => a.id === id)))); }, [accounts]);
  useEffect(() => {
    if (!detailId) {
      setActivity({ loading: false, runs: [], operations: [], error: null });
      return;
    }
    let cancelled = false;
    setActivity({ loading: true, runs: [], operations: [], error: null });
    Promise.all([api.getAutomationRuns(detailId), api.getAdOperations(detailId)])
      .then(([runs, operations]) => { if (!cancelled) setActivity({ loading: false, runs, operations, error: null }); })
      .catch((error) => { if (!cancelled) setActivity({ loading: false, runs: [], operations: [], error: error instanceof Error ? error.message : "记录读取失败" }); });
    return () => { cancelled = true; };
  }, [detailId, refresh]);
  useEffect(() => { setActivityView(null); setRecoveryBusy(null); }, [detailId]);
  useEffect(() => {
    let cancelled = false;
    const targets = JSON.parse(metricKey) as Array<[string, string, string | undefined]>;
    let cursor = 0;
    setMetrics((old) => ({ ...old, ...Object.fromEntries(targets.map(([id]) => [id, { loading: true }])) }));
    async function worker() {
      while (!cancelled && cursor < targets.length) {
        const [id, timezone] = targets[cursor++]!;
        try {
          const date = accountLocalDate(timezone);
          const days = await api.getMetricDays(id, { from: date, to: date }, "ad-group");
          if (!cancelled) setMetrics((old) => ({ ...old, [id]: { day: days.find((d) => d.date === date) } }));
        } catch (error) {
          if (!cancelled) setMetrics((old) => ({ ...old, [id]: { error: error instanceof Error ? error.message : "指标读取失败" } }));
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
    return () => { cancelled = true; };
  }, [metricKey, refresh]);
  const run = async (operation: () => Promise<void>) => {
    if (operationLock.current) return;
    operationLock.current = true; setBusy(true); setActionError(null);
    try { await operation(); } catch (error) { setActionError(error instanceof Error ? error.message : "操作失败，请重试。"); }
    finally { operationLock.current = false; setBusy(false); }
  };
  const refreshData = () => run(async () => { await props.onRefresh(); setRefresh((n) => n + 1); });
  const recover = (step: string, action: () => Promise<void>) => {
    void run(async () => { setRecoveryBusy(step); try { await action(); } finally { setRecoveryBusy(null); } });
  };
  const disabled = busy || props.saving;
  const healthCounts = accounts.reduce((result, a) => { result[accountHealth(states[a.id]).tone]++; return result; }, { healthy: 0, warning: 0, danger: 0 });
  const renderSpend = (account: AccountConfig) => {
    const metric = metrics[account.id];
    if (!metric || metric.loading) return <span className="p-loading-text" role="status">读取中…</span>;
    if (metric.error) return <button type="button" className="p-metric-error" title={metric.error} onClick={() => setRefresh((n) => n + 1)}>读取失败 · 重试</button>;
    if (!metric.day) return <><span className="p-number">—</span><small>暂无今日数据</small></>;
    return <><strong className="p-number">{metric.day.spend.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong><small>截至 {metric.day.lastLocalTime}</small></>;
  };
  return <section className="p-accounts" aria-label="账户管理">
    <header className="p-page-heading"><div><h1>账户管理<span>{accounts.length}</span></h1><p>管理广告账户接入、同步与自动化</p></div><div className="p-actions"><Button busy={busy} onClick={() => void refreshData()}><ArrowClockwise size={16} />刷新状态</Button><Button tone="primary" disabled={!canManage || disabled} onClick={props.onNew}><Plus size={16} />新增账户</Button></div></header>
    <div className="p-account-overview" aria-label="按账户状态筛选">
      {([
        ["all", "全部", accounts.length, ""],
        ["healthy", "健康", healthCounts.healthy, "healthy"],
        ["warning", "待完善", healthCounts.warning, "warning"],
        ["danger", "异常", healthCounts.danger, "danger"],
      ] as const).map(([value, label, count, tone]) => <button key={value} type="button" className={status === value ? "is-active" : ""} aria-pressed={status === value} onClick={() => setStatus(value)}><i className={`p-dot ${tone}`} />{label} <strong>{count}</strong></button>)}
    </div>
    {actionError && <div role="alert" className="p-feedback"><WarningCircle size={18} />{actionError}</div>}
    {!canManage && <p className="p-readonly">当前为只读权限，可查看账户与指标。</p>}
    <div className="p-account-surface">
      <div className="p-filters"><label className="p-search"><MagnifyingGlass size={18} /><input aria-label="搜索账户" placeholder="搜索账户名称或 ID" value={query} onChange={(e) => setQuery(e.target.value)} /></label><label>账户状态<select aria-label="账户状态筛选" value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">全部状态</option><option value="healthy">健康</option><option value="warning">待完善</option><option value="danger">异常</option></select></label><label>平台<select aria-label="平台筛选" value={platform} onChange={(e) => setPlatform(e.target.value)}><option value="all">全部平台</option><option value="tiktok">TikTok Ads</option></select></label><label>自动化<select aria-label="自动化范围筛选" value={scope} onChange={(e) => setScope(e.target.value)}><option value="all">全部账户</option><option value="enabled">开关已开启</option><option value="disabled">开关已关闭</option></select></label></div>
      {selectedAccounts.length > 0 && <div className="p-selection" role="status"><strong>已选择 {selectedAccounts.length} 个账户</strong><Button disabled={!canManage || disabled || !selectedAccounts.some((a) => !a.enabled && canEnable(a))} onClick={() => void run(() => props.onBulk(selectedAccounts, true))}><Play size={14} />开启自动化</Button><Button disabled={!canManage || disabled || !selectedAccounts.some((a) => a.enabled)} onClick={() => void run(() => props.onBulk(selectedAccounts, false))}><Pause size={14} />关闭自动化</Button><Button tone="quiet" disabled={disabled} onClick={() => setSelected(new Set())}>取消选择</Button></div>}
      <div className="p-table-scroll"><table className="p-account-table"><thead><tr><th className="p-check-cell"><Checkbox aria-label="选择本页账户" checked={visible.length > 0 && visibleSelected === visible.length} mixed={visibleSelected > 0 && visibleSelected < visible.length} disabled={!visible.length || disabled} onChange={(e) => setSelected((old) => { const next = new Set(old); visible.forEach((a) => e.target.checked ? next.add(a.id) : next.delete(a.id)); return next; })} /></th><th>账户</th><th>平台 / 类型</th><th>账户状态</th><th>最近同步</th><th className="p-numeric">今日消耗</th><th>自动化</th><th>操作</th></tr></thead><tbody>
        {visible.map((account) => { const health = accountHealth(states[account.id]); const sync = states[account.id]?.latestSync; const suspended = account.enabled && !runtimeEnabled; return <tr key={account.id} className={selected.has(account.id) ? "is-selected" : ""}><td className="p-check-cell"><Checkbox aria-label={`选择 ${account.displayName}`} checked={selected.has(account.id)} disabled={disabled} onChange={(e) => setSelected((old) => { const next = new Set(old); if (e.target.checked) next.add(account.id); else next.delete(account.id); return next; })} /></td><td><button className="p-account-name" type="button" onClick={() => setDetailId(account.id)}>{account.displayName}</button><small className="p-number p-account-id" title={account.id}>{account.id}</small></td><td><span>TikTok Ads</span><small>{accountTypeNames[account.accountType]}</small></td><td><Badge tone={health.tone}>{health.label}</Badge></td><td><span>{timestamp(sync?.finishedAt)}</span><small className={sync && sync.quality.status !== "healthy" ? "p-warning-text" : ""}>{sync ? sync.quality.status === "healthy" ? "同步完成" : "数据待检查" : "等待首次同步"}</small></td><td className="p-numeric">{renderSpend(account)}</td><td><button type="button" role="switch" aria-checked={account.enabled} aria-label={`${account.displayName}账户自动化配置`} className={`p-switch ${account.enabled ? "is-on" : ""} ${suspended ? "is-suspended" : ""}`} disabled={!canManage || disabled || (!account.enabled && !canEnable(account))} title={!account.enabled && !canEnable(account) ? "需完成接入与启停能力检测" : suspended ? "账户自动化配置已开启；全局自动化暂停期间不会执行" : undefined} onClick={() => void run(() => props.onToggle(account))}><span /></button><small>{!account.enabled ? "已关闭" : suspended ? "已开启 · 全局暂停" : !canEnable(account) ? "已开启 · 能力异常" : "已开启"}</small></td><td><div className="p-row-actions"><Button tone="quiet" className="p-compact" onClick={() => setDetailId(account.id)}>详情<ArrowSquareOut size={14} /></Button><Button tone="quiet" className="p-compact" disabled={!canManage || disabled} onClick={() => props.onConnect(account)}>接入</Button></div></td></tr>; })}
      </tbody></table></div>
      {visible.length === 0 && <EmptyState icon={<UsersThree size={32} />} title={accounts.length ? "没有匹配的账户" : "还没有广告账户"}>{accounts.length ? <><p>试试其他关键词或筛选条件。</p><Button onClick={() => { setQuery(""); setPlatform("all"); setStatus("all"); setScope("all"); }}>清除筛选</Button></> : <><p>添加账户后即可配置接入并查看同步状态。</p><Button tone="primary" disabled={!canManage} onClick={props.onNew}>新增账户</Button></>}</EmptyState>}
      <Pagination page={currentPage} total={filtered.length} size={size} onPage={setPage} onSize={setSize} />
    </div><p className="p-data-note">今日消耗按各账户时区统计，保留账户原币数值。</p>
    {detail && (() => {
      const state = states[detail.id];
      const health = accountHealth(state);
      const allExecutions = [
        ...activity.runs.map((item) => ({ id: `run:${item.id}`, at: item.startedAt, title: runTriggerName[item.trigger], detail: `命中 ${item.candidateCount} · 执行 ${item.actionCount} · 成功 ${item.successCount} · 失败 ${item.failureCount}`, status: runStatusName[item.status], tone: activityStatusTone(item.status) })),
        ...activity.operations.map((item) => ({ id: `operation:${item.id}`, at: item.updatedAt, title: `${operationActionName[item.action]} · ${item.entityName}`, detail: item.message ?? (item.source === "automation" ? "账户自动化" : item.source === "scheduled" ? "定时任务" : "人工操作"), status: operationStatusName[item.status], tone: activityStatusTone(item.status) })),
      ].sort((a, b) => b.at.localeCompare(a.at));
      const anomalyCandidates: DrawerAnomaly[] = [
        ...health.blockers.map((message, index) => ({ id: `health:${index}`, title: "账户状态", message, at: state?.connection?.lastTestedAt ?? "" })),
        ...(state?.latestSync?.warnings ?? []).map((message, index) => ({ id: `warning:${index}`, title: "同步警告", message, at: state?.latestSync?.finishedAt ?? "" })),
        ...(state?.latestSync?.quality.partialFailures ?? []).map((message, index) => ({ id: `partial:${index}`, title: "同步异常", message, at: state?.latestSync?.finishedAt ?? "" })),
        ...activity.runs.filter((item) => item.status === "failed" || item.failureCount > 0).map((item) => ({ id: `run:${item.id}`, title: "自动化运行", message: item.errorMessage ?? `${item.failureCount} 项执行失败`, at: item.finishedAt ?? item.startedAt })),
        ...activity.operations.filter((item) => item.status === "failed" || item.status === "unknown" || item.syncWarning).map((item) => ({ id: `operation:${item.id}`, title: `${operationActionName[item.action]} · ${item.entityName}`, message: item.syncWarning ?? item.message ?? "执行结果需要确认", at: item.updatedAt })),
      ];
      const seenAnomalies = new Set<string>();
      const allAnomalies = anomalyCandidates.filter((item) => !seenAnomalies.has(item.message) && Boolean(seenAnomalies.add(item.message))).sort((a, b) => b.at.localeCompare(a.at));
      const recentExecutions = allExecutions.slice(0, 4);
      const anomalies = allAnomalies.slice(0, 3);
      return <Drawer title="账户详情" onClose={() => setDetailId(null)}>
        <div className="p-detail-title"><span className="p-detail-avatar"><UsersThree size={24} /></span><div><h3>{detail.displayName}</h3><small className="p-number">{detail.id}</small><span>TikTok Ads · {accountTypeNames[detail.accountType]} · 最近同步 {timestamp(state?.latestSync?.finishedAt)}</span></div><Badge tone={health.tone}>{health.label}</Badge></div>
        <div className="p-detail-metrics">
          <div><span>今日消耗</span>{renderSpend(detail)}</div>
          <div><span>最近同步</span><strong>{timestamp(state?.latestSync?.finishedAt)}</strong><small>{state?.latestSync ? state.latestSync.quality.status === "healthy" ? "同步完成" : "数据待检查" : "等待首次同步"}</small></div>
          <div><span>最后成功同步</span><strong>{timestamp(state?.latestSync?.quality.lastHealthyAt ?? undefined)}</strong><small>{state?.latestSync?.quality.lastHealthyAt ? "健康快照" : "尚无健康快照"}</small></div>
          <div><span>自动化配置</span><strong>{detail.enabled ? "已开启" : "已关闭"}</strong><small>{detail.enabled && !runtimeEnabled ? "受全局暂停影响，当前不执行" : detail.enabled ? "全局运行中" : "不参与自动执行"}</small></div>
        </div>
        <h3>账户信息</h3>
        <dl className="p-detail-list"><dt>平台</dt><dd>TikTok Ads</dd><dt>账户类型</dt><dd>{accountTypeNames[detail.accountType]}</dd><dt>账户状态</dt><dd><Badge tone={health.tone}>{health.label}</Badge></dd><dt>接入方式</dt><dd>{providerNames[detail.providerKind]}</dd><dt>账户时区</dt><dd>{detail.timezone}</dd></dl>
        <h3>账户能力</h3>
        <ControlRail steps={(() => {
          const capabilityReason = (name: string, fallback: string) => state?.capabilities?.capabilities.find((item) => item.capability === name)?.reason ?? fallback;
          const failureAt = state?.connection?.lastTestedAt ?? state?.connection?.updatedAt ?? state?.latestSync?.finishedAt ?? undefined;
          const reconnect = { label: "重新接入", onClick: () => { setDetailId(null); props.onConnect(detail); }, disabled: !canManage || disabled };
          const recheck = (step: string) => ({ label: "重新检测", busy: recoveryBusy === step, disabled: !canManage || disabled || !state?.connection?.hasCredential, onClick: () => recover(step, async () => { await api.testConnection(detail.id, state?.connection?.kind ?? detail.providerKind); await props.onRefresh(); setRefresh((value) => value + 1); }) });
          const sync = { label: "重新同步", busy: recoveryBusy === "sync", disabled: !canManage || disabled || !health.connectionReady, onClick: () => recover("sync", async () => { await api.syncReadOnly(detail.id, state?.connection?.kind ?? detail.providerKind); await props.onRefresh(); setRefresh((value) => value + 1); }) };
          return [
            { label: "凭据", ready: state?.connection?.hasCredential === true, detail: state?.connection?.hasCredential ? "已保存接入凭据" : "尚未保存有效凭据", failureReason: state?.connection?.hasCredential ? undefined : "账户还没有可用凭据。", lastFailureAt: failureAt, recovery: reconnect },
            { label: "连接", ready: health.connectionReady, detail: health.connectionReady ? "连接检测通过" : "等待连接检测通过", failureReason: health.connectionReady ? undefined : (state?.connection?.lastMessage ?? capabilityReason("read-campaigns", "连接检测未通过。")), lastFailureAt: failureAt, recovery: state?.connection?.hasCredential ? recheck("connection") : reconnect },
            { label: "同步", ready: health.readReady, detail: health.readReady ? "系列与广告组数据可用" : "读取能力或同步数据尚未就绪", failureReason: health.readReady ? undefined : (state?.latestSync?.quality.status === "partial" ? "最近同步只完成了部分数据。" : state?.latestSync?.quality.status === "stale" ? "最近同步数据已过期。" : capabilityReason("read-ad-groups", "尚未完成只读同步。")), lastFailureAt: state?.latestSync?.finishedAt ?? failureAt, recovery: health.connectionReady ? sync : reconnect },
            { label: "创建", ready: health.createReady, detail: health.createReady ? "可创建广告系列" : "尚无可用创建能力", failureReason: health.createReady ? undefined : capabilityReason("create-campaigns", "创建广告系列能力未就绪。"), lastFailureAt: failureAt, recovery: state?.connection?.hasCredential ? recheck("create") : reconnect },
            { label: "执行", ready: health.statusReady, detail: health.statusReady ? "广告启停能力可用" : "尚无可用启停能力", failureReason: health.statusReady ? undefined : capabilityReason("change-status", "广告启停能力未就绪。"), lastFailureAt: failureAt, recovery: state?.connection?.hasCredential ? recheck("status") : reconnect },
          ];
        })()} />
        <section className="p-detail-section" aria-labelledby="account-anomalies"><div className="p-section-heading"><h3 id="account-anomalies">最近异常</h3>{!activity.loading && !activity.error && allAnomalies.length > 0 && <Button tone="quiet" className="p-link-button" onClick={() => setActivityView("anomalies")}>查看全部</Button>}</div>{activity.loading ? <p className="p-activity-state" role="status">正在读取账户记录…</p> : activity.error ? <div className="p-activity-state is-error"><span>{activity.error}</span><Button onClick={() => setRefresh((value) => value + 1)}>重试</Button></div> : anomalies.length ? <ul className="p-anomaly-list">{anomalies.map((item) => <li key={item.id}><WarningCircle size={16} /><div><strong>{item.title}</strong><p>{item.message}</p>{item.at && <time dateTime={item.at}>{timestamp(item.at)}</time>}</div></li>)}</ul> : <p className="p-activity-state">近期没有异常记录。</p>}</section>
        <section className="p-detail-section" aria-labelledby="account-executions"><div className="p-section-heading"><h3 id="account-executions">最近执行记录</h3>{!activity.loading && !activity.error && allExecutions.length > 0 && <Button tone="quiet" className="p-link-button" onClick={() => setActivityView("executions")}>查看全部</Button>}</div>{activity.loading ? <p className="p-activity-state" role="status">正在读取执行记录…</p> : activity.error ? <p className="p-activity-state is-error">记录暂时无法读取。</p> : recentExecutions.length ? <ul className="p-execution-list">{recentExecutions.map((item) => <li key={item.id}><span className="p-activity-icon"><ClockCounterClockwise size={16} /></span><div><strong>{item.title}</strong><p>{item.detail}</p><time dateTime={item.at}>{timestamp(item.at)}</time></div><Badge tone={item.tone}>{item.status}</Badge></li>)}</ul> : <p className="p-activity-state">近期没有执行记录。</p>}</section>
        <div className="p-detail-actions"><div className="p-action-group"><Button tone="primary" disabled={!canManage || disabled} onClick={() => { setDetailId(null); props.onEdit(detail); }}><PencilSimple size={16} />账户设置</Button><Button disabled={!canManage || disabled} onClick={() => { setDetailId(null); props.onConnect(detail); }}><Plug size={16} />重新接入</Button></div><div className="p-action-group p-action-group-danger"><Button tone="danger" disabled={!canManage || disabled} onClick={() => { setDetailId(null); void run(() => props.onDelete(detail)); }}><Trash size={16} />删除账户</Button></div></div>
        {activityView && <div className="p-activity-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setActivityView(null); }}><section className="p-activity-dialog" role="dialog" aria-modal="true" aria-labelledby="activity-dialog-title"><header><div><span className="p-eyebrow">账户记录</span><h3 id="activity-dialog-title">{activityView === "anomalies" ? "全部异常" : "全部执行记录"}</h3></div><Button tone="quiet" onClick={() => setActivityView(null)} aria-label="关闭全部记录">关闭</Button></header>{activityView === "anomalies" ? <ul className="p-anomaly-list">{allAnomalies.map((item) => <li key={item.id}><WarningCircle size={16} /><div><strong>{item.title}</strong><p>{item.message}</p>{item.at && <time dateTime={item.at}>{timestamp(item.at)}</time>}</div></li>)}</ul> : <ul className="p-execution-list">{allExecutions.map((item) => <li key={item.id}><span className="p-activity-icon"><ClockCounterClockwise size={16} /></span><div><strong>{item.title}</strong><p>{item.detail}</p><time dateTime={item.at}>{timestamp(item.at)}</time></div><Badge tone={item.tone}>{item.status}</Badge></li>)}</ul>}</section></div>}
      </Drawer>;
    })()}
  </section>;
}
