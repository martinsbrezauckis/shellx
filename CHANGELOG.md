# Changelog

All notable public changes to shellX are documented here.

Policy: keep this user-facing. Release notes should describe what users
can see or rely on. Internal hardening, private audit notes, and
implementation-only cleanup stay out unless they close a public issue or
explain a visible behavior change.

## [0.3.4] - 2026-06-30

### Fixed

- Updated a vulnerable transitive networking dependency flagged by the RustSec
  advisory database.

## [0.3.3] - 2026-06-30

### Added

- Experimental Browser workflow fast tracks: agents can save successful
  Browser tasks as workflow bookmarks, discover them by site/task taxonomy,
  dry-run the attached recipe, and apply saved navigation/click/wait/select/
  press/verify route steps through normal Browser gates while secret fills and
  Vault capture stay live-bound.
- The installer now bundles the `shellx-host` agent documentation into the
  desktop app, writes it for Grok/Codex/Claude plus ShellX-owned agent docs on
  launch, and serves it from the authenticated local Debug API.
- Appearance settings now include a bright/light mode alongside dark and
  system-following mode.

### Improved

- ShellX Vault now uses the shared Vault broker for resource schemas, grants,
  recovery, safe-folder/project-capsule contracts, backups, and sync-set
  groundwork, keeping the in-app Vault aligned with the standalone Vault path.
- Browser recipe export/replay keeps more safe locator metadata, preserves
  non-secret find-text steps for replay, and stops replay cleanly at
  live-bound inputs instead of pretending raw typed values can be replayed.

## [0.3.2] - 2026-06-20

### Improved

- Browser agent control is more reliable on modern web apps, with better
  action recovery, clearer visual-coordinate guidance, stronger secret-capture
  references, and safer handling of personal versus agent-owned tabs.

### Fixed

- Startup update checks no longer show a warning when the release updater feed
  is not advertising a usable manifest yet.

## [0.3.1] - 2026-06-19

### Added

- Browser agent tools now return clearer active-tab, task, owner, profile,
  status, title, and URL summaries so agents can choose the correct next
  Browser action without extra probing.

### Fixed

- Browser agent navigation now stays out of personal tabs unless the user
  explicitly hands a tab to that task, and tabs opened from agent-owned pages
  keep agent ownership.
- Browser observations and step summaries redact sensitive URLs more
  aggressively while preserving enough navigation context for agents to
  continue.
- Browser full-page screenshot capture has a longer DevTools timeout for heavy
  pages.
- ShellX host tools now find the running Windows Debug API more reliably from
  WSL and rank exact Browser tool searches first.

## [0.3.0] - 2026-06-18

### Added

- Added ShellX Vault as the main encrypted secrets store for passwords, API
  keys, profile cards, email resources, and Stripe agent-wallet references,
  with local or connected mode, recovery-kit setup, remembered-device unlock,
  password generation, hidden copy/reveal controls, descriptions, legacy import,
  and scoped grants for agents and browser fills.
- Added Vault Request Center in the main header and ShellX Browser Requests tab
  for approving, denying, reviewing, and revoking secret, profile, wallet,
  email-code, and write-only deposit requests.
- Added ShellX Browser as a ShellX-owned browser runtime for user and agent
  workflows, with Personal, Agent Work, and Task Disposable profiles, bookmarks
  with folders and toolbar entries, history, downloads, privacy/ad-block modes,
  task receipts, safe extraction, and native webview page loading.
- Added Browser agent automation through `/browser/*`, including navigation,
  page observation, Markdown/text extraction, deterministic DOM controls,
  screenshots, DevTools/CDP, HAR/performance exports, trace bundles, workflow
  replay, scheduled jobs, download/upload handling, event queues, and release
  readiness checks.
- Environment diagnostics now include feature-readiness checks that tell users
  and agents which missing local/WSL/SSH tools affect Work Preview, Preview
  Doctor screenshots, Git evidence, ShellX host tools, and agent diagnostics.
