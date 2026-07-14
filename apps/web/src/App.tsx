import {
  Activity,
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  CircleGauge,
  Database,
  Gauge,
  KeyRound,
  Layers3,
  Plus,
  PlugZap,
  Save,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
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
  AutomationSwitches,
  ProviderConnection,
  ProviderKind,
  ThresholdConfig,
  ThresholdInput,
} from "@tk-auto/core";
import {
  api,
  type BootstrapPayload,
  type SwitchDefinition,
} from "./api";
import { ConnectionPage } from "./ConnectionPage";
import { ManualPage } from "./ManualPage";

type PageKey =
  | "manual"
  | "connections"
  | "switches"
  | "configuration"
  | "thresholds";

const emptyThreshold: ThresholdInput = {
  code: "",
  label: "",
  metric: "cost_per_conversion",
  operator: "gte",
  value: 0,
  unit: "账户币种",
  stage: "stage-1",
  enabled: true,
};

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
    key: "connections",
    label: "接入管理",
    description: "连接检测与只读同步",
    icon: PlugZap,
  },
  {
    key: "switches",
    label: "自动化开关",
    description: "控制账户可执行能力",
    icon: SlidersHorizontal,
  },
  {
    key: "configuration",
    label: "配置管理",
    description: "接入方式与运行策略",
    icon: Settings2,
  },
  {
    key: "thresholds",
    label: "阈值配置",
    description: "定义自动化判断条件",
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

  const updateAccountInState = (updated: AccountConfig) => {
    setBootstrap((current) =>
      current
        ? {
            ...current,
            accounts: current.accounts.map((item) =>
              item.id === updated.id ? updated : item,
            ),
          }
        : current,
    );
  };

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
            <strong>核心配置阶段</strong>
            <small>未连接真实广告账户</small>
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
          <label className="account-picker">
            <span>操作账户</span>
            <div>
              <select
                value={selectedAccountId}
                onChange={(event) => setSelectedAccountId(event.target.value)}
              >
                {bootstrap.accounts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} />
            </div>
          </label>
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
        ) : !account ? (
          <EmptyState text="请选择一个账户。" />
        ) : page === "connections" ? (
          <ConnectionPage account={account} onError={setError} />
        ) : page === "switches" ? (
          <SwitchesPage
            account={account}
            definitions={bootstrap.switchDefinitions}
            onError={setError}
          />
        ) : page === "configuration" ? (
          <ConfigurationPage
            account={account}
            providers={bootstrap.providers}
            onSaved={updateAccountInState}
            onError={setError}
          />
        ) : (
          <ThresholdsPage account={account} onError={setError} />
        )}
      </main>
    </div>
  );
}

function SwitchesPage({
  account,
  definitions,
  onError,
}: {
  account: AccountConfig;
  definitions: SwitchDefinition[];
  onError: (message: string | null) => void;
}) {
  const [switches, setSwitches] = useState<AutomationSwitches | null>(null);
  const [saved, setSaved] = useState<AutomationSwitches | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSwitches(null);
    void api
      .getSwitches(account.id)
      .then((payload) => {
        setSwitches(payload);
        setSaved(payload);
      })
      .catch((cause) => onError(getErrorMessage(cause)));
  }, [account.id, onError]);

  const dirty =
    switches && saved ? JSON.stringify(switches) !== JSON.stringify(saved) : false;
  const enabledCount = switches
    ? Object.values(switches).filter(Boolean).length
    : 0;

  const save = async () => {
    if (!switches) return;
    try {
      setSaving(true);
      const result = await api.updateSwitches(account.id, switches);
      setSwitches(result);
      setSaved(result);
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!switches) return <EmptyState text="正在读取自动化开关…" loading />;

  return (
    <section className="page-stack">
      <div className="summary-grid">
        <SummaryCard
          icon={<CircleGauge size={20} />}
          label="已启用能力"
          value={`${enabledCount} / ${definitions.length}`}
          tone="blue"
        />
        <SummaryCard
          icon={<KeyRound size={20} />}
          label="当前接入"
          value={providerLabel(account.providerKind)}
          tone="violet"
        />
        <SummaryCard
          icon={<ShieldCheck size={20} />}
          label="执行模式"
          value={executionModeLabel(account.executionMode)}
          tone="green"
        />
      </div>

      <div className="section-heading">
        <div>
          <h2>账户能力开关</h2>
          <p>开关只定义规则引擎可使用的能力，当前阶段不会执行真实广告操作。</p>
        </div>
        <button
          className="primary-button"
          disabled={!dirty || saving}
          onClick={() => void save()}
          type="button"
        >
          <Save size={17} />
          {saving ? "保存中…" : dirty ? "保存更改" : "已保存"}
        </button>
      </div>

      <div className="switch-grid">
        {definitions.map((definition) => (
          <article className="switch-card" key={definition.key}>
            <div className="switch-card-copy">
              <div className="switch-title-row">
                <h3>{definition.label}</h3>
                <RiskBadge risk={definition.risk} />
              </div>
              <p>{definition.description}</p>
            </div>
            <Toggle
              checked={switches[definition.key]}
              label={definition.label}
              onChange={(checked) =>
                setSwitches((current) =>
                  current ? { ...current, [definition.key]: checked } : current,
                )
              }
            />
          </article>
        ))}
      </div>
    </section>
  );
}

