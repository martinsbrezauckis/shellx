param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][ValidateSet("native", "wsl")][string]$Orchestrator
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($ProcessId -le 0) { throw "ProcessId must be positive" }
if ($Port -le 0 -or $Port -gt 65535) { throw "Port must be between 1 and 65535" }

$volumeNativeMembers = @"
[System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
public static extern bool GetVolumeInformation(string rootPathName, System.Text.StringBuilder volumeNameBuffer, int volumeNameSize, out uint volumeSerialNumber, out uint maximumComponentLength, out uint fileSystemFlags, System.Text.StringBuilder fileSystemNameBuffer, int fileSystemNameSize);
"@
Add-Type -Namespace ShellXRelease -Name VolumeNative -MemberDefinition $volumeNativeMembers

function Get-VolumeSerial([string]$RootPath) {
  $serial = [uint32]0
  $maximumComponentLength = [uint32]0
  $fileSystemFlags = [uint32]0
  $volumeName = [Text.StringBuilder]::new(261)
  $fileSystemName = [Text.StringBuilder]::new(261)
  $ok = [ShellXRelease.VolumeNative]::GetVolumeInformation(
    $RootPath,
    $volumeName,
    $volumeName.Capacity,
    [ref]$serial,
    [ref]$maximumComponentLength,
    [ref]$fileSystemFlags,
    $fileSystemName,
    $fileSystemName.Capacity
  )
  if (-not $ok) { throw "Unable to resolve the executable volume identity" }
  return $serial.ToString("x8")
}

function Get-Sha256([string]$LiteralPath) {
  $stream = $null
  $sha256 = $null
  try {
    $stream = [IO.File]::Open(
      $LiteralPath,
      [IO.FileMode]::Open,
      [IO.FileAccess]::Read,
      [IO.FileShare]::Read
    )
    $sha256 = [Security.Cryptography.SHA256]::Create()
    $digest = $sha256.ComputeHash($stream)
    return [BitConverter]::ToString($digest).Replace("-", "").ToLowerInvariant()
  }
  finally {
    if ($stream) { $stream.Dispose() }
    if ($sha256) { $sha256.Dispose() }
  }
}

function Get-Ipv4LoopbackListeners([int]$ListenerPort) {
  $output = & "$env:SystemRoot\System32\netstat.exe" -ano -p tcp
  if ($LASTEXITCODE -ne 0) { throw "Unable to inspect the candidate loopback listener" }
  $listeners = [Collections.Generic.List[object]]::new()
  foreach ($line in $output) {
    $parts = @($line.Trim() -split "\s+")
    if ($parts.Count -ne 5 -or $parts[0] -cne "TCP") { continue }
    if ($parts[1] -cne "127.0.0.1:$ListenerPort" -or $parts[2] -cne "0.0.0.0:0") { continue }
    $owner = 0
    if (-not [int]::TryParse($parts[4], [ref]$owner) -or $owner -le 0) {
      throw "Candidate loopback listener owner is invalid"
    }
    $listeners.Add([pscustomobject]@{
      LocalAddress = "127.0.0.1"
      LocalPort = $ListenerPort
      OwningProcess = $owner
    })
  }
  return @($listeners)
}

$process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if (-not $process -or -not $process.Path) { throw "Candidate process is not running" }
$image = Get-Item -LiteralPath $process.Path
$hash = Get-Sha256 $image.FullName
$fileIdOutput = (& fsutil file queryFileID $image.FullName 2>&1 | Out-String)
$fileIdMatch = [regex]::Match($fileIdOutput, "0x[0-9a-fA-F]+")
if (-not $fileIdMatch.Success) { throw "Unable to resolve the candidate executable file ID" }
$volumeSerial = Get-VolumeSerial ([IO.Path]::GetPathRoot($image.FullName))

$listeners = @(Get-Ipv4LoopbackListeners $Port)
$listenerCount = @($listeners).Count
if ($listenerCount -ne 1) { throw "Expected exactly one IPv4 loopback listener for port $Port" }
$owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
if ($owners.Count -ne 1) { throw "Expected exactly one loopback listener owner for port $Port" }
$listener = $listeners | Where-Object { $_.OwningProcess -eq $owners[0] } | Select-Object -First 1

# Re-read each identity after filesystem and socket inspection so a PID reuse,
# process restart, executable replacement, or listener handoff cannot produce a
# coherent-looking observation assembled from different runtime epochs.
$finalProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if (-not $finalProcess -or -not $finalProcess.Path) { throw "Candidate process exited during collection" }
$finalImage = Get-Item -LiteralPath $finalProcess.Path
$finalHash = Get-Sha256 $finalImage.FullName
$finalFileIdOutput = (& fsutil file queryFileID $finalImage.FullName 2>&1 | Out-String)
$finalFileIdMatch = [regex]::Match($finalFileIdOutput, "0x[0-9a-fA-F]+")
if (-not $finalFileIdMatch.Success) { throw "Unable to re-resolve the candidate executable file ID" }
$finalListeners = @(Get-Ipv4LoopbackListeners $Port)
if (
  $finalProcess.StartTime.ToUniversalTime().ToString("o") -ne $process.StartTime.ToUniversalTime().ToString("o") -or
  $finalImage.FullName -ne $image.FullName -or
  $finalImage.Length -ne $image.Length -or
  $finalHash -ne $hash -or
  $finalFileIdMatch.Value.ToLowerInvariant() -ne $fileIdMatch.Value.ToLowerInvariant()
) { throw "Candidate process or executable identity changed during collection" }
if (@($finalListeners).Count -ne 1 -or [int]$finalListeners[0].OwningProcess -ne $ProcessId) {
  throw "Candidate loopback listener changed during collection"
}

[pscustomobject]@{
  schema = "shellx/release-surface-windows-native-runtime@1"
  collector = "windows-powershell-v1"
  orchestrator = $Orchestrator
  observedAt = [DateTime]::UtcNow.ToString("o")
  osVersion = [Environment]::OSVersion.VersionString
  architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  process = [pscustomobject]@{
    pid = [int]$process.Id
    startId = $process.StartTime.ToUniversalTime().ToString("o")
    imagePath = $image.FullName
    imageSha256 = $hash
    imageBytes = [long]$image.Length
    imageFileId = "$volumeSerial`:$($fileIdMatch.Value.ToLowerInvariant())"
  }
  listener = [pscustomobject]@{
    address = $listener.LocalAddress
    port = [int]$listener.LocalPort
    owningPid = [int]$owners[0]
  }
} | ConvertTo-Json -Depth 5 -Compress
