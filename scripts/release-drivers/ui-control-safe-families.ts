import {
  clearReleaseSurfaceInstalledInputElement as clearReleaseSurfaceWebDriverElement,
  clickReleaseSurfaceInstalledInputElement as clickReleaseSurfaceWebDriverElement,
  executeReleaseSurfaceInstalledInputScript as executeReleaseSurfaceWebDriverScript,
  findReleaseSurfaceInstalledInputElement as findReleaseSurfaceWebDriverElement,
  observeReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue as setReleaseSurfaceWebDriverElementValue,
  waitForReleaseSurfaceInstalledInputElement as waitForReleaseSurfaceWebDriverElement,
  waitForReleaseSurfaceInstalledInputElementAbsent as waitForReleaseSurfaceWebDriverElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { ReleaseSurfaceTauriInvokeSession } from "../lib/release-surface-tauri-invoke-client";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type WebDriver = ReleaseSurfaceInstalledInputSession;
type Connection = { base: string; token: string };

const SETTINGS_DIALOG = "[role='dialog'][aria-label='Settings']";
const SETTINGS_CONNECTIONS_TAB = "[data-debug-id='settings-tab-connections']";
const SETTINGS_GENERAL_TAB = "[data-debug-id='settings-tab-general']";
const SETTINGS_ABOUT_TAB = "[data-debug-id='settings-tab-about']";
const SETTINGS_DATA_TAB = "[data-debug-id='settings-tab-data']";
const SETTINGS_CONNECTORS_TAB = "[data-debug-id='settings-tab-connectors']";
const CONNECTION_ADD = "[title='Add a new connection preset']";
const CONNECTION_PICKER_ADD = "[title='Add a new connection']";
const CONNECTION_PICKER_DIALOG = "[role='dialog'][aria-label='Saved connections']";
const COMPOSER_CONNECTION = "[data-debug-id='composer-connection']";
const CONNECTION_DIALOG = "[role='dialog'][aria-labelledby='conn-editor-title']";
const CONNECTION_CANCEL = "[aria-label='Cancel connection changes']";
const CONNECTION_LOCAL = "[data-debug-id='connection-transport-local']";
const CONNECTION_WSL = "[data-debug-id='connection-transport-wsl']";
const CONNECTION_SSH = "[data-debug-id='connection-transport-ssh']";
const CONNECTION_RUNTIME = "[data-debug-id='connection-ssh-runtime-select']";
const CONNECTION_SSH_KEY = "[data-debug-id='connection-ssh-key-select']";
const PLUGINS_DIALOG = "[role='dialog'][aria-label='Plugins']";
const PLUGINS_OPEN = "[aria-label='Open plugins']";
const PLUGINS_CLOSE = `${PLUGINS_DIALOG} [aria-label='Close']`;

const CONNECTION_OPEN_SURFACE = "src/components/settings/ConnectionsTab.tsx:[title=\"Add a new connection preset\"]";
const CONNECTION_PICKER_OPEN_SURFACE = "src/components/ConnectionPicker.tsx:[title=\"Add a new connection\"]";
const CONNECTION_CLOSE_CONTROLS = {
  "src/components/ConnectionEditor.tsx:[aria-label=\"Close connection editor\"]": "[aria-label='Close connection editor']",
  "src/components/ConnectionEditor.tsx:[aria-label=\"Cancel connection changes\"]": CONNECTION_CANCEL,
} as const;
const CONNECTION_TEXT_CONTROLS = {
  "src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-label-input\"]": {
    control: "[data-debug-id='connection-label-input']",
    value: "shellx-final-local-draft",
    precondition: "local",
    label: "connection label",
  },
  "src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-wsl-distro-input\"]": {
    control: "[data-debug-id='connection-wsl-distro-input']",
    value: "ShellX-Final-WSL",
    precondition: "wsl",
    label: "WSL distro",
  },
  "src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-ssh-host-input\"]": {
    control: "[data-debug-id='connection-ssh-host-input']",
    value: "shellx-user@example.invalid",
    precondition: "ssh",
    label: "SSH host",
  },
  "src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-ssh-port-input\"]": {
    control: "[data-debug-id='connection-ssh-port-input']",
    value: "2222",
    precondition: "ssh",
    label: "SSH port",
  },
  "src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-ssh-wsl-distro-input\"]": {
    control: "[data-debug-id='connection-ssh-wsl-distro-input']",
    value: "ShellX-Final-Remote-WSL",
    precondition: "ssh-wsl",
    label: "remote Windows WSL distro",
  },
} as const;
const CONNECTION_TRANSPORT_CONTROLS = {
  "src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-transport-local\"]": {
    control: CONNECTION_LOCAL,
    target: "local",
    setup: CONNECTION_WSL,
  },
  "src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-transport-wsl\"]": {
    control: CONNECTION_WSL,
    target: "wsl",
    setup: CONNECTION_LOCAL,
  },
  "src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-transport-ssh\"]": {
    control: CONNECTION_SSH,
    target: "ssh",
    setup: CONNECTION_LOCAL,
  },
} as const;
const CONNECTION_RUNTIME_SURFACE = "src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-ssh-runtime-select\"]";
const CONNECTION_SSH_KEY_SURFACE = "src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-ssh-key-select\"]";
const OWNED_CONNECTION_VAULT_KEY = "connections.shellx-release-owned-ssh-key";
const OWNED_CONNECTION_VAULT_VALUE = "shellx-release-owned-ssh-private-key-placeholder";

type GeneralSettingKey = "density" | "theme";
const GENERAL_SETTING_CHOICES: Record<string, {
  key: GeneralSettingKey;
  target: string;
  control: string;
}> = Object.fromEntries([
  ...["compact", "default", "comfortable"].map((value) => [
    `src/components/settings/GeneralTab.tsx:[data-debug-id=\"settings-density-${value}\"]`,
    { key: "density", target: value, control: `[data-debug-id='settings-density-${value}']` },
  ]),
  [
    "src/components/settings/GeneralTab.tsx:[aria-label=\"Use Black theme\"]",
    { key: "theme", target: "black", control: "[aria-label='Use Black theme']" },
  ],
  [
    "src/components/settings/GeneralTab.tsx:[aria-label=\"Use Black and warm theme\"]",
    { key: "theme", target: "black_warm", control: "[aria-label='Use Black and warm theme']" },
  ],
  [
    "src/components/settings/GeneralTab.tsx:[aria-label=\"Use Bright theme\"]",
    { key: "theme", target: "bright", control: "[aria-label='Use Bright theme']" },
  ],
]) as Record<string, { key: GeneralSettingKey; target: string; control: string }>;
const GENERAL_FONT_RANGE_SURFACE = "src/components/settings/GeneralTab.tsx:[aria-label=\"Chat font size in pixels\"]";
const GENERAL_FONT_RANGE = "[aria-label='Chat font size in pixels']";
const GENERAL_FONT_RESET_SURFACE = "src/components/settings/GeneralTab.tsx:[title=\"Reset to default\"]";
const GENERAL_FONT_RESET = "[title='Reset to default']";
const GENERAL_FONT_DEFAULT = 19;
const DATA_DELETE_OPEN_SURFACE = 'src/components/settings/DataTab.tsx:[title^="Delete the "][title$=" on disk + in localStorage"]';
const DATA_DELETE_CANCEL_SURFACE = 'src/components/settings/DataTab.tsx:[id="data-delete-cancel"]';
const DATA_DELETE_CONFIRM_SURFACE = 'src/components/settings/DataTab.tsx:[id="data-delete-confirm"]';
const DATA_DELETE_OPEN = "[title^='Delete the '][title$=' on disk + in localStorage']";
const DATA_DELETE_DIALOG = "[role='alertdialog'][aria-labelledby='data-delete-title']";
const DATA_DELETE_CANCEL = "[id='data-delete-cancel']";
const DATA_DELETE_CONFIRM = "[id='data-delete-confirm']";
const DATA_DELETE_RECEIPT = "[data-shellx-release-control='data-delete-receipt']";
const OWNED_USER_DATA_KEY = "shellX.projects.v1";
const PRESERVED_USER_DATA_KEY = "shellX.chatTitles.v1";

const BUILTIN_DOC_CONTROLS = {
  "src/components/settings/AboutTab.tsx:[title=\"Read the shellX features overview\"]": {
    control: "[title='Read the shellX features overview']",
    dialog: "[role='dialog'][aria-label='Features']",
    label: "Features",
  },
  "src/components/settings/AboutTab.tsx:[title=\"Read the shellX quick-start guide\"]": {
    control: "[title='Read the shellX quick-start guide']",
    dialog: "[role='dialog'][aria-label='Quick start']",
    label: "Quick start",
  },
  "src/components/settings/AboutTab.tsx:[title=\"Read bundled release notes\"]": {
    control: "[title='Read bundled release notes']",
    dialog: "[role='dialog'][aria-label='Changelog']",
    label: "Changelog",
  },
  'src/components/settings/AboutTab.tsx:[title="Read bundled third-party notices"]': {
    control: "[title='Read bundled third-party notices']",
    dialog: "[role='dialog'][aria-label='Third-party notices']",
    label: "Third-party notices",
  },
} as const;
const BUILTIN_DOC_CLOSE_SURFACE = "src/components/BuiltinDocModal.tsx:[aria-label=\"Close (Esc)\"]";
const LAZY_SURFACE_RETRY = 'src/components/LazySurface.tsx:role=button;name="Retry"';
const LAZY_SURFACE_CLOSE = 'src/components/LazySurface.tsx:role=button;name="Close"';
const LAZY_SURFACE_ALERT = "[role='alert']";
const LAZY_SURFACE_RECOVERED = "[data-shellx-release-control='lazy-surface-recovered']";
const ABOUT_EXTERNAL_CONTROLS = {
  "src/components/settings/AboutTab.tsx:[data-debug-id=\"surface-components-settings-abouttab-4\"]": {
    control: "[data-debug-id='surface-components-settings-abouttab-4']",
    url: "https://theshellx.com",
    label: "ShellX homepage",
  },
  "src/components/settings/AboutTab.tsx:[data-debug-id=\"surface-components-settings-abouttab-5\"]": {
    control: "[data-debug-id='surface-components-settings-abouttab-5']",
    url: "https://x.com/theshellx",
    label: "ShellX X profile",
  },
  "src/components/settings/AboutTab.tsx:[data-debug-id=\"about-full-manual-link\"]": {
    control: "[data-debug-id='about-full-manual-link']",
    url: "https://docs.theshellx.com/manual/shellx/",
    label: "full ShellX manual",
  },
  "src/components/settings/AboutTab.tsx:[data-debug-id=\"surface-components-settings-abouttab-9\"]": {
    control: "[data-debug-id='surface-components-settings-abouttab-9']",
    url: "https://github.com/martinsbrezauckis/shellx",
    label: "ShellX GitHub repository",
  },
  "src/components/settings/AboutTab.tsx:[data-debug-id=\"surface-components-settings-abouttab-10\"]": {
    control: "[data-debug-id='surface-components-settings-abouttab-10']",
    url: "https://github.com/martinsbrezauckis/shellx/issues",
    label: "ShellX issue tracker",
  },
} as const;
const PLUGINS_DISCLOSURE_SURFACE = "src/components/PluginsModal.tsx::is([title=\"Collapse tier\"],[title=\"Expand tier\"])";
const PLUGINS_DISCLOSURE = ":is([title='Collapse tier'],[title='Expand tier'])";
const PROJECTS_DISCLOSURE_SURFACE = "src/components/LeftRail.tsx::is([title=\"Collapse all projects\"],[title=\"Expand all projects\"])";
const PROJECTS_DISCLOSURE = ":is([title='Collapse all projects'],[title='Expand all projects'])";
const OPEN_CHATS_DISCLOSURE_SURFACE = "src/components/LeftRail.tsx::is([title=\"Hide open chats — drop here to unfile\"],[title=\"Show open chats — drop here to unfile\"])";
const OPEN_CHATS_DISCLOSURE = ":is([title='Hide open chats — drop here to unfile'],[title='Show open chats — drop here to unfile'])";
const PAST_CHATS_DISCLOSURE_SURFACE = "src/components/LeftRail.tsx:[data-debug-id=\"left-past-chats-toggle\"]";
const PAST_CHATS_DISCLOSURE = "[data-debug-id='left-past-chats-toggle']";
const LOCAL_DISCLOSURES = {
  [PLUGINS_DISCLOSURE_SURFACE]: {
    selector: PLUGINS_DISCLOSURE,
    label: "Plugins tier",
    owner: "plugins",
  },
  [PROJECTS_DISCLOSURE_SURFACE]: {
    selector: PROJECTS_DISCLOSURE,
    label: "Projects",
    owner: "left-rail",
  },
  [OPEN_CHATS_DISCLOSURE_SURFACE]: {
    selector: OPEN_CHATS_DISCLOSURE,
    label: "Open chats",
    owner: "left-rail",
  },
  [PAST_CHATS_DISCLOSURE_SURFACE]: {
    selector: PAST_CHATS_DISCLOSURE,
    label: "Past chats",
    owner: "left-rail",
  },
} as const;
const PROJECT_ADD_SURFACE = "src/components/LeftRail.tsx:[data-debug-id=\"left-add-project\"]";
const PROJECT_RENAME_SURFACE = "src/components/LeftRail.tsx:[data-debug-id=\"left-project-rename-input\"]";
const PROJECT_CARET_SURFACE = "src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-3\"]";
const PROJECT_ROW_SURFACE = "src/components/LeftRail.tsx:[title$=\" — double-click to rename — drop a chat here to file it\"]";
const PROJECT_DELETE_SURFACE = "src/components/LeftRail.tsx:[aria-label=\"Delete project\"]";
const PROJECT_MARKER_DELETE_SURFACE = "src/components/LeftRail.tsx:[title^=\"Remove the label only — the \"][title$=\" chat(s) stay and reappear under \\\"Past chats\\\".|Remove the project label.\"]";
const PROJECT_ADD = "[data-debug-id='left-add-project']";
const PROJECT_ROW = "[data-debug-id='left-project-row']";
const PROJECT_RENAME_INPUT = "[data-debug-id='left-project-rename-input']";
const LEFT_RAIL = "[data-debug-id='left-rail']";
const PROJECT_CARET = "[data-debug-id='surface-components-leftrail-3']";
const PROJECT_MAIN = ".proj-row-main";
const PROJECT_DELETE = "[aria-label='Delete project']";
const PROJECT_DELETE_DIALOG = "[role='alertdialog'][aria-labelledby='proj-del-title']";
const PROJECT_MARKER_DELETE = ".proj-delete-actions > button:first-child";

const CONNECTOR_NEW_SURFACE = "src/components/settings/ConnectorsTab.tsx:role=button;name=\"New\"";
const CONNECTOR_CANCEL_SURFACE = "src/components/settings/ConnectorsTab.tsx:[aria-label=\"Cancel connector draft\"]";
const CONNECTOR_NEW = "[aria-label='Connector editor'] .connector-editor-head > button.settings-pill:not([aria-label])";
const CONNECTOR_CANCEL = "[aria-label='Cancel connector draft']";
const CONNECTOR_PROVIDER_SURFACE = "src/components/settings/ConnectorsTab.tsx:[data-debug-id=\"surface-components-settings-connectorstab-3\"]";
const CONNECTOR_PROVIDER_TELEGRAM = "[data-debug-id='surface-components-settings-connectorstab-3'][data-provider-kind='telegram']";
const CONNECTOR_PROVIDER_DISCORD = "[data-debug-id='surface-components-settings-connectorstab-3'][data-provider-kind='discord']";
const CONNECTOR_STATE_CONTROLS = {
  "src/components/settings/ConnectorsTab.tsx:role=button;name=\"Paused\"": {
    control: "[aria-label='Connector receiver state'] > button:first-child",
    setup: "[aria-label='Connector receiver state'] > button:last-child",
    state: { enabled: false },
    setupState: { enabled: true },
    label: "paused receiver",
  },
  "src/components/settings/ConnectorsTab.tsx:role=button;name=\"Live\"": {
    control: "[aria-label='Connector receiver state'] > button:last-child",
    setup: "[aria-label='Connector receiver state'] > button:first-child",
    state: { enabled: true },
    setupState: { enabled: false },
    label: "live receiver",
  },
  "src/components/settings/ConnectorsTab.tsx:role=button;name=\"Inbox\"": {
    control: "[aria-label='Connector delivery mode'] > button:first-child",
    setup: "[aria-label='Connector delivery mode'] > button:last-child",
    state: { dispatchMode: "inbox" },
    setupState: { dispatchMode: "autoPrompt" },
    label: "Inbox delivery",
  },
  "src/components/settings/ConnectorsTab.tsx:[title^=\"Send allowlisted \"][title$=\" messages to the active session\"]": {
    control: "[aria-label='Connector delivery mode'] > button:last-child",
    setup: "[aria-label='Connector delivery mode'] > button:first-child",
    state: { dispatchMode: "autoPrompt" },
    setupState: { dispatchMode: "inbox" },
    label: "Session chat delivery",
  },
} as const;
const CONNECTOR_TARGET_SURFACE = "src/components/settings/ConnectorsTab.tsx:[id=\"connector-target\"]";
const CONNECTOR_TARGET = "[id='connector-target']";
const CONNECTOR_TEXT_CONTROLS = {
  "src/components/settings/ConnectorsTab.tsx:[data-debug-id=\"surface-components-settings-connectorstab-21\"]": {
    control: "[data-debug-id='surface-components-settings-connectorstab-21']",
    baseline: "telegram/bot-token",
    value: "shellx-final/connector-token-ref",
    label: "Vault key reference",
    draftScoped: true,
  },
  "src/components/settings/ConnectorsTab.tsx:[id=\"connector-allowed\"]": {
    control: "[id='connector-allowed']",
    baseline: "",
    value: "999999999, 888888888",
    label: "allowlist draft",
    draftScoped: true,
  },
  "src/components/settings/ConnectorsTab.tsx:[id=\"connector-sim-sender\"]": {
    control: "[id='connector-sim-sender']",
    baseline: "",
    value: "shellx-final-synthetic-sender",
    label: "simulator sender draft",
    draftScoped: false,
  },
  "src/components/settings/ConnectorsTab.tsx:[id=\"connector-sim-conversation\"]": {
    control: "[id='connector-sim-conversation']",
    baseline: "",
    value: "shellx-final-synthetic-conversation",
    label: "simulator conversation draft",
    draftScoped: false,
  },
  "src/components/settings/ConnectorsTab.tsx:[id=\"connector-sim-text\"]": {
    control: "[id='connector-sim-text']",
    baseline: "",
    value: "ShellX final synthetic inbound message",
    label: "simulator message draft",
    draftScoped: false,
  },
} as const;
const SHELLX_TOOL_EXPOSURE_SURFACE = "src/components/RightRail.tsx:[data-debug-id=\"surface-components-rightrail-2\"]";
const SHELLX_TOOL_EXPOSURE_MODES = ["nativeFirst", "hostBridge", "hostFull", "off"] as const;
type ShellxToolExposureMode = typeof SHELLX_TOOL_EXPOSURE_MODES[number];
const RIGHT_TOOLING_TAB = "[data-debug-id='right-tab-tooling']";

const PROJECT_STATE_SCRIPT = String.raw`
return (() => {
  void "SHELLX_SAFE_FAMILY_PROJECT_STATE";
  const row = document.querySelector(arguments[0]);
  const caret = document.querySelector(arguments[1]);
  const main = document.querySelector(arguments[2]);
  const dialog = document.querySelector(arguments[3]);
  return {
    rowPresent: row instanceof HTMLElement,
    expanded: caret instanceof HTMLElement ? caret.getAttribute("aria-expanded") === "true" : null,
    mainExpanded: main instanceof HTMLElement ? main.getAttribute("aria-expanded") === "true" : null,
    dialogPresent: dialog instanceof HTMLElement,
  };
})();`;
export const SAFE_UI_CONTROL_FIXTURES = [
  "ui:connection-editor-closed",
  "ui:connection-editor-open",
  "ui:connection-editor-local-draft",
  "ui:connection-editor-choice-baseline",
  "ui:connection-editor-owned-vault-key",
  "ui:general-setting-owned-baseline",
  "ui:data-delete-dialog-closed",
  "ui:data-delete-dialog-open",
  "ui:data-delete-owned-section",
  "ui:builtin-doc-closed",
  "ui:builtin-doc-open",
  "ui:about-external-link-baseline",
  "ui:local-disclosure-owned-baseline",
  "ui:empty-project-list",
  "ui:owned-project-row-collapsed",
  "ui:owned-project-delete-dialog",
  "ui:connectors-draft-closed",
  "ui:connectors-unsaved-draft-open",
  "ui:connectors-unsaved-draft-baseline",
  "ui:shellx-tool-exposure-owned-baseline",
  "ui:lazy-surface-owned-error",
] as const;

export const SAFE_UI_CONTROL_CLEANUPS = [
  "ui:close-connection-editor-and-settings",
  "ui:clear-connection-draft-and-close-settings",
  "ui:restore-connection-draft-and-close-settings",
  "ui:clear-connection-vault-selection-delete-owned-key-and-close-settings",
  "ui:restore-general-setting-and-close-settings",
  "ui:close-data-delete-dialog-and-settings",
  "ui:restore-empty-user-data-and-close-settings",
  "ui:close-builtin-doc-and-settings",
  "ui:close-about-external-link-and-settings",
  "ui:restore-local-disclosure-and-close-owner",
  "ui:delete-owned-project-draft",
  "ui:delete-owned-project-marker",
  "ui:restore-connectors-draft-and-close-settings",
  "ui:restore-shellx-tool-exposure-and-right-rail",
  "ui:clear-lazy-surface-fixture",
] as const;

export const SAFE_UI_CONTROL_ORACLES = [
  "ui:activation:connection-editor-opened",
  "ui:activation:connection-editor-closed",
  "ui:boolean-state-transition",
  "ui:range-state-transition",
  "ui:activation:general-setting-reset",
  "ui:activation:data-delete-dialog-opened",
  "ui:activation:data-delete-dialog-cancelled",
  "ui:activation:data-delete-owned-section-removed",
  "ui:activation:builtin-doc-opened",
  "ui:activation:builtin-doc-closed",
  "ui:activation:about-external-link-dispatched",
  "ui:activation:project-draft-created",
  "ui:activation:project-delete-dialog-opened",
  "ui:activation:project-marker-deleted",
  "ui:activation:connectors-draft-opened",
  "ui:activation:connectors-draft-closed",
  "ui:activation:lazy-surface-recovered",
  "ui:activation:lazy-surface-dismissed",
] as const;

export function supportsSafeUiControlFamily(assignment: Assignment): boolean {
  const name = assignment.surface.name;
  return name === CONNECTION_OPEN_SURFACE
    || name === CONNECTION_PICKER_OPEN_SURFACE
    || name in CONNECTION_CLOSE_CONTROLS
    || name in CONNECTION_TEXT_CONTROLS
    || name in CONNECTION_TRANSPORT_CONTROLS
    || name === CONNECTION_RUNTIME_SURFACE
    || name === CONNECTION_SSH_KEY_SURFACE
    || name in GENERAL_SETTING_CHOICES
    || name === GENERAL_FONT_RANGE_SURFACE
    || name === GENERAL_FONT_RESET_SURFACE
    || name === DATA_DELETE_OPEN_SURFACE
    || name === DATA_DELETE_CANCEL_SURFACE
    || name === DATA_DELETE_CONFIRM_SURFACE
    || name in BUILTIN_DOC_CONTROLS
    || name === BUILTIN_DOC_CLOSE_SURFACE
    || name === LAZY_SURFACE_RETRY
    || name === LAZY_SURFACE_CLOSE
    || name in ABOUT_EXTERNAL_CONTROLS
    || name in LOCAL_DISCLOSURES
    || name === PROJECT_ADD_SURFACE
    || name === PROJECT_RENAME_SURFACE
    || name === PROJECT_CARET_SURFACE
    || name === PROJECT_ROW_SURFACE
    || name === PROJECT_DELETE_SURFACE
    || name === PROJECT_MARKER_DELETE_SURFACE
    || name === CONNECTOR_NEW_SURFACE
    || name === CONNECTOR_CANCEL_SURFACE
    || name === CONNECTOR_PROVIDER_SURFACE
    || name in CONNECTOR_STATE_CONTROLS
    || name === CONNECTOR_TARGET_SURFACE
    || name in CONNECTOR_TEXT_CONTROLS
    || name === SHELLX_TOOL_EXPOSURE_SURFACE;
}

export async function exerciseSafeUiControlFamily(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const name = assignment.surface.name;
  if (name === CONNECTION_OPEN_SURFACE) return await exerciseConnectionOpen(connection, webdriver, assignment);
  if (name === CONNECTION_PICKER_OPEN_SURFACE) return await exerciseConnectionPickerOpen(connection, webdriver, assignment);
  if (name in CONNECTION_CLOSE_CONTROLS) return await exerciseConnectionClose(connection, webdriver, assignment);
  if (name in CONNECTION_TEXT_CONTROLS) return await exerciseConnectionText(connection, webdriver, assignment);
  if (name in CONNECTION_TRANSPORT_CONTROLS || name === CONNECTION_RUNTIME_SURFACE) {
    return await exerciseConnectionChoice(connection, webdriver, assignment);
  }
  if (name === CONNECTION_SSH_KEY_SURFACE) {
    return await exerciseConnectionSshKey(connection, webdriver, assignment);
  }
  if (name in GENERAL_SETTING_CHOICES) return await exerciseGeneralChoice(connection, webdriver, assignment);
  if (name === GENERAL_FONT_RANGE_SURFACE || name === GENERAL_FONT_RESET_SURFACE) {
    return await exerciseGeneralFont(connection, webdriver, assignment);
  }
  if (name === DATA_DELETE_OPEN_SURFACE || name === DATA_DELETE_CANCEL_SURFACE) {
    return await exerciseDataDeleteDialog(connection, webdriver, assignment);
  }
  if (name === DATA_DELETE_CONFIRM_SURFACE) {
    return await exerciseDataDeleteConfirm(connection, webdriver, assignment);
  }
  if (name in BUILTIN_DOC_CONTROLS || name === BUILTIN_DOC_CLOSE_SURFACE) {
    return await exerciseBuiltinDoc(connection, webdriver, assignment);
  }
  if (name === LAZY_SURFACE_RETRY || name === LAZY_SURFACE_CLOSE) {
    return await exerciseLazySurfaceRecovery(connection, webdriver, assignment);
  }
  if (name in ABOUT_EXTERNAL_CONTROLS) return await exerciseAboutExternalLink(connection, webdriver, assignment);
  if (name === PROJECT_ADD_SURFACE) return await exerciseProjectAdd(webdriver, assignment);
  if (name === PROJECT_RENAME_SURFACE) return await exerciseProjectRename(webdriver, assignment);
  if (name === PROJECT_CARET_SURFACE || name === PROJECT_ROW_SURFACE) {
    return await exerciseProjectExpansion(webdriver, assignment);
  }
  if (name === PROJECT_DELETE_SURFACE) return await exerciseProjectDeleteDialog(webdriver, assignment);
  if (name === PROJECT_MARKER_DELETE_SURFACE) return await exerciseProjectMarkerDelete(webdriver, assignment);
  if (name === CONNECTOR_NEW_SURFACE || name === CONNECTOR_CANCEL_SURFACE) {
    return await exerciseConnectorDraftLifecycle(connection, webdriver, assignment);
  }
  if (name === CONNECTOR_PROVIDER_SURFACE) return await exerciseConnectorProvider(connection, webdriver, assignment);
  if (name in CONNECTOR_STATE_CONTROLS) return await exerciseConnectorState(connection, webdriver, assignment);
  if (name === CONNECTOR_TARGET_SURFACE) return await exerciseConnectorTarget(connection, webdriver, assignment);
  if (name in CONNECTOR_TEXT_CONTROLS) return await exerciseConnectorText(connection, webdriver, assignment);
  if (name === SHELLX_TOOL_EXPOSURE_SURFACE) return await exerciseShellxToolExposure(connection, webdriver, assignment);
  return await exerciseLocalDisclosure(connection, webdriver, assignment);
}

async function exerciseConnectorDraftLifecycle(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
) {
  const opening = assignment.surface.name === CONNECTOR_NEW_SURFACE;
  const outcome = emptyOutcome(
    assignment,
    opening
      ? "No native Connectors draft-open effect was observed."
      : "No native Connectors draft-cancel effect was observed.",
  );
  let baselineTab: SettingsTabId | null = null;
  try {
    baselineTab = await readSettingsTab(connection);
    await openSettingsTab(connection, webdriver, "connectors");
    if (!opening) {
      if (!(await readConnectorState(webdriver)).draftOpen) await clickSelector(webdriver, CONNECTOR_NEW);
      await waitForConnectorState(webdriver, connectorDraftBaseline(true));
      const allowed = await waitForReleaseSurfaceWebDriverElement(webdriver, "[id='connector-allowed']");
      await replaceInput(webdriver, allowed, "[id='connector-allowed']", "999999999");
    }
    const selector = opening ? CONNECTOR_NEW : CONNECTOR_CANCEL;
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    if (opening) {
      await waitForConnectorState(webdriver, connectorDraftBaseline(true));
      outcome.observedEffect = "A native WebDriver click opened a new unsaved Connector draft with the exact bounded default state.";
    } else {
      await waitForConnectorState(webdriver, connectorDraftBaseline(false));
      await clickSelector(webdriver, CONNECTOR_NEW);
      await waitForConnectorState(webdriver, connectorDraftBaseline(true));
      await waitForInputNonempty(webdriver, "[id='connector-allowed']", false);
      await clickSelector(webdriver, CONNECTOR_CANCEL);
      await waitForConnectorState(webdriver, connectorDraftBaseline(false));
      outcome.observedEffect = "A native WebDriver click cancelled the unsaved Connector draft, discarded its bounded local text, and restored the exact closed state.";
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupConnectorSettings(connection, webdriver, outcome, baselineTab);
  }
  return finalize(outcome);
}

async function exerciseConnectorProvider(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const outcome = emptyOutcome(assignment, "No native Connectors provider-draft effect was observed.");
  let baselineTab: SettingsTabId | null = null;
  try {
    baselineTab = await readSettingsTab(connection);
    await openConnectorDraft(connection, webdriver);
    await waitForConnectorState(webdriver, { providerKind: "telegram" });
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, CONNECTOR_PROVIDER_DISCORD);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForConnectorState(webdriver, { providerKind: "discord" });
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click changed only the unsaved Connectors provider draft from Telegram to Discord.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      const state = await readConnectorState(webdriver);
      if (state.draftOpen && state.providerKind !== "telegram") await clickSelector(webdriver, CONNECTOR_PROVIDER_TELEGRAM);
      if (state.draftOpen) await waitForConnectorState(webdriver, { providerKind: "telegram" });
    });
    await cleanupConnectorSettings(connection, webdriver, outcome, baselineTab);
  }
  return finalize(outcome);
}

