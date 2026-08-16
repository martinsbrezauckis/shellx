import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import { cleanupOwnedBrowserLifecycle } from "../shellx-browser-test-cleanup";
import {
  clearReleaseSurfaceInstalledInputElement as clearReleaseSurfaceWebDriverElement,
  closeReleaseSurfaceInstalledInputWindow as closeReleaseSurfaceWebDriverWindow,
  clickReleaseSurfaceInstalledInputElement as clickReleaseSurfaceWebDriverElement,
  createReleaseSurfaceInstalledInputSession,
  findReleaseSurfaceInstalledInputElement as findReleaseSurfaceWebDriverElement,
  focusReleaseSurfaceInstalledInputMainWindow,
  observeReleaseSurfaceInstalledInputElement,
  performReleaseSurfaceInstalledInputKeyChord as performReleaseSurfaceWebDriverKeyChord,
  switchReleaseSurfaceInstalledInputWindow as switchReleaseSurfaceWebDriverWindow,
  switchReleaseSurfaceInstalledInputWindowByTitle as switchReleaseSurfaceWebDriverWindowByTitle,
  setReleaseSurfaceInstalledInputElementValue as setReleaseSurfaceWebDriverElementValue,
  waitForReleaseSurfaceInstalledInputElement as waitForReleaseSurfaceWebDriverElement,
  waitForReleaseSurfaceInstalledInputElementAbsent as waitForReleaseSurfaceWebDriverElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverOutcome,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  cleanupDebugApiSessionFixture,
  prepareDebugApiSessionFixture,
} from "./debug-api-session-fixture";
import {
  FIND_NEW_TAB_CLEANUPS,
  FIND_NEW_TAB_FIXTURES,
  FIND_NEW_TAB_ORACLES,
  exerciseFindNewTabControl,
  supportsFindNewTabControl,
} from "./ui-control-find-new-tab";
import {
  SAFE_UI_CONTROL_CLEANUPS,
  SAFE_UI_CONTROL_FIXTURES,
  SAFE_UI_CONTROL_ORACLES,
  exerciseSafeUiControlFamily,
  supportsSafeUiControlFamily,
} from "./ui-control-safe-families";
import {
  SAFE_VAULT_DRAFT_CLEANUPS,
  SAFE_VAULT_DRAFT_FIXTURES,
  SAFE_VAULT_DRAFT_ORACLES,
  exerciseSafeVaultDraftControl,
  supportsSafeVaultDraftControl,
} from "./ui-control-safe-vault-drafts";
import {
  VAULT_OWNED_EDIT_CLEANUPS,
  VAULT_OWNED_EDIT_FIXTURES,
  VAULT_OWNED_EDIT_ORACLES,
  exerciseOwnedVaultEditControl,
  supportsOwnedVaultEditControl,
} from "./ui-control-vault-owned-edit";
import {
  FILE_PREVIEW_SAFE_CLEANUPS,
  FILE_PREVIEW_SAFE_FIXTURES,
  FILE_PREVIEW_SAFE_ORACLES,
  exerciseFilePreviewSafeControl,
  supportsFilePreviewSafeControl,
} from "./ui-control-file-preview-safe";
import {
  ATTACHMENT_MEDIA_SAFE_CLEANUPS,
  ATTACHMENT_MEDIA_SAFE_FIXTURES,
  ATTACHMENT_MEDIA_SAFE_ORACLES,
  exerciseAttachmentMediaSafeControl,
  supportsAttachmentMediaSafeControl,
} from "./ui-control-attachment-media-safe";
import {
  PLUGINS_SAFE_CLEANUPS,
  PLUGINS_SAFE_FIXTURES,
  PLUGINS_SAFE_ORACLES,
  exercisePluginsSafeControl,
  supportsPluginsSafeControl,
} from "./ui-control-plugins-safe";
import {
  BUILD_PLAN_REVIEW_SAFE_CLEANUPS,
  BUILD_PLAN_REVIEW_SAFE_FIXTURES,
  BUILD_PLAN_REVIEW_SAFE_ORACLES,
  exerciseBuildPlanReviewSafeControl,
  supportsBuildPlanReviewSafeControl,
} from "./ui-control-build-plan-review-safe";
import {
  SHELLXAGENT_LIFECYCLE_CLEANUPS,
  SHELLXAGENT_LIFECYCLE_FIXTURES,
  SHELLXAGENT_LIFECYCLE_ORACLES,
  exerciseShellxagentLifecycleControl,
  supportsShellxagentLifecycleControl,
} from "./ui-control-shellxagent-lifecycle";
import {
  REMOTE_CWD_LIFECYCLE_CLEANUPS,
  REMOTE_CWD_LIFECYCLE_FIXTURES,
  REMOTE_CWD_LIFECYCLE_ORACLES,
  exerciseRemoteCwdLifecycleControl,
  supportsRemoteCwdLifecycleControl,
} from "./ui-control-remote-cwd-lifecycle";
import {
  SETUP_GUIDE_CLEANUPS,
  SETUP_GUIDE_FIXTURES,
  SETUP_GUIDE_ORACLES,
  exerciseSetupGuideControl,
  supportsSetupGuideControl,
} from "./ui-control-setup-guide";
import {
  OWNED_BROWSER_BOOKMARK_CLEANUPS,
  OWNED_BROWSER_BOOKMARK_FIXTURES,
  OWNED_BROWSER_BOOKMARK_ORACLES,
  OWNED_BROWSER_TAB_CLEANUPS,
  OWNED_BROWSER_TAB_FIXTURES,
  OWNED_BROWSER_TAB_ORACLES,
  exerciseOwnedBrowserBookmarkControl,
  exerciseOwnedBrowserTabControl,
  supportsOwnedBrowserBookmarkControl,
  supportsOwnedBrowserTabControl,
} from "./ui-control-owned-browser-bookmarks";
import {
  WORK_PREVIEW_KIND_CLEANUPS,
  WORK_PREVIEW_KIND_FIXTURES,
  exerciseWorkPreviewKindControl,
  supportsWorkPreviewKindControl,
} from "./ui-control-work-preview-kind";
import {
  WORK_PREVIEW_RUNNING_CLEANUPS,
  WORK_PREVIEW_RUNNING_FIXTURES,
  WORK_PREVIEW_RUNNING_ORACLES,
  exerciseWorkPreviewRunningControl,
  supportsWorkPreviewRunningControl,
} from "./ui-control-work-preview-running";
import {
  WORK_PREVIEW_SAFE_CLEANUPS,
  WORK_PREVIEW_SAFE_FIXTURES,
  WORK_PREVIEW_SAFE_ORACLES,
  exerciseWorkPreviewSafeControl,
  supportsWorkPreviewSafeControl,
} from "./ui-control-work-preview-safe";
import {
  WORK_PREVIEW_START_CLEANUPS,
  WORK_PREVIEW_START_FIXTURES,
  WORK_PREVIEW_START_ORACLES,
  exerciseWorkPreviewStartControl,
  supportsWorkPreviewStartControl,
} from "./ui-control-work-preview-start";
import {
  BROWSER_SHIELDS_CLEANUPS,
  BROWSER_SHIELDS_FIXTURES,
  BROWSER_SHIELDS_ORACLES,
  exerciseBrowserShieldsControl,
  supportsBrowserShieldsControl,
} from "./ui-control-browser-shields";
import {
  BROWSER_AD_MODE_CLEANUPS,
  BROWSER_AD_MODE_FIXTURES,
  BROWSER_AD_MODE_ORACLES,
  exerciseBrowserAdModeControl,
  supportsBrowserAdModeControl,
} from "./ui-control-browser-ad-modes";
import {
  OWNED_BROWSER_HISTORY_CLEANUPS,
  OWNED_BROWSER_HISTORY_FIXTURES,
  OWNED_BROWSER_HISTORY_ORACLES,
  exerciseOwnedBrowserHistoryControl,
  supportsOwnedBrowserHistoryControl,
} from "./ui-control-owned-browser-history";
import {
  BROWSER_PERSONAL_LOCK_CLEANUPS,
  BROWSER_PERSONAL_LOCK_FIXTURES,
  BROWSER_PERSONAL_LOCK_ORACLES,
  exerciseBrowserPersonalLockControl,
  supportsBrowserPersonalLockControl,
} from "./ui-control-browser-personal-lock-settings";
import {
  OWNED_BROWSER_BOOKMARK_NAV_CLEANUPS,
  OWNED_BROWSER_BOOKMARK_NAV_FIXTURES,
  OWNED_BROWSER_BOOKMARK_NAV_ORACLES,
  exerciseOwnedBrowserBookmarkNavigation,
  supportsOwnedBrowserBookmarkNavigation,
} from "./ui-control-owned-browser-bookmark-navigation";
import {
  RIGHT_RAIL_GOAL_CLEANUPS,
  RIGHT_RAIL_GOAL_FIXTURES,
  RIGHT_RAIL_GOAL_ORACLES,
  exerciseRightRailGoalControl,
  supportsRightRailGoalControl,
} from "./ui-control-right-rail-goal";
import {
  GOAL_PLAN_REVIEW_CLEANUPS,
  GOAL_PLAN_REVIEW_FIXTURES,
  GOAL_PLAN_REVIEW_ORACLES,
  exerciseGoalPlanReviewControl,
  supportsGoalPlanReviewControl,
} from "./ui-control-goal-plan-review";
import {
  CONNECTORS_OWNED_CLEANUPS,
  CONNECTORS_OWNED_FIXTURES,
  CONNECTORS_OWNED_ORACLES,
  exerciseOwnedConnectorsControl,
  supportsOwnedConnectorsControl,
} from "./ui-control-connectors-owned";
import { UI_CONTROL_INSTALLED_CONTROLLER_FILES } from "./ui-control-installed-manifest";
import {
  FILES_PANE_CLEANUPS,
  FILES_PANE_FIXTURES,
  FILES_PANE_ORACLES,
  exerciseFilesPaneControl,
  supportsFilesPaneControl,
} from "./ui-control-files-pane";
import {
  BUILD_RUN_COCKPIT_CLEANUPS,
  BUILD_RUN_COCKPIT_FIXTURES,
  BUILD_RUN_COCKPIT_ORACLES,
  exerciseBuildRunCockpitControl,
  supportsBuildRunCockpitControl,
} from "./ui-control-build-run-cockpit";
import {
  MISC_SAFE_UI_CLEANUPS,
  MISC_SAFE_UI_FIXTURES,
  MISC_SAFE_UI_ORACLES,
  exerciseMiscSafeUiControl,
  supportsMiscSafeUiControl,
} from "./ui-control-misc-safe";

const SETTINGS_TAB_CONTROLS = {
  "[data-debug-id=\"settings-tab-general\"]": "general",
  "[data-debug-id=\"settings-tab-vault\"]": "vault",
  "[data-debug-id=\"settings-tab-connections\"]": "connections",
  "[data-debug-id=\"settings-tab-connectors\"]": "connectors",
  "[data-debug-id=\"settings-tab-desktop\"]": "desktop",
  "[data-debug-id=\"settings-tab-shellxagent\"]": "shellxagent",
  "[data-debug-id=\"settings-tab-data\"]": "data",
  "[data-debug-id=\"settings-tab-about\"]": "about",
} as const;

const RIGHT_RAIL_TAB_CONTROLS = {
  "[data-debug-id=\"right-tab-tasks\"]": "Tasks",
  "[data-debug-id=\"right-tab-tooling\"]": "Tooling",
  "[data-debug-id=\"right-tab-git\"]": "Git",
  "[data-debug-id=\"right-tab-preview\"]": "Preview",
  "[data-debug-id=\"right-tab-plan\"]": "Plan",
  "[data-debug-id=\"right-tab-files\"]": "Files",
} as const;

