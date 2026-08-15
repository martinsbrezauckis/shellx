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

let managerOpen = false;
let vaultOpen = false;
let search = "";
let stateFilter = "all";
let projectFilter = "all";
let environmentFilter = "all";
let providerFilter = "all";
let selected = true;
let editing = false;
let enabled = true;
let attention = true;
let attachment = true;
let workflow = true;
let vaultRequirement = true;
let triggerKind = "manual";
let weekdayTuesday = false;
let activeProviders = ["grok"];
let paused = false;
let running = true;
let manualRun = false;
let duplicate = false;
let deleted = false;
let deleteArmed = false;
let feedbackAction = false;
const values = new Map<string, string>();
const clickedSelectors: string[] = [];
const keyChords: string[][] = [];
let focusedSelector: string | null = "[data-debug-id='header-tasks']";
let previousFocusSelector: string | null = focusedSelector;

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
      return json(response, 200, { windowOpen: false, profiles: [], tabs: [], tasks: [], engine: { mounted: false }, enginePool: { engines: [] } });
    }
    if (request.method === "POST" && request.url === "/state/ui") {
      const body = await requestJson(request);
      if (body.openModal === "close") vaultOpen = false;
      if (body.debugTaskManagerFixture === "full") resetFixture();
      if (body.debugTaskManagerFixture === "clear") managerOpen = false;
      return json(response, 200, { ok: true });
    }
    if (request.method === "GET" && request.url === "/state/ui") {
      return json(response, 200, { taskManagerOpen: managerOpen, vaultOpen });
    }
    if (request.method === "GET" && request.url === "/audit") {
      return json(response, 200, {
        managerOpen,
        vaultOpen,
        search,
        stateFilter,
        projectFilter,
        environmentFilter,
        providerFilter,
        selected,
        enabled,
        attention,
        attachment,
        workflow,
        vaultRequirement,
        triggerKind,
        weekdayTuesday,
        activeProviders,
        paused,
        running,
        manualRun,
        duplicate,
        deleted,
        feedbackAction,
        clickedSelectors,
        keyChords,
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
    if (request.method === "GET" && path === `${prefix}/window`) return webdriverValue(response, "main-window");
    if (request.method === "GET" && path === `${prefix}/window/handles`) return webdriverValue(response, ["main-window"]);
    if (request.method === "GET" && path === `${prefix}/title`) return webdriverValue(response, "shellX");
    if (request.method === "POST" && path === `${prefix}/execute/sync`) {
      const body = await requestJson(request);
      const script = typeof body.script === "string" ? body.script : "";
      const scriptArgs = Array.isArray(body.args) ? body.args : [];
      if (script.includes("SHELLX_BOUNDED_ELEMENT_OBSERVATION")
        && typeof scriptArgs[0] === "string" && Array.isArray(scriptArgs[1])) {
        const selector = scriptArgs[0];
        const requested = scriptArgs[1].filter((field): field is string => typeof field === "string");
        const present = displayed(selector);
        const observation: Record<string, unknown> = {};
        if (requested.includes("value")) observation.value = valueFor(selector);
        if (requested.includes("checked") && selector === "[data-debug-id='task-manager-enabled']") observation.checked = enabled;
        if (requested.includes("pressed")) observation.pressed = pressedFor(selector);
        if (requested.includes("disabled")) observation.disabled = disabledFor(selector);
        if (requested.includes("title")) observation.title = titleFor(selector);
        if (requested.includes("focused")) observation.focused = focusedSelector === selector;
        return webdriverValue(response, { present, visible: present, observation: present ? observation : {} });
      }
      return webdriverError(response, 400, "javascript error", "unsupported fixture script");
    }
    if (request.method === "POST" && path === `${prefix}/element`) {
      const body = await requestJson(request);
      const selector = typeof body.value === "string" ? body.value : "";
      return displayed(selector)
        ? webdriverValue(response, element(selector))
        : webdriverError(response, 404, "no such element", `fixture does not expose ${selector}`);
    }
    const displayedMatch = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/displayed$`));
    if (request.method === "GET" && displayedMatch) return webdriverValue(response, displayed(elementSelector(displayedMatch[1]!)));
    const clearMatch = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/clear$`));
    if (request.method === "POST" && clearMatch) {
      const selector = elementSelector(clearMatch[1]!);
      if (!displayed(selector) || !textSelector(selector)) return webdriverError(response, 400, "invalid element state", "fixture element is not clearable");
      setValue(selector, "");
      return webdriverValue(response, null);
    }
    const valueMatch = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/value$`));
    if (request.method === "POST" && valueMatch) {
      const selector = elementSelector(valueMatch[1]!);
      if (!displayed(selector)) return webdriverError(response, 404, "stale element reference", "fixture element is not writable");
      const body = await requestJson(request);
      if (typeof body.text !== "string") return webdriverError(response, 400, "invalid argument", "text is required");
      if (selectSelector(selector)) setSelectValue(selector, body.text);
      else if (textSelector(selector)) setValue(selector, valueFor(selector) + body.text);
      else return webdriverError(response, 400, "invalid argument", "fixture element is not writable");
      return webdriverValue(response, null);
    }
    const clickMatch = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/click$`));
    if (request.method === "POST" && clickMatch) {
      const selector = elementSelector(clickMatch[1]!);
      if (!displayed(selector) || disabledFor(selector)) return webdriverError(response, 400, "element not interactable", "fixture element is not clickable");
      focusedSelector = selector;
      click(selector);
      clickedSelectors.push(selector);
      return webdriverValue(response, null);
    }
    if (request.method === "POST" && path === `${prefix}/actions`) {
      const body = await requestJson(request);
      const keys = keyDownValues(body);
      applyKeyChord(keys);
      keyChords.push(keys);
      return webdriverValue(response, null);
    }
    if (request.method === "DELETE" && path === `${prefix}/actions`) return webdriverValue(response, null);
    return webdriverError(response, 404, "unknown command", `${request.method} ${path}`);
  } catch (error) {
    return webdriverError(response, 500, "unknown error", errorText(error));
  }
});

