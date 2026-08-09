param(
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
  [string[]] $Artifacts,
  [string] $MetadataPath = $env:SHELLX_WINDOWS_SIGNING_METADATA_PATH,
  [string] $SignToolPath = $env:SHELLX_WINDOWS_SIGNTOOL_PATH,
  [string] $DlibPath = $env:SHELLX_WINDOWS_SIGNING_DLIB_PATH,
  [switch] $VerifyOnly
)

$ErrorActionPreference = "Stop"

function First-ExistingPath([string[]] $Paths) {
  foreach ($Path in $Paths) {
    if ($Path -and (Test-Path -LiteralPath $Path)) {
      return $Path
    }
  }
  return $null
}

if (-not $MetadataPath) {
  throw "SHELLX_WINDOWS_SIGNING_METADATA_PATH or -MetadataPath is required for Authenticode signing."
}
if (-not (Test-Path -LiteralPath $MetadataPath)) {
  throw "Signing metadata file does not exist: $MetadataPath"
}

if (-not $SignToolPath) {
  $SignToolPath = First-ExistingPath @(
    "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe",
    "${env:ProgramFiles(x86)}\Windows Kits\10\App Certification Kit\signtool.exe"
  )
}
if (-not $SignToolPath -or -not (Test-Path -LiteralPath $SignToolPath)) {
  throw "signtool.exe was not found. Set SHELLX_WINDOWS_SIGNTOOL_PATH."
}

if (-not $DlibPath) {
  $DlibPath = First-ExistingPath @(
    "$env:USERPROFILE\.shellx\tools\artifact-signing\Microsoft.ArtifactSigning.Client\bin\x64\Azure.CodeSigning.Dlib.dll",
    "$env:USERPROFILE\.nuget\packages\microsoft.artifactsigning.client\1.0.128\bin\x64\Azure.CodeSigning.Dlib.dll"
  )
}
if (-not $DlibPath -or -not (Test-Path -LiteralPath $DlibPath)) {
  throw "Azure Code Signing Dlib was not found. Set SHELLX_WINDOWS_SIGNING_DLIB_PATH."
}

foreach ($Artifact in $Artifacts) {
  if (-not (Test-Path -LiteralPath $Artifact)) {
    throw "Artifact does not exist: $Artifact"
  }
  if ($Artifact -match "\\nsis\\.*\\Plugins\\") {
    Write-Host "Skipping NSIS plugin helper: $Artifact"
    continue
  }

  if (-not $VerifyOnly) {
    Write-Host "Authenticode signing $Artifact"
    & $SignToolPath sign /v /fd SHA256 /tr "http://timestamp.acs.microsoft.com" /td SHA256 /dlib $DlibPath /dmdf $MetadataPath $Artifact
    if ($LASTEXITCODE -ne 0) {
      throw "signtool sign failed for $Artifact"
    }
  }

  Write-Host "Authenticode verifying $Artifact"
  & $SignToolPath verify /pa /v $Artifact
  if ($LASTEXITCODE -ne 0) {
    throw "signtool verify failed for $Artifact"
  }
}
