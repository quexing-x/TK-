import { describe, expect, it } from "vitest";
import {
  nextLocalRefreshAt,
  secondsUntilLocalRefresh,
} from "./local-refresh";

describe("local refresh countdown", () => {
  it("counts down from the actual next refresh timestamp", () => {
    const start = 1_000_000;
    const next = nextLocalRefreshAt(start);

    expect(secondsUntilLocalRefresh(next, start)).toBe(30);
    expect(secondsUntilLocalRefresh(next, start + 29_100)).toBe(1);
    expect(secondsUntilLocalRefresh(next, next)).toBe(0);
  });
});
