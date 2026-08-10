import { describe, expect, it } from "vitest";
import {
  BACKGROUND_PROGRAM_NAME,
  isAddressInUseError,
  schedulerLaunchCommand,
  schedulerProgramPath,
  waitForSchedulerHealthy,
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

describe("waitForSchedulerHealthy", () => {
  // 用虚拟时钟，不真的 sleep。
  function fakeClock() {
    let current = 0;
    return {
      now: () => current,
      sleep: async (ms: number) => {
        current += ms;
      },
    };
  }

  it("returns true as soon as the scheduler is healthy without waiting the full timeout", async () => {
    const clock = fakeClock();
    let calls = 0;
    const isHealthy = async () => {
      calls += 1;
      return calls >= 3; // 第三次才健康
    };

    const result = await waitForSchedulerHealthy(isHealthy, {
      timeoutMs: 120_000,
      intervalMs: 250,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toBe(true);
    expect(calls).toBe(3);
    // 只等了两个轮询间隔，远没到 120 秒——库大时正是靠这份耐心避免误报。
    expect(clock.now()).toBe(500);
  });

  it("keeps polling well past the old 10s ceiling before giving up", async () => {
    const clock = fakeClock();
    // 冷启动 30 秒才健康：旧的 10 秒写死会误判失败，新上限必须挺过去。
    const isHealthy = async () => clock.now() >= 30_000;

    const result = await waitForSchedulerHealthy(isHealthy, {
      timeoutMs: 120_000,
      intervalMs: 250,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toBe(true);
  });

  it("returns false only after the full timeout elapses", async () => {
    const clock = fakeClock();
    const isHealthy = async () => false;

    const result = await waitForSchedulerHealthy(isHealthy, {
      timeoutMs: 120_000,
      intervalMs: 250,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toBe(false);
    expect(clock.now()).toBeGreaterThanOrEqual(120_000);
  });
});

describe("isAddressInUseError", () => {
  it("recognizes an EADDRINUSE listen error", () => {
    expect(isAddressInUseError(Object.assign(new Error("listen"), { code: "EADDRINUSE" }))).toBe(true);
  });

  it("does not treat other errors as address-in-use", () => {
    expect(isAddressInUseError(new Error("boom"))).toBe(false);
    expect(isAddressInUseError({ code: "ECONNREFUSED" })).toBe(false);
    expect(isAddressInUseError(null)).toBe(false);
  });
});
