import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import {
  clickReleaseSurfaceInstalledInputElement,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  WORK_PREVIEW_CENTER_DIALOG,
  WORK_PREVIEW_ENTRY,
  WORK_PREVIEW_FILE_CONTENT,
  WORK_PREVIEW_PAGE,
  WORK_PREVIEW_REFRESH_SELECTOR,
  WORK_PREVIEW_START_SELECTOR,
  apiJson,
  cleanupFixture,
  hydrateFixtureBaseline,
  nodeReadablePath,
  postUi,
  prepareFixture,
  verifyRunningState,
  type PreviewFixture,
} from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;
type SafeAction = "refresh" | "doctor" | "file-mode" | "work-mode";

const SAFE_ACTIONS: Record<string, SafeAction> = {
  "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-refresh-state\"]": "refresh",
  "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-doctor\"]": "doctor",
  "src/components/PreviewCenter.tsx:[id=\"preview-center-file-mode\"]": "file-mode",
  "src/components/PreviewCenter.tsx:[id=\"preview-center-work-mode\"]": "work-mode",
};
const OPEN_SELECTOR = "[id='work-preview-open']";
const DOCTOR_SELECTOR = "[id='work-preview-doctor']";
const FILE_MODE_SELECTOR = "[id='preview-center-file-mode']";
const WORK_MODE_SELECTOR = "[id='preview-center-work-mode']";
const RENDERED_STATE_RECEIPT = ".work-preview-status";
const DOCTOR_STATE_RECEIPT = ".work-preview-doctor-card";
const CENTER_STATE_RECEIPT = ".preview-center-body";

export const WORK_PREVIEW_SAFE_FIXTURES = [
  "ui:work-preview-owned-refresh",
  "ui:work-preview-owned-doctor",
  "ui:preview-center-owned-file-and-work",
] as const;
export const WORK_PREVIEW_SAFE_CLEANUPS = [
  "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab",
  "ui:delete-doctor-screenshot-stop-refresh-delete-project-and-restore-tab",
  "ui:close-clear-preview-stop-refresh-delete-files-and-restore-tab",
] as const;
export const WORK_PREVIEW_SAFE_ORACLES = [
  "ui:activation:work-preview-state-refreshed",
  "ui:activation:work-preview-doctor-result",
] as const;

export function supportsWorkPreviewSafeControl(assignment: Assignment): boolean {
  return assignment.surface.name in SAFE_ACTIONS;
}

export async function exerciseWorkPreviewSafeControl(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = SAFE_ACTIONS[assignment.surface.name];
  if (action === "refresh") return exerciseRefresh(connection, webdriver, request, assignment);
  if (action === "doctor") return exerciseDoctor(connection, webdriver, request, assignment);
  if (action === "file-mode" || action === "work-mode") {
    return exercisePreviewCenterMode(connection, webdriver, request, assignment, action);
  }
  return {
    ...emptyOutcome(assignment, "No supported deterministic Work Preview action was selected."),
    error: `Work Preview safe driver does not support ${assignment.surface.name}`,
  };
}

async function exerciseRefresh(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Work Preview refresh transition was observed.");
  let fixture: PreviewFixture | null = null;
  try {
    fixture = await prepareIdleRenderer(connection, webdriver, request, "refresh");
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_REFRESH_SELECTOR, {
      timeoutMs: 5_000,
      pollMs: 50,
    });
    outcome.present = "pass";
    const running = await startBackendPreview(connection, fixture);
    await proveOwnedRunningPage(running, fixture);
    if (!await findReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_START_SELECTOR)) {
      throw new Error("refresh fixture lost its deliberately stale idle renderer state before activation");
    }
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElement(webdriver, OPEN_SELECTOR, { timeoutMs: 5_000, pollMs: 50 });
    const rendered = await renderedState(webdriver);
    if (rendered.status !== "running" || rendered.url !== "present") {
      throw new Error("Work Preview refresh did not reconcile the renderer with the exact owned running state");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click refreshed a deliberately stale idle Work Preview panel into the exact owned running URL and status.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (fixture) applyCleanup(outcome, await cleanupFixture(connection, webdriver, fixture, false));
  }
  return finalize(outcome, "Work Preview refresh control did not satisfy every required verdict");
}

