import { describe, expect, it } from "vitest";
import { describeCookieCoverage } from "./cookie-coverage.js";

describe("describeCookieCoverage", () => {
  it("only asks for the missing final-ad list when status templates are complete", () => {
    expect(
      describeCookieCoverage({
        readTargets: ["campaign", "ad-group"],
        statusTargets: ["campaign", "ad-group", "ad"],
      }),
    ).toEqual({
      verifiedCount: 2,
      message:
        "读取数据仍缺少最终广告层列表 cURL。启停模板已覆盖全部三个层级。未补齐层级的自动化保持不可用。",
    });
  });

  it("reports read and status gaps independently", () => {
    expect(
      describeCookieCoverage({
        readTargets: ["campaign"],
        statusTargets: ["campaign", "ad-group"],
      }).message,
    ).toBe(
      "读取数据仍缺少广告组、最终广告层列表 cURL。启停模板仍缺少最终广告层真实启停 cURL。未补齐层级的自动化保持不可用。",
    );
  });
});
