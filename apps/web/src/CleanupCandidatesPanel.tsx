import { useCallback, useEffect, useState } from "react";
import type { AccountConfig } from "@tk-auto/core";
import { RefreshCcw, Trash2 } from "lucide-react";
import { api } from "./api";
import { useAuth } from "./AuthGate";

type Candidate = Awaited<ReturnType<typeof api.getCleanupCandidates>>["candidates"][number];
type Settings = Awaited<ReturnType<typeof api.getCleanupCandidates>>["settings"];

/**
 * 待清理列表：按当前删除配置，这一刻够格被删的广告组。
 *
 * 列表和定时执行器共用服务端的 selectDeletionCandidates，所以这里看到的就是执行时会
 * 删的那一批——删除不可恢复，「看到的」和「删掉的」不是同一批没有补救余地。
 */
export function CleanupCandidatesPanel({
  accounts,
  onError,
}: {
  accounts: AccountConfig[];
  onError(message: string): void;
}) {
  const auth = useAuth();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const accountName = accounts.find((account) => account.id === accountId)?.displayName ?? "";
  const canOperate = auth.status.permissions.includes("ads:operate");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) {
      setCandidates([]);
      setSettings(null);
      return;
    }
    try {
      setLoading(true);
      const result = await api.getCleanupCandidates(accountId);
      setCandidates(result.candidates);
      setSettings(result.settings);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "待清理列表读取失败。");
    } finally {
      setLoading(false);
    }
  }, [accountId, onError]);

  useEffect(() => {
    setConfirming(false);
    setFeedback(null);
    void load();
  }, [load]);

  const runDelete = async () => {
    try {
      setBusy(true);
      const result = await api.deleteCleanupCandidates(accountId);
      setFeedback(
        result.skipped > 0
          ? `已删除 ${result.deleted} 个广告组；${result.skipped} 个已有未了结的删除记录，本次跳过。`
          : `已删除 ${result.deleted} 个广告组。`,
      );
      setConfirming(false);
      await load();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "删除失败。");
    } finally {
      setBusy(false);
    }
  };

  if (accounts.length === 0) {
    return (
      <div className="panel table-panel">
        <div className="panel-heading"><div><span className="panel-icon"><Trash2 size={18} /></span><div><h2>待清理广告组</h2><p>还没有配置广告账户。</p></div></div></div>
      </div>
    );
  }

  return (
    <div className="panel table-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-icon"><Trash2 size={18} /></span>
          <div>
            <h2>待清理广告组</h2>
            <p>
              {accountName ? `${accountName} · ` : ""}{settings
                ? `已关闭超过 ${settings.gracePeriodHours} 小时、转化 ≤ ${settings.maxConversions}、加购 ≤ ${settings.maxCarts}${settings.maxConversions > 0 ? `、有转化时 CPA ≥ ${settings.minCpa}` : ""}，每个系列至少保留 1 组`
                : "按「自动化执行器」页的删除配置计算"}
            </p>
          </div>
        </div>
        <div className="task-center-actions">
          <label className="field cleanup-account-picker">
            <span>账户</span>
            <select disabled={busy} value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}
            </select>
          </label>
          <button className="secondary-button" disabled={loading || busy} onClick={() => void load()} type="button">
            <RefreshCcw size={15} /> {loading ? "读取中…" : "刷新"}
          </button>
          {candidates.length > 0 && (
            confirming
              ? <>
                  <button className="danger-button" disabled={busy || !canOperate} onClick={() => void runDelete()} type="button">
                    {busy ? "删除中…" : `确认删除 ${candidates.length} 个`}
                  </button>
                  <button className="secondary-button" disabled={busy} onClick={() => setConfirming(false)} type="button">取消</button>
                </>
              : <button className="danger-button" disabled={!canOperate} onClick={() => setConfirming(true)} type="button">
                  <Trash2 size={15} /> 一键删除
                </button>
          )}
        </div>
      </div>

      {/* 删除不可恢复，二次确认里必须把条数说清楚，不能只给一个「确定」。 */}
      {confirming && (
        <div className="alert warning-alert" role="alert">
          即将删除 {candidates.length} 个广告组，删除后无法恢复。请先核对下面的列表。
        </div>
      )}
      {feedback && <div className="alert success-alert" role="status">{feedback}</div>}
      {!canOperate && <div className="alert warning-alert">当前角色只能查看；删除需要广告操作权限。</div>}

      <div className="table-wrap">
        <table>
          <thead><tr><th>广告组</th><th>转化</th><th>加购</th><th>消耗</th><th>CPA</th></tr></thead>
          <tbody>
            {candidates.length === 0
              ? <tr><td colSpan={5}><div className="system-empty">{loading ? "读取中…" : "没有够格清理的广告组。"}</div></td></tr>
              : candidates.map((candidate) => (
                  <tr key={candidate.externalId}>
                    <td><strong>{candidate.name}</strong><br /><small>{candidate.externalId}</small></td>
                    <td>{candidate.conversions ?? "—"}</td>
                    <td>{candidate.carts ?? "—"}</td>
                    <td>{candidate.spend === null ? "—" : candidate.spend.toFixed(2)}</td>
                    <td>{candidate.cpa === null ? "—" : candidate.cpa.toFixed(2)}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
