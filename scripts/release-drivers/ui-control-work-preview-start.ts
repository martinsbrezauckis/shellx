import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  clickReleaseSurfaceInstalledInputElement,
  findReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

export const WORK_PREVIEW_START_FIXTURES = ["ui:work-preview-owned-static-project"];
export const WORK_PREVIEW_START_CLEANUPS = ["ui:close-preview-center-stop-refresh-delete-project-and-restore-tab"];
export const WORK_PREVIEW_START_ORACLES = ["ui:activation:work-preview-start-lifecycle"];

const START_SURFACE = "src/components/WorkPreviewPanel.tsx:[data-debug-id=\"surface-components-workpreviewpanel-3\"]";
export const WORK_PREVIEW_START_SELECTOR = "[data-debug-id='surface-components-workpreviewpanel-3']";
export const WORK_PREVIEW_REFRESH_SELECTOR = "[id='work-preview-refresh-state']";
export const WORK_PREVIEW_CENTER_DIALOG = "[role='dialog'][aria-label='Preview Center']";
export const WORK_PREVIEW_CENTER_CLOSE = `${WORK_PREVIEW_CENTER_DIALOG} [aria-label='Close']`;
export const WORK_PREVIEW_ENTRY = "release-preview.html";
export const WORK_PREVIEW_PAGE = "<!doctype html><title>ShellX release Preview</title><main>SHELLX_RELEASE_OWNED_STATIC_PREVIEW_035</main>\n";
export const WORK_PREVIEW_FILE_ENTRY = "release-preview.txt";
export const WORK_PREVIEW_FILE_CONTENT = "SHELLX_RELEASE_OWNED_FILE_PREVIEW_035\n";

type Connection = { base: string; token: string };
type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];

export interface PreviewFixture {
  nodeRoot: string;
  launchRoot: string;
  nodeFilePath: string;
  launchFilePath: string;
  tabId: string;
  baselineRightTab: string;
  baselineActiveTab: Record<string, unknown>;
}

export function supportsWorkPreviewStartControl(assignment: Assignment): boolean {
  return assignment.surface.name === START_SURFACE;
}

export async function exerciseWorkPreviewStartControl(
  connection: Connection,
  webdriver: ReleaseSurfaceInstalledInputSession,
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
    observedEffect: "No native Work Preview start lifecycle effect was observed.",
  };
  let fixture: PreviewFixture | null = null;
  try {
    if (!supportsWorkPreviewStartControl(assignment)) {
      throw new Error(`Work Preview start driver does not support ${assignment.surface.name}`);
    }
    fixture = prepareFixture(request);
    await hydrateFixtureBaseline(connection, fixture);
    await postUi(connection, {
      rightTab: "Preview",
      activeTabId: fixture.tabId,
      activeTab: { ...fixture.baselineActiveTab, cwd: fixture.launchRoot },
      source: "final-surface-work-preview-start",
    });
    const idle = await previewState(connection, fixture.tabId);
    verifyIdleState(idle, fixture.tabId);
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_START_SELECTOR, {
      timeoutMs: 5_000,
      pollMs: 50,
    });
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    const running = await waitForRunningState(connection, fixture);
    await waitForReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_CENTER_DIALOG, {
      timeoutMs: 5_000,
      pollMs: 50,
    });
    const url = verifyRunningState(running, fixture);
    const page = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!page.ok || await page.text() !== WORK_PREVIEW_PAGE) {
      throw new Error("native Work Preview Start did not serve the exact owned static page");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click on the durable Start control launched ShellX Work Preview for an owned static project and served the exact page through its matching loopback state; project and endpoint identities were not retained.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (fixture) {
      const previewCenterOpen = Boolean(
        await findReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_CENTER_DIALOG),
      );
      const cleanupError = await cleanupFixture(connection, webdriver, fixture, previewCenterOpen);
      if (cleanupError) {
        outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
      } else {
        outcome.cleanup = "pass";
      }
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Work Preview Start control did not satisfy every required verdict";
  }
  return outcome;
}

