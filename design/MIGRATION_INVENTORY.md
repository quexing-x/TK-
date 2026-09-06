# TK Automation Production UI Migration Inventory

状态：rollout 完成（视觉统一，业务兼容层保留）。此文件是开发审计资料，不会在正式页面显示。

## 正式入口与页面

| Route | 页面组件 | 主要职责 | 当前迁移状态 |
| --- | --- | --- | --- |
| `#overview` | `OverviewPage` + account access | 平台接入状态、待办与入口 | 已统一 Shell；账户区使用 Production workspace |
| `#accounts` | `AccountManagement` | 账户、能力、同步、自动化开关 | Production baseline |
| `#automation` | `AutomationPage` / `AutomationFeaturesPage` | 检测、决策、执行与规则能力 | 已统一 Shell + Production 兼容层 |
| `#ads` | `AdsManagementPage` / `AllAccountsAdsView` | 广告组筛选、启停、计划、操作记录 | 已统一 Shell + Production 兼容层 |
| `#analytics` | `AnalyticsPage` / `AllAccountsAnalyticsView` | 指标扫描、趋势与同步批次 | 已统一 Shell + Production 兼容层 |
| `#launch` | `LaunchPage`、扩组、复制 | 创建、扩组、复制与进度 | 已统一 Shell + Production 兼容层 |
| `#rules` | `RulesPage` | 全局自动化规则与阈值 | 已统一 Shell + Production 兼容层 |
| `#notifications` | `NotificationsPage` | 通知渠道、测试与投递历史 | 已统一 Shell + Production 兼容层 |
| `#system-users` | `SystemUsersPage` | 用户、角色与权限 | 已统一 Shell + Production 兼容层 |
| `#maintenance` | `MaintenancePage`、`CleanupCandidatesPanel` | 备份、审计、升级与清理 | 已统一 Shell + Production 兼容层 |
| `#manual` | `ManualPage` | 操作手册与接入说明 | 已统一 Shell + Production 兼容层 |

代码中保留的 `MetaAssetsPage`、`MetaRulesPage`、`MetaConnectionPage` 属于现有业务实现；当前导航按现有 `pageFromHash` 规则不暴露已退休的 Meta 独立入口，不能借 UI rollout 改变该路由语义。

## Shell 与共享 UI

- `AccountShell` / `production.css` / `tokens.css`：已确认的 Dark Sidebar、Light Canvas、共享 topbar 与 Production tokens。
- 旧 Shell：`app-shell`、`sidebar`、`main-content`、`topbar`，需要收敛到 `AccountShell`，保留页面业务 class 作为兼容层。
- 共享交互目标：Button、Icon Button、Input、Select、Search、Checkbox、Switch、Tabs、Filter Bar、Status、Table、Pagination、Modal、Drawer、Toast、Empty、Loading、Error、Skeleton、Bulk Action、Confirmation。
- 新的 Phosphor 适配层：`apps/web/src/ui/icons.tsx`。正式页面不再直接依赖第二套图标库。

## 旧视觉与风险审计

- 16 个正式组件原先直接导入 `lucide-react`，已改为 Phosphor 适配层；依赖与 lockfile 已移除。
- 业务页面仍有大量旧 class（`panel`、`primary-button`、`field`、`table-wrap`、`status` 等），先通过统一 token/CSS 兼容层收敛，再按页面抽取，避免业务逻辑重写。
- 页面级 CSS 位于 `apps/web/src/ui/pages/`；这些文件只允许使用共享语义 token，不得继续新增页面私有颜色、圆角或阴影。
- 重点状态覆盖：默认、hover、focus、active、selected、disabled、loading、empty、error、warning、success、partial success、offline、permission denied、destructive confirmation。

## 验收证据与例外

- `design/review/route-verification.json`：11/11 正式路由通过 shell、颜色、导航和 runtime exception 检查；fixture 不访问真实 API。
- `design/review/verification.json`：账户工作台通过批量选择、分页、筛选、空态、加载、错误、只读权限、Drawer、能力诊断、恢复动作和破坏性确认等检查。
- 页面级业务组件仍保留原有 class（例如 launch 的步骤编辑、maintenance 的审计面板），只在 `.production-ui` 下由兼容层覆盖共享视觉属性。该例外用于保持业务可读性与行为稳定，不新增品牌色、玻璃或营销式装饰。
- Meta 独立入口继续按既有 `pageFromHash` 语义退休；本轮不重新暴露、不改路由或数据合同。

## 迁移验收边界

只调整布局、样式、组件复用、状态呈现和可访问性；不修改 API contract、自动化规则语义、任务执行行为或后端数据结构。所有截图与浏览器验收数据必须使用隔离 fixture，不能将视觉验收误报为真实账号联调。
