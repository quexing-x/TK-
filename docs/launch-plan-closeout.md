# 批量创建可靠性第一阶段收尾记录

## 架构方案

批量创建计划会按“目标账户 × 表格行”拆分为持久化的 `launch_plan_items`。执行服务以数据库原子领取 item：成功项跳过、明确失败项可单独重试、已发出请求但结果无法确定的项标记为 `unknown`，禁止自动重试。

创建 Provider 显式使用 `templateMode`：

- `none`：禁止复制接口和按广告系列名称定位模板；
- `copy`：必须提供 `templateCampaignId`，只允许按该 ID 定位模板。

Cookie 创建链的远端调用采用 dispatch 边界：本地校验或 TikTok 明确拒绝归类为 `failed`；发送后的网络、超时、解析或响应不完整归类为 `unknown`。

## 终审结论

第一阶段实现已通过独立只读审查。收尾时发现 GitHub Linux CI 的一个 SQLite 迁移集成测试会偶发超过 Vitest 默认 5 秒；修复仅为该慢路径测试设置 15 秒的显式上限，未改变生产逻辑。独立 Reviewer 对该修复结论为无 P0/P1/P2，可提交。

## 验证结果

- 本地：`pnpm typecheck`、`pnpm test`、`pnpm build`、`git diff --check` 通过。
- 存储测试：完整测试连续运行 3 次通过。
- GitHub PR #1：CI `validate` 通过。
- GitHub PR #2：CI `validate` 通过，随后合并至 `master`。
- `master` 合并后 CI：`validate` 通过。
- 验证未调用真实 TikTok 接口；Provider 测试使用 Mock。

## 后续 P2

- [后台 Worker 与批量创建实时进度](https://github.com/quexing-x/TK-/issues/3)
- [按需加载 ExcelJS 以降低首屏包体积](https://github.com/quexing-x/TK-/issues/4)
