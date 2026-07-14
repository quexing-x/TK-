import { describe, expect, it } from "vitest";
import { ThresholdInputSchema, defaultThresholds } from "./threshold.js";

describe("default thresholds", () => {
  it("are valid and uniquely coded", () => {
    const parsed = defaultThresholds.map((item) =>
      ThresholdInputSchema.parse(item),
    );
    const codes = new Set(parsed.map((item) => item.code));

    expect(codes.size).toBe(parsed.length);
  });
});
