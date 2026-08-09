import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  performReleaseSurfaceInstalledInputKeyChord,
  setReleaseSurfaceInstalledInputElementValue,
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
type WebDriver = ReleaseSurfaceInstalledInputSession;
type UiTab = Record<string, unknown> & { tabId: string };
type UiState = Record<string, unknown> & {
  activeTabId?: unknown;
  openTabs?: unknown;
  preview?: unknown;
};
type Action = "graph-reset" | "graph-node" | "graph-open" | "graph-recent"
  | "tree-expand" | "tree-name" | "timeline" | "evidence-row";
export type ActivityFixture = {
  id: string;
  marker: string;
  title: string;
  cwd: string;
  filePath: string;
  relativeFilePath: string;
  nestedDirectoryPath: string;
  sessionPath: string;
  scratchDir: string;
  workspaceRoot: string;
  removableParents: string[];
};
export type ActivityClipboardLifecycleContext = {
  fixture: ActivityFixture;
  baselineTabs: UiTab[];
  baselineActiveId: string;
  baselinePreview: unknown;
  ownedTabId: string;
};

const ACTIVITY_DIALOG = "[role='dialog'][aria-label='Activity Browser']";
const PREVIEW_DIALOG = "[role='dialog'][aria-label='Preview Center']";
const INPUT = "[data-debug-id='find-sessions-input']";
const DISK_ROW = "[data-debug-id='surface-components-findpopover-4']";
const DISK_ROW_SELECTED = `${DISK_ROW}[aria-selected='true']`;
const FIND_PREVIEW = ".find-preview";
const FIND_POPOVER = ".find-popover";
const OPEN_NEW_TAB = "[title='Open this chat in a new tab (Enter)']";
const SHELL = ".shell";
const GRAPH_TAB = "[data-debug-id='activity-tab-graph']";
const FILES_TAB = "[data-debug-id='activity-tab-files']";
const TIMELINE_TAB = "[data-debug-id='activity-tab-timeline']";
const EVIDENCE_TAB = "[data-debug-id='activity-tab-evidence']";
const GRAPH_RESET = "[aria-label='Reset graph layout']";
const GRAPH_OPEN = ".activity-graph-open";

function activityId(selector: string, occurrence: number): string {
  return `ui-control:src/components/ActivityBrowserModal.tsx:${selector}@src/components/ActivityBrowserModal.tsx#${occurrence}`;
}

const ACTIONS = new Map<string, Action>([
  [activityId('[aria-label="Reset graph layout"]', 13), "graph-reset"],
  [activityId('[data-debug-id="surface-components-activitybrowsermodal-14"]', 14), "graph-node"],
  [activityId('role=button;name="Open file"', 15), "graph-open"],
  [activityId('[data-debug-id="surface-components-activitybrowsermodal-16"]', 16), "graph-recent"],
  [activityId('[data-debug-id="surface-components-activitybrowsermodal-17"]', 17), "tree-expand"],
  [activityId('[data-debug-id="surface-components-activitybrowsermodal-18"]', 18), "tree-name"],
  [activityId('[data-debug-id="surface-components-activitybrowsermodal-19"]', 19), "timeline"],
  [activityId('[data-debug-id="surface-components-activitybrowsermodal-21"]', 21), "evidence-row"],
]);

export const ACTIVITY_BROWSER_LIFECYCLE_SURFACE_IDS = new Set(ACTIONS.keys());
export const ACTIVITY_BROWSER_LIFECYCLE_FIXTURES = [
  "ui:activity-browser-owned-session-file",
] as const;
export const ACTIVITY_BROWSER_LIFECYCLE_CLEANUPS = [
  "ui:close-owned-activity-preview-and-tab-delete-exact-fixture-restore-baseline",
] as const;
export const ACTIVITY_BROWSER_LIFECYCLE_ORACLES = [
  "ui:activation:activity-graph-layout-reset",
  "ui:activation:activity-owned-file-preview",
  "ui:boolean-state-transition",
  "ui:disclosure-state-transition",
] as const;

export function supportsActivityBrowserLifecycleControl(assignment: Assignment): boolean {
  return ACTIONS.has(assignment.surface.id);
}

