# OpenCode v2 链路审计与落地方案（2026-10-17）

原审计结论：基本链路能在 Windows OpenCode v2.0.16 上运行，但确认了 **6 项缺陷：2 项 P1、4 项 P2**。其中表单错误和重挂载丢失失败结果已通过真实服务复现；中止限流与轮询饥饿通过生产路由/函数的离线复现确认。审计阶段未修改项目源码；后续落地情况见本文最后一节。

**方案修订：** 本文末尾的“实施方案与验收”覆盖六项修复、统一模型配置和严格回退策略。以用户最新要求为准：**不提供新旧变量兼容；明确的提供方 429、余额不足和配额耗尽均归类为可回退错误。** 方案现已实现，新增验证结果与部署边界见“落地结果”。原审计段落保留修复前的复现结论。

**历史证据说明：** 原审计的 `/tmp/wqn-opencode-audit-20261017` 临时附件当前已不在工作区；下文保留路径作为历史记录。新增实现的可复跑脚本及脱敏证据已保存在 WQN 仓库，不能把旧附件视为当前仍可读取的验收产物。

## 原审计范围与证据边界

- 链路：Note4 `opencode_session.cpp` → `opencode_client.cpp` → WQN `/api/esp32/agent/*` → `opencode-agent-gateway.ts` / `opencode-agent-events.ts` → Windows OpenCode `/api/*`。
- WQN：`feat/mcp-v2-foundation`，HEAD `06fa1395c408d1d42d9be4949ee61a11f1300495`，审计期间工作区干净。
- 固件：`feat/ui-rewrite`，HEAD `33e1a2955ece1fdb863602023b7575981e0a4649`。工作区原有 UI 改动，审计期间也有其他工作继续修改，其中包括 `opencode_session.cpp`；本报告保留它们，固件代码结论针对读取时的工作树，不代表仅 HEAD。
- Windows 实例：进程 `opencode-cli.exe`，安装路径包含 `cli/2.0.16`，监听 `127.0.0.1:49374`。
- 实例的 `/openapi.json` 已保存为 [openapi.json](/tmp/wqn-opencode-audit-20261017/openapi.json)，SHA-256 `619712f2785c3aabb05f8df1a535d3dce59c97e158106544c9cea558f8c0eac7`。它明确说明 `/api/event` 跨所有 server locations，且断线期间事件会丢失。
- 实测使用当前生产网关和事件投影函数的 TypeScript 转译副本，仅替换模块导入路径并移除 `server-only` 的运行环境哨兵；不改业务逻辑。准备入口：[prepare.mjs](/tmp/wqn-opencode-audit-20261017/prepare.mjs)。源文件摘要：[source-hashes.txt](/tmp/wqn-opencode-audit-20261017/source-hashes.txt)。
- Windows 测试使用独立的 `%TEMP%\wqn-opencode-audit-20261017` 目录和新建会话。全部 12 个测试会话均已通过 DELETE 返回 204 清理；中止测试没有批准工具执行。
- 真实调用覆盖 **网关函数 ↔ Windows OpenCode ↔ 模型**，未经过真实设备 Bearer 鉴权、部署中的 Next.js、反向代理或实际 ESP32。离线路由测试模拟设备鉴权。不能据此宣称生产环境或设备 HIL 通过。

## 已确认缺陷

### AUD-OC-01 · P1 · 运行额度耗尽后无法中止任务

位置：[interrupt/route.ts:25](/home/unknow/projects/WQN/web/app/api/esp32/agent/sessions/[id]/interrupt/route.ts:25)，[opencode-agent-rate-limit.ts:31](/home/unknow/projects/WQN/web/lib/opencode-agent-rate-limit.ts:31)，[constants.ts:103](/home/unknow/projects/WQN/web/lib/constants.ts:103)。

运行和中止都调用 `enforceAgentRateLimit(deviceId, 'run')`，共用每设备 **6 次 / 5 分钟** 的额度。一个设备在窗口内提交第 6 次运行后，随后的中止会直接得到 `429 rate_limited`；请求尚未到达 OpenCode，任务继续运行。中止本身也消耗提交额度。

复现：用真实限流器消费同一设备的 6 个运行槽，再调用真实 interrupt 路由。结果为 **429，上游调用次数 0**。测试模拟鉴权，不依赖数据库或模型。

复现文件：[audit-routes.test.ts](/tmp/wqn-opencode-audit-20261017/audit-routes.test.ts)。该测试通过表示缺陷被复现，不表示功能修复。

建议：为中止使用独立桶，保留适度的自身限流；提交额度耗尽不应阻止用户停止正在执行的工作。回归应覆盖“第 6 个运行仍在执行时，中止仍可到达上游”。

