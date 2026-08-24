import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
  it("keeps results aligned with the input order regardless of completion order", async () => {
    const delays = [40, 0, 20, 0, 10];

    const results = await mapWithConcurrency(delays, 3, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    });

    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  // 上限存在的唯一理由就是别把同一个 Cookie 会话打到限流，所以它必须真的生效。
  it("never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, index) => index), 4, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return null;
    });

    expect(peak).toBe(4);
  });

  it("runs every item even when there are more items than lanes", async () => {
    const seen: number[] = [];

    await mapWithConcurrency(Array.from({ length: 9 }, (_, index) => index), 2, async (item) => {
      seen.push(item);
      return item;
    });

    expect(seen.sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  // 先抛出的那个如果直接把整体拒绝掉，其余在途的 Promise 就没人接管了，
  // Node 会按未处理拒绝处理。必须等所有泳道结束再抛。
  it("waits for in-flight work before surfacing a failure", async () => {
    let finished = 0;

    await expect(mapWithConcurrency([1, 2, 3, 4], 4, async (item) => {
      if (item === 1) throw new Error("first fails fast");
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished += 1;
      return item;
    })).rejects.toThrow("first fails fast");

    expect(finished).toBe(3);
  });

  it("returns an empty array without invoking the worker", async () => {
    let calls = 0;

    const results = await mapWithConcurrency([], 4, async () => {
      calls += 1;
      return calls;
    });

    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });
});