function resetFixture(): void {
  managerOpen = true;
  vaultOpen = false;
  search = "";
  stateFilter = "all";
  projectFilter = "all";
  environmentFilter = "all";
  providerFilter = "all";
  selected = true;
  editing = false;
  enabled = true;
  attention = true;
  attachment = true;
  workflow = true;
  vaultRequirement = true;
  triggerKind = "manual";
  weekdayTuesday = false;
  activeProviders = ["grok"];
  paused = false;
  running = true;
  manualRun = false;
  duplicate = false;
  deleted = false;
  deleteArmed = false;
  feedbackAction = false;
  focusedSelector = "[data-debug-id='task-manager-close']";
  values.clear();
  values.set("[data-debug-id='task-manager-name']", "Review the weekly changelog");
  values.set("[data-debug-id='task-manager-instruction']", "Review the project changelog and report only material changes.");
  values.set("[data-debug-id='task-manager-success-criteria']", "No material omissions.");
  values.set("[data-debug-id='task-manager-timezone']", "Europe/Riga");
  values.set("[data-debug-id='task-manager-max-run-seconds']", "600");
  values.set("[data-debug-id='task-manager-trigger-once']", "2030-01-01T09:00");
  values.set("[data-debug-id='task-manager-trigger-time']", "09:00");
  values.set("[data-debug-id='task-manager-trigger-month-day']", "1");
  values.set("[data-debug-id='task-manager-vault-grant']", "vault-grant-fixture");
  values.set("[data-debug-id='task-manager-environment']", "local");
  values.set("[data-debug-id='task-manager-missed-run-policy']", "needsAttention");
  values.set("[data-debug-id='task-manager-notification-policy']", "attentionOnly");
  values.set("[data-debug-id='task-manager-model-grok']", "providerDefault");
}

