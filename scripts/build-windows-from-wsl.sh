#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mode="${1:-release}"
target="x86_64-pc-windows-msvc"
case "$mode" in
  debug) tauri_mode=(--debug) ;;
  release) tauri_mode=() ;;
  *) echo "usage: $0 [debug|release]" >&2; exit 2 ;;
esac

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required" >&2
    exit 1
  fi
}

windows_profile_wsl() {
  local profile_win profile_wsl
  profile_win="$(powershell.exe -NoProfile -Command '[Environment]::GetFolderPath("UserProfile")' | tr -d '\r' | tail -n 1)"
  profile_wsl="$(wslpath -u "$profile_win" 2>/dev/null || true)"
  if [[ -z "$profile_wsl" || ! -d "$profile_wsl" ]]; then
    echo "Unable to resolve Windows user profile from WSL" >&2
    exit 1
  fi
  printf '%s\n' "$profile_wsl"
}

to_wsl_path() {
  local path="$1"
  if [[ "$path" =~ ^[A-Za-z]:\\ ]]; then
    wslpath -u "$path"
  else
    printf '%s\n' "$path"
  fi
}

need_command pnpm
need_command cargo
need_command powershell.exe
need_command wslpath
cargo xwin --version >/dev/null 2>&1 || {
  echo "cargo-xwin is required (cargo install cargo-xwin)" >&2
  exit 1
}

started="$(date +%s)"
version="$(node -p "require('./package.json').version")"
target_dir="src-tauri/target/$target/$mode"
bundle_dir="$target_dir/bundle"
exe="$target_dir/shellx.exe"
nsis="$bundle_dir/nsis/shellX_${version}_x64-setup.exe"
msi="$bundle_dir/msi/shellX_${version}_x64_en-US.msi"

output_dir="${SHELLX_WINDOWS_OUTPUT_DIR:-}"
if [[ -z "$output_dir" ]]; then
  output_dir="$(windows_profile_wsl)/shellx-builds/v${version}/windows"
else
  output_dir="$(to_wsl_path "$output_dir")"
fi

updater_key_path="${SHELLX_WINDOWS_UPDATER_KEY_PATH:-}"
if [[ -z "$updater_key_path" && -f "$HOME/.shellx-keys/updater.key" ]]; then
  updater_key_path="$HOME/.shellx-keys/updater.key"
fi
if [[ -n "$updater_key_path" ]]; then
  updater_key_path="$(to_wsl_path "$updater_key_path")"
fi

metadata_path="${SHELLX_WINDOWS_SIGNING_METADATA_PATH:-}"
if [[ -n "$metadata_path" ]]; then
  metadata_path="$(to_wsl_path "$metadata_path")"
fi

echo "[build-windows] installing JavaScript dependencies"
pnpm install --frozen-lockfile

echo "[build-windows] removing stale Windows bundle output"
rm -rf "$bundle_dir"

tauri_args=(tauri build "${tauri_mode[@]}" --runner cargo-xwin --target "$target" --ci)
tauri_args+=(--config '{"bundle":{"createUpdaterArtifacts":false}}')
if [[ -n "${SHELLX_TAURI_FEATURES:-}" ]]; then
  tauri_args+=(--features "$SHELLX_TAURI_FEATURES")
fi

echo "[build-windows] building shellX $version for $target ($mode)"
build_log="$(mktemp)"
if ! pnpm "${tauri_args[@]}" 2>&1 | tee "$build_log"; then
  echo "FAIL: Tauri Windows build failed; log: $build_log" >&2
  exit 1
fi

if [[ ! -f "$exe" ]]; then
  echo "FAIL: Windows app exe was not produced: $exe" >&2
  exit 1
fi
if [[ ! -f "$nsis" ]]; then
  echo "FAIL: NSIS installer was not produced: $nsis" >&2
  exit 1
fi
if [[ "${SHELLX_WINDOWS_REQUIRE_MSI:-0}" == "1" && ! -f "$msi" ]]; then
  echo "FAIL: MSI was required but was not produced: $msi" >&2
  exit 1
