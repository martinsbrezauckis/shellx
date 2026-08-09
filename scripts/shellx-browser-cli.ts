import { readFileSync } from "node:fs";
import { resolveShellxDebugApiConnection } from "./shellx-debug-paths";

type JsonObject = Record<string, unknown>;
type FlagValue = string | true;

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, FlagValue>;
}

interface DebugApiConnection {
  base: string;
  token: string;
}

async function readDebugApiConnection(flags: Record<string, FlagValue>): Promise<DebugApiConnection> {
  return resolveShellxDebugApiConnection({
    base: stringFlag(flags, "base"),
    port: stringFlag(flags, "port"),
    token: stringFlag(flags, "token"),
  });
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, FlagValue> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const flag = arg.slice(2);
    const equalsAt = flag.indexOf("=");
    if (equalsAt >= 0) {
      flags[flag.slice(0, equalsAt)] = flag.slice(equalsAt + 1);
      continue;
    }
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[flag] = next;
      i += 1;
    } else {
      flags[flag] = true;
    }
  }
  return { command, positional, flags };
}

function stringFlag(flags: Record<string, FlagValue>, key: string): string | null {
  const value = flags[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function boolFlag(flags: Record<string, FlagValue>, key: string): boolean {
  const value = flags[key];
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function numberFlag(flags: Record<string, FlagValue>, key: string): number | null {
  const value = stringFlag(flags, key);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function requiredPositiveIntegerFlag(
  flags: Record<string, FlagValue>,
  keys: string[],
  label: string,
): number {
  const value = keys.map((key) => numberFlag(flags, key)).find((item) => item !== null) ?? null;
  if (value === null || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requiredNumberPositional(parsed: ParsedArgs, index: number, name: string): number {
  const raw = requiredPositional(parsed, index, name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function objectValue(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function isJsonObject(value: JsonObject | null): value is JsonObject {
  return Boolean(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter((item): item is string => Boolean(item));
}

function numberValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function commonActionFields(flags: Record<string, FlagValue>): JsonObject {
  return cleanBody({
    browserTabId: stringFlag(flags, "tab") ?? stringFlag(flags, "browser-tab-id"),
    taskId: stringFlag(flags, "task") ?? stringFlag(flags, "task-id"),
    selector: stringFlag(flags, "selector"),
    lockLeaseId: stringFlag(flags, "lease") ?? stringFlag(flags, "lock-lease-id"),
    ownerAgentId: stringFlag(flags, "owner-agent") ?? stringFlag(flags, "owner-agent-id"),
    ownerRunId: stringFlag(flags, "owner-run") ?? stringFlag(flags, "owner-run-id"),
  });
}

function cleanBody(body: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

async function callDebugApi<T>(
  connection: DebugApiConnection,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const callerId = shellxHostCallerId();
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(callerId ? { "x-shellx-mcp-caller-id": callerId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text.trim() ? JSON.parse(text) as unknown : {};
  if (!response.ok) {
    const message = typeof parsed === "object" && parsed && "error" in parsed
      ? String((parsed as { error?: unknown }).error)
      : text;
    throw new Error(`${method} ${path} failed with HTTP ${response.status}: ${message}`);
  }
  return parsed as T;
}

function shellxHostCallerId(): string | null {
  const value = process.env.SHELLX_HOST_MCP_TAB_ID?.trim() ?? "";
  return value && value.length <= 200 ? value : null;
}

async function runCommand(parsed: ParsedArgs): Promise<unknown> {
  if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
    return { usage: usageLines() };
  }

  const connection = await readDebugApiConnection(parsed.flags);
  switch (parsed.command) {
    case "check": {
      const query = new URLSearchParams({ timeoutMs: String(Math.min(120_000, Math.floor(numberFlag(parsed.flags, "timeout-ms") ?? numberFlag(parsed.flags, "timeoutMs") ?? 0))) });
      const taskId = stringFlag(parsed.flags, "task") ?? stringFlag(parsed.flags, "task-id");
      const browserTabId = stringFlag(parsed.flags, "tab") ?? stringFlag(parsed.flags, "browser-tab-id");
      if (taskId) query.set("taskId", taskId);
      if (browserTabId) query.set("browserTabId", browserTabId);
      return callDebugApi(connection, "GET", `/browser/check?${query}`);
    }
    case "rendered-check": {
      const url = requiredPositional(parsed, 0, "url");
      const expectedDomains = stringFlag(parsed.flags, "expected-domains")
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      return callDebugApi(connection, "POST", "/browser/rendered-check", cleanBody({
        url,
        expectText: stringFlag(parsed.flags, "expect-text"),
        titleIncludes: stringFlag(parsed.flags, "title-includes"),
        selector: stringFlag(parsed.flags, "selector"),
        caseSensitive: boolFlag(parsed.flags, "case-sensitive") || undefined,
        timeoutMs: numberFlag(parsed.flags, "timeout-ms"),
        settleMs: numberFlag(parsed.flags, "settle-ms"),
        expectedDomains: expectedDomains?.length ? expectedDomains : undefined,
      }));
    }
    case "snapshot":
      return callDebugApi(connection, "GET", "/browser/state");
    case "tabs":
      return callDebugApi(connection, "GET", "/browser/tabs");
    case "locks": {
      const tabs = await callDebugApi<{ tabs?: Array<JsonObject> }>(connection, "GET", "/browser/tabs");
      return {
        locks: (tabs.tabs ?? [])
          .filter((tab) => Boolean(tab.lock))
          .map((tab) => ({
            browserTabId: tab.browserTabId,
            taskId: tab.taskId,
            url: tab.url,
            lock: tab.lock,
          })),
      };
    }
    case "navigate": {
      const url = requiredPositional(parsed, 0, "url");
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "navigate",
        url,
      });
    }
    case "observe":
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "observe",
      });
    case "click-ref": {
      const refId = requiredPositional(parsed, 0, "refId");
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "clickRef",
        refId,
      });
    }
    case "click-at": {
      const xFlag = numberFlag(parsed.flags, "x");
      const yFlag = numberFlag(parsed.flags, "y");
      if ((xFlag === null) !== (yFlag === null)) {
        throw new Error("click-at requires both --x and --y, or positional x y");
      }
      const x = xFlag ?? requiredNumberPositional(parsed, 0, "x");
      const y = yFlag ?? requiredNumberPositional(parsed, 1, "y");
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "clickAt",
        x,
        y,
      });
    }
    case "fill-ref": {
      const refId = requiredPositional(parsed, 0, "refId");
      const value = requiredPositional(parsed, 1, "value");
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "fillRef",
        refId,
        value,
      });
    }
    case "type-text": {
      const xFlag = numberFlag(parsed.flags, "x");
      const yFlag = numberFlag(parsed.flags, "y");
      if ((xFlag === null) !== (yFlag === null)) {
        throw new Error("type-text requires both --x and --y, or positional x y");
      }
      const x = xFlag ?? requiredNumberPositional(parsed, 0, "x");
      const y = yFlag ?? requiredNumberPositional(parsed, 1, "y");
      const value = requiredPositional(parsed, xFlag === null ? 2 : 0, "value");
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "typeText",
        x,
        y,
        value,
      });
    }
    case "fill-from-vault": {
      const refId = requiredPositional(parsed, 0, "refId");
      const grantId = requiredPositional(parsed, 1, "grantId");
      const secretRef = requiredPositional(parsed, 2, "secretRef");
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "fillFromVaultGrant",
        refId,
        grantId,
        secretRef,
      });
    }
    case "wait-for": {
      const key = requiredPositional(parsed, 0, "key");
      const value = requiredPositional(parsed, 1, "value");
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "waitFor",
        key,
        value,
      });
    }
    case "extract": {
      const format = requiredPositional(parsed, 0, "text|markdown|table");
      const action = extractActionFromFormat(format);
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action,
      });
    }
    case "verify": {
      const key = requiredPositional(parsed, 0, "key");
      const value = requiredPositional(parsed, 1, "value");
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "verify",
        key,
        value,
      });
    }
    case "screenshot":
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "captureScreenshot",
        fullPage: boolFlag(parsed.flags, "full-page") || boolFlag(parsed.flags, "fullPage"),
      });
    case "clear-site-data":
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "clearSiteData",
      });
    case "dialogs": {
      const limit = stringFlag(parsed.flags, "limit") ?? "20";
      return callDebugApi(connection, "GET", `/browser/dialogs?limit=${encodeURIComponent(limit)}`);
    }
    case "resolve-dialog": {
      const dialogId = requiredPositional(parsed, 0, "dialogId");
      const taskId = stringFlag(parsed.flags, "task") ?? stringFlag(parsed.flags, "task-id");
      if (!taskId) throw new Error("resolve-dialog requires --task <taskId>");
      const action = stringFlag(parsed.flags, "action") ?? "dismiss";
      if (!["accept", "dismiss"].includes(action)) {
        throw new Error("resolve-dialog --action must be accept or dismiss");
      }
      return callDebugApi(connection, "POST", "/browser/dialogs/resolve", {
        dialogId,
        taskId,
        action,
      });
    }
    case "trace-open":
      return callDebugApi(connection, "POST", "/browser/trace/export", cleanBody({
        taskId: stringFlag(parsed.flags, "task") ?? stringFlag(parsed.flags, "task-id"),
        browserTabId: stringFlag(parsed.flags, "tab") ?? stringFlag(parsed.flags, "browser-tab-id"),
        reason: stringFlag(parsed.flags, "reason") ?? "ShellX Browser CLI trace-open",
      }));
    case "flight-recorder-export":
      return callDebugApi(connection, "POST", "/browser/flight-recorder/export", cleanBody({
        taskId: stringFlag(parsed.flags, "task") ?? stringFlag(parsed.flags, "task-id"),
        browserTabId: stringFlag(parsed.flags, "tab") ?? stringFlag(parsed.flags, "browser-tab-id"),
        suiteId: stringFlag(parsed.flags, "suite") ?? stringFlag(parsed.flags, "suite-id"),
        attemptIndex: numberFlag(parsed.flags, "attempt-index") ?? numberFlag(parsed.flags, "attemptIndex"),
        group: stringFlag(parsed.flags, "group"),
        reason: stringFlag(parsed.flags, "reason") ?? "ShellX Browser CLI Flight Recorder export",
      }));
    case "workflow-evaluate":
      return workflowEvaluate(connection, parsed.flags);
    case "run-steps":
      return runSteps(connection, parsed.flags);
    case "workflow-bookmarks":
      return workflowBookmarks(connection, parsed.flags);
    case "workflow-save":
      return workflowSave(connection, parsed.flags);
    case "workflow-replay":
      return workflowReplay(connection, parsed.flags);
    default:
      throw new Error(`Unknown ShellX Browser command: ${parsed.command}`);
  }
}

