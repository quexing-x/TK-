import { join, resolve } from "node:path";
import { CookieCredentialInputSchema, normalizeProviderEntity, type ProviderEntity, type SyncEntityType } from "../packages/core/src/index.ts";
import { WindowsDpapiCredentialVault } from "../packages/credentials/src/index.ts";
import { CookieAdsProvider } from "../packages/providers/src/index.ts";
import { AutomationStore } from "../packages/storage/src/index.ts";
import { installOutboundProxy, resolveOutboundProxy } from "../apps/api/src/proxy.ts";

const expected = {
  campaign: required("TK_VERIFY_CAMPAIGN_NAME"),
  "ad-group": required("TK_VERIFY_ADGROUP_NAME"),
  ad: required("TK_VERIFY_AD_NAME"),
} as const;
const store = new AutomationStore(join(resolve("../data"), "tk-automation.db"));
const vault = new WindowsDpapiCredentialVault(join(resolve("../data"), "credentials"));
const proxyAgent = installOutboundProxy(resolveOutboundProxy());
try {
  const account = store.listAccounts().find((item) => item.displayName === "测试");
  if (!account || account.providerKind !== "cookie") throw new Error("只允许回读名为“测试”的 Cookie 账户。");
  const connection = store.getProviderConnection(account.id, "cookie");
  if (!connection?.credentialRef) throw new Error("测试账户未接入。");
  const raw = await vault.read(connection.credentialRef);
  if (!raw) throw new Error("测试账户凭据已失效。");
  const provider = new CookieAdsProvider();
  const sync = await provider.syncReadOnly({
    accountId: account.id,
    settings: connection.settings,
    credential: CookieCredentialInputSchema.parse(JSON.parse(raw)),
    timezone: account.timezone,
  });
  const verification = (["campaign", "ad-group", "ad"] as const).map((entityType) => {
    const matches = sync.entities.filter((entity) => entity.entityType === entityType && entityName(entity) === expected[entityType]);
    const statuses = matches.map((entity) => normalizeProviderEntity(entity).status);
    return { entityType, matchCount: matches.length, statuses };
  });
  const available = (["campaign", "ad-group", "ad"] as const).map((entityType) => ({
    entityType,
    items: sync.entities.filter((entity) => entity.entityType === entityType).map((entity) => ({ name: entityName(entity), status: normalizeProviderEntity(entity).status })),
  }));
  console.log(JSON.stringify({ counts: sync.result.counts, verification, available }));
  const missing = verification.filter((item) => item.matchCount === 0);
  if (missing.length > 0) throw new Error(`尚未回读到：${missing.map((item) => item.entityType).join("、")}。`);
  const unsafe = verification.filter((item) => item.statuses.some((status) => status !== "disabled"));
  if (unsafe.length > 0) throw new Error(`以下层级未确认全部关闭：${unsafe.map((item) => item.entityType).join("、")}。`);
  console.log("已回读系列、广告组和广告，三层均为关闭状态。");
} finally {
  await proxyAgent?.close();
  store.close();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}。`);
  return value;
}

function entityName(entity: ProviderEntity): string {
  const keys: Record<SyncEntityType, string[]> = {
    campaign: ["campaign_name", "name"],
    "ad-group": ["ad_name", "adgroup_name", "ad_group_name", "name"],
    ad: ["creative_name", "ad_name", "name"],
  };
  for (const key of keys[entity.entityType]) {
    if (typeof entity.payload[key] === "string") return entity.payload[key];
  }
  return "";
}