### AUD-OC-02 · P1 · 其他会话持续输出会饿死权限、提问和结束探测

位置：[opencode-agent-events.ts:957](/home/unknow/projects/WQN/web/lib/opencode-agent-events.ts:957)。

relay 每次循环重新执行 `Promise.race([pendingRead, sleep(pollIntervalMs)])`，只在本次等待没有读到字节时轮询。OpenCode 的 `/api/event` 跨所有 locations；只要任意会话持续以小于默认 2 秒的间隔输出，定时分支就无法运行。即使所有收到的事件都因 session 不匹配而被丢弃，也会不断推迟轮询。

影响：目标会话正等权限或提问时，设备可能一直收不到交互；已错过终止事件的 observe 也可能无法结束。这不是单纯延迟一次轮询，在持续流量下没有到期保证。

生产 `relayOpenCodeEvents` 离线复现：轮询周期设为 30 ms，运行约 150 ms。静默上游执行了 5 次 active 探测并发出 `agent.permission`；每 5 ms 注入另一个 session 的合法事件后，**active 探测 0 次、交互帧 0 个**。比例对应默认周期，未依赖实际模型造流量。

复现：[offline.mjs](/tmp/wqn-opencode-audit-20261017/offline.mjs)，输出：[offline-results.jsonl](/tmp/wqn-opencode-audit-20261017/offline-results.jsonl)。

建议：以绝对到期时间安排轮询，或让定时任务独立于读事件；读取无关事件不能重置探测期限。增加连续无关事件与 pending ask 同时存在的回归。

### AUD-OC-03 · P2 · 多选表单显示为可答，实际答案类型错误

位置：[opencode-agent-gateway.ts:1353](/home/unknow/projects/WQN/web/lib/opencode-agent-gateway.ts:1353)，[opencode-agent-question-sequence.ts:190](/home/unknow/projects/WQN/web/lib/opencode-agent-question-sequence.ts:190)。

`projectForm` 接受 `multiselect` 并展示选项，但投影丢掉了字段类型；设备回复是字符串，sequence 也只保存字符串。最终发送 `{answer:{choice:"a"}}`，而真实 v2 多选字段要求字符串数组。

Windows 实测：新建 `multiselect`，生产投影正常给出 A/B；调用生产回复函数发送字符串得到 **HTTP 400**。对同一个表单发送 `{answer:{choice:["a"]}}`，得到 **204**，详情变为 `answered`。

建议：保留字段类型和 `minItems/maxItems`。单项可满足约束时可映射为单元素数组；要求多个选项而设备无法表达时，应提供完整的多选交互或明确转到 OpenCode 端回答，不能继续作为普通单选提交。

### AUD-OC-04 · P2 · 混合必填表单被裁成无效的部分答案

位置：[opencode-agent-gateway.ts:1346](/home/unknow/projects/WQN/web/lib/opencode-agent-gateway.ts:1346)，[opencode-agent-question-sequence.ts:134](/home/unknow/projects/WQN/web/lib/opencode-agent-question-sequence.ts:134)。

投影没有保留 `required` 等表单约束，sequence 只选择有 1–8 个选项的字段。表单同时有可选字段和设备不能表达的必填字段时，后者被略过；答完可选字段就把不完整答案提交。只有完全没有可答字段时才提供 `options: []` 的退出交互，混合表单未受到这个保护。

Windows 实测：表单含必填的 `choice` 单选和必填的 `number`。只发送 sequence 能收集到的 `{choice:"a"}` 得到 **400 `FormInvalidAnswerError`**；补齐 `{choice:"a",number:1}` 得到 **204**。当前“跳过其余字段，最后一次提交”的策略在这个合法表单上无法完成。

建议：按整个表单的完成条件判断设备是否可答。存在无法满足的必填字段时应明确转到 OpenCode 端回答，并保留中止出口；不要向用户展示最终必然失败的提交。

### AUD-OC-05 · P2 · 截断选项值破坏了上游选项身份

位置：[opencode-agent-gateway.ts:1366](/home/unknow/projects/WQN/web/lib/opencode-agent-gateway.ts:1366)。

`value` 会被截到 256 个 code points，然后由设备原样发回。这里截断的是上游校验的身份值，不能像展示标签一样裁剪。

Windows 实测：合法字符串选项值为 300 个 `x`，投影变为 256 个。发送投影值得到 **400 `FormInvalidAnswerError`**；对同一表单发送原始 300 字符值得到 **204**。有共同前缀的长选项还会被映射成同一个值。

