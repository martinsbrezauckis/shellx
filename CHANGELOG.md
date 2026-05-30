# Changelog

All notable public changes to shellX are documented here.

Policy: keep this user-facing. Release notes should describe what users
can see or rely on. Internal hardening, private audit notes, and
implementation-only cleanup stay out unless they close a public issue or
explain a visible behavior change.

## [0.1.34] - 2026-05-30

### Added

- Work Preview for generated static HTML, web apps, and Expo web apps,
  with logs, Preview Doctor, screenshots, Ask Fix, Preview Center
  routing for previewable HTML links, and bottom-docked resizable logs.
- Attachment & Media Board plus optional Windows **Send to shellX** handoff for
  sending selected files into the active composer as attachment chips.
- Background task cockpit health counters, task reports, and Ask Grok
  diagnostics for visible task sets.

## [0.1.33] - 2026-05-28

### Added

- Grok environment diagnostics in the Tools panel with MCP health,
  `grok inspect` counts, trace export, and Preview setup checks.
- Header connector inbox for Telegram and Discord bot messages, with
  allowlists, search, date filters, unread badges, and simulation tests.
- Telegram Session Chat replies for allowlisted direct chats, including
  text replies and referenced image outputs from the active/fixed tab.

### Changed

- `/build` is now the single public long-horizon command. Legacy `/goal`
  input is treated as a compatibility alias and new UI/docs teach
  `/build` only.
- `/build` can keep long-running Agent work alive after a wait budget
  expires instead of killing active work.
- xAI API-key guidance now prefers `XAI_API_KEY` and labels
  `GROK_CODE_XAI_API_KEY` as legacy.

## [0.1.32] - 2026-05-25

### Added

- Experimental `/build` mode with a dedicated Build Run cockpit,
  approval gate, scratchboard, receipt log, checkpoints, and completion
  gates.
- Build receipts in Trace so plan writes, file changes, subagent starts
  and completions, checkpoints, verification, and accepted completion are
  auditable.

### Changed

- Local/WSL/SSH debug API sessions now expose stronger build-run state,
  receipts, and git checkpoint evidence for automated validation.
- Session Activity and Trace surfaces now show more complete tool
  activity for file, git, subagent, and build events.

### Fixed

- Checkpoint receipts with captured diffs now mark a build as
  code-changing, so review and verification gates stay enforced even
  when a transport misses a direct file-write observation.

## [0.1.31] - 2026-05-24

### Added

- Session **Trace** opens an Activity Browser with file/search/write/delete
  activity, an activity graph, and session-scoped media references.
- Session **Git** panel with repository status, diff review, local
  checkpoints, and worktree creation for the active tab's real working
  directory.
- Session-scoped update diagnostics so updater state can be reviewed from
  the connected session instead of guessing from global UI state.
- Five compact bundled Grok workflow skills for app building, bug fixing,
  UI polish, repo review, and release preparation.

### Changed

- Right-rail and bottom workspace tabs are now icon-first with hover
  explanations, keeping narrow layouts usable as more panels are added.
- Generated image/video paths now resolve consistently for local Windows,
  WSL, and SSH sessions in chat, media tabs, and preview.
- Session Trace now treats idle reconnect sessions as `No file activity`
  instead of surfacing internal missing-log wording.
- Terminal tasks can be killed or removed from Background Tasks even after
  switching away from the Terminal tab.
- Header search now keeps long result lists scrollable while letting the
  selected result preview use the full available popover height.
- The left rail history footer no longer shows an ambiguous total chat
  count below Past chats.
- Composer scope chips now truncate long connection, project, branch, and
  autonomy labels instead of crowding adjacent controls.

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
- Outside Connector settings for Telegram bot credentials, allowed
  senders, routing targets, and credential tests.
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
