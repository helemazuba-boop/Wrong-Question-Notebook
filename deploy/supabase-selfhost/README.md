# data.helema.cn 自托管 Supabase 迁移

本目录是 WQN 切换到 `data.helema.cn` 自托管 Supabase 的可审计基建。数据库、Storage 和应用切换是独立门禁；任一步失败都不得切换生产流量。

> 2026-08-27 的当前决策：Supabase Cloud 仍是 primary，腾讯云 self-hosted
> Supabase 仅作为 staging / clone target。本阶段从已 linked 的 Cloud 制作数据库与
> Storage 克隆，不切换生产 DNS、不开放生产写入、不做双写，也不把腾讯目标视为可独立
> 接管流量的最新副本。正式 cutover 必须另行批准并重新执行最终同步与验收。

上游依据：

- [Supabase：Platform 恢复到 Self-hosted](https://supabase.com/docs/guides/self-hosting/restore-from-platform)
- [Supabase：自托管 Docker](https://supabase.com/docs/guides/self-hosting/docker)
- [Supabase：反向代理与 HTTPS](https://supabase.com/docs/guides/self-hosting/self-hosted-proxy-https)
- [Supabase：新 publishable/secret keys](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys)

## 1. 固定拓扑

```text
Browser / Next.js / realtime proxy
               │ HTTPS / WSS
               ▼
       data.helema.cn:443
               │ OpenResty
               ▼
       127.0.0.1:8000 Kong
               │
       Auth / REST / Storage / Realtime
               │
          self-hosted PostgreSQL
```

Kong 的 `8000/8443` 不得监听公网地址；Studio 不经 `data.helema.cn` 暴露。PostgreSQL/Supavisor 端口只允许运维网络访问。

## 2. 准备自托管栈

1. 在目标机按官方 Docker 指南部署 Supabase，并记录所用上游 commit、Postgres/Auth/Storage/Kong 版本。
2. 复制 `selfhost.env.example` 为目标机的私密 `.env`，逐项生成随机值。
3. 确保以下值固定：

   ```dotenv
   SUPABASE_PUBLIC_URL=https://data.helema.cn
   API_EXTERNAL_URL=https://data.helema.cn/auth/v1
   SITE_URL=https://wqn.helema.cn
   ADDITIONAL_REDIRECT_URLS=https://wqn.helema.cn/auth/callback
   ```

4. 将 Kong 的端口映射限制为 `127.0.0.1:8000:8000`。安装 `openresty-data.helema.cn.conf`，替换证书路径后执行 `openresty -t` 再平滑 reload。
5. DNS 切换前先通过 `/etc/hosts` 在运维机验证 TLS、Auth、REST、Storage 和 Realtime。

## 3. 全新目标初始化（当前不执行）

目标 Supabase 基础栈就位后，先用直接 PostgreSQL 管理连接确认迁移计划。脚本拒绝 Supabase Cloud、拒绝已有 WQN 表，并要求显式确认解析出的目标主机：

```bash
cd /home/unknow/projects/WQN
read -rsp 'Self-host admin DB URL: ' TARGET_DATABASE_URL; echo
export TARGET_DATABASE_URL
export CONFIRM_TARGET_DATABASE_HOST='<上一步 URL 中的精确 hostname>'
bash deploy/supabase-selfhost/push-target-migrations.sh --dry-run

# 人工核对完整 migration 清单后：
export CONFIRM_M7_GREENFIELD_INITIALIZATION=initialize-m7-greenfield
bash deploy/supabase-selfhost/push-target-migrations.sh --apply
unset TARGET_DATABASE_URL CONFIRM_TARGET_DATABASE_HOST CONFIRM_M7_GREENFIELD_INITIALIZATION
```

`--apply` 完成后会验证 `20260719000000`、`20260719010000`、RLS、设备 token 哈希以及所有 SECURITY DEFINER 的固定 `search_path`。该路径不读取、不更新 Cloud；它只用于明确批准的 greenfield 初始化，不得与下文的 Cloud clone 流程混用。

## 4. Cloud 数据库克隆到 staging（当前路径）

源 Supabase Cloud 必须由 `web` 目录的 Supabase CLI linked project 访问。源端查询和 dump
不需要也不得要求 `SOURCE_DATABASE_URL`、数据库密码或直接 PostgreSQL 连接。先只读确认
linked project、PostgreSQL 版本和 migration history：

```bash
cd /home/unknow/projects/WQN/web
supabase db query --linked --agent yes --output-format json \
  "select current_user, current_database(), current_setting('server_version');"
supabase migration list --linked
```

本地 `web/supabase/migrations/` 与 remote history 必须完全一致。此流程不会运行
`supabase db push`，发现 pending、remote-only 或乱序 migration 时立即停止并先在独立变更中
完成核对。

数据库 dump、源 row counts 和最终 Storage 同步期间，暂停 WQN Web、Realtime、设备写入、
Storage 上传/删除以及任何 Cloud migration/deploy。Cloud 在维护窗口前后仍是 primary；冻结
只是为了让 schema、data、row counts 和对象字节来自同一个稳定检查点。

目标必须是空的 PostgreSQL 17.6 self-hosted 数据库，并通过本机 SSH tunnel 使用
`supabase_admin` PostgreSQL superuser。不要设置 `ALLOW_NONEMPTY_TARGET=1`。先进行只读确认：

```bash
cd /home/unknow/projects/WQN
set +x
unset SOURCE_DATABASE_URL ALLOW_NONEMPTY_TARGET
read -rsp 'Self-host admin DB URL: ' TARGET_DATABASE_URL; echo
export TARGET_DATABASE_URL

psql "$TARGET_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "
select
  current_user,
  current_database(),
  current_setting('server_version'),
  (select rolsuper from pg_roles where rolname = current_user),
  to_regclass('public.user_profiles');
"
```

输出必须显示预期数据库、PostgreSQL 17.6、superuser 为 `t`，且
`to_regclass('public.user_profiles')` 为空。选择不在 Git 工作树内、权限为 `0700` 的加密或
受控目录保存 artifacts，然后执行数据库克隆：

```bash
export MIGRATION_ARTIFACT_DIR=/absolute/private/path/wqn-clone-20260827
install -d -m 700 "$MIGRATION_ARTIFACT_DIR"
bash deploy/supabase-selfhost/database-migrate.sh
migration_status=$?
unset TARGET_DATABASE_URL
test "$migration_status" -eq 0

sha256sum -c "$MIGRATION_ARTIFACT_DIR/SHA256SUMS"
test ! -s "$MIGRATION_ARTIFACT_DIR/source-migrations.diff"
test ! -s "$MIGRATION_ARTIFACT_DIR/target-migrations.diff"
test ! -s "$MIGRATION_ARTIFACT_DIR/migration-history.diff"
test ! -s "$MIGRATION_ARTIFACT_DIR/row-counts.diff"
```

`TARGET_DATABASE_URL` 必须是维护窗口专用的 PostgreSQL superuser 连接（标准自托管栈为
`supabase_admin`），因为恢复需要保留对象 owner 并临时设置
`session_replication_role=replica`。不要使用 Next.js 的 `SUPABASE_SECRET_KEY`，也不要把
数据库 superuser URL 写入应用 env、日志或 shell history；迁移结束后立即从当前会话移除。

迁移脚本遵循官方要求，从 `web` 目录使用 `supabase db dump --linked` 分别导出
roles/schema/data；不要用原始 `pg_dump`，不要使用 `--include-seed`。源 preflight、migration
history 和 row counts 使用 `supabase db query --linked`，Target 的检查、restore 和验证仍只
使用 `TARGET_DATABASE_URL` + `psql`。

脚本会：

- 拒绝重复设备 MAC、非法 token hash 或未应用 v3 的源库；
- 拒绝覆盖已有 WQN 表的目标库；
- 在 dump 前精确比较 Source/Target 的 Auth 与 Storage migration history，拒绝不兼容的服务 schema；
- 生成权限为 `0700/0600` 的 dump、SHA-256 和审计输出；
- 在单事务中恢复数据；
- 原样复制并校验源库 `supabase_migrations.schema_migrations`（包括 name/statements），避免后续 `db push` 重放历史；
- 验证关键表、RLS、明文 token 删除、definer 权限和源/目标精确行数。

词库 migration 的原始 statements 约 1 MB，迁移历史的 CSV 导出/导入在低配主机上可能持续数分钟；此阶段没有进度行属于预期，禁止中断后直接继续切流，必须等待随后的 history diff 通过。

restore 本身是单事务，但 migration history 重建和最终验证发生在后续事务中。如果脚本在
restore 成功后失败，Target 可能已经非空；不得为了重跑而设置
`ALLOW_NONEMPTY_TARGET=1`。保留失败 artifacts 和目标用于诊断，然后重新创建干净 staging
数据库再执行完整流程。restore 的标准输出和错误输出分别保存在 `restore.txt` 与
`restore-error.txt`，失败时先保留并审查这两个文件，不要直接覆盖重跑。

`artifacts/` 含数据库业务数据，不得提交、上传公共制品库或长期留在构建机。验收后转移到加密备份介质。

## 5. Storage 对象迁移（数据库克隆成功后执行）

数据库 dump 只恢复 Storage 元数据，不恢复对象字节。正式 staging clone 应确保 Target 的
对象存储后端没有上次运行遗留的对象字节，并在源对象写入保持冻结时完成最终 upsert +
SHA-256 校验。若先做在线预复制，必须注意脚本不会删除 Source 已删除但 Target 仍存在的
多余对象；最终验收前应清空并重新建立对象存储后端，或单独证明不存在多余对象。数据库中
`storage.buckets` / `storage.objects` 的 metadata 则由第 4 节 DB restore 带入，不应手工清空。

```bash
# 在阿里云 WQN Web 主机执行；Target 请求必须经 WireGuard 到腾讯云 Kong。
cd /home/unknow/projects/WQN/web
set +x
read -rp 'Source Supabase origin: ' SOURCE_SUPABASE_URL
read -rsp 'Source Supabase secret key: ' SOURCE_SUPABASE_SECRET_KEY; echo
read -rp 'Target Supabase WireGuard origin: ' TARGET_SUPABASE_URL
read -rp 'Confirm exact target origin: ' CONFIRM_TARGET_SUPABASE_ORIGIN
read -rsp 'Target Supabase secret key: ' TARGET_SUPABASE_SECRET_KEY; echo
export SOURCE_SUPABASE_URL SOURCE_SUPABASE_SECRET_KEY
export TARGET_SUPABASE_URL TARGET_SUPABASE_SECRET_KEY CONFIRM_TARGET_SUPABASE_ORIGIN
npm run migrate:supabase-storage
unset SOURCE_SUPABASE_URL SOURCE_SUPABASE_SECRET_KEY
unset TARGET_SUPABASE_URL TARGET_SUPABASE_SECRET_KEY CONFIRM_TARGET_SUPABASE_ORIGIN
```

当前阿里云 Web → WireGuard → 腾讯云 Kong 的 Target origin 是
`http://10.77.0.2:8000`。该 HTTP 连接只能在 WireGuard 加密私网内使用；不得改用公网路径。
脚本要求 `CONFIRM_TARGET_SUPABASE_ORIGIN` 与解析后的 Target origin 精确一致，并默认迁移
`avatars,problem-uploads,word-packs`；通过 `STORAGE_BUCKETS` 显式覆盖。任何 checksum mismatch 都是切换阻断项。
脚本也会比较源/目标 bucket 的 public、文件大小上限和 MIME 白名单；不一致时拒绝继续，
并为每个 bucket 输出对象数、总字节数和路径/大小/内容散列组成的 manifest SHA-256。
`VERIFY_STORAGE_BYTES=0` 只可用于预演，输出不能作为正式切换验收证据。

### 5.1 `problem-uploads` 桶的 MIME 白名单是设备管线的硬依赖

设备内容同步会把 pack 物化为 Storage 对象（`web/lib/device-content-artifacts.ts`
的 `materializeDevicePackArtifact`），上传路径
`user/<uid>/device-packs/<domain>/<logicalId>/<sha256>.jsonl`，
**Content-Type 固定为 `application/x-ndjson`**。若桶开启 "Restrict MIME types"
且白名单未包含该类型，Storage 返回 400，清单接口以
`ARTIFACT_STORAGE_ERROR`(500, retryable) 失败——设备端表现为笔记/错题包
永远"部分完成待重试"、按需下载走不通。

要求：
* `problem-uploads` 的 MIME 白名单必须包含 `application/x-ndjson`；
  未来任何新增的服务端上传 Content-Type 都必须同步进入白名单。
* 变更桶配置后无需重刷设备固件：错误分类为可重试瞬态，下一轮同步自动恢复。
* 排查入口：Supabase Storage 访问日志中的 `POST /storage/v1/object/... 400`
  加上固件侧 `note-study/problem-study manifest failed: ARTIFACT_STORAGE_ERROR`。

## 6. Auth

生产推荐 `ENABLE_EMAIL_AUTOCONFIRM=false`。邮件模板可使用服务端 token hash：

```html
<a
  href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email&next=%2Fsubjects"
>
  Confirm email
</a>
```

应用 `/auth/callback` 同时兼容 token hash 与 PKCE `code`。迁移后的 JWT signing key不同，旧 Cloud session 默认失效，用户需要重新登录；不要为保留 session 而复制已暴露或无法安全托管的旧 JWT secret。

## 7. 应用配置与镜像

复制 `web/.env.production.template`，只在运行时注入服务端 secret。构建参数只能包含：

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY`
- `WQN_SUPABASE_EXPECTED_HOST`
- `SITE_URL`

`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` 是例外的构建期机密：Next.js 官方要求在 `next build` 时提供并嵌入服务端输出。Dockerfile 通过 BuildKit secret 挂载它，不通过 `ARG`/`ENV`，也不把它注入容器运行时环境（部署主机的私密 env 文件仍需保留它供后续构建）。镜像仓库的读取权限仍必须按生产 secret 级别管理。

独立 Realtime 容器不得复用整份主应用 env。`deploy-realtime-remote.ps1` 只生成并上传
`~/.env.wqn-realtime` 白名单文件，其中包含 Supabase 设备查询 key、StepFun key、
内部 HMAC secret 和 Realtime 配置；ACR 凭证、Server Actions key、Gemini/网页 AI key
不会写入该文件。直接 `docker run` 部署时，主应用和 Realtime 必须同时加入私有
`wqn-runtime` 网络，主应用使用网络别名 `wqn`，内部回调固定为 `http://wqn:3000`。

staging 验收前校验两个私密 env 文件：

```bash
node deploy/supabase-selfhost/validate-environment.mjs \
  web/.env.production \
  /path/to/self-hosted-supabase/.env
```

历史镜像曾将 service-role、AI key 和 Server Actions key 作为 build args；应视为已暴露。先部署修复后的镜像，再轮换 Supabase server key、AI provider keys、`WQN_REALTIME_PROXY_SECRET` 和 Server Actions key。发布/secret key 可并行启用后逐实例切换，最后禁用旧 key。

## 8. Staging 克隆验收（当前路径）

1. 在隔离主机部署全新自托管栈并记录所有镜像版本。
2. 进入 clone 窗口，冻结 Cloud 的数据库与 Storage 写入口。
3. 按第 4 节克隆数据库；成功后按第 5 节复制并校验 Storage 对象字节。
4. 用 `/etc/hosts` 验证 `data.helema.cn`，部署仅供 staging 验收、指向腾讯目标的 WQN/realtime 镜像。
5. 执行环境校验和自动 smoke；旧控制面必须返回 `UPGRADE_REQUIRED`，v3 claim 必须可创建和轮询。
6. 完成 Auth、REST、Storage、Realtime、行数与关键业务流程的人工验收。
7. 恢复 Cloud primary 写入口；腾讯 staging 保持隔离，不接收生产流量。
8. 烧录 generation=3 固件的验收必须先通过 M8 ownership gate，再按固件仓库
   `RELEASE_CHECKLIST.md` 完成擦除、配网、网页 claim、bootstrap、sync、刷新、
   100 次睡眠/唤醒和 AI/Flash 实测。USB/充电状态会主动持有睡眠 Lease，深睡验收必须断开 USB、使用电池供电。

本阶段禁止切换 DNS、生产反向代理或生产应用 env。staging smoke 会在腾讯 Target 创建一条
自动过期的 pending claim；因此必须在数据库与 Storage clone 完成后执行。

自动 smoke（不会打印 token 或 8 位显示码；会创建一条自动过期的 pending claim）：

```bash
cd /home/unknow/projects/WQN/web
export SUPABASE_PUBLIC_URL=https://data.helema.cn
export SUPABASE_PUBLISHABLE_KEY='...'
export WQN_BASE_URL=https://wqn.helema.cn
npm run smoke:m7-cutover
```

最低人工 smoke：

```bash
curl -fsS https://data.helema.cn/auth/v1/health
curl -i https://data.helema.cn/rest/v1/ \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY"
curl -i https://data.helema.cn/
```

最后一个请求必须返回 `404`，证明 Studio/Kong root 未暴露。随后在浏览器完成注册确认、登录、刷新 session、头像访问；设备完成 bootstrap/sync；Realtime 完成一次 WebSocket 会话。

## 9. Staging clone 失败处理

Cloud 始终是本阶段 primary，因此 staging clone 失败不需要生产回切：

1. 不修改生产 DNS、反向代理、应用 env 或 Cloud 数据。
2. 记录失败阶段；保留 artifacts、失败 Target 和日志用于诊断。
3. 若数据库 restore 已成功但后续 gate 失败，重新创建干净 Target，不使用
   `ALLOW_NONEMPTY_TARGET=1` 覆盖重跑。
4. 若 Storage gate 失败，保留失败对象后端用于诊断；重试正式验收前清理 staging 对象字节，
   避免遗留对象掩盖 Source 删除。
5. 结束 clone 窗口并恢复 Cloud 写入口；不得把 staging 变更反向合并到 Cloud。

未来生产 cutover 的冻结、最终增量同步、DNS 切换和成对回滚必须另写并审批 runbook；本文件
当前步骤的成功不能替代 cutover approval。
