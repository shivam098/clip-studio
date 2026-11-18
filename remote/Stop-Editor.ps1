$ErrorActionPreference = 'Stop'
$listeners = @(Get-NetTCPConnection -LocalPort 4319 -State Listen -ErrorAction SilentlyContinue)
if (!$listeners.Count) { Write-Output 'The editor is not listening.'; return }
if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') { throw 'Unexpected listener; nothing stopped.' }
$processId = $listeners[0].OwningProcess
$process = Get-Process -Id $processId
try {
    $null = $process.Handle
    $entry = [regex]::Escape((Join-Path $PSScriptRoot 'server.mjs'))
    $info = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
    if ($process.HasExited -or $info.Name -ine 'node.exe' -or $info.CommandLine -notmatch (' "' + $entry + '"$')) {
        throw 'Port is not owned by this editor installation; nothing stopped.'
    }
    Stop-Process -Id $processId -ErrorAction Stop
    Write-Output 'Stopped this browser editor only.'
} finally { $process.Dispose() }
