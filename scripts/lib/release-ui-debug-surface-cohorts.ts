import type { ReleaseSurfaceItem } from "./release-surface-inventory";

export type ReleaseUiDebugSurface = "app" | "browser";

export interface ReleaseUiDebugPatchStep {
  patch: Record<string, unknown>;
  delayMs?: number;
}

export interface ReleaseUiDebugOwnedBookmark {
  bookmarkId: string;
  kind: "folder" | "link";
  label: string;
  url?: string;
  parentId?: string;
  toolbarPinned?: boolean;
  toolbarOrder?: number;
  agentWorkflow?: {
    recipePath: string;
    goal?: string;
  };
}

export interface ReleaseUiDebugFixtureSpec {
  id: string;
  debugSurface: ReleaseUiDebugSurface;
  setup:
    | {
        kind: "app-state";
        patch: Record<string, unknown>;
        steps?: readonly ReleaseUiDebugPatchStep[];
        cleanupSteps?: readonly ReleaseUiDebugPatchStep[];
        cleanupReadySelector?: string;
        cleanupAbsentSelector?: string;
        preserveSettingsTab?: boolean;
        ownedSessionHistory?: boolean;
        ownedSessionHistorySurface?: boolean;
        ownedCwdPicker?: "empty" | "with-child";
        ownedGitRepo?: boolean;
        ownedConnectionPreset?: boolean;
        ownedFilesPane?: boolean;
        ownedPreviewFile?: "video" | "markdown";
        ownedPendingAttachment?: boolean;
        ownedRendererEventProjection?: boolean;
        ownedActivityBrowser?: boolean;
        ownedVaultAgentRequest?: boolean;
        ownedVaultGrant?: boolean;
        ownedWorkPreviewIssue?: boolean;
        cleanupAfterRestoreAbsentSelector?: string;
        ownedVaultSecret?: { key: string; value: string };
        ownedVaultLifecycle?: "setup-recovery-kit" | "configured-unlocked" | "configured-locked" | "configured-remembered";
      }
    | {
        kind: "owned-browser-task";
        rightTab: "chat" | "requests" | "actions" | "evidence" | "errors";
        steps?: readonly ReleaseUiDebugPatchStep[];
        cleanupSteps?: readonly ReleaseUiDebugPatchStep[];
        cleanupAbsentSelector?: string;
        ownedBookmarks?: readonly ReleaseUiDebugOwnedBookmark[];
        ownedDownloadIntent?: boolean;
      };
}

export interface ReleaseUiDebugSurfaceCohort {
  fixtureId: string;
  debugSurface: ReleaseUiDebugSurface;
}

const OWNED_BOOKMARK_LINK: readonly ReleaseUiDebugOwnedBookmark[] = [{
  bookmarkId: "final-surface-link",
  kind: "link",
  label: "Final surface link",
  url: "https://example.invalid/final-surface",
}];
const OWNED_BOOKMARK_FOLDER: readonly ReleaseUiDebugOwnedBookmark[] = [{
  bookmarkId: "final-surface-folder",
  kind: "folder",
  label: "Final surface folder",
}];
const OWNED_BOOKMARK_MANAGER: readonly ReleaseUiDebugOwnedBookmark[] = [
  ...OWNED_BOOKMARK_LINK,
  ...OWNED_BOOKMARK_FOLDER,
];
const OWNED_BOOKMARK_TOOLBAR: readonly ReleaseUiDebugOwnedBookmark[] = [
  {
    bookmarkId: "final-surface-toolbar-link",
    kind: "link",
    label: "Final surface toolbar link",
    url: "https://example.invalid/final-surface-toolbar",
    toolbarPinned: true,
    toolbarOrder: 1,
  },
  {
    bookmarkId: "final-surface-toolbar-folder",
    kind: "folder",
    label: "Final surface toolbar folder",
    toolbarPinned: true,
    toolbarOrder: 2,
  },
  {
    bookmarkId: "final-surface-toolbar-child",
    kind: "link",
    label: "Final surface toolbar child",
    url: "https://example.invalid/final-surface-child",
    parentId: "final-surface-toolbar-folder",
  },
];
const OWNED_BOOKMARK_MISSING_WORKFLOW: readonly ReleaseUiDebugOwnedBookmark[] = [{
  bookmarkId: "final-surface-missing-workflow",
  kind: "link",
  label: "Final surface missing workflow",
  agentWorkflow: {
    recipePath: "__SHELLX_RELEASE_OWNED_MISSING_RECIPE__",
    goal: "Prove the bounded saved-workflow preview error state",
  },
}];
const OWNED_VAULT_SECRET = {
  key: "release-surface-ui-owned-secret",
  value: "SHELLX_RELEASE_UI_DEBUG_SECRET_VALUE",
} as const;
const OWNED_VAULT_SETUP_PASSPHRASE = "ShellX-Release-UI-Vault-Passphrase-035";
const OWNED_PROJECT_DRAFT_CLEANUP_STEPS = [
  inputStep("[data-debug-id='left-project-rename-input']", "", "Enter"),
] as const;
const OWNED_PROJECT_DIALOG_CLEANUP_STEPS = [
  clickStep(".proj-delete-actions > button:first-child"),
] as const;
const OWNED_PROJECT_SETUP_STEPS = [
  clickStep("[data-debug-id='left-add-project']"),
  inputStep("[data-debug-id='left-project-rename-input']", "ShellX final owned project", "Enter"),
] as const;
const OWNED_PROJECT_DELETE_STEPS = [
  clickStep("[aria-label='Delete project']"),
  clickStep(".proj-delete-actions > button:first-child"),
] as const;

