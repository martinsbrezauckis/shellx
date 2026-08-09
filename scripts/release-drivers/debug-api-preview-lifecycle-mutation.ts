import { spawnSync } from "node:child_process";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

const PREVIEW_LIFECYCLE_MUTATIONS = new Set([
  "POST /preview/work/start",
  "POST /preview/work/restart",
  "POST /preview/work/stop",
]);
const PREVIEW_ENTRY = "release-preview.html";
const PREVIEW_MARKER = "SHELLX_RELEASE_OWNED_STATIC_PREVIEW_035";

type DebugApiConnection = { base: string; token: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

interface PreviewFixture {
  nodeRoot: string;
  launchRoot: string;
  tabId: string;
  platform: ReleaseSurfaceDriverRequest["platform"];
}

export function isDebugApiPreviewLifecycleMutation(name: string): boolean {
  return PREVIEW_LIFECYCLE_MUTATIONS.has(name);
}

export async function exerciseDebugApiPreviewLifecycleMutation(
  connection: DebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  assignment: DriverAssignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No owned Work Preview lifecycle effect was observed.",
  };
  let fixture: PreviewFixture | null = null;
  try {
    const name = assignment.surface.name;
    if (!PREVIEW_LIFECYCLE_MUTATIONS.has(name)) {
      throw new Error(`unsupported owned Work Preview lifecycle route ${name}`);
    }
    fixture = preparePreviewFixture(request, assignment);
    const idle = await previewState(connection, fixture.tabId);
    verifyIdlePreviewState(idle, fixture.tabId, "Preview lifecycle baseline");
    outcome.present = "pass";

    let seededUrl: string | null = null;
    if (name !== "POST /preview/work/start") {
      const seeded = await startPreview(connection, "/preview/work/start", fixture);
      seededUrl = verifyRunningPreviewState(seeded, fixture, "Preview lifecycle seed");
      await verifyPreviewPage(seededUrl);
    }

    if (name === "POST /preview/work/stop") {
      const stopped = await stopPreview(connection, fixture.tabId);
      outcome.invoke = "pass";
      verifyStoppedPreviewState(stopped, fixture, "POST /preview/work/stop");
      if (!seededUrl) throw new Error("Preview stop proof omitted its seeded URL");
      await verifyPreviewUrlUnavailable(seededUrl);
    } else {
      const route = name.endsWith("/restart")
        ? "/preview/work/restart"
        : "/preview/work/start";
      const running = await startPreview(connection, route, fixture);
      outcome.invoke = "pass";
      const runningUrl = verifyRunningPreviewState(running, fixture, name);
      await verifyPreviewPage(runningUrl);
      if (seededUrl) {
        if (seededUrl === runningUrl) {
          throw new Error("Preview restart reused its previous loopback endpoint");
        }
        await verifyPreviewUrlUnavailable(seededUrl);
      }
    }

    const state = await previewState(connection, fixture.tabId);
    if (name === "POST /preview/work/stop") {
      verifyStoppedPreviewState(state, fixture, `${name} readback`);
    } else {
      verifyRunningPreviewState(state, fixture, `${name} readback`);
    }
    outcome.effect = "pass";
    outcome.observedEffect = name === "POST /preview/work/restart"
      ? "POST /preview/work/restart replaced an owned static Preview loopback endpoint, served the exact owned page from the new endpoint, and made the prior endpoint unreachable."
      : name === "POST /preview/work/stop"
        ? "POST /preview/work/stop transitioned an owned running static Preview to stopped and made its exact loopback endpoint unreachable."
        : "POST /preview/work/start served the exact owned static page through ShellX Work Preview and exposed the matching running state.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (fixture) {
      const cleanupError = await cleanupPreviewFixture(connection, fixture);
      if (cleanupError) {
        outcome.error = outcome.error
          ? `${outcome.error}; cleanup: ${cleanupError}`
          : `cleanup: ${cleanupError}`;
      } else {
        outcome.cleanup = "pass";
      }
    }
  }
  return outcome;
}

