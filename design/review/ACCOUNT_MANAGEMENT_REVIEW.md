# 账户管理 — Review

状态：账户管理正式页与 Production UI rollout 已定稿，未发布、未部署、未提交 Git。

## 本轮结果

正式入口为 `#accounts`，可从侧栏“账户管理”进入；`#overview` 内的账户区也复用同一 Production workspace。所有正式路由统一由 `AccountShell` 提供侧栏、浅色画布和 topbar，旧书签与业务路由语义保持不变。账户接入和共享确认弹窗的图标改为 Phosphor，业务实现保持原有路径。

已提供搜索、账户状态/平台/自动化范围筛选、日消耗、最近同步、自动化开关、跨页选择、批量开关、分页、详情、编辑、接入和删除入口。状态概览可直接筛表；全局暂停时账户 Toggle 保留配置状态，并以降饱和状态及“已开启 · 全局暂停”说明当前不会执行。筛选变化清空选择，避免对隐藏筛选结果继续批量处理。批量变更显示可处理及跳过数量，逐账户保存并报告失败账户。

Drawer 按需读取现有自动化运行与广告操作接口，显示账户名称、ID、平台、类型、状态和最近同步时间，以及最后一次成功同步、账户自动化配置和真实能力链。正常能力节点保持紧凑；异常节点展开原因、最近失败时间和可执行恢复动作。最近异常与最近执行记录只展示少量记录，并提供“查看全部”对话框。底部操作按账户设置/重新接入与删除分组，删除仍需二次确认。关闭 Drawer 后不会继续读取活动记录。

设计规范：`../DESIGN_SYSTEM.md`。生产实现位于 `apps/web/src/AccountManagement.tsx` 与 `apps/web/src/ui/production/`，不导入 Playground 或 Review 数据。

## 验证

- 生产构建（包含 TypeScript 检查）通过；独立 `typecheck` 通过。
- Web 测试：29 个测试文件、176 个测试通过。
- 浏览器验收结果记录见 `verification.json`。
- 全正式路由验收结果记录见 `route-verification.json`，11/11 入口共享 Production shell，并通过侧栏、画布、active nav、无内部文案、无横向溢出和无玻璃模糊检查。
- 检查 1600px 宽屏与 1280px 桌面；较窄宽度只在表格内部横向滚动。
- 覆盖 hover、selected、loading、error/retry、empty、disabled、跨页选择、权限限制、批量部分失败、Drawer 活动读取、能力失败诊断与恢复入口、完整活动记录、破坏性确认、焦点约束和 Esc 返回焦点。

## 截图来源与边界

以下截图来自正式 App 的真实路由与组件，但账户和指标为独立浏览器的接口契约测试数据。浏览器拦截了全部 `/api/*` 请求，四次批量保存仅为模拟。没有登录真实账户，没有调用真实广告写入或连接检测。

本机 API 可达，但验收浏览器未登录，因此本轮不宣称已完成真实账户的登录后联调。生产代码使用现有 API，不包含演示数据后备路径。今日消耗显示账户时区下的日汇总；当前数据合同无法支持的 ROAS 已从账户页面移除。

| 截图 | 内容 |
| --- | --- |
| accounts-desktop.png | 1600px 账户列表及分页 |
| accounts-selected.png | 选中行与批量操作 |
| accounts-drawer.png | 账户详情及真实能力字段映射 |
| accounts-drawer-activity.png | 最近异常、最近执行记录与账户操作 |
| accounts-drawer-capability.png | 能力失败原因、最近失败时间与恢复入口 |
| accounts-loading.png | 指标加载 |
| accounts-error.png | 指标读取失败与重试 |
| accounts-filter-empty.png | 筛选无结果 |
| accounts-empty.png | 尚无账户 |
| accounts-readonly.png | 只读权限及禁用操作 |
| accounts-1280.png | 窄桌面表格滚动 |

复现浏览器验收：启动 Web 开发服务后运行 `node design/review/verify-accounts.mjs`。脚本自建临时 Edge 配置并在结束后清理；测试数据只存在于该脚本与浏览器拦截会话中。
