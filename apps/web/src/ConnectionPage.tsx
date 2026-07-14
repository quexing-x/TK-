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
import { describeCookieCoverage } from "./cookie-coverage.js";

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
  const readCoverageComplete = readiness.readTargets.length === 3;
  const readCoveragePartial =
    readiness.readTargets.length > 0 && !readCoverageComplete;
  const cookieCoverage = describeCookieCoverage(readiness);
  const verifiedCookieTargets = (["campaign", "ad-group", "ad"] as const).filter(
    (target) =>
      readiness.readTargets.includes(target) &&
      readiness.statusTargets.includes(target),
  );
  const cookieLayerCoverageIncomplete =
    providerKind === "cookie" &&
    readiness.statusTargets.length > 0 &&
    verifiedCookieTargets.length < 3;
  const cookieOnboardingIncomplete =
    providerKind === "cookie" &&
    (readiness.completedSteps < 2 || cookieLayerCoverageIncomplete);
  const displayedConnectionStatus = cookieOnboardingIncomplete
    ? "untested"
    : (connection?.status ?? "not-configured");
  const displayedConnectionLabel = cookieLayerCoverageIncomplete
    ? `层级未完成（${verifiedCookieTargets.length}/3）`
    : cookieOnboardingIncomplete
      ? `接入未完成（${readiness.completedSteps}/2）`
    : providerKind === "cookie" && connection?.status === "ready"
      ? "完整接入完成"
      : connectionStatusLabel(connection?.status);
  const displayedConnectionMessage = cookieLayerCoverageIncomplete
    ? `${cookieCoverage.message}${connection?.lastMessage ? ` ${connection.lastMessage}` : ""}`
    : cookieOnboardingIncomplete
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
              <span className="eyebrow">完整层级 · {verifiedCookieTargets.length}/3</span>
              <h2>分两类导入 Cookie 请求</h2>
              <p>读取数据与启停请求分别校验；三个层级都具备读取和启停能力后，才算完整接入。</p>
            </div>
          </div>
          <div className="cookie-import-steps">
            <article className={`cookie-import-step ${readCoverageComplete ? "complete" : readCoveragePartial ? "partial" : ""}`}>
              <header>
                <span className="cookie-step-number">{readCoverageComplete ? "✓" : "1"}</span>
                <div>
                  <span className="eyebrow">第 1 类 · 读取数据</span>
                  <h3>导入真实列表 cURL</h3>
                </div>
                <strong className="cookie-step-state">
                  {readCoverageComplete
                    ? "完成 3/3"
                    : readCoveragePartial
                      ? `部分完成 ${readiness.readTargets.length}/3`
                      : "未完成"}
                </strong>
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
              {readCoveragePartial && (
                <div className="network-filter-row">
                  <span>最终广告列表候选</span>
                  <button
                    aria-label="复制过滤词 list"
                    className={copiedFilter === "list" ? "copied" : ""}
                    onClick={() => void copyNetworkFilter("list")}
                    type="button"
                  >
                    <code>list</code>
                    {copiedFilter === "list" ? <CheckCircle2 size={15} /> : <Copy size={15} />}
                    <span>{copiedFilter === "list" ? "已复制" : "复制"}</span>
                  </button>
                </div>
              )}
              <textarea
                aria-label="第 1 步列表 cURL"
                className="curl-input"
                onChange={(event) => setReadCurlCommand(event.target.value)}
                placeholder={readCoveragePartial ? "继续粘贴最终广告层的真实列表 cURL" : "粘贴 /adgroup/list/? 请求的完整 cURL"}
                rows={5}
                spellCheck={false}
                value={readCurlCommand}
              />
              <div className="cookie-step-footer">
                <span>此处只接受 list 列表请求。</span>
                <button className="primary-button" disabled={busy !== null || !readCurlCommand.trim().startsWith("curl")} onClick={() => void importCurl("read")} type="button">
                  <Sparkles size={17} /> {busy === "import-read" ? "正在导入…" : readCoveragePartial ? "补充读取请求" : "导入第 1 类"}
                </button>
              </div>
              {importFeedback?.step === "read" && <div className={`import-feedback ${importFeedback.ok ? "" : "error"}`}>{importFeedback.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />} {importFeedback.message}</div>}
              {readCoveragePartial && (
                <div className="import-warning compact">
                  <AlertTriangle size={17} />
                  <span>最终广告启停已接入，但列表数据仍缺失。进入最终“广告”页面，在 Network 搜索 <code>list</code> 并刷新；选择 Response 中含单条广告名称或广告 ID 的真实列表请求，复制完整 cURL 后粘贴到上方继续导入。</span>
                </div>
              )}
            </article>

            <article className={`cookie-import-step ${readiness.statusRequestImported ? "complete" : ""}`}>
              <header>
                <span className="cookie-step-number">{readiness.statusRequestImported ? "✓" : "2"}</span>
                <div>
                  <span className="eyebrow">第 2 类 · 开启和关闭</span>
                  <h3>导入真实启停 cURL</h3>
                </div>
                <strong className="cookie-step-state">
                  {readiness.statusRequestImported
                    ? "已完成"
                    : readiness.statusTargets.length > 0
                      ? `部分完成 ${readiness.statusTargets.length}/3`
                      : "未完成"}
                </strong>
              </header>
              <p>广告组与最终广告各需要一条真实启停请求；两条请求都粘贴到同一个输入框，程序按真实路径自动合并层级能力。</p>
              <div className="network-filter-row">
                <span>广告组搜索内容</span>
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
              <div className="network-filter-row">
                <span>最终广告搜索内容</span>
                <button
                  aria-label="复制过滤词 /creative/update_status/?"
                  className={copiedFilter === "/creative/update_status/?" ? "copied" : ""}
                  onClick={() => void copyNetworkFilter("/creative/update_status/?")}
                  type="button"
                >
                  <code>/creative/update_status/?</code>
                  {copiedFilter === "/creative/update_status/?" ? <CheckCircle2 size={15} /> : <Copy size={15} />}
                  <span>{copiedFilter === "/creative/update_status/?" ? "已复制" : "复制"}</span>
                </button>
              </div>
              <div className="request-contract">
                <strong>已确认的两种真实启停请求</strong>
                <span>广告组：<code>POST /api/v3/i18n/overture/ad/update_status/</code>，包含 <code>ad_list</code></span>
                <span>最终广告：<code>POST /api/v2/i18n/overture/creative/update_status/</code>，包含 <code>creative_list</code> 与 <code>aco_creative_list</code></span>
                <span>两者都必须包含 <code>operation=enable/disable</code></span>
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
              {readiness.statusTargets.length > 0 && !readiness.statusRequestImported && (
                <div className="import-warning compact">
                  <AlertTriangle size={17} />
                  <span>已确认广告系列和广告组启停；最终广告层请求尚未导入，因此完整接入仍未完成。</span>
                </div>
              )}
            </article>
          </div>
          <div className="quick-import-security">完整请求仅进入本机 DPAPI 加密保险库，不写入 SQLite 明文。</div>
          {readiness.statusRequestImported && (
            <div className="import-feedback"><CheckCircle2 size={17} /> 三个层级的启停模板均已就绪；读取数据当前覆盖 {readiness.readTargets.length}/3，补齐最终广告列表后才是完整接入。</div>
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
