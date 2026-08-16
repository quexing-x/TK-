import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Database,
  KeyRound,
  Link2,
  LockKeyhole,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  RefreshCcw,
  UserRound,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type {
  AccountConfig,
  AccountProviderCapabilities,
  OfficialApiConnectionSettings,
  ProviderConnection,
  ProviderKind,
} from "@tk-auto/core";
import { api, type CookieConnectionReadiness } from "./api";
import { useAuth } from "./AuthGate";
import { useOverlays } from "./ui/overlays";
import { MetaConnectionPage } from "./MetaConnectionPage";
import { hasProviderCapability, providerCapabilityReason } from "./provider-capability-view";
import {
  canSubmitCookieImport,
  describeCookieState,
  displayedCookieReadiness,
  getCookieImportSteps,
  replaceProviderConnection,
} from "./cookie-onboarding.js";

const emptyApiSettings: OfficialApiConnectionSettings = {
  kind: "official-api",
  advertiserId: "",
};

const emptyReadiness: CookieConnectionReadiness = {
  dataRequestImported: false,
  statusRequestImported: false,
  requiredFields: {
    listQuery: false,
    updateQuery: false,
    copyQuery: false,
    csrfToken: false,
    cookie: false,
  },
  completedFields: 0,
  totalFields: 5,
  fieldsComplete: false,
};

const requiredFieldLabels = [
  ["listQuery", "/adgroup/list 查询参数"],
  ["updateQuery", "/ad/update_status 更新参数"],
  ["copyQuery", "/adgroup/list 复制参数（自动生成）"],
  ["csrfToken", "CSRF Token"],
  ["cookie", "Cookie"],
] as const;

const capabilityLabels = [
  ["read-campaigns", "广告系列监控", "只读"],
  ["read-ad-groups", "广告组监控", "只读"],
  ["read-ads", "广告监控", "只读"],
  ["read-reports", "报表同步", "只读"],
  ["create-campaigns", "广告创建", "写入"],
  ["copy-ads", "广告复制", "写入"],
  ["change-status", "状态管理", "写入"],
  ["delete-ad-groups", "删除广告组", "写入"],
  ["appeal-ads", "广告申诉", "写入"],
] as const;

