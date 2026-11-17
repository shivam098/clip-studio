param([string]$Destination = (Join-Path $env:LOCALAPPDATA 'ClipStudio\app'))
$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot -Parent
if (Test-Path $Destination) {
    throw "Destination already exists: $Destination. Stop the old trial and choose a new versioned destination; do not overwrite running code."
}
New-Item -ItemType Directory -Force $Destination | Out-Null
$archive = Join-Path $Destination 'source.zip'
try {
    & git -C $source archive --format=zip -o $archive HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Could not archive committed source.' }
    Expand-Archive -LiteralPath $archive -DestinationPath $Destination
} finally {
    if (Test-Path $archive) { Remove-Item -LiteralPath $archive }
}
Write-Host "Committed source installed at $Destination"
Write-Host "Start: & '$Destination\scripts\Start-ClipStudio.ps1'"
Write-Host 'Install/configure media and speech dependencies separately. This installer makes no network calls.'
