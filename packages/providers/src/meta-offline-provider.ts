import type {
  AppealMutation,
  AppealMutationResult,
  AdsProvider,
  CreationMutationResult,
  DeleteAdGroupMutation,
  DeleteAdGroupMutationResult,
  NewCreationMutation,
  ProviderCapability,
  ProviderContext,
  ProviderHealth,
  ProviderSyncOutput,
  StatusMutation,
  StatusMutationResult,
  TemplateCopyMutation,
} from "./types.js";
import type { LaunchOriginalPost, LaunchProductInfo } from "@tk-auto/core";

export const META_OFFLINE_UNAVAILABLE_MESSAGE =
  "Meta Marketing API 尚未接入；当前仅提供零网络离线骨架。";

const capabilities: ReadonlySet<ProviderCapability> = new Set();

/**
 * Meta 的平台占位实现。
 *
 * 当前阶段只允许架构和注册表识别 Meta；任何读取、写入、授权或健康探测
 * 都必须保持离线，直至单独实现并审核真实 Meta Marketing API 适配器。
 */
export class MetaOfflineAdsProvider implements AdsProvider {
  readonly kind = "meta-offline" as const;
  readonly platform = "meta" as const;
  readonly displayName = "Meta Ads（离线骨架）";
  readonly implementationStatus = "scaffolded" as const;
  readonly capabilityVersion = "meta-offline-scaffold-v1-2026-08";
  readonly capabilities = capabilities;

  resolveCapabilities(): ReadonlySet<ProviderCapability> {
    return capabilities;
  }

  async checkHealth(_context: ProviderContext): Promise<ProviderHealth> {
    return {
      ok: false,
      status: "failed",
      message: META_OFFLINE_UNAVAILABLE_MESSAGE,
    };
  }

  async syncReadOnly(_context: ProviderContext): Promise<ProviderSyncOutput> {
    throw unavailable("只读同步");
  }

  async readAdGroupOriginalPosts(
    _context: ProviderContext,
    _input: { campaignId: string; adGroupId: string },
  ): Promise<{
    posts: LaunchOriginalPost[];
    productUrl: string | null;
    productInfo: LaunchProductInfo | null;
    catalogSetup: 0 | 1 | null;
  }> {
    throw unavailable("原帖读取");
  }

  async readAccessibleOriginalPosts(
    _context: ProviderContext,
    _sourcePosts: LaunchOriginalPost[],
  ): Promise<LaunchOriginalPost[]> {
    throw unavailable("可访问原帖读取");
  }

  async changeStatus(
    _context: ProviderContext,
    _mutations: StatusMutation[],
  ): Promise<StatusMutationResult[]> {
    throw unavailable("状态变更");
  }

  async create(
    _context: ProviderContext,
    _mutations: NewCreationMutation[],
  ): Promise<CreationMutationResult[]> {
    throw unavailable("广告创建");
  }

  async copy(
    _context: ProviderContext,
    _mutations: TemplateCopyMutation[],
  ): Promise<CreationMutationResult[]> {
    throw unavailable("广告复制");
  }

  async appeal(
    _context: ProviderContext,
    _mutations: AppealMutation[],
  ): Promise<AppealMutationResult[]> {
    throw unavailable("广告申诉");
  }

  async deleteAdGroups(
    _context: ProviderContext,
    _mutations: DeleteAdGroupMutation[],
  ): Promise<DeleteAdGroupMutationResult[]> {
    throw unavailable("广告组删除");
  }
}

export class MetaOfflineProviderUnavailableError extends Error {
  override readonly name = "MetaOfflineProviderUnavailableError";
}

function unavailable(operation: string): MetaOfflineProviderUnavailableError {
  return new MetaOfflineProviderUnavailableError(
    `${META_OFFLINE_UNAVAILABLE_MESSAGE}${operation}不可用。`,
  );
}