const BROWSER_EVIDENCE_RECORD_SELECTOR = "[data-debug-id=\"shellx-browser-evidence-record\"]";
const BROWSER_EVIDENCE_REFRESH_SELECTOR = "[data-debug-id=\"shellx-browser-evidence-refresh\"]";
const HEADER_BROWSER_SELECTOR = "[data-debug-id=\"header-shellx-browser\"]";
const HEADER_THEME_SELECTOR = "[data-debug-id=\"header-theme-toggle\"]";
const OWNED_MODAL_TEXT_CONTROLS = {
  "src/components/ActivityBrowserModal.tsx:[data-debug-id=\"activity-search\"]": {
    openModal: "activity",
    dialog: "[role='dialog'][aria-label='Activity Browser']",
    control: "[data-debug-id='activity-search']",
    value: "shellx-final-owned-activity-query",
    label: "Activity Browser search",
  },
  "src/components/ConnectorInboxModal.tsx:[data-debug-id=\"connector-inbox-search-input\"]": {
    openModal: "connectorInbox",
    dialog: "[role='dialog'][aria-label='Connector inbox']",
    control: "[data-debug-id='connector-inbox-search-input']",
    value: "shellx-final-owned-query",
    label: "Connector Inbox search",
  },
  "src/components/ConnectorInboxModal.tsx:[data-debug-id=\"connector-inbox-date-input\"]": {
    openModal: "connectorInbox",
    dialog: "[role='dialog'][aria-label='Connector inbox']",
    control: "[data-debug-id='connector-inbox-date-input']",
    value: "2026-07-30",
    label: "Connector Inbox date",
  },
  "src/components/PRCreateModal.tsx:[data-debug-id=\"pr-base-input\"]": {
    openModal: "pr",
    dialog: "[role='dialog'][aria-label='Create pull request']",
    control: "[data-debug-id='pr-base-input']",
    value: "shellx-final-owned-base",
    label: "pull-request base branch draft",
  },
  "src/components/PRCreateModal.tsx:[data-debug-id=\"pr-title-input\"]": {
    openModal: "pr",
    dialog: "[role='dialog'][aria-label='Create pull request']",
    control: "[data-debug-id='pr-title-input']",
    value: "ShellX final owned pull-request title",
    label: "pull-request title draft",
  },
  "src/components/PRCreateModal.tsx:[data-debug-id=\"pr-body-input\"]": {
    openModal: "pr",
    dialog: "[role='dialog'][aria-label='Create pull request']",
    control: "[data-debug-id='pr-body-input']",
    value: "ShellX final owned pull-request body",
    label: "pull-request body draft",
  },
} as const;
const ACTIVITY_SEARCH_CLEAR_SURFACE = "src/components/ActivityBrowserModal.tsx:[data-debug-id=\"activity-search-clear\"]";
const ACTIVITY_DIALOG_SELECTOR = "[role='dialog'][aria-label='Activity Browser']";
const ACTIVITY_SEARCH_SELECTOR = "[data-debug-id='activity-search']";
const ACTIVITY_SEARCH_CLEAR_SELECTOR = "[data-debug-id='activity-search-clear']";
const PR_APPROVAL_SELECTOR = "[data-debug-id='surface-components-prcreatemodal-8']";
const PR_APPROVAL_SURFACE = "src/components/PRCreateModal.tsx:[data-debug-id=\"surface-components-prcreatemodal-8\"]";
const PR_DRAFT_SURFACE = "src/components/PRCreateModal.tsx:role=button;name=\"Draft\"";
const PR_DRAFT_SELECTOR = ".pr-modal .settings-pills > button:first-child";
const PR_CANCEL_SURFACE = "src/components/PRCreateModal.tsx:role=button;name=\"Cancel\"";
const PR_CANCEL_SELECTOR = ".pr-modal .hardcap-buttons > button:first-child";
const CONNECTOR_INBOX_DIALOG = "[role='dialog'][aria-label='Connector inbox']";
const CONNECTOR_INBOX_REFRESH_SURFACE = "src/components/ConnectorInboxModal.tsx:[data-debug-id=\"surface-components-connectorinboxmodal-4\"]";
const CONNECTOR_INBOX_REFRESH_CONTROL = "[data-debug-id='surface-components-connectorinboxmodal-4']";
const CONNECTOR_INBOX_TAB_SURFACE = "src/components/ConnectorInboxModal.tsx:[data-debug-id=\"surface-components-connectorinboxmodal-9\"]";
const CONNECTOR_INBOX_CLEAR_SURFACE = "src/components/ConnectorInboxModal.tsx:role=button;name=\"Clear\"";
const CONNECTOR_INBOX_SETTINGS_SURFACE = "src/components/ConnectorInboxModal.tsx:role=button;name=\"Connectors settings\"";
const CONNECTOR_INBOX_SEARCH = "[data-debug-id='connector-inbox-search-input']";
const CONNECTOR_INBOX_DATE = "[data-debug-id='connector-inbox-date-input']";
const CONNECTOR_INBOX_CLEAR = ".connector-inbox-filters > button.settings-pill";
const CONNECTOR_INBOX_SETTINGS = ".connector-inbox-foot > button.settings-pill";
const CONNECTOR_INBOX_FILTERS = ["all", "telegram", "discord"] as const;
const RIGHT_RAIL_TEXT_CONTROLS = {
  "src/components/TasksPanel.tsx:[data-debug-id=\"tasks-filter-input\"]": {
    tab: "Tasks",
    control: "[data-debug-id='tasks-filter-input']",
    value: "shellx-final-task-filter",
    label: "Tasks filter",
  },
  "src/components/FilesPane.tsx:[data-debug-id=\"files-search-input\"]": {
    tab: "Files",
    control: "[data-debug-id='files-search-input']",
    value: "shellx-final-file-filter",
    label: "Files search",
  },
} as const;
const TASKS_TOGGLE_CONTROLS = {
  "[data-debug-id=\"tasks-show-all-tabs-checkbox\"]": {
    control: "[data-debug-id='tasks-show-all-tabs-checkbox']",
    label: "Tasks all-tabs filter",
  },
  "[data-debug-id=\"tasks-show-completed-checkbox\"]": {
    control: "[data-debug-id='tasks-show-completed-checkbox']",
    label: "Tasks completed filter",
  },
} as const;
const OVERLAY_TEXT_CONTROLS = {
  "src/components/CommandPalette.tsx:[data-debug-id=\"command-palette-input\"]": {
    openModal: "palette",
    dialog: "[role='dialog'][aria-label='Command palette']",
    control: "[data-debug-id='command-palette-input']",
    value: "shellx-final-command-query",
    label: "Command Palette query",
  },
} as const;
const COMMAND_PALETTE_ROW_SURFACE = "src/components/CommandPalette.tsx:[data-debug-id=\"surface-components-commandpalette-4\"]";
const COMMAND_PALETTE_DIALOG = "[role='dialog'][aria-label='Command palette']";
const COMMAND_PALETTE_SETTINGS_ROW = "[data-debug-id='surface-components-commandpalette-4'][data-palette-action-id='act-settings']";
const ALWAYS_VISIBLE_TEXT_CONTROLS = {
  "src/components/FindPopover.tsx:[data-debug-id=\"find-sessions-input\"]": {
    control: "[data-debug-id='find-sessions-input']",
    value: "shellx-final-session-query",
    label: "session finder",
    cleanupAbsent: ".find-popover",
  },
  "src/components/BottomPanel.tsx:[data-debug-id=\"composer-prompt\"]": {
    control: "[data-debug-id='composer-prompt']",
    value: "shellx-final-composer-draft",
    label: "composer draft",
    cleanupAbsent: null,
  },
} as const;
const FIND_POPOVER_FOCUS_SURFACE = "src/components/FindPopover.tsx:[data-debug-id=\"surface-components-findpopover-1\"]";
const FIND_POPOVER_FOCUS_CONTROL = "[data-debug-id='surface-components-findpopover-1']";
const FIND_POPOVER_INPUT = "[data-debug-id='find-sessions-input']";
const FIND_POPOVER_PANEL = ".find-popover";
const FIND_OPEN_ROW_SURFACE = "src/components/FindPopover.tsx:[data-debug-id=\"surface-components-findpopover-3\"]";
const FIND_OPEN_ROW_CONTROL = "[data-debug-id='surface-components-findpopover-3']";
const FIND_OPEN_ROW_SELECTED = "[data-debug-id='surface-components-findpopover-3'][aria-selected='true']";
const FIND_PREVIEW_PANEL = ".find-preview";
const FIND_DISK_ROW_SURFACE = "src/components/FindPopover.tsx:[data-debug-id=\"surface-components-findpopover-4\"]";
const FIND_DISK_ROW_CONTROL = "[data-debug-id='surface-components-findpopover-4']";
const FIND_DISK_ROW_SELECTED = "[data-debug-id='surface-components-findpopover-4'][aria-selected='true']";
const SETTINGS_TEXT_CONTROLS = {
  "src/components/settings/GeneralTab.tsx:[data-debug-id=\"settings-browser-download-folder\"]": {
    control: "[data-debug-id='settings-browser-download-folder']",
    value: "shellx-final-owned-download-folder",
    label: "Browser download folder",
  },
} as const;
const BROWSER_DOWNLOAD_FOLDER_TEXT_CONTROLS = {
  "src/browser/components/DownloadSidecar.tsx:[data-debug-id=\"shellx-browser-download-folder\"]": {
    owner: "[data-debug-id=\"shellx-browser-downloads-menu\"]",
    panel: "#shellx-browser-download-sidecar[aria-labelledby='shellx-browser-downloads-menu']",
    control: "[data-debug-id='shellx-browser-download-folder']",
    value: "shellx-final-owned-browser-sidecar-download-folder",
    label: "Browser Downloads default folder",
  },
} as const;
const BROWSER_OPTIONS_TOGGLE_CONTROLS = {
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-toggle-right-sidebar\"]": {
    owner: "[data-debug-id=\"shellx-browser-options\"]",
    panel: "#shellx-browser-options-sidecar[aria-labelledby='shellx-browser-options']",
    control: "[data-debug-id='shellx-browser-toggle-right-sidebar']",
    label: "Browser right sidebar",
  },
} as const;
const BROWSER_SIDEBAR_VISIBILITY_CONTROLS = {
  "src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-toggle-right-sidebar-button\"]": {
    control: "[data-debug-id='shellx-browser-toggle-right-sidebar-button']",
    targetVisible: false,
    label: "hide Browser right sidebar",
  },
  "src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-show-right-sidebar-button\"]": {
    control: "[data-debug-id='shellx-browser-show-right-sidebar-button']",
    targetVisible: true,
    label: "show Browser right sidebar",
  },
} as const;
const BROWSER_SIDEBAR_RESIZE_CONTROLS = {
  "src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-sidebar-resize\"]": {
    control: "[data-debug-id='shellx-browser-sidebar-resize']",
    label: "Browser right-sidebar width",
  },
} as const;
const BROWSER_OPTIONS_TEXT_CONTROLS = {
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-homepage\"]": {
    owner: "[data-debug-id=\"shellx-browser-options\"]",
    panel: "#shellx-browser-options-sidecar[aria-labelledby='shellx-browser-options']",
    control: "[data-debug-id='shellx-browser-homepage']",
    value: "https://shellx.invalid/final-surface-home",
    label: "Browser homepage",
  },
} as const;
const BROWSER_OPTIONS_SELECT_CONTROLS = {
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-color-mode\"]": {
    owner: "[data-debug-id=\"shellx-browser-options\"]",
    panel: "#shellx-browser-options-sidecar[aria-labelledby='shellx-browser-options']",
    control: "[data-debug-id='shellx-browser-color-mode']",
    label: "Browser color mode",
  },
} as const;
const BROWSER_ENGINE_SELECT_CONTROLS = {
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-parallel-agents\"]": {
    owner: "[data-debug-id=\"shellx-browser-options\"]",
    panel: "#shellx-browser-options-sidecar[aria-labelledby='shellx-browser-options']",
    control: "[data-debug-id='shellx-browser-parallel-agents']",
    label: "parallel Browser agents",
  },
} as const;
const BROWSER_PROFILE_SELECT_CONTROLS = {
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-profile-select\"]": {
    owner: "[data-debug-id=\"shellx-browser-options\"]",
    panel: "#shellx-browser-options-sidecar[aria-labelledby='shellx-browser-options']",
    control: "[data-debug-id='shellx-browser-profile-select']",
    label: "Browser default profile",
  },
} as const;
const BROWSER_HISTORY_FILTER_CONTROLS = {
  "src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-history-search\"]": {
    kind: "text",
    control: "[data-debug-id='shellx-browser-history-search']",
    value: "shellx-final-history-query",
    label: "Browser history search",
  },
  "src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-history-date-filter\"]": {
    kind: "choice",
    control: "[data-debug-id='shellx-browser-history-date-filter']",
    value: "today",
    optionLabel: "Today",
    label: "Browser history date filter",
  },
  "src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-history-user\"]": {
    kind: "scope",
    control: "[data-debug-id='shellx-browser-history-user']",
    value: "user",
    label: "Browser user-history scope",
  },
  "src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-history-agent\"]": {
    kind: "scope",
    control: "[data-debug-id='shellx-browser-history-agent']",
    value: "agent",
    label: "Browser agent-history scope",
  },
} as const;
const BROWSER_HISTORY_OWNER = "[data-debug-id=\"shellx-browser-history-menu\"]";
const BROWSER_HISTORY_PANEL = "#shellx-browser-history-sidecar[aria-labelledby='shellx-browser-history-menu']";
const BROWSER_BOOKMARK_MODE_CONTROLS = {
  "src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-bookmark-list-mode\"]": {
    control: "[data-debug-id='shellx-browser-bookmark-list-mode']",
    targetManageMode: false,
    label: "Browser bookmark List mode",
  },
  "src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-bookmark-manager-toggle\"]": {
    control: "[data-debug-id='shellx-browser-bookmark-manager-toggle']",
    targetManageMode: true,
    label: "Browser bookmark Edit mode",
  },
} as const;
const BROWSER_BOOKMARK_DRAFT_TEXT_CONTROLS = {
  "src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-bookmark-draft-label\"]": {
    control: "[data-debug-id='shellx-browser-bookmark-draft-label']",
    value: "shellx-final-owned-bookmark-name",
    label: "Browser bookmark draft name",
  },
  "src/browser/components/BookmarkSidecar.tsx:[data-debug-id=\"shellx-browser-bookmark-draft-url\"]": {
    control: "[data-debug-id='shellx-browser-bookmark-draft-url']",
    value: "https://shellx.invalid/final-owned-bookmark",
    label: "Browser bookmark draft URL",
  },
} as const;
const BROWSER_BOOKMARK_OWNER = "[data-debug-id=\"shellx-browser-bookmarks-menu\"]";
const BROWSER_BOOKMARK_PANEL = "#shellx-browser-bookmark-manager-dock[aria-labelledby='shellx-browser-bookmarks-menu']";
const BROWSER_TRANSIENT_TEXT_CONTROLS = {
  "src/browser/components/BrowserChrome.tsx:[data-debug-id=\"shellx-browser-address\"]": {
    control: "[data-debug-id='shellx-browser-address']",
    value: "https://shellx.invalid/final-address-draft",
    label: "Browser address draft",
    rightPanel: null,
  },
  "src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-goal\"]": {
    control: "[data-debug-id='shellx-browser-goal']",
    value: "ShellX final owned Browser agent draft",
    label: "Browser agent message draft",
    rightPanel: "chat",
  },
} as const;
const BROWSER_TASK_CONTROL_CONTROLS = {
  "src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-agent-pause\"]": {
    control: "[data-debug-id='shellx-browser-agent-pause']",
    panel: "chat",
    precondition: "running",
    target: "paused",
    label: "Pause",
  },
  "src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-agent-resume\"]": {
    control: "[data-debug-id='shellx-browser-agent-resume']",
    panel: "chat",
    precondition: "paused",
    target: "running",
    label: "Resume",
  },
  "src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-agent-takeover\"]": {
    control: "[data-debug-id='shellx-browser-agent-takeover']",
    panel: "chat",
    precondition: "running",
    target: "userTakeover",
    label: "Takeover",
  },
  "src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-agent-abort\"]": {
    control: "[data-debug-id='shellx-browser-agent-abort']",
    panel: "chat",
    precondition: "running",
    target: "aborted",
    label: "Abort",
  },
  "src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-complete\"]": {
    control: "[data-debug-id='shellx-browser-complete']",
    panel: "actions",
    precondition: "running",
    target: "completed",
    label: "Complete",
  },
  "src/browser/components/AgentSidebar.tsx:[data-debug-id=\"shellx-browser-block\"]": {
    control: "[data-debug-id='shellx-browser-block']",
    panel: "actions",
    precondition: "running",
    target: "blocked",
    label: "Block",
  },
} as const;
const SETTINGS_DIALOG_SELECTOR = "[role='dialog'][aria-label='Settings']";
const HEADER_VAULT_REQUEST_SELECTOR = "[data-debug-id=\"header-vault-request-center\"]";
const VAULT_REQUEST_POPOVER_SELECTOR = "[data-debug-id='vault-request-center-popover'][role='dialog']";
const VAULT_WORKSPACE_MODAL_SELECTOR = "[data-debug-id='vault-workspace-modal']";
const VAULT_PASSWORD_GENERATOR_SELECTOR = "[data-debug-id='vault-password-generator']";
const VAULT_PASSWORD_GENERATOR_CLOSE_SELECTOR = "[data-debug-id=\"vault-password-generator-close\"]";
const VAULT_PASSWORD_GENERATOR_LOCAL_CONTROLS = {
  "src/components/VaultPasswordGenerator.tsx:[data-debug-id=\"surface-components-vaultpasswordgenerator-5\"]": {
    kind: "length-range",
    control: "[data-debug-id='surface-components-vaultpasswordgenerator-5']",
    label: "Vault password length slider",
  },
  "src/components/VaultPasswordGenerator.tsx:[data-debug-id=\"vault-password-generator-length\"]": {
    kind: "length-number",
    control: "[data-debug-id='vault-password-generator-length']",
    label: "Vault password numeric length",
  },
  "src/components/VaultPasswordGenerator.tsx:[data-debug-id=\"surface-components-vaultpasswordgenerator-11\"]": {
    kind: "checkbox",
    control: "[data-debug-id='surface-components-vaultpasswordgenerator-11']",
    label: "Vault password lowercase character set",
  },
  "src/components/VaultPasswordGenerator.tsx::is([aria-label=\"Hide generated password\"],[aria-label=\"Reveal generated password\"])": {
    kind: "reveal",
    control: ":is([aria-label='Hide generated password'],[aria-label='Reveal generated password'])",
    label: "Vault generated-password visibility",
  },
} as const;
const VAULT_REQUEST_QUICK_ACTIONS = {
  "[data-debug-id=\"vault-request-open-vault\"]": { label: "Open Vault", effect: "overview" },
  "[data-debug-id=\"vault-request-new-secret\"]": { label: "New secret", effect: "newSecret" },
  "[data-debug-id=\"vault-request-generate-password\"]": { label: "Generate password", effect: "generator" },
} as const;
const BROWSER_RIGHT_PANEL_CONTROLS = {
  "[data-debug-id=\"shellx-browser-right-tab-chat\"]": "chat",
  "[data-debug-id=\"shellx-browser-right-tab-requests\"]": "requests",
  "[data-debug-id=\"shellx-browser-right-tab-actions\"]": "actions",
  "[data-debug-id=\"shellx-browser-right-tab-evidence\"]": "evidence",
  "[data-debug-id=\"shellx-browser-right-tab-errors\"]": "errors",
} as const;
const BROWSER_DISCLOSURE_CONTROLS = {
  "[data-debug-id=\"shellx-browser-trust-chip\"]": {
    label: "trust and shields",
    panel: "#shellx-browser-shields-panel[aria-labelledby='shellx-browser-trust-chip']",
  },
  "[data-debug-id=\"shellx-browser-downloads-menu\"]": {
    label: "downloads",
    panel: "#shellx-browser-download-sidecar[aria-labelledby='shellx-browser-downloads-menu']",
  },
  "[data-debug-id=\"shellx-browser-bookmarks-menu\"]": {
    label: "bookmarks",
    panel: "#shellx-browser-bookmark-manager-dock[aria-labelledby='shellx-browser-bookmarks-menu']",
  },
  "[data-debug-id=\"shellx-browser-history-menu\"]": {
    label: "history",
    panel: "#shellx-browser-history-sidecar[aria-labelledby='shellx-browser-history-menu']",
  },
  "[data-debug-id=\"shellx-browser-save-page\"]": {
    label: "save page",
    panel: "#shellx-browser-save-menu[aria-labelledby='shellx-browser-save-page']",
  },
  "[data-debug-id=\"shellx-browser-ad-filter\"]": {
    label: "ad filter",
    panel: "#shellx-browser-ad-filter-menu[aria-labelledby='shellx-browser-ad-filter']",
  },
  "[data-debug-id=\"shellx-browser-options\"]": {
    label: "Browser options",
    panel: "#shellx-browser-options-sidecar[aria-labelledby='shellx-browser-options']",
  },
  "[data-debug-id=\"shellx-browser-collapse-tasks\"]": {
    label: "Browser Tasks section",
    panel: "#shellx-browser-actions-tasks-section[aria-labelledby='shellx-browser-collapse-tasks']",
    rightPanel: "actions",
  },
  "[data-debug-id=\"shellx-browser-collapse-receipts\"]": {
    label: "Browser Receipts section",
    panel: "#shellx-browser-actions-receipts-section[aria-labelledby='shellx-browser-collapse-receipts']",
    rightPanel: "actions",
  },
  "[data-debug-id=\"shellx-browser-collapse-console\"]": {
    label: "Browser Page errors section",
    panel: "#shellx-browser-errors-console-section[aria-labelledby='shellx-browser-collapse-console']",
    rightPanel: "errors",
  },
} as const;
const BROWSER_DISCLOSURE_CLOSE_CONTROLS = {
  "[data-debug-id=\"shellx-browser-downloads-close\"]": {
    label: "downloads",
    owner: "[data-debug-id=\"shellx-browser-downloads-menu\"]",
    panel: "#shellx-browser-download-sidecar[aria-labelledby='shellx-browser-downloads-menu']",
  },
  "[data-debug-id=\"shellx-browser-bookmark-manager-close\"]": {
    label: "bookmarks",
    owner: "[data-debug-id=\"shellx-browser-bookmarks-menu\"]",
    panel: "#shellx-browser-bookmark-manager-dock[aria-labelledby='shellx-browser-bookmarks-menu']",
  },
  "[data-debug-id=\"shellx-browser-history-close\"]": {
    label: "history",
    owner: "[data-debug-id=\"shellx-browser-history-menu\"]",
    panel: "#shellx-browser-history-sidecar[aria-labelledby='shellx-browser-history-menu']",
  },
  "[data-debug-id=\"shellx-browser-options-close\"]": {
    label: "options",
    owner: "[data-debug-id=\"shellx-browser-options\"]",
    panel: "#shellx-browser-options-sidecar[aria-labelledby='shellx-browser-options']",
  },
} as const;
const TRACE_ACTION_SELECTOR = "[data-debug-id=\"bottom-action-trace\"]";
const ACTIVITY_VIEW_CONTROLS = {
  "[data-debug-id=\"activity-tab-files\"]": "files",
  "[data-debug-id=\"activity-tab-graph\"]": "graph",
  "[data-debug-id=\"activity-tab-evidence\"]": "evidence",
  "[data-debug-id=\"activity-tab-timeline\"]": "timeline",
  "[data-debug-id=\"activity-tab-summary\"]": "summary",
} as const;
const ACTIVITY_EVIDENCE_DYNAMIC_SELECTOR =
  "[data-debug-id^=\"activity-evidence-section-\"][data-debug-id$=\"-expand\"]";
const ACTIVITY_EVIDENCE_SECTIONS = ["changes", "reads", "commands", "git"] as const;
const AGENT_RUNS_REFRESH_SURFACE =
  "src/components/AgentRunsMonitor.tsx:[data-debug-id=\"tasks-agent-runs-refresh\"]";
const AGENT_RUNS_REFRESH_CONTROL = "[data-debug-id='tasks-agent-runs-refresh']";
const VAULT_WORKSPACE_CONTROLS = {
  "[data-debug-id=\"vault-tab-secrets\"]": "secrets",
  "[data-debug-id=\"vault-tab-grants\"]": "grants",
  "[data-debug-id=\"vault-tab-setup\"]": "setup",
} as const;
const VAULT_RESOURCE_FORM_CONTROLS = {
  "[data-debug-id=\"vault-resource-form-tab-secret\"]": "secret",
  "[data-debug-id=\"vault-resource-form-tab-profileCard\"]": "profileCard",
  "[data-debug-id=\"vault-resource-form-tab-stripeAgentWallet\"]": "stripeAgentWallet",
} as const;

type SettingsTab = typeof SETTINGS_TAB_CONTROLS[keyof typeof SETTINGS_TAB_CONTROLS];
type RightRailTab = typeof RIGHT_RAIL_TAB_CONTROLS[keyof typeof RIGHT_RAIL_TAB_CONTROLS];
type BrowserRightPanelTab = typeof BROWSER_RIGHT_PANEL_CONTROLS[keyof typeof BROWSER_RIGHT_PANEL_CONTROLS];
type ActivityView = typeof ACTIVITY_VIEW_CONTROLS[keyof typeof ACTIVITY_VIEW_CONTROLS];
type VaultWorkspaceTab = typeof VAULT_WORKSPACE_CONTROLS[keyof typeof VAULT_WORKSPACE_CONTROLS];
type VaultResourceFormTab = typeof VAULT_RESOURCE_FORM_CONTROLS[keyof typeof VAULT_RESOURCE_FORM_CONTROLS];
type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;

export const UI_CONTROL_INSTALLED_MANIFEST: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-control-installed",
  kind: "ui-control",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [...UI_CONTROL_INSTALLED_CONTROLLER_FILES],
  supportedFixtures: [
    "ui:browser-evidence-current-task",
    "ui:browser-window-closed",
    "ui:vault-request-center-closed",
    "ui:vault-request-center-open",
    "ui:vault-password-generator-open",
    "ui:browser-right-panel-opposite-baseline",
    "ui:activity-view-opposite-baseline",
    "ui:activity-evidence-unfocused-grid",
    "ui:vault-workspace-tab-opposite-baseline",
    "ui:vault-resource-form-tab-opposite-baseline",
    "ui:browser-disclosure-closed-with-current-page",
    "ui:browser-disclosure-open-with-current-page",
    "ui:isolated-default-theme",
    "ui:owned-modal-text-input-empty",
    "ui:activity-search-owned-value",
    "ui:pr-modal-approval-baseline",
    "ui:pr-modal-local-option-baseline",
    "ui:pr-modal-open",
    "ui:connector-inbox-filter-baseline",
    "ui:connector-inbox-active-filters",
    "ui:connector-inbox-open",
    "ui:right-rail-text-input-empty",
    "ui:tasks-toggle-owned-baseline",
    "ui:overlay-text-input-empty",
    "ui:always-visible-text-input-empty",
    "ui:find-open-row-visible",
    "ui:find-disk-row-visible",
    "ui:settings-text-input-owned-baseline",
    "ui:browser-download-folder-owned-baseline",
    "ui:browser-options-toggle-owned-baseline",
    "ui:browser-sidebar-opposite-baseline",
    "ui:browser-sidebar-width-owned-baseline",
    "ui:browser-options-text-input-owned-baseline",
    "ui:browser-options-select-owned-baseline",
    "ui:browser-engine-select-owned-baseline",
    "ui:browser-history-filter-owned-baseline",
    "ui:browser-bookmark-mode-owned-baseline",
    "ui:browser-bookmark-draft-text-owned-baseline",
    "ui:browser-transient-text-owned-baseline",
    "ui:vault-password-generator-local-baseline",
    "ui:browser-task-control-owned-task",
    "ui:browser-profile-select-owned-baseline",
    "ui:command-palette-settings-action",
    ...SAFE_UI_CONTROL_FIXTURES,
    ...SAFE_VAULT_DRAFT_FIXTURES,
    ...VAULT_OWNED_EDIT_FIXTURES,
    ...FIND_NEW_TAB_FIXTURES,
    ...FILE_PREVIEW_SAFE_FIXTURES,
    ...ATTACHMENT_MEDIA_SAFE_FIXTURES,
    ...PLUGINS_SAFE_FIXTURES,
    ...BUILD_PLAN_REVIEW_SAFE_FIXTURES,
    ...SHELLXAGENT_LIFECYCLE_FIXTURES,
    ...REMOTE_CWD_LIFECYCLE_FIXTURES,
    ...SETUP_GUIDE_FIXTURES,
    ...OWNED_BROWSER_BOOKMARK_FIXTURES,
    ...OWNED_BROWSER_TAB_FIXTURES,
    ...OWNED_BROWSER_HISTORY_FIXTURES,
    ...BROWSER_PERSONAL_LOCK_FIXTURES,
    ...OWNED_BROWSER_BOOKMARK_NAV_FIXTURES,
    ...WORK_PREVIEW_KIND_FIXTURES,
    ...WORK_PREVIEW_RUNNING_FIXTURES,
    ...WORK_PREVIEW_SAFE_FIXTURES,
    ...WORK_PREVIEW_START_FIXTURES,
    ...BROWSER_SHIELDS_FIXTURES,
    ...BROWSER_AD_MODE_FIXTURES,
    ...RIGHT_RAIL_GOAL_FIXTURES,
    ...FILES_PANE_FIXTURES,
    ...GOAL_PLAN_REVIEW_FIXTURES,
    ...BUILD_RUN_COCKPIT_FIXTURES,
    ...MISC_SAFE_UI_FIXTURES,
    ...CONNECTORS_OWNED_FIXTURES,
    "ui:agent-runs-monitor-fresh-mount",
    "ui:connector-inbox-manual-refresh-baseline",
  ],
  supportedCleanups: [
    "ui:abort-owned-browser-task-and-restore-window",
    "ui:close-browser-window-and-restore-main",
    "ui:close-vault-request-center",
    "ui:close-vault-request-action-effect",
    "ui:restore-browser-right-panel-and-window",
    "ui:restore-activity-view-and-close",
    "ui:restore-activity-evidence-focus-and-close",
    "ui:restore-vault-workspace-tab-and-close-settings",
    "ui:restore-vault-resource-form-tab-and-close-settings",
    "ui:collapse-browser-disclosure-abort-task-and-restore-window",
    "ui:restore-isolated-theme-baseline",
    "ui:close-owned-modal",
    "ui:clear-input-and-close-owned-modal",
    "ui:clear-activity-search-and-close",
    "ui:restore-pr-approval-and-close",
    "ui:restore-pr-local-option-and-close",
    "ui:restore-connector-inbox-filter-and-close",
    "ui:reset-connector-inbox-refresh-receipt-and-close",
    "ui:restore-settings-tab-and-close",
    "ui:clear-input-and-restore-right-rail",
    "ui:restore-tasks-toggle-and-right-rail",
    "ui:clear-input-and-close-overlay",
    "ui:clear-input-and-neutralize-focus",
    "ui:delete-owned-session-clear-input-and-neutralize-focus",
    "ui:restore-settings-input-tab-and-dialog",
    "ui:restore-browser-download-folder-abort-task-and-restore-window",
    "ui:restore-browser-options-toggle-abort-task-and-restore-window",
    "ui:restore-browser-sidebar-abort-task-and-restore-window",
    "ui:restore-browser-sidebar-width-abort-task-and-window",
    "ui:restore-browser-options-text-input-abort-task-and-window",
    "ui:restore-browser-options-select-abort-task-and-window",
    "ui:restore-browser-engine-select-abort-task-and-window",
    "ui:restore-browser-history-filter-abort-task-and-window",
    "ui:restore-browser-bookmark-mode-abort-task-and-window",
    "ui:restore-browser-bookmark-draft-text-abort-task-and-window",
    "ui:restore-browser-transient-text-abort-task-and-window",
    "ui:restore-vault-password-generator-local-state",
    "ui:finish-or-abort-browser-task-and-restore-window",
    "ui:restore-browser-profile-select-abort-task-and-window",
    "ui:close-settings-and-command-palette",
    ...SAFE_UI_CONTROL_CLEANUPS,
    ...SAFE_VAULT_DRAFT_CLEANUPS,
    ...VAULT_OWNED_EDIT_CLEANUPS,
    ...FIND_NEW_TAB_CLEANUPS,
    ...FILE_PREVIEW_SAFE_CLEANUPS,
    ...ATTACHMENT_MEDIA_SAFE_CLEANUPS,
    ...PLUGINS_SAFE_CLEANUPS,
    ...BUILD_PLAN_REVIEW_SAFE_CLEANUPS,
    ...SHELLXAGENT_LIFECYCLE_CLEANUPS,
    ...REMOTE_CWD_LIFECYCLE_CLEANUPS,
    ...SETUP_GUIDE_CLEANUPS,
    ...OWNED_BROWSER_BOOKMARK_CLEANUPS,
    ...OWNED_BROWSER_TAB_CLEANUPS,
    ...OWNED_BROWSER_HISTORY_CLEANUPS,
    ...BROWSER_PERSONAL_LOCK_CLEANUPS,
    ...OWNED_BROWSER_BOOKMARK_NAV_CLEANUPS,
    ...WORK_PREVIEW_KIND_CLEANUPS,
    ...WORK_PREVIEW_RUNNING_CLEANUPS,
    ...WORK_PREVIEW_SAFE_CLEANUPS,
    ...WORK_PREVIEW_START_CLEANUPS,
    ...BROWSER_SHIELDS_CLEANUPS,
    ...BROWSER_AD_MODE_CLEANUPS,
    ...RIGHT_RAIL_GOAL_CLEANUPS,
    ...FILES_PANE_CLEANUPS,
    ...GOAL_PLAN_REVIEW_CLEANUPS,
    ...BUILD_RUN_COCKPIT_CLEANUPS,
    ...MISC_SAFE_UI_CLEANUPS,
    ...CONNECTORS_OWNED_CLEANUPS,
    "ui:restore-agent-runs-monitor-and-right-rail",
  ],
  supportedOracles: [
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
    ...SAFE_VAULT_DRAFT_ORACLES,
    ...VAULT_OWNED_EDIT_ORACLES.filter((oracle) => (
      oracle !== "ui:value-state-transition" && oracle !== "ui:boolean-state-transition"
    )),
    ...SAFE_UI_CONTROL_ORACLES,
    ...FIND_NEW_TAB_ORACLES,
    ...FILE_PREVIEW_SAFE_ORACLES,
    ...ATTACHMENT_MEDIA_SAFE_ORACLES,
    ...PLUGINS_SAFE_ORACLES,
    ...BUILD_PLAN_REVIEW_SAFE_ORACLES,
    ...SHELLXAGENT_LIFECYCLE_ORACLES,
    ...REMOTE_CWD_LIFECYCLE_ORACLES,
    ...SETUP_GUIDE_ORACLES,
    ...OWNED_BROWSER_BOOKMARK_ORACLES,
    ...OWNED_BROWSER_TAB_ORACLES,
    ...OWNED_BROWSER_HISTORY_ORACLES,
    ...BROWSER_PERSONAL_LOCK_ORACLES,
    ...OWNED_BROWSER_BOOKMARK_NAV_ORACLES,
    ...WORK_PREVIEW_START_ORACLES,
    ...WORK_PREVIEW_RUNNING_ORACLES,
    ...BROWSER_SHIELDS_ORACLES,
    ...BROWSER_AD_MODE_ORACLES,
    ...RIGHT_RAIL_GOAL_ORACLES,
    ...FILES_PANE_ORACLES,
    ...GOAL_PLAN_REVIEW_ORACLES.filter((oracle) => oracle !== "ui:value-state-transition"),
    ...BUILD_RUN_COCKPIT_ORACLES,
    ...MISC_SAFE_UI_ORACLES,
    ...CONNECTORS_OWNED_ORACLES,
    "ui:activation:agent-runs-manual-refresh",
    ...WORK_PREVIEW_SAFE_ORACLES,
  ],
};

