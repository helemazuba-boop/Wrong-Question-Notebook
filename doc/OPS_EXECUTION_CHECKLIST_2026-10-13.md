# 审计修复：运维执行清单

适用于 `AUDIT_REMEDIATION_2026-10-12.md` 的发布与生产验收。以下是待执行清单，编写文档不代表线上步骤已完成。

按仓库现有部署路径编写：WSL 执行命令，阿里云 `aliyun` 运行 App / Realtime，腾讯 `tencent` 的 `supabase-db` 提供数据库。实际环境与这些别名、容器名或域名不同时，先调整执行计划。这里是已有生产数据库的增量升级，不包含 Cloud → 自托管的数据克隆或流量切换。

## 0. 发布前置与变更记录

- [ ] 确认 PR #91 已合入 `release/note-baseline-prod`；发布提交包含 `0ba894aa55a896d3d8447aa0dacdb7fd3db396a7` 及其之前的审计修复。
- [ ] 确认发布提交的 CI 通过；登记实际发布 SHA、App / Realtime 镜像 tag 和 digest。
- [ ] **Web Push 前置：开发侧补齐 VAPID 运行时传参。** 本文建立时，`deploy/release-env-policy.sh`、`deploy/build-and-push.ps1` 和 `web/docker-compose.yml` 均缺少 `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT` 映射。环境模板已有字段，单独填模板不能使这些发布路径透传它们。记录配套修复提交后才勾选 Web Push 可用；应用内提醒与账号任务可单独验收。
- [ ] 登记变更负责人、维护窗口、实际站点 / Supabase origin、备份位置、恢复点，以及旧镜像和私密环境文件的恢复位置。
- [ ] 在写入暂停窗口完成数据库可恢复备份和 Storage 对象备份；数据库备份不包含对象字节。
- [ ] 暂停相关定时任务与普通用户写入，保留受控运维和专用验收账号入口；检查已有导出 / 注销任务是否仍在运行，待其结束或按恢复方案处理后再开始变更。

以下命令在 WSL 的仓库根目录执行：

```bash
cd /home/unknow/projects/WQN
git fetch origin
git switch release/note-baseline-prod
git pull --ff-only origin release/note-baseline-prod
git merge-base --is-ancestor 0ba894aa55a896d3d8447aa0dacdb7fd3db396a7 HEAD
git rev-parse HEAD
```

最后的祖先检查必须成功；仅包含上述提交仍不足以证明 Web Push 部署配套已修复，需另核对其提交。

## 1. 私密配置与工具

- [ ] WSL 已具备 Node.js 24+、项目 Node 依赖、Docker / Buildx、SSH、`psql` 和与验证环境一致的 Supabase CLI；检查 `aliyun`、`tencent` 连接及实际目标。
- [ ] 从现有生产配置整理 `web/.env.production`，保留有效密钥及当前 Supabase origin，不覆盖成模板占位值。配置文件按数据读取，不使用 `source web/.env.production`。

