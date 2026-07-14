import { describe, expect, it } from "vitest";
import { userGuide } from "./index.js";

describe("user guide", () => {
  it("contains both provider tutorials and the update policy", () => {
    expect(userGuide.version).toBe("1.3.0");
    const ids = userGuide.sections.map((section) => section.id);
    expect(ids).toContain("cookie-provider");
    expect(ids).toContain("official-api-provider");
    expect(ids).toContain("automation-center");
    expect(ids).toContain("ad-management");
    expect(ids).toContain("analytics");
    expect(ids).toContain("notifications");
    expect(ids).toContain("development-policy");

    const notificationGuide = userGuide.sections.find(
      (section) => section.id === "notifications",
    );
    expect(notificationGuide?.steps.join(" ")).toContain("没有到期账户");
    expect(notificationGuide?.notes.join(" ")).toContain("DPAPI");
    expect(notificationGuide?.links).toHaveLength(3);

    const cookieGuide = userGuide.sections.find(
      (section) => section.id === "cookie-provider",
    );
    expect(cookieGuide?.steps.join(" ")).toContain("Copy as cURL (bash)");
    expect(cookieGuide?.steps.join(" ")).toContain("/adgroup/list/?");
    expect(cookieGuide?.steps.join(" ")).toContain("/ad/update_status/?");
    expect(cookieGuide?.steps.join(" ")).toContain("左侧“广告组列表 cURL”输入框");
    expect(cookieGuide?.steps.join(" ")).toContain("右侧“广告启停 cURL”输入框");
    expect(cookieGuide?.steps.join(" ")).toContain("导入并检查");
    expect(cookieGuide?.steps.join(" ")).toContain("五个必要字段");
    expect(cookieGuide?.notes.join(" ")).toContain("用户不需要再复制第三条请求");
    expect(cookieGuide?.notes.join(" ")).toContain("Windows DPAPI 加密");

    const quickStart = userGuide.sections.find(
      (section) => section.id === "quick-start",
    );
    expect(quickStart?.steps.join(" ")).toContain("更高版本安装包");
    expect(quickStart?.notes.join(" ")).toContain("%APPDATA%");
  });
});
