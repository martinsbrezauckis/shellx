import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  clickReleaseSurfaceInstalledInputElement,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { apiJson, nodeReadablePath, postUi } from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;
type PreviewAction = "code" | "safe" | "run";

const ACTION_BY_SURFACE: Record<string, PreviewAction> = {
  "src/components/FilePreviewModal.tsx:[id=\"file-preview-mode-code\"]": "code",
  "src/components/FilePreviewModal.tsx:[id=\"file-preview-mode-safe-render\"]": "safe",
  "src/components/FilePreviewModal.tsx:[id=\"file-preview-run-work\"]": "run",
};
const DIALOG = "[role='dialog'][aria-label='Preview Center']";
const CLOSE = `${DIALOG} [aria-label='Close']`;
const CODE = "[id='file-preview-mode-code']";
const SAFE = "[id='file-preview-mode-safe-render']";
const RUN = "[id='file-preview-run-work']";
const REFRESH = "[id='work-preview-refresh-state']";
const HTML_STATE = ".preview-body-html";
const SAFE_STATE = ".preview-html-safe-state";
const CENTER_FILE = "[id='preview-center-file-mode']";
const CENTER_WORK = "[id='preview-center-work-mode']";
const CENTER_STATE = ".preview-center-body";
const WORK_STAGE_STATE = ".work-preview-stage-canvas";
const FILE_NAME = "release-file-preview.html";
const MARKER = "SHELLX_RELEASE_OWNED_SAFE_HTML_035";
const FILE_CONTENT = `<!doctype html><title>Owned safe preview</title><style>main{color:#135}</style><main>${MARKER}</main><script>window.__shellxUnsafePreviewRan=true</script>\n`;

interface FilePreviewFixture {
  nodeRoot: string;
  launchRoot: string;
  launchFilePath: string;
  tabId: string;
  baselineRightTab: string;
  baselineActiveTab: Record<string, unknown>;
}

export const FILE_PREVIEW_SAFE_FIXTURES = [
  "ui:file-preview-owned-html-mode",
  "ui:file-preview-owned-html-run",
] as const;
export const FILE_PREVIEW_SAFE_CLEANUPS = [
  "ui:close-delete-file-preview-and-restore-tab",
  "ui:stop-close-delete-file-preview-and-restore-tab",
] as const;
export const FILE_PREVIEW_SAFE_ORACLES = ["ui:activation:file-preview-work-preview-lifecycle"] as const;

export function supportsFilePreviewSafeControl(assignment: Assignment): boolean {
  return assignment.surface.name in ACTION_BY_SURFACE;
}

export async function exerciseFilePreviewSafeControl(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = ACTION_BY_SURFACE[assignment.surface.name];
  const outcome = emptyOutcome(assignment);
  let fixture: FilePreviewFixture | null = null;
  try {
    if (!action) throw new Error(`File Preview driver does not support ${assignment.surface.name}`);
    fixture = prepareFixture(request);
    await hydrateBaseline(connection, fixture);
    await postUi(connection, {
      rightTab: "Preview",
      activeTabId: fixture.tabId,
      activeTab: { ...fixture.baselineActiveTab, cwd: fixture.launchRoot },
      preview: {
        kind: "file",
        path: fixture.launchFilePath,
        tabId: fixture.tabId,
        sessionCwd: fixture.launchRoot,
      },
      openModal: "preview",
      source: "final-surface-file-preview-mode",
    });
    await waitForReleaseSurfaceInstalledInputElement(webdriver, DIALOG, { timeoutMs: 5_000, pollMs: 50 });
    const target = await waitForReleaseSurfaceInstalledInputElement(
      webdriver,
      action === "code" ? CODE : action === "safe" ? SAFE : RUN,
      {
      timeoutMs: 5_000,
      pollMs: 50,
      },
    );
    outcome.present = "pass";
    if (action === "code") {
      const opposite = await waitForReleaseSurfaceInstalledInputElement(webdriver, SAFE, { timeoutMs: 5_000, pollMs: 50 });
      await clickReleaseSurfaceInstalledInputElement(webdriver, opposite);
      await waitForMode(webdriver, "safe");
    } else if (action === "safe") {
      await waitForMode(webdriver, "code");
    }
    await clickReleaseSurfaceInstalledInputElement(webdriver, target);
    outcome.invoke = "pass";
    if (action === "run") {
      const running = await waitForRunningState(connection, fixture);
      const url = verifyRunningState(running, fixture);
      const page = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!page.ok || await page.text() !== FILE_CONTENT) {
        throw new Error("File Preview Run did not serve the exact owned HTML page");
      }
      await waitForRunState(webdriver);
    } else {
      await waitForMode(webdriver, action);
    }
    outcome.effect = "pass";
    outcome.observedEffect = action === "code"
      ? "A native WebDriver click restored Code mode from the opposite safe-render baseline and exposed the exact owned HTML source without a live frame."
      : action === "safe"
        ? "A native WebDriver click rendered the exact owned marker in a script-free, network-blocked, form-blocked sandboxed iframe without retaining file contents."
        : "A native WebDriver click launched the exact owned HTML file through ShellX Work Preview, rendered its loopback URL in the script-enabled work iframe, and retained neither page contents nor endpoint identity.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (fixture) applyCleanup(outcome, await cleanup(connection, webdriver, fixture, action === "run"));
  }
  return finalize(outcome);
}

