export const localRefreshIntervalMs = 30_000;

export function nextLocalRefreshAt(now = Date.now()): number {
  return now + localRefreshIntervalMs;
}

export function secondsUntilLocalRefresh(nextRefreshAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((nextRefreshAt - now) / 1_000));
}
