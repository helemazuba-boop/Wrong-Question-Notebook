# Local WSL console bridge. No credentials are copied to the browser.
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$ConsoleArgs)
$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot 'ops/cli.py'
if (-not $ConsoleArgs -or $ConsoleArgs.Count -eq 0) { $ConsoleArgs = @('serve') }
if ($PSScriptRoot -match '^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$') {
    $distro = $Matches[1]
    $linuxPath = '/' + ($Matches[2] -replace '\\', '/') + '/ops/cli.py'
    & wsl.exe --distribution $distro --exec python3 $linuxPath @ConsoleArgs
} elseif ([Environment]::OSVersion.Platform -eq 'Win32NT') {
    $linuxPath = (& wsl.exe wslpath -a $entry).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve WSL path for operations console' }
    & wsl.exe --exec python3 $linuxPath @ConsoleArgs
} else {
    & python3 $entry @ConsoleArgs
}
exit $LASTEXITCODE
