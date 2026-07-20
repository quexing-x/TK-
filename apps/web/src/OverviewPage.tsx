import { Activity, ArrowRight, CheckCircle2, CircleAlert, Plus, Radio } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountConfig, AutomationDecisionRecord, SystemRuntimeState } from "@tk-auto/core";
import { api, type BootstrapPayload } from "./api";

type OverviewDestination = "launch" | "ads" | "tasks" | "users";

export function OverviewPage({
  accounts,
  connectionStates,
  runtime,
  onNavigate,
}: {
  accounts: AccountConfig[];
  connectionStates: BootstrapPayload["accountConnectionStates"];
  runtime: SystemRuntimeState;
  onNavigate: (destination: OverviewDestination) => void;
}) {
  const [decisions, setDecisions] = useState<AutomationDecisionRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const loadDecisions = useCallback(async () => {
    try {
      const results = await Promise.all(
        accounts.map((account) => api.getAutomationDecisions(account.id).catch(() => [])),
      );
      setDecisions(results.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } finally {
      setLoading(false);
    }
  }, [accounts]);

  useEffect(() => {
    void loadDecisions();
  }, [loadDecisions]);

  const readyCount = connectionStates.filter((state) => state.connection?.status === "ready").length;
  const pending = useMemo(
    () => decisions.filter((decision) => decision.status === "preview" || decision.status === "pending"),
    [decisions],
  );
  const stream = useMemo(() => decisions.slice(0, 6), [decisions]);

  return (
    <section className="overview-page page-stack">
      <div className="overview-hero">
        <div className="overview-metric">
          <strong>{readyCount}</strong>
          <span>账户接入正常</span>
        </div>
        <span className="overview-divider" />
        <div className="overview-metric warning">
          <strong>{pending.length}</strong>
          <span>需要你决定</span>
        </div>
        <span className="overview-divider" />
        <div className="overview-hero-message">
          <strong>{runtime.enabled ? (pending.length ? "有自动化建议等待确认" : "自动化正在稳定运行") : "系统自动化当前已暂停"}</strong>
          <span>{runtime.enabled ? "所有执行均保留审计与人工核验入口。" : "恢复系统运行后，检测与队列会继续按既有规则处理。"}</span>
        </div>
      </div>

      <div className="overview-grid">
        <article className="overview-card overview-decisions">
          <header>
            <div><span>待你决定</span><small>来自各广告账户的最新自动化建议</small></div>
            <button className="text-button" type="button" onClick={() => onNavigate("ads")}>广告干预 <ArrowRight size={14} /></button>
          </header>
          {loading ? <p className="overview-empty">正在汇总决策记录…</p> : pending.length ? pending.slice(0, 3).map((decision) => (
            <div className="overview-decision" key={decision.id}>
              <CircleAlert size={17} />
              <div><strong>{decision.entityName}</strong><span>{decision.reason}</span></div>
              <button className="secondary-button compact" type="button" onClick={() => onNavigate("ads")}>查看</button>
            </div>
          )) : <p className="overview-empty"><CheckCircle2 size={17} /> 当前没有待处理建议</p>}
        </article>

        <div className="overview-side-stack">
          <article className="overview-quick-create">
            <Plus size={20} />
            <div><strong>创建今日广告</strong><span>模板、表格导入与批量创建均已就绪。</span></div>
            <button className="primary-button compact" type="button" onClick={() => onNavigate("launch")}>开始创建 <ArrowRight size={14} /></button>
          </article>
          <article className="overview-card overview-total">
            <span>累计自动决策</span><strong>{decisions.length}</strong><small>当前本地账户范围内的可追溯记录</small>
          </article>
        </div>
      </div>

      <article className="overview-card overview-stream">
        <header><div><span>实时决策流</span><small>读取最近的自动化决策，不触发任何平台写入。</small></div><button className="text-button" type="button" onClick={() => onNavigate("tasks")}>任务中心 <ArrowRight size={14} /></button></header>
        {stream.length ? stream.map((decision) => (
          <div className="overview-stream-row" key={decision.id}>
            <Radio size={14} />
            <time>{new Date(decision.createdAt).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
            <span>{decision.entityName} · {decision.action === "enable" ? "建议开启" : "建议关闭"}</span>
            <em className={`status ${decision.status === "succeeded" ? "active" : decision.status === "failed" || decision.status === "unknown" ? "danger" : "warning"}`}>{decision.status}</em>
          </div>
        )) : <p className="overview-empty"><Activity size={17} /> 暂无决策记录；完成接入与检测后会在这里显示。</p>}
      </article>
    </section>
  );
}
