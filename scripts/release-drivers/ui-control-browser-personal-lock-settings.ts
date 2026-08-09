import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  closeReleaseSurfaceInstalledInputWindow,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue,
  switchReleaseSurfaceInstalledInputWindow,
  switchReleaseSurfaceInstalledInputWindowByTitle,
  waitForReleaseSurfaceInstalledInputElement,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { cleanupOwnedBrowserLifecycle } from "../shellx-browser-test-cleanup";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;
type AuthMode = "deviceAuthPreferred" | "pinOnly";
type PreferenceKey = "blurLockedTabs" | "pauseDelegatedTabsWhenLocked" | "lockOnSleep" | "lockOnMinimize";
type Kind =
  | "openSettings"
  | "enableAction"
  | "enabled"
  | "timeout"
  | "auth"
  | "pinDraft"
  | "setPin"
  | "lockNow"
  | "unlockNow"
  | "pinLifecycle"
  | "noticeUnlock"
  | "overlayUnlock"
  | "overlayPin"
  | PreferenceKey;
type LockState = {
  enabled: boolean;
  locked: boolean;
  timeoutMinutes: number;
  authMode: AuthMode;
  pinConfigured: boolean;
  blurLockedTabs: boolean;
  pauseDelegatedTabsWhenLocked: boolean;
  lockOnSleep: boolean;
  lockOnMinimize: boolean;
};

const OWNER = "[data-debug-id='shellx-browser-options']";
const PANEL = "#shellx-browser-options-sidecar[aria-labelledby='shellx-browser-options']";
const TIMEOUT = "[data-debug-id='shellx-browser-personal-lock-timeout']";
const AUTH = "[data-debug-id='shellx-browser-personal-lock-auth-mode']";
const PIN = "[data-debug-id='shellx-browser-personal-lock-pin']";
const SET_PIN = "[data-debug-id='shellx-browser-personal-lock-set-pin']";
const ENABLE_ACTION = "[data-debug-id='shellx-browser-personal-enable-now']";
const ENABLED = "[data-debug-id='shellx-browser-personal-lock-enabled']";
const OPEN_SETTINGS = "[data-debug-id='shellx-browser-personal-lock-toggle']";
const NEW_TAB = "[data-debug-id='shellx-browser-new-tab']";
const LOCK_NOW = "[data-debug-id='shellx-browser-personal-lock-now']";
const UNLOCK_NOW = "[data-debug-id='shellx-browser-personal-unlock-now']";
const NOTICE = "[data-debug-id='shellx-browser-personal-lock-notice']";
const NOTICE_UNLOCK = "[data-debug-id='shellx-browser-personal-lock-notice-unlock']";
const OVERLAY = "[data-debug-id='shellx-browser-personal-lock-overlay']";
const OVERLAY_PIN = "[data-debug-id='shellx-browser-personal-lock-overlay-pin']";
const OVERLAY_UNLOCK = "[data-debug-id='shellx-browser-personal-lock-overlay-unlock']";
const TEST_PIN = "539174";
const DEFAULT_LOCK_STATE: LockState = {
  enabled: false,
  locked: false,
  timeoutMinutes: 30,
  authMode: "deviceAuthPreferred",
  pinConfigured: false,
  blurLockedTabs: true,
  pauseDelegatedTabsWhenLocked: true,
  lockOnSleep: true,
  lockOnMinimize: false,
};
const PREFERENCE_CONTROLS: Record<PreferenceKey, { selector: string; label: string }> = {
  blurLockedTabs: {
    selector: "[data-debug-id='shellx-browser-personal-lock-blur']",
    label: "cover locked personal tabs",
  },
  pauseDelegatedTabsWhenLocked: {
    selector: "[data-debug-id='shellx-browser-personal-lock-pause-delegated']",
    label: "pause delegated tabs while locked",
  },
  lockOnSleep: {
    selector: "[data-debug-id='shellx-browser-personal-lock-sleep']",
    label: "lock after system sleep",
  },
  lockOnMinimize: {
    selector: "[data-debug-id='shellx-browser-personal-lock-minimize']",
    label: "lock when minimized",
  },
};
const SURFACES: Record<string, Kind> = {
  "src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-personal-lock-toggle\"]": "openSettings",
  "src/browser/components/BrowserMenus.tsx::is([data-debug-id=\"shellx-browser-personal-enable-now\"],[data-debug-id=\"shellx-browser-personal-lock-now\"],[data-debug-id=\"shellx-browser-personal-unlock-now\"])": "enableAction",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-enabled\"]": "enabled",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-timeout\"]": "timeout",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-auth-mode\"]": "auth",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-pin\"]": "pinDraft",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-set-pin\"]": "setPin",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-blur\"]": "blurLockedTabs",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-pause-delegated\"]": "pauseDelegatedTabsWhenLocked",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-sleep\"]": "lockOnSleep",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-minimize\"]": "lockOnMinimize",
  "src/components/ShellxBrowserApp.tsx:[data-debug-id=\"shellx-browser-personal-lock-notice-unlock\"]": "noticeUnlock",
  "src/components/ShellxBrowserApp.tsx:[data-debug-id=\"shellx-browser-personal-lock-overlay-pin\"]": "overlayPin",
  "src/components/ShellxBrowserApp.tsx:[data-debug-id=\"shellx-browser-personal-lock-overlay-unlock\"]": "overlayUnlock",
  "shellx-browser-personal-lock-now": "lockNow",
  "shellx-browser-personal-unlock-now": "unlockNow",
  "shellx-browser-personal-lock-pin": "pinLifecycle",
  "shellx-browser-personal-lock-set-pin": "setPin",
  "shellx-browser-personal-lock-notice": "noticeUnlock",
  "shellx-browser-personal-lock-notice-unlock": "noticeUnlock",
  "shellx-browser-personal-lock-overlay": "overlayUnlock",
  "shellx-browser-personal-lock-overlay-pin": "overlayPin",
  "shellx-browser-personal-lock-overlay-unlock": "overlayUnlock",
};
export const BROWSER_PERSONAL_LOCK_FIXTURES = ["ui:browser-personal-lock-owned-settings"] as const;
export const BROWSER_PERSONAL_LOCK_CLEANUPS = ["ui:restore-browser-personal-lock-settings-abort-task-and-window"] as const;
export const BROWSER_PERSONAL_LOCK_ORACLES = [
  "ui:value-state-transition",
  "ui:activation:browser-personal-lock-settings-opened",
  "ui:activation:browser-personal-lock-enabled",
  "ui:activation:browser-personal-lock-unlocked",
  "ui:activation:browser-personal-lock-pin-lifecycle",
] as const;

