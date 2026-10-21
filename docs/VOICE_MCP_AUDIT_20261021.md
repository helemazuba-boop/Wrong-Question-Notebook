# Voice MCP 接入审计（2026-10-21）

本次覆盖 STD/PRO 流式对话、旧版非流式对话、Flash Realtime、内部 HTTP
执行接口、真实 PostgreSQL 写入，以及当前 Note4 固件的事件接收代码。
没有调用线上写入接口、修复历史数据或烧录固件。

## 日志能证明什么

用户提供的是应用容器日志，覆盖 2026-10-17 至 2026-10-21（UTC）。
10 月 20 日 09:15:59 和 09:17:04 的完成记录各有一次工具调用，但只有
`function_calls` 总数，没有名称、参数校验结果、事务错误码或写入回执。
因此不能仅凭这份日志将某条请求与“笔记写入失败”一一对应。

10 月 18 日 11:48:09 的日志明确出现
`DashScope chat tool loop exceeded maximum rounds`。ASR 空转写、fetch
失败、日报生成错误也存在，但没有证据表明它们导致了这两次笔记失败。

## 已确认并修复的问题

1. **笔记创建命令不符合真实表结构。** `executeVoiceWrite` 将
   `source_conversation_id` 当作 `notebook_notes` 的列。该列不存在，
   `private.mcp_insert_row_v2` 会返回 `invalid_insert_fields`，业务行不提交。
   修复为 `metadata.source_conversation_id`，并显式保存 `plain_text_v1`。
   新回归使用真实 voice 执行器生成命令，再调用 PostgreSQL RPC：修复前
   Note 失败、Todo 成功，修复后 Note 创建、重放和丢失响应恢复均通过。
   旧 SQL 测试手写了另一套有效命令，未覆盖实际 TypeScript 生成的错误列。
2. **Flash 结束事件与固件不一致。** relay 发送 `tool.done`，当前固件
   `flash_session.cpp` 识别的是 `tool.result` / `tool.error`。修复云端事件，
   同时保留调用 ID、`ok`、`display` 和错误码；不需要修改固件才能识别。
3. **HTTP 异常丢失失败语义。** Flash 曾将鉴权、请求格式、超时、网关错误
   全部缩成无 `error` 的失败。现在明确拒绝保留错误类别；写入请求在超时、
   断网或回执损坏后标为 `unknown_outcome`，提醒模型不要新建第二份。
   网络错误文字和服务端原始异常不进入模型结果或诊断日志。
4. **达到工具轮数上限后丢弃播报机会。** STD/PRO 和旧版对话原来在第四轮
   执行结束后直接抛错。现在保留最多四轮工具执行，随后进行一轮不提供工具的
   结果播报，保留已执行动作与回执，不再开放第五轮写入。
5. **取消后的迟到回执重启旧回复。** Flash 工具执行期间取消回复后，迟到
   结果原来仍会触发 `response.create`。现在将真实回执加入对话记录，但不
   重启已取消的回复，也不覆盖新一轮的设备工具状态。取消回复不会撤销写入。
6. **Note 声明与参数校验不够明确。** voice 不再向模型暴露由服务端管理的
   `client_request_id`；声明 UUID、非空正文、长度限制和可空的可选关联。
   JSON Schema 与运行时校验均验证这些情况，正文继续使用纯文本。
7. **缺少可关联的工具诊断。** 统一执行器现在记录工具名称、稳定请求 ID、
   设备/用户 ID、耗时、成功状态和安全错误码。笔记标题、正文、原始参数和
   数据库异常文本不写入这些日志。提示词要求解释失败原因，并区分权限不足、
   参数可修正和写入结果待确认。

## 八个工具的核查范围

| 工具                        | 执行路径及检查                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `create_notebook_note`      | 严格 voice 参数、设备绑定、事务内创建授权、真实表结构、原样换行、回执重放、丢失响应恢复、撤权后不返回回执 |
| `list_problem_sets`         | v2 读取器、当前用户过滤、科目筛选、稳定分页、智能错题本数量                                               |
| `list_problem_set_problems` | v2 读取器、目标本归属、手动/智能成员、分页游标                                                            |
| `search_user_problems`      | 用户错题范围、关键词/科目参数；浏览工作流仍由上两个工具承担                                               |
| `get_problem_detail`        | v2 题面、小题、结构化选项、答案来源、缺图状态、WQN 链接；图片链接不表示模型看过图片                       |
| `list_todos`                | 用户归属、状态/科目/数量校验                                                                              |
| `create_todo`               | 真实事务、原始相对日期指纹、账号时区、日期截止时间、不虚构提醒、稳定回执                                  |
| `update_todo_status`        | 真实事务、用户归属、固定状态枚举、幂等回执                                                                |

仍不提供 Word、已有笔记/题目内容修改或学习成绩写入。外部 MCP 工具契约
没有因本次 voice 修复而改变。Notebook 创建授权和账号/设备绑定仍由服务端及
事务重查，注入上下文不是授权凭据。

## 本地验证与发布

普通测试套件包含协议、签名/设备校验、错误回传、轮数上限、取消竞争及 Schema
回归。另有可选数据库测试，直接运行真实 TypeScript 执行器与已迁移的本地
PostgreSQL；不接受数据库网络 URL 或服务密钥，数据库名须以
`wqn_voice_test_` 开头，必须使用可丢弃的本地测试库：

```sh
cd web
WQN_VOICE_TEST_PG_CONTAINER=<local-container> \
WQN_VOICE_TEST_PG_DATABASE=wqn_voice_test_<suffix> \
npm test -- lib/__tests__/voice-write-database.test.ts
```

本次启用数据库测试后，全量 1,648 项通过、1 项跳过，包含四项真实数据库
回归。TypeScript、修改文件 ESLint、翻译、Web Webpack 生产构建、客户端
密钥扫描均通过；realtime-proxy Docker 构建及无网络模块加载检查通过。

本次没有新增迁移。发布需要更新 Web 和 realtime-proxy，并重连 Flash
会话以加载新的工具声明和提示词。历史永久失败的幂等请求不被自动重置，避免
更改既有操作结果。构建及本地数据库回归不代替真实设备和提供商验收。
