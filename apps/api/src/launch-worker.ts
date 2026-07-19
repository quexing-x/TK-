import type { WriteTaskActor } from "@tk-auto/core";
import { AutomationStore } from "@tk-auto/storage";
import { LaunchService } from "./launch-service.js";

/**
 * Durable, single-process worker for queued batch creation. Item ownership is
 * still enforced by LaunchService's database claim, so multiple API processes
 * and a restart cannot duplicate a provider write.
 */
export class LaunchWorker {
  private timer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(
    private readonly store: AutomationStore,
    private readonly launchService: LaunchService,
    private readonly intervalMs = 250,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain(), this.intervalMs);
    this.timer.unref?.();
    void this.drain();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.drainPromise;
  }

  enqueue(planId: string, actor: WriteTaskActor): void {
    this.store.enqueueLaunchPlan(planId, actor);
    void this.drain();
  }

  async drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainQueuedPlans().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async drainQueuedPlans(): Promise<void> {
    try {
      for (const queued of this.store.listQueuedLaunchPlans()) {
        try {
          await this.launchService.execute(queued.planId, queued.actor);
        } catch {
          // A mutable local safety gate (for example the master switch) can
          // reject a queued plan before any provider call. Leave it pending so
          // the worker can safely resume after that gate is restored.
        }
      }
    } catch {
      // A process shutdown can close storage after the worker is stopped.
      // There is no safe retry decision to make here; persisted pending work
      // remains available to the next process startup.
    }
  }
}
