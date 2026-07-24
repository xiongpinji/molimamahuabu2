param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [string]$BaselineInstallerPath,
  [string]$ProductName = '茉莉妈妈短剧制作平台'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$resolvedBaselineInstaller = if ($BaselineInstallerPath) {
  (Resolve-Path -LiteralPath $BaselineInstallerPath).Path
} else {
  $null
}
$firstInstaller = if ($resolvedBaselineInstaller) {
  $resolvedBaselineInstaller
} else {
  $resolvedInstaller
}
$runId = [guid]::NewGuid().ToString('N')
$validationRoot = Join-Path $env:TEMP "molimama-installer-validation-$runId"
$installDir = Join-Path $validationRoot 'app'
$userDataDir = Join-Path $env:APPDATA 'localminidrama-desktop'
$userDataValidationDir = Join-Path $userDataDir '.release-validation'
$userDataSentinel = Join-Path $userDataValidationDir "user-data-sentinel-$runId.txt"
$appExe = Join-Path $installDir "$ProductName.exe"

function Invoke-Installer([string]$Path) {
  $process = Start-Process `
    -FilePath $Path `
    -ArgumentList @('/S', "/D=$installDir") `
    -Wait `
    -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer exited with code $($process.ExitCode)"
  }
}

function Wait-UntilMissing([string]$Path, [int]$TimeoutSeconds = 60) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Test-Path -LiteralPath $Path) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }
  if (Test-Path -LiteralPath $Path) {
    throw "Path still exists after uninstall: $Path"
  }
}

function Find-Uninstaller {
  if (-not (Test-Path -LiteralPath $installDir)) {
    return $null
  }
  $uninstaller = Get-ChildItem -LiteralPath $installDir -Filter 'Uninstall*.exe' |
    Select-Object -First 1
  if ($uninstaller) {
    return $uninstaller.FullName
  }
  return $null
}

function Invoke-Uninstaller([string]$UninstallerPath) {
  $uninstallProcess = Start-Process `
    -FilePath $UninstallerPath `
    -ArgumentList '/S' `
    -Wait `
    -PassThru
  if ($uninstallProcess.ExitCode -ne 0) {
    throw "Uninstaller exited with code $($uninstallProcess.ExitCode)"
  }
}

$existingInstall = Get-ItemProperty `
  HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* `
  -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -in @($ProductName, '本地短剧助手') } |
  Select-Object -First 1
if ($existingInstall) {
  throw "Refusing to replace an existing user installation: $($existingInstall.DisplayName)"
}

try {
  New-Item -ItemType Directory -Path $validationRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $userDataValidationDir -Force | Out-Null
  Set-Content -LiteralPath $userDataSentinel -Value $runId -Encoding utf8NoBOM

  Invoke-Installer -Path $firstInstaller
  $baselineExecutable = Get-ChildItem -LiteralPath $installDir -Filter '*.exe' |
    Where-Object { $_.Name -notlike 'Uninstall*.exe' } |
    Select-Object -First 1
  if (-not $baselineExecutable) {
    throw "Baseline executable is missing under $installDir"
  }
  $baselineProductName = $baselineExecutable.VersionInfo.ProductName

  Invoke-Installer -Path $resolvedInstaller
  if (-not (Test-Path -LiteralPath $appExe)) {
    throw "Cover install removed the installed executable: $appExe"
  }
  $versionInfo = (Get-Item -LiteralPath $appExe).VersionInfo
  if ($versionInfo.ProductName -ne $ProductName) {
    throw "Unexpected ProductName '$($versionInfo.ProductName)'"
  }
  if ($versionInfo.FileDescription -ne $ProductName) {
    throw "Unexpected FileDescription '$($versionInfo.FileDescription)'"
  }
  if (-not (Test-Path -LiteralPath $userDataSentinel)) {
    throw "Cover install removed user data: $userDataSentinel"
  }

  $uninstallerPath = Find-Uninstaller
  if (-not $uninstallerPath) {
    throw "Uninstaller is missing under $installDir"
  }
  Invoke-Uninstaller -UninstallerPath $uninstallerPath

  Wait-UntilMissing -Path $appExe
  Wait-UntilMissing -Path $uninstallerPath
  if (-not (Test-Path -LiteralPath $userDataSentinel)) {
    throw "Uninstall removed user data: $userDataSentinel"
  }

  [ordered]@{
    ok = $true
    installer = $resolvedInstaller
    baselineInstaller = $firstInstaller
    baselineProductName = $baselineProductName
    productName = $versionInfo.ProductName
    fileVersion = $versionInfo.FileVersion
    coverInstallPreservedUserData = $true
    uninstallRemovedApplication = $true
    uninstallPreservedUserData = $true
  } | ConvertTo-Json
}
finally {
  if (Test-Path -LiteralPath $installDir) {
    try {
      $cleanupUninstaller = Find-Uninstaller
      if ($cleanupUninstaller) {
        Invoke-Uninstaller -UninstallerPath $cleanupUninstaller
        Wait-UntilMissing -Path $appExe
      }
    }
    catch {
      Write-Warning "Installer validation cleanup failed: $($_.Exception.Message)"
    }
  }
  if (Test-Path -LiteralPath $userDataSentinel) {
    Remove-Item -LiteralPath $userDataSentinel -Force
  }
  if (
    (Test-Path -LiteralPath $userDataValidationDir) -and
    -not (Get-ChildItem -LiteralPath $userDataValidationDir -Force | Select-Object -First 1)
  ) {
    Remove-Item -LiteralPath $userDataValidationDir -Force
  }
  if (Test-Path -LiteralPath $validationRoot) {
    $resolvedValidationRoot = (Resolve-Path -LiteralPath $validationRoot).Path
    $resolvedTemp = (Resolve-Path -LiteralPath $env:TEMP).Path
    if (-not $resolvedValidationRoot.StartsWith(
      "$resolvedTemp\molimama-installer-validation-",
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      throw "Refusing to clean unexpected path: $resolvedValidationRoot"
    }
    Remove-Item -LiteralPath $resolvedValidationRoot -Recurse -Force
  }
}
