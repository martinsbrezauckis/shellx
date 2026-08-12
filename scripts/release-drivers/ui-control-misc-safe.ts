import {
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputAccessibilityButton,
  clickReleaseSurfaceInstalledInputElement,
  executeReleaseSurfaceInstalledInputScript,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { nodeReadablePath } from "./debug-api-session-fixture";
import { apiJson, postUi } from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;

const PR_TRANSCRIPT_SURFACE = "src/components/PRCreateModal.tsx::is([title=\"Append the session transcript as an appendix\"],[title=\"No transcript captured yet\"])";
const HASH_AUTOCOMPLETE_SURFACE = "src/components/HashAutocomplete.tsx:[data-debug-id=\"surface-components-hashautocomplete-1\"]";
const MARKDOWN_PREVIEW_SURFACE = "src/lib/markdown-links.tsx:[data-debug-id=\"surface-lib-markdown-links-1\"]";
const MARKDOWN_EXTERNAL_SURFACE = "src/lib/markdown-links.tsx:[data-debug-id=\"surface-lib-markdown-links-2\"]";
const UPDATE_BANNER_NOTES_SURFACE = "src/components/UpdateBanner.tsx:role=button;name=\"Release notes\"";
const RIGHT_RAIL_NOTES_SURFACE = "src/components/RightRail.tsx:role=button;name=\"Notes\"";
const UPDATE_BANNER_INSTALL_SURFACE = "src/components/UpdateBanner.tsx:role=button;name=\"Install &amp; restart\"";
const RIGHT_RAIL_CHECK_SURFACE = "src/components/RightRail.tsx:role=button;name=\"Check\"";
const RIGHT_RAIL_INSTALL_SURFACE = "src/components/RightRail.tsx:role=button;name=\"Install\"";
const ABOUT_CHECK_SURFACE = "src/components/settings/AboutTab.tsx:[data-debug-id=\"surface-components-settings-abouttab-1\"]";
const ABOUT_INSTALL_SURFACE = "src/components/settings/AboutTab.tsx:role=button;name=\"Install &amp; restart\"";
const DEBUG_API_RETRY_SURFACE = "src/components/DebugApiConnectionBanner.tsx:[data-debug-id=\"debug-api-retry\"]";
const ERROR_BOUNDARY_RESET_SURFACE = "src/components/ErrorBoundary.tsx:role=button;name=\"Reset UI\"";
const ERROR_BOUNDARY_RELOAD_SURFACE = "src/components/ErrorBoundary.tsx:role=button;name=\"Reload window\"";
const PR_CREATE_SURFACE = "src/components/PRCreateModal.tsx:[data-debug-id=\"surface-components-prcreatemodal-10\"]";
const ARTIFACT_ARCHIVE_SURFACE = "src/App.tsx:[aria-label=\"Download Grok session artifacts\"]";
const PR_TRANSCRIPT = ":is([title='Append the session transcript as an appendix'],[title='No transcript captured yet'])";
const PR_DIALOG = "[role='dialog'][aria-label='Create pull request']";
const HASH_ROW = "[data-debug-id='surface-components-hashautocomplete-1']";
const COMPOSER = "[data-debug-id='composer-prompt']";
const MARKDOWN_PREVIEW_LINK = "[data-debug-id='surface-lib-markdown-links-1']";
const MARKDOWN_EXTERNAL_LINK = "[data-debug-id='surface-lib-markdown-links-2']";
const UPDATE_BANNER_NOTES = "div[role='status'] > button:first-of-type";
const RIGHT_RAIL_NOTES = ".update-diagnostic .tooling-actions > button:first-child";
const UPDATE_CONTROL_BY_SURFACE = new Map<string, string>([
  [UPDATE_BANNER_INSTALL_SURFACE, "[data-release-update-control='banner-install']"],
  [RIGHT_RAIL_CHECK_SURFACE, "[data-release-update-control='right-rail-check']"],
  [RIGHT_RAIL_INSTALL_SURFACE, "[data-release-update-control='right-rail-install']"],
  [ABOUT_CHECK_SURFACE, "[data-release-update-control='about-check']"],
  [ABOUT_INSTALL_SURFACE, "[data-release-update-control='about-install']"],
]);
const UPDATE_RECEIPT_BY_SURFACE = new Map<string, string>([
  [UPDATE_BANNER_INSTALL_SURFACE, "[data-release-update-receipt='banner']"],
  [RIGHT_RAIL_CHECK_SURFACE, "[data-release-update-receipt='right-rail']"],
  [RIGHT_RAIL_INSTALL_SURFACE, "[data-release-update-receipt='right-rail']"],
  [ABOUT_CHECK_SURFACE, "[data-release-update-receipt='about']"],
  [ABOUT_INSTALL_SURFACE, "[data-release-update-receipt='about']"],
]);
const UPDATE_CHECK_RECEIPT = "release fixture update check completed";
const UPDATE_INSTALL_RECEIPT = "release fixture update install boundary completed";
const DEBUG_API_RETRY = "[data-debug-id='debug-api-retry']";
const DEBUG_API_DISCONNECTED = "[data-debug-id='debug-api-disconnected']";
const ERROR_BOUNDARY_ALERT = "[role='alert']";
const ERROR_BOUNDARY_RESET = "[role='alert'] button:first-of-type";
const ERROR_BOUNDARY_RELOAD = "[role='alert'] button:last-of-type";
const PR_CREATE = "[data-debug-id='surface-components-prcreatemodal-10']";
const PR_APPROVAL = "[data-debug-id='surface-components-prcreatemodal-8']";
const PR_BASE = "[data-debug-id='pr-base-input']";
const PR_TITLE = "[data-debug-id='pr-title-input']";
const PR_BODY = "[data-debug-id='pr-body-input']";
const PR_BOUNDARY_RECEIPT = "[data-release-pr-create-receipt='boundary']";
const ARTIFACT_ARCHIVE = "[aria-label='Download Grok session artifacts']";
const PR_RECEIPT_TITLE = "release fixture PR create stopped before remote mutation";
const ARTIFACT_RECEIPT_TITLE = "release fixture artifact archive stopped before save picker";
const APP_RECOVERY_MARKER = ".shell";
const RELEASE_RENDERER_CRASH = "SHELLX_RELEASE_TEST_RENDERER_CRASH_035";
const OWNED_EXTERNAL_URL = "https://example.invalid/shellx/release-docs";
const OWNED_UPDATE_URL = "https://github.com/martinsbrezauckis/shellx/releases/tag/v0.3.5-release-fixture";
const PREVIEW_DIALOG = "[role='dialog'][aria-label='Preview Center']";
const OWNED_HASH_INSERTION = "[#735: Owned autocomplete fixture](https://example.invalid/shellx/issues/735) ";

export const MISC_SAFE_UI_FIXTURES = [
  "ui:pr-transcript-owned-renderer-baseline",
  "ui:hash-autocomplete-owned-composer-baseline",
  "ui:markdown-link-owned-file-projection",
  "ui:markdown-link-owned-external-projection",
  "ui:update-owned-available-notes",
  "ui:update-owned-check",
  "ui:update-owned-available-install-boundary",
  "ui:debug-api-owned-disconnected-retry",
  "ui:error-boundary-owned-renderer-crash-reset",
  "ui:error-boundary-owned-renderer-crash-reload",
  "ui:external-effect-pr-create-boundary",
  "ui:external-effect-artifact-archive-boundary",
] as const;

export const MISC_SAFE_UI_CLEANUPS = [
  "ui:restore-pr-transcript-close-modal-and-clear-events",
  "ui:clear-hash-draft-and-owned-items",
  "ui:close-preview-clear-events-delete-owned-file-and-restore-chat",
  "ui:clear-owned-update-fixture-and-restore-right-rail",
  "ui:clear-owned-update-fixture-close-settings-and-restore-baseline",
  "ui:clear-debug-api-disconnected-fixture",
  "ui:recover-isolated-renderer-and-preserve-backend",
  "ui:clear-external-effect-boundary-close-pr-restore-baseline",
  "ui:clear-external-effect-boundary-restore-artifact-control",
] as const;

export const MISC_SAFE_UI_ORACLES = [
  "ui:boolean-state-transition",
  "ui:activation:hash-autocomplete-owned-insertion",
  "ui:activation:markdown-owned-file-preview-opened",
  "ui:activation:markdown-owned-external-handoff",
  "ui:activation:update-release-notes-external-handoff",
  "ui:activation:update-check-completed",
  "ui:activation:update-install-boundary-completed",
  "ui:activation:debug-api-websocket-reconnected",
  "ui:activation:error-boundary-renderer-recovered",
  "ui:activation:pr-create-remote-boundary",
  "ui:activation:artifact-archive-save-picker-boundary",
] as const;

export function supportsMiscSafeUiControl(assignment: Assignment): boolean {
  return assignment.surface.name === PR_TRANSCRIPT_SURFACE
    || assignment.surface.name === HASH_AUTOCOMPLETE_SURFACE
    || assignment.surface.name === MARKDOWN_PREVIEW_SURFACE
    || assignment.surface.name === MARKDOWN_EXTERNAL_SURFACE
    || assignment.surface.name === UPDATE_BANNER_NOTES_SURFACE
    || assignment.surface.name === RIGHT_RAIL_NOTES_SURFACE
    || UPDATE_CONTROL_BY_SURFACE.has(assignment.surface.name)
    || assignment.surface.name === DEBUG_API_RETRY_SURFACE
    || assignment.surface.name === ERROR_BOUNDARY_RESET_SURFACE
    || assignment.surface.name === ERROR_BOUNDARY_RELOAD_SURFACE
    || assignment.surface.name === PR_CREATE_SURFACE
    || assignment.surface.name === ARTIFACT_ARCHIVE_SURFACE;
}

export async function exerciseMiscSafeUiControl(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  if (assignment.surface.name === PR_TRANSCRIPT_SURFACE) {
    return exercisePrTranscript(connection, webdriver, assignment);
  }
  if (assignment.surface.name === HASH_AUTOCOMPLETE_SURFACE) {
    return exerciseHashAutocomplete(connection, webdriver, assignment);
  }
  if (assignment.surface.name === MARKDOWN_PREVIEW_SURFACE) {
    return exerciseMarkdownPreview(connection, webdriver, request, assignment);
  }
  if (assignment.surface.name === MARKDOWN_EXTERNAL_SURFACE) {
    return exerciseMarkdownExternal(connection, webdriver, request, assignment);
  }
  if (assignment.surface.name === UPDATE_BANNER_NOTES_SURFACE
    || assignment.surface.name === RIGHT_RAIL_NOTES_SURFACE) {
    return exerciseUpdateNotesExternal(connection, webdriver, assignment);
  }
  if (UPDATE_CONTROL_BY_SURFACE.has(assignment.surface.name)) {
    return exerciseUpdateLifecycle(connection, webdriver, assignment);
  }
  if (assignment.surface.name === DEBUG_API_RETRY_SURFACE) {
    return exerciseDebugApiRetry(connection, webdriver, assignment);
  }
  if (assignment.surface.name === ERROR_BOUNDARY_RESET_SURFACE
    || assignment.surface.name === ERROR_BOUNDARY_RELOAD_SURFACE) {
    return exerciseErrorBoundaryRecovery(
      connection,
      webdriver,
      assignment,
      assignment.surface.name === ERROR_BOUNDARY_RELOAD_SURFACE ? "reload" : "reset",
    );
  }
  if (assignment.surface.name === PR_CREATE_SURFACE) {
    return exercisePrCreateBoundary(connection, webdriver, assignment);
  }
  if (assignment.surface.name === ARTIFACT_ARCHIVE_SURFACE) {
    return exerciseArtifactArchiveBoundary(connection, webdriver, assignment);
  }
  const outcome = emptyOutcome(assignment, "No supported miscellaneous UI lifecycle was selected.");
  outcome.error = `Miscellaneous UI driver does not support ${assignment.surface.name}`;
  return outcome;
}

async function exercisePrCreateBoundary(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No isolated pre-remote PR creation receipt was observed.");
  let prepared = false;
  try {
    const baseline = await apiJson(connection, "GET", "/state/ui");
    if ((baseline.openModal !== undefined && baseline.openModal !== null)
      || await findReleaseSurfaceInstalledInputElement(webdriver, PR_DIALOG)) {
      throw new Error("PR create boundary requires every modal to be closed at baseline");
    }
    await postUi(connection, {
      releaseTestExternalEffectBoundary: "pr-create",
      openModal: "pr",
      source: "final-surface-pr-create-boundary",
    });
    prepared = true;
    await waitForReleaseSurfaceInstalledInputElement(webdriver, PR_DIALOG);
    await setReleaseSurfaceInstalledInputElementValue(
      webdriver,
      await waitForReleaseSurfaceInstalledInputElement(webdriver, PR_BASE),
      "main",
    );
    await setReleaseSurfaceInstalledInputElementValue(
      webdriver,
      await waitForReleaseSurfaceInstalledInputElement(webdriver, PR_TITLE),
      "Release-owned PR boundary",
    );
    await setReleaseSurfaceInstalledInputElementValue(
      webdriver,
      await waitForReleaseSurfaceInstalledInputElement(webdriver, PR_BODY),
      "No remote mutation is permitted.",
    );
    let approval = await observeReleaseSurfaceInstalledInputElement(webdriver, PR_APPROVAL, ["checked"]);
    if (!approval.present || !approval.visible) throw new Error("PR create boundary did not expose the approval control");
    if (approval.checked !== true) {
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, PR_APPROVAL);
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      approval = await waitForChecked(webdriver, PR_APPROVAL, true);
    }
    if (approval.checked !== true) throw new Error("PR create boundary did not accept the explicit approval toggle");
    const create = await waitForReleaseSurfaceInstalledInputElement(webdriver, PR_CREATE);
    const enabled = await observeReleaseSurfaceInstalledInputElement(webdriver, PR_CREATE, ["disabled"]);
    if (!enabled.present || !enabled.visible || enabled.disabled !== false) {
      throw new Error("PR create boundary did not expose an enabled Create PR action with complete owned inputs");
    }
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, create);
    outcome.invoke = "pass";
    await waitForExactTitle(webdriver, PR_BOUNDARY_RECEIPT, PR_RECEIPT_TITLE);
    if (!await findReleaseSurfaceInstalledInputElement(webdriver, PR_DIALOG)) {
      throw new Error("PR create boundary closed as if a remote pull request had been created");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click submitted the complete approved renderer-owned PR draft through POST /github/pr/create and received the exact isolated pre-gh/pre-GitHub boundary without a subprocess or remote mutation.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const errors: string[] = [];
    if (prepared) {
      try {
        await postUi(connection, {
          releaseTestExternalEffectBoundary: "clear",
          openModal: "close",
          source: "final-surface-pr-create-boundary-cleanup",
        });
        await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, PR_DIALOG);
        await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, PR_BOUNDARY_RECEIPT);
        const restored = await apiJson(connection, "GET", "/state/ui");
        if ((restored.openModal !== undefined && restored.openModal !== null)
          || (restored.releaseTestExternalEffectBoundary !== undefined
            && restored.releaseTestExternalEffectBoundary !== null
            && restored.releaseTestExternalEffectBoundary !== "clear")) {
          throw new Error("PR create boundary cleanup retained its modal or release fixture");
        }
      } catch (error) {
        errors.push(errorText(error));
      }
    } else {
      errors.push("PR create boundary fixture was not prepared");
    }
    applyCleanup(outcome, errors);
  }
  return finalize(outcome, "PR create boundary did not satisfy every required verdict");
}

