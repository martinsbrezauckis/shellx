#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 <windows-artifact>" >&2
  exit 2
fi

artifact_path="$1"
metadata_path="${SHELLX_WINDOWS_SIGNING_METADATA_PATH:-}"
build_root="${SHELLX_RELEASE_BUILD_ROOT:-}"
source_repo="${SHELLX_RELEASE_SOURCE_REPO:-}"
expected_commit="${SHELLX_EXPECTED_SOURCE_COMMIT:-}"
verifier="${SHELLX_RELEASE_BUILD_INPUT_VERIFIER:-}"
generated_input_digest="${SHELLX_RELEASE_GENERATED_INPUT_DIGEST:-}"
artifact_root="${SHELLX_RELEASE_ARTIFACT_ROOT:-}"
nsis_executable="${SHELLX_RELEASE_NSIS_EXECUTABLE:-}"
nsis_executable_sha256="${SHELLX_RELEASE_NSIS_EXECUTABLE_SHA256:-}"
release_build_started="${SHELLX_RELEASE_BUILD_STARTED:-}"
nsis_signing_stage_root="${SHELLX_RELEASE_NSIS_SIGNING_STAGE_ROOT:-}"

if [[ -z "$metadata_path" ]]; then
  echo "SHELLX_WINDOWS_SIGNING_METADATA_PATH is required" >&2
  exit 1
fi
if [[ ! -f "$artifact_path" ]]; then
  echo "Windows artifact does not exist: $artifact_path" >&2
  exit 1
fi
if [[ ! -f "$metadata_path" ]]; then
  echo "Signing metadata file does not exist: $metadata_path" >&2
  exit 1
fi
if [[ -z "$build_root" || -z "$source_repo" || -z "$expected_commit" || -z "$verifier" \
  || -z "$generated_input_digest" || -z "$artifact_root" ]]; then
  echo "canonical release build identity environment is required before signing" >&2
  exit 1
fi
source_repo="$(cd "$source_repo" && pwd -P)"
build_root="$(cd "$build_root" && pwd -P)"
artifact_root="$(cd "$artifact_root" && pwd -P)"
artifact_directory="$(cd "$(dirname "$artifact_path")" && pwd -P)"
artifact_real="$artifact_directory/$(basename "$artifact_path")"
if [[ -L "$artifact_path" || ! -f "$artifact_real" ]]; then
  echo "Windows signing artifact must be a regular non-symlink file: $artifact_path" >&2
  exit 1
