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
import {
  WORK_PREVIEW_CENTER_CLOSE,
  WORK_PREVIEW_CENTER_DIALOG,
  WORK_PREVIEW_PAGE,
  WORK_PREVIEW_START_SELECTOR,
  apiJson,
  cleanupFixture,
  hydrateFixtureBaseline,
  postUi,
  prepareFixture,
  previewState,
  verifyRunningState,
  waitForRunningState,
  waitForUnavailable,
  type PreviewFixture,
} from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;
type RunningAction = "open" | "restart" | "stop" | "reload" | "viewport-phone" | "viewport-tablet" | "viewport-desktop" | "external-panel" | "external-stage";

const RUNNING_ACTIONS: Record<string, RunningAction> = {
  "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-open\"]": "open",
  "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-restart\"]": "restart",
  "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-stop\"]": "stop",
  "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-frame-reload\"]": "reload",
  "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-viewport-phone\"]": "viewport-phone",
  "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-viewport-tablet\"]": "viewport-tablet",
  "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-viewport-desktop\"]": "viewport-desktop",
  "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-panel-open-external\"]": "external-panel",
  "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-stage-open-external\"]": "external-stage",
};
const LOG_HEIGHT_SURFACE = "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-log-height-toggle\"]";
const LOG_HEIGHT_SELECTOR = "[id='work-preview-log-height-toggle']";
const FRAME_STATE_RECEIPT = ".work-preview-stage-canvas";
const LOG_STATE_RECEIPT = ".work-preview-log";

export const WORK_PREVIEW_RUNNING_FIXTURES = [
  "ui:work-preview-owned-running-project",
  "ui:work-preview-log-default-baseline",
] as const;
export const WORK_PREVIEW_RUNNING_ORACLES = [
  "ui:activation:work-preview-center-opened",
  "ui:activation:work-preview-restarted",
  "ui:activation:work-preview-stopped",
  "ui:activation:work-preview-frame-reloaded",
  "ui:activation:work-preview-log-height-transition",
  "ui:activation:work-preview-external-handoff",
] as const;
export const WORK_PREVIEW_RUNNING_CLEANUPS = [
  "ui:restore-work-preview-log-height-and-right-rail",
] as const;

export function supportsWorkPreviewRunningControl(assignment: Assignment): boolean {
  return assignment.surface.name in RUNNING_ACTIONS || assignment.surface.name === LOG_HEIGHT_SURFACE;
}

