import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { resolveShellxDebugApiConnection } from "./shellx-debug-paths";
import {
  optionalArrayProperty,
  optionalStringProperty,
  readJsonProperty,
  requireJsonObject,
} from "./runtime-json";

export const INSTALLED_STATE_SCHEMA = "shellx.installed-browser-state.v1";

const TERMINAL_TASK_STATUSES = new Set(["completed", "blocked", "aborted"]);

type BrowserState = {
  tabs?: Array<{ browserTabId?: string; lock?: unknown }>;
  tasks?: Array<{ taskId?: string; status?: string }>;
  activeTaskId?: string | null;
  activeBrowserTabId?: string | null;
  enginePool?: {
    engines?: Array<{
      mounted?: boolean;
      browserTabId?: string | null;
      taskId?: string | null;
      waitlist?: { active?: unknown; waiting?: unknown[] };
    }>;
    waiting?: unknown[];
    parkedTabs?: string[];
  };
  engineWaitlist?: { active?: unknown; waiting?: unknown[] };
  sessionGrants?: Array<{ status?: string }>;
  dialogs?: Array<{ status?: string }>;
  permissions?: Array<{ status?: string }>;
};

export type InstalledBrowserLifecycleCounts = {
  tabs: number;
  lockedTabs: number;
  activeTasks: number;
  busyEngines: number;
  waitingEngineActions: number;
  parkedTabs: number;
  pendingSessionGrants: number;
  pendingDialogs: number;
  pendingPermissions: number;
  activeTaskSelected: number;
  activeTabSelected: number;
};

export type InstalledBrowserStateProbe = {
  schemaVersion: typeof INSTALLED_STATE_SCHEMA;
  capturedAt: string;
  base: string;
  counts: InstalledBrowserLifecycleCounts;
  healthy: boolean;
  issues: string[];
};

function parseStatusRows(value: unknown, key: string, label: string): Array<{ status?: string }> | undefined {
  return optionalArrayProperty(value, key, label)?.map((row, index) => ({
    status: optionalStringProperty(row, "status", `${label}.${key}[${index}]`),
  }));
}

export function parseInstalledBrowserState(value: unknown): BrowserState {
  const label = "Installed Browser state";
  requireJsonObject(value, label);
  const tabs = optionalArrayProperty(value, "tabs", label)?.map((tab, index) => {
    const rowLabel = `${label}.tabs[${index}]`;
    return {
      browserTabId: optionalStringProperty(tab, "browserTabId", rowLabel),
      lock: readJsonProperty(tab, "lock", rowLabel),
    };
  });
  const tasks = optionalArrayProperty(value, "tasks", label)?.map((task, index) => {
    const rowLabel = `${label}.tasks[${index}]`;
    return {
      taskId: optionalStringProperty(task, "taskId", rowLabel),
      status: optionalStringProperty(task, "status", rowLabel),
    };
  });
  const poolValue = readJsonProperty(value, "enginePool", label);
  let enginePool: BrowserState["enginePool"];
  if (poolValue !== undefined && poolValue !== null) {
    requireJsonObject(poolValue, `${label}.enginePool`);
    const engines = optionalArrayProperty(poolValue, "engines", `${label}.enginePool`)?.map((engine, index) => {
      const engineLabel = `${label}.enginePool.engines[${index}]`;
      const waitlistValue = readJsonProperty(engine, "waitlist", engineLabel);
      let waitlist: { active?: unknown; waiting?: unknown[] } | undefined;
      if (waitlistValue !== undefined && waitlistValue !== null) {
        requireJsonObject(waitlistValue, `${engineLabel}.waitlist`);
        waitlist = {
          active: readJsonProperty(waitlistValue, "active", `${engineLabel}.waitlist`),
          waiting: optionalArrayProperty(waitlistValue, "waiting", `${engineLabel}.waitlist`),
        };
      }
      return {
        mounted: readJsonProperty(engine, "mounted", engineLabel) === true,
        browserTabId: optionalStringProperty(engine, "browserTabId", engineLabel),
        taskId: optionalStringProperty(engine, "taskId", engineLabel),
        waitlist,
      };
    });
    const parkedTabs = optionalArrayProperty(poolValue, "parkedTabs", `${label}.enginePool`)?.map((tabId, index) => {
      if (typeof tabId !== "string") throw new Error(`${label}.enginePool.parkedTabs[${index}] must be a string`);
      return tabId;
    });
    enginePool = {
      engines,
      waiting: optionalArrayProperty(poolValue, "waiting", `${label}.enginePool`),
      parkedTabs,
    };
  }
  return {
    tabs,
    tasks,
    activeTaskId: optionalStringProperty(value, "activeTaskId", label),
    activeBrowserTabId: optionalStringProperty(value, "activeBrowserTabId", label),
    enginePool,
    sessionGrants: parseStatusRows(value, "sessionGrants", label),
    dialogs: parseStatusRows(value, "dialogs", label),
    permissions: parseStatusRows(value, "permissions", label),
  };
}