const fixtures = [
  appFixture("ui:app-shell-visible", {}),
  appFixture(
    "ui:agent-cli-setup-owned-cards-visible",
    { agentCliSetupFixture: "cards" },
    undefined,
    [{ patch: { agentCliSetupFixture: "closed" } }],
    { cleanupAbsentSelector: "[data-debug-id='agent-cli-setup-dialog']" },
  ),
  appFixture(
    "ui:agent-cli-setup-owned-confirmation-visible",
    { agentCliSetupFixture: "confirmation" },
    undefined,
    [{ patch: { agentCliSetupFixture: "closed" } }],
    { cleanupAbsentSelector: "[data-debug-id='agent-cli-setup-dialog']" },
  ),
  appFixture(
    "ui:goal-plan-review-owned-visible",
    { goalPlanReviewFixture: "review" },
    undefined,
    [{ patch: { goalPlanReviewFixture: "closed" } }],
    { cleanupAbsentSelector: "[role='dialog'][aria-label^='Review plan:']" },
  ),
  appFixture(
    "ui:goal-plan-review-owned-editing-visible",
    { goalPlanReviewFixture: "editing" },
    undefined,
    [{ patch: { goalPlanReviewFixture: "closed" } }],
    { cleanupAbsentSelector: "[role='dialog'][aria-label^='Review plan:']" },
  ),
  appFixture(
    "ui:agent-cli-status-owned-setup-controls-visible",
    { rightTab: "Tooling", agentCliSetupFixture: "status-card" },
    undefined,
    [{ patch: { agentCliSetupFixture: "closed" } }],
    { cleanupAbsentSelector: "[data-debug-id='agent-cli-setup-dialog']" },
  ),
  appFixture("ui:find-open-row-visible", {}, [
    inputStep("[data-debug-id='find-sessions-input']", ""),
  ], [
    inputKeyStep("[data-debug-id='find-sessions-input']", "Escape"),
  ]),
  appFixture("ui:find-disk-row-visible", {}, [
    inputStep("[data-debug-id='find-sessions-input']", "SHELLX_RELEASE_SESSION_CANARY"),
  ], [
    inputKeyStep("[data-debug-id='find-sessions-input']", "Escape"),
  ], { ownedSessionHistory: true }),
  appFixture("ui:owned-past-chat-visible", { refreshPastChats: true }, undefined, undefined, {
    ownedSessionHistorySurface: true,
  }),
  appFixture("ui:owned-past-chat-rename-visible", { refreshPastChats: true }, [
    clickStep("[data-debug-id='left-past-chat-row'] [aria-label='Rename chat']"),
  ], [
    inputKeyStep("[data-debug-id='left-chat-rename-input']", "Escape"),
  ], {
    ownedSessionHistorySurface: true,
    cleanupAbsentSelector: "[data-debug-id=\"left-chat-rename-input\"]",
  }),
  appFixture("ui:owned-open-chat-context-menu-visible", {}, [
    ...OWNED_PROJECT_SETUP_STEPS,
    inputKeyStep(".unfiled-row.active > .unfiled-row-main", "ContextMenu"),
  ], [
    inputKeyStep("[role='menu'][aria-label='Move chat to project']", "Escape"),
    ...OWNED_PROJECT_DELETE_STEPS,
  ], {
    cleanupReadySelector: "[data-debug-id=\"surface-components-leftrail-15\"]",
    cleanupAbsentSelector: "[data-debug-id=\"left-project-row\"]",
  }),
  appFixture("ui:owned-past-chat-context-menu-visible", { refreshPastChats: true }, [
    ...OWNED_PROJECT_SETUP_STEPS,
    inputKeyStep("[data-debug-id='left-past-chat-row'] > .unfiled-row-main", "ContextMenu"),
  ], [
    inputKeyStep("[role='menu'][aria-label='Move past chat to project']", "Escape"),
    ...OWNED_PROJECT_DELETE_STEPS,
  ], {
    ownedSessionHistorySurface: true,
    cleanupReadySelector: "[data-debug-id=\"surface-components-leftrail-17\"]",
    cleanupAbsentSelector: "[data-debug-id=\"left-project-row\"]",
  }),
  appFixture("ui:setup-guide-visible", { setupGuideDismissed: false }),
  appFixture("ui:owned-project-draft-visible", {}, [
    clickStep("[data-debug-id='left-add-project']"),
  ], OWNED_PROJECT_DRAFT_CLEANUP_STEPS, {
    cleanupReadySelector: "[data-debug-id=\"left-project-rename-input\"]",
    cleanupAbsentSelector: "[data-debug-id=\"left-project-row\"]",
  }),
  appFixture("ui:owned-project-delete-dialog-visible", {}, [
    clickStep("[data-debug-id='left-add-project']"),
    inputStep(
      "[data-debug-id='left-project-rename-input']",
      "ShellX final owned project",
      "Enter",
    ),
    clickStep("[aria-label='Delete project']"),
  ], OWNED_PROJECT_DIALOG_CLEANUP_STEPS, {
    cleanupReadySelector: ".proj-delete-actions > button:first-child",
    cleanupAbsentSelector: "[data-debug-id=\"left-project-row\"]",
  }),
  appFixture("ui:bottom-chat-visible", { bottomTab: "Chat" }),
  appFixture("ui:right-rail-tasks-visible", { rightTab: "Tasks" }),
  appFixture(
    "ui:owned-tasks-panel-row-visible",
    { rightTab: "Tasks", debugClipboardFixture: "tasks" },
    undefined,
    [{ patch: { debugClipboardFixture: "clear" } }],
  ),
  appFixture("ui:right-rail-files-visible", { rightTab: "Files" }),
  appFixture("ui:right-rail-git-visible", { rightTab: "Git" }),
  appFixture("ui:right-rail-tooling-visible", { rightTab: "Tooling" }),
  appFixture(
    "ui:right-rail-owned-connector-action-visible",
    {
      rightTab: "Tooling",
      debugRendererFixture: {
        id: "provider-action-lifecycle",
        action: "right-rail-connector-action",
        cwd: ".",
      },
    },
    undefined,
    [{ patch: { debugRendererFixture: "clear" } }],
  ),
  appFixture("ui:right-rail-preview-visible", { rightTab: "Preview" }),
  appFixture("ui:settings-tab-strip-visible", { openModal: "settings" }),
  settingsFixture("ui:settings-general-visible", "general"),
  settingsFixture("ui:settings-about-visible", "about"),
  settingsFixture("ui:builtin-doc-visible", "about", [
    clickStep("[title='Read the shellX features overview']"),
  ]),
  settingsFixture("ui:settings-connections-visible", "connections"),
  appFixture("ui:settings-connectors-visible", {
    debugConnectorsFixture: "owned-safe",
    openModal: "settings",
  }, [
    clickStep("[data-debug-id='settings-tab-connectors']"),
    clickStep("[aria-label='Connector editor'] .connector-editor-head > button.settings-pill:not([aria-label])"),
  ], [
    { patch: { openModal: "close", debugConnectorsFixture: "clear" } },
  ], {
    preserveSettingsTab: true,
    cleanupAbsentSelector: "[data-connectors-debug-fixture='owned-safe']",
  }),
  appFixture("ui:settings-connectors-fixed-target-visible", {
    debugConnectorsFixture: "owned-safe",
    openModal: "settings",
  }, [
    clickStep("[data-debug-id='settings-tab-connectors']"),
    clickStep("[aria-label='Connector editor'] .connector-editor-head > button.settings-pill:not([aria-label])"),
    inputStep("#connector-target", "fixedTab"),
  ], [
    { patch: { openModal: "close", debugConnectorsFixture: "clear" } },
  ], {
    preserveSettingsTab: true,
    cleanupAbsentSelector: "[data-connectors-debug-fixture='owned-safe']",
  }),
  settingsFixture("ui:settings-desktop-visible", "desktop"),
  shellxagentSettingsFixture(),
  settingsFixture("ui:connection-editor-local-visible", "connections", [
    clickStep(".connections-header button[title='Add a new connection preset']"),
  ]),
  settingsFixture("ui:connection-editor-wsl-visible", "connections", [
    clickStep(".connections-header button[title='Add a new connection preset']"),
    clickStep("[data-debug-id='connection-transport-wsl']"),
  ]),
  settingsFixture("ui:connection-editor-ssh-visible", "connections", [
    clickStep(".connections-header button[title='Add a new connection preset']"),
    clickStep("[data-debug-id='connection-transport-ssh']"),
  ]),
  settingsFixture("ui:connection-editor-windows-wsl-visible", "connections", [
    clickStep(".connections-header button[title='Add a new connection preset']"),
    clickStep("[data-debug-id='connection-transport-ssh']"),
    inputStep("[data-debug-id='connection-ssh-runtime-select']", "windows_wsl"),
  ]),
  appFixture("ui:command-palette-visible", { openModal: "palette" }),
  appFixture("ui:help-modal-visible", { openModal: "help" }),
  appFixture("ui:build-plan-review-owned-ready-visible", {
    debugBuildPlanFixture: "owned-ready",
    openModal: "buildPlanReview",
  }, undefined, [
    { patch: { openModal: "close", debugBuildPlanFixture: "clear" } },
  ], {
    cleanupAbsentSelector: "[data-debug-id=\"surface-components-buildplanreviewmodal-1\"]",
  }),
  appFixture("ui:plugins-modal-visible", { openModal: "plugins" }),
  appFixture("ui:plugins-owned-marketplace-visible", {
    debugPluginsFixture: "owned-safe",
    openModal: "plugins",
  }, undefined, [
    { patch: { openModal: "close", debugPluginsFixture: "clear" } },
  ], {
    cleanupAbsentSelector: "[data-marketplace-entry-id='release-owned-recommended']",
  }),
  appFixture("ui:plugins-owned-key-form-visible", {
    debugPluginsFixture: "owned-safe",
    openModal: "plugins",
  }, [
    clickStep("[data-marketplace-entry-id='release-owned-installed-key'] [title='Enter your API key inline']"),
  ], [
    clickStep("[data-marketplace-entry-id='release-owned-installed-key'] [title='Cancel adding key (clears input)']"),
    { patch: { openModal: "close", debugPluginsFixture: "clear" } },
  ], {
    cleanupAbsentSelector: "[data-marketplace-entry-id='release-owned-recommended']",
  }),
  appFixture("ui:connector-inbox-visible", { openModal: "connectorInbox" }),
  appFixture("ui:asset-board-visible", { openModal: "assets" }),
  appFixture("ui:preview-center-visible", { openModal: "preview" }),
  appFixture("ui:file-preview-visible", {
    preview: { path: "shellx-final-owned-preview.fixture", kind: "file" },
    openModal: "preview",
  }, undefined, [
    { patch: { clearPreview: true } },
  ]),
  appFixture("ui:activity-browser-visible", { openModal: "activity" }),
  appFixture("ui:activity-search-active-visible", { openModal: "activity" }, [
    inputStep("[data-debug-id='activity-search']", "release"),
  ]),
  appFixture("ui:activity-evidence-visible", { openModal: "activity" }, [
    clickStep("[data-debug-id='activity-tab-evidence']"),
  ]),
  appFixture("ui:owned-activity-files-visible", { openModal: "activity" }, undefined, undefined, {
    ownedActivityBrowser: true,
  }),
  appFixture("ui:owned-activity-graph-visible", { openModal: "activity" }, [
    clickStep("[data-debug-id='activity-tab-graph']"),
  ], undefined, { ownedActivityBrowser: true }),
  appFixture("ui:owned-activity-graph-selected-visible", { openModal: "activity" }, [
    clickStep("[data-debug-id='activity-tab-graph']"),
    clickStep("[data-debug-id='surface-components-activitybrowsermodal-14'][title='src/nested/owned-activity.ts']"),
  ], undefined, { ownedActivityBrowser: true }),
  appFixture("ui:owned-activity-timeline-visible", { openModal: "activity" }, [
    clickStep("[data-debug-id='activity-tab-timeline']"),
  ], undefined, { ownedActivityBrowser: true }),
  appFixture("ui:owned-activity-evidence-rows-visible", { openModal: "activity" }, [
    clickStep("[data-debug-id='activity-tab-evidence']"),
  ], undefined, { ownedActivityBrowser: true }),
  appFixture("ui:session-rename-visible", { openModal: "close" }, [
    clickStep("[aria-label='Rename session']"),
  ], [
    inputKeyStep("[data-debug-id='session-rename-input']", "Escape"),
  ], { cleanupAbsentSelector: "[data-debug-id='session-rename-input']" }),
  appFixture("ui:session-preview-visible", {
    openModal: "close",
    preview: { kind: "file", path: "shellx-final-owned-session-preview.fixture" },
  }, undefined, [
    { patch: { clearPreview: true } },
  ], { cleanupAbsentSelector: "[data-debug-id='surface-components-sessiontabs-4']" }),
  appFixture("ui:session-preview-dropdown-visible", {
    openModal: "close",
    preview: { kind: "file", path: "shellx-final-owned-session-preview.fixture" },
  }, [
    clickStep("[aria-label='All sessions']"),
  ], [
    clickStep("[aria-label='All sessions']"),
    { patch: { clearPreview: true } },
  ], { cleanupAbsentSelector: "[data-debug-id='surface-components-sessiontabs-11']" }),
  appFixture("ui:session-delete-dialog-visible", { openModal: "close" }, [
    clickStep("[aria-label='Delete this session']"),
  ], [
    clickStep("[role='alertdialog'] .proj-delete-actions > button:last-child"),
  ], { cleanupAbsentSelector: "[data-debug-id='surface-components-leftrail-24']" }),
  appFixture("ui:pr-modal-visible", { openModal: "pr" }),
  appFixture("ui:vault-workspace-visible", { openModal: "vault" }),
  appOwnedVaultFixture("ui:vault-owned-secret-visible"),
  appOwnedVaultFixture("ui:vault-owned-secret-metadata-visible", [
    clickStep(`[aria-label='Edit metadata for ${OWNED_VAULT_SECRET.key}']`),
  ]),
  appOwnedVaultFixture("ui:vault-owned-secret-replace-visible", [
    clickStep(`[aria-label='Replace value for ${OWNED_VAULT_SECRET.key}']`),
  ]),
  appOwnedVaultLifecycleFixture("ui:vault-configured-unlocked-visible", "configured-unlocked"),
  appOwnedVaultLifecycleFixture("ui:vault-configured-locked-visible", "configured-locked"),
  appOwnedVaultLifecycleFixture("ui:vault-configured-remembered-visible", "configured-remembered"),
  appFixture("ui:vault-setup-unconfigured-visible", { openModal: "vault" }, [
    clickStep("[data-debug-id='vault-tab-setup']"),
  ]),
  appFixture(
    "ui:vault-profile-collision-owned",
    { openModal: "settings", debugClipboardFixture: "vault-draft" },
    [clickStep("[data-debug-id='vault-tab-setup']")],
    [{ patch: { debugClipboardFixture: "clear" } }],
    { preserveSettingsTab: true },
  ),
  appOwnedVaultRecoveryKitFixture(),
  appFixture("ui:vault-password-generator-visible", { openModal: "vault" }, [
    clickStep("[data-debug-id='vault-generate-password']"),
  ]),
  appFixture("ui:vault-profile-card-form-visible", { openModal: "vault" }, [
    clickStep("[data-debug-id='vault-resource-form-tab-profileCard']"),
  ]),
  appFixture("ui:vault-agent-wallet-form-visible", { openModal: "vault" }, [
    clickStep("[data-debug-id='vault-resource-form-tab-stripeAgentWallet']"),
  ]),
  appFixture("ui:vault-grants-visible", { openModal: "vault" }, [
    clickStep("[data-debug-id='vault-tab-grants']"),
  ]),
  appFixture("ui:vault-request-center-visible", { vaultRequestCenterOpen: true }),
  appFixture("ui:remote-cwd-picker-visible", {
    cwdPicker: { path: "/", label: "Final surface owned folder" },
  }),
  appFixture("ui:owned-remote-cwd-empty-visible", {}, undefined, [
    { patch: { cwdPicker: { open: false } } },
  ], {
    ownedCwdPicker: "empty",
    cleanupAbsentSelector: "[data-debug-id=\"remote-cwd-parent\"]",
  }),
  appFixture("ui:owned-remote-cwd-folder-visible", {}, undefined, [
    { patch: { cwdPicker: { open: false } } },
  ], {
    ownedCwdPicker: "with-child",
    cleanupAbsentSelector: "[data-debug-id=\"remote-cwd-folder\"]",
  }),
  appFixture("ui:owned-branch-picker-row-visible", { composerMenu: "branch" }, undefined, [
    { patch: { composerMenu: "close" } },
  ], {
    ownedGitRepo: true,
    cleanupAbsentSelector: "[data-debug-id=\"surface-components-branchpicker-1\"]",
  }),
  appFixture("ui:owned-connection-picker-row-visible", { composerMenu: "connection" }, undefined, [
    { patch: { composerMenu: "close" } },
  ], {
    ownedConnectionPreset: true,
    cleanupAbsentSelector: "[data-debug-id=\"surface-components-connectionpicker-3\"]",
  }),
  appFixture("ui:owned-connection-editor-scanned-visible", { composerMenu: "connection" }, [
    clickStep("[data-debug-id='surface-components-connectionpicker-3'] > button:nth-of-type(2)"),
  ], [
    clickStep("[aria-label='Close connection editor']"),
    { patch: { composerMenu: "close" } },
  ], {
    ownedConnectionPreset: true,
    cleanupAbsentSelector: "[data-debug-id=\"connection-agent-cli-setup-open\"]",
  }),
  appFixture("ui:owned-agent-picker-row-visible", { composerMenu: "connection" }, [
    clickStep(".connection-row-main"),
    { patch: { composerMenu: "agent" }, delayMs: 350 },
  ], [
    { patch: { composerMenu: "close" } },
  ], {
    ownedConnectionPreset: true,
    cleanupAbsentSelector: "[data-debug-id=\"surface-components-bottompanel-23\"]",
  }),
  appFixture("ui:owned-slash-command-row-visible", { composerMenu: "slash" }, undefined, [
    { patch: { composerMenu: "close" } },
  ], {
    cleanupAbsentSelector: "[data-debug-id=\"surface-components-bottompanel-24\"]",
  }),
  appFixture("ui:owned-files-pane-row-visible", { rightTab: "Files" }, undefined, undefined, {
    ownedFilesPane: true,
    cleanupAfterRestoreAbsentSelector: "[data-debug-id=\"surface-components-filespane-7\"]",
  }),
  appFixture(
    "ui:owned-work-preview-browser-issue-visible",
    { rightTab: "Preview" },
    [{ patch: { openModal: "workPreview" }, delayMs: 1_000 }],
    [{ patch: { openModal: "close" } }],
    {
      ownedWorkPreviewIssue: true,
      cleanupAbsentSelector: "[data-debug-id=\"surface-components-workpreviewpanel-16\"]",
    },
  ),
  appFixture("ui:owned-video-preview-visible", { openModal: "preview" }, undefined, [
    { patch: { clearPreview: true } },
  ], {
    ownedPreviewFile: "video",
    cleanupAbsentSelector: "[data-debug-id=\"surface-components-mediapreview-1\"]",
  }),
  appFixture("ui:owned-markdown-preview-links-visible", { openModal: "preview" }, undefined, [
    { patch: { clearPreview: true } },
  ], {
    ownedPreviewFile: "markdown",
    cleanupAbsentSelector: "[data-debug-id=\"surface-lib-markdown-links-1\"]",
  }),
  appFixture("ui:owned-pending-attachment-visible", { openModal: "assets" }, undefined, undefined, {
    ownedPendingAttachment: true,
    cleanupAbsentSelector: "[data-debug-id=\"surface-components-attachmentmediaboard-9\"]",
  }),
  appFixture(
    "ui:debug-api-disconnected-banner-visible",
    { debugUiConnectionFixture: "disconnected" },
    undefined,
    [{ patch: { debugUiConnectionFixture: "clear" } }],
    { cleanupAbsentSelector: "[data-debug-id=\"debug-api-disconnected\"]" },
  ),
  appFixture(
    "ui:owned-hash-autocomplete-row-visible",
    { debugHashItems: "owned" },
    [inputStep("[data-debug-id='composer-prompt']", "#735")],
    [
      inputStep("[data-debug-id='composer-prompt']", ""),
      { patch: { debugHashItems: "clear" } },
    ],
    { cleanupAbsentSelector: "[data-debug-id=\"surface-components-hashautocomplete-1\"]" },
  ),
  appFixture("ui:owned-renderer-event-chat-visible", { bottomTab: "Chat" }, undefined, [
    { patch: { debugRendererFixture: "clear" } },
  ], {
    ownedRendererEventProjection: true,
    cleanupAbsentSelector: "[data-debug-id=\"surface-components-permissionpill-1\"]",
  }),
  appFixture("ui:owned-renderer-event-assets-visible", { openModal: "assets" }, undefined, [
    { patch: { debugRendererFixture: "clear" } },
  ], {
    ownedRendererEventProjection: true,
    cleanupAbsentSelector: "[data-debug-id=\"surface-components-attachmentmediaboard-12\"]",
  }),
  appFixture("ui:owned-renderer-event-image-visible", { bottomTab: "Images" }, undefined, [
    { patch: { debugRendererFixture: "clear" } },
  ], {
    ownedRendererEventProjection: true,
    cleanupAbsentSelector: "[data-debug-id=\"surface-components-bottompanel-9\"]",
  }),
  appFixture("ui:owned-vault-agent-request-visible", { vaultRequestCenterOpen: true }, undefined, undefined, {
    ownedVaultAgentRequest: true,
    cleanupAfterRestoreAbsentSelector: "[data-debug-id=\"vault-request-center-item\"]",
  }),
  appFixture("ui:owned-vault-grant-row-visible", { openModal: "vault" }, [
    clickStep("[data-debug-id='vault-tab-grants']"),
  ], undefined, {
    ownedVaultGrant: true,
    cleanupAfterRestoreAbsentSelector: "[data-debug-id=\"shellx-vault-grant-row\"]",
  }),
  browserFixture("ui:browser-chrome-owned-task", "chat"),
  browserFixture("ui:browser-actions-owned-task", "actions"),
  browserFixture("ui:browser-requests-empty-owned-task", "requests"),
  browserFixture("ui:browser-evidence-owned-task", "evidence"),
  browserFixture("ui:browser-downloads-badge-owned-intent", "actions", { ownedDownloadIntent: true }),
  browserFixture("ui:browser-right-sidebar-hidden-owned-task", "chat", {
    steps: [clickStep("[data-debug-id='shellx-browser-toggle-right-sidebar-button']")],
    cleanupSteps: [clickStep("[data-debug-id='shellx-browser-show-right-sidebar-button']")],
    cleanupAbsentSelector: "[data-debug-id='shellx-browser-show-right-sidebar-button']",
  }),
  browserFixture("ui:browser-errors-owned-task", "errors"),
  browserMenuFixture(
    "ui:browser-options-owned-task",
    "[data-debug-id='shellx-browser-options']",
    "[data-debug-id='shellx-browser-options-close']",
    "[data-debug-id='shellx-browser-options-sidecar']",
  ),
  browserMenuFixture(
    "ui:browser-history-owned-task",
    "[data-debug-id='shellx-browser-history-menu']",
    "[data-debug-id='shellx-browser-history-close']",
    "[data-debug-id='shellx-browser-history-sidecar']",
  ),
  browserMenuFixture(
    "ui:browser-downloads-owned-task",
    "[data-debug-id='shellx-browser-downloads-menu']",
    "[data-debug-id='shellx-browser-downloads-close']",
    "[data-debug-id='shellx-browser-download-sidecar']",
  ),
  browserToggleMenuFixture(
    "ui:browser-shields-owned-task",
    "[data-debug-id='shellx-browser-trust-chip']",
    "[data-debug-id='shellx-browser-shields-panel']",
  ),
  browserToggleMenuFixture(
    "ui:browser-save-owned-task",
    "[data-debug-id='shellx-browser-save-page']",
    "[data-debug-id='shellx-browser-save-media']",
  ),
  browserToggleMenuFixture(
    "ui:browser-ad-filter-owned-task",
    "[data-debug-id='shellx-browser-ad-filter']",
    "[data-debug-id='shellx-browser-ad-mode-balanced']",
  ),
  browserBookmarkFixture("ui:browser-bookmark-list-link-owned", OWNED_BOOKMARK_LINK),
  browserBookmarkFixture("ui:browser-bookmark-list-folder-owned", OWNED_BOOKMARK_FOLDER),
  browserBookmarkFixture("ui:browser-bookmark-manager-owned", OWNED_BOOKMARK_MANAGER, [
    clickStep("[data-debug-id='shellx-browser-bookmark-manager-toggle']"),
  ]),
  browserFixture("ui:browser-bookmark-toolbar-owned", "chat", { ownedBookmarks: OWNED_BOOKMARK_TOOLBAR }),
  browserFixture("ui:browser-bookmark-toolbar-folder-open-owned", "chat", {
    ownedBookmarks: OWNED_BOOKMARK_TOOLBAR,
    steps: [clickStep("[data-debug-id='shellx-browser-bookmark-folder-final-surface-toolbar-folder']")],
    cleanupSteps: [clickStep("[data-debug-id='shellx-browser-bookmark-folder-final-surface-toolbar-folder']")],
    cleanupAbsentSelector: "[data-debug-id='shellx-browser-bookmark-folder-menu-final-surface-toolbar-folder']",
  }),
  browserFixture("ui:browser-workflow-preview-error-owned", "chat", {
    ownedBookmarks: OWNED_BOOKMARK_MISSING_WORKFLOW,
    steps: [
      clickStep("[data-debug-id='shellx-browser-bookmarks-menu']"),
      clickStep("[data-debug-id='shellx-browser-bookmark-final-surface-missing-workflow']"),
    ],
    cleanupSteps: [
      clickStep("[data-debug-id='shellx-browser-reload']"),
      clickStep("[data-debug-id='shellx-browser-bookmark-manager-close']"),
    ],
    cleanupAbsentSelector: "[data-debug-id='shellx-browser-bookmark-manager-dock']",
  }),
] as const satisfies readonly ReleaseUiDebugFixtureSpec[];

