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
  RuleConfigurationInputSchema,
  SyncEntityTypeSchema,
  IgnoreEntityInputSchema,
  ManualStatusInputSchema,
  NotificationChannelKindSchema,
  NotificationChannelSettingsSchema,
  NotificationCredentialInputSchema,
  InitialDeveloperInputSchema,
  LocalUserCreateInputSchema,
  LocalUserUpdateInputSchema,
  LoginInputSchema,
  PasswordChangeInputSchema,
  SystemRuntimeUpdateSchema,
  OneTimeScheduleInputSchema,
  OvernightScheduleInputSchema,
  AutomationFeatureSettingsInputSchema,
  MultiAccountLaunchPlanInputSchema,
  LaunchCopyPreviewInputSchema,
  LaunchPresetInputSchema,
  LaunchManualVerificationInputSchema,
  getCreationTemplateReadiness,
  StatusManualVerificationInputSchema,
  WriteTaskStatusSchema,
  AuditLogFilterSchema,
  type AppPermission,
  type ProviderKind,
  type WriteTaskActor,
} from "@tk-auto/core";
import type { CredentialVault } from "@tk-auto/credentials";
import {
  parseTikTokCurl,
  parseTikTokReadCurl,
  parseTikTokStatusCurl,
  getTikTokCookieImportReadiness,
  ProviderRegistry,
  TikTokCurlImportError,
  type ProviderContext,
} from "@tk-auto/providers";
import { AutomationStore } from "@tk-auto/storage";
import {
  AutomationBusyError,
  AutomationScheduler,
  AutomationService,
} from "./automation-service.js";
import { NotificationService } from "./notification-service.js";
import { LaunchService } from "./launch-service.js";
import { LaunchWorker } from "./launch-worker.js";
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

export interface AppDependencies {
  store: AutomationStore;
  vault: CredentialVault;
  providers?: ProviderRegistry;
  automation?: AutomationService;
  notifications?: NotificationService;
  startScheduler?: boolean;
  /** Only for isolated unit tests. Production authentication is always enabled. */
  disableAuth?: boolean;
  /** Enable only when the application is reached through HTTPS. */
  secureCookies?: boolean;
  appVersion?: string;
  packaged?: boolean;
  maintenanceUpdates?: MaintenanceUpdateRuntime;
  /** Desktop-only lifecycle bridge for the separately hosted scheduler. */
  onSystemRuntimeChanged?: (enabled: boolean) => void | Promise<void>;
}

