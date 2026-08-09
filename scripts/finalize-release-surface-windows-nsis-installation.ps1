param(
  [Parameter(Mandatory = $true)][string]$TargetRoot,
  [Parameter(Mandatory = $true)][string]$ExpectedUser,
  [Parameter(Mandatory = $true)][string]$ExpectedUserSid,
  [Parameter(Mandatory = $true)][string]$ExpectedUninstallerSha256,
  [Parameter(Mandatory = $true)][ValidateSet("native", "wsl")][string]$Orchestrator
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Assert-LocalFixedVolume([string]$Path, [string]$Label) {
  if ($Path -match "^\\\\" -or $Path -match "^//" -or $Path.Contains("/")) {
    throw "$Label must not use UNC, device, extended, or mixed-separator syntax"
  }
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -notmatch "^[A-Za-z]:\\") { throw "$Label must be a local absolute Windows path" }
  $driveLetter = $full.Substring(0, 2).ToUpperInvariant()
  $drive = [IO.DriveInfo]::new("$driveLetter\")
  if (-not $drive.IsReady -or $drive.DriveType -ne [IO.DriveType]::Fixed) {
    throw "$Label must reside on exactly one local fixed volume, not a mapped or SUBST drive"
  }
  $subst = & "$env:SystemRoot\System32\subst.exe" $driveLetter 2>$null
  $substExitCode = $LASTEXITCODE
  if ($substExitCode -eq 0 -and ($subst -join "").Trim()) {
    throw "$Label must reside on exactly one local fixed volume, not a mapped or SUBST drive"
  }
  if ($substExitCode -ne 1) {
    throw "$Label fixed-volume identity could not be verified"
  }
  return $full
}

function Assert-NoReparseAncestry([string]$ExistingPath, [string]$Label) {
  $current = Get-Item -LiteralPath $ExistingPath -Force
  while ($null -ne $current) {
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label must not have a reparse point in its ancestry: $($current.FullName)"
    }
    $current = $current.Parent
  }
}

function Get-ShellXProcesses {
  return @(Get-Process -Name "shellx", "app" -ErrorAction SilentlyContinue)
}

if ($ExpectedUninstallerSha256 -notmatch "^[a-fA-F0-9]{64}$") {
  throw "ExpectedUninstallerSha256 must be an exact SHA-256 digest"
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$administratorsSid = "S-1-5-32-544"
$currentGroupSids = @($identity.Groups | ForEach-Object { $_.Value })
$isAdministratorsMember = $currentGroupSids -contains $administratorsSid
$expectedIdentityMismatch = ($identity.Name -ine $ExpectedUser) -or ($identity.User.Value -ne $ExpectedUserSid)
if ((-not $ExpectedUser.Trim()) -or $expectedIdentityMismatch -or $isAdministratorsMember) {
  throw "NSIS release finalization must run as the exact expected non-admin disposable Windows user"
}
$target = (Assert-LocalFixedVolume $TargetRoot "TargetRoot").TrimEnd("\")
$targetItem = Get-Item -LiteralPath $target -Force
if (-not $targetItem.PSIsContainer) { throw "Receipt-bound TargetRoot is not a directory" }
Assert-NoReparseAncestry $target "Receipt-bound TargetRoot"
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$evidenceParent = [IO.Path]::Combine($localAppData, "ShellXReleaseEvidence")
if ($targetItem.Parent.FullName -ine $evidenceParent -or $targetItem.Name -notmatch "^shellx-final-install-[A-Za-z0-9._-]+$") {
  throw "Receipt-bound TargetRoot is outside the disposable ShellX release-evidence parent"
}
if ((Get-Acl -LiteralPath $target).Owner -ine $identity.Name) {
  throw "Receipt-bound TargetRoot must be owned by the disposable Windows user"
}
if (@(Get-ShellXProcesses).Count -ne 0) {
  throw "No shellx.exe or legacy app.exe process may exist before the uninstaller hook runs"
}

$productRegistry = "HKCU:\Software\shellx\shellX"
$uninstallRegistry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\shellX"
$fileContextRegistry = "HKCU:\Software\Classes\*\shell\shellX"
$directoryContextRegistry = "HKCU:\Software\Classes\Directory\shell\shellX"
$startShortcut = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::Programs), "shellX.lnk")
$desktopShortcut = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory), "shellX.lnk")
$sendToShortcut = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::SendTo), "shellX.lnk")
$registeredProductPath = [string](Get-Item -LiteralPath $productRegistry).GetValue("")
$uninstallKey = Get-Item -LiteralPath $uninstallRegistry
$registeredInstallLocation = ([string]$uninstallKey.GetValue("InstallLocation")).Trim('"')
$registeredUninstaller = ([string]$uninstallKey.GetValue("UninstallString")).Trim('"')
$uninstallerPath = [IO.Path]::Combine($target, "uninstall.exe")
if ($registeredProductPath -ine $target -or $registeredInstallLocation -ine $target -or $registeredUninstaller -ine $uninstallerPath) {
  throw "Windows registry state no longer binds the exact receipt-owned installation"
}
$uninstaller = Get-Item -LiteralPath $uninstallerPath -Force
if ($uninstaller.PSIsContainer -or ($uninstaller.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Receipt-bound uninstaller must be a regular non-reparse file"
}
$uninstallerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $uninstallerPath).Hash.ToLowerInvariant()
if ($uninstallerHash -ne $ExpectedUninstallerSha256.ToLowerInvariant()) {
  throw "Receipt-bound uninstaller hash does not match the installed manifest"
}

