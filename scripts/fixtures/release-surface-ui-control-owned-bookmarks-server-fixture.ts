import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const stateOut = requiredArg("--state-out");
const token = requiredArg("--token");
const sessionId = requiredArg("--session-id");
const instanceId = requiredArg("--instance-id");
const processId = Number(requiredArg("--process-id"));
const version = requiredArg("--version");
const sourceCommit = requiredArg("--source-commit");

type Bookmark = {
  bookmarkId: string;
  label: string;
  kind: "folder" | "link";
  url?: string | null;
  parentId?: string | null;
  toolbarPinned: boolean;
  toolbarOrder: number;
};
type BrowserTab = {
  browserTabId: string;
  taskId: string | null;
  profileId: string;
  url: string;
  active: boolean;
  ownerKind: "user" | "agent" | "delegatedToAgent";
  delegatedTaskId: string | null;
  delegatedGrantId: string | null;
  lock: {
    leaseId: string;
    ownerAgentId: string;
    ownerRunId: string;
  } | null;
};
type HistoryEntry = {
  historyId: string;
  taskId: string | null;
  profileId: string;
  url: string;
  title: string | null;
  visitedAtMs: number;
};
type PendingHandoff = {
  browserTabId: string;
  taskId: string;
  phase: "review" | "pending" | "success";
};
type BrowserReceipt = {
  kind: "browserHistoryCleared";
  evidence: { scope: "user" | "agent" | "all"; removed: number };
};

const bookmarks = new Map<string, Bookmark>();
const tabs = new Map<string, BrowserTab>();
const tabHistories = new Map<string, { urls: string[]; index: number }>();
let historyEntries: HistoryEntry[] = [];
const labelDrafts = new Map<string, string>();
const urlDrafts = new Map<string, string>();
const clickedSelectors: string[] = [];
const draggedSelectors: Array<{ source: string; target: string }> = [];
let taskId: string | null = null;
let taskStatus: string | null = null;
let browserWindowOpen = false;
let currentWindow = "main-window";
let disclosureOpen = false;
let manageMode = false;
let draftLabel = "";
let draftUrl = "";
let draftFolder = "";
let deleteConfirmationId: string | null = null;
let generatedIndex = 0;
let generatedTabIndex = 0;
let activeBrowserTabId: string | null = null;
let optionsOpen = false;
let homeValue = "https://example.com/";
let homeStored: string | null = null;
let pendingHandoff: PendingHandoff | null = null;
let handoffPendingObserved = false;
let focusedSelector: string | null = null;
let vaultGrantCount = 0;
let pendingHistoryClearScope: "user" | "agent" | "all" | null = null;
let historyOpen = false;
let historyScope: "user" | "agent" = "user";
let historyClearStatus: { tone: "success"; message: string } | null = null;
const historyClearReceipts: BrowserReceipt[] = [];
let openToolbarFolderId: string | null = null;

