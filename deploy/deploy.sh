#!/bin/bash
# ============================================================
# WQN Remote Deploy Script (run on target machines)
# ============================================================
# Pulls the Docker image from Alibaba Cloud ACR and starts
# the WQN container via docker-compose.
#
# Auto-detects CPU architecture and pulls the correct image:
#   - ARM64 (软路由)  →  :{tag}-arm64
#   - x86_64 (ECS)    →  :{tag}-amd64
#
# PREREQUISITES:
#   - Docker and Docker Compose installed
#   - Network access to ACR
#   - .env.production configured (copy from template)
#
# USAGE:
#   ./deploy.sh
#
# OPTIONS:
#   ./deploy.sh --pull-only   Pull image without starting
#   ./deploy.sh --stop        Stop and remove the container
#   ./deploy.sh --logs        Tail container logs
#   ./deploy.sh --restart     Restart the container
# ============================================================

set -e

# ---------- Detect CPU architecture ----------
detect_arch() {
    local arch=$(uname -m)
    case "$arch" in
        aarch64|arm64)
            echo "arm64"
            ;;
        x86_64|amd64)
            echo "amd64"
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

ARCH=$(detect_arch)

if [[ "$ARCH" == "unknown" ]]; then
    echo "[ERROR] Unknown CPU architecture: $(uname -m)" >&2
    exit 1
fi

echo "[INFO] Detected architecture: $ARCH"

# ---------- Config (fill in your values) ----------
ACR_SERVER="registry.cn-hangzhou.aliyuncs.com"   # e.g. registry.cn-hangzhou.aliyuncs.com
ACR_NAMESPACE="your-namespace"                    # e.g. wqn
ACR_REPO="wqn"                                   # e.g. wqn
ACR_USERNAME="your-access-key-id"                # e.g. yourAccessKeyID
ACR_PASSWORD="your-access-key-secret"             # e.g. yourAccessKeySecret

IMAGE_VERSION="latest"    # Base version tag (without -arm64/-amd64 suffix)

# Memory limit for the container
# 1GB router  (arm64) → CONTAINER_MEM_LIMIT=512m,  CONTAINER_NODE_OPTIONS=--max-old-space-size=200
# 2GB ECS     (amd64) → CONTAINER_MEM_LIMIT=1024m, CONTAINER_NODE_OPTIONS=--max-old-space-size=512
if [[ "$ARCH" == "arm64" ]]; then
    CONTAINER_MEM_LIMIT="512m"
    CONTAINER_NODE_OPTIONS="--max-old-space-size=200"
else
    CONTAINER_MEM_LIMIT="1024m"
    CONTAINER_NODE_OPTIONS="--max-old-space-size=512"
fi

# Site URL for sitemap and canonical URLs
SITE_URL="http://localhost:3000"

# Supabase (get from your Supabase project dashboard)
NEXT_PUBLIC_SUPABASE_URL="https://your-project-id.supabase.co"
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY="your-anon-key"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

# Gemini AI (get from https://aistudio.google.com/app/apikey)
GEMINI_API_KEY="your-gemini-api-key"

# ---------- Derived ----------
# Architecture-specific tag (ACR personal does not support manifest list)
export IMAGE="${ACR_SERVER}/${ACR_NAMESPACE}/${ACR_REPO}:${IMAGE_VERSION}-${ARCH}"
COMPOSE_FILE="docker-compose.yml"
ENV_FILE=".env.production"

# ---------- Detect script directory ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# docker-compose.yml and Dockerfile are in web/ subdirectory
WEB_DIR="$(dirname "$SCRIPT_DIR")"

# ---------- Helpers ----------
usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --pull-only    Pull image from ACR without starting"
    echo "  --stop         Stop and remove the container"
    echo "  --logs         Tail container logs"
    echo "  --restart      Restart the container"
    echo "  --status       Show container status"
    echo "  --help         Show this help message"
    echo ""
    echo "No option → pull + start (default)"
    echo ""
    echo "Detected: ARCH=$ARCH, IMAGE=$IMAGE"
}

log_info()  { echo -e "\033[34m[INFO]\033[0m  $*"; }
log_ok()    { echo -e "\033[32m[OK]\033[0m    $*"; }
log_warn()  { echo -e "\033[33m[WARN]\033[0m  $*"; }
log_error() { echo -e "\033[31m[ERROR]\033[0m $*" >&2; exit 1; }

# ---------- Parse arguments ----------
ACTION="start"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --pull-only)  ACTION="pull-only";  shift ;;
        --stop)       ACTION="stop";        shift ;;
        --logs)       ACTION="logs";        shift ;;
        --restart)    ACTION="restart";     shift ;;
        --status)     ACTION="status";      shift ;;
        --help|-h)    usage; exit 0 ;;
        *)            log_error "Unknown option: $1"; usage; exit 1 ;;
    esac
done

# ---------- Pre-flight ----------
cd "$WEB_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
    log_warn ".env.production not found. Creating from template..."
    cp .env.production.template "$ENV_FILE"
    log_warn "Please edit $ENV_FILE with your real values before deploying."
    exit 1
fi

# ---------- Actions ----------
pull_image() {
    log_info "Pulling image: $IMAGE"

    # Login first
    docker login "$ACR_SERVER" -u "$ACR_USERNAME" -p "$ACR_PASSWORD" || {
        log_error "ACR login failed. Check credentials."
    }

    docker pull "$IMAGE"
    log_ok "Image pulled."
}

start_container() {
    log_info "Starting WQN container..."
    log_info "Image: $IMAGE"

    ACR_SERVER="$ACR_SERVER" \
    ACR_NAMESPACE="$ACR_NAMESPACE" \
    ACR_REPO="$ACR_REPO" \
    CONTAINER_MEM_LIMIT="$CONTAINER_MEM_LIMIT" \
    CONTAINER_NODE_OPTIONS="$CONTAINER_NODE_OPTIONS" \
    SITE_URL="$SITE_URL" \
    NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY="$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY" \
    SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
    GEMINI_API_KEY="$GEMINI_API_KEY" \
    docker compose \
        -f "$WEB_DIR/$COMPOSE_FILE" \
        --env-file "$WEB_DIR/$ENV_FILE" \
        up -d

    log_ok "Container started."
    log_info "Check status: docker compose -f $WEB_DIR/$COMPOSE_FILE ps"
    log_info "View logs:    docker compose -f $WEB_DIR/$COMPOSE_FILE logs -f"
    log_info "Health check:  curl http://localhost:3000/api/health"
}

stop_container() {
    log_info "Stopping WQN container..."
    docker compose -f "$WEB_DIR/$COMPOSE_FILE" down
    log_ok "Container stopped and removed."
}

show_status() {
    docker compose -f "$WEB_DIR/$COMPOSE_FILE" ps
    echo ""
    echo "Memory usage:"
    docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}"
}

# ---------- Dispatch ----------
case "$ACTION" in
    pull-only)
        pull_image
        ;;
    stop)
        stop_container
        ;;
    logs)
        docker compose -f "$WEB_DIR/$COMPOSE_FILE" logs -f
        ;;
    restart)
        stop_container
        pull_image
        start_container
        ;;
    status)
        show_status
        ;;
    start)
        pull_image
        start_container
        ;;
esac
