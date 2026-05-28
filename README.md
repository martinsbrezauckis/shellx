# shellX

Desktop client that hosts xAI's **Grok Build CLI** — or any agent
speaking the Agent Client Protocol — with tabs, an encrypted vault,
voice in / out, session tool health, traceable file activity, Git review
workflows, an MCP marketplace, file/media preview, Build Mode,
and a typed HTTP API for local scripting.

**Status:** Beta. Windows installer is the primary signed release.
Linux bundles are experimental release artifacts when CI passes. macOS
public packaging is deferred until Developer ID signing and notarization
are ready.

## What it does

- **One UI for three runtimes.** Run the agent on local Windows, WSL,
  or SSH with the same chat, vault, previews, and host tools.
- **Grok Imagine-ready media.** Image and video generations from
  grok-build render inline when your Grok account exposes Imagine
  features.
- **Host MCP tools.** Vault, filesystem, network fetch, screenshots,
  vision, memory, process controls, and subagent tools are available to
  the connected agent.
- **Real terminal.** Embedded PTY (ConPTY on Windows, openpty on
  Linux). Run `vim`, `htop`, anything interactive.
- **Encrypted vault.** chacha20poly1305 cipher with an OS-keyring
  master key. Agent reads via `secret_get`; values never leak to
  chat or logs.
- **Persistent sessions.** Each chat saved as JSONL. Full-content
  search across history.
- **Traceable agent work.** Review file searches, reads, writes,
  deletes, generated media, and activity graph nodes for the active
  session when the connected agent exposes enough log detail.
- **Git workflow surface.** Inspect dirty state and diffs, create local
  checkpoints, and create worktrees from the active session without
  leaving shellX.
- **Tools health.** See MCP health, Grok environment diagnostics,
  search capability status, trace availability, and Preview setup for
  the active tab.
- **Workflow skills.** shellX installs compact Grok skills for common
  coding loops: build an app, fix a bug, polish UI, review a repo, and
  prepare a release.
- **Build Mode.** `/build "<objective>"` writes a scoped scratchboard,
  lets the agent plan + work across multiple turns, records host
  receipts for checkpoints/review/verification, and uses Preview Doctor
  evidence for UI/web work.
- **Work Preview.** Static HTML, web apps, and Expo web apps can run in
  a loopback preview with logs, diagnostics, and passive setup checks in
  the Tools panel.
- **Outside connectors.** Telegram can route allowlisted direct chats to
  a shellX session and reply back. Discord bot messages can land in the
  connector inbox.
- **shellXagent HTTP API.** Every UI surface reachable over loopback
  with a bearer token. Drive shellX from an external agent, Playwright,
  a CI bot, anything.
- **Auto-updater.** Signature-verified through Tauri's updater
  plugin.

## Install

### Windows

Download the latest signed installer from the
[Releases page](https://github.com/martinsbrezauckis/shellx/releases).

### Linux

Linux release artifacts are experimental. Download the `.deb`, `.rpm`,
or `.AppImage` from the Releases page if one matches your distro. If a
bundle is not attached for your distro, build from source:

```bash
git clone https://github.com/martinsbrezauckis/shellx
cd shellx
pnpm install
pnpm tauri build
```

For a Windows installer from WSL, use the staged Windows build helper:

```bash
./scripts/build-windows-from-wsl.sh
```

### macOS

No public notarized macOS download yet. The app can be built from
source for local development/testing, but public distribution waits on
Developer ID signing and notarization.

```bash
git clone https://github.com/martinsbrezauckis/shellx
cd shellx
pnpm install
./scripts/build-macos.sh
```

Requires Node 20+, pnpm, Rust 1.80+, and the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).
Maintainer signing/notarization notes live in `docs/MACOS_RELEASE.md`.

## Quick start

1. Launch shellX.
2. **Settings → Connections** — add a connection preset (Local,
   WSL distro, or SSH host).
3. **Settings → Vault** — if you haven't already, run `grok login`
   in a terminal once so shellX picks up your OAuth token; otherwise
   paste an xAI API key here.
4. **New tab → 📁 pill** → pick a working folder → **Connect**.
5. Type a prompt. Use `/build "<objective>"` for multi-turn build mode or
   `/pr` to open the PR-create modal. Grok's own slash commands (e.g.
   `/help`) work as usual.

For full quick-start, open **Settings → About → Quick start**.

## shellXagent API

Every UI surface has an HTTP equivalent.

- **Authentication:** `Authorization: Bearer <token>`. Read the token
  from `~/.shellx/shellxagent.token`.
- **Port discovery:** read the live port from
  `~/.shellx/debug-api.port`. The host-MCP HTTP port lives at
  `~/.shellx/mcp-http.port`. Both are written at startup so external
  drivers don't have to hard-code a value.
- **Loopback only.** The servers bind to `127.0.0.1`; LAN clients
  cannot reach them.

```bash
TOKEN=$(cat ~/.shellx/shellxagent.token)
PORT=$(cat ~/.shellx/debug-api.port)
H="Authorization: Bearer $TOKEN"
BASE="http://127.0.0.1:$PORT"

# Health (no auth)
curl "$BASE/health"

# Structural diagnostics
curl -X POST -H "$H" -H "Content-Type: application/json" \
  -d '{}' "$BASE/diagnostics"

# Connect + prompt + abort
curl -X POST -H "$H" -H "Content-Type: application/json" \
  -d '{"connectionId":"<id>","cwd":"<path>","tabId":"t1"}' \
  "$BASE/connect"

curl -X POST -H "$H" -H "Content-Type: application/json" \
  -d '{"prompt":"hello","tabId":"t1"}' \
  "$BASE/prompt"

curl -X POST -H "$H" "$BASE/abort?tabId=t1"

# Screenshot the shellX window
curl -H "$H" "$BASE/screenshot" > shellx.png
```

Full endpoint inventory + curl recipes: [docs/API.md](docs/API.md).

## Architecture

- **Tauri 2** — Rust backend + system WebView (WebView2 / WKWebView)
- **React + TypeScript** UI
- **Agent Client Protocol (ACP)** over stdio to the agent
- **portable-pty** for the embedded terminal
- **axum** + **tokio** for the shellXagent HTTP / WS API
- **chacha20poly1305** + **keyring-rs** for the vault

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the wire
diagrams and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the
security posture (single-user, local-machine trust boundary). The
public/private repo boundary is documented in
[docs/PUBLIC_REPO.md](docs/PUBLIC_REPO.md).

## License

MIT — see [LICENSE](LICENSE).

## Credits

Created by Martins Brezauckis. shellX connects to Grok through ACP and
can be driven by external automation through shellXagent.
