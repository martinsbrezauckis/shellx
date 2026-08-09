import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import {
  clearReleaseSurfaceInstalledInputElement as clearReleaseSurfaceWebDriverElement,
  clickReleaseSurfaceInstalledInputElement as clickReleaseSurfaceWebDriverElement,
  createReleaseSurfaceInstalledInputSession,
  setReleaseSurfaceInstalledInputElementValue as setReleaseSurfaceWebDriverElementValue,
  waitForReleaseSurfaceInstalledInputElement as waitForReleaseSurfaceWebDriverElement,
  waitForReleaseSurfaceInstalledInputElementAbsent as waitForReleaseSurfaceWebDriverElementAbsent,
  type ReleaseSurfaceInstalledInputElement as ReleaseSurfaceWebDriverElement,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverOutcome,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "shellx-command-installed",
  kind: "shellx-command",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
  ],
  supportedFixtures: ["shellx-command:composer-empty", "shellx-command:owned-legacy-goal"],
  supportedCleanups: ["shellx-command:close-modal-and-clear-composer", "shellx-command:clear-owned-goal-and-delete-cwd"],
  supportedOracles: [
    "shellx-command:commands:palette-visible",
    "shellx-command:pr:dialog-visible",
    "shellx-command:pause:goal-paused",
    "shellx-command:resume:goal-resumed",
    "shellx-command:stop:goal-cleared",
    "shellx-command:build:objective-required",
    "shellx-command:goal:objective-required",
  ],
};

const COMMANDS: Record<string, { effectSelector: string; effectLabel: string }> = {
  "/commands": {
    effectSelector: "[role='dialog'][aria-label='Command palette']",
    effectLabel: "Command Palette",
  },
  "/pr": {
    effectSelector: ".pr-modal[role='dialog']",
    effectLabel: "Create pull request dialog",
  },
};

const PROMPT_SELECTOR = "[data-debug-id='composer-prompt']";
const SEND_SELECTOR = "[data-debug-id='composer-send']";
const GOAL_COMMANDS = new Set(["/pause", "/resume", "/stop"]);
const VALIDATION_COMMANDS = new Set(["/build", "/goal"]);
const VALIDATION_SELECTORS: Record<string, string> = {
  "/build": "[data-shellx-event-code='build-objective-required']",
  "/goal": "[data-shellx-event-code='goal-objective-required']",
};
type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes: ReleaseSurfaceDriverOutcome[] = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseCommand(request, connection, installedInput, assignment));
  }
  return {
    schema: RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
    mode: request.mode,
    driverId: request.driverId,
    driverKind: request.driverKind,
    platform: request.platform,
    sourceCommit: request.sourceCommit,
    version: request.version,
    inventoryDigest: request.inventoryDigest,
    artifactSha256: request.artifact.sha256,
    controller: request.controller,
    runtime: request.runtime,
    nativeWebDriver: request.nativeWebDriver,
    macosNativeInput: request.macosNativeInput,
    startedAt,
    completedAt: completionTimestamp(startedAt),
    outcomes,
  };
}

