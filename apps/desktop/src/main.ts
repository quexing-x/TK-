import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { createApp } from "@tk-auto/api";
import { WindowsDpapiCredentialVault } from "@tk-auto/credentials";
import {
  AutomationStore,
  applyPendingDatabaseRestore,
  finalizePendingDatabaseRestore,
  rollbackPendingDatabaseRestore,
} from "@tk-auto/storage";
import {
  BrowserWindow,
  app,
  dialog,
} from "electron";
import { installOutboundProxy, resolveOutboundProxy } from "../../api/src/proxy.ts";
import { SignedUpdateRuntime } from "./update-runtime.js";

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

  const databasePath = join(dataDirectory, "tk-automation.db");
  let pendingRestore: ReturnType<typeof applyPendingDatabaseRestore> = null;
  try {
    pendingRestore = applyPendingDatabaseRestore(databasePath);
  } catch (cause) {
    console.error("Database restore was rejected; continuing with the original database.", cause);
  }
  let store: AutomationStore;
  try {
    store = new AutomationStore(databasePath, { appVersion: app.getVersion() });
    if (pendingRestore) {
      if (pendingRestore.rollbackPath) {
        store.registerRestoreRollbackBackup(pendingRestore.rollbackPath);
      }
      finalizePendingDatabaseRestore(pendingRestore);
    }
  } catch (cause) {
    if (!pendingRestore) throw cause;
    rollbackPendingDatabaseRestore(pendingRestore);
    store = new AutomationStore(databasePath, { appVersion: app.getVersion() });
    if (pendingRestore.rollbackPath) {
      store.registerRestoreRollbackBackup(pendingRestore.rollbackPath);
    }
  }
  store.seed();
  const vault = new WindowsDpapiCredentialVault(credentialDirectory);
  const proxyConfig = resolveOutboundProxy();
  const proxyAgent = installOutboundProxy(proxyConfig);
  const updateRuntime = new SignedUpdateRuntime({
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    currentExecutable: process.execPath,
    downloadDirectory: join(dataDirectory, "updates"),
    ...(process.env.TK_AUTO_UPDATE_MANIFEST_URL
      ? { manifestUrl: process.env.TK_AUTO_UPDATE_MANIFEST_URL }
      : {}),
    ...(process.env.TK_AUTO_UPDATE_PUBLIC_KEY
      ? { publicKey: process.env.TK_AUTO_UPDATE_PUBLIC_KEY }
      : {}),
    ...(process.env.TK_SIGNING_PUBLISHER
      ? { expectedPublisher: process.env.TK_SIGNING_PUBLISHER }
      : {}),
    install: (installerPath) => {
      const child = spawn(installerPath, [], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.unref();
      app.quit();
    },
  });
  const server = await createApp({
    store,
    vault,
    startScheduler: true,
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    maintenanceUpdates: updateRuntime,
  });

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
  if (updateRuntime.isConfigured()) {
    void updateRuntime.checkForUpdates().catch((cause) => {
      server.log.warn({ cause }, "Signed update check failed");
    });
  }
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
