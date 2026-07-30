import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryCredentialVault } from "@tk-auto/credentials";
import { AutomationStore } from "@tk-auto/storage";
import { createApp, requiredPermission } from "./app.js";

const developerPassword = "Local-Developer-2026!";
const viewerPassword = "Local-Viewer-2026!";

describe("local authentication and authorization", () => {
  let store: AutomationStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = new AutomationStore(":memory:");
    store.seed();
    app = await createApp({
      store,
      vault: new InMemoryCredentialVault(),
    });
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  it("requires first-run developer setup and protects the API", async () => {
    const status = await app.inject({ method: "GET", url: "/api/auth/status" });
    expect(status.json()).toMatchObject({
      setupRequired: true,
      authenticated: false,
    });

    const blocked = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(blocked.statusCode).toBe(401);

    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: {
        username: "developer",
        displayName: "本机开发者",
        password: developerPassword,
      },
    });
    expect(setup.statusCode).toBe(201);
    expect(setup.json()).toMatchObject({
      setupRequired: false,
      authenticated: true,
      user: { username: "developer", role: "developer" },
    });
    expect(setup.body).not.toContain(developerPassword);
    expect(setup.headers["set-cookie"]).toContain("HttpOnly");
    expect(setup.headers["set-cookie"]).toContain("SameSite=Strict");
  });

  it("requires confirmation before resetting local login access", async () => {
    await setupDeveloper(app);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      payload: { confirmation: "NO" },
    });
    expect(rejected.statusCode).toBe(400);
    expect(store.countLocalUsers()).toBe(1);

    const reset = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      payload: { confirmation: "RESET" },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({
      setupRequired: true,
      authenticated: false,
    });
    expect(store.countLocalUsers()).toBe(0);
  });

  it("enforces CSRF and role permissions without storing plaintext passwords", async () => {
    const developer = await setupDeveloper(app);
    const noCsrf = await app.inject({
      method: "PUT",
      url: "/api/automation/settings",
      headers: { cookie: developer.cookie },
      payload: { pollingIntervalMinutes: 6, maxActionsPerRun: 15 },
    });
    expect(noCsrf.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/api/local-users",
      headers: developer.headers,
      payload: {
        username: "viewer",
        displayName: "只读用户",
        role: "viewer",
        password: viewerPassword,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(viewerPassword);
    const stored = store.getStoredLocalUserByUsername("viewer");
    expect(stored?.passwordHash).not.toBe(viewerPassword);
    expect(stored?.passwordSalt).toBeTruthy();

    const viewerLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "viewer", password: viewerPassword },
    });
    const viewerCookie = cookieFrom(viewerLogin);
    const viewerCsrf = viewerLogin.json().csrfToken as string;
    const viewerRead = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { cookie: viewerCookie },
    });
    expect(viewerRead.statusCode).toBe(200);

    const viewerWrite = await app.inject({
      method: "PUT",
      url: "/api/automation/settings",
      headers: { cookie: viewerCookie, "x-csrf-token": viewerCsrf },
      payload: { pollingIntervalMinutes: 6, maxActionsPerRun: 15 },
    });
    expect(viewerWrite.statusCode).toBe(403);
    expect(viewerWrite.json().error).toBe("PERMISSION_DENIED");
  });

  it("invalidates existing sessions after changing the password", async () => {
    const developer = await setupDeveloper(app);
    const changed = await app.inject({
      method: "PUT",
      url: "/api/auth/password",
      headers: developer.headers,
      payload: {
        currentPassword: developerPassword,
        newPassword: "Changed-Developer-2026!",
      },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers["set-cookie"]).toContain("Max-Age=0");

    const oldSession = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { cookie: developer.cookie },
    });
    expect(oldSession.statusCode).toBe(401);
  });

  it("uses secure session cookies when HTTPS mode is enabled", async () => {
    const secureStore = new AutomationStore(":memory:");
    secureStore.seed();
    const secureApp = await createApp({
      store: secureStore,
      vault: new InMemoryCredentialVault(),
      secureCookies: true,
    });

    try {
      const setup = await secureApp.inject({
        method: "POST",
        url: "/api/auth/setup",
        payload: {
          username: "secure-developer",
          displayName: "HTTPS 测试开发者",
          password: developerPassword,
        },
      });
      expect(setup.statusCode).toBe(201);
      expect(setup.headers["set-cookie"]).toContain("Secure");
    } finally {
      await secureApp.close();
      secureStore.close();
    }
  });

  it("keeps the 12-hour session default unless the local desktop overrides it", async () => {
    const defaultSetup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: {
        username: "default-session",
        displayName: "默认会话",
        password: developerPassword,
      },
    });
    expect(defaultSetup.headers["set-cookie"]).toContain("Max-Age=43200");

    const desktopStore = new AutomationStore(":memory:");
    desktopStore.seed();
    const desktopApp = await createApp({
      store: desktopStore,
      vault: new InMemoryCredentialVault(),
      authSessionLifetimeMs: 2_147_483_647_000,
      authCookieMaxAgeSeconds: 2_147_483_647,
    });
    try {
      const desktopSetup = await desktopApp.inject({
        method: "POST",
        url: "/api/auth/setup",
        payload: {
          username: "desktop-session",
          displayName: "本地客户端会话",
          password: developerPassword,
        },
      });
      expect(desktopSetup.headers["set-cookie"]).toContain("Max-Age=2147483647");
    } finally {
      await desktopApp.close();
      desktopStore.close();
    }
  });

  it("requires ads operation permission for item-level creation retry", () => {
    expect(requiredPermission(
      "POST",
      "/api/launch-plans/plan-1/items/item-1/retry",
    )).toBe("ads:operate");
  });

  it("requires ads operation permission for status write retry", () => {
    expect(requiredPermission(
      "POST",
      "/api/accounts/account-1/status-operations/operation-1/retry",
    )).toBe("ads:operate");
  });

  it("requires ads operation permission for status write verification", () => {
    expect(requiredPermission(
      "POST",
      "/api/accounts/account-1/status-operations/operation-1/verify",
    )).toBe("ads:operate");
  });

  it("requires automation execution permission for resetting the write circuit", () => {
    expect(requiredPermission(
      "POST",
      "/api/accounts/account-1/write-circuit/reset",
    )).toBe("automation:execute");
  });

  it("restricts maintenance and audit endpoints to system administrators", async () => {
    const developer = await setupDeveloper(app);
    const mutation = await app.inject({
      method: "PUT",
      url: "/api/system/runtime",
      headers: { ...developer.headers, "x-correlation-id": "audit-request-1" },
      payload: { enabled: false },
    });
    expect(mutation.statusCode).toBe(200);

    const audit = await app.inject({
      method: "GET",
      url: "/api/maintenance/audit?action=global.runtime.updated",
      headers: { cookie: developer.cookie },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()[0]).toMatchObject({
      actor: { name: "本机开发者", kind: "user" },
      correlationId: "audit-request-1",
      requestId: expect.any(String),
    });

    await app.inject({
      method: "POST",
      url: "/api/local-users",
      headers: developer.headers,
      payload: {
        username: "maintenance-viewer",
        displayName: "运维只读测试",
        role: "viewer",
        password: viewerPassword,
      },
    });
    const viewerLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "maintenance-viewer", password: viewerPassword },
    });
    const blocked = await app.inject({
      method: "GET",
      url: "/api/maintenance/status",
      headers: { cookie: cookieFrom(viewerLogin) },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("PERMISSION_DENIED");
  });

  it("maps every maintenance read or mutation to system control", () => {
    expect(requiredPermission("GET", "/api/maintenance/status")).toBe("system:control");
    expect(requiredPermission("GET", "/api/maintenance/audit")).toBe("system:control");
    expect(requiredPermission("POST", "/api/maintenance/backups")).toBe("system:control");
    expect(requiredPermission("POST", "/api/maintenance/updates/install")).toBe("system:control");
  });
});

async function setupDeveloper(app: FastifyInstance): Promise<{
  cookie: string;
  headers: { cookie: string; "x-csrf-token": string };
}> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    payload: {
      username: "developer",
      displayName: "本机开发者",
      password: developerPassword,
    },
  });
  const cookie = cookieFrom(response);
  const csrf = response.json().csrfToken as string;
  return {
    cookie,
    headers: { cookie, "x-csrf-token": csrf },
  };
}

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  const header = Array.isArray(value) ? String(value[0]) : String(value);
  return header.split(";", 1)[0] ?? header;
}
