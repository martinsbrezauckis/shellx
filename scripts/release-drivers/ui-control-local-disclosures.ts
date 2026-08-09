import {
  clickReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type Action =
  | { kind: "open"; control: string; dialog: string; close: string; label: string; effectSelector?: string }
  | { kind: "close"; openModal: string; control: string; dialog: string; label: string; preview?: Record<string, unknown>; clearPreview?: boolean }
  | { kind: "toggle"; control: string; panel: string; label: string }
  | { kind: "hint"; control: string; panel: string; label: string };

const SETTINGS = "[role='dialog'][aria-label='Settings']";
const PLUGINS = "[role='dialog'][aria-label='Plugins']";
const ASSETS = "[role='dialog'][aria-label='Attachment and media board']";
const CONNECTOR_INBOX = "[role='dialog'][aria-label='Connector inbox']";
const ACTIVITY = "[role='dialog'][aria-label='Activity Browser']";
const PREVIEW_CENTER = "[role='dialog'][aria-label='Preview Center']";
const VAULT_WORKSPACE = "[data-debug-id='vault-workspace-modal']";

const actions: Record<string, Action> = {
  "src/components/Header.tsx:[aria-label=\"About shellX — version and source\"]": {
    kind: "open",
    control: "[aria-label='About shellX — version and source']",
    dialog: SETTINGS,
    close: `${SETTINGS} [aria-label='Close settings']`,
    label: "Settings About",
    effectSelector: "#settings-tab-panel[aria-labelledby='settings-tab-about']",
  },
  "src/components/Header.tsx:[aria-label=\"Open plugins\"]": {
    kind: "open",
    control: "[aria-label='Open plugins']",
    dialog: PLUGINS,
    close: `${PLUGINS} [aria-label='Close']`,
    label: "Plugins",
  },
  "src/components/Header.tsx:[aria-label=\"Open settings\"]": {
    kind: "open",
    control: "[aria-label='Open settings']",
    dialog: SETTINGS,
    close: `${SETTINGS} [aria-label='Close settings']`,
    label: "Settings",
  },
  "src/components/Header.tsx:[aria-label=\"Open connector inbox\"]": {
    kind: "open",
    control: "[aria-label='Open connector inbox']",
    dialog: CONNECTOR_INBOX,
    close: `${CONNECTOR_INBOX} [aria-label='Close connector inbox']`,
    label: "Connector Inbox",
  },
  "src/components/Settings.tsx:[aria-label=\"Close settings\"]": {
    kind: "close",
    openModal: "settings",
    control: `${SETTINGS} [aria-label='Close settings']`,
    dialog: SETTINGS,
    label: "Settings",
  },
  "src/components/PluginsModal.tsx:[aria-label=\"Close\"]": {
    kind: "close",
    openModal: "plugins",
    control: `${PLUGINS} [aria-label='Close']`,
    dialog: PLUGINS,
    label: "Plugins",
  },
  "src/components/AttachmentMediaBoard.tsx:[aria-label=\"Close\"]": {
    kind: "close",
    openModal: "assets",
    control: `${ASSETS} [aria-label='Close']`,
    dialog: ASSETS,
    label: "Attachment and Media Board",
  },
  "src/components/ConnectorInboxModal.tsx:[aria-label=\"Close connector inbox\"]": {
    kind: "close",
    openModal: "connectorInbox",
    control: `${CONNECTOR_INBOX} [aria-label='Close connector inbox']`,
    dialog: CONNECTOR_INBOX,
    label: "Connector Inbox",
  },
  "src/components/PreviewCenter.tsx:[aria-label=\"Close\"]": {
    kind: "close",
    openModal: "preview",
    control: `${PREVIEW_CENTER} [aria-label='Close']`,
    dialog: PREVIEW_CENTER,
    label: "Preview Center",
  },
  "src/components/FilePreviewModal.tsx:[title=\"Close (Esc)\"]": {
    kind: "close",
    openModal: "preview",
    control: `${PREVIEW_CENTER} [title='Close (Esc)']`,
    dialog: PREVIEW_CENTER,
    label: "embedded File Preview",
    preview: {
      kind: "file",
      path: "/tmp/shellx-final-synthetic-preview.fixture",
      tabId: "fixture-tab",
      sessionCwd: "/tmp",
    },
    clearPreview: true,
  },
  "src/components/VaultPanel.tsx:[aria-label=\"Close\"]": {
    kind: "close",
    openModal: "vault",
    control: `${VAULT_WORKSPACE} [aria-label='Close']`,
    dialog: VAULT_WORKSPACE,
    label: "Vault workspace",
  },
  "src/components/BottomPanel.tsx:[data-debug-id=\"bottom-action-assets\"]": {
    kind: "open",
    control: "[data-debug-id='bottom-action-assets']",
    dialog: ASSETS,
    close: `${ASSETS} [aria-label='Close']`,
    label: "Attachment and Media Board",
  },
  "src/components/BottomPanel.tsx:[data-debug-id=\"bottom-action-trace\"]": {
    kind: "open",
    control: "[data-debug-id='bottom-action-trace']",
    dialog: ACTIVITY,
    close: `${ACTIVITY} [aria-label='Close (Esc)']`,
    label: "Activity Browser",
  },
  "src/components/ActivityBrowserModal.tsx:[aria-label=\"Close (Esc)\"]": {
    kind: "close",
    openModal: "activity",
    control: `${ACTIVITY} [aria-label='Close (Esc)']`,
    dialog: ACTIVITY,
    label: "Activity Browser",
  },
  "src/components/BottomPanel.tsx:[data-debug-id=\"composer-connection\"]": {
    kind: "toggle",
    control: "[data-debug-id='composer-connection']",
    panel: "[role='dialog'][aria-label='Saved connections']",
    label: "Saved connections",
  },
  "src/components/BottomPanel.tsx:[data-debug-id=\"composer-agent\"]": {
    kind: "toggle",
    control: "[data-debug-id='composer-agent']",
    panel: "[data-agent-picker-root][role='menu'][aria-label='Agent']",
    label: "Agent",
  },
  "src/components/BottomPanel.tsx:[data-debug-id=\"composer-branch\"]": {
    kind: "toggle",
    control: "[data-debug-id='composer-branch']",
    panel: ".branch-picker[role='listbox']",
    label: "Branch",
  },
  "src/components/BottomPanel.tsx:[aria-label=\"Keyboard shortcuts\"]": {
    kind: "hint",
    control: "[aria-label='Keyboard shortcuts']",
    panel: "[role='tooltip'].hint-popover-portal",
    label: "Keyboard shortcuts",
  },
};

export const LOCAL_DISCLOSURE_SURFACE_NAMES = new Set(Object.keys(actions));
export const LOCAL_DISCLOSURE_FIXTURES = [
  "ui:activity-browser-closed",
  "ui:activity-browser-open",
  "ui:composer-picker-closed",
  "ui:header-dialog-closed",
  "ui:header-dialog-open",
  "ui:keyboard-hint-closed",
  "ui:owned-modal-closed",
  "ui:owned-modal-open",
] as const;
export const LOCAL_DISCLOSURE_CLEANUPS = [
  "ui:close-activity-browser",
  "ui:close-composer-picker",
  "ui:close-header-dialog",
  "ui:close-keyboard-hint",
  "ui:close-owned-modal",
] as const;
export const LOCAL_DISCLOSURE_ORACLES = [
  "ui:activation:about-settings-state",
  "ui:activation:activity-browser-closed",
  "ui:activation:activity-browser-owner-state",
  "ui:activation:composer-picker-state-transition",
  "ui:activation:keyboard-hint-state-transition",
  "ui:activation:owned-modal-closed",
  "ui:activation:owned-modal-opened",
  "ui:activation:plugins-dialog-closed",
  "ui:activation:plugins-dialog-opened",
  "ui:activation:settings-dialog-closed",
  "ui:activation:settings-dialog-opened",
] as const;

export function supportsLocalDisclosureControl(assignment: Assignment): boolean {
  return LOCAL_DISCLOSURE_SURFACE_NAMES.has(assignment.surface.name);
}

export async function exerciseLocalDisclosureControl(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = actions[assignment.surface.name];
  if (!action) throw new Error(`local-disclosure driver does not support ${assignment.surface.name}`);
  if (action.kind === "open") return exerciseOpen(connection, installedInput, assignment, action);
  if (action.kind === "close") return exerciseClose(connection, installedInput, assignment, action);
  if (action.kind === "toggle") return exerciseToggle(installedInput, assignment, action);
  return exerciseHint(installedInput, assignment, action);
}

async function exerciseOpen(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
  action: Extract<Action, { kind: "open" }>,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, `No native ${action.label} open effect was observed.`);
  let opened = false;
  try {
    await postUi(connection, { openModal: "close", source: "final-surface-local-disclosure-baseline" });
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, action.dialog);
    const control = await waitForReleaseSurfaceInstalledInputElement(input, action.control);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElement(input, action.dialog);
    if (action.effectSelector) await waitForReleaseSurfaceInstalledInputElement(input, action.effectSelector);
    opened = true;
    outcome.effect = "pass";
    outcome.observedEffect = `A bounded native click opened the exactly owned ${action.label} surface.`;
  } catch (error) {
    outcome.error = message(error);
  } finally {
    try {
      if (opened) {
        const close = await waitForReleaseSurfaceInstalledInputElement(input, action.close);
        await clickReleaseSurfaceInstalledInputElement(input, close);
      }
      await postUi(connection, { openModal: "close", source: "final-surface-local-disclosure-cleanup" });
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, action.dialog);
      outcome.cleanup = "pass";
    } catch (error) {
      outcome.error = appendCleanup(outcome.error, message(error));
    }
  }
  return finalize(outcome);
}