fi
approved_nsis_uninstaller=0
staged_nsis_uninstaller=""
nsis_callback_artifact=""
nsis_callback_identity=""
cleanup_staged_nsis_uninstaller() {
  if [[ -n "$staged_nsis_uninstaller" && -f "$staged_nsis_uninstaller" ]]; then
    unlink -- "$staged_nsis_uninstaller"
  fi
}
trap cleanup_staged_nsis_uninstaller EXIT
case "$artifact_real" in
  "$artifact_root"/*) ;;
  *)
    if [[ "$artifact_directory" != "/tmp" \
      || ! "$(basename "$artifact_real")" =~ ^makensis[A-Za-z0-9]{6}$ ]]; then
      echo "Windows signing artifact is outside the exact release target root: $artifact_path" >&2
      exit 1
    fi
    if [[ ! "$release_build_started" =~ ^[0-9]{10}$ \
      || ! "$nsis_executable_sha256" =~ ^[0-9a-f]{64}$ \
      || -L "$nsis_executable" || ! -x "$nsis_executable" \
      || "$(sha256sum "$nsis_executable" | cut -d ' ' -f 1)" != "$nsis_executable_sha256" ]]; then
      echo "NSIS uninstaller signer identity is missing or drifted" >&2
      exit 1
    fi
    artifact_stat="$(stat -c '%u:%a:%h:%Y' "$artifact_real")"
    if [[ "$artifact_stat" != "$(id -u):600:1:"* \
      || "${artifact_stat##*:}" -lt "$release_build_started" \
      || "$(LC_ALL=C head -c 2 "$artifact_real")" != "MZ" ]]; then
      echo "NSIS uninstaller callback failed ownership, freshness, or PE checks: $artifact_path" >&2
      exit 1
    fi
    signer_shell_pid="$PPID"
    makensis_pid="$(awk '/^PPid:/{print $2}' "/proc/$signer_shell_pid/status" 2>/dev/null || true)"
    if [[ ! "$makensis_pid" =~ ^[0-9]+$ \
      || "$(readlink -f "/proc/$makensis_pid/exe" 2>/dev/null || true)" != "$nsis_executable" ]]; then
      echo "NSIS uninstaller callback is not owned by the pinned makensis process" >&2
      exit 1
    fi
    nsis_cwd="$(readlink -f "/proc/$makensis_pid/cwd" 2>/dev/null || true)"
    installer_script_found=0
    installer_script_count=0
    while IFS= read -r argument; do
      case "$argument" in
        /*) candidate_script="$argument" ;;
        *) candidate_script="$nsis_cwd/$argument" ;;
      esac
      case "$candidate_script" in
        *.nsi) installer_script_count=$((installer_script_count + 1)) ;;
        *) continue ;;
      esac
      if [[ -L "$candidate_script" || ! -f "$candidate_script" ]]; then
        continue
      fi
      candidate_script="$(readlink -f "$candidate_script" 2>/dev/null || true)"
      case "$candidate_script" in
        "$artifact_root"/nsis/*/installer.nsi)
          candidate_script_stat="$(stat -c '%u:%Y' "$candidate_script")"
          if [[ "$candidate_script_stat" == "$(id -u):"* \
            && "${candidate_script_stat##*:}" -ge "$release_build_started" \
            && $(grep -Fc '!uninstfinalize' "$candidate_script") -eq 1 \
            && $(grep -Fc "$source_repo/scripts/windows-artifact-sign-command.sh" "$candidate_script") -eq 1 ]]; then
            installer_script_found=1
          fi
          ;;
      esac
    done < <(tr '\0' '\n' < "/proc/$makensis_pid/cmdline")
    if [[ "$installer_script_count" != "1" || "$installer_script_found" != "1" ]]; then
      echo "NSIS uninstaller callback is not building the contained installer script" >&2
      exit 1
    fi
    expected_nsis_signing_stage_root="$artifact_root/.shellx-nsis-signing-stage"
    if [[ "$nsis_signing_stage_root" != "$expected_nsis_signing_stage_root" \
      || -L "$nsis_signing_stage_root" || ! -d "$nsis_signing_stage_root" \
      || "$(stat -c '%u:%a' "$nsis_signing_stage_root")" != "$(id -u):700" ]]; then
      echo "NSIS signing stage must be the exact private directory inside the release target" >&2
      exit 1
    fi
    nsis_signing_stage_root="$(cd "$nsis_signing_stage_root" && pwd -P)"
    staged_nsis_uninstaller="$nsis_signing_stage_root/uninstaller-$makensis_pid-$(basename "$artifact_real").exe"
    if [[ -e "$staged_nsis_uninstaller" ]]; then
      echo "NSIS signing stage path is not fresh" >&2
      exit 1
    fi
    nsis_callback_artifact="$artifact_real"
    nsis_callback_identity="$(stat -c '%d:%i' "$nsis_callback_artifact")"
    ln -- "$nsis_callback_artifact" "$staged_nsis_uninstaller"
    if [[ "$nsis_callback_identity" != "$(stat -c '%d:%i' "$staged_nsis_uninstaller")" ]]; then
      echo "NSIS signing stage does not preserve the callback inode" >&2
      exit 1
    fi
    artifact_real="$staged_nsis_uninstaller"
    artifact_directory="$nsis_signing_stage_root"
    echo "NSIS uninstaller signing callback accepted from pinned makensis"
    approved_nsis_uninstaller=1
    ;;
  *) echo "Windows signing artifact is outside the exact release target root: $artifact_path" >&2; exit 1 ;;
esac
case "$artifact_real" in
  *.[eE][xX][eE]|*.[mM][sS][iI]) ;;
  "$artifact_root"/[nN][sS][iI][sS]/*/[pP][lL][uU][gG][iI][nN][sS]/*/*.[dD][lL][lL]) ;;
  *)
    if [[ "$approved_nsis_uninstaller" != "1" ]]; then
      echo "Windows signing artifact must be an EXE, MSI, contained NSIS plugin DLL, or controlled NSIS uninstaller: $artifact_path" >&2
      exit 1
    fi
    ;;
esac
if [[ "$verifier" != "$source_repo/scripts/verify-release-build-input.mjs" ]]; then
  echo "release build-input verifier must come from the canonical source checkout" >&2
  exit 1
fi
node "$verifier" \
  --build-root "$build_root" \
  --source-repo "$source_repo" \
  --expected-commit "$expected_commit" \
  --expected-generated-input-digest "$generated_input_digest" >/dev/null

powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$(wslpath -w "$source_repo/scripts/windows-artifact-sign.ps1")" \
  -MetadataPath "$(wslpath -w "$metadata_path")" \
  -Artifacts "$(wslpath -w "$artifact_real")"

if [[ "$approved_nsis_uninstaller" == "1" ]]; then
  if [[ "$(stat -c '%d:%i' "$nsis_callback_artifact")" != "$nsis_callback_identity" \
    || "$(stat -c '%d:%i' "$staged_nsis_uninstaller")" != "$nsis_callback_identity" ]]; then
    echo "NSIS uninstaller signing did not preserve the callback inode" >&2
    exit 1
  fi
fi

cleanup_staged_nsis_uninstaller
staged_nsis_uninstaller=""