export async function exerciseActivityBrowserLifecycleControl(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = ACTIONS.get(assignment.surface.id);
  const outcome = emptyOutcome(assignment);
  let fixture: ActivityFixture | null = null;
  let baselineTabs: UiTab[] = [];
  let baselineActiveId = "";
  let baselinePreview: unknown = null;
  let ownedTabId = "";
  try {
    if (!action) throw new Error(`Activity Browser lifecycle driver does not support ${assignment.surface.id}`);
    const baseline = await uiState(connection);
    baselineTabs = exactTabs(baseline, "Activity Browser baseline");
    baselineActiveId = exactActiveId(baseline, baselineTabs, "Activity Browser baseline");
    baselinePreview = baseline.preview ?? null;
    fixture = prepareActivityFixture(request);
    if (baselineTabs.some((tab) => tab.sessionId === fixture!.id)) {
      throw new Error("owned Activity Browser session already existed in the renderer baseline");
    }
    ownedTabId = await openOwnedSession(connection, webdriver, fixture, baselineTabs);
    await postUi(connection, { openModal: "activity" });
    await waitForReleaseSurfaceInstalledInputElement(webdriver, ACTIVITY_DIALOG);
    await waitForReleaseSurfaceInstalledInputElement(webdriver, FILES_TAB);

    if (action === "graph-node") {
      await openGraph(webdriver);
      const selector = graphNodeSelector(fixture);
      await assertPressed(webdriver, selector, false);
      await invoke(webdriver, selector, outcome);
      await assertPressed(webdriver, selector, true);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, GRAPH_OPEN);
      outcome.effect = "pass";
      outcome.observedEffect = "Native input selected the exact owned file node, changed its declared selection state, and rendered the matching file details.";
    } else if (action === "graph-reset") {
      await openGraph(webdriver);
      const selector = graphNodeSelector(fixture);
      await clickSelector(webdriver, selector);
      await assertFocused(webdriver, selector, true);
      await assertAbsent(webdriver, GRAPH_RESET, "pristine graph reset control");
      await performReleaseSurfaceInstalledInputKeyChord(
        webdriver,
        [webdriver.transport === "native-webdriver" ? "\uE014" : "right"],
      );
      const reset = await waitForReleaseSurfaceInstalledInputElement(webdriver, GRAPH_RESET);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, reset);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, GRAPH_RESET);
      outcome.effect = "pass";
      outcome.observedEffect = "Keyboard input nudged the focused owned graph node, exposed Reset graph layout, and native activation restored the deterministic layout state.";
    } else if (action === "tree-expand") {
      const selector = treeExpandSelector(fixture);
      await assertExpanded(webdriver, selector, false);
      await invoke(webdriver, selector, outcome);
      await assertExpanded(webdriver, selector, true);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, treeNameSelector(fixture));
      outcome.effect = "pass";
      outcome.observedEffect = "Native input expanded the exact nested owned directory and exposed its owned file row with declared accessibility state.";
    } else {
      const selector = await fileOpeningSelector(webdriver, fixture, action);
      await invoke(webdriver, selector, outcome);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, ACTIVITY_DIALOG);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, PREVIEW_DIALOG);
      await waitForExactPreview(connection, fixture.filePath, ownedTabId);
      outcome.effect = "pass";
      outcome.observedEffect = previewObservation(action);
    }
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const cleanupError = await cleanup(
      connection,
      webdriver,
      fixture,
      baselineTabs,
      baselineActiveId,
      baselinePreview,
      ownedTabId,
    );
    if (cleanupError) outcome.error = appendError(outcome.error, `cleanup: ${cleanupError}`);
    else if (fixture && baselineTabs.length > 0 && baselineActiveId) outcome.cleanup = "pass";
  }
  return finalize(outcome);
}

async function fileOpeningSelector(
  webdriver: WebDriver,
  fixture: ActivityFixture,
  action: Exclude<Action, "graph-reset" | "graph-node" | "tree-expand">,
): Promise<string> {
  if (action === "graph-open" || action === "graph-recent") {
    await openGraph(webdriver);
    await clickSelector(webdriver, graphNodeSelector(fixture));
    return action === "graph-open" ? GRAPH_OPEN : activityPathSelector(16, fixture.filePath);
  }
  if (action === "tree-name") {
    await clickSelector(webdriver, treeExpandSelector(fixture));
    return treeNameSelector(fixture);
  }
  if (action === "timeline") {
    await clickSelector(webdriver, TIMELINE_TAB);
    return activityPathSelector(19, fixture.filePath);
  }
  await clickSelector(webdriver, EVIDENCE_TAB);
  return activityPathSelector(21, fixture.filePath);
}

