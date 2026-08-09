import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  findReleaseSurfaceInstalledInputElement,
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
import { apiJson, postUi } from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type Action = "close" | "input" | "go" | "use" | "up" | "parent-empty" | "parent-populated" | "folder";
type UiBaseline = { activeTabId: string; activeTab: Record<string, unknown> };
type OwnedTree = {
  root: string;
  empty: string;
  listing: string;
  child: string;
};

const DIALOG = "[role='dialog'][aria-label='Remote folder picker']";
const INPUT = "[data-debug-id='remote-cwd-input']";
const CLOSE = "[data-debug-id='remote-cwd-close']";
const GO = "[data-debug-id='remote-cwd-go']";
const USE = "[data-debug-id='remote-cwd-use']";
const UP = "[data-debug-id='remote-cwd-up']";
const PARENT = "[data-debug-id='remote-cwd-parent']";
const FOLDER = "[data-debug-id='remote-cwd-folder']";

const ACTION_BY_SURFACE_ID = new Map<string, Action>([
  ['ui-control:src/App.tsx:[data-debug-id="remote-cwd-close"]@src/App.tsx#1', "close"],
  ['ui-control:src/App.tsx:[data-debug-id="remote-cwd-input"]@src/App.tsx#2', "input"],
  ['ui-control:src/App.tsx:[data-debug-id="remote-cwd-go"]@src/App.tsx#3', "go"],
  ['ui-control:src/App.tsx:[data-debug-id="remote-cwd-use"]@src/App.tsx#4', "use"],
  ['ui-control:src/App.tsx:[data-debug-id="remote-cwd-up"]@src/App.tsx#5', "up"],
  ['ui-control:src/App.tsx:[data-debug-id="remote-cwd-parent"]@src/App.tsx#6', "parent-empty"],
  ['ui-control:src/App.tsx:[data-debug-id="remote-cwd-parent"]@src/App.tsx#7', "parent-populated"],
  ['ui-control:src/App.tsx:[data-debug-id="remote-cwd-folder"]@src/App.tsx#8', "folder"],
]);

export const REMOTE_CWD_LIFECYCLE_FIXTURES = ["ui:remote-cwd-owned-local-tree"] as const;
export const REMOTE_CWD_LIFECYCLE_CLEANUPS = ["ui:close-remote-cwd-picker-delete-owned-tree"] as const;
export const REMOTE_CWD_LIFECYCLE_ORACLES = ["ui:activation:remote-cwd-path-transition"] as const;

export function supportsRemoteCwdLifecycleControl(assignment: Assignment): boolean {
  return ACTION_BY_SURFACE_ID.has(assignment.surface.id);
}

export async function exerciseRemoteCwdLifecycleControl(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  const action = ACTION_BY_SURFACE_ID.get(assignment.surface.id);
  let owned: OwnedTree | null = null;
  let baseline: UiBaseline | null = null;
  try {
    if (!action) throw new Error("Remote Folder control is outside the exact owned lifecycle cohort");
    if (await findReleaseSurfaceInstalledInputElement(installedInput, DIALOG)) {
      throw new Error("Remote Folder lifecycle refuses to overlay an operator folder picker");
    }
    baseline = await readUiBaseline(connection);
    if (action === "use" && baseline.activeTab.connectionTransport !== "local") {
      throw new Error("Remote Folder Use fixture requires the isolated candidate's local active tab");
    }
    owned = prepareOwnedTree();
    const initialPath = initialPathForAction(owned, action);
    await postUi(connection, {
      cwdPicker: {
        path: initialPath,
        label: action === "use" ? "Final surface owned active tab folder" : "Final surface isolated local folder",
        isolated: action !== "use",
        ...(action === "use" ? { tabId: baseline.activeTabId } : {}),
      },
      source: "final-surface-owned-remote-cwd",
    });
    await waitForReleaseSurfaceInstalledInputElement(installedInput, DIALOG, {
      timeoutMs: 8_000,
      pollMs: 75,
    });
    await waitForValue(installedInput, initialPath);
    outcome.present = "pass";

    const observedEffect = await exerciseAction(connection, installedInput, action, owned, initialPath, baseline);
    outcome.invoke = "pass";
    outcome.effect = "pass";
    outcome.observedEffect = observedEffect;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    applyCleanup(outcome, owned && baseline ? await cleanupOwnedTree(connection, installedInput, owned, baseline) : null);
  }
  return finalize(outcome);
}

