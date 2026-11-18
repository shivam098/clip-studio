$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'ClipStudioRemote'
if (Test-Path -LiteralPath $root) { throw 'ClipStudioRemote already exists. Do not overwrite a running installation.' }
$files = 'server.mjs','Start-Editor.ps1','Stop-Editor.ps1','operator.mjs','quick.yml','README.md',
         'pages/link-policy.js','site/index.html','site/editor.css','site/editor.js','site/mediabunny.js','site/mediabunny-license.txt'
$repo = Split-Path $PSScriptRoot -Parent
$archive = Join-Path ([System.IO.Path]::GetTempPath()) ("clip-editor-" + [guid]::NewGuid() + ".zip")
try {
    & git -C $repo archive -o $archive HEAD:remote -- @files
    if ($LASTEXITCODE -ne 0) { throw 'Could not archive the committed remote editor.' }
    New-Item -ItemType Directory -Path $root | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $root
    New-Item -ItemType Directory -Path (Join-Path $root 'state') | Out-Null
    [IO.File]::WriteAllText((Join-Path $root 'state\pin.json'), '{}')
} finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
}
Write-Output 'Installed the independent browser editor in %LOCALAPPDATA%\ClipStudioRemote. Nothing is running or shared by this installer.'