async function exerciseClose(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
  action: Extract<Action, { kind: "close" }>,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, `No native ${action.label} close effect was observed.`);
  try {
    await postUi(connection, {
      openModal: action.openModal,
      ...(action.preview ? { preview: action.preview } : {}),
      source: "final-surface-local-disclosure-setup",
    });
    await waitForReleaseSurfaceInstalledInputElement(input, action.dialog);
    const control = await waitForReleaseSurfaceInstalledInputElement(input, action.control);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, action.dialog);
    outcome.effect = "pass";
    outcome.observedEffect = `A bounded native click closed the exactly owned ${action.label} surface.`;
  } catch (error) {
    outcome.error = message(error);
  } finally {
    try {
      await postUi(connection, {
        openModal: "close",
        ...(action.clearPreview ? { clearPreview: true } : {}),
        source: "final-surface-local-disclosure-cleanup",
      });
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, action.dialog);
      outcome.cleanup = "pass";
    } catch (error) {
      outcome.error = appendCleanup(outcome.error, message(error));
    }
  }
  return finalize(outcome);
}

async function exerciseToggle(
  input: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
  action: Extract<Action, { kind: "toggle" }>,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, `No native ${action.label} disclosure effect was observed.`);
  let opened = false;
  try {
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, action.panel);
    const control = await waitForReleaseSurfaceInstalledInputElement(input, action.control);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElement(input, action.panel);
    opened = true;
    await clickReleaseSurfaceInstalledInputElement(input, control);
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, action.panel);
    opened = false;
    outcome.effect = "pass";
    outcome.observedEffect = `Bounded native clicks opened and closed the exactly owned ${action.label} disclosure.`;
  } catch (error) {
    outcome.error = message(error);
  } finally {
    try {
      if (opened) {
        const control = await waitForReleaseSurfaceInstalledInputElement(input, action.control);
        await clickReleaseSurfaceInstalledInputElement(input, control);
      }
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, action.panel);
      outcome.cleanup = "pass";
    } catch (error) {
      outcome.error = appendCleanup(outcome.error, message(error));
    }
  }
  return finalize(outcome);
}

