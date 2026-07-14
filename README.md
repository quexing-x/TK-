# TK Ads Automation

面向 TikTok 广告优化师的本地优先自动化管理工具。

当前阶段实现核心配置与双 Provider 只读接入：

- 自动化功能开关
- 账号配置管理
- 阈值配置
- Cookie / Official API 双 Provider 边界
- Windows DPAPI 加密凭据库
- 一次性 cURL 快速导入（自动解析账号、GET/POST、Payload 与凭据）
- 单账户连接检测
- 系列、广告组和广告只读同步
- 本地 SQLite 持久化和审计记录
- Web 置顶操作手册与自动生成 Markdown 手册

当前不会自动读取浏览器 Cookie，也不会向 TikTok 发起写入操作。用户可在
接入管理中粘贴只读列表请求的 cURL；系统自动解析并加密保存，随后只会重放
用户明确导入的 GET 或 POST 只读请求。

## 架构

```text
apps/web        可复用于 Web 与桌面壳的管理界面
apps/api        仅监听本机的 API 服务
packages/core   领域模型、校验和配置规则
packages/providers  Cookie / Official API 适配接口
packages/credentials Windows DPAPI 凭据库
packages/manual  Web 与 Markdown 共用的操作手册数据
packages/storage    SQLite 数据层
```

业务代码只依赖统一的 `AdsProvider` 接口。以后可以按账号选择 `cookie` 或
`official-api`，无需修改自动化开关和规则引擎。

## 本地启动

要求 Node.js 22 或更高版本，推荐 pnpm。

```powershell
pnpm install
pnpm dev
```

- 管理界面：http://127.0.0.1:5173
- 本地 API：http://127.0.0.1:3100

首次启动会在 `data/` 创建 SQLite 数据库和一个演示账号。

详细使用方式见 [docs/USER_GUIDE.md](docs/USER_GUIDE.md)。新增用户可见功能时，
必须按 [docs/FEATURE_DEVELOPMENT_CHECKLIST.md](docs/FEATURE_DEVELOPMENT_CHECKLIST.md)
同步补充教程，并运行：

```powershell
pnpm docs:generate
```

## 安全边界

- API 默认只监听 `127.0.0.1`。
- 不在数据库中保存明文 Cookie 或 Token。
- SQLite 的 `credentialRef` 只保存 Windows DPAPI 凭据文件的随机引用。
- cURL 中的 Cookie、CSRF、msToken、签名、完整 URL 和 Payload 均进入 DPAPI
  加密保险库，不以明文写入 SQLite。
- Cookie 请求只允许 TikTok 官方 HTTPS 域名，并禁止自动跟随重定向。
- 外部请求优先使用 HTTPS_PROXY/HTTP_PROXY；Windows 下未设置环境变量时自动继承当前系统代理。
- Provider 未通过连接检测时禁止只读同步。
- 所有配置变更写入审计日志。