async function exerciseCommand(
  request: ReleaseSurfaceDriverRequest,
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const command = assignment.surface.name;
  const spec = COMMANDS[command];
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No ShellX command effect was observed.",
  };
  let promptElement: ReleaseSurfaceWebDriverElement | null = null;
  let goalFixture: GoalCommandFixture | null = null;
  try {
    if (!spec && !GOAL_COMMANDS.has(command) && !VALIDATION_COMMANDS.has(command)) {
      throw new Error(`ShellX command fixture does not support ${command}`);
    }
    await postUi(connection, { openModal: "close", debugHighlights: [] });
    if (GOAL_COMMANDS.has(command)) {
      goalFixture = await prepareGoalCommandFixture(request, connection, command);
    }
    promptElement = await waitForReleaseSurfaceWebDriverElement(webdriver, PROMPT_SELECTOR);
    const sendElement = await waitForReleaseSurfaceWebDriverElement(webdriver, SEND_SELECTOR);
    await clearReleaseSurfaceWebDriverElement(webdriver, promptElement);
    outcome.present = "pass";
    await setReleaseSurfaceWebDriverElementValue(webdriver, promptElement, command);
    await clickReleaseSurfaceWebDriverElement(webdriver, sendElement);
    outcome.invoke = "pass";
    if (spec) await waitForReleaseSurfaceWebDriverElement(webdriver, spec.effectSelector);
    else if (goalFixture) await assertGoalCommandEffect(connection, command, goalFixture);
    else await waitForReleaseSurfaceWebDriverElement(webdriver, VALIDATION_SELECTORS[command]!);
    outcome.effect = "pass";
    outcome.observedEffect = spec
      ? `${command} was entered and submitted through native installed-input events, opening the visible ${spec.effectLabel}.`
      : goalFixture
        ? `${command} was entered and submitted through native installed-input events, producing its exact owned goal-state transition.`
        : `${command} was entered and submitted through native installed-input events, producing its exact visible objective-required validation result.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await postUi(connection, { openModal: "close", debugHighlights: [] });
      if (promptElement) await clearReleaseSurfaceWebDriverElement(webdriver, promptElement);
      if (spec) await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, spec.effectSelector);
      if (goalFixture) await cleanupGoalCommandFixture(connection, goalFixture);
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "ShellX command did not satisfy every required verdict";
  }
  return outcome;
}

type GoalCommandFixture = {
  tabId: string;
  localRoot: string;
  originalActiveTab: Record<string, unknown>;
};

async function prepareGoalCommandFixture(
  request: ReleaseSurfaceDriverRequest,
  connection: Connection,
  command: string,
): Promise<GoalCommandFixture> {
  const state = await uiState(connection);
  const tabId = typeof state.activeTabId === "string" ? state.activeTabId : "";
  const originalActiveTab = state.activeTab && typeof state.activeTab === "object" && !Array.isArray(state.activeTab)
    ? { ...(state.activeTab as Record<string, unknown>) }
    : {};
  if (!tabId) throw new Error(`${command} fixture requires one active renderer tab`);
  const existingBuild = await debugState(connection, `/build/state?tabId=${encodeURIComponent(tabId)}`);
  if (existingBuild !== null) throw new Error(`${command} fixture refuses to replace a pre-existing Build Mode run`);
  const existingGoal = await goalState(connection, tabId);
  if (existingGoal !== null) throw new Error(`${command} fixture refuses to replace a pre-existing goal slot`);
  const localRoot = mkdtempSync(join(tmpdir(), "shellx-release-command-goal-"));
  const fixture = { tabId, localRoot, originalActiveTab };
  try {
    const candidateCwd = candidatePath(localRoot, request.platform);
    await postUi(connection, { activeTab: { ...originalActiveTab, tabId, cwd: candidateCwd } });
    await waitForUiState(connection, (next) => {
      const active = next.activeTab;
      return Boolean(active && typeof active === "object" && !Array.isArray(active)
        && (active as Record<string, unknown>).cwd === candidateCwd);
    }, `${command} disposable cwd`);
    const started = await debugPost(connection, "/goal/start", {
      tabId,
      objective: `Owned release fixture for ${command}`,
      cwd: candidateCwd,
    });
    if (started.ok !== true || started.tabId !== tabId) throw new Error(`${command} fixture start returned the wrong receipt`);
    if (command === "/resume") await debugPost(connection, "/goal/pause", { tabId });
    const goal = await goalState(connection, tabId);
    if (!goal || typeof goal !== "object" || Array.isArray(goal)
      || (goal as Record<string, unknown>).active !== true
      || (goal as Record<string, unknown>).pausedByUser !== (command === "/resume")) {
      throw new Error(`${command} fixture did not reach its exact opposite goal baseline`);
    }
    return fixture;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    let cleanupError: string | null = null;
    try {
      await cleanupGoalCommandFixture(connection, fixture);
    } catch (cleanup) {
      cleanupError = cleanup instanceof Error ? cleanup.message : String(cleanup);
    }
    throw new Error(cleanupError ? `${detail}; cleanup: ${cleanupError}` : detail);
  }
}

async function assertGoalCommandEffect(
  connection: Connection,
  command: string,
  fixture: GoalCommandFixture,
): Promise<void> {
  const goal = await goalState(connection, fixture.tabId);
  if (command === "/stop") {
    if (goal !== null) throw new Error("/stop did not clear the exact owned goal slot");
    return;
  }
  if (!goal || typeof goal !== "object" || Array.isArray(goal)) {
    throw new Error(`${command} did not preserve its owned goal slot`);
  }
  const expectedPaused = command === "/pause";
  if ((goal as Record<string, unknown>).active !== true
    || (goal as Record<string, unknown>).pausedByUser !== expectedPaused) {
    throw new Error(`${command} did not reach its exact owned paused state`);
  }
}

async function cleanupGoalCommandFixture(
  connection: Connection,
  fixture: GoalCommandFixture,
): Promise<void> {
  const errors: string[] = [];
  try {
    await debugPost(connection, "/goal/stop", { tabId: fixture.tabId });
    const cleared = await goalState(connection, fixture.tabId);
    if (cleared !== null) throw new Error("owned goal slot remained after cleanup");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    await postUi(connection, { activeTab: { ...fixture.originalActiveTab, tabId: fixture.tabId } });
    const originalCwd = fixture.originalActiveTab.cwd;
    if (typeof originalCwd === "string" && originalCwd.trim()) {
      await waitForUiState(connection, (state) => {
        const active = state.activeTab;
        return Boolean(active && typeof active === "object" && !Array.isArray(active)
          && (active as Record<string, unknown>).cwd === originalCwd);
      }, "ShellX command cwd cleanup");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    rmSync(fixture.localRoot, { recursive: true, force: true });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (errors.length > 0) throw new Error(errors.join(" | "));
}

function candidatePath(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed" || process.platform === "win32") return path;
  const result = spawnSync("wslpath", ["-w", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("unable to map the owned goal cwd for Windows");
  return result.stdout.trim();
}

async function goalState(connection: Connection, tabId: string): Promise<unknown> {
  return debugState(connection, `/goal/state?tabId=${encodeURIComponent(tabId)}`);
}

async function debugState(connection: Connection, path: string): Promise<unknown> {
  const body = await debugJson(connection, "GET", path);
  if (!("state" in body)) throw new Error(`${path} omitted its explicit state envelope`);
  return body.state;
}

async function debugPost(connection: Connection, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return debugJson(connection, "POST", path, body);
}

async function debugJson(
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
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${method} ${path} returned an invalid JSON object`);
  return value as Record<string, unknown>;
}

async function uiState(connection: Connection): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}/state/ui`, {
    headers: { Authorization: `Bearer ${connection.token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`GET /state/ui failed ${response.status}: ${await response.text()}`);
  return await response.json() as Record<string, unknown>;
}

async function waitForUiState(
  connection: Connection,
  predicate: (state: Record<string, unknown>) => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate(await uiState(connection))) return;
    await delay(100);
  }
  throw new Error(`${label} did not appear before timeout`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${connection.base}/state/ui`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ debugSurface: "app", source: "final-surface-shellx-command-driver", ...body }),
  });
  if (!response.ok) throw new Error(`POST /state/ui failed ${response.status}: ${await response.text()}`);
}

runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
