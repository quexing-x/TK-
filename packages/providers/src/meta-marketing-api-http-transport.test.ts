import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaMarketingApiHttpTransport } from "./meta-marketing-api-http-transport.js";
import {
  MetaMarketingApiMutationRejectedError,
  MetaMarketingApiMutationUnknownError,
} from "./meta-marketing-api-provider.js";

const STATUS_TEST_OBJECT_ID = "120000000000001";
const APP_SECRET_PROOF = "a".repeat(64);

afterEach(() => vi.unstubAllGlobals());

describe("MetaMarketingApiHttpTransport", () => {
  it("uses the fixed Graph origin and keeps the token out of the URL", async () => {
    const fetchMock = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response(JSON.stringify({ id: "123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new MetaMarketingApiHttpTransport([STATUS_TEST_OBJECT_ID]);

    await expect(transport.get({
      version: "v26.0",
      path: "act_123",
      params: { fields: "id,name" },
      accessToken: "fixture-sensitive-token",
      appSecretProof: APP_SECRET_PROOF,
    })).resolves.toEqual({ id: "123" });

    await expect(transport.get({
      version: "v26.0",
      path: "act_123/insights",
      params: { fields: "campaign_id,spend", date_preset: "today", level: "campaign" },
      accessToken: "fixture-sensitive-token",
      appSecretProof: APP_SECRET_PROOF,
    })).resolves.toEqual({ id: "123" });

    await expect(transport.get({
      version: "v26.0",
      path: "123/owned_ad_accounts",
      params: { fields: "id,name,currency,timezone_name,account_status" },
      accessToken: "fixture-sensitive-token",
      appSecretProof: APP_SECRET_PROOF,
    })).resolves.toEqual({ id: "123" });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `https://graph.facebook.com/v26.0/act_123?fields=id%2Cname&appsecret_proof=${APP_SECRET_PROOF}`,
    );
    expect(String(url)).not.toContain("fixture-sensitive-token");
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: expect.objectContaining({
        authorization: "Bearer fixture-sensitive-token",
      }),
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "https://graph.facebook.com/v26.0/act_123/insights?",
    );
  });

  it("posts only an ACTIVE or PAUSED status body without retries", async () => {
    const fetchMock = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new MetaMarketingApiHttpTransport([STATUS_TEST_OBJECT_ID]);

    await expect(transport.post({
      version: "v26.0",
      path: STATUS_TEST_OBJECT_ID,
      body: { status: "PAUSED" },
      accessToken: "fixture-sensitive-token",
      appSecretProof: APP_SECRET_PROOF,
    })).resolves.toEqual({ success: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://graph.facebook.com/v26.0/120000000000001");
    expect(String(init?.body)).toBe(
      `status=PAUSED&appsecret_proof=${APP_SECRET_PROOF}`,
    );
  });

  it("rejects paths and mutation bodies outside the fixed scope before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const transport = new MetaMarketingApiHttpTransport([STATUS_TEST_OBJECT_ID]);

    await expect(transport.get({
      version: "v26.0",
      path: "https://example.com/escape",
      params: {},
      accessToken: "fixture-sensitive-token",
      appSecretProof: APP_SECRET_PROOF,
    })).rejects.toThrow("路径不在允许范围内");
    await expect(transport.post({
      version: "v26.0",
      path: STATUS_TEST_OBJECT_ID,
      body: { budget: "100" },
      accessToken: "fixture-sensitive-token",
      appSecretProof: APP_SECRET_PROOF,
    })).rejects.toBeInstanceOf(MetaMarketingApiMutationRejectedError);
    await expect(transport.post({
      version: "v26.0",
      path: "120000000000009",
      body: { status: "PAUSED" },
      accessToken: "fixture-sensitive-token",
      appSecretProof: APP_SECRET_PROOF,
    })).rejects.toThrow("不在本次对象级 allowlist");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid proof locally without leaking token or proof input", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const transport = new MetaMarketingApiHttpTransport([]);
    const sensitiveInvalidProof = "fixture-app-secret-must-not-leak";
    let message = "";
    try {
      await transport.get({
        version: "v26.0",
        path: "me/adaccounts",
        params: { fields: "id" },
        accessToken: "fixture-sensitive-token",
        appSecretProof: sensitiveInvalidProof,
      });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toContain("appsecret_proof 格式无效");
    expect(message).not.toContain("fixture-sensitive-token");
    expect(message).not.toContain(sensitiveInvalidProof);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies a POST transport loss and 5xx response as unknown", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 2, message: "service unavailable" },
      }), { status: 500, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new MetaMarketingApiHttpTransport([STATUS_TEST_OBJECT_ID]);
    const input = {
      version: "v26.0",
      path: STATUS_TEST_OBJECT_ID,
      body: { status: "PAUSED" },
      accessToken: "fixture-sensitive-token",
      appSecretProof: APP_SECRET_PROOF,
    } as const;

    await expect(transport.post(input))
      .rejects.toBeInstanceOf(MetaMarketingApiMutationUnknownError);
    await expect(transport.post(input))
      .rejects.toBeInstanceOf(MetaMarketingApiMutationUnknownError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("classifies an explicit Graph 4xx rejection as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: 100, error_subcode: 1815007, message: "invalid status" },
    }), { status: 400, headers: { "content-type": "application/json" } })));
    const transport = new MetaMarketingApiHttpTransport([STATUS_TEST_OBJECT_ID]);

    await expect(transport.post({
      version: "v26.0",
      path: STATUS_TEST_OBJECT_ID,
      body: { status: "PAUSED" },
      accessToken: "fixture-sensitive-token",
      appSecretProof: APP_SECRET_PROOF,
    })).rejects.toBeInstanceOf(MetaMarketingApiMutationRejectedError);
  });

  it("blocks a write after observed usage reaches the stop threshold", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "123" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-app-usage": JSON.stringify({ call_count: 95 }),
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new MetaMarketingApiHttpTransport([STATUS_TEST_OBJECT_ID]);
    await transport.get({
      version: "v26.0",
      path: "act_123",
      params: { fields: "id" },
      accessToken: "fixture-sensitive-token",
      appSecretProof: APP_SECRET_PROOF,
    });

    await expect(transport.post({
      version: "v26.0",
      path: STATUS_TEST_OBJECT_ID,
      body: { status: "PAUSED" },
      accessToken: "fixture-sensitive-token",
      appSecretProof: APP_SECRET_PROOF,
    })).rejects.toBeInstanceOf(MetaMarketingApiMutationRejectedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