export async function exerciseWorkPreviewRunningControl(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  if (assignment.surface.name === LOG_HEIGHT_SURFACE) {
    return exerciseLogHeight(connection, webdriver, assignment);
  }
  const outcome = emptyOutcome(assignment, "No native running Work Preview control effect was observed.");
  const action = RUNNING_ACTIONS[assignment.surface.name];
  let fixture: PreviewFixture | null = null;
  try {
    if (!action) throw new Error(`running Work Preview driver does not support ${assignment.surface.name}`);
    fixture = await startOwnedPreview(connection, webdriver, request, action);
    const before = await previewState(connection, fixture.tabId);
    const beforeUrl = verifyRunningState(before, fixture);
    if (action === "open" || action === "restart" || action === "stop" || action === "external-panel") {
      await closePreviewCenter(webdriver);
    }
    const selector = selectorForAction(action);
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, selector, {
      timeoutMs: 8_000,
      pollMs: 50,
    });
    outcome.present = "pass";
    if (action === "external-panel" || action === "external-stage") {
      const baseline = await readExternalUrlDispatches(connection);
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      const observed = await waitForExternalUrl(connection, baseline.length, beforeUrl);
      if (observed.length !== baseline.length + 1) {
        throw new Error("Work Preview external handoff emitted more than one URL");
      }
      outcome.effect = "pass";
      outcome.observedEffect = `A native WebDriver click dispatched the exact owned Work Preview loopback URL from the ${action === "external-panel" ? "right-rail panel" : "Preview Center stage"} through the isolated external-browser handoff.`;
    } else if (action.startsWith("viewport-")) {
      const target = action.slice("viewport-".length) as "phone" | "tablet" | "desktop";
      const baseline = target === "desktop" ? "phone" : "desktop";
      await clickSelector(webdriver, viewportSelector(baseline));
      await waitForViewport(webdriver, baseline);
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForViewport(webdriver, target);
      outcome.effect = "pass";
      outcome.observedEffect = `A native WebDriver click selected the exact ${target} Work Preview viewport and transferred aria-selected and canvas ownership.`;
    } else if (action === "reload") {
      const initial = await frameState(webdriver);
      if (!initial.framePresent) throw new Error("owned Work Preview frame had no initial mounted receipt");
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      const changed = await waitForFrameReload(webdriver, initial.reloadSeq);
      if (!changed.framePresent || changed.reloadSeq !== initial.reloadSeq + 1) {
        throw new Error("reloaded Work Preview frame lacks its exact bounded reload sequence");
      }
      outcome.effect = "pass";
      outcome.observedEffect = "A native WebDriver click changed the exact owned Work Preview iframe source through its bounded reload sequence.";
    } else if (action === "open") {
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_CENTER_DIALOG, { timeoutMs: 5_000, pollMs: 50 });
      const frame = await frameState(webdriver);
      if (!frame.framePresent) throw new Error("opened Preview Center does not expose its owned running preview frame receipt");
      outcome.effect = "pass";
      outcome.observedEffect = "A native WebDriver click opened Preview Center with the exact owned running Work Preview iframe.";
    } else if (action === "restart") {
      const beforeUpdatedAt = requireInteger(before.updatedAtMs, "running preview updatedAtMs");
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      const restarted = await waitForRestartedState(connection, fixture, beforeUpdatedAt);
      const restartedUrl = verifyRunningState(restarted, fixture);
      const page = await fetch(restartedUrl, { signal: AbortSignal.timeout(5_000) });
      if (!page.ok || await page.text() !== WORK_PREVIEW_PAGE) throw new Error("restarted preview did not serve the exact owned page");
      await waitForReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_CENTER_DIALOG, { timeoutMs: 5_000, pollMs: 50 });
      outcome.effect = "pass";
      outcome.observedEffect = "A native WebDriver click restarted the exact owned Work Preview lifecycle, re-served its byte-exact page, and reopened Preview Center.";
    } else {
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForStoppedState(connection, fixture.tabId);
      await waitForUnavailable(beforeUrl);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_START_SELECTOR, { timeoutMs: 8_000, pollMs: 50 });
      outcome.effect = "pass";
      outcome.observedEffect = "A native WebDriver click stopped the exact owned Work Preview lifecycle and made its former loopback endpoint unavailable.";
    }
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (fixture) {
      if (action?.startsWith("viewport-")) {
        try {
          const state = await frameState(webdriver);
          if (state.selectedId !== "work-preview-viewport-desktop") {
            await clickSelector(webdriver, viewportSelector("desktop"));
            await waitForViewport(webdriver, "desktop");
          }
        } catch (error) {
          const detail = `viewport restore: ${error instanceof Error ? error.message : String(error)}`;
          outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
        }
      }
      const modalOpen = Boolean(await findReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_CENTER_DIALOG));
      const cleanupError = await cleanupFixture(connection, webdriver, fixture, modalOpen);
      if (cleanupError) outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
      else outcome.cleanup = "pass";
    }
  }
  return finalize(outcome, "running Work Preview control did not satisfy every required verdict");
}

async function startOwnedPreview(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  lane: string,
): Promise<PreviewFixture> {
  const fixture = prepareFixture(request, lane);
  await hydrateFixtureBaseline(connection, fixture);
  await postUi(connection, {
    rightTab: "Preview",
    activeTabId: fixture.tabId,
    activeTab: { ...fixture.baselineActiveTab, cwd: fixture.launchRoot },
    source: "final-surface-work-preview-running",
  });
  const start = await waitForReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_START_SELECTOR, { timeoutMs: 5_000, pollMs: 50 });
  await clickReleaseSurfaceInstalledInputElement(webdriver, start);
  const running = await waitForRunningState(connection, fixture);
  verifyRunningState(running, fixture);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, WORK_PREVIEW_CENTER_DIALOG, { timeoutMs: 5_000, pollMs: 50 });
  return fixture;
}

