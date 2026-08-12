param(
  [Parameter(Mandatory = $true)][int]$CandidateProcessId,
  [Parameter(Mandatory = $true)][string]$CandidateStartId,
  [Parameter(Mandatory = $true)][string]$CandidateImagePath,
  [Parameter(Mandatory = $true)][ValidateSet("ShellX Browser")][string]$ExpectedTitle
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($CandidateProcessId -le 0) { throw "CandidateProcessId must be positive" }
$parsedStartId = [DateTime]::MinValue
if (-not [DateTime]::TryParse($CandidateStartId, [ref]$parsedStartId)) {
  throw "CandidateStartId must be an ISO timestamp"
}
if ($CandidateImagePath -notmatch '^(?:[A-Za-z]:\\|\\\\)') {
  throw "CandidateImagePath must be absolute"
}

$windowNativeSource = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace ShellXRelease {
  public static class WindowNative {
    public delegate bool EnumWindowsProc(IntPtr window, IntPtr extraData);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  }
}
"@
Add-Type -TypeDefinition $windowNativeSource

function Get-ExactCandidateProcess {
  $process = Get-Process -Id $CandidateProcessId -ErrorAction SilentlyContinue
  if (-not $process -or -not $process.Path) { throw "Candidate process is not running" }
  $startId = $process.StartTime.ToUniversalTime().ToString("o")
  if ($startId -cne $CandidateStartId) { throw "Candidate process start identity changed" }
  if (-not [String]::Equals($process.Path, $CandidateImagePath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Candidate executable path changed"
  }
  return $process
}

$null = Get-ExactCandidateProcess
$matches = [Collections.Generic.List[System.IntPtr]]::new()
$callback = [ShellXRelease.WindowNative+EnumWindowsProc]{
  param([IntPtr]$window, [IntPtr]$extraData)
  $owner = [uint32]0
  $null = [ShellXRelease.WindowNative]::GetWindowThreadProcessId($window, [ref]$owner)
  if ([int]$owner -ne $CandidateProcessId) { return $true }
  $title = [Text.StringBuilder]::new(513)
  $null = [ShellXRelease.WindowNative]::GetWindowText($window, $title, $title.Capacity)
  if ($title.ToString() -ceq $ExpectedTitle) { $matches.Add($window) }
  return $true
}
$null = [ShellXRelease.WindowNative]::EnumWindows($callback, [IntPtr]::Zero)
if ($matches.Count -ne 1) {
  throw "Expected exactly one candidate-owned native window titled '$ExpectedTitle'; found $($matches.Count)"
}

$target = $matches[0]
$wmClose = [uint32]0x0010
if (-not [ShellXRelease.WindowNative]::PostMessage($target, $wmClose, [IntPtr]::Zero, [IntPtr]::Zero)) {
  throw "Unable to post WM_CLOSE to the candidate-owned native window"
}

$deadline = [DateTime]::UtcNow.AddSeconds(10)
while ([DateTime]::UtcNow -lt $deadline -and [ShellXRelease.WindowNative]::IsWindow($target)) {
  Start-Sleep -Milliseconds 100
}
if ([ShellXRelease.WindowNative]::IsWindow($target)) {
  throw "Candidate-owned native window did not close before timeout"
}
$null = Get-ExactCandidateProcess

[pscustomobject]@{
  schema = "shellx/release-surface-windows-window-close@1"
  processId = $CandidateProcessId
  processStartId = $CandidateStartId
  title = $ExpectedTitle
  closed = $true
} | ConvertTo-Json -Compress