export function supportsBrowserPersonalLockControl(assignment: Assignment): boolean {
  return assignment.surface.name in SURFACES;
}

export async function exerciseBrowserPersonalLockControl(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const kind = SURFACES[assignment.surface.name];
  const outcome = emptyOutcome(assignment);
  const cleanupErrors: string[] = [];
  let baseline: LockState | null = null;
  let taskId: string | null = null;
  let personalTabId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!kind) throw new Error(`Browser Personal Lock driver does not support ${assignment.surface.name}`);
    baseline = await readLockState(connection);
    if (baseline.enabled || baseline.locked || baseline.pinConfigured) {
      throw new Error("Browser Personal Lock fixture requires an isolated disabled, unlocked, PIN-free baseline");
    }
    if (usesPersistedPin(kind) && !sameSemanticLockState(baseline, DEFAULT_LOCK_STATE)) {
      throw new Error("PIN lifecycle requires the disposable isolated Personal Browser Lock default baseline");
    }
    const started = await apiJson(connection, "POST", "/browser/task/start", {
      goal: `Final surface Browser Personal Lock ${kind} proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(started.taskId, "Browser Personal Lock taskId");
    if (needsPersonalTab(kind)) {
      const opened = await apiJson(connection, "POST", "/browser/tabs/open", {
        profileId: "personal",
        url: "about:blank",
      });
      personalTabId = requiredString(
        record(opened.tab, "Browser Personal Lock personal tab").browserTabId,
        "Browser Personal Lock personal tab id",
      );
      await apiJson(connection, "POST", "/browser/tabs/focus", { browserTabId: personalTabId });
    }
    const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;

    if (kind === "noticeUnlock" || kind === "overlayUnlock") {
      await prepareLockedPinState(connection, webdriver, true);
      if (kind === "noticeUnlock") {
        await clickReleaseSurfaceInstalledInputElement(
          webdriver,
          await waitForReleaseSurfaceInstalledInputElement(webdriver, NEW_TAB),
        );
        await waitForReleaseSurfaceInstalledInputElement(webdriver, NOTICE);
        const target = assignment.surface.name === "shellx-browser-personal-lock-notice"
          ? NOTICE
          : NOTICE_UNLOCK;
        await waitForReleaseSurfaceInstalledInputElement(webdriver, target);
        outcome.present = "pass";
        await enterExactPin(webdriver, OVERLAY_PIN);
        await clickReleaseSurfaceInstalledInputElement(
          webdriver,
          await waitForReleaseSurfaceInstalledInputElement(webdriver, NOTICE_UNLOCK),
        );
        outcome.invoke = "pass";
        await waitForLockState(connection, (state) => state.enabled && !state.locked && state.pinConfigured);
        if (await findReleaseSurfaceInstalledInputElement(webdriver, NOTICE)) {
          throw new Error("Personal Browser Lock notice remained after native unlock");
        }
        outcome.effect = "pass";
        outcome.observedEffect = "Native WebDriver installed input entered the synthetic PIN and unlocked the isolated Personal Browser Lock from its real blocked-new-tab notice; the verifier was then removed by isolated cleanup without exposing the PIN.";
      } else {
        await waitForReleaseSurfaceInstalledInputElement(webdriver, OVERLAY);
        const target = assignment.surface.name === "shellx-browser-personal-lock-overlay"
          ? OVERLAY
          : OVERLAY_UNLOCK;
        await waitForReleaseSurfaceInstalledInputElement(webdriver, target);
        outcome.present = "pass";
        await enterExactPin(webdriver, OVERLAY_PIN);
        await clickReleaseSurfaceInstalledInputElement(
          webdriver,
          await waitForReleaseSurfaceInstalledInputElement(webdriver, OVERLAY_UNLOCK),
        );
        outcome.invoke = "pass";
        await waitForLockState(connection, (state) => state.enabled && !state.locked && state.pinConfigured);
        if (await findReleaseSurfaceInstalledInputElement(webdriver, OVERLAY)) {
          throw new Error("Personal Browser Lock overlay remained after native unlock");
        }
        outcome.effect = "pass";
        outcome.observedEffect = "Native WebDriver installed input entered the synthetic PIN and unlocked the real isolated personal-profile overlay; the verifier was then removed by isolated cleanup without exposing the PIN.";
      }
    } else if (kind === "overlayPin") {
      await prepareLockedPinState(connection, webdriver, true);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, OVERLAY);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, OVERLAY_PIN);
      outcome.present = "pass";
      await enterExactPin(webdriver, OVERLAY_PIN);
      outcome.invoke = "pass";
      await clickReleaseSurfaceInstalledInputElement(
        webdriver,
        await waitForReleaseSurfaceInstalledInputElement(webdriver, OVERLAY_UNLOCK),
      );
      await waitForLockState(connection, (state) => state.enabled && !state.locked && state.pinConfigured);
      outcome.effect = "pass";
      outcome.observedEffect = "Native WebDriver installed input exercised the real personal-overlay PIN field and completed the PIN-backed unlock before isolated verifier removal; no PIN value entered any API response or retained evidence.";
    } else if (kind === "setPin" || kind === "pinLifecycle") {
      await openOptions(webdriver);
      await ensurePinMode(connection, webdriver);
      const target = kind === "pinLifecycle" ? PIN : SET_PIN;
      await waitForReleaseSurfaceInstalledInputElement(webdriver, target);
      outcome.present = "pass";
      await enterExactPin(webdriver, PIN);
      if (kind === "pinLifecycle") outcome.invoke = "pass";
      await clickReleaseSurfaceInstalledInputElement(
        webdriver,
        await waitForReleaseSurfaceInstalledInputElement(webdriver, SET_PIN),
      );
      if (kind === "setPin") outcome.invoke = "pass";
      await waitForLockState(connection, (state) => state.authMode === "pinOnly" && state.pinConfigured && !state.locked);
      if (await pinDraftReady(webdriver, PIN)) {
        throw new Error("Personal Browser Lock PIN draft remained after verifier creation");
      }
      outcome.effect = "pass";
      outcome.observedEffect = "Native WebDriver installed input created a verifier from the synthetic Personal Browser Lock PIN, observed only the safe pinConfigured state, and removed the verifier through isolated cleanup without retaining or exposing the PIN.";
    } else if (kind === "lockNow") {
      await openOptions(webdriver);
      await configureSyntheticPin(connection, webdriver);
      await setLockEnabled(connection, webdriver, true);
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, LOCK_NOW);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForLockState(connection, (state) => state.enabled && state.locked && state.pinConfigured);
      outcome.effect = "pass";
      outcome.observedEffect = "The conditional Lock now marker was backed by a real native PIN configuration and lock transition in the isolated Personal Browser profile before verifier removal.";
    } else if (kind === "unlockNow") {
      await prepareLockedPinState(connection, webdriver, false);
      await enterExactPin(webdriver, PIN);
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, UNLOCK_NOW);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForLockState(connection, (state) => state.enabled && !state.locked && state.pinConfigured);
      outcome.effect = "pass";
      outcome.observedEffect = "The conditional Unlock marker was backed by a real native PIN-backed unlock transition in the isolated Personal Browser profile before verifier removal.";
    } else if (kind === "openSettings") {
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, OPEN_SETTINGS);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElement(webdriver, PANEL);
      outcome.effect = "pass";
      outcome.observedEffect = "Native WebDriver installed input opened Personal Browser Lock settings from its disabled isolated header state.";
    } else if (kind === "enableAction" || kind === "enabled") {
      await openOptions(webdriver);
      const selector = kind === "enableAction" ? ENABLE_ACTION : ENABLED;
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, selector);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForLockState(connection, (state) => state.enabled && !state.locked && !state.pinConfigured);
      outcome.effect = "pass";
      outcome.observedEffect = kind === "enableAction"
        ? "Native WebDriver installed input enabled Personal Browser Lock through its status action in an isolated PIN-free profile before exact semantic restoration."
        : "Native WebDriver installed input enabled Personal Browser Lock through its checkbox in an isolated PIN-free profile before exact semantic restoration.";
    } else if (kind === "timeout") {
      await openOptions(webdriver);
      const next = baseline.timeoutMinutes === 15 ? 30 : 15;
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, TIMEOUT);
      outcome.present = "pass";
      await setReleaseSurfaceInstalledInputElementValue(webdriver, control, `${next} minutes`);
      outcome.invoke = "pass";
      await waitForLockState(connection, (state) => state.timeoutMinutes === next);
      outcome.effect = "pass";
      outcome.observedEffect = `Native WebDriver installed input changed the isolated Personal Browser Lock timeout to ${next} minutes before exact restoration.`;
    } else if (kind === "auth") {
      await openOptions(webdriver);
      const next: AuthMode = baseline.authMode === "pinOnly" ? "deviceAuthPreferred" : "pinOnly";
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, AUTH);
      outcome.present = "pass";
      await setReleaseSurfaceInstalledInputElementValue(webdriver, control, authLabel(next));
      outcome.invoke = "pass";
      await waitForLockState(connection, (state) => state.authMode === next);
      outcome.effect = "pass";
      outcome.observedEffect = `Native WebDriver installed input changed the isolated Personal Browser Lock unlock method to ${next} before exact restoration.`;
    } else if (kind === "pinDraft") {
      await openOptions(webdriver);
      if (baseline.authMode !== "pinOnly") {
        await setReleaseSurfaceInstalledInputElementValue(
          webdriver,
          await waitForReleaseSurfaceInstalledInputElement(webdriver, AUTH),
          authLabel("pinOnly"),
        );
        await waitForLockState(connection, (state) => state.authMode === "pinOnly");
      }
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, PIN);
      outcome.present = "pass";
      if (await pinDraftReady(webdriver, PIN)) await clearReleaseSurfaceInstalledInputElement(webdriver, control);
      await setReleaseSurfaceInstalledInputElementValue(webdriver, control, TEST_PIN);
      outcome.invoke = "pass";
      await waitForPinDraftReady(webdriver, PIN, true);
      const state = await readLockState(connection);
      if (state.pinConfigured) throw new Error("editing the Personal Browser Lock PIN draft unexpectedly persisted a PIN");
      outcome.effect = "pass";
      outcome.observedEffect = "Native WebDriver installed input changed only the local synthetic Personal Browser Lock PIN draft; no PIN verifier was persisted.";
    } else {
      await openOptions(webdriver);
      await setLockEnabled(connection, webdriver, true);
      const preference = PREFERENCE_CONTROLS[kind];
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, preference.selector);
      const target = !baseline[kind];
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForLockState(connection, (state) => state.enabled && state[kind] === target);
      outcome.effect = "pass";
      outcome.observedEffect = `Native WebDriver installed input changed ${preference.label} to ${target} in an isolated PIN-free profile before exact semantic restoration.`;
    }
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (browserWindowOpen && baseline) {
      if (kind && usesPersistedPin(kind)) {
        await cleanupAttempt(cleanupErrors, async () => {
          await clearVisiblePinDraft(webdriver, OVERLAY_PIN);
          await clearVisiblePinDraft(webdriver, PIN);
        });
        await cleanupAttempt(cleanupErrors, async () => {
          await apiJson(connection, "POST", "/state/ui", {
            releaseTestResetBrowserPersonalLock: "owned-pin-lifecycle",
          });
          await waitForLockState(connection, (state) => sameSemanticLockState(state, baseline!));
        });
      } else {
        await cleanupAttempt(cleanupErrors, async () => {
          await clearVisiblePinDraft(webdriver, PIN);
          let current = await readLockState(connection);
          for (const [preferenceKey, preference] of Object.entries(PREFERENCE_CONTROLS) as Array<[PreferenceKey, { selector: string; label: string }]>) {
            if (current[preferenceKey] === baseline![preferenceKey]) continue;
            if (!current.enabled) {
              await setLockEnabled(connection, webdriver, true);
            }
            await clickReleaseSurfaceInstalledInputElement(
              webdriver,
              await waitForReleaseSurfaceInstalledInputElement(webdriver, preference.selector),
            );
            await waitForLockState(connection, (state) => state[preferenceKey] === baseline![preferenceKey]);
            current = await readLockState(connection);
          }
          if (current.timeoutMinutes !== baseline!.timeoutMinutes) {
            await setReleaseSurfaceInstalledInputElementValue(
              webdriver,
              await waitForReleaseSurfaceInstalledInputElement(webdriver, TIMEOUT),
              `${baseline!.timeoutMinutes} minutes`,
            );
            await waitForLockState(connection, (state) => state.timeoutMinutes === baseline!.timeoutMinutes);
          }
          current = await readLockState(connection);
          if (current.authMode !== baseline!.authMode) {
            await setReleaseSurfaceInstalledInputElementValue(
              webdriver,
              await waitForReleaseSurfaceInstalledInputElement(webdriver, AUTH),
              authLabel(baseline!.authMode),
            );
            await waitForLockState(connection, (state) => state.authMode === baseline!.authMode);
          }
          current = await readLockState(connection);
          if (current.enabled !== baseline!.enabled) {
            await setLockEnabled(connection, webdriver, baseline!.enabled);
          }
          const restored = await readLockState(connection);
          if (!sameSemanticLockState(restored, baseline!)) {
            throw new Error("Personal Browser Lock semantic settings did not restore exactly");
          }
          await closeOptions(webdriver);
        });
      }
    }
    if (taskId || personalTabId) {
      await cleanupAttempt(cleanupErrors, async () => {
        const result = await cleanupOwnedBrowserLifecycle(
          (method, path, body) => apiJson(connection, method, path, body),
          {
            taskIds: taskId ? [taskId] : [],
            tabIds: personalTabId ? [personalTabId] : [],
            label: "final surface Browser Personal Lock",
          },
        );
        if (result.errors.length > 0) throw new Error(result.errors.join("; "));
      });
    }
    if (browserWindowOpen && originalWindow) {
      await cleanupAttempt(cleanupErrors, async () => {
        await closeReleaseSurfaceInstalledInputWindow(webdriver);
        await switchReleaseSurfaceInstalledInputWindow(webdriver, originalWindow!);
      });
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}cleanup: ${cleanupErrors.join(" | ")}`;
  }
  return finalize(outcome);
}

