import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  META_OFFLINE_UNAVAILABLE_MESSAGE,
  MetaOfflineAdsProvider,
  MetaOfflineProviderUnavailableError,
} from "./meta-offline-provider.js";
import { ProviderRegistry } from "./registry.js";
import type { ProviderContext } from "./types.js";

const context = {
  accountId: "meta-offline-test",
  settings: {
    kind: "meta-offline",
    businessId: "offline-business",
    adAccountId: "offline-account",
  },
  credential: { kind: "meta-offline" },
} satisfies ProviderContext;

afterEach(() => vi.unstubAllGlobals());

describe("MetaOfflineAdsProvider", () => {
  it("contains no HTTP transport or remote endpoint in the offline module", () => {
    const source = readFileSync(new URL("./meta-offline-provider.ts", import.meta.url), "utf8");

    for (const forbidden of [
      "node:http",
      "node:https",
      "undici",
      "axios",
      "fetch(",
      "http://",
      "https://",
    ]) {
      expect(source, `offline provider must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("reports the API as unconnected with no capabilities and no network", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("Meta offline scaffold attempted network access");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new MetaOfflineAdsProvider();

    await expect(provider.checkHealth(context)).resolves.toEqual({
      ok: false,
      status: "failed",
      message: META_OFFLINE_UNAVAILABLE_MESSAGE,
    });
    expect(provider.resolveCapabilities()).toEqual(new Set());
    expect([...provider.capabilities]).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects every provider operation locally without calling fetch", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("Meta offline scaffold attempted network access");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new MetaOfflineAdsProvider();
    const calls: Array<() => Promise<unknown>> = [
      () => provider.syncReadOnly(context),
      () => provider.readAdGroupOriginalPosts(context, { campaignId: "c1", adGroupId: "g1" }),
      () => provider.readAccessibleOriginalPosts(context, []),
      () => provider.changeStatus(context, []),
      () => provider.create(context, []),
      () => provider.copy(context, []),
      () => provider.appeal(context, []),
      () => provider.deleteAdGroups(context, []),
    ];

    for (const call of calls) {
      const result = call();
      await expect(result).rejects.toBeInstanceOf(MetaOfflineProviderUnavailableError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps registry health and sync paths offline and scaffolded", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("Meta offline scaffold attempted network access");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const registry = new ProviderRegistry();

    await expect(registry.checkHealth("meta-offline", context)).resolves.toMatchObject({
      ok: false,
      status: "failed",
      message: expect.stringContaining("尚未接入"),
    });
    expect(() => registry.syncReadOnly("meta-offline", context)).toThrow();
    await expect(registry.readAdGroupOriginalPosts(
      "meta-offline",
      context,
      { campaignId: "c1", adGroupId: "g1" },
    )).rejects.toThrow();
    await expect(registry.readAccessibleOriginalPosts(
      "meta-offline",
      context,
      [],
    )).rejects.toThrow();
    expect(() => registry.changeStatus("meta-offline", context, [])).toThrow();
    expect(() => registry.deleteAdGroups("meta-offline", context, [])).toThrow();
    await expect(registry.create("meta-offline", context, [])).rejects.toThrow();
    await expect(registry.copy("meta-offline", context, [])).rejects.toThrow();
    await expect(registry.copyAdGroupToExistingCampaign("meta-offline", context, {
      sourceAdGroupId: "g1",
      existingCampaignId: "c1",
      names: [],
      initialStatus: "disabled",
    })).rejects.toThrow();
    await expect(registry.copyCampaign("meta-offline", context, {
      sourceCampaignId: "c1",
      campaignName: "offline",
      adGroups: [],
      initialStatus: "disabled",
    })).rejects.toThrow();
    await expect(registry.createFromPreset("meta-offline", context, [])).rejects.toThrow();
    expect(registry.list()).toContainEqual(expect.objectContaining({
      kind: "meta-offline",
      platform: "meta",
      implementationStatus: "scaffolded",
      capabilities: [],
    }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
