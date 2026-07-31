import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AutomationStore } from "@tk-auto/storage";
import { WindowsDpapiCredentialVault } from "@tk-auto/credentials";
import { createApp } from "./app.js";
import { installOutboundProxy, resolveOutboundProxy, startOutboundProxyWatcher } from "./proxy.js";

const packageDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const databasePath =
  process.env.TK_AUTO_DB_PATH ??
  resolve(packageDirectory, "../../../data/tk-automation.db");
const credentialDirectory = process.env.TK_AUTO_CREDENTIAL_DIR
  ? resolve(process.env.TK_AUTO_CREDENTIAL_DIR)
  : resolve(packageDirectory, "../../../data/credentials");
const host = process.env.TK_AUTO_HOST ?? "127.0.0.1";
const port = Number(process.env.TK_AUTO_API_PORT ?? 3100);
const secureCookies = process.env.TK_AUTO_SECURE_COOKIES === "true";

const store = new AutomationStore(databasePath);
store.seed();
const vault = new WindowsDpapiCredentialVault(credentialDirectory);
const proxyConfig = resolveOutboundProxy();
const proxyAgent = installOutboundProxy(proxyConfig);

const app = await createApp({
  store,
  vault,
  startScheduler: true,
  secureCookies,
});
if (proxyConfig) {
  app.log.info(
    { source: proxyConfig.source },
    "Outbound HTTPS proxy enabled",
  );
}

// 出站代理不能只在启动时解析一次：后台调度器开机自启，常比 VPN / 代理客户端先
// 起来，那一刻解析到的结果（直连，或指向尚未监听的端口）会冻结整个进程生命周期。
const proxyWatcher = startOutboundProxyWatcher({
  initial: proxyConfig,
  onChange: (next, previous) => {
    app.log.warn(
      { from: previous?.source ?? "direct", to: next?.source ?? "direct" },
      next
        ? "Outbound proxy changed; switched global dispatcher"
        : "Outbound proxy removed; switched back to direct connections",
    );
  },
});

const shutdown = async () => {
  proxyWatcher.stop();
  await app.close();
  await proxyAgent?.close();
  store.close();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ host, port });
