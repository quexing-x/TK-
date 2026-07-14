import { describe, expect, it } from "vitest";
import { userGuide } from "./index.js";

describe("user guide", () => {
  it("contains both provider tutorials and the update policy", () => {
    const ids = userGuide.sections.map((section) => section.id);
    expect(ids).toContain("cookie-provider");
    expect(ids).toContain("official-api-provider");
    expect(ids).toContain("development-policy");

    const cookieGuide = userGuide.sections.find(
      (section) => section.id === "cookie-provider",
    );
    expect(cookieGuide?.steps.join(" ")).toContain("Copy as cURL (bash)");
    expect(cookieGuide?.steps.join(" ")).toContain("/adgroup/list/?");
    expect(cookieGuide?.steps.join(" ")).toContain("/campaign/list/?");
    expect(cookieGuide?.steps.join(" ")).toContain("report、batch、append");
    expect(cookieGuide?.notes.join(" ")).toContain("update_status");
  });
});
