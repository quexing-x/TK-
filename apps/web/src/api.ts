import type {
  AccountConfig,
  AccountSettingsUpdate,
  AccountCreateInput,
  GlobalAutomationSettings,
  GlobalAutomationSettingsInput,
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
} from "@tk-auto/core";
import type { TikTokCookieImportReadiness as CookieConnectionReadiness } from "@tk-auto/providers";

export type { CookieConnectionReadiness };

export interface ProviderDescriptor {
  kind: ProviderKind;
  displayName: string;
  implementationStatus: "scaffolded" | "available";
  capabilities: string[];
}

export interface BootstrapPayload {
  accounts: AccountConfig[];
  globalAutomationSettings: GlobalAutomationSettings;
  systemRuntime: SystemRuntimeState;
  providers: ProviderDescriptor[];
}

export interface ManualStatusResult extends ManualStatusInput {
  ok: boolean;
  message: string;
}

let csrfToken: string | null = null;

export function setAuthSession(status: AuthStatus | null): void {
  csrfToken = status?.csrfToken ?? null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)
        ? { "x-csrf-token": csrfToken }
        : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(payload?.message ?? `请求失败 (${response.status})`);
  }

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
  logout: async () => {
    const result = await request<{ ok: boolean }>("/api/auth/logout", {
      method: "POST",
    });
    setAuthSession(null);
    return result;
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
  getAutomationFeatures: () =>
    request<AutomationFeatureSettings>("/api/automation/features"),
  updateAutomationFeatures: (input: AutomationFeatureSettingsInput) =>
    request<AutomationFeatureSettings>("/api/automation/features", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
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
  createLaunchPlan: (input: MultiAccountLaunchPlanInput) =>
    request<MultiAccountLaunchPlanRecord>("/api/launch-plans", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cancelLaunchPlan: (planId: string) =>
    request<void>(`/api/launch-plans/${planId}`, { method: "DELETE" }),
  bootstrap: () => request<BootstrapPayload>("/api/bootstrap"),
  createAccount: (input: AccountCreateInput) =>
    request<AccountConfig>("/api/accounts", {
      method: "POST",
      body: JSON.stringify(input),
    }),
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
  getCookieReadiness: (accountId: string) =>
    request<CookieConnectionReadiness>(
      `/api/accounts/${accountId}/connections/cookie/readiness`,
    ),
  importCookieCurl: (
    accountId: string,
    command: string,
    step?: "read" | "status",
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
  changeEntityStatus: (accountId: string, input: ManualStatusInput) =>
    request<ManualStatusResult>(`/api/accounts/${accountId}/entities/status`, {
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
  getAdOperations: (accountId: string) =>
    request<AdOperationRecord[]>(`/api/accounts/${accountId}/ad-operations`),
  queueAppeal: (accountId: string, externalId: string, reason: string) =>
    request<AdOperationRecord>(`/api/accounts/${accountId}/appeals`, {
      method: "POST",
      body: JSON.stringify({ externalId, reason }),
    }),
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
};