function displayed(selector: string): boolean {
  if (selector === "[data-debug-id='vault-workspace-modal']") return vaultOpen;
  if (selector === "[data-debug-id='header-tasks']") return true;
  if (selector === "[data-debug-id='header-tasks-attention']") return attention;
  if (selector === "[data-debug-id='composer-create-task']") return !managerOpen;
  if (selector === "[data-debug-id='task-manager']" || selector === "[data-debug-id='task-manager-backdrop']") return managerOpen;
  if (!managerOpen) return false;
  if (selector === "[data-task-manager-feedback-state='action']") return feedbackAction;
  if (selector === "[data-debug-id='task-manager-empty']") return !definitionVisible();
  if (selector === "[data-debug-id='task-manager-definition-task-fixture-001']") return definitionVisible();
  if (selector === "[data-debug-id='task-manager-definition-task-fixture-001'][aria-current='true']") return definitionVisible() && selected;
  if (selector === "[data-debug-id='task-manager-definition-task-fixture-copy']") return duplicate;
  if (selector.startsWith("[data-debug-id='task-manager-filter-")) return true;
  if ([
    "[data-debug-id='task-manager-search']", "[data-debug-id='task-manager-project-filter']",
    "[data-debug-id='task-manager-environment-filter']", "[data-debug-id='task-manager-provider-filter']",
    "[data-debug-id='task-manager-close']",
  ].includes(selector)) return true;
  if (!selected || deleted) return false;
  if (selector === "[data-debug-id='task-manager-review']" || selector === "[data-debug-id='task-manager-edit-details']") return !editing;
  if (selector === "[data-debug-id='task-manager-review-details']") return editing;
  if (selector === "[data-debug-id='task-manager-attachment-binding']" || selector === "[data-debug-id='task-manager-remove-attachment']") return editing && attachment;
  if (selector === "[data-debug-id='task-manager-workflow-binding']" || selector === "[data-debug-id='task-manager-remove-workflow']") return editing && workflow;
  if (["[data-debug-id='task-manager-vault-binding']", "[data-debug-id='task-manager-vault-grant']", "[data-debug-id='task-manager-remove-vault-requirement']"].includes(selector)) return editing && vaultRequirement;
  if (selector === "[data-debug-id='task-manager-attention-item']" || selector === "[data-debug-id='task-manager-acknowledge-attention']") return attention;
  if (selector === "[data-debug-id='task-manager-trigger-once']") return editing && triggerKind === "once";
  if (selector === "[data-debug-id='task-manager-trigger-time']") return editing && ["daily", "weekdays", "weekly", "monthly"].includes(triggerKind);
  if (selector === "[data-debug-id='task-manager-trigger-month-day']") return editing && triggerKind === "monthly";
  if (selector === "[data-debug-id='task-manager-weekday-tuesday']") return editing && triggerKind === "weekly";
  if (selector === "[data-debug-id='task-manager-model-codex-cli']") return editing && activeProviders.includes("codex-cli");
  if (selector === "[data-debug-id='task-manager-model-grok']") return editing && activeProviders.includes("grok");
  if (/^\[data-debug-id='task-manager-provider-(grok|codex-cli)-(toggle|move-up|move-down|remove)'\]$/.test(selector)) {
    if (!editing) return false;
    if (selector.endsWith("-toggle']")) return true;
    const provider = selector.includes("codex-cli") ? "codex-cli" : "grok";
    return activeProviders.includes(provider);
  }
  if (selector === "[data-debug-id='task-manager-cancel-run-run-fixture-running']") return running;
  if (selector === "[data-debug-id='task-manager-open-run-run-fixture-completed']") return true;
  if (selector === "[data-debug-id='task-manager-run-run-fixture-manual']") return manualRun;
  if (selector === "[data-debug-id='task-manager-action-save-changes']") return editing;
  if (selector === "[data-debug-id='task-manager-action-confirm-delete']") return deleteArmed;
  if (selector === "[data-debug-id='task-manager-action-delete']") return !deleteArmed;
  if (selector.startsWith("[data-debug-id='task-manager-action-")) return true;
  if (!editing) return false;
  return [
    "[data-debug-id='task-manager-name']", "[data-debug-id='task-manager-instruction']",
    "[data-debug-id='task-manager-success-criteria']", "[data-debug-id='task-manager-enabled']",
    "[data-debug-id='task-manager-open-vault']", "[data-debug-id='task-manager-trigger-kind']", "[data-debug-id='task-manager-schedule-advanced']",
    "[data-debug-id='task-manager-timezone']", "[data-debug-id='task-manager-missed-run-policy']",
    "[data-debug-id='task-manager-max-run-seconds']", "[data-debug-id='task-manager-notification-policy']",
    "[data-debug-id='task-manager-environment']", "[data-debug-id='task-manager-recheck']",
  ].includes(selector);
}

