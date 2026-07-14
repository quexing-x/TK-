import { describe, expect, it } from "vitest";
import type { CookieConnectionReadiness } from "./api";
import {
  canSubmitCookieImport,
  describeCookieState,
  getCookieImportSteps,
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
});
