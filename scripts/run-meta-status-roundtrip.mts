import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  MetaAccessSecretBundleInputSchema,
  MetaMarketingApiConnectionSettingsSchema,
  type AdOperationRecord,
  type WriteTaskActor,
} from "../packages/core/src/index.ts";
import { WindowsDpapiCredentialVault } from "../packages/credentials/src/index.ts";
import {
  MetaMarketingApiAdsProvider,
  MetaMarketingApiHttpTransport,
  ProviderRegistry,
  type MetaMarketingApiStatusTestScope,
  type ProviderContext,
  type StatusMutationResult,
} from "../packages/providers/src/index.ts";
import { AutomationStore } from "../packages/storage/src/index.ts";
import { AutomationService } from "../apps/api/src/automation-service.ts";
import { installOutboundProxy, resolveOutboundProxy } from "../apps/api/src/proxy.ts";

if (process.env.TK_META_LIVE_TEST !== "single-ad-roundtrip") {
  throw new Error("Meta 真实状态实测已锁定；必须显式设置 TK_META_LIVE_TEST=single-ad-roundtrip。");
}

const configPathInput = process.env.TK_META_STATUS_TEST_CONFIG?.trim();
if (!configPathInput || !isAbsolute(configPathInput)) {
  throw new Error("必须通过 TK_META_STATUS_TEST_CONFIG 指定绝对配置路径。");
}
const configPath = assertCanonicalNonReparsePath(configPathInput, "Meta 实测配置文件");

interface LiveTestConfig {
  dataDirectory: string;
  credentialRef: string;
  displayName: string;
  appId: string;
  businessId: string | null;
  adAccountId: string;
  pageId: string;
  graphApiVersion: string;
  expectedCurrency: string;
  expectedTimezone: string;
  expectedCampaignBudgetRemaining: "0";
  target: {
    entityType: "ad";
    externalId: string;
    adSetId: string;
    campaignId: string;
  };
  expiresAt: string;
}

const MIN_SCOPE_REMAINING_MS = 30 * 60_000;
const MAX_SCOPE_REMAINING_MS = 2 * 60 * 60_000;
const RESTORE_SETTLE_TIMEOUT_MS = 60_000;
const RESTORE_SETTLE_INTERVAL_MS = 2_000;

const config = parseConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
const liveTestRoot = resolve("D:\\Temp\\tk-meta-live-test");
const dataDirectory = assertCanonicalNonReparsePath(
  resolve(config.dataDirectory),
  "Meta 实测数据目录",
);
const relativeRunDirectory = relative(liveTestRoot, dataDirectory);
if (!/^run-[A-Za-z0-9_-]+$/.test(relativeRunDirectory)) {
  throw new Error("Meta 实测数据目录必须是 D:\\Temp\\tk-meta-live-test\\run-* 的直接子目录。");
}
if (!sameWindowsPath(dataDirectory, dirname(configPath))) {
  throw new Error("Meta 实测数据目录必须与配置文件父目录完全一致。");
}
const databasePath = join(dataDirectory, "meta-status-roundtrip.db");
const credentialDirectory = join(dataDirectory, "credentials");
const credentialPath = join(credentialDirectory, `${config.credentialRef}.dpapi`);
const evidencePath = join(dataDirectory, "meta-status-roundtrip-evidence.json");
const lockPath = join(dataDirectory, "run.lock");
if (existsSync(databasePath)) {
  throw new Error("Meta 实测数据库已存在；一次性 Scope 禁止重复执行。");
}
if (existsSync(evidencePath)) {
  throw new Error("Meta 实测 evidence 已存在；一次性 Scope 禁止重复执行。");
}
if (!existsSync(credentialPath)) {
  throw new Error("Meta 实测 DPAPI 凭据不存在。");
}
assertCanonicalNonReparsePath(credentialDirectory, "Meta 实测凭据目录");
assertCanonicalNonReparsePath(credentialPath, "Meta 实测 DPAPI 凭据");
try {
  const lockHandle = openSync(lockPath, "wx", 0o600);
  closeSync(lockHandle);
} catch {
  throw new Error("Meta 实测 run.lock 已存在或无法原子创建；禁止并发或重复执行。");
}