export async function createApp(
  dependencies: AppDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const providers = dependencies.providers ?? new ProviderRegistry();
  const launchService = new LaunchService(
    dependencies.store,
    dependencies.vault,
    providers,
  );
  const launchWorker = new LaunchWorker(dependencies.store, launchService);
  launchWorker.start();
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
  const auth = new AuthService(dependencies.store);
  const maintenanceUpdates = dependencies.maintenanceUpdates
    ?? unavailableMaintenanceUpdateRuntime(dependencies.appVersion);
  const scheduler = new AutomationScheduler(
    dependencies.store,
    automation,
    notifications,
  );
  if (dependencies.startScheduler) scheduler.start();
  app.addHook("onClose", async () => {
    await launchWorker.stop();
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
    const token = readCookie(request.headers.cookie, authCookie.name);
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
    if (
      !dependencies.store.getSystemRuntimeState().enabled &&
      isRuntimeOperation(request.method, request.url)
    ) {
      return reply.status(423).send({
        error: "SYSTEM_PAUSED",
        message: "软件总开关已关闭，后台检测和广告操作均已暂停。",
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
    setSessionCookie(reply, session.token, dependencies.secureCookies ?? false);
    return reply.status(201).send(auth.status(session));
  });

  app.post("/api/auth/login", async (request, reply) => {
    const session = await auth.login(LoginInputSchema.parse(request.body), request.ip);
    setSessionCookie(reply, session.token, dependencies.secureCookies ?? false);
    return auth.status(session);
  });

  app.post("/api/auth/recover", async (request, reply) => {
    LocalAccessResetSchema.parse(request.body);
    auth.resetLocalAccess();
    clearSessionCookie(reply, dependencies.secureCookies ?? false);
    return auth.status(null);
  });

  app.post("/api/auth/logout", async (request, reply) => {
    auth.logout(request.authSession);
    clearSessionCookie(reply, dependencies.secureCookies ?? false);
    return { ok: true };
  });

  app.put("/api/auth/password", async (request, reply) => {
    if (!request.authSession) return reply.status(401).send();
    await auth.changePassword(
      request.authSession.user,
      PasswordChangeInputSchema.parse(request.body),
    );
    clearSessionCookie(reply, dependencies.secureCookies ?? false);
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

  app.get("/api/launch-plans/:planId/items/:itemId/verifications", async (request, reply) => {
    const { planId, itemId } = z.object({
      planId: z.string().min(1),
      itemId: z.string().min(1),
    }).parse(request.params);
    const item = dependencies.store.listLaunchPlanItems(planId).find((candidate) => candidate.itemId === itemId);
    if (!item) return reply.status(404).send({ message: "创建任务不存在。" });
    return dependencies.store.listLaunchPlanItemVerifications(itemId);
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
      const user = request.authSession?.user;
      return reply.status(201).send(
        dependencies.store.createMultiAccountLaunchPlan(
          MultiAccountLaunchPlanInputSchema.parse(request.body),
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
      return reply.status(201).send(
        dependencies.store.createLaunchCopyPreview(
          LaunchCopyPreviewInputSchema.parse(request.body),
        ),
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
    try {
      const results = await launchService.copyAdGroupWithinAccount({ accountId, ...input });
      return reply.send({ results });
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
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
    try {
      const result = await launchService.batchExpandAdGroups(input);
      return reply.send(result);
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  app.post("/api/launch-plans/:planId/execute", async (request, reply) => {
    const { planId } = z.object({ planId: z.string().min(1) }).parse(request.params);
    const plan = dependencies.store.getMultiAccountLaunchPlan(planId);
    if (!plan) {
      return reply.status(404).send({ message: "投放计划不存在。" });
    }
    const hasDispatchableItems = dependencies.store
      .listLaunchPlanItems(planId)
      .some((item) => item.status === "pending");
    if (hasDispatchableItems && !dependencies.store.getSystemRuntimeState().enabled) {
      return reply.status(409).send({ message: "软件总开关已关闭，批量创建写入已暂停。请重新开启后再立即执行。" });
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
    const { planId } = z.object({ planId: z.string().min(1) }).parse(request.params);
    const plan = dependencies.store.getMultiAccountLaunchPlan(planId);
    if (!plan) {
      return reply.status(404).send({ message: "投放计划不存在。" });
    }
    if (!dependencies.store.getSystemRuntimeState().enabled) {
      return reply.status(409).send({ message: "软件总开关已关闭，批量创建写入已暂停。请重新开启后再次确认并加入队列。" });
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
    try {
      const user = request.authSession?.user;
      return await launchService.retryItem(planId, itemId, user
        ? { id: user.id, name: user.username, kind: "user" }
        : { id: "local-user", name: "本地用户", kind: "user" });
    } catch (cause) {
      return reply.status(409).send({ message: getSafeProviderError(cause) });
    }
  });

  app.post("/api/launch-plans/:planId/items/:itemId/verify", async (request, reply) => {
    const { planId, itemId } = z.object({
      planId: z.string().min(1),
      itemId: z.string().min(1),
    }).parse(request.params);
    const item = dependencies.store.listLaunchPlanItems(planId).find((candidate) => candidate.itemId === itemId);
    if (!item) return reply.status(404).send({ message: "创建任务不存在。" });
    const actor = request.authSession?.user ?? {
      id: "isolated-test",
      username: "isolated-test",
    };
    try {
      const verification = dependencies.store.verifyUnknownLaunchPlanItem(
        itemId,
        LaunchManualVerificationInputSchema.parse(request.body),
        { id: actor.id, name: actor.username },
      );
      return {
        verification,
        item: dependencies.store.listLaunchPlanItems(planId).find((candidate) => candidate.itemId === itemId),
        plan: dependencies.store.refreshLaunchPlanResult(planId),
      };
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
    const account = dependencies.store.updateAccountSettings(accountId, body);
    if (!account) return reply.status(404).send({ message: "账号不存在。" });
    return account;
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
      if (settings.kind !== providerKind) {
        return reply.status(400).send({ message: "Provider 类型不一致。" });
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
      const credential = ProviderCredentialInputSchema.parse(request.body);
      if (credential.kind !== providerKind) {
        return reply.status(400).send({ message: "凭据类型不一致。" });
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
      if (!dependencies.store.getAccount(accountId)) {
        return reply.status(404).send({ message: "账号不存在。" });
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
    return dependencies.store.listManagedEntities(
      accountId,
      account.providerKind,
    );
  });

  app.post(
    "/api/accounts/:accountId/entities/status",
    async (request, reply) => {
      const { accountId } = AccountParamsSchema.parse(request.params);
      if (!dependencies.store.getAccount(accountId)) {
        return reply.status(404).send({ message: "账号不存在。" });
      }
      const body = ManualStatusInputSchema.parse(request.body);
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
      if (!dependencies.store.getAccount(accountId)) {
        return reply.status(404).send({ message: "账号不存在。" });
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

  app.get(
    "/api/accounts/:accountId/ad-operations",
    async (request, reply) => {
      const { accountId } = AccountParamsSchema.parse(request.params);
      if (!dependencies.store.getAccount(accountId)) {
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
      if (!dependencies.store.getAccount(accountId)) {
        return reply.status(404).send({ message: "账号不存在。" });
      }
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
      if (!dependencies.store.getAccount(accountId)) {
        return reply.status(404).send({ message: "账号不存在。" });
      }
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

  app.post(
    "/api/accounts/:accountId/connections/:providerKind/test",
    async (request, reply) => {
      const { accountId, providerKind } = ProviderParamsSchema.parse(
        request.params,
      );
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
  if (!connection || !connection.credentialRef) {
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
  return cause.name === "TimeoutError" ? "连接检测超时。" : cause.message;
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
  return (
    path.endsWith("/automation/run") ||
    path.endsWith("/entities/status") ||
    path.endsWith("/sync") ||
    path.endsWith("/test")
  );
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
  if (path.startsWith("/api/system/")) return "system:control";
  if (
    path === "/api/rules" ||
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
  token: string,
  secure: boolean,
): void {
  reply.header(
    "set-cookie",
    `${authCookie.name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=${authCookie.maxAgeSeconds}`,
  );
}

function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.header(
    "set-cookie",
    `${authCookie.name}=; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=0`,
  );
}
