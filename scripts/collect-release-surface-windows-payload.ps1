param(
  [Parameter(Mandatory = $true)][string]$RootPath,
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
  if ($substExitCode -ne 1) { throw "$Label fixed-volume identity could not be verified" }
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

$fullRoot = (Assert-LocalFixedVolume $RootPath "RootPath").TrimEnd("\")
if ($fullRoot -notmatch "^[A-Za-z]:\\" -or $fullRoot -match "^\\\\") {
  throw "RootPath must be a local absolute Windows path"
}
$root = Get-Item -LiteralPath $fullRoot -Force
if (-not $root.PSIsContainer) { throw "Installed payload root must be a directory" }
Assert-NoReparseAncestry $fullRoot "Installed payload root"

$entries = [Collections.Generic.List[object]]::new()
$pending = [Collections.Generic.Stack[object]]::new()
$pending.Push([pscustomobject]@{ Directory = [IO.DirectoryInfo]$root; Depth = 0 })
$utf8 = [Text.UTF8Encoding]::new($false)

while ($pending.Count -gt 0) {
  $work = $pending.Pop()
  if ([int]$work.Depth -gt 64) { throw "Installed payload exceeds the 64-directory-depth limit" }
  foreach ($entry in $work.Directory.EnumerateFileSystemInfos()) {
    if ($entries.Count -ge 50000) { throw "Installed payload exceeds the 50000-entry limit" }
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Installed payload contains a link or reparse entry: $($entry.FullName)"
    }
    if (-not $entry.FullName.StartsWith("$fullRoot\", [StringComparison]::OrdinalIgnoreCase)) {
      throw "Installed payload entry escaped its root: $($entry.FullName)"
    }
    $relative = $entry.FullName.Substring($fullRoot.Length + 1).Replace("\", "/")
    if ($utf8.GetByteCount($relative) -gt 4096) {
      throw "Installed payload path exceeds 4096 UTF-8 bytes: $relative"
    }
    if ($entry -is [IO.DirectoryInfo]) {
      $entries.Add([pscustomobject][ordered]@{
        path = $relative
        kind = "directory"
      })
      $pending.Push([pscustomobject]@{ Directory = $entry; Depth = ([int]$work.Depth + 1) })
      continue
    }
    if ($entry -isnot [IO.FileInfo]) {
      throw "Installed payload contains an unsupported filesystem entry: $relative"
    }

    $lengthBefore = [long]$entry.Length
    $writeBefore = $entry.LastWriteTimeUtc.Ticks
    $stream = [IO.File]::Open($entry.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      $sha = [Security.Cryptography.SHA256]::Create()
      try {
        $hashBytes = $sha.ComputeHash($stream)
      } finally {
        $sha.Dispose()
      }
    } finally {
      $stream.Dispose()
    }
    $entry.Refresh()
    if (-not $entry.Exists -or [long]$entry.Length -ne $lengthBefore -or $entry.LastWriteTimeUtc.Ticks -ne $writeBefore) {
      throw "Installed payload file changed while hashing: $relative"
    }
    $hash = ([BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()
    $entries.Add([pscustomobject][ordered]@{
      path = $relative
      kind = "file"
      sha256 = $hash
      bytes = $lengthBefore
    })
  }
}

[pscustomobject][ordered]@{
  schema = "shellx/release-surface-windows-payload-observation@1"
  collector = "windows-powershell-payload-v1"
  orchestrator = $Orchestrator
  rootPath = $fullRoot
  collectedAt = [DateTime]::UtcNow.ToString("o")
  entries = @($entries)
} | ConvertTo-Json -Depth 5 -Compress
