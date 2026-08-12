import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import {
  clearReleaseSurfaceInstalledInputElement as clearReleaseSurfaceWebDriverElement,
  clickReleaseSurfaceInstalledInputElement as clickReleaseSurfaceWebDriverElement,
  closeReleaseSurfaceInstalledInputWindow as closeReleaseSurfaceWebDriverWindow,
  dragReleaseSurfaceInstalledInputElementToElement as dragReleaseSurfaceWebDriverElementToElement,
  observeReleaseSurfaceInstalledInputElement as observeReleaseSurfaceWebDriverElement,
  performReleaseSurfaceInstalledInputKeyChord,
  setReleaseSurfaceInstalledInputElementValue as setReleaseSurfaceWebDriverElementValue,
  switchReleaseSurfaceInstalledInputWindow as switchReleaseSurfaceWebDriverWindow,
  switchReleaseSurfaceInstalledInputWindowByTitle as switchReleaseSurfaceWebDriverWindowByTitle,
  waitForReleaseSurfaceInstalledInputElement as waitForReleaseSurfaceWebDriverElement,
  waitForReleaseSurfaceInstalledInputElementAbsent as waitForReleaseSurfaceWebDriverElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { cleanupOwnedBrowserLifecycle } from "../shellx-browser-test-cleanup";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type WebDriver = ReleaseSurfaceInstalledInputSession;
type Connection = { base: string; token: string };
type Bookmark = {
  bookmarkId: string;
  label: string;
  kind: "folder" | "link";
  url?: string | null;
  parentId?: string | null;
  toolbarPinned?: boolean;
  toolbarOrder?: number | null;
};
type BrowserTab = {
  browserTabId: string;
  taskId?: string | null;
  profileId: string;
  url?: string | null;
  active?: boolean;
  ownerKind: "user" | "agent" | "delegatedToAgent";
  delegatedTaskId?: string | null;
  delegatedGrantId?: string | null;
  lock?: {
    leaseId: string;
    ownerAgentId: string;
    ownerRunId: string;
  } | null;
};

const OWNER = "[data-debug-id='shellx-browser-bookmarks-menu']";
const PANEL = "#shellx-browser-bookmark-manager-dock[aria-labelledby='shellx-browser-bookmarks-menu']";
const CLOSE = "[data-debug-id='shellx-browser-bookmark-manager-close']";
const LIST_MODE = "[data-debug-id='shellx-browser-bookmark-list-mode']";
const EDIT_MODE = "[data-debug-id='shellx-browser-bookmark-manager-toggle']";
const DRAFT_LABEL = "[data-debug-id='shellx-browser-bookmark-draft-label']";
const DRAFT_URL = "[data-debug-id='shellx-browser-bookmark-draft-url']";
const DRAFT_FOLDER = "[data-debug-id='shellx-browser-bookmark-draft-folder']";
const NEW_FOLDER = "[data-debug-id='shellx-browser-bookmark-create-folder']";
const ADD_LINK = "[data-debug-id='shellx-browser-bookmark-create-link']";
const OWNED_LINK_ID = "final-surface-ui-control-link";
const OWNED_FOLDER_ID = "final-surface-ui-control-folder";
const OWNED_DRAG_FIRST_ID = "final-surface-ui-control-drag-first";
const OWNED_DRAG_SECOND_ID = "final-surface-ui-control-drag-second";
const CREATED_FOLDER_LABEL = "Final surface UI-created folder";
const CREATED_LINK_LABEL = "Final surface UI-created link";
const CREATED_LINK_URL = "https://shellx.invalid/final-surface-ui-created-link";
const HEADER_BROWSER = "[data-debug-id='header-shellx-browser']";
const NEW_TAB = "[data-debug-id='shellx-browser-new-tab']";
const NEW_DISPOSABLE_TAB = "[data-debug-id='shellx-browser-new-disposable-tab']";
const HOME = "[data-debug-id='shellx-browser-home']";
const BACK = "[data-debug-id='shellx-browser-back']";
const FORWARD = "[data-debug-id='shellx-browser-forward']";
const RELOAD = "[data-debug-id='shellx-browser-reload']";
const LOCK_TAB = "[data-debug-id='shellx-browser-lock-tab']";
const HANDOFF_TAB = "[data-debug-id='shellx-browser-handoff-tab']";
const TAKE_BACK_TAB = "[data-debug-id='shellx-browser-take-back-tab']";
const HANDOFF_CONFIRMATION = "[data-debug-id='shellx-browser-handoff-confirmation']";
const HANDOFF_BACKDROP = "[data-debug-id='shellx-browser-handoff-confirmation-backdrop']";
const HANDOFF_CONTEXT = "[data-debug-id='shellx-browser-handoff-context']";
const HANDOFF_VAULT_NOTICE = "[data-debug-id='shellx-browser-handoff-vault-notice']";
const HANDOFF_STATUS = "[data-debug-id='shellx-browser-handoff-status']";
const HANDOFF_CANCEL = "[data-debug-id='shellx-browser-handoff-cancel']";
const HANDOFF_CONFIRM = "[data-debug-id='shellx-browser-handoff-confirm']";
const OPTIONS_OWNER = "[data-debug-id='shellx-browser-options']";
const OPTIONS_PANEL = "#shellx-browser-options-sidecar[aria-labelledby='shellx-browser-options']";
const HOME_INPUT = "[data-debug-id='shellx-browser-homepage']";

const SURFACES = {
  drag: "src/browser/components/BookmarkSidecar.tsx:[data-debug-id^=\"shellx-browser-bookmark-drag-\"]",
  label: "src/browser/components/BookmarkSidecar.tsx:[data-debug-id^=\"shellx-browser-bookmark-label-\"]",
  url: "src/browser/components/BookmarkSidecar.tsx:[data-debug-id^=\"shellx-browser-bookmark-url-\"]",
  pin: "src/browser/components/BookmarkSidecar.tsx:[data-debug-id^=\"shellx-browser-bookmark-pin-\"]",
  delete: "src/browser/components/BookmarkSidecar.tsx:[data-debug-id^=\"shellx-browser-bookmark-delete-\"]",
  folder: "src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-bookmark-draft-folder\"]",
  createFolder: "src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-bookmark-create-folder\"]",
  createLink: "src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-bookmark-create-link\"]",
} as const;

type ControlKind = keyof typeof SURFACES;
const kindBySurface = new Map<string, ControlKind>(
  Object.entries(SURFACES).map(([kind, surface]) => [surface, kind as ControlKind]),
);
const TAB_SURFACES = {
  focus: "src/browser/components/BrowserChrome.tsx:[data-debug-id^=\"shellx-browser-tab-\"]",
  close: "src/browser/components/BrowserChrome.tsx:[data-debug-id^=\"shellx-browser-close-tab-\"]",
  create: "src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-new-tab\"]",
  createDisposable: "src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-new-disposable-tab\"]",
  home: "src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-home\"]",
  back: "src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-back\"]",
  forward: "src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-forward\"]",
  reload: "src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-reload\"]",
  lock: "src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-lock-tab\"]",
  handoff: "src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-handoff-tab\"]",
  takeback: "src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-take-back-tab\"]",
  handoffCancel: "src/browser/components/BrowserTabHandoffConfirmation.tsx:[data-debug-id=\"shellx-browser-handoff-cancel\"]",
  handoffConfirm: "src/browser/components/BrowserTabHandoffConfirmation.tsx:[data-debug-id=\"shellx-browser-handoff-confirm\"]",
} as const;
type TabControlKind = keyof typeof TAB_SURFACES;
const tabKindBySurface = new Map<string, TabControlKind>(
  Object.entries(TAB_SURFACES).map(([kind, surface]) => [surface, kind as TabControlKind]),
);
type BrowserTabControlOptions = { handoffMarkerSelector?: string };

type OwnedHomepageState = { value: string; storage: "default" | "custom" };

export const OWNED_BROWSER_BOOKMARK_FIXTURES = [
  "ui:browser-bookmark-owned-row",
  "ui:browser-bookmark-owned-folder-choice",
  "ui:browser-bookmark-owned-create",
] as const;
export const OWNED_BROWSER_BOOKMARK_CLEANUPS = [
  "ui:delete-owned-bookmarks-restore-panel-abort-task-and-window",
] as const;
export const OWNED_BROWSER_BOOKMARK_ORACLES = [
  "ui:value-state-transition",
  "ui:choice-state-transition",
  "ui:activation:owned-bookmark-pin-state-transition",
  "ui:activation:owned-bookmark-state-transition",
  "ui:activation:owned-bookmark-order-transition",
] as const;
export const OWNED_BROWSER_TAB_FIXTURES = [
  "ui:browser-owned-tab-create",
  "ui:browser-owned-tab-row",
  "ui:browser-owned-home-navigation",
  "ui:browser-owned-history-navigation",
  "ui:browser-owned-tab-lock",
  "ui:browser-owned-tab-delegation",
] as const;
export const OWNED_BROWSER_TAB_CLEANUPS = [
  "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window",
] as const;
export const OWNED_BROWSER_TAB_ORACLES = [
  "ui:activation:owned-browser-tab-state-transition",
  "ui:activation:owned-browser-tab-focus-transition",
  "ui:activation:owned-browser-home-navigation",
  "ui:activation:owned-browser-history-navigation",
  "ui:activation:owned-browser-tab-lock-transition",
  "ui:activation:owned-browser-tab-delegation-transition",
] as const;

export function supportsOwnedBrowserBookmarkControl(assignment: Assignment): boolean {
  return kindBySurface.has(assignment.surface.name);
}

export function supportsOwnedBrowserTabControl(assignment: Assignment): boolean {
  return tabKindBySurface.has(assignment.surface.name);
}

export async function exerciseOwnedBrowserBookmarkControl(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const kind = kindBySurface.get(assignment.surface.name);
  const outcome = emptyOutcome(assignment);
  const cleanupIds = new Set<string>();
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  let baselineMode: boolean | null = null;
  try {
    if (!kind) throw new Error(`owned Bookmark driver does not support ${assignment.surface.name}`);
    await assertOwnedBookmarkNamespaceAvailable(connection);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface owned Browser bookmark ${kind} proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "Browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;

    if (kind === "drag") {
      await createBookmark(connection, {
        bookmarkId: OWNED_DRAG_FIRST_ID,
        label: "Final surface drag first",
        kind: "link",
        url: "https://shellx.invalid/final-surface-drag-first",
        toolbarPinned: false,
        toolbarOrder: 0,
      });
      cleanupIds.add(OWNED_DRAG_FIRST_ID);
      await createBookmark(connection, {
        bookmarkId: OWNED_DRAG_SECOND_ID,
        label: "Final surface drag second",
        kind: "link",
        url: "https://shellx.invalid/final-surface-drag-second",
        toolbarPinned: false,
        toolbarOrder: 1,
      });
      cleanupIds.add(OWNED_DRAG_SECOND_ID);
    } else if (["label", "url", "pin", "delete"].includes(kind)) {
      await createBookmark(connection, {
        bookmarkId: OWNED_LINK_ID,
        label: "Final surface owned link",
        kind: "link",
        url: "https://shellx.invalid/final-surface-owned-link",
        toolbarPinned: false,
      });
      cleanupIds.add(OWNED_LINK_ID);
    } else if (kind === "folder") {
      await createBookmark(connection, {
        bookmarkId: OWNED_FOLDER_ID,
        label: "Final surface owned folder",
        kind: "folder",
        toolbarPinned: false,
      });
      cleanupIds.add(OWNED_FOLDER_ID);
    }

    await openManager(webdriver);
    baselineMode = await readManageMode(webdriver);
    await setManageMode(webdriver, true);
    outcome.present = "pass";

    if (kind === "drag") {
      const source = await waitForReleaseSurfaceWebDriverElement(
        webdriver,
        `[data-debug-id='shellx-browser-bookmark-drag-${OWNED_DRAG_SECOND_ID}']`,
      );
      const target = await waitForReleaseSurfaceWebDriverElement(
        webdriver,
        `[data-debug-id='shellx-browser-bookmark-manager-row-${OWNED_DRAG_FIRST_ID}']`,
      );
      await dragReleaseSurfaceWebDriverElementToElement(webdriver, source, target);
      await waitForBookmarkOrder(connection, OWNED_DRAG_SECOND_ID, OWNED_DRAG_FIRST_ID);
      outcome.observedEffect = "Installed input used a bounded pointer drag to move the second owned bookmark before the first and persisted the exact resulting sibling order.";
    } else if (kind === "label" || kind === "url") {
      await exerciseRowText(webdriver, kind);
      outcome.observedEffect = `Installed input changed only the owned bookmark ${kind} draft before exact bookmark deletion.`;
    } else if (kind === "pin") {
      const selector = `[data-debug-id='shellx-browser-bookmark-pin-${OWNED_LINK_ID}']`;
      await clickSelector(webdriver, selector);
      await waitForBookmark(connection, (bookmark) => bookmark.bookmarkId === OWNED_LINK_ID && bookmark.toolbarPinned === true);
      outcome.observedEffect = "Installed input pinned exactly one owned synthetic bookmark before deleting it.";
    } else if (kind === "delete") {
      const selector = `[data-debug-id='shellx-browser-bookmark-delete-${OWNED_LINK_ID}']`;
      await clickSelector(webdriver, selector);
      await clickSelector(webdriver, `${selector}[aria-label^='Confirm delete ']`);
      await waitForBookmarkAbsent(connection, OWNED_LINK_ID);
      cleanupIds.delete(OWNED_LINK_ID);
      outcome.observedEffect = "Two installed input clicks confirmed deletion of exactly one owned synthetic bookmark.";
    } else if (kind === "folder") {
      const control = await waitForReleaseSurfaceWebDriverElement(webdriver, DRAFT_FOLDER);
      await setReleaseSurfaceWebDriverElementValue(webdriver, control, "Final surface owned folder");
      await waitForSelectValue(webdriver, DRAFT_FOLDER, OWNED_FOLDER_ID);
      outcome.observedEffect = "Installed input selected exactly one owned synthetic parent folder in the unsaved bookmark draft.";
    } else if (kind === "createFolder") {
      await replaceInput(webdriver, DRAFT_LABEL, CREATED_FOLDER_LABEL);
      await clickSelector(webdriver, NEW_FOLDER);
      const created = await waitForBookmark(connection, (bookmark) => (
        bookmark.kind === "folder" && bookmark.label === CREATED_FOLDER_LABEL
      ));
      cleanupIds.add(created.bookmarkId);
      outcome.observedEffect = "An installed input click created exactly one owned synthetic bookmark folder before exact deletion.";
    } else {
      await replaceInput(webdriver, DRAFT_LABEL, CREATED_LINK_LABEL);
      await replaceInput(webdriver, DRAFT_URL, CREATED_LINK_URL);
      await clickSelector(webdriver, ADD_LINK);
      const created = await waitForBookmark(connection, (bookmark) => (
        bookmark.kind === "link" && bookmark.label === CREATED_LINK_LABEL && bookmark.url === CREATED_LINK_URL
      ));
      cleanupIds.add(created.bookmarkId);
      outcome.observedEffect = "An installed input click created exactly one owned synthetic bookmark link before exact deletion.";
    }
    outcome.invoke = "pass";
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (browserWindowOpen) {
      await cleanupAttempt(cleanupErrors, async () => {
        await restoreDrafts(webdriver);
        if (baselineMode !== null) await setManageMode(webdriver, baselineMode);
      });
    }
    for (const bookmarkId of cleanupIds) {
      await cleanupAttempt(cleanupErrors, async () => deleteOwnedBookmark(connection, bookmarkId));
    }
    await cleanupAttempt(cleanupErrors, async () => assertOwnedBookmarkNamespaceAvailable(connection));
    if (browserWindowOpen) {
      await cleanupAttempt(cleanupErrors, async () => closeManager(webdriver));
    }
    if (taskId) {
      await cleanupAttempt(cleanupErrors, async () => {
        const result = await cleanupOwnedBrowserLifecycle(
          (method, path, body) => apiJson(connection, method, path, body),
          { taskIds: [taskId!], label: "final surface owned Bookmark" },
        );
        if (result.errors.length > 0) {
          throw new Error(`owned Bookmark cleanup reported: ${result.errors.join("; ")}`);
        }
      });
    }
    if (browserWindowOpen && originalWindow) {
      await cleanupAttempt(cleanupErrors, async () => {
        await closeReleaseSurfaceWebDriverWindow(webdriver);
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow!);
      });
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}cleanup: ${cleanupErrors.join("; ")}`;
  }
  return finalize(outcome);
}

export async function exerciseOwnedBrowserTabControl(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
  options: BrowserTabControlOptions = {},
): Promise<ReleaseSurfaceDriverOutcome> {
  const kind = tabKindBySurface.get(assignment.surface.name);
  const outcome = emptyTabOutcome(assignment);
  const baselineTabs = await listBrowserTabs(connection);
  const baselineActiveTabs = baselineTabs.filter((tab) => tab.active);
  const baselineIds = new Set(baselineTabs.map((tab) => tab.browserTabId));
  const baselineActiveId = baselineActiveTabs[0]?.browserTabId ?? null;
  const ownedIds = new Set<string>();
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  let baselineHome: OwnedHomepageState | null = null;
  let page: OwnedBrowserHomePage | null = null;
  let taskId: string | null = null;
  let delegatedTabId: string | null = null;
  try {
    if (!kind) throw new Error(`owned Browser tab driver does not support ${assignment.surface.name}`);
    if (baselineTabs.length > 0 && baselineActiveTabs.length !== 1) {
      throw new Error("Browser tab baseline must expose exactly one active tab before owned mutation");
    }
    if (kind === "home" || kind === "back" || kind === "forward" || kind === "reload") {
      page = await startOwnedBrowserHomePage();
    }
    const delegationKind = kind === "handoff" || kind === "takeback" || kind === "handoffCancel" || kind === "handoffConfirm";
    const seedCount = kind === "focus" || kind === "close" ? 2 : 1;
    if (delegationKind) {
      const started = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
        goal: `Final surface owned Browser tab ${kind} proof`,
        profileId: "task-disposable",
      autonomy: "assistedAutonomous",
        startUrl: "about:blank",
      });
      taskId = requiredString(started.taskId, "Browser delegation task start.taskId");
      const taskTabs = (await listBrowserTabs(connection)).filter((tab) => (
        !baselineIds.has(tab.browserTabId) && tab.taskId === taskId
      ));
      if (taskTabs.length !== 1 || taskTabs[0]!.ownerKind !== "agent") {
        throw new Error("Browser delegation task did not create exactly one agent-owned task tab");
      }
      ownedIds.add(taskTabs[0]!.browserTabId);
      const userTab = await openOwnedBrowserTab(connection, "task-disposable", "about:blank");
      if (baselineIds.has(userTab.browserTabId) || ownedIds.has(userTab.browserTabId) || userTab.ownerKind !== "user") {
        throw new Error(`owned Browser delegation tab fixture was not a unique user tab: ${userTab.browserTabId}`);
      }
      delegatedTabId = userTab.browserTabId;
      ownedIds.add(userTab.browserTabId);
      await focusBrowserTab(connection, userTab.browserTabId);
    } else {
      for (let index = 0; index < seedCount; index += 1) {
        const tab = await openOwnedBrowserTab(
          connection,
          "task-disposable",
          kind === "home"
            ? page!.startUrl
            : kind === "back" || kind === "forward" || kind === "reload"
              ? page!.firstUrl
              : "about:blank",
        );
        if (baselineIds.has(tab.browserTabId) || ownedIds.has(tab.browserTabId)) {
          throw new Error(`owned Browser tab fixture ID collision: ${tab.browserTabId}`);
        }
        ownedIds.add(tab.browserTabId);
      }
    }
    const ownedTabs = await ownedBrowserTabs(connection, ownedIds);
    const expectedOwnedCount = delegationKind ? 2 : seedCount;
    if (ownedTabs.length !== expectedOwnedCount) throw new Error("owned Browser tab fixture did not create its exact seed set");
    if (!delegationKind && seedCount === 2) await focusBrowserTab(connection, ownedTabs[0]!.browserTabId);

    const opened = await openOwnedBrowserWindow(webdriver);
    originalWindow = opened.originalHandle;
    browserWindowOpen = true;
    if (kind === "create" || kind === "createDisposable") {
      baselineHome = await prepareOwnedHomepage(webdriver, "about:blank");
      const selector = kind === "create" ? NEW_TAB : NEW_DISPOSABLE_TAB;
      const control = await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
      outcome.present = "pass";
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      outcome.invoke = "pass";
      const created = await waitForOneNewBrowserTab(connection, new Set([...baselineIds, ...ownedIds]));
      ownedIds.add(created.browserTabId);
      if (created.url !== "about:blank") throw new Error(`owned Browser tab opened unexpected URL ${created.url ?? "<missing>"}`);
      if (kind === "createDisposable" && created.profileId !== "task-disposable") {
        throw new Error(`owned disposable tab used unexpected profile ${created.profileId}`);
      }
      outcome.effect = "pass";
      outcome.observedEffect = `Installed input created exactly one owned ${kind === "createDisposable" ? "disposable " : ""}about:blank Browser tab.`;
    } else if (kind === "lock") {
      const target = ownedTabs[0]!;
      if (target.lock) throw new Error("owned Browser tab lock fixture unexpectedly started locked");
      const control = await waitForReleaseSurfaceWebDriverElement(webdriver, LOCK_TAB);
      outcome.present = "pass";
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      await waitForBrowserTabLock(connection, target.browserTabId, true);
      outcome.invoke = "pass";
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      await waitForBrowserTabLock(connection, target.browserTabId, false);
      outcome.effect = "pass";
      outcome.observedEffect = "Installed input acquired an exact UI-owned lease on one owned Browser tab, then released that lease and restored the unlocked baseline.";
    } else if (delegationKind) {
      if (!taskId || !delegatedTabId) throw new Error("owned Browser delegation fixture omitted its task or user tab");
      await exerciseOwnedBrowserTabHandoffSheet(
        connection,
        webdriver,
        { browserTabId: delegatedTabId, taskId },
        options.handoffMarkerSelector,
      );
      await takeBackOwnedBrowserTab(connection, webdriver, delegatedTabId);
      if (kind === "handoff" || kind === "handoffCancel" || kind === "handoffConfirm") {
        outcome.present = "pass";
        outcome.invoke = "pass";
        outcome.effect = "pass";
        outcome.observedEffect = kind === "handoffCancel"
          ? "Installed input opened the ShellX-owned trusted-user handoff sheet, verified its bounded review receipts, exercised Cancel and Escape with focus restoration to Handoff, then reopened and confirmed the exact owned handoff without granting Vault access."
          : kind === "handoffConfirm"
            ? "Installed input opened the ShellX-owned trusted-user handoff sheet, verified its bounded review receipts, exercised Cancel and Escape with focus restoration, then made one trusted Confirm through pending to success without granting Vault access."
            : "Installed input opened and confirmed the ShellX-owned trusted-user handoff sheet after its bounded review, Cancel-first focus, Cancel and Escape restoration, and pending-to-success receipts, then delegated one owned user tab to the exact active Browser agent task without granting Vault access.";
      } else {
        outcome.present = "pass";
        outcome.invoke = "pass";
        outcome.effect = "pass";
        outcome.observedEffect = "Installed input took one exactly delegated Browser tab back from its active agent task and restored user ownership with no delegated task binding.";
      }
    } else if (kind === "home") {
      const target = ownedTabs[0]!;
      baselineHome = await prepareOwnedHomepage(webdriver, page!.homeUrl);
      const control = await waitForReleaseSurfaceWebDriverElement(webdriver, HOME);
      outcome.present = "pass";
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForBrowserTabUrl(connection, target.browserTabId, page!.homeUrl);
      await waitForBrowserSettledUrl(connection, target.browserTabId, page!.homeUrl);
      outcome.effect = "pass";
      outcome.observedEffect = "Installed input navigated the exact owned active Browser tab and native engine to the configured loopback homepage marker.";
    } else if (kind === "back" || kind === "forward" || kind === "reload") {
      const target = ownedTabs[0]!;
      await waitForBrowserSettledUrl(connection, target.browserTabId, page!.firstUrl);
      if (kind === "back" || kind === "forward") {
        await applyOwnedBrowserAction(connection, target.browserTabId, "navigate", page!.secondUrl);
        await waitForBrowserTabUrl(connection, target.browserTabId, page!.secondUrl);
        await waitForBrowserSettledUrl(connection, target.browserTabId, page!.secondUrl);
      }
      if (kind === "forward") {
        await applyOwnedBrowserAction(connection, target.browserTabId, "goBack");
        await waitForBrowserTabUrl(connection, target.browserTabId, page!.firstUrl);
        await waitForBrowserSettledUrl(connection, target.browserTabId, page!.firstUrl);
      }
      const selector = kind === "back" ? BACK : kind === "forward" ? FORWARD : RELOAD;
      const requestBaseline = page!.requestCount("/first");
      const control = await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
      outcome.present = "pass";
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      outcome.invoke = "pass";
      const expectedUrl = kind === "back" ? page!.firstUrl : kind === "forward" ? page!.secondUrl : page!.firstUrl;
      if (kind === "reload") await waitForOwnedPageRequest(page!, "/first", requestBaseline + 1);
      await waitForBrowserTabUrl(connection, target.browserTabId, expectedUrl);
      await waitForBrowserSettledUrl(connection, target.browserTabId, expectedUrl);
      outcome.effect = "pass";
      outcome.observedEffect = kind === "reload"
        ? "Installed input reloaded the exact owned loopback page, produced a new HTTP request, and returned the active Browser tab and native engine to a settled loaded state."
        : `Installed input moved the exact owned active Browser tab and native engine ${kind} through its prepared loopback history.`;
    } else {
      const target = ownedTabs[1]!;
      const selector = kind === "focus"
        ? `[data-debug-id='shellx-browser-tab-${target.browserTabId}']`
        : `[data-debug-id='shellx-browser-close-tab-${target.browserTabId}']`;
      const control = await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
      outcome.present = "pass";
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      outcome.invoke = "pass";
      if (kind === "focus") {
        await waitForActiveBrowserTab(connection, target.browserTabId);
        outcome.observedEffect = "Installed input focused exactly one owned synthetic about:blank Browser tab.";
      } else {
        await waitForBrowserTabAbsent(connection, target.browserTabId);
        outcome.observedEffect = "Installed input closed exactly one owned synthetic about:blank Browser tab.";
      }
      outcome.effect = "pass";
    }
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (browserWindowOpen && baselineHome) {
      await cleanupAttempt(cleanupErrors, async () => restoreOwnedHomepage(webdriver, baselineHome!));
    }
    if (browserWindowOpen) {
      if (delegatedTabId) {
        await cleanupAttempt(cleanupErrors, async () => ensureOwnedBrowserTabTakenBack(connection, webdriver, delegatedTabId!));
      }
      for (const tabId of ownedIds) {
        await cleanupAttempt(cleanupErrors, async () => ensureOwnedBrowserTabUnlocked(connection, tabId));
      }
    }
    if (taskId) {
      await cleanupAttempt(cleanupErrors, async () => {
        await apiJson(connection, "POST", "/browser/task/control", {
          taskId,
          action: "abort",
          reason: "finalSurfaceOwnedBrowserDelegationCleanup",
        });
      });
    }
    for (const tabId of ownedIds) {
      await cleanupAttempt(cleanupErrors, async () => closeOwnedBrowserTab(connection, tabId));
    }
    if (baselineActiveId) {
      await cleanupAttempt(cleanupErrors, async () => focusBrowserTab(connection, baselineActiveId));
    }
    await cleanupAttempt(cleanupErrors, async () => assertExactBrowserTabIds(connection, baselineIds));
    if (browserWindowOpen && originalWindow) {
      await cleanupAttempt(cleanupErrors, async () => {
        await closeReleaseSurfaceWebDriverWindow(webdriver);
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow!);
      });
    }
    if (page) await cleanupAttempt(cleanupErrors, page.close);
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}cleanup: ${cleanupErrors.join("; ")}`;
  }
  return finalize(outcome);
}

