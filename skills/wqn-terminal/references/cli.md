# CLI 契约

运行 `python3 <skill-dir>/scripts/wqn.py <command>`。Linux/macOS、Python 3.10+，不需要 pip。全部命令输出 JSON；`--json` 可选。退出码 0 表示命令得到可报告的结果，1 表示客户端错误；业务是否完成始终检查返回的 `status`。`pending`、`denied`、`requires_user_action` 都不是完成业务任务。

## 配置和存储

第一次连接使用用户提供的服务地址：

```sh
python3 <skill-dir>/scripts/wqn.py configure --server https://your-wqn.example --client-name 'My AI Client'
```

只接受 HTTPS 的服务器 origin，不带路径、查询或凭据。CLI 校验发现元数据、资源 audience 和所有端点均属于该 origin，拒绝 HTTP 重定向。每个安装注册独立公共客户端，不内置 client secret。更换服务器使用另一个状态目录。

凭据目录依次选择 `WQN_STATE_DIR`、`$XDG_STATE_HOME/wqn-terminal`、`~/.local/state/wqn-terminal`。由用户或宿主配置私有持久化目录；不要把它放进 Skill 目录、项目、共享卷或可复用模板。CLI 将目录限制为 0700，状态和操作日志为 0600，并用文件锁、原子替换和 fsync 保存状态。命令返回 `persistence: host_managed`，不代表已证明宿主会保留这个目录。

凭据是否跨会话保留取决于宿主。整个目录丢失时需要重新授权。多个沙箱不能维护同一份轮换凭据的独立副本；快照恢复旧凭据可能触发服务端重复使用检测。CLI 的文件锁只协调同一文件系统中的调用，无法协调被复制的沙箱。

本地开发服务可在配置时显式添加 `--allow-http-loopback`，仅接受 `127.0.0.1` 或 `::1`。正式连接不要使用此选项。

## 命令

| 命令                           | 返回或行为                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `auth status`                  | 授权状态、账号 ID、scope、access token 截止时间、是否需要刷新；不输出凭据      |
| `auth start`                   | 复用待授权请求或创建请求；返回用户网址、短码、截止时间和轮询间隔               |
| `auth wait --timeout 45`       | 等待最多 45 秒；遵守服务器间隔，`slow_down` 后加 5 秒；跨进程保留进度          |
| `auth logout --revoke`         | 先请求撤销刷新与访问令牌，确认成功后移除本地凭据                               |
| `tools list`                   | 当前工具名称、说明和 annotations                                               |
| `tools schema TOOL`            | 指定工具的完整当前 Schema                                                      |
| `call TOOL --input-file FILE`  | 读取 UTF-8 JSON 对象参数，执行 MCP 工具并保留业务 envelope；无文件时使用空参数 |
| `request-id`                   | 生成 UUID v4，供一个独立写操作使用                                             |
| `operations list`              | 当前账号的本地操作 ID、工具、状态和回执信息，不输出原始参数                    |
| `operations status REQUEST_ID` | 根据本地日志查询服务端 `get_operation_status`                                  |

## 令牌和操作恢复

服务端当前策略为 `mcp:all`、1 小时 access token、90 天 refresh token，每次刷新重新计算 90 天。以服务器返回的 access token 有效期为准；CLI 不通过参数扩大期限。刷新在实际 MCP 调用前自动发生。

CLI 在刷新前持久化 `refresh_inflight`。进程终止、网络错误、无效响应或保存失败后，不重试可能已经消费的 refresh token。`refresh_uncertain` 或 `refresh_failed` 需要重新授权；无法确认旧授权是否已撤销时，可在 WQN 中撤销原客户端授权。轮换成功后会原子替换本地凭据。设备码兑换也采用相同的失效保护：结果不明确时重新发起授权。

CLI 在写调用前持久化工具、完整输入、账号和 request_id。同 ID 不同输入会被拒绝。发送状态不明确时，同 ID 的再次调用会转为查回执，不盲目重发。CLI 不自动恢复业务写操作；按服务端回执判断是否调用 `resume_operation`。重新授权后切换账号会阻止复用旧账号的日志。

`resume_operation` 本身是恢复控制调用，不生成新的业务 request_id；其目标 operation_id 来自原回执。已提交、待审核或被拒绝的操作按服务器结果处理。

已有本地日志的再次调用先查询回执。若查询明确返回 `operation_not_found`，CLI 记录该状态，允许下一次显式调用使用原 ID 和完全相同输入重试；服务端仍以该 ID 去重。回执暂不存在并不证明旧请求没有在途执行。JSON-RPC 的参数、方法或请求格式错误会作为明确的执行前错误报告。

## 常见错误

| code                                                                 | 处理                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `configuration_required`                                             | 配置用户提供的 WQN 地址                                                  |
| `device_flow_unsupported`                                            | 服务端需要部署设备授权能力，不能改用聊天粘贴 token                       |
| `authorization_required` / `authorization_rejected`                  | 检查账号状态，按需要重新授权                                             |
| `device_exchange_uncertain` / `refresh_uncertain` / `refresh_failed` | 不重放旧凭据，重新授权                                                   |
| `write_outcome_unknown`                                              | 保留 request_id，查询原回执                                              |
| `request_id_reused`                                                  | 原 ID 已绑定其他账号、工具或输入；先核对原任务，不改 ID 重发未知结果操作 |
| `state_busy`                                                         | 另一个本地命令持有锁，稍后重试                                           |
| `unsafe_state_directory` / `unsafe_state_file` / `state_corrupt`     | 修正宿主私有存储；不要把状态文件内容输出给模型                           |
| `revocation_uncertain` / `revocation_failed`                         | 不声称撤销成功；引导用户在 WQN 撤销授权                                  |

## 能力边界

CLI 避免凭据进入常规命令输出，不提供同一操作系统身份内的凭据隔离。用户授权的 AI 客户端及其宿主需要可信。用户授权页必须手动确认，CLI 不使用用户密码或浏览器 Cookie。