async function openGraph(webdriver: WebDriver): Promise<void> {
  await clickSelector(webdriver, GRAPH_TAB);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, ".activity-graph-view");
}

async function openOwnedSession(
  connection: Connection,
  webdriver: WebDriver,
  fixture: ActivityFixture,
  baselineTabs: UiTab[],
): Promise<string> {
  await postUi(connection, { openModal: "close", refreshPastChats: true });
  const shell = await waitForReleaseSurfaceInstalledInputElement(webdriver, SHELL);
  await clickReleaseSurfaceInstalledInputElement(webdriver, shell);
  await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, FIND_POPOVER);
  const input = await waitForReleaseSurfaceInstalledInputElement(webdriver, INPUT);
  await clearReleaseSurfaceInstalledInputElement(webdriver, input);
  await setReleaseSurfaceInstalledInputElementValue(webdriver, input, fixture.marker);
  const row = await waitForReleaseSurfaceInstalledInputElement(webdriver, DISK_ROW, { timeoutMs: 10_000, pollMs: 100 });
  await clickReleaseSurfaceInstalledInputElement(webdriver, row);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, DISK_ROW_SELECTED);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, FIND_PREVIEW);
  await clickSelector(webdriver, OPEN_NEW_TAB);
  await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, FIND_POPOVER);
  const opened = await waitForUiState(connection, (state) => {
    const tabs = safeTabs(state);
    const owned = tabs.filter((tab) => tab.sessionId === fixture.id);
    return tabs.length === baselineTabs.length + 1
      && baselineTabs.every((tab, index) => tabs[index]?.tabId === tab.tabId)
      && owned.length === 1
      && state.activeTabId === owned[0]?.tabId;
  }, "owned Activity Browser session tab activation");
  const owned = safeTabs(opened).filter((tab) => tab.sessionId === fixture.id);
  if (owned.length !== 1 || !owned[0]) throw new Error("owned Activity Browser tab identity was ambiguous");
  return owned[0].tabId;
}