const store = new AutomationStore(databasePath, { appVersion: "meta-status-live-test" });
const vault = new WindowsDpapiCredentialVault(credentialDirectory);
const proxyAgent = installOutboundProxy(resolveOutboundProxy());
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  account: {
    displayName: config.displayName,
    adAccountId: normalizeAdAccountId(config.adAccountId),
    currency: config.expectedCurrency,
    timezone: config.expectedTimezone,
    campaignBudgetRemaining: config.expectedCampaignBudgetRemaining,
  },
  target: config.target,
  writes: [],
  restorationRequired: "unknown",
};
let liveTransport: MetaMarketingApiHttpTransport | null = null;
let liveContext: ProviderContext | null = null;

try {
  store.seed();
  store.deleteAccount("demo-account", []);
  store.updateSystemRuntimeState({ enabled: false });
  const account = store.createAccount({
    displayName: config.displayName,
    platform: "meta",
    accountType: "standard",
    enabled: false,
    providerKind: "meta-marketing-api",
  });
  const profile = store.createMetaAccessProfile({
    name: `${config.displayName} scoped test`,
    appId: config.appId,
    businessId: config.businessId,
    graphApiVersion: config.graphApiVersion,
  });
  const settings = MetaMarketingApiConnectionSettingsSchema.parse({
    kind: "meta-marketing-api",
    profileId: profile.id,
    adAccountId: config.adAccountId,
    pageId: config.pageId,
    liveMode: "manual-status",
    allowedStatusEntityTypes: ["ad"],
  });
  const secret = await vault.read(config.credentialRef);
  if (!secret) throw new Error("Meta 实测 DPAPI 凭据无法解密。");
  const credential = parseStoredCredential(secret);
  await vault.restore(config.credentialRef, JSON.stringify(credential));
  store.setMetaAccessProfileSecretReference(profile.id, config.credentialRef);
  const scope: MetaMarketingApiStatusTestScope = {
    localAccountId: account.id,
    adAccountId: settings.adAccountId,
    entityType: config.target.entityType,
    externalId: config.target.externalId,
    expectedCurrency: config.expectedCurrency,
    expectedTimezone: config.expectedTimezone,
    expiresAt: config.expiresAt,
  };
  const transport = new MetaMarketingApiHttpTransport(config.target.externalId);
  liveTransport = transport;
  const provider = new MetaMarketingApiAdsProvider(transport, scope);
  const registry = new ProviderRegistry([provider]);
  const context: ProviderContext = {
    accountId: account.id,
    settings,
    credential,
    resolvedMetaAccessProfile: {
      profileId: profile.id,
      appId: profile.appId,
      businessId: profile.businessId,
      graphApiVersion: profile.graphApiVersion,
    },
    timezone: config.expectedTimezone,
  };
  liveContext = context;

  store.saveProviderConnectionSettings(account.id, settings);
  const connectionBeforeHealth = store.getProviderConnection(account.id, provider.kind);
  if (!connectionBeforeHealth) throw new Error("Meta 实测连接未落库。");
  const health = await provider.checkHealth(context);
  const authorized = store.completeProviderHealthCheckIfCurrent(
    account.id,
    provider.kind,
    connectionBeforeHealth,
    {
      connectionStatus: health.status,
      message: health.message,
      authorizationStatus: "active",
      capabilityVersion: provider.capabilityVersion,
      capabilities: registry.resolveAuthorizedCapabilities(provider.kind, context),
      expiresAt: config.expiresAt,
    },
  );
  if (!authorized?.authorizedCapabilities.includes("change-status")) {
    throw new Error("Meta 实测连接未获得 change-status 能力。");
  }
  evidence.connection = {
    status: authorized.status,
    authorizationStatus: authorized.authorizationStatus,
    capabilities: authorized.authorizedCapabilities,
    scopeExpiresAt: config.expiresAt,
  };

  const initialSync = await provider.syncReadOnly(context);
  store.saveReadOnlySync(account.id, provider.kind, initialSync.entities, initialSync.result);
  const target = store.listManagedEntities(account.id, provider.kind).find(
    (entity) => entity.entityType === "ad" && entity.externalId === config.target.externalId,
  );
  if (!target || target.status !== "enabled") {
    throw new Error("Meta 实测对象不属于同步快照或初始状态不是 ACTIVE。");
  }
  const baseline = await readScopedRemoteState(transport, context, config);
  assertSafeBaseline(baseline, config);
  evidence.baseline = baseline;
  evidence.restorationRequired = false;

  const service = new AutomationService(store, vault, registry);
  const actor = { id: "meta-live-test", name: "Meta 单对象实测", kind: "user" as const };
  assertScopeRemaining(config.expiresAt, "停用写入");
  const disabled = await executeManualStatusChange(
    service,
    store,
    account.id,
    config.target.externalId,
    "disable",
    actor,
    evidence.writes as unknown[],
  );
  if (!disabled.result.ok || disabled.operation.status !== "succeeded") {
    throw new Error(
      `Meta 停用实测未确认成功（${disabled.operation.status}），已停止后续写入。`,
    );
  }
  evidence.restorationRequired = true;

  const restorePreflight = await readScopedRemoteState(transport, context, config);
  assertSafeRestorePreflight(restorePreflight, config);
  evidence.restorePreflight = restorePreflight;
  assertScopeRemaining(config.expiresAt, "恢复写入");

  const enabled = await executeManualStatusChange(
    service,
    store,
    account.id,
    config.target.externalId,
    "enable",
    actor,
    evidence.writes as unknown[],
  );
  if (!enabled.result.ok || enabled.operation.status !== "succeeded") {
    throw new Error(
      `Meta 恢复原状态写入未明确成功（${enabled.operation.status}），禁止自动重试。`,
    );
  }
  const settleAttempts: unknown[] = [];
  evidence.settleAttempts = settleAttempts;
  const settled = await waitForSafeRestoreSettle(
    transport,
    context,
    config,
    settleAttempts,
  );
  evidence.settleElapsedMs = settled.elapsedMs;
  const finalReadback = settled.state;
  evidence.finalReadback = finalReadback;
  evidence.restorationRequired = false;

  evidence.status = "succeeded";
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    status: "succeeded",
    evidencePath,
    finalStatus: finalReadback.ad.status,
    finalEffectiveStatus: finalReadback.ad.effectiveStatus,
    campaignStatus: finalReadback.campaign.status,
    writeCount: (evidence.writes as unknown[]).length,
  }));
} catch (cause) {
  evidence.status = "failed-or-unknown";
  evidence.finishedAt = new Date().toISOString();
  evidence.message = cause instanceof Error ? cause.message : "Meta 实测失败。";
  if (liveTransport && liveContext) {
    try {
      const reconcile = await readScopedRemoteState(liveTransport, liveContext, config);
      evidence.reconcile = reconcile;
      evidence.restorationRequired = classifyRestorationRequired(reconcile, config);
    } catch (reconcileCause) {
      evidence.reconcileError = reconcileCause instanceof Error
        ? reconcileCause.message
        : "Meta 只读 reconcile 失败。";
      evidence.restorationRequired = "unknown";
    }
  }
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  throw cause;
} finally {
  store.close();
  await proxyAgent?.close().catch(() => undefined);
}