async function openOwnedBrowserWindow(webdriver: WebDriver): Promise<{ originalHandle: string; targetHandle: string }> {
  const control = await waitForReleaseSurfaceWebDriverElement(webdriver, HEADER_BROWSER);
  await clickReleaseSurfaceWebDriverElement(webdriver, control);
  const deadline = Date.now() + 10_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("owned Browser window did not open before timeout");
}

async function prepareOwnedHomepage(
  webdriver: WebDriver,
  target: string,
): Promise<OwnedHomepageState> {
  await closeOwnedOptions(webdriver);
  await clickSelector(webdriver, OPTIONS_OWNER);
  await waitForReleaseSurfaceWebDriverElement(webdriver, OPTIONS_PANEL);
  const baseline = await readOwnedHomepage(webdriver);
  const control = await waitForReleaseSurfaceWebDriverElement(webdriver, HOME_INPUT);
  await clearReleaseSurfaceWebDriverElement(webdriver, control);
  await setReleaseSurfaceWebDriverElementValue(webdriver, control, target);
  await waitForOwnedHomepage(webdriver, { value: target, storage: homepageStorageKind(target) });
  await closeOwnedOptions(webdriver);
  return baseline;
}

async function restoreOwnedHomepage(
  webdriver: WebDriver,
  baseline: OwnedHomepageState,
): Promise<void> {
  await closeOwnedOptions(webdriver);
  await clickSelector(webdriver, OPTIONS_OWNER);
  await waitForReleaseSurfaceWebDriverElement(webdriver, OPTIONS_PANEL);
  const control = await waitForReleaseSurfaceWebDriverElement(webdriver, HOME_INPUT);
  await clearReleaseSurfaceWebDriverElement(webdriver, control);
  if (baseline.value) await setReleaseSurfaceWebDriverElementValue(webdriver, control, baseline.value);
  await waitForOwnedHomepage(webdriver, baseline);
  await closeOwnedOptions(webdriver);
}

