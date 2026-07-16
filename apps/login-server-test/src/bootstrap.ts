import { AuthService } from "@tk-auto/api";
import type { AutomationStore } from "@tk-auto/storage";

const ADMIN_COUNT = 5;

export interface LoginTestBootstrapResult {
  developerCreated: boolean;
  administratorsCreated: number;
  totalUsers: number;
}

export async function bootstrapLoginTestAccounts(
  store: AutomationStore,
  environment: NodeJS.ProcessEnv,
): Promise<LoginTestBootstrapResult> {
  assertLoginTestMode(environment);
  const auth = new AuthService(store);
  let developerCreated = false;

  if (store.countLocalUsers() === 0) {
    const session = await auth.setupInitialDeveloper({
      username: required(environment, "TK_AUTO_TEST_DEVELOPER_USERNAME"),
      displayName: required(environment, "TK_AUTO_TEST_DEVELOPER_DISPLAY_NAME"),
      password: required(environment, "TK_AUTO_TEST_DEVELOPER_PASSWORD"),
    });
    auth.logout(session);
    developerCreated = true;
  }

  const developer = store
    .listLocalUsers()
    .find((user) => user.role === "developer" && user.enabled);
  if (!developer) {
    throw new Error("登录测试数据库中缺少启用的开发者账号。");
  }

  let administratorsCreated = 0;
  for (let index = 1; index <= ADMIN_COUNT; index += 1) {
    const suffix = String(index);
    const username = required(environment, `TK_AUTO_TEST_ADMIN_${suffix}_USERNAME`);
    if (store.getStoredLocalUserByUsername(username)) continue;
    await auth.createUser(developer, {
      username,
      displayName: required(
        environment,
        `TK_AUTO_TEST_ADMIN_${suffix}_DISPLAY_NAME`,
      ),
      role: "admin",
      password: required(environment, `TK_AUTO_TEST_ADMIN_${suffix}_PASSWORD`),
    });
    administratorsCreated += 1;
  }

  store.updateSystemRuntimeState({ enabled: false });
  return {
    developerCreated,
    administratorsCreated,
    totalUsers: store.countLocalUsers(),
  };
}

function assertLoginTestMode(environment: NodeJS.ProcessEnv): void {
  if (environment.TK_AUTO_LOGIN_TEST !== "true") {
    throw new Error("仅允许在 TK_AUTO_LOGIN_TEST=true 时初始化测试账户。");
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`缺少登录测试环境变量：${name}`);
  return value;
}
