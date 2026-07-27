import { afterEach, describe, expect, it, vi } from "vitest";
import { api, onUnauthorized, setAuthSession } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web API client", () => {
  it("loads the local bootstrap payload", async () => {
    const payload = {
      accounts: [],
      providers: [],
      globalAutomationSettings: {
        pollingIntervalMinutes: 5,
        maxActionsPerRun: 15,
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(api.bootstrap()).resolves.toEqual(payload);
    expect(fetch).toHaveBeenCalledWith(
      "/api/bootstrap",
      expect.objectContaining({
        headers: expect.not.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("does not send an empty JSON body header for automation preview", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.previewAutomation("account-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/accounts/account-1/automation/preview",
      expect.objectContaining({
        method: "POST",
        headers: expect.not.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("deletes an advertising account through the account endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.deleteAccount("account-1")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/accounts/account-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("loads and bulk-restores manual ad-group takeovers", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ restoredCount: 2 }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.getManualTakeovers("account-1");
    await expect(api.restoreAllManualTakeovers("account-1")).resolves.toEqual({ restoredCount: 2 });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/accounts/account-1/manual-takeovers",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/accounts/account-1/manual-takeovers",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("loads account-scoped provider capabilities", async () => {
    const payload = {
      accountId: "account-1",
      providerKind: "cookie",
      providerDisplayName: "Cookie",
      capabilityVersion: "cookie-v2",
      authorizationStatus: "active",
      authorizedAt: "2026-07-18T00:00:00.000Z",
      authorizationExpiresAt: null,
      capabilities: [{ capability: "create-campaigns", available: true, reason: "available" }],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getAccountCapabilities("account-1")).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/accounts/account-1/capabilities",
      expect.any(Object),
    );
  });

  it("surfaces a local API error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "配置保存失败。" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(api.bootstrap()).rejects.toThrow("配置保存失败。");
  });

  it("clears local authentication and notifies the app when logout finds an expired session", async () => {
    const unauthorized = vi.fn();
    const unsubscribe = onUnauthorized(unauthorized);
    setAuthSession({
      setupRequired: false,
      authenticated: true,
      user: null,
      permissions: [],
      csrfToken: "csrf-token",
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "session expired" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.logout()).rejects.toThrow("session expired");
    expect(unauthorized).toHaveBeenCalledTimes(1);

    await api.previewAutomation("account-1");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/accounts/account-1/automation/preview",
      expect.objectContaining({
        headers: expect.not.objectContaining({ "x-csrf-token": "csrf-token" }),
      }),
    );
    unsubscribe();
  });

  it("sends the selected Cookie onboarding step", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ready" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.importCookieCurl("account-1", "curl 'https://ads.tiktok.com/'", "status");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/accounts/account-1/connections/cookie/import-curl",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          command: "curl 'https://ads.tiktok.com/'",
          step: "status",
        }),
      }),
    );
  });

  it("stores notification settings without sending credentials in the same request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: "wecom",
          settings: { kind: "wecom", enabled: true, mentionAll: false },
          hasCredential: false,
          status: "not-configured",
          lastMessage: null,
          lastTestedAt: null,
          updatedAt: "2026-07-15T00:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.saveNotificationSettings("wecom", {
      kind: "wecom",
      enabled: true,
      mentionAll: false,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notifications/channels/wecom/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          kind: "wecom",
          enabled: true,
          mentionAll: false,
        }),
      }),
    );
  });

  it("sends notification credentials only to the credential endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ kind: "wecom", hasCredential: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.saveNotificationCredential("wecom", {
      kind: "wecom",
      webhookUrl:
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notifications/channels/wecom/credential",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("resets the account-scoped provider write circuit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        todayUsage: 0,
        circuit: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.resetWriteCircuit("account-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/accounts/account-1/write-circuit/reset",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("requests a server-verified copy preview before creating a migration plan", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "preview-1", safeToCreate: true }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      sourceAccountId: "source-account",
      sourceAdGroupId: "source-ad",
      targetAccountIds: ["target-account"],
      launchPresetId: "preset-1",
      launchRows: [{
        rowNumber: 2,
        campaignName: "campaign",
        adGroupName: "group",
        adName: "260718:001",
        videoCode: "video-1",
        productUrl: "https://example.com/product",
        region: "US",
        dailyBudget: 100,
        bid: null,
        startAt: null,
        endAt: null,
        initialStatus: "disabled" as const,
      }],
    };

    await api.createLaunchCopyPreview(input);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/launch-plans/copy-preview",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
    );
  });

  it("loads persisted queued plan ids so a reloaded page can resume progress polling", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(["plan-1", "plan-2"]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getQueuedLaunchPlanIds()).resolves.toEqual(["plan-1", "plan-2"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/launch-plans/queued", expect.any(Object));
  });

  it("uses the maintenance endpoints for audit, backup, restore, and signed updates", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.getMaintenanceStatus();
    await api.getAuditLogs({ action: "write-task", correlationId: "corr-1", limit: 25 });
    await api.getDatabaseBackups();
    await api.createDatabaseBackup();
    await api.verifyDatabaseBackup("backup-1");
    await api.requestDatabaseRestore("backup-1");
    await api.checkForUpdates();
    await api.downloadUpdate();
    await api.installUpdate();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/maintenance/status",
      "/api/maintenance/audit?action=write-task&correlationId=corr-1&limit=25",
      "/api/maintenance/backups",
      "/api/maintenance/backups",
      "/api/maintenance/backups/backup-1/verify",
      "/api/maintenance/backups/backup-1/restore",
      "/api/maintenance/updates/check",
      "/api/maintenance/updates/download",
      "/api/maintenance/updates/install",
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/maintenance/backups", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(6, "/api/maintenance/backups/backup-1/restore", expect.objectContaining({ method: "POST" }));
  });
});