const candidate = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, {
        ok: true,
        processId,
        instanceId,
        appVersion: version,
        buildCommit: sourceCommit,
        debugApiPort: address(candidate).port,
      });
    }
    if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: "unauthorized" });
    if (request.method === "GET" && request.url === "/browser/state") {
      return json(response, 200, {
        windowOpen: browserWindowOpen,
        engine: { engineId: "fixture-owned-bookmark-engine", mounted: browserWindowOpen },
        enginePool: {
          engines: [{ engineId: "fixture-owned-bookmark-engine", mounted: browserWindowOpen }],
        },
        activeTaskId: taskStatus === "running" ? taskId : null,
        tabs: [...tabs.values()],
        tasks: taskId ? [{ taskId, status: taskStatus }] : [],
        history: historyEntries,
      });
    }
    if (request.method === "GET" && request.url?.startsWith("/browser/receipts")) {
      return json(response, 200, { receipts: historyClearReceipts });
    }
    if (request.method === "POST" && request.url === "/browser/task/start") {
      const body = await requestJson(request);
      if (body.autonomy !== "assistedAutonomous") {
        return json(response, 400, { error: "Browser fixture requires the enforced assistedAutonomous policy" });
      }
      if ([...tabs.values()].some((tab) => tab.taskId !== null)) {
        return json(response, 409, { error: "previous owned Browser task tab was not cleaned" });
      }
      taskId = `fixture-owned-bookmark-task-${Date.now()}`;
      taskStatus = "running";
      browserWindowOpen = true;
      const profileId = typeof body.profileId === "string" ? body.profileId : "task-disposable";
      const startUrl = typeof body.startUrl === "string" ? body.startUrl : "about:blank";
      createTab(profileId, startUrl, taskId, "agent");
      recordHistory(taskId, profileId, startUrl);
      return json(response, 200, { taskId, status: taskStatus });
    }
    if (request.method === "POST" && request.url === "/browser/task/control") {
      const body = await requestJson(request);
      if (body.taskId !== taskId || body.action !== "abort") return json(response, 409, { error: "owned task mismatch" });
      taskStatus = "aborted";
      return json(response, 200, { taskId, status: taskStatus });
    }
    if (request.method === "POST" && request.url === "/browser/task/finish") {
      const body = await requestJson(request);
      if (body.taskId !== taskId || body.status !== "aborted" || taskStatus === null) {
        return json(response, 409, { error: "owned task finish mismatch" });
      }
      if (!["aborted", "blocked", "completed"].includes(taskStatus)) taskStatus = "aborted";
      return json(response, 200, { taskId, status: taskStatus });
    }
    if (request.method === "GET" && request.url === "/browser/tabs") {
      return json(response, 200, { tabs: [...tabs.values()] });
    }
    if (request.method === "POST" && request.url === "/browser/tabs/open") {
      const body = await requestJson(request);
      const tab = createTab(
        typeof body.profileId === "string" ? body.profileId : "agent-work",
        typeof body.url === "string" ? body.url : "about:blank",
        typeof body.taskId === "string" ? body.taskId : null,
      );
      return json(response, 200, { ok: true, tab });
    }
    if (request.method === "POST" && request.url === "/browser/tabs/focus") {
      const body = await requestJson(request);
      const id = string(body.browserTabId);
      const tab = tabs.get(id);
      if (!tab) return json(response, 404, { ok: false, error: "unknown tab" });
      focusTab(id);
      return json(response, 200, { ok: true, tab });
    }
    if (request.method === "POST" && request.url === "/browser/tabs/close") {
      const body = await requestJson(request);
      const id = string(body.browserTabId);
      const tab = tabs.get(id);
      if (!tab) return json(response, 404, { ok: false, error: "unknown tab" });
      closeTab(id);
      return json(response, 200, { ok: true, tab: { ...tab, active: false } });
    }
    if (request.method === "POST" && request.url === "/browser/tabs/unlock") {
      const body = await requestJson(request);
      const id = string(body.browserTabId);
      const tab = tabs.get(id);
      if (!tab?.lock || tab.lock.leaseId !== body.leaseId) {
        return json(response, 409, { ok: false, error: "owned lock mismatch" });
      }
      tab.lock = null;
      return json(response, 200, { ok: true, tab });
    }
    if (request.method === "POST" && request.url === "/browser/action") {
      const body = await requestJson(request);
      const id = typeof body.browserTabId === "string"
        ? body.browserTabId
        : [...tabs.values()].find((tab) => tab.taskId === body.taskId)?.browserTabId ?? "";
      const action = string(body.action);
      if (!tabs.has(id)) return json(response, 404, { ok: false, error: "unknown tab" });
      if (action === "bookmarkCurrent") {
        const tab = tabs.get(id)!;
        const url = typeof body.url === "string" && body.url ? body.url : tab.url;
        const bookmark = bookmarkFromBody({
          label: typeof body.value === "string" && body.value ? body.value : url,
          kind: "link",
          url,
          toolbarPinned: false,
        });
        bookmarks.set(bookmark.bookmarkId, bookmark);
      } else if (action === "navigate") {
        const url = string(body.url);
        navigateTab(id, url);
        const tab = tabs.get(id)!;
        recordHistory(tab.taskId, tab.profileId, url);
      }
      else if (action === "goBack") moveTabHistory(id, -1);
      else return json(response, 400, { ok: false, error: "unsupported fixture Browser action" });
      return json(response, 200, { ok: true, status: "applied", currentUrl: tabs.get(id)?.url ?? null });
    }
    if (request.method === "GET" && request.url?.startsWith("/browser/settle?")) {
      const url = new URL(request.url, "http://127.0.0.1");
      const id = url.searchParams.get("browserTabId") ?? "";
      const tab = tabs.get(id);
      if (!tab) return json(response, 404, { error: "unknown tab" });
      return json(response, 200, {
        settled: true,
        browserTabId: id,
        engineUrl: tab.url,
        pendingUrl: null,
        engineLoadStatus: "loaded",
      });
    }
    if (request.method === "GET" && request.url === "/browser/bookmarks") {
      return json(response, 200, { bookmarks: [...bookmarks.values()] });
    }
    if (request.method === "POST" && request.url === "/browser/bookmarks") {
      const body = await requestJson(request);
      const bookmark = bookmarkFromBody(body);
      bookmarks.set(bookmark.bookmarkId, bookmark);
      return json(response, 200, { bookmark });
    }
    if (request.method === "POST" && request.url === "/browser/bookmarks/reorder") {
      const body = await requestJson(request);
      const items = Array.isArray(body.items) ? body.items : [];
      for (const raw of items) {
        const item = record(raw);
        const id = string(item.bookmarkId);
        const bookmark = bookmarks.get(id);
        if (!bookmark) return json(response, 404, { error: "unknown bookmark" });
        if (typeof item.toolbarPinned === "boolean") bookmark.toolbarPinned = item.toolbarPinned;
        if (item.parentId === null || typeof item.parentId === "string") bookmark.parentId = item.parentId;
        if (typeof item.toolbarOrder === "number" && Number.isSafeInteger(item.toolbarOrder) && item.toolbarOrder >= 0) {
          bookmark.toolbarOrder = item.toolbarOrder;
        }
      }
      return json(response, 200, { ok: true });
    }
    if (request.method === "DELETE" && request.url?.startsWith("/browser/bookmarks/")) {
      const id = decodeURIComponent(request.url.slice("/browser/bookmarks/".length));
      if (!bookmarks.delete(id)) return json(response, 404, { error: "unknown bookmark" });
      if (openToolbarFolderId === id) openToolbarFolderId = null;
      labelDrafts.delete(id);
      urlDrafts.delete(id);
      if (deleteConfirmationId === id) deleteConfirmationId = null;
      return json(response, 200, { bookmarkId: id, deleted: true });
    }
    if (request.method === "GET" && request.url === "/audit") {
      return json(response, 200, {
        bookmarks: [...bookmarks.values()],
        historyEntries,
        historyOpen,
        historyScope,
        pendingHistoryClearScope,
        historyClearStatus,
        historyClearReceipts,
        openToolbarFolderId,
        labelDrafts: Object.fromEntries(labelDrafts),
        urlDrafts: Object.fromEntries(urlDrafts),
        taskId,
        taskStatus,
        browserWindowOpen,
        currentWindow,
        disclosureOpen,
        manageMode,
        draftLabel,
        draftUrl,
        draftFolder,
        deleteConfirmationId,
        tabs: [...tabs.values()],
        activeBrowserTabId,
        optionsOpen,
        homeValue,
        homeStored,
        pendingHandoff,
        focusedSelector,
        vaultGrantCount,
        clickedSelectors,
        draggedSelectors,
      });
    }
    return json(response, 404, { error: "not found" });
  } catch (error) {
    return json(response, 500, { error: errorText(error) });
  }
});

