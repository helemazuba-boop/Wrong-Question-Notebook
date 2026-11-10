# OAuth Device Flow 与终端 Skill 验证线整合

本轮是云端本地集成 checkpoint，遵循 [持续验证流程](NOTE4_VALIDATION_WORKFLOW.md)。

## 来源与范围

验证线基线为 `e846c6583438eddb22db3d331c4b891c6df3bdd3`。在隔离整合工作树中，
仅将本次两个功能提交移入 `validation/note4`，保留原有验证线历史与其他功能。

| 功能                                                  | 原始功能提交 | 验证线对应提交 |
| ----------------------------------------------------- | ------------ | -------------- |
| 云端设备授权、用户确认页、发现元数据、事务 RPC 与回归 | `95fe47c`    | `9329181`      |
| 终端 OAuth CLI、Skill、恢复日志、可重现打包与使用说明 | `fd2634d`    | `5e123a1`      |

原始功能分支为 `feat/oauth-device-skill-20261110`，基于 `6dcfa40`。
其较旧的部署工具历史不属于本轮功能提交，没有随分支历史整体引入。
实现及初始独立验证见 [OAuth Device Skill](../OAUTH_DEVICE_SKILL.md)。

## 整合修正与回移状态

`web/lib/database.types.ts` 的 Functions 入口发生新增声明冲突：验证线已有
`opencode_agent_control_v1`，本次新增 `oauth_poll_device_authorization`。
解决方式是同时保留两个 RPC 类型，并追加设备授权表类型；没有替换已有接口。
本轮没有发现需要回移的额外运行时修复。

已核对两种语言的合并结果：保留验证线全部原有键，仅追加 `OAuthDevice`。
运行时代码、SQL、CLI 与 Skill 文件均与已验证的原始功能提交逐字节相同；
差异仅为数据库类型与语言文件保留了验证线原有上下文。

两个原始功能提交保留在功能分支。持续开发线 `fix/robustness-20261029` 的
归并不属于本次“提交并合入验证线”操作；不能把验证线整合解释为该开发线已同步。

## 整合后验证

- 完整 Vitest：197 个文件通过、4 个文件跳过；2149 项通过、11 项条件跳过。
- TypeScript：`npm run type-check` 通过。
- 生产 Webpack 构建通过，退出码为 0；使用明确的构建占位配置，没有读取生产 dotenv。
- 构建后客户端静态资源的服务端凭据泄漏检查通过。
- CLI 跨进程本地 HTTP 集成：19 项通过。
- i18n：两种语言均为 2573 个键，缺失、额外和占位符差异均为 0。
- 仓库提交钩子：ESLint 0 错误、164 个已有警告；Web 全量格式检查通过。
- Skill 校验与 ZIP 完整性检查通过；整合后的 ZIP 与功能分支产物完全一致。

构建日志与退出码保存在整合工作树的 `artifacts/validation-build-20261111.log`
和 `artifacts/validation-build-20261111.exit`。重跑时出现过 Webpack 缓存恢复告警，
随后完成编译、类型检查、页面生成和 standalone 打包；缓存文件不进入提交。

包路径为 `artifacts/wqn-terminal.zip`，SHA-256：

```text
a276ad8f63d20f3ddd79d50c422d69ffe8ce4f3f6af36a00fe6d644fa6c6a638
```

PostgreSQL 协议、回滚及真实并发兑换的证据沿用功能分支的独立验证。
本轮已核对设备迁移、SQL 回归、并发测试及原 OAuth 基础迁移的文件一致性，
没有重新执行整条验证线的数据库迁移。

## 验收与发布边界

上线前需要应用 `20261110000000_oauth_device_authorization.sql` 并部署 Web，
再以真实账号完成浏览器授权和目标 AI 客户端的持久化验收。
已有的未跟踪 Agent 迁移保持原样，不属于本次提交集。

本轮未执行 push、远端 CI、生产迁移、部署、真实账号授权或客户端验收；
也不改变既有设备候选包及其实机验收记录。
