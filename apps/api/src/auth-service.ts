import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import {
  InitialDeveloperInputSchema,
  LocalUserCreateInputSchema,
  LocalUserUpdateInputSchema,
  LoginInputSchema,
  PasswordChangeInputSchema,
  permissionsForRole,
  type AppPermission,
  type AuthStatus,
  type InitialDeveloperInput,
  type LocalUserCreateInput,
  type LocalUserRecord,
  type LocalUserUpdateInput,
  type LoginInput,
  type PasswordChangeInput,
} from "@tk-auto/core";
import { AutomationStore } from "@tk-auto/storage";

const scrypt = promisify(scryptCallback);
export const DEFAULT_SESSION_LIFETIME_MS = 12 * 60 * 60_000;
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_LOGIN_FAILURES = 5;
const DUMMY_PASSWORD_SALT = Buffer.alloc(16).toString("base64");
const DUMMY_PASSWORD_HASH = Buffer.alloc(64).toString("base64");

interface LoginAttempt {
  failures: number;
  resetAt: number;
}

export interface AuthenticatedSession {
  user: LocalUserRecord;
  permissions: AppPermission[];
  csrfToken: string;
  tokenHash: string;
}

export interface CreatedSession extends AuthenticatedSession {
  token: string;
}

export class AuthenticationError extends Error {}
export class LoginRateLimitError extends Error {}
export class AuthorizationError extends Error {}

export class AuthService {
  private readonly loginAttempts = new Map<string, LoginAttempt>();
  private setupInProgress = false;

  constructor(
    private readonly store: AutomationStore,
    private readonly sessionLifetimeMs = DEFAULT_SESSION_LIFETIME_MS,
  ) {}

  status(session: AuthenticatedSession | null): AuthStatus {
    return {
      setupRequired: this.store.countLocalUsers() === 0,
      authenticated: session !== null,
      user: session?.user ?? null,
      permissions: session?.permissions ?? [],
      csrfToken: session?.csrfToken ?? null,
    };
  }

  async setupInitialDeveloper(
    input: InitialDeveloperInput,
  ): Promise<CreatedSession> {
    if (this.setupInProgress || this.store.countLocalUsers() > 0) {
      throw new AuthorizationError("本机账户已经初始化。");
    }
    this.setupInProgress = true;
    try {
      const parsed = InitialDeveloperInputSchema.parse(input);
      const password = await hashPassword(parsed.password);
      if (this.store.countLocalUsers() > 0) {
        throw new AuthorizationError("本机账户已经初始化。");
      }
      const user = this.store.createLocalUser({
        username: parsed.username,
        displayName: parsed.displayName,
        role: "developer",
        ...password,
      });
      return this.createSession(user);
    } finally {
      this.setupInProgress = false;
    }
  }