async function exerciseArtifactArchiveBoundary(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No isolated pre-save-picker artifact archive receipt was observed.");
  let prepared = false;
  try {
    await postUi(connection, {
      releaseTestExternalEffectBoundary: "artifact-archive",
      source: "final-surface-artifact-archive-boundary",
    });
    prepared = true;
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, ARTIFACT_ARCHIVE);
    const baseline = await observeReleaseSurfaceInstalledInputElement(webdriver, ARTIFACT_ARCHIVE, ["title", "disabled"]);
    if (!baseline.present || !baseline.visible || baseline.disabled === true || baseline.title === ARTIFACT_RECEIPT_TITLE) {
      throw new Error("artifact archive boundary did not expose its enabled pre-invocation control");
    }
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForExactTitle(webdriver, ARTIFACT_ARCHIVE, ARTIFACT_RECEIPT_TITLE);
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click invoked the production artifact-download handler and reached the exact isolated pre-save-picker boundary without opening an operating-system dialog, walking session files, or writing an archive.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const errors: string[] = [];
    if (prepared) {
      try {
        await postUi(connection, {
          releaseTestExternalEffectBoundary: "clear",
          source: "final-surface-artifact-archive-boundary-cleanup",
        });
        const restored = await findReleaseSurfaceInstalledInputElement(webdriver, ARTIFACT_ARCHIVE);
        if (restored) {
          const state = await observeReleaseSurfaceInstalledInputElement(webdriver, ARTIFACT_ARCHIVE, ["title"]);
          if (state.title === ARTIFACT_RECEIPT_TITLE) {
            throw new Error("artifact archive boundary cleanup retained its receipt");
          }
        }
        const ui = await apiJson(connection, "GET", "/state/ui");
        if (ui.releaseTestExternalEffectBoundary !== undefined
          && ui.releaseTestExternalEffectBoundary !== null
          && ui.releaseTestExternalEffectBoundary !== "clear") {
          throw new Error("artifact archive boundary cleanup retained its release fixture");
        }
      } catch (error) {
        errors.push(errorText(error));
      }
    } else {
      errors.push("artifact archive boundary fixture was not prepared");
    }
    applyCleanup(outcome, errors);
  }
  return finalize(outcome, "Artifact archive boundary did not satisfy every required verdict");
}