async function exerciseConnectorState(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const config = CONNECTOR_STATE_CONTROLS[assignment.surface.name as keyof typeof CONNECTOR_STATE_CONTROLS];
  const outcome = emptyOutcome(assignment, "No native Connectors state-draft effect was observed.");
  let baselineTab: SettingsTabId | null = null;
  try {
    baselineTab = await readSettingsTab(connection);
    await openConnectorDraft(connection, webdriver);
    await clickSelector(webdriver, config.setup);
    await waitForConnectorState(webdriver, config.setupState);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForConnectorState(webdriver, config.state);
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click changed only the unsaved Connectors draft to ${config.label}.`;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      const state = await readConnectorState(webdriver);
      if (state.draftOpen && state.enabled !== false) await clickSelector(webdriver, "[aria-label='Connector receiver state'] > button:first-child");
      if (state.draftOpen && state.dispatchMode !== "inbox") await clickSelector(webdriver, "[aria-label='Connector delivery mode'] > button:first-child");
      if (state.draftOpen) await waitForConnectorState(webdriver, { enabled: false, dispatchMode: "inbox" });
    });
    await cleanupConnectorSettings(connection, webdriver, outcome, baselineTab);
  }
  return finalize(outcome);
}

async function exerciseConnectorTarget(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const outcome = emptyOutcome(assignment, "No native Connectors target-draft effect was observed.");
  let baselineTab: SettingsTabId | null = null;
  try {
    baselineTab = await readSettingsTab(connection);
    await openConnectorDraft(connection, webdriver);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, CONNECTOR_TARGET);
    outcome.present = "pass";
    await setReleaseSurfaceWebDriverElementValue(webdriver, control, "Fixed tab id");
    outcome.invoke = "pass";
    await waitForConnectorState(webdriver, { targetMode: "fixedTab" });
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver selection changed only the unsaved Connectors target mode to a fixed tab without choosing or saving a tab identifier.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      const control = await visibleElement(webdriver, CONNECTOR_TARGET);
      if (control && (await readConnectorState(webdriver)).targetMode !== "activeTab") {
        await setReleaseSurfaceWebDriverElementValue(webdriver, control, "Active shellX tab");
      }
      if ((await readConnectorState(webdriver)).draftOpen) {
        await waitForConnectorState(webdriver, { targetMode: "activeTab" });
      }
    });
    await cleanupConnectorSettings(connection, webdriver, outcome, baselineTab);
  }
  return finalize(outcome);
}

async function exerciseConnectorText(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const config = CONNECTOR_TEXT_CONTROLS[assignment.surface.name as keyof typeof CONNECTOR_TEXT_CONTROLS];
  const outcome = emptyOutcome(assignment, "No native Connectors text-draft effect was observed.");
  let baselineTab: SettingsTabId | null = null;
  try {
    baselineTab = await readSettingsTab(connection);
    if (config.draftScoped) await openConnectorDraft(connection, webdriver);
    else await openSettingsTab(connection, webdriver, "connectors");
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    outcome.present = "pass";
    await replaceInput(webdriver, control, config.control, config.value);
    outcome.invoke = "pass";
    await waitForInputNonempty(webdriver, config.control, true);
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver text entry changed only the unsaved Connectors ${config.label}; no draft contents were retained in evidence.`;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      const control = await visibleElement(webdriver, config.control);
      if (control) {
        await replaceInput(webdriver, control, config.control, config.baseline);
        await waitForInputNonempty(webdriver, config.control, config.baseline.length > 0);
      }
    });
    await cleanupConnectorSettings(connection, webdriver, outcome, baselineTab);
  }
  return finalize(outcome);
}

