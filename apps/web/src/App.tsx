import {
  Activity,
  AlertTriangle,
  BarChart3,
  Ban,
  BellRing,
  BookOpen,
  Check,
  ChevronDown,
  CircleGauge,
  Gauge,
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
  MetricBatchRecord,
  ManagedEntityRecord,
  ProviderConnection,
  ProviderKind,
  ReadOnlySyncResult,
  ThresholdConfig,
  ScheduledEntityActionRecord,
} from "@tk-auto/core";
import {
  api,
  type BootstrapPayload,
  type CookieConnectionReadiness,
} from "./api";
import { ConnectionPage } from "./ConnectionPage";
import { ManualPage } from "./ManualPage";
import { NotificationsPage } from "./NotificationsPage";
import { RulesPage } from "./RulesPage";
import { AuthGate, useAuth } from "./AuthGate";
import { SystemUsersPage } from "./SystemUsersPage";
import { AutomationFeaturesPage } from "./AutomationFeaturesPage";
import { LaunchPage } from "./LaunchPage";
import {
  resolveAnalysisRange,
  type AnalysisPreset,
} from "./analytics";

type PageKey =
  | "manual"
  | "users"
  | "automation"
  | "ads"
  | "analytics"
  | "rules"
  | "notifications"
  | "launch"
  | "system-users";

const selectedAccountStorageKey = "tk-auto:selected-account-id";

const pageHash: Record<PageKey, string> = {
  manual: "#manual",
  users: "#users",
  automation: "#automation",
  ads: "#ads",
  analytics: "#analytics",
  rules: "#rules",
  notifications: "#notifications",
  launch: "#launch",
  "system-users": "#system-users",
};

function pageFromHash(hash = window.location.hash): PageKey {
  const found = (Object.entries(pageHash) as Array<[PageKey, string]>).find(
    ([, value]) => value === hash,
  );
  return found?.[0] ?? "manual";
}

function preferredAccountId(
  accounts: AccountConfig[],
  states: BootstrapPayload["accountConnectionStates"],
  current: string,
): string {
  const available = new Set(accounts.map((account) => account.id));
  const remembered = window.localStorage.getItem(selectedAccountStorageKey) ?? "";
  if (available.has(current)) return current;
  if (available.has(remembered)) return remembered;
  return states.find((state) => state.connection?.status === "ready")?.accountId
    ?? accounts[0]?.id
    ?? "";
}

const navItems: Array<{
  key: PageKey;
  label: string;
  description: string;
  icon: typeof Settings2;
}> = [
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
  {
    key: "notifications",
    label: "消息推送",
    description: "邮箱、企业微信与飞书",
    icon: BellRing,
  },
  {
    key: "launch",
    label: "创建广告",
    description: "相同广告多账户投放",
    icon: Plus,
  },
  {
    key: "system-users",
    label: "系统权限",
    description: "登录账户与角色权限",
    icon: ShieldCheck,
  },
];

export function App() {
  return (
    <AuthGate>
      <ConsoleApp />
    </AuthGate>
  );
}

