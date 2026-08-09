import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  acceptReleaseSurfaceInstalledInputAlert,
  clickReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type GoalFixture = {
  tabId: string;
  localRoot: string;
  candidateRoot: string;
  originalActiveTab: Record<string, unknown>;
  originalRightTab: RightRailTab;
};
type RightRailTab = "Tasks" | "Tooling" | "Git" | "Preview" | "Plan" | "Files";
type GoalAction = "review" | "pause-resume" | "complete";

const RIGHT_RAIL_GOAL_ACTIONS: Record<string, GoalAction> = {
  "src/components/RightRail.tsx:[title=\"Open the focused plan review dialog.\"]": "review",
  "src/components/RightRail.tsx::is([title=\"Pause auto-continuation (only user can pause)\"],[title=\"Resume auto-continuation\"])": "pause-resume",
  "src/components/RightRail.tsx:[title=\"Mark build as complete — stops the auto-continuation loop. Use when the agent finished but did not call the completion tool itself.\"]": "complete",
};

const REVIEW_BUTTON = "[title='Open the focused plan review dialog.']";
const REVIEW_DIALOG = "[role='dialog'][aria-label^='Review plan:']";
const REVIEW_LATER = "[aria-label='Review later']";
const PAUSE_BUTTON = "[title='Pause auto-continuation (only user can pause)']";
const RESUME_BUTTON = "[title='Resume auto-continuation']";
const COMPLETE_BUTTON = "[title='Mark build as complete — stops the auto-continuation loop. Use when the agent finished but did not call the completion tool itself.']";
const COMPLETE_CONFIRMATION = "Mark this build as complete? The auto-continuation loop will stop. Use this when the agent finished the work but did not call the completion tool itself.";
const RIGHT_RAIL_TABS = new Set<RightRailTab>(["Tasks", "Tooling", "Git", "Preview", "Plan", "Files"]);

export const RIGHT_RAIL_GOAL_FIXTURES = [
  "ui:right-rail-owned-goal-awaiting-review",
  "ui:right-rail-owned-goal-active",
] as const;

export const RIGHT_RAIL_GOAL_CLEANUPS = [
  "ui:forget-owned-goal-delete-cwd-and-restore-right-rail",
] as const;

export const RIGHT_RAIL_GOAL_ORACLES = [
  "ui:activation:right-rail-goal-review-opened",
  "ui:activation:right-rail-goal-pause-resume-transition",
  "ui:activation:right-rail-goal-completed",
] as const;

export function supportsRightRailGoalControl(assignment: Assignment): boolean {
  return assignment.surface.name in RIGHT_RAIL_GOAL_ACTIONS;
}

export async function exerciseRightRailGoalControl(
  connection: Connection,
  webdriver: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = RIGHT_RAIL_GOAL_ACTIONS[assignment.surface.name];
  const outcome = emptyOutcome(assignment);
  let fixture: GoalFixture | null = null;
  try {
    if (!action) throw new Error(`unsupported RightRail Goal control ${assignment.surface.name}`);
    fixture = await prepareGoalFixture(connection, request, action);
    if (action === "review") {
      await exerciseReview(webdriver, outcome);
    } else if (action === "pause-resume") {
      await exercisePauseResume(connection, webdriver, fixture, outcome);
    } else {
      await exerciseComplete(connection, webdriver, fixture, outcome);
    }
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    if (fixture) applyCleanup(outcome, await cleanupGoalFixture(connection, fixture));
  }
  return finalize(outcome);
}

async function exerciseReview(
  webdriver: ReleaseSurfaceInstalledInputSession,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await waitForReleaseSurfaceInstalledInputElement(webdriver, REVIEW_DIALOG, {
    timeoutMs: 8_000,
    pollMs: 75,
  });
  const reviewLater = await waitForReleaseSurfaceInstalledInputElement(webdriver, REVIEW_LATER);
  await clickReleaseSurfaceInstalledInputElement(webdriver, reviewLater);
  await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, REVIEW_DIALOG, { timeoutMs: 5_000, pollMs: 50 });
  const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, REVIEW_BUTTON, {
    timeoutMs: 8_000,
    pollMs: 75,
  });
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(webdriver, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElement(webdriver, REVIEW_DIALOG, { timeoutMs: 5_000, pollMs: 50 });
  const dismissReopened = await waitForReleaseSurfaceInstalledInputElement(webdriver, REVIEW_LATER);
  await clickReleaseSurfaceInstalledInputElement(webdriver, dismissReopened);
  await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, REVIEW_DIALOG, { timeoutMs: 5_000, pollMs: 50 });
  outcome.effect = "pass";
  outcome.observedEffect = "A native WebDriver click reopened the exact owned ready Goal review dialog after its automatic presentation was deliberately dismissed; no plan approval or provider prompt was sent.";
}

