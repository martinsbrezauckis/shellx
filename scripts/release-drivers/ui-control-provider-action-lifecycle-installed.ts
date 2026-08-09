import { Buffer } from "node:buffer";
import { existsSync, lstatSync, mkdirSync, rmdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  clickReleaseSurfaceInstalledInputElement,
  clearReleaseSurfaceInstalledInputElement,
  closeReleaseSurfaceInstalledInputWindow,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue,
  switchReleaseSurfaceInstalledInputWindow,
  switchReleaseSurfaceInstalledInputWindowByTitle,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import { createReleaseSurfaceInstalledInputSession } from "../lib/release-surface-installed-input-client";
import { releaseSurfaceProfileLaunchRootFromDebugTokenPath } from "../lib/release-surface-run-profile";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import { ReleaseSurfaceTauriInvokeSession } from "../lib/release-surface-tauri-invoke-client";
import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverOutcome,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  WORK_PREVIEW_CENTER_CLOSE,
  WORK_PREVIEW_CENTER_DIALOG,
  WORK_PREVIEW_START_SELECTOR,
  cleanupFixture as cleanupWorkPreviewFixture,
  hydrateFixtureBaseline,
  nodeReadablePath,
  postUi,
  prepareFixture as prepareWorkPreviewFixture,
  verifyRunningState,
  waitForRunningState,
  type PreviewFixture,
} from "./ui-control-work-preview-start";
import {
  cleanupDebugApiBrowserSettleFixture,
  debugApiBrowserSettleRequestPath,
  prepareDebugApiBrowserSettleFixture,
  verifyDebugApiBrowserSettleJson,
  type DebugApiBrowserSettleFixture,
} from "./debug-api-browser-settle-fixture";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
export type ProviderActionLifecycleConfig = {
  action: string;
  selector: string;
  openPalette?: boolean;
};

const FIXTURE_ID = "provider-action-lifecycle";
const CLEANUP_ID = "ui:stop-owned-provider-action-delete-project-and-restore-view";
const RECEIPT = "[data-shellx-release-control='provider-action-receipt']";
const ACTIVITY_DIALOG = "[role='dialog'][aria-label='Activity Browser']";
const BROWSER_GOAL = "[data-debug-id='shellx-browser-goal']";
const BROWSER_SEND_PROMPT = "SHELLX_RELEASE_PROVIDER_ACTION_BROWSER_SEND_035";
const COMPOSER_PROMPT = "[data-debug-id='composer-prompt']";
const COMPOSER_SEND_PROMPT = "SHELLX_RELEASE_PROVIDER_ACTION_COMPOSER_SEND_035";

