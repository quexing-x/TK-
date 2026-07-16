import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryCredentialVault } from "@tk-auto/credentials";
import { AutomationStore } from "@tk-auto/storage";
import { createApp } from "./app.js";

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
