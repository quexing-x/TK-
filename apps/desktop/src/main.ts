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
  Menu,
  nativeImage,
  Notification,
  Tray,
} from "electron";
import { installOutboundProxy, resolveOutboundProxy } from "../../api/src/proxy.ts";
import {
  BACKGROUND_PROGRAM_NAME,
  schedulerLaunchCommand,
  schedulerOrigin,
  schedulerProgramPath,
} from "./background-program.js";
import { setBackgroundStartup } from "./background-startup.js";
import { migrateLegacyRuntimeData, resolveDesktopRuntimePaths } from "./runtime-paths.js";
import { SignedUpdateRuntime } from "./update-runtime.js";

const PRODUCT_NAME = "TK Ads Automation";
const HOST = "127.0.0.1";
const isSchedulerProcess = process.argv.includes("--scheduler");
const isSmokeTest = process.argv.includes("--smoke-test");
const clientSessionProcessId = Number(process.argv.find((argument) => argument.startsWith("--client-session="))?.split("=", 2)[1]);
const legacyUserDataDirectory = join(app.getPath("appData"), PRODUCT_NAME);

app.setPath("userData", join(app.getPath("documents"), PRODUCT_NAME));
app.setName(isSchedulerProcess ? BACKGROUND_PROGRAM_NAME : PRODUCT_NAME);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: Awaited<ReturnType<typeof startRuntime>> | null = null;
let clientQuitRequested = false;
let shutdownStarted = false;

const hasSingleInstanceLock = isSchedulerProcess || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else if (isSchedulerProcess) {
  void app.whenReady().then(startSchedulerProcess).catch(showStartupFailure);
} else {
  app.on("second-instance", () => showClientWindow());
  void app.whenReady().then(startClientProcess).catch(showStartupFailure);
}

async function startSchedulerProcess(): Promise<void> {
  runtime = await startRuntime(schedulerOrigin());
  const enabled = runtime.store.getSystemRuntimeState().enabled;
  await setBackgroundStartup(backgroundExecutablePath(), enabled);
  if (!enabled && Number.isInteger(clientSessionProcessId) && clientSessionProcessId > 0) {
    stopWhenClientSessionEnds(clientSessionProcessId, runtime.store);
  }
  if (isSmokeTest) {
    const response = await fetch(`${runtime.origin}/api/health`);
    if (!response.ok) throw new Error(`后台程序健康检查失败（HTTP ${response.status}）。`);
    shutdownStarted = true;
    await stopRuntime(runtime);
    app.exit(0);
  }
}

async function startClientProcess(): Promise<void> {
  const origin = await ensureSchedulerRunning();
  mainWindow = createWindow(origin);
  tray = createTray();
}

async function ensureSchedulerRunning(): Promise<string> {
  const origin = schedulerOrigin();
  if (await isSchedulerHealthy(origin)) return origin;
  const command = schedulerLaunchCommand(backgroundExecutablePath());
  const args = app.isPackaged
    ? [...command.args, `--client-session=${process.pid}`]
    : [...process.argv.slice(1).filter((argument) => argument !== "--scheduler" && !argument.startsWith("--client-session=")), ...command.args, `--client-session=${process.pid}`];
  const child = spawn(command.command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    if (await isSchedulerHealthy(origin)) return origin;
  }
  throw new Error("tk自动化后台程序未能启动，请检查是否被安全软件阻止。");
}

