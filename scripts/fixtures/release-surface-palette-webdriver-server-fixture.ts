import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const stateOut = requiredArg(args, "--state-out");
const token = requiredArg(args, "--token");
const sessionId = requiredArg(args, "--session-id");
const instanceId = requiredArg(args, "--instance-id");
const processId = Number(requiredArg(args, "--process-id"));
const version = requiredArg(args, "--version");
const sourceCommit = requiredArg(args, "--source-commit");
const screenshotDir = requiredArg(args, "--screenshot-dir");
const screenshotPath = join(screenshotDir, "shellx-screenshot-1720000000000.png");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

const effectSelectors: Record<string, string> = {
  "act-settings": ".settings-modal",
  "act-help": ".modal[aria-label='Keyboard shortcuts']",
  "act-asset-board": ".asset-board-modal",
  "act-pr": ".pr-modal",
  "act-vault": "[data-debug-id='vault-workspace-modal']",
  "act-open-work-preview": ".preview-center-modal .preview-center-body-work",
  "act-desktop-integrations": "[data-debug-id='settings-tab-desktop'].active[aria-selected='true']",
  "act-toggle-term": "[data-debug-id='bottom-tab-terminal'].active",
};
const actionIds = new Set([
  ...Object.keys(effectSelectors),
  "act-new",
  "act-close",
  "act-auto-auto",
  "act-attach-screenshot",
  "act-connect",
  "act-abort",
]);
let paletteOpen = false;
let activeEffect: string | null = null;
let bottomTab: "Chat" | "Terminal" = "Chat";
let autonomy: "default" | "bypassPermissions" = "bypassPermissions";
let nextTabNumber = 2;
let openTabs = [{ tabId: "fixture-tab-1" }];
let activeTabId = "fixture-tab-1";
let activeTabState: Record<string, unknown> = {
  tabId: activeTabId,
  cwd: "/fixture/project",
  agentId: "grok",
  status: "Idle",
  isSending: false,
  connectionId: null,
  connectionLabel: "Local",
  connectionTransport: "local",
};
let providerActive = false;
let providerTabId = "";
const nativeClicks: string[] = [];
const chords: string[][] = [];
let releaseCount = 0;
let attachmentActive = false;
let attachmentRemoveClicks = 0;
let assetBoardOpen = false;

