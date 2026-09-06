# TK Automation — Production Design System

状态：冻结，Production UI rollout 已完成。来源：已通过 Review 的 UI Playground V1.1 与 App Canvas refinement。后续页面复用，不探索新风格；正式路由统一复用 `AccountShell` 与本文件 tokens。

## 视觉基线

深色侧栏、浅色工作区、白色内容表面、单一主蓝色；中高信息密度，数据与操作优先。禁止营销式 Hero、Bento、装饰轨道、玻璃、光晕和新品牌色。表格不增加冗余外层卡片。

生产 tokens 位于 `apps/web/src/ui/production/tokens.css`，由 `.production-ui` 限定作用域。Playground 是独立内部校准资产，生产代码不得导入 `ui-concepts`。已批准的轻微背景明度层次仅用于工作区，不用于控件和内容装饰。

| 类别 | 冻结值 |
| --- | --- |
| 工作区 / 表面 / 次表面 | #eef2f5 / #ffffff / #f7f9fb |
| 主文字 / 次文字 / 辅助文字 | #17202a / #344255 / #5f6f80 |
| 主色 / hover / 选中背景 | #2856d8 / #1e43b6 / #e9efff |
| 成功 / 警告 / 错误 | #168a57 / #a86400 / #b93630 |
| 边框 / 加强边框 | #d9e1e8 / #bdcad6，1px |
| 侧栏 / 文字 / 激活 | #111827 / #c0ccda / #243b78 |
| 字体 | Segoe UI Variable, Microsoft YaHei UI, Segoe UI, sans-serif |
| 数字字体 | Consolas, SFMono-Regular, monospace；tabular-nums |
| 页面标题 / 节标题 / 正文 / 表格 / 辅助 | 28 / 16 / 13 / 12 / 11px |
| 间距 | 4 / 8 / 12 / 16 / 20 / 24 / 32px |
| 圆角：表面 / 控件 / 状态 | 10 / 6 / 4px |
| 控件高度 | 36px；紧凑行操作 28px |
| 阴影 | 0 2px 8px rgb(23 32 42 / 5%)；浮层 0 14px 34px rgb(23 32 42 / 14%) |
| 焦点 | 2px 主蓝 outline，2px offset |
| 内容宽度 | 最大1600px；侧栏240px；窄桌面表格横向滚动 |

## 复用组件

`apps/web/src/ui/production/primitives.tsx` 提供 Button、Badge、Checkbox、Drawer、EmptyState、Pagination、ControlRail。业务数据和文案必须由调用方提供，不含演示账户、示例指标或设计标注。图标仅使用官方 `@phosphor-icons/react`。旧页面既有图标体系不在本轮全局迁移范围内；新生产区域不得引用 Lucide。

交互要求：原生按钮与表单语义；可见焦点；按钮 loading/disabled 禁止重复提交；checkbox 支持半选；Drawer 使用原生 dialog，焦点约束、Esc、关闭后返回焦点。hover 只改变表面与边框，不平移表格；选中行用浅蓝及复选框共同表达。状态文字不可仅靠颜色。

Control Rail 只显示已存储凭据、连接检测、同步质量、创建能力、执行能力，不能将后一步缺失推断成前一步失败；各节点是独立能力事实，不是百分比进度。

## 正式内容与数据约束

正式界面只能出现业务状态、真实数据、操作、错误、风险、结果和必要上下文。禁止 Component、Spec、Token、Playground、布局尺寸说明等内部标注。实现说明仅保存在本文件与 Review 材料，不进入页面。

今日消耗使用现有 metric-days 接口，按账户时区、广告组层、自然日的健康快照汇总；保留采样截止时间。未返回指标不等于零，不推测币种。本页不展示当前数据合同无法支持的派生指标。账户状态沿用 accountAccessStatus；自动化开关沿用现有能力与权限校验，全局暂停和账户开关分开表达。

## 正式路由 rollout

11 个正式入口（`#overview`、`#accounts`、`#automation`、`#ads`、`#analytics`、`#launch`、`#rules`、`#notifications`、`#system-users`、`#maintenance`、`#manual`）均由 `AccountShell` 提供深色侧栏、浅色画布、topbar、运行状态与错误反馈。业务页保留现有 class 与数据行为，通过 `.production-ui` 兼容层收敛颜色、边框、圆角、控件高度和表格节奏；这不改变 API contract、路由语义或自动化行为。

`design/review/verify-routes.mjs` 使用隔离的 in-page API fixture 检查每个入口的 shell、侧栏颜色、画布颜色、唯一 active nav、内部文案和运行时异常，并输出 `design/review/route-verification.json` 与各路由截图。

## 本轮边界

新增独立 `#accounts` 账户工作台；旧页面布局与旧书签保留。账户编辑、接入、删除复用已有控制逻辑。批量操作仅改变选中账户的本地自动化开关，按账户记录成功与失败；不直接启停广告。未授权的线上广告测试、发布、部署不属于视觉验收。其余正式路由的页面级差异属于业务信息架构保留项，不作为新视觉探索入口。
