# Agent 分类部署与测试

本版每题创建一个 OpenCode 新会话；进程恢复继续原会话，用户明确重试才创建新 run/会话。
当前 Registry 锁只固定 Agent bundle。App 与 worker 从首次发布起都配置 `agent`，
连接预检完成后再启动 worker 认领任务。
工程测试记录见 [VALIDATION.md](VALIDATION.md)，协议与恢复说明见 [README.md](README.md)。

1. 准备三个运行单元和网络

| 单元            | 配置与职责                                                      |
| --------------- | --------------------------------------------------------------- |
| WQN App         | 专用 `/api/mcp/mark`、任务控制 API、数据库提交与查询            |
| wqn-mark-worker | 常驻 Node 24 进程；认领任务、创建和恢复 OpenCode 会话、回收用量 |
| OpenCode V2     | 加载发布的工作区、现有 provider 和默认模型；通过 MCP 提交成果   |

worker 必须能访问 App 与 OpenCode；OpenCode 必须能访问 App 的 MCP URL 和模型供应商。
`WQN_MARK_OPENCODE_DIRECTORY` 是 **OpenCode 主机上**的绝对路径，不是 worker 容器路径。
Linux 示例为 `/srv/wqn-mark/registry`；Windows 示例为 `C:/WQN/mark-workspace`。
现有 `deploy/release.sh` 和桌面 App 发布脚本不会创建 mark-worker，须另行部署它。

2. 在构建机生成并同步同一份知识库

先设置两个源码目录，使用包含本次分类框架与工作区生成器的提交；远端旧分支可能尚未包含这些代码。

```bash
WQN_ROOT=/path/to/WQN
REGISTRY_ROOT=/path/to/WQN-Knowledge-Registry

cd "$REGISTRY_ROOT"
npm ci
npm run check
npm run build:agent

cd "$WQN_ROOT/web"
npm ci
npm run marks:sync-agent -- "$REGISTRY_ROOT/dist/agent-marking/bundle.json"
node scripts/sync-knowledge-registry.ts --verify-only --artifact "$REGISTRY_ROOT/dist/registry.json"
```

预期生成与锁定 Registry 对应的数学和物理方法文档，canonical registry 校验成功。`bundle.json` 的 SHA-256 必须等于
`web/knowledge-registry.lock.json` 的 `agent_marking.artifact_sha256`。
修改文档或 Skill 后必须重新生成、同步并发布 App 和 OpenCode 工作区。

在构建机打包；使用 `.` 会包含隐藏的 `.opencode/`：

```bash
tar -C "$REGISTRY_ROOT/dist/agent-marking" -czf /tmp/wqn-mark-workspace.tar.gz .
```

复制到 OpenCode 主机后，在一个空的发布目录解压：

```bash
mkdir -p /srv/wqn-mark/registry
tar -xzf /tmp/wqn-mark-workspace.tar.gz -C /srv/wqn-mark/registry
```

更新时发布到新的完整目录并切换 worker 指向，或先停 worker 再替换整个工作区；不要把不同版本的文件混在一起。

3. 准备环境变量

生成独立分类密钥：`openssl rand -hex 32`。三处使用同一个值；模型供应商密钥只保留在 OpenCode 环境。
下面的 `REPLACE_*` 都需替换。

| 变量                                  | App            | worker                        | OpenCode                       |
| ------------------------------------- | -------------- | ----------------------------- | ------------------------------ |
| `PROBLEM_MARKING_ENGINE`              | `agent`        | `agent`                       | 不需要                         |
| `PROBLEM_MARKING_AGENT_SECRET`        | 同一把分类密钥 | 同一把分类密钥                | 同一把分类密钥                 |
| `WQN_MARK_APP_URL`                    | 不需要         | App 内网 URL                  | 不需要                         |
| `WQN_MARK_OPENCODE_URL`               | 不需要         | OpenCode 服务 URL             | 不需要                         |
| `WQN_MARK_OPENCODE_DIRECTORY`         | 不需要         | OpenCode 主机的工作区绝对路径 | 对应的工作区目录               |
| `WQN_MARK_OPENCODE_USERNAME/PASSWORD` | 不需要         | OpenCode HTTP 认证            | 对应的服务认证                 |
| `WQN_MARK_MCP_URL`                    | 不需要         | 不使用                        | App 的完整 `/api/mcp/mark` URL |
| `WQN_MARK_CONCURRENCY`                | 不需要         | 默认 2，初次实测可用 1        | 不需要                         |

