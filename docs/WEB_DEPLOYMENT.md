# Web 部署准备说明

当前 Web 版复用桌面端的 React 前端和本地 API。生产环境必须让页面与 `/api` 保持同源，不能把浏览器直接连接到暴露在公网的 `3100` 端口。

## 支持边界

- 服务端部署在 Windows x64；凭据库使用 Windows DPAPI，并绑定运行 API 的 Windows 用户。
- API 继续监听 `127.0.0.1:3100`，只由同机 HTTPS 反向代理访问。
- SQLite 与 DPAPI 凭据目录必须持久化、备份，并限制为服务账户可读写。
- 首次部署不迁移桌面端现有 Cookie、Token 或数据库；需要迁移时单独执行受控备份恢复。
- 不在仓库、构建产物或代理配置中写入 Cookie、Token、密码或 Webhook。

## 构建

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --filter @tk-auto/web build
```

静态文件输出到 `apps/web/dist`。前端使用相对 `/api`，无需注入生产 API 地址。

## API 环境

建议用专用、非管理员 Windows 服务账户运行：

```powershell
$env:TK_AUTO_HOST = "127.0.0.1"
$env:TK_AUTO_API_PORT = "3100"
$env:TK_AUTO_DB_PATH = "D:\Services\TK-Automation\data\tk-automation.db"
$env:TK_AUTO_CREDENTIAL_DIR = "D:\Services\TK-Automation\data\credentials"
$env:TK_AUTO_SECURE_COOKIES = "true"
pnpm --filter @tk-auto/api start
```

`TK_AUTO_SECURE_COOKIES=true` 只在外层入口已启用 HTTPS 时使用。生产环境必须启用，否则登录 Cookie 不具备 `Secure` 属性。

## HTTPS 与同源代理

仓库提供 [Caddyfile.example](../deploy/Caddyfile.example)。部署时替换域名和静态目录：

- `/api/*` 反向代理到 `127.0.0.1:3100`。
- 其他路径从 `apps/web/dist` 提供，未知路径回退到 `index.html`。
- 只开放 HTTPS 入口；不要对公网开放 Vite 开发服务器或 API 端口。

## 上线前检查

1. `GET /api/health` 返回成功。
2. 首次管理员初始化、登录、退出和 CSRF 写请求正常。
3. 刷新 `/#overview`、`/#automation` 等 Hash 路由不返回 404。
4. 重启 API 后 SQLite 数据仍在，DPAPI 凭据仍能由同一服务账户读取。
5. 备份与恢复目录已验证，日志不包含 Cookie、Token、密码或完整 cURL。
6. 仅使用测试 Provider 数据完成页面回归；真实 TikTok 操作仍需单独人工授权。

## 回滚

- 静态前端：保留上一版 `dist` 快照并原子切换目录。
- API：停止服务后回退代码，再启动同一服务账户。
- 数据：数据库结构发生迁移时，不直接覆盖现有 SQLite；先按运维中心流程生成并验证备份。