async function closeOwnedOptions(webdriver: WebDriver): Promise<void> {
  const panel = await visibleElement(webdriver, OPTIONS_PANEL);
  if (panel) await clickSelector(webdriver, OPTIONS_OWNER);
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, OPTIONS_PANEL, { timeoutMs: 5_000, pollMs: 50 });
}

async function readOwnedHomepage(webdriver: WebDriver): Promise<OwnedHomepageState> {
  const state = await observeReleaseSurfaceWebDriverElement(webdriver, HOME_INPUT, ["value", "title"]);
  const receipt = state.title?.match(/^Browser homepage state: storage=(default|custom)$/);
  if (!state.present || !state.visible || typeof state.value !== "string" || !receipt) {
    throw new Error("owned Browser homepage state omitted its bounded input or persistence receipt");
  }
  return { value: state.value, storage: receipt[1] as OwnedHomepageState["storage"] };
}

async function waitForOwnedHomepage(
  webdriver: WebDriver,
  expected: OwnedHomepageState,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await readOwnedHomepage(webdriver);
    if (current.value === expected.value && current.storage === expected.storage) return;
    await delay(50);
  }
  throw new Error("owned Browser homepage did not reach its exact expected state");
}

function homepageStorageKind(value: string): OwnedHomepageState["storage"] {
  return value.trim() === "" || value.trim() === "https://example.com/" ? "default" : "custom";
}

