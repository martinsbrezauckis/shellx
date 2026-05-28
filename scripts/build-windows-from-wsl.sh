#!/usr/bin/env bash
set -euo pipefail

# Stages the repo onto the Windows filesystem and runs the Windows-native
# Tauri build there. This avoids MSVC/UNC/cmd.exe edge cases when the source
# tree lives under WSL.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
win_profile="$(
  powershell.exe -NoProfile -Command '[Environment]::GetFolderPath("UserProfile")' |
    tr -d '\r'
)"
stage_win="${win_profile}\\shellx-build\\grok-shell"
stage_wsl="$(wslpath -u "$stage_win")"

mkdir -p "$stage_wsl"
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'src-tauri/target/' \
  --exclude '.grok/' \
  --exclude '.claude/' \
  --exclude '.project/' \
  --exclude 'screenshots/' \
  "$repo_root/" "$stage_wsl/"

signing_key="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.shellx-keys/updater.key}"
if [[ -s "$signing_key" ]]; then
  signing_key_win="$(wslpath -w "$signing_key")"
else
  signing_key_win=""
fi

if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
  export WSLENV="${WSLENV:+$WSLENV:}TAURI_SIGNING_PRIVATE_KEY_PASSWORD/p"
fi

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "\
  Set-Location '$stage_win'; \
  \$env:TAURI_SIGNING_PRIVATE_KEY_PATH = '$signing_key_win'; \
  ./scripts/build-windows.ps1"