export function prepareActivityFixture(request: ReleaseSurfaceDriverRequest): ActivityFixture {
  const nativeTokenPath = request.runtime.debugTokenPath;
  const windowsNative = request.platform === "windows-installed" && /^[A-Za-z]:[\\/]/.test(nativeTokenPath);
  const nativeDirname = windowsNative ? win32.dirname : dirname;
  const nativeJoin = windowsNative ? win32.join : join;
  const nativeShellxHome = nativeDirname(nativeTokenPath);
  const nativeProfileRoot = nativeDirname(nativeShellxHome);
  const nodeProfileRoot = nodeReadablePath(nativeProfileRoot, request.platform);
  const commit = request.sourceCommit.slice(0, 16).toLowerCase().replace(/[^a-f0-9]/g, "0");
  const id = `release_activity_${commit}`;
  const marker = `SHELLX_RELEASE_ACTIVITY_CANARY_${commit}`;
  const title = `Release Activity Browser ${commit}`;
  const relativeFilePath = "src/nested/owned-activity.ts";
  const cwd = nativeJoin(nativeProfileRoot, "release-activity-workspace", id);
  const filePath = nativeJoin(cwd, ...relativeFilePath.split("/"));
  const nestedDirectoryPath = nativeJoin(cwd, "src", "nested");
  const workspaceRoot = join(nodeProfileRoot, "release-activity-workspace", id);
  const nodeFilePath = join(workspaceRoot, ...relativeFilePath.split("/"));
  const sessionPath = join(nodeProfileRoot, ".shellx", "sessions", `${id}.jsonl`);
  const sessionParent = dirname(sessionPath);
  const grokRoot = join(nodeProfileRoot, ".grok");
  const grokSessions = join(grokRoot, "sessions");
  const scratchParent = join(grokSessions, encodeURIComponent(cwd));
  const scratchDir = join(scratchParent, id);
  const workspaceParent = dirname(workspaceRoot);
  const removableParents = [sessionParent, grokRoot, grokSessions, scratchParent, workspaceParent]
    .filter((path) => !existsSync(path));
  for (const path of [sessionPath, scratchDir, workspaceRoot]) {
    if (existsSync(path)) throw new Error(`owned Activity Browser fixture path already exists: ${path}`);
  }
  const fixture = {
    id, marker, title, cwd, filePath, relativeFilePath, nestedDirectoryPath,
    sessionPath, scratchDir, workspaceRoot, removableParents,
  };
  try {
    mkdirSync(dirname(nodeFilePath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(sessionPath), { recursive: true, mode: 0o700 });
    mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
    writeFileSync(nodeFilePath, `export const activityCanary = ${JSON.stringify(marker)};\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const split = Math.floor(marker.length / 2);
    const sessionRecords = [
    {
      t: 1_000,
      payload: { method: "session/new", params: { cwd }, _meta: { cwd } },
    },
    {
      t: 2_000,
      payload: {
        params: { update: { sessionUpdate: "session_summary_generated", session_summary: title } },
      },
    },
    {
      t: 3_000,
      payload: {
        params: {
          update: { sessionUpdate: "agent_message_chunk", content: { text: marker.slice(0, split) } },
        },
      },
    },
    {
      t: 3_001,
      payload: {
        params: {
          update: { sessionUpdate: "agent_message_chunk", content: { text: marker.slice(split) } },
        },
      },
    },
    ];
    writeFileSync(sessionPath, `${sessionRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const hunkRecords = [
    {
      hunkId: `${id}-created`, filePath, hunkStart: 1, hunkEnd: 1,
      linesAdded: 1, linesRemoved: 0, authorType: "agent", sourceType: "agentEdit",
      eventType: "created", sessionId: id, timestamp: "2026-07-31T08:00:00.000Z", promptIndex: 1,
    },
    {
      hunkId: `${id}-written`, filePath, hunkStart: 1, hunkEnd: 1,
      linesAdded: 1, linesRemoved: 1, authorType: "agent", sourceType: "agentEdit",
      eventType: "written", sessionId: id, timestamp: "2026-07-31T08:01:00.000Z", promptIndex: 1,
    },
    ];
    writeFileSync(join(scratchDir, "hunk_records.jsonl"), `${hunkRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const update = {
      timestamp: "2026-07-31T08:02:00.000Z",
      params: { update: { sessionUpdate: "tool_call", toolCallId: `${id}-read`, title: "read_file", rawInput: { variant: "readfile", target_file: filePath } } },
    };
    writeFileSync(join(scratchDir, "updates.jsonl"), `${JSON.stringify(update)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return fixture;
  } catch (error) {
    try {
      cleanupActivityFixture(fixture);
    } catch (cleanupError) {
      throw new Error(`${errorText(error)}; fixture setup cleanup: ${errorText(cleanupError)}`);
    }
    throw error;
  }
}

export async function prepareActivityClipboardLifecycle(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
): Promise<ActivityClipboardLifecycleContext> {
  const baseline = await uiState(connection);
  const baselineTabs = exactTabs(baseline, "Activity clipboard baseline");
  const baselineActiveId = exactActiveId(baseline, baselineTabs, "Activity clipboard baseline");
  const baselinePreview = baseline.preview ?? null;
  const fixture = prepareActivityFixture(request);
  const ownedTabId = await openOwnedSession(connection, webdriver, fixture, baselineTabs);
  await postUi(connection, { openModal: "activity", source: "final-surface-activity-clipboard" });
  await waitForReleaseSurfaceInstalledInputElement(webdriver, ACTIVITY_DIALOG);
  return { fixture, baselineTabs, baselineActiveId, baselinePreview, ownedTabId };
}

export async function cleanupActivityClipboardLifecycle(
  connection: Connection,
  webdriver: WebDriver,
  context: ActivityClipboardLifecycleContext,
): Promise<string | null> {
  return cleanup(
    connection,
    webdriver,
    context.fixture,
    context.baselineTabs,
    context.baselineActiveId,
    context.baselinePreview,
    context.ownedTabId,
  );
}

async function cleanup(
  connection: Connection,
  webdriver: WebDriver,
  fixture: ActivityFixture | null,
  baselineTabs: UiTab[],
  baselineActiveId: string,
  baselinePreview: unknown,
  observedOwnedTabId: string,
): Promise<string | null> {
  const errors: string[] = [];
  await cleanupAttempt(errors, async () => {
    await postUi(connection, { openModal: "close", clearPreview: true });
    await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, ACTIVITY_DIALOG);
    await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, PREVIEW_DIALOG);
    const input = await findReleaseSurfaceInstalledInputElement(webdriver, INPUT);
    if (input) await clearReleaseSurfaceInstalledInputElement(webdriver, input);
    await clickSelector(webdriver, SHELL);
    await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, FIND_POPOVER);
  });
  if (fixture) {
    await cleanupAttempt(errors, async () => {
      const current = await uiState(connection);
      const ownedIds = safeTabs(current).filter((tab) => tab.sessionId === fixture.id).map((tab) => tab.tabId);
      if (observedOwnedTabId && ownedIds.length > 0 && !ownedIds.includes(observedOwnedTabId)) {
        throw new Error("owned Activity Browser tab identity changed before cleanup");
      }
      for (const tabId of [...new Set(ownedIds)].reverse()) {
        const selector = ownedCloseSelector(tabId);
        await clickSelector(webdriver, selector);
        await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, selector);
      }
    });
  }
  if (baselineTabs.length > 0 && baselineActiveId) {
    await cleanupAttempt(errors, async () => {
      const current = await uiState(connection);
      if (current.activeTabId !== baselineActiveId) await clickSelector(webdriver, tabSelector(baselineActiveId));
      if (baselinePreview && typeof baselinePreview === "object" && !Array.isArray(baselinePreview)) {
        await postUi(connection, { preview: baselinePreview });
      } else {
        await postUi(connection, { clearPreview: true });
      }
      await waitForUiState(connection, (state) => {
        const tabs = safeTabs(state);
        return tabs.length === baselineTabs.length
          && tabs.every((tab, index) => tab.tabId === baselineTabs[index]?.tabId)
          && state.activeTabId === baselineActiveId
          && JSON.stringify(state.preview ?? null) === JSON.stringify(baselinePreview ?? null);
      }, "Activity Browser exact UI baseline restoration");
    });
  }
  if (fixture) {
    try {
      cleanupActivityFixture(fixture);
      await postUi(connection, { refreshPastChats: true });
    } catch (error) {
      errors.push(errorText(error));
    }
  }
  return errors.length > 0 ? errors.join(" | ") : null;
}

export function cleanupActivityFixture(fixture: ActivityFixture): void {
  if (existsSync(fixture.sessionPath)) rmSync(fixture.sessionPath);
  if (existsSync(fixture.scratchDir)) rmSync(fixture.scratchDir, { recursive: true });
  if (existsSync(fixture.workspaceRoot)) rmSync(fixture.workspaceRoot, { recursive: true });
  for (const path of [...fixture.removableParents].sort((left, right) => right.length - left.length)) {
    if (existsSync(path)) rmdirSync(path);
  }
  if (existsSync(fixture.sessionPath) || existsSync(fixture.scratchDir) || existsSync(fixture.workspaceRoot)
    || fixture.removableParents.some((path) => existsSync(path))) {
    throw new Error("owned Activity Browser fixture remained after exact cleanup");
  }
}

async function waitForExactPreview(connection: Connection, filePath: string, tabId: string): Promise<void> {
  await waitForUiState(connection, (state) => {
    const preview = state.preview;
    return Boolean(preview && typeof preview === "object" && !Array.isArray(preview)
      && (preview as Record<string, unknown>).kind === "file"
      && (preview as Record<string, unknown>).path === filePath
      && (preview as Record<string, unknown>).tabId === tabId);
  }, "exact owned Activity Browser file preview");
}

async function invoke(webdriver: WebDriver, selector: string, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, selector);
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(webdriver, control);
  outcome.invoke = "pass";
}

