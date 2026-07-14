import { describe, expect, it } from "vitest";
import { userGuide } from "./index.js";

describe("user guide", () => {
  it("contains both provider tutorials and the update policy", () => {
    expect(userGuide.version).toBe("1.1.0");
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
    expect(cookieGuide?.steps.join(" ")).toContain("/campaign/list/?");
    expect(cookieGuide?.steps.join(" ")).toContain("report、batch 或 append");
    expect(cookieGuide?.notes.join(" ")).toContain("生成双向模板");

    const quickStart = userGuide.sections.find(
      (section) => section.id === "quick-start",
    );
    expect(quickStart?.steps.join(" ")).toContain("更高版本安装包");
    expect(quickStart?.notes.join(" ")).toContain("%APPDATA%");
  });
});
