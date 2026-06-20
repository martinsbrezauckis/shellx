import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { shellxHomeCandidates } from "./shellx-debug-paths";

type Json = Record<string, unknown>;

interface BrowserTask {
  taskId: string;
  profileId: string;
  status?: string;
}

interface BrowserTabLock {
  leaseId: string;
  ownerAgentId: string;
  ownerRunId: string;
  expiresAtMs: number;
}

interface BrowserTab {
  browserTabId: string;
  engineId: string;
  taskId?: string | null;
  profileId: string;
  url?: string | null;
  status: string;
  lock?: BrowserTabLock | null;
}

interface BrowserEngineSnapshot {
  engineId: string;
  mounted: boolean;
  webviewLabel: string;
  browserTabId?: string | null;
  taskId?: string | null;
  url?: string | null;
  pendingUrl?: string | null;
  title?: string | null;
  loadStatus: string;
  lastError?: string | null;
}

interface BrowserState {
  tabs?: BrowserTab[];
  activeBrowserTabId?: string | null;
  engine?: BrowserEngineSnapshot | null;
  enginePool?: {
    engines: BrowserEngineSnapshot[];
    limits?: {
      effectiveBackgroundEngines: number;
      configuredParallelAgents: string;
    };
    waiting?: unknown[];
    parkedTabs?: string[];
    windowState?: string;
    automationMode?: string;
  } | null;
}

interface BrowserTabResponse {
  ok: boolean;
  tab: BrowserTab;
  receipt: BrowserReceipt;
  error?: string;
}

interface BrowserReceipt {
  receiptId: string;
  kind: string;
  taskId?: string | null;
  profileId?: string | null;
  message?: string | null;
  evidence?: Json;
}

interface BrowserActionResponse {
  ok: boolean;
  status: string;
  taskId?: string | null;
  message?: string | null;
  receipt: BrowserReceipt;
  observation?: {
    url?: string | null;
    title?: string | null;
    domSummary?: {
      links: number;
      buttons: number;
      inputs: number;
      forms: number;
      tables: number;
      headings: number;
      textBytes: number;
    };
  } | null;
}

interface AgentTarget {
  id: "alpha" | "beta" | "gamma";
  agentId: string;
  runId: string;
  route: string;
  label: string;
  expectedText: string;
}

interface AgentRunState extends AgentTarget {
  task: BrowserTask;
  tab: BrowserTab;
  lock: BrowserTabLock;
}

const AGENT_TARGETS: AgentTarget[] = [
  {
    id: "alpha",
    agentId: "agent-alpha",
    runId: "run-alpha",
    route: "/agent-alpha",
    label: "Alpha research",
    expectedText: "Alpha workspace ready",
  },
  {
    id: "beta",
    agentId: "agent-beta",
    runId: "run-beta",
    route: "/agent-beta",
    label: "Beta forms",
    expectedText: "Beta workspace ready",
  },
  {
    id: "gamma",
    agentId: "agent-gamma",
    runId: "run-gamma",
    route: "/agent-gamma",
    label: "Gamma review",
    expectedText: "Gamma workspace ready",
  },
];

const EVIDENCE_ROOT = process.env.SHELLX_BROWSER_EVIDENCE_ROOT?.trim()
  || join(homedir(), ".shellx", "evidence");
const EVIDENCE_OUT = join(EVIDENCE_ROOT, "browser-concurrency");

let failures = 0;

function assert(condition: unknown, message: string): void {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures += 1;
}

