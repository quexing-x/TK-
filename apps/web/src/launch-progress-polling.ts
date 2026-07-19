export interface LaunchProgressPoller {
  reconcile(queuedPlanIds: string[]): void;
  stop(): void;
}

/** Controls polling from the durable queue state returned during page load. */
export function createLaunchProgressPoller(
  refresh: () => void,
  schedule: (callback: () => void, delayMs: number) => number = window.setInterval,
  cancel: (timer: number) => void = window.clearInterval,
  intervalMs = 750,
): LaunchProgressPoller {
  let timer: number | null = null;
  return {
    reconcile(queuedPlanIds) {
      if (queuedPlanIds.length > 0 && timer === null) {
        timer = schedule(refresh, intervalMs);
      } else if (queuedPlanIds.length === 0 && timer !== null) {
        cancel(timer);
        timer = null;
      }
    },
    stop() {
      if (timer !== null) cancel(timer);
      timer = null;
    },
  };
}
