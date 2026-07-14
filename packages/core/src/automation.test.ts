import { describe, expect, it } from "vitest";
import {
  AutomationSwitchesSchema,
  automationSwitchDefinitions,
  createDefaultAutomationSwitches,
} from "./automation.js";

describe("automation switches", () => {
  it("defines a value for every switch", () => {
    const defaults = createDefaultAutomationSwitches();

    expect(Object.keys(defaults)).toHaveLength(
      automationSwitchDefinitions.length,
    );
    expect(AutomationSwitchesSchema.parse(defaults)).toEqual(defaults);
  });

  it("enables reading and all three status levels by default", () => {
    const defaults = createDefaultAutomationSwitches();

    expect(defaults.parseCampaigns).toBe(true);
    expect(defaults.parseAdGroups).toBe(true);
    expect(defaults.parseAds).toBe(true);
    expect(defaults.manageCampaignStatus).toBe(true);
    expect(defaults.manageAdGroupStatus).toBe(true);
    expect(defaults.manageAdStatus).toBe(true);
    expect(defaults.deleteAdGroups).toBe(false);
  });
});
