import type { ProviderKind } from "@tk-auto/core";
import { CookieAdsProvider } from "./cookie-provider.js";
import { OfficialApiAdsProvider } from "./official-api-provider.js";
import type {
  AdsProvider,
  ProviderDescriptor,
  ProviderHealth,
  ProviderContext,
  ProviderSyncOutput,
  StatusMutation,
  StatusMutationResult,
  CreationMutation,
  CreationMutationResult,
} from "./types.js";

export class ProviderRegistry {
  private readonly providers = new Map<ProviderKind, AdsProvider>();

  constructor(providers: AdsProvider[] = defaultProviders()) {
    for (const provider of providers) {
      this.providers.set(provider.kind, provider);
    }
  }

  get(kind: ProviderKind): AdsProvider {
    const provider = this.providers.get(kind);
    if (!provider) {
      throw new Error(`Provider not registered: ${kind}`);
    }
    return provider;
  }

  list(): ProviderDescriptor[] {
    return [...this.providers.values()].map((provider) => ({
      kind: provider.kind,
      displayName: provider.displayName,
      implementationStatus: "available",
      capabilities: [...provider.capabilities],
    }));
  }

  checkHealth(
    kind: ProviderKind,
    context: ProviderContext,
  ): Promise<ProviderHealth> {
    return this.get(kind).checkHealth(context);
  }

  syncReadOnly(
    kind: ProviderKind,
    context: ProviderContext,
  ): Promise<ProviderSyncOutput> {
    return this.get(kind).syncReadOnly(context);
  }

  changeStatus(
    kind: ProviderKind,
    context: ProviderContext,
    mutations: StatusMutation[],
  ): Promise<StatusMutationResult[]> {
    return this.get(kind).changeStatus(context, mutations);
  }

  async createFromPreset(
    kind: ProviderKind,
    context: ProviderContext,
    mutations: CreationMutation[],
  ): Promise<CreationMutationResult[]> {
    const provider = this.get(kind);
    if (!provider.createFromPreset) {
      throw new Error(`${provider.displayName} 暂不支持通过预设创建广告。`);
    }
    return provider.createFromPreset(context, mutations);
  }
}

function defaultProviders(): AdsProvider[] {
  return [new CookieAdsProvider(), new OfficialApiAdsProvider()];
}
