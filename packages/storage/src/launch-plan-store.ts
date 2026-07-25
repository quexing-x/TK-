import type {
  LaunchCreationProgress,
  LaunchPlanItemRecord,
  LaunchPlanItemStatus,
  MultiAccountLaunchPlanRecord,
  WriteTaskActor,
} from "@tk-auto/core";
import type { AutomationStore } from "./store.js";

/** Focused launch-task persistence facade over the shared SQLite connection. */
export class LaunchPlanStore {
  constructor(private readonly store: AutomationStore) {}

  getPlan(planId: string): MultiAccountLaunchPlanRecord | null {
    return this.store.getMultiAccountLaunchPlan(planId);
  }

  listItems(planId: string, statuses?: LaunchPlanItemStatus[]): LaunchPlanItemRecord[] {
    return this.store.listLaunchPlanItems(planId, statuses);
  }

  claim(itemId: string, executorId: string, expectedStatus: "pending" | "failed" | "unknown", actor: WriteTaskActor) {
    return this.store.claimLaunchPlanItem(itemId, executorId, expectedStatus, actor);
  }

  progress(itemId: string, executorId: string, progress: LaunchCreationProgress) {
    return this.store.updateLaunchPlanItemProgress(itemId, executorId, progress);
  }

  renew(itemId: string, executorId: string): boolean {
    return this.store.renewLaunchPlanItemLease(itemId, executorId);
  }

  succeed(itemId: string, executorId: string, ids: { campaignId: string; adGroupId: string; adId?: string; warning?: string }) {
    return this.store.completeLaunchPlanItemSuccess(itemId, executorId, ids);
  }

  fail(itemId: string, executorId: string, message: string) {
    return this.store.completeLaunchPlanItemFailure(itemId, executorId, message);
  }

  unknown(itemId: string, executorId: string, message: string) {
    return this.store.completeLaunchPlanItemUnknown(itemId, executorId, message);
  }

  sync(itemId: string, warning: string | null) {
    return this.store.completeLaunchPlanItemSync(itemId, warning);
  }

  recover(staleBefore: string): number {
    return this.store.recoverInterruptedLaunchPlanItems(staleBefore);
  }

  recoverLegacySeriesBlocks() {
    // One-way upgrade compatibility for plans created by releases that used
    // database series locks. New creation tasks never acquire these locks.
    return this.store.recoverLegacySeriesCoordinationFailures();
  }

  refresh(planId: string): MultiAccountLaunchPlanRecord {
    return this.store.refreshLaunchPlanResult(planId);
  }
}
