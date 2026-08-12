import {
  clickReleaseSurfaceInstalledInputElement,
  closeReleaseSurfaceInstalledInputWindow,
  createReleaseSurfaceInstalledInputSession,
  observeReleaseSurfaceInstalledInputElement,
  switchReleaseSurfaceInstalledInputWindow,
  switchReleaseSurfaceInstalledInputWindowByTitle,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import {
  completionTimestamp,
  type ReleaseSurfaceDriverOutcome,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { cleanupOwnedBrowserLifecycle } from "../shellx-browser-test-cleanup";
import { startOwnedBrowserHomePage, type OwnedBrowserHomePage } from "./ui-control-owned-browser-bookmarks";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;
type ControlKind = "teach" | "inspect" | "approve" | "disable" | "har" | "performance";
type MarkerScenario = "base" | "denied" | "active" | "partial" | "clean" | "artifact-har" | "teach";
type BrowserDeveloperArtifactKind = "har" | "performance";

export const BROWSER_DEVELOPER_EVIDENCE_CONTROL_FIXTURE = "ui:browser-developer-evidence-owned-task";
export const BROWSER_DEVELOPER_EVIDENCE_CONTROL_CLEANUP = "ui:clear-browser-developer-site-approval-close-owned-task-and-window";
export const BROWSER_DEVELOPER_EVIDENCE_DEBUG_FIXTURE = "ui:browser-developer-evidence-owned-marker-state";
export const BROWSER_DEVELOPER_EVIDENCE_DEBUG_CLEANUP = "ui:clear-browser-developer-marker-state-close-owned-task-and-window";
export const BROWSER_DEVELOPER_EVIDENCE_CONTROL_ORACLES = [
  "ui:activation:browser-evidence-teach-owned-draft",
  "ui:activation:browser-developer-inspection-denied",
  "ui:activation:browser-developer-site-approved",
  "ui:activation:browser-developer-mode-disabled",
  "ui:activation:browser-developer-artifact-receipt",
] as const;
export const BROWSER_DEVELOPER_EVIDENCE_DEBUG_ORACLE = "ui:visible-browser-developer-evidence-marker";

const CONTROL_BY_NAME: Record<string, ControlKind> = {
  'src/browser/components/BrowserEvidencePanel.tsx:[data-debug-id="shellx-browser-evidence-teach-workflow"]': "teach",
  'src/browser/components/BrowserDeveloperInspection.tsx:[data-debug-id="shellx-browser-developer-inspect"]': "inspect",
  'src/browser/components/BrowserDeveloperInspection.tsx:[data-debug-id="shellx-browser-developer-approve-current-site"]': "approve",
  'src/browser/components/BrowserDeveloperInspection.tsx:[data-debug-id="shellx-browser-developer-disable-mode"]': "disable",
  'src/browser/components/BrowserDeveloperInspection.tsx:[data-debug-id="shellx-browser-developer-export-har"]': "har",
  'src/browser/components/BrowserDeveloperInspection.tsx:[data-debug-id="shellx-browser-developer-export-performance"]': "performance",
};

const MARKER_BY_ID: Record<string, { selector: string; scenario: MarkerScenario }> = {
  "ui-debug-surface:shellx-browser-evidence-teach-workflow@src/browser/components/BrowserEvidencePanel.tsx#3": {
    selector: "[data-debug-id='shellx-browser-evidence-teach-workflow']",
    scenario: "teach",
  },
  "ui-debug-surface:shellx-browser-developer-*-receipt@src/browser/components/BrowserDeveloperInspection.tsx#1": {
    selector: "[data-debug-id='shellx-browser-developer-har-receipt']",
    scenario: "artifact-har",
  },
  "ui-debug-surface:shellx-browser-developer-access-active@src/browser/components/BrowserDeveloperInspection.tsx#18": {
    selector: "[data-debug-id='shellx-browser-developer-access-active']",
    scenario: "active",
  },
  "ui-debug-surface:shellx-browser-developer-access-required@src/browser/components/BrowserDeveloperInspection.tsx#16": {
    selector: "[data-debug-id='shellx-browser-developer-access-required']",
    scenario: "denied",
  },
  "ui-debug-surface:shellx-browser-developer-approve-current-site@src/browser/components/BrowserDeveloperInspection.tsx#17": {
    selector: "[data-debug-id='shellx-browser-developer-approve-current-site']",
    scenario: "denied",
  },
  "ui-debug-surface:shellx-browser-developer-artifacts@src/browser/components/BrowserDeveloperInspection.tsx#20": {
    selector: "[data-debug-id='shellx-browser-developer-artifacts']",
    scenario: "active",
  },
  "ui-debug-surface:shellx-browser-developer-clean@src/browser/components/BrowserDeveloperInspection.tsx#9": {
    selector: "[data-debug-id='shellx-browser-developer-clean']",
    scenario: "clean",
  },
  "ui-debug-surface:shellx-browser-developer-console-summary@src/browser/components/BrowserDeveloperInspection.tsx#5": {
    selector: "[data-debug-id='shellx-browser-developer-console-summary']",
    scenario: "partial",
  },
  "ui-debug-surface:shellx-browser-developer-disable-mode@src/browser/components/BrowserDeveloperInspection.tsx#19": {
    selector: "[data-debug-id='shellx-browser-developer-disable-mode']",
    scenario: "active",
  },
  "ui-debug-surface:shellx-browser-developer-export-har@src/browser/components/BrowserDeveloperInspection.tsx#13": {
    selector: "[data-debug-id='shellx-browser-developer-export-har']",
    scenario: "base",
  },
  "ui-debug-surface:shellx-browser-developer-export-performance@src/browser/components/BrowserDeveloperInspection.tsx#14": {
    selector: "[data-debug-id='shellx-browser-developer-export-performance']",
    scenario: "base",
  },
  "ui-debug-surface:shellx-browser-developer-inspect@src/browser/components/BrowserDeveloperInspection.tsx#12": {
    selector: "[data-debug-id='shellx-browser-developer-inspect']",
    scenario: "base",
  },
  "ui-debug-surface:shellx-browser-developer-inspection@src/browser/components/BrowserDeveloperInspection.tsx#11": {
    selector: "[data-debug-id='shellx-browser-developer-inspection']",
    scenario: "base",
  },
  "ui-debug-surface:shellx-browser-developer-issues@src/browser/components/BrowserDeveloperInspection.tsx#8": {
    selector: "[data-debug-id='shellx-browser-developer-issues']",
    scenario: "partial",
  },
  "ui-debug-surface:shellx-browser-developer-last-inspected@src/browser/components/BrowserDeveloperInspection.tsx#3": {
    selector: "[data-debug-id='shellx-browser-developer-last-inspected']",
    scenario: "partial",
  },
  "ui-debug-surface:shellx-browser-developer-network-summary@src/browser/components/BrowserDeveloperInspection.tsx#6": {
    selector: "[data-debug-id='shellx-browser-developer-network-summary']",
    scenario: "partial",
  },
  "ui-debug-surface:shellx-browser-developer-page-summary@src/browser/components/BrowserDeveloperInspection.tsx#4": {
    selector: "[data-debug-id='shellx-browser-developer-page-summary']",
    scenario: "partial",
  },
  "ui-debug-surface:shellx-browser-developer-partial@src/browser/components/BrowserDeveloperInspection.tsx#10": {
    selector: "[data-debug-id='shellx-browser-developer-partial']",
    scenario: "partial",
  },
  "ui-debug-surface:shellx-browser-developer-performance-summary@src/browser/components/BrowserDeveloperInspection.tsx#7": {
    selector: "[data-debug-id='shellx-browser-developer-performance-summary']",
    scenario: "partial",
  },
  "ui-debug-surface:shellx-browser-developer-state-*@src/browser/components/BrowserDeveloperInspection.tsx#15": {
    selector: "[data-debug-id='shellx-browser-developer-state-developer-mode-required']",
    scenario: "denied",
  },
  "ui-debug-surface:shellx-browser-developer-summary@src/browser/components/BrowserDeveloperInspection.tsx#2": {
    selector: "[data-debug-id='shellx-browser-developer-summary']",
    scenario: "partial",
  },
};

type BrowserRuntimeState = {
  activeTaskId: string | null;
  activeBrowserTabId: string | null;
  windowOpen: boolean;
  tasks: Array<{ taskId: string; status: string }>;
  tabs: Array<{ browserTabId: string; taskId?: string | null; url?: string | null }>;
  developerMode: {
    enabled: boolean;
    fullCdpAccess: boolean;
    policyDisabled: boolean;
    approvedHosts: string[];
  };
};

type OwnedFixture = {
  taskId: string;
  browserTabId: string;
  originalWindow: string;
  page: OwnedBrowserHomePage;
};

export function supportsBrowserDeveloperEvidenceControl(assignment: Assignment): boolean {
  return assignment.surface.name in CONTROL_BY_NAME;
}

export function supportsBrowserDeveloperEvidenceMarker(assignment: Assignment): boolean {
  return assignment.surface.id in MARKER_BY_ID;
}

export async function executeBrowserDeveloperEvidenceControls(
  request: ReleaseSurfaceDriverRequest,
): Promise<ReleaseSurfaceDriverReport> {
  return execute(request, "control");
}

export async function executeBrowserDeveloperEvidenceMarkers(
  request: ReleaseSurfaceDriverRequest,
): Promise<ReleaseSurfaceDriverReport> {
  return execute(request, "marker");
}

async function execute(
  request: ReleaseSurfaceDriverRequest,
  lane: "control" | "marker",
): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const webdriver = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes = [];
  for (const assignment of request.assignments) {
    outcomes.push(lane === "control"
      ? await exerciseBrowserDeveloperEvidenceControl(connection, webdriver, assignment)
      : await exerciseBrowserDeveloperEvidenceMarker(connection, webdriver, assignment));
  }
  return {
    schema: "shellx/release-surface-driver-report@7",
    mode: request.mode,
    driverId: request.driverId,
    driverKind: request.driverKind,
    platform: request.platform,
    sourceCommit: request.sourceCommit,
    version: request.version,
    inventoryDigest: request.inventoryDigest,
    artifactSha256: request.artifact.sha256,
    controller: request.controller,
    runtime: request.runtime,
    nativeWebDriver: request.nativeWebDriver,
    macosNativeInput: request.macosNativeInput,
    startedAt,
    completedAt: completionTimestamp(startedAt),
    outcomes,
  };
}

export async function exerciseBrowserDeveloperEvidenceControl(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const kind = CONTROL_BY_NAME[assignment.surface.name];
  const outcome = emptyOutcome(assignment);
  let fixture: OwnedFixture | null = null;
  try {
    if (!kind || assignment.fixtureId !== BROWSER_DEVELOPER_EVIDENCE_CONTROL_FIXTURE
      || assignment.cleanupId !== BROWSER_DEVELOPER_EVIDENCE_CONTROL_CLEANUP
      || !BROWSER_DEVELOPER_EVIDENCE_CONTROL_ORACLES.includes(assignment.oracleId as never)) {
      throw new Error(`Browser Developer/Evidence control omitted its exact installed-driver contract: ${assignment.surface.id}`);
    }
    fixture = await prepareFixture(connection, webdriver, `Browser Developer ${kind} control`);
    if (kind === "teach") {
      await prepareTeach(connection, webdriver);
      const target = await waitForReleaseSurfaceInstalledInputElement(webdriver, selectorForControl(kind));
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, target);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-teach-review']");
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, "[data-debug-id='shellx-browser-teach-approval-receipt']");
      await waitForDeveloperMode(connection, (mode) => !mode.enabled && !mode.fullCdpAccess && mode.approvedHosts.length === 0, "Teach without Developer Mode authority");
      outcome.effect = "pass";
      outcome.observedEffect = "Native installed input recorded one complete owned Flight Recorder attempt, then entered Browser Teach with one reversible draft identity and no approval or replay authority.";
    } else if (kind === "inspect") {
      const target = await waitForReleaseSurfaceInstalledInputElement(webdriver, selectorForControl(kind));
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, target);
      outcome.invoke = "pass";
      await waitForDenied(connection, webdriver);
      outcome.effect = "pass";
      outcome.observedEffect = "Native installed input requested inspection and then exposed the exact Developer Mode denial for the owned loopback site without granting CDP access.";
    } else if (kind === "approve") {
      await requireDenied(connection, webdriver);
      const target = await waitForReleaseSurfaceInstalledInputElement(webdriver, selectorForControl(kind));
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, target);
      outcome.invoke = "pass";
      await waitForActiveInspection(connection, webdriver);
      outcome.effect = "pass";
      outcome.observedEffect = "Native installed input approved only the exact owned loopback host, activated Developer Mode, and displayed a bounded completed inspection.";
    } else if (kind === "disable") {
      await requireActiveInspection(connection, webdriver);
      const target = await waitForReleaseSurfaceInstalledInputElement(webdriver, selectorForControl(kind));
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, target);
      outcome.invoke = "pass";
      await waitForDeveloperMode(connection, (mode) => !mode.enabled && !mode.fullCdpAccess && mode.approvedHosts.length === 0, "Developer Mode disable state");
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, "[data-debug-id='shellx-browser-developer-har-receipt']");
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, "[data-debug-id='shellx-browser-developer-performance-receipt']");
      outcome.effect = "pass";
      outcome.observedEffect = "Native installed input disabled Developer Mode, cleared the owned site approval, and removed the bounded inspection and artifact receipt state.";
    } else {
      await requireActiveInspection(connection, webdriver);
      const target = await waitForReleaseSurfaceInstalledInputElement(webdriver, selectorForControl(kind));
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, target);
      outcome.invoke = "pass";
      await requireArtifact(webdriver, kind);
      outcome.effect = "pass";
      outcome.observedEffect = `Native installed input exported one private sanitized ${kind === "har" ? "HAR" : "performance"} artifact and displayed only its receipt identity, byte count, and SHA-256; no filesystem path entered the report.`;
    }
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupFixture(connection, webdriver, fixture, outcome);
  }
  return finalize(outcome);
}

