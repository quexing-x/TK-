import Fastify, { type FastifyInstance } from "fastify";
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
  AppealQueueInputSchema,
  type ProviderKind,
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

const AccountParamsSchema = z.object({ accountId: z.string().min(1) });
const ProviderParamsSchema = AccountParamsSchema.extend({
  providerKind: ProviderKindSchema,
});
const CurlImportBodySchema = z.object({
  command: z.string().min(1).max(262_144),
  step: z.enum(["read", "status"]).optional(),
});
const EntityParamsSchema = AccountParamsSchema.extend({
  entityType: SyncEntityTypeSchema,
  externalId: z.string().min(1).max(128),
});
const AnalyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  entityType: SyncEntityTypeSchema.optional(),
});

export interface AppDependencies {
  store: AutomationStore;
  vault: CredentialVault;
  providers?: ProviderRegistry;
  automation?: AutomationService;
  startScheduler?: boolean;
}

export async function createApp(
  dependencies: AppDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const providers = dependencies.providers ?? new ProviderRegistry();
  const automation =
    dependencies.automation ??
    new AutomationService(dependencies.store, dependencies.vault, providers);
  const scheduler = new AutomationScheduler(dependencies.store, automation);
  if (dependencies.startScheduler) scheduler.start();
  app.addHook("onClose", async () => scheduler.stop());

  await app.register(cors, {
    origin: [/^http:\/\/127\.0\.0\.1(?::\d+)?$/],
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

  app.get("/api/bootstrap", async () => ({
    accounts: dependencies.store.listAccounts(),
    globalAutomationSettings:
      dependencies.store.getGlobalAutomationSettings(),
    providers: providers.list(),
  }));

  app.put("/api/automation/settings", async (request) => {
    const body = GlobalAutomationSettingsInputSchema.parse(request.body);
    return dependencies.store.updateGlobalAutomationSettings(body);
  });

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
              const discardStaleAutoExpandedAd = [
                "ad-group",
                "ad-group-status",
              ].includes(imported.summary.target);
              credential = CookieCredentialInputSchema.parse({
                ...credential,
                csrfToken:
                  credential.csrfToken ?? parsedPrevious.csrfToken,
                csrfHeaderName: credential.csrfToken
                  ? credential.csrfHeaderName
                  : parsedPrevious.csrfHeaderName,
                userAgent: credential.userAgent ?? parsedPrevious.userAgent,
                requestTemplates: [
                  ...(parsedPrevious.requestTemplates ?? []).filter(
                    (item) =>
                      !incomingKeys.has(`${item.target}:${item.action ?? ""}`) &&
                      !(
                        discardStaleAutoExpandedAd &&
                        item.derived &&
                        ["ad", "ad-status"].includes(item.target)
                      ),
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

      try {
        const context = await loadProviderContext(
          dependencies.store,
          dependencies.vault,
          accountId,
          "cookie",
        );
        const health = await providers.checkHealth("cookie", context);
        return dependencies.store.updateProviderStatus(
          accountId,
          "cookie",
          health.status,
          `${importMessage} ${imported.summary.method} ${imported.summary.path} ${health.message}`,
        );
      } catch (cause) {
        return dependencies.store.updateProviderStatus(
          accountId,
          "cookie",
          "failed",
          `${importMessage} 请求已加密保存，但连接检测失败：${getSafeProviderError(cause)}`,
        );
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
      return automation.changeStatusManually(accountId, body);
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

  app.post(
    "/api/accounts/:accountId/appeals",
    async (request, reply) => {
      const { accountId } = AccountParamsSchema.parse(request.params);
      const account = dependencies.store.getAccount(accountId);
      if (!account) return reply.status(404).send({ message: "账号不存在。" });
      const body = AppealQueueInputSchema.parse(request.body);
      return reply.status(201).send(
        dependencies.store.queueAppeal(
          accountId,
          account.providerKind,
          body.externalId,
          body.reason,
        ),
      );
    },
  );

  app.get("/api/accounts/:accountId/analytics", async (request, reply) => {
    const { accountId } = AccountParamsSchema.parse(request.params);
    const account = dependencies.store.getAccount(accountId);
    if (!account) return reply.status(404).send({ message: "账号不存在。" });
    const query = AnalyticsQuerySchema.parse(request.query);
    const since = new Date(Date.now() - query.days * 24 * 60 * 60_000).toISOString();
    return dependencies.store.listMetricSnapshots(
      accountId,
      account.providerKind,
      since,
      query.entityType,
    );
  });

  app.post(
    "/api/accounts/:accountId/connections/:providerKind/test",
    async (request) => {
      const { accountId, providerKind } = ProviderParamsSchema.parse(
        request.params,
      );
      try {
        const context = await loadProviderContext(
          dependencies.store,
          dependencies.vault,
          accountId,
          providerKind,
        );
        const health = await providers.checkHealth(providerKind, context);
        return dependencies.store.updateProviderStatus(
          accountId,
          providerKind,
          health.status,
          health.message,
        );
      } catch (cause) {
        return dependencies.store.updateProviderStatus(
          accountId,
          providerKind,
          "failed",
          getSafeProviderError(cause),
        );
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
      const context = await loadProviderContext(
        dependencies.store,
        dependencies.vault,
        accountId,
        providerKind,
      );
      const output = await providers.syncReadOnly(providerKind, context);
      dependencies.store.saveReadOnlySync(
        accountId,
        providerKind,
        output.entities,
        output.result,
      );
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
