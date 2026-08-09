import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import { releaseSurfaceProfileLaunchRootFromDebugTokenPath } from "../lib/release-surface-run-profile";
import { ReleaseSurfaceTauriInvokeSession } from "../lib/release-surface-tauri-invoke-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type TaskRow = {
  taskId: string;
  origin: string;
  commandDisplay: string;
  status: string;
  pid: number | null;
  tabId: string | null;
};
type UiState = { activeTabId: string | null; rightTab: string | null };

const REFRESH = "[data-debug-id='surface-components-taskspanel-3']";
const DISCLOSURE = "[data-debug-id='surface-components-taskspanel-8']";
const PAUSE = "[title='Pause (SIGSTOP on Unix, NtSuspendProcess on Windows)']";
const RESUME = "[title='Resume (SIGCONT on Unix, NtResumeProcess on Windows)']";
const KILL = ":is([title='Kill (SIGTERM then SIGKILL after 3s)'],[title='Kill terminal and remove its task row'])";
const CLEAN_HOST_MCP = "[aria-label='Clean Host MCP children for this tab']";
const FILTER = "[data-debug-id='tasks-filter-input']";

const exactSelectors = [REFRESH, DISCLOSURE, PAUSE, RESUME, KILL, CLEAN_HOST_MCP] as const;

export const TASKS_PANEL_LIFECYCLE_FIXTURES = ["ui:tasks-panel-owned-process-lifecycles"] as const;
export const TASKS_PANEL_LIFECYCLE_CLEANUPS = ["ui:kill-owned-processes-and-restore-tasks-view"] as const;
export const TASKS_PANEL_LIFECYCLE_ORACLES = [
  "ui:activation:tasks-panel-manual-refresh-receipt",
  "ui:disclosure-state-transition",
  "ui:activation:tasks-panel-owned-task-paused",
  "ui:activation:tasks-panel-owned-task-resumed",
  "ui:activation:tasks-panel-owned-task-killed",
  "ui:boolean-state-transition",
] as const;

export function supportsTasksPanelLifecycleControl(assignment: Assignment): boolean {
  return assignment.surface.source === "src/components/TasksPanel.tsx"
    && exactSelectors.includes(normalizeSelector(assignment.surface.selector ?? "") as typeof exactSelectors[number]);
}