export const RELEASE_UI_DEBUG_FIXTURES: readonly ReleaseUiDebugFixtureSpec[] = fixtures;
export const RELEASE_UI_DEBUG_CLEANUP_ID = "ui:clear-debug-highlight-and-restore-owned-state";
export const RELEASE_UI_DEBUG_BROWSER_CLEANUP_ID = "ui:close-owned-browser-task-with-candidate-teardown";
export const RELEASE_UI_DEBUG_VAULT_LIFECYCLE_CLEANUP_ID = "ui:reset-disposable-vault-with-candidate-teardown";
export const RELEASE_UI_DEBUG_ORACLE_ID = "ui:visible-nonempty-rectangle";

const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
const fixtureIdBySurfaceKey = new Map<string, string>();
const fixtureIdBySurfaceOccurrenceKey = new Map<string, string>();

cohort("ui:app-shell-visible", "src/components/Header.tsx", [
  "header-shellx-browser",
  "header-theme-toggle",
]);
cohort("ui:app-shell-visible", "src/components/HeaderVaultRequestCenter.tsx", [
  "header-vault-request-center",
]);
cohort("ui:goal-plan-review-owned-visible", "src/components/GoalPlanReviewModal.tsx", [
  "surface-components-goalplanreviewmodal-1",
  "surface-components-goalplanreviewmodal-7",
  "surface-components-goalplanreviewmodal-9",
]);
cohort("ui:goal-plan-review-owned-editing-visible", "src/components/GoalPlanReviewModal.tsx", [
  "surface-components-goalplanreviewmodal-4",
]);
cohort("ui:app-shell-visible", "src/components/LeftRail.tsx", [
  "left-rail",
  "left-add-project",
]);
cohort("ui:owned-project-draft-visible", "src/components/LeftRail.tsx", [
  "left-project-row",
  "left-project-rename-input",
  "surface-components-leftrail-3",
]);
cohort("ui:owned-project-delete-dialog-visible", "src/components/LeftRail.tsx", [
  "surface-components-leftrail-19",
  "surface-components-leftrail-20",
]);
cohort("ui:session-delete-dialog-visible", "src/components/LeftRail.tsx", [
  "surface-components-leftrail-24",
  "surface-components-leftrail-25",
]);
cohort("ui:app-shell-visible", "src/components/RowActions.tsx", [
  "surface-components-rowactions-1",
  "surface-components-rowactions-2",
]);
cohort("ui:agent-cli-setup-owned-cards-visible", "src/components/AgentCliSetupAssistant.tsx", [
  "agent-cli-setup-assistant",
  "agent-cli-setup-dialog",
  "surface-components-agentclisetupassistant-11",
  "surface-components-agentclisetupassistant-5",
]);
cohort("ui:agent-cli-setup-owned-confirmation-visible", "src/components/AgentCliSetupAssistant.tsx", [
  "agent-cli-setup-confirm",
  "surface-components-agentclisetupassistant-9",
]);
cohort("ui:agent-cli-status-owned-setup-controls-visible", "src/components/AgentCliStatusCard.tsx", [
  "agent-cli-setup-open-grok",
  "agent-cli-setup-open-claude-code",
  "agent-cli-setup-open-codex-cli",
  "agent-cli-setup-open-antigravity-cli",
  "agent-cli-setup-open-missing",
]);
cohort("ui:owned-past-chat-visible", "src/components/LeftRail.tsx", [
  "left-past-chats-toggle",
  "left-past-chat-row",
]);
cohort("ui:owned-past-chat-rename-visible", "src/components/LeftRail.tsx", [
  "left-chat-rename-input",
]);
cohort("ui:owned-open-chat-context-menu-visible", "src/components/LeftRail.tsx", [
  "surface-components-leftrail-15",
]);
cohort("ui:owned-past-chat-context-menu-visible", "src/components/LeftRail.tsx", [
  "surface-components-leftrail-17",
]);
cohort("ui:app-shell-visible", "src/components/SessionTabs.tsx", [
  "session-tab",
]);
cohort("ui:session-rename-visible", "src/components/SessionTabs.tsx", [
  "session-rename-input",
]);
cohort("ui:session-preview-visible", "src/components/SessionTabs.tsx", [
  "surface-components-sessiontabs-4",
]);
cohort("ui:session-preview-dropdown-visible", "src/components/SessionTabs.tsx", [
  "surface-components-sessiontabs-11",
]);
cohort("ui:app-shell-visible", "src/components/FindPopover.tsx", [
  "surface-components-findpopover-1",
  "find-sessions-input",
]);
cohort("ui:find-open-row-visible", "src/components/FindPopover.tsx", [
  "surface-components-findpopover-3",
]);
cohort("ui:find-disk-row-visible", "src/components/FindPopover.tsx", [
  "surface-components-findpopover-4",
]);
cohort("ui:app-shell-visible", "src/components/RightRail.tsx", [
  "right-tab-tasks",
  "right-tab-tooling",
  "right-tab-git",
  "right-tab-preview",
  "right-tab-plan",
  "right-tab-files",
]);
cohort("ui:app-shell-visible", "src/components/BottomPanel.tsx", [
  "bottom-tab-chat",
  "bottom-tab-terminal",
  "bottom-action-trace",
  "bottom-action-assets",
  "bottom-tab-images",
  "bottom-tab-videos",
  "bottom-tab-logs",
  "bottom-tab-stderr",
]);
cohort("ui:bottom-chat-visible", "src/components/BottomPanel.tsx", [
  "composer",
  "composer-prompt",
  "composer-attach",
  "composer-screenshot",
  "composer-talk",
  "composer-voice-chat",
  "composer-send",
  "composer-connection",
  "composer-agent",
  "composer-folder",
  "composer-branch",
]);
cohort("ui:setup-guide-visible", "src/components/ShellxSetupGuide.tsx", [
  "shellx-setup-guide",
  "shellx-setup-step-vault",
  "shellx-setup-step-browser",
  "shellx-setup-step-downloads",
  "shellx-setup-step-agents",
  "shellx-setup-step-requests",
  "shellx-setup-guide-dismiss",
]);
cohort("ui:settings-tab-strip-visible", "src/components/Settings.tsx", [
  "surface-components-settings-1",
  "settings-tab-general",
  "settings-tab-vault",
  "settings-tab-connections",
  "settings-tab-connectors",
  "settings-tab-desktop",
  "settings-tab-shellxagent",
  "settings-tab-data",
  "settings-tab-about",
]);
cohort("ui:settings-general-visible", "src/components/settings/GeneralTab.tsx", [
  "settings-density-comfortable",
  "settings-density-compact",
  "settings-density-default",
  "settings-browser-download-folder",
  "settings-browser-download-folder-choose",
]);
cohort("ui:settings-about-visible", "src/components/settings/AboutTab.tsx", [
  "surface-components-settings-abouttab-1",
  "surface-components-settings-abouttab-3",
  "surface-components-settings-abouttab-4",
  "surface-components-settings-abouttab-5",
  "about-full-manual-link",
  "surface-components-settings-abouttab-9",
  "surface-components-settings-abouttab-10",
]);
cohort("ui:builtin-doc-visible", "src/components/BuiltinDocModal.tsx", [
  "surface-components-builtindocmodal-4",
  "surface-components-builtindocmodal-5",
]);
cohort("ui:settings-connections-visible", "src/components/settings/ConnectionsTab.tsx", [
  "surface-components-settings-connectionstab-2",
]);
cohort("ui:settings-connectors-visible", "src/components/settings/ConnectorsTab.tsx", [
  "connector-approval-auto-dispatch",
  "connector-approval-review-first",
  "surface-components-settings-connectorstab-1",
  "surface-components-settings-connectorstab-3",
  "surface-components-settings-connectorstab-12",
  "surface-components-settings-connectorstab-17",
  "surface-components-settings-connectorstab-18",
  "surface-components-settings-connectorstab-21",
]);
cohort("ui:settings-connectors-fixed-target-visible", "src/components/settings/ConnectorsTab.tsx", [
  "surface-components-settings-connectorstab-11",
]);
cohort("ui:settings-desktop-visible", "src/components/settings/DesktopTab.tsx", [
  "surface-components-settings-desktoptab-1",
]);
cohort("ui:settings-shellxagent-visible", "src/components/settings/ShellxagentTab.tsx", [
  "surface-components-settings-shellxagenttab-1",
  "surface-components-settings-shellxagenttab-2",
  "surface-components-settings-shellxagenttab-3",
]);
cohort("ui:connection-editor-local-visible", "src/components/ConnectionEditor.tsx", [
  "surface-components-connectioneditor-1",
  "surface-components-connectioneditor-2",
  "connection-label-input",
  "connection-transport-local",
  "connection-transport-wsl",
  "connection-transport-ssh",
  "surface-components-connectioneditor-12",
  "surface-components-connectioneditor-14",
  "surface-components-connectioneditor-16",
]);
cohort("ui:connection-editor-wsl-visible", "src/components/ConnectionEditor.tsx", [
  "connection-wsl-distro-input",
]);
cohort("ui:connection-editor-ssh-visible", "src/components/ConnectionEditor.tsx", [
  "connection-ssh-host-input",
  "connection-ssh-port-input",
  "connection-ssh-key-select",
  "connection-ssh-runtime-select",
  "connection-ssh-platform-hint",
]);
cohort("ui:connection-editor-windows-wsl-visible", "src/components/ConnectionEditor.tsx", [
  "connection-ssh-wsl-distro-input",
]);
cohort("ui:command-palette-visible", "src/components/CommandPalette.tsx", [
  "surface-components-commandpalette-1",
  "command-palette-input",
  "surface-components-commandpalette-4",
]);
cohort("ui:help-modal-visible", "src/components/HelpModal.tsx", [
  "surface-components-helpmodal-1",
]);
cohort("ui:build-plan-review-owned-ready-visible", "src/components/BuildPlanReviewModal.tsx", [
  "surface-components-buildplanreviewmodal-1",
  "surface-components-buildplanreviewmodal-4",
  "surface-components-buildplanreviewmodal-5",
]);
cohort("ui:plugins-modal-visible", "src/components/PluginsModal.tsx", [
  "surface-components-pluginsmodal-1",
  "plugins-shellx-host-scope",
]);
cohort("ui:plugins-owned-marketplace-visible", "src/components/PluginsModal.tsx", [
  "plugins-entry-toggle",
  "surface-components-pluginsmodal-10",
  "surface-components-pluginsmodal-11",
]);
cohort("ui:plugins-owned-key-form-visible", "src/components/PluginsModal.tsx", [
  "plugins-vault-key-input",
  "surface-components-pluginsmodal-13",
]);
cohort("ui:connector-inbox-visible", "src/components/ConnectorInboxModal.tsx", [
  "connector-inbox-backdrop",
  "surface-components-connectorinboxmodal-2",
  "surface-components-connectorinboxmodal-4",
  "connector-inbox-search-input",
  "connector-inbox-date-input",
  "surface-components-connectorinboxmodal-9",
]);
cohort("ui:asset-board-visible", "src/components/AttachmentMediaBoard.tsx", [
  "attachment-media-board-backdrop",
  "surface-components-attachmentmediaboard-2",
]);
cohort("ui:preview-center-visible", "src/components/PreviewCenter.tsx", [
  "preview-center-backdrop",
  "surface-components-previewcenter-2",
]);
cohort("ui:file-preview-visible", "src/components/FilePreviewModal.tsx", [
  "surface-components-filepreviewmodal-1",
]);
cohort("ui:activity-browser-visible", "src/components/ActivityBrowserModal.tsx", [
  "activity-browser-backdrop",
  "surface-components-activitybrowsermodal-2",
  "activity-tab-files",
  "activity-tab-graph",
  "activity-tab-evidence",
  "activity-tab-timeline",
  "activity-tab-summary",
  "activity-search",
]);
cohort("ui:activity-search-active-visible", "src/components/ActivityBrowserModal.tsx", [
  "activity-search-clear",
]);
cohort("ui:activity-evidence-visible", "src/components/ActivityBrowserModal.tsx", [
  "activity-evidence-column-resizer",
  "activity-evidence-row-resizer",
  "activity-evidence-section-*-expand",
]);
cohort("ui:owned-activity-graph-visible", "src/components/ActivityBrowserModal.tsx", [
  "surface-components-activitybrowsermodal-14",
]);
cohort("ui:owned-activity-graph-selected-visible", "src/components/ActivityBrowserModal.tsx", [
  "surface-components-activitybrowsermodal-16",
]);
cohort("ui:owned-activity-files-visible", "src/components/ActivityBrowserModal.tsx", [
  "surface-components-activitybrowsermodal-17",
  "surface-components-activitybrowsermodal-18",
]);
cohort("ui:owned-activity-timeline-visible", "src/components/ActivityBrowserModal.tsx", [
  "surface-components-activitybrowsermodal-19",
]);
cohort("ui:owned-activity-evidence-rows-visible", "src/components/ActivityBrowserModal.tsx", [
  "surface-components-activitybrowsermodal-21",
]);
cohort("ui:pr-modal-visible", "src/components/PRCreateModal.tsx", [
  "surface-components-prcreatemodal-1",
  "pr-base-input",
  "pr-title-input",
  "pr-body-input",
  "surface-components-prcreatemodal-8",
  "surface-components-prcreatemodal-10",
]);
cohort("ui:remote-cwd-picker-visible", "src/App.tsx", [
  "remote-cwd-close",
  "remote-cwd-input",
  "remote-cwd-go",
  "remote-cwd-use",
  "remote-cwd-up",
]);
cohortOccurrences("ui:owned-remote-cwd-empty-visible", "src/App.tsx", [
  { name: "remote-cwd-parent", occurrence: 6 },
]);
cohortOccurrences("ui:owned-remote-cwd-folder-visible", "src/App.tsx", [
  { name: "remote-cwd-parent", occurrence: 7 },
  { name: "remote-cwd-folder", occurrence: 8 },
]);
cohort("ui:owned-branch-picker-row-visible", "src/components/BranchPicker.tsx", [
  "surface-components-branchpicker-1",
]);
cohort("ui:owned-connection-picker-row-visible", "src/components/ConnectionPicker.tsx", [
  "surface-components-connectionpicker-3",
]);
cohort("ui:owned-connection-editor-scanned-visible", "src/components/ConnectionEditor.tsx", [
  "connection-agent-cli-setup-open",
]);
cohort("ui:owned-agent-picker-row-visible", "src/components/BottomPanel.tsx", [
  "surface-components-bottompanel-23",
]);
cohort("ui:owned-slash-command-row-visible", "src/components/BottomPanel.tsx", [
  "surface-components-bottompanel-24",
]);
cohort("ui:owned-files-pane-row-visible", "src/components/FilesPane.tsx", [
  "surface-components-filespane-7",
]);
cohort("ui:owned-video-preview-visible", "src/components/MediaPreview.tsx", [
  "surface-components-mediapreview-1",
]);
cohort("ui:owned-markdown-preview-links-visible", "src/lib/markdown-links.tsx", [
  "surface-lib-markdown-links-1",
  "surface-lib-markdown-links-2",
]);
cohort("ui:owned-pending-attachment-visible", "src/components/AttachmentMediaBoard.tsx", [
  "surface-components-attachmentmediaboard-9",
]);
cohort("ui:owned-renderer-event-chat-visible", "src/components/ChatOutput.tsx", [
  "surface-components-chatoutput-3",
  "surface-components-chatoutput-4",
  "surface-components-chatoutput-5",
]);
cohort("ui:owned-renderer-event-chat-visible", "src/components/PermissionPill.tsx", [
  "surface-components-permissionpill-1",
  "surface-components-permissionpill-3",
]);
cohort("ui:owned-renderer-event-assets-visible", "src/components/AttachmentMediaBoard.tsx", [
  "surface-components-attachmentmediaboard-12",
  "surface-components-attachmentmediaboard-14",
  "surface-components-attachmentmediaboard-18",
  "surface-components-attachmentmediaboard-19",
]);
cohort("ui:debug-api-disconnected-banner-visible", "src/components/DebugApiConnectionBanner.tsx", [
  "debug-api-disconnected",
  "debug-api-retry",
]);
cohort("ui:owned-hash-autocomplete-row-visible", "src/components/HashAutocomplete.tsx", [
  "surface-components-hashautocomplete-1",
]);
cohort("ui:owned-renderer-event-image-visible", "src/components/BottomPanel.tsx", [
  "surface-components-bottompanel-9",
]);
cohort("ui:owned-vault-agent-request-visible", "src/components/HeaderVaultRequestCenter.tsx", [
  "vault-request-center-item",
]);
cohortOccurrences("ui:owned-vault-agent-request-visible", "src/components/HeaderVaultRequestCenter.tsx", [
  { name: "vault-request-action-*", occurrence: 8 },
  { name: "vault-request-action-*", occurrence: 9 },
]);
cohort("ui:owned-vault-grant-row-visible", "src/components/settings/VaultGrantsPanel.tsx", [
  "shellx-vault-grant-row",
]);
cohort("ui:right-rail-tasks-visible", "src/components/TasksPanel.tsx", [
  "surface-components-taskspanel-3",
  "tasks-show-all-tabs-checkbox",
  "tasks-show-completed-checkbox",
  "tasks-filter-input",
]);
cohort("ui:owned-tasks-panel-row-visible", "src/components/TasksPanel.tsx", [
  "surface-components-taskspanel-8",
]);
cohort("ui:right-rail-tasks-visible", "src/components/AgentRunsMonitor.tsx", [
  "tasks-agent-runs",
  "tasks-agent-runs-refresh",
]);
cohort("ui:right-rail-files-visible", "src/components/FilesPane.tsx", [
  "files-search-input",
]);
cohort("ui:right-rail-git-visible", "src/components/GitPane.tsx", [
  "surface-components-gitpane-1",
  "surface-components-gitpane-5",
]);
cohort("ui:right-rail-tooling-visible", "src/components/RightRail.tsx", [
  "surface-components-rightrail-2",
  "surface-components-rightrail-9",
]);
cohort("ui:right-rail-owned-connector-action-visible", "src/components/RightRail.tsx", [
  "surface-components-rightrail-11",
]);
cohort("ui:right-rail-preview-visible", "src/components/WorkPreviewPanel.tsx", [
  "surface-components-workpreviewpanel-3",
]);
cohort("ui:owned-work-preview-browser-issue-visible", "src/components/WorkPreviewPanel.tsx", [
  "surface-components-workpreviewpanel-16",
]);
cohort("ui:vault-workspace-visible", "src/components/VaultPanel.tsx", [
  "surface-components-vaultpanel-1",
  "vault-workspace-modal",
  "vault-workspace-lock-status",
]);
cohort("ui:vault-workspace-visible", "src/components/settings/VaultTab.tsx", [
  "vault-filter-input",
  "vault-secret-key-input",
  "vault-generate-password",
  "vault-tab-secrets",
  "vault-tab-grants",
  "vault-tab-setup",
  "vault-resource-form-tabs",
  "vault-resource-form-tab-secret",
  "vault-resource-form-tab-profileCard",
  "vault-resource-form-tab-stripeAgentWallet",
  "vault-secret-form",
  "vault-secret-value-input",
  "surface-components-settings-vaulttab-30",
]);
cohort("ui:vault-setup-unconfigured-visible", "src/components/settings/VaultSetupPanel.tsx", [
  "shellx-vault-setup",
  "shellx-vault-setup-mode",
  "shellx-vault-master-passphrase",
  "shellx-vault-confirm-passphrase",
  "surface-components-settings-vaultsetuppanel-17",
  "shellx-vault-recovery-confirm",
  "shellx-vault-remember-device-setup",
]);
cohort("ui:vault-profile-collision-owned", "src/components/settings/VaultSetupPanel.tsx", [
  "vault-profile-collision",
]);
cohort("ui:vault-setup-recovery-kit-visible", "src/components/settings/VaultSetupPanel.tsx", [
  "shellx-vault-recovery-copy",
]);
cohort("ui:vault-owned-secret-visible", "src/components/settings/VaultTab.tsx", [
  "vault-description-inline",
  "vault-permission-bar",
  "vault-permission-visible",
  "vault-permission-userOnly",
  "vault-permission-browserFillAlways",
  "vault-permission-toolUseAlways",
  "vault-resource-section-secrets",
  "vault-resource-section-profile-cards",
  "vault-resource-section-agent-wallets",
]);
cohortOccurrences("ui:vault-owned-secret-metadata-visible", "src/components/settings/VaultTab.tsx", [
  { name: "vault-description-input", occurrence: 12 },
  { name: "vault-user-only-toggle", occurrence: 13 },
]);
cohort("ui:vault-owned-secret-metadata-visible", "src/components/settings/VaultTab.tsx", [
  "surface-components-settings-vaulttab-18",
]);
cohort("ui:vault-owned-secret-replace-visible", "src/components/settings/VaultTab.tsx", [
  "surface-components-settings-vaulttab-22",
]);
cohort("ui:vault-configured-unlocked-visible", "src/components/settings/VaultSetupPanel.tsx", [
  "shellx-vault-configured-summary",
  "shellx-vault-remember-passphrase",
  "shellx-vault-remember-device-enable",
  "shellx-vault-change-setup",
]);
cohort("ui:vault-configured-unlocked-visible", "src/components/VaultPanel.tsx", [
  "vault-workspace-lock",
]);
cohort("ui:vault-configured-locked-visible", "src/components/settings/VaultSetupPanel.tsx", [
  "shellx-vault-unlock-form",
  "shellx-vault-unlock-passphrase",
  "shellx-vault-unlock",
  "shellx-vault-remember-device-unlock",
]);
cohort("ui:vault-configured-locked-visible", "src/components/VaultPanel.tsx", [
  "vault-workspace-quick-unlock",
  "surface-components-vaultpanel-5",
]);
cohort("ui:vault-configured-remembered-visible", "src/components/settings/VaultSetupPanel.tsx", [
  "shellx-vault-forget-device",
]);
cohortOccurrences("ui:vault-workspace-visible", "src/components/settings/VaultTab.tsx", [
  { name: "vault-description-input", occurrence: 20 },
  { name: "vault-user-only-toggle", occurrence: 21 },
]);
cohort("ui:vault-password-generator-visible", "src/components/VaultPasswordGenerator.tsx", [
  "vault-password-generator",
  "vault-password-generator-close",
  "vault-password-generator-output",
  "vault-password-generator-copy",
  "surface-components-vaultpasswordgenerator-5",
  "vault-password-generator-length",
  "vault-password-generator-regenerate",
  "vault-password-generator-use",
  "vault-password-generator-save",
  "surface-components-vaultpasswordgenerator-11",
]);
cohort("ui:vault-profile-card-form-visible", "src/components/settings/VaultTab.tsx", [
  "vault-profile-card-form",
  "surface-components-settings-vaulttab-45",
]);
cohort("ui:vault-agent-wallet-form-visible", "src/components/settings/VaultTab.tsx", [
  "vault-agent-wallet-form",
  "surface-components-settings-vaulttab-48",
  "surface-components-settings-vaulttab-57",
  "surface-components-settings-vaulttab-59",
]);
cohort("ui:vault-grants-visible", "src/components/settings/VaultGrantsPanel.tsx", [
  "shellx-vault-grants",
]);
cohort("ui:vault-request-center-visible", "src/components/HeaderVaultRequestCenter.tsx", [
  "vault-request-center-popover",
  "vault-request-open-vault",
  "vault-request-new-secret",
  "vault-request-generate-password",
]);
cohort("ui:browser-chrome-owned-task", "src/browser/components/BrowserChrome.tsx", [
  "shellx-browser-tab-strip",
  "shellx-browser-tab-*",
  "shellx-browser-close-tab-*",
  "shellx-browser-new-tab",
  "shellx-browser-new-disposable-tab",
  "shellx-browser-lock-tab",
  "shellx-browser-personal-lock-toggle",
  "shellx-browser-tab-ownership-banner",
  "shellx-browser-back",
  "shellx-browser-forward",
  "shellx-browser-reload",
  "shellx-browser-home",
  "shellx-browser-trust-chip",
  "shellx-browser-address",
  "shellx-browser-copy-address",
  "shellx-browser-profile-marker",
  "shellx-browser-bookmark-current",
  "shellx-browser-vault-fill-menu",
  "shellx-browser-downloads-menu",
  "shellx-browser-bookmarks-menu",
  "shellx-browser-history-menu",
  "shellx-browser-save-page",
  "shellx-browser-ad-filter",
  "shellx-browser-options",
]);
cohort("ui:browser-downloads-badge-owned-intent", "src/browser/components/BrowserChrome.tsx", [
  "shellx-browser-downloads-badge",
]);
cohort("ui:browser-chrome-owned-task", "src/browser/components/EngineViewport.tsx", [
  "shellx-browser-viewport",
]);
cohort("ui:browser-actions-owned-task", "src/browser/components/AgentSidebar.tsx", [
  "shellx-browser-task-*",
  "shellx-browser-actions-panel",
  "shellx-browser-complete",
  "shellx-browser-block",
  "shellx-browser-collapse-tasks",
  "shellx-browser-downloads",
  "shellx-browser-collapse-receipts",
]);
cohort("ui:browser-chrome-owned-task", "src/browser/components/AgentSidebar.tsx", [
  "shellx-browser-sidebar-resize",
  "shellx-browser-toggle-right-sidebar-button",
  "shellx-browser-vault-prompt",
  "shellx-browser-right-tab-chat",
  "shellx-browser-right-tab-requests",
  "shellx-browser-right-tab-actions",
  "shellx-browser-right-tab-evidence",
  "shellx-browser-right-tab-errors",
  "shellx-browser-agent-panel",
  "shellx-browser-agent-chat-stream",
  "shellx-browser-cowork-session",
  "shellx-browser-agent-quick-actions",
  "shellx-browser-chat-explain-page",
  "shellx-browser-goal",
  "shellx-browser-agent-send",
  "shellx-browser-agent-pause",
  "shellx-browser-agent-resume",
  "shellx-browser-agent-takeover",
  "shellx-browser-agent-abort",
]);
cohort("ui:browser-requests-empty-owned-task", "src/browser/components/AgentSidebar.tsx", [
  "shellx-browser-requests-panel",
  "shellx-browser-requests-empty",
]);
cohort("ui:browser-errors-owned-task", "src/browser/components/AgentSidebar.tsx", [
  "shellx-browser-console",
  "shellx-browser-collapse-console",
]);
cohort("ui:browser-evidence-owned-task", "src/browser/components/BrowserEvidencePanel.tsx", [
  "shellx-browser-evidence-panel",
  "shellx-browser-evidence-record",
  "shellx-browser-evidence-refresh",
  "shellx-browser-evidence-empty",
]);
cohort("ui:browser-right-sidebar-hidden-owned-task", "src/browser/components/BrowserChrome.tsx", [
  "shellx-browser-show-right-sidebar-button",
]);
cohort("ui:browser-options-owned-task", "src/browser/components/BrowserMenus.tsx", [
  "shellx-browser-options-sidecar",
  "shellx-browser-options-close",
  "shellx-browser-color-mode",
  "shellx-browser-homepage",
  "shellx-browser-profile-select",
  "shellx-browser-toggle-right-sidebar",
  "shellx-browser-personal-lock-status",
  "shellx-browser-personal-enable-now",
  "shellx-browser-personal-lock-enabled",
  "shellx-browser-personal-lock-timeout",
  "shellx-browser-personal-lock-auth-mode",
  "shellx-browser-personal-lock-blur",
  "shellx-browser-personal-lock-pause-delegated",
  "shellx-browser-personal-lock-sleep",
  "shellx-browser-personal-lock-minimize",
  "shellx-browser-parallel-agents",
]);
cohort("ui:browser-options-owned-task", "src/browser/components/BrowserChrome.tsx", [
  "shellx-browser-chrome-menu-dock",
]);
cohort("ui:browser-history-owned-task", "src/browser/components/BrowserHistorySidecar.tsx", [
  "shellx-browser-history-sidecar",
  "shellx-browser-history-close",
  "shellx-browser-history-user",
  "shellx-browser-history-agent",
  "shellx-browser-history-search",
  "shellx-browser-history-date-filter",
  "shellx-browser-history-list",
  "shellx-browser-clear-history",
  "shellx-browser-history-entry-*",
]);
cohort("ui:browser-downloads-owned-task", "src/browser/components/DownloadSidecar.tsx", [
  "shellx-browser-download-sidecar",
  "shellx-browser-downloads-close",
  "shellx-browser-download-folder",
  "shellx-browser-download-folder-choose",
  "shellx-browser-download-list",
]);
cohort("ui:browser-shields-owned-task", "src/browser/components/BrowserShieldsPanel.tsx", [
  "shellx-browser-shields-panel",
  "shellx-browser-shields-global-enabled",
  "shellx-browser-site-shields-ad-trackers",
  "shellx-browser-site-shields-script-blocking",
  "shellx-browser-site-shields-save",
  "shellx-browser-site-shields-reset",
  "surface-browser-components-browsershieldspanel-3",
  "surface-browser-components-browsershieldspanel-4",
  "surface-browser-components-browsershieldspanel-5",
]);
cohort("ui:browser-save-owned-task", "src/browser/components/BrowserMenus.tsx", [
  "shellx-browser-save-fullpage-screenshot",
  "shellx-browser-save-screenshot",
  "shellx-browser-save-markdown",
  "shellx-browser-save-links",
  "shellx-browser-save-snapshot",
  "shellx-browser-save-media",
  "shellx-browser-save-code",
  "shellx-browser-save-site",
]);
cohort("ui:browser-ad-filter-owned-task", "src/browser/components/BrowserMenus.tsx", [
  "shellx-browser-ad-mode-default",
  "shellx-browser-ad-mode-off",
  "shellx-browser-ad-mode-balanced",
  "shellx-browser-ad-mode-strict",
]);
cohort("ui:browser-bookmark-list-link-owned", "src/browser/components/BookmarkSidecar.tsx", [
  "shellx-browser-bookmark-manager-dock",
  "shellx-browser-bookmark-manager-close",
  "shellx-browser-bookmark-list-mode",
  "shellx-browser-bookmark-manager-toggle",
  "shellx-browser-bookmark-list",
]);
cohortOccurrences("ui:browser-bookmark-list-link-owned", "src/browser/components/BookmarkSidecar.tsx", [
  { name: "shellx-browser-bookmark-*", occurrence: 1 },
]);
cohortOccurrences("ui:browser-bookmark-list-folder-owned", "src/browser/components/BookmarkSidecar.tsx", [
  { name: "shellx-browser-bookmark-*", occurrence: 2 },
]);
cohort("ui:browser-bookmark-manager-owned", "src/browser/components/BookmarkSidecar.tsx", [
  "shellx-browser-bookmark-manager",
  "shellx-browser-bookmark-draft-label",
  "shellx-browser-bookmark-draft-url",
  "shellx-browser-bookmark-draft-folder",
  "shellx-browser-bookmark-manager-row-*",
  "shellx-browser-bookmark-manager-open-*",
  "shellx-browser-bookmark-drag-*",
  "shellx-browser-bookmark-label-*",
  "shellx-browser-bookmark-url-*",
  "shellx-browser-bookmark-pin-*",
  "shellx-browser-bookmark-delete-*",
  "shellx-browser-bookmark-open-*",
  "shellx-browser-bookmark-create-folder",
  "shellx-browser-bookmark-create-link",
]);
cohort("ui:browser-bookmark-toolbar-owned", "src/browser/components/BookmarkToolbar.tsx", [
  "shellx-browser-bookmark-toolbar",
  "shellx-browser-bookmark-folder-*",
  "shellx-browser-bookmark-toolbar-link-*",
]);
cohort("ui:browser-bookmark-toolbar-folder-open-owned", "src/browser/components/BookmarkToolbar.tsx", [
  "shellx-browser-bookmark-folder-menu-*",
  "shellx-browser-bookmark-folder-child-*",
]);
cohort("ui:browser-workflow-preview-error-owned", "src/browser/components/BookmarkSidecar.tsx", [
  "shellx-browser-workflow-preview",
]);
cohort("ui:browser-workflow-preview-error-owned", "src/components/ShellxBrowserApp.tsx", [
  "shellx-browser-error",
]);