function ConsoleApp() {
  const auth = useAuth();
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [page, setPage] = useState<PageKey>(() => pageFromHash());
  const [error, setError] = useState<string | null>(null);

  const loadBootstrap = useCallback(async () => {
    try {
      const payload = await api.bootstrap();
      setBootstrap(payload);
      setSelectedAccountId((current) => preferredAccountId(
        payload.accounts,
        payload.accountConnectionStates,
        current,
      ));
      setError(null);
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    const syncPageFromUrl = () => setPage(pageFromHash());
    window.addEventListener("hashchange", syncPageFromUrl);
    return () => window.removeEventListener("hashchange", syncPageFromUrl);
  }, []);

  const navigateTo = useCallback((nextPage: PageKey) => {
    const nextHash = pageHash[nextPage];
    if (window.location.hash === nextHash) setPage(nextPage);
    else window.location.hash = nextHash;
  }, []);

  const selectAccount = useCallback((accountId: string) => {
    window.localStorage.setItem(selectedAccountStorageKey, accountId);
    setSelectedAccountId(accountId);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadBootstrap();
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [loadBootstrap]);

  const account = bootstrap?.accounts.find(
    (item) => item.id === selectedAccountId,
  );
  const selectedConnection = bootstrap?.accountConnectionStates.find(
    (item) => item.accountId === selectedAccountId,
  )?.connection ?? null;
  const selectedLatestSync = bootstrap?.accountConnectionStates.find(
    (item) => item.accountId === selectedAccountId,
  )?.latestSync ?? null;

  if (!bootstrap) {
    return (
      <div className="center-state">
        <div className="loader" />
        <strong>正在加载本地配置</strong>
        {error && <p className="error-text">{error}</p>}
      </div>
    );
  }

  const automationOverview = summarizeAccountConnections(
    bootstrap.accounts,
    bootstrap.accountConnectionStates,
  );

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

        <button
          className={bootstrap.systemRuntime.enabled ? "system-master active" : "system-master paused"}
          disabled={!auth.status.permissions.includes("system:control")}
          onClick={async () => {
            try {
              await api.updateSystemRuntime(!bootstrap.systemRuntime.enabled);
              await loadBootstrap();
            } catch (cause) {
              setError(getErrorMessage(cause));
            }
          }}
          type="button"
        >
          <span className="system-master-light" />
          <span>
            <strong>{bootstrap.systemRuntime.enabled ? "系统运行中" : "系统已暂停"}</strong>
            <small>{bootstrap.systemRuntime.enabled ? "检测、定时与启停已启用" : "所有后台任务和写入已停止"}</small>
          </span>
          <span className={bootstrap.systemRuntime.enabled ? "master-switch checked" : "master-switch"}><i /></span>
        </button>

        <div className="phase-card">
          <span className="phase-dot" />
          <div>
            <strong>本地自动化引擎</strong>
            <small>检测、决策、执行与审计</small>
          </div>
        </div>

        <nav className="nav-list">
          {navItems.filter((item) => item.key !== "system-users" || auth.status.permissions.includes("users:manage")).map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={page === item.key ? "nav-item active" : "nav-item"}
                key={item.key}
                onClick={() => navigateTo(item.key)}
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

        <button className={page === "manual" ? "nav-item manual-launch active" : "nav-item manual-launch"} onClick={() => navigateTo("manual")} type="button"><BookOpen size={19} /><span><strong>操作手册</strong><small>API 与 Cookie 详细教程</small></span></button>

        <div className="sidebar-footer">
          <ShieldCheck size={18} />
          <span>本地模式 · 仅监听 127.0.0.1</span>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="eyebrow">核心控制台</span>
            <h1>{page === "manual" ? "操作手册" : navItems.find((item) => item.key === page)?.label}</h1>
          </div>
          <div className="topbar-user">
            <span><strong>{auth.status.user?.displayName}</strong><small>{auth.status.user?.role}</small></span>
            <button type="button" onClick={() => void auth.logout()}>退出</button>
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
        ) : page === "system-users" ? (
          <SystemUsersPage onError={setError} />
        ) : page === "users" ? (
          <UsersPage
            accounts={bootstrap.accounts}
            initialConnectionStates={Object.fromEntries(
              bootstrap.accountConnectionStates.map((state) => [
                state.accountId,
                {
                  connection: state.connection,
                  readiness: null,
                  latestSync: state.latestSync,
                },
              ]),
            )}
            onChanged={loadBootstrap}
            onError={setError}
          />
        ) : page === "rules" ? (
          <RulesPage
            settings={bootstrap.globalAutomationSettings}
            onSettingsSaved={loadBootstrap}
            onError={setError}
          />
        ) : page === "notifications" ? (
          <NotificationsPage onError={setError} />
        ) : page === "launch" ? (
          <LaunchPage accounts={bootstrap.accounts} preferredAccountId={selectedAccountId} onError={setError} />
        ) : !account ? (
          <EmptyState text="请选择一个账户。" />
        ) : page === "automation" ? (
          <section className="page-stack"><AccountScopedPage accounts={bootstrap.accounts} selectedId={selectedAccountId} onSelect={selectAccount}>
            <AutomationPage account={account} connection={selectedConnection} maxActionsPerRun={bootstrap.globalAutomationSettings.maxActionsPerRun} overview={automationOverview} onError={setError} />
            <AutomationFeaturesPage onError={setError} />
          </AccountScopedPage></section>
        ) : page === "ads" ? (
          <AccountScopedPage accounts={bootstrap.accounts} selectedId={selectedAccountId} onSelect={selectAccount}>
            <AdsManagementPage account={account} onError={setError} />
          </AccountScopedPage>
        ) : page === "analytics" ? (
          <AccountScopedPage accounts={bootstrap.accounts} selectedId={selectedAccountId} onSelect={selectAccount}>
            <AnalyticsPage account={account} connection={selectedConnection} latestSync={selectedLatestSync} onError={setError} />
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
  enabled: false,
  providerKind: "cookie",
};

interface AccountAutomationOverview {
  connectedCount: number;
  automationEnabledCount: number;
  unreadyAccounts: Array<{
    accountId: string;
    displayName: string;
    message: string;
  }>;
}

function summarizeAccountConnections(
  accounts: AccountConfig[],
  states: BootstrapPayload["accountConnectionStates"],
): AccountAutomationOverview {
  const stateByAccountId = new Map(
    states.map((state) => [state.accountId, state]),
  );
  const automaticAccounts = accounts.filter((account) => account.enabled);
  return {
    connectedCount: states.filter(
      (state) => state.connection?.status === "ready",
    ).length,
    automationEnabledCount: automaticAccounts.length,
    unreadyAccounts: automaticAccounts.flatMap((account) => {
      const connection = stateByAccountId.get(account.id)?.connection;
      return connection?.status !== "ready"
        ? [{
            accountId: account.id,
            displayName: account.displayName,
            message: connectionStatusSummary(account, connection),
          }]
        : [];
    }),
  };
}

function automationConnectionMessage(
  account: AccountConfig,
  connection: ProviderConnection | null,
): string {
  const providerLabel = account.providerKind === "cookie" ? "Cookie 接入" : "API 接入";
  const stateLabel =
    !connection || connection.status === "not-configured"
      ? "尚未接入"
      : connection.status === "untested"
        ? "等待后台检测"
        : connection.status === "failed"
          ? account.providerKind === "cookie"
            ? "Cookie 已失效或连接异常"
            : "API 连接异常"
          : "尚未通过连接检测";
  return `当前账户「${account.displayName}」的${providerLabel}状态：${stateLabel}。请前往“用户管理”完成或检查接入。`;
}

function connectionStatusSummary(
  account: AccountConfig,
  connection: ProviderConnection | null | undefined,
): string {
  if (!connection || connection.status === "not-configured") {
    return "尚未导入接入信息";
  }
  if (connection.status === "untested") {
    return "已导入，等待后台连接检测";
  }
  if (connection.status === "failed") {
    return connection.lastMessage ?? (account.providerKind === "cookie"
      ? "Cookie 已失效或连接异常"
      : "API 连接异常");
  }
  return "尚未通过连接检测";
}

function UsersPage({
  accounts,
  initialConnectionStates,
  onChanged,
  onError,
}: {
  accounts: AccountConfig[];
  initialConnectionStates: Record<
    string,
    {
      connection: ProviderConnection | null;
      readiness: CookieConnectionReadiness | null;
      latestSync: ReadOnlySyncResult | null;
    }
  >;
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
        latestSync: ReadOnlySyncResult | null;
      }
    >
  >(initialConnectionStates);

  useEffect(() => {
    setConnectionStates(initialConnectionStates);
  }, [initialConnectionStates]);

  useEffect(() => {
    const timer = window.setInterval(() => void onChanged(), 30_000);
    return () => window.clearInterval(timer);
  }, [onChanged]);

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

  const enableAfterConnection = async (account: AccountConfig) => {
    if (!account.enabled) {
      await api.updateSettings(account.id, {
        ...settingsFromAccount(account),
        enabled: true,
      });
    }
    await onChanged();
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
                <tr key={account.id}>{(() => {
                  const automationReady = connectionStates[account.id]?.connection?.status === "ready";
                  return <>
                  <td><strong>{account.displayName}</strong><br /><small className="account-id">{account.id}</small></td>
                  <td>{accountTypeLabel(account.accountType)}</td>
                  <td>{providerLabel(account.providerKind)}</td>
                  <td>{connectionStateLabel(connectionStates[account.id], account.providerKind)}</td>
                  <td>
                    <div className="account-automation-toggle">
                      <Toggle
                        checked={automationReady && account.enabled}
                        disabled={!automationReady}
                        label={`${account.displayName}：${account.enabled ? "关闭" : "开启"}账户自动化`}
                        onChange={() => void toggleAccount(account)}
                      />
                      <span className={automationReady && account.enabled ? "status active" : "status"}>{automationReady ? account.enabled ? "已开启" : "已关闭" : "接入后开启"}</span>
                    </div>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button type="button" onClick={() => openEdit(account)}><Pencil size={14} /> 编辑</button>
                      <button type="button" onClick={() => setConnecting(account)}><PlugZap size={14} /> 接入</button>
                    </div>
                  </td></>;
                })()}</tr>
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
              <button type="button" onClick={() => { setConnecting(null); void onChanged(); }}><X size={20} /></button>
            </div>
            <ConnectionPage account={connecting} onConnectionReady={() => enableAfterConnection(connecting)} onError={onError} />
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
  const [schedules, setSchedules] = useState<ScheduledEntityActionRecord[]>([]);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<"all" | ManagedEntityRecord["entityType"]>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | ManagedEntityRecord["status"]>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<ManagedEntityRecord | null>(null);
  const [scheduleKind, setScheduleKind] = useState<"once" | "overnight">("once");
  const [scheduledAction, setScheduledAction] = useState<"enable" | "disable">("disable");
  const [runAt, setRunAt] = useState("");
  const [disableAt, setDisableAt] = useState("");
  const [enableAt, setEnableAt] = useState("");

  const load = useCallback(async () => {
    try {
      const [nextEntities, nextOperations, nextSchedules] = await Promise.all([
        api.getManagedEntities(account.id),
        api.getAdOperations(account.id),
        api.getSchedules(account.id),
      ]);
      setEntities(nextEntities);
      setOperations(nextOperations);
      setSchedules(nextSchedules);
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    }
  }, [account.id, onError]);

  useEffect(() => {
    setEntities(null);
    void load();
  }, [load]);

  const refreshFromProvider = async () => {
    try {
      setBusy("refresh");
      setSyncFeedback(null);
      const result = await api.previewAutomation(account.id);
      if (result.status === "failed") {
        setSyncFeedback(result.errorMessage ?? "读取广告数据失败，未返回具体原因。");
      } else {
        setSyncFeedback(`已完成只读同步：检测到 ${result.candidateCount} 项候选规则，不会修改广告。`);
      }
      await load();
    } catch (cause) {
      const message = getErrorMessage(cause);
      setSyncFeedback(message);
      onError(message);
    } finally {
      setBusy(null);
    }
  };

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

  const saveSchedule = async (event: FormEvent) => {
    event.preventDefault();
    if (!scheduling) return;
    try {
      setBusy(`${scheduling.externalId}:schedule`);
      if (scheduleKind === "once") {
        await api.createOneTimeSchedule(account.id, {
          externalId: scheduling.externalId,
          action: scheduledAction,
          runAt: new Date(runAt).toISOString(),
        });
      } else {
        await api.createOvernightSchedule(account.id, {
          externalId: scheduling.externalId,
          disableAt: new Date(disableAt).toISOString(),
          enableAt: new Date(enableAt).toISOString(),
        });
      }
      setScheduling(null);
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const cancelSchedule = async (schedule: ScheduledEntityActionRecord) => {
    try {
      if (schedule.groupId) {
        await api.cancelOvernightSchedule(account.id, schedule.groupId);
      } else {
        await api.cancelSchedule(account.id, schedule.id);
      }
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
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
          <button className="secondary-button" disabled={busy !== null} onClick={() => void refreshFromProvider()} type="button"><RefreshCcw size={16} /> {busy === "refresh" ? "同步中…" : "刷新"}</button>
        </div>
        {syncFeedback && <div className={`automation-run-feedback ${syncFeedback.includes("失败") || syncFeedback.includes("错误") ? "error" : "success"}`}>{syncFeedback}</div>}
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
                      <button disabled={busy !== null || entity.status === "unknown"} title={entity.status === "unknown" ? "状态未知：请先执行检测预览或等待下一次同步后再操作。" : undefined} onClick={() => void changeStatus(entity)} type="button">{entity.status === "enabled" ? "关闭" : "开启"}</button>
                      {entity.status === "unknown" && <small className="inline-protection-note">请先同步状态</small>}
                      <button disabled={busy !== null} onClick={() => void toggleIgnore(entity)} type="button"><Ban size={14} /> {entity.ignored ? "取消忽略" : "忽略"}</button>
                      {entity.entityType === "ad-group" && <button disabled={busy !== null} onClick={() => { setScheduling(entity); setRunAt(""); setDisableAt(""); setEnableAt(""); }} type="button">定时 / 过夜</button>}
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
        <div className="panel-heading"><div><span className="panel-icon"><CircleGauge size={18} /></span><div><h2>广告组定时任务</h2><p>单次定时只执行一次；过夜开关会每日按设置时间关闭和开启。账户自动化或软件总开关关闭时不会执行。</p></div></div></div>
        <div className="table-wrap"><table><thead><tr><th>广告组</th><th>类型</th><th>动作</th><th>下次执行</th><th>最近结果</th><th>操作</th></tr></thead><tbody>{schedules.length === 0 ? <tr><td colSpan={6}>暂无定时任务。</td></tr> : schedules.map((schedule) => <tr key={schedule.id}><td>{schedule.entityName}<br /><small>{schedule.externalId}</small></td><td>{schedule.scheduleType === "overnight" ? "每日过夜" : "单次定时"}</td><td>{schedule.action === "enable" ? "开启" : "关闭"}</td><td>{new Date(schedule.nextRunAt).toLocaleString()}</td><td>{schedule.lastMessage ?? scheduleStatusLabel(schedule.status)}</td><td>{schedule.status === "scheduled" ? <button className="danger-button compact-button" onClick={() => void cancelSchedule(schedule)} type="button">取消</button> : "—"}</td></tr>)}</tbody></table></div>
      </div>

      <div className="panel table-panel">
        <div className="panel-heading"><div><span className="panel-icon"><Activity size={18} /></span><div><h2>广告操作记录</h2><p>当前仅显示账户「{account.displayName}」的手动和自动启停、忽略名单变更。</p></div></div></div>
        <div className="table-wrap"><table>
          <thead><tr><th>对象</th><th>动作</th><th>来源</th><th>结果</th><th>信息</th><th>时间</th></tr></thead>
          <tbody>{operations.length === 0 ? <tr><td colSpan={6}>暂无操作记录。</td></tr> : operations.slice(0, 50).map((operation) => <tr key={operation.id}>
            <td>{operation.entityName}<br /><small>{operation.externalId}</small></td>
            <td>{operationActionLabel(operation.action)}</td>
            <td>{operation.source === "automation" ? "自动化" : operation.source === "scheduled" ? "定时" : "手动"}</td>
            <td><span className={operation.status === "succeeded" ? "status active" : "status"}>{operation.status === "succeeded" ? "成功" : operation.status === "pending" ? "等待" : "失败"}</span></td>
            <td>{operation.message ?? "—"}</td>
            <td>{new Date(operation.createdAt).toLocaleString()}</td>
          </tr>)}</tbody>
        </table></div>
      </div>

      {scheduling && (
        <div className="modal-backdrop" onMouseDown={() => setScheduling(null)}>
          <form className="modal schedule-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void saveSchedule(event)}>
            <div className="modal-heading"><div><span className="eyebrow">广告组定时</span><h2>{scheduling.name}</h2></div><button type="button" onClick={() => setScheduling(null)}><X size={20} /></button></div>
            <div className="schedule-kind-tabs"><button className={scheduleKind === "once" ? "active" : ""} onClick={() => setScheduleKind("once")} type="button">单次定时</button><button className={scheduleKind === "overnight" ? "active" : ""} onClick={() => setScheduleKind("overnight")} type="button">每日过夜</button></div>
            {scheduleKind === "once" ? <div className="form-grid"><Field label="执行动作"><select value={scheduledAction} onChange={(event) => setScheduledAction(event.target.value as typeof scheduledAction)}><option value="enable">开启</option><option value="disable">关闭</option></select></Field><Field label="执行时间"><input required type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} /></Field></div> : <div className="form-grid"><Field label="每日关闭时间（首次）"><input required type="datetime-local" value={disableAt} onChange={(event) => setDisableAt(event.target.value)} /></Field><Field label="每日开启时间（首次）"><input required type="datetime-local" value={enableAt} onChange={(event) => setEnableAt(event.target.value)} /></Field></div>}
            <p className="provider-endpoint-note">时间使用本机时区。未到时间前不会写入 TikTok；执行时仍要求账户连接正常且两个自动化总开关均开启。</p>
            <div className="modal-actions"><button className="secondary-button" onClick={() => setScheduling(null)} type="button">取消</button><button className="primary-button" disabled={busy !== null} type="submit">保存任务</button></div>
          </form>
        </div>
      )}
    </section>
  );
}

function AnalyticsPage({
  account,
  connection,
  latestSync,
  onError,
}: {
  account: AccountConfig;
  connection: ProviderConnection | null;
  latestSync: ReadOnlySyncResult | null;
  onError: (message: string | null) => void;
}) {
  const today = formatDateInput(new Date());
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
  const [preset, setPreset] = useState<AnalysisPreset>("7d");
  const [customFrom, setCustomFrom] = useState(formatDateInput(sevenDaysAgo));
  const [customTo, setCustomTo] = useState(today);
  const [level, setLevel] = useState<"all" | ManagedEntityRecord["entityType"]>("ad-group");
  const [barMetric, setBarMetric] = useState<BatchBarMetric>("spend");
  const [lineMetric, setLineMetric] = useState<BatchLineMetric>("cpc");
  const [batches, setBatches] = useState<MetricBatchRecord[] | null>(null);
  const range = useMemo(
    () => {
      try {
        return resolveAnalysisRange(preset, customFrom, customTo);
      } catch {
        return null;
      }
    },
    [customFrom, customTo, preset],
  );

  useEffect(() => {
    if (account.providerKind === "cookie" && level === "ad") setLevel("ad-group");
  }, [account.providerKind, level]);

  useEffect(() => {
    if (!range) return;
    setBatches(null);
    void api
      .getAnalytics(account.id, range, level === "all" ? undefined : level)
      .then((result) => {
        setBatches(result);
        onError(null);
      })
      .catch((cause) => onError(getErrorMessage(cause)));
  }, [account.id, level, onError, range?.from, range?.to]);

  const analysis = useMemo(() => analyzeMetricBatches(batches ?? []), [batches]);
  if (!batches) return <EmptyState text="正在分析指标快照…" loading />;

  return (
    <section className="page-stack">
      <div className={connection?.status === "ready" ? "alert info-alert" : "alert warning-alert"}><Activity size={18} /><span><strong>账户「{account.displayName}」</strong> · 当前连接{connection?.status === "ready" ? "正常" : "异常或待检测"} · 最后成功同步：{latestSync ? new Date(latestSync.finishedAt).toLocaleString() : "暂无"} · 指标图表为本机历史快照 · 币种：当前接入未提供，金额请以 TikTok 广告账户币种为准。</span></div>
      <div className="panel filter-panel">
        <div className="form-grid management-filters">
          <Field label="时间范围"><select value={preset} onChange={(event) => setPreset(event.target.value as AnalysisPreset)}><option value="today">今天</option><option value="yesterday">昨天</option><option value="3d">三天</option><option value="7d">七天</option><option value="30d">三十天</option><option value="custom">自定义</option></select></Field>
          <Field label="分析层级"><select value={level} onChange={(event) => setLevel(event.target.value as typeof level)}><option value="all">全部层级</option><option value="campaign">广告系列</option><option value="ad-group">广告组</option>{account.providerKind === "official-api" && <option value="ad">广告</option>}</select></Field>
          {preset === "custom" && <><Field label="开始日期"><input type="date" max={customTo || today} value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></Field><Field label="结束日期"><input type="date" min={customFrom} max={today} value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></Field></>}
        </div>
        {!range && <p className="error-text">请选择有效日期，且范围不超过 90 天。</p>}
        <p className="retention-note">本地指标快照默认保留 90 天。Cookie 接入当前不展示广告层级分析，因为其广告 list 并非独立真实列表请求。</p>
      </div>
      <div className="summary-grid">
        <SummaryCard icon={<Gauge size={20} />} label="当前消耗" value={formatMetric(analysis.latestSpend)} tone="blue" />
        <SummaryCard icon={<Activity size={20} />} label="当前点击" value={formatMetric(analysis.latestClicks)} tone="violet" />
        <SummaryCard icon={<Check size={20} />} label="当前转化" value={formatMetric(analysis.latestConversions)} tone="green" />
      </div>
      <div className="panel batch-chart-panel">
        <div className="panel-heading"><div><span className="panel-icon"><BarChart3 size={18} /></span><div><h2>批次数据透视</h2><p>数据与下方“检测批次趋势”完全一致；柱状和折线在同一张图中按各自刻度展示。</p></div></div><div className="chart-selectors"><label>柱状 <select value={barMetric} onChange={(event) => setBarMetric(event.target.value as BatchBarMetric)}><option value="spend">消耗</option><option value="clicks">点击</option><option value="conversions">转化</option></select></label><label>折线 <select value={lineMetric} onChange={(event) => setLineMetric(event.target.value as BatchLineMetric)}><option value="cpc">平均 CPC</option><option value="cpa">平均转化成本</option></select></label></div></div>
        <BatchTrendChart batches={analysis.batches} barMetric={barMetric} lineMetric={lineMetric} />
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

type BatchBarMetric = "spend" | "clicks" | "conversions";
type BatchLineMetric = "cpc" | "cpa";
type AnalyticsBatch = MetricBatchRecord;

function BatchTrendChart({ batches, barMetric, lineMetric }: { batches: AnalyticsBatch[]; barMetric: BatchBarMetric; lineMetric: BatchLineMetric }) {
  const points = batches.slice(0, 24).reverse().map((batch) => ({
    ...batch,
    barValue: batch[barMetric],
    lineValue: lineMetric === "cpc"
      ? (batch.clicks > 0 ? batch.spend / batch.clicks : null)
      : (batch.conversions > 0 ? batch.spend / batch.conversions : null),
  }));
  if (points.length === 0) return <div className="chart-empty">暂无批次数据，请先执行检测。</div>;
  const width = 920;
  const height = 286;
  const left = 54;
  const right = 54;
  const top = 20;
  const bottom = 52;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const barMaximum = Math.max(...points.map((point) => point.barValue), 1);
  const lineMaximum = Math.max(...points.map((point) => point.lineValue ?? 0), 1);
  const step = plotWidth / points.length;
  const barWidth = Math.min(34, Math.max(7, step * 0.55));
  const lineSegments: string[] = [];
  let currentSegment: string[] = [];
  points.forEach((point, index) => {
    if (point.lineValue === null) {
      if (currentSegment.length > 1) lineSegments.push(currentSegment.join(" "));
      currentSegment = [];
      return;
    }
    const x = left + step * index + step / 2;
    const y = top + plotHeight - (point.lineValue / lineMaximum) * plotHeight;
    currentSegment.push(`${x},${y}`);
  });
  if (currentSegment.length > 1) lineSegments.push(currentSegment.join(" "));
  const barLabel = { spend: "消耗", clicks: "点击", conversions: "转化" }[barMetric];
  const lineLabel = lineMetric === "cpc" ? "平均 CPC" : "平均转化成本";

  return <div className="batch-chart-wrap">
    <div className="chart-legend"><span className="bar-key">{barLabel}（柱）</span><span className="line-key">{lineLabel}（线）</span><small>最多显示最近 24 个检测批次</small></div>
    <svg aria-label={`${barLabel}柱状图与${lineLabel}折线图`} className="batch-combo-chart" role="img" viewBox={`0 0 ${width} ${height}`}>
      {[0, .25, .5, .75, 1].map((ratio) => {
        const y = top + plotHeight * (1 - ratio);
        return <g key={ratio}><line className="chart-grid-line" x1={left} x2={width - right} y1={y} y2={y} /><text className="chart-axis-label" textAnchor="end" x={left - 8} y={y + 4}>{formatMetric(barMaximum * ratio)}</text><text className="chart-axis-label" textAnchor="start" x={width - right + 8} y={y + 4}>{formatMetric(lineMaximum * ratio)}</text></g>;
      })}
      {points.map((point, index) => {
        const x = left + step * index + step / 2;
        const barHeight = (point.barValue / barMaximum) * plotHeight;
        const labelEvery = Math.max(1, Math.ceil(points.length / 8));
        return <g key={point.capturedAt}><rect className="chart-bar" height={barHeight} rx="3" width={barWidth} x={x - barWidth / 2} y={top + plotHeight - barHeight}><title>{new Date(point.capturedAt).toLocaleString()} · {barLabel} {formatMetric(point.barValue)} · {lineLabel} {formatMetric(point.lineValue)}</title></rect>{index % labelEvery === 0 && <text className="chart-x-label" textAnchor="middle" x={x} y={height - 24}>{formatChartTime(point.capturedAt)}</text>}</g>;
      })}
      {lineSegments.map((segment, index) => <polyline className="chart-line" fill="none" key={index} points={segment} />)}
      {points.map((point, index) => {
        if (point.lineValue === null) return null;
        const x = left + step * index + step / 2;
        const y = top + plotHeight - (point.lineValue / lineMaximum) * plotHeight;
        return <circle className="chart-line-dot" cx={x} cy={y} key={point.capturedAt} r="3.5"><title>{new Date(point.capturedAt).toLocaleString()} · {lineLabel} {formatMetric(point.lineValue)}</title></circle>;
      })}
    </svg>
  </div>;
}

function formatChartTime(value: string): string {
  const date = new Date(value);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function AutomationPage({
  account,
  connection,
  maxActionsPerRun,
  overview,
  onError,
}: {
  account: AccountConfig;
  connection: ProviderConnection | null;
  maxActionsPerRun: number;
  overview: AccountAutomationOverview;
  onError: (message: string | null) => void;
}) {
  const [runs, setRuns] = useState<AutomationRunRecord[] | null>(null);
  const [decisions, setDecisions] = useState<
    AutomationDecisionRecord[] | null
  >(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [runFeedback, setRunFeedback] = useState<string | null>(null);
  const connectionMessage = automationConnectionMessage(account, connection);
  const canRunAutomation = connection?.status === "ready";
  const unreadyAccounts = overview.unreadyAccounts ?? [];

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
    try {
      setBusy(preview ? "preview" : "run");
      setRunFeedback(null);
      const result = preview
        ? await api.previewAutomation(account.id)
        : await api.runAutomation(account.id);
      if (result.status === "failed") {
        setRunFeedback(result.errorMessage ?? "检测失败，未返回具体原因。");
      } else {
        setRunFeedback(
          preview
            ? `检测完成：发现 ${result.candidateCount} 项候选操作，未修改广告。`
            : `执行完成：成功 ${result.successCount} 项，失败 ${result.failureCount} 项。`,
        );
      }
      await load();
    } catch (cause) {
      const message = getErrorMessage(cause);
      setRunFeedback(message);
      onError(message);
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
          {!canRunAutomation && <p className="error-text">{connectionMessage}</p>}
        </div>
        <div className="automation-actions">
          <button
            className="secondary-button"
            disabled={busy !== null || !canRunAutomation}
            onClick={() => void execute(true)}
            type="button"
            title={canRunAutomation ? "只读检测，不会修改广告" : connectionMessage}
          >
            <RefreshCcw size={17} />
            {busy === "preview" ? "检测中…" : "检测预览"}
          </button>
          <button
            className="primary-button"
            disabled={busy !== null || !account.enabled || !canRunAutomation}
            onClick={() => void execute(false)}
            type="button"
            title={!canRunAutomation ? connectionMessage : account.enabled ? "按规则执行真实启停" : "请先在用户管理中开启账户自动化"}
          >
            <Play size={17} />
            {busy === "run" ? "运行中…" : "立即执行"}
          </button>
        </div>
      </div>
      {runFeedback && <div className={`automation-run-feedback ${latest?.status === "failed" ? "error" : "success"}`}>{runFeedback}</div>}

      <div className="panel automation-sync-panel">
        <div className="panel-heading"><div><span className="panel-icon"><ShieldCheck size={18} /></span><div><h2>账户接入状态</h2><p>由后台轮询维护；页面只展示已保存的最新结果，不会因切换页面重新检测。</p></div></div></div>
        <div className="sync-count-grid"><span>已接入 <strong>{overview.connectedCount}</strong></span><span>已开启自动化 <strong>{overview.automationEnabledCount}</strong></span><span>待处理接入 <strong>{unreadyAccounts.length}</strong></span></div>
        {unreadyAccounts.length > 0 ? <div className="sheet-issues warning"><strong>以下已开启自动化的账户尚不能运行</strong><ul>{unreadyAccounts.map((item) => <li key={item.accountId}><strong>{item.displayName}</strong>：{item.message}</li>)}</ul></div> : <p className="retention-note">所有已开启自动化的账户均已通过连接检测。</p>}
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
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={checked}
      className={checked ? "toggle checked" : "toggle"}
      disabled={disabled}
      title={disabled ? "账户尚未完成接入，完成后会自动开启自动化。" : undefined}
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
        <select aria-label="当前数据账户" value={selectedId} onChange={(event) => onSelect(event.target.value)}>
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
        latestSync: ReadOnlySyncResult | null;
  }
    | undefined,
  kind: ProviderKind,
): ReactNode {
  const connection = state?.connection;
  const cookieReadiness = state?.readiness;
  const latestSync = state?.latestSync;
  if (!connection || connection.status === "not-configured") {
    return <span className="status">未接入</span>;
  }
  if (kind === "cookie" && cookieReadiness && !cookieReadiness.fieldsComplete) {
    return (
      <span className="status warning">
        待导入 {cookieReadiness.completedFields}/5
      </span>
    );
  }
  if (kind === "cookie" && cookieReadiness && !cookieReadiness.statusRequestImported) {
    return <span className="status danger">启停能力未建立</span>;
  }
  if (connection.status === "ready") {
    const readStatus = !latestSync
      ? <span className="status warning">数据读取：待同步</span>
      : latestSync.counts["ad-group"] === 0
        ? <span className="status warning">数据读取：无广告组</span>
        : latestSync.warnings.length > 0
          ? <span className="status warning">数据读取：部分数据</span>
          : <span className="status active">数据读取：已接入</span>;
    return <div className="capability-statuses">{readStatus}<span className="status active">启停：已接入</span><span className="status">创建功能：暂未就绪</span></div>;
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

function scheduleStatusLabel(status: ScheduledEntityActionRecord["status"]): string {
  return { scheduled: "等待执行", completed: "已完成", failed: "失败", cancelled: "已取消" }[status];
}

function formatMetric(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function analyzeMetricBatches(batches: MetricBatchRecord[]) {
  const sorted = [...batches].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  const latest = sorted[0];
  return {
    latestSpend: latest?.spend ?? 0,
    latestClicks: latest?.clicks ?? 0,
    latestConversions: latest?.conversions ?? 0,
    batches: sorted,
  };
}

function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "发生未知错误。";
}
