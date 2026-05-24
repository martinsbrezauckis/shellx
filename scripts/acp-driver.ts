/**
 * scripts/acp-driver.ts
 *
 * Dual-mode ACP driver — the agent-first verification harness for grok-shell.
 *
 * Mode A (--mode=stdio):  spawn `grok agent stdio` as a child process and
 *                         exercise it directly. Used in P0 to capture real
 *                         wire format, and at any time as a baseline-truth
 *                         comparison against the Tauri app.
 *
 * Mode B (--mode=app):    connect to the running Tauri app's debug
 *                         WebSocket and drive it the same way an external
 *                         agent would. NOT IMPLEMENTED YET — wired in P3.
 *
 * Output: every JSON-RPC frame (both directions) plus stderr lines and
 *         driver-level notes append to evidence/session-NNN.jsonl, one
 *         line per entry: { t, dir, frame? | raw? | note? }.
 *
 * Why a single driver instead of two scripts: the JSONL format and the
 * sequence of prompts must be identical across modes so we can byte-diff
 * the captures and prove the Tauri pipeline doesn't drop or mutate events.
 *
 * Usage examples:
 *   pnpm capture -- --prompt "Reply with just the word OK."
 *   pnpm capture -- --prompt "Write a hello-world Rust file to /tmp/hi.rs"
 *   pnpm capture -- --cwd ~/grok-shell --prompt "List files in this dir."
 */

import { spawn, ChildProcess } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ───────────────────────── Types ─────────────────────────

type Direction = "in" | "out" | "log" | "stderr";

interface JsonlEntry {
  t: number;
  dir: Direction;
  frame?: unknown;
  raw?: string;
  note?: string;
}

interface CliArgs {
  mode: "stdio" | "app";
  cwd: string;
  prompts: string[];
  evidenceDir: string;
  protocolVersion: string;
  grokBin: string;
  promptTimeoutMs: number;
  /** Arbitrary CLI flags — Mode B reads --debug-port from here. */
  [key: string]: unknown;
}

/**
 * Resolve `~/.shellx/<name>` across local Unix/Windows installs and the
 * WSL->Windows topology where the running shellX app lives under
 * `C:\Users\<user>\.shellx` while this script runs from WSL.
 */
function shellxHome(name: string): string {
  const native = join(homedir(), ".shellx", name);
  if (existsSync(native)) return native;
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
  return native;
}

// ───────────────────────── CLI parsing ─────────────────────────

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  const prompts: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        args[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next != null && !next.startsWith("--")) {
          args[key] = next;
          i++;
        } else {
          args[key] = "true";
        }
      }
    }
  }
  if (args.prompt) prompts.push(args.prompt);
  // Allow multiple --prompt by repeated key: only the last survives via the
  // simple parser above. For multi-prompt runs, pass --prompts-file.
  return {
    mode: (args.mode as CliArgs["mode"]) ?? "stdio",
    cwd: args.cwd ?? process.cwd(),
    prompts: prompts.length
      ? prompts
      : ["Reply with just the single word OK."],
    evidenceDir: args.evidence ?? "evidence",
    protocolVersion: args["protocol-version"] ?? "2025-03-26",
    grokBin:
      args["grok-bin"] ??
      process.env.GROK_BIN ??
      `${process.env.HOME}/.grok/bin/grok`,
    promptTimeoutMs: parseInt(args["timeout-ms"] ?? "600000", 10),
  };
}

// ───────────────────────── Evidence file rotation ─────────────────────────

