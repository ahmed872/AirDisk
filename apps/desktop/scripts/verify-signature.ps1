# Verifies the Authenticode signatures of a built release (docs/product/deployment-and-release.md §7).
# Usage: pwsh apps/desktop/scripts/verify-signature.ps1 -Dist apps/desktop/dist [-ExpectedSubject 'CN=Your Company']
param([string]$Dist = 'apps/desktop/dist', [string]$ExpectedSubject = $env:AIRDESK_SIGNER_SUBJECT)
$ErrorActionPreference = 'Stop'
$files = @(Get-ChildItem "$Dist/AirDesk-Setup-*-x64.exe") + @(Get-ChildItem "$Dist/win-unpacked/AirDesk.exe")
if ($files.Count -lt 2) { throw "Installer or AirDesk.exe not found in $Dist" }
if ($files | Where-Object { $_.Name -match 'UNSIGNED' }) { throw 'An UNSIGNED development installer is present in the release folder' }
foreach ($f in $files) {
  $sig = Get-AuthenticodeSignature $f.FullName
  Write-Host "$($f.Name): $($sig.Status) — $($sig.SignerCertificate.Subject) — timestamp: $([bool]$sig.TimeStamperCertificate)"
  if ($sig.Status -ne 'Valid') { throw "$($f.Name) is not validly signed ($($sig.Status)): $($sig.StatusMessage)" }
  if (-not $sig.TimeStamperCertificate) { throw "$($f.Name) has no RFC 3161 timestamp" }
  if ($ExpectedSubject -and -not $sig.SignerCertificate.Subject.Contains($ExpectedSubject)) { throw "$($f.Name) is signed by '$($sig.SignerCertificate.Subject)', expected '$ExpectedSubject'" }
}
Write-Host 'All release binaries are validly signed and timestamped.'
