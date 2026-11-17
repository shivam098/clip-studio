param(
    [ValidateRange(1024,65535)][int]$Port = 4318,
    [string]$DataDirectory = (Join-Path $env:LOCALAPPDATA 'ClipStudio\data')
)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node -ErrorAction Stop).Source
$major = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($major -lt 24) { throw 'Clip Studio requires Node.js 24 or later.' }
$env:PORT = [string]$Port
$env:CLIP_STUDIO_DATA = $DataDirectory
Write-Host "Local trial: http://localhost:$Port"
Write-Host 'Keep this terminal open. Ctrl+C or Stop-ClipStudio.ps1 stops the server.'
& $node (Join-Path $appRoot 'src\server.mjs')
exit $LASTEXITCODE
