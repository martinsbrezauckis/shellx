import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import { releaseSurfaceControllerBindingFixture, releaseSurfaceFixtureSourceCommit, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { UI_CONTROL_INSTALLED_CONTROLLER_FILES } from "./release-drivers/ui-control-installed-manifest";
import {
  UI_CONTROL_BOUNDED_INSTALLED_DRIVER_ID,
  supportsBoundedInstalledUiControl,
} from "./release-drivers/ui-control-bounded-installed-assignments";
import "./test-browser-disclosure-accessibility";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-control-webdriver-"));
const profileRoot = join(temp, `shellx-final-webdriver-${"c".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-control-native-webdriver-token-0001";
const sessionId = "fixture-ui-control-session-0001";
const instanceId = "fixture-ui-control-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const remoteCwdControls = [
  { selector: "remote-cwd-close", occurrence: 1, elementTag: "button", driverFamily: "activation" },
  { selector: "remote-cwd-input", occurrence: 2, elementTag: "input", driverFamily: "text-entry" },
  { selector: "remote-cwd-go", occurrence: 3, elementTag: "button", driverFamily: "activation" },
  { selector: "remote-cwd-up", occurrence: 5, elementTag: "button", driverFamily: "activation" },
  { selector: "remote-cwd-parent", occurrence: 6, elementTag: "button", driverFamily: "activation" },
  { selector: "remote-cwd-parent", occurrence: 7, elementTag: "button", driverFamily: "activation" },
  { selector: "remote-cwd-folder", occurrence: 8, elementTag: "button", driverFamily: "activation" },
] as const;
const settingsTabs = [
  "general",
  "vault",
  "connections",
  "connectors",
  "desktop",
  "shellxagent",
  "data",
  "about",
] as const;
const workPreviewKinds = ["auto", "static", "web", "expo"] as const;
const workPreviewRunningControls = [
  { id: "open", occurrence: 2, fixtureId: "ui:work-preview-owned-running-project", oracleId: "ui:activation:work-preview-center-opened", cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab", driverFamily: "activation" },
  { id: "restart", occurrence: 4, fixtureId: "ui:work-preview-owned-running-project", oracleId: "ui:activation:work-preview-restarted", cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab", driverFamily: "activation" },
  { id: "stop", occurrence: 5, fixtureId: "ui:work-preview-owned-running-project", oracleId: "ui:activation:work-preview-stopped", cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab", driverFamily: "activation" },
  { id: "log-height-toggle", occurrence: 15, fixtureId: "ui:work-preview-log-default-baseline", oracleId: "ui:activation:work-preview-log-height-transition", cleanupId: "ui:restore-work-preview-log-height-and-right-rail", driverFamily: "activation" },
  { id: "viewport-phone", occurrence: 16, fixtureId: "ui:work-preview-owned-running-project", oracleId: "ui:selection-state-transition", cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab", driverFamily: "selection" },
  { id: "viewport-tablet", occurrence: 17, fixtureId: "ui:work-preview-owned-running-project", oracleId: "ui:selection-state-transition", cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab", driverFamily: "selection" },
  { id: "viewport-desktop", occurrence: 18, fixtureId: "ui:work-preview-owned-running-project", oracleId: "ui:selection-state-transition", cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab", driverFamily: "selection" },
  { id: "frame-reload", occurrence: 21, fixtureId: "ui:work-preview-owned-running-project", oracleId: "ui:activation:work-preview-frame-reloaded", cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab", driverFamily: "activation" },
  { id: "panel-open-external", occurrence: 14, fixtureId: "ui:work-preview-owned-running-project", oracleId: "ui:activation:work-preview-external-handoff", cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab", driverFamily: "activation" },
  { id: "stage-open-external", occurrence: 23, fixtureId: "ui:work-preview-owned-running-project", oracleId: "ui:activation:work-preview-external-handoff", cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab", driverFamily: "activation" },
] as const;
const workPreviewSafeControls = [
  { source: "src/components/WorkPreviewPanel.tsx", id: "work-preview-refresh-state", occurrence: 1, fixtureId: "ui:work-preview-owned-refresh", oracleId: "ui:activation:work-preview-state-refreshed", cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab", driverFamily: "activation" },
  { source: "src/components/WorkPreviewPanel.tsx", id: "work-preview-doctor", occurrence: 7, fixtureId: "ui:work-preview-owned-doctor", oracleId: "ui:activation:work-preview-doctor-result", cleanupId: "ui:delete-doctor-screenshot-stop-refresh-delete-project-and-restore-tab", driverFamily: "activation" },
  { source: "src/components/PreviewCenter.tsx", id: "preview-center-file-mode", occurrence: 3, fixtureId: "ui:preview-center-owned-file-and-work", oracleId: "ui:selection-state-transition", cleanupId: "ui:close-clear-preview-stop-refresh-delete-files-and-restore-tab", driverFamily: "selection" },
  { source: "src/components/PreviewCenter.tsx", id: "preview-center-work-mode", occurrence: 4, fixtureId: "ui:preview-center-owned-file-and-work", oracleId: "ui:selection-state-transition", cleanupId: "ui:close-clear-preview-stop-refresh-delete-files-and-restore-tab", driverFamily: "selection" },
] as const;
const filePreviewModeControls = [
  { name: "Code", occurrence: 2, mode: "code" },
  { name: "Safe render", occurrence: 3, mode: "safe" },
] as const;
const filePreviewRunControls = [
  { id: "file-preview-run-work", occurrence: 4 },
] as const;
const setupGuideControls = [
  { id: "agents", oracleId: "ui:activation:setup-guide-agent-cli-setup-opened" },
  { id: "browser", oracleId: "ui:activation:setup-guide-browser-opened" },
  { id: "downloads", oracleId: "ui:activation:setup-guide-download-settings-opened" },
  { id: "requests", oracleId: "ui:activation:setup-guide-requests-opened" },
  { id: "vault", oracleId: "ui:activation:setup-guide-vault-opened" },
  { id: "dismiss", oracleId: "ui:activation:setup-guide-dismissed" },
] as const;
const activitySearchClearControl = {
  occurrence: 9,
  selector: "[data-debug-id=\"activity-search-clear\"]",
} as const;
const browserRightTabs = ["chat", "requests", "actions", "evidence", "errors"] as const;
const activityViews = ["files", "graph", "evidence", "timeline", "summary"] as const;
const vaultWorkspaceTabs = ["secrets", "grants", "setup"] as const;
const vaultResourceFormTabs = ["secret", "profileCard", "stripeAgentWallet"] as const;
const vaultRequestQuickActions = [
  {
    id: "open-vault",
    occurrence: 2,
    oracleId: "ui:activation:vault-workspace-opened",
    expectedEffect: "opens the visible Vault workspace and dismisses the Request Center",
  },
  {
    id: "new-secret",
    occurrence: 3,
    oracleId: "ui:activation:vault-new-secret-state",
    expectedEffect: "opens the Vault workspace with Secrets and the secret editor selected",
  },
  {
    id: "generate-password",
    occurrence: 4,
    oracleId: "ui:activation:vault-password-generator-opened",
    expectedEffect: "replaces the Request Center body with its visible password generator",
  },
] as const;
const connectorSearchControl = {
  source: "src/components/ConnectorInboxModal.tsx",
  inventorySelector: "[data-debug-id=\"connector-inbox-search-input\"]",
  occurrence: 5,
} as const;
const additionalOwnedModalTextControls = [
  {
    source: "src/components/ActivityBrowserModal.tsx",
    inventorySelector: "[data-debug-id=\"activity-search\"]",
    occurrence: 7,
    elementTag: "input",
    label: "Activity Browser search",
  },
  {
    source: "src/components/ConnectorInboxModal.tsx",
    inventorySelector: "[data-debug-id=\"connector-inbox-date-input\"]",
    occurrence: 6,
    elementTag: "input",
    label: "Connector Inbox date",
  },
] as const;
const prTextControls = [
  {
    inventorySelector: "[data-debug-id=\"pr-base-input\"]",
    occurrence: 3,
    elementTag: "input",
    label: "pull-request base branch draft",
  },
  {
    inventorySelector: "[data-debug-id=\"pr-title-input\"]",
    occurrence: 4,
    elementTag: "input",
    label: "pull-request title draft",
  },
  {
    inventorySelector: "[data-debug-id=\"pr-body-input\"]",
    occurrence: 5,
    elementTag: "textarea",
    label: "pull-request body draft",
  },
] as const;
const prApprovalControl = {
  inventorySelector: "[data-debug-id=\"surface-components-prcreatemodal-8\"]",
  webdriverSelector: "[data-debug-id='surface-components-prcreatemodal-8']",
  occurrence: 8,
} as const;
const prLocalControls = [
  {
    inventorySelector: "role=button;name=\"Draft\"",
    webdriverSelector: ".pr-modal .settings-pills > button:first-child",
    occurrence: 6,
    fixtureId: "ui:pr-modal-local-option-baseline",
    oracleId: "ui:boolean-state-transition",
    cleanupId: "ui:restore-pr-local-option-and-close",
    label: "Draft option",
  },
  {
    inventorySelector: "role=button;name=\"Cancel\"",
    webdriverSelector: ".pr-modal .hardcap-buttons > button:first-child",
    occurrence: 9,
    fixtureId: "ui:pr-modal-open",
    oracleId: "ui:activation:owned-modal-closed",
    cleanupId: "ui:close-owned-modal",
    label: "Cancel action",
  },
] as const;
const connectorInboxLocalControls = [
  {
    inventorySelector: "[data-debug-id=\"surface-components-connectorinboxmodal-4\"]",
    occurrence: 4,
    fixtureId: "ui:connector-inbox-manual-refresh-baseline",
    oracleId: "ui:activation:connector-inbox-manual-refresh",
    cleanupId: "ui:reset-connector-inbox-refresh-receipt-and-close",
    label: "Refresh",
  },
  {
    inventorySelector: "[data-debug-id=\"surface-components-connectorinboxmodal-9\"]",
    occurrence: 9,
    fixtureId: "ui:connector-inbox-filter-baseline",
    oracleId: "ui:selection-state-transition",
    cleanupId: "ui:restore-connector-inbox-filter-and-close",
    label: "provider tabs",
  },
  {
    inventorySelector: "role=button;name=\"Clear\"",
    occurrence: 7,
    fixtureId: "ui:connector-inbox-active-filters",
    oracleId: "ui:activation:connector-inbox-filters-cleared",
    cleanupId: "ui:restore-connector-inbox-filter-and-close",
    label: "Clear filters",
  },
  {
    inventorySelector: "role=button;name=\"Connectors settings\"",
    occurrence: 8,
    fixtureId: "ui:connector-inbox-open",
    oracleId: "ui:activation:connector-settings-opened",
    cleanupId: "ui:restore-settings-tab-and-close",
    label: "Connectors settings",
  },
] as const;
const connectorDraftLifecycleControls = [
  {
    inventorySelector: "role=button;name=\"New\"",
    occurrence: 2,
    fixtureId: "ui:connectors-draft-closed",
    oracleId: "ui:activation:connectors-draft-opened",
    expectedEffect: "opens a new unsaved Connector draft with the exact bounded default state before deterministic cancellation",
  },
  {
    inventorySelector: "[aria-label=\"Cancel connector draft\"]",
    occurrence: 22,
    fixtureId: "ui:connectors-unsaved-draft-open",
    oracleId: "ui:activation:connectors-draft-closed",
    expectedEffect: "cancels an unsaved Connector draft and discards its bounded local text without saving",
  },
] as const;
const connectorDraftControls = [
  {
    inventorySelector: "[data-debug-id=\"surface-components-settings-connectorstab-3\"]",
    occurrence: 3,
    elementTag: "button",
    driverFamily: "selection",
    oracleId: "ui:selection-state-transition",
    expectedEffect: "changes only the unsaved connector provider draft before exact restoration",
  },
  {
    inventorySelector: "role=button;name=\"Paused\"",
    occurrence: 4,
    elementTag: "button",
    driverFamily: "activation",
    oracleId: "ui:boolean-state-transition",
    expectedEffect: "prepares Live and selects Paused only in the unsaved connector draft before exact restoration",
  },
  {
    inventorySelector: "role=button;name=\"Live\"",
    occurrence: 5,
    elementTag: "button",
    driverFamily: "activation",
    oracleId: "ui:boolean-state-transition",
    expectedEffect: "selects Live only in the unsaved connector draft before exact restoration",
  },
  {
    inventorySelector: "role=button;name=\"Inbox\"",
    occurrence: 6,
    elementTag: "button",
    driverFamily: "activation",
    oracleId: "ui:boolean-state-transition",
    expectedEffect: "prepares Session chat and selects Inbox only in the unsaved connector draft before exact restoration",
  },
  {
    inventorySelector: "[title^=\"Send allowlisted \"][title$=\" messages to the active session\"]",
    occurrence: 7,
    elementTag: "button",
    driverFamily: "activation",
    oracleId: "ui:boolean-state-transition",
    expectedEffect: "selects Session chat only in the unsaved connector draft before exact restoration",
  },
  {
    inventorySelector: "[data-debug-id=\"connector-approval-review-first\"]",
    occurrence: 8,
    elementTag: "button",
    driverFamily: "toggle",
    oracleId: "ui:boolean-state-transition",
    expectedEffect: "prepares Auto-dispatch and selects Review first only in the unsaved connector draft before exact restoration",
  },
  {
    inventorySelector: "[data-debug-id=\"connector-approval-auto-dispatch\"]",
    occurrence: 9,
    elementTag: "button",
    driverFamily: "toggle",
    oracleId: "ui:boolean-state-transition",
    expectedEffect: "selects Auto-dispatch only in the unsaved connector draft before exact restoration",
  },
  {
    inventorySelector: "[data-debug-id=\"surface-components-settings-connectorstab-21\"]",
    occurrence: 21,
    elementTag: "input",
    driverFamily: "text-entry",
    oracleId: "ui:value-state-transition",
    expectedEffect: "changes only the unsaved connector Vault key reference without retaining it",
  },
  {
    inventorySelector: "[id=\"connector-allowed\"]",
    occurrence: 9,
    elementTag: "input",
    driverFamily: "text-entry",
    oracleId: "ui:value-state-transition",
    expectedEffect: "changes only the unsaved connector allowlist without retaining it",
  },
  {
    inventorySelector: "[id=\"connector-target\"]",
    occurrence: 10,
    elementTag: "select",
    driverFamily: "choice",
    oracleId: "ui:choice-state-transition",
    expectedEffect: "changes only the unsaved connector target mode without selecting a tab identifier",
  },
  {
    inventorySelector: "[id=\"connector-sim-sender\"]",
    occurrence: 14,
    elementTag: "input",
    driverFamily: "text-entry",
    oracleId: "ui:value-state-transition",
    expectedEffect: "changes only the unsaved inbound-simulator sender without retaining it or simulating a message",
  },
  {
    inventorySelector: "[id=\"connector-sim-conversation\"]",
    occurrence: 15,
    elementTag: "input",
    driverFamily: "text-entry",
    oracleId: "ui:value-state-transition",
    expectedEffect: "changes only the unsaved inbound-simulator conversation without retaining it or simulating a message",
  },
  {
    inventorySelector: "[id=\"connector-sim-text\"]",
    occurrence: 16,
    elementTag: "input",
    driverFamily: "text-entry",
    oracleId: "ui:value-state-transition",
    expectedEffect: "changes only the unsaved inbound-simulator message without retaining it or simulating a message",
  },
] as const;
const shellxToolExposureControl = {
  inventorySelector: "[data-debug-id=\"surface-components-rightrail-2\"]",
  occurrence: 2,
} as const;
const rightRailGoalControls = [
  {
    inventorySelector: "[title=\"Open the focused plan review dialog.\"]",
    occurrence: 12,
    fixtureId: "ui:right-rail-owned-goal-awaiting-review",
    oracleId: "ui:activation:right-rail-goal-review-opened",
    expectedEffect: "reopens the exact ready Goal review dialog after its automatic presentation is deliberately dismissed",
  },
  {
    inventorySelector: ":is([title=\"Pause auto-continuation (only user can pause)\"],[title=\"Resume auto-continuation\"])",
    occurrence: 13,
    fixtureId: "ui:right-rail-owned-goal-active",
    oracleId: "ui:activation:right-rail-goal-pause-resume-transition",
    expectedEffect: "pauses and resumes the exact owned active Goal",
  },
  {
    inventorySelector: "[title=\"Mark build as complete — stops the auto-continuation loop. Use when the agent finished but did not call the completion tool itself.\"]",
    occurrence: 14,
    fixtureId: "ui:right-rail-owned-goal-active",
    oracleId: "ui:activation:right-rail-goal-completed",
    expectedEffect: "marks the exact owned active Goal complete after trusted confirmation",
  },
] as const;
const filesPaneControls = [
  {
    inventorySelector: ":is([title=\"Attach handler unavailable\"],[title=\"Attach selected files to the composer\"])",
    occurrence: 2,
    oracleId: "ui:activation:files-pane-selected-attached",
    expectedEffect: "selects and attaches exactly one owned in-scope text file, then clears its FilesPane selection",
  },
  {
    inventorySelector: "[aria-label^=\"Attach \"]",
    occurrence: 8,
    oracleId: "ui:activation:files-pane-row-attached",
    expectedEffect: "attaches exactly one owned in-scope row file without selecting or copying it",
  },
  {
    inventorySelector: "[aria-label^=\"Remove \"]",
    occurrence: 6,
    oracleId: "ui:activation:files-pane-selection-removed",
    expectedEffect: "removes exactly one owned file from the FilesPane selection",
  },
  {
    inventorySelector: "[aria-label=\"Clear selected files\"]",
    occurrence: 3,
    oracleId: "ui:activation:files-pane-selection-cleared",
    expectedEffect: "clears the exact one-file FilesPane selection",
  },
  {
    inventorySelector: "[data-debug-id=\"surface-components-filespane-7\"]",
    occurrence: 7,
    oracleId: "ui:activation:files-pane-row-navigation-preview",
    expectedEffect: "opens the owned child directory and then read-only Preview Center for its exact nested file",
  },
  {
    inventorySelector: "[aria-label=\"Back to session folder\"]",
    occurrence: 5,
    oracleId: "ui:activation:files-pane-session-folder-restored",
    expectedEffect: "returns from the owned child directory to the exact session folder",
  },
  {
    inventorySelector: "[aria-label=\"Up one level\"]",
    occurrence: 4,
    oracleId: "ui:activation:files-pane-parent-opened",
    expectedEffect: "opens exactly the owned session folder's parent",
  },
] as const;
const rightRailTextControls = [
  {
    source: "src/components/TasksPanel.tsx",
    inventorySelector: "[data-debug-id=\"tasks-filter-input\"]",
    occurrence: 7,
    label: "Tasks filter",
  },
  {
    source: "src/components/FilesPane.tsx",
    inventorySelector: "[data-debug-id=\"files-search-input\"]",
    occurrence: 1,
    label: "Files search",
  },
] as const;
const tasksToggleControls = [
  {
    inventorySelector: "[data-debug-id=\"tasks-show-all-tabs-checkbox\"]",
    webdriverSelector: "[data-debug-id='tasks-show-all-tabs-checkbox']",
    occurrence: 5,
    label: "Tasks all-tabs filter",
  },
  {
    inventorySelector: "[data-debug-id=\"tasks-show-completed-checkbox\"]",
    webdriverSelector: "[data-debug-id='tasks-show-completed-checkbox']",
    occurrence: 6,
    label: "Tasks completed filter",
  },
] as const;
const commandPaletteInputControl = {
  source: "src/components/CommandPalette.tsx",
  inventorySelector: "[data-debug-id=\"command-palette-input\"]",
  occurrence: 3,
} as const;
const alwaysVisibleTextControls = [
  {
    source: "src/components/FindPopover.tsx",
    inventorySelector: "[data-debug-id=\"find-sessions-input\"]",
    occurrence: 2,
    elementTag: "input",
    label: "session finder",
  },
  {
    source: "src/components/BottomPanel.tsx",
    inventorySelector: "[data-debug-id=\"composer-prompt\"]",
    occurrence: 14,
    elementTag: "textarea",
    label: "composer",
  },
] as const;
const findPopoverFocusControl = {
  source: "src/components/FindPopover.tsx",
  inventorySelector: "[data-debug-id=\"surface-components-findpopover-1\"]",
  webdriverSelector: "[data-debug-id='surface-components-findpopover-1']",
  occurrence: 1,
} as const;
const findOpenRowControl = {
  source: "src/components/FindPopover.tsx",
  inventorySelector: "[data-debug-id=\"surface-components-findpopover-3\"]",
  webdriverSelector: "[data-debug-id='surface-components-findpopover-3']",
  occurrence: 3,
} as const;
const findDiskRowControl = {
  source: "src/components/FindPopover.tsx",
  inventorySelector: "[data-debug-id=\"surface-components-findpopover-4\"]",
  webdriverSelector: "[data-debug-id='surface-components-findpopover-4']",
  occurrence: 4,
} as const;
const settingsDownloadFolderControl = {
  source: "src/components/settings/GeneralTab.tsx",
  inventorySelector: "[data-debug-id=\"settings-browser-download-folder\"]",
  occurrence: 7,
} as const;
const browserDownloadFolderControl = {
  source: "src/browser/components/DownloadSidecar.tsx",
  inventorySelector: "[data-debug-id=\"shellx-browser-download-folder\"]",
  occurrence: 2,
} as const;
const browserRightSidebarToggleControl = {
  source: "src/browser/components/BrowserMenus.tsx",
  inventorySelector: "[data-debug-id=\"shellx-browser-toggle-right-sidebar\"]",
  occurrence: 5,
} as const;
const browserSidebarVisibilityControls = [
  {
    source: "src/browser/components/AgentSidebar.tsx",
    inventorySelector: "[data-debug-id=\"shellx-browser-toggle-right-sidebar-button\"]",
    webdriverSelector: "[data-debug-id='shellx-browser-toggle-right-sidebar-button']",
    occurrence: 2,
    targetVisible: false,
  },
  {
    source: "src/browser/components/BrowserChrome.tsx",
    inventorySelector: "[data-debug-id=\"shellx-browser-show-right-sidebar-button\"]",
    webdriverSelector: "[data-debug-id='shellx-browser-show-right-sidebar-button']",
    occurrence: 9,
    targetVisible: true,
  },
] as const;
const browserSidebarResizeControl = {
  source: "src/browser/components/AgentSidebar.tsx",
  inventorySelector: "[data-debug-id=\"shellx-browser-sidebar-resize\"]",
  webdriverSelector: "[data-debug-id='shellx-browser-sidebar-resize']",
  occurrence: 1,
} as const;
const browserHomepageControl = {
  source: "src/browser/components/BrowserMenus.tsx",
  inventorySelector: "[data-debug-id=\"shellx-browser-homepage\"]",
  occurrence: 3,
} as const;
const browserColorModeControl = {
  source: "src/browser/components/BrowserMenus.tsx",
  inventorySelector: "[data-debug-id=\"shellx-browser-color-mode\"]",
  occurrence: 2,
} as const;
const browserParallelAgentsControl = {
  source: "src/browser/components/BrowserMenus.tsx",
  inventorySelector: "[data-debug-id=\"shellx-browser-parallel-agents\"]",
  occurrence: 16,
} as const;
const browserProfileControl = {
  source: "src/browser/components/BrowserMenus.tsx",
  inventorySelector: "[data-debug-id=\"shellx-browser-profile-select\"]",
  occurrence: 4,
} as const;
const browserHistoryFilterControls = [
  {
    id: "history-search",
    occurrence: 4,
    elementTag: "input",
    driverFamily: "text-entry",
    oracleId: "ui:value-state-transition",
  },
  {
    id: "history-date-filter",
    occurrence: 5,
    elementTag: "select",
    driverFamily: "selection",
    oracleId: "ui:choice-state-transition",
  },
  {
    id: "history-user",
    occurrence: 2,
    elementTag: "button",
    driverFamily: "activation",
    oracleId: "ui:boolean-state-transition",
  },
  {
    id: "history-agent",
    occurrence: 3,
    elementTag: "button",
    driverFamily: "activation",
    oracleId: "ui:boolean-state-transition",
  },
] as const;
const browserBookmarkModeControls = [
  {
    id: "bookmark-list-mode",
    occurrence: 9,
    targetManageMode: false,
  },
  {
    id: "bookmark-manager-toggle",
    occurrence: 10,
    targetManageMode: true,
  },
] as const;
const browserBookmarkDraftTextControls = [
  {
    id: "bookmark-draft-label",
    occurrence: 11,
    label: "bookmark draft name",
  },
  {
    id: "bookmark-draft-url",
    occurrence: 12,
    label: "bookmark draft URL",
  },
] as const;
const browserTransientTextControls = [
  {
    source: "src/browser/components/BrowserChrome.tsx",
    id: "address",
    occurrence: 15,
    elementTag: "input",
    label: "Browser address draft",
  },
  {
    source: "src/browser/components/AgentSidebar.tsx",
    id: "goal",
    occurrence: 9,
    elementTag: "textarea",
    label: "Browser agent message draft",
  },
] as const;
const vaultPasswordGeneratorLocalControls = [
  {
    inventorySelector: "[data-debug-id=\"surface-components-vaultpasswordgenerator-5\"]",
    webdriverSelector: "[data-debug-id='surface-components-vaultpasswordgenerator-5']",
    occurrence: 5,
    elementTag: "input",
    driverFamily: "range",
    oracleId: "ui:range-state-transition",
    label: "password length slider",
  },
  {
    inventorySelector: "[data-debug-id=\"vault-password-generator-length\"]",
    webdriverSelector: "[data-debug-id='vault-password-generator-length']",
    occurrence: 6,
    elementTag: "input",
    driverFamily: "text-entry",
    oracleId: "ui:value-state-transition",
    label: "password numeric length",
  },
  {
    inventorySelector: "[data-debug-id=\"surface-components-vaultpasswordgenerator-11\"]",
    webdriverSelector: "[data-debug-id='surface-components-vaultpasswordgenerator-11']",
    occurrence: 11,
    elementTag: "input",
    driverFamily: "toggle",
    oracleId: "ui:boolean-state-transition",
    label: "lowercase character set",
  },
  {
    inventorySelector: ":is([aria-label=\"Hide generated password\"],[aria-label=\"Reveal generated password\"])",
    webdriverSelector: ":is([aria-label='Hide generated password'],[aria-label='Reveal generated password'])",
    occurrence: 3,
    elementTag: "button",
    driverFamily: "activation",
    oracleId: "ui:activation:vault-password-reveal-transition",
    label: "generated-password visibility",
  },
] as const;
const browserTaskControls = [
  { id: "agent-pause", occurrence: 11, precondition: "running", target: "paused" },
  { id: "agent-resume", occurrence: 12, precondition: "paused", target: "running" },
  { id: "agent-takeover", occurrence: 13, precondition: "running", target: "userTakeover" },
  { id: "agent-abort", occurrence: 14, precondition: "running", target: "aborted" },
  { id: "complete", occurrence: 16, precondition: "running", target: "completed" },
  { id: "block", occurrence: 17, precondition: "running", target: "blocked" },
] as const;
const browserDisclosures = [
  { id: "trust-chip", source: "src/browser/components/BrowserChrome.tsx", occurrence: 14 },
  { id: "downloads-menu", source: "src/browser/components/BrowserChrome.tsx", occurrence: 19 },
  { id: "bookmarks-menu", source: "src/browser/components/BrowserChrome.tsx", occurrence: 20 },
  { id: "history-menu", source: "src/browser/components/BrowserChrome.tsx", occurrence: 21 },
  { id: "save-page", source: "src/browser/components/BrowserChrome.tsx", occurrence: 22 },
  { id: "ad-filter", source: "src/browser/components/BrowserChrome.tsx", occurrence: 23 },
  { id: "options", source: "src/browser/components/BrowserChrome.tsx", occurrence: 24 },
  { id: "collapse-tasks", source: "src/browser/components/AgentSidebar.tsx", occurrence: 15 },
  { id: "collapse-receipts", source: "src/browser/components/AgentSidebar.tsx", occurrence: 18 },
  { id: "collapse-console", source: "src/browser/components/AgentSidebar.tsx", occurrence: 19 },
] as const;
const browserShieldsControls = [
  { id: "shellx-browser-shields-global-enabled", occurrence: 1, elementTag: "input", driverFamily: "toggle", oracleId: "ui:boolean-state-transition" },
  { id: "shellx-browser-site-shields-ad-trackers", occurrence: 2, elementTag: "select", driverFamily: "selection", oracleId: "ui:choice-state-transition" },
  { id: "surface-browser-components-browsershieldspanel-3", occurrence: 3, elementTag: "select", driverFamily: "selection", oracleId: "ui:choice-state-transition" },
  { id: "surface-browser-components-browsershieldspanel-4", occurrence: 4, elementTag: "select", driverFamily: "selection", oracleId: "ui:choice-state-transition" },
  { id: "surface-browser-components-browsershieldspanel-5", occurrence: 5, elementTag: "input", driverFamily: "toggle", oracleId: "ui:boolean-state-transition" },
  { id: "shellx-browser-site-shields-script-blocking", occurrence: 6, elementTag: "input", driverFamily: "toggle", oracleId: "ui:boolean-state-transition" },
  { id: "shellx-browser-site-shields-save", occurrence: 7, elementTag: "button", driverFamily: "activation", oracleId: "ui:activation:browser-site-shields-override-transition" },
  { id: "shellx-browser-site-shields-reset", occurrence: 8, elementTag: "button", driverFamily: "activation", oracleId: "ui:activation:browser-site-shields-override-transition" },
] as const;
const browserAdModeControls = [
  { id: "shellx-browser-ad-mode-default", occurrence: 19, action: "default" },
  { id: "shellx-browser-ad-mode-balanced", occurrence: 20, action: "balanced" },
  { id: "shellx-browser-ad-mode-strict", occurrence: 21, action: "strict" },
  { id: "shellx-browser-ad-mode-off", occurrence: 22, action: "off" },
] as const;
const browserPersonalLockControls = [
  { id: "shellx-browser-personal-lock-timeout", occurrence: 8, elementTag: "select", driverFamily: "selection", oracleId: "ui:choice-state-transition" },
  { id: "shellx-browser-personal-lock-auth-mode", occurrence: 9, elementTag: "select", driverFamily: "selection", oracleId: "ui:choice-state-transition" },
  { id: "shellx-browser-personal-lock-pin", occurrence: 10, elementTag: "input", driverFamily: "text-entry", oracleId: "ui:value-state-transition" },
] as const;
const browserPersonalLockOpenControl = {
  id: "shellx-browser-personal-lock-toggle",
  occurrence: 6,
} as const;
const browserDisclosureCloses = [
  {
    id: "downloads-close",
    source: "src/browser/components/DownloadSidecar.tsx",
    occurrence: 1,
    owner: "downloads-menu",
    oracleId: "ui:activation:browser-downloads-closed",
  },
  {
    id: "bookmark-manager-close",
    source: "src/browser/components/BookmarkSidecar.tsx",
    occurrence: 8,
    owner: "bookmarks-menu",
    oracleId: "ui:activation:browser-bookmarks-closed",
  },
  {
    id: "history-close",
    source: "src/browser/components/BrowserHistorySidecar.tsx",
    occurrence: 1,
    owner: "history-menu",
    oracleId: "ui:activation:browser-history-closed",
  },
  {
    id: "options-close",
    source: "src/browser/components/BrowserMenus.tsx",
    occurrence: 1,
    owner: "options",
    oracleId: "ui:activation:browser-options-closed",
  },
] as const;
let fixture: ChildProcess | null = null;
const terminateOwnedFixture = (): void => {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  rmSync(temp, { recursive: true, force: true });
};
const onTerminationSignal = (): never => {
  terminateOwnedFixture();
  process.exit(143);
};
process.once("SIGINT", onTerminationSignal);
process.once("SIGTERM", onTerminationSignal);

try {
  mkdirSync(shellxHome, { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-ui-control-webdriver-server-fixture.ts"),
    "--state-out", statePath,
    "--token", token,
    "--session-id", sessionId,
    "--instance-id", instanceId,
    "--process-id", "4321",
    "--version", releaseSurfaceFixtureVersion,
    "--source-commit", sourceCommit,
    "--profile-root", profileRoot,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, fixture);
  const candidateBase = `http://127.0.0.1:${ports.candidatePort}`;
  const webdriverBase = `http://127.0.0.1:${ports.webdriverPort}`;

  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as { invocationTransport?: string; supportedOracles?: string[] };
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.supportedOracles, [
    "ui:selection-state-transition",
    "ui:choice-state-transition",
    "ui:disclosure-state-transition",
    "ui:boolean-state-transition",
    "ui:activation:browser-flight-recorder-identity",
    "ui:activation:browser-evidence-manual-refresh",
    "ui:activation:shellx-browser-window",
    "ui:activation:vault-workspace-opened",
    "ui:activation:vault-new-secret-state",
    "ui:activation:vault-password-generator-opened",
    "ui:activation:vault-password-generator-closed",
    "ui:activation:browser-downloads-closed",
    "ui:activation:browser-bookmarks-closed",
    "ui:activation:browser-history-closed",
    "ui:activation:browser-options-closed",
    "ui:activation:browser-sidebar-visibility-transition",
    "ui:activation:browser-sidebar-width-transition",
    "ui:activation:vault-password-reveal-transition",
    "ui:activation:browser-task-status-transition",
    "ui:activation:owned-modal-closed",
    "ui:boolean-state-transition",
    "ui:activation:connector-inbox-filters-cleared",
    "ui:activation:connector-inbox-manual-refresh",
    "ui:activation:connector-settings-opened",
    "ui:value-state-transition",
    "ui:activation:session-finder-focused",
    "ui:activation:activity-search-cleared",
    "ui:activation:settings-opened-from-command-palette",
    "ui:activation:vault-recovery-kit-created",
    "ui:activation:vault-recovery-confirmed",
    "ui:activation:vault-change-setup-opened",
    "ui:activation:vault-unlocked",
    "ui:activation:vault-locked",
    "ui:activation:vault-remembered-device-enabled",
    "ui:activation:vault-remembered-device-disabled",
    "ui:activation:vault-grants-refreshed",
    "ui:activation:vault-grant-revoked",
    "ui:activation:vault-owned-directory-reloaded",
    "ui:activation:vault-owned-notice-dismissed",
    "ui:activation:vault-owned-reveal-hidden",
    "ui:activation:vault-owned-metadata-transition",
    "ui:activation:vault-owned-replacement-transition",
    "ui:activation:vault-owned-secret-deleted",
    "ui:activation:vault-new-secret-value-visibility",
    "ui:activation:vault-new-secret-generator-opened",
    "ui:activation:vault-owned-resource-saved",
    "ui:activation:vault-generator-regenerated",
    "ui:activation:vault-generator-used",
    "ui:activation:vault-generator-cleared",
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
    "ui:activation:find-owned-session-new-tab",
    "ui:activation:file-preview-work-preview-lifecycle",
    "ui:activation:owned-attachment-preview",
    "ui:activation:owned-attachment-removed",
    "ui:activation:owned-asset-imported",
    "ui:activation:owned-asset-attached",
    "ui:activation:owned-attachment-prompt-inserted",
    "ui:boolean-state-transition",
    "ui:activation:build-plan-review-dismissed",
    "ui:activation:shellxagent-token-file-rotated",
    "ui:activation:remote-cwd-path-transition",
    "ui:activation:setup-guide-vault-opened",
    "ui:activation:setup-guide-browser-opened",
    "ui:activation:setup-guide-download-settings-opened",
    "ui:activation:setup-guide-agent-cli-setup-opened",
    "ui:activation:setup-guide-requests-opened",
    "ui:activation:setup-guide-dismissed",
    "ui:value-state-transition",
    "ui:choice-state-transition",
    "ui:activation:owned-bookmark-pin-state-transition",
    "ui:activation:owned-bookmark-state-transition",
    "ui:activation:owned-bookmark-order-transition",
    "ui:activation:owned-browser-tab-state-transition",
    "ui:activation:owned-browser-tab-focus-transition",
    "ui:activation:owned-browser-home-navigation",
    "ui:activation:owned-browser-history-navigation",
    "ui:activation:owned-browser-tab-lock-transition",
    "ui:activation:owned-browser-tab-delegation-transition",
    "ui:activation:owned-browser-history-entry-navigation",
    "ui:activation:owned-browser-history-clear",
    "ui:value-state-transition",
    "ui:activation:browser-personal-lock-settings-opened",
    "ui:activation:browser-personal-lock-enabled",
    "ui:activation:browser-personal-lock-unlocked",
    "ui:activation:browser-personal-lock-pin-lifecycle",
    "ui:activation:owned-browser-bookmark-created",
    "ui:activation:owned-browser-bookmark-navigation",
    "ui:activation:work-preview-start-lifecycle",
    "ui:activation:work-preview-center-opened",
    "ui:activation:work-preview-restarted",
    "ui:activation:work-preview-stopped",
    "ui:activation:work-preview-frame-reloaded",
    "ui:activation:work-preview-log-height-transition",
    "ui:activation:work-preview-external-handoff",
    "ui:activation:browser-site-shields-override-transition",
    "ui:activation:right-rail-goal-review-opened",
    "ui:activation:right-rail-goal-pause-resume-transition",
    "ui:activation:right-rail-goal-completed",
    ...filesPaneControls.map((control) => control.oracleId),
    "ui:activation:goal-plan-review-dismissed",
    "ui:activation:goal-plan-review-edit-opened",
    "ui:activation:goal-plan-review-edit-cancelled",
    "ui:activation:goal-plan-review-owned-state-transition",
    "ui:boolean-state-transition",
    "ui:activation:build-run-cockpit-owned-state-transition",
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
    "ui:activation:owned-connector-edit-opened",
    "ui:activation:agent-runs-manual-refresh",
    "ui:activation:work-preview-state-refreshed",
    "ui:activation:work-preview-doctor-result",
  ]);

  const report = runDriver(request(candidateBase, webdriverBase));
  assert.equal(
    report.outcomes.length,
    1
      + 1
      + browserRightTabs.length
      + activityViews.length
      + 1
      + vaultWorkspaceTabs.length
      + vaultResourceFormTabs.length
      + browserDisclosures.length
      + browserShieldsControls.length
      + browserAdModeControls.length
      + browserPersonalLockControls.length
      + 1
      + browserDisclosureCloses.length
      + 19
      + 1
      + 2
      + additionalOwnedModalTextControls.length
      + prTextControls.length
      + 1
      + prLocalControls.length
      + connectorInboxLocalControls.length
      + connectorDraftLifecycleControls.length
      + connectorDraftControls.length
      + 1
      + rightRailGoalControls.length
      + filesPaneControls.length
      + 1
      + 3
      + browserSidebarVisibilityControls.length
      + 1
      + 4
      + browserHistoryFilterControls.length
      + browserBookmarkModeControls.length
      + browserBookmarkDraftTextControls.length
      + browserTransientTextControls.length
      + vaultPasswordGeneratorLocalControls.length
      + browserTaskControls.length
      + workPreviewKinds.length
      + workPreviewRunningControls.length
      + workPreviewSafeControls.length
      + filePreviewModeControls.length
      + filePreviewRunControls.length
      + setupGuideControls.length
      + 1
      + 1
      + 1
      + 1
      + 1
      + 1
      + 1
      + remoteCwdControls.length
      + 3,
  );
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && outcome.observedEffect.toLowerCase().includes("native webdriver")
  )));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    bottomTab: string;
    settingsOpen: boolean;
    settingsTab: string;
    setupGuideDismissed: boolean;
    pluginsOpen: boolean;
    theme: string;
    persistedTheme: string | null;
    rightTab: string;
    agentRunsManualRefreshSequence: number;
    agentRunsManualRefreshGeneratedAtMs: number | null;
    activeTab: Record<string, unknown>;
    previewStatus: string | null;
    previewUrl: string | null;
    renderedPreviewStatus: string | null;
    renderedPreviewUrl: string | null;
    previewStarts: number;
    previewRefreshes: number;
    previewCenterView: string;
    previewFilePath: string | null;
    doctorScreenshotExists: boolean;
    workPreviewKind: string;
    workPreviewViewport: string;
    workPreviewReloadSeq: number;
    workPreviewLogHeight: number;
    workPreviewLogHeightStored: string | null;
    browserRightTab: string;
    activeTaskId: string | null;
    browserTaskId: string | null;
    browserTaskTabId: string | null;
    activeTaskStatus: string;
    recorderIndex: number;
    currentWindow: string;
    browserWindowOpen: boolean;
    activityOpen: boolean;
    activityView: string;
    activityEvidenceFocused: string | null;
    composerPicker: string | null;
    keyboardHintOpen: boolean;
    vaultWorkspaceTab: string;
    vaultResourceFormTab: string;
    browserDisclosure: string | null;
    browserRightSidebarVisible: boolean;
    browserRightSidebarWidth: number;
    browserHomepageValue: string;
    browserHomepageStoredValue: string | null;
    browserColorMode: string;
    browserColorModeStoredValue: string | null;
    browserParallelAgents: string;
    browserProfileId: string;
    browserAutomationMode: string;
    browserPersonalLock: {
      enabled: boolean;
      locked: boolean;
      timeoutMinutes: number;
      authMode: string;
      pinConfigured: boolean;
      blurLockedTabs: boolean;
      pauseDelegatedTabsWhenLocked: boolean;
      lockOnSleep: boolean;
      lockOnMinimize: boolean;
    };
    browserPersonalLockPinDraft: string;
    browserActiveHost: string | null;
    browserShields: {
      enabled: boolean;
      siteOverrides: Array<Record<string, unknown>>;
    };
    browserProfileAdModes: Record<string, string>;
    browserHistorySearch: string;
    browserHistoryDateFilter: string;
    browserHistoryScope: string;
    browserBookmarkManageMode: boolean;
    browserBookmarkDraftLabel: string;
    browserBookmarkDraftUrl: string;
    browserAddressValue: string;
    browserGoalValue: string;
    vaultRequestCenterOpen: boolean;
    vaultWorkspaceModalOpen: boolean;
    vaultWorkspaceIntent: string | null;
    vaultPasswordGeneratorOpen: boolean;
    vaultPasswordLowercase: boolean;
    vaultPasswordRevealed: boolean;
    vaultPasswordLength: number;
    ownedModalOpen: string | null;
    previewTarget: Record<string, unknown> | null;
    activitySearchValue: string;
    connectorSearchValue: string;
    connectorDateValue: string;
    connectorFilter: string;
    connectorInboxManualRefreshSequence: number;
    connectorInboxManualRefreshCompletedAtMs: number | null;
    connectorInboxManualRefreshConnectorCount: number | null;
    connectorInboxManualRefreshEventCount: number | null;
    connectorInboxManualRefreshMaxEventMs: number | null;
    connectorDraftOpen: boolean;
    connectorProvider: string;
    connectorEnabled: boolean;
    connectorDispatchMode: string;
    connectorRequireApproval: boolean;
    connectorTargetMode: string;
    connectorVaultKey: string;
    connectorAllowedIds: string;
    connectorSimValues: Record<string, string>;
    prTextValues: Record<string, string>;
    prApprovalChecked: boolean;
    prDraftActive: boolean;
    prTranscriptActive: boolean;
    hashItemsFixtureActive: boolean;
    commandPaletteOpen: boolean;
    commandPaletteInputValue: string;
    findSessionsFocused: boolean;
    alwaysVisibleTextValues: Record<string, string>;
    rightRailTextValues: Record<string, string>;
    goalState: Record<string, unknown> | null;
    goalLastClear: Record<string, unknown> | null;
    goalReviewModalOpen: boolean;
    buildPlanFixtureActive: boolean;
    buildPlanReviewOpen: boolean;
    buildPlanUnsafeMutationCount: number;
    shellxagentFixtureActive: boolean;
    shellxagentRevealed: boolean;
    shellxagentUnsafeMutationCount: number;
    remoteCwdOpen: boolean;
    remoteCwdPath: string;
    remoteCwdDraft: string;
    remoteCwdUnsafeUseCount: number;
    remoteCwdIsolatedLaunchCount: number;
    pendingAlertText: string | null;
    attachmentMediaPendingPaths: string[];
    filesPaneSessionPath: string | null;
    filesPaneFolder: string;
    filesPaneSelected: boolean;
    buildRunCockpitFixtureActive: boolean;
    buildRunCockpitShowAllReceipts: boolean;
    inputClearCounts: Record<string, number>;
    taskToggleStates: Record<string, { checked: boolean; storageKey: string }>;
    taskToggleStorage: Record<string, string | null>;
    publicSettings: Record<string, unknown>;
    clickedSelectors: string[];
    neutralFocusClicks: number;
    aboutExternalUrls: string[];
    debugUiConnectionFixture: string;
    debugUiWebSocketActive: number;
    debugUiWebSocketGeneration: number;
    errorBoundaryOpen: boolean;
    errorBoundaryDocumentGeneration: number;
    rendererCrashEventCount: number;
    releaseTestExternalEffectBoundary: string | null;
    prCreateBoundaryReceipt: string | null;
    artifactArchiveReceipt: string | null;
  };
  assert.deepEqual(audit.clickedSelectors, [
    "[data-debug-id='tasks-agent-runs-refresh']",
    "[data-debug-id='surface-components-settings-shellxagenttab-1']",
    "[data-debug-id='surface-components-settings-shellxagenttab-1']",
    "[data-debug-id='remote-cwd-close']",
    "[data-debug-id='remote-cwd-go']",
    "[data-debug-id='remote-cwd-up']",
    "[data-debug-id='remote-cwd-parent']",
    "[data-debug-id='remote-cwd-parent']",
    "[data-debug-id='remote-cwd-folder']",
    ...workPreviewKinds.flatMap((kind) => {
      const target = selectorForWorkPreviewKind(kind);
      const baseline = selectorForWorkPreviewKind(kind === "auto" ? "static" : "auto");
      return kind === "auto" ? [baseline, target] : [baseline, target, selectorForWorkPreviewKind("auto")];
    }),
    "[data-debug-id='header-shellx-browser']",
    "[data-debug-id='header-theme-toggle']",
    "[data-debug-id='header-theme-toggle']",
    prApprovalControl.webdriverSelector,
    prApprovalControl.webdriverSelector,
    ...prLocalControls.flatMap((control) => (
      control.label === "Draft option"
        ? [control.webdriverSelector, control.webdriverSelector]
        : [control.webdriverSelector]
    )),
    "[data-debug-id='surface-components-connectorinboxmodal-4']",
    "[data-debug-id='surface-components-connectorinboxmodal-9'][data-inbox='all']",
    "[data-debug-id='surface-components-connectorinboxmodal-9'][data-inbox='telegram']",
    "[data-debug-id='surface-components-connectorinboxmodal-9'][data-inbox='discord']",
    "[data-debug-id='surface-components-connectorinboxmodal-9'][data-inbox='all']",
    "[data-debug-id='surface-components-connectorinboxmodal-9'][data-inbox='telegram']",
    ".connector-inbox-filters > button.settings-pill",
    ".connector-inbox-foot > button.settings-pill",
    "[data-debug-id='settings-tab-general']",
    ...connectorDraftLifecycleControls.flatMap(expectedConnectorDraftLifecycleClicks),
    ...connectorDraftControls.flatMap(expectedConnectorDraftClicks),
    "[data-debug-id='surface-components-rightrail-2'][data-shellx-tool-exposure='hostBridge']",
    "[data-debug-id='surface-components-rightrail-2'][data-shellx-tool-exposure='hostFull']",
    "[data-debug-id='surface-components-rightrail-2'][data-shellx-tool-exposure='off']",
    "[data-debug-id='surface-components-rightrail-2'][data-shellx-tool-exposure='nativeFirst']",
    "[aria-label='Review later']",
    "[title='Open the focused plan review dialog.']",
    "[aria-label='Review later']",
    "[title='Pause auto-continuation (only user can pause)']",
    "[title='Resume auto-continuation']",
    "[title='Mark build as complete — stops the auto-continuation loop. Use when the agent finished but did not call the completion tool itself.']",
    "[aria-label='Select release-owned-file.txt']",
    "[title='Attach selected files to the composer']",
    "[aria-label='Attach release-owned-file.txt']",
    "[aria-label='Select release-owned-file.txt']",
    "[aria-label='Remove release-owned-file.txt from selection']",
    "[aria-label='Select release-owned-file.txt']",
    "[aria-label='Clear selected files']",
    ".fv-row.dir [data-debug-id='surface-components-filespane-7']",
    ".fv-row.file [data-debug-id='surface-components-filespane-7']",
    ".fv-row.dir [data-debug-id='surface-components-filespane-7']",
    "[title='Back to session folder']",
    "[title='Up one level']",
    ":is([title='Show every receipt in this Build Mode run'],[title='Show latest receipts only'])",
    ":is([title='Show every receipt in this Build Mode run'],[title='Show latest receipts only'])",
    ":is([title='Append the session transcript as an appendix'],[title='No transcript captured yet'])",
    ":is([title='Append the session transcript as an appendix'],[title='No transcript captured yet'])",
    "[data-debug-id='surface-components-hashautocomplete-1']",
    "[data-debug-id='surface-lib-markdown-links-1']",
    "[data-debug-id='surface-lib-markdown-links-2']",
    "[data-debug-id='debug-api-retry']",
    "[role='alert'] button:first-of-type",
    "[role='alert'] button:last-of-type",
    "[data-debug-id='surface-components-prcreatemodal-8']",
    "[data-debug-id='surface-components-prcreatemodal-10']",
    "[aria-label='Download Grok session artifacts']",
    ...tasksToggleControls.flatMap((control) => [control.webdriverSelector, control.webdriverSelector]),
    findPopoverFocusControl.webdriverSelector,
    findDiskRowControl.webdriverSelector,
    findPopoverFocusControl.webdriverSelector,
    findOpenRowControl.webdriverSelector,
    "[data-debug-id='header-vault-request-center']",
    ...vaultRequestQuickActions.map((action) => selectorForVaultRequestQuickAction(action.id)),
    "[data-debug-id='vault-request-generate-password']",
    "[data-debug-id='vault-password-generator-close']",
    ...vaultPasswordGeneratorLocalControls.flatMap((control) => [
      "[data-debug-id='vault-request-generate-password']",
      control.webdriverSelector,
      control.webdriverSelector,
    ]),
    ...browserRightTabs.flatMap((tab) => [
      "[data-debug-id='header-shellx-browser']",
      selectorForBrowserRightTab(tab),
    ]),
    ...activityViews.flatMap((view) => {
      const baseline = activityBaseline(view);
      return [
        "[data-debug-id='bottom-action-trace']",
        selectorForActivityTab(baseline),
        selectorForActivityTab(view),
        selectorForActivityTab(baseline),
        "[role='dialog'][aria-label='Activity Browser'] [aria-label='Close (Esc)']",
      ];
    }),
    "[data-debug-id='bottom-action-trace']",
    "[data-debug-id='activity-tab-evidence']",
    ...["changes", "reads", "commands", "git"].flatMap((section) => [
      `[data-debug-id='activity-evidence-section-${section}-expand'][aria-pressed='false']`,
      `[data-debug-id='activity-evidence-section-${section}-expand'][aria-pressed='true']`,
    ]),
    "[data-debug-id='activity-tab-files']",
    "[role='dialog'][aria-label='Activity Browser'] [aria-label='Close (Esc)']",
    ...vaultWorkspaceTabs.flatMap((tab) => {
      const baseline = vaultWorkspaceBaseline(tab);
      return [
        selectorForSettingsTab("vault"),
        selectorForVaultWorkspaceTab(baseline),
        selectorForVaultWorkspaceTab(tab),
        selectorForVaultWorkspaceTab(baseline),
      ];
    }),
    ...vaultResourceFormTabs.flatMap((tab) => {
      const baseline = vaultResourceBaseline(tab);
      return [
        selectorForSettingsTab("vault"),
        selectorForVaultWorkspaceTab("secrets"),
        selectorForVaultResourceFormTab(baseline),
        selectorForVaultResourceFormTab(tab),
        selectorForVaultResourceFormTab(baseline),
      ];
    }),
    ...browserDisclosures.flatMap((disclosure) => [
      selectorForBrowserDisclosure(disclosure.id),
      selectorForBrowserDisclosure(disclosure.id),
    ]),
    ...browserShieldsControls.flatMap((control) => {
      const owner = "[data-debug-id='shellx-browser-trust-chip']";
      const selector = `[data-debug-id='${control.id}']`;
      const reset = "[data-debug-id='shellx-browser-site-shields-reset']";
      const save = "[data-debug-id='shellx-browser-site-shields-save']";
      if (control.id === "shellx-browser-shields-global-enabled") return [owner, selector, selector];
      if (control.id === "shellx-browser-site-shields-ad-trackers"
        || control.id === "surface-browser-components-browsershieldspanel-3"
        || control.id === "surface-browser-components-browsershieldspanel-4") return [owner, reset];
      if (control.id === "shellx-browser-site-shields-reset") return [owner, save, reset];
      return [owner, selector, reset];
    }),
    ...browserAdModeControls.flatMap((control) => {
      const owner = "[data-debug-id='shellx-browser-ad-filter']";
      const target = `[data-debug-id='${control.id}']`;
      const useDefault = "[data-debug-id='shellx-browser-ad-mode-default']";
      if (control.action === "default") {
        return [owner, "[data-debug-id='shellx-browser-ad-mode-strict']", owner, target, owner, owner];
      }
      return [owner, target, owner, useDefault];
    }),
    ...browserPersonalLockControls.flatMap(() => [
      "[data-debug-id='shellx-browser-options']",
      "[data-debug-id='shellx-browser-options']",
    ]),
    "[data-debug-id='shellx-browser-personal-lock-toggle']",
    "[data-debug-id='shellx-browser-options']",
    ...browserDisclosureCloses.flatMap((control) => [
      selectorForBrowserDisclosure(control.owner),
      selectorForBrowserDisclosure(control.id),
    ]),
    "[data-debug-id='shellx-browser-downloads-menu']",
    "[data-debug-id='shellx-browser-downloads-menu']",
    "[data-debug-id='shellx-browser-options']",
    "[data-debug-id='shellx-browser-toggle-right-sidebar']",
    "[data-debug-id='shellx-browser-toggle-right-sidebar']",
    "[data-debug-id='shellx-browser-options']",
    ...browserSidebarVisibilityControls.flatMap(() => [
      "[data-debug-id='shellx-browser-toggle-right-sidebar-button']",
      "[data-debug-id='shellx-browser-show-right-sidebar-button']",
    ]),
    browserSidebarResizeControl.webdriverSelector,
    "[data-debug-id='shellx-browser-options']",
    "[data-debug-id='shellx-browser-options']",
    "[data-debug-id='shellx-browser-options']",
    "[data-debug-id='shellx-browser-options']",
    "[data-debug-id='shellx-browser-options']",
    "[data-debug-id='shellx-browser-options']",
    "[data-debug-id='shellx-browser-options']",
    "[data-debug-id='shellx-browser-options']",
    ...browserHistoryFilterControls.flatMap((control) => control.driverFamily === "activation"
      ? [
        "[data-debug-id='shellx-browser-history-menu']",
        "[data-debug-id='shellx-browser-history-agent']",
        "[data-debug-id='shellx-browser-history-user']",
        "[data-debug-id='shellx-browser-history-menu']",
      ]
      : [
        "[data-debug-id='shellx-browser-history-menu']",
        "[data-debug-id='shellx-browser-history-menu']",
      ]),
    ...browserBookmarkModeControls.flatMap(() => [
      "[data-debug-id='shellx-browser-bookmarks-menu']",
      "[data-debug-id='shellx-browser-bookmark-manager-toggle']",
      "[data-debug-id='shellx-browser-bookmark-list-mode']",
      "[data-debug-id='shellx-browser-bookmarks-menu']",
    ]),
    ...browserBookmarkDraftTextControls.flatMap(() => [
      "[data-debug-id='shellx-browser-bookmarks-menu']",
      "[data-debug-id='shellx-browser-bookmark-manager-toggle']",
      "[data-debug-id='shellx-browser-bookmark-list-mode']",
      "[data-debug-id='shellx-browser-bookmarks-menu']",
    ]),
    ...browserTaskControls.flatMap((control) => {
      const selector = `[data-debug-id='shellx-browser-${control.id}']`;
      if (control.id === "agent-pause") return [selector, "[data-debug-id='shellx-browser-agent-resume']"];
      if (control.id === "agent-takeover") return [selector, "[data-debug-id='shellx-browser-agent-resume']"];
      return [selector];
    }),
    "[data-debug-id='shellx-browser-evidence-record']",
    "[data-debug-id='shellx-browser-evidence-refresh']",
    "[data-debug-id='surface-components-workpreviewpanel-3']",
    "[role='dialog'][aria-label='Preview Center'] [aria-label='Close']",
    "[id='work-preview-refresh-state']",
    ...workPreviewRunningControls.flatMap(expectedWorkPreviewRunningClicks),
    ...workPreviewSafeControls.flatMap(expectedWorkPreviewSafeClicks),
    ...filePreviewModeControls.flatMap((control) => (
      control.mode === "code"
        ? ["[id='file-preview-mode-safe-render']", "[id='file-preview-mode-code']", "[role='dialog'][aria-label='Preview Center'] [aria-label='Close']"]
        : ["[id='file-preview-mode-safe-render']", "[role='dialog'][aria-label='Preview Center'] [aria-label='Close']"]
    )),
    ...filePreviewRunControls.flatMap(() => [
      "[id='file-preview-run-work']",
      "[id='work-preview-refresh-state']",
      "[role='dialog'][aria-label='Preview Center'] [aria-label='Close']",
    ]),
    ...setupGuideControls.flatMap((control) => (
      control.id === "downloads"
        ? [`[data-debug-id='shellx-setup-step-${control.id}']`, "[data-debug-id='settings-tab-vault']"]
        : [control.id === "dismiss"
            ? "[data-debug-id='shellx-setup-guide-dismiss']"
            : `[data-debug-id='shellx-setup-step-${control.id}']`]
    )),
    "[data-debug-id='activity-search-clear']",
    "[data-debug-id='surface-components-commandpalette-4'][data-palette-action-id='act-settings']",
  ]);
  assert.equal(audit.neutralFocusClicks, alwaysVisibleTextControls.length + 6);
  assert.equal(audit.bottomTab, "Chat");
  assert.equal(audit.settingsOpen, false);
  assert.equal(audit.pluginsOpen, false);
  assert.equal(audit.theme, "black");
  assert.equal(audit.persistedTheme, "black");
  assert.equal(audit.settingsTab, "vault");
  assert.equal(audit.setupGuideDismissed, false);
  assert.equal(audit.rightTab, "Tasks");
  assert.equal(audit.agentRunsManualRefreshSequence, 0);
  assert.equal(audit.agentRunsManualRefreshGeneratedAtMs, null);
  assert.deepEqual(audit.activeTab, {
    tabId: "fixture-active-tab-035",
    cwd: "/fixture/original-cwd",
    autonomy: "default",
    connectionId: null,
    connectionLabel: "Local",
    connectionTransport: "local",
    shellxToolExposure: "nativeFirst",
  });
  assert.equal(audit.previewStatus, "stopped");
  assert.equal(audit.previewUrl, null);
  assert.equal(audit.renderedPreviewStatus, "stopped");
  assert.equal(audit.renderedPreviewUrl, null);
  assert.equal(audit.previewStarts, 16);
  assert.equal(audit.previewRefreshes, 19);
  assert.equal(audit.aboutExternalUrls.slice(-2).length, 2);
  assert(audit.aboutExternalUrls.slice(-2).every((url) => url.includes("/preview-fixture/release-preview.html")));
  assert.equal(audit.previewCenterView, "work");
  assert.equal(audit.previewFilePath, null);
  assert.equal(audit.doctorScreenshotExists, false);
  assert.equal(audit.workPreviewKind, "auto");
  assert.equal(audit.workPreviewViewport, "desktop");
  assert.equal(audit.workPreviewReloadSeq, 0);
  assert.equal(audit.workPreviewLogHeight, 260);
  assert.equal(audit.workPreviewLogHeightStored, null);
  assert.equal(audit.ownedModalOpen, null);
  assert.equal(audit.previewTarget, null);
  assert.equal(existsSync(join(profileRoot, "ui-work-preview-start")), false);
  assert.equal(existsSync(join(profileRoot, "ui-file-preview-modes")), false);
  assert.equal(audit.browserRightTab, "chat");
  assert.equal(audit.activeTaskId, null);
  assert.equal(audit.browserTaskTabId, null);
  assert.equal(typeof audit.browserTaskId, "string");
  assert.equal(audit.activeTaskStatus, "aborted");
  assert.equal(audit.recorderIndex, 1);
  assert.equal(audit.currentWindow, "main-window");
  assert.equal(audit.browserWindowOpen, false);
  assert.equal(audit.activityOpen, false);
  assert.equal(audit.activityView, "files");
  assert.equal(audit.activityEvidenceFocused, null);
  assert.equal(audit.composerPicker, null);
  assert.equal(audit.keyboardHintOpen, false);
  assert.equal(audit.vaultWorkspaceTab, "secrets");
  assert.equal(audit.vaultResourceFormTab, "secret");
  assert.equal(audit.browserDisclosure, null);
  assert.equal(audit.browserRightSidebarVisible, true);
  assert.equal(audit.browserRightSidebarWidth, 360);
  assert.equal(audit.browserHomepageValue, "https://example.com/");
  assert.equal(audit.browserHomepageStoredValue, null);
  assert.equal(audit.browserColorMode, "system");
  assert.equal(audit.browserColorModeStoredValue, null);
  assert.equal(audit.browserParallelAgents, "auto");
  assert.equal(audit.browserProfileId, "task-disposable");
  assert.equal(audit.browserAutomationMode, "normal");
  assert.deepEqual(audit.browserPersonalLock, {
    enabled: false,
    locked: false,
    timeoutMinutes: 30,
    authMode: "deviceAuthPreferred",
    pinConfigured: false,
    blurLockedTabs: true,
    pauseDelegatedTabsWhenLocked: true,
    lockOnSleep: true,
    lockOnMinimize: false,
  });
  assert.equal(audit.browserPersonalLockPinDraft, "");
  assert.equal(audit.browserActiveHost, null);
  assert.equal(audit.browserShields.enabled, true);
  assert.deepEqual(audit.browserShields.siteOverrides, []);
  assert.deepEqual(audit.browserProfileAdModes, {});
  assert.equal(audit.browserHistorySearch, "");
  assert.equal(audit.browserHistoryDateFilter, "all");
  assert.equal(audit.browserHistoryScope, "user");
  assert.equal(audit.browserBookmarkManageMode, false);
  assert.equal(audit.browserBookmarkDraftLabel, "");
  assert.equal(audit.browserBookmarkDraftUrl, "");
  assert.equal(audit.browserAddressValue, "about:blank");
  assert.equal(audit.browserGoalValue, "Browse the page, extract needed information, and report with receipts.");
  assert.equal(audit.vaultRequestCenterOpen, false);
  assert.equal(audit.vaultWorkspaceModalOpen, false);
  assert.equal(audit.vaultWorkspaceIntent, null);
  assert.equal(audit.vaultPasswordGeneratorOpen, false);
  assert.equal(audit.vaultPasswordLowercase, true);
  assert.equal(audit.vaultPasswordRevealed, false);
  assert.equal(audit.vaultPasswordLength, 24);
  assert.equal(audit.ownedModalOpen, null);
  assert.equal(audit.activitySearchValue, "");
  assert.equal(audit.connectorSearchValue, "");
  assert.equal(audit.connectorDateValue, "");
  assert.equal(audit.connectorFilter, "all");
  assert.equal(audit.connectorInboxManualRefreshSequence, 0);
  assert.equal(audit.connectorInboxManualRefreshCompletedAtMs, null);
  assert.equal(audit.connectorInboxManualRefreshConnectorCount, null);
  assert.equal(audit.connectorInboxManualRefreshEventCount, null);
  assert.equal(audit.connectorInboxManualRefreshMaxEventMs, null);
  assert.equal(audit.connectorProvider, "telegram");
  assert.equal(audit.connectorDraftOpen, false);
  assert.equal(audit.connectorEnabled, false);
  assert.equal(audit.connectorDispatchMode, "inbox");
  assert.equal(audit.connectorRequireApproval, true);
  assert.equal(audit.connectorTargetMode, "activeTab");
  assert.equal(audit.connectorVaultKey, "telegram/bot-token");
  assert.equal(audit.connectorAllowedIds, "");
  assert.deepEqual(audit.connectorSimValues, {
    "[id='connector-sim-sender']": "",
    "[id='connector-sim-conversation']": "",
    "[id='connector-sim-text']": "",
  });
  assert.deepEqual(audit.connectorSimValues, {
    "[id='connector-sim-sender']": "",
    "[id='connector-sim-conversation']": "",
    "[id='connector-sim-text']": "",
  });
  assert.deepEqual(audit.prTextValues, {
    "[data-debug-id='pr-base-input']": "",
    "[data-debug-id='pr-title-input']": "",
    "[data-debug-id='pr-body-input']": "",
  });
  assert.equal(audit.prApprovalChecked, false);
  assert.equal(audit.prDraftActive, false);
  assert.equal(audit.prTranscriptActive, false);
  assert.equal(audit.hashItemsFixtureActive, false);
  assert.equal(audit.debugUiConnectionFixture, "clear");
  assert.equal(audit.debugUiWebSocketActive, 1);
  assert.equal(audit.debugUiWebSocketGeneration, 4);
  assert.equal(audit.errorBoundaryOpen, false);
  assert.equal(audit.errorBoundaryDocumentGeneration, 2);
  assert.equal(audit.rendererCrashEventCount, 2);
  assert.equal(audit.releaseTestExternalEffectBoundary, null);
  assert.equal(audit.prCreateBoundaryReceipt, null);
  assert.equal(audit.artifactArchiveReceipt, null);
  assert.equal(existsSync(join(profileRoot, "ui-misc-markdown-preview")), false);
  assert.equal(audit.commandPaletteOpen, false);
  assert.equal(audit.commandPaletteInputValue, "");
  assert.equal(audit.findSessionsFocused, false);
  assert.deepEqual(audit.alwaysVisibleTextValues, {
    "[data-debug-id='find-sessions-input']": "",
    "[data-debug-id='composer-prompt']": "",
  });
  assert.deepEqual(audit.rightRailTextValues, {
    "[data-debug-id='tasks-filter-input']": "",
    "[data-debug-id='files-search-input']": "",
  });
  assert.equal(audit.goalState, null);
  assert.equal(audit.goalLastClear, null);
  assert.equal(audit.goalReviewModalOpen, false);
  assert.equal(audit.buildPlanFixtureActive, false);
  assert.equal(audit.buildPlanReviewOpen, false);
  assert.equal(audit.buildPlanUnsafeMutationCount, 0);
  assert.equal(audit.shellxagentFixtureActive, false);
  assert.equal(audit.shellxagentRevealed, false);
  assert.equal(audit.shellxagentUnsafeMutationCount, 0);
  assert.equal(audit.remoteCwdOpen, false);
  assert.equal(audit.remoteCwdPath, "");
  assert.equal(audit.remoteCwdDraft, "");
  assert.equal(audit.remoteCwdUnsafeUseCount, 0);
  assert.equal(audit.remoteCwdIsolatedLaunchCount, remoteCwdControls.length);
  assert.equal(audit.pendingAlertText, null);
  assert.deepEqual(audit.attachmentMediaPendingPaths, []);
  assert.equal(audit.filesPaneSessionPath, null);
  assert.equal(audit.filesPaneFolder, "session");
  assert.equal(audit.filesPaneSelected, false);
  assert.equal(audit.buildRunCockpitFixtureActive, false);
  assert.equal(audit.buildRunCockpitShowAllReceipts, false);
  assert.equal(existsSync(join(profileRoot, "ui-files-pane-lifecycle")), false);
  assert.deepEqual(audit.inputClearCounts, {
    "[data-debug-id='plugins-vault-key-input']": 0,
    "[data-marketplace-entry-id='github'] [data-debug-id='plugins-vault-key-input']": 0,
    "[data-debug-id='remote-cwd-input']": 3,
    "[data-debug-id='activity-search']": 4,
    "[data-debug-id='connector-inbox-search-input']": 3,
    "[data-debug-id='connector-inbox-date-input']": 3,
    "[data-debug-id='pr-base-input']": 2,
    "[data-debug-id='pr-title-input']": 2,
    "[data-debug-id='pr-body-input']": 2,
    "[data-debug-id='tasks-filter-input']": 2,
    "[data-debug-id='files-search-input']": 2,
    "[data-debug-id='command-palette-input']": 2,
    "[data-debug-id='find-sessions-input']": 4,
    "[data-debug-id='composer-prompt']": 3,
    "[data-debug-id='settings-browser-download-folder']": 2,
    "[data-debug-id='shellx-browser-download-folder']": 2,
    "[data-debug-id='shellx-browser-homepage']": 2,
    "[data-debug-id='shellx-browser-history-search']": 2,
    "[data-debug-id='shellx-browser-bookmark-draft-label']": 2,
    "[data-debug-id='shellx-browser-bookmark-draft-url']": 2,
    "[data-debug-id='shellx-browser-address']": 2,
    "[data-debug-id='shellx-browser-goal']": 2,
    "[data-debug-id='shellx-browser-personal-lock-pin']": 1,
    "[data-debug-id='shellx-browser-personal-lock-overlay-pin']": 0,
    "[data-debug-id='connection-label-input']": 0,
    "[data-debug-id='connection-wsl-distro-input']": 0,
    "[data-debug-id='connection-ssh-host-input']": 0,
    "[data-debug-id='connection-ssh-port-input']": 0,
    "[data-debug-id='connection-ssh-wsl-distro-input']": 0,
    "[data-debug-id='left-project-rename-input']": 0,
    "[data-debug-id='session-rename-input']": 0,
    "[data-debug-id='surface-components-settings-connectorstab-21']": 2,
    "[id='connector-secret']": 0,
    "[id='connector-allowed']": 3,
    "[id='connector-sim-sender']": 2,
    "[id='connector-sim-conversation']": 2,
    "[id='connector-sim-text']": 2,
    "[placeholder='What should Grok change about this plan? (Ctrl+Enter to submit)']": 0,
  });
  assert.deepEqual(audit.publicSettings, {
    browserDownloadFolder: "",
    chatFontPx: 19,
    density: "default",
    githubGhBinary: "gh",
    theme: "black",
  });
  assert.deepEqual(audit.taskToggleStates, {
    "[data-debug-id='tasks-show-all-tabs-checkbox']": {
      checked: false,
      storageKey: "tasks-panel-show-all-tabs",
    },
    "[data-debug-id='tasks-show-completed-checkbox']": {
      checked: false,
      storageKey: "tasks-panel-show-completed",
    },
  });
  assert.deepEqual(audit.taskToggleStorage, {
    "tasks-panel-show-all-tabs": null,
    "tasks-panel-show-completed": null,
  });

  const boundedRequest = request(candidateBase, webdriverBase);
  boundedRequest.driverId = UI_CONTROL_BOUNDED_INSTALLED_DRIVER_ID;
  boundedRequest.controller = releaseSurfaceControllerBindingFixture(
    "scripts/release-drivers/ui-control-bounded-installed.ts",
    [
      "scripts/release-drivers/ui-control-installed.ts",
      "scripts/release-drivers/ui-control-bounded-installed-assignments.ts",
      ...UI_CONTROL_INSTALLED_CONTROLLER_FILES,
    ],
  );
  boundedRequest.assignments = boundedRequest.assignments.filter((assignment) => (
    supportsBoundedInstalledUiControl(assignment)
    // Work Preview Start already ran in the generic pass above and its owned
    // project fixture is deliberately single-use; its focused suite exercises
    // the lifecycle from a fresh fixture instead of weakening that ownership.
    && assignment.surface.name !== "src/components/WorkPreviewPanel.tsx:[data-debug-id=\"surface-components-workpreviewpanel-3\"]"
  ));
  // This omnibus fixture safely repeats 172 of the exact bounded cohort.
  // Plan-level and focused lifecycle tests account for the remainder.
  assert.equal(boundedRequest.assignments.length, 172);
  const boundedReport = runBoundedDriver(boundedRequest);
  assert.equal(boundedReport.outcomes.length, 172);
  assert(boundedReport.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
  )), JSON.stringify(boundedReport.outcomes, null, 2));

  console.log("Release surface native UI control WebDriver tests passed");
} finally {
  process.off("SIGINT", onTerminationSignal);
  process.off("SIGTERM", onTerminationSignal);
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
    fixture.kill("SIGTERM");
    await waitForExit(fixture);
  }
  rmSync(temp, { recursive: true, force: true });
}

