import {
  AlertTriangle,
  CheckCircle2,
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
  OfficialApiConnectionSettings,
  ProviderConnection,
  ProviderKind,
} from "@tk-auto/core";
import { api } from "./api";

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
      const [list, nextReadiness] = await Promise.all([
        api.getConnections(account.id),
        api.getCookieReadiness(account.id),
      ]);
      setConnections(list);
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
  const cookieState = describeCookieState(readiness, connection);

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
      if (readCurlCommand.trim()) {
        result = await api.importCookieCurl(
          account.id,
          readCurlCommand.trim(),
          "read",
        );
        setReadCurlCommand("");
        await load();
      }
      if (statusCurlCommand.trim()) {
        result = await api.importCookieCurl(
          account.id,
          statusCurlCommand.trim(),
          "status",
        );
        setStatusCurlCommand("");
      }
      await load();
      setImportFeedback({
        ok: result?.status === "ready",
        message:
          result?.status === "ready"
            ? "两段 cURL 已解码并加密保存，必要字段与启停能力均已建立。"
            : result?.lastMessage ?? "字段已保存，但当前连接异常。",
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
      await load();
    } catch (cause) {
      onError(getErrorMessage(cause));
      await load();
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

  return (
    <section className="page-stack">
      <div className="provider-tabs">
        <button
          className={providerKind === "cookie" ? "active" : ""}
          onClick={() => setProviderKind("cookie")}
          type="button"
        >
          <KeyRound size={18} /> Cookie 会话
        </button>
        <button
          className={providerKind === "official-api" ? "active" : ""}
          onClick={() => setProviderKind("official-api")}
          type="button"
        >
          <ShieldCheck size={18} /> Marketing API
        </button>
      </div>

      {providerKind === "cookie" ? (
        <>
          <div className="quick-import panel">
            <div className="quick-import-heading">
              <span className="quick-import-icon"><Sparkles size={21} /></span>
              <div>
                <span className="eyebrow">最少操作 · 两段 cURL</span>
                <h2>导入 Cookie 接入信息</h2>
                <p>程序只提取并加密保存必要字段，不显示 Cookie、Token 或完整请求内容。</p>
              </div>
            </div>

            <div className="cookie-import-steps">
              <CurlStep
                complete={readiness.dataRequestImported}
                copiedFilter={copiedFilter}
                filter="/adgroup/list/?"
                label="第 1 段 · 获取账户数据"
                onCopy={copyNetworkFilter}
                reminder="进入广告组页面后刷新，选择最后一条成功请求，再右键 Copy → Copy as cURL (bash)。"
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
                complete={readiness.statusRequestImported}
                copiedFilter={copiedFilter}
                filter="/ad/update_status/?"
                label="第 2 段 · 获取启停能力"
                onCopy={copyNetworkFilter}
                reminder="切换任意一条测试广告的开关，选择刚出现的 POST 请求，再右键 Copy → Copy as cURL (bash)。完成后可把测试广告恢复原状态。"
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
              <span>两段内容会在本机解码，并通过 Windows DPAPI 加密保存。</span>
              <button
                className="primary-button"
                disabled={
                  busy !== null ||
                  (!readCurlCommand.trim() && !statusCurlCommand.trim()) ||
                  (Boolean(readCurlCommand.trim()) &&
                    !readCurlCommand.trim().startsWith("curl")) ||
                  (Boolean(statusCurlCommand.trim()) &&
                    !statusCurlCommand.trim().startsWith("curl")) ||
                  (!readiness.dataRequestImported &&
                    !readCurlCommand.trim().startsWith("curl")) ||
                  (!readiness.statusRequestImported &&
                    !statusCurlCommand.trim().startsWith("curl"))
                }
                onClick={() => void importBothCurls()}
                type="button"
              >
                <Sparkles size={17} />
                {busy === "import" ? "正在导入…" : "导入并检查"}
              </button>
            </div>

            {importFeedback && (
              <div className={`import-feedback ${importFeedback.ok ? "" : "error"}`}>
                {importFeedback.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
                {importFeedback.message}
              </div>
            )}

            <div className="required-field-panel">
              <div>
                <strong>必要字段</strong>
                <span>{readiness.completedFields}/{readiness.totalFields} 已获取</span>
              </div>
              <div className="required-field-grid">
                {requiredFieldLabels.map(([key, label]) => (
                  <span
                    className={readiness.requiredFields[key] ? "complete" : ""}
                    key={key}
                  >
                    {readiness.requiredFields[key]
                      ? <CheckCircle2 size={15} />
                      : <AlertTriangle size={15} />}
                    {label}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="connection-summary panel">
            <div>
              <span className={`connection-state ${cookieState.status}`} />
              <div>
                <span className="eyebrow">实时接入状态</span>
                <h2>{cookieState.label}</h2>
                <p>{cookieState.message}</p>
              </div>
            </div>
            {connection?.hasCredential && (
              <button
                className="danger-button"
                disabled={busy !== null}
                onClick={() => void deleteCredential()}
                type="button"
              >
                <Trash2 size={16} /> 删除本机凭据
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="connection-columns">
            <form className="panel form-panel" onSubmit={(event) => void saveApiSettings(event)}>
              <div className="panel-heading">
                <div>
                  <span className="panel-icon"><Link2 size={18} /></span>
                  <div>
                    <h2>Marketing API 接入参数</h2>
                    <p>非敏感参数保存在本地 SQLite。</p>
                  </div>
                </div>
              </div>
              <div className="form-grid single-column">
                <ConnectionField label="Advertiser ID">
                  <input
                    onChange={(event) => setApiSettings({ ...apiSettings, advertiserId: event.target.value })}
                    value={apiSettings.advertiserId}
                  />
                </ConnectionField>
                <div className="provider-endpoint-note">
                  官方端点固定使用 business-api.tiktok.com/open_api/v1.3，无需手动填写。
                </div>
              </div>
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
                    <h2>Access Token</h2>
                    <p>使用 Windows 当前用户 DPAPI 加密；保存后自动验证权限。</p>
                  </div>
                </div>
              </div>
              <div className="form-grid single-column">
                <ConnectionField label="长期 Access Token">
                  <textarea
                    onChange={(event) => setAccessToken(event.target.value)}
                    placeholder="不要填写 App Secret"
                    rows={5}
                    value={accessToken}
                  />
                </ConnectionField>
              </div>
              <div className="form-actions split-actions">
                {connection?.hasCredential && (
                  <button
                    className="danger-button"
                    disabled={busy !== null}
                    onClick={() => void deleteCredential()}
                    type="button"
                  >
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

          <div className="connection-summary panel">
            <div>
              <span className={`connection-state ${connection?.status ?? "not-configured"}`} />
              <div>
                <span className="eyebrow">Marketing API 状态</span>
                <h2>{connectionStatusLabel(connection?.status)}</h2>
                <p>{connection?.lastMessage ?? "尚未保存 Marketing API 接入参数。"}</p>
              </div>
            </div>
          </div>
        </>
      )}
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
  title,
  children,
}: {
  complete: boolean;
  copiedFilter: string | null;
  filter: string;
  label: string;
  onCopy: (value: string) => Promise<void>;
  reminder: string;
  title: string;
  children: React.ReactNode;
}) {
  const copied = copiedFilter === filter;
  return (
    <article className={`cookie-import-step ${complete ? "complete" : ""}`}>
      <header>
        <span className="cookie-step-number">{complete ? "✓" : label.includes("1") ? "1" : "2"}</span>
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

function describeCookieState(
  readiness: CookieConnectionReadiness,
  connection?: ProviderConnection,
) {
  if (!readiness.fieldsComplete) {
    return {
      status: "untested",
      label: `等待导入（${readiness.completedFields}/${readiness.totalFields}）`,
      message: "请粘贴两段完整 cURL；只有五个必要字段全部获取后，才会显示接入正常。",
    };
  }
  if (!readiness.statusRequestImported) {
    return {
      status: "failed",
      label: "启停能力未建立",
      message: "必要字段已获取，但启停请求未能生成完整控制模板，请重新复制 /ad/update_status/? 的 POST cURL。",
    };
  }
  if (connection?.status === "ready") {
    return {
      status: "ready",
      label: "接入正常",
      message: "广告账户可正常读取，系列、广告组和广告的开启与关闭能力均已建立。",
    };
  }
  if (connection?.status === "failed") {
    return {
      status: "failed",
      label: "Cookie 已失效或连接异常",
      message: connection.lastMessage ?? "请重新获取并导入两段 cURL。",
    };
  }
  return {
    status: "untested",
    label: "字段已获取，等待连接结果",
    message: connection?.lastMessage ?? "正在等待本机完成连接状态更新。",
  };
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

function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "发生未知错误。";
}