export function ConnectionPage(props: {
  account: AccountConfig;
  onConnectionReady?: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  return props.account.platform === "meta"
    ? <MetaConnectionPage {...props} />
    : <TikTokConnectionPage {...props} />;
}

function TikTokConnectionPage({
  account,
  onConnectionReady,
  onError,
}: {
  account: AccountConfig;
  onConnectionReady?: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const auth = useAuth();
  const { confirm, toast } = useOverlays();
  const canManageAccounts = auth.status.permissions.includes("accounts:manage");
  const [providerKind, setProviderKind] = useState<ProviderKind>("cookie");
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [capabilityProfiles, setCapabilityProfiles] = useState<AccountProviderCapabilities[]>([]);
  const [readiness, setReadiness] =
    useState<CookieConnectionReadiness>(emptyReadiness);
  const [apiSettings, setApiSettings] =
    useState<OfficialApiConnectionSettings>(emptyApiSettings);
  const [accessToken, setAccessToken] = useState("");
  const [readCurlCommand, setReadCurlCommand] = useState("");
  const [statusCurlCommand, setStatusCurlCommand] = useState("");
  const [copiedFilter, setCopiedFilter] = useState<string | null>(null);
  const [importFeedback, setImportFeedback] = useState<{
    message: string;
    ok: boolean;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, nextReadiness, nextCapabilityProfiles] = await Promise.all([
        api.getConnections(account.id),
        api.getCookieReadiness(account.id),
        api.getConnectionCapabilities(account.id),
      ]);
      setConnections(list);
      setCapabilityProfiles(nextCapabilityProfiles);
      setReadiness(nextReadiness);
      const apiConnection = list.find((item) => item.kind === "official-api");
      setApiSettings(
        apiConnection?.settings.kind === "official-api"
          ? apiConnection.settings
          : emptyApiSettings,
      );
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    }
  }, [account.id, onError]);

  useEffect(() => {
    setImportFeedback(null);
    setReadCurlCommand("");
    setStatusCurlCommand("");
    void load();
  }, [load]);

  const connection = connections.find((item) => item.kind === providerKind);
  const cookieConnection = connections.find((item) => item.kind === "cookie");
  const apiConnection = connections.find((item) => item.kind === "official-api");
  const visibleReadiness = displayedCookieReadiness(readiness, connection);
  const cookieState = describeCookieState(visibleReadiness, connection);

  const copyNetworkFilter = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedFilter(value);
      onError(null);
    } catch {
      onError("复制失败，请手动选中过滤词后复制。");
    }
  };

  const importBothCurls = async () => {
    try {
      setBusy("import");
      setImportFeedback(null);
      let result = connection;
      for (const importStep of getCookieImportSteps(
        readCurlCommand,
        statusCurlCommand,
      )) {
        result = await api.importCookieCurl(
          account.id,
          importStep.command,
          importStep.step,
        );
        setConnections((current) => replaceProviderConnection(current, result!));
        if (importStep.step === "read") {
          setReadCurlCommand("");
          await load();
        } else {
          setStatusCurlCommand("");
        }
      }
      const nextReadiness = await api.getCookieReadiness(account.id);
      setReadiness(nextReadiness);
      await load();
      const importReady =
        result?.status === "ready" &&
        nextReadiness.fieldsComplete &&
        nextReadiness.statusRequestImported;
      if (importReady) await onConnectionReady?.();
      setImportFeedback({
        ok: importReady,
        message:
          importReady
            ? "两段 cURL 已解码并加密保存，必要字段与启停能力均已建立。"
            : "请求已加密保存，但必要字段、账户读取或三级启停模板仍未全部就绪，请按实时状态提示重新复制对应 cURL。",
      });
    } catch (cause) {
      const message = getErrorMessage(cause);
      setImportFeedback({ message, ok: false });
      onError(message);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const saveApiSettings = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setBusy("settings");
      await api.saveConnectionSettings(
        account.id,
        "official-api",
        apiSettings,
      );
      if (connection?.hasCredential) {
        await api.testConnection(account.id, "official-api");
        await onConnectionReady?.();
      }
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const saveApiCredential = async () => {
    try {
      setBusy("credential");
      await api.saveCredential(account.id, "official-api", {
        kind: "official-api",
        accessToken,
      });
      setAccessToken("");
      await api.testConnection(account.id, "official-api");
      await onConnectionReady?.();
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
      await load();
    } finally {
      setBusy(null);
    }
  };

  const deleteCredential = async () => {
    if (!await confirm({ title: "删除本机凭据", message: "确定删除本机加密凭据吗？接入参数会保留。", confirmLabel: "删除凭据", danger: true })) return;
    try {
      setBusy("delete");
      await api.deleteCredential(account.id, providerKind);
      await load();
      toast("本机加密凭据已删除");
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const syncReadOnly = async () => {
    if (connection?.status !== "ready") return;
    try {
      setBusy("sync");
      const result = await api.syncReadOnly(account.id, providerKind);
      const qualityMessage = result.quality.status === "healthy"
        ? "数据完整。"
        : `数据质量：${result.quality.status}${result.warnings.length ? `；${result.warnings.join("；")}` : "。"}`;
      setImportFeedback({
        ok: result.quality.status === "healthy",
        message: `已完成只读同步：系列 ${result.counts.campaign}、广告组 ${result.counts["ad-group"]}、广告 ${result.counts.ad}。${qualityMessage}`,
      });
      await load();
    } catch (cause) {
      const message = getErrorMessage(cause);
      setImportFeedback({ message, ok: false });
      onError(message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="connection-page">
      <AccountIdentity account={account} connection={connection} providerKind={providerKind} />

      <section className="connection-section connection-access-section" aria-labelledby="connection-access-title">
        <SectionTitle
          description="选择接入方式并完成当前账户所需的凭据配置。"
          icon={<Link2 size={18} />}
          id="connection-access-title"
          title="接入方式"
        />

        <div className="provider-tabs" role="tablist" aria-label="账户接入方式">
          <button
            aria-selected={providerKind === "cookie"}
            className={providerKind === "cookie" ? "active" : ""}
            onClick={() => setProviderKind("cookie")}
            role="tab"
            type="button"
          >
            <KeyRound size={18} /> Cookie 会话
          </button>
          <button
            aria-selected={providerKind === "official-api"}
            className={providerKind === "official-api" ? "active" : ""}
            onClick={() => setProviderKind("official-api")}
            role="tab"
            type="button"
          >
            <ShieldCheck size={18} /> Marketing API
          </button>
        </div>

        {providerKind === "cookie" ? (
          <div className="connection-setup-grid">
            <div className="connection-setup-main">
              <div className="connection-subheading">
                <span className="connection-subheading-icon"><Sparkles size={18} /></span>
                <div>
                  <h3>导入 Cookie 接入信息</h3>
                  <p>程序只提取并加密保存必要字段，不显示 Cookie、Token 或完整请求内容。</p>
                </div>
              </div>

              <p className="provider-endpoint-note">
                申诉接口已内置并复用；程序会使用当前账户的 Cookie、CSRF 和广告主 ID 发起请求，无需为每个账户单独导入申诉 cURL。
              </p>

              <div className="cookie-import-steps">
                <CurlStep
                  complete={visibleReadiness.dataRequestImported}
                  copiedFilter={copiedFilter}
                  filter="/adgroup/list/?"
                  label="获取账户数据"
                  onCopy={copyNetworkFilter}
                  reminder="进入广告组页面后刷新，选择最后一条成功请求，再右键 Copy → Copy as cURL (bash)。"
                  step="1"
                  title="广告组列表 cURL"
                >
                  <textarea
                    aria-label="广告组列表 cURL"
                    className="curl-input"
                    onChange={(event) => setReadCurlCommand(event.target.value)}
                    placeholder="粘贴 /adgroup/list/? 请求的完整 cURL"
                    rows={6}
                    spellCheck={false}
                    value={readCurlCommand}
                  />
                </CurlStep>

                <CurlStep
                  complete={visibleReadiness.statusRequestImported}
                  copiedFilter={copiedFilter}
                  filter="/ad/update_status/?"
                  label="获取启停能力"
                  onCopy={copyNetworkFilter}
                  reminder="切换任意一条测试广告的开关，选择刚出现的 POST 请求，再右键 Copy → Copy as cURL (bash)。完成后可把测试广告恢复原状态。"
                  step="2"
                  title="广告启停 cURL"
                >
                  <textarea
                    aria-label="广告启停 cURL"
                    className="curl-input"
                    onChange={(event) => setStatusCurlCommand(event.target.value)}
                    placeholder="粘贴 /ad/update_status/? 请求的完整 cURL"
                    rows={6}
                    spellCheck={false}
                    value={statusCurlCommand}
                  />
                </CurlStep>
              </div>

              <div className="curl-import-actions">
                <span><LockKeyhole size={15} /> 两段内容仅在本机解码，并通过 Windows DPAPI 加密保存。</span>
                <button
                  className="primary-button"
                  disabled={!canSubmitCookieImport({
                    busy: busy !== null,
                    readCommand: readCurlCommand,
                    readiness: visibleReadiness,
                    statusCommand: statusCurlCommand,
                  })}
                  onClick={() => void importBothCurls()}
                  type="button"
                >
                  <Sparkles size={17} />
                  {busy === "import" ? "正在导入…" : "导入并检查"}
                </button>
              </div>
            </div>

            <ReadinessPanel
              connection={cookieConnection}
              readiness={visibleReadiness}
            />
          </div>
        ) : (
          <div className="connection-setup-grid">
            <div className="official-api-forms">
              <form className="connection-form-block" onSubmit={(event) => void saveApiSettings(event)}>
                <div className="connection-subheading">
                  <span className="connection-subheading-icon"><Link2 size={18} /></span>
                  <div>
                    <h3>Marketing API 接入参数</h3>
                    <p>非敏感参数保存在本地 SQLite。</p>
                  </div>
                </div>
                <ConnectionField label="Advertiser ID">
                  <input
                    onChange={(event) => setApiSettings({ ...apiSettings, advertiserId: event.target.value })}
                    value={apiSettings.advertiserId}
                  />
                </ConnectionField>
                <div className="provider-endpoint-note">
                  官方端点固定使用 business-api.tiktok.com/open_api/v1.3，无需手动填写。
                </div>
                <div className="connection-inline-actions">
                  <button className="secondary-button" disabled={busy !== null} type="submit">
                    <Save size={17} /> {busy === "settings" ? "保存中…" : "保存接入参数"}
                  </button>
                </div>
              </form>

              <div className="connection-form-block">
                <div className="connection-subheading">
                  <span className="connection-subheading-icon"><KeyRound size={18} /></span>
                  <div>
                    <h3>Access Token</h3>
                    <p>使用 Windows 当前用户 DPAPI 加密，保存后自动验证权限。</p>
                  </div>
                </div>
                <ConnectionField label="长期 Access Token">
                  <textarea
                    onChange={(event) => setAccessToken(event.target.value)}
                    placeholder="不要填写 App Secret"
                    rows={5}
                    value={accessToken}
                  />
                </ConnectionField>
                <div className="connection-inline-actions split-actions">
                  {connection?.hasCredential && (
                    <button className="danger-button" disabled={busy !== null} onClick={() => void deleteCredential()} type="button">
                      <Trash2 size={16} /> 删除凭据
                    </button>
                  )}
                  <button
                    className="primary-button"
                    disabled={busy !== null || accessToken.length < 10}
                    onClick={() => void saveApiCredential()}
                    type="button"
                  >
                    <Save size={17} />
                    {busy === "credential" ? "保存并验证中…" : "加密保存并验证"}
                  </button>
                </div>
              </div>
            </div>

            <ReadinessPanel connection={apiConnection} advertiserId={apiSettings.advertiserId} />
          </div>
        )}
      </section>

      <section className="connection-section" aria-labelledby="connection-state-title">
        <SectionTitle
          description="使用实际授权结果呈现连接健康度与每种接入方式可执行的能力。"
          icon={<Activity size={18} />}
          id="connection-state-title"
          title="连接状态与能力"
        />
        <div className="connection-observability-grid">
          <ConnectionStatusPanel
            busy={busy}
            canManageAccounts={canManageAccounts}
            connection={connection}
            cookieState={providerKind === "cookie" ? cookieState : undefined}
            onDelete={() => void deleteCredential()}
            onSync={() => void syncReadOnly()}
            providerKind={providerKind}
          />
          <CapabilityMatrix capabilityProfiles={capabilityProfiles} />
        </div>
      </section>

      <section className="connection-section" aria-labelledby="connection-sync-title">
        <SectionTitle
          description="同步结果与凭据保护信息独立呈现，便于在执行前确认数据质量和安全边界。"
          icon={<Database size={18} />}
          id="connection-sync-title"
          title="同步质量与安全"
        />
        <div className="connection-quality-grid">
          <SyncQualityPanel connection={connection} feedback={importFeedback} providerKind={providerKind} />
          <SecurityPanel canManageAccounts={canManageAccounts} />
        </div>
      </section>
    </section>
  );
}

function CurlStep({
  complete,
  copiedFilter,
  filter,
  label,
  onCopy,
  reminder,
  step,
  title,
  children,
}: {
  complete: boolean;
  copiedFilter: string | null;
  filter: string;
  label: string;
  onCopy: (value: string) => Promise<void>;
  reminder: string;
  step: string;
  title: string;
  children: React.ReactNode;
}) {
  const copied = copiedFilter === filter;
  return (
    <article className={`cookie-import-step ${complete ? "complete" : ""}`}>
      <header>
        <span className="cookie-step-number">{complete ? "✓" : step}</span>
        <div>
          <span className="eyebrow">{label}</span>
          <h3>{title}</h3>
        </div>
        <strong className="cookie-step-state">{complete ? "已获取" : "待导入"}</strong>
      </header>
      <p>{reminder}</p>
      <div className="network-filter-row">
        <span>Network 搜索内容</span>
        <button
          aria-label={`复制过滤词 ${filter}`}
          className={copied ? "copied" : ""}
          onClick={() => void onCopy(filter)}
          type="button"
        >
          <code>{filter}</code>
          {copied ? <CheckCircle2 size={15} /> : <Copy size={15} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      {children}
    </article>
  );
}

function AccountIdentity({
  account,
  connection,
  providerKind,
}: {
  account: AccountConfig;
  connection: ProviderConnection | undefined;
  providerKind: ProviderKind;
}) {
  const initials = account.displayName.trim().slice(0, 2).toUpperCase();
  return (
    <header className="connection-identity">
      <div className="connection-account-mark" aria-hidden="true">{initials || <UserRound size={24} />}</div>
      <div className="connection-account-copy">
        <span>账户身份</span>
        <h2>{account.displayName}</h2>
        <p>{account.enabled ? "账户已启用" : "账户未启用"}，当前配置可独立验证后再进入自动化流程。</p>
      </div>
      <dl className="connection-account-meta">
        <div><dt>账户 ID</dt><dd>{maskIdentifier(account.id)}</dd></div>
        <div><dt>账户类型</dt><dd>{accountTypeLabel(account.accountType)}</dd></div>
        <div><dt>时区</dt><dd>{account.timezone}</dd></div>
        <div><dt>当前接入</dt><dd>{providerKind === "cookie" ? "Cookie 会话" : "Marketing API"}</dd></div>
      </dl>
      <span className={`connection-identity-status ${connection?.status ?? "not-configured"}`}>
        <span className="connection-state-dot" />
        {connectionStatusLabel(connection?.status)}
      </span>
    </header>
  );
}

function SectionTitle({
  description,
  icon,
  id,
  title,
}: {
  description: string;
  icon: React.ReactNode;
  id: string;
  title: string;
}) {
  return (
    <div className="connection-section-title">
      <span>{icon}</span>
      <div>
        <h2 id={id}>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  );
}

function ReadinessPanel({
  advertiserId,
  connection,
  readiness,
}: {
  advertiserId?: string;
  connection: ProviderConnection | undefined;
  readiness?: CookieConnectionReadiness;
}) {
  const rows = readiness
    ? requiredFieldLabels.map(([key, label]) => ({ label, ready: readiness.requiredFields[key] }))
    : [
        { label: "Advertiser ID 已填写", ready: Boolean(advertiserId?.trim()) },
        { label: "Access Token 已加密保存", ready: Boolean(connection?.hasCredential) },
        { label: "连接测试已通过", ready: connection?.status === "ready" },
        { label: "账户授权处于有效状态", ready: connection?.authorizationStatus === "active" },
      ];
  const completed = rows.filter((row) => row.ready).length;
  return (
    <aside className="connection-readiness" aria-label="连接就绪检查">
      <div className="connection-readiness-heading">
        <div><h3>连接就绪检查</h3><p>{completed}/{rows.length} 项就绪</p></div>
        <strong>{completed === rows.length ? "可以连接" : "需要补充"}</strong>
      </div>
      <div className="connection-readiness-list">
        {rows.map((row) => (
          <div className={row.ready ? "ready" : "pending"} key={row.label}>
            {row.ready ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
            <span>{row.label}</span>
            <small>{row.ready ? "已提供" : "待完成"}</small>
          </div>
        ))}
      </div>
      {readiness && (
        <div className="connection-readiness-foot">
          <span>账户数据请求</span><strong>{readiness.dataRequestImported ? "已导入" : "待导入"}</strong>
          <span>状态更新请求</span><strong>{readiness.statusRequestImported ? "已导入" : "待导入"}</strong>
        </div>
      )}
    </aside>
  );
}

function ConnectionStatusPanel({
  busy,
  canManageAccounts,
  connection,
  cookieState,
  onDelete,
  onSync,
  providerKind,
}: {
  busy: string | null;
  canManageAccounts: boolean;
  connection: ProviderConnection | undefined;
  cookieState: ReturnType<typeof describeCookieState> | undefined;
  onDelete: () => void;
  onSync: () => void;
  providerKind: ProviderKind;
}) {
  const status = connection?.status ?? "not-configured";
  return (
    <div className="connection-status-panel">
      <div className="connection-status-heading">
        <span className={`connection-status-symbol ${status}`}><Activity size={20} /></span>
        <div>
          <span>{providerKind === "cookie" ? "Cookie 会话" : "Marketing API"}</span>
          <h3>{cookieState?.label ?? connectionStatusLabel(status)}</h3>
          <p>{cookieState?.message ?? connection?.lastMessage ?? "尚未保存该接入方式的配置。"}</p>
        </div>
      </div>
      <dl className="connection-status-facts">
        <div><dt>凭据状态</dt><dd>{connection?.hasCredential ? "已加密保存" : "未保存"}</dd></div>
        <div><dt>授权状态</dt><dd>{authorizationStatusLabel(connection?.authorizationStatus)}</dd></div>
        <div><dt>最近检查</dt><dd>{formatDateTime(connection?.lastTestedAt)}</dd></div>
        <div><dt>能力数量</dt><dd>{connection?.authorizedCapabilities.length ?? 0} 项</dd></div>
      </dl>
      <div className="connection-status-actions">
        {connection?.status === "ready" && (
          <button className="secondary-button" disabled={busy !== null || !canManageAccounts} onClick={onSync} title={canManageAccounts ? undefined : "需要 accounts:manage 权限"} type="button">
            <RefreshCcw size={16} /> {busy === "sync" ? "同步中…" : "同步广告数据（只读）"}
          </button>
        )}
        {connection?.hasCredential && (
          <button className="danger-button" disabled={busy !== null} onClick={onDelete} type="button">
            <Trash2 size={16} /> {providerKind === "cookie" ? "删除本机凭据" : "删除凭据"}
          </button>
        )}
      </div>
    </div>
  );
}

function CapabilityMatrix({
  capabilityProfiles,
}: {
  capabilityProfiles: AccountProviderCapabilities[];
}) {
  const cookieProfile = capabilityProfiles.find((item) => item.providerKind === "cookie");
  const apiProfile = capabilityProfiles.find((item) => item.providerKind === "official-api");
  return (
    <div className="connection-capabilities">
      <div className="connection-capabilities-heading">
        <div><h3>能力矩阵</h3><p>以服务端返回的授权能力为准</p></div>
        <div><span>Cookie</span><span>Official API</span></div>
      </div>
      <div className="connection-capability-list">
        {capabilityLabels.map(([capability, label, mode]) => {
          const cookieAvailable = hasProviderCapability(cookieProfile, capability);
          const apiAvailable = hasProviderCapability(apiProfile, capability);
          return (
            <div key={capability}>
              <span><strong>{label}</strong><small>{mode}</small></span>
              <CapabilityState available={cookieAvailable} reason={providerCapabilityReason(cookieProfile, capability)} />
              <CapabilityState available={apiAvailable} reason={providerCapabilityReason(apiProfile, capability)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CapabilityState({ available, reason }: { available: boolean; reason: string }) {
  const label = available ? "可用" : "不可用";
  return <span aria-label={`${label}：${reason}`} className={available ? "available" : "unavailable"} title={reason}>{available ? <CheckCircle2 aria-hidden="true" size={15} /> : <AlertTriangle aria-hidden="true" size={15} />}{label}</span>;
}

function SyncQualityPanel({
  connection,
  feedback,
  providerKind,
}: {
  connection: ProviderConnection | undefined;
  feedback: { message: string; ok: boolean } | null;
  providerKind: ProviderKind;
}) {
  const ready = connection?.status === "ready";
  return (
    <div className="connection-quality-panel">
      <div className="connection-quality-score">
        <span className={feedback ? (feedback.ok ? "healthy" : "warning") : ready ? "healthy" : "idle"}>
          {feedback ? (feedback.ok ? <CheckCircle2 size={26} /> : <AlertTriangle size={26} />) : <Database size={26} />}
        </span>
        <div><h3>同步质量</h3><p>{providerKind === "cookie" ? "Cookie 只读同步" : "Marketing API 只读同步"}</p></div>
      </div>
      <dl className="connection-quality-facts">
        <div><dt>连接基础</dt><dd>{ready ? "正常" : "未就绪"}</dd></div>
        <div><dt>最近连接检查</dt><dd>{formatDateTime(connection?.lastTestedAt)}</dd></div>
        <div><dt>会话有效期</dt><dd>{connection?.authorizationExpiresAt ? formatDateTime(connection.authorizationExpiresAt) : "未提供"}</dd></div>
      </dl>
      <div className={`connection-quality-feedback ${feedback ? (feedback.ok ? "success" : "error") : "empty"}`} aria-live="polite">
        {feedback ? (feedback.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />) : <Activity size={17} />}
        <span>{feedback?.message ?? "完成导入或只读同步后，这里会显示本次操作结果。"}</span>
      </div>
    </div>
  );
}

function SecurityPanel({ canManageAccounts }: { canManageAccounts: boolean }) {
  const rows = [
    "凭据仅在本机加密保存，界面不会回显 Cookie 或 Access Token。",
    "官方 API 端点固定为 TikTok HTTPS 地址，不能在表单中改写。",
    "同步操作保持只读，不会通过该入口修改广告状态。",
    canManageAccounts ? "当前用户具备 accounts:manage 权限。" : "当前用户缺少 accounts:manage 权限，同步操作已禁用。",
  ];
  return (
    <aside className="connection-security-panel">
      <span className="connection-security-icon"><LockKeyhole size={24} /></span>
      <div><h3>安全提示</h3><p>接入凭据与账户数据遵循现有本地保护和权限规则。</p></div>
      <div className="connection-security-list">
        {rows.map((row) => <span key={row}><CheckCircle2 size={15} />{row}</span>)}
      </div>
    </aside>
  );
}

function ConnectionField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function connectionStatusLabel(status?: ProviderConnection["status"]): string {
  return {
    "not-configured": "尚未配置",
    untested: "等待验证",
    ready: "连接正常",
    failed: "连接失败",
  }[status ?? "not-configured"];
}

function authorizationStatusLabel(status?: ProviderConnection["authorizationStatus"]): string {
  return {
    "not-authorized": "未授权",
    active: "有效",
    expired: "已过期",
    revoked: "已撤销",
    failed: "授权失败",
  }[status ?? "not-authorized"];
}

function accountTypeLabel(accountType: AccountConfig["accountType"]): string {
  return { standard: "普通广告账户", agency: "代理账户", shop: "TikTok Shop" }[accountType];
}

function maskIdentifier(value: string): string {
  return value.length > 10 ? `${value.slice(0, 6)}••••${value.slice(-4)}` : value;
}

function formatDateTime(value?: string | null): string {
  if (!value) return "尚未检查";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "发生未知错误。";
}
