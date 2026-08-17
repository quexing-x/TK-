import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const publicDirectory = join(process.cwd(), "public");

describe("public Meta legal pages", () => {
  it.each([
    ["privacy.html", ["隱私政策", "Meta App ID", "資料刪除", "mailto:"]],
    ["data-deletion.html", ["資料刪除", "撤銷應用授權", "30 天內", "mailto:"]],
    ["terms.html", ["服務條款", "PAUSED", "Meta Platform Terms", "mailto:"]],
  ])("ships %s with the required public content", (fileName, requiredText) => {
    const content = readFileSync(join(publicDirectory, fileName), "utf8");
    expect(content).toContain('<meta name="viewport"');
    expect(content).toContain('<link rel="stylesheet" href="./legal.css"');
    expect(content).not.toMatch(/YOUR[-_ ]|example\.com|127\.0\.0\.1|Access Token[^<]{0,30}EAA/i);
    for (const text of requiredText) expect(content).toContain(text);
  });
});
