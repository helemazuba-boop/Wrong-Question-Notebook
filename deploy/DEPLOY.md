# WQN 最低内存占用 Standalone 部署指南

> Supabase 迁移到 `data.helema.cn` 的数据库、Storage、OpenResty/Kong、密钥轮换和回滚流程见 [supabase-selfhost/README.md](./supabase-selfhost/README.md)。

## 架构概览

```
┌──────────────────────────┐     ┌─────────────────────────────┐
│   阿里云 ECS (2GB)        │     │     阿里云 ECS (2GB)        │
│   架构: x86_64 (amd64)   │     │     架构: x86_64 (amd64)   │
│   Docker 容器 (1024m)     │     │     Docker 容器 (1024m)     │
└─────▲──────────▲──────────┘     └───────▲───────────▲──────────┘
      │          │                        │           │
      └──────────┴────────────────────────┴───────────┘
                          │
                   ┌───────▼───────┐
                   │   Supabase    │
                   │ data.helema.cn│
                   │  PostgreSQL  │
                   │   Auth       │
                   │   Storage    │
                   └──────────────┘
```

**关键设计原则：**

- 所有持久化数据存储在 `data.helema.cn` 自托管 Supabase
- 每台机器只运行一个 Docker 容器，内存严格隔离
- 阿里云 ACR 作为镜像中转站，机器从 ACR 拉取镜像

---

## 系统要求

### 阿里云 ECS

- 架构：**x86_64 (amd64)**
- 内存：2GB RAM
- 系统：Ubuntu 22.04+ / Debian 12+
- Docker 版本：20.10+
- 网络：公网访问

---

## 第一步：在阿里云控制台配置 ACR（容器镜像服务）

1. 登录 [阿里云容器镜像服务控制台](https://cr.console.aliyun.com)
2. 创建**企业版**或**个人版**实例
3. 创建**命名空间**（Namespace），如 `wqn`
4. 创建**镜像仓库**，如 `wqn`
5. 设置**访问凭证**（固定密码）
6. 记录以下信息：
   - 登录服务器：`registry.cn-<region>.aliyuncs.com`
   - 命名空间：`wqn`
   - 仓库名：`wqn`
   - 用户名：你的阿里云 AccessKey ID
   - 密码：你的 AccessKey Secret

---

## 第二步：在本地构建并推送镜像

### 前置条件

- Windows/macOS/Linux 开发机
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) 已安装并运行
- **Docker Desktop 设置**：勾选 `Settings → General → "Enable container images"`

### 凭证配置

脚本从 `web/.env.production` 读取 ACR 凭证。

1. 创建配置文件：

```powershell
cd D:\projects\Ali\Wrong-Question-Notebook
cp web\.env.production.template web\.env.production
```

2. 编辑 `web/.env.production`，填入你的 ACR 信息：

```bash
ACR_SERVER=crpi-xxxxxxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com
ACR_NAMESPACE=your-namespace
ACR_REPO=wqn
ACR_USERNAME=nick2075099365          # 你的阿里云用户名
ACR_PASSWORD=your-acr-password       # 你在 ACR 里设置的固定密码
```

> `.env.production` 已被 `.gitignore` 排除，不会提交到 Git。

### 构建镜像

```powershell
# 默认 latest tag
.\deploy\build-and-push.ps1

# 指定版本 tag（推荐，方便回滚）
.\deploy\build-and-push.ps1 -Tag "v1.0.0"

# 构建推送后自动部署到 SSH Host `aliyun`
.\deploy\build-and-push.ps1 -DeployAliyun

# 或使用双击友好的 bat 入口，默认会构建、推送并部署到 SSH Host `aliyun`
.\deploy\build.bat

# bat 入口带其他参数时仍会默认部署到阿里云
.\deploy\build.bat -Tag "v1.0.0"
```

### 可选：自动推送到阿里云 ECS

本地 OpenSSH 配置需要包含 `aliyun` Host：

```sshconfig
Host aliyun
    HostName 121.43.145.73
    User root
    IdentityFile C:\Users\ZhuanZ\.ssh\PC-LEGION.pem
```

带 `-DeployAliyun` 参数时（或直接运行 `deploy\build.bat` 时），脚本会在镜像推送成功后执行远程部署：

```bash
docker pull <本次构建的镜像>
docker stop wqn-app || true
docker rm wqn-app || true
docker network inspect wqn-runtime || docker network create wqn-runtime
docker run -d --name wqn-app --network wqn-runtime --network-alias wqn \
  -p 3000:3000 <本次构建的镜像>
docker image prune -f
```

远程部署只会从本地配置生成主应用运行时白名单文件；
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` 仅通过 BuildKit secret 参与构建，不会进入容器环境。
Realtime 发布同样从本地配置派生独立的 `~/.env.wqn-realtime`，不会上传 ACR 凭证、
主应用 AI key 或整份 `.env.production`。两个容器通过私有 `wqn-runtime` 网络通信，
Realtime 的 `WQN_INTERNAL_API_BASE` 应设为 `http://wqn:3000`。

可选参数：

```powershell
.\deploy\build-and-push.ps1 -DeployAliyun `
  -AliyunSshHost aliyun `
  -AliyunContainerName wqn-app `
  -AliyunPortMap 3000:3000 `
  -AliyunNetworkName wqn-runtime
```