async function exerciseShellxToolExposure(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const outcome = emptyOutcome(assignment, "No native ShellX tool-exposure effect was observed.");
  let baseline: ToolExposureUiState | null = null;
  try {
    baseline = await readToolExposureUiState(connection);
    await postUi(connection, { rightTab: "Tooling", source: "final-surface-safe-tool-exposure" });
    await waitForReleaseSurfaceWebDriverElement(webdriver, `${RIGHT_TOOLING_TAB}.active[aria-selected='true']`);
    const sequence = [
      ...SHELLX_TOOL_EXPOSURE_MODES.filter((mode) => mode !== baseline!.exposure),
      baseline.exposure,
    ];
    for (const mode of sequence) {
      const selector = shellxToolExposureSelector(mode);
      const control = await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
      outcome.present = "pass";
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      await waitForToolExposure(webdriver, connection, mode);
    }
    outcome.invoke = "pass";
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver clicks exercised all four per-tab ShellX tool-exposure modes and restored the exact original mode without starting a provider session.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (baseline) await cleanupStep(outcome, async () => {
      const current = await readToolExposureUiState(connection);
      if (current.exposure !== baseline!.exposure) {
        await clickSelector(webdriver, shellxToolExposureSelector(baseline!.exposure));
      }
      await waitForToolExposure(webdriver, connection, baseline!.exposure);
      await postUi(connection, { rightTab: baseline!.rightTab, source: "final-surface-safe-tool-exposure-cleanup" });
      await waitForReleaseSurfaceWebDriverElement(
        webdriver,
        `[data-debug-id='right-tab-${baseline!.rightTab.toLowerCase()}'].active[aria-selected='true']`,
      );
    });
    if (!outcome.error?.includes("cleanup:")) outcome.cleanup = "pass";
  }
  return finalize(outcome);
}

