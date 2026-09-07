import { describe, expect, it } from "vitest";
import { LANDING_PAGE_TRACKING_PARAMS, appendTrackingParams } from "./tracking-url.js";

const P = LANDING_PAGE_TRACKING_PARAMS;

describe("落地页归因参数", () => {
  it("干净域名后面直接拼一个问号", () => {
    expect(appendTrackingParams("https://shop.example.com/p/123"))
      .toBe(`https://shop.example.com/p/123?${P}`);
  });

  it("已经带参数的用 & 接上，不覆盖原参数", () => {
    expect(appendTrackingParams("https://shop.example.com/p?sku=9&ref=a"))
      .toBe(`https://shop.example.com/p?sku=9&ref=a&${P}`);
  });

  // TikTok 在跳转时才把这两个宏换成真实值，所以它们必须逐字出现在报文里。
  // 任何「解析 URL 再重新序列化」的写法都会把它们编码掉。
  it("两个宏原样保留，不被 URL 编码", () => {
    const result = appendTrackingParams("https://a.com/p");
    expect(result).toContain("utm_id=__CAMPAIGN_ID__");
    expect(result).toContain("utm_campaign=__CAMPAIGN_NAME__");
    expect(result).not.toContain("%5F");
    expect(result).not.toContain("%__");
  });

  // 重复拼会让 GA 收到两个 utm_source，TikTok 不报错，取哪个值是未定义的。
  it("已经带了 utm_source 就原样返回", () => {
    const already = `https://a.com/p?${P}`;
    expect(appendTrackingParams(already)).toBe(already);
    // 投手手填的大小写不一定统一。
    expect(appendTrackingParams("https://a.com/p?UTM_SOURCE=other"))
      .toBe("https://a.com/p?UTM_SOURCE=other");
  });

  // 参数落进 fragment 的话浏览器压根不会发给服务端，归因静默丢失。
  it("锚点留在最末尾，参数插在它前面", () => {
    expect(appendTrackingParams("https://a.com/p#tab"))
      .toBe(`https://a.com/p?${P}#tab`);
    expect(appendTrackingParams("https://a.com/p?x=1#tab"))
      .toBe(`https://a.com/p?x=1&${P}#tab`);
  });

  it("末尾已经有分隔符时不再补一个，避免拼出空参数", () => {
    expect(appendTrackingParams("https://a.com/p?")).toBe(`https://a.com/p?${P}`);
    expect(appendTrackingParams("https://a.com/p?x=1&")).toBe(`https://a.com/p?x=1&${P}`);
  });

  it("空值原样返回空串，不拼出一个只有参数的野 URL", () => {
    expect(appendTrackingParams("")).toBe("");
    expect(appendTrackingParams("   ")).toBe("");
    expect(appendTrackingParams(null)).toBe("");
    expect(appendTrackingParams(undefined)).toBe("");
  });

  it("首尾空格先剪掉再拼", () => {
    expect(appendTrackingParams("  https://a.com/p  ")).toBe(`https://a.com/p?${P}`);
  });
});