App：在现有 `web/.env.production` 中增加，保留原有数据库和其他配置：

```dotenv
PROBLEM_MARKING_ENGINE=agent
PROBLEM_MARKING_AGENT_SECRET=REPLACE_WITH_SHARED_MARK_SECRET
```

单独创建 worker 环境文件，例如部署主机的 `~/.env.wqn-mark-worker`，权限设为 600：

```dotenv
PROBLEM_MARKING_ENGINE=agent
PROBLEM_MARKING_AGENT_SECRET=REPLACE_WITH_SHARED_MARK_SECRET
WQN_MARK_APP_URL=http://wqn-app:3000
WQN_MARK_OPENCODE_URL=http://10.0.0.20:4096
WQN_MARK_OPENCODE_DIRECTORY=/srv/wqn-mark/registry
WQN_MARK_OPENCODE_USERNAME=opencode
WQN_MARK_OPENCODE_PASSWORD=REPLACE_WITH_OPENCODE_PASSWORD
WQN_MARK_CONCURRENCY=1
```

`wqn-app` 是现有 release.sh 默认容器名；Compose 中应使用 `http://wqn:3000`。
把示例 IP 换成 worker 实际可达的 OpenCode 地址。容器内的 `127.0.0.1` 指向该容器自身。

4. 发布数据库与 Agent App

先暂停已有分类 worker，避免更新 Registry 或工作区期间认领新任务。将生产配置放到当前 WQN 工作区的
`web/.env.production`，确认 `PROBLEM_MARKING_ENGINE=agent`。在 WQN 根目录执行迁移预检：

```bash
cd "$WQN_ROOT"
bash deploy/supabase-push.sh --dry-run-only
```

核对待执行清单和目标库；本次需要 `20261025000000_agent_problem_marking.sql` 及其已有前置迁移。
`supabase-push.sh` 会应用该目录所有待执行迁移，不只本文件；不要用 `--include-all` 掩盖历史差异。
当前脚本从配置读取维护 URL，经 SSH `tencent` 直连数据库容器。
确认清单符合本次发布范围后执行：

```bash
bash deploy/supabase-push.sh

cd "$WQN_ROOT/web"
node --env-file=.env.production scripts/sync-knowledge-registry.ts --artifact "$REGISTRY_ROOT/dist/registry.json"
```

第二条会向数据库同步锁定的 canonical registry。仅运行 `marks:sync-agent` 不会完成数据库同步。
随后按现有流程发布 App；例如在 WQN 根目录使用现有 WSL 发布脚本：

```bash
cd "$WQN_ROOT"
WQN_APP_TAG=agent-marking-REPLACE_WITH_RELEASE_TAG
bash deploy/release.sh "$WQN_APP_TAG" --skip-realtime
```

该命令会构建、推送并部署 App，默认目标为现有脚本的 `aliyun` SSH 别名。
App 中必须包含本次 bundle、lock 和路由代码。桌面发布流程也只覆盖 App；worker 按下一步部署。

5. 启动 OpenCode V2 并检查工作区

使用具备 provider 配置和默认模型的 OpenCode V2 运行账号。先确认 `opencode --version` 为 2.x。
以下命令配置该账号的共享后台服务；建议分类使用独立运行账号，避免调整个人服务：

