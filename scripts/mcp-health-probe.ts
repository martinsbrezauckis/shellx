/**
 * scripts/mcp-health-probe.ts — Phase A WSL-side runner for #322.
 *
 * Validates the MCP marketplace tool-health probe algorithm against the
 * running installed shellX without a rebuild. For each enabled entry in
 * ~/.shellx/mcp-marketplace.json, derives the launcher binary from
 * `stdio_command` and probes `<launcher> --version` via the active tab's
 * transport (Local Windows / WSL / SSH). Classifies status into one of:
 *   running, missing, failed, disabled, available
 *
 * Output: JSON to stdout and, when --out is provided, to that path.
 *
 * Intended for live checks across Local Windows, WSL, and SSH transports.
 *
 * Usage:
 *   npx tsx scripts/mcp-health-probe.ts [--tab-id <id>] [--out <path>]
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve `~/.shellx/<name>` cross-platform.
 *
 * Linux/macOS:  $HOME/.shellx/<name>
 * Windows:      %USERPROFILE%\.shellx\<name>  (via `homedir()`)
 * WSL→Windows:  falls back to `/mnt/c/Users/<win-user>/.shellx/<name>` when the
 *               native HOME copy is absent — supports the running-from-WSL,
 *               shellX-installed-on-Windows-host topology even when the
 *               Linux and Windows usernames differ.
 */
function shellxHome(name: string): string {
  const native = join(homedir(), ".shellx", name);
  if (existsSync(native)) return native;
  // WSL bridge: probe likely usernames first, then scan /mnt/c/Users
  // because the Linux-side $USER does not have to match the Windows
  // account name hosting the running shellX instance.
  for (const winUser of [
    process.env.WIN_USER,
    process.env.USERNAME,
    process.env.USER,
  ].filter((v): v is string => Boolean(v && v.trim()))) {
    const wslMounted = `/mnt/c/Users/${winUser}/.shellx/${name}`;
    if (existsSync(wslMounted)) return wslMounted;
  }
  try {
    for (const entry of readdirSync("/mnt/c/Users", { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const wslMounted = `/mnt/c/Users/${entry.name}/.shellx/${name}`;
      if (existsSync(wslMounted)) return wslMounted;
    }
  } catch {
    // fall through to the native path below
  }
  return native; // return native path so the caller's error message is useful
}

interface CatalogEntry {
  id: string;
  stdio_command: string;
}

/** Subset of CATALOG that matches what's actually shipped. Hardcoded
 * here so the probe runner doesn't need to ship with the shellX binary —
 * Phase B will read from the running shellX's in-process state. */
const CATALOG: CatalogEntry[] = [
  { id: "context7",     stdio_command: "npx -y @upstash/context7-mcp" },
  { id: "playwright",   stdio_command: "npx @playwright/mcp@latest" },
  { id: "fetch",        stdio_command: "uvx mcp-server-fetch" },
  { id: "git",          stdio_command: "uvx mcp-server-git" },
  { id: "memory",       stdio_command: "npx -y @modelcontextprotocol/server-memory" },
  { id: "github",       stdio_command: "" }, // HTTP
  { id: "supabase",     stdio_command: "npx -y @supabase/mcp-server-supabase" },
  { id: "stripe",       stdio_command: "npx -y @stripe/mcp" },
  { id: "serena",       stdio_command: "uvx --from git+https://github.com/oraios/serena serena start-mcp-server" },
  { id: "notion",       stdio_command: "npx -y @notionhq/notion-mcp-server" },
  { id: "firecrawl",    stdio_command: "npx -y firecrawl-mcp" },
  { id: "brave-search", stdio_command: "npx -y @modelcontextprotocol/server-brave-search" },
  { id: "figma",        stdio_command: "npx -y figma-developer-mcp" },
  { id: "slack",        stdio_command: "npx -y @modelcontextprotocol/server-slack" },
  { id: "markitdown",   stdio_command: "uvx markitdown-mcp" },
  { id: "telegram",     stdio_command: "uvx mcp-telegram" },
  { id: "gitlab",       stdio_command: "npx -y @modelcontextprotocol/server-gitlab" },
  { id: "postgres",     stdio_command: "npx -y @modelcontextprotocol/server-postgres" },
  { id: "sqlite",       stdio_command: "uvx mcp-server-sqlite" },
  { id: "docker",       stdio_command: "uvx docker-mcp" },
  { id: "jira",         stdio_command: "uvx mcp-atlassian" },
  { id: "discord",      stdio_command: "npx -y mcp-discord" },
  { id: "google-workspace", stdio_command: "uvx workspace-mcp" },
  { id: "1password",    stdio_command: "npx -y @1password/op-mcp" },
  { id: "qdrant",       stdio_command: "uvx mcp-server-qdrant" },
];

type Status = "running" | "missing" | "failed" | "disabled" | "available";

interface ProbeResult {
  entry_id: string;
  tab_id: string;
  status: Status;
  launcher: string;
  install_hint?: string;
  stderr_tail?: string;
  last_check_ms: number;
  elapsed_ms: number;
}

const TIMEOUT_MS = 5000;

/** Extract the launcher binary from a stdio_command string.
 *  e.g. "npx -y @x" → "npx",  "uvx mcp-server-fetch" → "uvx" */
function deriveLauncher(cmd: string): string {
  return cmd.trim().split(/\s+/)[0] ?? "";
}

function installHintFor(launcher: string): string | undefined {
  switch (launcher) {
    case "uvx":
    case "uv": return "Install via `winget install astral-sh.uv` or `pipx install uv`.";
    case "npx":
    case "npm":
    case "node": return "Install Node.js from https://nodejs.org/ (npm/npx come bundled).";
    case "docker": return "Install Docker Desktop from https://docker.com.";
    case "git": return "Install Git from https://git-scm.com.";
    default: return undefined;
  }
}

/** Spawn a probe command, return { exit, stderr } within timeout.
 *  On timeout exit=-1, stderr="probe timeout 5s". */
function probeOnce(cmd: string, args: string[]): Promise<{ exit: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    ch.stdout?.on("data", (b) => (stdout += b.toString()));
    ch.stderr?.on("data", (b) => (stderr += b.toString()));
    const t = setTimeout(() => {
      try { ch.kill("SIGKILL"); } catch {}
      resolve({ exit: -1, stderr: "probe timeout 5s", stdout });
    }, TIMEOUT_MS);
    ch.on("error", (e) => {
      clearTimeout(t);
      resolve({ exit: -2, stderr: String(e?.message ?? e), stdout });
    });
    ch.on("exit", (code) => {
      clearTimeout(t);
      resolve({ exit: code ?? -3, stderr, stdout });
    });
  });
}

