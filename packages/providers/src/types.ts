import type {
  ProviderConnectionSettings,
  ProviderCredentialInput,
  MetaAccessSecretBundleInput,
  ProviderEntity,
  ProviderKind,
  PlatformKind,
  ReadOnlySyncResult,
  AutomationAction,
  SyncEntityType,
  CreationPresetConfig,
  LaunchConfigurationRow,
  LaunchCreationEvidence,
  LaunchCreationProgress,
  ProviderCapability,
  LaunchOriginalPost,
  LaunchProductInfo,
  MetaAdCreationInput,
  MetaCreationProgress,
} from "@tk-auto/core";

export type { ProviderCapability } from "@tk-auto/core";

export interface ResolvedMetaAccessProfile {
  profileId: string;
  appId: string;
  businessId?: string | null;
  graphApiVersion: string;
}

export interface ProviderContext {
  accountId: string;
  settings: ProviderConnectionSettings;
  credential: ProviderCredentialInput | (MetaAccessSecretBundleInput & { kind?: never });
  timezone?: string;
  resolvedMetaAccessProfile?: ResolvedMetaAccessProfile;
}

export interface MetaAdAccountDiscoveryContext {
  credential: MetaAccessSecretBundleInput;
  resolvedMetaAccessProfile: ResolvedMetaAccessProfile;
}

export interface DiscoveredMetaAdAccount {
  adAccountId: string;
  name: string;
  currency: string;
  timezone: string;
  accountStatus: number;
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
  /**
   * 素材所属广告组的 ID。只有 entityType 为 material 时才需要：
   * procedural_material/update_status 要同时带广告组 ID 和素材 ID，光有素材 ID
   * 发不出去。其余三层不用填。
   */
  parentAdGroupId?: string;
}

export interface StatusMutationResult extends StatusMutation {
  ok: boolean;
  message: string;
  failureKind?: "retryable" | "unknown";
}

export interface MetaAdCreationMutation {
  input: MetaAdCreationInput;
  existing: {
    campaignId?: string;
    adSetId?: string;
    creativeId?: string;
    adId?: string;
  };
  onBeforeDispatch?: () => void;
  onProgress?: (progress: MetaCreationProgress) => void;
}

export interface MetaAdCreationResult {
  ok: boolean;
  campaignId?: string;
  adSetId?: string;
  creativeId?: string;
  adId?: string;
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
  batchCampaignId?: string;
  batchAdGroupNames?: string[];
  /** Frozen posts resolved in the target advertiser account for an original-post
   * migration. When present the provider must use these records directly and
   * must not resolve video codes, upload media, or authorize Spark posts. */
  originalPosts?: LaunchOriginalPost[];
  /** Product metadata frozen from the source creative. Provider-specific asset
   * ids are stripped before it crosses advertiser accounts. */
  originalProductInfo?: LaunchProductInfo;
  originalCatalogSetup?: 0 | 1;
  /** Read-only recovery for a previously unknown dispatch. The provider must
   * query remote state and must not save or publish another draft. */
  reconcileOnly?: boolean;
  /** Snap/sketch ids persisted before an unknown result. They scope read-only
   * reconciliation to this task instead of unrelated account drafts. */
  reconcileEvidence?: LaunchCreationEvidence;
  onBeforeDispatch?: () => void;
  onProgress?: (progress: LaunchCreationProgress) => void;
}

export interface CreationMutationResult extends CreationMutation {
  ok: boolean;
  campaignId?: string;
  adGroupId?: string;
  adId?: string;
  message: string;
  /** Non-blocking completion detail. A created campaign/ad-group remains a
   * success when TikTok skips its ad material during publication. */
  warning?: string;
  failureKind?: "retryable" | "unknown";
  /** False when an earlier accepted mutation makes replaying the whole
   * operation unsafe even though the final rejection is explicit. */
  retrySafe?: boolean;
  /** True only when read-only reconciliation positively proved that neither a
   * formal object nor this task's draft exists remotely. */
  reconciliationVerifiedAbsent?: boolean;
}

export class RetryableCreationError extends Error {
  override readonly name: string = "RetryableCreationError";
}

export class ConfirmedCreationFailureError extends RetryableCreationError {
  override readonly name = "ConfirmedCreationFailureError";

  constructor(message: string, readonly retrySafe = true) {
    super(message);
  }
}

export class UnknownCreationStateError extends Error {
  override readonly name = "UnknownCreationStateError";
}