const candidate = createServer(async (request, response) => {
  try {
    if (request.url === "/health" && request.method === "GET") {
      return json(response, 200, {
        ok: true,
        processId,
        instanceId,
        appVersion: version,
        buildCommit: sourceCommit,
        debugApiPort: candidateAddress().port,
      });
    }
    if (!authorized(request)) return json(response, 401, { error: "unauthorized" });
    if (request.url === "/browser/state" && request.method === "GET") {
      return json(response, 200, { tabs: [], tasks: [] });
    }
    if (request.url === "/state/ui" && request.method === "GET") {
      return json(response, 200, {
        bottomTab,
        autonomy,
        activeTab: { ...activeTabState, tabId: activeTabId, autonomy },
        activeTabId,
        openTabs,
      });
    }
    if (request.url === "/state/ui" && request.method === "POST") {
      const body = await requestJson(request);
      if (body.openModal === "palette") {
        paletteOpen = true;
        assetBoardOpen = false;
        activeEffect = null;
      } else if (body.openModal === "assets") {
        paletteOpen = false;
        assetBoardOpen = true;
        activeEffect = null;
      } else if (body.openModal === "close") {
        paletteOpen = false;
        assetBoardOpen = false;
        activeEffect = null;
      }
      if (body.bottomTab === "Chat" || body.bottomTab === "Terminal") bottomTab = body.bottomTab;
      if (body.releaseTestLegacyAutonomy === "legacy-default") autonomy = "default";
      if (typeof body.activeTabId === "string" && openTabs.some((tab) => tab.tabId === body.activeTabId)) {
        activeTabId = body.activeTabId;
      }
      if (body.activeTab && typeof body.activeTab === "object" && !Array.isArray(body.activeTab)) {
        const next = body.activeTab as Record<string, unknown>;
        if (next.tabId !== activeTabId) throw new Error("fixture activeTab patch must match activeTabId");
        activeTabState = structuredClone(next);
      }
      return json(response, 200, { ok: true });
    }
    if (request.url === "/state/sessions" && request.method === "GET") {
      return json(response, 200, {
        tabs: providerActive ? [{
          tabId: providerTabId,
          cwd: activeTabState.cwd,
          hasActiveChild: true,
        }] : [],
      });
    }
    if (request.url === "/connect" && request.method === "POST") {
      const body = await requestJson(request);
      if (typeof body.tabId !== "string" || body.tabId !== activeTabId || typeof body.cwd !== "string") {
        throw new Error("fixture connect requires the exact active tab and cwd");
      }
      providerActive = true;
      providerTabId = body.tabId;
      activeTabState = { ...activeTabState, cwd: body.cwd, status: "Connected" };
      return json(response, 200, { ok: true, cwd: body.cwd });
    }
    if (request.url?.startsWith("/abort?") && request.method === "POST") {
      const tabId = new URL(request.url, "http://127.0.0.1").searchParams.get("tabId");
      if (!providerActive || tabId !== providerTabId) return json(response, 404, { error: "unknown_tab" });
      providerActive = false;
      providerTabId = "";
      activeTabState = { ...activeTabState, status: "Idle", isSending: false };
      return json(response, 200, { ok: true, tabId, registryRemoved: true });
    }
    if (request.url === "/audit" && request.method === "GET") {
      return json(response, 200, {
        nativeClicks,
        chords,
        releaseCount,
        paletteOpen,
        activeEffect,
        bottomTab,
        autonomy,
        activeTabId,
        openTabs,
        attachmentActive,
        attachmentRemoveClicks,
        assetBoardOpen,
        activeTab: activeTabState,
        providerActive,
        screenshotFileExists: existsSync(screenshotPath),
      });
    }
    return json(response, 404, { error: "not found" });
  } catch (error) {
    return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const webdriver = createServer(async (request, response) => {
  try {
    const path = request.url ?? "";
    const prefix = `/session/${encodeURIComponent(sessionId)}`;
    if (!path.startsWith(prefix)) return webdriverError(response, 404, "invalid session id", "unknown fixture session");
    if (request.method === "POST" && path === `${prefix}/element`) {
      const body = await requestJson(request);
      const selector = typeof body.value === "string" ? body.value : "";
      const action = selector.match(/^\[data-palette-action-id='([^']+)'\]$/)?.[1];
      if (action && paletteOpen && actionIds.has(action)) {
        return webdriverValue(response, { "element-6066-11e4-a52e-4f735466cecf": `action:${action}` });
      }
      const effect = Object.entries(effectSelectors).find(([, value]) => value === selector)?.[0];
      if (effect && activeEffect === effect) {
        return webdriverValue(response, { "element-6066-11e4-a52e-4f735466cecf": `effect:${effect}` });
      }
      if (selector === ".composer-attachment-chip.composer-attachment-image" && attachmentActive) {
        return webdriverValue(response, { "element-6066-11e4-a52e-4f735466cecf": "attachment:chip" });
      }
      if (selector === ".composer-attachment-remove" && attachmentActive) {
        return webdriverValue(response, { "element-6066-11e4-a52e-4f735466cecf": "attachment:remove" });
      }
      if (selector === ".composer-attachment-chip" && attachmentActive) {
        return webdriverValue(response, { "element-6066-11e4-a52e-4f735466cecf": "attachment:chip" });
      }
      if (selector === "[role='dialog'][aria-label='Attachment and media board']" && assetBoardOpen) {
        return webdriverValue(response, { "element-6066-11e4-a52e-4f735466cecf": "ui-screenshot:board" });
      }
      if (selector === "[title='Attach app screenshot']" && assetBoardOpen) {
        return webdriverValue(response, { "element-6066-11e4-a52e-4f735466cecf": "ui-screenshot:asset" });
      }
      if (selector === "[data-debug-id='composer-screenshot']" && !paletteOpen && !assetBoardOpen) {
        return webdriverValue(response, { "element-6066-11e4-a52e-4f735466cecf": "ui-screenshot:composer" });
      }
      return webdriverError(response, 404, "no such element", `fixture does not expose ${selector}`);
    }
    const displayed = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/displayed$`));
    if (request.method === "GET" && displayed) {
      const elementId = decodeURIComponent(displayed[1]!);
      const action = elementId.startsWith("action:") ? elementId.slice("action:".length) : null;
      const effect = elementId.startsWith("effect:") ? elementId.slice("effect:".length) : null;
      return webdriverValue(response, Boolean(
        (action && paletteOpen && actionIds.has(action))
        || (effect && activeEffect === effect)
        || ((elementId === "attachment:chip" || elementId === "attachment:remove") && attachmentActive)
        || (elementId === "ui-screenshot:board" && assetBoardOpen)
        || (elementId === "ui-screenshot:asset" && assetBoardOpen)
        || (elementId === "ui-screenshot:composer" && !paletteOpen && !assetBoardOpen),
      ));
    }
    const clicked = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/click$`));
    if (request.method === "POST" && clicked) {
      const elementId = decodeURIComponent(clicked[1]!);
      if (elementId === "attachment:remove" && attachmentActive) {
        attachmentActive = false;
        attachmentRemoveClicks += 1;
        return webdriverValue(response, null);
      }
      if (elementId === "ui-screenshot:asset" || elementId === "ui-screenshot:composer") {
        if ((elementId === "ui-screenshot:asset" && !assetBoardOpen)
          || (elementId === "ui-screenshot:composer" && (paletteOpen || assetBoardOpen))) {
          return webdriverError(response, 404, "stale element reference", "fixture screenshot action is not visible");
        }
        nativeClicks.push(elementId);
        createScreenshotAttachment();
        return webdriverValue(response, null);
      }
      if (!elementId.startsWith("action:")) {
        return webdriverError(response, 404, "stale element reference", "fixture element is not clickable");
      }
      const action = elementId.slice("action:".length);
      if (!paletteOpen || !actionIds.has(action)) {
        return webdriverError(response, 404, "stale element reference", "fixture action is not visible");
      }
      nativeClicks.push(action);
      paletteOpen = false;
      activeEffect = effectSelectors[action] ? action : null;
      applyAction(action);
      return webdriverValue(response, null);
    }
    if (request.method === "POST" && path === `${prefix}/execute/sync`) {
      const body = await requestJson(request);
      if (typeof body.script !== "string" || !body.script.includes("SHELLX_BOUNDED_ELEMENT_OBSERVATION")) {
        return webdriverError(response, 400, "invalid argument", "fixture supports only bounded element observation");
      }
      const args = Array.isArray(body.args) ? body.args : [];
      const selector = args[0];
      const fields = Array.isArray(args[1]) ? args[1] : [];
      if (selector !== ".composer-attachment-chip.composer-attachment-image"
        || fields.length !== 1 || fields[0] !== "title") {
        return webdriverError(response, 400, "invalid argument", "fixture received an undeclared observation target");
      }
      return webdriverValue(response, attachmentActive
        ? { present: true, visible: true, observation: { title: screenshotPath } }
        : { present: false, visible: false, observation: {} });
    }
    if (request.method === "POST" && path === `${prefix}/actions`) {
      const body = await requestJson(request);
      const keys = keyDownValues(body);
      chords.push(keys);
      applyChord(keys);
      return webdriverValue(response, null);
    }
    if (request.method === "DELETE" && path === `${prefix}/actions`) {
      releaseCount += 1;
      return webdriverValue(response, null);
    }
    return webdriverError(response, 404, "unknown command", `${request.method} ${path}`);
  } catch (error) {
    return webdriverError(response, 500, "unknown error", error instanceof Error ? error.message : String(error));
  }
});

function applyAction(action: string): void {
  if (action === "act-toggle-term") {
    bottomTab = "Terminal";
  } else if (action === "act-new") {
    activeTabId = `fixture-tab-${nextTabNumber}`;
    nextTabNumber += 1;
    openTabs = [...openTabs, { tabId: activeTabId }];
  } else if (action === "act-close") {
    closeActiveTab();
  } else if (action === "act-auto-auto") {
    autonomy = "bypassPermissions";
  } else if (action === "act-attach-screenshot") {
    createScreenshotAttachment();
  } else if (action === "act-connect") {
    providerActive = true;
    providerTabId = activeTabId;
    activeTabState = { ...activeTabState, status: "Connected" };
  } else if (action === "act-abort") {
    providerActive = false;
    providerTabId = "";
    activeTabState = { ...activeTabState, status: "Idle", isSending: false };
  }
}

function createScreenshotAttachment(): void {
  mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
  writeFileSync(screenshotPath, png, { flag: "wx", mode: 0o600 });
  attachmentActive = true;
}

function applyChord(keys: string[]): void {
  const command = keys[0] === "\uE009" || keys[0] === "\uE03D";
  if (command && keys[1] === "t") {
    activeTabId = `fixture-tab-${nextTabNumber}`;
    activeTabState = { ...activeTabState, tabId: activeTabId, status: "Idle" };
    nextTabNumber += 1;
    openTabs = [...openTabs, { tabId: activeTabId }];
  } else if (command && keys[1] === "w") {
    closeActiveTab();
  } else {
    throw new Error(`unsupported fixture chord ${JSON.stringify(keys)}`);
  }
}

function closeActiveTab(): void {
  const index = openTabs.findIndex((tab) => tab.tabId === activeTabId);
  if (index < 0) throw new Error("fixture active tab is missing");
  const next = openTabs.filter((tab) => tab.tabId !== activeTabId);
  const fallback = next[index] ?? next[index - 1];
  openTabs = next;
  activeTabId = fallback?.tabId ?? "";
  activeTabState = { ...activeTabState, tabId: activeTabId, status: "Idle" };
}

function keyDownValues(body: Record<string, unknown>): string[] {
  const sources = Array.isArray(body.actions) ? body.actions : [];
  const source = asRecord(sources[0]);
  const actions = Array.isArray(source?.actions) ? source.actions : [];
  return actions
    .map(asRecord)
    .filter((action): action is Record<string, unknown> => action?.type === "keyDown")
    .map((action) => String(action.value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

candidate.listen(0, "127.0.0.1", () => {
  webdriver.listen(0, "127.0.0.1", () => {
    writeFileSync(stateOut, `${JSON.stringify({
      candidatePort: candidateAddress().port,
      webdriverPort: webdriverAddress().port,
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => candidate.close(() => webdriver.close(() => process.exit(0))));
}

function authorized(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 64 * 1024) throw new Error("fixture request body is too large");
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("fixture request must be an object");
  return parsed as Record<string, unknown>;
}

function candidateAddress(): { port: number } {
  const address = candidate.address();
  if (!address || typeof address === "string") throw new Error("candidate fixture is not listening");
  return { port: address.port };
}

function webdriverAddress(): { port: number } {
  const address = webdriver.address();
  if (!address || typeof address === "string") throw new Error("WebDriver fixture is not listening");
  return { port: address.port };
}

function webdriverValue(response: ServerResponse, value: unknown): void {
  json(response, 200, { value });
}

function webdriverError(response: ServerResponse, status: number, error: string, message: string): void {
  json(response, status, { value: { error, message, stacktrace: "" } });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