async function openOptions(webdriver: WebDriver): Promise<void> {
  if (await findReleaseSurfaceInstalledInputElement(webdriver, PANEL)) return;
  await clickReleaseSurfaceInstalledInputElement(webdriver, await waitForReleaseSurfaceInstalledInputElement(webdriver, OWNER));
  await waitForReleaseSurfaceInstalledInputElement(webdriver, PANEL);
}

async function closeOptions(webdriver: WebDriver): Promise<void> {
  if (!await findReleaseSurfaceInstalledInputElement(webdriver, PANEL)) return;
  await clickReleaseSurfaceInstalledInputElement(webdriver, await waitForReleaseSurfaceInstalledInputElement(webdriver, OWNER));
}

async function ensurePinMode(connection: Connection, webdriver: WebDriver): Promise<void> {
  const current = await readLockState(connection);
  if (current.authMode === "pinOnly") return;
  await setReleaseSurfaceInstalledInputElementValue(
    webdriver,
    await waitForReleaseSurfaceInstalledInputElement(webdriver, AUTH),
    authLabel("pinOnly"),
  );
  await waitForLockState(connection, (state) => state.authMode === "pinOnly");
}

async function configureSyntheticPin(connection: Connection, webdriver: WebDriver): Promise<void> {
  await openOptions(webdriver);
  await ensurePinMode(connection, webdriver);
  await enterExactPin(webdriver, PIN);
  await clickReleaseSurfaceInstalledInputElement(
    webdriver,
    await waitForReleaseSurfaceInstalledInputElement(webdriver, SET_PIN),
  );
  await waitForLockState(connection, (state) => state.authMode === "pinOnly" && state.pinConfigured && !state.locked);
  if (await pinDraftReady(webdriver, PIN)) {
    throw new Error("Personal Browser Lock PIN draft remained after verifier creation");
  }
}

