# TK Ads Automation

面向 TikTok 广告优化师的本地优先自动化管理工具。

## Windows 桌面版 1.3.8

安装包：`apps/desktop/release/TK-Ads-Automation-Setup-1.3.8.exe`

- 适用于 Windows x64，双击安装后从桌面或开始菜单启动。
- 不依赖自建服务器；界面、本地 API、SQLite 和 DPAPI 凭据库均在本机运行。
- 用户数据保存在“文档\TK Ads Automation\data”，与安装目录分离。
- 首次安装并打开客户端时，会启动名为“tk自动化后台程序”的无窗口后台调度器，并默认写入当前用户的开机自启。
- 关闭客户端窗口会最小化到系统托盘并显示提醒；托盘菜单可完全退出客户端，后台程序继续运行。系统总开关关闭时会同时停止后台程序和开机自启。
- 后续升级先关闭程序，再直接运行更高版本安装包；不要先卸载旧版本。
- 固定 App ID `com.tkads.automation`，新版安装包覆盖程序文件并保留用户数据。
- 当前安装包未配置商业代码签名证书，Windows 可能显示未知发布者提示。

生成安装包：

```powershell
pnpm desktop:dist
```

当前版本实现本地检测、决策与受保护的双 Provider 状态管理：

- 用户管理中的账户自动化总开关
- 用户管理内的账户编辑、接入与连接状态轮询
- 九条全局规则配置（数值可修改、单条可启停）
- Cookie / Official API 双 Provider 边界
- Windows DPAPI 加密凭据库
- 首次启动开发者账户、本机登录、角色权限、HttpOnly 会话与 CSRF 保护
- 左上角软件总开关：关闭后暂停检测、定时任务、通知和真实广告写入
- 两段 cURL 快速导入（两个输入框、一个导入按钮、五个必要字段状态）
- 单条状态 cURL 自动生成三个层级的开启、关闭模板
- 多广告账户独立凭据与全账户共用自动化规则
- 系列、广告组和广告分页检测与指标标准化
- 账户启用后默认自动执行；检测预览始终只读
- Cookie 真实状态 cURL 模板与官方状态更新 API
- 忽略名单、手动启停、申诉队列和操作记录
- 广告组单次定时和每日过夜开关
- 90 天指标快照、日历范围与检测批次柱线组合图
- 邮箱、企业微信和飞书轮询结果通知
- 自动申诉、复制和删除的全局配置骨架（真实执行器待 Provider 请求）
- Excel/CSV 批量创建配置：账户统一选择、空白继承、逐行校验和多账户分发
- 相同广告多账户投放计划（真实创建执行器待 Provider 请求）
- 本地 SQLite 持久化、调度器和审计记录
- Web 置顶操作手册与自动生成 Markdown 手册

程序不会自动读取浏览器 Cookie。Cookie 用户通常只需在第 1 步导入一条
`/adgroup/list/?` cURL，并在第 2 步导入一条 `/ad/update_status/?` cURL，系统会扩展
三个层级的双向模板。自动化只处理当前时间向前 48 小时内创建的推广系列；
九条规则由全部账户共用，推广系列默认不应用，广告组和广告默认应用。账户总开关和
单条规则开关开启后即按轮询计划自动执行，不再设置额外执行模式或能力开关。

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
`official-api`，无需修改账户总开关和规则引擎。

## 本地启动

要求 Node.js 22 或更高版本，推荐 pnpm。

```powershell
pnpm install
pnpm dev
```

- 管理界面：http://127.0.0.1:5173
- 本地 API：http://127.0.0.1:3100

首次启动先在页面创建本机开发者账户；随后在 `data/` 使用 SQLite 数据库和演示广告账号。

详细使用方式见 [docs/USER_GUIDE.md](docs/USER_GUIDE.md)。新增用户可见功能时，
必须按 [docs/FEATURE_DEVELOPMENT_CHECKLIST.md](docs/FEATURE_DEVELOPMENT_CHECKLIST.md)
同步补充教程，并运行：

```powershell
pnpm docs:generate
```

## 安全边界

- API 默认只监听 `127.0.0.1`。
- 所有业务 API 默认要求登录；写操作同时校验 CSRF 和服务端角色权限。
- 密码使用 scrypt 随机盐哈希保存，会话只在 SQLite 保存不可逆令牌哈希。
- 不在数据库中保存明文 Cookie 或 Token。
- SQLite 的 `credentialRef` 只保存 Windows DPAPI 凭据文件的随机引用。
- cURL 中的 Cookie、CSRF、msToken、签名、完整 URL 和 Payload 均进入 DPAPI
  加密保险库，不以明文写入 SQLite。
- Cookie 请求只允许 TikTok 官方 HTTPS 域名，并禁止自动跟随重定向。
- 外部请求优先使用 HTTPS_PROXY/HTTP_PROXY；Windows 下未设置环境变量时自动继承当前系统代理。
- Provider 未通过连接检测时禁止检测和写入。
- 忽略对象、冷却期对象和超过单轮上限的对象不会执行。
- 连续三次写入失败会熔断本轮；启用规则命中时，手动关闭的对象也可能被重新开启。
- 所有配置变更写入审计日志。