export async function exerciseBrowserDeveloperEvidenceMarker(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const marker = MARKER_BY_ID[assignment.surface.id];
  const outcome = emptyOutcome(assignment);
  let fixture: OwnedFixture | null = null;
  try {
    if (!marker || assignment.fixtureId !== BROWSER_DEVELOPER_EVIDENCE_DEBUG_FIXTURE
      || assignment.cleanupId !== BROWSER_DEVELOPER_EVIDENCE_DEBUG_CLEANUP
      || assignment.oracleId !== BROWSER_DEVELOPER_EVIDENCE_DEBUG_ORACLE) {
      throw new Error(`Browser Developer/Evidence marker omitted its exact installed-driver contract: ${assignment.surface.id}`);
    }
    fixture = await prepareFixture(
      connection,
      webdriver,
      `Browser Developer marker ${assignment.surface.name}`,
      { sanitizationLoss: marker.scenario === "partial" },
    );
    await prepareMarkerScenario(connection, webdriver, marker.scenario);
    await waitForReleaseSurfaceInstalledInputElement(webdriver, marker.selector);
    outcome.present = "pass";
    outcome.invoke = "pass";
    outcome.effect = "pass";
    outcome.observedEffect = `${assignment.surface.name} resolved after genuine native input established its exact owned Browser Developer/Evidence state; the task, tab, site approval, private receipt state, and loopback page are removed during cleanup.`;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupFixture(connection, webdriver, fixture, outcome);
  }
  return finalize(outcome);
}

