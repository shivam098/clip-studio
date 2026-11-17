param([ValidateRange(1024,65535)][int]$Port = 4318)
$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"
$health = Invoke-RestMethod "$base/api/health"
if ($health.name -ne 'Clip Studio') { throw 'This port is not a Clip Studio server; nothing was stopped.' }
$state = Invoke-RestMethod "$base/api/state"
Invoke-RestMethod "$base/api/shutdown" -Method Post `
    -Headers @{ 'X-Studio-Token' = $state.token } `
    -ContentType 'application/json' -Body '{"confirm":"stop-local-studio"}' | Out-Null
Write-Host 'Graceful stop requested. Running local work is cancelled; in-flight publishing requires reconciliation.'
