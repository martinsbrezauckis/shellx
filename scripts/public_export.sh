#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' \
    'usage: scripts/public_export.sh --out <empty-export-dir> [--git] [--allow-dirty]' \
    '' \
    'Creates a release-safe ShellX public export from the committed HEAD.' \
    '' \
    'Options:' \
    '  --out <dir>  Missing or empty destination directory.' \
    '  --git          Initialize and locally commit the new export.' \
    '  --allow-dirty  Export committed HEAD while ignoring tracked edits (test/preview only).'
}

out_dir=""
init_git=0
allow_dirty=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out)
      out_dir="${2:-}"
      shift 2
      ;;
    --git)
      init_git=1
      shift
      ;;
    --allow-dirty)
      allow_dirty=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$out_dir" ]; then
  printf '%s\n' '--out is required' >&2
  usage >&2
  exit 2
fi

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
out_parent_input="$(dirname -- "$out_dir")"
mkdir -p -- "$out_parent_input"
out_parent="$(cd "$out_parent_input" && pwd -P)"
out_dir="$out_parent/$(basename -- "$out_dir")"

case "$out_dir" in
  /|"$source_dir"|"$source_dir"/*|"$out_parent"|"${HOME:-__unset_home__}")
    printf 'refusing unsafe public-export destination: %s\n' "$out_dir" >&2
    exit 2
    ;;
esac

if [ -e "$out_dir" ] && [ ! -d "$out_dir" ]; then
  printf 'public-export destination is not a directory: %s\n' "$out_dir" >&2
  exit 2
fi
if [ -d "$out_dir" ] && find "$out_dir" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  printf 'public-export destination must be empty: %s\n' "$out_dir" >&2
  exit 2
fi

if [ "$allow_dirty" -ne 1 ] && { ! git -C "$source_dir" diff --quiet -- || ! git -C "$source_dir" diff --cached --quiet --; }; then
  printf '%s\n' 'tracked source changes must be committed before public export' >&2
  exit 2
fi

source_commit="$(git -C "$source_dir" rev-parse HEAD)"
tmp_dir="$(mktemp -d)"

cleanup() {
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

# Export canonical Git blob bytes on every host. Git for Windows otherwise
# applies core.autocrlf while archiving and the payload no longer matches the
# committed objects that the manifest binds.
git -c core.autocrlf=false -C "$source_dir" archive --format=tar HEAD | tar -C "$tmp_dir" -xf -

# The helper and policy come from the same committed archive as the payload.
# Every tracked path must be included or excluded by a category/reason before
# any bytes are copied into the destination.
node "$tmp_dir/scripts/prepare-public-export.mjs" \
  --repo-root "$source_dir" \
  --payload-root "$tmp_dir" \
  --source-commit "$source_commit"

mkdir -p -- "$out_dir"
tar -C "$tmp_dir" -cf - . | tar -C "$out_dir" -xf -

if [ "$init_git" -eq 1 ]; then
  git -C "$out_dir" init -b main >/dev/null
  git -C "$out_dir" add -A
  git -C "$out_dir" \
    -c user.name='ShellX Public Export' \
    -c user.email='shellx-public-export@example.invalid' \
    commit -m 'Create ShellX public export' >/dev/null
fi

printf 'SHELLX_PUBLIC_EXPORT_OK %s %s\n' "$source_commit" "$out_dir"
