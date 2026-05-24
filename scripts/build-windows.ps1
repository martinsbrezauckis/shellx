param(
  [string]$Configuration = "release",
  [string]$Features = "debug-api",
  [string]$SigningKeyPath = $env:TAURI_SIGNING_PRIVATE_KEY_PATH,
  [string]$SigningPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
)

$ErrorActionPreference = "Stop"

function Find-Vcvars64 {
  $candidates = @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  $found = Get-ChildItem "${env:ProgramFiles(x86)}\Microsoft Visual Studio" `
    -Filter vcvars64.bat -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
  if ($found) {
    return $found
  }

  throw "vcvars64.bat not found. Install Visual Studio Build Tools with the MSVC x64 toolchain."
}

function Ensure-LocalPnpmShim {
  # Tauri reads beforeBuildCommand from tauri.conf.json (`pnpm build`).
  # Some Windows installs expose only `corepack pnpm`, not a bare pnpm.cmd.
  # Put a repo-local shim first in PATH so the checked-in config still works.
  $shim = Join-Path (Get-Location) "pnpm.cmd"
  if (!(Test-Path $shim)) {
    Set-Content -Path $shim -Value "@echo off`r`ncorepack pnpm %*`r`n" -Encoding ASCII
  }
  $env:PATH = "$(Get-Location);$env:PATH"
}

function Invoke-Cmd {
  param([string]$Command)
  cmd /c $Command
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed ($LASTEXITCODE): $Command"
  }
}

function Quote-CmdArg {
  param([AllowEmptyString()][string]$Value)
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Get-SigningKeyText {
  param([string]$Path)

  if (!$Path) {
    return $null
  }

  if (!(Test-Path $Path)) {
    throw "Signing key path not found: $Path"
  }

  return Get-Content -Raw -Path $Path
}

$repo = (Get-Location).Path
$vcvars = Find-Vcvars64
Ensure-LocalPnpmShim
$nsisDir = Join-Path $repo "src-tauri\target\$Configuration\bundle\nsis"

$deferUpdaterSigning = $false
$encryptedSigningKey = $false
$signingKeyText = $null
if ($env:TAURI_SIGNING_PRIVATE_KEY) {
  $signingKeyText = $env:TAURI_SIGNING_PRIVATE_KEY
} elseif ($SigningKeyPath) {
  $signingKeyText = Get-SigningKeyText $SigningKeyPath
}

if ($signingKeyText) {
  $encryptedSigningKey = $signingKeyText -match "encrypted secret key"
  if ([string]::IsNullOrEmpty($SigningPassword)) {
    # Tauri's build-time signer can prompt when a key has an empty
    # password, even though `tauri signer sign -p ""` handles it.
    # Avoid the prompt and sign the finished installer manually below.
    $encryptedSigningKey = $true
    $deferUpdaterSigning = $true
  } elseif (!$env:TAURI_SIGNING_PRIVATE_KEY) {
    $env:TAURI_SIGNING_PRIVATE_KEY = $signingKeyText
  }
}

Write-Host "repo=$repo"
Write-Host "vcvars=$vcvars"

Invoke-Cmd "`"$vcvars`" && corepack pnpm install --frozen-lockfile"
if (Test-Path $nsisDir) {
  Get-ChildItem $nsisDir -Filter "shellX_*_x64-setup.exe*" -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
}
$buildStartedAt = (Get-Date).AddSeconds(-5)
$tauriBuildCommand = "`"$vcvars`" && corepack pnpm tauri build --features $Features"
if ($deferUpdaterSigning) {
  $deferredSigningConfig = Join-Path ([System.IO.Path]::GetTempPath()) "shellx-tauri-defer-updater-signing.json"
  '{"bundle":{"createUpdaterArtifacts":false}}' |
    Set-Content -Path $deferredSigningConfig -Encoding ASCII
  $tauriBuildCommand += " --config `"$deferredSigningConfig`" --ci"
}
$savedSigningEnv = @{
  TAURI_SIGNING_PRIVATE_KEY = $env:TAURI_SIGNING_PRIVATE_KEY
  TAURI_SIGNING_PRIVATE_KEY_PATH = $env:TAURI_SIGNING_PRIVATE_KEY_PATH
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
}
if ($deferUpdaterSigning) {
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}
try {
  Invoke-Cmd $tauriBuildCommand
} catch {
  if (!$deferUpdaterSigning) {
    throw
  }
  Write-Warning "Tauri build exited after bundle generation while updater signing is deferred; continuing to manual signer."
} finally {
  foreach ($entry in $savedSigningEnv.GetEnumerator()) {
    if ($null -eq $entry.Value) {
      Remove-Item "Env:\$($entry.Key)" -ErrorAction SilentlyContinue
    } else {
      Set-Item "Env:\$($entry.Key)" $entry.Value
    }
  }
}