const ACTIONS = new Map<string, ProviderActionLifecycleConfig>([
  ['src/components/ActivityBrowserModal.tsx:role=button;name="Ask agent"', {
    action: "activity-ask-agent",
    selector: `${ACTIVITY_DIALOG} button`,
  }],
  ['src/components/BottomPanel.tsx:[data-debug-id="composer-send"]', {
    action: "composer-send",
    selector: "[data-debug-id='composer-send']",
  }],
  ['src/components/TasksPanel.tsx:[aria-label="Ask the active agent to inspect the visible background tasks"]', {
    action: "tasks-visible-ask",
    selector: "[title='Ask the active agent to inspect the visible background tasks']",
  }],
  ['src/components/TasksPanel.tsx:[title="Ask the active agent to inspect this background task and its latest output"]', {
    action: "tasks-row-ask",
    selector: "[title='Ask the active agent to inspect this background task and its latest output']",
  }],
  ['src/components/WorkPreviewPanel.tsx:[id="work-preview-ask-fix"]', {
    action: "work-preview-ask-fix",
    selector: "[id='work-preview-ask-fix']",
  }],
  ['src/components/WorkPreviewPanel.tsx:[data-debug-id="surface-components-workpreviewpanel-16"]', {
    action: "work-preview-browser-issue-fix",
    selector: "[data-debug-id='surface-components-workpreviewpanel-16']",
  }],
  ['src/components/WorkPreviewPanel.tsx:[id="work-preview-stage-ask-fix"]', {
    action: "work-preview-stage-ask-fix",
    selector: "[id='work-preview-stage-ask-fix']",
  }],
  ['src/components/RightRail.tsx:[data-debug-id="surface-components-rightrail-11"]', {
    action: "right-rail-connector-action",
    selector: "[data-debug-id='surface-components-rightrail-11']",
  }],
  ['src/components/RightRail.tsx:[title="Ask the active agent to inspect this diagnostic snapshot"]', {
    action: "right-rail-environment-ask",
    selector: "[title='Ask the active agent to inspect this diagnostic snapshot']",
  }],
  ['src/browser/components/AgentSidebar.tsx:[data-debug-id="shellx-browser-agent-send"]', {
    action: "browser-send",
    selector: "[data-debug-id='shellx-browser-agent-send']",
  }],
  ['src/browser/components/AgentSidebar.tsx:[data-debug-id="shellx-browser-chat-explain-page"]', {
    action: "browser-explain-page",
    selector: "[data-debug-id='shellx-browser-chat-explain-page']",
  }],
]);

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-control-provider-action-lifecycle-installed",
  kind: "ui-control",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/lib/release-surface-run-profile.ts",
    "scripts/lib/release-surface-tauri-invoke-client.ts",
    "scripts/release-drivers/ui-control-provider-action-lifecycle-installed.ts",
    "scripts/release-drivers/ui-control-work-preview-start.ts",
    "scripts/release-drivers/debug-api-browser-settle-fixture.ts",
    "scripts/shellx-browser-test-cleanup.ts",
    "src/lib/debug-provider-action-fixture.ts",
  ],
  supportedFixtures: [...new Set([...ACTIONS.values()].map(({ action }) => `ui:provider-action-owned-${action}`))],
  supportedCleanups: [CLEANUP_ID],
  supportedOracles: ["ui:activation:provider-action-prompt-dispatched"],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const input = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes: ReleaseSurfaceDriverOutcome[] = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseProviderActionLifecycle(connection, input, request, assignment));
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