function parseConfig(value: unknown): LiveTestConfig {
  if (!isRecord(value) || !isRecord(value.target)) throw new Error("Meta 实测配置结构无效。");
  const config = value as unknown as LiveTestConfig;
  const numericValues = [
    config.appId,
    config.pageId,
    config.target.externalId,
    config.target.adSetId,
    config.target.campaignId,
  ];
  if (numericValues.some((item) => typeof item !== "string" || !/^\d+$/.test(item))) {
    throw new Error("Meta 实测配置中的资产 ID 必须为数字。");
  }
  if (config.businessId !== null && !/^\d+$/.test(config.businessId)) {
    throw new Error("Meta 实测 Business ID 必须为数字或 null。");
  }
  if (!/^(?:act_)?\d+$/.test(config.adAccountId)) throw new Error("Meta 广告账户 ID 无效。");
  if (config.target.entityType !== "ad") throw new Error("Meta 实测仅允许单个 Ad。");
  if (!/^v\d+\.\d+$/.test(config.graphApiVersion)) throw new Error("Meta Graph API 版本无效。");
  if (!/^[0-9a-f-]{36}$/i.test(config.credentialRef)) throw new Error("Meta 凭据引用无效。");
  if (!config.displayName?.trim()) throw new Error("Meta 测试账户名称缺失。");
  if (config.expectedCurrency !== "USD") throw new Error("Meta 实测币种必须固定为 USD。");
  if (config.expectedTimezone !== "Asia/Shanghai") {
    throw new Error("Meta 实测时区必须固定为 Asia/Shanghai。");
  }
  if (config.expectedCampaignBudgetRemaining !== "0") {
    throw new Error("Meta 实测 Campaign budget_remaining 必须固定为字符串 0。");
  }
  const expiresAt = Date.parse(config.expiresAt);
  const remaining = expiresAt - Date.now();
  if (
    !Number.isFinite(expiresAt)
    || remaining < MIN_SCOPE_REMAINING_MS
    || remaining > MAX_SCOPE_REMAINING_MS
  ) throw new Error("Meta 实测 Scope 必须至少剩余 30 分钟，且在未来两小时内过期。");
  if (
    dateKeyInTimeZone(new Date(), config.expectedTimezone)
    !== dateKeyInTimeZone(new Date(expiresAt), config.expectedTimezone)
  ) throw new Error("Meta 实测 Scope 不得跨越 Asia/Shanghai 自然日。");
  return config;
}