export async function executeUiControlInstalled(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes: ReleaseSurfaceDriverOutcome[] = [];
  for (const assignment of request.assignments) {
    if (process.env.SHELLX_RELEASE_DRIVER_TRACE === "1") {
      process.stderr.write(`[ui-control-installed] ${assignment.surface.name}\n`);
    }
    try {
      await focusReleaseSurfaceInstalledInputMainWindow(installedInput);
    } catch (error) {
      outcomes.push(finalizeOutcome({
        ...emptyOutcome(
          assignment,
          "The exact installed shellX main window could not be restored before this isolated assignment.",
        ),
        cleanup: "pass",
        error: `assignment baseline failed before fixture setup: ${error instanceof Error ? error.message : String(error)}`,
      }));
      continue;
    }
    const selector = assignment.surface.selector ?? "";
    if (selector === BROWSER_EVIDENCE_RECORD_SELECTOR || selector === BROWSER_EVIDENCE_REFRESH_SELECTOR) {
      outcomes.push(await exerciseBrowserEvidenceRecord(connection, installedInput, assignment));
    } else if (selector === HEADER_BROWSER_SELECTOR) {
      outcomes.push(await exerciseHeaderBrowser(connection, installedInput, assignment));
    } else if (selector === HEADER_THEME_SELECTOR) {
      outcomes.push(await exerciseHeaderThemeToggle(connection, installedInput, assignment));
    } else if (supportsOwnedBrowserBookmarkNavigation(assignment)) {
      outcomes.push(await exerciseOwnedBrowserBookmarkNavigation(connection, installedInput, assignment));
    } else if (supportsRightRailGoalControl(assignment)) {
      outcomes.push(await exerciseRightRailGoalControl(connection, installedInput, request, assignment));
    } else if (supportsFilesPaneControl(assignment)) {
      outcomes.push(await exerciseFilesPaneControl(connection, installedInput, request, assignment));
    } else if (supportsGoalPlanReviewControl(assignment)) {
      outcomes.push(await exerciseGoalPlanReviewControl(connection, installedInput, request, assignment));
    } else if (supportsBuildRunCockpitControl(assignment)) {
      outcomes.push(await exerciseBuildRunCockpitControl(connection, installedInput, request, assignment));
    } else if (supportsMiscSafeUiControl(assignment)) {
      outcomes.push(await exerciseMiscSafeUiControl(connection, installedInput, request, assignment));
    } else if (supportsOwnedConnectorsControl(assignment)) {
      outcomes.push(await exerciseOwnedConnectorsControl(connection, installedInput, assignment));
    } else if (supportsSafeUiControlFamily(assignment)) {
      outcomes.push(await exerciseSafeUiControlFamily(connection, installedInput, assignment));
    } else if (supportsOwnedVaultEditControl(assignment)) {
      outcomes.push(await exerciseOwnedVaultEditControl(connection, installedInput, assignment));
    } else if (supportsSafeVaultDraftControl(assignment)) {
      outcomes.push(await exerciseSafeVaultDraftControl(connection, installedInput, assignment));
    } else if (supportsFindNewTabControl(assignment)) {
      outcomes.push(await exerciseFindNewTabControl(connection, installedInput, request, assignment));
    } else if (supportsFilePreviewSafeControl(assignment)) {
      outcomes.push(await exerciseFilePreviewSafeControl(connection, installedInput, request, assignment));
    } else if (supportsAttachmentMediaSafeControl(assignment)) {
      outcomes.push(await exerciseAttachmentMediaSafeControl(connection, installedInput, request, assignment));
    } else if (supportsPluginsSafeControl(assignment)) {
      outcomes.push(await exercisePluginsSafeControl(connection, installedInput, assignment));
    } else if (supportsBuildPlanReviewSafeControl(assignment)) {
      outcomes.push(await exerciseBuildPlanReviewSafeControl(connection, installedInput, assignment));
    } else if (supportsShellxagentLifecycleControl(assignment)) {
      outcomes.push(await exerciseShellxagentLifecycleControl(connection, installedInput, assignment, request));
    } else if (supportsRemoteCwdLifecycleControl(assignment)) {
      outcomes.push(await exerciseRemoteCwdLifecycleControl(connection, installedInput, assignment));
    } else if (supportsSetupGuideControl(assignment)) {
      outcomes.push(await exerciseSetupGuideControl(connection, installedInput, assignment));
    } else if (supportsOwnedBrowserBookmarkControl(assignment)) {
      outcomes.push(await exerciseOwnedBrowserBookmarkControl(connection, installedInput, assignment));
    } else if (supportsOwnedBrowserTabControl(assignment)) {
      outcomes.push(await exerciseOwnedBrowserTabControl(connection, installedInput, assignment));
    } else if (supportsOwnedBrowserHistoryControl(assignment)) {
      outcomes.push(await exerciseOwnedBrowserHistoryControl(connection, installedInput, assignment));
    } else if (supportsBrowserPersonalLockControl(assignment)) {
      outcomes.push(await exerciseBrowserPersonalLockControl(connection, installedInput, assignment));
    } else if (supportsBrowserShieldsControl(assignment)) {
      outcomes.push(await exerciseBrowserShieldsControl(connection, installedInput, assignment));
    } else if (supportsBrowserAdModeControl(assignment)) {
      outcomes.push(await exerciseBrowserAdModeControl(connection, installedInput, assignment));
    } else if (supportsWorkPreviewKindControl(assignment)) {
      outcomes.push(await exerciseWorkPreviewKindControl(connection, installedInput, assignment));
    } else if (supportsWorkPreviewRunningControl(assignment)) {
      outcomes.push(await exerciseWorkPreviewRunningControl(connection, installedInput, request, assignment));
    } else if (supportsWorkPreviewSafeControl(assignment)) {
      outcomes.push(await exerciseWorkPreviewSafeControl(connection, installedInput, request, assignment));
    } else if (supportsWorkPreviewStartControl(assignment)) {
      outcomes.push(await exerciseWorkPreviewStartControl(connection, installedInput, request, assignment));
    } else if (assignment.surface.name === AGENT_RUNS_REFRESH_SURFACE) {
      outcomes.push(await exerciseAgentRunsRefreshControl(connection, installedInput, assignment));
    } else if (assignment.surface.name === ACTIVITY_SEARCH_CLEAR_SURFACE) {
      outcomes.push(await exerciseActivitySearchClear(connection, installedInput, assignment));
    } else if (assignment.surface.name === COMMAND_PALETTE_ROW_SURFACE) {
      outcomes.push(await exerciseCommandPaletteSettingsRow(connection, installedInput, assignment));
    } else if (ownedModalTextConfig(assignment)) {
      outcomes.push(await exerciseOwnedModalTextInput(connection, installedInput, assignment));
    } else if (assignment.surface.name === PR_APPROVAL_SURFACE) {
      outcomes.push(await exercisePrApprovalToggle(connection, installedInput, assignment));
    } else if (assignment.surface.name === PR_DRAFT_SURFACE) {
      outcomes.push(await exercisePrDraftToggle(connection, installedInput, assignment));
    } else if (assignment.surface.name === PR_CANCEL_SURFACE) {
      outcomes.push(await exercisePrCancel(connection, installedInput, assignment));
    } else if (assignment.surface.name === CONNECTOR_INBOX_REFRESH_SURFACE) {
      outcomes.push(await exerciseConnectorInboxRefresh(connection, installedInput, assignment));
    } else if (assignment.surface.name === CONNECTOR_INBOX_TAB_SURFACE) {
      outcomes.push(await exerciseConnectorInboxTabs(connection, installedInput, assignment));
    } else if (assignment.surface.name === CONNECTOR_INBOX_CLEAR_SURFACE) {
      outcomes.push(await exerciseConnectorInboxClear(connection, installedInput, assignment));
    } else if (assignment.surface.name === CONNECTOR_INBOX_SETTINGS_SURFACE) {
      outcomes.push(await exerciseConnectorInboxSettings(connection, installedInput, assignment));
    } else if (rightRailTextConfig(assignment)) {
      outcomes.push(await exerciseRightRailTextInput(connection, installedInput, assignment));
    } else if (selector in TASKS_TOGGLE_CONTROLS) {
      outcomes.push(await exerciseTasksToggle(connection, installedInput, assignment));
    } else if (overlayTextConfig(assignment)) {
      outcomes.push(await exerciseOverlayTextInput(connection, installedInput, assignment));
    } else if (alwaysVisibleTextConfig(assignment)) {
      outcomes.push(await exerciseAlwaysVisibleTextInput(installedInput, assignment));
    } else if (assignment.surface.name === FIND_POPOVER_FOCUS_SURFACE) {
      outcomes.push(await exerciseFindPopoverFocus(installedInput, assignment));
    } else if (assignment.surface.name === FIND_OPEN_ROW_SURFACE) {
      outcomes.push(await exerciseFindOpenRowSelection(installedInput, assignment));
    } else if (assignment.surface.name === FIND_DISK_ROW_SURFACE) {
      outcomes.push(await exerciseFindDiskRowSelection(installedInput, request, assignment));
    } else if (settingsTextConfig(assignment)) {
      outcomes.push(await exerciseSettingsTextInput(connection, installedInput, assignment));
    } else if (browserDownloadFolderTextConfig(assignment)) {
      outcomes.push(await exerciseBrowserDownloadFolderTextInput(connection, installedInput, assignment));
    } else if (browserOptionsToggleConfig(assignment)) {
      outcomes.push(await exerciseBrowserOptionsToggle(connection, installedInput, assignment));
    } else if (browserSidebarVisibilityConfig(assignment)) {
      outcomes.push(await exerciseBrowserSidebarVisibility(connection, installedInput, assignment));
    } else if (browserSidebarResizeConfig(assignment)) {
      outcomes.push(await exerciseBrowserSidebarResize(connection, installedInput, assignment));
    } else if (browserOptionsTextConfig(assignment)) {
      outcomes.push(await exerciseBrowserOptionsTextInput(connection, installedInput, assignment));
    } else if (browserOptionsSelectConfig(assignment)) {
      outcomes.push(await exerciseBrowserOptionsSelect(connection, installedInput, assignment));
    } else if (browserEngineSelectConfig(assignment)) {
      outcomes.push(await exerciseBrowserEngineSelect(connection, installedInput, assignment));
    } else if (browserProfileSelectConfig(assignment)) {
      outcomes.push(await exerciseBrowserProfileSelect(connection, installedInput, assignment));
    } else if (browserHistoryFilterConfig(assignment)) {
      outcomes.push(await exerciseBrowserHistoryFilter(connection, installedInput, assignment));
    } else if (browserBookmarkModeConfig(assignment)) {
      outcomes.push(await exerciseBrowserBookmarkMode(connection, installedInput, assignment));
    } else if (browserBookmarkDraftTextConfig(assignment)) {
      outcomes.push(await exerciseBrowserBookmarkDraftText(connection, installedInput, assignment));
    } else if (browserTransientTextConfig(assignment)) {
      outcomes.push(await exerciseBrowserTransientText(connection, installedInput, assignment));
    } else if (browserTaskControlConfig(assignment)) {
      outcomes.push(await exerciseBrowserTaskControl(connection, installedInput, assignment));
    } else if (selector === HEADER_VAULT_REQUEST_SELECTOR) {
      outcomes.push(await exerciseHeaderVaultRequestCenter(connection, installedInput, assignment));
    } else if (selector in VAULT_REQUEST_QUICK_ACTIONS) {
      outcomes.push(await exerciseVaultRequestQuickAction(connection, installedInput, assignment));
    } else if (selector === VAULT_PASSWORD_GENERATOR_CLOSE_SELECTOR) {
      outcomes.push(await exerciseVaultPasswordGeneratorClose(connection, installedInput, assignment));
    } else if (vaultPasswordGeneratorLocalConfig(assignment)) {
      outcomes.push(await exerciseVaultPasswordGeneratorLocalControl(connection, installedInput, assignment));
    } else if (selector in BROWSER_RIGHT_PANEL_CONTROLS) {
      outcomes.push(await exerciseBrowserRightPanelTab(connection, installedInput, assignment));
    } else if (selector in BROWSER_DISCLOSURE_CONTROLS) {
      outcomes.push(await exerciseBrowserDisclosure(connection, installedInput, assignment));
    } else if (selector in BROWSER_DISCLOSURE_CLOSE_CONTROLS) {
      outcomes.push(await exerciseBrowserDisclosureClose(connection, installedInput, assignment));
    } else if (selector in ACTIVITY_VIEW_CONTROLS) {
      outcomes.push(await exerciseActivityView(installedInput, assignment));
    } else if (selector === ACTIVITY_EVIDENCE_DYNAMIC_SELECTOR) {
      outcomes.push(await exerciseActivityEvidenceSections(installedInput, assignment));
    } else if (selector in VAULT_WORKSPACE_CONTROLS) {
      outcomes.push(await exerciseVaultWorkspaceTab(connection, installedInput, assignment));
    } else if (selector in VAULT_RESOURCE_FORM_CONTROLS) {
      outcomes.push(await exerciseVaultResourceFormTab(connection, installedInput, assignment));
    } else {
      outcomes.push(unsupportedOutcome(assignment, selector));
    }
  }
  return {
    schema: RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
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

async function exercisePrApprovalToggle(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native local pull-request approval toggle effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  let baseline: boolean | null = null;
  try {
    await postUi(connection, { openModal: "pr", source: "final-surface-pr-approval" });
    await waitForReleaseSurfaceWebDriverElement(webdriver, "[role='dialog'][aria-label='Create pull request']");
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, PR_APPROVAL_SELECTOR);
    baseline = await readOwnedCheckboxState(webdriver, PR_APPROVAL_SELECTOR);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForOwnedCheckboxState(webdriver, PR_APPROVAL_SELECTOR, !baseline);
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click changed only the local pull-request approval checkbox; no remote create action was invoked.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && baseline !== null) {
      try {
        const current = await readOwnedCheckboxState(webdriver, PR_APPROVAL_SELECTOR);
        if (current !== baseline) await clickReleaseSurfaceWebDriverElement(webdriver, control);
        await waitForOwnedCheckboxState(webdriver, PR_APPROVAL_SELECTOR, baseline);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      await postUi(connection, { openModal: "close", source: "final-surface-pr-approval-cleanup" });
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, "[role='dialog'][aria-label='Create pull request']");
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function exercisePrDraftToggle(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native local pull-request Draft toggle effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  let baseline: boolean | null = null;
  try {
    await postUi(connection, { openModal: "pr", source: "final-surface-pr-draft" });
    await waitForReleaseSurfaceWebDriverElement(webdriver, "[role='dialog'][aria-label='Create pull request']");
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, PR_DRAFT_SELECTOR);
    baseline = await readPrDraftState(webdriver);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForPrDraftState(webdriver, !baseline);
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click changed only the local pull-request Draft option; no remote create action was invoked.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && baseline !== null) {
      try {
        if (await readPrDraftState(webdriver) !== baseline) {
          await clickReleaseSurfaceWebDriverElement(webdriver, control);
        }
        await waitForPrDraftState(webdriver, baseline);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      await postUi(connection, { openModal: "close", source: "final-surface-pr-draft-cleanup" });
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, "[role='dialog'][aria-label='Create pull request']");
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function exercisePrCancel(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native pull-request Cancel effect was observed.");
  try {
    await postUi(connection, { openModal: "pr", source: "final-surface-pr-cancel" });
    await waitForReleaseSurfaceWebDriverElement(webdriver, "[role='dialog'][aria-label='Create pull request']");
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, PR_CANCEL_SELECTOR);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, "[role='dialog'][aria-label='Create pull request']");
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click closed the prepared pull-request modal without invoking its remote create action.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await postUi(connection, { openModal: "close", source: "final-surface-pr-cancel-cleanup" });
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, "[role='dialog'][aria-label='Create pull request']");
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function readPrDraftState(webdriver: WebDriver): Promise<boolean> {
  const state = await observeReleaseSurfaceInstalledInputElement(webdriver, PR_DRAFT_SELECTOR, ["pressed"]);
  if (!state.present || !state.visible || typeof state.pressed !== "boolean") {
    throw new Error("pull-request Draft state omitted pressed");
  }
  return state.pressed;
}

async function waitForPrDraftState(webdriver: WebDriver, expected: boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readPrDraftState(webdriver) === expected) return;
    await delay(50);
  }
  throw new Error(`pull-request Draft option did not reach active=${expected}`);
}

type ConnectorInboxFilterState = {
  filter: typeof CONNECTOR_INBOX_FILTERS[number];
  query: string;
  date: string;
};

type ConnectorInboxRefreshState = {
  present: true;
  disabled: boolean;
  sequence: number;
  completedAtMs: number | null;
  connectorCount: number | null;
  eventCount: number | null;
  maxEventMs: number | null;
};

async function exerciseConnectorInboxRefresh(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Connector Inbox manual-refresh receipt was observed.");
  try {
    await openConnectorInbox(connection, webdriver, "final-surface-connector-inbox-refresh");
    await waitForConnectorInboxRefreshBaseline(webdriver);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, CONNECTOR_INBOX_REFRESH_CONTROL);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    const receipt = await waitForSuccessfulConnectorInboxRefresh(webdriver);
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click completed manual Connector Inbox refresh ${receipt.sequence} at ${receipt.completedAtMs}, returning ${receipt.connectorCount} connectors and ${receipt.eventCount} events through its exact response receipt.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    try {
      await postUi(connection, { openModal: "close", source: "final-surface-connector-inbox-refresh-cleanup-reset" });
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, CONNECTOR_INBOX_DIALOG);
      await openConnectorInbox(connection, webdriver, "final-surface-connector-inbox-refresh-cleanup-probe");
      await waitForConnectorInboxRefreshBaseline(webdriver);
    } catch (error) {
      cleanupErrors.push(`receipt reset: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await postUi(connection, { openModal: "close", source: "final-surface-connector-inbox-refresh-cleanup-close" });
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, CONNECTOR_INBOX_DIALOG);
    } catch (error) {
      cleanupErrors.push(`modal close: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function waitForSuccessfulConnectorInboxRefresh(
  webdriver: WebDriver,
): Promise<ConnectorInboxRefreshState & {
  completedAtMs: number;
  connectorCount: number;
  eventCount: number;
  maxEventMs: number;
}> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readConnectorInboxRefreshState(webdriver);
    if (
      state.sequence === 1
      && state.completedAtMs !== null
      && state.connectorCount !== null
      && state.eventCount !== null
      && state.maxEventMs !== null
      && !state.disabled
    ) {
      return state as ConnectorInboxRefreshState & {
        completedAtMs: number;
        connectorCount: number;
        eventCount: number;
        maxEventMs: number;
      };
    }
    await delay(50);
  }
  throw new Error("Connector Inbox manual refresh did not publish one exact successful response receipt");
}

async function waitForConnectorInboxRefreshBaseline(webdriver: WebDriver): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readConnectorInboxRefreshState(webdriver);
    if (
      state.sequence === 0
      && state.completedAtMs === null
      && state.connectorCount === null
      && state.eventCount === null
      && state.maxEventMs === null
      && !state.disabled
    ) return;
    await delay(50);
  }
  throw new Error("Connector Inbox manual-refresh receipt did not reach its exact empty baseline");
}

