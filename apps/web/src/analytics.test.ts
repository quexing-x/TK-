import { describe, expect, it } from "vitest";
import { resolveAnalysisRange } from "./analytics";

describe("analytics ranges", () => {
  it("resolves yesterday as a closed local calendar day", () => {
    const range = resolveAnalysisRange(
      "yesterday",
      "",
      "",
      new Date("2026-07-15T12:00:00+08:00"),
    );
    const from = new Date(range.from);
    const to = new Date(range.to);
    expect(from.getDate()).toBe(14);
    expect(from.getHours()).toBe(0);
    expect(to.getHours()).toBe(23);
  });
});