async function clickSelector(webdriver: WebDriver, selector: string): Promise<void> {
  await clickReleaseSurfaceInstalledInputElement(webdriver, await waitForReleaseSurfaceInstalledInputElement(webdriver, selector));
}

async function assertPressed(webdriver: WebDriver, selector: string, expected: boolean): Promise<void> {
  await waitForObservation(webdriver, selector, "pressed", expected);
}

async function assertExpanded(webdriver: WebDriver, selector: string, expected: boolean): Promise<void> {
  await waitForObservation(webdriver, selector, "expanded", expected);
}

async function assertFocused(webdriver: WebDriver, selector: string, expected: boolean): Promise<void> {
  await waitForObservation(webdriver, selector, "focused", expected);
}

async function waitForObservation(
  webdriver: WebDriver,
  selector: string,
  field: "pressed" | "expanded" | "focused",
  expected: boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const observed = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, [field]);
    if (observed.present && observed.visible && observed[field] === expected) return;
    await delay(50);
  }
  throw new Error(`${selector} did not reach ${field}=${expected}`);
}

async function assertAbsent(webdriver: WebDriver, selector: string, label: string): Promise<void> {
  if (await findReleaseSurfaceInstalledInputElement(webdriver, selector)) throw new Error(`${label} unexpectedly existed`);
}

