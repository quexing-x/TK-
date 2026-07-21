import { describe, expect, it } from "vitest";
import {
  BACKGROUND_PROGRAM_NAME,
  schedulerLaunchCommand,
  schedulerProgramPath,
} from "./background-program.js";

describe("background scheduler program", () => {
  it("uses a separately named executable beside the client when packaged", () => {
    expect(schedulerProgramPath({
      packaged: true,
      executablePath: "C:/Apps/TK Ads Automation/TK Ads Automation.exe",
      appPath: "C:/Apps/TK Ads Automation/resources/app.asar",
    })).toMatch(new RegExp(`${BACKGROUND_PROGRAM_NAME}\\.exe$`));
  });

  it("passes only the background mode argument to the packaged program", () => {
    expect(schedulerLaunchCommand(`C:/Apps/${BACKGROUND_PROGRAM_NAME}.exe`)).toEqual({
      command: `C:/Apps/${BACKGROUND_PROGRAM_NAME}.exe`,
      args: ["--scheduler"],
    });
  });
});