async function waitForChecked(webdriver: WebDriver, selector: string, checked: boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["checked"]);
    if (state.present && state.visible && state.checked === checked) return state;
    await delay(50);
  }
  throw new Error(`${selector} did not reach checked=${checked}`);
}

async function waitForExactTitle(webdriver: WebDriver, selector: string, expectedTitle: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["title"]);
    if (state.present && state.visible && state.title === expectedTitle) return;
    await delay(50);
  }
  throw new Error(`${selector} did not reach title ${expectedTitle}`);
}

type DebugWebSocketHealth = {
  processId?: unknown;
  instanceId?: unknown;
  debugUiWebSocketActive?: unknown;
  debugUiWebSocketGeneration?: unknown;
};

async function exerciseErrorBoundaryRecovery(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
  action: "reset" | "reload",
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No isolated ErrorBoundary recovery was observed.");
  const selector = action === "reload" ? ERROR_BOUNDARY_RELOAD : ERROR_BOUNDARY_RESET;
  let prepared = false;
  try {
    const macosAccessibilityRecovery = webdriver.transport === "macos-native-input";
    const baseline = await debugWebSocketHealth(connection);
    if (baseline.active < 1 || baseline.processId === null || baseline.instanceId === null) {
      throw new Error("ErrorBoundary recovery requires an identified candidate with an active renderer stream");
    }
    await waitForReleaseSurfaceInstalledInputElement(webdriver, APP_RECOVERY_MARKER);
    const baselineErrors = await rendererCrashEvents(connection);
    await postUi(connection, {
      releaseTestRendererCrash: true,
      source: `final-surface-error-boundary-${action}`,
    });
    prepared = true;
    if (!macosAccessibilityRecovery) {
      await waitForRendererCrashEvent(connection, baselineErrors.length + 1);
    }
    let reloadNavigationInterruptedClick = false;
    if (macosAccessibilityRecovery) {
      // The release fixture unmounts App, including the renderer-side IPC and
      // Debug UI observers. On macOS the exact, candidate-bound Accessibility
      // button is therefore the native proof that the crash card rendered;
      // waiting for renderer telemetry first deadlocks the action that restores
      // those observers. The helper refuses every label except these two,
      // requires exactly one bounded AXButton in the attested WebArea, and posts
      // one native click before we verify the reconnected renderer below.
      await waitForDebugWebSocketDisconnect(connection);
      await waitForCrashPatchReplayWindowToExpire(connection);
      await clickReleaseSurfaceInstalledInputAccessibilityButton(
        webdriver,
        action === "reload" ? "Reload window" : "Reset UI",
      );
      outcome.present = "pass";
    } else {
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, selector);
      outcome.present = "pass";
      try {
        await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      } catch (error) {
        if (action !== "reload") throw error;
        reloadNavigationInterruptedClick = true;
      }
    }
    await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, ERROR_BOUNDARY_ALERT);
    await waitForReleaseSurfaceInstalledInputElement(webdriver, APP_RECOVERY_MARKER);
    const restored = await waitForDebugWebSocketReconnect(connection, baseline.generation);
    if (restored.processId !== baseline.processId || restored.instanceId !== baseline.instanceId) {
      throw new Error("ErrorBoundary recovery replaced or drifted the isolated backend identity");
    }
    const finalErrors = await rendererCrashEvents(connection);
    if (!macosAccessibilityRecovery && finalErrors.length !== baselineErrors.length + 1) {
      throw new Error("ErrorBoundary recovery did not record exactly one owned renderer error");
    }
    if (macosAccessibilityRecovery
      && (finalErrors.length < baselineErrors.length || finalErrors.length > baselineErrors.length + 1)) {
      throw new Error("macOS ErrorBoundary recovery observed an unexpected owned renderer-error count");
    }
    outcome.invoke = "pass";
    outcome.effect = "pass";
    outcome.observedEffect = macosAccessibilityRecovery
      ? `The candidate-bound macOS Accessibility helper found exactly one allowlisted ${action === "reload" ? "Reload window" : "Reset UI"} button inside the attested ShellX WebArea, posted its bounded semantic press, restored the stable app-shell control, preserved backend process ${baseline.processId}, and advanced the Debug UI stream from generation ${baseline.generation} to ${restored.generation}.`
      : `A native WebDriver click ${action === "reload" ? "reloaded the renderer document" : "reset the React error boundary"} after the exact owned render crash, restored the stable app-shell control, preserved backend process ${baseline.processId}, and advanced the Debug UI stream from generation ${baseline.generation} to ${restored.generation}.${reloadNavigationInterruptedClick ? " The WebDriver click response ended with the replaced document, and the post-navigation renderer/backend oracle proved the trusted click completed." : ""}`;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const errors: string[] = [];
    if (prepared) {
      try {
        await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, ERROR_BOUNDARY_ALERT);
        await waitForReleaseSurfaceInstalledInputElement(webdriver, APP_RECOVERY_MARKER);
      } catch (error) {
        try {
          if (webdriver.transport === "macos-native-input") {
            await clickReleaseSurfaceInstalledInputAccessibilityButton(webdriver, "Reload window");
          } else {
            const reload = await waitForReleaseSurfaceInstalledInputElement(webdriver, ERROR_BOUNDARY_RELOAD);
            await clickReleaseSurfaceInstalledInputElement(webdriver, reload).catch(() => undefined);
          }
          await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, ERROR_BOUNDARY_ALERT);
          await waitForReleaseSurfaceInstalledInputElement(webdriver, APP_RECOVERY_MARKER);
        } catch (recoveryError) {
          errors.push(`${errorText(error)}; bounded reload recovery failed: ${errorText(recoveryError)}`);
        }
      }
    } else {
      errors.push("ErrorBoundary crash fixture was not prepared");
    }
    applyCleanup(outcome, errors);
  }
  return finalize(outcome, "ErrorBoundary recovery lifecycle did not satisfy every required verdict");
}

