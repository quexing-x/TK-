# 新功能开发检查清单

每个用户可见功能完成前必须满足：

- 领域模型与 Provider 逻辑保持解耦。
- Cookie 与官方 API 的差异只存在于 Provider 包。
- 默认不启用写入型或破坏性操作。
- 敏感信息只进入环境变量、`.env` 或凭据库，禁止进入代码和日志。
- 为 API、存储和关键交互补充测试。
- 更新 `packages/manual/guide.json` 中对应教程。
- 执行 `pnpm docs:generate` 更新 `docs/USER_GUIDE.md`。
- 浏览器验证新功能和置顶操作手册。
- 确认 Web 与未来 EXE 均可复用新增业务模块。
