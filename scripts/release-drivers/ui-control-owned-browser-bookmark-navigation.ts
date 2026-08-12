import {
  clickReleaseSurfaceInstalledInputElement,
  closeReleaseSurfaceInstalledInputWindow,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  switchReleaseSurfaceInstalledInputWindow,
  switchReleaseSurfaceInstalledInputWindowByTitle,
  waitForReleaseSurfaceInstalledInputElement,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { cleanupOwnedBrowserLifecycle } from "../shellx-browser-test-cleanup";
import { startOwnedBrowserHomePage, type OwnedBrowserHomePage } from "./ui-control-owned-browser-bookmarks";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;
type Kind = "current" | "toolbarFolder" | "toolbarLink" | "folderChild" | "listRow" | "managerOpen";
type Bookmark = {
  bookmarkId: string;
  label: string;
  kind: "folder" | "link";
  url?: string | null;
  parentId?: string | null;
  toolbarPinned?: boolean;
};
type BrowserTab = { browserTabId: string; taskId?: string | null; url?: string | null };

const BOOKMARKS_OWNER = "[data-debug-id='shellx-browser-bookmarks-menu']";
const BOOKMARKS_PANEL = "#shellx-browser-bookmark-manager-dock[aria-labelledby='shellx-browser-bookmarks-menu']";
const EDIT_MODE = "[data-debug-id='shellx-browser-bookmark-manager-toggle']";
const LIST_MODE = "[data-debug-id='shellx-browser-bookmark-list-mode']";
const BOOKMARK_CURRENT = "[data-debug-id='shellx-browser-bookmark-current']";
const HISTORY_OWNER = "[data-debug-id='shellx-browser-history-menu']";
const HISTORY_PANEL = "#shellx-browser-history-sidecar[aria-labelledby='shellx-browser-history-menu']";
const HISTORY_USER_SCOPE = "[data-debug-id='shellx-browser-history-user']";
const HISTORY_AGENT_SCOPE = "[data-debug-id='shellx-browser-history-agent']";
const CLEAR_HISTORY = "[data-debug-id='shellx-browser-clear-history']";
const CLEAR_HISTORY_CONFIRMATION = "[data-debug-id='shellx-browser-history-clear-confirmation']";
const CLEAR_HISTORY_CONFIRM = "[data-debug-id='shellx-browser-history-clear-confirm']";
const ROOT_ID = "final-surface-navigation-link";
const FOLDER_ID = "final-surface-navigation-folder";
const CHILD_ID = "final-surface-navigation-child";
const SURFACES: Record<string, Kind> = {
  "src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-bookmark-current\"]": "current",
  "src/browser/components/BookmarkToolbar.tsx:[data-debug-id^=\"shellx-browser-bookmark-folder-\"]": "toolbarFolder",
  "src/browser/components/BookmarkToolbar.tsx:[data-debug-id^=\"shellx-browser-bookmark-toolbar-link-\"]": "toolbarLink",
  "src/browser/components/BookmarkToolbar.tsx:[data-debug-id^=\"shellx-browser-bookmark-folder-child-\"]": "folderChild",
  "src/browser/components/BookmarkSidecar.tsx:[data-debug-id^=\"shellx-browser-bookmark-\"]": "listRow",
  "src/browser/components/BookmarkSidecar.tsx:[data-debug-id^=\"shellx-browser-bookmark-open-\"]": "managerOpen",
};
export const OWNED_BROWSER_BOOKMARK_NAV_FIXTURES = ["ui:browser-bookmark-owned-navigation"] as const;
export const OWNED_BROWSER_BOOKMARK_NAV_CLEANUPS = ["ui:delete-owned-bookmark-navigation-abort-task-and-window-loopback"] as const;
export const OWNED_BROWSER_BOOKMARK_NAV_ORACLES = [
  "ui:activation:owned-browser-bookmark-created",
  "ui:activation:owned-browser-bookmark-navigation",
] as const;

export function supportsOwnedBrowserBookmarkNavigation(assignment: Assignment): boolean {
  return assignment.surface.name in SURFACES;
}

export async function exerciseOwnedBrowserBookmarkNavigation(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const kind = SURFACES[assignment.surface.name];
  const outcome = emptyOutcome(assignment);
  const cleanupErrors: string[] = [];
  const ownedIds: string[] = [];
  let page: OwnedBrowserHomePage | null = null;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  let ownedEmptyHistoryBaseline = false;
  let baselineManageMode: boolean | null = null;
  try {
    if (!kind) throw new Error(`owned bookmark navigation driver does not support ${assignment.surface.name}`);
    trace(kind, "start");
    if ((await listBookmarks(connection)).length !== 0) {
      throw new Error("owned bookmark navigation fixture requires an isolated empty bookmark baseline");
    }
    if (await historyCount(connection) !== 0) {
      throw new Error("owned bookmark navigation fixture requires an isolated empty history baseline");
    }
    ownedEmptyHistoryBaseline = true;
    page = await startOwnedBrowserHomePage();
    const started = await apiJson(connection, "POST", "/browser/task/start", {
      goal: `Final surface Browser bookmark ${kind} proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: page.startUrl,
      expectedDomains: ["127.0.0.1"],
    });
    taskId = requiredString(started.taskId, "Browser bookmark navigation taskId");
    const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    trace(kind, "window-ready");

    if (kind !== "current") {
      if (kind === "toolbarFolder" || kind === "folderChild") {
        await createBookmark(connection, {
          bookmarkId: FOLDER_ID,
          label: "Final surface navigation folder",
          kind: "folder",
          toolbarPinned: true,
        });
        ownedIds.push(FOLDER_ID);
        await createBookmark(connection, {
          bookmarkId: CHILD_ID,
          label: "Final surface navigation child",
          kind: "link",
          url: page.firstUrl,
          parentId: FOLDER_ID,
          toolbarPinned: false,
        });
        ownedIds.unshift(CHILD_ID);
      } else {
        await createBookmark(connection, {
          bookmarkId: ROOT_ID,
          label: "Final surface navigation link",
          kind: "link",
          url: page.firstUrl,
          toolbarPinned: kind === "toolbarLink",
        });
        ownedIds.push(ROOT_ID);
      }
    }
    trace(kind, "fixture-ready");

    if (kind === "current") {
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, BOOKMARK_CURRENT);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      const created = await waitForBookmark(connection, (bookmark) => bookmark.kind === "link" && bookmark.url === page!.startUrl);
      ownedIds.push(created.bookmarkId);
      outcome.effect = "pass";
      outcome.observedEffect = "Native WebDriver installed input created exactly one bookmark for the owned active loopback page.";
    } else if (kind === "toolbarFolder") {
      const folder = `[data-debug-id='shellx-browser-bookmark-folder-${FOLDER_ID}']`;
      const child = `[data-debug-id='shellx-browser-bookmark-folder-child-${CHILD_ID}']`;
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, folder);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElement(webdriver, child);
      outcome.effect = "pass";
      outcome.observedEffect = "Native WebDriver installed input opened the exact owned bookmark folder and exposed only its owned child.";
    } else {
      let selector: string;
      if (kind === "toolbarLink") selector = `[data-debug-id='shellx-browser-bookmark-toolbar-link-${ROOT_ID}']`;
      else if (kind === "folderChild") {
        await clickReleaseSurfaceInstalledInputElement(
          webdriver,
          await waitForReleaseSurfaceInstalledInputElement(webdriver, `[data-debug-id='shellx-browser-bookmark-folder-${FOLDER_ID}']`),
        );
        selector = `[data-debug-id='shellx-browser-bookmark-folder-child-${CHILD_ID}']`;
      } else {
        await openBookmarks(webdriver);
        baselineManageMode = await readManageMode(webdriver);
        if (kind === "managerOpen") {
          await setManageMode(webdriver, true);
          selector = `[data-debug-id='shellx-browser-bookmark-open-${ROOT_ID}'][aria-label='Open Final surface navigation link']`;
        } else {
          await setManageMode(webdriver, false);
          selector = `[data-debug-id='shellx-browser-bookmark-${ROOT_ID}']`;
        }
      }
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, selector);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForTaskUrl(connection, taskId, page.firstUrl);
      outcome.effect = "pass";
      outcome.observedEffect = `Native WebDriver installed input navigated the exact owned task tab through its ${kind} bookmark control.`;
    }
    trace(kind, "effect-finished");
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    trace(kind ?? "unknown", "cleanup-start");
    if (browserWindowOpen) {
      await cleanupAttempt(cleanupErrors, async () => {
        const folder = `[data-debug-id='shellx-browser-bookmark-folder-${FOLDER_ID}']`;
        const child = `[data-debug-id='shellx-browser-bookmark-folder-child-${CHILD_ID}']`;
        if (await findReleaseSurfaceInstalledInputElement(webdriver, child)) {
          await clickReleaseSurfaceInstalledInputElement(webdriver, await waitForReleaseSurfaceInstalledInputElement(webdriver, folder));
        }
        if (baselineManageMode !== null) {
          await openBookmarks(webdriver);
          await setManageMode(webdriver, baselineManageMode);
        }
        await closeBookmarks(webdriver);
      });
    }
    if (browserWindowOpen && ownedEmptyHistoryBaseline) {
      await cleanupAttempt(cleanupErrors, async () => clearOwnedHistory(connection, webdriver));
    }
    for (const bookmarkId of ownedIds) {
      await cleanupAttempt(cleanupErrors, async () => deleteBookmark(connection, bookmarkId));
    }
    await cleanupAttempt(cleanupErrors, async () => {
      if ((await listBookmarks(connection)).length !== 0) throw new Error("owned bookmark navigation cleanup left bookmark state");
    });
    if (taskId) {
      await cleanupAttempt(cleanupErrors, async () => {
        const result = await cleanupOwnedBrowserLifecycle(
          (method, path, body) => apiJson(connection, method, path, body),
          { taskIds: [taskId!], label: "final surface Browser bookmark navigation" },
        );
        if (result.errors.length > 0) throw new Error(result.errors.join("; "));
      });
    }
    if (browserWindowOpen && originalWindow) {
      await cleanupAttempt(cleanupErrors, async () => {
        await closeReleaseSurfaceInstalledInputWindow(webdriver);
        await switchReleaseSurfaceInstalledInputWindow(webdriver, originalWindow!);
      });
    }
    if (page) await cleanupAttempt(cleanupErrors, page.close);
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}cleanup: ${cleanupErrors.join(" | ")}`;
  }
  trace(kind ?? "unknown", "done");
  return finalize(outcome);
}

async function openBookmarks(webdriver: WebDriver): Promise<void> {
  if (await findReleaseSurfaceInstalledInputElement(webdriver, BOOKMARKS_PANEL)) return;
  await clickReleaseSurfaceInstalledInputElement(webdriver, await waitForReleaseSurfaceInstalledInputElement(webdriver, BOOKMARKS_OWNER));
  await waitForReleaseSurfaceInstalledInputElement(webdriver, BOOKMARKS_PANEL);
}

async function closeBookmarks(webdriver: WebDriver): Promise<void> {
  if (!await findReleaseSurfaceInstalledInputElement(webdriver, BOOKMARKS_PANEL)) return;
  await clickReleaseSurfaceInstalledInputElement(webdriver, await waitForReleaseSurfaceInstalledInputElement(webdriver, BOOKMARKS_OWNER));
}

async function readManageMode(webdriver: WebDriver): Promise<boolean> {
  const [list, edit] = await Promise.all([
    observeReleaseSurfaceInstalledInputElement(webdriver, LIST_MODE, ["pressed"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, EDIT_MODE, ["pressed"]),
  ]);
  if (!list.present || !list.visible || !edit.present || !edit.visible) {
    throw new Error("Browser bookmark navigation mode controls were not both visible");
  }
  if (list.pressed === true && edit.pressed === false) return false;
  if (list.pressed === false && edit.pressed === true) return true;
  throw new Error("Browser bookmark navigation did not expose one exact manage mode");
}

async function setManageMode(webdriver: WebDriver, expected: boolean): Promise<void> {
  if (await readManageMode(webdriver) === expected) return;
  await clickReleaseSurfaceInstalledInputElement(
    webdriver,
    await waitForReleaseSurfaceInstalledInputElement(webdriver, expected ? EDIT_MODE : LIST_MODE),
  );
  if (await readManageMode(webdriver) !== expected) throw new Error("Browser bookmark navigation manage-mode transition failed");
}

async function clearOwnedHistory(connection: Connection, webdriver: WebDriver): Promise<void> {
  if (await historyCount(connection) === 0) return;
  if (!await findReleaseSurfaceInstalledInputElement(webdriver, HISTORY_PANEL)) {
    await clickReleaseSurfaceInstalledInputElement(webdriver, await waitForReleaseSurfaceInstalledInputElement(webdriver, HISTORY_OWNER));
    await waitForReleaseSurfaceInstalledInputElement(webdriver, HISTORY_PANEL);
  }
  await clickReleaseSurfaceInstalledInputElement(
    webdriver,
    await waitForReleaseSurfaceInstalledInputElement(webdriver, HISTORY_AGENT_SCOPE),
  );
  await clickReleaseSurfaceInstalledInputElement(webdriver, await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_HISTORY));
  await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_HISTORY_CONFIRMATION);
  await clickReleaseSurfaceInstalledInputElement(
    webdriver,
    await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_HISTORY_CONFIRM),
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await historyCount(connection) === 0) break;
    await delay(50);
  }
  if (await historyCount(connection) !== 0) throw new Error("owned bookmark navigation history cleanup failed");
  await clickReleaseSurfaceInstalledInputElement(
    webdriver,
    await waitForReleaseSurfaceInstalledInputElement(webdriver, HISTORY_USER_SCOPE),
  );
  if (await findReleaseSurfaceInstalledInputElement(webdriver, HISTORY_PANEL)) {
    await clickReleaseSurfaceInstalledInputElement(webdriver, await waitForReleaseSurfaceInstalledInputElement(webdriver, HISTORY_OWNER));
  }
}

