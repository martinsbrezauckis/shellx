param(
  [Parameter(Mandatory = $true)][string]$ArtifactPath,
  [Parameter(Mandatory = $true)][string]$TargetRoot,
  [Parameter(Mandatory = $true)][string]$ExpectedUser,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
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

function Get-MachineShellXRegistrations {
  $registrations = [Collections.Generic.List[string]]::new()
  foreach ($base in @(
    "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )) {
    if (-not (Test-Path -LiteralPath $base)) { continue }
    foreach ($key in Get-ChildItem -LiteralPath $base -ErrorAction Stop) {
      $values = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
      $displayNameProperty = $values.PSObject.Properties["DisplayName"]
      $publisherProperty = $values.PSObject.Properties["Publisher"]
      $displayName = if ($null -ne $displayNameProperty) { [string]$displayNameProperty.Value } else { "" }
      $publisher = if ($null -ne $publisherProperty) { [string]$publisherProperty.Value } else { "" }
      if ($displayName -ieq "shellX" -or $publisher -ieq "shellx") {
        $registrations.Add($key.PSPath)
      }
    }
  }
  $machineProduct = "Registry::HKEY_LOCAL_MACHINE\Software\shellx\shellX"
  if (Test-Path -LiteralPath $machineProduct) { $registrations.Add($machineProduct) }
  return @($registrations | Sort-Object -Unique)
}

function Get-WebView2Identity {
  $records = [Collections.Generic.List[object]]::new()
  foreach ($record in @(
    @{ Scope = "machine-wow6432"; Path = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" },
    @{ Scope = "machine-native"; Path = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" },
    @{ Scope = "user"; Path = "Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" }
  )) {
    if (-not (Test-Path -LiteralPath $record.Path)) { continue }
    $version = [string](Get-ItemPropertyValue -LiteralPath $record.Path -Name "pv" -ErrorAction Stop)
    if ($version.Trim()) {
      $records.Add([pscustomobject][ordered]@{ scope = $record.Scope; version = $version })
    }
  }
  return @($records | Sort-Object scope)
}

if ($ExpectedVersion -notmatch "^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$") {
  throw "ExpectedVersion must be a canonical semantic version"
}

$artifactFullPath = Assert-LocalFixedVolume $ArtifactPath "Installer artifact"
Assert-NoReparseAncestry ([IO.Path]::GetDirectoryName($artifactFullPath)) "Installer artifact parent"
$artifact = Get-Item -LiteralPath $artifactFullPath -Force
if ($artifact.PSIsContainer -or ($artifact.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Installer artifact must be a regular non-reparse file"
}
if ($artifact.Extension -ne ".exe" -or $artifact.Length -le 0) { throw "Installer artifact must be a non-empty EXE" }
$signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or -not $signature.SignerCertificate) {
  throw "Installer artifact must have a valid Authenticode signature"
}
if (-not $signature.TimeStamperCertificate) {
  throw "Installer artifact must have a valid Authenticode timestamp certificate"
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $ExpectedUser.Trim() -or $identity.Name -ine $ExpectedUser) {
  throw "NSIS release installation must run as the exact expected disposable Windows user"
}
$administratorsSid = "S-1-5-32-544"
$currentGroupSids = @($identity.Groups | ForEach-Object { $_.Value })
$isAdministratorsMember = $currentGroupSids -contains $administratorsSid
if ($isAdministratorsMember) {
  throw "NSIS release installation must run as a fresh non-admin disposable Windows user"
}

$target = (Assert-LocalFixedVolume $TargetRoot "TargetRoot").TrimEnd("\")
if ($target -notmatch "^[A-Za-z]:\\" -or $target -match "^\\\\") {
  throw "TargetRoot must be a local absolute Windows path"
}
if (Test-Path -LiteralPath $target) { throw "TargetRoot must be absent before installation" }
$targetParent = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($target)) -Force
if (-not $targetParent.PSIsContainer) {
  throw "TargetRoot parent must be a regular non-reparse directory"
}
Assert-NoReparseAncestry $targetParent.FullName "TargetRoot parent"

$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$evidenceParent = [IO.Path]::Combine($localAppData, "ShellXReleaseEvidence")
if ($targetParent.FullName -ine $evidenceParent -or [IO.Path]::GetFileName($target) -notmatch "^shellx-final-install-[A-Za-z0-9._-]+$") {
  throw "TargetRoot must be a direct run-owned child of LocalAppData\ShellXReleaseEvidence"
}
$owner = (Get-Acl -LiteralPath $targetParent.FullName).Owner
if ($owner -ine $identity.Name) { throw "TargetRoot parent must be owned by the disposable Windows user" }
$defaultInstall = [IO.Path]::Combine($localAppData, "shellX")
$productRegistry = "HKCU:\Software\shellx\shellX"
$uninstallRegistry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\shellX"
$fileContextRegistry = "HKCU:\Software\Classes\*\shell\shellX"
$directoryContextRegistry = "HKCU:\Software\Classes\Directory\shell\shellX"
$startShortcut = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::Programs), "shellX.lnk")
$desktopShortcut = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory), "shellX.lnk")
$sendToShortcut = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::SendTo), "shellX.lnk")