export function releaseUiDebugFixture(id: string): ReleaseUiDebugFixtureSpec | null {
  return fixtureById.get(id) ?? null;
}

export function releaseUiDebugSurfaceCohort(
  surface: Pick<ReleaseSurfaceItem, "kind" | "source" | "name" | "occurrence">,
): ReleaseUiDebugSurfaceCohort | null {
  if (surface.kind !== "ui-debug-surface") return null;
  const occurrenceFixtureId = typeof surface.occurrence === "number"
    ? fixtureIdBySurfaceOccurrenceKey.get(
        surfaceOccurrenceKey(surface.source, surface.name, surface.occurrence),
      )
    : undefined;
  const fixtureId = occurrenceFixtureId ?? fixtureIdBySurfaceKey.get(surfaceKey(surface.source, surface.name));
  if (!fixtureId) return null;
  const fixture = fixtureById.get(fixtureId);
  if (!fixture) throw new Error(`UI debug fixture ${fixtureId} is not registered`);
  return { fixtureId, debugSurface: fixture.debugSurface };
}

export function promotedReleaseUiDebugSurfaces(
  surfaces: readonly ReleaseSurfaceItem[],
): ReleaseSurfaceItem[] {
  return surfaces.filter((surface) => releaseUiDebugSurfaceCohort(surface) !== null);
}

