import type {
  AccountConfig,
  AccountSettingsUpdate,
  AccountCreateInput,
  GlobalAutomationSettings,
  GlobalAutomationSettingsInput,
  ProviderWriteCircuit,
  AutomationDecisionRecord,
  AutomationRunRecord,
  ProviderConnection,
  ProviderConnectionSettings,
  ProviderCredentialInput,
  ProviderKind,
  ReadOnlySyncResult,
  RuleConfiguration,
  RuleConfigurationInput,
  AdOperationRecord,
  MetricBatchRecord,
  ManagedEntityRecord,
  IgnoredEntityRecord,
  ManualStatusInput,
  NotificationChannelKind,
  NotificationChannelRecord,
  NotificationChannelSettings,
  NotificationCredentialInput,
  NotificationDeliveryRecord,
  PollCycleRecord,
  AuthStatus,
  InitialDeveloperInput,
  LoginInput,
  LocalUserCreateInput,
  LocalUserRecord,
  LocalUserUpdateInput,
  PasswordChangeInput,
  SystemRuntimeState,
  AutomationFeatureSettings,
  AutomationFeatureSettingsInput,
  ScheduledEntityActionRecord,
  OneTimeScheduleInput,
  OvernightScheduleInput,
  MultiAccountLaunchPlanInput,
  MultiAccountLaunchPlanRecord,
  LaunchPresetInput,
  LaunchPresetRecord,
  LaunchPlanItemRecord,
  LaunchPlanItemAttemptRecord,
  LaunchCopyPreviewInput,
  LaunchCopyPreviewRecord,
  WriteTaskKind,
  WriteTaskStatus,
  WriteTaskSummaryRecord,
  AdOperationAttemptRecord,
  StatusManualVerificationInput,
  StatusManualVerificationRecord,
  AuditLogFilter,
  AuditLogRecord,
  DatabaseBackupRecord,
  MaintenanceStatus,
  UpdateRuntimeStatus,
  AccountProviderCapabilities,
  ProviderCapability,
} from "@tk-auto/core";
import type { TikTokCookieImportReadiness as CookieConnectionReadiness } from "@tk-auto/providers";

export type { CookieConnectionReadiness };

export interface ProviderDescriptor {
  kind: ProviderKind;
  displayName: string;
  implementationStatus: "scaffolded" | "available";
  capabilityVersion: string;
  capabilities: ProviderCapability[];
}

export interface BootstrapPayload {
  accounts: AccountConfig[];
  accountConnectionStates: Array<{
    accountId: string;
    connection: ProviderConnection | null;
    latestSync: ReadOnlySyncResult | null;
    capabilities: AccountProviderCapabilities;
  }>;
  globalAutomationSettings: GlobalAutomationSettings;
  systemRuntime: SystemRuntimeState;
  providers: ProviderDescriptor[];
}

export interface ManualStatusResult extends ManualStatusInput {
  ok: boolean;
  message: string;
}

export interface LaunchExecutionResult {
  plan: MultiAccountLaunchPlanRecord;
  results: Array<{
    itemId: string;
    accountId: string;
    status: "pending" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";
    message: string;
    syncWarning: string | null;
  }>;
}

export interface LaunchQueueResult {
  plan: MultiAccountLaunchPlanRecord;
  queued: true;
}

export interface ProviderWriteCircuitState {
  todayUsage: number;
  circuit: ProviderWriteCircuit | null;
}

export type WriteTaskAttemptRecord = LaunchPlanItemAttemptRecord | AdOperationAttemptRecord;

export interface WriteTaskFilters {
  kind?: WriteTaskKind;
  status?: WriteTaskStatus;
  accountId?: string;
  limit?: number;
}

let csrfToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setAuthSession(status: AuthStatus | null): void {
  csrfToken = status?.csrfToken ?? null;
}