async function exerciseAction(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  action: Action,
  owned: OwnedTree,
  initialPath: string,
  baseline: UiBaseline,
): Promise<string> {
  if (action === "close") {
    const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, CLOSE);
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
    return "A native WebDriver click closed only the isolated Remote Folder picker; no tab, provider, clipboard, or operator path was changed.";
  }
  if (action === "input") {
    const draft = join(owned.listing, "draft-only");
    await setInput(installedInput, draft);
    await waitForValue(installedInput, draft);
    await setInput(installedInput, initialPath);
    await waitForValue(installedInput, initialPath);
    return "Native WebDriver text entry changed and exactly restored only the isolated Remote Folder draft without navigating, selecting, or persisting it.";
  }
  if (action === "go") {
    await setInput(installedInput, owned.child);
    await waitForDisabled(installedInput, true);
    const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, GO);
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    await waitForValue(installedInput, owned.child);
    await waitForDisabled(installedInput, false);
    return "A native WebDriver click navigated the isolated Remote Folder picker to the exact typed owned directory and completed its real local listing without changing a tab.";
  }
  if (action === "use") {
    await waitForDisabled(installedInput, false);
    const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, USE);
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
    await waitForActiveCwd(connection, baseline.activeTabId, initialPath);
    return "A native WebDriver click persisted the exact owned local directory into only the isolated active tab before exact tab restoration.";
  }
  const selector = action === "up" ? UP : action.startsWith("parent-") ? PARENT : FOLDER;
  const expected = action === "folder" ? owned.child : action === "up" ? owned.listing : owned.root;
  const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, selector);
  await clickReleaseSurfaceInstalledInputElement(installedInput, control);
  await waitForValue(installedInput, expected);
  await waitForDisabled(installedInput, false);
  const label = action === "folder" ? "owned child" : "owned parent";
  return `A native WebDriver click navigated the isolated Remote Folder picker to its exact ${label} and completed the real local listing without selecting it into an operator tab.`;
}

function prepareOwnedTree(): OwnedTree {
  const root = mkdtempSync(join(tmpdir(), "shellx-release-ui-remote-cwd-"));
  try {
    const empty = join(root, "empty");
    const listing = join(root, "listing");
    const child = join(listing, "owned-child");
    mkdirSync(empty, { mode: 0o700 });
    mkdirSync(listing, { mode: 0o700 });
    mkdirSync(child, { mode: 0o700 });
    return { root, empty, listing, child };
  } catch (error) {
    if (existsSync(root)) rmSync(root, { recursive: true });
    throw error;
  }
}

function initialPathForAction(owned: OwnedTree, action: Action): string {
  if (action === "up") return owned.child;
  if (action === "parent-empty") return owned.empty;
  return owned.listing;
}

async function setInput(
  installedInput: ReleaseSurfaceInstalledInputSession,
  value: string,
): Promise<void> {
  const input = await waitForReleaseSurfaceInstalledInputElement(installedInput, INPUT);
  await clearReleaseSurfaceInstalledInputElement(installedInput, input);
  await setReleaseSurfaceInstalledInputElementValue(installedInput, input, value);
}

async function waitForValue(
  installedInput: ReleaseSurfaceInstalledInputSession,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(installedInput, INPUT, ["value"]);
    if (state.present && state.visible && state.value === expected) return;
    await delay(50);
  }
  throw new Error(`Remote Folder input did not reach ${expected}`);
}

async function waitForDisabled(
  installedInput: ReleaseSurfaceInstalledInputSession,
  expected: boolean,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(installedInput, USE, ["disabled"]);
    if (state.present && state.visible && state.disabled === expected) return;
    await delay(50);
  }
  throw new Error(`Remote Folder Use did not reach disabled=${String(expected)}`);
}

async function cleanupOwnedTree(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  owned: OwnedTree,
  baseline: UiBaseline,
): Promise<string | null> {
  const errors: string[] = [];
  try {
    await postUi(connection, {
      cwdPicker: { open: false },
      activeTabId: baseline.activeTabId,
      activeTab: baseline.activeTab,
      source: "final-surface-owned-remote-cwd-cleanup",
    });
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, INPUT);
    const restored = await readUiBaseline(connection);
    if (restored.activeTabId !== baseline.activeTabId
      || JSON.stringify(restored.activeTab) !== JSON.stringify(baseline.activeTab)) {
      throw new Error("Remote Folder cleanup did not restore the exact active tab baseline");
    }
  } catch (error) {
    errors.push(`picker: ${errorText(error)}`);
  }
  try {
    if (existsSync(owned.root)) rmSync(owned.root, { recursive: true });
    if (existsSync(owned.root)) throw new Error("owned Remote Folder tree remained after deletion");
  } catch (error) {
    errors.push(`tree: ${errorText(error)}`);
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

async function readUiBaseline(connection: Connection): Promise<UiBaseline> {
  const state = await apiJson(connection, "GET", "/state/ui");
  if (typeof state.activeTabId !== "string" || !state.activeTabId
    || !state.activeTab || typeof state.activeTab !== "object" || Array.isArray(state.activeTab)) {
    throw new Error("Remote Folder lifecycle requires one exact active tab baseline");
  }
  const activeTab = structuredClone(state.activeTab as Record<string, unknown>);
  if (activeTab.tabId !== state.activeTabId) throw new Error("Remote Folder active tab identity is inconsistent");
  return { activeTabId: state.activeTabId, activeTab };
}

async function waitForActiveCwd(connection: Connection, tabId: string, expected: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const state = await readUiBaseline(connection);
    if (state.activeTabId === tabId && state.activeTab.cwd === expected) return;
    await delay(50);
  }
  throw new Error(`Remote Folder Use did not persist ${expected} into exact tab ${tabId}`);
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
    observedEffect: "No isolated Remote Folder lifecycle transition was observed.",
  };
}

function applyCleanup(outcome: ReleaseSurfaceDriverOutcome, error: string | null): void {
  if (!error) outcome.cleanup = "pass";
  else outcome.error = outcome.error ? `${outcome.error}; cleanup: ${error}` : `cleanup: ${error}`;
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Remote Folder control did not satisfy every isolated lifecycle verdict";
  }
  return outcome;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