async function executeManualStatusChange(
  service: AutomationService,
  store: AutomationStore,
  accountId: string,
  externalId: string,
  action: "enable" | "disable",
  actor: WriteTaskActor,
  writes: unknown[],
): Promise<{ result: StatusMutationResult; operation: AdOperationRecord }> {
  const existingIds = new Set(store.listAdOperations(accountId).map((item) => item.id));
  let result: StatusMutationResult | null = null;
  let created: AdOperationRecord[] = [];
  try {
    result = await service.changeStatusManually(accountId, {
      entityType: "ad",
      externalId,
      action,
    }, actor);
  } finally {
    created = store.listAdOperations(accountId).filter((item) => !existingIds.has(item.id));
    for (const operation of created) writes.push(safeOperation(operation));
  }
  if (!result || created.length !== 1 || !created[0]) {
    throw new Error("Meta 实测未形成唯一且完整的人工状态操作证据。");
  }
  return { result, operation: created[0] };
}

function assertScopeRemaining(expiresAt: string, stage: string): void {
  if (Date.parse(expiresAt) - Date.now() < MIN_SCOPE_REMAINING_MS) {
    throw new Error(`Meta 实测 Scope 在${stage}前已不足 30 分钟，未发送请求。`);
  }
}

async function readScopedRemoteState(
  transport: MetaMarketingApiHttpTransport,
  context: ProviderContext,
  config: LiveTestConfig,
) {
  if (!("appSecret" in context.credential)) {
    throw new Error("Meta 实测必须使用 App Secret + Access Token 秘密包。");
  }
  const accessToken = context.credential.accessToken;
  const appSecretProof = await createAppSecretProof(
    context.credential.appSecret,
    accessToken,
  );
  const [adRaw, adSetRaw, campaignRaw] = await Promise.all([
    transport.get({
      version: config.graphApiVersion,
      path: config.target.externalId,
      params: { fields: "id,name,status,effective_status,adset_id,campaign_id,updated_time" },
      accessToken,
      appSecretProof,
    }),
    transport.get({
      version: config.graphApiVersion,
      path: config.target.adSetId,
      params: { fields: "id,name,status,effective_status,campaign_id,updated_time" },
      accessToken,
      appSecretProof,
    }),
    transport.get({
      version: config.graphApiVersion,
      path: config.target.campaignId,
      params: {
        fields: "id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,updated_time",
      },
      accessToken,
      appSecretProof,
    }),
  ]);
  const ad = readObjectState(adRaw);
  const adSet = readObjectState(adSetRaw);
  const campaign = readObjectState(campaignRaw);
  return { ad, adSet, campaign };
}