async function prepareTeach(connection: Connection, webdriver: WebDriver): Promise<void> {
  const record = await waitForReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-evidence-record']");
  await clickReleaseSurfaceInstalledInputElement(webdriver, record);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, ".shellx-browser-evidence-recorded[role='status']");
  const state = await readBrowserState(connection);
  const taskId = state.activeTaskId;
  if (!taskId) throw new Error("Browser Teach fixture has no exact active task to complete");
  const completed = await apiJson(connection, "POST", "/browser/task/finish", {
    taskId,
    status: "completed",
    reason: "release-surface-browser-teach-evidence-ready",
  });
  if (completed.taskId !== taskId || completed.status !== "completed") {
    throw new Error("Browser Teach fixture did not complete its exact evidence-owning task");
  }
}

async function prepareMarkerScenario(
  connection: Connection,
  webdriver: WebDriver,
  scenario: MarkerScenario,
): Promise<void> {
  if (scenario === "base") return;
  if (scenario === "teach") {
    await prepareTeach(connection, webdriver);
    await clickReleaseSurfaceInstalledInputElement(
      webdriver,
      await waitForReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-evidence-teach-workflow']"),
    );
    await waitForReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-teach-review']");
    return;
  }
  if (scenario === "denied") {
    await triggerDenied(connection, webdriver);
    return;
  }
  await requireActiveInspection(connection, webdriver);
  if (scenario === "partial") {
    await waitForReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-developer-partial']");
    return;
  }
  if (scenario === "clean") {
    await clickReleaseSurfaceInstalledInputElement(
      webdriver,
      await waitForReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-developer-inspect']"),
    );
    await waitForReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-developer-clean']");
  } else if (scenario === "artifact-har") {
    await clickReleaseSurfaceInstalledInputElement(
      webdriver,
      await waitForReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-developer-export-har']"),
    );
    await requireArtifact(webdriver, "har");
  }
}