foreach ($path in @(
  $defaultInstall,
  $productRegistry,
  $uninstallRegistry,
  $fileContextRegistry,
  $directoryContextRegistry,
  $startShortcut,
  $desktopShortcut,
  $sendToShortcut
)) {
  if (Test-Path -LiteralPath $path) { throw "Disposable Windows user baseline is not empty: $path" }
}
$conflictingProcesses = @(Get-ShellXProcesses)
if ($conflictingProcesses.Count -ne 0) {
  throw "No shellx.exe or legacy app.exe process may exist before the installer hook runs"
}
$machineRegistrationsBefore = @(Get-MachineShellXRegistrations)
if ($machineRegistrationsBefore.Count -ne 0) {
  throw "Disposable Windows baseline contains a machine-wide ShellX or legacy installer registration"
}
$webViewBefore = @(Get-WebView2Identity)
if ($webViewBefore.Count -eq 0) {
  throw "WebView2 must already be installed so the NSIS adapter cannot download or install it"
}
$webViewBeforeJson = ConvertTo-Json @($webViewBefore) -Depth 4 -Compress

$artifactHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact.FullName).Hash.ToLowerInvariant()
$artifactLengthBefore = [long]$artifact.Length
$artifactWriteBefore = $artifact.LastWriteTimeUtc.Ticks
$startedAt = [DateTime]::UtcNow.ToString("o")
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $artifact.FullName
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.Arguments = "/S /NS /D=$target"
$process = [Diagnostics.Process]::Start($startInfo)
if ($null -eq $process) { throw "NSIS installer process could not be started" }
if (-not $process.WaitForExit(15 * 60 * 1000)) {
  $taskKill = [IO.Path]::Combine($env:SystemRoot, "System32", "taskkill.exe")
  & $taskKill /PID $process.Id /T /F | Out-Null
  $taskKillExitCode = $LASTEXITCODE
  $terminated = $process.WaitForExit(10 * 1000)
  if ($taskKillExitCode -ne 0 -or -not $terminated -or -not $process.HasExited) {
    throw "NSIS installer PID $($process.Id) survived timeout termination; revert the entire test VM before any retry"
  }
  throw "NSIS installer exceeded its 15-minute native timeout; dispose this entire test profile or VM before retrying"
}
$completedAt = [DateTime]::UtcNow.ToString("o")
$artifact.Refresh()
$artifactHashAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact.FullName).Hash.ToLowerInvariant()
if ($artifactHashAfter -ne $artifactHashBefore -or [long]$artifact.Length -ne $artifactLengthBefore -or $artifact.LastWriteTimeUtc.Ticks -ne $artifactWriteBefore) {
  throw "Installer artifact changed during execution"
}
if ($process.ExitCode -ne 0) { throw "NSIS installer exited with code $($process.ExitCode)" }
if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw "NSIS installer did not create TargetRoot" }

$productKey = Get-Item -LiteralPath $productRegistry
$registeredProductPath = [string]$productKey.GetValue("")
$uninstallKey = Get-Item -LiteralPath $uninstallRegistry
$displayName = [string]$uninstallKey.GetValue("DisplayName")
$displayVersion = [string]$uninstallKey.GetValue("DisplayVersion")
$publisher = [string]$uninstallKey.GetValue("Publisher")
$mainBinaryName = [string]$uninstallKey.GetValue("MainBinaryName")
$installLocation = ([string]$uninstallKey.GetValue("InstallLocation")).Trim('"')
$uninstallString = ([string]$uninstallKey.GetValue("UninstallString")).Trim('"')
$displayIcon = ([string]$uninstallKey.GetValue("DisplayIcon")).Trim('"')
$noModify = [int]$uninstallKey.GetValue("NoModify")
$noRepair = [int]$uninstallKey.GetValue("NoRepair")
$mainExecutablePath = [IO.Path]::Combine($target, "shellx.exe")
$expectedUninstallerPath = [IO.Path]::Combine($target, "uninstall.exe")
if ($registeredProductPath -ine $target -or $installLocation -ine $target) {
  throw "NSIS registry installation path does not match TargetRoot"
}
if ($displayName -ne "shellX") { throw "NSIS uninstall registration DisplayName is invalid" }
if ($displayVersion -ne $ExpectedVersion -or $publisher -ne "shellx" -or $mainBinaryName -ne "shellx.exe") {
  throw "NSIS uninstall registration version, publisher, or main binary is invalid"
}
if ($uninstallString -ine $expectedUninstallerPath -or $displayIcon -ine $mainExecutablePath -or $noModify -ne 1 -or $noRepair -ne 1) {
  throw "NSIS uninstall registration paths or immutable flags are invalid"
}
foreach ($installedFile in @($mainExecutablePath, $expectedUninstallerPath)) {
  $item = Get-Item -LiteralPath $installedFile -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "NSIS payload contains a missing or non-regular required file: $installedFile"
  }
}
foreach ($path in @($startShortcut, $desktopShortcut, $sendToShortcut, $fileContextRegistry, $directoryContextRegistry)) {
  if (Test-Path -LiteralPath $path) { throw "Silent /NS install created a suppressed shortcut or Explorer handoff: $path" }
}
$conflictingProcessesAfter = @(Get-ShellXProcesses)
if ($conflictingProcessesAfter.Count -ne 0) { throw "Silent NSIS installation unexpectedly launched ShellX" }
$machineRegistrationsAfter = @(Get-MachineShellXRegistrations)
if ($machineRegistrationsAfter.Count -ne 0) { throw "NSIS installation created an unexpected machine-wide ShellX registration" }
$webViewAfter = @(Get-WebView2Identity)
$webViewAfterJson = ConvertTo-Json @($webViewAfter) -Depth 4 -Compress
if ($webViewAfterJson -ne $webViewBeforeJson) { throw "NSIS installation changed the WebView2 installation identity" }

