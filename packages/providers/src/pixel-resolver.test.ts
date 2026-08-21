import { describe, expect, it } from "vitest";
import { defaultCreationPresetConfig, type ProviderEntity } from "@tk-auto/core";
import {
  resolveLegacyTargetAccountPixelId,
  resolveLivePixelDirectoryId,
} from "./pixel-resolver.js";

function adGroup(
  id: string,
  pixelId: string,
  pixelName: string,
  pixelCode?: string,
): ProviderEntity {
  return {
    entityType: "ad-group",
    externalId: id,
    payload: {
      objective_type: 3,
      optimize_goal: 100,
      external_action: 96,
      ad_ref_pixel_id: pixelId,
      ad_pixel_name: pixelName,
      ...(pixelCode ? { pixel_code: pixelCode } : {}),
    },
  };
}

describe("resolveTargetAccountPixelId", () => {
  const directoryPage = (
    pixelList: Array<Record<string, unknown>>,
    page = 1,
    pageCount = 1,
  ) => ({
    code: 0,
    data: { pixel_list: pixelList, pagination: { page, page_count: pageCount } },
  });

  it("resolves a newly added Pixel Code from the live directory without ad history", () => {
    expect(resolveLivePixelDirectoryId([
      directoryPage([{
        pixel_id: "7542379322273447954",
        pixel_name: "纵恣-lsh",
        pixel_code: "D2LUO4BC77U67ECJGK00",
      }]),
    ], "d2luo4bc77u67ecjgk00")).toBe("7542379322273447954");
  });

  it("resolves an exact name from later live-directory pages", () => {
    expect(resolveLivePixelDirectoryId([
      directoryPage([], 1, 2),
      directoryPage([{
        pixel_id: "7542379322273447954",
        pixel_name: "纵恣-lsh",
        pixel_code: "D2LUO4BC77U67ECJGK00",
      }], 2, 2),
    ], "纵恣-lsh")).toBe("7542379322273447954");
  });

  it("returns an execution error instead of guessing an unknown selector", () => {
    expect(() => resolveLivePixelDirectoryId([
      directoryPage([{
        pixel_id: "7542379322273447954",
        pixel_name: "纵恣-lsh",
        pixel_code: "D2LUO4BC77U67ECJGK00",
      }]),
    ], "missing-pixel")).toThrow("实时像素目录未找到");
  });

  it("keeps the objective-based account fallback for a legacy numeric preset", () => {
    expect(resolveLegacyTargetAccountPixelId([
      adGroup("adgroup-1", "7542379322273447954", "当前账户像素"),
      adGroup("adgroup-2", "7542379322273447954", "当前账户像素"),
    ], {
      ...defaultCreationPresetConfig,
      pixelKey: undefined,
      pixelId: "old-account-pixel",
    })).toBe("7542379322273447954");
  });
});
