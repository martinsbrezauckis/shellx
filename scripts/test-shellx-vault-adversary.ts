import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { shellxDataPaths } from "./shellx-debug-paths";

type JsonObject = Record<string, unknown>;

interface BrowserTask {
  taskId: string;
  profileId: string;
}

interface BrowserTab {
  browserTabId: string;
  taskId?: string | null;
  profileId: string;
  url?: string | null;
  status: string;
}

interface BrowserState {
  tabs?: BrowserTab[];
  activeBrowserTabId?: string | null;
  engine?: {
    mounted: boolean;
    url?: string | null;
    title?: string | null;
    loadStatus: string;
    lastError?: string | null;
  } | null;
}

interface BrowserActionResponse {
  ok: boolean;
  status: string;
  message?: string | null;
  receipt?: { kind?: string; evidence?: JsonObject };
  observation?: {
    refs?: Array<{
      refId: string;
      selector?: string | null;
      label?: string | null;
      name?: string | null;
      role?: string | null;
      value?: string | null;
      visible?: boolean;
      enabled?: boolean;
      editable?: boolean;
    }>;
    formFields?: Array<{
      refId?: string | null;
      selector?: string | null;
      label: string;
      fieldKind: string;
      value?: string | null;
    }>;
  } | null;
}

interface BrowserTraceBundleResponse {
  traceId: string;
  taskId?: string | null;
  path: string;
  bytes: number;
  sha256: string;
  source: string;
  receipt: { kind: string };
}

interface CaptureEntry {
  t: number;
  route: string | null;
  kind: string;
  valueSeen: boolean;
  valueHash: string | null;
  note: string | null;
}

interface CaptureResponse {
  captures: CaptureEntry[];
}

interface DebugContext {
  base: string;
  token: string;
  port: string;
}

interface FixtureServer {
  baseUrl: string;
  routeUrl: string;
  close: () => Promise<void>;
}

const EVIDENCE_ROOT = process.env.SHELLX_BROWSER_EVIDENCE_ROOT?.trim()
  || join(homedir(), ".shellx", "evidence");
const EVIDENCE_OUT = join(EVIDENCE_ROOT, "browser-adversary");
const ALLOWED_PAGE_FIELD_CAPTURE_KINDS = new Set(["input", "change", "keydown", "mutation"]);

function readFirst(paths: string[]): string | null {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const value = readFileSync(path, "utf8").trim();
    if (value) return value;
  }
  return null;
}

function debugBase(): DebugContext {
  const explicitBase = process.env.SHELLX_DEBUG_BASE?.trim();
  const port = process.env.SHELLX_DEBUG_PORT?.trim()
    ?? readFirst(shellxDataPaths("debug-api.port"));
  const token = process.env.SHELLX_DEBUG_SECRET?.trim()
    ?? process.env.SHELLX_DEBUG_TOKEN?.trim()
    ?? readFirst(shellxDataPaths("shellxagent.token"))
    ?? readFirst(shellxDataPaths("debug.token"));
  if (!explicitBase && !port) {
    throw new Error("ShellX debug API port not found. Start the installed app or set SHELLX_DEBUG_BASE.");
  }
  if (!token) {
    throw new Error("ShellX debug API token not found. Set SHELLX_DEBUG_SECRET or start the installed app.");
  }
  const base = explicitBase ?? `http://127.0.0.1:${port}`;
  let resolvedPort = port ?? "";
  try {
    resolvedPort = new URL(base).port || resolvedPort;
  } catch {
    // Keep the file-sourced port for clearer fixture probing if explicit base is malformed.
  }
  if (!resolvedPort) throw new Error(`Could not resolve Debug API port from ${base}`);
  return { base, token, port: resolvedPort };
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api<T>(ctx: DebugContext, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ctx.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `${method} ${path} could not reach ${ctx.base}. Start ShellX with Debug API enabled, then rerun pnpm test:shellx-vault-adversary. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text();
  let parsed: unknown = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} failed with ${res.status}: ${text.slice(0, 800)}`);
  }
  return parsed as T;
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 20_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== null) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`);
}

function hostReadablePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (driveMatch) return `/mnt/${driveMatch[1]!.toLowerCase()}/${driveMatch[2]}`;
  return path;
}

function containsSentinel(value: unknown, sentinel: string): boolean {
  return JSON.stringify(value).includes(sentinel);
}

function assertNoSentinel(label: string, value: unknown, sentinel: string): void {
  assert(!containsSentinel(value, sentinel), `${label} does not expose the raw adversary sentinel`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function activeTaskTab(state: BrowserState, taskId: string): BrowserTab | null {
  return state.tabs?.find((tab) => tab.browserTabId === state.activeBrowserTabId && tab.taskId === taskId) ?? null;
}

async function browserAction(ctx: DebugContext, taskId: string, body: JsonObject): Promise<BrowserActionResponse> {
  return await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId,
    ...body,
  });
}

async function waitForBrowserEngine(ctx: DebugContext, expectedUrl: string, taskId: string): Promise<BrowserState> {
  return await waitFor("adversary fixture Browser engine load", async () => {
    const state = await api<BrowserState>(ctx, "GET", "/browser/state");
    const active = activeTaskTab(state, taskId);
    if (!active) return null;
    if (state.engine?.lastError) throw new Error(state.engine.lastError);
    if (!state.engine?.mounted || !state.engine.url?.startsWith(expectedUrl)) return null;
    return ["loaded", "observed", "screenshotCaptured"].includes(state.engine.loadStatus) ? state : null;
  }, 20_000, 500);
}

function closeChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) return resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function startFixture(ctx: DebugContext): Promise<FixtureServer> {
  const child = spawn(process.execPath, ["scripts/fixtures/vault-browser-site/server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`fixture server did not print a URL. stderr=${stderr.slice(-800)}`));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match?.[1]) return;
      clearTimeout(timeout);
      resolve(`http://127.0.0.1:${match[1]}`);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`fixture server exited before ready with code ${code}. stderr=${stderr.slice(-800)}`));
    });
    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
  return {
    baseUrl,
    routeUrl: `${baseUrl}/adversary?debugPort=${encodeURIComponent(ctx.port)}`,
    close: () => closeChild(child),
  };
}