- Agent runs in Background Tasks and the debug API now show visible tab sessions,
  provider runs, ShellX host subagents, and provider-native subagents when a
  provider stream exposes them.
- Agent CLI Setup Assistant helps install missing Grok Build, Claude Code,
  Codex CLI, and Antigravity CLI from Connections and Agent CLIs in a
  responsive setup dialog, with explicit confirmation before any command runs
  on Local, WSL, or SSH targets. It prefers native vendor installers on each
  surface and keeps Node/npm-based installs as fallbacks only where vendor docs
  still list them.

### Fixed

- Host and SSH filesystem tools now refuse additional credential and
  shell-startup paths, hide sensitive children from broad directory listings,
  skip sensitive files during broad `fs_grep`, and block CGNAT
  `100.64.0.0/10` targets in `net_fetch`.
- Session Git commands now disable pager, credential-helper, SSH command,
  hooks, fsmonitor, and `ext::` protocol hooks in ShellX-managed Git probes.

## [0.2.12] - 2026-06-09

### Added

- Per-session ShellX tool exposure controls for provider tabs, so Codex,
  Claude Code, and Antigravity sessions can prefer native tools, use selected
  ShellX bridge tools, use full host tools, or turn ShellX tools off per tab.
- Debug API active-tab report for multi-agent supervision, including tab id,
  focused state, selected agent, Local/WSL/SSH surface, cwd, and running or
  finished status.
- Debug API highlight overlays can draw labeled borders around UI elements for
  tutorials, screenshots, and demo recordings.
- Build plan approvals now have a centered review surface for screenshot-driven
  debug API checks.
- Provider capability diagnostics now include compact and advanced rows for
  release checks and agent-readable capability cards.
- Activity Browser graph now uses clearer file/folder/action visuals, adds a
  Reads & Searches and Git evidence view, and exposes a derived activity report
  through the debug API for multi-session monitoring.
- Activity Browser Evidence panels can now be resized or expanded for long
  records-heavy trace sessions.
- Activity Browser now has search across condensed Trace paths, commands,
  queries, tool names, sources, and timestamps.

### Fixed

- Windows Work Preview no longer launches generic web apps with POSIX-style
  environment prefixes that fail under `cmd.exe`.

## [0.2.11] - 2026-06-05

### Fixed

- Generated provider media paths no longer create ghost image assets when
  command text also contains shell fragments.
- SSH-tab image preview and vision tools can read generated/session images
  from the remote tab context.
- Debug API Preview Center opens the actual Markdown/HTML preview surface for
  screenshot-driven QA.

## [0.2.1] - 2026-06-05

### Added

- Multi-provider agent sessions for Codex CLI, Claude Code, and
  Antigravity CLI, with streaming output routed into the active ShellX
  session, provider-reported token usage, native resume metadata, and tab-close
  cleanup for active provider child processes.
- Composer Agent picker for choosing Grok, Claude Code, Codex CLI, or
  Antigravity per session tab.
- Agent CLI discovery and health checks for Local, WSL, and SSH
  environments, including Grok Build availability.
- Model instruction cards for named provider/media handoffs, including
  direct GPT Image, Grok Imagine image, and Grok Imagine video recipes,
  explicit-only routing, and no-silent-fallback policy.
- ShellX host MCP tooling for provider runs, so Codex and Claude sessions can
  inspect ShellX capabilities when their native CLIs expose MCP support, while
  distinguishing provider-native file tools from ShellX host `fs_*` tools.
- Explicit provider-to-Grok handoff support for user-approved prompts into an
  already-connected Grok tab, including Grok Imagine workflows, current-tab
  routing, and Local/WSL/SSH context preservation.
- Explicit provider-to-provider handoff support, including Claude-to-Codex
  media workflows when the selected environment exposes those tools.
- Generated media and attachment assets are tracked across sessions for reuse
  in provider workflows, including generated Codex GPT Image PNGs.
