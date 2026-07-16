import { join, resolve } from "node:path";
import { CookieCredentialInputSchema, normalizeProviderEntity, type ProviderEntity } from "../packages/core/src/index.ts";
import { WindowsDpapiCredentialVault } from "../packages/credentials/src/index.ts";
import { CookieAdsProvider } from "../packages/providers/src/index.ts";
import { AutomationStore } from "../packages/storage/src/index.ts";
import { installOutboundProxy, resolveOutboundProxy } from "../apps/api/src/proxy.ts";

const store = new AutomationStore(join(resolve("../data"), "tk-automation.db"));
const vault = new WindowsDpapiCredentialVault(join(resolve("../data"), "credentials"));
const proxyAgent = installOutboundProxy(resolveOutboundProxy());
try {
  if (process.env.TK_ALLOW_LIVE_CREATION !== "disabled-only") {
    throw new Error("真实创建已锁定；必须显式设置 TK_ALLOW_LIVE_CREATION=disabled-only。");
  }
  const matchingAccounts = store.listAccounts().filter((item) => item.displayName === "测试" && item.providerKind === "cookie");
  if (matchingAccounts.length !== 1) throw new Error("必须且只能存在一个名为“测试”的 Cookie 账户。");
  const account = matchingAccounts[0]!;
  const connection = store.getProviderConnection(account.id, "cookie");
  if (!connection?.credentialRef) throw new Error("测试账户未接入。");
  const raw = await vault.read(connection.credentialRef);
  if (!raw) throw new Error("测试账户凭据已失效。");
  const credential = CookieCredentialInputSchema.parse(JSON.parse(raw));
  const provider = new CookieAdsProvider();
  const context = { accountId: account.id, settings: connection.settings, credential, timezone: account.timezone };
  const health = await provider.checkHealth(context);
  store.updateProviderStatus(account.id, "cookie", health.status, health.message);
  if (!health.ok) throw new Error(`测试账户连接验证失败：${health.message}`);
  const rows = JSON.parse(process.env.TK_CREATION_ROWS_JSON ?? "[]");
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 10) throw new Error("创建验证行数无效。");
  const result = await provider.createFromPreset!(context, rows.map((row, index) => ({
    row: { ...row, videoCode: "__COPY_SOURCE__", rowNumber: index + 2, adName: `260716:${String(index + 1).padStart(3, "0")}`, region: "测试", dailyBudget: 1, bid: null, startAt: null, endAt: null, initialStatus: "disabled" },
    preset: {}, initialStatus: "disabled", sourceCampaignName: "测试系列0716",
  })));
  if (!result.every((item) => item.ok)) {
    const failures = result.filter((item) => !item.ok).map((item, index) => `第 ${index + 1} 条：${item.message}`).join("；");
    throw new Error(`TikTok 未接受全部关闭状态的创建请求。${failures}`);
  }
  const campaignIds = result.map((item) => item.campaignId).filter((id): id is string => typeof id === "string" && id.length > 0);
  if (campaignIds.length !== result.length) throw new Error("TikTok 创建结果缺少系列正式 ID，未通过验收。");
  let verified: ProviderEntity[] = [];
  let completeHierarchy = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    const sync = await provider.syncReadOnly(context);
    const campaigns = sync.entities.filter((entity) => entity.entityType === "campaign" && campaignIds.includes(entity.externalId));
    const adGroups = sync.entities.filter((entity) => entity.entityType === "ad-group" && campaignIds.includes(String(entity.payload.campaign_id ?? "")));
    const adGroupIds = new Set(adGroups.map((entity) => entity.externalId));
    const ads = sync.entities.filter((entity) => entity.entityType === "ad" && (
      campaignIds.includes(String(entity.payload.campaign_id ?? "")) || [
        entity.payload.adgroup_id,
        entity.payload.ad_group_id,
        entity.payload.ad_id,
      ].some((value) => adGroupIds.has(String(value ?? "")))
    ));
    completeHierarchy = campaignIds.every((campaignId) =>
      campaigns.some((entity) => entity.externalId === campaignId)
      && adGroups.some((entity) => String(entity.payload.campaign_id ?? "") === campaignId)
      && ads.some((entity) => String(entity.payload.campaign_id ?? "") === campaignId || [
        entity.payload.adgroup_id,
        entity.payload.ad_group_id,
        entity.payload.ad_id,
      ].some((value) => adGroups.some((group) => group.externalId === String(value ?? "") && String(group.payload.campaign_id ?? "") === campaignId))),
    );
    verified = [...campaigns, ...adGroups, ...ads];
    if (completeHierarchy) break;
  }
  if (!completeHierarchy) {
    throw new Error("创建任务已完成，但尚未从列表回读到完整的系列、广告组和广告，请稍后重新检查。");
  }
  const unsafe = verified.filter((entity) => normalizeProviderEntity(entity).status !== "disabled");
  if (unsafe.length > 0) throw new Error(`安全验收失败：${[...new Set(unsafe.map((entity) => entity.entityType))].join("、")} 未确认关闭。`);
  if (credential.creationProfile) {
    const verifiedCredential = CookieCredentialInputSchema.parse({
      ...credential,
      creationProfile: { ...credential.creationProfile, verifiedAt: new Date().toISOString() },
    });
    const verifiedReference = await vault.create(JSON.stringify(verifiedCredential));
    try {
      store.setProviderCredentialReference(account.id, "cookie", verifiedReference);
      await vault.delete(connection.credentialRef);
    } catch (error) {
      await vault.delete(verifiedReference);
      throw error;
    }
  }
  console.log(`真实创建验收通过：${result.length} 条任务的系列、广告组、广告均已回读并保持关闭。`);
} finally { await proxyAgent?.close(); store.close(); }
