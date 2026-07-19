import { describe, expect, it, vi } from "vitest";
import { createLaunchProgressPoller } from "./launch-progress-polling";

describe("launch progress polling", () => {
  it("starts after a reloaded page finds durable queued plans and stops when the queue empties", () => {
    const refresh = vi.fn();
    let callback: () => void = () => { throw new Error("poller did not schedule"); };
    const schedule = vi.fn((next: () => void) => {
      callback = next;
      return 42;
    });
    const cancel = vi.fn();
    const poller = createLaunchProgressPoller(refresh, schedule, cancel, 750);

    poller.reconcile(["plan-from-reload"]);
    callback();
    poller.reconcile([]);

    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 750);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(42);
  });
});
