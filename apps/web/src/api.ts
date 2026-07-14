import type {
  AccountConfig,
  AccountSettingsUpdate,
  AccountCreateInput,
  GlobalAutomationSettings,
  GlobalAutomationSettingsInput,
  AutomationSwitchRisk,
  AutomationSwitches,
  AutomationDecisionRecord,
  AutomationRunRecord,
  ProviderConnection,
  ProviderConnectionSettings,
  ProviderCredentialInput,
  ProviderKind,
  ReadOnlySyncResult,
  ThresholdConfig,
  ThresholdInput,
  AdOperationRecord,
  EntityMetricSnapshotRecord,
  ManagedEntityRecord,
  ManualStatusInput,
} from "@tk-auto/core";

export interface CookieConnectionReadiness {
  dataRequestImported: boolean;
  statusRequestImported: boolean;
  requiredFields: {
    listQuery: boolean;
    updateQuery: boolean;
    copyQuery: boolean;
    csrfToken: boolean;
    cookie: boolean;
  };
  completedFields: number;
  totalFields: 5;
  fieldsComplete: boolean;
}

export interface SwitchDefinition {
  key: keyof AutomationSwitches;
  label: string;
  description: string;
  risk: AutomationSwitchRisk;
}

export interface ProviderDescriptor {
  kind: ProviderKind;
  displayName: string;
  implementationStatus: "scaffolded" | "available";
  capabilities: string[];
}

export interface BootstrapPayload {
  accounts: AccountConfig[];
  globalAutomationSettings: GlobalAutomationSettings;
  providers: ProviderDescriptor[];
  switchDefinitions: SwitchDefinition[];
}

export interface ManualStatusResult extends ManualStatusInput {
  ok: boolean;
  message: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
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
  bootstrap: () => request<BootstrapPayload>("/api/bootstrap"),
  createAccount: (input: AccountCreateInput) =>
    request<AccountConfig>("/api/accounts", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getSwitches: (accountId: string) =>
    request<AutomationSwitches>(`/api/accounts/${accountId}/switches`),
  updateSwitches: (accountId: string, switches: AutomationSwitches) =>
    request<AutomationSwitches>(`/api/accounts/${accountId}/switches`, {
      method: "PUT",
      body: JSON.stringify(switches),
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
  getThresholds: (accountId: string) =>
    request<ThresholdConfig[]>(`/api/accounts/${accountId}/thresholds`),
  createThreshold: (accountId: string, input: ThresholdInput) =>
    request<ThresholdConfig>(`/api/accounts/${accountId}/thresholds`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateThreshold: (
    accountId: string,
    thresholdId: string,
    input: ThresholdInput,
  ) =>
    request<ThresholdConfig>(
      `/api/accounts/${accountId}/thresholds/${thresholdId}`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      },
    ),
  deleteThreshold: (accountId: string, thresholdId: string) =>
    request<void>(`/api/accounts/${accountId}/thresholds/${thresholdId}`, {
      method: "DELETE",
    }),
  getGlobalThresholds: () => request<ThresholdConfig[]>("/api/thresholds"),
  createGlobalThreshold: (input: ThresholdInput) =>
    request<ThresholdConfig>("/api/thresholds", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateGlobalThreshold: (thresholdId: string, input: ThresholdInput) =>
    request<ThresholdConfig>(`/api/thresholds/${thresholdId}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteGlobalThreshold: (thresholdId: string) =>
    request<void>(`/api/thresholds/${thresholdId}`, { method: "DELETE" }),
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
  approveDecision: (decisionId: string) =>
    request<AutomationDecisionRecord>(
      `/api/automation/decisions/${decisionId}/approve`,
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
    days: number,
    entityType?: ManualStatusInput["entityType"],
  ) => {
    const query = new URLSearchParams({ days: String(days) });
    if (entityType) query.set("entityType", entityType);
    return request<EntityMetricSnapshotRecord[]>(
      `/api/accounts/${accountId}/analytics?${query.toString()}`,
    );
  },
};
