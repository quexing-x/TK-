import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AutomationStore } from "@tk-auto/storage";
import { WindowsDpapiCredentialVault } from "@tk-auto/credentials";
import { createApp } from "./app.js";
import { installOutboundProxy, resolveOutboundProxy } from "./proxy.js";

const packageDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const databasePath =
  process.env.TK_AUTO_DB_PATH ??
  resolve(packageDirectory, "../../../data/tk-automation.db");
const credentialDirectory = resolve(
  packageDirectory,
  "../../../data/credentials",
);
const host = process.env.TK_AUTO_HOST ?? "127.0.0.1";
const port = Number(process.env.TK_AUTO_API_PORT ?? 3100);

const store = new AutomationStore(databasePath);
store.seed();
const vault = new WindowsDpapiCredentialVault(credentialDirectory);
const proxyConfig = resolveOutboundProxy();
const proxyAgent = installOutboundProxy(proxyConfig);

const app = await createApp({ store, vault, startScheduler: true });
if (proxyConfig) {
  app.log.info(
    { source: proxyConfig.source },
    "Outbound HTTPS proxy enabled",
  );
}

const shutdown = async () => {
  await app.close();
  await proxyAgent?.close();
  store.close();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ host, port });