async function prepareLockedPinState(
  connection: Connection,
  webdriver: WebDriver,
  closeAfterLock: boolean,
): Promise<void> {
  await configureSyntheticPin(connection, webdriver);
  await setLockEnabled(connection, webdriver, true);
  await clickReleaseSurfaceInstalledInputElement(
    webdriver,
    await waitForReleaseSurfaceInstalledInputElement(webdriver, LOCK_NOW),
  );
  await waitForLockState(connection, (state) => state.enabled && state.locked && state.pinConfigured);
  if (closeAfterLock) await closeOptions(webdriver);
}

async function setLockEnabled(connection: Connection, webdriver: WebDriver, enabled: boolean): Promise<void> {
  const current = await readLockState(connection);
  if (current.enabled === enabled) return;
  await openOptions(webdriver);
  await clickReleaseSurfaceInstalledInputElement(
    webdriver,
    await waitForReleaseSurfaceInstalledInputElement(webdriver, ENABLED),
  );
  await waitForLockState(connection, (state) => state.enabled === enabled && (!enabled ? !state.locked : true));
}

async function enterExactPin(webdriver: WebDriver, selector: string): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, selector);
  if (await pinDraftReady(webdriver, selector)) {
    await clearReleaseSurfaceInstalledInputElement(webdriver, control);
    await waitForPinDraftReady(webdriver, selector, false);
  }
  await setReleaseSurfaceInstalledInputElementValue(webdriver, control, TEST_PIN);
  await waitForPinDraftReady(webdriver, selector, true);
}

