import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web API client", () => {
  it("loads the local bootstrap payload", async () => {
    const payload = { accounts: [], providers: [], switchDefinitions: [] };
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
});