async function listBrowserTabs(connection: Connection): Promise<BrowserTab[]> {
  const body = await apiJson<Record<string, unknown>>(connection, "GET", "/browser/tabs");
  if (!Array.isArray(body.tabs)) throw new Error("Browser tabs response omitted tabs");
  return body.tabs.map((value) => {
    const tab = record(value);
    return {
      browserTabId: requiredString(tab.browserTabId, "Browser tab.browserTabId"),
      taskId: typeof tab.taskId === "string" ? tab.taskId : null,
      profileId: requiredString(tab.profileId, "Browser tab.profileId"),
      url: typeof tab.url === "string" ? tab.url : null,
      active: tab.active === true,
      ownerKind: browserTabOwnerKind(tab.ownerKind),
      delegatedTaskId: typeof tab.delegatedTaskId === "string" ? tab.delegatedTaskId : null,
      delegatedGrantId: typeof tab.delegatedGrantId === "string" ? tab.delegatedGrantId : null,
      lock: parseBrowserTabLock(tab.lock),
    };
  });
}

async function openOwnedBrowserTab(
  connection: Connection,
  profileId: string,
  url = "about:blank",
): Promise<BrowserTab> {
  const body = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/tabs/open", {
    profileId,
    url,
  });
  const tab = record(body.tab);
  return {
    browserTabId: requiredString(tab.browserTabId, "Browser tab open.tab.browserTabId"),
    taskId: typeof tab.taskId === "string" ? tab.taskId : null,
    profileId: requiredString(tab.profileId, "Browser tab open.tab.profileId"),
    url: typeof tab.url === "string" ? tab.url : null,
    active: tab.active === true,
    ownerKind: browserTabOwnerKind(tab.ownerKind),
    delegatedTaskId: typeof tab.delegatedTaskId === "string" ? tab.delegatedTaskId : null,
    delegatedGrantId: typeof tab.delegatedGrantId === "string" ? tab.delegatedGrantId : null,
    lock: parseBrowserTabLock(tab.lock),
  };
}