async function historyCount(connection: Connection): Promise<number> {
  const state = await apiJson(connection, "GET", "/browser/state");
  return Array.isArray(state.history) ? state.history.length : 0;
}

async function createBookmark(connection: Connection, bookmark: Bookmark): Promise<void> {
  await apiJson(connection, "POST", "/browser/bookmarks", bookmark as unknown as Record<string, unknown>);
  await waitForBookmark(connection, (candidate) => candidate.bookmarkId === bookmark.bookmarkId);
}

async function deleteBookmark(connection: Connection, bookmarkId: string): Promise<void> {
  const response = await fetch(`${connection.base}/browser/bookmarks/${encodeURIComponent(bookmarkId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${connection.token}` },
  });
  if (!response.ok && response.status !== 404) throw new Error(`bookmark cleanup returned HTTP ${response.status}`);
}

async function listBookmarks(connection: Connection): Promise<Bookmark[]> {
  const value = await apiJson(connection, "GET", "/browser/bookmarks");
  return Array.isArray(value.bookmarks)
    ? value.bookmarks.map((bookmark) => record(bookmark, "Browser bookmark") as Bookmark)
    : [];
}

async function waitForBookmark(connection: Connection, predicate: (bookmark: Bookmark) => boolean): Promise<Bookmark> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const bookmark = (await listBookmarks(connection)).find(predicate);
    if (bookmark) return bookmark;
    await delay(50);
  }
  throw new Error("owned Browser bookmark did not reach the required state");
}