[pscustomobject][ordered]@{
  schema = "shellx/release-surface-windows-nsis-installation@1"
  collector = "windows-powershell-nsis-v1"
  orchestrator = $Orchestrator
  userName = $identity.Name
  userSid = $identity.User.Value
  userIsAdministrator = $false
  userIsAdministratorsMember = $false
  artifact = [pscustomobject][ordered]@{
    path = $artifact.FullName
    basename = $artifact.Name
    sha256 = $artifactHashBefore
    bytes = [long]$artifact.Length
    signatureStatus = $signature.Status.ToString()
    signerThumbprint = $signature.SignerCertificate.Thumbprint.ToLowerInvariant()
    signerSubject = $signature.SignerCertificate.Subject
    signerIssuer = $signature.SignerCertificate.Issuer
    timestampSubject = $signature.TimeStamperCertificate.Subject
    timestampIssuer = $signature.TimeStamperCertificate.Issuer
    timestampThumbprint = $signature.TimeStamperCertificate.Thumbprint.ToLowerInvariant()
  }
  operation = [pscustomobject][ordered]@{
    startedAt = $startedAt
    completedAt = $completedAt
    exitCode = [int]$process.ExitCode
    targetRootStateBefore = "absent"
    arguments = @("/S", "/NS", "/D=<redacted-run-owned-target>")
  }
  targetRoot = $target
  mainExecutablePath = $mainExecutablePath
  expectedVersion = $ExpectedVersion
  webView2Identity = @($webViewAfter)
  safety = [pscustomobject][ordered]@{
    machineRegistrationsBefore = @($machineRegistrationsBefore)
    machineRegistrationsAfter = @($machineRegistrationsAfter)
    shellxProcessCountBefore = $conflictingProcesses.Count
    shellxProcessCountAfter = $conflictingProcessesAfter.Count
    webView2IdentityUnchanged = $true
  }
  systemEffects = @(
    [pscustomobject][ordered]@{
      id = "windows-product-registration"
      status = "pass"
      observed = "HKCU product registration points to the exact run-owned target"
      details = [pscustomobject][ordered]@{
        registryPath = "HKCU\Software\shellx\shellX"
        installLocation = $registeredProductPath
      }
    },
    [pscustomobject][ordered]@{
      id = "windows-uninstall-registration"
      status = "pass"
      observed = "HKCU uninstall registration names shellX, the exact version, target, and uninstaller"
      details = [pscustomobject][ordered]@{
        registryPath = "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\shellX"
        displayName = $displayName
        displayVersion = $displayVersion
        publisher = $publisher
        mainBinaryName = $mainBinaryName
        installLocation = $installLocation
        uninstallExecutable = $uninstallString
        displayIcon = $displayIcon
        noModify = $noModify
        noRepair = $noRepair
      }
    },
    [pscustomobject][ordered]@{
      id = "windows-shortcuts-suppressed"
      status = "pass"
      observed = "The /NS installer created no Start Menu or Desktop shortcut"
      details = [pscustomobject][ordered]@{
        startMenuAbsent = $true
        desktopAbsent = $true
      }
    },
    [pscustomobject][ordered]@{
      id = "windows-explorer-handoff-suppressed"
      status = "pass"
      observed = "Silent installation created no Explorer context menu or SendTo shortcut"
      details = [pscustomobject][ordered]@{
        fileContextMenuAbsent = $true
        directoryContextMenuAbsent = $true
        sendToAbsent = $true
      }
    }
  )
} | ConvertTo-Json -Depth 7 -Compress