function browserAction(connection: DebugApiConnection, body: JsonObject): Promise<unknown> {
  return callDebugApi(connection, "POST", "/browser/action", body);
}

function parseEvaluationAttempts(flags: Record<string, FlagValue>): JsonObject[] {
  const inline = stringFlag(flags, "attempts-json") ?? stringFlag(flags, "attemptsJson");
  const file = stringFlag(flags, "attempts-file") ?? stringFlag(flags, "attemptsFile");
  if (inline && file) {
    throw new Error("workflow-evaluate accepts either --attempts-json or --attempts-file, not both");
  }
  const raw = inline ?? (file ? readFileSync(file, "utf8") : null);
  if (!raw) {
    throw new Error("workflow-evaluate requires --attempts-json <json> or --attempts-file <path>");
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("workflow-evaluate attempts JSON must be an array");
  return parsed.map((attempt, index) => {
    const object = objectValue(attempt);
    if (!object) throw new Error(`workflow-evaluate attempt ${index} must be an object`);
    return { ...object };
  });
}

async function workflowEvaluate(
  connection: DebugApiConnection,
  flags: Record<string, FlagValue>,
): Promise<unknown> {
  const suiteId = stringFlag(flags, "suite") ?? stringFlag(flags, "suite-id");
  if (!suiteId) throw new Error("workflow-evaluate requires --suite <suiteId>");
  const evaluatedAtMs = requiredPositiveIntegerFlag(
    flags,
    ["evaluated-at-ms", "evaluatedAtMs"],
    "workflow-evaluate --evaluated-at-ms",
  );
  return callDebugApi(connection, "POST", "/browser/evaluations", cleanBody({
    suiteId,
    evaluatedAtMs,
    taskId: stringFlag(flags, "task") ?? stringFlag(flags, "task-id"),
    baselineLabel: stringFlag(flags, "baseline-label") ?? stringFlag(flags, "baselineLabel"),
    candidateLabel: stringFlag(flags, "candidate-label") ?? stringFlag(flags, "candidateLabel"),
    attempts: parseEvaluationAttempts(flags),
    reason: stringFlag(flags, "reason") ?? "ShellX Browser CLI workflow evaluation",
  }));
}

function runStepAction(action: unknown): string {
  if (typeof action !== "string" || !action.trim()) {
    throw new Error("run-steps step requires action");
  }
  switch (action.trim()) {
    case "navigate": return "navigate";
    case "observe": return "observe";
    case "clickRef":
    case "click": return "clickRef";
    case "fillRef": return "fillRef";
    case "press":
    case "pressKey": return "press";
    case "scroll": return "scroll";
    case "select": return "select";
    case "goBack":
    case "back": return "goBack";
    case "goForward":
    case "forward": return "goForward";
    case "reload":
    case "refresh": return "reload";
    case "waitFor": return "waitFor";
    case "verify": return "verify";
    case "findText": return "findText";
    case "extractText": return "extractText";
    case "extractMarkdown": return "extractMarkdown";
    case "extractTable": return "extractTable";
    case "captureScreenshot":
    case "screenshot": return "captureScreenshot";
    case "fillFromVaultGrant":
    case "fillProfileCardGrant":
    case "capturePageSecretToVault":
    case "readEmailCodeGrant":
    case "useAgentWalletGrant":
      throw new Error(`run-steps rejected unsupported sensitive Browser action '${action.trim()}'; use the dedicated CLI/MCP tool instead`);
    default:
      throw new Error(`run-steps rejected unsupported Browser action '${action.trim()}'`);
  }
}

function parseRunSteps(flags: Record<string, FlagValue>): JsonObject[] {
  const inline = stringFlag(flags, "steps-json") ?? stringFlag(flags, "stepsJson");
  const file = stringFlag(flags, "steps-file") ?? stringFlag(flags, "stepsFile");
  if (inline && file) throw new Error("run-steps accepts either --steps-json or --steps-file, not both");
  const raw = inline ?? (file ? readFileSync(file, "utf8") : null);
  if (!raw) throw new Error("run-steps requires --steps-json <json> or --steps-file <path>");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("run-steps JSON must be an array of step objects");
  return parsed.map((step, index) => {
    const object = objectValue(step);
    if (!object) throw new Error(`run-steps step ${index} must be an object`);
    return { ...object };
  });
}

function addIfMissing(body: JsonObject, key: string, value: unknown): void {
  if (body[key] !== undefined || value === undefined || value === null || value === "") return;
  body[key] = value;
}

function normalizeRunStep(step: JsonObject, common: JsonObject): JsonObject {
  const action = runStepAction(step.action);
  const body: JsonObject = { ...step, action };
  if (action === "findText" && !stringValue(body.value)) {
    const query = stringValue(body.query) ?? stringValue(body.q) ?? stringValue(body.text);
    if (query) body.value = query;
  }
  delete body.query;
  delete body.q;
  delete body.text;
  for (const [key, value] of Object.entries(common)) addIfMissing(body, key, value);
  return cleanBody(body);
}

function runStepsSummaryEntry(index: number, action: string, response: unknown): JsonObject {
  const data = objectValue(response) ?? {};
  const ok = typeof data.ok === "boolean" ? data.ok : true;
  return cleanBody({
    index,
    action,
    ok,
    status: stringValue(data.status) ?? "unknown",
    taskId: stringValue(data.taskId),
    currentUrl: stringValue(data.currentUrl),
    failureKind: ok ? undefined : "action",
    error: ok ? undefined : stringValue(data.error) ?? stringValue(data.message)
      ?? `Browser action returned status ${stringValue(data.status) ?? "unknown"}`,
  });
}

function runStepsAggregate(results: JsonObject[]): {
  succeeded: number;
  failed: number;
  continuedAfterFailure: boolean;
  failures: JsonObject[];
} {
  let succeeded = 0;
  let failed = 0;
  let sawFailure = false;
  let continuedAfterFailure = false;
  const failures: JsonObject[] = [];
  for (const result of results) {
    if (sawFailure) continuedAfterFailure = true;
    if (result.ok === true) {
      succeeded += 1;
      continue;
    }
    failed += 1;
    sawFailure = true;
    const status = stringValue(result.status) ?? "unknown";
    failures.push(cleanBody({
      index: result.index,
      action: result.action,
      status,
      failureKind: stringValue(result.failureKind) ?? "action",
      error: stringValue(result.error) ?? `Browser action returned status ${status}`,
    }));
  }
  return { succeeded, failed, continuedAfterFailure, failures };
}

function shouldWaitForCliBrowserSettle(action: string, response: unknown): boolean {
  const data = objectValue(response) ?? {};
  const ok = typeof data.ok === "boolean" ? data.ok : true;
  return ok && ["navigate", "goBack", "goForward", "reload"].includes(action);
}

function runStepsUsesExplicitTarget(flags: Record<string, FlagValue>): boolean {
  return Boolean(
    stringFlag(flags, "task") ||
      stringFlag(flags, "task-id") ||
      stringFlag(flags, "tab") ||
      stringFlag(flags, "browser-tab-id") ||
      boolFlag(flags, "use-active-tab") ||
      boolFlag(flags, "active-tab"),
  );
}

function firstRunStepsNavigateUrl(steps: JsonObject[]): string | null {
  for (const step of steps) {
    const action = typeof step.action === "string" ? step.action.trim() : "";
    if (action !== "navigate") continue;
    const url = stringValue(step.url);
    if (url) return url;
  }
  return null;
}

async function ensureRunStepsTask(
  connection: DebugApiConnection,
  flags: Record<string, FlagValue>,
  steps: JsonObject[],
  common: JsonObject,
): Promise<{ taskId: string | null; startedTask: JsonObject | null }> {
  const explicitTaskId = stringFlag(flags, "task") ?? stringFlag(flags, "task-id");
  if (explicitTaskId) return { taskId: explicitTaskId, startedTask: null };
  if (runStepsUsesExplicitTarget(flags)) return { taskId: null, startedTask: null };

  const startUrl = firstRunStepsNavigateUrl(steps);
  const startSiteKey = siteKeyFromUrl(startUrl);
  const expectedDomains = commaListFlag(flags, "expected-domains") ??
    commaListFlag(flags, "expectedDomains") ??
    (startSiteKey ? [startSiteKey] : undefined);
  const startedTask = await callDebugApi<JsonObject>(connection, "POST", "/browser/task/start", cleanBody({
    goal: stringFlag(flags, "goal") ?? "ShellX Browser CLI run-steps",
    startUrl,
    profileId: stringFlag(flags, "profile") ?? stringFlag(flags, "profile-id") ?? "agent-work",
    autonomy: stringFlag(flags, "autonomy") ?? "assistedAutonomous",
    expectedDomains,
    blockedDomains: commaListFlag(flags, "blocked-domains") ?? commaListFlag(flags, "blockedDomains"),
  }));
  const taskId = stringValue(startedTask.taskId);
  if (!taskId) throw new Error("run-steps could not start an agent Browser task");
  addIfMissing(common, "taskId", taskId);
  return { taskId, startedTask };
}

async function waitForCliBrowserSettle(
  connection: DebugApiConnection,
  taskId: string | null,
  timeoutMs: number,
): Promise<void> {
  const query = new URLSearchParams({ timeoutMs: String(Math.min(120_000, Math.floor(timeoutMs))) });
  if (taskId) query.set("taskId", taskId);
  const settle = await callDebugApi<{ settled?: boolean }>(connection, "GET", `/browser/settle?${query}`);
  if (settle.settled) return;
  throw new Error("run-steps timed out waiting for Browser navigation to settle");
}

async function runSteps(
  connection: DebugApiConnection,
  flags: Record<string, FlagValue>,
): Promise<unknown> {
  const steps = parseRunSteps(flags);
  if (steps.length === 0) throw new Error("run-steps requires at least one step");
  if (steps.length > 20) throw new Error("run-steps accepts at most 20 steps");
  const continueOnError = boolFlag(flags, "continue-on-error") || boolFlag(flags, "continueOnError");
  const timeoutMs = numberFlag(flags, "timeout-ms") ?? numberFlag(flags, "timeoutMs") ?? 30_000;
  const common = cleanBody({
    ...commonActionFields(flags),
    timeoutMs,
  });
  const target = await ensureRunStepsTask(connection, flags, steps, common);
  let carriedTaskId = target.taskId;
  const results: JsonObject[] = [];
  let lastResponse: unknown = null;
  let stoppedAt: number | null = null;
  let stoppedReason: string | null = null;

  for (let index = 0; index < steps.length; index += 1) {
    let body: JsonObject;
    let failureKind = "validation";
    try {
      body = normalizeRunStep(steps[index] ?? {}, common);
      if (!body.taskId && carriedTaskId) body.taskId = carriedTaskId;
      failureKind = "transport";
      const response = await browserAction(connection, body);
      if (!carriedTaskId) carriedTaskId = stringValue(objectValue(response)?.taskId);
      if (shouldWaitForCliBrowserSettle(String(body.action), response)) {
        failureKind = "navigationSettle";
        await waitForCliBrowserSettle(connection, carriedTaskId, timeoutMs);
      }
      lastResponse = response;
      const row = runStepsSummaryEntry(index, String(body.action), response);
      results.push(row);
      if (row.ok === false && !continueOnError) {
        stoppedAt = index;
        stoppedReason = `Browser action returned status ${String(row.status ?? "unknown")}`;
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push(cleanBody({
        index,
        action: typeof steps[index]?.action === "string" ? steps[index]?.action : undefined,
        ok: false,
        status: "error",
        failureKind,
        error: message,
      }));
      if (!continueOnError) {
        stoppedAt = index;
        stoppedReason = message;
        break;
      }
    }
  }

  const aggregate = runStepsAggregate(results);

  return {
    ok: aggregate.failed === 0,
    stepsPlanned: steps.length,
    stepsRun: results.length,
    stepsSucceeded: aggregate.succeeded,
    stepsFailed: aggregate.failed,
    continuedAfterFailure: aggregate.continuedAfterFailure,
    failureSummary: aggregate.failures,
    continueOnError,
    stoppedAt,
    stoppedReason,
    taskId: carriedTaskId,
    startedTask: target.startedTask,
    steps: results,
    lastResponse,
    note: "browser_run_steps style generic batch; sensitive Browser/Vault actions stay on dedicated gated tools",
  };
}

async function workflowBookmarks(
  connection: DebugApiConnection,
  flags: Record<string, FlagValue>,
): Promise<unknown> {
  const state = await callDebugApi<{ bookmarks?: unknown[] }>(connection, "GET", "/browser/bookmarks");
  const site = stringFlag(flags, "site") ?? stringFlag(flags, "site-key") ?? stringFlag(flags, "siteKey");
  const taskType = stringFlag(flags, "task-type") ?? stringFlag(flags, "taskType");
  const target = stringFlag(flags, "target");
  const surface = stringFlag(flags, "surface");
  const secretKind = stringFlag(flags, "secret-kind") ?? stringFlag(flags, "secretKind");
  const query = stringFlag(flags, "query")?.toLowerCase();
  const limit = Math.min(Number(stringFlag(flags, "limit") ?? "20") || 20, 100);
  const workflows = (state.bookmarks ?? [])
    .map(objectValue)
    .filter((bookmark): bookmark is JsonObject => Boolean(bookmark && objectValue(bookmark.agentWorkflow)))
    .map((bookmark) => {
      const workflow = objectValue(bookmark.agentWorkflow) ?? {};
      const url = stringValue(bookmark.url);
      return {
        bookmarkId: stringValue(bookmark.bookmarkId),
        label: stringValue(bookmark.label),
        url,
        category: stringValue(bookmark.category),
        siteKey: stringValue(workflow.siteKey) ?? siteKeyFromUrl(url),
        taskType: stringValue(workflow.taskType),
        target: stringValue(workflow.target),
        surface: stringValue(workflow.surface),
        aliases: stringArrayValue(workflow.aliases),
        permissionsNeeded: stringArrayValue(workflow.permissionsNeeded),
        secretKinds: stringArrayValue(workflow.secretKinds),
        recipeId: stringValue(workflow.recipeId),
        recipePath: stringValue(workflow.recipePath),
        goal: stringValue(workflow.goal),
        steps: workflow.steps,
        health: stringValue(workflow.health),
        driftStatus: stringValue(workflow.driftStatus),
      };
    })
    .filter((workflow) => !site || domainMatches(workflow.siteKey, normalizeSite(site)))
    .filter((workflow) => !taskType || workflow.taskType === workflowTaskType(taskType))
    .filter((workflow) => !target || workflow.target === slug(target))
    .filter((workflow) => !surface || workflow.surface === slug(surface))
    .filter((workflow) => !secretKind || workflow.secretKinds.some((item) => item.toLowerCase() === secretKind.toLowerCase()))
    .filter((workflow) => {
      if (!query) return true;
      return JSON.stringify(workflow).toLowerCase().includes(query);
    })
    .slice(0, limit);
  return { ok: true, count: workflows.length, workflows };
}

function workflowTaskType(value: string): string {
  const normalized = slug(value);
  if (normalized === "signup" || normalized.startsWith("signup-") || normalized.startsWith("sign-up")) {
    return "register";
  }
  if (normalized.startsWith("register") || normalized.startsWith("registration")) {
    return "register";
  }
  if (normalized === "signin" || normalized.startsWith("signin-") || normalized.startsWith("sign-in")) {
    return "login";
  }
  if (normalized.startsWith("log-in") || normalized.startsWith("login")) {
    return "login";
  }
  return normalized;
}

async function workflowReplay(
  connection: DebugApiConnection,
  flags: Record<string, FlagValue>,
): Promise<unknown> {
  let recipePath = stringFlag(flags, "recipe-path") ?? stringFlag(flags, "recipePath");
  const bookmarkId = stringFlag(flags, "bookmark") ?? stringFlag(flags, "bookmark-id") ?? stringFlag(flags, "bookmarkId");
  if (!recipePath && bookmarkId) {
    const discovered = await workflowBookmarks(connection, { ...flags, limit: "100" });
    const workflows = objectValue(discovered)?.workflows;
    if (Array.isArray(workflows)) {
      const workflow = workflows
        .map(objectValue)
        .find((candidate) => stringValue(candidate?.bookmarkId) === bookmarkId);
      recipePath = stringValue(workflow?.recipePath);
    }
  }
  if (!recipePath) throw new Error("workflow-replay requires --recipe-path <path> or --bookmark <bookmarkId>");
  const replay = await callDebugApi<JsonObject>(connection, "POST", "/browser/recipes/replay", cleanBody({
    ...commonActionFields(flags),
    recipePath,
    dryRun: !(boolFlag(flags, "apply") || boolFlag(flags, "no-dry-run")),
    reason: stringFlag(flags, "reason") ?? "ShellX Browser CLI workflow-replay",
  }));
  return {
    ok: booleanValue(replay.ok) ?? true,
    summary: workflowReplaySummary(replay),
    replay,
  };
}

function compactReplayStepResult(step: JsonObject, fallbackIndex: number): JsonObject {
  return cleanBody({
    index: numberValue(step.index) ?? fallbackIndex,
    action: stringValue(step.action),
    ok: booleanValue(step.ok),
    status: stringValue(step.status),
    reason: stringValue(step.reason),
    taskId: stringValue(step.taskId),
    currentUrl: stringValue(step.currentUrl),
  });
}

function compactSkippedStep(step: JsonObject, fallbackIndex: number): JsonObject {
  return cleanBody({
    index: numberValue(step.index) ?? fallbackIndex,
    action: stringValue(step.action),
    reason: stringValue(step.reason),
  });
}

function workflowReplaySummary(replay: JsonObject): JsonObject {
  const stepResults = Array.isArray(replay.stepResults)
    ? replay.stepResults.map(objectValue).filter(isJsonObject).map(compactReplayStepResult)
    : [];
  const skippedSteps = Array.isArray(replay.skippedSteps)
    ? replay.skippedSteps.map(objectValue).filter(isJsonObject).map(compactSkippedStep)
    : [];
  const decisionPoints = Array.isArray(replay.decisionPoints) ? replay.decisionPoints : [];
  const firstSkippedReason = stringValue(skippedSteps[0]?.reason);
  const needsLiveRecovery = skippedSteps.length > 0 || stepResults.some((step) => booleanValue(step.ok) === false);
  return cleanBody({
    ok: booleanValue(replay.ok) ?? true,
    status: stringValue(replay.status),
    dryRun: booleanValue(replay.dryRun),
    taskId: stringValue(replay.taskId),
    browserTabId: stringValue(replay.browserTabId),
    stepsPlanned: numberValue(replay.stepsPlanned) ?? stepResults.length + skippedSteps.length,
    stepsApplied: numberValue(replay.stepsApplied),
    stepsSkipped: numberValue(replay.stepsSkipped) ?? skippedSteps.length,
    decisionPointCount: decisionPoints.length,
    firstSkippedReason,
    needsLiveRecovery,
    stepResults,
    skippedSteps,
  });
}

async function workflowSave(
  connection: DebugApiConnection,
  flags: Record<string, FlagValue>,
): Promise<unknown> {
  const label = stringFlag(flags, "label") ?? stringFlag(flags, "name");
  if (!label) throw new Error("workflow-save requires --label <name>");
  const taskType = stringFlag(flags, "task-type") ?? stringFlag(flags, "taskType");
  if (!taskType) throw new Error("workflow-save requires --task-type <type>");
  const target = stringFlag(flags, "target");
  if (!target) throw new Error("workflow-save requires --target <slug>");
  const reason = stringFlag(flags, "reason") ?? `ShellX Browser CLI workflow-save: ${label}`;
  const recipe = await callDebugApi<JsonObject>(connection, "POST", "/browser/recipes/export", cleanBody({
    taskId: stringFlag(flags, "task") ?? stringFlag(flags, "task-id"),
    browserTabId: stringFlag(flags, "tab") ?? stringFlag(flags, "browser-tab-id"),
    reason,
  }));
  if (Number(recipe.steps ?? 0) <= 0) {
    throw new Error("workflow-save exported no replayable steps; run the Browser task first, then save the workflow");
  }
  const recipePath = stringValue(recipe.path);
  const recipeId = stringValue(recipe.recipeId);
  const state = await callDebugApi<{ activeBrowserTabId?: string; tabs?: JsonObject[] }>(connection, "GET", "/browser/state");
  const tabId = stringFlag(flags, "tab") ?? stringFlag(flags, "browser-tab-id") ?? state.activeBrowserTabId;
  const tab = (state.tabs ?? []).find((item) => stringValue(item.browserTabId) === tabId) ?? (state.tabs ?? [])[0];
  const url = stringFlag(flags, "url") ?? stringValue(tab?.url);
  const siteKey = stringFlag(flags, "site") ?? stringFlag(flags, "site-key") ?? stringFlag(flags, "siteKey") ?? siteKeyFromUrl(url);
  const workflow = cleanBody({
    siteKey,
    taskType: workflowTaskType(taskType),
    target: slug(target),
    surface: stringFlag(flags, "surface") ? slug(stringFlag(flags, "surface") ?? "") : undefined,
    aliases: commaListFlag(flags, "aliases"),
    permissionsNeeded: commaListFlag(flags, "permissions"),
    secretKinds: commaListFlag(flags, "secret-kinds") ?? commaListFlag(flags, "secretKinds"),
    recipeId,
    recipePath,
    goal: label,
    steps: recipe.steps,
    source: "recipe",
    health: "fresh",
    driftStatus: "fresh",
  });
  const bookmark = await callDebugApi<JsonObject>(connection, "POST", "/browser/bookmarks", cleanBody({
    label,
    kind: "link",
    category: "workflow",
    url,
    toolbarPinned: boolFlag(flags, "toolbar-pinned") || boolFlag(flags, "toolbarPinned"),
    agentWorkflow: workflow,
  }));
  return { ok: true, recipe, bookmark };
}

function commaListFlag(flags: Record<string, FlagValue>, key: string): string[] | undefined {
  const value = stringFlag(flags, key);
  if (!value) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeSite(value: string): string {
  try {
    const url = value.includes("://") ? value : `https://${value}`;
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return value.split("/")[0]?.replace(/^www\./, "").toLowerCase() ?? value.toLowerCase();
  }
}

function siteKeyFromUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = value.includes("://") ? value : `https://${value}`;
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function domainMatches(actual: string | null, expected: string): boolean {
  return Boolean(actual && (actual === expected || actual.endsWith(`.${expected}`)));
}

function requiredPositional(parsed: ParsedArgs, index: number, label: string): string {
  const value = parsed.positional[index]?.trim();
  if (!value) throw new Error(`${parsed.command} requires ${label}`);
  return value;
}

function extractActionFromFormat(format: string): string {
  switch (format.trim().toLowerCase()) {
    case "text":
    case "txt":
      return "extractText";
    case "markdown":
    case "md":
      return "extractMarkdown";
    case "table":
    case "tables":
      return "extractTable";
    default:
      throw new Error("extract format must be text, markdown, or table");
  }
}

function usageLines(): string[] {
  return [
    "pnpm shellx-browser check --task <taskId> --timeout-ms 1000",
    "pnpm shellx-browser rendered-check https://example.com --expect-text \"Example Domain\" --selector h1",
    "pnpm shellx-browser snapshot",
    "pnpm shellx-browser navigate https://example.com --tab <browserTabId>",
    "pnpm shellx-browser observe --tab <browserTabId>",
    "pnpm shellx-browser click-ref <refId> --task <taskId>",
    "pnpm shellx-browser click-at 128 240 --task <taskId>",
    "pnpm shellx-browser fill-ref <refId> <value> --task <taskId>",
    "pnpm shellx-browser type-text 128 240 \"hello\" --task <taskId>",
    "pnpm shellx-browser fill-from-vault <refId> <grantId> <secretRef> --task <taskId>",
    "pnpm shellx-browser wait-for text <value>",
    "pnpm shellx-browser extract markdown --selector main",
    "pnpm shellx-browser extract table --selector table",
    "pnpm shellx-browser verify text <value>",
    "pnpm shellx-browser screenshot --full-page --task <taskId>",
    "pnpm shellx-browser clear-site-data --task <taskId>",
    "pnpm shellx-browser dialogs --limit 20",
    "pnpm shellx-browser resolve-dialog <dialogId> --task <taskId> --action accept",
    "pnpm shellx-browser tabs",
    "pnpm shellx-browser locks",
    "pnpm shellx-browser trace-open --task <taskId>",
    "pnpm shellx-browser flight-recorder-export --task <taskId> --suite <suiteId> --group baseline --attempt-index 1",
    "pnpm shellx-browser workflow-evaluate --suite <suiteId> --evaluated-at-ms <unixMs> --task <taskId> --attempts-file <attempts.json>",
    "pnpm shellx-browser run-steps --steps-json '[{\"action\":\"navigate\",\"url\":\"https://example.com\"},{\"action\":\"waitFor\",\"value\":\"Example Domain\"}]'",
    "pnpm shellx-browser run-steps --use-active-tab --steps-json '[{\"action\":\"observe\"}]'",
    "pnpm shellx-browser workflow-bookmarks --site google.com --task-type get --target api-key",
    "pnpm shellx-browser workflow-save --label \"Google API key\" --task-type get --target api-key --site google.com",
    "pnpm shellx-browser workflow-replay --recipe-path <path> --dry-run",
  ];
}

function printResult(result: unknown, pretty: boolean): void {
  console.log(JSON.stringify(result, null, pretty ? 2 : 0));
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const result = await runCommand(parsed);
  printResult(result, parsed.flags.pretty === true);
  if (
    (["run-steps", "rendered-check"].includes(parsed.command) && objectValue(result)?.ok === false) ||
    (parsed.command === "workflow-evaluate" && objectValue(result)?.evidenceComplete !== true)
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