- Provider chat output preserves generated media paths and ShellX tab/run
  identifiers for preview and audit use.
- File and folder pickers are environment-aware across Local, WSL, and SSH
  provider tabs.
- Debug API Files pane listings are exposed as JSON for local, WSL, and SSH
  checks.
- Voice-chat playback supports provider sessions, so Claude/Codex text replies
  can use the existing ShellX spoken-response loop.

### Fixed

- New session and project tabs stay idle until the user sends a prompt or
  explicitly connects the agent.
- Work Preview starts WSL/SSH web app previews without shell quoting failures
  in generated dev-server commands.
- Grok command inventory, MCP schema discovery, and ShellX status probes stay
  out of the main chat stream; out-of-order tool updates no longer render as
  blank `tool` cards.
- Long `/build` runs keep in-flight Agent work tracked after wait-budget
  snapshots and clean up running Agent subagents when stopped.
- SSH folder browsing works against macOS targets that use BSD `find`.
- Generated asset lists no longer show regex/search patterns as phantom images.
- Legacy connection presets are imported into the ShellX data store when both
  old and new local data folders exist.
- SSH Grok sessions now find user-level `uvx`/`npx` launchers for marketplace
  MCP servers, so remote Fetch/Git tools do not appear missing when they live
  under `~/.local/bin` or an NVM/Homebrew path.
- macOS contributor source builds compile cleanly again (#1).

## [0.1.36] - 2026-06-02

### Added

- Files panel search stays pinned with the current folder while scrolling.
- Files tab can browse upward from the session folder, including WSL/SSH
  folder paths.
- Chat `/` autocomplete includes shellX `/commands` with input hints.
- Build cockpit can recheck stale blockers without restarting the session.
- Messages sent during an active Build run are queued as operator notes
  and injected at the next safe continuation.
- Build planning adds a git baseline task and initializes a repository in
  the project root when one is missing.
- Discord DM connectors can use Session Chat and return Grok text
  replies, matching the Telegram direct-chat flow.

### Fixed

- Unsent attachment chips stay scoped to their chat and are cleared when
  that chat closes.
- Preview Doctor screenshot links in chat open the captured image instead
  of a missing project-file placeholder.
- Long Build messages no longer create a horizontal chat scrollbar.
- Build Blocked clears when trusted Agent progress resumes after a stale
  blocker.
- Build Transport failed can be resumed after re-authentication or app
  restart without starting a fresh build run.
- Resume reconnects an active Build run before sending the next
  continuation.
- Localhost preview URLs in chat stay as browser links instead of broken
  file-preview chips.
- Safe MCP tool names no longer appear as `REDACTED` in chat/tool
  diagnostics.
- WSL MCP launcher checks find user-level `uvx` installs under
  `~/.local/bin`.
- WSL Grok environment diagnostics use the same user-bin path lookup.
- SSH Grok environment diagnostics pass the ShellX MCP bearer through
  the remote stdin prelude, matching normal SSH sessions.
- Debug API `/connect` honors `permissionMode` so smoke and Build test
  sessions can start in auto-approve mode.
- Grok environment no longer shows generic API-key guidance when no
  API-key environment variable is configured.
- Build scratchboard paths no longer get hidden as `REDACTED` in chat
  streams.
- Bare Markdown names in chat diagnostics no longer open missing cwd
  preview files unless they are explicit paths or session artifacts.
- Async Build Agent runs now get a hard watchdog so zero-output
  reviewer/verifier subagents cannot run indefinitely.

## [0.1.35] - 2026-05-31

### Fixed

- Chat `plan.md` and `goal.md` links now open the active Grok session
  copies instead of a missing Windows user-profile file.
- Generated image, video, and markdown previews keep encoded Grok
  session paths intact.
- Reconnected Grok tabs keep prior context, custom chat names, and
  session grouping after restart or close.
- Project markings survive reinstall data cleanup, slash-command
  autocomplete stays visible above the composer, and chat typing does
  less transcript repainting.

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