  async login(input: LoginInput, clientKey: string): Promise<CreatedSession> {
    const parsed = LoginInputSchema.parse(input);
    const attemptKey = `${clientKey}:${parsed.username}`;
    this.assertLoginAllowed(attemptKey);
    const user = this.store.getStoredLocalUserByUsername(parsed.username);
    const passwordValid = await verifyPassword(
      parsed.password,
      user?.passwordSalt ?? DUMMY_PASSWORD_SALT,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    const valid = user?.enabled === true && passwordValid;
    if (!valid || !user) {
      this.recordLoginFailure(attemptKey);
      throw new AuthenticationError("用户名或密码错误。");
    }
    this.loginAttempts.delete(attemptKey);
    this.store.recordLocalUserLogin(user.id);
    return this.createSession(
      this.store.getStoredLocalUser(user.id) as LocalUserRecord,
    );
  }

  authenticate(token: string | null): AuthenticatedSession | null {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const session = this.store.getAuthSession(tokenHash);
    if (!session) return null;
    const user = this.store.getStoredLocalUser(session.userId);
    if (!user?.enabled) {
      this.store.deleteAuthSession(tokenHash);
      return null;
    }
    return {
      user,
      permissions: permissionsForRole(user.role),
      csrfToken: session.csrfToken,
      tokenHash,
    };
  }

  logout(session: AuthenticatedSession | null): void {
    if (session) this.store.deleteAuthSession(session.tokenHash);
  }

  resetLocalAccess(): number {
    this.loginAttempts.clear();
    return this.store.resetLocalUserAccess();
  }

  async createUser(
    actor: LocalUserRecord,
    input: LocalUserCreateInput,
  ): Promise<LocalUserRecord> {
    const parsed = LocalUserCreateInputSchema.parse(input);
    if (parsed.role === "developer" && actor.role !== "developer") {
      throw new AuthorizationError("只有开发者可以新增开发者账户。");
    }
    const password = await hashPassword(parsed.password);
    return this.store.createLocalUser({
      username: parsed.username,
      displayName: parsed.displayName,
      role: parsed.role,
      ...password,
    });
  }

  updateUser(
    actor: LocalUserRecord,
    userId: string,
    input: LocalUserUpdateInput,
  ): LocalUserRecord {
    const parsed = LocalUserUpdateInputSchema.parse(input);
    const target = this.store.getStoredLocalUser(userId);
    if (!target) throw new AuthenticationError("本机账户不存在。");
    if (
      (target.role === "developer" || parsed.role === "developer") &&
      actor.role !== "developer"
    ) {
      throw new AuthorizationError("只有开发者可以修改开发者账户。");
    }
    if (actor.id === userId && !parsed.enabled) {
      throw new AuthorizationError("不能停用当前登录账户。");
    }
    if (
      target.role === "developer" &&
      (!parsed.enabled || parsed.role !== "developer") &&
      this.store
        .listLocalUsers()
        .filter((user) => user.role === "developer" && user.enabled).length <= 1
    ) {
      throw new AuthorizationError("至少保留一个启用的开发者账户。");
    }
    const updated = this.store.updateLocalUser(userId, parsed);
    if (!updated) throw new AuthenticationError("本机账户不存在。");
    return updated;
  }

  async changePassword(
    actor: LocalUserRecord,
    input: PasswordChangeInput,
  ): Promise<void> {
    const parsed = PasswordChangeInputSchema.parse(input);
    const stored = this.store.getStoredLocalUser(actor.id);
    if (
      !stored ||
      !(await verifyPassword(
        parsed.currentPassword,
        stored.passwordSalt,
        stored.passwordHash,
      ))
    ) {
      throw new AuthenticationError("当前密码不正确。");
    }
    const password = await hashPassword(parsed.newPassword);
    this.store.updateLocalUserPassword(
      actor.id,
      password.passwordHash,
      password.passwordSalt,
    );
  }

  private createSession(user: LocalUserRecord): CreatedSession {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const csrfToken = randomBytes(24).toString("base64url");
    const now = new Date();
    this.store.createAuthSession({
      id: randomBytes(16).toString("hex"),
      userId: user.id,
      tokenHash,
      csrfToken,
      expiresAt: new Date(now.getTime() + this.sessionLifetimeMs).toISOString(),
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
    });
    return {
      token,
      tokenHash,
      csrfToken,
      user,
      permissions: permissionsForRole(user.role),
    };
  }

  private assertLoginAllowed(key: string): void {
    const attempt = this.loginAttempts.get(key);
    if (!attempt) return;
    if (Date.now() >= attempt.resetAt) {
      this.loginAttempts.delete(key);
      return;
    }
    if (attempt.failures >= MAX_LOGIN_FAILURES) {
      throw new LoginRateLimitError("登录失败次数过多，请 15 分钟后再试。");
    }
  }

  private recordLoginFailure(key: string): void {
    const existing = this.loginAttempts.get(key);
    const now = Date.now();
    this.loginAttempts.set(key, {
      failures: existing && existing.resetAt > now ? existing.failures + 1 : 1,
      resetAt: existing && existing.resetAt > now
        ? existing.resetAt
        : now + LOGIN_WINDOW_MS,
    });
  }
}

async function hashPassword(password: string): Promise<{
  passwordHash: string;
  passwordSalt: string;
}> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return {
    passwordHash: derived.toString("base64"),
    passwordSalt: salt.toString("base64"),
  };
}

async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string,
): Promise<boolean> {
  try {
    const expected = Buffer.from(expectedHash, "base64");
    const actual = (await scrypt(
      password,
      Buffer.from(salt, "base64"),
      expected.length,
    )) as Buffer;
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const authCookie = {
  name: "tk_auto_session",
  maxAgeSeconds: DEFAULT_SESSION_LIFETIME_MS / 1000,
};
