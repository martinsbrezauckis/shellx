import {
  clickReleaseSurfaceInstalledInputElement,
  closeReleaseSurfaceInstalledInputWindow,
  switchReleaseSurfaceInstalledInputWindow,
  switchReleaseSurfaceInstalledInputWindowByTitle,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { apiJson, postUi } from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;
type SetupDestination = "agents" | "browser" | "dismiss" | "downloads" | "requests" | "vault";

const DESTINATION_BY_SURFACE: Record<string, SetupDestination> = Object.fromEntries(
  ["agents", "browser", "downloads", "requests", "vault"].map((id) => [
    `src/components/ShellxSetupGuide.tsx:[data-debug-id="shellx-setup-step-${id}"]`,
    id,
  ]),
) as Record<string, SetupDestination>;
DESTINATION_BY_SURFACE["src/components/ShellxSetupGuide.tsx:[data-debug-id=\"shellx-setup-guide-dismiss\"]"] = "dismiss";
const GUIDE = "[data-debug-id='shellx-setup-guide']";
const SETTINGS = "[role='dialog'][aria-label='Settings']";
const VAULT = "[data-debug-id='vault-workspace-modal']";
const REQUESTS = "[data-debug-id='vault-request-center-popover'][role='dialog']";
const REQUEST_TOGGLE = "[data-debug-id='header-vault-request-center'][aria-expanded='true']";

export const SETUP_GUIDE_FIXTURES = ["ui:setup-guide-destinations-closed"] as const;
export const SETUP_GUIDE_CLEANUPS = ["ui:restore-setup-guide-destinations"] as const;
export const SETUP_GUIDE_ORACLES = [
  "ui:activation:setup-guide-vault-opened",
  "ui:activation:setup-guide-browser-opened",
  "ui:activation:setup-guide-download-settings-opened",
  "ui:activation:setup-guide-agent-settings-opened",
  "ui:activation:setup-guide-requests-opened",
  "ui:activation:setup-guide-dismissed",
] as const;

export function supportsSetupGuideControl(assignment: Assignment): boolean {
  return assignment.surface.name in DESTINATION_BY_SURFACE;
}

export async function exerciseSetupGuideControl(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const destination = DESTINATION_BY_SURFACE[assignment.surface.name];
  const outcome = emptyOutcome(assignment);
  let baseline: { settingsTab: string; setupGuideDismissed: boolean } | null = null;
  let originalWindow: string | null = null;
  let browserOpened = false;
  try {
    if (!destination) throw new Error(`Setup Guide driver does not support ${assignment.surface.name}`);
    baseline = await prepare(connection, webdriver);
    const control = await waitForReleaseSurfaceInstalledInputElement(
      webdriver,
      destination === "dismiss"
        ? "[data-debug-id='shellx-setup-guide-dismiss']"
        : `[data-debug-id='shellx-setup-step-${destination}']`,
      { timeoutMs: 5_000, pollMs: 50 },
    );
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";

    if (destination === "dismiss") {
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, GUIDE, { timeoutMs: 5_000, pollMs: 50 });
      const state = await apiJson(connection, "GET", "/state/ui");
      if (state.setupGuideDismissed !== true) throw new Error("Setup Guide dismiss did not persist its exact local state");
    } else if (destination === "browser") {
      const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(webdriver, "ShellX Browser");
      originalWindow = switched.originalHandle;
      browserOpened = true;
      await waitForBrowserWindow(connection, true);
    } else if (destination === "downloads" || destination === "agents") {
      const tab = destination === "downloads" ? "general" : "shellxagent";
      await waitForReleaseSurfaceInstalledInputElement(webdriver, SETTINGS, { timeoutMs: 5_000, pollMs: 50 });
      await waitForReleaseSurfaceInstalledInputElement(
        webdriver,
        `[data-debug-id='settings-tab-${tab}'][aria-selected='true']`,
        { timeoutMs: 5_000, pollMs: 50 },
      );
      await waitForReleaseSurfaceInstalledInputElement(
        webdriver,
        `#settings-tab-panel[aria-labelledby='settings-tab-${tab}']`,
        { timeoutMs: 5_000, pollMs: 50 },
      );
    } else if (destination === "requests") {
      await waitForReleaseSurfaceInstalledInputElement(webdriver, REQUESTS, { timeoutMs: 5_000, pollMs: 50 });
      await waitForReleaseSurfaceInstalledInputElement(webdriver, REQUEST_TOGGLE, { timeoutMs: 5_000, pollMs: 50 });
    } else {
      await waitForReleaseSurfaceInstalledInputElement(webdriver, VAULT, { timeoutMs: 5_000, pollMs: 50 });
      const status = await apiJson(connection, "GET", "/vault/status");
      const expectedIntent = status.recoveryConfirmed === true
        && status.mode !== "unconfigured" && status.mode !== "legacyLimited"
        ? "overview"
        : "setup";
      const state = await apiJson(connection, "GET", "/state/ui");
      if (state.vaultWorkspaceIntent !== expectedIntent) {
        throw new Error(`Setup Guide Vault destination opened ${String(state.vaultWorkspaceIntent)} instead of ${expectedIntent}`);
      }
    }

    outcome.effect = "pass";
    outcome.observedEffect = observedEffect(destination);
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const errors: string[] = [];
    try {
      if (browserOpened && originalWindow) {
        await closeReleaseSurfaceInstalledInputWindow(webdriver);
        await switchReleaseSurfaceInstalledInputWindow(webdriver, originalWindow);
        await waitForBrowserWindow(connection, false);
      } else if (originalWindow) {
        await switchReleaseSurfaceInstalledInputWindow(webdriver, originalWindow);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (baseline) {
      try {
        await restore(connection, webdriver, baseline);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (errors.length === 0) outcome.cleanup = "pass";
    else outcome.error = outcome.error ? `${outcome.error}; cleanup: ${errors.join("; ")}` : `cleanup: ${errors.join("; ")}`;
  }
  return finalize(outcome);
}

async function prepare(
  connection: Connection,
  webdriver: WebDriver,
): Promise<{ settingsTab: string; setupGuideDismissed: boolean }> {
  const state = await apiJson(connection, "GET", "/state/ui");
  const settingsTab = typeof state.settingsTab === "string" ? state.settingsTab : "";
  if (!settingsTab || typeof state.setupGuideDismissed !== "boolean") {
    throw new Error("Setup Guide fixture could not read its exact Settings and dismissal baseline");
  }
  if (state.settingsOpen !== false || state.vaultRequestCenterOpen !== false) {
    throw new Error("Setup Guide fixture requires closed isolated destination surfaces");
  }
  await postUi(connection, {
    openModal: "close",
    vaultRequestCenterOpen: false,
    setupGuideDismissed: false,
    source: "final-surface-setup-guide-destination",
  });
  await waitForReleaseSurfaceInstalledInputElement(webdriver, GUIDE, { timeoutMs: 5_000, pollMs: 50 });
  return { settingsTab, setupGuideDismissed: state.setupGuideDismissed };
}

async function restore(
  connection: Connection,
  webdriver: WebDriver,
  baseline: { settingsTab: string; setupGuideDismissed: boolean },
): Promise<void> {
  try {
    const settings = await waitForReleaseSurfaceInstalledInputElement(webdriver, SETTINGS, { timeoutMs: 250, pollMs: 50 });
    void settings;
    const tab = await waitForReleaseSurfaceInstalledInputElement(
      webdriver,
      `[data-debug-id='settings-tab-${baseline.settingsTab}']`,
      { timeoutMs: 2_000, pollMs: 50 },
    );
    await clickReleaseSurfaceInstalledInputElement(webdriver, tab);
  } catch {
    // Settings is closed for the other Setup Guide destinations.
  }
  await postUi(connection, {
    openModal: "close",
    vaultRequestCenterOpen: false,
    setupGuideDismissed: baseline.setupGuideDismissed,
    source: "final-surface-setup-guide-destination-cleanup",
  });
  await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, SETTINGS, { timeoutMs: 5_000, pollMs: 50 });
  await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, VAULT, { timeoutMs: 5_000, pollMs: 50 });
  await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, REQUESTS, { timeoutMs: 5_000, pollMs: 50 });
  if (baseline.setupGuideDismissed) {
    await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, GUIDE, { timeoutMs: 5_000, pollMs: 50 });
  } else {
    await waitForReleaseSurfaceInstalledInputElement(webdriver, GUIDE, { timeoutMs: 5_000, pollMs: 50 });
  }
  const state = await apiJson(connection, "GET", "/state/ui");
  if (state.settingsTab !== baseline.settingsTab || state.settingsOpen !== false
    || state.vaultRequestCenterOpen !== false || state.setupGuideDismissed !== baseline.setupGuideDismissed) {
    throw new Error("Setup Guide cleanup did not restore its exact UI baseline");
  }
}

async function waitForBrowserWindow(connection: Connection, open: boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await apiJson(connection, "GET", "/browser/state");
    if (state.windowOpen === open) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Setup Guide Browser destination did not reach windowOpen=${open}`);
}

function observedEffect(destination: SetupDestination): string {
  if (destination === "browser") return "A native WebDriver click opened the separately titled ShellX Browser window and its exact Browser state.";
  if (destination === "dismiss") return "A native WebDriver click dismissed the Setup Guide and changed its exact local dismissal state before restoration.";
  if (destination === "downloads") return "A native WebDriver click opened Settings with General selected and its exact tabpanel visible.";
  if (destination === "agents") return "A native WebDriver click opened Settings with ShellX Agent selected and its exact tabpanel visible.";
  if (destination === "requests") return "A native WebDriver click expanded the Vault Request Center and exposed its exact dialog owner.";
  return "A native WebDriver click opened the Vault workspace with the exact setup-or-overview intent derived from metadata-only Vault status.";
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
    observedEffect: "No native Setup Guide destination effect was observed.",
  };
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Setup Guide destination did not satisfy every required verdict";
  }
  return outcome;
}
