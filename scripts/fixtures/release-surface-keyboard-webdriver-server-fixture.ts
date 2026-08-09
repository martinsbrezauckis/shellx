import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const stateOut = requiredArg(args, "--state-out");
const token = requiredArg(args, "--token");
const sessionId = requiredArg(args, "--session-id");
const instanceId = requiredArg(args, "--instance-id");
const processId = Number(requiredArg(args, "--process-id"));
const version = requiredArg(args, "--version");
const sourceCommit = requiredArg(args, "--source-commit");
const chords: string[][] = [];
let releaseCount = 0;
let neutralFocusClicks = 0;
let modal: "help" | "palette" | "settings" | null = null;
let bottomTab: "Chat" | "Terminal" = "Chat";
let nextTabNumber = 2;
let openTabs = [{ tabId: "fixture-tab-1" }];
let activeTabId = "fixture-tab-1";
let diffSessionOpen = false;
let activeHunkIndex = 0;
const hunkAudit = new Map<number, "accepted" | "rejected">();
const hunkClicks: number[] = [];
let refreshCount = 0;

const selectors: Record<string, () => boolean> = {
  ".shell": () => true,
  "[role='dialog'][aria-label='Keyboard shortcuts']": () => modal === "help",
  "[role='dialog'][aria-label='Command palette']": () => modal === "palette",
  ".settings-modal[role='dialog']": () => modal === "settings",
  "[data-debug-id='bottom-tab-terminal'].active": () => bottomTab === "Terminal",
  "[data-debug-id='bottom-tab-chat'].active": () => bottomTab === "Chat",
  "[data-debug-id='session-tab'].active": () => openTabs.some((tab) => tab.tabId === activeTabId),
};

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
        openModal: modal,
        activeTabId,
        openTabs,
      });
    }
    if (request.url === "/state/ui" && request.method === "POST") {
      const body = await requestJson(request);
      if (body.openModal === "close") modal = null;
      if (body.openModal === "settings") modal = "settings";
      if (body.bottomTab === "Chat" || body.bottomTab === "Terminal") bottomTab = body.bottomTab;
      const rendererFixture = asRecord(body.debugRendererFixture);
      if (rendererFixture?.id === "keyboard-diff-lifecycle") {
        diffSessionOpen = rendererFixture.action !== "clear";
        activeHunkIndex = 0;
        hunkAudit.clear();
      }
      if (body.refreshPastChats === true) refreshCount += 1;
      if (typeof body.activeTabId === "string" && openTabs.some((tab) => tab.tabId === body.activeTabId)) {
        activeTabId = body.activeTabId;
      }
      return json(response, 200, { ok: true });
    }
    if (request.url === "/audit" && request.method === "GET") {
      return json(response, 200, {
        chords,
        releaseCount,
        neutralFocusClicks,
        modal,
        bottomTab,
        activeTabId,
        openTabs,
        diffSessionOpen,
        activeHunkIndex,
        hunkAudit: Object.fromEntries(hunkAudit),
        hunkClicks,
        refreshCount,
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
      if (selectorVisible(selector)) return webdriverValue(response, element(selector));
      return webdriverError(response, 404, "no such element", `fixture does not expose ${selector}`);
    }
    const displayed = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/displayed$`));
    if (request.method === "GET" && displayed) {
      const selector = elementSelector(displayed[1]!);
      return webdriverValue(response, selectorVisible(selector));
    }
    const clicked = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/click$`));
    if (request.method === "POST" && clicked) {
      const selector = elementSelector(clicked[1]!);
      if (!selectorVisible(selector)) {
        return webdriverError(response, 404, "stale element reference", "fixture element is not clickable");
      }
      if (selector === ".shell") {
        neutralFocusClicks += 1;
      } else {
        const hunkIndex = diffHunkIndex(selector);
        if (hunkIndex === null) {
          return webdriverError(response, 400, "invalid element state", "fixture element has no click behavior");
        }
        activeHunkIndex = hunkIndex;
        hunkClicks.push(hunkIndex);
      }
      return webdriverValue(response, null);
    }
    if (request.method === "POST" && path === `${prefix}/execute/sync`) {
      const body = await requestJson(request);
      const script = typeof body.script === "string" ? body.script : "";
      if (script.includes("SHELLX_BOUNDED_ELEMENT_OBSERVATION")) {
        const args = Array.isArray(body.args) ? body.args : [];
        const selector = typeof args[0] === "string" ? args[0] : "";
        const fields = Array.isArray(args[1]) ? args[1] : [];
        const index = diffHunkIndex(selector);
        if (index === null || fields.length !== 1 || fields[0] !== "focused") {
          return webdriverError(response, 400, "invalid argument", "fixture received an undeclared diff observation");
        }
        const present = selectorVisible(selector);
        return webdriverValue(response, {
          present,
          visible: present,
          observation: present ? { focused: activeHunkIndex === index } : {},
        });
      }
      return webdriverError(response, 400, "invalid argument", "fixture supports only bounded element observation");
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

function applyChord(keys: string[]): void {
  const command = keys[0] === "\uE009" || keys[0] === "\uE03D";
  if (keys.length === 1 && keys[0] === "?") modal = "help";
  else if (keys.length === 1 && keys[0] === "\uE00C") modal = null;
  else if (command && keys[1] === "k") modal = "palette";
  else if (command && keys[1] === ",") modal = "settings";
  else if (command && keys[1] === "`") bottomTab = bottomTab === "Chat" ? "Terminal" : "Chat";
  else if (command && keys[1] === "t") {
    activeTabId = `fixture-tab-${nextTabNumber}`;
    nextTabNumber += 1;
    openTabs = [...openTabs, { tabId: activeTabId }];
  } else if (command && keys[1] === "w") {
    const index = openTabs.findIndex((tab) => tab.tabId === activeTabId);
    if (index < 0) throw new Error("fixture active tab is missing");
    const next = openTabs.filter((tab) => tab.tabId !== activeTabId);
    const fallback = next[index] ?? next[index - 1];
    openTabs = next;
    activeTabId = fallback?.tabId ?? "";
  } else if (diffSessionOpen && keys.length === 1 && keys[0] === "j") {
    activeHunkIndex = Math.min(activeHunkIndex + 1, 2);
  } else if (diffSessionOpen && keys.length === 1 && keys[0] === "k") {
    activeHunkIndex = Math.max(activeHunkIndex - 1, 0);
  } else if (diffSessionOpen && keys.length === 1 && keys[0] === "y") {
    if (hunkAudit.get(activeHunkIndex) === "accepted") hunkAudit.delete(activeHunkIndex);
    else hunkAudit.set(activeHunkIndex, "accepted");
  } else if (diffSessionOpen && keys.length === 1 && keys[0] === "n") {
    if (hunkAudit.get(activeHunkIndex) === "rejected") hunkAudit.delete(activeHunkIndex);
    else hunkAudit.set(activeHunkIndex, "rejected");
  } else throw new Error(`unsupported fixture chord ${JSON.stringify(keys)}`);
}

function selectorVisible(selector: string): boolean {
  if (selectors[selector]?.()) return true;
  const hunkIndex = diffHunkIndex(selector);
  if (!diffSessionOpen || hunkIndex === null) return false;
  if (selector.endsWith(".accepted")) return hunkAudit.get(hunkIndex) === "accepted";
  if (selector.endsWith(".rejected")) return hunkAudit.get(hunkIndex) === "rejected";
  return true;
}

function diffHunkIndex(selector: string): number | null {
  const match = selector.match(/\.tool-diff \[data-hunk\]\[data-hunk-idx='([0-2])'\]/);
  return match ? Number(match[1]) : null;
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

function element(selector: string): Record<string, string> {
  return { "element-6066-11e4-a52e-4f735466cecf": `selector:${Buffer.from(selector).toString("base64url")}` };
}

function elementSelector(value: string): string {
  const id = decodeURIComponent(value);
  if (!id.startsWith("selector:")) throw new Error("fixture element id is invalid");
  return Buffer.from(id.slice("selector:".length), "base64url").toString("utf8");
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
    if (bytes > 64 * 1024) throw new Error("fixture request is too large");
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("fixture request must be an object");
  return parsed as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
