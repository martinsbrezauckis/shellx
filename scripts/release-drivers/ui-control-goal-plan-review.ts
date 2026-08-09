import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { apiJson, nodeReadablePath } from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type GoalPlanReviewAction = "dismiss-header" | "dismiss-footer" | "open-edit" | "cancel-edit" | "edit-text"
  | "send-feedback" | "reject" | "approve";
type GoalProviderAction = "goal-approve" | "goal-replan";
type GoalActionConfig = {
  action: "send-feedback" | "reject" | "approve";
  fixtureId: string;
  selector: string;
  tabId: string;
  providerAction?: GoalProviderAction;
};

const DIALOG = "[role='dialog'][aria-label^='Review plan:']";
const HEADER_REVIEW_LATER = "[aria-label='Review later']";
const FOOTER_REVIEW_LATER = ".plan-review-actions > button:first-child";
const REQUEST_CHANGES = ".plan-review-actions > button:nth-of-type(3)";
const CANCEL_EDIT = ".plan-edit-actions > button:last-child";
const EDIT_TEXTAREA = "[placeholder='What should Grok change about this plan? (Ctrl+Enter to submit)']";
const EDIT_MARKER = "Clarify the inert release-surface verification phase.";
const LIVE_EDIT_MARKER = "Clarify the isolated Goal provider-action verification phase.";
const RIGHT_RAIL_TABS = new Set(["Tasks", "Tooling", "Git", "Preview", "Plan", "Files"] as const);

const actions = new Map<string, GoalPlanReviewAction>([
  ['ui-control:src/components/GoalPlanReviewModal.tsx:[aria-label="Review later"]@src/components/GoalPlanReviewModal.tsx#2', "dismiss-header"],
  ['ui-control:src/components/GoalPlanReviewModal.tsx:[placeholder="What should Grok change about this plan? (Ctrl+Enter to submit)"]@src/components/GoalPlanReviewModal.tsx#3', "edit-text"],
  ['ui-control:src/components/GoalPlanReviewModal.tsx:role=button;name="Cancel"@src/components/GoalPlanReviewModal.tsx#5', "cancel-edit"],
  ['ui-control:src/components/GoalPlanReviewModal.tsx:role=button;name="Review later"@src/components/GoalPlanReviewModal.tsx#6', "dismiss-footer"],
  ['ui-control:src/components/GoalPlanReviewModal.tsx:role=button;name="Request changes"@src/components/GoalPlanReviewModal.tsx#8', "open-edit"],
  ['ui-control:src/components/GoalPlanReviewModal.tsx:[data-debug-id="surface-components-goalplanreviewmodal-4"]@src/components/GoalPlanReviewModal.tsx#4', "send-feedback"],
  ['ui-control:src/components/GoalPlanReviewModal.tsx:[data-debug-id="surface-components-goalplanreviewmodal-7"]@src/components/GoalPlanReviewModal.tsx#7', "reject"],
  ['ui-control:src/components/GoalPlanReviewModal.tsx:[data-debug-id="surface-components-goalplanreviewmodal-9"]@src/components/GoalPlanReviewModal.tsx#9', "approve"],
]);

const liveActions = new Map<GoalPlanReviewAction, GoalActionConfig>([
  ["send-feedback", {
    action: "send-feedback",
    fixtureId: "ui:goal-plan-review-owned-send-feedback",
    selector: "[data-debug-id='surface-components-goalplanreviewmodal-4']",
    tabId: "release-goal-plan-replan",
    providerAction: "goal-replan",
  }],
  ["reject", {
    action: "reject",
    fixtureId: "ui:goal-plan-review-owned-reject",
    selector: "[data-debug-id='surface-components-goalplanreviewmodal-7']",
    tabId: "release-goal-plan-reject",
  }],
  ["approve", {
    action: "approve",
    fixtureId: "ui:goal-plan-review-owned-approve",
    selector: "[data-debug-id='surface-components-goalplanreviewmodal-9']",
    tabId: "release-goal-plan-approve",
    providerAction: "goal-approve",
  }],
]);

export const GOAL_PLAN_REVIEW_FIXTURES = [
  "ui:goal-plan-review-owned-review",
  "ui:goal-plan-review-owned-editing",
  "ui:goal-plan-review-owned-send-feedback",
  "ui:goal-plan-review-owned-reject",
  "ui:goal-plan-review-owned-approve",
] as const;

export const GOAL_PLAN_REVIEW_CLEANUPS = [
  "ui:close-goal-plan-review-owned-fixture",
  "ui:forget-owned-goal-provider-delete-cwd-and-restore-view",
] as const;