export function releaseUiDebugCohortDeclarationCount(): number {
  return fixtureIdBySurfaceKey.size + fixtureIdBySurfaceOccurrenceKey.size;
}

export function releaseUiDebugCleanupIdForFixture(fixtureId: string): string {
  const fixture = fixtureById.get(fixtureId);
  if (!fixture) throw new Error(`UI debug cleanup uses unknown fixture ${fixtureId}`);
  if (fixture.setup.kind === "owned-browser-task") return RELEASE_UI_DEBUG_BROWSER_CLEANUP_ID;
  return fixture.setup.ownedVaultLifecycle
    ? RELEASE_UI_DEBUG_VAULT_LIFECYCLE_CLEANUP_ID
    : RELEASE_UI_DEBUG_CLEANUP_ID;
}

function appFixture(
  id: string,
  patch: Record<string, unknown>,
  steps?: readonly ReleaseUiDebugPatchStep[],
  cleanupSteps?: readonly ReleaseUiDebugPatchStep[],
  options: {
    ownedSessionHistory?: boolean;
    ownedSessionHistorySurface?: boolean;
    ownedCwdPicker?: "empty" | "with-child";
    ownedGitRepo?: boolean;
    ownedConnectionPreset?: boolean;
    ownedFilesPane?: boolean;
    ownedPreviewFile?: "video" | "markdown";
    ownedPendingAttachment?: boolean;
    ownedRendererEventProjection?: boolean;
    ownedActivityBrowser?: boolean;
    ownedVaultAgentRequest?: boolean;
    ownedVaultGrant?: boolean;
    ownedWorkPreviewIssue?: boolean;
    preserveSettingsTab?: boolean;
    cleanupReadySelector?: string;
    cleanupAbsentSelector?: string;
    cleanupAfterRestoreAbsentSelector?: string;
  } = {},
): ReleaseUiDebugFixtureSpec {
  return { id, debugSurface: "app", setup: { kind: "app-state", patch, steps, cleanupSteps, ...options } };
}