async function clearVisiblePinDraft(webdriver: WebDriver, selector: string): Promise<void> {
  const control = await findReleaseSurfaceInstalledInputElement(webdriver, selector);
  if (!control) return;
  if (await pinDraftReady(webdriver, selector)) {
    await clearReleaseSurfaceInstalledInputElement(webdriver, control);
  }
  await waitForPinDraftReady(webdriver, selector, false);
}

function pinSubmitSelector(selector: string): string {
  if (selector === PIN) return SET_PIN;
  if (selector === OVERLAY_PIN) return OVERLAY_UNLOCK;
  throw new Error(`Personal Browser Lock PIN selector has no value-blind submit receipt: ${selector}`);
}

async function pinDraftReady(webdriver: WebDriver, selector: string): Promise<boolean> {
  const submit = pinSubmitSelector(selector);
  const state = await observeReleaseSurfaceInstalledInputElement(webdriver, submit, ["disabled"]);
  if (!state.present || !state.visible || typeof state.disabled !== "boolean") {
    throw new Error("Personal Browser Lock PIN submit control omitted its bounded disabled state");
  }
  return !state.disabled;
}

async function waitForPinDraftReady(webdriver: WebDriver, selector: string, expected: boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await pinDraftReady(webdriver, selector) === expected) return;
    await delay(50);
  }
  throw new Error(`Personal Browser Lock PIN draft did not reach value-blind ready=${String(expected)}`);
}

