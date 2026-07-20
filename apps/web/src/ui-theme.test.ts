import { describe, expect, it } from "vitest";
import { nextUiTheme, resolveUiTheme } from "./ui-theme";

describe("UI theme", () => {
  it("uses the light reference theme for missing or invalid values", () => {
    expect(resolveUiTheme(null)).toBe("light");
    expect(resolveUiTheme("system")).toBe("light");
  });

  it("restores and toggles dark mode", () => {
    expect(resolveUiTheme("dark")).toBe("dark");
    expect(nextUiTheme("light")).toBe("dark");
    expect(nextUiTheme("dark")).toBe("light");
  });
});
