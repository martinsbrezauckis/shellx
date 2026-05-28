#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "scripts/build-macos.sh must run on macOS." >&2
  exit 1
fi

version="$(node -p "require('./package.json').version")"
artifact_dir="${SHELLX_MAC_ARTIFACT_DIR:-$HOME/shellx-builds/v${version}/macos}"
build_log="$artifact_dir/build.log"
smoke_log="$artifact_dir/smoke-app.log"
smoke_port="${SHELLX_MAC_SMOKE_PORT:-5777}"
run_smoke="${SHELLX_MAC_SMOKE:-1}"
skip_tests="${SHELLX_MAC_SKIP_TESTS:-0}"
signed_build="${SHELLX_MAC_SIGNED:-0}"
dmg_build="${SHELLX_MAC_DMG:-0}"

mkdir -p "$artifact_dir"

log() {
  printf '[shellx mac] %s\n' "$*"
}

write_sha256sums() {
  local files=("$@")
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${files[@]}"
  else
    shasum -a 256 "${files[@]}"
  fi
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

if [[ "$dmg_build" == "1" && -n "${SSH_CONNECTION:-}" && "${SHELLX_MAC_ALLOW_SSH_DMG:-0}" != "1" ]]; then
  cat >&2 <<'MSG'
DMG packaging uses macOS Finder/osascript styling and has hung in headless SSH tests.
Run the DMG build from an active macOS GUI session, or set SHELLX_MAC_ALLOW_SSH_DMG=1
if you intentionally want to retry it over SSH.
MSG
  exit 1
fi

if [[ "$signed_build" == "1" ]]; then
  if [[ -z "${APPLE_SIGNING_IDENTITY:-}" && -z "${APPLE_CERTIFICATE:-}" ]]; then
    echo "Set APPLE_SIGNING_IDENTITY or APPLE_CERTIFICATE for a signed macOS build." >&2
    exit 1
  fi
  if [[ -n "${APPLE_CERTIFICATE:-}" ]]; then
    require_env APPLE_CERTIFICATE_PASSWORD
  fi
  if [[ -n "${APPLE_ID:-}" ]]; then
    require_env APPLE_PASSWORD
    require_env APPLE_TEAM_ID
  elif [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_ISSUER:-}" || -n "${APPLE_API_KEY_PATH:-}" ]]; then
    require_env APPLE_API_KEY
    require_env APPLE_API_ISSUER
    require_env APPLE_API_KEY_PATH
  else
    echo "Set App Store Connect notarization env (APPLE_API_KEY/APPLE_API_ISSUER/APPLE_API_KEY_PATH) or Apple ID env (APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID)." >&2
    exit 1
  fi
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
    echo "Set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH so updater artifacts can be signed." >&2
    exit 1
  fi
fi

log "repo=$repo_root"
log "artifacts=$artifact_dir"

if [[ "$skip_tests" != "1" ]]; then
  log "installing dependencies"
  pnpm install --frozen-lockfile 2>&1 | tee "$build_log"

  log "running frontend and Rust gates"
  {
    pnpm exec tsc --noEmit
    pnpm test
    cargo fmt --check --manifest-path src-tauri/Cargo.toml
    cargo check --manifest-path src-tauri/Cargo.toml --features debug-api
    cargo test --manifest-path src-tauri/Cargo.toml --features debug-api
    cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features debug-api -- -D warnings
  } 2>&1 | tee -a "$build_log"
else
  log "skipping tests because SHELLX_MAC_SKIP_TESTS=1"
  : >"$build_log"
fi

bundle_arg="app"
if [[ "$dmg_build" == "1" ]]; then
  bundle_arg="dmg"
fi

tauri_args=(tauri build --features debug-api --ci --bundles "$bundle_arg")
if [[ "$signed_build" != "1" ]]; then
  tauri_args+=(--no-sign)
fi

log "building macOS bundle: pnpm ${tauri_args[*]}"
pnpm "${tauri_args[@]}" 2>&1 | tee -a "$build_log"

bundle_root="src-tauri/target/release/bundle"
app_binary="$bundle_root/macos/shellX.app/Contents/MacOS/shellx"
if [[ ! -x "$app_binary" ]]; then
  echo "Built app binary not found: $app_binary" >&2
  exit 1
fi

shopt -s nullglob
for artifact in "$bundle_root"/macos/shellX.app.tar.gz "$bundle_root"/macos/shellX.app.tar.gz.sig "$bundle_root"/dmg/*.dmg "$bundle_root"/dmg/*.dmg.sig; do
  [[ -e "$artifact" ]] || continue
  cp -f "$artifact" "$artifact_dir/"
done
shopt -u nullglob

smoke_pid=""
cleanup() {
  if [[ -n "$smoke_pid" ]] && kill -0 "$smoke_pid" 2>/dev/null; then
    kill "$smoke_pid" 2>/dev/null || true
    wait "$smoke_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "$run_smoke" == "1" ]]; then
  log "launching app smoke on debug API port $smoke_port"
  port_file="$HOME/.shellx/debug-api.port"
  token_file="$HOME/.shellx/shellxagent.token"
  rm -f "$port_file"
  pkill -f "/shellX.app/Contents/MacOS/shellx" 2>/dev/null || true
  sleep 0.5
  GROK_SHELL_DEBUG_PORT="$smoke_port" "$app_binary" >"$smoke_log" 2>&1 &
  smoke_pid="$!"

  port=""
  for _ in {1..80}; do
    if ! kill -0 "$smoke_pid" 2>/dev/null; then
      echo "smoke app exited before debug API became ready; see $smoke_log" >&2
      exit 1
    fi
    if [[ -s "$port_file" ]]; then
      port="$(tr -d '[:space:]' <"$port_file")"
      if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
        break
      fi
    fi
    sleep 0.25
  done
  if [[ -z "$port" ]]; then
    echo "debug API did not publish a port; see $smoke_log" >&2
    exit 1
  fi
  if ! curl -fsS "http://127.0.0.1:${port}/health" >/dev/null; then
    echo "debug API health failed on port $port; see $smoke_log" >&2
    exit 1
  fi
  if [[ ! -s "$token_file" ]]; then
    echo "shellxagent token missing: $token_file" >&2
    exit 1
  fi
  token="$(tr -d '[:space:]' <"$token_file")"

  SHELLX_MAC_BASE_URL="http://127.0.0.1:${port}" SHELLX_MAC_TOKEN="$token" node <<'NODE'
const base = process.env.SHELLX_MAC_BASE_URL;
const token = process.env.SHELLX_MAC_TOKEN;
async function main() {
  const response = await fetch(`${base}/diagnostics`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      only: ["fs", "auth", "vault", "sessions", "connections", "settings", "screenshot"],
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`diagnostics HTTP ${response.status}: ${text}`);
  const json = JSON.parse(text);
  const failed = (json.checks || []).filter((check) => {
    if (!check) return true;
    if (check.ok === false) return true;
    if (typeof check.status === "string" && check.status !== "pass") return true;
    return false;
  });
  if (failed.length) throw new Error(`diagnostics failed: ${JSON.stringify(failed)}`);
}
main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
NODE

  curl -fsS -H "Authorization: Bearer $token" "http://127.0.0.1:${port}/screenshot" \
    >"$artifact_dir/shellx-window.png"
  log "smoke screenshot saved to $artifact_dir/shellx-window.png"
fi

(
  cd "$artifact_dir"
  shopt -s nullglob
  checksum_inputs=()
  for artifact in shellX.app.tar.gz shellX.app.tar.gz.sig *.dmg *.dmg.sig shellx-window.png; do
    [[ -e "$artifact" ]] || continue
    checksum_inputs+=("$artifact")
  done
  if (( ${#checksum_inputs[@]} > 0 )); then
    write_sha256sums "${checksum_inputs[@]}" >SHA256SUMS.txt
  fi
  shopt -u nullglob
)

log "built artifacts:"
find "$artifact_dir" -maxdepth 1 -type f -print | sort
