# WQN 发布与运维工作台

本地 WSL 运行界面和 Git 检查。镜像保存在 ACR，发布记录、配置快照与操作日志保存在 SSH 目标主机的 `~/.wqn-ops/`。浏览器关闭后，已经提交的云端变更任务继续运行；本机构建任务需要本地服务继续运行。

## 启动

本地需要 Python **3.12+**、Git、OpenSSH；构建需要现有 Docker Desktop / Buildx，PowerShell 构建引擎需要 `pwsh`。查询 PR 时使用已登录的 `gh`。云端需要 Python **3.6+**、Docker、OpenSSL **1.1.1+**，以及现有 ACR 拉取凭证。Docker 容器内需要支持 `fetch` 的 Node.js（当前镜像满足）。

在项目根目录运行：

```bash
bash deploy/ops.sh
# http://127.0.0.1:8765
```

Windows / WSL UNC 路径可以双击 `deploy/ops.bat`。它通过 WSL 启动控制台。端口或目标可调整：

```bash
bash deploy/ops.sh serve --port 8766 --ssh-host aliyun
```

服务只绑定回环地址；Host、Origin 和实例令牌校验用于阻止其他网页调用运维接口。SSH 密钥和仓库凭证留在执行端。没有公共网站托管步骤。

## 首次使用

1. 在“版本对照”核对实际云端服务、候选分支和提交时间线。
2. 在“分支与遗漏”核对候选与缓存的远端发布基线。程序补丁按稳定 patch-id 归组，保留各分支、原提交、作者时间、提交时间和附近提交。GitHub PR 与远端分支均按按钮显式刷新，界面显示刷新时间。
3. 在“部署与回退”点击“保存当前基线”。它只保存现有服务的恢复快照，不重启容器。采集时间不会冒充原部署时间。
4. 通过页面执行发布或环境更新，查看计划后再执行。新增程序补丁会改变暂缓指纹，需要重新核对；同一补丁被 cherry-pick 或增加工具改动不会重复要求暂缓。

### 分支核对的含义

候选固定为页面所选 SHA，不把工作区未提交内容当作发布内容。扫描先排除已在候选历史中的提交及等价补丁，再检查涉及文件的 blob/mode 和隔离临时索引中的反向补丁。混合提交按程序部分计算 patch-id 和内容匹配，工具、文档的适配差异不会把相同程序重复算作待办。内容匹配可识别部分 squash 和后续修改；未匹配仅表示需要核对，不证明功能缺失，也不证明需要整支合并。合并提交的冲突解决内容仍单列供人工检查。

本地分支与同名远端分支保留各自的 tip；即使远端落后或分叉，也不会只取一端。共享程序补丁的分支合并为一组，同一补丁只计一次，原 SHA 和来源仍可展开。暂缓按程序补丁集合绑定；旧版按 SHA 记录的原因只在覆盖当前整组内容时继续有效，部分核对不能覆盖新增程序改动。调整扫描范围后，旧原因仍保留在参考区；更新原因也保留此前记录。

主仓库固定由 `origin` URL 确定。不同仓库的 remote（例如 `upstream`）、`backup/` 与 `dependabot/` 引用放入折叠参考区。只涉及 `deploy/`、`.github/`、`doc/`、`docs/` 或根目录 Markdown 的提交作为工具和文档差异显示；`.github/dependabot.yml` 单列为配置差异。它们仍可查看，但不要求为 App 程序发布填写暂缓原因。未知路径、运行时代码、数据库及依赖文件仍进入程序补丁核对。

GitHub 查询显式使用 `origin` 对应仓库，避免 `gh` 默认选择 fork 的上游。已合并 PR 显示合并时分支头，并按 Git 祖先关系核对分支是否在该头后继续提交；PR 的“已合并”状态不等于当前分支所有后续提交已进入候选。远端 Release 引用是缓存的源码基线，实际运行版本另看“版本对照”的 SSH 状态。

记录由云端维护，本地没有历史数据库、镜像 tar 或持久化配置快照。构建使用临时 Git 归档目录固定所选 SHA；本地 `.env.production` 只临时复制到该目录并按 0600 保存，结束后清理。当前工作区未提交文件不进入构建。

配置内容在构建开始时固定。构建期间如果云端容器、环境或拓扑发生变化，后续部署会要求重新核对。现网状态也会与最近一份已验证快照比较，标记未建基线、匹配、已变化或无法核实。云端目录与 `vault.key` 应一起纳入现有主机备份。

新功能进入生产前，需要先把相关源码提交到候选分支。工作台自身的未提交实现不会被偷偷混入所选提交的镜像。

构建使用当前工作台维护的构建脚本，先记录 SHA256，再复制到单独的临时工具目录执行；应用源码、Dockerfile、构建配置和环境规则仍来自所选提交的独立归档。云端记录同时保存源码 SHA 与构建工具摘要，避免选择旧提交时重新执行已修复的历史发布脚本。原生脚本的 `--driver-opt` 按 CSV 转义，`NO_PROXY` 的逗号和内嵌引号保留为单个变量值。

## 入口与命令行

`web-release.bat`、`web-release.sh`、`release.sh` 和 `update-env.sh` 共用 `ops/cli.py` 的检查与云端记录。PowerShell App 的 `-DeployAliyun` 也转入该入口。

