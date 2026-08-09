import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

const GOAL_LIFECYCLE_MUTATIONS = new Set([
  "POST /goal/start",
  "POST /goal/stop",
  "POST /goal/pause",
  "POST /goal/resume",
  "POST /goal/reject",
  "POST /goal/complete",
]);
const TIMEOUT_MS = 30_000;

type DebugApiConnection = { base: string; token: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

interface GoalFixture {
  apiRoot: string;
  nodeRoot: string;
  scratchboardPath: string;
  tabId: string;
  objective: string;
}

export function isDebugApiGoalLifecycleMutation(name: string): boolean {
  return GOAL_LIFECYCLE_MUTATIONS.has(name);
}

export async function exerciseDebugApiGoalLifecycleMutation(
  connection: DebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  assignment: DriverAssignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No owned Goal lifecycle transition was observed.",
  };
  let fixture: GoalFixture | null = null;
  try {
    if (!GOAL_LIFECYCLE_MUTATIONS.has(assignment.surface.name)) {
      throw new Error(`unsupported Goal lifecycle route ${assignment.surface.name}`);
    }
    fixture = prepareGoalFixture(request, assignment.surface.name);
    const baseline = await goalState(connection, fixture.tabId);
    if (baseline.state !== null || baseline.lastClear !== null) {
      throw new Error("owned Goal fixture did not begin without state or tombstone");
    }
    outcome.present = "pass";

    if (assignment.surface.name === "POST /goal/start") {
      const started = await startGoal(connection, fixture);
      outcome.invoke = "pass";
      verifyStartedGoal(started, fixture);
      verifyScratchboard(fixture, "AWAITING_APPROVAL");
      verifyActiveState(await goalState(connection, fixture.tabId), fixture, false);
      outcome.observedEffect = "POST /goal/start created one exact owned active Goal, wrote its AWAITING_APPROVAL scratchboard in the disposable candidate profile, and cleanup stopped the Goal and removed that directory.";
    } else {
      verifyStartedGoal(await startGoal(connection, fixture), fixture);
      verifyScratchboard(fixture, "AWAITING_APPROVAL");
      verifyActiveState(await goalState(connection, fixture.tabId), fixture, false);

      if (assignment.surface.name === "POST /goal/pause") {
        const paused = await postGoal(connection, "/goal/pause", fixture.tabId);
        outcome.invoke = "pass";
        verifyToggleResponse(paused, fixture.tabId, "paused", true, "Goal pause");
        verifyActiveState(await goalState(connection, fixture.tabId), fixture, true);
        outcome.observedEffect = "POST /goal/pause paused one exact owned active Goal and read back pausedByUser=true before cleanup stopped it and removed its scratchboard.";
      } else if (assignment.surface.name === "POST /goal/resume") {
        verifyToggleResponse(
          await postGoal(connection, "/goal/pause", fixture.tabId),
          fixture.tabId,
          "paused",
          true,
          "Goal resume seed pause",
        );
        verifyActiveState(await goalState(connection, fixture.tabId), fixture, true);
        const resumed = await postGoal(connection, "/goal/resume", fixture.tabId);
        outcome.invoke = "pass";
        verifyToggleResponse(resumed, fixture.tabId, "paused", false, "Goal resume");
        verifyActiveState(await goalState(connection, fixture.tabId), fixture, false);
        outcome.observedEffect = "POST /goal/resume resumed one exact owned paused Goal and read back pausedByUser=false before cleanup stopped it and removed its scratchboard.";
      } else if (assignment.surface.name === "POST /goal/stop") {
        const stopped = await postGoal(connection, "/goal/stop", fixture.tabId);
        outcome.invoke = "pass";
        verifyToggleResponse(stopped, fixture.tabId, "active", false, "Goal stop");
        verifyClearedState(await goalState(connection, fixture.tabId), fixture, "off");
        outcome.observedEffect = "POST /goal/stop cleared one exact owned active Goal and exposed its off tombstone before cleanup removed the scratchboard directory.";
      } else if (assignment.surface.name === "POST /goal/reject") {
        const rejected = await postGoal(connection, "/goal/reject", fixture.tabId);
        outcome.invoke = "pass";
        verifyToggleResponse(rejected, fixture.tabId, "rejected", true, "Goal reject");
        verifyClearedState(await goalState(connection, fixture.tabId), fixture, "rejected");
        outcome.observedEffect = "POST /goal/reject cleared one exact owned active Goal and exposed its rejected tombstone before cleanup removed the scratchboard directory.";
      } else {
        const completed = await postGoal(connection, "/goal/complete", fixture.tabId);
        outcome.invoke = "pass";
        verifyCompleteResponse(completed, fixture.tabId);
        verifyScratchboard(fixture, "GOAL_COMPLETE");
        verifyCompletedState(await goalState(connection, fixture.tabId), fixture);
        outcome.observedEffect = "POST /goal/complete marked one exact owned Goal inactive, patched only its disposable scratchboard to GOAL_COMPLETE, and exposed its completed tombstone before cleanup cleared the residual state and removed the directory.";
      }
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (fixture) {
      const cleanupError = await cleanupGoalFixture(connection, fixture);
      if (cleanupError) {
        outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
      } else {
        outcome.cleanup = "pass";
      }
    }
  }
  return outcome;
}

function prepareGoalFixture(
  request: ReleaseSurfaceDriverRequest,
  surfaceName: string,
): GoalFixture {
  const lane = surfaceName.slice("POST /goal/".length);
  const segment = request.sourceCommit.slice(0, 16).replace(/[^a-f0-9]/g, "0");
  const directoryName = `release-goal-${lane}-${segment}`;
  const apiRoot = siblingPath(request.runtime.debugTokenPath, directoryName, request.platform);
  const nodeRoot = nodeReadablePath(apiRoot, request.platform);
  if (existsSync(nodeRoot)) throw new Error("owned Goal fixture root already exists");
  mkdirSync(nodeRoot, { mode: 0o700 });
  return {
    apiRoot,
    nodeRoot,
    scratchboardPath: platformJoin(apiRoot, "goal.md", request.platform),
    tabId: `shellx-release-goal-${lane}-${segment}`,
    objective: `Verify ShellX Goal ${lane} ${segment}`,
  };
}

async function cleanupGoalFixture(
  connection: DebugApiConnection,
  fixture: GoalFixture,
): Promise<string | null> {
  const errors: string[] = [];
  try {
    const state = await goalState(connection, fixture.tabId);
    if (state.state !== null) {
      await postGoal(connection, "/goal/stop", fixture.tabId);
      const cleared = await goalState(connection, fixture.tabId);
      if (cleared.state !== null) throw new Error("owned Goal remained after cleanup stop");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    const goalPath = join(fixture.nodeRoot, "goal.md");
    if (existsSync(goalPath)) unlinkSync(goalPath);
    if (existsSync(fixture.nodeRoot)) rmdirSync(fixture.nodeRoot);
    if (existsSync(fixture.nodeRoot)) throw new Error("owned Goal fixture remained after exact cleanup");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

async function startGoal(
  connection: DebugApiConnection,
  fixture: GoalFixture,
): Promise<Record<string, unknown>> {
  return apiJson(connection, "POST", "/goal/start", {
    tabId: fixture.tabId,
    objective: fixture.objective,
    cwd: fixture.apiRoot,
  });
}

async function postGoal(
  connection: DebugApiConnection,
  path: string,
  tabId: string,
): Promise<Record<string, unknown>> {
  return apiJson(connection, "POST", path, { tabId });
}

async function goalState(
  connection: DebugApiConnection,
  tabId: string,
): Promise<Record<string, unknown>> {
  return apiJson(connection, "GET", `/goal/state?tabId=${encodeURIComponent(tabId)}`);
}

function verifyStartedGoal(value: Record<string, unknown>, fixture: GoalFixture): void {
  verifyExactKeys(value, ["cwd", "objective", "ok", "scratchboardPath", "tabId"], "Goal start response");
  if (value.ok !== true || value.tabId !== fixture.tabId || value.objective !== fixture.objective
    || !samePath(value.cwd, fixture.apiRoot) || !samePath(value.scratchboardPath, fixture.scratchboardPath)) {
    throw new Error("Goal start response omitted its exact owned tab, objective, cwd, or scratchboard");
  }
}

function verifyScratchboard(fixture: GoalFixture, status: "AWAITING_APPROVAL" | "GOAL_COMPLETE"): void {
  const path = join(fixture.nodeRoot, "goal.md");
  const text = readFileSync(path, "utf8");
  const expected = status === "AWAITING_APPROVAL"
    ? `# Goal: ${fixture.objective}\n\nStatus: AWAITING_APPROVAL\n\n_grok is drafting the plan…_\n`
    : `# Goal: ${fixture.objective}\n\nstatus: GOAL_COMPLETE\n\n_grok is drafting the plan…_\n`;
  if (text !== expected) throw new Error(`Goal scratchboard did not contain the exact ${status} owned fixture`);
}

function verifyActiveState(
  value: Record<string, unknown>,
  fixture: GoalFixture,
  paused: boolean,
): void {
  verifyStateEnvelope(value, fixture.tabId);
  const state = requireObject(value.state, "Goal active state");
  if (state.active !== true || state.objective !== fixture.objective
    || !samePath(state.scratchboardPath, fixture.scratchboardPath)
    || state.transportKind !== "local" || state.pausedByUser !== paused
    || state.awaitingApproval !== true || state.planTurnCompleted !== false
    || state.halted !== false || state.haltedReason !== null) {
    throw new Error("Goal state omitted its exact active, approval, transport, or pause state");
  }
  if (value.lastClear !== null) throw new Error("active Goal unexpectedly exposed a clear tombstone");
}

function verifyClearedState(
  value: Record<string, unknown>,
  fixture: GoalFixture,
  reason: "off" | "rejected",
): void {
  verifyStateEnvelope(value, fixture.tabId);
  if (value.state !== null) throw new Error("cleared Goal still returned active state");
  const clear = requireObject(value.lastClear, "Goal clear tombstone");
  if (clear.reason !== reason || clear.objective !== fixture.objective || !Number.isSafeInteger(clear.clearedAtMs)) {
    throw new Error(`Goal clear tombstone did not bind the exact ${reason} lifecycle`);
  }
}

function verifyCompletedState(value: Record<string, unknown>, fixture: GoalFixture): void {
  verifyStateEnvelope(value, fixture.tabId);
  const state = requireObject(value.state, "Goal completed state");
  if (state.active !== false || state.objective !== fixture.objective
    || !samePath(state.scratchboardPath, fixture.scratchboardPath)) {
    throw new Error("completed Goal state omitted its exact inactive owned state");
  }
  const clear = requireObject(value.lastClear, "Goal completed tombstone");
  if (clear.reason !== "completed" || clear.objective !== fixture.objective
    || !Number.isSafeInteger(clear.clearedAtMs)) {
    throw new Error("Goal completed tombstone did not bind the exact owned lifecycle");
  }
}

function verifyStateEnvelope(value: Record<string, unknown>, tabId: string): void {
  verifyExactKeys(value, ["approvalStatus", "lastClear", "state", "tabId"], "Goal state envelope");
  if (value.tabId !== tabId) throw new Error("Goal state returned a different tab");
  if (value.state === null) {
    if (value.approvalStatus !== null) throw new Error("cleared Goal retained approval status");
  } else {
    requireObject(value.approvalStatus, "Goal approval status");
  }
}

function verifyToggleResponse(
  value: Record<string, unknown>,
  tabId: string,
  key: "active" | "paused" | "rejected",
  expected: boolean,
  label: string,
): void {
  verifyExactKeys(value, [key, "ok", "tabId"], `${label} response`);
  if (value.ok !== true || value.tabId !== tabId || value[key] !== expected) {
    throw new Error(`${label} response omitted its exact owned transition`);
  }
}

function verifyCompleteResponse(value: Record<string, unknown>, tabId: string): void {
  verifyExactKeys(value, [
    "active", "ok", "scratchboardError", "scratchboardPatched", "tabId", "wasActive",
  ], "Goal complete response");
  if (value.ok !== true || value.tabId !== tabId || value.active !== false || value.wasActive !== true
    || value.scratchboardPatched !== true || value.scratchboardError !== null) {
    throw new Error("Goal complete response omitted its exact scratchboard-backed transition");
  }
}

async function apiJson(
  connection: DebugApiConnection,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  return requireObject(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
}

function siblingPath(
  tokenPath: string,
  name: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  if (platform === "windows-installed" && /^[A-Za-z]:[\\/]/.test(tokenPath)) {
    return win32.join(win32.dirname(tokenPath), name);
  }
  return join(dirname(tokenPath), name);
}

function nodeReadablePath(
  path: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) {
    return resolve(path);
  }
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("unable to map the Goal fixture path into WSL");
  }
  return resolve(result.stdout.trim());
}

function platformJoin(
  parent: string,
  child: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  return platform === "windows-installed" ? win32.join(parent, child) : join(parent, child);
}

function samePath(value: unknown, expected: string): boolean {
  return typeof value === "string"
    && value.replaceAll("\\", "/").replace(/\/$/, "") === expected.replaceAll("\\", "/").replace(/\/$/, "");
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} did not return an object`);
  }
  return value as Record<string, unknown>;
}

function verifyExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys changed: ${actual.join(", ")}`);
  }
}