| 配置                                                      | 必须确认                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL` / `WQN_SUPABASE_EXPECTED_HOST` | 指向实际生产 Supabase；示例为 `https://data.helema.cn` / `data.helema.cn`                               |
| `SUPABASE_SECRET_KEY`                                     | 有效服务端凭证；只进入服务端运行环境                                                                    |
| `TARGET_DATABASE_URL`                                     | 维护连接保持 `127.0.0.1:15432`，密码 URL 编码；由现有脚本建立腾讯数据库隧道                             |
| `SITE_URL`                                                | 实际对外 HTTPS 站点；示例为 `https://wqn.helema.cn`                                                     |
| `CRON_SECRET`                                             | 填入非空随机密钥，App 与运维调度凭据一致；模板未列出时自行添加此键                                      |
| 三个 `VAPID_*`                                            | 公私钥是一对，`VAPID_SUBJECT` 使用真实联系邮箱或 HTTPS 联系地址；已有有效密钥应沿用，换密钥需要重新订阅 |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`                      | 沿用受控构建密钥；按发布脚本作为 BuildKit secret 使用                                                   |

首次配置且尚无 CRON / VAPID 密钥时，可在 `web` 目录生成到私密文件，命令不打印密钥：

```bash
cd web
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import webpush from 'web-push';
const pair = webpush.generateVAPIDKeys();
writeFileSync('.env.ops-generated.json', JSON.stringify({
  CRON_SECRET: randomBytes(32).toString('base64url'),
  VAPID_PUBLIC_KEY: pair.publicKey,
  VAPID_PRIVATE_KEY: pair.privateKey
}, null, 2), { flag: 'wx', mode: 0o600 });
console.log('Generated private .env.ops-generated.json; import through your secret manager.');
JS
cd ..
```

- [ ] 将所需值通过私密配置 / 密钥管理器录入；保留迁移管理 URL 在维护端。密钥、数据库备份、测试账号导出包和签名下载 URL 不进入 Git、公开报告或发布日志。

## 2. 数据库迁移

- [ ] 先预演并核对真实目标和待执行清单：

```bash
bash deploy/supabase-push.sh --dry-run-only
```

该入口读取 `web/.env.production`，经 SSH `tencent` 解析实时 `supabase-db` 容器 IP，并建立 `127.0.0.1:15432` 到容器 PostgreSQL 的隧道。Windows 对应入口是 `deploy\supabase-push.bat --dry-run-only`。

本轮新增版本如下；若已有部分版本成功应用，只补实际缺失项：

```text
20261012000000_account_authorization.sql
20261012000100_problem_set_moderation.sql
20261012000200_todo_reminders.sql
20261012000300_account_data_jobs.sql
20261012000400_scenario_onboarding.sql
20261012000500_account_credential_and_export_completion.sql
```

- [ ] 预演出现更早的待迁移版本、remote-only 版本或乱序时，先处理历史差异；不直接加 `--include-all`。`push-target-migrations.sh` 是空库初始化入口，不用于此次已有生产库升级。
- [ ] 备份与预演确认后执行正式迁移；该命令会写生产数据库：

```bash
bash deploy/supabase-push.sh
```

- [ ] 命令退出码为 0；再运行一次 `--dry-run-only`，确认这六个版本没有 pending，并保存脱敏结果。
- [ ] 在生产数据库管理连接中核验以下只读 SQL：

```sql
select version, name
from supabase_migrations.schema_migrations
where version in (
  '20261012000000', '20261012000100', '20261012000200',
  '20261012000300', '20261012000400', '20261012000500'
)
order by version;

select id, public, file_size_limit
from storage.buckets
where id = 'account-exports';
```

验收：六行迁移历史齐全，`account-exports` 存在且 `public=false`。若仍报历史 RPC 的 `Missing account guard insertion point`，记录失败版本与完整函数签名，核对发布代码包含 `1bb04b4` 的 CRLF 修复；错误解决后再继续。不要用 `migration repair` 把失败步骤标记为成功，也不执行生产 `db reset`。

## 3. 发布应用并检查实际运行环境

- [ ] 从核验后的 release 提交构建、推送并部署；显式保存本次 tag：

```bash
ops_release_tag="audit-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
bash deploy/release.sh "$ops_release_tag"
```

默认发布 App 和 Realtime；本次仅发布 App 时使用既有 `--skip-realtime` 参数，并登记继续运行的 Realtime 镜像。脚本会保存远端私密环境文件备份位置，需纳入变更记录。

- [ ] 在阿里云宿主机确认运行镜像、registry digest、健康状态及变量是否存在。环境变量检查只打印键名和布尔值：

```bash
docker inspect --format '{{.Config.Image}} {{.Image}}' wqn-app
ops_app_image_id="$(docker inspect --format '{{.Image}}' wqn-app)"
docker image inspect --format '{{json .RepoDigests}}' "$ops_app_image_id"
docker exec wqn-app node -e '
const keys = ["CRON_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"];
console.log(JSON.stringify(Object.fromEntries(keys.map(key => [key, Boolean(process.env[key])]))));
'
curl --fail --silent --show-error https://wqn.helema.cn/api/health
```

- [ ] `CRON_SECRET` 为 true；启用 Web Push 时三个 VAPID 键均为 true。登录后的 `/api/reminders/subscription` 返回有效 `publicKey`，且与本次配置的公开 VAPID key 一致。
- [ ] App 能实际登录、读取笔记本架、打开后台并查询统计；Realtime 本次一起更新时另核验其 `/health` 与内部 App 连接。`/api/health` 只返回进程状态，不检验数据库、迁移或队列。

## 4. 首位超级管理员

- [ ] 先通过数据库管理连接查询角色数量：

```sql
select
  count(*) filter (where user_role = 'super_admin') as super_admin_total,
  count(*) filter (where user_role = 'super_admin' and is_active is true) as active_super_admin_total
