param(
  [Parameter(Mandatory = $true)][ValidateSet("preflight-absent", "installed", "absent")][string]$Phase,
  [Parameter(Mandatory = $true)][string]$CandidateExe,
  [Parameter(Mandatory = $true)][string]$CandidateSha256,
  [Parameter(Mandatory = $true)][int]$CandidateProcessId,
  [Parameter(Mandatory = $true)][string]$DebugTokenPath,
  [Parameter(Mandatory = $true)][ValidateSet("native", "wsl")][string]$Orchestrator
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Get-Sha256Text([string]$Value) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Resolve-LocalFixedFile([string]$Path, [string]$Label) {
  if ($Path -match "^\\\\" -or $Path -match "^//" -or $Path.Contains("/")) {
    throw "$Label must use a local absolute Windows path"
  }
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -notmatch "^[A-Za-z]:\\") { throw "$Label must use a local absolute Windows path" }
  $drive = $full.Substring(0, 2).ToUpperInvariant()
  $driveInfo = [IO.DriveInfo]::new("$drive\")
  if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [IO.DriveType]::Fixed) {
    throw "$Label must reside on exactly one local fixed volume"
  }
  $subst = & "$env:SystemRoot\System32\subst.exe" $drive 2>$null
  $substExitCode = $LASTEXITCODE
  if ($substExitCode -eq 0 -and ($subst -join "").Trim()) {
    throw "$Label must reside on exactly one local fixed volume"
  }
  if ($substExitCode -ne 1) { throw "$Label fixed-volume identity could not be verified" }
  $item = Get-Item -LiteralPath $full -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label must be a regular non-reparse file"
  }
  return $item.FullName
}

function Assert-NoReparseAncestry([string]$Path, [string]$Label) {
  $current = Get-Item -LiteralPath $Path -Force
  while ($null -ne $current) {
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label must not have a reparse point in its ancestry"
    }
    $current = $current.Parent
  }
}

function Normalize-Path([string]$Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd("\").ToLowerInvariant()
}

function Test-PathUnder([string]$Path, [string]$Root) {
  $candidate = Normalize-Path $Path
  $parent = (Normalize-Path $Root) + "\"
  return $candidate.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase)
}

function Get-DefaultRegistryValue([string]$Path) {
  $key = Get-Item -LiteralPath $Path -ErrorAction Stop
  return [string]$key.GetValue("")
}

function Get-NamedRegistryValue([string]$Path, [string]$Name) {
  $key = Get-Item -LiteralPath $Path -ErrorAction Stop
  return [string]$key.GetValue($Name)
}

function Test-RegistryKeyPresent([string]$Path) {
  try {
    [void](Get-Item -LiteralPath $Path -ErrorAction Stop)
    return $true
  } catch [System.Management.Automation.ItemNotFoundException] {
    return $false
  } catch {
    throw "desktop integration registry state could not be read exactly"
  }
}

function Test-FilePresent([string]$Path) {
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer) { throw "desktop integration shortcut path is not a file" }
    return $true
  } catch [System.Management.Automation.ItemNotFoundException] {
    return $false
  } catch {
    throw "desktop integration shortcut state could not be read exactly"
  }
}

function Assert-RegistryVerb([string]$VerbPath, [string]$CommandPath, [string]$ExpectedExe, [string]$ExpectedCommand) {
  if (-not (Test-RegistryKeyPresent $VerbPath) -or -not (Test-RegistryKeyPresent $CommandPath)) {
    throw "candidate Explorer verb is incomplete"
  }
  if ((Get-DefaultRegistryValue $VerbPath) -cne "Send to shellX") {
    throw "candidate Explorer verb label is not exact"
  }
  if ((Get-NamedRegistryValue $VerbPath "Icon") -cne $ExpectedExe) {
    throw "candidate Explorer verb icon is not exact"
  }
  if ((Get-DefaultRegistryValue $CommandPath) -cne $ExpectedCommand) {
    throw "candidate Explorer verb command is not exact"
  }
  $children = @(Get-ChildItem -LiteralPath $VerbPath -ErrorAction Stop)
  if ($children.Count -ne 1 -or $children[0].PSChildName -cne "command") {
    throw "candidate Explorer verb contains unexpected child keys"
  }
}

