import{f as t,j as e,S as c}from"./LazySurface-EcW3B_n5.js";import{T as d,M as p,a as u,b as h}from"./shellx-CESBtrKy.js";import{u as w}from"./useModalFocus-BdgPt4s6.js";import"./task-teach-handoff-events-B2JD3vZe.js";const m=`# Changelog

All notable public changes to shellX are documented here.

## [0.3.62] - 2026-11-17

### Added

- Full session history opens as a read-only, paged view once a chat has durable
  history. It can safely prepare delimiter-free legacy history before showing
  an older page.
- The desktop bundles the \`shellx-host\` reference in ShellX-owned agent docs.
  Sessions ShellX launches receive compact rules and, when enabled,
  session-scoped Host MCP access; direct CLI sessions remain unchanged.

### Improved

- Native Browser download requests wait for explicit operator approval. ShellX
  retries only supported URL-addressable requests for the current task and tab,
  and keeps waiting, saved, failed, and cleanup-needed transfer state visible.
- Task Trace can recover a completed run after restart only when its durable
  archive record verifies. Otherwise Trace remains incomplete rather than
  treating a missing or partial archive as proof that nothing happened.
- Flight Recorder distinguishes intentional policy redactions from capture or
  retention gaps, and shows a reason for each retained redaction marker.
- Agent-requested Browser workflow and Trace exports stay tied to the
  caller-owned task and tab. Task attachments remain bound to their selected
  project in a managed Git-ignored location.
- Provider availability reports distinguish bundled guidance from a fresh
  target scan. A recorded card review date or CLI version does not claim a
  current native capability.
- Vault setup explains its access requirements and asks users to acknowledge
  the risk of permanent access loss. Recovery words and a restore flow are
  not available.

### Fixed

- Codex CLI detection on Windows with npm shell wrappers, and the Codex
  installer download source ([#11](https://github.com/martinsbrezauckis/shellx/issues/11)).
- Bugfixes.

## [0.3.61] - 2026-08-24

### Fixed

- Bugfixes.

## [0.3.60] - 2026-08-16

### Added

- Tasks turn a chat request into one-time or recurring work, with simple
  scheduling, notifications, run history, exact environment selection, and an
  ordered agent fallback list.
- Optional new-session defaults can preselect an Agent and starting folder, so
  a fresh chat is ready to use immediately.
- Browser Teach can save an approved workflow as a paused Task draft.
- ShellX Cut is available in Tools and to hosted agents for bounded video
  editing.

### Fixed

- Bugfixes.

## [0.3.52] - 2026-08-13

### Added

- Browser Teach keeps the most recent complete Flight Recorder attempt
  available after its task completes and turns it into a reviewable workflow
  draft. Users can resolve ambiguity, select Vault key identities, save an
  immutable revision, approve an Action Recipe without running it, and
  rehearse it through the zero-action dry-run planner.
- Browser Evidence includes a fixed native Developer Inspection for bounded
  document, console, network, performance, and issue summaries, with separate
  private HAR and performance exports.
- Antigravity model guidance highlights native Gemini image generation and
  keeps video routing capability-aware across supported providers.

### Improved

- Browser tab handoff now opens a ShellX-owned review with the sanitized page
  context, profile persistence, current owner, selected task, and separate
  Vault boundary before the user confirms the transfer.
- Browser Teach, Developer Inspection, Flight Recorder, forms, and keyboard
  focus use a consistent compact hierarchy in light and dark themes, including
  narrow right-panel layouts.

### Fixed

- Task Disposable Browser profiles start each new task without cookies,
  local storage, or IndexedDB data left by a previous task, and safely finish
  cleanup after native tabs close.
- Browser bookmarks and workflow bookmarks survive application restarts.
  Clear History now applies only to the selected User, Agent, or confirmed All
  scope.
- Windows Browser keeps Microsoft Defender SmartScreen active while applying
  ShellX privacy and download controls.
- Browser reads, tab actions, and Vault-assisted page actions stay bound to the
  exact owning agent task and tab.
- Debug API credentials remain stable for the running app and fail clearly if
  their protected descriptor cannot be persisted, avoiding self-inflicted 401
  errors.
- Windows provider launchers preserve literal prompt characters when a CLI is
  installed through a command shim.

## [0.3.51] - 2026-08-10

### Improved

- Large Workspace, Browser, Settings, Connections, setup, Vault, and operational
  panels now open with less startup work. The interactive Terminal remains in
  the app and is preloaded when the user signals intent to open it.
- Plan, Preview, Vault Request Center, Vault status, transcript, and native
  event refreshes do less duplicate work, improving responsiveness during long
  sessions and while the app is idle.
- Browser Workflows, native form controls, connection status, and neighboring
  light/dark surfaces use the established compact ShellX hierarchy and clearer
  recovery states.
- The Agent CLI setup action now opens the environment-aware setup assistant
  and refreshes provider discovery for the active Local, WSL, or SSH target.
- Telegram and Discord Session chat can route bounded replies through supported
  Codex, Claude, Antigravity, and Grok sessions instead of treating
  provider-only tabs as disconnected.
- Long-running provider sessions retain bounded output and drain process streams
  more reliably.

### Fixed

- Recovery after a missed Debug UI event preserves whether the requested state
  belongs to the main app or ShellX Browser.
- The Projects rail keeps its add-project control visible and clickable at
  narrow widths, preserves an immediate expand/collapse action, and waits for
  saved project state before rendering it.
- Rapidly changing preview or search input no longer lets an older asynchronous
  result replace the current file state.
- Host filesystem tools resolve permitted WSL UNC paths against the correct
  containment boundary.

## [0.3.5] - 2026-08-09

### Added

- Native Windows OpenSSH connections can run Windows-installed Grok, Codex,
  Claude, and Antigravity CLIs with Windows paths and PowerShell-safe command
  transport; WSL is no longer required on the destination PC. A separate
  Windows OpenSSH + WSL runtime keeps agents and project commands inside an
  explicitly selected distro when that is the intended environment.
- ShellX Browser Flight Recorder can create bounded, redacted task-attempt
  evidence, show attempt/evaluation identities in the Evidence panel, and
  compare exact attempts without presenting incomplete or gapped evidence as a
  complete result.
- Provider Browser access now uses a compact two-tool gateway with bounded
  observations, explicit extraction, and batched page actions for lower
  context and round-trip cost.
- ShellX-launched agents receive session-scoped host guidance and only the
  bridge capabilities selected for that tab; direct CLI sessions remain
  independent of the ShellX skill and host MCP.
- Target-keyed provider inventory distinguishes local, WSL, SSH POSIX, native
  Windows, and Windows-to-WSL installations, including native Windows Grok and
  fresh pre-launch CLI versions.
- The integrated Vault client follows the current shared broker contracts and
  can queue exact operator-reviewed executable requests with selected Vault
  resources injected into the approved process environment.
- Agent runs can report provider timing, completed actions, token usage, and
  structured provider-native subagent identities when the provider exposes
  them; Session Tools separates provider-native capabilities from ShellX-hosted
  tools.
- Large application surfaces load on demand, and parent-host text reads are
  compact and pageable with exact continuation offsets.
- The synchronized ShellX manual now documents each persistent header, rail,
  Settings, bottom-panel, Command Palette action, Browser menu, and Browser
  side-panel surface separately, with an interactive highlight that switches
  to the corresponding open UI state.

### Fixed

- Bugfixes.

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
- The installer now bundles the \`shellx-host\` agent documentation into the
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
- Added Browser agent automation through \`/browser/*\`, including navigation,
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
  skip sensitive files during broad \`fs_grep\`, and block CGNAT
  \`100.64.0.0/10\` targets in \`net_fetch\`.
- Session Git commands now disable pager, credential-helper, SSH command,
  hooks, fsmonitor, and \`ext::\` protocol hooks in ShellX-managed Git probes.

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
  environment prefixes that fail under \`cmd.exe\`.

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
  distinguishing provider-native file tools from ShellX host \`fs_*\` tools.
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
  blank \`tool\` cards.
- Long \`/build\` runs keep in-flight Agent work tracked after wait-budget
  snapshots and clean up running Agent subagents when stopped.
- SSH folder browsing works against macOS targets that use BSD \`find\`.
- Generated asset lists no longer show regex/search patterns as phantom images.
- Legacy connection presets are imported into the ShellX data store when both
  old and new local data folders exist.
- SSH Grok sessions now find user-level \`uvx\`/\`npx\` launchers for marketplace
  MCP servers, so remote Fetch/Git tools do not appear missing when they live
  under \`~/.local/bin\` or an NVM/Homebrew path.
- macOS contributor source builds compile cleanly again (#1).

## [0.1.36] - 2026-06-02

### Added

- Files panel search stays pinned with the current folder while scrolling.
- Files tab can browse upward from the session folder, including WSL/SSH
  folder paths.
- Chat \`/\` autocomplete includes shellX \`/commands\` with input hints.
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
- Safe MCP tool names no longer appear as \`REDACTED\` in chat/tool
  diagnostics.
- WSL MCP launcher checks find user-level \`uvx\` installs under
  \`~/.local/bin\`.
- WSL Grok environment diagnostics use the same user-bin path lookup.
- SSH Grok environment diagnostics pass the ShellX MCP bearer through
  the remote stdin prelude, matching normal SSH sessions.
- Debug API \`/connect\` honors \`permissionMode\` so smoke and Build test
  sessions can start in auto-approve mode.
- Grok environment no longer shows generic API-key guidance when no
  API-key environment variable is configured.
- Build scratchboard paths no longer get hidden as \`REDACTED\` in chat
  streams.
- Bare Markdown names in chat diagnostics no longer open missing cwd
  preview files unless they are explicit paths or session artifacts.
- Async Build Agent runs now get a hard watchdog so zero-output
  reviewer/verifier subagents cannot run indefinitely.

## [0.1.35] - 2026-05-31

### Fixed

- Chat \`plan.md\` and \`goal.md\` links now open the active Grok session
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
  \`grok inspect\` counts, trace export, and Preview setup checks.
- Header connector inbox for Telegram and Discord bot messages, with
  allowlists, search, date filters, unread badges, and simulation tests.
- Telegram Session Chat replies for allowlisted direct chats, including
  text replies and referenced image outputs from the active/fixed tab.

### Changed

- \`/build\` is now the single public long-horizon command. Legacy \`/goal\`
  input is treated as a compatibility alias and new UI/docs teach
  \`/build\` only.
- \`/build\` can keep long-running Agent work alive after a wait budget
  expires instead of killing active work.
- xAI API-key guidance now prefers \`XAI_API_KEY\` and labels
  \`GROK_CODE_XAI_API_KEY\` as legacy.

## [0.1.32] - 2026-05-25

### Added

- Experimental \`/build\` mode with a dedicated Build Run cockpit,
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
- Session Trace now treats idle reconnect sessions as \`No file activity\`
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
- \`/goal\` autonomous task mode with live plan visibility, pause/resume
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
screenshot capture, voice mode, updater, and \`/goal\` orchestration were
tested together. Private beta notes are not part of the public
changelog.
`,T=`ShellX third-party notices
==========================

Bundled font software:

- Onest: Copyright 2021 The Onest Project Authors
  (https://github.com/simpals/onest)
- Geist Mono: Copyright (c) 2023 Vercel, in collaboration with
  basement.studio

Both font families are distributed under the SIL Open Font License, Version
1.1, reproduced below.

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The fonts,
including any derivative works, can be bundled, embedded, redistributed
and/or sold with any software provided that any reserved names are not used
by derivative works. The fonts and derivatives, however, cannot be released
under any other type of license. The requirement for fonts to remain under
this license does not apply to any document created using the fonts or their
derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may include
source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical writer or
other person who contributed to the Font Software.

PERMISSION AND CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a copy
of the Font Software, to use, study, copy, merge, embed, modify, redistribute,
and sell modified and unmodified copies of the Font Software, subject to the
following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy contains
the above copyright notice and this license. These can be included either as
stand-alone text files, human-readable headers or in the appropriate
machine-readable metadata fields within text or binary files as long as those
fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font Name(s)
unless explicit written permission is granted by the corresponding Copyright
Holder. This restriction only applies to the primary font name as presented
to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any Modified
Version, except to acknowledge the contribution(s) of the Copyright Holder(s)
and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be
distributed entirely under this license, and must not be distributed under
any other license. The requirement for fonts to remain under this license
does not apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT,
TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR
ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL,
INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO USE
THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.

Production dependency notices
-----------------------------

This notice lists the declared licenses for ShellX production dependencies in
the supported Windows, macOS, and Linux dependency graphs.

The npm closure below contains 133 production packages. The Cargo
rows contain 666 unique package/version/license/source records;
each lists the supported target graphs that include it. Build-only Cargo
dependencies are excluded.

NPM production dependency closure
---------------------------------

- @fontsource-variable/onest@5.2.11 — OFL-1.1
- @shikijs/core@1.29.2 — MIT
- @shikijs/engine-javascript@1.29.2 — MIT
- @shikijs/engine-oniguruma@1.29.2 — MIT
- @shikijs/langs@1.29.2 — MIT
- @shikijs/themes@1.29.2 — MIT
- @shikijs/types@1.29.2 — MIT
- @shikijs/vscode-textmate@10.0.2 — MIT
- @tauri-apps/api@2.11.1 — Apache-2.0 OR MIT
- @tauri-apps/plugin-dialog@2.7.2 — MIT OR Apache-2.0
- @tauri-apps/plugin-process@2.3.1 — MIT OR Apache-2.0
- @tauri-apps/plugin-updater@2.10.1 — MIT OR Apache-2.0
- @types/debug@4.1.13 — MIT
- @types/estree@1.0.8 — MIT
- @types/estree-jsx@1.0.5 — MIT
- @types/hast@3.0.4 — MIT
- @types/mdast@4.0.4 — MIT
- @types/ms@2.1.0 — MIT
- @types/prop-types@15.7.15 — MIT
- @types/react@18.3.28 — MIT
- @types/unist@2.0.11 — MIT
- @types/unist@3.0.3 — MIT
- @ungap/structured-clone@1.3.1 — ISC
- @xterm/addon-fit@0.11.0 — MIT
- @xterm/addon-web-links@0.12.0 — MIT
- bail@2.0.2 — MIT
- ccount@2.0.1 — MIT
- character-entities@2.0.2 — MIT
- character-entities-html4@2.1.0 — MIT
- character-entities-legacy@3.0.0 — MIT
- character-reference-invalid@2.0.1 — MIT
- comma-separated-tokens@2.0.3 — MIT
- csstype@3.2.3 — MIT
- debug@4.4.3 — MIT
- decode-named-character-reference@1.3.0 — MIT
- dequal@2.0.3 — MIT
- devlop@1.1.0 — MIT
- emoji-regex-xs@1.0.0 — MIT
- escape-string-regexp@5.0.0 — MIT
- estree-util-is-identifier-name@3.0.0 — MIT
- extend@3.0.2 — MIT
- hast-util-to-html@9.0.5 — MIT
- hast-util-to-jsx-runtime@2.3.6 — MIT
- hast-util-whitespace@3.0.0 — MIT
- html-url-attributes@3.0.1 — MIT
- html-void-elements@3.0.0 — MIT
- inline-style-parser@0.2.7 — MIT
- is-alphabetical@2.0.1 — MIT
- is-alphanumerical@2.0.1 — MIT
- is-decimal@2.0.1 — MIT
- is-hexadecimal@2.0.1 — MIT
- is-plain-obj@4.1.0 — MIT
- js-tokens@4.0.0 — MIT
- longest-streak@3.1.0 — MIT
- loose-envify@1.4.0 — MIT
- lucide-react@1.16.0 — ISC
- markdown-table@3.0.4 — MIT
- mdast-util-find-and-replace@3.0.2 — MIT
- mdast-util-from-markdown@2.0.3 — MIT
- mdast-util-gfm@3.1.0 — MIT
- mdast-util-gfm-autolink-literal@2.0.1 — MIT
- mdast-util-gfm-footnote@2.1.0 — MIT
- mdast-util-gfm-strikethrough@2.0.0 — MIT
- mdast-util-gfm-table@2.0.0 — MIT
- mdast-util-gfm-task-list-item@2.0.0 — MIT
- mdast-util-mdx-expression@2.0.1 — MIT
- mdast-util-mdx-jsx@3.2.0 — MIT
- mdast-util-mdxjs-esm@2.0.1 — MIT
- mdast-util-phrasing@4.1.0 — MIT
- mdast-util-to-hast@13.2.1 — MIT
- mdast-util-to-markdown@2.1.2 — MIT
- mdast-util-to-string@4.0.0 — MIT
- micromark@4.0.2 — MIT
- micromark-core-commonmark@2.0.3 — MIT
- micromark-extension-gfm@3.0.0 — MIT
- micromark-extension-gfm-autolink-literal@2.1.0 — MIT
- micromark-extension-gfm-footnote@2.1.0 — MIT
- micromark-extension-gfm-strikethrough@2.1.0 — MIT
- micromark-extension-gfm-table@2.1.1 — MIT
- micromark-extension-gfm-tagfilter@2.0.0 — MIT
- micromark-extension-gfm-task-list-item@2.1.0 — MIT
- micromark-factory-destination@2.0.1 — MIT
- micromark-factory-label@2.0.1 — MIT
- micromark-factory-space@2.0.1 — MIT
- micromark-factory-title@2.0.1 — MIT
- micromark-factory-whitespace@2.0.1 — MIT
- micromark-util-character@2.1.1 — MIT
- micromark-util-chunked@2.0.1 — MIT
- micromark-util-classify-character@2.0.1 — MIT
- micromark-util-combine-extensions@2.0.1 — MIT
- micromark-util-decode-numeric-character-reference@2.0.2 — MIT
- micromark-util-decode-string@2.0.1 — MIT
- micromark-util-encode@2.0.1 — MIT
- micromark-util-html-tag-name@2.0.1 — MIT
- micromark-util-normalize-identifier@2.0.1 — MIT
- micromark-util-resolve-all@2.0.1 — MIT
- micromark-util-sanitize-uri@2.0.1 — MIT
- micromark-util-subtokenize@2.1.0 — MIT
- micromark-util-symbol@2.0.1 — MIT
- micromark-util-types@2.0.2 — MIT
- ms@2.1.3 — MIT
- oniguruma-to-es@2.3.0 — MIT
- parse-entities@4.0.2 — MIT
- property-information@7.1.0 — MIT
- react@18.3.1 — MIT
- react-dom@18.3.1 — MIT
- react-markdown@9.1.0 — MIT
- react-resizable-panels@2.1.9 — MIT
- regex@5.1.1 — MIT
- regex-recursion@5.1.1 — MIT
- regex-utilities@2.3.0 — MIT
- remark-gfm@4.0.1 — MIT
- remark-parse@11.0.0 — MIT
- remark-rehype@11.1.2 — MIT
- remark-stringify@11.0.0 — MIT
- scheduler@0.23.2 — MIT
- shiki@1.29.2 — MIT
- space-separated-tokens@2.0.2 — MIT
- stringify-entities@4.0.4 — MIT
- style-to-js@1.1.21 — MIT
- style-to-object@1.0.14 — MIT
- trim-lines@3.0.1 — MIT
- trough@2.2.0 — MIT
- unified@11.0.5 — MIT
- unist-util-is@6.0.1 — MIT
- unist-util-position@5.0.0 — MIT
- unist-util-stringify-position@4.0.0 — MIT
- unist-util-visit@5.1.0 — MIT
- unist-util-visit-parents@6.0.2 — MIT
- vfile@6.0.3 — MIT
- vfile-message@4.0.3 — MIT
- xterm@5.3.0 — MIT
- zwitch@2.0.4 — MIT

Cargo normal dependency graphs
------------------------------

- adler2@2.0.1 — 0BSD OR MIT OR Apache-2.0; crates.io; linux,macos,windows
- aead@0.5.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- aes@0.8.4 — MIT OR Apache-2.0; crates.io; linux
- aho-corasick@1.1.4 — Unlicense OR MIT; crates.io; linux,macos,windows
- alloc-no-stdlib@2.0.4 — BSD-3-Clause; crates.io; linux,macos,windows
- alloc-stdlib@0.2.2 — BSD-3-Clause; crates.io; linux,macos,windows
- anstream@1.0.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- anstyle@1.0.14 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- anstyle-parse@1.0.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- anstyle-query@1.1.5 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- anstyle-wincon@3.0.11 — MIT OR Apache-2.0; crates.io; windows
- anyhow@1.0.103 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- arboard@3.6.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- argon2@0.5.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- arrayref@0.3.9 — BSD-2-Clause; crates.io; linux,macos,windows
- arrayvec@0.7.6 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- async-broadcast@0.5.1 — MIT OR Apache-2.0; crates.io; linux
- async-broadcast@0.7.2 — MIT OR Apache-2.0; crates.io; linux
- async-channel@2.5.0 — Apache-2.0 OR MIT; crates.io; linux
- async-executor@1.14.0 — Apache-2.0 OR MIT; crates.io; linux
- async-fs@1.6.0 — Apache-2.0 OR MIT; crates.io; linux
- async-io@1.13.0 — Apache-2.0 OR MIT; crates.io; linux
- async-io@2.6.0 — Apache-2.0 OR MIT; crates.io; linux
- async-lock@2.8.0 — Apache-2.0 OR MIT; crates.io; linux
- async-lock@3.4.2 — Apache-2.0 OR MIT; crates.io; linux
- async-process@2.5.0 — Apache-2.0 OR MIT; crates.io; linux
- async-recursion@1.1.1 — MIT OR Apache-2.0; crates.io; linux
- async-signal@0.2.14 — Apache-2.0 OR MIT; crates.io; linux
- async-task@4.7.1 — Apache-2.0 OR MIT; crates.io; linux
- async-trait@0.1.89 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- atk@0.18.2 — MIT; crates.io; linux
- atk-sys@0.18.2 — MIT; crates.io; linux
- atomic-waker@1.1.2 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- aws-lc-rs@1.18.1 — ISC AND (Apache-2.0 OR ISC); crates.io; linux,macos,windows
- aws-lc-sys@0.45.0 — ISC AND (Apache-2.0 OR ISC) AND Apache-2.0 AND MIT AND BSD-3-Clause AND (Apache-2.0 OR ISC OR MIT) AND (Apache-2.0 OR ISC OR MIT-0); crates.io; linux,macos,windows
- axum@0.7.9 — MIT; crates.io; linux,macos,windows
- axum@0.8.9 — MIT; crates.io; linux,macos,windows
- axum-core@0.4.5 — MIT; crates.io; linux,macos,windows
- axum-core@0.5.6 — MIT; crates.io; linux,macos,windows
- base64@0.21.7 — MIT OR Apache-2.0; crates.io; macos
- base64@0.22.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- base64ct@1.8.3 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- bit-set@0.8.0 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- bit-vec@0.8.0 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- bitflags@1.3.2 — MIT/Apache-2.0; crates.io; linux,macos,windows
- bitflags@2.13.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- blake2@0.10.6 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- blake3@1.8.5 — CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception; crates.io; linux,macos,windows
- block-buffer@0.10.4 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- block-padding@0.3.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- block2@0.6.2 — MIT; crates.io; macos
- blocking@1.6.2 — Apache-2.0 OR MIT; crates.io; linux
- brotli@8.0.2 — BSD-3-Clause AND MIT; crates.io; linux,macos,windows
- brotli-decompressor@5.0.0 — BSD-3-Clause/MIT; crates.io; linux,macos,windows
- bs58@0.5.1 — MIT/Apache-2.0; crates.io; linux,macos,windows
- bstr@1.12.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- bumpalo@3.20.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- bytemuck@1.25.0 — Zlib OR Apache-2.0 OR MIT; crates.io; linux,macos,windows
- bytemuck_derive@1.10.2 — Zlib OR Apache-2.0 OR MIT; crates.io; linux,macos,windows
- byteorder@1.5.0 — Unlicense OR MIT; crates.io; linux,macos,windows
- byteorder-lite@0.1.0 — Unlicense OR MIT; crates.io; linux,macos,windows
- bytes@1.11.1 — MIT; crates.io; linux,macos,windows
- cairo-rs@0.18.5 — MIT; crates.io; linux
- cairo-sys-rs@0.18.2 — MIT; crates.io; linux
- camino@1.2.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- cargo_metadata@0.19.2 — MIT; crates.io; linux,macos,windows
- cargo-platform@0.1.9 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- cbc@0.1.2 — MIT OR Apache-2.0; crates.io; linux
- cfb@0.7.3 — MIT; crates.io; linux,macos,windows
- cfg-if@1.0.4 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- chacha20@0.10.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- chacha20@0.9.1 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- chacha20poly1305@0.10.1 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- chrono@0.4.44 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- chrono-tz@0.10.4 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- cipher@0.4.4 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- clap@4.6.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- clap_builder@4.6.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- clap_derive@4.6.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- clap_lex@1.1.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- clipboard-win@5.4.1 — BSL-1.0; crates.io; windows
- cobs@0.3.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- colorchoice@1.0.5 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- concurrent-queue@2.5.0 — Apache-2.0 OR MIT; crates.io; linux
- const-random@0.1.18 — MIT OR Apache-2.0; crates.io; linux
- const-random-macro@0.1.16 — MIT OR Apache-2.0; crates.io; linux
- constant_time_eq@0.4.2 — CC0-1.0 OR MIT-0 OR Apache-2.0; crates.io; linux,macos,windows
- cookie@0.18.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- core-foundation@0.10.1 — MIT OR Apache-2.0; crates.io; macos
- core-foundation@0.9.4 — MIT OR Apache-2.0; crates.io; macos
- core-foundation-sys@0.8.7 — MIT OR Apache-2.0; crates.io; macos
- core-graphics@0.25.0 — MIT OR Apache-2.0; crates.io; macos
- core-graphics-types@0.2.0 — MIT OR Apache-2.0; crates.io; macos
- cpufeatures@0.2.17 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- cpufeatures@0.3.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- crc32fast@1.5.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- crossbeam-channel@0.5.15 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- crossbeam-deque@0.8.6 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- crossbeam-epoch@0.9.20 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- crossbeam-utils@0.8.21 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- crunchy@0.2.4 — MIT; crates.io; linux
- crypto-common@0.1.7 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- cssparser@0.36.0 — MPL-2.0; crates.io; linux,macos,windows
- cssparser-macros@0.6.1 — MPL-2.0; crates.io; linux,macos,windows
- ctor@0.8.0 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- ctor-proc-macro@0.0.7 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- curve25519-dalek@4.1.3 — BSD-3-Clause; crates.io; linux,macos,windows
- curve25519-dalek-derive@0.1.1 — MIT/Apache-2.0; crates.io; linux,macos,windows
- darling@0.23.0 — MIT; crates.io; linux,macos,windows
- darling_core@0.23.0 — MIT; crates.io; linux,macos,windows
- darling_macro@0.23.0 — MIT; crates.io; linux,macos,windows
- data-encoding@2.11.0 — MIT; crates.io; linux,macos,windows
- dbus@0.9.11 — Apache-2.0/MIT; crates.io; linux
- deranged@0.5.8 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- derivative@2.2.0 — MIT/Apache-2.0; crates.io; linux
- derive_more@2.1.1 — MIT; crates.io; linux,macos,windows
- derive_more-impl@2.1.1 — MIT; crates.io; linux,macos,windows
- digest@0.10.7 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- dirs@6.0.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- dirs-sys@0.5.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- dispatch2@0.3.1 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- displaydoc@0.2.5 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- dlopen2@0.8.2 — MIT; crates.io; linux
- dlopen2_derive@0.4.3 — MIT; crates.io; linux
- dlv-list@0.5.2 — MIT OR Apache-2.0; crates.io; linux
- dom_query@0.27.0 — MIT; crates.io; linux,macos,windows
- downcast-rs@1.2.1 — MIT/Apache-2.0; crates.io; linux,macos,windows
- dpi@0.1.2 — Apache-2.0 AND MIT; crates.io; linux,macos,windows
- dtoa@1.0.11 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- dtoa-short@0.3.5 — MPL-2.0; crates.io; linux,macos,windows
- dtor@0.3.0 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- dtor-proc-macro@0.0.6 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- dunce@1.0.5 — CC0-1.0 OR MIT-0 OR Apache-2.0; crates.io; linux,macos,windows
- dyn-clone@1.0.20 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- either@1.15.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- embed_plist@1.2.2 — MIT OR Apache-2.0; crates.io; macos
- embedded-io@0.4.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- embedded-io@0.6.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- encoding_rs@0.8.35 — (Apache-2.0 OR MIT) AND BSD-3-Clause; crates.io; linux,macos,windows
- endi@1.1.1 — MIT; crates.io; linux
- enumflags2@0.7.12 — MIT OR Apache-2.0; crates.io; linux
- enumflags2_derive@0.7.12 — MIT OR Apache-2.0; crates.io; linux
- equivalent@1.0.2 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- erased-serde@0.4.10 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- errno@0.3.14 — MIT OR Apache-2.0; crates.io; linux,macos
- error-code@3.3.2 — BSL-1.0; crates.io; windows
- event-listener@2.5.3 — Apache-2.0 OR MIT; crates.io; linux
- event-listener@5.4.2 — Apache-2.0 OR MIT; crates.io; linux
- event-listener-strategy@0.5.4 — Apache-2.0 OR MIT; crates.io; linux
- fallible-iterator@0.3.0 — MIT/Apache-2.0; crates.io; linux,macos,windows
- fallible-streaming-iterator@0.1.9 — MIT/Apache-2.0; crates.io; linux,macos,windows
- fastcdc@4.0.1 — MIT; crates.io; linux,macos,windows
- fastrand@1.9.0 — Apache-2.0 OR MIT; crates.io; linux
- fastrand@2.4.1 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- fax@0.2.7 — MIT; crates.io; linux,macos,windows
- fdeflate@0.3.7 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- fern@0.7.1 — MIT; crates.io; linux,macos,windows
- field-offset@0.3.6 — MIT OR Apache-2.0; crates.io; linux
- file-id@0.2.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- filedescriptor@0.8.3 — MIT; crates.io; linux,macos,windows
- filetime@0.2.29 — MIT/Apache-2.0; crates.io; linux,macos,windows
- flate2@1.1.9 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- fnv@1.0.7 — Apache-2.0 / MIT; crates.io; linux,macos,windows
- foldhash@0.2.0 — Zlib; crates.io; linux,macos,windows
- foreign-types@0.5.0 — MIT/Apache-2.0; crates.io; macos
- foreign-types-macros@0.2.3 — MIT/Apache-2.0; crates.io; macos
- foreign-types-shared@0.3.1 — MIT/Apache-2.0; crates.io; macos
- form_urlencoded@1.2.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- fs2@0.4.3 — MIT/Apache-2.0; crates.io; linux,macos,windows
- fsevent-sys@4.1.0 — MIT; crates.io; macos
- futures-channel@0.3.32 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- futures-core@0.3.32 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- futures-executor@0.3.32 — MIT OR Apache-2.0; crates.io; linux
- futures-io@0.3.32 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- futures-lite@1.13.0 — Apache-2.0 OR MIT; crates.io; linux
- futures-lite@2.6.1 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- futures-macro@0.3.32 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- futures-sink@0.3.32 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- futures-task@0.3.32 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- futures-util@0.3.32 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- gdk@0.18.2 — MIT; crates.io; linux
- gdk-pixbuf@0.18.5 — MIT; crates.io; linux
- gdk-pixbuf-sys@0.18.0 — MIT; crates.io; linux
- gdk-sys@0.18.2 — MIT; crates.io; linux
- gdkwayland-sys@0.18.2 — MIT; crates.io; linux
- gdkx11@0.18.2 — MIT; crates.io; linux
- gdkx11-sys@0.18.2 — MIT; crates.io; linux
- generic-array@0.14.7 — MIT; crates.io; linux,macos,windows
- gethostname@1.1.0 — Apache-2.0; crates.io; linux
- getrandom@0.2.17 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- getrandom@0.3.4 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- getrandom@0.4.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- gio@0.18.4 — MIT; crates.io; linux
- gio-sys@0.18.1 — MIT; crates.io; linux
- glib@0.18.5 — MIT; vendored:vendor/glib; linux
- glib-macros@0.18.5 — MIT; crates.io; linux
- glib-sys@0.18.1 — MIT; crates.io; linux
- glob@0.3.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- globset@0.4.18 — Unlicense OR MIT; crates.io; linux,macos,windows
- gobject-sys@0.18.0 — MIT; crates.io; linux
- gtk@0.18.2 — MIT; crates.io; linux
- gtk-sys@0.18.2 — MIT; crates.io; linux
- gtk3-macros@0.18.2 — MIT; crates.io; linux
- h2@0.4.16 — MIT; crates.io; linux,macos,windows
- half@2.7.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- hash32@0.2.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- hashbrown@0.12.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- hashbrown@0.14.5 — MIT OR Apache-2.0; crates.io; linux
- hashbrown@0.17.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- hashlink@0.12.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- heapless@0.7.17 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- heck@0.4.1 — MIT OR Apache-2.0; crates.io; linux
- heck@0.5.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- hex@0.4.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- hkdf@0.12.4 — MIT OR Apache-2.0; crates.io; linux
- hmac@0.12.1 — MIT OR Apache-2.0; crates.io; linux
- html5ever@0.38.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- http@1.4.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- http-body@1.0.1 — MIT; crates.io; linux,macos,windows
- http-body-util@0.1.3 — MIT; crates.io; linux,macos,windows
- http-range@0.1.5 — MIT; crates.io; linux,macos,windows
- http-range-header@0.4.2 — MIT; crates.io; linux,macos,windows
- httparse@1.10.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- httpdate@1.0.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- hyper@1.9.0 — MIT; crates.io; linux,macos,windows
- hyper-rustls@0.27.9 — Apache-2.0 OR ISC OR MIT; crates.io; linux,macos,windows
- hyper-util@0.1.20 — MIT; crates.io; linux,macos,windows
- iana-time-zone@0.1.65 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- ico@0.5.0 — MIT; crates.io; linux,macos,windows
- icu_collections@2.2.0 — Unicode-3.0; crates.io; linux,macos,windows
- icu_locale_core@2.2.0 — Unicode-3.0; crates.io; linux,macos,windows
- icu_normalizer@2.2.0 — Unicode-3.0; crates.io; linux,macos,windows
- icu_normalizer_data@2.2.0 — Unicode-3.0; crates.io; linux,macos,windows
- icu_properties@2.2.0 — Unicode-3.0; crates.io; linux,macos,windows
- icu_properties_data@2.2.0 — Unicode-3.0; crates.io; linux,macos,windows
- icu_provider@2.2.0 — Unicode-3.0; crates.io; linux,macos,windows
- ident_case@1.0.1 — MIT/Apache-2.0; crates.io; linux,macos,windows
- idna@1.1.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- idna_adapter@1.2.2 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- ignore@0.4.25 — Unlicense OR MIT; crates.io; linux,macos,windows
- image@0.25.10 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- indexmap@1.9.3 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- indexmap@2.14.0 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- infer@0.19.0 — MIT; crates.io; linux,macos,windows
- inotify@0.11.2 — ISC; crates.io; linux
- inotify@0.9.6 — ISC; crates.io; linux
- inotify-sys@0.1.5 — ISC; crates.io; linux
- inout@0.1.4 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- io-lifetimes@1.0.11 — Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT; crates.io; linux
- ioctl-rs@0.1.6 — MIT; crates.io; linux,macos
- ipnet@2.12.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- is_terminal_polyfill@1.70.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- itoa@1.0.18 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- javascriptcore-rs@1.1.2 — MIT; crates.io; linux
- javascriptcore-rs-sys@1.1.1 — MIT; crates.io; linux
- json-patch@3.0.1 — MIT/Apache-2.0; crates.io; linux,macos,windows
- jsonptr@0.6.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- keyboard-types@0.7.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- keyring@2.3.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- lazy_static@1.5.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- libappindicator@0.9.0 — Apache-2.0 OR MIT; crates.io; linux
- libappindicator-sys@0.9.0 — Apache-2.0 OR MIT; crates.io; linux
- libc@0.2.186 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- libdbus-sys@0.2.7 — Apache-2.0/MIT; crates.io; linux
- libloading@0.7.4 — ISC; crates.io; linux
- libsqlite3-sys@0.39.1 — MIT; crates.io; linux,macos,windows
- linux-keyutils@0.2.5 — Apache-2.0 OR MIT; crates.io; linux
- linux-raw-sys@0.12.1 — Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT; crates.io; linux
- linux-raw-sys@0.3.8 — Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT; crates.io; linux
- litemap@0.8.2 — Unicode-3.0; crates.io; linux,macos,windows
- lock_api@0.4.14 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- log@0.4.29 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- lru-slab@0.1.2 — MIT OR Apache-2.0 OR Zlib; crates.io; linux,macos,windows
- lz4_flex@0.13.1 — MIT; crates.io; linux,macos,windows
- mac-notification-sys@0.6.12 — MIT/Apache-2.0; crates.io; macos
- markup5ever@0.38.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- matchers@0.2.0 — MIT; crates.io; linux,macos,windows
- matchit@0.7.3 — MIT AND BSD-3-Clause; crates.io; linux,macos,windows
- matchit@0.8.4 — MIT AND BSD-3-Clause; crates.io; linux,macos,windows
- memchr@2.8.0 — Unlicense OR MIT; crates.io; linux,macos,windows
- memoffset@0.6.5 — MIT; crates.io; linux,macos,windows
- memoffset@0.7.1 — MIT; crates.io; linux
- memoffset@0.9.1 — MIT; crates.io; linux
- memory-serve@2.1.0 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- mime@0.3.17 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- mime_guess@2.0.5 — MIT; crates.io; linux,macos,windows
- minisign-verify@0.2.5 — MIT; crates.io; linux,macos,windows
- miniz_oxide@0.8.9 — MIT OR Zlib OR Apache-2.0; crates.io; linux,macos,windows
- mio@0.8.11 — MIT; crates.io; linux
- mio@1.2.0 — MIT; crates.io; linux,macos,windows
- moxcms@0.8.1 — BSD-3-Clause OR Apache-2.0; crates.io; linux,macos,windows
- muda@0.19.1 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- new_debug_unreachable@1.0.6 — MIT; crates.io; linux,macos,windows
- nix@0.25.1 — MIT; crates.io; linux,macos,windows
- nix@0.26.4 — MIT; crates.io; linux
- nix@0.27.1 — MIT; crates.io; linux,macos
- nix@0.31.3 — MIT; crates.io; macos
- notify@6.1.1 — CC0-1.0; crates.io; linux,macos,windows
- notify@8.2.0 — CC0-1.0; crates.io; linux,macos,windows
- notify-debouncer-full@0.7.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- notify-rust@4.17.0 — MIT/Apache-2.0; crates.io; linux,macos,windows
- notify-types@2.1.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- ntapi@0.4.3 — Apache-2.0 OR MIT; crates.io; windows
- nu-ansi-term@0.50.3 — MIT; crates.io; linux,macos,windows
- num@0.4.3 — MIT OR Apache-2.0; crates.io; linux
- num_threads@0.1.7 — MIT OR Apache-2.0; crates.io; linux,macos
- num-bigint@0.4.6 — MIT OR Apache-2.0; crates.io; linux
- num-complex@0.4.6 — MIT OR Apache-2.0; crates.io; linux
- num-conv@0.2.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- num-integer@0.1.46 — MIT OR Apache-2.0; crates.io; linux
- num-iter@0.1.45 — MIT OR Apache-2.0; crates.io; linux
- num-rational@0.4.2 — MIT OR Apache-2.0; crates.io; linux
- num-traits@0.2.19 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- objc2@0.6.4 — MIT; crates.io; macos
- objc2-app-kit@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-av-foundation@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-avf-audio@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-cloud-kit@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-core-audio@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-core-audio-types@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-core-data@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-core-foundation@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-core-graphics@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-core-image@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-core-media@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-core-text@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-core-video@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-encode@4.1.0 — MIT; crates.io; macos
- objc2-exception-helper@0.1.1 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-foundation@0.3.2 — MIT; crates.io; macos
- objc2-image-io@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-io-surface@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-media-toolbox@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-metal@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-osa-kit@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-quartz-core@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- objc2-web-kit@0.3.2 — Zlib OR Apache-2.0 OR MIT; crates.io; macos
- once_cell@1.21.4 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- once_cell_polyfill@1.70.2 — MIT OR Apache-2.0; crates.io; windows
- opaque-debug@0.3.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- openssl-probe@0.2.1 — MIT OR Apache-2.0; crates.io; linux
- option-ext@0.2.0 — MPL-2.0; crates.io; linux,macos,windows
- ordered-multimap@0.7.3 — MIT; crates.io; linux
- ordered-stream@0.2.0 — MIT OR Apache-2.0; crates.io; linux
- osakit@0.3.1 — MIT OR Apache-2.0; crates.io; macos
- pango@0.18.3 — MIT; crates.io; linux
- pango-sys@0.18.0 — MIT; crates.io; linux
- parking@2.2.1 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- parking_lot@0.12.5 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- parking_lot_core@0.9.12 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- password-hash@0.5.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- percent-encoding@2.3.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- phf@0.12.1 — MIT; crates.io; linux,macos,windows
- phf@0.13.1 — MIT; crates.io; linux,macos,windows
- phf_generator@0.13.1 — MIT; crates.io; linux,macos,windows
- phf_macros@0.13.1 — MIT; crates.io; linux,macos,windows
- phf_shared@0.12.1 — MIT; crates.io; linux,macos,windows
- phf_shared@0.13.1 — MIT; crates.io; linux,macos,windows
- pin-project-lite@0.2.17 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- pin-utils@0.1.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- piper@0.2.5 — MIT OR Apache-2.0; crates.io; linux
- plist@1.10.0 — MIT; crates.io; linux,macos,windows
- png@0.17.16 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- png@0.18.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- polling@2.8.0 — Apache-2.0 OR MIT; crates.io; linux
- polling@3.11.0 — Apache-2.0 OR MIT; crates.io; linux
- poly1305@0.8.0 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- portable-pty@0.8.1 — MIT; crates.io; linux,macos,windows
- postcard@1.1.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- potential_utf@0.1.5 — Unicode-3.0; crates.io; linux,macos,windows
- powerfmt@0.2.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- ppv-lite86@0.2.21 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- precomputed-hash@0.1.1 — MIT; crates.io; linux,macos,windows
- proc-macro-crate@1.3.1 — MIT OR Apache-2.0; crates.io; linux
- proc-macro-crate@2.0.2 — MIT OR Apache-2.0; crates.io; linux
- proc-macro-crate@3.5.0 — MIT OR Apache-2.0; crates.io; linux
- proc-macro-error@1.0.4 — MIT OR Apache-2.0; crates.io; linux
- proc-macro-error-attr@1.0.4 — MIT OR Apache-2.0; crates.io; linux
- proc-macro2@1.0.106 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- pxfm@0.1.29 — BSD-3-Clause OR Apache-2.0; crates.io; linux,macos,windows
- quick-error@2.0.1 — MIT/Apache-2.0; crates.io; linux,macos,windows
- quick-xml@0.41.0 — MIT; crates.io; linux,macos,windows
- quinn@0.11.9 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- quinn-proto@0.11.19 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- quinn-udp@0.5.16 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- quote@1.0.45 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- rand@0.10.4 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- rand@0.8.6 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- rand@0.9.4 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- rand_chacha@0.3.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- rand_chacha@0.9.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- rand_core@0.10.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- rand_core@0.6.4 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- rand_core@0.9.5 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- rand_pcg@0.10.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- raw-window-handle@0.6.2 — MIT OR Apache-2.0 OR Zlib; crates.io; linux,macos,windows
- rayon@1.12.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- rayon-core@1.13.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- ref-cast@1.0.25 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- ref-cast-impl@1.0.25 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- regex@1.12.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- regex-automata@0.4.14 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- regex-syntax@0.8.10 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- reqwest@0.12.28 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- reqwest@0.13.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- rfd@0.16.0 — MIT; crates.io; linux,macos,windows
- ring@0.17.14 — Apache-2.0 AND ISC; crates.io; linux,macos,windows
- rpassword@7.5.4 — Apache-2.0; crates.io; linux,macos,windows
- rtoolbox@0.0.5 — Apache-2.0; crates.io; linux,macos,windows
- rusqlite@0.41.1 — MIT; crates.io; linux,macos,windows
- rust-ini@0.21.3 — MIT; crates.io; linux
- rustc-hash@2.1.2 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- rustix@0.37.28 — Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT; crates.io; linux
- rustix@1.1.6 — Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT; crates.io; linux,macos
- rustls@0.23.46 — Apache-2.0 OR ISC OR MIT; crates.io; linux,macos,windows
- rustls-native-certs@0.8.3 — Apache-2.0 OR ISC OR MIT; crates.io; linux
- rustls-pki-types@1.14.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- rustls-platform-verifier@0.7.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- rustls-webpki@0.103.16 — ISC; crates.io; linux,macos,windows
- rustversion@1.0.22 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- ryu@1.0.23 — Apache-2.0 OR BSL-1.0; crates.io; linux,macos,windows
- same-file@1.0.6 — Unlicense/MIT; crates.io; linux,macos,windows
- schemars@0.8.22 — MIT; crates.io; linux,macos,windows
- schemars@0.9.0 — MIT; crates.io; linux,macos,windows
- schemars@1.2.1 — MIT; crates.io; linux,macos,windows
- schemars_derive@0.8.22 — MIT; crates.io; linux,macos,windows
- scopeguard@1.2.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- secret-service@3.1.0 — MIT OR Apache-2.0; crates.io; linux
- security-framework@2.11.1 — MIT OR Apache-2.0; crates.io; macos
- security-framework@3.7.0 — MIT OR Apache-2.0; crates.io; macos
- security-framework-sys@2.17.0 — MIT OR Apache-2.0; crates.io; macos
- selectors@0.36.1 — MPL-2.0; crates.io; linux,macos,windows
- semver@1.0.28 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- serde@1.0.228 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- serde_core@1.0.228 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- serde_derive@1.0.228 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- serde_derive_internals@0.29.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- serde_json@1.0.149 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- serde_path_to_error@0.1.20 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- serde_repr@0.1.20 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- serde_spanned@0.6.9 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- serde_spanned@1.1.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- serde_urlencoded@0.7.1 — MIT/Apache-2.0; crates.io; linux,macos,windows
- serde_with@3.21.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- serde_with_macros@3.21.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- serde-untagged@0.1.9 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- serial@0.4.0 — MIT; crates.io; linux,macos,windows
- serial-core@0.4.0 — MIT; crates.io; linux,macos,windows
- serial-unix@0.4.0 — MIT; crates.io; linux,macos
- serial-windows@0.4.0 — MIT; crates.io; windows
- serialize-to-javascript@0.1.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- serialize-to-javascript-impl@0.1.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- servo_arc@0.4.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- sha1@0.10.6 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- sha2@0.10.9 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- sha256@1.6.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- sharded-slab@0.1.7 — MIT; crates.io; linux,macos,windows
- shared_library@0.1.9 — Apache-2.0/MIT; crates.io; windows
- shell-words@1.1.1 — MIT/Apache-2.0; crates.io; linux,macos,windows
- signal-hook-registry@1.4.8 — MIT OR Apache-2.0; crates.io; linux,macos
- simd-adler32@0.3.9 — MIT; crates.io; linux,macos,windows
- siphasher@1.0.3 — MIT/Apache-2.0; crates.io; linux,macos,windows
- slab@0.4.12 — MIT; crates.io; linux,macos,windows
- smallvec@1.15.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- socket2@0.4.10 — MIT OR Apache-2.0; crates.io; linux
- socket2@0.6.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- softbuffer@0.4.8 — MIT OR Apache-2.0; crates.io; windows
- soup3@0.5.0 — MIT; crates.io; linux
- soup3-sys@0.5.0 — MIT; crates.io; linux
- spin@0.9.8 — MIT; crates.io; linux,macos,windows
- stable_deref_trait@1.2.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- static_assertions@1.1.0 — MIT OR Apache-2.0; crates.io; linux
- string_cache@0.9.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- strsim@0.11.1 — MIT; crates.io; linux,macos,windows
- subtle@2.6.1 — BSD-3-Clause; crates.io; linux,macos,windows
- swift-rs@1.0.7 — MIT OR Apache-2.0; crates.io; macos
- syn@1.0.109 — MIT OR Apache-2.0; crates.io; linux
- syn@2.0.117 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- syn@3.0.10 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- sync_wrapper@1.0.2 — Apache-2.0; crates.io; linux,macos,windows
- synstructure@0.13.2 — MIT; crates.io; linux,macos,windows
- sysinfo@0.30.13 — MIT; crates.io; linux,macos,windows
- system-configuration@0.7.0 — MIT OR Apache-2.0; crates.io; macos
- system-configuration-sys@0.6.0 — MIT OR Apache-2.0; crates.io; macos
- tao@0.35.2 — Apache-2.0; vendored:vendor/tao-0.35.2; linux,macos,windows
- tar@0.4.46 — MIT OR Apache-2.0; crates.io; linux,macos
- tauri@2.11.5 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- tauri-codegen@2.6.3 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- tauri-macros@2.6.3 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- tauri-plugin-deep-link@2.4.9 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- tauri-plugin-dialog@2.7.2 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- tauri-plugin-fs@2.5.1 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- tauri-plugin-log@2.9.0 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- tauri-plugin-notification@2.3.3 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- tauri-plugin-process@2.3.1 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- tauri-plugin-single-instance@2.4.2 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- tauri-plugin-updater@2.10.1 — Apache-2.0 OR MIT; vendored:vendor/tauri-plugin-updater-2.10.1; linux,macos,windows
- tauri-runtime@2.11.3 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- tauri-runtime-wry@2.11.4 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- tauri-utils@2.9.3 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- tauri-winrt-notification@0.7.2 — MIT OR Apache-2.0; vendored:vendor/tauri-winrt-notification; windows
- tempfile@3.27.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- tendril@0.5.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- termios@0.2.2 — MIT; crates.io; linux,macos
- thiserror@1.0.69 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- thiserror@2.0.21 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- thiserror-impl@1.0.69 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- thiserror-impl@2.0.21 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- thread_local@1.1.9 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- tiff@0.11.3 — MIT; crates.io; linux,macos,windows
- time@0.3.47 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- time-core@0.1.8 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- time-macros@0.2.27 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- tiny-keccak@2.0.2 — CC0-1.0; crates.io; linux
- tinystr@0.8.3 — Unicode-3.0; crates.io; linux,macos,windows
- tinyvec@1.11.0 — Zlib OR Apache-2.0 OR MIT; crates.io; linux,macos,windows
- tinyvec_macros@0.1.1 — MIT OR Apache-2.0 OR Zlib; crates.io; linux,macos,windows
- tokio@1.53.3 — MIT; crates.io; linux,macos,windows
- tokio-macros@2.7.0 — MIT; crates.io; linux,macos,windows
- tokio-rustls@0.26.4 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- tokio-tungstenite@0.24.0 — MIT; crates.io; linux,macos,windows
- tokio-util@0.7.18 — MIT; crates.io; linux,macos,windows
- toml@0.8.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- toml@0.9.12+spec-1.1.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- toml_datetime@0.6.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- toml_datetime@0.7.5+spec-1.1.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- toml_datetime@1.1.1+spec-1.1.0 — MIT OR Apache-2.0; crates.io; linux
- toml_edit@0.19.15 — MIT OR Apache-2.0; crates.io; linux
- toml_edit@0.20.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- toml_edit@0.25.11+spec-1.1.0 — MIT OR Apache-2.0; crates.io; linux
- toml_parser@1.1.2+spec-1.1.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- toml_writer@1.1.1+spec-1.1.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- tower@0.5.3 — MIT; crates.io; linux,macos,windows
- tower-http@0.5.2 — MIT; crates.io; linux,macos,windows
- tower-http@0.6.10 — MIT; crates.io; linux,macos,windows
- tower-layer@0.3.3 — MIT; crates.io; linux,macos,windows
- tower-service@0.3.3 — MIT; crates.io; linux,macos,windows
- tracing@0.1.44 — MIT; crates.io; linux,macos,windows
- tracing-attributes@0.1.31 — MIT; crates.io; linux,macos,windows
- tracing-core@0.1.36 — MIT; crates.io; linux,macos,windows
- tracing-log@0.2.0 — MIT; crates.io; linux,macos,windows
- tracing-subscriber@0.3.23 — MIT; crates.io; linux,macos,windows
- tray-icon@0.24.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- try-lock@0.2.5 — MIT; crates.io; linux,macos,windows
- tungstenite@0.24.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- twox-hash@2.1.2 — MIT; crates.io; linux,macos,windows
- typed-path@0.13.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- typeid@1.0.3 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- typenum@1.20.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- unic-char-property@0.9.0 — MIT/Apache-2.0; crates.io; linux,macos,windows
- unic-char-range@0.9.0 — MIT/Apache-2.0; crates.io; linux,macos,windows
- unic-common@0.9.0 — MIT/Apache-2.0; crates.io; linux,macos,windows
- unic-ucd-ident@0.9.0 — MIT/Apache-2.0; crates.io; linux,macos,windows
- unic-ucd-version@0.9.0 — MIT/Apache-2.0; crates.io; linux,macos,windows
- unicase@2.9.0 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- unicode-ident@1.0.24 — (MIT OR Apache-2.0) AND Unicode-3.0; crates.io; linux,macos,windows
- unicode-segmentation@1.13.2 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- universal-hash@0.5.1 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- untrusted@0.9.0 — ISC; crates.io; linux,macos,windows
- url@2.5.8 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- urlencoding@2.1.3 — MIT; crates.io; linux,macos,windows
- urlpattern@0.3.0 — MIT; crates.io; linux,macos,windows
- utf-8@0.7.6 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- utf8_iter@1.0.4 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- utf8parse@0.2.2 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- uuid@1.23.1 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- vault-broker@0.1.0 — MIT; vendored:vendor/shellx-vault/crates/vault-broker; linux,macos,windows
- vault-client@0.1.0 — MIT; vendored:vendor/shellx-vault/crates/vault-client; linux,macos,windows
- vault-core@0.1.0 — MIT; vendored:vendor/shellx-vault/crates/vault-core; linux,macos,windows
- vault-server@0.1.0 — MIT; vendored:vendor/shellx-vault/crates/vault-server; linux,macos,windows
- waker-fn@1.2.0 — Apache-2.0 OR MIT; crates.io; linux
- walkdir@2.5.0 — Unlicense/MIT; crates.io; linux,macos,windows
- want@0.3.1 — MIT; crates.io; linux,macos,windows
- web_atoms@0.2.4 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- webkit2gtk@2.0.2 — MIT; crates.io; linux
- webkit2gtk-sys@2.0.2 — MIT; crates.io; linux
- webpki-roots@0.26.11 — CDLA-Permissive-2.0; crates.io; linux,macos,windows
- webpki-roots@1.0.10 — CDLA-Permissive-2.0; crates.io; linux,macos,windows
- webview2-com@0.38.2 — MIT; crates.io; windows
- webview2-com-macros@0.8.1 — MIT; crates.io; windows
- webview2-com-sys@0.38.2 — MIT; crates.io; windows
- weezl@0.1.12 — MIT OR Apache-2.0; crates.io; linux,macos,windows
- winapi@0.3.9 — MIT/Apache-2.0; crates.io; windows
- winapi-util@0.1.11 — Unlicense OR MIT; crates.io; windows
- window-vibrancy@0.6.0 — Apache-2.0 OR MIT; crates.io; macos,windows
- windows@0.52.0 — MIT OR Apache-2.0; crates.io; windows
- windows@0.58.0 — MIT OR Apache-2.0; crates.io; windows
- windows@0.61.3 — MIT OR Apache-2.0; crates.io; windows
- windows_x86_64_msvc@0.48.5 — MIT OR Apache-2.0; crates.io; windows
- windows_x86_64_msvc@0.52.6 — MIT OR Apache-2.0; crates.io; windows
- windows_x86_64_msvc@0.53.1 — MIT OR Apache-2.0; crates.io; windows
- windows-collections@0.2.0 — MIT OR Apache-2.0; crates.io; windows
- windows-core@0.52.0 — MIT OR Apache-2.0; crates.io; windows
- windows-core@0.58.0 — MIT OR Apache-2.0; crates.io; windows
- windows-core@0.61.2 — MIT OR Apache-2.0; crates.io; windows
- windows-future@0.2.1 — MIT OR Apache-2.0; crates.io; windows
- windows-implement@0.58.0 — MIT OR Apache-2.0; crates.io; windows
- windows-implement@0.60.2 — MIT OR Apache-2.0; crates.io; windows
- windows-interface@0.58.0 — MIT OR Apache-2.0; crates.io; windows
- windows-interface@0.59.3 — MIT OR Apache-2.0; crates.io; windows
- windows-link@0.1.3 — MIT OR Apache-2.0; crates.io; windows
- windows-link@0.2.1 — MIT OR Apache-2.0; crates.io; windows
- windows-numerics@0.2.0 — MIT OR Apache-2.0; crates.io; windows
- windows-registry@0.5.3 — MIT OR Apache-2.0; crates.io; windows
- windows-registry@0.6.1 — MIT OR Apache-2.0; crates.io; windows
- windows-result@0.2.0 — MIT OR Apache-2.0; crates.io; windows
- windows-result@0.3.4 — MIT OR Apache-2.0; crates.io; windows
- windows-result@0.4.1 — MIT OR Apache-2.0; crates.io; windows
- windows-strings@0.1.0 — MIT OR Apache-2.0; crates.io; windows
- windows-strings@0.4.2 — MIT OR Apache-2.0; crates.io; windows
- windows-strings@0.5.1 — MIT OR Apache-2.0; crates.io; windows
- windows-sys@0.48.0 — MIT OR Apache-2.0; crates.io; windows
- windows-sys@0.52.0 — MIT OR Apache-2.0; crates.io; windows
- windows-sys@0.59.0 — MIT OR Apache-2.0; crates.io; windows
- windows-sys@0.60.2 — MIT OR Apache-2.0; crates.io; windows
- windows-sys@0.61.2 — MIT OR Apache-2.0; crates.io; windows
- windows-targets@0.48.5 — MIT OR Apache-2.0; crates.io; windows
- windows-targets@0.52.6 — MIT OR Apache-2.0; crates.io; windows
- windows-targets@0.53.5 — MIT OR Apache-2.0; crates.io; windows
- windows-threading@0.1.0 — MIT OR Apache-2.0; crates.io; windows
- windows-version@0.1.7 — MIT OR Apache-2.0; crates.io; windows
- winnow@0.5.40 — MIT; crates.io; linux,macos,windows
- winnow@0.7.15 — MIT; crates.io; linux,macos,windows
- winnow@1.0.3 — MIT; crates.io; linux,macos,windows
- winreg@0.10.1 — MIT; crates.io; windows
- writeable@0.6.3 — Unicode-3.0; crates.io; linux,macos,windows
- wry@0.55.1 — Apache-2.0 OR MIT; vendored:vendor/wry-0.55.1; linux,macos,windows
- x11@2.21.0 — MIT; crates.io; linux
- x11-dl@2.21.0 — MIT; crates.io; linux
- x11rb@0.13.2 — MIT OR Apache-2.0; crates.io; linux
- x11rb-protocol@0.13.2 — MIT OR Apache-2.0; crates.io; linux
- x25519-dalek@2.0.1 — BSD-3-Clause; crates.io; linux,macos,windows
- xattr@1.6.1 — MIT OR Apache-2.0; crates.io; linux,macos
- xcap@0.1.1 — Apache-2.0; crates.io; linux,windows
- xcap@0.9.5 — Apache-2.0; crates.io; macos
- xcb@1.7.1 — MIT; crates.io; linux
- xdg-home@1.3.0 — MIT; crates.io; linux
- yoke@0.8.2 — Unicode-3.0; crates.io; linux,macos,windows
- yoke-derive@0.8.2 — Unicode-3.0; crates.io; linux,macos,windows
- zbus@3.15.2 — MIT; crates.io; linux
- zbus@5.15.0 — MIT; crates.io; linux
- zbus_macros@3.15.2 — MIT; crates.io; linux
- zbus_macros@5.15.0 — MIT; crates.io; linux
- zbus_names@2.6.1 — MIT; crates.io; linux
- zbus_names@4.3.2 — MIT; crates.io; linux
- zerocopy@0.8.48 — BSD-2-Clause OR Apache-2.0 OR MIT; crates.io; linux,macos,windows
- zerocopy-derive@0.8.48 — BSD-2-Clause OR Apache-2.0 OR MIT; crates.io; linux,macos,windows
- zerofrom@0.1.8 — Unicode-3.0; crates.io; linux,macos,windows
- zerofrom-derive@0.1.7 — Unicode-3.0; crates.io; linux,macos,windows
- zeroize@1.8.2 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- zeroize_derive@1.4.3 — Apache-2.0 OR MIT; crates.io; linux,macos,windows
- zerotrie@0.2.4 — Unicode-3.0; crates.io; linux,macos,windows
- zerovec@0.11.6 — Unicode-3.0; crates.io; linux,macos,windows
- zerovec-derive@0.11.3 — Unicode-3.0; crates.io; linux,macos,windows
- zip@9.4.1 — MIT; crates.io; linux,macos,windows
- zlib-rs@0.6.8 — Zlib; crates.io; linux,macos,windows
- zmij@1.0.21 — MIT; crates.io; linux,macos,windows
- zopfli@0.8.3 — Apache-2.0; crates.io; linux,macos,windows
- zune-core@0.5.1 — MIT OR Apache-2.0 OR Zlib; crates.io; linux,macos,windows
- zune-jpeg@0.5.15 — MIT OR Apache-2.0 OR Zlib; crates.io; linux,macos,windows
- zvariant@3.15.2 — MIT; crates.io; linux
- zvariant@5.11.0 — MIT; crates.io; linux
- zvariant_derive@3.15.2 — MIT; crates.io; linux
- zvariant_derive@5.11.0 — MIT; crates.io; linux
- zvariant_utils@1.0.1 — MIT; crates.io; linux
- zvariant_utils@3.3.1 — MIT; crates.io; linux
`,I=`# ShellX features

ShellX is a desktop client for Grok Build, Claude Code, Codex CLI,
Antigravity CLI, and other ACP-compatible agents. It combines chat,
projects, tools, previews, Git, and local automation in one app.

---

## Chat and sessions

- Multi-tab agent chat with one working folder and connection per tab.
- Persistent chat history with search and archived past sessions.
- Markdown file links open in ShellX; external links open in the browser.
- Tool output, diffs, terminals, generated images, and generated videos
  render inside the conversation.
- File picker, paste, drag/drop, screenshots, and Send to ShellX create
  attachment chips instead of raw paths in the composer.
- The **Assets** button opens pending attachments plus session images and
  videos in one board.
- On Windows, **Settings -> Desktop** can install **Send to ShellX** as
  a right-click menu item and SendTo shortcut for selected files.
- Select text and release the mouse to copy it.

## Connections

- Local Windows sessions.
- WSL sessions with Linux path handling.
- SSH sessions to Linux, macOS, or WSL targets with the ShellX host toolset
  tunneled to the remote environment.
- Native Windows OpenSSH can run Windows-installed CLI agents directly with
  PowerShell commands and Windows paths. WSL is not required.
- Windows OpenSSH can also launch the tab inside an explicitly selected WSL
  distro. This keeps one Linux path frame for agents, files, previews, and Git.

Switch connection per tab from the composer footer.

## Build Mode

\`/build "make this project production-ready"\` starts a long-running
build workflow. ShellX keeps the scratchboard, receipts, checkpoints,
review/verifier gates, and completion state visible in the Plan tab.

Use \`/pause\`, \`/resume\`, and \`/stop\` while a build is running.

## Work Preview

- Run generated static HTML, Node web apps, and Expo web apps from the
  Preview tab. The visual result opens in Preview Center.
- Clickable HTML file links open Preview Center and start a static Work
  Preview when the desktop host is available.
- Preview servers bind to loopback only.
- Preview logs stay in the right rail.
- Preview Doctor checks HTTP status, process logs, and first-page
  screenshots. Static previews can also surface browser errors.
- For interactive web or Expo apps, agents must also exercise important
  in-app tabs/buttons and inspect screenshots; a first-page Preview
  Doctor pass is not a full app-flow pass.
- Agents should start preview gates with host MCP \`preview_start\`, then
  run \`preview_diagnose\`; shell subagent dev servers are not accepted as
  Work Preview evidence.
- Ask Fix sends the preview failure context back to the active agent.

## Tools and environment health

- The Tools tab shows MCP health for the active environment.
- Grok tabs show MCP doctor and \`grok inspect\` diagnostics; provider
  tabs show CLI readiness, ShellX MCP availability, trace state, and
  Preview setup checks.
- Environment readiness lists missing Local/WSL/SSH commands and the ShellX
  feature each one affects, so agents can explain preview/tool failures without
  re-discovering basic tooling.
- Search capability status shows when Grok Web Search, Web Fetch, or
  ShellX X Search are available.
- The Plugins button manages curated MCP connectors and required keys.

## Files, Git, and Trace

- Files tab browses the active project folder.
- File preview supports markdown, code/config files, images, video, and
  PDF.
- Git tab shows status, diffs, local checkpoints, and worktree creation.
- GitHub picker can surface PRs and issues from connected repositories.
- Trace opens file/search/write/delete activity and generated media
  references when the session exposes enough detail.
- Download all creates a workspace zip for hand-off or backup.

## Vault and host tools

- Encrypted local vault for API keys and tokens.
- Agent access to approved host tools: filesystem, process management,
  screenshots, vision, network fetch, memory, and subagents.
- Agents can call \`capabilities_summary\` for a compact current tool map.
  For mutating/tab-aware host tools, the \`shellx-host-http__\` prefix is
  preferred when advertised; \`grok-shell-host__\` remains the read-only or
  local fallback.
- Use the active agent's native file/edit tools for routine project edits in
  the selected local, WSL, or SSH cwd. Host \`fs_*\` always runs on the ShellX
  parent host filesystem, even from remote provider tabs; use it for explicit
  Windows/parent-host paths, atomic or binary file operations, file watching,
  copy/delete helpers, and permission/audit-sensitive host mutations.
- Secrets retrieved from the vault are not echoed in chat.

## Native Browser

- ShellX Browser keeps authenticated web work, profiles, task ownership,
  approvals, and receipts inside the local desktop workspace.
- Task Disposable tabs use separate per-task web storage. Finishing or aborting
  the task, or closing its tab, retires that storage so the next disposable task
  starts empty.
- Links, folders, toolbar pins, and workflow bookmarks persist across ShellX
  restarts. History keeps User and Agent scopes separate, and clearing All
  requires a dedicated confirmation.
- Handing a tab to an agent opens an owned review of the sanitized page context,
  profile persistence, current owner, selected task, and separate Vault
  boundary before the transfer.
- Evidence can record one bounded, redacted task attempt and show its exact
  identity, completeness, hash, and comparison receipts without displaying
  private artifact paths.
- **Teach workflow** keeps the most recent complete recorded attempt available
  after its task completes and turns it into an editable, evidence-bound recipe
  draft. Saving creates an immutable revision, approval creates but does not
  run the recipe, and rehearsal is a dry run with zero applied steps. A
  zero-skip rehearsal can open a paused Task draft in the main workspace with
  the exact workflow digest and required Vault key identities for review.
- **Developer inspection** stays attached to the live task and summarizes the
  current page's document checks, console, network, performance, and
  deterministic issues. Separate HAR and performance exports return compact
  receipt identities in the UI.

## Voice and media

- Voice input through Grok STT.
- Optional voice replies when your account supports the needed audio
  path.
- Grok Imagine images and videos render inline when available on your
  Grok account.
- Attachment & Media Board lets you inspect, summarize, find in, or
  preview attached files and generated media from the current session.

## Connectors

- Telegram direct messages can route to the connector inbox or a target
  ShellX session when allowlisted.
- Telegram Session Chat can send active-session text replies and referenced
  image outputs back to the chat.
- Discord bot messages can route to the connector inbox or an eligible target
  ShellX session when allowlisted.
- Connector setup includes credential tests, allowlists, target session
  rules, and inbound simulation.

## Tasks and API

- The header Tasks button opens the first-class Task Manager for one-time or
  recurring agent work. Ask an agent to set up, schedule, or set up and run a
  Task and ShellX can prepare the complete definition from that conversation.
  The Tasks panel opens as a compact review and results surface; Edit details
  reveals the full form only when you want it. Create Task below the composer
  remains available for attachment- or workflow-backed drafts.
- Date and time pickers follow the execution computer's local clock by default.
  Timezone pinning, missed-run behavior, per-run safety limits, and notification
  policy remain in Advanced timing and notifications.
- Each run is bound to one immutable revision and one saved environment, then
  checked against a fresh provider catalogue before work starts. Run history,
  fallback decisions, unresolved attention, exact-session Open run, and
  exact-attempt Cancel run use bounded receipts rather than provider output.
- Saved Browser workflow and Vault references are revalidated before dispatch.
  ShellX passes only reviewed identities and digests to eligible agents; recipe
  paths and raw Vault values stay out of prompts and Task receipts.
- Visible composer attachments are copied only when you choose Create Task.
  ShellX verifies private, content-addressed copies on the exact execution
  target and shows their durable IDs and digests for review in Task Manager;
  original paths and file contents stay out of Task records and receipts.
  Closing an unsaved draft, or saving after removing an import, reclaims only
  never-saved exact copies through a retryable two-phase receipt; startup
  maintenance resumes a bounded pending/stale batch after interruption.
- Teach-created Task drafts start paused with no provider route selected. Task
  Manager shows the workflow binding and lets you select only active mediated
  Vault grants before enabling and saving the schedule.
- Optional desktop notifications appear only after a durable terminal result;
  each Task can choose attention-only or every-result notifications.
- The right-rail live process monitor remains available for CPU, memory, latest
  output, health counters, report copy, agent diagnostics, and stop controls.
- The shellXagent API exposes app state, prompts, screenshots, previews,
  settings, Vault actions, first-class Task state/actions, build state, and
  diagnostics over loopback.
- API access uses a private per-user bearer resolved internally by ShellX-owned clients.
  A custom Debug API bearer is trusted local operator access; agent-specific
  routes retain their own caller and intent checks.
- The updater checks signed release manifests and offers in-app updates
  when a published release is available.

## Skills / slash commands

Type \`/\` in the composer for ShellX-local commands and the active
agent's advertised commands. Provider tabs only show commands that are
available in the selected environment; they do not inherit stale Grok
commands from other tabs.
Custom Grok skills under \`~/.grok/skills/\` are loaded on Grok session
start. ShellX does not install its host guidance there: agents launched by
ShellX receive compact session rules and the host MCP surface, while direct
CLI sessions remain unchanged. The full reference copy lives under
\`~/.shellx/agent-docs/\` and the authenticated Debug API.
When Grok advertises upstream skills such as \`/check-work\`,
\`/best-of-n\`, or \`/execute-plan\`, treat them as manual commands; ShellX
\`/build\` uses its own Agent receipts for release-grade gates.

---

## Keyboard

| Shortcut       | Action                          |
|----------------|---------------------------------|
| Enter          | Send prompt                     |
| Shift+Enter    | Newline                         |
| Ctrl+C         | Abort current turn              |
| Ctrl+K         | Open command palette            |
| Ctrl+,         | Open Settings                   |
| Esc            | Close modal / cancel            |
| /              | Slash-command picker            |
| #              | PR / issue picker               |

---

## Where things live

- Config + sessions: \`%USERPROFILE%\\.shellx\\\` (Windows),
  \`~/.shellx/\` (Linux / macOS)
- Vault profile: the platform application-config directory's
  \`shellx-vault/profile.json\`; **Settings → Vault** shows the active profile.
  Legacy \`<config>/vault.enc\` is import-only.
- Grok auth token: \`~/.grok/auth.json\`

Use **Settings → Data** to manage projects, session names, and
caches per item.
`,g=`# ShellX — quick start

## Install

1. Download the latest installer from
   [github.com/martinsbrezauckis/shellx/releases](https://github.com/martinsbrezauckis/shellx/releases).
2. Run the installer.
3. Launch ShellX from the Start Menu.

## Sign in to an agent

For Grok sessions, ShellX talks to xAI's Grok Build CLI. You need either:

- **\`grok login\`** in a terminal once (or **\`grok login --device-auth\`**
  on a remote/headless target) — stores an OAuth token at
  \`~/.grok/auth.json\` that ShellX picks up automatically. *(Recommended.)*
- **Or** an xAI API key stored in **Settings -> Vault**.

Voice (STT) and vision use the OAuth token by default, so most users
never touch the API-key path.

For Claude Code, Codex CLI, and other provider sessions, sign in to the
provider CLI in the target environment first. ShellX scans Local, WSL,
and SSH targets and only offers agent choices that are available there.

## First session

1. The first tab opens to your home folder. Click the 📁 pill in the
   composer to pick a project folder.
2. Choose Local, WSL, or SSH from the connection pill.
3. Choose the agent for this tab.
4. For Grok, press **Connect** or send the first prompt. Provider tabs
   start when you send the first prompt.
5. Type a prompt and press **Enter**.

The active agent streams its response into the chat. File writes show as
diffs where the provider exposes them, image / video outputs render inline,
and terminal commands appear as live PTY or provider command blocks.

## Beta note

ShellX is development-stage software. Features can change, break, or be
overhauled between versions, so keep backups of important projects and
credentials.

ShellX Vault has no recovery words or restore flow. Keep the master passphrase
and required encrypted Vault data available. Review sensitive browser or agent actions such as sign-ins, purchases,
account changes, data submission, and secret use.

## Send files to a session

- Use **Attach** or paste/drop files into the composer for normal
  attachments.
- On Windows, open **Settings -> Desktop** and install **Send files to ShellX**
  to add **Send to ShellX** in Explorer. Multi-selected files arrive as
  composer chips in the active tab.
- Open **Assets** from the bottom toolbar to inspect pending attachments,
  generated images, and generated videos for the current session.

## Build Mode (/build)

For multi-turn tasks where you want Grok Build Mode to keep going without
being re-prompted, choose Grok for the tab and type:

\`\`\`
/build "build a TODO CLI in Rust with tests"
\`\`\`

ShellX writes a scoped scratchboard, lets Grok plan + work + verify,
requires checkpoint/reviewer/verification receipts for code changes,
and auto-continues each turn until Grok calls \`build_complete\`. For
UI/web/app work, Preview Doctor can feed render/log errors back to Grok.
You can \`/pause\` and \`/resume\` at any time.

## Preview generated apps

Open the right rail's **Preview** tab:

- Static HTML runs directly.
- Node apps need dependencies installed first.
- Expo web apps need \`react-dom\` and \`react-native-web\`.
- **Tools -> Environment** shows missing preview setup and the
  suggested command.
- HTML links in chat open Preview Center directly. Other file links use
  the same Preview Center surface for markdown, code, images, video, and
  PDF.

## Connecting to WSL or SSH

Open **Settings → Connections** and add a connection preset:

- **WSL** — enter the distro name. For Grok tabs, ShellX runs
  \`wsl.exe -d <distro> -- grok\`; provider tabs launch the selected CLI
  in that WSL distro. Filesystem reads route via UNC paths.
- **SSH** — host + user using your SSH config, key file, or ssh-agent.
  Choose direct POSIX for Linux, macOS, or a WSL sshd endpoint. Choose
  **Windows OpenSSH, run Windows agents** when the CLI and project live on
  Windows, and use an absolute Windows project path. Choose **Windows OpenSSH,
  run agents in WSL** only when the CLI and project live in an explicitly
  selected WSL distro, then use Linux paths for that tab. Mirrored WSL
  networking is required for the WSL process to reach ShellX's reverse
  host-tool tunnel; connection testing reports an actionable error when the
  loopback path is unavailable.

The connection pill in the composer footer lets you switch a tab
between presets. Each tab can have a different transport.

## Adding tools

Open **Plugins** from the header to enable global connectors and add
any required API keys. After a session connects, open the right rail's
**Tools** tab for environment-specific status and install hints.

## Telegram and Discord

Open **Settings -> Connectors** to add bot tokens and allowlisted sender
ids. Telegram direct chats and Discord DMs can land in the connector
inbox or route into Session chat and return the active session reply.
Delivery and Session chat approval are independent controls. Session chat
keeps per-message Review first enabled unless the operator separately selects
Auto-dispatch.
For Telegram, allowlisting a group chat authorizes every participant in
that group; keep per-message approval enabled or use a private chat when
Session chat can dispatch agent work.

## Useful panels

- **Plan**: active \`/build\` scratchboard and receipts.
- **Tools**: MCP health, environment health, Agent CLIs, and Preview setup.
- **Environment readiness**: missing tooling mapped to affected ShellX
  features.
- **Git**: status, diffs, checkpoints, and worktrees.
- **Preview**: generated web/app preview controls and logs.
- **Files**: active project browser.
- **Assets**: bottom-toolbar attachment and generated media board.

---

## Troubleshooting

**"Failed to connect" on a Grok tab → check that \`grok\` is on your PATH.**
Run \`grok --version\` in that environment. Provider tabs start on first send;
if Codex or Claude fails, rescan the selected environment and check that the
selected CLI is installed there.

**Voice button is grey.**
You need either an OAuth token (\`grok login\` once) or an xAI API key
in the vault. For shell-launched developer sessions, \`XAI_API_KEY\`
is also supported, and \`GROK_CODE_XAI_API_KEY\` remains accepted for
older setups. **Settings → Vault** shows which credential source is
active.

**File preview says "outside allowed scope".**
The file must be under (a) the active session's cwd, (b) your
Downloads folder, or (c) a \`~/.grok/sessions/\` directory. Move the
file or change the tab's cwd via the 📁 pill.

**MCP shows "missing".**
Click the row for the install hint — usually a small \`npm install -g\`
or platform package for the launcher binary.

**Work Preview exits immediately.**
Open **Tools → Environment** and check Feature readiness first, then Preview
setup. If Node, the detected package manager, Python for remote static preview,
or a screenshot browser is missing, install it in the selected Local/WSL/SSH
environment. If an Expo app says web dependencies are missing, run:

\`\`\`
npx expo install react-dom react-native-web
\`\`\`

Then reopen **Preview** and press **Retry**.

---

## Help

- 🐛 Bugs: [github.com/martinsbrezauckis/shellx/issues](https://github.com/martinsbrezauckis/shellx/issues)
- 📧 Author: martins.brezauckis@gmail.com
`,x={features:{id:"features",title:"Features",body:I},readme:{id:"readme",title:"Quick start",body:g},changelog:{id:"changelog",title:"Changelog",body:m},notices:{id:"notices",title:"Third-party notices",body:`\`\`\`text
${T}
\`\`\``}};function O({docId:i,onClose:a}){const o=t.useRef(null);if(w(!!i,o,a),!i)return null;const n=x[i];if(!n)return null;const r=n.body.split(`
`).length;return e.jsx("div",{"data-debug-id":"surface-components-builtindocmodal-4",className:"preview-backdrop",onClick:a,children:e.jsxs("div",{ref:o,"data-debug-id":"surface-components-builtindocmodal-5",className:"preview-modal",onClick:s=>s.stopPropagation(),role:"dialog","aria-modal":"true","aria-label":n.title,children:[e.jsxs("div",{className:"preview-head",children:[e.jsx("span",{className:"preview-fname",title:n.id,children:n.title}),e.jsx("span",{className:"preview-kind",children:"in-app docs"}),e.jsxs("span",{className:"preview-lines",children:[r," lines"]}),e.jsx("button",{type:"button",className:"preview-close",onClick:a,"aria-label":"Close (Esc)",title:"Close (Esc)",children:e.jsx(c,{name:"close",size:14})})]}),e.jsx("div",{className:"preview-body preview-body-markdown",onMouseUp:d,children:e.jsx("div",{className:"preview-md",children:e.jsx(p,{remarkPlugins:[u],components:{pre:s=>e.jsx(M,{...s}),a:({href:s,children:l})=>e.jsx(h,{href:s,children:l})},children:n.body})})})]})})}function M({children:i}){const a=t.useRef(null),[o,n]=t.useState(!1),r=t.useCallback(()=>{const s=a.current?.innerText??"";if(s)try{navigator.clipboard.writeText(s),n(!0),window.setTimeout(()=>n(!1),1200)}catch{}},[]);return e.jsxs("div",{className:"code-block-wrap",style:{position:"relative"},children:[e.jsx("pre",{ref:a,children:i}),e.jsx("button",{type:"button",className:"code-copy-btn",onClick:r,title:o?"Copied":"Copy to clipboard","aria-label":o?"Copied":"Copy to clipboard",children:e.jsx(c,{name:o?"check":"copy",size:13})})]})}export{O as BuiltinDocModal};
