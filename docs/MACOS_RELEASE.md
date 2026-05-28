# macOS Release Readiness

Status as of 2026-05-28: macOS source gates, unsigned app build, launch,
debug API smoke, diagnostics, screenshot capture, and one live Grok
prompt passed on the configured macOS builder. Public macOS downloads
remain withheld until Developer ID signing and notarization are available.

## Builder

- Host: configured macOS builder with SSH access
- Audit checkout: clean release checkout on the builder
- Artifact directory: `~/shellx-builds/v<version>/macos`
- Helper: `./scripts/build-macos.sh`

## Unsigned App Smoke

Run this before staging a release:

```bash
./scripts/build-macos.sh
```

The helper runs dependency install, frontend checks, Rust fmt/check/test
/ clippy, builds an unsigned `.app`, launches it, checks `/health`,
runs structural diagnostics, captures `/screenshot`, copies artifacts,
and writes `SHA256SUMS.txt`.

For a quick re-smoke after the full gates already passed:

```bash
SHELLX_MAC_SKIP_TESTS=1 ./scripts/build-macos.sh
```

## Signed Public Build

Run signed/notarized builds from an active macOS GUI session:

```bash
SHELLX_MAC_SIGNED=1 SHELLX_MAC_DMG=1 ./scripts/build-macos.sh
```

Required environment:

- `APPLE_SIGNING_IDENTITY` for a certificate already installed in the
  keychain, or `APPLE_CERTIFICATE` plus `APPLE_CERTIFICATE_PASSWORD`.
- App Store Connect notarization: `APPLE_API_KEY`,
  `APPLE_API_ISSUER`, and `APPLE_API_KEY_PATH`.
- Or Apple ID notarization: `APPLE_ID`, `APPLE_PASSWORD`, and
  `APPLE_TEAM_ID`.
- Tauri updater signing: `TAURI_SIGNING_PRIVATE_KEY` or
  `TAURI_SIGNING_PRIVATE_KEY_PATH`; add
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when the key is encrypted.

The script refuses DMG packaging over SSH by default because Tauri's DMG
styling path uses Finder/osascript and hung during headless SSH testing.
Use an interactive Mac session for the public DMG, or set
`SHELLX_MAC_ALLOW_SSH_DMG=1` only when intentionally debugging that path.

## Current Known Gaps

- Apple Developer ID enrollment is still pending, so signed/notarized
  public macOS artifacts are not attached yet.
- Keep the Mac mini Grok CLI current before using macOS as a Grok
  behavior reference.
- `latest.json` does not include macOS updater platforms until the first
  macOS public release assets are attached. shellX now treats missing
  macOS updater platforms as a quiet "no release yet" state instead of a
  red startup error.

## References

- Tauri reads `tauri.macos.conf.json` as a platform-specific config and
  merges it with the main config.
- Tauri macOS signing accepts either an installed keychain identity or
  exported certificate environment variables.
- Tauri notarization accepts App Store Connect API credentials or Apple
  ID credentials, and notarization is required for Developer ID
  distribution.
