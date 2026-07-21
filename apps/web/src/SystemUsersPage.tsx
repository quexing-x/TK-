import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, Pencil, Plus, ShieldCheck, UserCog, Users } from "lucide-react";
import type {
  LocalUserCreateInput,
  LocalUserRecord,
  LocalUserRole,
  LocalUserUpdateInput,
} from "@tk-auto/core";
import { api } from "./api";
import { useAuth } from "./AuthGate";
import "./ui/pages/system-maintenance.css";

const emptyCreateForm: LocalUserCreateInput = {
  username: "",
  displayName: "",
  role: "operator",
  password: "",
};

const roleDetails: Array<{
  role: LocalUserRole;
  name: string;
  description: string;
  scope: string;
}> = [
  { role: "developer", name: "开发者", description: "拥有全部系统权限，并可创建开发者账户。", scope: "全部模块" },
  { role: "admin", name: "管理员", description: "拥有系统、用户、账户、规则及广告操作权限。", scope: "全部模块" },
  { role: "operator", name: "操作员", description: "可管理账户、执行自动化、操作广告与投放。", scope: "运营模块" },
  { role: "viewer", name: "只读用户", description: "不具备写入权限，仅可查看当前允许访问的内容。", scope: "只读" },
];

export function SystemUsersPage({ onError }: { onError: (message: string | null) => void }) {
  const auth = useAuth();
  const canManage = auth.status.permissions.includes("users:manage");
  const [users, setUsers] = useState<LocalUserRecord[]>([]);
  const [editorMode, setEditorMode] = useState<"create" | "edit">("create");
  const [editingUser, setEditingUser] = useState<LocalUserRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<LocalUserCreateInput>(emptyCreateForm);
  const [editForm, setEditForm] = useState<LocalUserUpdateInput | null>(null);
  const [passwords, setPasswords] = useState({ currentPassword: "", newPassword: "", confirmNewPassword: "" });
  const enabledDeveloperCount = users.filter((user) => user.enabled && user.role === "developer").length;

  const roleCounts = useMemo(() => Object.fromEntries(
    roleDetails.map(({ role }) => [role, users.filter((user) => user.role === role).length]),
  ) as Record<LocalUserRole, number>, [users]);

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

  const openCreate = () => {
    setEditorMode("create");
    setEditingUser(null);
    setEditForm(null);
    setForm(emptyCreateForm);
  };

  const openEdit = (user: LocalUserRecord) => {
    setEditorMode("edit");
    setEditingUser(user);
    setEditForm({ displayName: user.displayName, role: user.role, enabled: user.enabled });
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      await api.createLocalUser(form);
      openCreate();
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

  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingUser || !editForm) return;
    try {
      setBusy(true);
      await api.updateLocalUser(editingUser.id, editForm);
      openCreate();
      await load();
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (passwords.newPassword !== passwords.confirmNewPassword) {
      onError("两次输入的新密码不一致，请重新确认。");
      return;
    }
    try {
      setBusy(true);
      await api.changePassword({ currentPassword: passwords.currentPassword, newPassword: passwords.newPassword });
      auth.invalidate();
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const editMustKeepDeveloper = Boolean(
    editingUser?.enabled && editingUser.role === "developer" && enabledDeveloperCount === 1,
  );
  const editOwnAccount = editingUser?.id === auth.status.user?.id;
  const cannotEditAccess = editMustKeepDeveloper || editOwnAccount;

  return (
    <main className="system-maintenance-page system-users-page">
      <header className="system-page-header">
        <div>
          <span className="system-page-kicker">本机权限控制</span>
          <p>管理本机账户、角色边界和登录凭据。所有权限仍由服务端校验。</p>
        </div>
        <div className="system-security-summary" aria-label="本机安全说明">
          <ShieldCheck size={20} />
          <span><strong>本机安全</strong><small>HttpOnly 会话 · CSRF 防护 · 加盐哈希</small></span>
        </div>
      </header>

      {canManage ? (
        <section className="system-users-workspace" aria-label="用户管理工作区">
          <article className="system-surface user-directory-panel">
            <div className="system-section-heading">
              <div><Users size={18} /><span><strong>用户管理</strong><small>共 {users.length} 个本机账户</small></span></div>
              <button className="primary-button" onClick={openCreate} type="button"><Plus size={15} /> 新增用户</button>
            </div>
            <div className="system-table-wrap">
              <table className="system-table">
                <thead><tr><th>用户</th><th>角色</th><th>状态</th><th>最后登录</th><th>操作</th></tr></thead>
                <tbody>
                  {users.length === 0 ? <tr><td colSpan={5}><div className="system-empty">暂无本机账户</div></td></tr> : users.map((user) => {
                    const mustKeepDeveloper = user.enabled && user.role === "developer" && enabledDeveloperCount === 1;
                    const cannotChange = user.id === auth.status.user?.id || mustKeepDeveloper;
                    return (
                      <tr className={editingUser?.id === user.id ? "is-selected" : ""} key={user.id}>
                        <td><strong>{user.displayName}</strong><small>{user.username}</small></td>
                        <td>
                          <select aria-label={`${user.displayName} 的角色`} className="inline-select" disabled={cannotChange} value={user.role} onChange={(event) => void update(user, { role: event.target.value as LocalUserRole })}>
                            {roleOptions(auth.status.user?.role === "developer")}
                          </select>
                        </td>
                        <td><span className={user.enabled ? "system-status is-active" : "system-status is-disabled"}>{user.enabled ? "正常" : "停用"}</span></td>
                        <td>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "从未登录"}</td>
                        <td>
                          <div className="system-row-actions">
                            <button aria-label={`编辑 ${user.displayName}`} className="system-text-button" onClick={() => openEdit(user)} type="button"><Pencil size={13} /> 编辑</button>
                            <button aria-label={`${user.displayName}${user.enabled ? "停用" : "启用"}`} className="system-text-button" disabled={cannotChange} title={mustKeepDeveloper ? "至少保留一个开发者账户" : undefined} onClick={() => void update(user, { enabled: !user.enabled })} type="button">{user.enabled ? "停用" : "启用"}</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </article>

          <article className="system-surface user-editor-panel">
            <div className="system-section-heading">
              <div><UserCog size={18} /><span><strong>{editorMode === "create" ? "新建用户" : "编辑用户"}</strong><small>{editorMode === "create" ? "创建本机登录账户" : editingUser?.username}</small></span></div>
              {editorMode === "edit" && <button className="system-text-button" onClick={openCreate} type="button">取消编辑</button>}
            </div>
            {editorMode === "create" ? (
              <form className="system-editor-form" onSubmit={(event) => void create(event)}>
                <label className="field"><span>显示名称 *</span><input required maxLength={80} placeholder="请输入显示名称" value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label>
                <label className="field"><span>用户名 *</span><input required pattern="[a-z][a-z0-9_-]{2,31}" placeholder="字母开头，3-32 位" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value.toLowerCase() })} /></label>
                <label className="field"><span>角色 *</span><select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as LocalUserRole })}>{roleOptions(auth.status.user?.role === "developer")}</select></label>
                <label className="field"><span>初始密码 *</span><input required type="password" minLength={12} autoComplete="new-password" placeholder="至少 12 位，含大小写、数字和符号" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
                <div className="system-form-actions"><button className="secondary-button" onClick={openCreate} type="button">重置</button><button className="primary-button" disabled={busy} type="submit">保存用户</button></div>
              </form>
            ) : editForm && editingUser ? (
              <form className="system-editor-form" onSubmit={(event) => void saveEdit(event)}>
                <label className="field"><span>显示名称 *</span><input required maxLength={80} value={editForm.displayName} onChange={(event) => setEditForm({ ...editForm, displayName: event.target.value })} /></label>
                <label className="field"><span>用户名</span><input disabled value={editingUser.username} /></label>
                <label className="field"><span>角色 *</span><select disabled={cannotEditAccess} value={editForm.role} onChange={(event) => setEditForm({ ...editForm, role: event.target.value as LocalUserRole })}>{roleOptions(auth.status.user?.role === "developer")}</select></label>
                <fieldset className="system-radio-field" disabled={cannotEditAccess}><legend>状态</legend><label><input checked={editForm.enabled} name="user-status" onChange={() => setEditForm({ ...editForm, enabled: true })} type="radio" /> 正常</label><label><input checked={!editForm.enabled} name="user-status" onChange={() => setEditForm({ ...editForm, enabled: false })} type="radio" /> 停用</label></fieldset>
                {cannotEditAccess && <p className="system-protection-note">当前账户或最后一个启用的开发者不可变更角色和状态。</p>}
                <div className="system-form-actions"><button className="secondary-button" onClick={openCreate} type="button">取消</button><button className="primary-button" disabled={busy} type="submit">保存修改</button></div>
              </form>
            ) : null}
          </article>

          <aside className="system-surface role-overview-panel">
            <div className="system-section-heading"><div><ShieldCheck size={18} /><span><strong>角色权限概览</strong><small>权限由角色统一映射</small></span></div></div>
            <div className="role-overview-list">
              {roleDetails.map((item) => <div className="role-overview-item" key={item.role}><div><strong>{item.name}</strong><span>{roleCounts[item.role]} 人</span></div><p>{item.description}</p><small>{item.scope}</small></div>)}
            </div>
            <p className="system-footnote">角色变更会影响该用户后续所有请求的服务端权限判断。</p>
          </aside>
        </section>
      ) : (
        <section className="system-access-denied"><ShieldCheck size={22} /><div><strong>无用户管理权限</strong><p>当前角色不能查看或修改其他本机账户。</p></div></section>
      )}

      <section className="system-password-section" aria-labelledby="password-heading">
        <div className="system-password-copy"><KeyRound size={22} /><div><h2 id="password-heading">修改我的密码</h2><p>密码修改后，所有现有登录会话立即失效，需要重新登录。</p></div></div>
        <form className="system-password-form" onSubmit={(event) => void changePassword(event)}>
          <label className="field"><span>当前密码</span><input required type="password" autoComplete="current-password" value={passwords.currentPassword} onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })} /></label>
          <label className="field"><span>新密码</span><input required type="password" minLength={12} autoComplete="new-password" value={passwords.newPassword} onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })} /></label>
          <label className="field"><span>确认新密码</span><input required type="password" minLength={12} autoComplete="new-password" value={passwords.confirmNewPassword} onChange={(event) => setPasswords({ ...passwords, confirmNewPassword: event.target.value })} /></label>
          <button className="primary-button" disabled={busy || passwords.newPassword !== passwords.confirmNewPassword} type="submit">修改密码</button>
        </form>
      </section>
    </main>
  );
}

function roleOptions(includeDeveloper: boolean) {
  return <>{includeDeveloper && <option value="developer">开发者</option>}<option value="admin">管理员</option><option value="operator">操作员</option><option value="viewer">只读用户</option></>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "本机账户操作失败。";
}