async function exerciseLogHeight(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Work Preview log-height transition was observed.");
  let baselineRightTab: string | null = null;
  try {
    const ui = await apiJson(connection, "GET", "/state/ui");
    baselineRightTab = typeof ui.rightTab === "string" ? ui.rightTab : null;
    if (!baselineRightTab || ui.openModal != null) throw new Error("log-height fixture requires a quiescent restorable right rail");
    await postUi(connection, { rightTab: "Preview", source: "final-surface-work-preview-log-height" });
    const initial = await logState(webdriver);
    if (initial.height !== 260 || initial.storage !== "default") throw new Error("log-height fixture did not start from the isolated default baseline");
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, LOG_HEIGHT_SELECTOR, { timeoutMs: 5_000, pollMs: 50 });
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForLogState(webdriver, 430, "custom");
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click expanded Work Preview logs and persisted the exact bounded height in the isolated candidate profile.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const errors: string[] = [];
    try {
      const current = await logState(webdriver);
      if (current.height === 430) await clickSelector(webdriver, LOG_HEIGHT_SELECTOR);
      await waitForLogState(webdriver, 260, "default");
    } catch (error) {
      errors.push(`log restore: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if (!baselineRightTab) throw new Error("right-rail baseline was unavailable");
      await postUi(connection, { rightTab: baselineRightTab, source: "final-surface-work-preview-log-height-cleanup" });
      const restored = await apiJson(connection, "GET", "/state/ui");
      if (restored.rightTab !== baselineRightTab) throw new Error("right rail was not restored");
    } catch (error) {
      errors.push(`right-rail restore: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (errors.length === 0) outcome.cleanup = "pass";
    else outcome.error = outcome.error ? `${outcome.error}; cleanup: ${errors.join("; ")}` : `cleanup: ${errors.join("; ")}`;
  }
  return finalize(outcome, "Work Preview log-height control did not satisfy every required verdict");
}

function selectorForAction(action: RunningAction): string {
  if (action.startsWith("viewport-")) return viewportSelector(action.slice("viewport-".length));
  if (action === "external-panel") return "[id='work-preview-panel-open-external']";
  if (action === "external-stage") return "[id='work-preview-stage-open-external']";
  return `[id='work-preview-${action === "reload" ? "frame-reload" : action}']`;
}

async function readExternalUrlDispatches(connection: Connection): Promise<string[]> {
  const response = await fetch(`${connection.base}/events/recent?limit=64`, {
    headers: { Authorization: `Bearer ${connection.token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`GET /events/recent failed ${response.status}: ${(await response.text()).slice(0, 800)}`);
  const events = await response.json() as unknown;
  if (!Array.isArray(events)) throw new Error("recent event response is not an array");
  return events.flatMap((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return [];
    const row = event as { kind?: unknown; payload?: unknown };
    if (row.kind !== "external-url-dispatched" || !row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) return [];
    const url = (row.payload as { url?: unknown }).url;
    return typeof url === "string" ? [url] : [];
  });
}

async function waitForExternalUrl(
  connection: Connection,
  baselineLength: number,
  expectedUrl: string,
): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const urls = await readExternalUrlDispatches(connection);
    if (urls.length > baselineLength && urls.at(-1) === expectedUrl) return urls;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Work Preview external handoff did not emit ${expectedUrl}`);
}

function viewportSelector(viewport: string): string {
  return `[id='work-preview-viewport-${viewport}']`;
}

async function closePreviewCenter(webdriver: WebDriver): Promise<void> {
  await clickSelector(webdriver, WORK_PREVIEW_CENTER_CLOSE);
  await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, WORK_PREVIEW_CENTER_DIALOG, { timeoutMs: 5_000, pollMs: 50 });
}

async function clickSelector(webdriver: WebDriver, selector: string): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, selector, { timeoutMs: 5_000, pollMs: 50 });
  await clickReleaseSurfaceInstalledInputElement(webdriver, control);
}

