import {
  Activity,
  AlertTriangle,
  BarChart3,
  Ban,
  BellRing,
  Check,
  ChevronDown,
  CircleGauge,
  Gauge,
  ListFilter,
  ListChecks,
  LayoutDashboard,
  Layers3,
  Moon,
  Plus,
  Pencil,
  PlugZap,
  Play,
  RefreshCcw,
  Save,
  Settings2,
  ShieldCheck,
  Search,
  SlidersHorizontal,
  Sun,
  Trash2,
  UserRound,
  X,
} from "./ui/icons";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AccountConfig,
  AccountSettingsUpdate,
  AccountCreateInput,
  PlatformKind,
  GlobalAutomationSettings,
  AutomationDecisionRecord,
  AutomationRunRecord,
  AdOperationRecord,
  MetricBatchRecord,
  DailyMetricRecord,
  EntityRangeMetricRecord,
  ManagedEntityRecord,
  IgnoredEntityRecord,
  ProviderConnection,
  ProviderKind,
  ReadOnlySyncResult,
  ThresholdConfig,
  ScheduledEntityActionRecord,
  AccountProviderCapabilities,
  SyncEntityType,
} from "@tk-auto/core";
import { isNetworkUnreachableMessage } from "@tk-auto/core";
import {
  api,
  type BootstrapPayload,
  type CookieConnectionReadiness,
  type ProviderWriteCircuitState,
} from "./api";
import { ConnectionPage } from "./ConnectionPage";
import { ManualPage } from "./ManualPage";
import { NotificationsPage } from "./NotificationsPage";
import { RulesPage } from "./RulesPage";
import { AuthGate, useAuth } from "./AuthGate";
import { SystemUsersPage } from "./SystemUsersPage";
import { AutomationFeaturesPage } from "./AutomationFeaturesPage";
import { LaunchPage } from "./LaunchPage";
import { MaintenancePage } from "./MaintenancePage";
import { OverviewPage } from "./OverviewPage";
import { MetaAssetsPage } from "./MetaAssetsPage";
import { MetaRulesPage } from "./MetaRulesPage";
import {
  accountAccessStatus,
  canEnableAccountAutomation,
  hasProviderCapability,
  providerCapabilitySummary,
} from "./provider-capability-view";
import {
  resolveAnalysisRange,
  type AnalysisPreset,
} from "./analytics";
import { syncQualityPresentation } from "./sync-quality-view";
import { selectActionableDecisionHistory } from "./automation-decision-view";
import { nextUiTheme, resolveUiTheme, UI_THEME_STORAGE_KEY, type UiTheme } from "./ui-theme";
import {
  secondsUntilLocalRefresh,
} from "./local-refresh";
import {
  applyAccountPlatformSelection,
  filterMetaAccounts,
  filterTikTokOperationalAccounts,
} from "./platform-account-view";
import {
  describeDailyCoverage,
  isDailyMetricIncomplete,
  mergeDailyMetricsAcrossAccounts,
  summarizeDailyMetrics,
} from "./metric-days";
import {
  ADS_MANAGEMENT_DEFAULT_CREATED_WINDOW,
  ADS_MANAGEMENT_DEFAULT_SPEND_RANGE,
  ADS_MANAGEMENT_DEFAULT_LEVEL,
  ADS_MANAGEMENT_DEFAULT_STATUS,
  ADS_MANAGEMENT_PAGE_SIZE,
  ADS_MANAGEMENT_RECENT_WINDOW_HOURS,
  adsManagementParticipation,
  adsManagementParticipationLabel,
  adsManagementSpendRangeDays,
  adsManagementSpendRangeLabel,
  applyEntityRangeMetrics,
  adsManagementRank,
  compareAdsManagementSpend,
  filterAdsManagementEntities,
  paginateAdsManagementItems,
  sumAdsManagementConversions,
  type AdsManagementCreatedWindow,
  type AdsManagementParticipation,
  type AdsManagementSpendRange,
} from "./ads-management-view";
import { CommandPalette, OverlayProvider, useOverlays } from "./ui/overlays";
import { AccountManagement } from "./AccountManagement";
import { AccountShell } from "./ui/production/AccountShell";
import { X as AccountCloseIcon, FloppyDisk as AccountSaveIcon } from "@phosphor-icons/react";

export type PageKey =
  | "accounts"
  | "overview"
  | "manual"
  | "users"
  | "automation"
  | "ads"
  | "analytics"
  | "meta-assets"
  | "meta-rules"
  | "rules"
  | "notifications"
  | "launch"
  | "maintenance"
  | "system-users";

const selectedAccountStorageKey = "tk-auto:selected-account-id";

export const pageHash: Record<PageKey, string> = {
  accounts: "#accounts",
  overview: "#overview",
  manual: "#manual",
  users: "#users",
  automation: "#automation",
  ads: "#ads",
  analytics: "#analytics",
  "meta-assets": "#meta-assets",
  "meta-rules": "#meta-rules",
  rules: "#rules",
  notifications: "#notifications",
  launch: "#launch",
  maintenance: "#maintenance",
  "system-users": "#system-users",
};

export function pageFromHash(hash = window.location.hash): PageKey {
  // Account management now lives on the home page. Preserve old bookmarks by
  // redirecting them to the home page instead of keeping a duplicate route.
  if (hash === "#users") return "overview";
  // Meta workspace is intentionally retired from the UI for the current release.
  if (hash === "#meta-assets" || hash === "#meta-rules") return "overview";
  const found = (Object.entries(pageHash) as Array<[PageKey, string]>).find(
    ([, value]) => value === hash,
  );
  return found?.[0] ?? "overview";
}

export function accountIdForPage(
  accounts: AccountConfig[],
  selectedAccountId: string,
  page: PageKey,
): string {
  if (selectedAccountId !== "all" || page === "ads") return selectedAccountId;
  return accounts[0]?.id ?? "";
}

function preferredAccountId(
  accounts: AccountConfig[],
  states: BootstrapPayload["accountConnectionStates"],
  current: string,
): string {
  const available = new Set(accounts.map((account) => account.id));
  const remembered = window.localStorage.getItem(selectedAccountStorageKey) ?? "";
  if (current === "all" || remembered === "all") return "all";
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
  section: "基础" | "TikTok" | "Meta" | "系统";
}> = [
  {
    key: "accounts",
    label: "账户管理",
    description: "账户接入、同步与自动化",
    icon: UserRound,
    section: "基础",
  },
  {
    key: "overview",
    label: "总览",
    description: "TikTok 接入状态与待办",
    icon: LayoutDashboard,
    section: "基础",
  },
  {
    key: "automation",
    label: "自动化中心",
    description: "检测、预览与执行记录",
    icon: Play,
    section: "TikTok",
  },
  {
    key: "ads",
    label: "广告管理",
    description: "筛选、忽略与手动启停",
    icon: ListFilter,
    section: "TikTok",
  },
  {
    key: "analytics",
    label: "广告分析",
    description: "指标快照与执行结果",
    icon: BarChart3,
    section: "TikTok",
  },
  {
    key: "launch",
    label: "创建广告",
    description: "相同广告多账户投放",
    icon: Plus,
    section: "TikTok",
  },
  {
    key: "rules",
    label: "规则配置",
    description: "九条全局自动化规则",
    icon: Gauge,
    section: "系统",
  },
  {
    key: "notifications",
    label: "消息推送",
    description: "邮箱、企业微信与飞书",
    icon: BellRing,
    section: "系统",
  },
  {
    key: "system-users",
    label: "系统权限",
    description: "登录账户与角色权限",
    icon: ShieldCheck,
    section: "系统",
  },
  {
    key: "maintenance",
    label: "运维中心",
    description: "审计、备份、恢复与升级",
    icon: Settings2,
    section: "系统",
  },
];

export function canAccessNavigationItem(
  key: PageKey,
  permissions: readonly string[],
): boolean {
  if (key === "system-users") return permissions.includes("users:manage");
  if (key === "maintenance") return permissions.includes("system:control");
  return true;
}

function CommandPaletteItems({
  items, query, selectedIndex, onQueryChange, onSelectedIndexChange, onSelect,
}: {
  items: typeof navItems;
  query: string;
  selectedIndex: number;
  onQueryChange: (value: string) => void;
  onSelectedIndexChange: (value: number) => void;
  onSelect: (item: typeof navItems[number]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return keyword ? items.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(keyword)) : items;
  }, [items, query]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { onSelectedIndexChange(Math.min(selectedIndex, Math.max(visible.length - 1, 0))); }, [onSelectedIndexChange, selectedIndex, visible.length]);
  return <>
    <input aria-label="搜索命令" className="command-palette-search" placeholder="搜索页面…" ref={inputRef} value={query} onChange={(event) => { onQueryChange(event.target.value); onSelectedIndexChange(0); }} onKeyDown={(event) => {
      if (event.key === "ArrowDown") { event.preventDefault(); onSelectedIndexChange(Math.min(selectedIndex + 1, visible.length - 1)); }
      if (event.key === "ArrowUp") { event.preventDefault(); onSelectedIndexChange(Math.max(selectedIndex - 1, 0)); }
      if (event.key === "Enter" && visible[selectedIndex]) { event.preventDefault(); onSelect(visible[selectedIndex]); }
    }} />
    {visible.length === 0 ? <p className="overview-empty">没有匹配的页面</p> : visible.map((item, index) => {
      const Icon = item.icon;
      return <button className={index === selectedIndex ? "is-selected" : undefined} key={item.key} type="button" role="menuitem" onMouseEnter={() => onSelectedIndexChange(index)} onClick={() => onSelect(item)}><Icon size={15} /><span>{item.label}</span><small>{item.description}</small></button>;
    })}
  </>;
}

export function App() {
  const [theme, setTheme] = useState<UiTheme>(() => {
    try {
      return resolveUiTheme(window.localStorage.getItem(UI_THEME_STORAGE_KEY));
    } catch {
      return "light";
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(UI_THEME_STORAGE_KEY, theme);
    } catch {
      // Keep the selected theme for this session when storage is unavailable.
    }
  }, [theme]);

  return (
    <OverlayProvider><AuthGate>
      <ConsoleApp theme={theme} onThemeToggle={() => setTheme((current) => nextUiTheme(current))} />
    </AuthGate></OverlayProvider>
  );
}

