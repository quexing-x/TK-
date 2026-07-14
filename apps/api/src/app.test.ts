import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationStore } from "@tk-auto/storage";
import { createApp } from "./app.js";
import type { FastifyInstance } from "fastify";
import { InMemoryCredentialVault } from "@tk-auto/credentials";

describe("local API", () => {
  let store: AutomationStore;
  let app: FastifyInstance;
  let vault: InMemoryCredentialVault;

  beforeEach(async () => {
    store = new AutomationStore(":memory:");
    store.seed();
    vault = new InMemoryCredentialVault();
    app = await createApp({ store, vault });
  });

  afterEach(async () => {
    await app.close();
    store.close();
    vi.restoreAllMocks();
  });

  it("returns bootstrap configuration", async () => {
    const response = await app.inject({ method: "GET", url: "/api/bootstrap" });

    expect(response.statusCode).toBe(200);
    expect(response.json().accounts).toHaveLength(1);
    expect(response.json().providers).toHaveLength(2);
  });

  it("updates automation switches", async () => {
    const existing = await app.inject({
      method: "GET",
      url: "/api/accounts/demo-account/switches",
    });
    const body = existing.json();
    body.closeNoConversion = true;

    const response = await app.inject({
      method: "PUT",
      url: "/api/accounts/demo-account/switches",
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().closeNoConversion).toBe(true);
  });

  it("stores provider settings and an encrypted credential reference", async () => {
    const settings = await app.inject({
      method: "PUT",
      url: "/api/accounts/demo-account/connections/cookie/settings",
      payload: {
        kind: "cookie",
        advertiserId: "123",
        healthUrl: "https://ads.tiktok.com/api/read-only",
        campaignsUrl: "",
        adGroupsUrl: "",
        adsUrl: "",
      },
    });
    expect(settings.statusCode).toBe(200);

    const credential = await app.inject({
      method: "PUT",
      url: "/api/accounts/demo-account/connections/cookie/credential",
      payload: {
        kind: "cookie",
        cookie: "sessionid=authorized-test-cookie",
        csrfHeaderName: "x-csrftoken",
      },
    });
    expect(credential.statusCode).toBe(200);
    expect(credential.json().hasCredential).toBe(true);
    expect(credential.json()).not.toHaveProperty("credentialRef");
    expect(JSON.stringify(credential.json())).not.toContain("authorized-test-cookie");
  });

  it("imports one cURL command, encrypts secrets, and tests the connection", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { list: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const command = `curl 'https://ads.tiktok.com/api/v4/i18n/statistics/op/adgroup/list/?aadvid=123456&msToken=ephemeral-secret' -H 'cookie: sessionid=authorized-test-cookie' -H 'x-csrftoken: csrf-value' -H 'content-type: application/json' --data-raw '{"page":1}'`;

    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/demo-account/connections/cookie/import-curl",
      payload: { command },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      hasCredential: true,
      status: "ready",
    });
    expect(response.json()).not.toHaveProperty("credentialRef");
    expect(JSON.stringify(response.json())).not.toContain("ephemeral-secret");

    const stored = store.getProviderConnection("demo-account", "cookie");
    expect(JSON.stringify(stored?.settings)).not.toContain("ephemeral-secret");
    expect(await vault.read(stored!.credentialRef!)).toContain(
      "ephemeral-secret",
    );
  });
});