async function requireDenied(connection: Connection, webdriver: WebDriver): Promise<void> {
  await triggerDenied(connection, webdriver);
}

async function triggerDenied(connection: Connection, webdriver: WebDriver): Promise<void> {
  await clickReleaseSurfaceInstalledInputElement(
    webdriver,
    await waitForReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-developer-inspect']"),
  );
  await waitForDenied(connection, webdriver);
}

async function waitForDenied(connection: Connection, webdriver: WebDriver): Promise<void> {
  await waitForReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-developer-access-required']");
  await waitForDeveloperMode(connection, (mode) => !mode.enabled && !mode.fullCdpAccess && mode.approvedHosts.length === 0, "Developer Mode denial");
}

async function requireActiveInspection(connection: Connection, webdriver: WebDriver): Promise<void> {
  const before = await readBrowserState(connection);
  if (!before.developerMode.enabled) await triggerDenied(connection, webdriver);
  await clickReleaseSurfaceInstalledInputElement(
    webdriver,
    await waitForReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-developer-approve-current-site']"),
  );
  await waitForActiveInspection(connection, webdriver);
}

async function waitForActiveInspection(connection: Connection, webdriver: WebDriver): Promise<void> {
  await waitForReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-developer-access-active']");
  await waitForReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-developer-summary']");
  await waitForBrowserState(connection, (state) => {
    const url = state.tabs.find((tab) => tab.taskId === state.activeTaskId)?.url;
    const host = typeof url === "string" ? safeHostname(url) : null;
    return state.developerMode.enabled
      && state.developerMode.fullCdpAccess
      && !state.developerMode.policyDisabled
      && state.developerMode.approvedHosts.length === 1
      && state.developerMode.approvedHosts[0] === host;
  }, "Developer Mode active partial inspection");
}

