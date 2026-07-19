import { afterEach, describe, expect, it, vi } from "vitest";
import { withLeaseHeartbeat } from "./write-task-kernel.js";

describe("write task lease heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews a running task until provider work settles and then clears the timer", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(() => true);
    let finish!: (value: string) => void;
    const work = new Promise<string>((resolve) => {
      finish = resolve;
    });

    const result = withLeaseHeartbeat(() => work, renew, 1_000);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(renew).toHaveBeenCalledTimes(3);

    finish("done");
    await expect(result).resolves.toBe("done");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(renew).toHaveBeenCalledTimes(3);
  });
});