const webdriver = createServer(async (request, response) => {
  try {
    const path = request.url ?? "";
    const prefix = `/session/${encodeURIComponent(sessionId)}`;
    if (!path.startsWith(prefix)) return webdriverError(response, 404, "invalid session id", "unknown fixture session");
    if (request.method === "GET" && path === `${prefix}/window`) return webdriverValue(response, currentWindow);
    if (request.method === "GET" && path === `${prefix}/window/handles`) {
      return webdriverValue(response, browserWindowOpen ? ["main-window", "browser-window"] : ["main-window"]);
    }
    if (request.method === "POST" && path === `${prefix}/window`) {
      const body = await requestJson(request);
      if (body.handle !== "main-window" && (body.handle !== "browser-window" || !browserWindowOpen)) {
        return webdriverError(response, 404, "no such window", "unknown fixture window");
      }
      currentWindow = String(body.handle);
      return webdriverValue(response, null);
    }
    if (request.method === "GET" && path === `${prefix}/title`) {
      return webdriverValue(response, currentWindow === "browser-window" ? "ShellX Browser" : "shellX");
    }
    if (request.method === "DELETE" && path === `${prefix}/window`) {
      if (currentWindow !== "browser-window") return webdriverError(response, 400, "invalid argument", "main window is not disposable");
      browserWindowOpen = false;
      currentWindow = "main-window";
      disclosureOpen = false;
      optionsOpen = false;
      historyOpen = false;
      openToolbarFolderId = null;
      pendingHandoff = null;
      focusedSelector = null;
      return webdriverValue(response, ["main-window"]);
    }
    if (request.method === "POST" && path === `${prefix}/execute/sync`) {
      const body = await requestJson(request);
      const script = typeof body.script === "string" ? body.script : "";
      const scriptArgs = Array.isArray(body.args) ? body.args : [];
      if (script.includes('internals.invoke("plugin:window|close", { label })')) {
        if (currentWindow !== "browser-window" || !browserWindowOpen) return webdriverValue(response, false);
        browserWindowOpen = false;
        currentWindow = "main-window";
        disclosureOpen = false;
        optionsOpen = false;
        historyOpen = false;
        openToolbarFolderId = null;
        pendingHandoff = null;
        focusedSelector = null;
        return webdriverValue(response, true);
      }
      if (script.includes("__shellxReleaseHandoffPendingObserver?.disconnect()") && script.includes("MutationObserver")) {
        handoffPendingObserved = pendingHandoff?.phase === "pending";
        return webdriverValue(response, true);
      }
      if (script.includes("return globalThis.__shellxReleaseHandoffPendingObserved === true")) {
        return webdriverValue(response, handoffPendingObserved || pendingHandoff?.phase === "pending");
      }
      if (script.includes("SHELLX_BOUNDED_ELEMENT_OBSERVATION")
        && typeof scriptArgs[0] === "string"
        && Array.isArray(scriptArgs[1])) {
        const selector = scriptArgs[0];
        const fields = scriptArgs[1];
        const handoffObservation = observedHandoffElement(selector, fields);
        if (handoffObservation) return webdriverValue(response, handoffObservation);
        if (fields.includes("value") && (isInput(selector) || selector === draftFolderSelector())) {
          const observation: Record<string, unknown> = {
            value: selector === draftFolderSelector() ? draftFolder : inputValue(selector),
          };
          if (selector === homeInputSelector() && fields.includes("title")) {
            observation.title = `Browser homepage state: storage=${homeStored === null ? "default" : "custom"}`;
          }
          return webdriverValue(response, {
            present: displayed(selector),
            visible: displayed(selector),
            observation,
          });
        }
        if (fields.includes("pressed") && (selector === listModeSelector() || selector === editModeSelector())) {
          return webdriverValue(response, {
            present: displayed(selector),
            visible: displayed(selector),
            observation: { pressed: selector === editModeSelector() ? manageMode : !manageMode },
          });
        }
        if (fields.includes("pressed") && (selector === historyUserSelector() || selector === historyAgentSelector())) {
          return webdriverValue(response, {
            present: true,
            visible: true,
            observation: {
              pressed: selector === historyUserSelector()
                ? historyScope === "user"
                : historyScope === "agent",
            },
          });
        }
      }
      return webdriverError(response, 400, "javascript error", "unsupported fixture script");
    }
    if (request.method === "POST" && path === `${prefix}/actions`) {
      const body = await requestJson(request);
      if (isHandoffEscape(body)) handleHandoffEscape();
      else handlePointerDragActions(body);
      return webdriverValue(response, null);
    }
    if (request.method === "DELETE" && path === `${prefix}/actions`) {
      return webdriverValue(response, null);
    }
    if (request.method === "POST" && path === `${prefix}/element`) {
      const body = await requestJson(request);
      const selector = typeof body.value === "string" ? body.value : "";
      return displayed(selector)
        ? webdriverValue(response, element(selector))
        : webdriverError(response, 404, "no such element", `fixture does not expose ${selector}`);
    }
    const displayedMatch = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/displayed$`));
    if (request.method === "GET" && displayedMatch) {
      return webdriverValue(response, displayed(elementSelector(displayedMatch[1]!)));
    }
    const clearMatch = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/clear$`));
    if (request.method === "POST" && clearMatch) {
      const selector = elementSelector(clearMatch[1]!);
      if (!displayed(selector) || !isInput(selector)) return webdriverError(response, 400, "invalid element state", "not clearable");
      setInputValue(selector, "");
      return webdriverValue(response, null);
    }
    const valueMatch = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/value$`));
    if (request.method === "POST" && valueMatch) {
      const selector = elementSelector(valueMatch[1]!);
      if (!displayed(selector)) return webdriverError(response, 404, "stale element reference", "not writable");
      const body = await requestJson(request);
      if (typeof body.text !== "string") return webdriverError(response, 400, "invalid argument", "text is required");
      if (isInput(selector)) setInputValue(selector, inputValue(selector) + body.text);
      else if (selector === draftFolderSelector()) {
        if (body.text === "Top level") draftFolder = "";
        else {
          const folder = [...bookmarks.values()].find((bookmark) => bookmark.kind === "folder" && bookmark.label === body.text);
          if (!folder) return webdriverError(response, 400, "invalid argument", "unknown folder option");
          draftFolder = folder.bookmarkId;
        }
      } else return webdriverError(response, 400, "invalid argument", "not writable");
      return webdriverValue(response, null);
    }
    const clickMatch = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/click$`));
    if (request.method === "POST" && clickMatch) {
      const selector = elementSelector(clickMatch[1]!);
      if (!displayed(selector)) return webdriverError(response, 404, "stale element reference", "not clickable");
      handleClick(selector);
      clickedSelectors.push(selector);
      return webdriverValue(response, null);
    }
    return webdriverError(response, 404, "unknown command", `${request.method} ${path}`);
  } catch (error) {
    return webdriverError(response, 500, "unknown error", errorText(error));
  }
});