function appOwnedVaultFixture(
  id: string,
  steps: readonly ReleaseUiDebugPatchStep[] = [],
): ReleaseUiDebugFixtureSpec {
  return {
    id,
    debugSurface: "app",
    setup: {
      kind: "app-state",
      patch: { openModal: "vault" },
      steps,
      ownedVaultSecret: OWNED_VAULT_SECRET,
    },
  };
}

function appOwnedVaultLifecycleFixture(
  id: string,
  ownedVaultLifecycle: "configured-unlocked" | "configured-locked" | "configured-remembered",
): ReleaseUiDebugFixtureSpec {
  return {
    id,
    debugSurface: "app",
    setup: {
      kind: "app-state",
      patch: { openModal: "vault" },
      steps: [clickStep("[data-debug-id='vault-tab-setup']")],
      ownedVaultLifecycle,
    },
  };
}

function appOwnedVaultRecoveryKitFixture(): ReleaseUiDebugFixtureSpec {
  return {
    id: "ui:vault-setup-recovery-kit-visible",
    debugSurface: "app",
    setup: {
      kind: "app-state",
      patch: { openModal: "vault" },
      steps: [
        clickStep("[data-debug-id='vault-tab-setup']"),
        inputStep("[data-debug-id='shellx-vault-master-passphrase']", OWNED_VAULT_SETUP_PASSPHRASE),
        inputStep("[data-debug-id='shellx-vault-confirm-passphrase']", OWNED_VAULT_SETUP_PASSPHRASE),
        clickTextStep("button", "Create recovery kit"),
      ],
      ownedVaultLifecycle: "setup-recovery-kit",
    },
  };
}