export async function exerciseTasksPanelLifecycle(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  relay: ReleaseSurfaceTauriInvokeSession,
  assignments: Assignment[],
  request: Pick<ReleaseSurfaceDriverRequest, "platform" | "runtime">,
): Promise<ReleaseSurfaceDriverOutcome[]> {
  validateAssignments(assignments);
  const outcomes = new Map(assignments.map((assignment) => [
    normalizeSelector(assignment.surface.selector!),
    emptyOutcome(assignment),
  ]));
  const outcome = (selector: string): ReleaseSurfaceDriverOutcome => {
    const value = outcomes.get(selector);
    if (!value) throw new Error(`TasksPanel outcome is missing ${selector}`);
    return value;
  };
  const markPresent = (selector: string): void => { outcome(selector).present = "pass"; };
  const markInvoke = (selector: string): void => { outcome(selector).invoke = "pass"; };
  const markEffect = (selector: string, detail: string): void => {
    outcome(selector).effect = "pass";
    outcome(selector).observedEffect = detail;
  };

  let baselineUi: UiState | null = null;
  let baselineFilter = "";
  let baselineTasks: TaskRow[] = [];
  let terminalId: string | null = null;
  let taskId: string | null = null;
  let hostMcpTaskId: string | null = null;
  let hostMcpPrepared = false;
  let primaryError: string | null = null;

  try {
    baselineUi = await readUiState(connection);
    if (!baselineUi.activeTabId) throw new Error("TasksPanel fixture requires one exact active tab");
    if (!baselineUi.rightTab) throw new Error("TasksPanel fixture requires one exact right-rail tab baseline");
    attributeValue(baselineUi.activeTabId);
    baselineTasks = await listTasks(relay);
    await setRightTab(connection, installedInput, "Tasks");

    baselineFilter = await readFilter(installedInput);
    if (baselineFilter) await replaceFilter(installedInput, "");
    const baselineRefreshSequence = await readManualRefreshSequence(installedInput);
    if (baselineRefreshSequence !== 0) {
      throw new Error("isolated TasksPanel fixture did not start with a zero manual-refresh receipt");
    }

    const profileRoot = releaseSurfaceProfileLaunchRootFromDebugTokenPath(
      request.runtime.debugTokenPath,
      request.platform,
    );
    const created = await relay.invoke("pty_create", {
      tabId: baselineUi.activeTabId,
      shell: request.platform === "windows-installed" ? "cmd.exe" : "/bin/sh",
      cwd: profileRoot,
      cols: 80,
      rows: 24,
    });
    if (typeof created !== "string" || !created) {
      throw new Error("owned TasksPanel PTY returned an invalid terminal identity");
    }
    terminalId = created;
    taskId = `${baselineUi.activeTabId}:${terminalId}`;
    if (!/^[A-Za-z0-9._:-]+$/.test(terminalId)) {
      throw new Error("owned TasksPanel PTY returned a non-selector-safe terminal identity");
    }
    attributeValue(taskId);
    await waitForTaskStatus(relay, taskId, "running", "owned PTY creation");

    const row = taskSelector(taskId);
    const refreshControl = await waitForReleaseSurfaceInstalledInputElement(installedInput, REFRESH);
    markPresent(REFRESH);
    await clickReleaseSurfaceInstalledInputElement(installedInput, refreshControl);
    markInvoke(REFRESH);
    await waitForManualRefreshSequence(installedInput, 1);
    await waitForReleaseSurfaceInstalledInputElement(installedInput, row);
    markEffect(
      REFRESH,
      `The native refresh click completed manual receipt 1 and retained exact owned task ${taskId}.`,
    );

    const disclosureSelector = `${row} ${DISCLOSURE}`;
    const disclosure = await waitForReleaseSurfaceInstalledInputElement(installedInput, disclosureSelector);
    const collapsed = await observeReleaseSurfaceInstalledInputElement(installedInput, disclosureSelector, ["expanded"]);
    if (collapsed.expanded !== false) throw new Error("owned task disclosure did not start collapsed");
    markPresent(DISCLOSURE);
    await clickReleaseSurfaceInstalledInputElement(installedInput, disclosure);
    markInvoke(DISCLOSURE);
    await waitForExpanded(installedInput, disclosureSelector, true);
    markEffect(DISCLOSURE, `The exact owned task row ${taskId} expanded without changing task state.`);

    const pauseSelector = `${row} ${PAUSE}`;
    const pause = await waitForReleaseSurfaceInstalledInputElement(installedInput, pauseSelector);
    markPresent(PAUSE);
    await clickReleaseSurfaceInstalledInputElement(installedInput, pause);
    markInvoke(PAUSE);
    await waitForTaskStatus(relay, taskId, "stopped", "owned task pause");
    markEffect(PAUSE, `The native Pause control changed only owned task ${taskId} from running to stopped.`);

    await replaceFilter(installedInput, "stopped");
    const resumeSelector = `${row} ${RESUME}`;
    const resume = await waitForReleaseSurfaceInstalledInputElement(installedInput, resumeSelector);
    markPresent(RESUME);
    await clickReleaseSurfaceInstalledInputElement(installedInput, resume);
    markInvoke(RESUME);
    await waitForTaskStatus(relay, taskId, "running", "owned task resume");
    markEffect(RESUME, `The native Resume control restored only owned task ${taskId} from stopped to running.`);

    await replaceFilter(installedInput, "");
    await waitForReleaseSurfaceInstalledInputElement(installedInput, row);
    const expanded = await observeReleaseSurfaceInstalledInputElement(installedInput, disclosureSelector, ["expanded"]);
    if (expanded.expanded === true) {
      const toggle = await waitForReleaseSurfaceInstalledInputElement(installedInput, disclosureSelector);
      await clickReleaseSurfaceInstalledInputElement(installedInput, toggle);
      await waitForExpanded(installedInput, disclosureSelector, false);
    }

    const killSelector = `${row} ${KILL}`;
    const kill = await waitForReleaseSurfaceInstalledInputElement(installedInput, killSelector);
    markPresent(KILL);
    await clickReleaseSurfaceInstalledInputElement(installedInput, kill);
    markInvoke(KILL);
    await waitForTaskAbsent(relay, taskId);
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, row);
    terminalId = null;
    markEffect(KILL, `The native Kill control terminated and removed only release-owned task ${taskId}.`);

    const beforeHostMcp = await listTasks(relay);
    if (beforeHostMcp.some((task) => task.origin === "host_mcp"
      && task.tabId === baselineUi!.activeTabId
      && (task.status === "running" || task.status === "stopped"))) {
      throw new Error("isolated TasksPanel fixture found a pre-existing live Host MCP child for the active tab");
    }
    await apiJson(connection, "POST", "/state/ui", {
      releaseTestHostMcpChild: "spawn-owned",
      source: "final-surface-tasks-panel-host-mcp",
    });
    hostMcpPrepared = true;
    const hostMcpTask = await waitForOwnedHostMcpTask(relay, beforeHostMcp, baselineUi.activeTabId);
    hostMcpTaskId = hostMcpTask.taskId;
    const clean = await waitForReleaseSurfaceInstalledInputElement(installedInput, CLEAN_HOST_MCP);
    const initialCleanState = await observeReleaseSurfaceInstalledInputElement(
      installedInput,
      CLEAN_HOST_MCP,
      ["pressed", "title"],
    );
    if (initialCleanState.pressed !== false
      || initialCleanState.title !== "Clean 1 Host MCP child process for this tab") {
      throw new Error("Host MCP cleanup control did not expose its exact unarmed single-child state");
    }
    markPresent(CLEAN_HOST_MCP);
    await clickReleaseSurfaceInstalledInputElement(installedInput, clean);
    await waitForHostMcpCleanupArmed(installedInput);
    if ((await findTask(relay, hostMcpTaskId))?.status !== "running") {
      throw new Error("arming Host MCP cleanup changed the release-owned process before confirmation");
    }
    const armed = await waitForReleaseSurfaceInstalledInputElement(installedInput, CLEAN_HOST_MCP);
    await clickReleaseSurfaceInstalledInputElement(installedInput, armed);
    markInvoke(CLEAN_HOST_MCP);
    await waitForTaskStatus(relay, hostMcpTaskId, "killed", "owned Host MCP cleanup");
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, CLEAN_HOST_MCP);
    markEffect(
      CLEAN_HOST_MCP,
      `Two native clicks armed and then process-tree-cleaned only release-owned Host MCP task ${hostMcpTaskId}.`,
    );
  } catch (error) {
    primaryError = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (taskId && terminalId && baselineUi?.activeTabId) {
      try {
        const current = await findTask(relay, taskId);
        if (current?.status === "stopped") {
          await relay.invoke("task_resume", { taskId });
          await waitForTaskStatus(relay, taskId, "running", "owned task cleanup resume");
        }
        await relay.invoke("pty_kill", { tabId: baselineUi.activeTabId, terminalId });
        await waitForTaskAbsent(relay, taskId);
      } catch (error) {
        cleanupErrors.push(`owned PTY: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (baselineUi?.activeTabId && hostMcpPrepared) {
      try {
        await apiJson(connection, "POST", "/state/ui", {
          releaseTestHostMcpChild: "clear-owned",
          source: "final-surface-tasks-panel-host-mcp-cleanup",
        });
        if (hostMcpTaskId) await waitForTaskAbsent(relay, hostMcpTaskId);
      } catch (error) {
        cleanupErrors.push(`owned Host MCP child: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await relay.cleanup();
    } catch (error) {
      cleanupErrors.push(`invoke relay: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (baselineUi) {
      try {
        if (baselineUi.rightTab === "Tasks") {
          await setRightTab(connection, installedInput, "Tooling");
          await setRightTab(connection, installedInput, "Tasks");
          if (baselineFilter) await replaceFilter(installedInput, baselineFilter);
          if (await readManualRefreshSequence(installedInput) !== 0) {
            throw new Error("TasksPanel manual-refresh receipt did not reset on exact remount");
          }
        } else if (baselineUi.rightTab) {
          await setRightTab(connection, installedInput, baselineUi.rightTab);
        }
        const restoredUi = await readUiState(connection);
        if (restoredUi.rightTab !== baselineUi.rightTab || restoredUi.activeTabId !== baselineUi.activeTabId) {
          throw new Error("TasksPanel cleanup did not restore the exact active tab and right-rail tab");
        }
      } catch (error) {
        cleanupErrors.push(`view baseline: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const restoredTasks = await listTasks(relay);
        assertBaselineTasksPreserved(baselineTasks, restoredTasks);
        if (taskId && restoredTasks.some((task) => task.taskId === taskId)) {
          throw new Error("owned TasksPanel PTY remained in the task registry");
        }
        if (hostMcpTaskId && restoredTasks.some((task) => task.taskId === hostMcpTaskId)) {
          throw new Error("owned Host MCP task remained in the task registry");
        }
      } catch (error) {
        cleanupErrors.push(`task baseline: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const cleanupError = cleanupErrors.join("; ");
    for (const value of outcomes.values()) {
      if (!cleanupError) value.cleanup = "pass";
      if (primaryError && !value.error) value.error = primaryError;
      if (cleanupError) value.error = appendError(value.error, `cleanup: ${cleanupError}`);
      if ([value.present, value.invoke, value.effect, value.cleanup].includes("fail") && !value.error) {
        value.error = "TasksPanel lifecycle did not satisfy every required verdict";
      }
    }
  }
  return assignments.map((assignment) => outcome(normalizeSelector(assignment.surface.selector!)));
}

function validateAssignments(assignments: Assignment[]): void {
  if (assignments.length !== exactSelectors.length) {
    throw new Error(`TasksPanel lifecycle requires exactly ${exactSelectors.length} assignments`);
  }
  const selectors = new Set(assignments.map((assignment) => normalizeSelector(assignment.surface.selector ?? "")));
  for (const assignment of assignments) {
    if (!supportsTasksPanelLifecycleControl(assignment)
      || assignment.fixtureId !== TASKS_PANEL_LIFECYCLE_FIXTURES[0]
      || assignment.cleanupId !== TASKS_PANEL_LIFECYCLE_CLEANUPS[0]) {
      throw new Error(`TasksPanel lifecycle assignment does not match ${assignment.surface.name}`);
    }
  }
  for (const selector of exactSelectors) {
    if (!selectors.has(selector)) throw new Error(`TasksPanel lifecycle is missing ${selector}`);
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
    observedEffect: "No native TasksPanel owned-task lifecycle effect was observed.",
  };
}

async function listTasks(relay: ReleaseSurfaceTauriInvokeSession): Promise<TaskRow[]> {
  const value = await relay.invoke("list_background_tasks", {});
  if (!Array.isArray(value)) throw new Error("list_background_tasks returned a non-array result");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("list_background_tasks returned a non-object row");
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.taskId !== "string" || !row.taskId || typeof row.status !== "string") {
      throw new Error("list_background_tasks omitted a bounded task identity or status");
    }
    if (row.pid !== null && row.pid !== undefined && !Number.isSafeInteger(row.pid)) {
      throw new Error("list_background_tasks returned an invalid pid");
    }
    if (row.tabId !== null && row.tabId !== undefined && typeof row.tabId !== "string") {
      throw new Error("list_background_tasks returned an invalid tab identity");
    }
    if (typeof row.origin !== "string" || typeof row.commandDisplay !== "string") {
      throw new Error("list_background_tasks omitted task origin or command display");
    }
    return {
      taskId: row.taskId,
      origin: row.origin,
      commandDisplay: row.commandDisplay,
      status: row.status,
      pid: Number.isSafeInteger(row.pid) ? Number(row.pid) : null,
      tabId: typeof row.tabId === "string" ? row.tabId : null,
    };
  });
}

async function waitForOwnedHostMcpTask(
  relay: ReleaseSurfaceTauriInvokeSession,
  before: TaskRow[],
  tabId: string,
): Promise<TaskRow> {
  const baselineIds = new Set(before.map((task) => task.taskId));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const matches = (await listTasks(relay)).filter((task) => !baselineIds.has(task.taskId)
      && task.origin === "host_mcp"
      && task.commandDisplay === "ShellX release-owned Host MCP child"
      && task.tabId === tabId
      && task.status === "running"
      && task.pid !== null);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error("Host MCP setup produced more than one release-owned child");
    await delay(100);
  }
  throw new Error("Host MCP setup did not expose one exact release-owned running child");
}

async function waitForHostMcpCleanupArmed(
  installedInput: ReleaseSurfaceInstalledInputSession,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await observeReleaseSurfaceInstalledInputElement(
      installedInput,
      CLEAN_HOST_MCP,
      ["pressed", "title"],
    );
    if (value.pressed === true
      && value.title === "Click again to clean 1 Host MCP child process for this tab") return;
    await delay(50);
  }
  throw new Error("Host MCP cleanup control did not reach its exact armed state");
}

async function findTask(relay: ReleaseSurfaceTauriInvokeSession, taskId: string): Promise<TaskRow | null> {
  return (await listTasks(relay)).find((task) => task.taskId === taskId) ?? null;
}

async function waitForTaskStatus(
  relay: ReleaseSurfaceTauriInvokeSession,
  taskId: string,
  status: string,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await findTask(relay, taskId))?.status === status) return;
    await delay(100);
  }
  throw new Error(`${label} did not reach exact status ${status}`);
}

async function waitForTaskAbsent(relay: ReleaseSurfaceTauriInvokeSession, taskId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!await findTask(relay, taskId)) return;
    await delay(100);
  }
  throw new Error(`owned task ${taskId} remained after exact PTY cleanup`);
}

function assertBaselineTasksPreserved(before: TaskRow[], after: TaskRow[]): void {
  for (const baseline of before) {
    const current = after.find((task) => task.taskId === baseline.taskId);
    if (!current
      || current.origin !== baseline.origin
      || current.commandDisplay !== baseline.commandDisplay
      || current.status !== baseline.status
      || current.pid !== baseline.pid
      || current.tabId !== baseline.tabId) {
      throw new Error(`baseline task ${baseline.taskId} changed during the owned TasksPanel lifecycle`);
    }
  }
}

async function readUiState(connection: Connection): Promise<UiState> {
  const value = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
  return {
    activeTabId: typeof value.activeTabId === "string" ? value.activeTabId : null,
    rightTab: typeof value.rightTab === "string" ? value.rightTab : null,
  };
}

async function setRightTab(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  tab: string,
): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    rightTab: tab,
    source: "final-surface-tasks-panel-lifecycle",
  });
  if (tab === "Tasks") await waitForReleaseSurfaceInstalledInputElement(installedInput, FILTER);
  else await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, FILTER);
  const state = await readUiState(connection);
  if (state.rightTab !== tab) throw new Error(`right rail did not select exact tab ${tab}`);
}

async function readFilter(installedInput: ReleaseSurfaceInstalledInputSession): Promise<string> {
  const value = await observeReleaseSurfaceInstalledInputElement(installedInput, FILTER, ["value"]);
  if (typeof value.value !== "string") throw new Error("TasksPanel filter omitted its bounded value");
  return value.value;
}

async function replaceFilter(installedInput: ReleaseSurfaceInstalledInputSession, value: string): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, FILTER);
  await clearReleaseSurfaceInstalledInputElement(installedInput, control);
  if (value) await setReleaseSurfaceInstalledInputElementValue(installedInput, control, value);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readFilter(installedInput) === value) return;
    await delay(50);
  }
  throw new Error(`TasksPanel filter did not reach ${JSON.stringify(value)}`);
}

async function readManualRefreshSequence(installedInput: ReleaseSurfaceInstalledInputSession): Promise<number> {
  const value = await observeReleaseSurfaceInstalledInputElement(installedInput, REFRESH, ["title"]);
  if (typeof value.title !== "string") throw new Error("TasksPanel refresh omitted its bounded title receipt");
  const match = value.title.match(/— (\d+) manual refresh(?:es)? completed in this view$/);
  if (!match) throw new Error("TasksPanel refresh title did not expose its bounded manual sequence");
  return Number(match[1]);
}

async function waitForManualRefreshSequence(
  installedInput: ReleaseSurfaceInstalledInputSession,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readManualRefreshSequence(installedInput) === expected) return;
    await delay(50);
  }
  throw new Error(`TasksPanel manual refresh did not reach exact sequence ${expected}`);
}

async function waitForExpanded(
  installedInput: ReleaseSurfaceInstalledInputSession,
  selector: string,
  expected: boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["expanded"]);
    if (value.expanded === expected) return;
    await delay(50);
  }
  throw new Error(`owned TasksPanel disclosure did not reach expanded=${expected}`);
}

function taskSelector(taskId: string): string {
  return `[data-task-id='${attributeValue(taskId)}']`;
}

function attributeValue(value: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error("TasksPanel task identity is not selector-safe");
  return value;
}

function normalizeSelector(value: string): string {
  return value.replaceAll('"', "'");
}

function appendError(current: string | undefined, detail: string): string {
  return current ? `${current}; ${detail}` : detail;
}

async function apiJson<T>(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 800)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