function ConsoleApp({ theme, onThemeToggle }: { theme: UiTheme; onThemeToggle: () => void }) {
  const auth = useAuth();
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [analyticsScope, setAnalyticsScope] = useState("all");
  const [page, setPage] = useState<PageKey>(() => pageFromHash());
  const [error, setError] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const capabilityRefreshAttempts = useRef(new Set<string>());

  const loadBootstrap = useCallback(async () => {
    try {
      const payload = await api.bootstrap();
      const operationalAccounts = filterTikTokOperationalAccounts(payload.accounts);
      const operationalAccountIds = new Set(operationalAccounts.map((account) => account.id));
      setBootstrap(payload);
      setSelectedAccountId((current) => preferredAccountId(
        operationalAccounts,
        payload.accountConnectionStates.filter((state) => operationalAccountIds.has(state.accountId)),
        current,
      ));
      setError(null);
      const staleConnections = payload.accountConnectionStates.filter((state) => {
        // Meta health checks can reach Graph API. They must only run after an
        // explicit user click in MetaConnectionPage, never during bootstrap.
        if (!operationalAccountIds.has(state.accountId)) return false;
        const connection = state.connection;
        if (
          !connection?.hasCredential
          || connection.status !== "ready"
          || connection.capabilityVersion === state.capabilities.capabilityVersion
        ) return false;
        const key = `${state.accountId}:${connection.kind}:${state.capabilities.capabilityVersion}`;
        if (capabilityRefreshAttempts.current.has(key)) return false;
        capabilityRefreshAttempts.current.add(key);
        return true;
      });
      if (staleConnections.length > 0) {
        void Promise.allSettled(staleConnections.map((state) =>
          api.testConnection(state.accountId, state.connection!.kind),
        )).then(async () => {
          const refreshed = await api.bootstrap();
          setBootstrap(refreshed);
        }).catch((cause) => setError(getErrorMessage(cause)));
      }
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    if (!window.location.hash || window.location.hash === "#users") {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${pageHash.overview}`);
      setPage("overview");
    }
    const syncPageFromUrl = () => setPage(pageFromHash());
    window.addEventListener("hashchange", syncPageFromUrl);
    return () => window.removeEventListener("hashchange", syncPageFromUrl);
  }, []);

  useEffect(() => {
    const openCommand = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
      if (event.key === "Escape") setCommandOpen(false);
    };
    window.addEventListener("keydown", openCommand);
    return () => window.removeEventListener("keydown", openCommand);
  }, []);

  useEffect(() => { if (commandOpen) { setCommandQuery(""); setCommandIndex(0); } }, [commandOpen]);

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

  const operationalAccounts = bootstrap
    ? filterTikTokOperationalAccounts(bootstrap.accounts)
    : [];
  const operationalAccountIds = new Set(operationalAccounts.map((item) => item.id));
  const operationalConnectionStates = bootstrap?.accountConnectionStates.filter((item) => operationalAccountIds.has(item.accountId)) ?? [];
  const metaAccounts = bootstrap ? filterMetaAccounts(bootstrap.accounts) : [];
  const metaAccountIds = new Set(metaAccounts.map((item) => item.id));
  const metaConnectionStates = bootstrap?.accountConnectionStates.filter((item) => metaAccountIds.has(item.accountId)) ?? [];
  const pageAccountId = accountIdForPage(operationalAccounts, selectedAccountId, page);
  const account = operationalAccounts.find(
    (item) => item.id === pageAccountId,
  );
  const selectedConnection = bootstrap?.accountConnectionStates.find(
    (item) => item.accountId === pageAccountId,
  )?.connection ?? null;
  const selectedLatestSync = bootstrap?.accountConnectionStates.find(
    (item) => item.accountId === pageAccountId,
  )?.latestSync ?? null;
  const selectedCapabilities = bootstrap?.accountConnectionStates.find(
    (item) => item.accountId === pageAccountId,
  )?.capabilities;

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
    operationalAccounts,
    operationalConnectionStates,
  );

  const toggleSystemRuntime = async () => {
    if (runtimeBusy) return;
    try {
      setRuntimeBusy(true);
      await api.updateSystemRuntime(!bootstrap.systemRuntime.enabled);
      await loadBootstrap();
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setRuntimeBusy(false);
    }
  };

  const visibleNavigation = navItems.filter((item) => canAccessNavigationItem(item.key, auth.status.permissions));
  const pageTitle = page === "overview" ? "总览" : page === "manual" ? "操作手册" : visibleNavigation.find((item) => item.key === page)?.label ?? "工作空间";
  const headerActions = page === "accounts" ? undefined : (
    <>
      <div className="p-command-area">
        <button className="command-trigger" type="button" onClick={() => setCommandOpen((open) => !open)} aria-expanded={commandOpen}>
          <Search size={15} /><span>跳转账户、规则、任务…</span><kbd>Ctrl K</kbd>
        </button>
        {commandOpen && <CommandPalette onClose={() => setCommandOpen(false)}><CommandPaletteItems query={commandQuery} selectedIndex={commandIndex} onQueryChange={setCommandQuery} onSelectedIndexChange={setCommandIndex} items={visibleNavigation.filter((item) => item.key !== "overview")} onSelect={(item) => { navigateTo(item.key); setCommandOpen(false); }} /></CommandPalette>}
      </div>
      <button aria-label={theme === "light" ? "切换到深色模式" : "切换到浅色模式"} className="theme-toggle" onClick={onThemeToggle} title={theme === "light" ? "切换到深色模式" : "切换到浅色模式"} type="button">
        {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}<span>{theme === "light" ? "深色" : "浅色"}</span>
      </button>
    </>
  );
  const routeContent = page === "accounts" ? (
    <UsersPage
      production
      runtimeEnabled={bootstrap.systemRuntime.enabled}
      accounts={bootstrap.accounts}
      initialConnectionStates={Object.fromEntries(bootstrap.accountConnectionStates.map((state) => [state.accountId, { ...state, readiness: null }]))}
      onChanged={loadBootstrap}
      onError={setError}
    />
  ) : page === "overview" ? (
    <OverviewPage accounts={bootstrap.accounts} connectionStates={bootstrap.accountConnectionStates} runtime={bootstrap.systemRuntime} onNavigate={navigateTo}>
      <UsersPage
        production
        runtimeEnabled={bootstrap.systemRuntime.enabled}
        accounts={bootstrap.accounts}
        initialConnectionStates={Object.fromEntries(bootstrap.accountConnectionStates.map((state) => [state.accountId, { connection: state.connection, readiness: null, latestSync: state.latestSync, capabilities: state.capabilities }]))}
        onChanged={loadBootstrap}
        onError={setError}
      />
    </OverviewPage>
  ) : page === "manual" ? (
    <ManualPage />
  ) : page === "system-users" ? (
    <SystemUsersPage onError={setError} />
  ) : page === "maintenance" ? (
    <MaintenancePage accounts={bootstrap.accounts} onError={setError} />
  ) : page === "meta-assets" ? (
    <MetaAssetsPage accounts={metaAccounts} connectionStates={metaConnectionStates} onConnectionsChanged={loadBootstrap} onError={setError} onOpenAccounts={() => { navigateTo("overview"); window.setTimeout(() => document.getElementById("account-management")?.scrollIntoView({ behavior: "smooth" }), 0); }} />
  ) : page === "meta-rules" ? (
    <MetaRulesPage accounts={metaAccounts} onError={setError} />
  ) : page === "rules" ? (
    <RulesPage settings={bootstrap.globalAutomationSettings} onSettingsSaved={loadBootstrap} onError={setError} />
  ) : page === "notifications" ? (
    <NotificationsPage onError={setError} />
  ) : page === "launch" ? (
    <LaunchPage accounts={operationalAccounts} accountCapabilities={Object.fromEntries(operationalConnectionStates.map((state) => [state.accountId, state.capabilities]))} connectionStates={operationalConnectionStates} preferredAccountId={pageAccountId} onConnectionStatesChanged={loadBootstrap} onManageConnection={(accountId) => { selectAccount(accountId); navigateTo("overview"); window.setTimeout(() => document.getElementById("account-management")?.scrollIntoView({ behavior: "smooth" }), 0); }} onError={setError} />
  ) : page === "ads" ? (
    <AccountScopedPage accounts={operationalAccounts} selectedId={selectedAccountId} onSelect={selectAccount} allowAll>
      {selectedAccountId === "all" ? <AllAccountsAdsView accounts={operationalAccounts} accountCapabilities={Object.fromEntries(operationalConnectionStates.map((state) => [state.accountId, state.capabilities]))} onError={setError} /> : account ? <AdsManagementPage account={account} capabilities={selectedCapabilities} key={account.id} pollingIntervalMinutes={bootstrap.globalAutomationSettings.pollingIntervalMinutes} onError={setError} /> : <EmptyState text="请选择一个账户。" />}
    </AccountScopedPage>
  ) : !account ? (
    <EmptyState text="请选择一个账户。" />
  ) : page === "automation" ? (
    <section className="page-stack"><AccountScopedPage accounts={operationalAccounts} selectedId={pageAccountId} onSelect={selectAccount}><AutomationPage account={account} connection={selectedConnection} capabilities={selectedCapabilities} maxActionsPerRun={bootstrap.globalAutomationSettings.maxActionsPerRun} overview={automationOverview} accounts={operationalAccounts} connectionStates={operationalConnectionStates.map((state) => ({ accountId: state.accountId, connection: state.connection }))} onError={setError} /></AccountScopedPage></section>
  ) : page === "analytics" ? (
    <AccountScopedPage accounts={operationalAccounts} selectedId={analyticsScope} onSelect={setAnalyticsScope} allowAll>{analyticsScope === "all" ? <AllAccountsAnalyticsView accounts={operationalAccounts} onError={setError} /> : (() => { const scopedAccount = operationalAccounts.find((item) => item.id === analyticsScope); const scopedState = operationalConnectionStates.find((state) => state.accountId === analyticsScope); return scopedAccount ? <AnalyticsPage account={scopedAccount} connection={scopedState?.connection ?? null} latestSync={scopedState?.latestSync ?? null} onError={setError} /> : <EmptyState text="请选择账户。" />; })()}</AccountScopedPage>
  ) : (
    <EmptyState text="页面不存在。" />
  );

  return <AccountShell navigation={visibleNavigation} onNavigate={(key) => navigateTo(key as PageKey)} runtimeEnabled={bootstrap.systemRuntime.enabled} runtimeBusy={runtimeBusy} canControl={auth.status.permissions.includes("system:control")} onToggleRuntime={() => void toggleSystemRuntime()} userName={auth.status.user?.displayName ?? "当前用户"} onLogout={() => void auth.logout()} error={error} onDismissError={() => setError(null)} activeKey={page} pageTitle={pageTitle} headerActions={headerActions}>{routeContent}</AccountShell>;
}

const defaultAccountInput: AccountCreateInput = {
  displayName: "",
  platform: "tiktok",
  accountType: "standard",
  enabled: false,
  providerKind: "cookie",
};

const defaultAccountEditorInput: AccountCreateInput = {
  ...defaultAccountInput,
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
  const providerLabel = account.providerKind === "meta-offline"
    ? "Meta 离线架构"
    : account.providerKind === "meta-marketing-api"
      ? "Meta Marketing API"
    : account.providerKind === "cookie" ? "Cookie 接入" : "API 接入";
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

// 传入判定结果而不是对象：切到多日区间后行上的指标是区间合计，
// 而参与与否必须继续按当天数据判定，不能让展示口径倒灌进判据。
/** 「消耗日期」区间换算成接口需要的起止时间；与广告分析共用 resolveAnalysisRange 的语义。 */
function spendRangeToRange(range: AdsManagementSpendRange): { from: string; to: string } {
  const days = adsManagementSpendRangeDays(range);
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));
  return { from: from.toISOString(), to: new Date().toISOString() };
}

function renderAdsManagementParticipation(participation: AdsManagementParticipation): ReactNode {
  if (participation === "manual-takeover") {
    return <span className="risk-badge destructive">{adsManagementParticipationLabel(participation)}</span>;
  }
  if (participation === "outside-window") {
    return (
      <span
        className="status"
        title={`创建时间已超出 ${ADS_MANAGEMENT_RECENT_WINDOW_HOURS} 小时规则窗口，且当天无消耗、不在自动化管辖中；规则引擎不会评估它。`}
      >
        {adsManagementParticipationLabel(participation)}
      </span>
    );
  }
  return adsManagementParticipationLabel(participation);
}

function connectionStatusSummary(
  account: AccountConfig,
  connection: ProviderConnection | null | undefined,
): string {
  if (!connection || connection.status === "not-configured") {
    return account.providerKind === "meta-offline"
      ? "离线架构已建立，API 尚未接入"
      : "尚未导入接入信息";
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

function canEnableConfiguredAccountAutomation(
  account: AccountConfig,
  state: {
    connection: ProviderConnection | null;
    capabilities: AccountProviderCapabilities | undefined;
  } | undefined,
): boolean {
  if (account.providerKind === "meta-offline") return false;
  if (account.platform === "meta") {
    const settings = state?.connection?.settings;
    return state?.connection?.status === "ready"
      && settings?.kind === "meta-marketing-api"
      && settings.liveMode === "automation-status"
      && hasProviderCapability(state.capabilities, "read-campaigns")
      && hasProviderCapability(state.capabilities, "read-ad-groups")
      && hasProviderCapability(state.capabilities, "read-ads")
      && hasProviderCapability(state.capabilities, "change-status");
  }
  return state?.connection?.status === "ready"
    && canEnableAccountAutomation(state.capabilities);
}

function UsersPage({
  production = false,
  runtimeEnabled = false,
  accounts,
  initialConnectionStates,
  onChanged,
  onError,
}: {
  production?: boolean;
  runtimeEnabled?: boolean;
  accounts: AccountConfig[];
  initialConnectionStates: Record<
    string,
    {
      connection: ProviderConnection | null;
      readiness: CookieConnectionReadiness | null;
      latestSync: ReadOnlySyncResult | null;
      capabilities: AccountProviderCapabilities;
    }
  >;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const auth = useAuth();
  const { confirm, prompt, toast } = useOverlays();
  const canManageAccounts = auth.status.permissions.includes("accounts:manage");
  const [editing, setEditing] = useState<AccountConfig | null>(null);
  const [form, setForm] = useState<AccountCreateInput>(defaultAccountEditorInput);
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
        capabilities: AccountProviderCapabilities;
      }
    >
  >(initialConnectionStates);

  useEffect(() => {
    setConnectionStates(initialConnectionStates);
  }, [initialConnectionStates]);

  useEffect(() => {
    if (production) return;
    const timer = window.setInterval(() => void onChanged(), 30_000);
    return () => window.clearInterval(timer);
  }, [onChanged, production]);

  const openNew = () => {
    if (!canManageAccounts) return;
    setEditing(null);
    setForm(defaultAccountEditorInput);
    setShowForm(true);
  };

  const openEdit = (account: AccountConfig) => {
    if (!canManageAccounts) return;
    setEditing(account);
    setForm({ ...settingsFromAccount(account), platform: account.platform });
    setShowForm(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canManageAccounts) return;
    try {
      setSaving(true);
      const enablesAutomation = form.enabled && (!editing || !editing.enabled);
      if (
        enablesAutomation
        && (!editing || !canEnableConfiguredAccountAutomation(
          editing,
          connectionStates[editing.id],
        ))
      ) {
        throw new Error("账户缺少数据读取或广告启停能力，不能开启自动化。");
      }
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
    if (!canManageAccounts) return;
    try {
      if (
        !account.enabled
        && !canEnableConfiguredAccountAutomation(account, connectionStates[account.id])
      ) {
        throw new Error("账户缺少数据读取或广告启停能力，不能开启自动化。");
      }
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
    if (!canManageAccounts) return;
    if (account.platform === "meta") {
      // Meta connection testing is explicit, but account automation remains a
      // separate user decision after selecting automation-status liveMode.
      await onChanged();
      return;
    }
    const capabilities = await api.getAccountCapabilities(account.id);
    if (!canEnableAccountAutomation(capabilities)) {
      await onChanged();
      onError("接入已保存，但当前缺少数据读取或广告启停能力，自动化未开启。");
      return;
    }
    if (!account.enabled) {
      await api.updateSettings(account.id, {
        ...settingsFromAccount(account),
        enabled: true,
      });
    }
    await onChanged();
  };

  const deleteAccount = async (account: AccountConfig) => {
    if (!canManageAccounts) return;
    const confirmation = `确认删除广告账户“${account.displayName}”吗？\n\n此操作不可撤销，将删除该账户的本地接入凭据、投放计划、操作记录及全部账户级数据。若它是多账户计划的来源，该共享计划也会删除；其他账户的凭据、规则和配置不会受影响。`;
    if (!await confirm({ title: "删除广告账户", message: confirmation, confirmLabel: "删除账户", danger: true })) return;
    try {
      setSaving(true);
      await api.deleteAccount(account.id);
      await onChanged();
      onError(null);
      toast("广告账户已删除");
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const bulkAutomation = async (selected: AccountConfig[], enabled: boolean) => {
    if (!canManageAccounts) return;
    const eligible = selected.filter((account) => account.enabled !== enabled && (!enabled || canEnableConfiguredAccountAutomation(account, connectionStates[account.id])));
    if (!eligible.length) return;
    const skipped = selected.length - eligible.length;
    if (!await confirm({ title: enabled ? "批量开启账户自动化" : "批量关闭账户自动化", message: `将${enabled ? "开启" : "关闭"} ${eligible.length} 个账户的自动化开关。${skipped ? `另有 ${skipped} 个账户因状态相同或能力未就绪而跳过。` : ""}${enabled ? "开启后由全局自动化状态与现有规则决定是否执行。" : "此操作不会直接关闭正在投放的广告。"}`, confirmLabel: "确认修改" })) return;
    const failures: string[] = [];
    let succeeded = 0;
    setSaving(true);
    try {
      for (const account of eligible) {
        try { await api.updateSettings(account.id, { ...settingsFromAccount(account), enabled }); succeeded++; }
        catch (cause) { failures.push(`${account.displayName}：${getErrorMessage(cause)}`); }
      }
      await onChanged();
      toast(`已更新 ${succeeded} 个账户${skipped ? `，跳过 ${skipped} 个` : ""}`, failures.length ? "error" : "success");
      if (failures.length) onError(`${failures.length} 个账户修改失败：${failures.join("；")}`);
    } finally { setSaving(false); }
  };

  const renderAccountRows = (platform: PlatformKind) => {
    const platformAccounts = accounts.filter((account) => account.platform === platform);
    if (platformAccounts.length === 0) {
      return <tr><td colSpan={7} className="account-platform-empty">暂无 {platformLabel(platform)} 账户。</td></tr>;
    }
    return platformAccounts.map((account) => {
      const automationReady = canEnableConfiguredAccountAutomation(
        account,
        connectionStates[account.id],
      );
      return (
        <tr key={account.id}>
          <td><strong>{account.displayName}</strong><br /><small className="account-id">{account.id}</small></td>
          <td>{accountTypeLabel(account.accountType)}</td>
          <td>{providerLabel(account.providerKind)}</td>
          <td>{connectionStateLabel(connectionStates[account.id], account.providerKind)}</td>
          <td>{providerCapabilitySummary(connectionStates[account.id]?.capabilities)}</td>
          <td>
            <div className="account-automation-toggle">
              <Toggle
                checked={account.enabled}
                disabled={!canManageAccounts || (!account.enabled && !automationReady)}
                label={`${account.displayName}：${account.enabled ? "关闭" : "开启"}账户自动化`}
                onChange={() => void toggleAccount(account)}
              />
              <span className={automationReady && account.enabled ? "status active" : "status"}>{account.platform === "meta" ? account.providerKind === "meta-offline" ? "离线架构不可开启" : account.enabled ? automationReady ? "Meta 账户已开启" : "已开启 · 接入异常" : automationReady ? "Meta 账户已关闭" : "需 Automation liveMode" : account.enabled ? automationReady ? "已开启" : "已开启 · 能力异常" : automationReady ? "已关闭" : "能力接入后开启"}</span>
            </div>
          </td>
          <td>
            <div className="row-actions">
              <button disabled={!canManageAccounts} type="button" onClick={() => openEdit(account)}><Pencil size={14} /> 编辑</button>
              <button disabled={!canManageAccounts || account.providerKind === "meta-offline"} title={account.providerKind === "meta-offline" ? "Meta 离线 Provider 不接收任何凭据" : undefined} type="button" onClick={() => setConnecting(account)}><PlugZap size={14} /> {account.providerKind === "meta-offline" ? "离线" : "接入"}</button>
              <button className="danger-button" disabled={saving || !canManageAccounts} type="button" onClick={() => void deleteAccount(account)}><Trash2 size={14} /> 删除</button>
            </div>
          </td>
        </tr>
      );
    });
  };

  const renderPlatformAccountGroup = (
    platform: PlatformKind,
    title: string,
    description: string,
  ) => {
    const count = accounts.filter((account) => account.platform === platform).length;
    return (
      <section className={`account-platform-group account-platform-${platform}`}>
        <header className="account-platform-heading">
          <div>
            <span className={platform === "meta" ? "status warning" : "status active"}>{platformLabel(platform)}</span>
            <div><h3>{title}</h3><p>{description}</p></div>
          </div>
          <strong>{count} 个账户</strong>
        </header>
        <div className="table-wrap">
          <table>
            <thead><tr><th>账户名称</th><th>账户类型</th><th>接入方式</th><th>接入状态</th><th>可用能力</th><th>自动化开关</th><th>操作</th></tr></thead>
            <tbody>{renderAccountRows(platform)}</tbody>
          </table>
        </div>
      </section>
    );
  };

  return (
    <section className="page-stack" id="account-management">
      {production ? <AccountManagement
        accounts={accounts} states={connectionStates} canManage={canManageAccounts} saving={saving} runtimeEnabled={runtimeEnabled}
        canEnable={(account) => canEnableConfiguredAccountAutomation(account, connectionStates[account.id])}
        onNew={openNew} onEdit={openEdit} onConnect={setConnecting} onDelete={deleteAccount} onToggle={toggleAccount}
        onRefresh={onChanged} onBulk={bulkAutomation}
      /> : <>
      <div className="panel table-panel">
        <div className="panel-heading">
          <div>
            <span className="panel-icon"><UserRound size={18} /></span>
            <div>
              <h2>广告平台账户</h2>
              <p>TikTok 与 Meta 账户分区管理；接入、能力与自动化状态互不混用。</p>
            </div>
          </div>
          <button className="primary-button" disabled={!canManageAccounts} onClick={openNew} title={canManageAccounts ? undefined : "需要 accounts:manage 权限"} type="button">
            <Plus size={17} /> 新增账户
          </button>
        </div>
        <div className="account-platform-groups">
          {renderPlatformAccountGroup("tiktok", "TikTok Ads 账户", "Cookie / 官方 API 接入与 TikTok 自动化")}
          {renderPlatformAccountGroup("meta", "Meta Ads 账户", "Marketing API 接入与 Meta 独立自动化")}
        </div>
      </div>
      </>}

      {showForm && (
        <div className="modal-backdrop" onMouseDown={() => setShowForm(false)}>
          <form className="modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void save(event)}>
            <div className="modal-heading">
              <div><span className="eyebrow">用户管理</span><h2>{editing ? "编辑广告账户" : "新增广告账户"}</h2></div>
              <button aria-label="关闭账户编辑" type="button" onClick={() => setShowForm(false)}>{production ? <AccountCloseIcon size={20} /> : <X size={20} />}</button>
            </div>
            <div className="form-grid">
              <Field label="账户名称">
                <input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
              </Field>
              <Field label="广告平台">
                <select disabled={Boolean(editing)} value={form.platform ?? "tiktok"} onChange={(event) => {
                  const platform = event.target.value as PlatformKind;
                  setForm(applyAccountPlatformSelection(form, platform));
                }}>
                  <option value="tiktok">TikTok Ads</option>
                  <option value="meta">Meta Ads（Facebook / Instagram）</option>
                </select>
              </Field>
              <Field label="账户类型">
                <select value={form.accountType} onChange={(event) => setForm({ ...form, accountType: event.target.value as AccountCreateInput["accountType"] })}>
                  <option value="standard">普通广告账户</option>
                  <option value="agency">代理账户</option>
                  {(form.platform ?? "tiktok") === "tiktok" && <option value="shop">TikTok Shop</option>}
                </select>
              </Field>
              <Field label="默认接入方式">
                <select value={form.providerKind} onChange={(event) => {
                  const providerKind = event.target.value as ProviderKind;
                  setForm({
                    ...form,
                    providerKind,
                    enabled: providerKind === "meta-offline" ? false : form.enabled,
                  });
                }}>
                  {(form.platform ?? "tiktok") === "meta" ? <>
                    <option value="meta-marketing-api">Meta Marketing API（官方接入）</option>
                    <option value="meta-offline">Meta 离线架构</option>
                  </> : <>
                    <option value="cookie">Cookie 会话</option>
                    <option value="official-api">TikTok Marketing API</option>
                  </>}
                </select>
              </Field>
              <div className="field toggle-field"><span>自动化开关</span><Toggle checked={form.enabled} disabled={form.providerKind === "meta-offline" || (!form.enabled && (!editing || !canEnableConfiguredAccountAutomation(editing, connectionStates[editing.id])))} label="自动化开关" onChange={(enabled) => setForm({ ...form, enabled })} /></div>
              {(form.platform ?? "tiktok") === "meta" && <p className="retention-note">Meta Marketing API 账户可在完成共享 App 档案、Automation liveMode 与能力检测后独立开启；Meta 离线架构始终关闭。</p>}
            </div>
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setShowForm(false)}>取消</button>
              <button className="primary-button" disabled={saving} type="submit">{production ? <AccountSaveIcon size={17} /> : <Save size={17} />} {saving ? "保存中…" : "保存账户"}</button>
            </div>
          </form>
        </div>
      )}

      {connecting && (
        <div className="modal-backdrop" onMouseDown={() => setConnecting(null)}>
          <div className="modal connection-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><span className="eyebrow">广告账户接入</span><h2>{connecting.displayName}</h2></div>
              <button aria-label="关闭账户接入" type="button" onClick={() => { setConnecting(null); void onChanged(); }}>{production ? <AccountCloseIcon size={20} /> : <X size={20} />}</button>
            </div>
            <ConnectionPage account={connecting} onConnectionReady={() => enableAfterConnection(connecting)} onError={onError} />
          </div>
        </div>
      )}
    </section>
  );
}

function scrollToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

type RuleValueMap = Record<string, Record<string, number>>;

// 依据九条关闭规则的阈值，判断广告对象哪些指标已越线（用于标红）。
// 仅纳入已启用规则；按转化量选择对应的零转化 / 有转化阈值。
function metricBreaches(metrics: ManagedEntityRecord["metrics"], rules: RuleValueMap): { spend: boolean; cpa: boolean; carts: boolean; cpc: boolean } {
  const conversions = metrics.conversions ?? 0;
  const spend = metrics.spend ?? 0;
  const carts = metrics.carts ?? 0;
  const cpc = metrics.cost_per_click ?? 0;
  const cpa = metrics.cost_per_conversion ?? 0;
  const result = { spend: false, cpa: false, carts: false, cpc: false };
  const over = (code: string, field: string, value: number) => {
    const limit = rules[code]?.[field];
    return typeof limit === "number" && value > limit;
  };
  if (conversions === 0) {
    if (over("NO_CONV_SPEND_CLOSE", "spend", spend)) result.spend = true;
    if (over("NO_CONV_CPC_CLOSE", "cpc", cpc)) result.cpc = true;
  } else {
    if (over("CV1_CPC_CLOSE", "cpc", cpc)) result.cpc = true;
    if (over(conversions >= 2 ? "CV2_CPA_CLOSE" : "CV1_CPA_CLOSE", "cpa", cpa)) result.cpa = true;
  }
  const cartRule = rules.NO_CART_CLOSE;
  if (cartRule && typeof cartRule.spend === "number" && spend >= cartRule.spend && carts <= (cartRule.carts ?? 0)) {
    result.carts = true;
  }
  return result;
}

function AdsManagementPage({
  account,
  capabilities,
  pollingIntervalMinutes,
  onError,
}: {
  account: AccountConfig;
  capabilities: AccountProviderCapabilities | undefined;
  pollingIntervalMinutes: number;
  onError: (message: string | null) => void;
}) {
  const auth = useAuth();
  const { confirm, prompt, toast } = useOverlays();
  const canOperateAds = auth.status.permissions.includes("ads:operate");
  const [entities, setEntities] = useState<ManagedEntityRecord[] | null>(null);
  const [operations, setOperations] = useState<AdOperationRecord[]>([]);
  const [decisions, setDecisions] = useState<AutomationDecisionRecord[]>([]);
  const [schedules, setSchedules] = useState<ScheduledEntityActionRecord[]>([]);
  const activeScheduleCount = schedules.filter((schedule) => schedule.status === "scheduled").length;
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<"all" | ManagedEntityRecord["entityType"]>(ADS_MANAGEMENT_DEFAULT_LEVEL);
  const [statusFilter, setStatusFilter] = useState<"all" | ManagedEntityRecord["status"]>(ADS_MANAGEMENT_DEFAULT_STATUS);
  const [createdWindow, setCreatedWindow] = useState<AdsManagementCreatedWindow>(ADS_MANAGEMENT_DEFAULT_CREATED_WINDOW);
  const [spendRange, setSpendRange] = useState<AdsManagementSpendRange>(ADS_MANAGEMENT_DEFAULT_SPEND_RANGE);
  const [rangeMetrics, setRangeMetrics] = useState<EntityRangeMetricRecord[] | null>(null);
  const [page, setPage] = useState(0);
  const [manualTakeovers, setManualTakeovers] = useState<IgnoredEntityRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [nextRefreshAt, setNextRefreshAt] = useState(() => Date.now());
  const [remoteRefreshing, setRemoteRefreshing] = useState(false);
  const remoteRefreshRunning = useRef(false);
  const [statusConfirming, setStatusConfirming] = useState<ManagedEntityRecord | null>(null);
  const [scheduling, setScheduling] = useState<ManagedEntityRecord | null>(null);
  const [scheduleKind, setScheduleKind] = useState<"once" | "overnight">("once");
  const [scheduledAction, setScheduledAction] = useState<"enable" | "disable">("disable");
  const [runAt, setRunAt] = useState("");
  const [disableAt, setDisableAt] = useState("");
  const [enableAt, setEnableAt] = useState("");
  const canChangeStatus = hasProviderCapability(capabilities, "change-status");
  const [ruleValues, setRuleValues] = useState<RuleValueMap>({});
  useEffect(() => {
    void api.getRuleConfiguration()
      .then((config) => setRuleValues(Object.fromEntries(config.rules.filter((rule) => rule.enabled).map((rule) => [rule.code, rule.values]))))
      .catch(() => undefined);
  }, []);
  const canRefreshRemote = hasProviderCapability(capabilities, "read-campaigns");

  // 「今天」沿用同步快照里的当日累计，不额外请求；多日区间才走日聚合接口。
  useEffect(() => {
    if (spendRange === "today") {
      setRangeMetrics(null);
      return;
    }
    let cancelled = false;
    void api
      .getEntityRangeMetrics(account.id, spendRangeToRange(spendRange))
      .then((result) => { if (!cancelled) setRangeMetrics(result); })
      .catch((cause) => { if (!cancelled) onError(getErrorMessage(cause)); });
    return () => { cancelled = true; };
  }, [account.id, onError, spendRange]);

  const load = useCallback(async () => {
    try {
      const [nextEntities, nextOperations, nextDecisions, nextSchedules, nextManualTakeovers] = await Promise.all([
        api.getManagedEntities(account.id),
        api.getAdOperations(account.id),
        api.getAutomationDecisions(account.id),
        api.getSchedules(account.id),
        api.getManualTakeovers(account.id),
      ]);
      setEntities(nextEntities);
      setOperations(nextOperations);
      setDecisions(nextDecisions);
      setSchedules(nextSchedules);
      setManualTakeovers(nextManualTakeovers);
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    }
  }, [account.id, onError]);

  const refreshRemote = useCallback(async () => {
    if (!canRefreshRemote) {
      await load();
      return;
    }
    if (remoteRefreshRunning.current) return;
    remoteRefreshRunning.current = true;
    setRemoteRefreshing(true);
    try {
      await api.syncReadOnly(account.id, account.providerKind);
      await load();
      onError(null);
    } catch (cause) {
      await load();
      onError(getErrorMessage(cause));
    } finally {
      remoteRefreshRunning.current = false;
      setRemoteRefreshing(false);
    }
  }, [account.id, account.providerKind, canRefreshRemote, load, onError]);

  useEffect(() => {
    setEntities(null);
    void load();
  }, [load]);

  useEffect(() => {
    let stopped = false;
    let refreshTimer: number | null = null;
    const clockTimer = window.setInterval(() => setClock(Date.now()), 1_000);

    const intervalMs = Math.max(60_000, pollingIntervalMinutes * 60_000);
    const runAndSchedule = async () => {
      await refreshRemote();
      if (stopped) return;
      const next = Date.now() + intervalMs;
      setNextRefreshAt(next);
      refreshTimer = window.setTimeout(() => void runAndSchedule(), intervalMs);
    };
    void runAndSchedule();
    return () => {
      stopped = true;
      window.clearInterval(clockTimer);
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [pollingIntervalMinutes, refreshRemote]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  // 可见性与参与判定一律基于当天指标（规则引擎判的就是当天），区间指标只用于展示。
  const scoped = useMemo(() => {
    const list = filterAdsManagementEntities(entities ?? [], {
      level,
      status: statusFilter,
      query,
      createdWindow,
    });
    // 人工接管的广告组始终置顶；其余保持既有排序（如消耗降序）。sort 稳定，不打乱同类相对顺序。
    return [...list].sort((left, right) => Number(Boolean(right.ignored)) - Number(Boolean(left.ignored)));
  }, [entities, createdWindow, level, query, statusFilter]);
  const participationByKey = useMemo(() => new Map(
    scoped.map((entity) => [
      `${entity.entityType}:${entity.externalId}`,
      adsManagementParticipation(entity),
    ]),
  ), [scoped]);
  const filtered = useMemo(() => {
    if (spendRange === "today" || !rangeMetrics) return scoped;
    const applied = applyEntityRangeMetrics(scoped, rangeMetrics);
    // 换成区间口径后按区间消耗重排，失效对象沉底、人工接管仍置顶。
    return [...applied]
      .sort((left, right) => (
        adsManagementRank(left) - adsManagementRank(right)
        || compareAdsManagementSpend(left, right)
      ))
      .sort((left, right) => Number(Boolean(right.ignored)) - Number(Boolean(left.ignored)));
  }, [rangeMetrics, scoped, spendRange]);
  const {
    items: pagedEntities,
    pageCount,
    currentPage,
  } = paginateAdsManagementItems(filtered, page);

  useEffect(() => setPage(0), [level, query, spendRange, statusFilter]);
  useEffect(() => setPage((current) => Math.min(current, pageCount - 1)), [pageCount]);
  const pendingStatusKeys = useMemo(() => new Set(
    operations
      .filter((operation) => operation.status === "pending" || operation.status === "running")
      .map((operation) => `${operation.entityType}:${operation.externalId}`),
  ), [operations]);

  const changeStatus = async (entity: ManagedEntityRecord) => {
    if (!canOperateAds) return;
    const action = entity.status === "disabled" ? "enable" : "disable";
    try {
      setBusy(`${entity.entityType}:${entity.externalId}:status`);
      const task = await api.changeEntityStatus(account.id, {
        entityType: entity.entityType,
        externalId: entity.externalId,
        action,
      });
      setOperations((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      void load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggleManualTakeover = async (entity: ManagedEntityRecord) => {
    if (!canOperateAds) return;
    try {
      setBusy(`${entity.entityType}:${entity.externalId}:takeover`);
      if (entity.ignored) {
        await api.unignoreEntity(account.id, entity.entityType, entity.externalId);
      } else {
        const reason = (await prompt({ title: "人工接管", message: "请输入接管原因；该广告组将不再参与自动化。", defaultValue: "人工接管，不参与自动化", required: true, confirmLabel: "确认接管" }))?.trim();
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

  const restoreManualTakeover = async (takeover: IgnoredEntityRecord) => {
    if (!canOperateAds) return;
    try {
      setBusy(`${takeover.entityType}:${takeover.externalId}:takeover`);
      await api.unignoreEntity(account.id, takeover.entityType, takeover.externalId);
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const restoreAllManualTakeovers = async () => {
    if (!canOperateAds || manualTakeovers.length === 0) return;
    if (!await confirm({ title: "恢复自动化", message: `确认恢复 ${manualTakeovers.length} 个广告组的自动化？`, confirmLabel: "恢复" })) return;
    try {
      setBusy("restore-all-takeovers");
      await api.restoreAllManualTakeovers(account.id);
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const saveSchedule = async (event: FormEvent) => {
    event.preventDefault();
    if (!scheduling || !canOperateAds) return;
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
    if (!canOperateAds) return;
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
  const refreshSeconds = secondsUntilLocalRefresh(nextRefreshAt, clock);
  const latestEntitySyncAt = entities.length > 0
    ? Math.max(...entities.map((entity) => new Date(entity.syncedAt).getTime()))
    : null;
  const entityNameByKey = new Map(entities.map((entity) => [`${entity.entityType}:${entity.externalId}`, entity.name]));
  const enabledCount = filtered.filter((entity) => entity.status === "enabled").length;
  const ignoredCount = filtered.filter((entity) => entity.ignored).length;
  const currentSpend = filtered.reduce((total, entity) => total + (entity.metrics.spend ?? 0), 0);
  const currentConversions = sumAdsManagementConversions(filtered);
  // 汇总 CPA：总消耗 ÷ 总转化。不能平均每行的 cost_per_conversion（按对象数加权而不是
  // 按转化数），零转化时给 null 让 formatMetric 显示「—」，不用 0 或 Infinity 顶替。
  const currentCpa = currentConversions > 0 ? currentSpend / currentConversions : null;

  return (
    <section className="page-stack ads-page">
      {/*
        指标带。原先每格都跟一行说明（「状态为已开启」「不参与自动化」
        「当前筛选对象合计」），那些是下面筛选条件的复述，读一次就够，
        却每天占掉一整行高度。只有消耗的时间口径必须留下——账户时区和本地
        时区可能差好几个小时，那是消歧，不是解释。
      */}
      <div className="ads-metric-rail tk-metric-strip is-headline" aria-label="广告管理摘要">
        <article><small>{spendRange === "today" ? "今日消耗" : "区间消耗"}</small><strong>{formatMetric(currentSpend)}</strong></article>
        <article><small>CPA</small><strong>{formatMetric(currentCpa)}</strong></article>
        <article><small>转化</small><strong>{formatMetric(currentConversions)}</strong></article>
        {/*
          人工接管从指标格降级成一个小入口：它是「去哪儿看」而不是「今天跑得怎么样」，
          占一整格会跟消耗/CPA/转化抢注意力。**只在真有接管对象时出现**——常态是 0，
          常年显示一个 0 是纯噪音。跳转能力保留，那是这页唯一能直达接管区的入口。
        */}
        <span className="tk-strip-note">
          {ignoredCount > 0 && (
            <button className="tk-strip-link" type="button" title="查看人工接管广告组" onClick={() => scrollToSection("manual-takeover-section")}>
              人工接管 {ignoredCount}
            </button>
          )}
          {adsManagementSpendRangeLabel(spendRange)}{createdWindow === "recent" ? ` · 建于 ${ADS_MANAGEMENT_RECENT_WINDOW_HOURS}h 内` : ""}
        </span>
      </div>
      <div className="panel filter-panel">
        <div className="form-grid management-filters">
          <Field label="名称或 ID">
            <input placeholder="搜索广告系列、广告组或广告" value={query} onChange={(event) => setQuery(event.target.value)} />
          </Field>
          <Field label="状态">
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="all">全部当前状态</option>
              <option value="enabled">已开启</option>
              <option value="disabled">已关闭</option>
            </select>
          </Field>
          <Field label="创建时间">
            <select value={createdWindow} onChange={(event) => setCreatedWindow(event.target.value as AdsManagementCreatedWindow)}>
              <option value="recent">最近 {ADS_MANAGEMENT_RECENT_WINDOW_HOURS} 小时</option>
              <option value="all">全部（含历史对象）</option>
            </select>
          </Field>
          <Field label="消耗日期">
            <select value={spendRange} onChange={(event) => setSpendRange(event.target.value as AdsManagementSpendRange)} aria-label="消耗日期">
              <option value="today">今天（账户时区）</option>
              <option value="3d">最近 3 天</option>
              <option value="7d">最近 7 天</option>
              <option value="30d">最近 30 天</option>
            </select>
          </Field>
          <Field label="层级">
            <select value={level} onChange={(event) => setLevel(event.target.value as typeof level)}>
              <option value="all">全部层级</option>
              <option value="campaign">广告系列</option>
              <option value="ad-group">广告组</option>
              <option value="ad">广告</option>
            </select>
          </Field>
        </div>
      </div>

      <div className="panel table-panel">
        <div className="panel-heading">
          <div><span className="panel-icon"><ListFilter size={18} /></span><div><h2>广告对象 <em className="heading-count">{filtered.length}</em><em className="heading-count">{enabledCount} 投放中</em></h2></div></div>
          <small className="inline-protection-note">
            {remoteRefreshing
              ? "正在后台刷新平台数据…"
              : `下次平台刷新：${refreshSeconds} 秒`}
            {latestEntitySyncAt ? ` · 最近同步 ${new Date(latestEntitySyncAt).toLocaleTimeString()}` : ""}
          </small>
        </div>
        <div className="tk-tablewrap tk-scroll-y">
          <table className="tk-table">
            <thead><tr><th>对象</th><th>层级</th><th>状态</th><th className="tk-num">消耗</th><th className="tk-num">CPA</th><th className="tk-num">点击量</th><th className="tk-num">加购</th><th className="tk-num">转化</th><th className="tk-num">CPC</th><th>自动化</th><th className="tk-sticky-end">操作</th></tr></thead>
            <tbody>
              {filtered.length === 0 ? <tr><td colSpan={11}>{entities.length === 0 ? "暂无广告数据，请先完成账户接入或等待首次同步。" : "当前筛选条件下没有对象，试试调整状态、层级或搜索条件。"}</td></tr> : pagedEntities.map((entity) => {
                const key = `${entity.entityType}:${entity.externalId}`;
                const statusPending = pendingStatusKeys.has(key);
                const breach = metricBreaches(entity.metrics, ruleValues);
                return (
                  <tr key={key}>
                    <td className="tk-name"><b><span className="tk-tail">{entity.name}</span></b><small>{entity.externalId}</small></td>
                    <td className="tk-muted">{entityTypeLabel(entity.entityType)}</td>
                    <td><span className={entity.status === "enabled" ? "status active" : "status"}>{operationalStatusLabel(entity.status)}</span></td>
                    <td className={metricCellClass(entity.metrics.spend, breach.spend)}>{formatMetric(entity.metrics.spend)}</td>
                    <td className={metricCellClass(entity.metrics.cost_per_conversion, breach.cpa)}>{formatMetric(entity.metrics.cost_per_conversion)}</td>
                    <td className={metricCellClass(entity.metrics.clicks, false)}>{formatMetric(entity.metrics.clicks)}</td>
                    <td className={metricCellClass(entity.metrics.carts, breach.carts)}>{formatMetric(entity.metrics.carts)}</td>
                    <td className={metricCellClass(entity.metrics.conversions, false)}>{formatMetric(entity.metrics.conversions)}</td>
                    <td className={metricCellClass(entity.metrics.cost_per_click, breach.cpc)}>{formatMetric(entity.metrics.cost_per_click)}</td>
                    <td>{renderAdsManagementParticipation(participationByKey.get(`${entity.entityType}:${entity.externalId}`) ?? "participating")}</td>
                    <td className="tk-sticky-end"><div className="row-actions">
                      {canChangeStatus && entity.status !== "unknown" && <button disabled={statusPending || !canOperateAds} title={!canOperateAds ? "需要 ads:operate 权限" : undefined} onClick={() => setStatusConfirming(entity)} type="button">{statusPending ? "处理中…" : entity.status === "disabled" ? "开启" : "关闭"}</button>}
                      {entity.status === "unknown" && <small className="inline-protection-note">状态待确认</small>}
                      {entity.entityType === "ad-group" && <button disabled={busy !== null || !canOperateAds} title={canOperateAds ? undefined : "需要 ads:operate 权限"} onClick={() => void toggleManualTakeover(entity)} type="button"><Ban size={14} /> {entity.ignored ? "恢复自动化" : "人工接管"}</button>}
                      {canChangeStatus && entity.entityType === "ad-group" && <button disabled={busy !== null || !canOperateAds} title={canOperateAds ? undefined : "需要 ads:operate 权限"} onClick={() => { const overnight = nextOvernightScheduleTimes(); setScheduling(entity); setRunAt(nextLocalMidnightInputValue()); setDisableAt(localDateTimeInputValue(overnight.disableAt)); setEnableAt(localDateTimeInputValue(overnight.enableAt)); }} type="button">定时 / 过夜</button>}
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length > ADS_MANAGEMENT_PAGE_SIZE && <div className="table-pagination"><span>第 {currentPage + 1} / {pageCount} 页，共 {filtered.length} 条</span><div><button className="secondary-button compact-button" disabled={currentPage === 0} onClick={() => setPage((value) => value - 1)} type="button">上一页</button><button className="secondary-button compact-button" disabled={currentPage >= pageCount - 1} onClick={() => setPage((value) => value + 1)} type="button">下一页</button></div></div>}
      </div>

      <div className="panel table-panel" id="manual-takeover-section">
        <div className="panel-heading">
          <div><span className="panel-icon"><UserRound size={18} /></span><div><h2>人工接管广告组 <em className="heading-count">{manualTakeovers.length}</em></h2></div></div>
        </div>
        <div className="tk-tablewrap tk-scroll-sm"><table className="tk-table"><thead><tr><th>广告组</th><th>接管原因</th><th>接管时间</th><th className="tk-sticky-end">操作</th></tr></thead><tbody>
          {manualTakeovers.length === 0 ? <tr><td className="tk-empty-cell" colSpan={4}>暂无人工接管的广告组。</td></tr> : manualTakeovers.map((takeover) => <tr key={`${takeover.entityType}:${takeover.externalId}`}><td className="tk-name"><b><span className="tk-tail">{entityNameByKey.get(`${takeover.entityType}:${takeover.externalId}`) ?? takeover.externalId}</span></b><small>{takeover.externalId}</small></td><td>{takeover.reason}</td><td className="tk-muted">{new Date(takeover.createdAt).toLocaleString()}</td><td className="tk-sticky-end"><button disabled={busy !== null || !canOperateAds} title={canOperateAds ? undefined : "需要 ads:operate 权限"} onClick={() => void restoreManualTakeover(takeover)} type="button">恢复自动化</button></td></tr>)}
        </tbody></table></div>
      </div>

      <div className="panel table-panel" id="schedule-section">
        <div className="panel-heading"><div><span className="panel-icon"><CircleGauge size={18} /></span><div><h2>广告组定时任务 <em className="heading-count">{activeScheduleCount}</em></h2></div></div></div>
        <div className="tk-tablewrap tk-scroll-sm"><table className="tk-table"><thead><tr><th>广告组</th><th>类型</th><th>动作</th><th>下次执行</th><th>最近结果</th><th className="tk-sticky-end">操作</th></tr></thead><tbody>{schedules.length === 0 ? <tr><td className="tk-empty-cell" colSpan={6}>暂无定时任务。</td></tr> : schedules.map((schedule) => <tr key={schedule.id}><td className="tk-name"><b><span className="tk-tail">{schedule.entityName}</span></b><small>{schedule.externalId}</small></td><td className="tk-muted">{schedule.scheduleType === "overnight" ? "每日过夜" : "单次定时"}</td><td>{schedule.action === "enable" ? "开启" : "关闭"}</td><td className="tk-muted">{new Date(schedule.nextRunAt).toLocaleString()}</td><td className="tk-muted">{schedule.lastMessage ?? scheduleStatusLabel(schedule.status)}</td><td className="tk-sticky-end">{schedule.status === "scheduled" ? <button className="danger-button compact-button" disabled={!canOperateAds} onClick={() => void cancelSchedule(schedule)} title={canOperateAds ? undefined : "需要 ads:operate 权限"} type="button">取消</button> : "—"}</td></tr>)}</tbody></table></div>
      </div>

      <details className="panel table-panel collapsible-panel">
        <summary className="panel-heading"><div><span className="panel-icon"><Activity size={18} /></span><div><h2>广告操作记录 <em className="heading-count">{operations.length}</em></h2></div></div></summary>
        <div className="table-wrap"><table>
          <thead><tr><th>对象</th><th>动作</th><th>来源</th><th>结果</th><th>信息</th><th>时间</th></tr></thead>
          <tbody>{operations.length === 0 ? <tr><td colSpan={6}>暂无操作记录。</td></tr> : operations.slice(0, 50).map((operation) => <tr key={operation.id}>
            <td>{operation.entityName}<br /><small>{operation.externalId}</small></td>
            <td>{operationActionLabel(operation.action)}</td>
            <td>{operation.source === "automation" ? "自动化" : operation.source === "scheduled" ? "定时" : "手动"}</td>
            <td><span className={operation.status === "succeeded" ? "status active" : operation.status === "failed" || operation.status === "cancelled" ? "status danger" : "status warning"}>{operation.status === "succeeded" ? "成功" : operation.status === "pending" ? "等待" : operation.status === "running" ? "执行中" : operation.status === "unknown" ? "待确认" : operation.status === "cancelled" ? "已取消" : "失败"}</span></td>
            <td>{operation.message ?? "—"}</td>
            <td>{new Date(operation.createdAt).toLocaleString()}</td>
          </tr>)}</tbody>
        </table></div>
      </details>

      {statusConfirming && (
        <div className="modal-backdrop" onMouseDown={() => setStatusConfirming(null)}>
          <div className="modal confirmation-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading"><div><span className="eyebrow">确认状态变更</span><h2>{statusConfirming.status === "disabled" ? "开启" : "关闭"}广告组</h2></div><button type="button" onClick={() => setStatusConfirming(null)}><X size={20} /></button></div>
            <p>将对“{statusConfirming.name}”发送{statusConfirming.status === "disabled" ? "开启" : "关闭"}请求，并在平台回读确认后更新状态。</p>
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setStatusConfirming(null)}>取消</button><button className="primary-button" disabled={busy !== null || !canOperateAds} type="button" onClick={() => { const entity = statusConfirming; setStatusConfirming(null); void changeStatus(entity); }}>确认{statusConfirming.status === "disabled" ? "开启" : "关闭"}</button></div>
          </div>
        </div>
      )}

      {scheduling && (
        <div className="modal-backdrop" onMouseDown={() => setScheduling(null)}>
          <form className="modal schedule-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void saveSchedule(event)}>
            <div className="modal-heading"><div><span className="eyebrow">广告组定时</span><h2>{scheduling.name}</h2></div><button type="button" onClick={() => setScheduling(null)}><X size={20} /></button></div>
            <div className="schedule-kind-tabs"><button className={scheduleKind === "once" ? "active" : ""} onClick={() => setScheduleKind("once")} type="button">单次定时</button><button className={scheduleKind === "overnight" ? "active" : ""} onClick={() => setScheduleKind("overnight")} type="button">每日过夜</button></div>
            {scheduleKind === "once" ? <div className="form-grid"><Field label="执行动作"><select value={scheduledAction} onChange={(event) => setScheduledAction(event.target.value as typeof scheduledAction)}><option value="enable">开启</option><option value="disable">关闭</option></select></Field><Field label="执行时间"><div className="schedule-time-input"><input required type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} /><button type="button" className="secondary-button compact-button" onClick={() => setRunAt(nextLocalMidnightInputValue())}>当日 24:00</button></div></Field></div> : <div className="form-grid"><Field label="每日关闭时间（首次）"><input required type="datetime-local" value={disableAt} onChange={(event) => setDisableAt(event.target.value)} /></Field><Field label="每日开启时间（首次）"><input required type="datetime-local" value={enableAt} onChange={(event) => setEnableAt(event.target.value)} /></Field></div>}
            <p className="provider-endpoint-note">时间使用本机时区。未到时间前不会写入 TikTok；执行时仍要求账户连接正常且两个自动化总开关均开启。</p>
          <div className="modal-actions"><button className="secondary-button" onClick={() => setScheduling(null)} type="button">取消</button><button className="primary-button" disabled={busy !== null || !canOperateAds} type="submit">保存任务</button></div>
          </form>
        </div>
      )}
    </section>
  );
}

function AllAccountsAdsView({
  accounts,
  accountCapabilities,
  onError,
}: {
  accounts: AccountConfig[];
  accountCapabilities: Record<string, AccountProviderCapabilities | undefined>;
  onError: (message: string | null) => void;
}) {
  const auth = useAuth();
  const { prompt } = useOverlays();
  const canOperateAds = auth.status.permissions.includes("ads:operate");
  const [entitiesByAccount, setEntitiesByAccount] = useState<Array<{
    account: AccountConfig;
    entity: ManagedEntityRecord;
  }>>([]);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<"all" | ManagedEntityRecord["status"]>(ADS_MANAGEMENT_DEFAULT_STATUS);
  const [createdWindow, setCreatedWindow] = useState<AdsManagementCreatedWindow>(ADS_MANAGEMENT_DEFAULT_CREATED_WINDOW);
  const [spendRange, setSpendRange] = useState<AdsManagementSpendRange>(ADS_MANAGEMENT_DEFAULT_SPEND_RANGE);
  const [rangeMetricsByAccount, setRangeMetricsByAccount] = useState<Record<string, EntityRangeMetricRecord[]> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [statusConfirming, setStatusConfirming] = useState<{ account: AccountConfig; entity: ManagedEntityRecord } | null>(null);
  const [scheduling, setScheduling] = useState<{ account: AccountConfig; entity: ManagedEntityRecord } | null>(null);
  const [scheduleKind, setScheduleKind] = useState<"once" | "overnight">("once");
  const [scheduledAction, setScheduledAction] = useState<"enable" | "disable">("disable");
  const [runAt, setRunAt] = useState("");
  const [disableAt, setDisableAt] = useState("");
  const [enableAt, setEnableAt] = useState("");

  const load = useCallback(async () => {
    try {
      const results = await Promise.all(accounts.map(async (account) => ({
        account,
        entities: await api.getManagedEntities(account.id),
      })));
      setEntitiesByAccount(results.flatMap(({ account, entities }) => entities.map((entity) => ({ account, entity }))));
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    }
  }, [accounts, onError]);

  // 区间指标按账户分别取，再各自套回该账户的对象上——不同账户的时区可能不同，
  // 自然日必须由各自的服务端换算，不能在前端统一切。
  useEffect(() => {
    if (spendRange === "today") {
      setRangeMetricsByAccount(null);
      return;
    }
    let cancelled = false;
    const range = spendRangeToRange(spendRange);
    void Promise.all(accounts.map(async (account) => [
      account.id,
      await api.getEntityRangeMetrics(account.id, range).catch(() => [] as EntityRangeMetricRecord[]),
    ] as const))
      .then((pairs) => { if (!cancelled) setRangeMetricsByAccount(Object.fromEntries(pairs)); })
      .catch((cause) => { if (!cancelled) onError(getErrorMessage(cause)); });
    return () => { cancelled = true; };
  }, [accounts, onError, spendRange]);

  const saveSchedule = async (event: FormEvent) => {
    event.preventDefault();
    if (!scheduling || !canOperateAds) return;
    try {
      setBusy(`${scheduling.entity.externalId}:schedule`);
      if (scheduleKind === "once") {
        await api.createOneTimeSchedule(scheduling.account.id, { externalId: scheduling.entity.externalId, action: scheduledAction, runAt: new Date(runAt).toISOString() });
      } else {
        await api.createOvernightSchedule(scheduling.account.id, { externalId: scheduling.entity.externalId, disableAt: new Date(disableAt).toISOString(), enableAt: new Date(enableAt).toISOString() });
      }
      setScheduling(null);
      await load();
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const visible = useMemo(() => {
    // 原本这里按 syncedAt 卡 48 小时，但 syncedAt 是"最近一次同步时间"，每轮轮询都会
    // 刷成当前时间，条件恒为真——等于没过滤，三周前的老广告组照样铺满列表。真正该看的
    // 是创建时间，且判据要和规则引擎同一套，所以改走 ads-management-view 的共用实现。
    const now = new Date();
    return entitiesByAccount
      .map((item, index) => ({ item, index }))
      .filter(({ item: { entity } }) => (
        entity.entityType === "ad-group"
        && (statusFilter === "all" || entity.status === statusFilter)
        && (createdWindow === "all" || adsManagementParticipation(entity, { now }) !== "outside-window")
      ))
      .sort((left, right) => (
        adsManagementRank(left.item.entity) - adsManagementRank(right.item.entity)
        || compareAdsManagementSpend(left.item.entity, right.item.entity)
        || left.index - right.index
      ))
      .map(({ item }) => item);
  }, [createdWindow, entitiesByAccount, statusFilter]);
  // 参与判定固定按当天指标，与下方展示用的区间口径分开。
  const participationByKey = useMemo(() => new Map(
    visible.map(({ entity }) => [
      `${entity.entityType}:${entity.externalId}`,
      adsManagementParticipation(entity),
    ]),
  ), [visible]);
  const rows = useMemo(() => {
    if (spendRange === "today" || !rangeMetricsByAccount) return visible;
    return visible
      .map(({ account, entity }) => ({
        account,
        entity: applyEntityRangeMetrics([entity], rangeMetricsByAccount[account.id] ?? [])[0] ?? entity,
      }))
      .sort((left, right) => (
        adsManagementRank(left.entity) - adsManagementRank(right.entity)
        || compareAdsManagementSpend(left.entity, right.entity)
      ));
  }, [rangeMetricsByAccount, spendRange, visible]);
  const {
    items: paged,
    pageCount,
    currentPage,
  } = paginateAdsManagementItems(rows, page);

  useEffect(() => setPage(0), [createdWindow, spendRange, statusFilter]);
  useEffect(() => setPage((current) => Math.min(current, pageCount - 1)), [pageCount]);

  const enabledCount = visible.filter(({ entity }) => entity.status === "enabled").length;
  const currentSpend = rows.reduce((total, { entity }) => total + (entity.metrics.spend ?? 0), 0);
  const currentConversions = sumAdsManagementConversions(rows.map(({ entity }) => entity));
  // 汇总 CPA 只能用「总消耗 ÷ 总转化」，不能把每行的 cost_per_conversion 平均——那是
  // 按对象数而不是按转化数加权，几条零转化的组就能把结果拉得没法看。零转化时给 null，
  // formatMetric 会显示「—」：0 会被读成「白嫖到量」，Infinity 更没法看。
  const currentCpa = currentConversions > 0 ? currentSpend / currentConversions : null;

  const changeStatus = async (account: AccountConfig, entity: ManagedEntityRecord) => {
    if (!hasProviderCapability(accountCapabilities[account.id], "change-status")) return;
    try {
      setBusy(`${account.id}:${entity.externalId}:status`);
      await api.changeEntityStatus(account.id, {
        entityType: entity.entityType,
        externalId: entity.externalId,
        action: entity.status === "disabled" ? "enable" : "disable",
      });
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggleManualTakeover = async (account: AccountConfig, entity: ManagedEntityRecord) => {
    try {
      setBusy(`${account.id}:${entity.externalId}:takeover`);
      if (entity.ignored) await api.unignoreEntity(account.id, entity.entityType, entity.externalId);
      else {
        const reason = (await prompt({ title: "人工接管", message: "请输入接管原因；该广告组将不再参与自动化。", defaultValue: "人工接管，不参与自动化", required: true, confirmLabel: "确认接管" }))?.trim();
        if (!reason) return;
        await api.ignoreEntity(account.id, entity.entityType, entity.externalId, reason);
      }
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="page-stack all-accounts-ads-page">
      {/*
        摘要条只留三个真正要天天盯的数：消耗、CPA、转化。

        「当前对象 / 投放中」是这张表的规模，不是投放结果——它们跟着表头走（下面的
        heading-count），而不是占掉摘要条的两格。「人工接管」同理下沉到表格里：那一列
        每行都有，摘要再报一次总数只是重复。留下的三个数字用大号等宽字体，扫一眼就能读。
      */}
      <div className="ads-metric-rail tk-metric-strip is-headline" aria-label="全部账户广告组摘要">
        <article><small>{spendRange === "today" ? "今日消耗" : "区间消耗"}</small><strong>{formatMetric(currentSpend)}</strong></article>
        <article><small>CPA</small><strong>{formatMetric(currentCpa)}</strong></article>
        <article><small>转化</small><strong>{formatMetric(currentConversions)}</strong></article>
        <span className="tk-strip-note">所有账户 · {adsManagementSpendRangeLabel(spendRange)}</span>
      </div>
      <div className="panel table-panel">
        <div className="panel-heading">
          <div><span className="panel-icon"><ListFilter size={18} /></span><div><h2>全部账户广告组 <em className="heading-count">{rows.length}</em><em className="heading-count">{enabledCount} 投放中</em></h2></div></div>
          <div className="row-actions">
            <select aria-label="广告组状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="enabled">已开启</option>
              <option value="disabled">已关闭</option>
              <option value="all">全部当前状态</option>
            </select>
            <select aria-label="广告组创建时间" value={createdWindow} onChange={(event) => setCreatedWindow(event.target.value as AdsManagementCreatedWindow)}>
              <option value="recent">创建：最近 {ADS_MANAGEMENT_RECENT_WINDOW_HOURS} 小时</option>
              <option value="all">创建：全部（含历史对象）</option>
            </select>
            <select aria-label="消耗日期" value={spendRange} onChange={(event) => setSpendRange(event.target.value as AdsManagementSpendRange)}>
              <option value="today">消耗：今天</option>
              <option value="3d">消耗：最近 3 天</option>
              <option value="7d">消耗：最近 7 天</option>
              <option value="30d">消耗：最近 30 天</option>
            </select>
            <small className="inline-protection-note">每 30 秒更新展示</small>
          </div>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>账户</th><th>对象</th><th>状态</th><th>消耗</th><th>CPA</th><th>点击量</th><th>加购</th><th>转化</th><th>CPC</th><th>自动化</th><th>操作</th></tr></thead>
          <tbody>{rows.length === 0 ? <tr><td colSpan={11}>最新健康同步中暂无符合当前筛选的广告组；若在找历史对象，把「创建时间」切到「全部」。</td></tr> : paged.map(({ account, entity }) => <tr key={`${account.id}:${entity.externalId}`}>
            <td>{account.displayName}</td><td><strong>{entity.name}</strong><br /><small>{entity.externalId}</small></td>
            <td><span className={entity.status === "enabled" ? "status active" : "status"}>{operationalStatusLabel(entity.status)}</span></td>
            <td>{formatMetric(entity.metrics.spend)}</td><td>{formatMetric(entity.metrics.cost_per_conversion)}</td><td>{formatMetric(entity.metrics.clicks)}</td><td>{formatMetric(entity.metrics.carts)}</td><td>{formatMetric(entity.metrics.conversions)}</td><td>{formatMetric(entity.metrics.cost_per_click)}</td>
            <td>{renderAdsManagementParticipation(participationByKey.get(`${entity.entityType}:${entity.externalId}`) ?? "participating")}</td>
            <td><div className="row-actions">{entity.status !== "unknown" && <button disabled={busy !== null || !canOperateAds || !hasProviderCapability(accountCapabilities[account.id], "change-status")} title={!hasProviderCapability(accountCapabilities[account.id], "change-status") ? "当前接入不支持启停写入" : undefined} onClick={() => setStatusConfirming({ account, entity })} type="button">{entity.status === "disabled" ? "开启" : "关闭"}</button>}<button disabled={busy !== null || !canOperateAds} onClick={() => void toggleManualTakeover(account, entity)} type="button">{entity.ignored ? "恢复自动化" : "人工接管"}</button>{hasProviderCapability(accountCapabilities[account.id], "change-status") && <button disabled={busy !== null || !canOperateAds} onClick={() => { const overnight = nextOvernightScheduleTimes(); setScheduling({ account, entity }); setScheduleKind("once"); setScheduledAction("disable"); setRunAt(nextLocalMidnightInputValue()); setDisableAt(localDateTimeInputValue(overnight.disableAt)); setEnableAt(localDateTimeInputValue(overnight.enableAt)); }} type="button">定时 / 过夜</button>}</div></td>
          </tr>)}</tbody>
        </table></div>
        {rows.length > ADS_MANAGEMENT_PAGE_SIZE && <div className="table-pagination"><span>第 {currentPage + 1} / {pageCount} 页，共 {rows.length} 条</span><div><button className="secondary-button compact-button" disabled={currentPage === 0} onClick={() => setPage((value) => value - 1)} type="button">上一页</button><button className="secondary-button compact-button" disabled={currentPage >= pageCount - 1} onClick={() => setPage((value) => value + 1)} type="button">下一页</button></div></div>}
      </div>
      {statusConfirming && <div className="modal-backdrop" onMouseDown={() => setStatusConfirming(null)}><div className="modal confirmation-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">确认状态变更</span><h2>{statusConfirming.entity.status === "disabled" ? "开启" : "关闭"}广告组</h2></div><button type="button" onClick={() => setStatusConfirming(null)}><X size={20} /></button></div><p>将对“{statusConfirming.account.displayName} / {statusConfirming.entity.name}”发送启停请求。</p><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setStatusConfirming(null)}>取消</button><button className="primary-button" disabled={busy !== null || !canOperateAds || !hasProviderCapability(accountCapabilities[statusConfirming.account.id], "change-status")} type="button" onClick={() => { const target = statusConfirming; setStatusConfirming(null); void changeStatus(target.account, target.entity); }}>确认</button></div></div></div>}
      {scheduling && (
        <div className="modal-backdrop" onMouseDown={() => setScheduling(null)}>
          <form className="modal schedule-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void saveSchedule(event)}>
            <div className="modal-heading"><div><span className="eyebrow">广告组定时 · {scheduling.account.displayName}</span><h2>{scheduling.entity.name}</h2></div><button type="button" onClick={() => setScheduling(null)}><X size={20} /></button></div>
            <div className="schedule-kind-tabs"><button className={scheduleKind === "once" ? "active" : ""} onClick={() => setScheduleKind("once")} type="button">单次定时</button><button className={scheduleKind === "overnight" ? "active" : ""} onClick={() => setScheduleKind("overnight")} type="button">每日过夜</button></div>
            {scheduleKind === "once" ? <div className="form-grid"><Field label="执行动作"><select value={scheduledAction} onChange={(event) => setScheduledAction(event.target.value as typeof scheduledAction)}><option value="enable">开启</option><option value="disable">关闭</option></select></Field><Field label="执行时间"><div className="schedule-time-input"><input required type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} /><button type="button" className="secondary-button compact-button" onClick={() => setRunAt(nextLocalMidnightInputValue())}>当日 24:00</button></div></Field></div> : <div className="form-grid"><Field label="每日关闭时间（首次）"><input required type="datetime-local" value={disableAt} onChange={(event) => setDisableAt(event.target.value)} /></Field><Field label="每日开启时间（首次）"><input required type="datetime-local" value={enableAt} onChange={(event) => setEnableAt(event.target.value)} /></Field></div>}
            <div className="modal-actions"><button className="secondary-button" onClick={() => setScheduling(null)} type="button">取消</button><button className="primary-button" disabled={busy !== null || !canOperateAds} type="submit">保存任务</button></div>
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
  const { confirm, toast } = useOverlays();
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
  const [days, setDays] = useState<DailyMetricRecord[] | null>(null);
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
    setDays(null);
    const entityType = level === "all" ? undefined : level;
    void Promise.all([
      api.getMetricDays(account.id, range, entityType),
      api.getAnalytics(account.id, range, entityType),
    ])
      .then(([dailyResult, batchResult]) => {
        setDays(dailyResult);
        setBatches(batchResult);
        onError(null);
      })
      .catch((cause) => onError(getErrorMessage(cause)));
  }, [account.id, level, onError, range?.from, range?.to]);

  const summary = useMemo(() => summarizeDailyMetrics(days ?? []), [days]);
  if (!days || !batches) return <EmptyState text="正在分析指标快照…" loading />;

  return (
    <section className="page-stack analytics-page">
      <div className="panel filter-panel">
        <div className="analytics-context-bar">
          <div>
            <span className={connection?.status === "ready" ? "status active" : "status warning"}>{connection?.status === "ready" ? "连接正常" : "连接待检查"}</span>
            <small>健康同步 {latestSync?.quality.lastHealthyAt ? new Date(latestSync.quality.lastHealthyAt).toLocaleString() : "暂无"} · 数据质量 {latestSync ? syncQualityPresentation(latestSync.quality.status).label : "暂无"}</small>
          </div>
        </div>
        <div className="form-grid management-filters">
          <Field label="时间范围"><select value={preset} onChange={(event) => setPreset(event.target.value as AnalysisPreset)}><option value="today">今天</option><option value="yesterday">昨天</option><option value="3d">三天</option><option value="7d">七天</option><option value="30d">三十天</option><option value="custom">自定义</option></select></Field>
          <Field label="分析层级"><select value={level} onChange={(event) => setLevel(event.target.value as typeof level)}><option value="all">全部层级</option><option value="campaign">广告系列</option><option value="ad-group">广告组</option>{account.providerKind === "official-api" && <option value="ad">广告</option>}</select></Field>
          {preset === "custom" && <><Field label="开始日期"><input type="date" max={customTo || today} value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></Field><Field label="结束日期"><input type="date" min={customFrom} max={today} value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></Field></>}
        </div>
        {!range && <p className="error-text">请选择有效日期，且范围不超过 90 天。</p>}
        <p className="retention-note">本地快照保留 90 天；Cookie 接入不含广告层级分析。</p>
      </div>
      <div className="summary-grid">
        <SummaryCard icon={<Gauge size={20} />} label="区间消耗" value={formatMetric(summary.spend)} tone="blue" />
        <SummaryCard icon={<Activity size={20} />} label="区间点击" value={formatMetric(summary.clicks)} tone="violet" />
        <SummaryCard icon={<Check size={20} />} label="区间转化" value={formatMetric(summary.conversions)} tone="green" />
        <SummaryCard icon={<CircleGauge size={20} />} label="平均 CPC" value={formatMetric(summary.cpc)} tone="blue" />
        <SummaryCard icon={<CircleGauge size={20} />} label="平均转化成本" value={formatMetric(summary.cpa)} tone="violet" />
      </div>
      <div className="panel batch-chart-panel">
        <div className="panel-heading"><div><span className="panel-icon"><BarChart3 size={18} /></span><div><h2>按日趋势</h2></div></div><div className="chart-selectors"><label>柱状 <select value={barMetric} onChange={(event) => setBarMetric(event.target.value as BatchBarMetric)}><option value="spend">消耗</option><option value="clicks">点击</option><option value="conversions">转化</option></select></label><label>折线 <select value={lineMetric} onChange={(event) => setLineMetric(event.target.value as BatchLineMetric)}><option value="cpc">平均 CPC</option><option value="cpa">平均转化成本</option></select></label></div></div>
        <DailyTrendChart days={days} barMetric={barMetric} lineMetric={lineMetric} />
      </div>
      <details className="panel table-panel collapsible-panel">
        <summary className="panel-heading"><div><span className="panel-icon"><BarChart3 size={18} /></span><div><h2>同步批次日志 <em className="heading-count">{batches.length}</em></h2></div></div></summary>
        <div className="table-wrap"><table>
          <thead><tr><th>检测时间</th><th>对象数</th><th>消耗</th><th>点击</th><th>转化</th><th>平均 CPC</th><th>平均转化成本</th></tr></thead>
          <tbody>{batches.length === 0 ? <tr><td colSpan={7}>暂无历史快照，请先执行检测。</td></tr> : batches.map((batch) => <tr key={batch.capturedAt}><td>{new Date(batch.capturedAt).toLocaleString()}</td><td>{batch.count}</td><td>{formatMetric(batch.spend)}</td><td>{formatMetric(batch.clicks)}</td><td>{formatMetric(batch.conversions)}</td><td>{formatMetric(batch.clicks > 0 ? batch.spend / batch.clicks : null)}</td><td>{formatMetric(batch.conversions > 0 ? batch.spend / batch.conversions : null)}</td></tr>)}</tbody>
        </table></div>
      </details>
    </section>
  );
}

type BatchBarMetric = "spend" | "clicks" | "conversions";
type BatchLineMetric = "cpc" | "cpa";
type AnalyticsBatch = MetricBatchRecord;

function DailyTrendChart({ days, barMetric, lineMetric }: { days: DailyMetricRecord[]; barMetric: BatchBarMetric; lineMetric: BatchLineMetric }) {
  // 横轴是自然日。旧实现画的是同步批次，而每个批次只属于一个账户、装的又是当日累计，
  // 于是大账户的累计值和小账户的累计值交替成柱——看着像消耗剧烈波动，其实是账户体量差异。
  const points = days.slice(0, 30).reverse().map((day) => ({
    ...day,
    barValue: day[barMetric],
    lineValue: lineMetric === "cpc"
      ? (day.clicks > 0 ? day.spend / day.clicks : null)
      : (day.conversions > 0 ? day.spend / day.conversions : null),
    incomplete: isDailyMetricIncomplete(day),
  }));
  if (points.length === 0) return <div className="chart-empty">该区间内没有健康同步的快照。</div>;
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
  const describe = (point: (typeof points)[number]) =>
    `${point.date}${describeDailyCoverage(point) ? `（${describeDailyCoverage(point)}）` : ""}`;

  return <div className="batch-chart-wrap">
    <div className="chart-legend"><span className="bar-key">{barLabel}（柱）</span><span className="line-key">{lineLabel}（线）</span><small>按账户时区的自然日，最多显示最近 30 天</small></div>
    <svg aria-label={`${barLabel}柱状图与${lineLabel}折线图`} className="batch-combo-chart" role="img" viewBox={`0 0 ${width} ${height}`}>
      {[0, .25, .5, .75, 1].map((ratio) => {
        const y = top + plotHeight * (1 - ratio);
        return <g key={ratio}><line className="chart-grid-line" x1={left} x2={width - right} y1={y} y2={y} /><text className="chart-axis-label" textAnchor="end" x={left - 8} y={y + 4}>{formatMetric(barMaximum * ratio)}</text><text className="chart-axis-label" textAnchor="start" x={width - right + 8} y={y + 4}>{formatMetric(lineMaximum * ratio)}</text></g>;
      })}
      {points.map((point, index) => {
        const x = left + step * index + step / 2;
        const barHeight = (point.barValue / barMaximum) * plotHeight;
        const labelEvery = Math.max(1, Math.ceil(points.length / 8));
        return <g key={point.date}><rect className={point.incomplete ? "chart-bar chart-bar-partial" : "chart-bar"} height={barHeight} rx="3" width={barWidth} x={x - barWidth / 2} y={top + plotHeight - barHeight}><title>{describe(point)} · {barLabel} {formatMetric(point.barValue)} · {lineLabel} {formatMetric(point.lineValue)}</title></rect>{index % labelEvery === 0 && <text className="chart-x-label" textAnchor="middle" x={x} y={height - 24}>{formatChartDay(point.date)}</text>}</g>;
      })}
      {lineSegments.map((segment, index) => <polyline className="chart-line" fill="none" key={index} points={segment} />)}
      {points.map((point, index) => {
        if (point.lineValue === null) return null;
        const x = left + step * index + step / 2;
        const y = top + plotHeight - (point.lineValue / lineMaximum) * plotHeight;
        return <circle className="chart-line-dot" cx={x} cy={y} key={point.date} r="3.5"><title>{describe(point)} · {lineLabel} {formatMetric(point.lineValue)}</title></circle>;
      })}
    </svg>
  </div>;
}

function formatChartDay(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function formatChartTime(value: string): string {
  const date = new Date(value);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function AutomationPage({
  account,
  connection,
  capabilities,
  maxActionsPerRun,
  overview,
  accounts,
  connectionStates,
  onError,
}: {
  account: AccountConfig;
  connection: ProviderConnection | null;
  capabilities: AccountProviderCapabilities | undefined;
  maxActionsPerRun: number;
  overview: AccountAutomationOverview;
  accounts: AccountConfig[];
  connectionStates: Array<{ accountId: string; connection: ProviderConnection | null }>;
  onError: (message: string | null) => void;
}) {
  const accessSummary = useMemo(() => {
    const connectionByAccount = new Map(connectionStates.map((state) => [state.accountId, state.connection]));
    let normal = 0;
    let automation = 0;
    const problems: Array<{ id: string; name: string; reason: string }> = [];
    for (const item of accounts) {
      const conn = connectionByAccount.get(item.id) ?? null;
      if (conn?.status === "ready") normal += 1;
      else problems.push({ id: item.id, name: item.displayName, reason: connectionStatusSummary(item, conn) });
      if (item.enabled) automation += 1;
    }
    return { total: accounts.length, normal, automation, abnormal: problems.length, problems };
  }, [accounts, connectionStates]);
  const { confirm, toast } = useOverlays();
  const [runs, setRuns] = useState<AutomationRunRecord[] | null>(null);
  const [decisions, setDecisions] = useState<
    AutomationDecisionRecord[] | null
  >(null);
  const [circuitState, setCircuitState] = useState<ProviderWriteCircuitState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [runFeedback, setRunFeedback] = useState<string | null>(null);
  const connectionMessage = automationConnectionMessage(account, connection);
  const canRunAutomation = connection?.status === "ready"
    && hasProviderCapability(capabilities, "read-campaigns");
  const canChangeStatus = hasProviderCapability(capabilities, "change-status");

  const load = useCallback(async () => {
    try {
      const [nextRuns, nextDecisions, nextCircuitState] = await Promise.all([
        api.getAutomationRuns(account.id),
        api.getAutomationDecisions(account.id),
        api.getWriteCircuit(account.id),
      ]);
      setRuns(nextRuns);
      setDecisions(nextDecisions);
      setCircuitState(nextCircuitState);
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    }
  }, [account.id, onError]);

  useEffect(() => {
    setRuns(null);
    setDecisions(null);
    setCircuitState(null);
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
            ? `检测完成：生成 ${result.candidateCount} 项规则建议，未修改广告。`
            : `自动执行完成：命中 ${result.candidateCount} 项，成功执行 ${result.successCount} 项，失败 ${result.failureCount} 项。`,
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

  const resetCircuit = async () => {
    try {
      setBusy("reset-circuit");
      setCircuitState(await api.resetWriteCircuit(account.id));
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  if (!runs || !decisions || !circuitState) {
    return <EmptyState text="正在读取自动化记录…" loading />;
  }

  const latest = runs[0];
  const actionableDecisions = selectActionableDecisionHistory(decisions);
  const automationHealthy = canRunAutomation && !circuitState.circuit?.openedAt;
  return (
    <section className="page-stack automation-page">
      <header className="automation-status-band">
        <div className="automation-status-copy">
          <span className={`automation-health-icon ${automationHealthy ? "active" : "warning"}`}>
            {automationHealthy ? <Check size={28} /> : <AlertTriangle size={24} />}
          </span>
          <div>
            <span className="eyebrow">当前运行状态</span>
            <h2>{automationHealthy ? "自动化已就绪" : "自动化等待处理"}</h2>
            <p>{automationHealthy ? `${account.displayName} 已具备只读检测能力。` : connectionMessage}</p>
          </div>
        </div>
        <dl className="automation-status-metrics">
          <div><dt>账户自动化</dt><dd>{account.enabled ? "已开启" : "已关闭"}</dd></div>
          <div><dt>最近候选</dt><dd>{latest?.candidateCount ?? 0} 项</dd></div>
          <div><dt>本轮自动启停</dt><dd>{latest?.successCount ?? 0} 项</dd></div>
          <div><dt>单轮操作上限</dt><dd>{maxActionsPerRun} 项</dd></div>
        </dl>
      </header>

      <section className="automation-safety-panel" aria-labelledby="automation-safety-title">
        <div>
          <span className="eyebrow">安全执行建议</span>
          <h2 id="automation-safety-title">自动启停，异常即止</h2>
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
            title={!canRunAutomation ? connectionMessage : account.enabled ? "按规则立即执行自动启停" : "请先在用户管理中开启账户自动化"}
          >
            <Play size={17} />
            {busy === "run" ? "执行中…" : "立即执行"}
          </button>
        </div>
      </section>
      {runFeedback && <div className={`automation-run-feedback ${latest?.status === "failed" ? "error" : "success"}`}>{runFeedback}</div>}

      <div className="automation-primary-grid">
        <section className="automation-flow-panel">
          <div className="automation-section-heading">
            <div><span className="panel-icon"><ShieldCheck size={18} /></span><div><h2>自动启停执行流程</h2></div></div>
          </div>
          <ol className="automation-flow" aria-label="自动化执行流程">
            <li className={runs.length > 0 ? "complete" : "current"}><span><Check size={14} /></span><small>检测</small></li>
            <li className={latest ? "complete" : "pending"}><span><Check size={14} /></span><small>评估</small></li>
            <li className={latest?.candidateCount ? "complete" : "pending"}><span><Check size={14} /></span><small>命中规则</small></li>
            <li className={latest?.actionCount ? "complete" : "pending"}><span><Play size={12} /></span><small>直接执行</small></li>
            <li className={latest?.successCount ? "complete" : "pending"}><span><Check size={14} /></span><small>回读确认</small></li>
          </ol>
          <p className="automation-flow-note">
            {circuitState.circuit?.openedAt
              ? `熔断已触发：${circuitState.circuit.lastError ?? "未知错误"}`
              : latest?.failureCount
                ? `最近一轮有 ${latest.failureCount} 项未完成，请在广告管理中人工处理。`
                : "全局自动化和账户自动化均开启、且 Provider 写入保护未触发时，按规则直接执行。"}
          </p>
        </section>

        <section className="automation-readiness-panel account-readiness-panel">
          <div className="automation-section-heading"><div><span className="panel-icon"><PlugZap size={18} /></span><div><h2>账户接入状态</h2></div></div></div>
          <div className="automation-account-status-grid">
            <span>正常接入 <strong className="status active">{accessSummary.normal}</strong></span>
            <span>自动化 <strong className="status active">{accessSummary.automation}</strong></span>
            <span>异常 <strong className={accessSummary.abnormal > 0 ? "status danger" : "status active"}>{accessSummary.abnormal}</strong></span>
          </div>
          {accessSummary.problems.length === 0
            ? <p className="retention-note">全部 {accessSummary.total} 个账户均已通过连接检测。</p>
            : <ul className="automation-problem-list">{accessSummary.problems.map((problem) => <li key={problem.id}><strong>{problem.name}</strong><span>{problem.reason}</span></li>)}</ul>}
        </section>
      </div>

      <section className="automation-policy-panel write-circuit-panel">
        <div className="automation-section-heading"><div><span className="panel-icon"><ShieldCheck size={18} /></span><div><h2>写入熔断状态</h2><p>连续写入失败会自动熔断以阻止继续启停；数据库原子防重，多实例不会重复领取同一建议。</p></div></div></div>
        <div className="sync-count-grid">
          <span>今日自动启停 <strong>{circuitState.todayUsage} 次（不限量）</strong></span>
          <span>熔断 <strong>{circuitState.circuit?.openedAt ? "已触发" : "正常"}</strong></span>
        </div>
        {circuitState.circuit?.openedAt && <div className="automation-actions">
          <button className="secondary-button" disabled={busy !== null || !canChangeStatus} onClick={() => void resetCircuit()} type="button">{busy === "reset-circuit" ? "重置中…" : "人工重置熔断"}</button>
        </div>}
        {circuitState.circuit?.openedAt && <p className="error-text">连续写入失败已触发熔断：{circuitState.circuit.lastError ?? "未知错误"}。修复连接后人工重置即可恢复自动启停。</p>}
      </section>

      <AutomationFeaturesPage onError={onError} />

      <section className="automation-history-section">
        <div className="automation-section-heading">
          <div>
            <span className="panel-icon"><Activity size={18} /></span>
            <div>
              <h2>最近运行</h2>
            </div>
          </div>
          <button className="secondary-button" onClick={() => void load()} type="button"><RefreshCcw size={16} /> 刷新</button>
        </div>
        <div className="table-wrap automation-history-table">
          <table>
            <thead><tr><th>开始时间</th><th>来源</th><th>候选</th><th>执行结果</th><th>状态</th><th>说明</th></tr></thead>
            <tbody>{runs.length === 0 ? <tr><td colSpan={6}>暂无已完成轮询记录。</td></tr> : runs.map((run) => <tr key={run.id}><td>{new Date(run.startedAt).toLocaleString()}</td><td>{automationTriggerLabel(run.trigger)}</td><td>{run.candidateCount}</td><td>{run.successCount} 成功 / {run.failureCount} 失败</td><td><span className={`status ${run.status === "completed" ? "active" : run.status === "failed" ? "danger" : "warning"}`}>{automationRunStatusLabel(run.status)}</span></td><td><small>{run.errorMessage ?? (run.candidateCount === 0 ? "本轮轮询正常完成，无需操作。" : "已生成规则建议，详见下方记录。")}</small></td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="automation-history-section automation-decision-history">
        <div className="automation-section-heading">
          <div><span className="panel-icon"><ListChecks size={18} /></span><div><h2>规则建议与执行记录</h2><p>保留触发规则、指标快照、规则版本、数据质量和自动执行结果。</p></div></div>
          <button className="secondary-button" onClick={() => void load()} type="button"><RefreshCcw size={16} /> 刷新</button>
        </div>
        <div className="table-wrap automation-history-table">
          <table>
            <thead><tr><th>对象</th><th>层级</th><th>命中条件</th><th>动作</th><th>结果</th><th>时间</th></tr></thead>
            <tbody>
              {actionableDecisions.length === 0 ? <tr><td colSpan={6}>暂无实际动作、失败或状态变化记录。常规安全跳过仍会保留在本地审计中。</td></tr> : actionableDecisions.map((decision) => {
                return (
                  <tr key={decision.id}>
                    <td><strong>{decision.entityName}</strong><br /><small>{decision.externalId}</small></td>
                    <td>{entityTypeLabel(decision.entityType)}</td>
                    <td>{metricLabel(decision.metric)} {operatorLabel(decision.operator)} {decision.thresholdValue}<br /><small>当前 {decision.metricValue} · {decision.thresholdCode}</small><br /><small>{decision.reason}</small><br /><small>规则版本 {formatRuleVersion(decision.ruleVersion)}</small><br /><small>指标快照：{formatMetricSnapshot(decision.metricSnapshot)}</small></td>
                    <td>{decision.action === "enable" ? "开启" : "关闭"}</td>
                    <td>
                      <span className={`status ${decision.status === "succeeded" ? "active" : decision.status === "failed" || decision.status === "unknown" ? "danger" : "warning"}`}>{decisionStatusLabel(decision.status)}</span>
                      {decision.errorMessage && <small className="decision-error">{decision.errorMessage}</small>}
                      {decision.status === "preview" && <small>已被更新决策或对象状态取代</small>}
                      <small className={decision.dataQualityStatus === "healthy" ? undefined : "decision-error"}>数据质量：{decision.dataQualityStatus}。{decision.dataQualityWarnings.length > 0 ? decision.dataQualityWarnings.join("；") : "无警告"}</small>
                    </td>
                    <td>{new Date(decision.createdAt).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
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
  allowAll = false,
  children,
}: {
  accounts: AccountConfig[];
  selectedId: string;
  onSelect: (id: string) => void;
  allowAll?: boolean;
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
          {allowAll && <option value="all">全部账户</option>}
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
        capabilities: AccountProviderCapabilities | undefined;
  }
    | undefined,
  kind: ProviderKind,
): ReactNode {
  if (kind === "meta-offline") {
    return <span className="status warning">离线架构 · 无网络</span>;
  }
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
    const access = accountAccessStatus({
      connection,
      latestSync: latestSync ?? null,
      capabilities: state?.capabilities ?? {
        accountId: connection.accountId,
        providerKind: kind,
        providerDisplayName: providerLabel(kind),
        capabilityVersion: connection.capabilityVersion,
        authorizationStatus: connection.authorizationStatus,
        authorizedAt: connection.authorizedAt,
        authorizationExpiresAt: connection.authorizationExpiresAt,
        capabilities: [],
      },
    });
    const statusClass = (ready: boolean) => ready ? "status active" : "status warning";
    return <div className="capability-statuses" title={access.blockers.join("；")}>
      <span className={statusClass(access.readReady)}>读取：{access.readReady ? "可用" : "未就绪"}</span>
      <span className={statusClass(access.statusReady)}>启停：{access.statusReady ? "可用" : "未就绪"}</span>
      <span className={statusClass(access.createReady)}>创建：{access.createReady ? "可用" : "未就绪"}</span>
      <span className={statusClass(access.copyReady)}>复制：{access.copyReady ? "可用" : "未就绪"}</span>
    </div>;
  }
  if (connection.status === "failed" && isNetworkUnreachableMessage(connection.lastMessage)) {
    return <span className="status danger" title={connection.lastMessage ?? undefined}>网络不可达</span>;
  }
  if (connection.status === "failed" && kind === "cookie") {
    return <span className="status danger">Cookie 已失效</span>;
  }
  return <span className="status">{connection.status === "untested" ? "等待检测" : "连接异常"}</span>;
}

function providerLabel(kind: ProviderKind): string {
  return {
    cookie: "Cookie 会话",
    "official-api": "TikTok Marketing API",
    "meta-offline": "Meta 离线架构",
    "meta-marketing-api": "Meta Marketing API（官方接入）",
  }[kind];
}

function platformLabel(platform: PlatformKind): string {
  return platform === "meta" ? "Meta Ads" : "TikTok Ads";
}

function accountTypeLabel(type: AccountConfig["accountType"]): string {
  return { standard: "普通广告账户", agency: "代理账户", shop: "TikTok Shop" }[
    type
  ];
}

function operatorLabel(operator: ThresholdConfig["operator"]): string {
  return { gt: ">", gte: "≥", lt: "<", lte: "≤" }[operator];
}

function entityTypeLabel(entityType: SyncEntityType): string {
  return { campaign: "广告系列", "ad-group": "广告组", ad: "广告", material: "素材" }[
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

function formatRuleVersion(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

function formatMetricSnapshot(
  snapshot: AutomationDecisionRecord["metricSnapshot"],
): string {
  return [
    ["消耗", snapshot.spend],
    ["预算", snapshot.budget],
    ["点击", snapshot.clicks],
    ["转化", snapshot.conversions],
    ["加购", snapshot.carts],
    ["展示", snapshot.impressions],
    ["CPC", snapshot.cost_per_click],
    ["CPA", snapshot.cost_per_conversion],
    ["加购成本", snapshot.cost_per_cart],
  ].map(([label, value]) => `${label} ${formatMetric(value as number | null)}`).join(" · ");
}

function decisionStatusLabel(
  status: AutomationDecisionRecord["status"],
): string {
  return {
    preview: "预览命中",
    pending: "等待确认",
    succeeded: "执行成功",
    failed: "执行失败",
    unknown: "执行结果待确认",
    skipped: "安全跳过",
  }[status];
}

function automationTriggerLabel(trigger: AutomationRunRecord["trigger"]): string {
  return ({ scheduler: "后台轮询", manual: "手动生成建议", preview: "检测预览" })[trigger];
}

function automationRunStatusLabel(status: AutomationRunRecord["status"]): string {
  return ({ running: "进行中", completed: "已完成", failed: "失败" })[status];
}

function operationalStatusLabel(
  status: ManagedEntityRecord["status"],
): string {
  return { enabled: "已开启", disabled: "已关闭", unknown: "待确认" }[status];
}

function operationActionLabel(action: AdOperationRecord["action"]): string {
  return {
    enable: "开启",
    disable: "关闭",
    ignore: "加入忽略",
    unignore: "取消忽略",
    appeal: "申诉",
    delete: "删除广告组",
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

/**
 * 指标单元格的类名。
 *
 * 大多数账户里绝大部分行的指标都是 0（当天还没跑出量），它们和真实数字一样黑，
 * 扫一列时满屏的 0 在抢注意力。这里把 0 压暗，让有数据的行自己跳出来。
 * 超阈值优先于压暗：命中规则的值必须显眼，哪怕它是 0。
 */
export function metricCellClass(value: number | null, breached: boolean): string {
  if (breached) return "tk-num metric-breach";
  return value === 0 ? "tk-num tk-zero" : "tk-num";
}

function localDateTimeInputValue(value: Date): string {
  const timezoneOffset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - timezoneOffset).toISOString().slice(0, 16);
}

function nextLocalMidnightInputValue(): string {
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  return localDateTimeInputValue(next);
}

function nextOvernightScheduleTimes(): { disableAt: Date; enableAt: Date } {
  const disableAt = new Date();
  disableAt.setHours(23, 45, 0, 0);
  if (disableAt.getTime() <= Date.now()) disableAt.setDate(disableAt.getDate() + 1);
  const enableAt = new Date(disableAt);
  enableAt.setHours(24, 0, 0, 0);
  return { disableAt, enableAt };
}

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function aggregateAccountBatches(lists: MetricBatchRecord[][]): MetricBatchRecord[] {
  const byTime = new Map<string, MetricBatchRecord>();
  for (const list of lists) {
    for (const batch of list) {
      const existing = byTime.get(batch.capturedAt);
      if (existing) {
        existing.count += batch.count;
        existing.spend += batch.spend;
        existing.clicks += batch.clicks;
        existing.conversions += batch.conversions;
      } else {
        byTime.set(batch.capturedAt, { ...batch });
      }
    }
  }
  return [...byTime.values()];
}

function AllAccountsAnalyticsView({ accounts, onError }: { accounts: AccountConfig[]; onError: (message: string | null) => void }) {
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
  const [days, setDays] = useState<DailyMetricRecord[] | null>(null);
  const range = useMemo(() => {
    try { return resolveAnalysisRange(preset, customFrom, customTo); } catch { return null; }
  }, [customFrom, customTo, preset]);

  useEffect(() => {
    if (!range) return;
    setBatches(null);
    setDays(null);
    const entityType = level === "all" ? undefined : level;
    void Promise.all([
      Promise.all(accounts.map((account) => api.getMetricDays(account.id, range, entityType).catch(() => [] as DailyMetricRecord[]))),
      Promise.all(accounts.map((account) => api.getAnalytics(account.id, range, entityType).catch(() => [] as MetricBatchRecord[]))),
    ])
      .then(([dailyLists, batchLists]) => {
        // 跨账户按自然日相加；批次只是同步日志，仍按时间戳并列。
        setDays(mergeDailyMetricsAcrossAccounts(dailyLists));
        setBatches(aggregateAccountBatches(batchLists));
        onError(null);
      })
      .catch((cause) => onError(getErrorMessage(cause)));
  }, [accounts, level, onError, range?.from, range?.to]);

  const summary = useMemo(() => summarizeDailyMetrics(days ?? []), [days]);
  if (!days || !batches) return <EmptyState text="正在汇总全部账户指标…" loading />;

  return (
    <section className="page-stack analytics-page">
      <div className="panel filter-panel">
        <div className="analytics-context-bar">
          <div>
            <span className="status active">全部账户</span>
            <small>汇总 {accounts.length} 个账户的检测批次；跨币种金额直接相加，仅供趋势参考。</small>
          </div>
        </div>
        <div className="form-grid management-filters">
          <Field label="时间范围"><select value={preset} onChange={(event) => setPreset(event.target.value as AnalysisPreset)}><option value="today">今天</option><option value="yesterday">昨天</option><option value="3d">三天</option><option value="7d">七天</option><option value="30d">三十天</option><option value="custom">自定义</option></select></Field>
          <Field label="分析层级"><select value={level} onChange={(event) => setLevel(event.target.value as typeof level)}><option value="all">全部层级</option><option value="campaign">广告系列</option><option value="ad-group">广告组</option><option value="ad">广告</option></select></Field>
          {preset === "custom" && <><Field label="开始日期"><input type="date" max={customTo || today} value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></Field><Field label="结束日期"><input type="date" min={customFrom} max={today} value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></Field></>}
        </div>
        {!range && <p className="error-text">请选择有效日期，且范围不超过 90 天。</p>}
        <p className="retention-note">本地快照保留 90 天；已按检测时间聚合全部账户。</p>
      </div>
      <div className="summary-grid">
        <SummaryCard icon={<Gauge size={20} />} label="区间消耗" value={formatMetric(summary.spend)} tone="blue" />
        <SummaryCard icon={<Activity size={20} />} label="区间点击" value={formatMetric(summary.clicks)} tone="violet" />
        <SummaryCard icon={<Check size={20} />} label="区间转化" value={formatMetric(summary.conversions)} tone="green" />
        <SummaryCard icon={<CircleGauge size={20} />} label="平均 CPC" value={formatMetric(summary.cpc)} tone="blue" />
        <SummaryCard icon={<CircleGauge size={20} />} label="平均转化成本" value={formatMetric(summary.cpa)} tone="violet" />
      </div>
      <div className="panel batch-chart-panel">
        <div className="panel-heading"><div><span className="panel-icon"><BarChart3 size={18} /></span><div><h2>按日趋势</h2></div></div><div className="chart-selectors"><label>柱状 <select value={barMetric} onChange={(event) => setBarMetric(event.target.value as BatchBarMetric)}><option value="spend">消耗</option><option value="clicks">点击</option><option value="conversions">转化</option></select></label><label>折线 <select value={lineMetric} onChange={(event) => setLineMetric(event.target.value as BatchLineMetric)}><option value="cpc">平均 CPC</option><option value="cpa">平均转化成本</option></select></label></div></div>
        <DailyTrendChart days={days} barMetric={barMetric} lineMetric={lineMetric} />
      </div>
      <details className="panel table-panel collapsible-panel">
        <summary className="panel-heading"><div><span className="panel-icon"><BarChart3 size={18} /></span><div><h2>同步批次日志 <em className="heading-count">{batches.length}</em></h2></div></div></summary>
        <div className="table-wrap"><table>
          <thead><tr><th>检测时间</th><th>对象数</th><th>消耗</th><th>点击</th><th>转化</th><th>平均 CPC</th><th>平均转化成本</th></tr></thead>
          <tbody>{batches.length === 0 ? <tr><td colSpan={7}>暂无历史快照，请先执行检测。</td></tr> : batches.map((batch) => <tr key={batch.capturedAt}><td>{new Date(batch.capturedAt).toLocaleString()}</td><td>{batch.count}</td><td>{formatMetric(batch.spend)}</td><td>{formatMetric(batch.clicks)}</td><td>{formatMetric(batch.conversions)}</td><td>{formatMetric(batch.clicks > 0 ? batch.spend / batch.clicks : null)}</td><td>{formatMetric(batch.conversions > 0 ? batch.spend / batch.conversions : null)}</td></tr>)}</tbody>
        </table></div>
      </details>
    </section>
  );
}

function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "发生未知错误。";
}
