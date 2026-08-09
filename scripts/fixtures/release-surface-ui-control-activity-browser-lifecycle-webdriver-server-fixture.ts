import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const tokenPath = requiredArg(args, "--token-file");
const token = readFileSync(tokenPath, "utf8").trim();
const statePath = requiredArg(args, "--state-out");
const sessionId = requiredArg(args, "--session-id");
const instanceId = requiredArg(args, "--instance-id");
const processId = Number(requiredArg(args, "--process-id"));
const version = requiredArg(args, "--version");
const sourceCommit = requiredArg(args, "--source-commit");
const commit = sourceCommit.slice(0, 16).toLowerCase().replace(/[^a-f0-9]/g, "0");
const ownedSessionId = `release_activity_${commit}`;
const marker = `SHELLX_RELEASE_ACTIVITY_CANARY_${commit}`;
const profileRoot = dirname(dirname(tokenPath));
const cwd = join(profileRoot, "release-activity-workspace", ownedSessionId);
const filePath = join(cwd, "src", "nested", "owned-activity.ts");
const nestedDirectoryPath = join(cwd, "src", "nested");
const relativeFilePath = "src/nested/owned-activity.ts";

const activityDialog = "[role='dialog'][aria-label='Activity Browser']";
const previewDialog = "[role='dialog'][aria-label='Preview Center']";
const input = "[data-debug-id='find-sessions-input']";
const diskRow = "[data-debug-id='surface-components-findpopover-4']";
const diskRowSelected = `${diskRow}[aria-selected='true']`;
const findPreview = ".find-preview";
const findPopover = ".find-popover";
const openNewTab = "[title='Open this chat in a new tab (Enter)']";
const shell = ".shell";
const graphTab = "[data-debug-id='activity-tab-graph']";
const filesTab = "[data-debug-id='activity-tab-files']";
const timelineTab = "[data-debug-id='activity-tab-timeline']";
const evidenceTab = "[data-debug-id='activity-tab-evidence']";
const graphView = ".activity-graph-view";
const graphReset = "[aria-label='Reset graph layout']";
const graphOpen = ".activity-graph-open";
const graphNode = `[data-debug-id='surface-components-activitybrowsermodal-14'][title='${cssString(relativeFilePath)}']`;
const graphRecent = activityPathSelector(16, filePath);
const treeExpand = activityPathSelector(17, nestedDirectoryPath.replaceAll("\\", "/"));
const treeName = activityPathSelector(18, filePath.replaceAll("\\", "/"));
const timeline = activityPathSelector(19, filePath);
const evidenceRow = activityPathSelector(21, filePath);
const baselineTabId = "fixture-baseline-tab";
const ownedTabId = "fixture-owned-activity-tab";

let openTabs: Array<Record<string, unknown> & { tabId: string }> = [{
  tabId: baselineTabId,
  sessionId: null,
  title: "Fixture baseline",
  cwd: profileRoot,
  connectionTransport: "local",
}];
let activeTabId = baselineTabId;
let preview: Record<string, unknown> | null = null;
let modal: "none" | "activity" | "preview" = "none";
let findOpen = false;
let query = "";
let rowSelected = false;
let view: "files" | "graph" | "timeline" | "evidence" = "files";
let graphSelected = false;
let graphFocused = false;
let customGraphPosition = false;
let nestedExpanded = false;
let previewTransitions = 0;
let resetTransitions = 0;
let selectionTransitions = 0;
let expandTransitions = 0;
const clickedSelectors: string[] = [];
const elementSelectors = new Map<string, string>();
let nextElementId = 1;

const candidate = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!authorized(request)) return json(response, 401, { error: "unauthorized" });
    if (url.pathname === "/health" && request.method === "GET") {
      return json(response, 200, {
        ok: true, processId, instanceId, appVersion: version, buildCommit: sourceCommit,
        debugApiVersion: "1.2.0", debugApiPort: candidateAddress().port,
      });
    }
    if (url.pathname === "/browser/state" && request.method === "GET") return json(response, 200, { ok: true });
    if (url.pathname === "/state/ui" && request.method === "GET") {
      return json(response, 200, { activeTabId, openTabs, preview });
    }
    if (url.pathname === "/state/ui" && request.method === "POST") {
      const body = await requestJson(request);
      if (body.openModal === "close") modal = "none";
      if (body.openModal === "activity") {
        if (!openTabs.some((tab) => tab.tabId === activeTabId && tab.sessionId === ownedSessionId)) {
          throw new Error("Activity modal opened without the owned session tab");
        }
        modal = "activity";
        view = "files";
        graphSelected = false;
        graphFocused = false;
        customGraphPosition = false;
        nestedExpanded = false;
      }
      if (body.clearPreview === true) preview = null;
      if (body.preview && typeof body.preview === "object" && !Array.isArray(body.preview)) {
        preview = body.preview as Record<string, unknown>;
      }
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/audit" && request.method === "GET") {
      return json(response, 200, {
        openTabs, activeTabId, preview, modal, findOpen, query, rowSelected, view,
        graphSelected, graphFocused, customGraphPosition, nestedExpanded,
        previewTransitions, resetTransitions, selectionTransitions, expandTransitions,
        clickedSelectors,
      });
    }
    return json(response, 404, { error: "not found" });
  } catch (error) {
    return json(response, 500, { error: errorText(error) });
  }
});

