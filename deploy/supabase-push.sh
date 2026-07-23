#!/usr/bin/env bash
# ============================================================
# WQN Supabase migration deploy - WSL/bash port of supabase-push.bat
# ============================================================
# Runs the Supabase CLI to apply pending DB migrations:
#   1. supabase --version
#   2. supabase migration list --linked
#   3. supabase db push --linked --dry-run
#   4. supabase db push --linked        (skipped if --dry-run-only)
#
# Pure bash - no PowerShell / pwsh dependency. Requires the
# `supabase` CLI on PATH and a linked project.
#
# USAGE:
#   ./supabase-push.sh                 # dry-run then apply
#   ./supabase-push.sh --include-all   # include-all migrations
#   ./supabase-push.sh --dry-run-only  # dry-run, do not apply
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WEB_DIR="$PROJECT_ROOT/web"

if [[ ! -d "$WEB_DIR" ]]; then
  echo "ERROR: web dir not found: $WEB_DIR" >&2
  exit 1
fi
cd "$WEB_DIR" || { echo "ERROR: cannot cd to $WEB_DIR" >&2; exit 1; }

EXTRA_ARGS=()
DRY_RUN_ONLY=0

while (( $# )); do
  case "$1" in
    --include-all)   EXTRA_ARGS+=(--include-all); shift ;;
    --dry-run-only)  DRY_RUN_ONLY=1; shift ;;
    *) echo "ERROR: Unknown argument: $1" >&2; exit 1 ;;
  esac
done

echo "WQN Supabase migration deploy"
echo "Web dir: $WEB_DIR"
echo "Extra args: ${EXTRA_ARGS[*]:-}"
if (( DRY_RUN_ONLY )); then echo "Mode: dry-run only"; fi
echo

if ! command -v supabase >/dev/null 2>&1; then
  echo "ERROR: Supabase CLI was not found in PATH." >&2
  exit 1
fi

echo "[1/4] Supabase CLI version"
supabase --version || { echo "ERROR: supabase --version failed." >&2; exit 1; }

echo
echo "[2/4] Current migration status"
supabase migration list --linked || { echo "ERROR: migration list failed." >&2; exit 1; }

echo
echo "[3/4] Dry run"
if (( ${#EXTRA_ARGS[@]} > 0 )); then
  supabase db push --linked --dry-run "${EXTRA_ARGS[@]}" \
    || { echo "ERROR: dry-run failed." >&2; exit 1; }
else
  supabase db push --linked --dry-run \
    || { echo "ERROR: dry-run failed." >&2; exit 1; }
fi

if (( DRY_RUN_ONLY )); then
  echo
  echo "Dry run complete. No migrations were applied."
  exit 0
fi

echo
echo "[4/4] Applying pending migrations"
if (( ${#EXTRA_ARGS[@]} > 0 )); then
  echo "WARNING: Running with ${EXTRA_ARGS[*]}."
  supabase db push --linked "${EXTRA_ARGS[@]}" \
    || { echo "ERROR: db push failed." >&2; exit 1; }
else
  supabase db push --linked \
    || { echo "ERROR: db push failed." >&2; exit 1; }
fi

echo
echo "[verify] Migration status after push"
supabase migration list --linked \
  || { echo "ERROR: post-push migration list failed." >&2; exit 1; }

echo
echo "Supabase migration deploy complete."
exit 0