export interface ProviderContract {
  readonly kind: ProviderKind;
  readonly platform: PlatformKind;
  readonly displayName: string;
  readonly implementationStatus: ProviderImplementationStatus;
  readonly capabilityVersion: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;
  resolveCapabilities?(context: ProviderContext): ReadonlySet<ProviderCapability>;
  checkHealth(context: ProviderContext): Promise<ProviderHealth>;
}

export interface ReadProvider extends ProviderContract {
  syncReadOnly(context: ProviderContext): Promise<ProviderSyncOutput>;
  /**
   * 只回读一个实体，用于状态写入后的确认。
   *
   * 可选：不实现（或返回 null）时调用方退回全量同步。存在的意义是省时间——
   * 全量同步在生产账户上实测 64.8 秒，而定向回读不到 1 秒。
   */
  readEntityById?(
    context: ProviderContext,
    entityType: "campaign" | "ad-group" | "ad",
    externalId: string,
  ): Promise<ProviderEntity | null>;
}

export interface OriginalPostMigrationProvider extends ProviderContract {
  readAdGroupOriginalPosts(
    context: ProviderContext,
    input: { campaignId: string; adGroupId: string },
  ): Promise<{ posts: LaunchOriginalPost[]; productUrl: string | null; productInfo: LaunchProductInfo | null; catalogSetup: 0 | 1 | null }>;
  readAccessibleOriginalPosts(
    context: ProviderContext,
    sourcePosts: LaunchOriginalPost[],
  ): Promise<LaunchOriginalPost[]>;
}

export interface StatusMutationProvider extends ProviderContract {
  changeStatus(
    context: ProviderContext,
    mutations: StatusMutation[],
  ): Promise<StatusMutationResult[]>;
}

export interface MetaAdCreationProvider extends ProviderContract {
  createMetaAd(
    context: ProviderContext,
    mutation: MetaAdCreationMutation,
  ): Promise<MetaAdCreationResult>;
  reconcileMetaAd(
    context: ProviderContext,
    mutation: Pick<MetaAdCreationMutation, "input" | "existing">,
  ): Promise<MetaAdCreationResult>;
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
  creativeId: string;
  /**
   * 广告所属的广告组 ID。真机申诉报文里的 `ad_id` 装的是广告组，`creative_id` 才是
   * 广告自己；此前两个位置都填了广告 ID，是 2026-08-06 申诉全败的原因之一。
   */
  adGroupId: string;
  reason: string;
}

export interface AppealMutationResult extends AppealMutation {
  ok: boolean;
  message: string;
  failureKind?: "retryable" | "unknown";
}

export interface AppealProvider extends ProviderContract {
  appeal(
    context: ProviderContext,
    mutations: AppealMutation[],
  ): Promise<AppealMutationResult[]>;
}

export interface DeleteAdGroupMutation {
  externalId: string;
}

export interface DeleteAdGroupMutationResult extends DeleteAdGroupMutation {
  ok: boolean;
  message: string;
  failureKind?: "retryable" | "unknown";
}

export interface DeleteAdGroupProvider extends ProviderContract {
  deleteAdGroups(
    context: ProviderContext,
    mutations: DeleteAdGroupMutation[],
  ): Promise<DeleteAdGroupMutationResult[]>;
}

export interface AdGroupBudgetMutation {
  /** 广告组 ID。update_budget 的路径段虽然写作 `ad`，装的却是广告组——与申诉、素材启停同一套口径。 */
  externalId: string;
  /** 目标日预算，账户币种。 */
  budget: number;
}

export interface AdGroupBudgetMutationResult extends AdGroupBudgetMutation {
  ok: boolean;
  message: string;
  failureKind?: "retryable" | "unknown";
}

export interface AdGroupBudgetProvider extends ProviderContract {
  updateAdGroupBudgets(
    context: ProviderContext,
    mutations: AdGroupBudgetMutation[],
  ): Promise<AdGroupBudgetMutationResult[]>;
}

export type AdsProvider = ProviderContract
  & Partial<ReadProvider>
  & Partial<OriginalPostMigrationProvider>
  & Partial<StatusMutationProvider>
  & Partial<MetaAdCreationProvider>
  & Partial<CreationProvider>
  & Partial<TemplateCopyProvider>
  & Partial<AppealProvider>
  & Partial<DeleteAdGroupProvider>
  & Partial<AdGroupBudgetProvider>;

export interface ProviderDescriptor {
  kind: ProviderKind;
  platform: PlatformKind;
  displayName: string;
  implementationStatus: ProviderImplementationStatus;
  capabilityVersion: string;
  capabilities: ProviderCapability[];
}

export type ProviderImplementationStatus = "scaffolded" | "available";
