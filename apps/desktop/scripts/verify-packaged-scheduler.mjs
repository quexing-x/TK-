import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = process.argv[2] ?? "release";
const appOutDirectory = resolve(desktopDirectory, outputDirectory, "win-unpacked");
const clientExecutable = join(appOutDirectory, "TK Ads Automation.exe");
const schedulerExecutable = join(appOutDirectory, "tk自动化后台程序.exe");
const appAsar = join(appOutDirectory, "resources", "app.asar");
const webEntry = join(appOutDirectory, "resources", "web", "index.html");

for (const path of [clientExecutable, schedulerExecutable, appAsar, webEntry]) {
  if (!existsSync(path)) throw new Error(`Release preflight is missing: ${path}`);
}

/**
 * 打进包里的前端不能比 web 源码旧。
 *
 * electron-builder 只是把 `../web/dist` 原样拷进 resources/web，自己不会构建它。
 * 1.4.66/1.4.67 就是这么发出去的：后端是新的、界面还是几小时前那份，装完看不出
 * 任何异常，只是改的东西「没生效」——最难查的一类。打包脚本已经补上构建步骤，
 * 这里再钉一道，免得哪天有人绕开脚本手跑 electron-builder。
 */
const webSourceDirectory = resolve(desktopDirectory, "..", "web", "src");
const newestSourceMtime = (directory) => {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSourceMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
};
if (existsSync(webSourceDirectory)) {
  const sourceMtime = newestSourceMtime(webSourceDirectory);
  const packagedMtime = statSync(webEntry).mtimeMs;
  if (sourceMtime > packagedMtime) {
    throw new Error(
      `Release preflight failed: 打包的前端比 web 源码旧（源码 ${new Date(sourceMtime).toISOString()} > 产物 ${new Date(packagedMtime).toISOString()}）。先跑 pnpm --filter @tk-auto/web build。`,
    );
  }
}

const bundledMain = readFileSync(appAsar).toString("utf8");
if (!/isSchedulerProcess\s*\|\|\s*(?:import_electron\.)?app\.requestSingleInstanceLock\(\)/.test(bundledMain)) {
  throw new Error("Release preflight failed: the scheduler single-instance separation is missing from app.asar.");
}

console.log("Release preflight passed: client, named scheduler, and scheduler lock separation are packaged.");
