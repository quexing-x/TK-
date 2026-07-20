import { describe, expect, it } from "vitest";
import type { ProviderConnection } from "@tk-auto/core";
import type { CookieConnectionReadiness } from "./api";
import {
  canSubmitCookieImport,
  describeCookieState,
  displayedCookieReadiness,
  getCookieImportSteps,
  replaceProviderConnection,
} from "./cookie-onboarding.js";

const emptyReadiness: CookieConnectionReadiness = {
  dataRequestImported: false,
  statusRequestImported: false,
  requiredFields: {
    listQuery: false,
    updateQuery: false,
    copyQuery: false,
    csrfToken: false,
    cookie: false,
  },
  completedFields: 0,
  totalFields: 5,
  fieldsComplete: false,
};

describe("Cookie onboarding interaction", () => {
  it("imports the list request before the status request", () => {
    expect(getCookieImportSteps(" curl 'list' ", " curl 'status' ")).toEqual([
      { command: "curl 'list'", step: "read" },
      { command: "curl 'status'", step: "status" },
    ]);
  });

  it("lets a user retry only the missing second request", () => {
    const readiness = { ...emptyReadiness, dataRequestImported: true };
    expect(
      canSubmitCookieImport({
        busy: false,
        readCommand: "",
        readiness,
        statusCommand: "curl 'status'",
      }),
    ).toBe(true);
    expect(getCookieImportSteps("", "curl 'status'")).toEqual([
      { command: "curl 'status'", step: "status" },
    ]);
  });

  it("does not label complete fields as connected when templates are missing", () => {
    const readiness: CookieConnectionReadiness = {
      ...emptyReadiness,
      completedFields: 5,
      fieldsComplete: true,
      requiredFields: {
        listQuery: true,
        updateQuery: true,
        copyQuery: true,
        csrfToken: true,
        cookie: true,
      },
    };
    expect(describeCookieState(readiness).label).toBe("启停能力未建立");
  });

  it("does not show retained fields as acquired after connection failure", () => {
    const readiness: CookieConnectionReadiness = {
      ...emptyReadiness, dataRequestImported: true, statusRequestImported: true,
      completedFields: 5, fieldsComplete: true,
      requiredFields: { listQuery: true, updateQuery: true, copyQuery: true, csrfToken: true, cookie: true },
    };
    const failed = cookieConnection({ status: "failed", lastMessage: "session expired" });
    expect(displayedCookieReadiness(readiness, failed)).toMatchObject({ completedFields: 0, fieldsComplete: false, requiredFields: { cookie: false } });
    expect(describeCookieState(readiness, failed).status).toBe("failed");
  });

  it("updates the rendered provider connection with the import result", () => {
    const existing = cookieConnection({ status: "untested" });
    const imported = { ...existing, status: "ready" as const, lastMessage: "ready" };
    expect(replaceProviderConnection([existing], imported)).toEqual([imported]);
  });
});

function cookieConnection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    accountId: "account-1", kind: "cookie",
    settings: { kind: "cookie", advertiserId: "123", healthUrl: "", campaignsUrl: "", adGroupsUrl: "", adsUrl: "" },
    hasCredential: true, status: "untested", authorizationStatus: "not-authorized", capabilityVersion: "cookie-v1",
    authorizedCapabilities: [], authorizedAt: null, authorizationExpiresAt: null, lastMessage: null, lastTestedAt: null,
    updatedAt: "2026-07-20T00:00:00.000Z", ...overrides,
  };
}