function assertSafeBaseline(
  state: Awaited<ReturnType<typeof readScopedRemoteState>>,
  config: LiveTestConfig,
): void {
  if (
    state.ad.id !== config.target.externalId
    || state.ad.status !== "ACTIVE"
    || state.ad.effectiveStatus !== "CAMPAIGN_PAUSED"
    || state.ad.adSetId !== config.target.adSetId
    || state.ad.campaignId !== config.target.campaignId
    || state.adSet.id !== config.target.adSetId
    || state.adSet.status !== "ACTIVE"
    || state.adSet.effectiveStatus !== "CAMPAIGN_PAUSED"
    || state.adSet.campaignId !== config.target.campaignId
    || state.campaign.id !== config.target.campaignId
    || state.campaign.status !== "PAUSED"
    || state.campaign.effectiveStatus !== "PAUSED"
    || state.campaign.budgetRemaining !== config.expectedCampaignBudgetRemaining
  ) throw new Error("Meta 实测对象或父级基线不满足零投放风险条件。");
}

function assertSafeRestorePreflight(
  state: Awaited<ReturnType<typeof readScopedRemoteState>>,
  config: LiveTestConfig,
): void {
  if (
    state.ad.id !== config.target.externalId
    || state.ad.status !== "PAUSED"
    || state.ad.adSetId !== config.target.adSetId
    || state.ad.campaignId !== config.target.campaignId
    || !hasSafePausedParents(state, config)
  ) throw new Error("Meta 恢复前对象或父级状态发生变化，已停止恢复写入。");
}

async function waitForSafeRestoreSettle(
  transport: MetaMarketingApiHttpTransport,
  context: ProviderContext,
  config: LiveTestConfig,
  attempts: unknown[],
): Promise<{
  state: Awaited<ReturnType<typeof readScopedRemoteState>>;
  elapsedMs: number;
}> {
  const startedAt = Date.now();
  let attempt = 0;
  while (true) {
    attempt += 1;
    const state = await readScopedRemoteState(transport, context, config);
    const elapsedMs = Date.now() - startedAt;
    attempts.push(safeSettleAttempt(attempt, elapsedMs, state));
    if (elapsedMs > RESTORE_SETTLE_TIMEOUT_MS) {
      throw new Error("Meta 恢复只读 settle 超过 60 秒，已停止且禁止自动重试。");
    }
    if (classifyRestorationRequired(state, config) === false) {
      return { state, elapsedMs };
    }
    if (!isSafeRestoreInProcess(state, config)) {
      throw new Error("Meta 恢复只读 settle 出现非预期状态、父级或预算变化，立即失败关闭。");
    }
    const remainingMs = RESTORE_SETTLE_TIMEOUT_MS - elapsedMs;
    if (remainingMs <= RESTORE_SETTLE_INTERVAL_MS) {
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, remainingMs));
      throw new Error("Meta 恢复只读 settle 在 60 秒内未完成，已停止且禁止自动重试。");
    }
    await new Promise<void>((resolveWait) =>
      setTimeout(resolveWait, RESTORE_SETTLE_INTERVAL_MS));
  }
}

function isSafeRestoreInProcess(
  state: Awaited<ReturnType<typeof readScopedRemoteState>>,
  config: LiveTestConfig,
): boolean {
  return state.ad.id === config.target.externalId
    && state.ad.status === "ACTIVE"
    && state.ad.effectiveStatus === "IN_PROCESS"
    && state.ad.adSetId === config.target.adSetId
    && state.ad.campaignId === config.target.campaignId
    && hasSafePausedParents(state, config);
}

function safeSettleAttempt(
  attempt: number,
  elapsedMs: number,
  state: Awaited<ReturnType<typeof readScopedRemoteState>>,
) {
  return {
    attempt,
    elapsedMs,
    ad: {
      id: state.ad.id,
      status: state.ad.status,
      effectiveStatus: state.ad.effectiveStatus,
      adSetId: state.ad.adSetId,
      campaignId: state.ad.campaignId,
    },
    adSet: {
      id: state.adSet.id,
      status: state.adSet.status,
      effectiveStatus: state.adSet.effectiveStatus,
      campaignId: state.adSet.campaignId,
    },
    campaign: {
      id: state.campaign.id,
      status: state.campaign.status,
      effectiveStatus: state.campaign.effectiveStatus,
      budgetRemaining: state.campaign.budgetRemaining,
    },
  };
}

