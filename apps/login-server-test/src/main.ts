import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { createApp } from "@tk-auto/api";
import { WindowsDpapiCredentialVault } from "@tk-auto/credentials";
import { AutomationStore } from "@tk-auto/storage";
import type { FastifyInstance } from "fastify";
import { bootstrapLoginTestAccounts } from "./bootstrap.js";

const LOOPBACK_HOST = "0.0.0.0";
const port = numberFromEnvironment("TK_AUTO_LOGIN_TEST_PORT", 3180);
const root = resolve(__dirname, "../../..");
const dataDirectory = resolve(
  process.env.TK_AUTO_LOGIN_TEST_DATA_DIR ?? resolve(root, "data/login-server-test"),
);
const databasePath = resolve(dataDirectory, "tk-automation-login-test.db");
const credentialDirectory = resolve(dataDirectory, "credentials");
const webRoot = resolve(process.env.TK_AUTO_WEB_ROOT ?? resolve(root, "apps/web/dist"));

void start().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function start(): Promise<void> {
  let store: AutomationStore | null = null;
  let app: FastifyInstance | null = null;
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await app?.close();
    } finally {
      store?.close();
      app = null;
      store = null;
    }
  };

  try {
    mkdirSync(dataDirectory, { recursive: true });
    store = new AutomationStore(databasePath);
    store.seed();
    const bootstrap = await bootstrapLoginTestAccounts(store, process.env);
    const vault = new WindowsDpapiCredentialVault(credentialDirectory);
    app = await createApp({
      store,
      vault,
      startScheduler: true,
      secureCookies: process.env.TK_AUTO_LOGIN_TEST_SECURE_COOKIES === "true",
    });

    await app.register(fastifyStatic, {
      root: webRoot,
      index: ["index.html"],
    });
    await app.listen({ host: LOOPBACK_HOST, port });
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    app.log.info(
      {
        mode: "login-test",
        origin: `http://${LOOPBACK_HOST}:${port}`,
        users: bootstrap.totalUsers,
        scheduler: true,
        automationEnabled: false,
      },
      "Isolated multi-user functional test server ready",
    );
  } catch (error) {
    await shutdown();
    throw error;
  }
}

function numberFromEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
    throw new Error(`${name} 必须是 1024 至 65535 之间的整数。`);
  }
  return value;
}
