import {
  assert, rustBrowser, rustBrowserModel, browserActionResultsSource, browserActionsSource, browserEngineRuntimeSource,
  browserScriptsSource, browserTabsSource, rustBrowserRecipes, rustBrowserTransfers, rustBrowserTransferArtifacts, rustLib,
  rustBuildMetadata, rustBuildScript, debugApi, debugApiBrowserArtifactsSource, debugApiBrowserStateSource, hostMcp,
  pluginsModalSource, subagentSource, packageData, testSuiteManifestSource, cargoToml, tauriConf,
  appSource, uiSource, browserAppConstantsSource, browserPreferencesSource, browserHistoryClearSource, browserPresentationSource,
  browserDebugBridgeSource, browserTaskIntentSource, browserApiSource, browserMenusSource, browserHistorySidecarSource, downloadSidecarSource,
  bookmarkSidecarSource, bookmarkToolbarSource, browserChromeSource, settingsModelSource, generalTabSource, nativeEngineSyncSource,
  browserStateHookSource, browserPageActionsSource, browserBookmarkHookSource, browserTabsHookSource, browserTasksHookSource, browserShellEffectsSource,
  engineViewportSource, agentSidebarSource, vaultPromptCardsSource, uiSourceLower, cssSource, browserAppCss,
  browserTopCss, browserTabChromeCss, browserTabStripCss, browserHeaderMenuWrapCss, browserHeaderPopoverCss, browserChromeShellCss,
  browserChromeMenuDockCss, browserBookmarkToolbarCss, browserExpandedAgentComposeCss, apiDocs, moduleReadme, shellxHostSkill,
  changelog, liveSmokeSource, fixtureServerSource, everydayFixtureSource, everydayAppsSmokeSource, adversarySmokeSource,
  concurrencySmokeSource, batchTimingSmokeSource, workflowMatrixSmokeSource, browserTestCleanupSource, browserCleanupTestSource, debugPathHelperSource,
  uiDebugSmokeSource, browserCliSource, skillInstallSource,
} from "./context";

