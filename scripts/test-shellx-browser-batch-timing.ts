import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { cleanupOwnedBrowserLifecycle } from "./shellx-browser-test-cleanup";
import { debugApiConnectionCandidates, shellxHomeCandidates } from "./shellx-debug-paths";

type JsonObject = Record<string, unknown>;

interface DebugContext {
  base: string;
  token: string;
  source: string;
}

interface McpContext {
  base: string;
  token: string;
  tabId: string;
  source: string;
}

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
    loadStatus: string;
    lastError?: string | null;
  } | null;
}

interface McpToolResult {
  isError?: boolean;
  structuredContent?: JsonObject;
  content?: Array<{ type?: string; text?: string }>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: McpToolResult;
  error?: {
    code: number;
    message: string;
  };
}

interface Fixture {
  baseUrl: string;
  routeUrl: string;
  blankUrl: string;
  close: () => Promise<void>;
}

interface Sample {
  label: string;
  ms: number;
  steps: number;
}

const API_TIMEOUT_MS = Number(process.env.SHELLX_BATCH_TIMING_API_TIMEOUT_MS ?? 30_000);
const ITERATIONS = Math.max(1, Math.min(Number(process.env.SHELLX_BATCH_TIMING_ITERATIONS ?? 3) || 3, 12));
const TAB_ID = process.env.SHELLX_BATCH_TIMING_TAB_ID?.trim() || "shellx-batch-timing";

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

function readTrim(path: string): string | null {
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf8").trim();
  return value || null;
}

function readDebugCandidates(): DebugContext[] {
  return debugApiConnectionCandidates();
}

function tabBoundMcpToken(baseToken: string, tabId: string): string {
  const digest = createHash("sha256")
    .update("shellx-mcp-tab-token-v1\0")
    .update(baseToken)
    .update("\0")
    .update(tabId)
    .digest("hex");
  return `sx_tab_${digest}`;
}

function readMcpCandidates(tabId: string): McpContext[] {
  const explicitBase = process.env.SHELLX_MCP_BASE?.trim();
  const baseToken = process.env.SHELLX_MCP_BASE_TOKEN?.trim()
    ?? process.env.SHELLX_MCP_SECRET?.trim();
  if (explicitBase) {
    if (!baseToken && !process.env.SHELLX_MCP_TOKEN?.trim()) {
      throw new Error("SHELLX_MCP_BASE requires SHELLX_MCP_BASE_TOKEN/SHELLX_MCP_SECRET or SHELLX_MCP_TOKEN.");
    }
    const token = process.env.SHELLX_MCP_TOKEN?.trim() || tabBoundMcpToken(baseToken ?? "", tabId);
    return [{ base: explicitBase, token, tabId, source: "env:SHELLX_MCP_BASE" }];
  }
  const explicitPort = process.env.SHELLX_MCP_PORT?.trim();
  return shellxHomeCandidates()
    .map((dir) => {
      const port = explicitPort ?? readTrim(join(dir, "mcp-http.port"));
      const pairedBaseToken = baseToken ?? readTrim(join(dir, "mcp.token"));
      if (!port || (!pairedBaseToken && !process.env.SHELLX_MCP_TOKEN?.trim())) return null;
      return {
        base: `http://127.0.0.1:${port}`,
        token: process.env.SHELLX_MCP_TOKEN?.trim() || tabBoundMcpToken(pairedBaseToken ?? "", tabId),
        tabId,
        source: explicitPort ? `env:SHELLX_MCP_PORT + ${dir}` : dir,
      };
    })
    .filter((candidate): candidate is McpContext => Boolean(candidate));
}

async function httpJson<T>(
  base: string,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${method} ${path} could not reach ${base} within ${API_TIMEOUT_MS}ms: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}: ${text.slice(0, 1200)}`);
  }
  if (!text.trim()) return JSON.parse("{}") as T;
  return JSON.parse(text) as T;
}

function debugApi<T>(ctx: DebugContext, method: string, path: string, body?: unknown): Promise<T> {
  return httpJson<T>(ctx.base, ctx.token, method, path, body);
}

async function firstHealthyDebug(candidates: DebugContext[]): Promise<DebugContext> {
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      await debugApi<JsonObject>(candidate, "GET", "/health");
      return candidate;
    } catch (err) {
      errors.push(`${candidate.base} (${candidate.source}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    [
      "No reachable ShellX Debug API candidate found.",
      "Start the installed ShellX app or set SHELLX_DEBUG_BASE/SHELLX_DEBUG_SECRET.",
      ...errors,
    ].join("\n"),
  );
}