async function exerciseDoctor(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Work Preview Doctor result was observed.");
  let fixture: PreviewFixture | null = null;
  let screenshotPath: string | null = null;
  let screenshotDeleted = false;
  const cleanupErrors: string[] = [];
  try {
    fixture = await prepareIdleRenderer(connection, webdriver, request, "doctor");
    const running = await startBackendPreview(connection, fixture);
    await proveOwnedRunningPage(running, fixture);
    await refreshRenderer(webdriver);
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, DOCTOR_SELECTOR, {
      timeoutMs: 5_000,
      pollMs: 50,
    });
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    const doctor = await waitForDoctorState(webdriver);
    if (!doctor.ok || !["passed", "warning"].includes(doctor.status)
      || doctor.http !== "200" || doctor.title !== "present"
      || !["captured", "unavailable"].includes(doctor.screenshot)) {
      throw new Error("Work Preview Doctor did not render the exact owned pass/warning evidence");
    }
    screenshotPath = doctor.screenshot === "captured"
      ? await waitForDoctorScreenshot(request, fixture)
      : null;
    if (screenshotPath) {
      deleteDoctorScreenshot(request, fixture, screenshotPath);
      screenshotDeleted = true;
    }
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click ran Preview Doctor against the owned loopback page, rendered its exact HTTP 200/title result, and ${screenshotPath ? "deleted its owned screenshot" : "proved the bounded screenshot-unavailable warning"}.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (fixture && screenshotPath && !screenshotDeleted) {
      try {
        deleteDoctorScreenshot(request, fixture, screenshotPath);
      } catch (error) {
        cleanupErrors.push(`doctor screenshot cleanup: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (fixture) {
      const cleanupError = await cleanupFixture(connection, webdriver, fixture, false);
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    applyCleanup(outcome, cleanupErrors.length > 0 ? cleanupErrors.join("; ") : null);
  }
  return finalize(outcome, "Work Preview Doctor control did not satisfy every required verdict");
}

async function exercisePreviewCenterMode(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
  action: "file-mode" | "work-mode",
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Preview Center mode transition was observed.");
  let fixture: PreviewFixture | null = null;
  try {
    fixture = await prepareIdleRenderer(connection, webdriver, request, action);
    const running = await startBackendPreview(connection, fixture);
    await proveOwnedRunningPage(running, fixture);
    await refreshRenderer(webdriver);
    const target = action === "file-mode" ? "file" : "work";
    const baseline = target === "file" ? "work" : "file";
    if (readFileSync(fixture.nodeFilePath, "utf8") !== WORK_PREVIEW_FILE_CONTENT) {
      throw new Error("Preview Center fixture file changed before native mode proof");
    }
    await postUi(connection, {
      preview: {
        path: fixture.launchFilePath,
        kind: "file",
        tabId: fixture.tabId,
        sessionCwd: fixture.launchRoot,
      },
      openModal: baseline === "work" ? "workPreview" : "preview",
      source: "final-surface-preview-center-mode",
    });
    await waitForReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_CENTER_DIALOG, {
      timeoutMs: 5_000,
      pollMs: 50,
    });
    const selector = target === "file" ? FILE_MODE_SELECTOR : WORK_MODE_SELECTOR;
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, selector, {
      timeoutMs: 5_000,
      pollMs: 50,
    });
    outcome.present = "pass";
    const before = await waitForCenterMode(webdriver, baseline);
    if ((baseline === "file" && !before.fileSelected) || (baseline === "work" && !before.workSelected)) {
      throw new Error("Preview Center did not start from the exact opposite mode baseline");
    }
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForCenterMode(webdriver, target);
    outcome.effect = "pass";
    outcome.observedEffect = target === "file"
      ? "A native WebDriver click selected Preview Center File mode and rendered the exact owned regular file from the opposite Work baseline."
      : "A native WebDriver click selected Preview Center Work mode and rendered the exact owned running loopback iframe from the opposite File baseline.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (fixture) {
      const modalOpen = Boolean(await findReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_CENTER_DIALOG));
      applyCleanup(outcome, await cleanupFixture(connection, webdriver, fixture, modalOpen, true));
    }
  }
  return finalize(outcome, "Preview Center mode control did not satisfy every required verdict");
}

async function prepareIdleRenderer(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  source: string,
): Promise<PreviewFixture> {
  const fixture = prepareFixture(request, source);
  await hydrateFixtureBaseline(connection, fixture);
  await postUi(connection, {
    rightTab: "Preview",
    activeTabId: fixture.tabId,
    activeTab: { ...fixture.baselineActiveTab, cwd: fixture.launchRoot },
    source: `final-surface-work-preview-${source}`,
  });
  await waitForReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_START_SELECTOR, {
    timeoutMs: 5_000,
    pollMs: 50,
  });
  return fixture;
}

async function startBackendPreview(
  connection: Connection,
  fixture: PreviewFixture,
): Promise<Record<string, unknown>> {
  return apiJson(
    connection,
    "POST",
    `/preview/work/start?tabId=${encodeURIComponent(fixture.tabId)}`,
    { tabId: fixture.tabId, cwd: fixture.launchRoot, kind: "static", entry: WORK_PREVIEW_ENTRY },
  );
}

async function proveOwnedRunningPage(
  running: Record<string, unknown>,
  fixture: PreviewFixture,
): Promise<string> {
  const url = verifyRunningState(running, fixture);
  const page = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!page.ok || await page.text() !== WORK_PREVIEW_PAGE) {
    throw new Error("owned Work Preview fixture did not serve the exact page");
  }
  return url;
}

async function refreshRenderer(webdriver: WebDriver): Promise<void> {
  const refresh = await waitForReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_REFRESH_SELECTOR, {
    timeoutMs: 5_000,
    pollMs: 50,
  });
  await clickReleaseSurfaceInstalledInputElement(webdriver, refresh);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, OPEN_SELECTOR, {
    timeoutMs: 5_000,
    pollMs: 50,
  });
}

async function renderedState(webdriver: WebDriver): Promise<{ status: string; url: "present" | "absent" }> {
  const value = await observeReleaseSurfaceInstalledInputElement(webdriver, RENDERED_STATE_RECEIPT, ["title"]);
  const match = value.title?.match(/^Work preview state: status=([a-z]+); url=(present|absent)$/);
  if (!value.present || !value.visible || !match) {
    throw new Error("Work Preview renderer omitted its bounded state receipt");
  }
  return { status: match[1]!, url: match[2]! as "present" | "absent" };
}

async function waitForDoctorState(webdriver: WebDriver): Promise<{
  status: string;
  ok: boolean;
  http: string;
  title: "present" | "absent";
  screenshot: "captured" | "unavailable" | "absent";
}> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await observeReleaseSurfaceInstalledInputElement(webdriver, DOCTOR_STATE_RECEIPT, ["title"]);
    const match = value.title?.match(/^Preview Doctor state: status=([a-z]+); ok=(yes|no); http=(\d+|none); title=(present|absent); screenshot=(captured|unavailable|absent)$/);
    if (value.present && value.visible && match) {
      return {
        status: match[1]!,
        ok: match[2] === "yes",
        http: match[3]!,
        title: match[4]! as "present" | "absent",
        screenshot: match[5]! as "captured" | "unavailable" | "absent",
      };
    }
    await delay();
  }
  throw new Error("Work Preview Doctor result did not become visible");
}

async function waitForDoctorScreenshot(
  request: ReleaseSurfaceDriverRequest,
  fixture: PreviewFixture,
): Promise<string> {
  const tokenNodePath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const screenshotRoot = resolve(dirname(dirname(tokenNodePath)), ".grok", "shellx-preview-screenshots");
  const expectedPrefix = `work-preview-${sanitizeTabId(fixture.tabId)}-`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const matches = existsSync(screenshotRoot)
      ? readdirSync(screenshotRoot).filter((name) => name.startsWith(expectedPrefix) && name.endsWith(".png"))
      : [];
    if (matches.length === 1) return resolve(screenshotRoot, matches[0]!);
    if (matches.length > 1) throw new Error("Preview Doctor created more than one owned screenshot");
    await delay();
  }
  throw new Error("Preview Doctor reported a captured screenshot without one exact owned file");
}

async function waitForCenterMode(
  webdriver: WebDriver,
  target: "file" | "work",
): Promise<{
  fileSelected: boolean;
  workSelected: boolean;
  mode: "file" | "work";
  file: "present" | "absent";
  work: "present" | "absent";
}> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [file, work, body] = await Promise.all([
      observeReleaseSurfaceInstalledInputElement(webdriver, FILE_MODE_SELECTOR, ["selected"]),
      observeReleaseSurfaceInstalledInputElement(webdriver, WORK_MODE_SELECTOR, ["selected"]),
      observeReleaseSurfaceInstalledInputElement(webdriver, CENTER_STATE_RECEIPT, ["title"]),
    ]);
    const receipt = body.title?.match(/^Preview Center state: mode=(file|work); file=(present|absent); work=(present|absent)$/);
    const state = {
      fileSelected: file.selected === true,
      workSelected: work.selected === true,
      mode: receipt?.[1] as "file" | "work" | undefined,
      file: receipt?.[2] as "present" | "absent" | undefined,
      work: receipt?.[3] as "present" | "absent" | undefined,
    };
    const selected = target === "file" ? state.fileSelected && !state.workSelected : state.workSelected && !state.fileSelected;
    const bodyMatches = body.present && body.visible && state.mode === target;
    const content = target === "file"
      ? state.file === "present"
      : state.work === "present";
    if (selected && bodyMatches && content) {
      return state as {
        fileSelected: boolean;
        workSelected: boolean;
        mode: "file" | "work";
        file: "present" | "absent";
        work: "present" | "absent";
      };
    }
    await delay();
  }
  throw new Error(`Preview Center did not reach exact ${target} mode ownership`);
}

function deleteDoctorScreenshot(
  request: ReleaseSurfaceDriverRequest,
  fixture: PreviewFixture,
  screenshotPath: string,
): void {
  const screenshotNodePath = nodeReadablePath(screenshotPath, request.platform);
  const tokenNodePath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const profileRoot = dirname(dirname(tokenNodePath));
  const screenshotRoot = resolve(profileRoot, ".grok", "shellx-preview-screenshots");
  const rel = relative(screenshotRoot, screenshotNodePath);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || rel.includes(sep)) {
    throw new Error("Preview Doctor screenshot escaped the isolated screenshot directory");
  }
  const expectedPrefix = `work-preview-${sanitizeTabId(fixture.tabId)}-`;
  if (!basename(screenshotNodePath).startsWith(expectedPrefix) || !basename(screenshotNodePath).endsWith(".png")) {
    throw new Error("Preview Doctor screenshot name did not bind the owned tab");
  }
  const stat = lstatSync(screenshotNodePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    throw new Error("Preview Doctor screenshot was not a nonempty regular file");
  }
  rmSync(screenshotNodePath);
  if (existsSync(screenshotNodePath)) throw new Error("Preview Doctor screenshot remained after deletion");
  if (existsSync(screenshotRoot) && readdirSync(screenshotRoot).length === 0) rmdirSync(screenshotRoot);
  const grokRoot = dirname(screenshotRoot);
  if (existsSync(grokRoot) && readdirSync(grokRoot).length === 0) rmdirSync(grokRoot);
}

function sanitizeTabId(value: string): string {
  const filtered = [...value.trim()]
    .filter((character) => /[A-Za-z0-9._-]/.test(character))
    .slice(0, 80)
    .join("")
    .replace(/^\.+|\.+$/g, "");
  return filtered || "default";
}

function emptyOutcome(assignment: Assignment, observedEffect: string): ReleaseSurfaceDriverOutcome {
  return {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect,
  };
}

function applyCleanup(outcome: ReleaseSurfaceDriverOutcome, error: string | null): void {
  if (!error) {
    outcome.cleanup = "pass";
    return;
  }
  outcome.error = outcome.error ? `${outcome.error}; cleanup: ${error}` : `cleanup: ${error}`;
}

function finalize(outcome: ReleaseSurfaceDriverOutcome, message: string): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = message;
  }
  return outcome;
}

async function delay(): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
}
