import {
  Activity,
  AlertTriangle,
  BarChart3,
  Ban,
  BookOpen,
  Check,
  ChevronDown,
  CircleGauge,
  Database,
  Gauge,
  Layers3,
  ListFilter,
  Plus,
  Pencil,
  PlugZap,
  Play,
  RefreshCcw,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  AccountConfig,
  AccountSettingsUpdate,
  AccountCreateInput,
  GlobalAutomationSettings,
  AutomationDecisionRecord,
  AutomationRunRecord,
  AdOperationRecord,
  EntityMetricSnapshotRecord,
  ManagedEntityRecord,
  ProviderConnection,
  ProviderKind,
  ThresholdConfig,
} from "@tk-auto/core";
import {
  api,
  type BootstrapPayload,
  type CookieConnectionReadiness,
} from "./api";
import { ConnectionPage } from "./ConnectionPage";
import { ManualPage } from "./ManualPage";
import { RulesPage } from "./RulesPage";

type PageKey =
  | "manual"
  | "users"
  | "automation"
  | "ads"
  | "analytics"
  | "rules";

const navItems: Array<{
  key: PageKey;
  label: string;
  description: string;
  icon: typeof Settings2;
}> = [
  {
    key: "manual",
    label: "操作手册",
    description: "API 与 Cookie 详细教程",
    icon: BookOpen,
  },
  {
    key: "users",
    label: "用户管理",
    description: "多广告账户与独立配置",
    icon: UserRound,
  },
  {
    key: "automation",
    label: "自动化中心",
    description: "检测、预览与执行记录",
    icon: Play,
  },
  {
    key: "ads",
    label: "广告管理",
    description: "筛选、忽略与手动启停",
    icon: ListFilter,
  },
  {
    key: "analytics",
    label: "广告分析",
    description: "指标快照与执行结果",
    icon: BarChart3,
  },
  {
    key: "rules",
    label: "规则配置",
    description: "九条全局自动化规则",
    icon: Gauge,
  },
];

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [page, setPage] = useState<PageKey>("manual");
  const [error, setError] = useState<string | null>(null);

  const loadBootstrap = useCallback(async () => {
    try {
      const payload = await api.bootstrap();
      setBootstrap(payload);
      setSelectedAccountId((current) => current || payload.accounts[0]?.id || "");
      setError(null);
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  const account = bootstrap?.accounts.find(
    (item) => item.id === selectedAccountId,
  );

  if (!bootstrap) {
    return (
      <div className="center-state">
        <div className="loader" />
        <strong>正在加载本地配置</strong>
        {error && <p className="error-text">{error}</p>}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Activity size={22} />
          </div>
          <div>
            <strong>TK Ads</strong>
            <span>Automation Console</span>
          </div>
        </div>

        <div className="phase-card">
          <span className="phase-dot" />
          <div>
            <strong>本地自动化引擎</strong>
            <small>检测、决策、执行与审计</small>
          </div>
        </div>

        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={page === item.key ? "nav-item active" : "nav-item"}
                key={item.key}
                onClick={() => setPage(item.key)}
                type="button"
              >
                <Icon size={19} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <ShieldCheck size={18} />
          <span>本地模式 · 仅监听 127.0.0.1</span>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="eyebrow">核心控制台</span>
            <h1>{navItems.find((item) => item.key === page)?.label}</h1>
          </div>
        </header>

        {error && (
          <div className="alert error-alert">
            <AlertTriangle size={18} />
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)}>
              <X size={16} />
            </button>
          </div>
        )}

        {page === "manual" ? (
          <ManualPage />
        ) : page === "users" ? (
          <UsersPage
            accounts={bootstrap.accounts}
            onChanged={loadBootstrap}
            onError={setError}
          />
        ) : page === "rules" ? (
          <RulesPage
            settings={bootstrap.globalAutomationSettings}
            onSettingsSaved={loadBootstrap}
            onError={setError}
          />
        ) : !account ? (
          <EmptyState text="请选择一个账户。" />
        ) : page === "automation" ? (
          <AccountScopedPage accounts={bootstrap.accounts} selectedId={selectedAccountId} onSelect={setSelectedAccountId}>
            <AutomationPage account={account} maxActionsPerRun={bootstrap.globalAutomationSettings.maxActionsPerRun} onError={setError} />
          </AccountScopedPage>
        ) : page === "ads" ? (
          <AccountScopedPage accounts={bootstrap.accounts} selectedId={selectedAccountId} onSelect={setSelectedAccountId}>
            <AdsManagementPage account={account} onError={setError} />
          </AccountScopedPage>
        ) : page === "analytics" ? (
          <AccountScopedPage accounts={bootstrap.accounts} selectedId={selectedAccountId} onSelect={setSelectedAccountId}>
            <AnalyticsPage account={account} onError={setError} />
          </AccountScopedPage>
        ) : (
          <EmptyState text="页面不存在。" />
        )}
      </main>
    </div>
  );
}

const defaultAccountInput: AccountCreateInput = {
  displayName: "",
  accountType: "standard",
  enabled: true,
  providerKind: "cookie",
};

function UsersPage({
  accounts,
  onChanged,
  onError,
}: {
  accounts: AccountConfig[];
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [editing, setEditing] = useState<AccountConfig | null>(null);
  const [form, setForm] = useState<AccountCreateInput>(defaultAccountInput);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState<AccountConfig | null>(null);
  const [connectionStates, setConnectionStates] = useState<
    Record<
      string,
      {
        connection: ProviderConnection | null;
        readiness: CookieConnectionReadiness | null;
      }
    >
  >({});

  const loadConnectionStates = useCallback(async () => {
    const entries = await Promise.all(
      accounts.map(async (account) => {
        const [list, readiness] = await Promise.all([
          api.getConnections(account.id).catch(() => []),
          account.providerKind === "cookie"
            ? api.getCookieReadiness(account.id).catch(() => null)
            : Promise.resolve(null),
        ]);
        return [
          account.id,
          {
            connection:
              list.find((item) => item.kind === account.providerKind) ?? null,
            readiness,
          },
        ] as const;
      }),
    );
    setConnectionStates(Object.fromEntries(entries));
  }, [accounts]);

  useEffect(() => {
    void loadConnectionStates();
    const timer = window.setInterval(() => void loadConnectionStates(), 30_000);
    return () => window.clearInterval(timer);
  }, [loadConnectionStates]);

  const openNew = () => {
    setEditing(null);
    setForm(defaultAccountInput);
    setShowForm(true);
  };

  const openEdit = (account: AccountConfig) => {
    setEditing(account);
    setForm(settingsFromAccount(account));
    setShowForm(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setSaving(true);
      if (editing) await api.updateSettings(editing.id, form);
      else await api.createAccount(form);
      await onChanged();
      setShowForm(false);
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const toggleAccount = async (account: AccountConfig) => {
    try {
      await api.updateSettings(account.id, {
        ...settingsFromAccount(account),
        enabled: !account.enabled,
      });
      await onChanged();
    } catch (cause) {
      onError(getErrorMessage(cause));
    }
  };

  return (
    <section className="page-stack">
      <div className="panel table-panel">
        <div className="panel-heading">
          <div>
            <span className="panel-icon"><UserRound size={18} /></span>
            <div>
              <h2>TikTok 广告账户</h2>
              <p>账户开启自动化后默认按全局规则执行；接入凭据仍按账户独立保存。</p>
            </div>
          </div>
          <button className="primary-button" onClick={openNew} type="button">
            <Plus size={17} /> 新增账户
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>账户名称</th>
                <th>账户类型</th>
                <th>接入方式</th>
                <th>接入状态</th>
                <th>自动化开关</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td><strong>{account.displayName}</strong><br /><small>{account.id}</small></td>
                  <td>{accountTypeLabel(account.accountType)}</td>
                  <td>{providerLabel(account.providerKind)}</td>
                  <td>{connectionStateLabel(connectionStates[account.id], account.providerKind)}</td>
                  <td><span className={account.enabled ? "status active" : "status"}>{account.enabled ? "已开启" : "已关闭"}</span></td>
                  <td>
                    <div className="row-actions">
                      <button type="button" onClick={() => openEdit(account)}><Pencil size={14} /> 编辑</button>
                      <button type="button" onClick={() => setConnecting(account)}><PlugZap size={14} /> 接入</button>
                      <button type="button" onClick={() => void toggleAccount(account)}>{account.enabled ? "关闭自动化" : "开启自动化"}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && (
        <div className="modal-backdrop" onMouseDown={() => setShowForm(false)}>
          <form className="modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void save(event)}>
            <div className="modal-heading">
              <div><span className="eyebrow">用户管理</span><h2>{editing ? "编辑广告账户" : "新增广告账户"}</h2></div>
              <button type="button" onClick={() => setShowForm(false)}><X size={20} /></button>
            </div>
            <div className="form-grid">
              <Field label="账户名称">
                <input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
              </Field>
              <Field label="账户类型">
                <select value={form.accountType} onChange={(event) => setForm({ ...form, accountType: event.target.value as AccountCreateInput["accountType"] })}>
                  <option value="standard">普通广告账户</option>
                  <option value="agency">代理账户</option>
                  <option value="shop">TikTok Shop</option>
                </select>
              </Field>
              <Field label="默认接入方式">
                <select value={form.providerKind} onChange={(event) => setForm({ ...form, providerKind: event.target.value as ProviderKind })}>
                  <option value="cookie">Cookie 会话</option>
                  <option value="official-api">Marketing API</option>
                </select>
              </Field>
              <div className="field toggle-field"><span>自动化开关</span><Toggle checked={form.enabled} label="自动化开关" onChange={(enabled) => setForm({ ...form, enabled })} /></div>
            </div>
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setShowForm(false)}>取消</button>
              <button className="primary-button" disabled={saving} type="submit"><Save size={17} /> {saving ? "保存中…" : "保存账户"}</button>
            </div>
          </form>
        </div>
      )}

      {connecting && (
        <div className="modal-backdrop" onMouseDown={() => setConnecting(null)}>
          <div className="modal connection-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><span className="eyebrow">广告账户接入</span><h2>{connecting.displayName}</h2></div>
              <button type="button" onClick={() => { setConnecting(null); void loadConnectionStates(); }}><X size={20} /></button>
            </div>
            <ConnectionPage account={connecting} onError={onError} />
          </div>
        </div>
      )}
    </section>
  );
}

function AdsManagementPage({
  account,
  onError,
}: {
  account: AccountConfig;
  onError: (message: string | null) => void;
}) {
  const [entities, setEntities] = useState<ManagedEntityRecord[] | null>(null);
  const [operations, setOperations] = useState<AdOperationRecord[]>([]);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<"all" | ManagedEntityRecord["entityType"]>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | ManagedEntityRecord["status"]>("all");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextEntities, nextOperations] = await Promise.all([
        api.getManagedEntities(account.id),
        api.getAdOperations(account.id),
      ]);
      setEntities(nextEntities);
      setOperations(nextOperations);
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    }
  }, [account.id, onError]);

  useEffect(() => {
    setEntities(null);
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (entities ?? []).filter((entity) => {
      if (level !== "all" && entity.entityType !== level) return false;
      if (statusFilter !== "all" && entity.status !== statusFilter) return false;
      return (
        !normalizedQuery ||
        entity.name.toLowerCase().includes(normalizedQuery) ||
        entity.externalId.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [entities, level, query, statusFilter]);

  const changeStatus = async (entity: ManagedEntityRecord) => {
    if (entity.status === "unknown") return;
    const action = entity.status === "enabled" ? "disable" : "enable";
    if (!window.confirm(`确认${action === "enable" ? "开启" : "关闭"}“${entity.name}”吗？`)) return;
    try {
      setBusy(`${entity.entityType}:${entity.externalId}:status`);
      const result = await api.changeEntityStatus(account.id, {
        entityType: entity.entityType,
        externalId: entity.externalId,
        action,
      });
      if (!result.ok) throw new Error(result.message);
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggleIgnore = async (entity: ManagedEntityRecord) => {
    try {
      setBusy(`${entity.entityType}:${entity.externalId}:ignore`);
      if (entity.ignored) {
        await api.unignoreEntity(account.id, entity.entityType, entity.externalId);
      } else {
        const reason = window.prompt("请输入忽略原因：", "人工排除，不参与自动化")?.trim();
        if (!reason) return;
        await api.ignoreEntity(
          account.id,
          entity.entityType,
          entity.externalId,
          reason,
        );
      }
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const queueAppeal = async (entity: ManagedEntityRecord) => {
    const reason = window.prompt("请输入申诉原因或备注：")?.trim();
    if (!reason) return;
    try {
      setBusy(`${entity.externalId}:appeal`);
      await api.queueAppeal(account.id, entity.externalId, reason);
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  if (!entities) return <EmptyState text="正在读取广告对象…" loading />;

  return (
    <section className="page-stack">
      <div className="panel filter-panel">
        <div className="form-grid management-filters">
          <Field label="名称或 ID">
            <input placeholder="搜索广告系列、广告组或广告" value={query} onChange={(event) => setQuery(event.target.value)} />
          </Field>
          <Field label="层级">
            <select value={level} onChange={(event) => setLevel(event.target.value as typeof level)}>
              <option value="all">全部层级</option>
              <option value="campaign">广告系列</option>
              <option value="ad-group">广告组</option>
              <option value="ad">广告</option>
            </select>
          </Field>
          <Field label="状态">
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="all">全部状态</option>
              <option value="enabled">已开启</option>
              <option value="disabled">已关闭</option>
              <option value="unknown">未知</option>
            </select>
          </Field>
        </div>
      </div>

      <div className="panel table-panel">
        <div className="panel-heading">
          <div><span className="panel-icon"><ListFilter size={18} /></span><div><h2>广告对象</h2><p>共 {filtered.length} 项；忽略对象不会参与自动化决策。</p></div></div>
          <button className="secondary-button" onClick={() => void load()} type="button"><RefreshCcw size={16} /> 刷新</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>对象</th><th>层级</th><th>状态</th><th>消耗</th><th>CPC</th><th>转化</th><th>自动化</th><th>操作</th></tr></thead>
            <tbody>
              {filtered.length === 0 ? <tr><td colSpan={8}>暂无数据，请先在用户管理完成账户接入，或在自动化中心执行一次检测。</td></tr> : filtered.map((entity) => {
                const key = `${entity.entityType}:${entity.externalId}`;
                return (
                  <tr key={key}>
                    <td><strong>{entity.name}</strong><br /><small>{entity.externalId}</small></td>
                    <td>{entityTypeLabel(entity.entityType)}</td>
                    <td><span className={entity.status === "enabled" ? "status active" : "status"}>{operationalStatusLabel(entity.status)}</span></td>
                    <td>{formatMetric(entity.metrics.spend)}</td>
                    <td>{formatMetric(entity.metrics.cost_per_click)}</td>
                    <td>{formatMetric(entity.metrics.conversions)}</td>
                    <td>{entity.ignored ? <span className="risk-badge destructive">已忽略</span> : "参与"}</td>
                    <td><div className="row-actions">
                      <button disabled={busy !== null || entity.status === "unknown"} onClick={() => void changeStatus(entity)} type="button">{entity.status === "enabled" ? "关闭" : "开启"}</button>
                      <button disabled={busy !== null} onClick={() => void toggleIgnore(entity)} type="button"><Ban size={14} /> {entity.ignored ? "取消忽略" : "忽略"}</button>
                      {entity.entityType === "ad" && <button disabled={busy !== null} onClick={() => void queueAppeal(entity)} type="button">加入申诉</button>}
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel table-panel">
        <div className="panel-heading"><div><span className="panel-icon"><Activity size={18} /></span><div><h2>广告操作记录</h2><p>手动和自动启停、忽略名单变更均记录在本机。</p></div></div></div>
        <div className="table-wrap"><table>
          <thead><tr><th>对象</th><th>动作</th><th>来源</th><th>结果</th><th>信息</th><th>时间</th></tr></thead>
          <tbody>{operations.length === 0 ? <tr><td colSpan={6}>暂无操作记录。</td></tr> : operations.slice(0, 50).map((operation) => <tr key={operation.id}>
            <td>{operation.entityName}<br /><small>{operation.externalId}</small></td>
            <td>{operationActionLabel(operation.action)}</td>
            <td>{operation.source === "automation" ? "自动化" : "手动"}</td>
            <td><span className={operation.status === "succeeded" ? "status active" : "status"}>{operation.status === "succeeded" ? "成功" : operation.status === "pending" ? "等待" : "失败"}</span></td>
            <td>{operation.message ?? "—"}</td>
            <td>{new Date(operation.createdAt).toLocaleString()}</td>
          </tr>)}</tbody>
        </table></div>
      </div>
    </section>
  );
}

function AnalyticsPage({
  account,
  onError,
}: {
  account: AccountConfig;
  onError: (message: string | null) => void;
}) {
  const [days, setDays] = useState(7);
  const [level, setLevel] = useState<"all" | EntityMetricSnapshotRecord["entityType"]>("ad-group");
  const [snapshots, setSnapshots] = useState<EntityMetricSnapshotRecord[] | null>(null);

  useEffect(() => {
    setSnapshots(null);
    void api
      .getAnalytics(account.id, days, level === "all" ? undefined : level)
      .then((result) => {
        setSnapshots(result);
        onError(null);
      })
      .catch((cause) => onError(getErrorMessage(cause)));
  }, [account.id, days, level, onError]);

  const analysis = useMemo(() => analyzeSnapshots(snapshots ?? []), [snapshots]);
  if (!snapshots) return <EmptyState text="正在分析指标快照…" loading />;

  return (
    <section className="page-stack">
      <div className="panel filter-panel">
        <div className="form-grid management-filters">
          <Field label="时间范围"><select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={1}>最近 1 天</option><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={90}>最近 90 天</option></select></Field>
          <Field label="分析层级"><select value={level} onChange={(event) => setLevel(event.target.value as typeof level)}><option value="all">全部层级</option><option value="campaign">广告系列</option><option value="ad-group">广告组</option><option value="ad">广告</option></select></Field>
        </div>
      </div>
      <div className="summary-grid">
        <SummaryCard icon={<Gauge size={20} />} label="当前消耗" value={formatMetric(analysis.latestSpend)} tone="blue" />
        <SummaryCard icon={<Activity size={20} />} label="当前点击" value={formatMetric(analysis.latestClicks)} tone="violet" />
        <SummaryCard icon={<Check size={20} />} label="当前转化" value={formatMetric(analysis.latestConversions)} tone="green" />
      </div>
      <div className="panel table-panel">
        <div className="panel-heading"><div><span className="panel-icon"><BarChart3 size={18} /></span><div><h2>检测批次趋势</h2><p>相同检测时间的对象聚合为一个批次，避免把多次累计指标重复相加。</p></div></div></div>
        <div className="table-wrap"><table>
          <thead><tr><th>检测时间</th><th>对象数</th><th>消耗</th><th>点击</th><th>转化</th><th>平均 CPC</th><th>平均转化成本</th></tr></thead>
          <tbody>{analysis.batches.length === 0 ? <tr><td colSpan={7}>暂无历史快照，请先执行检测。</td></tr> : analysis.batches.map((batch) => <tr key={batch.capturedAt}><td>{new Date(batch.capturedAt).toLocaleString()}</td><td>{batch.count}</td><td>{formatMetric(batch.spend)}</td><td>{formatMetric(batch.clicks)}</td><td>{formatMetric(batch.conversions)}</td><td>{formatMetric(batch.clicks > 0 ? batch.spend / batch.clicks : null)}</td><td>{formatMetric(batch.conversions > 0 ? batch.spend / batch.conversions : null)}</td></tr>)}</tbody>
        </table></div>
      </div>
    </section>
  );
}

function AutomationPage({
  account,
  maxActionsPerRun,
  onError,
}: {
  account: AccountConfig;
  maxActionsPerRun: number;
  onError: (message: string | null) => void;
}) {
  const [runs, setRuns] = useState<AutomationRunRecord[] | null>(null);
  const [decisions, setDecisions] = useState<
    AutomationDecisionRecord[] | null
  >(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextRuns, nextDecisions] = await Promise.all([
        api.getAutomationRuns(account.id),
        api.getAutomationDecisions(account.id),
      ]);
      setRuns(nextRuns);
      setDecisions(nextDecisions);
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    }
  }, [account.id, onError]);

  useEffect(() => {
    setRuns(null);
    setDecisions(null);
    void load();
  }, [load]);

  const execute = async (preview: boolean) => {
    if (
      !preview &&
      !window.confirm(
        `本轮最多会按已启用规则执行 ${maxActionsPerRun} 个真实启停操作。确认继续吗？`,
      )
    ) {
      return;
    }
    try {
      setBusy(preview ? "preview" : "run");
      if (preview) await api.previewAutomation(account.id);
      else await api.runAutomation(account.id);
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  if (!runs || !decisions) {
    return <EmptyState text="正在读取自动化记录…" loading />;
  }

  const latest = runs[0];
  return (
    <section className="page-stack">
      <div className="summary-grid">
        <SummaryCard
          icon={<CircleGauge size={20} />}
          label="账户自动化"
          value={account.enabled ? "已开启" : "已关闭"}
          tone="blue"
        />
        <SummaryCard
          icon={<Gauge size={20} />}
          label="最近候选"
          value={`${latest?.candidateCount ?? 0} 项`}
          tone="violet"
        />
        <SummaryCard
          icon={<Check size={20} />}
          label="最近执行"
          value={`${latest?.successCount ?? 0} 成功 / ${latest?.failureCount ?? 0} 失败`}
          tone="green"
        />
      </div>

      <div className="panel automation-control-panel">
        <div>
          <span className="eyebrow">检测 → 判断 → 执行</span>
          <h2>自动化运行控制</h2>
          <p>
            检测预览永远不会修改广告；账户开关开启后，定时轮询和“立即执行”都会按已启用规则自动启停。
          </p>
        </div>
        <div className="automation-actions">
          <button
            className="secondary-button"
            disabled={busy !== null}
            onClick={() => void execute(true)}
            type="button"
          >
            <RefreshCcw size={17} />
            {busy === "preview" ? "检测中…" : "检测预览"}
          </button>
          <button
            className="primary-button"
            disabled={busy !== null || !account.enabled}
            onClick={() => void execute(false)}
            type="button"
            title={account.enabled ? "按规则执行真实启停" : "请先在用户管理中开启账户自动化"}
          >
            <Play size={17} />
            {busy === "run" ? "运行中…" : "立即执行"}
          </button>
        </div>
      </div>

      <div className="panel table-panel">
        <div className="panel-heading">
          <div>
            <span className="panel-icon"><Activity size={18} /></span>
            <div>
              <h2>最近决策</h2>
              <p>每次命中、跳过和执行结果都会保存在本地审计记录中。</p>
            </div>
          </div>
          <button className="secondary-button" onClick={() => void load()} type="button">
            <RefreshCcw size={16} /> 刷新
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>对象</th>
                <th>层级</th>
                <th>命中条件</th>
                <th>动作</th>
                <th>结果</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {decisions.length === 0 ? (
                <tr><td colSpan={6}>暂无决策记录，请先执行“检测预览”。</td></tr>
              ) : decisions.map((decision) => (
                <tr key={decision.id}>
                  <td><strong>{decision.entityName}</strong><br /><small>{decision.externalId}</small></td>
                  <td>{entityTypeLabel(decision.entityType)}</td>
                  <td>{metricLabel(decision.metric)} {operatorLabel(decision.operator)} {decision.thresholdValue}<br /><small>当前 {decision.metricValue}</small></td>
                  <td>{decision.action === "enable" ? "开启" : "关闭"}</td>
                  <td>
                    <span className={`status ${decision.status === "succeeded" ? "active" : ""}`}>
                      {decisionStatusLabel(decision.status)}
                    </span>
                    {decision.errorMessage && <small className="decision-error">{decision.errorMessage}</small>}
                  </td>
                  <td>{new Date(decision.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone: "blue" | "violet" | "green";
}) {
  return (
    <article className="summary-card">
      <span className={`summary-icon ${tone}`}>{icon}</span>
      <div><span>{label}</span><strong>{value}</strong></div>
    </article>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={checked}
      className={checked ? "toggle checked" : "toggle"}
      onClick={() => onChange(!checked)}
      type="button"
    >
      <span />
    </button>
  );
}

function Field({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return <label className={wide ? "field wide" : "field"}><span>{label}</span>{children}</label>;
}

function AccountScopedPage({
  accounts,
  selectedId,
  onSelect,
  children,
}: {
  accounts: AccountConfig[];
  selectedId: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <section className="page-stack">
      <div className="panel account-scope-bar">
        <div>
          <strong>查看账户</strong>
          <span>这里只切换当前页面的数据视图，不改变全局自动化规则。</span>
        </div>
        <select value={selectedId} onChange={(event) => onSelect(event.target.value)}>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>{account.displayName}</option>
          ))}
        </select>
      </div>
      {children}
    </section>
  );
}

function EmptyState({ text, loading = false }: { text: string; loading?: boolean }) {
  return (
    <div className="empty-state">
      {loading ? <div className="loader" /> : <AlertTriangle size={24} />}
      <strong>{text}</strong>
    </div>
  );
}

function settingsFromAccount(account: AccountConfig): AccountSettingsUpdate {
  return {
    displayName: account.displayName,
    accountType: account.accountType,
    enabled: account.enabled,
    providerKind: account.providerKind,
  };
}

function connectionStateLabel(
  state:
    | {
        connection: ProviderConnection | null;
        readiness: CookieConnectionReadiness | null;
      }
    | undefined,
  kind: ProviderKind,
): ReactNode {
  const connection = state?.connection;
  const cookieReadiness = state?.readiness;
  if (kind === "cookie" && !cookieReadiness?.fieldsComplete) {
    return (
      <span className="status warning">
        待导入 {cookieReadiness?.completedFields ?? 0}/5
      </span>
    );
  }
  if (kind === "cookie" && !cookieReadiness?.statusRequestImported) {
    return <span className="status danger">启停能力未建立</span>;
  }
  if (!connection || connection.status === "not-configured") {
    return <span className="status">未接入</span>;
  }
  if (connection.status === "ready") {
    return <span className="status active">连接正常</span>;
  }
  if (connection.status === "failed" && kind === "cookie") {
    return <span className="status danger">Cookie 已失效</span>;
  }
  return <span className="status">{connection.status === "untested" ? "等待检测" : "连接异常"}</span>;
}

function providerLabel(kind: ProviderKind): string {
  return kind === "cookie" ? "Cookie 会话" : "Marketing API";
}

function accountTypeLabel(type: AccountConfig["accountType"]): string {
  return { standard: "普通广告账户", agency: "代理账户", shop: "TikTok Shop" }[
    type
  ];
}

function operatorLabel(operator: ThresholdConfig["operator"]): string {
  return { gt: ">", gte: "≥", lt: "<", lte: "≤" }[operator];
}

function entityTypeLabel(entityType: "campaign" | "ad-group" | "ad"): string {
  return { campaign: "广告系列", "ad-group": "广告组", ad: "广告" }[
    entityType
  ];
}

function metricLabel(metric: ThresholdConfig["metric"]): string {
  return {
    cost_per_conversion: "平均转化成本",
    cost_per_click: "平均点击成本",
    cost_per_cart: "平均加购成本",
    budget: "预算",
    spend: "消耗",
    conversions: "转化量",
    clicks: "点击量",
    custom: "自定义指标",
  }[metric];
}

function decisionStatusLabel(
  status: AutomationDecisionRecord["status"],
): string {
  return {
    preview: "预览命中",
    pending: "等待确认",
    succeeded: "执行成功",
    failed: "执行失败",
    skipped: "安全跳过",
  }[status];
}

function operationalStatusLabel(
  status: ManagedEntityRecord["status"],
): string {
  return { enabled: "已开启", disabled: "已关闭", unknown: "未知" }[status];
}

function operationActionLabel(action: AdOperationRecord["action"]): string {
  return {
    enable: "开启",
    disable: "关闭",
    ignore: "加入忽略",
    unignore: "取消忽略",
    appeal: "申诉",
  }[action];
}

function formatMetric(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function analyzeSnapshots(snapshots: EntityMetricSnapshotRecord[]) {
  const latestByEntity = new Map<string, EntityMetricSnapshotRecord>();
  const grouped = new Map<
    string,
    { capturedAt: string; count: number; spend: number; clicks: number; conversions: number }
  >();
  for (const snapshot of snapshots) {
    const key = `${snapshot.entityType}:${snapshot.externalId}`;
    if (!latestByEntity.has(key)) latestByEntity.set(key, snapshot);
    const batch = grouped.get(snapshot.capturedAt) ?? {
      capturedAt: snapshot.capturedAt,
      count: 0,
      spend: 0,
      clicks: 0,
      conversions: 0,
    };
    batch.count += 1;
    batch.spend += snapshot.metrics.spend ?? 0;
    batch.clicks += snapshot.metrics.clicks ?? 0;
    batch.conversions += snapshot.metrics.conversions ?? 0;
    grouped.set(snapshot.capturedAt, batch);
  }
  const latest = [...latestByEntity.values()];
  return {
    latestSpend: latest.reduce((sum, item) => sum + (item.metrics.spend ?? 0), 0),
    latestClicks: latest.reduce((sum, item) => sum + (item.metrics.clicks ?? 0), 0),
    latestConversions: latest.reduce(
      (sum, item) => sum + (item.metrics.conversions ?? 0),
      0,
    ),
    batches: [...grouped.values()].sort((a, b) =>
      b.capturedAt.localeCompare(a.capturedAt),
    ),
  };
}

function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "发生未知错误。";
}