async function waitForTaskUrl(connection: Connection, taskId: string, url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await apiJson(connection, "GET", "/browser/state");
    const tabs = Array.isArray(state.tabs) ? state.tabs.map((tab) => record(tab, "Browser tab") as BrowserTab) : [];
    if (tabs.some((tab) => tab.taskId === taskId && tab.url === url)) return;
    await delay(50);
  }
  throw new Error(`owned Browser task did not reach bookmark URL ${url}`);
}

async function apiJson(connection: Connection, method: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${connection.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} returned HTTP ${response.status}: ${text.slice(0, 240)}`);
  return record(JSON.parse(text), `${method} ${path}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
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
    observedEffect: "No native owned Browser-bookmark navigation transition was observed.",
  };
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if (outcome.present === "pass" && outcome.invoke === "pass" && outcome.effect === "pass" && outcome.cleanup === "pass") return outcome;
  outcome.observedEffect = "Requested effect was not fully verified; private failure details were not retained.";
  return outcome;
}

async function cleanupAttempt(errors: string[], action: () => Promise<void>): Promise<void> {
  try { await action(); } catch (error) { errors.push(errorText(error)); }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trace(kind: string, step: string): void {
  if (process.env.SHELLX_RELEASE_DRIVER_TRACE === "1") process.stderr.write(`[bookmark-navigation:${kind}] ${step}\n`);
}