async function exerciseProjectAdd(webdriver: WebDriver, assignment: Assignment) {
  const outcome = emptyOutcome(assignment, "No native project-draft creation effect was observed.");
  try {
    if (await findReleaseSurfaceWebDriverElement(webdriver, PROJECT_ROW)
      || await findReleaseSurfaceWebDriverElement(webdriver, PROJECT_RENAME_INPUT)) {
      throw new Error("project-add fixture requires the isolated project list to be empty");
    }
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, PROJECT_ADD);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElement(webdriver, PROJECT_ROW);
    await waitForReleaseSurfaceWebDriverElement(webdriver, PROJECT_RENAME_INPUT);
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click created one isolated inline project draft without opening a folder picker or external resource.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      const draft = await findReleaseSurfaceWebDriverElement(webdriver, PROJECT_RENAME_INPUT);
      if (draft) {
        await clearReleaseSurfaceWebDriverElement(webdriver, draft);
        const rail = await waitForReleaseSurfaceWebDriverElement(webdriver, LEFT_RAIL);
        await clickReleaseSurfaceWebDriverElement(webdriver, rail);
      }
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, PROJECT_RENAME_INPUT);
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, PROJECT_ROW);
    });
    if (!outcome.error?.includes("cleanup:")) outcome.cleanup = "pass";
  }
  return finalize(outcome);
}

async function exerciseProjectRename(webdriver: WebDriver, assignment: Assignment) {
  const outcome = emptyOutcome(assignment, "No native project rename-draft effect was observed.");
  let input: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  try {
    await requireEmptyProjectList(webdriver);
    await clickSelector(webdriver, PROJECT_ADD);
    input = await waitForReleaseSurfaceWebDriverElement(webdriver, PROJECT_RENAME_INPUT);
    outcome.present = "pass";
    await replaceInput(webdriver, input, PROJECT_RENAME_INPUT, "ShellX final owned project draft");
    outcome.invoke = "pass";
    await waitForInputNonempty(webdriver, PROJECT_RENAME_INPUT, true);
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver input changed the isolated inline project name draft without opening a folder picker or committing external state.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => cleanupOwnedProjectDraft(webdriver));
  }
  return finalize(outcome);
}

async function exerciseProjectExpansion(webdriver: WebDriver, assignment: Assignment) {
  const outcome = emptyOutcome(assignment, "No native owned-project expansion effect was observed.");
  const selector = assignment.surface.name === PROJECT_CARET_SURFACE ? PROJECT_CARET : PROJECT_MAIN;
  try {
    await prepareOwnedProjectRow(webdriver);
    await waitForProjectState(webdriver, { rowPresent: true, expanded: false, mainExpanded: false, dialogPresent: false });
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForProjectState(webdriver, { rowPresent: true, expanded: true, mainExpanded: true, dialogPresent: false });
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click expanded the exact isolated owned project through its visible row control.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => cleanupOwnedProjectMarker(webdriver));
  }
  return finalize(outcome);
}

async function exerciseProjectDeleteDialog(webdriver: WebDriver, assignment: Assignment) {
  const outcome = emptyOutcome(assignment, "No native owned-project delete-dialog effect was observed.");
  try {
    await prepareOwnedProjectRow(webdriver);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, PROJECT_DELETE);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElement(webdriver, PROJECT_DELETE_DIALOG);
    await waitForProjectState(webdriver, { rowPresent: true, expanded: false, mainExpanded: false, dialogPresent: true });
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click opened the exact isolated owned project's marker-deletion dialog without deleting any session.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => cleanupOwnedProjectMarker(webdriver));
  }
  return finalize(outcome);
}

