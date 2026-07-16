# 中心登录服务测试版

这个独立模块让五名测试人员登录同一套隔离的数据，验证完整广告管理功能及集中账号权限。它不会改动正式桌面版的数据目录。

## 安全边界

- 服务监听局域网地址 `0.0.0.0:3180`，仅用于受控的局域网测试；不会自行开放公网端口。
- 每次启动都会关闭软件总开关；测试人员必须在界面中明确开启后，自动化才可能执行。
- 测试数据库、会话、DPAPI 凭据与正式桌面版隔离。
- 账号密码只保存于根目录 `.env.login-test` 和当前 Windows 用户可解密的 `private/login-test-credentials.dpapi`，均被 Git 忽略，禁止发送到聊天或提交到仓库。
- 如通过 HTTPS 反向代理访问，设置 `TK_AUTO_LOGIN_TEST_SECURE_COOKIES=true`，Cookie 会启用 `Secure`、`HttpOnly`、`SameSite=Strict`。

## 本机初始化

首次执行以下命令生成 1 个开发者和 5 个管理员账号。已存在的私密文件不会被覆盖：

```powershell
pnpm login-test:secrets
pnpm login-test:credentials:export
```

构建并启动完整测试版：

```powershell
pnpm login-test:start
```

本机访问 `http://127.0.0.1:3180/`；同一局域网的测试设备使用本机 IPv4 地址加端口，例如 `http://192.168.x.x:3180/`。跨设备前需确认 Windows 防火墙已仅对可信网络放行 TCP 3180。

测试管理员用户名为 `admin01` 至 `admin05`。若需复制单个密码到剪贴板（默认 60 秒后清除），在本机执行：

```powershell
& "apps/login-server-test/scripts/copy-credential.ps1" -Username admin01
```

## 不包含的内容

- 不包含公网暴露、端口转发或隧道部署。
- 不包含客户端安装包自动绑定/切换服务器。
- 公网使用前必须单独选择并配置受控的 HTTPS 接入方案。
