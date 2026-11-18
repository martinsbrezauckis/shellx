#!/usr/bin/env bash
# One direct public product check, run on Linux, Windows and macOS.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

pnpm run typecheck
pnpm build
pnpm run test:public
cargo fmt --manifest-path src-tauri/Cargo.toml --check
if [[ "${RUNNER_OS:-}" == Windows ]]; then
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features debug-api,windows-test-manifest -- -D warnings
  cargo test --manifest-path src-tauri/Cargo.toml --all-targets --features debug-api,windows-test-manifest
else
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features debug-api -- -D warnings
  cargo test --manifest-path src-tauri/Cargo.toml --all-targets --features debug-api
fi
if [[ "${RUNNER_OS:-}" == Linux ]]; then
  cargo check --manifest-path src-tauri/Cargo.toml --all-targets --features debug-api
fi