async function fetchCaptures(fixture: FixtureServer): Promise<CaptureEntry[]> {
  const response = await fetch(`${fixture.baseUrl}/capture`, { headers: { "cache-control": "no-store" } });
  if (!response.ok) throw new Error(`GET /capture failed with ${response.status}: ${await response.text()}`);
  const body = await response.json() as CaptureResponse;
  return body.captures;
}

function classifyCaptures(captures: CaptureEntry[], sentinelHash: string): {
  allowedFieldCaptures: CaptureEntry[];
  boundaryLeaks: CaptureEntry[];
  debugApiFailures: CaptureEntry[];
} {
  const allowedFieldCaptures = captures.filter((entry) =>
    entry.valueHash === sentinelHash
    && entry.route === "/adversary"
    && ALLOWED_PAGE_FIELD_CAPTURE_KINDS.has(entry.kind)
    && String(entry.note ?? "").includes("visible field")
  );
  const boundaryLeaks = captures.filter((entry) =>
    entry.valueHash === sentinelHash
    && !allowedFieldCaptures.includes(entry)
  );
  const debugApiFailures = captures.filter((entry) => entry.kind === "debug-api-fetch");
  return { allowedFieldCaptures, boundaryLeaks, debugApiFailures };
}

function publicCaptureSummary(captures: CaptureEntry[]): JsonObject[] {
  return captures.map((entry) => ({
    t: entry.t,
    route: entry.route,
    kind: entry.kind,
    valueSeen: entry.valueSeen,
    valueHashPrefix: entry.valueHash ? entry.valueHash.slice(0, 12) : null,
    note: entry.note,
  }));
}