function classifyRestorationRequired(
  state: Awaited<ReturnType<typeof readScopedRemoteState>>,
  config: LiveTestConfig,
): true | false | "unknown" {
  if (
    state.ad.id !== config.target.externalId
    || state.ad.adSetId !== config.target.adSetId
    || state.ad.campaignId !== config.target.campaignId
    || !hasSafePausedParents(state, config)
  ) return "unknown";
  if (state.ad.status === "PAUSED") return true;
  if (state.ad.status === "ACTIVE" && state.ad.effectiveStatus === "CAMPAIGN_PAUSED") {
    return false;
  }
  return "unknown";
}

function hasSafePausedParents(
  state: Awaited<ReturnType<typeof readScopedRemoteState>>,
  config: LiveTestConfig,
): boolean {
  return state.adSet.id === config.target.adSetId
    && state.adSet.status === "ACTIVE"
    && state.adSet.effectiveStatus === "CAMPAIGN_PAUSED"
    && state.adSet.campaignId === config.target.campaignId
    && state.campaign.id === config.target.campaignId
    && state.campaign.status === "PAUSED"
    && state.campaign.effectiveStatus === "PAUSED"
    && state.campaign.budgetRemaining === config.expectedCampaignBudgetRemaining;
}

function readObjectState(value: unknown) {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("Meta 实测只读对象响应无效。");
  }
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : null,
    status: typeof value.status === "string" ? value.status : null,
    effectiveStatus: typeof value.effective_status === "string" ? value.effective_status : null,
    adSetId: typeof value.adset_id === "string" ? value.adset_id : null,
    campaignId: typeof value.campaign_id === "string" ? value.campaign_id : null,
    dailyBudget: typeof value.daily_budget === "string" ? value.daily_budget : null,
    lifetimeBudget: typeof value.lifetime_budget === "string" ? value.lifetime_budget : null,
    budgetRemaining: typeof value.budget_remaining === "string" ? value.budget_remaining : null,
    updatedTime: typeof value.updated_time === "string" ? value.updated_time : null,
  };
}

function dateKeyInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseStoredCredential(secret: string) {
  const trimmed = secret.trim();
  if (!trimmed.startsWith("{")) {
    throw new Error("旧单 Token 凭据已停用；请保存 App Secret + Access Token 秘密包。");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    throw new Error("Meta 实测 DPAPI Credential envelope 无法解析。");
  }
  return MetaAccessSecretBundleInputSchema.parse(decoded);
}

async function createAppSecretProof(
  appSecret: string,
  accessToken: string,
): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(accessToken),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeOperation(operation: AdOperationRecord) {
  return {
    taskId: operation.id,
    operationId: operation.operationId,
    action: operation.action,
    status: operation.status,
    message: operation.message,
    createdAt: operation.createdAt,
    completedAt: operation.completedAt,
  };
}

function normalizeAdAccountId(value: string): string {
  return value.startsWith("act_") ? value : `act_${value}`;
}

function assertCanonicalNonReparsePath(value: string, label: string): string {
  const resolvedPath = resolve(value);
  if (!existsSync(resolvedPath)) throw new Error(`${label}不存在。`);
  if (lstatSync(resolvedPath).isSymbolicLink()) {
    throw new Error(`${label}不能是符号链接、Junction 或其他重解析入口。`);
  }
  const realPath = realpathSync.native(resolvedPath);
  if (!sameWindowsPath(resolvedPath, realPath)) {
    throw new Error(`${label}真实路径与配置路径不一致，拒绝重解析逃逸。`);
  }
  return realPath;
}

function sameWindowsPath(left: string, right: string): boolean {
  const normalize = (value: string) => resolve(value)
    .replace(/[\\/]+$/, "")
    .toLocaleLowerCase("en-US");
  return normalize(left) === normalize(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