const webdriver = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const prefix = `/session/${encodeURIComponent(sessionId)}`;
    if (!url.pathname.startsWith(prefix)) return webdriverError(response, 404, "invalid session id", "unknown session");
    const path = url.pathname.slice(prefix.length) || "/";
    if (request.method === "POST" && path === "/execute/sync") {
      const body = await requestJson(request);
      const script = typeof body.script === "string" ? body.script : "";
      const scriptArgs = Array.isArray(body.args) ? body.args : [];
      if (script.includes("SHELLX_BOUNDED_ELEMENT_OBSERVATION")
        && typeof scriptArgs[0] === "string" && Array.isArray(scriptArgs[1])) {
        return webdriverValue(response, boundedObservation(
          scriptArgs[0],
          scriptArgs[1].filter((field): field is string => typeof field === "string"),
        ));
      }
      return webdriverError(response, 400, "javascript error", "unsupported bounded fixture script");
    }
    if (request.method === "POST" && path === "/element") {
      const body = await requestJson(request);
      const selector = typeof body.value === "string" ? body.value : "";
      if (!selectorDisplayed(selector)) return webdriverError(response, 404, "no such element", `fixture does not expose ${selector}`);
      const id = `activity-element-${nextElementId++}`;
      elementSelectors.set(id, selector);
      return webdriverValue(response, { "element-6066-11e4-a52e-4f735466cecf": id });
    }
    const displayed = path.match(/^\/element\/([^/]+)\/displayed$/);
    if (request.method === "GET" && displayed) {
      const selector = elementSelectors.get(decodeURIComponent(displayed[1]!));
      return webdriverValue(response, Boolean(selector && selectorDisplayed(selector)));
    }
    const clicked = path.match(/^\/element\/([^/]+)\/click$/);
    if (request.method === "POST" && clicked) {
      const selector = elementSelectors.get(decodeURIComponent(clicked[1]!));
      if (!selector || !selectorDisplayed(selector)) return webdriverError(response, 404, "stale element reference", "element is no longer visible");
      click(selector);
      return webdriverValue(response, null);
    }
    const cleared = path.match(/^\/element\/([^/]+)\/clear$/);
    if (request.method === "POST" && cleared) {
      const selector = elementSelectors.get(decodeURIComponent(cleared[1]!));
      if (selector !== input) return webdriverError(response, 400, "invalid element state", "only the Find input is editable");
      query = "";
      rowSelected = false;
      return webdriverValue(response, null);
    }
    const valued = path.match(/^\/element\/([^/]+)\/value$/);
    if (request.method === "POST" && valued) {
      const selector = elementSelectors.get(decodeURIComponent(valued[1]!));
      if (selector !== input) return webdriverError(response, 400, "invalid element state", "only the Find input is editable");
      const body = await requestJson(request);
      query = typeof body.text === "string" ? body.text : "";
      findOpen = true;
      rowSelected = false;
      return webdriverValue(response, null);
    }
    if (request.method === "POST" && path === "/actions") {
      const body = await requestJson(request);
      const keyValues = extractKeyValues(body);
      if (graphFocused && keyValues.includes("\uE014")) customGraphPosition = true;
      return webdriverValue(response, null);
    }
    if (request.method === "DELETE" && path === "/actions") return webdriverValue(response, null);
    return webdriverError(response, 404, "unknown command", `unsupported fixture WebDriver route ${path}`);
  } catch (error) {
    return webdriverError(response, 500, "unknown error", errorText(error));
  }
});

function selectorDisplayed(selector: string): boolean {
  const activity = modal === "activity";
  if (selector === shell || selector === input) return true;
  if (selector === findPopover) return findOpen;
  if (selector === diskRow) return findOpen && query === marker;
  if (selector === diskRowSelected) return findOpen && query === marker && rowSelected;
  if (selector === findPreview || selector === openNewTab) return findOpen && rowSelected;
  if (selector === activityDialog || selector === filesTab || selector === graphTab || selector === timelineTab || selector === evidenceTab) return activity;
  if (selector === previewDialog) return modal === "preview";
  if (selector === graphView || selector === graphNode) return activity && view === "graph";
  if (selector === graphReset) return activity && view === "graph" && customGraphPosition;
  if (selector === graphOpen || selector === graphRecent) return activity && view === "graph" && graphSelected;
  if (selector === treeExpand) return activity && view === "files";
  if (selector === treeName) return activity && view === "files" && nestedExpanded;
  if (selector === timeline) return activity && view === "timeline";
  if (selector === evidenceRow) return activity && view === "evidence";
  if (selector === tabSelector(baselineTabId)) return openTabs.some((tab) => tab.tabId === baselineTabId);
  if (selector === closeSelector(ownedTabId)) return openTabs.some((tab) => tab.tabId === ownedTabId);
  return false;
}

