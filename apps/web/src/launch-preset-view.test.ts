import { describe, expect, it } from "vitest";
import { defaultCreationPresetConfig, type LaunchPresetRecord } from "@tk-auto/core";
import {
  copyPresetForCustomization,
  nextPresetCopyName,
  presetStartLabel,
  regionLabelForCountryCodes,
} from "./LaunchPage";

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

describe("preset customization", () => {
  it("copies video mappings and generates a non-conflicting preset name", () => {
    const source = preset({
      creationConfig: {
        ...defaultCreationPresetConfig,
        videoPostMappings: [{ videoCode: "video-1", postId: "7663403524864167176" }],
      },
    });
    const copied = copyPresetForCustomization(source, ["基础预设", "基础预设 · 自定义"]);

    expect(copied.name).toBe("基础预设 · 自定义 (2)");
    expect(copied.creationConfig?.videoPostMappings).toEqual([
      { videoCode: "video-1", postId: "7663403524864167176" },
    ]);
    expect(copied.creationConfig?.videoPostMappings)
      .not.toBe(source.creationConfig.videoPostMappings);
  });

  it("keeps the actual region code as the single source of truth", () => {
    expect(regionLabelForCountryCodes([1668284])).toBe("台湾");
    expect(regionLabelForCountryCodes([6252001, 6251999])).toBe("6252001,6251999");
  });

  it("uses the first customization suffix when it is available", () => {
    expect(nextPresetCopyName("基础预设", ["基础预设"]))
      .toBe("基础预设 · 自定义");
  });
});
