import { useCallback, useEffect, useState } from "react";
import { Activity, ArchiveRestore, DatabaseBackup, FileClock, RefreshCw, ShieldCheck } from "lucide-react";
import type {
  AuditLogRecord,
  DatabaseBackupRecord,
  MaintenanceStatus,
  UpdateRuntimeStatus,
} from "@tk-auto/core";
import { api } from "./api";
import { useAuth } from "./AuthGate";
import { useOverlays } from "./ui/overlays";
import "./ui/pages/system-maintenance.css";

export function MaintenancePage({ onError }: { onError: (message: string) => void }) {
  const auth = useAuth();
  const { confirm, toast } = useOverlays();
  const canControlSystem = auth.status.permissions.includes("system:control");
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [backups, setBackups] = useState<DatabaseBackupRecord[]>([]);
  const [audit, setAudit] = useState<AuditLogRecord[]>([]);
  const [actionFilter, setActionFilter] = useState("");
  const [correlationFilter, setCorrelationFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!canControlSystem) return;
    try {
      const filters = {
        ...(actionFilter.trim() ? { action: actionFilter.trim() } : {}),
        ...(correlationFilter.trim() ? { correlationId: correlationFilter.trim() } : {}),
        limit: 100,
      };
      const [nextStatus, nextBackups, nextAudit] = await Promise.all([
        api.getMaintenanceStatus(),
        api.getDatabaseBackups(),
        api.getAuditLogs(filters),
      ]);
      setStatus(nextStatus);
      setBackups(nextBackups);
      setAudit(nextAudit);
    } catch (cause) {
      onError(errorMessage(cause));
    }
  }, [actionFilter, canControlSystem, correlationFilter, onError]);

  useEffect(() => { void reload(); }, [reload]);

  const run = async (key: string, operation: () => Promise<unknown>, message?: string) => {
    setBusy(key);
    setNotice(null);
    try {
      await operation();
      if (message) { setNotice(message); toast(message); }
      await reload();
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const update = async (operation: () => Promise<UpdateRuntimeStatus>) => {
    await run("update", async () => {
      const next = await operation();
      setStatus((current) => current ? { ...current, update: next } : current);
    });
  };

  if (!canControlSystem) {
    return <div className="system-access-denied maintenance-access-denied"><ShieldCheck size={22} /><div><strong>无运维中心访问权限</strong><p>当前角色不能读取或执行系统运维操作。</p></div></div>;
  }

  return (
    <main className="system-maintenance-page maintenance-page">
      <header className="system-page-header">
        <div>
          <span className="system-page-kicker">系统可靠性</span>
          <p>集中查看运行版本、升级安全、数据库备份恢复与审计轨迹。</p>
        </div>
        <button className="secondary-button" disabled={busy !== null} onClick={() => void reload()} type="button"><RefreshCw size={15} /> 刷新状态</button>
      </header>

      <section className="maintenance-status-section" aria-label="运行状态">
        <div className="maintenance-status-heading"><Activity size={18} /><span><strong>运行状态</strong><small>{status ? "系统状态已同步" : "正在读取运维状态"}</small></span></div>
        <div className="maintenance-status-strip">
          <Status label="当前版本" value={status?.appVersion ?? "读取中"} />
          <Status label="数据库结构" value={status?.schemaVersion ?? "读取中"} />
          <Status label="代码签名" value={status ? signatureLabel(status.update.signatureStatus) : "读取中"} tone={status?.update.signatureStatus === "invalid" ? "danger" : undefined} />
          <Status label="升级状态" value={status ? updateStateLabel(status.update) : "读取中"} tone={status?.update.state === "error" ? "danger" : undefined} />
        </div>
        {status?.pendingRestore && <p className="system-inline-warning">已有待应用的数据库恢复请求，请重启软件。</p>}
        {status?.update.message && <p className="system-muted-note">{status.update.message}</p>}
      </section>

      <section className="maintenance-operations-grid" aria-label="运维操作">
        <article className="system-surface audit-panel">
          <div className="system-section-heading">
            <div><FileClock size={18} /><span><strong>审计日志</strong><small>最近 100 条真实操作记录</small></span></div>
            <button className="system-text-button" onClick={() => void reload()} type="button"><RefreshCw size={13} /> 刷新</button>
          </div>
          <div className="system-filter-row">
            <label><span>动作</span><input value={actionFilter} onChange={(event) => setActionFilter(event.target.value)} placeholder="例如 write-task" /></label>
            <label><span>关联 ID</span><input value={correlationFilter} onChange={(event) => setCorrelationFilter(event.target.value)} placeholder="精确关联 ID" /></label>
          </div>
          <div className="system-table-wrap audit-table-wrap">
            <table className="system-table">
              <thead><tr><th>时间</th><th>操作人</th><th>账户</th><th>动作</th><th>关联信息</th></tr></thead>
              <tbody>{audit.length === 0 ? <tr><td colSpan={5}><div className="system-empty">没有符合条件的审计记录</div></td></tr> : audit.map((item) => <tr key={item.id}><td>{new Date(item.createdAt).toLocaleString()}</td><td><strong>{item.actor.name}</strong><small>{item.actor.kind === "system" ? "系统" : item.actor.id}</small></td><td>{item.accountId}</td><td><code>{item.action}</code></td><td><small>关联：{item.correlationId}<br />请求：{item.requestId ?? "后台任务"}</small></td></tr>)}</tbody>
            </table>
          </div>
        </article>

        <article className="system-surface backup-panel">
          <div className="system-section-heading">
            <div><DatabaseBackup size={18} /><span><strong>备份与恢复</strong><small>最多保留最近 5 份一致性快照</small></span></div>
            <button className="primary-button" disabled={busy !== null} onClick={() => void run("backup", api.createDatabaseBackup, "数据库备份已创建并通过完整性检查。") } type="button">立即备份</button>
          </div>
          {notice && <p className="system-success-note">{notice}</p>}
          <div className="backup-list">
            {backups.length === 0 ? <div className="system-empty">尚无数据库备份</div> : backups.map((backup) => (
              <div className="backup-item" key={backup.id}>
                <div className="backup-item-main">
                  <span className={backup.status === "verified" ? "system-status is-active" : "system-status is-disabled"}>{backup.status === "verified" ? "已验证" : "无效"}</span>
                  <strong>{new Date(backup.createdAt).toLocaleString()}</strong>
                  <small>{backupKindLabel(backup.kind)} · {backup.appVersion} / {backup.schemaVersion} · {formatBytes(backup.sizeBytes)}</small>
                  {backup.errorMessage && <small className="backup-error">{backup.errorMessage}</small>}
                </div>
                <div className="system-row-actions">
                  <button className="system-text-button" disabled={busy !== null} onClick={() => void run(`verify:${backup.id}`, () => api.verifyDatabaseBackup(backup.id))} type="button">重新校验</button>
                  <button className="system-text-button" disabled={busy !== null || backup.status !== "verified"} onClick={() => void (async () => { if (await confirm({ title: "恢复数据库", message: `确认将数据库恢复到 ${new Date(backup.createdAt).toLocaleString()}？请求保存后需要重启软件。`, confirmLabel: "保存恢复请求", danger: true })) await run(`restore:${backup.id}`, () => api.requestDatabaseRestore(backup.id), "恢复请求已保存，请重启软件。"); })()} type="button"><ArchiveRestore size={13} /> 恢复</button>
                </div>
              </div>
            ))}
          </div>
          <p className="system-footnote">恢复会在下次启动时应用；失败时自动回滚当前数据库。</p>
        </article>

        <article className="system-surface update-panel">
          <div className="system-section-heading"><div><ShieldCheck size={18} /><span><strong>升级检查</strong><small>签名、哈希与安装前备份</small></span></div></div>
          <div className="update-facts">
            <div><span>当前版本</span><strong>{status?.appVersion ?? "—"}</strong></div>
            <div><span>最新版本</span><strong>{status?.update.availableVersion ?? "未发现"}</strong></div>
            <div><span>发布状态</span><strong>{status ? updateStateLabel(status.update) : "读取中"}</strong></div>
          </div>
          <div className="update-actions">
            <button className="secondary-button" disabled={busy !== null || !status?.update.configured} onClick={() => void update(api.checkForUpdates)} type="button">检查更新</button>
            <button className="secondary-button" disabled={busy !== null || status?.update.state !== "available"} onClick={() => void update(api.downloadUpdate)} type="button">下载并验证</button>
            <button className="primary-button" disabled={busy !== null || status?.update.state !== "downloaded"} onClick={() => void (async () => { if (await confirm({ title: "启动升级", message: "安装前将自动创建并校验数据库备份。确认启动升级程序吗？", confirmLabel: "备份并安装", danger: true })) await update(api.installUpdate); })()} type="button">备份并安装</button>
          </div>
          <p className="system-footnote">升级包必须同时通过签名清单、SHA-256 与 Windows 代码签名校验。</p>
        </article>
      </section>
    </main>
  );
}

function Status({ label, value, tone }: { label: string; value: string; tone?: "danger" | undefined }) {
  return <div className={`maintenance-status-card${tone ? ` ${tone}` : ""}`}><small>{label}</small><strong>{value}</strong></div>;
}

export function signatureLabel(value: MaintenanceStatus["update"]["signatureStatus"]): string {
  return ({ "not-packaged": "开发环境", unknown: "待校验", valid: "有效", invalid: "无效" })[value];
}

export function updateStateLabel(update: UpdateRuntimeStatus): string {
  return ({ "not-configured": "未配置", idle: "待检查", checking: "检查中", "up-to-date": "已是最新", available: `发现 ${update.availableVersion ?? "新版本"}`, downloading: "下载中", downloaded: "已验证待安装", installing: "正在安装", error: "升级异常" })[update.state];
}

export function backupKindLabel(kind: DatabaseBackupRecord["kind"]): string {
  return ({ "pre-migration": "迁移前", manual: "手动", "pre-upgrade": "升级前", "restore-rollback": "恢复回滚" })[kind];
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "运维操作失败。";
}
