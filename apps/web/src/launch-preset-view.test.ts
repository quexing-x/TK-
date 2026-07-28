import { describe, expect, it } from "vitest";
import { defaultCreationPresetConfig, type LaunchPresetRecord } from "@tk-auto/core";
import { presetStartLabel } from "./LaunchPage";

const preset = (patch: Partial<LaunchPresetRecord> = {}): LaunchPresetRecord => ({
  id: "preset",
  name: "基础预设",
  region: "US",
  dailyBudget: 100,
  bid: null,
  startAt: null,
  endAt: null,
  startAtRule: "absolute",
  initialStatus: "enabled",
  creationConfig: defaultCreationPresetConfig,
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  ...patch,
});

describe("presetStartLabel", () => {
  it("shows immediate and relative preset timing explicitly", () => {
    expect(presetStartLabel(preset())).toBe("立即");
    expect(presetStartLabel(preset({ startAtRule: "tonight" }))).toContain("当天 24:00");
    expect(presetStartLabel(preset({ startAtRule: "tomorrow-morning" }))).toContain("次日 06:00");
  });
});