function graphNodeSelector(fixture: ActivityFixture): string {
  return `[data-debug-id='surface-components-activitybrowsermodal-14'][title='${cssString(fixture.relativeFilePath)}']`;
}

function treeExpandSelector(fixture: ActivityFixture): string {
  return activityPathSelector(17, fixture.nestedDirectoryPath.replaceAll("\\", "/"));
}

function treeNameSelector(fixture: ActivityFixture): string {
  return activityPathSelector(18, fixture.filePath.replaceAll("\\", "/"));
}

function activityPathSelector(occurrence: 16 | 17 | 18 | 19 | 21, path: string): string {
  return `[data-debug-id='surface-components-activitybrowsermodal-${occurrence}'][data-activity-path='${cssString(path)}']`;
}

function cssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function previewObservation(action: Action): string {
  const owner = action === "graph-open" ? "graph detail Open file"
    : action === "graph-recent" ? "graph Recent evidence row"
      : action === "tree-name" ? "Files tree name"
        : action === "timeline" ? "Timeline row"
          : "Evidence row";
  return `Native input activated the exact owned ${owner}, closed Activity Browser, and opened the same owned file in Preview Center with exact Debug API identity.`;
}

function exactTabs(state: UiState, label: string): UiTab[] {
  const tabs = safeTabs(state);
  if (!Array.isArray(state.openTabs) || tabs.length !== state.openTabs.length || tabs.length === 0) {
    throw new Error(`${label} did not expose a nonempty exact openTabs array`);
  }
  if (new Set(tabs.map((tab) => tab.tabId)).size !== tabs.length) throw new Error(`${label} contained duplicate tab identities`);
  return tabs;
}

function safeTabs(state: UiState): UiTab[] {
  if (!Array.isArray(state.openTabs)) return [];
  return state.openTabs.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const tab = value as Record<string, unknown>;
    return typeof tab.tabId === "string" && tab.tabId ? [tab as UiTab] : [];
  });
}

function exactActiveId(state: UiState, tabs: UiTab[], label: string): string {
  const active = typeof state.activeTabId === "string" ? state.activeTabId : "";
  if (!active || !tabs.some((tab) => tab.tabId === active)) throw new Error(`${label} did not bind activeTabId to one exact open tab`);
  return active;
}

async function waitForUiState(connection: Connection, predicate: (state: UiState) => boolean, label: string): Promise<UiState> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await uiState(connection);
    if (predicate(state)) return state;
    await delay(100);
  }
  throw new Error(`${label} did not appear before timeout`);
}

async function uiState(connection: Connection): Promise<UiState> {
  return apiJson<UiState>(connection, "GET", "/state/ui");
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", { debugSurface: "app", source: "final-surface-activity-browser", ...body });
}

async function apiJson<T>(connection: Connection, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers = new Headers({ Authorization: `Bearer ${connection.token}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${connection.base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${(await response.text()).slice(0, 1_200)}`);
  return await response.json() as T;
}

function nodeReadablePath(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) return resolve(path);
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("unable to map the Activity Browser fixture profile path");
  return resolve(result.stdout.trim());
}

function tabSelector(tabId: string): string {
  assertSafeTabId(tabId);
  return `[data-tab-id='${tabId}']`;
}

function ownedCloseSelector(tabId: string): string {
  return `${tabSelector(tabId)} [aria-label='Close session']`;
}

function assertSafeTabId(tabId: string): void {
  if (!/^[A-Za-z0-9._:-]+$/.test(tabId)) throw new Error("renderer tab identity is unsafe for an exact selector");
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
    observedEffect: "No bounded owned Activity Browser lifecycle transition was observed.",
  };
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Activity Browser lifecycle control did not satisfy every required verdict";
  }
  return outcome;
}

async function cleanupAttempt(errors: string[], action: () => Promise<void>): Promise<void> {
  try { await action(); } catch (error) { errors.push(errorText(error)); }
}

function appendError(current: string | undefined, next: string): string {
  return current ? `${current}; ${next}` : next;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
