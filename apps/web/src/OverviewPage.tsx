import {
  Activity,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Link2,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from "./ui/icons";
import type { ReactNode } from "react";
import type { AccountConfig, SystemRuntimeState } from "@tk-auto/core";
import type { BootstrapPayload } from "./api";

type OverviewDestination = "ads";

/**
 * The overview intentionally stays connection-only. Metrics, decisions and
 * operations belong to the TikTok modules.
 */
export function OverviewPage({
  accounts,
  connectionStates,
  runtime,
  onNavigate,
  children,
}: {
  accounts: AccountConfig[];
  connectionStates: BootstrapPayload["accountConnectionStates"];
  runtime: SystemRuntimeState;
  onNavigate: (destination: OverviewDestination) => void;
  children?: ReactNode;
}) {
  const stateByAccountId = new Map(connectionStates.map((state) => [state.accountId, state]));
  const groups = [
    {
      key: "tiktok" as const,
      title: "TikTok 接入",
      description: "Cookie / Marketing API 账户连接与能力",
      accounts: accounts.filter((account) => account.platform === "tiktok"),
      action: () => onNavigate("ads"),
      actionLabel: "进入 TikTok 广告管理",
    },
  ];

  return (
    <section className="overview-page connection-overview-page">
      <section className="overview-runtime-strip connection-runtime-strip" aria-label="本地运行状态">
        <div className={`runtime-orbit ${runtime.enabled ? "active" : "paused"}`}>
          <Activity size={30} strokeWidth={1.8} />
        </div>
        <div className="runtime-copy">
          <span className="section-kicker">CONNECTION OVERVIEW</span>
          <h2>平台接入总览</h2>
          <p>这里只展示账户连接、权限与自动化开关。</p>
        </div>
        <div className={`runtime-state-card ${runtime.enabled ? "active" : "paused"}`}>
          <span>全局自动化</span>
          <strong><i />{runtime.enabled ? "运行中" : "已暂停"}</strong>
          <small>平台规则仍由各自模块独立控制</small>
        </div>
      </section>

      <section className="connection-overview-heading">
        <div>
          <span className="section-kicker">PLATFORM ACCESS</span>
          <h2>接入状态</h2>
          <p>先在这里确认连接是否正常，再进入对应平台处理广告对象和规则。</p>
        </div>
        <div className="connection-overview-legend" aria-label="接入状态图例">
          <span><i className="healthy" />健康</span>
          <span><i className="warning" />待完善</span>
          <span><i className="danger" />异常</span>
        </div>
      </section>

      <div className="platform-access-grid">
        {groups.map((group) => {
          const readyCount = group.accounts.filter((account) => {
            const state = stateByAccountId.get(account.id);
            return connectionOverviewStatus(state).tone === "healthy";
          }).length;
          return (
            <article className={`platform-access-card platform-${group.key}`} key={group.key}>
              <header>
                <div className="platform-access-icon"><ShieldCheck size={19} /></div>
                <div><h3>{group.title}</h3><p>{group.description}</p></div>
                <span className="platform-access-count">{readyCount}/{group.accounts.length} 正常</span>
              </header>
              <div className="platform-access-list">
                {group.accounts.length === 0 ? (
                  <div className="platform-access-empty"><CircleAlert size={16} /><span>暂无已建立的 TikTok 账户接入</span></div>
                ) : group.accounts.map((account) => {
                  const state = stateByAccountId.get(account.id);
                  const access = connectionOverviewStatus(state);
                  return (
                    <div className="platform-access-row" key={account.id}>
                      <div className="platform-access-account"><strong>{account.displayName}</strong><small>{account.providerKind === "cookie" ? "Cookie 会话" : "官方 API"}</small></div>
                      <span className={`status ${access.tone === "healthy" ? "active" : access.tone === "danger" ? "danger" : "warning"}`}><i />{access.label}</span>
                      <span className="platform-access-detail">{account.enabled ? "自动化已开启" : "自动化未开启"}</span>
                      {access.tone !== "healthy" && <small className="platform-access-blocker" title={access.blocker}>{access.blocker}</small>}
                    </div>
                  );
                })}
              </div>
              <footer><button className="icon-text-link" type="button" onClick={group.action}>{group.actionLabel}<ArrowRight size={14} /></button></footer>
            </article>
          );
        })}
      </div>

      <section className="overview-account-section connection-account-section" id="account-management-overview">
        <header className="account-section-heading">
          <div><span className="section-kicker">ACCOUNT ACCESS</span><h2>账户接入与权限</h2></div>
          <p><Users size={15} /> 凭据、账户绑定和能力检测统一在这里管理；广告数据请进入对应平台模块。</p>
        </header>
        {children}
      </section>

    </section>
  );
}

function connectionOverviewStatus(
  state: BootstrapPayload["accountConnectionStates"][number] | undefined,
): { tone: "healthy" | "warning" | "danger"; label: "正常" | "待检测" | "异常"; blocker: string } {
  const connection = state?.connection;
  if (!connection) return { tone: "danger", label: "异常", blocker: "尚未建立账户接入。" };
  const authorizationFailed = ["expired", "revoked", "failed"].includes(
    state.capabilities.authorizationStatus,
  );
  if (connection.status === "ready" && state.capabilities.authorizationStatus === "active") {
    return { tone: "healthy", label: "正常", blocker: "" };
  }
  if (connection.status === "failed" || authorizationFailed) {
    return { tone: "danger", label: "异常", blocker: connection.lastMessage || "账户授权失败，请重新检测。" };
  }
  return {
    tone: "warning",
    label: "待检测",
    blocker: connection.hasCredential ? "凭据已保存，请检测连接。" : "尚未保存接入凭据。",
  };
}
