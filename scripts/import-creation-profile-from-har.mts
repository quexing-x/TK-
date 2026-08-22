/**
 * 从一次「真机手动创建成功」的 HAR 导入该账户的创建模板。
 *
 * 与 import-creation-profile.mts 的区别只有取材方式：那个脚本吃 4 个 cURL 文件，
 * 而 cURL 文本里带着完整 Cookie，落盘就等于把账户钥匙写进明文文件。这里直接从
 * HAR 里取**请求体**，全程不读也不落任何 header。
 *
 * 凭据改写沿用同一套安全流程：新建加密条目 -> 切换引用 -> 删除旧条目，任何一步
 * 失败都回滚新条目；Cookie / CSRF / cURL 模板等会话材料原样保留。
 *
 * 用法：
 *   TK_CREATION_ACCOUNT="账户显示名" \
 *   TK_AUTO_DATA_DIR="…/data" \
 *   npx tsx scripts/import-creation-profile-from-har.mts <har 文件>
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CookieCredentialInputSchema } from "../packages/core/src/index.ts";
import { WindowsDpapiCredentialVault } from "../packages/credentials/src/index.ts";
import { AutomationStore } from "../packages/storage/src/index.ts";

const harPath = process.argv[2];
if (!harPath) throw new Error("用法：npx tsx scripts/import-creation-profile-from-har.mts <har 文件>");
const accountName = process.env.TK_CREATION_ACCOUNT ?? "测试";
const dataDirectory = resolve(process.env.TK_AUTO_DATA_DIR ?? "../data");

const har = JSON.parse(await readFile(harPath, "utf8")) as {
  log?: { entries?: Array<{ request: { url: string; postData?: { text?: string } }; response: { status: number; content?: { text?: string } } }> };
};
const entries = har.log?.entries ?? [];
const publishIndex = entries.findIndex((entry) => pathOf(entry.request.url).includes("async_creation/create_by_snap"));
if (publishIndex < 0) throw new Error("HAR 中未找到发布请求（async_creation/create_by_snap）。");

// 只认发布成功的那次捕获：失败的报文导进去毫无意义，反而会把坏结构固化下来。
const publishResponse = parseJson(entries[publishIndex]!.response.content?.text ?? "{}");
if (!isRecord(publishResponse) || publishResponse.code !== 0) {
  throw new Error(`HAR 里的发布请求不是成功的（code=${isRecord(publishResponse) ? String(publishResponse.code) : "?"}），拒绝导入。`);
}

const campaign = bodyBefore("campaign_snap/save");
const adGroup = bodyBefore("ad_snap/save");
const creative = bodyBefore("creative_snap/save");
const publish = bodyAt(publishIndex);

// 同一次捕获必须来自同一个广告账户，否则会把别的账户的结构导进来。
const advertiserIds = new Set([publishIndex, indexBefore("campaign_snap/save"), indexBefore("ad_snap/save"), indexBefore("creative_snap/save")]
  .map((index) => new URL(entries[index]!.request.url).searchParams.get("aadvid") ?? ""));
if (advertiserIds.size !== 1) throw new Error(`HAR 里的创建请求来自多个广告账户：${[...advertiserIds].join("、")}`);

const store = new AutomationStore(join(dataDirectory, "tk-automation.db"));
const vault = new WindowsDpapiCredentialVault(join(dataDirectory, "credentials"));
try {
  const account = store.listAccounts().find((item) => item.displayName === accountName);
  if (!account) throw new Error(`未找到名为“${accountName}”的账户。`);
  if (account.providerKind !== "cookie") throw new Error("创建模板只支持已接入 Cookie 的账户。");
  const connection = store.getProviderConnection(account.id, "cookie");
  if (!connection?.credentialRef) throw new Error("该账户尚未接入 Cookie。");
  const settings = connection.settings as { advertiserId?: string } | undefined;
  const capturedAdvertiserId = [...advertiserIds][0];
  if (settings?.advertiserId && capturedAdvertiserId && settings.advertiserId !== capturedAdvertiserId) {
    throw new Error(`HAR 抓的是广告账户 ${capturedAdvertiserId}，而“${accountName}”接入的是 ${settings.advertiserId}，拒绝导入。`);
  }
  const saved = await vault.read(connection.credentialRef);
  if (!saved) throw new Error("该账户的加密凭据引用已失效。");
  const recovered = parseJson(saved) as Record<string, unknown>;
  const { creationProfile: _legacy, ...sessionCredential } = recovered;
  const credential = CookieCredentialInputSchema.parse(sessionCredential);

  const reference = await vault.create(JSON.stringify(CookieCredentialInputSchema.parse({
    ...credential,
    creationProfile: {
      version: 1,
      campaignPayload: campaign,
      adGroupPayload: adGroup,
      creativePayload: creative,
      publishPayload: publish,
      verifiedAt: null,
    },
  })));
  try {
    store.setProviderCredentialReference(account.id, "cookie", reference);
    await vault.delete(connection.credentialRef);
  } catch (error) {
    await vault.delete(reference);
    throw error;
  }
  console.log(`已为“${accountName}”（广告账户 ${capturedAdvertiserId}）导入创建模板；尚未标记为真实验证通过。`);
  console.log(`  campaign ${Object.keys(campaign).length} 字段 / adGroup ${Object.keys(adGroup).length} / creative ${Object.keys(creative).length} / publish ${Object.keys(publish).length}`);
} finally {
  store.close();
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}
function indexBefore(fragment: string): number {
  for (let index = publishIndex - 1; index >= 0; index -= 1) {
    if (pathOf(entries[index]!.request.url).includes(fragment)) return index;
  }
  throw new Error(`HAR 中未找到发布前的 ${fragment} 请求。`);
}
function bodyBefore(fragment: string): Record<string, unknown> {
  return bodyAt(indexBefore(fragment));
}
function bodyAt(index: number): Record<string, unknown> {
  const entry = entries[index]!;
  if (entry.response.status !== 200) throw new Error(`${pathOf(entry.request.url)} 不是成功响应（HTTP ${entry.response.status}）。`);
  const text = entry.request.postData?.text;
  if (!text) throw new Error(`${pathOf(entry.request.url)} 缺少 JSON 请求体。`);
  const parsed = parseJson(text);
  if (!isRecord(parsed)) throw new Error(`${pathOf(entry.request.url)} 请求体无效。`);
  return parsed;
}
function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
