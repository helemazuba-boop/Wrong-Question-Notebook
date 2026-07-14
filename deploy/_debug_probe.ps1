$tmp = [System.IO.Path]::GetTempPath()
$probe = Join-Path $tmp "wqn-probe-env.psh"
"'#!/bin/bash'", "set -e", "ENV_FILE='`$HOME/.env.production'", 'if [ -f "$ENV_FILE" ]; then echo EXISTS; else echo MISSING; fi' | ForEach-Object { Add-Content -LiteralPath $probe -Value $_ }
Get-Content -LiteralPath $probe -Raw
