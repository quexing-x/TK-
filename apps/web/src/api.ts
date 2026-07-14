import type {
  AccountConfig,
  AccountSettingsUpdate,
  AutomationSwitchRisk,
  AutomationSwitches,
  AutomationAction,
  AutomationDecisionRecord,
  AutomationRunRecord,
  ProviderConnection,
  ProviderConnectionSettings,
  ProviderCredentialInput,
  ProviderKind,
  ReadOnlySyncResult,
  SyncEntityType,
  ThresholdConfig,
  ThresholdInput,
} from "@tk-auto/core";

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
  providers: ProviderDescriptor[];
  switchDefinitions: SwitchDefinition[];
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
  providerHealth: (accountId: string) =>
    request<ProviderConnection | null>(
      `/api/accounts/${accountId}/provider-health`,
    ),
  getConnections: (accountId: string) =>
    request<ProviderConnection[]>(`/api/accounts/${accountId}/connections`),
  importCookieCurl: (accountId: string, command: string) =>
    request<ProviderConnection>(
      `/api/accounts/${accountId}/connections/cookie/import-curl`,
      { method: "POST", body: JSON.stringify({ command }) },
    ),
  importCookieStatusCurl: (
    accountId: string,
    command: string,
    entityType: SyncEntityType,
    action: AutomationAction,
  ) =>
    request<ProviderConnection>(
      `/api/accounts/${accountId}/connections/cookie/import-status-curl`,
      {
        method: "POST",
        body: JSON.stringify({ command, entityType, action }),
      },
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
};
