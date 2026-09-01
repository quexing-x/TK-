import Fastify, {
  type FastifyInstance,
  type FastifyReply,
} from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import {
  AccountSettingsUpdateSchema,
  AccountCreateInputSchema,
  GlobalAutomationSettingsInputSchema,
  CookieCredentialInputSchema,
  ProviderConnectionSettingsSchema,
  ProviderCredentialInputSchema,
  ProviderKindSchema,
  providerBelongsToPlatform,
  RuleConfigurationInputSchema,
  SyncEntityTypeSchema,
  IgnoreEntityInputSchema,
  ManualStatusInputSchema,
  NotificationChannelKindSchema,
  NotificationChannelSettingsSchema,
  NotificationCredentialInputSchema,
  InitialDeveloperInputSchema,
  MetaAutomationRuntimeInputSchema,
  MetaRuleConfigurationInputSchema,
  LocalUserCreateInputSchema,
  LocalUserUpdateInputSchema,
  LoginInputSchema,
  MetaAccessProfileInputSchema,
  MetaAccessSecretBundleInputSchema,
  MetaAdCreationInputSchema,
  PasswordChangeInputSchema,
  SystemRuntimeUpdateSchema,
  OneTimeScheduleInputSchema,
  OvernightScheduleInputSchema,
  AutomationFeatureSettingsInputSchema,
  MultiAccountLaunchPlanInputSchema,
  stripRetiredAgeRanges,
  LaunchCopyPreviewInputSchema,
  LaunchPresetInputSchema,
  getCreationTemplateReadiness,
  StatusManualVerificationInputSchema,
  WriteTaskStatusSchema,
  AuditLogFilterSchema,
  DEFAULT_EXPAND_THRESHOLDS,
  METRIC_RETENTION_DAYS,
  classifyCampaignsForExpand,
  type AppPermission,
  type ProviderKind,
  type WriteTaskActor,
} from "@tk-auto/core";
import type { CredentialVault } from "@tk-auto/credentials";
import {
  withCauseDetail,
  parseTikTokCurl,
  parseTikTokReadCurl,
  parseTikTokStatusCurl,
  getTikTokCookieImportReadiness,
  MetaMarketingApiHttpTransport,
  ProviderRegistry,
  TikTokCurlImportError,
  type ProviderContext,
} from "@tk-auto/providers";
import {
  AutomationStore,
  MetaCreationIdempotencyConflictError,
  PlatformConfigurationConflictError,
} from "@tk-auto/storage";
import {
  AutomationBusyError,
  AutomationScheduler,
  AutomationService,
} from "./automation-service.js";
import { NotificationService } from "./notification-service.js";
import { LaunchService } from "./launch-service.js";
import { LaunchWorker } from "./launch-worker.js";
import { MetaCreationService } from "./meta-creation-service.js";
import {
  AuthenticationError,
  AuthorizationError,
  AuthService,
  LoginRateLimitError,
  authCookie,
  type AuthenticatedSession,
} from "./auth-service.js";
import {
  unavailableMaintenanceUpdateRuntime,
  type MaintenanceUpdateRuntime,
} from "./maintenance-runtime.js";

export { AuthService };
export type { MaintenanceUpdateRuntime } from "./maintenance-runtime.js";

declare module "fastify" {
  interface FastifyRequest {
    authSession: AuthenticatedSession | null;
  }
}

const AccountParamsSchema = z.object({ accountId: z.string().min(1) });
const ProviderParamsSchema = AccountParamsSchema.extend({
  providerKind: ProviderKindSchema,
});
const MetaAccessProfileParamsSchema = z.object({ profileId: z.string().uuid() });
const MetaCreationTaskParamsSchema = AccountParamsSchema.extend({
  taskId: z.string().uuid(),
});
const MetaRuleConfigurationUpdateRequestSchema = MetaRuleConfigurationInputSchema.and(
  z.object({ expectedUpdatedAt: z.string().datetime() }),
);
const MetaAutomationRuntimeUpdateRequestSchema = MetaAutomationRuntimeInputSchema.extend({
  expectedUpdatedAt: z.string().datetime(),
});
const CurlImportBodySchema = z.object({
  command: z.string().min(1).max(262_144),
  step: z.enum(["read", "status", "appeal"]).optional(),
});
const EntityParamsSchema = AccountParamsSchema.extend({
  entityType: SyncEntityTypeSchema,
  externalId: z.string().min(1).max(128),
});
const OperationParamsSchema = AccountParamsSchema.extend({
  operationId: z.string().min(1),
});
const AnalyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  entityType: SyncEntityTypeSchema.optional(),
}).superRefine((value, context) => {
  if (value.from && value.to && new Date(value.from) > new Date(value.to)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "开始日期不能晚于结束日期。",
      path: ["from"],
    });
  }
});
const NotificationParamsSchema = z.object({
  channelKind: NotificationChannelKindSchema,
});
const LocalAccessResetSchema = z.object({
  confirmation: z.literal("RESET"),
});
const AuthCookieNameSchema = z.string()
  .min(1)
  .max(128)
  .regex(
    /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/,
    "鉴权 Cookie 名称包含不安全字符。",
  );

export interface AppDependencies {
  store: AutomationStore;
  vault: CredentialVault;
  providers?: ProviderRegistry;
  automation?: AutomationService;
  notifications?: NotificationService;
  startScheduler?: boolean;
  /** Disable the durable launch worker only for isolated test environments. */
  startLaunchWorker?: boolean;
  /** Only for isolated unit tests. Production authentication is always enabled. */
  disableAuth?: boolean;
  /** Enable only when the application is reached through HTTPS. */
  secureCookies?: boolean;
  appVersion?: string;
  packaged?: boolean;
  maintenanceUpdates?: MaintenanceUpdateRuntime;
  /** Desktop-only lifecycle bridge for the separately hosted scheduler. */
  onSystemRuntimeChanged?: (enabled: boolean) => void | Promise<void>;
  /** Desktop client override. Web/server deployments keep the 12-hour default. */
  authSessionLifetimeMs?: number;
  /** Desktop client cookie override paired with authSessionLifetimeMs. */
  authCookieMaxAgeSeconds?: number;
  /** Isolated deployments may use a distinct cookie namespace. */
  authCookieName?: string;
  /** Disable the destructive local-access recovery endpoint in isolated deployments. */
  allowAuthRecovery?: boolean;
}

