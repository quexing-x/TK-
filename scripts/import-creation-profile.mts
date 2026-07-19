import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CookieCredentialInputSchema } from "../packages/core/src/index.ts";
import { WindowsDpapiCredentialVault } from "../packages/credentials/src/index.ts";
import { parseTikTokCurl } from "../packages/providers/src/index.ts";
import { AutomationStore } from "../packages/storage/src/index.ts";
import { installOutboundProxy, resolveOutboundProxy } from "../apps/api/src/proxy.ts";

const accountName = process.env.TK_CREATION_ACCOUNT ?? "测试";
const files = {
  campaign: required("TK_CREATION_CAMPAIGN_CURL"),
  adGroup: required("TK_CREATION_ADGROUP_CURL"),
  creative: required("TK_CREATION_CREATIVE_CURL"),
  publish: required("TK_CREATION_PUBLISH_CURL"),
};
// Matches apps/api/src/server.ts: development data lives one level above the
// workspace unless an explicit desktop data directory is supplied.
const dataDirectory = resolve(process.env.TK_AUTO_DATA_DIR ?? "../data");
const store = new AutomationStore(join(dataDirectory, "tk-automation.db"));
const vault = new WindowsDpapiCredentialVault(join(dataDirectory, "credentials"));
const proxyAgent = installOutboundProxy(resolveOutboundProxy());

try {
  const account = store.listAccounts().find((item) => item.displayName === accountName);
  if (!account) throw new Error(`未找到名为“${accountName}”的账户。`);
  if (account.providerKind !== "cookie") throw new Error("创建模板只支持已接入 Cookie 的测试账户。");
  const connection = store.getProviderConnection(account.id, "cookie");
  if (!connection?.credentialRef) throw new Error("测试账户尚未导入两条 cURL。");
  const saved = await vault.read(connection.credentialRef);
  if (!saved) throw new Error("测试账户的加密凭据引用已失效。请重新导入两条 cURL。");
  const recovered = parseCredentialSecret(saved) as Record<string, unknown>;
  const { creationProfile: _legacyCreationProfile, ...sessionCredential } = recovered;
  const credential = CookieCredentialInputSchema.parse(sessionCredential);
  const [campaign, adGroup, creative, publish] = await Promise.all([
    readCreationBody(files.campaign, "campaign_snap/save"),
    readCreationBody(files.adGroup, "ad_snap/save"),
    readCreationBody(files.creative, "creative_snap/save"),
    readCreationBody(files.publish, "async_creation/create_by_snap"),
  ]);
  const reference = await vault.create(JSON.stringify(CookieCredentialInputSchema.parse({
    ...credential,
    creationProfile: { version: 1, campaignPayload: campaign, adGroupPayload: adGroup, creativePayload: creative, publishPayload: publish, verifiedAt: null },
  })));
  try {
    store.setProviderCredentialReference(account.id, "cookie", reference);
    await vault.delete(connection.credentialRef);
  } catch (error) {
    await vault.delete(reference);
    throw error;
  }
  console.log("创建模板已加密导入；尚未标记为真实验证通过。");
} finally {
  await proxyAgent?.close();
  store.close();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}。`);
  return value;
}
async function readCreationBody(path: string, expectedPath: string): Promise<Record<string, unknown>> {
  const imported = parseTikTokCurl(await readFile(path, "utf8"));
  if (!imported.summary.path.includes(expectedPath)) throw new Error(`创建样本不是 ${expectedPath} 请求。`);
  const body = imported.credential.requestTemplates?.[0]?.body;
  if (!body) throw new Error(`创建样本 ${expectedPath} 缺少 JSON 请求体。`);
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`创建样本 ${expectedPath} 请求体无效。`);
  return parsed as Record<string, unknown>;
}

function parseCredentialSecret(saved: string): unknown {
  try {
    return JSON.parse(saved);
  } catch {
    // The pre-Base64 DPAPI transport could corrupt only the appended Unicode
    // creationProfile. Its preceding Cookie/session object remains valid and
    // can be recovered without exposing or re-requesting credentials.
    const marker = saved.lastIndexOf(',"creationProfile":');
    if (marker < 0) throw new Error("加密凭据已损坏且无法自动恢复，请重新导入两条 cURL。");
    return JSON.parse(`${saved.slice(0, marker)}}`);
  }
}