export const GOAL_PLAN_REVIEW_ORACLES = [
  "ui:activation:goal-plan-review-dismissed",
  "ui:activation:goal-plan-review-edit-opened",
  "ui:activation:goal-plan-review-edit-cancelled",
  "ui:value-state-transition",
  "ui:activation:goal-plan-review-owned-state-transition",
] as const;

export function supportsGoalPlanReviewControl(assignment: Assignment): boolean {
  return actions.has(assignment.surface.id);
}

export async function exerciseGoalPlanReviewControl(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = actions.get(assignment.surface.id);
  const liveAction = action ? liveActions.get(action) : undefined;
  if (liveAction) {
    return exerciseGoalPlanBackingAction(connection, installedInput, request, assignment, liveAction);
  }
  const outcome = emptyOutcome(assignment);
  try {
    if (!action) throw new Error(`unsupported Goal Plan Review control ${assignment.surface.id}`);
    const editing = action === "cancel-edit" || action === "edit-text";
    await postUi(connection, {
      goalPlanReviewFixture: editing ? "editing" : "review",
      source: "final-surface-goal-plan-review",
    });
    await waitForReleaseSurfaceInstalledInputElement(installedInput, DIALOG);

    if (action === "edit-text") {
      await exerciseEditText(installedInput, outcome);
    } else {
      const selector = action === "dismiss-header"
        ? HEADER_REVIEW_LATER
        : action === "dismiss-footer"
          ? FOOTER_REVIEW_LATER
          : action === "open-edit"
            ? REQUEST_CHANGES
            : CANCEL_EDIT;
      const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, selector);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(installedInput, control);
      outcome.invoke = "pass";
      if (action === "dismiss-header" || action === "dismiss-footer") {
        await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
        outcome.observedEffect = "Native installed input dismissed the inert renderer-only Goal Plan Review fixture without approving, rejecting, replanning, or contacting a provider.";
      } else if (action === "open-edit") {
        await waitForReleaseSurfaceInstalledInputElement(installedInput, EDIT_TEXTAREA);
        outcome.observedEffect = "Native installed input opened the inert local feedback editor without entering text, submitting feedback, or contacting a provider.";
      } else {
        await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, EDIT_TEXTAREA);
        await waitForReleaseSurfaceInstalledInputElement(installedInput, DIALOG);
        outcome.observedEffect = "Native installed input cancelled the inert local feedback draft while preserving the review dialog and without contacting a provider.";
      }
      outcome.effect = "pass";
    }
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    try {
      await postUi(connection, {
        goalPlanReviewFixture: "closed",
        source: "final-surface-goal-plan-review-cleanup",
      });
      await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = errorMessage(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Goal Plan Review control did not satisfy every required verdict";
  }
  return outcome;
}

type GoalUiState = {
  activeTabId: string;
  activeTab: Record<string, unknown>;
  rightTab: "Tasks" | "Tooling" | "Git" | "Preview" | "Plan" | "Files";
};

type OwnedGoalFixture = {
  tabId: string;
  nodeProject: string;
  launchProject: string;
  objective: string;
  baseline: GoalUiState;
};