function browserTabOwnerKind(value: unknown): BrowserTab["ownerKind"] {
  if (value === undefined || value === null || value === "user") return "user";
  if (value === "agent" || value === "delegatedToAgent") return value;
  throw new Error(`Browser tab exposed unsupported ownerKind ${JSON.stringify(value)}`);
}

function parseBrowserTabLock(value: unknown): BrowserTab["lock"] {
  if (value === null || value === undefined) return null;
  const lock = record(value);
  return {
    leaseId: requiredString(lock.leaseId, "Browser tab.lock.leaseId"),
    ownerAgentId: requiredString(lock.ownerAgentId, "Browser tab.lock.ownerAgentId"),
    ownerRunId: requiredString(lock.ownerRunId, "Browser tab.lock.ownerRunId"),
  };
}

async function focusBrowserTab(connection: Connection, browserTabId: string): Promise<void> {
  const body = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/tabs/focus", { browserTabId });
  if (body.ok !== true) throw new Error(`Browser tab ${browserTabId} could not be focused`);
  await waitForActiveBrowserTab(connection, browserTabId);
}

async function closeOwnedBrowserTab(connection: Connection, browserTabId: string): Promise<void> {
  if (!(await listBrowserTabs(connection)).some((tab) => tab.browserTabId === browserTabId)) return;
  const body = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/tabs/close", { browserTabId });
  if (body.ok !== true) throw new Error(`Browser tab ${browserTabId} could not be closed`);
  await waitForBrowserTabAbsent(connection, browserTabId);
}

async function ownedBrowserTabs(connection: Connection, ids: Set<string>): Promise<BrowserTab[]> {
  return (await listBrowserTabs(connection)).filter((tab) => ids.has(tab.browserTabId));
}

async function waitForOneNewBrowserTab(connection: Connection, knownIds: Set<string>): Promise<BrowserTab> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const created = (await listBrowserTabs(connection)).filter((tab) => !knownIds.has(tab.browserTabId));
    if (created.length === 1) return created[0]!;
    if (created.length > 1) throw new Error("native Browser tab action created more than one tab");
    await delay(50);
  }
  throw new Error("native Browser tab action did not create exactly one tab");
}

async function waitForActiveBrowserTab(connection: Connection, browserTabId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const tabs = await listBrowserTabs(connection);
    if (tabs.find((tab) => tab.browserTabId === browserTabId)?.active === true
      && tabs.filter((tab) => tab.active).length === 1) return;
    await delay(50);
  }
  throw new Error(`Browser tab ${browserTabId} did not become the unique active tab`);
}

async function waitForBrowserTabAbsent(connection: Connection, browserTabId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await listBrowserTabs(connection)).some((tab) => tab.browserTabId === browserTabId)) return;
    await delay(50);
  }
  throw new Error(`Browser tab ${browserTabId} was not deleted`);
}