function click(selector: string): void {
  const filter = selector.match(/^\[data-debug-id='task-manager-filter-([^']+)'\]$/)?.[1];
  if (filter) stateFilter = filter;
  else if (selector === "[data-debug-id='header-tasks']" || selector === "[data-debug-id='composer-create-task']") {
    previousFocusSelector = selector;
    managerOpen = true;
    focusedSelector = "[data-debug-id='task-manager-close']";
  }
  else if (selector === "[data-debug-id='task-manager-definition-task-fixture-001']") selected = true;
  else if (selector === "[data-debug-id='task-manager-edit-details']") editing = true;
  else if (selector === "[data-debug-id='task-manager-review-details']") editing = false;
  else if (selector === "[data-debug-id='task-manager-enabled']") enabled = !enabled;
  else if (selector === "[data-debug-id='task-manager-remove-attachment']") attachment = false;
  else if (selector === "[data-debug-id='task-manager-remove-workflow']") workflow = false;
  else if (selector === "[data-debug-id='task-manager-remove-vault-requirement']") vaultRequirement = false;
  else if (selector === "[data-debug-id='task-manager-weekday-tuesday']") weekdayTuesday = !weekdayTuesday;
  else if (selector === "[data-debug-id='task-manager-recheck']") feedbackAction = true;
  else if (selector === "[data-debug-id='task-manager-provider-codex-cli-toggle']") activeProviders.push("codex-cli");
  else if (selector === "[data-debug-id='task-manager-provider-codex-cli-move-up']") activeProviders = ["codex-cli", "grok"];
  else if (selector === "[data-debug-id='task-manager-provider-codex-cli-move-down']") activeProviders = ["grok", "codex-cli"];
  else if (selector === "[data-debug-id='task-manager-provider-codex-cli-remove']") activeProviders = activeProviders.filter((provider) => provider !== "codex-cli");
  else if (selector === "[data-debug-id='task-manager-acknowledge-attention']") attention = false;
  else if (selector === "[data-debug-id='task-manager-cancel-run-run-fixture-running']") running = false;
  else if (selector === "[data-debug-id='task-manager-open-run-run-fixture-completed']") feedbackAction = true;
  else if (selector === "[data-debug-id='task-manager-action-duplicate']") duplicate = true;
  else if (selector === "[data-debug-id='task-manager-action-delete']") deleteArmed = true;
  else if (selector === "[data-debug-id='task-manager-action-confirm-delete']") { deleted = true; deleteArmed = false; }
  else if (selector === "[data-debug-id='task-manager-action-pause']") paused = true;
  else if (selector === "[data-debug-id='task-manager-action-resume']") paused = false;
  else if (selector === "[data-debug-id='task-manager-action-run-now']") manualRun = true;
  else if (selector === "[data-debug-id='task-manager-action-save-changes']") { feedbackAction = true; editing = false; }
  else if (selector === "[data-debug-id='task-manager-open-vault']") vaultOpen = true;
  else if (selector === "[data-debug-id='task-manager-close']" || selector === "[data-debug-id='task-manager-backdrop']") {
    managerOpen = false;
    focusedSelector = previousFocusSelector;
  }
}

