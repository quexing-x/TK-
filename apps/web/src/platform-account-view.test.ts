import { describe, expect, it } from "vitest";
import type { AccountConfig, AccountCreateInput } from "@tk-auto/core";
import {
  applyAccountPlatformSelection,
  filterMetaAccounts,
  filterTikTokOperationalAccounts,
} from "./platform-account-view";

describe("platform account view", () => {
  it("keeps Meta accounts out of TikTok operational selectors and totals", () => {
    const accounts = [
      { id: "tiktok-1", platform: "tiktok" },
      { id: "meta-1", platform: "meta" },
    ] as AccountConfig[];

    expect(filterTikTokOperationalAccounts(accounts).map((account) => account.id))
      .toEqual(["tiktok-1"]);
    expect(filterMetaAccounts(accounts).map((account) => account.id))
      .toEqual(["meta-1"]);
  });

  it("forces a Meta draft into the disabled read-only provider shape", () => {
    const draft: AccountCreateInput = {
      displayName: "内部测试",
      platform: "tiktok",
      accountType: "shop",
      enabled: true,
      providerKind: "official-api",
    };

    expect(applyAccountPlatformSelection(draft, "meta")).toEqual({
      displayName: "内部测试",
      platform: "meta",
      accountType: "standard",
      enabled: false,
      providerKind: "meta-marketing-api",
    });
    expect(applyAccountPlatformSelection(
      applyAccountPlatformSelection(draft, "meta"),
      "tiktok",
    )).toMatchObject({
      platform: "tiktok",
      enabled: false,
      providerKind: "cookie",
    });
  });
});
