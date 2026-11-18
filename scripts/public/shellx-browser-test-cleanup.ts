import {
  optionalArrayProperty,
  optionalStringProperty,
  requireJsonObject,
  requireStringProperty,
} from "./runtime-json";

type JsonObject = Record<string, unknown>;

export type BrowserLifecycleRequest = (
  method: "GET" | "POST",
  path: string,
  body?: JsonObject,
) => Promise<unknown>;

interface BrowserLifecycleTask {
  taskId: string;
  status: string;
}

interface BrowserLifecycleTabLock {
  leaseId?: string | null;
  ownerAgentId?: string | null;
  ownerRunId?: string | null;
}

interface BrowserLifecycleTab {
  browserTabId: string;
  taskId?: string | null;
  lock?: BrowserLifecycleTabLock | null;
}

interface BrowserLifecycleEngine {
  engineId: string;
}

interface BrowserLifecycleState {
  tasks?: BrowserLifecycleTask[];
  tabs?: BrowserLifecycleTab[];
  engines?: BrowserLifecycleEngine[];
  activeTaskId?: string | null;
}

export interface BrowserLifecycleCleanupOptions {
  taskIds?: Iterable<string>;
  tabIds?: Iterable<string>;
  engineIds?: Iterable<string>;
  label: string;
  timeoutMs?: number;
}

export interface BrowserLifecycleCleanupResult {
  tasksTracked: number;
  tabsTracked: number;
  enginesTracked: number;
  tasksAborted: number;
  tabsUnlocked: number;
  tabsClosed: number;
  errors: string[];
}

const TERMINAL_TASK_STATUSES = new Set(["completed", "blocked", "aborted"]);

