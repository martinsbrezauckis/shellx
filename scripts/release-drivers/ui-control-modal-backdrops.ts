import {
  clickReleaseSurfaceInstalledInputElementAtFraction,
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
type BackdropConfig = {
  fixtureId: string;
  label: string;
  backdrop: string;
  dialog: string;
  setup: (connection: Connection) => Promise<void>;
};

const configs: Record<string, BackdropConfig> = {
  "src/components/ActivityBrowserModal.tsx:[data-debug-id=\"activity-browser-backdrop\"]": direct(
    "activity",
    "Activity Browser",
    "[data-debug-id='activity-browser-backdrop']",
    ".activity-modal",
  ),
  "src/components/AttachmentMediaBoard.tsx:[data-debug-id=\"attachment-media-board-backdrop\"]": direct(
    "assets",
    "Attachment and Media Board",
    "[data-debug-id='attachment-media-board-backdrop']",
    ".asset-board-modal",
  ),
  "src/components/BuiltinDocModal.tsx:[data-debug-id=\"surface-components-builtindocmodal-4\"]": {
    fixtureId: "ui:modal-backdrop-builtin-doc",
    label: "built-in documentation",
    backdrop: "[data-debug-id='surface-components-builtindocmodal-4']",
    dialog: "[role='dialog'][aria-label='Features']",
    setup: async (connection) => {
      await postUi(connection, { openModal: "settings" });
      await postUi(connection, { debugClick: "[data-debug-id='settings-tab-about']" });
      await postUi(connection, { debugClick: "[title='Read the shellX features overview']" });
    },
  },
  "src/components/CommandPalette.tsx:[data-debug-id=\"surface-components-commandpalette-1\"]": direct(
    "palette",
    "Command Palette",
    "[data-debug-id='surface-components-commandpalette-1']",
    "[role='dialog'][aria-label='Command palette']",
  ),
  "src/components/ConnectionEditor.tsx:[data-debug-id=\"surface-components-connectioneditor-1\"]": {
    fixtureId: "ui:modal-backdrop-connection-editor",
    label: "connection editor",
    backdrop: "[data-debug-id='surface-components-connectioneditor-1']",
    dialog: "[role='dialog'][aria-labelledby='conn-editor-title']",
    setup: async (connection) => {
      await postUi(connection, { openModal: "settings" });
      await postUi(connection, { debugClick: "[data-debug-id='settings-tab-connections']" });
      await postUi(connection, { debugClick: ".connections-header button[title='Add a new connection preset']" });
    },
  },
  "src/components/ConnectorInboxModal.tsx:[data-debug-id=\"connector-inbox-backdrop\"]": direct(
    "connectorInbox",
    "Connector Inbox",
    "[data-debug-id='connector-inbox-backdrop']",
    ".connector-inbox-modal",
  ),
  "src/components/HelpModal.tsx:[data-debug-id=\"surface-components-helpmodal-1\"]": direct(
    "help",
    "keyboard shortcuts",
    "[data-debug-id='surface-components-helpmodal-1']",
    "[role='dialog'][aria-label='Keyboard shortcuts']",
  ),
  "src/components/PluginsModal.tsx:[data-debug-id=\"surface-components-pluginsmodal-1\"]": direct(
    "plugins",
    "Plugins",
    "[data-debug-id='surface-components-pluginsmodal-1']",
    "[role='dialog'][aria-label='Plugins']",
  ),
  "src/components/PRCreateModal.tsx:[data-debug-id=\"surface-components-prcreatemodal-1\"]": direct(
    "pr",
    "Create pull request",
    "[data-debug-id='surface-components-prcreatemodal-1']",
    "[role='dialog'][aria-label='Create pull request']",
  ),
  "src/components/PreviewCenter.tsx:[data-debug-id=\"preview-center-backdrop\"]": direct(
    "preview",
    "Preview Center",
    "[data-debug-id='preview-center-backdrop']",
    ".preview-center-modal",
  ),
  "src/components/Settings.tsx:[data-debug-id=\"surface-components-settings-1\"]": direct(
    "settings",
    "Settings",
    "[data-debug-id='surface-components-settings-1']",
    "[role='dialog'][aria-label='Settings']",
  ),
  "src/components/VaultPanel.tsx:[data-debug-id=\"surface-components-vaultpanel-1\"]": direct(
    "vault",
    "Vault workspace",
    "[data-debug-id='surface-components-vaultpanel-1']",
    "[data-debug-id='vault-workspace-modal']",
  ),
};

export const MODAL_BACKDROP_FIXTURES = Object.values(configs).map((config) => config.fixtureId);
export const MODAL_BACKDROP_CLEANUPS = ["ui:close-owned-modal-backdrop"] as const;
export const MODAL_BACKDROP_ORACLES = ["ui:activation:owned-modal-backdrop-closed"] as const;
export const MODAL_BACKDROP_SURFACE_NAMES = new Set(Object.keys(configs));

export function supportsModalBackdropControl(assignment: Assignment): boolean {
  return MODAL_BACKDROP_SURFACE_NAMES.has(assignment.surface.name);
}

export async function exerciseModalBackdropControl(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = configs[assignment.surface.name];
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No owned modal-backdrop close transition was observed.",
  };
  try {
    if (!config || assignment.fixtureId !== config.fixtureId) {
      throw new Error(`modal-backdrop fixture does not match ${assignment.surface.name}`);
    }
    await postUi(connection, { openModal: "close", source: "final-surface-modal-backdrop-baseline" });
    await config.setup(connection);
    await waitForReleaseSurfaceInstalledInputElement(installedInput, config.dialog);
    const backdrop = await waitForReleaseSurfaceInstalledInputElement(installedInput, config.backdrop);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElementAtFraction(installedInput, backdrop, 0.015, 0.015);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, config.backdrop);
    outcome.effect = "pass";
    outcome.observedEffect = `A bounded native pointer click on the outer ${config.label} backdrop closed its exact owned modal.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await postUi(connection, { openModal: "close", source: "final-surface-modal-backdrop-cleanup" });
      if (config) await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, config.backdrop);
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "modal backdrop did not satisfy every required verdict";
  }
  return outcome;
}

function direct(
  modal: string,
  label: string,
  backdrop: string,
  dialog: string,
): BackdropConfig {
  return {
    fixtureId: `ui:modal-backdrop-${modal}`,
    label,
    backdrop,
    dialog,
    setup: (connection) => postUi(connection, { openModal: modal }),
  };
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${connection.base}/state/ui`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`POST /state/ui failed ${response.status}: ${(await response.text()).slice(0, 800)}`);
}