function applyKeyChord(keys: string[]): void {
  const target = keys.find((key) => !["\uE008", "Shift", "shift"].includes(key));
  if (target === "\uE00C") {
    if (managerOpen) {
      managerOpen = false;
      focusedSelector = previousFocusSelector;
    }
    return;
  }
  if (target !== "\uE004" || !managerOpen) return;
  const reverse = keys.some((key) => ["\uE008", "Shift", "shift"].includes(key));
  if (reverse) {
    focusedSelector = focusedSelector === "[data-debug-id='task-manager-close']"
      ? "[data-debug-id='task-manager-action-run-now']"
      : "[data-debug-id='task-manager-close']";
    return;
  }
  focusedSelector = focusedSelector === "[data-debug-id='task-manager-action-run-now']"
    ? "[data-debug-id='task-manager-close']"
    : focusedSelector === "[data-debug-id='task-manager-close']"
      ? "[data-debug-id='task-manager-search']"
      : "[data-debug-id='task-manager-close']";
}

function disabledFor(selector: string): boolean {
  if (selector === "[data-debug-id='task-manager-action-pause']") return paused;
  if (selector === "[data-debug-id='task-manager-action-resume']") return !paused;
  const order = selector.match(/^\[data-debug-id='task-manager-provider-(grok|codex-cli)-move-(up|down)'\]$/);
  if (order) {
    const index = activeProviders.indexOf(order[1]!);
    return order[2] === "up" ? index <= 0 : index === activeProviders.length - 1;
  }
  return false;
}

function pressedFor(selector: string): boolean {
  const filter = selector.match(/^\[data-debug-id='task-manager-filter-([^']+)'\]$/)?.[1];
  if (filter) return stateFilter === filter;
  if (selector === "[data-debug-id='task-manager-weekday-tuesday']") return weekdayTuesday;
  const provider = selector.match(/^\[data-debug-id='task-manager-provider-(grok|codex-cli)-toggle'\]$/)?.[1];
  return provider ? activeProviders.includes(provider) : false;
}

function titleFor(selector: string): string {
  if (selector === "[data-debug-id='task-manager-close']") return "Close Task Manager (Esc)";
  return disabledFor(selector) ? "This action is unavailable." : "Task Manager fixture action";
}

function definitionVisible(): boolean {
  return !deleted && search !== "no-owned-match"
    && ["all", "needsAttention"].includes(stateFilter)
    && ["all", "ShellX"].includes(projectFilter)
    && ["all", "local"].includes(environmentFilter)
    && ["all", "grok"].includes(providerFilter);
}

function textSelector(selector: string): boolean {
  return [
    "[data-debug-id='task-manager-search']", "[data-debug-id='task-manager-name']",
    "[data-debug-id='task-manager-instruction']", "[data-debug-id='task-manager-success-criteria']",
    "[data-debug-id='task-manager-timezone']", "[data-debug-id='task-manager-max-run-seconds']",
    "[data-debug-id='task-manager-trigger-once']", "[data-debug-id='task-manager-trigger-time']",
    "[data-debug-id='task-manager-trigger-month-day']",
  ].includes(selector);
}

function selectSelector(selector: string): boolean {
  return [
    "[data-debug-id='task-manager-project-filter']", "[data-debug-id='task-manager-environment-filter']",
    "[data-debug-id='task-manager-provider-filter']", "[data-debug-id='task-manager-vault-grant']",
    "[data-debug-id='task-manager-trigger-kind']", "[data-debug-id='task-manager-missed-run-policy']",
    "[data-debug-id='task-manager-notification-policy']", "[data-debug-id='task-manager-environment']",
    "[data-debug-id='task-manager-model-grok']", "[data-debug-id='task-manager-model-codex-cli']",
  ].includes(selector);
}

