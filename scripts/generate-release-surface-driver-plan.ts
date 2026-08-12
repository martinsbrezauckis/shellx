import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ReleaseSurfaceInventory,
  ReleaseSurfaceItem,
  ReleaseSurfaceKind,
  ReleaseUiInteractionFamily,
} from "./lib/release-surface-inventory";
import {
  FINAL_SURFACE_DRIVER_PLAN_SCHEMA,
  type FinalSurfaceDriverAssignment,
  type FinalSurfaceDriverDefinition,
  type FinalSurfaceDriverPlan,
} from "./lib/release-surface-driver-plan";
import { textContentMatches } from "./lib/text-content";
import {
  RELEASE_UI_DEBUG_ORACLE_ID,
  releaseUiDebugCleanupIdForFixture,
  releaseUiDebugSurfaceCohort,
} from "./lib/release-ui-debug-surface-cohorts";
import {
  UI_CONTROL_BOUNDED_INSTALLED_DRIVER_ID,
  UI_CONTROL_BOUNDED_INSTALLED_SURFACE_NAMES,
} from "./release-drivers/ui-control-bounded-installed-assignments";
import {
  BROWSER_TEACH_CONTROL_DRIVER_ID,
  BROWSER_TEACH_CONTROL_SURFACE_IDS,
  BROWSER_TEACH_DEBUG_ASSIGNMENT_IDS,
  BROWSER_TEACH_DEBUG_DRIVER_ID,
  BROWSER_TEACH_INSTALLED_CLEANUP,
  BROWSER_TEACH_INSTALLED_CONTROL_ORACLES,
  BROWSER_TEACH_INSTALLED_DEBUG_ORACLE,
  BROWSER_TEACH_INSTALLED_FIXTURE,
} from "./release-drivers/ui-browser-teach-review-installed-assignments";

const BACKLOG_SUFFIX = "-backlog-installed";
const BROWSER_SHIELDS_UI_DRIVER_ID = "ui-control-browser-shields-installed";
const KEYBOARD_NATIVE_PICKER_DRIVER_ID = "keyboard-shortcut-native-picker-installed";
const PALETTE_NATIVE_PICKER_DRIVER_ID = "palette-action-native-picker-installed";
const PALETTE_PROVIDER_ACTION_DRIVER_ID = "palette-action-provider-action-installed";
const UI_NATIVE_PICKER_DRIVER_ID = "ui-control-native-picker-lifecycle-installed";
const APP_FOLDER_SURFACE_ID =
  'ui-control:src/components/BottomPanel.tsx:[data-debug-id="composer-folder"]@src/components/BottomPanel.tsx#21';
const SETTINGS_NATIVE_PICKER_SURFACE_ID =
  'ui-control:src/components/settings/GeneralTab.tsx:[data-debug-id="settings-browser-download-folder-choose"]@src/components/settings/GeneralTab.tsx#8';
const BROWSER_NATIVE_PICKER_SURFACE_ID =
  'ui-control:src/browser/components/DownloadSidecar.tsx:[data-debug-id="shellx-browser-download-folder-choose"]@src/browser/components/DownloadSidecar.tsx#3';
const VAULT_KEYFILE_SELECT_NATIVE_PICKER_SURFACE_ID =
  'ui-control:src/components/settings/VaultSetupPanel.tsx:[data-debug-id="surface-components-settings-vaultsetuppanel-17"]@src/components/settings/VaultSetupPanel.tsx#17';
const VAULT_KEYFILE_CLEAR_NATIVE_PICKER_SURFACE_ID =
  'ui-control:src/components/settings/VaultSetupPanel.tsx:role=button;name="Clear"@src/components/settings/VaultSetupPanel.tsx#18';
const NATIVE_PICKER_SURFACE_IDS = new Set([
  "keyboard-shortcut:attach",
  "palette-action:act-attach",
  BROWSER_NATIVE_PICKER_SURFACE_ID,
  'ui-control:src/components/AttachmentMediaBoard.tsx:[title="Attach file"]@src/components/AttachmentMediaBoard.tsx#4',
  'ui-control:src/components/BottomPanel.tsx:[data-debug-id="composer-attach"]@src/components/BottomPanel.tsx#15',
  APP_FOLDER_SURFACE_ID,
  SETTINGS_NATIVE_PICKER_SURFACE_ID,
  VAULT_KEYFILE_SELECT_NATIVE_PICKER_SURFACE_ID,
  VAULT_KEYFILE_CLEAR_NATIVE_PICKER_SURFACE_ID,
]);
const BROWSER_SHIELDS_UI_SURFACE_PREFIX = "src/browser/components/BrowserShieldsPanel.tsx:";
const VAULT_OWNED_EDIT_UI_DRIVER_ID = "ui-control-vault-owned-edit-installed";
const VAULT_ROW_REVEAL_DEBUG_DRIVER_ID = "ui-debug-vault-row-reveal-installed";
const VAULT_ROW_REVEAL_DEBUG_SURFACE_ID =
  "ui-debug-surface:vault-row-reveal@src/components/settings/VaultTab.tsx#11";
const VAULT_REQUEST_PROMPT_CONTROL_DRIVER_ID = "ui-control-vault-request-prompt-installed";
const VAULT_REQUEST_PROMPT_DEBUG_DRIVER_ID = "ui-debug-surface-vault-request-prompt-installed";
const TRUSTED_VAULT_FILL_BROWSER_CLI_DRIVER_ID = "browser-cli-trusted-vault-fill-installed";
const TRUSTED_VAULT_FILL_HOST_MCP_DRIVER_ID = "host-mcp-trusted-vault-fill-installed";
const TRUSTED_VAULT_FILL_TAURI_DRIVER_ID = "tauri-command-trusted-vault-fill-installed";
const TRUSTED_VAULT_FILL_UI_CONTROL_DRIVER_ID = "ui-control-trusted-vault-fill-installed";
const TRUSTED_VAULT_FILL_UI_DEBUG_DRIVER_ID = "ui-debug-surface-trusted-vault-fill-installed";
const TRUSTED_VAULT_FILL_DRIVER_IDS = new Set([
  TRUSTED_VAULT_FILL_BROWSER_CLI_DRIVER_ID,
  TRUSTED_VAULT_FILL_HOST_MCP_DRIVER_ID,
  TRUSTED_VAULT_FILL_TAURI_DRIVER_ID,
  TRUSTED_VAULT_FILL_UI_CONTROL_DRIVER_ID,
  TRUSTED_VAULT_FILL_UI_DEBUG_DRIVER_ID,
]);
const ACTIVITY_BROWSER_LIFECYCLE_UI_DRIVER_ID = "ui-control-activity-browser-lifecycle-installed";
const CLIPBOARD_LIFECYCLE_UI_DRIVER_ID = "ui-control-clipboard-lifecycle-installed";
const CLIPBOARD_LIFECYCLE_UI_SURFACE_IDS = new Set([
  'ui-control:src/browser/components/BrowserChrome.tsx:[data-debug-id="shellx-browser-copy-address"]@src/browser/components/BrowserChrome.tsx#16',
  'ui-control:src/components/ActivityBrowserModal.tsx:[id="activity-copy-summary"]@src/components/ActivityBrowserModal.tsx#11',
  'ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Copy command"@src/components/AgentCliSetupAssistant.tsx#4',
  'ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Copy command"@src/components/AgentCliSetupAssistant.tsx#7',
  'ui-control:src/components/BuiltinDocModal.tsx::is([aria-label="Copied"],[aria-label="Copy to clipboard"])@src/components/BuiltinDocModal.tsx#4',
  'ui-control:src/components/ChatOutput.tsx::is([aria-label="Copied"],[aria-label="Copy to clipboard"])@src/components/ChatOutput.tsx#2',
  'ui-control:src/components/FilePreviewModal.tsx:[title="Copy absolute path to clipboard"]@src/components/FilePreviewModal.tsx#5',
  'ui-control:src/components/FilePreviewModal.tsx:[title="Copies `@<path>` to clipboard. Paste into the composer to mention the file in your next prompt."]@src/components/FilePreviewModal.tsx#6',
  'ui-control:src/components/RightRail.tsx:[title="Copy environment diagnostic report"]@src/components/RightRail.tsx#6',
  'ui-control:src/components/TasksPanel.tsx:[aria-label="Copy a compact report for visible tasks"]@src/components/TasksPanel.tsx#1',
  'ui-control:src/components/TasksPanel.tsx:[title="Copy this task\'s latest output"]@src/components/TasksPanel.tsx#10',
  'ui-control:src/components/settings/VaultTab.tsx:[aria-label="Copy without revealing"]@src/components/settings/VaultTab.tsx#27',
  'ui-control:src/components/settings/VaultSetupPanel.tsx:[data-debug-id="shellx-vault-recovery-copy"]@src/components/settings/VaultSetupPanel.tsx#22',
  'ui-control:src/components/settings/VaultTab.tsx:[aria-label^="Copy value for "]@src/components/settings/VaultTab.tsx#8',
  'ui-control:src/components/VaultPasswordGenerator.tsx:[data-debug-id="vault-password-generator-copy"]@src/components/VaultPasswordGenerator.tsx#4',
  'ui-control:src/components/WorkPreviewPanel.tsx:[id="work-preview-copy-doctor-report"]@src/components/WorkPreviewPanel.tsx#12',
  'ui-control:src/components/WorkPreviewPanel.tsx:[id="work-preview-panel-copy-url"]@src/components/WorkPreviewPanel.tsx#13',
  'ui-control:src/components/WorkPreviewPanel.tsx:[id="work-preview-stage-copy-url"]@src/components/WorkPreviewPanel.tsx#22',
  'ui-control:src/components/settings/AboutTab.tsx:[data-debug-id="surface-components-settings-abouttab-3"]@src/components/settings/AboutTab.tsx#3',
  'ui-control:src/components/settings/ShellxagentTab.tsx:[data-debug-id="surface-components-settings-shellxagenttab-2"]@src/components/settings/ShellxagentTab.tsx#2',
]);
const PLUGINS_PRODUCTION_UI_DRIVER_ID = "ui-control-plugins-production-installed";
const PLUGINS_PRODUCTION_UI_CONTROLS = new Map<string, {
  expectedEffect: string;
  oracleId: string;
}>([
  ['ui-control:src/components/PluginsModal.tsx:role=button;name="Enable Recommended"@src/components/PluginsModal.tsx#4', {
    expectedEffect: "A native Enable Recommended click installs the one fixed zero-key recommended connector through the production marketplace path and proves its exact isolated marketplace and managed MCP configuration state.",
    oracleId: "ui:activation:plugins-recommended-installed",
  }],
  ['ui-control:src/components/PluginsModal.tsx:[data-debug-id="plugins-entry-toggle"]@src/components/PluginsModal.tsx#7', {
    expectedEffect: "A native entry-toggle click disables the fixed installed connector through the production marketplace path and proves installed=true and enabled=false in exact isolated state and managed configuration.",
    oracleId: "ui:boolean-state-transition",
  }],
  ['ui-control:src/components/PluginsModal.tsx:[data-debug-id="surface-components-pluginsmodal-10"]@src/components/PluginsModal.tsx#10', {
    expectedEffect: "A native Enable anyway click installs the fixed missing-key connector through the production marketplace path while proving that Vault metadata remains unchanged.",
    oracleId: "ui:activation:plugins-entry-installed",
  }],
  ['ui-control:src/components/PluginsModal.tsx:[data-debug-id="surface-components-pluginsmodal-11"]@src/components/PluginsModal.tsx#11', {
    expectedEffect: "A native Enable click installs the fixed zero-key connector through the production marketplace path and proves its exact isolated marketplace and managed MCP configuration state.",
    oracleId: "ui:activation:plugins-entry-installed",
  }],
  ['ui-control:src/components/PluginsModal.tsx:[data-debug-id="surface-components-pluginsmodal-13"]@src/components/PluginsModal.tsx#13', {
    expectedEffect: "Native entry and Save persist one fixed synthetic GitHub key through the production Vault path, expose only redacted key metadata, and leave marketplace files unchanged.",
    oracleId: "ui:activation:plugins-vault-key-saved",
  }],
  ['ui-control:src/components/PluginsModal.tsx:role=button;name="Remove"@src/components/PluginsModal.tsx#8', {
    expectedEffect: "A native Remove click uninstalls the fixed connector through the production marketplace path and proves its isolated marketplace record and managed MCP configuration block are removed.",
    oracleId: "ui:activation:plugins-entry-removed",
  }],
]);
const BOTTOM_TABS_UI_DRIVER_ID = "ui-control-bottom-tabs-installed";
const BOTTOM_TABS_UI_SURFACE_PREFIX = "src/components/BottomPanel.tsx:[data-debug-id=\"bottom-tab-";
const BOTTOM_PANEL_LIFECYCLE_UI_DRIVER_ID = "ui-control-bottom-panel-lifecycle-installed";
const SCREENSHOT_ATTACHMENT_UI_DRIVER_ID = "ui-control-screenshot-attachment-installed";
const SCREENSHOT_ATTACHMENT_UI_SURFACE_IDS = new Set([
  'ui-control:src/components/AttachmentMediaBoard.tsx:[title="Attach app screenshot"]@src/components/AttachmentMediaBoard.tsx#5',
  'ui-control:src/components/BottomPanel.tsx:[data-debug-id="composer-screenshot"]@src/components/BottomPanel.tsx#16',
]);
const BOTTOM_PANEL_LIFECYCLE_UI_SURFACE_NAMES = new Set([
  "src/components/BottomPanel.tsx:[aria-label^=\"Remove \"]",
  "src/components/BottomPanel.tsx:[data-debug-id=\"surface-components-bottompanel-24\"]",
  "src/components/BottomPanel.tsx:[data-debug-id=\"surface-components-bottompanel-9\"]",
  "src/components/BottomPanel.tsx:role=button;name=\"Inspect\"",
  "src/components/BottomPanel.tsx:role=button;name=\"Summarize\"",
  "src/components/BottomPanel.tsx:[data-debug-id=\"surface-components-bottompanel-23\"]",
  "src/components/BottomPanel.tsx:[aria-label=\"Turn voice chat off and cancel active listening\"]",
  "src/components/MicButton.tsx:[data-release-control=\"composer-mic-button\"]",
]);
const NAVIGATION_TABS_UI_DRIVER_ID = "ui-control-navigation-tabs-installed";
const SETTINGS_TABS_UI_SURFACE_PREFIX = "src/components/Settings.tsx:[data-debug-id=\"settings-tab-";
const RIGHT_RAIL_TABS_UI_SURFACE_PREFIX = "src/components/RightRail.tsx:[data-debug-id=\"right-tab-";
const SESSION_TABS_LIFECYCLE_UI_DRIVER_ID = "ui-control-session-tabs-lifecycle-installed";
const SESSION_TABS_LIFECYCLE_UI_SURFACE_PREFIX = "src/components/SessionTabs.tsx:";
const TASKS_PANEL_LIFECYCLE_UI_DRIVER_ID = "ui-control-tasks-panel-lifecycle-installed";
const TASKS_PANEL_LIFECYCLE_UI_SURFACE_NAMES = new Set([
  "src/components/TasksPanel.tsx:[data-debug-id=\"surface-components-taskspanel-3\"]",
  "src/components/TasksPanel.tsx:[data-debug-id=\"surface-components-taskspanel-8\"]",
  "src/components/TasksPanel.tsx:[title=\"Pause (SIGSTOP on Unix, NtSuspendProcess on Windows)\"]",
  "src/components/TasksPanel.tsx:[title=\"Resume (SIGCONT on Unix, NtResumeProcess on Windows)\"]",
  "src/components/TasksPanel.tsx::is([title=\"Kill (SIGTERM then SIGKILL after 3s)\"],[title=\"Kill terminal and remove its task row\"])",
  "src/components/TasksPanel.tsx:[aria-label=\"Clean Host MCP children for this tab\"]",
]);
const CHAT_OUTPUT_LIFECYCLE_UI_DRIVER_ID = "ui-control-chat-output-lifecycle-installed";
const CHAT_OUTPUT_LIFECYCLE_UI_SURFACE_NAMES = new Set([
  "src/components/ChatOutput.tsx:[aria-label^=\"Dismiss warning: \"]",
  "src/components/ChatOutput.tsx:[aria-label=\"Dismiss host MCP unreachable warning\"]",
  "src/components/ChatOutput.tsx:[data-debug-id=\"surface-components-chatoutput-1\"]",
  "src/components/ChatOutput.tsx:[data-debug-id=\"surface-components-chatoutput-3\"]",
  "src/components/ChatOutput.tsx:[data-debug-id=\"surface-components-chatoutput-4\"]",
  "src/components/ChatOutput.tsx:[data-debug-id=\"surface-components-chatoutput-5\"]",
]);
const CHAT_OUTPUT_JUMP_DEBUG_DRIVER_ID = "ui-debug-chat-output-jump-lifecycle-installed";
const CHAT_OUTPUT_JUMP_DEBUG_SURFACE_NAME = "surface-components-chatoutput-1";
const BROWSER_PERSONAL_LOCK_DEBUG_DRIVER_ID = "ui-debug-browser-personal-lock-lifecycle-installed";
const BROWSER_DELEGATION_DEBUG_DRIVER_ID = "ui-debug-browser-delegation-installed";
const BROWSER_DELEGATION_DEBUG_SURFACE_IDS = new Set([
  "ui-debug-surface:shellx-browser-handoff-tab@src/browser/components/BrowserChrome.tsx#8",
  "ui-debug-surface:shellx-browser-take-back-tab@src/browser/components/BrowserChrome.tsx#9",
  "ui-debug-surface:shellx-browser-handoff-confirmation-backdrop@src/browser/components/BrowserTabHandoffConfirmation.tsx#1",
  "ui-debug-surface:shellx-browser-handoff-confirmation@src/browser/components/BrowserTabHandoffConfirmation.tsx#2",
  "ui-debug-surface:shellx-browser-handoff-context@src/browser/components/BrowserTabHandoffConfirmation.tsx#3",
  "ui-debug-surface:shellx-browser-handoff-vault-notice@src/browser/components/BrowserTabHandoffConfirmation.tsx#4",
  "ui-debug-surface:shellx-browser-handoff-status@src/browser/components/BrowserTabHandoffConfirmation.tsx#5",
  "ui-debug-surface:shellx-browser-handoff-cancel@src/browser/components/BrowserTabHandoffConfirmation.tsx#6",
  "ui-debug-surface:shellx-browser-handoff-confirm@src/browser/components/BrowserTabHandoffConfirmation.tsx#7",
]);
const BROWSER_DEVELOPER_EVIDENCE_UI_DRIVER_ID = "ui-control-browser-developer-evidence-installed";
const BROWSER_DEVELOPER_EVIDENCE_DEBUG_DRIVER_ID = "ui-debug-browser-developer-evidence-installed";
const BROWSER_DEVELOPER_EVIDENCE_UI_SURFACE_IDS = new Set([
  'ui-control:src/browser/components/BrowserDeveloperInspection.tsx:[data-debug-id="shellx-browser-developer-approve-current-site"]@src/browser/components/BrowserDeveloperInspection.tsx#4',
  'ui-control:src/browser/components/BrowserDeveloperInspection.tsx:[data-debug-id="shellx-browser-developer-disable-mode"]@src/browser/components/BrowserDeveloperInspection.tsx#5',
  'ui-control:src/browser/components/BrowserDeveloperInspection.tsx:[data-debug-id="shellx-browser-developer-export-har"]@src/browser/components/BrowserDeveloperInspection.tsx#2',
  'ui-control:src/browser/components/BrowserDeveloperInspection.tsx:[data-debug-id="shellx-browser-developer-export-performance"]@src/browser/components/BrowserDeveloperInspection.tsx#3',
  'ui-control:src/browser/components/BrowserDeveloperInspection.tsx:[data-debug-id="shellx-browser-developer-inspect"]@src/browser/components/BrowserDeveloperInspection.tsx#1',
  'ui-control:src/browser/components/BrowserEvidencePanel.tsx:[data-debug-id="shellx-browser-evidence-teach-workflow"]@src/browser/components/BrowserEvidencePanel.tsx#2',
]);
const BROWSER_DEVELOPER_EVIDENCE_DEBUG_SURFACE_IDS = new Set([
  "ui-debug-surface:shellx-browser-evidence-teach-workflow@src/browser/components/BrowserEvidencePanel.tsx#3",
  "ui-debug-surface:shellx-browser-developer-*-receipt@src/browser/components/BrowserDeveloperInspection.tsx#1",
  "ui-debug-surface:shellx-browser-developer-access-active@src/browser/components/BrowserDeveloperInspection.tsx#18",
  "ui-debug-surface:shellx-browser-developer-access-required@src/browser/components/BrowserDeveloperInspection.tsx#16",
  "ui-debug-surface:shellx-browser-developer-approve-current-site@src/browser/components/BrowserDeveloperInspection.tsx#17",
  "ui-debug-surface:shellx-browser-developer-artifacts@src/browser/components/BrowserDeveloperInspection.tsx#20",
  "ui-debug-surface:shellx-browser-developer-clean@src/browser/components/BrowserDeveloperInspection.tsx#9",
  "ui-debug-surface:shellx-browser-developer-console-summary@src/browser/components/BrowserDeveloperInspection.tsx#5",
  "ui-debug-surface:shellx-browser-developer-disable-mode@src/browser/components/BrowserDeveloperInspection.tsx#19",
  "ui-debug-surface:shellx-browser-developer-export-har@src/browser/components/BrowserDeveloperInspection.tsx#13",
  "ui-debug-surface:shellx-browser-developer-export-performance@src/browser/components/BrowserDeveloperInspection.tsx#14",
  "ui-debug-surface:shellx-browser-developer-inspect@src/browser/components/BrowserDeveloperInspection.tsx#12",
  "ui-debug-surface:shellx-browser-developer-inspection@src/browser/components/BrowserDeveloperInspection.tsx#11",
  "ui-debug-surface:shellx-browser-developer-issues@src/browser/components/BrowserDeveloperInspection.tsx#8",
  "ui-debug-surface:shellx-browser-developer-last-inspected@src/browser/components/BrowserDeveloperInspection.tsx#3",
  "ui-debug-surface:shellx-browser-developer-network-summary@src/browser/components/BrowserDeveloperInspection.tsx#6",
  "ui-debug-surface:shellx-browser-developer-page-summary@src/browser/components/BrowserDeveloperInspection.tsx#4",
  "ui-debug-surface:shellx-browser-developer-partial@src/browser/components/BrowserDeveloperInspection.tsx#10",
  "ui-debug-surface:shellx-browser-developer-performance-summary@src/browser/components/BrowserDeveloperInspection.tsx#7",
  "ui-debug-surface:shellx-browser-developer-state-*@src/browser/components/BrowserDeveloperInspection.tsx#15",
  "ui-debug-surface:shellx-browser-developer-summary@src/browser/components/BrowserDeveloperInspection.tsx#2",
]);
const BROWSER_PERSONAL_LOCK_DEBUG_SURFACE_IDS = new Set([
  "ui-debug-surface:shellx-browser-personal-lock-now@src/browser/components/BrowserMenus.tsx#8",
  "ui-debug-surface:shellx-browser-personal-unlock-now@src/browser/components/BrowserMenus.tsx#8",
  "ui-debug-surface:shellx-browser-personal-lock-pin@src/browser/components/BrowserMenus.tsx#12",
  "ui-debug-surface:shellx-browser-personal-lock-set-pin@src/browser/components/BrowserMenus.tsx#13",
  "ui-debug-surface:shellx-browser-personal-lock-notice@src/components/ShellxBrowserApp.tsx#1",
  "ui-debug-surface:shellx-browser-personal-lock-notice-unlock@src/components/ShellxBrowserApp.tsx#2",
  "ui-debug-surface:shellx-browser-personal-lock-overlay@src/components/ShellxBrowserApp.tsx#3",
  "ui-debug-surface:shellx-browser-personal-lock-overlay-pin@src/components/ShellxBrowserApp.tsx#4",
  "ui-debug-surface:shellx-browser-personal-lock-overlay-unlock@src/components/ShellxBrowserApp.tsx#5",
]);
const RIGHT_RAIL_GIT_READ_UI_DRIVER_ID = "ui-control-right-rail-git-read-lifecycle-installed";
const RIGHT_RAIL_GIT_WRITE_UI_DRIVER_ID = "ui-control-right-rail-git-write-lifecycle-installed";
const RIGHT_RAIL_GIT_READ_UI_SURFACE_NAMES = new Set([
  "src/components/GitPane.tsx:[data-debug-id=\"surface-components-gitpane-1\"]",
  "src/components/GitPane.tsx:[data-debug-id=\"surface-components-gitpane-5\"]",
  "src/components/GitPane.tsx:role=button;name=\"Review diff\"",
  "src/components/RightRail.tsx:[title^=\"Refresh model instruction cards — \"][title$=\" completed in this view\"]",
  "src/components/RightRail.tsx:[data-debug-id=\"surface-components-rightrail-9\"]",
  "src/components/RightRail.tsx:role=button;name=\"Trace\"",
]);
const RIGHT_RAIL_GIT_WRITE_UI_SURFACE_NAMES = new Set([
  "src/components/GitPane.tsx:role=button;name=\"Checkpoint\"",
  "src/components/GitPane.tsx:role=button;name=\"Worktree\"",
]);
const PERMISSION_DECISION_UI_DRIVER_ID = "ui-control-permission-decision-lifecycle-installed";
const PROVIDER_ACTION_UI_DRIVER_ID = "ui-control-provider-action-lifecycle-installed";
const BROWSER_SAVE_LIFECYCLE_UI_DRIVER_ID = "ui-control-browser-save-lifecycle-installed";
const BROWSER_SAVE_LIFECYCLE_UI_SURFACE_IDS = new Set([
  'ui-control:src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-fullpage-screenshot"]@src/browser/components/BrowserMenus.tsx#17',
  'ui-control:src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-screenshot"]@src/browser/components/BrowserMenus.tsx#17',
  'ui-control:src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-markdown"]@src/browser/components/BrowserMenus.tsx#17',
  'ui-control:src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-links"]@src/browser/components/BrowserMenus.tsx#17',
  'ui-control:src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-snapshot"]@src/browser/components/BrowserMenus.tsx#17',
  'ui-control:src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-media"]@src/browser/components/BrowserMenus.tsx#18',
  'ui-control:src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-code"]@src/browser/components/BrowserMenus.tsx#18',
  'ui-control:src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-site"]@src/browser/components/BrowserMenus.tsx#18',
]);
const CONNECTORS_PRODUCTION_UI_DRIVER_ID = "ui-control-connectors-production-lifecycle-installed";
const permissionDecisionUiControls = new Map<string, {
  action: string;
  decision: "allow" | "allow_always" | "deny";
}>([
  ['src/components/PermissionPill.tsx:[data-debug-id="surface-components-permissionpill-1"]', {
    action: "pill-allow",
    decision: "allow",
  }],
  ['src/components/PermissionPill.tsx:[data-debug-id="surface-components-permissionpill-3"]', {
    action: "pill-deny",
    decision: "deny",
  }],
  ['src/components/PermissionPill.tsx:[title="Allow this tool every time without asking"]', {
    action: "pill-always",
    decision: "allow_always",
  }],
]);
const providerActionUiControls = new Map<string, string>([
  ['src/components/ActivityBrowserModal.tsx:role=button;name="Ask agent"', "activity-ask-agent"],
  ['src/components/BottomPanel.tsx:[data-debug-id="composer-send"]', "composer-send"],
  ['src/components/TasksPanel.tsx:[aria-label="Ask the active agent to inspect the visible background tasks"]', "tasks-visible-ask"],
  ['src/components/TasksPanel.tsx:[title="Ask the active agent to inspect this background task and its latest output"]', "tasks-row-ask"],
  ['src/components/WorkPreviewPanel.tsx:[id="work-preview-ask-fix"]', "work-preview-ask-fix"],
  ['src/components/WorkPreviewPanel.tsx:[data-debug-id="surface-components-workpreviewpanel-16"]', "work-preview-browser-issue-fix"],
  ['src/components/WorkPreviewPanel.tsx:[id="work-preview-stage-ask-fix"]', "work-preview-stage-ask-fix"],
  ['src/components/RightRail.tsx:[data-debug-id="surface-components-rightrail-11"]', "right-rail-connector-action"],
  ['src/components/RightRail.tsx:[title="Ask the active agent to inspect this diagnostic snapshot"]', "right-rail-environment-ask"],
  ['src/browser/components/AgentSidebar.tsx:[data-debug-id="shellx-browser-agent-send"]', "browser-send"],
  ['src/browser/components/AgentSidebar.tsx:[data-debug-id="shellx-browser-chat-explain-page"]', "browser-explain-page"],
]);
const connectorsProductionUiControls = new Map<string, string>([
  ['src/components/settings/ConnectorsTab.tsx:[data-debug-id="surface-components-settings-connectorstab-1"]', "refresh"],
  ['src/components/settings/ConnectorsTab.tsx:[data-debug-id="surface-components-settings-connectorstab-12"]', "save"],
  ['src/components/settings/ConnectorsTab.tsx:[data-debug-id="surface-components-settings-connectorstab-17"]', "simulate"],
  ['src/components/settings/ConnectorsTab.tsx:[data-debug-id="surface-components-settings-connectorstab-18"]', "test"],
  ['src/components/settings/ConnectorsTab.tsx:role=button;name="Delete"', "delete"],
]);
const LOCAL_DISCLOSURES_UI_DRIVER_ID = "ui-control-local-disclosures-installed";
const LOCAL_DISCLOSURES_UI_SURFACE_NAMES = new Set([
  "src/components/ActivityBrowserModal.tsx:[aria-label=\"Close (Esc)\"]",
  "src/components/AttachmentMediaBoard.tsx:[aria-label=\"Close\"]",
  "src/components/BottomPanel.tsx:[aria-label=\"Keyboard shortcuts\"]",
  "src/components/BottomPanel.tsx:[data-debug-id=\"bottom-action-assets\"]",
  "src/components/BottomPanel.tsx:[data-debug-id=\"bottom-action-trace\"]",
  "src/components/BottomPanel.tsx:[data-debug-id=\"composer-agent\"]",
  "src/components/BottomPanel.tsx:[data-debug-id=\"composer-branch\"]",
  "src/components/BottomPanel.tsx:[data-debug-id=\"composer-connection\"]",
  "src/components/ConnectorInboxModal.tsx:[aria-label=\"Close connector inbox\"]",
  "src/components/FilePreviewModal.tsx:[title=\"Close (Esc)\"]",
  "src/components/Header.tsx:[aria-label=\"About shellX — version and source\"]",
  "src/components/Header.tsx:[aria-label=\"Open connector inbox\"]",
  "src/components/Header.tsx:[aria-label=\"Open plugins\"]",
  "src/components/Header.tsx:[aria-label=\"Open settings\"]",
  "src/components/PluginsModal.tsx:[aria-label=\"Close\"]",
  "src/components/PreviewCenter.tsx:[aria-label=\"Close\"]",
  "src/components/Settings.tsx:[aria-label=\"Close settings\"]",
  "src/components/VaultPanel.tsx:[aria-label=\"Close\"]",
]);
const MODAL_BACKDROP_UI_DRIVER_ID = "ui-control-modal-backdrops-installed";
const attachmentMediaBuildingBlockers = new Map<string, string>();
const miscUiBuildingBlockers = new Map<string, string>([
  [
    'src/components/FilePreviewModal.tsx:[title="Copy absolute path to clipboard"]',
    "Copy absolute path writes operator clipboard state without an exact cross-platform clipboard snapshot and restoration channel",
  ],
  [
    'src/components/FilePreviewModal.tsx:[title="Copies `@<path>` to clipboard. Paste into the composer to mention the file in your next prompt."]',
    "Copy mention writes operator clipboard state without an exact cross-platform clipboard snapshot and restoration channel",
  ],
  [
    'src/components/BuiltinDocModal.tsx::is([aria-label="Copied"],[aria-label="Copy to clipboard"])',
    "Copy code writes operator clipboard contents and the renderer has no exact cross-platform clipboard restoration receipt",
  ],
]);
const activityPermissionBuildingBlockers = new Map<string, string>([
  [
    'src/components/ActivityBrowserModal.tsx:role=button;name="Ask agent"',
    "Ask agent submits a generated trace-summary prompt into the active provider session; this deterministic no-provider lane must not invoke or simulate that handoff",
  ],
  [
    'src/components/ActivityBrowserModal.tsx:role=button;name="Copy summary"',
    "Copy summary mutates the operator clipboard, and the installed-input contract has no exact cross-platform clipboard snapshot and restoration channel",
  ],
  [
    'src/components/PermissionPill.tsx:[data-debug-id="surface-components-permissionpill-1"]',
    "Allow resolves the exact live inline permission request; release automation must not approve an operator security decision",
  ],
  [
    'src/components/PermissionPill.tsx:[title="Allow this tool every time without asking"]',
    "Allow always resolves a live inline permission request and changes its remembered scope; release automation must not approve that operator security decision",
  ],
  [
    'src/components/PermissionPill.tsx:[data-debug-id="surface-components-permissionpill-3"]',
    "Deny resolves the exact live inline permission request; release automation must not reject an operator security decision",
  ],
]);
const settingsCoreBuildingBlockers = new Map<string, string>([
  [
    'src/components/settings/AboutTab.tsx:[data-debug-id="surface-components-settings-abouttab-3"]',
    "Copy email writes to the operator clipboard, for which this lane has no exact cross-platform snapshot and restoration channel",
  ],
]);
const tasksPanelBuildingBlockers = new Map<string, string>([
  [
    'ui-control:src/components/TasksPanel.tsx:[aria-label="Ask the active agent to inspect the visible background tasks"]@src/components/TasksPanel.tsx',
    "the action submits a prompt into the active provider session, which this deterministic no-provider lane must not invoke",
  ],
  [
    'ui-control:src/components/TasksPanel.tsx:[title="Ask the active agent to inspect this background task and its latest output"]@src/components/TasksPanel.tsx',
    "the action submits a prompt into the active provider session, which this deterministic no-provider lane must not invoke",
  ],
  [
    'ui-control:src/components/TasksPanel.tsx:[aria-label="Copy a compact report for visible tasks"]@src/components/TasksPanel.tsx',
    "the action mutates the operator clipboard and the installed-input contract has no exact cross-platform clipboard restoration channel",
  ],
  [
    'ui-control:src/components/TasksPanel.tsx:[title="Copy this task\'s latest output"]@src/components/TasksPanel.tsx',
    "the action mutates the operator clipboard and the installed-input contract has no exact cross-platform clipboard restoration channel",
  ],
]);
const workPreviewBuildingBlockers = new Map<string, string>([
  [
    'ui-control:src/components/WorkPreviewPanel.tsx:[data-debug-id="surface-components-workpreviewpanel-16"]@src/components/WorkPreviewPanel.tsx#19',
    "the browser-issue pill calls onAskGrokToFix and hands a generated repair draft to the active agent; provider and prompt paths are excluded",
  ],
  [
    'ui-control:src/components/WorkPreviewPanel.tsx:[id="work-preview-ask-fix"]@src/components/WorkPreviewPanel.tsx#6',
    "Ask Fix calls onAskGrokToFix and hands a generated repair draft to the active agent; provider and prompt paths are excluded",
  ],
  [
    'ui-control:src/components/WorkPreviewPanel.tsx:[id="work-preview-stage-ask-fix"]@src/components/WorkPreviewPanel.tsx#20',
    "the stage Ask Fix action calls onAskGrokToFix and hands a generated repair draft to the active agent; provider and prompt paths are excluded",
  ],
  [
    'ui-control:src/components/WorkPreviewPanel.tsx:[id="work-preview-copy-doctor-report"]@src/components/WorkPreviewPanel.tsx#12',
    "Copy Doctor report writes to the operator clipboard, which this isolated lifecycle must not touch",
  ],
  [
    'ui-control:src/components/WorkPreviewPanel.tsx:[id="work-preview-panel-copy-url"]@src/components/WorkPreviewPanel.tsx#13',
    "Copy URL writes to the operator clipboard, which this isolated lifecycle must not touch",
  ],
  [
    'ui-control:src/components/WorkPreviewPanel.tsx:[id="work-preview-stage-copy-url"]@src/components/WorkPreviewPanel.tsx#22',
    "the stage Copy URL action writes to the operator clipboard, which this isolated lifecycle must not touch",
  ],
]);
const chatOutputBuildingBlockers = new Map<string, string>([
  [
    'ui-control:src/components/ChatOutput.tsx::is([aria-label="Copied"],[aria-label="Copy to clipboard"])@src/components/ChatOutput.tsx',
    "the action writes assistant output to the operator clipboard and the installed-input contract has no exact cross-platform clipboard restoration channel",
  ],
]);
const rightRailGitBuildingBlockers = new Map<string, string>([
  [
    'ui-control:src/components/RightRail.tsx:[data-debug-id="surface-components-rightrail-11"]@src/components/RightRail.tsx',
    "the connector Install, Fix, or Ask action submits an installation or diagnostic prompt into the active provider session",
  ],
  [
    'ui-control:src/components/RightRail.tsx:[title="Ask the active agent to inspect this diagnostic snapshot"]@src/components/RightRail.tsx',
    "Ask submits a diagnostic prompt into the active provider session",
  ],
  [
    'ui-control:src/components/RightRail.tsx:[title="Copy environment diagnostic report"]@src/components/RightRail.tsx',
    "Copy writes the environment report to the operator clipboard, which has no exact cross-platform restoration channel",
  ],
]);
const vaultSettingsBuildingBlockers = new Map<string, string>();
const vaultUiLifecycleBuildingBlockers = new Map<string, string>([
  ['ui-control:src/components/settings/VaultTab.tsx:[aria-label="Copy without revealing"]@src/components/settings/VaultTab.tsx#27', "Copy without revealing writes the generated secret draft to the operator clipboard, which has no exact cross-platform restoration channel"],
  ['ui-control:src/components/VaultPasswordGenerator.tsx:[data-debug-id="vault-password-generator-copy"]@src/components/VaultPasswordGenerator.tsx#4', "Copy generated password writes secret material to the operator clipboard, which this isolated lifecycle must not touch"],
]);
type VaultRequestPromptPromotion = {
  fixtureId: string;
  expectedEffect: string;
  oracleId: string;
  cleanupId: string;
};

type TrustedVaultFillPromotion = VaultRequestPromptPromotion & {
  driverId: string;
};

const trustedVaultFillPromotions = new Map<string, TrustedVaultFillPromotion>([
  ["debug-api-route:POST /release-test/browser/trusted-vault-fixture", {
    driverId: "debug-api-route-installed",
    fixtureId: "vault-fill:trusted-https-fixed-child-webview",
    expectedEffect: "The isolated release-only route installs one fixed form on the exact active example.com child webview and returns only fixed-field SHA-256 plus input-event proof, never a selector, script, URL, or field value.",
    oracleId: "vault-fill:release-fixture-route:redacted-form-and-proof",
    cleanupId: "vault-fill:close-owned-route-task",
  }],
  ["browser-cli-command:fill-from-vault", {
    driverId: TRUSTED_VAULT_FILL_BROWSER_CLI_DRIVER_ID,
    fixtureId: "vault-fill:trusted-https-agent-secret",
    expectedEffect: "Browser CLI fill-from-vault consumes one exact approved isolated Fill grant and changes only the trusted HTTPS password field; evidence observes its SHA-256 and input-event count, never its value.",
    oracleId: "vault-fill:browser-cli:trusted-field-hash",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-task-and-restore-autonomy",
  }],
  ["host-mcp-tool:browser_fill_from_vault", {
    driverId: TRUSTED_VAULT_FILL_HOST_MCP_DRIVER_ID,
    fixtureId: "vault-fill:trusted-https-agent-secret",
    expectedEffect: "Host MCP browser_fill_from_vault consumes one exact approved isolated Fill grant and changes only the trusted HTTPS password field; evidence observes its SHA-256 and input-event count, never its value.",
    oracleId: "vault-fill:host-mcp-secret:trusted-field-hash",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-task-and-restore-autonomy",
  }],
  ["host-mcp-tool:browser_fill_profile_card", {
    driverId: TRUSTED_VAULT_FILL_HOST_MCP_DRIVER_ID,
    fixtureId: "vault-fill:trusted-https-profile-card",
    expectedEffect: "Host MCP browser_fill_profile_card extracts only the approved synthetic email property and changes only the trusted HTTPS email field; evidence observes its SHA-256 and input-event count, never its value.",
    oracleId: "vault-fill:host-mcp-profile:trusted-field-hash",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-task-and-restore-autonomy",
  }],
  ["tauri-command:shellx_browser_fill_user_vault_secret", {
    driverId: TRUSTED_VAULT_FILL_TAURI_DRIVER_ID,
    fixtureId: "vault-fill:trusted-https-user-suggestion",
    expectedEffect: "The production Tauri command fills one user-owned trusted HTTPS password field from an isolated user-only Vault item; evidence observes its SHA-256 and input-event count, never its value.",
    oracleId: "vault-fill:tauri-user-secret:trusted-field-hash",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-user-tab-and-restore-browser",
  }],
  ['ui-control:src/browser/components/BrowserChrome.tsx:[data-debug-id="shellx-browser-vault-fill-menu"]@src/browser/components/BrowserChrome.tsx#18', {
    driverId: TRUSTED_VAULT_FILL_UI_CONTROL_DRIVER_ID,
    fixtureId: "vault-fill:trusted-https-user-suggestion",
    expectedEffect: "Native installed input closes and reopens the exact trusted-origin Vault suggestion disclosure without activating a fill or observing the synthetic value.",
    oracleId: "ui:disclosure-state-transition",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-user-tab-and-restore-browser",
  }],
  ['ui-control:src/browser/components/BrowserVaultFillPanel.tsx:[data-debug-id="shellx-browser-vault-fill-suggestion"]@src/browser/components/BrowserVaultFillPanel.tsx#1', {
    driverId: TRUSTED_VAULT_FILL_UI_CONTROL_DRIVER_ID,
    fixtureId: "vault-fill:trusted-https-user-suggestion",
    expectedEffect: "Native installed input activates the exact suggestion and changes only the trusted HTTPS password field; evidence observes its SHA-256 and input-event count, never its value.",
    oracleId: "ui:activation:vault-fill-trusted-field-hash",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-user-tab-and-restore-browser",
  }],
  ["ui-debug-surface:shellx-browser-vault-fill-menu@src/browser/components/BrowserChrome.tsx#21", {
    driverId: TRUSTED_VAULT_FILL_UI_DEBUG_DRIVER_ID,
    fixtureId: "vault-fill:trusted-https-user-suggestion",
    expectedEffect: "The exact Vault fill menu marker resolves inside a non-empty trusted-origin suggestion lifecycle without exposing a field value.",
    oracleId: "vault-fill:ui-markers:trusted-suggestion-state",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-user-tab-and-restore-browser",
  }],
  ["ui-debug-surface:shellx-browser-vault-fill-badge@src/browser/components/BrowserChrome.tsx#22", {
    driverId: TRUSTED_VAULT_FILL_UI_DEBUG_DRIVER_ID,
    fixtureId: "vault-fill:trusted-https-user-suggestion",
    expectedEffect: "The exact non-zero Vault fill badge marker resolves inside a non-empty trusted-origin suggestion lifecycle without exposing a field value.",
    oracleId: "vault-fill:ui-markers:trusted-suggestion-state",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-user-tab-and-restore-browser",
  }],
  ["ui-debug-surface:shellx-browser-vault-fill-panel@src/browser/components/BrowserVaultFillPanel.tsx#1", {
    driverId: TRUSTED_VAULT_FILL_UI_DEBUG_DRIVER_ID,
    fixtureId: "vault-fill:trusted-https-user-suggestion",
    expectedEffect: "The exact Vault fill panel marker resolves inside a non-empty trusted-origin suggestion lifecycle without exposing a field value.",
    oracleId: "vault-fill:ui-markers:trusted-suggestion-state",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-user-tab-and-restore-browser",
  }],
  ["ui-debug-surface:shellx-browser-vault-fill-suggestion@src/browser/components/BrowserVaultFillPanel.tsx#3", {
    driverId: TRUSTED_VAULT_FILL_UI_DEBUG_DRIVER_ID,
    fixtureId: "vault-fill:trusted-https-user-suggestion",
    expectedEffect: "The exact Vault fill suggestion marker resolves inside a non-empty trusted-origin suggestion lifecycle without exposing a field value.",
    oracleId: "vault-fill:ui-markers:trusted-suggestion-state",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-user-tab-and-restore-browser",
  }],
]);

const promotedVaultRequestPromptControls = new Map<string, VaultRequestPromptPromotion>([
  ['ui-control:src/components/HeaderVaultRequestCenter.tsx:[data-debug-id^="vault-request-action-"]@src/components/HeaderVaultRequestCenter.tsx#5', {
    fixtureId: "ui:vault-request-owned-renderer-permission",
    expectedEffect: "Native installed input activates the exact focusSession tertiary action on an owned Vault-like renderer permission and focuses its source tab; no provider or permission decision is invoked.",
    oracleId: "ui:activation:vault-request-focus-owned-session",
    cleanupId: "ui:clear-owned-renderer-request-close-owned-tab-and-restore-header",
  }],
  ['ui-control:src/components/HeaderVaultRequestCenter.tsx:[data-debug-id^="vault-request-action-"]@src/components/HeaderVaultRequestCenter.tsx#6', {
    fixtureId: "ui:vault-request-owned-pending-grant",
    expectedEffect: "Native installed input activates the exact denyVaultGrant secondary action and changes only an isolated pending Vault grant to revoked without reading a secret.",
    oracleId: "ui:activation:vault-grant-decision-transition",
    cleanupId: "ui:reset-isolated-vault-grants-and-restore-header",
  }],
  ['ui-control:src/components/HeaderVaultRequestCenter.tsx:[data-debug-id^="vault-request-action-"]@src/components/HeaderVaultRequestCenter.tsx#7', {
    fixtureId: "ui:vault-request-owned-pending-grant",
    expectedEffect: "Native installed input activates the exact approveVaultGrant primary action and changes only an isolated pending Vault grant to approved without reading a secret.",
    oracleId: "ui:activation:vault-grant-decision-transition",
    cleanupId: "ui:reset-isolated-vault-grants-and-restore-header",
  }],
  ['ui-control:src/browser/components/VaultPromptCards.tsx:[data-debug-id^="shellx-browser-vault-prompt-"]@src/browser/components/VaultPromptCards.tsx#1', {
    fixtureId: "ui:browser-vault-owned-grant-and-deposit",
    expectedEffect: "Native installed input exercises both exact secondary variants: denySessionGrant changes the owned Browser grant to denied and dismissDeposit removes the owned deposit card.",
    oracleId: "ui:activation:browser-vault-prompt-decisions",
    cleanupId: "ui:delete-exact-deposits-abort-owned-browser-and-close-window",
  }],
  ['ui-control:src/browser/components/VaultPromptCards.tsx:[data-debug-id^="shellx-browser-vault-prompt-"]@src/browser/components/VaultPromptCards.tsx#2', {
    fixtureId: "ui:browser-vault-owned-grant-and-deposit",
    expectedEffect: "Native installed input exercises both exact primary variants: approveSessionGrant changes the owned Browser grant to granted and openVault opens the main Vault workspace from the owned deposit card.",
    oracleId: "ui:activation:browser-vault-prompt-decisions",
    cleanupId: "ui:delete-exact-deposits-abort-owned-browser-and-close-window",
  }],
]);

const promotedVaultRequestPromptDebugSurfaces = new Map<string, VaultRequestPromptPromotion>([
  ["ui-debug-surface:vault-request-action-*@src/components/HeaderVaultRequestCenter.tsx#7", {
    fixtureId: "ui:vault-request-owned-renderer-permission",
    expectedEffect: "Native installed input opens an owned three-action Vault-like request and binds the exact focusSession tertiary marker without activating a provider or permission decision.",
    oracleId: "ui:surface:browser-vault-action-specific-markers",
    cleanupId: "ui:clear-owned-renderer-request-close-owned-tab-and-restore-header",
  }],
  ["ui-debug-surface:shellx-browser-vault-prompt-*@src/browser/components/VaultPromptCards.tsx#3", {
    fixtureId: "ui:browser-vault-owned-grant-and-deposit",
    expectedEffect: "Native installed input opens both owned Browser request types and binds exact denySessionGrant and dismissDeposit secondary markers without inferring semantics from a generic slot.",
    oracleId: "ui:surface:browser-vault-action-specific-markers",
    cleanupId: "ui:delete-exact-deposits-abort-owned-browser-and-close-window",
  }],
  ["ui-debug-surface:shellx-browser-vault-prompt-*@src/browser/components/VaultPromptCards.tsx#4", {
    fixtureId: "ui:browser-vault-owned-grant-and-deposit",
    expectedEffect: "Native installed input opens both owned Browser request types and binds exact approveSessionGrant and openVault primary markers without inferring semantics from a generic slot.",
    oracleId: "ui:surface:browser-vault-action-specific-markers",
    cleanupId: "ui:delete-exact-deposits-abort-owned-browser-and-close-window",
  }],
  ["ui-debug-surface:shellx-browser-vault-prompt-card@src/browser/components/VaultPromptCards.tsx#2", {
    fixtureId: "ui:browser-vault-owned-grant-and-deposit",
    expectedEffect: "Native installed input opens a non-empty Browser Requests panel containing separately identified owned session-grant and deposit cards.",
    oracleId: "ui:surface:browser-vault-action-specific-markers",
    cleanupId: "ui:delete-exact-deposits-abort-owned-browser-and-close-window",
  }],
  ["ui-debug-surface:shellx-browser-vault-prompt-stack@src/browser/components/VaultPromptCards.tsx#1", {
    fixtureId: "ui:browser-vault-owned-grant-and-deposit",
    expectedEffect: "Native installed input opens the non-empty Browser Vault prompt stack with separately identified owned grant and deposit rows.",
    oracleId: "ui:surface:browser-vault-action-specific-markers",
    cleanupId: "ui:delete-exact-deposits-abort-owned-browser-and-close-window",
  }],
  ["ui-debug-surface:shellx-browser-vault-fill-unavailable@src/browser/components/BrowserVaultFillPanel.tsx#2", {
    fixtureId: "ui:browser-vault-owned-locked-fill-form",
    expectedEffect: "A local HTTP password form and locked isolated Vault expose the exact unavailable marker after a native close-and-reopen panel lifecycle; no credential suggestion or fill is invoked.",
    oracleId: "ui:surface:browser-vault-unavailable-fill-panel",
    cleanupId: "ui:close-owned-fill-tab-reset-isolated-vault-and-close-window",
  }],
]);
const LEFT_RAIL_LIFECYCLE_UI_DRIVER_ID = "ui-control-left-rail-lifecycle-installed";
const AGENT_CLI_SETUP_LIFECYCLE_UI_DRIVER_ID = "ui-control-agent-cli-setup-lifecycle-installed";
const agentCliSetupLifecycleUiControls = new Map<string, {
  fixtureId: string;
  expectedEffect: string;
  oracleId: string;
  cleanupId: string;
}>([
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:[data-debug-id="agent-cli-setup-dialog"]@src/components/AgentCliSetupAssistant.tsx#10', {
    fixtureId: "ui:agent-cli-setup-owned-dialog-open",
    expectedEffect: "A bounded native pointer click on the synthetic outer Agent CLI setup backdrop closes the exact renderer-owned dialog without invoking setup discovery or provider state.",
    oracleId: "ui:activation:agent-cli-setup-dialog-closed",
    cleanupId: "ui:close-agent-cli-setup-owned-dialog",
  }],
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Close"@src/components/AgentCliSetupAssistant.tsx#2', {
    fixtureId: "ui:agent-cli-setup-owned-dialog-open",
    expectedEffect: "A native click on the synthetic Agent CLI setup Close button closes the exact renderer-owned dialog without invoking setup discovery or provider state.",
    oracleId: "ui:activation:agent-cli-setup-dialog-closed",
    cleanupId: "ui:close-agent-cli-setup-owned-dialog",
  }],
  ...(["grok", "claude-code", "codex-cli", "antigravity-cli"] as const).map((providerId) => [
    `ui-control:src/components/AgentCliStatusCard.tsx:[data-debug-id="agent-cli-setup-open-${providerId}"]@src/components/AgentCliStatusCard.tsx#1`,
    {
      fixtureId: "ui:agent-cli-status-owned-setup-open",
      expectedEffect: `A bounded native click on the inert ${providerId} status-card setup control opens the synthetic Agent CLI setup dialog filtered to exactly that provider without scanning PATH or invoking a provider, installer, Vault, clipboard, or external action.`,
      oracleId: "ui:activation:agent-cli-status-setup-dialog-opened",
      cleanupId: "ui:close-agent-cli-status-dialog-and-restore-right-rail",
    },
  ] satisfies [string, {
    fixtureId: string;
    expectedEffect: string;
    oracleId: string;
    cleanupId: string;
  }]),
  ['ui-control:src/components/AgentCliStatusCard.tsx:[data-debug-id="agent-cli-setup-open-missing"]@src/components/AgentCliStatusCard.tsx#2', {
    fixtureId: "ui:agent-cli-status-owned-setup-open",
    expectedEffect: "A bounded native click on the inert missing-Agent-CLI setup control opens the synthetic setup dialog with exactly all four provider cards without scanning PATH or invoking a provider, installer, Vault, clipboard, or external action.",
    oracleId: "ui:activation:agent-cli-status-setup-dialog-opened",
    cleanupId: "ui:close-agent-cli-status-dialog-and-restore-right-rail",
  }],
  ['ui-control:src/components/AgentCliStatusCard.tsx:role=button;name="Refresh"@src/components/AgentCliStatusCard.tsx#3', {
    fixtureId: "ui:agent-cli-owned-target-live-refresh",
    expectedEffect: "A native Refresh click scans the isolated exact local target through the production resolver, version command, SHA-256, and size path and observes the owned CLI replacement before any provider launch.",
    oracleId: "ui:activation:agent-cli-fresh-version-observed",
    cleanupId: "ui:close-agent-cli-live-scan-delete-owned-binary-restore-right-rail",
  }],
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Recheck"@src/components/AgentCliSetupAssistant.tsx#1', {
    fixtureId: "ui:agent-cli-owned-target-live-refresh",
    expectedEffect: "A native Recheck click scans the isolated exact local target through the production resolver, version command, SHA-256, and size path and observes the owned CLI replacement before any provider launch.",
    oracleId: "ui:activation:agent-cli-fresh-version-observed",
    cleanupId: "ui:close-agent-cli-live-scan-delete-owned-binary-restore-right-rail",
  }],
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Open docs"@src/components/AgentCliSetupAssistant.tsx#3', {
    fixtureId: "ui:agent-cli-owned-doc-link-cards",
    expectedEffect: "A native click dispatches the exact synthetic provider documentation URL through ShellX's isolated external-browser handoff without opening an operator browser or contacting the network.",
    oracleId: "ui:activation:agent-cli-doc-link-dispatched",
    cleanupId: "ui:close-agent-cli-setup-owned-dialog",
  }],
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Open docs"@src/components/AgentCliSetupAssistant.tsx#6', {
    fixtureId: "ui:agent-cli-owned-doc-link-confirmation",
    expectedEffect: "A native click from the synthetic install confirmation dispatches the exact provider documentation URL through ShellX's isolated external-browser handoff without opening an operator browser or contacting the network.",
    oracleId: "ui:activation:agent-cli-doc-link-dispatched",
    cleanupId: "ui:close-agent-cli-setup-owned-dialog",
  }],
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:[data-debug-id="surface-components-agentclisetupassistant-5"]@src/components/AgentCliSetupAssistant.tsx#5', {
    fixtureId: "ui:agent-cli-owned-npm-install-lifecycle",
    expectedEffect: "A native Install click prepares the exact Codex npm command through the production confirmation registry inside the disposable final-test profile; no shim execution, network, PATH, shell configuration, provider authentication, or operator install occurs.",
    oracleId: "ui:activation:agent-cli-owned-npm-confirmation-prepared",
    cleanupId: "ui:cancel-agent-cli-preparation-close-dialog-delete-owned-shim-and-receipt",
  }],
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Cancel"@src/components/AgentCliSetupAssistant.tsx#8', {
    fixtureId: "ui:agent-cli-owned-npm-install-lifecycle",
    expectedEffect: "A native Cancel click removes the exact production confirmation prepared for the candidate-owned Codex npm shim and proves the confirmation cannot subsequently execute.",
    oracleId: "ui:activation:agent-cli-owned-npm-confirmation-cancelled",
    cleanupId: "ui:cancel-agent-cli-preparation-close-dialog-delete-owned-shim-and-receipt",
  }],
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:[data-debug-id="surface-components-agentclisetupassistant-9"]@src/components/AgentCliSetupAssistant.tsx#9', {
    fixtureId: "ui:agent-cli-owned-npm-install-lifecycle",
    expectedEffect: "A native Run installer click consumes the exact production confirmation and executes only the fixed candidate-owned npm shim, which records the immutable Codex install argv receipt without network, PATH, shell configuration, provider authentication, or operator installation.",
    oracleId: "ui:activation:agent-cli-owned-npm-shim-receipt",
    cleanupId: "ui:cancel-agent-cli-preparation-close-dialog-delete-owned-shim-and-receipt",
  }],
]);
const agentCliSetupBuildingBlockers = new Map<string, string>([
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Copy command"@src/components/AgentCliSetupAssistant.tsx#4', "Copy command writes to the operator clipboard, which this isolated lifecycle must not touch"],
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Copy command"@src/components/AgentCliSetupAssistant.tsx#7', "Confirmation Copy command writes to the operator clipboard, which this isolated lifecycle must not touch"],
  ['ui-control:src/components/ConnectionEditor.tsx:[data-debug-id="connection-agent-cli-setup-open"]@src/components/ConnectionEditor.tsx#13', "the connection-owned setup entry currently loads real Vault key references and enters the live target setup path; this isolated lifecycle cannot prove it without touching operator configuration"],
]);
const connectorsBuildingBlockers = new Map<string, string>([
  [
    "src/components/settings/ConnectorsTab.tsx:[data-debug-id=\"surface-components-settings-connectorstab-1\"]",
    "Refresh reads live connector configuration, Vault key names, and session state; this renderer-only lane must not inspect operator or Vault state",
  ],
  [
    "src/components/settings/ConnectorsTab.tsx:[data-debug-id=\"surface-components-settings-connectorstab-12\"]",
    "Save persists operator connector configuration and can write the token draft into Vault; both mutations are excluded",
  ],
  [
    "src/components/settings/ConnectorsTab.tsx:[data-debug-id=\"surface-components-settings-connectorstab-17\"]",
    "Simulate inbound creates a connector event and can dispatch its text into an active agent session; session and provider paths are excluded",
  ],
  [
    "src/components/settings/ConnectorsTab.tsx:[data-debug-id=\"surface-components-settings-connectorstab-18\"]",
    "Test performs a provider network call using a Vault-backed bot token; provider, network, and Vault access are excluded",
  ],
  [
    "src/components/settings/ConnectorsTab.tsx:role=button;name=\"Delete\"",
    "Delete removes persisted operator connector configuration after confirmation; operator-state mutation is excluded",
  ],
]);
const CONNECTION_LIFECYCLE_UI_DRIVER_ID = "ui-control-connection-lifecycle-installed";
const BRANCH_PICKER_LIFECYCLE_UI_DRIVER_ID = "ui-control-branch-picker-lifecycle-installed";
const BRANCH_PICKER_LIFECYCLE_UI_SURFACE_NAME =
  'src/components/BranchPicker.tsx:[data-debug-id="surface-components-branchpicker-1"]';
const WINDOWS_DESKTOP_INTEGRATION_UI_DRIVER_ID = "ui-control-windows-desktop-integration-installed";
const WINDOWS_DESKTOP_INTEGRATION_UI_SURFACE_NAMES = new Set([
  'src/components/settings/DesktopTab.tsx:[data-debug-id="surface-components-settings-desktoptab-1"]',
  'src/components/settings/DesktopTab.tsx:role=button;name="Install"',
  'src/components/settings/DesktopTab.tsx:role=button;name="Remove"',
]);
const CONNECTION_LIFECYCLE_UI_SURFACE_NAMES = new Set([
  "src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-agent-cli-setup-open\"]",
  "src/components/ConnectionEditor.tsx:[data-debug-id=\"surface-components-connectioneditor-12\"]",
  "src/components/ConnectionEditor.tsx:[data-debug-id=\"surface-components-connectioneditor-14\"]",
  "src/components/ConnectionEditor.tsx:[data-debug-id=\"surface-components-connectioneditor-16\"]",
  "src/components/ConnectionPicker.tsx:[aria-label=\"Confirm delete connection\"]",
  "src/components/ConnectionPicker.tsx:[aria-label^=\"Delete \"]",
  "src/components/ConnectionPicker.tsx:role=button;name=\"Cancel\"",
  "src/components/ConnectionPicker.tsx:role=button;name=\"Edit\"",
  "src/components/ConnectionPicker.tsx:[title^=\"Use \"]",
  "src/components/ConnectionPicker.tsx:role=button;name=\"Test\"",
  "src/components/settings/ConnectionsTab.tsx:[data-debug-id=\"surface-components-settings-connectionstab-2\"]",
  "src/components/settings/ConnectionsTab.tsx:[aria-label=\"Cancel delete connection\"]",
  "src/components/settings/ConnectionsTab.tsx:[aria-label=\"Confirm delete saved connection\"]",
  "src/components/settings/ConnectionsTab.tsx:[title=\"Edit this connection\"]",
  "src/components/settings/ConnectionsTab.tsx:[title=\"Delete this connection preset\"]",
]);
const connectionLifecycleBuildingBlockers = new Map<string, string>([
]);
const goalPlanReviewLifecycleUiControls = new Map<string, {
  fixtureId: string;
  expectedEffect: string;
  oracleId: string;
  cleanupId: string;
}>([
  ['ui-control:src/components/GoalPlanReviewModal.tsx:[aria-label="Review later"]@src/components/GoalPlanReviewModal.tsx#2', {
    fixtureId: "ui:goal-plan-review-owned-review",
    expectedEffect: "A native click dismisses the inert renderer-only Goal Plan Review fixture through its header action without approving, rejecting, replanning, or contacting a provider.",
    oracleId: "ui:activation:goal-plan-review-dismissed",
    cleanupId: "ui:close-goal-plan-review-owned-fixture",
  }],
  ['ui-control:src/components/GoalPlanReviewModal.tsx:[placeholder="What should Grok change about this plan? (Ctrl+Enter to submit)"]@src/components/GoalPlanReviewModal.tsx#3', {
    fixtureId: "ui:goal-plan-review-owned-editing",
    expectedEffect: "Native text entry changes and exactly clears only the inert local feedback draft without submitting feedback or contacting a provider.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:close-goal-plan-review-owned-fixture",
  }],
  ['ui-control:src/components/GoalPlanReviewModal.tsx:role=button;name="Cancel"@src/components/GoalPlanReviewModal.tsx#5', {
    fixtureId: "ui:goal-plan-review-owned-editing",
    expectedEffect: "A native click cancels the inert local feedback draft while preserving the review dialog and without contacting a provider.",
    oracleId: "ui:activation:goal-plan-review-edit-cancelled",
    cleanupId: "ui:close-goal-plan-review-owned-fixture",
  }],
  ['ui-control:src/components/GoalPlanReviewModal.tsx:role=button;name="Review later"@src/components/GoalPlanReviewModal.tsx#6', {
    fixtureId: "ui:goal-plan-review-owned-review",
    expectedEffect: "A native click dismisses the inert renderer-only Goal Plan Review fixture through its footer action without approving, rejecting, replanning, or contacting a provider.",
    oracleId: "ui:activation:goal-plan-review-dismissed",
    cleanupId: "ui:close-goal-plan-review-owned-fixture",
  }],
  ['ui-control:src/components/GoalPlanReviewModal.tsx:role=button;name="Request changes"@src/components/GoalPlanReviewModal.tsx#8', {
    fixtureId: "ui:goal-plan-review-owned-review",
    expectedEffect: "A native click opens the inert local feedback editor without entering or submitting feedback and without contacting a provider.",
    oracleId: "ui:activation:goal-plan-review-edit-opened",
    cleanupId: "ui:close-goal-plan-review-owned-fixture",
  }],
  ['ui-control:src/components/GoalPlanReviewModal.tsx:[data-debug-id="surface-components-goalplanreviewmodal-4"]@src/components/GoalPlanReviewModal.tsx#4', {
    fixtureId: "ui:goal-plan-review-owned-send-feedback",
    expectedEffect: "Native installed input submits an exact owned feedback draft to one isolated Goal, observes its real replan gate transition and correlated fixed provider child receipt, then removes the disposable Goal, provider, and project namespaces.",
    oracleId: "ui:activation:goal-plan-review-owned-state-transition",
    cleanupId: "ui:forget-owned-goal-provider-delete-cwd-and-restore-view",
  }],
  ['ui-control:src/components/GoalPlanReviewModal.tsx:[data-debug-id="surface-components-goalplanreviewmodal-7"]@src/components/GoalPlanReviewModal.tsx#7', {
    fixtureId: "ui:goal-plan-review-owned-reject",
    expectedEffect: "Two native installed clicks arm and confirm rejection of one isolated Goal plan, observe its real rejected tombstone without contacting a provider, then remove the disposable Goal and project namespaces.",
    oracleId: "ui:activation:goal-plan-review-owned-state-transition",
    cleanupId: "ui:forget-owned-goal-provider-delete-cwd-and-restore-view",
  }],
  ['ui-control:src/components/GoalPlanReviewModal.tsx:[data-debug-id="surface-components-goalplanreviewmodal-9"]@src/components/GoalPlanReviewModal.tsx#9', {
    fixtureId: "ui:goal-plan-review-owned-approve",
    expectedEffect: "Native installed input approves one isolated Goal plan, observes its real active gate transition, scratchboard status patch, and correlated fixed provider child receipt, then removes the disposable Goal, provider, and project namespaces.",
    oracleId: "ui:activation:goal-plan-review-owned-state-transition",
    cleanupId: "ui:forget-owned-goal-provider-delete-cwd-and-restore-view",
  }],
]);
const shellxagentBuildingBlockers = new Map<string, string>([
  [
    "src/components/settings/ShellxagentTab.tsx:[data-debug-id=\"surface-components-settings-shellxagenttab-2\"]",
    "Copy writes credential material to the operator clipboard, whose prior cross-platform contents cannot be captured and restored without exposing or mutating them",
  ],
]);
const appBottomLifecycleBuildingBlockers = new Map<string, string>();
const promotedModalBackdropControls = new Map<string, { fixtureId: string; label: string }>([
  ["src/components/ActivityBrowserModal.tsx:[data-debug-id=\"activity-browser-backdrop\"]", { fixtureId: "ui:modal-backdrop-activity", label: "Activity Browser" }],
  ["src/components/AttachmentMediaBoard.tsx:[data-debug-id=\"attachment-media-board-backdrop\"]", { fixtureId: "ui:modal-backdrop-assets", label: "Attachment and Media Board" }],
  ["src/components/BuiltinDocModal.tsx:[data-debug-id=\"surface-components-builtindocmodal-4\"]", { fixtureId: "ui:modal-backdrop-builtin-doc", label: "built-in documentation" }],
  ["src/components/CommandPalette.tsx:[data-debug-id=\"surface-components-commandpalette-1\"]", { fixtureId: "ui:modal-backdrop-palette", label: "Command Palette" }],
  ["src/components/ConnectionEditor.tsx:[data-debug-id=\"surface-components-connectioneditor-1\"]", { fixtureId: "ui:modal-backdrop-connection-editor", label: "connection editor" }],
  ["src/components/ConnectorInboxModal.tsx:[data-debug-id=\"connector-inbox-backdrop\"]", { fixtureId: "ui:modal-backdrop-connectorInbox", label: "Connector Inbox" }],
  ["src/components/HelpModal.tsx:[data-debug-id=\"surface-components-helpmodal-1\"]", { fixtureId: "ui:modal-backdrop-help", label: "keyboard shortcuts" }],
  ["src/components/PluginsModal.tsx:[data-debug-id=\"surface-components-pluginsmodal-1\"]", { fixtureId: "ui:modal-backdrop-plugins", label: "Plugins" }],
  ["src/components/PRCreateModal.tsx:[data-debug-id=\"surface-components-prcreatemodal-1\"]", { fixtureId: "ui:modal-backdrop-pr", label: "Create pull request" }],
  ["src/components/PreviewCenter.tsx:[data-debug-id=\"preview-center-backdrop\"]", { fixtureId: "ui:modal-backdrop-preview", label: "Preview Center" }],
  ["src/components/Settings.tsx:[data-debug-id=\"surface-components-settings-1\"]", { fixtureId: "ui:modal-backdrop-settings", label: "Settings" }],
  ["src/components/VaultPanel.tsx:[data-debug-id=\"surface-components-vaultpanel-1\"]", { fixtureId: "ui:modal-backdrop-vault", label: "Vault workspace" }],
]);
const browserShieldsUiDriver: FinalSurfaceDriverDefinition = {
  id: BROWSER_SHIELDS_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-browser-shields-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const vaultOwnedEditUiDriver: FinalSurfaceDriverDefinition = {
  id: VAULT_OWNED_EDIT_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-vault-owned-edit-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const vaultRowRevealDebugDriver: FinalSurfaceDriverDefinition = {
  id: VAULT_ROW_REVEAL_DEBUG_DRIVER_ID,
  kind: "ui-debug-surface",
  entrypoint: "scripts/release-drivers/ui-debug-vault-row-reveal-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const vaultRequestPromptControlDriver: FinalSurfaceDriverDefinition = {
  id: VAULT_REQUEST_PROMPT_CONTROL_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-vault-request-prompt-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const vaultRequestPromptDebugDriver: FinalSurfaceDriverDefinition = {
  id: VAULT_REQUEST_PROMPT_DEBUG_DRIVER_ID,
  kind: "ui-debug-surface",
  entrypoint: "scripts/release-drivers/ui-debug-surface-vault-request-prompt-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const trustedVaultFillBrowserCliDriver: FinalSurfaceDriverDefinition = {
  id: TRUSTED_VAULT_FILL_BROWSER_CLI_DRIVER_ID,
  kind: "browser-cli-command",
  entrypoint: "scripts/release-drivers/browser-cli-trusted-vault-fill-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const trustedVaultFillHostMcpDriver: FinalSurfaceDriverDefinition = {
  id: TRUSTED_VAULT_FILL_HOST_MCP_DRIVER_ID,
  kind: "host-mcp-tool",
  entrypoint: "scripts/release-drivers/host-mcp-trusted-vault-fill-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const trustedVaultFillTauriDriver: FinalSurfaceDriverDefinition = {
  id: TRUSTED_VAULT_FILL_TAURI_DRIVER_ID,
  kind: "tauri-command",
  entrypoint: "scripts/release-drivers/tauri-command-trusted-vault-fill-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const trustedVaultFillUiControlDriver: FinalSurfaceDriverDefinition = {
  id: TRUSTED_VAULT_FILL_UI_CONTROL_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-trusted-vault-fill-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const trustedVaultFillUiDebugDriver: FinalSurfaceDriverDefinition = {
  id: TRUSTED_VAULT_FILL_UI_DEBUG_DRIVER_ID,
  kind: "ui-debug-surface",
  entrypoint: "scripts/release-drivers/ui-debug-surface-trusted-vault-fill-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const activityBrowserLifecycleUiDriver: FinalSurfaceDriverDefinition = {
  id: ACTIVITY_BROWSER_LIFECYCLE_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-activity-browser-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const clipboardLifecycleUiDriver: FinalSurfaceDriverDefinition = {
  id: CLIPBOARD_LIFECYCLE_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-clipboard-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const bottomTabsUiDriver: FinalSurfaceDriverDefinition = {
  id: BOTTOM_TABS_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-bottom-tabs-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const bottomPanelLifecycleUiDriver: FinalSurfaceDriverDefinition = {
  id: BOTTOM_PANEL_LIFECYCLE_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-bottom-panel-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const screenshotAttachmentUiDriver: FinalSurfaceDriverDefinition = {
  id: SCREENSHOT_ATTACHMENT_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-screenshot-attachment-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const navigationTabsUiDriver: FinalSurfaceDriverDefinition = {
  id: NAVIGATION_TABS_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-navigation-tabs-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const sessionTabsLifecycleUiDriver: FinalSurfaceDriverDefinition = {
  id: SESSION_TABS_LIFECYCLE_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-session-tabs-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const tasksPanelLifecycleUiDriver: FinalSurfaceDriverDefinition = {
  id: TASKS_PANEL_LIFECYCLE_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-tasks-panel-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const chatOutputLifecycleUiDriver: FinalSurfaceDriverDefinition = {
  id: CHAT_OUTPUT_LIFECYCLE_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-chat-output-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const chatOutputJumpDebugDriver: FinalSurfaceDriverDefinition = {
  id: CHAT_OUTPUT_JUMP_DEBUG_DRIVER_ID,
  kind: "ui-debug-surface",
  entrypoint: "scripts/release-drivers/ui-debug-chat-output-jump-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const browserPersonalLockDebugDriver: FinalSurfaceDriverDefinition = {
  id: BROWSER_PERSONAL_LOCK_DEBUG_DRIVER_ID,
  kind: "ui-debug-surface",
  entrypoint: "scripts/release-drivers/ui-debug-browser-personal-lock-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const browserDelegationDebugDriver: FinalSurfaceDriverDefinition = {
  id: BROWSER_DELEGATION_DEBUG_DRIVER_ID,
  kind: "ui-debug-surface",
  entrypoint: "scripts/release-drivers/ui-debug-browser-delegation-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const browserDeveloperEvidenceUiDriver: FinalSurfaceDriverDefinition = {
  id: BROWSER_DEVELOPER_EVIDENCE_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-browser-developer-evidence-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const browserDeveloperEvidenceDebugDriver: FinalSurfaceDriverDefinition = {
  id: BROWSER_DEVELOPER_EVIDENCE_DEBUG_DRIVER_ID,
  kind: "ui-debug-surface",
  entrypoint: "scripts/release-drivers/ui-debug-browser-developer-evidence-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const browserTeachUiDriver: FinalSurfaceDriverDefinition = {
  id: BROWSER_TEACH_CONTROL_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-browser-teach-review-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const browserTeachDebugDriver: FinalSurfaceDriverDefinition = {
  id: BROWSER_TEACH_DEBUG_DRIVER_ID,
  kind: "ui-debug-surface",
  entrypoint: "scripts/release-drivers/ui-debug-browser-teach-review-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const rightRailGitReadUiDriver: FinalSurfaceDriverDefinition = {
  id: RIGHT_RAIL_GIT_READ_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-right-rail-git-read-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const rightRailGitWriteUiDriver: FinalSurfaceDriverDefinition = {
  id: RIGHT_RAIL_GIT_WRITE_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-right-rail-git-write-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const permissionDecisionUiDriver: FinalSurfaceDriverDefinition = {
  id: PERMISSION_DECISION_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-permission-decision-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const providerActionUiDriver: FinalSurfaceDriverDefinition = {
  id: PROVIDER_ACTION_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-provider-action-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const browserSaveLifecycleUiDriver: FinalSurfaceDriverDefinition = {
  id: BROWSER_SAVE_LIFECYCLE_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-browser-save-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const connectorsProductionUiDriver: FinalSurfaceDriverDefinition = {
  id: CONNECTORS_PRODUCTION_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-connectors-production-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const localDisclosuresUiDriver: FinalSurfaceDriverDefinition = {
  id: LOCAL_DISCLOSURES_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-local-disclosures-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const modalBackdropUiDriver: FinalSurfaceDriverDefinition = {
  id: MODAL_BACKDROP_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-modal-backdrops-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const leftRailLifecycleUiDriver: FinalSurfaceDriverDefinition = {
  id: LEFT_RAIL_LIFECYCLE_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-left-rail-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const agentCliSetupLifecycleUiDriver: FinalSurfaceDriverDefinition = {
  id: AGENT_CLI_SETUP_LIFECYCLE_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-agent-cli-setup-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const connectionLifecycleUiDriver: FinalSurfaceDriverDefinition = {
  id: CONNECTION_LIFECYCLE_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-connection-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const branchPickerLifecycleUiDriver: FinalSurfaceDriverDefinition = {
  id: BRANCH_PICKER_LIFECYCLE_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-branch-picker-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const boundedInstalledUiDriver: FinalSurfaceDriverDefinition = {
  id: UI_CONTROL_BOUNDED_INSTALLED_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-bounded-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const pluginsProductionUiDriver: FinalSurfaceDriverDefinition = {
  id: PLUGINS_PRODUCTION_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-plugins-production-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const windowsDesktopIntegrationUiDriver: FinalSurfaceDriverDefinition = {
  id: WINDOWS_DESKTOP_INTEGRATION_UI_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-windows-desktop-integration-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const keyboardNativePickerDriver: FinalSurfaceDriverDefinition = {
  id: KEYBOARD_NATIVE_PICKER_DRIVER_ID,
  kind: "keyboard-shortcut",
  entrypoint: "scripts/release-drivers/keyboard-shortcut-native-picker-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const paletteNativePickerDriver: FinalSurfaceDriverDefinition = {
  id: PALETTE_NATIVE_PICKER_DRIVER_ID,
  kind: "palette-action",
  entrypoint: "scripts/release-drivers/palette-action-native-picker-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const paletteProviderActionDriver: FinalSurfaceDriverDefinition = {
  id: PALETTE_PROVIDER_ACTION_DRIVER_ID,
  kind: "palette-action",
  entrypoint: "scripts/release-drivers/palette-action-provider-action-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const uiNativePickerDriver: FinalSurfaceDriverDefinition = {
  id: UI_NATIVE_PICKER_DRIVER_ID,
  kind: "ui-control",
  entrypoint: "scripts/release-drivers/ui-control-native-picker-lifecycle-installed.ts",
  platforms: {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  },
};
const kinds: ReleaseSurfaceKind[] = [
  "tauri-command",
  "debug-api-route",
  "host-mcp-tool",
  "browser-cli-command",
  "palette-action",
  "keyboard-shortcut",
  "shellx-command",
  "ui-debug-surface",
  "ui-control",
];
const promotedTauriCommands = new Set([
  "abort_session",
  "add_build_operator_note",
  "agent_cli_setup_cancel_install",
  "agent_cli_setup_confirm_install",
  "agent_cli_setup_prepare_install",
  "agent_cli_setup_recheck",
  "append_session_log",
  "approve_build_plan",
  "approve_goal_plan",
  "archive_session_artifacts",
  "capture_app_screenshot_to_file",
  "cleanup_mcp_children_for_tab",
  "copy_asset_to_scope",
  "copy_to_scope",
  "connections_delete",
  "connections_list",
  "connections_save",
  "connections_test",
  "delete_session_files",
  "delete_user_data_section",
  "desktop_integration_install_windows_context_menu",
  "desktop_integration_remove_windows_context_menu",
  "drop_tab_session",
  "get_build_receipts",
  "get_build_state",
  "get_debug_token",
  "get_detected_max_tokens",
  "get_goal_state",
  "git_branches",
  "git_session_create_checkpoint",
  "git_session_create_worktree",
  "git_session_diff",
  "git_session_status",
  "grok_environment_snapshot",
  "grok_trace_export",
  "halt_build",
  "interject_prompt",
  "list_project_files",
  "list_stored_sessions",
  "mark_goal_complete",
  "mcp_marketplace_install",
  "mcp_marketplace_list",
  "mcp_marketplace_set_enabled",
  "mcp_marketplace_uninstall",
  "open_url_in_browser",
  "outside_connectors_delete",
  "outside_connectors_events",
  "outside_connectors_list",
  "outside_connectors_save",
  "outside_connectors_simulate",
  "outside_connectors_test",
  "pause_build",
  "pause_goal",
  "pty_create",
  "pty_kill",
  "pty_resize",
  "pty_write",
  "read_image_as_data_url",
  "read_preview_file_as_data_url",
  "read_session_activity_source",
  "read_session_jsonl",
  "read_session_jsonl_tail",
  "read_text_file_for_path",
  "read_text_file_if_text",
  "release_test_take_native_picker",
  "read_user_data",
  "recheck_build_blocker",
  "reject_build_plan",
  "reject_goal_plan",
  "rename_past_session",
  "renderer_error",
  "request_goal_replan",
  "resolve_permission_request",
  "resume_build",
  "resume_goal",
  "save_dropped_attachment_to_scope",
  "send_prompt",
  "shellx_browser_copy_local_artifact",
  "session_tooling_snapshot",
  "set_permission_mode",
  "set_goal_mode",
  "shellx_browser_approve_developer_mode_host",
  "shellx_browser_claim_cowork_prompt",
  "shellx_browser_clear_history",
  "shellx_browser_control_task",
  "shellx_browser_delegate_tab_to_agent",
  "shellx_browser_finish_task",
  "shellx_browser_grant_transfer",
  "shellx_browser_open_window",
  "shellx_browser_open_vault_panel",
  "shellx_browser_operator_approve_teach_draft",
  "shellx_browser_operator_developer_inspect",
  "shellx_browser_operator_evidence_summary",
  "shellx_browser_operator_export_har",
  "shellx_browser_operator_export_flight_recorder",
  "shellx_browser_operator_export_performance",
  "shellx_browser_operator_list_teach_drafts",
  "shellx_browser_operator_prepare_teach_draft",
  "shellx_browser_operator_rehearse_teach_recipe",
  "shellx_browser_operator_revise_teach_draft",
  "shellx_browser_sync_engine",
  "shellx_browser_replay_cowork_prompt_notifications",
  "shellx_browser_remove_site_shields",
  "shellx_browser_resolve_dialog",
  "shellx_browser_resolve_permission",
  "shellx_browser_resolve_session_grant",
  "shellx_browser_send_cowork_prompt",
  "shellx_browser_take_back_tab_from_agent",
  "shellx_browser_update_developer_mode",
  "shellx_browser_update_download_folder",
  "shellx_browser_update_personal_lock",
  "shellx_browser_update_privacy",
  "shellx_browser_update_shields",
  "shellx_browser_update_site_shields",
  "shellx_browser_write_text_artifact",
  "shellx_vault_approve_grant",
  "shellx_vault_agent_request_approve",
  "shellx_vault_agent_request_center",
  "shellx_vault_agent_request_deny",
  "shellx_vault_begin_setup",
  "shellx_vault_confirm_recovery_saved",
  "shellx_vault_create_grant",
  "shellx_vault_lock",
  "shellx_vault_revoke_grant",
  "shellx_vault_set_remembered_device_enabled",
  "shellx_vault_unlock",
  "shellxagent_token_regenerate",
  "shellxagent_token_read",
  "start_build_mode",
  "start_grok_session",
  "synthesize_voice",
  "task_kill",
  "task_pause",
  "task_resume",
  "transcribe_audio_blob",
  "vault_delete",
  "vault_get",
  "vault_list_keys_with_meta",
  "vault_set",
  "vault_set_resource",
  "vault_update_metadata",
  "vault_update_resource_metadata",
  "voice_credential_source",
  "write_user_data",
]);
const promotedTauriFailClosedCommands = new Set([
  "add_build_operator_note",
  "agent_cli_setup_confirm_install",
  "agent_cli_setup_prepare_install",
  "approve_build_plan",
  "approve_goal_plan",
  "archive_session_artifacts",
  "shellx_browser_approve_developer_mode_host",
  "shellx_browser_claim_cowork_prompt",
  "shellx_browser_control_task",
  "shellx_browser_delegate_tab_to_agent",
  "shellx_browser_finish_task",
  "shellx_browser_grant_transfer",
  "shellx_browser_remove_site_shields",
  "shellx_browser_resolve_dialog",
  "shellx_browser_resolve_permission",
  "shellx_browser_resolve_session_grant",
  "shellx_browser_send_cowork_prompt",
  "shellx_browser_take_back_tab_from_agent",
  "shellx_browser_update_personal_lock",
  "shellx_browser_update_privacy",
  "shellx_browser_update_site_shields",
  "shellx_vault_approve_grant",
  "shellx_vault_agent_request_approve",
  "shellx_vault_agent_request_deny",
  "shellx_vault_begin_setup",
  "shellx_vault_confirm_recovery_saved",
  "shellx_vault_create_grant",
  "shellx_vault_lock",
  "shellx_vault_revoke_grant",
  "shellx_vault_set_remembered_device_enabled",
  "shellx_vault_unlock",
  "start_build_mode",
  "grok_trace_export",
  "interject_prompt",
  "mcp_marketplace_install",
  "mcp_marketplace_set_enabled",
  "open_url_in_browser",
  "outside_connectors_simulate",
  "pty_create",
  "pty_resize",
  "pty_write",
  "recheck_build_blocker",
  "request_goal_replan",
  "resume_build",
  "send_prompt",
  "synthesize_voice",
  "task_kill",
  "task_pause",
  "task_resume",
  "transcribe_audio_blob",
]);
const promotedTauriAbsentStateCommands = new Set([
  "agent_cli_setup_cancel_install",
  "halt_build",
  "pause_build",
  "pty_kill",
  "reject_build_plan",
]);
const promotedDebugApiReads = new Set([
  "GET /agent-doc/shellx-host/SKILL.md",
  "GET /browser/bookmarks",
  "GET /browser/check",
  "GET /browser/settle",
  "GET /browser/teach/drafts",
  "GET /browser/developer-mode",
  "GET /browser/dialogs",
  "GET /browser/downloads",
  "GET /browser/engine-pool",
  "GET /browser/evidence",
  "GET /browser/history",
  "GET /browser/logs",
  "GET /browser/network",
  "GET /browser/permissions",
  "GET /browser/personal-lock",
  "GET /browser/popups",
  "GET /browser/privacy",
  "GET /browser/receipts",
  "GET /browser/requests",
  "GET /browser/robots",
  "GET /browser/shields",
  "GET /browser/state",
  "GET /browser/storage-state",
  "GET /browser/uploads",
  "GET /events",
  "GET /events/recent",
  "GET /build/receipts",
  "GET /outside-connectors",
  "GET /outside-connectors/capabilities",
  "GET /outside-connectors/events",
  "GET /provider-adapters/state",
  "GET /provider-sessions/state",
  "GET /preview/work/diagnose",
  "GET /screenshot",
  "GET /sessions/:id/snippet",
  "GET /sessions/history",
  "GET /sessions/history/:id",
  "GET /sessions/search",
  "GET /state/agent_cli_setup",
  "GET /state/environment",
  "GET /state/files",
  "GET /state/github",
  "GET /state/github/items",
  "GET /state/session_git",
  "GET /state/session_git/diff",
  "GET /state/model_instruction_cards",
  "GET /state/session_activity",
  "GET /state/skills",
  "GET /state/subagents",
  "GET /state/grok_environment",
  "GET /vault/agent-requests",
  "GET /vault/e2e/audit",
  "GET /vault/grants",
  "GET /vault/keys",
  "GET /vault/resources",
]);
const promotedDebugApiMutations = new Set([
  "POST /browser/bookmarks",
  "POST /browser/bookmarks/reorder",
  "DELETE /browser/bookmarks/:bookmark_id",
]);
const promotedDebugApiGitMutations = new Set([
  "POST /state/session_git/checkpoint",
  "POST /state/session_git/worktree",
]);
const promotedDebugApiBrowserVaultDepositMutations = new Set([
  "POST /browser/vault-deposits",
]);
const promotedDebugApiBrowserWindowMutations = new Set([
  "POST /browser/open",
]);
const promotedDebugApiGoalLifecycleMutations = new Set([
  "POST /goal/start",
  "POST /goal/stop",
  "POST /goal/pause",
  "POST /goal/resume",
  "POST /goal/reject",
  "POST /goal/complete",
]);
const promotedDebugApiVaultOpenPanelMutations = new Set([
  "POST /vault/open-panel",
]);
const promotedDebugApiProviderLifecycleMutations = new Set([
  "POST /connect",
  "POST /provider-adapters/run",
  "POST /provider-sessions/start",
]);
const promotedDebugApiBrowserLifecycleMutations = new Set([
  "POST /browser/action",
  "POST /browser/cdp/execute",
  "POST /browser/task/start",
  "POST /browser/task/finish",
  "POST /browser/task/control",
  "POST /browser/tabs/close",
  "POST /browser/tabs/focus",
  "POST /browser/tabs/heartbeat",
  "POST /browser/tabs/lock",
  "POST /browser/tabs/open",
  "POST /browser/tabs/reorder",
  "POST /browser/tabs/unlock",
]);
const promotedDebugApiBrowserTeachDeveloperMutations = new Set([
  "POST /browser/developer/inspect",
  "POST /browser/teach/prepare",
  "POST /browser/teach/revise",
]);
const promotedDebugApiBrowserEvidenceArtifactMutations = new Set([
  "POST /browser/evaluations",
  "POST /browser/flight-recorder/export",
  "POST /browser/har/export",
  "POST /browser/performance/export",
  "POST /browser/recipes/export",
  "POST /browser/recipes/replay",
  "POST /browser/storage-state/export",
  "POST /browser/trace/export",
]);
const promotedDebugApiBrowserMonotonicMutations = new Set([
  "POST /browser/logs",
  "POST /browser/popups",
  "POST /browser/report",
]);
const promotedDebugApiBrowserTransferIntentMutations = new Set([
  "POST /browser/downloads/complete",
  "POST /browser/downloads/request",
  "POST /browser/uploads/complete",
  "POST /browser/uploads/request",
]);
const promotedDebugApiBrowserRobotMutations = new Set([
  "POST /browser/robots/schedule",
  "POST /browser/robots/run",
  "POST /browser/robots/cancel",
]);
const promotedDebugApiBrowserPendingRequestMutations = new Set([
  "POST /browser/dialogs",
  "POST /browser/permissions",
  "POST /browser/session-grants/apply",
  "POST /browser/session-grants/request",
]);
const promotedDebugApiBrowserRenderedCheckMutations = new Set([
  "POST /browser/rendered-check",
]);
const promotedDebugApiPreviewLifecycleMutations = new Set([
  "POST /preview/work/start",
  "POST /preview/work/restart",
  "POST /preview/work/stop",
]);
const promotedDebugApiVaultMutations = new Set([
  "POST /vault/set",
  "POST /vault/delete",
]);
const promotedDebugApiVaultSetupMutations = new Set([
  "POST /vault/setup/begin",
  "POST /vault/setup/confirm-recovery",
  "POST /vault/lock",
  "POST /vault/remember-device",
]);
const promotedDebugApiVaultAgentRequestMutations = new Set([
  "POST /vault/agent-requests",
  "POST /vault/agent-requests/:request_id/cancel",
]);
const promotedDebugApiFsWatchMutations = new Set([
  "POST /tools/fs_watch",
  "DELETE /tools/fs_watch/:watchId",
]);
const promotedDebugApiTauriInvokeRelayMutations = new Set([
  "POST /release-test/tauri-invokes",
  "GET /release-test/tauri-invokes/:id",
  "DELETE /release-test/tauri-invokes/:id",
  "POST /release-test/tauri-invokes/:id/claim",
  "POST /release-test/tauri-invokes/:id/complete",
]);
const promotedDebugApiEnginePoolMutations = new Set([
  "POST /browser/engine-pool",
]);
const promotedDebugApiPanelMutations = new Set([
  "POST /panels",
]);
const promotedDebugApiPreviewTargetMutations = new Set([
  "POST /preview",
]);
const promotedDebugApiSettingsMutations = new Set([
  "POST /settings",
]);
const promotedDebugApiConnectionMutations = new Set([
  "POST /connections",
  "DELETE /connections/:id",
]);
const promotedDebugApiOutsideConnectorMutations = new Set([
  "POST /outside-connectors",
  "DELETE /outside-connectors/:id",
]);
const promotedDebugApiUiMutations = new Set([
  "POST /state/ui",
]);
const promotedDebugApiOperatorGates = new Set([
  "POST /browser/privacy",
  "POST /browser/personal-lock",
  "POST /browser/shields",
  "POST /browser/shields/site",
  "DELETE /browser/shields/site/:host",
  "POST /browser/developer-mode",
  "POST /browser/developer-mode/approval",
  "POST /browser/dialogs/resolve",
  "POST /browser/permissions/resolve",
  "POST /browser/session-grants/resolve",
  "POST /browser/task/autonomy",
]);
const promotedDebugApiVaultE2eMutations = new Set([
  "POST /vault/e2e/reset",
  "POST /vault/e2e/seed-secret",
  "POST /vault/e2e/approve-grant",
  "POST /vault/e2e/deny-grant",
  "POST /vault/e2e/revoke-grant",
  "POST /vault/e2e/expire-grant",
  "POST /vault/e2e/probe-use",
]);
const promotedDebugApiVaultGrantMutations = new Set([
  "POST /vault/grants",
  "POST /vault/grants/:grant_id/revoke",
]);
const promotedDebugApiBoundedPostReads = new Set([
  "POST /diagnostics",
]);
const promotedDebugApiClipboardLifecycles = new Set([
  "POST /release-test/clipboard",
]);
const promotedDebugApiNativePickerLifecycles = new Set([
  "POST /release-test/native-picker",
  "GET /release-test/native-picker",
  "DELETE /release-test/native-picker",
]);
const promotedDebugApiRemoteApprovalGates = new Set([
  "POST /github/pr/create",
]);
const promotedDebugApiRawRevealDenials = new Set([
  "POST /vault/get",
]);
const promotedDebugApiSafeRefusals = new Set([
  "POST /abort",
  "POST /agent_cli_setup/install/cancel",
  "POST /agent_cli_setup/install/confirm",
  "POST /agent_cli_setup/install/prepare",
  "POST /agent_cli_setup/recheck",
  "POST /autonomy",
  "POST /build/receipt",
  "POST /build/start",
  "POST /build/approve",
  "POST /build/complete",
  "POST /build/operator_note",
  "POST /build/pause",
  "POST /build/recheck_blocker",
  "POST /build/reject",
  "POST /build/resume",
  "POST /build/stop",
  "POST /browser/vault/fill-receipt",
  "POST /browser/vault/generate-receipt",
  "POST /connections/:id/test",
  "POST /connections/provider-scan",
  "POST /disconnect",
  "POST /goal/approve",
  "POST /outside-connectors/:id/simulate",
  "POST /outside-connectors/:id/test",
  "POST /permissions/:reqId/respond",
  "POST /plan",
  "POST /preview/work/diagnose",
  "POST /prompt",
  "POST /provider-sessions/abort",
  "POST /sessions/:id/archive",
  "POST /tabs/:id/archive",
  "POST /state/environment/trace_export",
  "POST /state/grok_environment/trace_export",
  "POST /tools/process_attach_stdout",
  "POST /tools/process_list",
  "POST /tools/process_signal",
  "POST /tools/process_stats",
  "POST /tools/secret_get",
]);
const promotedBrowserCliWorkflows = new Set([
  "flight-recorder-export",
  "workflow-evaluate",
]);
const promotedBrowserCliReads = new Set([
  "workflow-bookmarks",
]);
const promotedBrowserCliRenderedChecks = new Set([
  "rendered-check",
]);
const promotedBrowserCliArtifacts = new Set([
  "screenshot",
  "trace-open",
]);
const promotedBrowserCliRecipeWorkflows = new Set([
  "workflow-save",
  "workflow-replay",
]);
const promotedBrowserCliActions = new Set([
  "clear-site-data",
  "click-at",
  "click-ref",
  "extract",
  "fill-ref",
  "navigate",
  "observe",
  "resolve-dialog",
  "run-steps",
  "type-text",
  "verify",
  "wait-for",
]);
const promotedKeyboardShortcuts = new Set([
  "diff-next",
  "diff-prev",
  "diff-accept",
  "diff-reject",
]);
const promotedPaletteActions = new Set([
  "act-abort",
  "act-attach-screenshot",
  "act-connect",
  "act-preview-doctor",
]);
const irreducibleSmallSurfaceBlockers = new Map<string, string>([
  ["ui-control:src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-copy-address\"]@src/browser/components/BrowserChrome.tsx#16", "Invoking Copy address overwrites the operator clipboard, whose prior contents cannot be read and restored exactly across supported platforms."],
]);
const promotedShellxCommands = new Set(["/build", "/goal", "/pause", "/resume", "/stop"]);
const promotedHostMcpReads = new Set([
  "environment",
  "Agent_metrics",
  "Agent_output",
  "Agent_poll_all",
  "Agent_status",
  "capabilities_summary",
  "cut_read",
  "browser_locks",
  "browser_check",
  "browser_downloads",
  "browser_evidence",
  "browser_extract",
  "browser_observe",
  "browser_read",
  "browser_rendered_check",
  "browser_state",
  "browser_tabs",
  "browser_workflows",
  "browser_verify",
  "browser_wait_for",
  "build_receipts",
  "build_state",
  "clock_now",
  "event_log",
  "fs_exists",
  "fs_grep",
  "fs_list_dir",
  "fs_read",
  "fs_read_binary",
  "fs_stat",
  "fs_unwatch",
  "grok_environment",
  "get_session_info",
  "host_read",
  "mem_get",
  "mem_list",
  "model_instruction_cards",
  "preview_diagnose",
  "preview_logs",
  "preview_state",
  "process_attach_stdout",
  "process_list",
  "process_stats",
  "provider_adapters",
  "provider_sessions",
  "search_tool",
  "session_environment",
  "session_tooling",
  "shellx_health",
  "sleep_ms",
  "secret_get",
  "vault_deposit",
  "vault_list",
  "vault_list_grants",
]);
const promotedHostMcpWrites = new Set([
  "Agent",
  "Agent_kill",
  "browser_act",
  "browser_clear_site_data",
  "browser_evaluation_write",
  "browser_flight_recorder_export",
  "browser_click_at",
  "browser_click_ref",
  "browser_fill_ref",
  "browser_navigate",
  "browser_resolve_dialog",
  "browser_run_steps",
  "browser_save_page",
  "browser_screenshot",
  "browser_type_text",
  "browser_trace_open",
  "browser_workflow_replay",
  "browser_workflow_save",
  "build_checkpoint",
  "build_complete",
  "build_receipt",
  "fs_append",
  "fs_copy",
  "fs_delete",
  "fs_ensure_dir",
  "fs_watch",
  "fs_write",
  "host_act",
  "cut_act",
  "goal_complete",
  "mem_delete",
  "mem_set",
  "net_fetch",
  "process_signal",
  "preview_start",
  "secret_delete",
  "secret_set",
  "security_scan",
  "send_prompt_to_provider",
  "send_prompt_to_session",
  "vault_agent_request",
  "vault_generate",
  "vault_request_grant",
  "vision_describe",
  "vision_describe_v2",
  "voice_stt_v2",
  "voice_tts",
  "x_search",
  "browser_capture_secret_to_vault",
  "browser_read_email_code",
  "browser_use_agent_wallet",
]);
const promotedHostMcpBrowserFixtureTools = new Set([
  "browser_act",
  "browser_clear_site_data",
  "browser_click_at",
  "browser_click_ref",
  "browser_extract",
  "browser_flight_recorder_export",
  "browser_fill_ref",
  "browser_navigate",
  "browser_observe",
  "browser_run_steps",
  "browser_save_page",
  "browser_screenshot",
  "browser_type_text",
  "browser_trace_open",
  "browser_verify",
  "browser_wait_for",
  "browser_capture_secret_to_vault",
  "browser_read_email_code",
  "browser_use_agent_wallet",
]);
const promotedVaultProfileDraftPlaceholders = [
  "Card label",
  "Full name",
  "Email",
  "Username",
  "Company",
  "Role",
  "Phone",
  "Address line 1",
  "Address line 2",
  "City",
  "Region",
  "Postal code",
  "Country",
];
const promotedVaultWalletDraftPlaceholders = [
  "Wallet label",
  "Stripe API secret ref",
  "Webhook signing secret ref",
  "Stripe account ref",
  "Stripe cardholder ref",
  "Stripe card ref",
  "Budget summary",
  "Allowed origins, comma-separated",
  "Allowed categories, comma-separated",
];
const promotedUiControls = new Map<string, {
  fixtureId: string;
  expectedEffect: string;
  oracleId: string;
  cleanupId: string;
}>([
  ["src/components/Header.tsx:[aria-label=\"About shellX — version and source\"]", {
    fixtureId: "ui:header-dialog-closed",
    expectedEffect: "A native click opens Settings with the About tab selected and its owned tabpanel visible.",
    oracleId: "ui:activation:about-settings-state",
    cleanupId: "ui:close-header-dialog",
  }],
  ["src/components/Header.tsx:[aria-label=\"Open plugins\"]", {
    fixtureId: "ui:header-dialog-closed",
    expectedEffect: "A native click opens the exactly labelled Plugins dialog.",
    oracleId: "ui:activation:plugins-dialog-opened",
    cleanupId: "ui:close-header-dialog",
  }],
  ["src/components/Header.tsx:[aria-label=\"Open settings\"]", {
    fixtureId: "ui:header-dialog-closed",
    expectedEffect: "A native click opens the exactly labelled Settings dialog.",
    oracleId: "ui:activation:settings-dialog-opened",
    cleanupId: "ui:close-header-dialog",
  }],
  ["src/components/Header.tsx:[aria-label=\"Open connector inbox\"]", {
    fixtureId: "ui:owned-modal-closed",
    expectedEffect: "A native click opens the exactly labelled Connector Inbox dialog.",
    oracleId: "ui:activation:owned-modal-opened",
    cleanupId: "ui:close-owned-modal",
  }],
  ["src/components/Header.tsx:[data-debug-id=\"header-theme-toggle\"]", {
    fixtureId: "ui:isolated-default-theme",
    expectedEffect: "A native click changes both the header toggle state and persisted theme, then a second native click restores the exact isolated baseline.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-isolated-theme-baseline",
  }],
  ["src/components/ConnectionEditor.tsx:[data-debug-id=\"surface-components-connectioneditor-16\"]", {
    fixtureId: "ui:owned-connection-record-edit",
    expectedEffect: "Native label input plus Save changes only one owned local preset label and reopens Saved connections before exact directory restoration.",
    oracleId: "ui:activation:owned-connection-record-saved",
    cleanupId: "ui:close-connection-ui-delete-owned-record-restore-directory",
  }],
  ["src/components/ConnectionEditor.tsx:[data-debug-id=\"surface-components-connectioneditor-12\"]", {
    fixtureId: "ui:owned-connection-record-local-probe",
    expectedEffect: "A native Scan CLIs click runs the real local provider discovery, bounded version probes, and executable identity hashes for all four supported agents, renders the result, and leaves the unsaved owned preset unchanged.",
    oracleId: "ui:activation:owned-connection-provider-scan-completed",
    cleanupId: "ui:close-connection-ui-delete-owned-record-restore-directory",
  }],
  ["src/components/ConnectionEditor.tsx:[data-debug-id=\"surface-components-connectioneditor-14\"]", {
    fixtureId: "ui:owned-connection-record-local-probe",
    expectedEffect: "A native editor Test click runs the real disposable local connection and provider probe, renders its bounded result, and persists a four-provider version/hash snapshot only on the owned preset.",
    oracleId: "ui:activation:owned-connection-test-completed",
    cleanupId: "ui:close-connection-ui-delete-owned-record-restore-directory",
  }],
  ["src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-agent-cli-setup-open\"]", {
    fixtureId: "ui:owned-connection-record-local-probe",
    expectedEffect: "Native installed input completes the real owned local provider scan and opens the connection-scoped Agent CLI setup assistant with inspected provider cards without preparing or confirming an installation.",
    oracleId: "ui:activation:owned-connection-agent-setup-opened",
    cleanupId: "ui:close-connection-ui-delete-owned-record-restore-directory",
  }],
  ["src/components/ConnectionPicker.tsx:[aria-label^=\"Delete \"]", {
    fixtureId: "ui:owned-connection-record-picker",
    expectedEffect: "A native click opens the bounded in-app delete confirmation for one exact owned local preset without changing the connection directory.",
    oracleId: "ui:activation:owned-connection-delete-confirmation-opened",
    cleanupId: "ui:close-connection-ui-delete-owned-record-restore-directory",
  }],
  ["src/components/ConnectionPicker.tsx:role=button;name=\"Cancel\"", {
    fixtureId: "ui:owned-connection-record-picker",
    expectedEffect: "A native click cancels the bounded in-app delete confirmation and preserves the exact owned local preset.",
    oracleId: "ui:activation:owned-connection-delete-cancelled",
    cleanupId: "ui:close-connection-ui-delete-owned-record-restore-directory",
  }],
  ["src/components/ConnectionPicker.tsx:[aria-label=\"Confirm delete connection\"]", {
    fixtureId: "ui:owned-connection-record-picker",
    expectedEffect: "A native click confirms the bounded in-app deletion and removes only one exact owned local preset before byte-for-byte directory restoration.",
    oracleId: "ui:activation:owned-connection-record-deleted",
    cleanupId: "ui:close-connection-ui-delete-owned-record-restore-directory",
  }],
  ["src/components/ConnectionPicker.tsx:role=button;name=\"Edit\"", {
    fixtureId: "ui:owned-connection-record-picker",
    expectedEffect: "A native click on one exact label-addressed owned local preset opens ConnectionEditor while its directory record remains state-exact.",
    oracleId: "ui:activation:owned-connection-editor-opened",
    cleanupId: "ui:close-connection-ui-delete-owned-record-restore-directory",
  }],
  ["src/components/ConnectionPicker.tsx:[title^=\"Use \"]", {
    fixtureId: "ui:owned-connection-record-local-probe",
    expectedEffect: "A native Use click selects only the exact disposable local preset on the active tab and completes its real provider version/hash scan before cleanup restores the original active-tab state.",
    oracleId: "ui:activation:owned-connection-selected",
    cleanupId: "ui:close-connection-ui-delete-owned-record-restore-directory",
  }],
  ["src/components/ConnectionPicker.tsx:role=button;name=\"Test\"", {
    fixtureId: "ui:owned-connection-record-local-probe",
    expectedEffect: "A native picker Test click runs the real disposable local connection and provider probe, renders its bounded result, and persists a four-provider version/hash snapshot only on the owned preset.",
    oracleId: "ui:activation:owned-connection-test-completed",
    cleanupId: "ui:close-connection-ui-delete-owned-record-restore-directory",
  }],
  ["src/components/settings/ConnectionsTab.tsx:[data-debug-id=\"surface-components-settings-connectionstab-2\"]", {
    fixtureId: "ui:owned-connection-record-settings",
    expectedEffect: "A native Refresh click discards one deliberately stale owned Settings row and renders the byte-exact isolated connection directory.",
    oracleId: "ui:activation:owned-connection-directory-refreshed",
    cleanupId: "ui:close-connection-ui-delete-owned-record-restore-directory",
  }],
  ["src/components/settings/ConnectionsTab.tsx:[title=\"Edit this connection\"]", {
    fixtureId: "ui:owned-connection-record-settings",
    expectedEffect: "A native click on the exact owned Settings row opens ConnectionEditor without changing the isolated connection record.",
    oracleId: "ui:activation:owned-connection-editor-opened",
    cleanupId: "ui:close-connection-ui-delete-owned-record-restore-directory",
  }],
  ["src/components/settings/ConnectionsTab.tsx:[title=\"Delete this connection preset\"]", {
    fixtureId: "ui:owned-connection-record-settings",
    expectedEffect: "A native Settings-row Delete click opens the bounded in-app confirmation without changing the owned preset.",
    oracleId: "ui:activation:owned-connection-delete-confirmation-opened",
    cleanupId: "ui:close-connection-ui-delete-owned-record-restore-directory",
  }],
  ["src/components/settings/ConnectionsTab.tsx:[aria-label=\"Cancel delete connection\"]", {
    fixtureId: "ui:owned-connection-record-settings",
    expectedEffect: "A native Cancel click closes the bounded Settings deletion confirmation and preserves the exact owned preset.",
    oracleId: "ui:activation:owned-connection-delete-cancelled",
    cleanupId: "ui:close-connection-ui-delete-owned-record-restore-directory",
  }],
  ["src/components/settings/ConnectionsTab.tsx:[aria-label=\"Confirm delete saved connection\"]", {
    fixtureId: "ui:owned-connection-record-settings",
    expectedEffect: "A native confirmation click removes only the owned Settings preset and restores the directory byte-for-byte.",
    oracleId: "ui:activation:owned-connection-record-deleted",
    cleanupId: "ui:close-connection-ui-delete-owned-record-restore-directory",
  }],
  [BRANCH_PICKER_LIFECYCLE_UI_SURFACE_NAME, {
    fixtureId: "ui:owned-branch-picker-selection",
    expectedEffect: "A native click selects release-proof only on one disposable renderer tab bound to the exact owned temporary Git repository.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:close-owned-branch-picker-tab-delete-temp-git-and-restore-baseline",
  }],
  ["src/components/BottomPanel.tsx:[data-debug-id=\"bottom-tab-chat\"]", {
    fixtureId: "ui:bottom-tab-opposite-baseline",
    expectedEffect: "A native click changes both renderer state and the active bottom-tab owner to Chat.",
    oracleId: "ui:activation:bottom-tab-chat-state-transition",
    cleanupId: "ui:restore-bottom-tab-baseline",
  }],
  ["src/components/BottomPanel.tsx:[data-debug-id=\"bottom-tab-terminal\"]", {
    fixtureId: "ui:bottom-tab-opposite-baseline",
    expectedEffect: "A native click changes both renderer state and the active bottom-tab owner to Terminal.",
    oracleId: "ui:activation:bottom-tab-terminal-state-transition",
    cleanupId: "ui:restore-bottom-tab-baseline",
  }],
  ["src/components/BottomPanel.tsx:[data-debug-id=\"bottom-tab-images\"]", {
    fixtureId: "ui:bottom-tab-opposite-baseline",
    expectedEffect: "A native click opens the Images bottom tab from an owned opposite baseline, including its intentional empty state, before exact restoration.",
    oracleId: "ui:activation:bottom-tab-images-state-transition",
    cleanupId: "ui:restore-bottom-tab-baseline",
  }],
  ["src/components/BottomPanel.tsx:[aria-label^=\"Remove \"]", {
    fixtureId: "ui:bottom-panel-owned-tab-attachment",
    expectedEffect: "A native click removes exactly the owned attachment chip and its inlined text state without changing the owned tab prompt or any baseline attachment.",
    oracleId: "ui:activation:owned-attachment-removed",
    cleanupId: "ui:remove-owned-attachment-clear-prompt-delete-files-close-tab-restore-baseline",
  }],
  ["src/components/BottomPanel.tsx:role=button;name=\"Inspect\"", {
    fixtureId: "ui:bottom-panel-owned-tab-attachment",
    expectedEffect: "A native click inserts the exact Inspect helper text for the owned attachment without sending it or invoking a provider.",
    oracleId: "ui:activation:owned-attachment-prompt-transition",
    cleanupId: "ui:remove-owned-attachment-clear-prompt-delete-files-close-tab-restore-baseline",
  }],
  ["src/components/BottomPanel.tsx:role=button;name=\"Summarize\"", {
    fixtureId: "ui:bottom-panel-owned-tab-attachment",
    expectedEffect: "A native click inserts the exact Summarize helper text for the owned attachment without sending it or invoking a provider.",
    oracleId: "ui:activation:owned-attachment-prompt-transition",
    cleanupId: "ui:remove-owned-attachment-clear-prompt-delete-files-close-tab-restore-baseline",
  }],
  ["src/components/BottomPanel.tsx:role=button;name=\"Find\"", {
    fixtureId: "ui:attachment-media-owned-lifecycle",
    expectedEffect: "A native click opens the exact attachment Find prompt and accepts a bounded owned query before inserting its deterministic composer draft without launching a provider.",
    oracleId: "ui:activation:owned-attachment-prompt-inserted",
    cleanupId: "ui:clear-owned-attachment-media-and-delete-root",
  }],
  ["src/components/BottomPanel.tsx:[data-debug-id=\"surface-components-bottompanel-23\"]", {
    fixtureId: "ui:bottom-panel-owned-tab-agent-choice",
    expectedEffect: "A native click selects one exact ready Codex row and persists it only into a disposable owned tab before clearing the scan fixture and deleting the tab.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:clear-owned-agent-scan-close-tab-restore-baseline",
  }],
  ["src/components/BottomPanel.tsx:[aria-label=\"Turn voice chat off and cancel active listening\"]", {
    fixtureId: "ui:bottom-panel-owned-tab-voice-capture",
    expectedEffect: "A native click invokes the real MicButton cancel transition from an isolated active capture, returns the mic to idle, clears the owned tab voice mode, and removes the off control without requesting a microphone or provider.",
    oracleId: "ui:activation:owned-voice-capture-cancelled",
    cleanupId: "ui:clear-owned-voice-capture-close-tab-restore-baseline",
  }],
  ["src/components/MicButton.tsx:[data-release-control=\"composer-mic-button\"]", {
    fixtureId: "ui:bottom-panel-owned-tab-mic-stop",
    expectedEffect: "A native click invokes the real MicButton stop boundary from an isolated active capture, returns the control to idle, and never requests a microphone or transcription provider.",
    oracleId: "ui:activation:owned-mic-capture-stopped",
    cleanupId: "ui:clear-owned-mic-stop-close-tab-restore-baseline",
  }],
  ["src/components/BottomPanel.tsx:[data-debug-id=\"surface-components-bottompanel-24\"]", {
    fixtureId: "ui:bottom-panel-owned-tab-slash-command",
    expectedEffect: "A native click selects the deterministic built-in /commands row and inserts its exact text into the owned tab composer without sending it.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:clear-owned-prompt-close-tab-restore-baseline",
  }],
  ["src/components/BottomPanel.tsx:[data-debug-id=\"surface-components-bottompanel-9\"]", {
    fixtureId: "ui:bottom-panel-owned-tab-media",
    expectedEffect: "A native click opens Preview Center for the exact owned event-projected image path without reading or sending unrelated media.",
    oracleId: "ui:activation:owned-media-preview-opened",
    cleanupId: "ui:close-preview-clear-owned-events-delete-files-close-tab-restore-baseline",
  }],
  ["src/components/BottomPanel.tsx:[data-debug-id=\"bottom-tab-videos\"]", {
    fixtureId: "ui:bottom-tab-opposite-baseline",
    expectedEffect: "A native click opens the Videos bottom tab from an owned opposite baseline, including its intentional empty state, before exact restoration.",
    oracleId: "ui:activation:bottom-tab-videos-state-transition",
    cleanupId: "ui:restore-bottom-tab-baseline",
  }],
  ["src/components/BottomPanel.tsx:[data-debug-id=\"bottom-tab-logs\"]", {
    fixtureId: "ui:bottom-tab-opposite-baseline",
    expectedEffect: "A native click changes both renderer state and the active bottom-tab owner to Logs.",
    oracleId: "ui:activation:bottom-tab-logs-state-transition",
    cleanupId: "ui:restore-bottom-tab-baseline",
  }],
  ["src/components/BottomPanel.tsx:[data-debug-id=\"bottom-tab-stderr\"]", {
    fixtureId: "ui:bottom-tab-opposite-baseline",
    expectedEffect: "A native click changes both renderer state and the active bottom-tab owner to Stderr.",
    oracleId: "ui:activation:bottom-tab-stderr-state-transition",
    cleanupId: "ui:restore-bottom-tab-baseline",
  }],
  ["src/components/Settings.tsx:[aria-label=\"Close settings\"]", {
    fixtureId: "ui:header-dialog-open",
    expectedEffect: "A native click closes the prepared Settings dialog and restores the exact closed baseline.",
    oracleId: "ui:activation:settings-dialog-closed",
    cleanupId: "ui:close-header-dialog",
  }],
  ["src/components/PluginsModal.tsx:[aria-label=\"Close\"]", {
    fixtureId: "ui:header-dialog-open",
    expectedEffect: "A native click closes the prepared Plugins dialog and restores the exact closed baseline.",
    oracleId: "ui:activation:plugins-dialog-closed",
    cleanupId: "ui:close-header-dialog",
  }],
  ["src/components/LeftRail.tsx:[data-debug-id=\"left-add-project\"]", {
    fixtureId: "ui:empty-project-list",
    expectedEffect: "A native click creates one inline project draft; clearing and blurring the owned draft removes it and restores the exact empty project baseline.",
    oracleId: "ui:activation:project-draft-created",
    cleanupId: "ui:delete-owned-project-draft",
  }],
  ["src/components/LeftRail.tsx:[data-debug-id=\"left-project-rename-input\"]", {
    fixtureId: "ui:empty-project-list",
    expectedEffect: "Native text entry changes the isolated inline project name draft before clearing and blurring it to restore the exact empty project list.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:delete-owned-project-draft",
  }],
  ["src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-3\"]", {
    fixtureId: "ui:owned-project-row-collapsed",
    expectedEffect: "A native click expands one isolated owned project row before exact marker deletion and empty-list restoration.",
    oracleId: "ui:disclosure-state-transition",
    cleanupId: "ui:delete-owned-project-marker",
  }],
  ["src/components/LeftRail.tsx:[title$=\" — double-click to rename — drop a chat here to file it\"]", {
    fixtureId: "ui:owned-project-row-collapsed",
    expectedEffect: "A native click expands one isolated owned project through its main row before exact marker deletion and empty-list restoration.",
    oracleId: "ui:disclosure-state-transition",
    cleanupId: "ui:delete-owned-project-marker",
  }],
  ["src/components/LeftRail.tsx:[aria-label=\"Delete project\"]", {
    fixtureId: "ui:owned-project-row-collapsed",
    expectedEffect: "A native click opens the exact owned project's deletion dialog before marker-only cleanup restores the empty project list.",
    oracleId: "ui:activation:project-delete-dialog-opened",
    cleanupId: "ui:delete-owned-project-marker",
  }],
  ["src/components/LeftRail.tsx:[title^=\"Remove the label only — the \"][title$=\" chat(s) stay and reappear under \\\"Past chats\\\".|Remove the project label.\"]", {
    fixtureId: "ui:owned-project-delete-dialog",
    expectedEffect: "A native click deletes only the isolated empty project marker and restores the exact empty project list.",
    oracleId: "ui:activation:project-marker-deleted",
    cleanupId: "ui:delete-owned-project-marker",
  }],
  ["src/components/settings/ConnectorsTab.tsx:role=button;name=\"New\"", {
    fixtureId: "ui:connectors-draft-closed",
    expectedEffect: "A native click opens a new unsaved Connector draft with the exact bounded default state before deterministic cancellation and Settings restoration.",
    oracleId: "ui:activation:connectors-draft-opened",
    cleanupId: "ui:restore-connectors-draft-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:[aria-label=\"Cancel connector draft\"]", {
    fixtureId: "ui:connectors-unsaved-draft-open",
    expectedEffect: "A native click cancels the unsaved Connector draft, discards bounded local text, and restores the exact closed state without saving.",
    oracleId: "ui:activation:connectors-draft-closed",
    cleanupId: "ui:restore-connectors-draft-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:[data-debug-id=\"surface-components-settings-connectorstab-3\"]", {
    fixtureId: "ui:connectors-unsaved-draft-baseline",
    expectedEffect: "A native click changes only the unsaved connector provider draft from Telegram to Discord before exact default-state restoration.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:restore-connectors-draft-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:role=button;name=\"Paused\"", {
    fixtureId: "ui:connectors-unsaved-draft-baseline",
    expectedEffect: "Native clicks prepare Live and select Paused only in the unsaved connector draft before exact default-state restoration.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-connectors-draft-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:role=button;name=\"Live\"", {
    fixtureId: "ui:connectors-unsaved-draft-baseline",
    expectedEffect: "A native click selects Live only in the unsaved connector draft before exact default-state restoration.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-connectors-draft-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:role=button;name=\"Inbox\"", {
    fixtureId: "ui:connectors-unsaved-draft-baseline",
    expectedEffect: "Native clicks prepare Session chat and select Inbox only in the unsaved connector draft before exact default-state restoration.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-connectors-draft-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:[title^=\"Send allowlisted \"][title$=\" messages to the active session\"]", {
    fixtureId: "ui:connectors-unsaved-draft-baseline",
    expectedEffect: "A native click selects Session chat only in the unsaved connector draft before exact Inbox restoration.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-connectors-draft-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:[data-debug-id=\"connector-approval-review-first\"]", {
    fixtureId: "ui:connectors-unsaved-draft-baseline",
    expectedEffect: "Native clicks prepare Auto-dispatch and select Review first only in the unsaved connector draft before exact default-state restoration.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-connectors-draft-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:[data-debug-id=\"connector-approval-auto-dispatch\"]", {
    fixtureId: "ui:connectors-unsaved-draft-baseline",
    expectedEffect: "A native click selects Auto-dispatch only in the unsaved connector draft before exact Review first restoration.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-connectors-draft-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:[data-debug-id=\"surface-components-settings-connectorstab-21\"]", {
    fixtureId: "ui:connectors-unsaved-draft-baseline",
    expectedEffect: "Native text entry changes only the unsaved connector Vault key reference before exact restoration without retaining its contents.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-connectors-draft-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:[id=\"connector-allowed\"]", {
    fixtureId: "ui:connectors-unsaved-draft-baseline",
    expectedEffect: "Native text entry changes only the unsaved connector allowlist before exact clearing without retaining its contents.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-connectors-draft-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:[id=\"connector-target\"]", {
    fixtureId: "ui:connectors-unsaved-draft-baseline",
    expectedEffect: "Native selection changes only the unsaved connector target mode without selecting or retaining a tab identifier before exact restoration.",
    oracleId: "ui:choice-state-transition",
    cleanupId: "ui:restore-connectors-draft-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:[id=\"connector-sim-sender\"]", {
    fixtureId: "ui:connectors-unsaved-draft-baseline",
    expectedEffect: "Native text entry changes only the unsaved inbound-simulator sender draft before exact clearing without retaining its contents or simulating a message.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-connectors-draft-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:[id=\"connector-sim-conversation\"]", {
    fixtureId: "ui:connectors-unsaved-draft-baseline",
    expectedEffect: "Native text entry changes only the unsaved inbound-simulator conversation draft before exact clearing without retaining its contents or simulating a message.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-connectors-draft-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:[id=\"connector-sim-text\"]", {
    fixtureId: "ui:connectors-unsaved-draft-baseline",
    expectedEffect: "Native text entry changes only the unsaved inbound-simulator message draft before exact clearing without retaining its contents or simulating a message.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-connectors-draft-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:[id=\"connector-secret\"]", {
    fixtureId: "ui:connectors-owned-renderer-fixture",
    expectedEffect: "Native text entry changes and exactly clears only a synthetic unsaved connector token while Save stays disabled and no Vault command runs.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:clear-connectors-owned-fixture-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:[data-debug-id=\"surface-components-settings-connectorstab-11\"]", {
    fixtureId: "ui:connectors-owned-renderer-fixture",
    expectedEffect: "Native selection chooses and exactly clears one synthetic renderer-only session in the unsaved connector target draft without changing a live session.",
    oracleId: "ui:choice-state-transition",
    cleanupId: "ui:clear-connectors-owned-fixture-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:[id=\"connector-sim-connector\"]", {
    fixtureId: "ui:connectors-owned-renderer-fixture",
    expectedEffect: "Native selection changes between two synthetic renderer-only connector options and restores the baseline while Simulate stays disabled.",
    oracleId: "ui:choice-state-transition",
    cleanupId: "ui:clear-connectors-owned-fixture-and-close-settings",
  }],
  ["src/components/settings/ConnectorsTab.tsx:role=button;name=\"Edit\"", {
    fixtureId: "ui:connectors-owned-renderer-fixture",
    expectedEffect: "A native click opens the exact synthetic connector in the local editor and Cancel restores the closed fixture without saving or reading Vault state.",
    oracleId: "ui:activation:owned-connector-edit-opened",
    cleanupId: "ui:clear-connectors-owned-fixture-and-close-settings",
  }],
  ["src/components/RightRail.tsx:[data-debug-id=\"surface-components-rightrail-2\"]", {
    fixtureId: "ui:shellx-tool-exposure-owned-baseline",
    expectedEffect: "Native clicks exercise Native, Bridge, Full, and Off for the active tab, prove the exact backing state after every choice, and restore the prior mode and right-rail tab without starting an agent.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-shellx-tool-exposure-and-right-rail",
  }],
  ["src/components/RightRail.tsx:[title=\"Open the focused plan review dialog.\"]", {
    fixtureId: "ui:right-rail-owned-goal-awaiting-review",
    expectedEffect: "A native click reopens the exact ready Goal review dialog after its automatic presentation is deliberately dismissed, without approving the plan or sending a provider prompt.",
    oracleId: "ui:activation:right-rail-goal-review-opened",
    cleanupId: "ui:forget-owned-goal-delete-cwd-and-restore-right-rail",
  }],
  ["src/components/RightRail.tsx::is([title=\"Pause auto-continuation (only user can pause)\"],[title=\"Resume auto-continuation\"])", {
    fixtureId: "ui:right-rail-owned-goal-active",
    expectedEffect: "Native clicks pause and resume one exact isolated active Goal, proving both dynamic labels and backing pausedByUser transitions without contacting a provider.",
    oracleId: "ui:activation:right-rail-goal-pause-resume-transition",
    cleanupId: "ui:forget-owned-goal-delete-cwd-and-restore-right-rail",
  }],
  ["src/components/RightRail.tsx:[title=\"Mark build as complete — stops the auto-continuation loop. Use when the agent finished but did not call the completion tool itself.\"]", {
    fixtureId: "ui:right-rail-owned-goal-active",
    expectedEffect: "A native click plus the exact trusted-user confirmation marks only the isolated active Goal complete without sending a provider prompt.",
    oracleId: "ui:activation:right-rail-goal-completed",
    cleanupId: "ui:forget-owned-goal-delete-cwd-and-restore-right-rail",
  }],
  ["src/components/ActivityBrowserModal.tsx:[aria-label=\"Close (Esc)\"]", {
    fixtureId: "ui:activity-browser-open",
    expectedEffect: "A native click closes the prepared Activity Browser and restores the exact closed baseline.",
    oracleId: "ui:activation:activity-browser-closed",
    cleanupId: "ui:close-activity-browser",
  }],
  ["src/components/ActivityBrowserModal.tsx:[data-debug-id^=\"activity-evidence-section-\"][data-debug-id$=\"-expand\"]", {
    fixtureId: "ui:activity-evidence-unfocused-grid",
    expectedEffect: "Native clicks expand and restore each concrete member of the dynamic Activity Evidence section family with matching pressed state and focused-grid ownership.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-activity-evidence-focus-and-close",
  }],
  ["src/components/VaultPasswordGenerator.tsx:[data-debug-id=\"vault-password-generator-close\"]", {
    fixtureId: "ui:vault-password-generator-open",
    expectedEffect: "A native click closes the prepared Vault password generator while preserving the open Request Center.",
    oracleId: "ui:activation:vault-password-generator-closed",
    cleanupId: "ui:close-vault-request-action-effect",
  }],
  ["src/components/VaultPasswordGenerator.tsx:[data-debug-id=\"surface-components-vaultpasswordgenerator-5\"]", {
    fixtureId: "ui:vault-password-generator-local-baseline",
    expectedEffect: "Native installed input changes the visible Vault password length slider by one step before exact synchronized length and Request Center restoration without retaining password contents.",
    oracleId: "ui:range-state-transition",
    cleanupId: "ui:restore-vault-password-generator-local-state",
  }],
  ["src/components/VaultPasswordGenerator.tsx:[data-debug-id=\"vault-password-generator-length\"]", {
    fixtureId: "ui:vault-password-generator-local-baseline",
    expectedEffect: "Native installed input changes the visible Vault password numeric control by one step before exact synchronized length and Request Center restoration without retaining password contents.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-vault-password-generator-local-state",
  }],
  ["src/browser/components/DownloadSidecar.tsx:[data-debug-id=\"shellx-browser-downloads-close\"]", {
    fixtureId: "ui:browser-disclosure-open-with-current-page",
    expectedEffect: "A native click closes the prepared Browser Downloads panel while preserving the owned task.",
    oracleId: "ui:activation:browser-downloads-closed",
    cleanupId: "ui:collapse-browser-disclosure-abort-task-and-restore-window",
  }],
  ["src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-bookmark-manager-close\"]", {
    fixtureId: "ui:browser-disclosure-open-with-current-page",
    expectedEffect: "A native click closes the prepared Browser Bookmarks panel while preserving the owned task.",
    oracleId: "ui:activation:browser-bookmarks-closed",
    cleanupId: "ui:collapse-browser-disclosure-abort-task-and-restore-window",
  }],
  ["src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-history-close\"]", {
    fixtureId: "ui:browser-disclosure-open-with-current-page",
    expectedEffect: "A native click closes the prepared Browser History panel while preserving the owned task.",
    oracleId: "ui:activation:browser-history-closed",
    cleanupId: "ui:collapse-browser-disclosure-abort-task-and-restore-window",
  }],
  ["src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-options-close\"]", {
    fixtureId: "ui:browser-disclosure-open-with-current-page",
    expectedEffect: "A native click closes the prepared Browser Options panel while preserving the owned task.",
    oracleId: "ui:activation:browser-options-closed",
    cleanupId: "ui:collapse-browser-disclosure-abort-task-and-restore-window",
  }],
  ["src/components/AttachmentMediaBoard.tsx:[aria-label=\"Close\"]", {
    fixtureId: "ui:owned-modal-open",
    expectedEffect: "A native click closes the prepared Attachment and Media Board dialog.",
    oracleId: "ui:activation:owned-modal-closed",
    cleanupId: "ui:close-owned-modal",
  }],
  ["src/components/AttachmentMediaBoard.tsx:[data-debug-id=\"surface-components-attachmentmediaboard-9\"]", {
    fixtureId: "ui:attachment-media-owned-lifecycle",
    expectedEffect: "A native click previews the exact owned temporary pending attachment with its active-tab context before exact UI and fixture-root cleanup.",
    oracleId: "ui:activation:owned-attachment-preview",
    cleanupId: "ui:clear-owned-attachment-media-and-delete-root",
  }],
  ["src/components/AttachmentMediaBoard.tsx:[aria-label=\"Preview file\"]", {
    fixtureId: "ui:attachment-media-owned-lifecycle",
    expectedEffect: "A native click previews the exact owned temporary pending or sent attachment represented by that concrete occurrence before exact cleanup.",
    oracleId: "ui:activation:owned-attachment-preview",
    cleanupId: "ui:clear-owned-attachment-media-and-delete-root",
  }],
  ["src/components/AttachmentMediaBoard.tsx:[aria-label=\"Remove attachment\"]", {
    fixtureId: "ui:attachment-media-owned-lifecycle",
    expectedEffect: "A native click removes exactly one owned pending attachment chip without deleting its temporary source file before exact cleanup.",
    oracleId: "ui:activation:owned-attachment-removed",
    cleanupId: "ui:clear-owned-attachment-media-and-delete-root",
  }],
  ["src/components/AttachmentMediaBoard.tsx:role=button;name=\"Inspect\"", {
    fixtureId: "ui:attachment-media-owned-lifecycle",
    expectedEffect: "A native click inserts the exact deterministic Inspect draft for one owned pending attachment and closes the board without launching a provider.",
    oracleId: "ui:activation:owned-attachment-prompt-inserted",
    cleanupId: "ui:clear-owned-attachment-media-and-delete-root",
  }],
  ["src/components/AttachmentMediaBoard.tsx:role=button;name=\"Summarize\"", {
    fixtureId: "ui:attachment-media-owned-lifecycle",
    expectedEffect: "A native click inserts the exact deterministic Summarize draft for one owned pending attachment and closes the board without launching a provider.",
    oracleId: "ui:activation:owned-attachment-prompt-inserted",
    cleanupId: "ui:clear-owned-attachment-media-and-delete-root",
  }],
  ["src/components/AttachmentMediaBoard.tsx:role=button;name=\"Find\"", {
    fixtureId: "ui:attachment-media-owned-lifecycle",
    expectedEffect: "A native click opens the exact attachment Find prompt, accepts a bounded owned query, inserts the deterministic draft, and closes the board without launching a provider.",
    oracleId: "ui:activation:owned-attachment-prompt-inserted",
    cleanupId: "ui:clear-owned-attachment-media-and-delete-root",
  }],
  ["src/components/AttachmentMediaBoard.tsx:[data-debug-id=\"surface-components-attachmentmediaboard-12\"]", {
    fixtureId: "ui:attachment-media-owned-lifecycle",
    expectedEffect: "A native click previews the exact owned temporary sent attachment projected only in the disposable renderer fixture before exact cleanup.",
    oracleId: "ui:activation:owned-attachment-preview",
    cleanupId: "ui:clear-owned-attachment-media-and-delete-root",
  }],
  ["src/components/AttachmentMediaBoard.tsx:[data-debug-id=\"surface-components-attachmentmediaboard-14\"]", {
    fixtureId: "ui:attachment-media-owned-lifecycle",
    expectedEffect: "A native click previews the exact owned temporary reusable media asset with its source-tab context before exact cleanup.",
    oracleId: "ui:activation:owned-attachment-preview",
    cleanupId: "ui:clear-owned-attachment-media-and-delete-root",
  }],
  ["src/components/AttachmentMediaBoard.tsx:[aria-label^=\"Preview \"]", {
    fixtureId: "ui:attachment-media-owned-lifecycle",
    expectedEffect: "A native click previews the exact owned reusable image asset with its source-tab context before exact cleanup.",
    oracleId: "ui:activation:owned-attachment-preview",
    cleanupId: "ui:clear-owned-attachment-media-and-delete-root",
  }],
  ["src/components/AttachmentMediaBoard.tsx:[aria-label^=\"Attach \"]", {
    fixtureId: "ui:attachment-media-owned-lifecycle",
    expectedEffect: "A native click copies one owned reusable image into the disposable scope and attaches only that byte-identical imported copy before exact cleanup.",
    oracleId: "ui:activation:owned-asset-attached",
    cleanupId: "ui:clear-owned-attachment-media-and-delete-root",
  }],
  ["src/components/AttachmentMediaBoard.tsx:[aria-label^=\"Import \"]", {
    fixtureId: "ui:attachment-media-owned-lifecycle",
    expectedEffect: "A native click copies one owned reusable image into the disposable scope without attaching it before exact cleanup.",
    oracleId: "ui:activation:owned-asset-imported",
    cleanupId: "ui:clear-owned-attachment-media-and-delete-root",
  }],
  ["src/components/AttachmentMediaBoard.tsx:[data-debug-id=\"surface-components-attachmentmediaboard-18\"]", {
    fixtureId: "ui:attachment-media-owned-lifecycle",
    expectedEffect: "A native click previews the exact owned temporary session image before exact UI and fixture-root cleanup.",
    oracleId: "ui:activation:owned-attachment-preview",
    cleanupId: "ui:clear-owned-attachment-media-and-delete-root",
  }],
  ["src/components/AttachmentMediaBoard.tsx:[data-debug-id=\"surface-components-attachmentmediaboard-19\"]", {
    fixtureId: "ui:attachment-media-owned-lifecycle",
    expectedEffect: "A native click previews the exact owned temporary session video before exact UI and fixture-root cleanup.",
    oracleId: "ui:activation:owned-attachment-preview",
    cleanupId: "ui:clear-owned-attachment-media-and-delete-root",
  }],
  ["src/components/MediaPreview.tsx:[data-debug-id=\"surface-components-mediapreview-1\"]", {
    fixtureId: "ui:attachment-media-owned-lifecycle",
    expectedEffect: "Native installed input plays and then pauses one exact valid release-owned MP4 through the app-owned accessible control before restoring UI state and deleting the fixture root.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:clear-owned-attachment-media-and-delete-root",
  }],
  ["src/components/PluginsModal.tsx::is([title=\"Cancel adding key (clears input)\"],[title=\"Enter your API key inline\"])", {
    fixtureId: "ui:plugins-owned-local-draft",
    expectedEffect: "Native installed input toggles the exact owned in-memory Plugins key form and proves Cancel clears its synthetic unsaved draft without invoking marketplace or Vault commands.",
    oracleId: "ui:disclosure-state-transition",
    cleanupId: "ui:clear-owned-plugin-draft-and-fixture",
  }],
  ["src/components/PluginsModal.tsx:[data-debug-id=\"plugins-vault-key-input\"]", {
    fixtureId: "ui:plugins-owned-local-draft",
    expectedEffect: "Native installed input changes only the exact owned synthetic Plugins key draft before Cancel clears it; Save, Vault, marketplace, provider, and clipboard paths are not invoked.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:clear-owned-plugin-draft-and-fixture",
  }],
  ["src/components/BuildPlanReviewModal.tsx:[aria-label=\"Review later\"]", {
    fixtureId: "ui:build-plan-review-owned-inert",
    expectedEffect: "A native click dismisses the fixed renderer-only Build plan review and reaches the reversible Plan-tab handoff while Reject and Accept plan stay disabled.",
    oracleId: "ui:activation:build-plan-review-dismissed",
    cleanupId: "ui:clear-owned-build-plan-review-and-restore-right-rail",
  }],
  ["src/components/BuildPlanReviewModal.tsx:role=button;name=\"Review later\"", {
    fixtureId: "ui:build-plan-review-owned-inert",
    expectedEffect: "A native click dismisses the fixed renderer-only Build plan review and reaches the reversible Plan-tab handoff while Reject and Accept plan stay disabled.",
    oracleId: "ui:activation:build-plan-review-dismissed",
    cleanupId: "ui:clear-owned-build-plan-review-and-restore-right-rail",
  }],
  ["src/components/BuildPlanReviewModal.tsx:[data-debug-id=\"surface-components-buildplanreviewmodal-4\"]", {
    fixtureId: "ui:build-plan-review-owned-reject",
    expectedEffect: "Two native installed clicks arm and confirm rejection of one exact isolated Build plan, observe its real halted state and planRejected receipt, then remove the disposable Build, Git, and project namespaces.",
    oracleId: "ui:activation:build-run-cockpit-owned-state-transition",
    cleanupId: "ui:clear-owned-build-run-project-provider-git-and-restore-view",
  }],
  ["src/components/BuildPlanReviewModal.tsx:[data-debug-id=\"surface-components-buildplanreviewmodal-5\"]", {
    fixtureId: "ui:build-plan-review-owned-approve",
    expectedEffect: "A native installed click approves one exact isolated Build plan, observes its real active state, durable planApproved receipt, and correlated fixed provider child receipt, then removes every owned namespace.",
    oracleId: "ui:activation:build-run-cockpit-owned-state-transition",
    cleanupId: "ui:clear-owned-build-run-project-provider-git-and-restore-view",
  }],
  ["src/components/settings/ShellxagentTab.tsx:[data-debug-id=\"surface-components-settings-shellxagenttab-1\"]", {
    fixtureId: "ui:shellxagent-owned-safe-token",
    expectedEffect: "A native click reveals only the fixed renderer-owned ShellX Agent token while Copy and Regenerate stay disabled, then exact cleanup hides it, closes Settings, and clears the fixture without changing the persisted Settings tab.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:hide-owned-shellxagent-token-close-settings-and-clear-fixture",
  }],
  ["src/components/settings/ShellxagentTab.tsx:[data-debug-id=\"surface-components-settings-shellxagenttab-3\"]", {
    fixtureId: "ui:shellxagent-isolated-token-rotation",
    expectedEffect: "A native click rotates the isolated candidate profile's ShellX Agent token to a different 32-hex credential identity; cleanup restores the original bytes, permissions, authenticated Debug API session, and Settings tab without recording either token value.",
    oracleId: "ui:activation:shellxagent-token-file-rotated",
    cleanupId: "ui:restore-isolated-shellxagent-token-mode-and-settings",
  }],
  ["src/App.tsx:[data-debug-id=\"remote-cwd-close\"]", {
    fixtureId: "ui:remote-cwd-owned-local-tree",
    expectedEffect: "A native click closes the isolated local Remote Folder picker without changing an active tab or operator path.",
    oracleId: "ui:activation:remote-cwd-path-transition",
    cleanupId: "ui:close-remote-cwd-picker-delete-owned-tree",
  }],
  ["src/App.tsx:[data-debug-id=\"remote-cwd-input\"]", {
    fixtureId: "ui:remote-cwd-owned-local-tree",
    expectedEffect: "Native text entry changes and exactly restores only the isolated Remote Folder draft without navigating or selecting it.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:close-remote-cwd-picker-delete-owned-tree",
  }],
  ["src/App.tsx:[data-debug-id=\"remote-cwd-go\"]", {
    fixtureId: "ui:remote-cwd-owned-local-tree",
    expectedEffect: "A native click navigates to the exact typed disposable local directory and completes its real listing without changing an active tab.",
    oracleId: "ui:activation:remote-cwd-path-transition",
    cleanupId: "ui:close-remote-cwd-picker-delete-owned-tree",
  }],
  ["src/App.tsx:[data-debug-id=\"remote-cwd-use\"]", {
    fixtureId: "ui:remote-cwd-owned-local-tree",
    expectedEffect: "A native click persists the exact disposable local directory into only the isolated candidate's active tab before restoring its complete baseline.",
    oracleId: "ui:activation:remote-cwd-path-transition",
    cleanupId: "ui:close-remote-cwd-picker-delete-owned-tree",
  }],
  ["src/App.tsx:[data-debug-id=\"remote-cwd-up\"]", {
    fixtureId: "ui:remote-cwd-owned-local-tree",
    expectedEffect: "A native click navigates from the disposable child directory to its exact local parent without changing an active tab.",
    oracleId: "ui:activation:remote-cwd-path-transition",
    cleanupId: "ui:close-remote-cwd-picker-delete-owned-tree",
  }],
  ["src/App.tsx:[data-debug-id=\"remote-cwd-parent\"]", {
    fixtureId: "ui:remote-cwd-owned-local-tree",
    expectedEffect: "A native click follows the exact disposable parent row from either the empty or populated local listing without changing an active tab.",
    oracleId: "ui:activation:remote-cwd-path-transition",
    cleanupId: "ui:close-remote-cwd-picker-delete-owned-tree",
  }],
  ["src/App.tsx:[data-debug-id=\"remote-cwd-folder\"]", {
    fixtureId: "ui:remote-cwd-owned-local-tree",
    expectedEffect: "A native click enters the exact disposable local child directory and completes its real listing without changing an active tab.",
    oracleId: "ui:activation:remote-cwd-path-transition",
    cleanupId: "ui:close-remote-cwd-picker-delete-owned-tree",
  }],
  ["src/components/ConnectorInboxModal.tsx:[aria-label=\"Close connector inbox\"]", {
    fixtureId: "ui:owned-modal-open",
    expectedEffect: "A native click closes the prepared Connector Inbox dialog.",
    oracleId: "ui:activation:owned-modal-closed",
    cleanupId: "ui:close-owned-modal",
  }],
  ["src/components/PreviewCenter.tsx:[aria-label=\"Close\"]", {
    fixtureId: "ui:owned-modal-open",
    expectedEffect: "A native click closes the prepared Preview Center dialog.",
    oracleId: "ui:activation:owned-modal-closed",
    cleanupId: "ui:close-owned-modal",
  }],
  ["src/components/FilePreviewModal.tsx:[id=\"file-preview-mode-code\"]", {
    fixtureId: "ui:file-preview-owned-html-mode",
    expectedEffect: "A native click restores Code mode from an owned safe-render baseline and exposes the exact owned HTML source without a live frame.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:close-delete-file-preview-and-restore-tab",
  }],
  ["src/components/FilePreviewModal.tsx:[id=\"file-preview-mode-safe-render\"]", {
    fixtureId: "ui:file-preview-owned-html-mode",
    expectedEffect: "A native click renders the exact owned HTML marker in a script-free, network-blocked, form-blocked sandboxed iframe.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:close-delete-file-preview-and-restore-tab",
  }],
  ["src/components/FilePreviewModal.tsx:[id=\"file-preview-run-work\"]", {
    fixtureId: "ui:file-preview-owned-html-run",
    expectedEffect: "A native click launches the exact owned HTML file through Work Preview, serves it from the matching loopback state in a script-enabled iframe, then stops the endpoint and removes the fixture.",
    oracleId: "ui:activation:file-preview-work-preview-lifecycle",
    cleanupId: "ui:stop-close-delete-file-preview-and-restore-tab",
  }],
  ...(["vault", "browser", "downloads", "agents", "requests"] as const).map((destination) => [
    `src/components/ShellxSetupGuide.tsx:[data-debug-id="shellx-setup-step-${destination}"]`,
    {
      fixtureId: "ui:setup-guide-destinations-closed",
      expectedEffect: `A native click opens the exact ${destination} destination from the visible Setup Guide before restoring Settings, window, overlay, and dismissal baselines.`,
      oracleId: `ui:activation:setup-guide-${destination === "downloads" ? "download-settings" : destination === "agents" ? "agent-cli-setup" : destination}-opened`,
      cleanupId: "ui:restore-setup-guide-destinations",
    },
  ] as const),
  ["src/components/ShellxSetupGuide.tsx:[data-debug-id=\"shellx-setup-guide-dismiss\"]", {
    fixtureId: "ui:setup-guide-destinations-closed",
    expectedEffect: "A native click dismisses the visible Setup Guide, proves the exact local dismissal state, and restores the original dismissal baseline.",
    oracleId: "ui:activation:setup-guide-dismissed",
    cleanupId: "ui:restore-setup-guide-destinations",
  }],
  ["src/components/FilePreviewModal.tsx:[title=\"Close (Esc)\"]", {
    fixtureId: "ui:owned-modal-open",
    expectedEffect: "A native click on the embedded File Preview footer closes the prepared Preview Center dialog without reading or changing the synthetic file target.",
    oracleId: "ui:activation:owned-modal-closed",
    cleanupId: "ui:close-owned-modal",
  }],
  ["src/components/VaultPanel.tsx:[aria-label=\"Close\"]", {
    fixtureId: "ui:owned-modal-open",
    expectedEffect: "A native click closes the prepared Vault workspace dialog.",
    oracleId: "ui:activation:owned-modal-closed",
    cleanupId: "ui:close-owned-modal",
  }],
  ["src/components/ConnectorInboxModal.tsx:[data-debug-id=\"connector-inbox-search-input\"]", {
    fixtureId: "ui:owned-modal-text-input-empty",
    expectedEffect: "Native text entry changes the prepared Connector Inbox search value before exact clearing and modal cleanup.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:clear-input-and-close-owned-modal",
  }],
  ["src/components/ConnectorInboxModal.tsx:[data-debug-id=\"connector-inbox-date-input\"]", {
    fixtureId: "ui:owned-modal-text-input-empty",
    expectedEffect: "Native text entry changes the prepared Connector Inbox date value before exact clearing and modal cleanup.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:clear-input-and-close-owned-modal",
  }],
  ["src/components/ConnectorInboxModal.tsx:[data-debug-id=\"surface-components-connectorinboxmodal-4\"]", {
    fixtureId: "ui:connector-inbox-manual-refresh-baseline",
    expectedEffect: "A native click completes exactly one manual Connector Inbox refresh and publishes the returned connector count, event count, latest-event watermark, and completion time before exact receipt reset and modal cleanup.",
    oracleId: "ui:activation:connector-inbox-manual-refresh",
    cleanupId: "ui:reset-connector-inbox-refresh-receipt-and-close",
  }],
  ["src/components/ConnectorInboxModal.tsx:[data-debug-id=\"surface-components-connectorinboxmodal-9\"]", {
    fixtureId: "ui:connector-inbox-filter-baseline",
    expectedEffect: "Native clicks select every concrete Connector Inbox provider tab before exact filter-state and modal restoration.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:restore-connector-inbox-filter-and-close",
  }],
  ["src/components/ConnectorInboxModal.tsx:role=button;name=\"Clear\"", {
    fixtureId: "ui:connector-inbox-active-filters",
    expectedEffect: "A native click clears the prepared Connector Inbox provider, search, and date filters before exact original-state restoration.",
    oracleId: "ui:activation:connector-inbox-filters-cleared",
    cleanupId: "ui:restore-connector-inbox-filter-and-close",
  }],
  ["src/components/ConnectorInboxModal.tsx:role=button;name=\"Connectors settings\"", {
    fixtureId: "ui:connector-inbox-open",
    expectedEffect: "A native click closes Connector Inbox and opens Settings with the Connectors tab selected before exact Settings-tab restoration.",
    oracleId: "ui:activation:connector-settings-opened",
    cleanupId: "ui:restore-settings-tab-and-close",
  }],
  ["src/components/ActivityBrowserModal.tsx:[data-debug-id=\"activity-search\"]", {
    fixtureId: "ui:owned-modal-text-input-empty",
    expectedEffect: "Native text entry changes the prepared Activity Browser search value before exact clearing and modal cleanup.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:clear-input-and-close-owned-modal",
  }],
  ["src/components/ActivityBrowserModal.tsx:[data-debug-id=\"activity-search-clear\"]", {
    fixtureId: "ui:activity-search-owned-value",
    expectedEffect: "A native click clears the exact owned Activity Browser search draft before exact modal cleanup without retaining its contents.",
    oracleId: "ui:activation:activity-search-cleared",
    cleanupId: "ui:clear-activity-search-and-close",
  }],
  ["src/components/PRCreateModal.tsx:[data-debug-id=\"pr-base-input\"]", {
    fixtureId: "ui:owned-modal-text-input-empty",
    expectedEffect: "Native text entry changes the prepared pull-request base branch draft before exact clearing and modal cleanup without creating a remote pull request.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:clear-input-and-close-owned-modal",
  }],
  ["src/components/PRCreateModal.tsx:[data-debug-id=\"pr-title-input\"]", {
    fixtureId: "ui:owned-modal-text-input-empty",
    expectedEffect: "Native text entry changes the prepared pull-request title draft before exact clearing and modal cleanup without creating a remote pull request.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:clear-input-and-close-owned-modal",
  }],
  ["src/components/PRCreateModal.tsx:[data-debug-id=\"pr-body-input\"]", {
    fixtureId: "ui:owned-modal-text-input-empty",
    expectedEffect: "Native text entry changes the prepared pull-request body draft before exact clearing and modal cleanup without creating a remote pull request.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:clear-input-and-close-owned-modal",
  }],
  ["src/components/PRCreateModal.tsx:[data-debug-id=\"surface-components-prcreatemodal-8\"]", {
    fixtureId: "ui:pr-modal-approval-baseline",
    expectedEffect: "A native click changes only the prepared local pull-request approval checkbox before exact restoration and modal cleanup; no remote pull request is created.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-pr-approval-and-close",
  }],
  ["src/components/PRCreateModal.tsx:role=button;name=\"Draft\"", {
    fixtureId: "ui:pr-modal-local-option-baseline",
    expectedEffect: "A native click changes only the prepared local pull-request Draft option before exact restoration and modal cleanup; no remote pull request is created.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-pr-local-option-and-close",
  }],
  ["src/components/PRCreateModal.tsx:role=button;name=\"Cancel\"", {
    fixtureId: "ui:pr-modal-open",
    expectedEffect: "A native click closes the prepared pull-request modal without creating a remote pull request.",
    oracleId: "ui:activation:owned-modal-closed",
    cleanupId: "ui:close-owned-modal",
  }],
  ["src/components/TasksPanel.tsx:[data-debug-id=\"tasks-filter-input\"]", {
    fixtureId: "ui:right-rail-text-input-empty",
    expectedEffect: "Native text entry changes the prepared Tasks filter before exact clearing and right-rail restoration.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:clear-input-and-restore-right-rail",
  }],
  ["src/components/FilesPane.tsx:[data-debug-id=\"files-search-input\"]", {
    fixtureId: "ui:right-rail-text-input-empty",
    expectedEffect: "Native text entry changes the prepared Files search before exact clearing and right-rail restoration.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:clear-input-and-restore-right-rail",
  }],
  ["src/components/FilesPane.tsx::is([title=\"Attach handler unavailable\"],[title=\"Attach selected files to the composer\"])", {
    fixtureId: "ui:files-pane-owned-tree",
    expectedEffect: "Native clicks select and attach exactly one owned in-scope text file, then clear its FilesPane selection without invoking a picker, copying a file, or sending a provider prompt.",
    oracleId: "ui:activation:files-pane-selected-attached",
    cleanupId: "ui:remove-owned-files-attachments-close-preview-delete-tree-and-restore-state",
  }],
  ["src/components/FilesPane.tsx:[aria-label^=\"Attach \"]", {
    fixtureId: "ui:files-pane-owned-tree",
    expectedEffect: "A native row action attaches exactly one owned in-scope text file without selecting it, invoking a picker, copying a file, or sending a provider prompt.",
    oracleId: "ui:activation:files-pane-row-attached",
    cleanupId: "ui:remove-owned-files-attachments-close-preview-delete-tree-and-restore-state",
  }],
  ["src/components/FilesPane.tsx:[aria-label^=\"Remove \"]", {
    fixtureId: "ui:files-pane-owned-tree",
    expectedEffect: "A native click removes exactly one owned file from the FilesPane selection without changing the file or composer.",
    oracleId: "ui:activation:files-pane-selection-removed",
    cleanupId: "ui:remove-owned-files-attachments-close-preview-delete-tree-and-restore-state",
  }],
  ["src/components/FilesPane.tsx:[aria-label=\"Clear selected files\"]", {
    fixtureId: "ui:files-pane-owned-tree",
    expectedEffect: "A native click clears the exact one-file FilesPane selection without changing the file or composer.",
    oracleId: "ui:activation:files-pane-selection-cleared",
    cleanupId: "ui:remove-owned-files-attachments-close-preview-delete-tree-and-restore-state",
  }],
  ["src/components/FilesPane.tsx:[data-debug-id=\"surface-components-filespane-7\"]", {
    fixtureId: "ui:files-pane-owned-tree",
    expectedEffect: "Native clicks exercise both concrete owned row branches by opening the child directory and then read-only Preview Center for its exact nested file.",
    oracleId: "ui:activation:files-pane-row-navigation-preview",
    cleanupId: "ui:remove-owned-files-attachments-close-preview-delete-tree-and-restore-state",
  }],
  ["src/components/FilesPane.tsx:[aria-label=\"Back to session folder\"]", {
    fixtureId: "ui:files-pane-owned-tree",
    expectedEffect: "A native click returns from the owned child directory to the exact session folder without invoking a picker or external process.",
    oracleId: "ui:activation:files-pane-session-folder-restored",
    cleanupId: "ui:remove-owned-files-attachments-close-preview-delete-tree-and-restore-state",
  }],
  ["src/components/FilesPane.tsx:[aria-label=\"Up one level\"]", {
    fixtureId: "ui:files-pane-owned-tree",
    expectedEffect: "A native click opens exactly the owned session folder's parent without invoking a picker or external process.",
    oracleId: "ui:activation:files-pane-parent-opened",
    cleanupId: "ui:remove-owned-files-attachments-close-preview-delete-tree-and-restore-state",
  }],
  ["src/components/WorkPreviewPanel.tsx:[data-debug-id=\"surface-components-workpreviewpanel-3\"]", {
    fixtureId: "ui:work-preview-owned-static-project",
    expectedEffect: "A native click on the durable Work Preview Start control launches the exact owned static project through ShellX's loopback preview lifecycle.",
    oracleId: "ui:activation:work-preview-start-lifecycle",
    cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-refresh-state\"]", {
    fixtureId: "ui:work-preview-owned-refresh",
    expectedEffect: "A native click reconciles a deliberately stale idle Work Preview panel with the exact owned running loopback state.",
    oracleId: "ui:activation:work-preview-state-refreshed",
    cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-doctor\"]", {
    fixtureId: "ui:work-preview-owned-doctor",
    expectedEffect: "A native click runs Preview Doctor against the exact owned loopback page, renders its HTTP/title result, and deletes any returned screenshot.",
    oracleId: "ui:activation:work-preview-doctor-result",
    cleanupId: "ui:delete-doctor-screenshot-stop-refresh-delete-project-and-restore-tab",
  }],
  ["src/components/PreviewCenter.tsx:[id=\"preview-center-file-mode\"]", {
    fixtureId: "ui:preview-center-owned-file-and-work",
    expectedEffect: "A native click selects Preview Center File mode and renders the exact owned regular file from a running Work baseline.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:close-clear-preview-stop-refresh-delete-files-and-restore-tab",
  }],
  ["src/components/PreviewCenter.tsx:[id=\"preview-center-work-mode\"]", {
    fixtureId: "ui:preview-center-owned-file-and-work",
    expectedEffect: "A native click selects Preview Center Work mode and renders the exact owned running loopback iframe from a File baseline.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:close-clear-preview-stop-refresh-delete-files-and-restore-tab",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-kind-auto\"]", {
    fixtureId: "ui:work-preview-kind-auto-baseline",
    expectedEffect: "A native click selects the exact Auto Work Preview kind with aria-selected ownership before exact kind and right-rail restoration.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:restore-work-preview-kind-and-right-rail",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-kind-static\"]", {
    fixtureId: "ui:work-preview-kind-auto-baseline",
    expectedEffect: "A native click selects the exact Static Work Preview kind with aria-selected ownership before exact kind and right-rail restoration.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:restore-work-preview-kind-and-right-rail",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-kind-web\"]", {
    fixtureId: "ui:work-preview-kind-auto-baseline",
    expectedEffect: "A native click selects the exact Web Work Preview kind with aria-selected ownership before exact kind and right-rail restoration.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:restore-work-preview-kind-and-right-rail",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-kind-expo\"]", {
    fixtureId: "ui:work-preview-kind-auto-baseline",
    expectedEffect: "A native click selects the exact Expo Work Preview kind with aria-selected ownership before exact kind and right-rail restoration.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:restore-work-preview-kind-and-right-rail",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-open\"]", {
    fixtureId: "ui:work-preview-owned-running-project",
    expectedEffect: "A native click opens Preview Center with the exact owned running Work Preview iframe.",
    oracleId: "ui:activation:work-preview-center-opened",
    cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-restart\"]", {
    fixtureId: "ui:work-preview-owned-running-project",
    expectedEffect: "A native click restarts the exact owned Work Preview lifecycle, re-serves its byte-exact page, and opens Preview Center.",
    oracleId: "ui:activation:work-preview-restarted",
    cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-stop\"]", {
    fixtureId: "ui:work-preview-owned-running-project",
    expectedEffect: "A native click stops the exact owned Work Preview lifecycle and makes its former endpoint unavailable.",
    oracleId: "ui:activation:work-preview-stopped",
    cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-log-height-toggle\"]", {
    fixtureId: "ui:work-preview-log-default-baseline",
    expectedEffect: "A native click expands Work Preview logs and persists the exact bounded height before isolated-profile restoration.",
    oracleId: "ui:activation:work-preview-log-height-transition",
    cleanupId: "ui:restore-work-preview-log-height-and-right-rail",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-viewport-phone\"]", {
    fixtureId: "ui:work-preview-owned-running-project",
    expectedEffect: "A native click selects the exact phone Work Preview viewport with matching aria-selected and canvas ownership.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-viewport-tablet\"]", {
    fixtureId: "ui:work-preview-owned-running-project",
    expectedEffect: "A native click selects the exact tablet Work Preview viewport with matching aria-selected and canvas ownership.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-viewport-desktop\"]", {
    fixtureId: "ui:work-preview-owned-running-project",
    expectedEffect: "A native click selects the exact desktop Work Preview viewport with matching aria-selected and canvas ownership.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-frame-reload\"]", {
    fixtureId: "ui:work-preview-owned-running-project",
    expectedEffect: "A native click changes the exact owned Work Preview iframe source through its bounded reload sequence.",
    oracleId: "ui:activation:work-preview-frame-reloaded",
    cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-panel-open-external\"]", {
    fixtureId: "ui:work-preview-owned-running-project",
    expectedEffect: "A native click dispatches the exact owned running loopback URL from the right-rail panel through ShellX's isolated external-browser handoff without opening an operator browser.",
    oracleId: "ui:activation:work-preview-external-handoff",
    cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab",
  }],
  ["src/components/WorkPreviewPanel.tsx:[id=\"work-preview-stage-open-external\"]", {
    fixtureId: "ui:work-preview-owned-running-project",
    expectedEffect: "A native click dispatches the exact owned running loopback URL from Preview Center through ShellX's isolated external-browser handoff without opening an operator browser.",
    oracleId: "ui:activation:work-preview-external-handoff",
    cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab",
  }],
  ["src/components/TasksPanel.tsx:[data-debug-id=\"tasks-show-all-tabs-checkbox\"]", {
    fixtureId: "ui:tasks-toggle-owned-baseline",
    expectedEffect: "A native click changes the Tasks all-tabs filter and its persisted setting before exact restoration.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-tasks-toggle-and-right-rail",
  }],
  ["src/components/TasksPanel.tsx:[data-debug-id=\"tasks-show-completed-checkbox\"]", {
    fixtureId: "ui:tasks-toggle-owned-baseline",
    expectedEffect: "A native click changes the Tasks completed filter and its persisted setting before exact restoration.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-tasks-toggle-and-right-rail",
  }],
  ["src/components/AgentRunsMonitor.tsx:[data-debug-id=\"tasks-agent-runs-refresh\"]", {
    fixtureId: "ui:agent-runs-monitor-fresh-mount",
    expectedEffect: "A native click completes exactly one manual Agent runs refresh and publishes its successful response generation receipt before the owned monitor mount and right rail are restored.",
    oracleId: "ui:activation:agent-runs-manual-refresh",
    cleanupId: "ui:restore-agent-runs-monitor-and-right-rail",
  }],
  ["src/components/CommandPalette.tsx:[data-debug-id=\"command-palette-input\"]", {
    fixtureId: "ui:overlay-text-input-empty",
    expectedEffect: "Native text entry changes the prepared Command Palette query before exact clearing and overlay cleanup.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:clear-input-and-close-overlay",
  }],
  ["src/components/CommandPalette.tsx:[data-debug-id=\"surface-components-commandpalette-4\"]", {
    fixtureId: "ui:command-palette-settings-action",
    expectedEffect: "A native click activates the exact Command Palette Settings row, closes the palette, and opens the visible Settings dialog before closing both owned overlays.",
    oracleId: "ui:activation:settings-opened-from-command-palette",
    cleanupId: "ui:close-settings-and-command-palette",
  }],
  ["src/components/FindPopover.tsx:[data-debug-id=\"find-sessions-input\"]", {
    fixtureId: "ui:always-visible-text-input-empty",
    expectedEffect: "Native text entry changes the prepared session finder before exact clearing and focus cleanup.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:clear-input-and-neutralize-focus",
  }],
  ["src/components/FindPopover.tsx:[data-debug-id=\"surface-components-findpopover-1\"]", {
    fixtureId: "ui:always-visible-text-input-empty",
    expectedEffect: "A native click on the always-visible Find shell focuses its owned session input and opens the finder popover before exact focus cleanup.",
    oracleId: "ui:activation:session-finder-focused",
    cleanupId: "ui:clear-input-and-neutralize-focus",
  }],
  ["src/components/FindPopover.tsx:[data-debug-id=\"surface-components-findpopover-3\"]", {
    fixtureId: "ui:find-open-row-visible",
    expectedEffect: "Native clicks focus the session finder and select its exact owned open-session row, exposing the local preview without opening another tab.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:clear-input-and-neutralize-focus",
  }],
  ["src/components/FindPopover.tsx:[data-debug-id=\"surface-components-findpopover-4\"]", {
    fixtureId: "ui:find-disk-row-visible",
    expectedEffect: "Native input finds and selects one exact owned on-disk session row, exposing its bounded local preview before deleting the owned history fixture.",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:delete-owned-session-clear-input-and-neutralize-focus",
  }],
  ["src/components/FindPopover.tsx:[title=\"Open this chat in a new tab (Enter)\"]", {
    fixtureId: "ui:find-owned-session-new-tab",
    expectedEffect: "Native activation opens exactly one new renderer tab for an owned on-disk session, preserves every baseline tab, selects the exact new identity, then closes only that owned tab and restores the original tab state.",
    oracleId: "ui:activation:find-owned-session-new-tab",
    cleanupId: "ui:close-owned-session-tab-delete-history-and-restore-baseline",
  }],
  ["src/components/BottomPanel.tsx:[data-debug-id=\"composer-prompt\"]", {
    fixtureId: "ui:always-visible-text-input-empty",
    expectedEffect: "Native text entry changes the prepared composer without submitting before exact clearing and focus cleanup.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:clear-input-and-neutralize-focus",
  }],
  ["src/components/settings/GeneralTab.tsx:[data-debug-id=\"settings-browser-download-folder\"]", {
    fixtureId: "ui:settings-text-input-owned-baseline",
    expectedEffect: "Native text entry changes the Browser download folder and its durable public setting before exact value and Settings-tab restoration.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-settings-input-tab-and-dialog",
  }],
  ["src/browser/components/DownloadSidecar.tsx:[data-debug-id=\"shellx-browser-download-folder\"]", {
    fixtureId: "ui:browser-download-folder-owned-baseline",
    expectedEffect: "Native text entry changes the Browser Downloads default folder and its durable public setting before exact value, panel, task, and window restoration.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-browser-download-folder-abort-task-and-restore-window",
  }],
  ["src/browser/components/BrowserShieldsPanel.tsx:[data-debug-id=\"shellx-browser-shields-global-enabled\"]", {
    fixtureId: "ui:browser-shields-owned-task",
    expectedEffect: "A native click changes global Browser protection in both bounded rendered and Browser API state before restoring the exact enabled baseline and removing the owned task, window, and loopback page.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:reset-owned-site-shields-restore-global-abort-task-and-window",
  }],
  ...([
    ["shellx-browser-site-shields-ad-trackers", "ad and tracker mode", "ui:choice-state-transition"],
    ["surface-browser-components-browsershieldspanel-3", "cookie mode", "ui:choice-state-transition"],
    ["surface-browser-components-browsershieldspanel-4", "fingerprinting mode", "ui:choice-state-transition"],
    ["surface-browser-components-browsershieldspanel-5", "HTTPS-upgrade setting", "ui:boolean-state-transition"],
    ["shellx-browser-site-shields-script-blocking", "script-blocking setting", "ui:boolean-state-transition"],
  ] as const).map(([debugId, label, oracleId]) => [`src/browser/components/BrowserShieldsPanel.tsx:[data-debug-id=\"${debugId}\"]`, {
    fixtureId: "ui:browser-shields-owned-task",
    expectedEffect: `Native input changes the owned loopback site's ${label} in both bounded rendered and Browser API state before removing the exact site override, task, window, and loopback page.`,
    oracleId,
    cleanupId: "ui:reset-owned-site-shields-restore-global-abort-task-and-window",
  }] as const),
  ["src/browser/components/BrowserShieldsPanel.tsx:[data-debug-id=\"shellx-browser-site-shields-save\"]", {
    fixtureId: "ui:browser-shields-owned-task",
    expectedEffect: "A native click creates exactly one owned loopback site override and enables its Reset action before removing that override, task, window, and loopback page.",
    oracleId: "ui:activation:browser-site-shields-override-transition",
    cleanupId: "ui:reset-owned-site-shields-restore-global-abort-task-and-window",
  }],
  ["src/browser/components/BrowserShieldsPanel.tsx:[data-debug-id=\"shellx-browser-site-shields-reset\"]", {
    fixtureId: "ui:browser-shields-owned-task",
    expectedEffect: "A native click removes one deliberately prepared owned loopback site override and disables Reset before removing the task, window, and loopback page.",
    oracleId: "ui:activation:browser-site-shields-override-transition",
    cleanupId: "ui:reset-owned-site-shields-restore-global-abort-task-and-window",
  }],
  ["src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-toggle-right-sidebar\"]", {
    fixtureId: "ui:browser-options-toggle-owned-baseline",
    expectedEffect: "A native click changes the Browser right-sidebar checkbox and chrome reveal control before exact state, panel, task, and window restoration.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-browser-options-toggle-abort-task-and-restore-window",
  }],
  ["src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-toggle-right-sidebar-button\"]", {
    fixtureId: "ui:browser-sidebar-opposite-baseline",
    expectedEffect: "A native click hides the Browser right sidebar and exposes its exactly owned reveal control before exact state, task, and window restoration.",
    oracleId: "ui:activation:browser-sidebar-visibility-transition",
    cleanupId: "ui:restore-browser-sidebar-abort-task-and-restore-window",
  }],
  ["src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-show-right-sidebar-button\"]", {
    fixtureId: "ui:browser-sidebar-opposite-baseline",
    expectedEffect: "A native click shows the prepared hidden Browser right sidebar and removes its exactly owned reveal control before exact state, task, and window restoration.",
    oracleId: "ui:activation:browser-sidebar-visibility-transition",
    cleanupId: "ui:restore-browser-sidebar-abort-task-and-restore-window",
  }],
  ["src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-homepage\"]", {
    fixtureId: "ui:browser-options-text-input-owned-baseline",
    expectedEffect: "Native text entry changes the Browser homepage and its renderer-local persistence before exact value, storage, panel, task, and window restoration.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-browser-options-text-input-abort-task-and-window",
  }],
  ["src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-color-mode\"]", {
    fixtureId: "ui:browser-options-select-owned-baseline",
    expectedEffect: "Native selection changes the Browser color mode, applied root state, and renderer-local persistence before exact value, storage, panel, task, and window restoration.",
    oracleId: "ui:choice-state-transition",
    cleanupId: "ui:restore-browser-options-select-abort-task-and-window",
  }],
  ["src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-parallel-agents\"]", {
    fixtureId: "ui:browser-engine-select-owned-baseline",
    expectedEffect: "Native selection changes the configured parallel Browser-agent capacity in the installed engine pool while preserving automation mode before exact panel, task, and window restoration.",
    oracleId: "ui:choice-state-transition",
    cleanupId: "ui:restore-browser-engine-select-abort-task-and-window",
  }],
  ["src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-profile-select\"]", {
    fixtureId: "ui:browser-profile-select-owned-baseline",
    expectedEffect: "Native selection changes only the default profile for the next Browser action before exact choice, panel, task, and window restoration.",
    oracleId: "ui:choice-state-transition",
    cleanupId: "ui:restore-browser-profile-select-abort-task-and-window",
  }],
  ["src/browser/components/BrowserMenus.tsx::is([data-debug-id=\"shellx-browser-personal-enable-now\"],[data-debug-id=\"shellx-browser-personal-lock-now\"],[data-debug-id=\"shellx-browser-personal-unlock-now\"])", {
    fixtureId: "ui:browser-personal-lock-owned-settings",
    expectedEffect: "A native click enables Personal Browser Lock through its status action from an isolated disabled, unlocked, PIN-free baseline before exact semantic settings, panel, task, and window restoration.",
    oracleId: "ui:activation:browser-personal-lock-enabled",
    cleanupId: "ui:restore-browser-personal-lock-settings-abort-task-and-window",
  }],
  ["src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-enabled\"]", {
    fixtureId: "ui:browser-personal-lock-owned-settings",
    expectedEffect: "A native click enables Personal Browser Lock through its checkbox from an isolated disabled, unlocked, PIN-free baseline before exact semantic settings, panel, task, and window restoration.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-browser-personal-lock-settings-abort-task-and-window",
  }],
  ["src/components/ShellxBrowserApp.tsx:[data-debug-id=\"shellx-browser-personal-lock-notice-unlock\"]", {
    fixtureId: "ui:browser-personal-lock-owned-settings",
    expectedEffect: "Native input creates an isolated synthetic PIN verifier, locks a real personal tab, triggers the blocked-new-tab notice, enters the PIN through the overlay field, and unlocks from the notice before exact isolated verifier, tab, task, and window cleanup without exposing the PIN.",
    oracleId: "ui:activation:browser-personal-lock-unlocked",
    cleanupId: "ui:restore-browser-personal-lock-settings-abort-task-and-window",
  }],
  ["src/components/ShellxBrowserApp.tsx:[data-debug-id=\"shellx-browser-personal-lock-overlay-pin\"]", {
    fixtureId: "ui:browser-personal-lock-owned-settings",
    expectedEffect: "Native input creates an isolated synthetic PIN verifier, locks a real personal tab, enters the PIN through the genuine overlay field, completes unlock, and removes the verifier with exact tab, task, and window cleanup without exposing the PIN.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-browser-personal-lock-settings-abort-task-and-window",
  }],
  ["src/components/ShellxBrowserApp.tsx:[data-debug-id=\"shellx-browser-personal-lock-overlay-unlock\"]", {
    fixtureId: "ui:browser-personal-lock-owned-settings",
    expectedEffect: "Native input creates an isolated synthetic PIN verifier, locks a real personal tab, enters the PIN, and unlocks through the genuine overlay control before exact isolated verifier, tab, task, and window cleanup without exposing the PIN.",
    oracleId: "ui:activation:browser-personal-lock-unlocked",
    cleanupId: "ui:restore-browser-personal-lock-settings-abort-task-and-window",
  }],
  ["src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-history-search\"]", {
    fixtureId: "ui:browser-history-filter-owned-baseline",
    expectedEffect: "Native text entry changes the Browser history search before exact value, panel, task, and window restoration.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-browser-history-filter-abort-task-and-window",
  }],
  ["src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-timeout\"]", {
    fixtureId: "ui:browser-personal-lock-owned-settings",
    expectedEffect: "Native selection changes the isolated PIN-free Personal Browser Lock timeout before exact settings, panel, task, and window restoration.",
    oracleId: "ui:choice-state-transition",
    cleanupId: "ui:restore-browser-personal-lock-settings-abort-task-and-window",
  }],
  ["src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-personal-lock-toggle\"]", {
    fixtureId: "ui:browser-personal-lock-owned-settings",
    expectedEffect: "A native click opens Personal Browser Lock settings from the isolated disabled header state before exact panel, task, and window restoration.",
    oracleId: "ui:activation:browser-personal-lock-settings-opened",
    cleanupId: "ui:restore-browser-personal-lock-settings-abort-task-and-window",
  }],
  ["src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-auth-mode\"]", {
    fixtureId: "ui:browser-personal-lock-owned-settings",
    expectedEffect: "Native selection changes the isolated PIN-free Personal Browser Lock unlock method before exact settings, panel, task, and window restoration.",
    oracleId: "ui:choice-state-transition",
    cleanupId: "ui:restore-browser-personal-lock-settings-abort-task-and-window",
  }],
  ["src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-pin\"]", {
    fixtureId: "ui:browser-personal-lock-owned-settings",
    expectedEffect: "Native text entry changes only the synthetic Personal Browser Lock PIN draft without persisting a PIN verifier, then clears the draft and restores unlock method, panel, task, and window state.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-browser-personal-lock-settings-abort-task-and-window",
  }],
  ["src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-set-pin\"]", {
    fixtureId: "ui:browser-personal-lock-owned-settings",
    expectedEffect: "Native input creates a verifier from an isolated synthetic Personal Browser Lock PIN, observes only safe configured state, and removes the verifier with exact task and window cleanup without retaining or exposing the PIN.",
    oracleId: "ui:activation:browser-personal-lock-pin-lifecycle",
    cleanupId: "ui:restore-browser-personal-lock-settings-abort-task-and-window",
  }],
  ...([
    ["shellx-browser-personal-lock-blur", "cover locked personal tabs"],
    ["shellx-browser-personal-lock-pause-delegated", "pause delegated tabs while locked"],
    ["shellx-browser-personal-lock-sleep", "lock after system sleep"],
    ["shellx-browser-personal-lock-minimize", "lock when minimized"],
  ] as const).map(([debugId, label]) => [`src/browser/components/BrowserMenus.tsx:[data-debug-id=\"${debugId}\"]`, {
    fixtureId: "ui:browser-personal-lock-owned-settings",
    expectedEffect: `A native click changes ${label} in an isolated enabled, unlocked, PIN-free Personal Lock profile before exact semantic settings, panel, task, and window restoration.`,
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-browser-personal-lock-settings-abort-task-and-window",
  }] as const),
  ["src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-history-date-filter\"]", {
    fixtureId: "ui:browser-history-filter-owned-baseline",
    expectedEffect: "Native selection changes the Browser history date filter before exact choice, panel, task, and window restoration.",
    oracleId: "ui:choice-state-transition",
    cleanupId: "ui:restore-browser-history-filter-abort-task-and-window",
  }],
  ["src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-history-user\"]", {
    fixtureId: "ui:browser-history-filter-owned-baseline",
    expectedEffect: "A native click selects User history from an Agent baseline before exact scope, panel, task, and window restoration.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-browser-history-filter-abort-task-and-window",
  }],
  ["src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-history-agent\"]", {
    fixtureId: "ui:browser-history-filter-owned-baseline",
    expectedEffect: "A native click selects Agent history from a User baseline before exact scope, panel, task, and window restoration.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-browser-history-filter-abort-task-and-window",
  }],
  ["src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id^=\"shellx-browser-history-entry-\"]", {
    fixtureId: "ui:browser-owned-history-sidecar",
    expectedEffect: "Native input selects one exact synthetic Agent-history row and navigates its owned Browser task tab to the recorded loopback URL before clearing only the isolated history baseline and restoring scope, panel, task, loopback server, and window state.",
    oracleId: "ui:activation:owned-browser-history-entry-navigation",
    cleanupId: "ui:clear-owned-browser-history-abort-task-and-window-loopback",
  }],
  ["src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-clear-history\"]", {
    fixtureId: "ui:browser-owned-history-sidecar",
    expectedEffect: "Native input confirms the exact ShellX Agent-history sheet and clears the isolated owned Browser-history baseline before restoring scope, panel, task, loopback server, and window state.",
    oracleId: "ui:activation:owned-browser-history-clear",
    cleanupId: "ui:clear-owned-browser-history-abort-task-and-window-loopback",
  }],
  ["src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-clear-all-history\"]", {
    fixtureId: "ui:browser-history-clear-sheet-owned-baseline",
    expectedEffect: "Native input opens the exact All-history confirmation sheet over a mixed owned User and Agent history baseline without removing either class before exact panel, scope, task, personal tab, loopback server, and window restoration.",
    oracleId: "ui:activation:owned-browser-history-all-clear-sheet",
    cleanupId: "ui:restore-owned-browser-history-clear-sheet",
  }],
  ["src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-history-clear-cancel\"]", {
    fixtureId: "ui:browser-history-clear-sheet-owned-baseline",
    expectedEffect: "Native input cancels the exact All-history confirmation sheet over a mixed owned User and Agent history baseline and preserves both classes before exact panel, scope, task, personal tab, loopback server, and window restoration.",
    oracleId: "ui:activation:owned-browser-history-clear-cancel",
    cleanupId: "ui:restore-owned-browser-history-clear-sheet",
  }],
  ["src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-history-clear-confirm\"]", {
    fixtureId: "ui:browser-history-clear-sheet-owned-baseline",
    expectedEffect: "Native input confirms the exact All-history sheet over a mixed owned User and Agent history baseline, then verifies the all-scope receipt and success status before exact panel, scope, task, personal tab, loopback server, and window restoration.",
    oracleId: "ui:activation:owned-browser-history-all-clear-receipt",
    cleanupId: "ui:restore-owned-browser-history-clear-sheet",
  }],
  ["src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-bookmark-list-mode\"]", {
    fixtureId: "ui:browser-bookmark-mode-owned-baseline",
    expectedEffect: "A native click selects Browser bookmark List mode from an owned Edit baseline before exact mode, panel, task, and window restoration.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-browser-bookmark-mode-abort-task-and-window",
  }],
  ["src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-bookmark-manager-toggle\"]", {
    fixtureId: "ui:browser-bookmark-mode-owned-baseline",
    expectedEffect: "A native click selects Browser bookmark Edit mode from an owned List baseline before exact mode, panel, task, and window restoration.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-browser-bookmark-mode-abort-task-and-window",
  }],
  ["src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-bookmark-draft-label\"]", {
    fixtureId: "ui:browser-bookmark-draft-text-owned-baseline",
    expectedEffect: "Native text entry changes the Browser bookmark draft name without creating a bookmark before exact value, mode, panel, task, and window restoration.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-browser-bookmark-draft-text-abort-task-and-window",
  }],
  ["src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-bookmark-draft-url\"]", {
    fixtureId: "ui:browser-bookmark-draft-text-owned-baseline",
    expectedEffect: "Native text entry changes the Browser bookmark draft URL without creating a bookmark before exact value, mode, panel, task, and window restoration.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-browser-bookmark-draft-text-abort-task-and-window",
  }],
  ["src/browser/components/BookmarkSidecar.tsx:[data-debug-id^=\"shellx-browser-bookmark-drag-\"]", {
    fixtureId: "ui:browser-bookmark-owned-row",
    expectedEffect: "Bounded native pointer input drags the second synthetic owned bookmark before the first, verifies the exact persisted sibling order, then deletes both bookmarks and restores mode, panel, task, and window state.",
    oracleId: "ui:activation:owned-bookmark-order-transition",
    cleanupId: "ui:delete-owned-bookmarks-restore-panel-abort-task-and-window",
  }],
  ...([
    ["[data-debug-id^=\"shellx-browser-bookmark-label-\"]", "label", "ui:value-state-transition"],
    ["[data-debug-id^=\"shellx-browser-bookmark-url-\"]", "URL", "ui:value-state-transition"],
    ["[data-debug-id^=\"shellx-browser-bookmark-pin-\"]", "toolbar pin", "ui:activation:owned-bookmark-pin-state-transition"],
    ["[data-debug-id^=\"shellx-browser-bookmark-delete-\"]", "confirmed deletion", "ui:activation:owned-bookmark-state-transition"],
  ] as const).map(([selector, label, oracleId]) => [`src/browser/components/BookmarkSidecar.tsx:${selector}`, {
    fixtureId: "ui:browser-bookmark-owned-row",
    expectedEffect: `Native interaction changes only one synthetic owned bookmark ${label} before deleting that exact bookmark and restoring mode, panel, task, and window state.`,
    oracleId,
    cleanupId: "ui:delete-owned-bookmarks-restore-panel-abort-task-and-window",
  }] as const),
  ["src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-bookmark-draft-folder\"]", {
    fixtureId: "ui:browser-bookmark-owned-folder-choice",
    expectedEffect: "Native selection chooses one synthetic owned parent folder in the unsaved bookmark draft before deleting that exact folder and restoring draft, mode, panel, task, and window state.",
    oracleId: "ui:choice-state-transition",
    cleanupId: "ui:delete-owned-bookmarks-restore-panel-abort-task-and-window",
  }],
  ["src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-bookmark-create-folder\"]", {
    fixtureId: "ui:browser-bookmark-owned-create",
    expectedEffect: "A native click creates one synthetic owned bookmark folder before deleting its exact returned ID and restoring draft, mode, panel, task, and window state.",
    oracleId: "ui:activation:owned-bookmark-state-transition",
    cleanupId: "ui:delete-owned-bookmarks-restore-panel-abort-task-and-window",
  }],
  ["src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-bookmark-create-link\"]", {
    fixtureId: "ui:browser-bookmark-owned-create",
    expectedEffect: "A native click creates one synthetic owned bookmark link before deleting its exact returned ID and restoring draft, mode, panel, task, and window state.",
    oracleId: "ui:activation:owned-bookmark-state-transition",
    cleanupId: "ui:delete-owned-bookmarks-restore-panel-abort-task-and-window",
  }],
  ["src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-bookmark-current\"]", {
    fixtureId: "ui:browser-bookmark-owned-navigation",
    expectedEffect: "Native input creates exactly one bookmark for the owned active loopback page before deleting its returned ID and restoring task, tab, server, and window state.",
    oracleId: "ui:activation:owned-browser-bookmark-created",
    cleanupId: "ui:delete-owned-bookmark-navigation-abort-task-and-window-loopback",
  }],
  ["src/browser/components/BookmarkToolbar.tsx:[data-debug-id^=\"shellx-browser-bookmark-folder-\"]", {
    fixtureId: "ui:browser-bookmark-owned-navigation",
    expectedEffect: "Native input opens one exact owned toolbar bookmark folder and exposes its owned child before exact bookmark, disclosure, task, tab, server, and window cleanup.",
    oracleId: "ui:disclosure-state-transition",
    cleanupId: "ui:delete-owned-bookmark-navigation-abort-task-and-window-loopback",
  }],
  ["src/browser/components/BookmarkToolbar.tsx:[data-debug-id^=\"shellx-browser-bookmark-toolbar-link-\"]", {
    fixtureId: "ui:browser-bookmark-owned-navigation",
    expectedEffect: "Native input navigates the exact owned task tab through one synthetic toolbar bookmark link before exact bookmark, task, tab, server, and window cleanup.",
    oracleId: "ui:activation:owned-browser-bookmark-navigation",
    cleanupId: "ui:delete-owned-bookmark-navigation-abort-task-and-window-loopback",
  }],
  ["src/browser/components/BookmarkToolbar.tsx:[data-debug-id^=\"shellx-browser-bookmark-folder-child-\"]", {
    fixtureId: "ui:browser-bookmark-owned-navigation",
    expectedEffect: "Native input opens one owned toolbar folder and navigates the exact task tab through its synthetic child bookmark before exact bookmark, disclosure, task, tab, server, and window cleanup.",
    oracleId: "ui:activation:owned-browser-bookmark-navigation",
    cleanupId: "ui:delete-owned-bookmark-navigation-abort-task-and-window-loopback",
  }],
  ["src/browser/components/BookmarkSidecar.tsx:[data-debug-id^=\"shellx-browser-bookmark-\"]", {
    fixtureId: "ui:browser-bookmark-owned-navigation",
    expectedEffect: "Native input navigates the exact owned task tab through one synthetic bookmark-list row before exact bookmark, panel, task, tab, server, and window cleanup.",
    oracleId: "ui:activation:owned-browser-bookmark-navigation",
    cleanupId: "ui:delete-owned-bookmark-navigation-abort-task-and-window-loopback",
  }],
  ["src/browser/components/BookmarkSidecar.tsx:[data-debug-id^=\"shellx-browser-bookmark-open-\"]", {
    fixtureId: "ui:browser-bookmark-owned-navigation",
    expectedEffect: "Native input navigates the exact owned task tab through one synthetic bookmark-manager Open action before exact bookmark, panel, task, tab, server, and window cleanup.",
    oracleId: "ui:activation:owned-browser-bookmark-navigation",
    cleanupId: "ui:delete-owned-bookmark-navigation-abort-task-and-window-loopback",
  }],
  ["src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-new-tab\"]", {
    fixtureId: "ui:browser-owned-tab-create",
    expectedEffect: "Installed input creates exactly one owned about:blank Browser tab before deleting its returned ID and restoring homepage input, renderer storage, active tab, tab set, and window state.",
    oracleId: "ui:activation:owned-browser-tab-state-transition",
    cleanupId: "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window",
  }],
  ["src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-new-disposable-tab\"]", {
    fixtureId: "ui:browser-owned-tab-create",
    expectedEffect: "Installed input creates exactly one owned task-disposable about:blank Browser tab before deleting its returned ID and restoring homepage input, renderer storage, active tab, tab set, and window state.",
    oracleId: "ui:activation:owned-browser-tab-state-transition",
    cleanupId: "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window",
  }],
  ["src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-home\"]", {
    fixtureId: "ui:browser-owned-home-navigation",
    expectedEffect: "Installed input navigates the exact owned active Browser tab and native engine from a loopback starting page to the configured loopback homepage, waits for settled engine load, then restores homepage input, renderer storage, active tab, tab set, loopback server, and window state.",
    oracleId: "ui:activation:owned-browser-home-navigation",
    cleanupId: "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window",
  }],
  ...([
    ["back", "back through its prepared loopback history"],
    ["forward", "forward through its prepared loopback history"],
    ["reload", "through a reload that produces a new owned HTTP request"],
  ] as const).map(([action, effect]) => [
    `src/browser/components/BrowserChrome.tsx:[data-debug-id="shellx-browser-${action}"]`,
    {
      fixtureId: "ui:browser-owned-history-navigation",
      expectedEffect: `Installed input moves the exact owned active Browser tab and native engine ${effect}, waits for exact loaded settlement without a pending URL, then restores the active tab, tab set, loopback server, and window state.`,
      oracleId: "ui:activation:owned-browser-history-navigation",
      cleanupId: "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window",
    },
  ] as const),
  ["src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-lock-tab\"]", {
    fixtureId: "ui:browser-owned-tab-lock",
    expectedEffect: "Installed input acquires one exact shellx-browser-ui/browser-window lease on an owned active Browser tab, then releases the returned lease and restores the unlocked tab, active tab, tab set, and window baseline.",
    oracleId: "ui:activation:owned-browser-tab-lock-transition",
    cleanupId: "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window",
  }],
  ["src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-handoff-tab\"]", {
    fixtureId: "ui:browser-owned-tab-delegation",
    expectedEffect: "Installed input opens and confirms the exact ShellX-owned trusted-user handoff sheet, delegates one owned user tab to the exact active Browser agent task without granting Vault access, then takes it back and restores task, ownership, active-tab, tab-set, and window state.",
    oracleId: "ui:activation:owned-browser-tab-delegation-transition",
    cleanupId: "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window",
  }],
  ["src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-take-back-tab\"]", {
    fixtureId: "ui:browser-owned-tab-delegation",
    expectedEffect: "After an exact trusted-user handoff setup, installed input takes one owned delegated Browser tab back from its active agent task and restores user ownership with no task or grant binding before exact task, tab-set, active-tab, and window cleanup.",
    oracleId: "ui:activation:owned-browser-tab-delegation-transition",
    cleanupId: "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window",
  }],
  ["src/browser/components/BrowserTabHandoffConfirmation.tsx:[data-debug-id=\"shellx-browser-handoff-cancel\"]", {
    fixtureId: "ui:browser-owned-tab-delegation",
    expectedEffect: "Installed input opens the exact ShellX handoff review, verifies its sanitized tab, profile, persistence, owner, target-task, and Vault-boundary receipts, exercises Cancel with focus restoration, then reopens and confirms the owned handoff before exact take-back, task, tab-set, active-tab, and window cleanup.",
    oracleId: "ui:activation:owned-browser-tab-delegation-transition",
    cleanupId: "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window",
  }],
  ["src/browser/components/BrowserTabHandoffConfirmation.tsx:[data-debug-id=\"shellx-browser-handoff-confirm\"]", {
    fixtureId: "ui:browser-owned-tab-delegation",
    expectedEffect: "Installed input opens the exact ShellX handoff review, verifies its sanitized tab, profile, persistence, owner, target-task, and Vault-boundary receipts, exercises Cancel with focus restoration, then makes one trusted Confirm and observes its pending-to-success handoff before exact take-back, task, tab-set, active-tab, and window cleanup.",
    oracleId: "ui:activation:owned-browser-tab-delegation-transition",
    cleanupId: "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window",
  }],
  ["src/browser/components/BrowserChrome.tsx:[data-debug-id^=\"shellx-browser-tab-\"]", {
    fixtureId: "ui:browser-owned-tab-row",
    expectedEffect: "Installed input focuses exactly one of two synthetic owned about:blank Browser tabs before deleting both returned IDs and restoring the prior active tab, tab set, and window state.",
    oracleId: "ui:activation:owned-browser-tab-focus-transition",
    cleanupId: "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window",
  }],
  ["src/browser/components/BrowserChrome.tsx:[data-debug-id^=\"shellx-browser-close-tab-\"]", {
    fixtureId: "ui:browser-owned-tab-row",
    expectedEffect: "Installed input closes exactly one synthetic owned about:blank Browser tab before deleting any remaining owned tab IDs and restoring the prior active tab, tab set, and window state.",
    oracleId: "ui:activation:owned-browser-tab-state-transition",
    cleanupId: "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window",
  }],
  ["src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-address\"]", {
    fixtureId: "ui:browser-transient-text-owned-baseline",
    expectedEffect: "Native text entry changes the Browser address draft without navigating before exact value, right-panel, task, and window restoration.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-browser-transient-text-abort-task-and-window",
  }],
  ["src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-goal\"]", {
    fixtureId: "ui:browser-transient-text-owned-baseline",
    expectedEffect: "Native text entry changes the Browser agent message draft without sending before exact value, right-panel, task, and window restoration.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-browser-transient-text-abort-task-and-window",
  }],
  ["src/components/VaultPasswordGenerator.tsx:[data-debug-id=\"surface-components-vaultpasswordgenerator-11\"]", {
    fixtureId: "ui:vault-password-generator-local-baseline",
    expectedEffect: "A native click changes one visible Vault password character-set checkbox before exact local-state and Request Center restoration without retaining password contents.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-vault-password-generator-local-state",
  }],
  ["src/components/VaultPasswordGenerator.tsx::is([aria-label=\"Hide generated password\"],[aria-label=\"Reveal generated password\"])", {
    fixtureId: "ui:vault-password-generator-local-baseline",
    expectedEffect: "A native click changes the generated-password visibility boolean before exact local-state and Request Center restoration without retaining password contents.",
    oracleId: "ui:activation:vault-password-reveal-transition",
    cleanupId: "ui:restore-vault-password-generator-local-state",
  }],
  ["src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-agent-pause\"]", {
    fixtureId: "ui:browser-task-control-owned-task",
    expectedEffect: "A native operator click pauses exactly one owned running Browser task before trusted resume and abort cleanup.",
    oracleId: "ui:activation:browser-task-status-transition",
    cleanupId: "ui:finish-or-abort-browser-task-and-restore-window",
  }],
  ["src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-agent-resume\"]", {
    fixtureId: "ui:browser-task-control-owned-task",
    expectedEffect: "A native operator click resumes exactly one owned paused Browser task before abort cleanup.",
    oracleId: "ui:activation:browser-task-status-transition",
    cleanupId: "ui:finish-or-abort-browser-task-and-restore-window",
  }],
  ["src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-agent-takeover\"]", {
    fixtureId: "ui:browser-task-control-owned-task",
    expectedEffect: "A native operator click takes over exactly one owned running Browser task before trusted resume and abort cleanup.",
    oracleId: "ui:activation:browser-task-status-transition",
    cleanupId: "ui:finish-or-abort-browser-task-and-restore-window",
  }],
  ["src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-agent-abort\"]", {
    fixtureId: "ui:browser-task-control-owned-task",
    expectedEffect: "A native operator click aborts exactly one owned running Browser task and leaves only its terminal receipt.",
    oracleId: "ui:activation:browser-task-status-transition",
    cleanupId: "ui:finish-or-abort-browser-task-and-restore-window",
  }],
  ["src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-complete\"]", {
    fixtureId: "ui:browser-task-control-owned-task",
    expectedEffect: "A native operator click completes exactly one owned running Browser task and leaves only its terminal receipt.",
    oracleId: "ui:activation:browser-task-status-transition",
    cleanupId: "ui:finish-or-abort-browser-task-and-restore-window",
  }],
  ["src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-block\"]", {
    fixtureId: "ui:browser-task-control-owned-task",
    expectedEffect: "A native operator click blocks exactly one owned running Browser task and leaves only its terminal receipt.",
    oracleId: "ui:activation:browser-task-status-transition",
    cleanupId: "ui:finish-or-abort-browser-task-and-restore-window",
  }],
  ["src/components/BottomPanel.tsx:[data-debug-id=\"bottom-action-assets\"]", {
    fixtureId: "ui:owned-modal-closed",
    expectedEffect: "A native click opens the visible Attachment and Media Board dialog.",
    oracleId: "ui:activation:owned-modal-opened",
    cleanupId: "ui:close-owned-modal",
  }],
  ["src/components/BottomPanel.tsx:[data-debug-id=\"bottom-action-trace\"]", {
    fixtureId: "ui:activity-browser-closed",
    expectedEffect: "A native click opens the visible Activity Browser dialog.",
    oracleId: "ui:activation:activity-browser-owner-state",
    cleanupId: "ui:close-activity-browser",
  }],
  ["src/components/BottomPanel.tsx:[data-debug-id=\"composer-connection\"]", {
    fixtureId: "ui:composer-picker-closed",
    expectedEffect: "A native click opens the Saved connections picker before a second native click closes it.",
    oracleId: "ui:activation:composer-picker-state-transition",
    cleanupId: "ui:close-composer-picker",
  }],
  ["src/components/BottomPanel.tsx:[data-debug-id=\"composer-agent\"]", {
    fixtureId: "ui:composer-picker-closed",
    expectedEffect: "A native click opens the Agent picker before a second native click closes it.",
    oracleId: "ui:activation:composer-picker-state-transition",
    cleanupId: "ui:close-composer-picker",
  }],
  ["src/components/BottomPanel.tsx:[data-debug-id=\"composer-branch\"]", {
    fixtureId: "ui:composer-picker-closed",
    expectedEffect: "A native click opens the Branch picker before a second native click closes it.",
    oracleId: "ui:activation:composer-picker-state-transition",
    cleanupId: "ui:close-composer-picker",
  }],
  ["src/components/BottomPanel.tsx:[aria-label=\"Keyboard shortcuts\"]", {
    fixtureId: "ui:keyboard-hint-closed",
    expectedEffect: "Native focus opens the Keyboard shortcuts tooltip before native focus cleanup closes it.",
    oracleId: "ui:activation:keyboard-hint-state-transition",
    cleanupId: "ui:close-keyboard-hint",
  }],
  ["src/components/settings/ConnectionsTab.tsx:[title=\"Add a new connection preset\"]", {
    fixtureId: "ui:connection-editor-closed",
    expectedEffect: "A native click opens a new unsaved Connection Editor draft before exact modal and Settings cleanup.",
    oracleId: "ui:activation:connection-editor-opened",
    cleanupId: "ui:close-connection-editor-and-settings",
  }],
  ["src/components/ConnectionPicker.tsx:[title=\"Add a new connection\"]", {
    fixtureId: "ui:connection-editor-closed",
    expectedEffect: "Native clicks open the Saved connections picker and then one new unsaved Connection Editor draft before exact picker and draft cleanup.",
    oracleId: "ui:activation:connection-editor-opened",
    cleanupId: "ui:close-connection-editor-and-settings",
  }],
  ["src/components/ConnectionEditor.tsx:[aria-label=\"Close connection editor\"]", {
    fixtureId: "ui:connection-editor-open",
    expectedEffect: "A native click closes the prepared unsaved Connection Editor without saving its draft.",
    oracleId: "ui:activation:connection-editor-closed",
    cleanupId: "ui:close-connection-editor-and-settings",
  }],
  ["src/components/ConnectionEditor.tsx:[aria-label=\"Cancel connection changes\"]", {
    fixtureId: "ui:connection-editor-open",
    expectedEffect: "A native click cancels the prepared unsaved Connection Editor without saving its draft.",
    oracleId: "ui:activation:connection-editor-closed",
    cleanupId: "ui:close-connection-editor-and-settings",
  }],
  ...[
    ["connection-label-input", "connection label"],
    ["connection-wsl-distro-input", "WSL distro"],
    ["connection-ssh-host-input", "SSH host"],
    ["connection-ssh-port-input", "SSH port"],
    ["connection-ssh-wsl-distro-input", "remote Windows WSL distro"],
  ].map(([id, label]) => [`src/components/ConnectionEditor.tsx:[data-debug-id=\"${id}\"]`, {
    fixtureId: "ui:connection-editor-local-draft",
    expectedEffect: `Native text entry changes only the unsaved ${label} draft before exact clearing and modal cleanup.`,
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:clear-connection-draft-and-close-settings",
  }] as const),
  ...["local", "wsl", "ssh"].map((transport) => [`src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-transport-${transport}\"]`, {
    fixtureId: "ui:connection-editor-choice-baseline",
    expectedEffect: `A native click selects the ${transport.toUpperCase()} transport in an unsaved draft before exact local-baseline restoration.`,
    oracleId: "ui:choice-state-transition",
    cleanupId: "ui:restore-connection-draft-and-close-settings",
  }] as const),
  ["src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-ssh-runtime-select\"]", {
    fixtureId: "ui:connection-editor-choice-baseline",
    expectedEffect: "Native selection changes the unsaved SSH remote-runtime choice before exact POSIX-baseline restoration.",
    oracleId: "ui:choice-state-transition",
    cleanupId: "ui:restore-connection-draft-and-close-settings",
  }],
  ["src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-ssh-key-select\"]", {
    fixtureId: "ui:connection-editor-owned-vault-key",
    expectedEffect: "Native WebDriver selects one exact redacted key reference from an isolated Vault-backed SSH draft without revealing its value or saving a connection.",
    oracleId: "ui:choice-state-transition",
    cleanupId: "ui:clear-connection-vault-selection-delete-owned-key-and-close-settings",
  }],
  ...["compact", "default", "comfortable"].map((density) => [`src/components/settings/GeneralTab.tsx:[data-debug-id=\"settings-density-${density}\"]`, {
    fixtureId: "ui:general-setting-owned-baseline",
    expectedEffect: `A native click changes the persisted UI density to ${density} before exact baseline restoration.`,
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-general-setting-and-close-settings",
  }] as const),
  ...[
    ["Use Black theme", "black"],
    ["Use Black and warm theme", "black_warm"],
    ["Use Bright theme", "bright"],
  ].map(([label, theme]) => [`src/components/settings/GeneralTab.tsx:[aria-label=\"${label}\"]`, {
    fixtureId: "ui:general-setting-owned-baseline",
    expectedEffect: `A native click changes the persisted theme to ${theme} before exact baseline restoration.`,
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-general-setting-and-close-settings",
  }] as const),
  ["src/components/settings/GeneralTab.tsx:[aria-label=\"Chat font size in pixels\"]", {
    fixtureId: "ui:general-setting-owned-baseline",
    expectedEffect: "Native range input changes the persisted chat font size before exact baseline restoration.",
    oracleId: "ui:range-state-transition",
    cleanupId: "ui:restore-general-setting-and-close-settings",
  }],
  ["src/components/settings/GeneralTab.tsx:[title=\"Reset to default\"]", {
    fixtureId: "ui:general-setting-owned-baseline",
    expectedEffect: "A native click resets a prepared non-default chat font size before exact original-baseline restoration.",
    oracleId: "ui:activation:general-setting-reset",
    cleanupId: "ui:restore-general-setting-and-close-settings",
  }],
  ['src/components/settings/DataTab.tsx:[title^="Delete the "][title$=" on disk + in localStorage"]', {
    fixtureId: "ui:data-delete-dialog-closed",
    expectedEffect: "A native click opens the renderer-owned Data deletion confirmation without deleting localStorage or any on-disk user data.",
    oracleId: "ui:activation:data-delete-dialog-opened",
    cleanupId: "ui:close-data-delete-dialog-and-settings",
  }],
  ['src/components/settings/DataTab.tsx:[id="data-delete-cancel"]', {
    fixtureId: "ui:data-delete-dialog-open",
    expectedEffect: "A native click closes the prepared renderer-owned Data deletion confirmation without deleting localStorage or any on-disk user data.",
    oracleId: "ui:activation:data-delete-dialog-cancelled",
    cleanupId: "ui:close-data-delete-dialog-and-settings",
  }],
  ['src/components/settings/DataTab.tsx:[id="data-delete-confirm"]', {
    fixtureId: "ui:data-delete-owned-section",
    expectedEffect: "Native WebDriver confirms deletion of one exact isolated user-data section, observes disk and localStorage cleanup, preserves its sibling section, and restores the empty profile baseline.",
    oracleId: "ui:activation:data-delete-owned-section-removed",
    cleanupId: "ui:restore-empty-user-data-and-close-settings",
  }],
  ...[
    ["Read the shellX features overview", "Features"],
    ["Read the shellX quick-start guide", "Quick start"],
    ["Read bundled release notes", "Changelog"],
  ].map(([title, label]) => [`src/components/settings/AboutTab.tsx:[title=\"${title}\"]`, {
    fixtureId: "ui:builtin-doc-closed",
    expectedEffect: `A native click opens the bundled ${label} dialog without filesystem or network access.`,
    oracleId: "ui:activation:builtin-doc-opened",
    cleanupId: "ui:close-builtin-doc-and-settings",
  }] as const),
  ['src/components/settings/AboutTab.tsx:[title="Read bundled third-party notices"]', {
    fixtureId: "ui:builtin-doc-closed",
    expectedEffect: "A native click opens the bundled Third-party notices dialog without filesystem or network access.",
    oracleId: "ui:activation:builtin-doc-opened",
    cleanupId: "ui:close-builtin-doc-and-settings",
  }],
  ['src/components/LazySurface.tsx:role=button;name="Retry"', {
    fixtureId: "ui:lazy-surface-owned-error",
    expectedEffect: "A native click retries the failed scoped surface and renders its deterministic recovered state without replacing the workspace.",
    oracleId: "ui:activation:lazy-surface-recovered",
    cleanupId: "ui:clear-lazy-surface-fixture",
  }],
  ['src/components/LazySurface.tsx:role=button;name="Close"', {
    fixtureId: "ui:lazy-surface-owned-error",
    expectedEffect: "A native click dismisses the failed scoped surface while the surrounding workspace remains mounted.",
    oracleId: "ui:activation:lazy-surface-dismissed",
    cleanupId: "ui:clear-lazy-surface-fixture",
  }],
  ["src/components/BuiltinDocModal.tsx:[aria-label=\"Close (Esc)\"]", {
    fixtureId: "ui:builtin-doc-open",
    expectedEffect: "A native click closes the prepared bundled-document dialog while preserving Settings until cleanup.",
    oracleId: "ui:activation:builtin-doc-closed",
    cleanupId: "ui:close-builtin-doc-and-settings",
  }],
  ...[
    ["surface-components-settings-abouttab-4", "ShellX homepage", "https://theshellx.com"],
    ["surface-components-settings-abouttab-5", "ShellX X profile", "https://x.com/theshellx"],
    ["about-full-manual-link", "full ShellX manual", "https://docs.theshellx.com/manual/shellx/"],
    ["surface-components-settings-abouttab-9", "ShellX GitHub repository", "https://github.com/martinsbrezauckis/shellx"],
    ["surface-components-settings-abouttab-10", "ShellX issue tracker", "https://github.com/martinsbrezauckis/shellx/issues"],
  ].map(([debugId, label, url]) => [`src/components/settings/AboutTab.tsx:[data-debug-id=\"${debugId}\"]`, {
    fixtureId: "ui:about-external-link-baseline",
    expectedEffect: `A native click dispatches the exact ${label} URL (${url}) through ShellX's bounded external-browser handoff.`,
    oracleId: "ui:activation:about-external-link-dispatched",
    cleanupId: "ui:close-about-external-link-and-settings",
  }] as const),
  ["src/components/PluginsModal.tsx::is([title=\"Collapse tier\"],[title=\"Expand tier\"])", {
    fixtureId: "ui:local-disclosure-owned-baseline",
    expectedEffect: "A native click changes one Plugins tier disclosure before exact expansion and modal restoration.",
    oracleId: "ui:disclosure-state-transition",
    cleanupId: "ui:restore-local-disclosure-and-close-owner",
  }],
  ["src/components/LeftRail.tsx::is([title=\"Collapse all projects\"],[title=\"Expand all projects\"])", {
    fixtureId: "ui:local-disclosure-owned-baseline",
    expectedEffect: "A native click changes the Projects disclosure before exact expanded-baseline restoration.",
    oracleId: "ui:disclosure-state-transition",
    cleanupId: "ui:restore-local-disclosure-and-close-owner",
  }],
  ["src/components/LeftRail.tsx::is([title=\"Hide open chats — drop here to unfile\"],[title=\"Show open chats — drop here to unfile\"])", {
    fixtureId: "ui:local-disclosure-owned-baseline",
    expectedEffect: "A native click changes the Open chats disclosure before exact expanded-baseline restoration.",
    oracleId: "ui:disclosure-state-transition",
    cleanupId: "ui:restore-local-disclosure-and-close-owner",
  }],
  ["src/components/LeftRail.tsx:[data-debug-id=\"left-past-chats-toggle\"]", {
    fixtureId: "ui:local-disclosure-owned-baseline",
    expectedEffect: "A native click changes the Past chats disclosure before exact expanded-baseline restoration.",
    oracleId: "ui:disclosure-state-transition",
    cleanupId: "ui:restore-local-disclosure-and-close-owner",
  }],
  ...([
    ["[data-debug-id=\"vault-filter-input\"]", "Vault list filter"],
    ["[data-debug-id=\"vault-secret-key-input\"]", "unsaved secret key"],
    ["[data-debug-id=\"vault-secret-value-input\"]", "unsaved synthetic secret value"],
    ...promotedVaultProfileDraftPlaceholders.map((placeholder) => [
      `[placeholder=\"${placeholder}\"]`,
      `unsaved profile ${placeholder}`,
    ]),
    ...promotedVaultWalletDraftPlaceholders.map((placeholder) => [
      `[placeholder=\"${placeholder}\"]`,
      `unsaved wallet ${placeholder}`,
    ]),
    [
      "[placeholder=\"description visible to agents unless marked user-only\"]",
      "unsaved Vault resource description",
    ],
  ] as const).map(([selector, label]) => [`src/components/settings/VaultTab.tsx:${selector}`, {
    fixtureId: "ui:vault-unsaved-draft-text-baseline",
    expectedEffect: `Native text entry changes only the ${label} before exact value and Settings-owner restoration; no Vault save, credential, grant, or permission action is invoked.`,
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-vault-unsaved-draft-and-settings-owner",
  }] as const),
  ...([
    ["surface-components-settings-vaulttab-45", "unsaved profile user-only", "ui:boolean-state-transition"],
    ["surface-components-settings-vaulttab-48", "unsaved wallet Stripe mode", "ui:choice-state-transition"],
    ["surface-components-settings-vaulttab-57", "unsaved wallet status", "ui:choice-state-transition"],
    ["surface-components-settings-vaulttab-59", "unsaved wallet user-only", "ui:boolean-state-transition"],
  ] as const).map(([debugId, label, oracleId]) => [`src/components/settings/VaultTab.tsx:[data-debug-id=\"${debugId}\"]`, {
    fixtureId: "ui:vault-unsaved-draft-choice-baseline",
    expectedEffect: `Native input changes only the ${label} before exact value and Settings-owner restoration; no Vault save, credential, grant, or permission action is invoked.`,
    oracleId,
    cleanupId: "ui:restore-vault-unsaved-draft-and-settings-owner",
  }] as const),
  ...(["visible", "userOnly", "toolUseAlways", "browserFillAlways"] as const).map((level) => [
    `src/components/settings/VaultTab.tsx:[data-debug-id=\"vault-permission-${level}\"]`,
    {
      fixtureId: "ui:vault-unsaved-draft-permission-baseline",
      expectedEffect: `Native input selects only the unsaved secret ${level} permission level before exact draft and Settings-owner restoration; no Vault save, credential, or grant action is invoked.`,
      oracleId: "ui:boolean-state-transition",
      cleanupId: "ui:restore-vault-unsaved-draft-and-settings-owner",
    },
  ] as const),
  ...([
    ['[placeholder="Server URL"]', "unsaved external Vault server URL"],
    ['[placeholder="Repo"]', "unsaved external Vault repository"],
    ['[placeholder="Access token"]', "unsaved external Vault access-token draft"],
    ['[data-debug-id="shellx-vault-master-passphrase"]', "unsaved Vault master-passphrase draft"],
    ['[data-debug-id="shellx-vault-confirm-passphrase"]', "unsaved Vault passphrase-confirmation draft"],
  ] as const).map(([selector, label]) => [`src/components/settings/VaultSetupPanel.tsx:${selector}`, {
    fixtureId: "ui:vault-unsaved-draft-text-baseline",
    expectedEffect: `Native text entry changes only the ${label} before exact draft, setup-mode, and Settings-owner restoration; no Vault setup, save, credential, grant, or permission action is invoked.`,
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:restore-vault-unsaved-draft-and-settings-owner",
  }] as const),
  ...([
    ['role=button;name="Local"', "unsaved local Vault setup mode"],
    ['role=button;name="External"', "unsaved external Vault setup mode"],
    ['[data-debug-id="shellx-vault-remember-device-setup"]', "unsaved Vault remember-device choice"],
  ] as const).map(([selector, label]) => [`src/components/settings/VaultSetupPanel.tsx:${selector}`, {
    fixtureId: "ui:vault-unsaved-draft-choice-baseline",
    expectedEffect: `Native input changes only the ${label} before exact draft, setup-mode, and Settings-owner restoration; no Vault setup, save, credential, grant, or permission action is invoked.`,
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-vault-unsaved-draft-and-settings-owner",
  }] as const),
  ['src/components/settings/VaultSetupPanel.tsx:role=button;name="Create recovery kit"', {
    fixtureId: "ui:vault-setup-recovery-action",
    expectedEffect: "Native input begins one disposable Vault recovery challenge, proves the recovery-copy action and cleared passphrase fields without observing recovery words, then resets the candidate Vault exactly.",
    oracleId: "ui:activation:vault-recovery-kit-created",
    cleanupId: "ui:reset-disposable-vault-and-close-settings",
  }],
  ['src/components/settings/VaultSetupPanel.tsx:role=input;name="Import existing ShellX secrets"', {
    fixtureId: "ui:vault-setup-recovery-import-choice",
    expectedEffect: "Native input changes only the disposable recovery challenge's legacy-import choice before exact restoration and Vault reset; setup is never confirmed and recovery words are never observed.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:reset-disposable-vault-and-close-settings",
  }],
  ['src/components/settings/VaultSetupPanel.tsx:[data-debug-id="shellx-vault-recovery-confirm"]', {
    fixtureId: "ui:vault-setup-recovery-confirm-action",
    expectedEffect: "Native input confirms one disposable recovery challenge, proves the configured and unlocked Vault state without observing recovery words, then resets the candidate Vault exactly.",
    oracleId: "ui:activation:vault-recovery-confirmed",
    cleanupId: "ui:reset-disposable-vault-and-close-settings",
  }],
  ['src/components/settings/VaultSetupPanel.tsx:[data-debug-id="shellx-vault-change-setup"]', {
    fixtureId: "ui:vault-configured-change-setup-action",
    expectedEffect: "Native input opens the configured Vault setup form while its disposable backend remains configured and unlocked, then resets the candidate Vault exactly.",
    oracleId: "ui:activation:vault-change-setup-opened",
    cleanupId: "ui:reset-disposable-vault-and-close-settings",
  }],
  ['src/components/settings/VaultSetupPanel.tsx:[data-debug-id="shellx-vault-unlock-passphrase"]', {
    fixtureId: "ui:vault-configured-unlock-passphrase",
    expectedEffect: "Native text entry changes only the locked disposable Vault passphrase draft while its backend remains configured and locked, then resets the candidate Vault exactly.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:reset-disposable-vault-and-close-settings",
  }],
  ['src/components/settings/VaultSetupPanel.tsx:[data-debug-id="shellx-vault-remember-device-unlock"]', {
    fixtureId: "ui:vault-configured-unlock-remember-device",
    expectedEffect: "Native input changes only the locked disposable Vault remember-device choice while device remembering stays disabled, then restores the choice and resets the candidate Vault exactly.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:reset-disposable-vault-and-close-settings",
  }],
  ['src/components/settings/VaultSetupPanel.tsx:[data-debug-id="shellx-vault-unlock"]', {
    fixtureId: "ui:vault-configured-unlock-action",
    expectedEffect: "Native input unlocks the configured disposable Vault with an owned passphrase while device remembering remains disabled, then resets the candidate Vault exactly.",
    oracleId: "ui:activation:vault-unlocked",
    cleanupId: "ui:reset-disposable-vault-and-close-settings",
  }],
  ['src/components/settings/VaultSetupPanel.tsx:[data-debug-id="shellx-vault-remember-passphrase"]', {
    fixtureId: "ui:vault-configured-remember-passphrase",
    expectedEffect: "Native text entry changes only the remembered-device passphrase draft while the disposable Vault remains unlocked and device remembering stays disabled, then resets the candidate Vault exactly.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:reset-disposable-vault-and-close-settings",
  }],
  ['src/components/settings/VaultSetupPanel.tsx:[data-debug-id="shellx-vault-remember-device-enable"]', {
    fixtureId: "ui:vault-configured-remember-device-enable",
    expectedEffect: "Native input enables remembered-device credentials only in the isolated disposable Vault namespace, proves the exact configured remembered state, then resets the candidate Vault exactly.",
    oracleId: "ui:activation:vault-remembered-device-enabled",
    cleanupId: "ui:reset-disposable-vault-and-close-settings",
  }],
  ['src/components/settings/VaultSetupPanel.tsx:[data-debug-id="shellx-vault-forget-device"]', {
    fixtureId: "ui:vault-configured-forget-device",
    expectedEffect: "Native input removes remembered-device credentials only from the isolated disposable Vault namespace, proves the exact configured non-remembered state, then resets the candidate Vault exactly.",
    oracleId: "ui:activation:vault-remembered-device-disabled",
    cleanupId: "ui:reset-disposable-vault-and-close-settings",
  }],
  ['src/components/settings/VaultGrantsPanel.tsx:role=button;name="Refresh"', {
    fixtureId: "ui:vault-grants-refresh-owned-grants",
    expectedEffect: "Native input reconciles one rendered owned grant with the exact two-grant disposable backend metadata set without reading secret values.",
    oracleId: "ui:activation:vault-grants-refreshed",
    cleanupId: "ui:reset-disposable-vault-and-close-settings",
  }],
  ['src/components/settings/VaultGrantsPanel.tsx:role=button;name="Revoke"', {
    fixtureId: "ui:vault-grants-revoke-owned-grant",
    expectedEffect: "Native input revokes exactly one approved owned grant in the guarded disposable Vault and removes its active renderer row without reading secret values.",
    oracleId: "ui:activation:vault-grant-revoked",
    cleanupId: "ui:reset-disposable-vault-and-close-settings",
  }],
  ['src/components/VaultPanel.tsx:[data-debug-id="vault-workspace-lock"]', {
    fixtureId: "ui:vault-workspace-lock-action",
    expectedEffect: "Native input locks the configured disposable Vault workspace, exposes its quick-unlock form, and keeps device remembering disabled before exact Vault reset and modal cleanup.",
    oracleId: "ui:activation:vault-locked",
    cleanupId: "ui:reset-disposable-vault-and-close-settings",
  }],
  ['src/components/VaultPanel.tsx:[aria-label="Vault master passphrase"]', {
    fixtureId: "ui:vault-workspace-unlock-passphrase",
    expectedEffect: "Native text entry changes only the locked Vault workspace passphrase draft while its disposable backend remains configured and locked before exact Vault reset and modal cleanup.",
    oracleId: "ui:value-state-transition",
    cleanupId: "ui:reset-disposable-vault-and-close-settings",
  }],
  ['src/components/VaultPanel.tsx:[data-debug-id="surface-components-vaultpanel-5"]', {
    fixtureId: "ui:vault-workspace-unlock-action",
    expectedEffect: "Native input unlocks the configured disposable Vault workspace without silently enabling remembered-device credentials before exact Vault reset and modal cleanup.",
    oracleId: "ui:activation:vault-unlocked",
    cleanupId: "ui:reset-disposable-vault-and-close-settings",
  }],
]);

const NEW_VAULT_RESOURCE_CLEANUP =
  "ui:delete-exact-owned-vault-resources-clear-sensitive-drafts-and-restore-settings";

const promotedVaultOwnedEditControls = new Map<string, {
  fixtureId: string;
  expectedEffect: string;
  oracleId: string;
  cleanupId: string;
}>([
  vaultOwnedEditConfig('[title="Reload key list"]', 4, "ui:vault-owned-secret-redacted-directory", "Native input refreshes the rendered Vault directory and exposes exactly one externally seeded owned metadata row.", "ui:activation:vault-owned-directory-reloaded"),
  vaultOwnedEditConfig('[aria-label="Dismiss notification"]', 5, "ui:vault-owned-secret-revealed-user-action", "Native input dismisses the owned reveal notice after its sensitive value is immediately hidden without entering evidence.", "ui:activation:vault-owned-notice-dismissed"),
  vaultOwnedEditConfig('[aria-label^="Hide value for "]', 9, "ui:vault-owned-secret-revealed-user-action", "Native input hides the deliberately revealed owned value and removes its sensitive input from the rendered tree.", "ui:activation:vault-owned-reveal-hidden"),
  vaultOwnedEditConfig('[aria-label^="Replace value for "]', 10, "ui:vault-owned-secret-redacted-directory", "Native input opens the exact owned row replacement editor with an empty password draft and disabled Save baseline.", "ui:activation:vault-owned-replacement-transition"),
  vaultOwnedEditConfig('[aria-label^="Edit metadata for "]', 11, "ui:vault-owned-secret-redacted-directory", "Native input opens the exact owned metadata editor with its redacted description and agent-visibility baseline.", "ui:activation:vault-owned-metadata-transition"),
  vaultOwnedEditConfig('[aria-label="Hide value"]', 14, "ui:vault-owned-secret-revealed-user-action", "Native input hides the deliberately revealed owned value through its inline action and removes the sensitive input.", "ui:activation:vault-owned-reveal-hidden"),
  vaultOwnedEditConfig('[data-debug-id="vault-description-input"]', 15, "ui:vault-owned-secret-metadata-edit", "Native text entry changes only the owned metadata description draft before deterministic cancellation.", "ui:value-state-transition"),
  vaultOwnedEditConfig('[data-debug-id="vault-user-only-toggle"]', 16, "ui:vault-owned-secret-metadata-edit", "Native input changes only the owned metadata user-only draft before deterministic cancellation.", "ui:boolean-state-transition"),
  vaultOwnedEditConfig('role=button;name="Save"', 17, "ui:vault-owned-secret-metadata-edit", "Native input persists the exact owned description and user-only metadata transition and proves both again after reopening.", "ui:activation:vault-owned-metadata-transition"),
  vaultOwnedEditConfig('[data-debug-id="surface-components-settings-vaulttab-18"]', 18, "ui:vault-owned-secret-metadata-edit", "Native input cancels both owned metadata drafts while preserving the exact redacted directory baseline.", "ui:activation:vault-owned-metadata-transition"),
  vaultOwnedEditConfig('[aria-label^="New value for "]', 19, "ui:vault-owned-secret-replacement-edit", "Native text entry changes the password-only owned replacement draft and enables Save without exposing its contents.", "ui:value-state-transition"),
  vaultOwnedEditConfig('[title="Generate a strong replacement"]', 20, "ui:vault-owned-secret-replacement-edit", "Native input generates a non-empty password-only replacement draft and enables Save without reading its contents.", "ui:activation:vault-owned-replacement-transition"),
  vaultOwnedEditConfig('role=button;name="Save"', 21, "ui:vault-owned-secret-replacement-edit", "Native input saves the owned replacement, closes its editor, and proves a fresh reveal-and-hide transition without secret evidence.", "ui:activation:vault-owned-replacement-transition"),
  vaultOwnedEditConfig('[data-debug-id="surface-components-settings-vaulttab-22"]', 22, "ui:vault-owned-secret-replacement-edit", "Native input cancels the password-only replacement draft and proves the original owned row remains revealable and hideable.", "ui:activation:vault-owned-replacement-transition"),
  vaultOwnedEditConfig('[data-debug-id="vault-description-input"]', 28, "ui:vault-unsaved-new-secret-edit", "Native text entry changes and exactly clears only the unsaved new-secret description without submission.", "ui:value-state-transition"),
  vaultOwnedEditConfig('[data-debug-id="vault-user-only-toggle"]', 29, "ui:vault-unsaved-new-secret-edit", "Native input changes and exactly restores only the unsaved new-secret user-only choice without submission.", "ui:boolean-state-transition"),
  vaultOwnedEditConfig('[aria-label^="Confirm delete "]', 12, "ui:vault-owned-secret-delete", "Native input confirms deletion of the exact owned disposable secret and proves its redacted directory row is absent.", "ui:activation:vault-owned-secret-deleted", NEW_VAULT_RESOURCE_CLEANUP),
  vaultOwnedEditConfig(':is([aria-label="Hide generated secret value"],[aria-label="Reveal generated secret value"])', 25, "ui:vault-unsaved-new-secret-value", "Native input toggles and exactly restores only the unsaved synthetic secret field visibility without observing its contents.", "ui:activation:vault-new-secret-value-visibility", NEW_VAULT_RESOURCE_CLEANUP),
  vaultOwnedEditConfig('[data-debug-id="vault-generate-password"]', 26, "ui:vault-unsaved-new-secret-generator", "Native input opens the password generator for the unsaved owned secret without observing generated contents.", "ui:activation:vault-new-secret-generator-opened", NEW_VAULT_RESOURCE_CLEANUP),
  vaultOwnedEditConfig('[data-debug-id="surface-components-settings-vaulttab-30"]', 30, "ui:vault-owned-new-secret-save", "Native input saves one exact owned disposable password/key, proves only its redacted directory metadata, and deletes it during cleanup.", "ui:activation:vault-owned-resource-saved", NEW_VAULT_RESOURCE_CLEANUP),
  vaultOwnedEditConfig('role=button;name="Save profile card"', 46, "ui:vault-owned-profile-save", "Native input saves one exact owned disposable profile card, proves only its redacted resource metadata, and deletes it during cleanup.", "ui:activation:vault-owned-resource-saved", NEW_VAULT_RESOURCE_CLEANUP),
  vaultOwnedEditConfig('role=button;name="Save wallet"', 60, "ui:vault-owned-wallet-save", "Native input saves one exact owned disposable wallet descriptor, proves only its redacted resource metadata, and deletes it during cleanup.", "ui:activation:vault-owned-resource-saved", NEW_VAULT_RESOURCE_CLEANUP),
  vaultOwnedExternalConfig("src/components/VaultPasswordGenerator.tsx", '[data-debug-id="vault-password-generator-regenerate"]', 7, "ui:vault-unsaved-new-secret-generator", "Native input regenerates the temporary password pocket and resets its visible reveal state without observing generated contents.", "ui:activation:vault-generator-regenerated"),
  vaultOwnedExternalConfig("src/components/VaultPasswordGenerator.tsx", '[data-debug-id="vault-password-generator-use"]', 8, "ui:vault-unsaved-new-secret-generator", "Native input moves the temporary password into the unsaved password field, closes the generator, and proves the non-empty draft only through control enablement.", "ui:activation:vault-generator-used"),
  vaultOwnedExternalConfig("src/components/VaultPasswordGenerator.tsx", '[data-debug-id="vault-password-generator-save"]', 9, "ui:vault-owned-generator-save", "Native input saves the generated password under one exact owned disposable key, proves only redacted metadata, and deletes it during cleanup.", "ui:activation:vault-owned-resource-saved"),
  vaultOwnedExternalConfig("src/components/VaultPasswordGenerator.tsx", 'role=button;name="Replace"', 10, "ui:vault-unsaved-new-secret-generator", "Native input clears and replaces the temporary password pocket while resetting its visible reveal state without observing either value.", "ui:activation:vault-generator-cleared"),
]);

const promotedActivityBrowserLifecycleControls = new Map<string, {
  fixtureId: string;
  expectedEffect: string;
  oracleId: string;
  cleanupId: string;
}>([
  activityBrowserLifecycleConfig('[aria-label="Reset graph layout"]', 13, "Keyboard input nudges the focused owned file node, then native Reset activation restores the deterministic graph layout.", "ui:activation:activity-graph-layout-reset"),
  activityBrowserLifecycleConfig('[data-debug-id="surface-components-activitybrowsermodal-14"]', 14, "Native input selects the exact owned file graph node and renders its matching detail state.", "ui:boolean-state-transition"),
  activityBrowserLifecycleConfig('role=button;name="Open file"', 15, "Native input opens the exact owned graph-detail file in Preview Center with exact Debug API identity.", "ui:activation:activity-owned-file-preview"),
  activityBrowserLifecycleConfig('[data-debug-id="surface-components-activitybrowsermodal-16"]', 16, "Native input opens the exact owned Recent evidence file in Preview Center with exact Debug API identity.", "ui:activation:activity-owned-file-preview"),
  activityBrowserLifecycleConfig('[data-debug-id="surface-components-activitybrowsermodal-17"]', 17, "Native input expands the exact owned nested directory and exposes its file row with declared accessibility state.", "ui:disclosure-state-transition"),
  activityBrowserLifecycleConfig('[data-debug-id="surface-components-activitybrowsermodal-18"]', 18, "Native input opens the exact owned Files-tree file in Preview Center with exact Debug API identity.", "ui:activation:activity-owned-file-preview"),
  activityBrowserLifecycleConfig('[data-debug-id="surface-components-activitybrowsermodal-19"]', 19, "Native input opens the exact owned Timeline file in Preview Center with exact Debug API identity.", "ui:activation:activity-owned-file-preview"),
  activityBrowserLifecycleConfig('[data-debug-id="surface-components-activitybrowsermodal-21"]', 21, "Native input opens the exact owned Evidence-row file in Preview Center with exact Debug API identity.", "ui:activation:activity-owned-file-preview"),
]);

promotedUiControls.set(
  'src/browser/components/AgentSidebar.tsx:[data-debug-id="shellx-browser-sidebar-resize"]',
  {
    fixtureId: "ui:browser-sidebar-width-owned-baseline",
    expectedEffect: "Native keyboard input changes the Browser right-sidebar width by one exact bounded 20px step before exact restoration.",
    oracleId: "ui:activation:browser-sidebar-width-transition",
    cleanupId: "ui:restore-browser-sidebar-width-abort-task-and-window",
  },
);

for (const [surfaceName, action, expectedEffect] of [
  [
    'src/components/BuildRunCockpit.tsx:[title="Approve the Build Mode scratchboard and start execution."]',
    "approve",
    "A native click approves one exact disposable Build scratchboard, observes active state and a PlanApproved receipt, and dispatches the real kickoff prompt only to the isolated fixed JSONL provider child.",
  ],
  [
    'src/components/BuildRunCockpit.tsx:[title="Reject this Build Mode plan and halt the run."]',
    "reject",
    "A native click rejects one exact disposable approval-ready Build run, observes its halted state and PlanRejected receipt, then removes the isolated project and ledger.",
  ],
  [
    'src/components/BuildRunCockpit.tsx:[title="Pause Build Mode auto-continuation."]',
    "pause",
    "A native click pauses one exact disposable active Build run and observes its persisted paused state without contacting a provider.",
  ],
  [
    'src/components/BuildRunCockpit.tsx::is([title="Reconnect this tab and resume Build Mode auto-continuation."],[title="Resume Build Mode auto-continuation."])',
    "resume",
    "A native click resumes one exact disposable paused Build run, generates exactly one real continuation, and dispatches it only to the isolated fixed JSONL provider child.",
  ],
  [
    'src/components/BuildRunCockpit.tsx:[title="Recheck blocker evidence without restarting or prompting the Agent."]',
    "recheck",
    "A native click rechecks one exact disposable satisfied review blocker, observes active state plus a BlockerResolved receipt, and sends no provider prompt.",
  ],
  [
    'src/components/BuildRunCockpit.tsx:[title="Create a local shellX git checkpoint and attach it to this Build Mode run."]',
    "checkpoint",
    "A native click snapshots one exact disposable dirty Git repository, attaches its complete checkpoint identity to the Build ledger, and cleanup removes both namespaces.",
  ],
  [
    'src/components/BuildRunCockpit.tsx:[title="Stop Build Mode manually without accepting completion."]',
    "stop",
    "A native click halts one exact disposable active Build run, observes the exact RunHalted receipt, and clears only its isolated run/provider/project namespaces.",
  ],
] as const) {
  promotedUiControls.set(surfaceName, {
    fixtureId: `ui:build-run-cockpit-owned-${action}`,
    expectedEffect,
    oracleId: "ui:activation:build-run-cockpit-owned-state-transition",
    cleanupId: "ui:clear-owned-build-run-project-provider-git-and-restore-view",
  });
}

for (const [surfaceName, expectedEffect, oracleId] of [
  [
    'src/components/GitPane.tsx:role=button;name="Checkpoint"',
    "A native click creates one exact ShellX checkpoint for a disposable dirty repository and preserves both tracked diff and untracked snapshot evidence before deleting only that checkpoint.",
    "ui:activation:owned-git-checkpoint-created",
  ],
  [
    'src/components/GitPane.tsx:role=button;name="Worktree"',
    "A native click creates one exact in-repository ShellX worktree and owned branch from a disposable release-proof branch before removing both and pruning the worktree registry.",
    "ui:activation:owned-git-worktree-created",
  ],
] as const) {
  promotedUiControls.set(surfaceName, {
    fixtureId: "ui:right-rail-git-owned-write-lifecycle",
    expectedEffect,
    oracleId,
    cleanupId: "ui:remove-owned-checkpoint-worktree-branch-and-repository-restore-right-rail",
  });
}

for (const [tab, label] of [
  ["general", "General"],
  ["vault", "Vault"],
  ["connections", "Connections"],
  ["connectors", "Connectors"],
  ["desktop", "Desktop"],
  ["shellxagent", "shellXagent"],
  ["data", "Data"],
  ["about", "About"],
] as const) {
  promotedUiControls.set(`src/components/Settings.tsx:[data-debug-id="settings-tab-${tab}"]`, {
    fixtureId: "ui:settings-tab-opposite-baseline",
    expectedEffect: `A native click selects ${label} and renders its exact owned Settings tabpanel from an opposite baseline.`,
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:restore-settings-tab-baseline-and-close",
  });
}

for (const [surfaceName, expectedEffect, oracleId] of [
  [
    'src/components/settings/DesktopTab.tsx:[data-debug-id="surface-components-settings-desktoptab-1"]',
    "A native click completes one exact manual Desktop integration status refresh receipt while the native Windows baseline remains absent.",
    "ui:activation:windows-desktop-integration-refresh-receipt",
  ],
  [
    'src/components/settings/DesktopTab.tsx:role=button;name="Install"',
    "A native click installs both exact candidate-owned HKCU Explorer verbs and the exact SendTo shortcut in the receipt-bound disposable Windows user.",
    "ui:activation:windows-desktop-integration-installed",
  ],
  [
    'src/components/settings/DesktopTab.tsx:role=button;name="Remove"',
    "A native click removes both prepared candidate-owned HKCU Explorer verbs and the exact SendTo shortcut from the receipt-bound disposable Windows user.",
    "ui:activation:windows-desktop-integration-removed",
  ],
] as const) {
  promotedUiControls.set(surfaceName, {
    fixtureId: "ui:windows-desktop-integration-empty-baseline",
    expectedEffect,
    oracleId,
    cleanupId: "ui:remove-owned-windows-desktop-integration-restore-settings",
  });
}

for (const [selector, expectedEffect, oracleId] of [
  ["[aria-label=\"All sessions\"]", "A native click opens the exact all-sessions listbox and preserves the renderer tab count and order.", "ui:disclosure-state-transition"],
  ["[aria-label=\"Close session\"]", "A native click removes only one owned strip tab and preserves the exact survivor order without touching a baseline session.", "ui:activation:session-tabs-owned-strip-close"],
  ["[aria-label=\"Rename session\"]", "A native click enters rename mode for one exact owned tab with its current title as the draft.", "ui:activation:session-tabs-rename-trigger"],
  ["[aria-label=\"Scroll left\"]", "A native click decreases the overflowing Session Tabs rail's actual bounded scrollLeft value.", "ui:activation:session-tabs-scroll-left-position"],
  ["[aria-label=\"Scroll right\"]", "A native click increases the overflowing Session Tabs rail's actual bounded scrollLeft value.", "ui:activation:session-tabs-scroll-right-position"],
  ["[data-debug-id=\"session-rename-input\"]", "Native text input commits and reads back one exact owned title before restoring its original value.", "ui:value-state-transition"],
  ["[data-debug-id=\"session-tab\"]", "A native click selects one exact owned strip tab and reads back its activeTabId.", "ui:activation:session-tabs-active-id"],
  ["[data-debug-id=\"surface-components-sessiontabs-11\"]", "A native click on one exact owned dropdown Preview control opens Preview Center and preserves its typed target.", "ui:activation:session-tabs-dropdown-preview-state"],
  ["[data-debug-id=\"surface-components-sessiontabs-4\"]", "A native click on one exact owned strip Preview control opens Preview Center and preserves its typed target.", "ui:activation:session-tabs-strip-preview-state"],
  ["[title^=\"#\"]", "A native click on one exact owned all-sessions row selects its activeTabId and closes the listbox.", "ui:selection-state-transition"],
  ["[title=\"Close\"]", "A native click removes only one owned dropdown tab, preserves survivor order, and keeps the listbox visible.", "ui:activation:session-tabs-owned-dropdown-close"],
  ["[aria-label=\"New session\"]", "A native click appends and activates exactly one owned renderer tab while preserving every baseline tab.", "ui:activation:session-tabs-new-owned-tab"],
] as const) {
  promotedUiControls.set(`${SESSION_TABS_LIFECYCLE_UI_SURFACE_PREFIX}${selector}`, {
    fixtureId: "ui:session-tabs-owned-multi-tab-lifecycle",
    expectedEffect,
    oracleId,
    cleanupId: "ui:delete-owned-session-tabs-and-restore-baseline",
  });
}

for (const [surfaceName, expectedEffect, oracleId] of [
  [
    'src/components/TasksPanel.tsx:[data-debug-id="surface-components-taskspanel-3"]',
    "A native click completes one manual Tasks refresh receipt while retaining the exact owned disposable terminal row.",
    "ui:activation:tasks-panel-manual-refresh-receipt",
  ],
  [
    'src/components/TasksPanel.tsx:[data-debug-id="surface-components-taskspanel-8"]',
    "A native click expands one exact owned task row and reads back its bounded disclosure state without changing the task.",
    "ui:disclosure-state-transition",
  ],
  [
    'src/components/TasksPanel.tsx:[title="Pause (SIGSTOP on Unix, NtSuspendProcess on Windows)"]',
    "A native click pauses only one release-owned disposable PTY and proves its exact stopped registry state.",
    "ui:activation:tasks-panel-owned-task-paused",
  ],
  [
    'src/components/TasksPanel.tsx:[title="Resume (SIGCONT on Unix, NtResumeProcess on Windows)"]',
    "A native click resumes only one release-owned disposable PTY and proves its exact running registry state.",
    "ui:activation:tasks-panel-owned-task-resumed",
  ],
  [
    'src/components/TasksPanel.tsx::is([title="Kill (SIGTERM then SIGKILL after 3s)"],[title="Kill terminal and remove its task row"])',
    "A native click terminates and removes only one exact release-owned disposable PTY while preserving every baseline task.",
    "ui:activation:tasks-panel-owned-task-killed",
  ],
  [
    'src/components/TasksPanel.tsx:[aria-label="Clean Host MCP children for this tab"]',
    "Two native clicks arm and then process-tree-clean only one exact release-owned Host MCP child for the active tab while preserving every baseline task.",
    "ui:boolean-state-transition",
  ],
] as const) {
  promotedUiControls.set(surfaceName, {
    fixtureId: "ui:tasks-panel-owned-process-lifecycles",
    expectedEffect,
    oracleId,
    cleanupId: "ui:kill-owned-processes-and-restore-tasks-view",
  });
}

for (const [surfaceName, expectedEffect, oracleId] of [
  [
    'src/components/ChatOutput.tsx:[data-debug-id="surface-components-chatoutput-1"]',
    "Bounded native upward input exposes Jump to latest, then one native click re-pins the owned transcript and removes the affordance.",
    "ui:activation:chat-output-jump-repinned",
  ],
  [
    'src/components/ChatOutput.tsx:[data-debug-id="surface-components-chatoutput-3"]',
    "A native click opens Preview Center for an exact owned candidate-profile text attachment and proves its path, source context, read kind, and character count.",
    "ui:activation:chat-output-owned-attachment-preview",
  ],
  [
    'src/components/ChatOutput.tsx:[data-debug-id="surface-components-chatoutput-4"]',
    "A native click opens Preview Center for an exact owned candidate-profile diff path and proves its path, source context, read kind, and character count.",
    "ui:activation:chat-output-owned-diff-preview",
  ],
  [
    'src/components/ChatOutput.tsx:[data-debug-id="surface-components-chatoutput-5"]',
    "Native input expands the owned thought disclosure, proves its bounded state, and returns it to the exact collapsed baseline.",
    "ui:disclosure-state-transition",
  ],
  [
    'src/components/ChatOutput.tsx:[aria-label^="Dismiss warning: "]',
    "One native click removes only the owned renderer-loop warning before exact fixture cleanup.",
    "ui:activation:chat-output-owned-doom-warning-dismissed",
  ],
  [
    'src/components/ChatOutput.tsx:[aria-label="Dismiss host MCP unreachable warning"]',
    "One native click removes only the owned renderer host-MCP warning before exact fixture cleanup.",
    "ui:activation:chat-output-owned-host-warning-dismissed",
  ],
] as const) {
  promotedUiControls.set(surfaceName, {
    fixtureId: "ui:chat-output-owned-renderer-lifecycle",
    expectedEffect,
    oracleId,
    cleanupId: "ui:clear-owned-chat-output-events-close-preview-delete-files-and-restore-view",
  });
}

for (const [surfaceName, expectedEffect, oracleId] of [
  [
    'src/components/GitPane.tsx:[data-debug-id="surface-components-gitpane-1"]',
    "A native click re-reads the fixed renderer-owned Git snapshot and advances its bounded manual-refresh receipt without contacting a repository.",
    "ui:activation:git-pane-manual-refresh-receipt",
  ],
  [
    'src/components/GitPane.tsx:role=button;name="Review diff"',
    "A native click renders the fixed renderer-owned HEAD diff without reading Git or filesystem state.",
    "ui:activation:git-pane-owned-diff-rendered",
  ],
  [
    'src/components/GitPane.tsx:[data-debug-id="surface-components-gitpane-5"]',
    "Native tab clicks select every fixed owned diff scope and return to the exact HEAD baseline.",
    "ui:selection-state-transition",
  ],
  [
    'src/components/RightRail.tsx:[title^="Refresh model instruction cards — "][title$=" completed in this view"]',
    "A native click re-reads the fixed renderer-owned model-card policy and advances its bounded manual-refresh receipt without contacting external state.",
    "ui:activation:model-cards-manual-refresh-receipt",
  ],
  [
    'src/components/RightRail.tsx:[data-debug-id="surface-components-rightrail-9"]',
    "A native click re-reads the fixed renderer-owned environment snapshot and advances its bounded manual-refresh receipt without invoking Grok CLI diagnostics.",
    "ui:activation:environment-manual-refresh-receipt",
  ],
  [
    'src/components/RightRail.tsx:role=button;name="Trace"',
    "A native click invokes the production trace-export handler against the fixed renderer-owned environment snapshot and records the exact pre-filesystem boundary without writing an artifact.",
    "ui:activation:environment-trace-export-boundary",
  ],
] as const) {
  promotedUiControls.set(surfaceName, {
    fixtureId: "ui:right-rail-git-owned-read-lifecycle",
    expectedEffect,
    oracleId,
    cleanupId: "ui:clear-owned-right-rail-git-fixture-and-restore-right-rail",
  });
}

for (const [tab, label] of [
  ["tasks", "Tasks"],
  ["tooling", "Tooling"],
  ["git", "Git"],
  ["preview", "Preview"],
  ["plan", "Plan"],
  ["files", "Files"],
] as const) {
  promotedUiControls.set(`src/components/RightRail.tsx:[data-debug-id="right-tab-${tab}"]`, {
    fixtureId: "ui:right-rail-tab-opposite-baseline",
    expectedEffect: `A native click selects ${label} and synchronizes its visible selected owner with exact Debug API state.`,
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:restore-right-rail-tab-baseline",
  });
}

promotedUiControls.set(
  "src/components/BuildRunCockpit.tsx::is([title=\"Show every receipt in this Build Mode run\"],[title=\"Show latest receipts only\"])",
  {
    fixtureId: "ui:build-run-cockpit-owned-terminal-receipts",
    expectedEffect: "A native click expands the fixed terminal Build fixture from six visible receipts to all eight, then cleanup collapses and removes the renderer-only fixture without invoking a Build action.",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:collapse-and-clear-build-run-fixture-restore-right-rail",
  },
);

for (const [surfaceName, fixtureId, expectedEffect, oracleId, cleanupId] of [
  [
    'src/components/PRCreateModal.tsx::is([title="Append the session transcript as an appendix"],[title="No transcript captured yet"])',
    "ui:pr-transcript-owned-renderer-baseline",
    "A native click toggles only the synthetic transcript appendix option in a renderer-owned PR draft, then restores and closes it without creating a PR.",
    "ui:boolean-state-transition",
    "ui:restore-pr-transcript-close-modal-and-clear-events",
  ],
  [
    'src/components/HashAutocomplete.tsx:[data-debug-id="surface-components-hashautocomplete-1"]',
    "ui:hash-autocomplete-owned-composer-baseline",
    "A native click inserts one exact synthetic issue markdown reference into the empty isolated composer, then cleanup clears both the draft and owned item without querying GitHub.",
    "ui:activation:hash-autocomplete-owned-insertion",
    "ui:clear-hash-draft-and-owned-items",
  ],
  [
    'src/lib/markdown-links.tsx:[data-debug-id="surface-lib-markdown-links-1"]',
    "ui:markdown-link-owned-file-projection",
    "A native click opens Preview Center for one exact disposable file projected by the renderer-only markdown fixture, then cleanup closes it and deletes the owned files.",
    "ui:activation:markdown-owned-file-preview-opened",
    "ui:close-preview-clear-events-delete-owned-file-and-restore-chat",
  ],
  [
    'src/lib/markdown-links.tsx:[data-debug-id="surface-lib-markdown-links-2"]',
    "ui:markdown-link-owned-external-projection",
    "A native click dispatches one exact synthetic HTTP link rendered by the production SafeMarkdownLink through ShellX's isolated external-browser handoff without opening an operator browser.",
    "ui:activation:markdown-owned-external-handoff",
    "ui:close-preview-clear-events-delete-owned-file-and-restore-chat",
  ],
  [
    'src/components/UpdateBanner.tsx:role=button;name="Release notes"',
    "ui:update-owned-available-notes",
    "A native click dispatches the exact synthetic GitHub release-notes URL from an isolated available-update banner without opening an operator browser or contacting the updater endpoint.",
    "ui:activation:update-release-notes-external-handoff",
    "ui:clear-owned-update-fixture-and-restore-right-rail",
  ],
  [
    'src/components/RightRail.tsx:role=button;name="Notes"',
    "ui:update-owned-available-notes",
    "A native click dispatches the exact synthetic GitHub release-notes URL from the isolated Tools update card without opening an operator browser or contacting the updater endpoint.",
    "ui:activation:update-release-notes-external-handoff",
    "ui:clear-owned-update-fixture-and-restore-right-rail",
  ],
  [
    'src/components/UpdateBanner.tsx:role=button;name="Install &amp; restart"',
    "ui:update-owned-available-install-boundary",
    "A native click invokes the production update-banner install handler against an isolated signed-update fixture, reaches the exact pre-download install boundary, and records completion without network, file replacement, or relaunch.",
    "ui:activation:update-install-boundary-completed",
    "ui:clear-owned-update-fixture-and-restore-right-rail",
  ],
  [
    'src/components/RightRail.tsx:role=button;name="Check"',
    "ui:update-owned-check",
    "A native click invokes the production Tools updater check handler and projects the exact isolated available release without contacting a network endpoint.",
    "ui:activation:update-check-completed",
    "ui:clear-owned-update-fixture-and-restore-right-rail",
  ],
  [
    'src/components/RightRail.tsx:role=button;name="Install"',
    "ui:update-owned-available-install-boundary",
    "A native click invokes the production Tools updater install handler against an isolated signed-update fixture, reaches the exact pre-download install boundary, and records completion without network, file replacement, or relaunch.",
    "ui:activation:update-install-boundary-completed",
    "ui:clear-owned-update-fixture-and-restore-right-rail",
  ],
  [
    'src/components/settings/AboutTab.tsx:[data-debug-id="surface-components-settings-abouttab-1"]',
    "ui:update-owned-check",
    "A native click invokes the production About updater check handler and projects the exact isolated available release without contacting a network endpoint.",
    "ui:activation:update-check-completed",
    "ui:clear-owned-update-fixture-close-settings-and-restore-baseline",
  ],
  [
    'src/components/settings/AboutTab.tsx:role=button;name="Install &amp; restart"',
    "ui:update-owned-available-install-boundary",
    "A native click invokes the production About updater install handler against an isolated signed-update fixture, reaches the exact pre-download install boundary, and records completion without network, file replacement, or relaunch.",
    "ui:activation:update-install-boundary-completed",
    "ui:clear-owned-update-fixture-close-settings-and-restore-baseline",
  ],
  [
    'src/components/DebugApiConnectionBanner.tsx:[data-debug-id="debug-api-retry"]',
    "ui:debug-api-owned-disconnected-retry",
    "A native click clears the exact disconnected fixture and creates a fresh authenticated renderer Debug UI event-stream generation while retaining an active connection.",
    "ui:activation:debug-api-websocket-reconnected",
    "ui:clear-debug-api-disconnected-fixture",
  ],
  [
    'src/components/ErrorBoundary.tsx:role=button;name="Reset UI"',
    "ui:error-boundary-owned-renderer-crash-reset",
    "A native click resets the React boundary after one isolated transient render crash, restores the app, preserves the backend identity, and creates a fresh renderer event stream.",
    "ui:activation:error-boundary-renderer-recovered",
    "ui:recover-isolated-renderer-and-preserve-backend",
  ],
  [
    'src/components/ErrorBoundary.tsx:role=button;name="Reload window"',
    "ui:error-boundary-owned-renderer-crash-reload",
    "A native click reloads the renderer document after one isolated transient render crash, restores the app, preserves the backend identity, and creates a fresh renderer event stream.",
    "ui:activation:error-boundary-renderer-recovered",
    "ui:recover-isolated-renderer-and-preserve-backend",
  ],
  [
    'src/components/PRCreateModal.tsx:[data-debug-id="surface-components-prcreatemodal-10"]',
    "ui:external-effect-pr-create-boundary",
    "A native click submits a complete explicitly approved PR draft through the production Debug API route and reaches the exact isolated pre-gh/pre-GitHub boundary without spawning a subprocess or mutating remote state.",
    "ui:activation:pr-create-remote-boundary",
    "ui:clear-external-effect-boundary-close-pr-restore-baseline",
  ],
  [
    'src/App.tsx:[aria-label="Download Grok session artifacts"]',
    "ui:external-effect-artifact-archive-boundary",
    "A native click invokes the production artifact-download handler and reaches the exact isolated pre-save-picker boundary without opening an operating-system dialog, walking session files, or writing an archive.",
    "ui:activation:artifact-archive-save-picker-boundary",
    "ui:clear-external-effect-boundary-restore-artifact-control",
  ],
] as const) {
  promotedUiControls.set(surfaceName, { fixtureId, expectedEffect, oracleId, cleanupId });
}

for (const [surfaceName, config] of promotedModalBackdropControls) {
  promotedUiControls.set(surfaceName, {
    fixtureId: config.fixtureId,
    expectedEffect: `A bounded native pointer click on the outer ${config.label} backdrop closes its exact owned modal.`,
    oracleId: "ui:activation:owned-modal-backdrop-closed",
    cleanupId: "ui:close-owned-modal-backdrop",
  });
}

const LEFT_RAIL_LIFECYCLE_CLEANUP =
  "ui:restore-left-rail-titles-assignments-active-tab-close-owned-tabs-delete-owned-project-and-jsonl";
const leftRailLifecycleUiControls = new Map<string, {
  surfaceName: string;
  expectedEffect: string;
  oracleId: string;
}>([
  ["ui-control:src/components/LeftRail.tsx:[aria-label=\"Delete project\"]@src/components/LeftRail.tsx#6", {
    surfaceName: "src/components/LeftRail.tsx:[aria-label=\"Delete project\"]",
    expectedEffect: "A native click opens the exact owned project's deletion dialog before the dedicated lifecycle cancels it and preserves the marker.",
    oracleId: "ui:activation:project-delete-dialog-opened",
  }],
  ["ui-control:src/components/LeftRail.tsx:[data-debug-id=\"left-add-project\"]@src/components/LeftRail.tsx#2", {
    surfaceName: "src/components/LeftRail.tsx:[data-debug-id=\"left-add-project\"]",
    expectedEffect: "A native click creates one inline project draft before the dedicated lifecycle clears it and restores the exact empty project baseline.",
    oracleId: "ui:activation:project-draft-created",
  }],
  ["ui-control:src/components/LeftRail.tsx:[data-debug-id=\"left-project-rename-input\"]@src/components/LeftRail.tsx#4", {
    surfaceName: "src/components/LeftRail.tsx:[data-debug-id=\"left-project-rename-input\"]",
    expectedEffect: "Native text entry persists the exact isolated project name before the dedicated lifecycle deletes its marker and restores the empty project baseline.",
    oracleId: "ui:value-state-transition",
  }],
  ["ui-control:src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-3\"]@src/components/LeftRail.tsx#3", {
    surfaceName: "src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-3\"]",
    expectedEffect: "A native click expands the exact owned project through its caret before the dedicated lifecycle restores and deletes the marker.",
    oracleId: "ui:disclosure-state-transition",
  }],
  ["ui-control:src/components/LeftRail.tsx:[title$=\" — double-click to rename — drop a chat here to file it\"]@src/components/LeftRail.tsx#5", {
    surfaceName: "src/components/LeftRail.tsx:[title$=\" — double-click to rename — drop a chat here to file it\"]",
    expectedEffect: "A native click expands the exact owned project through its main row before the dedicated lifecycle restores and deletes the marker.",
    oracleId: "ui:disclosure-state-transition",
  }],
  ["ui-control:src/components/LeftRail.tsx:[title^=\"Remove the label only — the \"][title$=\" chat(s) stay and reappear under \\\"Past chats\\\".|Remove the project label.\"]@src/components/LeftRail.tsx#21", {
    surfaceName: "src/components/LeftRail.tsx:[title^=\"Remove the label only — the \"][title$=\" chat(s) stay and reappear under \\\"Past chats\\\".|Remove the project label.\"]",
    expectedEffect: "A native click deletes only the exact owned empty project marker before the dedicated lifecycle recreates its disposable working marker.",
    oracleId: "ui:activation:project-marker-deleted",
  }],
  ["ui-control:src/components/LeftRail.tsx:[data-debug-id=\"left-chat-rename-input\"]@src/components/LeftRail.tsx#13", {
    surfaceName: "src/components/LeftRail.tsx:[data-debug-id=\"left-chat-rename-input\"]",
    expectedEffect: "Native text entry renames the exact owned past-session JSONL, persists its title identity, and restores the original title.",
    oracleId: "ui:value-state-transition",
  }],
  ["ui-control:src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-15\"]@src/components/LeftRail.tsx#15", {
    surfaceName: "src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-15\"]",
    expectedEffect: "A native context-menu choice files the exact baseline open tab into one owned project in renderer and persisted tab state.",
    oracleId: "ui:activation:left-rail-open-tab-project-persisted",
  }],
  ["ui-control:src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-17\"]@src/components/LeftRail.tsx#17", {
    surfaceName: "src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-17\"]",
    expectedEffect: "A native context-menu choice persists the exact owned past-session project assignment.",
    oracleId: "ui:activation:left-rail-past-session-project-persisted",
  }],
  ["ui-control:src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-19\"]@src/components/LeftRail.tsx#19", {
    surfaceName: "src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-19\"]",
    expectedEffect: "A bounded native pointer click on the project dialog backdrop cancels it while preserving the exact owned project marker.",
    oracleId: "ui:activation:left-rail-project-dialog-backdrop-cancelled",
  }],
  ["ui-control:src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-24\"]@src/components/LeftRail.tsx#24", {
    surfaceName: "src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-24\"]",
    expectedEffect: "A bounded native pointer click on the session dialog backdrop cancels it without deleting the exact baseline tab.",
    oracleId: "ui:activation:left-rail-session-dialog-backdrop-cancelled",
  }],
  ["ui-control:src/components/LeftRail.tsx:[placeholder=\"Chat title\"]@src/components/LeftRail.tsx#10", {
    surfaceName: "src/components/LeftRail.tsx:[placeholder=\"Chat title\"]",
    expectedEffect: "Native text entry renames the exact baseline open tab in renderer and persisted tab state, then restores its original title.",
    oracleId: "ui:value-state-transition",
  }],
  ["ui-control:src/components/LeftRail.tsx:[title^=\"Focus tab: \"][title$=\" — use Shift+F10 to move it, or drag it to another project\"]@src/components/LeftRail.tsx#11", {
    surfaceName: "src/components/LeftRail.tsx:[title^=\"Focus tab: \"][title$=\" — use Shift+F10 to move it, or drag it to another project\"]",
    expectedEffect: "A native click focuses the exact baseline open-tab identity from an owned opposite active tab.",
    oracleId: "ui:activation:left-rail-open-tab-focused",
  }],
  ["ui-control:src/components/LeftRail.tsx:[title^=\"Open chat \\\"\"][title$=\"\\\" — use Shift+F10 to move it, or drag it to another project\"]@src/components/LeftRail.tsx#7", {
    surfaceName: "src/components/LeftRail.tsx:[title^=\"Open chat \\\"\"][title$=\"\\\" — use Shift+F10 to move it, or drag it to another project\"]",
    expectedEffect: "A native click on a project-nested live-chat row focuses the exact persisted tab identity.",
    oracleId: "ui:activation:left-rail-project-open-tab-focused",
  }],
  ["ui-control:src/components/LeftRail.tsx:[title^=\"Reopen \\\"\"][title$=\")\"]@src/components/LeftRail.tsx#14", {
    surfaceName: "src/components/LeftRail.tsx:[title^=\"Reopen \\\"\"][title$=\")\"]",
    expectedEffect: "A native click reopens exactly one active renderer tab for the exact owned unfiled JSONL session.",
    oracleId: "ui:activation:left-rail-past-session-reopened",
  }],
  ["ui-control:src/components/LeftRail.tsx:[title^=\"Reopen \\\"\"][title$=\"\\\" — use Shift+F10 to move it, or drag it to another project\"]@src/components/LeftRail.tsx#8", {
    surfaceName: "src/components/LeftRail.tsx:[title^=\"Reopen \\\"\"][title$=\"\\\" — use Shift+F10 to move it, or drag it to another project\"]",
    expectedEffect: "A native click reopens exactly one active renderer tab for the exact owned project-filed JSONL session.",
    oracleId: "ui:activation:left-rail-project-past-session-reopened",
  }],
  ["ui-control:src/components/LeftRail.tsx:role=button;name=\"Cancel\"@src/components/LeftRail.tsx#23", {
    surfaceName: "src/components/LeftRail.tsx:role=button;name=\"Cancel\"",
    expectedEffect: "The native project-dialog Cancel button closes its exact dialog while preserving the owned project marker.",
    oracleId: "ui:activation:left-rail-project-dialog-button-cancelled",
  }],
  ["ui-control:src/components/LeftRail.tsx:role=button;name=\"Cancel\"@src/components/LeftRail.tsx#27", {
    surfaceName: "src/components/LeftRail.tsx:role=button;name=\"Cancel\"",
    expectedEffect: "The native session-dialog Cancel button closes its exact dialog without deleting the baseline tab.",
    oracleId: "ui:activation:left-rail-session-dialog-button-cancelled",
  }],
  ["ui-control:src/components/LeftRail.tsx:role=menuitem;name=\"Unfile (remove from project)\"@src/components/LeftRail.tsx#16", {
    surfaceName: "src/components/LeftRail.tsx:role=menuitem;name=\"Unfile (remove from project)\"",
    expectedEffect: "The native open-chat Unfile choice removes the exact project identity from renderer and persisted tab state.",
    oracleId: "ui:activation:left-rail-open-tab-unfiled",
  }],
  ["ui-control:src/components/LeftRail.tsx:role=menuitem;name=\"Unfile (remove from project)\"@src/components/LeftRail.tsx#18", {
    surfaceName: "src/components/LeftRail.tsx:role=menuitem;name=\"Unfile (remove from project)\"",
    expectedEffect: "The native past-chat Unfile choice removes the exact persisted session-project assignment.",
    oracleId: "ui:activation:left-rail-past-session-unfiled",
  }],
  ["ui-control:src/components/LeftRail.tsx:[title^=\"Delete the project label AND permanently remove \"][title$=\" session file(s) from disk.\"]@src/components/LeftRail.tsx#22", {
    surfaceName: "src/components/LeftRail.tsx:[title^=\"Delete the project label AND permanently remove \"][title$=\" session file(s) from disk.\"]",
    expectedEffect: "A native click deletes the exact owned project marker and its one explicitly assigned disposable session JSONL before byte-exact fixture recreation.",
    oracleId: "ui:activation:owned-project-and-session-deleted",
  }],
  ["ui-control:src/components/LeftRail.tsx:role=button;name=\"Delete\"@src/components/LeftRail.tsx#26", {
    surfaceName: "src/components/LeftRail.tsx:role=button;name=\"Delete\"",
    expectedEffect: "The session confirmation Delete button removes only the exact owned disposable session JSONL before byte-exact fixture recreation.",
    oracleId: "ui:activation:owned-session-file-deleted",
  }],
  ["ui-control:src/components/RowActions.tsx:[data-debug-id=\"surface-components-rowactions-1\"]@src/components/RowActions.tsx#1", {
    surfaceName: "src/components/RowActions.tsx:[data-debug-id=\"surface-components-rowactions-1\"]",
    expectedEffect: "The shared Rename affordance changes only the exact owned past-session title and restores its persisted title identity.",
    oracleId: "ui:activation:owned-row-rename-restored",
  }],
  ["ui-control:src/components/RowActions.tsx:[data-debug-id=\"surface-components-rowactions-2\"]@src/components/RowActions.tsx#2", {
    surfaceName: "src/components/RowActions.tsx:[data-debug-id=\"surface-components-rowactions-2\"]",
    expectedEffect: "The shared Delete affordance removes only the exact owned disposable session JSONL before byte-exact fixture recreation.",
    oracleId: "ui:activation:owned-row-delete-completed",
  }],
]);
for (const config of leftRailLifecycleUiControls.values()) {
  promotedUiControls.set(config.surfaceName, {
    fixtureId: "ui:left-rail-owned-lifecycle",
    expectedEffect: config.expectedEffect,
    oracleId: config.oracleId,
    cleanupId: LEFT_RAIL_LIFECYCLE_CLEANUP,
  });
}

for (const [surfaceName, config] of permissionDecisionUiControls) {
  promotedUiControls.set(surfaceName, {
    fixtureId: "ui:permission-owned-" + config.action,
    expectedEffect: "Native installed input drives the real " + config.action
      + " callback from pending to " + config.decision
      + " in renderer-owned memory, then exact cleanup removes only that fixture without launching a provider or changing persistent permission policy.",
    oracleId: "ui:activation:permission-" + config.action + "-transition",
    cleanupId: "ui:clear-owned-permission-decision-and-restore-view",
  });
}

for (const [surfaceName, action] of providerActionUiControls) {
  promotedUiControls.set(surfaceName, {
    fixtureId: `ui:provider-action-owned-${action}`,
    expectedEffect: `A native click dispatches the exact ${action} prompt to one release-owned disposable ShellX provider child through the real provider JSONL registry and proves its matching SHA-256 receipt; the separate provider-route batch retains real-provider stream proof.`,
    oracleId: "ui:activation:provider-action-prompt-dispatched",
    cleanupId: "ui:stop-owned-provider-action-delete-project-and-restore-view",
  });
}

for (const [surfaceName, action] of connectorsProductionUiControls) {
  const effects: Record<string, string> = {
    refresh: "A native Refresh click reloads one exact release-owned connector from the isolated production store and renders its fixed local-session row.",
    save: "Native write-only token input plus Save persists one disabled Inbox connector and its synthetic credential through the isolated production Vault without returning the token.",
    simulate: "Native simulator input creates one production inbound event for the disabled release-owned connector and persists the expected rejected/no-dispatch status.",
    test: "A native Test click reads the synthetic credential through Vault, rejects its deliberate pre-network token shape, and persists the bounded test timestamp and error.",
    delete: "A native Delete click plus exact confirmation removes only the release-owned connector and refreshes the isolated production list.",
  };
  promotedUiControls.set(surfaceName, {
    fixtureId: `ui:connectors-production-owned-${action}`,
    expectedEffect: effects[action]!,
    oracleId: "ui:activation:owned-connector-production-transition",
    cleanupId: "ui:delete-owned-connectors-reset-isolated-vault-restore-settings-and-teardown-profile",
  });
}

const root = resolve(import.meta.dirname, "..");
const inventoryPath = resolve(root, "release", "surface-inventory.json");
const planPath = resolve(root, "release", "surface-driver-plan.json");
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as ReleaseSurfaceInventory;
const current = JSON.parse(readFileSync(planPath, "utf8")) as FinalSurfaceDriverPlan;
const expected = buildExpectedPlan(current, inventory);
const expectedText = `${JSON.stringify(expected, null, 2)}\n`;
const write = process.argv.includes("--write");
const check = process.argv.includes("--check") || !write;

if (write) {
  writeFileSync(planPath, expectedText, "utf8");
  console.log(`Wrote ${planPath}`);
}

if (check) {
  const actual = readFileSync(planPath, "utf8");
  if (!textContentMatches(actual, expectedText)) {
    console.error("Release surface driver plan drifted from its exact inventory backlog assignments.");
    console.error("Run: pnpm surface:driver-plan:write");
    process.exit(1);
  }
}

const curated = expected.assignments.filter((assignment) => !isBacklogDriverId(assignment.driverId)).length;
const backlog = expected.assignments.length - curated;
console.log(
  `Release surface driver plan synced: ${expected.assignments.length} surfaces `
  + `(${curated} executable-lane assignments, ${backlog} explicit building backlog assignments).`,
);

export function buildExpectedPlan(
  plan: FinalSurfaceDriverPlan,
  exactInventory: ReleaseSurfaceInventory,
): FinalSurfaceDriverPlan {
  const curatedDrivers = [
    ...plan.drivers.filter((driver) => (
      !isBacklogDriverId(driver.id)
      && driver.id !== "ui-control-installed"
      && driver.id !== BROWSER_SHIELDS_UI_DRIVER_ID
      && driver.id !== VAULT_OWNED_EDIT_UI_DRIVER_ID
      && driver.id !== VAULT_ROW_REVEAL_DEBUG_DRIVER_ID
      && driver.id !== VAULT_REQUEST_PROMPT_CONTROL_DRIVER_ID
      && driver.id !== VAULT_REQUEST_PROMPT_DEBUG_DRIVER_ID
      && !TRUSTED_VAULT_FILL_DRIVER_IDS.has(driver.id)
      && driver.id !== ACTIVITY_BROWSER_LIFECYCLE_UI_DRIVER_ID
      && driver.id !== CLIPBOARD_LIFECYCLE_UI_DRIVER_ID
      && driver.id !== BOTTOM_TABS_UI_DRIVER_ID
      && driver.id !== BOTTOM_PANEL_LIFECYCLE_UI_DRIVER_ID
      && driver.id !== SCREENSHOT_ATTACHMENT_UI_DRIVER_ID
      && driver.id !== NAVIGATION_TABS_UI_DRIVER_ID
      && driver.id !== SESSION_TABS_LIFECYCLE_UI_DRIVER_ID
      && driver.id !== TASKS_PANEL_LIFECYCLE_UI_DRIVER_ID
      && driver.id !== CHAT_OUTPUT_LIFECYCLE_UI_DRIVER_ID
      && driver.id !== CHAT_OUTPUT_JUMP_DEBUG_DRIVER_ID
      && driver.id !== BROWSER_PERSONAL_LOCK_DEBUG_DRIVER_ID
      && driver.id !== BROWSER_DELEGATION_DEBUG_DRIVER_ID
      && driver.id !== BROWSER_DEVELOPER_EVIDENCE_UI_DRIVER_ID
      && driver.id !== BROWSER_DEVELOPER_EVIDENCE_DEBUG_DRIVER_ID
      && driver.id !== BROWSER_TEACH_CONTROL_DRIVER_ID
      && driver.id !== BROWSER_TEACH_DEBUG_DRIVER_ID
      && driver.id !== "ui-debug-permission-decision-lifecycle-installed"
      && driver.id !== RIGHT_RAIL_GIT_READ_UI_DRIVER_ID
      && driver.id !== RIGHT_RAIL_GIT_WRITE_UI_DRIVER_ID
      && driver.id !== PERMISSION_DECISION_UI_DRIVER_ID
      && driver.id !== PROVIDER_ACTION_UI_DRIVER_ID
      && driver.id !== BROWSER_SAVE_LIFECYCLE_UI_DRIVER_ID
      && driver.id !== CONNECTORS_PRODUCTION_UI_DRIVER_ID
      && driver.id !== LOCAL_DISCLOSURES_UI_DRIVER_ID
      && driver.id !== MODAL_BACKDROP_UI_DRIVER_ID
      && driver.id !== LEFT_RAIL_LIFECYCLE_UI_DRIVER_ID
      && driver.id !== AGENT_CLI_SETUP_LIFECYCLE_UI_DRIVER_ID
      && driver.id !== CONNECTION_LIFECYCLE_UI_DRIVER_ID
      && driver.id !== BRANCH_PICKER_LIFECYCLE_UI_DRIVER_ID
      && driver.id !== WINDOWS_DESKTOP_INTEGRATION_UI_DRIVER_ID
      && driver.id !== UI_CONTROL_BOUNDED_INSTALLED_DRIVER_ID
      && driver.id !== KEYBOARD_NATIVE_PICKER_DRIVER_ID
      && driver.id !== PALETTE_NATIVE_PICKER_DRIVER_ID
      && driver.id !== PALETTE_PROVIDER_ACTION_DRIVER_ID
      && driver.id !== UI_NATIVE_PICKER_DRIVER_ID
      && driver.id !== PLUGINS_PRODUCTION_UI_DRIVER_ID
    )),
    browserShieldsUiDriver,
    vaultOwnedEditUiDriver,
    vaultRowRevealDebugDriver,
    vaultRequestPromptControlDriver,
    vaultRequestPromptDebugDriver,
    trustedVaultFillBrowserCliDriver,
    trustedVaultFillHostMcpDriver,
    trustedVaultFillTauriDriver,
    trustedVaultFillUiControlDriver,
    trustedVaultFillUiDebugDriver,
    activityBrowserLifecycleUiDriver,
    clipboardLifecycleUiDriver,
    bottomTabsUiDriver,
    bottomPanelLifecycleUiDriver,
    screenshotAttachmentUiDriver,
    navigationTabsUiDriver,
    sessionTabsLifecycleUiDriver,
    tasksPanelLifecycleUiDriver,
    chatOutputLifecycleUiDriver,
    chatOutputJumpDebugDriver,
    browserPersonalLockDebugDriver,
    browserDelegationDebugDriver,
    browserDeveloperEvidenceUiDriver,
    browserDeveloperEvidenceDebugDriver,
    browserTeachUiDriver,
    browserTeachDebugDriver,
    rightRailGitReadUiDriver,
    rightRailGitWriteUiDriver,
    permissionDecisionUiDriver,
    providerActionUiDriver,
    browserSaveLifecycleUiDriver,
    connectorsProductionUiDriver,
    localDisclosuresUiDriver,
    modalBackdropUiDriver,
    leftRailLifecycleUiDriver,
    agentCliSetupLifecycleUiDriver,
    connectionLifecycleUiDriver,
    branchPickerLifecycleUiDriver,
    windowsDesktopIntegrationUiDriver,
    boundedInstalledUiDriver,
    keyboardNativePickerDriver,
    paletteNativePickerDriver,
    paletteProviderActionDriver,
    uiNativePickerDriver,
    pluginsProductionUiDriver,
  ];
  const promotedSurfaceIds = new Set(
    exactInventory.items
      .filter((surface) => trustedVaultFillPromotions.has(surface.id) || (
        surface.kind === "tauri-command" && promotedTauriCommands.has(surface.name)
      ) || (
        surface.kind === "debug-api-route"
          && (
            promotedDebugApiReads.has(surface.name)
            || promotedDebugApiMutations.has(surface.name)
            || promotedDebugApiGitMutations.has(surface.name)
            || promotedDebugApiBrowserVaultDepositMutations.has(surface.name)
            || promotedDebugApiBrowserWindowMutations.has(surface.name)
            || promotedDebugApiGoalLifecycleMutations.has(surface.name)
            || promotedDebugApiVaultOpenPanelMutations.has(surface.name)
            || promotedDebugApiProviderLifecycleMutations.has(surface.name)
            || promotedDebugApiBrowserLifecycleMutations.has(surface.name)
            || promotedDebugApiBrowserTeachDeveloperMutations.has(surface.name)
            || promotedDebugApiBrowserEvidenceArtifactMutations.has(surface.name)
            || promotedDebugApiBrowserMonotonicMutations.has(surface.name)
            || promotedDebugApiBrowserTransferIntentMutations.has(surface.name)
            || promotedDebugApiBrowserRobotMutations.has(surface.name)
            || promotedDebugApiBrowserPendingRequestMutations.has(surface.name)
            || promotedDebugApiBrowserRenderedCheckMutations.has(surface.name)
            || promotedDebugApiPreviewLifecycleMutations.has(surface.name)
            || promotedDebugApiVaultMutations.has(surface.name)
            || promotedDebugApiVaultSetupMutations.has(surface.name)
            || promotedDebugApiVaultAgentRequestMutations.has(surface.name)
            || promotedDebugApiFsWatchMutations.has(surface.name)
            || promotedDebugApiTauriInvokeRelayMutations.has(surface.name)
            || promotedDebugApiEnginePoolMutations.has(surface.name)
            || promotedDebugApiPanelMutations.has(surface.name)
            || promotedDebugApiPreviewTargetMutations.has(surface.name)
            || promotedDebugApiSettingsMutations.has(surface.name)
            || promotedDebugApiConnectionMutations.has(surface.name)
            || promotedDebugApiOutsideConnectorMutations.has(surface.name)
            || promotedDebugApiUiMutations.has(surface.name)
            || promotedDebugApiOperatorGates.has(surface.name)
            || promotedDebugApiVaultE2eMutations.has(surface.name)
            || promotedDebugApiVaultGrantMutations.has(surface.name)
            || promotedDebugApiBoundedPostReads.has(surface.name)
            || promotedDebugApiClipboardLifecycles.has(surface.name)
            || promotedDebugApiNativePickerLifecycles.has(surface.name)
            || promotedDebugApiRemoteApprovalGates.has(surface.name)
            || promotedDebugApiRawRevealDenials.has(surface.name)
            || promotedDebugApiSafeRefusals.has(surface.name)
          )
      ) || (
        surface.kind === "browser-cli-command"
          && (
            promotedBrowserCliWorkflows.has(surface.name)
            || promotedBrowserCliReads.has(surface.name)
            || promotedBrowserCliRenderedChecks.has(surface.name)
            || promotedBrowserCliArtifacts.has(surface.name)
            || promotedBrowserCliRecipeWorkflows.has(surface.name)
            || promotedBrowserCliActions.has(surface.name)
          )
      ) || (
        surface.kind === "host-mcp-tool"
          && (promotedHostMcpReads.has(surface.name) || promotedHostMcpWrites.has(surface.name))
      ) || (
        surface.kind === "palette-action" && promotedPaletteActions.has(surface.name)
      ) || (
        surface.kind === "keyboard-shortcut" && promotedKeyboardShortcuts.has(surface.name)
      ) || (
        surface.kind === "shellx-command" && promotedShellxCommands.has(surface.name)
      ) || (
        surface.kind === "ui-control"
          && (promotedUiControls.has(surface.name)
            || promotedVaultOwnedEditControls.has(surface.id)
            || promotedVaultRequestPromptControls.has(surface.id)
            || promotedActivityBrowserLifecycleControls.has(surface.id)
            || SCREENSHOT_ATTACHMENT_UI_SURFACE_IDS.has(surface.id)
            || BROWSER_SAVE_LIFECYCLE_UI_SURFACE_IDS.has(surface.id)
            || BROWSER_DEVELOPER_EVIDENCE_UI_SURFACE_IDS.has(surface.id)
            || BROWSER_TEACH_CONTROL_SURFACE_IDS.has(surface.id)
            || agentCliSetupLifecycleUiControls.has(surface.id)
            || goalPlanReviewLifecycleUiControls.has(surface.id)
            || CLIPBOARD_LIFECYCLE_UI_SURFACE_IDS.has(surface.id)
            || PLUGINS_PRODUCTION_UI_CONTROLS.has(surface.id)
          )
      ) || (
        surface.kind === "ui-debug-surface"
          && (
            promotedVaultRequestPromptDebugSurfaces.has(surface.id)
            || surface.id === VAULT_ROW_REVEAL_DEBUG_SURFACE_ID
            || BROWSER_PERSONAL_LOCK_DEBUG_SURFACE_IDS.has(surface.id)
            || BROWSER_DELEGATION_DEBUG_SURFACE_IDS.has(surface.id)
            || BROWSER_DEVELOPER_EVIDENCE_DEBUG_SURFACE_IDS.has(surface.id)
            || BROWSER_TEACH_DEBUG_ASSIGNMENT_IDS.has(surface.id)
            || releaseUiDebugSurfaceCohort(surface) !== null
            || surface.name === CHAT_OUTPUT_JUMP_DEBUG_SURFACE_NAME
          )
      ) || (
        NATIVE_PICKER_SURFACE_IDS.has(surface.id)
      ))
      .map((surface) => surface.id),
  );
  const inventorySurfaceIds = new Set(exactInventory.items.map((surface) => surface.id));
  const promotedOccurrenceIndependentIds = new Set(
    exactInventory.items
      .filter((surface) => promotedSurfaceIds.has(surface.id))
      .map((surface) => occurrenceIndependentSurfaceId(surface.id)),
  );
  const inventoryById = new Map(exactInventory.items.map((surface) => [surface.id, surface]));
  const curatedAssignments = plan.assignments.filter((assignment) => (
    !isBacklogDriverId(assignment.driverId)
      && !isRetiredSurfaceAssignment(assignment.surfaceId)
      && !promotedSurfaceIds.has(assignment.surfaceId)
      && (
        inventorySurfaceIds.has(assignment.surfaceId)
        || !promotedOccurrenceIndependentIds.has(occurrenceIndependentSurfaceId(assignment.surfaceId))
      )
  )).map((assignment) => {
    const surface = inventoryById.get(assignment.surfaceId);
    return assignment.driverId === "ui-control-installed"
      && surface
      && UI_CONTROL_BOUNDED_INSTALLED_SURFACE_NAMES.has(surface.name)
      ? { ...assignment, driverId: UI_CONTROL_BOUNDED_INSTALLED_DRIVER_ID }
      : assignment;
  });
  const promotedAssignments = exactInventory.items
    .filter((surface) => promotedSurfaceIds.has(surface.id))
    .map((surface) => {
      const trustedVaultFill = trustedVaultFillPromotions.get(surface.id);
      if (trustedVaultFill) {
        return {
          surfaceId: surface.id,
          driverId: trustedVaultFill.driverId,
          fixtureId: trustedVaultFill.fixtureId,
          expectedEffect: trustedVaultFill.expectedEffect,
          oracleId: trustedVaultFill.oracleId,
          cleanupId: trustedVaultFill.cleanupId,
        };
      }
      if (NATIVE_PICKER_SURFACE_IDS.has(surface.id)) return promotedNativePickerAssignment(surface);
      if (surface.kind === "tauri-command") return promotedTauriAssignment(surface);
      if (surface.kind === "debug-api-route") {
        if (promotedDebugApiBrowserVaultDepositMutations.has(surface.name)) return promotedDebugApiBrowserVaultDepositMutationAssignment(surface);
        if (promotedDebugApiBrowserWindowMutations.has(surface.name)) return promotedDebugApiBrowserWindowMutationAssignment(surface);
        if (promotedDebugApiGitMutations.has(surface.name)) return promotedDebugApiGitMutationAssignment(surface);
        if (promotedDebugApiGoalLifecycleMutations.has(surface.name)) return promotedDebugApiGoalLifecycleMutationAssignment(surface);
        if (promotedDebugApiVaultOpenPanelMutations.has(surface.name)) return promotedDebugApiVaultOpenPanelMutationAssignment(surface);
        if (promotedDebugApiProviderLifecycleMutations.has(surface.name)) return promotedDebugApiProviderLifecycleMutationAssignment(surface);
        if (promotedDebugApiRawRevealDenials.has(surface.name)) return promotedDebugApiRawRevealDenialAssignment(surface);
        if (promotedDebugApiSafeRefusals.has(surface.name)) return promotedDebugApiSafeRefusalAssignment(surface);
        if (promotedDebugApiBrowserLifecycleMutations.has(surface.name)) return promotedDebugApiBrowserLifecycleMutationAssignment(surface);
        if (promotedDebugApiBrowserTeachDeveloperMutations.has(surface.name)) return promotedDebugApiBrowserTeachDeveloperMutationAssignment(surface);
        if (promotedDebugApiBrowserEvidenceArtifactMutations.has(surface.name)) return promotedDebugApiBrowserEvidenceArtifactMutationAssignment(surface);
        if (promotedDebugApiBrowserMonotonicMutations.has(surface.name)) return promotedDebugApiBrowserMonotonicMutationAssignment(surface);
        if (promotedDebugApiBrowserTransferIntentMutations.has(surface.name)) return promotedDebugApiBrowserTransferIntentMutationAssignment(surface);
        if (promotedDebugApiBrowserRobotMutations.has(surface.name)) return promotedDebugApiBrowserRobotMutationAssignment(surface);
        if (promotedDebugApiBrowserPendingRequestMutations.has(surface.name)) return promotedDebugApiBrowserPendingRequestMutationAssignment(surface);
        if (promotedDebugApiBrowserRenderedCheckMutations.has(surface.name)) return promotedDebugApiBrowserRenderedCheckMutationAssignment(surface);
        if (promotedDebugApiPreviewLifecycleMutations.has(surface.name)) return promotedDebugApiPreviewLifecycleMutationAssignment(surface);
        if (promotedDebugApiOperatorGates.has(surface.name)) return promotedDebugApiOperatorGateAssignment(surface);
        if (promotedDebugApiVaultE2eMutations.has(surface.name)) return promotedDebugApiVaultE2eMutationAssignment(surface);
        if (promotedDebugApiVaultGrantMutations.has(surface.name)) return promotedDebugApiVaultGrantMutationAssignment(surface);
        if (promotedDebugApiBoundedPostReads.has(surface.name)) return promotedDebugApiBoundedPostReadAssignment(surface);
        if (promotedDebugApiClipboardLifecycles.has(surface.name)) return promotedDebugApiClipboardLifecycleAssignment(surface);
        if (promotedDebugApiNativePickerLifecycles.has(surface.name)) return promotedDebugApiNativePickerLifecycleAssignment(surface);
        if (promotedDebugApiRemoteApprovalGates.has(surface.name)) return promotedDebugApiRemoteApprovalGateAssignment(surface);
        if (promotedDebugApiVaultMutations.has(surface.name)) return promotedDebugApiVaultMutationAssignment(surface);
        if (promotedDebugApiVaultSetupMutations.has(surface.name)) return promotedDebugApiVaultSetupMutationAssignment(surface);
        if (promotedDebugApiVaultAgentRequestMutations.has(surface.name)) return promotedDebugApiVaultAgentRequestMutationAssignment(surface);
        if (promotedDebugApiFsWatchMutations.has(surface.name)) return promotedDebugApiFsWatchMutationAssignment(surface);
        if (promotedDebugApiTauriInvokeRelayMutations.has(surface.name)) return promotedDebugApiTauriInvokeRelayMutationAssignment(surface);
        if (promotedDebugApiEnginePoolMutations.has(surface.name)) return promotedDebugApiEnginePoolMutationAssignment(surface);
        if (promotedDebugApiPanelMutations.has(surface.name)) return promotedDebugApiPanelMutationAssignment(surface);
        if (promotedDebugApiPreviewTargetMutations.has(surface.name)) return promotedDebugApiPreviewTargetMutationAssignment(surface);
        if (promotedDebugApiSettingsMutations.has(surface.name)) return promotedDebugApiSettingsMutationAssignment(surface);
        if (promotedDebugApiConnectionMutations.has(surface.name)) return promotedDebugApiConnectionMutationAssignment(surface);
        if (promotedDebugApiOutsideConnectorMutations.has(surface.name)) return promotedDebugApiOutsideConnectorMutationAssignment(surface);
        if (promotedDebugApiUiMutations.has(surface.name)) return promotedDebugApiUiMutationAssignment(surface);
        return promotedDebugApiMutations.has(surface.name)
          ? promotedDebugApiMutationAssignment(surface)
          : promotedDebugApiReadAssignment(surface);
      }
      if (surface.kind === "host-mcp-tool") {
        return promotedHostMcpWrites.has(surface.name)
          ? promotedHostMcpWriteAssignment(surface)
          : promotedHostMcpReadAssignment(surface);
      }
      if (surface.kind === "ui-debug-surface") {
        return surface.id === VAULT_ROW_REVEAL_DEBUG_SURFACE_ID
          ? promotedVaultRowRevealDebugAssignment(surface)
          : promotedVaultRequestPromptDebugSurfaces.has(surface.id)
          ? promotedVaultRequestPromptDebugAssignment(surface)
          : promotedUiDebugAssignment(surface);
      }
      if (surface.kind === "palette-action") return promotedPaletteActionAssignment(surface);
      if (surface.kind === "keyboard-shortcut") return promotedKeyboardShortcutAssignment(surface);
      if (surface.kind === "shellx-command") return promotedShellxCommandAssignment(surface);
      if (surface.kind === "ui-control") {
        if (BROWSER_TEACH_CONTROL_SURFACE_IDS.has(surface.id)) {
          return promotedBrowserTeachUiAssignment(surface);
        }
        if (BROWSER_DEVELOPER_EVIDENCE_UI_SURFACE_IDS.has(surface.id)) {
          return promotedBrowserDeveloperEvidenceUiAssignment(surface);
        }
        if (BROWSER_SAVE_LIFECYCLE_UI_SURFACE_IDS.has(surface.id)) {
          return promotedBrowserSaveLifecycleAssignment(surface);
        }
        if (SCREENSHOT_ATTACHMENT_UI_SURFACE_IDS.has(surface.id)) {
          return promotedScreenshotAttachmentAssignment(surface);
        }
        if (PLUGINS_PRODUCTION_UI_CONTROLS.has(surface.id)) {
          return promotedPluginsProductionAssignment(surface);
        }
        if (CLIPBOARD_LIFECYCLE_UI_SURFACE_IDS.has(surface.id)) {
          return promotedClipboardLifecycleAssignment(surface);
        }
        if (promotedVaultRequestPromptControls.has(surface.id)) {
          return promotedVaultRequestPromptControlAssignment(surface);
        }
        if (agentCliSetupLifecycleUiControls.has(surface.id)) {
          return promotedAgentCliSetupLifecycleAssignment(surface);
        }
        if (promotedActivityBrowserLifecycleControls.has(surface.id)) {
          return promotedActivityBrowserLifecycleAssignment(surface);
        }
        return promotedVaultOwnedEditControls.has(surface.id)
          ? promotedVaultOwnedEditAssignment(surface)
          : promotedUiDialogAssignment(surface);
      }
      if (promotedBrowserCliReads.has(surface.name)) return promotedBrowserCliReadAssignment(surface);
      if (promotedBrowserCliRenderedChecks.has(surface.name)) return promotedBrowserCliRenderedCheckAssignment(surface);
      if (promotedBrowserCliArtifacts.has(surface.name)) return promotedBrowserCliArtifactAssignment(surface);
      if (promotedBrowserCliRecipeWorkflows.has(surface.name)) return promotedBrowserCliRecipeWorkflowAssignment(surface);
      return promotedBrowserCliActions.has(surface.name)
        ? promotedBrowserCliActionAssignment(surface)
        : promotedBrowserCliWorkflowAssignment(surface);
    });
  const curatedSurfaceIds = new Set<string>();

  for (const assignment of [...curatedAssignments, ...promotedAssignments]) {
    if (!inventoryById.has(assignment.surfaceId)) {
      throw new Error(`curated assignment ${assignment.surfaceId} is outside the exact inventory`);
    }
    if (curatedSurfaceIds.has(assignment.surfaceId)) {
      throw new Error(`curated surface ${assignment.surfaceId} is assigned more than once`);
    }
    curatedSurfaceIds.add(assignment.surfaceId);
  }

  const drivers = [
    ...curatedDrivers,
    ...kinds.map(backlogDriver),
  ];
  const assignments = [
    ...curatedAssignments,
    ...promotedAssignments,
    ...exactInventory.items
      .filter((surface) => !curatedSurfaceIds.has(surface.id))
      .map(backlogAssignment),
  ];

  return {
    schema: FINAL_SURFACE_DRIVER_PLAN_SCHEMA,
    mode: "final-frozen-candidate",
    inventoryDigest: exactInventory.digest,
    releaseReady: assignments.length === exactInventory.items.length
      && assignments.every((assignment) => !isBacklogDriverId(assignment.driverId)),
    drivers,
    assignments,
  };
}

function occurrenceIndependentSurfaceId(surfaceId: string): string {
  return surfaceId.replace(/#\d+$/, "");
}

function isRetiredSurfaceAssignment(surfaceId: string): boolean {
  return surfaceId === "tauri-command:pty_attach"
    || surfaceId.includes("@src/components/PermissionModal.tsx")
    || surfaceId.includes('src/components/BottomPanel.tsx:[title^="ACP terminal "]')
    || surfaceId.includes('src/components/BottomPanel.tsx:[aria-label="close terminal tab"]')
    || surfaceId.includes('src/components/BottomPanel.tsx:role=button;name="shell"')
    || surfaceId.includes('src/browser/components/BookmarkSidecar.tsx:[aria-label="New folder"]')
    || surfaceId.includes('src/browser/components/BookmarkSidecar.tsx:[aria-label="Add link"]')
    || surfaceId.includes('src/browser/components/BookmarkSidecar.tsx:[data-debug-id="surface-browser-components-bookmarksidecar-5"]')
    || surfaceId.includes('ui-debug-surface:surface-browser-components-bookmarksidecar-5@');
}

function promotedPluginsProductionAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const config = PLUGINS_PRODUCTION_UI_CONTROLS.get(surface.id);
  if (!config) throw new Error(`missing promoted Plugins production control config for ${surface.id}`);
  return {
    surfaceId: surface.id,
    driverId: PLUGINS_PRODUCTION_UI_DRIVER_ID,
    fixtureId: "ui:plugins-owned-production-profile",
    ...config,
    cleanupId: "ui:restore-owned-plugin-config-delete-synthetic-vault-key-and-close-modal",
  };
}

function promotedBrowserSaveLifecycleAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!BROWSER_SAVE_LIFECYCLE_UI_SURFACE_IDS.has(surface.id)) {
    throw new Error(`missing promoted Browser Save lifecycle config for ${surface.id}`);
  }
  return {
    surfaceId: surface.id,
    driverId: BROWSER_SAVE_LIFECYCLE_UI_DRIVER_ID,
    fixtureId: "ui:browser-save-owned-page-and-download-folder",
    expectedEffect: "A native installed-app click performs the exact Browser Save action against one owned local page: local saves prove contained artifact bytes, MIME type, SHA-256, and completed transfer identity before immediate file deletion; copy jobs prove a queued transfer intent; monotonic rows end with candidate teardown.",
    oracleId: "ui:activation:browser-save-artifact-or-intent-recorded",
    cleanupId: "ui:close-owned-browser-task-with-candidate-teardown",
  };
}

function promotedScreenshotAttachmentAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!SCREENSHOT_ATTACHMENT_UI_SURFACE_IDS.has(surface.id)) {
    throw new Error(`missing promoted screenshot attachment config for ${surface.id}`);
  }
  return {
    surfaceId: surface.id,
    driverId: SCREENSHOT_ATTACHMENT_UI_DRIVER_ID,
    fixtureId: "ui:isolated-profile-empty-composer-screenshot",
    expectedEffect: "A native click invokes the production app-window capture path, creates one regular PNG inside the isolated profile, and attaches that exact path as a removable image chip.",
    oracleId: "ui:activation:owned-app-screenshot-attached",
    cleanupId: "ui:remove-exact-screenshot-attachment-delete-owned-png-restore-view",
  };
}

function promotedVaultRequestPromptControlAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const config = promotedVaultRequestPromptControls.get(surface.id);
  if (!config) throw new Error(`missing promoted Vault request/prompt control config for ${surface.id}`);
  return {
    surfaceId: surface.id,
    driverId: VAULT_REQUEST_PROMPT_CONTROL_DRIVER_ID,
    ...config,
  };
}

function promotedVaultRequestPromptDebugAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const config = promotedVaultRequestPromptDebugSurfaces.get(surface.id);
  if (!config) throw new Error(`missing promoted Vault request/prompt debug config for ${surface.id}`);
  return {
    surfaceId: surface.id,
    driverId: VAULT_REQUEST_PROMPT_DEBUG_DRIVER_ID,
    ...config,
  };
}

function promotedUiDebugAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (BROWSER_TEACH_DEBUG_ASSIGNMENT_IDS.has(surface.id)) {
    return {
      surfaceId: surface.id,
      driverId: BROWSER_TEACH_DEBUG_DRIVER_ID,
      fixtureId: BROWSER_TEACH_INSTALLED_FIXTURE,
      expectedEffect: `${surface.name} becomes visible only through the exact native Browser Teach lifecycle over owned redacted Flight Recorder evidence; approval remains Tauri-only and the disposable Vault profile is removed during candidate teardown.`,
      oracleId: BROWSER_TEACH_INSTALLED_DEBUG_ORACLE,
      cleanupId: BROWSER_TEACH_INSTALLED_CLEANUP,
    };
  }
  if (BROWSER_DEVELOPER_EVIDENCE_DEBUG_SURFACE_IDS.has(surface.id)) {
    return {
      surfaceId: surface.id,
      driverId: BROWSER_DEVELOPER_EVIDENCE_DEBUG_DRIVER_ID,
      fixtureId: "ui:browser-developer-evidence-owned-marker-state",
      expectedEffect: `${surface.name} resolves only after native installed input establishes the exact owned Browser Evidence-to-Teach or Developer inspection state; Developer Mode site approval, private receipt state, task, tab, window, and loopback page are cleared during cleanup.`,
      oracleId: "ui:visible-browser-developer-evidence-marker",
      cleanupId: "ui:clear-browser-developer-marker-state-close-owned-task-and-window",
    };
  }
  if (BROWSER_PERSONAL_LOCK_DEBUG_SURFACE_IDS.has(surface.id)) {
    return {
      surfaceId: surface.id,
      driverId: BROWSER_PERSONAL_LOCK_DEBUG_DRIVER_ID,
      fixtureId: "ui:browser-personal-lock-owned-settings",
      expectedEffect: `${surface.name} is established through real native set-PIN, lock, and PIN-backed unlock input in an isolated personal Browser profile, followed by exact verifier, tab, task, and window cleanup without exposing the PIN.`,
      oracleId: "ui:activation:browser-personal-lock-pin-lifecycle",
      cleanupId: "ui:restore-browser-personal-lock-settings-abort-task-and-window",
    };
  }
  if (BROWSER_DELEGATION_DEBUG_SURFACE_IDS.has(surface.id)) {
    return {
      surfaceId: surface.id,
      driverId: BROWSER_DELEGATION_DEBUG_DRIVER_ID,
      fixtureId: "ui:browser-owned-tab-delegation-marker",
      expectedEffect: `${surface.name} becomes reachable through the genuine native-input trusted handoff/take-back lifecycle on an exact owned disposable Browser tab, followed by exact tab, task, and window restoration.`,
      oracleId: "ui:activation:owned-browser-tab-delegation-marker",
      cleanupId: "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window",
    };
  }
  if (surface.name === CHAT_OUTPUT_JUMP_DEBUG_SURFACE_NAME) {
    return {
      surfaceId: surface.id,
      driverId: CHAT_OUTPUT_JUMP_DEBUG_DRIVER_ID,
      fixtureId: "ui:chat-output-owned-native-scroll-marker",
      expectedEffect: "Native upward input exposes the genuine Jump to latest marker, then its exact selector resolves to a non-empty visible rectangle on the attested renderer.",
      oracleId: "ui:visible-native-scroll-marker-rectangle",
      cleanupId: "ui:clear-owned-chat-output-scroll-marker-and-restore-view",
    };
  }
  const cohort = releaseUiDebugSurfaceCohort(surface);
  if (!cohort) throw new Error(`missing promoted UI debug cohort for ${surface.id}`);
  return {
    surfaceId: surface.id,
    driverId: "ui-debug-surface-installed",
    fixtureId: cohort.fixtureId,
    expectedEffect: `${surface.name} resolves on the attested ${cohort.debugSurface} renderer after its exact owned fixture state is established; no control activation is claimed.`,
    oracleId: RELEASE_UI_DEBUG_ORACLE_ID,
    cleanupId: releaseUiDebugCleanupIdForFixture(cohort.fixtureId),
  };
}

function promotedBrowserTeachUiAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!BROWSER_TEACH_CONTROL_SURFACE_IDS.has(surface.id)) {
    throw new Error(`missing Browser Teach control config for ${surface.id}`);
  }
  const oracleId = surface.name.includes("teach-issue-action-")
    ? BROWSER_TEACH_INSTALLED_CONTROL_ORACLES[1]
    : surface.name.includes("teach-vault-binding-")
      ? BROWSER_TEACH_INSTALLED_CONTROL_ORACLES[3]
      : surface.name.includes("teach-goal")
        || surface.name.includes("teach-value-label-")
        || surface.name.includes("teach-value-literal-")
        ? BROWSER_TEACH_INSTALLED_CONTROL_ORACLES[2]
        : BROWSER_TEACH_INSTALLED_CONTROL_ORACLES[0];
  return {
    surfaceId: surface.id,
    driverId: BROWSER_TEACH_CONTROL_DRIVER_ID,
    fixtureId: BROWSER_TEACH_INSTALLED_FIXTURE,
    expectedEffect: `${surface.name} is exercised through native installed input across the owned Browser Teach review, save/conflict, approval, rehearsal, receipt, and redacted disposable-Vault lifecycle.`,
    oracleId,
    cleanupId: BROWSER_TEACH_INSTALLED_CLEANUP,
  };
}

function promotedBrowserDeveloperEvidenceUiAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!BROWSER_DEVELOPER_EVIDENCE_UI_SURFACE_IDS.has(surface.id)) {
    throw new Error(`missing Browser Developer/Evidence control config for ${surface.id}`);
  }
  const control = surface.name.includes("teach-workflow")
    ? {
        expectedEffect: "A native installed-app click records one complete owned Flight Recorder attempt and enters Browser Teach with one reversible draft identity; neither approval nor recipe replay is invoked.",
        oracleId: "ui:activation:browser-evidence-teach-owned-draft",
      }
    : surface.name.includes("developer-inspect")
      ? {
          expectedEffect: "A native installed-app click exposes the pending Browser Developer inspection state and then its exact Developer Mode denial for the owned loopback site without granting CDP access.",
          oracleId: "ui:activation:browser-developer-inspection-denied",
        }
      : surface.name.includes("approve-current-site")
        ? {
            expectedEffect: "A native installed-app click approves Developer Mode only for the exact owned loopback host and exposes bounded partial inspection state.",
            oracleId: "ui:activation:browser-developer-site-approved",
          }
        : surface.name.includes("disable-mode")
          ? {
              expectedEffect: "A native installed-app click disables Browser Developer Mode, clears the exact owned site approval, and removes private inspection receipt state.",
              oracleId: "ui:activation:browser-developer-mode-disabled",
            }
          : {
              expectedEffect: "A native installed-app click exports one private sanitized Browser Developer artifact and proves only its compact receipt identity, byte count, and SHA-256 without exposing a filesystem path.",
              oracleId: "ui:activation:browser-developer-artifact-receipt",
            };
  return {
    surfaceId: surface.id,
    driverId: BROWSER_DEVELOPER_EVIDENCE_UI_DRIVER_ID,
    fixtureId: "ui:browser-developer-evidence-owned-task",
    ...control,
    cleanupId: "ui:clear-browser-developer-site-approval-close-owned-task-and-window",
  };
}

function promotedNativePickerAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!NATIVE_PICKER_SURFACE_IDS.has(surface.id)) {
    throw new Error(`missing promoted native picker config for ${surface.id}`);
  }
  if (surface.id === APP_FOLDER_SURFACE_ID) {
    return {
      surfaceId: surface.id,
      driverId: UI_NATIVE_PICKER_DRIVER_ID,
      fixtureId: "native-picker:owned-directory-local-tab",
      expectedEffect: "The macOS candidate-bound native dialog or Windows/Linux isolated one-shot directory result traverses the production handler, selects the exact receipt-owned directory, and changes only the active isolated tab cwd.",
      oracleId: "ui:activation:native-picker-exact-owned-directory-selected",
      cleanupId: "native-picker:restore-exact-tab-delete-fixture",
    };
  }
  if (surface.id === SETTINGS_NATIVE_PICKER_SURFACE_ID) {
    return {
      surfaceId: surface.id,
      driverId: UI_NATIVE_PICKER_DRIVER_ID,
      fixtureId: "native-picker:owned-settings-download-directory",
      expectedEffect: "The macOS candidate-bound native dialog or Windows/Linux isolated one-shot directory result traverses the production Settings handler and proves the exact receipt-owned download directory plus its public backing state.",
      oracleId: "ui:activation:native-picker-exact-settings-directory-selected",
      cleanupId: "native-picker:restore-exact-settings-delete-fixture",
    };
  }
  if (surface.id === BROWSER_NATIVE_PICKER_SURFACE_ID) {
    return {
      surfaceId: surface.id,
      driverId: UI_NATIVE_PICKER_DRIVER_ID,
      fixtureId: "native-picker:owned-browser-download-directory",
      expectedEffect: "The macOS candidate-bound Browser dialog or Windows/Linux isolated one-shot directory result traverses the production Browser handler and proves the exact receipt-owned download directory plus its public backing state.",
      oracleId: "ui:activation:native-picker-exact-browser-directory-selected",
      cleanupId: "native-picker:restore-exact-browser-settings-task-window-delete-fixture",
    };
  }
  if (surface.id === VAULT_KEYFILE_SELECT_NATIVE_PICKER_SURFACE_ID) {
    return {
      surfaceId: surface.id,
      driverId: UI_NATIVE_PICKER_DRIVER_ID,
      fixtureId: "native-picker:owned-vault-keyfile-setup",
      expectedEffect: "The macOS candidate-bound native dialog or Windows/Linux isolated one-shot file result traverses the production Vault handler and exposes only one bounded reversible synthetic keyfile draft.",
      oracleId: "ui:activation:native-picker-exact-owned-vault-keyfile-selected",
      cleanupId: "native-picker:clear-owned-vault-keyfile-close-settings-delete-fixture",
    };
  }
  if (surface.id === VAULT_KEYFILE_CLEAR_NATIVE_PICKER_SURFACE_ID) {
    return {
      surfaceId: surface.id,
      driverId: UI_NATIVE_PICKER_DRIVER_ID,
      fixtureId: "native-picker:owned-vault-keyfile-setup",
      expectedEffect: "A native Clear click removes the exact synthetic Vault keyfile draft without invoking setup, unlocking Vault, or retaining keyfile material.",
      oracleId: "ui:activation:native-picker-owned-vault-keyfile-cleared",
      cleanupId: "native-picker:clear-owned-vault-keyfile-close-settings-delete-fixture",
    };
  }
  return {
    surfaceId: surface.id,
    driverId: surface.kind === "keyboard-shortcut"
      ? KEYBOARD_NATIVE_PICKER_DRIVER_ID
      : surface.kind === "palette-action"
        ? PALETTE_NATIVE_PICKER_DRIVER_ID
        : UI_NATIVE_PICKER_DRIVER_ID,
    fixtureId: "native-picker:owned-file-empty-composer",
    expectedEffect: "The macOS candidate-bound native dialog or Windows/Linux isolated one-shot file result traverses the production attachment handler and renders the exact receipt-owned removable pending attachment.",
    oracleId: surface.kind === "ui-control"
      ? "ui:activation:native-picker-exact-owned-file-attached"
      : "native-picker:exact-owned-file-attached",
    cleanupId: "native-picker:remove-exact-attachment-restore-tab-delete-fixture",
  };
}

function promotedPaletteActionAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (surface.name === "act-preview-doctor") {
    return {
      surfaceId: surface.id,
      driverId: PALETTE_PROVIDER_ACTION_DRIVER_ID,
      fixtureId: "ui:provider-action-owned-work-preview-palette-ask-fix",
      expectedEffect: "The native palette action diagnoses one exact owned Work Preview and dispatches its generated repair prompt only to a release-owned disposable ShellX provider child, with matching process receipt and exact project cleanup.",
      oracleId: "ui:activation:provider-action-prompt-dispatched",
      cleanupId: "ui:stop-owned-provider-action-delete-project-and-restore-view",
    };
  }
  if (surface.name === "act-connect" || surface.name === "act-abort") {
    const connect = surface.name === "act-connect";
    return {
      surfaceId: surface.id,
      driverId: "palette-action-installed",
      fixtureId: "palette:isolated-local-grok-session",
      expectedEffect: connect
        ? "The native palette Connect action starts and initializes one real local Grok ACP child for the exact isolated tab without sending a provider prompt, then cleanup hard-aborts it and restores the exact tab baseline."
        : "The native palette Abort action terminates one prepared real local Grok ACP child, removes its registry slot, and returns the exact isolated tab to Idle before exact baseline restoration.",
      oracleId: connect
        ? "palette:act-connect:owned-grok-session-active"
        : "palette:act-abort:owned-grok-session-aborted",
      cleanupId: "palette:abort-owned-grok-session-and-restore-tab",
    };
  }
  if (surface.name !== "act-attach-screenshot") {
    throw new Error(`missing promoted palette action config for ${surface.id}`);
  }
  return {
    surfaceId: surface.id,
    driverId: "palette-action-installed",
    fixtureId: "palette:isolated-run-profile-with-empty-composer",
    expectedEffect: "The screenshot palette action captures the installed ShellX window into one owned PNG and attaches that exact file as a removable composer image chip.",
    oracleId: "palette:act-attach-screenshot:owned-screenshot-attached",
    cleanupId: "palette:remove-chip-and-delete-exact-owned-screenshot",
  };
}

function promotedKeyboardShortcutAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "keyboard-shortcut-installed",
    fixtureId: "keyboard:owned-renderer-diff",
    expectedEffect: `Native keyboard shortcut ${surface.name} changes the exact focused hunk in an owned disposable diff session.`,
    oracleId: `keyboard:${surface.name}:diff-hunk-effect`,
    cleanupId: "keyboard:clear-owned-renderer-diff-and-restore-tabs",
  };
}

function promotedShellxCommandAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (surface.name === "/build" || surface.name === "/goal") {
    return {
      surfaceId: surface.id,
      driverId: "shellx-command-installed",
      fixtureId: "shellx-command:composer-empty",
      expectedEffect: `Native composer submission of bare ${surface.name} produces exactly one objective-required validation result without starting a run.`,
      oracleId: `shellx-command:${surface.name.slice(1)}:objective-required`,
      cleanupId: "shellx-command:close-modal-and-clear-composer",
    };
  }
  const effect = surface.name === "/stop" ? "clears" : surface.name === "/pause" ? "pauses" : "resumes";
  return {
    surfaceId: surface.id,
    driverId: "shellx-command-installed",
    fixtureId: "shellx-command:owned-legacy-goal",
    expectedEffect: `Native composer submission of ${surface.name} ${effect} one exact owned disposable goal slot.`,
    oracleId: `shellx-command:${surface.name.slice(1)}:goal-${surface.name === "/stop" ? "cleared" : `${surface.name.slice(1)}d`}`,
    cleanupId: "shellx-command:clear-owned-goal-and-delete-cwd",
  };
}

function promotedUiDialogAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const leftRailConfig = leftRailLifecycleUiControls.get(surface.id);
  const goalPlanReviewConfig = goalPlanReviewLifecycleUiControls.get(surface.id);
  const config = leftRailConfig ? {
    fixtureId: "ui:left-rail-owned-lifecycle",
    expectedEffect: leftRailConfig.expectedEffect,
    oracleId: leftRailConfig.oracleId,
    cleanupId: LEFT_RAIL_LIFECYCLE_CLEANUP,
  } : goalPlanReviewConfig ?? promotedUiControls.get(surface.name);
  if (!config) throw new Error(`missing promoted UI dialog config for ${surface.id}`);
  return {
    surfaceId: surface.id,
    driverId: leftRailConfig
      ? LEFT_RAIL_LIFECYCLE_UI_DRIVER_ID
      : permissionDecisionUiControls.has(surface.name)
      ? PERMISSION_DECISION_UI_DRIVER_ID
      : surface.name === BRANCH_PICKER_LIFECYCLE_UI_SURFACE_NAME
      ? BRANCH_PICKER_LIFECYCLE_UI_DRIVER_ID
      : WINDOWS_DESKTOP_INTEGRATION_UI_SURFACE_NAMES.has(surface.name)
      ? WINDOWS_DESKTOP_INTEGRATION_UI_DRIVER_ID
      : providerActionUiControls.has(surface.name)
      ? PROVIDER_ACTION_UI_DRIVER_ID
      : connectorsProductionUiControls.has(surface.name)
      ? CONNECTORS_PRODUCTION_UI_DRIVER_ID
      : CONNECTION_LIFECYCLE_UI_SURFACE_NAMES.has(surface.name)
      ? CONNECTION_LIFECYCLE_UI_DRIVER_ID
      : promotedModalBackdropControls.has(surface.name)
      ? MODAL_BACKDROP_UI_DRIVER_ID
      : surface.name.startsWith(BROWSER_SHIELDS_UI_SURFACE_PREFIX)
        ? BROWSER_SHIELDS_UI_DRIVER_ID
        : BOTTOM_PANEL_LIFECYCLE_UI_SURFACE_NAMES.has(surface.name)
          ? BOTTOM_PANEL_LIFECYCLE_UI_DRIVER_ID
        : surface.name.startsWith(BOTTOM_TABS_UI_SURFACE_PREFIX)
          ? BOTTOM_TABS_UI_DRIVER_ID
          : surface.name.startsWith(SETTINGS_TABS_UI_SURFACE_PREFIX)
            || surface.name.startsWith(RIGHT_RAIL_TABS_UI_SURFACE_PREFIX)
            ? NAVIGATION_TABS_UI_DRIVER_ID
            : surface.name.startsWith(SESSION_TABS_LIFECYCLE_UI_SURFACE_PREFIX)
              ? SESSION_TABS_LIFECYCLE_UI_DRIVER_ID
            : TASKS_PANEL_LIFECYCLE_UI_SURFACE_NAMES.has(surface.name)
              ? TASKS_PANEL_LIFECYCLE_UI_DRIVER_ID
            : CHAT_OUTPUT_LIFECYCLE_UI_SURFACE_NAMES.has(surface.name)
              ? CHAT_OUTPUT_LIFECYCLE_UI_DRIVER_ID
            : RIGHT_RAIL_GIT_READ_UI_SURFACE_NAMES.has(surface.name)
              ? RIGHT_RAIL_GIT_READ_UI_DRIVER_ID
            : RIGHT_RAIL_GIT_WRITE_UI_SURFACE_NAMES.has(surface.name)
              ? RIGHT_RAIL_GIT_WRITE_UI_DRIVER_ID
            : LOCAL_DISCLOSURES_UI_SURFACE_NAMES.has(surface.name)
              ? LOCAL_DISCLOSURES_UI_DRIVER_ID
              : UI_CONTROL_BOUNDED_INSTALLED_SURFACE_NAMES.has(surface.name)
                ? UI_CONTROL_BOUNDED_INSTALLED_DRIVER_ID
                : "ui-control-installed",
    ...config,
  };
}

function promotedAgentCliSetupLifecycleAssignment(
  surface: ReleaseSurfaceItem,
): FinalSurfaceDriverAssignment {
  const config = agentCliSetupLifecycleUiControls.get(surface.id);
  if (!config) throw new Error(`missing promoted Agent CLI setup config for ${surface.id}`);
  return {
    surfaceId: surface.id,
    driverId: AGENT_CLI_SETUP_LIFECYCLE_UI_DRIVER_ID,
    ...config,
  };
}

function promotedVaultOwnedEditAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const config = promotedVaultOwnedEditControls.get(surface.id);
  if (!config) throw new Error(`missing promoted owned Vault edit config for ${surface.id}`);
  return {
    surfaceId: surface.id,
    driverId: VAULT_OWNED_EDIT_UI_DRIVER_ID,
    ...config,
  };
}

function promotedVaultRowRevealDebugAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (surface.id !== VAULT_ROW_REVEAL_DEBUG_SURFACE_ID) {
    throw new Error(`missing promoted owned Vault reveal marker config for ${surface.id}`);
  }
  return {
    surfaceId: surface.id,
    driverId: VAULT_ROW_REVEAL_DEBUG_DRIVER_ID,
    fixtureId: "ui:vault-owned-secret-reveal-marker",
    expectedEffect: "A native installed-app click reveals one fixed synthetic owned secret long enough to resolve only the sensitive container marker, then hides it without reading, highlighting, hashing, or reporting the input value.",
    oracleId: "ui:visible:vault-owned-sensitive-row-without-value-observation",
    cleanupId: "ui:hide-owned-vault-secret-delete-exact-owned-key-and-restore-settings",
  };
}

function promotedActivityBrowserLifecycleAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const config = promotedActivityBrowserLifecycleControls.get(surface.id);
  if (!config) throw new Error(`missing promoted Activity Browser lifecycle config for ${surface.id}`);
  return {
    surfaceId: surface.id,
    driverId: ACTIVITY_BROWSER_LIFECYCLE_UI_DRIVER_ID,
    ...config,
  };
}

function promotedClipboardLifecycleAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!CLIPBOARD_LIFECYCLE_UI_SURFACE_IDS.has(surface.id)) {
    throw new Error(`missing clipboard lifecycle config for ${surface.id}`);
  }
  return {
    surfaceId: surface.id,
    driverId: CLIPBOARD_LIFECYCLE_UI_DRIVER_ID,
    fixtureId: "ui:owned-native-clipboard-empty-lifecycle",
    expectedEffect: "Native installed input invokes the exact owned copy control only after a metadata-only empty preflight; the host verifies the synthetic value by SHA-256 plus UTF-8 length, clears only that same value, and proves the clipboard empty without reporting contents.",
    oracleId: "ui:activation:native-clipboard-owned-value-verified-and-cleared",
    cleanupId: "ui:clear-owned-clipboard-prove-empty-and-restore-surface",
  };
}

function activityBrowserLifecycleConfig(
  selector: string,
  occurrence: number,
  expectedEffect: string,
  oracleId: string,
): readonly [string, {
  fixtureId: string;
  expectedEffect: string;
  oracleId: string;
  cleanupId: string;
}] {
  return [
    `ui-control:src/components/ActivityBrowserModal.tsx:${selector}@src/components/ActivityBrowserModal.tsx#${occurrence}`,
    {
      fixtureId: "ui:activity-browser-owned-session-file",
      expectedEffect,
      oracleId,
      cleanupId: "ui:close-owned-activity-preview-and-tab-delete-exact-fixture-restore-baseline",
    },
  ];
}

function vaultOwnedEditConfig(
  selector: string,
  occurrence: number,
  fixtureId: string,
  expectedEffect: string,
  oracleId: string,
  cleanupId = "ui:delete-exact-owned-vault-key-restore-redacted-directory-and-settings",
): readonly [string, {
  fixtureId: string;
  expectedEffect: string;
  oracleId: string;
  cleanupId: string;
}] {
  return [
    `ui-control:src/components/settings/VaultTab.tsx:${selector}@src/components/settings/VaultTab.tsx#${occurrence}`,
    {
      fixtureId,
      expectedEffect,
      oracleId,
      cleanupId,
    },
  ];
}

function vaultOwnedExternalConfig(
  source: string,
  selector: string,
  occurrence: number,
  fixtureId: string,
  expectedEffect: string,
  oracleId: string,
): readonly [string, {
  fixtureId: string;
  expectedEffect: string;
  oracleId: string;
  cleanupId: string;
}] {
  return [
    `ui-control:${source}:${selector}@${source}#${occurrence}`,
    { fixtureId, expectedEffect, oracleId, cleanupId: NEW_VAULT_RESOURCE_CLEANUP },
  ];
}

function promotedDebugApiReadAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const path = surface.name.slice("GET ".length);
  const screenshot = path === "/screenshot";
  const vaultE2e = path === "/vault/e2e/audit";
  const sessionFixture = path.startsWith("/sessions/");
  const filesFixture = path === "/state/files";
  const browserSettleFixture = path === "/browser/settle";
  const gitFixture = path === "/state/github" || path === "/state/github/items"
    || path === "/state/session_git" || path === "/state/session_git/diff";
  const absentSessionFixture = path === "/state/session_activity"
    || path === "/state/environment"
    || path === "/state/grok_environment"
    || path === "/preview/work/diagnose";
  if (path === "/browser/teach/drafts") {
    return {
      surfaceId: surface.id,
      driverId: "debug-api-route-installed",
      fixtureId: "debug-api:isolated-browser-teach-agent-task",
      expectedEffect: "GET /browser/teach/drafts reads exactly one draft prepared from owned evidence for the matching MCP task owner; it neither approves nor applies a recipe.",
      oracleId: "debug-api:GET-browser-teach-drafts:owned-agent-readback",
      cleanupId: "debug-api:close-owned-browser-teach-task-and-candidate-teardown",
    };
  }
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: screenshot
      ? "debug-api:installed-window-capture"
      : vaultE2e
        ? "debug-api:isolated-vault-e2e-read"
        : sessionFixture
          ? "debug-api:isolated-session-history"
        : filesFixture
          ? "debug-api:isolated-files-directory"
        : browserSettleFixture
          ? "debug-api:isolated-browser-task"
        : gitFixture
          ? "debug-api:isolated-git-repository"
        : absentSessionFixture
          ? "debug-api:isolated-absent-session"
        : path.startsWith("/agent-doc/")
          ? "debug-api:installed-app-identity"
          : "debug-api:installed-read-model",
    expectedEffect: `${surface.name} returns its exact bounded read-only contract without retaining returned Browser data in release evidence.`,
    oracleId: `debug-api:GET-${path.slice(1).replaceAll("/", "-").replaceAll(".", "-")}`,
    cleanupId: screenshot
      ? "debug-api:restore-window-state"
      : vaultE2e
        ? "debug-api:delete-isolated-run-profile"
        : sessionFixture
          ? "debug-api:delete-owned-session-fixture"
        : filesFixture
          ? "debug-api:delete-owned-files-fixture"
        : browserSettleFixture
          ? "debug-api:close-owned-browser-task-and-server"
        : gitFixture
          ? "debug-api:delete-owned-git-fixture"
        : "debug-api:read-only",
  };
}

function promotedDebugApiBrowserTeachDeveloperMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiBrowserTeachDeveloperMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Browser Teach/Developer config for ${surface.id}`);
  }
  if (surface.name === "POST /browser/developer/inspect") {
    return {
      surfaceId: surface.id,
      driverId: "debug-api-route-installed",
      fixtureId: "debug-api:isolated-browser-teach-agent-task",
      expectedEffect: "POST /browser/developer/inspect proves the fixed task-owned inspection remains Developer-Mode-gated and returns its expected structured denial without enabling Developer Mode or executing arbitrary CDP.",
      oracleId: "debug-api:POST-browser-developer-inspect:developer-mode-denial",
      cleanupId: "debug-api:close-owned-browser-teach-task-and-candidate-teardown",
    };
  }
  if (surface.name === "POST /browser/teach/prepare") {
    return {
      surfaceId: surface.id,
      driverId: "debug-api-route-installed",
      fixtureId: "debug-api:isolated-browser-teach-agent-task",
      expectedEffect: "POST /browser/teach/prepare derives one immutable draft and current revision from exact owned Flight Recorder evidence for the matching MCP task owner; approval remains unavailable on Debug API.",
      oracleId: "debug-api:POST-browser-teach-prepare:owned-agent-draft",
      cleanupId: "debug-api:close-owned-browser-teach-task-and-candidate-teardown",
    };
  }
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-browser-teach-agent-task",
    expectedEffect: "POST /browser/teach/revise creates one compare-and-swap revision for the exact owned agent draft and confirms it through owner-scoped draft readback; it cannot approve or apply a recipe.",
    oracleId: "debug-api:POST-browser-teach-revise:owned-agent-revision",
    cleanupId: "debug-api:close-owned-browser-teach-task-and-candidate-teardown",
  };
}

function promotedDebugApiMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const create = surface.name === "POST /browser/bookmarks";
  const reorder = surface.name === "POST /browser/bookmarks/reorder";
  if (!create && !reorder && surface.name !== "DELETE /browser/bookmarks/:bookmark_id") {
    throw new Error(`missing promoted Debug API mutation config for ${surface.id}`);
  }
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-browser-bookmark",
    expectedEffect: create
      ? "POST /browser/bookmarks creates exactly one owned bookmark in the isolated release profile."
      : reorder
        ? "POST /browser/bookmarks/reorder moves exactly one owned link into its owned folder in the isolated release profile."
      : "DELETE /browser/bookmarks/:bookmark_id removes exactly its prepared owned bookmark from the isolated release profile.",
    oracleId: create
      ? "debug-api:POST-browser-bookmarks:semantic-effect"
      : reorder
        ? "debug-api:post-browser-bookmarks-reorder:semantic-effect"
      : "debug-api:delete-browser-bookmarks-bookmark-id:semantic-effect",
    cleanupId: "debug-api:delete-owned-browser-bookmark",
  };
}

function promotedDebugApiGitMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiGitMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Git mutation config for ${surface.id}`);
  }
  const checkpoint = surface.name.endsWith("/checkpoint");
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-git-repository-mutation",
    expectedEffect: checkpoint
      ? "POST /state/session_git/checkpoint materializes one exact local checkpoint for an owned dirty repository and removes its receipt-owned checkpoint directory during cleanup."
      : "POST /state/session_git/worktree creates one exact local branch and worktree under an owned repository that is removed during cleanup; no remote is configured or contacted.",
    oracleId: checkpoint
      ? "debug-api:POST-state-session_git-checkpoint:semantic-effect"
      : "debug-api:POST-state-session_git-worktree:semantic-effect",
    cleanupId: "debug-api:delete-owned-git-fixture-and-checkpoint",
  };
}

function promotedDebugApiBrowserVaultDepositMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiBrowserVaultDepositMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Browser Vault deposit config for ${surface.id}`);
  }
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-browser-vault-deposit",
    expectedEffect: "POST /browser/vault-deposits writes one synthetic secret into the isolated Vault, returns only write-only receipts, deletes the exact Vault entry, closes its owned task, and defers monotonic Browser receipt cleanup to proven candidate-profile teardown.",
    oracleId: "debug-api:POST-browser-vault-deposits:semantic-effect",
    cleanupId: "debug-api:delete-owned-vault-deposit-close-task-and-candidate-teardown",
  };
}

function promotedDebugApiBrowserWindowMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiBrowserWindowMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Browser window config for ${surface.id}`);
  }
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:installed-browser-window",
    expectedEffect: "POST /browser/open opens or focuses the installed ShellX Browser native window with about:blank, verifies its exact receipt and foreground registry state, and defers the visible window plus monotonic receipt to candidate teardown.",
    oracleId: "debug-api:POST-browser-open:semantic-effect",
    cleanupId: "debug-api:close-browser-window-with-candidate-teardown",
  };
}

function promotedDebugApiGoalLifecycleMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiGoalLifecycleMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Goal lifecycle config for ${surface.id}`);
  }
  const action = surface.name.slice("POST /goal/".length);
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-goal-lifecycle",
    expectedEffect: `${surface.name} performs its exact owned Goal ${action} transition, verifies the state and disposable scratchboard, then clears the Goal and deletes the fixture.`,
    oracleId: `debug-api:POST-goal-${action}:semantic-effect`,
    cleanupId: "debug-api:stop-owned-goal-and-delete-scratchboard",
  };
}

function promotedDebugApiVaultOpenPanelMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiVaultOpenPanelMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Vault panel config for ${surface.id}`);
  }
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:installed-vault-panel",
    expectedEffect: "POST /vault/open-panel focuses the installed main window, waits for the renderer-mounted Vault acknowledgement, verifies a non-empty visible panel rectangle, then closes the panel and clears its highlight.",
    oracleId: "debug-api:POST-vault-open-panel:semantic-effect",
    cleanupId: "debug-api:close-vault-panel-and-clear-highlight",
  };
}

function promotedDebugApiProviderLifecycleMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiProviderLifecycleMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API provider lifecycle config for ${surface.id}`);
  }
  const route = surface.name.slice("POST /".length).replaceAll("/", "-");
  const effect = surface.name === "POST /connect"
    ? "launches one exact local Grok ACP child in an owned project and proves its live registry row before tab-scoped abort cleanup"
    : surface.name === "POST /provider-adapters/run"
      ? "rejects an empty cwd before resolving or launching a provider and proves its matching bounded start/failure events"
      : "runs the release-owned installed JSONL child fixture to completion and proves its parsed receipt plus matching registry events without contacting an external provider";
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-local-provider-lifecycle",
    expectedEffect: `${surface.name} ${effect}; the final provider-route batch separately proves every provider and transport stream on the same frozen candidate.`,
    oracleId: `debug-api:POST-${route}:semantic-effect`,
    cleanupId: surface.name === "POST /provider-adapters/run"
      ? "debug-api:no-provider-process-created"
      : "debug-api:stop-owned-provider-and-delete-project",
  };
}

function promotedDebugApiBrowserLifecycleMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiBrowserLifecycleMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Browser lifecycle config for ${surface.id}`);
  }
  const path = surface.name.slice("POST ".length);
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-browser-task",
    expectedEffect: surface.name === "POST /browser/cdp/execute"
      ? "POST /browser/cdp/execute proves the exact browserDeveloperModeApproval denial and request receipt for an owned loopback task without evaluating the requested expression."
      : `${surface.name} performs its exact owned task/tab transition against a loopback-only page.`,
    oracleId: `debug-api:POST-${path.slice(1).replaceAll("/", "-")}:semantic-effect`,
    cleanupId: "debug-api:close-owned-browser-task-and-server",
  };
}

function promotedDebugApiBrowserEvidenceArtifactMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiBrowserEvidenceArtifactMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Browser evidence artifact config for ${surface.id}`);
  }
  const evaluation = surface.name === "POST /browser/evaluations";
  const flightRecorder = surface.name === "POST /browser/flight-recorder/export";
  const performance = surface.name === "POST /browser/performance/export";
  const recipeReplay = surface.name === "POST /browser/recipes/replay";
  const oraclePath = surface.name.slice("POST /browser/".length).replaceAll("/", "-");
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-browser-evidence-artifacts",
    expectedEffect: evaluation
      ? "POST /browser/evaluations binds two exact-task, SHA-256-verified Flight Recorder attempts into one evidence-complete bounded report before deleting all owned artifacts."
      : flightRecorder
        ? "POST /browser/flight-recorder/export writes one exact-task, complete, bounded artifact whose bytes and SHA-256 are verified before exact deletion."
        : performance
          ? "POST /browser/performance/export captures real mounted-engine metrics for the exact owned page, verifies bounded artifact bytes, SHA-256, counters, URL sanitation, and redaction policy, then deletes the artifact."
        : recipeReplay
          ? "POST /browser/recipes/replay dry-runs one SHA-256-verified exact-task recipe, proves one ordered result per planned or skipped step with zero applied actions, then deletes the fixture artifact."
        : `${surface.name} writes one bounded exact-task/profile artifact whose bytes, SHA-256, redaction identity, and receipt are verified before exact deletion.`,
    oracleId: evaluation
      ? "debug-api:post-browser-evaluations:semantic-effect"
      : `debug-api:post-browser-${oraclePath}:semantic-effect`,
    cleanupId: "debug-api:delete-owned-browser-artifacts-and-close-task",
  };
}

function promotedDebugApiBrowserMonotonicMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiBrowserMonotonicMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Browser monotonic config for ${surface.id}`);
  }
  const operation = surface.name === "POST /browser/logs"
    ? "log entry and matching receipt"
    : surface.name === "POST /browser/popups"
      ? "approval-gated popup event and matching sanitized receipt"
      : "report receipt";
  const oraclePath = surface.name.slice("POST /browser/".length);
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-browser-monotonic-state",
    expectedEffect: `${surface.name} appends and reads back exactly one bounded owned-task ${operation}; the monotonic row ends with disposable candidate teardown.`,
    oracleId: `debug-api:post-browser-${oraclePath}:semantic-effect`,
    cleanupId: "debug-api:close-owned-browser-task-and-candidate-teardown",
  };
}

function promotedDebugApiBrowserTransferIntentMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiBrowserTransferIntentMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Browser transfer intent config for ${surface.id}`);
  }
  const direction = surface.name.includes("downloads") ? "download" : "upload";
  const completion = surface.name.endsWith("/complete");
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-browser-transfer-intent",
    expectedEffect: completion
      ? `${surface.name} rejects completion of one exact owned requested ${direction} without a host-granted approval, preserves the pending row, and emits no false completion receipt; identities end with disposable candidate teardown.`
      : `${surface.name} records and reads back exactly one owned requested ${direction} intent plus its receipt without performing a transfer; monotonic state ends with disposable candidate teardown.`,
    oracleId: `debug-api:post-browser-${direction}s-${completion ? "complete" : "request"}:semantic-effect`,
    cleanupId: "debug-api:delete-owned-transfer-file-close-task-and-candidate-teardown",
  };
}

function promotedDebugApiBrowserRobotMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiBrowserRobotMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Browser robot config for ${surface.id}`);
  }
  const action = surface.name.slice("POST /browser/robots/".length);
  const expected = action === "run"
    ? "dry-runs one exact SHA-256-verified recipe with zero applied actions and reads back the matching terminal job and receipt"
    : `records and reads back one exact owned ${action === "schedule" ? "scheduled" : "cancelled"} recipe job plus its matching receipt`;
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-browser-robot-recipe",
    expectedEffect: `${surface.name} ${expected}; the exact recipe and active task are removed while terminal robot rows end with disposable candidate teardown.`,
    oracleId: `debug-api:post-browser-robots-${action}:semantic-effect`,
    cleanupId: "debug-api:delete-owned-browser-robot-recipe-close-task-and-candidate-teardown",
  };
}

function promotedDebugApiBrowserPendingRequestMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiBrowserPendingRequestMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Browser pending-request config for ${surface.id}`);
  }
  const grantApplication = surface.name === "POST /browser/session-grants/apply";
  const subject = surface.name === "POST /browser/dialogs"
    ? "dialog"
    : surface.name === "POST /browser/permissions" ? "permission request" : "session grant request";
  const oraclePath = surface.name.slice("POST /browser/".length).replaceAll("/", "-");
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-browser-pending-request",
    expectedEffect: grantApplication
      ? "POST /browser/session-grants/apply rejects one exact owned requested grant, preserves its pending row, then task completion proves the same row and cancellation receipt are terminal; identities end with disposable candidate teardown."
      : `${surface.name} creates and reads back one exact owned pending ${subject} plus its receipt, then completes the task and proves the same row and cancellation receipt are terminal; identities end with disposable candidate teardown.`,
    oracleId: `debug-api:post-browser-${oraclePath}:semantic-effect`,
    cleanupId: "debug-api:complete-owned-browser-task-and-candidate-teardown",
  };
}

function promotedDebugApiBrowserRenderedCheckMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiBrowserRenderedCheckMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Browser rendered-check config for ${surface.id}`);
  }
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-browser-hidden-renderer",
    expectedEffect: "POST /browser/rendered-check matches exact text, title, and selector in an isolated loopback hidden renderer, proves renderer destruction, and preserves visible Browser summary state.",
    oracleId: "debug-api:post-browser-rendered-check:semantic-effect",
    cleanupId: "debug-api:destroy-owned-browser-hidden-renderer",
  };
}

function promotedDebugApiPreviewLifecycleMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiPreviewLifecycleMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Work Preview lifecycle config for ${surface.id}`);
  }
  const path = surface.name.slice("POST ".length);
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-work-preview-lifecycle",
    expectedEffect: `${surface.name} proves its exact ShellX-owned static Preview lifecycle transition against a disposable project and loopback endpoint.`,
    oracleId: `debug-api:POST-${path.slice(1).replaceAll("/", "-")}:semantic-effect`,
    cleanupId: "debug-api:stop-owned-preview-and-delete-project",
  };
}

function promotedDebugApiOperatorGateAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const separator = surface.name.indexOf(" ");
  if (separator <= 0) throw new Error(`invalid promoted Debug API operator gate ${surface.id}`);
  const method = surface.name.slice(0, separator);
  const path = surface.name.slice(separator + 1);
  const oraclePath = path
    .slice(1)
    .replaceAll("/", "-")
    .replace(":host", "host");
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:operator-gated-read-only",
    expectedEffect: `${surface.name} returns its exact operator-only denial and preserves the corresponding Browser state.`,
    oracleId: `debug-api:${method}-${oraclePath}:operator-denied`,
    cleanupId: "debug-api:read-only",
  };
}

function promotedDebugApiVaultE2eMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const path = surface.name.slice("POST ".length);
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "route-driver:isolated-vault-e2e-mutation",
    expectedEffect: `${surface.name} performs its exact redacted lifecycle transition only inside the guarded disposable Vault E2E profile.`,
    oracleId: `debug-api:POST-${path.slice(1).replaceAll("/", "-")}:semantic-effect`,
    cleanupId: "debug-api:reset-isolated-vault-e2e",
  };
}

function promotedDebugApiVaultGrantMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const revoke = surface.name === "POST /vault/grants/:grant_id/revoke";
  if (!revoke && surface.name !== "POST /vault/grants") {
    throw new Error(`missing promoted Debug API Vault grant config for ${surface.id}`);
  }
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "route-driver:isolated-vault-e2e-mutation",
    expectedEffect: revoke
      ? "POST /vault/grants/:grant_id/revoke revokes exactly its owned pending grant inside the guarded disposable Vault E2E profile."
      : "POST /vault/grants creates exactly one owned pending grant inside the guarded disposable Vault E2E profile.",
    oracleId: revoke
      ? "debug-api:POST-vault-grants-grant-id-revoke:semantic-effect"
      : "debug-api:POST-vault-grants:semantic-effect",
    cleanupId: "debug-api:reset-isolated-vault-e2e",
  };
}

function promotedDebugApiBoundedPostReadAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:installed-bounded-post-read",
    expectedEffect: "POST /diagnostics runs only the bounded auth check and proves the installed bearer-token file without returning token material.",
    oracleId: "debug-api:POST-diagnostics-auth",
    cleanupId: "debug-api:read-only",
  };
}

function promotedDebugApiClipboardLifecycleAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:guarded-native-clipboard-preflight",
    expectedEffect: "POST /release-test/clipboard either acquires and releases one exact empty-clipboard lease or safely refuses nonempty native metadata, without reading or changing clipboard payload bytes.",
    oracleId: "debug-api:POST-release-test-clipboard:guarded-preflight-lifecycle",
    cleanupId: "debug-api:release-empty-or-preserve-nonempty-clipboard",
  };
}

function promotedDebugApiNativePickerLifecycleAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiNativePickerLifecycles.has(surface.name)) {
    throw new Error(`missing promoted Debug API native-picker config for ${surface.id}`);
  }
  const method = surface.name.slice(0, surface.name.indexOf(" "));
  const effect = method === "POST"
    ? "arms one exact receipt-owned file result without returning path text"
    : method === "GET"
      ? "reports only the armed kind and path SHA-256 for one exact receipt-owned file result"
      : "clears one exact unused receipt-owned file result";
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-native-picker-lease",
    expectedEffect: `${surface.name} ${effect} inside the isolated candidate profile.`,
    oracleId: `debug-api:${method}-release-test-native-picker:lease-lifecycle`,
    cleanupId: "debug-api:clear-isolated-native-picker-lease-delete-fixture",
  };
}

function promotedDebugApiRemoteApprovalGateAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:remote-approval-gated-read-only",
    expectedEffect: "POST /github/pr/create without confirmRemoteCreate returns the exact per-operation approval requirement before resolving a session, invoking gh, or contacting GitHub.",
    oracleId: "debug-api:POST-github-pr-create:approval-required",
    cleanupId: "debug-api:read-only",
  };
}

function promotedDebugApiRawRevealDenialAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:operator-gated-read-only",
    expectedEffect: "POST /vault/get returns its exact raw-secret denial without exposing a value and preserves Vault key metadata.",
    oracleId: "debug-api:POST-vault-get:raw-reveal-denied",
    cleanupId: "debug-api:read-only",
  };
}

function promotedDebugApiSafeRefusalAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const path = surface.name.slice("POST ".length);
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-safe-refusal",
    expectedEffect: `${surface.name} returns its exact bounded read, missing-id result, or pre-effect refusal without contacting a provider, process, secret backend, remote, or external service.`,
    oracleId: `debug-api:POST-${path.slice(1).replaceAll("/", "-").replaceAll(":", "")}:safe-refusal`,
    cleanupId: "debug-api:read-only",
  };
}

function promotedDebugApiVaultMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const create = surface.name === "POST /vault/set";
  if (!create && surface.name !== "POST /vault/delete") {
    throw new Error(`missing promoted Debug API Vault mutation config for ${surface.id}`);
  }
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-vault-secret",
    expectedEffect: create
      ? "POST /vault/set creates exactly one owned secret in the isolated release Vault without exposing its value."
      : "POST /vault/delete removes exactly its prepared owned secret from the isolated release Vault.",
    oracleId: create
      ? "debug-api:POST-vault-set:semantic-effect"
      : "debug-api:POST-vault-delete:semantic-effect",
    cleanupId: "debug-api:delete-owned-vault-secret",
  };
}

function promotedDebugApiVaultSetupMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiVaultSetupMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Vault setup config for ${surface.id}`);
  }
  const effect = surface.name === "POST /vault/setup/begin"
    ? "creates one valid local recovery challenge and proves its pending setup through successful confirmation"
    : surface.name === "POST /vault/setup/confirm-recovery"
      ? "activates the exact pending local Vault with recovery confirmed, no legacy import, and remembered-device storage disabled"
      : surface.name === "POST /vault/remember-device"
        ? "enables and verifies the OS-backed remembered-device credential, then deletes it and verifies disabled state"
        : "removes the active session while preserving the configured local Vault, recovery confirmation, and disabled remembered-device state";
  const oraclePath = surface.name.slice("POST /vault/".length).replaceAll("/", "-");
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-vault-setup-lifecycle",
    expectedEffect: `${surface.name} ${effect} inside the disposable Vault E2E profile, then restores the exact unconfigured baseline.`,
    oracleId: `debug-api:post-vault-${oraclePath}:semantic-effect`,
    cleanupId: "debug-api:reset-isolated-vault-e2e",
  };
}

function promotedDebugApiVaultAgentRequestMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiVaultAgentRequestMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Vault agent-request config for ${surface.id}`);
  }
  const cancel = surface.name.endsWith("/:request_id/cancel");
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-vault-agent-request",
    expectedEffect: cancel
      ? "POST /vault/agent-requests/:request_id/cancel terminates and reads back the exact owned pending executable request without executing it or exposing a secret, then resets all isolated request/resource state."
      : "POST /vault/agent-requests creates and reads back one exact metadata-only pending executable request without executing it or exposing a secret, then resets all isolated request/resource state.",
    oracleId: cancel
      ? "debug-api:post-vault-agent-requests-request-id-cancel:semantic-effect"
      : "debug-api:post-vault-agent-requests:semantic-effect",
    cleanupId: "debug-api:reset-isolated-vault-e2e-and-agent-state",
  };
}

function promotedDebugApiFsWatchMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiFsWatchMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API filesystem-watch config for ${surface.id}`);
  }
  const deleting = surface.name.startsWith("DELETE ");
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-native-temp-fs-watch",
    expectedEffect: `${surface.name} creates one owned native-temp watch, proves exact-ID deduplication and an exact marker event, stops it, and proves the watch ID absent.`,
    oracleId: deleting
      ? "debug-api:DELETE-tools-fs-watch-watchId:semantic-effect"
      : "debug-api:POST-tools-fs-watch:semantic-effect",
    cleanupId: "debug-api:stop-owned-fs-watch-and-delete-native-temp-fixture",
  };
}

function promotedDebugApiTauriInvokeRelayMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  if (!promotedDebugApiTauriInvokeRelayMutations.has(surface.name)) {
    throw new Error(`missing promoted Debug API Tauri invoke relay config for ${surface.id}`);
  }
  const routeEffect = surface.name.includes("/claim")
    ? "lets the installed renderer claim one exact nonce-bound allowlisted command"
    : surface.name.includes("/complete")
      ? "accepts the installed renderer's bounded terminal result for one claimed command"
      : surface.name.startsWith("GET ")
        ? "polls one exact terminal allowlisted command result"
        : surface.name.startsWith("DELETE ")
          ? "deletes one exact terminal command record and proves it absent"
          : "creates one exact allowlisted command without exposing its nonce or arguments to normal events";
  const oracleRoute = surface.name
    .replace(" ", "-")
    .replaceAll("/", "-")
    .replaceAll(":", "")
    .replace(/-+/g, "-");
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-tauri-invoke-relay",
    expectedEffect: `${surface.name} ${routeEffect}; get_debug_port binds the full claim/complete lifecycle to the attested isolated candidate before exact record deletion.`,
    oracleId: `debug-api:${oracleRoute}:semantic-effect`,
    cleanupId: "debug-api:delete-owned-tauri-invoke",
  };
}

function promotedDebugApiEnginePoolMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-browser-engine-pool",
    expectedEffect: "POST /browser/engine-pool changes the isolated candidate's logical parallel-agent and automation settings before exact logical restoration.",
    oracleId: "debug-api:POST-browser-engine-pool:semantic-effect",
    cleanupId: "debug-api:restore-browser-engine-pool",
  };
}

function promotedDebugApiPanelMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:installed-panel-baseline",
    expectedEffect: "POST /panels changes both installed panel split arrays before restoring the exact original arrays.",
    oracleId: "debug-api:POST-panels:semantic-effect",
    cleanupId: "debug-api:restore-panel-baseline",
  };
}

function promotedDebugApiPreviewTargetMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:installed-preview-baseline",
    expectedEffect: "POST /preview changes and reads back one typed Preview target before restoring the exact nullable baseline.",
    oracleId: "debug-api:POST-preview:semantic-effect",
    cleanupId: "debug-api:restore-preview-baseline",
  };
}

function promotedDebugApiSettingsMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-settings-profile",
    expectedEffect: "POST /settings changes all six normalized public settings fields before restoring the exact original object.",
    oracleId: "debug-api:POST-settings:semantic-effect",
    cleanupId: "debug-api:restore-settings-baseline",
  };
}

function promotedDebugApiConnectionMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const create = surface.name === "POST /connections";
  if (!create && surface.name !== "DELETE /connections/:id") {
    throw new Error(`missing promoted Debug API connection mutation config for ${surface.id}`);
  }
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-connection-preset",
    expectedEffect: create
      ? "POST /connections creates exactly one inert local connection preset in the isolated profile."
      : "DELETE /connections/:id removes exactly its prepared inert local connection preset.",
    oracleId: create
      ? "debug-api:POST-connections:semantic-effect"
      : "debug-api:DELETE-connections-id:semantic-effect",
    cleanupId: "debug-api:delete-owned-connection-preset",
  };
}

function promotedDebugApiOutsideConnectorMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const create = surface.name === "POST /outside-connectors";
  if (!create && surface.name !== "DELETE /outside-connectors/:id") {
    throw new Error(`missing promoted Debug API outside-connector mutation config for ${surface.id}`);
  }
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:isolated-disabled-outside-connector",
    expectedEffect: create
      ? "POST /outside-connectors creates exactly one disabled, network-inert connector reference in the isolated profile."
      : "DELETE /outside-connectors/:id removes exactly its prepared disabled connector reference.",
    oracleId: create
      ? "debug-api:POST-outside-connectors:semantic-effect"
      : "debug-api:DELETE-outside-connectors-id:semantic-effect",
    cleanupId: "debug-api:delete-owned-outside-connector",
  };
}

function promotedDebugApiUiMutationAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "debug-api-route-installed",
    fixtureId: "debug-api:installed-ui-baseline",
    expectedEffect: "POST /state/ui changes the isolated candidate's bottom-tab owner before restoring the exact logical UI baseline while preserving its monotonic audit trail.",
    oracleId: "debug-api:POST-state-ui:semantic-effect",
    cleanupId: "debug-api:restore-logical-ui-baseline",
  };
}

function promotedTauriSpecialAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment | null {
  if (surface.name === "release_test_take_native_picker") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-native-picker-lease",
      expectedEffect: "Installed Tauri IPC consumes one exact receipt-owned file result once and returns its bounded kind, path, and SHA-256 only inside the isolated candidate profile.",
      oracleId: "tauri:release_test_take_native_picker:single-use",
      cleanupId: "tauri:clear-native-picker-lease-delete-fixture",
    };
  }
  if (surface.name === "desktop_integration_install_windows_context_menu"
    || surface.name === "desktop_integration_remove_windows_context_menu") {
    const install = surface.name === "desktop_integration_install_windows_context_menu";
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:windows-desktop-integration-empty-baseline",
      expectedEffect: install
        ? "Installed Tauri IPC creates both exact candidate-owned HKCU Explorer verbs and the exact SendTo shortcut in the receipt-bound disposable Windows user."
        : "Installed Tauri IPC removes both prepared candidate-owned HKCU Explorer verbs and the exact SendTo shortcut from the receipt-bound disposable Windows user.",
      oracleId: `tauri:${surface.name}:native-lifecycle`,
      cleanupId: "tauri:remove-owned-windows-desktop-integration",
    };
  }
  if (surface.name === "get_debug_token" || surface.name === "shellxagent_token_read") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:attested-debug-token",
      expectedEffect: `Installed Tauri IPC ${surface.name} returns the exact token already bound to the attested disposable candidate without retaining token material.`,
      oracleId: `tauri:${surface.name}:attested-token`,
      cleanupId: "tauri:delete-invoke-state",
    };
  }
  if (surface.name === "abort_session") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-session-slot",
      expectedEffect: "Installed Tauri IPC abort_session aborts an owned empty session slot, reports success, and leaves no slot or child process behind.",
      oracleId: "tauri:abort_session:owned-session-aborted",
      cleanupId: "tauri:drop-owned-session-slot",
    };
  }
  if (surface.name === "start_grok_session") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-local-grok-session",
      expectedEffect: "Installed Tauri IPC starts and initializes one real local Grok ACP child in the isolated candidate profile without sending a provider prompt, then aborts the child and removes its session slot.",
      oracleId: "tauri:start_grok_session:owned-grok-session-active",
      cleanupId: "tauri:abort-owned-grok-session-and-drop-slot",
    };
  }
  if (surface.name === "capture_app_screenshot_to_file") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-screenshot-file",
      expectedEffect: "Installed Tauri IPC captures the isolated candidate as a bounded PNG before deleting the exact owned screenshot and any newly created empty parent directory.",
      oracleId: "tauri:capture_app_screenshot_to_file:owned-screenshot",
      cleanupId: "tauri:delete-owned-screenshot",
    };
  }
  if (surface.name === "shellxagent_token_regenerate") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-token-rotation",
      expectedEffect: "Installed Tauri IPC rotates the isolated candidate token, proves its format, disk persistence, and command readback, then preserves the live token only until disposable candidate teardown.",
      oracleId: "tauri:shellxagent_token_regenerate:owned-token-rotation",
      cleanupId: "tauri:preserve-rotated-token-until-candidate-teardown",
    };
  }
  if (surface.name === "shellx_browser_open_vault_panel") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:installed-vault-panel-closed",
      expectedEffect: "Installed Tauri IPC opens the real Vault workspace in the attested renderer before authenticated Debug UI highlight proof and close restore the panel after all bounded notification retries.",
      oracleId: "tauri:shellx_browser_open_vault_panel:visible-vault-workspace",
      cleanupId: "tauri:close-vault-panel-after-retries",
    };
  }
  if (surface.name === "shellx_browser_open_window") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-monotonic-event",
      expectedEffect: "Installed Tauri IPC opens or focuses the ShellX Browser native window at about:blank, proves its exact response, foreground registry state, and monotonic receipt, then discards the window and receipt with the isolated candidate profile.",
      oracleId: "tauri:shellx_browser_open_window:native-window-opened",
      cleanupId: "tauri:discard-with-candidate-profile",
    };
  }
  if (surface.name === "shellx_browser_clear_history") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-browser-history",
      expectedEffect: "Installed Tauri IPC shellx_browser_clear_history clears exactly one owned loopback history entry through an explicit all-scope request, proves empty readback, closes the owned task and tab, and leaves its monotonic receipt only until candidate teardown.",
      oracleId: "tauri:shellx_browser_clear_history:owned-history-cleared",
      cleanupId: "tauri:close-owned-browser-history-fixture",
    };
  }
  if (surface.name === "shellx_browser_operator_evidence_summary") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-browser-evidence",
      expectedEffect: "Installed operator Tauri IPC returns one bounded owned Flight Recorder evidence row after an exact fixture export, then removes the artifact, task, and tab.",
      oracleId: "tauri:shellx_browser_operator_evidence_summary:owned-evidence-row",
      cleanupId: "tauri:close-owned-browser-evidence-fixture",
    };
  }
  if (surface.name === "shellx_browser_operator_export_flight_recorder") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-browser-evidence",
      expectedEffect: "Installed operator Tauri IPC writes one bounded Flight Recorder artifact for an exact owned task, verifies its bytes and SHA-256, then removes the file, task, and tab.",
      oracleId: "tauri:shellx_browser_operator_export_flight_recorder:owned-artifact",
      cleanupId: "tauri:close-owned-browser-evidence-fixture",
    };
  }
  if (surface.name === "shellx_browser_operator_developer_inspect") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-browser-operator-workflow",
      expectedEffect: "Installed operator Tauri IPC invokes the fixed Browser developer inspector for one owned task and proves its expected Developer Mode denial without granting approval, enabling Developer Mode, or mutating the page.",
      oracleId: "tauri:shellx_browser_operator_developer_inspect:developer-mode-denial",
      cleanupId: "tauri:close-owned-browser-operator-workflow-and-candidate-teardown",
    };
  }
  if (surface.name === "shellx_browser_operator_export_har" || surface.name === "shellx_browser_operator_export_performance") {
    const kind = surface.name.endsWith("export_har") ? "HAR" : "performance";
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-browser-operator-workflow",
      expectedEffect: `Installed operator Tauri IPC exports one bounded owned Browser ${kind} artifact and returns only its compact receipt; the task, tab, loopback page, and private candidate artifacts end with exact cleanup and candidate teardown.`,
      oracleId: `tauri:${surface.name}:owned-artifact-receipt`,
      cleanupId: "tauri:close-owned-browser-operator-workflow-and-candidate-teardown",
    };
  }
  if (new Set([
    "shellx_browser_operator_prepare_teach_draft",
    "shellx_browser_operator_list_teach_drafts",
    "shellx_browser_operator_revise_teach_draft",
    "shellx_browser_operator_approve_teach_draft",
    "shellx_browser_operator_rehearse_teach_recipe",
  ]).has(surface.name)) {
    const effect = surface.name === "shellx_browser_operator_prepare_teach_draft"
      ? "derives one immutable operator Teach draft from exact owned Flight Recorder evidence"
      : surface.name === "shellx_browser_operator_list_teach_drafts"
        ? "reads back one exact owned operator Teach draft"
        : surface.name === "shellx_browser_operator_revise_teach_draft"
          ? "creates one compare-and-swap operator Teach revision and reads it back"
          : surface.name === "shellx_browser_operator_approve_teach_draft"
            ? "creates one operator-approved Action Recipe V2 draft and matching approval receipt without applying it"
            : "dry-runs one approved Teach recipe with zero applied steps and records one rehearsal receipt";
    const oracle = surface.name === "shellx_browser_operator_prepare_teach_draft"
      ? "owned-draft"
      : surface.name === "shellx_browser_operator_list_teach_drafts"
        ? "owned-draft-readback"
        : surface.name === "shellx_browser_operator_revise_teach_draft"
          ? "owned-revision"
          : surface.name === "shellx_browser_operator_approve_teach_draft"
            ? "owned-approval-receipt"
            : "dry-run-receipt";
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-browser-operator-workflow",
      expectedEffect: `Installed operator Tauri IPC ${effect}; Debug API has no approval or replay authority, and the exact task, tab, loopback page, and private candidate artifacts end with cleanup and candidate teardown.`,
      oracleId: `tauri:${surface.name}:${oracle}`,
      cleanupId: "tauri:close-owned-browser-operator-workflow-and-candidate-teardown",
    };
  }
  if (surface.name === "shellx_browser_sync_engine") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-browser-engine-sync",
      expectedEffect: "Installed Tauri IPC resynchronizes one exact owned Browser engine with bounded layout coordinates while preserving its settled loopback page, then removes the exact task, tab, and engine.",
      oracleId: "tauri:shellx_browser_sync_engine:owned-engine-preserved",
      cleanupId: "tauri:close-owned-browser-engine-sync",
    };
  }
  if (surface.name === "renderer_error") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-monotonic-event",
      expectedEffect: "Installed Tauri IPC renderer_error records one exact bounded synthetic event in the authenticated candidate ledger; the event is discarded with the isolated candidate process and profile.",
      oracleId: "tauri:renderer_error:owned-ledger-event",
      cleanupId: "tauri:discard-with-candidate-profile",
    };
  }
  if (surface.name === "set_permission_mode") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-session-slot",
      expectedEffect: "Installed Tauri IPC applies the ShellX Full Auto permission default to one owned empty session slot, reports the exact mode, and removes the slot.",
      oracleId: "tauri:set_permission_mode:full-auto-slot-removed",
      cleanupId: "tauri:drop-owned-session-slot",
    };
  }
  if (surface.name === "mcp_marketplace_uninstall") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-marketplace-mutation",
      expectedEffect: "Installed Tauri IPC uninstalls one prepared marketplace entry from the isolated profile before restoring the exact prior marketplace and Grok configuration files.",
      oracleId: "tauri:mcp_marketplace_uninstall:owned-marketplace",
      cleanupId: "tauri:restore-marketplace-files",
    };
  }
  if (surface.name === "shellx_vault_agent_request_approve"
    || surface.name === "shellx_vault_agent_request_deny") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-vault-agent-state",
      expectedEffect: `Installed Tauri IPC ${surface.name} returns the exact unknown-request rejection before any command execution and restores the Vault agent-state files byte-for-byte.`,
      oracleId: `tauri:${surface.name}:fail-closed`,
      cleanupId: "tauri:restore-vault-agent-state",
    };
  }
  if (new Set([
    "vault_delete",
    "vault_get",
    "vault_set",
    "vault_set_resource",
    "vault_update_metadata",
    "vault_update_resource_metadata",
  ]).has(surface.name)) {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-vault-mutation",
      expectedEffect: `Installed Tauri IPC ${surface.name} performs and reads back its exact owned compatibility-Vault lifecycle effect without retaining the key or value.`,
      oracleId: `tauri:${surface.name}:owned-vault`,
      cleanupId: "tauri:delete-owned-vault-secret",
    };
  }
  if (surface.name === "git_session_create_checkpoint" || surface.name === "git_session_create_worktree") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-git-mutation",
      expectedEffect: `Installed Tauri IPC ${surface.name} performs and verifies its exact effect only inside an owned disposable repository and profile before removing all artifacts.`,
      oracleId: `tauri:${surface.name}:owned-repository-mutation`,
      cleanupId: "tauri:delete-owned-git-mutation",
    };
  }
  if (surface.name === "cleanup_mcp_children_for_tab") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-absent-mcp-children",
      expectedEffect: "Installed Tauri IPC cleanup_mcp_children_for_tab reports zero for an owned absent tab without touching any real process.",
      oracleId: "tauri:cleanup_mcp_children_for_tab:absent-tab",
      cleanupId: "tauri:delete-invoke-state",
    };
  }
  if (surface.name === "resolve_permission_request") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-absent-permission",
      expectedEffect: "Installed Tauri IPC resolve_permission_request returns false for an unregistered disposable identifier without resolving a live request.",
      oracleId: "tauri:resolve_permission_request:absent-request",
      cleanupId: "tauri:delete-invoke-state",
    };
  }
  if (surface.name === "shellx_browser_replay_cowork_prompt_notifications") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:installed-read-model",
      expectedEffect: "Installed Tauri IPC shellx_browser_replay_cowork_prompt_notifications reports zero for the isolated candidate's empty prompt queue.",
      oracleId: "tauri:shellx_browser_replay_cowork_prompt_notifications:empty-replay",
      cleanupId: "tauri:delete-invoke-state",
    };
  }
  if (new Set(["append_session_log", "delete_session_files", "rename_past_session"]).has(surface.name)) {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-session-history-mutation",
      expectedEffect: `Installed Tauri IPC ${surface.name} applies its exact effect to one owned disposable session history and leaves no history file behind.`,
      oracleId: `tauri:${surface.name}:owned-history`,
      cleanupId: "tauri:delete-owned-session-history",
    };
  }
  if (surface.name === "delete_user_data_section" || surface.name === "write_user_data") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-user-data-mutation",
      expectedEffect: `Installed Tauri IPC ${surface.name} applies and reads back its exact owned user-data effect before restoring the isolated store to empty.`,
      oracleId: `tauri:${surface.name}:owned-user-data`,
      cleanupId: "tauri:restore-empty-user-data",
    };
  }
  if (new Set(["mark_goal_complete", "pause_goal", "reject_goal_plan", "resume_goal", "set_goal_mode"]).has(surface.name)) {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-goal-state",
      expectedEffect: `Installed Tauri IPC ${surface.name} performs its exact transition on an owned disposable goal and then clears the state and scratchboard.`,
      oracleId: `tauri:${surface.name}:owned-goal-state`,
      cleanupId: "tauri:clear-owned-goal-state",
    };
  }
  if (new Set([
    "shellx_browser_update_developer_mode",
    "shellx_browser_update_download_folder",
    "shellx_browser_update_shields",
  ]).has(surface.name)) {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-browser-setting-mutation",
      expectedEffect: `Installed Tauri IPC ${surface.name} changes the isolated Browser setting, proves exact runtime${surface.name === "shellx_browser_update_developer_mode" ? "" : " and persisted"} readback, and restores the prior state and settings file; monotonic receipts end with candidate teardown.`,
      oracleId: `tauri:${surface.name}:owned-browser-setting`,
      cleanupId: "tauri:restore-browser-setting-state",
    };
  }
  if (promotedTauriFailClosedCommands.has(surface.name)) {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-fail-closed-validation",
      expectedEffect: `Installed Tauri IPC ${surface.name} returns its exact fail-closed validation or absent-state rejection before performing the guarded operation.`,
      oracleId: `tauri:${surface.name}:fail-closed`,
      cleanupId: surface.name === "archive_session_artifacts"
        ? "tauri:drop-owned-session-slot"
        : "tauri:delete-invoke-state",
    };
  }
  if (promotedTauriAbsentStateCommands.has(surface.name)) {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-absent-state",
      expectedEffect: `Installed Tauri IPC ${surface.name} returns its exact idempotent absent-state result without changing a live process or run.`,
      oracleId: `tauri:${surface.name}:absent-state`,
      cleanupId: "tauri:delete-invoke-state",
    };
  }
  if (surface.name === "connections_save" || surface.name === "connections_delete") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-connection-mutation",
      expectedEffect: `Installed Tauri IPC ${surface.name} performs and reads back its exact owned local-connection lifecycle effect before deleting the fixture.`,
      oracleId: `tauri:${surface.name}:owned-connection`,
      cleanupId: "tauri:delete-owned-connection",
    };
  }
  if (surface.name === "connections_test") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-absent-state",
      expectedEffect: "Installed Tauri IPC connections_test returns its exact network-inert unknown-connection result.",
      oracleId: "tauri:connections_test:absent-connection",
      cleanupId: "tauri:delete-invoke-state",
    };
  }
  if (surface.name === "outside_connectors_save" || surface.name === "outside_connectors_delete") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-outside-connector-mutation",
      expectedEffect: `Installed Tauri IPC ${surface.name} performs and reads back its exact disabled outside-connector lifecycle effect before deleting the fixture.`,
      oracleId: `tauri:${surface.name}:owned-outside-connector`,
      cleanupId: "tauri:delete-owned-outside-connector",
    };
  }
  if (surface.name === "outside_connectors_test") {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-absent-state",
      expectedEffect: "Installed Tauri IPC outside_connectors_test returns its exact network-inert unknown-connector result.",
      oracleId: "tauri:outside_connectors_test:absent-connector",
      cleanupId: "tauri:delete-invoke-state",
    };
  }
  if (new Set([
    "copy_asset_to_scope",
    "copy_to_scope",
    "save_dropped_attachment_to_scope",
    "shellx_browser_copy_local_artifact",
    "shellx_browser_write_text_artifact",
  ]).has(surface.name)) {
    return {
      surfaceId: surface.id,
      driverId: "tauri-command-installed",
      fixtureId: "tauri:isolated-file-mutation",
      expectedEffect: `Installed Tauri IPC ${surface.name} writes and reads back exact owned bytes only under the isolated profile before deleting the fixture.`,
      oracleId: `tauri:${surface.name}:owned-file`,
      cleanupId: "tauri:delete-owned-file-fixture",
    };
  }
  return null;
}

function promotedTauriAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const special = promotedTauriSpecialAssignment(surface);
  if (special) return special;
  const profileFixture = new Set([
    "list_project_files",
    "read_text_file_for_path",
    "read_text_file_if_text",
  ]).has(surface.name);
  const sessionSlotFixture = surface.name === "get_detected_max_tokens" || surface.name === "drop_tab_session";
  const gitFixture = new Set(["git_branches", "git_session_diff", "git_session_status"]).has(surface.name);
  const userDataFixture = surface.name === "read_user_data";
  const sessionHistoryFixture = surface.name === "read_session_jsonl" || surface.name === "read_session_jsonl_tail";
  const mediaFixture = surface.name === "read_image_as_data_url" || surface.name === "read_preview_file_as_data_url";
  const absentSessionFixture = surface.name === "read_session_activity_source"
    || surface.name === "grok_environment_snapshot";
  const vaultReadFixture = surface.name === "shellx_vault_agent_request_center";
  const expectedEffect = surface.name === "drop_tab_session"
    ? "Installed Tauri IPC drop_tab_session removes the exact prepared disposable session slot and reports that it existed."
    : surface.name === "get_detected_max_tokens"
      ? "Installed Tauri IPC get_detected_max_tokens returns the exact empty-session fallback before its disposable slot is removed."
      : surface.name === "git_branches"
        ? "Installed Tauri IPC git_branches returns the exact current branch from an owned disposable repository before that repository is removed."
        : surface.name === "git_session_status"
          ? "Installed Tauri IPC git_session_status returns the exact dirty state from an owned disposable repository before that repository is removed."
          : surface.name === "git_session_diff"
            ? "Installed Tauri IPC git_session_diff returns the exact bounded HEAD patch from an owned disposable repository before that repository is removed."
        : `Installed Tauri IPC ${surface.name} returns its bounded read-only schema without retaining returned user data in release evidence.`;
  return {
    surfaceId: surface.id,
    driverId: "tauri-command-installed",
    fixtureId: profileFixture
      ? "tauri:isolated-profile-marker"
      : sessionSlotFixture
        ? "tauri:isolated-session-slot"
        : gitFixture
          ? "tauri:isolated-git-repository"
          : userDataFixture
            ? "tauri:isolated-user-data-store"
            : sessionHistoryFixture
              ? "tauri:isolated-session-history"
              : mediaFixture
              ? "tauri:isolated-media-file"
              : absentSessionFixture
                ? "tauri:isolated-absent-session"
                : vaultReadFixture
                  ? "tauri:isolated-vault-read-model"
          : "tauri:installed-read-model",
    expectedEffect,
    oracleId: surface.name === "drop_tab_session"
      ? "tauri:drop_tab_session:slot-removed"
      : surface.name === "get_detected_max_tokens"
        ? "tauri:get_detected_max_tokens:context-fallback"
        : surface.name === "git_branches"
          ? "tauri:git_branches:owned-repository"
          : surface.name === "git_session_status"
            ? "tauri:git_session_status:owned-repository"
        : surface.name === "git_session_diff"
              ? "tauri:git_session_diff:owned-repository"
              : surface.name === "read_session_jsonl"
                ? "tauri:read_session_jsonl:owned-history"
                : surface.name === "read_session_jsonl_tail"
                  ? "tauri:read_session_jsonl_tail:owned-history"
                  : surface.name === "read_image_as_data_url"
                    ? "tauri:read_image_as_data_url:owned-media"
                    : surface.name === "read_preview_file_as_data_url"
                      ? "tauri:read_preview_file_as_data_url:owned-media"
          : `tauri:${surface.name}:read-schema`,
    cleanupId: profileFixture
      ? "tauri:preserve-owned-profile-marker"
      : sessionSlotFixture
        ? "tauri:drop-owned-session-slot"
        : gitFixture
          ? "tauri:delete-owned-git-fixture"
          : userDataFixture
            ? "tauri:read-only-user-data"
            : sessionHistoryFixture
              ? "tauri:delete-owned-session-history"
              : mediaFixture
              ? "tauri:delete-owned-media-file"
              : absentSessionFixture
                ? "tauri:delete-invoke-state"
                : vaultReadFixture
                  ? "tauri:delete-invoke-state"
          : "tauri:delete-invoke-state",
  };
}

function promotedBrowserCliWorkflowAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "browser-cli-command-installed",
    fixtureId: "browser-cli:flight-recorder-disposable-task",
    expectedEffect: `Installed Browser CLI ${surface.name} produces a bounded exact-identity Flight Recorder artifact against a disposable task.`,
    oracleId: `browser-cli:${surface.name}:flight-recorder-effect`,
    cleanupId: "browser-cli:close-owned-task-and-delete-run-profile",
  };
}

function promotedBrowserCliReadAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "browser-cli-command-installed",
    fixtureId: "browser-cli:installed-read-model",
    expectedEffect: `Installed Browser CLI ${surface.name} returns its exact bounded workflow schema without retaining workflow contents in release evidence.`,
    oracleId: `browser-cli:${surface.name}:schema`,
    cleanupId: "browser-cli:read-only",
  };
}

function promotedBrowserCliRenderedCheckAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "browser-cli-command-installed",
    fixtureId: "browser-cli:hidden-rendered-loopback",
    expectedEffect: "Installed Browser CLI rendered-check verifies an owned loopback page in an isolated hidden renderer without creating visible Browser state.",
    oracleId: "browser-cli:rendered-check:hidden-renderer-effect",
    cleanupId: "browser-cli:destroy-hidden-renderer-and-delete-run-profile",
  };
}

function promotedBrowserCliArtifactAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "browser-cli-command-installed",
    fixtureId: "browser-cli:disposable-local-page-task",
    expectedEffect: `Installed Browser CLI ${surface.name} creates one bounded exact-identity artifact against an owned loopback page task without retaining its path or content in release evidence.`,
    oracleId: `browser-cli:${surface.name}:artifact-effect`,
    cleanupId: "browser-cli:close-owned-task-and-delete-run-profile",
  };
}

function promotedBrowserCliRecipeWorkflowAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "browser-cli-command-installed",
    fixtureId: "browser-cli:disposable-local-page-task",
    expectedEffect: `Installed Browser CLI ${surface.name} proves its exact bounded recipe workflow against an owned loopback task without retaining recipe or bookmark content in release evidence.`,
    oracleId: `browser-cli:${surface.name}:workflow-effect`,
    cleanupId: "browser-cli:close-owned-task-and-delete-run-profile",
  };
}

function promotedBrowserCliActionAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  return {
    surfaceId: surface.id,
    driverId: "browser-cli-command-installed",
    fixtureId: "browser-cli:disposable-local-page-task",
    expectedEffect: `Installed Browser CLI ${surface.name} drives its exact bounded action against an owned loopback page task.`,
    oracleId: `browser-cli:${surface.name}:local-page-effect`,
    cleanupId: "browser-cli:close-owned-task-and-delete-run-profile",
  };
}

function promotedHostMcpReadAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const browserFixture = promotedHostMcpBrowserFixtureTools.has(surface.name);
  const hiddenRendererFixture = surface.name === "browser_rendered_check";
  return {
    surfaceId: surface.id,
    driverId: "host-mcp-tool-installed",
    fixtureId: hiddenRendererFixture
      ? "host-mcp:installed-browser-hidden-renderer-fixture"
      : browserFixture
      ? "host-mcp:installed-browser-mutation-fixture"
      : "host-mcp:installed-read-fixture",
    expectedEffect: hiddenRendererFixture
      ? "Installed Host MCP browser_rendered_check proves exact text/title/selector matches in an isolated loopback hidden renderer and proves renderer/profile cleanup without creating a visible task or retaining page data."
      : browserFixture
      ? `Installed Host MCP ${surface.name} proves its exact bounded read-only effect against an owned disposable loopback Browser task without retaining task or page data.`
      : `Installed Host MCP ${surface.name} returns its exact bounded read-only contract against the attested candidate without retaining returned host data in release evidence.`,
    oracleId: `host-mcp:${surface.name}:installed-read-effect`,
    cleanupId: hiddenRendererFixture
      ? "host-mcp:close-owned-browser-server"
      : browserFixture
      ? "host-mcp:close-owned-browser-task-and-restore-autonomy"
      : "host-mcp:delete-owned-read-fixture",
  };
}

function promotedHostMcpWriteAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const browserGateway = promotedHostMcpBrowserFixtureTools.has(surface.name);
  const previewLifecycle = surface.name === "preview_start";
  const vaultGeneration = surface.name === "vault_generate";
  const vaultBrowserLifecycle = [
    "browser_capture_secret_to_vault",
    "browser_read_email_code",
    "browser_use_agent_wallet",
  ].includes(surface.name);
  return {
    surfaceId: surface.id,
    driverId: "host-mcp-tool-installed",
    fixtureId: previewLifecycle
      ? "host-mcp:installed-preview-lifecycle-fixture"
      : vaultBrowserLifecycle
      ? "host-mcp:installed-vault-e2e-browser-lifecycle"
      : browserGateway
      ? "host-mcp:installed-browser-mutation-fixture"
      : "host-mcp:installed-mutation-fixture",
    expectedEffect: previewLifecycle
      ? "Installed Host MCP preview_start passes the exact write-class permission gate, serves an owned static project through ShellX Work Preview, and proves exact loopback teardown without mutating user or external state."
      : vaultGeneration
      ? "Installed Host MCP vault_generate passes the exact write-class permission gate, creates one disposable Vault item without exposing its generated password, refuses overwrite, and proves exact item deletion."
      : surface.name === "browser_capture_secret_to_vault"
      ? "Installed Host MCP browser_capture_secret_to_vault passes the exact write-class gate, captures one synthetic owned loopback field directly into an isolated disposable Vault profile, proves presence without reveal, and resets the profile."
      : surface.name === "browser_read_email_code"
      ? "Installed Host MCP browser_read_email_code passes the exact write-class gate, validates an approved EmailCodeRead grant, returns one synthetic code to the tool, records only redacted receipt metadata, and resets the isolated Vault profile."
      : surface.name === "browser_use_agent_wallet"
      ? "Installed Host MCP browser_use_agent_wallet passes the exact write-class gate, validates an approved AgentWalletUse grant, and proves the declared browser_agent_wallet_checkout_unavailable error plus redacted receipt without claiming payment success."
      : `Installed Host MCP ${surface.name} passes the exact write-class permission gate and proves its bounded disposable effect, metadata-only operation, or pre-effect safety refusal without mutating user or external state.`,
    oracleId: `host-mcp:${surface.name}:installed-mutation-effect`,
    cleanupId: previewLifecycle
      ? "host-mcp:stop-owned-preview-and-delete-project"
      : vaultBrowserLifecycle
      ? "host-mcp:reset-isolated-vault-close-owned-browser-task-and-restore-autonomy"
      : browserGateway
      ? "host-mcp:close-owned-browser-task-and-restore-autonomy"
      : vaultGeneration
      ? "host-mcp:delete-generated-vault-item-and-owned-mutation-fixture-and-restore-autonomy"
      : "host-mcp:delete-owned-mutation-fixture-and-restore-autonomy",
  };
}

function backlogDriver(kind: ReleaseSurfaceKind): FinalSurfaceDriverDefinition {
  return {
    id: backlogDriverId(kind),
    kind,
    entrypoint: `scripts/release-drivers/${kind}-backlog-installed.ts`,
    platforms: {
      "windows-installed": "building",
      "macos-installed": "building",
      "linux-installed": "building",
    },
  };
}

function backlogAssignment(surface: ReleaseSurfaceItem): FinalSurfaceDriverAssignment {
  const common = {
    surfaceId: surface.id,
    driverId: backlogDriverId(surface.kind),
  };
  const tasksPanelBlocker = tasksPanelBuildingBlockers.get(occurrenceIndependentSurfaceId(surface.id));
  if (tasksPanelBlocker) {
    return {
      ...common,
      fixtureId: "ui:tasks-panel-excluded-provider-clipboard-or-operator-state",
      expectedEffect: `BUILDING: ${tasksPanelBlocker}.`,
      oracleId: surface.kind === "ui-control"
        ? "ui:activation:tasks-panel-excluded-building-blocker"
        : `ui:${oracleSegment(surface.name)}:building-blocker`,
      cleanupId: "ui:not-invoked",
    };
  }
  const chatOutputBlocker = chatOutputBuildingBlockers.get(occurrenceIndependentSurfaceId(surface.id));
  if (chatOutputBlocker) {
    return {
      ...common,
      fixtureId: "ui:chat-output-excluded-clipboard-state",
      expectedEffect: `BUILDING: ${chatOutputBlocker}.`,
      oracleId: surface.kind === "ui-control"
        ? "ui:activation:chat-output-excluded-building-blocker"
        : `ui:${oracleSegment(surface.name)}:building-blocker`,
      cleanupId: "ui:not-invoked",
    };
  }
  const rightRailGitBlocker = rightRailGitBuildingBlockers.get(occurrenceIndependentSurfaceId(surface.id));
  if (rightRailGitBlocker) {
    return {
      ...common,
      fixtureId: "ui:right-rail-git-excluded-network-provider-clipboard-file-or-repository-state",
      expectedEffect: `BUILDING: ${rightRailGitBlocker}.`,
      oracleId: surface.kind === "ui-control"
        ? "ui:activation:right-rail-git-excluded-building-blocker"
        : `ui:${oracleSegment(surface.name)}:building-blocker`,
      cleanupId: "ui:not-invoked",
    };
  }
  const vaultUiLifecycleBlocker = vaultUiLifecycleBuildingBlockers.get(surface.id);
  if (vaultUiLifecycleBlocker) {
    return {
      ...common,
      fixtureId: "ui:vault-ui-excluded-clipboard-request-or-trusted-fill-state",
      expectedEffect: `BUILDING: ${vaultUiLifecycleBlocker}.`,
      oracleId: surface.kind === "ui-control"
        ? `ui:activation:${oracleSegment(surface.name)}:building-blocker`
        : `ui:${oracleSegment(surface.name)}:building-blocker`,
      cleanupId: "ui:not-invoked",
    };
  }
  const vaultSettingsBlocker = vaultSettingsBuildingBlockers.get(surface.id);
  if (vaultSettingsBlocker) {
    return {
      ...common,
      fixtureId: "ui:vault-settings-excluded-keyfile-clipboard-or-device-state",
      expectedEffect: `BUILDING: ${vaultSettingsBlocker}.`,
      oracleId: surface.kind === "ui-control"
        ? `ui:activation:${oracleSegment(surface.name)}:building-blocker`
        : `ui:${oracleSegment(surface.name)}:building-blocker`,
      cleanupId: "ui:not-invoked",
    };
  }
  const blocker = irreducibleSmallSurfaceBlockers.get(surface.id);
  if (blocker) {
    return {
      ...common,
      fixtureId: `${surface.kind}:irreducible-native-or-operator-state`,
      expectedEffect: `BUILDING: ${blocker}`,
      oracleId: surface.kind === "ui-control"
        ? surface.driverFamily === "activation"
          ? `ui:activation:${oracleSegment(surface.name)}:building-blocker`
          : {
              selection: "ui:selection-state-transition",
              disclosure: "ui:disclosure-state-transition",
              toggle: "ui:boolean-state-transition",
              "text-entry": "ui:value-state-transition",
              choice: "ui:choice-state-transition",
              range: "ui:range-state-transition",
              "file-picker": "ui:file-attachment-transition",
            }[surface.driverFamily as Exclude<ReleaseUiInteractionFamily, "activation">]
        : `${surface.kind}:${oracleSegment(surface.name)}:building-blocker`,
      cleanupId: `${surface.kind}:not-invoked`,
    };
  }
  switch (surface.kind) {
    case "tauri-command":
      return {
        ...common,
        fixtureId: "tauri:command-specific-disposable-state",
        expectedEffect: `Installed Tauri IPC ${surface.name} returns its command-specific success payload and proves any declared state transition in disposable state.`,
        oracleId: `tauri:${oracleSegment(surface.name)}:semantic-effect`,
        cleanupId: "tauri:restore-command-specific-disposable-state",
      };
    case "debug-api-route": {
      const [method = "route", ...pathParts] = surface.name.split(" ");
      const path = pathParts.join(" ");
      return {
        ...common,
        fixtureId: "debug-api:route-specific-disposable-state",
        expectedEffect: `${surface.name} returns its exact route contract and proves any declared state transition against disposable state.`,
        oracleId: `debug-api:${oracleSegment(`${method}-${path}`)}:semantic-effect`,
        cleanupId: "debug-api:restore-route-specific-disposable-state",
      };
    }
    case "host-mcp-tool":
      return {
        ...common,
        fixtureId: "host-mcp:tool-specific-disposable-state",
        expectedEffect: `Host MCP ${surface.name} returns its typed tool result and proves its declared semantic effect against disposable state.`,
        oracleId: `host-mcp:${oracleSegment(surface.name)}:semantic-effect`,
        cleanupId: "host-mcp:restore-tool-specific-disposable-state",
      };
    case "browser-cli-command":
      return {
        ...common,
        fixtureId: "browser-cli:command-specific-disposable-state",
        expectedEffect: `Browser CLI ${surface.name} accepts bounded fixture arguments, returns its exact command contract, and proves its declared Browser effect.`,
        oracleId: `browser-cli:${oracleSegment(surface.name)}:semantic-effect`,
        cleanupId: "browser-cli:restore-command-specific-disposable-state",
      };
    case "palette-action":
      return {
        ...common,
        fixtureId: "palette:action-specific-opposite-baseline",
        expectedEffect: `Native command-palette action ${surface.name} reaches its action-specific owner state from an opposite baseline.`,
        oracleId: `palette:${oracleSegment(surface.name)}:semantic-effect`,
        cleanupId: "palette:restore-action-specific-baseline",
      };
    case "keyboard-shortcut":
      return {
        ...common,
        fixtureId: "keyboard:shortcut-specific-opposite-baseline",
        expectedEffect: `Native keyboard shortcut ${surface.name} reaches its shortcut-specific owner state from an opposite baseline.`,
        oracleId: `keyboard:${oracleSegment(surface.name)}:semantic-effect`,
        cleanupId: "keyboard:restore-shortcut-specific-baseline",
      };
    case "shellx-command":
      return {
        ...common,
        fixtureId: "shellx-command:command-specific-disposable-state",
        expectedEffect: `Native composer submission of ${surface.name} reaches its command-specific result state with bounded fixture input.`,
        oracleId: `shellx-command:${oracleSegment(surface.name)}:semantic-effect`,
        cleanupId: "shellx-command:restore-command-specific-disposable-state",
      };
    case "ui-debug-surface":
      return {
        ...common,
        fixtureId: surface.driverFamily === "dynamic-marker"
          ? "ui:dynamic-marker-owned-state"
          : "ui:static-marker-owned-state",
        expectedEffect: `${surface.name} resolves through its deterministic owned UI state to a visible non-empty rectangle.`,
        oracleId: "ui:visible-nonempty-rectangle",
        cleanupId: "ui:clear-debug-highlight-and-restore-owned-state",
      };
    case "ui-control":
      return uiControlBacklogAssignment(surface, common);
  }
}

function uiControlBacklogAssignment(
  surface: ReleaseSurfaceItem,
  common: Pick<FinalSurfaceDriverAssignment, "surfaceId" | "driverId">,
): FinalSurfaceDriverAssignment {
  const activityPermissionBlocker = activityPermissionBuildingBlockers.get(surface.name);
  if (activityPermissionBlocker) {
    return {
      ...common,
      fixtureId: "ui:activity-permission-excluded-provider-clipboard-or-live-request",
      expectedEffect: `BUILDING: ${activityPermissionBlocker}.`,
      oracleId: `ui:activation:${oracleSegment(surface.name)}:building-blocker`,
      cleanupId: "ui:not-invoked",
    };
  }
  const workPreviewBlocker = workPreviewBuildingBlockers.get(surface.id);
  if (workPreviewBlocker) {
    return {
      ...common,
      fixtureId: "ui:work-preview-excluded-provider-clipboard-or-external-path",
      expectedEffect: `BUILDING: ${workPreviewBlocker}.`,
      oracleId: `ui:activation:${oracleSegment(surface.name)}:building-blocker`,
      cleanupId: "ui:not-invoked",
    };
  }
  const settingsCoreBlocker = settingsCoreBuildingBlockers.get(surface.name);
  if (settingsCoreBlocker) {
    return {
      ...common,
      fixtureId: "ui:settings-core-excluded-external-os-picker-or-destructive-state",
      expectedEffect: `BUILDING: ${settingsCoreBlocker}.`,
      oracleId: `ui:activation:${oracleSegment(surface.name)}:building-blocker`,
      cleanupId: "ui:not-invoked",
    };
  }
  const agentCliSetupBlocker = agentCliSetupBuildingBlockers.get(surface.id);
  if (agentCliSetupBlocker) {
    return {
      ...common,
      fixtureId: "ui:agent-cli-setup-excluded-real-provider-or-operator-state",
      expectedEffect: `BUILDING: ${agentCliSetupBlocker}.`,
      oracleId: `ui:activation:${oracleSegment(surface.name)}:building-blocker`,
      cleanupId: "ui:not-invoked",
    };
  }
  const attachmentMediaBlocker = attachmentMediaBuildingBlockers.get(surface.name);
  if (attachmentMediaBlocker) {
    return {
      ...common,
      fixtureId: "ui:attachment-media-excluded-native-or-prompt-path",
      expectedEffect: `BUILDING: ${attachmentMediaBlocker}.`,
      oracleId: `ui:activation:${oracleSegment(surface.name)}:building-blocker`,
      cleanupId: "ui:not-invoked",
    };
  }
  const miscUiBlocker = miscUiBuildingBlockers.get(surface.name);
  if (miscUiBlocker) {
    return {
      ...common,
      fixtureId: "ui:misc-excluded-clipboard-url-provider-updater-git-session-or-destructive-state",
      expectedEffect: `BUILDING: ${miscUiBlocker}.`,
      oracleId: surface.driverFamily === "selection"
        ? "ui:selection-state-transition"
        : `ui:activation:${oracleSegment(surface.name)}:building-blocker`,
      cleanupId: "ui:not-invoked",
    };
  }
  const shellxagentBlocker = shellxagentBuildingBlockers.get(surface.name);
  if (shellxagentBlocker) {
    return {
      ...common,
      fixtureId: "ui:shellxagent-excluded-clipboard-or-live-token-mutation",
      expectedEffect: `BUILDING: ${shellxagentBlocker}.`,
      oracleId: `ui:activation:${oracleSegment(surface.name)}:building-blocker`,
      cleanupId: "ui:not-invoked",
    };
  }
  const connectorsBlocker = connectorsBuildingBlockers.get(surface.name);
  if (connectorsBlocker) {
    return {
      ...common,
      fixtureId: "ui:connectors-excluded-provider-vault-session-or-operator-state",
      expectedEffect: `BUILDING: ${connectorsBlocker}.`,
      oracleId: `ui:activation:${oracleSegment(surface.name)}:building-blocker`,
      cleanupId: "ui:not-invoked",
    };
  }
  const appBottomBlocker = appBottomLifecycleBuildingBlockers.get(surface.id);
  if (appBottomBlocker) {
    return {
      ...common,
      fixtureId: "ui:app-bottom-excluded-provider-picker-session-capture-or-prompt-state",
      expectedEffect: `BUILDING: ${appBottomBlocker}.`,
      oracleId: surface.driverFamily === "toggle"
        ? "ui:boolean-state-transition"
        : `ui:activation:${oracleSegment(surface.name)}:building-blocker`,
      cleanupId: "ui:not-invoked",
    };
  }
  const family = surface.driverFamily as ReleaseUiInteractionFamily | undefined;
  if (!family) throw new Error(`${surface.id} does not declare a UI interaction family`);
  const oracleId = family === "activation"
    ? `ui:activation:surface-${createHash("sha256").update(surface.id).digest("hex").slice(0, 16)}:semantic-effect`
    : {
      selection: "ui:selection-state-transition",
      disclosure: "ui:disclosure-state-transition",
      toggle: "ui:boolean-state-transition",
      "text-entry": "ui:value-state-transition",
      choice: "ui:choice-state-transition",
      range: "ui:range-state-transition",
      "file-picker": "ui:file-attachment-transition",
    }[family];
  const connectionBlocker = connectionLifecycleBuildingBlockers.get(surface.id);
  if (connectionBlocker) {
    return {
      ...common,
      fixtureId: "ui:connection-excluded-probe-vault-or-active-target-path",
      expectedEffect: `BUILDING: ${connectionBlocker}.`,
      oracleId,
      cleanupId: "ui:not-invoked",
    };
  }
  return {
    ...common,
    fixtureId: `ui:${family}:owned-opposite-baseline`,
    expectedEffect: `Native ${family} control ${surface.name} reaches its typed owner and backing-state effect from an owned opposite baseline.`,
    oracleId,
    cleanupId: family === "file-picker"
      ? "ui:remove-owned-attachment-and-restore-baseline"
      : "ui:restore-owned-opposite-baseline",
  };
}

function backlogDriverId(kind: ReleaseSurfaceKind): string {
  return `${kind}${BACKLOG_SUFFIX}`;
}

function isBacklogDriverId(value: string): boolean {
  return value.endsWith(BACKLOG_SUFFIX);
}

function oracleSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || "surface";
}
