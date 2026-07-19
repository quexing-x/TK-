import { describe, expect, it } from "vitest";
import { createExcelJsLoader } from "./exceljs-loader.js";

describe("ExcelJS loader", () => {
  it("retries after a transient module-load failure", async () => {
    let attempts = 0;
    const loadExcelJs = createExcelJsLoader(() => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("temporary load failure"));
      return Promise.resolve({ Workbook: class Workbook {} } as typeof import("exceljs"));
    });

    await expect(loadExcelJs()).rejects.toThrow("temporary load failure");
    await expect(loadExcelJs()).resolves.toMatchObject({ Workbook: expect.any(Function) });
    expect(attempts).toBe(2);
  });
});