建议：通过有界的代理选项 ID 映射回原值，或把无法无损传输的字段转为 OpenCode 端回答；不要改写答案身份。

### AUD-OC-06 · P2 · 重新挂载把失败和中止统一折叠为 idle

位置：[opencode-agent-events.ts:878](/home/unknow/projects/WQN/web/lib/opencode-agent-events.ts:878)，设备消费处：[opencode_session.cpp:1422](/home/unknow/projects/firmware/firmware/wqn-zectrix-note4/main/opencode_session.cpp:1422)。

observe 在 session 不 active 且有任何非空 `outcome` 时，只发送 `agent.status {status:"idle"}`。`failed`、`interrupted` 与 `succeeded` 的结果因此无法区分；设备没有收到失败帧，会走 `!g_run_failed` 的完成分支。历史文本不能补回已经丢失的终态语义。

两条真实 Windows 复现：

1. 不可用模型导致真实 run 终态为 `failed`；重新挂载生产 relay 只得到一个 idle，没有 `agent.error`。
2. 使用 StepFun `step-3.7-flash` 在权限等待处调用生产中止函数，返回 `interrupted:true`，会话真实终态为 `interrupted`；重新挂载仍只得到一个 idle。

离线用三个终态分别探测，结果也完全相同。实时连接中，失败/中止事件的映射能正确发出错误加 idle；缺陷限定在错过这些事件后的恢复路径。

建议：根据明确的 outcome 重建终态，失败和中止先发对应 `agent.error`，再发 idle；补充两种非成功终态的 observe 回归。

## 实际验证结果

| 检查 | 结果 | 证据层级 |
| --- | --- | --- |
| 7 个 OpenCode/契约测试文件 | 207 项通过 | 离线单测 |
| 转写流与 UTF-8 截断测试 | 14 项通过 | 离线单测 |
| 固件 agent round policy | 1220 checks，0 failures | 主机 C++ |
| 中止额度耗尽复现 | 路由 429，上游 0 调用 | 模拟鉴权、真实路由/限流器 |
| 持续无关事件下轮询 | 0 次探测，未投递权限 | 真实生产 relay、模拟 SSE |
| 独立目录 A/B 的会话列表 | A 不见 B，B 不见 A | Windows 实际 API |
| 三种表单缺陷及完整答案对照 | 错误答案 400，对照答案 204 | Windows 实际 API |
| 已答表单是否还在 pending list | 不在；detail 为 answered | Windows 实际 API，排除了一个候选疑点 |
| StepFun `step-3.7-flash` 文本/推理流 | succeeded，回答 WQN_AUDIT_OK | 真实模型 + 生产网关函数 |
| StepFun echo 权限 once 回复 | permission → tool 完成 → succeeded | 真实模型 + 实际权限 API |
| StepFun 单选提问 A/B | question → 回复 A → succeeded | 真实模型 + 实际表单 API |
| StepFun 中止权限等待中的 run | interrupted:true，终态 interrupted | 真实模型 + 实际中止 API |
| StepFun 历史回填 | 正常执行的三个测试均含预期回答 | Windows 实际 API + 生产投影 |
| `failed` / `interrupted` 重新挂载 | 只发 idle，缺陷复现 | Windows 实际 API + 生产 relay |
| `opencode/deepseek-v4.1-flash-free` | 提供方返回 Rate limit exceeded | 已尝试，正常执行未通过 |
| 首次选用的旧 `opencode/cat-jam-free` | Model unavailable | 环境模型不可用；用于验证 failed 恢复 |
| 用户后续限定模型之前的一条默认模型请求 | 文本与历史通过 | `magpie/workbuddy-ai/deepseek-v4.1-flash`，不等同于 Free 验证 |

正常流程的 Windows 入口：[free-live.mjs](/tmp/wqn-opencode-audit-20261017/free-live.mjs)。脚本名称沿用最初 Free 探测，实际模型由环境变量指定：

```powershell
$env:WQN_AUDIT_PROVIDER = 'stepfun'
$env:WQN_AUDIT_MODEL = 'step-3.7-flash'
$env:WQN_AUDIT_LABEL = 'step'
node '\\wsl.localhost\Ubuntu\tmp\wqn-opencode-audit-20261017\free-live.mjs'
# 单独验证中止及恢复：在同一命令后加 --interrupt-only
```

脚本在 Windows 进程内读取本机 OpenCode service 凭据，不将口令写入命令参数。`echo` 权限只对脚本指定的固定命令批准；其他工具请求拒绝。表单边界复现与 failed 恢复入口：[live.mjs](/tmp/wqn-opencode-audit-20261017/live.mjs)。

离线复现命令：

