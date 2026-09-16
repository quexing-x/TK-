import { LAUNCH_RECONCILE_QUIET_MS, type WriteTaskActor } from "@tk-auto/core";
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
    /**
     * 跑完到核对之间的静默期。
     *
     * 留这段等待是因为 TikTok 的正式对象有延迟：刚结束就查，会把「马上就成」的条目
     * 误判成「只剩草稿」，然后把它的草稿清掉——那就白建了一次。
     */
    private readonly quietPeriodMs = LAUNCH_RECONCILE_QUIET_MS,
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
          // A mutable creation precondition can reject a queued plan before
          // any provider call. Persisted pending work remains available for a
          // later explicit retry after that condition is corrected.
        }
        // 这一轮之后它可能已经没有待办条目了；落一个结束时刻，静默期从那时起算。
        this.markSettledIfDone(queued.planId);
      }
      await this.reconcileSettledPlans();
    } catch {
      // A process shutdown can close storage after the worker is stopped.
      // There is no safe retry decision to make here; persisted pending work
      // remains available to the next process startup.
    }
  }

  /** 条目全部到终态就记下结束时刻。markLaunchPlanSettled 只写第一次，重复调用无害。 */
  private markSettledIfDone(planId: string): void {
    const busy = this.store
      .listLaunchPlanItems(planId)
      .some((item) => item.status === "pending" || item.status === "running");
    if (!busy) this.store.markLaunchPlanSettled(planId);
  }

  /**
   * 静默期满的计划逐个核对。
   *
   * **串行，一次一个账户。** 四个账户常常前后脚跑完，核对本身要翻正式列表和草稿列表，
   * 并发查等于又一次把列表接口打满——那正是 2026-09-16 撞上 403 的原因。这里是后台
   * 静默动作，慢几十秒没有任何影响。
   */
  private async reconcileSettledPlans(): Promise<void> {
    for (const due of this.store.listLaunchPlansAwaitingReconcile(this.quietPeriodMs)) {
      try {
        await this.launchService.reconcileSettledPlan(due.planId);
      } catch {
        // 核对失败不标记已核对，下一轮自然重来。绝不能因为核对出错就把计划卡死。
      }
    }
  }
}