function ConfigurationPage({
  account,
  providers,
  onSaved,
  onError,
}: {
  account: AccountConfig;
  providers: BootstrapPayload["providers"];
  onSaved: (account: AccountConfig) => void;
  onError: (message: string | null) => void;
}) {
  const [form, setForm] = useState<AccountSettingsUpdate>(() =>
    settingsFromAccount(account),
  );
  const [health, setHealth] = useState<ProviderConnection | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(settingsFromAccount(account));
    setHealth(null);
    void api
      .providerHealth(account.id)
      .then(setHealth)
      .catch((cause) => onError(getErrorMessage(cause)));
  }, [account, onError]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setSaving(true);
      const updated = await api.updateSettings(account.id, form);
      onSaved(updated);
      setHealth(await api.providerHealth(account.id));
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="page-stack two-column-layout">
      <form className="panel form-panel" onSubmit={(event) => void save(event)}>
        <div className="panel-heading">
          <div>
            <span className="panel-icon"><Settings2 size={18} /></span>
            <div>
              <h2>账号运行配置</h2>
              <p>这些设置独立于接入方式，可在 Cookie 与官方 API 间复用。</p>
            </div>
          </div>
        </div>

        <div className="form-grid">
          <Field label="账户名称">
            <input
              value={form.displayName}
              onChange={(event) =>
                setForm({ ...form, displayName: event.target.value })
              }
            />
          </Field>
          <Field label="接入方式">
            <select
              value={form.providerKind}
              onChange={(event) =>
                setForm({
                  ...form,
                  providerKind: event.target.value as ProviderKind,
                })
              }
            >
              {providers.map((provider) => (
                <option key={provider.kind} value={provider.kind}>
                  {provider.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="执行模式">
            <select
              value={form.executionMode}
              onChange={(event) =>
                setForm({
                  ...form,
                  executionMode: event.target
                    .value as AccountSettingsUpdate["executionMode"],
                })
              }
            >
              <option value="observe">仅观察</option>
              <option value="manual-approval">人工确认</option>
              <option value="automatic">全自动</option>
            </select>
          </Field>
          <Field label="轮询间隔（分钟）">
            <input
              min="1"
              max="1440"
              type="number"
              value={form.pollingIntervalMinutes}
              onChange={(event) =>
                setForm({
                  ...form,
                  pollingIntervalMinutes: Number(event.target.value),
                })
              }
            />
          </Field>
          <Field label="账户时区" wide>
            <input
              value={form.timezone}
              onChange={(event) =>
                setForm({ ...form, timezone: event.target.value })
              }
            />
          </Field>
        </div>

        <div className="inline-setting">
          <div>
            <strong>启用此账户</strong>
            <span>关闭后调度器将跳过该账户。</span>
          </div>
          <Toggle
            checked={form.enabled}
            label="启用此账户"
            onChange={(enabled) => setForm({ ...form, enabled })}
          />
        </div>

        <div className="form-actions">
          <button className="primary-button" disabled={saving} type="submit">
            <Save size={17} />
            {saving ? "保存中…" : "保存配置"}
          </button>
        </div>
      </form>

      <aside className="side-stack">
        <div className="panel provider-panel">
          <div className="provider-icon">
            {account.providerKind === "cookie" ? (
              <KeyRound size={24} />
            ) : (
              <Database size={24} />
            )}
          </div>
          <span className="eyebrow">Provider 状态</span>
          <h3>{providerLabel(account.providerKind)}</h3>
          <div className={`health-pill ${health?.status ?? "loading"}`}>
            <span />
            {health?.status === "not-configured"
              ? "尚未配置凭据"
              : health?.status === "ready"
                ? "连接正常"
                : health?.status === "failed"
                  ? "连接失败"
                  : health?.status === "untested"
                    ? "等待检测"
                    : "检查中"}
          </div>
          <p>{health?.lastMessage ?? "正在检查本地接入状态…"}</p>
        </div>

        <div className="notice-card">
          <ShieldCheck size={20} />
          <div>
            <strong>凭据安全边界</strong>
            <p>数据库只保存 credentialRef。真实 Cookie 或 Token 将由操作系统凭据库管理。</p>
          </div>
        </div>
      </aside>
    </section>
  );
}

function ThresholdsPage({
  account,
  onError,
}: {
  account: AccountConfig;
  onError: (message: string | null) => void;
}) {
  const [thresholds, setThresholds] = useState<ThresholdConfig[] | null>(null);
  const [editing, setEditing] = useState<ThresholdConfig | null>(null);
  const [form, setForm] = useState<ThresholdInput>(emptyThreshold);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setThresholds(await api.getThresholds(account.id));
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    }
  }, [account.id, onError]);

  useEffect(() => {
    setThresholds(null);
    setShowForm(false);
    void load();
  }, [load]);

  const openNew = () => {
    setEditing(null);
    setForm(emptyThreshold);
    setShowForm(true);
  };

  const openEdit = (threshold: ThresholdConfig) => {
    setEditing(threshold);
    setForm({
      code: threshold.code,
      label: threshold.label,
      metric: threshold.metric,
      operator: threshold.operator,
      value: threshold.value,
      unit: threshold.unit,
      stage: threshold.stage,
      enabled: threshold.enabled,
    });
    setShowForm(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setSaving(true);
      if (editing) {
        await api.updateThreshold(account.id, editing.id, form);
      } else {
        await api.createThreshold(account.id, form);
      }
      await load();
      setShowForm(false);
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (threshold: ThresholdConfig) => {
    if (!window.confirm(`确定删除阈值“${threshold.label}”吗？`)) return;
    try {
      await api.deleteThreshold(account.id, threshold.id);
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    }
  };

  const stats = useMemo(() => {
    const list = thresholds ?? [];
    return {
      enabled: list.filter((item) => item.enabled).length,
      stageOne: list.filter((item) => item.stage === "stage-1").length,
      stageTwo: list.filter((item) => item.stage === "stage-2").length,
    };
  }, [thresholds]);

  if (!thresholds) return <EmptyState text="正在读取阈值配置…" loading />;

  return (
    <section className="page-stack">
      <div className="summary-grid">
        <SummaryCard
          icon={<Check size={20} />}
          label="启用阈值"
          value={`${stats.enabled} 项`}
          tone="green"
        />
        <SummaryCard
          icon={<Layers3 size={20} />}
          label="第一阶段"
          value={`${stats.stageOne} 项`}
          tone="blue"
        />
        <SummaryCard
          icon={<Layers3 size={20} />}
          label="第二阶段"
          value={`${stats.stageTwo} 项`}
          tone="violet"
        />
      </div>

      <div className="panel table-panel">
        <div className="panel-heading">
          <div>
            <span className="panel-icon"><Gauge size={18} /></span>
            <div>
              <h2>阈值列表</h2>
              <p>阈值只保存判断条件；具体动作将在规则引擎阶段绑定。</p>
            </div>
          </div>
          <button className="primary-button" onClick={openNew} type="button">
            <Plus size={17} />
            新增阈值
          </button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>配置代码</th>
                <th>名称</th>
                <th>阶段</th>
                <th>判断条件</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {thresholds.map((threshold) => (
                <tr key={threshold.id}>
                  <td><code>{threshold.code}</code></td>
                  <td><strong>{threshold.label}</strong></td>
                  <td>{stageLabel(threshold.stage)}</td>
                  <td>
                    <span className="condition">
                      {operatorLabel(threshold.operator)} {threshold.value} {threshold.unit}
                    </span>
                  </td>
                  <td>
                    <span className={threshold.enabled ? "status active" : "status"}>
                      {threshold.enabled ? "启用" : "停用"}
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button type="button" onClick={() => openEdit(threshold)}>编辑</button>
                      <button
                        className="danger-link"
                        type="button"
                        onClick={() => void remove(threshold)}
                      >
                        <Trash2 size={15} /> 删除
                      </button>
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
          <form
            className="modal"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => void save(event)}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">阈值配置</span>
                <h2>{editing ? "编辑阈值" : "新增阈值"}</h2>
              </div>
              <button type="button" onClick={() => setShowForm(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="form-grid">
              <Field label="配置代码">
                <input
                  placeholder="例如 CPA_LEVEL1"
                  value={form.code}
                  onChange={(event) =>
                    setForm({ ...form, code: event.target.value.toUpperCase() })
                  }
                />
              </Field>
              <Field label="显示名称">
                <input
                  value={form.label}
                  onChange={(event) => setForm({ ...form, label: event.target.value })}
                />
              </Field>
              <Field label="指标">
                <select
                  value={form.metric}
                  onChange={(event) =>
                    setForm({ ...form, metric: event.target.value as ThresholdInput["metric"] })
                  }
                >
                  <option value="cost_per_conversion">平均转化成本</option>
                  <option value="cost_per_click">平均点击成本</option>
                  <option value="cost_per_cart">平均加购成本</option>
                  <option value="budget">预算</option>
                  <option value="spend">消耗</option>
                  <option value="conversions">转化量</option>
                  <option value="clicks">点击量</option>
                  <option value="custom">自定义</option>
                </select>
              </Field>
              <Field label="运算符">
                <select
                  value={form.operator}
                  onChange={(event) =>
                    setForm({ ...form, operator: event.target.value as ThresholdInput["operator"] })
                  }
                >
                  <option value="gte">大于等于</option>
                  <option value="gt">大于</option>
                  <option value="lte">小于等于</option>
                  <option value="lt">小于</option>
                </select>
              </Field>
              <Field label="阈值">
                <input
                  min="0"
                  step="0.01"
                  type="number"
                  value={form.value}
                  onChange={(event) => setForm({ ...form, value: Number(event.target.value) })}
                />
              </Field>
              <Field label="单位">
                <input
                  value={form.unit}
                  onChange={(event) => setForm({ ...form, unit: event.target.value })}
                />
              </Field>
              <Field label="阶段">
                <select
                  value={form.stage}
                  onChange={(event) =>
                    setForm({ ...form, stage: event.target.value as ThresholdInput["stage"] })
                  }
                >
                  <option value="stage-1">第一阶段</option>
                  <option value="stage-2">第二阶段</option>
                  <option value="global">全局</option>
                </select>
              </Field>
              <div className="field toggle-field">
                <span>状态</span>
                <Toggle
                  checked={form.enabled}
                  label="启用阈值"
                  onChange={(enabled) => setForm({ ...form, enabled })}
                />
              </div>
            </div>
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setShowForm(false)}>
                取消
              </button>
              <button className="primary-button" disabled={saving} type="submit">
                <Save size={17} /> {saving ? "保存中…" : "保存阈值"}
              </button>
            </div>
          </form>
        </div>
      )}
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

function RiskBadge({ risk }: { risk: SwitchDefinition["risk"] }) {
  const labels = { read: "只读", write: "写入", destructive: "高风险" };
  return <span className={`risk-badge ${risk}`}>{labels[risk]}</span>;
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
    enabled: account.enabled,
    providerKind: account.providerKind,
    timezone: account.timezone,
    pollingIntervalMinutes: account.pollingIntervalMinutes,
    executionMode: account.executionMode,
  };
}

function providerLabel(kind: ProviderKind): string {
  return kind === "cookie" ? "Cookie 会话" : "Marketing API";
}

function executionModeLabel(mode: AccountConfig["executionMode"]): string {
  return { observe: "仅观察", "manual-approval": "人工确认", automatic: "全自动" }[mode];
}

function stageLabel(stage: ThresholdConfig["stage"]): string {
  return { "stage-1": "第一阶段", "stage-2": "第二阶段", global: "全局" }[stage];
}

function operatorLabel(operator: ThresholdConfig["operator"]): string {
  return { gt: ">", gte: "≥", lt: "<", lte: "≤" }[operator];
}

function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "发生未知错误。";
}
