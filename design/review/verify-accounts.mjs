// Browser-only contract fixtures. Never imported by the production application.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const output = dirname(fileURLToPath(import.meta.url));
const profile = await mkdtemp(join(tmpdir(), "tk-account-review-"));
const port = 9241;
const browser = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws, nextId = 0;
const pending = new Map(), errors = [], checks = [], writes = [];
let mode = "normal", metricDelay = 0, activityDelay = 0, failAccount = null;
const now = new Date().toISOString();
const earlier = new Date(Date.now() - 3_600_000).toISOString();
const accounts = Array.from({ length: 32 }, (_, i) => ({ id: `review-account-${String(i + 1).padStart(3, "0")}`, displayName: ["东南亚 · 美妆主账户", "泰国 · 家居日用", "越南 · 服饰增长", "印尼 · 新品测试", "马来西亚 · 品牌投放", "菲律宾 · 电商转化", "新加坡 · 再营销", "台湾 · 素材测试"][i % 8] + (i > 7 ? ` ${Math.floor(i / 8) + 1}` : ""), platform: i % 7 === 6 ? "meta" : "tiktok", accountType: i % 3 === 0 ? "agency" : "standard", enabled: i % 3 === 0, providerKind: i % 7 === 6 ? "meta-marketing-api" : "cookie", timezone: "Asia/Shanghai", pollIntervalSeconds: 30, maxActionsPerCycle: 5, updatedAt: now }));
const capabilities = ["read-campaigns", "read-ad-groups", "read-ads", "change-status", "create-campaigns", "copy-ads"];
function state(a, i) {
  const failed = i % 8 === 3, partial = i % 8 === 2;
  return { accountId: a.id, connection: { accountId: a.id, kind: a.providerKind, settings: { kind: a.providerKind, advertiserId: a.id, liveMode: "automation-status" }, hasCredential: true, status: failed ? "failed" : "ready", authorizationStatus: failed ? "expired" : "active", capabilityVersion: "review-v1", lastMessage: failed ? "凭据已过期，请重新接入。" : null, lastTestedAt: now, updatedAt: now }, latestSync: failed ? null : { startedAt: now, finishedAt: now, counts: { campaign: 18, "ad-group": 46, ad: 98, material: 0 }, warnings: [], quality: { status: partial ? "partial" : "healthy", completeEntityTypes: partial ? ["campaign"] : ["campaign", "ad-group", "ad"], partialFailures: partial ? ["广告层返回数据不完整。"] : [], lastHealthyAt: partial ? earlier : now } }, capabilities: { accountId: a.id, providerKind: a.providerKind, providerDisplayName: "账户接入", authorizationStatus: failed ? "expired" : "active", capabilityVersion: "review-v1", capabilities: capabilities.map((c) => ({ capability: c, available: !failed && !(partial && c === "create-campaigns"), reason: "需要重新检测创建能力。" })) } };
}
function send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; }
async function until(expression) { for (let i = 0; i < 120; i++) { if (await evaluate(`Boolean(${expression})`)) return; await wait(100); } throw new Error(`Timeout: ${expression}`); }
function assert(value, label) { if (!value) throw new Error(`FAIL ${label}`); checks.push(label); console.log(`PASS ${label}`); }
async function clickText(text) { await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`); await wait(120); }
async function select(label, value) { await evaluate(`(()=>{const el=document.querySelector('select[aria-label="${label}"]'); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true}));})()`); await wait(150); }
async function search(value) { await evaluate(`(()=>{const el=document.querySelector('input[aria-label="搜索账户"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true}));})()`); await wait(150); }
async function screenshot(name) { const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); await writeFile(join(output, `${name}.png`), Buffer.from(r.data, "base64")); }
async function fulfill(event) {
  const { requestId, request } = event;
  const url = new URL(request.url);
  let body, code = 200;
  if (url.pathname === "/api/auth/status") body = { authenticated: true, setupRequired: false, user: { id: "review-user", displayName: "运营人员", role: "developer" }, permissions: mode === "readonly" ? [] : ["accounts:manage", "system:control", "users:manage"], csrfToken: "isolated-review" };
  else if (url.pathname === "/api/bootstrap") body = { accounts: mode === "empty" ? [] : accounts, accountConnectionStates: mode === "empty" ? [] : accounts.map(state), systemRuntime: { enabled: false }, globalAutomationSettings: {}, providers: [] };
  else if (url.pathname.endsWith("/automation/runs")) {
    await wait(activityDelay);
    const accountId = url.pathname.split("/")[3];
    body = [
      { id: `${accountId}-run-current`, accountId, providerKind: "cookie", trigger: "scheduler", automatic: true, status: "completed", startedAt: now, finishedAt: now, candidateCount: 4, actionCount: 3, successCount: 3, failureCount: 0, errorMessage: null },
      { id: `${accountId}-run-earlier`, accountId, providerKind: "cookie", trigger: "scheduler", automatic: true, status: "failed", startedAt: earlier, finishedAt: earlier, candidateCount: 2, actionCount: 1, successCount: 0, failureCount: 1, errorMessage: "一个广告组状态回读失败。" },
    ];
  } else if (url.pathname.endsWith("/ad-operations")) {
    await wait(activityDelay);
    const accountId = url.pathname.split("/")[3];
    body = [
      { id: `${accountId}-operation-current`, operationId: "op-1", attemptId: "attempt-1", correlationId: "review-1", attemptCount: 1, accountId, providerKind: "cookie", entityType: "ad-group", externalId: "group-001", entityName: "SEA Broad 01", action: "disable", source: "automation", status: "succeeded", phase: "sync", actor: { id: "system", name: "自动化引擎", kind: "system" }, claimedBy: null, claimedAt: null, message: "状态已同步", syncWarning: null, createdAt: now, updatedAt: now, completedAt: now },
      { id: `${accountId}-operation-earlier`, operationId: "op-2", attemptId: "attempt-2", correlationId: "review-2", attemptCount: 1, accountId, providerKind: "cookie", entityType: "ad-group", externalId: "group-002", entityName: "SEA Interest 02", action: "enable", source: "automation", status: "unknown", phase: "readback", actor: { id: "system", name: "自动化引擎", kind: "system" }, claimedBy: null, claimedAt: null, message: "平台已接收请求，回读状态待确认", syncWarning: "启停结果尚未完成回读。", createdAt: earlier, updatedAt: earlier, completedAt: null },
      { id: `${accountId}-operation-failed`, operationId: "op-3", attemptId: "attempt-3", correlationId: "review-3", attemptCount: 1, accountId, providerKind: "cookie", entityType: "ad-group", externalId: "group-003", entityName: "SEA Retarget 03", action: "disable", source: "automation", status: "failed", phase: "execute", actor: { id: "system", name: "自动化引擎", kind: "system" }, claimedBy: null, claimedAt: null, message: "平台拒绝了本次状态变更。", syncWarning: null, createdAt: earlier, updatedAt: earlier, completedAt: null },
      { id: `${accountId}-operation-unknown`, operationId: "op-4", attemptId: "attempt-4", correlationId: "review-4", attemptCount: 1, accountId, providerKind: "cookie", entityType: "ad-group", externalId: "group-004", entityName: "SEA Prospect 04", action: "enable", source: "automation", status: "unknown", phase: "readback", actor: { id: "system", name: "自动化引擎", kind: "system" }, claimedBy: null, claimedAt: null, message: "平台回读仍在等待。", syncWarning: "第二个启停结果尚未完成回读。", createdAt: earlier, updatedAt: earlier, completedAt: null },
    ];
  }
  else if (request.method === "POST" && url.pathname.includes("/connections/") && url.pathname.endsWith("/test")) {
    const accountId = url.pathname.split("/")[3];
    const a = accounts.find((item) => item.id === accountId);
    body = { accountId, kind: a?.providerKind ?? "cookie", settings: { kind: a?.providerKind ?? "cookie", advertiserId: accountId }, hasCredential: true, status: "ready", authorizationStatus: "active", capabilityVersion: "review-v1", authorizedCapabilities: capabilities, authorizedAt: now, authorizationExpiresAt: null, lastMessage: null, lastTestedAt: now, updatedAt: now };
  } else if (request.method === "POST" && url.pathname.includes("/connections/") && url.pathname.endsWith("/sync")) {
    body = { startedAt: now, finishedAt: now, counts: { campaign: 18, "ad-group": 46, ad: 98, material: 0 }, warnings: [], quality: { status: "healthy", completeEntityTypes: ["campaign", "ad-group", "ad"], partialFailures: [], lastHealthyAt: now } };
  }
  else if (url.pathname.endsWith("/metric-days")) {
    await wait(metricDelay);
    if (mode === "metric-error" && url.pathname.includes("001")) { code = 503; body = { message: "指标读取暂时失败，请稍后重试。" }; }
    else { const index = Number(url.pathname.match(/review-account-(\d+)/)?.[1]); body = index % 8 === 4 ? [] : [{ date: url.searchParams.get("from"), count: 46, spend: index === 2 ? 0 : 582.17 * index, clicks: 120, conversions: 8, lastCapturedAt: now, lastLocalTime: "16:28", isCurrentDay: true }]; }
  } else if (request.method === "PUT" && url.pathname.endsWith("/settings")) {
    writes.push({ path: url.pathname, body: JSON.parse(request.postData) });
    const a = accounts.find((a) => url.pathname.includes(a.id));
    if (a?.id === failAccount) { code = 500; body = { message: "测试账户保存失败" }; }
    else { Object.assign(a, JSON.parse(request.postData)); body = a; }
  } else { errors.push(`Unexpected intercepted API: ${request.method} ${url.pathname}`); code = 500; body = { message: "接口不在验收范围内" }; }
  await send("Fetch.fulfillRequest", { requestId, responseCode: code, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(body)).toString("base64") });
}
try {
  let tabs;
  for (let i = 0; i < 50; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; } catch { await wait(100); } }
  ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.addEventListener("message", (event) => { const m = JSON.parse(event.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(m.error.message)) : p?.resolve(m.result); } else if (m.method === "Fetch.requestPaused") void fulfill(m.params).catch((e) => { /* Reload cancels pending fixture responses. */ if (!e.message.includes("Invalid InterceptionId")) errors.push(e.message); }); else if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails)); });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/*" }] });
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: "http://127.0.0.1:5173/#accounts" });
  await until("document.querySelectorAll('.p-account-table tbody tr').length===25 && !document.querySelector('.p-loading-text')");
  await select("每页账户数", "10"); await until("!document.querySelector('.p-loading-text')");
  assert(await evaluate("getComputedStyle(document.querySelector('.p-sidebar')).backgroundColor==='rgb(17, 24, 39)'"), "Frozen dark sidebar");
  await screenshot("accounts-desktop");
  assert(await evaluate("document.querySelectorAll('.p-account-table tbody tr')[1].innerText.includes('0.00') && document.querySelectorAll('.p-account-table tbody tr')[3].innerText.includes('暂无今日数据')"), "Zero spend differs from missing data");
  await evaluate("document.documentElement.dataset.theme='dark'");
  assert(await evaluate("getComputedStyle(document.querySelector('.p-account-surface')).backgroundColor==='rgb(255, 255, 255)'"), "Account canvas remains approved light theme under legacy dark preference");
  await evaluate("document.documentElement.dataset.theme='light'");
  assert(await evaluate("document.documentElement.scrollWidth===document.documentElement.clientWidth"), "1600px desktop has no page overflow");
  assert(await evaluate("!document.querySelector('.p-shell svg.lucide')"), "Phosphor only in account workspace");
  assert(await evaluate("!/(Playground|Design System|Token|Spec|Component|Control Rail)/i.test(document.querySelector('.p-shell').innerText)"), "No internal design copy");
  assert(await evaluate("!document.querySelector('.p-shell').innerText.includes('ROAS')"), "ROAS removed from account page and drawer");
  assert(await evaluate("!document.querySelector('.p-overview-note') && document.querySelector('.p-runtime-control').innerText.includes('全局自动化已暂停')"), "Global runtime state appears only in top bar");
  assert(await evaluate("document.querySelectorAll('.p-switch.is-suspended').length===4 && [...document.querySelectorAll('.p-switch.is-suspended')].every(b=>b.nextElementSibling.innerText.includes('已开启 · 全局暂停'))"), "Enabled account toggles show suspended visual state without changing configuration");
  assert(await evaluate("document.querySelectorAll('.p-account-overview button').length===4 && document.querySelector('.p-account-overview button.is-active').innerText.includes('全部')"), "Lightweight health summary exposes four filter actions");
  assert(await evaluate("document.querySelectorAll('.p-account-table tbody tr').length===10"), "Page size applies");
  await screenshot("accounts-desktop");
  const rect = await evaluate("(()=>{const r=document.querySelector('.p-account-table tbody tr').getBoundingClientRect();return {x:r.x+100,y:r.y+20};})()");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...rect });
  await wait(250);
  assert(await evaluate("getComputedStyle(document.querySelector('.p-account-table tbody tr')).backgroundColor==='rgb(247, 249, 251)'"), "Row hover surface");
  await evaluate("document.querySelector('input[aria-label=\"选择本页账户\"]').click()"); await wait(100);
  assert(await evaluate("document.querySelectorAll('tr.is-selected').length===10"), "Select current page and bulk actions");
  await screenshot("accounts-selected");
  await evaluate("document.querySelector('button[aria-label=\"下一页\"]').click()"); await wait(150);
  assert(await evaluate("document.querySelector('.p-selection').textContent.includes('10') && document.querySelectorAll('tr.is-selected').length===0"), "Selection persists across pagination");
  await search("东南亚"); assert(await evaluate("document.querySelectorAll('.p-account-table tbody tr').length===4 && !document.querySelector('.p-selection')"), "Search filters and clears hidden selections");
  await search("no-match-at-all"); assert(await evaluate("document.querySelector('.p-empty').innerText.includes('没有匹配')"), "Filtered empty state"); await screenshot("accounts-filter-empty");
  await clickText("清除筛选"); await select("平台筛选", "meta"); assert(await evaluate("[...document.querySelectorAll('.p-account-table tbody tr')].every(r=>r.innerText.includes('Meta Ads'))"), "Platform filter"); await select("平台筛选", "all");
  await evaluate("[...document.querySelectorAll('.p-account-overview button')].find(b=>b.innerText.includes('异常')).click()"); await wait(150); assert(await evaluate("document.querySelectorAll('.p-account-table tbody tr').length===4 && document.querySelector('.p-account-overview button.is-active').innerText.includes('异常')"), "Health summary filters the table and marks active state"); await evaluate("document.querySelector('.p-account-overview button').click()"); await wait(150);
  activityDelay = 450; await evaluate("document.querySelector('.p-account-name').focus(); document.querySelector('.p-account-name').click()"); await until("document.querySelector('dialog[open]')");
  assert(await evaluate("[...document.querySelectorAll('.p-activity-state[role=status]')].some(el=>el.innerText.includes('正在读取'))"), "Drawer activity shows loading state while records are pending");
  await until("document.querySelectorAll('.p-execution-list li').length>0"); activityDelay = 0;
  assert(await evaluate("document.querySelectorAll('.p-rail li').length===5 && document.querySelectorAll('.p-rail .is-ready').length===5"), "Drawer rail uses five independent real capability fields");
  assert(await evaluate("document.querySelector('.p-detail-metrics').innerText.includes('最后成功同步') && document.querySelector('.p-detail-metrics').innerText.includes('受全局暂停影响')"), "Drawer separates successful sync and account configuration from global runtime");
  assert(await evaluate("document.querySelectorAll('.p-anomaly-list li').length>=2 && document.querySelectorAll('.p-execution-list li').length===4"), "Drawer shows recent anomalies and combined execution records");
  assert(await evaluate("document.querySelectorAll('.p-link-button').length===2"), "Drawer exposes full activity links without expanding recent lists");
  await clickText("查看全部"); await until("document.querySelector('.p-activity-dialog')");
  assert(await evaluate("document.querySelector('.p-activity-dialog h3').innerText.includes('全部') && document.querySelectorAll('.p-activity-dialog .p-anomaly-list li').length>=4"), "Full anomaly dialog lists all available records");
  await evaluate("document.querySelector('[aria-label=\"关闭全部记录\"]').click()"); await until("!document.querySelector('.p-activity-dialog')");
  await screenshot("accounts-drawer");
  await evaluate("document.querySelector('.p-drawer').scrollTop=document.querySelector('.p-drawer').scrollHeight"); await wait(100); await screenshot("accounts-drawer-activity"); await evaluate("document.querySelector('.p-drawer').scrollTop=0");
  for (let i=0;i<9;i++) { await send("Input.dispatchKeyEvent", {type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9}); await send("Input.dispatchKeyEvent", {type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9}); }
  assert(await evaluate("Boolean(document.activeElement.closest('dialog'))"), "Drawer traps keyboard focus");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await wait(100);
  assert(await evaluate("!document.querySelector('dialog[open]') && document.activeElement.classList.contains('p-account-name')"), "Escape closes drawer and returns focus");
  await search("review-account-004"); await until("document.querySelectorAll('.p-account-table tbody tr').length===1");
  await evaluate("document.querySelector('.p-account-name').click()"); await until("document.querySelector('.p-rail .is-failed')");
  assert(await evaluate("document.querySelector('.p-rail-diagnostic')?.innerText.includes('原因') && [...document.querySelectorAll('.p-rail-diagnostic .p-button')].some(b=>b.innerText.includes('重新检测'))"), "Capability failure expands with reason and recovery action");
  await screenshot("accounts-drawer-capability");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await wait(100); await search("");
  await evaluate("document.querySelector('.p-account-name').click()"); await until("document.querySelector('.p-drawer')"); await clickText("删除账户"); await until("document.querySelector('.unified-modal.is-danger')");
  assert(await evaluate("document.querySelector('.unified-modal.is-danger').innerText.includes('不可撤销')"), "Delete action opens explicit destructive confirmation");
  await clickText("取消"); await until("!document.querySelector('.unified-modal')");
  mode = "metric-error"; metricDelay = 1500; await clickText("刷新状态"); await until("document.querySelector('.p-loading-text')"); await screenshot("accounts-loading"); await until("document.querySelector('.p-metric-error')"); await screenshot("accounts-error");
  metricDelay = 0; mode = "normal"; await evaluate("document.querySelector('.p-metric-error').click()"); await until("!document.querySelector('.p-loading-text') && !document.querySelector('.p-metric-error')");
  assert(true, "Metric error and retry recover");
  await evaluate("document.querySelector('input[aria-label=\"选择本页账户\"]').click()"); await clickText("关闭自动化"); await until("document.querySelector('.unified-modal')");
  assert(writes.length === 0, "Bulk mutation waits for explicit confirmation");
  failAccount = accounts[0].id;
  await clickText("确认修改"); await until("document.querySelector('.p-feedback')?.innerText.includes('修改失败')");
  assert(writes.length === 4 && writes.every((w) => w.body.enabled === false), "Bulk affects only four eligible selected accounts");
  assert(await evaluate("document.querySelector('.p-feedback').innerText.includes('东南亚')"), "Partial bulk failure reports failed account");
  mode = "readonly"; await send("Page.reload"); await until("document.querySelector('.p-readonly')");
  assert(await evaluate("[...document.querySelectorAll('button[role=switch]')].every(b=>b.disabled)"), "Read-only permissions disable mutations");
  await screenshot("accounts-readonly");
  mode = "empty"; await send("Page.reload"); await until("document.querySelector('.p-empty')?.innerText.includes('还没有广告账户')"); await screenshot("accounts-empty");
  mode = "normal"; await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await send("Page.reload"); await until("document.querySelector('.p-account-table tbody tr')");
  await screenshot("accounts-1280");
  assert(await evaluate("document.documentElement.scrollWidth===document.documentElement.clientWidth && document.querySelector('.p-table-scroll').scrollWidth>document.querySelector('.p-table-scroll').clientWidth"), "1280px keeps scrolling inside table");
  assert(errors.length === 0, `No runtime exceptions or out-of-scope API requests: ${errors.join('; ')}`);
  await writeFile(join(output, "verification.json"), JSON.stringify({ dataSource: "isolated browser API contract fixtures; no real account writes", checks, simulatedWrites: writes.length, errors }, null, 2));
} finally { ws?.close(); browser.kill(); await wait(700); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