async function firstHealthyMcp(candidates: McpContext[]): Promise<McpContext> {
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      await httpJson<JsonObject>(candidate.base, null, "GET", "/health");
      return candidate;
    } catch (err) {
      errors.push(`${candidate.base} (${candidate.source}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    [
      "No reachable ShellX MCP HTTP candidate found.",
      "Start the installed ShellX app or set SHELLX_MCP_BASE/SHELLX_MCP_BASE_TOKEN.",
      ...errors,
    ].join("\n"),
  );
}

async function mcpCall(
  ctx: McpContext,
  name: string,
  args: JsonObject,
  options: { allowToolError?: boolean } = {},
): Promise<McpToolResult> {
  const request = {
    jsonrpc: "2.0",
    id: `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    method: "tools/call",
    params: {
      name,
      arguments: args,
    },
  };
  const response = await httpJson<JsonRpcResponse>(ctx.base, ctx.token, "POST", "/mcp", request, {
    "MCP-Tab-Id": ctx.tabId,
  });
  if (response.error) {
    throw new Error(`MCP ${name} failed with ${response.error.code}: ${response.error.message}`);
  }
  if (!response.result) throw new Error(`MCP ${name} returned no result`);
  if (response.result.isError && !options.allowToolError) {
    const text = response.result.content?.map((item) => item.text).filter(Boolean).join("\n") || "unknown MCP tool error";
    throw new Error(`MCP ${name} returned isError: ${text}`);
  }
  return response.result;
}

async function runContinuedFailureContractSmoke(
  debug: DebugContext,
  ctx: McpContext,
  fixture: Fixture,
  taskIds: Set<string>,
): Promise<void> {
  const task = await startTask(debug, fixture, "continued batch failure contract", taskIds);
  const steps: JsonObject[] = [
    { action: "navigate", url: fixture.routeUrl, timeoutMs: 30_000 },
    { action: "unsupportedContractProbe" },
    { action: "waitFor", value: "ShellX workflow matrix ready", timeoutMs: 5_000 },
  ];
  const result = await mcpCall(ctx, "browser_run_steps", {
    taskId: task.taskId,
    steps,
    continueOnError: true,
    timeoutMs: 30_000,
  }, { allowToolError: true });
  const structured = result.structuredContent ?? {};
  assert(result.isError === true, "browser_run_steps reports MCP isError when a continued step fails");
  assert(structured.ok === false, "browser_run_steps aggregate ok stays false after a continued failure");
  assert(structured.stepsPlanned === 3 && structured.stepsRun === 3, "browser_run_steps continues after a validation failure when requested");
  assert(structured.stepsSucceeded === 2 && structured.stepsFailed === 1, "browser_run_steps reports truthful success and failure counts");
  assert(structured.continuedAfterFailure === true, "browser_run_steps records that execution continued after failure");
  assert(structured.stoppedAt === null, "browser_run_steps reserves stoppedAt for an early stop");
  const failures = Array.isArray(structured.failureSummary) ? structured.failureSummary : [];
  assert(failures.length === 1 && (failures[0] as JsonObject)?.failureKind === "validation", "browser_run_steps returns a stable validation failure summary");
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    for (const socket of sockets) socket.destroy();
    server.close((err) => err ? reject(err) : resolve());
  });
}

