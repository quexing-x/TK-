param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[a-z][a-z0-9_-]{2,31}$")]
  [string]$Username,
  [ValidateRange(10, 300)]
  [int]$ClearAfterSeconds = 60
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Windows.Forms

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$source = Join-Path $root "private\login-test-credentials.dpapi"
if (-not (Test-Path -LiteralPath $source)) {
  throw "Encrypted account document not found."
}

$encrypted = [IO.File]::ReadAllBytes($source)
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $encrypted,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
$lines = [Text.Encoding]::UTF8.GetString($plainBytes) -split "`r?`n"
$fields = $lines |
  Where-Object { $_ -match "`t$([regex]::Escape($Username))`t" } |
  Select-Object -First 1 |
  ForEach-Object { $_ -split "`t", 3 }
if (-not $fields -or $fields.Count -ne 3) {
  throw "Account not found in the encrypted document."
}

$password = $fields[2]
[Windows.Forms.Clipboard]::SetText($password)
Write-Output "Password for $Username copied to the clipboard for up to $ClearAfterSeconds seconds."
Start-Sleep -Seconds $ClearAfterSeconds
if ([Windows.Forms.Clipboard]::ContainsText() -and [Windows.Forms.Clipboard]::GetText() -eq $password) {
  [Windows.Forms.Clipboard]::Clear()
  Write-Output "Clipboard cleared."
}
$password = $null
$plainBytes = $null
