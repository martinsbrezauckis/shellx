# Changelog

All notable public changes to shellX are documented here.

Policy: keep this user-facing. Release notes should describe what users
can see or rely on. Internal hardening, private audit notes, and
implementation-only cleanup stay out unless they close a public issue or
explain a visible behavior change.

## [0.1.30] - 2026-05-24

### Added

- Session-scoped **Tools** status in the right rail so each connected
  environment can show what tools are ready, missing, or need setup.
- Grok Web Search, Web Fetch, and shellX X Search capability status in
  the session Tools panel when the connected build exposes them.
- Generated **Images** and **Videos** tabs with thumbnail grids and
  full-size previews.
- File preview support for common code/config files, PDFs, images,
  videos, and unsupported-file messaging.
- Sandboxed HTML output preview. HTML files still open as code by
  default; the rendered preview is an explicit user choice.
- Outside Connector settings for Telegram bot and local relay
  credentials, allowed senders, routing targets, and credential tests.
- In-app changelog access from Settings -> About.

### Changed

- Session tabs now include compact numbered status badges for easier
  navigation from small screens and external connectors.
- Plugin/MCP setup now separates global connector settings from
  per-session tool health.
- Plan review uses a clearer modal layout with cleaner
  approve/reject/request-changes controls.
- Settings -> General now explains that Permission UX only applies to
  Confirm mode prompts.
- Settings -> About now keeps public links external while in-app docs
  open inside shellX.

## [0.1.29] - 2026-05-22

Initial public beta release.

### Added

- Multi-tab Grok Build desktop client with Local, WSL, and SSH
  connection presets.
- `/goal` autonomous task mode with live plan visibility, pause/resume
  controls, and completion checks.
- MCP/plugin management for curated tool servers.
- Encrypted local vault for API keys, tokens, and shared secrets.
- Voice input and voice-chat playback using available xAI credentials.
- Grok Imagine image and video generation support inside shellX when
  the connected Grok account exposes Imagine features.
- File links, markdown/code previews, inline tool output, and generated
  media previews in chat.
- Session history, project grouping, search, and workspace archive
  download.
- Tauri updater integration for signed Windows releases.

### Changed

- Header brand opens Settings -> About as the single app identity
  surface.
- GitHub release workflow builds signed installer/update artifacts from
  version tags.

## Pre-Public Development Archive

Before 0.1.29, shellX moved through private beta builds while the
Windows app, ACP transports, host MCP, vault, plugin marketplace,
screenshot capture, voice mode, updater, and `/goal` orchestration were
tested together. Private beta notes are not part of the public
changelog.