assert(
  browserEngineRuntimeSource.includes("Open link in new tab") &&
    browserEngineRuntimeSource.includes("data-shellx-browser-context-menu") &&
    !browserEngineRuntimeSource.includes("Open link in new window"),
  "Browser injected page context menu offers Open link in new tab and avoids new-window wording",
);
assert(
  browserStateHookSource.includes("useBrowserState") &&
    browserStateHookSource.includes("browserApiGet<BrowserState>") &&
    browserStateHookSource.includes('"/browser/state?view=core"') &&
    browserStateHookSource.includes('"/browser/summary"') &&
    browserStateHookSource.includes('frame.kind !== "browser-event"') &&
    browserStateHookSource.includes("15_000") &&
    !browserStateHookSource.includes("setInterval") &&
    browserStateHookSource.includes("browserDebugApiBase") &&
    browserStateHookSource.includes("getBrowserDebugToken") &&
    browserStateHookSource.includes("debug-ui-state-patch") &&
    uiSource.includes("useBrowserState"),
  "browser state uses event revisions, visible slices, and compact disconnected fallback polling",
);
assert(
  browserStateHookSource.includes('"/browser/history?limit=1000"') &&
    browserStateHookSource.includes('"/browser/receipts?limit=200"') &&
    browserStateHookSource.includes('"/browser/logs?limit=200"') &&
    browserStateHookSource.includes('"/browser/requests"'),
  "browser UI fetches heavy state only through bounded panel slices",
);
assert(
  engineViewportSource.includes("EngineViewport") &&
    engineViewportSource.includes("shellx-browser-viewport") &&
    engineViewportSource.includes("shellx-browser-engine-slot") &&
    engineViewportSource.includes('data-debug-id="shellx-browser-viewport"') &&
    uiSource.includes("<EngineViewport"),
  "browser engine viewport is extracted behind a stable component boundary",
);
assert(
  agentSidebarSource.includes("AgentSidebar") &&
    !agentSidebarSource.includes('data-debug-id="shellx-browser-autonomy"') &&
    agentSidebarSource.includes('data-debug-id="shellx-browser-goal"') &&
    agentSidebarSource.includes('data-debug-id="shellx-browser-agent-pause"') &&
    agentSidebarSource.includes('data-debug-id="shellx-browser-agent-resume"') &&
    agentSidebarSource.includes('data-debug-id="shellx-browser-agent-abort"') &&
    agentSidebarSource.includes('data-debug-id="shellx-browser-agent-takeover"') &&
    uiSource.includes("<AgentSidebar"),
  "browser Agent sidebar is extracted without exposing a non-enforced autonomy selector",
);
assert(rustBrowserModel.includes("BrowserTaskAutonomyUpdateRequest"), "Browser models active task autonomy updates");
assert(!browserApiSource.includes("shellx_browser_update_task_autonomy") && !uiSource.includes("updateBrowserTaskAutonomy"), "Browser removes the unused frontend autonomy command until policy enforcement exists");
assert(!uiSource.includes("displayedAutonomy") && !uiSource.includes("onAutonomyChange={setTaskAutonomy}"), "Browser UI does not present inert autonomy states");
assert(
  vaultPromptCardsSource.includes("VaultPromptCards") &&
    vaultPromptCardsSource.includes('data-debug-id="shellx-browser-vault-prompt-stack"') &&
    vaultPromptCardsSource.includes('data-debug-id="shellx-browser-vault-prompt-card"') &&
    vaultPromptCardsSource.includes("prompts.slice(0, 3)") &&
    /rightPanelTab === "requests"[\s\S]*?<VaultPromptCards/.test(agentSidebarSource),
  "browser Vault prompt cards live in the dedicated Requests tab",
);
assert(uiSource.includes("scriptBlockingEnabled"), "browser UI keeps script blocking as an explicit advanced toggle");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-ad-filter\""), "browser UI exposes ad mode option in the header");
assert(browserChromeSource.includes("className=\"shellx-browser-address-actions\""), "browser header keeps action icons in a fixed visible cluster");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-downloads\""), "browser UI exposes downloads/uploads status");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-bookmark-current\""), "browser UI exposes bookmark current page action");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-bookmarks-menu\""), "browser UI exposes bookmarks from the compact header menu");
assert(bookmarkToolbarSource.includes("data-debug-id=\"shellx-browser-bookmark-toolbar\""), "Browser renders a bookmark toolbar");
assert(bookmarkSidecarSource.includes("data-debug-id=\"shellx-browser-bookmark-manager\""), "Browser exposes a bookmark manager");
assert(bookmarkSidecarSource.includes("shellx-browser-bookmark-manager-dock"), "Browser bookmark manager lives outside native page overlay");
assert(bookmarkToolbarSource.includes("shellx-browser-bookmark-folder-menu"), "Browser toolbar folders open as menus");
assert(bookmarkSidecarSource.includes("data-debug-id=\"shellx-browser-bookmark-list\""), "browser UI opens bookmarks as a readable docked list");
assert(bookmarkSidecarSource.includes("data-debug-id=\"shellx-browser-bookmark-list-mode\""), "browser UI exposes an explicit bookmark list tab");
assert(bookmarkSidecarSource.includes("data-debug-id=\"shellx-browser-bookmark-manager-toggle\""), "browser UI exposes explicit bookmark list/manage modes");
assert(bookmarkSidecarSource.includes("New folder") && bookmarkSidecarSource.includes("Add link"), "browser bookmark manager uses clear creation labels");
assert(bookmarkSidecarSource.includes("shellx-browser-bookmark-pin-"), "browser bookmark manager exposes per-bookmark toolbar visibility actions");
assert(bookmarkSidecarSource.includes("shellx-browser-bookmark-sidecar"), "browser bookmark manager opens as a compact left sidecar");
assert(bookmarkSidecarSource.includes("data-debug-id={`shellx-browser-bookmark-label-${bookmark.bookmarkId}`}"), "browser bookmark manager renames inline in the row");
assert(bookmarkSidecarSource.includes("data-debug-id={`shellx-browser-bookmark-url-${bookmark.bookmarkId}`}"), "browser bookmark manager edits link URLs inline in the row");
assert(browserDebugBridgeSource.includes('new FocusEvent("focusout", { bubbles: true })'), "browser debug input blur path triggers React blur handlers");
assert(!bookmarkSidecarSource.includes("data-debug-id=\"shellx-browser-bookmark-folder-root\""), "browser bookmark manager does not expose a fake Bookmarks root drop target");
assert(!bookmarkSidecarSource.includes("shellx-browser-bookmark-folder-targets"), "browser bookmark manager does not duplicate folders in a separate target strip");
assert(bookmarkSidecarSource.includes('data-bookmark-folder-target-id={bookmark.kind === "folder" ? bookmark.bookmarkId : undefined}'), "browser bookmark folder rows are direct drop targets");
assert(browserBookmarkHookSource.includes("export function useBrowserBookmarks") && browserBookmarkHookSource.includes("parentId,") && !browserBookmarkHookSource.includes('kind: "folder",\n        toolbarPinned: true'), "browser bookmark management lives in a focused hook and new folders do not auto-pin to the toolbar");
assert(!browserBookmarkHookSource.includes("toolbarPinned: !bookmarkDraftParentId"), "browser new links do not auto-pin to the toolbar");
assert(bookmarkSidecarSource.includes("shellx-browser-bookmark-icon-action"), "browser bookmark manager uses compact icon actions");
assert(bookmarkSidecarSource.includes("data-debug-id={`shellx-browser-bookmark-drag-${bookmark.bookmarkId}`}"), "browser bookmark manager exposes a dedicated drag handle per row");
assert(browserBookmarkHookSource.includes("startBookmarkPointerDrag"), "browser bookmark manager supports pointer drag sorting from the visible handle");
assert(!uiSource.includes("window.prompt(\"Bookmark name\""), "browser bookmark manager does not use prompt-based rename");
assert(!uiSource.includes("Toolbar/root"), "browser bookmark manager avoids unclear Toolbar/root folder labels");
assert(
  cssSource.includes(".shellx-browser-bookmark-manager-head {\n  min-width: 0;\n  display: grid;") &&
    cssSource.includes(".shellx-browser-bookmark-manager-actions {\n  grid-column: 1 / -1;"),
  "browser bookmark manager keeps List/Edit below the title instead of covering it",
);
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-history-menu\""), "browser UI exposes history from the compact header control");
assert(browserHistorySidecarSource.includes("data-debug-id=\"shellx-browser-history-user\""), "browser UI exposes user history tab");
assert(browserHistorySidecarSource.includes("data-debug-id=\"shellx-browser-history-agent\""), "browser UI exposes agent history tab");
assert(
  browserHistorySidecarSource.includes("className=\"shellx-browser-history-list-row\"") &&
    browserHistorySidecarSource.includes("className=\"shellx-browser-history-url\"") &&
    browserHistorySidecarSource.includes("title={entry.url}"),
  "browser history rows show actual URLs in stable non-deforming rows",
);
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-profile-marker\""), "browser UI leaves only a compact profile marker in the header");
assert(!uiSource.includes("className=\"shellx-browser-profile-chip\""), "browser UI removes the visible header profile selector chip");
assert(browserMenusSource.includes("data-debug-id=\"shellx-browser-color-mode\""), "browser UI exposes color mode option");
assert(!browserMenusSource.includes("data-debug-id=\"shellx-browser-engine-mode\"") && !browserMenusSource.includes("Background only"), "browser UI hides background-only mode until a non-presentational engine exists");
assert(browserMenusSource.includes("data-debug-id=\"shellx-browser-parallel-agents\""), "browser UI exposes parallel agent capacity option");
assert(browserHistorySidecarSource.includes("data-debug-id=\"shellx-browser-clear-history\""), "browser UI exposes clear-history action");
assert(
  browserPreferencesSource.includes("COLOR_MODE_STORAGE_KEY") &&
    browserShellEffectsSource.includes("persistBrowserColorMode(colorMode") &&
    browserPreferencesSource.includes("window.localStorage.removeItem(COLOR_MODE_STORAGE_KEY)") &&
    browserPreferencesSource.includes("window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, value)") &&
    browserMenusSource.includes("shellx-browser-color-mode"),
  "browser UI stores local color mode preference",
);
assert(
  browserApiSource.includes("shellx_browser_clear_history") &&
    browserHistoryClearSource.includes("clearBrowserHistoryCommand"),
  "browser UI can call the local clear-history command",
);
assert(browserMenusSource.includes("data-debug-id=\"shellx-browser-toggle-right-sidebar\""), "browser UI can hide the right sidebar");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-toggle-right-sidebar-button\""), "browser UI exposes visible right sidebar toggle");
assert(uiSource.includes("historySidecarOpen") && cssSource.includes(".shellx-browser-left-sidecar"), "browser UI supports a left sidecar surface for long lists");
assert(agentSidebarSource.includes("className=\"shellx-browser-panel-toggle shellx-browser-panel-toggle-right\""), "right sidebar hide control lives on the right panel edge");
assert(
  agentSidebarSource.indexOf("data-debug-id=\"shellx-browser-toggle-right-sidebar-button\"") <
    agentSidebarSource.indexOf("className=\"shellx-browser-right-tabs\"") &&
    !agentSidebarSource.includes("shellx-browser-sidebar-autonomy"),
  "browser panel tabs follow the collapse control without an inert autonomy row",
);
assert(
  browserChromeSource.includes("data-debug-id=\"shellx-browser-show-right-sidebar-button\"") &&
    uiSource.indexOf("<BrowserChrome") < uiSource.indexOf("<div className={gridClassName}") &&
    !uiSource.includes("shellx-browser-panel-restore-right"),
  "browser right-sidebar restore control stays in top chrome instead of being covered by the native page",
);
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-agent-panel\""), "browser task composer lives in the Agent sidebar");
assert(agentSidebarSource.includes("className=\"shellx-browser-agent-compose\""), "browser Agent sidebar has a dedicated task compose form");
assert(!agentSidebarSource.includes("data-debug-id=\"shellx-browser-agent-route\""), "browser Agent sidebar removes the local route chip");
assert(!agentSidebarSource.includes("Browser chat"), "browser Agent sidebar removes the redundant Browser chat title");
assert(!agentSidebarSource.includes("Browser local"), "browser Agent sidebar removes the redundant Browser local label");
assert(!uiSource.includes("No browser task started"), "browser page removes the duplicated current-task block");
assert(!uiSource.includes("<span className=\"shellx-browser-kicker\">Current task</span>"), "browser page does not duplicate task state above the viewport");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-agent-chat-stream\""), "browser Agent sidebar renders a chat-style stream");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-agent-send\""), "browser Agent sidebar has an icon send action");
assert(!agentSidebarSource.includes("data-debug-id=\"shellx-browser-agent-stop\""), "browser Agent sidebar removes the duplicate stop action");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-agent-pause\""), "browser Agent sidebar exposes a pause action");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-agent-resume\""), "browser Agent sidebar exposes a resume action");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-agent-takeover\""), "browser Agent sidebar exposes user takeover action");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-agent-abort\""), "browser Agent sidebar exposes abort action");
assert(agentSidebarSource.includes("Abort task"), "browser Agent sidebar labels the destructive task cancel action clearly");
assert(!agentSidebarSource.includes("data-debug-id=\"shellx-browser-expand-chat\""), "browser Agent chat removes the expand/compact toggle");
assert(!uiSource.includes("setChatExpanded"), "browser Agent chat does not keep obsolete expand state");
assert(agentSidebarSource.includes("className=\"shellx-browser-agent-panel chat-expanded\""), "browser Agent chat stays expanded by default");
assert(!agentSidebarSource.includes("className=\"shellx-browser-agent-autonomy\""), "browser Agent autonomy control is no longer inside chat chrome");
assert(!agentSidebarSource.includes("className=\"shellx-browser-sidebar-autonomy\""), "browser removes the inert autonomy control from sidebar chrome");
assert(uiSource.includes('const [profileId, setProfileId] = useState(USER_DEFAULT_PROFILE_ID)'), "browser user-opened tabs default to the personal profile");
assert(browserAppConstantsSource.includes('USER_DEFAULT_PROFILE_ID = "personal"'), "browser normal navigation has an explicit user-default profile");
assert(browserTasksHookSource.includes("const taskProfileId = profileId === userDefaultProfileId ? agentDefaultProfileId : profileId"), "browser chat tasks switch personal selection to the agent profile");
assert(
  browserTaskIntentSource.includes("inferBrowserTaskStartUrl") &&
    browserTaskIntentSource.includes("https://www.google.com/search") &&
    browserTasksHookSource.includes("inferBrowserTaskStartUrl(taskGoal, address.trim())") &&
    !browserTasksHookSource.includes("startUrl: address.trim() || null"),
  "browser chat infers explicit open/search intents instead of cloning the current address",
);
assert(browserTabsHookSource.includes("export function useBrowserTabs") && browserTabsHookSource.includes("const newTab = (nextProfileId = userDefaultProfileId)"), "browser normal new tabs default to user profile");
assert(
  browserTabsHookSource.includes('const newTabUrl = homeUrl.trim() || DEFAULT_HOME_URL') &&
    browserTabsHookSource.includes("url: newTabUrl") &&
    !browserTabsHookSource.includes("url: address.trim() || null"),
  "browser new tabs open the configured new-tab/home URL instead of cloning the active page",
);
assert(
  uiSource.includes(": activeBrowserTab\n      ? (activeBrowserTab.url?.trim() || \"about:blank\")") &&
    uiSource.includes(": activeTask?.currentUrl?.trim() || address.trim() || state?.pendingStartUrl?.trim() || \"\""),
  "browser engine URL respects a blank active tab instead of falling back to the previous address",
);
assert(
  uiSource.includes('tabs.length === 0\n    ? "about:blank"') &&
    uiSource.includes('if (tabs.length === 0) return ""'),
  "browser engine and address bar reset to blank when all tabs are closed",
);
assert(
  uiSource.includes("activeEngineId: activeBrowserTab?.engineId ?? null") &&
    !uiSource.includes("activeEngineId: activeBrowserTab?.engineId ?? state?.engine?.engineId"),
  "browser blank-state sync does not reuse a stale background engine id",
);
assert(!uiSource.includes("await apiPostJson(\"/browser/task/start\", {\n          goal,\n          startUrl: url,\n          profileId,\n          autonomy,"), "browser address navigation does not start an agent task");
assert(rustBrowser.includes("browserUserNavigated"), "Browser backend supports taskless user-tab navigation receipts");
assert(rustBrowser.includes("taskless bookmarkCurrent"), "Browser backend supports user bookmarks without an agent task");
assert(
  rustBrowser.includes("state.active_task_id = active_tab_task_id") &&
    rustBrowser.includes("active tab selection must clear stale agent task context"),
  "Browser backend clears stale active task context when focusing a taskless tab",
);
assert(uiSource.includes("browserChatMessages"), "browser Agent chat renders chat messages instead of raw receipt notifications");
assert(!uiSource.includes("receipts.slice().reverse().slice(0, 5).map((receipt)"), "browser Agent chat is not a raw receipt notification feed");
assert(
  uiSource.includes("useBrowserCowork") &&
    appSource.includes("useBrowserCoworkPromptBridge") && browserApiSource.includes("shellx_browser_send_cowork_prompt"),
  "browser Chat routes through its attached real ShellX agent session",
);
assert(browserPresentationSource.includes("parsed.search = \"\"") && browserPresentationSource.includes("parsed.hash = \"\""), "browser UI strips query and fragment before rendering agent-facing status URLs");
assert(!uiSource.includes("Task is ${activeTask.status"), "browser Agent chat does not synthesize status replies");
assert(!agentSidebarSource.includes("data-debug-id=\"shellx-browser-start-task\""), "browser Agent sidebar removes the visible Start button");
assert(!agentSidebarSource.includes("data-debug-id=\"shellx-browser-observe\""), "browser Agent sidebar removes the visible Observe button");
assert(!agentSidebarSource.includes("data-debug-id=\"shellx-browser-extract\""), "browser page save moves out of the Agent sidebar");
assert(agentSidebarSource.includes("onSubmit={onSubmitTask}"), "browser task input supports Enter-to-start through a form submit");
assert(agentSidebarSource.includes("onKeyDown={onSubmitTaskFromKeyboard}"), "browser Agent composer maps Enter to task submit");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-right-tab-chat\""), "browser right panel exposes a Chat tab");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-right-tab-requests\""), "browser right panel exposes a Requests tab");
assert(
  agentSidebarSource.indexOf("data-debug-id=\"shellx-browser-right-tab-chat\"") <
    agentSidebarSource.indexOf("data-debug-id=\"shellx-browser-right-tab-requests\"") &&
    agentSidebarSource.indexOf("data-debug-id=\"shellx-browser-right-tab-requests\"") <
      agentSidebarSource.indexOf("data-debug-id=\"shellx-browser-right-tab-actions\""),
  "browser right panel places Requests immediately after Chat",
);
assert(agentSidebarSource.includes("shellx-browser-tab-badge"), "browser Requests tab shows a count badge");
assert(!agentSidebarSource.includes("data-debug-id=\"shellx-browser-right-tab-dev\""), "browser right panel removes the user-facing Dev tab");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-right-tab-actions\""), "browser right panel exposes an agent action log tab");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-right-tab-errors\""), "browser right panel exposes a page errors tab");
assert(uiSource.includes("previousVaultPromptCountRef") && uiSource.includes("setRightPanelTab(\"requests\")"), "browser focuses Requests when new Vault prompts arrive");
assert(uiSource.includes("const selectRightPanelTab"), "browser right panel tabs close overlapping header menus before switching");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-save-page\""), "browser header exposes user-facing page save");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-downloads-menu\""), "browser header exposes a Downloads manager");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-downloads-badge\""), "browser header Downloads icon exposes transfer status badge");
assert(browserMenusSource.includes("shellx-browser-save-fullpage-screenshot"), "browser page save menu includes local full-page screenshot");
assert(browserMenusSource.includes("shellx-browser-save-screenshot"), "browser page save menu includes local window screenshot");
assert(browserMenusSource.includes("shellx-browser-save-markdown"), "browser page save menu includes local Markdown extraction");
assert(browserMenusSource.includes("shellx-browser-save-links"), "browser page save menu includes local links extraction");
assert(browserMenusSource.includes("shellx-browser-save-snapshot"), "browser page save menu includes local snapshot bundle");
assert(
  !browserMenusSource.includes("shellx-browser-explain-page") &&
    !browserMenusSource.includes("kind: \"explain\""),
  "browser page save menu keeps agent explain action out of file-save actions",
);
assert(
  agentSidebarSource.includes("data-debug-id=\"shellx-browser-chat-explain-page\"") &&
    agentSidebarSource.includes("onExplainPage") &&
    uiSource.includes("requestChatExplainPage"),
  "browser chat sidebar exposes Explain page as an agent action",
);
assert(browserMenusSource.includes("shellx-browser-save-media"), "browser page save menu includes media save");
assert(browserMenusSource.includes("shellx-browser-save-code"), "browser page save menu includes code save");
assert(browserMenusSource.includes("shellx-browser-save-site"), "browser page save menu includes whole-site save intent");
assert(downloadSidecarSource.includes("data-debug-id=\"shellx-browser-download-sidecar\""), "browser Downloads manager opens as a left sidecar");
assert(downloadSidecarSource.includes("data-debug-id=\"shellx-browser-download-folder\""), "browser Downloads manager exposes default folder setting");
assert(downloadSidecarSource.includes("data-debug-id=\"shellx-browser-download-list\""), "browser Downloads manager shows transfer rows");
assert(downloadSidecarSource.includes("transferStatusLabel") && downloadSidecarSource.includes("\"Queued\"") && downloadSidecarSource.includes("\"Saved\""), "browser Downloads manager uses user-facing status labels");
assert(settingsModelSource.includes("browserDownloadFolder") && generalTabSource.includes("settings-browser-download-folder"), "global Settings expose Browser default download folder");
assert(generalTabSource.includes("onInput={(event) => patchBrowserDownloadFolder(event.currentTarget.value)}"), "global Settings Browser download folder works with debug input events");
assert(debugApi.includes("\"browserDownloadFolder\""), "Debug API settings persist Browser default download folder");
assert(
  browserPreferencesSource.includes("readSettingsLocal") &&
    browserPreferencesSource.includes("persistSettings(next)") &&
    browserPreferencesSource.includes("browserDownloadFolder") &&
    browserShellEffectsSource.includes("persistBrowserDownloadFolder"),
  "browser Downloads sidecar uses the shared Settings download folder",
);
assert(browserPageActionsSource.includes("destinationDir: defaultDownloadFolder.trim()"), "browser page save carries the configured download folder");
assert(browserPageActionsSource.includes("grantBrowserTransfer") && browserPageActionsSource.includes("/browser/downloads/complete"), "browser user-initiated local page saves complete download rows");
assert(browserPageActionsSource.includes("writeBrowserTextArtifact") && browserPageActionsSource.includes("copyBrowserLocalArtifact"), "browser local page saves write artifacts through operator-owned Tauri commands");
assert(browserPageActionsSource.includes("export function useBrowserPageActions") && uiSource.includes("useBrowserPageActions({"), "browser page-save workflow lives in a focused hook");
assert(
  browserPageActionsSource.includes("browserExplainGoal") &&
    browserPresentationSource.includes("boundedBrowserExplainExcerpt") &&
    browserPageActionsSource.includes("requestExplainPage") &&
    browserPageActionsSource.includes("safeStartUrl.startsWith(\"about:\")") &&
    uiSource.includes("setRightPanelTab(CHAT_PANEL)") && browserAppConstantsSource.includes('CHAT_PANEL = "chat"'),
  "browser explain action starts a bounded sanitized Browser task in the chat panel",
);
assert(browserApiSource.includes("shellx_browser_write_text_artifact") && browserApiSource.includes("shellx_browser_copy_local_artifact"), "browser API exposes local artifact write/copy commands");
assert(rustLib.includes("shellx_browser_transfer_artifacts::shellx_browser_write_text_artifact"), "browser text artifact command is registered with Tauri");
assert(rustLib.includes("shellx_browser_transfer_artifacts::shellx_browser_copy_local_artifact"), "browser local artifact copy command is registered with Tauri");
assert(rustBrowserTransferArtifacts.includes("sanitized_download_file_name") && rustBrowserTransferArtifacts.includes("unique_destination_path"), "browser local artifact writes sanitize filenames and avoid collisions");
assert(rustBrowserTransfers.includes("enforce_home_containment") && rustBrowserTransferArtifacts.includes("browser_download_destination"), "browser local artifact destinations use the shared host filesystem containment policy");
assert(rustBrowserTransferArtifacts.includes("ensure_browser_local_artifact_source_allowed") && rustBrowserTransferArtifacts.includes("shellx-browser-screenshots"), "browser local artifact copy is limited to ShellX Browser generated artifact roots");
assert(hostMcp.includes("/.shellx/browser-settings.json") && hostMcp.includes("/.shellx/browser-artifacts/shellx-browser-screenshots/"), "host MCP fs denylist protects Browser settings and screenshot artifacts");
assert(browserActionResultsSource.includes("record_taskless_engine_observation_locked") && browserActionResultsSource.includes("record_taskless_screenshot_result_locked"), "browser local save actions work from taskless user tabs");
assert(cssSource.includes(".shellx-browser-download-icon-status.pending .shellx-browser-download-badge"), "browser Downloads badge has explicit visible pending colors");
assert(uiSource.includes("setHeaderMenu(DOWNLOADS_MENU)") && browserAppConstantsSource.includes('DOWNLOADS_MENU = "downloads"'), "browser page save opens the Downloads manager after saving or queuing");
assert(uiSource.includes("setRightPanelTab(\"actions\")"), "browser page save also surfaces the transfer log");
for (const section of ["tasks", "console", "receipts"]) {
  assert(agentSidebarSource.includes(`data-debug-id=\"shellx-browser-collapse-${section}\"`), `browser UI can collapse ${section}`);
}
assert(
  browserApiSource.includes("shellx_browser_sync_engine") &&
    nativeEngineSyncSource.includes("syncBrowserEngine") &&
    uiSource.includes("useNativeEngineSync"),
  "browser UI syncs the native engine",
);
assert(uiSource.includes("inTauri()") && uiSource.includes('const activeBrowserTabTerminal = ["completed", "blocked", "aborted"].includes') && uiSource.includes("tabs.length > 0 && !activeBrowserTabTerminal"), "browser UI gates native engine sync in web QA and after terminal disposable task cleanup");
assert(
  browserChromeSource.includes("shellx-browser-chrome-shell") &&
    browserChromeSource.includes("data-debug-id=\"shellx-browser-chrome-menu-dock\"") &&
    browserChromeShellCss.includes("position: relative;") &&
    browserChromeMenuDockCss.includes("position: absolute;") &&
    browserChromeMenuDockCss.includes("top: 100%;"),
  "browser small menus overlay below the toolbar without pushing the native WebView",
);
assert(
  uiSource.includes("setBookmarkManagerOpen(false);") &&
    uiSource.includes("setOpenToolbarFolderId(null);") &&
    uiSource.includes("setHeaderMenu((current)"),
  "browser header menus and options close bookmark surfaces before opening",
);
assert(
  browserEngineRuntimeSource.includes("park_inactive_browser_engine_webviews") &&
    browserEngineRuntimeSource.includes("browser_engine_bounds_are_background") &&
    browserEngineRuntimeSource.includes("failed to hide inactive Browser engine") &&
    browserEngineRuntimeSource.includes("failed to show Browser engine") &&
    browserEngineRuntimeSource.includes("failed to park inactive Browser engine"),
  "native Browser sync hides and parks inactive WebView engines off-screen",
);
for (const avoidedTerm of ["rewards", "crypto", "wallet upsell", "sponsored new-tab", "affiliate"]) {
  assert(!uiSourceLower.includes(avoidedTerm), `browser UI defaults avoid ${avoidedTerm}`);
}
assert(browserStateHookSource.includes("if (inTauri()) setError"), "browser UI does not show Debug API fetch banners during web-only visual QA");
assert(
  nativeEngineSyncSource.includes("ResizeObserver") &&
    nativeEngineSyncSource.includes("syncBrowserEngine") &&
    browserApiSource.includes("shellx_browser_sync_engine"),
  "browser UI keeps native engine bounds aligned",
);
assert(uiSource.includes("rightSidebarWidth"), "browser right sidebar width is user-resizable");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-sidebar-resize\""), "browser right sidebar exposes a resize handle");
assert(engineViewportSource.includes("shellx-browser-engine-slot"), "browser UI exposes a stable native engine slot");
assert(nativeEngineSyncSource.includes("retry sync shortly"), "browser UI retries transient native engine remounts without surfacing a hard error");
assert(cssSource.includes(".shellx-browser-app"), "browser UI has CSS");
assert(cssSource.includes(".shellx-browser-console"), "browser console panel has CSS");
assert(cssSource.includes(".shellx-browser-tab-strip"), "browser tab strip has CSS");
assert(cssSource.includes(".shellx-browser-transfer-list"), "browser transfer list has CSS");
assert(cssSource.includes(".shellx-browser-download-sidecar") && cssSource.includes(".shellx-browser-download-row"), "browser Downloads sidecar has CSS");
assert(cssSource.includes(".shellx-browser-options-sidecar"), "browser settings sidecar has CSS");
assert(cssSource.includes(".shellx-browser-agent-panel"), "browser Agent sidebar panel has CSS");
assert(cssSource.includes(".shellx-browser-personal-lock-btn.locked") && cssSource.includes(".shellx-browser-personal-lock-btn.unlocked"), "browser Personal Lock button has locked/unlocked state colors");
assert(cssSource.includes(".shellx-browser-lock-notice"), "browser Personal Lock structured notice has CSS");
assert(cssSource.includes(".shellx-browser-actions-panel .shellx-browser-receipt small") && cssSource.includes("overflow-wrap: anywhere"), "browser Actions tab text wraps instead of squeezing");
assert(cssSource.includes(".shellx-browser-profile-marker"), "browser compact profile marker has CSS");
assert(cssSource.includes(".shellx-browser-ownership-banner"), "browser tab ownership banner has CSS");
assert(cssSource.includes(".shellx-browser-trust-chip"), "browser trust chip has CSS");
assert(cssSource.includes(".shellx-browser-trust-chip.insecureHttp"), "browser trust chip has an insecure HTTP state");
assert(cssSource.includes(".shellx-browser-shields-panel"), "browser Shields panel has CSS");
assert(cssSource.includes(".shellx-browser-bookmark-toolbar"), "browser bookmark toolbar has CSS");
assert(cssSource.includes(".shellx-browser-bookmark-manager"), "browser bookmark manager has CSS");
assert(cssSource.includes(".shellx-browser-bookmark-manager-dock"), "browser bookmark manager shell has CSS");
assert(cssSource.includes(".shellx-browser-bookmark-sidecar"), "browser bookmark manager sidecar has CSS");
assert(cssSource.includes(".shellx-browser-bookmark-folder-menu"), "browser bookmark folders have dropdown CSS");
assert(uiSource.includes("openToolbarFolderId"), "browser toolbar folders are click-toggled instead of hover-only");
assert(bookmarkToolbarSource.includes("data-debug-id={`shellx-browser-bookmark-folder-menu-${openToolbarFolder.bookmarkId}`}"), "browser toolbar folder menus expose debug ids");
assert(bookmarkToolbarSource.includes("data-debug-id={`shellx-browser-bookmark-folder-child-${child.bookmarkId}`}"), "browser toolbar folder child rows expose debug ids");
assert(cssSource.includes(".shellx-browser-header-popover"), "browser compact header menus have CSS");
assert(cssSource.includes(".shellx-browser-right-tabs"), "browser right panel tabs have CSS");
assert(cssSource.includes("grid-template-columns: repeat(5") && cssSource.includes(".shellx-browser-tab-badge") && cssSource.includes(".shellx-browser-requests-panel"), "browser right panel fits Requests and Evidence tabs");
assert(
  browserTopCss.includes("overflow: visible;") &&
    browserTabChromeCss.includes("overflow: visible;") &&
    browserTabStripCss.includes("overflow: visible;") &&
    browserHeaderMenuWrapCss.includes("z-index: 140;") &&
    browserHeaderPopoverCss.includes("z-index: 160;"),
  "browser header popovers render above active tabs and are not clipped by Browser chrome",
);
assert(
  browserBookmarkToolbarCss.includes("overflow: visible;") &&
    cssSource.includes(".shellx-browser-bookmark-folder-menu-dock") &&
    cssSource.includes("z-index: 150;"),
  "browser bookmark toolbar folder menus render above page chrome without toolbar clipping",
);
assert(cssSource.includes(".shellx-browser-agent-chat-stream"), "browser chat stream has CSS");
assert(cssSource.includes(".shellx-browser-agent-panel.chat-expanded"), "browser expanded chat layout has CSS");
assert(cssSource.includes(".shellx-browser-address-actions"), "browser header action cluster has CSS");
assert(
  browserAppCss.includes("height: 100vh;") &&
    browserAppCss.includes("overflow: hidden;"),
  "browser app shell is viewport-constrained so side panels scroll internally",
);
assert(cssSource.includes("grid-template-columns: 32px 32px 32px 32px minmax(160px, 1fr) max-content;"), "browser address row reserves a fixed home/action column");
assert(cssSource.includes(".shellx-browser-right-controls"), "browser right sidebar control row has CSS");
assert(!cssSource.includes(".shellx-browser-sidebar-autonomy"), "browser removes stale autonomy control CSS");
assert(cssSource.includes(".shellx-browser-agent-panel.chat-expanded .shellx-browser-agent-compose"), "browser expanded chat pins composer inside the panel");
assert(
  browserExpandedAgentComposeCss.includes("padding-bottom:") &&
    browserExpandedAgentComposeCss.includes("env(safe-area-inset-bottom)") &&
    browserExpandedAgentComposeCss.includes("overflow: visible"),
  "browser expanded chat composer reserves bottom space so wrapped Abort/Takeover controls are not clipped",
);
assert(
  agentSidebarSource.includes("className=\"shellx-browser-actions-panel shellx-browser-scroll-panel\"") &&
    agentSidebarSource.includes("data-debug-id=\"shellx-browser-actions-panel\""),
  "browser Actions tab uses a constrained, test-addressable scroll panel",
);
assert(agentSidebarSource.includes("className=\"shellx-browser-console shellx-browser-scroll-panel\""), "browser Errors tab uses a constrained scroll panel");
assert(
  cssSource.includes(".shellx-browser-scroll-panel") &&
    cssSource.includes(".shellx-browser-scroll-panel {\n  min-width: 0;") &&
    cssSource.includes("height: 100%;") &&
    cssSource.includes("overflow: auto;") &&
    cssSource.includes("overscroll-behavior: contain;"),
  "browser right-panel tab content has a shared internal scroll contract",
);
assert(
  cssSource.includes(".shellx-browser-dev-panel,\n.shellx-browser-actions-panel {\n  min-width: 0;") ||
    cssSource.includes(".shellx-browser-actions-panel {\n  min-width: 0;"),
  "browser Actions tab can shrink inside the right sidebar column",
);
assert(
  cssSource.includes(".shellx-browser-right-tabs button {\n  min-width: 0;") &&
    cssSource.includes("text-overflow: ellipsis;") &&
    cssSource.includes(".shellx-browser-tab-badge {\n  min-width: 16px;\n  flex: 0 0 auto;"),
  "browser right-panel tab labels stay readable in narrow sidebar widths",
);
assert(
  cssSource.includes(".shellx-browser-receipt {\n  min-width: 0;") &&
    cssSource.includes(".shellx-browser-receipt span {\n  min-width: 0;\n  max-width: 100%;") &&
    cssSource.includes(".shellx-browser-transfer {\n  min-width: 0;") &&
    cssSource.includes(".shellx-browser-transfer span {\n  width: fit-content;\n  max-width: 100%;"),
  "browser Actions tab receipts and transfer chips cannot force horizontal text distortion",
);
assert(cssSource.includes(".shellx-browser-agent-chat-stream") && cssSource.includes("overscroll-behavior: contain;"), "browser Chat stream keeps internal scroll containment");
assert(cssSource.includes(".shellx-browser-sidebar-resize"), "browser right sidebar resize handle has CSS");
assert(cssSource.includes(".shellx-browser-panel-toggle"), "browser side panel edge toggles have CSS");
assert(cssSource.includes(".shellx-browser-app[data-color-mode"), "browser color modes have CSS");
assert(
  cssSource.includes("@media (prefers-color-scheme: dark)") &&
    cssSource.includes(".shellx-browser-app[data-color-mode=\"system\"]") &&
    cssSource.includes("--ink: #f5f5f4"),
  "browser system color mode has readable dark-system tokens",
);
assert(cssSource.includes(".shellx-browser-empty-state"), "browser sidebar empty states have CSS");
assert(!cssSource.includes(".shellx-browser-grid.hide-left"), "browser grid no longer carries left-sidebar layout state");
assert(cssSource.includes(".shellx-browser-grid.hide-right"), "browser grid supports hidden right sidebar");
assert(cssSource.includes(".shellx-browser-tabs::-webkit-scrollbar"), "browser tab rail hides WebKit scrollbars");
assert(cssSource.includes("scrollbar-width: none"), "browser tab rail hides Firefox scrollbars");
assert(!cssSource.includes("inset 0 2px 0 rgba(34, 197, 94, 0.7)"), "browser active-tab highlight does not overlay tab text");
assert(cssSource.includes("0 0 0 3px rgba(34, 197, 94, 0.06)"), "browser active-tab highlight uses an outer readable glow");
assert(cssSource.includes("pointer-events: none"), "browser viewport placeholder cannot steal page scroll input");
assert(!uiSource.includes("shellx-browser-bookmarks-popover"), "browser bookmarks no longer open in a page-overlaid popover");
assert(bookmarkSidecarSource.includes("data-debug-id=\"shellx-browser-bookmark-list\""), "browser bookmarks open first as a docked list");
assert(bookmarkSidecarSource.includes("renderBookmarkManagerRow"), "browser bookmark manager renders sortable folder rows");
assert(browserChromeSource.includes("draggable={!busy}") && bookmarkSidecarSource.includes("draggable={!busy}"), "browser tabs and bookmarks expose drag sorting hooks");
assert(apiDocs.includes("/browser/state"), "API docs include browser state route");
assert(apiDocs.includes("/browser/summary") && apiDocs.includes("/browser/check") && apiDocs.includes("under 16 KB") && apiDocs.includes("never creates a task"), "API docs describe bounded Browser summary and quiet-check contracts");
assert(apiDocs.includes("/browser/settle") && apiDocs.includes("server waits internally"), "API docs describe compact Browser navigation settlement");
assert(apiDocs.includes("/browser/tabs"), "API docs include browser tabs routes");
assert(apiDocs.includes("/browser/tabs/reorder"), "API docs include browser tab reorder route");
assert(apiDocs.includes("/browser/bookmarks/reorder"), "API docs include bookmark manager routes");
assert(apiDocs.includes("/browser/privacy"), "API docs include browser privacy route");
assert(apiDocs.includes("shellx_browser_update_privacy"), "API docs document Browser privacy operator command");
assert(apiDocs.includes("shellx_browser_update_shields"), "API docs document Browser Shields operator command");
assert(apiDocs.includes("shellx_browser_update_site_shields"), "API docs document Browser site Shields operator command");
assert(apiDocs.includes("strict") && moduleReadme.includes("native request"), "Browser docs describe strict native request filtering");
assert(apiDocs.includes("/browser/shields"), "API docs include browser Shields route");
assert(apiDocs.includes("/browser/downloads/request"), "API docs include browser download intent route");
assert(apiDocs.includes("stepSummary"), "API docs include compact Browser step summaries");
assert(apiDocs.includes("shellx_browser_delegate_tab_to_agent"), "API docs include Browser tab handoff command");
assert(apiDocs.includes("/browser/action"), "API docs include browser actions");
assert(apiDocs.includes("/browser/tabs/lock"), "API docs include browser tab lock route");
assert(apiDocs.includes("/browser/personal-lock"), "API docs include personal lock read route");
assert(apiDocs.includes("current route inventory refreshed 2026-08-14"), "API docs inventory date is current");
assert(apiDocs.includes("clearSiteData") && apiDocs.includes("capturePageSecretToVault"), "API docs include current Browser action names");
assert(uiSource.includes('data-debug-id="shellx-browser-personal-lock-overlay"'), "browser UI exposes personal lock overlay selector");
assert(browserChromeSource.includes('data-debug-id="shellx-browser-tab-strip"'), "browser UI exposes Browser tab strip selector");
assert(browserChromeSource.includes("shellx-browser-close-tab-"), "browser chrome exposes Browser tab close controls");
assert(browserChromeSource.includes("shellx-browser-new-disposable-tab"), "browser chrome exposes disposable Browser tab control");
assert(browserChromeSource.includes("shellx-browser-bookmarks-menu"), "browser menus expose compact bookmark controls");
assert(agentSidebarSource.includes("shellx-browser-agent-chat-stream"), "browser Agent sidebar exposes chat controls");
assert(browserChromeSource.includes("shellx-browser-save-page"), "browser menus expose page save controls");
assert(moduleReadme.includes("ShellX Browser"), "top-level shellx-browser module README exists");
assert(moduleReadme.includes("browser_navigate"), "Browser README documents native Browser navigation");
assert(moduleReadme.includes("browser_screenshot"), "Browser README documents full-page Browser screenshot evidence");
assert(moduleReadme.includes("browser_capture_secret_to_vault"), "Browser README documents direct Vault capture");
assert(moduleReadme.includes("browser_read_email_code"), "Browser README documents email-code grants");
assert(moduleReadme.includes("formFieldGroups") && shellxHostSkill.includes("formFieldGroups"), "Browser docs teach grouped form intent metadata");
assert(moduleReadme.includes("Only three modes are user-facing") && !moduleReadme.includes("Visual Clean Compatibility"), "Browser README documents the three user-facing ad modes");
assert(moduleReadme.includes("does not run browser-owned ads"), "Browser README documents no browser-owned ads");
assert(moduleReadme.includes("URL affiliate rewriting"), "Browser README documents no affiliate rewriting");
assert(moduleReadme.includes("stepSummary"), "Browser README documents compact Browser step summaries");
assert(moduleReadme.includes("task-scoped"), "Browser README documents task-scoped extraction");
assert(moduleReadme.includes("Magika"), "Browser README records Magika classifier role");
assert(moduleReadme.includes("MarkItDown"), "Browser README records MarkItDown converter role");
assert(moduleReadme.includes("Maxun"), "Browser README records Maxun inspiration role");
assert(
  moduleReadme.includes("browser_workflows") &&
    moduleReadme.includes("browser_workflow_save") &&
    moduleReadme.includes("browser_workflow_replay"),
  "Browser README documents workflow MCP wrappers",
);
assert(testSuiteManifestSource.includes('["tsx","scripts/test-shellx-browser.ts"]'), "pnpm test includes shellx browser checks");
const releaseVersion = packageData.version;
assert(/^\d+\.\d+\.\d+$/.test(releaseVersion), "package version is release semver");
assert(cargoToml.includes(`version = "${releaseVersion}"`), "Cargo version matches package version");
assert(tauriConf.version === releaseVersion, "Tauri version matches package version");
assert(changelog.includes(`## [${releaseVersion}]`), "changelog has current release section");
assert(changelog.includes("shared Vault broker") && changelog.includes("bright/light mode"), "changelog documents current 0.3.3 public surfaces");
assert(Boolean(packageData.scripts?.["test:shellx-browser-debug-api"]), "package exposes live Browser debug API smoke");
assert(Boolean(packageData.scripts?.["test:shellx-browser-ui-debug"]), "package exposes rendered Browser UI debug smoke");
assert(Boolean(packageData.scripts?.["test:shellx-browser-everyday-apps"]), "package exposes everyday-app Browser smoke");
assert(Boolean(packageData.scripts?.["test:shellx-browser-concurrency"]), "package exposes three-agent Browser concurrency smoke");
assert(
    uiDebugSmokeSource.includes("shellx-browser-bookmark-manager-dock") &&
    uiDebugSmokeSource.includes("shellx-browser-bookmark-list") &&
    uiDebugSmokeSource.includes("shellx-browser-bookmark-list-mode") &&
    uiDebugSmokeSource.includes("03-options-sidecar-collapsed-sidebar") &&
    uiDebugSmokeSource.includes("04-save-collapsed-sidebar") &&
    uiDebugSmokeSource.includes("05-history-sidecar") &&
    uiDebugSmokeSource.includes("06-bookmark-sidecar-collapsed-sidebar") &&
    uiDebugSmokeSource.includes("07-bookmark-manager-sidecar") &&
    uiDebugSmokeSource.includes("Browser settings sidecar stays open when interacting inside the panel") &&
    uiDebugSmokeSource.includes("Browser history sidecar supports search and date filters") &&
    uiDebugSmokeSource.includes("blur: true") &&
    uiDebugSmokeSource.includes("Browser bookmark manager can edit an existing link URL") &&
    uiDebugSmokeSource.includes("Browser bookmark pointer drag can sort rows") &&
    uiDebugSmokeSource.includes("Browser toolbar folder click shows included bookmarks") &&
    uiDebugSmokeSource.includes("browser-right-initial-show") &&
    uiDebugSmokeSource.includes("Native Browser engine sits to the right of collapsed-sidebar Browser settings sidecar") &&
    uiDebugSmokeSource.includes("Native Browser engine stays fixed while collapsed-sidebar save menu overlays") &&
    uiDebugSmokeSource.includes("Collapsed-sidebar Browser save menu overlays the page instead of pushing it down") &&
    uiDebugSmokeSource.includes("Native Browser engine sits to the right of the collapsed-sidebar bookmark sidecar") &&
    uiDebugSmokeSource.includes("Browser normal personal tabs hide the redundant ownership banner"),
  "rendered UI smoke covers docked Browser menus and bookmark manager/toolbar interactions",
);
assert(
  uiDebugSmokeSource.includes("browser-agent-bottom-controls") &&
    uiDebugSmokeSource.includes("[data-debug-id='shellx-browser-agent-takeover']") &&
    uiDebugSmokeSource.includes("[data-debug-id='shellx-browser-agent-abort']") &&
    uiDebugSmokeSource.includes("result.clipped !== true"),
  "rendered UI smoke verifies Browser Agent Abort/Takeover controls are not clipped",
);
assert(
  uiDebugSmokeSource.includes("Browser Actions receipt text keeps readable dimensions") &&
    uiDebugSmokeSource.includes("Browser Personal Lock settings stay operator-only over the debug UI relay") &&
    uiDebugSmokeSource.includes("Browser Personal Lock timeout rejects debug relay input") &&
    uiDebugSmokeSource.includes("postUiForbidden"),
  "rendered UI smoke verifies Actions text readability and Personal Lock debug-relay gating",
);
assert(liveSmokeSource.includes("/browser/session-grants/request"), "live smoke covers browser session grants");
assert(liveSmokeSource.includes("browser_session_grant_resolution_requires_operator"), "live smoke verifies Browser session grant resolution mutation gate");
assert(liveSmokeSource.includes("/browser/vault-deposits"), "live smoke covers write-only Vault deposits");
assert(liveSmokeSource.includes("/browser/logs"), "live smoke covers Browser console logs");
assert(liveSmokeSource.includes("bookmarkCurrent"), "live smoke covers Browser bookmark-current behavior");
assert(liveSmokeSource.includes("clearHistory"), "live smoke covers blocked Browser history clearing");
assert(liveSmokeSource.includes("/browser/tabs/open"), "live smoke covers Browser tab open route");
assert(liveSmokeSource.includes("/browser/tabs/reorder"), "live smoke covers Browser tab reorder route");
assert(liveSmokeSource.includes("/browser/tabs/close"), "live smoke covers Browser tab close route");
assert(liveSmokeSource.includes("active tab close restores native Browser engine"), "live smoke covers active-tab close engine restoration");
assert(debugApi.includes("sync_browser_active_tab_to_engine"), "debug API close-tab route syncs the native engine to the surviving active tab");
assert(
  (debugApi.includes("close_browser_engine_webview") || debugApiBrowserStateSource.includes("close_browser_engine_webview")) &&
    (debugApi.includes("engine_still_used") || debugApiBrowserStateSource.includes("engine_still_used")),
  "debug API close-tab route cleans up orphaned native Browser engine webviews",
);
assert(
  rustBrowser.includes("tab_observations: BTreeMap<String, BrowserObservation>") &&
    browserActionResultsSource.includes("state.tab_observations.insert") &&
    browserActionsSource.includes("request.browser_tab_id.clone()") &&
    browserTabsSource.includes("state.tab_observations.remove(&tab.browser_tab_id)"),
  "taskless user-tab observe caches selectors so refId Browser actions work without an active agent task",
);
assert(liveSmokeSource.includes("/browser/tabs/lock"), "live smoke covers Browser tab lock route");
assert(liveSmokeSource.includes("tabLocked"), "live smoke covers Browser tab lock denial");
assert(liveSmokeSource.includes("/browser/task/control"), "live smoke covers Browser task agent lifecycle control route");
assert(liveSmokeSource.includes('takeover.status === "userTakeover"'), "live smoke verifies headerless Debug API operator takeover authority");
assert(liveSmokeSource.includes("shellxBrowserOperator"), "live smoke verifies operator receipt provenance for headerless Debug API task controls");
assert(liveSmokeSource.includes("browserTaskActionBlocked"), "live smoke covers Browser task action blocking after operator control");
assert(liveSmokeSource.includes("action: \"scroll\""), "live smoke covers Browser scroll action");
assert(liveSmokeSource.includes("/browser/privacy"), "live smoke covers Browser privacy route");
assert(liveSmokeSource.includes("browser_privacy_requires_operator"), "live smoke verifies Browser privacy mutation gate");
assert(liveSmokeSource.includes("/browser/shields"), "live smoke covers Browser Shields route");
assert(liveSmokeSource.includes("browser_shields_requires_operator"), "live smoke verifies Browser Shields mutation gate");
assert(liveSmokeSource.includes("/browser/developer-mode"), "live smoke covers Browser Developer Mode route");
assert(liveSmokeSource.includes("/browser/developer-mode/approval"), "live smoke covers Browser Developer Mode approval route");
assert(liveSmokeSource.includes("/browser/cdp/execute"), "live smoke covers gated Browser CDP executor route");
assert(liveSmokeSource.includes("/browser/har/export"), "live smoke covers Browser HAR export route");
assert(liveSmokeSource.includes("/browser/performance/export"), "live smoke covers Browser performance export route");
assert(liveSmokeSource.includes("/browser/recipes/export"), "live smoke covers Browser recipe export route");
assert(liveSmokeSource.includes("/browser/recipes/replay"), "live smoke covers Browser recipe replay route");
assert(debugApiBrowserArtifactsSource.includes("browser_recipe_replay_plan") && debugApiBrowserArtifactsSource.includes("try_apply_engine_action") && debugApiBrowserArtifactsSource.includes("skipped_steps") && rustBrowserRecipes.includes("stepsSkipped"), "Browser recipe replay route applies planned route steps and reports skipped steps");
assert(debugApiBrowserArtifactsSource.includes("browser_recipe_replay_response_step_result") && rustBrowserRecipes.includes("stepResults"), "Browser recipe replay returns compact per-step execution summaries");
assert(debugApiBrowserArtifactsSource.includes("begin_robot_run") && debugApiBrowserArtifactsSource.includes("execute_browser_recipe_replay") && debugApiBrowserArtifactsSource.includes("finish_robot_run"), "Browser robot run executes recipe replay before recording its terminal status");
assert(liveSmokeSource.includes("recipeReplay.decisionPoints"), "live smoke checks Browser recipe replay decision points");
assert(liveSmokeSource.includes("recipe replay rejects a changed saved artifact"), "live smoke proves changed saved Browser recipes fail closed");
assert(liveSmokeSource.includes("/browser/robots/schedule"), "live smoke covers Browser robot schedule route");
assert(liveSmokeSource.includes("/browser/robots/run"), "live smoke covers Browser robot run route");
assert(liveSmokeSource.includes("/browser/downloads/request"), "live smoke covers Browser download intent route");
assert(liveSmokeSource.includes("/browser/uploads/request"), "live smoke covers Browser upload intent route");
assert(liveSmokeSource.includes("/browser/downloads/complete"), "live smoke covers Browser download completion route");
assert(liveSmokeSource.includes("/browser/uploads/complete"), "live smoke covers Browser upload completion route");
assert(liveSmokeSource.includes("requiresEngine"), "live smoke checks engine-required action reporting");
assert(liveSmokeSource.includes("waitForBrowserEngine"), "live smoke waits for the native Browser engine");
assert(liveSmokeSource.includes("Example Domain"), "live smoke expects real page extraction from example.com");
assert(fixtureServerSource.includes("/everyday-apps"), "fixture server exposes everyday app workflow route");
assert(everydayFixtureSource.includes("data-app-shell=\"mail\""), "everyday fixture includes mail workflow");
assert(everydayFixtureSource.includes("data-app-shell=\"docs\""), "everyday fixture includes docs workflow");
assert(everydayFixtureSource.includes("data-app-shell=\"calendar\""), "everyday fixture includes calendar workflow");
assert(everydayFixtureSource.includes("data-app-shell=\"checkout\""), "everyday fixture includes checkout workflow");
assert(everydayFixtureSource.includes("data-app-shell=\"profile-card\""), "everyday fixture includes profile-card autofill workflow");
assert(everydayFixtureSource.includes("data-app-shell=\"email-code\""), "everyday fixture includes email-code validation workflow");
assert(everydayFixtureSource.includes("data-app-shell=\"agent-wallet\""), "everyday fixture includes agent-wallet checkout workflow");
assert(everydayFixtureSource.includes("beforeunload"), "everyday fixture can trigger beforeunload blockers");
assert(everydayFixtureSource.includes("Notification.requestPermission"), "everyday fixture can request notification permission");
assert(everydayAppsSmokeSource.includes("/everyday-apps"), "everyday app smoke navigates to the workflow fixture");
assert(everydayAppsSmokeSource.includes("action: \"findText\""), "everyday app smoke uses in-page search");
assert(everydayAppsSmokeSource.includes("action: \"verify\""), "everyday app smoke verifies workflow outcomes");
assert(concurrencySmokeSource.includes("ShellX Browser three-agent concurrency smoke"), "concurrency smoke has a clear release-gate title");
assert(concurrencySmokeSource.includes("agent-alpha") && concurrencySmokeSource.includes("agent-beta") && concurrencySmokeSource.includes("agent-gamma"), "concurrency smoke runs three distinct agent owners");
assert(concurrencySmokeSource.includes("/browser/tabs/lock"), "concurrency smoke locks tabs per agent owner");
assert(concurrencySmokeSource.includes("/browser/tabs/heartbeat"), "concurrency smoke refreshes tab lock leases");
assert(concurrencySmokeSource.includes("tabLocked"), "concurrency smoke verifies wrong-owner lock denial");
assert(concurrencySmokeSource.includes("browserTabLockDenied"), "concurrency smoke verifies lock-denial receipts");
assert(concurrencySmokeSource.includes("assertNoCrossTaskReceipts"), "concurrency smoke checks receipt/task isolation");
assert(concurrencySmokeSource.includes("waitForRunEngineReady") && concurrencySmokeSource.includes("pendingUrl"), "concurrency smoke waits for task engine navigation before owner observe");
assert(concurrencySmokeSource.includes("still pending"), "concurrency smoke retries explicit pending-navigation observe races");
assert(everydayAppsSmokeSource.includes("/browser/dialogs"), "everyday app smoke exercises beforeunload/dialog event routes");
assert(everydayAppsSmokeSource.includes("blockedBeforeUnload"), "everyday app smoke verifies beforeunload-gated navigation");
assert(everydayAppsSmokeSource.includes("/browser/permissions"), "everyday app smoke exercises permission event routes");
assert(everydayAppsSmokeSource.includes("data-testid=mail-search"), "everyday app smoke drives mail search controls");
assert(everydayAppsSmokeSource.includes("data-testid=doc-editor"), "everyday app smoke drives rich document editing");
assert(everydayAppsSmokeSource.includes("data-testid=checkout-submit"), "everyday app smoke drives form submit controls");
assert(everydayAppsSmokeSource.includes("fillProfileCardGrant"), "everyday app smoke covers profile-card fill mediation");
assert(everydayAppsSmokeSource.includes("readEmailCodeGrant"), "everyday app smoke covers email-code mediation");
assert(everydayAppsSmokeSource.includes("useAgentWalletGrant"), "everyday app smoke covers agent-wallet mediation");
assert(Boolean(packageData.scripts?.["test:shellx-vault-adversary"]), "package exposes Vault Browser adversary smoke");
assert(adversarySmokeSource.includes("ShellX Vault Browser adversary smoke"), "adversary smoke has a clear release-gate title");
assert(adversarySmokeSource.includes("assertNoSentinel"), "adversary smoke scans Debug API responses for raw sentinel leaks");
assert(adversarySmokeSource.includes("valueHash"), "adversary smoke classifies page captures by hashed values");
assert(adversarySmokeSource.includes("debug-api-fetch"), "adversary smoke checks hostile page Debug API probes");
assert(adversarySmokeSource.includes("/browser/trace/export"), "adversary smoke exports and scans Browser traces");
assert(
  browserTestCleanupSource.includes("cleanupOwnedBrowserLifecycle") &&
    browserTestCleanupSource.includes("/browser/task/finish") &&
    browserTestCleanupSource.includes("/browser/tabs/unlock") &&
    browserTestCleanupSource.includes("/browser/tabs/close"),
  "Browser live gates share an owned task/tab lifecycle finalizer",
);
for (const [label, source] of [
  ["Debug API", liveSmokeSource],
  ["everyday apps", everydayAppsSmokeSource],
  ["workflow matrix", workflowMatrixSmokeSource],
  ["batch timing", batchTimingSmokeSource],
  ["concurrency", concurrencySmokeSource],
  ["Vault adversary", adversarySmokeSource],
] as const) {
  assert(source.includes("cleanupOwnedBrowserLifecycle"), `${label} smoke finalizes only owned Browser tasks and tabs`);
}
assert(
  browserCleanupTestSource.includes("preserves an unrelated operator tab") &&
    browserCleanupTestSource.includes("partial cleanup idempotent") &&
    testSuiteManifestSource.includes('["tsx","scripts/test-shellx-browser-cleanup.ts"]'),
  "Browser cleanup ownership and partial-failure behavior are covered in pnpm test",
);
assert(debugApi.includes("publish_shellxagent_descriptor"), "Debug API publishes shellxagent.json discovery descriptor");
assert(debugApi.includes('"/shellxagent.json"') && debugApi.includes('"/.well-known/shellxagent.json"'), "Debug API serves shellxagent.json discovery descriptor from installed app");
assert(debugApi.includes('"/agent-doc/manifest"') && debugApi.includes('"/agent-doc/skills/shellx-host/SKILL.md"'), "Debug API serves bundled agent docs from installed app");
assert(debugApi.includes("\"browserAction\"") && debugApi.includes("/browser/action"), "shellxagent.json advertises the gated Browser action route");
assert(debugApi.includes("\"rawCdpExposed\"") && debugApi.includes("false"), "shellxagent.json declares raw CDP unavailable");
assert(debugApi.includes("rawCdpEndpoint") && debugApi.includes("serde_json::Value::Null"), "Debug API tests protect against raw CDP descriptor exposure");
assert(rustBuildScript.includes("SHELLX_BUILD_COMMIT") && rustBuildScript.includes('git_stdout(&["rev-parse", "HEAD"])'), "build script embeds the exact source commit with an explicit override");
assert(rustBuildMetadata.includes('BROWSER_PROTOCOL_VERSION: &str = "1.5.0"') && rustBuildMetadata.includes("BROWSER_SCHEMA_REVISION") && rustBuildMetadata.includes("browserCoworkSession"), "Browser protocol, schema, and cowork identity are centralized");
assert(debugApi.includes("browserProtocolVersion") && debugApi.includes("browserSchemaRevision") && debugApi.includes("browserFeatureFlags"), "Debug API health and discovery expose Browser protocol identity");
assert(hostMcp.includes("browserProtocolVersion") && hostMcp.includes("browserSchemaRevision") && hostMcp.includes("buildCommit"), "Host MCP initialize exposes matching Browser and build identity");
assert(debugApi.includes("write_private_text_file") && debugApi.includes("atomic_write_private_file"), "shellxagent.json delegates to the atomic private-file writer");
assert(apiDocs.includes("shellxagent.json") && apiDocs.includes("rawCdpExposed: false"), "API docs describe shellxagent.json without raw CDP");
assert(apiDocs.includes("~/.shellx/agent-docs/shellx-host/SKILL.md") && apiDocs.includes("direct CLI sessions stay unchanged"), "API docs describe session-scoped host activation and product-owned docs");
assert(skillInstallSource.includes('legacy_global_shellx_host_skill_targets_for_home') && skillInstallSource.includes('join("agent-docs")') && skillInstallSource.includes("SHELLX_SESSION_RULES"), "Installer runtime migrates global host skills and keeps the manifest in ShellX-owned docs");
assert(packageData.scripts?.["shellx-browser"] === "tsx scripts/shellx-browser-cli.ts", "package exposes ShellX Browser CLI wrapper");
assert(browserCliSource.includes("readDebugApiConnection"), "Browser CLI reads Debug API port/token from local ShellX files");
assert(debugPathHelperSource.includes("shellxagent.token") && debugPathHelperSource.includes("debug.token"), "Browser CLI uses the installed-app Debug API token");
assert(
  debugPathHelperSource.includes("resolveShellxDebugApiConnection") &&
    debugPathHelperSource.includes("debugApiConnectionCandidates") &&
    debugPathHelperSource.includes("/browser/state") &&
    browserCliSource.includes("resolveShellxDebugApiConnection") &&
    workflowMatrixSmokeSource.includes("resolveShellxDebugApiConnection") &&
    liveSmokeSource.includes("resolveShellxDebugApiConnection") &&
    everydayAppsSmokeSource.includes("resolveShellxDebugApiConnection") &&
    adversarySmokeSource.includes("resolveShellxDebugApiConnection") &&
    concurrencySmokeSource.includes("resolveShellxDebugApiConnection"),
  "Browser live gates pair and probe Debug API port/token candidates",
);
assert(browserCliSource.includes("/browser/action") && browserCliSource.includes("/browser/check") && browserCliSource.includes("/browser/settle?${query}"), "Browser CLI wraps action, quiet-check, and compact-settle routes");
assert(browserCliSource.includes("/browser/tabs"), "Browser CLI wraps Browser tabs route");
assert(browserCliSource.includes("\"navigate\""), "Browser CLI exposes native Browser navigation");
assert(browserCliSource.includes("fill-from-vault"), "Browser CLI exposes Vault-mediated credential fill");
assert(browserCliSource.includes("lockLeaseId"), "Browser CLI can pass tab lock leases to Browser actions");
assert(browserCliSource.includes("/browser/trace/export"), "Browser CLI wraps Browser trace export route");
assert(
  browserCliSource.includes("SHELLX_HOST_MCP_TAB_ID")
    && browserCliSource.includes('"x-shellx-mcp-caller-id"'),
  "Browser CLI carries ShellX-owned caller identity into agent-scoped evidence routes",
);
for (const tool of [
  "browser_state", "browser_check", "browser_read", "browser_act",
  "browser_tabs",
  "browser_locks",
  "browser_navigate",
  "browser_observe",
  "browser_click_ref",
  "browser_fill_ref",
  "browser_fill_from_vault",
  "browser_fill_profile_card",
  "browser_capture_secret_to_vault",
  "browser_read_email_code",
  "browser_use_agent_wallet",
  "browser_wait_for",
  "browser_extract",
  "browser_save_page",
  "browser_verify",
  "browser_screenshot",
  "browser_downloads",
  "browser_resolve_dialog",
  "browser_trace_open", "browser_evidence", "browser_flight_recorder_export", "browser_evaluation_write",
]) {
  assert(hostMcp.includes(`"name": "${tool}"`), `Host MCP exposes ${tool}`);
}
assert(hostMcp.includes("tool_browser_action") && hostMcp.includes("advertised_tool_specs") && hostMcp.includes("browser_entry_tool_specs()") && hostMcp.includes("specs.extend(browser_tool_specs())") && hostMcp.includes("DEFAULT_OBSERVE_STRUCTURED_BYTES") && hostMcp.includes("mcpSerializedBytes") && hostMcp.includes("mcpApproxTokens") && apiDocs.includes("32-tool, 82,893-byte") && apiDocs.includes("two-tool, 2,601-byte") && apiDocs.includes("3,000-byte") && moduleReadme.includes("32 compatibility schemas (82,893 bytes)") && !moduleReadme.includes("29 compatibility schemas"), "Host MCP Browser actions use one wrapper, advertise the compact gateway, retain all 32 searchable aliases, and enforce the measured observation budget");
assert(hostMcp.includes("/browser/action"), "Host MCP Browser action tools call the Browser Debug API action route");
assert(hostMcp.includes("browser_action_body"), "Host MCP maps MCP Browser tool arguments to the Debug API body");
assert(hostMcp.includes("browserTabId must also pass the owning taskId"), "Host MCP Browser tools reject raw taskless browserTabId targeting");
assert(hostMcp.includes("fullPage"), "Host MCP Browser tools can request full-page screenshots");
assert(
  rustBrowserModel.includes("pub force: bool") &&
    browserActionsSource.includes("force: request.force") &&
    browserScriptsSource.includes("force click applied") &&
    hostMcp.includes('"force": { "type": "boolean"') &&
    hostMcp.includes('body.insert("force"'),
  "Browser click actions support explicit force mode for overlay-blocked refs",
);
assert(hostMcp.includes("native ShellX Browser"), "Host MCP Browser tools tell agents the native Browser exists");
assert(hostMcp.includes("browser_navigate"), "Host MCP exposes native Browser navigation");
assert(hostMcp.includes("browser_fill_profile_card"), "Host MCP teaches profile-card Browser fill");
assert(hostMcp.includes("browser_read_email_code"), "Host MCP teaches email-code Browser flow");
assert(hostMcp.includes("browser_use_agent_wallet"), "Host MCP teaches agent-wallet Browser flow");
assert(hostMcp.includes("browser_save_page") && hostMcp.includes("finalPath"), "Host MCP teaches Browser page-save final paths");
assert(hostMcp.includes('"browser_downloads"'), "Host MCP exposes Browser download path discovery");
assert(hostMcp.includes('"browser_resolve_dialog"'), "Host MCP exposes task-owned beforeunload dialog resolution");
assert(hostMcp.includes("personal/delegated user tabs and page permissions still require the ShellX operator UI"), "Host MCP scopes Browser dialog resolution away from user-owned prompts");
assert(hostMcp.includes('"browser_screenshot"'), "Host MCP capability summary includes Browser screenshots");
assert(hostMcp.includes("Do not dump raw `/browser/state` or observation JSON into the current working directory or user folders"), "Host MCP warns agents not to dump raw Browser state/observe JSON into cwd/user folders");
assert(hostMcp.includes('debug_api_get_json_for_caller("/browser/summary", 10, caller_session_id)') && hostMcp.includes('args.get("include")') && hostMcp.includes('debug_api_get_json_for_caller(&path, timeout_secs, caller_session_id)') && hostMcp.includes('"browser_check"'), "Host MCP exposes caller-scoped bounded browser_state and UI-silent browser_check paths");
assert(hostMcp.includes("browser_mcp_settle_path") && !hostMcp.includes("Duration::from_millis(75)"), "Host MCP navigation uses the compact settle endpoint instead of 75 ms full-state polling");
assert(shellxHostSkill.includes("prior observations") && shellxHostSkill.includes("opt-in slices"), "ShellX host skill teaches bounded Browser state orientation");
assert(hostMcp.includes("Do not write raw observation dumps to the current working directory or user folders"), "Browser observe tool description points agents to trace artifacts instead of raw dumps");
assert(hostMcp.includes("Do not copy the trace or raw Browser state into the current working directory or user folders"), "Browser trace tool description keeps diagnostics in ShellX trace storage by default");
assert(pluginsModalSource.includes("Native Browser") && pluginsModalSource.includes("Vault Request Center"), "Plugins modal shellx-host row must mention Browser and Vault Request Center");
assert(!pluginsModalSource.includes("Workflow skills"), "Plugins modal must not advertise retired workflow skills");
assert(hostMcp.includes("Agent tool description must teach subagent Browser flow"), "Host MCP tests protect Agent Browser guidance");
assert(hostMcp.includes("browser_workflows") && hostMcp.includes("browser_workflow_save") && hostMcp.includes("browser_workflow_replay"), "Host MCP exposes Agent workflow bookmark discovery, save, and replay");
assert(hostMcp.includes("browser_extract_action_from_format") && hostMcp.includes("\"table\"") && apiDocs.includes("text/markdown/table") && shellxHostSkill.includes("format: table"), "Host MCP browser_extract exposes table extraction in source, docs, and bundled host skill");
assert(hostMcp.includes("browser_run_steps"), "Host MCP exposes generic Browser batch control");
assert(hostMcp.includes("tool_browser_run_steps"), "Host MCP implements Browser batch control as a focused wrapper");
assert(hostMcp.includes("is_write_class_tool(\"browser_run_steps\")"), "Browser batch control is write-class gated");
assert(hostMcp.includes("browser_run_steps_allowed_action") && hostMcp.includes("fillFromVaultGrant") && hostMcp.includes("unsupported sensitive Browser action"), "Browser batch control rejects unsupported or sensitive Browser actions");
assert(hostMcp.includes("findText") && hostMcp.includes("extractTable") && apiDocs.includes("safe in-page `findText`") && shellxHostSkill.includes("findText -> extractTable"), "Browser batch control includes safe in-page search/table extraction in source, docs, and bundled host skill");
assert(hostMcp.includes("\"scroll\" => Ok(\"scroll\")") && hostMcp.includes("\"goBack\" | \"back\"") && apiDocs.includes("ordinary `scroll`, `select`, `goBack`, `goForward`") && shellxHostSkill.includes("scroll -> select -> findText"), "Browser batch control includes generic scroll/select/history actions in source, docs, and bundled host skill");
assert(hostMcp.includes("browser_run_steps_normalize_step_aliases") && hostMcp.includes("Convenience alias for findText") && apiDocs.includes("`findText` may use `query`") && shellxHostSkill.includes("batch steps may use `query`"), "Browser batch control maps findText query aliases in source, docs, and bundled host skill");
assert(hostMcp.includes("browser_mcp_wait_for_navigation_settle") && hostMcp.includes("Browser navigation did not settle") && hostMcp.includes("goBack") && shellxHostSkill.includes("Navigate/history/"), "Host MCP Browser navigation/history/reload waits for page settle before follow-up actions");
assert(hostMcp.includes("browser_mcp_force_click_recovery_body") && hostMcp.includes("browser_mcp_locator_candidate_recovery_body") && hostMcp.includes("mcpRecovery") && hostMcp.includes("receivesEvents") && hostMcp.includes("strictLocator"), "Host MCP Browser auto-recovery is limited to strict locator and receivesEvents force-click retries with evidence");
assert(hostMcp.includes("browser_run_steps_result_entry") && hostMcp.includes("\"mcpRecovery\".to_string()"), "Host MCP Browser batch step rows carry structured recovery evidence");
assert(hostMcp.includes("browser_run_steps_aggregate") && hostMcp.includes("continuedAfterFailure") && hostMcp.includes("failureSummary"), "Host MCP Browser batch aggregates continued failures truthfully");
assert(browserCliSource.includes("runStepsAggregate") && browserCliSource.includes("stepsSucceeded") && browserCliSource.includes("process.exitCode = 1"), "Browser CLI reports failed batches and exits nonzero");
assert(shellxHostSkill.includes("step row includes structured") && shellxHostSkill.includes("mcpRecovery"), "ShellX host skill teaches batch recovery evidence");
assert(Boolean(packageData.scripts?.["test:shellx-browser-batch-timing"]), "package exposes live Browser batch timing smoke");
assert(
  batchTimingSmokeSource.includes("debugApiConnectionCandidates") &&
    !batchTimingSmokeSource.includes("SHELLX_DEBUG_BASE requires SHELLX_DEBUG_SECRET"),
  "Browser batch timing uses the shared paired Debug API candidate resolver",
);
assert(
  batchTimingSmokeSource.includes("/mcp") &&
    batchTimingSmokeSource.includes("browser_run_steps") &&
    batchTimingSmokeSource.includes("browser_navigate") &&
    batchTimingSmokeSource.includes("SHELLX_BATCH_TIMING_ITERATIONS") &&
    batchTimingSmokeSource.includes("median"),
  "Browser batch timing smoke compares Host MCP sequential calls against browser_run_steps",
);
assert(
  batchTimingSmokeSource.includes("runStrictLocatorRecoverySmoke") &&
    batchTimingSmokeSource.includes("strictLocator"),
  "Browser batch timing smoke covers live strict locator recovery through MCP",
);
assert(
  batchTimingSmokeSource.includes("runExpandedGenericBatchSmoke") &&
    batchTimingSmokeSource.includes("action: \"select\"") &&
    batchTimingSmokeSource.includes("action: \"extractTable\"") &&
    batchTimingSmokeSource.includes("action: \"goForward\"") &&
    batchTimingSmokeSource.includes("browser_run_steps expanded generic batch"),
  "Browser batch timing smoke covers expanded generic browser_run_steps actions",
);
assert(
  batchTimingSmokeSource.includes("runContinuedFailureContractSmoke") &&
    batchTimingSmokeSource.includes("allowToolError") &&
    batchTimingSmokeSource.includes("continuedAfterFailure"),
  "Browser batch timing smoke covers continued-failure aggregate semantics through MCP",
);
assert(
  apiDocs.includes("test:shellx-browser-batch-timing") &&
    apiDocs.includes("browser_run_steps timing"),
  "API docs keep the Browser batch timing checklist visible",
);
assert(hostMcp.includes("exported no replayable steps"), "Host MCP workflow save rejects empty recipes");
assert(hostMcp.includes("browser_workflow_summaries_filter_by_taxonomy_and_aliases"), "Host MCP tests workflow bookmark taxonomy filtering");
assert(hostMcp.includes("browser_workflow_apply_blocks_contract_drift"), "Host MCP blocks stale contract workflow apply");
assert(hostMcp.includes("browser_workflow_apply_contract_guard_blocks_scope_mismatches") && hostMcp.includes("expectedDomains") && hostMcp.includes("allowedPermissions"), "Host MCP workflow replay has deterministic apply contract scope checks");
assert(hostMcp.includes("stepResults") && hostMcp.includes("decisionPoints"), "Host MCP workflow replay tells agents to inspect compact replay step results and decision points");
assert(hostMcp.includes("workflowMetadataUpdated") && hostMcp.includes("health/drift metadata"), "Host MCP workflow replay records bookmark health and drift after apply");
assert(subagentSource.includes("native ShellX Browser"), "subagent runtime guard tells spawned agents the native Browser exists");
assert(subagentSource.includes("browser_act action=navigate"), "subagent runtime guard teaches Browser navigation");
assert(subagentSource.includes("browser_read action=observe"), "subagent runtime guard teaches Browser observation");
assert(subagentSource.includes("Browser and Vault approval gates still apply"), "subagent runtime guard preserves Browser mutation gates");
assert(subagentSource.includes("Do not write raw Browser state or observation JSON into the current working directory or user folders"), "subagent runtime guard prevents raw Browser JSON dumps in cwd/user folders");
assert(shellxHostSkill.includes("Native ShellX Browser for agent web work"), "ShellX host skill documents native Browser existence");
assert(shellxHostSkill.includes('browser_act { action: "navigate"'), "ShellX host skill teaches Browser navigation tool flow");
assert(shellxHostSkill.includes("browser_act action=runSteps") && shellxHostSkill.includes("generic Browser action steps"), "ShellX host skill teaches generic Browser batch control without site hardcoding");
assert(shellxHostSkill.includes("browser_act action=resolveDialog"), "ShellX host skill teaches task-owned beforeunload resolution");
assert(shellxHostSkill.includes("3,000-byte serialized") && shellxHostSkill.includes("mcpApproxTokens"), "ShellX host skill teaches compact Browser observe defaults");
assert(shellxHostSkill.includes("response message or receipt"), "ShellX host skill teaches direct beforeunload dialogId recovery");
assert(shellxHostSkill.includes("Do not write raw Browser state or observation JSON dumps into"), "ShellX host skill prevents raw Browser JSON dumps in cwd/user folders");
assert(shellxHostSkill.includes("action=captureSecretToVault"), "ShellX host skill teaches direct page-secret Vault capture");
assert(shellxHostSkill.includes("action=readEmailCode"), "ShellX host skill teaches email-code grants");
assert(shellxHostSkill.includes("action=useAgentWallet"), "ShellX host skill teaches agent-wallet grants");
assert(shellxHostSkill.includes("action=workflows") && shellxHostSkill.includes("action=workflowSave") && shellxHostSkill.includes("action=workflowReplay"), "ShellX host skill teaches reusable Browser workflow save/replay");
assert(
  shellxHostSkill.includes("/agent-doc/manifest") &&
    shellxHostSkill.includes("/agent-doc/skills/shellx-host/SKILL.md") &&
    shellxHostSkill.includes("/browser/recipes/replay"),
  "ShellX host skill documents bundled agent-doc routes and Browser recipe replay",
);
assert(
  shellxHostSkill.includes("pnpm shellx-browser run-steps") &&
    shellxHostSkill.includes("agent-work") &&
    shellxHostSkill.includes("--use-active-tab") &&
    shellxHostSkill.includes("workflow-replay") &&
    shellxHostSkill.includes("compact `summary`"),
  "ShellX host skill teaches installed CLI fallback for Browser batches and workflow replay",
);
for (const command of [
  "check", "snapshot",
  "navigate",
  "observe",
  "click-ref",
  "fill-ref",
  "wait-for",
  "extract",
  "verify",
  "screenshot",
  "dialogs",
  "resolve-dialog",
  "tabs",
  "locks",
  "trace-open",
  "run-steps",
  "workflow-bookmarks",
  "workflow-save",
  "workflow-replay",
]) {
  assert(browserCliSource.includes(`"${command}"`), `Browser CLI exposes ${command}`);
}
assert(browserCliSource.includes("extractTable") && browserCliSource.includes("extract table"), "Browser CLI exposes table extraction");
assert(
  browserCliSource.includes("runSteps(") &&
    browserCliSource.includes("ensureRunStepsTask") &&
    browserCliSource.includes("/browser/task/start") && browserCliSource.includes("/browser/settle?${query}") && !browserCliSource.includes("setTimeout(resolve, 100)") &&
    browserCliSource.includes("agent-work") &&
    browserCliSource.includes("use-active-tab") &&
    browserCliSource.includes("steps-json") &&
    browserCliSource.includes("browser_run_steps style generic batch") &&
    moduleReadme.includes("pnpm shellx-browser run-steps") &&
    moduleReadme.includes("--use-active-tab") &&
    apiDocs.includes("pnpm shellx-browser run-steps"),
  "Browser CLI exposes generic Browser batch control",
);
assert(
  browserCliSource.includes("/browser/recipes/export") &&
    browserCliSource.includes("/browser/recipes/replay") &&
    browserCliSource.includes("agentWorkflow") &&
    browserCliSource.includes("exported no replayable steps") &&
    browserCliSource.includes("workflowReplaySummary") &&
    browserCliSource.includes("decisionPointCount") &&
    moduleReadme.includes("`workflow-replay` returns a compact `summary`") &&
    apiDocs.includes("`workflow-replay` returns a compact `summary`"),
  "Browser CLI exposes workflow bookmark save, discovery, replay, and compact replay summaries",
);
assert(
  browserCliSource.includes("workflowTaskType") &&
    browserCliSource.includes('return "register"') &&
    browserCliSource.includes('return "login"') &&
    !browserCliSource.includes('slug(taskType).split("-")[0]'),
  "Browser CLI canonicalizes multi-word workflow task types",
);
assert(
  browserCliSource.includes('case "click-at"') &&
    browserCliSource.includes('case "type-text"') &&
    browserCliSource.includes('case "clear-site-data"') &&
    moduleReadme.includes("pnpm shellx-browser click-at") &&
    apiDocs.includes("pnpm shellx-browser click-at") &&
    shellxHostSkill.includes("pnpm shellx-browser click-at"),
  "Browser CLI exposes direct coordinate and site-data recovery fallbacks",
);
