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
  const [curlCommand, setCurlCommand] = useState("");
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
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

  const importCurl = async () => {
    try {
      setBusy("import");
      setImportFeedback(null);
      const result = await api.importCookieCurl(account.id, curlCommand.trim());
      setCurlCommand("");
      setImportFeedback(
        result.lastMessage ?? "请求已加密保存，请查看连接状态。",
      );
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
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
              <h2>同一个输入框，两条 cURL 完成 Cookie 接入</h2>
              <p>不需要选择广告层级；完成后默认具备系列、广告组和广告三级管理能力。</p>
            </div>
          </div>
          <ol className="quick-import-steps">
            <li className={readiness.dataRequestImported ? "complete" : ""}>
              <strong>{readiness.dataRequestImported ? "已完成" : "第 1 条"}</strong>
              复制一条广告组列表 cURL，用于 Cookie、账户和数据读取
            </li>
            <li className={readiness.statusRequestImported ? "complete" : ""}>
              <strong>{readiness.statusRequestImported ? "已完成" : "第 2 条"}</strong>
              任意切换一次测试对象，复制真实开关 cURL；自动扩展全部三级启停
            </li>
          </ol>
          <div className="network-filter-guide">
            <div>
              <strong>第 1 条列表请求过滤词</strong>
              <span>在 Network 左上角 Filter 中粘贴；第一项没有结果时再用第二项。</span>
            </div>
            <div className="network-filter-buttons">
              {["/adgroup/list/?", "/campaign/list/?"].map((value) => (
                <button
                  aria-label={`复制过滤词 ${value}`}
                  className={copiedFilter === value ? "copied" : ""}
                  key={value}
                  onClick={() => void copyNetworkFilter(value)}
                  type="button"
                >
                  <code>{value}</code>
                  {copiedFilter === value ? <CheckCircle2 size={15} /> : <Copy size={15} />}
                  <span>{copiedFilter === value ? "已复制" : "复制"}</span>
                </button>
              ))}
            </div>
          </div>
          {readiness.dataRequestImported && !readiness.statusRequestImported && (
            <div className="import-warning">
              <AlertTriangle size={18} />
              <div>
                <strong>当前只完成了读取接入，启停功能还未接入。</strong>
                <span>第二条不要再复制 list 请求；请在 TikTok 中切换一次测试对象，再复制包含 update 或 status 的真实 POST 请求。</span>
              </div>
            </div>
          )}
          <textarea
            aria-label="cURL 命令"
            className="curl-input"
            onChange={(event) => setCurlCommand(event.target.value)}
            placeholder="curl 'https://ads.tiktok.com/...' ..."
            rows={7}
            spellCheck={false}
            value={curlCommand}
          />
          <div className="quick-import-footer">
            <span>完整请求仅进入本机 DPAPI 加密保险库，不写入 SQLite 明文。</span>
            <button className="primary-button" disabled={busy !== null || !curlCommand.trim().startsWith("curl")} onClick={() => void importCurl()} type="button">
              <Sparkles size={17} /> {busy === "import" ? "正在导入检测…" : "加密导入并检测"}
            </button>
          </div>
          {importFeedback && <div className="import-feedback"><CheckCircle2 size={17} /> {importFeedback}</div>}
          {readiness.completedSteps === 2 && (
            <div className="import-feedback"><CheckCircle2 size={17} /> Cookie 接入完成，三个层级的启停模板均已就绪。</div>
          )}
        </div>
      )}

      <div className="connection-summary panel">
        <div>
          <span className={`connection-state ${connection?.status ?? "not-configured"}`} />
          <div>
            <span className="eyebrow">当前状态</span>
            <h2>{connectionStatusLabel(connection?.status)}</h2>
            <p>{connection?.lastMessage ?? "尚未保存此 Provider 的接入参数。"}</p>
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