function setSelectValue(selector: string, input: string): void {
  const mappings: Record<string, Record<string, string>> = {
    "[data-debug-id='task-manager-project-filter']": { ShellX: "ShellX" },
    "[data-debug-id='task-manager-environment-filter']": { "This computer": "local" },
    "[data-debug-id='task-manager-provider-filter']": { Grok: "grok" },
    "[data-debug-id='task-manager-vault-grant']": { "Select active grant…": "", "Browser fill · https://example.invalid · vault-grant-fixture": "vault-grant-fixture" },
    "[data-debug-id='task-manager-trigger-kind']": { Once: "once", Daily: "daily", Weekly: "weekly", Monthly: "monthly" },
    "[data-debug-id='task-manager-missed-run-policy']": { "Run once when ShellX opens": "runOnceWhenAvailable" },
    "[data-debug-id='task-manager-notification-policy']": { "After every result": "everyTerminalResult" },
    "[data-debug-id='task-manager-environment']": { "Remote Windows · ssh / Windows": "remote-windows" },
    "[data-debug-id='task-manager-model-grok']": { "Grok fixture fast · verified": "grok-fixture-fast" },
  };
  const value = mappings[selector]?.[input];
  if (value === undefined) throw new Error(`unknown Task Manager fixture option ${selector} ${input}`);
  setValue(selector, value);
  if (selector === "[data-debug-id='task-manager-trigger-kind']") triggerKind = value;
  if (selector === "[data-debug-id='task-manager-project-filter']") projectFilter = value;
  if (selector === "[data-debug-id='task-manager-environment-filter']") environmentFilter = value;
  if (selector === "[data-debug-id='task-manager-provider-filter']") providerFilter = value;
  if (selector === "[data-debug-id='task-manager-environment']") activeProviders = [];
}

function valueFor(selector: string): string {
  if (selector === "[data-debug-id='task-manager-search']") return search;
  if (selector === "[data-debug-id='task-manager-project-filter']") return projectFilter;
  if (selector === "[data-debug-id='task-manager-environment-filter']") return environmentFilter;
  if (selector === "[data-debug-id='task-manager-provider-filter']") return providerFilter;
  if (selector === "[data-debug-id='task-manager-trigger-kind']") return triggerKind;
  return values.get(selector) ?? "";
}

function setValue(selector: string, value: string): void {
  if (selector === "[data-debug-id='task-manager-search']") search = value;
  else values.set(selector, value);
}

candidate.listen(0, "127.0.0.1", () => {
  webdriver.listen(0, "127.0.0.1", () => {
    writeFileSync(stateOut, `${JSON.stringify({ candidatePort: address(candidate).port, webdriverPort: address(webdriver).port })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => candidate.close(() => webdriver.close(() => process.exit(0))));

function element(selector: string): Record<string, string> {
  return { "element-6066-11e4-a52e-4f735466cecf": `selector:${Buffer.from(selector).toString("base64url")}` };
}

function elementSelector(value: string): string {
  const id = decodeURIComponent(value);
  if (!id.startsWith("selector:")) throw new Error("fixture element id is invalid");
  return Buffer.from(id.slice("selector:".length), "base64url").toString("utf8");
}

function address(server: typeof candidate): { port: number } {
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

function keyDownValues(body: Record<string, unknown>): string[] {
  const sources = Array.isArray(body.actions) ? body.actions : [];
  const source = sources.find((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && (value as Record<string, unknown>).type === "key");
  const actions = Array.isArray(source?.actions) ? source.actions : [];
  const values = actions.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const action = value as Record<string, unknown>;
    return action.type === "keyDown" && typeof action.value === "string" ? [action.value] : [];
  });
  if (values.length === 0 || values.length > 8) throw new Error("fixture key chord must contain one to eight keyDown values");
  return values;
}

function webdriverValue(response: ServerResponse, value: unknown): void { json(response, 200, { value }); }
function webdriverError(response: ServerResponse, status: number, error: string, message: string): void { json(response, status, { value: { error, message, stacktrace: "" } }); }
function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function requiredArg(name: string): string { const index = args.indexOf(name); const value = index >= 0 ? args[index + 1] : undefined; if (!value?.trim()) throw new Error(`${name} is required`); return value.trim(); }