function displayed(selector: string): boolean {
  if (currentWindow === "main-window") return selector === headerBrowserSelector();
  if (currentWindow !== "browser-window") return false;
  if (pendingHandoff) {
    return selector === handoffConfirmationSelector()
      || selector === handoffBackdropSelector()
      || selector === handoffContextSelector()
      || selector === handoffVaultNoticeSelector()
      || selector === handoffConfirmSelector()
      || selector === handoffCancelSelector()
      || (pendingHandoff.phase === "success" && selector === handoffStatusSelector());
  }
  if (pendingHistoryClearScope) {
    return selector === historyClearConfirmationSelector()
      || selector === historyClearConfirmSelector()
      || selector === historyClearCancelSelector();
  }
  if (
    selector === newTabSelector()
    || selector === newDisposableTabSelector()
    || selector === homeSelector()
    || selector === backSelector()
    || selector === forwardSelector()
    || selector === reloadSelector()
    || selector === lockTabSelector()
    || selector === optionsOwnerSelector()
    || selector === bookmarkCurrentSelector()
  ) return true;
  if (selector === handoffTabSelector()) {
    const tab = activeBrowserTabId ? tabs.get(activeBrowserTabId) : null;
    return taskStatus === "running" && Boolean(taskId) && tab?.ownerKind === "user";
  }
  if (selector === takeBackTabSelector()) {
    const tab = activeBrowserTabId ? tabs.get(activeBrowserTabId) : null;
    return tab?.ownerKind === "delegatedToAgent";
  }
  if (selector === optionsPanelSelector() || selector === homeInputSelector()) return optionsOpen;
  if (selector === historyOwnerSelector()) return true;
  if (selector === historyPanelSelector() || selector === historyUserSelector() || selector === historyAgentSelector()) {
    return historyOpen;
  }
  if (selector === historyClearStatusSelector()) return historyOpen && historyClearStatus !== null;
  if (selector === clearHistorySelector()) return historyOpen && historyEntries.some((entry) => (
    historyScope === "agent" ? !isUserHistoryEntry(entry) : isUserHistoryEntry(entry)
  ));
  if (selector === clearAllHistorySelector()) return historyOpen && historyEntries.length > 0;
  const historyEntry = dynamicHistorySelector(selector);
  if (historyEntry) {
    return historyOpen && historyEntries.some((entry) => (
      entry.historyId === historyEntry && (historyScope === "agent" ? !isUserHistoryEntry(entry) : isUserHistoryEntry(entry))
    ));
  }
  const toolbar = dynamicToolbarSelector(selector);
  if (toolbar?.kind === "folder") return bookmarks.get(toolbar.id)?.kind === "folder" && bookmarks.get(toolbar.id)?.toolbarPinned === true;
  if (toolbar?.kind === "link") return bookmarks.get(toolbar.id)?.kind === "link" && bookmarks.get(toolbar.id)?.toolbarPinned === true;
  if (toolbar?.kind === "child") return bookmarks.get(toolbar.id)?.parentId === openToolbarFolderId;
  const bookmarkNavigation = dynamicBookmarkNavigationSelector(selector);
  if (bookmarkNavigation?.kind === "list") return disclosureOpen && !manageMode && bookmarks.get(bookmarkNavigation.id)?.kind === "link";
  if (bookmarkNavigation?.kind === "manager") return disclosureOpen && manageMode && bookmarks.get(bookmarkNavigation.id)?.kind === "link";
  const tab = dynamicTabSelector(selector);
  if (tab) return tabs.has(tab.id);
  if (selector === ownerSelector()) return true;
  if (selector === panelSelector()) return disclosureOpen;
  if (selector === closeSelector()) return disclosureOpen;
  if (selector === listModeSelector() || selector === editModeSelector()) return disclosureOpen;
  if (!disclosureOpen || !manageMode) return false;
  if ([draftLabelSelector(), draftUrlSelector(), draftFolderSelector(), newFolderSelector(), addLinkSelector()].includes(selector)) return true;
  const row = dynamicRowSelector(selector);
  const drag = dynamicBookmarkDragSelector(selector);
  if (drag) return bookmarks.has(drag);
  const managerRow = dynamicBookmarkManagerRowSelector(selector);
  if (managerRow) return bookmarks.has(managerRow);
  if (!row || !bookmarks.has(row.id)) return false;
  if (row.kind === "url" && bookmarks.get(row.id)?.kind !== "link") return false;
  if (row.kind === "delete-confirm") return deleteConfirmationId === row.id;
  return true;
}

function observedHandoffElement(
  selector: string,
  fields: unknown[],
): { present: boolean; visible: boolean; observation: Record<string, unknown> } | null {
  const handoffSelector = [
    handoffTabSelector(),
    handoffConfirmationSelector(),
    handoffBackdropSelector(),
    handoffContextSelector(),
    handoffVaultNoticeSelector(),
    handoffStatusSelector(),
    handoffCancelSelector(),
    handoffConfirmSelector(),
  ].includes(selector);
  if (!handoffSelector) return null;
  const observation: Record<string, unknown> = {};
  if (fields.includes("focused")) observation.focused = focusedSelector === selector;
  if (fields.includes("disabled")) {
    if (selector === handoffConfirmSelector()) observation.disabled = pendingHandoff?.phase === "pending";
    else if (selector === handoffCancelSelector()) observation.disabled = pendingHandoff?.phase === "pending";
    else observation.disabled = false;
  }
  if (fields.includes("title")) {
    if (selector === handoffContextSelector() && pendingHandoff) {
      observation.title = handoffContextTitle(pendingHandoff);
    } else if (selector === handoffVaultNoticeSelector()) {
      observation.title = "Vault secrets still require a separate approval. This handoff does not grant Vault access.";
    } else if (selector === handoffStatusSelector() && pendingHandoff?.phase === "success") {
      observation.title = "Tab handed off to the active Browser agent task.";
    }
  }
  return {
    present: displayed(selector),
    visible: displayed(selector),
    observation,
  };
}

function handoffContextTitle(handoff: PendingHandoff): string {
  const value = [
    "Origin about context",
    "URL Local or non-web URL context is withheld",
    "Profile Task disposable (task-disposable)",
    "Persistence Disposable task storage",
    "Owner User-controlled",
    `Task ${handoff.taskId}: Final surface owned Browser tab handoff proof`,
  ].join("; ");
  return value.length > 240 ? `${value.slice(0, 239)}…` : value;
}

function isHandoffEscape(body: Record<string, unknown>): boolean {
  const sources = Array.isArray(body.actions) ? body.actions : [];
  if (sources.length !== 1) return false;
  const source = record(sources[0]);
  const actions = Array.isArray(source.actions) ? source.actions.map(record) : [];
  return source.type === "key"
    && source.id === "shellx-release-keyboard"
    && actions.length === 2
    && actions[0]?.type === "keyDown" && actions[0]?.value === "\uE00C"
    && actions[1]?.type === "keyUp" && actions[1]?.value === "\uE00C";
}

function handleHandoffEscape(): void {
  if (!pendingHandoff || pendingHandoff.phase === "pending") {
    throw new Error("fixture Browser handoff Escape requires a cancellable review state");
  }
  pendingHandoff = null;
  focusedSelector = handoffTabSelector();
}

function completeHandoff(): void {
  if (!pendingHandoff || pendingHandoff.phase !== "pending") return;
  const tab = tabs.get(pendingHandoff.browserTabId);
  if (!tab || taskId !== pendingHandoff.taskId || taskStatus !== "running" || tab.ownerKind !== "user") return;
  tab.ownerKind = "delegatedToAgent";
  tab.taskId = pendingHandoff.taskId;
  tab.delegatedTaskId = pendingHandoff.taskId;
  tab.delegatedGrantId = null;
  pendingHandoff.phase = "success";
}

