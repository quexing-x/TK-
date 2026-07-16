import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CookieCredentialInputSchema } from "../packages/core/src/index.ts";
import { WindowsDpapiCredentialVault } from "../packages/credentials/src/index.ts";
import { AutomationStore } from "../packages/storage/src/index.ts";

const har = JSON.parse(await readFile(process.argv[2], "utf8"));
const entries = har.log?.entries ?? [];
const publishIndex = entries.findIndex((entry: any) => new URL(entry.request.url).pathname.includes("async_creation/create_by_snap"));
if (publishIndex < 0) throw new Error("HAR 中未找到成功发布请求。");
const campaignEntry = entries.slice(0, publishIndex).reverse().find((entry: any) => new URL(entry.request.url).pathname.includes("campaign_snap/save"));
if (!campaignEntry) throw new Error("HAR 中未找到发布前的系列保存请求。");
const campaignPayload = JSON.parse(campaignEntry.request.postData.text);
const publishPayload = JSON.parse(entries[publishIndex].request.postData.text);
const dataDirectory = resolve("../data");
const store = new AutomationStore(join(dataDirectory, "tk-automation.db"));
const vault = new WindowsDpapiCredentialVault(join(dataDirectory, "credentials"));
try {
  const account = store.listAccounts().find((item) => item.displayName === "测试");
  if (!account) throw new Error("未找到测试账户。");
  const connection = store.getProviderConnection(account.id, "cookie");
  if (!connection?.credentialRef) throw new Error("测试账户未接入。");
  const raw = await vault.read(connection.credentialRef);
  if (!raw) throw new Error("测试账户凭据已失效。");
  const credential = CookieCredentialInputSchema.parse(JSON.parse(raw));
  if (!credential.creationProfile) throw new Error("测试账户缺少创建模板。");
  const updated = CookieCredentialInputSchema.parse({
    ...credential,
    creationProfile: { ...credential.creationProfile, campaignPayload, publishPayload, verifiedAt: null },
  });
  const reference = await vault.create(JSON.stringify(updated));
  try {
    store.setProviderCredentialReference(account.id, "cookie", reference);
    await vault.delete(connection.credentialRef);
  } catch (error) {
    await vault.delete(reference);
    throw error;
  }
  console.log("测试账户的系列保存与发布模板已从 HAR 安全刷新。");
} finally {
  store.close();
}