/** Probe one launcher on a specific transport.
 *  Local Windows: `where.exe <binary>` then `<binary> --version`
 *  WSL:           `wsl.exe -d <distro> -e <binary> --version`
 *  SSH:           `ssh <host> -- <binary> --version`
 */
async function probeLauncher(
  launcher: string,
  transport: { kind: "local" | "wsl" | "ssh"; wslDistro?: string; sshHost?: string },
): Promise<{ exit: number; stderr: string; stdout: string }> {
  if (launcher === "") {
    return { exit: -4, stderr: "empty launcher (HTTP-only entry, skip)", stdout: "" };
  }
  switch (transport.kind) {
    case "local":
      // On Windows. Probe binary --version directly. If binary missing,
      // CreateProcess will fail with ENOENT-like error (-2).
      // We run via wsl.exe -d ... no — we're DRIVING from WSL but the
      // shellX install is on Windows. Use cmd.exe via wslpath equivalent:
      // simpler: invoke the Windows binary directly through the /mnt/c/
      // mount-aware exec. Since we're WSL, native node spawn of "cmd.exe"
      // would call cmd.exe in Windows; spawn of "uvx" expects WSL PATH.
      //
      // For Phase A simplicity: probe in WSL's view of the system PATH,
      // which mirrors Windows PATH when WSL2 interop is enabled. This
      // means a launcher present on Windows but not WSL would be a
      // false-negative — note this caveat.
      //
      // To probe the Windows-side binary properly, use cmd.exe:
      return await probeOnce("cmd.exe", ["/c", launcher, "--version"]);
    case "wsl":
      return await probeOnce("wsl.exe", ["-d", transport.wslDistro || "ubuntu-24.04", "-e", launcher, "--version"]);
    case "ssh":
      return await probeOnce("ssh", [transport.sshHost!, "--", launcher, "--version"]);
  }
}

function classify(result: { exit: number; stderr: string; stdout: string }, launcher: string): { status: Status; install_hint?: string; stderr_tail?: string } {
  if (launcher === "") return { status: "available", install_hint: "HTTP-mode entry, no launcher probe" };
  if (result.exit === 0) return { status: "running" };
  const stderrTail = result.stderr.slice(-200).trim() || undefined;
  // exit -1 = timeout, -2 = spawn error (file not found typically)
  // exit ≠ 0 + stderr suggests "not recognized" / "command not found" / "No such file" → missing
  const lower = (result.stderr + " " + result.stdout).toLowerCase();
  const missingSignals = [
    "is not recognized",
    "not recognized",
    "command not found",
    "no such file",
    "enoent",
    "cannot find",
  ];
  if (result.exit === -2 || missingSignals.some(s => lower.includes(s))) {
    return { status: "missing", install_hint: installHintFor(launcher), stderr_tail: stderrTail };
  }
  // timeout = failed
  if (result.exit === -1) {
    return { status: "failed", stderr_tail: stderrTail };
  }
  return { status: "failed", stderr_tail: stderrTail };
}

/**
 * Read the live shellXagent bearer token. Source of truth is
 * `~/.shellx/shellxagent.token` (the rename from `debug.token`). Falls
 * back to the legacy `debug.token` name for installs that predate the
 * auto-migration so this probe keeps working during the rollout. Path
 * resolution is cross-platform via `shellxHome()` (HOME/USERPROFILE +
 * WSL-mount fallback).
 */
