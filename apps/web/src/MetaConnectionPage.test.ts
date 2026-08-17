import { describe, expect, it } from "vitest";
import {
  validateMetaBindingDraft,
  validateMetaProfileDraft,
  validateMetaSecretDraft,
} from "./MetaConnectionPage";

describe("Meta connection form validation", () => {
  it("explains every invalid shared App profile field", () => {
    expect(validateMetaProfileDraft({
      name: " ",
      appId: "Meta app",
      businessId: "bm_123",
      graphApiVersion: "26",
    })).toEqual({
      name: "请输入档案名称。",
      appId: "App ID 只能包含数字，不要填写名称或网址。",
      businessId: "Business Portfolio ID 只能包含数字；没有 BM 时请留空。",
      graphApiVersion: "Graph API 版本格式应为 v数字.数字，例如 v25.0。",
    });
  });

  it("accepts a numeric App ID with an optional empty BM", () => {
    expect(validateMetaProfileDraft({
      name: "上海沙盒 App",
      appId: "123456789012345",
      businessId: null,
      graphApiVersion: "v26.0",
    })).toEqual({});
  });

  it("reports secret and token requirements separately", () => {
    expect(validateMetaSecretDraft({
      appSecret: "short",
      accessToken: "also-short",
    })).toEqual({
      appSecret: "App Secret 至少需要 8 个字符。",
      accessToken: "Access Token 至少需要 20 个字符。",
    });
  });

  it("accepts either act_数字 or bare digits and explains invalid Page IDs", () => {
    const base = {
      profileId: "9dc6768f-a071-4db3-8e0f-7a25de984900",
      pageId: "",
      liveMode: "read-only" as const,
      creationMode: "disabled" as const,
      allowedStatusEntityTypes: ["ad"] as const,
    };
    expect(validateMetaBindingDraft({ ...base, allowedStatusEntityTypes: [...base.allowedStatusEntityTypes], adAccountId: "1705718683974303" })).toEqual({});
    expect(validateMetaBindingDraft({
      ...base,
      allowedStatusEntityTypes: [...base.allowedStatusEntityTypes],
      adAccountId: "act_not-a-number",
      pageId: "page_214422481745657",
    })).toEqual({
      adAccountId: "广告账户 ID 应为 act_数字；只填数字也会自动补全 act_。",
      pageId: "Facebook Page ID 只能包含数字；不需要 Page 时请留空。",
    });
  });
});
