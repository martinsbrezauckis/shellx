import {
  clickReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  cleanupDebugApiGitFixture,
  prepareDebugApiGitFixture,
  type DebugApiGitFixture,
} from "./debug-api-git-fixture";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type UiTab = Record<string, unknown> & { tabId: string };
type UiState = Record<string, unknown> & { activeTabId?: unknown; openTabs?: unknown };

const SURFACE = 'src/components/BranchPicker.tsx:[data-debug-id="surface-components-branchpicker-1"]';
const NEW_SESSION = "[title='New session (⌘T)']";
const BRANCH_TOGGLE = "[data-debug-id='composer-branch']";
const PICKER = ".branch-picker[role='listbox']";
const OPTION = "[data-debug-id='surface-components-branchpicker-1'][role='option']";

export const BRANCH_PICKER_LIFECYCLE_DRIVER_ID = "ui-control-branch-picker-lifecycle-installed";
export const BRANCH_PICKER_LIFECYCLE_FIXTURES = ["ui:owned-branch-picker-selection"] as const;
export const BRANCH_PICKER_LIFECYCLE_CLEANUPS = [
  "ui:close-owned-branch-picker-tab-delete-temp-git-and-restore-baseline",
] as const;
export const BRANCH_PICKER_LIFECYCLE_ORACLES = [
  "ui:selection-state-transition",
] as const;

export function supportsBranchPickerLifecycleControl(assignment: Assignment): boolean {
  return assignment.surface.name === SURFACE;
}

export async function exerciseBranchPickerLifecycleControl(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  let git: DebugApiGitFixture | null = null;
  let ownedTabId = "";
  let baselineTabs: UiTab[] = [];
  let baselineActiveId = "";
  try {
    assertAssignment(assignment);
    const baseline = await uiState(connection);
    baselineTabs = exactTabs(baseline, "BranchPicker baseline");
    baselineActiveId = exactActiveId(baseline, baselineTabs, "BranchPicker baseline");
    git = prepareDebugApiGitFixture(request);
    if (baselineTabs.some((tab) => tab.cwd === git!.apiPath)) {
      throw new Error("owned BranchPicker Git path already existed in the renderer baseline");
    }

    const beforeIds = new Set(baselineTabs.map((tab) => tab.tabId));
    const newSession = await waitForReleaseSurfaceInstalledInputElement(input, NEW_SESSION);
    await clickReleaseSurfaceInstalledInputElement(input, newSession);
    const created = await waitForUi(
      connection,
      (state) => safeTabs(state).length === baselineTabs.length + 1
        && safeTabs(state).filter((tab) => !beforeIds.has(tab.tabId)).length === 1,
      "owned BranchPicker session tab creation",
    );
    const owned = safeTabs(created).filter((tab) => !beforeIds.has(tab.tabId));
    if (owned.length !== 1 || !owned[0] || created.activeTabId !== owned[0].tabId) {
      throw new Error("BranchPicker setup did not create and activate one exact owned tab");
    }
    ownedTabId = owned[0].tabId;
    assertSafeTabId(ownedTabId);
    await postUi(connection, {
      activeTab: {
        ...owned[0],
        cwd: git.apiPath,
        connectionId: null,
        connectionLabel: "Local",
        connectionTransport: "local",
      },
    });
    await waitForUi(connection, (state) => {
      const tab = safeTabs(state).find((entry) => entry.tabId === ownedTabId);
      return state.activeTabId === ownedTabId && tab?.cwd === git!.apiPath && (tab.branchName ?? null) === null;
    }, "owned BranchPicker Git tab binding");

    const toggle = await waitForReleaseSurfaceInstalledInputElement(input, BRANCH_TOGGLE);
    await clickReleaseSurfaceInstalledInputElement(input, toggle);
    await waitForReleaseSurfaceInstalledInputElement(input, PICKER);
    const control = await waitForReleaseSurfaceInstalledInputElement(input, OPTION);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, PICKER);
    await waitForUi(connection, (state) => {
      const tab = safeTabs(state).find((entry) => entry.tabId === ownedTabId);
      return state.activeTabId === ownedTabId
        && tab?.cwd === git!.apiPath
        && tab.branchName === "release-proof";
    }, "owned BranchPicker selection persistence");
    outcome.effect = "pass";
    outcome.observedEffect = "A native click selected release-proof only on one disposable renderer tab bound to the exact owned temporary Git repository.";
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    const cleanupError = await cleanup(connection, input, git, ownedTabId, baselineTabs, baselineActiveId);
    if (cleanupError) {
      outcome.error = outcome.error ? outcome.error + "; cleanup: " + cleanupError : "cleanup: " + cleanupError;
    } else {
      outcome.cleanup = "pass";
    }
  }
  if (outcome.error && outcome.present === "pass" && outcome.invoke === "pass" && outcome.effect === "pass") {
    outcome.effect = "fail";
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "BranchPicker lifecycle evidence was incomplete";
  }
  return outcome;
}

