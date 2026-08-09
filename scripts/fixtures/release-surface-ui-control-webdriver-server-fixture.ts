import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const args = process.argv.slice(2);
const stateOut = requiredArg(args, "--state-out");
const token = requiredArg(args, "--token");
const sessionId = requiredArg(args, "--session-id");
const instanceId = requiredArg(args, "--instance-id");
const processId = Number(requiredArg(args, "--process-id"));
const version = requiredArg(args, "--version");
const sourceCommit = requiredArg(args, "--source-commit");
const profileRoot = requiredArg(args, "--profile-root");
const leftRailLifecycle = args.includes("--left-rail-lifecycle");
const pluginsProductionLifecycle = args.includes("--plugins-production-lifecycle");
const clickedSelectors: string[] = [];
const aboutExternalUrls: string[] = [];
let bottomTab = "Chat";
let settingsOpen = false;
let settingsTab = "general";
let dataDeleteDialogOpen = false;
let dataDeleteReceipt: { key: string; diskRemoved: boolean; localStorageCleared: boolean } | null = null;
let ownedUserData: Record<string, unknown> = {};
let setupGuideDismissed = false;
let agentCliSetupFixtureMode: "closed" | "cards" | "confirmation" | "status-card" | "live-status" | "live-setup" | "install-lifecycle" = "closed";
let agentCliStatusDialogProvider: string | "all" | null = null;
let ownedAgentCliVersion: string | null = null;
let ownedAgentCliScanCount = 0;
let agentCliInstallConfirmationId: string | null = null;
let agentCliInstallPrepareCount = 0;
let agentCliInstallCancelCount = 0;
let agentCliInstallRunCount = 0;
let pluginsOpen = false;
let pluginsFixtureActive = false;
let pluginsProductionFixtureActive = false;
let pluginsKeyFormEntryId: string | null = null;
let pluginsKeyDraftValue = "";
let pluginsUnsafeMutationCount = 0;
const pluginsVaultKeys = new Set<string>();
let buildPlanFixtureActive = false;
let buildPlanReviewOpen = false;
let buildPlanUnsafeMutationCount = 0;
let buildPlanRejectArmed = false;
let shellxagentFixtureActive = false;
let shellxagentRevealed = false;
let shellxagentUnsafeMutationCount = 0;
let shellxagentRotationCount = 0;
let remoteCwdOpen = false;
let remoteCwdPath = "";
let remoteCwdDraft = "";
let remoteCwdUnsafeUseCount = 0;
let remoteCwdIsolatedLaunchCount = 0;
let remoteCwdOwnedUseActive = false;
let remoteCwdOwnedUseLaunchCount = 0;
let theme = "black";
let persistedTheme: string | null = null;
let rightTab = "Tasks";
let debugUpdateFixture: "live" | "owned-check" | "owned-available" | "owned-cleared" = "live";
let updateBannerAvailable = false;
let rightRailUpdateAvailable = false;
let aboutUpdateAvailable = false;
let updateBannerReceipt: string | null = null;
let rightRailUpdateReceipt: string | null = null;
let aboutUpdateReceipt: string | null = null;
let debugUiConnectionFixture: "clear" | "disconnected" = "clear";
let debugUiWebSocketActive = 1;
let debugUiWebSocketGeneration = 1;
let errorBoundaryOpen = false;
let errorBoundaryDocumentGeneration = 1;
let lazySurfaceState: "closed" | "error" | "recovered" = "closed";
const rendererCrashEvents: Array<{ t: number; kind: string; payload: Record<string, unknown> }> = [];
let releaseTestVoiceRecording = false;
let releaseTestVoiceMode = false;
let goalState: Record<string, unknown> | null = null;
let goalLastClear: Record<string, unknown> | null = null;
let goalReviewModalOpen = false;
let goalPlanReviewFixtureMode: "closed" | "review" | "editing" = "closed";
let goalPlanReviewEditing = false;
let goalPlanReviewComment = "";
let goalPlanRejectArmed = false;
let goalProviderAction: "goal-approve" | "goal-replan" | null = null;
let goalProviderDigest: string | null = null;
let goalProviderRunId: string | null = null;
let buildRunCockpitFixtureActive = false;
let buildRunCockpitShowAllReceipts = false;
let buildRunState: Record<string, unknown> | null = null;
let buildRunReceipts: Array<Record<string, unknown>> = [];
let buildRunProviderAction: "build-approve" | "build-resume" | null = null;
let buildRunProviderDigest: string | null = null;
let buildRunProviderRunId: string | null = null;
let pendingAlertText: string | null = null;
let pendingPromptResponseText: string | null = null;
let pendingAttachmentFindTarget: "board" | "bottom" | null = null;
let pendingConnectionDeleteId: string | null = null;
let pendingSettingsConnectionDeleteId: string | null = null;
let agentRunsManualRefreshSequence = 0;
let agentRunsManualRefreshGeneratedAtMs: number | null = null;
let tasksManualRefreshSequence = 0;
let tasksCleanupMcpArmed = false;
let ownedTerminalSequence = 0;
type FixtureBackgroundTask = {
  taskId: string;
  origin: "user_term" | "host_mcp";
  commandDisplay: string;
  pid: number;
  cpuPct: number;
  rssMb: number;
  status: "running" | "stopped" | "killed";
  startedAtMs: number;
  recentOutputTail: string;
  tabId: string;
  terminalId?: string;
};
let ownedBackgroundTasks: FixtureBackgroundTask[] = [];
const expandedBackgroundTaskIds = new Set<string>();
const releaseTauriInvokes = new Map<string, { value: unknown }>();
let releaseTauriInvokeSequence = 0;
let chatOutputLifecycleActive = false;
let chatOutputThoughtExpanded = false;
let chatOutputJumpVisible = false;
let chatOutputDoomVisible = false;
let chatOutputHostVisible = false;
let chatOutputUpCount = 0;
let chatOutputAttachmentPath: string | null = null;
let chatOutputDiffPath: string | null = null;
let rightRailGitLifecycleActive = false;
let rightRailGitRefreshSequence = 0;
let rightRailGitDiffScope = "head";
let rightRailGitDiffVisible = false;
let rightRailModelCardsRefreshSequence = 0;
let rightRailEnvironmentRefreshSequence = 0;
let rightRailEnvironmentTraceReceipt: string | null = null;
let rightRailGitWriteCheckpointCount = 0;
let rightRailGitWriteWorktreeCount = 0;
let permissionFixtureAction: string | null = null;
let permissionDecision: string | null = null;
let providerActionFixture: string | null = null;
let providerActionDigest: string | null = null;
let providerActionRunId: string | null = null;
const baselineActiveTab: Record<string, unknown> = {
  tabId: "fixture-active-tab-035",
  cwd: "/fixture/original-cwd",
  autonomy: "default",
  connectionId: null,
  connectionLabel: "Local",
  connectionTransport: "local",
  shellxToolExposure: "nativeFirst",
};
let activeTab: Record<string, unknown> = structuredClone(baselineActiveTab);
let openSessionTabs: Array<Record<string, unknown>> = [sessionTabFromActive(baselineActiveTab)];
let ownedSessionTabSequence = 0;
let sessionDropdownOpen = false;
let sessionRenamingTabId: string | null = null;
let sessionRenameValue = "";
let sessionRailScrollLeft = 0;
const SESSION_RAIL_CLIENT_WIDTH = 720;
const SESSION_TAB_WIDTH = 180;
const SESSION_NEW_BUTTON_WIDTH = 44;
const findOwnedSessionId = `release_session_${sourceCommit.slice(0, 16)}_ui_find_new_tab`;
const findOwnedTabId = `fixture-find-owned-tab-${sourceCommit.slice(0, 16)}`;
const bottomPanelOwnedTabId = `fixture-bottom-panel-owned-tab-${sourceCommit.slice(0, 16)}`;
let bottomPanelAttachmentPaths: string[] = [];
let bottomPanelImagePath: string | null = null;
let bottomPanelTerminalIds: string[] = [];
let bottomPanelActiveTerminal: string | null = null;
let bottomPanelFixtureUserVisible = false;
let previewState: Record<string, unknown> | null = null;
let renderedPreviewState: Record<string, unknown> | null = null;
let previewStarts = 0;
let previewRefreshes = 0;
let previewCenterView: "file" | "work" = "file";
let previewFilePath: string | null = null;
let filePreviewHtmlMode: "code" | "safe" = "code";
let workPreviewDiagnostic: {
  cardClass: string;
  summary: string;
  http: string;
  title: string;
  screenshotPath: string;
  screenshotError: null;
} | null = null;
let doctorScreenshotPath: string | null = null;
let workPreviewKind = "auto";
let workPreviewViewport = "desktop";
let workPreviewReloadSeq = 0;
let workPreviewLogHeight = 260;
let workPreviewLogHeightStored: string | null = null;
let browserRightTab = "chat";
let neutralFocusClicks = 0;
let activeTaskId: string | null = null;
let browserTaskId: string | null = null;
let browserTaskTabId: string | null = null;
let browserTaskOwnerSessionId: string | null = null;
let browserTaskUrl: string | null = null;
let activeTaskStatus: string | null = null;
let browserDownloadFolder: string | null = null;
let browserTransferSequence = 0;
const browserDownloads: Array<Record<string, unknown>> = [];
let recorderIndex = 0;
let recorderStatusVisible = false;
let browserEvidenceManualRefreshSequence = 0;
let browserEvidenceManualRefreshCompletedAtMs: number | null = null;
const browserProfileAdModes = new Map<string, "balanced" | "strict" | "off">();
let currentWindow = "main-window";
let browserWindowOpen = false;
let activityOpen = false;
let activityView = "files";
let activityEvidenceFocused: "changes" | "reads" | "commands" | "git" | null = null;
let activitySearchValue = "";
let composerPicker: "connection" | "agent" | "branch" | null = null;
let agentPickerFixtureActive = false;
let keyboardHintOpen = false;
let helpModalOpen = false;
let vaultWorkspaceTab = "secrets";
let vaultResourceFormTab = "secret";
let browserDisclosure: string | null = null;
let browserRightSidebarVisible = true;
let browserRightSidebarWidth = 360;
let browserHomepageValue = "https://example.com/";
let browserHomepageStoredValue: string | null = null;
let browserColorMode = "system";
let browserColorModeStoredValue: string | null = null;
let browserParallelAgents = "auto";
let browserProfileId = "task-disposable";
const browserAutomationMode = "normal";
const browserPersonalLock = {
  enabled: false,
  locked: false,
  timeoutMinutes: 30,
  authMode: "deviceAuthPreferred" as "deviceAuthPreferred" | "pinOnly",
  pinConfigured: false,
  blurLockedTabs: true,
  pauseDelegatedTabsWhenLocked: true,
  lockOnSleep: true,
  lockOnMinimize: false,
};
let browserPersonalLockPinDraft = "";
let browserPersonalLockNotice = false;
let browserPersonalLockVerifierDigest: string | null = null;
let browserPersonalTabId: string | null = null;
type FixtureSiteShields = {
  host: string;
  adTrackerMode: "off" | "balanced" | "strict";
  cookieMode: "allowAll" | "blockThirdParty" | "blockAll";
  fingerprintingMode: "compatibility" | "strict";
  httpsUpgradeEnabled: boolean;
  scriptBlockingEnabled: boolean;
  updatedAtMs: number;
};
let browserActiveHost: string | null = null;
const browserShields: {
  enabled: boolean;
  adTrackerMode: FixtureSiteShields["adTrackerMode"];
  cookieMode: FixtureSiteShields["cookieMode"];
  fingerprintingMode: FixtureSiteShields["fingerprintingMode"];
  httpsUpgradeEnabled: boolean;
  scriptBlockingEnabled: boolean;
  siteOverrides: FixtureSiteShields[];
  updatedAtMs: number;
} = {
  enabled: true,
  adTrackerMode: "balanced",
  cookieMode: "blockThirdParty",
  fingerprintingMode: "compatibility",
  httpsUpgradeEnabled: true,
  scriptBlockingEnabled: false,
  siteOverrides: [],
  updatedAtMs: 1_750_000_000_000,
};
let browserHistorySearch = "";
let browserHistoryDateFilter = "all";
let browserHistoryScope = "user";
let browserBookmarkManageMode = false;
let browserBookmarkDraftLabel = "";
let browserBookmarkDraftUrl = "";
let browserAddressValue = "about:blank";
let browserGoalValue = "Browse the page, extract needed information, and report with receipts.";
let vaultRequestCenterOpen = false;
let vaultWorkspaceModalOpen = false;
let vaultWorkspaceIntent: "overview" | "newSecret" | "setup" | null = null;
let vaultPasswordGeneratorOpen = false;
let vaultPasswordLowercase = true;
let vaultPasswordRevealed = false;
let vaultPasswordLength = 24;
let focusedSelector: string | null = null;
type OwnedModalId = "assets" | "connectorInbox" | "preview" | "vault" | "pr";
let ownedModalOpen: OwnedModalId | null = null;
let previewTarget: Record<string, unknown> | null = null;
let previewVideoPlaybackState: "idle" | "playing" | "paused" = "idle";
let attachmentMediaPendingPaths: string[] = [];
let attachmentMediaSessionPath: string | null = null;
let attachmentMediaImagePath: string | null = null;
let attachmentMediaVideoPath: string | null = null;
let filesPaneSessionPath: string | null = null;
let filesPaneFolder: "session" | "nested" | "parent" = "session";
let filesPaneSelected = false;
let connectorSearchValue = "";
let connectorDateValue = "";
let connectorFilter = "all";
let connectorInboxManualRefreshSequence = 0;
let connectorInboxManualRefreshCompletedAtMs: number | null = null;
let connectorInboxManualRefreshConnectorCount: number | null = null;
let connectorInboxManualRefreshEventCount: number | null = null;
let connectorInboxManualRefreshMaxEventMs: number | null = null;
let prApprovalChecked = false;
let prDraftActive = false;
let prTranscriptActive = false;
let releaseTestExternalEffectBoundary: "pr-create" | "artifact-archive" | null = null;
let prCreateBoundaryReceipt: string | null = null;
let artifactArchiveReceipt: string | null = null;
let hashItemsFixtureActive = false;
const prTextValues: Record<string, string> = {
  "[data-debug-id='pr-base-input']": "",
  "[data-debug-id='pr-title-input']": "",
  "[data-debug-id='pr-body-input']": "",
};
let commandPaletteOpen = false;
let commandPaletteInputValue = "";
let findSessionsFocused = false;
let findOpenRowSelected = false;
let findDiskRowSelected = false;
let connectionEditorOpen = false;
let connectionEditorOwnedId: string | null = null;
let connectionTransport = "local";
let connectionRuntime = "posix";
let connectionSshKeyVaultRef = "";
const connectionVaultKeys = new Set<string>();
const connectionPresets = new Map<string, Record<string, unknown>>();
const connectionTestResults = new Map<string, { reachable: boolean; latencyMs: number | null; error: string | null }>();
let connectionEditorProviderScan: Array<Record<string, unknown>> | null = null;
let settingsConnectionRows: Array<Record<string, unknown>> = [];
let settingsConnectionsRefreshCount = 0;
let connectorDraftOpen = false;
let connectorProvider = "telegram";
let connectorEnabled = false;
let connectorDispatchMode = "inbox";
let connectorTargetMode = "activeTab";
let connectorVaultKey = "telegram/bot-token";
let connectorAllowedIds = "";
let connectorsFixtureActive = false;
let connectorSecretValue = "";
let connectorFixedTabId = "";
let connectorSimConnectorId = "";
let connectorEditingId = "";
let connectorUnsafeMutationCount = 0;
const connectorSimValues: Record<string, string> = {
  "[id='connector-sim-sender']": "",
  "[id='connector-sim-conversation']": "",
  "[id='connector-sim-text']": "",
};
let builtinDoc: "Features" | "Quick start" | "Changelog" | "Third-party notices" | null = null;
let pendingPointerSelector: string | null = null;
let pluginsTierExpanded = true;
const pluginsMarketplaceStatePath = join(profileRoot, ".shellx", "mcp-marketplace.json");
const pluginsMarketplaceConfigPath = join(profileRoot, ".grok", "config.toml");

function pluginsMarketplaceEntry(id: "context7" | "github"): { installed: boolean; enabled: boolean } {
  try {
    const state = JSON.parse(readFileSync(pluginsMarketplaceStatePath, "utf8")) as {
      entries?: Record<string, { installed?: boolean; enabled?: boolean }>;
    };
    const entry = state.entries?.[id];
    return { installed: entry?.installed === true, enabled: entry?.enabled !== false };
  } catch {
    return { installed: false, enabled: true };
  }
}

function writePluginsMarketplaceEntry(
  id: "context7" | "github",
  installed: boolean,
  enabled: boolean,
): void {
  mkdirSync(dirname(pluginsMarketplaceStatePath), { recursive: true, mode: 0o700 });
  writeFileSync(pluginsMarketplaceStatePath, JSON.stringify({ entries: { [id]: { installed, enabled } } }), {
    encoding: "utf8",
    mode: 0o600,
  });
  mkdirSync(dirname(pluginsMarketplaceConfigPath), { recursive: true, mode: 0o700 });
  if (!installed) {
    if (existsSync(pluginsMarketplaceConfigPath)) unlinkSync(pluginsMarketplaceConfigPath);
    return;
  }
  const secretReference = id === "github"
    ? '\nheaders = { "Authorization" = "Bearer ${SHELLX_MCP_MARKETPLACE_GITHUB_PAT}" }'
    : "";
  writeFileSync(pluginsMarketplaceConfigPath, [
    `# shellX:managed-mcp-marketplace:${id} BEGIN - do not edit by hand`,
    `[mcp_servers.shellx-mp-${id}]`,
    `enabled = ${String(enabled)}`,
    `type = "${id === "github" ? "http" : "stdio"}"${secretReference}`,
    `# shellX:managed-mcp-marketplace:${id} END`,
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
}

let projectsExpanded = true;
let openChatsExpanded = true;
let pastChatsExpanded = true;
let ownedProjectDraft = false;
let ownedProjectRenaming = false;
let ownedProjectRenameValue = "";
let ownedProjectExpanded = false;
let ownedProjectDeleteDialog = false;
const leftRailProjectId = "release-left-rail-project-" + sourceCommit.slice(0, 16);
const leftRailOwnedSessionId = "release_session_" + sourceCommit.slice(0, 16) + "_ui_left_rail_lifecycle";
const leftRailOwnedTabId = "fixture-left-rail-owned-tab-" + sourceCommit.slice(0, 16);
const leftRailUserDataPath = join(profileRoot, ".shellx", "user-data.json");
let leftRailPastAvailable = false;
let leftRailChatContextOpen = false;
let leftRailPastContextOpen = false;
let leftRailSessionDeleteDialog = false;
let leftRailSessionDeleteTarget: "baseline-open" | "owned-past" | null = null;
let leftRailRenaming: "open" | "past" | null = null;
let leftRailRenameValue = "";
let leftRailPastTitle = "Release session history " + sourceCommit.slice(0, 16);
const leftRailChatTitles: Record<string, string> = {};
const leftRailSessionProjects: Record<string, string> = {};
const connectionDraftValues: Record<string, string> = {
  "[data-debug-id='connection-label-input']": "",
  "[data-debug-id='connection-wsl-distro-input']": "",
  "[data-debug-id='connection-ssh-host-input']": "",
  "[data-debug-id='connection-ssh-port-input']": "",
  "[data-debug-id='connection-ssh-wsl-distro-input']": "",
};
const publicSettings = {
  browserDownloadFolder: "",
  chatFontPx: 19,
  density: "default",
  githubGhBinary: "gh",
  permissionUx: "pill",
  theme: "black",
};
let releaseNativePickerLease: {
  kind: "file" | "directory";
  path: string;
  pathSha256: string;
} | null = null;
let vaultKeyfileSelected = false;
const alwaysVisibleTextValues: Record<string, string> = {
  "[data-debug-id='find-sessions-input']": "",
  "[data-debug-id='composer-prompt']": "",
};
const rightRailTextValues: Record<string, string> = {
  "[data-debug-id='tasks-filter-input']": "",
  "[data-debug-id='files-search-input']": "",
};
const inputClearCounts: Record<string, number> = {
  "[data-debug-id='plugins-vault-key-input']": 0,
  "[data-marketplace-entry-id='github'] [data-debug-id='plugins-vault-key-input']": 0,
  "[data-debug-id='activity-search']": 0,
  "[data-debug-id='connector-inbox-search-input']": 0,
  "[data-debug-id='connector-inbox-date-input']": 0,
  "[data-debug-id='pr-base-input']": 0,
  "[data-debug-id='pr-title-input']": 0,
  "[data-debug-id='pr-body-input']": 0,
  "[data-debug-id='tasks-filter-input']": 0,
  "[data-debug-id='files-search-input']": 0,
  "[data-debug-id='command-palette-input']": 0,
  "[data-debug-id='find-sessions-input']": 0,
  "[data-debug-id='composer-prompt']": 0,
  "[data-debug-id='remote-cwd-input']": 0,
  "[data-debug-id='settings-browser-download-folder']": 0,
  "[data-debug-id='shellx-browser-download-folder']": 0,
  "[data-debug-id='shellx-browser-homepage']": 0,
  "[data-debug-id='shellx-browser-history-search']": 0,
  "[data-debug-id='shellx-browser-bookmark-draft-label']": 0,
  "[data-debug-id='shellx-browser-bookmark-draft-url']": 0,
  "[data-debug-id='shellx-browser-address']": 0,
  "[data-debug-id='shellx-browser-goal']": 0,
  "[data-debug-id='shellx-browser-personal-lock-pin']": 0,
  "[data-debug-id='shellx-browser-personal-lock-overlay-pin']": 0,
  "[data-debug-id='connection-label-input']": 0,
  "[data-debug-id='connection-wsl-distro-input']": 0,
  "[data-debug-id='connection-ssh-host-input']": 0,
  "[data-debug-id='connection-ssh-port-input']": 0,
  "[data-debug-id='connection-ssh-wsl-distro-input']": 0,
  "[data-debug-id='left-project-rename-input']": 0,
  "[data-debug-id='session-rename-input']": 0,
  "[data-debug-id='surface-components-settings-connectorstab-21']": 0,
  "[id='connector-secret']": 0,
  "[id='connector-allowed']": 0,
  "[id='connector-sim-sender']": 0,
  "[id='connector-sim-conversation']": 0,
  "[id='connector-sim-text']": 0,
  "[placeholder='What should Grok change about this plan? (Ctrl+Enter to submit)']": 0,
};
const taskToggleStates: Record<string, { checked: boolean; storageKey: string }> = {
  "[data-debug-id='tasks-show-all-tabs-checkbox']": {
    checked: false,
    storageKey: "tasks-panel-show-all-tabs",
  },
  "[data-debug-id='tasks-show-completed-checkbox']": {
    checked: false,
    storageKey: "tasks-panel-show-completed",
  },
};
const taskToggleStorage: Record<string, string | null> = {
  "tasks-panel-show-all-tabs": null,
  "tasks-panel-show-completed": null,
};
const evidenceReceipts: Array<Record<string, unknown>> = [];
let debugHighlightResults: Array<Record<string, unknown>> = [];

if (leftRailLifecycle) persistLeftRailUserData();

const OWNED_MODAL_BY_SELECTOR: Record<string, { id: OwnedModalId; dialog: string }> = {
  "[role='dialog'][aria-label='Attachment and media board'] [aria-label='Close']": {
    id: "assets",
    dialog: "[role='dialog'][aria-label='Attachment and media board']",
  },
  "[role='dialog'][aria-label='Connector inbox'] [aria-label='Close connector inbox']": {
    id: "connectorInbox",
    dialog: "[role='dialog'][aria-label='Connector inbox']",
  },
  "[role='dialog'][aria-label='Preview Center'] [aria-label='Close']": {
    id: "preview",
    dialog: "[role='dialog'][aria-label='Preview Center']",
  },
  "[role='dialog'][aria-label='Preview Center'] [title='Close (Esc)']": {
    id: "preview",
    dialog: "[role='dialog'][aria-label='Preview Center']",
  },
  "[data-debug-id='vault-workspace-modal'] [aria-label='Close']": {
    id: "vault",
    dialog: "[data-debug-id='vault-workspace-modal']",
  },
};

const TAB_BY_SELECTOR: Record<string, string> = {
  "[data-debug-id='bottom-tab-chat']": "Chat",
  "[data-debug-id='bottom-tab-terminal']": "Terminal",
  "[data-debug-id='bottom-tab-images']": "Images",
  "[data-debug-id='bottom-tab-videos']": "Videos",
  "[data-debug-id='bottom-tab-logs']": "Logs",
  "[data-debug-id='bottom-tab-stderr']": "Stderr",
};

const SETTINGS_TAB_BY_SELECTOR: Record<string, string> = {
  "[data-debug-id='settings-tab-general']": "general",
  "[data-debug-id='settings-tab-vault']": "vault",
  "[data-debug-id='settings-tab-connections']": "connections",
  "[data-debug-id='settings-tab-connectors']": "connectors",
  "[data-debug-id='settings-tab-desktop']": "desktop",
  "[data-debug-id='settings-tab-shellxagent']": "shellxagent",
  "[data-debug-id='settings-tab-data']": "data",
  "[data-debug-id='settings-tab-about']": "about",
};

const RIGHT_TAB_BY_SELECTOR: Record<string, string> = {
  "[data-debug-id='right-tab-tasks']": "Tasks",
  "[data-debug-id='right-tab-tooling']": "Tooling",
  "[data-debug-id='right-tab-git']": "Git",
  "[data-debug-id='right-tab-preview']": "Preview",
  "[data-debug-id='right-tab-plan']": "Plan",
  "[data-debug-id='right-tab-files']": "Files",
};

const BROWSER_RIGHT_TAB_BY_SELECTOR: Record<string, string> = {
  "[data-debug-id='shellx-browser-right-tab-chat']": "chat",
  "[data-debug-id='shellx-browser-right-tab-requests']": "requests",
  "[data-debug-id='shellx-browser-right-tab-actions']": "actions",
  "[data-debug-id='shellx-browser-right-tab-evidence']": "evidence",
  "[data-debug-id='shellx-browser-right-tab-errors']": "errors",
};

const ACTIVITY_VIEW_BY_SELECTOR: Record<string, string> = {
  "[data-debug-id='activity-tab-files']": "files",
  "[data-debug-id='activity-tab-graph']": "graph",
  "[data-debug-id='activity-tab-evidence']": "evidence",
  "[data-debug-id='activity-tab-timeline']": "timeline",
  "[data-debug-id='activity-tab-summary']": "summary",
};

const VAULT_WORKSPACE_TAB_BY_SELECTOR: Record<string, string> = {
  "[data-debug-id='vault-tab-secrets']": "secrets",
  "[data-debug-id='vault-tab-grants']": "grants",
  "[data-debug-id='vault-tab-setup']": "setup",
};

const VAULT_RESOURCE_FORM_TAB_BY_SELECTOR: Record<string, string> = {
  "[data-debug-id='vault-resource-form-tab-secret']": "secret",
  "[data-debug-id='vault-resource-form-tab-profileCard']": "profileCard",
  "[data-debug-id='vault-resource-form-tab-stripeAgentWallet']": "stripeAgentWallet",
};

const BROWSER_DISCLOSURE_BY_SELECTOR: Record<string, { id: string; panel: string; rightPanel?: string }> = {
  "[data-debug-id='shellx-browser-trust-chip']": {
    id: "trust",
    panel: "#shellx-browser-shields-panel[aria-labelledby='shellx-browser-trust-chip']",
  },
  "[data-debug-id='shellx-browser-downloads-menu']": {
    id: "downloads",
    panel: "#shellx-browser-download-sidecar[aria-labelledby='shellx-browser-downloads-menu']",
  },
  "[data-debug-id='shellx-browser-bookmarks-menu']": {
    id: "bookmarks",
    panel: "#shellx-browser-bookmark-manager-dock[aria-labelledby='shellx-browser-bookmarks-menu']",
  },
  "[data-debug-id='shellx-browser-history-menu']": {
    id: "history",
    panel: "#shellx-browser-history-sidecar[aria-labelledby='shellx-browser-history-menu']",
  },
  "[data-debug-id='shellx-browser-save-page']": {
    id: "save",
    panel: "#shellx-browser-save-menu[aria-labelledby='shellx-browser-save-page']",
  },
  "[data-debug-id='shellx-browser-ad-filter']": {
    id: "ads",
    panel: "#shellx-browser-ad-filter-menu[aria-labelledby='shellx-browser-ad-filter']",
  },
  "[data-debug-id='shellx-browser-options']": {
    id: "options",
    panel: "#shellx-browser-options-sidecar[aria-labelledby='shellx-browser-options']",
  },
  "[data-debug-id='shellx-browser-collapse-tasks']": {
    id: "sidebar-tasks",
    panel: "#shellx-browser-actions-tasks-section[aria-labelledby='shellx-browser-collapse-tasks']",
    rightPanel: "actions",
  },
  "[data-debug-id='shellx-browser-collapse-receipts']": {
    id: "sidebar-receipts",
    panel: "#shellx-browser-actions-receipts-section[aria-labelledby='shellx-browser-collapse-receipts']",
    rightPanel: "actions",
  },
  "[data-debug-id='shellx-browser-collapse-console']": {
    id: "sidebar-console",
    panel: "#shellx-browser-errors-console-section[aria-labelledby='shellx-browser-collapse-console']",
    rightPanel: "errors",
  },
};
const BROWSER_DISCLOSURE_CLOSE_BY_SELECTOR: Record<string, string> = {
  "[data-debug-id='shellx-browser-downloads-close']": "downloads",
  "[data-debug-id='shellx-browser-bookmark-manager-close']": "bookmarks",
  "[data-debug-id='shellx-browser-history-close']": "history",
  "[data-debug-id='shellx-browser-options-close']": "options",
};
const CONNECTION_DIALOG_SELECTOR = "[role='dialog'][aria-labelledby='conn-editor-title']";
const BUILTIN_DOC_BY_SELECTOR: Record<string, "Features" | "Quick start" | "Changelog" | "Third-party notices"> = {
  "[title='Read the shellX features overview']": "Features",
  "[title='Read the shellX quick-start guide']": "Quick start",
  "[title='Read bundled release notes']": "Changelog",
  "[title='Read bundled third-party notices']": "Third-party notices",
};
const ABOUT_EXTERNAL_URL_BY_SELECTOR: Record<string, string> = {
  "[data-debug-id='surface-components-settings-abouttab-4']": "https://theshellx.com",
  "[data-debug-id='surface-components-settings-abouttab-5']": "https://x.com/theshellx",
  "[data-debug-id='about-full-manual-link']": "https://docs.theshellx.com/manual/shellx/",
  "[data-debug-id='surface-components-settings-abouttab-9']": "https://github.com/martinsbrezauckis/shellx",
  "[data-debug-id='surface-components-settings-abouttab-10']": "https://github.com/martinsbrezauckis/shellx/issues",
};
const WORK_PREVIEW_KIND_BY_SELECTOR: Record<string, "auto" | "static" | "web" | "expo"> = {
  "[id='work-preview-kind-auto']": "auto",
  "[id='work-preview-kind-static']": "static",
  "[id='work-preview-kind-web']": "web",
  "[id='work-preview-kind-expo']": "expo",
};

function activeBrowserShields() {
  const site = browserActiveHost
    ? browserShields.siteOverrides.find((item) => item.host === browserActiveHost)
    : undefined;
  return {
    host: browserActiveHost,
    enabled: browserShields.enabled,
    effectiveAdTrackerMode: site?.adTrackerMode ?? browserShields.adTrackerMode,
    effectiveCookieMode: site?.cookieMode ?? browserShields.cookieMode,
    effectiveFingerprintingMode: site?.fingerprintingMode ?? browserShields.fingerprintingMode,
    httpsUpgradeEnabled: site?.httpsUpgradeEnabled ?? browserShields.httpsUpgradeEnabled,
    scriptBlockingEnabled: site?.scriptBlockingEnabled ?? browserShields.scriptBlockingEnabled,
    hasSiteOverride: Boolean(site),
    blockedAdTrackerCount: 0,
  };
}

function saveBrowserSiteOverride(patch: Partial<Omit<FixtureSiteShields, "host" | "updatedAtMs">>): void {
  if (!browserActiveHost) throw new Error("fixture Browser Shields host is missing");
  const active = activeBrowserShields();
  const updatedAtMs = browserShields.updatedAtMs + 1;
  const next: FixtureSiteShields = {
    host: browserActiveHost,
    adTrackerMode: patch.adTrackerMode ?? active.effectiveAdTrackerMode,
    cookieMode: patch.cookieMode ?? active.effectiveCookieMode,
    fingerprintingMode: patch.fingerprintingMode ?? active.effectiveFingerprintingMode,
    httpsUpgradeEnabled: patch.httpsUpgradeEnabled ?? active.httpsUpgradeEnabled,
    scriptBlockingEnabled: patch.scriptBlockingEnabled ?? active.scriptBlockingEnabled,
    updatedAtMs,
  };
  browserShields.siteOverrides = [
    ...browserShields.siteOverrides.filter((item) => item.host !== browserActiveHost),
    next,
  ];
  browserShields.updatedAtMs = updatedAtMs;
}

function sessionRailScrollWidth(): number {
  return Math.max(SESSION_RAIL_CLIENT_WIDTH, openSessionTabs.length * SESSION_TAB_WIDTH + SESSION_NEW_BUTTON_WIDTH);
}

function sessionRailMaxScrollLeft(): number {
  return Math.max(0, sessionRailScrollWidth() - SESSION_RAIL_CLIENT_WIDTH);
}

function clampSessionRailScroll(): void {
  sessionRailScrollLeft = Math.min(sessionRailMaxScrollLeft(), Math.max(0, sessionRailScrollLeft));
}

function ensureSessionTabVisible(tabId: string): void {
  const index = openSessionTabs.findIndex((tab) => tab.tabId === tabId);
  if (index < 0) return;
  const left = index * SESSION_TAB_WIDTH;
  const right = left + SESSION_TAB_WIDTH;
  if (left < sessionRailScrollLeft) sessionRailScrollLeft = left;
  else if (right > sessionRailScrollLeft + SESSION_RAIL_CLIENT_WIDTH) {
    sessionRailScrollLeft = right - SESSION_RAIL_CLIENT_WIDTH;
  }
  clampSessionRailScroll();
}

function sessionTabSelectorParts(selector: string): { tabId: string; descendant: string } | null {
  const match = selector.match(/^\[data-tab-id='([A-Za-z0-9._:-]+)'\](?: (.+))?$/);
  return match ? { tabId: match[1]!, descendant: match[2] ?? "" } : null;
}

function sessionDropdownRowParts(selector: string): { index: number; descendant: string } | null {
  const match = selector.match(/^\.stab-dropdown \[role='option'\]:nth-child\((\d+)\)(?: (.+))?$/);
  if (!match) return null;
  return { index: Number(match[1]) - 2, descendant: match[2] ?? "" };
}

function sessionTabAt(index: number): Record<string, unknown> | null {
  return index >= 0 && index < openSessionTabs.length ? openSessionTabs[index]! : null;
}

function commitSessionRename(): void {
  if (!sessionRenamingTabId) return;
  const tab = openSessionTabs.find((entry) => entry.tabId === sessionRenamingTabId);
  const title = sessionRenameValue.trim();
  if (tab && title) tab.title = title;
  sessionRenamingTabId = null;
  sessionRenameValue = "";
}

function closeOwnedSessionTab(tabId: string): boolean {
  const fixtureOwned = tabId.startsWith("fixture-owned-session-tab-")
    || tabId === findOwnedTabId
    || tabId === bottomPanelOwnedTabId;
  if (!fixtureOwned || !openSessionTabs.some((tab) => tab.tabId === tabId)) {
    return false;
  }
  const index = openSessionTabs.findIndex((tab) => tab.tabId === tabId);
  openSessionTabs = openSessionTabs.filter((tab) => tab.tabId !== tabId);
  if (activeTab.tabId === tabId) {
    const fallback = openSessionTabs[index] ?? openSessionTabs[index - 1] ?? null;
    if (fallback) activeTab = activeContextFromSessionTab(fallback, activeTab);
  }
  if (sessionRenamingTabId === tabId) {
    sessionRenamingTabId = null;
    sessionRenameValue = "";
  }
  if (tabId === bottomPanelOwnedTabId) {
    bottomPanelAttachmentPaths = [];
    bottomPanelImagePath = null;
    bottomPanelTerminalIds = [];
    bottomPanelActiveTerminal = null;
    bottomPanelFixtureUserVisible = false;
    alwaysVisibleTextValues["[data-debug-id='composer-prompt']"] = "";
  }
  clampSessionRailScroll();
  return true;
}

function filesPaneActive(): boolean {
  return rightTab === "Files" && filesPaneSessionPath !== null;
}

function filesPaneJoin(base: string, child: string): string {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${child}`;
}

function fixtureNormalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[A-Za-z]:[\\/]?$/.test(trimmed)) return `${trimmed.slice(0, 2)}\\`;
  if (trimmed === "/") return "/";
  return trimmed.replace(/[\\/]+$/, "");
}

function fixtureParentPath(value: string): string | null {
  const normalized = fixtureNormalizePath(value);
  if (!normalized || normalized === "/" || /^[A-Za-z]:\\$/.test(normalized)) return null;
  const separator = normalized.includes("\\") && !normalized.includes("/") ? "\\" : "/";
  const index = normalized.lastIndexOf(separator);
  if (index < 0) return null;
  if (index === 0) return "/";
  if (index === 2 && /^[A-Za-z]:/.test(normalized)) return `${normalized.slice(0, 2)}\\`;
  return normalized.slice(0, index);
}

function fixturePathBase(value: string): string {
  const normalized = fixtureNormalizePath(value);
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return normalized.slice(index + 1);
}

function fixtureJoinPath(base: string, child: string): string {
  const normalized = fixtureNormalizePath(base);
  const separator = normalized.includes("\\") && !normalized.includes("/") ? "\\" : "/";
  return normalized === "/" ? `/${child}` : `${normalized}${separator}${child}`;
}

function filesPaneSessionFilePath(): string | null {
  return filesPaneSessionPath ? filesPaneJoin(filesPaneSessionPath, "release-owned-file.txt") : null;
}

function filesPaneNestedFilePath(): string | null {
  return filesPaneSessionPath
    ? filesPaneJoin(filesPaneJoin(filesPaneSessionPath, "release-owned-directory"), "release-owned-nested.txt")
    : null;
}

function composerAttachmentTitle(selector: string): string | null {
  const match = selector.match(/^\.composer-attachment-chip\[title=("(?:[^"\\]|\\.)*")\]$/);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function consumeReleaseNativePicker(kind: "file" | "directory"): string {
  if (!releaseNativePickerLease || releaseNativePickerLease.kind !== kind) {
    throw new Error(`isolated native-picker fixture has no armed ${kind} result`);
  }
  const value = releaseNativePickerLease.path;
  releaseNativePickerLease = null;
  return value;
}

function tasksPanelSelectorParts(selector: string): { taskId: string; descendant: string } | null {
  const match = selector.match(/^\[data-task-id='([A-Za-z0-9._:-]+)'\](?: (.+))?$/);
  return match ? { taskId: match[1]!, descendant: match[2] ?? "" } : null;
}

function tasksPanelTaskVisible(task: FixtureBackgroundTask): boolean {
  if (rightTab !== "Tasks") return false;
  const showAllTabs = taskToggleStates["[data-debug-id='tasks-show-all-tabs-checkbox']"]!.checked;
  if (!showAllTabs && task.tabId !== activeTab.tabId) return false;
  const filter = (rightRailTextValues["[data-debug-id='tasks-filter-input']"] ?? "").trim().toLowerCase();
  const showCompleted = taskToggleStates["[data-debug-id='tasks-show-completed-checkbox']"]!.checked;
  const terminalStateFilter = filter.includes("stopped") || filter.includes("exited") || filter.includes("killed");
  if (!showCompleted && !terminalStateFilter && task.status !== "running") return false;
  if (!filter) return true;
  return `${task.commandDisplay} ${task.status} ${task.pid}`.toLowerCase().includes(filter);
}

function tasksPanelTask(taskId: string): FixtureBackgroundTask | null {
  return ownedBackgroundTasks.find((task) => task.taskId === taskId) ?? null;
}

function visibleHostMcpTasks(): FixtureBackgroundTask[] {
  return ownedBackgroundTasks.filter((task) => task.origin === "host_mcp"
    && task.tabId === activeTab.tabId
    && (task.status === "running" || task.status === "stopped"));
}

function handleReleaseTauriInvoke(command: string, args: Record<string, unknown>): unknown {
  if (command === "read_user_data") return structuredClone(ownedUserData);
  if (command === "write_user_data") {
    if (!args.data || typeof args.data !== "object" || Array.isArray(args.data)) {
      throw new Error("owned user-data fixture requires one object");
    }
    ownedUserData = structuredClone(args.data as Record<string, unknown>);
    return null;
  }
  if (command === "shellx_browser_state") {
    return { downloadFolder: browserDownloadFolder };
  }
  if (command === "shellx_browser_update_download_folder") {
    const request = args.request;
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("Browser download-folder invoke omitted its request");
    }
    const value = (request as Record<string, unknown>).downloadFolder;
    if (value !== null && (typeof value !== "string" || !value.trim())) {
      throw new Error("Browser download-folder invoke requires null or one exact path");
    }
    browserDownloadFolder = value as string | null;
    return browserDownloadFolder;
  }
  if (command === "shellx_browser_operator_evidence_summary") {
    const limit = typeof args.limit === "number" && Number.isSafeInteger(args.limit)
      ? Math.min(100, Math.max(1, args.limit))
      : 20;
    return {
      ok: true,
      callerScoped: false,
      durableRecovered: 0,
      durableScanTruncated: false,
      durableScanFailed: false,
      durableSkipped: 0,
      count: Math.min(limit, evidenceReceipts.length),
      recent: evidenceReceipts.slice(-limit).reverse(),
    };
  }
  if (command === "pty_create") {
    if (typeof args.tabId !== "string" || !args.tabId || !/^[A-Za-z0-9._:-]+$/.test(args.tabId)) {
      throw new Error("owned TasksPanel fixture requires one selector-safe tabId");
    }
    ownedTerminalSequence += 1;
    const terminalId = `fixture-owned-terminal-${ownedTerminalSequence}`;
    ownedBackgroundTasks.push({
      taskId: `${args.tabId}:${terminalId}`,
      origin: "user_term",
      commandDisplay: typeof args.shell === "string" ? args.shell : "fixture-shell",
      pid: 7_000 + ownedTerminalSequence,
      cpuPct: 0,
      rssMb: 1,
      status: "running",
      startedAtMs: 1_750_000_000_000 + ownedTerminalSequence,
      recentOutputTail: "owned TasksPanel release fixture output",
      tabId: args.tabId,
      terminalId,
    });
    return terminalId;
  }
  if (command === "list_background_tasks") {
    return ownedBackgroundTasks.map(({ terminalId: _terminalId, ...task }) => ({ ...task }));
  }
  if (command === "pty_write") {
    if (typeof args.tabId !== "string" || typeof args.terminalId !== "string" || !Array.isArray(args.data)) {
      throw new Error("owned TasksPanel PTY write omitted its identity or data");
    }
    const task = tasksPanelTask(`${args.tabId}:${args.terminalId}`);
    if (!task || args.data.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new Error("owned TasksPanel PTY write targeted an unknown task or invalid byte buffer");
    }
    task.recentOutputTail = Buffer.from(args.data as number[]).toString("utf8").trim();
    return null;
  }
  if (command === "task_pause" || command === "task_resume") {
    const task = typeof args.taskId === "string" ? tasksPanelTask(args.taskId) : null;
    if (!task) throw new Error(`unknown owned TasksPanel task ${String(args.taskId ?? "")}`);
    task.status = command === "task_pause" ? "stopped" : "running";
    return null;
  }
  if (command === "pty_kill") {
    if (typeof args.tabId !== "string" || typeof args.terminalId !== "string") {
      throw new Error("owned TasksPanel PTY cleanup omitted its identity");
    }
    const taskId = `${args.tabId}:${args.terminalId}`;
    ownedBackgroundTasks = ownedBackgroundTasks.filter((task) => task.taskId !== taskId);
    expandedBackgroundTaskIds.delete(taskId);
    return null;
  }
  throw new Error(`unsupported TasksPanel release Tauri invoke ${command}`);
}

function selectorDisplayed(selector: string): boolean {
  if (currentWindow === "main-window" && errorBoundaryOpen) {
    return selector === "[role='alert']"
      || selector === "[role='alert'] button:first-of-type"
      || selector === "[role='alert'] button:last-of-type";
  }
  if (currentWindow === "main-window" && lazySurfaceState === "error") {
    return selector === "[role='alert']"
      || selector === "[role='alert'] button:first-of-type"
      || selector === "[role='alert'] button:last-of-type";
  }
  if (currentWindow === "main-window" && selector === "[data-shellx-release-control='lazy-surface-recovered']") {
    return lazySurfaceState === "recovered";
  }
  if (currentWindow === "browser-window") {
    if (selector === "[data-debug-id='shellx-browser-address']") return true;
    if (selector === "[data-debug-id='shellx-browser-new-tab']") return true;
    if (selector === "[data-debug-id='shellx-browser-personal-lock-toggle']") return true;
    if (selector === "[data-debug-id='shellx-browser-personal-lock-now']") {
      return browserDisclosure === "options" && browserPersonalLock.enabled && !browserPersonalLock.locked;
    }
    if (selector === "[data-debug-id='shellx-browser-personal-unlock-now']") {
      return browserDisclosure === "options" && browserPersonalLock.enabled && browserPersonalLock.locked;
    }
    if (
      selector === "[data-debug-id='shellx-browser-personal-lock-notice']"
      || selector === "[data-debug-id='shellx-browser-personal-lock-notice-unlock']"
    ) return browserPersonalLockNotice;
    if (
      selector === "[data-debug-id='shellx-browser-personal-lock-overlay']"
      || selector === "[data-debug-id='shellx-browser-personal-lock-overlay-pin']"
      || selector === "[data-debug-id='shellx-browser-personal-lock-overlay-unlock']"
    ) return browserProfileId === "personal" && browserPersonalLock.enabled && browserPersonalLock.locked
      && (selector !== "[data-debug-id='shellx-browser-personal-lock-overlay-pin']"
        || (browserPersonalLock.authMode === "pinOnly" && browserPersonalLock.pinConfigured));
    if (selector === "[data-debug-id='shellx-browser-goal']") {
      return browserRightSidebarVisible && browserRightTab === "chat";
    }
    if (selector === "[data-debug-id='shellx-browser-agent-send']") {
      return browserRightSidebarVisible && browserRightTab === "chat"
        && providerActionFixture === "browser-send" && activeTaskStatus === "running"
        && browserGoalValue.trim().length > 0;
    }
    if (selector === "[data-debug-id='shellx-browser-chat-explain-page']") {
      return browserRightSidebarVisible && browserRightTab === "chat"
        && providerActionFixture === "browser-explain-page" && activeTaskStatus === "running"
        && Boolean(browserTaskUrl);
    }
    if (
      selector === "[data-debug-id='shellx-browser-agent-pause']"
      || selector === "[data-debug-id='shellx-browser-agent-resume']"
      || selector === "[data-debug-id='shellx-browser-agent-takeover']"
      || selector === "[data-debug-id='shellx-browser-agent-abort']"
    ) return browserRightSidebarVisible && browserRightTab === "chat";
    if (
      selector === "[data-debug-id='shellx-browser-complete']"
      || selector === "[data-debug-id='shellx-browser-block']"
    ) return browserRightSidebarVisible && browserRightTab === "actions";
    if (selector === "[data-debug-id='shellx-browser-download-folder']") {
      return browserDisclosure === "downloads";
    }
    if (selector === "[data-debug-id='shellx-browser-download-folder-choose']") {
      return browserDisclosure === "downloads";
    }
    if (selector === "[data-debug-id='shellx-browser-downloads-badge']") {
      return browserDownloads.length > 0;
    }
    if (/^\[data-debug-id='shellx-browser-save-(?:fullpage-screenshot|screenshot|markdown|links|snapshot|media|code|site)'\]$/.test(selector)) {
      return browserDisclosure === "save" && Boolean(browserTaskId && browserTaskTabId && browserTaskUrl);
    }
    if (selector === "[data-debug-id='shellx-browser-toggle-right-sidebar']") {
      return browserDisclosure === "options";
    }
    if (selector === "[data-debug-id='shellx-browser-show-right-sidebar-button']") {
      return !browserRightSidebarVisible;
    }
    if (selector === "[data-debug-id='shellx-browser-toggle-right-sidebar-button']") {
      return browserRightSidebarVisible;
    }
    if (selector === "[data-debug-id='shellx-browser-sidebar-resize']") {
      return browserRightSidebarVisible;
    }
    if (selector === "[data-debug-id='shellx-browser-homepage']") {
      return browserDisclosure === "options";
    }
    if (selector === "[data-debug-id='shellx-browser-color-mode']") {
      return browserDisclosure === "options";
    }
    if (selector === "[data-debug-id='shellx-browser-parallel-agents']") {
      return browserDisclosure === "options";
    }
    if (selector === "[data-debug-id='shellx-browser-profile-select']") {
      return browserDisclosure === "options";
    }
    if (
      selector === "[data-debug-id='shellx-browser-personal-lock-timeout']"
      || selector === "[data-debug-id='shellx-browser-personal-lock-auth-mode']"
      || selector === "[data-debug-id='shellx-browser-personal-lock-enabled']"
      || selector === "[data-debug-id='shellx-browser-personal-lock-blur']"
      || selector === "[data-debug-id='shellx-browser-personal-lock-pause-delegated']"
      || selector === "[data-debug-id='shellx-browser-personal-lock-sleep']"
      || selector === "[data-debug-id='shellx-browser-personal-lock-minimize']"
    ) return browserDisclosure === "options";
    if (selector === "[data-debug-id='shellx-browser-personal-enable-now']") {
      return browserDisclosure === "options" && !browserPersonalLock.enabled;
    }
    if (selector === "[data-debug-id='shellx-browser-personal-lock-pin']") {
      return browserDisclosure === "options" && browserPersonalLock.authMode === "pinOnly";
    }
    if (selector === "[data-debug-id='shellx-browser-personal-lock-set-pin']") {
      return browserDisclosure === "options" && browserPersonalLock.authMode === "pinOnly";
    }
    if (
      selector === "[data-debug-id='shellx-browser-shields-global-enabled']"
      || selector === "[data-debug-id='shellx-browser-site-shields-ad-trackers']"
      || selector === "[data-debug-id='surface-browser-components-browsershieldspanel-3']"
      || selector === "[data-debug-id='surface-browser-components-browsershieldspanel-4']"
      || selector === "[data-debug-id='surface-browser-components-browsershieldspanel-5']"
      || selector === "[data-debug-id='shellx-browser-site-shields-script-blocking']"
      || selector === "[data-debug-id='shellx-browser-site-shields-save']"
      || selector === "[data-debug-id='shellx-browser-site-shields-reset']"
    ) return browserDisclosure === "trust";
    if (
      selector === "[data-debug-id='shellx-browser-ad-mode-default']"
      || selector === "[data-debug-id='shellx-browser-ad-mode-balanced']"
      || selector === "[data-debug-id='shellx-browser-ad-mode-strict']"
      || selector === "[data-debug-id='shellx-browser-ad-mode-off']"
    ) return browserDisclosure === "ads";
    if (
      selector === "[data-debug-id='shellx-browser-history-search']"
      || selector === "[data-debug-id='shellx-browser-history-date-filter']"
      || selector === "[data-debug-id='shellx-browser-history-user']"
      || selector === "[data-debug-id='shellx-browser-history-agent']"
    ) return browserDisclosure === "history";
    if (
      selector === "[data-debug-id='shellx-browser-bookmark-list-mode']"
      || selector === "[data-debug-id='shellx-browser-bookmark-manager-toggle']"
    ) return browserDisclosure === "bookmarks";
    if (
      selector === "[data-debug-id='shellx-browser-bookmark-draft-label']"
      || selector === "[data-debug-id='shellx-browser-bookmark-draft-url']"
    ) return browserDisclosure === "bookmarks" && browserBookmarkManageMode;
    const expandedMatch = selector.match(/^(.+)\[aria-expanded='true'\]$/);
    const disclosureBase = expandedMatch?.[1] ?? selector;
    const disclosure = BROWSER_DISCLOSURE_BY_SELECTOR[disclosureBase];
    if (disclosure) {
      return (!disclosure.rightPanel || browserRightTab === disclosure.rightPanel)
        && (!expandedMatch || browserDisclosure === disclosure.id);
    }
    const disclosurePanel = Object.values(BROWSER_DISCLOSURE_BY_SELECTOR).find((value) => value.panel === selector);
    if (disclosurePanel) {
      return (!disclosurePanel.rightPanel || browserRightTab === disclosurePanel.rightPanel)
        && browserDisclosure === disclosurePanel.id;
    }
    const disclosureClose = BROWSER_DISCLOSURE_CLOSE_BY_SELECTOR[selector];
    if (disclosureClose) return browserDisclosure === disclosureClose;
    const selectedMatch = selector.match(/^(.+)\.active\[aria-selected='true'\]$/);
    const browserTabBase = selectedMatch?.[1] ?? selector;
    const browserTab = BROWSER_RIGHT_TAB_BY_SELECTOR[browserTabBase];
    if (browserTab) return !selectedMatch || browserTab === browserRightTab;
    const panelMatch = selector.match(/^#shellx-browser-panel-([^[]+)\[aria-labelledby='shellx-browser-right-tab-([^']+)'\]$/);
    if (panelMatch) return panelMatch[1] === browserRightTab && panelMatch[2] === browserRightTab;
    if (selector === "[data-debug-id='shellx-browser-evidence-record']") {
      return browserRightTab === "evidence" && activeTaskStatus === "running";
    }
    if (selector === "[data-debug-id='shellx-browser-evidence-refresh']") {
      return browserRightTab === "evidence" && activeTaskStatus === "running";
    }
    if (selector === ".shellx-browser-evidence-recorded[role='status']") {
      return browserRightTab === "evidence" && recorderStatusVisible;
    }
    return false;
  }
  if (selector === "[data-debug-id='header-shellx-browser']") return true;
  if (selector === "[data-debug-id='composer-attach']"
    || selector === "[data-debug-id='composer-folder']") return true;
  if (selector === "[data-palette-action-id='act-attach']") return commandPaletteOpen;
  if (selector === "[role='dialog'][aria-label='Attachment and media board'] [title='Attach file']") {
    return ownedModalOpen === "assets";
  }
  if (
    selector === "[data-debug-id='agent-cli-setup-dialog']"
    || selector === "[data-debug-id='agent-cli-setup-assistant']"
    || selector === "[data-debug-id='surface-components-agentclisetupassistant-11']"
    || selector === "[data-debug-id='surface-components-agentclisetupassistant-5']"
    || selector === "[data-debug-id='agent-cli-setup-assistant'] .agent-cli-setup-header-actions button:last-child"
  ) return (
    agentCliSetupFixtureMode === "cards"
    || agentCliSetupFixtureMode === "confirmation"
    || agentCliSetupFixtureMode === "live-setup"
    || agentCliSetupFixtureMode === "install-lifecycle"
    || agentCliStatusDialogProvider !== null
  );
  if (selector === "[data-debug-id='agent-cli-setup-assistant'] .agent-cli-setup-header-actions button:first-child") {
    return agentCliSetupFixtureMode === "live-setup";
  }
  if (selector === ".agent-cli-setup-card[data-agent-cli-provider='grok'] .agent-cli-setup-card-actions button:first-child") {
    return agentCliSetupFixtureMode === "cards";
  }
  if (selector === ".agent-cli-setup-confirm-links button:first-child") {
    return agentCliSetupFixtureMode === "confirmation";
  }
  if (
    selector === "[data-debug-id='agent-cli-setup-confirm']"
    || selector === ".agent-cli-setup-confirm-actions button:first-child"
    || selector === "[data-debug-id='surface-components-agentclisetupassistant-9']"
  ) return agentCliSetupFixtureMode === "confirmation"
    || (agentCliSetupFixtureMode === "install-lifecycle" && agentCliInstallConfirmationId !== null);
  const agentCliProviderCardMatch = selector.match(/^\.agent-cli-setup-card\[data-agent-cli-provider='([^']+)'\]$/);
  if (agentCliProviderCardMatch) {
    const providerId = agentCliProviderCardMatch[1]!;
    return agentCliSetupFixtureMode === "cards"
      || agentCliSetupFixtureMode === "confirmation"
      || (agentCliSetupFixtureMode === "live-setup" && providerId === "grok")
      || (agentCliSetupFixtureMode === "install-lifecycle" && providerId === "codex-cli")
      || agentCliStatusDialogProvider === "all"
      || agentCliStatusDialogProvider === providerId;
  }
  if (selector === ".provider-runner-actions button:last-child") {
    return rightTab === "Tooling" && agentCliSetupFixtureMode === "live-status";
  }
  if (selector === ".provider-adapter-row[data-agent-cli-provider='grok']") {
    return rightTab === "Tooling" && agentCliSetupFixtureMode === "live-status";
  }
  if (/^\[data-debug-id='agent-cli-setup-open-(grok|claude-code|codex-cli|antigravity-cli)'\]$/.test(selector)) {
    return rightTab === "Tooling"
      && agentCliSetupFixtureMode === "status-card"
      && agentCliStatusDialogProvider === null;
  }
  if (selector === "[data-debug-id='agent-cli-setup-open-missing']") {
    return rightTab === "Tooling"
      && agentCliSetupFixtureMode === "status-card"
      && agentCliStatusDialogProvider === null;
  }
  if (selector === "[aria-label='About shellX — version and source']") return true;
  if (selector === "[aria-label='Open plugins']") return true;
  if (selector === "[aria-label='Open settings']") return true;
  if (selector === "[data-debug-id='header-theme-toggle']") return true;
  if (selector === "[role='dialog'][aria-label^='Review plan:']") {
    return goalReviewModalOpen || goalPlanReviewFixtureMode !== "closed";
  }
  if (selector === "[aria-label='Review later']") {
    return goalReviewModalOpen || goalPlanReviewFixtureMode !== "closed";
  }
  if (selector === ".plan-review-actions > button:first-child") {
    return goalReviewModalOpen || goalPlanReviewFixtureMode !== "closed";
  }
  if (selector === ".plan-review-actions > button:nth-of-type(3)") {
    return goalReviewModalOpen || goalPlanReviewFixtureMode !== "closed";
  }
  if (
    selector === ".plan-edit-actions > button:last-child"
    || selector === "[placeholder='What should Grok change about this plan? (Ctrl+Enter to submit)']"
  ) return (goalReviewModalOpen || goalPlanReviewFixtureMode !== "closed") && goalPlanReviewEditing;
  if (selector === "[data-debug-id='surface-components-goalplanreviewmodal-4']") {
    return goalReviewModalOpen && goalPlanReviewEditing;
  }
  if (selector === "[data-debug-id='surface-components-goalplanreviewmodal-7']"
    || selector === "[data-debug-id='surface-components-goalplanreviewmodal-9']") {
    return goalReviewModalOpen;
  }
  if ((buildPlanFixtureActive && buildPlanReviewOpen) || buildRunState?.status === "awaitingApproval") {
    if (selector === "[role='dialog'][aria-label^='Review build plan:']"
      || selector === "[role='dialog'][aria-label^='Review build plan:'] [aria-label='Review later']"
      || selector === "[role='dialog'][aria-label^='Review build plan:'] .plan-review-actions > button:first-child"
      || selector === "[data-debug-id='surface-components-buildplanreviewmodal-1']"
      || selector === "[data-debug-id='surface-components-buildplanreviewmodal-4']"
      || selector === "[data-debug-id='surface-components-buildplanreviewmodal-5']") return true;
  }
  if (selector === "[title='Open the focused plan review dialog.']") {
    return rightTab === "Plan"
      && goalState?.active === true
      && goalState.awaitingApproval === true
      && !goalReviewModalOpen;
  }
  if (selector === "[title='Pause auto-continuation (only user can pause)']") {
    return rightTab === "Plan"
      && goalState?.active === true
      && goalState.awaitingApproval === false
      && goalState.pausedByUser === false;
  }
  if (selector === "[title='Resume auto-continuation']") {
    return rightTab === "Plan"
      && goalState?.active === true
      && goalState.awaitingApproval === false
      && goalState.pausedByUser === true;
  }
  if (selector === "[title='Mark build as complete — stops the auto-continuation loop. Use when the agent finished but did not call the completion tool itself.']") {
    return rightTab === "Plan"
      && goalState?.active === true
      && goalState.awaitingApproval === false;
  }
  if (selector === ":is([title='Show every receipt in this Build Mode run'],[title='Show latest receipts only'])") {
    return rightTab === "Plan" && buildRunCockpitFixtureActive;
  }
  if (selector === "[data-shellx-release-control='build-receipt-ledger-state']") {
    return rightTab === "Plan" && buildRunCockpitFixtureActive;
  }
  if (selector === "[data-shellx-release-control='build-run-state-receipt']") {
    return rightTab === "Plan" && buildRunState !== null;
  }
  if (selector === "[title='Approve the Build Mode scratchboard and start execution.']"
    || selector === "[title='Reject this Build Mode plan and halt the run.']") {
    return rightTab === "Plan" && buildRunState?.status === "awaitingApproval";
  }
  if (selector === "[title='Pause Build Mode auto-continuation.']") {
    return rightTab === "Plan" && buildRunState?.status === "active";
  }
  if (selector === "[title='Resume Build Mode auto-continuation.']") {
    return rightTab === "Plan" && buildRunState?.status === "paused";
  }
  if (selector === "[title='Recheck blocker evidence without restarting or prompting the Agent.']") {
    return rightTab === "Plan" && buildRunState?.status === "blocked";
  }
  if (selector === "[title='Create a local shellX git checkpoint and attach it to this Build Mode run.']") {
    return rightTab === "Plan" && (buildRunState?.status === "active" || buildRunState?.status === "paused");
  }
  if (selector === "[title='Stop Build Mode manually without accepting completion.']") {
    return rightTab === "Plan" && buildRunState !== null
      && buildRunState.status !== "complete" && buildRunState.status !== "halted";
  }
  if (/^\[data-debug-id='surface-components-rightrail-2'\]\[data-shellx-tool-exposure='(nativeFirst|hostBridge|hostFull|off)'\]$/.test(selector)) {
    return rightTab === "Tooling";
  }
  if (selector === "[data-debug-id='surface-components-gitpane-1']") {
    return rightTab === "Git" && (rightRailGitLifecycleActive || rightRailGitWriteFixtureActive());
  }
  if (selector === "[data-shellx-release-control='git-review-diff']") {
    return rightTab === "Git" && rightRailGitLifecycleActive;
  }
  if (/^\[data-debug-id='surface-components-gitpane-5'\]\[data-git-diff-scope='(head|working|staged|lastCommit)'\]$/.test(selector)) {
    return rightTab === "Git" && rightRailGitLifecycleActive;
  }
  if (selector === ".git-actions > button:nth-child(2)" || selector === ".git-actions > button:nth-child(3)") {
    return rightTab === "Git" && rightRailGitWriteFixtureActive();
  }
  if (selector === ".git-diff-box") {
    return rightTab === "Git" && rightRailGitLifecycleActive && rightRailGitDiffVisible;
  }
  if (selector === "[data-shellx-release-control='model-cards-refresh']") {
    return rightTab === "Tooling" && rightRailGitLifecycleActive;
  }
  if (selector === "[data-debug-id='surface-components-rightrail-9']"
    || selector === "[data-release-environment-control='trace']") {
    return rightTab === "Tooling" && rightRailGitLifecycleActive;
  }
  const permissionPending = permissionFixtureAction !== null && permissionDecision === null;
  if (selector === "[data-debug-id='surface-components-permissionmodal-1']"
    || selector === "[data-debug-id='surface-components-permissionmodal-2']") {
    return permissionPending && permissionFixtureAction?.startsWith("modal-") === true;
  }
  if (selector === "[data-shellx-release-control='permission-modal-allow']"
    || selector === "[data-shellx-release-control='permission-modal-deny']") {
    return permissionPending && permissionFixtureAction?.startsWith("modal-") === true;
  }
  if (selector === "[data-debug-id='surface-components-permissionpill-1']"
    || selector === "[data-debug-id='surface-components-permissionpill-3']"
    || selector === "[data-shellx-release-control='permission-pill-always']") {
    return permissionPending && permissionFixtureAction?.startsWith("pill-") === true && bottomTab === "Chat";
  }
  if (selector === "[data-shellx-release-control='permission-decision-receipt']") {
    return permissionFixtureAction !== null && permissionDecision !== null;
  }
  if (selector === "[data-shellx-release-control='provider-action-receipt']") {
    return providerActionFixture !== null && providerActionDigest !== null;
  }
  if (selector === "[data-debug-id='composer-send']") {
    return providerActionFixture === "composer-send"
      && (alwaysVisibleTextValues["[data-debug-id='composer-prompt']"] ?? "").trim().length > 0;
  }
  if (selector === "[role='dialog'][aria-label='Activity Browser'] button.pact") {
    return activityOpen && providerActionFixture === "activity-ask-agent";
  }
  if (selector === "[title='Ask the active agent to inspect the visible background tasks']") {
    return rightTab === "Tasks" && providerActionFixture === "tasks-visible-ask" && ownedBackgroundTasks.length > 0;
  }
  if (selector === "[title='Ask the active agent to inspect this background task and its latest output']") {
    return providerActionFixture === "tasks-row-ask" && [...expandedBackgroundTaskIds].some((taskId) => tasksPanelTask(taskId));
  }
  if (selector.endsWith(" [title='Ask the active agent to inspect this background task and its latest output']")) {
    const row = tasksPanelSelectorParts(selector);
    return providerActionFixture === "tasks-row-ask" && Boolean(row && expandedBackgroundTaskIds.has(row.taskId));
  }
  if (selector === "[id='work-preview-ask-fix']") {
    return rightTab === "Preview" && ownedModalOpen !== "preview" && providerActionFixture === "work-preview-ask-fix" && previewState?.status === "running";
  }
  if (selector === "[data-palette-action-id='act-preview-doctor']") {
    return commandPaletteOpen && providerActionFixture === "work-preview-palette-ask-fix"
      && previewState?.status === "running";
  }
  if (selector === "[id='work-preview-stage-ask-fix']") {
    return ownedModalOpen === "preview" && providerActionFixture === "work-preview-stage-ask-fix" && previewState?.status === "running";
  }
  if (selector === "[data-debug-id='surface-components-workpreviewpanel-16']") {
    return ownedModalOpen === "preview" && providerActionFixture === "work-preview-browser-issue-fix" && previewState?.status === "running";
  }
  if (selector === "[data-debug-id='surface-components-rightrail-11']") {
    return rightTab === "Tooling" && providerActionFixture === "right-rail-connector-action";
  }
  if (selector === "[title='Ask the active agent to inspect this diagnostic snapshot']") {
    return rightTab === "Tooling" && providerActionFixture === "right-rail-environment-ask";
  }
  const leftRailDisplayed = leftRailLifecycleSelectorDisplayed(selector);
  if (leftRailDisplayed !== null) return leftRailDisplayed;
  if (selector === "[data-debug-id='left-add-project']" || selector === "[data-debug-id='left-rail']") return true;
  if (selector === "[data-debug-id='left-project-row']") return ownedProjectDraft;
  if (selector === "[data-debug-id='left-project-rename-input']") return ownedProjectDraft && ownedProjectRenaming;
  if (selector === "[data-debug-id='surface-components-leftrail-3']" || selector === ".proj-row-main" || selector === "[aria-label='Delete project']") {
    return ownedProjectDraft && !ownedProjectRenaming;
  }
  if (selector === "[role='alertdialog'][aria-labelledby='proj-del-title']" || selector === ".proj-delete-actions > button:first-child") {
    return ownedProjectDraft && ownedProjectDeleteDialog;
  }
  if (selector === "[data-debug-id='activity-browser-backdrop']" || selector === "[aria-label='Activity Browser']" || selector === ".activity-modal") return activityOpen;
  if (selector === "[data-debug-id='attachment-media-board-backdrop']" || selector === "[aria-label='Attachment and media board']" || selector === ".asset-board-modal") {
    return ownedModalOpen === "assets";
  }
  if (ownedModalOpen === "assets") {
    if (selector === "[data-debug-id='surface-components-attachmentmediaboard-9']") {
      return attachmentMediaPendingPaths.length > 0;
    }
    if (selector === "[data-debug-id='surface-components-attachmentmediaboard-12']") {
      return attachmentMediaSessionPath !== null;
    }
    if (selector === "[data-debug-id='surface-components-attachmentmediaboard-14']") {
      return attachmentMediaImagePath !== null || attachmentMediaVideoPath !== null;
    }
    if (selector === "[data-debug-id='surface-components-attachmentmediaboard-18']") {
      return attachmentMediaImagePath !== null;
    }
    if (selector === "[data-debug-id='surface-components-attachmentmediaboard-19']") {
      return attachmentMediaVideoPath !== null;
    }
    if (selector === "[role='dialog'][aria-label='Attachment and media board'] .asset-board-section:nth-of-type(1) [title='Preview file']"
      || selector === "[role='dialog'][aria-label='Attachment and media board'] .asset-board-section:nth-of-type(1) [title='Remove attachment']"
      || selector === "[role='dialog'][aria-label='Attachment and media board'] [title='Remove attachment']") {
      return attachmentMediaPendingPaths.length > 0;
    }
    if (selector === "[role='dialog'][aria-label='Attachment and media board'] .asset-board-section:nth-of-type(2) [title='Preview file']") {
      return attachmentMediaSessionPath !== null;
    }
    if (selector === "[role='dialog'][aria-label='Attachment and media board'] .asset-board-section:nth-of-type(1) .asset-board-actions > button:nth-child(3)"
      || selector === "[role='dialog'][aria-label='Attachment and media board'] .asset-board-section:nth-of-type(1) .asset-board-actions > button:nth-child(4)"
      || selector === "[role='dialog'][aria-label='Attachment and media board'] .asset-board-section:nth-of-type(1) .asset-board-actions > button:nth-child(5)") {
      return attachmentMediaPendingPaths.length > 0;
    }
    if (selector === "[aria-label='Preview release-owned-image.png']"
      || selector === "[aria-label='Attach release-owned-image.png']"
      || selector === "[aria-label='Import release-owned-image.png']") {
      return attachmentMediaImagePath !== null;
    }
  }
  if (selector === "[data-debug-id='surface-components-commandpalette-1']") return commandPaletteOpen;
  if (selector === "[data-debug-id='surface-components-connectioneditor-1']") return connectionEditorOpen;
  if (selector === "[data-debug-id='connector-inbox-backdrop']" || selector === "[aria-label='Connector inbox']" || selector === ".connector-inbox-modal") {
    return ownedModalOpen === "connectorInbox";
  }
  if (selector === "[data-debug-id='surface-components-connectorinboxmodal-4']"
    || selector === "[data-debug-id='surface-components-connectorinboxmodal-2']") {
    return ownedModalOpen === "connectorInbox";
  }
  if (selector === "[data-debug-id='surface-components-helpmodal-1']"
    || selector === "[role='dialog'][aria-label='Keyboard shortcuts']") return helpModalOpen;
  if (selector === "[data-debug-id='surface-components-pluginsmodal-1']") return pluginsOpen;
  if (pluginsOpen && pluginsProductionLifecycle && pluginsProductionFixtureActive) {
    const context = pluginsMarketplaceEntry("context7");
    const github = pluginsMarketplaceEntry("github");
    if (selector === ".mp-hero button.mp-action-btn-primary") return !context.installed;
    if (selector === "[data-marketplace-entry-id='context7'] [data-debug-id='surface-components-pluginsmodal-11']") return !context.installed;
    if (selector === "[data-marketplace-entry-id='context7'] [data-debug-id='plugins-entry-toggle']") return context.installed;
    if (selector === "[data-marketplace-entry-id='context7'] .mp-row-actions > button.mp-action-btn-secondary") return context.installed;
    if (selector === "[data-marketplace-entry-id='github'] [data-debug-id='surface-components-pluginsmodal-10']") {
      return !github.installed && !pluginsVaultKeys.has("github/pat");
    }
    if (selector === "[data-marketplace-entry-id='github'] [data-debug-id='plugins-entry-toggle']") {
      return github.installed;
    }
    if (selector === "[data-marketplace-entry-id='github'] [title='Enter your API key inline']") {
      return !pluginsVaultKeys.has("github/pat");
    }
    if (selector === "[data-marketplace-entry-id='github'] [data-debug-id='plugins-vault-key-input']"
      || selector === "[data-marketplace-entry-id='github'] [data-debug-id='surface-components-pluginsmodal-13']") {
      return pluginsKeyFormEntryId === "github";
    }
    if (selector === "[data-marketplace-entry-id='github'] [data-debug-id='surface-components-pluginsmodal-11']") {
      return !github.installed && pluginsVaultKeys.has("github/pat");
    }
  }
  if (pluginsOpen && pluginsFixtureActive) {
    if (selector === "[role='dialog'][aria-label='Plugins']") return true;
    if (selector === "[data-marketplace-entry-id='release-owned-installed-key'] :is([title='Cancel adding key (clears input)'],[title='Enter your API key inline'])"
      || selector === "[data-marketplace-entry-id='release-owned-uninstalled-key'] :is([title='Cancel adding key (clears input)'],[title='Enter your API key inline'])") {
      return true;
    }
    if (selector === "[data-debug-id='plugins-vault-key-input']") {
      return pluginsKeyFormEntryId !== null;
    }
    if (selector === "#mcp-key-form-release-owned-installed-key") {
      return pluginsKeyFormEntryId === "release-owned-installed-key";
    }
    if (selector === "#mcp-key-form-release-owned-uninstalled-key") {
      return pluginsKeyFormEntryId === "release-owned-uninstalled-key";
    }
  }
  if (selector === "[data-debug-id='surface-components-prcreatemodal-1']") return ownedModalOpen === "pr";
  if (selector === "[data-debug-id='preview-center-backdrop']" || selector === "[aria-label='Preview Center']" || selector === ".preview-center-modal") {
    return ownedModalOpen === "preview";
  }
  if (selector === "[data-debug-id='surface-components-mediapreview-1']") {
    return ownedModalOpen === "preview"
      && typeof previewTarget?.path === "string"
      && previewTarget.path.endsWith("release-owned-video.mp4");
  }
  if (selector === "[data-debug-id='surface-components-settings-1']") return settingsOpen;
  if (remoteCwdOpen) {
    if (selector === "[role='dialog'][aria-label='Remote folder picker']"
      || selector === "[data-debug-id='remote-cwd-input']"
      || selector === "[data-debug-id='remote-cwd-close']"
      || selector === "[data-debug-id='remote-cwd-go']"
      || selector === "[data-debug-id='remote-cwd-use']"
      || selector === "[data-debug-id='remote-cwd-up']") return true;
    if (selector === "[data-debug-id='remote-cwd-parent']") {
      return fixtureParentPath(remoteCwdPath) !== null;
    }
    if (selector === "[data-debug-id='remote-cwd-folder']") {
      return fixturePathBase(remoteCwdPath) === "listing";
    }
  }
  if (
    selector === "[data-debug-id='surface-components-settings-shellxagenttab-1']"
    || selector === "[data-debug-id='surface-components-settings-shellxagenttab-2']"
    || selector === "[data-debug-id='surface-components-settings-shellxagenttab-3']"
  ) return settingsOpen && (shellxagentFixtureActive || settingsTab === "shellxagent");
  if (selector === "[data-debug-id='surface-components-vaultpanel-1']") return vaultWorkspaceModalOpen;
  if (selector === "[data-debug-id='surface-components-builtindocmodal-4']") return builtinDoc === "Features";
  const ownedModalControl = OWNED_MODAL_BY_SELECTOR[selector];
  if (ownedModalControl) {
    if (selector.endsWith("[title='Close (Esc)']")) {
      return ownedModalOpen === "preview" && typeof previewTarget?.path === "string";
    }
    return ownedModalOpen === ownedModalControl.id;
  }
  const ownedModalDialog = Object.values(OWNED_MODAL_BY_SELECTOR).find((value) => value.dialog === selector);
  if (ownedModalDialog) {
    return ownedModalOpen === ownedModalDialog.id
      || (ownedModalDialog.id === "vault" && vaultWorkspaceModalOpen);
  }
  if (selector === "[data-debug-id='connector-inbox-search-input']") {
    return ownedModalOpen === "connectorInbox";
  }
  if (selector === "[data-debug-id='connector-inbox-date-input']") {
    return ownedModalOpen === "connectorInbox";
  }
  const connectorInboxTab = selector.match(/^\[data-debug-id='surface-components-connectorinboxmodal-9'\]\[data-inbox='(all|telegram|discord)'\](?:\[aria-selected='true'\])?$/);
  if (connectorInboxTab) {
    const requiresSelected = selector.endsWith("[aria-selected='true']");
    return ownedModalOpen === "connectorInbox"
      && (!requiresSelected || connectorFilter === connectorInboxTab[1]);
  }
  if (selector === ".connector-inbox-filters > button.settings-pill") {
    return ownedModalOpen === "connectorInbox"
      && (connectorFilter !== "all" || connectorSearchValue.length > 0 || connectorDateValue.length > 0);
  }
  if (selector === ".connector-inbox-foot > button.settings-pill") return ownedModalOpen === "connectorInbox";
  if (selector === "[role='dialog'][aria-label='Create pull request']") return ownedModalOpen === "pr";
  if (Object.hasOwn(prTextValues, selector)) return ownedModalOpen === "pr";
  if (selector === "[data-debug-id='surface-components-prcreatemodal-8']") return ownedModalOpen === "pr";
  if (selector === "[data-debug-id='surface-components-prcreatemodal-10']") return ownedModalOpen === "pr";
  if (selector === "[data-release-pr-create-receipt='boundary']") {
    return ownedModalOpen === "pr" && prCreateBoundaryReceipt !== null;
  }
  if (selector === "[aria-label='Download Grok session artifacts']") {
    return releaseTestExternalEffectBoundary === "artifact-archive";
  }
  if (selector === ".pr-modal .settings-pills > button:first-child") return ownedModalOpen === "pr";
  if (selector === ":is([title='Append the session transcript as an appendix'],[title='No transcript captured yet'])") {
    return ownedModalOpen === "pr";
  }
  if (selector === ".pr-modal .hardcap-buttons > button:first-child") return ownedModalOpen === "pr";
  if (selector === "[data-debug-id='surface-components-hashautocomplete-1']") {
    return hashItemsFixtureActive
      && (alwaysVisibleTextValues["[data-debug-id='composer-prompt']"] ?? "").startsWith("#");
  }
  if (selector === "[data-debug-id='debug-api-disconnected']"
    || selector === "[data-debug-id='debug-api-retry']") {
    return debugUiConnectionFixture === "disconnected";
  }
  if (selector === "[data-debug-id='composer-voice-chat']") return true;
  if (selector === "[aria-label='Turn voice chat off and cancel active listening']") {
    return releaseTestVoiceMode;
  }
  if (selector === "[data-debug-id='surface-lib-markdown-links-1']") {
    return bottomTab === "Chat" && attachmentMediaImagePath !== null;
  }
  if (selector === "[data-debug-id='surface-lib-markdown-links-2']") {
    return bottomTab === "Chat" && attachmentMediaImagePath !== null;
  }
  if (selector === "div[role='status'] > button:first-of-type") {
    return updateBannerAvailable;
  }
  if (selector === ".update-diagnostic .tooling-actions > button:first-child") {
    return rightRailUpdateAvailable && rightTab === "Tooling";
  }
  if (selector === "[data-release-update-control='banner-install']") return updateBannerAvailable;
  if (selector === "[data-release-update-control='right-rail-check']") return rightTab === "Tooling";
  if (selector === "[data-release-update-control='right-rail-install']") return rightTab === "Tooling" && rightRailUpdateAvailable;
  if (selector === "[data-release-update-control='about-check']") return settingsOpen && settingsTab === "about";
  if (selector === "[data-release-update-control='about-install']") return settingsOpen && settingsTab === "about" && aboutUpdateAvailable;
  if (selector === "[data-release-update-receipt='banner']") return updateBannerAvailable || updateBannerReceipt !== null;
  if (selector === "[data-release-update-receipt='right-rail']") return rightTab === "Tooling";
  if (selector === "[data-release-update-receipt='about']") return settingsOpen && settingsTab === "about";
  if (selector === "[data-debug-id='tasks-filter-input']") return rightTab === "Tasks";
  if (selector === "[data-debug-id='surface-components-taskspanel-3']") return rightTab === "Tasks";
  if (selector === "[aria-label='Clean Host MCP children for this tab']") {
    return rightTab === "Tasks" && visibleHostMcpTasks().length > 0;
  }
  if (selector === "[data-debug-id='tasks-agent-runs-refresh']") return rightTab === "Tasks";
  const tasksPanelParts = tasksPanelSelectorParts(selector);
  if (tasksPanelParts) {
    const task = tasksPanelTask(tasksPanelParts.taskId);
    if (!task || !tasksPanelTaskVisible(task)) return false;
    if (!tasksPanelParts.descendant) return true;
    if (tasksPanelParts.descendant === "[data-debug-id='surface-components-taskspanel-8']") return true;
    if (tasksPanelParts.descendant === "[title='Pause (SIGSTOP on Unix, NtSuspendProcess on Windows)']") {
      return task.status === "running";
    }
    if (tasksPanelParts.descendant === "[title='Resume (SIGCONT on Unix, NtResumeProcess on Windows)']") {
      return task.status === "stopped";
    }
    if (tasksPanelParts.descendant === ":is([title='Kill (SIGTERM then SIGKILL after 3s)'],[title='Kill terminal and remove its task row'])") {
      return task.status === "running" || task.status === "stopped";
    }
    return false;
  }
  if (selector === ".output") return bottomTab === "Chat" && chatOutputLifecycleActive;
  if (selector === "[data-debug-id='surface-components-chatoutput-1']") {
    return bottomTab === "Chat" && chatOutputLifecycleActive && chatOutputJumpVisible;
  }
  if (selector === "[data-debug-id='surface-components-chatoutput-3']") {
    return bottomTab === "Chat" && chatOutputLifecycleActive && chatOutputAttachmentPath !== null;
  }
  if (selector === "[data-debug-id='surface-components-chatoutput-4']") {
    return bottomTab === "Chat" && chatOutputLifecycleActive && chatOutputDiffPath !== null;
  }
  if (selector === "[data-debug-id='surface-components-chatoutput-5']") {
    return bottomTab === "Chat" && chatOutputLifecycleActive;
  }
  if (selector === "[aria-label^='Dismiss warning: ']") {
    return bottomTab === "Chat" && chatOutputLifecycleActive && chatOutputDoomVisible;
  }
  if (selector === "[aria-label='Dismiss host MCP unreachable warning']") {
    return bottomTab === "Chat" && chatOutputLifecycleActive && chatOutputHostVisible;
  }
  if (selector === "[data-debug-id='files-search-input']") return rightTab === "Files";
  if (selector === "[aria-label='Select release-owned-file.txt']") {
    return filesPaneActive() && filesPaneFolder === "session" && !filesPaneSelected;
  }
  if (selector === "[aria-label='Remove release-owned-file.txt from selection']") {
    return filesPaneActive() && filesPaneFolder === "session" && filesPaneSelected;
  }
  if (selector === "[title='Attach selected files to the composer']"
    || selector === "[aria-label='Clear selected files']") {
    return filesPaneActive() && filesPaneFolder === "session" && filesPaneSelected;
  }
  if (selector === "[aria-label='Attach release-owned-file.txt']") {
    return filesPaneActive() && filesPaneFolder === "session";
  }
  if (selector === ".fv-row.dir [data-debug-id='surface-components-filespane-7']") {
    return filesPaneActive() && filesPaneFolder === "session";
  }
  if (selector === ".fv-row.file [data-debug-id='surface-components-filespane-7']") {
    return filesPaneActive() && (filesPaneFolder === "session" || filesPaneFolder === "nested");
  }
  if (selector === "[title='Back to session folder']") {
    return filesPaneActive() && filesPaneFolder !== "session";
  }
  if (selector === "[title='Up one level']") {
    return filesPaneActive() && filesPaneFolder === "session";
  }
  const composerAttachment = composerAttachmentTitle(selector);
  if (composerAttachment !== null) {
    return attachmentMediaPendingPaths.includes(composerAttachment)
      || bottomPanelAttachmentPaths.includes(composerAttachment);
  }
  const workPreviewKindSelected = selector.match(/^(.+)\[aria-selected='true'\]$/);
  const workPreviewKindBase = workPreviewKindSelected?.[1] ?? selector;
  const targetWorkPreviewKind = WORK_PREVIEW_KIND_BY_SELECTOR[workPreviewKindBase];
  if (targetWorkPreviewKind) {
    return rightTab === "Preview"
      && (!workPreviewKindSelected || workPreviewKind === targetWorkPreviewKind);
  }
  if (selector === "[id='work-preview-log-height-toggle']") return rightTab === "Preview";
  if (selector === ".work-preview-log") return rightTab === "Preview";
  if (selector === "[id='work-preview-refresh-state']") return rightTab === "Preview";
  if (selector === ".work-preview-status") return rightTab === "Preview";
  if (selector === ".work-preview-doctor-card") return rightTab === "Preview" && workPreviewDiagnostic !== null;
  if (selector === "[id='work-preview-doctor']") {
    return rightTab === "Preview" && renderedPreviewState?.status === "running";
  }
  if (selector === "[id='work-preview-open']" || selector === "[id='work-preview-restart']" || selector === "[id='work-preview-stop']") {
    return rightTab === "Preview" && renderedPreviewState?.status === "running";
  }
  if (selector === "[id='work-preview-panel-open-external']") {
    return rightTab === "Preview" && ownedModalOpen !== "preview" && renderedPreviewState?.status === "running";
  }
  if (selector === "[id='work-preview-stage-open-external']") {
    return ownedModalOpen === "preview" && renderedPreviewState?.status === "running";
  }
  if (
    selector === "[id='work-preview-frame-reload']"
    || selector === "[id='work-preview-viewport-phone']"
    || selector === "[id='work-preview-viewport-tablet']"
    || selector === "[id='work-preview-viewport-desktop']"
  ) return ownedModalOpen === "preview" && renderedPreviewState?.status === "running";
  if (selector === ".work-preview-stage-canvas") {
    return ownedModalOpen === "preview" && renderedPreviewState?.status === "running";
  }
  if (selector === "[id='preview-center-file-mode']") {
    return ownedModalOpen === "preview" && previewFilePath !== null;
  }
  if (selector === "[id='preview-center-work-mode']") {
    return ownedModalOpen === "preview" && renderedPreviewState?.status === "running";
  }
  if (selector === ".preview-center-body") return ownedModalOpen === "preview";
  if (selector === ".preview-body-html") {
    return ownedModalOpen === "preview" && previewCenterView === "file"
      && previewFilePath?.endsWith(".html") === true;
  }
  if (selector === ".preview-html-safe-state") {
    return ownedModalOpen === "preview" && previewCenterView === "file"
      && previewFilePath?.endsWith(".html") === true && filePreviewHtmlMode === "safe";
  }
  if (selector === "[id='file-preview-mode-code']" || selector === "[id='file-preview-mode-safe-render']") {
    return ownedModalOpen === "preview" && previewFilePath?.endsWith(".html") === true;
  }
  if (selector === "[id='file-preview-run-work']") {
    return ownedModalOpen === "preview" && previewCenterView === "file"
      && previewFilePath?.endsWith("release-file-preview.html") === true;
  }
  if (selector === "[data-debug-id='surface-components-workpreviewpanel-3']") {
    return rightTab === "Preview" && (!renderedPreviewState || renderedPreviewState.status === "idle" || renderedPreviewState.status === "stopped");
  }
  if (Object.hasOwn(taskToggleStates, selector)) return rightTab === "Tasks";
  if (selector === "[role='dialog'][aria-label='Command palette']") return commandPaletteOpen;
  if (selector === "[data-debug-id='command-palette-input']") return commandPaletteOpen;
  if (selector === "[data-debug-id='surface-components-commandpalette-4'][data-palette-action-id='act-settings']") {
    return commandPaletteOpen;
  }
  if (Object.hasOwn(alwaysVisibleTextValues, selector)) return true;
  if (selector === ".stab-new[title='New session (⌘T)']") return true;
  if (selector === ".composer-attachment-actions > .composer-attachment-action:nth-of-type(1)"
    || selector === ".composer-attachment-actions > .composer-attachment-action:nth-of-type(2)"
    || selector === ".composer-attachment-actions > .composer-attachment-action:nth-of-type(3)") {
    return (activeTab.tabId === bottomPanelOwnedTabId && bottomPanelAttachmentPaths.length > 0)
      || attachmentMediaPendingPaths.length > 0;
  }
  if (selector === "[data-debug-id='surface-components-bottompanel-24']") {
    return activeTab.tabId === bottomPanelOwnedTabId
      && alwaysVisibleTextValues["[data-debug-id='composer-prompt']"] === "/comm";
  }
  if (selector === "[role='dialog'][aria-label='Preview Center']") {
    return ownedModalOpen === "preview" && typeof previewTarget?.path === "string";
  }
  if (selector === ".preview-center-heading" || selector === ".preview-modal.preview-modal-embedded") {
    return ownedModalOpen === "preview" && previewCenterView === "file" && previewFilePath !== null;
  }
  if (selector === ".terminal-substrip > button.substrip-tab") {
    return activeTab.tabId === bottomPanelOwnedTabId && bottomPanelFixtureUserVisible;
  }
  if (selector === ".bottom-panel") return true;
  if (selector === ".composer-attachment-chip[title]") {
    return activeTab.tabId === bottomPanelOwnedTabId && bottomPanelAttachmentPaths.length > 0;
  }
  if (selector === ".composer-attachment-chip" || selector === ".composer-attachment-remove") {
    return bottomPanelAttachmentPaths.length > 0;
  }
  if (selector === "[data-release-terminal-id]") {
    return activeTab.tabId === bottomPanelOwnedTabId && bottomPanelTerminalIds.length > 0;
  }
  const exactTerminalRow = selector.match(/^\[data-release-terminal-id='([A-Za-z0-9._:-]+)'\]$/);
  if (exactTerminalRow) return bottomPanelTerminalIds.includes(exactTerminalRow[1]!);
  const foreignTerminalRow = selector.match(/^\[data-release-terminal-id\]:not\(\[data-release-terminal-id='([A-Za-z0-9._:-]+)'\]\)$/);
  if (foreignTerminalRow) return bottomPanelTerminalIds.some((id) => id !== foreignTerminalRow[1]);
  if (selector === "[data-release-bottom-panel-user-terminal-fixture]") {
    return activeTab.tabId === bottomPanelOwnedTabId && bottomPanelFixtureUserVisible
      && bottomPanelActiveTerminal === "user";
  }
  const removeAttachment = selector.match(/^\[aria-label='Remove ([^']+)'\]$/);
  if (removeAttachment) {
    return activeTab.tabId === bottomPanelOwnedTabId
      && bottomPanelAttachmentPaths.some((path) => path.replace(/\\/g, "/").endsWith(`/${removeAttachment[1]}`));
  }
  const mediaCard = selector.match(/^\[data-debug-id='surface-components-bottompanel-9'\]\[title='([^']+)'\]$/);
  if (mediaCard) return bottomTab === "Images" && bottomPanelImagePath === mediaCard[1]!.replace(/\\\\/g, "\\");
  const acpTerminal = selector.match(/^\[title='ACP terminal ([A-Za-z0-9._:-]+)'\]$/);
  if (acpTerminal) return bottomPanelTerminalIds.includes(acpTerminal[1]!);
  const closeAcpTerminal = selector.match(/^\[data-release-terminal-id='([A-Za-z0-9._:-]+)'\] \[aria-label='close terminal tab'\]$/);
  if (closeAcpTerminal) return bottomPanelTerminalIds.includes(closeAcpTerminal[1]!);
  if (selector === "[data-debug-id='surface-components-findpopover-1']") return true;
  if (selector === ".find-popover") return findSessionsFocused;
  if (selector === "[data-debug-id='surface-components-findpopover-3']") return findSessionsFocused;
  if (selector === "[data-debug-id='surface-components-findpopover-3'][aria-selected='true']") {
    return findSessionsFocused && findOpenRowSelected;
  }
  if (selector === "[data-debug-id='surface-components-findpopover-4']") {
    return findSessionsFocused && alwaysVisibleTextValues["[data-debug-id='find-sessions-input']"]?.startsWith("SHELLX_RELEASE_SESSION_CANARY_") === true;
  }
  if (selector === "[data-debug-id='surface-components-findpopover-4'][aria-selected='true']") {
    return findSessionsFocused && findDiskRowSelected;
  }
  if (selector === ".find-preview") return findSessionsFocused && (findOpenRowSelected || findDiskRowSelected);
  if (selector === "[title='Open this chat in a new tab (Enter)']") {
    return findSessionsFocused && (findOpenRowSelected || findDiskRowSelected);
  }
  const sessionTabSelector = selector.match(/^\[data-tab-id='([A-Za-z0-9._:-]+)'\](?: \[aria-label='Close session'\])?$/);
  if (sessionTabSelector) return openSessionTabs.some((tab) => tab.tabId === sessionTabSelector[1]);
  const vaultExpanded = selector === "[data-debug-id='header-vault-request-center'][aria-expanded='true']";
  if (selector === "[data-debug-id='header-vault-request-center']") return true;
  if (selector === "[data-debug-id='shellx-setup-guide']") return !setupGuideDismissed && currentWindow === "main-window";
  if (selector === "[data-debug-id='shellx-setup-guide-dismiss']") return !setupGuideDismissed && currentWindow === "main-window";
  if (/^\[data-debug-id='shellx-setup-step-(agents|browser|downloads|requests|vault)'\]$/.test(selector)) {
    return !setupGuideDismissed && currentWindow === "main-window";
  }
  if (vaultExpanded || selector === "[data-debug-id='vault-request-center-popover'][role='dialog']") {
    return vaultRequestCenterOpen;
  }
  if (
    selector === "[data-debug-id='vault-request-open-vault']"
    || selector === "[data-debug-id='vault-request-new-secret']"
    || selector === "[data-debug-id='vault-request-generate-password']"
  ) return vaultRequestCenterOpen;
  if (selector === "[data-debug-id='vault-password-generator']") {
    return vaultRequestCenterOpen && vaultPasswordGeneratorOpen;
  }
  if (selector === "[data-debug-id='vault-password-generator-close']") {
    return vaultRequestCenterOpen && vaultPasswordGeneratorOpen;
  }
  if (
    selector === "[data-debug-id='surface-components-vaultpasswordgenerator-5']"
    || selector === "[data-debug-id='vault-password-generator-length']"
    ||
    selector === "[data-debug-id='surface-components-vaultpasswordgenerator-11']"
    || selector === ":is([aria-label='Hide generated password'],[aria-label='Reveal generated password'])"
  ) return vaultRequestCenterOpen && vaultPasswordGeneratorOpen;
  if (selector === "[data-debug-id='vault-workspace-modal']") return vaultWorkspaceModalOpen;
  if (selector === "[data-debug-id='bottom-action-trace']" || selector === "[data-debug-id='bottom-action-assets']") return true;
  if (selector === "[data-debug-id='composer-connection']" || selector === "[data-debug-id='composer-agent']" || selector === "[data-debug-id='composer-branch']") return true;
  if (selector === "[role='dialog'][aria-label='Saved connections']") return composerPicker === "connection";
  if (selector === "[role='alertdialog'][aria-label='Delete connection']"
    || selector === "[aria-label='Confirm delete connection']"
    || selector === "[role='alertdialog'][aria-label='Delete connection'] button:nth-of-type(1)") {
    return composerPicker === "connection" && pendingConnectionDeleteId !== null;
  }
  if (selector === "[title='Add a new connection']") return composerPicker === "connection";
  if (composerPicker === "connection") {
    const useLabel = selector.match(/^\[title='Use ([^']+)'\]$/)?.[1];
    if (useLabel && [...connectionPresets.values()].some((preset) => preset.label === useLabel)) return true;
    const testLabel = selector.match(/^\[title='Use ([^']+)'\] ~ \[data-debug-id='surface-components-connectionpicker-3'\] > button:first-child$/)?.[1];
    if (testLabel && [...connectionPresets.values()].some((preset) => preset.label === testLabel)) return true;
    const testReceiptLabel = selector.match(/^\[title='Use ([^']+)'\] \[data-shellx-release-control='connection-test-receipt'\]$/)?.[1];
    if (testReceiptLabel && [...connectionPresets.values()].some((preset) => preset.label === testReceiptLabel)) return true;
    const editLabel = selector.match(/^\[title='Use ([^']+)'\] ~ \[data-debug-id='surface-components-connectionpicker-3'\] > button:nth-of-type\(2\)$/)?.[1];
    if (editLabel && [...connectionPresets.values()].some((preset) => preset.label === editLabel)) return true;
    const deleteLabel = selector.match(/^\[aria-label='Delete ([^']+)'\]$/)?.[1];
    if (deleteLabel && [...connectionPresets.values()].some((preset) => preset.label === deleteLabel)) return true;
  }
  if (selector === "[data-agent-picker-root][role='menu'][aria-label='Agent']") return composerPicker === "agent";
  if (selector === "[data-debug-id='surface-components-bottompanel-23'][data-agent-id='codex-cli']") {
    return composerPicker === "agent" && agentPickerFixtureActive;
  }
  if (selector === ".branch-picker[role='listbox']") return composerPicker === "branch";
  if (selector === "[data-debug-id='surface-components-branchpicker-1'][role='option']") {
    return composerPicker === "branch"
      && typeof activeTab.cwd === "string"
      && activeTab.cwd.includes("release-surface-git-");
  }
  if (selector === "[aria-label='Keyboard shortcuts']") return true;
  if (selector === "[aria-label='Open connector inbox']") return true;
  if (selector === "[role='tooltip'].hint-popover-portal") return keyboardHintOpen;
  if (selector === "[role='dialog'][aria-label='Activity Browser']") return activityOpen;
  if (selector === "[role='dialog'][aria-label='Activity Browser'] [aria-label='Close (Esc)']") return activityOpen;
  if (selector === "[data-debug-id='activity-search']") return activityOpen;
  if (selector === "[data-debug-id='activity-search-clear']") return activityOpen && activitySearchValue.length > 0;
  const activityEvidenceButton = selector.match(/^\[data-debug-id='activity-evidence-section-(changes|reads|commands|git)-expand'\](?:\[aria-pressed='(true|false)'\])?$/);
  if (activityEvidenceButton) {
    const focused = activityEvidenceFocused === activityEvidenceButton[1];
    return activityOpen && activityView === "evidence"
      && (!activityEvidenceButton[2] || (activityEvidenceButton[2] === "true") === focused);
  }
  const activityEvidenceGrid = selector.match(/^\.activity-evidence-grid\.activity-evidence-grid-focused-(changes|reads|commands|git)$/);
  if (activityEvidenceGrid) {
    return activityOpen && activityView === "evidence" && activityEvidenceFocused === activityEvidenceGrid[1];
  }
  const activitySelectedMatch = selector.match(/^(.+)\.active\[aria-selected='true'\]$/);
  const activityBase = activitySelectedMatch?.[1] ?? selector;
  const targetActivityView = ACTIVITY_VIEW_BY_SELECTOR[activityBase];
  if (targetActivityView) return activityOpen && (!activitySelectedMatch || targetActivityView === activityView);
  const activityPanelMatch = selector.match(/^#activity-panel-([^[]+)\[aria-labelledby='activity-tab-([^']+)'\]$/);
  if (activityPanelMatch) return activityOpen && activityPanelMatch[1] === activityView && activityPanelMatch[2] === activityView;
  if (selector === CONNECTION_DIALOG_SELECTOR) return connectionEditorOpen;
  if (selector === "[title='Add a new connection preset']") return settingsOpen && settingsTab === "connections" && !connectionEditorOpen;
  if (selector === "[data-debug-id='surface-components-settings-connectionstab-2']") {
    return settingsOpen && settingsTab === "connections" && !connectionEditorOpen;
  }
  if (selector === "[role='alertdialog'][aria-label='Delete saved connection']"
    || selector === "[aria-label='Cancel delete connection']"
    || selector === "[aria-label='Confirm delete saved connection']") {
    return settingsOpen && settingsTab === "connections" && pendingSettingsConnectionDeleteId !== null;
  }
  if (settingsOpen && settingsTab === "connections" && !connectionEditorOpen) {
    const row = selector.match(/^\.connection-row\[data-connection-id='([^']+)'\](?: \[title='(Edit this connection|Delete this connection preset)'\])?$/);
    if (row) return settingsConnectionRows.some((preset) => preset.id === row[1]);
  }
  if (selector === "[aria-label='Close connection editor']" || selector === "[aria-label='Cancel connection changes']") {
    return connectionEditorOpen;
  }
  if (selector === "[data-debug-id='surface-components-connectioneditor-12']"
    || selector === "[data-debug-id='surface-components-connectioneditor-14']") return connectionEditorOpen;
  if (selector === "[data-debug-id='connection-agent-cli-setup-open']") {
    return connectionEditorOpen && connectionEditorProviderScan !== null;
  }
  if (selector === "[data-shellx-release-control='connection-provider-scan-receipt']") {
    return connectionEditorOpen && connectionEditorProviderScan !== null;
  }
  if (selector === "[data-shellx-release-control='connection-test-receipt']") {
    return connectionEditorOpen
      && connectionEditorOwnedId !== null
      && connectionTestResults.has(connectionEditorOwnedId);
  }
  if (selector === "[data-debug-id='surface-components-connectioneditor-16']") return connectionEditorOpen;
  if (Object.hasOwn(connectionDraftValues, selector)) {
    if (!connectionEditorOpen) return false;
    if (selector === "[data-debug-id='connection-wsl-distro-input']") return connectionTransport === "wsl";
    if (selector === "[data-debug-id='connection-ssh-host-input']" || selector === "[data-debug-id='connection-ssh-port-input']") {
      return connectionTransport === "ssh";
    }
    if (selector === "[data-debug-id='connection-ssh-wsl-distro-input']") {
      return connectionTransport === "ssh" && connectionRuntime === "windows_wsl";
    }
    return true;
  }
  if (selector === "[data-debug-id='connection-transport-local']"
    || selector === "[data-debug-id='connection-transport-wsl']"
    || selector === "[data-debug-id='connection-transport-ssh']") return connectionEditorOpen;
  if (selector === "[data-debug-id='connection-ssh-runtime-select']") {
    return connectionEditorOpen && connectionTransport === "ssh";
  }
  if (selector === "[data-debug-id='connection-ssh-key-select']") {
    return connectionEditorOpen && connectionTransport === "ssh";
  }
  const connectionSshKeyOption = selector.match(/^\[data-debug-id='connection-ssh-key-select'\] option\[value='([^']+)'\]$/)?.[1];
  if (connectionSshKeyOption) {
    return connectionEditorOpen && connectionTransport === "ssh" && connectionVaultKeys.has(connectionSshKeyOption);
  }
  if (selector === "[aria-label='Connector editor'] .connector-editor-head > button.settings-pill:not([aria-label])") {
    return settingsOpen && settingsTab === "connectors" && !connectorDraftOpen;
  }
  if (selector === "[data-connectors-debug-fixture='owned-safe']") {
    return settingsOpen && settingsTab === "connectors" && connectorsFixtureActive;
  }
  if (selector === "[aria-label='Cancel connector draft']") {
    return settingsOpen && settingsTab === "connectors" && connectorDraftOpen;
  }
  const connectorProviderControl = selector.match(/^\[data-debug-id='surface-components-settings-connectorstab-3'\]\[data-provider-kind='(telegram|discord)'\]$/);
  if (connectorProviderControl) return settingsOpen && settingsTab === "connectors" && connectorDraftOpen;
  if (
    selector === "[aria-label='Connector receiver state'] > button:first-child"
    || selector === "[aria-label='Connector receiver state'] > button:last-child"
    || selector === "[aria-label='Connector delivery mode'] > button:first-child"
    || selector === "[aria-label='Connector delivery mode'] > button:last-child"
    || selector === "[id='connector-target']"
    || selector === "[data-debug-id='surface-components-settings-connectorstab-21']"
    || selector === "[id='connector-secret']"
    || selector === "[id='connector-allowed']"
  ) return settingsOpen && settingsTab === "connectors" && connectorDraftOpen;
  if (selector === "[data-debug-id='surface-components-settings-connectorstab-11']") {
    return settingsOpen && settingsTab === "connectors" && connectorsFixtureActive
      && connectorDraftOpen && connectorTargetMode === "fixedTab";
  }
  if (selector === "[id='connector-sim-connector']") {
    return settingsOpen && settingsTab === "connectors" && connectorsFixtureActive;
  }
  if (selector === "[data-debug-id='surface-components-settings-connectorstab-12']") {
    return settingsOpen && settingsTab === "connectors" && connectorsFixtureActive && connectorDraftOpen;
  }
  if (selector === "[data-debug-id='surface-components-settings-connectorstab-17']"
    || selector === "[data-connector-id='release-owned-connector-telegram'] [data-debug-id='surface-components-settings-connectorstab-18']"
    || selector === "[data-connector-id='release-owned-connector-telegram'] .settings-pill-danger") {
    return settingsOpen && settingsTab === "connectors" && connectorsFixtureActive;
  }
  if (selector === "[data-connector-id='release-owned-connector-telegram'] .connection-row-meta > button:nth-of-type(2)") {
    return settingsOpen && settingsTab === "connectors" && connectorsFixtureActive && !connectorDraftOpen;
  }
  if (Object.hasOwn(connectorSimValues, selector)) return settingsOpen && settingsTab === "connectors";
  const generalActive = selector.match(/^(.+)\.active$/);
  const generalBase = generalActive?.[1] ?? selector;
  const generalSetting = generalSettingForSelector(generalBase);
  if (generalSetting) {
    return settingsOpen && settingsTab === "general"
      && (!generalActive || publicSettings[generalSetting.key] === generalSetting.value);
  }
  if (selector === "[aria-label='Chat font size in pixels']" || selector === "[title='Reset to default']") {
    return settingsOpen && settingsTab === "general";
  }
  if (selector === "[title^='Delete the '][title$=' on disk + in localStorage']") {
    return settingsOpen && settingsTab === "data" && !dataDeleteDialogOpen;
  }
  if (selector === "[role='alertdialog'][aria-labelledby='data-delete-title']") {
    return settingsOpen && settingsTab === "data" && dataDeleteDialogOpen;
  }
  if (selector === "[id='data-delete-cancel']" || selector === "[id='data-delete-confirm']") {
    return settingsOpen && settingsTab === "data" && dataDeleteDialogOpen;
  }
  if (selector === "[data-shellx-release-control='data-delete-receipt']") {
    return settingsOpen && settingsTab === "data" && dataDeleteReceipt !== null;
  }
  const builtinDocOpen = BUILTIN_DOC_BY_SELECTOR[selector];
  if (builtinDocOpen) return settingsOpen && settingsTab === "about" && builtinDoc === null;
  if (ABOUT_EXTERNAL_URL_BY_SELECTOR[selector]) return settingsOpen && settingsTab === "about";
  const builtinDialog = selector.match(/^\[role='dialog'\]\[aria-label='(Features|Quick start|Changelog|Third-party notices)'\](?: \[aria-label='Close \(Esc\)'\])?$/);
  if (builtinDialog) return builtinDoc === builtinDialog[1];
  if (selector === ":is([title='Collapse tier'],[title='Expand tier'])") return pluginsOpen;
  if (selector === ":is([title='Collapse all projects'],[title='Expand all projects'])") return true;
  if (selector === ":is([title='Hide open chats — drop here to unfile'],[title='Show open chats — drop here to unfile'])") return true;
  if (selector === "[data-debug-id='left-past-chats-toggle']") return true;
  if (selector === ".session-tabs-rail" || selector === "[title='New session (⌘T)']" || selector === "[aria-label='New session']" || selector === "[aria-label='All sessions']") {
    return true;
  }
  if (selector === "[aria-label='Scroll left']") return sessionRailScrollLeft > 1;
  if (selector === "[aria-label='Scroll right']") return sessionRailScrollLeft < sessionRailMaxScrollLeft() - 1;
  if (selector === "[role='listbox']" || selector === ".stab-dropdown") return sessionDropdownOpen;
  const sessionTabParts = sessionTabSelectorParts(selector);
  if (sessionTabParts) {
    const tab = openSessionTabs.find((entry) => entry.tabId === sessionTabParts.tabId);
    if (!tab) return false;
    if (!sessionTabParts.descendant) return true;
    if (sessionTabParts.descendant === "[data-debug-id='session-rename-input']") {
      return sessionRenamingTabId === sessionTabParts.tabId;
    }
    if (sessionTabParts.descendant === "[aria-label='Rename session']") {
      return sessionRenamingTabId !== sessionTabParts.tabId;
    }
    if (sessionTabParts.descendant === "[aria-label='Close session']") return true;
    if (sessionTabParts.descendant === "[data-debug-id='surface-components-sessiontabs-4']") {
      return previewTarget?.tabId === sessionTabParts.tabId;
    }
    return false;
  }
  const dropdownRow = sessionDropdownRowParts(selector);
  if (dropdownRow) {
    const tab = sessionTabAt(dropdownRow.index);
    if (!sessionDropdownOpen || !tab) return false;
    if (!dropdownRow.descendant) return true;
    if (dropdownRow.descendant === "[data-debug-id='surface-components-sessiontabs-11']") {
      return previewTarget?.tabId === tab.tabId;
    }
    if (dropdownRow.descendant === "[title='Close']") return true;
    return false;
  }
  if (selector === ".shell") return true;
  const active = selector.endsWith(".active");
  const base = active ? selector.slice(0, -".active".length) : selector;
  const tab = TAB_BY_SELECTOR[base];
  if (tab) return !active || tab === bottomTab;
  if (selector === "[role='dialog'][aria-label='Settings']" || selector === ".settings-modal[role='dialog']") return settingsOpen;
  if (selector === "[role='dialog'][aria-label='Settings'] [aria-label='Close settings']") return settingsOpen;
  if (selector === "[data-debug-id='settings-browser-download-folder']") return settingsOpen && settingsTab === "general";
  if (selector === "[data-debug-id='settings-browser-download-folder-choose']") {
    return settingsOpen && settingsTab === "general";
  }
  if (selector === "[data-debug-id='surface-components-settings-vaultsetuppanel-17']") {
    return settingsOpen && settingsTab === "vault";
  }
  if (selector === ".vault-keyfile-picker > button:last-child") {
    return settingsOpen && settingsTab === "vault" && vaultKeyfileSelected;
  }
  if (selector === "[role='dialog'][aria-label='Plugins']") return pluginsOpen;
  if (selector === "[role='dialog'][aria-label='Plugins'] [aria-label='Close']") return pluginsOpen;
  const selectedMatch = selector.match(/^(.+)\[aria-selected='true'\]$/);
  const settingsBase = selectedMatch?.[1] ?? selector;
  const targetSettingsTab = SETTINGS_TAB_BY_SELECTOR[settingsBase];
  if (targetSettingsTab) return settingsOpen && (!selectedMatch || targetSettingsTab === settingsTab);
  const panelMatch = selector.match(/^#settings-tab-panel\[aria-labelledby='settings-tab-([^']+)'\]$/);
  if (panelMatch) return settingsOpen && panelMatch[1] === settingsTab;
  const vaultWorkspaceSelectedMatch = selector.match(/^(.+)\.active\[aria-selected='true'\]$/);
  const vaultWorkspaceBase = vaultWorkspaceSelectedMatch?.[1] ?? selector;
  const targetVaultWorkspaceTab = VAULT_WORKSPACE_TAB_BY_SELECTOR[vaultWorkspaceBase];
  if (targetVaultWorkspaceTab) {
    return ((settingsOpen && settingsTab === "vault") || vaultWorkspaceModalOpen)
      && (!vaultWorkspaceSelectedMatch || targetVaultWorkspaceTab === vaultWorkspaceTab);
  }
  const vaultWorkspacePanelMatch = selector.match(
    /^#vault-workspace-panel-([^[]+)\[aria-labelledby='vault-tab-([^']+)'\]$/,
  );
  if (vaultWorkspacePanelMatch) {
    return ((settingsOpen && settingsTab === "vault") || vaultWorkspaceModalOpen)
      && vaultWorkspacePanelMatch[1] === vaultWorkspaceTab
      && vaultWorkspacePanelMatch[2] === vaultWorkspaceTab;
  }
  const vaultResourceSelectedMatch = selector.match(/^(.+)\.active\[aria-selected='true'\]$/);
  const vaultResourceBase = vaultResourceSelectedMatch?.[1] ?? selector;
  const targetVaultResourceTab = VAULT_RESOURCE_FORM_TAB_BY_SELECTOR[vaultResourceBase];
  if (targetVaultResourceTab) {
    return ((settingsOpen && settingsTab === "vault") || vaultWorkspaceModalOpen)
      && vaultWorkspaceTab === "secrets"
      && (!vaultResourceSelectedMatch || targetVaultResourceTab === vaultResourceFormTab);
  }
  const vaultResourcePanelMatch = selector.match(
    /^#vault-resource-form-panel-([^[]+)\[aria-labelledby='vault-resource-form-tab-([^']+)'\]$/,
  );
  if (vaultResourcePanelMatch) {
    return ((settingsOpen && settingsTab === "vault") || vaultWorkspaceModalOpen)
      && vaultWorkspaceTab === "secrets"
      && vaultResourcePanelMatch[1] === vaultResourceFormTab
      && vaultResourcePanelMatch[2] === vaultResourceFormTab;
  }
  const rightSelectedMatch = selector.match(/^(.+)\.active\[aria-selected='true'\]$/);
  const rightBase = rightSelectedMatch?.[1] ?? selector;
  const targetRightTab = RIGHT_TAB_BY_SELECTOR[rightBase];
  if (targetRightTab) return !rightSelectedMatch || targetRightTab === rightTab;
  return false;
}

function resetConnectorInboxManualRefreshReceipt(): void {
  connectorInboxManualRefreshSequence = 0;
  connectorInboxManualRefreshCompletedAtMs = null;
  connectorInboxManualRefreshConnectorCount = null;
  connectorInboxManualRefreshEventCount = null;
  connectorInboxManualRefreshMaxEventMs = null;
}

function resetConnectorDraft(open = false): void {
  connectorDraftOpen = open;
  connectorProvider = "telegram";
  connectorEnabled = false;
  connectorDispatchMode = "inbox";
  connectorTargetMode = "activeTab";
  connectorVaultKey = "telegram/bot-token";
  connectorAllowedIds = "";
  connectorSecretValue = "";
  connectorFixedTabId = "";
  connectorEditingId = "";
}

function resetAttachmentMediaFixture(): void {
  attachmentMediaPendingPaths = [];
  attachmentMediaSessionPath = null;
  attachmentMediaImagePath = null;
  attachmentMediaVideoPath = null;
}

function rightRailGitWriteFixtureActive(): boolean {
  const cwd = typeof activeTab.cwd === "string" ? activeTab.cwd : "";
  return cwd.includes("ui-right-rail-git-write-lifecycle") && existsSync(cwd) && existsSync(join(cwd, ".git"));
}

function createOwnedGitWriteCheckpoint(): void {
  if (!rightRailGitWriteFixtureActive()) throw new Error("owned Git write fixture is not active");
  const repo = String(activeTab.cwd);
  const id = `${Date.now()}-before-review-fixture`;
  const target = join(
    profileRoot,
    ".shellx",
    "git-checkpoints",
    "fixture-owned-repository",
    "fixture-active-tab-035",
    id,
  );
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(join(target, "unstaged.patch"), "SHELLX_GIT_WRITE_TRACKED_035\n", { flag: "wx", mode: 0o600 });
  writeFileSync(join(target, "staged.patch"), "", { flag: "wx", mode: 0o600 });
  writeFileSync(join(target, "status.txt"), "## release-proof\n M README.md\n?? owned-untracked.txt\n", { flag: "wx", mode: 0o600 });
  writeFileSync(join(target, "untracked.json"), JSON.stringify({ entries: [{ path: "owned-untracked.txt" }] }, null, 2), { flag: "wx", mode: 0o600 });
  writeFileSync(join(target, "checkpoint.json"), JSON.stringify({
    id,
    label: "Before review fixture locale",
    createdAtMs: Date.now(),
    branch: "release-proof",
    head: runFixtureGit(repo, ["rev-parse", "HEAD"]).trim(),
    repoRoot: repo,
    path: target,
    staged: 0,
    unstaged: 1,
    untracked: 1,
    conflicts: 0,
  }, null, 2), { flag: "wx", mode: 0o600 });
}

function createOwnedGitWriteWorktree(): void {
  if (!rightRailGitWriteFixtureActive()) throw new Error("owned Git write fixture is not active");
  const repo = String(activeTab.cwd);
  const seconds = Math.floor(Date.now() / 1000);
  const branch = `shellx/release-proof-${seconds}`;
  const target = join(repo, ".worktrees", `shellx-release-proof-${seconds}`);
  runFixtureGit(repo, ["worktree", "add", "-b", branch, target, "release-proof"]);
}

function runFixtureGit(repo: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(`owned Git fixture command failed: ${String(result.stderr || result.stdout).trim().slice(0, 800)}`);
  }
  return String(result.stdout);
}

function attachmentMediaImportedPath(): string | null {
  const cwd = typeof activeTab.cwd === "string" ? activeTab.cwd : "";
  return cwd && attachmentMediaImagePath
    ? join(cwd, ".shellx", "assets", "release-owned-image.png")
    : null;
}

function scanOwnedAgentCliVersion(): void {
  const binDir = join(profileRoot, ".local", "bin");
  const binary = [join(binDir, "grok"), join(binDir, "grok.CMD")].find(existsSync);
  if (!binary) throw new Error("owned Agent CLI fixture binary is missing");
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    shell: binary.toUpperCase().endsWith(".CMD"),
    timeout: 2_000,
  });
  if (result.status !== 0) {
    throw new Error(`owned Agent CLI version scan failed: ${String(result.stderr).slice(0, 300)}`);
  }
  const versionLine = String(result.stdout).split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = versionLine.match(/shellx-refresh-[12]\.0\.0/);
  if (!match) throw new Error("owned Agent CLI scan returned an unexpected version");
  ownedAgentCliVersion = match[0];
  ownedAgentCliScanCount += 1;
}

function ownedConnectionProviderScan(): Array<Record<string, unknown>> {
  const checkedAtMs = Date.now();
  return ["grok", "codex-cli", "claude-code", "antigravity-cli"].map((providerId, index) => ({
    providerId,
    canRun: true,
    status: "ready",
    binary: `shellx-release-owned-${providerId}`,
    version: `${providerId} release-fixture-${index + 1}.0.0`,
    binarySha256: createHash("sha256").update(`shellx-release-owned-${providerId}`).digest("hex"),
    binaryBytes: 128 + index,
    targetKey: `local:${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"}`,
    checkedAtMs,
  }));
}

function runOwnedNpmInstallShim(): void {
  const shim = join(profileRoot, ".local", "bin", process.platform === "win32" ? "npm.CMD" : "npm");
  if (!existsSync(shim)) throw new Error("owned npm install shim is missing");
  const result = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/D", "/C", "call", shim, "install", "-g", "@openai/codex"], {
        encoding: "utf8",
        env: { ...process.env, HOME: profileRoot, USERPROFILE: profileRoot },
        timeout: 2_000,
      })
    : spawnSync(shim, ["install", "-g", "@openai/codex"], {
        encoding: "utf8",
        env: { ...process.env, HOME: profileRoot },
        timeout: 2_000,
      });
  if (result.status !== 0 || !String(result.stdout).includes("SHELLX_OWNED_NPM_SHIM_OK")) {
    throw new Error(`owned npm install shim failed: ${String(result.stderr).slice(0, 300)}`);
  }
}

function importAttachmentMediaImage(attach: boolean): void {
  const target = attachmentMediaImportedPath();
  if (!target || !attachmentMediaImagePath || !existsSync(attachmentMediaImagePath)) {
    throw new Error("owned Attachment/Media fixture cannot import its image");
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, readFileSync(attachmentMediaImagePath), { flag: "wx", mode: 0o600 });
  if (attach) attachmentMediaPendingPaths.push(target);
}

function previewAttachmentMediaPath(path: string | null): void {
  if (!path) throw new Error("owned Attachment/Media fixture preview path is missing");
  previewTarget = {
    kind: "file",
    path,
    tabId: activeTab.tabId,
    sessionCwd: activeTab.cwd,
  };
  previewFilePath = path;
  previewCenterView = "file";
  ownedModalOpen = "preview";
}

function closeModalBackdrop(selector: string): void {
  if (!selectorDisplayed(selector)) throw new Error(`fixture modal backdrop is not visible: ${selector}`);
  if (selector === "[data-debug-id='activity-browser-backdrop']") activityOpen = false;
  else if (selector === "[data-debug-id='agent-cli-setup-dialog']") {
    if (agentCliSetupFixtureMode === "status-card") agentCliStatusDialogProvider = null;
    else agentCliSetupFixtureMode = "closed";
  }
  else if (selector === "[data-debug-id='attachment-media-board-backdrop']") ownedModalOpen = null;
  else if (selector === "[data-debug-id='surface-components-builtindocmodal-4']") builtinDoc = null;
  else if (selector === "[data-debug-id='surface-components-commandpalette-1']") commandPaletteOpen = false;
  else if (selector === "[data-debug-id='surface-components-connectioneditor-1']") connectionEditorOpen = false;
  else if (selector === "[data-debug-id='connector-inbox-backdrop']") {
    ownedModalOpen = null;
    resetConnectorInboxManualRefreshReceipt();
  }
  else if (selector === "[data-debug-id='surface-components-helpmodal-1']") helpModalOpen = false;
  else if (selector === "[data-debug-id='surface-components-pluginsmodal-1']") pluginsOpen = false;
  else if (selector === "[data-debug-id='surface-components-prcreatemodal-1']") ownedModalOpen = null;
  else if (selector === "[data-debug-id='preview-center-backdrop']") ownedModalOpen = null;
  else if (selector === "[data-debug-id='surface-components-settings-1']") {
    settingsOpen = false;
    dataDeleteDialogOpen = false;
    resetConnectorDraft();
  }
  else if (selector === "[data-debug-id='surface-components-vaultpanel-1']") {
    ownedModalOpen = null;
    vaultWorkspaceModalOpen = false;
    vaultWorkspaceIntent = null;
  }
  else if (leftRailLifecycle && selector === "[data-debug-id='surface-components-leftrail-19']") {
    ownedProjectDeleteDialog = false;
  }
  else if (leftRailLifecycle && selector === "[data-debug-id='surface-components-leftrail-24']") {
    leftRailSessionDeleteDialog = false;
    leftRailSessionDeleteTarget = null;
  }
  else if (selector === "[data-debug-id='surface-components-permissionmodal-1']"
    && permissionFixtureAction === "modal-backdrop-deny") {
    permissionDecision = "deny";
  }
  else {
    throw new Error(`fixture does not support modal backdrop ${selector}`);
  }
  clickedSelectors.push(selector);
}

function completeProviderAction(selector: string): boolean {
  if (!providerActionFixture || providerActionDigest) return false;
  const expected = providerActionFixture === "activity-ask-agent"
    ? selector === "[role='dialog'][aria-label='Activity Browser'] button.pact"
    : providerActionFixture === "tasks-visible-ask"
      ? selector === "[title='Ask the active agent to inspect the visible background tasks']"
      : providerActionFixture === "tasks-row-ask"
        ? selector === "[title='Ask the active agent to inspect this background task and its latest output']"
          || selector.endsWith(" [title='Ask the active agent to inspect this background task and its latest output']")
        : providerActionFixture === "work-preview-ask-fix"
          ? selector === "[id='work-preview-ask-fix']"
          : providerActionFixture === "work-preview-palette-ask-fix"
            ? selector === "[data-palette-action-id='act-preview-doctor']"
          : providerActionFixture === "work-preview-stage-ask-fix"
            ? selector === "[id='work-preview-stage-ask-fix']"
            : providerActionFixture === "work-preview-browser-issue-fix"
              ? selector === "[data-debug-id='surface-components-workpreviewpanel-16']"
              : providerActionFixture === "right-rail-connector-action"
                ? selector === "[data-debug-id='surface-components-rightrail-11']"
                : providerActionFixture === "right-rail-environment-ask"
                  ? selector === "[title='Ask the active agent to inspect this diagnostic snapshot']"
                  : providerActionFixture === "browser-send"
                    ? selector === "[data-debug-id='shellx-browser-agent-send']"
                  : providerActionFixture === "browser-explain-page"
                    ? selector === "[data-debug-id='shellx-browser-chat-explain-page']"
                  : providerActionFixture === "composer-send"
                    ? selector === "[data-debug-id='composer-send']"
                  : false;
  if (!expected) return false;
  const browserVisiblePrompt = providerActionFixture === "browser-send"
    ? browserGoalValue.trim()
    : providerActionFixture === "browser-explain-page"
      ? browserExplainPrompt()
      : null;
  const exactPrompt = providerActionFixture === "composer-send"
    ? (alwaysVisibleTextValues["[data-debug-id='composer-prompt']"] ?? "").trim()
    : browserVisiblePrompt === null
      ? `fixture:${providerActionFixture}`
      : browserCoworkEnvelope(browserVisiblePrompt);
  providerActionDigest = createHash("sha256").update(exactPrompt).digest("hex");
  providerActionRunId = `fixture-provider-action-${providerActionFixture}`;
  if (providerActionFixture === "activity-ask-agent") activityOpen = false;
  if (providerActionFixture === "work-preview-palette-ask-fix") commandPaletteOpen = false;
  if (browserVisiblePrompt !== null) browserGoalValue = "";
  if (providerActionFixture === "composer-send") {
    alwaysVisibleTextValues["[data-debug-id='composer-prompt']"] = "";
  }
  clickedSelectors.push(selector);
  return true;
}

function browserCoworkEnvelope(visiblePrompt: string): string {
  if (!browserTaskId || !browserTaskTabId || !browserTaskUrl) {
    throw new Error("Browser provider action fixture lacks its exact task, tab, or URL");
  }
  return `ShellX Browser cowork request\nBrowser task ID: ${browserTaskId}\nBrowser tab ID: ${browserTaskTabId}\nCurrent URL: ${browserTaskUrl}\n\nWork in the visible native ShellX Browser with the explicit task and tab IDs above. Use ShellX Browser tools, preserve operator pause/takeover/abort authority, and keep Vault or sensitive actions inside Request Center. Do not switch to a hidden or unrelated browser surface.\n\nUser message:\n${visiblePrompt}`;
}

function browserExplainPrompt(): string {
  if (!browserTaskUrl) throw new Error("Browser explain fixture lacks its exact URL");
  return [
    "Explain the current browser page for the user.",
    `URL: ${browserTaskUrl}`,
    "Title: ShellX release settle",
    "Page excerpt: Owned Browser settle fixture ready",
    "Summarize what the page is for, the important visible facts/actions, and any security or trust concerns. Do not assume access to user secrets or hidden session data unless the user explicitly grants it.",
  ].join("\n");
}

function completeBrowserSaveAction(selector: string): boolean {
  const action = new Map<string, { reasons: string[]; queued: boolean }>([
    ["[data-debug-id='shellx-browser-save-fullpage-screenshot']", { reasons: ["userPageSave:fullPageScreenshot"], queued: false }],
    ["[data-debug-id='shellx-browser-save-screenshot']", { reasons: ["userPageSave:screenshot"], queued: false }],
    ["[data-debug-id='shellx-browser-save-markdown']", { reasons: ["userPageSave:markdown"], queued: false }],
    ["[data-debug-id='shellx-browser-save-links']", { reasons: ["userPageSave:linksJson"], queued: false }],
    ["[data-debug-id='shellx-browser-save-snapshot']", {
      reasons: ["userPageSave:fullPageScreenshot", "userPageSave:snapshotJson"],
      queued: false,
    }],
    ["[data-debug-id='shellx-browser-save-media']", { reasons: ["userPageSave:media"], queued: true }],
    ["[data-debug-id='shellx-browser-save-code']", { reasons: ["userPageSave:code"], queued: true }],
    ["[data-debug-id='shellx-browser-save-site']", { reasons: ["userPageSave:workingSiteCopy"], queued: true }],
  ]).get(selector);
  if (!action) return false;
  if (browserDisclosure !== "save" || !browserDownloadFolder || !browserTaskId || !browserTaskTabId || !browserTaskUrl) {
    throw new Error("Browser Save fixture lacks its exact menu, folder, task, tab, or page");
  }
  for (const reason of action.reasons) {
    browserTransferSequence += 1;
    const requestedAtMs = 1_750_100_000_000 + browserTransferSequence;
    const transferId = `fixture-browser-save-transfer-${browserTransferSequence}`;
    if (action.queued) {
      const displayName = browserSaveDisplayName(reason);
      browserDownloads.push({
        transferId,
        direction: "download",
        status: "requested",
        taskId: browserTaskId,
        browserTabId: browserTaskTabId,
        url: browserTaskUrl,
        filePath: null,
        displayName,
        finalPath: null,
        mimeType: null,
        contentKind: null,
        bytes: null,
        sha256: null,
        sourceUrl: null,
        destination: browserDownloadFolder,
        retentionReason: null,
        approvalId: null,
        destinationOrigin: null,
        refId: null,
        reason,
        requestedAtMs,
        completedAtMs: null,
      });
      continue;
    }
    const artifact = browserSaveArtifact(reason, browserTaskUrl, browserTransferSequence);
    const finalPath = join(browserDownloadFolder, artifact.fileName);
    writeFileSync(finalPath, artifact.bytes, { flag: "wx", mode: 0o600 });
    browserDownloads.push({
      transferId,
      direction: "download",
      status: "completed",
      taskId: browserTaskId,
      browserTabId: browserTaskTabId,
      url: browserTaskUrl,
      filePath: null,
      displayName: artifact.fileName,
      finalPath,
      mimeType: artifact.mimeType,
      contentKind: null,
      bytes: artifact.bytes.length,
      sha256: createHash("sha256").update(artifact.bytes).digest("hex"),
      sourceUrl: browserTaskUrl,
      destination: "local-downloads",
      retentionReason: reason,
      approvalId: `fixture-browser-save-approval-${browserTransferSequence}`,
      destinationOrigin: null,
      refId: null,
      reason,
      requestedAtMs,
      completedAtMs: requestedAtMs + 1,
    });
  }
  browserDisclosure = "downloads";
  browserRightTab = "actions";
  clickedSelectors.push(selector);
  return true;
}

function browserSaveDisplayName(reason: string): string {
  if (reason === "userPageSave:media") return "Media copy job";
  if (reason === "userPageSave:code") return "Code copy job";
  if (reason === "userPageSave:workingSiteCopy") return "Site copy job";
  throw new Error(`unsupported queued Browser Save reason ${reason}`);
}

function browserSaveArtifact(
  reason: string,
  sourceUrl: string,
  sequence: number,
): { fileName: string; mimeType: string; bytes: Buffer } {
  if (reason === "userPageSave:screenshot" || reason === "userPageSave:fullPageScreenshot") {
    return {
      fileName: `shellx-release-${sequence}${reason.endsWith("fullPageScreenshot") ? "-fullpage" : "-window"}.png`,
      mimeType: "image/png",
      bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    };
  }
  if (reason === "userPageSave:markdown") {
    return {
      fileName: `shellx-release-${sequence}.md`,
      mimeType: "text/markdown",
      bytes: Buffer.from("# ShellX release settle\n\nOwned Browser settle fixture ready\n", "utf8"),
    };
  }
  if (reason === "userPageSave:linksJson") {
    return {
      fileName: `shellx-release-${sequence}-links.json`,
      mimeType: "application/json",
      bytes: Buffer.from(`${JSON.stringify({
        sourceUrl,
        title: "ShellX release settle",
        capturedAt: "2026-08-01T00:00:00.000Z",
        count: 0,
        links: [],
      }, null, 2)}\n`, "utf8"),
    };
  }
  if (reason === "userPageSave:snapshotJson") {
    return {
      fileName: `shellx-release-${sequence}-snapshot.json`,
      mimeType: "application/json",
      bytes: Buffer.from(`${JSON.stringify({
        sourceUrl,
        title: "ShellX release settle",
        capturedAt: "2026-08-01T00:00:00.000Z",
        domSummary: { textLength: 37 },
        markdown: "# ShellX release settle\n\nOwned Browser settle fixture ready",
        links: [],
        screenshot: {
          path: "candidate-private-screenshot-path",
          bytes: 68,
          sha256: "a".repeat(64),
          width: 1,
          height: 1,
          fullPage: true,
          pageWidth: 1,
          pageHeight: 1,
        },
      }, null, 2)}\n`, "utf8"),
    };
  }
  throw new Error(`unsupported completed Browser Save reason ${reason}`);
}

const candidate = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.url === "/health" && request.method === "GET") {
      return json(response, 200, {
        ok: true,
        processId,
        instanceId,
        appVersion: version,
        buildCommit: sourceCommit,
        debugApiPort: candidateAddress().port,
        debugUiWebSocketActive,
        debugUiWebSocketGeneration,
      });
    }
    if (requestUrl.pathname === "/preview-fixture/release-preview.html" && request.method === "GET") {
      if (previewState?.status !== "running"
        || previewState.url !== `http://127.0.0.1:${candidateAddress().port}${requestUrl.pathname}`) {
        return text(response, 404, "preview stopped");
      }
      return text(
        response,
        200,
        "<!doctype html><title>ShellX release Preview</title><main>SHELLX_RELEASE_OWNED_STATIC_PREVIEW_035</main>\n",
        "text/html; charset=utf-8",
      );
    }
    if (requestUrl.pathname === "/preview-fixture/release-file-preview.html" && request.method === "GET") {
      if (previewState?.status !== "running"
        || previewState.url !== `http://127.0.0.1:${candidateAddress().port}${requestUrl.pathname}`
        || !previewFilePath || !existsSync(previewFilePath)) {
        return text(response, 404, "preview stopped");
      }
      return text(response, 200, readFileSync(previewFilePath, "utf8"), "text/html; charset=utf-8");
    }
    if (!authorized(request)) return json(response, 401, { error: "unauthorized" });
    if (requestUrl.pathname === "/release-test/native-picker") {
      if (request.method === "POST") {
        const body = await requestJson(request);
        if (releaseNativePickerLease
          || (body.kind !== "file" && body.kind !== "directory")
          || typeof body.path !== "string" || !body.path || !existsSync(body.path)) {
          return json(response, 400, { error: "release_native_picker_invalid" });
        }
        releaseNativePickerLease = {
          kind: body.kind,
          path: body.path,
          pathSha256: createHash("sha256").update(body.path).digest("hex"),
        };
        return json(response, 201, {
          armed: true,
          kind: releaseNativePickerLease.kind,
          pathSha256: releaseNativePickerLease.pathSha256,
        });
      }
      if (request.method === "GET") {
        return releaseNativePickerLease
          ? json(response, 200, {
            armed: true,
            kind: releaseNativePickerLease.kind,
            pathSha256: releaseNativePickerLease.pathSha256,
          })
          : json(response, 200, { armed: false });
      }
      if (request.method === "DELETE") {
        const cleared = releaseNativePickerLease !== null;
        releaseNativePickerLease = null;
        return json(response, 200, { cleared });
      }
    }
    if (request.url === "/browser/state" && request.method === "GET") {
      const effectiveAdMode = browserProfileAdModes.get(browserProfileId) ?? "balanced";
      return json(response, 200, {
        activeTaskId,
        downloadFolder: browserDownloadFolder,
        downloads: browserDownloads,
        privacy: {
          globalAdMode: "balanced",
          profileModes: [...browserProfileAdModes].map(([profileId, adMode]) => ({ profileId, adMode })),
        },
        personalLock: browserPersonalLock,
        windowOpen: browserWindowOpen,
        engine: {
          engineId: "browser-engine-foreground",
          mounted: browserWindowOpen && browserTaskTabId !== null,
          privacyMode: effectiveAdMode,
        },
        enginePool: {
          engines: browserTaskTabId
            ? [{ engineId: "browser-engine-foreground", mounted: browserWindowOpen }]
            : [],
          windowState: browserWindowOpen ? "foreground" : "closed",
        },
        tabs: [
          ...(browserTaskTabId && browserTaskId ? [{
            browserTabId: browserTaskTabId,
            engineId: "browser-engine-foreground",
            taskId: browserTaskId,
            profileId: "task-disposable",
            privacyMode: effectiveAdMode,
            active: browserProfileId !== "personal",
            url: browserTaskUrl,
            shields: activeBrowserShields(),
          }] : []),
          ...(browserPersonalTabId ? [{
            browserTabId: browserPersonalTabId,
            engineId: "browser-engine-foreground",
            taskId: null,
            profileId: "personal",
            privacyMode: effectiveAdMode,
            active: browserProfileId === "personal",
            url: "about:blank",
            shields: activeBrowserShields(),
          }] : []),
        ],
        tasks: browserTaskId ? [{
          taskId: browserTaskId,
          status: activeTaskStatus,
          ownerSessionId: browserTaskOwnerSessionId,
          currentUrl: browserTaskUrl,
        }] : [],
      });
    }
    if (request.url === "/browser/downloads" && request.method === "GET") {
      return json(response, 200, { downloads: browserDownloads });
    }
    if (request.url === "/browser/downloads/request" && request.method === "POST") {
      const body = await requestJson(request);
      if (body.taskId !== browserTaskId || body.browserTabId !== browserTaskTabId
        || typeof body.url !== "string" || !body.url || typeof body.fileName !== "string" || !body.fileName
        || typeof body.reason !== "string" || !body.reason) {
        return json(response, 400, { error: "invalid owned Browser download intent fixture" });
      }
      browserTransferSequence += 1;
      const entry = {
        transferId: `fixture-browser-download-intent-${browserTransferSequence}`,
        direction: "download",
        status: "requested",
        taskId: browserTaskId,
        browserTabId: browserTaskTabId,
        url: body.url,
        filePath: null,
        displayName: body.fileName,
        finalPath: null,
        mimeType: null,
        contentKind: null,
        bytes: null,
        sha256: null,
        sourceUrl: null,
        destination: null,
        retentionReason: null,
        approvalId: null,
        destinationOrigin: null,
        refId: null,
        reason: body.reason,
        requestedAtMs: 1_750_100_000_000 + browserTransferSequence,
        completedAtMs: null,
      };
      browserDownloads.push(entry);
      return json(response, 200, entry);
    }
    if (request.url === "/browser/shields" && request.method === "GET") {
      return json(response, 200, { shields: browserShields });
    }
    if (request.url === "/vault/status" && request.method === "GET") {
      return json(response, 200, {
        activeGrants: 0,
        lastError: null,
        legacyVaultDetected: false,
        mode: "unconfigured",
        pendingDeposits: 0,
        recoveryConfirmed: false,
        rememberedDeviceEnabled: true,
        syncPending: false,
        unlocked: false,
      });
    }
    if (requestUrl.pathname === "/vault/keys" && request.method === "GET") {
      const prefix = requestUrl.searchParams.get("prefix") ?? "";
      const keys = [...new Set([...pluginsVaultKeys, ...connectionVaultKeys])]
        .filter((key) => key.startsWith(prefix))
        .sort();
      return json(response, 200, { keys, entries: keys.map((key) => ({ key, kind: "secret" })) });
    }
    if (request.url === "/vault/set" && request.method === "POST") {
      const body = await requestJson(request);
      if (typeof body.key !== "string" || !body.key.startsWith("connections.")
        || typeof body.value !== "string" || !body.value) {
        return json(response, 400, { error: "invalid owned Connection Vault-key fixture" });
      }
      if (connectionVaultKeys.has(body.key)) return json(response, 409, { error: "owned Connection Vault key already exists" });
      connectionVaultKeys.add(body.key);
      return json(response, 200, { ok: true, key: body.key });
    }
    if (request.url === "/vault/delete" && request.method === "POST") {
      const body = await requestJson(request);
      if (body.key === "github/pat" && pluginsProductionLifecycle) {
        pluginsVaultKeys.delete("github/pat");
        return json(response, 200, { ok: true, key: "github/pat" });
      }
      if (typeof body.key !== "string" || !connectionVaultKeys.delete(body.key)) {
        return json(response, 400, { error: "unknown synthetic Vault key" });
      }
      if (connectionSshKeyVaultRef === body.key) connectionSshKeyVaultRef = "";
      return json(response, 200, { ok: true, key: body.key });
    }
    if (request.url === "/browser/task/start" && request.method === "POST") {
      const body = await requestJson(request);
      if (body.autonomy !== "assistedAutonomous") {
        return json(response, 400, { error: "Browser fixture requires the enforced assistedAutonomous policy" });
      }
      const startUrl = typeof body.startUrl === "string" ? body.startUrl : "about:blank";
      if (browserTaskTabId) {
        return json(response, 409, { error: "previous owned Browser task tab was not cleaned" });
      }
      browserActiveHost = startUrl.startsWith("about:") ? null : new URL(startUrl).hostname;
      browserProfileId = typeof body.profileId === "string" && body.profileId ? body.profileId : "task-disposable";
      activeTaskId = `fixture-browser-task-${Date.now()}`;
      browserTaskId = activeTaskId;
      browserTaskTabId = `fixture-browser-tab-${Date.now()}`;
      browserTaskOwnerSessionId = typeof request.headers["x-shellx-mcp-caller-id"] === "string"
        ? request.headers["x-shellx-mcp-caller-id"]
        : null;
      browserTaskUrl = startUrl;
      browserAddressValue = startUrl;
      activeTaskStatus = "running";
      recorderStatusVisible = false;
      browserEvidenceManualRefreshSequence = 0;
      browserEvidenceManualRefreshCompletedAtMs = null;
      browserWindowOpen = true;
      browserPersonalLockNotice = false;
      return json(response, 200, {
        taskId: activeTaskId,
        status: activeTaskStatus,
        ownerSessionId: browserTaskOwnerSessionId,
        currentUrl: browserTaskUrl,
      });
    }
    if (request.url === "/browser/tabs/open" && request.method === "POST") {
      const body = await requestJson(request);
      if (body.profileId !== "personal" || body.url !== "about:blank" || browserPersonalTabId) {
        return json(response, 400, { ok: false, error: "invalid isolated personal Browser tab fixture" });
      }
      if (browserPersonalLock.enabled && browserPersonalLock.locked) {
        return json(response, 400, { ok: false, error: "Personal browser is locked" });
      }
      browserPersonalTabId = `fixture-browser-personal-tab-${Date.now()}`;
      browserProfileId = "personal";
      return json(response, 200, {
        ok: true,
        tab: {
          browserTabId: browserPersonalTabId,
          taskId: null,
          profileId: "personal",
          active: true,
          url: "about:blank",
        },
        receipt: { kind: "browserTabOpened", data: { profileId: "personal" } },
      });
    }
    if (request.url === "/browser/tabs/focus" && request.method === "POST") {
      const body = await requestJson(request);
      if (body.browserTabId === browserPersonalTabId && browserPersonalTabId) {
        browserProfileId = "personal";
      } else if (body.browserTabId === browserTaskTabId && browserTaskTabId) {
        browserProfileId = "task-disposable";
      } else {
        return json(response, 404, { ok: false, error: "unknown owned Browser tab" });
      }
      return json(response, 200, {
        ok: true,
        tab: { browserTabId: body.browserTabId, profileId: browserProfileId, active: true },
        receipt: { kind: "browserTabFocused" },
      });
    }
    if (requestUrl.pathname === "/browser/settle" && request.method === "GET") {
      const taskId = requestUrl.searchParams.get("taskId");
      const browserTabId = requestUrl.searchParams.get("browserTabId");
      if (!browserWindowOpen || taskId !== browserTaskId || browserTabId !== browserTaskTabId) {
        return json(response, 404, { error: "unknown owned Browser settle target" });
      }
      return json(response, 200, {
        settled: true,
        taskId: browserTaskId,
        browserTabId: browserTaskTabId,
        taskStatus: activeTaskStatus,
        tabStatus: "ready",
        engineId: "browser-engine-foreground",
        engineLoadStatus: "loaded",
        engineUrl: browserTaskUrl,
        revision: "fixture-provider-action-settled",
        pendingUrl: null,
      });
    }
    if (request.url === "/browser/task/control" && request.method === "POST") {
      const body = await requestJson(request);
      if (body.taskId !== browserTaskId || typeof body.action !== "string") {
        return json(response, 400, { error: "invalid task control" });
      }
      if (body.action === "pause" && activeTaskStatus === "running") activeTaskStatus = "paused";
      else if (body.action === "resume" && (activeTaskStatus === "paused" || activeTaskStatus === "userTakeover")) {
        activeTaskStatus = "running";
        activeTaskId = browserTaskId;
      }
      else if (body.action === "abort" && activeTaskStatus && !["aborted", "blocked", "completed"].includes(activeTaskStatus)) {
        activeTaskStatus = "aborted";
        activeTaskId = null;
      }
      else return json(response, 400, { error: "invalid task transition" });
      return json(response, 200, { ok: true, status: activeTaskStatus });
    }
    if (request.url === "/browser/task/finish" && request.method === "POST") {
      const body = await requestJson(request);
      if (browserTaskOwnerSessionId
        && request.headers["x-shellx-mcp-caller-id"] !== browserTaskOwnerSessionId) {
        return json(response, 403, { error: "Browser fixture task owner session mismatch" });
      }
      if (body.taskId !== browserTaskId || body.status !== "aborted" || !activeTaskStatus) {
        return json(response, 400, { error: "invalid task finish" });
      }
      if (!["aborted", "blocked", "completed"].includes(activeTaskStatus)) activeTaskStatus = "aborted";
      activeTaskId = null;
      return json(response, 200, { taskId: browserTaskId, status: activeTaskStatus });
    }
    if (request.url === "/browser/tabs/close" && request.method === "POST") {
      const body = await requestJson(request);
      if (body.browserTabId === browserPersonalTabId && browserPersonalTabId) {
        const closed = browserPersonalTabId;
        browserPersonalTabId = null;
        if (browserProfileId === "personal") browserProfileId = "task-disposable";
        return json(response, 200, { ok: true, tab: { browserTabId: closed, active: false } });
      }
      if (browserTaskOwnerSessionId
        && request.headers["x-shellx-mcp-caller-id"] !== browserTaskOwnerSessionId) {
        return json(response, 403, { error: "Browser fixture tab owner session mismatch" });
      }
      if (body.browserTabId !== browserTaskTabId || !browserTaskTabId) {
        return json(response, 404, { error: "unknown owned Browser tab" });
      }
      const closed = browserTaskTabId;
      browserTaskTabId = null;
      return json(response, 200, { ok: true, tab: { browserTabId: closed, active: false } });
    }
    if (request.url === "/browser/engine-pool" && request.method === "GET") {
      return json(response, 200, {
        enginePool: {
          limits: { configuredParallelAgents: browserParallelAgents },
          automationMode: browserAutomationMode,
          engines: [],
          waiting: [],
          parkedTabs: [],
        },
      });
    }
    if (request.url === "/browser/evidence?limit=20" && request.method === "GET") {
      return json(response, 200, {
        ok: true,
        callerScoped: false,
        durableRecovered: 0,
        durableScanTruncated: false,
        durableScanFailed: false,
        durableSkipped: 0,
        recent: evidenceReceipts.slice(-20).reverse(),
      });
    }
    if (requestUrl.pathname === "/release-test/tauri-invokes" && request.method === "POST") {
      const body = await requestJson(request);
      if (typeof body.command !== "string" || !body.args || typeof body.args !== "object" || Array.isArray(body.args)) {
        return json(response, 400, { error: "invalid owned TasksPanel invoke request" });
      }
      releaseTauriInvokeSequence += 1;
      const id = `rti-${releaseTauriInvokeSequence.toString(16).padStart(32, "0")}`;
      const value = handleReleaseTauriInvoke(body.command, body.args as Record<string, unknown>);
      releaseTauriInvokes.set(id, { value });
      return json(response, 202, { id, status: "pending" });
    }
    const releaseInvokeMatch = requestUrl.pathname.match(/^\/release-test\/tauri-invokes\/(rti-[0-9a-f]{32})$/);
    if (releaseInvokeMatch && request.method === "GET") {
      const record = releaseTauriInvokes.get(releaseInvokeMatch[1]!);
      if (!record) return json(response, 404, { error: "release_tauri_invoke_not_found", message: "not found" });
      return json(response, 200, { id: releaseInvokeMatch[1], status: "passed", value: record.value });
    }
    if (releaseInvokeMatch && request.method === "DELETE") {
      const removed = releaseTauriInvokes.delete(releaseInvokeMatch[1]!);
      return json(response, 200, { removed });
    }
    if (request.url === "/agent_cli_setup/install/cancel" && request.method === "POST") {
      const body = await requestJson(request);
      if (typeof body.confirmationId !== "string" || body.confirmationId !== agentCliInstallConfirmationId) {
        return json(response, 400, { error: "agent_cli_setup.cancel: unknown or expired confirmation id" });
      }
      agentCliInstallConfirmationId = null;
      agentCliInstallCancelCount += 1;
      return json(response, 200, { ok: true, cleaned: true });
    }
    if (request.url === "/agent_cli_setup/install/confirm" && request.method === "POST") {
      const body = await requestJson(request);
      if (typeof body.confirmationId !== "string" || body.confirmationId !== agentCliInstallConfirmationId) {
        return json(response, 400, { error: "agent_cli_setup.confirm: unknown or expired confirmation id" });
      }
      return json(response, 409, { error: "fixture confirmation must be invoked through native input" });
    }
    if (request.url === "/state/ui" && request.method === "GET") {
      return json(response, 200, {
        bottomTab,
        settingsOpen,
        settingsTab,
        dataDeleteDialogOpen,
        setupGuideDismissed,
        agentCliSetupFixture: agentCliSetupFixtureMode,
        ownedAgentCliVersion,
        ownedAgentCliScanCount,
        agentCliInstallConfirmationId,
        goalPlanReviewFixture: goalPlanReviewFixtureMode,
        agentCliStatusDialogProvider,
        vaultRequestCenterOpen,
        vaultWorkspaceIntent,
        rightTab,
        debugUiConnectionFixture,
        releaseTestExternalEffectBoundary,
        activeTabId: activeTab.tabId,
        activeTab,
        openTabs: openSessionTabs,
        preview: previewTarget,
        openModal: ownedModalOpen,
        debugHighlightResults,
        debugHighlightResultsBySurface: { app: debugHighlightResults },
        shellxagentFixtureActive,
        permissionFixtureAction,
        permissionDecision,
        providerActionFixture,
        providerActionDigest,
        providerActionRunId,
      });
    }
    if (requestUrl.pathname === "/provider-sessions/state" && request.method === "GET") {
      const tabId = requestUrl.searchParams.get("tabId") ?? "default";
      const buildRecentRuns = buildRunProviderAction && buildRunProviderDigest && buildRunProviderRunId
        && buildRunState?.tabId === tabId
        ? [{
            runId: buildRunProviderRunId,
            tabId,
            providerId: "codex-cli",
            phase: "completed",
            persistSession: false,
            shellxToolExposure: "off",
          }]
        : [];
      const goalRecentRuns = goalProviderAction && goalProviderDigest && goalProviderRunId
        && goalState?.tabId === tabId
        ? [{
            runId: goalProviderRunId,
            tabId,
            providerId: "codex-cli",
            phase: "completed",
            persistSession: false,
            shellxToolExposure: "off",
          }]
        : [];
      const recentRuns = goalRecentRuns.length > 0
        ? goalRecentRuns
        : buildRecentRuns.length > 0
        ? buildRecentRuns
        : providerActionFixture && providerActionDigest && providerActionRunId
        ? [{
            runId: providerActionRunId,
            tabId,
            providerId: "codex-cli",
            phase: "completed",
            persistSession: false,
            shellxToolExposure: "off",
          }]
        : [];
      return json(response, 200, {
        tabId,
        transport: "local",
        transportKey: "local",
        recentRuns,
        storedConversations: {},
      });
    }
    if (requestUrl.pathname === "/events/recent" && request.method === "GET") {
      const events: Array<{ t: number; kind: string; payload: Record<string, unknown> }> = aboutExternalUrls.map((url, index) => ({
        t: 1_750_000_000_000 + index,
        kind: "external-url-dispatched",
        payload: { url },
      }));
      if (providerActionFixture && providerActionDigest && providerActionRunId) {
        events.push({
          t: 1_750_000_100_000,
          kind: "provider-session-event",
          payload: {
            tabId: `release-provider-action-${providerActionFixture}`,
            runId: providerActionRunId,
            providerId: "codex-cli",
            kind: "text",
            text: `SHELLX_PROVIDER_ACTION_RECEIPT ${providerActionFixture} ${providerActionDigest}`,
          },
        });
      }
      if (buildRunProviderAction && buildRunProviderDigest && buildRunProviderRunId && buildRunState) {
        events.push({
          t: 1_750_000_200_000,
          kind: "build-event",
          payload: {
            kind: "release_fixture_provider_started",
            tabId: buildRunState.tabId,
            runId: buildRunProviderRunId,
            action: buildRunProviderAction,
            promptSha256: buildRunProviderDigest,
          },
        }, {
          t: 1_750_000_200_001,
          kind: "provider-session-event",
          payload: {
            tabId: buildRunState.tabId,
            runId: buildRunProviderRunId,
            providerId: "codex-cli",
            kind: "text",
            text: `SHELLX_PROVIDER_ACTION_RECEIPT ${buildRunProviderAction} ${buildRunProviderDigest}`,
          },
        });
      }
      if (goalProviderAction && goalProviderDigest && goalProviderRunId && goalState) {
        events.push({
          t: 1_750_000_300_000,
          kind: "goal-event",
          payload: {
            kind: "release_fixture_provider_started",
            tabId: goalState.tabId,
            runId: goalProviderRunId,
            action: goalProviderAction,
            promptSha256: goalProviderDigest,
          },
        }, {
          t: 1_750_000_300_001,
          kind: "provider-session-event",
          payload: {
            tabId: goalState.tabId,
            runId: goalProviderRunId,
            providerId: "codex-cli",
            kind: "text",
            text: `SHELLX_PROVIDER_ACTION_RECEIPT ${goalProviderAction} ${goalProviderDigest}`,
          },
        });
      }
      events.push(...rendererCrashEvents);
      return json(response, 200, events);
    }
    if (requestUrl.pathname === "/build/state" && request.method === "GET") {
      return json(response, 200, {
        tabId: requestUrl.searchParams.get("tabId") ?? "default",
        state: buildRunState,
      });
    }
    if (requestUrl.pathname === "/build/receipts" && request.method === "GET") {
      return json(response, 200, {
        ok: true,
        tabId: requestUrl.searchParams.get("tabId") ?? "default",
        receipts: buildRunReceipts,
      });
    }
    if (request.url === "/build/start" && request.method === "POST") {
      const body = await requestJson(request);
      const target = body.releaseTestState;
      if (buildRunState !== null || typeof body.tabId !== "string" || body.tabId !== activeTab.tabId
        || typeof body.cwd !== "string" || body.cwd !== activeTab.cwd
        || !["awaiting-approval", "active", "paused", "blocked-recheckable"].includes(String(target))) {
        return json(response, 400, { error: "invalid isolated Build Run fixture" });
      }
      const runId = `fixture-${body.tabId}-run`;
      const scratchboardPath = join(body.cwd, `build.${body.tabId}.${runId}.md`);
      writeFileSync(scratchboardPath, "# Build: fixture\n\nStatus: AWAITING_APPROVAL\n\n## Phase 1 - Exercise\n- [ ] Exercise control\n\n## Phase 2 - Review\n- [ ] AI slop wiring placeholder mock fake success audit\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      const status = target === "awaiting-approval"
        ? "awaitingApproval"
        : target === "blocked-recheckable"
          ? "blocked"
          : target;
      if (target !== "awaiting-approval") {
        writeFileSync(scratchboardPath, readFileSync(scratchboardPath, "utf8").replace("Status: AWAITING_APPROVAL", "Status: IN_PROGRESS"), "utf8");
      }
      buildRunState = {
        runId,
        tabId: body.tabId,
        objective: body.objective,
        cwd: body.cwd,
        transportKind: "local",
        scratchboardPath,
        status,
        continuationsTotal: 0,
        checkpointId: null,
        codeChanged: false,
        reviewRequired: false,
        reviewSatisfied: target === "blocked-recheckable",
        verificationRequired: false,
        verificationSatisfied: true,
        previewRequired: false,
        previewSatisfied: true,
        openBlocker: target === "blocked-recheckable"
          ? "Review gate receipt is pending for the isolated fixture"
          : null,
      };
      buildPlanRejectArmed = false;
      buildRunReceipts = [{ kind: "runStarted", summary: `Build Mode started: ${body.objective}`, data: {} }];
      if (target !== "awaiting-approval") buildRunReceipts.push({ kind: "planApproved", summary: "Build plan approved", data: {} });
      if (target === "blocked-recheckable") {
        buildRunReceipts.push(
          { kind: "blockerOpened", summary: buildRunState.openBlocker, data: { fixtureOnly: true } },
          { kind: "reviewCompleted", summary: "Owned review evidence is now complete", data: { gateEvidence: { accepted: true } } },
        );
      }
      return json(response, 200, {
        ok: true,
        tabId: body.tabId,
        state: buildRunState,
        kickoffPrompt: "fixture",
        releaseTestState: target,
      });
    }
    if (request.url === "/build/stop" && request.method === "POST") {
      const body = await requestJson(request);
      if (!buildRunState || body.tabId !== buildRunState.tabId || body.releaseTestClearState !== true) {
        return json(response, 400, { error: "Build fixture cleanup must be exact" });
      }
      const tabId = buildRunState.tabId;
      buildRunState = null;
      buildRunReceipts = [];
      buildRunProviderAction = null;
      buildRunProviderDigest = null;
      buildRunProviderRunId = null;
      buildPlanRejectArmed = false;
      return json(response, 200, {
        ok: true,
        tabId,
        stopped: true,
        active: false,
        releaseTestCleared: true,
      });
    }
    if (requestUrl.pathname === "/goal/state" && request.method === "GET") {
      return json(response, 200, {
        tabId: requestUrl.searchParams.get("tabId") ?? "default",
        state: goalState,
        approvalStatus: goalState?.awaitingApproval === true
          ? { ready: goalState.planTurnCompleted === true, reason: null }
          : goalState ? { ready: false, reason: null } : null,
        lastClear: goalLastClear,
      });
    }
    if (request.url === "/goal/start" && request.method === "POST") {
      const body = await requestJson(request);
      if (goalState !== null || goalLastClear !== null) {
        return json(response, 409, { error: "previous Goal fixture was not exactly cleared" });
      }
      if (body.tabId !== activeTab.tabId || body.cwd !== activeTab.cwd
        || (body.releaseTestState !== "awaiting-review" && body.releaseTestState !== "active-approved")) {
        return json(response, 400, { error: "invalid isolated RightRail Goal fixture" });
      }
      const awaitingApproval = body.releaseTestState === "awaiting-review";
      const scratchboardPath = `${String(body.cwd).replace(/[\\/]$/, "")}/goal.md`;
      writeFileSync(
        scratchboardPath,
        `# Goal: ${body.objective}\n\nStatus: AWAITING_APPROVAL\n\n## Phase 1 - Verify lifecycle\n- [ ] Exercise the exact owned Goal Plan action\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      goalState = {
        tabId: body.tabId,
        active: true,
        objective: body.objective,
        scratchboardPath,
        transportKind: "local",
        continuationsTotal: 0,
        startedAtMs: Date.now(),
        pausedByUser: false,
        halted: false,
        haltedReason: null,
        awaitingApproval,
        planTurnCompleted: true,
        approvedAtMs: awaitingApproval ? 0 : Date.now(),
      };
      goalPlanRejectArmed = false;
      goalProviderAction = null;
      goalProviderDigest = null;
      goalProviderRunId = null;
      goalReviewModalOpen = awaitingApproval;
      return json(response, 200, {
        ok: true,
        tabId: body.tabId,
        objective: body.objective,
        scratchboardPath: goalState.scratchboardPath,
        cwd: body.cwd,
        releaseTestState: body.releaseTestState,
      });
    }
    if (request.url === "/goal/stop" && request.method === "POST") {
      const body = await requestJson(request);
      if (body.tabId !== activeTab.tabId || body.releaseTestClearState !== true) {
        return json(response, 400, { error: "Goal fixture cleanup must be exact" });
      }
      goalState = null;
      goalLastClear = null;
      goalReviewModalOpen = false;
      goalPlanReviewEditing = false;
      goalPlanReviewComment = "";
      goalPlanRejectArmed = false;
      goalProviderAction = null;
      goalProviderDigest = null;
      goalProviderRunId = null;
      pendingAlertText = null;
      return json(response, 200, {
        ok: true,
        tabId: body.tabId,
        active: false,
        releaseTestCleared: true,
      });
    }
    if (request.url === "/settings" && request.method === "GET") {
      return json(response, 200, publicSettings);
    }
    if (request.url === "/connections" && request.method === "GET") {
      return json(response, 200, { presets: [...connectionPresets.values()] });
    }
    if (request.url === "/connections" && request.method === "POST") {
      const body = await requestJson(request);
      const transport = body.transport && typeof body.transport === "object" && !Array.isArray(body.transport)
        ? body.transport as Record<string, unknown>
        : null;
      if (connectionPresets.size !== 0 || typeof body.label !== "string" || !body.label
        || transport?.kind !== "local") {
        return json(response, 400, { error: "invalid isolated connection fixture" });
      }
      const id = `fixture-owned-connection-${sourceCommit.slice(0, 16)}`;
      const preset: Record<string, unknown> = {
        ...structuredClone(body),
        id,
        createdMs: 1_750_000_000_000,
        lastUsedMs: 0,
      };
      connectionPresets.set(id, preset);
      return json(response, 200, preset);
    }
    if (requestUrl.pathname.startsWith("/connections/") && request.method === "DELETE") {
      const id = decodeURIComponent(requestUrl.pathname.slice("/connections/".length));
      if (!connectionPresets.delete(id)) return json(response, 404, { error: "unknown owned connection fixture" });
      connectionTestResults.delete(id);
      connectionEditorProviderScan = null;
      if (connectionEditorOwnedId === id) {
        connectionEditorOwnedId = null;
        connectionEditorOpen = false;
      }
      if (pendingConnectionDeleteId === id) pendingConnectionDeleteId = null;
      if (pendingSettingsConnectionDeleteId === id) pendingSettingsConnectionDeleteId = null;
      return json(response, 200, { ok: true, id });
    }
    if (request.url === "/state/ui" && request.method === "POST") {
      const body = await requestJson(request);
      if (body.releaseTestResetBrowserPersonalLock !== undefined) {
        if (body.releaseTestResetBrowserPersonalLock !== "owned-pin-lifecycle") {
          return json(response, 400, { error: "invalid_release_test_personal_lock_reset" });
        }
        Object.assign(browserPersonalLock, {
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
        browserPersonalLockVerifierDigest = null;
        browserPersonalLockPinDraft = "";
        browserPersonalLockNotice = false;
      }
      if (leftRailLifecycle && body.refreshPastChats === true) {
        leftRailPastAvailable = existsSync(join(profileRoot, ".shellx", "sessions", leftRailOwnedSessionId + ".jsonl"));
      }
      if (body.debugPluginsFixture === "owned-safe") {
        pluginsFixtureActive = true;
        pluginsProductionFixtureActive = false;
        pluginsKeyFormEntryId = null;
        pluginsKeyDraftValue = "";
      } else if (body.debugPluginsFixture === "owned-production" && pluginsProductionLifecycle) {
        pluginsFixtureActive = false;
        pluginsProductionFixtureActive = true;
        pluginsKeyFormEntryId = null;
        pluginsKeyDraftValue = "";
      } else if (body.debugPluginsFixture === "clear") {
        pluginsFixtureActive = false;
        pluginsProductionFixtureActive = false;
        pluginsKeyFormEntryId = null;
        pluginsKeyDraftValue = "";
      }
      if (body.debugConnectorsFixture === "owned-safe") {
        connectorsFixtureActive = true;
        connectorSimConnectorId = "release-owned-connector-telegram";
        connectorUnsafeMutationCount = 0;
        resetConnectorDraft();
      } else if (body.debugConnectorsFixture === "clear") {
        connectorsFixtureActive = false;
        connectorSimConnectorId = "";
        resetConnectorDraft();
      }
      if (body.debugBuildPlanFixture === "owned-ready") {
        buildPlanFixtureActive = true;
        buildPlanReviewOpen = false;
        buildPlanRejectArmed = false;
      } else if (body.debugBuildPlanFixture === "clear") {
        buildPlanFixtureActive = false;
        buildPlanReviewOpen = false;
        buildPlanRejectArmed = false;
      }
      if (body.debugShellxagentFixture === "owned-safe") {
        shellxagentFixtureActive = true;
        shellxagentRevealed = false;
      } else if (body.debugShellxagentFixture === "clear") {
        shellxagentFixtureActive = false;
        shellxagentRevealed = false;
      }
      if (body.releaseTestHostMcpChild === "spawn-owned") {
        if (visibleHostMcpTasks().length !== 0) {
          return json(response, 409, { error: "owned Host MCP fixture collision" });
        }
        ownedBackgroundTasks.push({
          taskId: "gs-release-owned-host-mcp",
          origin: "host_mcp",
          commandDisplay: "ShellX release-owned Host MCP child",
          pid: 7_035,
          cpuPct: 0,
          rssMb: 1,
          status: "running",
          startedAtMs: 1_750_000_003_500,
          recentOutputTail: "",
          tabId: String(activeTab.tabId),
        });
        tasksCleanupMcpArmed = false;
      } else if (body.releaseTestHostMcpChild === "clear-owned") {
        ownedBackgroundTasks = ownedBackgroundTasks.filter((task) => !(task.origin === "host_mcp"
          && task.tabId === activeTab.tabId
          && task.commandDisplay === "ShellX release-owned Host MCP child"));
        tasksCleanupMcpArmed = false;
      } else if (body.releaseTestHostMcpChild !== undefined) {
        return json(response, 400, { error: "invalid owned Host MCP fixture command" });
      }
      if (body.cwdPicker && typeof body.cwdPicker === "object" && !Array.isArray(body.cwdPicker)) {
        const picker = body.cwdPicker as Record<string, unknown>;
        if (picker.open === false) {
          remoteCwdOpen = false;
          remoteCwdPath = "";
          remoteCwdDraft = "";
          remoteCwdOwnedUseActive = false;
        } else if (picker.isolated === true && typeof picker.path === "string"
          && picker.label === "Final surface isolated local folder") {
          remoteCwdOpen = true;
          remoteCwdPath = fixtureNormalizePath(picker.path);
          remoteCwdDraft = remoteCwdPath;
          remoteCwdIsolatedLaunchCount += 1;
          remoteCwdOwnedUseActive = false;
        } else if (picker.isolated === false && picker.tabId === activeTab.tabId
          && typeof picker.path === "string" && picker.label === "Final surface owned active tab folder") {
          remoteCwdOpen = true;
          remoteCwdPath = fixtureNormalizePath(picker.path);
          remoteCwdDraft = remoteCwdPath;
          remoteCwdOwnedUseActive = true;
          remoteCwdOwnedUseLaunchCount += 1;
        }
      }
      if (typeof body.bottomTab === "string") bottomTab = body.bottomTab;
      if (body.releaseTestVoiceCapture === "recording") {
        releaseTestVoiceRecording = true;
        releaseTestVoiceMode = true;
      } else if (body.releaseTestVoiceCapture === "clear") {
        releaseTestVoiceRecording = false;
        releaseTestVoiceMode = false;
      }
      if (body.releaseTestExternalEffectBoundary === "pr-create"
        || body.releaseTestExternalEffectBoundary === "artifact-archive") {
        releaseTestExternalEffectBoundary = body.releaseTestExternalEffectBoundary;
        prCreateBoundaryReceipt = null;
        artifactArchiveReceipt = null;
      } else if (body.releaseTestExternalEffectBoundary === "clear") {
        releaseTestExternalEffectBoundary = null;
        prCreateBoundaryReceipt = null;
        artifactArchiveReceipt = null;
        prApprovalChecked = false;
        prDraftActive = false;
        prTranscriptActive = false;
        for (const selector of Object.keys(prTextValues)) prTextValues[selector] = "";
      }
      if (body.releaseTestRendererCrash === true) {
        errorBoundaryOpen = true;
        debugUiWebSocketActive = 0;
        rendererCrashEvents.push({
          t: 1_750_000_400_000 + rendererCrashEvents.length,
          kind: "renderer-error",
          payload: {
            message: "SHELLX_RELEASE_TEST_RENDERER_CRASH_035",
            stack: "release-test-renderer-stack",
            componentStack: "release-test-component-stack",
          },
        });
      }
      if (body.releaseTestLazySurface === "owned-error") {
        lazySurfaceState = "error";
      } else if (body.releaseTestLazySurface === "clear") {
        lazySurfaceState = "closed";
      }
      if (body.debugUiConnectionFixture === "disconnected") debugUiConnectionFixture = "disconnected";
      else if (body.debugUiConnectionFixture === "clear") debugUiConnectionFixture = "clear";
      if (body.debugUpdateFixture === "owned-check" || body.debugUpdateFixture === "owned-available") {
        debugUpdateFixture = body.debugUpdateFixture;
        const available = body.debugUpdateFixture === "owned-available";
        updateBannerAvailable = available;
        rightRailUpdateAvailable = available;
        aboutUpdateAvailable = available;
        updateBannerReceipt = null;
        rightRailUpdateReceipt = null;
        aboutUpdateReceipt = null;
      } else if (body.debugUpdateFixture === "clear") {
        debugUpdateFixture = "owned-cleared";
        updateBannerAvailable = false;
        rightRailUpdateAvailable = false;
        aboutUpdateAvailable = false;
        updateBannerReceipt = null;
        rightRailUpdateReceipt = null;
        aboutUpdateReceipt = null;
      }
      if (Array.isArray(body.debugHighlights)) {
        debugHighlightResults = body.debugHighlights.flatMap((entry: unknown) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const value = entry as Record<string, unknown>;
          if (typeof value.id !== "string" || typeof value.selector !== "string") return [];
          const resolved = selectorDisplayed(value.selector);
          return [{
            id: value.id,
            status: resolved ? "resolved" : "missing",
            selector: value.selector,
            ...(resolved ? {
              rect: { left: 10, top: 10, width: 180, height: 28 },
              visibleRect: { left: 10, top: 10, width: 180, height: 28 },
            } : {}),
          }];
        });
      }
      if (
        body.agentCliSetupFixture === "closed"
        || body.agentCliSetupFixture === "cards"
        || body.agentCliSetupFixture === "confirmation"
        || body.agentCliSetupFixture === "status-card"
        || body.agentCliSetupFixture === "live-status"
        || body.agentCliSetupFixture === "live-setup"
        || body.agentCliSetupFixture === "install-lifecycle"
      ) {
        agentCliSetupFixtureMode = body.agentCliSetupFixture;
        agentCliStatusDialogProvider = null;
        if (body.agentCliSetupFixture === "live-status" || body.agentCliSetupFixture === "live-setup") {
          scanOwnedAgentCliVersion();
        }
        if (body.agentCliSetupFixture === "closed") agentCliInstallConfirmationId = null;
      }
      if (
        body.goalPlanReviewFixture === "closed"
        || body.goalPlanReviewFixture === "review"
        || body.goalPlanReviewFixture === "editing"
      ) {
        goalPlanReviewFixtureMode = body.goalPlanReviewFixture;
        goalPlanReviewEditing = body.goalPlanReviewFixture === "editing";
        goalPlanReviewComment = "";
      }
      if (typeof body.activeTabId === "string") {
        const requested = openSessionTabs.find((tab) => tab.tabId === body.activeTabId);
        if (requested) activeTab = activeContextFromSessionTab(requested, activeTab);
      }
      if (typeof body.rightTab === "string") {
        if (body.debugSurface === "browser") browserRightTab = body.rightTab;
        else {
          if (rightTab === "Tasks" && body.rightTab !== "Tasks") {
            agentRunsManualRefreshSequence = 0;
            agentRunsManualRefreshGeneratedAtMs = null;
            tasksManualRefreshSequence = 0;
            tasksCleanupMcpArmed = false;
            expandedBackgroundTaskIds.clear();
          }
          rightTab = body.rightTab;
        }
      }
      if (body.activeTab && typeof body.activeTab === "object" && !Array.isArray(body.activeTab)) {
        activeTab = structuredClone(body.activeTab as Record<string, unknown>);
        const cwd = typeof activeTab.cwd === "string" ? activeTab.cwd : "";
        filesPaneSessionPath = cwd.includes("ui-files-pane-lifecycle") ? cwd : null;
        filesPaneFolder = "session";
        filesPaneSelected = false;
        const index = openSessionTabs.findIndex((tab) => tab.tabId === activeTab.tabId);
        if (index >= 0) openSessionTabs[index] = { ...openSessionTabs[index], ...sessionTabFromActive(activeTab) };
      }
      if (body.preview && typeof body.preview === "object" && !Array.isArray(body.preview)) {
        previewTarget = structuredClone(body.preview as Record<string, unknown>);
        previewVideoPlaybackState = "idle";
        const path = (body.preview as Record<string, unknown>).path;
        if (typeof path === "string" && path) {
          previewFilePath = path;
          filePreviewHtmlMode = "code";
        }
      }
      if (body.clearPreview === true) {
        previewTarget = null;
        previewFilePath = null;
        previewVideoPlaybackState = "idle";
      }
      if (Array.isArray(body.debugAttachPaths)) {
        if (activeTab.tabId === bottomPanelOwnedTabId) {
          if (body.debugAttachPaths.some((path: unknown) => typeof path !== "string" || !path)) {
            return json(response, 400, { error: "invalid owned BottomPanel attachment fixture" });
          }
          bottomPanelAttachmentPaths = [...new Set([...bottomPanelAttachmentPaths, ...body.debugAttachPaths as string[]])];
        } else {
          for (const path of body.debugAttachPaths) {
            if (typeof path === "string" && path && !attachmentMediaPendingPaths.includes(path)) {
              attachmentMediaPendingPaths.push(path);
            }
          }
        }
      }
      if (Array.isArray(body.debugRemoveAttachmentPaths)) {
        const removed = new Set(body.debugRemoveAttachmentPaths.filter((path: unknown): path is string => typeof path === "string"));
        attachmentMediaPendingPaths = attachmentMediaPendingPaths.filter((path) => !removed.has(path));
        bottomPanelAttachmentPaths = bottomPanelAttachmentPaths.filter((path) => !removed.has(path));
      }
      if (body.debugRendererFixture === "clear") {
        if (pendingAttachmentFindTarget) {
          pendingAlertText = null;
          pendingPromptResponseText = null;
          pendingAttachmentFindTarget = null;
        }
        attachmentMediaSessionPath = null;
        attachmentMediaImagePath = null;
        attachmentMediaVideoPath = null;
        bottomPanelImagePath = null;
        bottomPanelTerminalIds = [];
        bottomPanelActiveTerminal = null;
        bottomPanelFixtureUserVisible = false;
        chatOutputLifecycleActive = false;
        chatOutputThoughtExpanded = false;
        chatOutputJumpVisible = false;
        chatOutputDoomVisible = false;
        chatOutputHostVisible = false;
        chatOutputUpCount = 0;
        chatOutputAttachmentPath = null;
        chatOutputDiffPath = null;
        rightRailGitLifecycleActive = false;
        rightRailGitRefreshSequence = 0;
        rightRailGitDiffScope = "head";
        rightRailGitDiffVisible = false;
        rightRailModelCardsRefreshSequence = 0;
        rightRailEnvironmentRefreshSequence = 0;
        rightRailEnvironmentTraceReceipt = null;
        permissionFixtureAction = null;
        permissionDecision = null;
        providerActionFixture = null;
        providerActionDigest = null;
        providerActionRunId = null;
        buildRunCockpitFixtureActive = false;
        buildRunCockpitShowAllReceipts = false;
      } else if (body.debugRendererFixture && typeof body.debugRendererFixture === "object" && !Array.isArray(body.debugRendererFixture)) {
        const rendererFixture = body.debugRendererFixture as Record<string, unknown>;
        if (rendererFixture.id === "event-projections") {
          attachmentMediaSessionPath = typeof rendererFixture.attachmentPath === "string" ? rendererFixture.attachmentPath : null;
          attachmentMediaImagePath = typeof rendererFixture.imagePath === "string" ? rendererFixture.imagePath : null;
          attachmentMediaVideoPath = typeof rendererFixture.videoPath === "string" ? rendererFixture.videoPath : null;
          if (activeTab.tabId === bottomPanelOwnedTabId) {
            bottomPanelImagePath = attachmentMediaImagePath;
          }
        } else if (rendererFixture.id === "bottom-panel-lifecycle"
          && typeof rendererFixture.terminalId === "string" && /^[A-Za-z0-9._:-]+$/.test(rendererFixture.terminalId)) {
          bottomPanelTerminalIds = [rendererFixture.terminalId];
          bottomPanelActiveTerminal = "user";
          bottomPanelFixtureUserVisible = true;
        } else if (rendererFixture.id === "chat-output-lifecycle") {
          chatOutputLifecycleActive = rendererFixture.action !== "clear";
          chatOutputThoughtExpanded = false;
          chatOutputJumpVisible = false;
          chatOutputDoomVisible = rendererFixture.action !== "clear";
          chatOutputHostVisible = rendererFixture.action !== "clear";
          chatOutputUpCount = 0;
          chatOutputAttachmentPath = rendererFixture.action !== "clear" && typeof rendererFixture.attachmentPath === "string"
            ? rendererFixture.attachmentPath
            : null;
          chatOutputDiffPath = rendererFixture.action !== "clear" && typeof rendererFixture.diffPath === "string"
            ? rendererFixture.diffPath
            : null;
        } else if (rendererFixture.id === "build-run-cockpit-receipts") {
          buildRunCockpitFixtureActive = true;
          buildRunCockpitShowAllReceipts = false;
        } else if (rendererFixture.id === "right-rail-git-lifecycle") {
          rightRailGitLifecycleActive = rendererFixture.action !== "clear";
          rightRailGitRefreshSequence = 0;
          rightRailGitDiffScope = "head";
          rightRailGitDiffVisible = false;
          rightRailModelCardsRefreshSequence = 0;
          rightRailEnvironmentRefreshSequence = 0;
          rightRailEnvironmentTraceReceipt = null;
        } else if (rendererFixture.id === "permission-decision-lifecycle"
          && typeof rendererFixture.action === "string"
          && /^(?:modal-markers|modal-backdrop-deny|modal-deny|modal-allow|pill-allow|pill-always|pill-deny|clear)$/.test(rendererFixture.action)) {
          permissionFixtureAction = rendererFixture.action === "clear" ? null : rendererFixture.action;
          permissionDecision = null;
        } else if (rendererFixture.id === "provider-action-lifecycle"
          && typeof rendererFixture.action === "string") {
          if (rendererFixture.action === "clear") {
            providerActionFixture = null;
            providerActionDigest = null;
            providerActionRunId = null;
          } else {
            providerActionFixture = rendererFixture.action;
            providerActionDigest = null;
            providerActionRunId = null;
            if (providerActionFixture === "activity-ask-agent") activityOpen = true;
          }
        }
      }
      if (body.debugAgentPickerFixture === "owned-ready") agentPickerFixtureActive = true;
      if (body.debugAgentPickerFixture === "clear") {
        agentPickerFixtureActive = false;
        if (composerPicker === "agent") composerPicker = null;
      }
      if (body.debugHashItems === "owned") hashItemsFixtureActive = true;
      if (body.debugHashItems === "clear") hashItemsFixtureActive = false;
      if (body.openModal === "settings") settingsOpen = true;
      if (body.openModal === "palette") commandPaletteOpen = true;
      if (body.openModal === "activity") activityOpen = true;
      if (body.openModal === "help") helpModalOpen = true;
      if (body.openModal === "plugins") pluginsOpen = true;
      if (body.openModal === "buildPlanReview") buildPlanReviewOpen = buildPlanFixtureActive;
      if (body.openModal === "assets" || body.openModal === "connectorInbox" || body.openModal === "preview" || body.openModal === "workPreview" || body.openModal === "vault" || body.openModal === "pr") {
        ownedModalOpen = body.openModal === "workPreview" ? "preview" : body.openModal;
        if (body.openModal === "preview" || body.openModal === "workPreview") {
          previewCenterView = body.openModal === "workPreview" ? "work" : "file";
        }
        vaultWorkspaceModalOpen = body.openModal === "vault";
        if (body.openModal === "vault") vaultWorkspaceIntent = "overview";
      }
      if (body.openModal === "close") {
        settingsOpen = false;
        shellxagentRevealed = false;
        settingsConnectionRows = [];
        pendingSettingsConnectionDeleteId = null;
        dataDeleteDialogOpen = false;
        dataDeleteReceipt = null;
        resetConnectorDraft();
        pluginsOpen = false;
        pluginsKeyFormEntryId = null;
        pluginsKeyDraftValue = "";
        buildPlanReviewOpen = false;
        connectionEditorOpen = false;
        connectionEditorOwnedId = null;
        connectionEditorProviderScan = null;
        connectionSshKeyVaultRef = "";
        builtinDoc = null;
        ownedModalOpen = null;
        prApprovalChecked = false;
        prDraftActive = false;
        prTranscriptActive = false;
        prCreateBoundaryReceipt = null;
        for (const selector of Object.keys(prTextValues)) prTextValues[selector] = "";
        resetConnectorInboxManualRefreshReceipt();
        vaultWorkspaceModalOpen = false;
        vaultWorkspaceIntent = null;
        commandPaletteOpen = false;
        helpModalOpen = false;
        activityOpen = false;
        activityEvidenceFocused = null;
        agentCliSetupFixtureMode = "closed";
        goalPlanReviewFixtureMode = "closed";
        goalPlanReviewEditing = false;
        goalPlanReviewComment = "";
        agentCliStatusDialogProvider = null;
      }
      const debugClick = typeof body.debugClick === "string"
        ? body.debugClick
        : body.debugClick && typeof body.debugClick === "object" && !Array.isArray(body.debugClick)
          ? String((body.debugClick as Record<string, unknown>).selector ?? "")
          : "";
      const settingsTabClick = /^\[data-debug-id='settings-tab-(general|vault|connections|connectors|desktop|shellxagent|data|about)'\]$/.exec(debugClick)?.[1] ?? null;
      if (settingsTabClick) {
        settingsTab = settingsTabClick;
      }
      if (debugClick === "[data-debug-id='settings-tab-connections']") {
        settingsConnectionRows = structuredClone([...connectionPresets.values()]);
      }
      else if (debugClick === "[title='Read the shellX features overview']") builtinDoc = "Features";
      else if (debugClick === ".connections-header button[title='Add a new connection preset']") {
        connectionEditorOpen = true;
        connectionEditorProviderScan = null;
        connectionSshKeyVaultRef = "";
      }
      if (typeof body.vaultRequestCenterOpen === "boolean") {
        vaultRequestCenterOpen = body.vaultRequestCenterOpen;
        if (!vaultRequestCenterOpen) vaultPasswordGeneratorOpen = false;
      }
      if (typeof body.setupGuideDismissed === "boolean") setupGuideDismissed = body.setupGuideDismissed;
      return json(response, 200, { ok: true });
    }
    if (requestUrl.pathname === "/preview/work/state" && request.method === "GET") {
      const tabId = String(requestUrl.searchParams.get("tabId") ?? "");
      return json(response, 200, previewState?.tabId === tabId ? previewState : idlePreviewState(tabId));
    }
    if (requestUrl.pathname === "/preview/work/start" && request.method === "POST") {
      const body = await requestJson(request);
      const tabId = String(requestUrl.searchParams.get("tabId") ?? body.tabId ?? "");
      const cwd = typeof body.cwd === "string" ? body.cwd : "";
      if (!tabId || !cwd || body.kind !== "static" || body.entry !== "release-preview.html") {
        return json(response, 400, { error: "invalid owned Preview start fixture" });
      }
      previewStarts += 1;
      const url = `http://127.0.0.1:${candidateAddress().port}/preview-fixture/release-preview.html`;
      const now = Date.now();
      previewState = runningPreviewState(tabId, cwd, url, now);
      return json(response, 200, previewState);
    }
    if (requestUrl.pathname === "/preview/work/stop" && request.method === "POST") {
      const body = await requestJson(request);
      const tabId = String(requestUrl.searchParams.get("tabId") ?? body.tabId ?? "");
      if (!previewState || previewState.tabId !== tabId) return json(response, 200, idlePreviewState(tabId));
      previewState.status = "stopped";
      previewState.url = null;
      previewState.taskId = null;
      previewState.pid = null;
      previewState.error = null;
      previewState.updatedAtMs = Date.now();
      (previewState.logs as Array<Record<string, unknown>>).push({
        t: Date.now(),
        stream: "system",
        line: "preview stopped by shellX",
      });
      return json(response, 200, previewState);
    }
    if (request.url === "/audit" && request.method === "GET") {
      return json(response, 200, {
        bottomTab,
        settingsOpen,
        settingsTab,
        dataDeleteDialogOpen,
        dataDeleteReceipt,
        ownedUserData,
        setupGuideDismissed,
        agentCliSetupFixtureMode,
        agentCliStatusDialogProvider,
        ownedAgentCliVersion,
        ownedAgentCliScanCount,
        agentCliInstallConfirmationId,
        agentCliInstallPrepareCount,
        agentCliInstallCancelCount,
        agentCliInstallRunCount,
        pluginsOpen,
        pluginsFixtureActive,
        pluginsProductionFixtureActive,
        pluginsKeyFormEntryId,
        pluginsKeyDraftValue: pluginsProductionFixtureActive && pluginsKeyDraftValue ? "[redacted]" : pluginsKeyDraftValue,
        pluginsVaultKeys: [...pluginsVaultKeys].sort(),
        pluginsUnsafeMutationCount,
        buildPlanFixtureActive,
        buildPlanReviewOpen,
        buildPlanUnsafeMutationCount,
        shellxagentFixtureActive,
        shellxagentRevealed,
        shellxagentUnsafeMutationCount,
        shellxagentRotationCount,
        remoteCwdOpen,
        remoteCwdPath,
        remoteCwdDraft,
        remoteCwdUnsafeUseCount,
        remoteCwdIsolatedLaunchCount,
        remoteCwdOwnedUseLaunchCount,
        agentPickerFixtureActive,
        theme,
        persistedTheme,
        rightTab,
        goalState,
        goalLastClear,
        goalReviewModalOpen,
        goalPlanReviewFixtureMode,
        goalPlanReviewEditing,
        goalPlanReviewComment,
        goalPlanRejectArmed,
        goalProviderAction,
        goalProviderDigest,
        goalProviderRunId,
        buildRunCockpitFixtureActive,
        buildRunCockpitShowAllReceipts,
        buildRunState,
        buildRunReceipts,
        buildRunProviderAction,
        pendingAlertText,
        pendingConnectionDeleteId,
        pendingSettingsConnectionDeleteId,
        settingsConnectionRows,
        settingsConnectionsRefreshCount,
        agentRunsManualRefreshSequence,
        agentRunsManualRefreshGeneratedAtMs,
        tasksManualRefreshSequence,
        tasksCleanupMcpArmed,
        ownedBackgroundTasks,
        expandedBackgroundTaskIds: [...expandedBackgroundTaskIds],
        releaseTauriInvokeCount: releaseTauriInvokes.size,
        chatOutputLifecycleActive,
        chatOutputThoughtExpanded,
        chatOutputJumpVisible,
        chatOutputDoomVisible,
        chatOutputHostVisible,
        chatOutputUpCount,
        chatOutputAttachmentPath,
        chatOutputDiffPath,
        rightRailGitLifecycleActive,
        rightRailGitRefreshSequence,
        rightRailGitDiffScope,
        rightRailGitDiffVisible,
        rightRailModelCardsRefreshSequence,
        rightRailEnvironmentRefreshSequence,
        rightRailEnvironmentTraceReceipt,
        rightRailGitWriteCheckpointCount,
        rightRailGitWriteWorktreeCount,
        permissionFixtureAction,
        permissionDecision,
        providerActionFixture,
        providerActionDigest,
        providerActionRunId,
        activeTab,
        sessionTabIds: openSessionTabs.map((tab) => tab.tabId),
        sessionTabSessionIds: openSessionTabs.map((tab) => tab.sessionId ?? null),
        sessionTabTitles: openSessionTabs.map((tab) => tab.title ?? null),
        sessionDropdownOpen,
        sessionRenamingTabId,
        sessionRenameValue,
        sessionRailScrollLeft,
        sessionRailScrollWidth: sessionRailScrollWidth(),
        sessionRailClientWidth: SESSION_RAIL_CLIENT_WIDTH,
        bottomPanelAttachmentPaths,
        vaultKeyfileSelected,
        releaseNativePickerArmed: releaseNativePickerLease !== null,
        bottomPanelComposerPrompt: alwaysVisibleTextValues["[data-debug-id='composer-prompt']"],
        bottomPanelImagePath,
        bottomPanelTerminalIds,
        bottomPanelActiveTerminal,
        bottomPanelFixtureUserVisible,
        previewStatus: previewState?.status ?? null,
        previewUrl: previewState?.url ?? null,
        renderedPreviewStatus: renderedPreviewState?.status ?? null,
        renderedPreviewUrl: renderedPreviewState?.url ?? null,
        previewStarts,
        previewRefreshes,
        previewCenterView,
        previewFilePath,
        doctorScreenshotExists: doctorScreenshotPath ? existsSync(doctorScreenshotPath) : false,
        workPreviewKind,
        workPreviewViewport,
        workPreviewReloadSeq,
        workPreviewLogHeight,
        workPreviewLogHeightStored,
        browserRightTab,
        activeTaskId,
        browserTaskId,
        browserTaskTabId,
        browserTaskOwnerSessionId,
        browserTaskUrl,
        activeTaskStatus,
        browserDownloadFolder,
        browserDownloads,
        recorderIndex,
        currentWindow,
        browserWindowOpen,
        activityOpen,
        activityView,
        activityEvidenceFocused,
        composerPicker,
        keyboardHintOpen,
        vaultWorkspaceTab,
        vaultResourceFormTab,
        browserDisclosure,
        browserRightSidebarVisible,
        browserRightSidebarWidth,
        browserHomepageValue,
        browserHomepageStoredValue,
        browserColorMode,
        browserColorModeStoredValue,
        browserParallelAgents,
        browserProfileId,
        browserAutomationMode,
        browserPersonalLock,
        browserPersonalLockPinDraft,
        browserPersonalLockNotice,
        browserPersonalLockVerifierConfigured: browserPersonalLockVerifierDigest !== null,
        browserPersonalTabId,
        browserActiveHost,
        browserProfileAdModes: Object.fromEntries(browserProfileAdModes),
        browserShields,
        browserHistorySearch,
        browserHistoryDateFilter,
        browserHistoryScope,
        browserBookmarkManageMode,
        browserBookmarkDraftLabel,
        browserBookmarkDraftUrl,
        browserAddressValue,
        browserGoalValue,
        vaultRequestCenterOpen,
        vaultWorkspaceModalOpen,
        vaultWorkspaceIntent,
        vaultPasswordGeneratorOpen,
        vaultPasswordLowercase,
        vaultPasswordRevealed,
        vaultPasswordLength,
        ownedModalOpen,
        previewTarget,
        previewVideoPlaybackState,
        attachmentMediaPendingPaths,
        attachmentMediaSessionPath,
        attachmentMediaImagePath,
        attachmentMediaVideoPath,
        filesPaneSessionPath,
        filesPaneFolder,
        filesPaneSelected,
        activitySearchValue,
        connectorSearchValue,
        connectorDateValue,
        connectorFilter,
        connectorInboxManualRefreshSequence,
        connectorInboxManualRefreshCompletedAtMs,
        connectorInboxManualRefreshConnectorCount,
        connectorInboxManualRefreshEventCount,
        connectorInboxManualRefreshMaxEventMs,
        prTextValues,
        prApprovalChecked,
        prDraftActive,
        prTranscriptActive,
        releaseTestExternalEffectBoundary,
        prCreateBoundaryReceipt,
        artifactArchiveReceipt,
        hashItemsFixtureActive,
        commandPaletteOpen,
        commandPaletteInputValue,
        findSessionsFocused,
        connectionEditorOpen,
        connectionEditorOwnedId,
        connectionEditorProviderScan,
        connectionPresets: [...connectionPresets.values()],
        connectionTestResults: Object.fromEntries(connectionTestResults),
        connectionTransport,
        connectionRuntime,
        connectionSshKeyVaultRef,
        connectionVaultKeys: [...connectionVaultKeys].sort(),
        connectionDraftValues,
        connectorDraftOpen,
        connectorProvider,
        connectorEnabled,
        connectorDispatchMode,
        connectorTargetMode,
        connectorVaultKey,
        connectorAllowedIds,
        connectorsFixtureActive,
        connectorSecretValue,
        connectorFixedTabId,
        connectorSimConnectorId,
        connectorEditingId,
        connectorUnsafeMutationCount,
        connectorSimValues,
        builtinDoc,
        aboutExternalUrls,
        debugUpdateFixture,
        updateBannerAvailable,
        rightRailUpdateAvailable,
        aboutUpdateAvailable,
        updateBannerReceipt,
        rightRailUpdateReceipt,
        aboutUpdateReceipt,
        debugUiConnectionFixture,
        debugUiWebSocketActive,
        debugUiWebSocketGeneration,
        errorBoundaryOpen,
        errorBoundaryDocumentGeneration,
        rendererCrashEventCount: rendererCrashEvents.length,
        releaseTestVoiceRecording,
        releaseTestVoiceMode,
        pluginsTierExpanded,
        projectsExpanded,
        openChatsExpanded,
        pastChatsExpanded,
        ownedProjectDraft,
        ownedProjectRenaming,
        ownedProjectRenameValue,
        ownedProjectExpanded,
        ownedProjectDeleteDialog,
        alwaysVisibleTextValues,
        rightRailTextValues,
        inputClearCounts,
        publicSettings,
        taskToggleStates,
        taskToggleStorage,
        clickedSelectors,
        neutralFocusClicks,
      });
    }
    return json(response, 404, { error: "not found" });
  } catch (error) {
    return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const webdriver = createServer(async (request, response) => {
  try {
    const path = request.url ?? "";
    const prefix = `/session/${encodeURIComponent(sessionId)}`;
    if (!path.startsWith(prefix)) return webdriverError(response, 404, "invalid session id", "unknown fixture session");
    if (request.method === "GET" && path === `${prefix}/window`) {
      return webdriverValue(response, currentWindow);
    }
    if (request.method === "GET" && path === `${prefix}/window/handles`) {
      return webdriverValue(response, browserWindowOpen ? ["main-window", "browser-window"] : ["main-window"]);
    }
    if (request.method === "POST" && path === `${prefix}/window`) {
      const body = await requestJson(request);
      if (body.handle !== "main-window" && (body.handle !== "browser-window" || !browserWindowOpen)) {
        return webdriverError(response, 404, "no such window", "unknown fixture window");
      }
      currentWindow = String(body.handle);
      return webdriverValue(response, null);
    }
    if (request.method === "GET" && path === `${prefix}/title`) {
      return webdriverValue(response, currentWindow === "browser-window" ? "ShellX Browser" : "ShellX");
    }
    if (request.method === "GET" && path === `${prefix}/alert/text`) {
      if (!pendingAlertText) return webdriverError(response, 404, "no such alert", "fixture has no pending alert");
      return webdriverValue(response, pendingAlertText);
    }
    if (request.method === "POST" && path === `${prefix}/alert/text`) {
      if (!pendingAlertText || !pendingAttachmentFindTarget) {
        return webdriverError(response, 404, "no such alert", "fixture has no pending text prompt");
      }
      const body = await requestJson(request);
      if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 4_096 || body.text.includes("\0")) {
        return webdriverError(response, 400, "invalid argument", "fixture prompt response must be a bounded non-empty string");
      }
      pendingPromptResponseText = body.text;
      return webdriverValue(response, null);
    }
    if (request.method === "POST" && path === `${prefix}/alert/accept`) {
      if (!pendingAlertText) return webdriverError(response, 404, "no such alert", "fixture has no pending alert");
      pendingAlertText = null;
      if (pendingAttachmentFindTarget) {
        const target = pendingAttachmentFindTarget;
        const trimmed = pendingPromptResponseText?.trim() ?? "";
        pendingAttachmentFindTarget = null;
        pendingPromptResponseText = null;
        if (!trimmed) {
          return webdriverError(response, 400, "invalid argument", "owned attachment Find prompt has no response");
        }
        const prompt = alwaysVisibleTextValues["[data-debug-id='composer-prompt']"]!.trim();
        const inserted = `Find \"${trimmed}\" in the attached file. Report every relevant match with filename and context.`;
        alwaysVisibleTextValues["[data-debug-id='composer-prompt']"] = prompt ? `${prompt}\n\n${inserted}` : inserted;
        if (target === "board") {
          bottomTab = "Chat";
          ownedModalOpen = null;
        }
        return webdriverValue(response, null);
      }
      if (pendingConnectionDeleteId) {
        connectionPresets.delete(pendingConnectionDeleteId);
        settingsConnectionRows = settingsConnectionRows.filter((preset) => preset.id !== pendingConnectionDeleteId);
        pendingConnectionDeleteId = null;
        return webdriverValue(response, null);
      }
      if (!goalState || goalState.active !== true) {
        return webdriverError(response, 400, "unexpected alert open", "owned Goal is not active");
      }
      goalState.active = false;
      goalLastClear = {
        reason: "completed",
        objective: goalState.objective,
        clearedAtMs: Date.now(),
      };
      goalReviewModalOpen = false;
      return webdriverValue(response, null);
    }
    if (request.method === "DELETE" && path === `${prefix}/window`) {
      if (currentWindow === "browser-window") {
        browserWindowOpen = false;
        browserDisclosure = null;
      }
      currentWindow = "main-window";
      return webdriverValue(response, null);
    }
    if (request.method === "POST" && path === `${prefix}/execute/sync`) {
      const body = await requestJson(request);
      const script = typeof body.script === "string" ? body.script : "";
      const args = Array.isArray(body.args) ? body.args : [];
      if (script === "return window.localStorage.getItem(arguments[0]);" && args[0] === "shellX.settingsTab.v2") {
        return webdriverValue(response, settingsTab);
      }
      if (script === "return window.localStorage.getItem(arguments[0]);" && args[0] === "shellX.rightTab.v2") {
        return webdriverValue(response, rightTab);
      }
      if (script.includes("SHELLX_BOUNDED_ELEMENT_OBSERVATION") && typeof args[0] === "string" && Array.isArray(args[1])) {
        const selector = args[0];
        const requested = args[1].filter((field): field is string => typeof field === "string");
        const observation: Record<string, unknown> = {};
        if (selector === "[data-debug-id='header-theme-toggle']" && requested.includes("pressed")) {
          observation.pressed = theme === "bright";
        }
        const observedGeneralSetting = generalSettingForSelector(selector);
        if (observedGeneralSetting && requested.includes("pressed")) {
          observation.pressed = publicSettings[observedGeneralSetting.key] === observedGeneralSetting.value;
        }
        if (selector === "[aria-label='Chat font size in pixels']" && requested.includes("value")) {
          observation.value = String(publicSettings.chatFontPx);
        }
        if (Object.hasOwn(connectionDraftValues, selector) && requested.includes("value")) {
          observation.value = connectionDraftValues[selector];
        }
        const observedConnectionTransport = selector.match(/^\[data-debug-id='connection-transport-(local|wsl|ssh)'\]$/)?.[1];
        if (observedConnectionTransport && requested.includes("checked")) {
          observation.checked = connectionTransport === observedConnectionTransport;
        }
        if (selector === "[data-debug-id='connection-ssh-runtime-select']" && requested.includes("value")) {
          observation.value = connectionRuntime;
        }
        if (selector === "[data-debug-id='connection-ssh-key-select']" && requested.includes("value")) {
          observation.value = connectionSshKeyVaultRef;
        }
        if (selector === "[data-shellx-release-control='data-delete-receipt']"
          && requested.includes("title") && dataDeleteReceipt) {
          observation.title = `Data delete · key=${dataDeleteReceipt.key} · diskRemoved=${dataDeleteReceipt.diskRemoved} · localStorageCleared=${dataDeleteReceipt.localStorageCleared}`;
        }
        const observedConnectorProvider = selector.match(/^\[data-debug-id='surface-components-settings-connectorstab-3'\]\[data-provider-kind='(telegram|discord)'\]$/)?.[1];
        if (observedConnectorProvider && requested.includes("selected")) {
          observation.selected = connectorProvider === observedConnectorProvider;
        }
        const observedConnectorInboxFilter = selector.match(/^\[data-debug-id='surface-components-connectorinboxmodal-9'\]\[data-inbox='(all|telegram|discord)'\]$/)?.[1];
        if (observedConnectorInboxFilter && requested.includes("selected")) {
          observation.selected = connectorFilter === observedConnectorInboxFilter;
        }
        if (requested.includes("pressed")) {
          if (selector === "[aria-label='Connector receiver state'] > button:first-child") {
            observation.pressed = !connectorEnabled;
          } else if (selector === "[aria-label='Connector receiver state'] > button:last-child") {
            observation.pressed = connectorEnabled;
          } else if (selector === "[aria-label='Connector delivery mode'] > button:first-child") {
            observation.pressed = connectorDispatchMode === "inbox";
          } else if (selector === "[aria-label='Connector delivery mode'] > button:last-child") {
            observation.pressed = connectorDispatchMode === "autoPrompt";
          }
        }
        if (selector === "[id='connector-target']" && requested.includes("value")) {
          observation.value = connectorTargetMode;
        }
        if (selector === "[data-debug-id='surface-components-settings-connectorstab-11']" && requested.includes("value")) {
          observation.value = connectorFixedTabId;
        }
        if (selector === "[id='connector-sim-connector']" && requested.includes("value")) {
          observation.value = connectorSimConnectorId;
        }
        if (selector === "[id='connector-secret']" && requested.includes("nonempty")) {
          observation.nonempty = connectorSecretValue.length > 0;
        }
        if (selector === "[data-debug-id='surface-components-settings-connectorstab-21']" && requested.includes("nonempty")) {
          observation.nonempty = connectorVaultKey.length > 0;
        }
        if (selector === "[id='connector-allowed']" && requested.includes("nonempty")) {
          observation.nonempty = connectorAllowedIds.length > 0;
        }
        if (Object.hasOwn(connectorSimValues, selector) && requested.includes("nonempty")) {
          observation.nonempty = (connectorSimValues[selector] ?? "").length > 0;
        }
        if (selector === "[data-debug-id='left-project-rename-input']" && requested.includes("nonempty")) {
          observation.nonempty = ownedProjectRenameValue.length > 0;
        }
        if (selector === "[data-connectors-debug-fixture='owned-safe']" && requested.includes("mounted")) {
          observation.mounted = connectorsFixtureActive;
        }
        if (selector === "[data-debug-id='surface-components-prcreatemodal-8']" && requested.includes("checked")) {
          observation.checked = prApprovalChecked;
        }
        if (selector === "[data-release-pr-create-receipt='boundary']" && requested.includes("title")) {
          observation.title = prCreateBoundaryReceipt;
        }
        if (selector === "[aria-label='Download Grok session artifacts']" && requested.includes("title")) {
          observation.title = artifactArchiveReceipt
            ?? "Download this Grok session's artifacts (workspace + scratch) as a zip";
        }
        if (selector === ":is([title='Append the session transcript as an appendix'],[title='No transcript captured yet'])") {
          if (requested.includes("pressed")) observation.pressed = prTranscriptActive;
          if (requested.includes("disabled")) observation.disabled = !chatOutputLifecycleActive;
          if (requested.includes("title")) {
            observation.title = chatOutputLifecycleActive
              ? "Append the session transcript as an appendix"
              : "No transcript captured yet";
          }
        }
        if (selector === "[data-debug-id='surface-components-hashautocomplete-1']" && requested.includes("title")) {
          observation.title = "Issue #735: Owned autocomplete fixture";
        }
        if (selector === "[data-debug-id='composer-voice-chat']" && requested.includes("title")) {
          observation.title = releaseTestVoiceRecording
            ? "Recording 0.0s — click to stop, Esc to cancel"
            : "Voice chat — STT + spoken reply playback";
        }
        if (selector === "[data-release-update-receipt='banner']" && requested.includes("title")) {
          observation.title = updateBannerReceipt ?? "Update status";
        }
        if (selector === "[data-release-update-receipt='right-rail']" && requested.includes("title")) {
          observation.title = rightRailUpdateReceipt ?? "Update diagnostics";
        }
        if (selector === "[data-release-update-receipt='about']" && requested.includes("title")) {
          observation.title = aboutUpdateReceipt ?? "About and updates";
        }
        if (selector === "[data-debug-id='surface-lib-markdown-links-1']" && requested.includes("title")) {
          observation.title = "release-owned-preview.png";
        }
        if (selector === "[data-debug-id='tasks-agent-runs-refresh']" && requested.includes("title")) {
          observation.title = `Agent runs refresh receipt · sequence=${agentRunsManualRefreshSequence} · generatedAtMs=${agentRunsManualRefreshGeneratedAtMs ?? "none"}`;
        }
        if (selector === "[data-debug-id='surface-components-connectorinboxmodal-4']" && requested.includes("title")) {
          observation.title = `Connector inbox refresh receipt · sequence=${connectorInboxManualRefreshSequence} · completedAtMs=${connectorInboxManualRefreshCompletedAtMs ?? "none"} · connectors=${connectorInboxManualRefreshConnectorCount ?? "none"} · events=${connectorInboxManualRefreshEventCount ?? "none"} · maxEventMs=${connectorInboxManualRefreshMaxEventMs ?? "none"}`;
        }
        if (selector === "[data-debug-id='shellx-browser-toggle-right-sidebar']" && requested.includes("checked")) {
          observation.checked = browserRightSidebarVisible;
        }
        if (selector === "[data-debug-id='shellx-browser-toggle-right-sidebar-button']" && requested.includes("title")) {
          observation.title = "Hide right panel";
        }
        if (selector === "[data-debug-id='shellx-browser-show-right-sidebar-button']" && requested.includes("title")) {
          observation.title = "Show right panel";
        }
        if (selector === "[data-debug-id='shellx-browser-sidebar-resize']" && requested.includes("title")) {
          observation.title = `Resize right panel · width=${browserRightSidebarWidth}px · use Left/Right arrows`;
        }
        if (selector === "[data-debug-id='shellx-browser-evidence-record']" && requested.includes("title")) {
          observation.title = activeTaskStatus
            ? "Export a bounded, redacted attempt for the current task"
            : "Start or select a browser task first";
        }
        if (selector === "[data-debug-id='shellx-browser-evidence-refresh']" && requested.includes("title")) {
          observation.title = `Flight Recorder refresh receipt · sequence=${browserEvidenceManualRefreshSequence} · completedAtMs=${browserEvidenceManualRefreshCompletedAtMs ?? "none"}`;
        }
        if (requested.includes("disabled")) {
          if (selector === "[data-debug-id='surface-components-prcreatemodal-10']") {
            observation.disabled = !prApprovalChecked
              || !(prTextValues["[data-debug-id='pr-base-input']"] ?? "").trim()
              || !(prTextValues["[data-debug-id='pr-title-input']"] ?? "").trim();
          }
          else if (selector === "[aria-label='Download Grok session artifacts']") observation.disabled = false;
          else if (selector === "[data-debug-id='shellx-browser-agent-pause']") observation.disabled = !activeTaskStatus || activeTaskStatus === "paused";
          else if (selector === "[data-debug-id='shellx-browser-agent-resume']") observation.disabled = !activeTaskStatus || activeTaskStatus === "running";
          else if (selector === "[data-debug-id='shellx-browser-agent-takeover']") observation.disabled = !activeTaskStatus || activeTaskStatus === "userTakeover";
          else if (selector === "[data-debug-id='shellx-browser-agent-abort']") observation.disabled = !activeTaskStatus || activeTaskStatus === "aborted";
          else if (selector === "[data-debug-id='shellx-browser-complete']" || selector === "[data-debug-id='shellx-browser-block']") observation.disabled = !activeTaskStatus;
          else if (selector === "[data-debug-id='surface-components-settings-connectorstab-12']"
            || selector === "[data-debug-id='surface-components-settings-connectorstab-17']"
            || selector === "[data-connector-id='release-owned-connector-telegram'] [data-debug-id='surface-components-settings-connectorstab-18']"
            || selector === "[data-connector-id='release-owned-connector-telegram'] .settings-pill-danger") {
            observation.disabled = connectorsFixtureActive;
          }
          else if (selector === "[data-debug-id='tasks-agent-runs-refresh']"
            || selector === "[data-debug-id='surface-components-connectorinboxmodal-4']") observation.disabled = false;
          else if (selector === "[data-debug-id='shellx-browser-evidence-record']") observation.disabled = !activeTaskStatus;
          else if (selector === "[data-debug-id='shellx-browser-evidence-refresh']") observation.disabled = false;
          else if (selector === "[data-debug-id='shellx-browser-personal-lock-set-pin']") observation.disabled = browserPersonalLockPinDraft.trim().length < 4;
          else if (selector === "[data-debug-id='shellx-browser-personal-lock-overlay-unlock']") {
            observation.disabled = browserPersonalLock.authMode === "pinOnly"
              && browserPersonalLock.pinConfigured
              && !browserPersonalLockPinDraft.trim();
          }
        }
        const observedHistoryScope = selector.match(/^\[data-debug-id='shellx-browser-history-(user|agent)'\]$/)?.[1];
        if (observedHistoryScope && requested.includes("pressed")) {
          observation.pressed = browserHistoryScope === observedHistoryScope;
        }
        const observedBrowserRightTab = selector.match(/^\[data-debug-id='shellx-browser-right-tab-(chat|requests|actions|evidence|errors)'\]$/)?.[1];
        if (observedBrowserRightTab && requested.includes("selected")) {
          observation.selected = browserRightTab === observedBrowserRightTab;
        }
        const observedSettingsTab = SETTINGS_TAB_BY_SELECTOR[selector];
        if (observedSettingsTab && requested.includes("selected")) {
          observation.selected = settingsTab === observedSettingsTab;
        }
        const observedWorkPreviewKind = WORK_PREVIEW_KIND_BY_SELECTOR[selector];
        if (observedWorkPreviewKind && requested.includes("selected")) {
          observation.selected = workPreviewKind === observedWorkPreviewKind;
        }
        if (selector === "[data-debug-id='shellx-browser-bookmark-list-mode']" && requested.includes("pressed")) {
          observation.pressed = !browserBookmarkManageMode;
        }
        if (selector === "[data-debug-id='shellx-browser-bookmark-manager-toggle']" && requested.includes("pressed")) {
          observation.pressed = browserBookmarkManageMode;
        }
        if (selector === ".pr-modal .settings-pills > button:first-child" && requested.includes("pressed")) {
          observation.pressed = prDraftActive;
        }
        const observedTasksToggle = taskToggleStates[selector];
        if (observedTasksToggle && requested.includes("checked")) {
          observation.checked = observedTasksToggle.checked;
        }
        if (requested.includes("expanded")) {
          if (selector === ":is([title='Collapse tier'],[title='Expand tier'])") {
            observation.expanded = pluginsTierExpanded;
          } else if (selector === ":is([title='Collapse all projects'],[title='Expand all projects'])") {
            observation.expanded = projectsExpanded;
          } else if (selector === ":is([title='Hide open chats — drop here to unfile'],[title='Show open chats — drop here to unfile'])") {
            observation.expanded = openChatsExpanded;
          } else if (selector === "[data-debug-id='left-past-chats-toggle']") {
            observation.expanded = pastChatsExpanded;
          }
        }
        if ((selector === "[data-debug-id='surface-components-vaultpasswordgenerator-5']"
          || selector === "[data-debug-id='vault-password-generator-length']")
          && requested.includes("value")) {
          observation.value = String(vaultPasswordLength);
        }
        if (selector === "[data-debug-id='surface-components-vaultpasswordgenerator-11']"
          && requested.includes("checked")) {
          observation.checked = vaultPasswordLowercase;
        }
        if (selector === ":is([aria-label='Hide generated password'],[aria-label='Reveal generated password'])"
          && requested.includes("title")) {
          observation.title = vaultPasswordRevealed ? "Hide generated password" : "Reveal generated password";
        }
        if (requested.includes("value")) {
          if (Object.hasOwn(alwaysVisibleTextValues, selector)) {
            observation.value = alwaysVisibleTextValues[selector] ?? "";
          } else if (Object.hasOwn(rightRailTextValues, selector)) {
            observation.value = rightRailTextValues[selector] ?? "";
          } else if (Object.hasOwn(prTextValues, selector)) {
            observation.value = prTextValues[selector] ?? "";
          } else if (selector === "[data-debug-id='command-palette-input']") {
            observation.value = commandPaletteInputValue;
          } else if (selector === "[data-debug-id='activity-search']") {
            observation.value = activitySearchValue;
          } else if (selector === "[data-debug-id='connector-inbox-search-input']") {
            observation.value = connectorSearchValue;
          } else if (selector === "[data-debug-id='connector-inbox-date-input']") {
            observation.value = connectorDateValue;
          } else if (selector === "[data-debug-id='settings-browser-download-folder']"
            || selector === "[data-debug-id='shellx-browser-download-folder']") {
            observation.value = publicSettings.browserDownloadFolder;
          } else if (selector === "[data-debug-id='shellx-browser-homepage']") {
            observation.value = browserHomepageValue;
          } else if (selector === "[data-debug-id='shellx-browser-history-search']") {
            observation.value = browserHistorySearch;
          } else if (selector === "[data-debug-id='shellx-browser-history-date-filter']") {
            observation.value = browserHistoryDateFilter;
          } else if (selector === "[data-debug-id='shellx-browser-bookmark-draft-label']") {
            observation.value = browserBookmarkDraftLabel;
          } else if (selector === "[data-debug-id='shellx-browser-bookmark-draft-url']") {
            observation.value = browserBookmarkDraftUrl;
          } else if (selector === "[data-debug-id='shellx-browser-address']") {
            observation.value = browserAddressValue;
          } else if (selector === "[data-debug-id='shellx-browser-goal']") {
            observation.value = browserGoalValue;
          } else if (selector === "[data-debug-id='shellx-browser-parallel-agents']") {
            observation.value = browserParallelAgents;
          } else if (selector === "[data-debug-id='shellx-browser-profile-select']") {
            observation.value = browserProfileId;
          } else if (selector === "[data-debug-id='shellx-browser-color-mode']") {
            observation.value = browserColorMode;
          }
        }
        if (selector === "[data-debug-id='shellx-browser-homepage']" && requested.includes("title")) {
          observation.title = `Browser homepage state: storage=${browserHomepageStoredValue === null ? "default" : "custom"}`;
        }
        if (selector === "[data-debug-id='shellx-browser-color-mode']" && requested.includes("title")) {
          observation.title = `Browser color state: applied=${browserColorMode}; storage=${browserColorModeStoredValue === null ? "default" : "custom"}`;
        }
        if (selector === ".bottom-panel" && requested.includes("mounted")) {
          observation.mounted = bottomPanelFixtureUserVisible;
        }
        const observedAttachment = composerAttachmentTitle(selector);
        if (observedAttachment !== null && requested.includes("title")) {
          observation.title = observedAttachment;
        }
        if (selector === ".composer-attachment-chip" && requested.includes("title")) {
          observation.title = bottomPanelAttachmentPaths[0] ?? null;
        }
        if (selector === "[data-debug-id='surface-components-attachmentmediaboard-9']"
          && requested.includes("title")) {
          observation.title = attachmentMediaPendingPaths[0] ?? null;
        }
        if (selector === ".terminal-substrip > button.substrip-tab" && requested.includes("pressed")) {
          observation.pressed = bottomPanelActiveTerminal === "user";
        }
        const observedAcpTerminal = selector.match(/^\[title='ACP terminal ([A-Za-z0-9._:-]+)'\]$/);
        if (observedAcpTerminal && requested.includes("pressed")) {
          observation.pressed = bottomPanelActiveTerminal === observedAcpTerminal[1];
        }
        if (
          selector === "[placeholder='What should Grok change about this plan? (Ctrl+Enter to submit)']"
          && requested.includes("value")
        ) observation.value = goalPlanReviewComment;
        if (selector === "[aria-label='All sessions']" && requested.includes("expanded")) {
          observation.expanded = sessionDropdownOpen;
        }
        if (selector === "[data-debug-id='surface-components-taskspanel-3']" && requested.includes("title")) {
          observation.title = `Refresh background tasks — ${tasksManualRefreshSequence} manual refresh${tasksManualRefreshSequence === 1 ? "" : "es"} completed in this view`;
        }
        if (selector === "[data-debug-id='surface-components-mediapreview-1']") {
          if (requested.includes("pressed")) observation.pressed = previewVideoPlaybackState === "playing";
          if (requested.includes("title")) observation.title = `Video playback · state=${previewVideoPlaybackState}`;
        }
        if (selector === "[aria-label='Clean Host MCP children for this tab']") {
          const count = visibleHostMcpTasks().length;
          if (requested.includes("pressed")) observation.pressed = tasksCleanupMcpArmed;
          if (requested.includes("title")) {
            observation.title = tasksCleanupMcpArmed
              ? `Click again to clean ${count} Host MCP child process${count === 1 ? "" : "es"} for this tab`
              : `Clean ${count} Host MCP child process${count === 1 ? "" : "es"} for this tab`;
          }
        }
        if (selector === "[data-debug-id='surface-components-gitpane-1']" && requested.includes("title")) {
          observation.title = `Refresh repository status — ${rightRailGitRefreshSequence} manual refresh${rightRailGitRefreshSequence === 1 ? "" : "es"} completed in this view`;
        }
        const gitDiffScope = selector.match(/^\[data-debug-id='surface-components-gitpane-5'\]\[data-git-diff-scope='(head|working|staged|lastCommit)'\]$/)?.[1];
        if (gitDiffScope && requested.includes("selected")) {
          observation.selected = rightRailGitDiffScope === gitDiffScope;
        }
        if (selector === "[data-shellx-release-control='model-cards-refresh']" && requested.includes("title")) {
          observation.title = `Refresh model instruction cards — ${rightRailModelCardsRefreshSequence} manual refresh${rightRailModelCardsRefreshSequence === 1 ? "" : "es"} completed in this view`;
        }
        if (selector === "[data-debug-id='surface-components-rightrail-9']" && requested.includes("title")) {
          observation.title = `Refresh environment — ${rightRailEnvironmentRefreshSequence} manual refresh${rightRailEnvironmentRefreshSequence === 1 ? "" : "es"} completed in this view`;
        }
        if (selector === "[data-release-environment-control='trace']" && requested.includes("title")) {
          observation.title = rightRailEnvironmentTraceReceipt ?? "Owned fixture trace export stops before filesystem access.";
        }
        if (selector === "[data-shellx-release-control='connection-provider-scan-receipt']"
          && requested.includes("title") && connectionEditorProviderScan) {
          observation.title = `Provider scan · transport=local · providers=${connectionEditorProviderScan.length} · ready=${connectionEditorProviderScan.filter((provider) => provider.canRun === true).length}`;
        }
        const pickerTestReceiptLabel = selector.match(/^\[title='Use ([^']+)'\] \[data-shellx-release-control='connection-test-receipt'\]$/)?.[1];
        const pickerTestReceipt = pickerTestReceiptLabel
          ? [...connectionPresets.entries()].find(([, preset]) => preset.label === pickerTestReceiptLabel)
          : null;
        const connectionTestReceipt = pickerTestReceipt
          ? connectionTestResults.get(pickerTestReceipt[0])
          : selector === "[data-shellx-release-control='connection-test-receipt']" && connectionEditorOwnedId
            ? connectionTestResults.get(connectionEditorOwnedId)
            : null;
        if (connectionTestReceipt && requested.includes("title")) {
          observation.title = `Connection test · reachable=${connectionTestReceipt.reachable} · latencyMs=${connectionTestReceipt.latencyMs ?? "none"} · error=${connectionTestReceipt.error ? "present" : "none"}`;
        }
        if ((selector === ".provider-adapter-row[data-agent-cli-provider='grok']"
          || selector === ".agent-cli-setup-card[data-agent-cli-provider='grok']")
          && requested.includes("title") && ownedAgentCliVersion) {
          observation.title = `Agent CLI scan receipt: version ${ownedAgentCliVersion}`;
        }
        if (selector === "[data-debug-id='agent-cli-setup-confirm']"
          && requested.includes("title") && agentCliInstallConfirmationId) {
          observation.title = [
            "Agent CLI install confirmation receipt",
            `id=${agentCliInstallConfirmationId}`,
            "provider=codex-cli",
            "method=npm",
            "command=npm install -g @openai/codex",
          ].join(" · ");
        }
        if (selector === "[data-shellx-release-control='permission-decision-receipt']"
          && requested.includes("title") && permissionFixtureAction && permissionDecision) {
          observation.title = `Permission decision receipt — ${permissionFixtureAction} — ${permissionDecision}`;
        }
        if (selector === "[data-shellx-release-control='provider-action-receipt']"
          && requested.includes("title") && providerActionFixture && providerActionDigest) {
          observation.title = `Provider action receipt — ${providerActionFixture} — ${providerActionDigest}`;
        }
        if (selector === "[data-shellx-release-control='build-run-state-receipt']"
          && requested.includes("title") && buildRunState) {
          observation.title = `Build run state · ${buildRunState.status} · checkpoint=${Boolean(buildRunState.checkpointId)} · blocker=${Boolean(buildRunState.openBlocker)} · receipts=${buildRunReceipts.length}`;
        }
        if (selector === ":is([title='Show every receipt in this Build Mode run'],[title='Show latest receipts only'])") {
          if (requested.includes("pressed")) observation.pressed = buildRunCockpitShowAllReceipts;
          if (requested.includes("title")) {
            observation.title = buildRunCockpitShowAllReceipts
              ? "Show latest receipts only"
              : "Show every receipt in this Build Mode run";
          }
        }
        if (selector === "[data-shellx-release-control='build-receipt-ledger-state']" && requested.includes("title")) {
          observation.title = `Build receipt ledger · total=8 · visible=${buildRunCockpitShowAllReceipts ? 8 : 6} · mode=${buildRunCockpitShowAllReceipts ? "all" : "latest"}`;
        }
        if (selector === "[data-debug-id='tasks-filter-input']" && requested.includes("value")) {
          observation.value = rightRailTextValues[selector] ?? "";
        }
        if (selector === "[data-debug-id='surface-components-chatoutput-5']"
          && requested.includes("expanded")) {
          observation.expanded = chatOutputThoughtExpanded;
        }
        if (selector === ".preview-center-heading" && requested.includes("title")) {
          observation.title = previewFilePath ?? "";
        }
        if (selector === ".preview-modal.preview-modal-embedded" && requested.includes("title")) {
          if (!previewFilePath || !existsSync(previewFilePath)) observation.title = "File preview failed";
          else {
            const kind = previewFilePath.endsWith(".txt") ? "text" : previewFilePath.endsWith(".ts") ? "code" : "unknown";
            observation.title = `File preview ready · ${basename(previewFilePath)} · ${kind} · ${readFileSync(previewFilePath, "utf8").length} characters`;
          }
        }
        const observedTask = tasksPanelSelectorParts(selector);
        if (observedTask?.descendant === "[data-debug-id='surface-components-taskspanel-8']"
          && requested.includes("expanded")) {
          observation.expanded = expandedBackgroundTaskIds.has(observedTask.taskId);
        }
        if (selector === ".session-tabs-rail") {
          if (requested.includes("scrollLeft")) observation.scrollLeft = sessionRailScrollLeft;
          if (requested.includes("scrollWidth")) observation.scrollWidth = sessionRailScrollWidth();
          if (requested.includes("clientWidth")) observation.clientWidth = SESSION_RAIL_CLIENT_WIDTH;
        }
        const observedSessionTab = sessionTabSelectorParts(selector);
        if (observedSessionTab?.descendant === "[data-debug-id='session-rename-input']"
          && requested.includes("value")) {
          observation.value = sessionRenameValue;
        }
        const pluginsKeyControl = selector.match(/^\[data-marketplace-entry-id='(release-owned-installed-key|release-owned-uninstalled-key)'\] :is\(\[title='Cancel adding key \(clears input\)'\],\[title='Enter your API key inline'\]\)$/);
        if (pluginsKeyControl && requested.includes("expanded")) {
          observation.expanded = pluginsKeyFormEntryId === pluginsKeyControl[1];
        }
        if ((selector === "#mcp-key-form-release-owned-installed-key"
          || selector === "#mcp-key-form-release-owned-uninstalled-key") && requested.includes("title")) {
          observation.title = pluginsKeyDraftValue ? "Draft present" : "Draft empty";
        }
        if (selector === "[data-marketplace-entry-id='context7'] [data-debug-id='plugins-entry-toggle']"
          && requested.includes("checked")) {
          observation.checked = pluginsMarketplaceEntry("context7").enabled;
        }
        if ((selector === "[data-debug-id='surface-components-buildplanreviewmodal-4']"
          || selector === "[data-debug-id='surface-components-buildplanreviewmodal-5']")
          && requested.includes("disabled")) {
          observation.disabled = buildPlanFixtureActive;
        }
        if (selector === "[data-debug-id='surface-components-buildplanreviewmodal-4']"
          && requested.includes("title")) {
          observation.title = buildPlanRejectArmed
            ? "Confirm rejection and halt this Build Mode run"
            : "Reject this Build Mode plan";
        }
        if ((selector === "[data-debug-id='surface-components-goalplanreviewmodal-4']"
          || selector === "[data-debug-id='surface-components-goalplanreviewmodal-7']"
          || selector === "[data-debug-id='surface-components-goalplanreviewmodal-9']")
          && requested.includes("disabled")) {
          observation.disabled = goalPlanReviewFixtureMode !== "closed";
        }
        if (selector === "[data-debug-id='surface-components-goalplanreviewmodal-7']"
          && requested.includes("title")) {
          observation.title = goalPlanRejectArmed
            ? "Confirm rejection and clear this Goal plan"
            : "Reject this Goal plan";
        }
        if (selector === "[data-debug-id='surface-components-settings-shellxagenttab-1']"
          && requested.includes("pressed")) {
          observation.pressed = shellxagentRevealed;
        }
        if ((selector === "[data-debug-id='surface-components-settings-shellxagenttab-2']"
          || selector === "[data-debug-id='surface-components-settings-shellxagenttab-3']")
          && requested.includes("disabled")) {
          observation.disabled = shellxagentFixtureActive;
        }
        if (selector === "[data-debug-id='remote-cwd-input']" && requested.includes("value")) {
          observation.value = remoteCwdDraft;
        }
        if (selector === "[data-debug-id='remote-cwd-use']" && requested.includes("disabled")) {
          observation.disabled = fixtureNormalizePath(remoteCwdDraft) !== remoteCwdPath;
        }
        const exposureMatch = selector.match(/^\[data-debug-id='surface-components-rightrail-2'\]\[data-shellx-tool-exposure='(nativeFirst|hostBridge|hostFull|off)'\]$/);
        if (exposureMatch && requested.includes("pressed")) {
          observation.pressed = activeTab.shellxToolExposure === exposureMatch[1];
        }
        const activeShields = activeBrowserShields();
        if (selector === "[data-debug-id='shellx-browser-shields-global-enabled']" && requested.includes("checked")) {
          observation.checked = browserShields.enabled;
        }
        if (selector === "[data-debug-id='shellx-browser-site-shields-ad-trackers']" && requested.includes("value")) {
          observation.value = activeShields.effectiveAdTrackerMode;
        }
        if (selector === "[data-debug-id='surface-browser-components-browsershieldspanel-3']" && requested.includes("value")) {
          observation.value = activeShields.effectiveCookieMode;
        }
        if (selector === "[data-debug-id='surface-browser-components-browsershieldspanel-4']" && requested.includes("value")) {
          observation.value = activeShields.effectiveFingerprintingMode;
        }
        if (selector === "[data-debug-id='surface-browser-components-browsershieldspanel-5']" && requested.includes("checked")) {
          observation.checked = activeShields.httpsUpgradeEnabled;
        }
        if (selector === "[data-debug-id='shellx-browser-site-shields-script-blocking']" && requested.includes("checked")) {
          observation.checked = activeShields.scriptBlockingEnabled;
        }
        if (selector === "[data-debug-id='shellx-browser-site-shields-save']" && requested.includes("disabled")) {
          observation.disabled = browserActiveHost === null;
        }
        if (selector === "[data-debug-id='shellx-browser-site-shields-reset']" && requested.includes("disabled")) {
          observation.disabled = browserActiveHost === null || !activeShields.hasSiteOverride;
        }
        if (selector === ".work-preview-status" && requested.includes("title")) {
          observation.title = `Work preview state: status=${String(renderedPreviewState?.status ?? "idle")}; url=${typeof renderedPreviewState?.url === "string" ? "present" : "absent"}`;
        }
        if (selector === ".work-preview-doctor-card" && requested.includes("title") && workPreviewDiagnostic) {
          const status = workPreviewDiagnostic.cardClass.includes("work-preview-doctor-warning") ? "warning" : "passed";
          observation.title = `Preview Doctor state: status=${status}; ok=yes; http=${workPreviewDiagnostic.http.replace(/^HTTP\s+/, "")}; title=${workPreviewDiagnostic.title ? "present" : "absent"}; screenshot=${workPreviewDiagnostic.screenshotPath ? "captured" : workPreviewDiagnostic.screenshotError ? "unavailable" : "absent"}`;
        }
        if ((selector === "[id='preview-center-file-mode']" || selector === "[id='preview-center-work-mode']")
          && requested.includes("selected")) {
          observation.selected = previewCenterView === (selector.includes("file-mode") ? "file" : "work");
        }
        if ((selector === "[id='file-preview-mode-code']" || selector === "[id='file-preview-mode-safe-render']")
          && requested.includes("selected")) {
          observation.selected = filePreviewHtmlMode === (selector.includes("safe-render") ? "safe" : "code");
        }
        if (selector === ".preview-center-body" && requested.includes("title")) {
          observation.title = `Preview Center state: mode=${previewCenterView}; file=${previewFilePath ? "present" : "absent"}; work=${renderedPreviewState?.status === "running" ? "present" : "absent"}`;
        }
        if (selector === ".preview-body-html" && requested.includes("title")) {
          const content = previewFilePath && existsSync(previewFilePath)
            && readFileSync(previewFilePath, "utf8").length > 0 ? "present" : "absent";
          observation.title = `File preview HTML state: mode=${filePreviewHtmlMode}; load=ready; content=${content}; frame=${filePreviewHtmlMode === "safe" ? "present" : "absent"}`;
        }
        if (selector === ".preview-html-safe-state" && requested.includes("title")) {
          const content = previewFilePath && existsSync(previewFilePath)
            && readFileSync(previewFilePath, "utf8").length > 0 ? "present" : "absent";
          observation.title = `Safe HTML render: content=${content}; sandbox=locked; referrer=no-referrer; csp=locked; scripts=stripped`;
        }
        const viewport = selector.match(/^\[id='work-preview-viewport-(phone|tablet|desktop)'\]$/)?.[1];
        if (viewport && requested.includes("selected")) observation.selected = workPreviewViewport === viewport;
        if (selector === ".work-preview-stage-canvas" && requested.includes("title")) {
          observation.title = `Work preview stage: viewport=${workPreviewViewport}; frame=${renderedPreviewState?.status === "running" ? "present" : "absent"}; reload=${workPreviewReloadSeq}`;
        }
        if (selector === ".work-preview-log" && requested.includes("title")) {
          observation.title = `Work preview log: height=${workPreviewLogHeight}; storage=${workPreviewLogHeight === 260 ? "default" : "custom"}`;
        }
        if (selector === "[role='dialog'][aria-label='Attachment and media board']" && requested.includes("title")) {
          const assets = Number(attachmentMediaImagePath !== null) + Number(attachmentMediaVideoPath !== null);
          observation.title = `Attachment board state: pending=${attachmentMediaPendingPaths.length}; session=${attachmentMediaSessionPath ? 1 : 0}; assets=${assets}; images=${attachmentMediaImagePath ? 1 : 0}; videos=${attachmentMediaVideoPath ? 1 : 0}`;
        }
        const adModeMatch = selector.match(/^\[data-debug-id='shellx-browser-ad-mode-(default|balanced|strict|off)'\]$/);
        if (adModeMatch) {
          const mode = adModeMatch[1];
          const override = browserProfileAdModes.get(browserProfileId) ?? null;
          if (requested.includes("pressed")) {
            observation.pressed = mode === "default" ? override === null : override === mode;
          }
          if (requested.includes("disabled")) {
            observation.disabled = mode === "default" && override === null;
          }
        }
        return webdriverValue(response, {
          present: selectorDisplayed(selector),
          visible: selectorDisplayed(selector),
          observation,
        });
      }
      if (script.includes("SHELLX_THEME_STATE")) {
        return webdriverValue(response, {
          pressed: theme === "bright" ? "true" : "false",
          theme,
          persistedTheme,
        });
      }
      if (script.includes("SHELLX_BOTTOM_PANEL_COMPOSER_STATE")) {
        return webdriverValue(response, {
          prompt: alwaysVisibleTextValues["[data-debug-id='composer-prompt']"],
          attachmentPaths: [...bottomPanelAttachmentPaths],
          slashRows: alwaysVisibleTextValues["[data-debug-id='composer-prompt']"] === "/comm"
            ? ["/commands Show ShellX slash commands"]
            : [],
        });
      }
      if (script.includes("SHELLX_BOTTOM_PANEL_TERMINAL_STATE")) {
        return webdriverValue(response, {
          mounted: false,
          ids: [...bottomPanelTerminalIds],
          active: bottomPanelActiveTerminal,
          fixtureUserVisible: bottomPanelFixtureUserVisible,
        });
      }
      if (script.includes("SHELLX_OWNED_INPUT_STATE") && typeof args[0] === "string") {
        if (args[0] === "[data-debug-id='activity-search']") {
          return webdriverValue(response, { value: activitySearchValue });
        }
        if (args[0] === "[data-debug-id='connector-inbox-search-input']") {
          return webdriverValue(response, { value: connectorSearchValue });
        }
        if (args[0] === "[data-debug-id='connector-inbox-date-input']") {
          return webdriverValue(response, { value: connectorDateValue });
        }
        if (Object.hasOwn(prTextValues, args[0])) {
          return webdriverValue(response, { value: prTextValues[args[0]] });
        }
        if (Object.hasOwn(rightRailTextValues, args[0])) {
          return webdriverValue(response, { value: rightRailTextValues[args[0]] });
        }
        if (args[0] === "[data-debug-id='command-palette-input']") {
          return webdriverValue(response, { value: commandPaletteInputValue });
        }
        if (Object.hasOwn(alwaysVisibleTextValues, args[0])) {
          return webdriverValue(response, { value: alwaysVisibleTextValues[args[0]] });
        }
        if (args[0] === "[data-debug-id='settings-browser-download-folder']") {
          return webdriverValue(response, { value: publicSettings.browserDownloadFolder });
        }
        if (args[0] === "[data-debug-id='shellx-browser-download-folder']") {
          return webdriverValue(response, { value: publicSettings.browserDownloadFolder });
        }
        if (args[0] === "[data-debug-id='shellx-browser-homepage']") {
          return webdriverValue(response, { value: browserHomepageValue });
        }
        if (args[0] === "[data-debug-id='shellx-browser-history-search']") {
          return webdriverValue(response, { value: browserHistorySearch });
        }
        if (args[0] === "[data-debug-id='shellx-browser-bookmark-draft-label']") {
          return webdriverValue(response, { value: browserBookmarkDraftLabel });
        }
        if (args[0] === "[data-debug-id='shellx-browser-bookmark-draft-url']") {
          return webdriverValue(response, { value: browserBookmarkDraftUrl });
        }
        if (args[0] === "[data-debug-id='shellx-browser-address']") {
          return webdriverValue(response, { value: browserAddressValue });
        }
        if (args[0] === "[data-debug-id='shellx-browser-goal']") {
          return webdriverValue(response, { value: browserGoalValue });
        }
      }
      if (script.includes("SHELLX_SAFE_FAMILY_PROJECT_STATE")) {
        return webdriverValue(response, {
          rowPresent: ownedProjectDraft,
          expanded: ownedProjectDraft && !ownedProjectRenaming ? ownedProjectExpanded : null,
          mainExpanded: ownedProjectDraft && !ownedProjectRenaming ? ownedProjectExpanded : null,
          dialogPresent: ownedProjectDeleteDialog,
        });
      }
      if (script.includes("SHELLX_VAULT_PASSWORD_GENERATOR_LOCAL_STATE") && typeof args[0] === "string") {
        if (
          args[0] === "[data-debug-id='surface-components-vaultpasswordgenerator-5']"
          || args[0] === "[data-debug-id='vault-password-generator-length']"
        ) {
          return webdriverValue(response, { checked: null, revealed: false, length: vaultPasswordLength });
        }
        if (args[0] === "[data-debug-id='surface-components-vaultpasswordgenerator-11']") {
          return webdriverValue(response, { checked: vaultPasswordLowercase, revealed: false, length: null });
        }
        if (args[0] === ":is([aria-label='Hide generated password'],[aria-label='Reveal generated password'])") {
          return webdriverValue(response, { checked: null, revealed: vaultPasswordRevealed, length: null });
        }
      }
      return webdriverError(response, 400, "javascript error", "unsupported fixture script");
    }
    if (request.method === "POST" && path === `${prefix}/element`) {
      const body = await requestJson(request);
      const selector = typeof body.value === "string" ? body.value : "";
      if (selectorDisplayed(selector)) return webdriverValue(response, element(selector));
      return webdriverError(response, 404, "no such element", `fixture does not expose ${selector}`);
    }
    const displayed = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/displayed$`));
    if (request.method === "GET" && displayed) {
      return webdriverValue(response, selectorDisplayed(elementSelector(displayed[1]!)));
    }
    const rect = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/rect$`));
    if (request.method === "GET" && rect) {
      const selector = elementSelector(rect[1]!);
      if (!selectorDisplayed(selector)) {
        return webdriverError(response, 404, "stale element reference", "fixture element has no visible rect");
      }
      pendingPointerSelector = selector;
      return webdriverValue(response, { x: 0, y: 0, width: 1200, height: 800 });
    }
    const cleared = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/clear$`));
    if (request.method === "POST" && cleared) {
      const selector = elementSelector(cleared[1]!);
      if (!selectorDisplayed(selector)) {
        return webdriverError(response, 404, "stale element reference", "fixture element is not clearable");
      }
      const leftRailInput = leftRailLifecycle && (
        selector.includes("[placeholder='Chat title']")
        || selector.includes("[data-debug-id='left-chat-rename-input']")
      );
      const renameInput = sessionTabSelectorParts(selector);
      const isSessionRenameInput = renameInput?.descendant === "[data-debug-id='session-rename-input']"
        && renameInput.tabId === sessionRenamingTabId;
      if (!Object.hasOwn(inputClearCounts, selector) && !leftRailInput && !isSessionRenameInput) {
        return webdriverError(response, 400, "invalid element state", "fixture element is not an input");
      }
      focusedSelector = selector;
      if (leftRailInput) leftRailRenameValue = "";
      else if (selector === "[data-debug-id='activity-search']") activitySearchValue = "";
      else if (selector === "[data-debug-id='plugins-vault-key-input']"
        || selector === "[data-marketplace-entry-id='github'] [data-debug-id='plugins-vault-key-input']") pluginsKeyDraftValue = "";
      else if (selector === "[data-debug-id='remote-cwd-input']") remoteCwdDraft = "";
      else if (selector === "[data-debug-id='connector-inbox-search-input']") connectorSearchValue = "";
      else if (selector === "[data-debug-id='connector-inbox-date-input']") connectorDateValue = "";
      else if (Object.hasOwn(prTextValues, selector)) prTextValues[selector] = "";
      else if (selector === "[data-debug-id='command-palette-input']") commandPaletteInputValue = "";
      else if (
        selector === "[data-debug-id='settings-browser-download-folder']"
        || selector === "[data-debug-id='shellx-browser-download-folder']"
      ) publicSettings.browserDownloadFolder = "";
      else if (selector === "[data-debug-id='shellx-browser-homepage']") {
        browserHomepageValue = "";
        browserHomepageStoredValue = null;
      }
      else if (selector === "[data-debug-id='shellx-browser-history-search']") browserHistorySearch = "";
      else if (selector === "[data-debug-id='shellx-browser-bookmark-draft-label']") browserBookmarkDraftLabel = "";
      else if (selector === "[data-debug-id='shellx-browser-bookmark-draft-url']") browserBookmarkDraftUrl = "";
      else if (selector === "[data-debug-id='shellx-browser-address']") browserAddressValue = "";
      else if (selector === "[data-debug-id='shellx-browser-goal']") browserGoalValue = "";
      else if (
        selector === "[data-debug-id='shellx-browser-personal-lock-pin']"
        || selector === "[data-debug-id='shellx-browser-personal-lock-overlay-pin']"
      ) browserPersonalLockPinDraft = "";
      else if (Object.hasOwn(connectionDraftValues, selector)) connectionDraftValues[selector] = "";
      else if (selector === "[data-debug-id='left-project-rename-input']") ownedProjectRenameValue = "";
      else if (isSessionRenameInput) sessionRenameValue = "";
      else if (selector === "[data-debug-id='surface-components-settings-connectorstab-21']") connectorVaultKey = "";
      else if (selector === "[id='connector-secret']") connectorSecretValue = "";
      else if (selector === "[id='connector-allowed']") connectorAllowedIds = "";
      else if (Object.hasOwn(connectorSimValues, selector)) connectorSimValues[selector] = "";
      else if (selector === "[placeholder='What should Grok change about this plan? (Ctrl+Enter to submit)']") {
        goalPlanReviewComment = "";
      }
      else if (Object.hasOwn(alwaysVisibleTextValues, selector)) {
        alwaysVisibleTextValues[selector] = "";
        if (selector === "[data-debug-id='find-sessions-input']") {
          findSessionsFocused = true;
          findOpenRowSelected = false;
          findDiskRowSelected = false;
        }
      }
      else rightRailTextValues[selector] = "";
      inputClearCounts[selector] = (inputClearCounts[selector] ?? 0) + 1;
      focusedSelector = selector;
      return webdriverValue(response, null);
    }
    const valued = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/value$`));
    if (request.method === "POST" && valued) {
      const selector = elementSelector(valued[1]!);
      if (!selectorDisplayed(selector)) {
        return webdriverError(response, 404, "stale element reference", "fixture element is not writable");
      }
      const body = await requestJson(request);
      if (selector === "[data-debug-id='connection-ssh-runtime-select']" && typeof body.text === "string") {
        const runtimes: Record<string, string> = {
          "Linux, macOS, or WSL SSH server": "posix",
          "Windows OpenSSH, run Windows agents": "windows",
          "Windows OpenSSH, run agents in WSL": "windows_wsl",
        };
        const next = runtimes[body.text];
        if (!next) return webdriverError(response, 400, "invalid argument", "fixture connection runtime option is invalid");
        connectionRuntime = next;
        return webdriverValue(response, null);
      }
      if (selector === "[data-debug-id='connection-ssh-key-select']" && typeof body.text === "string") {
        if (body.text === "(use ssh-agent / ssh-config default)") {
          connectionSshKeyVaultRef = "";
          return webdriverValue(response, null);
        }
        if (!connectionVaultKeys.has(body.text)) {
          return webdriverError(response, 400, "invalid argument", "fixture Connection Vault-key option is invalid");
        }
        connectionSshKeyVaultRef = body.text;
        return webdriverValue(response, null);
      }
      if (selector === "[id='connector-target']" && typeof body.text === "string") {
        const targets: Record<string, string> = {
          "Active shellX tab": "activeTab",
          "Fixed tab id": "fixedTab",
        };
        const next = targets[body.text];
        if (!next) return webdriverError(response, 400, "invalid argument", "fixture connector target option is invalid");
        connectorTargetMode = next;
        if (next === "activeTab") connectorFixedTabId = "";
        return webdriverValue(response, null);
      }
      if (selector === "[data-debug-id='surface-components-settings-connectorstab-11']" && typeof body.text === "string") {
        const targets: Record<string, string> = {
          "Choose live session": "",
          "1 · Release owned connector session · local · idle · release-owne": "release-owned-connector-tab",
        };
        if (!Object.hasOwn(targets, body.text)) {
          return webdriverError(response, 400, "invalid argument", "fixture connector session option is invalid");
        }
        connectorFixedTabId = targets[body.text]!;
        return webdriverValue(response, null);
      }
      if (selector === "[id='connector-sim-connector']" && typeof body.text === "string") {
        const connectors: Record<string, string> = {
          "Release owned Telegram · Telegram": "release-owned-connector-telegram",
          "Release owned Discord · Discord": "release-owned-connector-discord",
        };
        const next = connectors[body.text];
        if (!next) return webdriverError(response, 400, "invalid argument", "fixture simulator connector option is invalid");
        connectorSimConnectorId = next;
        return webdriverValue(response, null);
      }
      if (selector === "[aria-label='Chat font size in pixels']" && typeof body.text === "string") {
        const next = Number(body.text);
        if (!Number.isSafeInteger(next) || next < 12 || next > 26) {
          return webdriverError(response, 400, "invalid argument", "fixture font-size value is invalid");
        }
        publicSettings.chatFontPx = next;
        return webdriverValue(response, null);
      }
      if (selector === "[data-debug-id='shellx-browser-color-mode']" && typeof body.text === "string") {
        const next = body.text.toLowerCase();
        if (next !== "system" && next !== "light" && next !== "dark") {
          return webdriverError(response, 400, "invalid argument", "fixture color-mode option is invalid");
        }
        browserColorMode = next;
        browserColorModeStoredValue = next === "system" ? null : next;
        return webdriverValue(response, null);
      }
      if (selector === "[data-debug-id='shellx-browser-parallel-agents']" && typeof body.text === "string") {
        const next = body.text === "Auto" ? "auto" : body.text;
        if (!["auto", "1", "2", "3", "4"].includes(next)) {
          return webdriverError(response, 400, "invalid argument", "fixture parallel-agent option is invalid");
        }
        browserParallelAgents = next;
        return webdriverValue(response, null);
      }
      if (selector === "[data-debug-id='shellx-browser-profile-select']" && typeof body.text === "string") {
        const profiles: Record<string, string> = {
          Personal: "personal",
          "Agent Work · default": "agent-work",
          "Task Disposable · no cookies": "task-disposable",
        };
        const next = profiles[body.text];
        if (!next) return webdriverError(response, 400, "invalid argument", "fixture Browser profile option is invalid");
        browserProfileId = next;
        return webdriverValue(response, null);
      }
      if (selector === "[data-debug-id='shellx-browser-personal-lock-timeout']" && typeof body.text === "string") {
        const next = Number(body.text.match(/^\d+/)?.[0]);
        if (![5, 15, 30, 60].includes(next)) {
          return webdriverError(response, 400, "invalid argument", "fixture Personal Lock timeout is invalid");
        }
        browserPersonalLock.timeoutMinutes = next;
        return webdriverValue(response, null);
      }
      if (selector === "[data-debug-id='shellx-browser-personal-lock-auth-mode']" && typeof body.text === "string") {
        const next = body.text === "Session PIN"
          ? "pinOnly"
          : body.text === "Device auth preferred" ? "deviceAuthPreferred" : null;
        if (!next) return webdriverError(response, 400, "invalid argument", "fixture Personal Lock auth mode is invalid");
        browserPersonalLock.authMode = next;
        return webdriverValue(response, null);
      }
      if (selector === "[data-debug-id='shellx-browser-site-shields-ad-trackers']" && typeof body.text === "string") {
        const modes: Record<string, FixtureSiteShields["adTrackerMode"]> = { Balanced: "balanced", Strict: "strict", Off: "off" };
        const next = modes[body.text];
        if (!next) return webdriverError(response, 400, "invalid argument", "fixture ad-tracker mode is invalid");
        saveBrowserSiteOverride({ adTrackerMode: next });
        return webdriverValue(response, null);
      }
      if (selector === "[data-debug-id='surface-browser-components-browsershieldspanel-3']" && typeof body.text === "string") {
        const modes: Record<string, FixtureSiteShields["cookieMode"]> = {
          "Block third-party": "blockThirdParty",
          "Allow all": "allowAll",
          "Block all": "blockAll",
        };
        const next = modes[body.text];
        if (!next) return webdriverError(response, 400, "invalid argument", "fixture cookie mode is invalid");
        saveBrowserSiteOverride({ cookieMode: next });
        return webdriverValue(response, null);
      }
      if (selector === "[data-debug-id='surface-browser-components-browsershieldspanel-4']" && typeof body.text === "string") {
        const modes: Record<string, FixtureSiteShields["fingerprintingMode"]> = { Compatibility: "compatibility", Strict: "strict" };
        const next = modes[body.text];
        if (!next) return webdriverError(response, 400, "invalid argument", "fixture fingerprinting mode is invalid");
        saveBrowserSiteOverride({ fingerprintingMode: next });
        return webdriverValue(response, null);
      }
      if (selector === "[data-debug-id='shellx-browser-history-date-filter']" && typeof body.text === "string") {
        const options: Record<string, string> = {
          "All dates": "all",
          Today: "today",
          Yesterday: "yesterday",
          "Last 7 days": "last7",
        };
        const next = options[body.text];
        if (!next) return webdriverError(response, 400, "invalid argument", "fixture history date option is invalid");
        browserHistoryDateFilter = next;
        return webdriverValue(response, null);
      }
      const leftRailInput = leftRailLifecycle && (
        selector.includes("[placeholder='Chat title']")
        || selector.includes("[data-debug-id='left-chat-rename-input']")
      );
      const renameInput = sessionTabSelectorParts(selector);
      const isSessionRenameInput = renameInput?.descendant === "[data-debug-id='session-rename-input']"
        && renameInput.tabId === sessionRenamingTabId;
      if ((!Object.hasOwn(inputClearCounts, selector) && !leftRailInput && !isSessionRenameInput) || typeof body.text !== "string") {
        return webdriverError(response, 400, "invalid argument", "fixture value request is invalid");
      }
      if (leftRailInput) leftRailRenameValue += body.text;
      else if (selector === "[data-debug-id='activity-search']") activitySearchValue += body.text;
      else if (selector === "[data-debug-id='plugins-vault-key-input']"
        || selector === "[data-marketplace-entry-id='github'] [data-debug-id='plugins-vault-key-input']") pluginsKeyDraftValue += body.text;
      else if (selector === "[data-debug-id='remote-cwd-input']") remoteCwdDraft += body.text;
      else if (selector === "[data-debug-id='connector-inbox-search-input']") connectorSearchValue += body.text;
      else if (selector === "[data-debug-id='connector-inbox-date-input']") connectorDateValue += body.text;
      else if (Object.hasOwn(prTextValues, selector)) prTextValues[selector] += body.text;
      else if (selector === "[data-debug-id='command-palette-input']") commandPaletteInputValue += body.text;
      else if (
        selector === "[data-debug-id='settings-browser-download-folder']"
        || selector === "[data-debug-id='shellx-browser-download-folder']"
      ) {
        publicSettings.browserDownloadFolder += body.text;
      }
      else if (selector === "[data-debug-id='shellx-browser-homepage']") {
        browserHomepageValue += body.text;
        const normalized = browserHomepageValue.trim() || "https://example.com/";
        browserHomepageStoredValue = normalized === "https://example.com/" ? null : normalized;
      }
      else if (selector === "[data-debug-id='shellx-browser-history-search']") browserHistorySearch += body.text;
      else if (selector === "[data-debug-id='shellx-browser-bookmark-draft-label']") browserBookmarkDraftLabel += body.text;
      else if (selector === "[data-debug-id='shellx-browser-bookmark-draft-url']") browserBookmarkDraftUrl += body.text;
      else if (selector === "[data-debug-id='shellx-browser-address']") browserAddressValue += body.text;
      else if (selector === "[data-debug-id='shellx-browser-goal']") browserGoalValue += body.text;
      else if (
        selector === "[data-debug-id='shellx-browser-personal-lock-pin']"
        || selector === "[data-debug-id='shellx-browser-personal-lock-overlay-pin']"
      ) browserPersonalLockPinDraft += body.text;
      else if (Object.hasOwn(connectionDraftValues, selector)) connectionDraftValues[selector] += body.text;
      else if (selector === "[data-debug-id='left-project-rename-input']") ownedProjectRenameValue += body.text;
      else if (isSessionRenameInput) sessionRenameValue += body.text;
      else if (selector === "[data-debug-id='surface-components-settings-connectorstab-21']") connectorVaultKey += body.text;
      else if (selector === "[id='connector-secret']") connectorSecretValue += body.text;
      else if (selector === "[id='connector-allowed']") connectorAllowedIds += body.text;
      else if (Object.hasOwn(connectorSimValues, selector)) connectorSimValues[selector] += body.text;
      else if (selector === "[placeholder='What should Grok change about this plan? (Ctrl+Enter to submit)']") {
        goalPlanReviewComment += body.text;
      }
      else if (Object.hasOwn(alwaysVisibleTextValues, selector)) {
        alwaysVisibleTextValues[selector] = `${alwaysVisibleTextValues[selector] ?? ""}${body.text}`;
        if (selector === "[data-debug-id='find-sessions-input']") findSessionsFocused = true;
      }
      else rightRailTextValues[selector] = `${rightRailTextValues[selector] ?? ""}${body.text}`;
      focusedSelector = selector;
      return webdriverValue(response, null);
    }
    if (request.method === "POST" && path === `${prefix}/actions`) {
      const body = await requestJson(request);
      const sources = Array.isArray(body.actions) ? body.actions : [];
      let key: string | null = null;
      const keyValues: string[] = [];
      let pointerDown = false;
      let pointerButton: number | null = null;
      for (const source of sources) {
        if (!source || typeof source !== "object") continue;
        const actions = (source as Record<string, unknown>).actions;
        if (!Array.isArray(actions)) continue;
        for (const action of actions) {
          if (!action || typeof action !== "object") continue;
          const row = action as Record<string, unknown>;
          if (row.type === "keyDown" && typeof row.value === "string") {
            key = row.value;
            keyValues.push(row.value);
          }
          if (row.type === "pointerDown") {
            pointerDown = true;
            pointerButton = typeof row.button === "number" ? row.button : null;
          }
        }
      }
      if (pointerDown && pendingPointerSelector) {
        if (leftRailLifecycle && pointerButton === 2) {
          openLeftRailContextMenu(pendingPointerSelector);
        } else {
          closeModalBackdrop(pendingPointerSelector);
        }
        pendingPointerSelector = null;
        return webdriverValue(response, null);
      }
      if (keyValues.includes("u") && (keyValues.includes("\uE009") || keyValues.includes("\uE03D"))) {
        bottomPanelAttachmentPaths = [consumeReleaseNativePicker("file")];
        return webdriverValue(response, null);
      }
      if (leftRailLifecycle && (focusedSelector === "[data-debug-id='left-project-rename-input']"
        || focusedSelector?.includes("[placeholder='Chat title']")
        || focusedSelector?.includes("[data-debug-id='left-chat-rename-input']"))) {
        if (key !== "\uE006") return webdriverError(response, 400, "invalid argument", "left-rail fixture only accepts Return");
        commitLeftRailRename(focusedSelector);
        return webdriverValue(response, null);
      }
      if (focusedSelector === ".output" && chatOutputLifecycleActive) {
        if (key !== "\uE013") {
          return webdriverError(response, 400, "invalid argument", "ChatOutput fixture accepts only ArrowUp");
        }
        chatOutputUpCount += 1;
        if (chatOutputUpCount >= 4) chatOutputJumpVisible = true;
        return webdriverValue(response, null);
      }
      if (focusedSelector === "[data-debug-id='shellx-browser-sidebar-resize']") {
        if (key === "\uE012") browserRightSidebarWidth = Math.min(560, browserRightSidebarWidth + 20);
        else if (key === "\uE014") browserRightSidebarWidth = Math.max(280, browserRightSidebarWidth - 20);
        else return webdriverError(response, 400, "invalid argument", "Browser sidebar resize accepts only ArrowLeft or ArrowRight");
        return webdriverValue(response, null);
      }
      if (
        focusedSelector !== "[data-debug-id='surface-components-vaultpasswordgenerator-5']"
        && focusedSelector !== "[data-debug-id='vault-password-generator-length']"
      ) {
        return webdriverError(response, 400, "invalid element state", "fixture key action has no supported focused control");
      }
      if (key === "\uE014" || key === "\uE013") vaultPasswordLength = Math.min(64, vaultPasswordLength + 1);
      else if (key === "\uE012" || key === "\uE015") vaultPasswordLength = Math.max(8, vaultPasswordLength - 1);
      else return webdriverError(response, 400, "invalid argument", "fixture key action is unsupported");
      return webdriverValue(response, null);
    }
    if (request.method === "DELETE" && path === `${prefix}/actions`) {
      pendingPointerSelector = null;
      return webdriverValue(response, null);
    }
    const clicked = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/click$`));
    if (request.method === "POST" && clicked) {
      const selector = elementSelector(clicked[1]!);
      if (!selectorDisplayed(selector)) {
        return webdriverError(response, 404, "stale element reference", "fixture element is not clickable");
      }
      focusedSelector = selector;
      if (selector === "[role='alert'] button:first-of-type"
        || selector === "[role='alert'] button:last-of-type") {
        if (lazySurfaceState === "error") {
          lazySurfaceState = selector.endsWith("first-of-type") ? "recovered" : "closed";
        } else {
          errorBoundaryOpen = false;
          if (selector.endsWith("last-of-type")) errorBoundaryDocumentGeneration += 1;
          debugUiWebSocketActive = 1;
          debugUiWebSocketGeneration += 1;
        }
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='composer-voice-chat']" && releaseTestVoiceRecording) {
        releaseTestVoiceRecording = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Turn voice chat off and cancel active listening']") {
        releaseTestVoiceRecording = false;
        releaseTestVoiceMode = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='composer-attach']"
        || selector === "[data-palette-action-id='act-attach']"
        || selector === "[role='dialog'][aria-label='Attachment and media board'] [title='Attach file']") {
        const pickerPath = consumeReleaseNativePicker("file");
        bottomPanelAttachmentPaths = [pickerPath];
        if (selector.includes("Attachment and media board")) attachmentMediaPendingPaths = [pickerPath];
        if (selector === "[data-palette-action-id='act-attach']") commandPaletteOpen = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='composer-folder']") {
        activeTab = { ...activeTab, cwd: consumeReleaseNativePicker("directory") };
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='settings-browser-download-folder-choose']") {
        publicSettings.browserDownloadFolder = consumeReleaseNativePicker("directory");
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='shellx-browser-download-folder-choose']") {
        publicSettings.browserDownloadFolder = consumeReleaseNativePicker("directory");
        browserDownloadFolder = publicSettings.browserDownloadFolder;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-settings-vaultsetuppanel-17']") {
        consumeReleaseNativePicker("file");
        vaultKeyfileSelected = true;
        clickedSelectors.push(selector);
      }
      else if (selector === ".vault-keyfile-picker > button:last-child") {
        vaultKeyfileSelected = false;
        clickedSelectors.push(selector);
      }
      else if (selector === ".composer-attachment-remove") {
        bottomPanelAttachmentPaths = [];
        attachmentMediaPendingPaths = [];
        clickedSelectors.push(selector);
      }
      else if (leftRailLifecycle && handleLeftRailClick(selector)) {
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='remote-cwd-close']") {
        remoteCwdOpen = false;
        remoteCwdPath = "";
        remoteCwdDraft = "";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='remote-cwd-go']") {
        remoteCwdPath = fixtureNormalizePath(remoteCwdDraft);
        remoteCwdDraft = remoteCwdPath;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='remote-cwd-up']"
        || selector === "[data-debug-id='remote-cwd-parent']") {
        const parent = fixtureParentPath(remoteCwdPath);
        if (!parent) {
          return webdriverError(response, 400, "element not interactable", "Remote Folder path has no owned parent");
        }
        remoteCwdPath = parent;
        remoteCwdDraft = parent;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='remote-cwd-folder']") {
        remoteCwdPath = fixtureJoinPath(remoteCwdPath, "owned-child");
        remoteCwdDraft = remoteCwdPath;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='remote-cwd-use']") {
        if (!remoteCwdOwnedUseActive) {
          remoteCwdUnsafeUseCount += 1;
          return webdriverError(response, 400, "element not interactable", "fixture refuses to persist a Remote Folder into an operator tab");
        }
        activeTab = { ...activeTab, cwd: remoteCwdPath };
        remoteCwdOpen = false;
        remoteCwdPath = "";
        remoteCwdDraft = "";
        remoteCwdOwnedUseActive = false;
        clickedSelectors.push(selector);
      }
      else if (selector === ".shell") {
        commitSessionRename();
        neutralFocusClicks += 1;
        findSessionsFocused = false;
        findOpenRowSelected = false;
        findDiskRowSelected = false;
        keyboardHintOpen = false;
      }
      else if (selector === ".output") {
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-chatoutput-1']") {
        chatOutputJumpVisible = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-chatoutput-3']"
        || selector === "[data-debug-id='surface-components-chatoutput-4']") {
        const path = selector.endsWith("chatoutput-3']") ? chatOutputAttachmentPath : chatOutputDiffPath;
        if (!path || !existsSync(path)) {
          return webdriverError(response, 400, "element not interactable", "owned ChatOutput preview file is missing");
        }
        previewTarget = {
          kind: "file",
          path,
          tabId: activeTab.tabId,
          sessionCwd: activeTab.cwd,
        };
        previewFilePath = path;
        previewCenterView = "file";
        ownedModalOpen = "preview";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-chatoutput-5']") {
        chatOutputThoughtExpanded = !chatOutputThoughtExpanded;
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label^='Dismiss warning: ']") {
        chatOutputDoomVisible = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Dismiss host MCP unreachable warning']") {
        chatOutputHostVisible = false;
        clickedSelectors.push(selector);
      }
      else if (selector === ".stab-new[title='New session (⌘T)']") {
        if (openSessionTabs.some((tab) => tab.tabId === bottomPanelOwnedTabId)) {
          return webdriverError(response, 400, "element not interactable", "owned BottomPanel tab already exists");
        }
        const ownedTab = {
          tabId: bottomPanelOwnedTabId,
          sessionId: null,
          title: "new session",
          cwd: activeTab.cwd,
          agentId: null,
          connectionId: activeTab.connectionId ?? null,
          connectionLabel: activeTab.connectionLabel ?? "Local",
          connectionTransport: activeTab.connectionTransport ?? "local",
          projectId: null,
          branchName: null,
          status: "Idle",
          isSending: false,
        };
        openSessionTabs.push(ownedTab);
        activeTab = activeContextFromSessionTab(ownedTab, activeTab);
        bottomPanelAttachmentPaths = [];
        alwaysVisibleTextValues["[data-debug-id='composer-prompt']"] = "";
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='New session (⌘T)']" || selector === "[aria-label='New session']") {
        ownedSessionTabSequence += 1;
        const tabId = `fixture-owned-session-tab-${ownedSessionTabSequence}`;
        const ownedTab = {
          tabId,
          sessionId: null,
          title: `Owned session ${ownedSessionTabSequence}`,
          cwd: activeTab.cwd,
          agentId: null,
          connectionId: activeTab.connectionId ?? null,
          connectionLabel: activeTab.connectionLabel ?? "Local",
          connectionTransport: activeTab.connectionTransport ?? "local",
          projectId: null,
          branchName: null,
          status: "Idle",
          isSending: false,
        };
        openSessionTabs.push(ownedTab);
        activeTab = activeContextFromSessionTab(ownedTab, activeTab);
        ensureSessionTabVisible(tabId);
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='All sessions']") {
        sessionDropdownOpen = !sessionDropdownOpen;
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Scroll right']") {
        sessionRailScrollLeft = Math.min(sessionRailMaxScrollLeft(), sessionRailScrollLeft + 240);
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Scroll left']") {
        sessionRailScrollLeft = Math.max(0, sessionRailScrollLeft - 240);
        clickedSelectors.push(selector);
      }
      else if (sessionTabSelectorParts(selector)) {
        const parts = sessionTabSelectorParts(selector)!;
        const tab = openSessionTabs.find((entry) => entry.tabId === parts.tabId);
        if (!tab) return webdriverError(response, 400, "element not interactable", "unknown renderer session tab");
        if (!parts.descendant) {
          activeTab = activeContextFromSessionTab(tab, activeTab);
          ensureSessionTabVisible(parts.tabId);
        } else if (parts.descendant === "[aria-label='Rename session']") {
          sessionRenamingTabId = parts.tabId;
          sessionRenameValue = String(tab.title ?? "");
        } else if (parts.descendant === "[aria-label='Close session']") {
          if (!closeOwnedSessionTab(parts.tabId)) {
            return webdriverError(response, 400, "element not interactable", "fixture refuses to close a non-owned renderer tab");
          }
        } else if (parts.descendant === "[data-debug-id='surface-components-sessiontabs-4']") {
          activeTab = activeContextFromSessionTab(tab, activeTab);
          ensureSessionTabVisible(parts.tabId);
          ownedModalOpen = "preview";
          previewCenterView = "file";
        } else {
          return webdriverError(response, 400, "element not interactable", "unsupported renderer session-tab descendant");
        }
        clickedSelectors.push(selector);
      }
      else if (sessionDropdownRowParts(selector)) {
        const parts = sessionDropdownRowParts(selector)!;
        const tab = sessionTabAt(parts.index);
        if (!sessionDropdownOpen || !tab) {
          return webdriverError(response, 400, "element not interactable", "unknown renderer session dropdown row");
        }
        const tabId = String(tab.tabId ?? "");
        if (!parts.descendant) {
          activeTab = activeContextFromSessionTab(tab, activeTab);
          ensureSessionTabVisible(tabId);
          sessionDropdownOpen = false;
        } else if (parts.descendant === "[data-debug-id='surface-components-sessiontabs-11']") {
          activeTab = activeContextFromSessionTab(tab, activeTab);
          ensureSessionTabVisible(tabId);
          ownedModalOpen = "preview";
          previewCenterView = "file";
          sessionDropdownOpen = false;
        } else if (parts.descendant === "[title='Close']") {
          if (!closeOwnedSessionTab(tabId)) {
            return webdriverError(response, 400, "element not interactable", "fixture refuses to close a non-owned renderer dropdown tab");
          }
        } else {
          return webdriverError(response, 400, "element not interactable", "unsupported renderer session dropdown descendant");
        }
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Remove release-owned-file.txt from selection']") {
        filesPaneSelected = false;
        clickedSelectors.push(selector);
      }
      else if (/^\[aria-label='Remove ([^']+)'\]$/.test(selector)) {
        const name = selector.match(/^\[aria-label='Remove ([^']+)'\]$/)?.[1] ?? "";
        const before = bottomPanelAttachmentPaths.length;
        bottomPanelAttachmentPaths = bottomPanelAttachmentPaths.filter(
          (path) => !path.replace(/\\/g, "/").endsWith(`/${name}`),
        );
        if (bottomPanelAttachmentPaths.length === before) {
          return webdriverError(response, 400, "element not interactable", "owned attachment was not present");
        }
        clickedSelectors.push(selector);
      }
      else if (selector === ".composer-attachment-actions > .composer-attachment-action:nth-of-type(1)"
        || selector === ".composer-attachment-actions > .composer-attachment-action:nth-of-type(2)") {
        const inserted = selector.endsWith("nth-of-type(1)")
          ? "Inspect the attached file. Summarize what each contains and point out anything important I should notice."
          : "Summarize the attached file. Keep it concise and include filenames when comparing them.";
        const prompt = alwaysVisibleTextValues["[data-debug-id='composer-prompt']"]!.trim();
        alwaysVisibleTextValues["[data-debug-id='composer-prompt']"] = prompt ? `${prompt}\n\n${inserted}` : inserted;
        clickedSelectors.push(selector);
      }
      else if (selector === ".composer-attachment-actions > .composer-attachment-action:nth-of-type(3)") {
        pendingAlertText = "Find what in the attached files?";
        pendingPromptResponseText = null;
        pendingAttachmentFindTarget = "bottom";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-bottompanel-24']") {
        alwaysVisibleTextValues["[data-debug-id='composer-prompt']"] = "/commands ";
        clickedSelectors.push(selector);
      }
      else if (/^\[data-debug-id='surface-components-bottompanel-9'\]\[title='[^']+'\]$/.test(selector)) {
        if (!bottomPanelImagePath) {
          return webdriverError(response, 400, "element not interactable", "owned media fixture is missing");
        }
        previewTarget = { path: bottomPanelImagePath, title: "Image preview", kind: "image" };
        previewFilePath = bottomPanelImagePath;
        ownedModalOpen = "preview";
        previewCenterView = "file";
        clickedSelectors.push(selector);
      }
      else if (/^\[title='ACP terminal [A-Za-z0-9._:-]+'\]$/.test(selector)) {
        const terminalId = selector.match(/^\[title='ACP terminal ([A-Za-z0-9._:-]+)'\]$/)?.[1] ?? "";
        if (!bottomPanelTerminalIds.includes(terminalId)) {
          return webdriverError(response, 400, "element not interactable", "owned ACP terminal is missing");
        }
        bottomPanelActiveTerminal = terminalId;
        clickedSelectors.push(selector);
      }
      else if (selector === ".terminal-substrip > button.substrip-tab") {
        bottomPanelActiveTerminal = "user";
        clickedSelectors.push(selector);
      }
      else if (/^\[data-release-terminal-id='[A-Za-z0-9._:-]+'\] \[aria-label='close terminal tab'\]$/.test(selector)) {
        const terminalId = selector.match(/^\[data-release-terminal-id='([A-Za-z0-9._:-]+)'\]/)?.[1] ?? "";
        bottomPanelTerminalIds = bottomPanelTerminalIds.filter((id) => id !== terminalId);
        if (bottomPanelActiveTerminal === terminalId) bottomPanelActiveTerminal = "user";
        clickedSelectors.push(selector);
      }
      else if (selector === ".provider-runner-actions button:last-child"
        && agentCliSetupFixtureMode === "live-status") {
        scanOwnedAgentCliVersion();
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='agent-cli-setup-assistant'] .agent-cli-setup-header-actions button:first-child"
        && agentCliSetupFixtureMode === "live-setup") {
        scanOwnedAgentCliVersion();
        clickedSelectors.push(selector);
      }
      else if (selector === ".agent-cli-setup-card[data-agent-cli-provider='grok'] .agent-cli-setup-card-actions button:first-child"
        && agentCliSetupFixtureMode === "cards") {
        aboutExternalUrls.push("https://example.invalid/shellx-agent-cli-setup");
        clickedSelectors.push(selector);
      }
      else if (selector === ".agent-cli-setup-confirm-links button:first-child"
        && agentCliSetupFixtureMode === "confirmation") {
        aboutExternalUrls.push("https://example.invalid/shellx-agent-cli-setup");
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-agentclisetupassistant-5']"
        && agentCliSetupFixtureMode === "install-lifecycle" && agentCliInstallConfirmationId === null) {
        agentCliInstallConfirmationId = "setup-01234567-89ab-4cde-8fab-0123456789ab";
        agentCliInstallPrepareCount += 1;
        clickedSelectors.push(selector);
      }
      else if (selector === ".agent-cli-setup-confirm-actions button:first-child"
        && agentCliSetupFixtureMode === "install-lifecycle" && agentCliInstallConfirmationId !== null) {
        agentCliInstallConfirmationId = null;
        agentCliInstallCancelCount += 1;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-agentclisetupassistant-9']"
        && agentCliSetupFixtureMode === "install-lifecycle" && agentCliInstallConfirmationId !== null) {
        runOwnedNpmInstallShim();
        agentCliInstallConfirmationId = null;
        agentCliInstallRunCount += 1;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='agent-cli-setup-assistant'] .agent-cli-setup-header-actions button:last-child") {
        if (agentCliSetupFixtureMode === "status-card") agentCliStatusDialogProvider = null;
        else agentCliSetupFixtureMode = "closed";
        clickedSelectors.push(selector);
      }
      else if (/^\[data-debug-id='agent-cli-setup-open-(grok|claude-code|codex-cli|antigravity-cli)'\]$/.test(selector)) {
        agentCliStatusDialogProvider = selector.match(/^\[data-debug-id='agent-cli-setup-open-([^']+)'\]$/)?.[1] ?? null;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='agent-cli-setup-open-missing']") {
        agentCliStatusDialogProvider = "all";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-findpopover-1']") {
        findSessionsFocused = true;
        findOpenRowSelected = false;
        findDiskRowSelected = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Review later']") {
        if (goalPlanReviewFixtureMode !== "closed") {
          goalPlanReviewFixtureMode = "closed";
          goalPlanReviewEditing = false;
          goalPlanReviewComment = "";
        } else {
          goalReviewModalOpen = false;
        }
        clickedSelectors.push(selector);
      }
      else if (selector === ".plan-review-actions > button:first-child") {
        goalPlanReviewFixtureMode = "closed";
        goalPlanReviewEditing = false;
        goalPlanReviewComment = "";
        clickedSelectors.push(selector);
      }
      else if (selector === ".plan-review-actions > button:nth-of-type(3)") {
        goalPlanReviewEditing = true;
        goalPlanReviewComment = "";
        clickedSelectors.push(selector);
      }
      else if (selector === ".plan-edit-actions > button:last-child") {
        goalPlanReviewEditing = false;
        goalPlanReviewComment = "";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-goalplanreviewmodal-4']") {
        if (goalPlanReviewFixtureMode !== "closed" || !goalReviewModalOpen || !goalPlanReviewEditing
          || !goalState || goalState.awaitingApproval !== true || !goalPlanReviewComment.trim()) {
          return webdriverError(response, 400, "element not interactable", "Goal feedback is not bound to an owned reviewable Goal");
        }
        goalState.planTurnCompleted = false;
        goalReviewModalOpen = false;
        goalPlanReviewEditing = false;
        goalProviderAction = "goal-replan";
        goalProviderDigest = createHash("sha256")
          .update(`replan:${String(goalState.objective)}:${goalPlanReviewComment.trim()}`)
          .digest("hex");
        goalProviderRunId = "fixture-goal-provider-replan";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-goalplanreviewmodal-7']") {
        if (goalPlanReviewFixtureMode !== "closed" || !goalReviewModalOpen || !goalState
          || goalState.awaitingApproval !== true) {
          return webdriverError(response, 400, "element not interactable", "Goal rejection is not bound to an owned reviewable Goal");
        }
        if (!goalPlanRejectArmed) {
          goalPlanRejectArmed = true;
        } else {
          goalPlanRejectArmed = false;
          goalLastClear = {
            reason: "rejected",
            objective: goalState.objective,
            clearedAtMs: Date.now(),
          };
          goalState = null;
          goalReviewModalOpen = false;
        }
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-goalplanreviewmodal-9']") {
        if (goalPlanReviewFixtureMode !== "closed" || !goalReviewModalOpen || !goalState
          || goalState.awaitingApproval !== true) {
          return webdriverError(response, 400, "element not interactable", "Goal approval is not bound to an owned reviewable Goal");
        }
        const scratchboard = String(goalState.scratchboardPath);
        writeFileSync(
          scratchboard,
          readFileSync(scratchboard, "utf8").replace("Status: AWAITING_APPROVAL", "Status: IN_PROGRESS"),
          "utf8",
        );
        goalState.awaitingApproval = false;
        goalState.planTurnCompleted = true;
        goalState.approvedAtMs = Date.now();
        goalReviewModalOpen = false;
        goalProviderAction = "goal-approve";
        goalProviderDigest = createHash("sha256")
          .update(`approve:${String(goalState.objective)}:${scratchboard}`)
          .digest("hex");
        goalProviderRunId = "fixture-goal-provider-approve";
        clickedSelectors.push(selector);
      }
      else if (selector === "[role='dialog'][aria-label^='Review build plan:'] [aria-label='Review later']"
        || selector === "[role='dialog'][aria-label^='Review build plan:'] .plan-review-actions > button:first-child") {
        if (!buildPlanFixtureActive || !buildPlanReviewOpen) {
          return webdriverError(response, 400, "element not interactable", "owned Build plan fixture is not open");
        }
        buildPlanReviewOpen = false;
        rightTab = "Plan";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-buildplanreviewmodal-4']"
        || selector === "[data-debug-id='surface-components-buildplanreviewmodal-5']") {
        if (buildPlanFixtureActive || !buildRunState || buildRunState.status !== "awaitingApproval") {
          buildPlanUnsafeMutationCount += 1;
          return webdriverError(response, 400, "element not interactable", "Build plan action is not bound to an owned awaiting-approval run");
        }
        if (selector.endsWith("-4']") && !buildPlanRejectArmed) {
          buildPlanRejectArmed = true;
          clickedSelectors.push(selector);
        } else if (selector.endsWith("-4']")) {
          buildPlanRejectArmed = false;
          buildRunState.status = "halted";
          buildRunReceipts.push({ kind: "planRejected", summary: "Build plan rejected", data: {} });
          clickedSelectors.push(selector);
        } else {
          buildPlanRejectArmed = false;
          buildRunState.status = "active";
          const scratchboard = String(buildRunState.scratchboardPath);
          writeFileSync(scratchboard, readFileSync(scratchboard, "utf8").replace("Status: AWAITING_APPROVAL", "Status: IN_PROGRESS"), "utf8");
          buildRunReceipts.push({ kind: "planApproved", summary: "Build plan approved", data: {} });
          buildRunProviderAction = "build-approve";
          buildRunProviderDigest = createHash("sha256").update(`approve:${buildRunState.objective}:${scratchboard}`).digest("hex");
          buildRunProviderRunId = "fixture-build-provider-approve";
          clickedSelectors.push(selector);
        }
      }
      else if (selector === "[data-debug-id='surface-components-settings-shellxagenttab-1']") {
        if (!settingsOpen || !shellxagentFixtureActive) {
          return webdriverError(response, 400, "element not interactable", "owned ShellX Agent fixture is not active");
        }
        shellxagentRevealed = !shellxagentRevealed;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-settings-shellxagenttab-3']"
        && settingsOpen && settingsTab === "shellxagent" && !shellxagentFixtureActive) {
        const path = join(profileRoot, ".shellx", "shellxagent.token");
        writeFileSync(path, "abcdef0123456789abcdef0123456789", { mode: 0o600 });
        shellxagentRotationCount += 1;
        shellxagentRevealed = true;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-settings-shellxagenttab-2']"
        || selector === "[data-debug-id='surface-components-settings-shellxagenttab-3']") {
        shellxagentUnsafeMutationCount += 1;
        return webdriverError(response, 400, "element not interactable", "owned ShellX Agent fixture disables clipboard and token rotation");
      }
      else if (selector === "[title='Open the focused plan review dialog.']") {
        goalReviewModalOpen = true;
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Approve the Build Mode scratchboard and start execution.']") {
        if (!buildRunState || buildRunState.status !== "awaitingApproval") {
          return webdriverError(response, 400, "element not interactable", "owned Build approval is not ready");
        }
        buildRunState.status = "active";
        const scratchboard = String(buildRunState.scratchboardPath);
        writeFileSync(scratchboard, readFileSync(scratchboard, "utf8").replace("Status: AWAITING_APPROVAL", "Status: IN_PROGRESS"), "utf8");
        buildRunReceipts.push({ kind: "planApproved", summary: "Build plan approved", data: {} });
        buildRunProviderAction = "build-approve";
        buildRunProviderDigest = createHash("sha256").update(`approve:${buildRunState.objective}:${scratchboard}`).digest("hex");
        buildRunProviderRunId = "fixture-build-provider-approve";
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Reject this Build Mode plan and halt the run.']") {
        if (!buildRunState || buildRunState.status !== "awaitingApproval") {
          return webdriverError(response, 400, "element not interactable", "owned Build rejection is not ready");
        }
        buildRunState.status = "halted";
        buildRunReceipts.push({ kind: "planRejected", summary: "Build plan rejected", data: {} });
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Pause Build Mode auto-continuation.']") {
        if (!buildRunState || buildRunState.status !== "active") {
          return webdriverError(response, 400, "element not interactable", "owned Build is not active");
        }
        buildRunState.status = "paused";
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Resume Build Mode auto-continuation.']") {
        if (!buildRunState || buildRunState.status !== "paused") {
          return webdriverError(response, 400, "element not interactable", "owned Build is not paused");
        }
        buildRunState.status = "active";
        buildRunState.continuationsTotal = 1;
        buildRunProviderAction = "build-resume";
        buildRunProviderDigest = createHash("sha256").update(`resume:${buildRunState.objective}:${buildRunState.scratchboardPath}`).digest("hex");
        buildRunProviderRunId = "fixture-build-provider-resume";
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Recheck blocker evidence without restarting or prompting the Agent.']") {
        if (!buildRunState || buildRunState.status !== "blocked" || buildRunState.reviewSatisfied !== true) {
          return webdriverError(response, 400, "element not interactable", "owned Build blocker is not recheckable");
        }
        buildRunState.status = "active";
        buildRunState.openBlocker = null;
        buildRunReceipts.push({ kind: "blockerResolved", summary: "Blocker cleared; trusted reviewer receipt satisfies the review gate.", data: {} });
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Create a local shellX git checkpoint and attach it to this Build Mode run.']") {
        if (!buildRunState || (buildRunState.status !== "active" && buildRunState.status !== "paused")) {
          return webdriverError(response, 400, "element not interactable", "owned Build cannot checkpoint");
        }
        const checkpointId = "fixture-build-checkpoint";
        const checkpointPath = join(profileRoot, ".shellx", "git-checkpoints", "fixture-repo", String(buildRunState.tabId), checkpointId);
        mkdirSync(checkpointPath, { recursive: true, mode: 0o700 });
        writeFileSync(join(checkpointPath, "checkpoint.json"), "{}\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
        writeFileSync(join(checkpointPath, "unstaged.patch"), "fixture patch\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
        writeFileSync(join(checkpointPath, "untracked.json"), "[]\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
        buildRunState.checkpointId = checkpointId;
        buildRunReceipts.push({
          kind: "checkpointCreated",
          summary: "Git checkpoint created: Build fixture",
          data: { checkpointId, path: checkpointPath, repoRoot: buildRunState.cwd },
        });
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Stop Build Mode manually without accepting completion.']") {
        if (!buildRunState || buildRunState.status === "halted" || buildRunState.status === "complete") {
          return webdriverError(response, 400, "element not interactable", "owned Build cannot stop");
        }
        buildRunState.status = "halted";
        buildRunReceipts.push({ kind: "runHalted", summary: "Stopped manually from Build cockpit", data: {} });
        clickedSelectors.push(selector);
      }
      else if (selector === ":is([title='Show every receipt in this Build Mode run'],[title='Show latest receipts only'])") {
        buildRunCockpitShowAllReceipts = !buildRunCockpitShowAllReceipts;
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Pause auto-continuation (only user can pause)']") {
        if (!goalState) return webdriverError(response, 400, "element not interactable", "owned Goal is absent");
        goalState.pausedByUser = true;
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Resume auto-continuation']") {
        if (!goalState) return webdriverError(response, 400, "element not interactable", "owned Goal is absent");
        goalState.pausedByUser = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Mark build as complete — stops the auto-continuation loop. Use when the agent finished but did not call the completion tool itself.']") {
        pendingAlertText = "Mark this build as complete? The auto-continuation loop will stop. Use this when the agent finished the work but did not call the completion tool itself.";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-findpopover-3']") {
        findOpenRowSelected = true;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-findpopover-4']") {
        findDiskRowSelected = true;
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Open this chat in a new tab (Enter)']") {
        if (!findDiskRowSelected || openSessionTabs.some((tab) => tab.sessionId === findOwnedSessionId)) {
          return webdriverError(response, 400, "element not interactable", "owned Find session fixture is not uniquely selected");
        }
        const ownedTab = {
          tabId: findOwnedTabId,
          sessionId: findOwnedSessionId,
          title: `Release session history ${sourceCommit.slice(0, 16)}`,
          cwd: activeTab.cwd,
          agentId: null,
          connectionId: activeTab.connectionId ?? null,
          connectionLabel: activeTab.connectionLabel ?? "Local",
          connectionTransport: activeTab.connectionTransport ?? "local",
          projectId: null,
          branchName: null,
          status: "Idle",
          isSending: false,
        };
        openSessionTabs.push(ownedTab);
        activeTab = activeContextFromSessionTab(ownedTab, activeTab);
        alwaysVisibleTextValues["[data-debug-id='find-sessions-input']"] = "";
        findSessionsFocused = false;
        findOpenRowSelected = false;
        findDiskRowSelected = false;
        clickedSelectors.push(selector);
      }
      else if (/^\[data-tab-id='[A-Za-z0-9._:-]+'\] \[aria-label='Close session'\]$/.test(selector)) {
        const tabId = selector.match(/^\[data-tab-id='([A-Za-z0-9._:-]+)'\]/)?.[1] ?? "";
        if ((tabId !== findOwnedTabId && tabId !== bottomPanelOwnedTabId)
          || !openSessionTabs.some((tab) => tab.tabId === tabId)) {
          return webdriverError(response, 400, "element not interactable", "fixture refuses to close a non-owned renderer tab");
        }
        const index = openSessionTabs.findIndex((tab) => tab.tabId === tabId);
        openSessionTabs = openSessionTabs.filter((tab) => tab.tabId !== tabId);
        const fallback = openSessionTabs[index] ?? openSessionTabs[index - 1] ?? null;
        if (fallback) activeTab = activeContextFromSessionTab(fallback, activeTab);
        if (tabId === bottomPanelOwnedTabId) {
          bottomPanelAttachmentPaths = [];
          bottomPanelImagePath = null;
          bottomPanelTerminalIds = [];
          bottomPanelActiveTerminal = null;
          bottomPanelFixtureUserVisible = false;
          alwaysVisibleTextValues["[data-debug-id='composer-prompt']"] = "";
        }
        clickedSelectors.push(selector);
      }
      else if (/^\[data-tab-id='[A-Za-z0-9._:-]+'\]$/.test(selector)) {
        const tabId = selector.match(/^\[data-tab-id='([A-Za-z0-9._:-]+)'\]$/)?.[1] ?? "";
        const tab = openSessionTabs.find((entry) => entry.tabId === tabId);
        if (!tab) return webdriverError(response, 400, "element not interactable", "unknown renderer session tab");
        activeTab = activeContextFromSessionTab(tab, activeTab);
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-commandpalette-4'][data-palette-action-id='act-settings']") {
        commandPaletteOpen = false;
        settingsOpen = true;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='header-shellx-browser']") {
        browserWindowOpen = true;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='shellx-setup-step-vault']") {
        ownedModalOpen = "vault";
        vaultWorkspaceModalOpen = true;
        vaultWorkspaceIntent = "setup";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='shellx-setup-step-browser']") {
        browserWindowOpen = true;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='shellx-setup-step-downloads']") {
        settingsOpen = true;
        settingsTab = "general";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='shellx-setup-step-agents']") {
        settingsOpen = true;
        settingsTab = "shellxagent";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='shellx-setup-step-requests']") {
        vaultRequestCenterOpen = true;
        vaultPasswordGeneratorOpen = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='shellx-setup-guide-dismiss']") {
        setupGuideDismissed = true;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='header-vault-request-center']") {
        vaultRequestCenterOpen = !vaultRequestCenterOpen;
        vaultPasswordGeneratorOpen = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='tasks-agent-runs-refresh']") {
        agentRunsManualRefreshSequence += 1;
        agentRunsManualRefreshGeneratedAtMs = 1_750_000_000_000 + agentRunsManualRefreshSequence;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-taskspanel-3']") {
        tasksManualRefreshSequence += 1;
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Clean Host MCP children for this tab']") {
        const tasks = visibleHostMcpTasks();
        if (tasks.length === 0) {
          return webdriverError(response, 400, "element not interactable", "no owned Host MCP task is visible");
        }
        if (!tasksCleanupMcpArmed) tasksCleanupMcpArmed = true;
        else {
          for (const task of tasks) task.status = "killed";
          tasksCleanupMcpArmed = false;
        }
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-mediapreview-1']") {
        previewVideoPlaybackState = previewVideoPlaybackState === "playing" ? "paused" : "playing";
        clickedSelectors.push(selector);
      }
      else if (tasksPanelSelectorParts(selector)) {
        const parts = tasksPanelSelectorParts(selector)!;
        const task = tasksPanelTask(parts.taskId);
        if (!task || !tasksPanelTaskVisible(task)) {
          return webdriverError(response, 400, "element not interactable", "unknown owned TasksPanel task row");
        }
        if (parts.descendant === "[data-debug-id='surface-components-taskspanel-8']") {
          if (expandedBackgroundTaskIds.has(parts.taskId)) expandedBackgroundTaskIds.delete(parts.taskId);
          else expandedBackgroundTaskIds.add(parts.taskId);
        } else if (parts.descendant === "[title='Pause (SIGSTOP on Unix, NtSuspendProcess on Windows)']"
          && task.status === "running") {
          task.status = "stopped";
        } else if (parts.descendant === "[title='Resume (SIGCONT on Unix, NtResumeProcess on Windows)']"
          && task.status === "stopped") {
          task.status = "running";
        } else if (parts.descendant === ":is([title='Kill (SIGTERM then SIGKILL after 3s)'],[title='Kill terminal and remove its task row'])") {
          ownedBackgroundTasks = ownedBackgroundTasks.filter((entry) => entry.taskId !== parts.taskId);
          expandedBackgroundTaskIds.delete(parts.taskId);
        } else {
          return webdriverError(response, 400, "element not interactable", "unsupported owned TasksPanel control");
        }
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='activity-search-clear']") {
        activitySearchValue = "";
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='About shellX — version and source']") {
        settingsOpen = true;
        settingsTab = "about";
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Open plugins']") {
        pluginsOpen = true;
        clickedSelectors.push(selector);
      }
      else if (pluginsProductionLifecycle && pluginsProductionFixtureActive
        && (selector === ".mp-hero button.mp-action-btn-primary"
          || selector === "[data-marketplace-entry-id='context7'] [data-debug-id='surface-components-pluginsmodal-11']")) {
        writePluginsMarketplaceEntry("context7", true, true);
        clickedSelectors.push(selector);
      }
      else if (pluginsProductionLifecycle && pluginsProductionFixtureActive
        && selector === "[data-marketplace-entry-id='context7'] [data-debug-id='plugins-entry-toggle']") {
        const context = pluginsMarketplaceEntry("context7");
        writePluginsMarketplaceEntry("context7", true, !context.enabled);
        clickedSelectors.push(selector);
      }
      else if (pluginsProductionLifecycle && pluginsProductionFixtureActive
        && selector === "[data-marketplace-entry-id='context7'] .mp-row-actions > button.mp-action-btn-secondary") {
        writePluginsMarketplaceEntry("context7", false, true);
        clickedSelectors.push(selector);
      }
      else if (pluginsProductionLifecycle && pluginsProductionFixtureActive
        && selector === "[data-marketplace-entry-id='github'] [data-debug-id='surface-components-pluginsmodal-10']") {
        writePluginsMarketplaceEntry("github", true, true);
        clickedSelectors.push(selector);
      }
      else if (pluginsProductionLifecycle && pluginsProductionFixtureActive
        && selector === "[data-marketplace-entry-id='github'] [title='Enter your API key inline']") {
        pluginsKeyFormEntryId = "github";
        pluginsKeyDraftValue = "";
        clickedSelectors.push(selector);
      }
      else if (pluginsProductionLifecycle && pluginsProductionFixtureActive
        && selector === "[data-marketplace-entry-id='github'] [data-debug-id='surface-components-pluginsmodal-13']") {
        if (!pluginsKeyDraftValue) {
          return webdriverError(response, 400, "invalid element state", "synthetic Plugins Vault draft is empty");
        }
        pluginsVaultKeys.add("github/pat");
        pluginsKeyFormEntryId = null;
        pluginsKeyDraftValue = "";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-marketplace-entry-id='release-owned-installed-key'] :is([title='Cancel adding key (clears input)'],[title='Enter your API key inline'])"
        || selector === "[data-marketplace-entry-id='release-owned-uninstalled-key'] :is([title='Cancel adding key (clears input)'],[title='Enter your API key inline'])") {
        const entryId = selector.includes("release-owned-installed-key")
          ? "release-owned-installed-key"
          : "release-owned-uninstalled-key";
        if (!pluginsOpen || !pluginsFixtureActive) {
          return webdriverError(response, 400, "element not interactable", "owned Plugins fixture is not active");
        }
        if (pluginsKeyFormEntryId === entryId) {
          pluginsKeyFormEntryId = null;
          pluginsKeyDraftValue = "";
        } else {
          pluginsKeyFormEntryId = entryId;
          pluginsKeyDraftValue = "";
        }
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Open connector inbox']") {
        ownedModalOpen = "connectorInbox";
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Open settings']") {
        settingsOpen = true;
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Add a new connection preset']") {
        connectionEditorOpen = true;
        connectionEditorProviderScan = null;
        connectionSshKeyVaultRef = "";
        connectionTransport = "local";
        connectionRuntime = "posix";
        for (const key of Object.keys(connectionDraftValues)) connectionDraftValues[key] = "";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-settings-connectionstab-2']") {
        if (!settingsOpen || settingsTab !== "connections") {
          return webdriverError(response, 400, "element not interactable", "Settings connections is not open");
        }
        settingsConnectionRows = structuredClone([...connectionPresets.values()]);
        settingsConnectionsRefreshCount += 1;
        clickedSelectors.push(selector);
      }
      else if (/^\.connection-row\[data-connection-id='[^']+'\] \[title='Edit this connection'\]$/.test(selector)) {
        const id = selector.match(/^\.connection-row\[data-connection-id='([^']+)'\]/)?.[1] ?? "";
        const preset = settingsConnectionRows.find((entry) => entry.id === id);
        if (!preset || !connectionPresets.has(id)) {
          return webdriverError(response, 404, "stale element reference", "owned Settings connection row disappeared");
        }
        connectionEditorOwnedId = id;
        connectionEditorOpen = true;
        connectionEditorProviderScan = null;
        connectionSshKeyVaultRef = "";
        connectionTransport = "local";
        connectionRuntime = "posix";
        for (const key of Object.keys(connectionDraftValues)) connectionDraftValues[key] = "";
        connectionDraftValues["[data-debug-id='connection-label-input']"] = String(preset.label ?? "");
        clickedSelectors.push(selector);
      }
      else if (/^\.connection-row\[data-connection-id='[^']+'\] \[title='Delete this connection preset'\]$/.test(selector)) {
        const id = selector.match(/^\.connection-row\[data-connection-id='([^']+)'\]/)?.[1] ?? "";
        const preset = settingsConnectionRows.find((entry) => entry.id === id);
        if (!preset || !connectionPresets.has(id)) {
          return webdriverError(response, 404, "stale element reference", "owned Settings connection row disappeared");
        }
        pendingSettingsConnectionDeleteId = id;
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Cancel delete connection']") {
        if (!pendingSettingsConnectionDeleteId) {
          return webdriverError(response, 400, "element not interactable", "Settings connection confirmation is not open");
        }
        pendingSettingsConnectionDeleteId = null;
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Confirm delete saved connection']") {
        if (!pendingSettingsConnectionDeleteId) {
          return webdriverError(response, 400, "element not interactable", "Settings connection confirmation is not open");
        }
        connectionPresets.delete(pendingSettingsConnectionDeleteId);
        connectionTestResults.delete(pendingSettingsConnectionDeleteId);
        settingsConnectionRows = settingsConnectionRows.filter((preset) => preset.id !== pendingSettingsConnectionDeleteId);
        pendingSettingsConnectionDeleteId = null;
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Add a new connection']") {
        composerPicker = null;
        connectionEditorOpen = true;
        connectionEditorProviderScan = null;
        connectionSshKeyVaultRef = "";
        connectionTransport = "local";
        connectionRuntime = "posix";
        for (const key of Object.keys(connectionDraftValues)) connectionDraftValues[key] = "";
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Close connection editor']" || selector === "[aria-label='Cancel connection changes']") {
        connectionEditorOpen = false;
        connectionEditorOwnedId = null;
        connectionEditorProviderScan = null;
        connectionSshKeyVaultRef = "";
        clickedSelectors.push(selector);
      }
      else if (/^\[title='Use [^']+'\] ~ \[data-debug-id='surface-components-connectionpicker-3'\] > button:first-child$/.test(selector)) {
        const label = selector.match(/^\[title='Use ([^']+)'\]/)?.[1] ?? "";
        const entry = [...connectionPresets.entries()].find(([, preset]) => preset.label === label);
        if (!entry) return webdriverError(response, 404, "stale element reference", "owned connection row disappeared");
        const providers = ownedConnectionProviderScan();
        connectionPresets.set(entry[0], { ...entry[1], providerScan: providers });
        connectionTestResults.set(entry[0], { reachable: true, latencyMs: 3, error: null });
        clickedSelectors.push(selector);
      }
      else if (/^\[title='Use [^']+'\] ~ \[data-debug-id='surface-components-connectionpicker-3'\] > button:nth-of-type\(2\)$/.test(selector)) {
        const label = selector.match(/^\[title='Use ([^']+)'\]/)?.[1] ?? "";
        const entry = [...connectionPresets.entries()].find(([, preset]) => preset.label === label);
        if (!entry) return webdriverError(response, 404, "stale element reference", "owned connection row disappeared");
        connectionEditorOwnedId = entry[0];
        connectionEditorOpen = true;
        connectionEditorProviderScan = null;
        connectionSshKeyVaultRef = "";
        composerPicker = null;
        connectionTransport = "local";
        connectionRuntime = "posix";
        for (const key of Object.keys(connectionDraftValues)) connectionDraftValues[key] = "";
        connectionDraftValues["[data-debug-id='connection-label-input']"] = label;
        clickedSelectors.push(selector);
      }
      else if (/^\[title='Use [^']+'\]$/.test(selector)) {
        const label = selector.match(/^\[title='Use ([^']+)'\]$/)?.[1] ?? "";
        const entry = [...connectionPresets.entries()].find(([, preset]) => preset.label === label);
        if (!entry) return webdriverError(response, 404, "stale element reference", "owned connection row disappeared");
        const providers = ownedConnectionProviderScan();
        connectionPresets.set(entry[0], { ...entry[1], providerScan: providers });
        activeTab = {
          ...activeTab,
          connectionId: entry[0],
          connectionLabel: label,
          connectionTransport: "local",
        };
        composerPicker = null;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-connectioneditor-12']") {
        if (!connectionEditorOpen || !connectionEditorOwnedId || !connectionPresets.has(connectionEditorOwnedId)) {
          return webdriverError(response, 400, "element not interactable", "owned connection editor is not open");
        }
        connectionEditorProviderScan = ownedConnectionProviderScan();
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-connectioneditor-14']") {
        if (!connectionEditorOpen || !connectionEditorOwnedId) {
          return webdriverError(response, 400, "element not interactable", "owned connection editor is not open");
        }
        const preset = connectionPresets.get(connectionEditorOwnedId);
        if (!preset) return webdriverError(response, 404, "stale element reference", "owned connection record disappeared");
        const providers = ownedConnectionProviderScan();
        connectionPresets.set(connectionEditorOwnedId, { ...preset, providerScan: providers });
        connectionTestResults.set(connectionEditorOwnedId, { reachable: true, latencyMs: 2, error: null });
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='connection-agent-cli-setup-open']") {
        if (!connectionEditorOpen || !connectionEditorOwnedId || !connectionEditorProviderScan) {
          return webdriverError(response, 400, "element not interactable", "owned connection provider scan is not ready");
        }
        agentCliSetupFixtureMode = "live-setup";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-connectioneditor-16']") {
        const preset = connectionEditorOwnedId ? connectionPresets.get(connectionEditorOwnedId) : null;
        const label = connectionDraftValues["[data-debug-id='connection-label-input']"]!.trim();
        if (!preset || !label) {
          return webdriverError(response, 400, "element not interactable", "owned connection draft is invalid");
        }
        connectionPresets.set(connectionEditorOwnedId!, { ...preset, label, transport: { kind: "local" } });
        connectionEditorOpen = false;
        connectionEditorOwnedId = null;
        connectionEditorProviderScan = null;
        connectionSshKeyVaultRef = "";
        composerPicker = "connection";
        clickedSelectors.push(selector);
      }
      else if (selector !== "[aria-label='Delete project']" && /^\[aria-label='Delete [^']+'\]$/.test(selector)) {
        const label = selector.match(/^\[aria-label='Delete ([^']+)'\]$/)?.[1] ?? "";
        const entry = [...connectionPresets.entries()].find(([, preset]) => preset.label === label);
        if (!entry) return webdriverError(response, 404, "stale element reference", "owned connection row disappeared");
        pendingConnectionDeleteId = entry[0];
        clickedSelectors.push(selector);
      }
      else if (selector === "[role='alertdialog'][aria-label='Delete connection'] button:nth-of-type(1)") {
        if (!pendingConnectionDeleteId) {
          return webdriverError(response, 400, "element not interactable", "owned connection confirmation is not open");
        }
        pendingConnectionDeleteId = null;
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Confirm delete connection']") {
        if (!pendingConnectionDeleteId) {
          return webdriverError(response, 400, "element not interactable", "owned connection confirmation is not open");
        }
        connectionPresets.delete(pendingConnectionDeleteId);
        connectionTestResults.delete(pendingConnectionDeleteId);
        pendingConnectionDeleteId = null;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-attachmentmediaboard-9']"
        || selector === "[role='dialog'][aria-label='Attachment and media board'] .asset-board-section:nth-of-type(1) [title='Preview file']") {
        previewAttachmentMediaPath(attachmentMediaPendingPaths[0] ?? null);
        clickedSelectors.push(selector);
      }
      else if (selector === "[role='dialog'][aria-label='Attachment and media board'] .asset-board-section:nth-of-type(1) [title='Remove attachment']") {
        attachmentMediaPendingPaths = attachmentMediaPendingPaths.slice(1);
        bottomPanelAttachmentPaths = [];
        clickedSelectors.push(selector);
      }
      else if (selector === "[role='dialog'][aria-label='Attachment and media board'] [title='Remove attachment']") {
        attachmentMediaPendingPaths = [];
        bottomPanelAttachmentPaths = [];
        clickedSelectors.push(selector);
      }
      else if (selector === "[role='dialog'][aria-label='Attachment and media board'] .asset-board-section:nth-of-type(1) .asset-board-actions > button:nth-child(3)"
        || selector === "[role='dialog'][aria-label='Attachment and media board'] .asset-board-section:nth-of-type(1) .asset-board-actions > button:nth-child(4)") {
        const inserted = selector.endsWith("nth-child(3)")
          ? "Inspect the attached file. Summarize what each contains and point out anything important I should notice."
          : "Summarize the attached file. Keep it concise and include filenames when comparing them.";
        const prompt = alwaysVisibleTextValues["[data-debug-id='composer-prompt']"]!.trim();
        alwaysVisibleTextValues["[data-debug-id='composer-prompt']"] = prompt ? `${prompt}\n\n${inserted}` : inserted;
        bottomTab = "Chat";
        ownedModalOpen = null;
        clickedSelectors.push(selector);
      }
      else if (selector === "[role='dialog'][aria-label='Attachment and media board'] .asset-board-section:nth-of-type(1) .asset-board-actions > button:nth-child(5)") {
        pendingAlertText = "Find what in the attached files?";
        pendingPromptResponseText = null;
        pendingAttachmentFindTarget = "board";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-attachmentmediaboard-12']"
        || selector === "[role='dialog'][aria-label='Attachment and media board'] .asset-board-section:nth-of-type(2) [title='Preview file']") {
        previewAttachmentMediaPath(attachmentMediaSessionPath);
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-attachmentmediaboard-14']") {
        previewAttachmentMediaPath(attachmentMediaVideoPath ?? attachmentMediaImagePath);
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Preview release-owned-image.png']"
        || selector === "[data-debug-id='surface-components-attachmentmediaboard-18']") {
        previewAttachmentMediaPath(attachmentMediaImagePath);
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-attachmentmediaboard-19']") {
        previewAttachmentMediaPath(attachmentMediaVideoPath);
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Attach release-owned-image.png']") {
        importAttachmentMediaImage(true);
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Import release-owned-image.png']") {
        importAttachmentMediaImage(false);
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Select release-owned-file.txt']") {
        filesPaneSelected = true;
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Clear selected files']") {
        filesPaneSelected = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Attach selected files to the composer']"
        || selector === "[aria-label='Attach release-owned-file.txt']") {
        const path = filesPaneSessionFilePath();
        if (!path) return webdriverError(response, 400, "element not interactable", "owned FilesPane session path is missing");
        if (!attachmentMediaPendingPaths.includes(path)) attachmentMediaPendingPaths.push(path);
        if (selector.startsWith("[title=")) filesPaneSelected = false;
        clickedSelectors.push(selector);
      }
      else if (selector === ".fv-row.dir [data-debug-id='surface-components-filespane-7']") {
        filesPaneFolder = "nested";
        filesPaneSelected = false;
        clickedSelectors.push(selector);
      }
      else if (selector === ".fv-row.file [data-debug-id='surface-components-filespane-7']") {
        const path = filesPaneFolder === "nested" ? filesPaneNestedFilePath() : filesPaneSessionFilePath();
        if (!path || !filesPaneSessionPath) {
          return webdriverError(response, 400, "element not interactable", "owned FilesPane file path is missing");
        }
        previewTarget = {
          kind: "file",
          path,
          tabId: activeTab.tabId,
          sessionCwd: filesPaneSessionPath,
        };
        previewFilePath = path;
        previewCenterView = "file";
        ownedModalOpen = "preview";
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Back to session folder']") {
        filesPaneFolder = "session";
        filesPaneSelected = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Up one level']") {
        filesPaneFolder = "parent";
        filesPaneSelected = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Connector editor'] .connector-editor-head > button.settings-pill:not([aria-label])") {
        resetConnectorDraft(true);
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Cancel connector draft']") {
        resetConnectorDraft();
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-connector-id='release-owned-connector-telegram'] .connection-row-meta > button:nth-of-type(2)") {
        if (!connectorsFixtureActive) {
          return webdriverError(response, 400, "element not interactable", "owned Connectors fixture is not active");
        }
        resetConnectorDraft(true);
        connectorEditingId = "release-owned-connector-telegram";
        connectorVaultKey = "release-owned/telegram-token-ref";
        connectorAllowedIds = "release-owned-chat";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='connection-transport-local']"
        || selector === "[data-debug-id='connection-transport-wsl']"
        || selector === "[data-debug-id='connection-transport-ssh']") {
        connectionTransport = selector.includes("-wsl'") ? "wsl" : selector.includes("-ssh'") ? "ssh" : "local";
        clickedSelectors.push(selector);
      }
      else if (/^\[data-debug-id='surface-components-settings-connectorstab-3'\]\[data-provider-kind='(telegram|discord)'\]$/.test(selector)) {
        connectorProvider = selector.includes("'discord'") ? "discord" : "telegram";
        connectorVaultKey = connectorProvider === "discord" ? "discord/bot-token" : "telegram/bot-token";
        connectorAllowedIds = "";
        connectorDispatchMode = "inbox";
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Connector receiver state'] > button:first-child") {
        connectorEnabled = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Connector receiver state'] > button:last-child") {
        connectorEnabled = true;
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Connector delivery mode'] > button:first-child") {
        connectorDispatchMode = "inbox";
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Connector delivery mode'] > button:last-child") {
        connectorDispatchMode = "autoPrompt";
        clickedSelectors.push(selector);
      }
      else if (/^\[data-debug-id='surface-components-rightrail-2'\]\[data-shellx-tool-exposure='(nativeFirst|hostBridge|hostFull|off)'\]$/.test(selector)) {
        activeTab.shellxToolExposure = selector.match(/data-shellx-tool-exposure='([^']+)'/)![1]!;
        clickedSelectors.push(selector);
      }
      else if (generalSettingForSelector(selector)) {
        const setting = generalSettingForSelector(selector)!;
        publicSettings[setting.key] = setting.value;
        if (setting.key === "theme") {
          theme = setting.value;
          persistedTheme = setting.value;
        }
        clickedSelectors.push(selector);
      }
      else if (selector === "[title='Reset to default']") {
        publicSettings.chatFontPx = 19;
        clickedSelectors.push(selector);
      }
      else if (BUILTIN_DOC_BY_SELECTOR[selector]) {
        builtinDoc = BUILTIN_DOC_BY_SELECTOR[selector]!;
        clickedSelectors.push(selector);
      }
      else if (ABOUT_EXTERNAL_URL_BY_SELECTOR[selector]) {
        aboutExternalUrls.push(ABOUT_EXTERNAL_URL_BY_SELECTOR[selector]!);
        clickedSelectors.push(selector);
      }
      else if (/^\[role='dialog'\]\[aria-label='(?:Features|Quick start|Changelog|Third-party notices)'\] \[aria-label='Close \(Esc\)'\]$/.test(selector)) {
        builtinDoc = null;
        clickedSelectors.push(selector);
      }
      else if (selector === ":is([title='Collapse tier'],[title='Expand tier'])") {
        pluginsTierExpanded = !pluginsTierExpanded;
        clickedSelectors.push(selector);
      }
      else if (selector === ":is([title='Collapse all projects'],[title='Expand all projects'])") {
        projectsExpanded = !projectsExpanded;
        clickedSelectors.push(selector);
      }
      else if (selector === ":is([title='Hide open chats — drop here to unfile'],[title='Show open chats — drop here to unfile'])") {
        openChatsExpanded = !openChatsExpanded;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='left-past-chats-toggle']") {
        pastChatsExpanded = !pastChatsExpanded;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='header-theme-toggle']") {
        theme = theme === "bright" ? "black" : "bright";
        persistedTheme = theme;
        publicSettings.theme = theme;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-gitpane-1']") {
        rightRailGitRefreshSequence += 1;
        clickedSelectors.push(selector);
      }
      else if (selector === ".git-actions > button:nth-child(2)") {
        createOwnedGitWriteCheckpoint();
        rightRailGitWriteCheckpointCount += 1;
        clickedSelectors.push(selector);
      }
      else if (selector === ".git-actions > button:nth-child(3)") {
        createOwnedGitWriteWorktree();
        rightRailGitWriteWorktreeCount += 1;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-shellx-release-control='git-review-diff']") {
        rightRailGitDiffScope = "head";
        rightRailGitDiffVisible = true;
        clickedSelectors.push(selector);
      }
      else if (/^\[data-debug-id='surface-components-gitpane-5'\]\[data-git-diff-scope='(head|working|staged|lastCommit)'\]$/.test(selector)) {
        rightRailGitDiffScope = selector.match(/data-git-diff-scope='(head|working|staged|lastCommit)'/)![1]!;
        rightRailGitDiffVisible = true;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-shellx-release-control='model-cards-refresh']") {
        rightRailModelCardsRefreshSequence += 1;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-rightrail-9']") {
        rightRailEnvironmentRefreshSequence += 1;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-release-environment-control='trace']") {
        rightRailEnvironmentTraceReceipt = "release fixture trace export boundary completed";
        clickedSelectors.push(selector);
      }
      else if (completeProviderAction(selector)) {
        // completeProviderAction records the exact native selector.
      }
      else if (selector === "[data-debug-id='surface-components-permissionmodal-1']"
        && permissionFixtureAction === "modal-backdrop-deny") {
        permissionDecision = "deny";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-shellx-release-control='permission-modal-allow']"
        && permissionFixtureAction === "modal-allow") {
        permissionDecision = "allow";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-shellx-release-control='permission-modal-deny']"
        && permissionFixtureAction === "modal-deny") {
        permissionDecision = "deny";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-permissionpill-1']"
        && permissionFixtureAction === "pill-allow") {
        permissionDecision = "allow";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-shellx-release-control='permission-pill-always']"
        && permissionFixtureAction === "pill-always") {
        permissionDecision = "allow_always";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-permissionpill-3']"
        && permissionFixtureAction === "pill-deny") {
        permissionDecision = "deny";
        clickedSelectors.push(selector);
      }
      else if (selector === "[role='dialog'][aria-label='Settings'] [aria-label='Close settings']") {
        settingsOpen = false;
        dataDeleteDialogOpen = false;
        resetConnectorDraft();
        clickedSelectors.push(selector);
      }
      else if (selector === "[role='dialog'][aria-label='Plugins'] [aria-label='Close']") {
        pluginsOpen = false;
        pluginsKeyFormEntryId = null;
        pluginsKeyDraftValue = "";
        clickedSelectors.push(selector);
      }
      else if (OWNED_MODAL_BY_SELECTOR[selector]) {
        const modal = OWNED_MODAL_BY_SELECTOR[selector]!;
        if (ownedModalOpen !== modal.id) {
          return webdriverError(response, 400, "element not interactable", "owned fixture modal is not open");
        }
        ownedModalOpen = null;
        if (modal.id === "preview") previewVideoPlaybackState = "idle";
        if (modal.id === "connectorInbox") resetConnectorInboxManualRefreshReceipt();
        if (modal.id === "vault") {
          vaultWorkspaceModalOpen = false;
          vaultWorkspaceIntent = null;
        }
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='vault-request-open-vault']") {
        vaultRequestCenterOpen = false;
        vaultPasswordGeneratorOpen = false;
        vaultWorkspaceModalOpen = true;
        vaultWorkspaceIntent = "overview";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='vault-request-new-secret']") {
        vaultRequestCenterOpen = false;
        vaultPasswordGeneratorOpen = false;
        vaultWorkspaceModalOpen = true;
        vaultWorkspaceIntent = "newSecret";
        vaultWorkspaceTab = "secrets";
        vaultResourceFormTab = "secret";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='vault-request-generate-password']") {
        vaultPasswordGeneratorOpen = true;
        vaultPasswordRevealed = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='vault-password-generator-close']") {
        vaultPasswordGeneratorOpen = false;
        clickedSelectors.push(selector);
      }
      else if (
        selector === "[data-debug-id='surface-components-vaultpasswordgenerator-5']"
        || selector === "[data-debug-id='vault-password-generator-length']"
      ) {
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-vaultpasswordgenerator-11']") {
        vaultPasswordLowercase = !vaultPasswordLowercase;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='left-add-project']") {
        ownedProjectDraft = true;
        ownedProjectRenaming = true;
        ownedProjectRenameValue = "New project";
        ownedProjectExpanded = false;
        ownedProjectDeleteDialog = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='left-rail']") {
        if (ownedProjectDraft && ownedProjectRenaming) {
          if (ownedProjectRenameValue.length === 0) ownedProjectDraft = false;
          ownedProjectRenaming = false;
        }
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-leftrail-3']" || selector === ".proj-row-main") {
        ownedProjectExpanded = !ownedProjectExpanded;
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Delete project']") {
        ownedProjectDeleteDialog = true;
        clickedSelectors.push(selector);
      }
      else if (selector === ".proj-delete-actions > button:first-child") {
        ownedProjectDraft = false;
        ownedProjectRenaming = false;
        ownedProjectRenameValue = "";
        ownedProjectExpanded = false;
        ownedProjectDeleteDialog = false;
        clickedSelectors.push(selector);
      }
      else if (selector === ":is([aria-label='Hide generated password'],[aria-label='Reveal generated password'])") {
        vaultPasswordRevealed = !vaultPasswordRevealed;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='shellx-browser-agent-pause']" && activeTaskStatus === "running") {
        activeTaskStatus = "paused";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='shellx-browser-agent-resume']" && (activeTaskStatus === "paused" || activeTaskStatus === "userTakeover")) {
        activeTaskStatus = "running";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='shellx-browser-agent-takeover']" && (activeTaskStatus === "running" || activeTaskStatus === "paused")) {
        activeTaskStatus = "userTakeover";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='shellx-browser-agent-abort']" && activeTaskStatus && !["aborted", "blocked", "completed"].includes(activeTaskStatus)) {
        activeTaskStatus = "aborted";
        activeTaskId = null;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='shellx-browser-complete']" && activeTaskStatus === "running") {
        activeTaskStatus = "completed";
        activeTaskId = null;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='shellx-browser-block']" && activeTaskStatus === "running") {
        activeTaskStatus = "blocked";
        activeTaskId = null;
        clickedSelectors.push(selector);
      }
      else if (taskToggleStates[selector]) {
        const toggle = taskToggleStates[selector]!;
        toggle.checked = !toggle.checked;
        taskToggleStorage[toggle.storageKey] = toggle.checked ? "1" : null;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-prcreatemodal-8']") {
        prApprovalChecked = !prApprovalChecked;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-prcreatemodal-10']") {
        if (releaseTestExternalEffectBoundary !== "pr-create") {
          return webdriverError(response, 400, "invalid element state", "fixture PR create boundary is not active");
        }
        if (!prApprovalChecked
          || !(prTextValues["[data-debug-id='pr-base-input']"] ?? "").trim()
          || !(prTextValues["[data-debug-id='pr-title-input']"] ?? "").trim()) {
          return webdriverError(response, 400, "invalid element state", "fixture PR create draft is incomplete or unapproved");
        }
        prCreateBoundaryReceipt = "release fixture PR create stopped before remote mutation";
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Download Grok session artifacts']") {
        if (releaseTestExternalEffectBoundary !== "artifact-archive") {
          return webdriverError(response, 400, "invalid element state", "fixture artifact archive boundary is not active");
        }
        artifactArchiveReceipt = "release fixture artifact archive stopped before save picker";
        clickedSelectors.push(selector);
      }
      else if (selector === ".pr-modal .settings-pills > button:first-child") {
        prDraftActive = !prDraftActive;
        clickedSelectors.push(selector);
      }
      else if (selector === ":is([title='Append the session transcript as an appendix'],[title='No transcript captured yet'])") {
        if (!chatOutputLifecycleActive) {
          return webdriverError(response, 400, "invalid element state", "fixture PR transcript is disabled");
        }
        prTranscriptActive = !prTranscriptActive;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-hashautocomplete-1']") {
        alwaysVisibleTextValues["[data-debug-id='composer-prompt']"] = "[#735: Owned autocomplete fixture](https://example.invalid/shellx/issues/735) ";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='debug-api-retry']") {
        debugUiConnectionFixture = "clear";
        debugUiWebSocketActive = 1;
        debugUiWebSocketGeneration += 1;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-lib-markdown-links-1']") {
        previewTarget = {
          kind: "file",
          path: attachmentMediaImagePath,
          tabId: activeTab.tabId,
        };
        previewFilePath = attachmentMediaImagePath;
        ownedModalOpen = "preview";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-lib-markdown-links-2']") {
        aboutExternalUrls.push("https://example.invalid/shellx/release-docs");
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-release-update-control='right-rail-check']") {
        rightRailUpdateAvailable = true;
        rightRailUpdateReceipt = "release fixture update check completed";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-release-update-control='about-check']") {
        aboutUpdateAvailable = true;
        aboutUpdateReceipt = "release fixture update check completed";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-release-update-control='banner-install']") {
        updateBannerAvailable = false;
        updateBannerReceipt = "release fixture update install boundary completed";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-release-update-control='right-rail-install']") {
        rightRailUpdateAvailable = false;
        rightRailUpdateReceipt = "release fixture update install boundary completed";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-release-update-control='about-install']") {
        aboutUpdateAvailable = false;
        aboutUpdateReceipt = "release fixture update install boundary completed";
        clickedSelectors.push(selector);
      }
      else if (selector === "div[role='status'] > button:first-of-type"
        || selector === ".update-diagnostic .tooling-actions > button:first-child") {
        if ((selector === "div[role='status'] > button:first-of-type" && !updateBannerAvailable)
          || (selector === ".update-diagnostic .tooling-actions > button:first-child" && !rightRailUpdateAvailable)) {
          return webdriverError(response, 400, "element not interactable", "owned update fixture is not available");
        }
        aboutExternalUrls.push("https://github.com/martinsbrezauckis/shellx/releases/tag/v0.3.5-release-fixture");
        clickedSelectors.push(selector);
      }
      else if (selector === ".pr-modal .hardcap-buttons > button:first-child") {
        ownedModalOpen = null;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-connectorinboxmodal-4']") {
        connectorInboxManualRefreshSequence += 1;
        connectorInboxManualRefreshCompletedAtMs = 1_750_000_100_000 + connectorInboxManualRefreshSequence;
        connectorInboxManualRefreshConnectorCount = 2;
        connectorInboxManualRefreshEventCount = 3;
        connectorInboxManualRefreshMaxEventMs = 1_750_000_090_000;
        clickedSelectors.push(selector);
      }
      else if (/^\[data-debug-id='surface-components-connectorinboxmodal-9'\]\[data-inbox='(all|telegram|discord)'\]$/.test(selector)) {
        connectorFilter = selector.match(/data-inbox='(all|telegram|discord)'/)![1]!;
        clickedSelectors.push(selector);
      }
      else if (selector === ".connector-inbox-filters > button.settings-pill") {
        connectorFilter = "all";
        connectorSearchValue = "";
        connectorDateValue = "";
        clickedSelectors.push(selector);
      }
      else if (selector === ".connector-inbox-foot > button.settings-pill") {
        ownedModalOpen = null;
        settingsOpen = true;
        settingsTab = "connectors";
        clickedSelectors.push(selector);
      }
      else if (WORK_PREVIEW_KIND_BY_SELECTOR[selector]) {
        if (rightTab !== "Preview") {
          return webdriverError(response, 400, "element not interactable", "Work Preview kind fixture is not visible");
        }
        workPreviewKind = WORK_PREVIEW_KIND_BY_SELECTOR[selector]!;
        clickedSelectors.push(selector);
      }
      else if (selector === "[id='work-preview-log-height-toggle']") {
        workPreviewLogHeight = workPreviewLogHeight < 360 ? 430 : 260;
        workPreviewLogHeightStored = workPreviewLogHeight === 260 ? null : String(workPreviewLogHeight);
        clickedSelectors.push(selector);
      }
      else if (selector === "[id='work-preview-refresh-state']") {
        renderedPreviewState = structuredClone(previewState ?? idlePreviewState(String(activeTab.tabId ?? "")));
        workPreviewDiagnostic = null;
        previewRefreshes += 1;
        clickedSelectors.push(selector);
      }
      else if (selector === "[id='work-preview-doctor']") {
        const tabId = String(renderedPreviewState?.tabId ?? activeTab.tabId ?? "default");
        const screenshotRoot = join(profileRoot, ".grok", "shellx-preview-screenshots");
        mkdirSync(screenshotRoot, { recursive: true, mode: 0o700 });
        doctorScreenshotPath = join(screenshotRoot, `work-preview-${sanitizeTabId(tabId)}-${Date.now()}.png`);
        writeFileSync(doctorScreenshotPath, Buffer.from("89504e470d0a1a0a", "hex"), { flag: "wx", mode: 0o600 });
        workPreviewDiagnostic = {
          cardClass: "work-preview-doctor-card work-preview-doctor-passed",
          summary: "Preview Doctor passed all checks.",
          http: "HTTP 200",
          title: "ShellX release Preview",
          screenshotPath: doctorScreenshotPath,
          screenshotError: null,
        };
        clickedSelectors.push(selector);
      }
      else if (selector === "[id='preview-center-file-mode']") {
        previewCenterView = "file";
        clickedSelectors.push(selector);
      }
      else if (selector === "[id='preview-center-work-mode']") {
        previewCenterView = "work";
        clickedSelectors.push(selector);
      }
      else if (selector === "[id='file-preview-mode-code']") {
        filePreviewHtmlMode = "code";
        clickedSelectors.push(selector);
      }
      else if (selector === "[id='file-preview-mode-safe-render']") {
        filePreviewHtmlMode = "safe";
        clickedSelectors.push(selector);
      }
      else if (selector === "[id='file-preview-run-work']") {
        const tabId = typeof activeTab.tabId === "string" ? activeTab.tabId : "";
        if (!tabId || !previewFilePath?.endsWith("release-file-preview.html") || !existsSync(previewFilePath)) {
          return webdriverError(response, 400, "element not interactable", "File Preview Run fixture is not owned");
        }
        previewStarts += 1;
        const cwd = dirname(previewFilePath);
        const url = `http://127.0.0.1:${candidateAddress().port}/preview-fixture/release-file-preview.html`;
        const now = Date.now();
        previewState = runningPreviewState(tabId, cwd, url, now);
        renderedPreviewState = structuredClone(previewState);
        previewTarget = { kind: "url", path: previewFilePath, tabId, sessionCwd: cwd };
        previewCenterView = "work";
        clickedSelectors.push(selector);
      }
      else if (selector === "[id='work-preview-open']") {
        ownedModalOpen = "preview";
        previewCenterView = "work";
        clickedSelectors.push(selector);
      }
      else if (selector === "[id='work-preview-restart']") {
        if (!previewState || previewState.status !== "running") {
          return webdriverError(response, 400, "element not interactable", "Work Preview restart fixture is not running");
        }
        previewStarts += 1;
        previewState.updatedAtMs = Math.max(Date.now(), Number(previewState.updatedAtMs ?? 0) + 1);
        previewState.startedAtMs = previewState.updatedAtMs;
        (previewState.logs as Array<Record<string, unknown>>).push({
          t: previewState.updatedAtMs,
          stream: "system",
          line: "preview restarted by shellX",
        });
        workPreviewReloadSeq = 0;
        ownedModalOpen = "preview";
        previewCenterView = "work";
        renderedPreviewState = structuredClone(previewState);
        clickedSelectors.push(selector);
      }
      else if (selector === "[id='work-preview-stop']") {
        if (!previewState || previewState.status !== "running") {
          return webdriverError(response, 400, "element not interactable", "Work Preview stop fixture is not running");
        }
        previewState.status = "stopped";
        previewState.url = null;
        previewState.updatedAtMs = Date.now();
        (previewState.logs as Array<Record<string, unknown>>).push({
          t: previewState.updatedAtMs,
          stream: "system",
          line: "preview stopped by shellX",
        });
        renderedPreviewState = structuredClone(previewState);
        clickedSelectors.push(selector);
      }
      else if (selector === "[id='work-preview-panel-open-external']"
        || selector === "[id='work-preview-stage-open-external']") {
        const url = typeof renderedPreviewState?.url === "string" ? renderedPreviewState.url : null;
        if (!url) {
          return webdriverError(response, 400, "element not interactable", "Work Preview external fixture has no running URL");
        }
        aboutExternalUrls.push(url);
        clickedSelectors.push(selector);
      }
      else if (selector === "[id='work-preview-frame-reload']") {
        workPreviewReloadSeq += 1;
        clickedSelectors.push(selector);
      }
      else if (/^\[id='work-preview-viewport-(phone|tablet|desktop)'\]$/.test(selector)) {
        workPreviewViewport = selector.match(/^\[id='work-preview-viewport-(phone|tablet|desktop)'\]$/)![1]!;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-workpreviewpanel-3']") {
        const tabId = typeof activeTab.tabId === "string" ? activeTab.tabId : "";
        const cwd = typeof activeTab.cwd === "string" ? activeTab.cwd : "";
        if (!tabId || !cwd || rightTab !== "Preview") {
          return webdriverError(response, 400, "element not interactable", "Work Preview fixture has no active project");
        }
        previewStarts += 1;
        const url = `http://127.0.0.1:${candidateAddress().port}/preview-fixture/release-preview.html`;
        const now = Date.now();
        previewState = runningPreviewState(tabId, cwd, url, now);
        renderedPreviewState = structuredClone(previewState);
        workPreviewViewport = "desktop";
        workPreviewReloadSeq = 0;
        ownedModalOpen = "preview";
        previewCenterView = "work";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='bottom-action-trace']") {
        activityOpen = true;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='bottom-action-assets']") {
        ownedModalOpen = "assets";
        clickedSelectors.push(selector);
      }
      else if (selector === "[title^='Delete the '][title$=' on disk + in localStorage']") {
        dataDeleteDialogOpen = true;
        dataDeleteReceipt = null;
        clickedSelectors.push(selector);
      }
      else if (selector === "[id='data-delete-cancel']") {
        dataDeleteDialogOpen = false;
        clickedSelectors.push(selector);
      }
      else if (selector === "[id='data-delete-confirm']") {
        if (!dataDeleteDialogOpen) {
          return webdriverError(response, 400, "element not interactable", "Data delete confirmation is not open");
        }
        const key = "shellX.projects.v1";
        const diskRemoved = Object.hasOwn(ownedUserData, key);
        delete ownedUserData[key];
        dataDeleteDialogOpen = false;
        dataDeleteReceipt = { key, diskRemoved, localStorageCleared: true };
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='composer-connection']") {
        composerPicker = composerPicker === "connection" ? null : "connection";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='composer-agent']") {
        composerPicker = composerPicker === "agent" ? null : "agent";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-bottompanel-23'][data-agent-id='codex-cli']") {
        if (!agentPickerFixtureActive || activeTab.tabId !== bottomPanelOwnedTabId) {
          return webdriverError(response, 400, "element not interactable", "fixture refuses to mutate a non-owned agent tab");
        }
        activeTab = { ...activeTab, agentId: "codex-cli" };
        const tab = openSessionTabs.find((entry) => entry.tabId === activeTab.tabId);
        if (!tab) return webdriverError(response, 404, "stale element reference", "owned agent tab disappeared");
        tab.agentId = "codex-cli";
        composerPicker = null;
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='composer-branch']") {
        composerPicker = composerPicker === "branch" ? null : "branch";
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='surface-components-branchpicker-1'][role='option']") {
        if (composerPicker !== "branch" || typeof activeTab.cwd !== "string"
          || !activeTab.cwd.includes("release-surface-git-")) {
          return webdriverError(response, 400, "element not interactable", "owned BranchPicker Git fixture is not active");
        }
        activeTab.branchName = "release-proof";
        const tab = openSessionTabs.find((entry) => entry.tabId === activeTab.tabId);
        if (!tab || !String(tab.tabId).startsWith("fixture-owned-session-tab-")) {
          return webdriverError(response, 400, "element not interactable", "fixture refuses to mutate a non-owned BranchPicker tab");
        }
        tab.branchName = "release-proof";
        composerPicker = null;
        clickedSelectors.push(selector);
      }
      else if (selector === "[aria-label='Keyboard shortcuts']") {
        keyboardHintOpen = true;
        clickedSelectors.push(selector);
      }
      else if (selector === "[role='dialog'][aria-label='Activity Browser'] [aria-label='Close (Esc)']") {
        activityOpen = false;
        activityEvidenceFocused = null;
        clickedSelectors.push(selector);
      }
      else if (/^\[data-debug-id='activity-evidence-section-(changes|reads|commands|git)-expand'\](?:\[aria-pressed='(?:true|false)'\])?$/.test(selector)) {
        const section = selector.match(/activity-evidence-section-(changes|reads|commands|git)-expand/)?.[1] as typeof activityEvidenceFocused;
        if (!activityOpen || activityView !== "evidence" || !section) {
          return webdriverError(response, 400, "element not interactable", "Activity Evidence fixture is not open");
        }
        activityEvidenceFocused = activityEvidenceFocused === section ? null : section;
        clickedSelectors.push(selector);
      }
      else if (completeBrowserSaveAction(selector)) {
        // The helper records the exact artifact or queued intent and opens Downloads.
      }
      else if (selector === "[data-debug-id='shellx-browser-evidence-record']") {
        recorderIndex += 1;
        recorderStatusVisible = true;
        const receiptId = `fixture-flight-receipt-${recorderIndex}`;
        evidenceReceipts.push({
          receiptId,
          kind: "browserFlightRecorderExported",
          taskId: activeTaskId,
          t: Date.now(),
          evidence: {
            attemptId: `fixture-flight-attempt-${recorderIndex}`,
            taskId: activeTaskId,
            bytes: 1024,
            sha256: "a".repeat(64),
            events: 4,
            receipts: 3,
            gapCount: 0,
            evidenceComplete: true,
          },
        });
        clickedSelectors.push(selector);
      }
      else if (selector === "[data-debug-id='shellx-browser-evidence-refresh']") {
        browserEvidenceManualRefreshSequence += 1;
        browserEvidenceManualRefreshCompletedAtMs = Date.now();
        clickedSelectors.push(selector);
      }
      else {
        const disclosure = BROWSER_DISCLOSURE_BY_SELECTOR[selector];
        const disclosureClose = BROWSER_DISCLOSURE_CLOSE_BY_SELECTOR[selector];
        const tab = TAB_BY_SELECTOR[selector];
        const nextSettingsTab = SETTINGS_TAB_BY_SELECTOR[selector];
        const nextRightTab = RIGHT_TAB_BY_SELECTOR[selector];
        const nextBrowserRightTab = BROWSER_RIGHT_TAB_BY_SELECTOR[selector];
        const nextActivityView = ACTIVITY_VIEW_BY_SELECTOR[selector];
        const nextVaultWorkspaceTab = VAULT_WORKSPACE_TAB_BY_SELECTOR[selector];
        const nextVaultResourceFormTab = VAULT_RESOURCE_FORM_TAB_BY_SELECTOR[selector];
        if (selector === "[data-debug-id='shellx-browser-personal-lock-toggle']") {
          browserDisclosure = "options";
        }
        else if (selector === "[data-debug-id='shellx-browser-personal-lock-now']") {
          if (!browserPersonalLock.enabled || browserPersonalLock.locked) {
            return webdriverError(response, 400, "element not interactable", "Personal Lock cannot lock from the current state");
          }
          browserPersonalLock.locked = true;
        }
        else if (selector === "[data-debug-id='shellx-browser-new-tab']") {
          if (browserPersonalLock.enabled && browserPersonalLock.locked) browserPersonalLockNotice = true;
        }
        else if (
          selector === "[data-debug-id='shellx-browser-personal-unlock-now']"
          ||
          selector === "[data-debug-id='shellx-browser-personal-lock-notice-unlock']"
          || selector === "[data-debug-id='shellx-browser-personal-lock-overlay-unlock']"
        ) {
          if (!browserPersonalLock.enabled || !browserPersonalLock.locked) {
            return webdriverError(response, 400, "element not interactable", "Personal Lock is not locked");
          }
          if (browserPersonalLock.authMode === "pinOnly" && browserPersonalLock.pinConfigured) {
            const enteredDigest = createHash("sha256")
              .update(`fixture-personal-lock:${browserPersonalLockPinDraft}`)
              .digest("hex");
            if (!browserPersonalLockVerifierDigest || enteredDigest !== browserPersonalLockVerifierDigest) {
              return webdriverError(response, 400, "invalid argument", "Personal Lock PIN did not match");
            }
          }
          browserPersonalLock.locked = false;
          browserPersonalLockNotice = false;
          browserPersonalLockPinDraft = "";
        }
        else if (selector === "[data-debug-id='shellx-browser-personal-lock-set-pin']") {
          if (browserPersonalLock.authMode !== "pinOnly" || browserPersonalLockPinDraft.length < 4) {
            return webdriverError(response, 400, "element not interactable", "Personal Lock PIN is not ready");
          }
          browserPersonalLockVerifierDigest = createHash("sha256")
            .update(`fixture-personal-lock:${browserPersonalLockPinDraft}`)
            .digest("hex");
          browserPersonalLock.pinConfigured = true;
          browserPersonalLockPinDraft = "";
        }
        else if (selector === "[data-debug-id='shellx-browser-personal-enable-now']") {
          if (browserPersonalLock.enabled) {
            return webdriverError(response, 400, "element not interactable", "Personal Lock is already enabled");
          }
          browserPersonalLock.enabled = true;
          browserPersonalLock.locked = false;
        }
        else if (selector === "[data-debug-id='shellx-browser-personal-lock-enabled']") {
          browserPersonalLock.enabled = !browserPersonalLock.enabled;
          if (!browserPersonalLock.enabled) {
            browserPersonalLock.locked = false;
            browserPersonalLockNotice = false;
          }
        }
        else if (selector === "[data-debug-id='shellx-browser-personal-lock-blur']") {
          if (!browserPersonalLock.enabled) {
            return webdriverError(response, 400, "element not interactable", "Personal Lock preference is disabled");
          }
          browserPersonalLock.blurLockedTabs = !browserPersonalLock.blurLockedTabs;
        }
        else if (selector === "[data-debug-id='shellx-browser-personal-lock-pause-delegated']") {
          if (!browserPersonalLock.enabled) {
            return webdriverError(response, 400, "element not interactable", "Personal Lock preference is disabled");
          }
          browserPersonalLock.pauseDelegatedTabsWhenLocked = !browserPersonalLock.pauseDelegatedTabsWhenLocked;
        }
        else if (selector === "[data-debug-id='shellx-browser-personal-lock-sleep']") {
          if (!browserPersonalLock.enabled) {
            return webdriverError(response, 400, "element not interactable", "Personal Lock preference is disabled");
          }
          browserPersonalLock.lockOnSleep = !browserPersonalLock.lockOnSleep;
        }
        else if (selector === "[data-debug-id='shellx-browser-personal-lock-minimize']") {
          if (!browserPersonalLock.enabled) {
            return webdriverError(response, 400, "element not interactable", "Personal Lock preference is disabled");
          }
          browserPersonalLock.lockOnMinimize = !browserPersonalLock.lockOnMinimize;
        }
        else if (selector === "[data-debug-id='shellx-browser-history-user']") {
          browserHistoryScope = "user";
        }
        else if (selector === "[data-debug-id='shellx-browser-history-agent']") {
          browserHistoryScope = "agent";
        }
        else if (selector === "[data-debug-id='shellx-browser-bookmark-list-mode']") {
          browserBookmarkManageMode = false;
        }
        else if (selector === "[data-debug-id='shellx-browser-bookmark-manager-toggle']") {
          browserBookmarkManageMode = true;
        }
        else if (selector === "[data-debug-id='shellx-browser-toggle-right-sidebar-button']") {
          browserRightSidebarVisible = false;
        }
        else if (selector === "[data-debug-id='shellx-browser-show-right-sidebar-button']") {
          browserRightSidebarVisible = true;
        }
        else if (selector === "[data-debug-id='shellx-browser-sidebar-resize']") {
          // Pointer focus alone does not change width; the following native key action does.
        }
        else if (selector === "[data-debug-id='shellx-browser-toggle-right-sidebar']") {
          browserRightSidebarVisible = !browserRightSidebarVisible;
        }
        else if (selector === "[data-debug-id='shellx-browser-shields-global-enabled']") {
          browserShields.enabled = !browserShields.enabled;
          browserShields.updatedAtMs += 1;
        }
        else if (selector === "[data-debug-id='surface-browser-components-browsershieldspanel-5']") {
          saveBrowserSiteOverride({ httpsUpgradeEnabled: !activeBrowserShields().httpsUpgradeEnabled });
        }
        else if (selector === "[data-debug-id='shellx-browser-site-shields-script-blocking']") {
          saveBrowserSiteOverride({ scriptBlockingEnabled: !activeBrowserShields().scriptBlockingEnabled });
        }
        else if (selector === "[data-debug-id='shellx-browser-site-shields-save']") {
          saveBrowserSiteOverride({});
        }
        else if (selector === "[data-debug-id='shellx-browser-site-shields-reset']") {
          if (!browserActiveHost) return webdriverError(response, 400, "element not interactable", "fixture Shields host is missing");
          browserShields.siteOverrides = browserShields.siteOverrides.filter((item) => item.host !== browserActiveHost);
          browserShields.updatedAtMs += 1;
        }
        else if (selector === "[data-debug-id='shellx-browser-ad-mode-default']") {
          if (!browserProfileAdModes.has(browserProfileId)) {
            return webdriverError(response, 400, "element not interactable", "profile already uses the global ad mode");
          }
          browserProfileAdModes.delete(browserProfileId);
          browserDisclosure = null;
        }
        else if (/^\[data-debug-id='shellx-browser-ad-mode-(balanced|strict|off)'\]$/.test(selector)) {
          const mode = selector.match(/shellx-browser-ad-mode-(balanced|strict|off)/)?.[1] as "balanced" | "strict" | "off" | undefined;
          if (!mode) return webdriverError(response, 400, "invalid argument", "unknown profile ad mode");
          browserProfileAdModes.set(browserProfileId, mode);
          browserDisclosure = null;
        }
        else if (disclosure) browserDisclosure = browserDisclosure === disclosure.id ? null : disclosure.id;
        else if (disclosureClose && browserDisclosure === disclosureClose) browserDisclosure = null;
        else if (tab) bottomTab = tab;
        else if (nextSettingsTab && settingsOpen) {
          if (nextSettingsTab !== "connectors") resetConnectorDraft();
          if (nextSettingsTab !== "data") dataDeleteDialogOpen = false;
          settingsTab = nextSettingsTab;
        }
        else if (nextRightTab) {
          if (rightTab === "Tasks" && nextRightTab !== "Tasks") {
            agentRunsManualRefreshSequence = 0;
            agentRunsManualRefreshGeneratedAtMs = null;
          }
          rightTab = nextRightTab;
        }
        else if (nextBrowserRightTab) browserRightTab = nextBrowserRightTab;
        else if (nextActivityView && activityOpen) activityView = nextActivityView;
        else if (nextVaultWorkspaceTab && settingsOpen && settingsTab === "vault") {
          vaultWorkspaceTab = nextVaultWorkspaceTab;
        }
        else if (
          nextVaultResourceFormTab
          && settingsOpen
          && settingsTab === "vault"
          && vaultWorkspaceTab === "secrets"
        ) {
          vaultResourceFormTab = nextVaultResourceFormTab;
        }
        else return webdriverError(response, 400, "element not interactable", "unsupported fixture control");
        clickedSelectors.push(selector);
      }
      return webdriverValue(response, null);
    }
    return webdriverError(response, 404, "unknown command", `${request.method} ${path}`);
  } catch (error) {
    return webdriverError(response, 500, "unknown error", error instanceof Error ? error.message : String(error));
  }
});

candidate.listen(0, "127.0.0.1", () => {
  webdriver.listen(0, "127.0.0.1", () => {
    writeFileSync(stateOut, `${JSON.stringify({
      candidatePort: candidateAddress().port,
      webdriverPort: webdriverAddress().port,
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => candidate.close(() => webdriver.close(() => process.exit(0))));
}

function element(selector: string): Record<string, string> {
  return { "element-6066-11e4-a52e-4f735466cecf": `selector:${Buffer.from(selector).toString("base64url")}` };
}

function elementSelector(value: string): string {
  const id = decodeURIComponent(value);
  if (!id.startsWith("selector:")) throw new Error("fixture element id is invalid");
  return Buffer.from(id.slice("selector:".length), "base64url").toString("utf8");
}

function authorized(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 64 * 1024) throw new Error("fixture request is too large");
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("fixture request must be an object");
  return parsed as Record<string, unknown>;
}

function candidateAddress(): { port: number } {
  const address = candidate.address();
  if (!address || typeof address === "string") throw new Error("candidate fixture is not listening");
  return { port: address.port };
}

function webdriverAddress(): { port: number } {
  const address = webdriver.address();
  if (!address || typeof address === "string") throw new Error("WebDriver fixture is not listening");
  return { port: address.port };
}

function webdriverValue(response: ServerResponse, value: unknown): void {
  json(response, 200, { value });
}

function webdriverError(response: ServerResponse, status: number, error: string, message: string): void {
  json(response, status, { value: { error, message, stacktrace: "" } });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function text(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  response.writeHead(status, { "Content-Type": contentType });
  response.end(body);
}

function sessionTabFromActive(value: Record<string, unknown>): Record<string, unknown> {
  return {
    tabId: value.tabId,
    sessionId: null,
    title: "Fixture",
    cwd: value.cwd,
    agentId: null,
    connectionId: value.connectionId ?? null,
    connectionLabel: value.connectionLabel ?? "Local",
    connectionTransport: value.connectionTransport ?? "local",
    projectId: null,
    branchName: null,
    status: "Idle",
    isSending: false,
  };
}

function persistLeftRailUserData(): void {
  if (!leftRailLifecycle) return;
  mkdirSync(dirname(leftRailUserDataPath), { recursive: true, mode: 0o700 });
  const projects = ownedProjectDraft && !ownedProjectRenaming
    ? [{ id: leftRailProjectId, name: ownedProjectRenameValue }]
    : [];
  writeFileSync(leftRailUserDataPath, JSON.stringify({
    "shellX.projects.v1": projects,
    "shellX.chatTitles.v1": { ...leftRailChatTitles },
    "shellX.sessionProjects.v1": { ...leftRailSessionProjects },
    "shellX.session-tabs.v3": openSessionTabs,
  }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

function leftRailLifecycleSelectorDisplayed(selector: string): boolean | null {
  if (!leftRailLifecycle) return null;
  const baseline = openSessionTabs.find((tab) => tab.tabId === baselineActiveTab.tabId);
  const baselineFiled = baseline?.projectId === leftRailProjectId;
  const projectBlock = ".project-block[data-project-id='" + leftRailProjectId + "']";
  const openRow = ".unfiled-row[data-tab-id='" + baselineActiveTab.tabId + "']";
  const pastRow = "[data-debug-id='left-past-chat-row'][data-session-id='" + leftRailOwnedSessionId + "']";
  const projectOpen = projectBlock + " .chat-row[data-tab-id='" + baselineActiveTab.tabId + "']";
  const projectPast = projectBlock + " .chat-row[data-session-id='" + leftRailOwnedSessionId + "']";
  const exact: Record<string, boolean> = {
    [projectBlock]: ownedProjectDraft && !ownedProjectRenaming,
    [projectBlock + " [data-debug-id='surface-components-leftrail-3']"]: ownedProjectDraft && !ownedProjectRenaming,
    [projectBlock + " [data-debug-id='surface-components-leftrail-3'][aria-expanded='true']"]: ownedProjectDraft && !ownedProjectRenaming && ownedProjectExpanded,
    [projectBlock + " .proj-row-main"]: ownedProjectDraft && !ownedProjectRenaming,
    [projectBlock + " [aria-label='Delete project']"]: ownedProjectDraft && !ownedProjectRenaming,
    [openRow + " [title^='Focus tab: ']"]: Boolean(baseline) && !baselineFiled && leftRailRenaming !== "open",
    [openRow + " [data-debug-id='surface-components-rowactions-1']"]: Boolean(baseline) && !baselineFiled && leftRailRenaming !== "open",
    [openRow + " [data-debug-id='surface-components-rowactions-2']"]: Boolean(baseline) && !baselineFiled && leftRailRenaming !== "open",
    [openRow + " [placeholder='Chat title']"]: Boolean(baseline) && !baselineFiled && leftRailRenaming === "open",
    [pastRow + " [title^='Reopen ']"]: leftRailPastAvailable && leftRailSessionProjects[leftRailOwnedSessionId] === undefined && leftRailRenaming !== "past",
    [pastRow + " [data-debug-id='surface-components-rowactions-1']"]: leftRailPastAvailable && leftRailSessionProjects[leftRailOwnedSessionId] === undefined && leftRailRenaming !== "past",
    [pastRow + " [data-debug-id='surface-components-rowactions-2']"]: leftRailPastAvailable && leftRailSessionProjects[leftRailOwnedSessionId] === undefined && leftRailRenaming !== "past",
    [pastRow + " [data-debug-id='left-chat-rename-input']"]: leftRailPastAvailable && leftRailSessionProjects[leftRailOwnedSessionId] === undefined && leftRailRenaming === "past",
    [projectOpen + " [title^='Open chat ']"]: ownedProjectExpanded && baselineFiled,
    [projectPast + " [title^='Reopen ']"]: ownedProjectExpanded && leftRailSessionProjects[leftRailOwnedSessionId] === leftRailProjectId,
    ["[role='menu'][aria-label='Move chat to project']"]: leftRailChatContextOpen,
    ["[role='menu'][aria-label='Move chat to project'] [data-debug-id='surface-components-leftrail-15']"]: leftRailChatContextOpen && ownedProjectDraft,
    ["[role='menu'][aria-label='Move chat to project'] [role='menuitem'].secondary"]: leftRailChatContextOpen,
    ["[role='menu'][aria-label='Move past chat to project']"]: leftRailPastContextOpen,
    ["[role='menu'][aria-label='Move past chat to project'] [data-debug-id='surface-components-leftrail-17']"]: leftRailPastContextOpen && ownedProjectDraft,
    ["[role='menu'][aria-label='Move past chat to project'] [role='menuitem'].secondary"]: leftRailPastContextOpen,
    ["[data-debug-id='surface-components-leftrail-19']"]: ownedProjectDeleteDialog,
    ["[role='alertdialog'][aria-labelledby='proj-del-title'] .proj-delete-actions > button:first-child"]: ownedProjectDeleteDialog,
    ["[role='alertdialog'][aria-labelledby='proj-del-title'] .proj-delete-actions > button:nth-child(2)"]: ownedProjectDeleteDialog
      && leftRailSessionProjects[leftRailOwnedSessionId] === leftRailProjectId,
    ["[role='alertdialog'][aria-labelledby='proj-del-title'] .proj-delete-actions > button:last-child"]: ownedProjectDeleteDialog,
    ["[data-debug-id='surface-components-leftrail-24']"]: leftRailSessionDeleteDialog,
    ["[role='alertdialog'][aria-labelledby='sess-del-title']"]: leftRailSessionDeleteDialog,
    ["[role='alertdialog'][aria-labelledby='sess-del-title'] .proj-delete-actions > button:first-child"]: leftRailSessionDeleteDialog
      && leftRailSessionDeleteTarget === "owned-past",
    ["[role='alertdialog'][aria-labelledby='sess-del-title'] .proj-delete-actions > button:last-child"]: leftRailSessionDeleteDialog,
  };
  if (Object.hasOwn(exact, selector)) return exact[selector]!;
  return null;
}

function openLeftRailContextMenu(selector: string): void {
  if (selector.includes("[title^='Focus tab: ']") || selector.includes("[title^='Open chat ']")) {
    leftRailChatContextOpen = true;
    leftRailPastContextOpen = false;
    return;
  }
  if (selector.includes("[title^='Reopen ']")) {
    leftRailPastContextOpen = true;
    leftRailChatContextOpen = false;
    return;
  }
  throw new Error("fixture refuses a context click outside an exact left-rail chat row");
}

function commitLeftRailRename(selector: string): void {
  if (selector === "[data-debug-id='left-project-rename-input']") {
    if (!ownedProjectRenameValue) ownedProjectDraft = false;
    ownedProjectRenaming = false;
    persistLeftRailUserData();
    return;
  }
  if (leftRailRenaming === "open" && selector.includes("[placeholder='Chat title']")) {
    const tab = openSessionTabs.find((entry) => entry.tabId === baselineActiveTab.tabId);
    if (tab) tab.title = leftRailRenameValue;
    leftRailRenaming = null;
    persistLeftRailUserData();
    return;
  }
  if (leftRailRenaming === "past" && selector.includes("[data-debug-id='left-chat-rename-input']")) {
    leftRailPastTitle = leftRailRenameValue;
    leftRailChatTitles[leftRailOwnedSessionId] = leftRailRenameValue;
    leftRailRenaming = null;
    persistLeftRailUserData();
    return;
  }
  throw new Error("fixture rename commit was not bound to one exact left-rail input");
}

function handleLeftRailClick(selector: string): boolean {
  const projectBlock = ".project-block[data-project-id='" + leftRailProjectId + "']";
  const openRow = ".unfiled-row[data-tab-id='" + baselineActiveTab.tabId + "']";
  const pastRow = "[data-debug-id='left-past-chat-row'][data-session-id='" + leftRailOwnedSessionId + "']";
  const projectOpen = projectBlock + " .chat-row[data-tab-id='" + baselineActiveTab.tabId + "']";
  const projectPast = projectBlock + " .chat-row[data-session-id='" + leftRailOwnedSessionId + "']";
  if (selector === "[data-debug-id='left-add-project']") {
    ownedProjectDraft = true;
    ownedProjectRenaming = true;
    ownedProjectRenameValue = "New project";
    ownedProjectExpanded = false;
    ownedProjectDeleteDialog = false;
    persistLeftRailUserData();
    return true;
  }
  if (selector === projectBlock + " [data-debug-id='surface-components-leftrail-3']"
    || selector === projectBlock + " .proj-row-main") {
    ownedProjectExpanded = !ownedProjectExpanded;
    return true;
  }
  if (selector === projectBlock + " [aria-label='Delete project']") {
    ownedProjectDeleteDialog = true;
    return true;
  }
  if (selector === "[role='alertdialog'][aria-labelledby='proj-del-title'] .proj-delete-actions > button:first-child") {
    ownedProjectDraft = false;
    ownedProjectRenaming = false;
    ownedProjectRenameValue = "";
    ownedProjectExpanded = false;
    ownedProjectDeleteDialog = false;
    persistLeftRailUserData();
    return true;
  }
  if (selector === "[role='alertdialog'][aria-labelledby='proj-del-title'] .proj-delete-actions > button:nth-child(2)") {
    if (leftRailSessionProjects[leftRailOwnedSessionId] !== leftRailProjectId) {
      throw new Error("fixture refuses project session deletion without the exact owned assignment");
    }
    const sessionPath = join(profileRoot, ".shellx", "sessions", leftRailOwnedSessionId + ".jsonl");
    if (!existsSync(sessionPath)) throw new Error("fixture owned project session JSONL was absent before deletion");
    unlinkSync(sessionPath);
    leftRailPastAvailable = false;
    delete leftRailSessionProjects[leftRailOwnedSessionId];
    delete leftRailChatTitles[leftRailOwnedSessionId];
    ownedProjectDraft = false;
    ownedProjectRenaming = false;
    ownedProjectRenameValue = "";
    ownedProjectExpanded = false;
    ownedProjectDeleteDialog = false;
    persistLeftRailUserData();
    return true;
  }
  if (selector === "[role='alertdialog'][aria-labelledby='proj-del-title'] .proj-delete-actions > button:last-child") {
    ownedProjectDeleteDialog = false;
    return true;
  }
  if (selector === "[role='alertdialog'][aria-labelledby='sess-del-title'] .proj-delete-actions > button:last-child") {
    leftRailSessionDeleteDialog = false;
    leftRailSessionDeleteTarget = null;
    return true;
  }
  if (selector === "[role='alertdialog'][aria-labelledby='sess-del-title'] .proj-delete-actions > button:first-child") {
    if (leftRailSessionDeleteTarget !== "owned-past") {
      throw new Error("fixture refuses to delete the baseline operator-shaped session");
    }
    const sessionPath = join(profileRoot, ".shellx", "sessions", leftRailOwnedSessionId + ".jsonl");
    if (!existsSync(sessionPath)) throw new Error("fixture owned session JSONL was absent before deletion");
    unlinkSync(sessionPath);
    leftRailPastAvailable = false;
    delete leftRailSessionProjects[leftRailOwnedSessionId];
    delete leftRailChatTitles[leftRailOwnedSessionId];
    leftRailSessionDeleteDialog = false;
    leftRailSessionDeleteTarget = null;
    persistLeftRailUserData();
    return true;
  }
  if (selector === openRow + " [data-debug-id='surface-components-rowactions-1']") {
    const tab = openSessionTabs.find((entry) => entry.tabId === baselineActiveTab.tabId);
    leftRailRenaming = "open";
    leftRailRenameValue = typeof tab?.title === "string" ? tab.title : "Fixture";
    return true;
  }
  if (selector === pastRow + " [data-debug-id='surface-components-rowactions-1']") {
    leftRailRenaming = "past";
    leftRailRenameValue = leftRailPastTitle;
    return true;
  }
  if (selector === openRow + " [data-debug-id='surface-components-rowactions-2']") {
    leftRailSessionDeleteDialog = true;
    leftRailSessionDeleteTarget = "baseline-open";
    return true;
  }
  if (selector === pastRow + " [data-debug-id='surface-components-rowactions-2']") {
    leftRailSessionDeleteDialog = true;
    leftRailSessionDeleteTarget = "owned-past";
    return true;
  }
  if (selector === openRow + " [title^='Focus tab: ']" || selector === projectOpen + " [title^='Open chat ']") {
    const tab = openSessionTabs.find((entry) => entry.tabId === baselineActiveTab.tabId);
    if (tab) activeTab = activeContextFromSessionTab(tab, activeTab);
    return true;
  }
  if (selector === pastRow + " [title^='Reopen ']" || selector === projectPast + " [title^='Reopen ']") {
    if (!openSessionTabs.some((entry) => entry.sessionId === leftRailOwnedSessionId)) {
      const owned = {
        tabId: leftRailOwnedTabId,
        sessionId: leftRailOwnedSessionId,
        title: leftRailPastTitle,
        cwd: activeTab.cwd,
        agentId: null,
        connectionId: null,
        connectionLabel: "Local",
        connectionTransport: "local",
        projectId: leftRailSessionProjects[leftRailOwnedSessionId] ?? null,
        branchName: null,
        status: "Idle",
        isSending: false,
      };
      openSessionTabs.push(owned);
      activeTab = activeContextFromSessionTab(owned, activeTab);
      persistLeftRailUserData();
    }
    return true;
  }
  if (selector === "[role='menu'][aria-label='Move chat to project'] [data-debug-id='surface-components-leftrail-15']") {
    const tab = openSessionTabs.find((entry) => entry.tabId === baselineActiveTab.tabId);
    if (tab) tab.projectId = leftRailProjectId;
    leftRailChatContextOpen = false;
    persistLeftRailUserData();
    return true;
  }
  if (selector === "[role='menu'][aria-label='Move chat to project'] [role='menuitem'].secondary") {
    const tab = openSessionTabs.find((entry) => entry.tabId === baselineActiveTab.tabId);
    if (tab) tab.projectId = null;
    leftRailChatContextOpen = false;
    persistLeftRailUserData();
    return true;
  }
  if (selector === "[role='menu'][aria-label='Move past chat to project'] [data-debug-id='surface-components-leftrail-17']") {
    leftRailSessionProjects[leftRailOwnedSessionId] = leftRailProjectId;
    leftRailPastContextOpen = false;
    persistLeftRailUserData();
    return true;
  }
  if (selector === "[role='menu'][aria-label='Move past chat to project'] [role='menuitem'].secondary") {
    delete leftRailSessionProjects[leftRailOwnedSessionId];
    leftRailPastContextOpen = false;
    persistLeftRailUserData();
    return true;
  }
  if (selector === "[data-tab-id='" + leftRailOwnedTabId + "'] [aria-label='Close session']") {
    openSessionTabs = openSessionTabs.filter((entry) => entry.tabId !== leftRailOwnedTabId);
    const baseline = openSessionTabs.find((entry) => entry.tabId === baselineActiveTab.tabId);
    if (baseline) activeTab = activeContextFromSessionTab(baseline, activeTab);
    persistLeftRailUserData();
    return true;
  }
  if (selector === "[data-tab-id='" + baselineActiveTab.tabId + "']") {
    const baseline = openSessionTabs.find((entry) => entry.tabId === baselineActiveTab.tabId);
    if (baseline) activeTab = activeContextFromSessionTab(baseline, activeTab);
    return true;
  }
  return false;
}

function activeContextFromSessionTab(
  tab: Record<string, unknown>,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tabId: tab.tabId,
    cwd: tab.cwd ?? fallback.cwd,
    autonomy: fallback.autonomy ?? "default",
    connectionId: tab.connectionId ?? null,
    connectionLabel: tab.connectionLabel ?? "Local",
    connectionTransport: tab.connectionTransport ?? "local",
    shellxToolExposure: fallback.shellxToolExposure ?? "nativeFirst",
  };
}

function idlePreviewState(tabId: string): Record<string, unknown> {
  return {
    tabId,
    cwd: null,
    kind: null,
    status: "idle",
    url: null,
    command: null,
    taskId: null,
    pid: null,
    startedAtMs: null,
    updatedAtMs: Date.now(),
    viewportHint: null,
    error: null,
    logs: [],
  };
}

function runningPreviewState(tabId: string, cwd: string, url: string, now: number): Record<string, unknown> {
  return {
    tabId,
    cwd,
    kind: "staticHtml",
    status: "running",
    url,
    command: "shellX static file server",
    taskId: null,
    pid: null,
    startedAtMs: now,
    updatedAtMs: now,
    viewportHint: null,
    error: null,
    logs: [
      { t: now, stream: "system", line: "selected static entry release-preview.html" },
      { t: now, stream: "system", line: `serving ${cwd} at ${url}` },
    ],
  };
}

function sanitizeTabId(value: string): string {
  const filtered = [...value.trim()]
    .filter((character) => /[A-Za-z0-9._-]/.test(character))
    .slice(0, 80)
    .join("")
    .replace(/^\.+|\.+$/g, "");
  return filtered || "default";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function generalSettingForSelector(selector: string): {
  key: "density" | "permissionUx" | "theme";
  value: string;
} | null {
  const density = selector.match(/^\[data-debug-id='settings-density-(compact|default|comfortable)'\]$/)?.[1];
  if (density) return { key: "density", value: density };
  const permissionUx = selector.match(/^\[data-debug-id='settings-permission-ux-(pill|modal|both)'\]$/)?.[1];
  if (permissionUx) return { key: "permissionUx", value: permissionUx };
  const themes: Record<string, string> = {
    "[aria-label='Use Black theme']": "black",
    "[aria-label='Use Black and warm theme']": "black_warm",
    "[aria-label='Use Bright theme']": "bright",
  };
  return themes[selector] ? { key: "theme", value: themes[selector]! } : null;
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
