const required = ["CSC_LINK", "CSC_KEY_PASSWORD", "TK_SIGNING_PUBLISHER"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(`签名发布缺少环境变量：${missing.join("、")}。`);
}
console.log("Signing environment is configured.");
