import {
  cleanupOwnedBrowserLifecycle,
  type BrowserLifecycleRequest,
} from "./shellx-browser-test-cleanup";

interface FakeTask {
  taskId: string;
  status: string;
}

interface FakeTab {
  browserTabId: string;
  taskId?: string | null;
  lock?: {
    leaseId: string;
    ownerAgentId: string;
    ownerRunId: string;
  } | null;
}

interface FakeState {
  tasks: FakeTask[];
  tabs: FakeTab[];
  enginePool?: { engines: Array<{ engineId: string }> };
  activeTaskId?: string | null;
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

function fakeRequest(
  state: FakeState,
  options: { failFirstAbort?: boolean } = {},
): BrowserLifecycleRequest {
  let abortAttempts = 0;
  return async (method, path, body = {}) => {
    if (method === "GET" && path === "/browser/state") {
      return structuredClone(state);
    }
    if (method === "POST" && path === "/browser/tabs/unlock") {
      const tab = state.tabs.find((item) => item.browserTabId === body.browserTabId);
      if (!tab) throw new Error("unknown fake tab");
      tab.lock = null;
      return { ok: true };
    }
    if (method === "POST" && path === "/browser/task/finish") {
      abortAttempts += 1;
      if (options.failFirstAbort && abortAttempts === 1) {
        throw new Error("synthetic abort race");
      }
      const task = state.tasks.find((item) => item.taskId === body.taskId);
      if (!task) throw new Error("unknown fake task");
      task.status = "aborted";
      if (state.activeTaskId === task.taskId) state.activeTaskId = null;
      return { ...task };
    }
    if (method === "POST" && path === "/browser/tabs/close") {
      const index = state.tabs.findIndex((item) => item.browserTabId === body.browserTabId);
      if (index < 0) throw new Error("unknown fake tab");
      const [tab] = state.tabs.splice(index, 1);
      if (tab?.taskId) {
        const hasOwnedTab = state.tabs.some((item) => item.taskId === tab.taskId);
        const task = state.tasks.find((item) => item.taskId === tab.taskId);
        if (!hasOwnedTab && task && task.status === "running") task.status = "aborted";
        if (state.activeTaskId === tab.taskId) state.activeTaskId = null;
      }
      if (state.enginePool) {
        state.enginePool.engines = state.enginePool.engines.filter((engine) => engine.engineId !== `${tab?.browserTabId}-engine`);
      }
      return { ok: true };
    }
    throw new Error(`unexpected fake request ${method} ${path}`);
  };
}

async function main(): Promise<void> {
  console.log("\n=== ShellX Browser test cleanup ===");

  const isolated: FakeState = {
    tasks: [
      { taskId: "owned-task", status: "running" },
      { taskId: "operator-task", status: "running" },
    ],
    tabs: [
      {
        browserTabId: "owned-tab",
        taskId: "owned-task",
        lock: {
          leaseId: "owned-lease",
          ownerAgentId: "owned-agent",
          ownerRunId: "owned-run",
        },
      },
      { browserTabId: "operator-tab", taskId: "operator-task", lock: null },
    ],
    enginePool: { engines: [{ engineId: "owned-tab-engine" }, { engineId: "operator-tab-engine" }] },
    activeTaskId: "owned-task",
  };
  const isolatedResult = await cleanupOwnedBrowserLifecycle(
    fakeRequest(isolated),
    { taskIds: ["owned-task"], tabIds: ["owned-tab"], engineIds: ["owned-tab-engine"], label: "cleanup-unit" },
  );
  assert(isolatedResult.tasksAborted === 1, "cleanup aborts the tracked running task");
  assert(isolatedResult.tabsUnlocked === 1, "cleanup unlocks the tracked tab");
  assert(isolatedResult.tabsClosed === 1, "cleanup closes the tracked tab");
  assert(isolatedResult.enginesTracked === 1, "cleanup tracks the exact owned Browser engine");
  assert(isolated.tasks.find((task) => task.taskId === "owned-task")?.status === "aborted", "tracked task is terminal");
  assert(isolated.tabs.some((tab) => tab.browserTabId === "operator-tab"), "cleanup preserves an unrelated operator tab");
  assert(isolated.tasks.find((task) => task.taskId === "operator-task")?.status === "running", "cleanup preserves an unrelated operator task");
  assert(isolated.enginePool?.engines.some((engine) => engine.engineId === "operator-tab-engine"), "cleanup preserves an unrelated operator engine");

  const partial: FakeState = {
    tasks: [{ taskId: "partial-task", status: "running" }],
    tabs: [{ browserTabId: "partial-tab", taskId: "partial-task", lock: null }],
    enginePool: { engines: [{ engineId: "partial-tab-engine" }] },
    activeTaskId: "partial-task",
  };
  const partialResult = await cleanupOwnedBrowserLifecycle(
    fakeRequest(partial, { failFirstAbort: true }),
    { taskIds: ["partial-task"], engineIds: ["partial-tab-engine"], label: "cleanup-partial-unit", timeoutMs: 500 },
  );
  assert(partialResult.errors.some((error) => error.includes("synthetic abort race")), "cleanup reports a failed abort attempt");
  assert(partial.tasks[0]?.status === "aborted" && partial.tabs.length === 0, "final-tab close still makes partial cleanup idempotent");

  const noOpResult = await cleanupOwnedBrowserLifecycle(
    async () => ({}),
    { label: "cleanup-empty-unit" },
  );
  assert(noOpResult.tasksTracked === 0 && noOpResult.tabsTracked === 0 && noOpResult.enginesTracked === 0, "empty cleanup is a no-op");

  let malformedStateRejected = false;
  try {
    await cleanupOwnedBrowserLifecycle(
      async () => ({ tasks: "not-an-array" }),
      { taskIds: ["owned-task"], label: "cleanup-malformed-unit" },
    );
  } catch (error) {
    malformedStateRejected = error instanceof Error && /tasks must be an array/.test(error.message);
  }
  assert(malformedStateRejected, "cleanup rejects malformed Browser lifecycle state");

  console.log("ShellX Browser cleanup checks passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