function preparePreviewFixture(
  request: ReleaseSurfaceDriverRequest,
  assignment: DriverAssignment,
): PreviewFixture {
  const tokenNodePath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const tokenStat = lstatSync(tokenNodePath);
  if (tokenStat.isSymbolicLink() || !tokenStat.isFile()) {
    throw new Error("Debug API token must be a regular non-link file");
  }
  if (basename(tokenNodePath) !== "shellxagent.token" || basename(dirname(tokenNodePath)) !== ".shellx") {
    throw new Error("Work Preview fixtures require the installed candidate's .shellx token path");
  }
  const nodeProfileRoot = dirname(dirname(tokenNodePath));
  const launchProfileRoot = portableParent(
    portableParent(request.runtime.debugTokenPath, request.platform),
    request.platform,
  );
  const lane = assignment.surface.name.endsWith("/restart")
    ? "restart"
    : assignment.surface.name.endsWith("/stop") ? "stop" : "start";
  const nodeRoot = resolve(nodeProfileRoot, `debug-api-preview-${lane}`);
  const rel = relative(resolve(nodeProfileRoot), nodeRoot);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Work Preview fixture root escaped the disposable run profile");
  }
  if (existsSync(nodeRoot)) throw new Error("Work Preview fixture root must not exist before the route proof");
  mkdirSync(nodeRoot, { mode: 0o700 });
  writeFileSync(
    join(nodeRoot, PREVIEW_ENTRY),
    `<!doctype html><title>ShellX release Preview</title><main>${PREVIEW_MARKER}</main>\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return {
    nodeRoot,
    launchRoot: portableJoin(launchProfileRoot, `debug-api-preview-${lane}`, request.platform),
    tabId: `shellx-release-preview-${lane}-${request.sourceCommit.slice(0, 16)}`,
    platform: request.platform,
  };
}

async function cleanupPreviewFixture(
  connection: DebugApiConnection,
  fixture: PreviewFixture,
): Promise<string | null> {
  const errors: string[] = [];
  try {
    const before = await previewState(connection, fixture.tabId);
    const oldUrl = typeof before.url === "string" ? before.url : null;
    const stopped = await stopPreview(connection, fixture.tabId);
    if (stopped.status !== "idle") {
      verifyStoppedPreviewState(stopped, fixture, "Work Preview cleanup stop");
    }
    if (oldUrl) await verifyPreviewUrlUnavailable(oldUrl);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    rmSync(fixture.nodeRoot, { recursive: true });
    if (existsSync(fixture.nodeRoot)) throw new Error("owned Preview fixture root remained after deletion");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

async function startPreview(
  connection: DebugApiConnection,
  path: "/preview/work/start" | "/preview/work/restart",
  fixture: PreviewFixture,
): Promise<Record<string, unknown>> {
  return apiJson(connection, "POST", `${path}?tabId=${encodeURIComponent(fixture.tabId)}`, {
    tabId: fixture.tabId,
    cwd: fixture.launchRoot,
    kind: "static",
    entry: PREVIEW_ENTRY,
  });
}

async function stopPreview(
  connection: DebugApiConnection,
  tabId: string,
): Promise<Record<string, unknown>> {
  return apiJson(
    connection,
    "POST",
    `/preview/work/stop?tabId=${encodeURIComponent(tabId)}`,
    { tabId },
  );
}

async function previewState(
  connection: DebugApiConnection,
  tabId: string,
): Promise<Record<string, unknown>> {
  return apiJson(
    connection,
    "GET",
    `/preview/work/state?tabId=${encodeURIComponent(tabId)}`,
  );
}

function verifyIdlePreviewState(
  value: Record<string, unknown>,
  tabId: string,
  label: string,
): void {
  requirePreviewStateKeys(value, label);
  if (value.tabId !== tabId || value.status !== "idle" || value.cwd !== null || value.kind !== null
    || value.url !== null || value.command !== null || value.taskId !== null || value.pid !== null
    || value.startedAtMs !== null || value.viewportHint !== null || value.error !== null
    || !Number.isSafeInteger(value.updatedAtMs) || !Array.isArray(value.logs) || value.logs.length !== 0) {
    throw new Error(`${label} did not match the exact idle state`);
  }
}

function verifyRunningPreviewState(
  value: Record<string, unknown>,
  fixture: PreviewFixture,
  label: string,
): string {
  requirePreviewStateKeys(value, label);
  const url = typeof value.url === "string" ? value.url : "";
  if (value.tabId !== fixture.tabId || !samePortablePath(value.cwd, fixture.launchRoot, fixture.platform)
    || value.kind !== "staticHtml" || value.status !== "running"
    || !/^http:\/\/127\.0\.0\.1:\d+\//.test(url)
    || value.command !== "shellX static file server" || value.taskId !== null || value.pid !== null
    || !Number.isSafeInteger(value.startedAtMs) || !Number.isSafeInteger(value.updatedAtMs)
    || value.viewportHint !== null || value.error !== null
    || !Array.isArray(value.logs) || value.logs.length < 2) {
    throw new Error(`${label} did not match the exact owned static Preview running state`);
  }
  return url;
}

function verifyStoppedPreviewState(
  value: Record<string, unknown>,
  fixture: PreviewFixture,
  label: string,
): void {
  requirePreviewStateKeys(value, label);
  if (value.tabId !== fixture.tabId || !samePortablePath(value.cwd, fixture.launchRoot, fixture.platform)
    || value.kind !== "staticHtml" || value.status !== "stopped"
    || value.url !== null || value.command !== "shellX static file server"
    || value.taskId !== null || value.pid !== null
    || !Number.isSafeInteger(value.startedAtMs) || !Number.isSafeInteger(value.updatedAtMs)
    || value.viewportHint !== null || value.error !== null
    || !Array.isArray(value.logs) || value.logs.length < 3) {
    throw new Error(`${label} did not match the exact stopped static Preview state`);
  }
}

function requirePreviewStateKeys(value: Record<string, unknown>, label: string): void {
  const expected = [
    "command", "cwd", "error", "kind", "logs", "pid", "startedAtMs", "status", "tabId",
    "taskId", "updatedAtMs", "url", "viewportHint",
  ];
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected.sort())) {
    throw new Error(`${label} returned the wrong Preview state keys`);
  }
}

async function verifyPreviewPage(url: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  const body = await response.text();
  const originalPage = `<!doctype html><title>ShellX release Preview</title><main>${PREVIEW_MARKER}</main>\n`;
  const doctorMarkers = body.match(/data-shellx-preview-doctor/g)?.length ?? 0;
  if (!response.ok || !body.startsWith("<script data-shellx-preview-doctor>")
    || !body.endsWith(originalPage) || doctorMarkers !== 1) {
    throw new Error("Work Preview did not serve the exact owned page with one ShellX Preview Doctor injection");
  }
}

async function verifyPreviewUrlUnavailable(url: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (!response.ok) return;
    } catch {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("stopped Work Preview endpoint remained reachable");
}

async function apiJson(
  connection: DebugApiConnection,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  const value = text.trim() ? JSON.parse(text) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${method} ${path} returned a non-object payload`);
  }
  return value as Record<string, unknown>;
}

function nodeReadablePath(
  path: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) {
    return resolve(path);
  }
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("unable to map the Debug API token path");
  return resolve(result.stdout.trim());
}

function portableParent(
  path: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  if (platform !== "windows-installed") return dirname(path);
  const normalized = path.replaceAll("/", "\\").replace(/\\+$/, "");
  const index = normalized.lastIndexOf("\\");
  if (index <= 2) throw new Error("Debug API token path is outside a disposable Windows profile");
  return normalized.slice(0, index);
}

function portableJoin(
  base: string,
  child: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  return platform === "windows-installed"
    ? `${base.replace(/[\\/]+$/, "")}\\${child}`
    : join(base, child);
}

function samePortablePath(
  value: unknown,
  expected: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): boolean {
  if (typeof value !== "string") return false;
  const normalize = (path: string) => path
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/")
    .replace(/\/$/, "");
  const left = normalize(value);
  const right = normalize(expected);
  return platform === "windows-installed"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
