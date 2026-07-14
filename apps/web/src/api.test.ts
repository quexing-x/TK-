import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

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
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
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
});
