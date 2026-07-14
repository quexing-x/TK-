import { type FormEvent, useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, ShieldCheck, UserCog } from "lucide-react";
import type { LocalUserCreateInput, LocalUserRecord, LocalUserRole } from "@tk-auto/core";
import { api } from "./api";
import { useAuth } from "./AuthGate";

export function SystemUsersPage({ onError }: { onError: (message: string | null) => void }) {
  const auth = useAuth();
  const canManage = auth.status.permissions.includes("users:manage");
  const [users, setUsers] = useState<LocalUserRecord[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<LocalUserCreateInput>({
    username: "",
    displayName: "",
    role: "operator",
    password: "",
  });
  const [passwords, setPasswords] = useState({ currentPassword: "", newPassword: "" });

  const load = useCallback(async () => {
    if (!canManage) return;
    try {
      setUsers(await api.getLocalUsers());
      onError(null);
    } catch (cause) {
      onError(messageOf(cause));
    }
  }, [canManage, onError]);

  useEffect(() => void load(), [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      await api.createLocalUser(form);
      setForm({ username: "", displayName: "", role: "operator", password: "" });
      setShowCreate(false);
      await load();
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const update = async (user: LocalUserRecord, change: Partial<Pick<LocalUserRecord, "role" | "enabled">>) => {
    try {
      await api.updateLocalUser(user.id, {
        displayName: user.displayName,
        role: change.role ?? user.role,
        enabled: change.enabled ?? user.enabled,
      });
      await load();
    } catch (cause) {
      onError(messageOf(cause));
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      await api.changePassword(passwords);
      auth.invalidate();
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page-stack">
      <div className="panel permission-hero"><ShieldCheck size={28} /><div><span className="eyebrow">本机安全</span><h2>登录与权限控制</h2><p>账户只存在本机。密码以加盐哈希保存；会话采用 HttpOnly Cookie，写操作执行 CSRF 与服务端权限校验。</p></div></div>
      {canManage && <div className="panel table-panel"><div className="panel-heading"><div><span className="panel-icon"><UserCog size={18} /></span><div><h2>本机账户</h2><p>开发者拥有全部权限；管理员可管理系统；操作员可管理广告；只读用户不能修改数据。</p></div></div><button className="primary-button" onClick={() => setShowCreate(true)} type="button"><Plus size={16} /> 新增账户</button></div><div className="table-wrap"><table><thead><tr><th>账户</th><th>角色</th><th>状态</th><th>最后登录</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><strong>{user.displayName}</strong><br /><small>{user.username}</small></td><td><select className="inline-select" disabled={user.id === auth.status.user?.id} value={user.role} onChange={(event) => void update(user, { role: event.target.value as LocalUserRole })}>{roleOptions(auth.status.user?.role === "developer")}</select></td><td><span className={user.enabled ? "status active" : "status danger"}>{user.enabled ? "已启用" : "已停用"}</span></td><td>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "从未"}</td><td>{new Date(user.createdAt).toLocaleDateString()}</td><td><button className="secondary-button compact-button" disabled={user.id === auth.status.user?.id} onClick={() => void update(user, { enabled: !user.enabled })} type="button">{user.enabled ? "停用" : "启用"}</button></td></tr>)}</tbody></table></div></div>}
      <form className="panel password-panel" onSubmit={(event) => void changePassword(event)}><div><KeyRound size={20} /><div><h2>修改我的密码</h2><p>修改后所有现有登录会话立即失效，需要重新登录。</p></div></div><div className="form-grid"><label className="field"><span>当前密码</span><input required type="password" autoComplete="current-password" value={passwords.currentPassword} onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })} /></label><label className="field"><span>新密码</span><input required type="password" minLength={12} autoComplete="new-password" value={passwords.newPassword} onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })} /></label></div><div className="form-actions"><button className="primary-button" disabled={busy} type="submit">修改密码</button></div></form>
      {showCreate && <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}><form className="modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void create(event)}><div className="modal-heading"><div><span className="eyebrow">权限控制</span><h2>新增本机账户</h2></div><button onClick={() => setShowCreate(false)} type="button">×</button></div><div className="form-grid"><label className="field"><span>显示名称</span><input required maxLength={80} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label><label className="field"><span>用户名</span><input required pattern="[a-z][a-z0-9_-]{2,31}" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value.toLowerCase() })} /></label><label className="field"><span>角色</span><select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as LocalUserRole })}>{roleOptions(auth.status.user?.role === "developer")}</select></label><label className="field"><span>初始密码</span><input required type="password" minLength={12} autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label></div><div className="modal-actions"><button className="secondary-button" onClick={() => setShowCreate(false)} type="button">取消</button><button className="primary-button" disabled={busy} type="submit">创建账户</button></div></form></div>}
    </section>
  );
}

function roleOptions(includeDeveloper: boolean) {
  return <>{includeDeveloper && <option value="developer">开发者</option>}<option value="admin">管理员</option><option value="operator">操作员</option><option value="viewer">只读用户</option></>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "本机账户操作失败。";
}
