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

const FEATURES = `# shellX — what it does

**shellX** is a desktop client that hosts xAI's
[Grok Build CLI](https://x.ai/grok) (or any agent that speaks
the Agent Client Protocol). Tabs, vault, voice, file preview, MCP
marketplace, session tool health, autonomous goal mode — wrapped
around a real agent.

---

## Multi-tab chat

- **One tab = one agent process.** Each tab gets its own working
  directory, transport, autonomy mode, and event history.
- **Voice input.** Hold the 🎤 button to dictate; transcribed via xAI's
  Grok STT and inserted at the composer cursor.
- **Voice chat round-trip.** Toggle 🎧 to have grok reply in speech;
  click ✕ next to the mic to switch it off.
- **Smart file links.** Markdown links to local files open in the
  built-in preview; external links open in your default browser.
- **Generated media tabs.** Images and videos generated during a
  session are collected into dedicated preview grids.
- **Inline tool output.** File reads, fetches, terminal commands render
  inside the chat card instead of getting buried in args.
- **Grok Imagine media.** Image and video generations from grok-build
  render inline when your Grok account exposes Imagine features.
- **Copy on selection.** Select text → release → it's on the clipboard.

## Three transports, one UI

- **Local Windows** — grok runs as a child process. Default, no setup.
- **WSL** — grok runs inside your WSL distro. Files on the Linux side
  are read through UNC paths automatically.
- **SSH** — grok runs on a remote host you choose. shellX tunnels its
  host-MCP toolset to the remote so the agent has the same toolbox it
  has locally. cwd is auto-created if it doesn't exist.

Switch transports per tab via the connection pill in the composer
footer.

## /goal — autonomous mode

\`/goal "build a sieve of Eratosthenes in Python with tests"\` puts the
tab into autonomous mode. shellX:

1. Writes a scratchboard (\`goal.md\`) in the working directory.
2. Lets grok plan, work, and verify across multiple turns.
3. Requires a reviewer/check subagent gate for code changes when available.
4. Auto-continues each turn until grok calls \`goal_complete\`.

Use \`/pause\`, \`/resume\`, \`/stop\` to control it. The right rail's
**Plan** tab shows the live scratchboard and a checklist of phases.

## MCP marketplace

The Plugins button lists curated MCP servers (Fetch, Git, Memory,
Playwright, Context7, Stripe, Sentry, Cloudflare, Supabase, Vercel,
GitHub, ...). Use it for global connector settings and API keys.
After a tab connects, the right rail's **Tools** tab shows what is
actually ready in that environment and where a missing tool needs to
be installed.

## Search capabilities

When the connected Grok build exposes them, **Tools** shows Web
Search, Web Fetch, and shellX X Search capability status. Ask grok to
use those tools from chat; shellX keeps the result links clickable.

## File preview + workspace

- Click any file link in chat -> preview opens (markdown,
  syntax-highlighted code/config, image, video, PDF).
- HTML opens as code first. Use the preview toggle only when you want
  a sandboxed static render.
- Unsupported binary files show a clear unsupported-preview message.
- The right rail's **Files** tab shows the active tab's cwd with
  drag-and-drop attach.
- **Download all** zips the workspace for backup or hand-off.

## Outside connectors

Settings -> Connectors stores Telegram bot or local relay credentials,
allowed sender lists, and target-session rules. Use credential tests
before enabling a connector; keep dispatch review-first until you
trust the channel.

## Encrypted vault

Settings → Vault stores API keys, tokens, and shared secrets locally:

- chacha20poly1305 cipher; master key kept in your OS keyring.
- Values are write-only from the UI — the agent reads them via
  \`secret_get\` but they never echo to chat or logs.
- xAI OAuth (from \`grok login\`) is the default credential for STT and
  vision; you don't need a separate API key for those.

## Skills / slash commands

Type \`/\` in the composer for autocomplete of grok's slash commands.
Custom skills under \`~/.grok/skills/\` are loaded on session start.
shellX also installs five compact workflow skills for common coding
loops: build an app, fix a bug, polish UI, review a repo, and prepare
a release.

## Tasks rail

Background subagents launched via \`Agent\` show up in the right
rail's **Tasks** tab: live CPU/RAM, last output, and a kill button.
Scoped to the active tab.

## shellXagent HTTP API

Every UI surface is also reachable over \`127.0.0.1\` as a typed JSON
API. Useful for local scripting and AI-driven UI tests on the same
machine. Loopback only — other machines on the network cannot reach
it. Token in **Settings → shellXagent**.

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
   [github.com/MartinsBrezauckis/shellx/releases](https://github.com/MartinsBrezauckis/shellx/releases).
2. Run the installer and launch shellX. Updates are delivered from
   GitHub Releases.
3. Launch shellX from the Start Menu.

## First connection

shellX talks to xAI's Grok Build CLI. You need either:

- **\`grok login\`** in a terminal once — stores an OAuth token at
  \`~/.grok/auth.json\` that shellX picks up automatically. *(Recommended.)*
- **Or** an xAI API key pasted into **Settings → Vault**.

Voice (STT) and vision use the OAuth token by default, so most users
never touch the API-key path.

## Your first prompt

1. The first tab opens to your home folder. Click the 📁 pill in the
   composer to pick a project folder.
2. Type a prompt and press **Enter**.
3. grok streams its response into the chat. File writes show as diffs,
   image / video outputs render inline, terminal commands appear as
   live PTY blocks.

## Autonomous mode (/goal)

For multi-turn tasks where you want grok to keep going without being
re-prompted, type:

\`\`\`
/goal "build a TODO CLI in Rust with tests"
\`\`\`

shellX writes a scratchboard, lets grok plan + work + verify, requires
a reviewer/check subagent gate for code changes when available, and
auto-continues each turn until grok calls \`goal_complete\`. You can
\`/pause\` and \`/resume\` at any time.

## Connecting to WSL or SSH

Open **Settings → Connections** and add a connection preset:

- **WSL** — enter the distro name. shellX runs
  \`wsl.exe -d <distro> -- grok\` and routes filesystem reads via
  UNC paths.
- **SSH** — host + user using your SSH config, key file, or ssh-agent.
  Optional pre-set cwd; if missing, shellX auto-creates it.

The connection pill in the composer footer lets you switch a tab
between presets. Each tab can have a different transport.

## Adding MCPs

Open **Plugins** from the header to enable global connectors and add
any required API keys. After a session connects, open the right rail's
**Tools** tab for environment-specific status and install hints.

## Tips

- The right rail's **Plan** tab shows whether a \`/goal\` is active and
  what the scratchboard says.
- The right rail's **Tools** tab shows what the active environment can
  actually use.
- Select text in chat — it auto-copies on mouse release.
- The 🎤 button lights up red while recording. Pressing **Send** while
  hot stops recording, transcribes, and submits in one click.
- Tabs persist across restarts. Past sessions live in the left rail.

---

## Troubleshooting

**"Failed to connect" → check that \`grok\` is on your PATH.**
Run \`grok --version\` in a terminal. If it's missing, install via
\`npm install -g @xai/grok-build\` (or the platform-specific package).

**Voice button is grey.**
You need either an OAuth token (\`grok login\` once) or an xAI API key
in the vault. **Settings → Vault** shows which credential source is
active.

**File preview says "outside allowed scope".**
The file must be under (a) the active session's cwd, (b) your
Downloads folder, or (c) a \`~/.grok/sessions/\` directory. Move the
file or change the tab's cwd via the 📁 pill.

**MCP shows "missing".**
Click the row for the install hint — usually a small \`npm install -g\`
or platform package for the launcher binary.

---

## Help

- 🐛 Bugs: [github.com/MartinsBrezauckis/shellx/issues](https://github.com/MartinsBrezauckis/shellx/issues)
- 📧 Author: martins.brezauckis@gmail.com
`;

export const BUILTIN_DOCS: Record<string, BuiltinDoc> = {
  features: { id: "features", title: "Features", body: FEATURES },
  readme: { id: "readme", title: "Quick start", body: README },
  changelog: { id: "changelog", title: "Changelog", body: CHANGELOG },
};
