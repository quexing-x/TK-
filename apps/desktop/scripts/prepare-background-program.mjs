import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export default function prepareBackgroundProgram(context) {
  if (context.electronPlatformName !== "win32") return;
  const client = join(context.appOutDir, "TK Ads Automation.exe");
  const scheduler = join(context.appOutDir, "tk自动化后台程序.exe");
  if (!existsSync(client)) throw new Error(`Missing packed client executable: ${client}`);
  copyFileSync(client, scheduler);
}
