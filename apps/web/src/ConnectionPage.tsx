import {
  CheckCircle2,
  ChevronDown,
  CloudDownload,
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
  AutomationAction,
  CookieConnectionSettings,
  OfficialApiConnectionSettings,
  ProviderConnection,
  ProviderKind,
  ReadOnlySyncResult,
  SyncEntityType,
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

export function ConnectionPage({
  account,
  onError,
}: {
  account: AccountConfig;
  onError: (message: string | null) => void;
}) {
  const [providerKind, setProviderKind] = useState<ProviderKind>("cookie");
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
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
  const [statusCurlCommand, setStatusCurlCommand] = useState("");
  const [statusEntityType, setStatusEntityType] =
    useState<SyncEntityType>("campaign");
  const [statusAction, setStatusAction] =
    useState<AutomationAction>("disable");
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<ReadOnlySyncResult | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.getConnections(account.id);
      setConnections(list);
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
        result.status === "ready"
          ? "导入完成，Cookie 连接检测已通过。"
          : (result.lastMessage ?? "请求已加密保存，请查看连接状态。"),
      );
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const importStatusCurl = async () => {
    try {
      setBusy("status-import");
      setImportFeedback(null);
      await api.importCookieStatusCurl(
        account.id,
        statusCurlCommand.trim(),
        statusEntityType,
        statusAction,
      );
      setStatusCurlCommand("");
      setImportFeedback(
        `已加密保存${entityTypeLabel(statusEntityType)}${statusAction === "enable" ? "开启" : "关闭"}模板。`,
      );
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
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
              <span className="eyebrow">推荐方式 · 一次复制</span>
              <h2>粘贴 cURL，自动导入并检测</h2>
              <p>自动识别账号、POST/GET、Payload、Cookie 与 CSRF Token。</p>
            </div>
          </div>
          <ol className="quick-import-steps">
            <li>在 Network 中选中广告系列、广告组或广告列表请求</li>
            <li>右键该请求，选择 Copy → Copy as cURL (bash)</li>
            <li>粘贴到下面并点击“加密导入并检测”</li>
          </ol>
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
        </div>
      )}

      {providerKind === "cookie" && (
        <details className="advanced-connection panel status-template-import">
          <summary>
            <ChevronDown size={18} />
            <span>
              <strong>导入真实启停请求</strong>
              <small>全自动或人工确认执行前，需要为使用的层级分别导入开启和关闭 cURL</small>
            </span>
          </summary>
          <div className="advanced-connection-content">
            <div className="form-grid">
              <ConnectionField label="对象层级">
                <select
                  value={statusEntityType}
                  onChange={(event) =>
                    setStatusEntityType(event.target.value as SyncEntityType)
                  }
                >
                  <option value="campaign">广告系列</option>
                  <option value="ad-group">广告组</option>
                  <option value="ad">广告</option>
                </select>
              </ConnectionField>
              <ConnectionField label="请求动作">
                <select
                  value={statusAction}
                  onChange={(event) =>
                    setStatusAction(event.target.value as AutomationAction)
                  }
                >
                  <option value="disable">关闭</option>
                  <option value="enable">开启</option>
                </select>
              </ConnectionField>
            </div>
            <ol className="quick-import-steps">
              <li>在 TikTok Ads 页面手动切换一个测试对象的开关。</li>
              <li>Network 中筛选 update 或 status，复制对应请求为 cURL (bash)。</li>
              <li>选择相同层级和动作后粘贴；程序执行时只替换对象 ID，其余参数沿用真实请求。</li>
            </ol>
            <textarea
              className="curl-input"
              onChange={(event) => setStatusCurlCommand(event.target.value)}
              placeholder="curl 'https://ads.tiktok.com/.../update_status/...' ..."
              rows={7}
              spellCheck={false}
              value={statusCurlCommand}
            />
            <div className="quick-import-footer">
              <span>请求模板与 Cookie 一起使用 Windows DPAPI 加密，不写入 SQLite 明文。</span>
              <button
                className="primary-button"
                disabled={
                  busy !== null || !statusCurlCommand.trim().startsWith("curl")
                }
                onClick={() => void importStatusCurl()}
                type="button"
              >
                <Sparkles size={17} />
                {busy === "status-import" ? "导入中…" : "加密导入状态模板"}
              </button>
            </div>
          </div>
        </details>
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

function entityTypeLabel(entityType: SyncEntityType): string {
  return { campaign: "广告系列", "ad-group": "广告组", ad: "广告" }[
    entityType
  ];
}
