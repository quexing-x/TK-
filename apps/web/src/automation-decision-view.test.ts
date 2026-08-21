import { describe, expect, it } from "vitest";
import type {
  AdOperationRecord,
  AutomationDecisionRecord,
  ManagedEntityRecord,
} from "@tk-auto/core";
import { selectActionableDecisionHistory, selectPendingAutomationDecisions } from "./automation-decision-view";

const decision = (overrides: Partial<AutomationDecisionRecord> = {}): AutomationDecisionRecord => ({
  id: "decision-new",
  runId: "run-1",
  accountId: "account-1",
  providerKind: "cookie",
  thresholdId: "threshold-1",
  thresholdCode: "rule-1",
  entityType: "ad-group",
  externalId: "group-1",
  entityName: "广告组 1",
  action: "disable",
  metric: "spend",
  metricValue: 100,
  operator: "gte",
  thresholdValue: 80,
  reason: "达到关闭阈值",
  suggestionKey: "suggestion-1",
  ruleVersion: "v1",
  rulePredicate: {},
  metricSnapshot: {
    cost_per_conversion: null,
    cost_per_click: null,
    cost_per_cart: null,
    budget: null,
    spend: 100,
    conversions: null,
    clicks: null,
    carts: null,
    impressions: null,
  },
  dataQualityStatus: "healthy",
  dataQualityWarnings: [],
  status: "preview",
  errorMessage: null,
  createdAt: "2026-07-21T10:00:00.000Z",
  executedAt: null,
  ...overrides,
});

describe("selectPendingAutomationDecisions", () => {
  it("does not reveal an older suggestion after the latest decision is completed", () => {
    const result = selectPendingAutomationDecisions({
      decisions: [
        decision({ id: "decision-old", createdAt: "2026-07-21T09:00:00.000Z" }),
        decision({ id: "decision-new", status: "succeeded" }),
      ],
    });

    expect(result).toEqual([]);
  });

  it("removes a close decision when the entity is already closed", () => {
    const entity = {
      accountId: "account-1",
      entityType: "ad-group",
      externalId: "group-1",
      name: "广告组 1",
      status: "disabled",
      parentCampaignId: null,
      parentAdGroupId: null,
      campaignBudget: null,
      campaignBudgetOptimized: false,
      metrics: decision().metricSnapshot,
      ignored: false,
      automationManaged: false,
      syncedAt: "2026-07-21T10:01:00.000Z",
    } satisfies ManagedEntityRecord & { accountId: string };
    expect(selectPendingAutomationDecisions({ decisions: [decision()], entities: [entity] })).toEqual([]);
  });

  it("removes a decision while a matching newer close operation is active", () => {
    const operation = {
      accountId: "account-1",
      entityType: "ad-group",
      externalId: "group-1",
      action: "disable",
      status: "pending",
      createdAt: "2026-07-21T10:01:00.000Z",
    } as AdOperationRecord;
    expect(selectPendingAutomationDecisions({ decisions: [decision()], operations: [operation] })).toEqual([]);
  });

  it("keeps a decision when the matching operation is older or failed", () => {
    const oldOperation = {
      accountId: "account-1",
      entityType: "ad-group",
      externalId: "group-1",
      action: "disable",
      status: "succeeded",
      createdAt: "2026-07-21T09:59:00.000Z",
    } as AdOperationRecord;
    const failedOperation = {
      ...oldOperation,
      status: "failed",
      createdAt: "2026-07-21T10:01:00.000Z",
    } as AdOperationRecord;

    expect(selectPendingAutomationDecisions({
      decisions: [decision()],
      operations: [oldOperation, failedOperation],
    })).toHaveLength(1);
  });
});

describe("selectActionableDecisionHistory", () => {
  it("hides routine safe skips while keeping failed and executed records", () => {
    const history = selectActionableDecisionHistory([
      decision({ id: "skip", status: "skipped" }),
      decision({ id: "failed", status: "failed" }),
      decision({ id: "done", status: "succeeded" }),
    ]);
    expect(history.map((item) => item.id)).toEqual(["failed", "done"]);
  });
});