async function exerciseProjectMarkerDelete(webdriver: WebDriver, assignment: Assignment) {
  const outcome = emptyOutcome(assignment, "No native owned-project marker deletion effect was observed.");
  try {
    await prepareOwnedProjectRow(webdriver);
    await clickSelector(webdriver, PROJECT_DELETE);
    await waitForReleaseSurfaceWebDriverElement(webdriver, PROJECT_DELETE_DIALOG);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, PROJECT_MARKER_DELETE);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, PROJECT_DELETE_DIALOG);
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, PROJECT_ROW);
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click deleted only the exact isolated empty project marker and restored the empty project list.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => cleanupOwnedProjectMarker(webdriver));
  }
  return finalize(outcome);
}

async function requireEmptyProjectList(webdriver: WebDriver): Promise<void> {
  if (await findReleaseSurfaceWebDriverElement(webdriver, PROJECT_ROW)
    || await findReleaseSurfaceWebDriverElement(webdriver, PROJECT_RENAME_INPUT)) {
    throw new Error("owned-project fixture requires the isolated project list to be empty");
  }
}

async function prepareOwnedProjectRow(webdriver: WebDriver): Promise<void> {
  await requireEmptyProjectList(webdriver);
  await clickSelector(webdriver, PROJECT_ADD);
  const input = await waitForReleaseSurfaceWebDriverElement(webdriver, PROJECT_RENAME_INPUT);
  await replaceInput(webdriver, input, PROJECT_RENAME_INPUT, "ShellX final owned project");
  await clickSelector(webdriver, LEFT_RAIL);
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, PROJECT_RENAME_INPUT);
  await waitForReleaseSurfaceWebDriverElement(webdriver, PROJECT_ROW);
  await waitForReleaseSurfaceWebDriverElement(webdriver, PROJECT_CARET);
  await waitForReleaseSurfaceWebDriverElement(webdriver, PROJECT_MAIN);
}

async function cleanupOwnedProjectDraft(webdriver: WebDriver): Promise<void> {
  const draft = await findReleaseSurfaceWebDriverElement(webdriver, PROJECT_RENAME_INPUT);
  if (draft) {
    await clearReleaseSurfaceWebDriverElement(webdriver, draft);
    await clickSelector(webdriver, LEFT_RAIL);
  }
  if (await findReleaseSurfaceWebDriverElement(webdriver, PROJECT_ROW)) {
    await cleanupOwnedProjectMarker(webdriver);
  }
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, PROJECT_RENAME_INPUT);
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, PROJECT_ROW);
}

async function cleanupOwnedProjectMarker(webdriver: WebDriver): Promise<void> {
  if (!await findReleaseSurfaceWebDriverElement(webdriver, PROJECT_ROW)) {
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, PROJECT_DELETE_DIALOG);
    return;
  }
  if (!await findReleaseSurfaceWebDriverElement(webdriver, PROJECT_DELETE_DIALOG)) {
    await clickSelector(webdriver, PROJECT_DELETE);
    await waitForReleaseSurfaceWebDriverElement(webdriver, PROJECT_DELETE_DIALOG);
  }
  await clickSelector(webdriver, PROJECT_MARKER_DELETE);
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, PROJECT_DELETE_DIALOG);
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, PROJECT_ROW);
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, PROJECT_RENAME_INPUT);
}

async function readProjectState(webdriver: WebDriver): Promise<Record<string, unknown>> {
  return record(await executeReleaseSurfaceWebDriverScript(
    webdriver,
    PROJECT_STATE_SCRIPT,
    [PROJECT_ROW, PROJECT_CARET, PROJECT_MAIN, PROJECT_DELETE_DIALOG],
  ));
}

async function waitForProjectState(
  webdriver: WebDriver,
  expected: { rowPresent: boolean; expanded: boolean; mainExpanded: boolean; dialogPresent: boolean },
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readProjectState(webdriver);
    if (state.rowPresent === expected.rowPresent
      && state.expanded === expected.expanded
      && state.mainExpanded === expected.mainExpanded
      && state.dialogPresent === expected.dialogPresent) return;
    await delay(50);
  }
  throw new Error(`owned project state did not reach ${JSON.stringify(expected)}`);
}

async function exerciseConnectionOpen(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const outcome = emptyOutcome(assignment, "No native Connection Editor open effect was observed.");
  try {
    await openSettingsTab(connection, webdriver, "connections");
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, CONNECTION_ADD);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElement(webdriver, CONNECTION_DIALOG);
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click opened one new unsaved Connection Editor draft.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupConnectionEditor(connection, webdriver, outcome);
  }
  return finalize(outcome);
}

async function exerciseConnectionPickerOpen(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const outcome = emptyOutcome(assignment, "No native composer Connection Editor open effect was observed.");
  try {
    const owner = await waitForReleaseSurfaceWebDriverElement(webdriver, COMPOSER_CONNECTION);
    await clickReleaseSurfaceWebDriverElement(webdriver, owner);
    await waitForReleaseSurfaceWebDriverElement(webdriver, CONNECTION_PICKER_DIALOG);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, CONNECTION_PICKER_ADD);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, CONNECTION_PICKER_DIALOG);
    await waitForReleaseSurfaceWebDriverElement(webdriver, CONNECTION_DIALOG);
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver clicks opened one new unsaved Connection Editor draft from the composer picker.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupConnectionEditor(connection, webdriver, outcome);
  }
  return finalize(outcome);
}

async function exerciseConnectionClose(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const outcome = emptyOutcome(assignment, "No native Connection Editor close effect was observed.");
  const selector = CONNECTION_CLOSE_CONTROLS[assignment.surface.name as keyof typeof CONNECTION_CLOSE_CONTROLS];
  try {
    await openConnectionEditor(connection, webdriver);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, CONNECTION_DIALOG);
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click closed the unsaved Connection Editor without invoking Save.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupConnectionEditor(connection, webdriver, outcome);
  }
  return finalize(outcome);
}

async function exerciseConnectionText(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const config = CONNECTION_TEXT_CONTROLS[assignment.surface.name as keyof typeof CONNECTION_TEXT_CONTROLS];
  const outcome = emptyOutcome(assignment, "No native Connection Editor draft text effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  try {
    await openConnectionEditor(connection, webdriver);
    await prepareConnectionPrecondition(webdriver, config.precondition);
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    await replaceDeclaredInput(webdriver, control, config.control, "");
    outcome.present = "pass";
    await setReleaseSurfaceWebDriverElementValue(webdriver, control, config.value);
    outcome.invoke = "pass";
    await waitForDeclaredInputValue(webdriver, config.control, config.value);
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver input changed only the unsaved ${config.label} draft.`;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (control) await cleanupStep(outcome, async () => replaceDeclaredInput(webdriver, control!, config.control, ""));
    await cleanupConnectionEditor(connection, webdriver, outcome);
  }
  return finalize(outcome);
}

async function exerciseConnectionChoice(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const outcome = emptyOutcome(assignment, "No native Connection Editor choice effect was observed.");
  try {
    await openConnectionEditor(connection, webdriver);
    const transport = CONNECTION_TRANSPORT_CONTROLS[assignment.surface.name as keyof typeof CONNECTION_TRANSPORT_CONTROLS];
    if (transport) {
      await clickSelector(webdriver, transport.setup);
      await waitForChoice(webdriver, transport.setup, { checked: true });
      const control = await waitForReleaseSurfaceWebDriverElement(webdriver, transport.control);
      outcome.present = "pass";
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForChoice(webdriver, transport.control, { checked: true });
      outcome.effect = "pass";
      outcome.observedEffect = `A native WebDriver click selected ${transport.target.toUpperCase()} only in the unsaved Connection Editor draft.`;
    } else {
      await clickSelector(webdriver, CONNECTION_SSH);
      const control = await waitForReleaseSurfaceWebDriverElement(webdriver, CONNECTION_RUNTIME);
      outcome.present = "pass";
      await setReleaseSurfaceWebDriverElementValue(webdriver, control, "Windows OpenSSH, run Windows agents");
      outcome.invoke = "pass";
      await waitForChoice(webdriver, CONNECTION_RUNTIME, { value: "windows" });
      outcome.effect = "pass";
      outcome.observedEffect = "Native WebDriver selection changed only the unsaved SSH remote-runtime choice.";
    }
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      const runtime = await visibleElement(webdriver, CONNECTION_RUNTIME);
      if (runtime) {
        await setReleaseSurfaceWebDriverElementValue(webdriver, runtime, "Linux, macOS, or WSL SSH server");
        await waitForChoice(webdriver, CONNECTION_RUNTIME, { value: "posix" });
      }
      const local = await visibleElement(webdriver, CONNECTION_LOCAL);
      if (local) {
        await clickReleaseSurfaceWebDriverElement(webdriver, local);
        await waitForChoice(webdriver, CONNECTION_LOCAL, { checked: true });
      }
    });
    await cleanupConnectionEditor(connection, webdriver, outcome);
  }
  return finalize(outcome);
}

async function exerciseConnectionSshKey(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const outcome = emptyOutcome(assignment, "No native WebDriver Connection Vault-key selection effect was observed.");
  let seeded = false;
  let vaultBaseline = "";
  let connectionsBaseline = "";
  try {
    vaultBaseline = await apiText(connection, "GET", "/vault/keys?prefix=connections.");
    connectionsBaseline = await apiText(connection, "GET", "/connections");
    if (vaultDirectoryHasKey(vaultBaseline, OWNED_CONNECTION_VAULT_KEY)) {
      throw new Error("owned Connection Vault-key fixture already exists");
    }
    await apiJson(connection, "POST", "/vault/set", {
      key: OWNED_CONNECTION_VAULT_KEY,
      value: OWNED_CONNECTION_VAULT_VALUE,
    });
    seeded = true;
    if (!vaultDirectoryHasKey(
      await apiText(connection, "GET", "/vault/keys?prefix=connections."),
      OWNED_CONNECTION_VAULT_KEY,
    )) throw new Error("owned Connection Vault-key fixture was not created");

    await openConnectionEditor(connection, webdriver);
    await clickSelector(webdriver, CONNECTION_SSH);
    await waitForChoice(webdriver, CONNECTION_SSH, { checked: true });
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `${CONNECTION_SSH_KEY} option[value='${OWNED_CONNECTION_VAULT_KEY}']`,
    );
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, CONNECTION_SSH_KEY);
    outcome.present = "pass";
    await setReleaseSurfaceWebDriverElementValue(webdriver, control, OWNED_CONNECTION_VAULT_KEY);
    outcome.invoke = "pass";
    await waitForChoice(webdriver, CONNECTION_SSH_KEY, { value: OWNED_CONNECTION_VAULT_KEY });
    if (await apiText(connection, "GET", "/connections") !== connectionsBaseline) {
      throw new Error("unsaved SSH Vault-key selection changed the connection directory");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver selected one exact redacted key reference from an isolated Vault-backed SSH draft without revealing its value or saving a connection.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      const keySelect = await visibleElement(webdriver, CONNECTION_SSH_KEY);
      if (keySelect) {
        await setReleaseSurfaceWebDriverElementValue(webdriver, keySelect, "(use ssh-agent / ssh-config default)");
        await waitForChoice(webdriver, CONNECTION_SSH_KEY, { value: "" });
      }
    });
    await cleanupConnectionEditor(connection, webdriver, outcome);
    await cleanupStep(outcome, async () => {
      if (seeded) await apiJson(connection, "POST", "/vault/delete", { key: OWNED_CONNECTION_VAULT_KEY });
      if (vaultBaseline && await apiText(connection, "GET", "/vault/keys?prefix=connections.") !== vaultBaseline) {
        throw new Error("Connection Vault-key cleanup did not restore the redacted directory byte-for-byte");
      }
      if (connectionsBaseline && await apiText(connection, "GET", "/connections") !== connectionsBaseline) {
        throw new Error("Connection Vault-key cleanup did not preserve the connection directory byte-for-byte");
      }
    });
  }
  return finalize(outcome);
}

async function exerciseGeneralChoice(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const config = GENERAL_SETTING_CHOICES[assignment.surface.name]!;
  const outcome = emptyOutcome(assignment, "No native General setting choice effect was observed.");
  let baseline: PublicSettings | null = null;
  try {
    await openSettingsTab(connection, webdriver, "general");
    baseline = await readPublicSettings(connection);
    const original = baseline[config.key];
    if (original === config.target) {
      const alternate = alternateGeneralSetting(config.key, config.target);
      await clickSelector(webdriver, generalSettingSelector(config.key, alternate));
      await waitForPublicSetting(connection, config.key, alternate);
    }
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForPublicSetting(connection, config.key, config.target);
    await waitForGeneralControlState(webdriver, config.control, { pressed: true });
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click changed persisted ${config.key} to ${config.target}.`;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (baseline) await cleanupStep(outcome, async () => {
      const original = baseline![config.key];
      if ((await readPublicSettings(connection))[config.key] !== original) {
        await clickSelector(webdriver, generalSettingSelector(config.key, original));
      }
      await waitForPublicSetting(connection, config.key, original);
    });
    await cleanupSettings(connection, webdriver, outcome);
  }
  return finalize(outcome);
}

