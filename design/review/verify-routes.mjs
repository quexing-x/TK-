// Browser-only visual route audit. Uses in-page API fixtures and never reaches
// the local API or any external platform. This is intentionally separate from
// production code and is safe to run against the Vite preview server.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const output = dirname(fileURLToPath(import.meta.url));
const profile = await mkdtemp(join(tmpdir(), "tk-route-review-"));
const port = 9242;
const browser = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = new Date().toISOString();
const accounts = [
  { id: "route-account-001", displayName: "东南亚 · 美妆主账户", platform: "tiktok", accountType: "agency", enabled: true, providerKind: "cookie", timezone: "Asia/Shanghai", pollIntervalSeconds: 30, maxActionsPerCycle: 5, updatedAt: now },
  { id: "route-account-002", displayName: "泰国 · 家居日用", platform: "tiktok", accountType: "standard", enabled: false, providerKind: "cookie", timezone: "Asia/Shanghai", pollIntervalSeconds: 30, maxActionsPerCycle: 5, updatedAt: now },
  { id: "route-account-003", displayName: "新加坡 · 再营销", platform: "meta", accountType: "standard", enabled: false, providerKind: "meta-marketing-api", timezone: "Asia/Shanghai", pollIntervalSeconds: 30, maxActionsPerCycle: 5, updatedAt: now },
];
const capabilities = ["read-campaigns", "read-ad-groups", "read-ads", "change-status", "create-campaigns", "copy-ads"];
const connectionFor = (account) => ({ accountId: account.id, kind: account.providerKind, settings: { kind: account.providerKind, advertiserId: account.id, liveMode: "automation-status" }, hasCredential: true, status: "ready", authorizationStatus: "active", capabilityVersion: "route-review-v1", lastMessage: null, lastTestedAt: now, updatedAt: now });
const stateFor = (account) => ({ accountId: account.id, connection: connectionFor(account), latestSync: { startedAt: now, finishedAt: now, counts: { campaign: 8, "ad-group": 16, ad: 32, material: 0 }, warnings: [], quality: { status: "healthy", completeEntityTypes: ["campaign", "ad-group", "ad"], partialFailures: [], lastHealthyAt: now } }, capabilities: { accountId: account.id, providerKind: account.providerKind, providerDisplayName: account.platform === "meta" ? "Meta Marketing API" : "TikTok Cookie", authorizationStatus: "active", capabilityVersion: "route-review-v1", capabilities: capabilities.map((capability) => ({ capability, available: true, reason: null })) } });
const bootstrap = { accounts, accountConnectionStates: accounts.map(stateFor), globalAutomationSettings: { pollingIntervalMinutes: 15, maxActionsPerRun: 20 }, systemRuntime: { enabled: false }, providers: [] };
const rules = { layers: { campaign: true, adGroup: true, ad: true }, rules: [], updatedAt: now };
const features = { appeal: { enabled: true, textTemplate: "请复核广告：{ad_name}", scheduleHours: [9], retryLimit: 1 }, copy: { autoCopyEnabled: false, autoCopyMinConversions: 3, autoCopyMaxCpa: 100, autoCopyMaxCpc: 10, autoCopyCount: 2, autoCopyBudget: null, autoCopyBid: null, autoCopyDailyAccountLimit: 10, autoCopyLaunchImmediately: true, autoCopySameCampaign: true }, deletion: { enabled: false, onlyDisabled: true, scheduleHour: 6, retainOnePerCampaign: true }, dailyEnable: { enabled: false, scheduleHour: 8 }, budgetBump: { enabled: false, sourceBudget: 100, targetBudget: 150, minConversions: 3, maxCpa: 100 } };
const maintenance = { appVersion: "1.4.106", schemaVersion: "2026-08-22", pendingRestore: false, update: { configured: false, state: "not-configured", availableVersion: null, signatureStatus: "not-packaged", message: null } };

