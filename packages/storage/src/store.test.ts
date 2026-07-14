import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultAutomationSwitches } from "@tk-auto/core";
import { AutomationStore } from "./store.js";

describe("AutomationStore", () => {
  let store: AutomationStore;

  beforeEach(() => {
    store = new AutomationStore(":memory:");
    store.seed();
  });

  afterEach(() => {
    store.close();
  });

  it("seeds an account and thresholds", () => {
    expect(store.listAccounts()).toHaveLength(1);
    expect(store.listThresholds("demo-account")).toHaveLength(6);
  });

  it("persists automation switches", () => {
    const switches = createDefaultAutomationSwitches();
    switches.closeNoConversion = true;

    store.updateAutomationSwitches("demo-account", switches);

    expect(store.getAutomationSwitches("demo-account").closeNoConversion).toBe(
      true,
    );
  });

  it("keeps cookie and official API connections independent", () => {
    store.saveProviderConnectionSettings("demo-account", {
      kind: "cookie",
      advertiserId: "123",
      healthUrl: "https://ads.tiktok.com/api/read-only",
      campaignsUrl: "",
      adGroupsUrl: "",
      adsUrl: "",
    });
    store.saveProviderConnectionSettings("demo-account", {
      kind: "official-api",
      advertiserId: "456",
    });
    store.setProviderCredentialReference("demo-account", "cookie", "ref-cookie");
    store.setProviderCredentialReference(
      "demo-account",
      "official-api",
      "ref-api",
    );

    const connections = store.listProviderConnections("demo-account");
    expect(connections).toHaveLength(2);
    expect(connections.every((item) => item.hasCredential)).toBe(true);
  });
});