async function exercisePauseResume(
  connection: Connection,
  webdriver: ReleaseSurfaceInstalledInputSession,
  fixture: GoalFixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  const pause = await waitForReleaseSurfaceInstalledInputElement(webdriver, PAUSE_BUTTON, {
    timeoutMs: 8_000,
    pollMs: 75,
  });
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(webdriver, pause);
  outcome.invoke = "pass";
  await waitForGoalState(connection, fixture.tabId, (state) => state.pausedByUser === true, "paused");
  const resume = await waitForReleaseSurfaceInstalledInputElement(webdriver, RESUME_BUTTON, {
    timeoutMs: 8_000,
    pollMs: 75,
  });
  await clickReleaseSurfaceInstalledInputElement(webdriver, resume);
  await waitForGoalState(connection, fixture.tabId, (state) => state.pausedByUser === false, "resumed");
  await waitForReleaseSurfaceInstalledInputElement(webdriver, PAUSE_BUTTON, { timeoutMs: 8_000, pollMs: 75 });
  outcome.effect = "pass";
  outcome.observedEffect = "Two native WebDriver clicks paused and resumed the exact owned active Goal, proving both dynamic labels and backend pausedByUser transitions without contacting a provider.";
}

async function exerciseComplete(
  connection: Connection,
  webdriver: ReleaseSurfaceInstalledInputSession,
  fixture: GoalFixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, COMPLETE_BUTTON, {
    timeoutMs: 8_000,
    pollMs: 75,
  });
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(webdriver, control);
  await acceptReleaseSurfaceInstalledInputAlert(webdriver, COMPLETE_CONFIRMATION);
  outcome.invoke = "pass";
  await waitForGoalEnvelope(connection, fixture.tabId, (body) => {
    const state = optionalObject(body.state, "completed Goal state");
    const clear = optionalObject(body.lastClear, "completed Goal tombstone");
    return state?.active === false && clear?.reason === "completed";
  }, "completed");
  await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, COMPLETE_BUTTON, {
    timeoutMs: 8_000,
    pollMs: 75,
  });
  outcome.effect = "pass";
  outcome.observedEffect = "A native WebDriver click plus the exact trusted-user confirmation marked only the owned Goal inactive and exposed its completed tombstone without sending a provider prompt.";
}

async function prepareGoalFixture(
  connection: Connection,
  request: ReleaseSurfaceDriverRequest,
  action: GoalAction,
): Promise<GoalFixture> {
  const ui = await apiJson(connection, "GET", "/state/ui");
  const originalActiveTab = requireObject(ui.activeTab, "active UI tab");
  const tabId = typeof ui.activeTabId === "string" && ui.activeTabId
    ? ui.activeTabId
    : typeof originalActiveTab.tabId === "string" ? originalActiveTab.tabId : "";
  if (!tabId || originalActiveTab.tabId !== tabId) {
    throw new Error("RightRail Goal fixture requires one exact active renderer tab");
  }
  const originalRightTab = requireRightRailTab(ui.rightTab);
  const build = await apiJson(connection, "GET", `/build/state?tabId=${encodeURIComponent(tabId)}`);
  if (build.state !== null) throw new Error("RightRail Goal fixture refuses to replace an active Build run");
  const goal = await goalEnvelope(connection, tabId);
  if (goal.state !== null || goal.lastClear !== null) {
    throw new Error("RightRail Goal fixture refuses to replace existing Goal state or history");
  }

  const localRoot = mkdtempSync(join(tmpdir(), "shellx-release-right-rail-goal-"));
  const candidateRoot = candidatePath(localRoot, request.platform);
  const fixture = { tabId, localRoot, candidateRoot, originalActiveTab, originalRightTab };
  try {
    await postUi(connection, {
      openModal: "close",
      rightTab: "Plan",
      activeTab: { ...originalActiveTab, tabId, cwd: candidateRoot },
    });
    await waitForUi(connection, (state) => {
      const active = optionalObject(state.activeTab, "fixture active tab");
      return state.rightTab === "Plan" && active?.tabId === tabId && active.cwd === candidateRoot;
    }, "owned Plan-tab and cwd baseline");
    const releaseTestState = action === "review" ? "awaiting-review" : "active-approved";
    const started = await apiJson(connection, "POST", "/goal/start", {
      tabId,
      objective: `Verify ShellX RightRail ${action} lifecycle`,
      cwd: candidateRoot,
      releaseTestState,
    });
    if (started.ok !== true || started.tabId !== tabId || started.releaseTestState !== releaseTestState) {
      throw new Error("RightRail Goal fixture start did not return its exact isolated state");
    }
    await waitForGoalEnvelope(connection, tabId, (body) => {
      const state = optionalObject(body.state, "prepared Goal state");
      const approval = optionalObject(body.approvalStatus, "prepared Goal approval status");
      return state?.active === true
        && state.pausedByUser === false
        && (action === "review"
          ? state.awaitingApproval === true && approval?.ready === true
          : state.awaitingApproval === false);
    }, releaseTestState);
    return fixture;
  } catch (error) {
    const cleanupError = await cleanupGoalFixture(connection, fixture);
    throw new Error(cleanupError ? `${errorMessage(error)}; cleanup: ${cleanupError}` : errorMessage(error));
  }
}