async function exerciseGeneralFont(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const reset = assignment.surface.name === GENERAL_FONT_RESET_SURFACE;
  const outcome = emptyOutcome(assignment, "No native General font setting effect was observed.");
  let baseline: PublicSettings | null = null;
  try {
    await openSettingsTab(connection, webdriver, "general");
    baseline = await readPublicSettings(connection);
    const range = await waitForReleaseSurfaceWebDriverElement(webdriver, GENERAL_FONT_RANGE);
    if (reset) {
      const prepared = baseline.chatFontPx === GENERAL_FONT_DEFAULT ? GENERAL_FONT_DEFAULT + 1 : GENERAL_FONT_DEFAULT;
      await setReleaseSurfaceWebDriverElementValue(webdriver, range, String(prepared));
      await waitForPublicSetting(connection, "chatFontPx", prepared);
      const control = await waitForReleaseSurfaceWebDriverElement(webdriver, GENERAL_FONT_RESET);
      outcome.present = "pass";
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForPublicSetting(connection, "chatFontPx", GENERAL_FONT_DEFAULT);
      outcome.observedEffect = "A native WebDriver click reset the prepared chat font size to its product default.";
    } else {
      const target = baseline.chatFontPx >= 26 ? baseline.chatFontPx - 1 : baseline.chatFontPx + 1;
      outcome.present = "pass";
      await setReleaseSurfaceWebDriverElementValue(webdriver, range, String(target));
      outcome.invoke = "pass";
      await waitForPublicSetting(connection, "chatFontPx", target);
      await waitForGeneralControlState(webdriver, GENERAL_FONT_RANGE, { value: String(target) });
      outcome.observedEffect = "Native WebDriver range input changed the persisted chat font size.";
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (baseline) await cleanupStep(outcome, async () => {
      const range = await waitForReleaseSurfaceWebDriverElement(webdriver, GENERAL_FONT_RANGE);
      await setReleaseSurfaceWebDriverElementValue(webdriver, range, String(baseline!.chatFontPx));
      await waitForPublicSetting(connection, "chatFontPx", baseline!.chatFontPx);
    });
    await cleanupSettings(connection, webdriver, outcome);
  }
  return finalize(outcome);
}

async function exerciseDataDeleteDialog(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const cancel = assignment.surface.name === DATA_DELETE_CANCEL_SURFACE;
  const outcome = emptyOutcome(assignment, "No native Data deletion confirmation-dialog effect was observed.");
  try {
    await openSettingsTab(connection, webdriver, "data");
    const open = await waitForReleaseSurfaceWebDriverElement(webdriver, DATA_DELETE_OPEN);
    if (!cancel) outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, open);
    await waitForReleaseSurfaceWebDriverElement(webdriver, DATA_DELETE_DIALOG);
    if (cancel) {
      const control = await waitForReleaseSurfaceWebDriverElement(webdriver, DATA_DELETE_CANCEL);
      outcome.present = "pass";
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, DATA_DELETE_DIALOG);
      outcome.observedEffect = "A native WebDriver click cancelled the renderer-owned Data deletion confirmation without deleting local or on-disk user data.";
    } else {
      outcome.invoke = "pass";
      outcome.observedEffect = "A native WebDriver click opened the renderer-owned Data deletion confirmation without deleting local or on-disk user data.";
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      const close = await visibleElement(webdriver, DATA_DELETE_CANCEL);
      if (close) await clickReleaseSurfaceWebDriverElement(webdriver, close);
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, DATA_DELETE_DIALOG);
    });
    await cleanupSettings(connection, webdriver, outcome);
  }
  return finalize(outcome);
}

async function exerciseDataDeleteConfirm(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const outcome = emptyOutcome(assignment, "No native WebDriver isolated Data deletion effect was observed.");
  const relay = new ReleaseSurfaceTauriInvokeSession(connection);
  let prepared = false;
  try {
    const baseline = record(await relay.invoke("read_user_data", {}));
    if (Object.keys(baseline).length !== 0) {
      throw new Error("isolated Data deletion fixture requires an empty user-data baseline");
    }
    await relay.invoke("write_user_data", {
      data: {
        [OWNED_USER_DATA_KEY]: [{ id: "shellx-release-owned-project" }],
        [PRESERVED_USER_DATA_KEY]: { "shellx-release-owned-session": "Preserved title" },
      },
    });
    prepared = true;
    await openSettingsTab(connection, webdriver, "data");
    const open = await waitForReleaseSurfaceWebDriverElement(webdriver, DATA_DELETE_OPEN);
    await clickReleaseSurfaceWebDriverElement(webdriver, open);
    await waitForReleaseSurfaceWebDriverElement(webdriver, DATA_DELETE_DIALOG);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, DATA_DELETE_CONFIRM);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, DATA_DELETE_DIALOG);
    await waitForDataDeleteReceipt(webdriver);
    const after = record(await relay.invoke("read_user_data", {}));
    if (Object.hasOwn(after, OWNED_USER_DATA_KEY)
      || JSON.stringify(after) !== JSON.stringify({
        [PRESERVED_USER_DATA_KEY]: { "shellx-release-owned-session": "Preserved title" },
      })) {
      throw new Error("Data deletion did not remove only the exact owned section");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver confirmed deletion of one exact isolated user-data section, observed disk and localStorage cleanup, and preserved its sibling section.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      const cancel = await visibleElement(webdriver, DATA_DELETE_CANCEL);
      if (cancel) await clickReleaseSurfaceWebDriverElement(webdriver, cancel);
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, DATA_DELETE_DIALOG);
    });
    await cleanupSettings(connection, webdriver, outcome);
    await cleanupStep(outcome, async () => {
      if (prepared) await relay.invoke("write_user_data", { data: {} });
      if (Object.keys(record(await relay.invoke("read_user_data", {}))).length !== 0) {
        throw new Error("Data deletion cleanup did not restore the empty user-data baseline");
      }
      await relay.cleanup();
    });
  }
  return finalize(outcome);
}

async function waitForDataDeleteReceipt(webdriver: WebDriver): Promise<void> {
  const deadline = Date.now() + 8_000;
  let last: string | undefined;
  while (Date.now() < deadline) {
    const receipt = await observeReleaseSurfaceInstalledInputElement(webdriver, DATA_DELETE_RECEIPT, ["title"]);
    last = receipt.title;
    if (receipt.present && receipt.visible
      && last === `Data delete · key=${OWNED_USER_DATA_KEY} · diskRemoved=true · localStorageCleared=true`) return;
    await delay(50);
  }
  throw new Error(`Data deletion did not publish its exact bounded receipt: ${last ?? "missing"}`);
}

async function exerciseBuiltinDoc(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const outcome = emptyOutcome(assignment, "No native bundled-document modal effect was observed.");
  const openConfig = BUILTIN_DOC_CONTROLS[assignment.surface.name as keyof typeof BUILTIN_DOC_CONTROLS];
  const config = openConfig ?? BUILTIN_DOC_CONTROLS["src/components/settings/AboutTab.tsx:[title=\"Read the shellX features overview\"]"];
  try {
    await openSettingsTab(connection, webdriver, "about");
    if (!openConfig) {
      await clickSelector(webdriver, config.control);
      await waitForReleaseSurfaceWebDriverElement(webdriver, config.dialog);
      const close = await waitForReleaseSurfaceWebDriverElement(webdriver, `${config.dialog} [aria-label='Close (Esc)']`);
      outcome.present = "pass";
      await clickReleaseSurfaceWebDriverElement(webdriver, close);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, config.dialog);
      outcome.observedEffect = "A native WebDriver click closed the prepared bundled-document dialog.";
    } else {
      const control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
      outcome.present = "pass";
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceWebDriverElement(webdriver, config.dialog);
      outcome.observedEffect = `A native WebDriver click opened the bundled ${config.label} dialog without a network or filesystem action.`;
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      const close = await visibleElement(webdriver, `${config.dialog} [aria-label='Close (Esc)']`);
      if (close) await clickReleaseSurfaceWebDriverElement(webdriver, close);
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, config.dialog);
    });
    await cleanupSettings(connection, webdriver, outcome);
  }
  return finalize(outcome);
}