async function rendererCrashEvents(connection: Connection): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${connection.base}/events/recent?limit=8000`, {
    headers: { Authorization: `Bearer ${connection.token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`GET /events/recent failed ${response.status}: ${(await response.text()).slice(0, 800)}`);
  const events = await response.json() as unknown;
  if (!Array.isArray(events)) throw new Error("renderer-error readback was not an array");
  return events.filter((event): event is Record<string, unknown> => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    const row = event as Record<string, unknown>;
    if (row.kind !== "renderer-error" || !row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) return false;
    return (row.payload as Record<string, unknown>).message === RELEASE_RENDERER_CRASH;
  });
}

async function waitForRendererCrashEvent(connection: Connection, expectedCount: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await rendererCrashEvents(connection)).length === expectedCount) return;
    await delay(50);
  }
  throw new Error(`renderer-error ledger did not reach exact owned count ${expectedCount}`);
}

async function exerciseDebugApiRetry(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No fresh renderer Debug API event-stream generation was observed.");
  let prepared = false;
  try {
    const baseline = await debugWebSocketHealth(connection);
    if (baseline.active < 1) {
      throw new Error("Debug API retry fixture requires the renderer event stream to be connected at baseline");
    }
    await postUi(connection, {
      debugUiConnectionFixture: "disconnected",
      source: "final-surface-misc-debug-api-retry",
    });
    prepared = true;
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, DEBUG_API_RETRY);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, DEBUG_API_DISCONNECTED);
    const restored = await waitForDebugWebSocketReconnect(connection, baseline.generation);
    if (restored.active < 1) {
      throw new Error("Debug API retry opened a new generation without retaining an active renderer stream");
    }
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click cleared the forced disconnected banner and advanced the isolated candidate's authenticated Debug UI event stream from generation ${baseline.generation} to ${restored.generation}, with ${restored.active} active stream.`;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const errors: string[] = [];
    if (prepared) {
      try {
        await postUi(connection, {
          debugUiConnectionFixture: "clear",
          source: "final-surface-misc-debug-api-retry-cleanup",
        });
        await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, DEBUG_API_DISCONNECTED);
        const state = await apiJson(connection, "GET", "/state/ui");
        if (state.debugUiConnectionFixture !== undefined
          && state.debugUiConnectionFixture !== null
          && state.debugUiConnectionFixture !== "clear") {
          throw new Error("Debug API retry cleanup retained the forced disconnected fixture");
        }
      } catch (error) {
        errors.push(errorText(error));
      }
    } else {
      errors.push("Debug API retry fixture was not prepared");
    }
    applyCleanup(outcome, errors);
  }
  return finalize(outcome, "Debug API retry lifecycle did not satisfy every required verdict");
}