async function waitForBrowserTabUrl(
  connection: Connection,
  browserTabId: string,
  expectedUrl: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const tab = (await listBrowserTabs(connection)).find((candidate) => candidate.browserTabId === browserTabId);
    if (tab?.url === expectedUrl && tab.active === true) return;
    await delay(50);
  }
  throw new Error(`Browser tab ${browserTabId} did not navigate to its exact owned homepage`);
}

async function waitForBrowserTabLock(
  connection: Connection,
  browserTabId: string,
  expectedLocked: boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const tab = (await listBrowserTabs(connection)).find((candidate) => candidate.browserTabId === browserTabId);
    if (!tab) throw new Error(`owned Browser tab ${browserTabId} disappeared during lock transition`);
    if (!expectedLocked && !tab.lock) return;
    if (
      expectedLocked
      && tab.lock?.ownerAgentId === "shellx-browser-ui"
      && tab.lock.ownerRunId === "browser-window"
      && tab.lock.leaseId.length > 0
    ) return;
    await delay(50);
  }
  throw new Error(`owned Browser tab ${browserTabId} did not reach its exact ${expectedLocked ? "UI-locked" : "unlocked"} state`);
}

async function waitForBrowserTabOwnership(
  connection: Connection,
  browserTabId: string,
  expected: Pick<BrowserTab, "ownerKind" | "taskId" | "delegatedTaskId">,
): Promise<BrowserTab> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const tab = (await listBrowserTabs(connection)).find((candidate) => candidate.browserTabId === browserTabId);
    if (!tab) throw new Error(`owned Browser tab ${browserTabId} disappeared during ownership transition`);
    if (
      tab.ownerKind === expected.ownerKind
      && (tab.taskId ?? null) === (expected.taskId ?? null)
      && (tab.delegatedTaskId ?? null) === (expected.delegatedTaskId ?? null)
    ) return tab;
    await delay(50);
  }
  throw new Error(`owned Browser tab ${browserTabId} did not reach its exact ${expected.ownerKind} ownership state`);
}

export async function exerciseOwnedBrowserTabHandoffSheet(
  connection: Connection,
  webdriver: WebDriver,
  expected: { browserTabId: string; taskId: string },
  markerSelector?: string,
): Promise<void> {
  await clickSelector(webdriver, HANDOFF_TAB);
  await verifyOwnedBrowserTabHandoffReview(webdriver, { taskId: expected.taskId }, markerSelector);

  const cancelState = await observeReleaseSurfaceWebDriverElement(webdriver, HANDOFF_CANCEL, ["focused", "disabled"]);
  if (!cancelState.present || !cancelState.visible || cancelState.focused !== true || cancelState.disabled !== false) {
    throw new Error("Browser handoff sheet did not expose an enabled Cancel initial focus target");
  }
  await clickSelector(webdriver, HANDOFF_CANCEL);
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, HANDOFF_CONFIRMATION, { timeoutMs: 5_000, pollMs: 50 });
  await assertOwnedBrowserHandoffFocusRestored(webdriver, "Cancel");

  await clickSelector(webdriver, HANDOFF_TAB);
  await verifyOwnedBrowserTabHandoffReview(webdriver, { taskId: expected.taskId }, markerSelector);
  await performReleaseSurfaceInstalledInputKeyChord(webdriver, ["\uE00C"]);
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, HANDOFF_CONFIRMATION, { timeoutMs: 5_000, pollMs: 50 });
  await assertOwnedBrowserHandoffFocusRestored(webdriver, "Escape");

  await clickSelector(webdriver, HANDOFF_TAB);
  await verifyOwnedBrowserTabHandoffReview(webdriver, { taskId: expected.taskId }, markerSelector);
  const confirm = await waitForReleaseSurfaceWebDriverElement(webdriver, HANDOFF_CONFIRM);
  await clickReleaseSurfaceWebDriverElement(webdriver, confirm);
  const delegated = await waitForBrowserTabOwnership(connection, expected.browserTabId, {
    ownerKind: "delegatedToAgent",
    taskId: expected.taskId,
    delegatedTaskId: expected.taskId,
  });
  if (delegated.delegatedGrantId) {
    throw new Error("Browser handoff unexpectedly attached a delegated Vault or session grant");
  }
  await waitForReleaseSurfaceWebDriverElement(webdriver, HANDOFF_STATUS, { timeoutMs: 5_000, pollMs: 50 });
  const statusState = await observeReleaseSurfaceWebDriverElement(webdriver, HANDOFF_STATUS, ["title"]);
  if (!statusState.present || !statusState.visible || typeof statusState.title !== "string" || !/handed off|delegated/i.test(statusState.title)) {
    throw new Error("Browser handoff did not expose a truthful bounded success status");
  }
  if (markerSelector === HANDOFF_STATUS) await waitForReleaseSurfaceWebDriverElement(webdriver, markerSelector);
  await clickSelector(webdriver, HANDOFF_CANCEL);
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, HANDOFF_CONFIRMATION, { timeoutMs: 5_000, pollMs: 50 });
}

async function assertOwnedBrowserHandoffFocusRestored(webdriver: WebDriver, action: "Cancel" | "Escape"): Promise<void> {
  const restoredFocus = await observeReleaseSurfaceWebDriverElement(webdriver, HANDOFF_TAB, ["focused"]);
  if (!restoredFocus.present || !restoredFocus.visible || restoredFocus.focused !== true) {
    throw new Error(`Browser handoff ${action} did not restore focus to its triggering Handoff control`);
  }
}

async function verifyOwnedBrowserTabHandoffReview(
  webdriver: WebDriver,
  expected: { taskId: string },
  markerSelector?: string,
): Promise<void> {
  await waitForReleaseSurfaceWebDriverElement(webdriver, HANDOFF_BACKDROP);
  await waitForReleaseSurfaceWebDriverElement(webdriver, HANDOFF_CONFIRMATION);
  await waitForReleaseSurfaceWebDriverElement(webdriver, HANDOFF_CONTEXT);
  await waitForReleaseSurfaceWebDriverElement(webdriver, HANDOFF_VAULT_NOTICE);
  await waitForReleaseSurfaceWebDriverElement(webdriver, HANDOFF_CANCEL);
  await waitForReleaseSurfaceWebDriverElement(webdriver, HANDOFF_CONFIRM);
  if (markerSelector && markerSelector !== HANDOFF_STATUS) {
    await waitForReleaseSurfaceWebDriverElement(webdriver, markerSelector);
  }
  const context = await observeReleaseSurfaceWebDriverElement(webdriver, HANDOFF_CONTEXT, ["title"]);
  if (!context.present || !context.visible || typeof context.title !== "string") {
    throw new Error("Browser handoff review omitted its bounded context receipt");
  }
  for (const fragment of [
    "Origin about context",
    "URL Local or non-web URL context is withheld",
    "(task-disposable)",
    "Persistence Disposable task storage",
    "Owner User-controlled",
    `Task ${expected.taskId}:`,
  ]) {
    if (!context.title.includes(fragment)) {
      throw new Error(`Browser handoff review context omitted ${JSON.stringify(fragment)}`);
    }
  }
  const vault = await observeReleaseSurfaceWebDriverElement(webdriver, HANDOFF_VAULT_NOTICE, ["title"]);
  const expectedVaultNotice = "Vault secrets still require a separate approval. This handoff does not grant Vault access.";
  if (!vault.present || !vault.visible || vault.title !== expectedVaultNotice) {
    throw new Error("Browser handoff review did not prove the separate Vault approval boundary");
  }
}

