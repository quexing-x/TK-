import { join, resolve } from "node:path";
import { WindowsDpapiCredentialVault } from "../packages/credentials/src/index.ts";
import { ProviderRegistry } from "../packages/providers/src/index.ts";
import { AutomationStore } from "../packages/storage/src/index.ts";
import { LaunchService } from "../apps/api/src/launch-service.ts";
import { installOutboundProxy, resolveOutboundProxy } from "../apps/api/src/proxy.ts";

if (process.env.TK_ALLOW_LIVE_CREATION !== "disabled-only") {
  throw new Error("真实创建已锁定；必须显式设置 TK_ALLOW_LIVE_CREATION=disabled-only。");
}

const dataDirectory = process.env.TK_DATA_DIR?.trim();
if (!dataDirectory) {
  throw new Error("必须通过 TK_DATA_DIR 指向当前安装实例的数据目录，禁止猜测数据库位置。");
}

const planId = process.env.TK_CREATION_PLAN_ID?.trim();
if (!planId) {
  throw new Error("必须通过 TK_CREATION_PLAN_ID 指定软件内已经保存的创建计划。");
}

const resolvedDataDirectory = resolve(dataDirectory);
const store = new AutomationStore(join(resolvedDataDirectory, "tk-automation.db"));
const vault = new WindowsDpapiCredentialVault(join(resolvedDataDirectory, "credentials"));
const proxyAgent = installOutboundProxy(resolveOutboundProxy());

try {
  const plan = store.getMultiAccountLaunchPlan(planId);
  if (!plan) throw new Error("指定的创建计划不存在。");

  const pendingItems = store
    .listLaunchPlanItems(planId)
    .filter((item) => item.status === "pending");
  if (pendingItems.length !== 1) {
    throw new Error("真实验收脚本每次只允许执行一个 pending 创建项。");
  }

  const [item] = pendingItems;
  const account = item ? store.getAccount(item.accountId) : null;
  if (!item || !account || account.displayName !== "测试" || account.providerKind !== "cookie") {
    throw new Error("真实验收仅允许名为“测试”的 Cookie 账户执行。");
  }
  if (item.launchRow.initialStatus !== "disabled") {
    throw new Error("真实验收创建项必须冻结为关闭状态。");
  }

  const launchService = new LaunchService(store, vault, new ProviderRegistry());
  const execution = await launchService.execute(planId, {
    id: "verified-creation-script",
    name: "真实创建验收脚本",
    kind: "system",
  });
  const result = execution.results.find((candidate) => candidate.itemId === item.itemId);
  if (!result || result.status !== "succeeded") {
    throw new Error(result?.message ?? "创建项没有返回成功结果；请按持久化状态处理，禁止直接重试。");
  }

  const persisted = store
    .listLaunchPlanItems(planId)
    .find((candidate) => candidate.itemId === item.itemId);
  if (!persisted?.campaignId || !persisted.adGroupId || !persisted.adId) {
    throw new Error("创建结果缺少完整的系列、广告组或广告 ID；禁止直接重试。");
  }

  const syncedEntities = store.listManagedEntities(account.id, account.providerKind);
  const createdHierarchy = [
    { entityType: "campaign" as const, externalId: persisted.campaignId },
    { entityType: "ad-group" as const, externalId: persisted.adGroupId },
    { entityType: "ad" as const, externalId: persisted.adId },
  ].map(({ entityType, externalId }) =>
    syncedEntities.find((entity) =>
      entity.entityType === entityType && entity.externalId === externalId,
    ),
  );
  const missingHierarchy = createdHierarchy.some((entity) => !entity);
  const unsafeHierarchy = createdHierarchy.filter((entity) =>
    entity && entity.status !== "disabled",
  );
  if (missingHierarchy || unsafeHierarchy.length > 0 || result.syncWarning) {
    store.setAccountExecutionMode(
      account.id,
      "manual-approval",
      "真实创建后的关闭状态回读未通过，已自动熔断写入；禁止直接重试。",
    );
    if (missingHierarchy) {
      throw new Error("创建已确认，但未从最新同步数据回读到完整的系列、广告组和广告；禁止直接重试。");
    }
    if (unsafeHierarchy.length > 0) {
      throw new Error("创建已确认，但系列、广告组或广告未确认保持关闭；已熔断写入，禁止直接重试。");
    }
    throw new Error(`创建已确认，但回读存在警告：${result.syncWarning}；已熔断写入，禁止直接重试。`);
  }

  console.log("真实创建验收通过：1 个创建项的系列、广告组和广告均已回读并确认保持关闭。");
} finally {
  await proxyAgent?.close();
  store.close();
}