async function requireArtifact(
  webdriver: WebDriver,
  kind: BrowserDeveloperArtifactKind,
): Promise<void> {
  const selector = `[data-debug-id='shellx-browser-developer-${kind}-receipt']`;
  await waitForReleaseSurfaceInstalledInputElement(webdriver, selector);
  const observed = await observeReleaseSurfaceInstalledInputElement(webdriver, `${selector} span`, ["title"]);
  if (!observed.present || !observed.visible || !observed.title
    || !/\b\d+ B\b/.test(observed.title) || !/sha256 [a-f0-9]{64}$/i.test(observed.title)
    || /(?:file:\/\/|[A-Za-z]:\\|\/(?:home|Users|tmp|var)\/)/.test(observed.title)) {
    throw new Error(`Browser Developer ${kind} UI receipt must be visible, bounded, SHA-attested, and path-free`);
  }
}

async function prepareFixture(
  connection: Connection,
  webdriver: WebDriver,
  label: string,
  options: { sanitizationLoss?: boolean } = {},
): Promise<OwnedFixture> {
  const syntheticCredential = options.sanitizationLoss ? ["ghp", "a".repeat(40)].join("_") : undefined;
  const page = await startOwnedBrowserHomePage({ title: syntheticCredential });
  try {
    const started = await apiJson(connection, "POST", "/browser/task/start", {
      goal: `Final surface ${label}`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: page.startUrl,
      expectedDomains: ["127.0.0.1"],
    });
    const taskId = requiredString(started.taskId, "Browser Developer taskId");
    const state = await waitForBrowserState(connection, (value) => (
      value.activeTaskId === taskId
        && value.tabs.some((tab) => tab.taskId === taskId)
        && value.tasks.some((task) => task.taskId === taskId && task.status === "running")
    ), "Browser Developer owned task baseline");
    const browserTabId = requiredString(
      state.tabs.find((tab) => tab.taskId === taskId)?.browserTabId,
      "Browser Developer browserTabId",
    );
    await apiJson(connection, "POST", "/state/ui", {
      debugSurface: "browser",
      rightTab: "evidence",
      source: "final-surface-browser-developer-evidence-driver",
    });
    const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(webdriver, "ShellX Browser");
    return { taskId, browserTabId, originalWindow: switched.originalHandle, page };
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function cleanupFixture(
  connection: Connection,
  webdriver: WebDriver,
  fixture: OwnedFixture | null,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  const errors: string[] = [];
  if (fixture) {
    try {
      const state = await readBrowserState(connection);
      if (state.developerMode.enabled) {
        await clickReleaseSurfaceInstalledInputElement(
          webdriver,
          await waitForReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-developer-disable-mode']"),
        );
        await waitForDeveloperMode(connection, (mode) => !mode.enabled && !mode.fullCdpAccess && mode.approvedHosts.length === 0, "Developer Mode cleanup");
      }
    } catch (error) {
      errors.push(`clear Developer Mode: ${errorText(error)}`);
    }
    try {
      const result = await cleanupOwnedBrowserLifecycle(
        (method, path, body) => apiJson(connection, method, path, body),
        { taskIds: [fixture.taskId], label: "final surface Browser Developer/Evidence" },
      );
      if (result.errors.length > 0) throw new Error(result.errors.join(" | "));
    } catch (error) {
      errors.push(`close owned Browser task: ${errorText(error)}`);
    }
    try {
      await apiJson(connection, "POST", "/state/ui", {
        debugSurface: "browser",
        rightTab: "chat",
        source: "final-surface-browser-developer-evidence-cleanup",
      });
      await closeReleaseSurfaceInstalledInputWindow(webdriver);
      await switchReleaseSurfaceInstalledInputWindow(webdriver, fixture.originalWindow);
    } catch (error) {
      errors.push(`restore Browser window: ${errorText(error)}`);
    }
    try {
      await fixture.page.close();
    } catch (error) {
      errors.push(`close loopback page: ${errorText(error)}`);
    }
    try {
      await waitForBrowserState(connection, (state) => (
        state.activeTaskId === null
          && !state.tabs.some((tab) => tab.browserTabId === fixture!.browserTabId || tab.taskId === fixture!.taskId)
          && state.tasks.some((task) => (
            task.taskId === fixture!.taskId && (task.status === "aborted" || task.status === "completed")
          ))
          && !state.developerMode.enabled
          && !state.developerMode.fullCdpAccess
          && state.developerMode.approvedHosts.length === 0
          && !state.windowOpen
      ), "Browser Developer/Evidence fixture cleanup");
    } catch (error) {
      errors.push(`verify cleanup: ${errorText(error)}`);
    }
  }
  if (errors.length === 0) outcome.cleanup = "pass";
  else outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}cleanup: ${errors.join(" | ")}`;
}

function selectorForControl(kind: ControlKind): string {
  return kind === "teach"
    ? "[data-debug-id='shellx-browser-evidence-teach-workflow']"
    : `[data-debug-id='shellx-browser-developer-${kind === "performance" ? "export-performance" : kind === "har" ? "export-har" : kind === "approve" ? "approve-current-site" : kind === "disable" ? "disable-mode" : "inspect"}']`;
}

async function readBrowserState(connection: Connection): Promise<BrowserRuntimeState> {
  const value = await apiJson(connection, "GET", "/browser/state");
  if (!Array.isArray(value.tasks) || !Array.isArray(value.tabs)
    || !value.developerMode || typeof value.developerMode !== "object" || Array.isArray(value.developerMode)
    || typeof value.windowOpen !== "boolean") {
    throw new Error("Browser core state omitted its task, tab, window, or Developer Mode contract");
  }
  return value as BrowserRuntimeState;
}

async function waitForBrowserState(
  connection: Connection,
  predicate: (state: BrowserRuntimeState) => boolean,
  label: string,
): Promise<BrowserRuntimeState> {
  const deadline = Date.now() + 5_000;
  let last: BrowserRuntimeState | null = null;
  while (Date.now() < deadline) {
    const state = await readBrowserState(connection);
    last = state;
    if (predicate(state)) return state;
    await delay(25);
  }
  throw new Error(`${label} did not reach its exact state: ${JSON.stringify(last)}`);
}

async function waitForDeveloperMode(
  connection: Connection,
  predicate: (mode: BrowserRuntimeState["developerMode"]) => boolean,
  label: string,
): Promise<void> {
  await waitForBrowserState(connection, (state) => predicate(state.developerMode), label);
}

function safeHostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function apiJson<T extends Record<string, unknown> = Record<string, unknown>>(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} returned HTTP ${response.status}: ${text.slice(0, 240)}`);
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${method} ${path} returned a non-object response`);
  return value as T;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || value.includes("\0")) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
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
    observedEffect: "No exact Browser Developer/Evidence result was observed.",
  };
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Browser Developer/Evidence surface did not satisfy every required verdict";
  }
  return outcome;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
