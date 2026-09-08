import { AlertTriangle, CheckCircle2, RefreshCcw, RotateCcw, ShieldCheck, XCircle } from "./ui/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AccountConfig,
  StatusManualVerificationInput,
  StatusManualVerificationRecord,
  WriteTaskKind,
  WriteTaskStatus,
  WriteTaskSummaryRecord,
} from "@tk-auto/core";
import { api, type WriteTaskAttemptRecord } from "./api";
import { useAuth } from "./AuthGate";

interface TaskCenterPageProps {
  accounts: AccountConfig[];
  preferredAccountId: string;
  onError(message: string): void;
}

const statusOptions: Array<["" | WriteTaskStatus, string]> = [
  ["", "全部状态"],
  ["pending", "等待执行"],
  ["running", "执行中"],
  ["succeeded", "已成功"],
  ["failed", "明确失败"],
  ["unknown", "结果待确认"],
  ["cancelled", "已取消"],
];

export function TaskCenterPage({ accounts, preferredAccountId, onError }: TaskCenterPageProps) {
  const auth = useAuth();
  const canOperate = auth.status.permissions.includes("ads:operate");
  const [kind, setKind] = useState<"" | WriteTaskKind>("");
  const [status, setStatus] = useState<"" | WriteTaskStatus>("");
  const [accountId, setAccountId] = useState(preferredAccountId);
  const [tasks, setTasks] = useState<WriteTaskSummaryRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [attempts, setAttempts] = useState<WriteTaskAttemptRecord[]>([]);
  const [verifications, setVerifications] = useState<StatusManualVerificationRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [verification, setVerification] = useState<StatusManualVerificationInput>({
    decision: "confirmed-succeeded",
    observedStatus: "disabled",
    evidence: "",
    note: "",
  });

  const selected = useMemo(
    () => tasks.find((task) => task.taskId === selectedId) ?? null,
    [selectedId, tasks],
  );

  const load = useCallback(async () => {
    try {
      const next = await api.getWriteTasks({
        ...(kind ? { kind } : {}),
        ...(status ? { status } : {}),
        ...(accountId ? { accountId } : {}),
        limit: 500,
      });
      setTasks(next);
      setSelectedId((current) => next.some((task) => task.taskId === current)
        ? current
        : next[0]?.taskId ?? "");
    } catch (cause) {
      onError(messageOf(cause));
    }
  }, [accountId, kind, onError, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setAttempts([]);
      setVerifications([]);
      return;
    }
    let active = true;
    void Promise.all([
      api.getWriteTaskAttempts(selected.kind, selected.taskId),
      selected.kind === "status"
        ? api.getStatusWriteTaskVerifications(selected.taskId)
        : Promise.resolve([]),
    ])
      .then(([nextAttempts, nextVerifications]) => {
        if (!active) return;
        setAttempts(nextAttempts);
        setVerifications(nextVerifications);
      })
      .catch((cause) => { if (active) onError(messageOf(cause)); });
    setVerification((current) => ({
      ...current,
      decision: "confirmed-succeeded",
      observedStatus: selected.action === "enable" ? "enabled" : "disabled",
      evidence: "",
      note: "",
    }));
    return () => { active = false; };
  }, [onError, selected]);

  async function retry(task: WriteTaskSummaryRecord) {
    setBusy(true);
    try {
      if (task.kind === "launch") {
        if (!task.parentId) throw new Error("创建任务缺少所属计划。 ");
        await api.retryLaunchPlanItem(task.parentId, task.taskId);
      } else {
        await api.retryStatusOperation(task.accountId, task.operationId);
      }
      await load();
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function cancelPlan(task: WriteTaskSummaryRecord) {
    if (!task.parentId) return;
    setBusy(true);
    try {
      await api.cancelLaunchPlan(task.parentId);
      await load();
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function verifyStatusTask() {
    if (!selected || selected.kind !== "status") return;
    setBusy(true);
    try {
      await api.verifyStatusOperation(selected.accountId, selected.operationId, verification);
      await load();
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return <section className="page-stack task-center-page">
    <header className="task-center-header">
      <div><span className="eyebrow">执行控制台</span><h2>统一任务中心</h2><p>跟踪广告创建和启停写入，处理失败恢复与启停结果核对。</p></div>
      <button className="secondary-button" disabled={busy} onClick={() => void load()} type="button"><RefreshCcw size={15} /> 刷新任务</button>
    </header>

    <div className="task-metric-strip" aria-label="任务状态概览">
      <span><small>当前结果</small><strong>{tasks.length}</strong></span>
      <span><small>执行中</small><strong>{tasks.filter((task) => task.status === "running").length}</strong></span>
      <span><small>明确失败</small><strong>{tasks.filter((task) => task.status === "failed").length}</strong></span>
      <span><small>待核验</small><strong>{tasks.filter((task) => task.status === "unknown").length}</strong></span>
    </div>

    <div className="panel filter-panel task-filter-bar">
      <div className="form-grid management-filters">
        <label className="field"><span>任务类型</span><select value={kind} onChange={(event) => setKind(event.target.value as "" | WriteTaskKind)}><option value="">全部任务</option><option value="launch">广告创建</option><option value="status">广告启停</option></select></label>
        <label className="field"><span>状态</span><select value={status} onChange={(event) => setStatus(event.target.value as "" | WriteTaskStatus)}>{statusOptions.map(([value, label]) => <option key={value || "all"} value={value}>{label}</option>)}</select></label>
        <label className="field"><span>账户</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">全部账户</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label>
      </div>
    </div>

    <div className="task-workbench">

    <div className="panel table-panel task-list-pane">
      <div className="panel-heading"><div><span className="panel-icon"><ShieldCheck size={18} /></span><div><h2>任务历史</h2></div></div></div>
      <div className="table-wrap"><table><thead><tr><th>账户</th><th>任务</th><th>动作</th><th>状态</th><th>阶段</th><th>尝试</th><th>更新时间</th></tr></thead><tbody>{tasks.length === 0 ? <tr><td colSpan={7}>没有符合条件的任务。</td></tr> : tasks.map((task) => <tr className={selectedId === task.taskId ? "selected-row" : undefined} key={`${task.kind}:${task.taskId}`} onClick={() => setSelectedId(task.taskId)}><td>{accountName(accounts, task.accountId)}</td><td><strong>{task.label}</strong><br /><small>{task.kind === "launch" ? "广告创建" : "广告启停"}</small></td><td>{actionLabel(task.action)}</td><td><TaskStatus task={task} /></td><td>{phaseLabel(task.phase)}</td><td>{task.attemptCount}</td><td>{new Date(task.updatedAt).toLocaleString()}</td></tr>)}</tbody></table></div>
    </div>

    {selected ? <aside className="panel task-detail-panel">
      <div className="panel-heading"><div><span className="panel-icon"><CheckCircle2 size={18} /></span><div><h2>任务详情</h2><p>{selected.label} · {accountName(accounts, selected.accountId)}</p></div></div><div className="task-center-actions">{selected.retryable && <button className="primary-button" disabled={busy || !canOperate} onClick={() => void retry(selected)} type="button"><RotateCcw size={15} /> 单项重试</button>}{selected.kind === "launch" && ["pending", "failed"].includes(selected.status) && <button className="secondary-button" disabled={busy || !canOperate} onClick={() => void cancelPlan(selected)} type="button"><XCircle size={15} /> 取消所属计划</button>}</div></div>
      <div className="task-detail-grid">
        <Detail label="任务 ID" value={selected.taskId} />
        <Detail label="操作 ID" value={selected.operationId} />
        <Detail label="关联 ID" value={selected.correlationId} />
        <Detail label="本次尝试 ID" value={selected.attemptId ?? "尚未领取"} />
        <Detail label="操作" value={`${actionLabel(selected.action)}${selected.kind === "status" ? "广告组" : "广告"}`} />
        <Detail label="当前状态" value={statusLabel(selected.status)} />
        <Detail label="发起人" value={`${selected.actor.name}（${selected.actor.kind === "system" ? "系统" : "用户"}）`} />
        <Detail label="开始执行" value={selected.claimedAt ? new Date(selected.claimedAt).toLocaleString() : "等待执行"} />
        <Detail label="完成时间" value={selected.completedAt ? new Date(selected.completedAt).toLocaleString() : "—"} />
        <Detail label="结果说明" value={humanTaskMessage(selected.status, selected.action, selected.message)} />
      </div>
      {selected.syncWarning && <div className="alert warning-alert"><AlertTriangle size={18} /><span><strong>同步警告：</strong>{selected.syncWarning}</span></div>}

      {selected.requiresVerification && selected.kind === "status" && <div className="task-verification-form">
        <h3>人工核验启停结果</h3><p>请先在 TikTok 后台确认对象当前状态，再记录可复核证据。核验前不会自动重试。</p>
        <div className="form-grid">
          <label className="field"><span>核验结论</span><select value={verification.decision} onChange={(event) => setVerification({ ...verification, decision: event.target.value as StatusManualVerificationInput["decision"] })}><option value="confirmed-succeeded">确认写入成功</option><option value="confirmed-failed">确认写入未成功</option></select></label>
          <label className="field"><span>实际状态</span><select value={verification.observedStatus} onChange={(event) => setVerification({ ...verification, observedStatus: event.target.value as StatusManualVerificationInput["observedStatus"] })}><option value="enabled">已开启</option><option value="disabled">已关闭</option></select></label>
          <label className="field wide"><span>核验证据</span><textarea minLength={10} placeholder="填写查询时间、对象 ID、后台状态或其他可复核依据（至少 10 个字符）" value={verification.evidence} onChange={(event) => setVerification({ ...verification, evidence: event.target.value })} /></label>
          <label className="field wide"><span>备注</span><textarea value={verification.note} onChange={(event) => setVerification({ ...verification, note: event.target.value })} /></label>
        </div>
        <div className="form-actions"><button className="primary-button" disabled={busy || !canOperate || verification.evidence.trim().length < 10} onClick={() => void verifyStatusTask()} type="button">保存核验结论</button></div>
      </div>}
      {selected.kind === "status" && <div className="table-wrap"><table><thead><tr><th>人工核验时间</th><th>结论</th><th>证据</th><th>备注</th><th>核验人</th></tr></thead><tbody>{verifications.length === 0 ? <tr><td colSpan={5}>暂无人工核验记录。</td></tr> : verifications.map((item) => <tr key={item.id}><td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.decision}</td><td><small>{item.evidence}</small></td><td><small>{item.note || "—"}</small></td><td>{item.actor.name}</td></tr>)}</tbody></table></div>}

      <div className="table-wrap"><table><thead><tr><th>次数</th><th>状态</th><th>阶段</th><th>执行者</th><th>开始</th><th>完成</th><th>结果说明</th></tr></thead><tbody>{attempts.length === 0 ? <tr><td colSpan={7}>尚无执行尝试。</td></tr> : attempts.map((attempt) => <tr key={attempt.attemptId}><td>{attempt.attemptNumber}</td><td>{statusLabel(attempt.status)}</td><td>{phaseLabel(attempt.phase === "campaign_draft" || attempt.phase === "adgroup_draft" || attempt.phase === "creative_draft" || attempt.phase === "publishing" ? "dispatch" : attempt.phase)}</td><td>{attempt.actor.name}</td><td>{new Date(attempt.createdAt).toLocaleString()}</td><td>{attempt.completedAt ? new Date(attempt.completedAt).toLocaleString() : "—"}</td><td>{humanTaskMessage(attempt.status, selected.action, "message" in attempt ? attempt.message : attempt.errorMessage)}</td></tr>)}</tbody></table></div>
    </aside> : <aside className="panel task-detail-panel task-detail-empty"><CheckCircle2 size={28} /><strong>选择一条任务查看详情</strong><span>执行尝试和恢复入口将在这里显示。</span></aside>}
    </div>
  </section>;
}

function TaskStatus({ task }: { task: WriteTaskSummaryRecord }) {
  const presentation = taskStatusPresentation(task);
  return <span className={`status ${presentation.tone}`}>{presentation.label}</span>;
}

export function taskStatusPresentation(
  task: Pick<WriteTaskSummaryRecord, "status" | "retryable" | "requiresVerification" | "syncWarning">,
) {
  return {
    label: statusLabel(task.status),
    tone: task.status === "succeeded"
      ? "active" as const
      : task.status === "failed" || task.status === "cancelled"
        ? "danger" as const
        : "warning" as const,
    showRetry: task.retryable && task.status === "failed",
    showVerification: task.requiresVerification && task.status === "unknown",
    syncWarning: task.syncWarning,
  };
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><small>{label}</small><span>{value}</span></div>;
}

function accountName(accounts: AccountConfig[], accountId: string): string {
  return accounts.find((account) => account.id === accountId)?.displayName ?? accountId;
}

function actionLabel(action: string): string {
  if (action === "create") return "创建";
  if (action === "enable") return "开启";
  if (action === "disable") return "关闭";
  return action;
}

function statusLabel(status: string): string {
  return ({
    pending: "等待执行",
    running: "执行中",
    succeeded: "已成功",
    failed: "明确失败",
    unknown: "结果待确认",
    cancelled: "已取消",
  } as Record<string, string>)[status] ?? status;
}

function phaseLabel(phase: string): string {
  return ({ validation: "校验", dispatch: "平台请求", readback: "结果回读", sync: "数据同步" } as Record<string, string>)[phase] ?? phase;
}

function humanTaskMessage(status: string, action: string, message: string | null | undefined): string {
  const actionName = actionLabel(action);
  const original = message?.trim();
  const summary = status === "succeeded"
    ? `已确认${actionName}完成。`
    : status === "pending"
      ? "已创建，等待执行。"
      : status === "running"
        ? "正在执行，请稍候。"
        : status === "unknown"
          ? "请求已发出，但暂时无法确认最终状态。"
          : status === "cancelled"
            ? "已取消，未再执行。"
            : status === "failed"
              ? `${actionName}未完成，请重试或查看平台状态。`
              : "暂无结果说明。";
  return original ? `${summary} 原始信息：${original}` : summary;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "任务中心操作失败。";
}
