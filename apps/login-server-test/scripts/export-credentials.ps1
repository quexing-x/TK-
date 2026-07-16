$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$source = Join-Path $root ".env.login-test"
$targetDirectory = Join-Path $root "private"
$target = Join-Path $targetDirectory "login-test-credentials.dpapi"

if (-not (Test-Path -LiteralPath $source)) {
  throw "Missing .env.login-test. Run pnpm login-test:secrets first."
}

$values = @{}
Get-Content -LiteralPath $source -Encoding utf8 | ForEach-Object {
  if ($_ -match "^\s*#" -or $_ -notmatch "=") { return }
  $name, $value = $_ -split "=", 2
  $values[$name.Trim()] = $value.Trim()
}

$lines = @(
  "TK Ads Automation central login test accounts",
  "Protected for the current Windows user. Never commit or send in chat.",
  "",
  "Developer`t$($values['TK_AUTO_TEST_DEVELOPER_USERNAME'])`t$($values['TK_AUTO_TEST_DEVELOPER_PASSWORD'])"
)
for ($index = 1; $index -le 5; $index++) {
  $lines += "Administrator $index`t$($values["TK_AUTO_TEST_ADMIN_${index}_USERNAME"])`t$($values["TK_AUTO_TEST_ADMIN_${index}_PASSWORD"])"
}

$plainBytes = [Text.Encoding]::UTF8.GetBytes(($lines -join [Environment]::NewLine))
$encrypted = [Security.Cryptography.ProtectedData]::Protect(
  $plainBytes,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
[IO.File]::WriteAllBytes($target, $encrypted)
Write-Output "Created DPAPI-protected account document: $target"