async function cleanupGoalFixture(connection: Connection, fixture: GoalFixture): Promise<string | null> {
  const errors: string[] = [];
  try {
    const cleared = await apiJson(connection, "POST", "/goal/stop", {
      tabId: fixture.tabId,
      releaseTestClearState: true,
    });
    if (cleared.ok !== true || cleared.releaseTestCleared !== true) {
      throw new Error("owned Goal cleanup did not return its exact release-test receipt");
    }
    const envelope = await goalEnvelope(connection, fixture.tabId);
    if (envelope.state !== null || envelope.lastClear !== null) {
      throw new Error("owned Goal state or tombstone remained after cleanup");
    }
  } catch (error) {
    errors.push(errorMessage(error));
  }
  try {
    await postUi(connection, {
      openModal: "close",
      rightTab: fixture.originalRightTab,
      activeTab: { ...fixture.originalActiveTab, tabId: fixture.tabId },
    });
    await waitForUi(connection, (state) => {
      const active = optionalObject(state.activeTab, "restored active tab");
      return state.rightTab === fixture.originalRightTab
        && isDeepStrictEqual(active, fixture.originalActiveTab);
    }, "original RightRail and active-tab baseline");
  } catch (error) {
    errors.push(errorMessage(error));
  }
  try {
    if (existsSync(fixture.localRoot)) rmSync(fixture.localRoot, { recursive: true });
    if (existsSync(fixture.localRoot)) throw new Error("owned Goal fixture directory remained after cleanup");
  } catch (error) {
    errors.push(errorMessage(error));
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

async function waitForGoalState(
  connection: Connection,
  tabId: string,
  predicate: (state: Record<string, unknown>) => boolean,
  label: string,
): Promise<void> {
  await waitForGoalEnvelope(connection, tabId, (body) => {
    const state = optionalObject(body.state, `${label} Goal state`);
    return state !== null && predicate(state);
  }, label);
}

async function waitForGoalEnvelope(
  connection: Connection,
  tabId: string,
  predicate: (body: Record<string, unknown>) => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const body = await goalEnvelope(connection, tabId);
    if (predicate(body)) return;
    await delay(75);
  }
  throw new Error(`RightRail Goal fixture did not reach ${label}`);
}

async function goalEnvelope(connection: Connection, tabId: string): Promise<Record<string, unknown>> {
  const body = await apiJson(connection, "GET", `/goal/state?tabId=${encodeURIComponent(tabId)}`);
  if (body.tabId !== tabId || !("state" in body) || !("lastClear" in body) || !("approvalStatus" in body)) {
    throw new Error("Goal state omitted its exact envelope");
  }
  return body;
}

async function waitForUi(
  connection: Connection,
  predicate: (state: Record<string, unknown>) => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate(await apiJson(connection, "GET", "/state/ui"))) return;
    await delay(50);
  }
  throw new Error(`Debug UI did not restore ${label}`);
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    debugSurface: "app",
    source: "final-surface-right-rail-goal-driver",
    ...body,
  });
}

async function apiJson(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const headers = new Headers({ Authorization: `Bearer ${connection.token}` });
  if (body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 500)}`);
  const value = text ? JSON.parse(text) as unknown : null;
  return requireObject(value, `${method} ${path}`);
}

function candidatePath(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed" || process.platform === "win32") return path;
  const result = spawnSync("wslpath", ["-w", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("unable to map the owned RightRail Goal cwd for Windows");
  return result.stdout.trim();
}

function requireRightRailTab(value: unknown): RightRailTab {
  if (typeof value !== "string" || !RIGHT_RAIL_TABS.has(value as RightRailTab)) {
    throw new Error("RightRail Goal fixture requires a known original right tab");
  }
  return value as RightRailTab;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown, label: string): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  return requireObject(value, label);
}

function emptyOutcome(assignment: Assignment): ReleaseSurfaceDriverOutcome {
  return {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No native WebDriver RightRail Goal lifecycle transition was observed.",
  };
}

function applyCleanup(outcome: ReleaseSurfaceDriverOutcome, error: string | null): void {
  if (error) outcome.error = outcome.error ? `${outcome.error}; cleanup: ${error}` : `cleanup: ${error}`;
  else outcome.cleanup = "pass";
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "RightRail Goal control did not satisfy every required verdict";
  }
  return outcome;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