async function exerciseHint(
  input: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
  action: Extract<Action, { kind: "hint" }>,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, `No native ${action.label} hint effect was observed.`);
  let opened = false;
  try {
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, action.panel);
    const control = await waitForReleaseSurfaceInstalledInputElement(input, action.control);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElement(input, action.panel);
    opened = true;
    const shell = await waitForReleaseSurfaceInstalledInputElement(input, ".shell");
    await clickReleaseSurfaceInstalledInputElement(input, shell);
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, action.panel);
    opened = false;
    outcome.effect = "pass";
    outcome.observedEffect = `Bounded native focus opened and dismissed the exactly owned ${action.label} hint.`;
  } catch (error) {
    outcome.error = message(error);
  } finally {
    try {
      if (opened) {
        const shell = await waitForReleaseSurfaceInstalledInputElement(input, ".shell");
        await clickReleaseSurfaceInstalledInputElement(input, shell);
      }
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, action.panel);
      outcome.cleanup = "pass";
    } catch (error) {
      outcome.error = appendCleanup(outcome.error, message(error));
    }
  }
  return finalize(outcome);
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

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "local disclosure did not satisfy every required verdict";
  }
  return outcome;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendCleanup(current: string | undefined, detail: string): string {
  return current ? `${current}; cleanup: ${detail}` : `cleanup: ${detail}`;
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${connection.base}/state/ui`, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`POST /state/ui failed ${response.status}: ${(await response.text()).slice(0, 800)}`);
}