async function debugWebSocketHealth(connection: Connection): Promise<{
  active: number;
  generation: number;
  processId: number | null;
  instanceId: string | null;
}> {
  const health = await apiJson(connection, "GET", "/health") as DebugWebSocketHealth;
  const active = Number(health.debugUiWebSocketActive);
  const generation = Number(health.debugUiWebSocketGeneration);
  if (!Number.isSafeInteger(active) || active < 0
    || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("candidate /health omitted valid Debug UI WebSocket telemetry");
  }
  const processId = Number(health.processId);
  const instanceId = typeof health.instanceId === "string" && health.instanceId ? health.instanceId : null;
  return {
    active,
    generation,
    processId: Number.isSafeInteger(processId) && processId > 0 ? processId : null,
    instanceId,
  };
}

async function waitForDebugWebSocketReconnect(
  connection: Connection,
  baselineGeneration: number,
): Promise<{
  active: number;
  generation: number;
  processId: number | null;
  instanceId: string | null;
}> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const health = await debugWebSocketHealth(connection);
    if (health.generation > baselineGeneration && health.active >= 1) return health;
    await delay(50);
  }
  throw new Error(`Debug UI WebSocket generation did not advance beyond ${baselineGeneration}`);
}

async function waitForDebugWebSocketDisconnect(connection: Connection): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await debugWebSocketHealth(connection);
    if (current.active === 0) return;
    await delay(50);
  }
  throw new Error("ErrorBoundary crash did not close the owned renderer stream before native recovery");
}

async function waitForCrashPatchReplayWindowToExpire(connection: Connection): Promise<void> {
  const state = await apiJson(connection, "GET", "/state/ui");
  const patchMs = Number(state.lastUiPatchMs);
  if (!Number.isFinite(patchMs) || patchMs <= 0 || patchMs > Date.now() + 1_000) {
    throw new Error("ErrorBoundary crash patch omitted a valid authoritative timestamp");
  }
  // A newly mounted App initializes its event cursor to `Date.now() - 500`.
  // Waiting beyond that exact replay horizon prevents the isolated one-shot
  // crash command in the WebSocket backlog from crashing the recovered App.
  const remaining = patchMs + 750 - Date.now();
  if (remaining > 0) await delay(remaining);
}

async function exerciseUpdateLifecycle(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No isolated updater action receipt was observed.");
  const controlSelector = UPDATE_CONTROL_BY_SURFACE.get(assignment.surface.name);
  const receiptSelector = UPDATE_RECEIPT_BY_SURFACE.get(assignment.surface.name);
  if (!controlSelector || !receiptSelector) {
    outcome.error = `missing updater lifecycle selector for ${assignment.surface.name}`;
    return finalize(outcome, "Updater lifecycle selector resolution failed");
  }
  const isCheck = assignment.surface.name === RIGHT_RAIL_CHECK_SURFACE
    || assignment.surface.name === ABOUT_CHECK_SURFACE;
  const isAbout = assignment.surface.name === ABOUT_CHECK_SURFACE
    || assignment.surface.name === ABOUT_INSTALL_SURFACE;
  let baseline: { rightTab: string; settingsOpen: boolean; settingsTab: string } | null = null;
  let prepared = false;
  try {
    const state = await apiJson(connection, "GET", "/state/ui");
    const storedSettingsTab = await executeReleaseSurfaceInstalledInputScript(
      webdriver,
      "return window.localStorage.getItem(arguments[0]);",
      ["shellX.settingsTab.v2"],
    );
    const settingsTab = typeof storedSettingsTab === "string" && [
      "general", "vault", "connections", "connectors", "desktop", "shellxagent", "data", "about",
    ].includes(storedSettingsTab) ? storedSettingsTab : "general";
    baseline = {
      rightTab: typeof state.rightTab === "string" ? state.rightTab : "",
      settingsOpen: Boolean(await findReleaseSurfaceInstalledInputElement(
        webdriver,
        "[role='dialog'][aria-label='Settings']",
      )),
      settingsTab,
    };
    if (!baseline.rightTab) throw new Error("updater lifecycle requires a restorable right-rail baseline");
    await postUi(connection, {
      debugUpdateFixture: isCheck ? "owned-check" : "owned-available",
      ...(!isAbout && assignment.surface.name !== UPDATE_BANNER_INSTALL_SURFACE ? { rightTab: "Tooling" } : {}),
      ...(isAbout ? { openModal: "settings" } : {}),
      source: "final-surface-update-lifecycle",
    });
    prepared = true;
    if (isAbout) {
      await waitForReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='settings-tab-about']");
      await postUi(connection, {
        debugClick: "[data-debug-id='settings-tab-about']",
        source: "final-surface-update-lifecycle-about",
      });
    }
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, controlSelector);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    const expectedReceipt = isCheck ? UPDATE_CHECK_RECEIPT : UPDATE_INSTALL_RECEIPT;
    await waitForUpdateReceipt(webdriver, receiptSelector, expectedReceipt);
    if (!isCheck) await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, controlSelector);
    outcome.effect = "pass";
    outcome.observedEffect = isCheck
      ? "A native WebDriver click invoked the production updater check handler and reached the exact isolated available-update receipt without network access."
      : "A native WebDriver click invoked the production updater install handler and reached its isolated pre-download boundary without network, application replacement, or relaunch.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const errors: string[] = [];
    if (prepared && baseline) {
      try {
        await postUi(connection, {
          debugUpdateFixture: "clear",
          rightTab: baseline.rightTab,
          ...(isAbout ? { openModal: "settings" } : {}),
          source: "final-surface-update-lifecycle-cleanup",
        });
        if (isAbout) {
          await postUi(connection, {
            debugClick: `[data-debug-id='settings-tab-${baseline.settingsTab}']`,
            source: "final-surface-update-lifecycle-restore-tab",
          });
          if (!baseline.settingsOpen) {
            await postUi(connection, {
              openModal: "close",
              source: "final-surface-update-lifecycle-close-settings",
            });
          }
        }
        const restored = await apiJson(connection, "GET", "/state/ui");
        const restoredSettingsOpen = Boolean(await findReleaseSurfaceInstalledInputElement(
          webdriver,
          "[role='dialog'][aria-label='Settings']",
        ));
        const restoredSettingsTab = await executeReleaseSurfaceInstalledInputScript(
          webdriver,
          "return window.localStorage.getItem(arguments[0]);",
          ["shellX.settingsTab.v2"],
        );
        if (restored.rightTab !== baseline.rightTab
          || (isAbout && restoredSettingsOpen !== baseline.settingsOpen)
          || (isAbout && String(restoredSettingsTab ?? "general") !== baseline.settingsTab)) {
          throw new Error("updater lifecycle cleanup did not restore the exact UI baseline");
        }
      } catch (error) {
        errors.push(errorText(error));
      }
    } else {
      errors.push("updater lifecycle fixture was not prepared");
    }
    applyCleanup(outcome, errors);
  }
  return finalize(outcome, "Updater lifecycle did not satisfy every required verdict");
}