export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const usesDedicatedResultToast = path.startsWith("/api/launch-plans")
    || path === "/api/ad-groups/batch-expand";
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)
        ? { "x-csrf-token": csrfToken }
        : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    if (response.status === 401) unauthorizedHandler?.();
    const payload = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    const message = payload?.message ?? `请求失败 (${response.status})`;
    if (typeof window !== "undefined" && !["GET", "HEAD", "OPTIONS"].includes(method)) window.dispatchEvent(new CustomEvent("tk-api-write", { detail: { ok: false, message } }));
    throw new Error(message);
  }

  if (
    typeof window !== "undefined"
    && !usesDedicatedResultToast
    && !["GET", "HEAD", "OPTIONS"].includes(method)
  ) window.dispatchEvent(new CustomEvent("tk-api-write", { detail: { ok: true, message: "操作已完成" } }));

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const api = {
  authStatus: async () => {
    const status = await request<AuthStatus>("/api/auth/status");
    setAuthSession(status);
    return status;
  },
  setupDeveloper: async (input: InitialDeveloperInput) => {
    const status = await request<AuthStatus>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify(input),
    });
    setAuthSession(status);
    return status;
  },
  login: async (input: LoginInput) => {
    const status = await request<AuthStatus>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    });
    setAuthSession(status);
    return status;
  },
  resetLocalAccess: async () => {
    const status = await request<AuthStatus>("/api/auth/recover", {
      method: "POST",
      body: JSON.stringify({ confirmation: "RESET" }),
    });
    setAuthSession(status);
    return status;
  },
  logout: async () => {
    try {
      return await request<{ ok: boolean }>("/api/auth/logout", {
        method: "POST",
      });
    } finally {
      setAuthSession(null);
    }
  },
  changePassword: (input: PasswordChangeInput) =>
    request<{ ok: boolean; reauthenticationRequired: boolean }>(
      "/api/auth/password",
      { method: "PUT", body: JSON.stringify(input) },
    ),
  getLocalUsers: () => request<LocalUserRecord[]>("/api/local-users"),
  createLocalUser: (input: LocalUserCreateInput) =>
    request<LocalUserRecord>("/api/local-users", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateLocalUser: (userId: string, input: LocalUserUpdateInput) =>
    request<LocalUserRecord>(`/api/local-users/${userId}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  updateSystemRuntime: (enabled: boolean) =>
    request<SystemRuntimeState>("/api/system/runtime", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),
  getWriteCircuit: (accountId: string) =>
    request<ProviderWriteCircuitState>(
      `/api/accounts/${accountId}/write-circuit`,
    ),
  resetWriteCircuit: (accountId: string) =>
    request<ProviderWriteCircuitState>(
      `/api/accounts/${accountId}/write-circuit/reset`,
      { method: "POST" },
    ),
  getAutomationFeatures: () =>
    request<AutomationFeatureSettings>("/api/automation/features"),
  updateAutomationFeatures: (input: AutomationFeatureSettingsInput) =>
    request<AutomationFeatureSettings>("/api/automation/features", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  applyAutomationFeaturesToAllAccounts: (input: AutomationFeatureSettingsInput) =>
    request<{ settings: AutomationFeatureSettings; accountCount: number }>(
      "/api/automation/features/apply-all",
      { method: "POST", body: JSON.stringify(input) },
    ),
  getSchedules: (accountId: string) =>
    request<ScheduledEntityActionRecord[]>(
      `/api/accounts/${accountId}/schedules`,
    ),
  createOneTimeSchedule: (accountId: string, input: OneTimeScheduleInput) =>
    request<ScheduledEntityActionRecord>(
      `/api/accounts/${accountId}/schedules/once`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  createOvernightSchedule: (
    accountId: string,
    input: OvernightScheduleInput,
  ) =>
    request<ScheduledEntityActionRecord[]>(
      `/api/accounts/${accountId}/schedules/overnight`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  cancelSchedule: (accountId: string, scheduleId: string) =>
    request<void>(`/api/accounts/${accountId}/schedules/${scheduleId}`, {
      method: "DELETE",
    }),
  cancelOvernightSchedule: (accountId: string, groupId: string) =>
    request<void>(
      `/api/accounts/${accountId}/overnight-schedules/${groupId}`,
      { method: "DELETE" },
    ),
  getLaunchPlans: () =>
    request<MultiAccountLaunchPlanRecord[]>("/api/launch-plans"),
  getQueuedLaunchPlanIds: () =>
    request<string[]>("/api/launch-plans/queued"),
  getLaunchPresets: () => request<LaunchPresetRecord[]>("/api/launch-presets"),
  createLaunchPreset: (input: LaunchPresetInput) =>
    request<LaunchPresetRecord>("/api/launch-presets", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateLaunchPreset: (presetId: string, input: LaunchPresetInput) =>
    request<LaunchPresetRecord>(`/api/launch-presets/${presetId}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteLaunchPreset: (presetId: string) =>
    request<void>(`/api/launch-presets/${presetId}`, { method: "DELETE" }),
  createLaunchPlan: (input: MultiAccountLaunchPlanInput) =>
    request<MultiAccountLaunchPlanRecord>("/api/launch-plans", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cancelLaunchPlan: (planId: string) =>
    request<void>(`/api/launch-plans/${planId}`, { method: "DELETE" }),
  executeLaunchPlan: (planId: string) =>
    request<LaunchExecutionResult>(`/api/launch-plans/${planId}/execute`, {
      method: "POST",
    }),
  queueLaunchPlan: (planId: string) =>
    request<LaunchQueueResult>(`/api/launch-plans/${planId}/queue`, {
      method: "POST",
    }),
  createLaunchCopyPreview: (input: LaunchCopyPreviewInput) =>
    request<LaunchCopyPreviewRecord>("/api/launch-plans/copy-preview", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getLaunchPlanItems: (planId: string) =>
    request<LaunchPlanItemRecord[]>(`/api/launch-plans/${planId}/items`),
  retryLaunchPlanItem: (planId: string, itemId: string) =>
    request<LaunchExecutionResult>(`/api/launch-plans/${planId}/items/${itemId}/retry`, {
      method: "POST",
    }),
  getLaunchPlanItemAttempts: (planId: string, itemId: string) =>
    request<LaunchPlanItemAttemptRecord[]>(`/api/launch-plans/${planId}/items/${itemId}/attempts`),
  getWriteTasks: (filters: WriteTaskFilters = {}) => {
    const query = new URLSearchParams();
    if (filters.kind) query.set("kind", filters.kind);
    if (filters.status) query.set("status", filters.status);
    if (filters.accountId) query.set("accountId", filters.accountId);
    if (filters.limit) query.set("limit", String(filters.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return request<WriteTaskSummaryRecord[]>(`/api/write-tasks${suffix}`);
  },
  getWriteTaskAttempts: (kind: WriteTaskKind, taskId: string) =>
    request<WriteTaskAttemptRecord[]>(`/api/write-tasks/${kind}/${taskId}/attempts`),
  getStatusWriteTaskVerifications: (taskId: string) =>
    request<StatusManualVerificationRecord[]>(`/api/write-tasks/status/${taskId}/verifications`),
  retryStatusOperation: (accountId: string, operationId: string) =>
    request<ManualStatusResult>(`/api/accounts/${accountId}/status-operations/${operationId}/retry`, {
      method: "POST",
    }),
  verifyStatusOperation: (
    accountId: string,
    operationId: string,
    input: StatusManualVerificationInput,
  ) => request<{
    verification: StatusManualVerificationRecord;
    task: AdOperationRecord;
  }>(`/api/accounts/${accountId}/status-operations/${operationId}/verify`, {
    method: "POST",
    body: JSON.stringify(input),
  }),
  bootstrap: () => request<BootstrapPayload>("/api/bootstrap"),
  createAccount: (input: AccountCreateInput) =>
    request<AccountConfig>("/api/accounts", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteAccount: (accountId: string) =>
    request<void>(`/api/accounts/${accountId}`, { method: "DELETE" }),
  updateSettings: (accountId: string, settings: AccountSettingsUpdate) =>
    request<AccountConfig>(`/api/accounts/${accountId}/settings`, {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  updateGlobalAutomationSettings: (input: GlobalAutomationSettingsInput) =>
    request<GlobalAutomationSettings>("/api/automation/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  getNotificationChannels: () =>
    request<NotificationChannelRecord[]>("/api/notifications/channels"),
  saveNotificationSettings: (
    kind: NotificationChannelKind,
    settings: NotificationChannelSettings,
  ) =>
    request<NotificationChannelRecord>(
      `/api/notifications/channels/${kind}/settings`,
      { method: "PUT", body: JSON.stringify(settings) },
    ),
  saveNotificationCredential: (
    kind: NotificationChannelKind,
    credential: NotificationCredentialInput,
  ) =>
    request<NotificationChannelRecord>(
      `/api/notifications/channels/${kind}/credential`,
      { method: "PUT", body: JSON.stringify(credential) },
    ),
  deleteNotificationCredential: (kind: NotificationChannelKind) =>
    request<{ ok: boolean }>(
      `/api/notifications/channels/${kind}/credential`,
      { method: "DELETE" },
    ),
  testNotificationChannel: (kind: NotificationChannelKind) =>
    request<NotificationChannelRecord>(
      `/api/notifications/channels/${kind}/test`,
      { method: "POST" },
    ),
  getNotificationDeliveries: () =>
    request<NotificationDeliveryRecord[]>("/api/notifications/deliveries"),
  getPollCycles: () =>
    request<PollCycleRecord[]>("/api/notifications/cycles"),
  providerHealth: (accountId: string) =>
    request<ProviderConnection | null>(
      `/api/accounts/${accountId}/provider-health`,
    ),
  getConnections: (accountId: string) =>
    request<ProviderConnection[]>(`/api/accounts/${accountId}/connections`),
  getConnectionCapabilities: (accountId: string) =>
    request<AccountProviderCapabilities[]>(
      `/api/accounts/${accountId}/connection-capabilities`,
    ),
  getAccountCapabilities: (accountId: string) =>
    request<AccountProviderCapabilities>(`/api/accounts/${accountId}/capabilities`),
  getCookieReadiness: (accountId: string) =>
    request<CookieConnectionReadiness>(
      `/api/accounts/${accountId}/connections/cookie/readiness`,
    ),
  importCookieCurl: (
    accountId: string,
    command: string,
    step?: "read" | "status" | "appeal",
  ) =>
    request<ProviderConnection>(
      `/api/accounts/${accountId}/connections/cookie/import-curl`,
      { method: "POST", body: JSON.stringify({ command, step }) },
    ),
  saveConnectionSettings: (
    accountId: string,
    providerKind: ProviderKind,
    settings: ProviderConnectionSettings,
  ) =>
    request<ProviderConnection>(
      `/api/accounts/${accountId}/connections/${providerKind}/settings`,
      { method: "PUT", body: JSON.stringify(settings) },
    ),
  saveCredential: (
    accountId: string,
    providerKind: ProviderKind,
    credential: ProviderCredentialInput,
  ) =>
    request<ProviderConnection>(
      `/api/accounts/${accountId}/connections/${providerKind}/credential`,
      { method: "PUT", body: JSON.stringify(credential) },
    ),
  deleteCredential: (accountId: string, providerKind: ProviderKind) =>
    request<void>(
      `/api/accounts/${accountId}/connections/${providerKind}/credential`,
      { method: "DELETE" },
    ),
  testConnection: (accountId: string, providerKind: ProviderKind) =>
    request<ProviderConnection>(
      `/api/accounts/${accountId}/connections/${providerKind}/test`,
      { method: "POST" },
    ),
  syncReadOnly: (accountId: string, providerKind: ProviderKind) =>
    request<ReadOnlySyncResult>(
      `/api/accounts/${accountId}/connections/${providerKind}/sync`,
      { method: "POST" },
    ),
  getRuleConfiguration: () => request<RuleConfiguration>("/api/rules"),
  updateRuleConfiguration: (input: RuleConfigurationInput) =>
    request<RuleConfiguration>("/api/rules", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  getAutomationRuns: (accountId: string) =>
    request<AutomationRunRecord[]>(
      `/api/accounts/${accountId}/automation/runs`,
    ),
  getLatestAutomationSync: (accountId: string) =>
    request<ReadOnlySyncResult | null>(
      `/api/accounts/${accountId}/automation/latest-sync`,
    ),
  getAutomationDecisions: (accountId: string) =>
    request<AutomationDecisionRecord[]>(
      `/api/accounts/${accountId}/automation/decisions`,
    ),
  previewAutomation: (accountId: string) =>
    request<AutomationRunRecord>(
      `/api/accounts/${accountId}/automation/preview`,
      { method: "POST" },
    ),
  runAutomation: (accountId: string) =>
    request<AutomationRunRecord>(
      `/api/accounts/${accountId}/automation/run`,
      { method: "POST" },
    ),
  getManagedEntities: (accountId: string) =>
    request<ManagedEntityRecord[]>(`/api/accounts/${accountId}/entities`),
  batchExpandAdGroups: (input: {
    sources: Array<{
      accountId: string;
      sourceCampaignId: string;
      sourceCampaignName: string;
      sourceAdGroupId: string;
      sourceAdGroupName: string;
    }>;
    count: number;
    dailyBudget: number;
    bid: number | null;
    launchImmediately: boolean;
    sameCampaign: boolean;
    scheduledStartAt?: string | null;
  }) =>
    request<{ createdGroups: number; scheduled: number; failed: Array<{ name: string; message: string }>; skipped: number }>(
      "/api/ad-groups/batch-expand",
      { method: "POST", body: JSON.stringify(input) },
    ),
  copyCampaign: (input: {
    accountId: string;
    sourceCampaignId: string;
    sourceAdGroupIds: string[];
    campaignCopies: number;
    groupsPerCampaign: number;
    initialStatus: "enabled" | "disabled";
    scheduledStartAt?: string | null;
    campaignBudget?: number | null;
    bid?: number | null;
  }) =>
    request<{
      createdCampaigns: number;
      createdGroups: number;
      skipped: number;
      failed: Array<{ name: string; message: string }>;
      plan: Array<{ campaignName: string; groups: Array<{ sourceAdGroupId: string; name: string }> }>;
    }>("/api/campaigns/copy", { method: "POST", body: JSON.stringify(input) }),
  getManualTakeovers: (accountId: string) =>
    request<IgnoredEntityRecord[]>(`/api/accounts/${accountId}/manual-takeovers`),
  changeEntityStatus: (accountId: string, input: ManualStatusInput) =>
    request<AdOperationRecord>(`/api/accounts/${accountId}/entities/status`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  ignoreEntity: (
    accountId: string,
    entityType: ManualStatusInput["entityType"],
    externalId: string,
    reason: string,
  ) =>
    request(
      `/api/accounts/${accountId}/entities/${entityType}/${encodeURIComponent(externalId)}/ignore`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),
  unignoreEntity: (
    accountId: string,
    entityType: ManualStatusInput["entityType"],
    externalId: string,
  ) =>
    request<void>(
      `/api/accounts/${accountId}/entities/${entityType}/${encodeURIComponent(externalId)}/ignore`,
      { method: "DELETE" },
    ),
  restoreAllManualTakeovers: (accountId: string) =>
    request<{ restoredCount: number }>(
      `/api/accounts/${accountId}/manual-takeovers`,
      { method: "DELETE" },
    ),
  getAdOperations: (accountId: string) =>
    request<AdOperationRecord[]>(`/api/accounts/${accountId}/ad-operations`),
  getAnalytics: (
    accountId: string,
    range: { from: string; to: string },
    entityType?: ManualStatusInput["entityType"],
  ) => {
    const query = new URLSearchParams({ from: range.from, to: range.to });
    if (entityType) query.set("entityType", entityType);
    return request<MetricBatchRecord[]>(
      `/api/accounts/${accountId}/analytics?${query.toString()}`,
    );
  },
  getMaintenanceStatus: () =>
    request<MaintenanceStatus>("/api/maintenance/status"),
  getAuditLogs: (filters: Partial<AuditLogFilter> = {}) => {
    const query = new URLSearchParams();
    if (filters.accountId) query.set("accountId", filters.accountId);
    if (filters.actorId) query.set("actorId", filters.actorId);
    if (filters.action) query.set("action", filters.action);
    if (filters.correlationId) query.set("correlationId", filters.correlationId);
    if (filters.from) query.set("from", filters.from);
    if (filters.to) query.set("to", filters.to);
    if (filters.limit) query.set("limit", String(filters.limit));
    return request<AuditLogRecord[]>(`/api/maintenance/audit?${query.toString()}`);
  },
  getDatabaseBackups: () =>
    request<DatabaseBackupRecord[]>("/api/maintenance/backups"),
  createDatabaseBackup: () =>
    request<DatabaseBackupRecord>("/api/maintenance/backups", { method: "POST" }),
  verifyDatabaseBackup: (backupId: string) =>
    request<DatabaseBackupRecord>(`/api/maintenance/backups/${backupId}/verify`, { method: "POST" }),
  requestDatabaseRestore: (backupId: string) =>
    request<{ backup: DatabaseBackupRecord; restartRequired: boolean; message: string }>(
      `/api/maintenance/backups/${backupId}/restore`,
      { method: "POST" },
    ),
  checkForUpdates: () =>
    request<UpdateRuntimeStatus>("/api/maintenance/updates/check", { method: "POST" }),
  downloadUpdate: () =>
    request<UpdateRuntimeStatus>("/api/maintenance/updates/download", { method: "POST" }),
  installUpdate: () =>
    request<UpdateRuntimeStatus>("/api/maintenance/updates/install", { method: "POST" }),
};
