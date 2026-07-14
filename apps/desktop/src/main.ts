import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { createApp } from "@tk-auto/api";
import { WindowsDpapiCredentialVault } from "@tk-auto/credentials";
import { AutomationStore } from "@tk-auto/storage";
import {
  BrowserWindow,
  app,
  dialog,
} from "electron";
import { installOutboundProxy, resolveOutboundProxy } from "../../api/src/proxy.ts";

const PRODUCT_NAME = "TK Ads Automation";
const HOST = "127.0.0.1";
const isSmokeTest = process.argv.includes("--smoke-test");

let mainWindow: BrowserWindow | null = null;
let runtime: Awaited<ReturnType<typeof startRuntime>> | null = null;
let shutdownStarted = false;

app.setName(PRODUCT_NAME);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("before-quit", (event) => {
    if (shutdownStarted || !runtime) return;
    event.preventDefault();
    shutdownStarted = true;
    void stopRuntime(runtime).finally(() => app.quit());
  });

  app.on("window-all-closed", () => app.quit());

  void app.whenReady().then(async () => {
    try {
      runtime = await startRuntime();
      if (isSmokeTest) {
        const response = await fetch(`${runtime.origin}/api/health`);
        if (!response.ok) throw new Error(`健康检查失败（HTTP ${response.status}）`);
        console.log("Desktop smoke test passed.");
        shutdownStarted = true;
        await stopRuntime(runtime);
        app.exit(0);
        return;
      }
      mainWindow = createWindow(runtime.origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知启动错误";
      dialog.showErrorBox(PRODUCT_NAME, `本地服务启动失败：${message}`);
      app.quit();
    }
  });
}

async function startRuntime() {
  const dataDirectory = join(app.getPath("userData"), "data");
  const credentialDirectory = join(dataDirectory, "credentials");
  mkdirSync(dataDirectory, { recursive: true });

  const store = new AutomationStore(join(dataDirectory, "tk-automation.db"));
  store.seed();
  const vault = new WindowsDpapiCredentialVault(credentialDirectory);
  const proxyConfig = resolveOutboundProxy();
  const proxyAgent = installOutboundProxy(proxyConfig);
  const server = await createApp({ store, vault, startScheduler: true });

  const webRoot = app.isPackaged
    ? join(process.resourcesPath, "web")
    : resolve(__dirname, "../../web/dist");
  await server.register(fastifyStatic, {
    root: webRoot,
    index: ["index.html"],
  });

  if (proxyConfig) {
    server.log.info(
      { source: proxyConfig.source },
      "Outbound HTTPS proxy enabled",
    );
  }

  const origin = await server.listen({ host: HOST, port: 0 });
  return { server, store, proxyAgent, origin };
}

function createWindow(origin: string): BrowserWindow {
  const window = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f5f7fb",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const allowedOrigin = new URL(origin).origin;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== allowedOrigin) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(origin);
  return window;
}

async function stopRuntime(activeRuntime: NonNullable<typeof runtime>) {
  await activeRuntime.server.close();
  await activeRuntime.proxyAgent?.close();
  activeRuntime.store.close();
  runtime = null;
}