export async function exerciseProviderActionLifecycle(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
  configOverride?: ProviderActionLifecycleConfig,
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = configOverride ?? ACTIONS.get(assignment.surface.name);
  const outcome = emptyOutcome(assignment);
  if (!config
    || assignment.fixtureId !== `ui:provider-action-owned-${config.action}`
    || assignment.oracleId !== "ui:activation:provider-action-prompt-dispatched"
    || assignment.cleanupId !== CLEANUP_ID) {
    outcome.error = `provider action driver rejected ${assignment.surface.name}`;
    return outcome;
  }
  const baseline = await uiState(connection);
  const providerDir = prepareProviderDirectory(request, config.action);
  let previewFixture: PreviewFixture | null = null;
  let terminal: { relay: ReleaseSurfaceTauriInvokeSession; tabId: string; terminalId: string } | null = null;
  let browserFixture: DebugApiBrowserSettleFixture | null = null;
  let mainWindowHandle: string | null = null;
  try {
    if (config.action.startsWith("work-preview-")) {
      previewFixture = await startOwnedWorkPreview(connection, input, request, config.action, providerDir.launchPath);
    } else if (config.action.startsWith("tasks-")) {
      terminal = await startOwnedTask(connection, input, request, config.action, providerDir.launchPath);
    } else if (config.action.startsWith("browser-")) {
      const activeTabId = typeof baseline.activeTabId === "string" ? baseline.activeTabId : "";
      const activeTab = record(baseline.activeTab);
      if (!activeTabId || activeTab?.tabId !== activeTabId || typeof activeTab.agentId !== "string" || !activeTab.agentId) {
        throw new Error("Browser provider action requires one exact active ShellX agent tab");
      }
      await postUi(connection, {
        debugRendererFixture: { id: FIXTURE_ID, action: config.action, cwd: providerDir.launchPath },
        source: "final-surface-provider-action-browser",
      });
      browserFixture = await prepareDebugApiBrowserSettleFixture(connection, { callerSessionId: activeTabId });
      const settlePath = debugApiBrowserSettleRequestPath("/browser/settle", browserFixture);
      const settled = await apiJson(connection, "GET", settlePath);
      verifyDebugApiBrowserSettleJson("/browser/settle", settled, browserFixture);
      const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(input, "ShellX Browser");
      mainWindowHandle = switched.originalHandle;
      if (config.action === "browser-send") {
        const goal = await waitForReleaseSurfaceInstalledInputElement(input, BROWSER_GOAL, { timeoutMs: 8_000, pollMs: 50 });
        await clearReleaseSurfaceInstalledInputElement(input, goal);
        await setReleaseSurfaceInstalledInputElementValue(input, goal, BROWSER_SEND_PROMPT);
      }
    } else {
      await postUi(connection, {
        ...(config.action.startsWith("right-rail-") ? { rightTab: "Tooling" } : {}),
        debugRendererFixture: { id: FIXTURE_ID, action: config.action, cwd: providerDir.launchPath },
        source: "final-surface-provider-action",
      });
      if (config.action === "composer-send") {
        const composer = await waitForReleaseSurfaceInstalledInputElement(input, COMPOSER_PROMPT);
        await clearReleaseSurfaceInstalledInputElement(input, composer);
        await setReleaseSurfaceInstalledInputElementValue(input, composer, COMPOSER_SEND_PROMPT);
      }
    }

    if (config.openPalette) {
      await postUi(connection, {
        openModal: "palette",
        source: "final-surface-provider-action-palette",
      });
    }

    const selector = config.action === "activity-ask-agent"
      ? "[role='dialog'][aria-label='Activity Browser'] button.pact"
      : config.selector;
    const control = await waitForReleaseSurfaceInstalledInputElement(input, selector, { timeoutMs: 8_000, pollMs: 50 });
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    outcome.invoke = "pass";
    if (config.action === "composer-send") {
      await waitForElementValue(input, COMPOSER_PROMPT, "");
    }
    if (browserFixture) {
      await waitForBrowserGoalValue(input, "");
      await verifyOwnedBrowserCoworkState(connection, browserFixture);
      if (!mainWindowHandle) throw new Error("Browser provider action lost its main-window handle");
      await switchReleaseSurfaceInstalledInputWindow(input, mainWindowHandle);
    }
    await waitForReleaseSurfaceInstalledInputElement(input, RECEIPT, { timeoutMs: 10_000, pollMs: 50 });
    const receipt = await observeReleaseSurfaceInstalledInputElement(input, RECEIPT, ["title"]);
    const title = typeof receipt.title === "string" ? receipt.title : "";
    const digest = exactReceiptDigest(title, config.action);
    await verifyProviderProcessReceipt(connection, config.action, digest);
    outcome.effect = "pass";
    outcome.observedEffect = `A native click dispatched the exact ${config.action} prompt to one release-owned disposable ShellX provider child, completed through the provider JSONL registry, and exposed its matching SHA-256 receipt; no external provider was called.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const errors: string[] = [];
    if (browserFixture && mainWindowHandle) {
      try {
        await switchReleaseSurfaceInstalledInputWindow(input, mainWindowHandle);
      } catch (error) {
        errors.push(`main window restore: ${errorText(error)}`);
      }
    }
    try {
      const composer = await findReleaseSurfaceInstalledInputElement(input, COMPOSER_PROMPT);
      if (composer) await clearReleaseSurfaceInstalledInputElement(input, composer);
      await postUi(connection, {
        debugRendererFixture: { id: FIXTURE_ID, action: "clear" },
        source: "final-surface-provider-action-cleanup",
      });
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, RECEIPT, { timeoutMs: 5_000, pollMs: 50 });
    } catch (error) {
      errors.push(`fixture clear: ${errorText(error)}`);
    }
    if (terminal) {
      try {
        await terminal.relay.invoke("pty_kill", { tabId: terminal.tabId, terminalId: terminal.terminalId });
        await terminal.relay.cleanup();
      } catch (error) {
        errors.push(`owned task: ${errorText(error)}`);
      }
    }
    if (previewFixture) {
      try {
        const modalOpen = Boolean(await findReleaseSurfaceInstalledInputElement(input, WORK_PREVIEW_CENTER_DIALOG));
        const error = await cleanupWorkPreviewFixture(connection, input, previewFixture, modalOpen);
        if (error) errors.push(`owned preview: ${error}`);
      } catch (error) {
        errors.push(`owned preview: ${errorText(error)}`);
      }
    }
    if (browserFixture) {
      try {
        const error = await cleanupDebugApiBrowserSettleFixture(connection, browserFixture);
        if (error) errors.push(`owned Browser: ${error}`);
      } catch (error) {
        errors.push(`owned Browser: ${errorText(error)}`);
      }
      try {
        const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(input, "ShellX Browser");
        await closeReleaseSurfaceInstalledInputWindow(input);
        await switchReleaseSurfaceInstalledInputWindow(input, mainWindowHandle ?? switched.originalHandle);
      } catch (error) {
        errors.push(`Browser window: ${errorText(error)}`);
      }
    }
    try {
      await restoreUi(connection, baseline);
    } catch (error) {
      errors.push(`view restore: ${errorText(error)}`);
    }
    try {
      if (existsSync(providerDir.nodePath)) rmdirSync(providerDir.nodePath);
      if (existsSync(providerDir.nodePath)) throw new Error("owned provider directory remained");
    } catch (error) {
      errors.push(`provider directory: ${errorText(error)}`);
    }
    if (errors.length === 0) outcome.cleanup = "pass";
    else outcome.error = appendError(outcome.error, `cleanup: ${errors.join("; ")}`);
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "provider action lifecycle did not satisfy every required verdict";
  }
  return outcome;
}

async function waitForElementValue(
  input: ReleaseSurfaceInstalledInputSession,
  selector: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observation = await observeReleaseSurfaceInstalledInputElement(input, selector, ["value"]);
    if (observation.present && observation.visible && observation.value === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`provider action did not expose the expected ${selector} value`);
}

async function waitForBrowserGoalValue(
  input: ReleaseSurfaceInstalledInputSession,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observation = await observeReleaseSurfaceInstalledInputElement(input, BROWSER_GOAL, ["value"]);
    if (observation.present && observation.visible && observation.value === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Browser provider action did not clear its exact visible message draft");
}

async function verifyOwnedBrowserCoworkState(
  connection: Connection,
  fixture: DebugApiBrowserSettleFixture,
): Promise<void> {
  const state = record(await apiJson(connection, "GET", "/browser/state"));
  const tasks = Array.isArray(state?.tasks) ? state.tasks.map(record).filter(Boolean) : [];
  const tabs = Array.isArray(state?.tabs) ? state.tabs.map(record).filter(Boolean) : [];
  const task = tasks.find((row) => row?.taskId === fixture.taskId);
  const tab = tabs.find((row) => row?.browserTabId === fixture.browserTabId);
  if (!task || task.status !== "running" || task.ownerSessionId !== fixture.callerSessionId
    || task.currentUrl !== fixture.url) {
    throw new Error("Browser provider action did not preserve its exact running owned task state");
  }
  if (!tab || tab.taskId !== fixture.taskId || tab.url !== fixture.url || tab.active !== true) {
    throw new Error("Browser provider action did not preserve its exact active owned tab and page");
  }
}

async function startOwnedTask(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  action: string,
  providerCwd: string,
): Promise<{ relay: ReleaseSurfaceTauriInvokeSession; tabId: string; terminalId: string }> {
  const state = await uiState(connection);
  const active = record(state.activeTab);
  const tabId = typeof active?.tabId === "string" ? active.tabId : "";
  if (!tabId) throw new Error("provider action task fixture requires one active tab");
  await postUi(connection, {
    rightTab: "Tasks",
    debugRendererFixture: { id: FIXTURE_ID, action, cwd: providerCwd },
    source: "final-surface-provider-action-task",
  });
  const relay = new ReleaseSurfaceTauriInvokeSession(connection);
  const terminalId = await relay.invoke("pty_create", {
    tabId,
    shell: request.platform === "windows-installed" ? "cmd.exe" : "/bin/sh",
    cwd: releaseSurfaceProfileLaunchRootFromDebugTokenPath(request.runtime.debugTokenPath, request.platform),
    cols: 80,
    rows: 24,
  });
  if (typeof terminalId !== "string" || !terminalId || !/^[A-Za-z0-9._:-]+$/.test(terminalId)) {
    throw new Error("provider action task fixture returned an invalid terminal identity");
  }
  const command = request.platform === "windows-installed"
    ? "echo SHELLX_RELEASE_PROVIDER_ACTION_TASK_035\r\n"
    : "echo SHELLX_RELEASE_PROVIDER_ACTION_TASK_035\n";
  await relay.invoke("pty_write", { tabId, terminalId, data: [...Buffer.from(command)] });
  const row = `[data-task-id='${tabId}:${terminalId}']`;
  await waitForReleaseSurfaceInstalledInputElement(input, row, { timeoutMs: 8_000, pollMs: 50 });
  if (action === "tasks-row-ask") {
    const toggle = await waitForReleaseSurfaceInstalledInputElement(input, `${row} [data-debug-id='surface-components-taskspanel-8']`);
    await clickReleaseSurfaceInstalledInputElement(input, toggle);
    await waitForReleaseSurfaceInstalledInputElement(input, `${row} [title='Ask the active agent to inspect this background task and its latest output']`);
  }
  return { relay, tabId, terminalId };
}

async function startOwnedWorkPreview(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  action: string,
  providerCwd: string,
): Promise<PreviewFixture> {
  const fixture = prepareWorkPreviewFixture(request);
  await hydrateFixtureBaseline(connection, fixture);
  await postUi(connection, {
    rightTab: "Preview",
    activeTabId: fixture.tabId,
    activeTab: { ...fixture.baselineActiveTab, cwd: fixture.launchRoot },
    debugRendererFixture: { id: FIXTURE_ID, action, cwd: providerCwd },
    source: "final-surface-provider-action-preview",
  });
  const start = await waitForReleaseSurfaceInstalledInputElement(input, WORK_PREVIEW_START_SELECTOR, { timeoutMs: 5_000, pollMs: 50 });
  await clickReleaseSurfaceInstalledInputElement(input, start);
  verifyRunningState(await waitForRunningState(connection, fixture), fixture);
  await waitForReleaseSurfaceInstalledInputElement(input, WORK_PREVIEW_CENTER_DIALOG, { timeoutMs: 5_000, pollMs: 50 });
  if (action === "work-preview-ask-fix" || action === "work-preview-palette-ask-fix") {
    const close = await waitForReleaseSurfaceInstalledInputElement(input, WORK_PREVIEW_CENTER_CLOSE);
    await clickReleaseSurfaceInstalledInputElement(input, close);
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, WORK_PREVIEW_CENTER_DIALOG);
  }
  return fixture;
}

function prepareProviderDirectory(
  request: ReleaseSurfaceDriverRequest,
  action: string,
): { nodePath: string; launchPath: string } {
  const tokenNodePath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const stat = lstatSync(tokenNodePath);
  if (!stat.isFile() || stat.isSymbolicLink() || basename(tokenNodePath) !== "shellxagent.token") {
    throw new Error("provider action fixture requires the installed candidate token");
  }
  const suffix = request.sourceCommit.slice(0, 8).toLowerCase().replace(/[^a-f0-9]/g, "0");
  const name = `release-provider-action-${action}-${suffix}`;
  const nodePath = resolve(dirname(tokenNodePath), name);
  if (existsSync(nodePath)) throw new Error(`provider action fixture directory pre-existed: ${name}`);
  mkdirSync(nodePath, { mode: 0o700 });
  const launchShellxHome = portableParent(request.runtime.debugTokenPath, request.platform);
  return { nodePath, launchPath: portableJoin(launchShellxHome, name, request.platform) };
}

async function verifyProviderProcessReceipt(connection: Connection, action: string, digest: string): Promise<void> {
  const tabId = `release-provider-action-${action}`;
  const state = record(await apiJson(connection, "GET", `/provider-sessions/state?tabId=${encodeURIComponent(tabId)}&transport=local`));
  const runs = Array.isArray(state?.recentRuns) ? state.recentRuns.map(record).filter(Boolean) : [];
  const completed = runs.find((run) => run?.phase === "completed" && run?.persistSession === false && run?.shellxToolExposure === "off");
  if (!completed || typeof completed.runId !== "string") throw new Error("provider action child lacked its exact completed registry row");
  const events = await apiJson(connection, "GET", `/events/recent?tabId=${encodeURIComponent(tabId)}&limit=200`);
  if (!Array.isArray(events) || !events.some((frame) => {
    const event = record(frame);
    const payload = record(event?.payload);
    return event?.kind === "provider-session-event"
      && payload?.runId === completed.runId
      && payload?.kind === "text"
      && payload?.text === `SHELLX_PROVIDER_ACTION_RECEIPT ${action} ${digest}`;
  })) {
    throw new Error("provider action child lacked its exact parsed process receipt event");
  }
}

function exactReceiptDigest(title: string, action: string): string {
  const prefix = `Provider action receipt — ${action} — `;
  if (!title.startsWith(prefix)) throw new Error("provider action receipt title did not match action");
  const digest = title.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("provider action receipt lacked a bounded SHA-256 digest");
  return digest;
}

async function restoreUi(connection: Connection, baseline: Record<string, unknown>): Promise<void> {
  const active = record(baseline.activeTab);
  const expectedRightTab = typeof baseline.rightTab === "string" ? baseline.rightTab : "Tasks";
  const expectedActiveTabId = typeof baseline.activeTabId === "string" ? baseline.activeTabId : null;
  await postUi(connection, {
    rightTab: expectedRightTab,
    ...(expectedActiveTabId ? { activeTabId: expectedActiveTabId } : {}),
    ...(active ? { activeTab: active } : {}),
    openModal: "close",
    source: "final-surface-provider-action-view-restore",
  });
  const restored = await uiState(connection);
  if (restored.rightTab !== expectedRightTab) {
    throw new Error(`provider action cleanup did not restore rightTab ${expectedRightTab}`);
  }
  if (expectedActiveTabId && restored.activeTabId !== expectedActiveTabId) {
    throw new Error(`provider action cleanup did not restore activeTabId ${expectedActiveTabId}`);
  }
  if (active && !jsonContains(restored.activeTab, active)) {
    throw new Error("provider action cleanup did not restore the submitted activeTab fields");
  }
}

async function uiState(connection: Connection): Promise<Record<string, unknown>> {
  return record(await apiJson(connection, "GET", "/state/ui")) ?? {};
}

async function apiJson(connection: Connection, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${(await response.text()).slice(0, 400)}`);
  return response.json();
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonContains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((value, index) => jsonContains(actual[index], value));
  }
  const expectedRecord = record(expected);
  if (expectedRecord) {
    const actualRecord = record(actual);
    return Boolean(actualRecord) && Object.entries(expectedRecord).every(([key, value]) => (
      Object.prototype.hasOwnProperty.call(actualRecord, key)
      && jsonContains(actualRecord?.[key], value)
    ));
  }
  return Object.is(actual, expected);
}

function portableParent(value: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  const separator = platform === "windows-installed" ? "\\" : "/";
  const normalized = value.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index <= 0 ? normalized : normalized.slice(0, index).replace(/[\\/]/g, separator);
}

function portableJoin(root: string, child: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  const separator = platform === "windows-installed" ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${child}`;
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
    observedEffect: "No exact provider action process lifecycle was observed.",
  };
}

function appendError(current: string | undefined, next: string): string {
  return current ? `${current}; ${next}` : next;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
    console.error(errorText(error));
    process.exitCode = 1;
  });
}
