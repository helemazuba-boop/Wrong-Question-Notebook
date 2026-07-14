# WQN Flash Realtime — Nginx 配置补丁（ECS 上执行）

## 你的现状（来自你给的诊断输出）

```
LISTEN 0.0.0.0:80   nginx    ← 命中 301 → https，固件跟不了死掉
LISTEN 0.0.0.0:443  nginx    ← 反代到 3000 是有，但 /api/esp32/realtime 也没单独配
LISTEN 0.0.0.0:3000 docker-proxy
无 :8080 监听        ← Bun relay 没起
```

#80 收到的是 `301 Moved Permanently → https://` —— 这意味着
你的 nginx 80 server 块只有 `return 301 https://$host$request_uri`，没有任何 location。
**这是固件立刻失败的根因。**

#443 你应该有 location / 转发到 wqn-app:3000，但**没有**单独的
`location = /api/esp32/realtime` 反代到 wqn-realtime:8080。

## 修复方法（按下面两步操作）

### 1) 找到 nginx 配置文件

```bash
sudo nginx -T 2>/dev/null | grep -E 'include\s+' | grep -v '#'
```

会列出 `conf.d/*.conf` 或 `sites-enabled/*` 的 include 路径，找到
包含 `server_name wqn.helema.cn` 的那个文件。例如：

```bash
sudo nginx -T 2>/dev/null | grep -rl 'wqn.helema.cn' | head
# /etc/nginx/conf.d/wqn.conf     ← 你的实际文件
# /etc/nginx/sites-enabled/wqn   ← 可能是这个
```

### 2) 在那个文件里加两个 location（先看现有的 server 块）

最常见的形态是两段 server（一个 80，一个 443）。**你至少要在 443
那一段加上 `location = /api/esp32/realtime`**；**强烈建议**同时在 80
一段也加，理由见末尾"为什么不能靠 301"。

把下面这段追加到你 nginx 文件里（**编辑前先备份**）：

```nginx
# ============================================================
# Flash Realtime WebSocket — relay to Bun wqn-realtime:8080
# ============================================================
# This must appear BEFORE the catch-all `location /` block in the
# same server, because nginx matches longest-location-prefix first;
# the `=` modifier pins the match to this exact path.

# 443 server block — add this inside your existing `server { listen 443 ... }`:
location = /api/esp32/realtime {
    proxy_pass http://127.0.0.1:8080/api/esp32/realtime;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    proxy_connect_timeout 30s;
    proxy_buffering off;
    proxy_redirect off;
}

# 80 server block — same thing, so plain-HTTP WS clients work too:
# (ESP32 ESP-IDF WS client will follow 301 only if you set
#  CONFIG_ESP_WEBSOCKET_CLIENT_ENABLE_REDIRECT=y. Easier to just
#  proxy it directly.)
location = /api/esp32/realtime {
    proxy_pass http://127.0.0.1:8080/api/esp32/realtime;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    proxy_connect_timeout 30s;
    proxy_buffering off;
    proxy_redirect off;
}
```

为什么这么写：
- `proxy_pass http://127.0.0.1:8080/...`：Bun 容器开了
  `expose: "8080"`，但 *不* publish 到 host（防直接外网穿透），由 nginx
  走 host loopback 访问。
- `proxy_set_header Upgrade $http_upgrade` + `Connection "upgrade"`：
  **缺一不可**，不然 nginx 把 WS 升级请求当普通 HTTP 处理。
- `proxy_buffering off`：WS 帧要立刻转发，不能 buffer。
- `= /api/esp32/realtime`：精确匹配，优先于任何 `location /`。

### 3) 验证配置 + reload

```bash
sudo nginx -t                           # 语法检查必须 OK
sudo nginx -s reload                    # 平滑 reload
sudo nginx -T 2>/dev/null | grep -B1 -A 15 "esp32/realtime"
# 应该看到上面两段 location
```

### 4) 自测（curl）

```bash
curl -i --http1.1 \
     -H "Connection: Upgrade" \
     -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" \
     -H "Sec-WebSocket-Key: dGVzdA==" \
     -H "Sec-WebSocket-Protocol: wqn-flash-v2" \
     https://wqn.helema.cn/api/esp32/realtime
```

期望：返回 `HTTP/1.1 101 Switching Protocols`
或 `426 Upgrade Required`（如果 WQN_REALTIME_PROXY_SECRET 配置错误）。**绝不能**再返 `301`。

### 5) 起 wqn-realtime 容器

(此步骤在 Nginx 配置生效后再做，否则再配)

在 `web/` 目录里有 `docker-compose.yml` 包含 `wqn-realtime` 服务。
在 ECS 上跑：

```bash
cd /path/to/deploy/parent  # 要能找到 web/docker-compose.yml
# 你的 .env.production 必须在 web/ 下，或者用 --env-file
docker compose -f web/docker-compose.yml --env-file web/.env.production up -d wqn-realtime
docker compose -f web/docker-compose.yml --env-file web/.env.production ps
docker logs wqn-realtime --tail 50
curl http://127.0.0.1:8080/health
# → {"status":"ok"}
```

## 为什么不能靠 "打开 ESP32 redirect"

ESP-IDF 的 `esp_websocket_client` 默认**不会** follow 301。
要让 ESP32 自己跟重定向，必须：
1. menuconfig `CONFIG_ESP_WEBSOCKET_CLIENT_ENABLE_REDIRECT=y`
2. 重新 build & flash 固件

而且即使开了 redirect，**首跳还是 80 端口**，会先经过一次明文
HTTP。在中国大陆安全合规要求下也是不可接受的（设备就算走明文
也属于传输不加密违规）。

**正解就是 nginx 在 80 / 443 两段都加 location 反代**，让固件一次到位 TLS+WS。

## 重启顺序 (每次部署都要按这个顺序)

1. `docker compose up -d wqn-realtime`（或 `docker compose up -d`）
2. `curl http://127.0.0.1:8080/health`  → "ok"
3. `sudo nginx -s reload`
4. `curl -i --upgrade https://wqn.helema.cn/api/esp32/realtime` → 101 / 426
5. 重启/扫描设备，固件应连上