```bash
opencode service set hostname 0.0.0.0
opencode service set port 4096
opencode service set password 'REPLACE_WITH_OPENCODE_PASSWORD'
opencode service set env WQN_MARK_MCP_URL https://wqn.example.com/api/mcp/mark
opencode service set env PROBLEM_MARKING_AGENT_SECRET 'REPLACE_WITH_SHARED_MARK_SECRET'
opencode service start
opencode service status
```

把 MCP 域名替换为已发布 App 的地址。后台服务的环境需用 `service set env` 设置；
只在另一个终端 `export` 不会更新已运行的服务。服务可在不同工作目录按请求加载 Location。
以实际安装版本的 `opencode serve --help`、`opencode service --help` 和 `/openapi.json` 为准。

在能访问 OpenCode 的终端，设置测试变量并读取接口：

```bash
export WQN_MARK_OPENCODE_URL=http://10.0.0.20:4096
export WQN_MARK_OPENCODE_DIRECTORY=/srv/wqn-mark/registry
export WQN_MARK_OPENCODE_USERNAME=opencode
read -rsp 'OpenCode password: ' WQN_MARK_OPENCODE_PASSWORD
export WQN_MARK_OPENCODE_PASSWORD

curl -fsS -u "$WQN_MARK_OPENCODE_USERNAME:$WQN_MARK_OPENCODE_PASSWORD" \
  "$WQN_MARK_OPENCODE_URL/openapi.json" -o /tmp/wqn-mark-openapi.json
curl -fsS -u "$WQN_MARK_OPENCODE_USERNAME:$WQN_MARK_OPENCODE_PASSWORD" \
  --get --data-urlencode "directory=$WQN_MARK_OPENCODE_DIRECTORY" \
  "$WQN_MARK_OPENCODE_URL/api/agent"
curl -fsS -u "$WQN_MARK_OPENCODE_USERNAME:$WQN_MARK_OPENCODE_PASSWORD" \
  --get --data-urlencode "directory=$WQN_MARK_OPENCODE_DIRECTORY" \
  "$WQN_MARK_OPENCODE_URL/api/mcp"
```

预期：OpenAPI 包含 `/api/session`、`/api/session/{sessionID}/prompt`、`/api/event`，
session 创建接受指定 id/metadata，prompt 接受指定消息 id。agent 列表应包含 `mark`，MCP 列表应显示
`wqn_mark` 已连接。worker 创建会话时省略 `model`，因此要确认该运行账号在实际工作区解析出的默认
`provider/model` 在其模型目录中可用。需要图题时，确认默认模型支持图片。

6. 验证专用 MCP 的四个工具

在启动 worker 前，从可信终端查询工具清单。这个请求不会认领任务或调用模型。

```bash
export WQN_MARK_MCP_URL=https://wqn.example.com/api/mcp/mark
read -rsp 'Mark service secret: ' PROBLEM_MARKING_AGENT_SECRET
export PROBLEM_MARKING_AGENT_SECRET
curl -fsS "$WQN_MARK_MCP_URL" \
  -H "Authorization: Bearer $PROBLEM_MARKING_AGENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

预期只有 `get_mark_context`、`read_mark_images`、`submit_mark_result`、`get_mark_receipt`，
且都带 inputSchema/outputSchema。OpenCode 侧调用名称带 `wqn_mark_` 前缀。
一次任务的 run_id/task_token 由 worker 自动发给模型。

7. 部署常驻 worker 并确认就绪

沿用现有 App 部署时，在构建机 WQN 根目录构建并发布新镜像：

```bash
cd "$WQN_ROOT"
MARK_WORKER_IMAGE=your-registry/your-namespace/wqn-mark-worker:REPLACE_WITH_RELEASE_TAG
docker build -f web/Dockerfile.mark-worker -t "$MARK_WORKER_IMAGE" web
docker push "$MARK_WORKER_IMAGE"
```

在 App 部署主机上，使用对应镜像名和刚才准备的独立环境文件：

```bash
MARK_WORKER_IMAGE=your-registry/your-namespace/wqn-mark-worker:REPLACE_WITH_RELEASE_TAG
chmod 600 "$HOME/.env.wqn-mark-worker"
docker pull "$MARK_WORKER_IMAGE"
docker run -d --name wqn-mark-worker --restart unless-stopped \
  --network wqn-runtime \
  --env-file "$HOME/.env.wqn-mark-worker" \
  "$MARK_WORKER_IMAGE"