function handleClick(selector: string): void {
  if (selector === headerBrowserSelector()) {
    browserWindowOpen = true;
  } else if (selector === optionsOwnerSelector()) {
    optionsOpen = !optionsOpen;
    disclosureOpen = false;
    historyOpen = false;
  } else if (selector === historyOwnerSelector()) {
    historyOpen = !historyOpen;
    disclosureOpen = false;
    optionsOpen = false;
  } else if (selector === bookmarkCurrentSelector()) {
    if (!activeBrowserTabId) throw new Error("fixture bookmark-current action requires an active Browser tab");
    const tab = tabs.get(activeBrowserTabId)!;
    const bookmark = bookmarkFromBody({ label: tab.url, kind: "link", url: tab.url, toolbarPinned: false });
    bookmarks.set(bookmark.bookmarkId, bookmark);
  } else if (selector === historyUserSelector()) {
    historyScope = "user";
  } else if (selector === historyAgentSelector()) {
    historyScope = "agent";
  } else if (selector === clearHistorySelector()) {
    if (!historyEntries.some((entry) => historyScope === "agent" ? !isUserHistoryEntry(entry) : isUserHistoryEntry(entry))) {
      throw new Error("fixture scoped Clear history action requires matching owned history");
    }
    pendingHistoryClearScope = historyScope;
  } else if (selector === clearAllHistorySelector()) {
    if (historyEntries.length === 0) throw new Error("fixture Clear all history action requires owned history");
    pendingHistoryClearScope = "all";
  } else if (selector === historyClearConfirmSelector()) {
    if (!pendingHistoryClearScope) throw new Error("fixture History clear confirmation requires a pending scope");
    const scope = pendingHistoryClearScope;
    const removed = historyEntries.filter((entry) => scope === "all" || (scope === "user") === isUserHistoryEntry(entry)).length;
    historyEntries = historyEntries.filter((entry) => scope !== "all" && (scope === "user") !== isUserHistoryEntry(entry));
    historyClearReceipts.unshift({ kind: "browserHistoryCleared", evidence: { scope, removed } });
    historyClearStatus = {
      tone: "success",
      message: `Cleared ${scope === "all" ? `${removed} Browser history` : `${removed} ${scope === "user" ? "User" : "Agent"} history`} ${removed === 1 ? "entry" : "entries"}.`,
    };
    pendingHistoryClearScope = null;
  } else if (selector === historyClearCancelSelector()) {
    pendingHistoryClearScope = null;
  } else if (dynamicHistorySelector(selector)) {
    const entry = historyEntries.find((candidate) => candidate.historyId === dynamicHistorySelector(selector));
    if (!entry || !activeBrowserTabId) throw new Error("fixture history entry action requires an active owned tab");
    navigateTab(activeBrowserTabId, entry.url);
    const tab = tabs.get(activeBrowserTabId)!;
    recordHistory(tab.taskId, tab.profileId, entry.url);
    historyOpen = false;
  } else if (dynamicToolbarSelector(selector)?.kind === "folder") {
    const folderId = dynamicToolbarSelector(selector)!.id;
    openToolbarFolderId = openToolbarFolderId === folderId ? null : folderId;
  } else if (dynamicToolbarSelector(selector)?.kind === "link" || dynamicToolbarSelector(selector)?.kind === "child") {
    const bookmarkId = dynamicToolbarSelector(selector)!.id;
    const bookmark = bookmarks.get(bookmarkId);
    if (!bookmark?.url || !activeBrowserTabId) throw new Error("fixture toolbar bookmark action requires an owned URL and tab");
    navigateTab(activeBrowserTabId, bookmark.url);
    recordHistory(tabs.get(activeBrowserTabId)!.taskId, tabs.get(activeBrowserTabId)!.profileId, bookmark.url);
    openToolbarFolderId = null;
  } else if (dynamicBookmarkNavigationSelector(selector)) {
    const target = dynamicBookmarkNavigationSelector(selector)!;
    const bookmark = bookmarks.get(target.id);
    if (!bookmark?.url || !activeBrowserTabId) throw new Error("fixture bookmark-list action requires an owned URL and tab");
    navigateTab(activeBrowserTabId, bookmark.url);
    recordHistory(tabs.get(activeBrowserTabId)!.taskId, tabs.get(activeBrowserTabId)!.profileId, bookmark.url);
    disclosureOpen = false;
  } else if (selector === newTabSelector()) {
    createTab("personal", homeValue.trim() || "https://example.com/", null);
  } else if (selector === newDisposableTabSelector()) {
    createTab("task-disposable", homeValue.trim() || "https://example.com/", null);
  } else if (selector === homeSelector()) {
    if (!activeBrowserTabId) throw new Error("fixture Home action requires an active Browser tab");
    navigateTab(activeBrowserTabId, homeValue.trim() || "https://example.com/");
  } else if (selector === backSelector()) {
    if (!activeBrowserTabId) throw new Error("fixture Back action requires an active Browser tab");
    moveTabHistory(activeBrowserTabId, -1);
  } else if (selector === forwardSelector()) {
    if (!activeBrowserTabId) throw new Error("fixture Forward action requires an active Browser tab");
    moveTabHistory(activeBrowserTabId, 1);
  } else if (selector === reloadSelector()) {
    if (!activeBrowserTabId) throw new Error("fixture Reload action requires an active Browser tab");
    const tab = tabs.get(activeBrowserTabId);
    if (!tab) throw new Error("fixture Reload action active Browser tab is missing");
    void fetch(tab.url, { headers: { Connection: "close" } }).catch(() => { /* owned driver detects missing request */ });
  } else if (selector === lockTabSelector()) {
    if (!activeBrowserTabId) throw new Error("fixture Lock action requires an active Browser tab");
    const tab = tabs.get(activeBrowserTabId);
    if (!tab) throw new Error("fixture Lock action active Browser tab is missing");
    tab.lock = tab.lock
      ? null
      : {
          leaseId: `fixture-ui-browser-lease-${activeBrowserTabId}`,
          ownerAgentId: "shellx-browser-ui",
          ownerRunId: "browser-window",
        };
  } else if (selector === handoffTabSelector()) {
    if (!activeBrowserTabId || !taskId || taskStatus !== "running") {
      throw new Error("fixture Handoff action requires an active user tab and Browser task");
    }
    const tab = tabs.get(activeBrowserTabId);
    if (!tab || tab.ownerKind !== "user") throw new Error("fixture Handoff action requires user ownership");
    pendingHandoff = { browserTabId: activeBrowserTabId, taskId, phase: "review" };
    focusedSelector = handoffCancelSelector();
  } else if (selector === handoffConfirmSelector()) {
    if (!pendingHandoff) throw new Error("fixture Browser handoff confirmation requires a pending handoff");
    if (pendingHandoff.phase !== "review") throw new Error("fixture Browser handoff confirmation is not ready for a trusted confirmation");
    const tab = tabs.get(pendingHandoff.browserTabId);
    if (!tab || taskId !== pendingHandoff.taskId || taskStatus !== "running" || tab.ownerKind !== "user") {
      throw new Error("fixture Browser handoff confirmation lost its active user tab or task");
    }
    pendingHandoff.phase = "pending";
    handoffPendingObserved = true;
    setTimeout(() => completeHandoff(), 75);
  } else if (selector === handoffCancelSelector()) {
    if (pendingHandoff?.phase === "pending") {
      throw new Error("fixture Browser handoff cannot cancel while its trusted confirmation is pending");
    }
    pendingHandoff = null;
    focusedSelector = handoffTabSelector();
  } else if (selector === takeBackTabSelector()) {
    if (!activeBrowserTabId) throw new Error("fixture Take back action requires an active Browser tab");
    const tab = tabs.get(activeBrowserTabId);
    if (!tab || tab.ownerKind !== "delegatedToAgent") throw new Error("fixture Take back action requires delegated ownership");
    tab.ownerKind = "user";
    tab.taskId = null;
    tab.delegatedTaskId = null;
    tab.lock = null;
  } else if (dynamicTabSelector(selector)?.kind === "focus") {
    focusTab(dynamicTabSelector(selector)!.id);
  } else if (dynamicTabSelector(selector)?.kind === "close") {
    closeTab(dynamicTabSelector(selector)!.id);
  } else if (selector === ownerSelector()) {
    disclosureOpen = !disclosureOpen;
    historyOpen = false;
  }
  else if (selector === closeSelector()) disclosureOpen = false;
  else if (selector === listModeSelector()) manageMode = false;
  else if (selector === editModeSelector()) manageMode = true;
  else if (selector === newFolderSelector()) {
    const id = `fixture-ui-created-folder-${++generatedIndex}`;
    bookmarks.set(id, { bookmarkId: id, label: draftLabel.trim() || "New folder", kind: "folder", parentId: draftFolder || null, toolbarPinned: false, toolbarOrder: bookmarks.size });
    draftLabel = "";
    deleteConfirmationId = null;
  } else if (selector === addLinkSelector()) {
    if (!draftUrl.trim()) throw new Error("fixture Add link requires a URL");
    const id = `fixture-ui-created-link-${++generatedIndex}`;
    bookmarks.set(id, { bookmarkId: id, label: draftLabel.trim() || draftUrl, kind: "link", url: draftUrl, parentId: draftFolder || null, toolbarPinned: false, toolbarOrder: bookmarks.size });
    draftLabel = "";
    draftUrl = "";
    draftFolder = "";
    deleteConfirmationId = null;
  } else {
    const row = dynamicRowSelector(selector);
    if (!row) throw new Error(`unsupported fixture click ${selector}`);
    const bookmark = bookmarks.get(row.id);
    if (!bookmark) throw new Error("unknown fixture bookmark");
    if (row.kind === "pin") bookmark.toolbarPinned = !bookmark.toolbarPinned;
    else if (row.kind === "delete") deleteConfirmationId = row.id;
    else if (row.kind === "delete-confirm") {
      bookmarks.delete(row.id);
      labelDrafts.delete(row.id);
      urlDrafts.delete(row.id);
      deleteConfirmationId = null;
    } else throw new Error(`unsupported bookmark row action ${row.kind}`);
  }
}

