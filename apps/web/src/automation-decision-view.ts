import type {
  AdOperationRecord,
  AutomationApprovalRecord,
  AutomationDecisionRecord,
  ManagedEntityRecord,
} from "@tk-auto/core";

type PendingDecisionOptions = {
  decisions: AutomationDecisionRecord[];
  approvals?: AutomationApprovalRecord[];
  entities?: Array<ManagedEntityRecord & { accountId: string }>;
  operations?: AdOperationRecord[];
  statuses?: AutomationDecisionRecord["status"][];
};

const activeOperationStatuses = new Set<AdOperationRecord["status"]>([
  "pending",
  "running",
  "succeeded",
  "unknown",
]);

function entityKey(accountId: string, entityType: string, externalId: string): string {
  return `${accountId}:${entityType}:${externalId}`;
}

export function selectPendingAutomationDecisions({
  decisions,
  approvals = [],
  entities = [],
  operations = [],
  statuses = ["preview"],
}: PendingDecisionOptions): AutomationDecisionRecord[] {
  const allowedStatuses = new Set(statuses);
  const approvedDecisionIds = new Set(approvals.map((approval) => approval.decisionId));
  const entityStatusByKey = new Map(
    entities.map((entity) => [
      entityKey(entity.accountId, entity.entityType, entity.externalId),
      entity.status,
    ]),
  );
  const activeOperationsByKey = new Map<string, AdOperationRecord[]>();
  for (const operation of operations) {
    if (!activeOperationStatuses.has(operation.status)) continue;
    const key = entityKey(operation.accountId, operation.entityType, operation.externalId);
    activeOperationsByKey.set(key, [...(activeOperationsByKey.get(key) ?? []), operation]);
  }

  const seen = new Set<string>();
  return [...decisions]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((decision) => {
      const key = entityKey(decision.accountId, decision.entityType, decision.externalId);
      if (seen.has(key)) return false;
      seen.add(key);

      if (!allowedStatuses.has(decision.status) || approvedDecisionIds.has(decision.id)) return false;

      const expectedStatus = decision.action === "enable" ? "enabled" : "disabled";
      if (entityStatusByKey.get(key) === expectedStatus) return false;

      const expectedOperationAction = decision.action === "enable" ? "enable" : "disable";
      return !(activeOperationsByKey.get(key) ?? []).some((operation) => (
        operation.action === expectedOperationAction
        && operation.createdAt >= decision.createdAt
      ));
    });
}

/** Keep the audit table actionable: routine safe skips remain stored, but do not
 * bury executions and failures in the default view. */
export function selectActionableDecisionHistory(decisions: AutomationDecisionRecord[]): AutomationDecisionRecord[] {
  return [...decisions]
    .filter((decision) => decision.status !== "skipped")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