function click(selector: string): void {
  clickedSelectors.push(selector);
  if (selector === shell) {
    findOpen = false;
    rowSelected = false;
  } else if (selector === diskRow) {
    rowSelected = true;
  } else if (selector === openNewTab) {
    if (!openTabs.some((tab) => tab.tabId === ownedTabId)) {
      openTabs = [...openTabs, {
        tabId: ownedTabId, sessionId: ownedSessionId, title: "Release Activity Browser",
        cwd, connectionTransport: "local",
      }];
    }
    activeTabId = ownedTabId;
    findOpen = false;
    rowSelected = false;
  } else if (selector === graphTab) {
    view = "graph";
  } else if (selector === filesTab) {
    view = "files";
  } else if (selector === timelineTab) {
    view = "timeline";
  } else if (selector === evidenceTab) {
    view = "evidence";
  } else if (selector === graphNode) {
    graphSelected = true;
    graphFocused = true;
    selectionTransitions += 1;
  } else if (selector === graphReset) {
    customGraphPosition = false;
    resetTransitions += 1;
  } else if (selector === treeExpand) {
    nestedExpanded = !nestedExpanded;
    expandTransitions += 1;
  } else if ([graphOpen, graphRecent, treeName, timeline, evidenceRow].includes(selector)) {
    modal = "preview";
    preview = { kind: "file", path: filePath, tabId: ownedTabId, sessionCwd: cwd };
    previewTransitions += 1;
  } else if (selector === closeSelector(ownedTabId)) {
    openTabs = openTabs.filter((tab) => tab.tabId !== ownedTabId);
    activeTabId = baselineTabId;
  } else if (selector === tabSelector(baselineTabId)) {
    activeTabId = baselineTabId;
  } else {
    throw new Error(`fixture click is not implemented for ${selector}`);
  }
}

function boundedObservation(selector: string, requested: string[]): Record<string, unknown> {
  const observation: Record<string, unknown> = {};
  for (const field of requested) {
    if (field === "pressed" && selector === graphNode) observation.pressed = graphSelected;
    else if (field === "focused" && selector === graphNode) observation.focused = graphFocused;
    else if (field === "expanded" && selector === treeExpand) observation.expanded = nestedExpanded;
    else throw new Error(`fixture has no ${field} observation for ${selector}`);
  }
  return { present: selectorDisplayed(selector), visible: selectorDisplayed(selector), observation };
}

function activityPathSelector(occurrence: number, path: string): string {
  return `[data-debug-id='surface-components-activitybrowsermodal-${occurrence}'][data-activity-path='${cssString(path)}']`;
}

function cssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function tabSelector(tabId: string): string {
  return `[data-tab-id='${tabId}']`;
}

function closeSelector(tabId: string): string {
  return `${tabSelector(tabId)} [aria-label='Close session']`;
}

function extractKeyValues(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.actions)) return [];
  return body.actions.flatMap((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return [];
    const actions = (source as Record<string, unknown>).actions;
    if (!Array.isArray(actions)) return [];
    return actions.flatMap((action) => {
      if (!action || typeof action !== "object" || Array.isArray(action)) return [];
      const value = (action as Record<string, unknown>).value;
      return (action as Record<string, unknown>).type === "keyDown" && typeof value === "string" ? [value] : [];
    });
  });
}

function authorized(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(request);
  if (!text) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object");
  return value as Record<string, unknown>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function webdriverValue(response: ServerResponse, value: unknown): void {
  json(response, 200, { value });
}

function webdriverError(response: ServerResponse, status: number, error: string, message: string): void {
  json(response, status, { value: { error, message, stacktrace: "" } });
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function candidateAddress(): { port: number } {
  const address = candidate.address();
  if (!address || typeof address === "string") throw new Error("candidate fixture is not listening");
  return address;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

candidate.listen(0, "127.0.0.1", () => {
  webdriver.listen(0, "127.0.0.1", () => {
    const webdriverAddress = webdriver.address();
    if (!webdriverAddress || typeof webdriverAddress === "string") throw new Error("WebDriver fixture is not listening");
    writeFileSync(statePath, `${JSON.stringify({ candidatePort: candidateAddress().port, webdriverPort: webdriverAddress.port })}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => candidate.close(() => webdriver.close(() => process.exit(0))));
}