export async function createApp(
  dependencies: AppDependencies,
): Promise<FastifyInstance> {
  const sessionCookieName = AuthCookieNameSchema.parse(
    dependencies.authCookieName ?? authCookie.name,
  );
  const app = Fastify({ logger: true });
  const providers = dependencies.providers ?? new ProviderRegistry(undefined, {
    metaMarketingApiTransportFactory: ({ allowedMutationExternalIds, allowedCreationPaths }) =>
      new MetaMarketingApiHttpTransport({
        allowedMutationExternalIds,
        allowedCreationPaths: allowedCreationPaths ?? [],
      }),
  });
  const launchService = new LaunchService(
    dependencies.store,
    dependencies.vault,
    providers,
  );
  const launchWorker = dependencies.startLaunchWorker === false
    ? null
    : new LaunchWorker(dependencies.store, launchService);
  launchWorker?.start();
  const automation =
    dependencies.automation ??
    new AutomationService(
      dependencies.store,
      dependencies.vault,
      providers,
      (input) => launchService.copyAdGroupWithinAccount(input),
    );
  const notifications =
    dependencies.notifications ??
    new NotificationService(dependencies.store, dependencies.vault);
  const auth = new AuthService(
    dependencies.store,
    dependencies.authSessionLifetimeMs,
  );
  const sessionCookieMaxAgeSeconds = dependencies.authCookieMaxAgeSeconds
    ?? authCookie.maxAgeSeconds;
  const maintenanceUpdates = dependencies.maintenanceUpdates
    ?? unavailableMaintenanceUpdateRuntime(dependencies.appVersion);
  const scheduler = new AutomationScheduler(
    dependencies.store,
    automation,
    notifications,
  );
  if (dependencies.startScheduler) scheduler.start();
  app.addHook("onClose", async () => {
    await launchWorker?.stop();
    scheduler.stop();
  });
  app.decorateRequest("authSession", null);

  await app.register(cors, {
    origin: [/^http:\/\/127\.0\.0\.1(?::\d+)?$/],
    credentials: true,
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply
      .header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
      .header("x-content-type-options", "nosniff")
      .header("x-frame-options", "DENY")
      .header("referrer-policy", "no-referrer")
      .header("permissions-policy", "camera=(), microphone=(), geolocation=()")
      .header("cache-control", "no-store");
    return payload;
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const token = readCookie(request.headers.cookie, sessionCookieName);
    request.authSession = auth.authenticate(token);
    const requestedCorrelationId = request.headers["x-correlation-id"];
    const correlationId = typeof requestedCorrelationId === "string"
      && /^[A-Za-z0-9_.:-]{1,128}$/.test(requestedCorrelationId)
      ? requestedCorrelationId
      : request.id;
    dependencies.store.enterAuditContext({
      actor: request.authSession
        ? {
          id: request.authSession.user.id,
          name: request.authSession.user.displayName,
          kind: "user",
        }
        : { id: "system", name: "系统", kind: "system" },
      requestId: request.id,
      correlationId,
    });
    reply.header("x-correlation-id", correlationId);
    if (dependencies.disableAuth || isPublicApi(request.method, request.url)) {
      return;
    }
    if (!request.authSession) {
      return reply.status(401).send({
        error: "AUTHENTICATION_REQUIRED",
        message: "请先登录本地管理账户。",
      });
    }
    if (isMutation(request.method)) {
      const csrf = request.headers["x-csrf-token"];
      if (
        typeof csrf !== "string" ||
        csrf !== request.authSession.csrfToken
      ) {
        return reply.status(403).send({
          error: "CSRF_INVALID",
          message: "安全校验失败，请刷新页面后重试。",
        });
      }
    }
    const permission = requiredPermission(request.method, request.url);
    if (
      permission &&
      !request.authSession.permissions.includes(permission)
    ) {
      return reply.status(403).send({
        error: "PERMISSION_DENIED",
        message: "当前账户没有执行此操作的权限。",
      });
    }
    const runtimePauseMessage = getRuntimePauseMessage(
      dependencies.store,
      request.method,
      request.url,
    );
    if (runtimePauseMessage) {
      return reply.status(423).send({
        error: "SYSTEM_PAUSED",
        message: runtimePauseMessage,
      });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      void reply.status(400).send({
        error: "VALIDATION_ERROR",
        message: "请求数据不符合配置规则。",
        details: error.flatten(),
      });
      return;
    }

    if (error instanceof AutomationBusyError) {
      void reply.status(409).send({
        error: "AUTOMATION_BUSY",
        message: error.message,
      });
      return;
    }

    if (error instanceof LoginRateLimitError) {
      void reply.status(429).send({
        error: "LOGIN_RATE_LIMITED",
        message: error.message,
      });
      return;
    }

    if (error instanceof AuthenticationError) {
      void reply.status(401).send({
        error: "AUTHENTICATION_FAILED",
        message: error.message,
      });
      return;
    }

    if (error instanceof AuthorizationError) {
      void reply.status(403).send({
        error: "PERMISSION_DENIED",
        message: error.message,
      });
      return;
    }

    if (error instanceof Error && error.message.includes("UNIQUE constraint")) {
      void reply.status(409).send({
        error: "CONFLICT",
        message: "同一账号下的配置代码不能重复。",
      });
      return;
    }

    app.log.error(error);
    void reply.status(500).send({
      error: "INTERNAL_ERROR",
      message: "本地服务处理失败。",
    });
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "tk-auto-local-api",
  }));

  app.get("/api/auth/status", async (request) =>
    auth.status(request.authSession),
  );

  app.post("/api/auth/setup", async (request, reply) => {
    const session = await auth.setupInitialDeveloper(
      InitialDeveloperInputSchema.parse(request.body),
    );
    setSessionCookie(reply, sessionCookieName, session.token, dependencies.secureCookies ?? false, sessionCookieMaxAgeSeconds);
    return reply.status(201).send(auth.status(session));
  });

  app.post("/api/auth/login", async (request, reply) => {
    const session = await auth.login(LoginInputSchema.parse(request.body), request.ip);
    setSessionCookie(reply, sessionCookieName, session.token, dependencies.secureCookies ?? false, sessionCookieMaxAgeSeconds);
    return auth.status(session);
  });

  app.post("/api/auth/recover", async (request, reply) => {
    if (dependencies.allowAuthRecovery === false) {
      return reply.status(404).send({
        error: "NOT_FOUND",
        message: "资源不存在。",
      });
    }
    LocalAccessResetSchema.parse(request.body);
    auth.resetLocalAccess();
    clearSessionCookie(reply, sessionCookieName, dependencies.secureCookies ?? false);
    return auth.status(null);
  });

  app.post("/api/auth/logout", async (request, reply) => {
    auth.logout(request.authSession);
    clearSessionCookie(reply, sessionCookieName, dependencies.secureCookies ?? false);
    return { ok: true };
  });

  app.put("/api/auth/password", async (request, reply) => {
    if (!request.authSession) return reply.status(401).send();
    await auth.changePassword(
      request.authSession.user,
      PasswordChangeInputSchema.parse(request.body),
    );
    clearSessionCookie(reply, sessionCookieName, dependencies.secureCookies ?? false);
    return { ok: true, reauthenticationRequired: true };
  });

  app.get("/api/local-users", async () => dependencies.store.listLocalUsers());

  app.post("/api/local-users", async (request, reply) => {
    if (!request.authSession) return reply.status(401).send();
    const created = await auth.createUser(
      request.authSession.user,
      LocalUserCreateInputSchema.parse(request.body),
    );
    return reply.status(201).send(created);
  });

  app.put("/api/local-users/:userId", async (request, reply) => {
    if (!request.authSession) return reply.status(401).send();
    const { userId } = z.object({ userId: z.string().min(1) }).parse(request.params);
    return auth.updateUser(
      request.authSession.user,
      userId,
      LocalUserUpdateInputSchema.parse(request.body),
    );
  });

  app.get("/api/bootstrap", async () => {
    const accounts = dependencies.store.listAccounts();
    return {
      accounts,
      // This is persisted local state only. It lets the account list render
      // immediately; the scheduler remains the sole background health checker.
      accountConnectionStates: accounts.map((account) => ({
        accountId: account.id,
        connection: dependencies.store.getProviderConnection(
          account.id,
          account.providerKind,
        ),
        latestSync: dependencies.store.getLatestReadOnlySync(
          account.id,
          account.providerKind,
        ),
        capabilities: providers.describeAccount(
          account.id,
          account.providerKind,
          dependencies.store.getProviderConnection(account.id, account.providerKind),
        ),
      })),
      globalAutomationSettings:
        dependencies.store.getGlobalAutomationSettings(),
      systemRuntime: dependencies.store.getSystemRuntimeState(),
      providers: providers.list(),
    };
  });

  app.get("/api/system/runtime", async () =>
    dependencies.store.getSystemRuntimeState(),
  );

  app.put("/api/system/runtime", async (request) => {
    const state = dependencies.store.updateSystemRuntimeState(
      SystemRuntimeUpdateSchema.parse(request.body),
    );
    await dependencies.onSystemRuntimeChanged?.(state.enabled);
    return state;
  });

  app.get("/api/automation/features", async () =>
    dependencies.store.getAutomationFeatureSettings(),
  );

  app.put("/api/automation/features", async (request) =>
    dependencies.store.updateAutomationFeatureSettings(
      AutomationFeatureSettingsInputSchema.parse(request.body),
    ),
  );

  app.post("/api/automation/features/apply-all", async (request) =>
    dependencies.store.applyAutomationFeatureSettingsToAllAccounts(
      AutomationFeatureSettingsInputSchema.parse(request.body),
    ),
  );

  app.get("/api/launch-plans", async () =>
    dependencies.store.listMultiAccountLaunchPlans(),
  );

  app.get("/api/launch-plans/queued", async () =>
    dependencies.store.listQueuedLaunchPlans().map((queued) => queued.planId),
  );

  app.get("/api/write-tasks", async (request) => {
    const query = z.object({
      kind: z.enum(["launch", "status"]).optional(),
      status: WriteTaskStatusSchema.optional(),
      accountId: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(1_000).optional(),
    }).parse(request.query);
    return dependencies.store.listWriteTaskSummaries({
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });
  });

  app.get("/api/maintenance/status", async () => ({
    appVersion: dependencies.appVersion ?? "development",
    schemaVersion: dependencies.store.getSchemaVersion(),
    packaged: dependencies.packaged ?? false,
    pendingRestore: dependencies.store.hasPendingDatabaseRestore(),
    update: await maintenanceUpdates.getStatus(),
  }));

  app.get("/api/maintenance/audit", async (request) =>
    dependencies.store.listAuditLogs(AuditLogFilterSchema.parse(request.query)),
  );

  app.get("/api/maintenance/backups", async () =>
    dependencies.store.listDatabaseBackups(),
  );

  app.post("/api/maintenance/backups", async (_request, reply) =>
    reply.status(201).send(dependencies.store.createDatabaseBackup("manual")),
  );

  app.post("/api/maintenance/backups/:backupId/verify", async (request) => {
    const { backupId } = z.object({ backupId: z.string().min(1) }).parse(request.params);
    return dependencies.store.verifyDatabaseBackup(backupId);
  });

  app.post("/api/maintenance/backups/:backupId/restore", async (request) => {
    const { backupId } = z.object({ backupId: z.string().min(1) }).parse(request.params);
    return {
      backup: dependencies.store.requestDatabaseRestore(backupId),
      restartRequired: true,
      message: "恢复请求已安全保存；重启软件后应用，并在失败时自动回滚当前数据库。",
    };
  });

  app.post("/api/maintenance/updates/check", async () =>
    maintenanceUpdates.checkForUpdates(),
  );

  app.post("/api/maintenance/updates/download", async () =>
    maintenanceUpdates.downloadUpdate(),
  );

  app.post("/api/maintenance/updates/install", async () => {
    const backup = dependencies.store.createDatabaseBackup("pre-upgrade");
    if (backup.status !== "verified") {
      throw new Error("升级前备份未通过校验，已阻止安装更新。");
    }
    return maintenanceUpdates.installUpdate();
  });

  app.get("/api/write-tasks/:kind/:taskId/attempts", async (request, reply) => {
    const { kind, taskId } = z.object({
      kind: z.enum(["launch", "status"]),
      taskId: z.string().min(1),
    }).parse(request.params);
    try {
      if (kind === "launch") {
        dependencies.store.getLaunchPlanItem(taskId);
        return dependencies.store.listLaunchPlanItemAttempts(taskId);
      }
      const task = dependencies.store.getAdOperation(taskId);
      return dependencies.store.listAdOperationAttempts(task.operationId);
    } catch (cause) {
      return reply.status(404).send({ message: getSafeProviderError(cause) });
    }
  });

  app.get("/api/write-tasks/status/:taskId/verifications", async (request, reply) => {
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    try {
      dependencies.store.getAdOperation(taskId);
      return dependencies.store.listStatusWriteTaskVerifications(taskId);
    } catch (cause) {
      return reply.status(404).send({ message: getSafeProviderError(cause) });
    }
  });

  app.get("/api/launch-plans/:planId/items", async (request, reply) => {
    const { planId } = z.object({ planId: z.string().min(1) }).parse(request.params);
    if (!dependencies.store.getMultiAccountLaunchPlan(planId)) {
      return reply.status(404).send({ message: "投放计划不存在。" });
    }
    return dependencies.store.listLaunchPlanItems(planId);
  });

  app.get("/api/launch-plans/:planId/items/:itemId/attempts", async (request, reply) => {
    const { planId, itemId } = z.object({
      planId: z.string().min(1),
      itemId: z.string().min(1),
    }).parse(request.params);
    const item = dependencies.store.listLaunchPlanItems(planId).find((candidate) => candidate.itemId === itemId);
    if (!item) return reply.status(404).send({ message: "创建任务不存在。" });
    return dependencies.store.listLaunchPlanItemAttempts(itemId);
  });

  app.get("/api/launch-presets", async () =>
    dependencies.store.listLaunchPresets(),
  );

  app.post("/api/launch-presets", async (request, reply) =>
    reply.status(201).send(
      dependencies.store.createLaunchPreset(LaunchPresetInputSchema.parse(request.body)),
    ),
  );

  app.put("/api/launch-presets/:presetId", async (request) => {
    const { presetId } = z.object({ presetId: z.string().min(1) }).parse(request.params);
    return dependencies.store.updateLaunchPreset(
      presetId,
      LaunchPresetInputSchema.parse(request.body),
    );
  });

  app.delete("/api/launch-presets/:presetId", async (request, reply) => {
    const { presetId } = z.object({ presetId: z.string().min(1) }).parse(request.params);
    if (!dependencies.store.deleteLaunchPreset(presetId)) {
      return reply.status(404).send({ message: "广告预设不存在。" });
    }
    return reply.status(204).send();
  });

  app.post("/api/launch-plans", async (request, reply) => {
    try {
      // 存量行可能带已下线的年龄档（页面里更新前导入的表、旧计划）：先剥掉再校验，
      // 否则整条被拒，且报错挂在 launchRows 顶层键上、指不到年龄字段。
      const rawBody = request.body as { launchRows?: unknown } | null;
      const body = rawBody && Array.isArray(rawBody.launchRows)
        ? { ...rawBody, launchRows: stripRetiredAgeRanges(rawBody.launchRows as Array<{ ageRanges?: unknown }>) }
        : request.body;
      const input = MultiAccountLaunchPlanInputSchema.parse(body);
      if (hasMetaOfflineAccount(dependencies.store, [
        input.sourceAccountId,
        ...input.targetAccountIds,
      ])) {
        return reply.status(409).send(metaOfflineMessage());
      }
      const user = request.authSession?.user;
      return reply.status(201).send(
        dependencies.store.createMultiAccountLaunchPlan(
          input,
          user
            ? { id: user.id, name: user.username, kind: "user" }
            : { id: "local-user", name: "本地用户", kind: "user" },
        ),
      );
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  app.post("/api/launch-plans/copy-preview", async (request, reply) => {
    try {
      const input = LaunchCopyPreviewInputSchema.parse(request.body);
      if (hasMetaOfflineAccount(dependencies.store, [
        input.sourceAccountId,
        ...input.targetAccountIds,
      ])) {
        return reply.status(409).send(metaOfflineMessage());
      }
      return reply.status(201).send(
        await launchService.createCopyPreview(input),
      );
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  app.post("/api/accounts/:accountId/ad-groups/copy-same-account", async (request, reply) => {
    const { accountId } = z.object({ accountId: z.string().min(1) }).parse(request.params);
    const input = z.object({
      sourceCampaignId: z.string().min(1),
      sourceCampaignName: z.string().min(1),
      sourceAdGroupId: z.string().min(1).optional(),
      baseAdGroupName: z.string().min(1),
      count: z.number().int().min(1).max(10),
      dailyBudget: z.number().positive(),
      bid: z.number().nonnegative().nullable(),
      launchImmediately: z.boolean(),
      sameCampaign: z.boolean().optional(),
    }).parse(request.body);
    if (hasMetaOfflineAccount(dependencies.store, [accountId])) {
      return reply.status(409).send(metaOfflineMessage());
    }
    try {
      const results = await launchService.copyAdGroupWithinAccount({ accountId, ...input });
      return reply.send({ results });
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  app.post("/api/campaigns/copy", async (request, reply) => {
    const input = z.object({
      accountId: z.string().min(1),
      sources: z.array(z.object({
        sourceCampaignId: z.string().min(1),
        sourceAdGroupIds: z.array(z.string().min(1)).min(1).max(50),
      })).min(1).max(20),
      campaignCopies: z.number().int().min(1).max(20),
      groupsPerCampaign: z.number().int().min(1).max(20),
      initialStatus: z.enum(["enabled", "disabled"]).default("disabled"),
      scheduledStartAt: z.string().datetime().nullable().default(null),
      createNewPosts: z.boolean().default(true),
      campaignBudget: z.number().positive().nullable().default(null),
      adGroupBudget: z.number().positive().nullable().default(null),
      bid: z.number().nonnegative().nullable().default(null),
    }).parse(request.body);
    if (hasMetaOfflineAccount(dependencies.store, [input.accountId])) {
      return reply.status(409).send(metaOfflineMessage());
    }
    try {
      return reply.send(await launchService.copyCampaign(input));
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  // 卡在「结果未知」的系列复制任务：先列出来供人工去 TikTok 后台核实，
  // 核实后再单独调重置。绝不在这里代为清理 TikTok 侧的草稿或系列——
  // 那必须由人工确认后自行处理。
  app.get("/api/accounts/:accountId/campaign-copy-tasks", async (request) => {
    const { accountId } = z.object({ accountId: z.string().min(1) }).parse(request.params);
    return dependencies.store.listStuckCampaignCopyTasks(accountId);
  });

  // 人工核实后一次清掉这些账户下所有「结果未知」的扩组记录。这类记录禁止自动重试，
  // 只能靠人收口；没有这个入口，界面顶部的红色横幅只进不出，最后没人再看它。
  app.post("/api/ad-group-expand-tasks/resolve-uncertain", async (request, reply) => {
    const { accountIds } = z.object({
      accountIds: z.array(z.string().min(1)).min(1).max(200),
    }).parse(request.body);
    if (hasMetaOfflineAccount(dependencies.store, accountIds)) {
      return reply.status(409).send(metaOfflineMessage());
    }
    return reply.send({
      cleared: dependencies.store.resolveUncertainAdGroupExpandTasks(accountIds),
    });
  });

  // 发布这条记录留在 TikTok 后台的草稿。清除只是把红条摘掉、草稿仍烂在后台；这个入口才是
  // 真正的收口。创建类写入，成功才把记录落成 succeeded。
  app.post("/api/ad-group-expand-tasks/:taskKey/publish-draft", async (request, reply) => {
    const { taskKey } = z.object({ taskKey: z.string().min(1) }).parse(request.params);
    const task = dependencies.store.getUncertainAdGroupExpandTask(taskKey);
    if (!task) {
      return reply.status(404).send({ message: "该扩组记录不存在，或已不处于「结果未知」状态。" });
    }
    if (hasMetaOfflineAccount(dependencies.store, [task.accountId])) {
      return reply.status(409).send(metaOfflineMessage());
    }
    try {
      return reply.send(await launchService.publishStuckExpandDraft(taskKey));
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  // 遗留草稿：后台躺着、超过保护期没人动过的草稿广告组。保护期之内的和还挂着「结果未知」
  // 的一律不列——前者可能是正在跑的扩组或人工正在编辑，后者等人决定发布还是放弃。
  app.get("/api/accounts/:accountId/draft-candidates", async (request, reply) => {
    const { accountId } = z.object({ accountId: z.string().min(1) }).parse(request.params);
    if (hasMetaOfflineAccount(dependencies.store, [accountId])) {
      return reply.status(409).send(metaOfflineMessage());
    }
    try {
      return reply.send(await launchService.listStaleDraftAdGroups(accountId));
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  // 一键清理。候选在服务端重新算一遍，不接受调用方传 ID——界面上看到列表到点下删除之间
  // 可能过了很久，期间轮询会建新草稿，拿旧 ID 去删删掉的就是正在用的那个。
  app.post("/api/accounts/:accountId/draft-candidates/delete", async (request, reply) => {
    const { accountId } = z.object({ accountId: z.string().min(1) }).parse(request.params);
    if (hasMetaOfflineAccount(dependencies.store, [accountId])) {
      return reply.status(409).send(metaOfflineMessage());
    }
    try {
      return reply.send(await launchService.deleteStaleDraftAdGroups(accountId));
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  app.post("/api/accounts/:accountId/campaign-copy-tasks/:taskKey/reset", async (request, reply) => {
    const { accountId, taskKey } = z.object({
      accountId: z.string().min(1),
      taskKey: z.string().min(1),
    }).parse(request.params);
    if (hasMetaOfflineAccount(dependencies.store, [accountId])) {
      return reply.status(409).send(metaOfflineMessage());
    }
    const reset = dependencies.store.resetCampaignCopyTask(accountId, taskKey);
    if (!reset) {
      return reply.status(404).send({ message: "该系列复制任务不存在，或已不处于结果未知状态。" });
    }
    return reply.send({ ok: true });
  });

  // 待清理列表：按当前删除配置，这一刻够格被删的广告组。与定时执行器共用
  // selectDeletionCandidates，因此列表里看到的就是执行时会删的那一批。
  app.get("/api/accounts/:accountId/cleanup-candidates", async (request, reply) => {
    const { accountId } = z.object({ accountId: z.string().min(1) }).parse(request.params);
    if (hasMetaOfflineAccount(dependencies.store, [accountId])) {
      return reply.status(409).send(metaOfflineMessage());
    }
    const candidates = automation.listCleanupCandidates(accountId);
    return reply.send({
      settings: dependencies.store.getAutomationFeatureSettings().deletion,
      candidates: candidates.map((entity) => ({
        externalId: entity.externalId,
        name: entity.name,
        parentCampaignId: entity.parentCampaignId,
        conversions: entity.metrics.conversions,
        carts: entity.metrics.carts,
        spend: entity.metrics.spend,
        cpa: entity.metrics.cost_per_conversion,
      })),
    });
  });

  // 一键删除：立刻删掉上面那批。删除不可恢复，闸门与定时执行器完全一致，只是不看
  // 计划小时、不占当日的日任务名额。
  app.post("/api/accounts/:accountId/cleanup-candidates/delete", async (request, reply) => {
    const { accountId } = z.object({ accountId: z.string().min(1) }).parse(request.params);
    if (hasMetaOfflineAccount(dependencies.store, [accountId])) {
      return reply.status(409).send(metaOfflineMessage());
    }
    try {
      return reply.send(await automation.deleteCleanupCandidatesNow(accountId));
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  // 只读预检：发请求前告诉用户这批源组「有没有在跑的、今天扩过没有」，由用户决定
  // 是否继续。不写任何东西，也不拦截提交。
  app.post("/api/ad-groups/batch-expand/preflight", async (request, reply) => {
    const input = z.object({
      sources: z.array(z.object({
        accountId: z.string().min(1),
        sourceCampaignId: z.string().min(1),
        sourceCampaignName: z.string().min(1),
        sourceAdGroupId: z.string().min(1),
        sourceAdGroupName: z.string().min(1),
      })).min(1).max(200),
      scheduledStartAt: z.string().datetime().nullable().default(null),
    }).parse(request.body);
    return reply.send(launchService.previewBatchExpandConflicts(input));
  });

  app.post("/api/ad-groups/batch-expand", async (request, reply) => {
    const input = z.object({
      sources: z.array(z.object({
        accountId: z.string().min(1),
        sourceCampaignId: z.string().min(1),
        sourceCampaignName: z.string().min(1),
        sourceAdGroupId: z.string().min(1),
        sourceAdGroupName: z.string().min(1),
      })).min(1).max(200),
      count: z.number().int().min(1).max(10),
      dailyBudget: z.number().positive(),
      bid: z.number().nonnegative().nullable(),
      launchImmediately: z.boolean(),
      sameCampaign: z.boolean().default(true),
      scheduledStartAt: z.string().datetime().nullable().default(null),
    }).parse(request.body);
    if (hasMetaOfflineAccount(
      dependencies.store,
      input.sources.map((source) => source.accountId),
    )) {
      return reply.status(409).send(metaOfflineMessage());
    }
    try {
      const result = await launchService.batchExpandAdGroups(input);
      return reply.send(result);
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  app.get("/api/ad-group-expand-tasks", async (request, reply) => {
    const query = z.object({
      accountIds: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(request.query);
    const accountIds = query.accountIds.split(",").map((id) => id.trim()).filter(Boolean);
    return reply.send({
      tasks: dependencies.store.listAdGroupExpandHistory(accountIds, query.limit),
    });
  });

  app.post("/api/launch-plans/:planId/execute", async (request, reply) => {
    const { planId } = z.object({ planId: z.string().min(1) }).parse(request.params);
    const plan = dependencies.store.getMultiAccountLaunchPlan(planId);
    if (!plan) {
      return reply.status(404).send({ message: "投放计划不存在。" });
    }
    if (hasMetaOfflineAccount(dependencies.store, [
      plan.sourceAccountId,
      ...plan.targetAccountIds,
    ])) {
      return reply.status(409).send(metaOfflineMessage());
    }
    const readiness = getCreationTemplateReadiness(plan.presetSnapshot?.creationConfig ?? {});
    if (!readiness.ready) {
      return reply.status(409).send({ message: `广告预设缺少 ${readiness.missingFieldCount} 项真实创建参数，不能执行。` });
    }
    try {
      const user = request.authSession?.user;
      return await launchService.execute(planId, user
        ? { id: user.id, name: user.username, kind: "user" }
        : { id: "local-user", name: "本地用户", kind: "user" });
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  app.post("/api/launch-plans/:planId/queue", async (request, reply) => {
    if (!launchWorker) {
      return reply.status(503).send({
        message: "当前隔离测试环境已关闭后台创建队列。",
      });
    }
    const { planId } = z.object({ planId: z.string().min(1) }).parse(request.params);
    const plan = dependencies.store.getMultiAccountLaunchPlan(planId);
    if (!plan) {
      return reply.status(404).send({ message: "投放计划不存在。" });
    }
    if (hasMetaOfflineAccount(dependencies.store, [
      plan.sourceAccountId,
      ...plan.targetAccountIds,
    ])) {
      return reply.status(409).send(metaOfflineMessage());
    }
    const readiness = getCreationTemplateReadiness(plan.presetSnapshot?.creationConfig ?? {});
    if (!readiness.ready) {
      return reply.status(409).send({ message: `广告预设缺少 ${readiness.missingFieldCount} 项真实创建参数，不能加入创建队列。` });
    }
    try {
      const user = request.authSession?.user;
      const actor: WriteTaskActor = user
        ? { id: user.id, name: user.username, kind: "user" }
        : { id: "local-user", name: "本地用户", kind: "user" };
      launchWorker.enqueue(planId, actor);
      return reply.status(202).send({
        plan: dependencies.store.getMultiAccountLaunchPlan(planId),
        queued: true,
      });
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  app.post("/api/launch-plans/:planId/items/:itemId/retry", async (request, reply) => {
    const { planId, itemId } = z.object({
      planId: z.string().min(1),
      itemId: z.string().min(1),
    }).parse(request.params);
    const plan = dependencies.store.getMultiAccountLaunchPlan(planId);
    if (plan && hasMetaOfflineAccount(dependencies.store, [
      plan.sourceAccountId,
      ...plan.targetAccountIds,
    ])) {
      return reply.status(409).send(metaOfflineMessage());
    }
    try {
      const user = request.authSession?.user;
      return await launchService.retryItem(planId, itemId, user
        ? { id: user.id, name: user.username, kind: "user" }
        : { id: "local-user", name: "本地用户", kind: "user" });
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  app.delete("/api/launch-plans/:planId", async (request, reply) => {
    const { planId } = z.object({ planId: z.string().min(1) }).parse(request.params);
    try {
      if (!dependencies.store.cancelMultiAccountLaunchPlan(planId)) {
        return reply.status(404).send({ message: "投放计划不存在或已结束。" });
      }
      return reply.status(204).send();
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  app.put("/api/automation/settings", async (request) => {
    const body = GlobalAutomationSettingsInputSchema.parse(request.body);
    return dependencies.store.updateGlobalAutomationSettings(body);
  });

  app.get("/api/notifications/channels", async () =>
    dependencies.store.listNotificationChannels(),
  );

  app.put(
    "/api/notifications/channels/:channelKind/settings",
    async (request, reply) => {
      const { channelKind } = NotificationParamsSchema.parse(request.params);
      const settings = NotificationChannelSettingsSchema.parse(request.body);
      if (settings.kind !== channelKind) {
        return reply.status(400).send({ message: "通知渠道类型不一致。" });
      }
      return dependencies.store.saveNotificationChannelSettings(settings);
    },
  );

  app.put(
    "/api/notifications/channels/:channelKind/credential",
    async (request, reply) => {
      const { channelKind } = NotificationParamsSchema.parse(request.params);
      const credential = NotificationCredentialInputSchema.parse(request.body);
      if (credential.kind !== channelKind) {
        return reply.status(400).send({ message: "通知凭据类型不一致。" });
      }
      const channel = dependencies.store.getNotificationChannel(channelKind);
      if (!channel?.settings) {
        return reply.status(409).send({ message: "请先保存通知渠道参数。" });
      }
      const reference = await dependencies.vault.create(
        JSON.stringify(credential),
      );
      try {
        dependencies.store.setNotificationCredentialReference(
          channelKind,
          reference,
        );
      } catch (cause) {
        await dependencies.vault.delete(reference);
        throw cause;
      }
      if (channel.credentialRef) {
        await dependencies.vault.delete(channel.credentialRef);
      }
      return dependencies.store
        .listNotificationChannels()
        .find((item) => item.kind === channelKind);
    },
  );

  app.delete(
    "/api/notifications/channels/:channelKind/credential",
    async (request) => {
      const { channelKind } = NotificationParamsSchema.parse(request.params);
      const reference =
        dependencies.store.clearNotificationCredential(channelKind);
      if (reference) await dependencies.vault.delete(reference);
      return { ok: true };
    },
  );

  app.get("/api/accounts/:accountId/manual-takeovers", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    const account = dependencies.store.getAccount(accountId);
    if (!account) return reply.status(404).send({ message: "账号不存在。" });
    return dependencies.store.listIgnoredEntities(accountId, account.providerKind)
      .filter((item) => item.entityType === "ad-group");
  });

  app.delete("/api/accounts/:accountId/manual-takeovers", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    const account = dependencies.store.getAccount(accountId);
    if (!account) return reply.status(404).send({ message: "账号不存在。" });
    const takeovers = dependencies.store.listIgnoredEntities(accountId, account.providerKind)
      .filter((item) => item.entityType === "ad-group");
    for (const takeover of takeovers) {
      dependencies.store.removeEntityIgnored(
        accountId,
        account.providerKind,
        takeover.entityType,
        takeover.externalId,
      );
    }
    return { restoredCount: takeovers.length };
  });

  app.post(
    "/api/notifications/channels/:channelKind/test",
    async (request) => {
      const { channelKind } = NotificationParamsSchema.parse(request.params);
      return notifications.testChannel(channelKind);
    },
  );

  app.get("/api/notifications/deliveries", async () =>
    dependencies.store.listNotificationDeliveries(),
  );

  app.get("/api/notifications/cycles", async () =>
    dependencies.store.listPollCycles(),
  );

  app.get("/api/rules", async () =>
    dependencies.store.getRuleConfiguration(),
  );

  app.put("/api/rules", async (request) => {
    const body = RuleConfigurationInputSchema.parse(request.body);
    return dependencies.store.updateRuleConfiguration(body);
  });

  app.get("/api/platforms/meta/rules", async () =>
    dependencies.store.getMetaRuleConfiguration(),
  );
  const metaCreationService = new MetaCreationService(
    dependencies.store,
    dependencies.vault,
    providers,
  );

  app.put("/api/platforms/meta/rules", async (request, reply) => {
    const { expectedUpdatedAt, ...body } =
      MetaRuleConfigurationUpdateRequestSchema.parse(request.body);
    try {
      return dependencies.store.updateMetaRuleConfiguration(body, expectedUpdatedAt);
    } catch (cause) {
      if (cause instanceof PlatformConfigurationConflictError) {
        return reply.status(409).send({
          error: cause.code,
          message: "Meta 规则已被其他操作更新，请刷新后再保存。",
        });
      }
      throw cause;
    }
  });

  app.get("/api/platforms/meta/runtime", async () =>
    dependencies.store.getMetaAutomationRuntime(),
  );

  app.put("/api/platforms/meta/runtime", async (request, reply) => {
    const { expectedUpdatedAt, ...body } =
      MetaAutomationRuntimeUpdateRequestSchema.parse(request.body);
    try {
      return dependencies.store.updateMetaAutomationRuntime(body, expectedUpdatedAt);
    } catch (cause) {
      if (cause instanceof PlatformConfigurationConflictError) {
        return reply.status(409).send({
          error: cause.code,
          message: "Meta 运行设置已被其他操作更新，请刷新后再保存。",
        });
      }
      throw cause;
    }
  });

  app.get("/api/accounts/:accountId/meta-creations", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    const account = dependencies.store.getAccount(accountId);
    if (!account) return reply.status(404).send({ message: "账号不存在。" });
    return dependencies.store.listMetaCreationTasks(accountId);
  });

  app.post("/api/accounts/:accountId/meta-creations", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    const input = MetaAdCreationInputSchema.parse(request.body);
    try {
      const task = await metaCreationService.execute(accountId, input);
      return reply.status(task.status === "succeeded" ? 201 : 200).send(task);
    } catch (cause) {
      if (cause instanceof MetaCreationIdempotencyConflictError) {
        return reply.status(409).send({
          error: cause.code,
          message: cause.message,
        });
      }
      throw cause;
    }
  });

  app.post(
    "/api/accounts/:accountId/meta-creations/:taskId/reconcile",
    async (request, reply) => {
      const { accountId, taskId } = MetaCreationTaskParamsSchema.parse(request.params);
      try {
        return await metaCreationService.reconcile(accountId, taskId);
      } catch (cause) {
        return reply.status(409).send({ message: getSafeProviderError(cause) });
      }
    },
  );

  app.post(
    "/api/accounts/:accountId/meta-creations/:taskId/retry",
    async (request, reply) => {
      const { accountId, taskId } = MetaCreationTaskParamsSchema.parse(request.params);
      let task;
      try {
        task = dependencies.store.getMetaCreationTask(taskId);
      } catch {
        return reply.status(404).send({ message: "Meta 创建任务不存在。" });
      }
      if (task.accountId !== accountId) {
        return reply.status(404).send({ message: "Meta 创建任务不存在。" });
      }
      return metaCreationService.execute(accountId, task.input);
    },
  );

  app.get("/api/platforms/meta/access-profiles", async () =>
    dependencies.store.listMetaAccessProfiles(),
  );

  app.post("/api/platforms/meta/access-profiles", async (request, reply) => {
    const input = MetaAccessProfileInputSchema.parse(request.body);
    try {
      return reply.status(201).send(dependencies.store.createMetaAccessProfile(
        input,
      ));
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  app.put("/api/platforms/meta/access-profiles/:profileId", async (request, reply) => {
    const { profileId } = MetaAccessProfileParamsSchema.parse(request.params);
    const input = MetaAccessProfileInputSchema.parse(request.body);
    try {
      const result = dependencies.store.updateMetaAccessProfile(
        profileId,
        input,
      );
      if (!result) return reply.status(404).send({ message: "Meta 共享凭据不存在。" });
      return result.profile;
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  app.put(
    "/api/platforms/meta/access-profiles/:profileId/secret",
    async (request, reply) => {
      const { profileId } = MetaAccessProfileParamsSchema.parse(request.params);
      const profile = dependencies.store.getStoredMetaAccessProfile(profileId);
      if (!profile) return reply.status(404).send({ message: "Meta 共享凭据不存在。" });
      const bundle = MetaAccessSecretBundleInputSchema.parse(request.body);
      const reference = await dependencies.vault.create(JSON.stringify(bundle));
      let updated;
      try {
        updated = dependencies.store.setMetaAccessProfileSecretReference(
          profileId,
          reference,
          { appId: profile.appId, updatedAt: profile.updatedAt },
        );
      } catch (cause) {
        try {
          await dependencies.vault.delete(reference);
        } catch (cleanupCause) {
          request.log.error(
            {
              profileId,
              error: getSafeProviderError(cleanupCause),
            },
            "Meta 新共享凭据回滚清理失败。",
          );
        }
        return reply.status(409).send({ message: getSafeProviderError(cause) });
      }
      if (profile.secretRef) {
        try {
          await dependencies.vault.delete(profile.secretRef);
        } catch (cleanupCause) {
          request.log.error(
            {
              profileId,
              error: getSafeProviderError(cleanupCause),
            },
            "Meta 旧共享凭据清理失败；新凭据仍保持生效。",
          );
        }
      }
      return updated;
    },
  );

  app.delete(
    "/api/platforms/meta/access-profiles/:profileId/secret",
    async (request, reply) => {
      const { profileId } = MetaAccessProfileParamsSchema.parse(request.params);
      if (!dependencies.store.getMetaAccessProfile(profileId)) {
        return reply.status(404).send({ message: "Meta 共享凭据不存在。" });
      }
      const reference = dependencies.store.clearMetaAccessProfileSecret(profileId);
      if (reference) await dependencies.vault.delete(reference);
      return reply.status(204).send();
    },
  );

  app.post(
    "/api/platforms/meta/access-profiles/:profileId/discover-ad-accounts",
    async (request, reply) => {
      const { profileId } = MetaAccessProfileParamsSchema.parse(request.params);
      const profile = dependencies.store.getStoredMetaAccessProfile(profileId);
      if (!profile) {
        return reply.status(404).send({ message: "Meta 共享凭据不存在。" });
      }
      if (!profile.secretRef) {
        return reply.status(409).send({
          message: "请先为 Meta 共享凭据保存 App Secret 与 Access Token。",
        });
      }
      const secret = await dependencies.vault.read(profile.secretRef);
      if (!secret) {
        return reply.status(409).send({
          message: "Meta 共享凭据引用已失效，请重新保存。",
        });
      }
      try {
        return await providers.discoverMetaAdAccounts({
          credential: MetaAccessSecretBundleInputSchema.parse(JSON.parse(secret)),
          resolvedMetaAccessProfile: {
            profileId: profile.id,
            appId: profile.appId,
            businessId: profile.businessId,
            graphApiVersion: profile.graphApiVersion,
          },
        });
      } catch (cause) {
        return reply.status(409).send({ message: getSafeProviderError(cause) });
      }
    },
  );

  app.delete("/api/platforms/meta/access-profiles/:profileId", async (request, reply) => {
    const { profileId } = MetaAccessProfileParamsSchema.parse(request.params);
    const profile = dependencies.store.getStoredMetaAccessProfile(profileId);
    if (!profile) return reply.status(404).send({ message: "Meta 共享凭据不存在。" });
    let deletedSecretRef: string | null;
    try {
      deletedSecretRef = dependencies.store.deleteMetaAccessProfile(profileId);
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
    if (deletedSecretRef) {
      try {
        await dependencies.vault.delete(deletedSecretRef);
      } catch (cleanupCause) {
        request.log.error(
          {
            profileId,
            error: getSafeProviderError(cleanupCause),
          },
          "Meta 共享凭据档案已删除并解除密文引用，但旧密文文件清理失败。",
        );
      }
    }
    return reply.status(204).send();
  });

  app.post("/api/accounts", async (request, reply) => {
    const body = AccountCreateInputSchema.parse(request.body);
    return reply.status(201).send(dependencies.store.createAccount(body));
  });

  app.delete("/api/accounts/:accountId", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    let credentialBackups: Array<{ reference: string; secret: string }> = [];
    try {
      const credentialReferences = dependencies.store.listAccountCredentialReferences(accountId);
      if (!credentialReferences) {
        return reply.status(404).send({ message: "账号不存在。" });
      }
      credentialBackups = (await Promise.all(credentialReferences.map(async (reference) => ({
        reference,
        secret: await dependencies.vault.read(reference),
      })))).flatMap((item) => item.secret === null ? [] : [{ reference: item.reference, secret: item.secret }]);
      for (const reference of credentialReferences) {
        await dependencies.vault.delete(reference);
      }
      dependencies.store.deleteAccount(accountId, credentialReferences);
    } catch (cause) {
      await Promise.allSettled(credentialBackups.map(({ reference, secret }) =>
        dependencies.vault.restore(reference, secret),
      ));
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
    return reply.status(204).send();
  });

  app.get("/api/accounts/:accountId", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    const account = dependencies.store.getAccount(accountId);
    if (!account) return reply.status(404).send({ message: "账号不存在。" });
    return account;
  });

  app.put("/api/accounts/:accountId/settings", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    const body = AccountSettingsUpdateSchema.parse(request.body);
    try {
      const account = dependencies.store.updateAccountSettings(accountId, body);
      if (!account) return reply.status(404).send({ message: "账号不存在。" });
      return account;
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  app.get("/api/accounts/:accountId/write-circuit", async (request) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    return automation.getProviderWriteCircuitState(accountId);
  });

  app.post(
    "/api/accounts/:accountId/write-circuit/reset",
    async (request) => {
      const { accountId } = AccountParamsSchema.parse(request.params);
      return automation.resetProviderWriteCircuit(accountId);
    },
  );

  app.get("/api/accounts/:accountId/provider-health", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    const account = dependencies.store.getAccount(accountId);
    if (!account) return reply.status(404).send({ message: "账号不存在。" });
    return dependencies.store.getProviderConnection(
      account.id,
      account.providerKind,
    );
  });

  app.get("/api/accounts/:accountId/connections", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    if (!dependencies.store.getAccount(accountId)) {
      return reply.status(404).send({ message: "账号不存在。" });
    }
    return dependencies.store.listProviderConnections(accountId);
  });

  app.get("/api/accounts/:accountId/connection-capabilities", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    if (!dependencies.store.getAccount(accountId)) {
      return reply.status(404).send({ message: "账号不存在。" });
    }
    return dependencies.store.listProviderConnections(accountId).map((connection) =>
      providers.describeAccount(accountId, connection.kind, connection),
    );
  });

  app.get("/api/accounts/:accountId/capabilities", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    const account = dependencies.store.getAccount(accountId);
    if (!account) return reply.status(404).send({ message: "账号不存在。" });
    return providers.describeAccount(
      accountId,
      account.providerKind,
      dependencies.store.getProviderConnection(accountId, account.providerKind),
    );
  });

  app.get(
    "/api/accounts/:accountId/connections/cookie/readiness",
    async (request, reply) => {
      const { accountId } = AccountParamsSchema.parse(request.params);
      const connection = dependencies.store.getProviderConnection(
        accountId,
        "cookie",
      );
      if (!connection?.credentialRef) {
        return getTikTokCookieImportReadiness();
      }
      const secret = await dependencies.vault.read(connection.credentialRef);
      if (!secret) {
        return reply.status(409).send({ message: "Cookie 凭据引用已失效。" });
      }
      const credential = ProviderCredentialInputSchema.parse(JSON.parse(secret));
      if (credential.kind !== "cookie") {
        return reply.status(409).send({ message: "当前凭据不是 Cookie 类型。" });
      }
      return getTikTokCookieImportReadiness(credential);
    },
  );

  app.post(
    "/api/accounts/:accountId/connections/cookie/import-curl",
    async (request, reply) => {
      const { accountId } = AccountParamsSchema.parse(request.params);
      if (!dependencies.store.getAccount(accountId)) {
        return reply.status(404).send({ message: "账号不存在。" });
      }
      const { command, step } = CurlImportBodySchema.parse(request.body);
      let imported: ReturnType<typeof parseTikTokCurl>;
      try {
        imported =
          step === "read"
            ? parseTikTokReadCurl(command)
            : step === "status"
              ? parseTikTokStatusCurl(command)
              : parseTikTokCurl(command);
      } catch (cause) {
        if (cause instanceof TikTokCurlImportError) {
          return reply.status(400).send({ message: cause.message });
        }
        throw cause;
      }

      const previous = dependencies.store.getProviderConnection(
        accountId,
        "cookie",
      );
      let credential = imported.credential;
      if (previous?.credentialRef) {
        const previousSecret = await dependencies.vault.read(
          previous.credentialRef,
        );
        if (previousSecret) {
          try {
            const parsedPrevious = ProviderCredentialInputSchema.parse(
              JSON.parse(previousSecret),
            );
            if (parsedPrevious.kind === "cookie") {
              const incomingKeys = new Set(
                (credential.requestTemplates ?? []).map(
                  (item) => `${item.target}:${item.action ?? ""}`,
                ),
              );
              credential = CookieCredentialInputSchema.parse({
                ...credential,
                // A refreshed list/status cURL updates session material only.
                // Keep the account-scoped encrypted creation profile so
                // reconnecting never silently removes creation capability.
                creationProfile: parsedPrevious.creationProfile,
                csrfToken:
                  credential.csrfToken ?? parsedPrevious.csrfToken,
                csrfHeaderName: credential.csrfToken
                  ? credential.csrfHeaderName
                  : parsedPrevious.csrfHeaderName,
                userAgent: credential.userAgent ?? parsedPrevious.userAgent,
                requestTemplates: [
                  ...(parsedPrevious.requestTemplates ?? []).filter(
                    (item) => !incomingKeys.has(`${item.target}:${item.action ?? ""}`),
                  ),
                  ...(credential.requestTemplates ?? []),
                ],
              });
            }
          } catch {
            // A stale legacy credential should not block replacing it.
          }
        }
      }
      dependencies.store.saveProviderConnectionSettings(
        accountId,
        imported.settings,
      );
      const reference = await dependencies.vault.create(
        JSON.stringify(credential),
      );
      try {
        dependencies.store.setProviderCredentialReference(
          accountId,
          "cookie",
          reference,
        );
      } catch (cause) {
        await dependencies.vault.delete(reference);
        throw cause;
      }
      if (previous?.credentialRef) {
        await dependencies.vault.delete(previous.credentialRef);
      }

      const importMessage = imported.summary.target.endsWith("-status")
        ? "第 2 段启停 cURL 已解码，更新查询参数和三级启停模板已加密保存。"
        : "第 1 段列表 cURL 已解码，列表查询参数、复制查询参数、Cookie 和 CSRF 已加密保存。";

      const checkedConnection = dependencies.store.getProviderConnection(accountId, "cookie");
      if (!checkedConnection) throw new Error("Provider connection not found");
      try {
        const context = await loadProviderContext(
          dependencies.store,
          dependencies.vault,
          accountId,
          "cookie",
        );
        const health = await providers.checkHealth("cookie", context);
        const authorized = dependencies.store.completeProviderHealthCheckIfCurrent(
          accountId,
          "cookie",
          checkedConnection,
          {
            connectionStatus: health.status,
            message: `${importMessage} ${imported.summary.method} ${imported.summary.path} ${health.message}`,
            authorizationStatus: health.status === "ready" ? "active" : "failed",
            capabilityVersion: providers.capabilityVersion("cookie"),
            capabilities: health.status === "ready"
              ? providers.resolveAuthorizedCapabilities("cookie", context)
              : [],
          },
        );
        if (!authorized) {
          return reply.status(409).send({ message: "接入参数或凭据已变更，请重新检测。" });
        }
        return authorized;
      } catch (cause) {
        const authorized = dependencies.store.completeProviderHealthCheckIfCurrent(
          accountId,
          "cookie",
          checkedConnection,
          {
            connectionStatus: "failed",
            message: `${importMessage} 请求已加密保存，但连接检测失败：${getSafeProviderError(cause)}`,
            authorizationStatus: "failed",
            capabilityVersion: providers.capabilityVersion("cookie"),
            capabilities: [],
          },
        );
        if (!authorized) {
          return reply.status(409).send({ message: "接入参数或凭据已变更，请重新检测。" });
        }
        return authorized;
      }
    },
  );

  app.put(
    "/api/accounts/:accountId/connections/:providerKind/settings",
    async (request, reply) => {
      const { accountId, providerKind } = ProviderParamsSchema.parse(
        request.params,
      );
      const settings = ProviderConnectionSettingsSchema.parse(request.body);
      const account = dependencies.store.getAccount(accountId);
      if (!account) return reply.status(404).send({ message: "账号不存在。" });
      if (settings.kind !== providerKind) {
        return reply.status(400).send({ message: "Provider 类型不一致。" });
      }
      if (!providerBelongsToPlatform(account.platform, providerKind)) {
        return reply.status(409).send({ message: "接入方式与账户平台不匹配。" });
      }
      if (providerKind === "meta-offline") {
        return reply.status(409).send({
          message: "Meta 当前仅提供离线架构，不接收 API 参数或凭据。",
        });
      }
      return dependencies.store.saveProviderConnectionSettings(
        accountId,
        settings,
      );
    },
  );

  app.put(
    "/api/accounts/:accountId/connections/:providerKind/credential",
    async (request, reply) => {
      const { accountId, providerKind } = ProviderParamsSchema.parse(
        request.params,
      );
      if (providerKind === "meta-marketing-api") {
        return reply.status(409).send({
          message: "Meta App Secret 与 Access Token 由共享凭据 Profile 统一管理，不再按广告账户重复保存。",
        });
      }
      const credential = ProviderCredentialInputSchema.parse(request.body);
      const account = dependencies.store.getAccount(accountId);
      if (!account) return reply.status(404).send({ message: "账号不存在。" });
      if (credential.kind !== providerKind) {
        return reply.status(400).send({ message: "凭据类型不一致。" });
      }
      if (!providerBelongsToPlatform(account.platform, providerKind)) {
        return reply.status(409).send({ message: "接入方式与账户平台不匹配。" });
      }
      if (providerKind === "meta-offline") {
        return reply.status(409).send({
          message: "Meta 当前仅提供离线架构，不接收 API 参数或凭据。",
        });
      }
      const existing = dependencies.store.getProviderConnection(
        accountId,
        providerKind,
      );
      if (!existing) {
        return reply.status(409).send({ message: "请先保存接入参数。" });
      }
      const reference = await dependencies.vault.create(
        JSON.stringify(credential),
      );
      try {
        const connection = dependencies.store.setProviderCredentialReference(
          accountId,
          providerKind,
          reference,
        );
        if (existing.credentialRef) {
          await dependencies.vault.delete(existing.credentialRef);
        }
        return connection;
      } catch (error) {
        await dependencies.vault.delete(reference);
        throw error;
      }
    },
  );

  app.delete(
    "/api/accounts/:accountId/connections/:providerKind/credential",
    async (request, reply) => {
      const { accountId, providerKind } = ProviderParamsSchema.parse(
        request.params,
      );
      if (providerKind === "meta-offline") {
        return reply.status(409).send({
          message: "Meta Marketing API 尚未接入；当前仅提供零网络离线架构。",
        });
      }
      if (providerKind === "meta-marketing-api") {
        return reply.status(409).send({
          message: "请在 Meta 共享凭据 Profile 中删除 App Secret 与 Access Token。",
        });
      }
      const reference = dependencies.store.clearProviderCredential(
        accountId,
        providerKind,
      );
      if (reference) await dependencies.vault.delete(reference);
      return reply.status(204).send();
    },
  );

  app.get("/api/accounts/:accountId/automation/runs", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    if (!dependencies.store.getAccount(accountId)) {
      return reply.status(404).send({ message: "账号不存在。" });
    }
    return dependencies.store.listAutomationRuns(accountId);
  });

  app.get("/api/accounts/:accountId/automation/latest-sync", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    const account = dependencies.store.getAccount(accountId);
    if (!account) return reply.status(404).send({ message: "账户不存在。" });
    return dependencies.store.getLatestReadOnlySync(accountId, account.providerKind);
  });

  app.get(
    "/api/accounts/:accountId/automation/decisions",
    async (request, reply) => {
      const { accountId } = AccountParamsSchema.parse(request.params);
      if (!dependencies.store.getAccount(accountId)) {
        return reply.status(404).send({ message: "账号不存在。" });
      }
      return dependencies.store.listAutomationDecisions(accountId);
    },
  );

  app.post(
    "/api/accounts/:accountId/automation/preview",
    async (request, reply) => {
      const { accountId } = AccountParamsSchema.parse(request.params);
      const account = dependencies.store.getAccount(accountId);
      if (!account) {
        return reply.status(404).send({ message: "账号不存在。" });
      }
      if (account.providerKind === "meta-offline") {
        return reply.status(409).send(metaOfflineMessage());
      }
      return automation.runAccount(accountId, "preview");
    },
  );

  app.post(
    "/api/accounts/:accountId/automation/run",
    async (request, reply) => {
      const { accountId } = AccountParamsSchema.parse(request.params);
      const account = dependencies.store.getAccount(accountId);
      if (!account) {
        return reply.status(404).send({ message: "账号不存在。" });
      }
      if (account.providerKind === "meta-offline") {
        return reply.status(409).send(metaOfflineMessage());
      }
      if (!account.enabled) {
        return reply.status(409).send({ message: "账户自动化已关闭，请先在用户管理中开启。" });
      }
      return automation.runAccount(accountId, "manual");
    },
  );

  app.get("/api/accounts/:accountId/entities", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    const account = dependencies.store.getAccount(accountId);
    if (!account) return reply.status(404).send({ message: "账号不存在。" });
    return dependencies.store.listCurrentManagedEntities(
      accountId,
      account.providerKind,
    );
  });

  app.post(
    "/api/accounts/:accountId/entities/status",
    async (request, reply) => {
      const { accountId } = AccountParamsSchema.parse(request.params);
      const account = dependencies.store.getAccount(accountId);
      if (!account) {
        return reply.status(404).send({ message: "账号不存在。" });
      }
      const body = ManualStatusInputSchema.parse(request.body);
      if (account.platform === "meta") {
        if (account.providerKind !== "meta-marketing-api") {
          return reply.status(409).send(metaOfflineMessage());
        }
        try {
          providers.requireAccountCapability(
            accountId,
            account.providerKind,
            dependencies.store.getProviderConnection(accountId, account.providerKind),
            "change-status",
          );
        } catch (cause) {
          return reply.status(409).send({ message: getSafeProviderError(cause) });
        }
      }
      const user = request.authSession?.user;
      try {
        return automation.enqueueManualStatusChange(accountId, body, user
          ? { id: user.id, name: user.username, kind: "user" }
          : { id: "local-user", name: "本地用户", kind: "user" });
      } catch (cause) {
        return reply.status(409).send({ message: getSafeProviderError(cause) });
      }
    },
  );

  app.post(
    "/api/accounts/:accountId/status-operations/:operationId/retry",
    async (request, reply) => {
      const { accountId, operationId } = OperationParamsSchema.parse(request.params);
      const account = dependencies.store.getAccount(accountId);
      if (!account) {
        return reply.status(404).send({ message: "账号不存在。" });
      }
      if (account.platform === "meta") {
        return reply.status(409).send({
          message: "Meta 启停的失败或 unknown 操作禁止自动重放，请先只读对账。",
        });
      }
      const user = request.authSession?.user;
      try {
        return await automation.retryStatusOperation(accountId, operationId, user
          ? { id: user.id, name: user.username, kind: "user" }
          : { id: "local-user", name: "本地用户", kind: "user" });
      } catch (cause) {
        return reply.status(409).send({ message: getSafeProviderError(cause) });
      }
    },
  );

  app.post(
    "/api/accounts/:accountId/status-operations/:operationId/verify",
    async (request, reply) => {
      const { accountId, operationId } = OperationParamsSchema.parse(request.params);
      const account = dependencies.store.getAccount(accountId);
      if (!account) return reply.status(404).send({ message: "账号不存在。" });
      if (account.providerKind === "meta-offline") {
        return reply.status(409).send(metaOfflineMessage());
      }
      let task;
      try {
        task = dependencies.store.getAdOperationByOperationId(operationId);
      } catch (cause) {
        return reply.status(404).send({ message: getSafeProviderError(cause) });
      }
      if (task.accountId !== accountId) {
        return reply.status(404).send({ message: "状态写入任务不存在。" });
      }
      const user = request.authSession?.user;
      try {
        const verification = dependencies.store.verifyUnknownStatusWriteTask(
          task.id,
          StatusManualVerificationInputSchema.parse(request.body),
          user
            ? { id: user.id, name: user.username, kind: "user" }
            : { id: "local-user", name: "本地用户", kind: "user" },
        );
        return {
          verification,
          task: dependencies.store.getAdOperation(task.id),
        };
      } catch (cause) {
        return reply.status(409).send({ message: getSafeProviderError(cause) });
      }
    },
  );

  app.post(
    "/api/accounts/:accountId/entities/:entityType/:externalId/ignore",
    async (request, reply) => {
      const { accountId, entityType, externalId } = EntityParamsSchema.parse(
        request.params,
      );
      const account = dependencies.store.getAccount(accountId);
      if (!account) return reply.status(404).send({ message: "账号不存在。" });
      if (account.platform === "meta") return reply.status(409).send(metaOfflineMessage());
      const body = IgnoreEntityInputSchema.parse({
        ...(request.body as object),
        entityType,
        externalId,
      });
      return dependencies.store.setEntityIgnored(
        accountId,
        account.providerKind,
        entityType,
        externalId,
        body.reason,
      );
    },
  );

  app.delete(
    "/api/accounts/:accountId/entities/:entityType/:externalId/ignore",
    async (request, reply) => {
      const { accountId, entityType, externalId } = EntityParamsSchema.parse(
        request.params,
      );
      const account = dependencies.store.getAccount(accountId);
      if (!account) return reply.status(404).send({ message: "账号不存在。" });
      if (account.platform === "meta") return reply.status(409).send(metaOfflineMessage());
      const removed = dependencies.store.removeEntityIgnored(
        accountId,
        account.providerKind,
        entityType,
        externalId,
      );
      if (!removed) return reply.status(404).send({ message: "忽略记录不存在。" });
      return reply.status(204).send();
    },
  );

  app.post(
    "/api/accounts/:accountId/meta/status-operations/:operationId/reconcile",
    async (request, reply) => {
      const { accountId, operationId } = OperationParamsSchema.parse(request.params);
      const user = request.authSession?.user;
      try {
        return await automation.reconcileMetaStatusOperation(
          accountId,
          operationId,
          user
            ? { id: user.id, name: user.username, kind: "user" }
            : { id: "meta-readback-reconcile", name: "Meta 只读回读核验", kind: "system" },
        );
      } catch (cause) {
        return reply.status(409).send({ message: getSafeProviderError(cause) });
      }
    },
  );

  app.get(
    "/api/accounts/:accountId/ad-operations",
    async (request, reply) => {
      const { accountId } = AccountParamsSchema.parse(request.params);
      const account = dependencies.store.getAccount(accountId);
      if (!account) {
        return reply.status(404).send({ message: "账号不存在。" });
      }
      return dependencies.store.listAdOperations(accountId);
    },
  );

  app.get("/api/accounts/:accountId/schedules", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    if (!dependencies.store.getAccount(accountId)) {
      return reply.status(404).send({ message: "账号不存在。" });
    }
    return dependencies.store.listScheduledActions(accountId);
  });

  app.post(
    "/api/accounts/:accountId/schedules/once",
    async (request, reply) => {
      const { accountId } = AccountParamsSchema.parse(request.params);
      const account = dependencies.store.getAccount(accountId);
      if (!account) {
        return reply.status(404).send({ message: "账号不存在。" });
      }
      if (account.platform === "meta") return reply.status(409).send(metaOfflineMessage());
      return reply.status(201).send(
        dependencies.store.createOneTimeSchedule(
          accountId,
          OneTimeScheduleInputSchema.parse(request.body),
        ),
      );
    },
  );

  app.post(
    "/api/accounts/:accountId/schedules/overnight",
    async (request, reply) => {
      const { accountId } = AccountParamsSchema.parse(request.params);
      const account = dependencies.store.getAccount(accountId);
      if (!account) {
        return reply.status(404).send({ message: "账号不存在。" });
      }
      if (account.platform === "meta") return reply.status(409).send(metaOfflineMessage());
      return reply.status(201).send(
        dependencies.store.createOvernightSchedule(
          accountId,
          OvernightScheduleInputSchema.parse(request.body),
        ),
      );
    },
  );

  app.delete(
    "/api/accounts/:accountId/schedules/:scheduleId",
    async (request, reply) => {
      const params = AccountParamsSchema.extend({
        scheduleId: z.string().min(1),
      }).parse(request.params);
      if (
        !dependencies.store.cancelScheduledAction(
          params.accountId,
          params.scheduleId,
        )
      ) {
        return reply.status(404).send({ message: "定时任务不存在或已结束。" });
      }
      return reply.status(204).send();
    },
  );

  app.delete(
    "/api/accounts/:accountId/overnight-schedules/:groupId",
    async (request, reply) => {
      const params = AccountParamsSchema.extend({
        groupId: z.string().min(1),
      }).parse(request.params);
      if (
        !dependencies.store.cancelOvernightSchedule(
          params.accountId,
          params.groupId,
        )
      ) {
        return reply.status(404).send({ message: "过夜任务不存在或已结束。" });
      }
      return reply.status(204).send();
    },
  );

  app.post(
    "/api/accounts/:accountId/appeals",
    async (request, reply) => {
      const { accountId } = AccountParamsSchema.parse(request.params);
      const account = dependencies.store.getAccount(accountId);
      if (!account) return reply.status(404).send({ message: "账号不存在。" });
      return reply.status(409).send({
        message: "当前 Provider 未实现申诉执行，无法加入队列。请在 TikTok Ads Manager 中完成申诉。",
      });
    },
  );

  app.get("/api/accounts/:accountId/analytics", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    const account = dependencies.store.getAccount(accountId);
    if (!account) return reply.status(404).send({ message: "账号不存在。" });
    const query = AnalyticsQuerySchema.parse(request.query);
    const until = query.to ?? new Date().toISOString();
    const since = query.from ?? new Date(
      new Date(until).getTime() - query.days * 24 * 60 * 60_000,
    ).toISOString();
    if (new Date(until).getTime() - new Date(since).getTime() > 90 * 24 * 60 * 60_000) {
      return reply.status(400).send({ message: "自定义分析范围最多为 90 天。" });
    }
    return dependencies.store.listMetricBatches(
      accountId,
      account.providerKind,
      since,
      query.entityType,
      until,
    );
  });

  // 按自然日汇总。/analytics 返回的是同步批次（当日累计的中间态），只适合排查同步本身；
  // 业务指标一律走这里，否则同一天的累计值会被重复计入区间合计。
  app.get("/api/accounts/:accountId/metric-days", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    const account = dependencies.store.getAccount(accountId);
    if (!account) return reply.status(404).send({ message: "账号不存在。" });
    const query = AnalyticsQuerySchema.parse(request.query);
    const until = query.to ?? new Date().toISOString();
    const since = query.from ?? new Date(
      new Date(until).getTime() - query.days * 24 * 60 * 60_000,
    ).toISOString();
    if (new Date(until).getTime() - new Date(since).getTime() > 90 * 24 * 60 * 60_000) {
      return reply.status(400).send({ message: "自定义分析范围最多为 90 天。" });
    }
    return dependencies.store.listDailyMetricTotals(
      accountId,
      account.providerKind,
      since,
      query.entityType,
      until,
    );
  });

  // 广告管理页的「消耗日期」区间：按对象返回区间合计，口径与 metric-days 相同。
  app.get("/api/accounts/:accountId/entity-metrics", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    const account = dependencies.store.getAccount(accountId);
    if (!account) return reply.status(404).send({ message: "账号不存在。" });
    const query = AnalyticsQuerySchema.parse(request.query);
    const until = query.to ?? new Date().toISOString();
    const since = query.from ?? new Date(
      new Date(until).getTime() - query.days * 24 * 60 * 60_000,
    ).toISOString();
    if (new Date(until).getTime() - new Date(since).getTime() > 90 * 24 * 60 * 60_000) {
      return reply.status(400).send({ message: "自定义分析范围最多为 90 天。" });
    }
    return dependencies.store.listEntityRangeMetrics(
      accountId,
      account.providerKind,
      since,
      query.entityType,
      until,
    );
  });

  /**
   * 扩组页的分类：每条系列今天该照常扩组，还是该停下来复制新系列重跑。
   *
   * 判据是**自系列创建以来累计**，所以回看整个保留期而不是最近几天——窗口取短了会把
   * 老系列的成绩截掉。实测同一条系列按 3 天窗口看是「单转 8.0 可扩」，按累计看是
   * 「13.1 该重扩」，口径不能含糊。
   *
   * 返回 computedAt：转化是延迟回传的，同一天早上和下午算出来的分桶会不一样，界面必须
   * 能告诉用户「你看的是几点的账」。
   */
  app.get("/api/accounts/:accountId/expand-classification", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    const account = dependencies.store.getAccount(accountId);
    if (!account) return reply.status(404).send({ message: "账号不存在。" });
    const query = z.object({
      maxCostPerConversion: z.coerce.number().positive()
        .default(DEFAULT_EXPAND_THRESHOLDS.maxCostPerConversion),
      maxSpendWithoutConversion: z.coerce.number().nonnegative()
        .default(DEFAULT_EXPAND_THRESHOLDS.maxSpendWithoutConversion),
    }).parse(request.query);

    const until = new Date().toISOString();
    const since = new Date(
      Date.now() - METRIC_RETENTION_DAYS * 24 * 60 * 60_000,
    ).toISOString();
    // listEntityRangeMetrics 按账户本地日取当日最后一个健康快照再跨日累加。这一步的
    // 时区是关键：TikTok 报表按账户时区日切（实测该户 234 条系列全部在本地 00:00 归零），
    // 拿 UTC 日分组会取到日切后几小时的近零值，花费与转化都会被严重少算。
    const metrics = new Map(
      dependencies.store
        .listEntityRangeMetrics(accountId, account.providerKind, since, "campaign", until)
        .map((row) => [row.externalId, row]),
    );
    // 必须走 listCurrentManagedEntities：listManagedEntities 不筛 is_current，会把
    // 已经下线的系列一并带出来（实测生产账户 105 行里有 1 行是陈旧的），那些系列在
    // 账户里已经不存在，却会顶着历史累计出现在判定结果里。
    const managed = dependencies.store.listCurrentManagedEntities(accountId, account.providerKind);
    // 组被自动化规则一个个关光的系列，再也花不出钱：零转化的观察期判据在它身上是死
    // 循环（消耗永远跨不过阈值），而「关掉需重扩的系列」也只敢对这批下手。
    const campaignsWithActiveAdGroups = new Set(
      managed
        .filter((entity) => entity.entityType === "ad-group"
          && entity.status === "enabled"
          && entity.parentCampaignId)
        .map((entity) => entity.parentCampaignId as string),
    );
    const campaigns = managed
      .filter((entity) => entity.entityType === "campaign")
      .map((entity) => {
        const metric = metrics.get(entity.externalId);
        return {
          externalId: entity.externalId,
          name: entity.name,
          status: entity.status,
          hasActiveAdGroups: campaignsWithActiveAdGroups.has(entity.externalId),
          // 快照里没有这条系列时按零处理：它要么刚建、要么已超出保留期，两种都不该
          // 凭空得到一个成绩。
          spend: metric?.spend ?? 0,
          conversions: metric?.conversions ?? 0,
          days: metric?.days ?? 0,
        };
      });

    const thresholds = {
      maxCostPerConversion: query.maxCostPerConversion,
      maxSpendWithoutConversion: query.maxSpendWithoutConversion,
    };
    return reply.send({
      computedAt: until,
      coverageSince: since,
      thresholds,
      ...classifyCampaignsForExpand(campaigns, thresholds),
    });
  });

  app.post(
    "/api/accounts/:accountId/connections/:providerKind/test",
    async (request, reply) => {
      const { accountId, providerKind } = ProviderParamsSchema.parse(
        request.params,
      );
      if (providerKind === "meta-offline") {
        return reply.status(409).send({
          message: "Meta Marketing API 尚未接入；当前不会发起同步请求。",
        });
      }
      const checkedConnection = dependencies.store.getProviderConnection(
        accountId,
        providerKind,
      );
      if (!checkedConnection) {
        return reply.status(404).send({ message: "Provider 接入不存在。" });
      }
      try {
        const context = await loadProviderContext(
          dependencies.store,
          dependencies.vault,
          accountId,
          providerKind,
        );
        const health = await providers.checkHealth(providerKind, context);
        const authorized = dependencies.store.completeProviderHealthCheckIfCurrent(
          accountId,
          providerKind,
          checkedConnection,
          {
            connectionStatus: health.status,
            message: health.message,
            authorizationStatus: health.status === "ready" ? "active" : "failed",
            capabilityVersion: providers.capabilityVersion(providerKind),
            capabilities: health.status === "ready"
              ? providers.resolveAuthorizedCapabilities(providerKind, context)
              : [],
          },
        );
        if (!authorized) {
          return reply.status(409).send({ message: "接入参数或凭据已变更，请重新检测。" });
        }
        return authorized;
      } catch (cause) {
        const authorized = dependencies.store.completeProviderHealthCheckIfCurrent(
          accountId,
          providerKind,
          checkedConnection,
          {
            connectionStatus: "failed",
            message: getSafeProviderError(cause),
            authorizationStatus: "failed",
            capabilityVersion: providers.capabilityVersion(providerKind),
            capabilities: [],
          },
        );
        if (!authorized) {
          return reply.status(409).send({ message: "接入参数或凭据已变更，请重新检测。" });
        }
        return authorized;
      }
    },
  );

  app.post(
    "/api/accounts/:accountId/connections/:providerKind/sync",
    async (request, reply) => {
      const { accountId, providerKind } = ProviderParamsSchema.parse(
        request.params,
      );
      const connection = dependencies.store.getProviderConnection(
        accountId,
        providerKind,
      );
      if (!connection || connection.status !== "ready") {
        return reply.status(409).send({ message: "请先通过连接检测。" });
      }
      try {
        providers.requireAccountCapability(
          accountId,
          providerKind,
          connection,
          "read-campaigns",
        );
      } catch (cause) {
        return reply.status(409).send({ message: getSafeProviderError(cause) });
      }
      let output: Awaited<ReturnType<ProviderRegistry["syncReadOnly"]>>;
      try {
        const context = await loadProviderContext(
          dependencies.store,
          dependencies.vault,
          accountId,
          providerKind,
        );
        output = await providers.syncReadOnly(providerKind, context);
      } catch (cause) {
        dependencies.store.updateProviderStatus(
          accountId,
          providerKind,
          "failed",
          `数据同步异常：${getSafeProviderError(cause)}`,
        );
        throw cause;
      }
      dependencies.store.saveReadOnlySync(accountId, providerKind, output.entities, output.result);
      return output.result;
    },
  );

  return app;
}

async function loadProviderContext(
  store: AutomationStore,
  vault: CredentialVault,
  accountId: string,
  providerKind: ProviderKind,
): Promise<ProviderContext> {
  const connection = store.getProviderConnection(accountId, providerKind);
  if (!connection) {
    throw new Error("接入参数或凭据尚未配置。");
  }
  if (providerKind === "meta-marketing-api") {
    if (
      connection.settings.kind !== "meta-marketing-api"
      || !connection.settings.profileId
    ) {
      throw new Error("Meta 广告账户尚未绑定共享凭据 Profile。");
    }
    const profile = store.getStoredMetaAccessProfile(connection.settings.profileId);
    if (!profile?.secretRef) {
      throw new Error("Meta 共享凭据 Profile 尚未保存 App Secret 与 Access Token。");
    }
    const secret = await vault.read(profile.secretRef);
    if (!secret) throw new Error("Meta 共享凭据引用已失效，请重新保存。");
    return {
      accountId,
      settings: connection.settings,
      credential: MetaAccessSecretBundleInputSchema.parse(JSON.parse(secret)),
      resolvedMetaAccessProfile: {
        profileId: profile.id,
        appId: profile.appId,
        businessId: profile.businessId,
        graphApiVersion: profile.graphApiVersion,
      },
      timezone: store.getAccount(accountId)?.timezone ?? "UTC",
    };
  }
  if (!connection.credentialRef) {
    throw new Error("接入参数或凭据尚未配置。");
  }
  const secret = await vault.read(connection.credentialRef);
  if (!secret) throw new Error("凭据引用已经失效，请重新保存凭据。");
  return {
    accountId,
    settings: connection.settings,
    credential: ProviderCredentialInputSchema.parse(JSON.parse(secret)),
    timezone: store.getAccount(accountId)?.timezone ?? "UTC",
  };
}

function getSafeProviderError(cause: unknown): string {
  if (!(cause instanceof Error)) return "连接检测失败。";
  if (cause.name === "TimeoutError") return "连接检测超时。";
  return withCauseDetail(cause.message, cause);
}

function metaOfflineMessage(): { message: string } {
  return {
    message: "Meta 离线账户不允许真实操作；请切换到 Meta Marketing API，按账户选择只读、人工启停或自动启停模式并通过授权检测。",
  };
}

function hasMetaOfflineAccount(
  store: AutomationStore,
  accountIds: Iterable<string>,
): boolean {
  return [...new Set(accountIds)].some(
    (accountId) => store.getAccount(accountId)?.providerKind === "meta-offline",
  );
}

function isMutation(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function isPublicApi(method: string, rawUrl: string): boolean {
  const path = rawUrl.split("?", 1)[0] ?? rawUrl;
  return (
    (method === "GET" && ["/api/health", "/api/auth/status"].includes(path)) ||
    (method === "POST" && ["/api/auth/setup", "/api/auth/login", "/api/auth/recover"].includes(path))
  );
}

function isRuntimeOperation(method: string, rawUrl: string): boolean {
  if (!isMutation(method)) return false;
  const path = rawUrl.split("?", 1)[0] ?? rawUrl;
  return path.endsWith("/automation/run");
}

function getRuntimePauseMessage(
  store: AutomationStore,
  method: string,
  rawUrl: string,
): string | null {
  if (!isRuntimeOperation(method, rawUrl)) return null;
  const path = rawUrl.split("?", 1)[0] ?? rawUrl;
  const match = path.match(/^\/api\/accounts\/([^/]+)\/automation\/run$/);
  if (match?.[1]) {
    let accountId: string;
    try {
      accountId = decodeURIComponent(match[1]);
    } catch {
      accountId = match[1];
    }
    const account = store.getAccount(accountId);
    if (account?.providerKind === "meta-offline") return null;
    if (account?.platform === "meta") {
      return store.getMetaAutomationRuntime().enabled
        ? null
        : "Meta 自动化总开关已关闭，Meta 后台执行已暂停。";
    }
  }
  return store.getSystemRuntimeState().enabled
    ? null
    : "自动化总开关已关闭，后台自动化已暂停。";
}

export function requiredPermission(
  method: string,
  rawUrl: string,
): AppPermission | null {
  const path = rawUrl.split("?", 1)[0] ?? rawUrl;
  if (path.startsWith("/api/maintenance/")) return "system:control";
  if (!isMutation(method)) {
    return path.startsWith("/api/local-users") ? "users:manage" : null;
  }
  if (path.startsWith("/api/local-users")) return "users:manage";
  if (path.startsWith("/api/platforms/meta/access-profiles")) return "accounts:manage";
  if (path.includes("/meta-creations")) return "ads:operate";
  if (path.startsWith("/api/system/")) return "system:control";
  if (path === "/api/platforms/meta/runtime") return "system:control";
  if (
    path === "/api/rules" ||
    path === "/api/platforms/meta/rules" ||
    path.startsWith("/api/automation/settings") ||
    path.startsWith("/api/automation/features")
  ) {
    return "rules:manage";
  }
  if (path.startsWith("/api/notifications/")) return "rules:manage";
  if (
    path.startsWith("/api/launch-plans/")
    && (path.endsWith("/execute") || path.endsWith("/queue") || path.endsWith("/retry") || path.endsWith("/verify"))
  ) return "ads:operate";
  if (path.includes("/write-circuit")) return "automation:execute";
  if (path.includes("/automation/")) return "automation:execute";
  if (
    path.includes("/entities/status") ||
    path.includes("/status-operations/") ||
    path.includes("/ignore") ||
    path.includes("/appeals") ||
    path.includes("/schedules")
  ) {
    return "ads:operate";
  }
  if (path.includes("/manual-takeovers")) return "ads:operate";
  if (path.startsWith("/api/ad-groups")) return "ads:operate";
  if (path.includes("/campaign-copy-tasks")) return "launch:manage";
  // 不能依赖函数末尾的兜底：那条规则对非 DELETE 返回 null，等于放行无权限校验。
  if (path.startsWith("/api/campaigns")) return "launch:manage";
  if (path.startsWith("/api/launch-plans") || path.startsWith("/api/launch-presets")) return "launch:manage";
  if (path.startsWith("/api/accounts")) return "accounts:manage";
  return method === "DELETE" ? "system:control" : null;
}

function readCookie(
  header: string | undefined,
  name: string,
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function setSessionCookie(
  reply: FastifyReply,
  name: string,
  token: string,
  secure: boolean,
  maxAgeSeconds: number,
): void {
  reply.header(
    "set-cookie",
    `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=${maxAgeSeconds}`,
  );
}

function clearSessionCookie(
  reply: FastifyReply,
  name: string,
  secure: boolean,
): void {
  reply.header(
    "set-cookie",
    `${name}=; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=0`,
  );
}
