#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 <windows-artifact>" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_path="$1"
metadata_path="${SHELLX_WINDOWS_SIGNING_METADATA_PATH:-}"

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

powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$(wslpath -w "$repo_root/scripts/windows-artifact-sign.ps1")" \
  -MetadataPath "$(wslpath -w "$metadata_path")" \
  -Artifacts "$(wslpath -w "$artifact_path")"
