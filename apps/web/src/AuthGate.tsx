import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Activity, KeyRound, LogIn, ShieldCheck } from "lucide-react";
import type { AuthStatus } from "@tk-auto/core";
import { api } from "./api";

interface AuthContextValue {
  status: AuthStatus;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  invalidate: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("Auth context is unavailable.");
  return value;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("developer");
  const [displayName, setDisplayName] = useState("本机开发者");
  const [password, setPassword] = useState("");

  const refresh = async () => {
    const next = await api.authStatus();
    setStatus(next);
  };

  useEffect(() => {
    void refresh().catch((cause) => {
      setError(messageOf(cause));
      setStatus({
        setupRequired: false,
        authenticated: false,
        user: null,
        permissions: [],
        csrfToken: null,
      });
    });
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      const next = status?.setupRequired
        ? await api.setupDeveloper({ username, displayName, password })
        : await api.login({ username, password });
      setPassword("");
      setError(null);
      setStatus(next);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const value = useMemo<AuthContextValue | null>(() => {
    if (!status?.authenticated) return null;
    return {
      status,
      refresh,
      logout: async () => {
        await api.logout();
        setStatus({ ...status, authenticated: false, user: null, permissions: [], csrfToken: null });
      },
      invalidate: () => {
        setStatus({ ...status, authenticated: false, user: null, permissions: [], csrfToken: null });
      },
    };
  }, [status]);

  if (!status) {
    return (
      <div className="auth-shell">
        <div className="loader" />
        <strong>正在检查本地安全状态</strong>
      </div>
    );
  }

  if (!status.authenticated || !value) {
    const setup = status.setupRequired;
    return (
      <main className="auth-shell">
        <form className="auth-card" onSubmit={(event) => void submit(event)}>
          <div className="auth-brand">
            <span><Activity size={24} /></span>
            <div><strong>TK Ads</strong><small>Local Automation</small></div>
          </div>
          <div className="auth-heading">
            <span><ShieldCheck size={20} /></span>
            <div>
              <h1>{setup ? "创建本机开发者" : "登录管理控制台"}</h1>
              <p>{setup ? "首次启动只需设置一次。不会创建默认密码，也不会上传账户信息。" : "使用本机账户进入广告自动化控制台。"}</p>
            </div>
          </div>
          {setup && (
            <label className="field">
              <span>显示名称</span>
              <input required maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
          )}
          <label className="field">
            <span>用户名</span>
            <input required autoComplete="username" pattern="[a-z][a-z0-9_-]{2,31}" value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} />
          </label>
          <label className="field">
            <span>密码</span>
            <input required type="password" autoComplete={setup ? "new-password" : "current-password"} minLength={setup ? 12 : 1} value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {setup && <small className="auth-password-tip">至少 12 位，并包含大写、小写、数字和符号。</small>}
          {error && <p className="auth-error">{error}</p>}
          <button className="primary-button auth-submit" disabled={busy} type="submit">
            {setup ? <KeyRound size={18} /> : <LogIn size={18} />}
            {busy ? "处理中…" : setup ? "创建并进入" : "登录"}
          </button>
          <footer>仅监听 127.0.0.1 · 会话与广告凭据均在本机保护</footer>
        </form>
      </main>
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "本地登录失败。";
}
