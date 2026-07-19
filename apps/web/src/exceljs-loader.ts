type ExcelJsModule = typeof import("exceljs");
type ExcelJsImporter = () => Promise<ExcelJsModule>;

export function createExcelJsLoader(importExcelJs: ExcelJsImporter): () => Promise<ExcelJsModule> {
  let excelJsModule: Promise<ExcelJsModule> | undefined;
  return () => {
    if (!excelJsModule) {
      excelJsModule = importExcelJs().catch((error: unknown) => {
        excelJsModule = undefined;
        throw error;
      });
    }
    return excelJsModule;
  };
}

// Keep the spreadsheet library outside the initial application module graph.
export const loadExcelJs = createExcelJsLoader(() => import("exceljs"));
