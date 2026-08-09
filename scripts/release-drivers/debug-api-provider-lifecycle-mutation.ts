import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

const PROVIDER_LIFECYCLE_ROUTES = new Set([
  "POST /connect",
  "POST /provider-adapters/run",
  "POST /provider-sessions/start",
]);

const PROVIDER_CANARY = "SHELLX_RELEASE_PROVIDER_ROUTE_CANARY_035";
const PROVIDER_ADAPTER_PREFLIGHT_ID = "claude-code";
const PROVIDER_ACTION = "activity-ask-agent";
const PROVIDER_ACTION_TAB_ID = `release-provider-action-${PROVIDER_ACTION}`;
const PROVIDER_ACTION_PROMPT = "Verify the isolated ShellX provider session lifecycle fixture.";

type Connection = { base: string; token: string };
type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];

export function isDebugApiProviderLifecycleMutation(name: string): boolean {
  return PROVIDER_LIFECYCLE_ROUTES.has(name);
}

export async function exerciseDebugApiProviderLifecycleMutation(
  connection: Connection,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No installed provider lifecycle transition was observed.",
  };
  const project = assignment.surface.name === "POST /provider-adapters/run"
    ? null
    : assignment.surface.name === "POST /provider-sessions/start"
      ? prepareOwnedProviderActionProject(request, PROVIDER_ACTION)
      : prepareOwnedProviderProject(request);
  const tabId = assignment.surface.name === "POST /provider-sessions/start"
    ? PROVIDER_ACTION_TAB_ID
    : `shellx-release-provider-${randomUUID()}`;
  let grokConnected = false;
  let providerRunId: string | null = null;
  try {
    if (assignment.surface.name === "POST /connect") {
      if (!project) throw new Error("POST /connect fixture project is missing");
      await assertGrokTabAbsent(connection, tabId);
      outcome.present = "pass";
      const response = await postJson(connection, `/connect?tabId=${encodeURIComponent(tabId)}`, {
        tabId,
        cwd: project,
        permissionMode: "plan",
        mcpServers: [],
      }, 60_000);
      outcome.invoke = "pass";
      if (response.status !== 200) throw new Error(`POST /connect returned ${response.status}: ${response.text.slice(0, 500)}`);
      const body = requireObject(response.body, "POST /connect");
      if (body.ok !== true || body.cwd !== project) throw new Error("POST /connect omitted its exact successful cwd contract");
      grokConnected = true;
      const tab = await requireGrokTab(connection, tabId);
      if (tab.cwd !== project || tab.hasActiveChild !== true || tab.isSsh !== false || tab.isWsl !== false) {
        throw new Error("POST /connect did not create the exact active local Grok session");
      }
      const aborted = await postJson(connection, `/abort?tabId=${encodeURIComponent(tabId)}`, {}, 30_000);
      if (aborted.status !== 200) throw new Error(`owned Grok cleanup returned ${aborted.status}`);
      grokConnected = false;
      await assertGrokTabAbsent(connection, tabId);
      outcome.effect = "pass";
      outcome.observedEffect = "POST /connect launched one exact local Grok ACP child in an owned project, exposed that live tab through the installed session registry, and removed it through the tab-scoped abort lifecycle; paths and session identifiers were omitted from the report.";
    } else if (assignment.surface.name === "POST /provider-adapters/run") {
      const eventsBefore = await recentEvents(connection);
      outcome.present = "pass";
      const response = await postJson(
        connection,
        "/provider-adapters/run",
        providerBody("", PROVIDER_ADAPTER_PREFLIGHT_ID),
        30_000,
      );
      outcome.invoke = "pass";
      if (response.status !== 400) throw new Error(`POST /provider-adapters/run returned ${response.status}: ${response.text.slice(0, 500)}`);
      const body = requireObject(response.body, "POST /provider-adapters/run");
      if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["error", "ok", "providerId"])
        || body.ok !== false || body.providerId !== PROVIDER_ADAPTER_PREFLIGHT_ID || body.error !== "cwd is empty") {
        throw new Error("provider adapter run did not preserve its exact no-spawn validation contract");
      }
      const eventsAfter = await recentEvents(connection);
      const startedBefore = countEvents(eventsBefore, "provider-adapter-run-started", PROVIDER_ADAPTER_PREFLIGHT_ID);
      const startedAfter = countEvents(eventsAfter, "provider-adapter-run-started", PROVIDER_ADAPTER_PREFLIGHT_ID);
      const failedBefore = countEvents(eventsBefore, "provider-adapter-run-failed", PROVIDER_ADAPTER_PREFLIGHT_ID);
      const failedAfter = countEvents(eventsAfter, "provider-adapter-run-failed", PROVIDER_ADAPTER_PREFLIGHT_ID);
      const matchingFailure = eventsAfter.some((event) => event.kind === "provider-adapter-run-failed"
        && isRecord(event.payload) && event.payload.providerId === PROVIDER_ADAPTER_PREFLIGHT_ID
        && event.payload.error === "cwd is empty" && event.payload.transport === "local");
      if (startedAfter !== startedBefore + 1 || failedAfter !== failedBefore + 1 || !matchingFailure) {
        throw new Error("provider adapter run did not emit its matching no-spawn lifecycle event pair");
      }
      outcome.effect = "pass";
      outcome.observedEffect = "POST /provider-adapters/run rejected an empty cwd before command resolution or provider launch and emitted the matching bounded start/failure event pair; the final provider-route batch separately proves real provider execution.";
    } else if (assignment.surface.name === "POST /provider-sessions/start") {
      if (!project) throw new Error("POST /provider-sessions/start fixture project is missing");
      await assertProviderTabQuiescent(connection, tabId);
      outcome.present = "pass";
      const response = await postJson(connection, "/provider-sessions/start", {
        tabId,
        providerId: "codex-cli",
        cwd: project,
        prompt: PROVIDER_ACTION_PROMPT,
        includeMcpProbe: false,
        includeShellxTooling: false,
        shellxToolExposure: "off",
        timeoutMs: 15_000,
        persistSession: false,
        resume: false,
        resumeLast: false,
        permissionMode: "readOnly",
        transport: "local",
        releaseFixture: {
          id: "provider-action-lifecycle",
          action: PROVIDER_ACTION,
        },
      }, 60_000);
      outcome.invoke = "pass";
      if (response.status !== 200) throw new Error(`POST /provider-sessions/start returned ${response.status}: ${response.text.slice(0, 500)}`);
      const body = requireObject(response.body, "POST /provider-sessions/start");
      const run = requireObject(body.run, "provider session start run");
      providerRunId = typeof run.runId === "string" ? run.runId : null;
      if (body.ok !== true || !providerRunId || run.tabId !== tabId || run.providerId !== "codex-cli"
        || !sameProviderFixtureCwd(run.cwd, project, request.platform)
        || run.transport !== "local" || !["starting", "streaming", "completed"].includes(String(run.phase))) {
        throw new Error("provider session start omitted its exact isolated child-process contract");
      }
      await requireProviderRunTerminal(connection, tabId, providerRunId, "completed");
      const events = await recentEvents(connection);
      for (const expectedKind of ["started", "completed"]) {
        if (!events.some((event) => event.kind === "provider-session-event" && isRecord(event.payload)
          && event.payload.runId === providerRunId && event.payload.tabId === tabId
          && String(event.payload.kind).toLowerCase() === expectedKind)) {
          throw new Error(`provider session lifecycle omitted its ${expectedKind} event`);
        }
      }
      const promptSha256 = createHash("sha256").update(PROVIDER_ACTION_PROMPT).digest("hex");
      if (!events.some((event) => event.kind === "provider-session-event" && isRecord(event.payload)
        && event.payload.runId === providerRunId && event.payload.tabId === tabId
        && event.payload.kind === "text"
        && event.payload.text === `SHELLX_PROVIDER_ACTION_RECEIPT ${PROVIDER_ACTION} ${promptSha256}`)) {
        throw new Error("provider session lifecycle omitted its exact parsed fixture receipt");
      }
      providerRunId = null;
      outcome.effect = "pass";
      outcome.observedEffect = "POST /provider-sessions/start launched the installed ShellX release-owned JSONL child fixture, parsed its exact receipt, and exposed matching started/completed registry events without contacting an external provider; the final provider-route batch separately proves real provider sessions.";
    } else {
      throw new Error(`provider lifecycle fixture does not support ${assignment.surface.name}`);
    }
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (grokConnected) {
      try {
        await postJson(connection, `/abort?tabId=${encodeURIComponent(tabId)}`, {}, 30_000);
        await assertGrokTabAbsent(connection, tabId);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (providerRunId) {
      try {
        await postJson(connection, `/provider-sessions/abort?tabId=${encodeURIComponent(tabId)}`, {
          tabId,
          runId: providerRunId,
          transport: "local",
        }, 30_000);
        await requireProviderRunTerminal(connection, tabId, providerRunId, "aborted");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (project) {
      try {
        cleanupOwnedProviderProject(project, request);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) {
      outcome.cleanup = "pass";
    } else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

export function sameProviderFixtureCwd(
  observed: unknown,
  expected: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): boolean {
  if (observed === expected) return true;
  if (platform !== "windows-installed" || typeof observed !== "string") return false;
  return normalizeWindowsFixturePath(observed) === normalizeWindowsFixturePath(expected);
}

function normalizeWindowsFixturePath(value: string): string {
  const slashes = value.trim().replaceAll("/", "\\");
  const withoutLongPrefix = slashes.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/i, "");
  return withoutLongPrefix.replace(/\\+$/, "").toLowerCase();
}

function providerBody(cwd: string, providerId: string): Record<string, unknown> {
  return {
    providerId,
    cwd,
    prompt: `Return exactly ${PROVIDER_CANARY} and no other text. Do not call tools.`,
    includeMcpProbe: false,
    includeShellxTooling: false,
    shellxToolExposure: "off",
    timeoutMs: 120_000,
    persistSession: false,
    permissionMode: "readOnly",
    transport: "local",
    recordEvents: true,
  };
}

function prepareOwnedProviderProject(request: ReleaseSurfaceDriverRequest): string {
  const profileRoot = dirname(dirname(request.runtime.debugTokenPath));
  const stat = lstatSync(profileRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !basename(profileRoot).startsWith("shellx-final-webdriver-")) {
    throw new Error("provider fixture requires the exact owned final-candidate profile root");
  }
  const project = mkdtempSync(join(profileRoot, "release-provider-route-"));
  writeFileSync(join(project, "README.md"), "# ShellX release provider lifecycle fixture\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return project;
}

function prepareOwnedProviderActionProject(request: ReleaseSurfaceDriverRequest, action: string): string {
  const profileRoot = dirname(dirname(request.runtime.debugTokenPath));
  const stat = lstatSync(profileRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !basename(profileRoot).startsWith("shellx-final-webdriver-")) {
    throw new Error("provider action fixture requires the exact owned final-candidate profile root");
  }
  const project = mkdtempSync(join(profileRoot, `release-provider-action-${action}-`));
  writeFileSync(join(project, "README.md"), "# ShellX release provider action fixture\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return project;
}

function cleanupOwnedProviderProject(project: string, request: ReleaseSurfaceDriverRequest): void {
  const profileRoot = dirname(dirname(request.runtime.debugTokenPath));
  if (dirname(project) !== profileRoot
    || (!basename(project).startsWith("release-provider-route-")
      && !basename(project).startsWith("release-provider-action-"))) {
    throw new Error("refused to remove an unowned provider project");
  }
  if (existsSync(project)) {
    // Windows can retain the just-aborted provider child's cwd handle for a
    // short interval after the registry has reached its absent postcondition.
    // Node retries only the bounded transient removal errors for recursive
    // deletes; all other errors still fail immediately and the final
    // existence check remains authoritative.
    rmSync(project, { recursive: true, maxRetries: 50, retryDelay: 100 });
  }
  if (existsSync(project)) throw new Error("owned provider project remained after cleanup");
}

async function assertGrokTabAbsent(connection: Connection, tabId: string): Promise<void> {
  const sessions = requireObject(await getJson(connection, "/state/sessions"), "session registry");
  const tabs = Array.isArray(sessions.tabs) ? sessions.tabs : [];
  if (tabs.some((tab) => isRecord(tab) && tab.tabId === tabId)) throw new Error("owned Grok tab already exists or survived cleanup");
}

async function requireGrokTab(connection: Connection, tabId: string): Promise<Record<string, unknown>> {
  const sessions = requireObject(await getJson(connection, "/state/sessions"), "session registry");
  const tabs = Array.isArray(sessions.tabs) ? sessions.tabs : [];
  const tab = tabs.find((value) => isRecord(value) && value.tabId === tabId);
  if (!isRecord(tab)) throw new Error("owned Grok tab was absent from the installed session registry");
  return tab;
}

async function assertProviderTabQuiescent(connection: Connection, tabId: string): Promise<void> {
  const state = await providerState(connection, tabId);
  if (state.activeRun != null || (Array.isArray(state.recentRuns) && state.recentRuns.length > 0)) {
    throw new Error("owned provider tab collided with existing lifecycle state");
  }
}

async function requireProviderRunTerminal(
  connection: Connection,
  tabId: string,
  runId: string,
  phase: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await providerState(connection, tabId);
    const recent = Array.isArray(state.recentRuns) ? state.recentRuns : [];
    if (state.activeRun == null && recent.some((value) => isRecord(value)
      && value.runId === runId && String(value.phase).toLowerCase() === phase)) return;
    await delay(25);
  }
  throw new Error(`owned provider run never reached ${phase} cleanup state`);
}

async function providerState(connection: Connection, tabId: string): Promise<Record<string, unknown>> {
  return requireObject(
    await getJson(connection, `/provider-sessions/state?tabId=${encodeURIComponent(tabId)}&transport=local`),
    "provider session state",
  );
}

async function recentEvents(connection: Connection): Promise<Array<{ kind: string; payload: unknown }>> {
  const value = await getJson(connection, "/events/recent?limit=1000");
  if (!Array.isArray(value)) throw new Error("recent event endpoint returned a non-array envelope");
  return value.flatMap((event) => isRecord(event) && typeof event.kind === "string"
    ? [{ kind: event.kind, payload: event.payload }] : []);
}

function countEvents(events: Array<{ kind: string; payload: unknown }>, kind: string, providerId: string): number {
  return events.filter((event) => event.kind === kind && isRecord(event.payload)
    && event.payload.providerId === providerId).length;
}

async function getJson(connection: Connection, path: string): Promise<unknown> {
  const response = await fetch(`${connection.base}${path}`, {
    headers: { Authorization: `Bearer ${connection.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function postJson(
  connection: Connection,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(`${connection.base}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