async function waitForUpdateReceipt(
  webdriver: WebDriver,
  selector: string,
  expectedTitle: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["title"]);
    if (state.present && state.visible && state.title === expectedTitle) return;
    await delay(50);
  }
  throw new Error(`updater lifecycle did not reach receipt ${expectedTitle}`);
}

async function exerciseUpdateNotesExternal(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native owned update-notes handoff was observed.");
  const selector = assignment.surface.name === UPDATE_BANNER_NOTES_SURFACE
    ? UPDATE_BANNER_NOTES
    : RIGHT_RAIL_NOTES;
  let baselineRightTab: string | null = null;
  let prepared = false;
  try {
    const baselineUi = await apiJson(connection, "GET", "/state/ui");
    baselineRightTab = typeof baselineUi.rightTab === "string" ? baselineUi.rightTab : null;
    if (!baselineRightTab) throw new Error("update notes fixture requires a restorable right-rail tab");
    const baselineUrls = await readExternalUrlDispatches(connection);
    await postUi(connection, {
      debugUpdateFixture: "owned-available",
      ...(assignment.surface.name === RIGHT_RAIL_NOTES_SURFACE ? { rightTab: "Tooling" } : {}),
      source: "final-surface-misc-update-notes",
    });
    prepared = true;
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, selector);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    const observed = await waitForExternalUrl(connection, baselineUrls.length, OWNED_UPDATE_URL);
    if (observed.length !== baselineUrls.length + 1) {
      throw new Error("update notes handoff emitted more than one URL");
    }
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click dispatched ${OWNED_UPDATE_URL} from the exact isolated ${assignment.surface.name === UPDATE_BANNER_NOTES_SURFACE ? "update banner" : "Tools update card"} without updater network access or an operator browser.`;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const errors: string[] = [];
    if (prepared) {
      try {
        await postUi(connection, {
          debugUpdateFixture: "clear",
          ...(baselineRightTab ? { rightTab: baselineRightTab } : {}),
          source: "final-surface-misc-update-notes-cleanup",
        });
        await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, selector);
        const restored = await apiJson(connection, "GET", "/state/ui");
        if (restored.rightTab !== baselineRightTab) {
          throw new Error("update notes cleanup did not restore the exact right-rail baseline");
        }
      } catch (error) {
        errors.push(errorText(error));
      }
    } else {
      errors.push("update notes fixture was not prepared");
    }
    applyCleanup(outcome, errors);
  }
  return finalize(outcome, "Update notes lifecycle did not satisfy every required verdict");
}

async function exerciseMarkdownExternal(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native owned markdown external handoff was observed.");
  let fixture: OwnedMarkdownFixture | null = null;
  let baselineBottomTab: string | null = null;
  try {
    fixture = prepareMarkdownFixture(request);
    const baselineUi = await apiJson(connection, "GET", "/state/ui");
    baselineBottomTab = typeof baselineUi.bottomTab === "string" ? baselineUi.bottomTab : null;
    if (!baselineBottomTab || baselineUi.preview !== null) {
      throw new Error("markdown external fixture requires a restorable rail and no existing preview");
    }
    const baselineUrls = await readExternalUrlDispatches(connection);
    await postUi(connection, {
      bottomTab: "Chat",
      debugRendererFixture: {
        id: "event-projections",
        attachmentPath: fixture.launchAttachmentPath,
        imagePath: fixture.launchImagePath,
        externalLinkUrl: OWNED_EXTERNAL_URL,
      },
      source: "final-surface-misc-markdown-external",
    });
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, MARKDOWN_EXTERNAL_LINK);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    const observed = await waitForExternalUrl(connection, baselineUrls.length, OWNED_EXTERNAL_URL);
    if (observed.length !== baselineUrls.length + 1) {
      throw new Error("markdown external handoff emitted more than one URL");
    }
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click dispatched ${OWNED_EXTERNAL_URL} from the exact renderer-owned SafeMarkdownLink through the isolated external-browser handoff.`;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const errors: string[] = [];
    if (fixture) {
      try {
        await postUi(connection, {
          bottomTab: baselineBottomTab ?? "Chat",
          debugRendererFixture: "clear",
          source: "final-surface-misc-markdown-external-cleanup",
        });
        await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, MARKDOWN_EXTERNAL_LINK);
        const restored = await apiJson(connection, "GET", "/state/ui");
        if (restored.bottomTab !== baselineBottomTab || restored.preview !== null) {
          throw new Error("markdown external cleanup did not restore the exact UI baseline");
        }
      } catch (error) {
        errors.push(errorText(error));
      }
      try {
        rmSync(fixture.nodeRoot, { recursive: true });
        if (existsSync(fixture.nodeRoot)) throw new Error("owned markdown fixture root remained");
      } catch (error) {
        errors.push(errorText(error));
      }
    } else {
      errors.push("markdown external fixture was not prepared");
    }
    applyCleanup(outcome, errors);
  }
  return finalize(outcome, "Markdown external lifecycle did not satisfy every required verdict");
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