async function exerciseLazySurfaceRecovery(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
) {
  const retry = assignment.surface.name === LAZY_SURFACE_RETRY;
  const controlSelector = `${LAZY_SURFACE_ALERT} button:${retry ? "first" : "last"}-of-type`;
  const outcome = emptyOutcome(assignment, "No scoped LazySurface recovery effect was observed.");
  try {
    await postUi(connection, { releaseTestLazySurface: "owned-error" });
    await waitForReleaseSurfaceWebDriverElement(webdriver, LAZY_SURFACE_ALERT);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, controlSelector);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, LAZY_SURFACE_ALERT);
    if (retry) {
      await waitForReleaseSurfaceWebDriverElement(webdriver, LAZY_SURFACE_RECOVERED);
      outcome.observedEffect = "A native WebDriver click retried the scoped failure and rendered its owned recovered state.";
    } else {
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, LAZY_SURFACE_RECOVERED);
      outcome.observedEffect = "A native WebDriver click dismissed the scoped failure without replacing the workspace.";
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      await postUi(connection, { releaseTestLazySurface: "clear" });
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, LAZY_SURFACE_ALERT);
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, LAZY_SURFACE_RECOVERED);
    });
  }
  return finalize(outcome);
}

async function exerciseAboutExternalLink(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const config = ABOUT_EXTERNAL_CONTROLS[assignment.surface.name as keyof typeof ABOUT_EXTERNAL_CONTROLS];
  const outcome = emptyOutcome(assignment, "No native About external-link dispatch was observed.");
  try {
    await openSettingsTab(connection, webdriver, "about");
    const baseline = await readExternalUrlDispatches(connection);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    const observed = await waitForAboutExternalUrl(connection, baseline.length, config.url);
    if (observed.length !== baseline.length + 1) {
      throw new Error("About external-link dispatch emitted more than one URL");
    }
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click dispatched the exact ${config.label} URL through the bounded external-browser handoff.`;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupSettings(connection, webdriver, outcome);
  }
  return finalize(outcome);
}

async function readExternalUrlDispatches(connection: Connection): Promise<string[]> {
  const events = await apiJson<unknown>(connection, "GET", "/events/recent?limit=64");
  if (!Array.isArray(events)) throw new Error("recent event response is not an array");
  return events.flatMap((event) => {
    if (!event || typeof event !== "object") return [];
    const row = event as { kind?: unknown; payload?: unknown };
    if (row.kind !== "external-url-dispatched" || !row.payload || typeof row.payload !== "object") return [];
    const url = (row.payload as { url?: unknown }).url;
    return typeof url === "string" ? [url] : [];
  });
}

async function waitForAboutExternalUrl(connection: Connection, baselineLength: number, expectedUrl: string): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const urls = await readExternalUrlDispatches(connection);
    if (urls.length > baselineLength && urls.at(-1) === expectedUrl) return urls;
    await delay(50);
  }
  throw new Error(`About external-link dispatch did not emit ${expectedUrl}`);
}

async function exerciseLocalDisclosure(connection: Connection, webdriver: WebDriver, assignment: Assignment) {
  const config = LOCAL_DISCLOSURES[assignment.surface.name as keyof typeof LOCAL_DISCLOSURES];
  const plugins = config.owner === "plugins";
  const selector = config.selector;
  const outcome = emptyOutcome(assignment, "No native local disclosure effect was observed.");
  let baseline: boolean | null = null;
  try {
    if (plugins) {
      await clickSelector(webdriver, PLUGINS_OPEN);
      await waitForReleaseSurfaceWebDriverElement(webdriver, PLUGINS_DIALOG);
    }
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
    baseline = await readDisclosureState(webdriver, selector);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForDisclosureState(webdriver, selector, !baseline);
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click changed the ${config.label} disclosure state.`;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (baseline !== null) await cleanupStep(outcome, async () => {
      if (await readDisclosureState(webdriver, selector) !== baseline) await clickSelector(webdriver, selector);
      await waitForDisclosureState(webdriver, selector, baseline!);
    });
    if (plugins) await cleanupStep(outcome, async () => {
      const close = await visibleElement(webdriver, PLUGINS_CLOSE);
      if (close) await clickReleaseSurfaceWebDriverElement(webdriver, close);
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, PLUGINS_DIALOG);
    });
    if (outcome.cleanup !== "fail") outcome.cleanup = "pass";
  }
  return finalize(outcome);
}

async function openConnectionEditor(connection: Connection, webdriver: WebDriver): Promise<void> {
  await openSettingsTab(connection, webdriver, "connections");
  await clickSelector(webdriver, CONNECTION_ADD);
  await waitForReleaseSurfaceWebDriverElement(webdriver, CONNECTION_DIALOG);
}

async function openSettingsTab(
  connection: Connection,
  webdriver: WebDriver,
  tab: "connections" | "general" | "about" | "connectors" | "data",
): Promise<void> {
  await postUi(connection, { openModal: "settings", source: `final-surface-safe-${tab}` });
  await waitForReleaseSurfaceWebDriverElement(webdriver, SETTINGS_DIALOG);
  const selector = {
    connections: SETTINGS_CONNECTIONS_TAB,
    general: SETTINGS_GENERAL_TAB,
    about: SETTINGS_ABOUT_TAB,
    connectors: SETTINGS_CONNECTORS_TAB,
    data: SETTINGS_DATA_TAB,
  }[tab];
  await clickSelector(webdriver, selector);
  await waitForReleaseSurfaceWebDriverElement(webdriver, `${selector}[aria-selected='true']`);
  await waitForReleaseSurfaceWebDriverElement(webdriver, `#settings-tab-panel[aria-labelledby='settings-tab-${tab}']`);
}

async function openConnectorDraft(connection: Connection, webdriver: WebDriver): Promise<void> {
  await openSettingsTab(connection, webdriver, "connectors");
  const state = await readConnectorState(webdriver);
  if (!state.draftOpen) await clickSelector(webdriver, CONNECTOR_NEW);
  await waitForConnectorState(webdriver, connectorDraftBaseline(true));
}

type SettingsTabId = "general" | "vault" | "connections" | "connectors" | "desktop" | "shellxagent" | "data" | "about";

async function readSettingsTab(connection: Connection): Promise<SettingsTabId> {
  const state = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
  const tab = String(state.settingsTab ?? "");
  if (!["general", "vault", "connections", "connectors", "desktop", "shellxagent", "data", "about"].includes(tab)) {
    throw new Error("public UI state did not expose a supported Settings tab");
  }
  return tab as SettingsTabId;
}

type ConnectorDraftState = {
  draftOpen: boolean;
  providerKind: string | null;
  enabled: boolean | null;
  dispatchMode: string | null;
  targetMode: string | null;
};

