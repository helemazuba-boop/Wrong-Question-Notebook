# data.helema.cn 自托管 Supabase 迁移

本目录是 WQN 从 Supabase Platform 迁移到 `data.helema.cn` 的可审计基建。数据库迁移、Storage 对象复制和应用切换是三个独立门禁；任一步失败都不得修改旧 Cloud 项目或删除旧数据。

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

## 3. 源库门禁与数据库恢复

先对旧 Cloud 执行 v3 约束前检查；它只读数据并会在重复 MAC 或非法 token hash 时失败：

```bash
psql "$SOURCE_DATABASE_URL" \
  --set ON_ERROR_STOP=1 \
  --file deploy/supabase-selfhost/before-v3-push.sql
```

通过后，把仓库内全部 pending migration（包括 v3 与 `20260719010000_self_hosted_security_hardening.sql`）应用到旧 Cloud。必须先 dry-run，输出不得包含意外的历史迁移。若 `supabase migration list --linked` 因 legacy login-role API 失败，使用直接 PostgreSQL URL 的脚本，不依赖 linked project：

```bash
read -rsp 'Old Cloud DB URL: ' SOURCE_DATABASE_URL; echo
export SOURCE_DATABASE_URL
bash deploy/supabase-selfhost/push-source-migrations.sh --dry-run

# 核对 dry-run 清单后才允许写入：
export CONFIRM_SOURCE_MIGRATION_PUSH=apply-20260719-to-old-cloud
bash deploy/supabase-selfhost/push-source-migrations.sh --apply
unset CONFIRM_SOURCE_MIGRATION_PUSH
```

脚本会在 apply 后验证 v3/security invariants 以及两条 20260719 migration history。迁库脚本还会要求源库 migration history 与当前 checkout 完全一致，防止从错误分支或漏迁的库制作快照。

迁移脚本遵循官方要求，使用 `supabase db dump` 分别导出 roles/schema/data；不要用原始 `pg_dump`，不要在生产使用 `--include-seed`。

```bash
cd /home/unknow/projects/WQN
read -rsp 'Old Cloud DB URL: ' SOURCE_DATABASE_URL; echo
read -rsp 'Self-host admin DB URL: ' TARGET_DATABASE_URL; echo
export SOURCE_DATABASE_URL TARGET_DATABASE_URL
bash deploy/supabase-selfhost/database-migrate.sh
unset SOURCE_DATABASE_URL TARGET_DATABASE_URL
```

`TARGET_DATABASE_URL` 必须是维护窗口专用的 PostgreSQL superuser 连接（标准自托管栈为
`supabase_admin`），因为恢复需要保留对象 owner 并临时设置
`session_replication_role=replica`。不要使用 Next.js 的 `SUPABASE_SECRET_KEY`，也不要把
数据库 superuser URL 写入应用 env、日志或 shell history；迁移结束后立即从当前会话移除。

脚本会：

- 拒绝重复设备 MAC、非法 token hash 或未应用 v3 的源库；
- 拒绝覆盖已有 WQN 表的目标库；
- 生成权限为 `0700/0600` 的 dump、SHA-256 和审计输出；
- 在单事务中恢复数据；
- 原样复制并校验源库 `supabase_migrations.schema_migrations`（包括 name/statements），避免后续 `db push` 重放历史；
- 验证关键表、RLS、明文 token 删除、definer 权限和源/目标精确行数。

词库 migration 的原始 statements 约 1 MB，迁移历史的 CSV 导出/导入在低配主机上可能持续数分钟；此阶段没有进度行属于预期，禁止中断后直接继续切流，必须等待随后的 history diff 通过。

`artifacts/` 含数据库业务数据，不得提交、上传公共制品库或长期留在构建机。验收后转移到加密备份介质。

## 4. Storage 对象迁移

数据库 dump 只恢复 Storage 元数据，不恢复对象字节。先做一轮预复制，维护窗口中再做最终 upsert + SHA-256 校验：

```bash
cd /home/unknow/projects/WQN/web
export SOURCE_SUPABASE_URL='https://old-project.supabase.co'
export SOURCE_SUPABASE_SECRET_KEY='...'
export TARGET_SUPABASE_URL='https://data.helema.cn'
export TARGET_SUPABASE_SECRET_KEY='...'
npm run migrate:supabase-storage
```

默认迁移 `avatars,problem-uploads`；通过 `STORAGE_BUCKETS` 显式扩展。任何 checksum mismatch 都是切换阻断项。
脚本也会比较源/目标 bucket 的 public、文件大小上限和 MIME 白名单；不一致时拒绝继续，
并为每个 bucket 输出对象数、总字节数和路径/大小/内容散列组成的 manifest SHA-256。
`VERIFY_STORAGE_BYTES=0` 只可用于预演，输出不能作为正式切换验收证据。

## 5. Auth

生产推荐 `ENABLE_EMAIL_AUTOCONFIRM=false`。邮件模板可使用服务端 token hash：

```html
<a
  href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email&next=%2Fsubjects"
>
  Confirm email
</a>
```

应用 `/auth/callback` 同时兼容 token hash 与 PKCE `code`。迁移后的 JWT signing key不同，旧 Cloud session 默认失效，用户需要重新登录；不要为保留 session 而复制已暴露或无法安全托管的旧 JWT secret。

## 6. 应用配置与镜像

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

切换前校验两个私密 env 文件：

```bash
node deploy/supabase-selfhost/validate-environment.mjs \
  web/.env.production \
  /path/to/self-hosted-supabase/.env
```

历史镜像曾将 service-role、AI key 和 Server Actions key 作为 build args；应视为已暴露。先部署修复后的镜像，再轮换 Supabase server key、AI provider keys、`WQN_REALTIME_PROXY_SECRET` 和 Server Actions key。发布/secret key 可并行启用后逐实例切换，最后禁用旧 key。

## 7. 切换顺序

1. 在隔离主机完成一次全量演练并记录耗时、dump hash、行数和对象数。
2. 预复制 Storage 对象。
3. 进入维护窗口，停止 WQN 与 realtime 写入口。
4. 执行最终数据库 dump/restore和 Storage upsert 校验。
5. 用 `/etc/hosts` 运行下面的 smoke tests。
6. 部署指向 `data.helema.cn` 的 WQN 镜像。
7. 切换 `data.helema.cn` DNS；观察 Auth/REST/Storage/Realtime、5xx、延迟和数据库连接。
8. 验证后恢复写入口。旧 Cloud 保持只读保留，禁止立即删除。

最低 smoke tests：

```bash
curl -fsS https://data.helema.cn/auth/v1/health
curl -i https://data.helema.cn/rest/v1/ \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY"
curl -i https://data.helema.cn/
```

最后一个请求必须返回 `404`，证明 Studio/Kong root 未暴露。随后在浏览器完成注册确认、登录、刷新 session、头像访问；设备完成 bootstrap/sync；Realtime 完成一次 WebSocket 会话。

## 8. 回滚

切换后若出现数据一致性、Auth、Storage 或 Realtime 故障：

1. 立即重新进入维护状态，防止新旧库双写分叉。
2. 将 WQN runtime env 和镜像恢复到旧 Cloud URL/key。
3. 回切 DNS/反向代理并验证旧链路。
4. 保留失败目标库、dump、日志和校验结果用于取证，不在事故窗口执行反向数据合并。

只有在稳定观察期结束、备份恢复演练通过并确认目标库为唯一写源后，才能撤销旧 Cloud key 和旧域名兼容项。