async function waitForExternalUrl(connection: Connection, baselineLength: number, expectedUrl: string): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const urls = await readExternalUrlDispatches(connection);
    if (urls.length > baselineLength && urls.at(-1) === expectedUrl) return urls;
    await delay(50);
  }
  throw new Error(`markdown external handoff did not emit ${expectedUrl}`);
}

async function exercisePrTranscript(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native local PR transcript transition was observed.");
  let prepared = false;
  try {
    if (await findReleaseSurfaceInstalledInputElement(webdriver, PR_DIALOG)) {
      throw new Error("PR transcript fixture requires the PR modal to be closed at baseline");
    }
    await postUi(connection, {
      debugRendererFixture: { id: "chat-output-lifecycle" },
      openModal: "pr",
      source: "final-surface-misc-pr-transcript",
    });
    prepared = true;
    await waitForReleaseSurfaceInstalledInputElement(webdriver, PR_DIALOG);
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, PR_TRANSCRIPT);
    const baseline = await prTranscriptState(webdriver);
    if (baseline.present !== true || baseline.disabled !== false || baseline.pressed !== false
      || baseline.title !== "Append the session transcript as an appendix") {
      throw new Error("PR transcript fixture did not expose the exact enabled inactive baseline");
    }
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    const selected = await waitForPrTranscriptState(webdriver, true);
    if (selected.disabled !== false || selected.title !== "Append the session transcript as an appendix") {
      throw new Error("PR transcript toggle changed outside its local option state");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click enabled only the synthetic transcript appendix option in the renderer-owned PR draft; no GitHub request, provider, clipboard, Git command, or file mutation was invoked.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const errors: string[] = [];
    if (prepared) {
      try {
        const state = await prTranscriptState(webdriver).catch(() => null);
        if (state?.pressed === true) {
          const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, PR_TRANSCRIPT);
          await clickReleaseSurfaceInstalledInputElement(webdriver, control);
          await waitForPrTranscriptState(webdriver, false);
        }
        await postUi(connection, {
          debugRendererFixture: { id: "chat-output-lifecycle", action: "clear" },
          openModal: "close",
          source: "final-surface-misc-pr-transcript-cleanup",
        });
        await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, PR_DIALOG);
      } catch (error) {
        errors.push(errorText(error));
      }
    } else {
      errors.push("PR transcript fixture was not prepared");
    }
    applyCleanup(outcome, errors);
  }
  return finalize(outcome, "PR transcript lifecycle did not satisfy every required verdict");
}

async function exerciseHashAutocomplete(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native owned hash-autocomplete insertion was observed.");
  let prepared = false;
  try {
    const prompt = await waitForReleaseSurfaceInstalledInputElement(webdriver, COMPOSER);
    const baseline = await hashState(webdriver);
    if (baseline.prompt !== "" || baseline.rowPresent !== false) {
      throw new Error("hash-autocomplete fixture requires an empty isolated composer and closed row baseline");
    }
    await postUi(connection, { debugHashItems: "owned", source: "final-surface-misc-hash" });
    prepared = true;
    await setReleaseSurfaceInstalledInputElementValue(webdriver, prompt, "#735");
    const row = await waitForReleaseSurfaceInstalledInputElement(webdriver, HASH_ROW);
    const opened = await hashState(webdriver);
    if (opened.prompt !== "#735" || opened.rowPresent !== true
      || opened.rowTitle !== "Issue #735: Owned autocomplete fixture") {
      throw new Error("hash-autocomplete fixture did not expose the exact owned result");
    }
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, row);
    outcome.invoke = "pass";
    const inserted = await waitForHashState(webdriver, (state) => (
      state.prompt === OWNED_HASH_INSERTION && state.rowPresent === false
    ));
    if (inserted.prompt !== OWNED_HASH_INSERTION) {
      throw new Error("hash-autocomplete selection did not insert the exact bounded markdown reference");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click inserted one exact synthetic issue reference into the empty isolated composer and closed its owned autocomplete row without querying GitHub or sending a prompt.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const errors: string[] = [];
    if (prepared) {
      try {
        const prompt = await findReleaseSurfaceInstalledInputElement(webdriver, COMPOSER);
        if (prompt) await clearReleaseSurfaceInstalledInputElement(webdriver, prompt);
        await postUi(connection, { debugHashItems: "clear", source: "final-surface-misc-hash-cleanup" });
        await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, HASH_ROW);
        const state = await hashState(webdriver);
        if (state.prompt !== "" || state.rowPresent !== false) {
          throw new Error("hash-autocomplete cleanup did not restore the empty closed baseline");
        }
      } catch (error) {
        errors.push(errorText(error));
      }
    } else {
      errors.push("hash-autocomplete fixture was not prepared");
    }
    applyCleanup(outcome, errors);
  }
  return finalize(outcome, "Hash-autocomplete lifecycle did not satisfy every required verdict");
}

