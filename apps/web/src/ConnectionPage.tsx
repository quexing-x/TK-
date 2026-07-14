import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CloudDownload,
  Copy,
  KeyRound,
  Link2,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type {
  AccountConfig,
  CookieConnectionReadiness,
  CookieConnectionSettings,
  OfficialApiConnectionSettings,
  ProviderConnection,
  ProviderKind,
  ReadOnlySyncResult,
} from "@tk-auto/core";
import { api } from "./api";

const emptyCookieSettings: CookieConnectionSettings = {
  kind: "cookie",
  advertiserId: "",
  healthUrl: "",
  campaignsUrl: "",
  adGroupsUrl: "",
  adsUrl: "",
};

const emptyApiSettings: OfficialApiConnectionSettings = {
  kind: "official-api",
  advertiserId: "",
};

const emptyReadiness: CookieConnectionReadiness = {
  dataRequestImported: false,
  statusRequestImported: false,
  readTargets: [],
  statusTargets: [],
  completedSteps: 0,
};

export function ConnectionPage({
  account,
  onError,
}: {
  account: AccountConfig;
  onError: (message: string | null) => void;
}) {
  const [providerKind, setProviderKind] = useState<ProviderKind>("cookie");
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [readiness, setReadiness] =
    useState<CookieConnectionReadiness>(emptyReadiness);
  const [copiedFilter, setCopiedFilter] = useState<string | null>(null);
  const [cookieSettings, setCookieSettings] =
    useState<CookieConnectionSettings>(emptyCookieSettings);
  const [apiSettings, setApiSettings] =
    useState<OfficialApiConnectionSettings>(emptyApiSettings);
  const [cookie, setCookie] = useState("");
  const [csrfToken, setCsrfToken] = useState("");
  const [csrfHeaderName, setCsrfHeaderName] = useState("x-csrftoken");
  const [userAgent, setUserAgent] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [readCurlCommand, setReadCurlCommand] = useState("");
  const [statusCurlCommand, setStatusCurlCommand] = useState("");
  const [importFeedback, setImportFeedback] = useState<{
    step: "read" | "status";
    message: string;
    ok: boolean;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<ReadOnlySyncResult | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, nextReadiness] = await Promise.all([
        api.getConnections(account.id),
        api.getCookieReadiness(account.id),
      ]);
      setConnections(list);
      setReadiness(nextReadiness);
      const cookieConnection = list.find((item) => item.kind === "cookie");
      const apiConnection = list.find((item) => item.kind === "official-api");
      setCookieSettings(
        cookieConnection?.settings.kind === "cookie"
          ? cookieConnection.settings
          : emptyCookieSettings,
      );
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
    setSyncResult(null);
    setImportFeedback(null);
    void load();
  }, [load]);

  const connection = connections.find((item) => item.kind === providerKind);
  const cookieOnboardingIncomplete =
    providerKind === "cookie" && readiness.completedSteps < 2;
  const displayedConnectionStatus = cookieOnboardingIncomplete
    ? "untested"
    : (connection?.status ?? "not-configured");
  const displayedConnectionLabel = cookieOnboardingIncomplete
    ? `接入未完成（${readiness.completedSteps}/2）`
    : providerKind === "cookie" && connection?.status === "ready"
      ? "完整接入完成"
      : connectionStatusLabel(connection?.status);
  const displayedConnectionMessage = cookieOnboardingIncomplete
    ? readiness.dataRequestImported && connection?.status === "ready"
      ? "第 1 步只读连接正常；第 2 步启停请求尚未导入，自动启停暂不可用。"
      : `Cookie 完整接入尚未完成。${connection?.lastMessage ? ` ${connection.lastMessage}` : ""}`
    : (connection?.lastMessage ?? "尚未保存此 Provider 的接入参数。");

  const importCurl = async (step: "read" | "status") => {
    const command = step === "read" ? readCurlCommand : statusCurlCommand;
    try {
      setBusy(`import-${step}`);
      setImportFeedback(null);
      const result = await api.importCookieCurl(account.id, command.trim(), step);
      if (step === "read") setReadCurlCommand("");
      else setStatusCurlCommand("");
      setImportFeedback({
        step,
        message: result.lastMessage ?? "请求已加密保存，请查看连接状态。",
        ok: true,
      });
      await load();
    } catch (cause) {
      const message = getErrorMessage(cause);
      setImportFeedback({ step, message, ok: false });
      onError(message);
    } finally {
      setBusy(null);
    }
  };

  const copyNetworkFilter = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedFilter(value);
      onError(null);
    } catch {
      onError("复制失败，请手动选中过滤词后复制。");
    }
  };

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setBusy("settings");
      await api.saveConnectionSettings(
        account.id,
        providerKind,
        providerKind === "cookie" ? cookieSettings : apiSettings,
      );
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const saveCredential = async () => {
    try {
      setBusy("credential");
      await api.saveCredential(
        account.id,
        providerKind,
        providerKind === "cookie"
          ? {
              kind: "cookie",
              cookie,
              csrfToken: csrfToken || undefined,
              csrfHeaderName,
              userAgent: userAgent || undefined,
            }
          : { kind: "official-api", accessToken },
      );
      setCookie("");
      setCsrfToken("");
      setAccessToken("");
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async () => {
    try {
      setBusy("test");
      await api.testConnection(account.id, providerKind);
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    try {
      setBusy("sync");
      setSyncResult(await api.syncReadOnly(account.id, providerKind));
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const deleteCredential = async () => {
    if (!window.confirm("确定删除本机加密凭据吗？接入参数会保留。")) return;
    try {
      setBusy("delete");
      await api.deleteCredential(account.id, providerKind);
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const forms = (
    <div className="connection-columns">
      <form className="panel form-panel" onSubmit={(event) => void saveSettings(event)}>
        <div className="panel-heading">
          <div>
            <span className="panel-icon"><Link2 size={18} /></span>
            <div>
              <h2>接入参数</h2>
              <p>非敏感参数保存在本地 SQLite。</p>
            </div>
          </div>
        </div>
        {providerKind === "cookie" ? (
          <div className="form-grid single-column">
            <ConnectionField label="Advertiser ID">
              <input value={cookieSettings.advertiserId} onChange={(event) => setCookieSettings({ ...cookieSettings, advertiserId: event.target.value })} />
            </ConnectionField>
            <ConnectionField label="连接检测 URL">
              <input placeholder="https://ads.tiktok.com/..." value={cookieSettings.healthUrl} onChange={(event) => setCookieSettings({ ...cookieSettings, healthUrl: event.target.value })} />
            </ConnectionField>
            <ConnectionField label="系列只读 URL（可选）">
              <input value={cookieSettings.campaignsUrl} onChange={(event) => setCookieSettings({ ...cookieSettings, campaignsUrl: event.target.value })} />
            </ConnectionField>
            <ConnectionField label="广告组只读 URL（可选）">
              <input value={cookieSettings.adGroupsUrl} onChange={(event) => setCookieSettings({ ...cookieSettings, adGroupsUrl: event.target.value })} />
            </ConnectionField>
            <ConnectionField label="广告只读 URL（可选）">
              <input value={cookieSettings.adsUrl} onChange={(event) => setCookieSettings({ ...cookieSettings, adsUrl: event.target.value })} />
            </ConnectionField>
          </div>
        ) : (
          <div className="form-grid single-column">
            <ConnectionField label="Advertiser ID">
              <input value={apiSettings.advertiserId} onChange={(event) => setApiSettings({ ...apiSettings, advertiserId: event.target.value })} />
            </ConnectionField>
            <div className="provider-endpoint-note">
              官方端点固定使用 business-api.tiktok.com/open_api/v1.3，无需手动填写。
            </div>
          </div>
        )}
        <div className="form-actions">
          <button className="primary-button" disabled={busy !== null} type="submit">
            <Save size={17} /> {busy === "settings" ? "保存中…" : "保存接入参数"}
          </button>
        </div>
      </form>

      <div className="panel form-panel">
        <div className="panel-heading">
          <div>
            <span className="panel-icon"><KeyRound size={18} /></span>
            <div>
              <h2>加密凭据</h2>
              <p>使用 Windows 当前用户 DPAPI 加密。</p>
            </div>
          </div>
        </div>
        {providerKind === "cookie" ? (
          <div className="form-grid single-column">
            <ConnectionField label="Cookie">
              <textarea rows={5} value={cookie} onChange={(event) => setCookie(event.target.value)} placeholder="仅粘贴本人或已授权账户的 Cookie" />
            </ConnectionField>
            <ConnectionField label="CSRF Token（可选）">
              <input value={csrfToken} onChange={(event) => setCsrfToken(event.target.value)} />
            </ConnectionField>
            <ConnectionField label="CSRF 请求头名称">
              <input value={csrfHeaderName} onChange={(event) => setCsrfHeaderName(event.target.value)} />
            </ConnectionField>
            <ConnectionField label="User-Agent（可选）">
              <input value={userAgent} onChange={(event) => setUserAgent(event.target.value)} />
            </ConnectionField>
          </div>
        ) : (
          <div className="form-grid single-column">
            <ConnectionField label="长期 Access Token">
              <textarea rows={5} value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder="不要填写 App Secret" />
            </ConnectionField>
          </div>
        )}
        <div className="form-actions split-actions">
          {connection?.hasCredential && (
            <button className="danger-button" disabled={busy !== null} onClick={() => void deleteCredential()} type="button">
              <Trash2 size={16} /> 删除凭据
            </button>
          )}
          <button
            className="primary-button"
            disabled={busy !== null || (providerKind === "cookie" ? cookie.length < 10 : accessToken.length < 10)}
            onClick={() => void saveCredential()}
            type="button"
          >
            <Save size={17} /> {busy === "credential" ? "加密中…" : connection?.hasCredential ? "覆盖保存凭据" : "加密保存凭据"}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <section className="page-stack">
      <div className="provider-tabs">
        <button className={providerKind === "cookie" ? "active" : ""} onClick={() => setProviderKind("cookie")} type="button">
          <KeyRound size={18} /> Cookie 会话
        </button>
        <button className={providerKind === "official-api" ? "active" : ""} onClick={() => setProviderKind("official-api")} type="button">
          <ShieldCheck size={18} /> Marketing API
        </button>
      </div>

      {providerKind === "cookie" && (
        <div className="quick-import panel">
          <div className="quick-import-heading">
            <span className="quick-import-icon"><Sparkles size={21} /></span>
            <div>
              <span className="eyebrow">最快接入 · {readiness.completedSteps}/2</span>
              <h2>分两步导入 Cookie 请求</h2>
              <p>每一步使用独立输入框并校验请求类型，避免列表请求和启停请求混淆。</p>
            </div>
          </div>
          <div className="cookie-import-steps">
            <article className={`cookie-import-step ${readiness.dataRequestImported ? "complete" : ""}`}>
              <header>
                <span className="cookie-step-number">{readiness.dataRequestImported ? "✓" : "1"}</span>
                <div>
                  <span className="eyebrow">第 1 步 · 读取数据</span>
                  <h3>导入广告组列表 cURL</h3>
                </div>
                <strong className="cookie-step-state">{readiness.dataRequestImported ? "已完成" : "未完成"}</strong>
              </header>
              <p>在 TikTok Ads 的 Network 左上角 Filter 搜索以下内容，刷新广告组页面后复制对应请求。</p>
              <div className="network-filter-row">
                <span>Network 搜索内容</span>
                <button
                  aria-label="复制过滤词 /adgroup/list/?"
                  className={copiedFilter === "/adgroup/list/?" ? "copied" : ""}
                  onClick={() => void copyNetworkFilter("/adgroup/list/?")}
                  type="button"
                >
                  <code>/adgroup/list/?</code>
                  {copiedFilter === "/adgroup/list/?" ? <CheckCircle2 size={15} /> : <Copy size={15} />}
                  <span>{copiedFilter === "/adgroup/list/?" ? "已复制" : "复制"}</span>
                </button>
              </div>
              <textarea
                aria-label="第 1 步列表 cURL"
                className="curl-input"
                onChange={(event) => setReadCurlCommand(event.target.value)}
                placeholder="粘贴 /adgroup/list/? 请求的完整 cURL"
                rows={5}
                spellCheck={false}
                value={readCurlCommand}
              />
              <div className="cookie-step-footer">
                <span>此处只接受 list 列表请求。</span>
                <button className="primary-button" disabled={busy !== null || !readCurlCommand.trim().startsWith("curl")} onClick={() => void importCurl("read")} type="button">
                  <Sparkles size={17} /> {busy === "import-read" ? "正在导入…" : "导入第 1 步"}
                </button>
              </div>
              {importFeedback?.step === "read" && <div className={`import-feedback ${importFeedback.ok ? "" : "error"}`}>{importFeedback.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />} {importFeedback.message}</div>}
            </article>

            <article className={`cookie-import-step ${readiness.statusRequestImported ? "complete" : ""}`}>
              <header>
                <span className="cookie-step-number">{readiness.statusRequestImported ? "✓" : "2"}</span>
                <div>
                  <span className="eyebrow">第 2 步 · 开启和关闭</span>
                  <h3>导入广告启停 cURL</h3>
                </div>
                <strong className="cookie-step-state">{readiness.statusRequestImported ? "已完成" : "未完成"}</strong>
              </header>
              <p>进入广告层级，切换一次测试广告的开关，再在 Network 搜索以下内容并复制新出现的 POST 请求。</p>
              <div className="network-filter-row">
                <span>Network 搜索内容</span>
                <button
                  aria-label="复制过滤词 /ad/update_status/?"
                  className={copiedFilter === "/ad/update_status/?" ? "copied" : ""}
                  onClick={() => void copyNetworkFilter("/ad/update_status/?")}
                  type="button"
                >
                  <code>/ad/update_status/?</code>
                  {copiedFilter === "/ad/update_status/?" ? <CheckCircle2 size={15} /> : <Copy size={15} />}
                  <span>{copiedFilter === "/ad/update_status/?" ? "已复制" : "复制"}</span>
                </button>
              </div>
              <div className="request-contract">
                <strong>第二步请求必须同时满足</strong>
                <span><code>POST /api/v3/i18n/overture/ad/update_status/</code></span>
                <span>Form Data 包含 <code>ad_list</code> 和 <code>operation=enable/disable</code></span>
                <span>必须复制完整 cURL，以保留 Cookie、boundary、aadvid 和签名参数</span>
              </div>
              {!readiness.statusRequestImported && (
                <div className="import-warning compact">
                  <AlertTriangle size={17} />
                  <span>不要复制 list 请求；第 2 步只接受 /ad/update_status/? 的真实启停请求。</span>
                </div>
              )}
              <textarea
                aria-label="第 2 步启停 cURL"
                className="curl-input"
                disabled={!readiness.dataRequestImported}
                onChange={(event) => setStatusCurlCommand(event.target.value)}
                placeholder={readiness.dataRequestImported ? "粘贴 /ad/update_status/? 请求的完整 cURL" : "请先完成第 1 步"}
                rows={5}
                spellCheck={false}
                value={statusCurlCommand}
              />
              <div className="cookie-step-footer">
                <span>此处只接受 update_status 启停请求。</span>
                <button className="primary-button" disabled={busy !== null || !readiness.dataRequestImported || !statusCurlCommand.trim().startsWith("curl")} onClick={() => void importCurl("status")} type="button">
                  <Sparkles size={17} /> {busy === "import-status" ? "正在导入…" : "导入第 2 步"}
                </button>
              </div>
              {importFeedback?.step === "status" && <div className={`import-feedback ${importFeedback.ok ? "" : "error"}`}>{importFeedback.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />} {importFeedback.message}</div>}
            </article>
          </div>
          <div className="quick-import-security">完整请求仅进入本机 DPAPI 加密保险库，不写入 SQLite 明文。</div>
          {readiness.completedSteps === 2 && (
            <div className="import-feedback"><CheckCircle2 size={17} /> Cookie 接入完成，三个层级的启停模板均已就绪。</div>
          )}
        </div>
      )}

      <div className="connection-summary panel">
        <div>
          <span className={`connection-state ${displayedConnectionStatus}`} />
          <div>
            <span className="eyebrow">完整接入状态</span>
            <h2>{displayedConnectionLabel}</h2>
            <p>{displayedConnectionMessage}</p>
          </div>
        </div>
        <div className="connection-actions">
          <button className="secondary-button" disabled={!connection?.hasCredential || busy !== null} onClick={() => void testConnection()} type="button">
            <Link2 size={17} /> {busy === "test" ? "检测中…" : "连接检测"}
          </button>
          <button className="primary-button" disabled={connection?.status !== "ready" || busy !== null} onClick={() => void sync()} type="button">
            <CloudDownload size={17} /> {busy === "sync" ? "同步中…" : "只读同步"}
          </button>
        </div>
      </div>

      {providerKind === "cookie" ? (
        <details className="advanced-connection panel">
          <summary><ChevronDown size={18} /><span><strong>高级手动接入</strong><small>仅在快速导入无法识别时使用</small></span></summary>
          <div className="advanced-connection-content">{forms}</div>
        </details>
      ) : forms}

      {syncResult && (
        <div className="sync-result panel">
          <CheckCircle2 size={22} />
          <div>
            <h3>只读同步完成</h3>
            <p>系列 {syncResult.counts.campaign} · 广告组 {syncResult.counts["ad-group"]} · 广告 {syncResult.counts.ad}</p>
            {syncResult.warnings.map((warning) => <span key={warning}>{warning}</span>)}
          </div>
        </div>
      )}
    </section>
  );
}

function ConnectionField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function connectionStatusLabel(status?: ProviderConnection["status"]): string {
  return {
    "not-configured": "尚未配置",
    untested: "等待检测",
    ready: "连接正常",
    failed: "连接失败",
  }[status ?? "not-configured"];
}

function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "发生未知错误。";
}
