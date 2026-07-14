import { describe, expect, it } from "vitest";
import { userGuide } from "./index.js";

describe("user guide", () => {
  it("contains both provider tutorials and the update policy", () => {
    expect(userGuide.version).toBe("1.1.5");
    const ids = userGuide.sections.map((section) => section.id);
    expect(ids).toContain("cookie-provider");
    expect(ids).toContain("official-api-provider");
    expect(ids).toContain("automation-center");
    expect(ids).toContain("ad-management");
    expect(ids).toContain("analytics");
    expect(ids).toContain("development-policy");

    const cookieGuide = userGuide.sections.find(
      (section) => section.id === "cookie-provider",
    );
    expect(cookieGuide?.steps.join(" ")).toContain("Copy as cURL (bash)");
    expect(cookieGuide?.steps.join(" ")).toContain("/adgroup/list/?");
    expect(cookieGuide?.steps.join(" ")).toContain("/ad/update_status/?");
    expect(cookieGuide?.steps.join(" ")).toContain("/creative/update_status/?");
    expect(cookieGuide?.steps.join(" ")).toContain("独立输入框");
    expect(cookieGuide?.steps.join(" ")).toContain("multipart/form-data");
    expect(cookieGuide?.steps.join(" ")).toContain("ad_list");
    expect(cookieGuide?.steps.join(" ")).toContain("creative_list");
    expect(cookieGuide?.steps.join(" ")).toContain("读取数据如果显示 2/3");
    expect(cookieGuide?.steps.join(" ")).toContain("实时请求并校验响应");
    expect(cookieGuide?.steps.join(" ")).toContain("最终广告层");
    expect(cookieGuide?.notes.join(" ")).toContain("同一输入框可以连续导入");
    expect(cookieGuide?.notes.join(" ")).toContain("层级未完成");

    const quickStart = userGuide.sections.find(
      (section) => section.id === "quick-start",
    );
    expect(quickStart?.steps.join(" ")).toContain("更高版本安装包");
    expect(quickStart?.notes.join(" ")).toContain("%APPDATA%");
  });
});