from public.user_profiles;
```

- [ ] 已有活跃超级管理员时直接验证其后台访问；仅 `super_admin_total=0` 时，选定已有且活跃的账号，通过受控脚本初始化：

```bash
cd web
node --env-file=.env.production scripts/bootstrap-super-admin.mjs "替换为已确认的活跃账号UUID"
cd ..
```

- [ ] 重新查询并确认角色、活跃状态与登录结果。若已有超级管理员但全部停用，按受控账号恢复流程处理；该 bootstrap 会拒绝重复创建。普通 JWT / 普通前端不能授予自己超级管理员。

## 5. 每分钟任务调度

选择生产实际使用的一种调度方式：Vercel production 按 `web/vercel.json` 注册并确认实际触发；自托管由宿主机 cron 或 systemd 调度。以下给出自托管 cron 示例。

- [ ] 在阿里云宿主机建立只供运维读取的 curl 配置文件。使用 `sudoedit` 写入一行，将占位值换成 App 实际使用的 CRON secret：

```bash
sudo install -d -m 700 /etc/wqn-ops
# 文件已存在时先备份，再编辑；新建文件后权限必须为 600。
sudoedit /etc/wqn-ops/cron.curl
sudo chmod 600 /etc/wqn-ops/cron.curl
```

```text
header = "Authorization: Bearer REPLACE_WITH_CRON_SECRET"
```

- [ ] 创建 `/usr/local/sbin/wqn-cron-tick`，实际站点不是示例域名时替换 URL；保存后设为 root 拥有、权限 755：

```bash
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  todo-reminders) ops_timeout=55 ;;
  account-data) ops_timeout=300 ;;
  *) exit 2 ;;
esac
printf '%s %s ' "$(date -u +%FT%TZ)" "$1"
curl --config /etc/wqn-ops/cron.curl \
  --fail-with-body --silent --show-error \
  --connect-timeout 10 --max-time "$ops_timeout" \
  --write-out ' HTTP=%{http_code}\n' \
  "https://wqn.helema.cn/api/cron/$1"