export function prepareFixture(request: ReleaseSurfaceDriverRequest): PreviewFixture {
  const tokenPath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const tokenStat = lstatSync(tokenPath);
  if (tokenStat.isSymbolicLink() || !tokenStat.isFile()) {
    throw new Error("Work Preview UI fixture requires a regular non-link Debug token");
  }
  if (basename(tokenPath) !== "shellxagent.token" || basename(dirname(tokenPath)) !== ".shellx") {
    throw new Error("Work Preview UI fixture requires the installed candidate's .shellx token path");
  }
  const nodeProfileRoot = dirname(dirname(tokenPath));
  const nodeRoot = resolve(nodeProfileRoot, "ui-work-preview-start");
  const rel = relative(resolve(nodeProfileRoot), nodeRoot);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Work Preview UI fixture escaped the disposable profile");
  }
  if (existsSync(nodeRoot)) throw new Error("Work Preview UI fixture root must not pre-exist");
  mkdirSync(nodeRoot, { mode: 0o700 });
  writeFileSync(join(nodeRoot, WORK_PREVIEW_ENTRY), WORK_PREVIEW_PAGE, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const nodeFilePath = join(nodeRoot, WORK_PREVIEW_FILE_ENTRY);
  writeFileSync(nodeFilePath, WORK_PREVIEW_FILE_CONTENT, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const launchProfileRoot = portableParent(portableParent(request.runtime.debugTokenPath, request.platform), request.platform);
  const launchRoot = portableJoin(launchProfileRoot, "ui-work-preview-start", request.platform);
  return {
    nodeRoot,
    launchRoot,
    nodeFilePath,
    launchFilePath: portableJoin(launchRoot, WORK_PREVIEW_FILE_ENTRY, request.platform),
    tabId: "",
    baselineRightTab: "",
    baselineActiveTab: {},
  };
}

export async function hydrateFixtureBaseline(
  connection: Connection,
  fixture: PreviewFixture,
): Promise<void> {
  const state = await apiJson(connection, "GET", "/state/ui");
  const activeTab = requireObject(state.activeTab, "Work Preview UI baseline activeTab");
  const tabId = typeof activeTab.tabId === "string" ? activeTab.tabId.trim() : "";
  const cwd = typeof activeTab.cwd === "string" ? activeTab.cwd.trim() : "";
  const rightTab = typeof state.rightTab === "string" ? state.rightTab.trim() : "";
  if (!tabId || !cwd || !rightTab) {
    throw new Error("Work Preview UI fixture requires a renderer-owned active tab with a restorable cwd and right rail");
  }
  fixture.tabId = tabId;
  fixture.baselineRightTab = rightTab;
  fixture.baselineActiveTab = structuredClone(activeTab);
}

export async function cleanupFixture(
  connection: Connection,
  webdriver: ReleaseSurfaceInstalledInputSession,
  fixture: PreviewFixture,
  previewCenterExpected: boolean,
  clearOwnedFilePreview = false,
): Promise<string | null> {
  const errors: string[] = [];
  if (previewCenterExpected) {
    try {
      const close = await waitForReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_CENTER_CLOSE, {
        timeoutMs: 5_000,
        pollMs: 50,
      });
      await clickReleaseSurfaceInstalledInputElement(webdriver, close);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, WORK_PREVIEW_CENTER_DIALOG, {
        timeoutMs: 5_000,
        pollMs: 50,
      });
    } catch (error) {
      errors.push(`Preview Center cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    if (fixture.tabId) {
      const before = await previewState(connection, fixture.tabId);
      const oldUrl = typeof before.url === "string" ? before.url : null;
      const stopped = await apiJson(
        connection,
        "POST",
        `/preview/work/stop?tabId=${encodeURIComponent(fixture.tabId)}`,
        { tabId: fixture.tabId },
      );
      if (stopped.status !== "idle") verifyStoppedState(stopped, fixture);
      if (oldUrl) await waitForUnavailable(oldUrl);
      await postUi(connection, {
        rightTab: "Preview",
        activeTabId: fixture.tabId,
        activeTab: { ...fixture.baselineActiveTab, cwd: fixture.launchRoot },
        ...(clearOwnedFilePreview ? { clearPreview: true } : {}),
        source: "final-surface-work-preview-renderer-cleanup",
      });
      const refresh = await waitForReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_REFRESH_SELECTOR, {
        timeoutMs: 5_000,
        pollMs: 50,
      });
      await clickReleaseSurfaceInstalledInputElement(webdriver, refresh);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_START_SELECTOR, {
        timeoutMs: 5_000,
        pollMs: 50,
      });
      await postUi(connection, {
        rightTab: fixture.baselineRightTab,
        activeTabId: fixture.tabId,
        activeTab: fixture.baselineActiveTab,
        source: "final-surface-work-preview-start-cleanup",
      });
      const restored = await apiJson(connection, "GET", "/state/ui");
      const restoredActive = requireObject(restored.activeTab, "restored Work Preview UI activeTab");
      if (restored.rightTab !== fixture.baselineRightTab
        || JSON.stringify(stableActiveTab(restoredActive)) !== JSON.stringify(stableActiveTab(fixture.baselineActiveTab))) {
        throw new Error("Work Preview UI cleanup did not restore the exact active tab and right rail baseline");
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    rmSync(fixture.nodeRoot, { recursive: true });
    if (existsSync(fixture.nodeRoot)) throw new Error("owned Work Preview UI fixture root remained");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

export async function waitForRunningState(connection: Connection, fixture: PreviewFixture): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await previewState(connection, fixture.tabId);
    if (state.status === "running") return state;
    if (state.status === "failed") throw new Error(`native Work Preview Start failed: ${String(state.error ?? "unknown error")}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("native Work Preview Start did not reach running state");
}

function verifyIdleState(state: Record<string, unknown>, tabId: string): void {
  requireStateKeys(state, "Work Preview UI idle state");
  if (state.tabId !== tabId || state.status !== "idle" || state.url !== null || state.cwd !== null
    || state.kind !== null || state.command !== null || state.taskId !== null || state.pid !== null
    || state.startedAtMs !== null || state.viewportHint !== null || state.error !== null
    || !Number.isSafeInteger(state.updatedAtMs) || !Array.isArray(state.logs) || state.logs.length !== 0) {
    throw new Error("Work Preview UI did not start from an exact idle state");
  }
}

export function verifyRunningState(state: Record<string, unknown>, fixture: PreviewFixture): string {
  requireStateKeys(state, "Work Preview UI running state");
  const url = typeof state.url === "string" ? state.url : "";
  if (state.tabId !== fixture.tabId || state.cwd !== fixture.launchRoot || state.kind !== "staticHtml"
    || state.status !== "running" || !/^http:\/\/127\.0\.0\.1:\d+\//.test(url)
    || state.command !== "shellX static file server" || state.taskId !== null || state.pid !== null
    || !Number.isSafeInteger(state.startedAtMs) || !Number.isSafeInteger(state.updatedAtMs)
    || state.viewportHint !== null || state.error !== null
    || !Array.isArray(state.logs) || state.logs.length < 2) {
    throw new Error("native Work Preview Start returned the wrong owned static running state");
  }
  return url;
}

function verifyStoppedState(state: Record<string, unknown>, fixture: PreviewFixture): void {
  requireStateKeys(state, "Work Preview UI stopped state");
  if (state.tabId !== fixture.tabId || state.cwd !== fixture.launchRoot || state.kind !== "staticHtml"
    || state.status !== "stopped" || state.url !== null || state.command !== "shellX static file server"
    || state.taskId !== null || state.pid !== null || !Number.isSafeInteger(state.startedAtMs)
    || !Number.isSafeInteger(state.updatedAtMs) || state.viewportHint !== null || state.error !== null
    || !Array.isArray(state.logs) || state.logs.length < 3) {
    throw new Error("Work Preview UI cleanup returned the wrong stopped state");
  }
}

function requireStateKeys(state: Record<string, unknown>, label: string): void {
  const expected = [
    "command", "cwd", "error", "kind", "logs", "pid", "startedAtMs", "status", "tabId",
    "taskId", "updatedAtMs", "url", "viewportHint",
  ].sort();
  if (JSON.stringify(Object.keys(state).sort()) !== JSON.stringify(expected)) {
    throw new Error(`${label} returned the wrong keys`);
  }
}

function stableActiveTab(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

export async function waitForUnavailable(url: string): Promise<void> {
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
  throw new Error("stopped Work Preview UI endpoint remained reachable");
}

export async function previewState(connection: Connection, tabId: string): Promise<Record<string, unknown>> {
  return apiJson(connection, "GET", `/preview/work/state?tabId=${encodeURIComponent(tabId)}`);
}

export async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", body);
}

export async function apiJson(
  connection: Connection,
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
  return requireObject(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} did not return an object`);
  return value as Record<string, unknown>;
}

export function nodeReadablePath(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) {
    return resolve(path);
  }
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("unable to map the Work Preview UI token path");
  return resolve(result.stdout.trim());
}

function portableParent(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed") return dirname(path);
  const normalized = path.replaceAll("/", "\\").replace(/\\+$/, "");
  const index = normalized.lastIndexOf("\\");
  if (index <= 2) throw new Error("Work Preview UI token path is outside a disposable Windows profile");
  return normalized.slice(0, index);
}

function portableJoin(base: string, child: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  return platform === "windows-installed" ? `${base.replace(/[\\/]+$/, "")}\\${child}` : join(base, child);
}