function fixtureScript() {
  const serialized = JSON.stringify({ accounts, bootstrap, rules, features, maintenance, now });
  return `(() => {
    const fixture = ${serialized};
    const originalFetch = window.fetch.bind(window);
    const errors = [];
    window.__routeFixtureErrors = errors;
    window.addEventListener('error', (event) => errors.push(String(event.error?.stack || event.message)));
    window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason?.stack || event.reason)));
    const response = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const account = (path) => fixture.accounts.find((item) => path.includes(item.id));
    const get = (path) => {
      if (path === '/api/auth/status') return { authenticated: true, setupRequired: false, user: { id: 'route-review-user', displayName: '运营人员', role: 'developer' }, permissions: ['accounts:manage', 'rules:manage', 'system:control', 'users:manage'], csrfToken: 'route-review' };
      if (path === '/api/bootstrap') return fixture.bootstrap;
      if (path === '/api/rules') return fixture.rules;
      if (path === '/api/automation/features') return fixture.features;
      if (path === '/api/maintenance/status') return fixture.maintenance;
      if (path === '/api/notifications/channels' || path === '/api/notifications/deliveries' || path === '/api/notifications/cycles') return [];
      if (path === '/api/local-users' || path === '/api/launch-presets' || path === '/api/launch-plans' || path === '/api/launch-plans/queued' || path === '/api/write-tasks') return [];
      if (path.startsWith('/api/maintenance/audit') || path.startsWith('/api/maintenance/backups')) return [];
      if (path.endsWith('/connections')) return account(path) ? [fixture.bootstrap.accountConnectionStates.find((item) => item.accountId === account(path).id).connection] : [];
      if (path.endsWith('/connection-capabilities')) return [];
      if (path.endsWith('/capabilities')) return fixture.bootstrap.accountConnectionStates.find((item) => item.accountId === account(path)?.id)?.capabilities ?? null;
      if (path.endsWith('/cookie-readiness')) return { status: 'ready', missing: [], present: ['sessionid'] };
      if (path.includes('/rules') && path.includes('/platforms/meta')) return { rules: [], updatedAt: fixture.now };
      if (path.includes('/platforms/meta/runtime')) return { enabled: false, updatedAt: fixture.now };
      if (path.includes('/platforms/meta/access-profiles')) return [];
      if (path.endsWith('/metric-days')) return [{ date: fixture.now.slice(0, 10), count: 32, spend: 582.17, clicks: 80, conversions: 4, lastCapturedAt: fixture.now, lastLocalTime: '16:28', isCurrentDay: true }];
      if (path.endsWith('/entities') || path.endsWith('/ad-operations') || path.endsWith('/automation/runs') || path.endsWith('/automation/decisions') || path.endsWith('/schedules') || path.endsWith('/manual-takeovers') || path.endsWith('/analytics')) return [];
      if (path.includes('/launch-plans/') && path.endsWith('/items')) return [];
      if (path.includes('/expand') || path.includes('/campaign-copy') || path.includes('/copy-history') || path.includes('/stale-drafts')) return { tasks: [], candidates: [], settings: {}, conflicts: [], cleared: 0, deleted: 0, skipped: 0 };
      if (path.includes('/cleanup-candidates')) return { candidates: [], settings: { gracePeriodHours: 48, maxConversions: 0, maxCarts: 0, minCpa: 0 } };
      return [];
    };
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
      if (!url.pathname.startsWith('/api/')) return originalFetch(input, init);
      const method = String(init?.method || (typeof input === 'object' ? input.method : 'GET')).toUpperCase();
      if (method === 'GET' || method === 'HEAD') return Promise.resolve(response(get(url.pathname)));
      return Promise.resolve(response({ ok: true, account: account(url.pathname), settings: fixture.rules, updatedAt: fixture.now, status: 'ready', state: 'idle', message: 'fixture' }));
    };
  })();`;
}

let ws;
let nextId = 0;
const pending = new Map();
function send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value; }
async function until(expression) { for (let i = 0; i < 120; i += 1) { if (await evaluate(`Boolean(${expression})`)) return; await wait(100); } throw new Error(`Timeout: ${expression}`); }
async function screenshot(name) { const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); await writeFile(join(output, `${name}.png`), Buffer.from(result.data, "base64")); }

const routes = ["overview", "accounts", "automation", "ads", "analytics", "launch", "rules", "notifications", "system-users", "maintenance", "manual"];
const checks = [];
const failures = [];
const routeResults = [];
try {
  let tabs;
  for (let i = 0; i < 50; i += 1) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; } catch { await wait(100); } }
  ws = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (!message.id) return; const entry = pending.get(message.id); pending.delete(message.id); message.error ? entry?.reject(new Error(message.error.message)) : entry?.resolve(message.result); });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: fixtureScript() });
  for (const route of routes) {
    await send("Page.navigate", { url: `http://127.0.0.1:5173/#${route}` });
    await until("document.querySelector('.p-shell') && !document.querySelector('.p-loading-text')");
    await wait(200);
    const result = await evaluate(`(() => { const shell = document.querySelector('.p-shell'); const sidebar = document.querySelector('.p-sidebar'); const active = document.querySelectorAll('.p-sidebar .p-nav-item.is-active').length; const text = shell?.innerText || ''; const errors = window.__routeFixtureErrors || []; const detailHeading = document.querySelector('.task-detail-panel .panel-heading'); return { shell: Boolean(shell), sidebar: getComputedStyle(sidebar).backgroundColor, canvas: getComputedStyle(document.querySelector('.p-main')).backgroundColor, active, internalCopy: /(UI Playground|Design System|Control Rail|Demo)/i.test(text), noGlass: !detailHeading || getComputedStyle(detailHeading).backdropFilter === 'none', errors, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`);
    const routeChecks = [result.shell, result.sidebar === "rgb(17, 24, 39)", result.canvas === "rgb(238, 242, 245)", result.active === 1, !result.internalCopy, result.noGlass, !result.overflow, result.errors.length === 0];
    routeResults.push({ route, ...result, routeChecks });
    if (!routeChecks.every(Boolean)) failures.push({ route, result, routeChecks }); else checks.push(route);
    await screenshot(`route-${route}`);
  }
  await writeFile(join(output, "route-verification.json"), JSON.stringify({ dataSource: "isolated in-page API fixtures; no real account writes", routes, checks, failures, results: routeResults }, null, 2));
  if (failures.length) throw new Error(`Route audit failed: ${JSON.stringify(failures)}`);
  console.log(`PASS ${checks.length} formal routes share the production shell`);
} finally { ws?.close(); browser.kill(); await wait(700); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