async function cleanup(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  git: DebugApiGitFixture | null,
  ownedTabId: string,
  baselineTabs: UiTab[],
  baselineActiveId: string,
): Promise<string | null> {
  const errors: string[] = [];
  try {
    await postUi(connection, { composerMenu: "close" });
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, PICKER);
    if (ownedTabId) {
      const state = await uiState(connection);
      if (safeTabs(state).some((tab) => tab.tabId === ownedTabId)) {
        const close = await waitForReleaseSurfaceInstalledInputElement(input, ownedCloseSelector(ownedTabId));
        await clickReleaseSurfaceInstalledInputElement(input, close);
        await waitForReleaseSurfaceInstalledInputElementAbsent(input, ownedCloseSelector(ownedTabId));
      }
    }
    if (baselineTabs.length > 0 && baselineActiveId) {
      const afterClose = await uiState(connection);
      if (afterClose.activeTabId !== baselineActiveId) {
        const baselineTab = await waitForReleaseSurfaceInstalledInputElement(input, tabSelector(baselineActiveId));
        await clickReleaseSurfaceInstalledInputElement(input, baselineTab);
      }
      await waitForUi(connection, (state) => {
        const tabs = safeTabs(state);
        return state.activeTabId === baselineActiveId
          && tabs.length === baselineTabs.length
          && tabs.every((tab, index) => tab.tabId === baselineTabs[index]?.tabId);
      }, "BranchPicker exact tab baseline restoration");
    }
  } catch (error) {
    errors.push(errorMessage(error));
  }
  if (git) {
    const error = cleanupDebugApiGitFixture(git);
    if (error) errors.push(error);
  }
  return errors.length ? errors.join("; ") : null;
}

function assertAssignment(assignment: Assignment): void {
  if (!supportsBranchPickerLifecycleControl(assignment)
    || assignment.fixtureId !== BRANCH_PICKER_LIFECYCLE_FIXTURES[0]
    || assignment.oracleId !== BRANCH_PICKER_LIFECYCLE_ORACLES[0]
    || assignment.cleanupId !== BRANCH_PICKER_LIFECYCLE_CLEANUPS[0]) {
    throw new Error("BranchPicker lifecycle assignment contract drifted");
  }
}

function exactTabs(state: UiState, label: string): UiTab[] {
  const tabs = safeTabs(state);
  if (!Array.isArray(state.openTabs) || tabs.length !== state.openTabs.length || tabs.length === 0) {
    throw new Error(label + " did not expose a nonempty exact openTabs array");
  }
  if (new Set(tabs.map((tab) => tab.tabId)).size !== tabs.length) {
    throw new Error(label + " contained duplicate tab identities");
  }
  return tabs;
}

function safeTabs(state: UiState): UiTab[] {
  return Array.isArray(state.openTabs) ? state.openTabs.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const tab = value as Record<string, unknown>;
    return typeof tab.tabId === "string" && tab.tabId ? [tab as UiTab] : [];
  }) : [];
}

function exactActiveId(state: UiState, tabs: UiTab[], label: string): string {
  const id = typeof state.activeTabId === "string" ? state.activeTabId : "";
  if (!id || !tabs.some((tab) => tab.tabId === id)) {
    throw new Error(label + " did not bind activeTabId to one exact open tab");
  }
  return id;
}

async function waitForUi(
  connection: Connection,
  predicate: (state: UiState) => boolean,
  label: string,
): Promise<UiState> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await uiState(connection);
    if (predicate(state)) return state;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(label + " did not settle before timeout");
}

async function uiState(connection: Connection): Promise<UiState> {
  return apiJson(connection, "GET", "/state/ui");
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    debugSurface: "app",
    source: "final-surface-branch-picker-lifecycle",
    ...body,
  });
}

async function apiJson(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<UiState> {
  const headers = new Headers({ Authorization: "Bearer " + connection.token });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(connection.base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(method + " " + path + " failed " + response.status + ": " + await response.text());
  return await response.json() as UiState;
}

function tabSelector(tabId: string): string {
  assertSafeTabId(tabId);
  return "[data-tab-id='" + tabId + "']";
}

function ownedCloseSelector(tabId: string): string {
  return tabSelector(tabId) + " [aria-label='Close session']";
}

function assertSafeTabId(tabId: string): void {
  if (!/^[A-Za-z0-9._:-]+$/.test(tabId)) throw new Error("owned BranchPicker tab identity was not selector-safe");
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
    observedEffect: "No owned BranchPicker selection was observed.",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
