import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const port = 9237;
const userData = await mkdtemp(join(tmpdir(), "tk-playground-"));
const playgroundUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "index.html")).href;
const browser = spawn(edge, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userData}`,
  "about:blank"
], { stdio: "ignore" });

let socket;
let nextId = 0;
const pending = new Map();
const events = new Map();
const exceptions = [];

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitForEndpoint() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return response.json();
    } catch (_) {}
    await wait(100);
  }
  throw new Error("CDP endpoint did not start");
}
function once(method) {
  return new Promise((resolve) => {
    const list = events.get(method) || [];
    list.push(resolve);
    events.set(method, list);
  });
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  return result.result?.value;
}
function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

function parseRgb(value) {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`Unsupported color: ${value}`);
  return channels;
}

function relativeLuminance(value) {
  const channels = parseRgb(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

async function assertContrast(selector, label) {
  const styles = await evaluate(`(function () {
    var style = getComputedStyle(document.querySelector(${JSON.stringify(selector)}));
    return { color: style.color, backgroundColor: style.backgroundColor };
  }())`);
  const foreground = relativeLuminance(styles.color);
  const background = relativeLuminance(styles.backgroundColor);
  const ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  assert(ratio >= 4.5, `${label}文字对比度 ${ratio.toFixed(2)}:1 (${styles.color} on ${styles.backgroundColor})`);
}

try {
  const version = await waitForEndpoint();
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((tab) => tab.type === "page");
  if (!page) throw new Error("No page target");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params?.exceptionDetails?.text || "runtime exception");
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
      return;
    }
    if (message.method) {
      const list = events.get(message.method) || [];
      events.delete(message.method);
      list.forEach((resolve) => resolve(message.params));
    }
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: playgroundUrl });
  await once("Page.loadEventFired");
  await wait(100);

  assert((await evaluate("document.querySelectorAll('.ph').length")) > 20, "本地 Phosphor 图标已渲染");
  assert((await evaluate("document.fonts.check('16px Phosphor')")) === true, "Phosphor 本地图标字体已加载");
  assert((await evaluate("getComputedStyle(document.querySelector('.ph'), '::before').content !== 'none'")) === true, "Phosphor 图标字形可见");
  assert((await evaluate("document.querySelectorAll('[data-lucide]').length")) === 0, "页面没有 Lucide 图标引用");
  assert((await evaluate("document.documentElement.dataset.version")) === "1.1", "Playground 已标记为 V1.1");
  assert((await evaluate("document.querySelectorAll('button:not([type])').length")) === 0, "所有按钮都有 type");
  assert((await evaluate("document.querySelectorAll('.status-rail button').length")) === 0, "状态轨道没有无效按钮");
  assert((await evaluate("document.querySelectorAll('.status-rail').length")) === 1, "Control Rail 只用于真实流程状态");
  assert((await evaluate("document.querySelectorAll('.section-heading[data-section]').length")) === 0, "页面没有工程化 Section 编号");
  assert((await evaluate("!/CONTROL SPEC|CONTROL RAIL \\/ V2|RETRY 2/.test(document.body.innerText)")) === true, "页面没有 V2 工程标签");
  assert((await evaluate("Math.round(document.querySelector('.control').getBoundingClientRect().height)")) === 36, "控件恢复为 36px 舒适密度");
  assert((await evaluate("parseFloat(getComputedStyle(document.querySelector('.sample')).borderRadius)")) === 10, "Surface 使用 V1 适度圆角");
  assert((await evaluate("getComputedStyle(document.querySelector('.sample')).boxShadow !== 'none'")) === true, "Surface 保留柔和层级阴影");
  assert((await evaluate("getComputedStyle(document.querySelector('.table-workspace')).boxShadow")) === "none", "表格移除不必要外层 Card");
  assert((await evaluate("parseFloat(getComputedStyle(document.querySelector('.main')).maxWidth)")) === 1600, "桌面 Workspace 上限扩展到 1600px");
  assert((await evaluate("parseFloat(getComputedStyle(document.querySelector('.topbar h1')).fontSize)")) === 28, "Page title 使用 28px 层级");
  assert((await evaluate("parseFloat(getComputedStyle(document.querySelector('.section-heading h2')).fontSize)")) === 16, "Section title 使用 16px 层级");
  assert((await evaluate("document.querySelector('.table tbody td').getBoundingClientRect().height <= 56")) === true, "表格行保持高频运营所需密度");
  assert((await evaluate("(function () { var ids = Array.from(document.querySelectorAll('[id]')).map(function (node) { return node.id; }); return new Set(ids).size === ids.length; }())")) === true, "页面没有重复 id");
  assert((await evaluate("!/[—–⌘⌄‹›]/.test(document.body.innerText)")) === true, "页面没有遗留装饰字符");
  assert((await evaluate("Array.from(document.querySelectorAll('label[for]')).every((label) => document.getElementById(label.htmlFor))")) === true, "所有显式 label 都关联控件");
  assert((await evaluate("Array.from(document.querySelectorAll('[aria-labelledby],[aria-describedby]')).every(function (node) { return ['aria-labelledby', 'aria-describedby'].every(function (name) { return (node.getAttribute(name) || '').trim().split(' ').filter(Boolean).every(function (id) { return document.getElementById(id); }); }); })")) === true, "ARIA 引用目标都存在");
  assert((await evaluate("document.getElementById('overlay').getAttribute('aria-hidden')")) === "true", "浮层初始状态对辅助技术隐藏");
  await assertContrast("#primaryDemo", "浅色主按钮");
  await assertContrast("#dangerDemo", "浅色危险按钮");
  await assertContrast(".page-btn.active", "浅色当前页按钮");

  await evaluate("document.getElementById('themeToggle').click()");
  await wait(220);
  assert((await evaluate("document.documentElement.dataset.theme")) === "dark", "主题可以切换到深色");
  assert((await evaluate("document.querySelector('[data-theme-icon]').classList.contains('ph-sun')")) === true, "深色主题使用 Phosphor 太阳图标");
  await assertContrast("#primaryDemo", "深色主按钮");
  await assertContrast("#dangerDemo", "深色危险按钮");
  await assertContrast(".page-btn.active", "深色当前页按钮");
  await evaluate("document.getElementById('themeToggle').click()");
  await wait(220);

  await evaluate("document.getElementById('dropdownTrigger').click()");
  assert(await evaluate("document.getElementById('dropdownTrigger').getAttribute('aria-expanded')") === "true", "下拉菜单点击后展开");
  await evaluate("document.getElementById('option-running').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  assert(await evaluate("document.getElementById('dropdownMenu').hidden") === true, "下拉菜单 Escape 可关闭");
  assert(await evaluate("document.activeElement.id") === "dropdownTrigger", "下拉菜单关闭后焦点返回触发器");
  await evaluate("document.getElementById('dropdownTrigger').focus(); document.getElementById('dropdownTrigger').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))");
  await wait(30);
  assert(await evaluate("document.getElementById('dropdownMenu').hidden") === false, "下拉菜单可由 ArrowDown 打开");
  await evaluate("document.getElementById('option-error').click()");
  assert(await evaluate("document.querySelector('#dropdownTrigger span').textContent") === "状态：异常", "下拉选项会更新触发器文案");

  await evaluate("document.getElementById('tab-all').focus(); document.getElementById('tab-all').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
  assert(await evaluate("document.getElementById('tab-running').getAttribute('aria-selected')") === "true", "标签页支持方向键切换");
  assert(await evaluate("document.getElementById('tab-panel').getAttribute('aria-labelledby')") === "tab-running", "标签页面板关联当前标签");

  await evaluate("document.getElementById('openModal').click()");
  await wait(30);
  assert(await evaluate("document.getElementById('overlay').hidden") === false, "Modal 可以打开");
  assert(await evaluate("document.getElementById('appShell').hasAttribute('inert')") === true, "Modal 打开时背景被 inert 隔离");
  assert(await evaluate("document.getElementById('modalDialog').contains(document.activeElement)") === true, "Modal 打开后焦点进入浮层");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))");
  assert(await evaluate("document.activeElement.id") === "confirmModal", "Modal 焦点可向后循环");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))");
  assert(await evaluate("document.activeElement.hasAttribute('data-close')") === true, "Modal 焦点可向前循环");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  assert(await evaluate("document.getElementById('overlay').hidden") === true, "Modal Escape 可关闭");
  assert(await evaluate("document.activeElement.id") === "openModal", "Modal 关闭后焦点返回打开按钮");

  await evaluate("document.getElementById('openDrawer').click()");
  await wait(30);
  assert(await evaluate("document.getElementById('detailDrawer').hidden") === false, "Drawer 可以打开");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  assert(await evaluate("document.getElementById('overlay').hidden") === true, "Drawer Escape 可关闭");
  assert(await evaluate("document.activeElement.id") === "openDrawer", "Drawer 关闭后焦点返回打开按钮");
  await evaluate("document.querySelectorAll('[data-drawer]')[1].click()");
  await wait(30);
  assert(await evaluate("document.getElementById('drawerDescription').textContent") === "双科-TTN-SG-08", "表格抽屉显示当前账户");
  assert(await evaluate("document.getElementById('drawerSync').textContent") === "12 分钟前", "表格抽屉同步当前账户数据");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  assert(await evaluate("document.activeElement === document.querySelectorAll('[data-drawer]')[1]") === true, "表格抽屉关闭后焦点返回当前行");

  await evaluate("document.querySelector('.row-check').click()");
  assert(await evaluate("document.getElementById('selectionBar').hidden") === false, "表格选中后显示批量操作栏");
  assert(await evaluate("document.querySelector('tbody tr').getAttribute('aria-selected')") === "true", "表格行同步 aria-selected");
  await evaluate("document.querySelector('.page-btn[data-page=\"2\"]').click()");
  assert(await evaluate("document.querySelector('.page-btn[aria-current=page]').dataset.page") === "2", "分页点击更新当前页");
  assert(await evaluate("document.getElementById('pagePrev').disabled") === false, "分页第二页启用上一页");

  await evaluate("document.getElementById('showToast').click(); document.getElementById('showErrorToast').click()");
  assert(await evaluate("document.querySelectorAll('#toastStack .toast[role=status]').length") === 1, "成功 Toast 使用 status 语义");
  assert(await evaluate("document.querySelectorAll('#toastStack .toast[role=alert]').length") === 1, "错误 Toast 使用 alert 语义");
  await evaluate("document.querySelector('#toastStack .toast[role=status] button').click()");
  assert(await evaluate("document.querySelectorAll('#toastStack .toast[role=status]').length") === 0, "Toast 可手动关闭");

  await send("Emulation.setDeviceMetricsOverride", { width: 540, height: 1100, deviceScaleFactor: 1, mobile: false });
  await wait(80);
  const responsive = await evaluate("({ width: document.documentElement.clientWidth, filter: document.querySelector('.filter-bar').getBoundingClientRect().width, viewport: window.innerWidth })");
  assert(responsive.filter <= responsive.viewport, "540px 窄屏筛选栏不溢出");
  assert(exceptions.length === 0, `运行期间没有 JS 异常${exceptions.length ? `: ${exceptions.join(" | ")}` : ""}`);
  console.log("ALL PLAYGROUND SMOKE TESTS PASSED");
  console.log(`Edge ${version.Browser || "headless"}`);
} finally {
  socket?.close();
  browser.kill("SIGKILL");
  await wait(300);
  try { await rm(userData, { recursive: true, force: true }); } catch (_) {}
}
