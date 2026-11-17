param([ValidateSet('protect','unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$value = [Console]::In.ReadToEnd()
if ($Mode -eq 'protect') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($value)
    try {
        $protected = [Security.Cryptography.ProtectedData]::Protect(
            $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        [Console]::Write([Convert]::ToBase64String($protected))
    } finally { [Array]::Clear($bytes, 0, $bytes.Length) }
} else {
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect(
        [Convert]::FromBase64String($value), $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try { [Console]::Write([Text.Encoding]::UTF8.GetString($bytes)) }
    finally { [Array]::Clear($bytes, 0, $bytes.Length) }
}