docker logs --tail 100 wqn-mark-worker
docker exec wqn-mark-worker wget -qO- http://127.0.0.1:8090/health
```

`wqn-runtime` 是现有 release.sh 默认网络；自定义了网络或容器名时一并修改。
已有 worker 时移除已停止的旧容器，再用相同名字创建。修改容器环境后需要重新创建容器。
Agent worker 的 `/health` 应返回 `{"ready":true,"engine":"agent",...}`。
worker 就绪后会开始认领已有待处理题目。逐题回执验收见下一步。

若采用仓库的 Compose，先在现有 `web/.env.production` 加入步骤 3 的 App/worker 变量，
`WQN_MARK_APP_URL` 由 Compose 固定为 `http://wqn:3000`。设置一个非空的 `IMAGE_WQN`
及现有 App 所需配置/构建 secret，然后在 `web/` 执行；不同时启动第二套现有 App：

```bash
docker compose --env-file .env.production -f docker-compose.yml build wqn wqn-mark-worker
docker compose --env-file .env.production -f docker-compose.yml up -d --force-recreate wqn wqn-mark-worker
docker compose --env-file .env.production -f docker-compose.yml logs --tail=100 wqn-mark-worker
docker compose --env-file .env.production -f docker-compose.yml exec -T wqn-mark-worker \
  wget -qO- http://127.0.0.1:8090/health
```

8. 实际分类与验收报告

先选少量新题，或在题目分类卡中对一题明确重试。管理员也可在 `/zh-CN/admin/problem-marks`
按单题重新排队；首轮不要使用全量重排。已完成的历史题不会因切换自动重跑，现有待处理题可能被认领。
期限从排队起算五分钟，排队已经超时的题会直接失败。

检查每个 run 对应一个新的 session；结果卡能展示目标/必需项、推荐/备选方法及证据。
确定失败后通过题目卡明确重试；断线但提交结果未知时先读原回执。
停 worker 后再启动测试恢复，应在租约到期后继续同一个 run/session，不重复发 prompt。

管理员的 `/api/admin/problem-marks` 响应中，`health.agent.recent_tasks` 给出最近 20 个
run_id/problem_id/session_id、状态与用量。也可用受信数据库查询获得更早任务：

```sql
select run_id, problem_id, session_id, state, error_code, queued_at, telemetry
from public.problem_mark_agent_tasks
order by created_at desc limit 20;
```

在 WQN `web/` 准备 `acceptance-runs.json`：

```json
[
  {
    "run_id": "REPLACE_WITH_ACTUAL_RUN_UUID",
    "expected": {
      "notes": "逐题预期、可接受的方法、禁止误标和未覆盖项"
    }
  }
]
```

使用从当前操作机可达的 App URL。导出只需 App 和分类密钥；设置 rag 避免要求操作机拥有 OpenCode 配置：

```bash
PROBLEM_MARKING_ENGINE=rag \
WQN_MARK_APP_URL=https://wqn.example.com \
node --env-file=/secure/path/mark-export.env \
  server/mark-worker/export-report.mjs acceptance-runs.json report.json
```

`mark-export.env` 只需包含 `PROBLEM_MARKING_AGENT_SECRET`。以上覆盖只影响导出进程，不切换服务器引擎。
报告包含结果、引用、回执、错误、实际模型、排队/执行/总耗时、token、已知费用和工具调用计数。
未知费用保留 null；逐题人工检查适用性、遗漏、必需与推荐的区别，不把工程测试视为分类质量评分。
当前词库包含数学和物理 Skill。缺失的知识点或方法应返回 `unresolved`。

