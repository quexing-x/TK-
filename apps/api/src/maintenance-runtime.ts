import type { UpdateRuntimeStatus } from "@tk-auto/core";

export interface MaintenanceUpdateRuntime {
  getStatus(): UpdateRuntimeStatus | Promise<UpdateRuntimeStatus>;
  checkForUpdates(): UpdateRuntimeStatus | Promise<UpdateRuntimeStatus>;
  downloadUpdate(): UpdateRuntimeStatus | Promise<UpdateRuntimeStatus>;
  installUpdate(): UpdateRuntimeStatus | Promise<UpdateRuntimeStatus>;
}

export function unavailableMaintenanceUpdateRuntime(
  currentVersion = "development",
): MaintenanceUpdateRuntime {
  const status = (): UpdateRuntimeStatus => ({
    configured: false,
    state: "not-configured",
    currentVersion,
    availableVersion: null,
    signatureStatus: "not-packaged",
    message: "当前运行环境未配置签名升级源。",
    checkedAt: null,
  });
  const unavailable = (): never => {
    throw new Error("当前运行环境未配置签名升级源。");
  };
  return {
    getStatus: status,
    checkForUpdates: unavailable,
    downloadUpdate: unavailable,
    installUpdate: unavailable,
  };
}
