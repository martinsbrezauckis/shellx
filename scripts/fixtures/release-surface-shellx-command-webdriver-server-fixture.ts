import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const stateOut = requiredArg("--state-out");
const token = requiredArg("--token");
const sessionId = requiredArg("--session-id");
const instanceId = requiredArg("--instance-id");
const processId = Number(requiredArg("--process-id"));
const version = requiredArg("--version");
const sourceCommit = requiredArg("--source-commit");
const commandEffects: Record<string, string> = {
  "/commands": "[role='dialog'][aria-label='Command palette']",
  "/pr": ".pr-modal[role='dialog']",
  "/build": "[data-shellx-event-code='build-objective-required']",
  "/goal": "[data-shellx-event-code='goal-objective-required']",
};
const goalCommands = new Set(["/pause", "/resume", "/stop"]);
const validationCommands = new Set(["/build", "/goal"]);
let promptValue = "";
let activeCommand: string | null = null;
const activeTab = { tabId: "fixture-tab-1", cwd: "/fixture/original", connectionLabel: "Local", connectionTransport: "local" };
const goalStates = new Map<string, { active: boolean; pausedByUser: boolean }>();
const apiRequests: string[] = [];
const enteredValues: string[] = [];
const clickedCommands: string[] = [];
let clearCount = 0;

const candidate = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/health" && request.method === "GET") {
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
    if (url.pathname === "/browser/state" && request.method === "GET") {
      return json(response, 200, { tabs: [], tasks: [] });
    }
    if (url.pathname === "/state/ui" && request.method === "GET") {
      return json(response, 200, { activeTabId: activeTab.tabId, activeTab: { ...activeTab }, openTabs: [{ tabId: activeTab.tabId }] });
    }
    if (url.pathname === "/state/ui" && request.method === "POST") {
      const body = await requestJson(request);
      if (body.openModal === "close") activeCommand = null;
      if (body.activeTab && typeof body.activeTab === "object" && !Array.isArray(body.activeTab)) {
        const patch = body.activeTab as Record<string, unknown>;
        if (typeof patch.cwd === "string" && patch.cwd.trim()) activeTab.cwd = patch.cwd;
      }
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/build/state" && request.method === "GET") {
      apiRequests.push("GET /build/state");
      return json(response, 200, { tabId: url.searchParams.get("tabId") ?? "default", state: null });
    }
    if (url.pathname === "/goal/state" && request.method === "GET") {
      apiRequests.push("GET /goal/state");
      const tabId = url.searchParams.get("tabId") ?? "default";
      return json(response, 200, { tabId, state: goalStates.get(tabId) ?? null, approvalStatus: null, lastClear: null });
    }
    if (url.pathname === "/goal/start" && request.method === "POST") {
      apiRequests.push("POST /goal/start");
      const body = await requestJson(request);
      const tabId = typeof body.tabId === "string" ? body.tabId : "default";
      goalStates.set(tabId, { active: true, pausedByUser: false });
      return json(response, 200, { ok: true, tabId, objective: body.objective, cwd: body.cwd, scratchboardPath: `${body.cwd}/goal.md` });
    }
    if (url.pathname === "/goal/pause" && request.method === "POST") {
      apiRequests.push("POST /goal/pause");
      const body = await requestJson(request);
      const tabId = typeof body.tabId === "string" ? body.tabId : "default";
      const goal = goalStates.get(tabId);
      if (goal) goal.pausedByUser = true;
      return json(response, 200, { ok: true, tabId, paused: true });
    }
    if (url.pathname === "/goal/stop" && request.method === "POST") {
      apiRequests.push("POST /goal/stop");
      const body = await requestJson(request);
      const tabId = typeof body.tabId === "string" ? body.tabId : "default";
      goalStates.delete(tabId);
      return json(response, 200, { ok: true, tabId, active: false });
    }
    if (url.pathname === "/audit" && request.method === "GET") {
      return json(response, 200, {
        enteredValues,
        clickedCommands,
        promptValue,
        activeCommand,
        clearCount,
        activeTab,
        goalStates: Object.fromEntries(goalStates),
        apiRequests,
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
      if (selector === "[data-debug-id='composer-prompt']") return webdriverValue(response, element("prompt"));
      if (selector === "[data-debug-id='composer-send']") return webdriverValue(response, element("send"));
      const command = Object.entries(commandEffects).find(([, effect]) => effect === selector)?.[0];
      if (command && activeCommand === command) return webdriverValue(response, element(`effect:${command.slice(1)}`));
      return webdriverError(response, 404, "no such element", `fixture does not expose ${selector}`);
    }
    const displayed = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/displayed$`));
    if (request.method === "GET" && displayed) {
      const elementId = decodeURIComponent(displayed[1]!);
      return webdriverValue(response, elementId === "prompt" || elementId === "send"
        || (elementId.startsWith("effect:") && activeCommand === `/${elementId.slice("effect:".length)}`));
    }
    const cleared = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/clear$`));
    if (request.method === "POST" && cleared) {
      const elementId = decodeURIComponent(cleared[1]!);
      if (elementId !== "prompt") return webdriverError(response, 400, "invalid element state", "only prompt is clearable");
      promptValue = "";
      clearCount += 1;
      return webdriverValue(response, null);
    }
    const value = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/value$`));
    if (request.method === "POST" && value) {
      const elementId = decodeURIComponent(value[1]!);
      if (elementId !== "prompt") return webdriverError(response, 400, "invalid element state", "only prompt accepts text");
      const body = await requestJson(request);
      if (typeof body.text !== "string") return webdriverError(response, 400, "invalid argument", "text is required");
      promptValue += body.text;
      enteredValues.push(promptValue);
      return webdriverValue(response, null);
    }
    const clicked = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/click$`));
    if (request.method === "POST" && clicked) {
      const elementId = decodeURIComponent(clicked[1]!);
      if (elementId !== "send") return webdriverError(response, 400, "invalid element state", "only send is clickable");
      if (!commandEffects[promptValue] && !goalCommands.has(promptValue) && !validationCommands.has(promptValue)) {
        return webdriverError(response, 400, "invalid argument", "unsupported command text");
      }
      activeCommand = promptValue;
      clickedCommands.push(promptValue);
      const goal = goalStates.get(activeTab.tabId);
      if (promptValue === "/pause" && goal) goal.pausedByUser = true;
      if (promptValue === "/resume" && goal) goal.pausedByUser = false;
      if (promptValue === "/stop") goalStates.delete(activeTab.tabId);
      promptValue = "";
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

function requiredArg(name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : args.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
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

function element(id: string): Record<string, string> {
  return { "element-6066-11e4-a52e-4f735466cecf": id };
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