async function isSchedulerHealthy(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function backgroundExecutablePath(): string {
  return schedulerProgramPath({
    packaged: app.isPackaged,
    executablePath: process.execPath,
    appPath: app.getAppPath(),
  });
}

async function startRuntime(origin: string) {
  const paths = resolveDesktopRuntimePaths({
    downloadsDirectory: app.getPath("downloads"),
    legacyUserDataDirectory,
    userDataDirectory: app.getPath("userData"),
  });
  const migrated = migrateLegacyRuntimeData(paths);
  if (migrated) console.log("Migrated local data from the legacy AppData directory.");
  const { dataDirectory } = paths;
  const credentialDirectory = join(dataDirectory, "credentials");
  mkdirSync(dataDirectory, { recursive: true });

  const databasePath = join(dataDirectory, "tk-automation.db");
  let pendingRestore: ReturnType<typeof applyPendingDatabaseRestore> = null;
  try { pendingRestore = applyPendingDatabaseRestore(databasePath); } catch (cause) { console.error("Database restore was rejected; continuing with the original database.", cause); }
  let store: AutomationStore;
  try {
    store = new AutomationStore(databasePath, { appVersion: app.getVersion() });
    if (pendingRestore) {
      if (pendingRestore.rollbackPath) store.registerRestoreRollbackBackup(pendingRestore.rollbackPath);
      finalizePendingDatabaseRestore(pendingRestore);
    }
  } catch (cause) {
    if (!pendingRestore) throw cause;
    rollbackPendingDatabaseRestore(pendingRestore);
    store = new AutomationStore(databasePath, { appVersion: app.getVersion() });
    if (pendingRestore.rollbackPath) store.registerRestoreRollbackBackup(pendingRestore.rollbackPath);
  }
  store.seed();
  const vault = new WindowsDpapiCredentialVault(credentialDirectory);
  const proxyConfig = resolveOutboundProxy();
  const proxyAgent = installOutboundProxy(proxyConfig);
  const updateRuntime = new SignedUpdateRuntime({
    currentVersion: app.getVersion(), packaged: app.isPackaged, currentExecutable: process.execPath,
    downloadDirectory: paths.downloadDirectory,
    ...(process.env.TK_AUTO_UPDATE_MANIFEST_URL ? { manifestUrl: process.env.TK_AUTO_UPDATE_MANIFEST_URL } : {}),
    ...(process.env.TK_AUTO_UPDATE_PUBLIC_KEY ? { publicKey: process.env.TK_AUTO_UPDATE_PUBLIC_KEY } : {}),
    ...(process.env.TK_SIGNING_PUBLISHER ? { expectedPublisher: process.env.TK_SIGNING_PUBLISHER } : {}),
    install: (installerPath) => { const child = spawn(installerPath, [], { detached: true, stdio: "ignore", windowsHide: false }); child.unref(); app.quit(); },
  });
  const server = await createApp({
    store, vault, startScheduler: true, appVersion: app.getVersion(), packaged: app.isPackaged,
    maintenanceUpdates: updateRuntime,
    onSystemRuntimeChanged: async (enabled) => {
      if (!isSchedulerProcess) return;
      await setBackgroundStartup(backgroundExecutablePath(), enabled);
      if (!enabled) setTimeout(() => app.quit(), 250);
    },
  });
  const webRoot = app.isPackaged ? join(process.resourcesPath, "web") : resolve(__dirname, "../../web/dist");
  await server.register(fastifyStatic, { root: webRoot, index: ["index.html"] });
  if (proxyConfig) server.log.info({ source: proxyConfig.source }, "Outbound HTTPS proxy enabled");
  await server.listen({ host: HOST, port: Number(new URL(origin).port) });
  if (updateRuntime.isConfigured()) void updateRuntime.checkForUpdates().catch((cause) => server.log.warn({ cause }, "Signed update check failed"));
  return { server, store, proxyAgent, origin };
}

function createWindow(origin: string): BrowserWindow {
  const window = new BrowserWindow({ title: PRODUCT_NAME, width: 1440, height: 960, minWidth: 1100, minHeight: 720, show: false, autoHideMenuBar: true, backgroundColor: "#f5f7fb", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const allowedOrigin = new URL(origin).origin;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (new URL(url).origin !== allowedOrigin) event.preventDefault(); });
  window.on("close", (event) => {
    if (clientQuitRequested) return;
    event.preventDefault();
    window.hide();
    new Notification({ title: PRODUCT_NAME, body: "客户端已最小化到系统托盘；右下角托盘菜单可完全退出客户端，后台程序继续运行。" }).show();
  });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(origin);
  return window;
}

function createTray(): Tray {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), "build", "icon.ico"));
  const created = new Tray(icon);
  created.setToolTip(PRODUCT_NAME);
  created.setContextMenu(Menu.buildFromTemplate([
    { label: "显示客户端", click: showClientWindow },
    { type: "separator" },
    { label: "完全退出客户端（后台程序继续运行）", click: exitClient },
  ]));
  created.on("click", showClientWindow);
  return created;
}

function showClientWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function exitClient(): void {
  clientQuitRequested = true;
  app.quit();
}

function stopWhenClientSessionEnds(parentProcessId: number, store: AutomationStore): void {
  const timer = setInterval(() => {
    if (store.getSystemRuntimeState().enabled) {
      clearInterval(timer);
      return;
    }
    try {
      process.kill(parentProcessId, 0);
    } catch {
      clearInterval(timer);
      app.quit();
    }
  }, 2_000);
  timer.unref();
}

async function stopRuntime(activeRuntime: NonNullable<typeof runtime>) {
  await activeRuntime.server.close();
  await activeRuntime.proxyAgent?.close();
  activeRuntime.store.close();
  runtime = null;
}

function showStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : "未知启动错误";
  dialog.showErrorBox(isSchedulerProcess ? BACKGROUND_PROGRAM_NAME : PRODUCT_NAME, `本地服务启动失败：${message}`);
  app.quit();
}
