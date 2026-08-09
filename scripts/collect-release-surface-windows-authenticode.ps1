param(
  [Parameter(Mandatory = $true)][string]$ArtifactPath,
  [Parameter(Mandatory = $true)][string]$ExpectedPublisherCommonName,
  [Parameter(Mandatory = $true)][string]$ExpectedPublisherOrganization,
  [Parameter(Mandatory = $true)][string]$ExpectedPublisherCountry,
  [Parameter(Mandatory = $true)][string]$ExpectedIssuerOrganization,
  [Parameter(Mandatory = $true)][string]$ExpectedTimestampIssuerOrganization
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Get-DistinguishedNameValue([string]$DistinguishedName, [string]$Name) {
  $match = [regex]::Match($DistinguishedName, "(?:^|,\s*)$([regex]::Escape($Name))=([^,]+)", [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $match.Success) { return "" }
  return $match.Groups[1].Value.Trim()
}

function Get-CertificateObservation([Security.Cryptography.X509Certificates.X509Certificate2]$Certificate) {
  return [pscustomobject][ordered]@{
    subject = $Certificate.Subject
    issuer = $Certificate.Issuer
    thumbprint = $Certificate.Thumbprint.ToLowerInvariant()
    serialNumber = $Certificate.SerialNumber.ToLowerInvariant()
    notBefore = $Certificate.NotBefore.ToUniversalTime().ToString("o")
    notAfter = $Certificate.NotAfter.ToUniversalTime().ToString("o")
  }
}

function Assert-LocalFixedVolume([string]$Path, [string]$Label) {
  if ($Path -match "^\\\\" -or $Path -match "^//" -or $Path.Contains("/")) {
    throw "$Label must not use UNC, device, extended, or mixed-separator syntax"
  }
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -notmatch "^[A-Za-z]:\\") { throw "$Label must be a local absolute Windows path" }
  $driveLetter = $full.Substring(0, 2).ToUpperInvariant()
  $drive = [IO.DriveInfo]::new("$driveLetter\")
  if (-not $drive.IsReady -or $drive.DriveType -ne [IO.DriveType]::Fixed) {
    throw "$Label must reside on exactly one local fixed volume"
  }
  $subst = & "$env:SystemRoot\System32\subst.exe" $driveLetter 2>$null
  $substExitCode = $LASTEXITCODE
  if ($substExitCode -eq 0 -and ($subst -join "").Trim()) {
    throw "$Label must reside on exactly one local fixed volume"
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

$fullArtifactPath = Assert-LocalFixedVolume $ArtifactPath "ArtifactPath"
if ($ArtifactPath -match "^\\\\" -or $ArtifactPath.Contains("/") -or $fullArtifactPath -notmatch "^[A-Za-z]:\\") {
  throw "ArtifactPath must be a canonical local Windows path"
}
Assert-NoReparseAncestry ([IO.Path]::GetDirectoryName($fullArtifactPath)) "Authenticode artifact parent"
$artifact = Get-Item -LiteralPath $fullArtifactPath -Force
if ($artifact.PSIsContainer -or ($artifact.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $artifact.Length -le 0) {
  throw "Authenticode artifact must be a non-empty regular non-reparse file"
}
$signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or -not $signature.SignerCertificate) {
  throw "Authenticode artifact must have a valid Windows signature"
}
if (-not $signature.TimeStamperCertificate) { throw "Authenticode artifact must have a timestamp certificate" }
$signer = $signature.SignerCertificate
$timestamp = $signature.TimeStamperCertificate
$publisherCommonName = Get-DistinguishedNameValue $signer.Subject "CN"
$publisherOrganization = Get-DistinguishedNameValue $signer.Subject "O"
$publisherCountry = Get-DistinguishedNameValue $signer.Subject "C"
$issuerOrganization = Get-DistinguishedNameValue $signer.Issuer "O"
$timestampIssuerOrganization = Get-DistinguishedNameValue $timestamp.Issuer "O"
$publisherMismatch = ($publisherCommonName -cne $ExpectedPublisherCommonName) -or ($publisherOrganization -cne $ExpectedPublisherOrganization) -or ($publisherCountry -cne $ExpectedPublisherCountry)
if ($publisherMismatch) {
  throw "Authenticode publisher identity does not match the frozen ShellX signing profile"
}
$issuerMismatch = ($issuerOrganization -cne $ExpectedIssuerOrganization) -or ($timestampIssuerOrganization -cne $ExpectedTimestampIssuerOrganization)
if ($issuerMismatch) {
  throw "Authenticode signer or timestamp issuer does not match the frozen ShellX signing profile"
}
$artifactHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact.FullName).Hash.ToLowerInvariant()
$artifact.Refresh()
if (-not $artifact.Exists -or $artifact.Length -le 0) { throw "Authenticode artifact disappeared during verification" }

[pscustomobject][ordered]@{
  schema = "shellx/release-surface-windows-authenticode-observation@1"
  collector = "windows-powershell-authenticode-v1"
  status = $signature.Status.ToString()
  verifiedAt = [DateTime]::UtcNow.ToString("o")
  artifactPath = $artifact.FullName
  artifactSha256 = $artifactHash
  artifactBytes = [long]$artifact.Length
  publisher = [pscustomobject][ordered]@{
    commonName = $publisherCommonName
    organization = $publisherOrganization
    country = $publisherCountry
  }
  signerCertificate = Get-CertificateObservation $signer
  timestampCertificate = Get-CertificateObservation $timestamp
} | ConvertTo-Json -Depth 5 -Compress