function settingsFixture(
  id: string,
  tab: string,
  steps: readonly ReleaseUiDebugPatchStep[] = [],
): ReleaseUiDebugFixtureSpec {
  return {
    id,
    debugSurface: "app",
    setup: {
      kind: "app-state",
      patch: { openModal: "settings" },
      steps: [clickStep(`[data-debug-id='settings-tab-${tab}']`), ...steps],
      preserveSettingsTab: true,
    },
  };
}

function shellxagentSettingsFixture(): ReleaseUiDebugFixtureSpec {
  return {
    id: "ui:settings-shellxagent-visible",
    debugSurface: "app",
    setup: {
      kind: "app-state",
      patch: { openModal: "settings" },
      steps: [{ patch: { debugShellxagentFixture: "owned-safe" } }],
      cleanupSteps: [{ patch: { openModal: "close", debugShellxagentFixture: "clear" } }],
      cleanupAbsentSelector: "[data-debug-id='surface-components-settings-shellxagenttab-1']",
      preserveSettingsTab: true,
    },
  };
}

type BrowserFixtureOptions = Omit<
  Extract<ReleaseUiDebugFixtureSpec["setup"], { kind: "owned-browser-task" }>,
  "kind" | "rightTab"
>;

function browserFixture(
  id: string,
  rightTab: "chat" | "requests" | "actions" | "evidence" | "errors",
  options: BrowserFixtureOptions = {},
): ReleaseUiDebugFixtureSpec {
  return { id, debugSurface: "browser", setup: { kind: "owned-browser-task", rightTab, ...options } };
}