function prepareFixture(request: ReleaseSurfaceDriverRequest): FilePreviewFixture {
  const tokenPath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const tokenStat = lstatSync(tokenPath);
  if (tokenStat.isSymbolicLink() || !tokenStat.isFile()
    || basename(tokenPath) !== "shellxagent.token" || basename(dirname(tokenPath)) !== ".shellx") {
    throw new Error("File Preview fixture requires the installed candidate's regular .shellx token");
  }
  const nodeProfileRoot = dirname(dirname(tokenPath));
  const nodeRoot = resolve(nodeProfileRoot, "ui-file-preview-modes");
  const rel = relative(resolve(nodeProfileRoot), nodeRoot);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("File Preview fixture escaped the disposable profile");
  }
  if (existsSync(nodeRoot)) throw new Error("File Preview fixture root must not pre-exist");
  mkdirSync(nodeRoot, { mode: 0o700 });
  writeFileSync(join(nodeRoot, FILE_NAME), FILE_CONTENT, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const launchProfileRoot = portableParent(portableParent(request.runtime.debugTokenPath, request.platform), request.platform);
  const launchRoot = portableJoin(launchProfileRoot, "ui-file-preview-modes", request.platform);
  return {
    nodeRoot,
    launchRoot,
    launchFilePath: portableJoin(launchRoot, FILE_NAME, request.platform),
    tabId: "",
    baselineRightTab: "",
    baselineActiveTab: {},
  };
}

async function hydrateBaseline(connection: Connection, fixture: FilePreviewFixture): Promise<void> {
  const state = await apiJson(connection, "GET", "/state/ui");
  const activeTab = requiredRecord(state.activeTab, "File Preview baseline activeTab");
  const tabId = typeof activeTab.tabId === "string" ? activeTab.tabId.trim() : "";
  const rightTab = typeof state.rightTab === "string" ? state.rightTab.trim() : "";
  if (!tabId || !rightTab) throw new Error("File Preview fixture requires a restorable active tab and right rail");
  fixture.tabId = tabId;
  fixture.baselineRightTab = rightTab;
  fixture.baselineActiveTab = structuredClone(activeTab);
}

async function waitForMode(webdriver: WebDriver, mode: Exclude<PreviewAction, "run">): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [code, safe, html, safeRender] = await Promise.all([
      observeReleaseSurfaceInstalledInputElement(webdriver, CODE, ["selected"]),
      observeReleaseSurfaceInstalledInputElement(webdriver, SAFE, ["selected"]),
      observeReleaseSurfaceInstalledInputElement(webdriver, HTML_STATE, ["title"]),
      mode === "safe"
        ? observeReleaseSurfaceInstalledInputElement(webdriver, SAFE_STATE, ["title"])
        : Promise.resolve(null),
    ]);
    const receipt = html.title?.match(/^File preview HTML state: mode=(code|safe); load=(loading|error|ready); content=(present|absent); frame=(present|absent)$/);
    const selected = mode === "code"
      ? code.selected === true && safe.selected === false
      : safe.selected === true && code.selected === false;
    const stateMatches = html.present && html.visible && receipt?.[1] === mode
      && receipt[2] === "ready" && receipt[3] === "present"
      && receipt[4] === (mode === "safe" ? "present" : "absent");
    const safeReceipt = safeRender?.title?.match(/^Safe HTML render: content=(present|absent); sandbox=(locked|missing); referrer=(no-referrer|missing); csp=(locked|missing); scripts=(stripped|present)$/);
    const safetyMatches = mode === "code" || (safeRender?.present === true && safeRender.visible
      && safeReceipt?.[1] === "present" && safeReceipt[2] === "locked"
      && safeReceipt[3] === "no-referrer" && safeReceipt[4] === "locked"
      && safeReceipt[5] === "stripped");
    if (selected && stateMatches && safetyMatches) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`File Preview did not reach bounded ${mode} ownership and safety state`);
}

