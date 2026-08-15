/**
 * src/lib/builtin-docs.ts — curated in-app documentation.
 *
 * The About tab links to these docs. Bundled as TypeScript string
 * constants so they ship inside the installer and work without
 * filesystem access, network, or post-install download. Edit here to
 * update the in-app docs; the repo `README.md` is the canonical
 * project README for GitHub viewers.
 *
 * Format: GitHub-flavored markdown. Rendered through ReactMarkdown +
 * remarkGfm with the same `a:` (open-in-browser) and `pre:` (copy
 * button) component overrides used by chat output.
 *
 * Style rules (so the in-app docs stay clean for end users):
 * - Speak to the user. No internal issue numbers, no phase markers.
 * - Examples use neutral placeholders ("your project folder"),
 * never personal hostnames or paths.
 * - Concrete commands and click paths beat prose.
 * - One section per concept. Short.
 */
import CHANGELOG from "../../CHANGELOG.md?raw";
import THIRD_PARTY_NOTICES from "../../THIRD-PARTY-NOTICES.txt?raw";

export interface BuiltinDoc {
 /** Filename-style id ("features", "quickstart"). Stable key for
 * links + URL fragments. */
  id: string;
 /** Display title shown in the modal header. */
  title: string;
 /** Markdown body. */
  body: string;
}

const FEATURES = `# shellX features

shellX is a desktop client for Grok Build, Claude Code, Codex CLI,
Antigravity CLI, and other ACP-compatible agents. It combines chat,
projects, tools, previews, Git, and local automation in one app.

---

## Chat and sessions

- Multi-tab agent chat with one working folder and connection per tab.
- Persistent chat history with search and archived past sessions.
- Markdown file links open in shellX; external links open in the browser.
- Tool output, diffs, terminals, generated images, and generated videos
  render inside the conversation.
- File picker, paste, drag/drop, screenshots, and Send to shellX create
  attachment chips instead of raw paths in the composer.
- The **Assets** button opens pending attachments plus session images and
  videos in one board.
- On Windows, **Settings -> Desktop** can install **Send to shellX** as
  a right-click menu item and SendTo shortcut for selected files.
- Select text and release the mouse to copy it.

## Connections

- Local Windows sessions.
- WSL sessions with Linux path handling.
- SSH sessions to Linux, macOS, or WSL targets with the shellX host toolset
  tunneled to the remote environment.
- Native Windows OpenSSH can run Windows-installed CLI agents directly with
  PowerShell commands and Windows paths. WSL is not required.
- Windows OpenSSH can also launch the tab inside an explicitly selected WSL
  distro. This keeps one Linux path frame for agents, files, previews, and Git.

Switch connection per tab from the composer footer.

## Build Mode

\`/build "make this project production-ready"\` starts a long-running
build workflow. shellX keeps the scratchboard, receipts, checkpoints,
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
  shellX X Search are available.
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
  shellX session when allowlisted.
- Telegram Session Chat can send active-session text replies and referenced
  image outputs back to the chat.
- Discord bot messages can route to the connector inbox or an eligible target
  ShellX session when allowlisted.
- Connector setup includes credential tests, allowlists, target session
  rules, and inbound simulation.

## Tasks and API

- The header Tasks button opens the first-class Task Manager for one-time or
  recurring agent work. Create Task below the composer starts a reviewed draft
  from the current conversation; provider order and schedule stay in Task
  Manager.
- Date and time pickers follow the execution computer's local clock by default.
  Timezone pinning, missed-run behavior, stop-after limits, and notification
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
\`/best-of-n\`, or \`/execute-plan\`, treat them as manual commands; shellX
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
`;

const README = `# shellX — quick start

## Install

1. Download the latest installer from
   [github.com/martinsbrezauckis/shellx/releases](https://github.com/martinsbrezauckis/shellx/releases).
2. Run the installer.
3. Launch shellX from the Start Menu.

## Sign in to an agent

For Grok sessions, shellX talks to xAI's Grok Build CLI. You need either:

- **\`grok login\`** in a terminal once (or **\`grok login --device-auth\`**
  on a remote/headless target) — stores an OAuth token at
  \`~/.grok/auth.json\` that shellX picks up automatically. *(Recommended.)*
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

ShellX Vault keeps secrets under your control. Save your recovery materials,
and review sensitive browser or agent actions such as sign-ins, purchases,
account changes, data submission, and secret use.

## Send files to a session

- Use **Attach** or paste/drop files into the composer for normal
  attachments.
- On Windows, open **Settings -> Desktop** and install **Send files to shellX**
  to add **Send to shellX** in Explorer. Multi-selected files arrive as
  composer chips in the active tab.
- Open **Assets** from the bottom toolbar to inspect pending attachments,
  generated images, and generated videos for the current session.

## Build Mode (/build)

For multi-turn tasks where you want Grok Build Mode to keep going without
being re-prompted, choose Grok for the tab and type:

\`\`\`
/build "build a TODO CLI in Rust with tests"
\`\`\`

shellX writes a scoped scratchboard, lets Grok plan + work + verify,
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

- **WSL** — enter the distro name. For Grok tabs, shellX runs
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
`;

export const BUILTIN_DOCS: Record<string, BuiltinDoc> = {
  features: { id: "features", title: "Features", body: FEATURES },
  readme: { id: "readme", title: "Quick start", body: README },
  changelog: { id: "changelog", title: "Changelog", body: CHANGELOG },
  notices: { id: "notices", title: "Third-party notices", body: `\`\`\`text\n${THIRD_PARTY_NOTICES}\n\`\`\`` },
};
