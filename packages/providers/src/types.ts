import type {
  ProviderConnectionSettings,
  ProviderCredentialInput,
  ProviderEntity,
  ProviderKind,
  ReadOnlySyncResult,
  AutomationAction,
  SyncEntityType,
  CreationPresetConfig,
  LaunchConfigurationRow,
  LaunchCreationProgress,
  ProviderCapability,
} from "@tk-auto/core";

export type { ProviderCapability } from "@tk-auto/core";

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
  failureKind?: "retryable" | "unknown";
}

export class RetryableStatusMutationError extends Error {
  override readonly name = "RetryableStatusMutationError";
}

export class UnknownStatusMutationStateError extends Error {
  override readonly name = "UnknownStatusMutationStateError";
}

export interface CreationMutation {
  row: LaunchConfigurationRow;
  preset: CreationPresetConfig;
  initialStatus: "enabled" | "disabled";
  templateMode: "none" | "copy";
  templateCampaignId?: string;
  operationId?: string;
  attemptId?: string;
  correlationId?: string;
  batchId?: string;
  onProgress?: (progress: LaunchCreationProgress) => void;
}

export interface CreationMutationResult extends CreationMutation {
  ok: boolean;
  campaignId?: string;
  adGroupId?: string;
  adId?: string;
  message: string;
  failureKind?: "retryable" | "unknown";
}

export class RetryableCreationError extends Error {
  override readonly name: string = "RetryableCreationError";
}

export class ConfirmedCreationFailureError extends RetryableCreationError {
  override readonly name = "ConfirmedCreationFailureError";
}

export class UnknownCreationStateError extends Error {
  override readonly name = "UnknownCreationStateError";
}

export interface ProviderContract {
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly capabilityVersion: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;
  resolveCapabilities?(context: ProviderContext): ReadonlySet<ProviderCapability>;
  checkHealth(context: ProviderContext): Promise<ProviderHealth>;
}

export interface ReadProvider extends ProviderContract {
  syncReadOnly(context: ProviderContext): Promise<ProviderSyncOutput>;
}

export interface StatusMutationProvider extends ProviderContract {
  changeStatus(
    context: ProviderContext,
    mutations: StatusMutation[],
  ): Promise<StatusMutationResult[]>;
}

export type NewCreationMutation = Omit<
  CreationMutation,
  "templateMode" | "templateCampaignId"
>;

export interface CreationProvider extends ProviderContract {
  create(
    context: ProviderContext,
    mutations: NewCreationMutation[],
  ): Promise<CreationMutationResult[]>;
}

export type TemplateCopyMutation = Omit<CreationMutation, "templateMode"> & {
  templateCampaignId: string;
};

export interface TemplateCopyProvider extends ProviderContract {
  copy(
    context: ProviderContext,
    mutations: TemplateCopyMutation[],
  ): Promise<CreationMutationResult[]>;
}

export interface AppealMutation {
  externalId: string;
  reason: string;
}

export interface AppealMutationResult extends AppealMutation {
  ok: boolean;
  message: string;
}

export interface AppealProvider extends ProviderContract {
  appeal(
    context: ProviderContext,
    mutations: AppealMutation[],
  ): Promise<AppealMutationResult[]>;
}

export type AdsProvider = ProviderContract
  & Partial<ReadProvider>
  & Partial<StatusMutationProvider>
  & Partial<CreationProvider>
  & Partial<TemplateCopyProvider>
  & Partial<AppealProvider>;

export interface ProviderDescriptor {
  kind: ProviderKind;
  displayName: string;
  implementationStatus: "scaffolded" | "available";
  capabilityVersion: string;
  capabilities: ProviderCapability[];
}