function handlePointerDragActions(body: Record<string, unknown>): void {
  const sources = Array.isArray(body.actions) ? body.actions : [];
  if (sources.length !== 1) throw new Error("fixture drag requires exactly one pointer source");
  const pointer = record(sources[0]);
  if (pointer.type !== "pointer" || pointer.id !== "shellx-release-pointer-drag") {
    throw new Error("fixture drag requires the bounded release pointer identity");
  }
  const actions = Array.isArray(pointer.actions) ? pointer.actions.map(record) : [];
  if (actions.length !== 6
    || actions[0]?.type !== "pointerMove"
    || actions[1]?.type !== "pointerDown" || actions[1]?.button !== 0
    || actions[2]?.type !== "pause" || actions[2]?.duration !== 120
    || actions[3]?.type !== "pointerMove"
    || actions[4]?.type !== "pause" || actions[4]?.duration !== 80
    || actions[5]?.type !== "pointerUp" || actions[5]?.button !== 0) {
    throw new Error("fixture drag received an unbounded pointer action chain");
  }
  const sourceSelector = originSelector(actions[0]!.origin);
  const targetSelector = originSelector(actions[3]!.origin);
  const sourceId = dynamicBookmarkDragSelector(sourceSelector);
  const targetId = dynamicBookmarkManagerRowSelector(targetSelector);
  const source = sourceId ? bookmarks.get(sourceId) : null;
  const target = targetId ? bookmarks.get(targetId) : null;
  if (!source || !target || source.bookmarkId === target.bookmarkId) {
    throw new Error("fixture drag source or target is not an exact owned bookmark row");
  }
  const parentId = target.parentId ?? null;
  const ordered = [...bookmarks.values()]
    .filter((bookmark) => (bookmark.parentId ?? null) === parentId && bookmark.bookmarkId !== source.bookmarkId)
    .sort((left, right) => left.toolbarOrder - right.toolbarOrder || left.bookmarkId.localeCompare(right.bookmarkId));
  const targetIndex = ordered.findIndex((bookmark) => bookmark.bookmarkId === target.bookmarkId);
  if (targetIndex < 0) throw new Error("fixture drag target disappeared from its sibling order");
  ordered.splice(targetIndex, 0, source);
  ordered.forEach((bookmark, index) => {
    bookmark.parentId = parentId;
    bookmark.toolbarPinned = parentId ? false : bookmark.toolbarPinned;
    bookmark.toolbarOrder = index;
  });
  draggedSelectors.push({ source: sourceSelector, target: targetSelector });
}

function originSelector(value: unknown): string {
  const origin = record(value);
  const id = origin["element-6066-11e4-a52e-4f735466cecf"];
  if (typeof id !== "string") throw new Error("fixture drag origin omitted its W3C element identity");
  return elementSelector(id);
}

function isInput(selector: string): boolean {
  return selector === homeInputSelector() || selector === draftLabelSelector() || selector === draftUrlSelector()
    || dynamicRowSelector(selector)?.kind === "label" || dynamicRowSelector(selector)?.kind === "url";
}