async function exerciseGoalPlanBackingAction(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
  config: GoalActionConfig,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  if (assignment.fixtureId !== config.fixtureId
    || assignment.oracleId !== "ui:activation:goal-plan-review-owned-state-transition"
    || assignment.cleanupId !== "ui:forget-owned-goal-provider-delete-cwd-and-restore-view") {
    outcome.error = `Goal Plan Review ${config.action} assignment does not match its isolated lifecycle`;
    return outcome;
  }
  let fixture: OwnedGoalFixture | null = null;
  let fixtureStarted = false;
  try {
    fixture = await prepareOwnedGoalFixture(connection, request, config);
    fixtureStarted = true;
    await waitForReleaseSurfaceInstalledInputElement(installedInput, DIALOG, {
      timeoutMs: 8_000,
      pollMs: 50,
    });
    if (config.action === "send-feedback") {
      const requestChanges = await waitForReleaseSurfaceInstalledInputElement(installedInput, REQUEST_CHANGES);
      await clickReleaseSurfaceInstalledInputElement(installedInput, requestChanges);
      const textarea = await waitForReleaseSurfaceInstalledInputElement(installedInput, EDIT_TEXTAREA);
      await clearReleaseSurfaceInstalledInputElement(installedInput, textarea);
      await setReleaseSurfaceInstalledInputElementValue(installedInput, textarea, LIVE_EDIT_MARKER);
      const draft = await observeReleaseSurfaceInstalledInputElement(installedInput, EDIT_TEXTAREA, ["value"]);
      if (draft.value !== LIVE_EDIT_MARKER) throw new Error("Goal feedback fixture did not expose its exact draft");
    }
    const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, config.selector, {
      timeoutMs: 8_000,
      pollMs: 50,
    });
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    if (config.action === "reject") {
      await waitForGoalRejectConfirmation(installedInput, config.selector);
      const confirmation = await waitForReleaseSurfaceInstalledInputElement(installedInput, config.selector);
      await clickReleaseSurfaceInstalledInputElement(installedInput, confirmation);
    }
    outcome.invoke = "pass";

    if (config.action === "reject") {
      await waitForGoalEnvelope(connection, fixture.tabId, (body) => {
        const clear = optionalRecord(body.lastClear);
        return body.state === null && clear?.reason === "rejected";
      }, "rejected state and tombstone");
      outcome.observedEffect = "Two native installed clicks armed and confirmed rejection of only the exact isolated Goal plan, observed its rejected tombstone, and sent no provider prompt.";
    } else {
      const expectedAwaiting = config.action === "send-feedback";
      const state = await waitForGoalEnvelope(connection, fixture.tabId, (body) => {
        const goal = optionalRecord(body.state);
        return goal?.active === true
          && goal.awaitingApproval === expectedAwaiting
          && goal.planTurnCompleted === !expectedAwaiting;
      }, config.action === "approve" ? "approved Goal state" : "replan Goal state");
      if (config.action === "approve") {
        const goal = optionalRecord(state.state);
        const scratchboard = nodeReadablePath(String(goal?.scratchboardPath ?? ""), request.platform);
        if (!readFileSync(scratchboard, "utf8").includes("Status: IN_PROGRESS")) {
          throw new Error("Goal approval did not patch the exact owned scratchboard to IN_PROGRESS");
        }
      }
      const digest = await verifyGoalProviderFixture(connection, fixture.tabId, config.providerAction!);
      outcome.observedEffect = `Native installed input exercised the exact isolated Goal Plan ${config.action} action, observed its real orchestrator transition and correlated fixed JSONL provider receipt ${digest}.`;
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (fixture && fixtureStarted) {
      try {
        const cleared = await apiJson(connection, "POST", "/goal/stop", {
          tabId: fixture.tabId,
          releaseTestClearState: true,
        });
        if (cleared.releaseTestCleared !== true) throw new Error("Goal release-test state was not cleared");
        const envelope = await readGoalEnvelope(connection, fixture.tabId);
        if (envelope.state !== null || envelope.lastClear !== null) {
          throw new Error("Goal state or tombstone remained after exact cleanup");
        }
        if (config.providerAction) {
          const provider = await apiJson(connection, "GET", `/provider-sessions/state?tabId=${encodeURIComponent(fixture.tabId)}&transport=local`);
          if (provider.activeRun != null || !Array.isArray(provider.recentRuns) || provider.recentRuns.length !== 0) {
            throw new Error("fixed Goal provider child registry row remained after cleanup");
          }
        }
      } catch (error) {
        cleanupErrors.push(`Goal state: ${errorMessage(error)}`);
      }
    }
    if (fixture) {
      try {
        if (existsSync(fixture.nodeProject)) rmSync(fixture.nodeProject, { recursive: true });
        if (existsSync(fixture.nodeProject)) throw new Error("owned Goal project remained");
      } catch (error) {
        cleanupErrors.push(`filesystem: ${errorMessage(error)}`);
      }
      try {
        await postUi(connection, {
          goalPlanReviewFixture: "closed",
          rightTab: fixture.baseline.rightTab,
          activeTabId: fixture.baseline.activeTabId,
          activeTab: fixture.baseline.activeTab,
          source: "final-surface-goal-plan-action-cleanup",
        });
        const restored = await readGoalUiState(connection);
        if (restored.activeTabId !== fixture.baseline.activeTabId
          || restored.rightTab !== fixture.baseline.rightTab
          || JSON.stringify(restored.activeTab) !== JSON.stringify(fixture.baseline.activeTab)) {
          throw new Error("Goal action cleanup did not restore the exact UI baseline");
        }
      } catch (error) {
        cleanupErrors.push(`view: ${errorMessage(error)}`);
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else outcome.error = outcome.error
      ? `${outcome.error}; cleanup: ${cleanupErrors.join("; ")}`
      : `cleanup: ${cleanupErrors.join("; ")}`;
  }
  return outcome;
}

async function prepareOwnedGoalFixture(
  connection: Connection,
  request: ReleaseSurfaceDriverRequest,
  config: GoalActionConfig,
): Promise<OwnedGoalFixture> {
  const baseline = await readGoalUiState(connection);
  const existing = await readGoalEnvelope(connection, config.tabId);
  if (existing.state !== null || existing.lastClear !== null) {
    throw new Error("Goal Plan lifecycle refuses to replace existing Goal state or history");
  }
  const build = await apiJson(connection, "GET", `/build/state?tabId=${encodeURIComponent(config.tabId)}`);
  if (build.state !== null) throw new Error("Goal Plan lifecycle refuses to replace an active Build run");

  const tokenPath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const tokenStat = lstatSync(tokenPath);
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink()
    || basename(tokenPath) !== "shellxagent.token" || basename(dirname(tokenPath)) !== ".shellx") {
    throw new Error("Goal lifecycle requires the installed candidate's regular .shellx token");
  }
  const shellxHome = dirname(tokenPath);
  const suffix = request.sourceCommit.slice(0, 8).toLowerCase().replace(/[^a-f0-9]/g, "0");
  const directory = `${config.tabId}-${suffix}`;
  const nodeProject = resolve(shellxHome, directory);
  const rel = relative(resolve(shellxHome), nodeProject);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || existsSync(nodeProject)) {
    throw new Error("Goal lifecycle project is not a fresh direct candidate-home child");
  }
  mkdirSync(nodeProject, { mode: 0o700 });
  const launchShellxHome = portableParent(request.runtime.debugTokenPath, request.platform);
  const launchProject = portableJoin(launchShellxHome, directory, request.platform);
  const objective = `Exercise isolated Goal Plan modal ${config.providerAction ?? "goal-reject"}`;
  const fixture = { tabId: config.tabId, nodeProject, launchProject, objective, baseline };
  try {
    await postUi(connection, {
      goalPlanReviewFixture: "closed",
      rightTab: "Plan",
      activeTabId: config.tabId,
      activeTab: {
        ...baseline.activeTab,
        tabId: config.tabId,
        cwd: launchProject,
        status: "Connected",
      },
      source: "final-surface-goal-plan-action",
    });
    const started = await apiJson(connection, "POST", "/goal/start", {
      tabId: config.tabId,
      objective,
      cwd: launchProject,
      releaseTestState: "awaiting-review",
    });
    if (started.ok !== true || started.tabId !== config.tabId || started.releaseTestState !== "awaiting-review") {
      throw new Error("Goal Plan fixture start omitted its exact isolated receipt");
    }
    await waitForGoalEnvelope(connection, config.tabId, (body) => {
      const state = optionalRecord(body.state);
      const approval = optionalRecord(body.approvalStatus);
      return state?.active === true && state.awaitingApproval === true
        && state.planTurnCompleted === true && approval?.ready === true;
    }, "awaiting-review Goal state");
    return fixture;
  } catch (error) {
    try {
      await apiJson(connection, "POST", "/goal/stop", {
        tabId: config.tabId,
        releaseTestClearState: true,
      });
    } catch { /* cleanup continues below */ }
    if (existsSync(nodeProject)) rmSync(nodeProject, { recursive: true });
    await postUi(connection, {
      rightTab: baseline.rightTab,
      activeTabId: baseline.activeTabId,
      activeTab: baseline.activeTab,
      source: "final-surface-goal-plan-action-prepare-cleanup",
    }).catch(() => {});
    throw error;
  }
}

