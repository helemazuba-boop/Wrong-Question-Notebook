# ============================================================
# nginx patch — adds the Flash Realtime WebSocket location to the
# existing wqn.helema.cn server block(s) on the Aliyun ECS host.
# Idempotent: safe to run multiple times.
#
# USAGE (run from Windows PowerShell):
#   .\deploy\patch-nginx-realtime.ps1
#
# Behaviour:
#   1. SSH to the host, locate the nginx config file containing
#      `server_name wqn.helema.cn`.
#   2. Use Python (re module) to find every `server { ... }` block
#      that listens on 80 or 443 and does NOT already contain
#      `location = /api/esp32/realtime`.
#   3. Insert the realtime location block at the top of each match.
#   4. `nginx -t` then `nginx -s reload`.
#
# Pre-conditions:
#   - nginx is running and serving wqn.helema.cn on port 80 (and 443).
#   - You can ssh to $AliyunSshHost without password prompt.
#   - wqn-realtime container is up and listening on 127.0.0.1:8080.
#   - python3 is available on the host (Aliyun ECS images have it).
# ============================================================

[CmdletBinding()]
param(
    [string]$AliyunSshHost = "aliyun"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  Patch nginx for Flash Realtime (idempotent)" -ForegroundColor Cyan
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host ""

# We embed Python via base64 so the host-side shell never sees nested
# quote escape issues. The script writes the patched file, then we
# validate + reload via the same SSH invocation.
$pythonScript = @'
import os, re, sys, shutil, datetime

NGINX_DIR = "/etc/nginx"
NGINX_DIRS_CANDIDATES = [
    "/etc/nginx",
    "/www/server/nginx/conf",         # 宝塔主配置目录（一般 include sites）
    "/www/server/panel/vhost/nginx",  # 宝塔站点 conf 目录
]
DOMAIN = "wqn.helema.cn"
LOCATION_PATH = "/api/esp32/realtime"
MARKER = "# WQN_FLASH_REALTIME_BLOCK"
UPSTREAM = "127.0.0.1:8080"

LOCATION_BLOCK = f"""{MARKER}
location = {LOCATION_PATH} {{
    proxy_pass http://{UPSTREAM}{LOCATION_PATH};
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
}}
"""

def find_conf():
    for NGINX_DIR in NGINX_DIRS_CANDIDATES:
        if not os.path.isdir(NGINX_DIR):
            continue
        for root, _dirs, files in os.walk(NGINX_DIR):
            for name in files:
                if not name.endswith(".conf"):
                    continue
                full = os.path.join(root, name)
                try:
                    with open(full, "r", encoding="utf-8", errors="ignore") as f:
                        if re.search(rf"server_name\s+{re.escape(DOMAIN)}\b", f.read()):
                            return full
                except OSError:
                    continue
    return None

def patch_server(text):
    # Match top-level server { ... } blocks. We do not handle nested
    # braces (nginx doesn't have them, so this is safe).
    server_re = re.compile(r"server\s*\{[^{}]*\}", re.DOTALL)

    def sub(match):
        body = match.group(0)
        if MARKER in body or f"location = {LOCATION_PATH}" in body:
            return body
        if not re.search(r"listen[^;]*\b(?:80|443)\b", body):
            return body
        # Insert before the first `location` directive, else before the
        # closing brace.
        m = re.search(r"^\s*location\b", body, re.MULTILINE)
        if m:
            insert_at = m.start()
            new_body = body[:insert_at] + LOCATION_BLOCK + "\n" + body[insert_at:]
        else:
            new_body = body[:-1] + "\n    " + LOCATION_BLOCK + body[-1]
        return new_body

    return server_re.sub(sub, text)

conf = find_conf()
if not conf:
    print(f"[ERROR] no nginx config containing server_name {DOMAIN} under any of:", file=sys.stderr)
    for d in NGINX_DIRS_CANDIDATES:
        print(f"        - {d}", file=sys.stderr)
    print("        If you installed nginx via a panel (BaoTa / aaPanel / oneinstack),", file=sys.stderr)
    print("        add its vhost dir to NGINX_DIRS_CANDIDATES or edit the conf by hand.", file=sys.stderr)
    sys.exit(1)

print(f"[patch-nginx] target: {conf}")

with open(conf, "r", encoding="utf-8", errors="ignore") as f:
    original = f.read()

if MARKER in original or f"location = {LOCATION_PATH}" in original:
    print("[patch-nginx] already patched, skipping rewrite")
    sys.exit(0)

backup = f"{conf}.bak-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}"
shutil.copy2(conf, backup)
print(f"[patch-nginx] backup: {backup}")

patched = patch_server(original)
if MARKER not in patched:
    print("[ERROR] patch produced no marker; rolling back", file=sys.stderr)
    sys.exit(1)

tmp = conf + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    f.write(patched)
os.replace(tmp, conf)
print("[patch-nginx] file written")
'@

$pythonBase64 = [Convert]::ToBase64String(
    [System.Text.Encoding]::UTF8.GetBytes($pythonScript)
)

# Verify that python3 exists on the host first.
Write-Host "  [1/3] Checking python3 on host..." -ForegroundColor Yellow
$checkResult = & ssh $AliyunSshHost "command -v python3 && python3 --version"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  [ERROR] python3 not found on the host. Install it or run this patch manually." -ForegroundColor Red
    exit 1
}
Write-Host "        $checkResult" -ForegroundColor DarkGray

# Run the Python patcher.
Write-Host "  [2/3] Patching nginx config..." -ForegroundColor Yellow
$pythonB64Var = $pythonBase64
$remotePatchScript = @"
set -e
echo '${pythonB64Var}' | base64 -d > /tmp/wqn_patch_nginx.py
python3 /tmp/wqn_patch_nginx.py
rm -f /tmp/wqn_patch_nginx.py
"@
$remotePatchScript | & ssh $AliyunSshHost "bash -s"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  [ERROR] nginx config patch failed on host." -ForegroundColor Red
    exit 1
}

# Validate and reload.
Write-Host "  [3/3] Validating and reloading nginx..." -ForegroundColor Yellow
$validateScript = @"
nginx -t
nginx -s reload
echo "[patch-nginx] reload ok"
"@
$validateScript | & ssh $AliyunSshHost "bash -s"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  [ERROR] nginx -t or reload failed. The backup file on the host holds the previous good config." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  nginx patched and reloaded." -ForegroundColor Green
Write-Host ""
Write-Host "  Verify from your laptop:" -ForegroundColor Yellow
Write-Host "    curl -i --http1.1 " -NoNewline -ForegroundColor White
Write-Host "       -H 'Connection: Upgrade' -H 'Upgrade: websocket'" -ForegroundColor White
Write-Host "       -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGVzdA=='" -ForegroundColor White
Write-Host "       -H 'Sec-WebSocket-Protocol: wqn-flash-v2'" -ForegroundColor White
Write-Host "       https://wqn.helema.cn/api/esp32/realtime" -ForegroundColor White
Write-Host ""
Write-Host "  Expected: HTTP/1.1 101 Switching Protocols" -ForegroundColor Yellow
Write-Host "            (or 401 if no Bearer token was provided)" -ForegroundColor Yellow
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host ""