function usesPersistedPin(kind: Kind): boolean {
  return kind === "setPin"
    || kind === "lockNow"
    || kind === "unlockNow"
    || kind === "pinLifecycle"
    || kind === "noticeUnlock"
    || kind === "overlayUnlock"
    || kind === "overlayPin";
}

function needsPersonalTab(kind: Kind): boolean {
  return kind === "noticeUnlock" || kind === "overlayUnlock" || kind === "overlayPin";
}

async function readLockState(connection: Connection): Promise<LockState> {
  const state = await apiJson(connection, "GET", "/browser/state");
  const lock = record(state.personalLock, "Browser personalLock");
  const authMode = lock.authMode;
  if (authMode !== "deviceAuthPreferred" && authMode !== "pinOnly") throw new Error("Browser personalLock.authMode is invalid");
  return {
    enabled: lock.enabled === true,
    locked: lock.locked === true,
    timeoutMinutes: requiredNumber(lock.timeoutMinutes, "Browser personalLock.timeoutMinutes"),
    authMode,
    pinConfigured: lock.pinConfigured === true,
    blurLockedTabs: lock.blurLockedTabs !== false,
    pauseDelegatedTabsWhenLocked: lock.pauseDelegatedTabsWhenLocked !== false,
    lockOnSleep: lock.lockOnSleep !== false,
    lockOnMinimize: lock.lockOnMinimize === true,
  };
}