9. 工程测试与回退

下面在 WQN `web/` 执行，均不代表真实模型效果：

```bash
npm run type-check
npm run format:check
npx eslint --quiet . --ext .ts,.tsx,.js,.jsx
npx vitest run --maxWorkers=2
npm run test:mark-worker
npm run build -- --webpack
npm run check:client-bundle-secrets
```

生产构建需要现有 App 构建环境，包括公开 Supabase URL、origin 配置和 Server Actions secret。
SQL 32 项测试及真实 MCP→数据库 smoke 只对独立测试库运行，具体命令见 VALIDATION.md；不要指向生产。

SQL 使用包含 WQN 全部前置 schema 和本次迁移的独立空测试库，运行账号需具备测试 fixture 权限：

```bash
MARK_TEST_DATABASE_URL='postgresql://test_admin:test_password@127.0.0.1:54322/wqn_agent_mark_validation_fresh'
supabase test db --db-url "$MARK_TEST_DATABASE_URL" supabase/tests/database/agent-problem-marking.test.sql
```

预期 32 项全部通过。真实 MCP→数据库 smoke 需要一个新的、schema 完整的独立测试库：

```bash
WQN_AGENT_TEST_DB=wqn_agent_mark_validation_fresh \
WQN_AGENT_TEST_CONTAINER=supabase_db_your_local_stack \
npx vitest run lib/__tests__/problem-marks-agent-database.test.ts --maxWorkers=1
```

预期 1 项通过；未设置这两个环境变量时该项会跳过。此测试通过 Docker 中的
`psql -U supabase_admin` 连接，测试库名和容器名必须使用示例前缀，且会写入合成 fixture。

需要暂停认领时，先停止 worker 并保留 App 的 `agent` 配置。已启动的会话仍可在任务期限内提交。
恢复时启动匹配当前 App 与 Registry 的 worker，让它按租约继续原会话。
恢复 RAG 处理需要回退到带 `skill_retrieval` 锁的兼容 App 和相匹配的 Registry、向量产物及 provider 配置，
并重新创建相关容器。当前 App 直接改为 `rag` 会因缺少检索锁而使分类失败。

| 现象                             | 核查                                                     |
| -------------------------------- | -------------------------------------------------------- |
| `OPENCODE_V2_REQUIRED`           | 是否误用了 V1；检查目标服务 `/openapi.json`              |
| `REGISTRY_LOCK_MISMATCH`         | 数据库 active registry 是否已同步到 App lock             |
| `AGENT_BUNDLE_LOCK_MISMATCH`     | App bundle/lock 是否来自同次构建                         |
| `MARK_ENGINE_MISMATCH`           | App 与 worker 的 engine 是否一致                         |
| `SKILL_RETRIEVAL_CONTRACT`       | 当前 App 锁只支持 Agent 标注，检查 engine 是否为 `agent` |
| 401 / MCP 未连接                 | 分类密钥、OpenCode HTTP 密码、MCP URL 和服务环境         |
| 找不到 mark 或文档               | 绝对目录、`.opencode/` 隐藏文件、运行账号与工作区加载    |
| `PROMPT_OUTCOME_UNKNOWN`         | 原输入接收状态未知；保留原会话/回执，禁止自动重发        |
| `AGENT_FINISHED_WITHOUT_RECEIPT` | 读取会话中的工具错误；模型文本完成不等于成果入库         |

OpenCode 命令与配置依据 2026-10-26 核对的官方 V2 文档：
[服务](https://dev.opencode.ai/v2/docs/cli/web/)、
[MCP](https://dev.opencode.ai/v2/docs/mcp-servers/)、
[Agent](https://dev.opencode.ai/v2/docs/agents/)、
[权限](https://dev.opencode.ai/v2/docs/permissions/)。

后续交付涉及用户部署或测试时，同时给出操作主机/目录、配置、完整命令、预期输出、回退步骤和未验证项。