function inputValue(selector: string): string {
  if (selector === homeInputSelector()) return homeValue;
  if (selector === draftLabelSelector()) return draftLabel;
  if (selector === draftUrlSelector()) return draftUrl;
  const row = dynamicRowSelector(selector);
  if (!row) throw new Error(`unknown fixture input ${selector}`);
  const bookmark = bookmarks.get(row.id);
  if (!bookmark) throw new Error("unknown fixture bookmark input");
  if (row.kind === "label") return labelDrafts.get(row.id) ?? bookmark.label;
  if (row.kind === "url") return urlDrafts.get(row.id) ?? bookmark.url ?? "";
  throw new Error(`fixture row ${row.kind} is not an input`);
}

function setInputValue(selector: string, value: string): void {
  if (selector === homeInputSelector()) {
    homeValue = value;
    const normalized = value.trim() || "https://example.com/";
    homeStored = normalized === "https://example.com/" ? null : normalized;
  } else if (selector === draftLabelSelector()) draftLabel = value;
  else if (selector === draftUrlSelector()) draftUrl = value;
  else {
    const row = dynamicRowSelector(selector);
    if (row?.kind === "label") labelDrafts.set(row.id, value);
    else if (row?.kind === "url") urlDrafts.set(row.id, value);
    else throw new Error(`unknown fixture input ${selector}`);
  }
}

function dynamicTabSelector(selector: string): { kind: "focus" | "close"; id: string } | null {
  const match = selector.match(/^\[data-debug-id='shellx-browser-(close-)?tab-([^']+)'\]$/);
  if (!match) return null;
  return { kind: match[1] ? "close" : "focus", id: match[2]! };
}

function dynamicHistorySelector(selector: string): string | null {
  return selector.match(/^\[data-debug-id='shellx-browser-history-entry-([^']+)'\]$/)?.[1] ?? null;
}

function dynamicToolbarSelector(selector: string): { kind: "folder" | "link" | "child"; id: string } | null {
  const child = selector.match(/^\[data-debug-id='shellx-browser-bookmark-folder-child-([^']+)'\]$/);
  if (child) return { kind: "child", id: child[1]! };
  const link = selector.match(/^\[data-debug-id='shellx-browser-bookmark-toolbar-link-([^']+)'\]$/);
  if (link) return { kind: "link", id: link[1]! };
  const folder = selector.match(/^\[data-debug-id='shellx-browser-bookmark-folder-([^']+)'\]$/);
  return folder ? { kind: "folder", id: folder[1]! } : null;
}

function dynamicBookmarkNavigationSelector(selector: string): { kind: "list" | "manager"; id: string } | null {
  const list = selector.match(/^\[data-debug-id='shellx-browser-bookmark-([^']+)'\]$/);
  if (list && bookmarks.has(list[1]!)) return { kind: "list", id: list[1]! };
  const manager = selector.match(/^\[data-debug-id='shellx-browser-bookmark-open-([^']+)'\]\[aria-label='Open ([^']+)'\]$/);
  if (!manager) return null;
  const bookmark = bookmarks.get(manager[1]!);
  if (bookmark?.label !== manager[2]) return null;
  return bookmark ? { kind: "manager", id: bookmark.bookmarkId } : null;
}

function dynamicBookmarkDragSelector(selector: string): string | null {
  return selector.match(/^\[data-debug-id='shellx-browser-bookmark-drag-([^']+)'\]$/)?.[1] ?? null;
}

function dynamicBookmarkManagerRowSelector(selector: string): string | null {
  return selector.match(/^\[data-debug-id='shellx-browser-bookmark-manager-row-([^']+)'\]$/)?.[1] ?? null;
}

function dynamicRowSelector(selector: string): { kind: "label" | "url" | "pin" | "delete" | "delete-confirm"; id: string } | null {
  const match = selector.match(/^\[data-debug-id='shellx-browser-bookmark-(label|url|pin|delete)-([^']+)'\](\[aria-label\^='Confirm delete '\])?$/);
  if (!match) return null;
  return { kind: match[3] ? "delete-confirm" : match[1] as "label" | "url" | "pin" | "delete", id: match[2]! };
}

function bookmarkFromBody(body: Record<string, unknown>): Bookmark {
  const kind = body.kind === "folder" ? "folder" : body.kind === "link" ? "link" : null;
  if (!kind) throw new Error("bookmark kind is required");
  const bookmarkId = typeof body.bookmarkId === "string" && body.bookmarkId ? body.bookmarkId : `fixture-api-bookmark-${++generatedIndex}`;
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : kind === "folder" ? "Folder" : string(body.url);
  const url = kind === "link" ? string(body.url) : null;
  return {
    bookmarkId,
    label,
    kind,
    ...(url ? { url } : {}),
    parentId: typeof body.parentId === "string" ? body.parentId : null,
    toolbarPinned: body.toolbarPinned === true,
    toolbarOrder: typeof body.toolbarOrder === "number" && Number.isSafeInteger(body.toolbarOrder) && body.toolbarOrder >= 0
      ? body.toolbarOrder
      : bookmarks.size,
  };
}

function createTab(
  profileId: string,
  url: string,
  ownedTaskId: string | null,
  ownerKind: BrowserTab["ownerKind"] = "user",
): BrowserTab {
  const browserTabId = `fixture-owned-tab-${++generatedTabIndex}`;
  for (const tab of tabs.values()) tab.active = false;
  const tab: BrowserTab = {
    browserTabId,
    taskId: ownedTaskId,
    profileId,
    url,
    active: true,
    ownerKind,
    delegatedTaskId: null,
    delegatedGrantId: null,
    lock: null,
  };
  tabs.set(browserTabId, tab);
  tabHistories.set(browserTabId, { urls: [url], index: 0 });
  activeBrowserTabId = browserTabId;
  return tab;
}

function focusTab(browserTabId: string): void {
  if (!tabs.has(browserTabId)) throw new Error(`unknown fixture tab ${browserTabId}`);
  for (const tab of tabs.values()) tab.active = tab.browserTabId === browserTabId;
  activeBrowserTabId = browserTabId;
}

function closeTab(browserTabId: string): void {
  if (!tabs.delete(browserTabId)) throw new Error(`unknown fixture tab ${browserTabId}`);
  tabHistories.delete(browserTabId);
  if (activeBrowserTabId === browserTabId) {
    activeBrowserTabId = tabs.keys().next().value ?? null;
    if (activeBrowserTabId) focusTab(activeBrowserTabId);
  }
}

