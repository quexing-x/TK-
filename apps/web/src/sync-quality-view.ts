import type { SyncDataQualityStatus } from "@tk-auto/core";

export interface SyncQualityPresentation {
  label: string;
  tone: "active" | "warning" | "danger";
  automaticWritesAllowed: boolean;
}

export function syncQualityPresentation(
  status: SyncDataQualityStatus,
): SyncQualityPresentation {
  if (status === "healthy") {
    return { label: "健康", tone: "active", automaticWritesAllowed: true };
  }
  if (status === "invalid") {
    return { label: "契约失效", tone: "danger", automaticWritesAllowed: false };
  }
  return {
    label: status === "partial" ? "部分可信" : "已过期",
    tone: "warning",
    automaticWritesAllowed: false,
  };
}
