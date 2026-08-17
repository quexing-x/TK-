import { describe, expect, it } from "vitest";
import {
  AccountConfigSchema,
  AccountCreateInputSchema,
  platformForProvider,
  providerBelongsToPlatform,
} from "./account.js";

describe("advertising platform account model", () => {
  it("keeps legacy TikTok provider inputs compatible when platform is omitted", () => {
    const input = AccountCreateInputSchema.parse({
      displayName: "TikTok legacy account",
      accountType: "standard",
      enabled: false,
      providerKind: "cookie",
    });

    expect(input.platform).toBeUndefined();
    expect(platformForProvider(input.providerKind)).toBe("tiktok");
  });

  it("accepts a disabled Meta offline account and rejects automatic execution", () => {
    expect(AccountCreateInputSchema.parse({
      displayName: "Meta internal scaffold",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "meta-offline",
    })).toMatchObject({ platform: "meta", providerKind: "meta-offline" });

    expect(() => AccountCreateInputSchema.parse({
      displayName: "Unsafe Meta account",
      platform: "meta",
      accountType: "standard",
      enabled: true,
      providerKind: "meta-offline",
    })).toThrow("Meta 离线架构不能开启账户自动化");
  });

  it("allows automation only for the real Meta Marketing API provider", () => {
    expect(platformForProvider("meta-marketing-api")).toBe("meta");
    expect(providerBelongsToPlatform("meta", "meta-marketing-api")).toBe(true);
    expect(AccountCreateInputSchema.parse({
      displayName: "Meta read-only account",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "meta-marketing-api",
    })).toMatchObject({ providerKind: "meta-marketing-api" });
    expect(AccountCreateInputSchema.parse({
      displayName: "Meta automation account",
      platform: "meta",
      accountType: "standard",
      enabled: true,
      providerKind: "meta-marketing-api",
    })).toMatchObject({ enabled: true, providerKind: "meta-marketing-api" });
  });

  it("does not allow a provider to cross platform boundaries", () => {
    expect(providerBelongsToPlatform("meta", "official-api")).toBe(false);
    expect(() => AccountCreateInputSchema.parse({
      displayName: "Wrong provider",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "official-api",
    })).toThrow("接入方式与广告平台不匹配");
  });

  it("rejects inconsistent persisted account configurations", () => {
    const base = {
      id: "meta-account",
      displayName: "Meta",
      platform: "meta" as const,
      accountType: "standard" as const,
      enabled: false,
      providerKind: "meta-offline" as const,
      credentialRef: null,
      timezone: "UTC",
      pollingIntervalMinutes: 5,
      maxActionsPerRun: 15,
      updatedAt: "2026-08-12T00:00:00.000Z",
    };

    expect(AccountConfigSchema.safeParse(base).success).toBe(true);
    expect(AccountConfigSchema.safeParse({ ...base, providerKind: "cookie" }).success).toBe(false);
    expect(AccountConfigSchema.safeParse({ ...base, enabled: true }).success).toBe(false);
  });
});
