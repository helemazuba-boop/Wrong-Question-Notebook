#!/usr/bin/env bash
# Shared environment update engine; durable records and recovery live on ECS.
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in
  --check) shift; exec python3 "$SCRIPT_DIR/ops/cli.py" env-check "$@" ;;
  --preview) shift; exec python3 "$SCRIPT_DIR/ops/cli.py" env-preview "$@" ;;
  -h|--help)
    echo 'Usage: bash deploy/update-env.sh [--check|--preview|--yes] [--ssh-host HOST]'
    echo 'Default: review the env plan, save a cloud snapshot, recreate App and verify.'
    echo '--check: local validation. --preview: read-only cloud comparison.'
    exit 0 ;;
  *) exec python3 "$SCRIPT_DIR/ops/cli.py" env "$@" ;;
esac