async function startWorkflowFixture(): Promise<Fixture> {
  const fixturePath = join(process.cwd(), "scripts", "fixtures", "vault-browser-site", "public", "workflow-matrix.html");
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/blank") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end("<!doctype html><title>ShellX batch timing blank</title><p>Blank timing start</p>");
      return;
    }
    if (req.method === "GET" && url.pathname === "/workflow-matrix") {
      const html = await readFile(fixturePath, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/recovery-smoke") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(`<!doctype html>
        <title>ShellX recovery smoke</title>
        <main>
          <h1>ShellX recovery smoke ready</h1>
          <button data-testid="recover-target" onclick="document.querySelector('#status').textContent = 'Recovered click';">Recover action</button>
          <p id="status">Waiting for stale ref recovery</p>
        </main>`);
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "fixture route not found" }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("workflow fixture did not bind to a TCP port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    routeUrl: `${baseUrl}/workflow-matrix`,
    blankUrl: `${baseUrl}/blank`,
    close: () => closeServer(server, sockets),
  };
}

function elapsedMs(startMs: number): number {
  return Math.max(0, Math.round(performance.now() - startMs));
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 20_000,
  intervalMs = 300,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown = null;
  while (performance.now() < deadline) {
    try {
      const value = await fn();
      if (value !== null) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function waitForBrowserEngine(ctx: DebugContext, expectedUrl: string, taskId: string): Promise<BrowserState> {
  return waitFor("Browser batch timing engine load", async () => {
    const state = await debugApi<BrowserState>(ctx, "GET", "/browser/state");
    const active = state.tabs?.find((tab) => tab.browserTabId === state.activeBrowserTabId);
    if (active?.taskId !== taskId) return null;
    if (!state.engine?.mounted || !state.engine.url?.startsWith(expectedUrl)) return null;
    if (state.engine.loadStatus === "error") throw new Error(state.engine.lastError ?? "Browser engine error");
    return ["loaded", "observed", "screenshotCaptured"].includes(state.engine.loadStatus) ? state : null;
  });
}

async function startTask(
  ctx: DebugContext,
  fixture: Fixture,
  label: string,
  taskIds: Set<string>,
): Promise<BrowserTask> {
  const task = await debugApi<BrowserTask>(ctx, "POST", "/browser/task/start", {
    goal: `Browser batch timing ${label}`,
    startUrl: fixture.blankUrl,
    profileId: "agent-work",
    autonomy: "assistedAutonomous",
    expectedDomains: ["127.0.0.1"],
  });
  taskIds.add(task.taskId);
  await waitForBrowserEngine(ctx, fixture.blankUrl, task.taskId);
  return task;
}

function timedSteps(fixture: Fixture): JsonObject[] {
  return [
    { action: "navigate", url: fixture.routeUrl, timeoutMs: 30_000 },
    { action: "waitFor", value: "ShellX workflow matrix ready", timeoutMs: 5_000 },
    { action: "clickRef", selector: "[data-testid=cookie-accept]", timeoutMs: 5_000 },
    { action: "clickRef", selector: "[data-testid=nav-dashboard]", timeoutMs: 5_000 },
    { action: "clickRef", selector: "[data-testid=refresh-dashboard]", timeoutMs: 5_000 },
    { action: "waitFor", value: "Latest usage score", timeoutMs: 5_000 },
    { action: "clickRef", selector: "[data-testid=sort-usage]", timeoutMs: 5_000 },
    { action: "verify", key: "text", value: "Usage sorted descending", timeoutMs: 5_000 },
  ];
}

function toolForStep(step: JsonObject): string {
  switch (step.action) {
    case "navigate": return "browser_navigate";
    case "waitFor": return "browser_wait_for";
    case "clickRef": return "browser_click_ref";
    case "verify": return "browser_verify";
    default: throw new Error(`No MCP tool mapping for timing action ${String(step.action)}`);
  }
}

async function runSequential(ctx: McpContext, taskId: string, fixture: Fixture): Promise<Sample> {
  const start = performance.now();
  const steps = timedSteps(fixture);
  for (const step of steps) {
    const { action: _action, ...args } = step;
    await mcpCall(ctx, toolForStep(step), {
      taskId,
      ...args,
    });
  }
  return { label: "sequential", ms: elapsedMs(start), steps: steps.length };
}

async function runBatched(ctx: McpContext, taskId: string, fixture: Fixture): Promise<Sample> {
  const steps = timedSteps(fixture);
  const start = performance.now();
  const result = await mcpCall(ctx, "browser_run_steps", {
    taskId,
    steps,
    timeoutMs: 30_000,
  });
  const structured = result.structuredContent ?? {};
  assert(structured.ok === true, "browser_run_steps reports ok");
  assert(structured.stepsRun === steps.length, "browser_run_steps runs all planned timing steps");
  return { label: "batched", ms: elapsedMs(start), steps: steps.length };
}

async function runStrictLocatorRecoverySmoke(
  debug: DebugContext,
  ctx: McpContext,
  fixture: Fixture,
  taskIds: Set<string>,
): Promise<void> {
  const task = await startTask(debug, fixture, "strict locator recovery", taskIds);
  const routeUrl = `${fixture.baseUrl}/recovery-smoke`;
  await mcpCall(ctx, "browser_navigate", {
    taskId: task.taskId,
    url: routeUrl,
    timeoutMs: 30_000,
  });
  await mcpCall(ctx, "browser_wait_for", {
    taskId: task.taskId,
    value: "ShellX recovery smoke ready",
    timeoutMs: 5_000,
  });
  await mcpCall(ctx, "browser_observe", {
    taskId: task.taskId,
    maxRefs: 20,
    timeoutMs: 5_000,
  });
  const recoveredClick = await mcpCall(ctx, "browser_click_ref", {
    taskId: task.taskId,
    refId: "dom-stale-click-ref",
    timeoutMs: 5_000,
  });
  const structured = recoveredClick.structuredContent ?? {};
  const recovery = structured.mcpRecovery as JsonObject | undefined;
  assert(structured.ok === true, "browser_click_ref stale-ref recovery applies through MCP");
  assert(
    recovery?.strategy === "strictLocator",
    "browser_click_ref stale-ref recovery reports strictLocator evidence",
  );
  assert(recovery?.ok === true, "browser_click_ref stale-ref recovery reports successful retry evidence");
  await mcpCall(ctx, "browser_wait_for", {
    taskId: task.taskId,
    value: "Recovered click",
    timeoutMs: 5_000,
  });
}

async function runExpandedGenericBatchSmoke(
  debug: DebugContext,
  ctx: McpContext,
  fixture: Fixture,
  taskIds: Set<string>,
): Promise<void> {
  const task = await startTask(debug, fixture, "expanded generic batch actions", taskIds);
  const steps: JsonObject[] = [
    { action: "navigate", url: fixture.routeUrl, timeoutMs: 30_000 },
    { action: "waitFor", value: "ShellX workflow matrix ready", timeoutMs: 5_000 },
    { action: "clickRef", selector: "[data-testid=cookie-accept]", timeoutMs: 5_000 },
    { action: "clickRef", selector: "[data-testid=nav-developer]", timeoutMs: 5_000 },
    { action: "select", selector: "[data-testid=project-select]", value: "demo-api", timeoutMs: 5_000 },
    { action: "clickRef", selector: "[data-testid=api-open]", timeoutMs: 5_000 },
    { action: "waitFor", value: "API keys ready for selected project", timeoutMs: 5_000 },
    { action: "findText", query: "API keys ready", timeoutMs: 5_000 },
    { action: "clickRef", selector: "[data-testid=nav-dashboard]", timeoutMs: 5_000 },
    { action: "scroll", selector: "[data-testid=usage-table]", timeoutMs: 5_000 },
    { action: "extractTable", selector: "[data-testid=usage-table]", timeoutMs: 5_000 },
    { action: "verify", key: "text", value: "Search", timeoutMs: 5_000 },
    { action: "navigate", url: fixture.blankUrl, timeoutMs: 30_000 },
    { action: "waitFor", value: "Blank timing start", timeoutMs: 5_000 },
    { action: "goBack", timeoutMs: 30_000 },
    { action: "waitFor", value: "ShellX workflow matrix ready", timeoutMs: 5_000 },
    { action: "goForward", timeoutMs: 30_000 },
    { action: "waitFor", value: "Blank timing start", timeoutMs: 5_000 },
    { action: "reload", timeoutMs: 30_000 },
    { action: "waitFor", value: "Blank timing start", timeoutMs: 5_000 },
  ];
  const result = await mcpCall(ctx, "browser_run_steps", {
    taskId: task.taskId,
    steps,
    timeoutMs: 30_000,
  });
  const structured = result.structuredContent ?? {};
  assert(structured.ok === true, "browser_run_steps expanded generic batch reports ok");
  assert(structured.stepsRun === steps.length, "browser_run_steps expanded generic batch runs every step");
  const results = Array.isArray(structured.steps) ? structured.steps : [];
  const tableStep = results.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      (entry as JsonObject).action === "extractTable",
  ) as JsonObject | undefined;
  assert(Boolean(tableStep), "browser_run_steps expanded generic batch records extractTable step");
  assert(tableStep?.ok === true, "browser_run_steps expanded generic batch applies extractTable step");
}

async function cleanupFixtureLifecycle(ctx: DebugContext, taskIds: Set<string>): Promise<void> {
  await cleanupOwnedBrowserLifecycle(
    (method, path, body) => debugApi(ctx, method, path, body),
    { taskIds, label: "browser-batch-timing" },
  );
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

async function main(): Promise<void> {
  console.log("\n=== ShellX Browser Host MCP batch timing ===");
  const debug = await firstHealthyDebug(readDebugCandidates());
  const mcp = await firstHealthyMcp(readMcpCandidates(TAB_ID));
  const taskIds = new Set<string>();
  let fixture: Fixture | null = null;
  const sequential: Sample[] = [];
  const batched: Sample[] = [];
  try {
    console.log(`Using Debug API ${debug.base} (${debug.source})`);
    console.log(`Using MCP HTTP ${mcp.base} (${mcp.source})`);
    await debugApi<JsonObject>(debug, "POST", "/state/ui", {
      activeTabId: TAB_ID,
      openTabs: [{ tabId: TAB_ID, title: "Browser batch timing" }],
      source: "release-test",
    });
    assert(true, `disposable test tab ${TAB_ID} is registered before tab-scoped autonomy`);
    await debugApi<JsonObject>(debug, "POST", `/autonomy?tabId=${encodeURIComponent(TAB_ID)}`, {
      tabId: TAB_ID,
      mode: "bypassPermissions",
    });
    assert(true, `test tab ${TAB_ID} is in bypassPermissions for non-interactive MCP write-class timing`);

    fixture = await startWorkflowFixture();
    await debugApi<JsonObject>(debug, "POST", "/browser/open", { startUrl: fixture.blankUrl });
    await runStrictLocatorRecoverySmoke(debug, mcp, fixture, taskIds);
    await cleanupFixtureLifecycle(debug, taskIds);
    await runExpandedGenericBatchSmoke(debug, mcp, fixture, taskIds);
    await cleanupFixtureLifecycle(debug, taskIds);
    await runContinuedFailureContractSmoke(debug, mcp, fixture, taskIds);
    await cleanupFixtureLifecycle(debug, taskIds);

    for (let i = 0; i < ITERATIONS; i += 1) {
      const sequentialTask = await startTask(debug, fixture, `sequential ${i + 1}`, taskIds);
      sequential.push(await runSequential(mcp, sequentialTask.taskId, fixture));
      await cleanupFixtureLifecycle(debug, taskIds);

      const batchedTask = await startTask(debug, fixture, `batched ${i + 1}`, taskIds);
      batched.push(await runBatched(mcp, batchedTask.taskId, fixture));
      await cleanupFixtureLifecycle(debug, taskIds);
    }

    const sequentialMedian = median(sequential.map((sample) => sample.ms));
    const batchedMedian = median(batched.map((sample) => sample.ms));
    assert(sequentialMedian > 0, "sequential MCP timing produced a positive median");
    assert(batchedMedian > 0, "browser_run_steps timing produced a positive median");

    console.table([
      {
        path: "sequential Host MCP calls",
        iterations: sequential.length,
        steps: sequential[0]?.steps ?? 0,
        medianMs: sequentialMedian,
        samplesMs: sequential.map((sample) => sample.ms).join(","),
      },
      {
        path: "browser_run_steps batch",
        iterations: batched.length,
        steps: batched[0]?.steps ?? 0,
        medianMs: batchedMedian,
        samplesMs: batched.map((sample) => sample.ms).join(","),
      },
    ]);
    const speedup = batchedMedian > 0 ? Number((sequentialMedian / batchedMedian).toFixed(2)) : 0;
    console.log(`browser_run_steps timing speedup: ${speedup}x median over ${ITERATIONS} iteration(s)`);
    if (speedup < 1) {
      console.warn("  ! batch path was not faster in this run; keep the evidence and compare again after control-layer changes");
    }
  } finally {
    if (fixture) {
      try {
        await cleanupFixtureLifecycle(debug, taskIds);
      } finally {
        await fixture.close().catch(() => undefined);
      }
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