async function readGoalUiState(connection: Connection): Promise<GoalUiState> {
  const state = await apiJson(connection, "GET", "/state/ui");
  if (typeof state.activeTabId !== "string" || !optionalRecord(state.activeTab)
    || typeof state.rightTab !== "string" || !RIGHT_RAIL_TABS.has(state.rightTab as GoalUiState["rightTab"])) {
    throw new Error("Goal lifecycle could not read an exact restorable UI baseline");
  }
  return {
    activeTabId: state.activeTabId,
    activeTab: structuredClone(state.activeTab as Record<string, unknown>),
    rightTab: state.rightTab as GoalUiState["rightTab"],
  };
}

async function readGoalEnvelope(connection: Connection, tabId: string): Promise<Record<string, unknown>> {
  const body = await apiJson(connection, "GET", `/goal/state?tabId=${encodeURIComponent(tabId)}`);
  if (body.tabId !== tabId || !("state" in body) || !("lastClear" in body) || !("approvalStatus" in body)) {
    throw new Error("Goal state omitted its exact envelope");
  }
  return body;
}

async function waitForGoalEnvelope(
  connection: Connection,
  tabId: string,
  predicate: (body: Record<string, unknown>) => boolean,
  label: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    last = await readGoalEnvelope(connection, tabId);
    if (predicate(last)) return last;
    await delay(50);
  }
  throw new Error(`Goal Plan fixture did not reach ${label}: ${JSON.stringify(last)}`);
}

