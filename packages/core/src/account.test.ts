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

});