fi

if grep -q "Compiling " "$build_log"; then
  exe_mtime="$(stat -c %Y "$exe")"
  if [[ "$exe_mtime" -lt "$started" ]]; then
    echo "FAIL: $exe is stale after a compile; inspect $build_log" >&2
    exit 1
  fi
  echo "[verify] Windows exe rebuilt:"
else
  echo "[verify] Windows exe reused from cache:"
fi
ls -lh "$exe"
sha256sum "$exe"

installer_mtime="$(stat -c %Y "$nsis")"
if [[ "$installer_mtime" -lt "$started" ]]; then
  echo "FAIL: $nsis is stale; installer was not freshly bundled" >&2
  exit 1
fi
echo "[verify] fresh NSIS installer:"
ls -lh "$nsis"
sha256sum "$nsis"

mkdir -p "$output_dir"
dest_nsis="$output_dir/$(basename "$nsis")"
rm -f "$dest_nsis" "$dest_nsis.sig"
cp "$nsis" "$dest_nsis"

dest_msi=""
if [[ -f "$msi" ]]; then
  dest_msi="$output_dir/$(basename "$msi")"
  rm -f "$dest_msi"
  cp "$msi" "$dest_msi"
else
  echo "[build-windows] MSI not produced by this WSL build; NSIS is the release artifact."
fi

if [[ -n "$metadata_path" ]]; then
  if [[ ! -f "$metadata_path" ]]; then
    echo "FAIL: signing metadata file does not exist: $metadata_path" >&2
    exit 1
  fi
  sign_script="$repo_root/scripts/windows-artifact-sign.ps1"
  artifacts_win=("$(wslpath -w "$dest_nsis")")
  if [[ -n "$dest_msi" ]]; then
    artifacts_win+=("$(wslpath -w "$dest_msi")")
  fi
  echo "[build-windows] Authenticode signing copied final artifacts"
  powershell.exe -NoProfile -ExecutionPolicy Bypass \
    -File "$(wslpath -w "$sign_script")" \
    -MetadataPath "$(wslpath -w "$metadata_path")" \
    -Artifacts "${artifacts_win[@]}"
elif [[ "${SHELLX_WINDOWS_SIGNING_REQUIRED:-0}" == "1" ]]; then
  echo "FAIL: SHELLX_WINDOWS_SIGNING_REQUIRED=1 but SHELLX_WINDOWS_SIGNING_METADATA_PATH is not set" >&2
  exit 1
else
  echo "[build-windows] Authenticode signing skipped; set SHELLX_WINDOWS_SIGNING_METADATA_PATH to sign."
fi

if [[ -n "$updater_key_path" ]]; then
  if [[ ! -f "$updater_key_path" ]]; then
    echo "FAIL: updater key path does not exist: $updater_key_path" >&2
    exit 1
  fi
  echo "[build-windows] creating Tauri updater signature for final installer"
  pnpm exec tauri signer sign \
    --private-key-path "$updater_key_path" \
    --password="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
    "$dest_nsis" >/dev/null
elif [[ "${SHELLX_WINDOWS_UPDATER_REQUIRED:-0}" == "1" ]]; then
  echo "FAIL: SHELLX_WINDOWS_UPDATER_REQUIRED=1 but no updater key path was found" >&2
  exit 1
else
  echo "[build-windows] updater .sig skipped; set SHELLX_WINDOWS_UPDATER_KEY_PATH or ~/.shellx-keys/updater.key."
fi

echo "[build-windows] final Windows artifacts:"
find "$output_dir" -maxdepth 1 -type f -printf '%f %s bytes\n' | sort
sha256sum "$dest_nsis"
if [[ -f "$dest_nsis.sig" ]]; then
  sha256sum "$dest_nsis.sig"
fi
if [[ -n "$dest_msi" ]]; then
  sha256sum "$dest_msi"
fi
echo "[build-windows] OK: $output_dir"
