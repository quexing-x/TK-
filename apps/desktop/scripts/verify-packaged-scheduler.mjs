import { existsSync, readFileSync } from "node:fs";
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

const bundledMain = readFileSync(appAsar).toString("utf8");
if (!/isSchedulerProcess\s*\|\|\s*(?:import_electron\.)?app\.requestSingleInstanceLock\(\)/.test(bundledMain)) {
  throw new Error("Release preflight failed: the scheduler single-instance separation is missing from app.asar.");
}

console.log("Release preflight passed: client, named scheduler, and scheduler lock separation are packaged.");