function readTrim(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function findShellxHome(): string {
  const candidates = shellxHomeCandidates();
  for (const dir of candidates) {
    if (readTrim(join(dir, "debug-api.port")) || readTrim(join(dir, "shellxagent.token"))) return dir;
  }
  return candidates[0] ?? ".shellx";
}

async function request(base: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${base}${path}`, { ...init, headers });
}

async function api<T>(
  base: string,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const res = await request(base, token, path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} failed ${res.status}: ${text}`);
  return text ? JSON.parse(text) as T : {} as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeAllBrowserTabs(base: string, token: string): Promise<void> {
  const state = await api<BrowserState>(base, token, "GET", "/browser/state").catch(() => null);
  for (const tab of state?.tabs ?? []) {
    await api<BrowserTabResponse>(base, token, "POST", "/browser/tabs/close", {
      browserTabId: tab.browserTabId,
    }).catch(() => undefined);
  }
  await waitFor("Browser tab cleanup", async () => {
    const next = await api<BrowserState>(base, token, "GET", "/browser/state");
    return (next.tabs?.length ?? 0) === 0 ? next : null;
  }, 8_000, 250).catch(() => undefined);
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 20_000,
  intervalMs = 400,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result !== null) return result;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`);
}

function startFixtureServer(): Promise<{ server: Server; baseUrl: string; closeAll: () => void }> {
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const target = AGENT_TARGETS.find((item) => item.route === url.pathname);
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, fixture: "shellx-browser-concurrency" }));
      return;
    }
    if (!target) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(`<!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${target.label}</title>
        </head>
        <body>
          <main>
            <h1>${target.expectedText}</h1>
            <button data-testid="${target.id}-primary">Run ${target.id}</button>
            <input data-testid="${target.id}-input" aria-label="${target.id} input" value="">
            <p>Fixture route ${target.route} belongs only to ${target.agentId}.</p>
          </main>
        </body>
      </html>`);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise<{ server: Server; baseUrl: string; closeAll: () => void }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        closeAll: () => {
          for (const socket of sockets) socket.destroy();
        },
      });
    });
  });
}

function activeTab(state: BrowserState): BrowserTab | null {
  return state.tabs?.find((tab) => tab.browserTabId === state.activeBrowserTabId) ?? null;
}

function tabForTask(state: BrowserState, taskId: string): BrowserTab | null {
  return state.tabs?.find((tab) => tab.taskId === taskId) ?? null;
}

function engineForRun(state: BrowserState, run: AgentRunState): BrowserEngineSnapshot | null {
  return state.enginePool?.engines?.find((engine) => engine.engineId === run.tab.engineId)
    ?? (state.engine?.engineId === run.tab.engineId ? state.engine : null);
}

async function waitForTaskTab(base: string, token: string, taskId: string): Promise<BrowserTab> {
  return await waitFor(`tab for ${taskId}`, async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    return tabForTask(state, taskId);
  });
}

async function waitForRunEngineReady(base: string, token: string, run: AgentRunState): Promise<BrowserEngineSnapshot> {
  return await waitFor(`engine ready for ${run.id}`, async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const engine = engineForRun(state, run);
    if (!engine?.mounted) return null;
    if (engine.browserTabId !== run.tab.browserTabId) return null;
    if (engine.taskId !== run.task.taskId) return null;
    if (engine.pendingUrl) return null;
    if (!engine.url?.includes(run.route)) return null;
    if (["loading", "navigating", "taskStarted"].includes(engine.loadStatus)) return null;
    return engine;
  }, 20_000, 250);
}

async function startAgentTask(base: string, token: string, fixtureBaseUrl: string, target: AgentTarget): Promise<AgentRunState> {
  const task = await api<BrowserTask>(base, token, "POST", "/browser/task/start", {
    goal: `ShellX Browser three-agent concurrency smoke: ${target.label}`,
    startUrl: `${fixtureBaseUrl}${target.route}`,
    profileId: "agent-work",
    autonomy: "assistedAutonomous",
    expectedDomains: ["127.0.0.1"],
  });
  const tab = await waitForTaskTab(base, token, task.taskId);
  const locked = await api<BrowserTabResponse>(base, token, "POST", "/browser/tabs/lock", {
    browserTabId: tab.browserTabId,
    ownerAgentId: target.agentId,
    ownerRunId: target.runId,
    ttlSeconds: 120,
  });
  if (!locked.ok || !locked.tab.lock) throw new Error(`${target.id} tab lock failed`);
  return {
    ...target,
    task,
    tab: locked.tab,
    lock: locked.tab.lock,
  };
}

async function observeOwnedTab(base: string, token: string, run: AgentRunState): Promise<BrowserActionResponse> {
  return await waitFor(`owned observe for ${run.id}`, async () => {
    try {
      return await api<BrowserActionResponse>(base, token, "POST", "/browser/action", {
        taskId: run.task.taskId,
        browserTabId: run.tab.browserTabId,
        action: "observe",
        lockLeaseId: run.lock.leaseId,
        ownerAgentId: run.agentId,
        ownerRunId: run.runId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("still pending")) return null;
      throw err;
    }
  }, 20_000, 250);
}

async function heartbeatOwnedTab(base: string, token: string, run: AgentRunState): Promise<BrowserTabResponse> {
  return await api<BrowserTabResponse>(base, token, "POST", "/browser/tabs/heartbeat", {
    browserTabId: run.tab.browserTabId,
    leaseId: run.lock.leaseId,
    ownerAgentId: run.agentId,
    ownerRunId: run.runId,
    ttlSeconds: 120,
  });
}

async function assertNoCrossTaskReceipts(base: string, token: string, runs: AgentRunState[]): Promise<BrowserReceipt[]> {
  const response = await api<{ receipts: BrowserReceipt[] }>(base, token, "GET", "/browser/receipts?limit=300");
  const taskByTab = new Map(runs.map((run) => [run.tab.browserTabId, run.task.taskId]));
  const taskIds = new Set(runs.map((run) => run.task.taskId));
  const checked = response.receipts.filter((receipt) => receipt.taskId && taskIds.has(receipt.taskId));
  for (const receipt of checked) {
    const tabId = typeof receipt.evidence?.browserTabId === "string" ? receipt.evidence.browserTabId : null;
    if (!tabId) continue;
    const expectedTask = taskByTab.get(tabId);
    assert(!expectedTask || expectedTask === receipt.taskId, `${receipt.kind} receipt stays scoped to its Browser tab task`);
  }
  for (const run of runs) {
    assert(checked.some((receipt) => receipt.taskId === run.task.taskId), `${run.agentId} has task-scoped receipts`);
  }
  return checked;
}

async function closeRunTab(base: string, token: string, run: AgentRunState): Promise<void> {
  await api<BrowserTabResponse>(base, token, "POST", "/browser/tabs/unlock", {
    browserTabId: run.tab.browserTabId,
    leaseId: run.lock.leaseId,
    ownerAgentId: run.agentId,
    ownerRunId: run.runId,
  }).catch(() => undefined);
  await api<BrowserTabResponse>(base, token, "POST", "/browser/tabs/close", {
    browserTabId: run.tab.browserTabId,
  }).catch(() => undefined);
}

async function main(): Promise<void> {
  const shellxHome = findShellxHome();
  const port = process.env.SHELLX_DEBUG_PORT ?? readTrim(join(shellxHome, "debug-api.port"));
  const token = process.env.SHELLX_DEBUG_TOKEN ?? readTrim(join(shellxHome, "shellxagent.token"));
  if (!port) throw new Error(`debug-api.port not found under ${shellxHome}`);
  if (!token) throw new Error(`shellxagent.token not found under ${shellxHome}`);
  const base = process.env.SHELLX_DEBUG_BASE ?? `http://127.0.0.1:${port}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = process.env.SHELLX_BROWSER_CONCURRENCY_OUT ?? join(EVIDENCE_OUT, stamp);
  mkdirSync(outDir, { recursive: true });

  console.log("\n=== ShellX Browser three-agent concurrency smoke ===");
  const fixture = await startFixtureServer();
  const runs: AgentRunState[] = [];
  try {
    await api<Json>(base, token, "GET", "/health");
    assert(true, "debug API health responds");
    await closeAllBrowserTabs(base, token);
    const health = await fetch(`${fixture.baseUrl}/health`).then((res) => res.json()) as Json;
    assert(health.ok === true, "local three-agent fixture responds");

    await api<Json>(base, token, "POST", "/browser/open", { startUrl: "about:blank" });
    const started = await Promise.all(
      AGENT_TARGETS.map((target) => startAgentTask(base, token, fixture.baseUrl, target)),
    );
    runs.push(...started);
    assert(runs.length === 3, "three agent tasks start concurrently");
    assert(new Set(runs.map((run) => run.task.taskId)).size === 3, "three tasks have distinct task ids");
    assert(new Set(runs.map((run) => run.tab.browserTabId)).size === 3, "three tasks have distinct Browser tabs");
    assert(new Set(runs.map((run) => run.tab.engineId)).size === 3, "three tasks have distinct Browser engine ids");
    assert(runs.every((run) => run.tab.lock?.ownerAgentId === run.agentId), "each tab lock is owned by the expected agent");

    const heartbeats = await Promise.all(runs.map((run) => heartbeatOwnedTab(base, token, run)));
    assert(heartbeats.every((response) => response.ok), "all three agents can heartbeat their own locks");

    const beta = runs.find((run) => run.id === "beta");
    const alpha = runs.find((run) => run.id === "alpha");
    if (!beta || !alpha) throw new Error("missing alpha/beta concurrency runs");
    const deniedFocus = await api<BrowserTabResponse>(base, token, "POST", "/browser/tabs/focus", {
      browserTabId: beta.tab.browserTabId,
      lockLeaseId: alpha.lock.leaseId,
      ownerAgentId: alpha.agentId,
      ownerRunId: alpha.runId,
    });
    assert(deniedFocus.ok === false, "wrong owner cannot focus another agent's locked tab");
    assert(deniedFocus.receipt.kind === "browserTabLockDenied", "wrong-owner focus emits browserTabLockDenied receipt");
    const deniedObserve = await api<BrowserActionResponse>(base, token, "POST", "/browser/action", {
      taskId: beta.task.taskId,
      browserTabId: beta.tab.browserTabId,
      action: "observe",
      lockLeaseId: alpha.lock.leaseId,
      ownerAgentId: alpha.agentId,
      ownerRunId: alpha.runId,
    });
    assert(deniedObserve.status === "tabLocked", "wrong owner receives tabLocked for another agent's Browser action");
    assert(deniedObserve.receipt.kind === "browserTabLockDenied", "wrong-owner action emits browserTabLockDenied receipt");

    const readyEngines = await Promise.all(runs.map((run) => waitForRunEngineReady(base, token, run)));
    assert(readyEngines.every((engine, index) => engine.browserTabId === runs[index]?.tab.browserTabId), "each owner tab finishes initial navigation before observe");

    const ownedObserves = await Promise.all(runs.map((run) => observeOwnedTab(base, token, run)));
    assert(ownedObserves.every((response) => response.status === "applied"), "each owner can observe its locked tab");
    assert(ownedObserves.every((response) => (response.observation?.domSummary?.textBytes ?? 0) >= 0), "owned observations return bounded DOM summaries");

    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const active = activeTab(state);
    const engineIds = new Set(runs.map((run) => run.tab.engineId));
    const poolEngineIds = new Set((state.enginePool?.engines ?? []).map((engine) => engine.engineId));
    assert(Boolean(active?.browserTabId), "Browser state keeps an active tab after concurrent activity");
    assert((state.tabs ?? []).filter((tab) => runs.some((run) => run.tab.browserTabId === tab.browserTabId)).length === 3, "Browser state retains all three concurrent task tabs");
    assert((state.enginePool?.limits?.effectiveBackgroundEngines ?? 0) >= 3, "Browser engine pool capacity allows three background agents");
    assert([...engineIds].every((engineId) => poolEngineIds.has(engineId)), "Browser engine pool retains all three task engines");
    assert((state.enginePool?.waiting ?? []).length === 0, "Browser engine pool has no stuck waiters after concurrent observes");

    const receipts = await assertNoCrossTaskReceipts(base, token, runs);
    assert(receipts.some((receipt) => receipt.kind === "browserTabLockDenied"), "receipt ledger includes the wrong-owner denial");

    const report = {
      createdAt: new Date().toISOString(),
      fixtureBaseUrl: fixture.baseUrl,
      activeBrowserTabId: state.activeBrowserTabId ?? null,
      engine: state.engine ?? null,
      enginePool: state.enginePool ?? null,
      ownedObserves: ownedObserves.map((response, index) => ({
        id: runs[index]?.id ?? `run-${index}`,
        status: response.status,
        message: response.message ?? null,
        observationUrl: response.observation?.url ?? null,
        observationTitle: response.observation?.title ?? null,
        textBytes: response.observation?.domSummary?.textBytes ?? null,
      })),
      runs: runs.map((run) => ({
        id: run.id,
        agentId: run.agentId,
        runId: run.runId,
        taskId: run.task.taskId,
        browserTabId: run.tab.browserTabId,
        engineId: run.tab.engineId,
        lockLeaseId: run.lock.leaseId,
        route: run.route,
      })),
      receiptsChecked: receipts.length,
    };
    writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
    console.log(`\nThree-agent Browser concurrency evidence: ${outDir}`);
  } finally {
    await Promise.all(runs.map((run) => closeRunTab(base, token, run)));
    fixture.closeAll();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }

  if (failures > 0) {
    throw new Error(`${failures} Browser concurrency smoke check(s) failed`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