function sameSemanticLockState(left: LockState, right: LockState): boolean {
  return left.enabled === right.enabled
    && left.locked === right.locked
    && left.timeoutMinutes === right.timeoutMinutes
    && left.authMode === right.authMode
    && left.pinConfigured === right.pinConfigured
    && left.blurLockedTabs === right.blurLockedTabs
    && left.pauseDelegatedTabsWhenLocked === right.pauseDelegatedTabsWhenLocked
    && left.lockOnSleep === right.lockOnSleep
    && left.lockOnMinimize === right.lockOnMinimize;
}

async function waitForLockState(connection: Connection, predicate: (state: LockState) => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate(await readLockState(connection))) return;
    await delay(50);
  }
  throw new Error("Browser Personal Lock settings did not reach the required state");
}

function authLabel(mode: AuthMode): string {
  return mode === "pinOnly" ? "Session PIN" : "Device auth preferred";
}

async function apiJson(connection: Connection, method: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${connection.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} returned HTTP ${response.status}: ${text.slice(0, 240)}`);
  return record(JSON.parse(text), `${method} ${path}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a number`);
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
    observedEffect: "No isolated Browser Personal Lock settings transition was observed.",
  };
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if (outcome.present === "pass" && outcome.invoke === "pass" && outcome.effect === "pass" && outcome.cleanup === "pass") return outcome;
  outcome.observedEffect = "Requested effect was not fully verified; private failure details were not retained.";
  return outcome;
}

async function cleanupAttempt(errors: string[], action: () => Promise<void>): Promise<void> {
  try { await action(); } catch (error) { errors.push(errorText(error)); }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
