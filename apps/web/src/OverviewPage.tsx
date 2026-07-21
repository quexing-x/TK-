import {
  Activity,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  CircleGauge,
  Database,
  Plus,
  Radio,
  ShieldCheck,
  Users,
  Zap,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type {
  AccountConfig,
  AdOperationRecord,
  AutomationApprovalRecord,
  AutomationDecisionRecord,
  ManagedEntityRecord,
  SystemRuntimeState,
} from "@tk-auto/core";
import { api, type BootstrapPayload } from "./api";
import { selectPendingAutomationDecisions } from "./automation-decision-view";
import { hasProviderCapability } from "./provider-capability-view";

type OverviewDestination = "launch" | "ads" | "tasks" | "users";

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
  const [decisions, setDecisions] = useState<AutomationDecisionRecord[]>([]);
  const [approvals, setApprovals] = useState<AutomationApprovalRecord[]>([]);
  const [entities, setEntities] = useState<Array<ManagedEntityRecord & { accountId: string }>>([]);
  const [operations, setOperations] = useState<AdOperationRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const loadDecisions = useCallback(async () => {
    try {
      const results = await Promise.all(
        accounts.map(async (account) => {
          const [nextDecisions, nextApprovals, nextEntities, nextOperations] = await Promise.all([
          api.getAutomationDecisions(account.id).catch(() => []),
          api.getAutomationApprovals(account.id).catch(() => []),
          api.getManagedEntities(account.id).catch(() => []),
          api.getAdOperations(account.id).catch(() => []),
          ]);
          return { accountId: account.id, nextDecisions, nextApprovals, nextEntities, nextOperations };
        }),
      );
      setDecisions(results.flatMap((result) => result.nextDecisions).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setApprovals(results.flatMap((result) => result.nextApprovals));
      setEntities(results.flatMap((result) => result.nextEntities.map((entity) => ({ ...entity, accountId: result.accountId }))));
      setOperations(results.flatMap((result) => result.nextOperations));
    } finally {
      setLoading(false);
    }
  }, [accounts]);

  useEffect(() => {
    void loadDecisions();
  }, [loadDecisions]);

  const readyCount = connectionStates.filter((state) => state.connection?.status === "ready").length;
  const enabledCount = accounts.filter((account) => account.enabled).length;
  const pending = useMemo(() => selectPendingAutomationDecisions({
    decisions,
    approvals,
    entities,
    operations,
    statuses: ["preview", "pending"],
  }), [approvals, decisions, entities, operations]);
  const stream = useMemo(() => decisions.slice(0, 5), [decisions]);
  const accountExceptions = useMemo(() => connectionStates.flatMap((state) => {
    const accountName = accounts.find((account) => account.id === state.accountId)?.displayName ?? "未命名账户";
    const disconnected = state.connection?.status === "failed"
      || ["expired", "revoked", "failed"].includes(state.capabilities.authorizationStatus);
    if (disconnected) return [`${accountName}：账户连接已失效，请重新接入。`];
    if (!hasProviderCapability(state.capabilities, "change-status")) {
      return [`${accountName}：广告启停能力不可用，请重新导入启停请求。`];
    }
    return [];
  }), [accounts, connectionStates]);
  const accountHealth = useMemo(() => accounts.map((account) => {
    const state = connectionStates.find((item) => item.accountId === account.id);
    const disconnected = state?.connection?.status === "failed"
      || (state ? ["expired", "revoked", "failed"].includes(state.capabilities.authorizationStatus) : false);
    const ready = state?.connection?.status === "ready" && !!state && hasProviderCapability(state.capabilities, "change-status");
    return { id: account.id, name: account.displayName, tone: disconnected ? "danger" : ready ? "healthy" : "warning" };
  }), [accounts, connectionStates]);
  const healthyAccountCount = accountHealth.filter((account) => account.tone === "healthy").length;
  const warningAccountCount = accountHealth.filter((account) => account.tone === "warning").length;
  const dangerAccountCount = accountHealth.filter((account) => account.tone === "danger").length;
  const healthyEnd = accounts.length ? (healthyAccountCount / accounts.length) * 360 : 0;
  const warningEnd = accounts.length ? ((healthyAccountCount + warningAccountCount) / accounts.length) * 360 : 0;

  return (
    <section className="overview-page">
      <section className="overview-runtime-strip" aria-label="系统运行概览">
        <div className={`runtime-orbit ${runtime.enabled ? "active" : "paused"}`}>
          <Activity size={36} strokeWidth={1.8} />
        </div>
        <div className="runtime-copy">
          <span className="section-kicker">SYSTEM STATUS</span>
          <h2>{runtime.enabled ? "系统运行中" : "系统已暂停"}</h2>
          <p>{runtime.enabled ? "检测、决策与任务队列正在按既有规则运行" : "所有后台任务与平台写入均已停止"}</p>
        </div>
        <div className="runtime-stat-grid">
          <OverviewStat label="已接入账户" value={String(readyCount)} meta={`共 ${accounts.length} 个`} />
          <OverviewStat label="自动化账户" value={String(enabledCount)} meta="当前启用" />
          <OverviewStat label="待处理决策" value={String(pending.length)} meta="需要确认" tone={pending.length ? "warning" : undefined} />
          <OverviewStat label="累计决策" value={String(decisions.length)} meta="本地可追溯" />
        </div>
        <div className={`runtime-state-card ${runtime.enabled ? "active" : "paused"}`}>
          <span>主控状态</span>
          <strong><i />{runtime.enabled ? "稳定运行" : "安全暂停"}</strong>
          <small>控制入口位于页面右上角</small>
        </div>
      </section>

      {accountExceptions.length > 0 && (
        <section className="overview-exception-bar">
          <div><CircleAlert size={18} /><strong>发现 {accountExceptions.length} 项账户接入异常</strong></div>
          <span>{accountExceptions[0]}</span>
          <button className="text-button" type="button" onClick={() => document.getElementById("account-management")?.scrollIntoView({ behavior: "smooth" })}>
            处理账户 <ArrowRight size={14} />
          </button>
        </section>
      )}

      <section className="overview-workspace-grid">
        <article className="overview-zone account-health-zone">
          <header className="zone-heading">
            <div><h2>账户健康</h2><span>连接与执行能力</span></div>
            <button className="icon-text-link" type="button" onClick={() => document.getElementById("account-management")?.scrollIntoView({ behavior: "smooth" })}>查看详情 <ArrowRight size={14} /></button>
          </header>
          <div className="health-visual">
            <div className="health-ring" style={{ "--healthy-end": `${healthyEnd}deg`, "--warning-end": `${warningEnd}deg` } as CSSProperties}>
              <div><strong>{accounts.length}</strong><span>总账户</span></div>
            </div>
            <div className="health-breakdown">
              <span><i className="healthy" />健康<strong>{healthyAccountCount}</strong></span>
              <span><i className="warning" />待完善<strong>{warningAccountCount}</strong></span>
              <span><i className="danger" />异常<strong>{dangerAccountCount}</strong></span>
            </div>
          </div>
          <div className="account-health-bars" aria-label="账户健康状态">
            {accountHealth.length ? accountHealth.map((account) => (
              <div className="account-health-row" key={account.id}>
                <span title={account.name}>{account.name}</span>
                <i><b className={account.tone} /></i>
                <strong className={account.tone}>{account.tone === "healthy" ? "健康" : account.tone === "danger" ? "异常" : "待完善"}</strong>
              </div>
            )) : <p className="account-health-empty">尚未添加账户</p>}
          </div>
        </article>

        <article className="overview-zone decision-zone">
          <header className="zone-heading">
            <div><h2>待处理决策</h2><span>{pending.length} 项需要确认</span></div>
            <button className="icon-text-link" type="button" onClick={() => onNavigate("ads")}>查看全部 <ArrowRight size={14} /></button>
          </header>
          <div className="decision-list">
            {loading ? <p className="overview-empty">正在汇总决策记录…</p> : pending.length ? pending.slice(0, 5).map((decision, index) => (
              <div className="decision-row" key={decision.id}>
                <span className={`priority-tag ${index === 0 ? "high" : index < 3 ? "medium" : "low"}`}>{index === 0 ? "高" : index < 3 ? "中" : "低"}</span>
                <div><strong>{decision.entityName}</strong><small>{decision.reason}</small></div>
                <time>{new Date(decision.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
                <button type="button" onClick={() => onNavigate("ads")}>处理</button>
              </div>
            )) : <p className="overview-empty"><CheckCircle2 size={17} /> 当前没有待处理建议</p>}
          </div>
        </article>

        <article className="overview-zone activity-zone">
          <header className="zone-heading">
            <div><h2>最近活动</h2><span>自动化决策流</span></div>
            <button className="icon-text-link" type="button" onClick={() => onNavigate("tasks")}>查看全部 <ArrowRight size={14} /></button>
          </header>
          <div className="activity-list">
            {stream.length ? stream.map((decision) => (
              <div className="activity-row" key={decision.id}>
                <span className={`activity-icon ${decision.status === "succeeded" ? "success" : decision.status === "failed" || decision.status === "unknown" ? "danger" : "info"}`}>
                  {decision.status === "succeeded" ? <CheckCircle2 size={15} /> : decision.status === "failed" || decision.status === "unknown" ? <CircleAlert size={15} /> : <Radio size={15} />}
                </span>
                <div><strong>{decision.entityName}</strong><small>{decision.action === "enable" ? "建议开启" : "建议关闭"} · {decision.reason}</small></div>
                <time>{new Date(decision.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
              </div>
            )) : <p className="overview-empty"><Activity size={17} /> 暂无决策记录</p>}
          </div>
        </article>
      </section>

      <section className="overview-lower-grid">
        <article className="quick-action-zone">
          <header className="zone-heading"><div><h2>快捷操作</h2><span>保持原有操作结果</span></div></header>
          <div className="quick-action-grid">
            <button type="button" onClick={() => onNavigate("launch")}><Plus size={22} /><strong>创建广告</strong><span>批量导入与发布</span></button>
            <button type="button" onClick={() => document.getElementById("account-management")?.scrollIntoView({ behavior: "smooth" })}><Users size={22} /><strong>管理账户</strong><span>接入与能力检测</span></button>
            <button type="button" onClick={() => onNavigate("ads")}><CircleGauge size={22} /><strong>广告管理</strong><span>筛选与人工启停</span></button>
            <button type="button" onClick={() => onNavigate("tasks")}><Zap size={22} /><strong>任务中心</strong><span>重试与人工核验</span></button>
          </div>
        </article>

        <article className="connection-health-zone">
          <header className="zone-heading"><div><h2>连接健康</h2><span>本地服务状态</span></div></header>
          <div className="connection-health-list">
            <ConnectionHealth icon={<ShieldCheck size={17} />} label="账户接入" detail={`${readyCount}/${accounts.length} 正常`} healthy={readyCount === accounts.length} />
            <ConnectionHealth icon={<Database size={17} />} label="本地数据" detail="读取正常" healthy />
            <ConnectionHealth icon={<Activity size={17} />} label="任务队列" detail={runtime.enabled ? "运行中" : "已暂停"} healthy={runtime.enabled} />
          </div>
        </article>
      </section>

      <section className="overview-account-section">
        <header className="account-section-heading">
          <div><span className="section-kicker">ACCOUNT OPERATIONS</span><h2>账户管理</h2></div>
          <p>原账户新增、编辑、接入、同步、自动化开关和删除能力完整保留。</p>
        </header>
        {children}
      </section>
    </section>
  );
}

function OverviewStat({ label, value, meta, tone }: { label: string; value: string; meta: string; tone?: "warning" | undefined }) {
  return <div className={`overview-stat ${tone ?? ""}`}><span>{label}</span><strong>{value}</strong><small>{meta}</small></div>;
}

function ConnectionHealth({ icon, label, detail, healthy }: { icon: ReactNode; label: string; detail: string; healthy: boolean }) {
  return <div><span className="connection-health-icon">{icon}</span><strong>{label}</strong><em className={healthy ? "healthy" : "warning"}>{healthy ? "正常" : "注意"}</em><small>{detail}</small><i className="mini-trend">⌁</i></div>;
}