async function verifyGoalProviderFixture(
  connection: Connection,
  tabId: string,
  action: GoalProviderAction,
): Promise<string> {
  const deadline = Date.now() + 12_000;
  let last = "";
  while (Date.now() < deadline) {
    const state = await apiJson(connection, "GET", `/provider-sessions/state?tabId=${encodeURIComponent(tabId)}&transport=local`);
    const runs = Array.isArray(state.recentRuns) ? state.recentRuns.filter(optionalRecord) : [];
    const completed = runs.find((run) => run.phase === "completed"
      && run.persistSession === false && run.shellxToolExposure === "off");
    const response = await fetch(`${connection.base}/events/recent?tabId=${encodeURIComponent(tabId)}&limit=200`, {
      headers: { Authorization: `Bearer ${connection.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Goal provider events failed ${response.status}`);
    const events: unknown = await response.json();
    const rows = Array.isArray(events) ? events.filter(optionalRecord) : [];
    const goalEvent = rows.find((row) => {
      const payload = optionalRecord(row.payload);
      return row.kind === "goal-event" && payload?.kind === "release_fixture_provider_started"
        && payload.tabId === tabId && payload.action === action;
    });
    const goalPayload = goalEvent ? optionalRecord(goalEvent.payload) : null;
    const digest = typeof goalPayload?.promptSha256 === "string" ? goalPayload.promptSha256 : "";
    const textEvent = rows.find((row) => {
      const payload = optionalRecord(row.payload);
      return row.kind === "provider-session-event" && payload?.runId === completed?.runId
        && payload?.kind === "text" && payload.text === `SHELLX_PROVIDER_ACTION_RECEIPT ${action} ${digest}`;
    });
    last = `${String(completed?.runId ?? "no-run")}:${digest || "no-digest"}`;
    if (completed && /^[a-f0-9]{64}$/.test(digest) && textEvent) return digest;
    await delay(75);
  }
  throw new Error(`fixed Goal provider child lacked its correlated JSONL receipt: ${last}`);
}

async function waitForGoalRejectConfirmation(
  input: ReleaseSurfaceInstalledInputSession,
  selector: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(input, selector, ["title", "disabled"]);
    if (state.present && state.visible && state.disabled === false
      && state.title === "Confirm rejection and clear this Goal plan") return;
    await delay(50);
  }
  throw new Error("Goal Plan rejection did not reach its exact in-window confirmation state");
}

function portableParent(value: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  const separator = platform === "windows-installed" ? "\\" : "/";
  const normalized = value.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (index <= 0) throw new Error("Goal token path has no candidate ShellX-home parent");
  return normalized.slice(0, index).replace(/[\\/]/g, separator);
}

function portableJoin(root: string, child: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  const separator = platform === "windows-installed" ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${child}`;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function exerciseEditText(
  installedInput: ReleaseSurfaceInstalledInputSession,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, EDIT_TEXTAREA);
  outcome.present = "pass";
  await clearReleaseSurfaceInstalledInputElement(installedInput, control);
  await setReleaseSurfaceInstalledInputElementValue(installedInput, control, EDIT_MARKER);
  outcome.invoke = "pass";
  const entered = await observeReleaseSurfaceInstalledInputElement(installedInput, EDIT_TEXTAREA, ["value"]);
  if (entered.value !== EDIT_MARKER) {
    throw new Error("Goal Plan Review feedback draft did not expose the exact owned value transition");
  }
  await clearReleaseSurfaceInstalledInputElement(installedInput, control);
  const restored = await observeReleaseSurfaceInstalledInputElement(installedInput, EDIT_TEXTAREA, ["value"]);
  if (restored.value !== "") {
    throw new Error("Goal Plan Review feedback draft was not exactly cleared");
  }
  outcome.effect = "pass";
  outcome.observedEffect = "Native installed text entry changed and exactly cleared only the inert local Goal Plan Review feedback draft; no feedback was submitted and no provider was contacted.";
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${connection.base}/state/ui`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ debugSurface: "app", ...body }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`POST /state/ui failed ${response.status}: ${(await response.text()).slice(0, 800)}`);
  }
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
    observedEffect: "No inert native Goal Plan Review transition was observed.",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
