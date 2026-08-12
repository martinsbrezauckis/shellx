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
if [[ -z "$build_root" || -z "$source_repo" || -z "$expected_commit" || -z "$verifier" ]]; then
  echo "canonical release build identity environment is required before signing" >&2
  exit 1
fi
source_repo="$(cd "$source_repo" && pwd -P)"
build_root="$(cd "$build_root" && pwd -P)"
if [[ "$verifier" != "$source_repo/scripts/verify-release-build-input.mjs" ]]; then
  echo "release build-input verifier must come from the canonical source checkout" >&2
  exit 1
fi
node "$verifier" \
  --build-root "$build_root" \
  --source-repo "$source_repo" \
  --expected-commit "$expected_commit" >/dev/null

powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$(wslpath -w "$source_repo/scripts/windows-artifact-sign.ps1")" \
  -MetadataPath "$(wslpath -w "$metadata_path")" \
  -Artifacts "$(wslpath -w "$artifact_path")"
