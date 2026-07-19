import { useCallback, useEffect, useState } from "react";
import type {
  AuditLogRecord,
  DatabaseBackupRecord,
  MaintenanceStatus,
  UpdateRuntimeStatus,
} from "@tk-auto/core";
import { api } from "./api";

export function MaintenancePage({ onError }: { onError: (message: string) => void }) {
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [backups, setBackups] = useState<DatabaseBackupRecord[]>([]);
  const [audit, setAudit] = useState<AuditLogRecord[]>([]);
  const [actionFilter, setActionFilter] = useState("");
  const [correlationFilter, setCorrelationFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
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
  }, [actionFilter, correlationFilter, onError]);

  useEffect(() => { void reload(); }, [reload]);

  const run = async (key: string, operation: () => Promise<unknown>, message?: string) => {
    setBusy(key);
    setNotice(null);
    try {
      await operation();
      if (message) setNotice(message);
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

  return <div className="page-stack maintenance-page">
    <section className="panel">
      <div className="panel-heading"><div><h2>版本与升级安全</h2><p>升级包必须同时通过签名清单、SHA-256 和 Windows 代码签名校验；安装前自动创建数据库备份。</p></div></div>
      {status ? <div className="maintenance-status-grid">
        <Status label="当前版本" value={status.appVersion} />
        <Status label="数据库结构" value={status.schemaVersion} />
        <Status label="代码签名" value={signatureLabel(status.update.signatureStatus)} {...(status.update.signatureStatus === "invalid" ? { tone: "danger" as const } : {})} />
        <Status label="升级状态" value={updateStateLabel(status.update)} {...(status.update.state === "error" ? { tone: "danger" as const } : {})} />
      </div> : <p>正在读取运维状态…</p>}
      {status?.pendingRestore && <p className="inline-warning">已有待应用的数据库恢复请求，请重启软件。</p>}
      {status?.update.message && <p className="muted-note">{status.update.message}</p>}
      <div className="button-row">
        <button className="secondary-button" disabled={busy !== null || !status?.update.configured} onClick={() => void update(api.checkForUpdates)} type="button">检查更新</button>
        <button className="secondary-button" disabled={busy !== null || status?.update.state !== "available"} onClick={() => void update(api.downloadUpdate)} type="button">下载并验证</button>
        <button className="primary-button" disabled={busy !== null || status?.update.state !== "downloaded"} onClick={() => {
          if (window.confirm("安装前将自动创建并校验数据库备份。确认启动升级程序吗？")) void update(api.installUpdate);
        }} type="button">备份并安装</button>
      </div>
    </section>

    <section className="panel">
      <div className="panel-heading"><div><h2>数据库备份与恢复</h2><p>最多保留最近 5 份一致性快照。恢复会在下次启动应用，失败时自动回滚当前数据库。</p></div><button className="primary-button" disabled={busy !== null} onClick={() => void run("backup", api.createDatabaseBackup, "数据库备份已创建并通过完整性检查。")} type="button">立即备份</button></div>
      {notice && <p className="success-note">{notice}</p>}
      <div className="table-wrap"><table><thead><tr><th>时间</th><th>用途</th><th>版本</th><th>大小</th><th>校验</th><th>操作</th></tr></thead><tbody>{backups.length === 0 ? <tr><td colSpan={6}>尚无数据库备份。</td></tr> : backups.map((backup) => <tr key={backup.id}><td>{new Date(backup.createdAt).toLocaleString()}</td><td>{backupKindLabel(backup.kind)}</td><td>{backup.appVersion}<br /><small>{backup.schemaVersion}</small></td><td>{formatBytes(backup.sizeBytes)}</td><td><span className={backup.status === "verified" ? "status active" : "status danger"}>{backup.status === "verified" ? "已验证" : "无效"}</span>{backup.errorMessage && <><br /><small>{backup.errorMessage}</small></>}</td><td><div className="table-actions"><button className="secondary-button compact-button" disabled={busy !== null} onClick={() => void run(`verify:${backup.id}`, () => api.verifyDatabaseBackup(backup.id))} type="button">重新校验</button><button className="secondary-button compact-button" disabled={busy !== null || backup.status !== "verified"} onClick={() => {
          if (window.confirm(`确认将数据库恢复到 ${new Date(backup.createdAt).toLocaleString()}？请求保存后需要重启软件。`)) void run(`restore:${backup.id}`, () => api.requestDatabaseRestore(backup.id), "恢复请求已保存，请重启软件。");
        }} type="button">恢复</button></div></td></tr>)}</tbody></table></div>
    </section>

    <section className="panel">
      <div className="panel-heading"><div><h2>审计日志</h2><p>记录真实操作人、请求 ID、关联 ID、账户和动作。默认显示最近 100 条。</p></div><button className="secondary-button" onClick={() => void reload()} type="button">刷新</button></div>
      <div className="filter-row"><label>动作<input value={actionFilter} onChange={(event) => setActionFilter(event.target.value)} placeholder="例如 write-task" /></label><label>关联 ID<input value={correlationFilter} onChange={(event) => setCorrelationFilter(event.target.value)} placeholder="精确关联 ID" /></label></div>
      <div className="table-wrap"><table><thead><tr><th>时间</th><th>操作人</th><th>账户</th><th>动作</th><th>关联信息</th></tr></thead><tbody>{audit.length === 0 ? <tr><td colSpan={5}>没有符合条件的审计记录。</td></tr> : audit.map((item) => <tr key={item.id}><td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.actor.name}<br /><small>{item.actor.kind === "system" ? "系统" : item.actor.id}</small></td><td>{item.accountId}</td><td>{item.action}</td><td><small>关联：{item.correlationId}<br />请求：{item.requestId ?? "后台任务"}</small></td></tr>)}</tbody></table></div>
    </section>
  </div>;
}

function Status({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
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