function normalizeIds(values: Iterable<string> | undefined): Set<string> {
  return new Set(
    [...(values ?? [])]
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownedTabs(
  state: BrowserLifecycleState,
  taskIds: Set<string>,
  tabIds: Set<string>,
): BrowserLifecycleTab[] {
  return (state.tabs ?? []).filter((tab) =>
    tabIds.has(tab.browserTabId) || Boolean(tab.taskId && taskIds.has(tab.taskId))
  );
}

function activeOwnedTasks(
  state: BrowserLifecycleState,
  taskIds: Set<string>,
): BrowserLifecycleTask[] {
  return (state.tasks ?? []).filter((task) =>
    taskIds.has(task.taskId) && !TERMINAL_TASK_STATUSES.has(task.status)
  );
}

async function readLifecycleState(request: BrowserLifecycleRequest): Promise<BrowserLifecycleState> {
  const value = await request("GET", "/browser/state");
  const stateValue = requireJsonObject(value, "Browser lifecycle state");
  const tasks = (optionalArrayProperty(value, "tasks", "Browser lifecycle state") ?? []).map((task, index) => ({
    taskId: requireStringProperty(task, "taskId", `Browser lifecycle state.tasks[${index}]`),
    status: requireStringProperty(task, "status", `Browser lifecycle state.tasks[${index}]`),
  }));
  const tabs = (optionalArrayProperty(value, "tabs", "Browser lifecycle state") ?? []).map((tab, index) => {
    const label = `Browser lifecycle state.tabs[${index}]`;
    const lockValue = Reflect.get(requireJsonObject(tab, label), "lock");
    let lock: BrowserLifecycleTabLock | null = null;
    if (lockValue !== undefined && lockValue !== null) {
      requireJsonObject(lockValue, `${label}.lock`);
      lock = {
        leaseId: optionalStringProperty(lockValue, "leaseId", `${label}.lock`),
        ownerAgentId: optionalStringProperty(lockValue, "ownerAgentId", `${label}.lock`),
        ownerRunId: optionalStringProperty(lockValue, "ownerRunId", `${label}.lock`),
      };
    }
    return {
      browserTabId: requireStringProperty(tab, "browserTabId", label),
      taskId: optionalStringProperty(tab, "taskId", label),
      lock,
    };
  });
  const enginePoolValue = Reflect.get(stateValue, "enginePool");
  let engines: BrowserLifecycleEngine[] = [];
  if (enginePoolValue !== undefined && enginePoolValue !== null) {
    requireJsonObject(enginePoolValue, "Browser lifecycle state.enginePool");
    engines = (optionalArrayProperty(enginePoolValue, "engines", "Browser lifecycle state.enginePool") ?? [])
      .map((engine, index) => ({
        engineId: requireStringProperty(engine, "engineId", `Browser lifecycle state.enginePool.engines[${index}]`),
      }));
  }
  return {
    tasks,
    tabs,
    engines,
    activeTaskId: optionalStringProperty(value, "activeTaskId", "Browser lifecycle state"),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function cleanupOwnedBrowserLifecycle(
  request: BrowserLifecycleRequest,
  options: BrowserLifecycleCleanupOptions,
): Promise<BrowserLifecycleCleanupResult> {
  const taskIds = normalizeIds(options.taskIds);
  const tabIds = normalizeIds(options.tabIds);
  const engineIds = normalizeIds(options.engineIds);
  const result: BrowserLifecycleCleanupResult = {
    tasksTracked: taskIds.size,
    tabsTracked: tabIds.size,
    enginesTracked: engineIds.size,
    tasksAborted: 0,
    tabsUnlocked: 0,
    tabsClosed: 0,
    errors: [],
  };
  if (taskIds.size === 0 && tabIds.size === 0 && engineIds.size === 0) return result;

  let state = await readLifecycleState(request);
  for (const tab of ownedTabs(state, taskIds, tabIds)) {
    if (!tab.lock) continue;
    try {
      await request("POST", "/browser/tabs/unlock", {
        browserTabId: tab.browserTabId,
        leaseId: tab.lock.leaseId ?? undefined,
        ownerAgentId: tab.lock.ownerAgentId ?? undefined,
        ownerRunId: tab.lock.ownerRunId ?? undefined,
      });
      result.tabsUnlocked += 1;
    } catch (error) {
      result.errors.push(`unlock ${tab.browserTabId}: ${errorMessage(error)}`);
    }
  }

  for (const task of activeOwnedTasks(state, taskIds)) {
    try {
      await request("POST", "/browser/task/finish", {
        taskId: task.taskId,
        status: "aborted",
        reason: "testHarnessCleanup",
        requestedBy: options.label,
      });
      result.tasksAborted += 1;
    } catch (error) {
      result.errors.push(`abort ${task.taskId}: ${errorMessage(error)}`);
    }
  }

  state = await readLifecycleState(request);
  for (const tab of ownedTabs(state, taskIds, tabIds)) {
    try {
      await request("POST", "/browser/tabs/close", {
        browserTabId: tab.browserTabId,
        lockLeaseId: tab.lock?.leaseId ?? undefined,
        ownerAgentId: tab.lock?.ownerAgentId ?? undefined,
        ownerRunId: tab.lock?.ownerRunId ?? undefined,
      });
      result.tabsClosed += 1;
    } catch (error) {
      result.errors.push(`close ${tab.browserTabId}: ${errorMessage(error)}`);
    }
  }

  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    state = await readLifecycleState(request);
    const remainingTabs = ownedTabs(state, taskIds, tabIds);
    const remainingActiveTasks = activeOwnedTasks(state, taskIds);
    const remainingEngines = (state.engines ?? []).filter((engine) => engineIds.has(engine.engineId));
    const staleActiveTask = Boolean(state.activeTaskId && taskIds.has(state.activeTaskId));
    if (remainingTabs.length === 0 && remainingActiveTasks.length === 0
      && remainingEngines.length === 0 && !staleActiveTask) {
      return result;
    }
    await sleep(100);
  }

  state = await readLifecycleState(request);
  const remainingTabIds = ownedTabs(state, taskIds, tabIds).map((tab) => tab.browserTabId);
  const remainingTaskIds = activeOwnedTasks(state, taskIds).map((task) => task.taskId);
  const remainingEngineIds = (state.engines ?? [])
    .filter((engine) => engineIds.has(engine.engineId))
    .map((engine) => engine.engineId);
  throw new Error(
    `${options.label} Browser cleanup left owned state: tasks=${remainingTaskIds.join(",") || "none"} tabs=${remainingTabIds.join(",") || "none"} engines=${remainingEngineIds.join(",") || "none"}`
      + (result.errors.length ? `; cleanup errors=${result.errors.join(" | ")}` : ""),
  );
}
