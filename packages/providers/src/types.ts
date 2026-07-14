import type {
  ProviderConnectionSettings,
  ProviderCredentialInput,
  ProviderEntity,
  ProviderKind,
  ReadOnlySyncResult,
  AutomationAction,
  SyncEntityType,
} from "@tk-auto/core";

export type ProviderCapability =
  | "read-campaigns"
  | "read-ad-groups"
  | "read-ads"
  | "read-reports"
  | "create-campaigns"
  | "copy-ads"
  | "change-status"
  | "delete-ad-groups"
  | "appeal-ads";

export interface ProviderContext {
  accountId: string;
  settings: ProviderConnectionSettings;
  credential: ProviderCredentialInput;
  timezone?: string;
}

export interface ProviderHealth {
  ok: boolean;
  status: "ready" | "failed";
  message: string;
}

export interface ProviderSyncOutput {
  entities: ProviderEntity[];
  result: ReadOnlySyncResult;
}

export interface StatusMutation {
  entityType: SyncEntityType;
  externalId: string;
  action: AutomationAction;
}

export interface StatusMutationResult extends StatusMutation {
  ok: boolean;
  message: string;
}

export interface AdsProvider {
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;
  checkHealth(context: ProviderContext): Promise<ProviderHealth>;
  syncReadOnly(context: ProviderContext): Promise<ProviderSyncOutput>;
  changeStatus(
    context: ProviderContext,
    mutations: StatusMutation[],
  ): Promise<StatusMutationResult[]>;
}

export interface ProviderDescriptor {
  kind: ProviderKind;
  displayName: string;
  implementationStatus: "scaffolded" | "available";
  capabilities: ProviderCapability[];
}