function nextSessionPath(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const existing = readdirSync(dir).filter((f) =>
    /^session-\d+\.jsonl$/.test(f),
  );
  const nums = existing
    .map((f) => parseInt(f.slice(8, -6), 10))
    .filter((n) => !Number.isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return join(dir, `session-${String(next).padStart(3, "0")}.jsonl`);
}

class JsonlWriter {
  constructor(private path: string) {
    writeFileSync(path, "");
  }
  write(entry: JsonlEntry) {
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }
}

// ───────────────────────── ACP stdio client ─────────────────────────

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio.
 * Handles requests with id, notifications, and responses; matches responses
 * back to their request promises. Logs every frame in both directions.
 */
// Methods the agent (acting as ACP client of OUR client capabilities) may
// invoke on us. We advertised fs.readTextFile + fs.writeTextFile in
// initialize, so we must implement them. Return shape matches ACP spec:
//   fs/read_text_file → { content: <string> }
//   fs/write_text_file → null (success)
// Anything else: -32601 Method Not Found.
type AgentRequestHandler = (params: any) => Promise<unknown>;

const AGENT_REQUEST_HANDLERS: Record<string, AgentRequestHandler> = {
  "fs/read_text_file": async (params: any) => {
    const path: string = params?.path;
    if (typeof path !== "string") {
      throw { code: -32602, message: "Invalid params: 'path' required" };
    }
    if (!existsSync(path)) {
      throw {
        code: -32000,
        message: `File not found: ${path}`,
        data: { kind: "ENOENT", path },
      };
    }
    const content = readFileSync(path, "utf8");
    return { content };
  },
  "fs/write_text_file": async (params: any) => {
    const path: string = params?.path;
    const content: string = params?.content ?? "";
    if (typeof path !== "string") {
      throw { code: -32602, message: "Invalid params: 'path' required" };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    return null;
  },
};

class StdioAcpClient {
  private child: ChildProcess;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number | string, (frame: any) => void>();
  private notificationHandlers: Array<(frame: any) => void> = [];

  constructor(
    private logger: JsonlWriter,
    grokBin: string,
  ) {
    this.child = spawn(grokBin, ["agent", "stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stderr!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr!.on("data", (chunk: string) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        this.logger.write({ t: Date.now(), dir: "stderr", raw: line });
      }
    });
    this.child.on("error", (err) => {
      this.logger.write({
        t: Date.now(),
        dir: "log",
        note: `child error: ${err.message}`,
      });
    });
    this.child.on("exit", (code, sig) => {
      this.logger.write({
        t: Date.now(),
        dir: "log",
        note: `child exit code=${code} signal=${sig}`,
      });
    });
  }

  private onStdout(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string) {
    let frame: any;
    try {
      frame = JSON.parse(line);
    } catch {
      this.logger.write({
        t: Date.now(),
        dir: "in",
        raw: line,
        note: "json-parse-failed",
      });
      return;
    }
    this.logger.write({ t: Date.now(), dir: "in", frame });

    // Response to one of our requests
    if (
      frame.id != null &&
      (frame.result !== undefined || frame.error !== undefined)
    ) {
      // Filter agent's internal "skills-reload" pseudo-frames (see wire-shape.md)
      if (frame.id === "skills-reload") return;
      const resolver = this.pending.get(frame.id);
      if (resolver) {
        this.pending.delete(frame.id);
        resolver(frame);
      }
      return;
    }

    // Request from the agent (bidirectional ACP — agent calls OUR fs methods).
    // A request has both `id` and `method`. Notifications have only `method`.
    if (frame.id !== undefined && typeof frame.method === "string") {
      void this.handleAgentRequest(frame);
      return;
    }

    // Notification
    for (const h of this.notificationHandlers) h(frame);
  }

  private async handleAgentRequest(frame: any) {
    const handler = AGENT_REQUEST_HANDLERS[frame.method];
    if (!handler) {
      this.sendResponse(frame.id, undefined, {
        code: -32601,
        message: `Method not found: ${frame.method}`,
      });
      return;
    }
    try {
      const result = await handler(frame.params);
      this.sendResponse(frame.id, result);
    } catch (err: any) {
      const error =
        err && typeof err === "object" && "code" in err
          ? err
          : { code: -32000, message: err?.message ?? String(err) };
      this.sendResponse(frame.id, undefined, error);
    }
  }

  private sendResponse(id: any, result?: unknown, error?: unknown) {
    const frame: any = { jsonrpc: "2.0", id };
    if (error !== undefined) frame.error = error;
    else frame.result = result ?? null;
    this.logger.write({ t: Date.now(), dir: "out", frame });
    this.child.stdin!.write(JSON.stringify(frame) + "\n");
  }

  onNotification(h: (frame: any) => void) {
    this.notificationHandlers.push(h);
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    const frame = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`Timeout waiting for response to ${method} (id=${id})`),
        );
      }, timeoutMs);
      this.pending.set(id, (resp) => {
        clearTimeout(t);
        if (resp.error)
          reject(
            new Error(`ACP error in ${method}: ${JSON.stringify(resp.error)}`),
          );
        else resolve(resp.result);
      });
      this.logger.write({ t: Date.now(), dir: "out", frame });
      this.child.stdin!.write(JSON.stringify(frame) + "\n");
    });
  }

  notify(method: string, params: unknown) {
    const frame = { jsonrpc: "2.0", method, params };
    this.logger.write({ t: Date.now(), dir: "out", frame });
    this.child.stdin!.write(JSON.stringify(frame) + "\n");
  }

  kill() {
    try {
      this.child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

// ───────────────────────── Mode A: stdio ─────────────────────────

async function runStdioMode(args: CliArgs): Promise<number> {
  const evidencePath = nextSessionPath(args.evidenceDir);
  console.log(`[driver] mode=stdio evidence=${evidencePath}`);
  const logger = new JsonlWriter(evidencePath);
  logger.write({
    t: Date.now(),
    dir: "log",
    note: `driver start mode=stdio cwd=${args.cwd} protocolVersion=${args.protocolVersion} grokBin=${args.grokBin}`,
  });

  const client = new StdioAcpClient(logger, args.grokBin);

  // Brief notification echo to stdout so progress is visible during long runs.
  client.onNotification((frame: any) => {
    const m = frame?.method ?? "<no-method>";
    const su = frame?.params?.update?.sessionUpdate;
    const tag = su ? `${m}/${su}` : m;
    process.stdout.write(`  · ${tag}\n`);
  });

  // 1. initialize
  // Empirical: grok agent stdio responds with protocolVersion: 1 (a number)
  // and one authMethod {id: "grok.com"}. Even though prior acp.rs comments
  // claimed older "1" failed, the actual current binary uses it. We send
  // whatever protocolVersion the caller asks for and capture the negotiated
  // value out of the response.
  let initResult: any;
  try {
    initResult = await client.request("initialize", {
      protocolVersion: args.protocolVersion,
      clientInfo: { name: "grok-shell-driver", version: "0.0.1" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });
    logger.write({
      t: Date.now(),
      dir: "log",
      note: `initialize ok: protocolVersion=${initResult?.protocolVersion} authMethods=${JSON.stringify(initResult?.authMethods)}`,
    });
    console.log("[driver] initialize ok");
  } catch (e: any) {
    logger.write({
      t: Date.now(),
      dir: "log",
      note: `initialize failed: ${e.message}`,
    });
    console.error("[driver] initialize failed:", e.message);
    client.kill();
    return 2;
  }

  // 1b. authenticate (required by grok 0.1.211)
  // ACP spec: client picks one of the auth methods from the initialize
  // response and sends `authenticate` with { methodId }.
  const authMethods: Array<{ id: string }> = initResult?.authMethods ?? [];
  if (authMethods.length > 0) {
    const methodId = authMethods[0]!.id;
    try {
      const authResult = await client.request("authenticate", { methodId });
      logger.write({
        t: Date.now(),
        dir: "log",
        note: `authenticate ok methodId=${methodId} result=${JSON.stringify(authResult)}`,
      });
      console.log(`[driver] authenticate ok methodId=${methodId}`);
    } catch (e: any) {
      logger.write({
        t: Date.now(),
        dir: "log",
        note: `authenticate failed methodId=${methodId}: ${e.message}`,
      });
      console.error(`[driver] authenticate failed methodId=${methodId}:`, e.message);
      client.kill();
      return 5;
    }
  } else {
    logger.write({
      t: Date.now(),
      dir: "log",
      note: "no auth methods advertised — skipping authenticate",
    });
  }

  // 2. session/new
  let sessionId: string | undefined;
  try {
    const sn = await client.request("session/new", {
      cwd: args.cwd,
      mcpServers: [],
    });
    sessionId = sn?.sessionId ?? sn?.session_id ?? sn?.id;
    logger.write({
      t: Date.now(),
      dir: "log",
      note: `session/new ok sessionId=${sessionId}`,
    });
    console.log(`[driver] session/new ok sessionId=${sessionId}`);
  } catch (e: any) {
    logger.write({
      t: Date.now(),
      dir: "log",
      note: `session/new failed: ${e.message}`,
    });
    console.error("[driver] session/new failed:", e.message);
    client.kill();
    return 3;
  }

  // 3. send each prompt sequentially
  let promptExit = 0;
  for (const prompt of args.prompts) {
    logger.write({
      t: Date.now(),
      dir: "log",
      note: `send session/prompt: ${prompt}`,
    });
    console.log(`[driver] prompt: ${JSON.stringify(prompt)}`);
    try {
      const result = await client.request(
        "session/prompt",
        {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        },
        args.promptTimeoutMs,
      );
      logger.write({
        t: Date.now(),
        dir: "log",
        note: `session/prompt result: ${JSON.stringify(result)}`,
      });
      console.log("[driver] prompt complete");
    } catch (e: any) {
      logger.write({
        t: Date.now(),
        dir: "log",
        note: `session/prompt failed: ${e.message}`,
      });
      console.error("[driver] prompt failed:", e.message);
      promptExit = 4;
      break;
    }
  }

  client.kill();
  // Brief settle so the child exit line lands in the log.
  await new Promise((r) => setTimeout(r, 500));
  logger.write({ t: Date.now(), dir: "log", note: "driver end" });
  console.log(`[driver] done. evidence: ${evidencePath}`);
  return promptExit;
}

// ─────────── Mode B: drive the running Tauri app over the debug WS ───────────

interface AppModeOptions {
  baseUrl: string;             // e.g. http://127.0.0.1:<debug-port>
  wsUrl: string;               // e.g. ws://127.0.0.1:<debug-port>/events?token=...
  token: string;               // P-Review-C2: bearer token for all non-/health endpoints
}

/**
 * Resolve the debug-api bearer token in the same order the Rust server
 * uses (debug_api.rs::resolve_or_create_debug_token):
 *   1. --token CLI flag
 *   2. GROK_SHELL_DEBUG_SECRET env var
 *   3. ~/.shellx/shellxagent.token  (auto-created by the running app)
 *
 * Cross-platform home: uses `shellxHome()` so WSL-side runs can still
 * discover the live token when shellX is running on the Windows host.
 *
 * Empty string means "no token configured yet" — we'll still try /health,
 * but anything else will 401. Surfacing that as a clear error message
 * beats silent failures.
 */
function resolveDebugToken(args: CliArgs): string {
  const cliToken = (args as any).token;
  if (typeof cliToken === "string" && cliToken.length > 0) return cliToken;
  const envToken = process.env.GROK_SHELL_DEBUG_SECRET;
  if (envToken && envToken.length > 0) return envToken;
  // Canonical token file (since the rename from ~/.grok-shell/debug.token).
  // Try the live name first, then the legacy name as a safety net for
  // users on builds that predate the auto-migration.
  const candidates = [
    shellxHome("shellxagent.token"),
    shellxHome("debug.token"),
  ];
  for (const tokenPath of candidates) {
    try {
      const raw = readFileSync(tokenPath, "utf8").trim();
      if (raw.length >= 32) return raw;
    } catch {
      // file missing — try next candidate
    }
  }
  return "";
}

/**
 * Resolve the live debug-api port. Order:
 *   1. --debug-port CLI flag
 *   2. GROK_SHELL_DEBUG_PORT env var (matches what the server reads)
 *   3. ~/.shellx/debug-api.port  (published atomically by the server
 *      after a successful bind — survives 5757→5759 fallback steps)
 *   4. 5757 fallback
 *
 * Cross-platform home via `shellxHome()` so WSL-side driver runs can
 * discover the live bound port from the Windows-hosted app.
 */
function resolveDebugPort(args: CliArgs): number {
  const cliPort = Number((args as any)["debug-port"]);
  if (Number.isFinite(cliPort) && cliPort > 0) return cliPort;
  const envPort = Number(process.env.GROK_SHELL_DEBUG_PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  try {
    const portFile = shellxHome("debug-api.port");
    const raw = readFileSync(portFile, "utf8").trim();
    const p = Number(raw);
    if (Number.isFinite(p) && p > 0 && p < 65536) return p;
  } catch {
    // server hasn't published a bound port yet — fall through
  }
  return 5757;
}

function appOptions(args: CliArgs): AppModeOptions {
  const port = resolveDebugPort(args);
  const token = resolveDebugToken(args);
  const wsUrl = token
    ? `ws://127.0.0.1:${port}/events?token=${encodeURIComponent(token)}`
    : `ws://127.0.0.1:${port}/events`;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl,
    token,
  };
}

function authHeaders(opts: AppModeOptions): Record<string, string> {
  return opts.token ? { Authorization: `Bearer ${opts.token}` } : {};
}

async function waitForHealth(opts: AppModeOptions, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      // /health is intentionally unauthenticated (liveness probe).
      const r = await fetch(`${opts.baseUrl}/health`);
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function runAppMode(args: CliArgs): Promise<number> {
  const opts = appOptions(args);
  const evidencePath = nextSessionPath(args.evidenceDir);
  console.log(`[driver] mode=app evidence=${evidencePath} ws=${opts.wsUrl}`);
  const logger = new JsonlWriter(evidencePath);
  logger.write({
    t: Date.now(),
    dir: "log",
    note: `driver start mode=app baseUrl=${opts.baseUrl}`,
  });

  // 0. wait for app to be up
  const up = await waitForHealth(opts, 60_000);
  if (!up) {
    logger.write({
      t: Date.now(),
      dir: "log",
      note: "app not reachable on /health within 60s — start it with `pnpm tauri:dev -- --features debug-api`",
    });
    console.error(
      "[driver] app /health unreachable — is the Tauri app running with --features debug-api?",
    );
    return 6;
  }

  // 1. WS subscriber — mirrors every backend event into JSONL just like Mode A.
  // Node 22+ ships a global WebSocket; if missing, this errors at runtime —
  // bump Node or polyfill ws package.
  const ws = new WebSocket(opts.wsUrl);
  let promptCompleteSeen = false;
  let promptCompleteWaiters: Array<() => void> = [];
  const resolvePromptWaiters = () => {
    const waiters = promptCompleteWaiters;
    promptCompleteWaiters = [];
    for (const resolve of waiters) resolve();
  };
  const waitForPromptComplete = () =>
    new Promise<void>((resolve) => {
      promptCompleteWaiters.push(resolve);
    });
  ws.addEventListener("message", (msg: MessageEvent) => {
      let parsed: any;
      try {
        parsed = JSON.parse(String(msg.data));
      } catch {
        logger.write({
          t: Date.now(),
          dir: "in",
          raw: String(msg.data),
          note: "ws-json-parse-failed",
        });
        return;
      }
      // Mode A logs the inner JSON-RPC frame as `frame`; Mode B's events are
      // already wrapped { t, kind, payload } by debug_api.rs. We store the
      // wrapped envelope so the two formats are distinguishable but both
      // self-describing. Notification echo on stdout still works.
      logger.write({ t: Date.now(), dir: "in", frame: parsed });

      // Watch for _x.ai/session/prompt_complete to know when we can wrap up.
      const m = parsed?.payload?.method;
      if (m === "_x.ai/session/prompt_complete") {
        promptCompleteSeen = true;
        process.stdout.write(`  · prompt_complete\n`);
        resolvePromptWaiters();
      } else if (parsed?.kind === "session-ended") {
        resolvePromptWaiters();
      } else if (typeof m === "string") {
        const su = parsed?.payload?.params?.update?.sessionUpdate;
        process.stdout.write(`  · ${su ? `${m}/${su}` : m}\n`);
      }
    });
    ws.addEventListener("close", () => {
      logger.write({ t: Date.now(), dir: "log", note: "ws closed" });
      resolvePromptWaiters();
    });
    ws.addEventListener("error", () => {
      logger.write({ t: Date.now(), dir: "log", note: "ws error" });
      resolvePromptWaiters();
    });

  // Wait for WS open.
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
    ws.addEventListener("error", (e) => {
      clearTimeout(t);
      reject(new Error(`ws error: ${(e as any)?.message ?? "unknown"}`));
    }, { once: true });
  });
  logger.write({ t: Date.now(), dir: "log", note: "ws open" });
  console.log("[driver] ws connected");

  // 2. /connect — idempotent; if the user already clicked Connect in the UI,
  // grok will reject with "already running" and we just proceed.
  try {
    const connectRes = await fetch(`${opts.baseUrl}/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(opts) },
      body: JSON.stringify({ cwd: args.cwd }),
    });
    const text = await connectRes.text();
    logger.write({
      t: Date.now(),
      dir: "log",
      note: `connect http ${connectRes.status}: ${text.slice(0, 200)}`,
    });
    if (!connectRes.ok) {
      console.warn(`[driver] /connect returned ${connectRes.status}: ${text}`);
      // not necessarily fatal — if session already active, /prompt will still work
    } else {
      console.log("[driver] /connect ok");
    }
  } catch (e: any) {
    logger.write({
      t: Date.now(),
      dir: "log",
      note: `connect fetch failed: ${e.message}`,
    });
    console.error("[driver] /connect failed:", e.message);
    try { ws.close(); } catch { /* ignore */ }
    return 7;
  }

  // 3. For each prompt: POST /prompt, wait for prompt_complete (or timeout).
  for (const prompt of args.prompts) {
    promptCompleteSeen = false;
    const promptComplete = waitForPromptComplete();
    logger.write({ t: Date.now(), dir: "log", note: `send /prompt: ${prompt}` });
    console.log(`[driver] prompt: ${JSON.stringify(prompt)}`);
    try {
      // Bearer auth required on /prompt (and every endpoint except
      // /health). authHeaders() returns the spread-friendly object.
      const r = await fetch(`${opts.baseUrl}/prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(opts),
        },
        body: JSON.stringify({ prompt }),
      });
      const text = await r.text();
      logger.write({
        t: Date.now(),
        dir: "log",
        note: `prompt http ${r.status}: ${text.slice(0, 200)}`,
      });
      if (!r.ok) {
        console.error(`[driver] /prompt failed: ${r.status} ${text}`);
        break;
      }
    } catch (e: any) {
      logger.write({
        t: Date.now(),
        dir: "log",
        note: `prompt fetch failed: ${e.message}`,
      });
      console.error("[driver] /prompt fetch failed:", e.message);
      break;
    }

    // Wait for prompt_complete, bounded by the user's timeout.
    const completed = await Promise.race([
      promptComplete.then(() => true),
      new Promise<boolean>((res) =>
        setTimeout(() => res(false), args.promptTimeoutMs),
      ),
    ]);
    if (!completed && !promptCompleteSeen) {
      logger.write({
        t: Date.now(),
        dir: "log",
        note: `prompt_complete not observed within ${args.promptTimeoutMs}ms`,
      });
      console.warn("[driver] prompt timed out (no prompt_complete event)");
    } else {
      console.log("[driver] prompt complete");
    }
  }

  try { ws.close(); } catch { /* ignore */ }
  // Brief drain so trailing WS messages land before exit.
  await new Promise((r) => setTimeout(r, 300));
  logger.write({ t: Date.now(), dir: "log", note: "driver end" });
  console.log(`[driver] done. evidence: ${evidencePath}`);
  return 0;
}

// ───────────────────────── Main ─────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  if (args.mode === "stdio") {
    return runStdioMode(args);
  }
  if (args.mode === "app") {
    return runAppMode(args);
  }
  console.error(`[driver] unknown --mode=${args.mode}`);
  return 64;
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((e) => {
    console.error("[driver] fatal:", e);
    process.exit(1);
  });