function request(candidateBase: string, webdriverBase: string): ReleaseSurfaceDriverRequest {
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-installed",
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: "a".repeat(64),
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture("scripts/release-drivers/ui-control-installed.ts", [
      "scripts/shellx-browser-test-cleanup.ts",
      "scripts/lib/release-surface-installed-input-client.ts",
      "scripts/lib/release-surface-bounded-observation.ts",
      "scripts/lib/release-surface-macos-native-input.ts",
      "scripts/lib/release-surface-tauri-invoke-client.ts",
      "scripts/release-drivers/debug-api-session-fixture.ts",
      "scripts/release-drivers/ui-control-owned-browser-bookmarks.ts",
      "scripts/release-drivers/ui-control-owned-browser-history.ts",
      "scripts/release-drivers/ui-control-browser-personal-lock-settings.ts",
      "scripts/release-drivers/ui-control-owned-browser-bookmark-navigation.ts",
      "scripts/release-drivers/ui-control-browser-ad-modes.ts",
      "scripts/release-drivers/ui-control-browser-shields.ts",
      "scripts/release-drivers/ui-control-right-rail-goal.ts",
      "scripts/release-drivers/ui-control-files-pane.ts",
      "scripts/release-drivers/ui-control-build-run-cockpit.ts",
      "scripts/release-drivers/ui-control-misc-safe.ts",
      "scripts/release-drivers/ui-control-safe-families.ts",
      "scripts/release-drivers/ui-control-safe-vault-drafts.ts",
      "scripts/release-drivers/ui-control-vault-owned-edit.ts",
      "scripts/release-drivers/ui-control-find-new-tab.ts",
      "scripts/release-drivers/ui-control-file-preview-safe.ts",
      "scripts/release-drivers/ui-control-attachment-media-safe.ts",
      "scripts/release-drivers/ui-control-setup-guide.ts",
      "scripts/release-drivers/ui-control-work-preview-kind.ts",
      "scripts/release-drivers/ui-control-work-preview-running.ts",
      "scripts/release-drivers/ui-control-work-preview-safe.ts",
      "scripts/release-drivers/ui-control-work-preview-start.ts",
    ]),
    runtime: {
      processId: 4321,
      instanceId,
      debugBase: candidateBase,
      debugTokenPath: tokenPath,
      mcpBase: "http://127.0.0.1:9",
      mcpTokenPath: tokenPath,
      executableSha256: "d".repeat(64),
      installedPayloadPath: "/tmp/fixture/shellx",
      installedManifestSha256: "e".repeat(64),
      posixNative: releaseSurfacePosixNativeBindingFixture({ processId: 4321, port: Number(new URL(candidateBase).port), imagePath: "/tmp/fixture/shellx", imageSha256: "d".repeat(64) }),
    },
    nativeWebDriver: {
      base: webdriverBase,
      sessionId,
      evidence: { basename: "native-webdriver-binding.json", sha256: "f".repeat(64), bytes: 1024 },
    },
    assignments: [
      {
        surface: {
          id: "ui-control:src/components/AgentRunsMonitor.tsx:[data-debug-id=\"tasks-agent-runs-refresh\"]@src/components/AgentRunsMonitor.tsx#1",
          kind: "ui-control" as const,
          name: "src/components/AgentRunsMonitor.tsx:[data-debug-id=\"tasks-agent-runs-refresh\"]",
          source: "src/components/AgentRunsMonitor.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id=\"tasks-agent-runs-refresh\"]",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:agent-runs-monitor-fresh-mount",
        expectedEffect: "A native click completes one exact manual Agent runs refresh and publishes its response generation receipt",
        oracleId: "ui:activation:agent-runs-manual-refresh",
        cleanupId: "ui:restore-agent-runs-monitor-and-right-rail",
      },
      {
        surface: {
          id: "ui-control:src/components/settings/ShellxagentTab.tsx:[data-debug-id=\"surface-components-settings-shellxagenttab-1\"]@src/components/settings/ShellxagentTab.tsx#1",
          kind: "ui-control" as const,
          name: "src/components/settings/ShellxagentTab.tsx:[data-debug-id=\"surface-components-settings-shellxagenttab-1\"]",
          source: "src/components/settings/ShellxagentTab.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id=\"surface-components-settings-shellxagenttab-1\"]",
          elementTag: "button",
          driverFamily: "toggle" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:shellxagent-owned-safe-token",
        expectedEffect: "A native click reveals only the fixed renderer-owned ShellX Agent token while unsafe actions stay disabled",
        oracleId: "ui:boolean-state-transition",
        cleanupId: "ui:hide-owned-shellxagent-token-close-settings-and-clear-fixture",
      },
      ...remoteCwdControls.map((control) => ({
        surface: {
          id: `ui-control:src/App.tsx:[data-debug-id=\"${control.selector}\"]@src/App.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/App.tsx:[data-debug-id=\"${control.selector}\"]`,
          source: "src/App.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: `[data-debug-id=\"${control.selector}\"]`,
          elementTag: control.elementTag,
          driverFamily: control.driverFamily,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:remote-cwd-owned-local-tree",
        expectedEffect: `A native WebDriver ${control.driverFamily === "text-entry" ? "text entry" : "click"} changes only the isolated Remote Folder path before exact cleanup without persisting it to a tab.`,
        oracleId: control.driverFamily === "text-entry"
          ? "ui:value-state-transition"
          : "ui:activation:remote-cwd-path-transition",
        cleanupId: "ui:close-remote-cwd-picker-delete-owned-tree",
      })),
      ...workPreviewKinds.map((kind) => ({
        surface: {
          id: `ui-control:src/components/WorkPreviewPanel.tsx:[id=\"work-preview-kind-${kind}\"]@src/components/WorkPreviewPanel.tsx#${workPreviewKindOccurrence(kind)}`,
          kind: "ui-control" as const,
          name: `src/components/WorkPreviewPanel.tsx:[id=\"work-preview-kind-${kind}\"]`,
          source: "src/components/WorkPreviewPanel.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: `[id=\"work-preview-kind-${kind}\"]`,
          elementTag: "button",
          driverFamily: "selection" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:work-preview-kind-auto-baseline",
        expectedEffect: `A native click selects the exact ${kind} Work Preview kind with aria-selected ownership`,
        oracleId: "ui:selection-state-transition",
        cleanupId: "ui:restore-work-preview-kind-and-right-rail",
      })),
      {
        surface: {
          id: "ui-control:src/components/Header.tsx:[data-debug-id=\"header-shellx-browser\"]@src/components/Header.tsx#3",
          kind: "ui-control" as const,
          name: "src/components/Header.tsx:[data-debug-id=\"header-shellx-browser\"]",
          source: "src/components/Header.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id=\"header-shellx-browser\"]",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-window-closed",
        expectedEffect: "A native click opens the separately titled ShellX Browser window",
        oracleId: "ui:activation:shellx-browser-window",
        cleanupId: "ui:close-browser-window-and-restore-main",
      },
      {
        surface: {
          id: "ui-control:src/components/Header.tsx:[data-debug-id=\"header-theme-toggle\"]@src/components/Header.tsx#6",
          kind: "ui-control" as const,
          name: "src/components/Header.tsx:[data-debug-id=\"header-theme-toggle\"]",
          source: "src/components/Header.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id=\"header-theme-toggle\"]",
          elementTag: "button",
          driverFamily: "toggle" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:isolated-default-theme",
        expectedEffect: "A native click changes and then restores the exact isolated theme state",
        oracleId: "ui:boolean-state-transition",
        cleanupId: "ui:restore-isolated-theme-baseline",
      },
      {
        surface: {
          id: `ui-control:${connectorSearchControl.source}:${connectorSearchControl.inventorySelector}@${connectorSearchControl.source}#${connectorSearchControl.occurrence}`,
          kind: "ui-control" as const,
          name: `${connectorSearchControl.source}:${connectorSearchControl.inventorySelector}`,
          source: connectorSearchControl.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: connectorSearchControl.inventorySelector,
          elementTag: "input",
          driverFamily: "text-entry" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:owned-modal-text-input-empty",
        expectedEffect: "Native text entry changes the prepared Connector Inbox search value before exact clearing and modal cleanup.",
        oracleId: "ui:value-state-transition",
        cleanupId: "ui:clear-input-and-close-owned-modal",
      },
      ...additionalOwnedModalTextControls.map((control) => ({
        surface: {
          id: `ui-control:${control.source}:${control.inventorySelector}@${control.source}#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `${control.source}:${control.inventorySelector}`,
          source: control.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: control.inventorySelector,
          elementTag: control.elementTag,
          driverFamily: "text-entry" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:owned-modal-text-input-empty",
        expectedEffect: `Native text entry changes the prepared ${control.label} value before exact clearing and modal cleanup.`,
        oracleId: "ui:value-state-transition",
        cleanupId: "ui:clear-input-and-close-owned-modal",
      })),
      ...prTextControls.map((control) => ({
        surface: {
          id: `ui-control:src/components/PRCreateModal.tsx:${control.inventorySelector}@src/components/PRCreateModal.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/PRCreateModal.tsx:${control.inventorySelector}`,
          source: "src/components/PRCreateModal.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: control.inventorySelector,
          elementTag: control.elementTag,
          driverFamily: "text-entry" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:owned-modal-text-input-empty",
        expectedEffect: `Native text entry changes the prepared ${control.label} before exact clearing and modal cleanup without creating a remote pull request.`,
        oracleId: "ui:value-state-transition",
        cleanupId: "ui:clear-input-and-close-owned-modal",
      })),
      {
        surface: {
          id: `ui-control:src/components/PRCreateModal.tsx:${prApprovalControl.inventorySelector}@src/components/PRCreateModal.tsx#${prApprovalControl.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/PRCreateModal.tsx:${prApprovalControl.inventorySelector}`,
          source: "src/components/PRCreateModal.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: prApprovalControl.inventorySelector,
          elementTag: "input",
          inputType: "checkbox",
          driverFamily: "toggle" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:pr-modal-approval-baseline",
        expectedEffect: "A native click changes only the prepared local pull-request approval checkbox before exact restoration and modal cleanup; no remote pull request is created.",
        oracleId: "ui:boolean-state-transition",
        cleanupId: "ui:restore-pr-approval-and-close",
      },
      ...prLocalControls.map((control) => ({
        surface: {
          id: `ui-control:src/components/PRCreateModal.tsx:${control.inventorySelector}@src/components/PRCreateModal.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/PRCreateModal.tsx:${control.inventorySelector}`,
          source: "src/components/PRCreateModal.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: control.inventorySelector,
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: control.fixtureId,
        expectedEffect: control.label === "Draft option"
          ? "A native click changes only the prepared local pull-request Draft option before exact restoration and modal cleanup; no remote pull request is created."
          : "A native click closes the prepared pull-request modal without creating a remote pull request.",
        oracleId: control.oracleId,
        cleanupId: control.cleanupId,
      })),
      ...connectorInboxLocalControls.map((control) => ({
        surface: {
          id: `ui-control:src/components/ConnectorInboxModal.tsx:${control.inventorySelector}@src/components/ConnectorInboxModal.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/ConnectorInboxModal.tsx:${control.inventorySelector}`,
          source: "src/components/ConnectorInboxModal.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: control.inventorySelector,
          elementTag: "button",
          driverFamily: control.label === "provider tabs" ? "selection" as const : "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: control.fixtureId,
        expectedEffect: control.label === "provider tabs"
          ? "Native clicks select every concrete Connector Inbox provider tab before exact filter-state and modal restoration."
          : control.label === "Refresh"
            ? "A native click completes exactly one manual Connector Inbox refresh and publishes its returned counts, latest-event watermark, and completion time before exact receipt reset and modal cleanup."
          : control.label === "Clear filters"
            ? "A native click clears the prepared Connector Inbox provider, search, and date filters before exact original-state restoration."
            : "A native click closes Connector Inbox and opens Settings with the Connectors tab selected before exact Settings-tab restoration.",
        oracleId: control.oracleId,
        cleanupId: control.cleanupId,
      })),
      ...connectorDraftLifecycleControls.map((control) => ({
        surface: {
          id: `ui-control:src/components/settings/ConnectorsTab.tsx:${control.inventorySelector}@src/components/settings/ConnectorsTab.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/settings/ConnectorsTab.tsx:${control.inventorySelector}`,
          source: "src/components/settings/ConnectorsTab.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: control.inventorySelector,
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: control.fixtureId,
        expectedEffect: `Native installed input ${control.expectedEffect}.`,
        oracleId: control.oracleId,
        cleanupId: "ui:restore-connectors-draft-and-close-settings",
      })),
      ...connectorDraftControls.map((control) => ({
        surface: {
          id: `ui-control:src/components/settings/ConnectorsTab.tsx:${control.inventorySelector}@src/components/settings/ConnectorsTab.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/settings/ConnectorsTab.tsx:${control.inventorySelector}`,
          source: "src/components/settings/ConnectorsTab.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: control.inventorySelector,
          elementTag: control.elementTag,
          driverFamily: control.driverFamily,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:connectors-unsaved-draft-baseline",
        expectedEffect: `Native installed input ${control.expectedEffect}.`,
        oracleId: control.oracleId,
        cleanupId: "ui:restore-connectors-draft-and-close-settings",
      })),
      {
        surface: {
          id: `ui-control:src/components/RightRail.tsx:${shellxToolExposureControl.inventorySelector}@src/components/RightRail.tsx#${shellxToolExposureControl.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/RightRail.tsx:${shellxToolExposureControl.inventorySelector}`,
          source: "src/components/RightRail.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: shellxToolExposureControl.inventorySelector,
          elementTag: "button",
          driverFamily: "toggle" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:shellx-tool-exposure-owned-baseline",
        expectedEffect: "Native clicks exercise every ShellX tool-exposure mode for the active tab before exact mode and right-rail restoration without starting a provider session.",
        oracleId: "ui:boolean-state-transition",
        cleanupId: "ui:restore-shellx-tool-exposure-and-right-rail",
      },
      ...rightRailGoalControls.map((control) => ({
        surface: {
          id: `ui-control:src/components/RightRail.tsx:${control.inventorySelector}@src/components/RightRail.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/RightRail.tsx:${control.inventorySelector}`,
          source: "src/components/RightRail.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: control.inventorySelector,
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: control.fixtureId,
        expectedEffect: `Native installed input ${control.expectedEffect}.`,
        oracleId: control.oracleId,
        cleanupId: "ui:forget-owned-goal-delete-cwd-and-restore-right-rail",
      })),
      ...filesPaneControls.map((control) => ({
        surface: {
          id: `ui-control:src/components/FilesPane.tsx:${control.inventorySelector}@src/components/FilesPane.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/FilesPane.tsx:${control.inventorySelector}`,
          source: "src/components/FilesPane.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: control.inventorySelector,
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:files-pane-owned-tree",
        expectedEffect: `Native installed input ${control.expectedEffect}.`,
        oracleId: control.oracleId,
        cleanupId: "ui:remove-owned-files-attachments-close-preview-delete-tree-and-restore-state",
      })),
      {
        surface: {
          id: "ui-control:src/components/BuildRunCockpit.tsx::is([title=\"Show every receipt in this Build Mode run\"],[title=\"Show latest receipts only\"])@src/components/BuildRunCockpit.tsx#8",
          kind: "ui-control" as const,
          name: "src/components/BuildRunCockpit.tsx::is([title=\"Show every receipt in this Build Mode run\"],[title=\"Show latest receipts only\"])",
          source: "src/components/BuildRunCockpit.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: ":is([title=\"Show every receipt in this Build Mode run\"],[title=\"Show latest receipts only\"])",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:build-run-cockpit-owned-terminal-receipts",
        expectedEffect: "A native click expands the fixed terminal Build fixture from six visible receipts to all eight, then cleanup collapses and removes the renderer-only fixture without invoking a Build action.",
        oracleId: "ui:boolean-state-transition",
        cleanupId: "ui:collapse-and-clear-build-run-fixture-restore-right-rail",
      },
      {
        surface: {
          id: "ui-control:src/components/PRCreateModal.tsx::is([title=\"Append the session transcript as an appendix\"],[title=\"No transcript captured yet\"])@src/components/PRCreateModal.tsx#7",
          kind: "ui-control" as const,
          name: "src/components/PRCreateModal.tsx::is([title=\"Append the session transcript as an appendix\"],[title=\"No transcript captured yet\"])",
          source: "src/components/PRCreateModal.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: ":is([title=\"Append the session transcript as an appendix\"],[title=\"No transcript captured yet\"])",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:pr-transcript-owned-renderer-baseline",
        expectedEffect: "A native click toggles only the synthetic transcript appendix option in a renderer-owned PR draft, then restores and closes it without creating a PR.",
        oracleId: "ui:boolean-state-transition",
        cleanupId: "ui:restore-pr-transcript-close-modal-and-clear-events",
      },
      {
        surface: {
          id: "ui-control:src/components/HashAutocomplete.tsx:[data-debug-id=\"surface-components-hashautocomplete-1\"]@src/components/HashAutocomplete.tsx#1",
          kind: "ui-control" as const,
          name: "src/components/HashAutocomplete.tsx:[data-debug-id=\"surface-components-hashautocomplete-1\"]",
          source: "src/components/HashAutocomplete.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id=\"surface-components-hashautocomplete-1\"]",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:hash-autocomplete-owned-composer-baseline",
        expectedEffect: "A native click inserts one exact synthetic issue markdown reference into the empty isolated composer, then cleanup clears both the draft and owned item without querying GitHub.",
        oracleId: "ui:activation:hash-autocomplete-owned-insertion",
        cleanupId: "ui:clear-hash-draft-and-owned-items",
      },
      {
        surface: {
          id: "ui-control:src/lib/markdown-links.tsx:[data-debug-id=\"surface-lib-markdown-links-1\"]@src/lib/markdown-links.tsx#1",
          kind: "ui-control" as const,
          name: "src/lib/markdown-links.tsx:[data-debug-id=\"surface-lib-markdown-links-1\"]",
          source: "src/lib/markdown-links.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id=\"surface-lib-markdown-links-1\"]",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:markdown-link-owned-file-projection",
        expectedEffect: "A native click opens Preview Center for one exact disposable file projected by the renderer-only markdown fixture, then cleanup closes it and deletes the owned files.",
        oracleId: "ui:activation:markdown-owned-file-preview-opened",
        cleanupId: "ui:close-preview-clear-events-delete-owned-file-and-restore-chat",
      },
      {
        surface: {
          id: "ui-control:src/lib/markdown-links.tsx:[data-debug-id=\"surface-lib-markdown-links-2\"]@src/lib/markdown-links.tsx#2",
          kind: "ui-control" as const,
          name: "src/lib/markdown-links.tsx:[data-debug-id=\"surface-lib-markdown-links-2\"]",
          source: "src/lib/markdown-links.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id=\"surface-lib-markdown-links-2\"]",
          elementTag: "a",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:markdown-link-owned-external-projection",
        expectedEffect: "A native click dispatches one exact synthetic HTTP SafeMarkdownLink through the isolated external-browser handoff.",
        oracleId: "ui:activation:markdown-owned-external-handoff",
        cleanupId: "ui:close-preview-clear-events-delete-owned-file-and-restore-chat",
      },
      {
        surface: {
          id: "ui-control:src/components/DebugApiConnectionBanner.tsx:[data-debug-id=\"debug-api-retry\"]@src/components/DebugApiConnectionBanner.tsx#1",
          kind: "ui-control" as const,
          name: "src/components/DebugApiConnectionBanner.tsx:[data-debug-id=\"debug-api-retry\"]",
          source: "src/components/DebugApiConnectionBanner.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id=\"debug-api-retry\"]",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:debug-api-owned-disconnected-retry",
        expectedEffect: "A native click clears the exact disconnected fixture and creates a fresh authenticated renderer Debug UI event-stream generation while retaining an active connection.",
        oracleId: "ui:activation:debug-api-websocket-reconnected",
        cleanupId: "ui:clear-debug-api-disconnected-fixture",
      },
      {
        surface: {
          id: "ui-control:src/components/ErrorBoundary.tsx:role=button;name=\"Reset UI\"@src/components/ErrorBoundary.tsx#1",
          kind: "ui-control" as const,
          name: "src/components/ErrorBoundary.tsx:role=button;name=\"Reset UI\"",
          source: "src/components/ErrorBoundary.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "role=button;name=\"Reset UI\"",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:error-boundary-owned-renderer-crash-reset",
        expectedEffect: "A native click resets the React boundary after one isolated transient render crash, restores the app, preserves the backend identity, and creates a fresh renderer event stream.",
        oracleId: "ui:activation:error-boundary-renderer-recovered",
        cleanupId: "ui:recover-isolated-renderer-and-preserve-backend",
      },
      {
        surface: {
          id: "ui-control:src/components/ErrorBoundary.tsx:role=button;name=\"Reload window\"@src/components/ErrorBoundary.tsx#2",
          kind: "ui-control" as const,
          name: "src/components/ErrorBoundary.tsx:role=button;name=\"Reload window\"",
          source: "src/components/ErrorBoundary.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "role=button;name=\"Reload window\"",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:error-boundary-owned-renderer-crash-reload",
        expectedEffect: "A native click reloads the renderer document after one isolated transient render crash, restores the app, preserves the backend identity, and creates a fresh renderer event stream.",
        oracleId: "ui:activation:error-boundary-renderer-recovered",
        cleanupId: "ui:recover-isolated-renderer-and-preserve-backend",
      },
      {
        surface: {
          id: "ui-control:src/components/PRCreateModal.tsx:[data-debug-id=\"surface-components-prcreatemodal-10\"]@src/components/PRCreateModal.tsx#10",
          kind: "ui-control" as const,
          name: "src/components/PRCreateModal.tsx:[data-debug-id=\"surface-components-prcreatemodal-10\"]",
          source: "src/components/PRCreateModal.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id=\"surface-components-prcreatemodal-10\"]",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:external-effect-pr-create-boundary",
        expectedEffect: "A native click submits a complete explicitly approved PR draft through the production Debug API route and reaches the exact isolated pre-gh/pre-GitHub boundary without spawning a subprocess or mutating remote state.",
        oracleId: "ui:activation:pr-create-remote-boundary",
        cleanupId: "ui:clear-external-effect-boundary-close-pr-restore-baseline",
      },
      {
        surface: {
          id: "ui-control:src/App.tsx:[aria-label=\"Download Grok session artifacts\"]@src/App.tsx#9",
          kind: "ui-control" as const,
          name: "src/App.tsx:[aria-label=\"Download Grok session artifacts\"]",
          source: "src/App.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[aria-label=\"Download Grok session artifacts\"]",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:external-effect-artifact-archive-boundary",
        expectedEffect: "A native click invokes the production artifact-download handler and reaches the exact isolated pre-save-picker boundary without opening an operating-system dialog, walking session files, or writing an archive.",
        oracleId: "ui:activation:artifact-archive-save-picker-boundary",
        cleanupId: "ui:clear-external-effect-boundary-restore-artifact-control",
      },
      ...rightRailTextControls.map((control) => ({
        surface: {
          id: `ui-control:${control.source}:${control.inventorySelector}@${control.source}#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `${control.source}:${control.inventorySelector}`,
          source: control.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: control.inventorySelector,
          elementTag: "input",
          driverFamily: "text-entry" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:right-rail-text-input-empty",
        expectedEffect: `Native text entry changes the prepared ${control.label} value before exact clearing and right-rail restoration.`,
        oracleId: "ui:value-state-transition",
        cleanupId: "ui:clear-input-and-restore-right-rail",
      })),
      ...tasksToggleControls.map((control) => ({
        surface: {
          id: `ui-control:src/components/TasksPanel.tsx:${control.inventorySelector}@src/components/TasksPanel.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/TasksPanel.tsx:${control.inventorySelector}`,
          source: "src/components/TasksPanel.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: control.inventorySelector,
          elementTag: "input",
          driverFamily: "toggle" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:tasks-toggle-owned-baseline",
        expectedEffect: `A native click changes the ${control.label} and its persisted setting before exact restoration.`,
        oracleId: "ui:boolean-state-transition",
        cleanupId: "ui:restore-tasks-toggle-and-right-rail",
      })),
      {
        surface: {
          id: `ui-control:${commandPaletteInputControl.source}:${commandPaletteInputControl.inventorySelector}@${commandPaletteInputControl.source}#${commandPaletteInputControl.occurrence}`,
          kind: "ui-control" as const,
          name: `${commandPaletteInputControl.source}:${commandPaletteInputControl.inventorySelector}`,
          source: commandPaletteInputControl.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: commandPaletteInputControl.inventorySelector,
          elementTag: "input",
          driverFamily: "text-entry" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:overlay-text-input-empty",
        expectedEffect: "Native text entry changes the prepared Command Palette query before exact clearing and overlay cleanup.",
        oracleId: "ui:value-state-transition",
        cleanupId: "ui:clear-input-and-close-overlay",
      },
      ...alwaysVisibleTextControls.map((control) => ({
        surface: {
          id: `ui-control:${control.source}:${control.inventorySelector}@${control.source}#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `${control.source}:${control.inventorySelector}`,
          source: control.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: control.inventorySelector,
          elementTag: control.elementTag,
          driverFamily: "text-entry" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:always-visible-text-input-empty",
        expectedEffect: `Native text entry changes the prepared ${control.label} without submitting before exact clearing and focus cleanup.`,
        oracleId: "ui:value-state-transition",
        cleanupId: "ui:clear-input-and-neutralize-focus",
      })),
      {
        surface: {
          id: `ui-control:${findPopoverFocusControl.source}:${findPopoverFocusControl.inventorySelector}@${findPopoverFocusControl.source}#${findPopoverFocusControl.occurrence}`,
          kind: "ui-control" as const,
          name: `${findPopoverFocusControl.source}:${findPopoverFocusControl.inventorySelector}`,
          source: findPopoverFocusControl.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: findPopoverFocusControl.inventorySelector,
          elementTag: "div",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:always-visible-text-input-empty",
        expectedEffect: "A native click focuses the owned session finder and opens its popover before exact focus cleanup.",
        oracleId: "ui:activation:session-finder-focused",
        cleanupId: "ui:clear-input-and-neutralize-focus",
      },
      {
        surface: {
          id: `ui-control:${findDiskRowControl.source}:${findDiskRowControl.inventorySelector}@${findDiskRowControl.source}#${findDiskRowControl.occurrence}`,
          kind: "ui-control" as const,
          name: `${findDiskRowControl.source}:${findDiskRowControl.inventorySelector}`,
          source: findDiskRowControl.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: findDiskRowControl.inventorySelector,
          elementTag: "div",
          driverFamily: "selection" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:find-disk-row-visible",
        expectedEffect: "Native input finds and selects one exact owned on-disk session row before deleting the history fixture.",
        oracleId: "ui:selection-state-transition",
        cleanupId: "ui:delete-owned-session-clear-input-and-neutralize-focus",
      },
      {
        surface: {
          id: `ui-control:${findOpenRowControl.source}:${findOpenRowControl.inventorySelector}@${findOpenRowControl.source}#${findOpenRowControl.occurrence}`,
          kind: "ui-control" as const,
          name: `${findOpenRowControl.source}:${findOpenRowControl.inventorySelector}`,
          source: findOpenRowControl.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: findOpenRowControl.inventorySelector,
          elementTag: "div",
          driverFamily: "selection" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:find-open-row-visible",
        expectedEffect: "Native clicks focus Find and select its owned open-session row without opening another tab.",
        oracleId: "ui:selection-state-transition",
        cleanupId: "ui:clear-input-and-neutralize-focus",
      },
      {
        surface: {
          id: `ui-control:${settingsDownloadFolderControl.source}:${settingsDownloadFolderControl.inventorySelector}@${settingsDownloadFolderControl.source}#${settingsDownloadFolderControl.occurrence}`,
          kind: "ui-control" as const,
          name: `${settingsDownloadFolderControl.source}:${settingsDownloadFolderControl.inventorySelector}`,
          source: settingsDownloadFolderControl.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: settingsDownloadFolderControl.inventorySelector,
          elementTag: "input",
          driverFamily: "text-entry" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:settings-text-input-owned-baseline",
        expectedEffect: "Native text entry changes the Browser download folder before exact durable and UI restoration.",
        oracleId: "ui:value-state-transition",
        cleanupId: "ui:restore-settings-input-tab-and-dialog",
      },
      {
        surface: {
          id: "ui-control:src/components/HeaderVaultRequestCenter.tsx:[data-debug-id=\"header-vault-request-center\"]@src/components/HeaderVaultRequestCenter.tsx#1",
          kind: "ui-control" as const,
          name: "src/components/HeaderVaultRequestCenter.tsx:[data-debug-id=\"header-vault-request-center\"]",
          source: "src/components/HeaderVaultRequestCenter.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id=\"header-vault-request-center\"]",
          elementTag: "button",
          driverFamily: "disclosure" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:vault-request-center-closed",
        expectedEffect: "The Vault Request Center owner expands and exposes its exactly labelled popover after a native click",
        oracleId: "ui:disclosure-state-transition",
        cleanupId: "ui:close-vault-request-center",
      },
      ...vaultRequestQuickActions.map((action) => ({
        surface: {
          id: `ui-control:src/components/HeaderVaultRequestCenter.tsx:${selectorForVaultRequestQuickActionInventory(action.id)}@src/components/HeaderVaultRequestCenter.tsx#${action.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/HeaderVaultRequestCenter.tsx:${selectorForVaultRequestQuickActionInventory(action.id)}`,
          source: "src/components/HeaderVaultRequestCenter.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: selectorForVaultRequestQuickActionInventory(action.id),
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:vault-request-center-open",
        expectedEffect: `A native click ${action.expectedEffect}`,
        oracleId: action.oracleId,
        cleanupId: "ui:close-vault-request-action-effect",
      })),
      {
        surface: {
          id: "ui-control:src/components/VaultPasswordGenerator.tsx:[data-debug-id=\"vault-password-generator-close\"]@src/components/VaultPasswordGenerator.tsx#1",
          kind: "ui-control" as const,
          name: "src/components/VaultPasswordGenerator.tsx:[data-debug-id=\"vault-password-generator-close\"]",
          source: "src/components/VaultPasswordGenerator.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id=\"vault-password-generator-close\"]",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:vault-password-generator-open",
        expectedEffect: "A native click closes the prepared Vault password generator while preserving the open Request Center",
        oracleId: "ui:activation:vault-password-generator-closed",
        cleanupId: "ui:close-vault-request-action-effect",
      },
      ...vaultPasswordGeneratorLocalControls.map((control) => ({
        surface: {
          id: `ui-control:src/components/VaultPasswordGenerator.tsx:${control.inventorySelector}@src/components/VaultPasswordGenerator.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/VaultPasswordGenerator.tsx:${control.inventorySelector}`,
          source: "src/components/VaultPasswordGenerator.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: control.inventorySelector,
          elementTag: control.elementTag,
          driverFamily: control.driverFamily,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:vault-password-generator-local-baseline",
        expectedEffect: `A native click changes ${control.label} before exact local-state restoration without retaining password contents.`,
        oracleId: control.oracleId,
        cleanupId: "ui:restore-vault-password-generator-local-state",
      })),
      ...browserRightTabs.map((tab, index) => ({
        surface: {
          id: `ui-control:src/browser/components/AgentSidebar.tsx:${selectorForBrowserRightInventory(tab)}@src/browser/components/AgentSidebar.tsx#${index + 3}`,
          kind: "ui-control" as const,
          name: `src/browser/components/AgentSidebar.tsx:${selectorForBrowserRightInventory(tab)}`,
          source: "src/browser/components/AgentSidebar.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: selectorForBrowserRightInventory(tab),
          elementTag: "button",
          elementRole: "tab",
          driverFamily: "selection" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-right-panel-opposite-baseline",
        expectedEffect: `${tab} becomes the selected Browser right-panel tab after a native click`,
        oracleId: "ui:selection-state-transition",
        cleanupId: "ui:restore-browser-right-panel-and-window",
      })),
      ...activityViews.map((view, index) => ({
        surface: {
          id: `ui-control:src/components/ActivityBrowserModal.tsx:${selectorForActivityInventory(view)}@src/components/ActivityBrowserModal.tsx#${index + 3}`,
          kind: "ui-control" as const,
          name: `src/components/ActivityBrowserModal.tsx:${selectorForActivityInventory(view)}`,
          source: "src/components/ActivityBrowserModal.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: selectorForActivityInventory(view),
          elementTag: "button",
          elementRole: "tab",
          driverFamily: "selection" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:activity-view-opposite-baseline",
        expectedEffect: `${view} becomes the selected Activity Browser view after a native click`,
        oracleId: "ui:selection-state-transition",
        cleanupId: "ui:restore-activity-view-and-close",
      })),
      {
        surface: {
          id: "ui-control:src/components/ActivityBrowserModal.tsx:[data-debug-id^=\"activity-evidence-section-\"][data-debug-id$=\"-expand\"]@src/components/ActivityBrowserModal.tsx#20",
          kind: "ui-control" as const,
          name: "src/components/ActivityBrowserModal.tsx:[data-debug-id^=\"activity-evidence-section-\"][data-debug-id$=\"-expand\"]",
          source: "src/components/ActivityBrowserModal.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id^=\"activity-evidence-section-\"][data-debug-id$=\"-expand\"]",
          elementTag: "button",
          driverFamily: "toggle" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:activity-evidence-unfocused-grid",
        expectedEffect: "Native clicks expand and restore each Activity Evidence section",
        oracleId: "ui:boolean-state-transition",
        cleanupId: "ui:restore-activity-evidence-focus-and-close",
      },
      ...vaultWorkspaceTabs.map((tab, index) => ({
        surface: {
          id: `ui-control:src/components/settings/VaultTab.tsx:${selectorForVaultWorkspaceInventory(tab)}@src/components/settings/VaultTab.tsx#${index + 1}`,
          kind: "ui-control" as const,
          name: `src/components/settings/VaultTab.tsx:${selectorForVaultWorkspaceInventory(tab)}`,
          source: "src/components/settings/VaultTab.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: selectorForVaultWorkspaceInventory(tab),
          elementTag: "button",
          elementRole: "tab",
          driverFamily: "selection" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:vault-workspace-tab-opposite-baseline",
        expectedEffect: `${tab} becomes the selected Vault workspace after a native click`,
        oracleId: "ui:selection-state-transition",
        cleanupId: "ui:restore-vault-workspace-tab-and-close-settings",
      })),
      ...vaultResourceFormTabs.map((tab) => ({
        surface: {
          id: `ui-control:src/components/settings/VaultTab.tsx:${selectorForVaultResourceInventory(tab)}@src/components/settings/VaultTab.tsx#7`,
          kind: "ui-control" as const,
          name: `src/components/settings/VaultTab.tsx:${selectorForVaultResourceInventory(tab)}`,
          source: "src/components/settings/VaultTab.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: selectorForVaultResourceInventory(tab),
          finiteVariant: `vault-resource-form-tab-${tab}`,
          elementTag: "button",
          elementRole: "tab",
          driverFamily: "selection" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:vault-resource-form-tab-opposite-baseline",
        expectedEffect: `${tab} becomes the selected Vault resource editor after a native click`,
        oracleId: "ui:selection-state-transition",
        cleanupId: "ui:restore-vault-resource-form-tab-and-close-settings",
      })),
      ...browserDisclosures.map((disclosure) => ({
        surface: {
          id: `ui-control:${disclosure.source}:${selectorForBrowserDisclosureInventory(disclosure.id)}@${disclosure.source}#${disclosure.occurrence}`,
          kind: "ui-control" as const,
          name: `src/browser/components/BrowserChrome.tsx:${selectorForBrowserDisclosureInventory(disclosure.id)}`,
          source: disclosure.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: selectorForBrowserDisclosureInventory(disclosure.id),
          elementTag: "button",
          driverFamily: "disclosure" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-disclosure-closed-with-current-page",
        expectedEffect: `${disclosure.id} expands its exactly owned Browser panel after a native click`,
        oracleId: "ui:disclosure-state-transition",
        cleanupId: "ui:collapse-browser-disclosure-abort-task-and-restore-window",
      })),
      ...browserShieldsControls.map((control) => ({
        surface: {
          id: `ui-control:src/browser/components/BrowserShieldsPanel.tsx:[data-debug-id=\"${control.id}\"]@src/browser/components/BrowserShieldsPanel.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/browser/components/BrowserShieldsPanel.tsx:[data-debug-id=\"${control.id}\"]`,
          source: "src/browser/components/BrowserShieldsPanel.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: `[data-debug-id=\"${control.id}\"]`,
          elementTag: control.elementTag,
          driverFamily: control.driverFamily,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-shields-owned-task",
        expectedEffect: `Native Browser Shields ${control.id} transition`,
        oracleId: control.oracleId,
        cleanupId: "ui:reset-owned-site-shields-restore-global-abort-task-and-window",
      })),
      ...browserAdModeControls.map((control) => ({
        surface: {
          id: `ui-control:src/browser/components/BrowserMenus.tsx:[data-debug-id="${control.id}"]@src/browser/components/BrowserMenus.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/browser/components/BrowserMenus.tsx:[data-debug-id="${control.id}"]`,
          source: "src/browser/components/BrowserMenus.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: `[data-debug-id="${control.id}"]`,
          elementTag: "button",
          driverFamily: "toggle" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-ad-mode-owned-task-default",
        expectedEffect: `Native Browser profile ad mode ${control.action} transition`,
        oracleId: "ui:boolean-state-transition",
        cleanupId: "ui:restore-browser-ad-mode-default-abort-task-and-window",
      })),
      ...browserPersonalLockControls.map((control) => ({
        surface: {
          id: `ui-control:src/browser/components/BrowserMenus.tsx:[data-debug-id="${control.id}"]@src/browser/components/BrowserMenus.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/browser/components/BrowserMenus.tsx:[data-debug-id="${control.id}"]`,
          source: "src/browser/components/BrowserMenus.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: `[data-debug-id="${control.id}"]`,
          elementTag: control.elementTag,
          driverFamily: control.driverFamily,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-personal-lock-owned-settings",
        expectedEffect: `Native Personal Browser Lock ${control.id} transition`,
        oracleId: control.oracleId,
        cleanupId: "ui:restore-browser-personal-lock-settings-abort-task-and-window",
      })),
      {
        surface: {
          id: `ui-control:src/browser/components/BrowserChrome.tsx:[data-debug-id="${browserPersonalLockOpenControl.id}"]@src/browser/components/BrowserChrome.tsx#${browserPersonalLockOpenControl.occurrence}`,
          kind: "ui-control" as const,
          name: `src/browser/components/BrowserChrome.tsx:[data-debug-id="${browserPersonalLockOpenControl.id}"]`,
          source: "src/browser/components/BrowserChrome.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: `[data-debug-id="${browserPersonalLockOpenControl.id}"]`,
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-personal-lock-owned-settings",
        expectedEffect: "Native click opens Personal Browser Lock settings from its disabled baseline.",
        oracleId: "ui:activation:browser-personal-lock-settings-opened",
        cleanupId: "ui:restore-browser-personal-lock-settings-abort-task-and-window",
      },
      ...browserDisclosureCloses.map((control) => ({
        surface: {
          id: `ui-control:${control.source}:${selectorForBrowserDisclosureInventory(control.id)}@${control.source}#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `${control.source}:${selectorForBrowserDisclosureInventory(control.id)}`,
          source: control.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: selectorForBrowserDisclosureInventory(control.id),
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-disclosure-open-with-current-page",
        expectedEffect: `${control.id} closes its exactly owned Browser panel after a native click`,
        oracleId: control.oracleId,
        cleanupId: "ui:collapse-browser-disclosure-abort-task-and-restore-window",
      })),
      {
        surface: {
          id: `ui-control:${browserDownloadFolderControl.source}:${browserDownloadFolderControl.inventorySelector}@${browserDownloadFolderControl.source}#${browserDownloadFolderControl.occurrence}`,
          kind: "ui-control" as const,
          name: `${browserDownloadFolderControl.source}:${browserDownloadFolderControl.inventorySelector}`,
          source: browserDownloadFolderControl.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: browserDownloadFolderControl.inventorySelector,
          elementTag: "input",
          driverFamily: "text-entry" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-download-folder-owned-baseline",
        expectedEffect: "Native text entry changes the Browser Downloads default folder before exact durable, panel, task, and window restoration.",
        oracleId: "ui:value-state-transition",
        cleanupId: "ui:restore-browser-download-folder-abort-task-and-restore-window",
      },
      {
        surface: {
          id: `ui-control:${browserRightSidebarToggleControl.source}:${browserRightSidebarToggleControl.inventorySelector}@${browserRightSidebarToggleControl.source}#${browserRightSidebarToggleControl.occurrence}`,
          kind: "ui-control" as const,
          name: `${browserRightSidebarToggleControl.source}:${browserRightSidebarToggleControl.inventorySelector}`,
          source: browserRightSidebarToggleControl.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: browserRightSidebarToggleControl.inventorySelector,
          elementTag: "input",
          driverFamily: "toggle" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-options-toggle-owned-baseline",
        expectedEffect: "A native click changes the Browser right-sidebar checkbox and chrome reveal control before exact restoration.",
        oracleId: "ui:boolean-state-transition",
        cleanupId: "ui:restore-browser-options-toggle-abort-task-and-restore-window",
      },
      ...browserSidebarVisibilityControls.map((control) => ({
        surface: {
          id: `ui-control:${control.source}:${control.inventorySelector}@${control.source}#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `${control.source}:${control.inventorySelector}`,
          source: control.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: control.inventorySelector,
          elementTag: "button",
          driverFamily: "toggle" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-sidebar-opposite-baseline",
        expectedEffect: `A native click ${control.targetVisible ? "shows" : "hides"} the Browser right sidebar from an opposite prepared baseline.`,
        oracleId: "ui:activation:browser-sidebar-visibility-transition",
        cleanupId: "ui:restore-browser-sidebar-abort-task-and-restore-window",
      })),
      {
        surface: {
          id: `ui-control:${browserSidebarResizeControl.source}:${browserSidebarResizeControl.inventorySelector}@${browserSidebarResizeControl.source}#${browserSidebarResizeControl.occurrence}`,
          kind: "ui-control" as const,
          name: `${browserSidebarResizeControl.source}:${browserSidebarResizeControl.inventorySelector}`,
          source: browserSidebarResizeControl.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: browserSidebarResizeControl.inventorySelector,
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-sidebar-width-owned-baseline",
        expectedEffect: "Native keyboard input changes the Browser right-sidebar width by one exact bounded step before restoration.",
        oracleId: "ui:activation:browser-sidebar-width-transition",
        cleanupId: "ui:restore-browser-sidebar-width-abort-task-and-window",
      },
      {
        surface: {
          id: `ui-control:${browserHomepageControl.source}:${browserHomepageControl.inventorySelector}@${browserHomepageControl.source}#${browserHomepageControl.occurrence}`,
          kind: "ui-control" as const,
          name: `${browserHomepageControl.source}:${browserHomepageControl.inventorySelector}`,
          source: browserHomepageControl.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: browserHomepageControl.inventorySelector,
          elementTag: "input",
          driverFamily: "text-entry" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-options-text-input-owned-baseline",
        expectedEffect: "Native text entry changes the Browser homepage before exact renderer-local persistence, panel, task, and window restoration.",
        oracleId: "ui:value-state-transition",
        cleanupId: "ui:restore-browser-options-text-input-abort-task-and-window",
      },
      {
        surface: {
          id: `ui-control:${browserColorModeControl.source}:${browserColorModeControl.inventorySelector}@${browserColorModeControl.source}#${browserColorModeControl.occurrence}`,
          kind: "ui-control" as const,
          name: `${browserColorModeControl.source}:${browserColorModeControl.inventorySelector}`,
          source: browserColorModeControl.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: browserColorModeControl.inventorySelector,
          elementTag: "select",
          driverFamily: "selection" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-options-select-owned-baseline",
        expectedEffect: "Native selection changes the Browser color mode, applied root state, and renderer-local persistence before exact restoration.",
        oracleId: "ui:choice-state-transition",
        cleanupId: "ui:restore-browser-options-select-abort-task-and-window",
      },
      {
        surface: {
          id: `ui-control:${browserParallelAgentsControl.source}:${browserParallelAgentsControl.inventorySelector}@${browserParallelAgentsControl.source}#${browserParallelAgentsControl.occurrence}`,
          kind: "ui-control" as const,
          name: `${browserParallelAgentsControl.source}:${browserParallelAgentsControl.inventorySelector}`,
          source: browserParallelAgentsControl.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: browserParallelAgentsControl.inventorySelector,
          elementTag: "select",
          driverFamily: "selection" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-engine-select-owned-baseline",
        expectedEffect: "Native selection changes configured parallel Browser-agent capacity while preserving automation mode before exact restoration.",
        oracleId: "ui:choice-state-transition",
        cleanupId: "ui:restore-browser-engine-select-abort-task-and-window",
      },
      {
        surface: {
          id: `ui-control:${browserProfileControl.source}:${browserProfileControl.inventorySelector}@${browserProfileControl.source}#${browserProfileControl.occurrence}`,
          kind: "ui-control" as const,
          name: `${browserProfileControl.source}:${browserProfileControl.inventorySelector}`,
          source: browserProfileControl.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: browserProfileControl.inventorySelector,
          elementTag: "select",
          driverFamily: "selection" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-profile-select-owned-baseline",
        expectedEffect: "Native selection changes only the default profile for the next Browser action before exact restoration.",
        oracleId: "ui:choice-state-transition",
        cleanupId: "ui:restore-browser-profile-select-abort-task-and-window",
      },
      ...browserHistoryFilterControls.map((control) => ({
        surface: {
          id: `ui-control:src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-${control.id}\"]@src/browser/components/BrowserHistorySidecar.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-${control.id}\"]`,
          source: "src/browser/components/BrowserHistorySidecar.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: `[data-debug-id=\"shellx-browser-${control.id}\"]`,
          elementTag: control.elementTag,
          driverFamily: control.driverFamily,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-history-filter-owned-baseline",
        expectedEffect: `Native interaction changes ${control.id} from a distinct prepared baseline before exact restoration.`,
        oracleId: control.oracleId,
        cleanupId: "ui:restore-browser-history-filter-abort-task-and-window",
      })),
      ...browserBookmarkModeControls.map((control) => ({
        surface: {
          id: `ui-control:src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-${control.id}\"]@src/browser/components/BookmarkSidecar.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-${control.id}\"]`,
          source: "src/browser/components/BookmarkSidecar.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: `[data-debug-id=\"shellx-browser-${control.id}\"]`,
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-bookmark-mode-owned-baseline",
        expectedEffect: `Native click selects ${control.targetManageMode ? "Edit" : "List"} mode from an owned opposite baseline before exact restoration.`,
        oracleId: "ui:boolean-state-transition",
        cleanupId: "ui:restore-browser-bookmark-mode-abort-task-and-window",
      })),
      ...browserBookmarkDraftTextControls.map((control) => ({
        surface: {
          id: `ui-control:src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-${control.id}\"]@src/browser/components/BookmarkSidecar.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-${control.id}\"]`,
          source: "src/browser/components/BookmarkSidecar.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: `[data-debug-id=\"shellx-browser-${control.id}\"]`,
          elementTag: "input",
          driverFamily: "text-entry" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-bookmark-draft-text-owned-baseline",
        expectedEffect: `Native text entry changes the ${control.label} without creating a bookmark before exact restoration.`,
        oracleId: "ui:value-state-transition",
        cleanupId: "ui:restore-browser-bookmark-draft-text-abort-task-and-window",
      })),
      ...browserTransientTextControls.map((control) => ({
        surface: {
          id: `ui-control:${control.source}:[data-debug-id=\"shellx-browser-${control.id}\"]@${control.source}#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `${control.source}:[data-debug-id=\"shellx-browser-${control.id}\"]`,
          source: control.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: `[data-debug-id=\"shellx-browser-${control.id}\"]`,
          elementTag: control.elementTag,
          driverFamily: "text-entry" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-transient-text-owned-baseline",
        expectedEffect: `Native text entry changes the ${control.label} without submitting before exact restoration.`,
        oracleId: "ui:value-state-transition",
        cleanupId: "ui:restore-browser-transient-text-abort-task-and-window",
      })),
      ...browserTaskControls.map((control) => ({
        surface: {
          id: `ui-control:src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-${control.id}\"]@src/browser/components/AgentSidebar.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-${control.id}\"]`,
          source: "src/browser/components/AgentSidebar.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: `[data-debug-id=\"shellx-browser-${control.id}\"]`,
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-task-control-owned-task",
        expectedEffect: `A native operator click changes exactly one owned Browser task from ${control.precondition} to ${control.target}.`,
        oracleId: "ui:activation:browser-task-status-transition",
        cleanupId: "ui:finish-or-abort-browser-task-and-restore-window",
      })),
      {
        surface: {
          id: "ui-control:src/browser/components/BrowserEvidencePanel.tsx:[data-debug-id=\"shellx-browser-evidence-record\"]@src/browser/components/BrowserEvidencePanel.tsx#1",
          kind: "ui-control" as const,
          name: "src/browser/components/BrowserEvidencePanel.tsx:[data-debug-id=\"shellx-browser-evidence-record\"]",
          source: "src/browser/components/BrowserEvidencePanel.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id=\"shellx-browser-evidence-record\"]",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-evidence-current-task",
        expectedEffect: "A native click writes a bounded Flight Recorder identity receipt for the exact current task",
        oracleId: "ui:activation:browser-flight-recorder-identity",
        cleanupId: "ui:abort-owned-browser-task-and-restore-window",
      },
      {
        surface: {
          id: "ui-control:src/browser/components/BrowserEvidencePanel.tsx:[data-debug-id=\"shellx-browser-evidence-refresh\"]@src/browser/components/BrowserEvidencePanel.tsx#2",
          kind: "ui-control" as const,
          name: "src/browser/components/BrowserEvidencePanel.tsx:[data-debug-id=\"shellx-browser-evidence-refresh\"]",
          source: "src/browser/components/BrowserEvidencePanel.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id=\"shellx-browser-evidence-refresh\"]",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:browser-evidence-current-task",
        expectedEffect: "A native click completes one exact Flight Recorder evidence reload and publishes its local completion receipt",
        oracleId: "ui:activation:browser-evidence-manual-refresh",
        cleanupId: "ui:abort-owned-browser-task-and-restore-window",
      },
      {
        surface: {
          id: "ui-control:src/components/WorkPreviewPanel.tsx:[data-debug-id=\"surface-components-workpreviewpanel-3\"]@src/components/WorkPreviewPanel.tsx#3",
          kind: "ui-control" as const,
          name: "src/components/WorkPreviewPanel.tsx:[data-debug-id=\"surface-components-workpreviewpanel-3\"]",
          source: "src/components/WorkPreviewPanel.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id=\"surface-components-workpreviewpanel-3\"]",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:work-preview-owned-static-project",
        expectedEffect: "A native click starts ShellX Work Preview for an exact owned static project",
        oracleId: "ui:activation:work-preview-start-lifecycle",
        cleanupId: "ui:close-preview-center-stop-refresh-delete-project-and-restore-tab",
      },
      ...workPreviewRunningControls.map((control) => ({
        surface: {
          id: `ui-control:src/components/WorkPreviewPanel.tsx:[id=\"work-preview-${control.id}\"]@src/components/WorkPreviewPanel.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/WorkPreviewPanel.tsx:[id=\"work-preview-${control.id}\"]`,
          source: "src/components/WorkPreviewPanel.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: `[id=\"work-preview-${control.id}\"]`,
          elementTag: "button",
          driverFamily: control.driverFamily,
          eventTrust: "native-required" as const,
        },
        fixtureId: control.fixtureId,
        expectedEffect: `A native click proves the exact ${control.id} Work Preview control effect`,
        oracleId: control.oracleId,
        cleanupId: control.cleanupId,
      })),
      ...workPreviewSafeControls.map((control) => ({
        surface: {
          id: `ui-control:${control.source}:[id="${control.id}"]@${control.source}#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `${control.source}:[id="${control.id}"]`,
          source: control.source,
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: `[id="${control.id}"]`,
          elementTag: "button",
          driverFamily: control.driverFamily,
          eventTrust: "native-required" as const,
        },
        fixtureId: control.fixtureId,
        expectedEffect: `A native click proves the exact ${control.id} safe Work Preview effect`,
        oracleId: control.oracleId,
        cleanupId: control.cleanupId,
      })),
      ...filePreviewModeControls.map((control) => ({
        surface: {
          id: `ui-control:src/components/FilePreviewModal.tsx:[id="file-preview-mode-${control.mode === "safe" ? "safe-render" : "code"}"]@src/components/FilePreviewModal.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/FilePreviewModal.tsx:[id="file-preview-mode-${control.mode === "safe" ? "safe-render" : "code"}"]`,
          source: "src/components/FilePreviewModal.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: `[id="file-preview-mode-${control.mode === "safe" ? "safe-render" : "code"}"]`,
          elementTag: "button",
          driverFamily: "selection" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:file-preview-owned-html-mode",
        expectedEffect: `A native click proves exact ${control.name} File Preview ownership and safety state`,
        oracleId: "ui:selection-state-transition",
        cleanupId: "ui:close-delete-file-preview-and-restore-tab",
      })),
      ...filePreviewRunControls.map((control) => ({
        surface: {
          id: `ui-control:src/components/FilePreviewModal.tsx:[id="${control.id}"]@src/components/FilePreviewModal.tsx#${control.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/FilePreviewModal.tsx:[id="${control.id}"]`,
          source: "src/components/FilePreviewModal.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: `[id="${control.id}"]`,
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:file-preview-owned-html-run",
        expectedEffect: "A native click proves the exact owned File Preview to Work Preview lifecycle",
        oracleId: "ui:activation:file-preview-work-preview-lifecycle",
        cleanupId: "ui:stop-close-delete-file-preview-and-restore-tab",
      })),
      ...setupGuideControls.map((control) => ({
        surface: {
          id: control.id === "dismiss"
            ? "ui-control:src/components/ShellxSetupGuide.tsx:[data-debug-id=\"shellx-setup-guide-dismiss\"]@src/components/ShellxSetupGuide.tsx#2"
            : `ui-control:src/components/ShellxSetupGuide.tsx:[data-debug-id="shellx-setup-step-${control.id}"]@src/components/ShellxSetupGuide.tsx#1`,
          kind: "ui-control" as const,
          name: control.id === "dismiss"
            ? "src/components/ShellxSetupGuide.tsx:[data-debug-id=\"shellx-setup-guide-dismiss\"]"
            : `src/components/ShellxSetupGuide.tsx:[data-debug-id="shellx-setup-step-${control.id}"]`,
          source: "src/components/ShellxSetupGuide.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: control.id === "dismiss"
            ? "[data-debug-id=\"shellx-setup-guide-dismiss\"]"
            : `[data-debug-id="shellx-setup-step-${control.id}"]`,
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:setup-guide-destinations-closed",
        expectedEffect: `A native click proves the exact Setup Guide ${control.id} destination`,
        oracleId: control.oracleId,
        cleanupId: "ui:restore-setup-guide-destinations",
      })),
      {
        surface: {
          id: `ui-control:src/components/ActivityBrowserModal.tsx:${activitySearchClearControl.selector}@src/components/ActivityBrowserModal.tsx#${activitySearchClearControl.occurrence}`,
          kind: "ui-control" as const,
          name: `src/components/ActivityBrowserModal.tsx:${activitySearchClearControl.selector}`,
          source: "src/components/ActivityBrowserModal.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: activitySearchClearControl.selector,
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:activity-search-owned-value",
        expectedEffect: "A native click clears the exact owned Activity Browser search draft",
        oracleId: "ui:activation:activity-search-cleared",
        cleanupId: "ui:clear-activity-search-and-close",
      },
      {
        surface: {
          id: "ui-control:src/components/CommandPalette.tsx:[data-debug-id=\"surface-components-commandpalette-4\"]@src/components/CommandPalette.tsx#4",
          kind: "ui-control" as const,
          name: "src/components/CommandPalette.tsx:[data-debug-id=\"surface-components-commandpalette-4\"]",
          source: "src/components/CommandPalette.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
          selector: "[data-debug-id=\"surface-components-commandpalette-4\"]",
          elementTag: "button",
          driverFamily: "activation" as const,
          eventTrust: "native-required" as const,
        },
        fixtureId: "ui:command-palette-settings-action",
        expectedEffect: "A native click activates the exact Command Palette Settings row and opens Settings",
        oracleId: "ui:activation:settings-opened-from-command-palette",
        cleanupId: "ui:close-settings-and-command-palette",
      },
    ],
  };
}

function selectorForWorkPreviewKind(kind: typeof workPreviewKinds[number]): string {
  return `[id='work-preview-kind-${kind}']`;
}

function expectedWorkPreviewRunningClicks(control: typeof workPreviewRunningControls[number]): string[] {
  const start = "[data-debug-id='surface-components-workpreviewpanel-3']";
  const close = "[role='dialog'][aria-label='Preview Center'] [aria-label='Close']";
  const selector = `[id='work-preview-${control.id}']`;
  const refresh = "[id='work-preview-refresh-state']";
  if (control.id === "open" || control.id === "restart") return [start, close, selector, close, refresh];
  if (control.id === "stop") return [start, close, selector, refresh];
  if (control.id === "panel-open-external") return [start, close, selector, refresh];
  if (control.id === "stage-open-external") return [start, selector, close, refresh];
  if (control.id === "log-height-toggle") return [selector, selector];
  if (control.id === "viewport-phone") return [start, "[id='work-preview-viewport-desktop']", selector, "[id='work-preview-viewport-desktop']", close, refresh];
  if (control.id === "viewport-tablet") return [start, "[id='work-preview-viewport-desktop']", selector, "[id='work-preview-viewport-desktop']", close, refresh];
  if (control.id === "viewport-desktop") return [start, "[id='work-preview-viewport-phone']", selector, close, refresh];
  return [start, selector, close, refresh];
}

function expectedWorkPreviewSafeClicks(control: typeof workPreviewSafeControls[number]): string[] {
  const refresh = "[id='work-preview-refresh-state']";
  const close = "[role='dialog'][aria-label='Preview Center'] [aria-label='Close']";
  const selector = `[id='${control.id}']`;
  if (control.id === "work-preview-refresh-state") return [refresh, refresh];
  if (control.id === "work-preview-doctor") return [refresh, selector, refresh];
  return [refresh, selector, close, refresh];
}

function workPreviewKindOccurrence(kind: typeof workPreviewKinds[number]): number {
  return { auto: 8, static: 9, web: 10, expo: 11 }[kind];
}

function selectorForSettingsTab(tab: typeof settingsTabs[number]): string {
  return `[data-debug-id='settings-tab-${tab}']`;
}

function expectedConnectorDraftClicks(control: typeof connectorDraftControls[number]): string[] {
  const open = "[data-debug-id='settings-tab-connectors']";
  const openDraft = "[aria-label='Connector editor'] .connector-editor-head > button.settings-pill:not([aria-label])";
  const cancelDraft = "[aria-label='Cancel connector draft']";
  const restore = "[data-debug-id='settings-tab-general']";
  if (control.inventorySelector === "[data-debug-id=\"connector-approval-review-first\"]") {
    return [
      open,
      openDraft,
      "[data-debug-id='connector-approval-auto-dispatch']",
      "[data-debug-id='connector-approval-review-first']",
      cancelDraft,
      restore,
    ];
  }
  if (control.inventorySelector === "[data-debug-id=\"connector-approval-auto-dispatch\"]") {
    return [
      open,
      openDraft,
      "[data-debug-id='connector-approval-review-first']",
      "[data-debug-id='connector-approval-auto-dispatch']",
      "[data-debug-id='connector-approval-review-first']",
      cancelDraft,
      restore,
    ];
  }
  if (control.occurrence === 3) {
    return [
      open,
      openDraft,
      "[data-debug-id='surface-components-settings-connectorstab-3'][data-provider-kind='discord']",
      "[data-debug-id='surface-components-settings-connectorstab-3'][data-provider-kind='telegram']",
      cancelDraft,
      restore,
    ];
  }
  if (control.occurrence === 4) {
    return [
      open,
      openDraft,
      "[aria-label='Connector receiver state'] > button:last-child",
      "[aria-label='Connector receiver state'] > button:first-child",
      cancelDraft,
      restore,
    ];
  }
  if (control.occurrence === 5) {
    return [
      open,
      openDraft,
      "[aria-label='Connector receiver state'] > button:first-child",
      "[aria-label='Connector receiver state'] > button:last-child",
      "[aria-label='Connector receiver state'] > button:first-child",
      cancelDraft,
      restore,
    ];
  }
  if (control.occurrence === 6) {
    return [
      open,
      openDraft,
      "[aria-label='Connector delivery mode'] > button:last-child",
      "[aria-label='Connector delivery mode'] > button:first-child",
      cancelDraft,
      restore,
    ];
  }
  if (control.occurrence === 7) {
    return [
      open,
      openDraft,
      "[aria-label='Connector delivery mode'] > button:first-child",
      "[aria-label='Connector delivery mode'] > button:last-child",
      "[aria-label='Connector delivery mode'] > button:first-child",
      cancelDraft,
      restore,
    ];
  }
  if (control.occurrence === 21 || control.occurrence === 9 || control.occurrence === 10) {
    return [open, openDraft, cancelDraft, restore];
  }
  return [open, restore];
}

function expectedConnectorDraftLifecycleClicks(
  control: typeof connectorDraftLifecycleControls[number],
): string[] {
  const openSettings = "[data-debug-id='settings-tab-connectors']";
  const openDraft = "[aria-label='Connector editor'] .connector-editor-head > button.settings-pill:not([aria-label])";
  const cancelDraft = "[aria-label='Cancel connector draft']";
  const restore = "[data-debug-id='settings-tab-general']";
  return control.occurrence === 2
    ? [openSettings, openDraft, cancelDraft, restore]
    : [openSettings, openDraft, cancelDraft, openDraft, cancelDraft, restore];
}

function selectorForBrowserRightInventory(tab: typeof browserRightTabs[number]): string {
  return `[data-debug-id="shellx-browser-right-tab-${tab}"]`;
}

function selectorForBrowserRightTab(tab: typeof browserRightTabs[number]): string {
  return `[data-debug-id='shellx-browser-right-tab-${tab}']`;
}

function selectorForActivityInventory(view: typeof activityViews[number]): string {
  return `[data-debug-id="activity-tab-${view}"]`;
}

function selectorForActivityTab(view: typeof activityViews[number]): string {
  return `[data-debug-id='activity-tab-${view}']`;
}

function activityBaseline(view: typeof activityViews[number]): typeof activityViews[number] {
  return view === "files" ? "summary" : "files";
}

function selectorForVaultWorkspaceInventory(tab: typeof vaultWorkspaceTabs[number]): string {
  return `[data-debug-id="vault-tab-${tab}"]`;
}

function selectorForVaultWorkspaceTab(tab: typeof vaultWorkspaceTabs[number]): string {
  return `[data-debug-id='vault-tab-${tab}']`;
}

function vaultWorkspaceBaseline(tab: typeof vaultWorkspaceTabs[number]): typeof vaultWorkspaceTabs[number] {
  return tab === "secrets" ? "setup" : "secrets";
}

function selectorForVaultResourceInventory(tab: typeof vaultResourceFormTabs[number]): string {
  return `[data-debug-id="vault-resource-form-tab-${tab}"]`;
}

function selectorForVaultResourceFormTab(tab: typeof vaultResourceFormTabs[number]): string {
  return `[data-debug-id='vault-resource-form-tab-${tab}']`;
}

function selectorForVaultRequestQuickAction(id: typeof vaultRequestQuickActions[number]["id"]): string {
  return `[data-debug-id='vault-request-${id}']`;
}

function selectorForVaultRequestQuickActionInventory(id: typeof vaultRequestQuickActions[number]["id"]): string {
  return `[data-debug-id="vault-request-${id}"]`;
}

function vaultResourceBaseline(tab: typeof vaultResourceFormTabs[number]): typeof vaultResourceFormTabs[number] {
  return tab === "secret" ? "stripeAgentWallet" : "secret";
}

function selectorForBrowserDisclosureInventory(id: string): string {
  return `[data-debug-id="shellx-browser-${id}"]`;
}

function selectorForBrowserDisclosure(id: string): string {
  return `[data-debug-id='shellx-browser-${id}']`;
}

function runDriver(requestValue: ReleaseSurfaceDriverRequest): ReleaseSurfaceDriverReport {
  const requestPath = join(temp, "request.json");
  const reportPath = join(temp, "report.json");
  writeFileSync(requestPath, `${JSON.stringify(requestValue, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  if (run.status !== 0 && reportText) {
    const failedReport = JSON.parse(reportText) as ReleaseSurfaceDriverReport;
    const failedOutcomes = failedReport.outcomes.filter((outcome) => (
      outcome.present !== "pass"
      || outcome.invoke !== "pass"
      || outcome.effect !== "pass"
      || outcome.cleanup !== "pass"
    ));
    assert.fail([
      run.stderr,
      run.stdout,
      `failed outcomes: ${JSON.stringify(failedOutcomes, null, 2)}`,
    ].filter(Boolean).join("\n"));
  }
  assert.equal(run.status, 0, [run.stderr, run.stdout, reportText].filter(Boolean).join("\n"));
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.deepEqual(report.nativeWebDriver, requestValue.nativeWebDriver);
  return report;
}

function runBoundedDriver(requestValue: ReleaseSurfaceDriverRequest): ReleaseSurfaceDriverReport {
  const requestPath = join(temp, "bounded-request.json");
  const reportPath = join(temp, "bounded-report.json");
  writeFileSync(requestPath, `${JSON.stringify(requestValue, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 300_000 });
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  assert.equal(run.status, 0, [run.error?.message, run.stderr, run.stdout, reportText].filter(Boolean).join("\n"));
  return JSON.parse(reportText) as ReleaseSurfaceDriverReport;
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`UI control fixture exited before startup: ${await streamText(child.stderr)}`);
    }
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { candidatePort?: number; webdriverPort?: number };
      if (Number.isInteger(value.candidatePort) && Number.isInteger(value.webdriverPort)) {
        return { candidatePort: Number(value.candidatePort), webdriverPort: Number(value.webdriverPort) };
      }
    } catch {
      // The create-only state file is not ready yet.
    }
    await delay(50);
  }
  throw new Error("UI control fixture did not publish its ports");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    delay(2_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function streamText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