async function frameState(webdriver: WebDriver): Promise<{
  framePresent: boolean;
  reloadSeq: number;
  selectedId: string | null;
  viewport: "phone" | "tablet" | "desktop";
}> {
  const selectors = ["phone", "tablet", "desktop"].map(viewportSelector);
  const [phone, tablet, desktop, canvas] = await Promise.all([
    observeReleaseSurfaceInstalledInputElement(webdriver, selectors[0]!, ["selected"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, selectors[1]!, ["selected"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, selectors[2]!, ["selected"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, FRAME_STATE_RECEIPT, ["title"]),
  ]);
  const selected = [phone, tablet, desktop]
    .map((state, index) => state.selected === true ? ["phone", "tablet", "desktop"][index]! : null)
    .filter((viewport): viewport is string => Boolean(viewport));
  const receipt = canvas.title?.match(/^Work preview stage: viewport=(phone|tablet|desktop); frame=(present|absent); reload=(\d+)$/);
  if (!canvas.present || !canvas.visible || !receipt || selected.length !== 1 || receipt[1] !== selected[0]) {
    throw new Error("Work Preview stage omitted its bounded viewport/frame receipt");
  }
  return {
    framePresent: receipt[2] === "present",
    reloadSeq: Number(receipt[3]),
    selectedId: `work-preview-viewport-${selected[0]!}`,
    viewport: receipt[1]! as "phone" | "tablet" | "desktop",
  };
}

async function waitForViewport(webdriver: WebDriver, target: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await frameState(webdriver);
    if (state.selectedId === `work-preview-viewport-${target}` && state.viewport === target) return;
    await delay();
  }
  throw new Error(`Work Preview viewport did not reach ${target}`);
}

async function waitForFrameReload(webdriver: WebDriver, initial: number): Promise<Awaited<ReturnType<typeof frameState>>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await frameState(webdriver);
    if (state.framePresent && state.reloadSeq > initial) return state;
    await delay();
  }
  throw new Error("Work Preview iframe reload sequence did not change");
}

async function waitForRestartedState(connection: Connection, fixture: PreviewFixture, oldUpdatedAt: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await previewState(connection, fixture.tabId);
    if (state.status === "running" && typeof state.updatedAtMs === "number" && state.updatedAtMs > oldUpdatedAt) return state;
    if (state.status === "failed") throw new Error(`Work Preview restart failed: ${String(state.error ?? "unknown error")}`);
    await delay();
  }
  throw new Error("Work Preview restart did not produce a newer running state");
}

async function waitForStoppedState(connection: Connection, tabId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await previewState(connection, tabId);
    if (state.status === "stopped" && state.url === null) return;
    await delay();
  }
  throw new Error("Work Preview Stop did not reach the exact stopped state");
}

async function logState(webdriver: WebDriver): Promise<{ height: number; storage: "default" | "custom" }> {
  const value = await observeReleaseSurfaceInstalledInputElement(webdriver, LOG_STATE_RECEIPT, ["title"]);
  const match = value.title?.match(/^Work preview log: height=(\d+); storage=(default|custom)$/);
  if (!value.present || !value.visible || !match) {
    throw new Error("Work Preview log omitted its bounded height/storage receipt");
  }
  return { height: Number(match[1]), storage: match[2]! as "default" | "custom" };
}

async function waitForLogState(webdriver: WebDriver, height: number, storage: "default" | "custom"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await logState(webdriver);
    if (state.height === height && state.storage === storage) return;
    await delay();
  }
  throw new Error(`Work Preview log height did not reach ${height}/${storage}`);
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

function finalize(outcome: ReleaseSurfaceDriverOutcome, message: string): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) outcome.error = message;
  return outcome;
}

function requireInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is invalid`);
  return value as number;
}

async function delay(): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
}