$startedAt = [DateTime]::UtcNow.ToString("o")
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $uninstallerPath
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.Arguments = "/S _?=$target"
$process = [Diagnostics.Process]::Start($startInfo)
if ($null -eq $process) { throw "NSIS uninstaller process could not be started" }
if (-not $process.WaitForExit(5 * 60 * 1000)) {
  $taskKill = [IO.Path]::Combine($env:SystemRoot, "System32", "taskkill.exe")
  & $taskKill /PID $process.Id /T /F | Out-Null
  $taskKillExitCode = $LASTEXITCODE
  $terminated = $process.WaitForExit(10 * 1000)
  if ($taskKillExitCode -ne 0 -or -not $terminated -or -not $process.HasExited) {
    throw "NSIS uninstaller PID $($process.Id) survived timeout termination; revert the entire test VM before any retry"
  }
  throw "NSIS uninstaller exceeded its 5-minute native timeout; dispose this entire test profile or VM before retrying"
}
$completedAt = [DateTime]::UtcNow.ToString("o")
if ($process.ExitCode -ne 0) { throw "NSIS uninstaller exited with code $($process.ExitCode)" }
if (Test-Path -LiteralPath ([IO.Path]::Combine($target, "shellx.exe"))) { throw "NSIS uninstaller left the main executable behind" }
if (Test-Path -LiteralPath $uninstallRegistry) { throw "NSIS uninstaller left its uninstall registration behind" }
foreach ($path in @($startShortcut, $desktopShortcut, $sendToShortcut, $fileContextRegistry, $directoryContextRegistry)) {
  if (Test-Path -LiteralPath $path) { throw "NSIS uninstaller left a shortcut or Explorer handoff behind: $path" }
}
if (@(Get-ShellXProcesses).Count -ne 0) { throw "NSIS uninstaller left a ShellX process running" }

$residuals = @(Get-ChildItem -LiteralPath $target -Force)
if ($residuals.Count -gt 1 -or ($residuals.Count -eq 1 -and $residuals[0].FullName -ine $uninstallerPath)) {
  throw "NSIS uninstaller left an unexpected residual; preserving TargetRoot for investigation"
}
if ($residuals.Count -eq 1) {
  $residual = Get-Item -LiteralPath $uninstallerPath -Force
  $residualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $uninstallerPath).Hash.ToLowerInvariant()
  $residualIsReparse = ($residual.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  if ($residual.PSIsContainer -or $residualIsReparse -or ($residualHash -ne $ExpectedUninstallerSha256.ToLowerInvariant())) {
    throw "NSIS residual uninstaller identity changed; preserving TargetRoot for investigation"
  }
  Remove-Item -LiteralPath $uninstallerPath
}
if (@(Get-ChildItem -LiteralPath $target -Force).Count -ne 0) {
  throw "Receipt-bound TargetRoot is not empty after exact residual cleanup"
}
[IO.Directory]::Delete($target, $false)

if (Test-Path -LiteralPath $productRegistry) {
  $productKey = Get-Item -LiteralPath $productRegistry
  if ([string]$productKey.GetValue("") -ine $target -or @($productKey.GetSubKeyNames()).Count -ne 0) {
    throw "ShellX product registration has unexpected data; preserving it for investigation"
  }
  $unexpectedValueNames = @($productKey.GetValueNames() | Where-Object { $_ -ne "" -and $_ -ne "Installer Language" })
  if ($unexpectedValueNames.Count -ne 0) {
    throw "ShellX product registration has unexpected values; preserving it for investigation"
  }
  Remove-Item -LiteralPath $productRegistry
  $manufacturerRegistry = "HKCU:\Software\shellx"
  if (Test-Path -LiteralPath $manufacturerRegistry) {
    $manufacturer = Get-Item -LiteralPath $manufacturerRegistry
    if (@($manufacturer.GetSubKeyNames()).Count -eq 0 -and @($manufacturer.GetValueNames()).Count -eq 0) {
      Remove-Item -LiteralPath $manufacturerRegistry
    }
  }
}
if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $productRegistry)) {
  throw "Receipt-bound Windows installation was not fully finalized"
}

[pscustomobject][ordered]@{
  schema = "shellx/release-surface-windows-nsis-finalization@1"
  orchestrator = $Orchestrator
  userName = $identity.Name
  userSid = $identity.User.Value
  targetRoot = $target
  uninstallerSha256 = $ExpectedUninstallerSha256.ToLowerInvariant()
  startedAt = $startedAt
  completedAt = $completedAt
  exitCode = [int]$process.ExitCode
  targetRemoved = $true
  productRegistrationRemoved = $true
  uninstallRegistrationRemoved = $true
  shortcutsAndHandoffAbsent = $true
  recursiveDeleteUsed = $false
} | ConvertTo-Json -Depth 4 -Compress