```bash
# 本地只读 Git 检查
bash deploy/ops.sh check --ref HEAD

# 云端只读查询；不会初始化历史目录
bash deploy/ops.sh status
bash deploy/ops.sh history
bash deploy/ops.sh logs --source app --since 30m

# 保存当前运行状态为基线，不重启服务
bash deploy/ops.sh capture

# 发布：先核对遗漏；交互确认后固定提交构建
bash deploy/release.sh --skip-realtime
bash deploy/web-release.sh --no-deploy

# 若选择本次暂缓未集成工作，记录明确原因
bash deploy/release.sh --defer-reason '本次仅发布修复，功能留待下次集成'

# 环境检查与更新
bash deploy/update-env.sh --check
bash deploy/update-env.sh --preview
bash deploy/update-env.sh

# 查看具体记录、生成恢复计划、按计划执行
bash deploy/ops.sh operation <操作ID>
bash deploy/ops.sh rollback-plan <已验证记录ID>
bash deploy/ops.sh apply <计划ID> --compatibility-reviewed
```

`--yes` 是脚本调用时对具体操作的显式确认；不会跳过遗漏核对、目标状态守卫、环境核验或回退兼容性检查。无人值守发布还需要有效的 `--defer-reason`，或者已记录且未变化的逐项暂缓决定。

## 云端执行与回退

每次变更先保存运行容器的实际 env、镜像 ID、端口、网络、命令与运行参数。配置快照采用 OpenSSL AES-256-CBC/PBKDF2 加密，并通过独立的 HMAC 校验密文完整性；密钥只保存在目标主机 `~/.wqn-ops/vault.key`（0600）。公开记录不包含 env 值。

应用计划后，云端独立进程取得互斥锁，重新核验容器身份、env 和拓扑，先准备所有镜像，再替换容器。旧容器被重命名保留；新容器的镜像 ID、完整有效 env 和容器内 HTTP 就绪检查均通过后，才写入 `verified` 回执。

失败后尝试恢复旧容器及旧 env，并再次检查服务。只有恢复核验通过才标记 `rolled_back`；恢复不完整为 `needs_attention`。进程被强制结束、主机重启或连接无法核实时，保留操作 ID，不会自动重放。

历史回退从已验证记录的恢复快照重建，并留下新的操作记录。优先使用现有确定的 image ID；需要重新拉取时，必须与保存的 image ID 一致，tag 被覆盖就拒绝执行。镜像仍由 ACR 保留；此模块不自动清理 ACR tag、本地恢复镜像或云端配置快照。后续清理必须先核对哪些回退点仍依赖它们。

数据库不会自动降级。回退前必须核对数据库与共享配置兼容性。当前适配器处理现有 App/Realtime 的私有 Docker 网络和无挂载拓扑；自定义挂载、设备、特权、额外主机和未支持的资源配置会明确拒绝，避免重建时丢失参数。

单独的环境更新仅处理 App。配置规则优先使用运行镜像的源码标签或已验证云端发布回执；历史镜像可从版本 tag 推断，并明确注明。无法确认版本则停止。OpenCode 新旧变量必须与运行版本对应；当前旧程序不会因为把新变量放进容器就获得 fallback 功能。

构建时公共变量发生变化会要求重新发布镜像，避免出现容器 env 已变而浏览器代码未变。App 与 Realtime 共用的认证密钥发生变化时，也会要求联合更新，避免单独重建 App 后使另一服务失去认证。

## ACR 与日志

ACR 页面从云端记录汇总已知镜像，不依赖个人版管理 OpenAPI。点击“核验 ACR”通过云端 Docker 的仓库协议检查已知版本及 digest；失败时显示未核实，不把网络、登录失败解释为镜像已删除。

日志页支持 App/Realtime 容器、nginx access/error、Docker journal。容器日志支持按时间拉取，持续刷新以 5 秒轮询实现；系统日志显示最近 300 行。当前面板展示有大小上限的日志片段，不能替代长期日志服务。已知密钥和认证头在传给浏览器前脱敏，导出的是当前脱敏结果。

替换前的容器日志及构建/执行日志按操作归档在云端。历史容器已删除或日志已轮转时，模块不会声称能恢复缺失日志。外部手工操作未进入回执，需要通过当前状态核对并重新采集基线。

## 验证

```bash
bash deploy/tests/run.sh
python3 deploy/tests/ops.test.py HTTPTests
```

前者覆盖旧部署脚本、包装入口、Git 补丁等价、云端快照加密、状态变化守卫、镜像拉取失败、env 核验失败、启动失败、自动恢复、历史状态回退、单次应用和锁。后者需要本机监听回环端口权限。生产部署、真实 ACR 推送和业务提供商调用属于另外的验收步骤。

开发时可运行浏览器只读检查和显式云端隔离检查：

```bash
# 先启动本地工作台；使用现有 web/node_modules 中的 Playwright
node deploy/tests/ops-browser.cjs

# 显式创建临时内部网络、虚构配置和测试容器，结束后清理
python3 deploy/tests/ops-aliyun-isolation.py --run
```

浏览器检查的变更计划使用测试响应拦截，现网只读。隔离检查核对现网 App/Realtime 容器 ID 保持不变，并验证实际后台执行、环境重建、历史回退及失败后的自动恢复。两者都不会发布生产应用。
