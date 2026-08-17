import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialVault } from "@tk-auto/credentials";
import { ProviderRegistry, type AdsProvider } from "@tk-auto/providers";
import { AutomationStore } from "@tk-auto/storage";
import { MetaCreationService } from "./meta-creation-service.js";

describe("MetaCreationService", () => {
  let store: AutomationStore;
  let vault: InMemoryCredentialVault;

  beforeEach(() => {
    store = new AutomationStore(":memory:");
    store.seed();
    vault = new InMemoryCredentialVault();
  });

  afterEach(() => {
    store.close();
    vi.restoreAllMocks();
  });

  it("persists each confirmed layer and makes the same request idempotent", async () => {
    const createMetaAd = vi.fn(async (_context, mutation) => {
      expect(typeof mutation.onBeforeDispatch).toBe("function");
      mutation.onBeforeDispatch?.();
      mutation.onProgress?.({
        phase: "campaign",
        campaignId: "120000000000101",
        message: "campaign confirmed",
      });
      mutation.onProgress?.({
        phase: "ad-set",
        campaignId: "120000000000101",
        adSetId: "120000000000102",
        message: "ad set confirmed",
      });
      mutation.onProgress?.({
        phase: "creative",
        campaignId: "120000000000101",
        adSetId: "120000000000102",
        creativeId: "120000000000103",
        message: "creative confirmed",
      });
      mutation.onProgress?.({
        phase: "ad",
        campaignId: "120000000000101",
        adSetId: "120000000000102",
        creativeId: "120000000000103",
        adId: "120000000000104",
        message: "ad confirmed",
      });
      return {
        ok: true,
        campaignId: "120000000000101",
        adSetId: "120000000000102",
        creativeId: "120000000000103",
        adId: "120000000000104",
        message: "done",
      };
    });
    const capabilities = new Set([
      "read-campaigns",
      "read-ad-groups",
      "read-ads",
      "create-campaigns",
    ] as const);
    const provider: AdsProvider = {
      kind: "meta-marketing-api",
      platform: "meta",
      displayName: "fixture Meta",
      implementationStatus: "available",
      capabilityVersion: "fixture-meta-create-v1",
      capabilities,
      resolveCapabilities: () => capabilities,
      checkHealth: async () => ({ ok: true, status: "ready", message: "ready" }),
      createMetaAd,
      syncReadOnly: async () => {
        throw new Error("follow-up sync unavailable");
      },
    };
    const registry = new ProviderRegistry([provider]);
    const account = store.createAccount({
      displayName: "Meta creation fixture",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "meta-marketing-api",
    });
    const profile = store.createMetaAccessProfile({
      name: "fixture profile",
      appId: "100000000000001",
      businessId: null,
      graphApiVersion: "v25.0",
    });
    const reference = await vault.create(JSON.stringify({
      appSecret: "fixture-app-secret-with-enough-length",
      accessToken: "fixture-user-access-token-with-enough-length",
    }));
    store.setMetaAccessProfileSecretReference(profile.id, reference);
    store.saveProviderConnectionSettings(account.id, {
      kind: "meta-marketing-api",
      profileId: profile.id,
      adAccountId: "act_300000000000003",
      pageId: "400000000000004",
      liveMode: "read-only",
      allowedStatusEntityTypes: [],
      creationMode: "paused-only",
    });
    store.updateProviderStatus(account.id, "meta-marketing-api", "ready", "ready");
    store.updateProviderAuthorization(account.id, "meta-marketing-api", {
      status: "active",
      capabilityVersion: provider.capabilityVersion,
      capabilities: [...capabilities],
    });
    const service = new MetaCreationService(store, vault, registry);
    const input = {
      idempotencyKey: "meta-create-service-0001",
      campaignName: "campaign",
      adSetName: "ad set",
      creativeName: "creative",
      adName: "ad",
      objective: "OUTCOME_TRAFFIC" as const,
      optimizationGoal: "LINK_CLICKS" as const,
      billingEvent: "IMPRESSIONS" as const,
      destinationType: "WEBSITE" as const,
      dailyBudgetMinorUnits: 500,
      countries: ["US"],
      destinationUrl: "https://example.com/product",
      primaryText: "primary text",
      headline: "headline",
      description: "description",
      callToAction: "LEARN_MORE" as const,
      imageHash: null,
    };

    const first = await service.execute(account.id, input);
    const second = await service.execute(account.id, input);
    expect(first).toMatchObject({
      status: "succeeded",
      phase: "completed",
      input: { targetLevel: "ad" },
      campaignId: "120000000000101",
      adSetId: "120000000000102",
      creativeId: "120000000000103",
      adId: "120000000000104",
    });
    expect(second.id).toBe(first.id);
    expect(createMetaAd).toHaveBeenCalledTimes(1);
    await expect(service.execute(account.id, {
      ...input,
      headline: "different headline",
    })).rejects.toThrow("相同幂等键已用于不同的 Meta 创建请求");
    expect(createMetaAd).toHaveBeenCalledTimes(1);
  });

  it("keeps unknown creation locked until read-only reconciliation proves a safe resume point", async () => {
    const createMetaAd = vi.fn(async (_context, mutation) => {
      if (mutation.existing.creativeId) {
        mutation.onProgress?.({
          phase: "ad",
          campaignId: mutation.existing.campaignId,
          adSetId: mutation.existing.adSetId,
          creativeId: mutation.existing.creativeId,
          adId: "120000000000204",
          message: "ad confirmed",
        });
        return {
          ok: true,
          ...mutation.existing,
          adId: "120000000000204",
          message: "ad confirmed",
        };
      }
      return {
        ok: false,
        campaignId: "120000000000201",
        adSetId: "120000000000202",
        creativeId: "120000000000203",
        failureKind: "unknown" as const,
        message: "ad dispatch result unknown",
      };
    });
    const reconcileMetaAd = vi.fn(async () => ({
      ok: false,
      campaignId: "120000000000201",
      adSetId: "120000000000202",
      creativeId: "120000000000203",
      failureKind: "retryable" as const,
      message: "ad confirmed absent",
    }));
    const capabilities = new Set([
      "read-campaigns",
      "read-ad-groups",
      "read-ads",
      "create-campaigns",
    ] as const);
    const provider: AdsProvider = {
      kind: "meta-marketing-api",
      platform: "meta",
      displayName: "fixture Meta",
      implementationStatus: "available",
      capabilityVersion: "fixture-meta-reconcile-v1",
      capabilities,
      resolveCapabilities: () => capabilities,
      checkHealth: async () => ({ ok: true, status: "ready", message: "ready" }),
      createMetaAd,
      reconcileMetaAd,
    };
    const account = store.createAccount({
      displayName: "Meta reconcile fixture",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "meta-marketing-api",
    });
    const profile = store.createMetaAccessProfile({
      name: "fixture reconcile profile",
      appId: "100000000000002",
      businessId: null,
      graphApiVersion: "v25.0",
    });
    store.setMetaAccessProfileSecretReference(profile.id, await vault.create(JSON.stringify({
      appSecret: "fixture-app-secret-with-enough-length",
      accessToken: "fixture-user-access-token-with-enough-length",
    })));
    store.saveProviderConnectionSettings(account.id, {
      kind: "meta-marketing-api",
      profileId: profile.id,
      adAccountId: "act_300000000000003",
      pageId: "400000000000004",
      liveMode: "read-only",
      allowedStatusEntityTypes: [],
      creationMode: "paused-only",
    });
    store.updateProviderStatus(account.id, "meta-marketing-api", "ready", "ready");
    store.updateProviderAuthorization(account.id, "meta-marketing-api", {
      status: "active",
      capabilityVersion: provider.capabilityVersion,
      capabilities: [...capabilities],
    });
    const service = new MetaCreationService(store, vault, new ProviderRegistry([provider]));
    const input = {
      idempotencyKey: "meta-create-reconcile-0001",
      campaignName: "campaign",
      adSetName: "ad set",
      creativeName: "creative",
      adName: "ad",
      objective: "OUTCOME_TRAFFIC" as const,
      optimizationGoal: "LINK_CLICKS" as const,
      billingEvent: "IMPRESSIONS" as const,
      destinationType: "WEBSITE" as const,
      dailyBudgetMinorUnits: 500,
      countries: ["US"],
      destinationUrl: "https://example.com/product",
      primaryText: "primary text",
      headline: "headline",
      description: "",
      callToAction: "LEARN_MORE" as const,
      imageHash: null,
    };

    const unknown = await service.execute(account.id, input);
    await expect(service.execute(account.id, input)).resolves.toMatchObject({
      id: unknown.id,
      status: "unknown",
    });
    const reconciled = await service.reconcile(account.id, unknown.id);
    expect(reconciled).toMatchObject({
      status: "failed",
      phase: "creative",
      campaignId: "120000000000201",
      adSetId: "120000000000202",
      creativeId: "120000000000203",
    });
    const retried = await service.execute(account.id, input);
    expect(retried).toMatchObject({
      status: "succeeded",
      phase: "completed",
      campaignId: "120000000000201",
      adSetId: "120000000000202",
      creativeId: "120000000000203",
      adId: "120000000000204",
    });
    expect(reconcileMetaAd).toHaveBeenCalledTimes(1);
    expect(createMetaAd).toHaveBeenCalledTimes(2);
    expect(createMetaAd.mock.calls[1]?.[1].existing).toEqual({
      campaignId: "120000000000201",
      adSetId: "120000000000202",
      creativeId: "120000000000203",
    });
  });

  it("finishes at Ad Set and safely reconciles an uncertain two-level dispatch before retry", async () => {
    let uncertainAdSetDispatches = 0;
    const createMetaAd = vi.fn(async (_context, mutation) => {
      mutation.onBeforeDispatch?.();
      mutation.onProgress?.({
        phase: "campaign",
        campaignId: "120000000000301",
        message: "campaign confirmed",
      });
      if (
        mutation.input.idempotencyKey.includes("uncertain-adset")
        && uncertainAdSetDispatches++ === 0
      ) {
        mutation.onBeforeDispatch?.();
        throw new Error("ad set response interrupted after dispatch");
      }
      if (createMetaAd.mock.calls.length === 1) {
        return {
          ok: false,
          campaignId: "120000000000301",
          failureKind: "unknown" as const,
          message: "ad set dispatch result unknown",
        };
      }
      mutation.onProgress?.({
        phase: "ad-set",
        campaignId: "120000000000301",
        adSetId: "120000000000302",
        message: "ad set confirmed",
      });
      return {
        ok: true,
        campaignId: "120000000000301",
        adSetId: "120000000000302",
        message: "two paused layers confirmed",
      };
    });
    const reconcileMetaAd = vi.fn(async (_context, mutation) => {
      if (mutation.existing.adSetId) {
        return {
          ok: true,
          campaignId: mutation.existing.campaignId,
          adSetId: mutation.existing.adSetId,
          message: "two paused layers read back",
        };
      }
      return {
        ok: false,
        campaignId: "120000000000301",
        failureKind: "retryable" as const,
        message: "ad set confirmed absent",
      };
    });
    const capabilities = new Set([
      "read-campaigns",
      "read-ad-groups",
      "create-campaigns",
    ] as const);
    const provider: AdsProvider = {
      kind: "meta-marketing-api",
      platform: "meta",
      displayName: "fixture Meta two-level",
      implementationStatus: "available",
      capabilityVersion: "fixture-meta-two-level-v1",
      capabilities,
      resolveCapabilities: () => capabilities,
      checkHealth: async () => ({ ok: true, status: "ready", message: "ready" }),
      createMetaAd,
      reconcileMetaAd,
      syncReadOnly: async () => {
        throw new Error("follow-up sync unavailable");
      },
    };
    const account = store.createAccount({
      displayName: "Meta two-level fixture",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "meta-marketing-api",
    });
    const profile = store.createMetaAccessProfile({
      name: "fixture two-level profile",
      appId: "100000000000003",
      businessId: null,
      graphApiVersion: "v25.0",
    });
    store.setMetaAccessProfileSecretReference(profile.id, await vault.create(JSON.stringify({
      appSecret: "fixture-app-secret-with-enough-length",
      accessToken: "fixture-user-access-token-with-enough-length",
    })));
    store.saveProviderConnectionSettings(account.id, {
      kind: "meta-marketing-api",
      profileId: profile.id,
      adAccountId: "act_300000000000003",
      pageId: "400000000000004",
      liveMode: "read-only",
      allowedStatusEntityTypes: [],
      creationMode: "paused-only",
    });
    store.updateProviderStatus(account.id, "meta-marketing-api", "ready", "ready");
    store.updateProviderAuthorization(account.id, "meta-marketing-api", {
      status: "active",
      capabilityVersion: provider.capabilityVersion,
      capabilities: [...capabilities],
    });
    const service = new MetaCreationService(store, vault, new ProviderRegistry([provider]));
    const input = {
      targetLevel: "ad-set" as const,
      idempotencyKey: "meta-create-two-level-0001",
      campaignName: "campaign",
      adSetName: "ad set",
      objective: "OUTCOME_TRAFFIC" as const,
      optimizationGoal: "LINK_CLICKS" as const,
      billingEvent: "IMPRESSIONS" as const,
      destinationType: "WEBSITE" as const,
      dailyBudgetMinorUnits: 500,
      countries: ["US"],
    };

    const unknown = await service.execute(account.id, input);
    expect(unknown).toMatchObject({
      status: "unknown",
      phase: "campaign",
      input: { targetLevel: "ad-set" },
      campaignId: "120000000000301",
      adSetId: null,
    });
    await expect(service.execute(account.id, input)).resolves.toMatchObject({
      id: unknown.id,
      status: "unknown",
    });
    expect(createMetaAd).toHaveBeenCalledTimes(1);

    const reconciled = await service.reconcile(account.id, unknown.id);
    expect(reconciled).toMatchObject({
      status: "failed",
      phase: "campaign",
      campaignId: "120000000000301",
      adSetId: null,
    });

    const retried = await service.execute(account.id, input);
    expect(retried).toMatchObject({
      status: "succeeded",
      phase: "completed",
      input: { targetLevel: "ad-set" },
      campaignId: "120000000000301",
      adSetId: "120000000000302",
      creativeId: null,
      adId: null,
      attemptCount: 2,
    });
    expect(reconcileMetaAd).toHaveBeenCalledTimes(1);
    expect(createMetaAd).toHaveBeenCalledTimes(2);
    expect(createMetaAd.mock.calls[1]?.[1].existing).toEqual({
      campaignId: "120000000000301",
    });

    const alreadyReachedInput = {
      ...input,
      idempotencyKey: "meta-create-two-level-reached-0002",
    };
    const alreadyReached = store.createMetaCreationTask(account.id, alreadyReachedInput);
    store.claimMetaCreationTask(alreadyReached.id);
    store.updateMetaCreationProgress(alreadyReached.id, {
      phase: "ad-set",
      campaignId: "120000000000311",
      adSetId: "120000000000312",
      message: "two layers confirmed before local failure",
    });
    store.completeMetaCreationTask(alreadyReached.id, "failed", "legacy downstream failure");

    await expect(service.execute(account.id, alreadyReachedInput)).resolves.toMatchObject({
      status: "succeeded",
      phase: "completed",
      campaignId: "120000000000311",
      adSetId: "120000000000312",
      creativeId: null,
      adId: null,
      attemptCount: 2,
    });
    expect(createMetaAd).toHaveBeenCalledTimes(2);
    expect(reconcileMetaAd).toHaveBeenCalledTimes(2);

    const uncertainAdSetInput = {
      ...input,
      idempotencyKey: "meta-create-two-level-uncertain-adset-0003",
    };
    const uncertain = await service.execute(account.id, uncertainAdSetInput);
    expect(uncertain).toMatchObject({
      status: "unknown",
      phase: "campaign",
      campaignId: "120000000000301",
      adSetId: null,
      creativeId: null,
      adId: null,
    });
    expect(createMetaAd).toHaveBeenCalledTimes(3);
    await expect(service.execute(account.id, uncertainAdSetInput)).resolves.toMatchObject({
      id: uncertain.id,
      status: "unknown",
    });
    expect(createMetaAd).toHaveBeenCalledTimes(3);

    await expect(service.reconcile(account.id, uncertain.id)).resolves.toMatchObject({
      status: "failed",
      phase: "campaign",
      campaignId: "120000000000301",
      adSetId: null,
    });

    await expect(service.execute(account.id, uncertainAdSetInput)).resolves.toMatchObject({
      status: "succeeded",
      phase: "completed",
      campaignId: "120000000000301",
      adSetId: "120000000000302",
      creativeId: null,
      adId: null,
    });
    expect(createMetaAd).toHaveBeenCalledTimes(4);
    expect(reconcileMetaAd).toHaveBeenCalledTimes(3);
  });

  it("fails stale running tasks closed to unknown before any replay", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-17T00:00:00.000Z"));
      const account = store.createAccount({
        displayName: "Meta interrupted fixture",
        platform: "meta",
        accountType: "standard",
        enabled: false,
        providerKind: "meta-marketing-api",
      });
      const input = {
        idempotencyKey: "meta-create-interrupted-0001",
        campaignName: "campaign",
        adSetName: "ad set",
        creativeName: "creative",
        adName: "ad",
        objective: "OUTCOME_TRAFFIC" as const,
        optimizationGoal: "LINK_CLICKS" as const,
        billingEvent: "IMPRESSIONS" as const,
        destinationType: "WEBSITE" as const,
        dailyBudgetMinorUnits: 500,
        countries: ["US"],
        destinationUrl: "https://example.com/product",
        primaryText: "primary text",
        headline: "headline",
        description: "",
        callToAction: "LEARN_MORE" as const,
        imageHash: null,
      };
      const task = store.createMetaCreationTask(account.id, input);
      store.claimMetaCreationTask(task.id);

      vi.setSystemTime(new Date("2026-08-17T00:31:00.000Z"));
      const createMetaAd = vi.fn();
      const service = new MetaCreationService(
        store,
        vault,
        new ProviderRegistry([{
          kind: "meta-marketing-api",
          platform: "meta",
          displayName: "fixture Meta",
          implementationStatus: "available",
          capabilityVersion: "fixture-meta-interrupted-v1",
          capabilities: new Set(["create-campaigns"] as const),
          checkHealth: async () => ({ ok: true, status: "ready", message: "ready" }),
          createMetaAd,
        }]),
      );

      expect(store.getMetaCreationTask(task.id)).toMatchObject({
        status: "unknown",
        attemptCount: 1,
      });
      await expect(service.execute(account.id, input)).resolves.toMatchObject({
        id: task.id,
        status: "unknown",
      });
      expect(createMetaAd).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
