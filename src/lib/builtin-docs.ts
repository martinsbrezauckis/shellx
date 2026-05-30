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

shellX is a desktop client for Grok Build and other ACP-compatible
agents. It combines chat, projects, tools, previews, Git, and local
automation in one app.

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
- SSH sessions with the shellX host toolset tunneled to the remote
  environment.

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
- Grok environment diagnostics show MCP doctor results, \`grok inspect\`
  counts, trace availability, and Preview setup checks.
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
- Native Grok file tools are preferred for routine project edits. Host
  \`fs_*\` remains for atomic or binary file operations, Windows parent-host
  paths from remote sessions, file watching, copy/delete helpers, and
  permission/audit-sensitive host mutations.
- Secrets retrieved from the vault are not echoed in chat.

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
- Telegram Session Chat can send Grok text replies and referenced image
  outputs back to the chat.
- Discord bot messages can be received into the connector inbox.
- Connector setup includes credential tests, allowlists, target session
  rules, and inbound simulation.

## Tasks and API

- Background tasks show CPU, memory, latest output, health counters,
  report copy, ask-Grok diagnostics, and stop controls.
- The shellXagent API exposes app state, prompts, screenshots, previews,
  settings, vault actions, build state, and diagnostics over loopback.
- API access uses the local bearer token stored under \`~/.shellx\`.
- The updater checks signed release manifests and offers in-app updates
  when a published release is available.

## Skills / slash commands

Type \`/\` in the composer for autocomplete of grok's slash commands.
Custom skills under \`~/.grok/skills/\` are loaded on session start.
shellX also installs five compact workflow skills for common coding
loops: build an app, fix a bug, polish UI, review a repo, and prepare
a release.
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
| Ctrl+K         | Quick search                    |
| Ctrl+,         | Open Settings                   |
| Esc            | Close modal / cancel            |
| /              | Slash-command picker            |
| #              | PR / issue picker               |

---

## Where things live

- Config + sessions: \`%USERPROFILE%\\.shellx\\\` (Windows),
  \`~/.shellx/\` (Linux / macOS)
- Vault: \`<config>/vault.enc\`
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

## Sign in to Grok

shellX talks to xAI's Grok Build CLI. You need either:

- **\`grok login\`** in a terminal once — stores an OAuth token at
  \`~/.grok/auth.json\` that shellX picks up automatically. *(Recommended.)*
- **Or** an xAI API key stored in **Settings -> Vault**.

Voice (STT) and vision use the OAuth token by default, so most users
never touch the API-key path.

## First session

1. The first tab opens to your home folder. Click the 📁 pill in the
   composer to pick a project folder.
2. Choose Local, WSL, or SSH from the connection pill.
3. Press **Connect**.
4. Type a prompt and press **Enter**.

grok streams its response into the chat. File writes show as diffs,
image / video outputs render inline, terminal commands appear as live
PTY blocks.

## Send files to a session

- Use **Attach** or paste/drop files into the composer for normal
  attachments.
- On Windows, open **Settings -> Desktop** and install **Send files to shellX**
  to add **Send to shellX** in Explorer. Multi-selected files arrive as
  composer chips in the active tab.
- Open **Assets** from the bottom toolbar to inspect pending attachments,
  generated images, and generated videos for the current session.

## Build Mode (/build)

For multi-turn tasks where you want grok to keep going without being
re-prompted, type:

\`\`\`
/build "build a TODO CLI in Rust with tests"
\`\`\`

shellX writes a scoped scratchboard, lets grok plan + work + verify,
requires checkpoint/reviewer/verification receipts for code changes,
and auto-continues each turn until grok calls \`build_complete\`. For
UI/web/app work, Preview Doctor can feed render/log errors back to grok.
You can \`/pause\` and \`/resume\` at any time.

## Preview generated apps

Open the right rail's **Preview** tab:

- Static HTML runs directly.
- Node apps need dependencies installed first.
- Expo web apps need \`react-dom\` and \`react-native-web\`.
- **Tools -> Grok environment** shows missing preview setup and the
  suggested command.
- HTML links in chat open Preview Center directly. Other file links use
  the same Preview Center surface for markdown, code, images, video, and
  PDF.

## Connecting to WSL or SSH

Open **Settings → Connections** and add a connection preset:

- **WSL** — enter the distro name. shellX runs
  \`wsl.exe -d <distro> -- grok\` and routes filesystem reads via
  UNC paths.
- **SSH** — host + user using your SSH config, key file, or ssh-agent.
  Optional pre-set cwd; if missing, shellX auto-creates it.

The connection pill in the composer footer lets you switch a tab
between presets. Each tab can have a different transport.

## Adding tools

Open **Plugins** from the header to enable global connectors and add
any required API keys. After a session connects, open the right rail's
**Tools** tab for environment-specific status and install hints.

## Telegram and Discord

Open **Settings -> Connectors** to add bot tokens and allowlisted sender
ids. Telegram can reply back to an allowlisted direct chat. Discord
messages currently land in the connector inbox.

## Useful panels

- **Plan**: active \`/build\` scratchboard and receipts.
- **Tools**: MCP health, Grok environment health, and Preview setup.
- **Git**: status, diffs, checkpoints, and worktrees.
- **Preview**: generated web/app preview controls and logs.
- **Files**: active project browser.
- **Assets**: bottom-toolbar attachment and generated media board.

---

## Troubleshooting

**"Failed to connect" → check that \`grok\` is on your PATH.**
Run \`grok --version\` in a terminal. If it's missing, install via
\`npm install -g @xai/grok-build\` (or the platform-specific package).

**Voice button is grey.**
You need either an OAuth token (\`grok login\` once) or an xAI API key
in the vault. For shell-launched developer sessions, current Grok docs
prefer \`XAI_API_KEY\`; \`GROK_CODE_XAI_API_KEY\` is legacy. **Settings
→ Vault** shows which credential source is active.

**File preview says "outside allowed scope".**
The file must be under (a) the active session's cwd, (b) your
Downloads folder, or (c) a \`~/.grok/sessions/\` directory. Move the
file or change the tab's cwd via the 📁 pill.

**MCP shows "missing".**
Click the row for the install hint — usually a small \`npm install -g\`
or platform package for the launcher binary.

**Work Preview exits immediately.**
Open **Tools → Grok environment** and check Preview setup. If an Expo
app says web dependencies are missing, run:

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
};
