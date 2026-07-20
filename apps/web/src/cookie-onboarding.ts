import type { ProviderConnection } from "@tk-auto/core";
import type { CookieConnectionReadiness } from "./api";

export interface CookieImportStep {
  command: string;
  step: "read" | "status";
}

export function getCookieImportSteps(
  readCommand: string,
  statusCommand: string,
): CookieImportStep[] {
  const steps: CookieImportStep[] = [];
  if (readCommand.trim()) {
    steps.push({ command: readCommand.trim(), step: "read" });
  }
  if (statusCommand.trim()) {
    steps.push({ command: statusCommand.trim(), step: "status" });
  }
  return steps;
}

export function canSubmitCookieImport(input: {
  busy: boolean;
  readCommand: string;
  readiness: CookieConnectionReadiness;
  statusCommand: string;
}): boolean {
  if (input.busy) return false;
  const readCommand = input.readCommand.trim();
  const statusCommand = input.statusCommand.trim();
  if (!readCommand && !statusCommand) return false;
  if (readCommand && !readCommand.startsWith("curl")) return false;
  if (statusCommand && !statusCommand.startsWith("curl")) return false;
  if (!input.readiness.dataRequestImported && !readCommand) return false;
  if (!input.readiness.statusRequestImported && !statusCommand) return false;
  return true;
}

/**
 * Imported cURL values are retained locally so a user can refresh them after a
 * session expires. They must not be presented as usable connection evidence
 * after a failed health check.
 */
export function displayedCookieReadiness(
  readiness: CookieConnectionReadiness,
  connection?: ProviderConnection,
): CookieConnectionReadiness {
  if (connection?.status !== "failed") return readiness;
  return {
    ...readiness,
    dataRequestImported: false,
    statusRequestImported: false,
    requiredFields: { listQuery: false, updateQuery: false, copyQuery: false, csrfToken: false, cookie: false },
    completedFields: 0,
    fieldsComplete: false,
  };
}

export function replaceProviderConnection(connections: ProviderConnection[], next: ProviderConnection): ProviderConnection[] {
  const index = connections.findIndex((connection) => connection.kind === next.kind);
  if (index < 0) return [...connections, next];
  return connections.map((connection, currentIndex) => currentIndex === index ? next : connection);
}

export function describeCookieState(
  readiness: CookieConnectionReadiness,
  connection?: ProviderConnection,
) {
  if (connection?.status === "failed") {
    return { status: "failed", label: "Cookie 已失效或连接异常", message: connection.lastMessage ?? "请重新获取并导入两段 cURL。" };
  }
  if (!readiness.fieldsComplete) {
    return {
      status: "untested",
      label: `等待导入（${readiness.completedFields}/${readiness.totalFields}）`,
      message: "请粘贴两段完整 cURL；只有五个必要字段全部获取后，才会显示接入正常。",
    };
  }
  if (!readiness.statusRequestImported) {
    return {
      status: "failed",
      label: "启停能力未建立",
      message: "必要字段已获取，但启停请求未能生成完整控制模板，请重新复制 /ad/update_status/? 的 POST cURL。",
    };
  }
  if (connection?.status === "ready") {
    return {
      status: "ready",
      label: "接入正常",
      message: "必要字段完整、广告账户读取成功，系列、广告组和广告的双向启停模板已按已知接口契约生成。",
    };
  }
  return {
    status: "untested",
    label: "字段已获取，等待连接结果",
    message: connection?.lastMessage ?? "正在等待本机完成连接状态更新。",
  };
}