```sh
node /tmp/wqn-opencode-audit-20261017/prepare.mjs
node /tmp/wqn-opencode-audit-20261017/offline.mjs
cd /home/unknow/projects/WQN/web
node_modules/.bin/vitest run --config /tmp/wqn-opencode-audit-20261017/vitest.config.mjs
```

## 其他核对与后续验证

- **固件静默流下的回复延迟，源码证据，未做 HIL：** [opencode_client.cpp:528](/home/unknow/projects/firmware/firmware/wqn-zectrix-note4/main/opencode_client.cpp:528) 的 EAGAIN 分支直接 continue，唯一的 `DrainOutboundReplies` 在 [581 行](/home/unknow/projects/firmware/firmware/wqn-zectrix-note4/main/opencode_client.cpp:581)。用户在收到 ask 后稍晚作答，而 SSE 暂时无新字节时，回复队列要等后续流量才会发送。按当前网关默认心跳推算，等待可接近 14 秒，另加请求耗时；这个时延尚未经设备计时。建议在每次短读等待前处理队列，保持单 worker 所有权，并在 HIL 测量点击到 POST 的时延。
- **契约镜像：** 两端 schema SHA-256 相同：`66dd0e0aa64eb1e074af29440bc712f18b8cf11cd2af4b9320a313e97755332d`。manifest 不完全一致：云端少了固件的 `sse_line_bytes:16384` 和 `json_nesting_depth:32`。本次没有观察到由此造成的线上兼容错误，不能把 schema 相同写成整个目录完全一致。
- **现有 smoke 有误报通道：** [opencode-gateway-smoke.mjs:174](/home/unknow/projects/WQN/web/scripts/opencode-gateway-smoke.mjs:174) 用所有 `<500` 状态判断权限路径已路由；[207 行](/home/unknow/projects/WQN/web/scripts/opencode-gateway-smoke.mjs:207) 将未拿到响应前的 AbortError 也记为 SSE PASS。该脚本不能单独作为本次链路验收依据。本次调用真实生产函数，另有明确的状态/内容断言。
- 本轮没有验证生产绑定、真实 Supabase 幂等 RPC、设备鉴权、断网/重连/深睡、内存压力、子代理交互的设备行为，也没有固件完整构建或设备 HIL。主机检查与 Windows 实调的通过范围仅如上表。
- 修复顺序建议：先处理 AUD-OC-01/02，随后修复表单投影及答案建模，最后补齐恢复终态和上述回归。此报告仅记录问题与建议，没有落地修复。

## 实施方案与验收（按用户最新要求修订）

### 1. 已确定的规则

1. 外部模型配置统一为 `provider/model#variant`。直接移除旧环境变量及用户绑定中的旧模型字段，不实现双读、转换、弃用期或新旧值优先级。
2. **提供方 429、余额不足、配额耗尽属于 fallback 类错误。** 此规则替代先前对余额不足不自动回退的建议。分类与是否可以安全执行自动回退分别判断。
3. 一个逻辑任务最多一次主模型到备模的自动切换；备模失败即结束，不轮询模型列表，不切回主模型，不新增任务重试链。
4. 已有可见文本、推理输出、工具请求或子代理启动的任务，不自动重放。此时仍记录原因为 fallback 类错误，但返回“需要确认后继续”的结果；本次变更不自动追加用户消息或执行第二遍工具。
5. 所有重连、并发请求、服务重启及同一请求的重试，共用持久化的回退次数与预算。用户取消和本地预算耗尽优先于回退。
6. 严格预算在实际模型请求发出前执行。仅靠 SSE 的 usage 事后统计，不作为严格 token 上限的实现。

### 2. 统一模型配置：直接切换，没有旧变量兼容

新环境变量形式如下；主备模型顺序为部署示例，模型验证授权不等同于已确定的生产主备顺序：

```dotenv
WQN_OPENCODE_MODEL=stepfun/step-3.7-flash
WQN_OPENCODE_FALLBACK_MODEL=opencode/deepseek-v4.1-flash-free
WQN_OPENCODE_FALLBACK_ENABLED=false
```

