import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutomationStore } from "@tk-auto/storage";
import { bootstrapLoginTestAccounts } from "./bootstrap.js";

const environment: NodeJS.ProcessEnv = {
  TK_AUTO_LOGIN_TEST: "true",
  TK_AUTO_TEST_DEVELOPER_USERNAME: "developer",
  TK_AUTO_TEST_DEVELOPER_DISPLAY_NAME: "测试开发者",
  TK_AUTO_TEST_DEVELOPER_PASSWORD: "Login-Test-Developer-2026!",
  ...Object.fromEntries(
    Array.from({ length: 5 }, (_, offset) => {
      const index = offset + 1;
      return [
        [`TK_AUTO_TEST_ADMIN_${index}_USERNAME`, `admin0${index}`],
        [`TK_AUTO_TEST_ADMIN_${index}_DISPLAY_NAME`, `测试管理员 ${index}`],
        [`TK_AUTO_TEST_ADMIN_${index}_PASSWORD`, `Login-Test-Admin-${index}-2026!`],
      ];
    }).flat(),
  ),
};

describe("login test account bootstrap", () => {
  let store: AutomationStore;

  beforeEach(() => {
    store = new AutomationStore(":memory:");
    store.seed();
  });

  afterEach(() => store.close());

  it("creates one developer and five administrators with automation paused", async () => {
    const result = await bootstrapLoginTestAccounts(store, environment);

    expect(result).toEqual({
      developerCreated: true,
      administratorsCreated: 5,
      totalUsers: 6,
    });
    expect(store.listLocalUsers().filter((user) => user.role === "admin"))
      .toHaveLength(5);
    expect(store.getSystemRuntimeState().enabled).toBe(false);
  });

  it("is idempotent and never replaces existing passwords", async () => {
    await bootstrapLoginTestAccounts(store, environment);
    const before = store.getStoredLocalUserByUsername("admin01")?.passwordHash;
    const result = await bootstrapLoginTestAccounts(store, environment);

    expect(result.administratorsCreated).toBe(0);
    expect(result.totalUsers).toBe(6);
    expect(store.getStoredLocalUserByUsername("admin01")?.passwordHash).toBe(before);
  });

  it("refuses to seed accounts outside explicit login-test mode", async () => {
    await expect(
      bootstrapLoginTestAccounts(store, { ...environment, TK_AUTO_LOGIN_TEST: "false" }),
    ).rejects.toThrow("TK_AUTO_LOGIN_TEST=true");
  });
});