async function readConnectorState(webdriver: WebDriver): Promise<ConnectorDraftState> {
  const [telegram, discord, paused, live, inbox, session, target] = await Promise.all([
    observeReleaseSurfaceInstalledInputElement(webdriver, CONNECTOR_PROVIDER_TELEGRAM, ["selected"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, CONNECTOR_PROVIDER_DISCORD, ["selected"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, "[aria-label='Connector receiver state'] > button:first-child", ["pressed"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, "[aria-label='Connector receiver state'] > button:last-child", ["pressed"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, "[aria-label='Connector delivery mode'] > button:first-child", ["pressed"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, "[aria-label='Connector delivery mode'] > button:last-child", ["pressed"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, CONNECTOR_TARGET, ["value"]),
  ]);
  const observations = [telegram, discord, paused, live, inbox, session, target];
  const open = observations.every((observation) => observation.present && observation.visible);
  const closed = observations.every((observation) => !observation.present);
  const state: ConnectorDraftState = {
    draftOpen: open,
    providerKind: open ? (telegram.selected ? "telegram" : discord.selected ? "discord" : null) : null,
    enabled: open ? (live.pressed ? true : paused.pressed ? false : null) : null,
    dispatchMode: open ? (session.pressed ? "autoPrompt" : inbox.pressed ? "inbox" : null) : null,
    targetMode: open && typeof target.value === "string" ? target.value : null,
  };
  const validOpen = open
    && ["telegram", "discord"].includes(String(state.providerKind))
    && typeof state.enabled === "boolean"
    && ["inbox", "autoPrompt"].includes(String(state.dispatchMode))
    && ["activeTab", "fixedTab"].includes(String(state.targetMode));
  const validClosed = closed
    && state.providerKind === null
    && state.enabled === null
    && state.dispatchMode === null
    && state.targetMode === null;
  if (!validOpen && !validClosed) {
    throw new Error("Connectors unsaved draft did not expose its exact bounded state");
  }
  return state;
}

function connectorDraftBaseline(open: boolean): ConnectorDraftState {
  return open
    ? {
        draftOpen: true,
        providerKind: "telegram",
        enabled: false,
        dispatchMode: "inbox",
        targetMode: "activeTab",
      }
    : {
        draftOpen: false,
        providerKind: null,
        enabled: null,
        dispatchMode: null,
        targetMode: null,
      };
}

async function waitForConnectorState(
  webdriver: WebDriver,
  expected: Partial<ConnectorDraftState>,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readConnectorState(webdriver);
    if (Object.entries(expected).every(([key, value]) => state[key as keyof ConnectorDraftState] === value)) return;
    await delay(50);
  }
  throw new Error(`Connectors unsaved draft did not reach ${JSON.stringify(expected)}`);
}

type ToolExposureUiState = {
  rightTab: "Tasks" | "Tooling" | "Git" | "Preview" | "Plan" | "Files";
  exposure: ShellxToolExposureMode;
};

async function readToolExposureUiState(connection: Connection): Promise<ToolExposureUiState> {
  const state = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
  const rightTab = String(state.rightTab ?? "");
  const activeTab = record(state.activeTab);
  const exposure = String(activeTab.shellxToolExposure ?? "");
  if (!["Tasks", "Tooling", "Git", "Preview", "Plan", "Files"].includes(rightTab)
    || !SHELLX_TOOL_EXPOSURE_MODES.includes(exposure as ShellxToolExposureMode)) {
    throw new Error("public UI state omitted the exact per-tab ShellX tool-exposure state");
  }
  return {
    rightTab: rightTab as ToolExposureUiState["rightTab"],
    exposure: exposure as ShellxToolExposureMode,
  };
}

async function waitForToolExposure(
  webdriver: WebDriver,
  connection: Connection,
  expected: ShellxToolExposureMode,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readToolExposureUiState(connection);
    const observed = await observeReleaseSurfaceInstalledInputElement(
      webdriver,
      shellxToolExposureSelector(expected),
      ["pressed"],
    );
    if (state.exposure === expected && observed.present && observed.visible && observed.pressed === true) return;
    await delay(50);
  }
  throw new Error(`per-tab ShellX tool exposure did not reach ${expected}`);
}

function shellxToolExposureSelector(mode: ShellxToolExposureMode): string {
  return `[data-debug-id='surface-components-rightrail-2'][data-shellx-tool-exposure='${mode}']`;
}

async function prepareConnectionPrecondition(webdriver: WebDriver, precondition: string): Promise<void> {
  if (precondition === "local") return;
  await clickSelector(webdriver, precondition === "wsl" ? CONNECTION_WSL : CONNECTION_SSH);
  if (precondition === "ssh-wsl") {
    const runtime = await waitForReleaseSurfaceWebDriverElement(webdriver, CONNECTION_RUNTIME);
    await setReleaseSurfaceWebDriverElementValue(webdriver, runtime, "Windows OpenSSH, run agents in WSL");
    await waitForChoice(webdriver, CONNECTION_RUNTIME, { value: "windows_wsl" });
  }
}

async function cleanupConnectionEditor(connection: Connection, webdriver: WebDriver, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  await cleanupStep(outcome, async () => {
    const cancel = await visibleElement(webdriver, CONNECTION_CANCEL);
    if (cancel) await clickReleaseSurfaceWebDriverElement(webdriver, cancel);
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, CONNECTION_DIALOG);
  });
  await cleanupSettings(connection, webdriver, outcome);
}

async function cleanupSettings(connection: Connection, webdriver: WebDriver, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  await cleanupStep(outcome, async () => {
    await postUi(connection, { openModal: "close", source: "final-surface-safe-cleanup" });
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, SETTINGS_DIALOG);
  });
  if (!outcome.error?.includes("cleanup:")) outcome.cleanup = "pass";
}

async function cleanupConnectorSettings(
  connection: Connection,
  webdriver: WebDriver,
  outcome: ReleaseSurfaceDriverOutcome,
  baselineTab: SettingsTabId | null,
): Promise<void> {
  await cleanupStep(outcome, async () => {
    if (await visibleElement(webdriver, CONNECTOR_CANCEL)) {
      await clickSelector(webdriver, CONNECTOR_CANCEL);
    }
    await waitForConnectorState(webdriver, connectorDraftBaseline(false));
  });
  if (baselineTab) await cleanupStep(outcome, async () => {
    if (await visibleElement(webdriver, SETTINGS_DIALOG)) {
      const selector = `[data-debug-id='settings-tab-${baselineTab}']`;
      if ((await readSettingsTab(connection)) !== baselineTab) await clickSelector(webdriver, selector);
      await waitForReleaseSurfaceWebDriverElement(webdriver, `${selector}[aria-selected='true']`);
    }
  });
  await cleanupSettings(connection, webdriver, outcome);
}

async function replaceInput(
  webdriver: WebDriver,
  control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>>,
  selector: string,
  value: string,
): Promise<void> {
  await clearReleaseSurfaceWebDriverElement(webdriver, control);
  await waitForInputNonempty(webdriver, selector, false);
  if (value) await setReleaseSurfaceWebDriverElementValue(webdriver, control, value);
  await waitForInputNonempty(webdriver, selector, value.length > 0);
}

async function waitForInputNonempty(webdriver: WebDriver, selector: string, expected: boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["nonempty"]);
    if (state.nonempty === expected) return;
    await delay(50);
  }
  throw new Error(`owned draft input nonempty state did not reach ${expected}`);
}

async function waitForChoice(
  webdriver: WebDriver,
  selector: string,
  expected: { checked?: boolean; value?: string },
): Promise<void> {
  const deadline = Date.now() + 5_000;
  const fields = expected.checked === undefined ? ["value"] as const : ["checked"] as const;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, fields);
    if ((expected.checked === undefined || state.checked === expected.checked)
      && (expected.value === undefined || state.value === expected.value)) return;
    await delay(50);
  }
  throw new Error(`owned choice ${selector} did not reach ${JSON.stringify(expected)}`);
}

async function replaceDeclaredInput(
  webdriver: WebDriver,
  control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>>,
  selector: string,
  value: string,
): Promise<void> {
  await clearReleaseSurfaceWebDriverElement(webdriver, control);
  await waitForDeclaredInputValue(webdriver, selector, "");
  if (value) await setReleaseSurfaceWebDriverElementValue(webdriver, control, value);
  await waitForDeclaredInputValue(webdriver, selector, value);
}

async function waitForDeclaredInputValue(webdriver: WebDriver, selector: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["value"]);
    if (state.value === expected) return;
    await delay(50);
  }
  throw new Error(`declared draft input did not reach expected length ${expected.length}`);
}

type PublicSettings = {
  browserDownloadFolder: string;
  chatFontPx: number;
  density: string;
  githubGhBinary: string;
  permissionUx: string;
  theme: string;
};

async function readPublicSettings(connection: Connection): Promise<PublicSettings> {
  const body = await apiJson<Record<string, unknown>>(connection, "GET", "/settings");
  if (typeof body.browserDownloadFolder !== "string" || !Number.isSafeInteger(body.chatFontPx)
    || !["compact", "default", "comfortable"].includes(String(body.density))
    || !["gh", "gh.exe"].includes(String(body.githubGhBinary))
    || !["pill", "modal", "both"].includes(String(body.permissionUx))
    || !["black", "black_warm", "bright"].includes(String(body.theme))) {
    throw new Error("public Settings payload did not match its normalized schema");
  }
  return body as PublicSettings;
}

async function waitForPublicSetting(
  connection: Connection,
  key: GeneralSettingKey | "chatFontPx",
  expected: string | number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await readPublicSettings(connection))[key] === expected) return;
    await delay(50);
  }
  throw new Error(`public setting ${key} did not reach ${String(expected)}`);
}

async function waitForGeneralControlState(
  webdriver: WebDriver,
  selector: string,
  expected: { pressed?: boolean; value?: string },
): Promise<void> {
  const deadline = Date.now() + 5_000;
  const fields = expected.pressed === undefined ? ["value"] as const : ["pressed"] as const;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, fields);
    if ((expected.pressed === undefined || state.pressed === expected.pressed)
      && (expected.value === undefined || state.value === expected.value)) return;
    await delay(50);
  }
  throw new Error(`General setting control ${selector} did not reach ${JSON.stringify(expected)}`);
}

function generalSettingSelector(key: GeneralSettingKey, value: string): string {
  if (key === "density") return `[data-debug-id='settings-density-${value}']`;
  const themes: Record<string, string> = {
    black: "[aria-label='Use Black theme']",
    black_warm: "[aria-label='Use Black and warm theme']",
    bright: "[aria-label='Use Bright theme']",
  };
  const selector = themes[value];
  if (!selector) throw new Error(`unsupported theme baseline ${value}`);
  return selector;
}

function alternateGeneralSetting(key: GeneralSettingKey, current: string): string {
  const values = key === "density"
    ? ["compact", "default", "comfortable"]
    : ["black", "black_warm", "bright"];
  const alternate = values.find((value) => value !== current);
  if (!alternate) throw new Error(`no alternate ${key} setting exists`);
  return alternate;
}

async function readDisclosureState(webdriver: WebDriver, selector: string): Promise<boolean> {
  const state = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["expanded"]);
  if (typeof state.expanded !== "boolean") throw new Error(`disclosure ${selector} did not expose aria-expanded`);
  return state.expanded;
}

async function waitForDisclosureState(webdriver: WebDriver, selector: string, expected: boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readDisclosureState(webdriver, selector) === expected) return;
    await delay(50);
  }
  throw new Error(`disclosure ${selector} did not reach expanded=${expected}`);
}

async function clickSelector(webdriver: WebDriver, selector: string): Promise<void> {
  await clickReleaseSurfaceWebDriverElement(webdriver, await waitForReleaseSurfaceWebDriverElement(webdriver, selector));
}

async function visibleElement(webdriver: WebDriver, selector: string) {
  try {
    return await waitForReleaseSurfaceWebDriverElement(webdriver, selector, { timeoutMs: 250, pollMs: 50 });
  } catch {
    return null;
  }
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", body);
}

async function apiJson<T>(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers = new Headers({ Authorization: `Bearer ${connection.token}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function apiText(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<string> {
  const headers = new Headers({ Authorization: `Bearer ${connection.token}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text}`);
  return text;
}

function vaultDirectoryHasKey(value: string, key: string): boolean {
  const parsed = JSON.parse(value) as { keys?: unknown };
  return Array.isArray(parsed.keys) && parsed.keys.includes(key);
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

async function cleanupStep(outcome: ReleaseSurfaceDriverOutcome, action: () => Promise<void>): Promise<void> {
  try {
    await action();
    if (!outcome.error?.includes("cleanup:")) outcome.cleanup = "pass";
  } catch (error) {
    const detail = errorText(error);
    outcome.cleanup = "fail";
    outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
  }
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "safe UI control family did not satisfy every required verdict";
  }
  return outcome;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WebDriver state must be an object");
  return value as Record<string, unknown>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
