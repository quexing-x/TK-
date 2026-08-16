import { describe, expect, it } from "vitest";
import { accountIdForPage, canAccessNavigationItem, pageFromHash, pageHash } from "./App";

describe("application navigation contract", () => {
  it("keeps every public hash route address stable", () => {
    expect(pageHash).toEqual({
      overview: "#overview",
      manual: "#manual",
      users: "#users",
      automation: "#automation",
      ads: "#ads",
      analytics: "#analytics",
      "meta-assets": "#meta-assets",
      "meta-rules": "#meta-rules",
      rules: "#rules",
      notifications: "#notifications",
      launch: "#launch",
      maintenance: "#maintenance",
      "system-users": "#system-users",
    });
  });

  it("keeps the legacy account-management bookmark and unknown fallback", () => {
    expect(pageFromHash("#users")).toBe("overview");
    expect(pageFromHash("#unknown")).toBe("overview");
  });

  it("preserves permission-gated navigation", () => {
    expect(canAccessNavigationItem("system-users", [])).toBe(false);
    expect(canAccessNavigationItem("system-users", ["users:manage"])).toBe(true);
    expect(canAccessNavigationItem("maintenance", [])).toBe(false);
    expect(canAccessNavigationItem("maintenance", ["system:control"])).toBe(true);
    expect(canAccessNavigationItem("ads", [])).toBe(true);
  });

  it("keeps the all-accounts scope local to ads management", () => {
    const accounts = [{ id: "account-a" }, { id: "account-b" }] as Parameters<typeof accountIdForPage>[0];
    expect(accountIdForPage(accounts, "all", "ads")).toBe("all");
    expect(accountIdForPage(accounts, "all", "automation")).toBe("account-a");
    expect(accountIdForPage(accounts, "all", "analytics")).toBe("account-a");
    expect(accountIdForPage(accounts, "account-b", "automation")).toBe("account-b");
  });
});