async function readConnectorInboxRefreshState(webdriver: WebDriver): Promise<ConnectorInboxRefreshState> {
  const observation = await observeReleaseSurfaceInstalledInputElement(
    webdriver,
    CONNECTOR_INBOX_REFRESH_CONTROL,
    ["disabled", "title"],
  );
  if (!observation.present || !observation.visible || typeof observation.disabled !== "boolean") {
    throw new Error("Connector Inbox Refresh control is absent or omitted disabled state");
  }
  const match = observation.title?.match(
    /^Connector inbox refresh receipt · sequence=(\d+) · completedAtMs=(none|\d+) · connectors=(none|\d+) · events=(none|\d+) · maxEventMs=(none|\d+)$/,
  );
  if (!match) throw new Error("Connector Inbox Refresh omitted its bounded receipt title");
  const nullableNumber = (value: string | undefined): number | null => value === "none" ? null : Number(value);
  const state: ConnectorInboxRefreshState = {
    present: true,
    disabled: observation.disabled,
    sequence: Number(match[1]),
    completedAtMs: nullableNumber(match[2]),
    connectorCount: nullableNumber(match[3]),
    eventCount: nullableNumber(match[4]),
    maxEventMs: nullableNumber(match[5]),
  };
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 0) {
    throw new Error("Connector Inbox Refresh returned an invalid sequence");
  }
  for (const key of ["completedAtMs", "connectorCount", "eventCount", "maxEventMs"] as const) {
    const value = state[key];
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Connector Inbox Refresh returned invalid ${key}`);
    }
  }
  if (state.completedAtMs === 0) throw new Error("Connector Inbox Refresh returned an invalid completion time");
  return state;
}

async function exerciseConnectorInboxTabs(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Connector Inbox provider-tab effect was observed.");
  let baseline: ConnectorInboxFilterState | null = null;
  try {
    await openConnectorInbox(connection, webdriver, "final-surface-connector-inbox-tabs");
    baseline = await readConnectorInboxFilterState(webdriver);
    outcome.present = "pass";
    for (const filter of CONNECTOR_INBOX_FILTERS) {
      await selectConnectorInboxFilter(webdriver, filter);
    }
    outcome.invoke = "pass";
    const selected = await readConnectorInboxFilterState(webdriver);
    if (selected.filter !== "discord") throw new Error("Connector Inbox provider-tab sequence did not select its final concrete tab");
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver clicks selected All, Telegram, and Discord through the concrete Connector Inbox tab family.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    await cleanupConnectorInboxFilter(connection, webdriver, baseline, outcome, "final-surface-connector-inbox-tabs-cleanup");
  }
  return finalizeOutcome(outcome);
}

async function exerciseConnectorInboxClear(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Connector Inbox clear-filter effect was observed.");
  let baseline: ConnectorInboxFilterState | null = null;
  try {
    await openConnectorInbox(connection, webdriver, "final-surface-connector-inbox-clear");
    baseline = await readConnectorInboxFilterState(webdriver);
    await replaceConnectorInboxInput(webdriver, CONNECTOR_INBOX_SEARCH, "shellx-final-inbox-query");
    await replaceConnectorInboxInput(webdriver, CONNECTOR_INBOX_DATE, "2026-07-30");
    await selectConnectorInboxFilter(webdriver, "telegram");
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, CONNECTOR_INBOX_CLEAR);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForConnectorInboxFilterState(webdriver, { filter: "all", query: "", date: "" });
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click cleared the prepared Connector Inbox provider, search, and date filters together.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    await cleanupConnectorInboxFilter(connection, webdriver, baseline, outcome, "final-surface-connector-inbox-clear-cleanup");
  }
  return finalizeOutcome(outcome);
}

async function exerciseConnectorInboxSettings(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Connector Inbox to Settings navigation effect was observed.");
  let originalTab: SettingsTab | null = null;
  try {
    originalTab = await readStoredSettingsTab(connection);
    await openConnectorInbox(connection, webdriver, "final-surface-connector-inbox-settings");
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, CONNECTOR_INBOX_SETTINGS);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, CONNECTOR_INBOX_DIALOG);
    await waitForReleaseSurfaceWebDriverElement(webdriver, SETTINGS_DIALOG_SELECTOR);
    await waitForSettingsTab(webdriver, "connectors", "Connector Inbox Settings navigation");
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click closed Connector Inbox and opened Settings with the Connectors tab selected.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (originalTab) {
      try {
        if (originalTab !== "connectors") {
          const originalControl = await waitForReleaseSurfaceWebDriverElement(
            webdriver,
            webdriverSelector(selectorForSettingsTab(originalTab)),
          );
          await clickReleaseSurfaceWebDriverElement(webdriver, originalControl);
          await waitForSettingsTab(webdriver, originalTab, "Connector Inbox Settings cleanup");
        }
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      await postUi(connection, { openModal: "close", source: "final-surface-connector-inbox-settings-cleanup" });
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, SETTINGS_DIALOG_SELECTOR);
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, CONNECTOR_INBOX_DIALOG);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function openConnectorInbox(connection: Connection, webdriver: WebDriver, source: string): Promise<void> {
  await postUi(connection, { openModal: "connectorInbox", source });
  await waitForReleaseSurfaceWebDriverElement(webdriver, CONNECTOR_INBOX_DIALOG);
}

async function readConnectorInboxFilterState(webdriver: WebDriver): Promise<ConnectorInboxFilterState> {
  const [query, date, ...tabs] = await Promise.all([
    observeReleaseSurfaceInstalledInputElement(webdriver, CONNECTOR_INBOX_SEARCH, ["value"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, CONNECTOR_INBOX_DATE, ["value"]),
    ...CONNECTOR_INBOX_FILTERS.map((filter) => observeReleaseSurfaceInstalledInputElement(
      webdriver,
      `[data-debug-id='surface-components-connectorinboxmodal-9'][data-inbox='${filter}']`,
      ["selected"],
    )),
  ]);
  if (!query.present || !query.visible || typeof query.value !== "string"
    || !date.present || !date.visible || typeof date.value !== "string") {
    throw new Error("Connector Inbox filter state omitted query or date");
  }
  const selected = CONNECTOR_INBOX_FILTERS.filter((_filter, index) => {
    const tab = tabs[index];
    if (!tab?.present || !tab.visible || typeof tab.selected !== "boolean") {
      throw new Error("Connector Inbox filter state omitted a provider tab");
    }
    return tab.selected;
  });
  if (selected.length !== 1) throw new Error("Connector Inbox filter state must select exactly one provider");
  return {
    filter: selected[0]!,
    query: query.value,
    date: date.value,
  };
}

async function waitForConnectorInboxFilterState(
  webdriver: WebDriver,
  expected: ConnectorInboxFilterState,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await readConnectorInboxFilterState(webdriver);
    if (current.filter === expected.filter && current.query === expected.query && current.date === expected.date) return;
    await delay(50);
  }
  throw new Error(`Connector Inbox filters did not reach ${JSON.stringify(expected)}`);
}

async function selectConnectorInboxFilter(
  webdriver: WebDriver,
  filter: typeof CONNECTOR_INBOX_FILTERS[number],
): Promise<void> {
  const selector = `[data-debug-id='surface-components-connectorinboxmodal-9'][data-inbox='${filter}']`;
  const control = await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
  await clickReleaseSurfaceWebDriverElement(webdriver, control);
  const current = await readConnectorInboxFilterState(webdriver);
  if (current.filter !== filter) throw new Error(`Connector Inbox did not select ${filter}`);
}

async function replaceConnectorInboxInput(webdriver: WebDriver, selector: string, value: string): Promise<void> {
  const control = await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
  await replaceOwnedInputValue(webdriver, control, selector, value);
}

async function cleanupConnectorInboxFilter(
  connection: Connection,
  webdriver: WebDriver,
  baseline: ConnectorInboxFilterState | null,
  outcome: ReleaseSurfaceDriverOutcome,
  source: string,
): Promise<void> {
  const cleanupErrors: string[] = [];
  if (baseline) {
    try {
      const current = await readConnectorInboxFilterState(webdriver);
      if (current.query !== baseline.query) {
        await replaceConnectorInboxInput(webdriver, CONNECTOR_INBOX_SEARCH, baseline.query);
      }
      if (current.date !== baseline.date) {
        await replaceConnectorInboxInput(webdriver, CONNECTOR_INBOX_DATE, baseline.date);
      }
      if (current.filter !== baseline.filter) {
        await selectConnectorInboxFilter(webdriver, baseline.filter);
      }
      await waitForConnectorInboxFilterState(webdriver, baseline);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    await postUi(connection, { openModal: "close", source });
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, CONNECTOR_INBOX_DIALOG);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  if (cleanupErrors.length === 0) outcome.cleanup = "pass";
  else {
    const detail = cleanupErrors.join("; ");
    outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
  }
}

async function readOwnedCheckboxState(webdriver: WebDriver, selector: string): Promise<boolean> {
  const state = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["checked"]);
  if (!state.present || !state.visible || typeof state.checked !== "boolean") {
    throw new Error("owned checkbox state omitted checked");
  }
  return state.checked;
}

async function waitForOwnedCheckboxState(webdriver: WebDriver, selector: string, expected: boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readOwnedCheckboxState(webdriver, selector) === expected) return;
    await delay(50);
  }
  throw new Error(`owned checkbox did not reach checked=${expected}`);
}

async function exerciseAlwaysVisibleTextInput(
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = alwaysVisibleTextConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native always-visible text-entry effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    await clearReleaseSurfaceWebDriverElement(webdriver, control);
    await waitForOwnedInputValue(webdriver, config.control, "");
    outcome.present = "pass";
    await setReleaseSurfaceWebDriverElementValue(webdriver, control, config.value);
    outcome.invoke = "pass";
    await waitForOwnedInputValue(webdriver, config.control, config.value);
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver input changed the exactly owned ${config.label} without submitting it.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && config) {
      try {
        await clearReleaseSurfaceWebDriverElement(webdriver, control);
        await waitForOwnedInputValue(webdriver, config.control, "");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      const neutral = await waitForReleaseSurfaceWebDriverElement(webdriver, ".shell");
      await clickReleaseSurfaceWebDriverElement(webdriver, neutral);
      if (config?.cleanupAbsent) {
        await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, config.cleanupAbsent);
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function exerciseFindPopoverFocus(
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native session-finder focus effect was observed.");
  try {
    const neutral = await waitForReleaseSurfaceWebDriverElement(webdriver, ".shell");
    await clickReleaseSurfaceWebDriverElement(webdriver, neutral);
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, FIND_POPOVER_PANEL);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, FIND_POPOVER_FOCUS_CONTROL);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElement(webdriver, FIND_POPOVER_INPUT);
    await waitForReleaseSurfaceWebDriverElement(webdriver, FIND_POPOVER_PANEL);
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click focused the owned session finder and exposed its visible results popover.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      const neutral = await waitForReleaseSurfaceWebDriverElement(webdriver, ".shell");
      await clickReleaseSurfaceWebDriverElement(webdriver, neutral);
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, FIND_POPOVER_PANEL);
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function exerciseFindOpenRowSelection(
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native open-session row selection was observed.");
  try {
    const neutral = await waitForReleaseSurfaceWebDriverElement(webdriver, ".shell");
    await clickReleaseSurfaceWebDriverElement(webdriver, neutral);
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, FIND_POPOVER_PANEL);
    const shell = await waitForReleaseSurfaceWebDriverElement(webdriver, FIND_POPOVER_FOCUS_CONTROL);
    await clickReleaseSurfaceWebDriverElement(webdriver, shell);
    const row = await waitForReleaseSurfaceWebDriverElement(webdriver, FIND_OPEN_ROW_CONTROL);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, row);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElement(webdriver, FIND_OPEN_ROW_SELECTED);
    await waitForReleaseSurfaceWebDriverElement(webdriver, FIND_PREVIEW_PANEL);
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver clicks focused Find and selected its owned open-session row with a visible local preview.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      const neutral = await waitForReleaseSurfaceWebDriverElement(webdriver, ".shell");
      await clickReleaseSurfaceWebDriverElement(webdriver, neutral);
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, FIND_POPOVER_PANEL);
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function exerciseFindDiskRowSelection(
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native owned on-disk session selection was observed.");
  const fixture = prepareDebugApiSessionFixture(request, "ui_find_control");
  try {
    const neutral = await waitForReleaseSurfaceWebDriverElement(webdriver, ".shell");
    await clickReleaseSurfaceWebDriverElement(webdriver, neutral);
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, FIND_POPOVER_PANEL);
    const input = await waitForReleaseSurfaceWebDriverElement(webdriver, FIND_POPOVER_INPUT);
    await clearReleaseSurfaceWebDriverElement(webdriver, input);
    await setReleaseSurfaceWebDriverElementValue(webdriver, input, fixture.marker);
    const row = await waitForReleaseSurfaceWebDriverElement(webdriver, FIND_DISK_ROW_CONTROL);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, row);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElement(webdriver, FIND_DISK_ROW_SELECTED);
    await waitForReleaseSurfaceWebDriverElement(webdriver, FIND_PREVIEW_PANEL);
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver input found and selected one exact owned on-disk session row with a bounded local preview.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    try {
      const input = await waitForReleaseSurfaceWebDriverElement(webdriver, FIND_POPOVER_INPUT);
      await clearReleaseSurfaceWebDriverElement(webdriver, input);
      const neutral = await waitForReleaseSurfaceWebDriverElement(webdriver, ".shell");
      await clickReleaseSurfaceWebDriverElement(webdriver, neutral);
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, FIND_POPOVER_PANEL);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    const fixtureCleanup = cleanupDebugApiSessionFixture(fixture);
    if (fixtureCleanup) cleanupErrors.push(fixtureCleanup);
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

function alwaysVisibleTextConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return ALWAYS_VISIBLE_TEXT_CONTROLS[key as keyof typeof ALWAYS_VISIBLE_TEXT_CONTROLS];
}

async function exerciseSettingsTextInput(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = settingsTextConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native Settings text-entry effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  let baseline: PublicSettings | null = null;
  let originalTab: SettingsTab | null = null;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    baseline = await readPublicSettings(connection);
    originalTab = await readStoredSettingsTab(connection);
    await postUi(connection, { openModal: "settings", source: "final-surface-settings-text" });
    await waitForReleaseSurfaceWebDriverElement(webdriver, SETTINGS_DIALOG_SELECTOR);
    if (originalTab !== "general") {
      const generalTab = await waitForReleaseSurfaceWebDriverElement(
        webdriver,
        webdriverSelector(selectorForSettingsTab("general")),
      );
      await clickReleaseSurfaceWebDriverElement(webdriver, generalTab);
    }
    await waitForSettingsTab(webdriver, "general", "Settings text fixture setup");
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    await waitForOwnedInputValue(webdriver, config.control, baseline.browserDownloadFolder);
    outcome.present = "pass";
    await replaceOwnedInputValue(webdriver, control, config.control, config.value);
    outcome.invoke = "pass";
    const changed = await waitForPublicSettings(connection, {
      ...baseline,
      browserDownloadFolder: config.value,
    });
    if (JSON.stringify(changed) !== JSON.stringify({ ...baseline, browserDownloadFolder: config.value })) {
      throw new Error("native Settings text input changed fields outside its exact public owner");
    }
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver input changed the exactly owned ${config.label} and its durable public setting.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && baseline && config) {
      try {
        await replaceOwnedInputValue(
          webdriver,
          control,
          config.control,
          baseline.browserDownloadFolder,
        );
        await waitForPublicSettings(connection, baseline);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (originalTab && originalTab !== "general") {
      try {
        const originalControl = await waitForReleaseSurfaceWebDriverElement(
          webdriver,
          webdriverSelector(selectorForSettingsTab(originalTab)),
        );
        await clickReleaseSurfaceWebDriverElement(webdriver, originalControl);
        await waitForSettingsTab(webdriver, originalTab, "Settings text fixture tab cleanup");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      await postUi(connection, { openModal: "close", source: "final-surface-settings-text-cleanup" });
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, SETTINGS_DIALOG_SELECTOR);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

function settingsTextConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return SETTINGS_TEXT_CONTROLS[key as keyof typeof SETTINGS_TEXT_CONTROLS];
}

function browserDownloadFolderTextConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return BROWSER_DOWNLOAD_FOLDER_TEXT_CONTROLS[key as keyof typeof BROWSER_DOWNLOAD_FOLDER_TEXT_CONTROLS];
}

async function exerciseBrowserDownloadFolderTextInput(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = browserDownloadFolderTextConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native Browser Downloads text-entry effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  let baseline: PublicSettings | null = null;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    baseline = await readPublicSettings(connection);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: "Final surface native Browser Downloads default-folder proof",
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    await closeBrowserDisclosureIfOpen(webdriver, config.owner, config.panel);
    const owner = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(config.owner));
    await clickReleaseSurfaceWebDriverElement(webdriver, owner);
    await waitForReleaseSurfaceWebDriverElement(webdriver, config.panel);
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    await waitForOwnedInputValue(webdriver, config.control, baseline.browserDownloadFolder);
    outcome.present = "pass";
    await replaceOwnedInputValue(webdriver, control, config.control, config.value);
    outcome.invoke = "pass";
    const changed = await waitForPublicSettings(connection, {
      ...baseline,
      browserDownloadFolder: config.value,
    });
    if (JSON.stringify(changed) !== JSON.stringify({ ...baseline, browserDownloadFolder: config.value })) {
      throw new Error("native Browser Downloads input changed fields outside its exact public owner");
    }
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver input changed the exactly owned ${config.label} and its durable public setting.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && baseline && config) {
      try {
        await replaceOwnedInputValue(webdriver, control, config.control, baseline.browserDownloadFolder);
        await waitForPublicSettings(connection, baseline);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (config && browserWindowOpen) {
      try {
        await closeBrowserDisclosureIfOpen(webdriver, config.owner, config.panel);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (taskId) {
      try {
        await cleanupOwnedUiBrowserTask(connection, taskId, "final surface UI control");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (originalWindow) {
      try {
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

function browserOptionsToggleConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return BROWSER_OPTIONS_TOGGLE_CONTROLS[key as keyof typeof BROWSER_OPTIONS_TOGGLE_CONTROLS];
}

async function exerciseBrowserOptionsToggle(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = browserOptionsToggleConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native Browser Options toggle effect was observed.");
  let baseline: boolean | null = null;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface native ${config.label} toggle proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    await closeBrowserDisclosureIfOpen(webdriver, config.owner, config.panel);
    const owner = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(config.owner));
    await clickReleaseSurfaceWebDriverElement(webdriver, owner);
    await waitForReleaseSurfaceWebDriverElement(webdriver, config.panel);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    baseline = (await readBrowserRightSidebarState(webdriver, config.control)).checked;
    await waitForBrowserRightSidebarState(webdriver, config.control, baseline);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForBrowserRightSidebarState(webdriver, config.control, !baseline);
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click changed the ${config.label} checkbox and its exactly owned chrome reveal control.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (baseline !== null && config && browserWindowOpen) {
      try {
        const current = await readBrowserRightSidebarState(webdriver, config.control);
        if (current.checked !== baseline) {
          const control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
          await clickReleaseSurfaceWebDriverElement(webdriver, control);
        }
        await waitForBrowserRightSidebarState(webdriver, config.control, baseline);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (config && browserWindowOpen) {
      try {
        await closeBrowserDisclosureIfOpen(webdriver, config.owner, config.panel);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (taskId) {
      try {
        await cleanupOwnedUiBrowserTask(connection, taskId, "final surface UI control");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (originalWindow) {
      try {
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

function browserSidebarVisibilityConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return BROWSER_SIDEBAR_VISIBILITY_CONTROLS[key as keyof typeof BROWSER_SIDEBAR_VISIBILITY_CONTROLS];
}

function browserSidebarResizeConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return BROWSER_SIDEBAR_RESIZE_CONTROLS[key as keyof typeof BROWSER_SIDEBAR_RESIZE_CONTROLS];
}

async function readBrowserRightSidebarWidth(
  webdriver: WebDriver,
  selector: string,
): Promise<number> {
  const observation = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["title"]);
  const match = observation.title?.match(/^Resize right panel · width=(\d+)px · use Left\/Right arrows$/);
  const width = Number(match?.[1]);
  if (!observation.present || !observation.visible || !Number.isSafeInteger(width) || width <= 0) {
    throw new Error("Browser right-sidebar resize control did not expose one exact bounded width title");
  }
  return width;
}

async function waitForBrowserRightSidebarWidth(
  webdriver: WebDriver,
  selector: string,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readBrowserRightSidebarWidth(webdriver, selector) === expected) return;
    await delay(50);
  }
  throw new Error(`Browser right-sidebar width did not reach ${expected}px`);
}

function browserSidebarWidthKey(webdriver: WebDriver, increase: boolean): string {
  if (webdriver.transport === "native-webdriver") return increase ? "\uE012" : "\uE014";
  return increase ? "left" : "right";
}

async function exerciseBrowserSidebarResize(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = browserSidebarResizeConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native Browser sidebar width effect was observed.");
  let baselineWidth: number | null = null;
  let baselineVisible: boolean | null = null;
  let increased = false;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface native ${config.label} proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    baselineVisible = (await readBrowserRightSidebarState(webdriver, config.control)).checked;
    await setBrowserRightSidebarVisibility(webdriver, true, config.control);
    baselineWidth = await readBrowserRightSidebarWidth(webdriver, config.control);
    if (baselineWidth < 280 || baselineWidth > 560) {
      throw new Error(`Browser right-sidebar width ${baselineWidth}px is outside the declared 280..560 range`);
    }
    increased = baselineWidth <= 540;
    const expected = baselineWidth + (increased ? 20 : -20);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    await performReleaseSurfaceWebDriverKeyChord(webdriver, [browserSidebarWidthKey(webdriver, increased)]);
    outcome.invoke = "pass";
    await waitForBrowserRightSidebarWidth(webdriver, config.control, expected);
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver keyboard input changed the owned Browser right-sidebar width from ${baselineWidth}px to ${expected}px.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (baselineWidth !== null && config && browserWindowOpen) {
      try {
        const current = await readBrowserRightSidebarWidth(webdriver, config.control);
        if (current !== baselineWidth) {
          await performReleaseSurfaceWebDriverKeyChord(webdriver, [browserSidebarWidthKey(webdriver, !increased)]);
        }
        await waitForBrowserRightSidebarWidth(webdriver, config.control, baselineWidth);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (baselineVisible !== null && config && browserWindowOpen) {
      try {
        await setBrowserRightSidebarVisibility(webdriver, baselineVisible, config.control);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (taskId) {
      try {
        await cleanupOwnedUiBrowserTask(connection, taskId, "final surface UI control");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (originalWindow) {
      try {
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function exerciseBrowserSidebarVisibility(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = browserSidebarVisibilityConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native Browser sidebar visibility effect was observed.");
  let baseline: boolean | null = null;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface native ${config.label} proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    baseline = (await readBrowserRightSidebarState(webdriver, config.control)).checked;
    await setBrowserRightSidebarVisibility(webdriver, !config.targetVisible, config.control);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForBrowserRightSidebarState(webdriver, config.control, config.targetVisible);
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click changed the exactly owned control to ${config.label}.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (baseline !== null && config && browserWindowOpen) {
      try {
        await setBrowserRightSidebarVisibility(webdriver, baseline, config.control);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (taskId) {
      try {
        await cleanupOwnedUiBrowserTask(connection, taskId, "final surface UI control");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (originalWindow) {
      try {
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function setBrowserRightSidebarVisibility(
  webdriver: WebDriver,
  visible: boolean,
  stateSelector: string,
): Promise<void> {
  const current = await readBrowserRightSidebarState(webdriver, stateSelector);
  if (current.checked === visible) {
    await waitForBrowserRightSidebarState(webdriver, stateSelector, visible);
    return;
  }
  const selector = visible
    ? "[data-debug-id='shellx-browser-show-right-sidebar-button']"
    : "[data-debug-id='shellx-browser-toggle-right-sidebar-button']";
  const control = await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
  await clickReleaseSurfaceWebDriverElement(webdriver, control);
  await waitForBrowserRightSidebarState(webdriver, stateSelector, visible);
}

function browserOptionsTextConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return BROWSER_OPTIONS_TEXT_CONTROLS[key as keyof typeof BROWSER_OPTIONS_TEXT_CONTROLS];
}

async function exerciseBrowserOptionsTextInput(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = browserOptionsTextConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native Browser Options text-entry effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  let baseline: BrowserHomepageState | null = null;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface native ${config.label} text-entry proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    await closeBrowserDisclosureIfOpen(webdriver, config.owner, config.panel);
    const owner = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(config.owner));
    await clickReleaseSurfaceWebDriverElement(webdriver, owner);
    await waitForReleaseSurfaceWebDriverElement(webdriver, config.panel);
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    baseline = await readBrowserHomepageState(webdriver, config.control);
    outcome.present = "pass";
    await replaceOwnedInputValue(webdriver, control, config.control, config.value);
    outcome.invoke = "pass";
    await waitForBrowserHomepageState(webdriver, config.control, {
      value: config.value,
      storage: "custom",
    });
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver input changed the exactly owned ${config.label} and its renderer-local persistence.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && baseline && config) {
      try {
        await replaceOwnedInputValue(webdriver, control, config.control, baseline.value);
        await waitForBrowserHomepageState(webdriver, config.control, baseline);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (config && browserWindowOpen) {
      try {
        await closeBrowserDisclosureIfOpen(webdriver, config.owner, config.panel);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (taskId) {
      try {
        await cleanupOwnedUiBrowserTask(connection, taskId, "final surface UI control");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (originalWindow) {
      try {
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function readOwnedInputValue(webdriver: WebDriver, selector: string): Promise<string> {
  const observed = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["value"]);
  if (!observed.present || !observed.visible || typeof observed.value !== "string") {
    throw new Error("owned input state did not expose its declared bounded value");
  }
  return observed.value;
}

type BrowserHomepageState = { value: string; storage: "default" | "custom" };

async function readBrowserHomepageState(webdriver: WebDriver, selector: string): Promise<BrowserHomepageState> {
  const observed = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["value", "title"]);
  const receipt = observed.title?.match(/^Browser homepage state: storage=(default|custom)$/);
  if (!observed.present || !observed.visible || typeof observed.value !== "string" || !receipt) {
    throw new Error("Browser homepage omitted its bounded value or persistence receipt");
  }
  return { value: observed.value, storage: receipt[1] as BrowserHomepageState["storage"] };
}

async function waitForBrowserHomepageState(
  webdriver: WebDriver,
  selector: string,
  expected: BrowserHomepageState,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await readBrowserHomepageState(webdriver, selector);
    if (current.value === expected.value && current.storage === expected.storage) return;
    await delay(50);
  }
  throw new Error("Browser homepage did not reach its exact bounded preference state");
}

function browserOptionsSelectConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return BROWSER_OPTIONS_SELECT_CONTROLS[key as keyof typeof BROWSER_OPTIONS_SELECT_CONTROLS];
}

type BrowserColorModeState = {
  value: "system" | "light" | "dark";
  applied: "system" | "light" | "dark";
  storage: "default" | "custom";
};

async function exerciseBrowserOptionsSelect(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = browserOptionsSelectConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native Browser Options selection effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  let baseline: BrowserColorModeState | null = null;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface native ${config.label} selection proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    await closeBrowserDisclosureIfOpen(webdriver, config.owner, config.panel);
    const owner = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(config.owner));
    await clickReleaseSurfaceWebDriverElement(webdriver, owner);
    await waitForReleaseSurfaceWebDriverElement(webdriver, config.panel);
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    baseline = await readBrowserColorModeState(webdriver, config.control);
    const target = baseline.value === "dark" ? "light" : "dark";
    outcome.present = "pass";
    await setReleaseSurfaceWebDriverElementValue(webdriver, control, browserColorModeLabel(target));
    outcome.invoke = "pass";
    await waitForBrowserColorModeState(webdriver, config.control, {
      value: target,
      applied: target,
      storage: "custom",
    });
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver selection changed the ${config.label}, applied root mode, and renderer-local persistence together.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && baseline && config) {
      try {
        const current = await readBrowserColorModeState(webdriver, config.control);
        if (current.value !== baseline.value) {
          await setReleaseSurfaceWebDriverElementValue(webdriver, control, browserColorModeLabel(baseline.value));
        }
        await waitForBrowserColorModeState(webdriver, config.control, baseline);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (config && browserWindowOpen) {
      try {
        await closeBrowserDisclosureIfOpen(webdriver, config.owner, config.panel);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (taskId) {
      try {
        await cleanupOwnedUiBrowserTask(connection, taskId, "final surface UI control");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (originalWindow) {
      try {
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

function browserColorModeLabel(value: BrowserColorModeState["value"]): string {
  return value === "system" ? "System" : value === "light" ? "Light" : "Dark";
}

async function readBrowserColorModeState(
  webdriver: WebDriver,
  selector: string,
): Promise<BrowserColorModeState> {
  const state = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["value", "title"]);
  const receipt = state.title?.match(/^Browser color state: applied=(system|light|dark); storage=(default|custom)$/);
  if (!state.present || !state.visible || !isBrowserColorMode(state.value) || !receipt || !isBrowserColorMode(receipt[1])) {
    throw new Error("Browser color-mode state did not expose its bounded select and applied-state receipt");
  }
  return {
    value: state.value,
    applied: receipt[1],
    storage: receipt[2] as BrowserColorModeState["storage"],
  };
}

async function waitForBrowserColorModeState(
  webdriver: WebDriver,
  selector: string,
  expected: BrowserColorModeState,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await readBrowserColorModeState(webdriver, selector);
    if (JSON.stringify(current) === JSON.stringify(expected)) return;
    await delay(50);
  }
  throw new Error("Browser color-mode state did not reach its exact expected baseline");
}

function isBrowserColorMode(value: unknown): value is BrowserColorModeState["value"] {
  return value === "system" || value === "light" || value === "dark";
}

function browserEngineSelectConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return BROWSER_ENGINE_SELECT_CONTROLS[key as keyof typeof BROWSER_ENGINE_SELECT_CONTROLS];
}

type BrowserEnginePoolConfig = {
  configuredParallelAgents: "auto" | "1" | "2" | "3" | "4";
  automationMode: "normal" | "backgroundOnly";
};

async function exerciseBrowserEngineSelect(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = browserEngineSelectConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native Browser engine-pool selection effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  let baseline: BrowserEnginePoolConfig | null = null;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface native ${config.label} selection proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    await closeBrowserDisclosureIfOpen(webdriver, config.owner, config.panel);
    const owner = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(config.owner));
    await clickReleaseSurfaceWebDriverElement(webdriver, owner);
    await waitForReleaseSurfaceWebDriverElement(webdriver, config.panel);
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    baseline = await readBrowserEnginePoolConfig(connection);
    await waitForBrowserEngineSelectState(webdriver, connection, config.control, baseline);
    const target: BrowserEnginePoolConfig["configuredParallelAgents"] = baseline.configuredParallelAgents === "auto" ? "1" : "auto";
    outcome.present = "pass";
    await setReleaseSurfaceWebDriverElementValue(webdriver, control, target === "auto" ? "Auto" : target);
    outcome.invoke = "pass";
    await waitForBrowserEngineSelectState(webdriver, connection, config.control, {
      configuredParallelAgents: target,
      automationMode: baseline.automationMode,
    });
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver selection changed the configured ${config.label} while preserving automation mode.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && baseline && config) {
      try {
        const current = await readBrowserEnginePoolConfig(connection);
        if (current.configuredParallelAgents !== baseline.configuredParallelAgents) {
          await setReleaseSurfaceWebDriverElementValue(
            webdriver,
            control,
            baseline.configuredParallelAgents === "auto" ? "Auto" : baseline.configuredParallelAgents,
          );
        }
        await waitForBrowserEngineSelectState(webdriver, connection, config.control, baseline);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (config && browserWindowOpen) {
      try {
        await closeBrowserDisclosureIfOpen(webdriver, config.owner, config.panel);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (taskId) {
      try {
        await cleanupOwnedUiBrowserTask(connection, taskId, "final surface UI control");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (originalWindow) {
      try {
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function readBrowserEnginePoolConfig(connection: Connection): Promise<BrowserEnginePoolConfig> {
  const body = await apiJson<Record<string, unknown>>(connection, "GET", "/browser/engine-pool");
  const pool = requiredRecord(body.enginePool, "Browser engine pool");
  const limits = requiredRecord(pool.limits, "Browser engine-pool limits");
  const configured = limits.configuredParallelAgents;
  const automation = pool.automationMode;
  if (configured !== "auto" && configured !== "1" && configured !== "2" && configured !== "3" && configured !== "4") {
    throw new Error("Browser engine pool returned an invalid configured parallel-agent setting");
  }
  if (automation !== "normal" && automation !== "backgroundOnly") {
    throw new Error("Browser engine pool returned an invalid automation mode");
  }
  return { configuredParallelAgents: configured, automationMode: automation };
}

async function readOwnedSelectValue(webdriver: WebDriver, selector: string): Promise<string> {
  const state = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["value"]);
  if (!state.present || !state.visible || typeof state.value !== "string") {
    throw new Error("owned select state did not expose a string value");
  }
  return state.value;
}

async function waitForBrowserEngineSelectState(
  webdriver: WebDriver,
  connection: Connection,
  selector: string,
  expected: BrowserEnginePoolConfig,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const selected = await readOwnedSelectValue(webdriver, selector);
    const current = await readBrowserEnginePoolConfig(connection);
    if (selected === expected.configuredParallelAgents && JSON.stringify(current) === JSON.stringify(expected)) return;
    await delay(50);
  }
  throw new Error("Browser engine-pool select did not reach its exact UI and Debug API baseline");
}

function browserProfileSelectConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return BROWSER_PROFILE_SELECT_CONTROLS[key as keyof typeof BROWSER_PROFILE_SELECT_CONTROLS];
}

function browserProfileOptionLabel(profileId: string): string {
  if (profileId === "personal") return "Personal";
  if (profileId === "agent-work") return "Agent Work · default";
  if (profileId === "task-disposable") return "Task Disposable · no cookies";
  throw new Error(`unsupported Browser profile ${profileId}`);
}

async function exerciseBrowserProfileSelect(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = browserProfileSelectConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native Browser profile selection effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  let baseline: string | null = null;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface native ${config.label} proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    await closeBrowserDisclosureIfOpen(webdriver, config.owner, config.panel);
    const owner = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(config.owner));
    await clickReleaseSurfaceWebDriverElement(webdriver, owner);
    await waitForReleaseSurfaceWebDriverElement(webdriver, config.panel);
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    baseline = await readOwnedSelectValue(webdriver, config.control);
    browserProfileOptionLabel(baseline);
    const target = baseline === "agent-work" ? "task-disposable" : "agent-work";
    outcome.present = "pass";
    await setReleaseSurfaceWebDriverElementValue(webdriver, control, browserProfileOptionLabel(target));
    outcome.invoke = "pass";
    await waitForOwnedSelectValue(webdriver, config.control, target);
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver selection changed only the ${config.label} for the next action.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && config && baseline) {
      try {
        if (await readOwnedSelectValue(webdriver, config.control) !== baseline) {
          await setReleaseSurfaceWebDriverElementValue(webdriver, control, browserProfileOptionLabel(baseline));
        }
        await waitForOwnedSelectValue(webdriver, config.control, baseline);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (config && browserWindowOpen) {
      try {
        await closeBrowserDisclosureIfOpen(webdriver, config.owner, config.panel);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (taskId) {
      try {
        await cleanupOwnedUiBrowserTask(connection, taskId, "final surface UI control");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (originalWindow) {
      try {
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

function browserHistoryFilterConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return BROWSER_HISTORY_FILTER_CONTROLS[key as keyof typeof BROWSER_HISTORY_FILTER_CONTROLS];
}

type BrowserHistoryScope = "user" | "agent";

async function exerciseBrowserHistoryFilter(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = browserHistoryFilterConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native Browser History filter effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  let baselineText: string | null = null;
  let baselineChoice: string | null = null;
  let baselineScope: BrowserHistoryScope | null = null;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface native ${config.label} proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    await closeBrowserDisclosureIfOpen(webdriver, BROWSER_HISTORY_OWNER, BROWSER_HISTORY_PANEL);
    const owner = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(BROWSER_HISTORY_OWNER));
    await clickReleaseSurfaceWebDriverElement(webdriver, owner);
    await waitForReleaseSurfaceWebDriverElement(webdriver, BROWSER_HISTORY_PANEL);
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    outcome.present = "pass";
    if (config.kind === "text") {
      baselineText = await readOwnedInputValue(webdriver, config.control);
      await replaceOwnedInputValue(webdriver, control, config.control, config.value);
      outcome.invoke = "pass";
      outcome.effect = "pass";
    } else if (config.kind === "choice") {
      baselineChoice = await readOwnedSelectValue(webdriver, config.control);
      const target = baselineChoice === config.value ? "all" : config.value;
      const targetLabel = target === config.value ? config.optionLabel : "All dates";
      await setReleaseSurfaceWebDriverElementValue(webdriver, control, targetLabel);
      outcome.invoke = "pass";
      await waitForOwnedSelectValue(webdriver, config.control, target);
      outcome.effect = "pass";
    } else {
      baselineScope = await readBrowserHistoryScope(webdriver);
      await setBrowserHistoryScope(webdriver, config.value === "user" ? "agent" : "user");
      control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForBrowserHistoryScope(webdriver, config.value);
      outcome.effect = "pass";
    }
    outcome.observedEffect = `Native WebDriver interaction changed the exactly owned ${config.label} from a distinct prepared baseline.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && config && browserWindowOpen) {
      try {
        if (config.kind === "text" && baselineText !== null) {
          await replaceOwnedInputValue(webdriver, control, config.control, baselineText);
        } else if (config.kind === "choice" && baselineChoice !== null) {
          const current = await readOwnedSelectValue(webdriver, config.control);
          if (current !== baselineChoice) {
            await setReleaseSurfaceWebDriverElementValue(
              webdriver,
              control,
              browserHistoryDateLabel(baselineChoice),
            );
          }
          await waitForOwnedSelectValue(webdriver, config.control, baselineChoice);
        } else if (config.kind === "scope" && baselineScope) {
          await setBrowserHistoryScope(webdriver, baselineScope);
        }
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserWindowOpen) {
      try {
        await closeBrowserDisclosureIfOpen(webdriver, BROWSER_HISTORY_OWNER, BROWSER_HISTORY_PANEL);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (taskId) {
      try {
        await cleanupOwnedUiBrowserTask(connection, taskId, "final surface UI control");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (originalWindow) {
      try {
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function waitForOwnedSelectValue(webdriver: WebDriver, selector: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readOwnedSelectValue(webdriver, selector) === expected) return;
    await delay(50);
  }
  throw new Error(`owned select did not reach ${expected}`);
}

function browserHistoryDateLabel(value: string): string {
  if (value === "all") return "All dates";
  if (value === "today") return "Today";
  if (value === "yesterday") return "Yesterday";
  if (value === "last7") return "Last 7 days";
  throw new Error(`unsupported Browser history date value ${value}`);
}

async function readBrowserHistoryScope(webdriver: WebDriver): Promise<BrowserHistoryScope> {
  const [user, agent] = await Promise.all([
    observeReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-history-user']", ["pressed"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-history-agent']", ["pressed"]),
  ]);
  if (user.present && user.visible && user.pressed === true && agent.present && agent.visible && agent.pressed === false) return "user";
  if (user.present && user.visible && user.pressed === false && agent.present && agent.visible && agent.pressed === true) return "agent";
  throw new Error("Browser history scope did not expose exactly one active owner");
}

async function waitForBrowserHistoryScope(webdriver: WebDriver, expected: BrowserHistoryScope): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readBrowserHistoryScope(webdriver) === expected) return;
    await delay(50);
  }
  throw new Error(`Browser history scope did not reach ${expected}`);
}

async function setBrowserHistoryScope(webdriver: WebDriver, expected: BrowserHistoryScope): Promise<void> {
  if (await readBrowserHistoryScope(webdriver) === expected) return;
  const control = await waitForReleaseSurfaceWebDriverElement(
    webdriver,
    `[data-debug-id='shellx-browser-history-${expected}']`,
  );
  await clickReleaseSurfaceWebDriverElement(webdriver, control);
  await waitForBrowserHistoryScope(webdriver, expected);
}

function browserBookmarkModeConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return BROWSER_BOOKMARK_MODE_CONTROLS[key as keyof typeof BROWSER_BOOKMARK_MODE_CONTROLS];
}

function browserBookmarkDraftTextConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return BROWSER_BOOKMARK_DRAFT_TEXT_CONTROLS[key as keyof typeof BROWSER_BOOKMARK_DRAFT_TEXT_CONTROLS];
}

async function readBrowserBookmarkManageMode(webdriver: WebDriver): Promise<boolean> {
  const [list, edit] = await Promise.all([
    observeReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-bookmark-list-mode']", ["pressed"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, "[data-debug-id='shellx-browser-bookmark-manager-toggle']", ["pressed"]),
  ]);
  if (list.present && list.visible && list.pressed === true && edit.present && edit.visible && edit.pressed === false) return false;
  if (list.present && list.visible && list.pressed === false && edit.present && edit.visible && edit.pressed === true) return true;
  throw new Error("Browser bookmark mode did not expose exactly one active owner");
}

async function waitForBrowserBookmarkManageMode(webdriver: WebDriver, expected: boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readBrowserBookmarkManageMode(webdriver) === expected) return;
    await delay(50);
  }
  throw new Error(`Browser bookmark mode did not reach ${expected ? "Edit" : "List"}`);
}

async function setBrowserBookmarkManageMode(webdriver: WebDriver, expected: boolean): Promise<void> {
  if (await readBrowserBookmarkManageMode(webdriver) === expected) return;
  const selector = expected
    ? "[data-debug-id='shellx-browser-bookmark-manager-toggle']"
    : "[data-debug-id='shellx-browser-bookmark-list-mode']";
  const control = await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
  await clickReleaseSurfaceWebDriverElement(webdriver, control);
  await waitForBrowserBookmarkManageMode(webdriver, expected);
}