async function exerciseMarkdownPreview(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native owned markdown-file preview was observed.");
  let fixture: OwnedMarkdownFixture | null = null;
  let baselineBottomTab: string | null = null;
  try {
    fixture = prepareMarkdownFixture(request);
    const baseline = await apiJson(connection, "GET", "/state/ui");
    baselineBottomTab = typeof baseline.bottomTab === "string" ? baseline.bottomTab : null;
    if (!baselineBottomTab || baseline.preview !== null) {
      throw new Error("markdown preview fixture requires a restorable rail and no existing preview");
    }
    await postUi(connection, {
      bottomTab: "Chat",
      debugRendererFixture: {
        id: "event-projections",
        attachmentPath: fixture.launchAttachmentPath,
        imagePath: fixture.launchImagePath,
      },
      source: "final-surface-misc-markdown-preview",
    });
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, MARKDOWN_PREVIEW_LINK);
    const projected = await observeReleaseSurfaceInstalledInputElement(webdriver, MARKDOWN_PREVIEW_LINK, ["title"]);
    if (!projected.present || !projected.visible || projected.title !== "release-owned-preview.png") {
      throw new Error("markdown link fixture did not expose exactly one owned local preview control");
    }
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElement(webdriver, PREVIEW_DIALOG);
    await waitForPreviewPath(connection, fixture.launchImagePath);
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click opened Preview Center for the exact disposable file projected by the renderer-only markdown fixture; no external URL, clipboard, provider, file picker, or operator file was used.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const errors: string[] = [];
    if (fixture) {
      try {
        await postUi(connection, {
          bottomTab: baselineBottomTab ?? "Chat",
          clearPreview: true,
          debugRendererFixture: "clear",
          openModal: "close",
          source: "final-surface-misc-markdown-preview-cleanup",
        });
        await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, PREVIEW_DIALOG);
        await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, MARKDOWN_PREVIEW_LINK);
        const restored = await apiJson(connection, "GET", "/state/ui");
        if (restored.bottomTab !== baselineBottomTab || restored.preview !== null) {
          throw new Error("markdown preview cleanup did not restore the exact UI baseline");
        }
      } catch (error) {
        errors.push(errorText(error));
      }
      try {
        rmSync(fixture.nodeRoot, { recursive: true });
        if (existsSync(fixture.nodeRoot)) throw new Error("owned markdown fixture root remained");
      } catch (error) {
        errors.push(errorText(error));
      }
    } else {
      errors.push("markdown preview fixture was not prepared");
    }
    applyCleanup(outcome, errors);
  }
  return finalize(outcome, "Markdown preview lifecycle did not satisfy every required verdict");
}

type OwnedMarkdownFixture = {
  nodeRoot: string;
  launchAttachmentPath: string;
  launchImagePath: string;
};

function prepareMarkdownFixture(request: ReleaseSurfaceDriverRequest): OwnedMarkdownFixture {
  const tokenPath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const tokenStat = lstatSync(tokenPath);
  if (tokenStat.isSymbolicLink() || !tokenStat.isFile()
    || basename(tokenPath) !== "shellxagent.token" || basename(dirname(tokenPath)) !== ".shellx") {
    throw new Error("markdown preview fixture requires the installed candidate's regular .shellx token");
  }
  const nodeProfileRoot = dirname(dirname(tokenPath));
  const nodeRoot = resolve(nodeProfileRoot, "ui-misc-markdown-preview");
  const rel = relative(resolve(nodeProfileRoot), nodeRoot);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || existsSync(nodeRoot)) {
    throw new Error("markdown preview fixture root was not a new child of the disposable profile");
  }
  mkdirSync(nodeRoot, { mode: 0o700 });
  writeFileSync(join(nodeRoot, "release-owned-context.txt"), "SHELLX_OWNED_MARKDOWN_CONTEXT\n", { flag: "wx", mode: 0o600 });
  writeFileSync(
    join(nodeRoot, "release-owned-preview.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    { flag: "wx", mode: 0o600 },
  );
  const launchProfileRoot = portableParent(portableParent(request.runtime.debugTokenPath, request.platform), request.platform);
  const launchRoot = portableJoin(launchProfileRoot, "ui-misc-markdown-preview", request.platform);
  return {
    nodeRoot,
    launchAttachmentPath: portableJoin(launchRoot, "release-owned-context.txt", request.platform),
    launchImagePath: portableJoin(launchRoot, "release-owned-preview.png", request.platform),
  };
}

async function waitForPreviewPath(connection: Connection, expectedPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await apiJson(connection, "GET", "/state/ui");
    const preview = state.preview && typeof state.preview === "object" && !Array.isArray(state.preview)
      ? state.preview as Record<string, unknown>
      : null;
    if (preview?.kind === "file" && preview.path === expectedPath) return;
    await delay(50);
  }
  throw new Error("markdown preview did not bind to the exact owned file path");
}

async function prTranscriptState(webdriver: WebDriver) {
  return observeReleaseSurfaceInstalledInputElement(webdriver, PR_TRANSCRIPT, ["pressed", "disabled", "title"]);
}

type HashState = {
  prompt: string | null;
  rowPresent: boolean;
  rowTitle: string | null;
};

async function hashState(webdriver: WebDriver): Promise<HashState> {
  const [prompt, row] = await Promise.all([
    observeReleaseSurfaceInstalledInputElement(webdriver, COMPOSER, ["value"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, HASH_ROW, ["title"]),
  ]);
  return {
    prompt: prompt.present && typeof prompt.value === "string" ? prompt.value : null,
    rowPresent: row.present && row.visible,
    rowTitle: row.present && typeof row.title === "string" ? row.title : null,
  };
}

async function waitForPrTranscriptState(webdriver: WebDriver, pressed: boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await prTranscriptState(webdriver);
    if (state.present && state.visible && state.pressed === pressed) return state;
    await delay(50);
  }
  throw new Error(`PR transcript toggle did not reach pressed=${pressed}`);
}

async function waitForHashState(
  webdriver: WebDriver,
  predicate: (state: HashState) => boolean,
): Promise<HashState> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await hashState(webdriver);
    if (predicate(state)) return state;
    await delay(50);
  }
  throw new Error("miscellaneous UI state did not reach its exact expected transition");
}

function portableParent(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed") return dirname(path);
  const normalized = path.replaceAll("/", "\\").replace(/\\+$/, "");
  const index = normalized.lastIndexOf("\\");
  if (index <= 2) throw new Error("markdown preview token path is outside a disposable Windows profile");
  return normalized.slice(0, index);
}

function portableJoin(base: string, child: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  return platform === "windows-installed" ? `${base.replace(/[\\/]+$/, "")}\\${child}` : join(base, child);
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

function applyCleanup(outcome: ReleaseSurfaceDriverOutcome, errors: string[]): void {
  if (errors.length === 0) outcome.cleanup = "pass";
  else {
    const detail = errors.join("; ");
    outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
  }
}

function finalize(outcome: ReleaseSurfaceDriverOutcome, fallback: string): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = fallback;
  }
  return outcome;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