async function takeBackOwnedBrowserTab(
  connection: Connection,
  webdriver: WebDriver,
  browserTabId: string,
): Promise<void> {
  const takeback = await waitForReleaseSurfaceWebDriverElement(webdriver, TAKE_BACK_TAB);
  await clickReleaseSurfaceWebDriverElement(webdriver, takeback);
  await waitForBrowserTabOwnership(connection, browserTabId, {
    ownerKind: "user",
    taskId: null,
    delegatedTaskId: null,
  });
}

async function ensureOwnedBrowserTabTakenBack(
  connection: Connection,
  webdriver: WebDriver,
  browserTabId: string,
): Promise<void> {
  let tab = (await listBrowserTabs(connection)).find((candidate) => candidate.browserTabId === browserTabId);
  if (!tab) return;
  if (tab.ownerKind === "delegatedToAgent") await focusBrowserTab(connection, browserTabId);
  const sheet = await observeReleaseSurfaceWebDriverElement(webdriver, HANDOFF_CONFIRMATION, ["disabled"]);
  if (sheet.present && sheet.visible) {
    const cancel = await waitForReleaseSurfaceWebDriverElement(webdriver, HANDOFF_CANCEL);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const state = await observeReleaseSurfaceWebDriverElement(webdriver, HANDOFF_CANCEL, ["disabled"]);
      if (state.present && state.visible && state.disabled === false) {
        await clickReleaseSurfaceWebDriverElement(webdriver, cancel);
        await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, HANDOFF_CONFIRMATION, { timeoutMs: 5_000, pollMs: 50 });
        break;
      }
      await delay(25);
    }
  }
  tab = (await listBrowserTabs(connection)).find((candidate) => candidate.browserTabId === browserTabId);
  if (!tab || tab.ownerKind === "user") return;
  if (tab.ownerKind !== "delegatedToAgent" || !tab.taskId || tab.delegatedTaskId !== tab.taskId) {
    throw new Error(`owned Browser tab ${browserTabId} acquired unexpected foreign ownership`);
  }
  const takeback = await waitForReleaseSurfaceWebDriverElement(webdriver, TAKE_BACK_TAB);
  await clickReleaseSurfaceWebDriverElement(webdriver, takeback);
  await waitForBrowserTabOwnership(connection, browserTabId, {
    ownerKind: "user",
    taskId: null,
    delegatedTaskId: null,
  });
}

async function ensureOwnedBrowserTabUnlocked(
  connection: Connection,
  browserTabId: string,
): Promise<void> {
  const tab = (await listBrowserTabs(connection)).find((candidate) => candidate.browserTabId === browserTabId);
  if (!tab?.lock) return;
  if (tab.lock.ownerAgentId !== "shellx-browser-ui" || tab.lock.ownerRunId !== "browser-window") {
    throw new Error(`owned Browser tab ${browserTabId} acquired an unexpected foreign lock`);
  }
  const response = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/tabs/unlock", {
    browserTabId,
    leaseId: tab.lock.leaseId,
    ownerAgentId: tab.lock.ownerAgentId,
    ownerRunId: tab.lock.ownerRunId,
  });
  if (response.ok !== true) throw new Error(`owned Browser tab ${browserTabId} cleanup unlock failed`);
  await waitForBrowserTabLock(connection, browserTabId, false);
}

async function waitForBrowserSettledUrl(
  connection: Connection,
  browserTabId: string,
  expectedUrl: string,
): Promise<void> {
  const path = `/browser/settle?browserTabId=${encodeURIComponent(browserTabId)}&timeoutMs=30000`;
  const settled = await apiJson<Record<string, unknown>>(connection, "GET", path);
  if (
    settled.settled !== true
    || settled.browserTabId !== browserTabId
    || settled.engineUrl !== expectedUrl
    || settled.pendingUrl !== null
    || settled.engineLoadStatus !== "loaded"
  ) {
    throw new Error("Browser Home navigation did not settle the native engine on the exact owned homepage");
  }
}

async function applyOwnedBrowserAction(
  connection: Connection,
  browserTabId: string,
  action: "navigate" | "goBack",
  url?: string,
): Promise<void> {
  const response = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/action", {
    browserTabId,
    action,
    ...(url ? { url } : {}),
  });
  if (response.ok !== true || response.status !== "applied") {
    throw new Error(`owned Browser history preparation ${action} was not applied`);
  }
}

export type OwnedBrowserHomePage = {
  startUrl: string;
  firstUrl: string;
  secondUrl: string;
  homeUrl: string;
  requestCount: (path: string) => number;
  close: () => Promise<void>;
};

export async function startOwnedBrowserHomePage(options: { title?: string } = {}): Promise<OwnedBrowserHomePage> {
  const sockets = new Set<Socket>();
  const requests = new Map<string, number>();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.set(path, (requests.get(path) ?? 0) + 1);
    const defaultLabel = path === "/home"
      ? "ShellX owned Home destination"
      : path === "/second"
        ? "ShellX owned Browser history second page"
        : path === "/first"
          ? "ShellX owned Browser history first page"
          : "ShellX owned Home starting page";
    const label = options.title ?? defaultLabel;
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "close",
    });
    response.end(`<!doctype html><html><head><title>${label}</title></head><body><main>${label}</main></body></html>`);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await listenLoopback(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeLoopback(server, sockets);
    throw new Error("owned Browser Home loopback server did not publish a TCP address");
  }
  const base = `http://127.0.0.1:${address.port}`;
  return {
    startUrl: `${base}/start`,
    firstUrl: `${base}/first`,
    secondUrl: `${base}/second`,
    homeUrl: `${base}/home`,
    requestCount: (path) => requests.get(path) ?? 0,
    close: () => closeLoopback(server, sockets),
  };
}

async function waitForOwnedPageRequest(
  page: OwnedBrowserHomePage,
  path: string,
  minimum: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (page.requestCount(path) >= minimum) return;
    await delay(50);
  }
  throw new Error(`owned Browser page ${path} did not receive request ${minimum}`);
}

async function listenLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

async function closeLoopback(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function assertExactBrowserTabIds(connection: Connection, expected: Set<string>): Promise<void> {
  const actual = new Set((await listBrowserTabs(connection)).map((tab) => tab.browserTabId));
  if (actual.size !== expected.size || [...actual].some((id) => !expected.has(id))) {
    throw new Error(`Browser tab cleanup mismatch: expected ${expected.size}, found ${actual.size}`);
  }
}

async function exerciseRowText(webdriver: WebDriver, kind: "label" | "url"): Promise<void> {
  const selector = kind === "label"
    ? `[data-debug-id='shellx-browser-bookmark-label-${OWNED_LINK_ID}']`
    : `[data-debug-id='shellx-browser-bookmark-url-${OWNED_LINK_ID}']`;
  await replaceInput(webdriver, selector, kind === "label" ? "Final surface edited label" : "https://shellx.invalid/edited-draft");
}

async function openManager(webdriver: WebDriver): Promise<void> {
  await closeManager(webdriver);
  await clickSelector(webdriver, OWNER);
  await waitForReleaseSurfaceWebDriverElement(webdriver, PANEL);
}

async function closeManager(webdriver: WebDriver): Promise<void> {
  const close = await visibleElement(webdriver, CLOSE);
  if (close) await clickReleaseSurfaceWebDriverElement(webdriver, close);
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, PANEL, { timeoutMs: 5_000, pollMs: 50 });
}