async function exerciseBrowserBookmarkMode(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = browserBookmarkModeConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native Browser bookmark mode effect was observed.");
  let baselineMode: boolean | null = null;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface native ${config.label} proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    await closeBrowserDisclosureIfOpen(webdriver, BROWSER_BOOKMARK_OWNER, BROWSER_BOOKMARK_PANEL);
    const owner = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(BROWSER_BOOKMARK_OWNER));
    await clickReleaseSurfaceWebDriverElement(webdriver, owner);
    await waitForReleaseSurfaceWebDriverElement(webdriver, BROWSER_BOOKMARK_PANEL);
    baselineMode = await readBrowserBookmarkManageMode(webdriver);
    await setBrowserBookmarkManageMode(webdriver, !config.targetManageMode);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForBrowserBookmarkManageMode(webdriver, config.targetManageMode);
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver click changed the exactly owned ${config.label} from its opposite prepared baseline.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (baselineMode !== null && browserWindowOpen) {
      try {
        await setBrowserBookmarkManageMode(webdriver, baselineMode);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    await cleanupBrowserBookmarkExercise(
      connection,
      webdriver,
      taskId,
      originalWindow,
      browserWindowOpen,
      cleanupErrors,
    );
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function exerciseBrowserBookmarkDraftText(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = browserBookmarkDraftTextConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native Browser bookmark draft text effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  let baselineValue: string | null = null;
  let baselineMode: boolean | null = null;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface native ${config.label} proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    await closeBrowserDisclosureIfOpen(webdriver, BROWSER_BOOKMARK_OWNER, BROWSER_BOOKMARK_PANEL);
    const owner = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(BROWSER_BOOKMARK_OWNER));
    await clickReleaseSurfaceWebDriverElement(webdriver, owner);
    await waitForReleaseSurfaceWebDriverElement(webdriver, BROWSER_BOOKMARK_PANEL);
    baselineMode = await readBrowserBookmarkManageMode(webdriver);
    await setBrowserBookmarkManageMode(webdriver, true);
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    baselineValue = await readOwnedInputValue(webdriver, config.control);
    outcome.present = "pass";
    await replaceOwnedInputValue(webdriver, control, config.control, config.value);
    outcome.invoke = "pass";
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver input changed the exactly owned ${config.label} without creating a bookmark.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && config && baselineValue !== null && browserWindowOpen) {
      try {
        await replaceOwnedInputValue(webdriver, control, config.control, baselineValue);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (baselineMode !== null && browserWindowOpen) {
      try {
        await setBrowserBookmarkManageMode(webdriver, baselineMode);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    await cleanupBrowserBookmarkExercise(
      connection,
      webdriver,
      taskId,
      originalWindow,
      browserWindowOpen,
      cleanupErrors,
    );
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function cleanupBrowserBookmarkExercise(
  connection: Connection,
  webdriver: WebDriver,
  taskId: string | null,
  originalWindow: string | null,
  browserWindowOpen: boolean,
  cleanupErrors: string[],
): Promise<void> {
  if (browserWindowOpen) {
    try {
      await closeBrowserDisclosureIfOpen(webdriver, BROWSER_BOOKMARK_OWNER, BROWSER_BOOKMARK_PANEL);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (taskId) {
    try {
      await cleanupOwnedUiBrowserTask(connection, taskId, "final surface UI control");
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (browserWindowOpen && originalWindow) {
    try {
      await closeBrowserWindow(connection, webdriver, originalWindow);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
  } else if (originalWindow) {
    try {
      await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
}

function browserTransientTextConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return BROWSER_TRANSIENT_TEXT_CONTROLS[key as keyof typeof BROWSER_TRANSIENT_TEXT_CONTROLS];
}

async function readBrowserRightPanelTab(webdriver: WebDriver): Promise<BrowserRightPanelTab> {
  const tabs = ["chat", "requests", "actions", "evidence", "errors"] as const;
  const observations = await Promise.all(tabs.map((tab) => observeReleaseSurfaceInstalledInputElement(
    webdriver,
    `[data-debug-id='shellx-browser-right-tab-${tab}']`,
    ["selected"],
  )));
  const selected = tabs.filter((_tab, index) => {
    const observation = observations[index];
    if (!observation?.present || !observation.visible || typeof observation.selected !== "boolean") {
      throw new Error("Browser right-panel state omitted a bounded tab");
    }
    return observation.selected;
  });
  if (selected.length === 1) return selected[0]!;
  throw new Error("Browser right-panel state did not expose exactly one selected tab");
}

async function exerciseBrowserTransientText(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = browserTransientTextConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native Browser transient text effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  let baselineValue: string | null = null;
  let baselineRightPanel: BrowserRightPanelTab | null = null;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface native ${config.label} proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    baselineRightPanel = await readBrowserRightPanelTab(webdriver);
    if (config.rightPanel) {
      await setBrowserRightPanelTab(connection, webdriver, config.rightPanel, `${config.label} fixture setup`);
    }
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    baselineValue = await readOwnedInputValue(webdriver, config.control);
    outcome.present = "pass";
    await replaceOwnedInputValue(webdriver, control, config.control, config.value);
    outcome.invoke = "pass";
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver input changed the exactly owned ${config.label} without submitting it.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && config && baselineValue !== null && browserWindowOpen) {
      try {
        await replaceOwnedInputValue(webdriver, control, config.control, baselineValue);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (baselineRightPanel && browserWindowOpen) {
      try {
        await setBrowserRightPanelTab(connection, webdriver, baselineRightPanel, `${config?.label ?? "Browser text"} cleanup`);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (taskId) {
      try {
        await cleanupOwnedUiBrowserTask(connection, taskId, "final surface UI control");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (originalWindow) {
      try {
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

function browserTaskControlConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return BROWSER_TASK_CONTROL_CONTROLS[key as keyof typeof BROWSER_TASK_CONTROL_CONTROLS];
}

async function readBrowserTaskStatus(
  connection: Connection,
  taskId: string,
): Promise<string> {
  const state = await apiJson<Record<string, unknown>>(connection, "GET", "/browser/state");
  if (!Array.isArray(state.tasks)) throw new Error("Browser state omitted tasks while verifying native task control");
  const task = state.tasks
    .map((value) => requiredRecord(value, "Browser state task"))
    .find((value) => value.taskId === taskId);
  if (!task || typeof task.status !== "string" || !task.status) {
    throw new Error(`Browser state omitted owned task ${taskId}`);
  }
  return task.status;
}

async function waitForBrowserTaskStatus(
  connection: Connection,
  taskId: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readBrowserTaskStatus(connection, taskId) === expected) return;
    await delay(50);
  }
  throw new Error(`Browser task ${taskId} did not reach ${expected}`);
}

async function waitForOwnedButtonEnabled(webdriver: WebDriver, selector: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["disabled"]);
    if (state.present && state.visible && state.disabled === false) return;
    if (state.present && state.visible && state.disabled !== true) {
      throw new Error(`owned button ${selector} did not expose disabled state`);
    }
    await delay(50);
  }
  throw new Error(`owned button ${selector} did not become enabled`);
}

async function exerciseBrowserTaskControl(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = browserTaskControlConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native Browser task-control status effect was observed.");
  let baselineRightPanel: BrowserRightPanelTab | null = null;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface native Browser task ${config.label} proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    baselineRightPanel = await readBrowserRightPanelTab(webdriver);
    await setBrowserRightPanelTab(connection, webdriver, config.panel, `Browser task ${config.label} setup`);
    if (config.precondition === "paused") {
      await apiJson(connection, "POST", "/browser/task/control", {
        taskId,
        action: "pause",
        reason: "finalSurfaceUiControlSetup",
      });
      await waitForBrowserTaskStatus(connection, taskId, "paused");
    } else {
      await waitForBrowserTaskStatus(connection, taskId, "running");
    }
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    await waitForOwnedButtonEnabled(webdriver, config.control);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForBrowserTaskStatus(connection, taskId, config.target);
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click changed only the owned Browser task from ${config.precondition} to ${config.target}.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (taskId && browserWindowOpen) {
      try {
        const status = await readBrowserTaskStatus(connection, taskId);
        if (status === "paused" || status === "userTakeover") {
          await setBrowserRightPanelTab(connection, webdriver, "chat", "Browser task control cleanup");
          const resumeSelector = "[data-debug-id='shellx-browser-agent-resume']";
          const resume = await waitForReleaseSurfaceWebDriverElement(webdriver, resumeSelector);
          await waitForOwnedButtonEnabled(webdriver, resumeSelector);
          await clickReleaseSurfaceWebDriverElement(webdriver, resume);
          await waitForBrowserTaskStatus(connection, taskId, "running");
        }
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (taskId) {
      try {
        await cleanupOwnedUiBrowserTask(connection, taskId, "final surface Browser task control");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (baselineRightPanel && browserWindowOpen) {
      try {
        await setBrowserRightPanelTab(connection, webdriver, baselineRightPanel, "Browser task control panel cleanup");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (originalWindow) {
      try {
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function readBrowserRightSidebarState(
  webdriver: WebDriver,
  selector: string,
): Promise<{ checked: boolean; revealVisible: boolean }> {
  const [hide, reveal] = await Promise.all([
    observeReleaseSurfaceInstalledInputElement(
      webdriver,
      "[data-debug-id='shellx-browser-toggle-right-sidebar-button']",
      ["title"],
    ),
    observeReleaseSurfaceInstalledInputElement(
      webdriver,
      "[data-debug-id='shellx-browser-show-right-sidebar-button']",
      ["title"],
    ),
  ]);
  if (hide.present === reveal.present) {
    throw new Error("Browser right-sidebar state must expose exactly one chrome visibility control");
  }
  let checked = hide.present;
  if (selector === "[data-debug-id='shellx-browser-toggle-right-sidebar']") {
    const control = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["checked"]);
    if (!control.present || !control.visible || typeof control.checked !== "boolean") {
      throw new Error("Browser right-sidebar Options toggle omitted checked state");
    }
    checked = control.checked;
  }
  return { checked, revealVisible: reveal.present };
}

async function waitForBrowserRightSidebarState(
  webdriver: WebDriver,
  selector: string,
  expected: boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await readBrowserRightSidebarState(webdriver, selector);
    if (current.checked === expected && current.revealVisible === !expected) return;
    await delay(50);
  }
  throw new Error(`Browser right-sidebar state did not reach checked=${expected}`);
}

async function replaceOwnedInputValue(
  webdriver: WebDriver,
  control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>>,
  selector: string,
  value: string,
): Promise<void> {
  await clearReleaseSurfaceWebDriverElement(webdriver, control);
  await waitForOwnedInputValue(webdriver, selector, "");
  if (value) await setReleaseSurfaceWebDriverElementValue(webdriver, control, value);
  await waitForOwnedInputValue(webdriver, selector, value);
}

type PublicSettings = {
  browserDownloadFolder: string;
  chatFontPx: number;
  defaultAgentId: string | null;
  defaultWorkingFolder: string;
  density: string;
  githubGhBinary: string;
  theme: string;
};

async function readPublicSettings(connection: Connection): Promise<PublicSettings> {
  const body = await apiJson<Record<string, unknown>>(connection, "GET", "/settings");
  const keys = Object.keys(body).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    "browserDownloadFolder", "chatFontPx", "defaultAgentId", "defaultWorkingFolder", "density", "githubGhBinary", "theme",
  ])) throw new Error("public Settings payload returned unexpected fields");
  if (typeof body.browserDownloadFolder !== "string"
    || !Number.isSafeInteger(body.chatFontPx)
    || !(body.defaultAgentId === null || ["grok", "codex-cli", "claude-code", "antigravity-cli"].includes(String(body.defaultAgentId)))
    || typeof body.defaultWorkingFolder !== "string"
    || !["compact", "default", "comfortable"].includes(String(body.density))
    || !["gh", "gh.exe"].includes(String(body.githubGhBinary))
    || !["black", "black_warm", "bright"].includes(String(body.theme))) {
    throw new Error("public Settings payload did not match its normalized schema");
  }
  return body as PublicSettings;
}

async function waitForPublicSettings(connection: Connection, expected: PublicSettings): Promise<PublicSettings> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await readPublicSettings(connection);
    if (JSON.stringify(current) === JSON.stringify(expected)) return current;
    await delay(50);
  }
  throw new Error("public Settings payload did not reach its exact expected baseline");
}

async function readStoredSettingsTab(connection: Connection): Promise<SettingsTab> {
  const state = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
  const value = state.settingsTab;
  if (typeof value === "string" && Object.values(SETTINGS_TAB_CONTROLS).includes(value as SettingsTab)) {
    return value as SettingsTab;
  }
  throw new Error("stored Settings tab was unavailable or invalid");
}

async function exerciseOverlayTextInput(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = overlayTextConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native overlay text-entry effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    await postUi(connection, { openModal: config.openModal, source: "final-surface-overlay-text" });
    await waitForReleaseSurfaceWebDriverElement(webdriver, config.dialog);
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    await clearReleaseSurfaceWebDriverElement(webdriver, control);
    await waitForOwnedInputValue(webdriver, config.control, "");
    outcome.present = "pass";
    await setReleaseSurfaceWebDriverElementValue(webdriver, control, config.value);
    outcome.invoke = "pass";
    await waitForOwnedInputValue(webdriver, config.control, config.value);
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver input changed the exactly owned ${config.label} value.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && config) {
      try {
        await clearReleaseSurfaceWebDriverElement(webdriver, control);
        await waitForOwnedInputValue(webdriver, config.control, "");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      await postUi(connection, { openModal: "close", source: "final-surface-overlay-text-cleanup" });
      if (config) await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, config.dialog);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

function overlayTextConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return OVERLAY_TEXT_CONTROLS[key as keyof typeof OVERLAY_TEXT_CONTROLS];
}

async function exerciseTasksToggle(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const selector = assignment.surface.selector ?? "";
  const config = TASKS_TOGGLE_CONTROLS[selector as keyof typeof TASKS_TOGGLE_CONTROLS];
  const outcome = emptyOutcome(assignment, "No native Tasks toggle effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  let baseline: TasksToggleState | null = null;
  let originalTab: RightRailTab | null = null;
  try {
    if (!config) throw new Error(`UI control driver does not support selector ${selector || "<missing>"}`);
    const state = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
    originalTab = requireRightRailTab(state.rightTab, "Tasks toggle original tab");
    await setRightRailTab(connection, webdriver, "Tasks", "Tasks toggle fixture setup");
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    baseline = await readTasksToggleState(webdriver, config);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForTasksToggleState(webdriver, config, {
      checked: !baseline.checked,
    });
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click changed the exactly owned ${config.label} and its persisted setting.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && baseline && config) {
      try {
        const current = await readTasksToggleState(webdriver, config);
        if (current.checked !== baseline.checked) await clickReleaseSurfaceWebDriverElement(webdriver, control);
        await waitForTasksToggleState(webdriver, config, {
          checked: baseline.checked,
        });
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (originalTab) {
      try {
        await setRightRailTab(connection, webdriver, originalTab, "Tasks toggle fixture cleanup");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

type TasksToggleConfig = typeof TASKS_TOGGLE_CONTROLS[keyof typeof TASKS_TOGGLE_CONTROLS];
type TasksToggleState = { checked: boolean };

async function readTasksToggleState(webdriver: WebDriver, config: TasksToggleConfig): Promise<TasksToggleState> {
  const state = await observeReleaseSurfaceInstalledInputElement(webdriver, config.control, ["checked"]);
  if (!state.present || !state.visible || typeof state.checked !== "boolean") {
    throw new Error("Tasks toggle state omitted checked");
  }
  return { checked: state.checked };
}

async function waitForTasksToggleState(
  webdriver: WebDriver,
  config: TasksToggleConfig,
  expected: TasksToggleState,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await readTasksToggleState(webdriver, config);
    if (current.checked === expected.checked) return;
    await delay(50);
  }
  throw new Error(`Tasks toggle did not reach checked=${expected.checked}`);
}

type AgentRunsRefreshState = {
  present: boolean;
  disabled: boolean;
  sequence: number;
  generatedAtMs: number | null;
};

async function exerciseAgentRunsRefreshControl(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Agent runs Refresh effect was observed.");
  let originalRightTab: RightRailTab | null = null;
  try {
    const ui = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
    originalRightTab = requireRightRailTab(ui.rightTab, "Agent runs Refresh original tab");
    if (ui.openModal != null) {
      throw new Error("Agent runs Refresh fixture requires a quiescent restorable right rail");
    }
    await setRightRailTab(connection, webdriver, "Files", "Agent runs Refresh fixture reset");
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, AGENT_RUNS_REFRESH_CONTROL, {
      timeoutMs: 5_000,
      pollMs: 50,
    });
    await setRightRailTab(connection, webdriver, "Tasks", "Agent runs Refresh fixture setup");
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, AGENT_RUNS_REFRESH_CONTROL, {
      timeoutMs: 5_000,
      pollMs: 50,
    });
    await waitForAgentRunsRefreshState(webdriver, { sequence: 0, generatedAtMs: null, disabled: false });
    outcome.present = "pass";

    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    const receipt = await waitForSuccessfulAgentRunsRefresh(webdriver);
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click completed manual Agent runs refresh ${receipt.sequence} with response generation ${receipt.generatedAtMs}.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    try {
      await setRightRailTab(connection, webdriver, "Files", "Agent runs Refresh cleanup reset");
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, AGENT_RUNS_REFRESH_CONTROL, {
        timeoutMs: 5_000,
        pollMs: 50,
      });
    } catch (error) {
      cleanupErrors.push(`monitor reset: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (originalRightTab) {
      try {
        await setRightRailTab(connection, webdriver, originalRightTab, "Agent runs Refresh cleanup restore");
        if (originalRightTab === "Tasks") {
          await waitForReleaseSurfaceWebDriverElement(webdriver, AGENT_RUNS_REFRESH_CONTROL, {
            timeoutMs: 5_000,
            pollMs: 50,
          });
          await waitForAgentRunsRefreshState(webdriver, { sequence: 0, generatedAtMs: null, disabled: false });
        } else {
          await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, AGENT_RUNS_REFRESH_CONTROL, {
            timeoutMs: 5_000,
            pollMs: 50,
          });
        }
      } catch (error) {
        cleanupErrors.push(`right-rail restore: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      cleanupErrors.push("right-rail restore: original tab was unavailable");
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function waitForSuccessfulAgentRunsRefresh(
  webdriver: WebDriver,
): Promise<AgentRunsRefreshState & { generatedAtMs: number }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readAgentRunsRefreshState(webdriver);
    if (state.sequence === 1 && state.generatedAtMs !== null && state.generatedAtMs > 0 && !state.disabled) {
      return state as AgentRunsRefreshState & { generatedAtMs: number };
    }
    await delay(50);
  }
  throw new Error("Agent runs manual refresh did not publish one exact successful response receipt");
}

async function waitForAgentRunsRefreshState(
  webdriver: WebDriver,
  expected: Pick<AgentRunsRefreshState, "sequence" | "generatedAtMs" | "disabled">,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readAgentRunsRefreshState(webdriver);
    if (
      state.sequence === expected.sequence
      && state.generatedAtMs === expected.generatedAtMs
      && state.disabled === expected.disabled
    ) return;
    await delay(50);
  }
  throw new Error(`Agent runs Refresh did not reach sequence ${expected.sequence} with its exact owned baseline`);
}

async function readAgentRunsRefreshState(webdriver: WebDriver): Promise<AgentRunsRefreshState> {
  const observation = await observeReleaseSurfaceInstalledInputElement(
    webdriver,
    AGENT_RUNS_REFRESH_CONTROL,
    ["disabled", "title"],
  );
  if (!observation.present || !observation.visible || typeof observation.disabled !== "boolean") {
    throw new Error("Agent runs Refresh is absent or omitted disabled state");
  }
  const match = observation.title?.match(/^Agent runs refresh receipt · sequence=(\d+) · generatedAtMs=(none|\d+)$/);
  if (!match) throw new Error("Agent runs Refresh omitted its bounded receipt title");
  const state: AgentRunsRefreshState = {
    present: true,
    disabled: observation.disabled,
    sequence: Number(match[1]),
    generatedAtMs: match[2] === "none" ? null : Number(match[2]),
  };
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 0) {
    throw new Error("Agent runs Refresh returned an invalid sequence");
  }
  if (state.generatedAtMs !== null && (!Number.isSafeInteger(state.generatedAtMs) || state.generatedAtMs <= 0)) {
    throw new Error("Agent runs Refresh returned an invalid response generation time");
  }
  return state;
}

async function exerciseRightRailTextInput(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = rightRailTextConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native right-rail text-entry effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  let originalTab: RightRailTab | null = null;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    const state = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
    originalTab = requireRightRailTab(state.rightTab, "right-rail text fixture original tab");
    await setRightRailTab(connection, webdriver, config.tab, "right-rail text fixture setup");
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    await clearReleaseSurfaceWebDriverElement(webdriver, control);
    await waitForOwnedInputValue(webdriver, config.control, "");
    outcome.present = "pass";
    await setReleaseSurfaceWebDriverElementValue(webdriver, control, config.value);
    outcome.invoke = "pass";
    await waitForOwnedInputValue(webdriver, config.control, config.value);
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver input changed the exactly owned ${config.label} value.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && config) {
      try {
        await clearReleaseSurfaceWebDriverElement(webdriver, control);
        await waitForOwnedInputValue(webdriver, config.control, "");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (originalTab) {
      try {
        await setRightRailTab(connection, webdriver, originalTab, "right-rail text fixture cleanup");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

function rightRailTextConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return RIGHT_RAIL_TEXT_CONTROLS[key as keyof typeof RIGHT_RAIL_TEXT_CONTROLS];
}

function requireRightRailTab(value: unknown, label: string): RightRailTab {
  if (typeof value === "string" && Object.values(RIGHT_RAIL_TAB_CONTROLS).includes(value as RightRailTab)) {
    return value as RightRailTab;
  }
  throw new Error(`${label} is invalid`);
}

async function exerciseOwnedModalTextInput(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = ownedModalTextConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native owned-modal text-entry effect was observed.");
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    await postUi(connection, { openModal: config.openModal, source: "final-surface-owned-modal-text" });
    await waitForReleaseSurfaceWebDriverElement(webdriver, config.dialog);
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    await clearReleaseSurfaceWebDriverElement(webdriver, control);
    await waitForOwnedInputValue(webdriver, config.control, "");
    outcome.present = "pass";
    await setReleaseSurfaceWebDriverElementValue(webdriver, control, config.value);
    outcome.invoke = "pass";
    await waitForOwnedInputValue(webdriver, config.control, config.value);
    outcome.effect = "pass";
    outcome.observedEffect = `Native WebDriver input changed the exactly owned ${config.label} value.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && config) {
      try {
        await clearReleaseSurfaceWebDriverElement(webdriver, control);
        await waitForOwnedInputValue(webdriver, config.control, "");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      await postUi(connection, { openModal: "close", source: "final-surface-owned-modal-text-cleanup" });
      if (config) await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, config.dialog);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function exerciseActivitySearchClear(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Activity Browser search-clear effect was observed.");
  let input: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  try {
    await postUi(connection, { openModal: "activity", source: "final-surface-activity-search-clear" });
    await waitForReleaseSurfaceWebDriverElement(webdriver, ACTIVITY_DIALOG_SELECTOR);
    input = await waitForReleaseSurfaceWebDriverElement(webdriver, ACTIVITY_SEARCH_SELECTOR);
    await clearReleaseSurfaceWebDriverElement(webdriver, input);
    await setReleaseSurfaceWebDriverElementValue(webdriver, input, "shellx-final-owned-clear-query");
    await waitForOwnedInputValue(webdriver, ACTIVITY_SEARCH_SELECTOR, "shellx-final-owned-clear-query");
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, ACTIVITY_SEARCH_CLEAR_SELECTOR);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForOwnedInputValue(webdriver, ACTIVITY_SEARCH_SELECTOR, "");
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click cleared the exact owned Activity Browser search draft without retaining its text.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const errors: string[] = [];
    if (input) {
      try {
        await clearReleaseSurfaceWebDriverElement(webdriver, input);
        await waitForOwnedInputValue(webdriver, ACTIVITY_SEARCH_SELECTOR, "");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      await postUi(connection, { openModal: "close", source: "final-surface-activity-search-clear-cleanup" });
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, ACTIVITY_DIALOG_SELECTOR);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (errors.length === 0) outcome.cleanup = "pass";
    else outcome.error = outcome.error ? `${outcome.error}; cleanup: ${errors.join("; ")}` : `cleanup: ${errors.join("; ")}`;
  }
  return finalizeOutcome(outcome);
}

async function exerciseCommandPaletteSettingsRow(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Command Palette row effect was observed.");
  try {
    await postUi(connection, { openModal: "close", source: "final-surface-command-palette-row-reset" });
    await postUi(connection, { openModal: "palette", source: "final-surface-command-palette-row-setup" });
    await waitForReleaseSurfaceWebDriverElement(webdriver, COMMAND_PALETTE_DIALOG);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, COMMAND_PALETTE_SETTINGS_ROW);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, COMMAND_PALETTE_DIALOG);
    await waitForReleaseSurfaceWebDriverElement(webdriver, SETTINGS_DIALOG_SELECTOR);
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click activated the exact Command Palette Settings row, closed the palette, and opened the visible Settings dialog.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await postUi(connection, { openModal: "close", source: "final-surface-command-palette-row-cleanup" });
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, COMMAND_PALETTE_DIALOG);
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, SETTINGS_DIALOG_SELECTOR);
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function waitForOwnedInputValue(webdriver: WebDriver, selector: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readOwnedInputValue(webdriver, selector) === expected) return;
    await delay(50);
  }
  throw new Error(`owned input did not reach the exact expected value length ${expected.length}`);
}

function ownedModalTextConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return OWNED_MODAL_TEXT_CONTROLS[key as keyof typeof OWNED_MODAL_TEXT_CONTROLS];
}

async function exerciseBrowserDisclosureClose(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const selector = assignment.surface.selector ?? "";
  const config = BROWSER_DISCLOSURE_CLOSE_CONTROLS[selector as keyof typeof BROWSER_DISCLOSURE_CLOSE_CONTROLS];
  const outcome = emptyOutcome(assignment, "No native Browser panel-close effect was observed.");
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!config) throw new Error(`UI control driver does not support selector ${selector || "<missing>"}`);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface native Browser ${config.label} close proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    await closeBrowserDisclosureIfOpen(webdriver, config.owner, config.panel);
    const owner = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(config.owner));
    await clickReleaseSurfaceWebDriverElement(webdriver, owner);
    await waitForReleaseSurfaceWebDriverElement(webdriver, config.panel);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(selector));
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, config.panel);
    await waitForReleaseSurfaceWebDriverElementAbsent(
      webdriver,
      `${webdriverSelector(config.owner)}[aria-expanded='true']`,
    );
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click closed the exactly owned Browser ${config.label} panel.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (config && browserWindowOpen) {
      try {
        await closeBrowserDisclosureIfOpen(webdriver, config.owner, config.panel);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (taskId) {
      try {
        await cleanupOwnedUiBrowserTask(connection, taskId, "final surface UI control");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function exerciseHeaderThemeToggle(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native theme-toggle state transition was observed.");
  let invoked = false;
  try {
    const baseline = await readThemeState(connection, webdriver);
    if (baseline.theme !== "black" || baseline.pressed !== "false") {
      throw new Error("isolated final profile did not start from the exact black theme baseline");
    }
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(HEADER_THEME_SELECTOR));
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    invoked = true;
    outcome.invoke = "pass";
    await waitForThemeState(connection, webdriver, { pressed: "true", theme: "bright", persistedTheme: "bright" });
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click changed aria-pressed, the document theme, and persisted settings to bright.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (invoked) {
        const control = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(HEADER_THEME_SELECTOR));
        await clickReleaseSurfaceWebDriverElement(webdriver, control);
      }
      await waitForThemeState(connection, webdriver, { pressed: "false", theme: "black", persistedTheme: "black" });
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

type ThemeState = { pressed: string | null; theme: string | null; persistedTheme: string | null };

async function readThemeState(connection: Connection, webdriver: WebDriver): Promise<ThemeState> {
  const observed = await observeReleaseSurfaceInstalledInputElement(
    webdriver,
    webdriverSelector(HEADER_THEME_SELECTOR),
    ["pressed"],
  );
  if (!observed.present || !observed.visible || typeof observed.pressed !== "boolean") {
    throw new Error("theme state omitted the explicitly declared bounded pressed observation");
  }
  const settings = await apiJson<Record<string, unknown>>(connection, "GET", "/settings");
  const theme = typeof settings.theme === "string" ? settings.theme : null;
  return {
    pressed: observed.pressed ? "true" : "false",
    theme,
    persistedTheme: theme,
  };
}

async function waitForThemeState(connection: Connection, webdriver: WebDriver, expected: ThemeState): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await readThemeState(connection, webdriver);
    if (current.pressed === expected.pressed
      && current.theme === expected.theme
      && current.persistedTheme === expected.persistedTheme) return;
    await delay(50);
  }
  throw new Error(`theme state did not reach ${JSON.stringify(expected)}`);
}

async function exerciseVaultRequestQuickAction(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const selector = assignment.surface.selector ?? "";
  const action = VAULT_REQUEST_QUICK_ACTIONS[selector as keyof typeof VAULT_REQUEST_QUICK_ACTIONS];
  const outcome = emptyOutcome(assignment, "No native Vault Request Center quick-action effect was observed.");
  try {
    if (!action) throw new Error(`UI control driver does not support selector ${selector || "<missing>"}`);
    await resetVaultRequestQuickAction(connection, webdriver, "final-surface-ui-control-driver");
    await postUi(connection, { vaultRequestCenterOpen: true, source: "final-surface-ui-control-driver" });
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_REQUEST_POPOVER_SELECTOR);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(selector));
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    if (action.effect === "overview") {
      await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_WORKSPACE_MODAL_SELECTOR);
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, VAULT_REQUEST_POPOVER_SELECTOR);
      outcome.observedEffect = "A native WebDriver click opened the visible Vault workspace and dismissed the Request Center.";
    } else if (action.effect === "newSecret") {
      await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_WORKSPACE_MODAL_SELECTOR);
      await waitForReleaseSurfaceWebDriverElement(
        webdriver,
        "[data-debug-id='vault-tab-secrets'].active[aria-selected='true']",
      );
      await waitForReleaseSurfaceWebDriverElement(
        webdriver,
        "[data-debug-id='vault-resource-form-tab-secret'].active[aria-selected='true']",
      );
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, VAULT_REQUEST_POPOVER_SELECTOR);
      outcome.observedEffect = "A native WebDriver click opened the Vault workspace with Secrets and the secret editor selected.";
    } else {
      await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_PASSWORD_GENERATOR_SELECTOR);
      await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_REQUEST_POPOVER_SELECTOR);
      outcome.observedEffect = "A native WebDriver click replaced the Request Center body with its visible password generator.";
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await resetVaultRequestQuickAction(connection, webdriver, "final-surface-ui-control-driver-cleanup");
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function resetVaultRequestQuickAction(
  connection: Connection,
  webdriver: WebDriver,
  source: string,
): Promise<void> {
  await postUi(connection, { openModal: "close", vaultRequestCenterOpen: false, source });
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, VAULT_REQUEST_POPOVER_SELECTOR);
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, VAULT_WORKSPACE_MODAL_SELECTOR);
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, VAULT_PASSWORD_GENERATOR_SELECTOR);
}

async function exerciseVaultPasswordGeneratorClose(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Vault password-generator close effect was observed.");
  try {
    await resetVaultRequestQuickAction(connection, webdriver, "final-surface-vault-generator-close-setup");
    await postUi(connection, {
      vaultRequestCenterOpen: true,
      source: "final-surface-vault-generator-close-setup",
    });
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_REQUEST_POPOVER_SELECTOR);
    const generate = await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      "[data-debug-id='vault-request-generate-password']",
    );
    await clickReleaseSurfaceWebDriverElement(webdriver, generate);
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_PASSWORD_GENERATOR_SELECTOR);

    const control = await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      webdriverSelector(VAULT_PASSWORD_GENERATOR_CLOSE_SELECTOR),
    );
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, VAULT_PASSWORD_GENERATOR_SELECTOR);
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_REQUEST_POPOVER_SELECTOR);
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `${webdriverSelector(HEADER_VAULT_REQUEST_SELECTOR)}[aria-expanded='true']`,
    );
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click closed the prepared Vault password generator while the Request Center remained expanded.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await resetVaultRequestQuickAction(connection, webdriver, "final-surface-vault-generator-close-cleanup");
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

function vaultPasswordGeneratorLocalConfig(assignment: ReleaseSurfaceDriverRequest["assignments"][number]) {
  const key = `${assignment.surface.source}:${assignment.surface.selector ?? ""}`;
  return VAULT_PASSWORD_GENERATOR_LOCAL_CONTROLS[key as keyof typeof VAULT_PASSWORD_GENERATOR_LOCAL_CONTROLS];
}

async function openVaultPasswordGenerator(
  connection: Connection,
  webdriver: WebDriver,
  source: string,
): Promise<void> {
  await resetVaultRequestQuickAction(connection, webdriver, `${source}-reset`);
  await postUi(connection, { vaultRequestCenterOpen: true, source });
  await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_REQUEST_POPOVER_SELECTOR);
  const generate = await waitForReleaseSurfaceWebDriverElement(
    webdriver,
    "[data-debug-id='vault-request-generate-password']",
  );
  await clickReleaseSurfaceWebDriverElement(webdriver, generate);
  await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_PASSWORD_GENERATOR_SELECTOR);
}

async function readVaultPasswordGeneratorLocalState(
  webdriver: WebDriver,
  control: string,
  kind: "checkbox" | "reveal" | "length-range" | "length-number",
): Promise<boolean | number> {
  const field = kind === "checkbox" ? "checked" : kind === "reveal" ? "title" : "value";
  const observed = await observeReleaseSurfaceInstalledInputElement(webdriver, control, [field]);
  if (!observed.present || !observed.visible) {
    throw new Error(`Vault password-generator ${kind} state control was not present and visible`);
  }
  const value = kind === "checkbox"
    ? observed.checked
    : kind === "reveal"
      ? observed.title === "Hide generated password"
      : Number(observed.value);
  if (kind.startsWith("length-")) {
    if (!Number.isSafeInteger(value) || Number(value) < 8 || Number(value) > 64) {
      throw new Error(`Vault password-generator ${kind} state omitted its bounded integer`);
    }
    return Number(value);
  }
  if (typeof value !== "boolean") throw new Error(`Vault password-generator ${kind} state omitted its boolean`);
  return value;
}

async function waitForVaultPasswordGeneratorLocalState(
  webdriver: WebDriver,
  control: string,
  kind: "checkbox" | "reveal" | "length-range" | "length-number",
  expected: boolean | number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readVaultPasswordGeneratorLocalState(webdriver, control, kind) === expected) return;
    await delay(50);
  }
  throw new Error(`Vault password-generator ${kind} state did not reach ${expected}`);
}

function vaultPasswordLengthKey(
  webdriver: WebDriver,
  kind: "length-range" | "length-number",
  increase: boolean,
): string {
  if (webdriver.transport === "native-webdriver") {
    if (kind === "length-range") return increase ? "\uE014" : "\uE012";
    return increase ? "\uE013" : "\uE015";
  }
  if (kind === "length-range") return increase ? "right" : "left";
  return increase ? "up" : "down";
}

async function exerciseVaultPasswordGeneratorLocalControl(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = vaultPasswordGeneratorLocalConfig(assignment);
  const outcome = emptyOutcome(assignment, "No native Vault password-generator local-state effect was observed.");
  let baseline: boolean | number | null = null;
  let control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>> | null = null;
  try {
    if (!config) throw new Error(`UI control driver does not support ${assignment.surface.name}`);
    await openVaultPasswordGenerator(connection, webdriver, "final-surface-vault-generator-local");
    control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    baseline = await readVaultPasswordGeneratorLocalState(webdriver, config.control, config.kind);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    if (typeof baseline === "number") {
      if (config.kind !== "length-range" && config.kind !== "length-number") {
        throw new Error("Vault password-generator numeric baseline has a non-numeric control kind");
      }
      await performReleaseSurfaceWebDriverKeyChord(
        webdriver,
        [vaultPasswordLengthKey(webdriver, config.kind, baseline < 64)],
      );
    }
    outcome.invoke = "pass";
    const expected = typeof baseline === "number"
      ? baseline + (baseline < 64 ? 1 : -1)
      : !baseline;
    await waitForVaultPasswordGeneratorLocalState(webdriver, config.control, config.kind, expected);
    outcome.effect = "pass";
    outcome.observedEffect = typeof baseline === "number"
      ? `Native WebDriver installed input changed the ${config.label} from ${baseline} to ${expected} without retaining generated password contents.`
      : `A native WebDriver click changed only the ${config.label} boolean without retaining generated password contents.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (control && config && baseline !== null) {
      try {
        const current = await readVaultPasswordGeneratorLocalState(webdriver, config.control, config.kind);
        if (current !== baseline) {
          await clickReleaseSurfaceWebDriverElement(webdriver, control);
          if (typeof baseline === "number" && typeof current === "number") {
            if (config.kind !== "length-range" && config.kind !== "length-number") {
              throw new Error("Vault password-generator numeric cleanup has a non-numeric control kind");
            }
            await performReleaseSurfaceWebDriverKeyChord(
              webdriver,
              [vaultPasswordLengthKey(webdriver, config.kind, current < baseline)],
            );
          }
        }
        await waitForVaultPasswordGeneratorLocalState(webdriver, config.control, config.kind, baseline);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      await resetVaultRequestQuickAction(connection, webdriver, "final-surface-vault-generator-local-cleanup");
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function exerciseHeaderVaultRequestCenter(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Vault Request Center owner-and-popover effect was observed.");
  try {
    await postUi(connection, { vaultRequestCenterOpen: false, source: "final-surface-ui-control-driver" });
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, VAULT_REQUEST_POPOVER_SELECTOR);
    const control = await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      webdriverSelector(HEADER_VAULT_REQUEST_SELECTOR),
    );
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `${webdriverSelector(HEADER_VAULT_REQUEST_SELECTOR)}[aria-expanded='true']`,
    );
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_REQUEST_POPOVER_SELECTOR);
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click expanded the Vault Request Center owner and exposed its exactly labelled popover.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await postUi(connection, { vaultRequestCenterOpen: false, source: "final-surface-ui-control-driver-cleanup" });
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, VAULT_REQUEST_POPOVER_SELECTOR);
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function exerciseBrowserDisclosure(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const selector = assignment.surface.selector ?? "";
  const disclosure = BROWSER_DISCLOSURE_CONTROLS[selector as keyof typeof BROWSER_DISCLOSURE_CONTROLS];
  const outcome = emptyOutcome(assignment, "No native Browser disclosure owner-and-panel effect was observed.");
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!disclosure) throw new Error(`UI control driver does not support selector ${selector || "<missing>"}`);
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface native ${disclosure.label} disclosure proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    const disclosureRightPanel = "rightPanel" in disclosure ? disclosure.rightPanel : null;
    if (disclosureRightPanel) {
      await setBrowserRightPanelTab(connection, webdriver, disclosureRightPanel, "Browser disclosure owner setup");
    }
    await closeBrowserDisclosureIfOpen(webdriver, selector, disclosure.panel);

    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(selector));
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `${webdriverSelector(selector)}[aria-expanded='true']`,
    );
    await waitForReleaseSurfaceWebDriverElement(webdriver, disclosure.panel);
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click expanded the ${disclosure.label} owner and exposed its exactly labelled panel.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (disclosure && browserWindowOpen) {
      try {
        await closeBrowserDisclosureIfOpen(webdriver, selector, disclosure.panel);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
      if ("rightPanel" in disclosure) {
        try {
          await setBrowserRightPanelTab(connection, webdriver, "chat", "Browser disclosure right-panel cleanup");
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (taskId) {
      try {
        await cleanupOwnedUiBrowserTask(connection, taskId, "final surface UI control");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (originalWindow) {
      try {
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function closeBrowserDisclosureIfOpen(
  webdriver: WebDriver,
  inventorySelector: string,
  panelSelector: string,
): Promise<void> {
  const selector = webdriverSelector(inventorySelector);
  try {
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `${selector}[aria-expanded='true']`,
      { timeoutMs: 250, pollMs: 50 },
    );
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
  } catch {
    // The requested closed baseline is already active.
  }
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, panelSelector, { timeoutMs: 5_000, pollMs: 50 });
}

async function exerciseVaultWorkspaceTab(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const selector = assignment.surface.selector ?? "";
  const target = VAULT_WORKSPACE_CONTROLS[selector as keyof typeof VAULT_WORKSPACE_CONTROLS];
  const baseline: VaultWorkspaceTab = target === "secrets" ? "setup" : "secrets";
  const outcome = emptyOutcome(assignment, "No native Vault workspace-tab selection effect was observed.");
  let settingsOpen = false;
  try {
    if (!target) throw new Error(`UI control driver does not support selector ${selector || "<missing>"}`);
    await openVaultSettings(connection, webdriver);
    settingsOpen = true;
    await selectVaultWorkspaceTab(webdriver, baseline, "Vault workspace setup");
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(selector));
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForVaultWorkspaceTab(webdriver, target, "Vault workspace native effect");
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click changed the selected Vault workspace owner and tabpanel from ${baseline} to ${target}.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (target && settingsOpen) {
      try {
        await selectVaultWorkspaceTab(webdriver, baseline, "Vault workspace cleanup");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (settingsOpen) {
      try {
        await closeSettings(connection, webdriver);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function exerciseVaultResourceFormTab(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const selector = assignment.surface.selector ?? "";
  const target = VAULT_RESOURCE_FORM_CONTROLS[selector as keyof typeof VAULT_RESOURCE_FORM_CONTROLS];
  const baseline: VaultResourceFormTab = target === "secret" ? "stripeAgentWallet" : "secret";
  const outcome = emptyOutcome(assignment, "No native Vault resource-form tab selection effect was observed.");
  let settingsOpen = false;
  try {
    if (!target) throw new Error(`UI control driver does not support selector ${selector || "<missing>"}`);
    await openVaultSettings(connection, webdriver);
    settingsOpen = true;
    await selectVaultWorkspaceTab(webdriver, "secrets", "Vault resource workspace setup");
    await selectVaultResourceFormTab(webdriver, baseline, "Vault resource form setup");
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(selector));
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForVaultResourceFormTab(webdriver, target, "Vault resource form native effect");
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click changed the selected Vault resource editor and tabpanel from ${baseline} to ${target}.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (target && settingsOpen) {
      try {
        await selectVaultResourceFormTab(webdriver, baseline, "Vault resource form cleanup");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (settingsOpen) {
      try {
        await closeSettings(connection, webdriver);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function exerciseActivityView(
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const selector = assignment.surface.selector ?? "";
  const target = ACTIVITY_VIEW_CONTROLS[selector as keyof typeof ACTIVITY_VIEW_CONTROLS];
  const baseline: ActivityView = target === "files" ? "summary" : "files";
  const outcome = emptyOutcome(assignment, "No native Activity Browser view-selection effect was observed.");
  let modalOpen = false;
  try {
    if (!target) throw new Error(`UI control driver does not support selector ${selector || "<missing>"}`);
    await openActivityBrowser(webdriver);
    modalOpen = true;
    await selectActivityView(webdriver, baseline, "Activity view setup");
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(selector));
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForActivityView(webdriver, target, "Activity view native effect");
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click changed the selected Activity Browser owner and tabpanel from ${baseline} to ${target}.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (target && modalOpen) {
      try {
        await selectActivityView(webdriver, baseline, "Activity view cleanup");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (modalOpen) {
      try {
        await closeActivityBrowser(webdriver);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function exerciseActivityEvidenceSections(
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Activity Evidence section transitions were observed.");
  let modalOpen = false;
  try {
    await openActivityBrowser(webdriver);
    modalOpen = true;
    await selectActivityView(webdriver, "evidence", "Activity Evidence fixture setup");
    for (const section of ACTIVITY_EVIDENCE_SECTIONS) {
      const base = `[data-debug-id='activity-evidence-section-${section}-expand']`;
      const collapsed = `${base}[aria-pressed='false']`;
      const expanded = `${base}[aria-pressed='true']`;
      const focusedGrid = `.activity-evidence-grid.activity-evidence-grid-focused-${section}`;
      const control = await waitForReleaseSurfaceWebDriverElement(webdriver, collapsed);
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      await waitForReleaseSurfaceWebDriverElement(webdriver, expanded);
      await waitForReleaseSurfaceWebDriverElement(webdriver, focusedGrid);
      const restore = await waitForReleaseSurfaceWebDriverElement(webdriver, expanded);
      await clickReleaseSurfaceWebDriverElement(webdriver, restore);
      await waitForReleaseSurfaceWebDriverElement(webdriver, collapsed);
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, focusedGrid);
    }
    outcome.present = "pass";
    outcome.invoke = "pass";
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver clicks expanded and restored all four concrete Activity Evidence sections, with matching pressed state and focused-grid ownership for each member of the dynamic control family.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (modalOpen) {
      for (const section of ACTIVITY_EVIDENCE_SECTIONS) {
        try {
          const expanded = await findReleaseSurfaceWebDriverElement(
            webdriver,
            `[data-debug-id='activity-evidence-section-${section}-expand'][aria-pressed='true']`,
          );
          if (expanded) await clickReleaseSurfaceWebDriverElement(webdriver, expanded);
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
      try {
        await selectActivityView(webdriver, "files", "Activity Evidence cleanup");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
      try {
        await closeActivityBrowser(webdriver);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function openActivityBrowser(webdriver: WebDriver): Promise<void> {
  const trace = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(TRACE_ACTION_SELECTOR));
  await clickReleaseSurfaceWebDriverElement(webdriver, trace);
  await waitForReleaseSurfaceWebDriverElement(webdriver, "[role='dialog'][aria-label='Activity Browser']");
}

async function closeActivityBrowser(webdriver: WebDriver): Promise<void> {
  const close = await waitForReleaseSurfaceWebDriverElement(
    webdriver,
    "[role='dialog'][aria-label='Activity Browser'] [aria-label='Close (Esc)']",
  );
  await clickReleaseSurfaceWebDriverElement(webdriver, close);
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, "[role='dialog'][aria-label='Activity Browser']");
}

async function selectActivityView(webdriver: WebDriver, view: ActivityView, label: string): Promise<void> {
  const selector = webdriverSelector(selectorForActivityView(view));
  const control = await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
  await clickReleaseSurfaceWebDriverElement(webdriver, control);
  await waitForActivityView(webdriver, view, label);
}

async function waitForActivityView(webdriver: WebDriver, view: ActivityView, label: string): Promise<void> {
  const selector = webdriverSelector(selectorForActivityView(view));
  try {
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `${selector}.active[aria-selected='true']`,
      { timeoutMs: 5_000, pollMs: 50 },
    );
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `#activity-panel-${view}[aria-labelledby='activity-tab-${view}']`,
      { timeoutMs: 5_000, pollMs: 50 },
    );
  } catch (error) {
    throw new Error(`${label} did not select ${view}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exerciseHeaderBrowser(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native ShellX Browser window effect was observed.");
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    const opened = await openBrowserWindow(webdriver);
    originalWindow = opened.originalHandle;
    outcome.present = "pass";
    outcome.invoke = "pass";
    browserWindowOpen = true;
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click opened the separately titled ShellX Browser window and switched to its chrome.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (browserWindowOpen && originalWindow) {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      }
      else if (originalWindow) await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function exerciseBrowserRightPanelTab(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const selector = assignment.surface.selector ?? "";
  const target = BROWSER_RIGHT_PANEL_CONTROLS[selector as keyof typeof BROWSER_RIGHT_PANEL_CONTROLS];
  const baseline: BrowserRightPanelTab = target === "chat" ? "errors" : "chat";
  const outcome = emptyOutcome(assignment, "No native Browser right-panel selection effect was observed.");
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!target) throw new Error(`UI control driver does not support selector ${selector || "<missing>"}`);
    const opened = await openBrowserWindow(webdriver);
    originalWindow = opened.originalHandle;
    browserWindowOpen = true;
    await setBrowserRightPanelTab(connection, webdriver, baseline, "Browser right-panel setup");
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(selector));
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForBrowserRightPanelTab(webdriver, target, "Browser right-panel native effect");
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click changed the selected Browser right-panel owner and visible tabpanel from ${baseline} to ${target}.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (target && browserWindowOpen) {
      try {
        await setBrowserRightPanelTab(connection, webdriver, baseline, "Browser right-panel cleanup");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (originalWindow) {
      try {
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

async function openBrowserWindow(webdriver: WebDriver): Promise<{ originalHandle: string; targetHandle: string }> {
  const control = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(HEADER_BROWSER_SELECTOR));
  await clickReleaseSurfaceWebDriverElement(webdriver, control);
  const deadline = Date.now() + 10_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ShellX Browser window did not open before timeout");
}

async function closeBrowserWindow(
  connection: Connection,
  webdriver: WebDriver,
  originalHandle: string,
): Promise<void> {
  let closeError: unknown = null;
  let restoreError: unknown = null;
  try {
    await closeReleaseSurfaceWebDriverWindow(webdriver);
    await waitForBrowserWindowClosedState(connection);
  } catch (error) {
    closeError = error;
  }
  try {
    await switchReleaseSurfaceWebDriverWindow(webdriver, originalHandle);
  } catch (error) {
    restoreError = error;
  }
  if (closeError || restoreError) {
    const closeDetail = closeError
      ? `Browser close failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`
      : "";
    const restoreDetail = restoreError
      ? `main-window restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
      : "";
    throw new Error([closeDetail, restoreDetail].filter(Boolean).join("; "));
  }
}

async function waitForBrowserWindowClosedState(connection: Connection): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastState = "Browser state was not read";
  while (Date.now() < deadline) {
    const state = await apiJson<Record<string, unknown>>(connection, "GET", "/browser/state");
    const engine = requiredRecord(state.engine, "Browser foreground engine");
    const enginePool = requiredRecord(state.enginePool, "Browser engine pool");
    const pooledEngines = Array.isArray(enginePool.engines)
      ? enginePool.engines.map((value) => requiredRecord(value, "Browser pooled engine"))
      : [];
    const closed = state.windowOpen === false
      && engine.mounted === false
      && pooledEngines.every((pooled) => pooled.mounted === false);
    if (closed) return;
    lastState = JSON.stringify({
      windowOpen: state.windowOpen,
      foregroundMounted: engine.mounted,
      pooledMounted: pooledEngines.filter((pooled) => pooled.mounted === true).length,
    });
    await delay(50);
  }
  throw new Error(`Native Browser close did not reconcile Debug API state: ${lastState}`);
}

async function setBrowserRightPanelTab(
  connection: Connection,
  webdriver: WebDriver,
  tab: BrowserRightPanelTab,
  label: string,
): Promise<void> {
  await postUi(connection, {
    debugSurface: "browser",
    rightTab: tab,
    source: "final-surface-ui-control-driver",
  });
  await waitForBrowserRightPanelTab(webdriver, tab, label);
}

async function waitForBrowserRightPanelTab(
  webdriver: WebDriver,
  tab: BrowserRightPanelTab,
  label: string,
): Promise<void> {
  const selector = webdriverSelector(selectorForBrowserRightPanelTab(tab));
  try {
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `${selector}.active[aria-selected='true']`,
      { timeoutMs: 5_000, pollMs: 50 },
    );
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `#shellx-browser-panel-${tab}[aria-labelledby='shellx-browser-right-tab-${tab}']`,
      { timeoutMs: 5_000, pollMs: 50 },
    );
  } catch (error) {
    throw new Error(`${label} did not select ${tab}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exerciseBrowserEvidenceRecord(
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const refresh = assignment.surface.selector === BROWSER_EVIDENCE_REFRESH_SELECTOR;
  const outcome = emptyOutcome(
    assignment,
    refresh
      ? "No completed native Flight Recorder refresh effect was observed."
      : "No native Flight Recorder identity effect was observed.",
  );
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: "Final surface native Flight Recorder UI proof",
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    await postUi(connection, {
      debugSurface: "browser",
      rightTab: "evidence",
      source: "final-surface-ui-control-driver",
    });
    const switched = await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    const controlSelector = refresh ? BROWSER_EVIDENCE_REFRESH_SELECTOR : BROWSER_EVIDENCE_RECORD_SELECTOR;
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, webdriverSelector(controlSelector));
    outcome.present = "pass";
    if (refresh) {
      await waitForBrowserEvidenceRefreshState(webdriver, 0, null);
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      outcome.invoke = "pass";
      const receipt = await waitForBrowserEvidenceManualRefresh(webdriver);
      outcome.effect = "pass";
      outcome.observedEffect = `A native WebDriver click completed exactly one Flight Recorder evidence reload and published its local completion receipt at ${receipt.completedAtMs}.`;
    } else {
      const before = await browserEvidenceReceiptIds(connection);
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForBrowserEvidenceIdentity(connection, taskId, before);
      await waitForReleaseSurfaceWebDriverElement(
        webdriver,
        ".shellx-browser-evidence-recorded[role='status']",
      );
      outcome.effect = "pass";
      outcome.observedEffect = "A native WebDriver click recorded one bounded Flight Recorder attempt for the exact disposable task with a valid SHA-256 identity and explicit evidence completeness; attempt identity was not retained.";
    }
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (taskId) {
      try {
        await cleanupOwnedUiBrowserTask(connection, taskId, "final surface UI control");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      await postUi(connection, {
        debugSurface: "browser",
        rightTab: "chat",
        source: "final-surface-ui-control-driver-cleanup",
      });
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeBrowserWindow(connection, webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (originalWindow) {
      try {
        await switchReleaseSurfaceWebDriverWindow(webdriver, originalWindow);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) {
      outcome.cleanup = "pass";
    } else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return finalizeOutcome(outcome);
}

interface BrowserEvidenceRefreshState {
  present: true;
  disabled: boolean;
  sequence: number;
  completedAtMs: number | null;
}

async function readBrowserEvidenceRefreshState(webdriver: WebDriver): Promise<BrowserEvidenceRefreshState> {
  const observation = await observeReleaseSurfaceInstalledInputElement(
    webdriver,
    webdriverSelector(BROWSER_EVIDENCE_REFRESH_SELECTOR),
    ["disabled", "title"],
  );
  if (!observation.present || !observation.visible || typeof observation.disabled !== "boolean") {
    throw new Error("Browser evidence Refresh is absent or omitted disabled state");
  }
  const match = observation.title?.match(/^Flight Recorder refresh receipt · sequence=(\d+) · completedAtMs=(none|\d+)$/);
  if (!match) throw new Error("Browser evidence Refresh omitted its bounded receipt title");
  const state: BrowserEvidenceRefreshState = {
    present: true,
    disabled: observation.disabled,
    sequence: Number(match[1]),
    completedAtMs: match[2] === "none" ? null : Number(match[2]),
  };
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 0) {
    throw new Error("Browser evidence Refresh returned an invalid sequence");
  }
  if (state.completedAtMs !== null && (!Number.isSafeInteger(state.completedAtMs) || state.completedAtMs <= 0)) {
    throw new Error("Browser evidence Refresh returned an invalid completion time");
  }
  return state;
}

async function waitForBrowserEvidenceRefreshState(
  webdriver: WebDriver,
  sequence: number,
  completedAtMs: number | null,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readBrowserEvidenceRefreshState(webdriver);
    if (state.sequence === sequence && state.completedAtMs === completedAtMs && !state.disabled) return;
    await delay(50);
  }
  throw new Error(`Browser evidence Refresh did not reach sequence ${sequence} with its exact baseline`);
}

async function waitForBrowserEvidenceManualRefresh(
  webdriver: WebDriver,
): Promise<BrowserEvidenceRefreshState & { completedAtMs: number }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readBrowserEvidenceRefreshState(webdriver);
    if (state.sequence === 1 && state.completedAtMs !== null && !state.disabled) {
      return state as BrowserEvidenceRefreshState & { completedAtMs: number };
    }
    await delay(50);
  }
  throw new Error("Browser evidence manual Refresh did not publish one exact successful response receipt");
}

async function browserEvidenceReceiptIds(connection: Connection): Promise<Set<string>> {
  const summary = await invokeReleaseTauriCommand(
    connection,
    "shellx_browser_operator_evidence_summary",
    { limit: 20 },
  );
  const recent = Array.isArray(summary.recent) ? summary.recent : [];
  return new Set(recent.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const receiptId = (entry as Record<string, unknown>).receiptId;
    return typeof receiptId === "string" ? [receiptId] : [];
  }));
}

async function waitForBrowserEvidenceIdentity(
  connection: Connection,
  taskId: string,
  before: Set<string>,
): Promise<{ attemptId: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const summary = await invokeReleaseTauriCommand(
      connection,
      "shellx_browser_operator_evidence_summary",
      { limit: 20 },
    );
    const recent = Array.isArray(summary.recent) ? summary.recent : [];
    for (const value of recent) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const receipt = value as Record<string, unknown>;
      if (receipt.kind !== "browserFlightRecorderExported" || receipt.taskId !== taskId) continue;
      const receiptId = requiredString(receipt.receiptId, "Flight Recorder receipt.receiptId");
      if (before.has(receiptId)) continue;
      const evidence = requiredRecord(receipt.evidence, "Flight Recorder receipt.evidence");
      const attemptId = requiredString(evidence.attemptId, "Flight Recorder evidence.attemptId");
      const sha256 = requiredString(evidence.sha256, "Flight Recorder evidence.sha256");
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Flight Recorder evidence.sha256 must be lowercase SHA-256");
      for (const key of ["events", "receipts", "gapCount"] as const) {
        if (typeof evidence[key] !== "number" || !Number.isSafeInteger(evidence[key]) || Number(evidence[key]) < 0) {
          throw new Error(`Flight Recorder evidence.${key} must be a non-negative safe integer`);
        }
      }
      if (typeof evidence.evidenceComplete !== "boolean") {
        throw new Error("Flight Recorder evidence.evidenceComplete must be explicit");
      }
      return { attemptId };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Flight Recorder identity receipt did not appear before timeout");
}

function webdriverSelector(inventorySelector: string): string {
  return inventorySelector.replaceAll('"', "'");
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || value.includes("\0")) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function selectorForSettingsTab(tab: SettingsTab): string {
  const entry = Object.entries(SETTINGS_TAB_CONTROLS).find(([, value]) => value === tab);
  if (!entry) throw new Error(`no Settings-tab selector exists for ${tab}`);
  return entry[0];
}

function selectorForRightRailTab(tab: RightRailTab): string {
  const entry = Object.entries(RIGHT_RAIL_TAB_CONTROLS).find(([, value]) => value === tab);
  if (!entry) throw new Error(`no right-rail tab selector exists for ${tab}`);
  return entry[0];
}

function selectorForBrowserRightPanelTab(tab: BrowserRightPanelTab): string {
  const entry = Object.entries(BROWSER_RIGHT_PANEL_CONTROLS).find(([, value]) => value === tab);
  if (!entry) throw new Error(`no Browser right-panel selector exists for ${tab}`);
  return entry[0];
}

function selectorForActivityView(view: ActivityView): string {
  const entry = Object.entries(ACTIVITY_VIEW_CONTROLS).find(([, value]) => value === view);
  if (!entry) throw new Error(`no Activity view selector exists for ${view}`);
  return entry[0];
}

function selectorForVaultWorkspaceTab(tab: VaultWorkspaceTab): string {
  const entry = Object.entries(VAULT_WORKSPACE_CONTROLS).find(([, value]) => value === tab);
  if (!entry) throw new Error(`no Vault workspace selector exists for ${tab}`);
  return entry[0];
}

function selectorForVaultResourceFormTab(tab: VaultResourceFormTab): string {
  const entry = Object.entries(VAULT_RESOURCE_FORM_CONTROLS).find(([, value]) => value === tab);
  if (!entry) throw new Error(`no Vault resource form selector exists for ${tab}`);
  return entry[0];
}

async function openVaultSettings(connection: Connection, webdriver: WebDriver): Promise<void> {
  await postUi(connection, { openModal: "settings", source: "final-surface-ui-control-driver" });
  await waitForReleaseSurfaceWebDriverElement(webdriver, "[role='dialog'][aria-label='Settings']");
  const vaultSettingsTab = await waitForReleaseSurfaceWebDriverElement(
    webdriver,
    webdriverSelector(selectorForSettingsTab("vault")),
  );
  await clickReleaseSurfaceWebDriverElement(webdriver, vaultSettingsTab);
  await waitForSettingsTab(webdriver, "vault", "Vault Settings owner setup");
}

async function closeSettings(connection: Connection, webdriver: WebDriver): Promise<void> {
  await postUi(connection, { openModal: "close", source: "final-surface-ui-control-driver-cleanup" });
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, "[role='dialog'][aria-label='Settings']");
}

async function selectVaultWorkspaceTab(
  webdriver: WebDriver,
  tab: VaultWorkspaceTab,
  label: string,
): Promise<void> {
  const control = await waitForReleaseSurfaceWebDriverElement(
    webdriver,
    webdriverSelector(selectorForVaultWorkspaceTab(tab)),
  );
  await clickReleaseSurfaceWebDriverElement(webdriver, control);
  await waitForVaultWorkspaceTab(webdriver, tab, label);
}

async function waitForVaultWorkspaceTab(
  webdriver: WebDriver,
  tab: VaultWorkspaceTab,
  label: string,
): Promise<void> {
  const selector = webdriverSelector(selectorForVaultWorkspaceTab(tab));
  try {
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `${selector}.active[aria-selected='true']`,
      { timeoutMs: 5_000, pollMs: 50 },
    );
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `#vault-workspace-panel-${tab}[aria-labelledby='vault-tab-${tab}']`,
      { timeoutMs: 5_000, pollMs: 50 },
    );
  } catch (error) {
    throw new Error(`${label} did not select ${tab}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function selectVaultResourceFormTab(
  webdriver: WebDriver,
  tab: VaultResourceFormTab,
  label: string,
): Promise<void> {
  const control = await waitForReleaseSurfaceWebDriverElement(
    webdriver,
    webdriverSelector(selectorForVaultResourceFormTab(tab)),
  );
  await clickReleaseSurfaceWebDriverElement(webdriver, control);
  await waitForVaultResourceFormTab(webdriver, tab, label);
}

async function waitForVaultResourceFormTab(
  webdriver: WebDriver,
  tab: VaultResourceFormTab,
  label: string,
): Promise<void> {
  const selector = webdriverSelector(selectorForVaultResourceFormTab(tab));
  try {
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `${selector}.active[aria-selected='true']`,
      { timeoutMs: 5_000, pollMs: 50 },
    );
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `#vault-resource-form-panel-${tab}[aria-labelledby='vault-resource-form-tab-${tab}']`,
      { timeoutMs: 5_000, pollMs: 50 },
    );
  } catch (error) {
    throw new Error(`${label} did not select ${tab}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForSettingsTab(webdriver: WebDriver, tab: SettingsTab, label: string): Promise<void> {
  try {
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `${webdriverSelector(selectorForSettingsTab(tab))}[aria-selected='true']`,
      { timeoutMs: 5_000, pollMs: 50 },
    );
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `#settings-tab-panel[aria-labelledby='settings-tab-${tab}']`,
      { timeoutMs: 5_000, pollMs: 50 },
    );
  } catch (error) {
    throw new Error(`${label} did not select ${tab}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function setRightRailTab(
  connection: Connection,
  webdriver: WebDriver,
  tab: RightRailTab,
  label: string,
): Promise<void> {
  await postUi(connection, {
    debugSurface: "app",
    source: "final-surface-ui-control-driver",
    openModal: "close",
    debugHighlights: [],
    rightTab: tab,
  });
  await waitForRightRailTab(connection, webdriver, tab, label);
}

async function waitForRightRailTab(
  connection: Connection,
  webdriver: WebDriver,
  tab: RightRailTab,
  label: string,
): Promise<void> {
  const selector = webdriverSelector(selectorForRightRailTab(tab));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const state = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
      await waitForReleaseSurfaceWebDriverElement(webdriver, `${selector}.active[aria-selected='true']`, {
        timeoutMs: 500,
        pollMs: 50,
      });
      if (state.rightTab === tab) return;
    } catch {
      // Debug state and the visible React selection may settle on adjacent turns.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`${label} did not reach ${tab} in Debug API and selected owner state`);
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", body);
}

function emptyOutcome(
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
  observedEffect: string,
): ReleaseSurfaceDriverOutcome {
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

function unsupportedOutcome(
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
  selector: string,
): ReleaseSurfaceDriverOutcome {
  return finalizeOutcome({
    ...emptyOutcome(assignment, "No supported native UI control family matched this surface."),
    cleanup: "pass",
    error: `UI control driver does not support selector ${selector || "<missing>"}`,
  });
}

function finalizeOutcome(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "UI control did not satisfy every required verdict";
  }
  return outcome;
}

async function apiJson<T>(
  connection: Connection,
  method: "GET" | "POST" | "DELETE",
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

async function invokeReleaseTauriCommand(
  connection: Connection,
  command: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const started = await apiJson<Record<string, unknown>>(
    connection,
    "POST",
    "/release-test/tauri-invokes",
    { command, args },
  );
  const invokeId = requiredString(started.id, "release Tauri invoke id");
  if (!/^rti-[0-9a-f]{32}$/.test(invokeId) || started.status !== "pending") {
    throw new Error("release Tauri invoke returned an invalid start receipt");
  }
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const state = await apiJson<Record<string, unknown>>(
        connection,
        "GET",
        `/release-test/tauri-invokes/${encodeURIComponent(invokeId)}`,
      );
      if (state.status === "passed") {
        return requiredRecord(state.value, `${command} result`);
      }
      if (state.status === "failed") {
        throw new Error(typeof state.error === "string" ? state.error : `${command} failed`);
      }
      await delay(100);
    }
    throw new Error(`${command} did not complete before the 20 second deadline`);
  } finally {
    const removed = await apiJson<Record<string, unknown>>(
      connection,
      "DELETE",
      `/release-test/tauri-invokes/${encodeURIComponent(invokeId)}`,
    );
    if (removed.removed !== true) throw new Error(`${command} release relay state remained after cleanup`);
  }
}

async function cleanupOwnedUiBrowserTask(
  connection: Connection,
  taskId: string,
  label: string,
): Promise<void> {
  const result = await cleanupOwnedBrowserLifecycle(
    (method, path, body) => apiJson(connection, method, path, body),
    { taskIds: [taskId], label },
  );
  if (result.errors.length > 0) {
    throw new Error(`${label} Browser cleanup reported: ${result.errors.join("; ")}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runReleaseSurfaceDriverCli(UI_CONTROL_INSTALLED_MANIFEST, executeUiControlInstalled).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
