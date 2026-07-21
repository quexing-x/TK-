import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrateLegacyRuntimeData,
  resolveDesktopRuntimePaths,
} from "./runtime-paths.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop runtime paths", () => {
  it("stores data in Documents and update downloads in Downloads", () => {
    const paths = resolveDesktopRuntimePaths({
      downloadsDirectory: "C:/Users/test/Downloads",
      legacyUserDataDirectory: "C:/Users/test/AppData/Roaming/TK Ads Automation",
      userDataDirectory: "C:/Users/test/Documents/TK Ads Automation",
    });

    expect(paths.dataDirectory).toContain("Documents");
    expect(paths.dataDirectory).not.toContain("AppData");
    expect(paths.downloadDirectory).toContain("Downloads");
  });

  it("copies legacy data once and preserves the legacy source", () => {
    const root = mkdtempSync(join(tmpdir(), "tk-auto-desktop-"));
    temporaryDirectories.push(root);
    const legacyDataDirectory = join(root, "legacy", "data");
    const dataDirectory = join(root, "documents", "TK Ads Automation", "data");
    mkdirSync(legacyDataDirectory, { recursive: true });
    writeFileSync(join(legacyDataDirectory, "tk-automation.db"), "test-data");

    const paths = {
      legacyDataDirectory,
      dataDirectory,
      downloadDirectory: join(root, "downloads", "TK Ads Automation", "updates"),
    };
    expect(migrateLegacyRuntimeData(paths)).toBe(true);
    expect(migrateLegacyRuntimeData(paths)).toBe(false);
    expect(existsSync(join(legacyDataDirectory, "tk-automation.db"))).toBe(true);
    expect(readFileSync(join(dataDirectory, "tk-automation.db"), "utf8")).toBe("test-data");
  });
});
