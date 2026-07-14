import type { ProviderKind } from "@tk-auto/core";
import { CookieAdsProvider } from "./cookie-provider.js";
import { OfficialApiAdsProvider } from "./official-api-provider.js";
import type {
  AdsProvider,
  ProviderDescriptor,
  ProviderHealth,
  ProviderContext,
  ProviderSyncOutput,
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
      implementationStatus: "scaffolded",
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
}

function defaultProviders(): AdsProvider[] {
  return [new CookieAdsProvider(), new OfficialApiAdsProvider()];
}