$installer = Get-ChildItem $nsisDir -Filter "shellX_*_x64-setup.exe" |
  Where-Object { $_.LastWriteTime -ge $buildStartedAt } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (!$installer) {
  throw "Fresh NSIS installer not found under $nsisDir"
}

$sigPath = "$($installer.FullName).sig"
if ((Test-Path $sigPath) -and ((Get-Item $sigPath).LastWriteTime -lt $installer.LastWriteTime)) {
  Remove-Item $sigPath -Force
}

if (!(Test-Path $sigPath)) {
  if (!$SigningKeyPath -and !$env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-Warning "Installer built, but no updater signing key was supplied; skipping .sig fallback."
  } else {
    $signingKeyForSigner = $SigningKeyPath
    $tempSigningKeyForSigner = $null
    if (!$signingKeyForSigner -and $signingKeyText) {
      $tempSigningKeyForSigner = Join-Path ([System.IO.Path]::GetTempPath()) "shellx-updater-signing.key"
      Set-Content -Path $tempSigningKeyForSigner -Value $signingKeyText -NoNewline -Encoding ASCII
      $signingKeyForSigner = $tempSigningKeyForSigner
    } elseif ($signingKeyForSigner -and $signingKeyForSigner.StartsWith("\\")) {
      # The Windows Tauri signer cannot reliably read WSL UNC key paths.
      # Copy the already-read key text to a short local temp path for signing.
      $tempSigningKeyForSigner = Join-Path ([System.IO.Path]::GetTempPath()) "shellx-updater-signing.key"
      Set-Content -Path $tempSigningKeyForSigner -Value $signingKeyText -NoNewline -Encoding ASCII
      $signingKeyForSigner = $tempSigningKeyForSigner
    }

    try {
      $signCommand = "corepack pnpm tauri signer sign"
      if ($signingKeyForSigner) {
        $signCommand += " -f $(Quote-CmdArg $signingKeyForSigner)"
      }
      if ($encryptedSigningKey) {
        if ([string]::IsNullOrEmpty($SigningPassword)) {
          $signCommand += ' -p ""'
        } else {
          $signCommand += " -p $(Quote-CmdArg $SigningPassword)"
        }
      } elseif ($SigningPassword -ne $null) {
        $signCommand += " -p $(Quote-CmdArg $SigningPassword)"
      }
      $signCommand += " $(Quote-CmdArg $($installer.FullName))"

      Invoke-Cmd $signCommand
    } finally {
      if ($tempSigningKeyForSigner) {
        Remove-Item $tempSigningKeyForSigner -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

$outDir = Join-Path $env:USERPROFILE "shellx-builds\v$((Get-Content package.json | ConvertFrom-Json).version)"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Remove-Item (Join-Path $outDir "shellX_*") -Force -ErrorAction SilentlyContinue
Copy-Item $installer.FullName $outDir -Force
if (Test-Path $sigPath) {
  Copy-Item $sigPath $outDir -Force
}

Get-ChildItem $outDir -Filter "shellX_*" |
  Get-FileHash -Algorithm SHA256 |
  ForEach-Object { "$($_.Hash.ToLowerInvariant())  $($_.Path)" } |
  Set-Content (Join-Path $outDir "SHA256SUMS.txt") -Encoding ASCII

Write-Host "Built artifacts:"
Get-ChildItem $outDir | Format-Table Name,Length,LastWriteTime