function navigateTab(browserTabId: string, url: string): void {
  const tab = tabs.get(browserTabId);
  const history = tabHistories.get(browserTabId);
  if (!tab || !history) throw new Error(`unknown fixture tab ${browserTabId}`);
  history.urls = history.urls.slice(0, history.index + 1);
  history.urls.push(url);
  history.index = history.urls.length - 1;
  tab.url = url;
}

function recordHistory(taskId: string | null, profileId: string, url: string): void {
  if (!url || url === "about:blank") return;
  historyEntries = historyEntries.filter((entry) => !(entry.profileId === profileId && entry.url === url));
  historyEntries.unshift({
    historyId: `fixture-history-${++generatedIndex}`,
    taskId,
    profileId,
    url,
    title: null,
    visitedAtMs: Date.now(),
  });
}

function moveTabHistory(browserTabId: string, delta: -1 | 1): void {
  const tab = tabs.get(browserTabId);
  const history = tabHistories.get(browserTabId);
  if (!tab || !history) throw new Error(`unknown fixture tab ${browserTabId}`);
  const next = Math.max(0, Math.min(history.urls.length - 1, history.index + delta));
  history.index = next;
  tab.url = history.urls[next]!;
}

function headerBrowserSelector() { return "[data-debug-id='header-shellx-browser']"; }
function newTabSelector() { return "[data-debug-id='shellx-browser-new-tab']"; }
function newDisposableTabSelector() { return "[data-debug-id='shellx-browser-new-disposable-tab']"; }
function homeSelector() { return "[data-debug-id='shellx-browser-home']"; }
function backSelector() { return "[data-debug-id='shellx-browser-back']"; }
function forwardSelector() { return "[data-debug-id='shellx-browser-forward']"; }
function reloadSelector() { return "[data-debug-id='shellx-browser-reload']"; }
function lockTabSelector() { return "[data-debug-id='shellx-browser-lock-tab']"; }
function bookmarkCurrentSelector() { return "[data-debug-id='shellx-browser-bookmark-current']"; }
function handoffTabSelector() { return "[data-debug-id='shellx-browser-handoff-tab']"; }
function handoffBackdropSelector() { return "[data-debug-id='shellx-browser-handoff-confirmation-backdrop']"; }
function handoffConfirmationSelector() { return "[data-debug-id='shellx-browser-handoff-confirmation']"; }
function handoffContextSelector() { return "[data-debug-id='shellx-browser-handoff-context']"; }
function handoffVaultNoticeSelector() { return "[data-debug-id='shellx-browser-handoff-vault-notice']"; }
function handoffStatusSelector() { return "[data-debug-id='shellx-browser-handoff-status']"; }
function handoffConfirmSelector() { return "[data-debug-id='shellx-browser-handoff-confirm']"; }
function handoffCancelSelector() { return "[data-debug-id='shellx-browser-handoff-cancel']"; }
function takeBackTabSelector() { return "[data-debug-id='shellx-browser-take-back-tab']"; }
function optionsOwnerSelector() { return "[data-debug-id='shellx-browser-options']"; }
function optionsPanelSelector() { return "#shellx-browser-options-sidecar[aria-labelledby='shellx-browser-options']"; }
function homeInputSelector() { return "[data-debug-id='shellx-browser-homepage']"; }
function historyOwnerSelector() { return "[data-debug-id='shellx-browser-history-menu']"; }
function historyPanelSelector() { return "#shellx-browser-history-sidecar[aria-labelledby='shellx-browser-history-menu']"; }
function historyUserSelector() { return "[data-debug-id='shellx-browser-history-user']"; }
function historyAgentSelector() { return "[data-debug-id='shellx-browser-history-agent']"; }
function clearHistorySelector() { return "[data-debug-id='shellx-browser-clear-history']"; }
function clearAllHistorySelector() { return "[data-debug-id='shellx-browser-clear-all-history']"; }
function historyClearStatusSelector() { return "[data-debug-id='shellx-browser-history-clear-status']"; }
function historyClearConfirmationSelector() { return "[data-debug-id='shellx-browser-history-clear-confirmation']"; }
function historyClearConfirmSelector() { return "[data-debug-id='shellx-browser-history-clear-confirm']"; }
function historyClearCancelSelector() { return "[data-debug-id='shellx-browser-history-clear-cancel']"; }
function isUserHistoryEntry(entry: HistoryEntry): boolean {
  return entry.profileId === "personal" && !entry.taskId?.trim();
}
function ownerSelector() { return "[data-debug-id='shellx-browser-bookmarks-menu']"; }
function panelSelector() { return "#shellx-browser-bookmark-manager-dock[aria-labelledby='shellx-browser-bookmarks-menu']"; }
function closeSelector() { return "[data-debug-id='shellx-browser-bookmark-manager-close']"; }
function listModeSelector() { return "[data-debug-id='shellx-browser-bookmark-list-mode']"; }
function editModeSelector() { return "[data-debug-id='shellx-browser-bookmark-manager-toggle']"; }
function draftLabelSelector() { return "[data-debug-id='shellx-browser-bookmark-draft-label']"; }
function draftUrlSelector() { return "[data-debug-id='shellx-browser-bookmark-draft-url']"; }
function draftFolderSelector() { return "[data-debug-id='shellx-browser-bookmark-draft-folder']"; }
function newFolderSelector() { return "[data-debug-id='shellx-browser-bookmark-create-folder']"; }
function addLinkSelector() { return "[data-debug-id='shellx-browser-bookmark-create-link']"; }

candidate.listen(0, "127.0.0.1", () => {
  webdriver.listen(0, "127.0.0.1", () => {
    writeFileSync(stateOut, `${JSON.stringify({ candidatePort: address(candidate).port, webdriverPort: address(webdriver).port })}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => closeServers(candidate, webdriver));
}

function closeServers(first: Server, second: Server): void {
  first.close(() => second.close(() => process.exit(0)));
}

function element(selector: string): Record<string, string> {
  return { "element-6066-11e4-a52e-4f735466cecf": `selector:${Buffer.from(selector).toString("base64url")}` };
}

function elementSelector(value: string): string {
  const id = decodeURIComponent(value);
  if (!id.startsWith("selector:")) throw new Error("fixture element id is invalid");
  return Buffer.from(id.slice("selector:".length), "base64url").toString("utf8");
}

function address(server: Server): { port: number } {
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("fixture server is not listening");
  return { port: value.port };
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function webdriverValue(response: ServerResponse, value: unknown): void { json(response, 200, { value }); }
function webdriverError(response: ServerResponse, status: number, error: string, message: string): void {
  json(response, status, { value: { error, message, stacktrace: "" } });
}
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture value must be an object");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("fixture value must be a non-empty string");
  return value.trim();
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function requiredArg(name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