function Assert-SendToShortcut([string]$ShortcutPath, [string]$ExpectedExe) {
  if (-not (Test-FilePresent $ShortcutPath)) {
    throw "candidate SendTo shortcut is absent"
  }
  $shortcutItem = Get-Item -LiteralPath $ShortcutPath -Force
  if (($shortcutItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "candidate SendTo shortcut must not be a reparse point"
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $iconLocation = [string]$shortcut.IconLocation
  $iconMatches = (Normalize-Path ($iconLocation -replace ',\s*0$', '')) -ceq (Normalize-Path $ExpectedExe)
  $targetMatches = (Normalize-Path ([string]$shortcut.TargetPath)) -ceq (Normalize-Path $ExpectedExe)
  $argumentsMatch = ([string]$shortcut.Arguments) -ceq "--attach"
  $descriptionMatches = ([string]$shortcut.Description) -ceq "Send files to shellX"
  if (-not $targetMatches -or -not $argumentsMatch -or -not $iconMatches -or -not $descriptionMatches) {
    throw "candidate SendTo shortcut is not exact"
  }
}

$processTokenNativeMembers = @"
[System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError=true)]
public static extern bool OpenProcessToken(System.IntPtr processHandle, uint desiredAccess, out System.IntPtr tokenHandle);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern bool CloseHandle(System.IntPtr handle);
"@
Add-Type -Namespace ShellXRelease -Name ProcessTokenNative -MemberDefinition $processTokenNativeMembers

function Get-ProcessUserSid([Diagnostics.Process]$Process) {
  $token = [IntPtr]::Zero
  if (-not [ShellXRelease.ProcessTokenNative]::OpenProcessToken($Process.Handle, 8, [ref]$token)) {
    throw "candidate process token could not be opened"
  }
  try {
    $processIdentity = [Security.Principal.WindowsIdentity]::new($token)
    return $processIdentity.User.Value
  } finally {
    [void][ShellXRelease.ProcessTokenNative]::CloseHandle($token)
  }
}

if ($CandidateSha256 -notmatch "^[a-f0-9]{64}$") { throw "candidate SHA-256 is invalid" }
if ($CandidateProcessId -le 0) { throw "candidate process id is invalid" }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$administratorsSid = "S-1-5-32-544"
$groupSids = @($identity.Groups | ForEach-Object { $_.Value })
if ($groupSids -contains $administratorsSid) {
  throw "desktop integration proof requires the fresh non-admin disposable Windows user"
}

$candidate = Resolve-LocalFixedFile $CandidateExe "Candidate executable"
Assert-NoReparseAncestry ([IO.Path]::GetDirectoryName($candidate)) "Candidate executable"
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash.ToLowerInvariant() -cne $CandidateSha256) {
  throw "candidate executable hash changed"
}

$process = Get-Process -Id $CandidateProcessId -ErrorAction SilentlyContinue
if ($null -eq $process) { throw "candidate process is absent" }
if (-not $process.Path -or (Normalize-Path ([string]$process.Path)) -cne (Normalize-Path $candidate)) {
  throw "candidate process image is not the exact release executable"
}
if ((Get-ProcessUserSid $process) -ne $identity.User.Value) {
  throw "candidate process does not belong to the current disposable Windows user"
}

$profileRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if (-not (Test-PathUnder $DebugTokenPath $profileRoot)) {
  throw "candidate Debug API token is outside the disposable Windows user profile"
}
$evidenceRoot = [IO.Path]::Combine($localAppData, "ShellXReleaseEvidence")
$targetRoot = [IO.Path]::GetDirectoryName($candidate)
$targetUnderEvidence = Test-PathUnder $targetRoot $evidenceRoot
$targetNameMatches = [IO.Path]::GetFileName($targetRoot) -match "^shellx-final-install-[A-Za-z0-9._-]+$"
if (-not $targetUnderEvidence -or -not $targetNameMatches) {
  throw "candidate executable is outside the receipt-owned final Windows installation target"
}

$fileVerb = "Registry::HKEY_CURRENT_USER\Software\Classes\*\shell\shellX"
$fileCommand = "$fileVerb\command"
$directoryVerb = "Registry::HKEY_CURRENT_USER\Software\Classes\Directory\shell\shellX"
$directoryCommand = "$directoryVerb\command"
$sendToShortcut = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::SendTo), "shellX.lnk")
$expectedCommand = '"' + $candidate + '" --attach "%1"'
$filePresent = Test-RegistryKeyPresent $fileVerb
$directoryPresent = Test-RegistryKeyPresent $directoryVerb
$shortcutPresent = Test-FilePresent $sendToShortcut

if ($Phase -eq "preflight-absent" -or $Phase -eq "absent") {
  if ($filePresent -or $directoryPresent -or $shortcutPresent) {
    throw "ShellX Explorer verbs or SendTo shortcut already exist; refusing to inspect, overwrite, or remove them"
  }
} else {
  Assert-RegistryVerb $fileVerb $fileCommand $candidate $expectedCommand
  Assert-RegistryVerb $directoryVerb $directoryCommand $candidate $expectedCommand
  Assert-SendToShortcut $sendToShortcut $candidate
}

[pscustomobject][ordered]@{
  schema = "shellx/release-surface-windows-desktop-integration-observation@1"
  phase = $Phase
  orchestrator = $Orchestrator
  observedAt = [DateTime]::UtcNow.ToString("o")
  userNameSha256 = Get-Sha256Text $identity.Name.ToLowerInvariant()
  userSidSha256 = Get-Sha256Text $identity.User.Value
  candidatePathSha256 = Get-Sha256Text (Normalize-Path $candidate)
  candidateSha256 = $CandidateSha256
  candidateProcessId = $CandidateProcessId
  nonAdmin = $true
  candidateOwnedTarget = $true
  candidateOwnerMatches = $true
  debugTokenInsideUserProfile = $true
  fileVerbInstalled = [bool]($Phase -eq "installed")
  directoryVerbInstalled = [bool]($Phase -eq "installed")
  sendToShortcutInstalled = [bool]($Phase -eq "installed")
  exactCandidateValues = [bool]($Phase -eq "installed")
  mutated = $false
} | ConvertTo-Json -Depth 4 -Compress