```

- [ ] 确认 cron 服务运行、`curl` / `flock` 可用。写入 `/etc/cron.d/wqn-audit-jobs`，文件 root 拥有、权限 644、末尾保留换行；两个锁分别控制两个任务：

```text
* * * * * root /usr/bin/flock -n -E 0 /run/lock/wqn-todo-reminders.lock /usr/local/sbin/wqn-cron-tick todo-reminders >> /var/log/wqn-todo-reminders.log 2>&1
* * * * * root /usr/bin/flock -n -E 0 /run/lock/wqn-account-data.lock /usr/local/sbin/wqn-cron-tick account-data >> /var/log/wqn-account-data.log 2>&1
```

- [ ] 日志由 root 管理，配置轮转和失败 / 超时告警；Vercel 与宿主机不重复配置同一生产任务。
- [ ] 手工调用前核对待处理队列：两个接口会真实入箱 / 发送推送 / 处理导出和注销，不是只读探针。确认后使用同一任务锁调用：

```bash
sudo /usr/bin/flock -n -E 0 /run/lock/wqn-todo-reminders.lock /usr/local/sbin/wqn-cron-tick todo-reminders
sudo /usr/bin/flock -n -E 0 /run/lock/wqn-account-data.lock /usr/local/sbin/wqn-cron-tick account-data
```

验收：每分钟调度有持续成功记录，无凭据调用为 401；正确凭据调用为 200。提醒响应关注 `enqueued`、`sent`、`pushConfigured`；要求 Web Push 时后者须为 true。账号响应 `{processed:0}` 仅代表空队列，`{processed:1,status:"completed"}` 才代表该次任务完成；HTTP 200 且状态 pending / failed 仍需检查错误与重试。客户端超时不等于服务端任务已取消，应同时检查租约和服务器日志。

## 6. 专用测试账号业务验收

仅使用专用验收账号及其测试文件，登记对应 UUID 和测试记录。注销测试账号不可作为正式超级管理员。

| 场景         | 验收条件                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 基本权限     | 普通账号无法进入管理后台；admin 可访问基础管理；moderator 可审核举报；超级管理员可操作受限功能                             |
| 直接资料写入 | 普通账号通过自己的 JWT / PostgREST 写 `user_role`、`is_active` 被拒绝，普通资料修改成功                                    |
| 停用与恢复   | 保留测试账号旧 JWT，停用后业务入口拒绝；MCP 凭证被撤销；设备账号停用返回 403，恢复后原配对可使用，MCP 凭证需重新授权       |
| 受限分享     | 未授权测试账号不能读取受限题集及复习内容，获授权账号可以；匿名公开分享仍可读                                               |
| 举报         | 专用测试分享提交举报、管理员处理、用户读取结果；隐藏后旧链接拒绝，恢复后可访问；自审被拒绝                                 |
| 应用内提醒   | 创建几分钟后到期的待办；自动 tick 后本人收件箱可见、刷新后仍在；完成 / 取消 / 改期后的提醒状态正确                         |
| 浏览器推送   | HTTPS、真实浏览器授权并订阅；关闭页面后到期收到通知；中文 / 英文点击进入待办页，语言正确，内容与实际任务一致               |
| 账号导出     | 在五分钟内重新认证，申请专用测试账号导出；任务完成、下载解压，记录及原附件完整、无凭证；私有桶不能匿名访问，签名链接有时限 |
| 账号注销     | 专用账号申请注销后立即禁用；任务完成后 Auth、本人模块和文件清理；另一个验收账号已复制的题目 / 图片仍保留                   |
| 入口与后台   | 笔记本统一从笔记本架进入；旧 `/notebooks` 列表回到书架；1664px 与窄屏的中英文后台无横向溢出、双重滚动或文件计数缺失        |

- [ ] Web Push 记录真实发送与终端显示两个结果，不能只凭 `sent` 判定设备已展示；已被推送服务接受的消息无法撤回。
- [ ] Android 当前验收应用内提醒。原生后台待办通知尚未实现，单独保留未交付状态，不把 Android CI 通过计为该能力通过。
- [ ] 导出超过 512 MB 的任务应明确失败，不接收部分导出冒充完整成功；过期文件清理按七天策略验收。下载链接当前有效期为 60 秒。

## 7. 观测、失败处理与恢复写入

- [ ] 按生产数据库管理权限查看状态聚合，不在报告中导出用户内容或推送订阅密钥：

```sql
select kind, status, count(*) from public.account_data_jobs group by kind, status;
select status, count(*) from public.todo_push_deliveries group by status;
```

- [ ] 检查最老待处理任务、失败次数、`next_attempt_at`、租约是否到期、错误是否持续。注销失败会继续 pending 重试，需要关注长时间 pending，不能只监控 failed。
- [ ] 迁移失败：停止应用切换，保留已成功应用的版本记录，分析实际错误并重新预演；不删除迁移历史以重跑。
- [ ] 应用失败：暂停写入与调度，优先修复前进；若回退镜像，选择已经包含本轮权限 / 停用检查且验证兼容当前 schema 的版本，使用其配套配置。直接回到旧安全修复前镜像可能恢复越权路径。
- [ ] 数据库恢复按已准备的数据库与 Storage 配套恢复方案执行；镜像回退不会撤销账号注销、导出清理或已接受的推送。发布脚本保存环境文件备份，但不提供数据库和账号数据的自动恢复。
- [ ] 全部必要验收通过后恢复写入，启用唯一生产调度器并观察至少 15 分钟；记录响应、状态变化和告警，区分应用内提醒通过与 Web Push 未通过的情况。

## 8. 运维回填

| 项目                                      | 执行人 / 时间 | 证据 / 结果  |
| ----------------------------------------- | ------------- | ------------ |
| release SHA、App / Realtime tag 和 digest | 待填          | 待填         |
| 数据库与 Storage 备份 / 恢复点            | 待填          | 私密位置     |
| 六个新增迁移、再次预演无 pending          | 待填          | 待填         |
| 活跃超级管理员、权限与停用验证            | 待填          | 待填         |
| 运行配置布尔检查、VAPID 配套修复 SHA      | 待填          | 不填密钥值   |
| 两个每分钟任务和观测结果                  | 待填          | 待填         |
| 提醒入箱 / 真实 Web Push / 语言跳转       | 待填          | 三项分别记录 |
| 导出与测试账号注销、他人副本保留          | 待填          | 待填         |
| 回退可用版本、配置恢复位置与限制          | 待填          | 待填         |
| 恢复写入时间与观察结果                    | 待填          | 待填         |

参考：[审计修复记录](./AUDIT_REMEDIATION_2026-10-12.md)、[生产迁移入口](../deploy/supabase-push.sh)、[发布入口](../deploy/release.sh)、[运行环境策略](../deploy/release-env-policy.sh)。