function readShellxagentToken(): string {
  for (const name of ["shellxagent.token", "debug.token"]) {
    try {
      const raw = readFileSync(shellxHome(name), "utf8").trim();
      if (raw.length >= 32) return raw;
    } catch {
      // try next candidate
    }
  }
  return "";
}

/**
 * Read the live debug-api port the running shellX bound to. The server
 * writes the actually-bound port (after any 5759/5761/5763/5765 orphan-
 * socket fallback) to `~/.shellx/debug-api.port`. Returns null when the
 * file is missing — caller should fall back to probing the standard
 * port list.
 */
function readBoundDebugApiPort(): number | null {
  try {
    const raw = readFileSync(shellxHome("debug-api.port"), "utf8").trim();
    const p = Number(raw);
    if (Number.isFinite(p) && p > 0 && p < 65536) return p;
  } catch {
    // not published yet
  }
  return null;
}

async function getTabTransport(
  requestedTabId?: string | null,
): Promise<{ tabId: string; kind: "local" | "wsl" | "ssh"; wslDistro?: string; sshHost?: string }> {
  // Find live shellXagent port: prefer the published `debug-api.port`
  // file, fall back to /health probe across the known fallback ports.
  const token = readShellxagentToken();
  let port = readBoundDebugApiPort() ?? 5759;
  if (readBoundDebugApiPort() === null) {
    for (const p of [5757, 5759, 5761, 5763, 5765]) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/health`);
        if (r.ok) { port = p; break; }
      } catch {}
    }
  }
  const r = await fetch(`http://127.0.0.1:${port}/state/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data: any = await r.json();
  const tabs = Array.isArray(data?.tabs) ? data.tabs : [];
  const selected = (requestedTabId
    ? tabs.find((t: any) => t.tabId === requestedTabId)
    : undefined)
    ?? tabs.find((t: any) => t.hasSession)
    ?? tabs[0];
  if (!selected) {
    return {
      tabId: requestedTabId?.trim() || "default",
      kind: "local",
    };
  }
  if (selected.isSsh) {
    return { tabId: selected.tabId, kind: "ssh", sshHost: selected.sshHost };
  }
  if (selected.isWsl) {
    return {
      tabId: selected.tabId,
      kind: "wsl",
      wslDistro: selected.wslDistro || "ubuntu-24.04",
    };
  }
  return { tabId: selected.tabId, kind: "local" };
}

function readMarketplaceState(): Set<string> {
  try {
    const raw = readFileSync(shellxHome("mcp-marketplace.json"), "utf8");
    const d = JSON.parse(raw);
    return new Set(Object.entries(d.entries || {})
      .filter(([_, v]: any) => v?.installed && v?.enabled)
      .map(([k]) => k));
  } catch {
    return new Set();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? argv[outIdx + 1]! : null;
  const tabIdFromArgs = argv.indexOf("--tab-id") >= 0 ? argv[argv.indexOf("--tab-id") + 1] : null;

  const transport = await getTabTransport(tabIdFromArgs);
  console.error(`[probe] transport: ${JSON.stringify(transport)}`);

  const enabledIds = readMarketplaceState();
  console.error(`[probe] enabled marketplace ids: ${Array.from(enabledIds).join(", ") || "(none)"}`);

  const results: ProbeResult[] = [];
  // Probe in batches of 4 (concurrency cap per design)
  const queue = CATALOG.filter(e => enabledIds.has(e.id));
  // For Phase A also probe NOT-enabled entries to validate "available" classification
  // (note: those are "available" only conceptually since they're not installed)
  const BATCH = 4;
  for (let i = 0; i < queue.length; i += BATCH) {
    const batch = queue.slice(i, i + BATCH);
    const batchRes = await Promise.all(batch.map(async (entry) => {
      const launcher = deriveLauncher(entry.stdio_command);
      const startMs = Date.now();
      const probeRes = await probeLauncher(launcher, transport);
      const cls = classify(probeRes, launcher);
      const r: ProbeResult = {
        entry_id: entry.id,
        tab_id: transport.tabId,
        status: cls.status,
        launcher,
        install_hint: cls.install_hint,
        stderr_tail: cls.stderr_tail,
        last_check_ms: Date.now(),
        elapsed_ms: Date.now() - startMs,
      };
      console.error(`[probe] ${entry.id.padEnd(20)} launcher=${launcher.padEnd(8)} status=${r.status.padEnd(10)} elapsed=${r.elapsed_ms}ms`);
      return r;
    }));
    results.push(...batchRes);
  }

  const summary = {
    ts: new Date().toISOString(),
    transport,
    probed_count: results.length,
    by_status: results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {} as Record<string, number>),
    results,
  };
  const out = JSON.stringify(summary, null, 2);
  console.log(out);

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, out);
    console.error(`[probe] written: ${outPath}`);
  }
}
main().catch(e => { console.error("FATAL:", e); process.exit(1); });