export function summarizeInstalledBrowserState(state: BrowserState, base: string): InstalledBrowserStateProbe {
  const engines = state.enginePool?.engines ?? [];
  const waitingEngineActions = (state.enginePool?.waiting?.length ?? 0)
    + engines.filter((engine) => Boolean(engine.waitlist?.active)).length;
  const counts: InstalledBrowserLifecycleCounts = {
    tabs: state.tabs?.length ?? 0,
    lockedTabs: state.tabs?.filter((tab) => Boolean(tab.lock)).length ?? 0,
    activeTasks: state.tasks?.filter((task) => !TERMINAL_TASK_STATUSES.has(task.status ?? "")).length ?? 0,
    busyEngines: engines.filter((engine) => Boolean(engine.browserTabId || engine.taskId)).length,
    waitingEngineActions,
    parkedTabs: state.enginePool?.parkedTabs?.length ?? 0,
    pendingSessionGrants: state.sessionGrants?.filter((grant) => grant.status === "requested").length ?? 0,
    pendingDialogs: state.dialogs?.filter((dialog) => dialog.status === "pending").length ?? 0,
    pendingPermissions: state.permissions?.filter((permission) => permission.status === "pending").length ?? 0,
    activeTaskSelected: state.activeTaskId ? 1 : 0,
    activeTabSelected: state.activeBrowserTabId ? 1 : 0,
  };
  const issues = Object.entries(counts)
    .filter(([, count]) => count !== 0)
    .map(([key, count]) => `${key}=${count}`);
  return {
    schemaVersion: INSTALLED_STATE_SCHEMA,
    capturedAt: new Date().toISOString(),
    base,
    counts,
    healthy: issues.length === 0,
    issues,
  };
}

async function captureInstalledBrowserState(): Promise<InstalledBrowserStateProbe> {
  const connection = await resolveShellxDebugApiConnection({ probePath: "/browser/state", timeoutMs: 2_000 });
  const response = await fetch(`${connection.base}/browser/state`, {
    headers: { Authorization: `Bearer ${connection.token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`GET /browser/state failed ${response.status}: ${await response.text()}`);
  return summarizeInstalledBrowserState(parseInstalledBrowserState(await response.json()), connection.base);
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const output = readArg(process.argv.slice(2), "--out");
  if (!output) throw new Error("Usage: tsx scripts/shellx-installed-state-probe.ts --out <path>");
  const snapshot = await captureInstalledBrowserState();
  writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(snapshot)}\n`, (error) => error ? reject(error) : resolve());
  });
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  void main().then(
    () => process.exit(0),
    (error) => {
      const message = `FAIL installed Browser state probe: ${error instanceof Error ? error.message : String(error)}\n`;
      process.stderr.write(message, () => process.exit(1));
    },
  );
}
