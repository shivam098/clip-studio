$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot 'server.mjs'
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$start.WorkingDirectory = $PSScriptRoot
$start.UseShellExecute = $false
$start.EnvironmentVariables.Clear()
$start.EnvironmentVariables['SystemRoot'] = $env:SystemRoot
$start.Arguments = ('--permission --max-old-space-size=64 "--allow-fs-read={0}\site" "--allow-fs-read={0}\pages\link-policy.js" "--allow-fs-read={0}\state\pin.json" "{1}"' -f $PSScriptRoot,$entry)
$child = [Diagnostics.Process]::Start($start)
try { $child.WaitForExit(); exit $child.ExitCode }
finally { $child.Dispose() }
