import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { cleanupOwnedBrowserLifecycle } from "./shellx-browser-test-cleanup";
import { resolveShellxDebugApiConnection } from "./shellx-debug-paths";

type JsonObject = Record<string, unknown>;
type AgentName = "codex" | "claude" | "grok";
type ScenarioName = "api-key" | "onboarding" | "dynamic-dashboard";

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

interface BrowserActionResponse {
  ok: boolean;
  status: string;
  requiredApproval?: string | null;
  message?: string | null;
  currentUrl?: string | null;
}

interface BrowserRecipeExportResponse {
  recipeId: string;
  path: string;
  bytes: number;
  sha256: string;
  steps: number;
  source: string;
  receipt: { kind: string };
}

interface BrowserRecipeReplayResponse {
  ok: boolean;
  status: string;
  stepsPlanned: number;
  stepsApplied: number;
  stepsSkipped: number;
  skippedSteps?: Array<{ index: number; action?: string | null; reason: string }>;
  dryRun: boolean;
  receipt: { kind: string };
}

interface BrowserBookmarkResponse {
  ok: boolean;
  bookmark: {
    bookmarkId: string;
    label: string;
    agentWorkflow?: JsonObject | null;
  };
}

interface DebugContext {
  base: string;
  token: string;
}

interface Fixture {
  baseUrl: string;
  routeUrl: string;
  blankUrl: string;
  close: () => Promise<void>;
}

interface SavedWorkflow {
  recorder: AgentName;
  scenario: ScenarioName;
  recipePath: string;
  recipeSteps: number;
  bookmarkId: string;
  freshMs: number;
  freshActions: number;
}

interface ReplayOutcome {
  recorder: AgentName;
  consumer: AgentName;
  scenario: ScenarioName;
  completed: boolean;
  replayMs: number;
  liveFollowUpMs: number;
  stepsPlanned: number;
  stepsApplied: number;
  stepsSkipped: number;
  skippedReasons: string[];
}

const SCENARIOS: ScenarioName[] = ["api-key", "onboarding", "dynamic-dashboard"];
const API_TIMEOUT_MS = Number(process.env.SHELLX_WORKFLOW_MATRIX_API_TIMEOUT_MS ?? 30_000);
const DEFAULT_AGENTS: AgentName[] = ["codex", "claude", "grok"];

function matrixAgents(): AgentName[] {
  const raw = process.env.SHELLX_WORKFLOW_MATRIX_AGENTS?.trim();
  if (!raw) return DEFAULT_AGENTS;
  const agents = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is AgentName => value === "codex" || value === "claude" || value === "grok");
  if (agents.length === 0) {
    throw new Error("SHELLX_WORKFLOW_MATRIX_AGENTS must include at least one of codex,claude,grok");
  }
  return Array.from(new Set(agents));
}