async function waitForRunningState(
  connection: Connection,
  fixture: FilePreviewFixture,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await apiJson(connection, "GET", `/preview/work/state?tabId=${encodeURIComponent(fixture.tabId)}`);
    if (state.status === "running") return state;
    if (state.status === "failed") throw new Error(`File Preview Run failed: ${String(state.error ?? "unknown error")}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("File Preview Run did not reach running state");
}

function verifyRunningState(state: Record<string, unknown>, fixture: FilePreviewFixture): string {
  const url = typeof state.url === "string" ? state.url : "";
  if (state.tabId !== fixture.tabId || state.cwd !== fixture.launchRoot || state.kind !== "staticHtml"
    || state.status !== "running" || !/^http:\/\/127\.0\.0\.1:\d+\//.test(url)
    || state.command !== "shellX static file server" || state.taskId !== null || state.pid !== null
    || !Number.isSafeInteger(state.startedAtMs) || !Number.isSafeInteger(state.updatedAtMs)
    || state.viewportHint !== null || state.error !== null
    || !Array.isArray(state.logs) || state.logs.length < 2) {
    throw new Error("File Preview Run returned the wrong owned static running state");
  }
  return url;
}

async function waitForRunState(webdriver: WebDriver): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [file, work, center, stage] = await Promise.all([
      observeReleaseSurfaceInstalledInputElement(webdriver, CENTER_FILE, ["selected"]),
      observeReleaseSurfaceInstalledInputElement(webdriver, CENTER_WORK, ["selected"]),
      observeReleaseSurfaceInstalledInputElement(webdriver, CENTER_STATE, ["title"]),
      observeReleaseSurfaceInstalledInputElement(webdriver, WORK_STAGE_STATE, ["title"]),
    ]);
    const centerReceipt = center.title?.match(/^Preview Center state: mode=(file|work); file=(present|absent); work=(present|absent)$/);
    const stageReceipt = stage.title?.match(/^Work preview stage: viewport=(phone|tablet|desktop); frame=(present|absent); reload=(\d+)$/);
    if (file.selected === false && work.selected === true
      && center.present && center.visible && centerReceipt?.[1] === "work"
      && centerReceipt[2] === "present" && centerReceipt[3] === "present"
      && stage.present && stage.visible && stageReceipt?.[2] === "present") {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("File Preview Run did not render the owned script-enabled Work Preview iframe");
}

async function cleanup(
  connection: Connection,
  webdriver: WebDriver,
  fixture: FilePreviewFixture,
  stopOwnedPreview: boolean,
): Promise<string | null> {
  const errors: string[] = [];
  let ownedUrl: string | null = null;
  if (stopOwnedPreview) {
    try {
      const before = await apiJson(connection, "GET", `/preview/work/state?tabId=${encodeURIComponent(fixture.tabId)}`);
      ownedUrl = typeof before.url === "string" ? before.url : null;
      if (before.status === "running") {
        const stopped = await apiJson(
          connection,
          "POST",
          `/preview/work/stop?tabId=${encodeURIComponent(fixture.tabId)}`,
          { tabId: fixture.tabId },
        );
        if (stopped.status !== "stopped" || stopped.url !== null) {
          throw new Error("File Preview cleanup returned the wrong stopped state");
        }
      }
      if (ownedUrl) await waitForUnavailable(ownedUrl);
      const refresh = await waitForReleaseSurfaceInstalledInputElement(webdriver, REFRESH, {
        timeoutMs: 5_000,
        pollMs: 50,
      });
      await clickReleaseSurfaceInstalledInputElement(webdriver, refresh);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    if (await findReleaseSurfaceInstalledInputElement(webdriver, DIALOG)) {
      const close = await waitForReleaseSurfaceInstalledInputElement(webdriver, CLOSE, { timeoutMs: 5_000, pollMs: 50 });
      await clickReleaseSurfaceInstalledInputElement(webdriver, close);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, DIALOG, { timeoutMs: 5_000, pollMs: 50 });
    }
    await postUi(connection, {
      openModal: "close",
      clearPreview: true,
      rightTab: fixture.baselineRightTab,
      activeTabId: fixture.tabId,
      activeTab: fixture.baselineActiveTab,
      source: "final-surface-file-preview-mode-cleanup",
    });
    const restored = await apiJson(connection, "GET", "/state/ui");
    if (restored.rightTab !== fixture.baselineRightTab
      || JSON.stringify(restored.activeTab) !== JSON.stringify(fixture.baselineActiveTab)
      || restored.preview !== null) {
      throw new Error("File Preview cleanup did not restore the exact UI baseline");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    rmSync(fixture.nodeRoot, { recursive: true });
    if (existsSync(fixture.nodeRoot)) throw new Error("owned File Preview fixture root remained");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

async function waitForUnavailable(url: string): Promise<void> {
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
  throw new Error("owned File Preview Work Preview endpoint remained available after stop");
}

function portableParent(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed") return dirname(path);
  const normalized = path.replaceAll("/", "\\").replace(/\\+$/, "");
  const index = normalized.lastIndexOf("\\");
  if (index <= 2) throw new Error("File Preview token path is outside a disposable Windows profile");
  return normalized.slice(0, index);
}

function portableJoin(base: string, child: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  return platform === "windows-installed" ? `${base.replace(/[\\/]+$/, "")}\\${child}` : join(base, child);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} was not an object`);
  return value as Record<string, unknown>;
}

function emptyOutcome(assignment: Assignment): ReleaseSurfaceDriverOutcome {
  return {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No native File Preview mode transition was observed.",
  };
}

function applyCleanup(outcome: ReleaseSurfaceDriverOutcome, error: string | null): void {
  if (!error) outcome.cleanup = "pass";
  else outcome.error = outcome.error ? `${outcome.error}; cleanup: ${error}` : `cleanup: ${error}`;
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "File Preview control did not satisfy every required verdict";
  }
  return outcome;
}
