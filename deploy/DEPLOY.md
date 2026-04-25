# WQN 最低内存占用 Standalone 部署指南

## 架构概览

```
┌──────────────────────────┐     ┌─────────────────────────────┐
│   软路由 (1GB RAM)        │     │     阿里云 ECS (2GB)        │
│   架构: ARM64 (aarch64)   │     │    架构: x86_64 (amd64)   │
│   Rockchip RK3588         │     │     Docker 容器            │
│   Docker 容器 (512m)      │     │    WQN 服务 (1024m)        │
└─────▲──────────▲──────────┘     └───────▲───────────▲──────────┘
      │          │                        │           │
      └──────────┴────────────────────────┴───────────┘
                          │
                   ┌───────▼───────┐
                   │   Supabase    │
                   │  (云端数据库)  │
                   │  PostgreSQL  │
                   │   Auth       │
                   │   Storage    │
                   └──────────────┘
```

**关键设计原则：**
- 所有持久化数据存储在 Supabase 云端数据库（两台机器均不存储本地数据库）
- 两台机器只运行一个 Docker 容器，内存严格隔离
- 阿里云 ACR 作为镜像中转站，两台机器均从 ACR 拉取镜像
- **分离标签策略**：ACR 个人版不支持 manifest list，因此：
  - 软路由拉取 `:{tag}-arm64`
  - ECS 拉取 `:{tag}-amd64`
  - `deploy.sh` 自动检测架构并拉取对应镜像

---

## 系统要求

### 软路由（家庭）
- 架构：**ARM64 (aarch64)** — Rockchip RK3588（ARMv8, 4核 1416MHz）
- 内存：1GB RAM，建议预留 400MB+ 给宿主机
- 系统：OpenWrt with Docker，或 Debian/Ubuntu on ARM
- Docker 版本：20.10+
- 网络：可访问阿里云 ACR

### 阿里云 ECS（云端）
- 架构：**x86_64 (amd64)**
- 内存：2GB RAM
- 系统：Ubuntu 22.04+ / Debian 12+
- Docker 版本：20.10+
- 网络：公网访问

---

## 第一步：在阿里云控制台配置 ACR（容器镜像服务）

> 如果你已在第一阶段完成了 ACR 配置，跳过此步。

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
- **Docker Desktop 设置**：勾选 `Settings → General → "Enable container images"`（启用 Buildx 多架构构建）

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

脚本会自动为两个架构构建并推送到 ACR：

- `linux/amd64` → `:{tag}-amd64`（阿里云 ECS）
- `linux/arm64` → `:{tag}-arm64`（软路由）

```powershell
# 默认 latest tag
.\deploy\build-and-push.ps1

# 指定版本 tag（推荐，方便回滚）
.\deploy\build-and-push.ps1 -Tag "v1.0.0"
```

> **注意**：首次运行会下载 QEMU 模拟镜像（约 30MB），用于在 x86_64 上交叉编译 ARM64 镜像。

### 验证镜像已推送

在阿里云 ACR 控制台 → 镜像仓库 → 查看镜像版本，确认 `latest-amd64` 和 `latest-arm64` 两个架构镜像都已推送。

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

# 镜像（deploy.sh 会自动追加 -arm64 或 -amd64 后缀）
# 软路由：latest-arm64
# 阿里云 ECS：latest-amd64
IMAGE=registry.cn-hangzhou.aliyuncs.com/your-namespace/wqn:latest

# 内存限制（deploy.sh 会根据架构自动设置，也可手动覆盖）
CONTAINER_MEM_LIMIT=512m
CONTAINER_NODE_OPTIONS=--max-old-space-size=200

# Supabase（从 Supabase 控制台获取）
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Gemini AI（从 Google AI Studio 获取）
GEMINI_API_KEY=your-gemini-api-key

# 站点 URL（用于 sitemap 和规范 URL）
SITE_URL=https://your-home-router.ddns.net   # 你的软路由公网地址
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

# 拉取镜像（注意选对架构！）
# 软路由 (ARM64):
docker pull registry.cn-hangzhou.aliyuncs.com/your-namespace/wqn:latest-arm64
# 阿里云 ECS (AMD64):
docker pull registry.cn-hangzhou.aliyuncs.com/your-namespace/wqn:latest-amd64

# 启动容器（以软路由 ARM64 为例）
docker run -d \
  --name wqn \
  --restart unless-stopped \
  --memory 512m \
  --memory-swap 512m \
  --shm-size 64m \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e NEXT_TELEMETRY_DISABLED=1 \
  -e NODE_OPTIONS="--max-old-space-size=200" \
  -e NEXT_PUBLIC_SUPABASE_URL="https://xxx.supabase.co" \
  -e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY="xxx" \
  -e SUPABASE_SERVICE_ROLE_KEY="xxx" \
  -e GEMINI_API_KEY="xxx" \
  -e SITE_URL="http://localhost:3000" \
  registry.cn-hangzhou.aliyuncs.com/your-namespace/wqn:latest-arm64

# 验证
curl http://localhost:3000/api/health
```

---

## 第四步：配置域名和反向代理（可选但推荐）

### 软路由（家庭）配置

如果需要从外网访问，需要配置 DDNS + 反向代理：

1. **DDNS**：在 OpenWrt 上配置阿里云 DDNS，将你的域名动态解析到家庭公网 IP
2. **反向代理**：使用 Nginx/Caddy 将 HTTPS 请求转发到 Docker 容器

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

| 组件 | 软路由 (1GB) | 阿里云 ECS (2GB) |
|------|-------------|------------------|
| 宿主机预留 | ~400MB | ~600MB |
| WQN 容器限制 | 512MB | 1024MB |
| Node.js 堆 | 256MB | 512MB |
| 共享内存 | 64MB | 64MB |
| 估算总占用 | ~600MB | ~1100MB |
| **安全余量** | **~400MB** | **~900MB** |

---

## 常见问题

### Q: Docker 构建失败，提示 `node: command not found`
确保在 `web/` 目录下运行构建脚本，而不是项目根目录。

### Q: 容器启动后立即退出
检查日志：`docker logs wqn`，通常是环境变量缺失导致的。

### Q: 软路由拉取镜像很慢
可以在阿里云 ECS 上先拉取镜像，然后打包传回：
```bash
# ECS 上
docker save wqn:latest -o wqn.tar
# 传回软路由
scp wqn.tar user@router:/tmp/
# 软路由上
docker load -i /tmp/wqn.tar
```

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
目标机器上修改 `.env.production` 中的 `TAG=v1.2.3`，然后重启。

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