`WQN_OPENCODE_MODEL` 在网关绑定启用时必填；回退关闭时可省略备模，回退开启时备模及预算策略必须完整。主备不能相同。模型 ID 区分大小写，只在第一个 `/` 分离 provider，保留模型自身的其他 `/`；`#variant` 独立校验。格式依据 [OpenCode v2 模型引用规则](https://opencode.ai/v2/docs/models#references)。

用户绑定 JSON 同步改为 `model`、`fallbackModel`、`fallbackEnabled` 及经 schema 校验的回退策略，沿用绑定对象的整体覆盖方式，不拼接其他用户的凭据或配置。具体规则：

- 删除 `WQN_OPENCODE_PROVIDER_ID` 和 `WQN_OPENCODE_MODEL_ID` 的读取、示例、部署透传及相关正向测试。
- 删除用户绑定外部输入中的 `providerId`、`modelId` 旧字段。部署预检和绑定 schema 遇到旧配置直接报错，提示替换；不会根据旧字段补全新配置。
- 内部仍转换成 OpenCode API 必需的 `{providerID,id,variant?}`。这是上游接口映射，不属于旧配置兼容。
- 同步更新 `web/env.example`、生产模板适用部分、`deploy/build-and-push.ps1`、`deploy/release-env-policy.sh`、部署测试与契约 README。真实环境文件在部署时按新键一次替换，本次文档更新不修改它们。
- 提交任务前在绑定的 directory/location 中读取模型目录，校验启用状态、工具能力、variant 和上下文约束；使用目录接口，不发送付费健康探测。`enabled` 不能证明账号有余额或提供方未限流。
- 禁止模型缺失时使用 OpenCode 自选默认值。对已有会话先核对实际模型；运行中的会话不被环境变量更新改写，任务策略在首次 claim 时固定。
- 对桌面已有会话，自动运行仅接受显式许可的模型与受控调用边界；名单外模型或不可归因的活动请求返回明确错误，不悄悄更改桌面模型。

### 3. 错误分类：429 和余额不足进入 fallback

由 provider 适配边界保留原始状态码、提供方错误码、来源、配额作用域及可用的 Retry-After，再转换成网关的统一错误。当前 v2 的 `Session.StructuredError` 只保证 `type/message/status?`，不足以保证每种提供方的余额错误码均保留；需在适配层补齐证据，不能把“Rate limit exceeded”文案当成已经验证的 HTTP 429。

| 来源与错误 | 归类 | 行为 |
| --- | --- | --- |
| 模型目录确认主模型不存在、禁用或不可用 | `model_unavailable`，fallback | 提交前检查备模与预算，最多切换一次 |
| **提供方 HTTP 429** | **`provider_rate_limited`，fallback** | 不继续反复调用主模型；按执行门槛尝试备模 |
| **提供方明确余额不足、HTTP 402 或配额耗尽** | **`provider_quota_exhausted`，fallback** | 根据实际状态/错误码归一化；检查备模的计费及配额池 |
| 提供方通过 429/403 等返回明确的 `insufficient_quota`、`insufficient_balance` 等代码 | `provider_quota_exhausted`，fallback | 使用按提供方验证过的错误码映射；不把所有 403 当成余额不足 |
| 明确的提供方服务故障，且能确认当前调用已经失败终止 | `provider_unavailable`，fallback 候选 | 同样受执行门槛限制；代理 502 等执行状态不明时不自动调用备模 |
| WQN 设备运行限流返回 429 | `local_rate_limited` | 保持限流，不借回退绕过；中止使用独立额度 |
| WQN 本地任务或用户预算耗尽 | `budget_exhausted` | 停止任务，不转向备模继续消费 |
| OpenCode Basic Auth 或提供方普通鉴权/权限错误 | `authentication_failed` / `forbidden` | 报错，不自动回退；明确余额代码按余额不足规则处理 |
| 参数错误、上下文超限、内容拒绝、工具或表单失败 | 对应业务错误 | 不自动回退 |
| 提交超时、断线、未知执行状态、无法归因的错误 | `execution_unknown` | 核对原任务状态并恢复观察；禁止再提交任务 |
| 用户取消 | `cancelled` | 终止，不进入回退 |

配额耗尽时，备模若明确共用已耗尽的账号/计费池，跳过无效调用；模型级限流且备模使用独立额度时可切换。不能仅凭 provider ID 不同认定配额池独立，也不能仅凭模型名包含 Free 或 catalog 的 cost 为 0 就认定可无限使用。

回退策略应有明确的配额组信息；作用域不明时，不向可能共用已耗尽配额的备模盲目发请求。提供方的 Retry-After 或本地冷却会影响后续主模型准入，不能阻塞正在处理的用户中止。

### 4. 自动回退的执行门槛与幂等

自动回退需要同时满足：

- 本次错误属于上表的 fallback 类，备模已显式配置并通过校验，回退开关开启。
- 这是该逻辑任务的首次模型轮次，尚无文本/推理输出，未开始工具请求、子代理或其他执行副作用。
- 主模型本次调用已明确失败并停止，不存在仍在重试、后台生成或执行状态不明的调用。
- 任务未取消，备模未处于不可用的配额组/冷却状态，且剩余 token、物理请求次数、步数和时间预算足够。
- 原子获得该任务唯一回退名额及用户并发名额，并成功持久化预算预留。

预检发现主模型不可用直接选择备模，也消耗该任务唯一的回退名额和用户回退额度。切换后本任务后续轮次固定使用备模；不得因为一次成功而重新获得切换次数。新任务重新评估路由，主模型仍在冷却时直接使用备模也必须记入回退额度。

持久化数据至少包含 `device_id/request_id/session_id`、策略版本及快照、主备引用、实际模型、回退次数、错误来源/类型/状态/提供方码、调用及预算记录、取消状态。`request_id` 重放读取原策略，不因部署更新重新选模。

在既有 `esp32_agent_run_requests` claim/complete 协议上扩展尝试与预算账本，通过事务、锁和唯一约束保证并发安全；预算按用户汇总，覆盖同一用户的多个设备。同一 session 的执行路由要串行化，避免两个设备同时切换模型。每次尝试有独立 attempt ID，过期尝试不能覆盖更新后的任务状态；超时预留不能因 TTL 到期就假定上游已停止并释放额度。

旧固件未提供 `request_id` 时，保留单模型运行能力，但不开放自动回退。这是任务幂等门槛，不是旧环境变量兼容。

回退期间通过现有 `agent.status {status:"retry",message:...}` 展示切换原因和实际模型；可恢复的主模型错误不会先作为致命 `agent.error` 发到设备。最终失败才发错误加 idle；重连恢复同一结果和回退记录，不重新开始尝试。详细提供方错误及账本留在服务端，不把密钥或原始响应体发给设备。

### 5. 实现层次：配置/账本在 WQN，物理调用控制在 provider 边界

本机 v2.0.16 的 OpenAPI 明确：`POST /api/session/{id}/model` 只影响后续 provider turns，`POST /api/session/{id}/generate` 生成不写历史的临时文本，`POST /api/session/{id}/prompt` 则持久接纳一条新输入。因此不能把“切换模型 + 再发一次原 prompt”当成可靠的恢复原语。

- **WQN 网关**负责配置解析、设备及会话鉴权、逻辑任务 claim、策略快照、错误状态、用户额度与取消、设备 SSE 投影。
- **OpenCode/provider 适配边界**负责识别每个真实模型调用、归因到逻辑任务、调用前预算准入、处理首次调用的 429/余额不足等错误，以及在同一逻辑推理请求内最多一次切换。不会再向 session 追加一份原始用户 prompt。
- 先用本机 v2.0.16 做能力验证，检查可用扩展点是否覆盖调用前、调用失败和用量结算；能满足要求时使用原生扩展。若不能覆盖，就采用专用 provider 适配器或兼容代理，且必须有可靠的任务身份传递，不能靠全局可变配置猜测当前任务。
- 如果上述边界尚不能阻止原生重试、计入子代理调用或可靠归因，运行期自动回退不能验收，也不能启用。提供方 429/余额不足仍按 fallback 类记录，但不能通过网关重复 POST prompt 代替缺失能力。该能力验证与适配实现属于交付工作，不留作上线后的假设。

官方当前文档说明 OpenCode 会重试部分超时请求，且 `settings` 是否生效依赖 provider package；需要用实际调用计数证明本机适配有效，不能仅配置一个未经验证的 `maxRetries` 字段。[来源](https://opencode.ai/v2/docs/providers#timeouts)

### 6. token 与调用次数的严格限制

**硬规则：** 每任务最多一次主→备切换；每用户最多一个自动回退任务并发；同一失败模型的底层自动重试不能绕过物理调用账本。一次切换不等于整个 Agent 任务只有两次请求，正常工具轮次与每次物理重试都要单独计数。

启用回退必须显式配置以下额度并通过有限正整数/上下界校验；缺少预算配置、计数存储不可用或无法可靠估算请求上界时，拒绝开启自动回退：

| 额度 | 作用 |
| --- | --- |
| `maxInputTokens` | 限制每次回退请求携带的上下文，包含历史、系统提示和工具定义 |
| `maxOutputTokens` | 提供方实际执行的每次输出上限；推理 token 按真实提供方口径计入，不能漏算 |
| `maxTotalTokens` | 原主模型和备模共用的任务总额度，切换不清零 |
| `maxProviderRequests` / `maxSteps` | 分别限制物理发送次数和 Agent 轮次，重试不伪装成不计费轮次 |
| `maxDurationMs` | 任务绝对期限，切换和重连不延长 |
| `maxFallbacksPer24Hours` / `maxUserTokensPer24Hours` | 用户滚动窗口的回退次数及累计额度，覆盖多个设备 |
| `cooldownMs` | 对明确限流、余额耗尽及连续失败施加冷却 |

初始冷却 10 分钟、用户滚动 24 小时最多 3 次自动回退可作为保守部署起点；具体 token 额度在部署策略中显式设定，不依据模型名称生成默认的无限额度。这些是方案建议值，不表示已修改生产配置。

每次物理发送前，原子预留“该请求输入上界 + 最大可能输出”并检查剩余额度；输入估算必须有针对模型/包验证过的保守上界。主任务、备模、子代理以及为该任务触发的维护调用共同计入。按提供方实际口径归一化缓存与推理 token，避免漏计；不能把缓存 token 当作免费。

结束后用实际 usage 结算，失败且没有可靠用量时继续保留预留。没有证据证明请求未计费时，不自动把失败请求记为零。预算及取消检查位于每次真实发送之前；事后 usage 达限时也发中止，但不把这个补救称作硬上限。

OpenCode 的 Agent `steps` 在新用户输入时会重置，最后一步还会要求模型总结，所以 steps 不能代替上述持久累计预算。[来源](https://opencode.ai/v2/docs/agents#steps)

### 7. 四个实施单元及验收顺序

| 顺序 | 变更范围 | 必须通过的验收 |
| --- | --- | --- |
| 1. 控制与恢复 | AUD-OC-01/02/06；中止独立桶、绝对时间轮询、按真实 outcome 恢复终态；固件静默循环处理回复队列 | 运行额度耗尽仍能中止；连续无关 SSE 不阻止权限/提问/终态探测；failed/interrupted 重挂载保持结果；回复不依赖下一次心跳 |
| 2. 表单建模 | AUD-OC-03/04/05；保留类型/required/选择约束；按整个表单判断可答性；完整 option 值的有界代理映射 | 多选数组成功；缺失必填项不提交；300 字符 option 无损还原；共同长前缀不碰撞；重连及映射过期不误答 |
| 3. 配置与账本 | 新配置一次切换，删除旧键；部署校验/透传；持久化策略、取消、尝试及预算；并发约束 | 新键完整透传；旧键/旧用户绑定字段明确报错且无法提供模型值；同 request 重连不增加次数；重启不丢额度；多设备和 session 并发受控；过期 attempt 不覆盖新状态 |
| 4. provider 回退与集成 | v2.0.16 扩展能力验证、必要适配；429/余额不足归类；同一逻辑推理调用切换；物理调用前限额；通知与恢复 | 主模型 429→备模成功；明确余额不足→独立配额备模成功；备模再次 429/余额不足即结束；无重复 prompt/工具；隐藏重试计数正确；输入/输出/总量/时间/并发/窗口额度均不可绕过 |

六项缺陷保持独立回归，避免新增回退逻辑掩盖原始失败。最小交付不需要新增设备 SSE 事件类型；需要调整设备 JSON 形状时，同步云端及固件 schema、manifest、fixture 和解析器。

验证优先使用无费用的假 provider 注入标准 429、402、余额不足、5xx、超时及部分输出错误，精确记录真实发送次数和入参。预算、重启、并发和幂等还需真实测试数据库验证；现有 mock 测试不足以证明事务约束。不能为了测试余额不足反复调用付费提供方。

Windows 实调仅用已授权的 `stepfun/step-3.7-flash` 和 `opencode/deepseek-v4.1-flash-free`，限定临时目录、固定提示和调用预算。Free 模型若仍被限流，记录环境阻断；使用可控 provider 的 429 注入验证回退逻辑，不把一次错误文案当成完整回退验收。

固件变更使用现有 build-wsl，要求 0 warnings、M8、主机相关检查和 CRLF-aware diff 检查；随后做设备 HIL：静默等待后点击回复、中止、断线恢复、失败/中止状态展示。生产绑定、部署和完整 HIL 仍分别记录验证结果。

发布使用同一次配置切换移除真实环境中的旧键，先安装修复与账本/provider 控制能力，回退开关保持关闭；全部验收完成后启用。上述为批准的实施方案。当前源码及验证结果如下；生产环境切换仍未执行。


## 落地结果（2026-10-17）

已完成源码修复和受控回退实现；实现与验证阶段未执行远端推送、生产部署或刷机。WQN 基于 `06fa1395`，固件基于当前 `438eb620` 的工作树。以下验证针对此次改动，不复用旧临时附件作为新增功能通过依据。

| 项目 | 当前实现 |
| --- | --- |
| AUD-OC-01 | interrupt 独立限流桶；用尽 6 个运行槽仍可调用中止 |
| AUD-OC-02 | 绝对时间轮询，持续无关 SSE 不再重置定时器；每轮等待完成，不堆叠探测 |
| AUD-OC-03 | 保存 multiselect 类型和 min/maxItems；可用单选作答时提交一元素数组，否则整表单仅可中止 |
| AUD-OC-04 | 任一无法满足的必填字段使整表单进入中止模式；不再提交裁剪后的部分答案 |
| AUD-OC-05 | 长值使用完整身份的确定性哈希映射，整字段统一代理；提交时从权威表单还原，不猜测字段、不截断身份 |
| AUD-OC-06 | 重挂载区分 succeeded/failed/interrupted；失败/中止发错误再 idle，同 request 只观察旧执行 |
| 固件静默回复 | 唯一 worker 在短读前处理回复队列，不再依赖下一次 SSE 字节或心跳；保留原文件的 LF 换行 |
| 配置 | 主/备统一引用；旧变量（包括空值）和旧绑定字段直接拒绝；同步部署预检、透传、模板、契约 |
| 原生控制 | OpenCode v2 插件在每个物理请求前通过 SQL 原子预留；首轮 429/余额不足可替换一次 HTTP 请求，未重复 POST prompt；原生重试禁止 |
| 预算与归属 | 四张 RLS 表保存任务、物理尝试、冷却、子会话归属；跨设备共享用户预算；删除设备不清除账本；子代理启动即封住回退 |
| 不确定状态 | 无 usage 保留预留；提交超时/断线保留 unknown；旧终态按捕获的 task ID 处理，不能覆盖后续任务 |
| 通知与旁项 | agent.status/retry 显示实际备模；修复 smoke 的超时/泛 4xx 误报；云端 manifest 补齐固件已有的两项限制，schema 不变 |

实施与部署说明：[OpenCode controller README](/home/unknow/projects/WQN/web/server/opencode-control/README.md)。脱敏证据：[2026-10-17.json](/home/unknow/projects/WQN/web/server/opencode-control/validation/2026-10-17.json)。

当前验证：

- Web 全量离线套件 **1621 PASS、1 SKIP**，文件为 168 PASS、2 SKIP；跳过项不算通过。类型检查、变更文件 ESLint、部署 Bash 测试及 Windows PowerShell 解析通过。
- 全新隔离 PostgreSQL 16.15 应用完整迁移后，**34 项真实事务检查通过**，覆盖并发、重放、各级预算、每日回退、未知预留、子会话归属、服务角色权限及 Retry-After 冷却延长。
- Windows **OpenCode v2.0.16 原生插件 + 假 provider + 真实 SQL**：主 429→备成功、明确余额不足→备成功、备再次 429→结束，均为 2 次物理发送；调用预算为 1 时仅发送主请求。原消息 ID 重放均不增加调用。四条路径的实际发送数与账本一致。
- 已授权的 **StepFun Step Plan / step-3.7-flash** 经同一原生控制链实调 **1 次**：输出上限 64，实际 prompt 6978 + completion 28 = **7006**，其中 cached 320，reasoning 0；SQL 结算 **7006**。本次没有再次消耗真实 DeepSeek free 配额；其回退分支使用可控失败注入验证。一个样本不能替代全部推理档位的上界验证。
- 固件 ESP-IDF 5.5 `build-wsl` 构建通过，**0 warnings**，M8 和 UI 栈门禁通过；Agent round policy **1220 checks / 0 failures**，CRLF-aware diff 通过。
- Web 默认 Turbopack 在当前执行环境因端口绑定 `Operation not permitted` 失败；使用非密钥验证环境值的 **Webpack 生产构建通过**，客户端包无服务端密钥。没有为构建修改真实环境文件。

验证边界：原生集成通过临时控制桥调用同一个真实 SQL RPC，没有把它冒充已部署 Next.js/反向代理/真实设备鉴权验收。子代理身份/预算已有主机与数据库回归，尚未执行真实模型驱动的完整子代理工具工作流。设备点击到 POST 的实测延迟、中止、断网恢复及最终展示仍需 HIL；没有刷写设备。真实生产 SQL、密钥、绑定、OpenCode 桌面/全局配置和回退开关均未修改。

启用条件：先应用迁移并安装插件，设置双方共享控制密钥及显式 provider HTTP 路由、完整预算/独立配额组，再启用开关。适配器当前只开放经约束的 `openai-compatible` HTTP chat completions；WebSocket、Responses API、未知上下文上界及未验证的推理输出口径会阻断。输入预留使用整个模型接收窗口，故意保守；不是字符数估算或事后超额中止。默认回退保持关闭，生产主备顺序和额度没有被验证授权自动代选。
