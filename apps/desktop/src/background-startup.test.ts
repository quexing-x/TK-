import { describe, expect, it } from "vitest";
import { backgroundStartupRegistryValue } from "./background-startup.js";

describe("background startup registration", () => {
  it("registers the named scheduler executable in the current-user startup hive", () => {
    expect(backgroundStartupRegistryValue("C:/Apps/tk自动化后台程序.exe")).toEqual({
      key: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      name: "tk自动化后台程序",
      command: '"C:/Apps/tk自动化后台程序.exe" --scheduler',
    });
  });
});