async function readManageMode(webdriver: WebDriver): Promise<boolean> {
  const [list, edit] = await Promise.all([
    observeReleaseSurfaceWebDriverElement(webdriver, LIST_MODE, ["pressed"]),
    observeReleaseSurfaceWebDriverElement(webdriver, EDIT_MODE, ["pressed"]),
  ]);
  if (!list.present || !list.visible || !edit.present || !edit.visible) {
    throw new Error("Bookmark Manager mode controls were not both visible");
  }
  if (list.pressed === true && edit.pressed === false) return false;
  if (list.pressed === false && edit.pressed === true) return true;
  throw new Error("Bookmark Manager did not expose exactly one active mode");
}

async function setManageMode(webdriver: WebDriver, expected: boolean): Promise<void> {
  if (await readManageMode(webdriver) === expected) return;
  await clickSelector(webdriver, expected ? EDIT_MODE : LIST_MODE);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readManageMode(webdriver) === expected) return;
    await delay(50);
  }
  throw new Error(`Bookmark Manager did not reach ${expected ? "Edit" : "List"} mode`);
}

async function restoreDrafts(webdriver: WebDriver): Promise<void> {
  for (const selector of [DRAFT_LABEL, DRAFT_URL]) {
    const control = await visibleElement(webdriver, selector);
    if (control) {
      await clearReleaseSurfaceWebDriverElement(webdriver, control);
      await waitForInputValue(webdriver, selector, "");
    }
  }
  const folder = await visibleElement(webdriver, DRAFT_FOLDER);
  if (folder && await readSelectValue(webdriver, DRAFT_FOLDER) !== "") {
    await setReleaseSurfaceWebDriverElementValue(webdriver, folder, "Top level");
    await waitForSelectValue(webdriver, DRAFT_FOLDER, "");
  }
}

async function replaceInput(webdriver: WebDriver, selector: string, value: string): Promise<void> {
  const control = await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
  await clearReleaseSurfaceWebDriverElement(webdriver, control);
  if (value) await setReleaseSurfaceWebDriverElementValue(webdriver, control, value);
  await waitForInputValue(webdriver, selector, value);
}

async function readInputValue(webdriver: WebDriver, selector: string): Promise<string> {
  const state = await observeReleaseSurfaceWebDriverElement(webdriver, selector, ["value"]);
  if (!state.present || !state.visible || typeof state.value !== "string") {
    throw new Error(`owned bookmark input ${selector} omitted its visible value`);
  }
  return state.value;
}

async function waitForInputValue(webdriver: WebDriver, selector: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readInputValue(webdriver, selector) === expected) return;
    await delay(50);
  }
  throw new Error(`owned bookmark input ${selector} did not reach the expected value`);
}

async function readSelectValue(webdriver: WebDriver, selector: string): Promise<string> {
  const state = await observeReleaseSurfaceWebDriverElement(webdriver, selector, ["value"]);
  if (!state.present || !state.visible || typeof state.value !== "string") {
    throw new Error(`owned bookmark select ${selector} omitted its visible value`);
  }
  return state.value;
}

async function waitForSelectValue(webdriver: WebDriver, selector: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readSelectValue(webdriver, selector) === expected) return;
    await delay(50);
  }
  throw new Error(`owned bookmark select ${selector} did not reach ${expected || "Top level"}`);
}

async function assertOwnedBookmarkNamespaceAvailable(connection: Connection): Promise<void> {
  const bookmarks = await listBookmarks(connection);
  const collision = bookmarks.find((bookmark) => (
    bookmark.bookmarkId === OWNED_LINK_ID
    || bookmark.bookmarkId === OWNED_FOLDER_ID
    || bookmark.bookmarkId === OWNED_DRAG_FIRST_ID
    || bookmark.bookmarkId === OWNED_DRAG_SECOND_ID
    || bookmark.label === CREATED_FOLDER_LABEL
    || bookmark.label === CREATED_LINK_LABEL
    || bookmark.url === CREATED_LINK_URL
  ));
  if (collision) throw new Error(`owned bookmark fixture namespace collision: ${collision.bookmarkId}`);
}

async function listBookmarks(connection: Connection): Promise<Bookmark[]> {
  const body = await apiJson<Record<string, unknown>>(connection, "GET", "/browser/bookmarks");
  if (!Array.isArray(body.bookmarks)) throw new Error("Browser bookmarks response omitted bookmarks");
  return body.bookmarks as Bookmark[];
}

async function createBookmark(connection: Connection, bookmark: Bookmark): Promise<void> {
  await apiJson(connection, "POST", "/browser/bookmarks", bookmark);
  await waitForBookmark(connection, (candidate) => candidate.bookmarkId === bookmark.bookmarkId);
}

async function deleteOwnedBookmark(connection: Connection, bookmarkId: string): Promise<void> {
  if (!(await listBookmarks(connection)).some((bookmark) => bookmark.bookmarkId === bookmarkId)) return;
  await apiJson(connection, "DELETE", `/browser/bookmarks/${encodeURIComponent(bookmarkId)}`);
  await waitForBookmarkAbsent(connection, bookmarkId);
}

async function waitForBookmark(
  connection: Connection,
  predicate: (bookmark: Bookmark) => boolean,
): Promise<Bookmark> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const bookmark = (await listBookmarks(connection)).find(predicate);
    if (bookmark) return bookmark;
    await delay(50);
  }
  throw new Error("owned Browser bookmark did not reach its expected state");
}

async function waitForBookmarkAbsent(connection: Connection, bookmarkId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await listBookmarks(connection)).some((bookmark) => bookmark.bookmarkId === bookmarkId)) return;
    await delay(50);
  }
  throw new Error(`owned Browser bookmark ${bookmarkId} was not deleted`);
}

async function waitForBookmarkOrder(
  connection: Connection,
  firstBookmarkId: string,
  secondBookmarkId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const bookmarks = await listBookmarks(connection);
    const first = bookmarks.find((bookmark) => bookmark.bookmarkId === firstBookmarkId);
    const second = bookmarks.find((bookmark) => bookmark.bookmarkId === secondBookmarkId);
    if (first && second && first.parentId == null && second.parentId == null
      && first.toolbarOrder === 0 && second.toolbarOrder === 1) return;
    await delay(50);
  }
  throw new Error("owned Browser bookmark drag did not persist the exact expected sibling order");
}

async function clickSelector(webdriver: WebDriver, selector: string): Promise<void> {
  await clickReleaseSurfaceWebDriverElement(webdriver, await waitForReleaseSurfaceWebDriverElement(webdriver, selector));
}

async function visibleElement(webdriver: WebDriver, selector: string) {
  try {
    return await waitForReleaseSurfaceWebDriverElement(webdriver, selector, { timeoutMs: 250, pollMs: 50 });
  } catch {
    return null;
  }
}

async function cleanupAttempt(errors: string[], action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(errorText(error));
  }
}

async function apiJson<T>(
  connection: Connection,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers = new Headers({ Authorization: `Bearer ${connection.token}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${await response.text()}`);
  return await response.json() as T;
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
    observedEffect: "No owned Browser bookmark effect was observed.",
  };
}

function emptyTabOutcome(assignment: Assignment): ReleaseSurfaceDriverOutcome {
  return {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No owned Browser tab effect was observed.",
  };
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "owned Browser bookmark control did not satisfy every required verdict";
  }
  return outcome;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WebDriver state must be an object");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || value.includes("\0")) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