function browserMenuFixture(
  id: string,
  openSelector: string,
  closeSelector: string,
  absentSelector: string,
): ReleaseUiDebugFixtureSpec {
  return browserFixture(id, "chat", {
    steps: [clickStep(openSelector)],
    cleanupSteps: [clickStep(closeSelector)],
    cleanupAbsentSelector: absentSelector,
  });
}

function browserToggleMenuFixture(
  id: string,
  toggleSelector: string,
  absentSelector: string,
): ReleaseUiDebugFixtureSpec {
  return browserFixture(id, "chat", {
    steps: [clickStep(toggleSelector)],
    cleanupSteps: [clickStep(toggleSelector)],
    cleanupAbsentSelector: absentSelector,
  });
}

function browserBookmarkFixture(
  id: string,
  ownedBookmarks: readonly ReleaseUiDebugOwnedBookmark[],
  additionalSteps: readonly ReleaseUiDebugPatchStep[] = [],
): ReleaseUiDebugFixtureSpec {
  return browserFixture(id, "chat", {
    ownedBookmarks,
    steps: [clickStep("[data-debug-id='shellx-browser-bookmarks-menu']"), ...additionalSteps],
    cleanupSteps: [clickStep("[data-debug-id='shellx-browser-bookmark-manager-close']")],
    cleanupAbsentSelector: "[data-debug-id='shellx-browser-bookmark-manager-dock']",
  });
}

function clickStep(selector: string): ReleaseUiDebugPatchStep {
  return { patch: { debugClick: selector }, delayMs: 250 };
}

function clickTextStep(selector: string, text: string): ReleaseUiDebugPatchStep {
  return { patch: { debugClick: { selector, text } }, delayMs: 250 };
}

function inputStep(selector: string, value: string, key?: string): ReleaseUiDebugPatchStep {
  return { patch: { debugInput: { selector, value, ...(key ? { key } : {}) } }, delayMs: 250 };
}

function inputKeyStep(selector: string, key: string): ReleaseUiDebugPatchStep {
  return { patch: { debugInput: { selector, value: "", key } }, delayMs: 250 };
}

function cohort(fixtureId: string, source: string, names: readonly string[]): void {
  if (!fixtureById.has(fixtureId)) throw new Error(`UI debug cohort uses unknown fixture ${fixtureId}`);
  for (const name of names) {
    const key = surfaceKey(source, name);
    const existing = fixtureIdBySurfaceKey.get(key);
    if (existing) throw new Error(`UI debug surface ${key} is already assigned to ${existing}`);
    fixtureIdBySurfaceKey.set(key, fixtureId);
  }
}

function cohortOccurrences(
  fixtureId: string,
  source: string,
  surfaces: readonly { name: string; occurrence: number }[],
): void {
  if (!fixtureById.has(fixtureId)) throw new Error(`UI debug cohort uses unknown fixture ${fixtureId}`);
  for (const surface of surfaces) {
    const key = surfaceOccurrenceKey(source, surface.name, surface.occurrence);
    const existing = fixtureIdBySurfaceOccurrenceKey.get(key);
    if (existing) throw new Error(`UI debug surface occurrence ${key} is already assigned to ${existing}`);
    fixtureIdBySurfaceOccurrenceKey.set(key, fixtureId);
  }
}

function surfaceKey(source: string, name: string): string {
  return `${source}\u0000${name}`;
}

function surfaceOccurrenceKey(source: string, name: string, occurrence: number): string {
  return `${surfaceKey(source, name)}\u0000${occurrence}`;
}
