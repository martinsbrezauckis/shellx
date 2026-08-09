#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mode="${1:-release}"
target="x86_64-pc-windows-msvc"
signing_required="${SHELLX_WINDOWS_SIGNING_REQUIRED:-1}"
updater_required="${SHELLX_WINDOWS_UPDATER_REQUIRED:-1}"
if [[ ! "$signing_required" =~ ^[01]$ || ! "$updater_required" =~ ^[01]$ ]]; then
  echo "SHELLX_WINDOWS_SIGNING_REQUIRED and SHELLX_WINDOWS_UPDATER_REQUIRED must be 0 or 1" >&2
  exit 2
fi
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
if [[ -n "$updater_key_path" ]]; then
  updater_key_path="$(to_wsl_path "$updater_key_path")"
fi

metadata_path="${SHELLX_WINDOWS_SIGNING_METADATA_PATH:-}"
if [[ -n "$metadata_path" ]]; then
  metadata_path="$(to_wsl_path "$metadata_path")"
  if [[ ! -f "$metadata_path" ]]; then
    echo "FAIL: signing metadata file does not exist: $metadata_path" >&2
    exit 1
  fi
  export SHELLX_WINDOWS_SIGNING_METADATA_PATH="$metadata_path"
elif [[ "$signing_required" == "1" ]]; then
  echo "FAIL: SHELLX_WINDOWS_SIGNING_REQUIRED=1 but SHELLX_WINDOWS_SIGNING_METADATA_PATH is not set" >&2
  exit 1
fi

echo "[build-windows] installing JavaScript dependencies"
pnpm install --frozen-lockfile

echo "[build-windows] removing stale Windows bundle output"
rm -rf "$bundle_dir"

tauri_config='{"bundle":{"createUpdaterArtifacts":false}}'
if [[ -n "$metadata_path" ]]; then
  sign_command="$repo_root/scripts/windows-artifact-sign-command.sh"
  if [[ ! -x "$sign_command" ]]; then
    echo "FAIL: Windows signing command is not executable: $sign_command" >&2
    exit 1
  fi
  export SHELLX_SIGN_COMMAND_PATH="$sign_command"
  tauri_config="$(node -e 'process.stdout.write(JSON.stringify({bundle:{createUpdaterArtifacts:false,windows:{signCommand:{cmd:process.env.SHELLX_SIGN_COMMAND_PATH,args:["%1"]}}}}))')"
fi

tauri_args=(tauri build "${tauri_mode[@]}" --runner cargo-xwin --target "$target" --bundles nsis --ci)
tauri_args+=(--config "$tauri_config")
if [[ -n "${SHELLX_TAURI_FEATURES:-}" ]]; then
  tauri_args+=(--features "$SHELLX_TAURI_FEATURES")
fi

echo "[build-windows] building shellX $version for $target ($mode)"
build_log="$(mktemp)"
cleanup_build_log() {
  if [[ -n "${build_log:-}" && -f "$build_log" ]]; then
    rm -f -- "$build_log"
  fi
}
trap cleanup_build_log EXIT
if ! pnpm "${tauri_args[@]}" 2>&1 | tee "$build_log"; then
  echo "FAIL: Tauri Windows build failed; full output is shown above" >&2
  exit 1
fi

if [[ ! -f "$exe" ]]; then
  echo "FAIL: Windows app exe was not produced: $exe" >&2
  exit 1
fi
if grep -Fq "Failed to add bundler type" "$build_log"; then
  echo "FAIL: Tauri could not bind the requested bundle type to the desktop executable" >&2
  exit 1
fi
if ! grep -Eq 'Built application at: .*/shellx\.exe$' "$build_log"; then
  echo "FAIL: Tauri did not report shellx.exe as the built desktop application" >&2
  exit 1
fi
exe_win="$(wslpath -w "$exe")"
exe_win_ps="${exe_win//\'/\'\'}"
echo "[verify] Windows desktop executable MCP EOF smoke"
if ! powershell.exe -NoProfile -Command "\$null | & '$exe_win_ps' --mcp-server; exit \$LASTEXITCODE"; then
  echo "FAIL: Windows desktop executable did not pass the MCP EOF smoke: $exe" >&2
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
cleanup_build_log
build_log=""
trap - EXIT
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
  sign_script="$repo_root/scripts/windows-artifact-sign.ps1"
  artifacts_win=("$(wslpath -w "$dest_nsis")")
  if [[ -n "$dest_msi" ]]; then
    artifacts_win+=("$(wslpath -w "$dest_msi")")
  fi
  echo "[build-windows] Authenticode verifying copied final artifacts"
  powershell.exe -NoProfile -ExecutionPolicy Bypass \
    -File "$(wslpath -w "$sign_script")" \
    -MetadataPath "$(wslpath -w "$metadata_path")" \
    -VerifyOnly \
    -Artifacts "${artifacts_win[@]}"
else
  echo "[build-windows] Authenticode signing skipped by explicit SHELLX_WINDOWS_SIGNING_REQUIRED=0 development opt-out."
fi

if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "[build-windows] creating Tauri updater signature from the process environment"
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
    env -u TAURI_SIGNING_PRIVATE_KEY_PATH \
    pnpm exec tauri signer sign "$dest_nsis" >/dev/null
elif [[ -n "$updater_key_path" ]]; then
  if [[ ! -f "$updater_key_path" ]]; then
    echo "FAIL: updater key path does not exist: $updater_key_path" >&2
    exit 1
  fi
  echo "[build-windows] creating Tauri updater signature from the configured key file"
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
    env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PATH \
    pnpm exec tauri signer sign \
    --private-key-path "$updater_key_path" \
    "$dest_nsis" >/dev/null
elif [[ "$updater_required" == "1" ]]; then
  echo "FAIL: SHELLX_WINDOWS_UPDATER_REQUIRED=1 but SHELLX_WINDOWS_UPDATER_KEY_PATH is not set" >&2
  exit 1
else
  echo "[build-windows] updater .sig skipped by explicit SHELLX_WINDOWS_UPDATER_REQUIRED=0 development opt-out."
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
