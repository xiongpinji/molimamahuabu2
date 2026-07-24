param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseDirectory,
  [string]$PackageJsonPath = (Join-Path $PSScriptRoot '..\package.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$releaseDir = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$packagePath = (Resolve-Path -LiteralPath $PackageJsonPath).Path
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$version = [string]$package.version
$productName = [string]$package.build.productName

$expectedNames = @(
  "$productName $version Setup.exe",
  "$productName $version Portable.exe"
)
$artifacts = @(
  Get-ChildItem -LiteralPath $releaseDir -Filter '*.exe' |
    Sort-Object Name
)

if ($artifacts.Count -ne $expectedNames.Count) {
  $found = ($artifacts.Name -join ', ')
  throw "Expected signed release files '$($expectedNames -join "', '")'; found '$found'"
}
foreach ($artifact in $artifacts) {
  if ($artifact.Name -notin $expectedNames) {
    throw "Unexpected executable in release directory: $($artifact.Name)"
  }
}

$artifactReports = foreach ($artifact in $artifacts) {
  $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
  if ($signature.Status -ne 'Valid') {
    throw "Invalid Authenticode signature on $($artifact.Name): $($signature.Status)"
  }
  if (-not $signature.SignerCertificate) {
    throw "Missing signer certificate on $($artifact.Name)"
  }
  if (-not $signature.TimeStamperCertificate) {
    throw "Missing trusted timestamp on $($artifact.Name)"
  }

  $hash = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $versionInfo = $artifact.VersionInfo
  if ($versionInfo.FileVersion -ne $version) {
    throw "Unexpected FileVersion on $($artifact.Name): $($versionInfo.FileVersion)"
  }
  [ordered]@{
    name = $artifact.Name
    bytes = $artifact.Length
    sha256 = $hash
    fileVersion = $versionInfo.FileVersion
    signerSubject = $signature.SignerCertificate.Subject
    signerThumbprint = $signature.SignerCertificate.Thumbprint
    timestampSubject = $signature.TimeStamperCertificate.Subject
  }
}

$checksumPath = Join-Path $releaseDir 'SHA256SUMS.txt'
$artifactReports |
  ForEach-Object { "$($_.sha256) *$($_.name)" } |
  Set-Content -LiteralPath $checksumPath -Encoding utf8NoBOM

foreach ($artifact in $artifactReports) {
  $actual = (Get-FileHash -LiteralPath (Join-Path $releaseDir $artifact.name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $artifact.sha256) {
    throw "SHA-256 verification failed for $($artifact.name)"
  }
}

$report = [ordered]@{
  ok = $true
  productName = $productName
  version = $version
  tag = [string]$env:GITHUB_REF_NAME
  verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
  artifacts = @($artifactReports)
}
$reportPath = Join-Path $releaseDir 'release-verification.json'
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding utf8NoBOM
$report | ConvertTo-Json -Depth 5
