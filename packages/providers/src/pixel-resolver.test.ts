import { describe, expect, it } from "vitest";
import { defaultCreationPresetConfig, type ProviderEntity } from "@tk-auto/core";
import {
  resolveAccountPixelIdFromAdGroups,
  resolveLegacyTargetAccountPixelId,
} from "./pixel-resolver.js";

function adGroup(
  id: string,
  pixelId: string,
  pixelName: string,
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
    },
  };
}

describe("从广告组解析数据连接（旧称 Pixel）", () => {
  // 真实账户的形状：同一账户下两个名字相近的数据连接，很容易填错。
  const account = [
    adGroup("adgroup-1", "7542377711428370439", "纵恣-czx"),
    adGroup("adgroup-2", "7542377711428370439", "纵恣-czx"),
    adGroup("adgroup-3", "7542379322273447954", "纵恣-lsh"),
  ];

  it("按名称精确匹配，大小写与首尾空格不影响", () => {
    expect(resolveAccountPixelIdFromAdGroups(account, "纵恣-czx")).toBe("7542377711428370439");
    expect(resolveAccountPixelIdFromAdGroups(account, "  纵恣-LSH  ")).toBe("7542379322273447954");
  });

  it("按数字 ID 精确匹配", () => {
    expect(resolveAccountPixelIdFromAdGroups(account, "7542379322273447954"))
      .toBe("7542379322273447954");
  });

  it("填 Pixel Code 时明确说清楚为什么不行，并列出该账户实际在用的连接", () => {
    // 事件管理器目录接口已对所有账户返回 code 50002，Code 无法在本地比对；
    // 这里必须把话说透，否则用户只会反复重试同一个填法。
    let message = "";
    try {
      resolveAccountPixelIdFromAdGroups(account, "D2LUO4BC77U67ECJGK00");
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toContain("看起来是 Pixel Code");
    expect(message).toContain("请改填数据连接名称或数字 ID");
    // 报错要带上账户现状，按常用度排序。
    expect(message).toContain("纵恣-czx(7542377711428370439)");
    expect(message).toContain("纵恣-lsh(7542379322273447954)");
  });

  it("找不到时不猜，报错里给出候选", () => {
    expect(() => resolveAccountPixelIdFromAdGroups(account, "别的账户的连接"))
      .toThrow("找不到数据连接");
    expect(() => resolveAccountPixelIdFromAdGroups(account, "别的账户的连接"))
      .toThrow("纵恣-czx(7542377711428370439)");
  });

  it("账户里一个数据连接都没有时，说清楚是账户没有而不是名字写错", () => {
    expect(() => resolveAccountPixelIdFromAdGroups([
      { entityType: "ad-group", externalId: "adgroup-1", payload: { ad_name: "无连接" } },
    ], "纵恣-czx")).toThrow("没有任何数据连接可供匹配");
  });

  it("同名对应多个 ID 时拒绝猜，要求改填数字 ID", () => {
    expect(() => resolveAccountPixelIdFromAdGroups([
      adGroup("adgroup-1", "7542377711428370439", "同名连接"),
      adGroup("adgroup-2", "7542379322273447954", "同名连接"),
    ], "同名连接")).toThrow("多个数据连接匹配");
  });

  it("只看广告组，系列等其它实体不参与匹配", () => {
    expect(() => resolveAccountPixelIdFromAdGroups([
      {
        entityType: "campaign",
        externalId: "campaign-1",
        payload: { ad_ref_pixel_id: "7542377711428370439", ad_pixel_name: "纵恣-czx" },
      },
    ], "纵恣-czx")).toThrow("找不到数据连接");
  });

  it("保留旧数字预设的目标匹配回退", () => {
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