### 验证镜像已推送

在阿里云 ACR 控制台 → 镜像仓库 → 查看镜像版本，确认镜像已推送。

---

## 第三步：部署到目标机器

### 3.1 配置环境变量

在目标机器的 `web/` 目录下：

```bash
cd /path/to/Wrong-Question-Notebook/web
cp .env.production.template .env.production
nano .env.production   # 填写真实值
```

必需的配置项：

```bash
# ACR 凭证（deploy.sh 用来登录和拉取镜像）
ACR_SERVER=registry.cn-hangzhou.aliyuncs.com
ACR_NAMESPACE=your-namespace
ACR_REPO=wqn
ACR_USERNAME=your-access-key-id
ACR_PASSWORD=your-access-key-secret

# 镜像
IMAGE=registry.cn-hangzhou.aliyuncs.com/your-namespace/wqn:latest

# 自托管 Supabase
NEXT_PUBLIC_SUPABASE_URL=https://data.helema.cn
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY=sb_publishable_xxx
WQN_SUPABASE_EXPECTED_HOST=data.helema.cn
# HTTPS 部署留空；私网 HTTP 部署必须填写与 URL 完全相同的 origin。
WQN_ALLOW_HTTP_SUPABASE_ORIGIN=
SUPABASE_SECRET_KEY=sb_secret_xxx

# Gemini AI（从 Google AI Studio 获取）
GEMINI_API_KEY=your-gemini-api-key

# 站点 URL（用于 sitemap 和规范 URL）
SITE_URL=https://your-domain.com
```

### 3.2 部署脚本（推荐方式）

在目标机器上运行：

```bash
# 下载/同步 deploy 目录（包含 deploy.sh、docker-compose.yml、.env.production）
# 假设你已通过 scp/sync 将项目同步到目标机器

cd /path/to/deploy

# 首次部署
./deploy.sh

# 查看日志
./deploy.sh --logs

# 查看状态
./deploy.sh --status

# 停止服务
./deploy.sh --stop

# 重启服务
./deploy.sh --restart

# 仅拉取镜像
./deploy.sh --pull-only
```

### 3.3 手动 Docker 部署（备用）

```bash
cd /path/to/Wrong-Question-Notebook/web

# 登录 ACR
docker login registry.cn-hangzhou.aliyuncs.com -u YOUR_ACCESS_KEY_ID -p YOUR_ACCESS_KEY_SECRET

# 拉取镜像
docker pull registry.cn-hangzhou.aliyuncs.com/your-namespace/wqn:latest

# 启动容器
docker run -d \
  --name wqn \
  --restart unless-stopped \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e NEXT_TELEMETRY_DISABLED=1 \
  -e NEXT_PUBLIC_SUPABASE_URL="https://data.helema.cn" \
  -e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY="xxx" \
  -e WQN_SUPABASE_EXPECTED_HOST="data.helema.cn" \
  -e WQN_ALLOW_HTTP_SUPABASE_ORIGIN="" \
  -e SUPABASE_SECRET_KEY="xxx" \
  -e GEMINI_API_KEY="xxx" \
  -e SITE_URL="http://localhost:3000" \
  registry.cn-hangzhou.aliyuncs.com/your-namespace/wqn:latest

# 验证
curl http://localhost:3000/api/health
```

---

## 第四步：配置域名和反向代理（可选但推荐）

### 阿里云 ECS 配置

1. **反向代理**：使用 Nginx/Caddy 将 HTTPS 请求转发到 Docker 容器

示例 Nginx 配置：

```nginx
server {
    listen 443 ssl;
    server_name wqn.your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 内存占用估算

| 组件         | 阿里云 ECS (2GB) |
| ------------ | ---------------- |
| 宿主机预留   | ~600MB           |
| WQN 容器限制 | 1024MB           |
| Node.js 堆   | 512MB            |
| 共享内存     | 64MB             |
| 估算总占用   | ~1100MB          |
| **安全余量** | **~900MB**       |

---

## 常见问题

### Q: Docker 构建失败，提示 `node: command not found`

确保在 `web/` 目录下运行构建脚本，而不是项目根目录。

### Q: 容器启动后立即退出

检查日志：`docker logs wqn`，通常是环境变量缺失导致的。

### Q: 如何更新到新版本？

```bash
# 更新镜像
./deploy.sh --restart   # 会自动拉取最新镜像并重启

# 或手动
docker pull registry.cn-hangzhou.aliyuncs.com/wqn/wqn:latest
docker compose -f docker-compose.yml up -d
```

### Q: 如何回滚到旧版本？

使用版本标签构建不同版本：

```powershell
.\deploy\build-and-push.ps1 ... -Tag "v1.2.3"
```

目标机器上修改 `.env.production` 中的 `IMAGE_VERSION=v1.2.3`，然后重启。

### Q: 健康检查失败

```bash
docker exec wqn wget -qO- http://localhost:3000/api/health
```

确认 API 端点返回 `{"status":"ok"}`。

---

## 维护命令

```bash
# 查看容器资源使用
docker stats

# 进入容器调试
docker exec -it wqn sh

# 查看 Next.js 日志
docker logs wqn --tail 100

# 完全重建
docker compose -f docker-compose.yml down --rmi all
docker compose -f docker-compose.yml up -d --build
```