async function main(): Promise<void> {
  console.log("\n=== ShellX Vault Browser adversary smoke ===");
  const ctx = debugBase();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = process.env.SHELLX_BROWSER_ADVERSARY_OUT ?? join(EVIDENCE_OUT, stamp);
  mkdirSync(outDir, { recursive: true });
  const sentinel = `SXV_E2E_SECRET_BROWSER_ADV_${Date.now()}_${randomBytes(8).toString("hex")}`;
  const sentinelHash = sha256(sentinel);
  let fixture: FixtureServer | null = null;
  let tabId: string | null = null;

  try {
    const health = await api<JsonObject>(ctx, "GET", "/health");
    assert(Boolean(health), "debug API health responds");
    const unauthenticated = await fetch(`${ctx.base}/browser/state`).catch(() => null);
    assert(
      unauthenticated === null || [401, 403].includes(unauthenticated.status),
      "Debug API rejects browser state without the bearer token",
    );

    fixture = await startFixture(ctx);
    const opened = await api<{ ok: boolean }>(ctx, "POST", "/browser/open", {
      startUrl: fixture.routeUrl,
    });
    assert(opened.ok, "Browser window opens for adversary fixture");

    const task = await api<BrowserTask>(ctx, "POST", "/browser/task/start", {
      goal: "Adversarial Vault Browser smoke: fill a credential field without leaking secrets to ShellX surfaces",
      startUrl: fixture.routeUrl,
      profileId: "agent-work",
      autonomy: "assistedAutonomous",
      expectedDomains: ["127.0.0.1"],
    });
    assert(task.profileId === "agent-work", "adversary Browser task uses Agent Work profile");
    const loaded = await waitForBrowserEngine(ctx, fixture.routeUrl, task.taskId);
    tabId = activeTaskTab(loaded, task.taskId)?.browserTabId ?? null;
    assert(Boolean(tabId), "adversary task has an active Browser tab");

    const initialObserve = await browserAction(ctx, task.taskId, { action: "observe" });
    assert(initialObserve.status === "applied", "agent observes adversary fixture before secret fill");
    assertNoSentinel("initial observation", initialObserve, sentinel);

    const fillVisible = await browserAction(ctx, task.taskId, {
      action: "fillRef",
      selector: "#visible-secret-field",
      value: sentinel,
    });
    assert(fillVisible.status === "applied", "agent can fill the intended visible credential field");
    assertNoSentinel("fillRef response", fillVisible, sentinel);

    await waitFor("adversary page observed the intended field fill", async () => {
      const captures = await fetchCaptures(fixture!);
      return captures.some((entry) => entry.valueHash === sentinelHash) ? true : null;
    }, 8_000, 500);

    const afterFillObserve = await browserAction(ctx, task.taskId, { action: "observe" });
    assert(afterFillObserve.status === "applied", "agent observes adversary fixture after secret fill");
    assertNoSentinel("post-fill observation", afterFillObserve, sentinel);
    assert(
      afterFillObserve.observation?.refs?.some((ref) =>
        ref.selector === "#visible-secret-field"
        && ref.role === "password"
        && (ref.value === null || ref.value === undefined)
        && ref.label !== sentinel
        && ref.name !== sentinel
      ) === true,
      "password refs keep value redacted and do not use the secret as label/name",
    );
    assert(
      afterFillObserve.observation?.formFields?.some((field) =>
        field.selector === "#visible-secret-field"
        && field.fieldKind === "password"
        && (field.value === null || field.value === undefined)
      ) === true,
      "password formFields keep value redacted",
    );

    const hiddenFill = await browserAction(ctx, task.taskId, {
      action: "fillRef",
      selector: "#hidden-secret-field",
      value: sentinel,
    });
    assert(["notActionable", "notFound"].includes(hiddenFill.status), "hidden credential field cannot be filled by agent automation");
    assertNoSentinel("hidden fill response", hiddenFill, sentinel);

    const scriptLink = await browserAction(ctx, task.taskId, {
      action: "clickRef",
      selector: "a[href^='javascript:']",
    });
    assert(["applied", "blocked", "notActionable"].includes(scriptLink.status), "javascript-link trap is exercised without crashing Browser control");
    assertNoSentinel("javascript-link action response", scriptLink, sentinel);

    const captures = await waitFor("adversary captures include Debug API blocked probe", async () => {
      const next = await fetchCaptures(fixture!);
      return next.some((entry) => entry.kind === "debug-api-fetch-blocked" && String(entry.note ?? "").includes(ctx.port))
        ? next
        : null;
    }, 8_000, 500);
    assertNoSentinel("adversary capture records", captures, sentinel);
    const classified = classifyCaptures(captures, sentinelHash);
    assert(classified.allowedFieldCaptures.length > 0, "adversary fixture saw the intended website-owned field value");
    assert(classified.boundaryLeaks.length === 0, "no sentinel hash appeared in non-field adversary channels");
    assert(classified.debugApiFailures.length === 0, "hostile page script did not get authorized Debug API access");

    const state = await api<BrowserState>(ctx, "GET", "/browser/state");
    assertNoSentinel("browser state", state, sentinel);
    const receipts = await api<{ receipts: Array<JsonObject> }>(ctx, "GET", "/browser/receipts?limit=200");
    assertNoSentinel("browser receipts", receipts, sentinel);
    const logs = await api<{ logs: Array<JsonObject> }>(ctx, "GET", "/browser/logs?limit=100");
    assertNoSentinel("browser logs", logs, sentinel);

    const trace = await api<BrowserTraceBundleResponse>(ctx, "POST", "/browser/trace/export", {
      taskId: task.taskId,
      reason: "Adversary smoke verifies Browser trace redaction after credential fill",
    });
    assert(trace.receipt.kind === "browserTraceBundleExported", "trace export returns a Browser trace receipt");
    const tracePath = hostReadablePath(trace.path);
    assert(existsSync(tracePath), `trace bundle exists on host path ${basename(tracePath)}`);
    const traceBody = readFileSync(tracePath, "utf8");
    assert(!traceBody.includes(sentinel), "trace bundle does not expose the raw adversary sentinel");

    const reportPath = join(outDir, "manifest.json");
    writeFileSync(reportPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      debugBase: ctx.base.replace(/:[0-9]+$/, ":<port>"),
      fixture: {
        route: "/adversary",
        baseUrl: fixture.baseUrl,
      },
      sentinelHash,
      trace: {
        traceId: trace.traceId,
        path: trace.path,
        bytes: trace.bytes,
        sha256: trace.sha256,
      },
      captures: publicCaptureSummary(captures),
      classification: {
        allowedFieldCaptureCount: classified.allowedFieldCaptures.length,
        boundaryLeakCount: classified.boundaryLeaks.length,
        debugApiFailureCount: classified.debugApiFailures.length,
      },
    }, null, 2));
    assert(!readFileSync(reportPath, "utf8").includes(sentinel), "adversary evidence manifest omits the raw sentinel");

    console.log(`Adversary smoke evidence: ${outDir}`);
    console.log("ShellX Vault Browser adversary smoke passed");
  } finally {
    if (tabId) {
      await api<JsonObject>(ctx, "POST", "/browser/tabs/close", { browserTabId: tabId }).catch(() => undefined);
    }
    await fixture?.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
