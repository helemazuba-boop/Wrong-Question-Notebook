#!/usr/bin/env bash
# Repo hygiene gate: fail when a forbidden path is tracked.
# See doc/1006-security-fix-plan.md (B3.2) and .gitignore for rationale.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

violations=()

while IFS= read -r path; do
  # Committed env examples/templates are allowed.
  case "$path" in
    .env.example | */.env.example | .env.production.template | */.env.production.template)
      continue
      ;;
  esac

  case "$path" in
    .env | */.env | .env.* | */.env.*) violations+=("$path  (env file; commit .example/.template instead)") ;;
    .vscode/* | */.vscode/*) violations+=("$path  (.vscode editor state)") ;;
    .worktrees/* | */.worktrees/*) violations+=("$path  (.worktrees gitlink)") ;;
    .claude/* | */.claude/*) violations+=("$path  (.claude agent state)") ;;
    serial_log* | */serial_log*) violations+=("$path  (serial log)") ;;
    *.log) violations+=("$path  (log file)") ;;
    *.pem) violations+=("$path  (certificate/key file)") ;;
    *_debug_probe* | */*_debug_probe*) violations+=("$path  (local debug probe)") ;;
  esac
done < <(git ls-files)

if ((${#violations[@]})); then
  echo "Forbidden tracked paths found:" >&2
  printf '  - %s\n' "${violations[@]}" >&2
  echo >&2
  echo "Untrack them (git rm --cached) and keep the pattern in .gitignore." >&2
  exit 1
fi

echo "OK: no forbidden tracked paths."
