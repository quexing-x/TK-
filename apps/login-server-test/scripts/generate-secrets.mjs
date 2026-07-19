import { randomBytes } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve(process.cwd(), ".env.login-test");
try {
  await access(target);
  console.log(`登录测试凭据已存在，未覆盖：${target}`);
  process.exit(0);
} catch {
  // The file is created once so reruns never silently replace account passwords.
}

const lines = [
  "# TK Ads Automation central login test - PRIVATE, NEVER COMMIT",
  "TK_AUTO_LOGIN_TEST=true",
  "TK_AUTO_LOGIN_TEST_PORT=3180",
  "TK_AUTO_LOGIN_TEST_SECURE_COOKIES=false",
  "TK_AUTO_TEST_DEVELOPER_USERNAME=developer",
  "TK_AUTO_TEST_DEVELOPER_DISPLAY_NAME=登录测试开发者",
  `TK_AUTO_TEST_DEVELOPER_PASSWORD=${password()}`,
];

for (let index = 1; index <= 5; index += 1) {
  const displayIndex = String(index).padStart(2, "0");
  lines.push(
    `TK_AUTO_TEST_ADMIN_${index}_USERNAME=admin${displayIndex}`,
    `TK_AUTO_TEST_ADMIN_${index}_DISPLAY_NAME=测试管理员 ${displayIndex}`,
    `TK_AUTO_TEST_ADMIN_${index}_PASSWORD=${password()}`,
  );
}

await writeFile(target, `${lines.join("\n")}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
console.log(`已生成 1 个开发者和 5 个管理员的私密凭据文件：${target}`);

function password() {
  return `${randomBytes(18).toString("base64url")}aA1!`;
}