async function debugBase(): Promise<DebugContext> {
  return resolveShellxDebugApiConnection();
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsedMs(startMs: number): number {
  return Math.max(0, Math.round(performance.now() - startMs));
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 20_000,
  intervalMs = 350,
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
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`);
}

async function api<T>(ctx: DebugContext, method: string, path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${ctx.base}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${method} ${path} could not reach ${ctx.base} within ${API_TIMEOUT_MS}ms. Cause: ${cause}`,
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} failed with ${res.status}: ${text.slice(0, 1200)}`);
  }
  const text = await res.text();
  if (!text.trim()) return JSON.parse("{}");
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(JSON.stringify(text));
  }
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
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, fixture: "shellx-workflow-matrix", routes: ["/workflow-matrix", "/blank"] }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/blank") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end("<!doctype html><title>Blank ShellX workflow matrix page</title><p>Blank workflow start</p>");
      return;
    }
    if (req.method === "GET" && url.pathname === "/workflow-matrix") {
      const html = await readFile(fixturePath, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
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

async function waitForBrowserEngine(ctx: DebugContext, expectedUrl: string, taskId: string): Promise<BrowserState> {
  return await waitFor("workflow matrix Browser engine load", async () => {
    const state = await api<BrowserState>(ctx, "GET", "/browser/state");
    const active = state.tabs?.find((tab) => tab.browserTabId === state.activeBrowserTabId);
    if (active?.taskId !== taskId) return null;
    if (!state.engine?.mounted || !state.engine.url?.startsWith(expectedUrl)) return null;
    if (state.engine.loadStatus === "error") throw new Error(state.engine.lastError ?? "Browser engine error");
    return ["loaded", "observed", "screenshotCaptured"].includes(state.engine.loadStatus) ? state : null;
  }, 20_000, 350);
}

async function startTask(
  ctx: DebugContext,
  fixture: Fixture,
  goal: string,
  taskIds: Set<string>,
): Promise<BrowserTask> {
  const task = await api<BrowserTask>(ctx, "POST", "/browser/task/start", {
    goal,
    startUrl: fixture.blankUrl,
    profileId: "agent-work",
    autonomy: "assistedAutonomous",
    expectedDomains: ["127.0.0.1"],
  });
  taskIds.add(task.taskId);
  await waitForBrowserEngine(ctx, fixture.blankUrl, task.taskId);
  return task;
}

async function browserAction(ctx: DebugContext, taskId: string, body: JsonObject): Promise<BrowserActionResponse> {
  return await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId,
    ...body,
  });
}

async function applied(ctx: DebugContext, taskId: string, body: JsonObject, label: string): Promise<void> {
  const result = await browserAction(ctx, taskId, body);
  assert(
    result.status === "applied",
    `${label}: ${JSON.stringify({ status: result.status, requiredApproval: result.requiredApproval, message: result.message })}`,
  );
  if (body.action === "navigate" && typeof body.url === "string") {
    await waitForBrowserEngine(ctx, body.url, taskId);
  }
}

async function verifyText(ctx: DebugContext, taskId: string, value: string, label: string): Promise<void> {
  await applied(ctx, taskId, { action: "verify", key: "text", value }, label);
}

async function recordApiKeyWorkflow(ctx: DebugContext, fixture: Fixture, taskId: string): Promise<number> {
  const actions: Array<[JsonObject, string]> = [
    [{ action: "navigate", url: fixture.routeUrl }, "agent navigates workflow matrix fixture"],
    [{ action: "waitFor", value: "ShellX workflow matrix ready", timeoutMs: 5_000 }, "agent waits for matrix fixture readiness"],
    [{ action: "clickRef", selector: "[data-testid=cookie-accept]" }, "agent accepts cookie-style fixture"],
    [{ action: "clickRef", selector: "[data-testid=nav-developer]" }, "agent opens developer console"],
    [{ action: "select", selector: "[data-testid=project-select]", value: "demo-api" }, "agent selects API project"],
    [{ action: "clickRef", selector: "[data-testid=api-open]" }, "agent opens API keys panel"],
    [{ action: "waitFor", value: "API keys", timeoutMs: 5_000 }, "agent waits for API keys panel"],
    [{ action: "clickRef", selector: "[data-testid=create-api-key]" }, "agent creates test API key"],
    [{ action: "waitFor", value: "API key ready", timeoutMs: 5_000 }, "agent waits for API key creation"],
    [{ action: "verify", key: "text", value: "API key ready" }, "agent verifies API-key-style completion"],
  ];
  for (const [body, label] of actions) await applied(ctx, taskId, body, label);
  return actions.length;
}

async function recordOnboardingWorkflow(ctx: DebugContext, fixture: Fixture, taskId: string): Promise<number> {
  const actions: Array<[JsonObject, string]> = [
    [{ action: "navigate", url: fixture.routeUrl }, "agent navigates workflow matrix fixture"],
    [{ action: "waitFor", value: "ShellX workflow matrix ready", timeoutMs: 5_000 }, "agent waits for matrix fixture readiness"],
    [{ action: "clickRef", selector: "[data-testid=cookie-accept]" }, "agent accepts cookie-style fixture"],
    [{ action: "clickRef", selector: "[data-testid=nav-onboarding]" }, "agent opens onboarding form"],
    [{ action: "fillRef", selector: "[data-testid=team-name]", value: "Claude Code" }, "agent fills team name"],
    [{ action: "fillRef", selector: "[data-testid=project-name]", value: "Workflow benchmark" }, "agent fills project name"],
    [{ action: "select", selector: "[data-testid=project-type]", value: "automation" }, "agent selects project type"],
    [{ action: "clickRef", selector: "[data-testid=preview-onboarding]" }, "agent previews onboarding form"],
    [{ action: "waitFor", value: "Onboarding preview ready", timeoutMs: 5_000 }, "agent waits for onboarding preview"],
    [{ action: "verify", key: "text", value: "Onboarding preview ready" }, "agent verifies onboarding preview"],
  ];
  for (const [body, label] of actions) await applied(ctx, taskId, body, label);
  return actions.length;
}

async function recordDynamicWorkflow(ctx: DebugContext, fixture: Fixture, taskId: string): Promise<number> {
  const actions: Array<[JsonObject, string]> = [
    [{ action: "navigate", url: fixture.routeUrl }, "agent navigates workflow matrix fixture"],
    [{ action: "waitFor", value: "ShellX workflow matrix ready", timeoutMs: 5_000 }, "agent waits for matrix fixture readiness"],
    [{ action: "clickRef", selector: "[data-testid=cookie-accept]" }, "agent accepts cookie-style fixture"],
    [{ action: "clickRef", selector: "[data-testid=nav-dashboard]" }, "agent opens usage dashboard"],
    [{ action: "clickRef", selector: "[data-testid=refresh-dashboard]" }, "agent refreshes usage dashboard"],
    [{ action: "waitFor", value: "Latest usage score", timeoutMs: 5_000 }, "agent waits for dynamic dashboard value"],
    [{ action: "clickRef", selector: "[data-testid=sort-usage]" }, "agent sorts usage table"],
    [{ action: "extractTable", selector: "[data-testid=usage-table]" }, "agent extracts dashboard table"],
    [{ action: "verify", key: "text", value: "Usage sorted descending" }, "agent verifies dashboard completion"],
  ];
  for (const [body, label] of actions) await applied(ctx, taskId, body, label);
  return actions.length;
}

async function completeReplayFollowUp(
  ctx: DebugContext,
  scenario: ScenarioName,
  taskId: string,
): Promise<{ completed: boolean; liveFollowUpMs: number }> {
  const start = performance.now();
  try {
    if (scenario === "onboarding") {
      await applied(ctx, taskId, { action: "fillRef", selector: "[data-testid=team-name]", value: "Claude Code" }, "consumer binds skipped team name");
      await applied(ctx, taskId, { action: "fillRef", selector: "[data-testid=project-name]", value: "Workflow benchmark" }, "consumer binds skipped project name");
      await applied(ctx, taskId, { action: "select", selector: "[data-testid=project-type]", value: "automation" }, "consumer binds skipped project type");
      await applied(ctx, taskId, { action: "clickRef", selector: "[data-testid=preview-onboarding]" }, "consumer previews form after live binding");
      await verifyText(ctx, taskId, "Onboarding preview ready", "consumer verifies onboarding preview after live binding");
      return { completed: true, liveFollowUpMs: elapsedMs(start) };
    }
    if (scenario === "api-key") {
      const alreadyReady = await browserAction(ctx, taskId, {
        action: "verify",
        key: "text",
        value: "API key ready",
        timeoutMs: 800,
      }).catch(() => null);
      if (!alreadyReady || alreadyReady.status !== "applied") {
        await applied(ctx, taskId, { action: "select", selector: "[data-testid=project-select]", value: "demo-api" }, "consumer binds skipped API project");
        await applied(ctx, taskId, { action: "clickRef", selector: "[data-testid=api-open]" }, "consumer opens API keys panel after live binding");
        await applied(ctx, taskId, { action: "waitFor", value: "API keys", timeoutMs: 5_000 }, "consumer waits for API keys panel after live binding");
        await applied(ctx, taskId, { action: "clickRef", selector: "[data-testid=create-api-key]" }, "consumer creates API key after live binding");
        await applied(ctx, taskId, { action: "waitFor", value: "API key ready", timeoutMs: 5_000 }, "consumer waits for API key after live binding");
      }
      await verifyText(ctx, taskId, "API key ready", "consumer verifies api-key replay completion");
      return { completed: true, liveFollowUpMs: elapsedMs(start) };
    }
    await verifyText(ctx, taskId, "Usage sorted descending", `consumer verifies ${scenario} replay completion`);
    return { completed: true, liveFollowUpMs: elapsedMs(start) };
  } catch (err) {
    console.warn(`  ! ${scenario} follow-up failed: ${err instanceof Error ? err.message : String(err)}`);
    return { completed: false, liveFollowUpMs: elapsedMs(start) };
  }
}

async function exportAndSaveWorkflow(
  ctx: DebugContext,
  fixture: Fixture,
  taskId: string,
  recorder: AgentName,
  scenario: ScenarioName,
  actionCount: number,
  freshMs: number,
): Promise<SavedWorkflow> {
  const recipe = await api<BrowserRecipeExportResponse>(ctx, "POST", "/browser/recipes/export", {
    taskId,
    reason: `Workflow matrix export ${scenario} recorded by ${recorder}`,
  });
  assert(recipe.steps > 0, `${recorder}/${scenario} exports a non-empty recipe`);
  const bookmarkId = `wf-matrix-${scenario}-${recorder}`;
  const bookmark = await api<BrowserBookmarkResponse>(ctx, "POST", "/browser/bookmarks", {
    bookmarkId,
    label: `Matrix ${scenario} (${recorder})`,
    kind: "link",
    url: fixture.routeUrl,
    category: "workflow",
    toolbarPinned: false,
    agentWorkflow: {
      siteKey: "127.0.0.1",
      taskType: scenario === "api-key" ? "get" : scenario === "onboarding" ? "fill" : "read",
      target: scenario,
      surface: "workflow-matrix",
      aliases: [`matrix-${scenario}`, `${recorder}-${scenario}`],
      permissionsNeeded: scenario === "onboarding" ? ["profile-form-binding"] : [],
      secretKinds: scenario === "api-key" ? ["api-key"] : [],
      recipeId: recipe.recipeId,
      recipePath: recipe.path,
      goal: `Replay ${scenario} task recorded by ${recorder}`,
      steps: recipe.steps,
      source: "recipe",
      health: "fresh",
      driftStatus: "fresh",
      recorderAgent: recorder,
      actionCount,
    },
  });
  assert(bookmark.ok && bookmark.bookmark.bookmarkId === bookmarkId, `${recorder}/${scenario} workflow bookmark is saved`);
  return {
    recorder,
    scenario,
    recipePath: recipe.path,
    recipeSteps: recipe.steps,
    bookmarkId,
    freshMs,
    freshActions: actionCount,
  };
}

async function recordWorkflow(
  ctx: DebugContext,
  fixture: Fixture,
  recorder: AgentName,
  scenario: ScenarioName,
  taskIds: Set<string>,
): Promise<SavedWorkflow> {
  const task = await startTask(ctx, fixture, `Workflow matrix fresh ${scenario} recorded by ${recorder}`, taskIds);
  const start = performance.now();
  let actionCount = 0;
  if (scenario === "api-key") {
    actionCount = await recordApiKeyWorkflow(ctx, fixture, task.taskId);
  } else if (scenario === "onboarding") {
    actionCount = await recordOnboardingWorkflow(ctx, fixture, task.taskId);
  } else {
    actionCount = await recordDynamicWorkflow(ctx, fixture, task.taskId);
  }
  const freshMs = elapsedMs(start);
  return await exportAndSaveWorkflow(ctx, fixture, task.taskId, recorder, scenario, actionCount, freshMs);
}

async function replayWorkflow(
  ctx: DebugContext,
  fixture: Fixture,
  workflow: SavedWorkflow,
  consumer: AgentName,
  taskIds: Set<string>,
): Promise<ReplayOutcome> {
  const task = await startTask(ctx, fixture, `Workflow matrix replay ${workflow.scenario}: ${consumer} consumes ${workflow.recorder}`, taskIds);
  const start = performance.now();
  const replay = await api<BrowserRecipeReplayResponse>(ctx, "POST", "/browser/recipes/replay", {
    taskId: task.taskId,
    recipePath: workflow.recipePath,
    dryRun: false,
    reason: `Workflow matrix ${consumer} applies ${workflow.scenario} recipe recorded by ${workflow.recorder}`,
  });
  const replayMs = elapsedMs(start);
  const replaySkippedReasons = Array.from(new Set((replay.skippedSteps ?? []).map((step) => step.reason))).sort();
  const requiresLiveBinding = !replay.ok
    && replay.status === "incomplete"
    && replay.stepsApplied > 0
    && replaySkippedReasons.includes("redactedInputRequiresBinding")
    && replaySkippedReasons.includes("blockedByLiveBinding");
  if (replay.dryRun !== false || (!replay.ok && !requiresLiveBinding)) {
    throw new Error(
      `${consumer} could not apply or safely pause ${workflow.recorder}/${workflow.scenario} workflow recipe: ${JSON.stringify(replay)}`,
    );
  }
  assert(true, `${consumer} applies or safely pauses ${workflow.recorder}/${workflow.scenario} workflow recipe`);
  const followUp = await completeReplayFollowUp(ctx, workflow.scenario, task.taskId);
  return {
    recorder: workflow.recorder,
    consumer,
    scenario: workflow.scenario,
    completed: followUp.completed,
    replayMs,
    liveFollowUpMs: followUp.liveFollowUpMs,
    stepsPlanned: replay.stepsPlanned,
    stepsApplied: replay.stepsApplied,
    stepsSkipped: replay.stepsSkipped,
    skippedReasons: replaySkippedReasons,
  };
}

async function main(): Promise<void> {
  console.log("\n=== ShellX Browser workflow matrix ===");
  const ctx = await debugBase();
  let fixture: Fixture | null = null;
  const saved: SavedWorkflow[] = [];
  const outcomes: ReplayOutcome[] = [];
  const taskIds = new Set<string>();
  try {
    await api<JsonObject>(ctx, "GET", "/health");
    assert(true, "debug API health responds");
    fixture = await startWorkflowFixture();
    await api<JsonObject>(ctx, "POST", "/browser/open", { startUrl: fixture.blankUrl });
    assert(true, "Browser window opens for workflow matrix");
    const agents = matrixAgents();
    console.log(`Agents under test: ${agents.join(", ")}`);

    for (const recorder of agents) {
      for (const scenario of SCENARIOS) {
        console.log(`\n--- Record ${scenario} as ${recorder} ---`);
        saved.push(await recordWorkflow(ctx, fixture, recorder, scenario, taskIds));
      }
    }

    for (const workflow of saved) {
      for (const consumer of agents) {
        console.log(`\n--- Replay ${workflow.scenario}: ${consumer} consumes ${workflow.recorder} recipe ---`);
        outcomes.push(await replayWorkflow(ctx, fixture, workflow, consumer, taskIds));
      }
    }

    const failed = outcomes.filter((outcome) => !outcome.completed);
    assert(failed.length === 0, "all cross-agent workflow replays complete their task");

    console.log("\nWorkflow matrix summary:");
    console.table(outcomes.map((outcome) => {
      const source = saved.find((item) => item.recorder === outcome.recorder && item.scenario === outcome.scenario);
      const totalReplayMs = outcome.replayMs + outcome.liveFollowUpMs;
      return {
        scenario: outcome.scenario,
        recorder: outcome.recorder,
        consumer: outcome.consumer,
        freshMs: source?.freshMs ?? 0,
        replayMs: totalReplayMs,
        speedup: source && totalReplayMs > 0 ? Number((source.freshMs / totalReplayMs).toFixed(2)) : 0,
        actions: source?.freshActions ?? 0,
        planned: outcome.stepsPlanned,
        applied: outcome.stepsApplied,
        skipped: outcome.stepsSkipped,
        skippedReasons: outcome.skippedReasons.join(","),
      };
    }));

    const byScenario = SCENARIOS.map((scenario) => {
      const scenarioSaved = saved.filter((item) => item.scenario === scenario);
      const scenarioOutcomes = outcomes.filter((item) => item.scenario === scenario);
      const avgFresh = scenarioSaved.reduce((sum, item) => sum + item.freshMs, 0) / Math.max(1, scenarioSaved.length);
      const avgReplay = scenarioOutcomes.reduce((sum, item) => sum + item.replayMs + item.liveFollowUpMs, 0) / Math.max(1, scenarioOutcomes.length);
      return {
        scenario,
        avgFreshMs: Math.round(avgFresh),
        avgReplayMs: Math.round(avgReplay),
        avgSpeedup: avgReplay > 0 ? Number((avgFresh / avgReplay).toFixed(2)) : 0,
        completed: `${scenarioOutcomes.filter((item) => item.completed).length}/${scenarioOutcomes.length}`,
      };
    });
    console.log("\nScenario averages:");
    console.table(byScenario);
  } finally {
    try {
      await cleanupOwnedBrowserLifecycle(
        (method, path, body) => api(ctx, method, path, body),
        { taskIds, label: "workflow-matrix" },
      );
    } finally {
      if (fixture) await fixture.close().catch(() => undefined);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
