import { readFileSync } from "node:fs";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

function readMaybe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

console.log("\n=== shellx browser module ===");

const rustBrowser = readFileSync("src-tauri/src/shellx_browser.rs", "utf8");
const rustBrowserDestructiveActions = readFileSync("src-tauri/src/shellx_browser_destructive_actions.rs", "utf8");
const rustBrowserDeveloperMode = readFileSync("src-tauri/src/shellx_browser_developer_mode.rs", "utf8");
const rustBrowserPersonalLock = readMaybe("src-tauri/src/shellx_browser_personal_lock.rs");
const rustBrowserPersistence = readMaybe("src-tauri/src/shellx_browser_persistence.rs");
const rustBrowserModel = readMaybe("src-tauri/src/shellx_browser_model.rs");
const browserActionResultsSource = readMaybe("src-tauri/src/shellx_browser_action_results.rs");
const browserActionsSource = readMaybe("src-tauri/src/shellx_browser_actions.rs");
const browserBookmarksSource = readMaybe("src-tauri/src/shellx_browser_bookmarks.rs");
const browserCdpRuntimeSource = readMaybe("src-tauri/src/shellx_browser_cdp_runtime.rs");
const browserEngineSource = readMaybe("src-tauri/src/shellx_browser_engine.rs");
const browserEngineRuntimeSource = readMaybe("src-tauri/src/shellx_browser_engine_runtime.rs");
const browserEngineStateSource = readMaybe("src-tauri/src/shellx_browser_engine_state.rs");
const browserScriptsSource = readMaybe("src-tauri/src/shellx_browser_scripts.rs");
const browserSecuritySource = readMaybe("src-tauri/src/shellx_browser_security.rs");
const browserTabsSource = readMaybe("src-tauri/src/shellx_browser_tabs.rs");
const browserProtectedValuesSource = readMaybe("src-tauri/src/shellx_browser_protected_values.rs");
const browserProfilesSource = readMaybe("src-tauri/src/shellx_browser_profiles.rs");
const browserTasksSource = readMaybe("src-tauri/src/shellx_browser_tasks.rs");
const rustBrowserPrivacy = readFileSync("src-tauri/src/shellx_browser_privacy.rs", "utf8");
const rustBrowserPrompts = readFileSync("src-tauri/src/shellx_browser_prompts.rs", "utf8");
const rustBrowserSessionGrants = readFileSync("src-tauri/src/shellx_browser_session_grants.rs", "utf8");
const rustBrowserShields = readFileSync("src-tauri/src/shellx_browser_shields.rs", "utf8");
const rustBrowserRobots = readMaybe("src-tauri/src/shellx_browser_robots.rs");
const rustBrowserArtifacts = readMaybe("src-tauri/src/shellx_browser_artifacts.rs");
const rustBrowserStorageState = readMaybe("src-tauri/src/shellx_browser_storage_state.rs");
const rustBrowserState = readMaybe("src-tauri/src/shellx_browser_state.rs");
const rustBrowserRecipes = readMaybe("src-tauri/src/shellx_browser_recipes.rs");
const rustBrowserReports = readMaybe("src-tauri/src/shellx_browser_reports.rs");
const rustBrowserDiagnostics = readMaybe("src-tauri/src/shellx_browser_diagnostics.rs");
const rustBrowserTransfers = readFileSync("src-tauri/src/shellx_browser_transfers.rs", "utf8");
const rustBrowserVault = readMaybe("src-tauri/src/shellx_browser_vault.rs");
const rustBrowserIntegrationTests = readMaybe("src-tauri/tests/shellx_browser.rs");
const rustLib = readFileSync("src-tauri/src/lib.rs", "utf8");
const debugApi = readFileSync("src-tauri/src/debug_api.rs", "utf8");
const debugApiBrowser = readMaybe("src-tauri/src/debug_api_browser.rs");
const debugApiBrowserArtifactsSource = readMaybe("src-tauri/src/debug_api_browser_artifacts.rs");
const debugApiBrowserSecuritySource = readMaybe("src-tauri/src/debug_api_browser_security.rs");
const debugApiBrowserStateSource = readMaybe("src-tauri/src/debug_api_browser_state.rs");
const debugApiBrowserSettingsSource = readMaybe("src-tauri/src/debug_api_browser_settings.rs");
const debugApiBrowserRouteSources = [
  debugApi,
  debugApiBrowser,
  debugApiBrowserArtifactsSource,
  debugApiBrowserSecuritySource,
  debugApiBrowserStateSource,
  debugApiBrowserSettingsSource,
];
const hostMcp = readFileSync("src-tauri/src/host_mcp.rs", "utf8");
const pluginsModalSource = readFileSync("src/components/PluginsModal.tsx", "utf8");
const subagentSource = readFileSync("src-tauri/src/subagent.rs", "utf8");
const packageJson = readFileSync("package.json", "utf8");
const packageData = JSON.parse(packageJson) as { version: string; scripts?: Record<string, string> };
const cargoToml = readFileSync("src-tauri/Cargo.toml", "utf8");
const tauriConf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as { version: string };
const tauriConfSource = readFileSync("src-tauri/tauri.conf.json", "utf8");
const tauriCapabilitiesSource = readFileSync("src-tauri/capabilities/default.json", "utf8");
const mainSource = readFileSync("src/main.tsx", "utf8");
const appSource = readFileSync("src/App.tsx", "utf8");
const uiSource = (() => {
  try {
    return readFileSync("src/components/ShellxBrowserApp.tsx", "utf8");
  } catch {
    return "";
  }
})();
const browserTypesSource = readMaybe("src/browser/types.ts");
const browserDebugBridgeSource = readMaybe("src/browser/debugBridge.ts");
const browserTaskIntentSource = readMaybe("src/browser/taskIntent.ts");
const browserApiSource = readMaybe("src/browser/api.ts");
const browserShieldsPanelSource = readMaybe("src/browser/components/BrowserShieldsPanel.tsx");
const browserMenusSource = readMaybe("src/browser/components/BrowserMenus.tsx");
const browserHistorySidecarSource = readMaybe("src/browser/components/BrowserHistorySidecar.tsx");
const downloadSidecarSource = readMaybe("src/browser/components/DownloadSidecar.tsx");
const bookmarkSidecarSource = readMaybe("src/browser/components/BookmarkSidecar.tsx");
const browserChromeSource = readMaybe("src/browser/components/BrowserChrome.tsx");
const settingsSource = readMaybe("src/components/Settings.tsx");
const generalTabSource = readMaybe("src/components/settings/GeneralTab.tsx");
const nativeEngineSyncSource = readMaybe("src/browser/hooks/useNativeEngineSync.ts");
const browserStateHookSource = readMaybe("src/browser/hooks/useBrowserState.ts");
const engineViewportSource = readMaybe("src/browser/components/EngineViewport.tsx");
const agentSidebarSource = readMaybe("src/browser/components/AgentSidebar.tsx");
const vaultPromptCardsSource = readMaybe("src/browser/components/VaultPromptCards.tsx");
const uiSourceLower = uiSource.toLowerCase();
const cssSource = readFileSync("src/App.css", "utf8");
function cssBlock(selector: string): string {
  const start = cssSource.indexOf(`${selector} {`);
  if (start === -1) {
    return "";
  }
  const open = cssSource.indexOf("{", start);
  const close = cssSource.indexOf("}", open);
  return open === -1 || close === -1 ? "" : cssSource.slice(start, close + 1);
}
const browserAppCss = cssSource.match(/\.shellx-browser-app\s*\{[^}]+\}/)?.[0] ?? "";
const browserTopCss = cssBlock(".shellx-browser-top");
const browserTabChromeCss = cssBlock(".shellx-browser-tab-chrome");
const browserTabStripCss = cssBlock(".shellx-browser-tab-strip");
const browserHeaderMenuWrapCss = cssBlock(".shellx-browser-header-menu-wrap");
const browserHeaderPopoverCss = cssBlock(".shellx-browser-header-popover");
const browserBookmarkToolbarCss = cssBlock(".shellx-browser-bookmark-toolbar");
const browserBookmarkFolderMenuCss = cssBlock(".shellx-browser-bookmark-folder-menu");
const browserExpandedAgentComposeCss = cssBlock(".shellx-browser-agent-panel.chat-expanded .shellx-browser-agent-compose");
const apiDocs = readFileSync("docs/API.md", "utf8");
const moduleReadme = readFileSync("shellx-browser/README.md", "utf8");
const shellxHostSkill = readFileSync("skills/shellx-host/SKILL.md", "utf8");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const liveSmokeSource = readFileSync("scripts/test-shellx-browser-debug-api.ts", "utf8");
const fixtureServerSource = readFileSync("scripts/fixtures/vault-browser-site/server.mjs", "utf8");
const everydayFixtureSource = readMaybe("scripts/fixtures/vault-browser-site/public/everyday-apps.html");
const everydayAppsSmokeSource = readMaybe("scripts/test-shellx-browser-everyday-apps.ts");
const adversarySmokeSource = readMaybe("scripts/test-shellx-vault-adversary.ts");
const concurrencySmokeSource = readMaybe("scripts/test-shellx-browser-concurrency.ts");
const uiDebugSmokeSource = (() => {
  try {
    return readFileSync("scripts/test-shellx-browser-ui-debug.ts", "utf8");
  } catch {
    return "";
  }
})();
const browserCliSource = (() => {
  try {
    return readFileSync("scripts/shellx-browser-cli.ts", "utf8");
  } catch {
    return "";
  }
})();

assert(rustBrowser.includes("ShellxBrowserRegistry"), "Rust browser registry exists");
assert(rustLib.includes("shellx_browser_model"), "browser model module is registered");
assert(rustBrowser.includes("pub use crate::shellx_browser_model"), "browser facade re-exports model types");
assert(rustBrowserModel.includes("pub enum BrowserAdMode"), "browser model owns Browser ad mode types");
assert(rustBrowserModel.includes("pub struct BrowserPrivacySettings"), "browser model owns Browser privacy settings");
assert(rustBrowserModel.includes("pub struct BrowserShieldSettings"), "browser model owns Browser Shields settings");
assert(rustBrowserModel.includes("pub struct BrowserDeveloperModeSettings"), "browser model owns Browser Developer Mode settings");
assert(rustBrowserModel.includes("pub struct BrowserClearHistoryRequest"), "browser model owns operator request structs");
assert(cargoToml.includes('"unstable"'), "Tauri unstable webview API is enabled for child Browser engine");
assert(rustBrowser.includes("BROWSER_ENGINE_WEBVIEW_LABEL"), "native Browser engine webview label is modeled");
assert(tauriCapabilitiesSource.includes('"shellx-browser"'), "Browser window has Tauri permissions for debug API and engine commands");
assert(
  tauriConfSource.includes("http://127.0.0.1:*") && tauriConfSource.includes("ws://127.0.0.1:*"),
  "production CSP allows Browser renderer debug API traffic on dynamic loopback ports",
);
assert(rustBrowser.includes("BrowserEngineSnapshot"), "Browser engine state is exposed in snapshots");
assert(rustBrowser.includes("BrowserEngineWaitlistSnapshot"), "Browser engine waitlist state is exposed in snapshots");
assert(rustBrowser.includes("BrowserEnginePoolSnapshot"), "Browser engine pool state is exposed in snapshots");
assert(rustBrowser.includes("BrowserEnginePoolUpdateRequest"), "Browser engine pool settings update request is modeled");
assert(
  browserProfilesSource.includes("pub(crate) fn default_profiles") &&
    browserProfilesSource.includes("pub(crate) fn browser_profile_storage_root") &&
    browserProfilesSource.includes("pub(crate) fn resolve_profile_id") &&
    browserProfilesSource.includes("safe_storage_segment") &&
    rustLib.includes("mod shellx_browser_profiles;"),
  "Browser profile defaults and storage roots live in a focused module",
);
assert(
  !/fn default_profiles/.test(rustBrowser) &&
    !/fn browser_profile_storage_root/.test(rustBrowser) &&
    !/fn safe_storage_segment/.test(rustBrowser) &&
    !/fn resolve_profile_id/.test(rustBrowser),
  "Browser profile helpers are no longer embedded in shellx_browser.rs",
);
assert(rustBrowser.includes("engine_pool"), "Browser state carries the engine pool");
assert(rustBrowser.includes("engine_id"), "Browser tabs and engines carry stable engine ids");
assert(rustBrowserModel.includes("pending_url: Option<String>"), "Browser engine tracks pending navigation separately from committed URL");
assert(rustBrowser.includes("Browser engine navigation to {} is still pending"), "Browser actions are blocked while native navigation is pending");
assert(rustBrowser.includes("Browser engine is showing {} while active tab expects {}"), "Browser actions are blocked when WebView page and active tab diverge");
assert(
    rustBrowser.includes("engine_belongs_to_tab") &&
    rustBrowser.includes("same_tab_oauth_redirect_mismatch_is_allowed_for_state_healing") &&
    rustBrowser.includes("same_allocated_engine_redirect_with_lagging_owner_metadata_is_allowed") &&
    rustBrowser.includes("engine_observation_reconciles_oauth_redirect_before_context_check") &&
    rustBrowser.includes("engine_action_guard_reconciles_allocated_engine_redirect_before_dispatch"),
  "Browser actions allow same-tab OAuth redirects so observation can heal tab state",
);
assert(rustBrowser.includes("BROWSER_ENGINE_EVAL_TIMEOUT"), "Browser engine timeout uses a stable error sentinel");
assert(rustBrowser.includes("browserEngineBusy"), "Browser engine waitlist returns retryable busy responses instead of hanging");
assert(rustBrowser.includes("try_block_beforeunload_navigation"), "Browser navigate preflights beforeunload registration before leaving dirty pages");
assert(rustBrowser.includes("record_engine_beforeunload_blocker"), "Browser engine records beforeunload blockers from pending native navigation");
assert(browserEngineStateSource.includes("browserBeforeUnloadBlocked"), "Browser engine emits a dedicated beforeunload blocker receipt");
assert(
  browserEngineStateSource.includes("browser_urls_match_without_query_or_fragment"),
  "Browser engine can commit accepted beforeunload loads when WebView omits query strings",
);
assert(rustBrowser.includes("__shellxBeforeUnloadRegistered"), "Browser initialization tracks page beforeunload registration for approval gating");
assert(rustBrowser.includes("normalize_engine_sync_request"), "Browser engine normalizes stale UI sync requests before touching the native WebView");
assert(browserEngineStateSource.includes("stale_personal_blank_sync"), "Browser engine ignores stale personal blank syncs after task tab activation");
assert(rustBrowser.includes('engine.load_status == "navigating"'), "Browser engine clears stale navigating state when returning to the committed page");
assert(rustBrowser.includes("BrowserHistoryEntry"), "Browser history entries are modeled in state");
assert(rustBrowser.includes("BrowserBookmarkKind"), "Browser bookmarks distinguish links and folders");
assert(rustBrowser.includes("BrowserBookmarkToolbarItem"), "Browser exposes toolbar bookmark items");
assert(rustBrowser.includes("BrowserBookmarkUpsertRequest"), "Browser can upsert bookmarks through a structured request");
assert(rustBrowser.includes("BrowserTabSnapshot"), "Browser tabs are modeled in state");
assert(rustBrowser.includes("BrowserTabLock"), "Browser tab lock leases are modeled");
assert(rustBrowserModel.includes("BrowserTabOwnerKind"), "Browser tabs model user, agent, and delegated ownership");
assert(rustBrowserModel.includes("BrowserPersonalLockSettings"), "Browser Personal Lock state is modeled");
assert(rustBrowserPersonalLock.includes("browser_personal_lock_requires_operator"), "Personal Browser Lock mutations require the ShellX operator path");
assert(rustBrowserPersistence.includes("browser-settings.json"), "Browser privacy, Shields, and Personal Lock settings persist to a dedicated local settings file");
assert(rustBrowserPersistence.includes("SHELLX_BROWSER_SETTINGS_PATH"), "Browser settings persistence has an isolated test path override");
assert(rustBrowserPersistence.includes("persistable_personal_lock") && rustBrowserPersistence.includes("copy.locked = false"), "Personal Browser Lock persistence does not trust runtime locked state from disk");
assert(rustBrowserPersistence.includes("personalLockPinHash") && rustBrowserPersistence.includes('assert!(!raw.contains("2468"))'), "Browser settings persistence stores PIN verifier metadata without raw PINs");
assert(rustBrowserModel.includes("opt_in_confirmed_at_ms") && browserTypesSource.includes("optInConfirmedAtMs"), "Personal Browser Lock stores an explicit opt-in marker across Rust and UI state");
assert(rustBrowserPersistence.includes("browser_settings_ignore_legacy_unconfirmed_personal_lock_opt_in"), "Browser settings disable legacy Personal Lock state without explicit opt-in");
assert(rustBrowserPersistence.includes("confirmed opt-in should not lock personal tabs immediately on app launch"), "Confirmed Personal Lock opt-in starts unlocked on app launch");
assert(rustBrowserPersistence.includes("state.tabs.is_empty()") && rustBrowserPersistence.includes("state.receipts.is_empty()"), "Browser settings persistence test rejects runtime tabs and receipts in settings");
assert(rustBrowserPersonalLock.includes("browserTabHandoff"), "agent control of user-owned tabs requires handoff");
assert(rustBrowserPersonalLock.includes("browserTabDelegationMismatch"), "delegated tabs reject the wrong Browser task");
assert(rustBrowser.includes("BrowserPageSecurityState"), "Browser page security state is modeled");
assert(rustBrowser.includes("BrowserPrivacySettings"), "Browser privacy settings are modeled");
assert(rustBrowser.includes("BrowserShieldSettings"), "Browser Shields settings are modeled");
assert(rustBrowser.includes("BrowserSiteShieldOverride"), "Browser Shields support per-site overrides");
assert(rustBrowser.includes("BrowserDeveloperModeSettings"), "Browser Developer Mode settings are modeled");
assert(rustBrowser.includes("BrowserFileTransferEntry"), "Browser file transfer intents are modeled");
assert(rustBrowser.includes("BrowserTransferCompleteRequest"), "Browser file transfer completion requests are modeled");
assert(rustBrowser.includes("BrowserDomSummary"), "Browser observations include deterministic DOM summary metadata");
assert(rustBrowser.includes("BrowserFormField"), "Browser observations include a structured form field map");
assert(rustBrowser.includes("BrowserAccessibilityNode"), "Browser observations include an accessibility-style control tree");
assert(rustBrowser.includes("BrowserLocatorSuggestion"), "Browser observations include locator suggestions");
assert(rustBrowser.includes("BrowserElementBounds"), "Browser observations include element bounds");
assert(rustBrowser.includes("BrowserActionabilityCheck"), "Browser actions include actionability checks");
assert(rustBrowserModel.includes("BrowserActionabilityCoveringElement"), "Browser actionability reports the element covering a failed click target");
assert(rustBrowser.includes("BrowserVerificationResult"), "Browser actions include verification results");
assert(rustBrowser.includes("BrowserAgentStepSummary"), "Browser actions include compact agent step summaries");
assert(rustBrowserModel.includes("snapshot_id"), "Browser observations expose a snapshot id for agent control loops");
assert(rustBrowserModel.includes("target_ref_id") && rustBrowserModel.includes("locator_candidates"), "Browser step summaries expose target and locator recovery metadata");
assert(rustBrowser.includes("BrowserTraceExportRequest"), "Browser trace export request is modeled");
assert(rustBrowser.includes("BrowserTraceBundleArtifact"), "Browser trace bundle artifacts are modeled");
assert(rustBrowser.includes("BrowserCdpExecuteRequest"), "Browser CDP executor request is modeled");
assert(rustBrowser.includes("BrowserCdpExecuteResponse"), "Browser CDP executor response is modeled");
assert(rustBrowser.includes("execute_browser_cdp_command"), "Browser has a gated CDP executor");
assert(rustBrowserDeveloperMode.includes("browserCdpCommandExecuted"), "Browser CDP executor emits completion receipts");
assert(
  browserCdpRuntimeSource.includes("pub async fn execute_browser_cdp_command") &&
    browserCdpRuntimeSource.includes("pub async fn export_browser_performance") &&
    browserCdpRuntimeSource.includes("pub(crate) async fn eval_browser_engine_json") &&
    browserCdpRuntimeSource.includes("fn browser_cdp_execution_script") &&
    browserCdpRuntimeSource.includes("fn browser_performance_capture_script") &&
    rustLib.includes("mod shellx_browser_cdp_runtime;"),
  "Browser CDP and performance runtime lives in a focused module",
);
assert(
  !/pub async fn execute_browser_cdp_command\s*\(/.test(rustBrowser) &&
    !/pub async fn export_browser_performance\s*\(/.test(rustBrowser) &&
    !/fn browser_cdp_execution_script\s*\(/.test(rustBrowser) &&
    !/fn browser_performance_capture_script\s*\(/.test(rustBrowser),
  "Browser CDP and performance runtime is no longer embedded in shellx_browser.rs",
);
assert(rustBrowser.includes("BrowserHarExportRequest"), "Browser HAR export request is modeled");
assert(rustBrowser.includes("BrowserHarArtifact"), "Browser HAR export artifact is modeled");
assert(rustBrowserDiagnostics.includes("browserHarExported"), "Browser HAR exports emit receipts");
assert(rustBrowser.includes("BrowserPerformanceExportRequest"), "Browser performance export request is modeled");
assert(rustBrowser.includes("BrowserPerformanceArtifact"), "Browser performance export artifact is modeled");
assert(rustBrowserDiagnostics.includes("browserPerformanceExported"), "Browser performance exports emit receipts");
assert(rustBrowser.includes("BrowserRecipeExportRequest"), "Browser recorder recipe export request is modeled");
assert(rustBrowser.includes("BrowserRecipeReplayRequest"), "Browser recipe replay request is modeled");
assert(rustBrowserRecipes.includes('"schemaVersion": 2'), "Browser recipe exports use Action Recipe V2 manifests");
assert(rustBrowserRecipes.includes("variableInputs") && rustBrowserRecipes.includes("decisionPoints") && rustBrowserRecipes.includes("sourceReceipts"), "Browser recipe exports include replay planning sections");
assert(rustBrowserRecipes.includes("browserRecipeExported"), "Browser recipe exports emit receipts");
assert(rustBrowserRecipes.includes("browserRecipeReplayCompleted"), "Browser recipe replay emits completion receipts");
assert(rustBrowser.includes("BrowserRobotScheduleRequest"), "Browser robot queue schedule request is modeled");
assert(rustBrowser.includes("BrowserRobotJob"), "Browser robot queue jobs are modeled");
assert(rustBrowserRobots.includes("browserRobotScheduled"), "Browser robot scheduling emits receipts");
assert(rustBrowserRobots.includes("browserRobotRunCompleted"), "Browser robot runs emit completion receipts");
assert(rustBrowserArtifacts.includes("redact_trace_receipt"), "Browser trace bundles redact raw receipt text");
assert(rustBrowserDiagnostics.includes("diagnosticsSections"), "Browser trace bundles include diagnostics section metadata");
assert(rustBrowserArtifacts.includes("browser_trace_string_redaction"), "Browser trace bundles redact credential-shaped strings");
assert(rustBrowser.includes("BrowserStorageStateManifest"), "Browser storage-state manifests are modeled");
assert(rustBrowser.includes("BrowserStorageStateExportArtifact"), "Browser storage-state export artifacts are modeled");
assert(rustBrowser.includes("BrowserSessionGrantResolveRequest"), "Browser session grant resolve requests are modeled");
assert(rustBrowser.includes("BrowserSessionGrantApplyRequest"), "Browser session grant apply requests are modeled");
assert(rustBrowser.includes("BrowserDialogEvent"), "Browser dialog events are modeled");
assert(rustBrowser.includes("BrowserPermissionEvent"), "Browser page permission events are modeled");
assert(rustBrowser.includes("BrowserPermissionRecordRequest"), "Browser page permission record requests are modeled");
assert(rustBrowser.includes("BrowserPermissionResolveRequest"), "Browser page permission resolve requests are modeled");
assert(
  browserEngineRuntimeSource.includes("PermissionRequestedEventHandler") &&
    browserEngineRuntimeSource.includes("add_PermissionRequested") &&
    browserEngineRuntimeSource.includes("browser_permission_report_initialization_script") &&
    browserEngineRuntimeSource.includes("__shellxPermissionRequests") &&
    browserActionsSource.includes("record_queued_browser_permission_reports") &&
    browserActionsSource.includes("browser_permission_report_drain_script") &&
    browserActionsSource.includes("record_permission_event") &&
    browserScriptsSource.includes("ensureShellxPermissionReporter"),
  "native WebView and action-drained page permission requests are bridged into Browser permission events",
);
assert(rustBrowser.includes("BrowserPopupEvent"), "Browser popup events are modeled");
assert(rustBrowser.includes("BrowserNetworkEntry"), "Browser network metadata entries are modeled");
assert(rustBrowser.includes("BrowserScreenshotArtifact"), "Browser actions can return structured screenshot artifacts");
assert(
  browserProtectedValuesSource.includes("BROWSER_SECRET_REDACTION_PLACEHOLDER") &&
    browserProtectedValuesSource.includes("register_browser_protected_value_locked") &&
    browserProtectedValuesSource.includes("browser_protected_values_for_task") &&
    browserProtectedValuesSource.includes("redact_browser_observation") &&
    browserProtectedValuesSource.includes("redact_engine_control_result") &&
    browserProtectedValuesSource.includes("redact_browser_credential_patterns") &&
    browserProtectedValuesSource.includes("redact_browser_url_query_fragments") &&
    browserProtectedValuesSource.includes("credential_pattern_redaction_covers_observed_page_keys") &&
    browserProtectedValuesSource.includes("redact_browser_option(&mut observation.url") &&
    browserProtectedValuesSource.includes("redact_browser_option(&mut reference.selector") &&
    browserProtectedValuesSource.includes("redact_browser_option(&mut node.selector") &&
    browserProtectedValuesSource.includes("redact_browser_option(&mut verification.checked_url") &&
    browserProtectedValuesSource.includes("block_screenshot_if_protected_values") &&
    rustLib.includes("mod shellx_browser_protected_values;"),
  "Browser protected-value redaction lives in a focused module",
);
assert(
  !/fn browser_should_track_protected_value/.test(rustBrowser) &&
    !/fn redact_browser_observation/.test(rustBrowser) &&
    !/fn redact_engine_control_result/.test(rustBrowser) &&
    !/fn register_browser_protected_value_locked/.test(rustBrowser),
  "Browser protected-value redaction helpers are no longer embedded in shellx_browser.rs",
);
assert(rustBrowserModel.includes("screenshot_full_page"), "Browser action requests can ask for full-page screenshot capture");
assert(rustBrowserModel.includes("timeout_ms"), "Browser action requests can bound wait-style actions with timeoutMs");
assert(rustBrowserModel.includes("full_page"), "Browser screenshot artifacts report whether they are full-page captures");
assert(rustBrowserModel.includes("page_width"), "Browser screenshot artifacts report full-page CSS width");
assert(rustBrowserModel.includes("page_height"), "Browser screenshot artifacts report full-page CSS height");
assert(rustBrowser.includes("BrowserFindTextResult"), "Browser find-in-page results are modeled");
assert(browserScriptsSource.includes("isSensitiveField"), "Browser observations classify password/token-like fields as sensitive");
assert(rustBrowser.includes("domSummary"), "Browser observation JSON exposes domSummary");
assert(rustBrowser.includes("formFields"), "Browser observation JSON exposes formFields");
assert(rustBrowserModel.includes("accessibilityTree"), "Browser observation JSON exposes accessibilityTree");
assert(rustBrowserModel.includes("locatorSuggestions"), "Browser observation JSON exposes locatorSuggestions");
assert(rustBrowserModel.includes("strictMatchCount"), "Browser observation refs expose strictMatchCount");
assert(rustBrowser.includes("actionability"), "Browser action JSON exposes actionability");
assert(rustBrowser.includes("verification"), "Browser action JSON exposes verification");
assert(rustBrowserModel.includes("stepSummary"), "Browser action JSON exposes compact step summaries");
assert(rustBrowser.includes("deserialize_bool_lossy"), "Browser action parser tolerates non-boolean page metadata");
assert(rustBrowser.includes('matches!(normalized.as_str(), "1" | "true" | "yes" | "y" | "on")'), "Browser action parser accepts string boolean metadata");
assert(rustBrowserModel.includes("deserialize_string_lossy"), "Browser observation parser tolerates non-string page metadata");
assert(browserActionsSource.includes("Input.dispatchMouseEvent"), "Browser click actions dispatch native mouse events after actionability checks");
assert(browserActionsSource.includes("native_input_recommended.unwrap_or(true)"), "Browser click actions can skip native mouse fallback when JS activation is enough");
assert(browserScriptsSource.includes("nativeInputRecommendedForClick") && browserScriptsSource.includes('element.closest?.("a[href],button,summary,label")'), "Browser click control script avoids double-activating normal anchors/buttons");
assert(browserActionsSource.includes("Input.insertText"), "Browser fill/type actions dispatch native text input after actionability checks");
assert(browserActionResultsSource.includes("browserScreenshotCaptured"), "Browser screenshot capture produces a dedicated receipt");
assert(browserActionsSource.includes("capture_window_label_png"), "Browser screenshot capture targets the Browser window label");
assert(browserActionsSource.includes("Page.captureScreenshot"), "Browser full-page screenshot capture uses the native page capture path");
assert(browserActionsSource.includes("captureBeyondViewport"), "Browser full-page screenshot capture can include content beyond the viewport");
assert(
  browserActionsSource.includes("call_browser_engine_cdp_with_timeout") &&
    browserActionsSource.includes("std::time::Duration::from_secs(20)"),
  "Browser full-page screenshot capture uses a longer WebView2 CDP timeout",
);
const screenshotCaptureSource = browserActionsSource.match(/async fn capture_browser_screenshot_artifact[\s\S]*?fn png_dimensions/)?.[0] ?? "";
assert(!screenshotCaptureSource.includes("focus_existing_browser_window"), "Browser screenshot capture does not steal foreground focus");
assert(debugApi.includes("app.get_window(window_label)"), "Browser screenshot capture can target chrome Window labels");
assert(
  debugApi.includes("was_iconic") && debugApi.includes("SW_MINIMIZE"),
  "Browser screenshot capture restores temporarily unminimized windows back to minimized state",
);
assert(rustBrowser.includes("BrowserEngineBounds"), "Browser engine bounds are modeled");
assert(rustBrowser.includes("shellx_browser_sync_engine"), "Browser engine sync command is registered");
assert(browserEngineRuntimeSource.includes("focus_existing_browser_window"), "Browser window lifecycle can focus an existing chrome window before rebuilding it");
assert(browserEngineRuntimeSource.includes("ensure_browser_window_for_engine"), "Browser engine sync has a non-focusing window ensure path");
assert(
  browserEngineRuntimeSource.includes("fn ensure_browser_window_for_engine(") &&
    browserEngineRuntimeSource.includes("restore_visible_geometry: bool"),
  "Browser engine sync can request non-focusing geometry restoration for visible tabs",
);
assert(
  browserEngineRuntimeSource.includes("ensure_browser_window_for_engine(app, !browser_engine_bounds_are_background(request.bounds))?"),
  "Browser engine sync restores visible parked chrome without focusing background tabs",
);
assert(
  browserEngineRuntimeSource.includes("if restore_visible_geometry") &&
    browserEngineRuntimeSource.includes("restore_browser_window_geometry(&window)"),
  "Browser engine ensure path restores existing minimized/offscreen Browser windows",
);
assert(rustBrowser.includes("engine_sync_lock"), "Browser engine sync serializes concurrent native webview mounts");
assert(browserEngineRuntimeSource.includes("_engine_sync_guard"), "Browser engine sync holds the mount lock while touching native webviews");
assert(browserEngineRuntimeSource.includes("wait_for_browser_engine_label_release"), "Browser engine sync waits for stale labels before remounting");
assert(debugApi.includes("wait_for_engine_action_slot"), "debug API routes engine-backed browser actions through the waitlist");
assert(rustBrowser.includes("browser_engine_webview_label"), "Browser engine webview labels are derived from engine ids");
assert(browserCdpRuntimeSource.includes("eval_browser_engine_json(app, &engine_label"), "Browser engine eval routes through the target engine label");
assert(uiSource.includes("activeBrowserTabId: activeBrowserTab?.browserTabId ?? null"), "Browser UI sends active tab id during native engine sync");
assert(browserEngineRuntimeSource.includes("restore_browser_window_geometry"), "Browser window lifecycle restores minimized/offscreen existing windows");
assert(browserEngineRuntimeSource.includes("window.unminimize"), "Browser window restore path unminimizes parked windows");
assert(browserEngineRuntimeSource.includes("outer_position"), "Browser window restore path inspects existing window position");
assert(browserEngineRuntimeSource.includes("set_position(Position::Logical(LogicalPosition::new(160.0, 120.0)))"), "Browser window restore path has a visible-position fallback");
assert(
  browserEngineRuntimeSource.includes("pub fn open_or_focus_browser_window") &&
    browserEngineRuntimeSource.includes("pub(crate) fn sync_native_browser_engine") &&
    browserEngineRuntimeSource.includes("fn install_strict_browser_request_filter") &&
    browserEngineRuntimeSource.includes("fn park_inactive_browser_engine_webviews") &&
    browserEngineRuntimeSource.includes("fn wait_for_browser_engine_label_release") &&
    browserEngineRuntimeSource.includes("fn engine_bounds_rect") &&
    rustLib.includes("mod shellx_browser_engine_runtime;"),
  "Browser native engine runtime lives in a focused module",
);
assert(
  !/pub fn open_or_focus_browser_window\s*\(/.test(rustBrowser) &&
    !/fn ensure_browser_window_for_engine\s*\(/.test(rustBrowser) &&
    !/fn sync_native_browser_engine\s*\(/.test(rustBrowser) &&
    !/fn install_strict_browser_request_filter\s*\(/.test(rustBrowser) &&
    !/fn park_inactive_browser_engine_webviews\s*\(/.test(rustBrowser) &&
    !/fn wait_for_browser_engine_label_release\s*\(/.test(rustBrowser) &&
    !/fn engine_bounds_rect\s*\(/.test(rustBrowser),
  "Browser native engine runtime helpers are no longer embedded in shellx_browser.rs",
);
assert(
  browserEngineStateSource.includes("pub fn record_engine_sync") &&
    browserEngineStateSource.includes("pub fn record_engine_load_for_engine") &&
    browserEngineStateSource.includes("pub fn record_engine_title_for_engine") &&
    browserEngineStateSource.includes("pub fn record_engine_beforeunload_blocker") &&
    rustLib.includes("mod shellx_browser_engine_state;"),
  "Browser engine state lifecycle lives in a focused module",
);
assert(
  !/pub fn record_engine_sync\s*\(/.test(rustBrowser) &&
    !/pub fn record_engine_load_for_engine\s*\(/.test(rustBrowser) &&
    !/pub fn record_engine_title_for_engine\s*\(/.test(rustBrowser) &&
    !/pub fn record_engine_beforeunload_blocker\s*\(/.test(rustBrowser),
  "Browser engine state lifecycle methods are no longer embedded in shellx_browser.rs",
);
assert(browserEngineRuntimeSource.includes("WebviewBuilder::new"), "Browser engine creates a native child webview");
assert(browserEngineRuntimeSource.includes("add_child"), "Browser engine mounts inside the Browser chrome window");
assert(browserEngineRuntimeSource.includes("set_bounds"), "Browser engine can resize to the viewport");
assert(
  browserEngineRuntimeSource.includes("SHELLX_BROWSER_WEBVIEW2_ADDITIONAL_ARGS") &&
    browserEngineRuntimeSource.includes("additional_browser_args(SHELLX_BROWSER_WEBVIEW2_ADDITIONAL_ARGS)") &&
    browserEngineRuntimeSource.includes("--disable-background-timer-throttling") &&
    browserEngineRuntimeSource.includes("--disable-backgrounding-occluded-windows") &&
    browserEngineRuntimeSource.includes("--disable-renderer-backgrounding") &&
    browserEngineRuntimeSource.includes("msWebOOUI,msPdfOOUI,msSmartScreenProtection"),
  "Browser WebView2 engines opt out of occluded/background throttling while preserving Wry default UI/smartscreen flags",
);
assert(browserCdpRuntimeSource.includes("eval_with_callback"), "Browser engine can evaluate DOM extraction scripts");
assert(rustBrowser.includes("try_apply_engine_action"), "Browser action path can use the native engine");
assert(rustBrowser.includes("sync_engine_to_task"), "debug API task starts can sync the mounted Browser engine directly");
assert(rustBrowser.includes("sync_engine_to_tab"), "debug API tab navigation can sync the mounted Browser engine directly");
assert(rustBrowser.includes("sync_engine_to_tab_preserving_page"), "debug API tab focus can sync without replaying stale tab URLs");
assert(
  debugApiBrowserStateSource.includes("sync_engine_to_tab(s.app(), &registry, &response.tab)") &&
    debugApiBrowserStateSource.includes("sync_engine_to_tab_preserving_page") &&
    debugApi.includes("sync_engine_to_tab_preserving_page(app, registry, &tab)"),
  "debug API tab open navigates while tab focus/active alignment preserves existing Browser pages",
);
assert(debugApi.includes("sync_browser_action_navigation_to_engine"), "debug API navigate actions sync the mounted Browser engine directly");
assert(
  debugApi.includes("let tab_from_task = response") &&
    debugApi.includes(".find(|tab| tab.task_id.as_deref() == Some(task_id))") &&
    debugApi.includes("tab_from_task.or(tab_from_active)"),
  "debug API navigate sync targets the response task tab before falling back to the active tab",
);
assert(debugApi.includes("sync_engine_to_tab(app, registry, &tab).map(|_| ())"), "debug API navigate sync remains non-preserving so explicit navigation drives the WebView");
assert(browserActionResultsSource.includes("browserEngineObserved"), "engine-backed page observations produce receipts");
assert(browserApiSource.includes("preserveExistingPage?: boolean"), "Browser engine sync API can mark layout syncs as page-preserving");
assert(rustBrowserModel.includes("preserve_existing_page"), "Browser engine sync model carries page-preservation intent");
assert(nativeEngineSyncSource.includes("preserveExistingPage: true"), "Browser UI focus and resize syncs preserve the live page");
assert(
  browserEngineRuntimeSource.includes("request.preserve_existing_page && same_browser_tab") &&
    browserEngineRuntimeSource.includes("let should_navigate = !preserve_existing_page") &&
    browserEngineRuntimeSource.includes("current_webview_url"),
  "Browser native engine does not replay stale tab URLs and reports the live URL during same-tab preserving sync",
);
assert(
  browserEngineStateSource.includes("let preserve_existing_page = request.preserve_existing_page") &&
    browserEngineStateSource.includes("let navigation_requested = !preserve_existing_page") &&
    browserEngineStateSource.includes("engine.url = Some(current_url)"),
  "Browser engine state commits live URLs without false navigation records during same-tab preserving sync",
);
assert(
  uiSource.includes("const rawUrl = state?.engine?.url ?? activeBrowserTab.url ?? \"\""),
  "browser Vault fill observation prefers the active engine URL when tab metadata is stale",
);
assert(rustBrowser.includes("selector"), "engine observations expose selectors for deterministic controls");
assert(rustBrowserModel.includes("raw_selector"), "engine observations preserve internal raw selectors for ref replay");
assert(
  browserActionResultsSource.includes("preserve_raw_observation_selectors") &&
    browserActionResultsSource.includes(".raw_selector") &&
    browserActionResultsSource.includes("or_else(|| candidate.selector.clone())"),
  "Browser redacts visible selectors without breaking ref replay",
);
assert(browserScriptsSource.includes("BROWSER_ENGINE_CONTROL_SCRIPT"), "Browser engine has a deterministic control script");
assert(
  browserScriptsSource.includes("BROWSER_ENGINE_OBSERVE_SCRIPT") &&
    browserScriptsSource.includes("BROWSER_ENGINE_CONTROL_SCRIPT") &&
    browserScriptsSource.includes("xpathCount") &&
    browserScriptsSource.includes("if (queryCount(cssSelector) === 1) return cssSelector;") &&
    browserScriptsSource.includes("if (xpathCount(xpath) === 1) return xpath;") &&
    browserScriptsSource.includes("return queryCount(cssSelector) > 0 ? cssSelector : xpath;") &&
    browserScriptsSource.includes("document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)") &&
    browserScriptsSource.includes('current !== document &&') &&
    browserScriptsSource.includes('`/${parts.join("/")}`') &&
    browserScriptsSource.includes("summary,output,[aria-live]") &&
    browserScriptsSource.includes("InputEvent(\"beforeinput\"") &&
    browserScriptsSource.includes("execCommand(\"insertText\"") &&
    rustLib.includes("mod shellx_browser_scripts;"),
  "Browser native engine scripts live in a focused module and replay XPath when CSS selectors are not actionable",
);
assert(
  !/const BROWSER_ENGINE_OBSERVE_SCRIPT/.test(rustBrowser) &&
    !/const BROWSER_ENGINE_CONTROL_SCRIPT/.test(rustBrowser),
  "Browser native engine scripts are no longer embedded in shellx_browser.rs",
);
assert(
  browserActionResultsSource.includes("pub fn record_engine_observation") &&
    browserActionResultsSource.includes("pub(crate) fn record_engine_control_result") &&
    browserActionResultsSource.includes("pub(crate) fn record_screenshot_result") &&
    browserActionResultsSource.includes("pub fn resolve_engine_selector") &&
    browserActionResultsSource.includes("browser_observation_refs_with_synthetic") &&
    rustLib.includes("mod shellx_browser_action_results;"),
  "Browser engine action result lifecycle lives in a focused module",
);
assert(
  !/pub fn record_engine_observation\s*\(/.test(rustBrowser) &&
    !/fn record_engine_control_result\s*\(/.test(rustBrowser) &&
    !/fn record_screenshot_result\s*\(/.test(rustBrowser) &&
    !/pub fn resolve_engine_selector\s*\(/.test(rustBrowser) &&
    !/fn browser_observation_refs_with_synthetic\s*\(/.test(rustBrowser),
  "Browser engine action result lifecycle methods are no longer embedded in shellx_browser.rs",
);
assert(browserActionResultsSource.includes("resolve_engine_selector"), "Browser engine resolves observation refs to selectors");
assert(
  browserActionResultsSource.includes("record_taskless_engine_control_result_locked") &&
    browserActionResultsSource.includes("Browser user tab engine action") &&
    browserActionResultsSource.includes("task_id: None") &&
    browserActionResultsSource.includes("register_browser_protected_value_for_scope_locked") &&
    browserActionResultsSource.includes("browser_protected_values_for_tab"),
  "taskless user tabs can record native Browser engine controls without an agent task",
);
assert(rustBrowser.includes("browserEngineActionApplied"), "engine-backed DOM actions produce receipts");
assert(browserActionResultsSource.includes("browserVerificationPassed"), "Browser verification pass receipts are modeled");
assert(browserActionResultsSource.includes("browserVerificationFailed"), "Browser verification failure receipts are modeled");
assert(rustBrowserDiagnostics.includes("browserTraceBundleExported"), "Browser trace bundle export receipts are modeled");
assert(rustBrowserStorageState.includes("browserStorageStateManifestExported"), "Browser storage-state export receipts are modeled");
assert(rustBrowserSessionGrants.includes("browserSessionGrantApplied"), "Browser session grant application receipts are modeled");
assert(rustBrowserPrompts.includes("browserDialogRecorded"), "Browser dialog record receipts are modeled");
assert(rustBrowserPrompts.includes("browserDialogResolved"), "Browser dialog resolve receipts are modeled");
assert(rustBrowserPrompts.includes("browserPermissionRequested"), "Browser page permission request receipts are modeled");
assert(rustBrowserPrompts.includes("browserPermissionResolved"), "Browser page permission resolve receipts are modeled");
assert(
  browserEngineRuntimeSource.includes("COREWEBVIEW2_PERMISSION_STATE_DENY") &&
    browserEngineRuntimeSource.includes("requires_approval: true"),
  "native page permissions fail closed until ShellX operator approval is available",
);
assert(rustBrowserPrompts.includes("browserPopupRecorded"), "Browser popup record receipts are modeled");
assert(rustBrowser.includes("browserNetworkObserved"), "Browser network metadata receipts are modeled");
assert(rustBrowser.includes("findText"), "Browser engine can search text inside the current page");
assert(browserScriptsSource.includes("summary,output,[aria-live]"), "Browser find-in-page can scroll common app status/output elements");
assert(browserScriptsSource.includes("notActionable"), "Browser engine can return honest notActionable outcomes");
assert(browserScriptsSource.includes("dispatchEvent(new Event(\"input\""), "engine-backed fill/type dispatches input events");
assert(browserScriptsSource.includes("InputEvent(\"beforeinput\""), "engine-backed fill/type dispatches beforeinput events for rich editors");
assert(browserScriptsSource.includes("execCommand(\"insertText\""), "engine-backed fill/type uses browser text insertion for contenteditable editors");
assert(rustBrowser.includes("extractTable"), "Browser engine can extract table data deterministically");
assert(liveSmokeSource.includes("domSummary"), "live Browser smoke checks DOM summary observations");
assert(liveSmokeSource.includes("formFields"), "live Browser smoke checks form field observations");
assert(liveSmokeSource.includes("accessibilityTree"), "live Browser smoke checks accessibility control observations");
assert(liveSmokeSource.includes("locatorSuggestions"), "live Browser smoke checks locator suggestions");
assert(liveSmokeSource.includes("strictMatchCount"), "live Browser smoke checks strict match metadata");
assert(liveSmokeSource.includes("actionability"), "live Browser smoke checks actionability receipts");
assert(liveSmokeSource.includes("browserVerificationPassed"), "live Browser smoke checks verification pass receipts");
assert(liveSmokeSource.includes("browserVerificationFailed"), "live Browser smoke checks verification failure receipts");
assert(liveSmokeSource.includes("stepSummary"), "live Browser smoke checks compact step summaries");
assert(liveSmokeSource.includes("action: \"findText\""), "live Browser smoke checks find-in-page actions");
assert(liveSmokeSource.includes("/browser/trace/export"), "live Browser smoke checks trace bundle export route");
assert(liveSmokeSource.includes("shellx-browser-traces"), "live Browser smoke checks Browser trace artifact path");
assert(liveSmokeSource.includes("/browser/storage-state"), "live Browser smoke checks storage-state manifest route");
assert(liveSmokeSource.includes("cookieValuesExposed"), "live Browser smoke checks storage-state privacy flags");
assert(liveSmokeSource.includes("/browser/session-grants/apply"), "live Browser smoke checks session grant application route");
assert(liveSmokeSource.includes("/browser/dialogs"), "live Browser smoke checks dialog routes");
assert(liveSmokeSource.includes("/browser/permissions"), "live Browser smoke checks page permission routes");
assert(liveSmokeSource.includes("/browser/popups"), "live Browser smoke checks popup routes");
assert(liveSmokeSource.includes("browser_prompt_resolution_requires_operator"), "live Browser smoke verifies prompt resolution mutation gate");
assert(liveSmokeSource.includes("/browser/network"), "live Browser smoke checks network metadata route");
assert(liveSmokeSource.includes("browserScreenshotCaptured"), "live Browser smoke checks screenshot capture receipts");
assert(liveSmokeSource.includes("shellx-browser-screenshots"), "live Browser smoke checks Browser screenshot artifact path");
assert(tauriConfSource.includes("\"$HOME/.grok/shellx-browser-screenshots/**\""), "Tauri asset protocol allows Browser screenshot artifacts");
assert(tauriConfSource.includes("\"$HOME/.grok/shellx-browser-traces/**\""), "Tauri asset protocol allows Browser trace artifacts");
assert(rustBrowser.includes("browserBookmarkSaved"), "Browser can save the current page as a bookmark");
assert(browserBookmarksSource.includes("browserHistoryCleared"), "Browser can clear local history from the user UI");
assert(rustBrowser.includes("BrowserClearHistoryRequest"), "Browser clear-history operator request is modeled");
assert(browserBookmarksSource.includes("shellx_browser_destructive_actions::browser_destructive_action_requires_operator"), "Browser clear-history registry mutation is operator-gated");
assert(rustBrowserDestructiveActions.includes("BROWSER_DESTRUCTIVE_ACTION_OPERATOR_ERROR_CODE"), "Browser destructive action module defines the operator-gate error code");
assert(
  (rustBrowser.includes("browserTabLockDenied") || browserTabsSource.includes("browserTabLockDenied")) &&
    browserTabsSource.includes("tab_lock_denial_for_request"),
  "Browser tab locks produce deterministic denial receipts",
);
assert(rustBrowserPrivacy.includes("browserPrivacyModeChanged"), "Browser privacy mode changes produce receipts");
assert(
  (rustBrowser.includes("browserInsecureCredentialEntryBlocked") ||
    browserSecuritySource.includes("browserInsecureCredentialEntryBlocked")),
  "Browser blocks insecure credential entry with a receipt",
);
assert(
  (rustBrowser.includes("insecureCredentialEntryApproval") ||
    browserSecuritySource.includes("insecureCredentialEntryApproval")),
  "Browser exposes the insecure credential approval kind",
);
assert(rustBrowserDeveloperMode.includes("browserDeveloperModeChanged"), "Browser Developer Mode changes produce receipts");
assert(rustBrowserDeveloperMode.includes("browserCdpAccessRequested"), "Browser CDP access requests produce receipts");
assert(rustBrowserDeveloperMode.includes("browserCdpAccessApproved"), "Browser CDP approvals produce receipts");
assert(rustLib.includes("shellx_browser_developer_mode::shellx_browser_update_developer_mode"), "browser Developer Mode operator command is registered with Tauri");
assert(rustLib.includes("shellx_browser_developer_mode::shellx_browser_approve_developer_mode_host"), "browser Developer Mode host approval command is registered with Tauri");
assert(rustBrowserDeveloperMode.includes("browser_developer_mode_update_requires_operator"), "browser Developer Mode registry updates are operator-gated");
assert(rustBrowserDeveloperMode.includes("browser_developer_mode_approval_requires_operator"), "browser Developer Mode approvals are operator-gated");
assert(rustBrowserDeveloperMode.includes("BROWSER_DEVELOPER_MODE_OPERATOR_ERROR_CODE"), "browser Developer Mode module defines the operator-gate error code");
assert(
  debugApi.includes("BROWSER_DEVELOPER_MODE_OPERATOR_ERROR_CODE") ||
    debugApiBrowserSettingsSource.includes("BROWSER_DEVELOPER_MODE_OPERATOR_ERROR_CODE"),
  "debug API rejects Browser Developer Mode mutation",
);
assert(rustBrowserTransfers.includes("browserDownloadRequested"), "Browser download intents produce receipts");
assert(rustBrowserTransfers.includes("browserUploadRequested"), "Browser upload intents produce receipts");
assert(rustBrowserTransfers.includes("browserDownloadCompleted"), "Browser download completion receipts are modeled");
assert(rustBrowserTransfers.includes("browserUploadCompleted"), "Browser upload completion receipts are modeled");
assert(rustLib.includes("shellx_browser_transfers::shellx_browser_grant_transfer"), "browser transfer approval command is registered with Tauri");
assert(rustBrowserTransfers.includes("browser_transfer_approval_requires_operator"), "browser transfer approvals are operator-gated");
assert(rustBrowserTransfers.includes("BROWSER_TRANSFER_OPERATOR_ERROR_CODE"), "browser transfer module defines the operator-gate error code");
assert(rustLib.includes("shellx_browser_prompts::shellx_browser_resolve_dialog"), "browser dialog resolution operator command is registered with Tauri");
assert(rustLib.includes("shellx_browser_prompts::shellx_browser_resolve_permission"), "browser permission resolution operator command is registered with Tauri");
assert(rustBrowserPrompts.includes("browser_dialog_agent_may_resolve_locked"), "browser dialog resolution has a narrow agent-owned beforeunload exception");
assert(rustBrowserPrompts.includes("tab.profile_id != \"personal\""), "agent dialog resolution excludes personal profile tabs");
assert(rustBrowserPrompts.includes("browser_permission_resolution_requires_operator(&request)"), "browser permission resolution is operator-gated");
assert(rustBrowserPrompts.includes("BROWSER_PROMPT_OPERATOR_ERROR_CODE"), "browser prompt module defines the operator-gate error code");
assert(rustBrowserSessionGrants.includes("browser_session_grant_resolution_requires_operator"), "browser session grant resolution is operator-gated");
assert(rustBrowserSessionGrants.includes("BROWSER_SESSION_GRANT_OPERATOR_ERROR_CODE"), "browser session grant module defines the operator-gate error code");
assert(
  debugApiBrowserRouteSources.some((source) => source.includes("BROWSER_SESSION_GRANT_OPERATOR_ERROR_CODE")),
  "debug API rejects Browser session grant resolution with a stable code",
);
assert(rustBrowserPrivacy.includes("visualCleanCompatibility"), "Browser ad modes include visual clean compatibility");
assert(rustBrowser.includes("Strict"), "Browser ad modes include strict native request filtering");
assert(rustBrowserModel.includes("global_ad_mode: BrowserAdMode::Balanced"), "Browser privacy defaults to balanced mode");
assert(rustBrowserModel.includes("profile_modes: Vec::new()"), "Browser profile privacy overrides are opt-in");
assert(
  rustBrowserShields.includes("browser_ad_decision_for_url") &&
    rustBrowserShields.includes("browser_privacy_initialization_script") &&
    rustBrowserShields.includes("refresh_browser_tab_shields"),
  "Browser Shields/ad-filter decisions live in shellx_browser_shields.rs",
);
assert(
  !rustBrowser.includes("fn browser_ad_decision_for_url") &&
    !rustBrowser.includes("fn browser_privacy_initialization_script") &&
    !rustBrowser.includes("fn refresh_browser_tab_shields"),
  "Browser Shields/ad-filter decisions are no longer embedded in shellx_browser.rs",
);
assert(rustBrowserShields.includes("__shellxPrivacyStats"), "Browser ad filter exposes local privacy stats for UI and tests");
assert(rustBrowser.includes("reapply_browser_privacy_to_active_engine"), "Browser reapplies ad filtering when privacy or shields settings change");
assert(browserEngineRuntimeSource.includes("install_strict_browser_request_filter"), "Browser strict ad mode installs native request filtering");
assert(
  browserEngineRuntimeSource.includes("AddWebResourceRequestedFilter") &&
    browserEngineRuntimeSource.includes("WebResourceRequestedEventHandler"),
  "Browser strict ad mode hooks WebView2 request interception",
);
assert(rustBrowser.includes("browserStrictRequestBlocked"), "Browser strict request filtering emits block receipts");
assert(rustBrowserShields.includes("window.fetch = function") && rustBrowserShields.includes("navigator.sendBeacon = function"), "Browser ad filter guards fetch and beacon tracker calls");
assert(
  rustBrowserShields.includes("resetPrivacyStatsForOffMode") &&
    rustBrowserShields.includes("blockedRequests = 0"),
  "Browser ad filter resets stale privacy counters when ad mode is off",
);
assert(rustBrowserShields.includes("Node.prototype.appendChild") && rustBrowserShields.includes("pagead2.googlesyndication.com"), "Browser ad filter guards dynamically injected ad scripts");
assert(rustBrowserShields.includes("adform.net") && rustBrowserShields.includes("googletagmanager.com") && rustBrowserShields.includes("scorecardresearch.com"), "Browser ad filter includes common news-site ad and tracker hosts");
assert(rustBrowserShields.includes("findAdTextOverlayNodes") && rustBrowserShields.includes("rekl[aā]m"), "Browser ad filter catches visible ad interstitial overlays");
assert(rustBrowserShields.includes(".monster-overlay") && rustBrowserShields.includes(".ad-countdown"), "Browser ad filter handles Delfi-style ad interstitial containers");
assert(rustBrowserShields.includes("__shellx_ad_filter_style") && rustBrowserShields.includes("persistentPresentationSelectors"), "Browser ad filter installs a persistent page stylesheet for late ad renderers");
assert(
  rustBrowserShields.includes("balancedPresentationSelectors") &&
    rustBrowserShields.includes("strictPresentationSelectors") &&
    rustBrowserShields.includes("presentationSelectorsForMode") &&
    rustBrowserShields.includes('mode === "strict"'),
  "Browser Balanced ad filtering keeps broad cosmetic selectors strict-only",
);
assert(
  rustBrowserShields.includes("genericAdTextPattern") &&
    rustBrowserShields.includes('mode !== "strict" && !strongInterstitial') &&
    rustBrowserShields.includes('strongInterstitial || (mode === "strict" && overlayLike(target))'),
  "Browser Balanced ad filtering keeps broad ad-text cleanup strict-only",
);
assert(rustBrowserShields.includes("__shellxLastAppliedPrivacyMode"), "Browser ad filter restores stale strict-hidden elements when privacy modes change");
assert(rustBrowserShields.includes("examined >= 20000"), "Browser ad text scan is bounded but not cut off by large consent-manager DOMs");
assert(rustBrowserShields.includes("__shellxPrivacySchedule") && rustBrowserShields.includes("characterData: true"), "Browser ad filter observes late text-rendered ad interstitials");
assert(rustBrowserShields.includes("250, 1000, 2500, 5000, 9000"), "Browser ad filter retries cleanup after late ad renderers");
assert(everydayFixtureSource.includes("ShellX ad filter cleaned"), "everyday fixture exercises visible ad cleanup");
assert(everydayFixtureSource.includes("ad-interstitial-fixture") && everydayAppsSmokeSource.includes("Portāls atvērsies"), "everyday fixture covers visible ad interstitial cleanup");
assert(everydayAppsSmokeSource.includes("blockedAdTrackerCount"), "everyday Browser smoke asserts tab shield ad count");
assert(rustBrowser.includes("record_history_visit"), "Browser records navigation history deterministically");
assert(browserTasksSource.includes("browserTaskStarted"), "browser task receipts are modeled");
assert(rustBrowser.includes("BrowserTaskControlRequest"), "Browser task operator control requests are modeled");
assert(browserTasksSource.includes("browserTaskPaused"), "Browser task pause receipts are modeled");
assert(browserTasksSource.includes("browserTaskResumed"), "Browser task resume receipts are modeled");
assert(browserTasksSource.includes("browserTaskAborted"), "Browser task abort receipts are modeled");
assert(browserTasksSource.includes("browserTaskUserTakeover"), "Browser task user-takeover receipts are modeled");
assert(
  browserTasksSource.includes("pub fn start_task") &&
    browserTasksSource.includes("pub fn finish_task") &&
    browserTasksSource.includes("pub fn control_task") &&
    browserTasksSource.includes("pub fn task_control_block_for_action") &&
    browserTasksSource.includes("pub(crate) fn resolve_task_id") &&
    browserTasksSource.includes("pub(crate) fn find_task_index") &&
    browserTasksSource.includes("pub(crate) fn browser_agent_step_summary_for_task") &&
    browserTasksSource.includes("pub(crate) fn task_control_blocked_response") &&
    browserTasksSource.includes("browserTaskStarted") &&
    browserTasksSource.includes("browserTaskActionBlocked") &&
    rustLib.includes("mod shellx_browser_tasks;"),
  "Browser task lifecycle lives in a focused module",
);
assert(
  !/pub fn start_task\s*\(/.test(rustBrowser) &&
    !/pub fn finish_task\s*\(/.test(rustBrowser) &&
    !/pub fn control_task\s*\(/.test(rustBrowser) &&
    !/pub fn task_control_block_for_action\s*\(/.test(rustBrowser) &&
    !/fn task_control_blocked_response\s*\(/.test(rustBrowser) &&
    !/pub\(crate\) fn resolve_task_id\s*\(/.test(rustBrowser) &&
    !/pub\(crate\) fn find_task_index\s*\(/.test(rustBrowser) &&
    !/pub\(crate\) fn browser_agent_step_summary_for_task\s*\(/.test(rustBrowser),
  "Browser task lifecycle helpers are no longer embedded in shellx_browser.rs",
);
assert(rustBrowser.includes("required_approval_for_action"), "sensitive browser actions are policy-gated");
assert(rustBrowser.includes("BrowserVaultDepositRequest"), "write-only Vault deposit API is modeled");
assert(rustBrowser.includes("BrowserVaultServerReceipt"), "Vault deposit server receipt stays explicit");
assert(rustBrowserModel.includes("fromToken"), "Vault deposit receipt exposes token provenance without secret echo");
assert(rustBrowser.includes("BrowserConsoleLogRequest"), "browser console log ingestion is modeled");
assert(rustBrowserReports.includes("browserConsoleError"), "browser console errors produce receipts");
for (const action of [
  "click",
  "type",
  "scroll",
  "waitFor",
  "select",
  "uploadFile",
  "downloadFile",
  "extractTable",
  "captureScreenshot",
  "verify",
  "fillFromVaultGrant",
  "askUser",
  "bookmarkCurrent",
  "clearHistory",
]) {
  assert(rustBrowser.includes(`"${action}"`), `browser action model covers ${action}`);
}
assert(rustLib.includes("shellx_browser::ShellxBrowserRegistry"), "registry is managed by Tauri");
assert(rustLib.includes("shellx_browser_open_window"), "browser window command is registered");
assert(rustLib.includes("shellx_browser_sync_engine"), "browser engine sync command is registered with Tauri");
assert(rustLib.includes("shellx_browser_clear_history"), "browser clear-history operator command is registered with Tauri");
assert(rustLib.includes("shellx_browser_privacy::shellx_browser_update_privacy"), "browser privacy operator command is registered with Tauri");
assert(rustLib.includes("shellx_browser_shields::shellx_browser_update_shields"), "browser Shields global operator command is registered with Tauri");
assert(rustLib.includes("shellx_browser_shields::shellx_browser_update_site_shields"), "browser Shields site operator command is registered with Tauri");
assert(rustLib.includes("shellx_browser_shields::shellx_browser_remove_site_shields"), "browser Shields remove operator command is registered with Tauri");
assert(rustBrowserPrivacy.includes("browser_privacy_update_requires_operator"), "browser privacy registry updates are operator-gated");
assert(rustBrowserPrivacy.includes("browser_privacy_requires_operator"), "browser privacy module defines the operator-gate error code");
assert(
  rustBrowserPrivacy.includes("impl ShellxBrowserRegistry") &&
    rustBrowserPrivacy.includes("pub fn update_privacy"),
  "Browser privacy registry mutation lives in shellx_browser_privacy.rs",
);
assert(!/pub fn update_privacy\(/.test(rustBrowser), "Browser privacy registry mutation is no longer embedded in shellx_browser.rs");
assert(
  debugApi.includes("BROWSER_PRIVACY_OPERATOR_ERROR_CODE") ||
    debugApiBrowserSettingsSource.includes("BROWSER_PRIVACY_OPERATOR_ERROR_CODE"),
  "debug API rejects Browser privacy mutation",
);
assert(
  browserApiSource.includes("shellx_browser_update_privacy") &&
    uiSource.includes("updateBrowserPrivacy"),
  "browser UI changes privacy through the Tauri operator path",
);
assert(rustBrowserShields.includes("browser_shields_update_requires_operator"), "browser Shields registry updates are operator-gated");
assert(rustBrowserShields.includes("browser_site_shields_remove_requires_operator"), "browser Shields removals are operator-gated");
assert(rustBrowserShields.includes("browser_shields_requires_operator"), "browser Shields module defines the operator-gate error code");
assert(
  rustBrowserShields.includes("impl ShellxBrowserRegistry") &&
    rustBrowserShields.includes("pub fn update_shields") &&
    rustBrowserShields.includes("pub fn update_site_shields") &&
    rustBrowserShields.includes("pub fn remove_site_shields"),
  "Browser Shields registry mutations live in shellx_browser_shields.rs",
);
assert(
  !/pub fn update_shields\(/.test(rustBrowser) &&
    !/pub fn update_site_shields\(/.test(rustBrowser) &&
    !/pub fn remove_site_shields\(/.test(rustBrowser),
  "Browser Shields registry mutations are no longer embedded in shellx_browser.rs",
);
assert(
  debugApi.includes("BROWSER_SHIELDS_OPERATOR_ERROR_CODE") ||
    debugApiBrowserSettingsSource.includes("BROWSER_SHIELDS_OPERATOR_ERROR_CODE"),
  "debug API rejects Browser Shields mutation",
);
assert(
  browserApiSource.includes("shellx_browser_update_shields") &&
    uiSource.includes("updateBrowserShields"),
  "browser UI changes global Shields through the Tauri operator path",
);
assert(
  browserApiSource.includes("shellx_browser_update_site_shields") &&
    uiSource.includes("updateBrowserSiteShields"),
  "browser UI changes site Shields through the Tauri operator path",
);
assert(
  browserApiSource.includes("shellx_browser_remove_site_shields") &&
    uiSource.includes("removeBrowserSiteShields"),
  "browser UI removes site Shields through the Tauri operator path",
);
for (const route of [
  "/browser/state",
  "/browser/tabs",
  "/browser/tabs/open",
  "/browser/tabs/focus",
  "/browser/tabs/reorder",
  "/browser/tabs/close",
  "/browser/tabs/lock",
  "/browser/tabs/heartbeat",
  "/browser/tabs/unlock",
  "/browser/profiles",
  "/browser/tasks",
  "/browser/task/autonomy",
  "/browser/bookmarks",
  "/browser/bookmarks/reorder",
  "/browser/bookmarks/:bookmark_id",
  "/browser/receipts",
  "/browser/privacy",
  "/browser/engine-pool",
  "/browser/shields",
  "/browser/shields/site",
  "/browser/shields/site/:host",
  "/browser/developer-mode",
  "/browser/developer-mode/approval",
  "/browser/downloads",
  "/browser/cdp/execute",
  "/browser/har/export",
  "/browser/performance/export",
  "/browser/recipes/export",
  "/browser/recipes/replay",
  "/browser/robots",
  "/browser/robots/schedule",
  "/browser/robots/run",
  "/browser/robots/cancel",
  "/browser/downloads/request",
  "/browser/uploads",
  "/browser/uploads/request",
  "/browser/downloads/complete",
  "/browser/uploads/complete",
  "/browser/trace/export",
  "/browser/storage-state",
  "/browser/storage-state/export",
  "/browser/session-grants/apply",
  "/browser/dialogs",
  "/browser/dialogs/resolve",
  "/browser/permissions",
  "/browser/permissions/resolve",
  "/browser/popups",
  "/browser/network",
  "/browser/open",
  "/browser/task/start",
  "/browser/task/control",
  "/browser/task/finish",
  "/browser/action",
  "/browser/logs",
  "/browser/vault-deposits",
  "/browser/vault/fill-receipt",
  "/browser/vault/generate-receipt",
  "/browser/session-grants/request",
  "/browser/session-grants/resolve",
  "/browser/report",
]) {
assert(debugApiBrowserRouteSources.some((source) => source.includes(route)), `debug API wires ${route}`);
}
assert(
  browserBookmarksSource.includes("pub(crate) fn default_bookmarks") &&
    browserBookmarksSource.includes("pub(crate) fn browser_bookmark_toolbar") &&
    browserBookmarksSource.includes("pub(crate) fn upsert_browser_bookmark_locked") &&
    browserBookmarksSource.includes("pub(crate) fn validate_browser_bookmark_parent"),
  "Browser bookmark/history behavior lives in shellx_browser_bookmarks.rs",
);
assert(
  browserBookmarksSource.includes("impl ShellxBrowserRegistry") &&
    browserBookmarksSource.includes("pub fn upsert_bookmark") &&
    browserBookmarksSource.includes("pub fn reorder_bookmarks") &&
    browserBookmarksSource.includes("pub fn delete_bookmark") &&
    browserBookmarksSource.includes("pub fn clear_history"),
  "Browser bookmark/history registry mutations live in shellx_browser_bookmarks.rs",
);
assert(
  !/pub fn upsert_bookmark\(/.test(rustBrowser) &&
    !/pub fn reorder_bookmarks\(/.test(rustBrowser) &&
    !/pub fn delete_bookmark\(/.test(rustBrowser) &&
    !/pub fn clear_history\(/.test(rustBrowser),
  "Browser bookmark/history registry mutations are no longer embedded in shellx_browser.rs",
);
assert(
  browserEngineSource.includes("pub struct BrowserEngineActionSlotGuard") &&
    browserEngineSource.includes("pub async fn wait_for_engine_action_slot") &&
    browserEngineSource.includes("pub(crate) fn browser_engine_webview_label") &&
    rustBrowser.includes("crate::shellx_browser_engine"),
  "Browser engine lifecycle and waitlist behavior lives in shellx_browser_engine.rs",
);
assert(
  browserEngineSource.includes("impl ShellxBrowserRegistry") &&
    browserEngineSource.includes("pub fn update_engine_pool"),
  "Browser engine-pool settings mutation lives in shellx_browser_engine.rs",
);
assert(!/pub fn update_engine_pool\(/.test(rustBrowser), "Browser engine-pool settings mutation is no longer embedded in shellx_browser.rs");
assert(
  browserActionsSource.includes("pub(crate) async fn try_apply_engine_action") &&
    browserActionsSource.includes("pub(crate) async fn observe_browser_page") &&
    browserActionsSource.includes("pub(crate) fn classify_sensitive_field") &&
    rustBrowser.includes("crate::shellx_browser_actions"),
  "Browser action, observation, and verification behavior lives in shellx_browser_actions.rs",
);
assert(
  browserTabsSource.includes("impl ShellxBrowserRegistry") &&
    browserTabsSource.includes("pub fn open_tab") &&
    browserTabsSource.includes("pub fn focus_tab") &&
    browserTabsSource.includes("pub fn reorder_tabs") &&
    browserTabsSource.includes("pub fn close_tab") &&
    browserTabsSource.includes("pub fn lock_tab") &&
    browserTabsSource.includes("pub fn heartbeat_tab") &&
    browserTabsSource.includes("pub fn unlock_tab"),
  "Browser tab lifecycle and lock methods live in shellx_browser_tabs.rs",
);
assert(
  rustBrowser.includes("crate::shellx_browser_tabs") &&
    !/pub fn open_tab\(/.test(rustBrowser) &&
    !/pub fn focus_tab\(/.test(rustBrowser) &&
    !/pub fn lock_tab\(/.test(rustBrowser),
  "Browser tab lifecycle methods are no longer embedded in shellx_browser.rs",
);
assert(
  browserSecuritySource.includes("pub(crate) fn normalize_browser_url") &&
    browserSecuritySource.includes("pub(crate) fn validate_browser_navigation_target") &&
    browserSecuritySource.includes("pub(crate) fn browser_url_uses_private_network") &&
    browserSecuritySource.includes("pub(crate) fn classify_browser_page_security") &&
    browserSecuritySource.includes("pub(crate) fn insecure_credential_denial_for_request"),
  "Browser page security and private-network policy live in shellx_browser_security.rs",
);
assert(
  rustBrowser.includes("crate::shellx_browser_security") &&
    !/fn classify_browser_page_security\(/.test(rustBrowser) &&
    !/fn browser_url_uses_private_network\(/.test(rustBrowser) &&
    !/fn insecure_credential_denial_for_request\(/.test(rustBrowser),
  "Browser page security helpers are no longer embedded in shellx_browser.rs",
);
assert(rustLib.includes("mod shellx_browser_robots;"), "browser robot queue module is registered");
assert(
  rustBrowserRobots.includes("pub fn schedule_robot") &&
    rustBrowserRobots.includes("pub fn run_robot") &&
    rustBrowserRobots.includes("pub fn cancel_robot") &&
    rustBrowserRobots.includes("browserRobotScheduled") &&
    rustBrowserRobots.includes("browserRobotRunCompleted") &&
    rustBrowserRobots.includes("browserRobotCancelled"),
  "Browser robot queue behavior lives in shellx_browser_robots.rs",
);
assert(
  !rustBrowser.includes("pub fn schedule_robot") &&
    !rustBrowser.includes("pub fn run_robot") &&
    !rustBrowser.includes("pub fn cancel_robot"),
  "Browser robot queue methods are no longer embedded in shellx_browser.rs",
);
assert(rustLib.includes("mod shellx_browser_artifacts;"), "browser artifact helper module is registered");
assert(
  rustBrowserArtifacts.includes("pub(crate) fn redact_trace_value") &&
    rustBrowserArtifacts.includes("pub(crate) fn redact_trace_receipt") &&
    rustBrowserArtifacts.includes("pub(crate) fn browser_recipe_step_from_receipt") &&
    rustBrowserArtifacts.includes("pub(crate) fn write_browser_json_artifact"),
  "Browser artifact redaction and writer helpers live in shellx_browser_artifacts.rs",
);
assert(
  !rustBrowser.includes("fn redact_trace_value") &&
    !rustBrowser.includes("fn redact_trace_receipt") &&
    !rustBrowser.includes("fn browser_recipe_step_from_receipt") &&
    !rustBrowser.includes("fn write_browser_json_artifact"),
  "Browser artifact helper functions are no longer embedded in shellx_browser.rs",
);
assert(rustLib.includes("mod shellx_browser_storage_state;"), "browser storage-state module is registered");
assert(
  rustBrowserStorageState.includes("pub fn storage_state_manifests") &&
    rustBrowserStorageState.includes("pub fn export_storage_state_manifest") &&
    rustBrowserStorageState.includes("pub(crate) fn browser_storage_state_manifests") &&
    rustBrowserStorageState.includes("browserStorageStateManifestExported"),
  "Browser storage-state manifest and export behavior lives in shellx_browser_storage_state.rs",
);
assert(
  !rustBrowser.includes("pub fn storage_state_manifests") &&
    !rustBrowser.includes("pub fn export_storage_state_manifest") &&
    !rustBrowser.includes("fn browser_storage_state_manifests"),
  "Browser storage-state manifest methods are no longer embedded in shellx_browser.rs",
);
assert(rustLib.includes("mod shellx_browser_recipes;"), "browser recipe module is registered");
assert(
  rustBrowserRecipes.includes("pub fn export_recipe") &&
    rustBrowserRecipes.includes("pub fn replay_recipe_record") &&
    rustBrowserRecipes.includes("browserRecipeExported") &&
    rustBrowserRecipes.includes("browserRecipeReplayCompleted"),
  "Browser recipe export and replay behavior lives in shellx_browser_recipes.rs",
);
assert(
  !rustBrowser.includes("pub fn export_recipe") &&
    !rustBrowser.includes("pub fn replay_recipe_record"),
  "Browser recipe export and replay methods are no longer embedded in shellx_browser.rs",
);
assert(rustLib.includes("mod shellx_browser_diagnostics;"), "browser diagnostics export module is registered");
assert(
  rustBrowserDiagnostics.includes("pub fn export_har") &&
    rustBrowserDiagnostics.includes("pub fn export_performance_artifact") &&
    rustBrowserDiagnostics.includes("pub fn export_trace_bundle") &&
    rustBrowserDiagnostics.includes("browserHarExported") &&
    rustBrowserDiagnostics.includes("browserPerformanceExported") &&
    rustBrowserDiagnostics.includes("browserTraceBundleExported") &&
    rustBrowserDiagnostics.includes("diagnosticsSections"),
  "Browser HAR, performance, and trace export behavior lives in shellx_browser_diagnostics.rs",
);
assert(
  !rustBrowser.includes("pub fn export_har") &&
    !rustBrowser.includes("pub fn export_performance_artifact") &&
    !rustBrowser.includes("pub fn export_trace_bundle"),
  "Browser HAR, performance, and trace export methods are no longer embedded in shellx_browser.rs",
);
assert(
  rustBrowserTransfers.includes("pub fn request_download_intent") &&
    rustBrowserTransfers.includes("pub fn request_upload_intent") &&
    rustBrowserTransfers.includes("pub fn complete_download") &&
    rustBrowserTransfers.includes("pub fn complete_upload") &&
    rustBrowserTransfers.includes("pub fn grant_transfer_for_user") &&
    rustBrowserTransfers.includes("fn complete_transfer") &&
    rustBrowserTransfers.includes("fn validate_transfer_approval") &&
    rustBrowserTransfers.includes("validate_and_consume_transfer_approval") &&
    rustBrowserTransfers.includes("browserDownloadRequested") &&
    rustBrowserTransfers.includes("browserUploadRequested") &&
    rustBrowserTransfers.includes("browserDownloadCompleted") &&
    rustBrowserTransfers.includes("browserUploadCompleted"),
  "Browser transfer request, approval, and completion behavior lives in shellx_browser_transfers.rs",
);
assert(
  rustBrowserIntegrationTests.includes("not-a-host-granted-approval") &&
    rustBrowserIntegrationTests.includes("forged approval denial should not expose filesystem validation ordering"),
  "Browser transfer completion rejects forged approvals before filesystem path checks",
);
assert(
  !rustBrowser.includes("pub fn request_download_intent") &&
    !rustBrowser.includes("pub fn request_upload_intent") &&
    !rustBrowser.includes("pub fn complete_download") &&
    !rustBrowser.includes("pub fn complete_upload") &&
    !rustBrowser.includes("pub fn grant_transfer_for_user") &&
    !rustBrowser.includes("fn complete_transfer") &&
    !rustBrowser.includes("fn validate_and_consume_transfer_approval") &&
    !rustBrowser.includes("fn classify_transfer_content"),
  "Browser transfer methods and transfer-specific helpers are no longer embedded in shellx_browser.rs",
);
assert(rustLib.includes("mod shellx_browser_reports;"), "browser report and console module is registered");
assert(
  rustBrowserReports.includes("pub fn console_logs") &&
    rustBrowserReports.includes("pub fn record_console_log") &&
    rustBrowserReports.includes("pub fn write_report") &&
    rustBrowserReports.includes("fn normalize_console_level") &&
    rustBrowserReports.includes("fn sanitize_console_message") &&
    rustBrowserReports.includes("fn sanitize_console_details") &&
    rustBrowserReports.includes("browserConsoleLog") &&
    rustBrowserReports.includes("browserConsoleError") &&
    rustBrowserReports.includes("browserReportWritten"),
  "Browser report writing and console log behavior lives in shellx_browser_reports.rs",
);
assert(
  !rustBrowser.includes("pub fn console_logs") &&
    !rustBrowser.includes("pub fn record_console_log") &&
    !rustBrowser.includes("pub fn write_report") &&
    !rustBrowser.includes("fn normalize_console_level") &&
    !rustBrowser.includes("fn sanitize_console_message") &&
    !rustBrowser.includes("fn sanitize_console_details"),
  "Browser report and console methods/helpers are no longer embedded in shellx_browser.rs",
);
assert(rustLib.includes("mod shellx_browser_state;"), "browser read-only state module is registered");
assert(
  rustBrowserState.includes("pub fn state") &&
    rustBrowserState.includes("pub fn profiles") &&
    rustBrowserState.includes("pub fn tabs") &&
    rustBrowserState.includes("pub fn privacy") &&
    rustBrowserState.includes("pub fn shields") &&
    rustBrowserState.includes("pub fn developer_mode") &&
    rustBrowserState.includes("pub fn downloads") &&
    rustBrowserState.includes("pub fn uploads") &&
    rustBrowserState.includes("pub fn bookmarks") &&
    rustBrowserState.includes("pub fn bookmark_toolbar") &&
    rustBrowserState.includes("pub fn tasks") &&
    rustBrowserState.includes("pub fn receipts") &&
    rustBrowserState.includes("pub fn dialogs") &&
    rustBrowserState.includes("pub fn permissions") &&
    rustBrowserState.includes("pub fn popups") &&
    rustBrowserState.includes("pub fn network_entries") &&
    rustBrowserState.includes("pub fn robots"),
  "Browser read-only snapshot and list getters live in shellx_browser_state.rs",
);
assert(
  !rustBrowser.includes("pub fn state") &&
    !rustBrowser.includes("pub fn profiles") &&
    !rustBrowser.includes("pub fn tabs") &&
    !rustBrowser.includes("pub fn privacy") &&
    !rustBrowser.includes("pub fn shields") &&
    !rustBrowser.includes("pub fn developer_mode") &&
    !rustBrowser.includes("pub fn downloads") &&
    !rustBrowser.includes("pub fn uploads") &&
    !rustBrowser.includes("pub fn bookmarks") &&
    !rustBrowser.includes("pub fn bookmark_toolbar") &&
    !rustBrowser.includes("pub fn tasks") &&
    !rustBrowser.includes("pub fn receipts") &&
    !rustBrowser.includes("pub fn dialogs") &&
    !rustBrowser.includes("pub fn permissions") &&
    !rustBrowser.includes("pub fn popups") &&
    !rustBrowser.includes("pub fn network_entries") &&
    !rustBrowser.includes("pub fn robots"),
  "Browser read-only snapshot and list getters are no longer embedded in shellx_browser.rs",
);
assert(
  rustBrowserDeveloperMode.includes("pub fn update_developer_mode") &&
    rustBrowserDeveloperMode.includes("pub fn approve_developer_mode_host") &&
    rustBrowserDeveloperMode.includes("pub fn prepare_cdp_execute") &&
    rustBrowserDeveloperMode.includes("pub fn record_cdp_execute_result") &&
    rustBrowserDeveloperMode.includes("browser_protected_values_for_task") &&
    rustBrowserDeveloperMode.includes("redact_browser_json_value") &&
    rustBrowserDeveloperMode.includes("fn cdp_access_denial_for_request") &&
    rustBrowserDeveloperMode.includes("BrowserCdpPreflight") &&
    rustBrowserDeveloperMode.includes("fn developer_mode_host_from_request") &&
    rustBrowserDeveloperMode.includes("browserDeveloperModeChanged") &&
    rustBrowserDeveloperMode.includes("browserCdpAccessRequested") &&
    rustBrowserDeveloperMode.includes("browserCdpCommandExecuted") &&
    rustBrowserDeveloperMode.includes("browserCdpAccessApproved"),
  "Browser Developer Mode mutation and CDP lifecycle behavior lives in shellx_browser_developer_mode.rs",
);
assert(
  !rustBrowser.includes("pub fn update_developer_mode") &&
    !rustBrowser.includes("pub fn approve_developer_mode_host") &&
    !rustBrowser.includes("pub fn prepare_cdp_execute") &&
    !rustBrowser.includes("pub fn record_cdp_execute_result") &&
    !rustBrowser.includes("fn cdp_access_denial_for_request") &&
    !rustBrowser.includes("fn developer_mode_host_from_request"),
  "Browser Developer Mode mutation and CDP lifecycle methods are no longer embedded in shellx_browser.rs",
);
assert(
  debugApi.includes("debug_ui_patch_sensitive_selector_denial") &&
    debugApi.includes("vault-request-action-approve") &&
    debugApi.includes("shellx-browser-vault-prompt-approveSessionGrant") &&
    debugApi.includes("vault-permission-") &&
    debugApi.includes("perm-pill-allow") &&
    debugApi.includes("shellx-browser-personal-lock-overlay-unlock") &&
    debugApi.includes("shellx-browser-save-markdown"),
  "Debug UI relay rejects human-only approval and permission controls before broadcasting synthetic clicks",
);
assert(
  rustBrowserSessionGrants.includes("pub fn request_session_grant") &&
    rustBrowserSessionGrants.includes("pub fn resolve_session_grant") &&
    rustBrowserSessionGrants.includes("pub fn apply_session_grant") &&
    rustBrowserSessionGrants.includes("browserSessionGrantRequested") &&
    rustBrowserSessionGrants.includes("browserSessionGrantGranted") &&
    rustBrowserSessionGrants.includes("browserSessionGrantApplied"),
  "Browser session grant request, resolution, and application behavior lives in shellx_browser_session_grants.rs",
);
assert(
  !rustBrowser.includes("pub fn request_session_grant") &&
    !rustBrowser.includes("pub fn resolve_session_grant") &&
    !rustBrowser.includes("pub fn apply_session_grant"),
  "Browser session grant methods are no longer embedded in shellx_browser.rs",
);
assert(
  rustBrowserPrompts.includes("pub fn record_dialog_event") &&
    rustBrowserPrompts.includes("pub fn resolve_dialog_event") &&
    rustBrowserPrompts.includes("pub fn record_permission_event") &&
    rustBrowserPrompts.includes("pub fn resolve_permission_event") &&
    rustBrowserPrompts.includes("pub fn record_popup_event") &&
    rustBrowserPrompts.includes("pub fn record_network_observed") &&
    rustBrowserPrompts.includes("browserDialogRecorded") &&
    rustBrowserPrompts.includes("browserDialogResolved") &&
    rustBrowserPrompts.includes("browserPermissionRequested") &&
    rustBrowserPrompts.includes("browserPermissionResolved") &&
    rustBrowserPrompts.includes("browserPopupRecorded"),
  "Browser dialog, permission, popup, and network event lifecycle lives in shellx_browser_prompts.rs",
);
assert(
  !rustBrowser.includes("pub fn record_dialog_event") &&
    !rustBrowser.includes("pub fn resolve_dialog_event") &&
    !rustBrowser.includes("pub fn record_permission_event") &&
    !rustBrowser.includes("pub fn resolve_permission_event") &&
    !rustBrowser.includes("pub fn record_popup_event") &&
    !rustBrowser.includes("pub fn record_network_observed"),
  "Browser dialog, permission, popup, and network event lifecycle methods are no longer embedded in shellx_browser.rs",
);
assert(rustLib.includes("mod shellx_browser_vault;"), "browser Vault mediation module is registered");
assert(
  rustBrowserVault.includes("pub fn create_vault_deposit") &&
    browserActionsSource.includes("capture_browser_page_secret_value") &&
    browserScriptsSource.includes("capturePageSecretToVault") &&
    rustBrowserVault.includes("pub fn record_vault_fill_receipt") &&
    rustBrowserVault.includes("pub fn record_profile_card_fill_receipt") &&
    rustBrowserVault.includes("pub fn record_email_code_receipt") &&
    rustBrowserVault.includes("pub fn record_agent_wallet_receipt") &&
    rustBrowserVault.includes("pub fn record_agent_wallet_blocked_receipt") &&
    rustBrowserVault.includes("pub fn record_vault_generate_receipt") &&
    rustBrowserVault.includes("browserVaultDepositCreated") &&
    rustBrowserVault.includes("browserVaultCredentialFilled") &&
    rustBrowserVault.includes("browserVaultPasswordGenerated"),
  "Browser Vault deposit and mediated credential receipt behavior lives in shellx_browser_vault.rs",
);
assert(
  debugApi.includes("capturePageSecretToVault") &&
    debugApi.includes("capture_browser_page_secret_value") &&
    debugApi.includes("compat_set_with_description(&secret_ref") &&
    debugApi.includes("\"secretExposed\": false"),
  "Browser can capture page-visible generated secrets directly into Vault without returning raw secret text",
);
assert(
  !rustBrowser.includes("pub fn create_vault_deposit") &&
    !rustBrowser.includes("pub fn record_vault_fill_receipt") &&
    !rustBrowser.includes("pub fn record_profile_card_fill_receipt") &&
    !rustBrowser.includes("pub fn record_email_code_receipt") &&
    !rustBrowser.includes("pub fn record_agent_wallet_receipt") &&
    !rustBrowser.includes("pub fn record_agent_wallet_blocked_receipt") &&
    !rustBrowser.includes("pub fn record_vault_generate_receipt") &&
    !rustBrowser.includes("fn record_vault_credential_receipt"),
  "Browser Vault deposit and credential receipt methods are no longer embedded in shellx_browser.rs",
);
assert(
  rustBrowserVault.includes("pub async fn shellx_browser_open_vault_panel") &&
    rustBrowserVault.includes("pub fn prepare_vault_grant_fill_action") &&
    rustBrowserVault.includes("pub fn prepare_profile_card_fill_action") &&
    rustBrowserVault.includes("SHELLX_OPEN_VAULT_PANEL_EVENT"),
  "Browser Vault bridge helpers live in shellx_browser_vault.rs",
);
assert(
  !/fn emit_open_vault_panel\s*\(/.test(rustBrowser) &&
    !/pub fn prepare_vault_grant_fill_action\s*\(/.test(rustBrowser) &&
    !/pub fn prepare_profile_card_fill_action\s*\(/.test(rustBrowser),
  "Browser Vault bridge helpers are no longer embedded in shellx_browser.rs",
);
assert(debugApi.includes("\"browser-event\""), "debug API emits browser-event frames");
assert(debugApi.includes("emit_browser_latest"), "taskless browser grant routes still emit latest receipts");
assert(
  rustLib.includes("mod debug_api_browser") &&
    debugApi.includes("debug_api_browser::") &&
    debugApiBrowserStateSource.includes("/browser/state") &&
    debugApiBrowser.includes("/browser/action") &&
    debugApiBrowser.includes("browser_privacy_requires_operator") &&
    debugApiBrowser.includes("browser_shields_requires_operator") &&
    debugApiBrowser.includes("browser_session_grant_resolution_requires_operator"),
  "Browser Debug API routes are isolated without weakening operator gates",
);
assert(
  debugApiBrowserStateSource.includes("pub(crate) async fn browser_state_http") &&
    debugApiBrowserStateSource.includes("pub(crate) async fn browser_tab_open_http") &&
    debugApiBrowserStateSource.includes("pub(crate) async fn browser_task_start_http") &&
    debugApiBrowser.includes("debug_api_browser_state::browser_state_routes()"),
  "Browser Debug API state/tab/task handlers live in a focused route module",
);
assert(
  !debugApi.includes("pub(crate) async fn browser_state_http") &&
    !debugApi.includes("pub(crate) async fn browser_tab_open_http") &&
    !debugApi.includes("pub(crate) async fn browser_task_start_http"),
  "Browser Debug API state/tab/task handlers are no longer embedded in debug_api.rs",
);
assert(
  debugApiBrowserSettingsSource.includes("pub(crate) async fn browser_bookmarks_http") &&
    debugApiBrowserSettingsSource.includes("pub(crate) async fn browser_shields_post_http") &&
    debugApiBrowserSettingsSource.includes("pub(crate) async fn browser_developer_mode_post_http") &&
    debugApiBrowser.includes("debug_api_browser_settings::browser_settings_routes()"),
  "Browser Debug API bookmarks/privacy/Shields/developer handlers live in a focused route module",
);
assert(
  !debugApi.includes("pub(crate) async fn browser_bookmarks_http") &&
    !debugApi.includes("pub(crate) async fn browser_shields_post_http") &&
    !debugApi.includes("pub(crate) async fn browser_developer_mode_post_http"),
  "Browser Debug API settings handlers are no longer embedded in debug_api.rs",
);
assert(
  debugApiBrowserArtifactsSource.includes("pub(crate) async fn browser_trace_export_http") &&
    debugApiBrowserArtifactsSource.includes("pub(crate) async fn browser_cdp_execute_http") &&
    debugApiBrowserArtifactsSource.includes("pub(crate) async fn browser_robot_schedule_http") &&
    debugApiBrowserArtifactsSource.includes("pub(crate) async fn browser_download_request_http") &&
    debugApiBrowser.includes("debug_api_browser_artifacts::browser_artifact_routes()"),
  "Browser Debug API artifact/devtools/robot/transfer handlers live in a focused route module",
);
assert(
  !debugApi.includes("pub(crate) async fn browser_trace_export_http") &&
    !debugApi.includes("pub(crate) async fn browser_cdp_execute_http") &&
    !debugApi.includes("pub(crate) async fn browser_robot_schedule_http") &&
    !debugApi.includes("pub(crate) async fn browser_download_request_http"),
  "Browser Debug API artifact/devtools/robot/transfer handlers are no longer embedded in debug_api.rs",
);
assert(
  debugApiBrowserSecuritySource.includes("pub(crate) async fn browser_dialog_resolve_http") &&
    debugApiBrowserSecuritySource.includes("pub(crate) async fn browser_permission_resolve_http") &&
    debugApiBrowserSecuritySource.includes("pub(crate) async fn browser_session_grant_resolve_http") &&
    debugApiBrowserSecuritySource.includes("pub(crate) async fn browser_vault_deposit_http") &&
    debugApiBrowser.includes("debug_api_browser_security::browser_security_routes()"),
  "Browser Debug API dialog/permission/Vault-grant handlers live in a focused route module",
);
assert(
  !debugApi.includes("pub(crate) async fn browser_dialog_resolve_http") &&
    !debugApi.includes("pub(crate) async fn browser_permission_resolve_http") &&
    !debugApi.includes("pub(crate) async fn browser_session_grant_resolve_http") &&
    !debugApi.includes("pub(crate) async fn browser_vault_deposit_http"),
  "Browser Debug API dialog/permission/Vault-grant handlers are no longer embedded in debug_api.rs",
);
assert(mainSource.includes("ShellxBrowserApp"), "renderer can boot the browser window app");
assert(browserChromeSource.includes('ShellIcon name="browser-orbit" size={18}'), "browser chrome brand uses the Browser orbit glyph");
assert(
  browserApiSource.includes("browserApiGet") &&
    browserApiSource.includes("browserApiPostJson") &&
    browserApiSource.includes("browserApiDeleteJson"),
  "browser frontend API facade owns Debug API wrappers",
);
assert(
  browserApiSource.includes("shellx_browser_sync_engine") &&
    browserApiSource.includes("shellx_browser_update_privacy") &&
    browserApiSource.includes("shellx_browser_update_shields") &&
    browserApiSource.includes("shellx_browser_update_site_shields") &&
    browserApiSource.includes("shellx_browser_remove_site_shields"),
  "browser frontend API facade owns operator Tauri commands",
);
assert(
  !uiSource.includes("../lib/debug-api") &&
    !uiSource.includes("@tauri-apps/api/core"),
  "browser component uses browser API facade instead of raw transports",
);
assert(
  uiSource.includes("DebugHighlightOverlay") &&
    browserStateHookSource.includes("browserDebugApiBase") &&
    browserStateHookSource.includes("getBrowserDebugToken") &&
    browserApiSource.includes("debugApiBase") &&
    browserApiSource.includes("getDebugToken"),
  "browser renderer can join authenticated debug UI events",
);
assert(uiSource.includes("runBrowserDebugClickSelector") && uiSource.includes("runBrowserDebugInputSelector") && uiSource.includes("runBrowserDebugDragSelector"), "browser renderer exposes debug selector click/input/drag commands");
assert(browserDebugBridgeSource.includes("body.blur === true") && browserDebugBridgeSource.includes("element.blur()"), "browser renderer debug input can blur fields to commit edits");
assert(
  debugApi.includes("pub debug_surface: Option<String>") &&
    appSource.includes('normalizeDebugSurface(p.debugSurface) === "browser"') &&
    browserStateHookSource.includes('if (debugSurface && debugSurface !== "browser") return'),
  "browser renderer debug commands are scoped away from the main ShellX window",
);
assert(
  appSource.includes('debugUiPatchSource(payload?.patch) === "renderer"') &&
    appSource.includes('source === "renderer" || source.includes("browser")'),
  "main ShellX window ignores Browser/renderer debug state so it cannot overwrite Browser highlight results",
);
assert(browserStateHookSource.includes("normalizeBrowserRightTabPatch") && browserStateHookSource.includes("onRightPanelPatch(rightTabPatch)"), "browser renderer maps debug rightTab patches to Browser panel tabs");
assert(
  browserStateHookSource.includes("sameBrowserDebugHighlights") &&
    uiSource.includes('<DebugHighlightOverlay surface="browser" highlights={debugHighlights} />') &&
    debugApi.includes("debug_highlight_results_by_surface"),
  "browser renderer can report visible chrome selectors through debug highlights",
);
assert(
  uiSource.includes(".shellx-browser-left-sidecar") &&
    uiSource.includes("shellx-browser-header-menu-wrap") &&
    uiSource.includes("setHeaderMenu(null)"),
  "browser left sidecars stay open while users click inside them",
);
assert(browserChromeSource.includes("<span>Agent</span>"), "browser chrome presents the window as Agent");
assert(!browserChromeSource.includes("<span>ShellX Browser</span>"), "browser chrome removes the old ShellX Browser title text");
assert(browserChromeSource.indexOf("className=\"shellx-browser-tab-strip\"") < browserChromeSource.indexOf("className=\"shellx-browser-address-row\""), "browser tabs sit above the active-tab address toolbar");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-address\""), "browser UI address bar has debug id");
assert(
  uiSource.includes("const addressSourceUrl =") &&
    uiSource.includes("state?.engine?.url?.trim()") &&
    uiSource.includes("setAddress(addressSourceUrl)") &&
    uiSource.includes("[addressSourceUrl, addressEditing]"),
  "browser address bar syncs to active engine/tab URL after native Browser navigation",
);
assert(
  uiSource.includes("activeTaskForActiveTab") &&
    uiSource.includes("activeBrowserTab?.taskId === activeTask?.taskId") &&
    uiSource.includes("if (activeTaskForActiveTab)"),
  "browser address navigation only targets an agent task when the active tab belongs to that task",
);
assert(
  browserChromeSource.includes("onFocus={() => onSetAddressEditing(true)}") &&
    browserChromeSource.includes("onBlur={() => onSetAddressEditing(false)}"),
  "browser address bar preserves user edits while focused",
);
assert(!uiSource.includes("data-debug-id=\"shellx-browser-go\""), "browser UI relies on Enter/navigation API instead of a visible Go button");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-home\""), "browser UI exposes a homepage button before the address bar");
assert(browserMenusSource.includes("data-debug-id=\"shellx-browser-homepage\""), "browser settings expose homepage configuration");
assert(uiSource.includes("HOME_URL_STORAGE_KEY"), "browser homepage setting is persisted locally");
assert(browserChromeSource.indexOf("data-debug-id=\"shellx-browser-home\"") < browserChromeSource.indexOf("data-debug-id=\"shellx-browser-address\""), "browser homepage button is before the address bar");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-copy-address\""), "browser UI can copy the current address from the address bar");
assert(browserChromeSource.includes("className=\"shellx-browser-address-copy\""), "browser UI styles address copy like an inline code action");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-console\""), "browser UI exposes console log panel");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-options\""), "browser UI exposes options panel toggle");
assert(
  uiSource.includes("shellx-browser-header-menu-wrap") &&
    uiSource.includes("shellx-browser-options-wrap") &&
    uiSource.includes("shellx-browser-chrome-menu-dock") &&
    uiSource.includes("shellx-browser-left-sidecar") &&
    uiSource.includes("shellx-browser-shields-wrap"),
  "browser menus stay open when interacting with Shields, docked chrome panels, and left sidecars",
);
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-tab-strip\""), "browser UI exposes tab strip");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-new-tab\""), "browser UI exposes new tab action");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-new-disposable-tab\""), "browser UI exposes a new disposable tab action");
assert(
  uiSource.includes("canUseHistoryControls={Boolean(activeBrowserTab)}") &&
    browserChromeSource.includes("canUseHistoryControls") &&
    !browserChromeSource.includes("canUseTaskHistory"),
  "browser Back/Forward/Reload controls are available for normal user tabs, not only agent tasks",
);
assert(
  !/const runAction = \(action: string\) => \{\s*if \(!activeTask\) return;/.test(uiSource) &&
    uiSource.includes('...(activeTaskForActiveTab ? { taskId: activeTaskForActiveTab.taskId } : {})'),
  "browser toolbar actions dispatch against the active tab even when no agent task is active",
);
assert(browserChromeSource.includes('data-debug-id="shellx-browser-bookmark-current"') && browserChromeSource.indexOf('data-debug-id="shellx-browser-bookmark-current"') < browserChromeSource.indexOf('data-debug-id="shellx-browser-bookmarks-menu"'), "browser bookmark-current star appears before bookmark menu");
assert(browserChromeSource.includes('ShellIcon name="star"'), "browser bookmark-current uses a star icon");
assert(browserChromeSource.includes('data-debug-id="shellx-browser-ad-filter"'), "browser header exposes ad filter control");
assert(browserMenusSource.includes('data-debug-id="shellx-browser-ad-mode-balanced"'), "browser ad filter menu exposes balanced mode");
assert(browserMenusSource.includes('data-debug-id="shellx-browser-ad-mode-strict"'), "browser ad filter menu exposes strict mode");
assert(browserMenusSource.includes('data-debug-id="shellx-browser-ad-mode-off"'), "browser ad filter menu exposes off mode");
assert(!browserMenusSource.includes('data-debug-id="shellx-browser-ad-mode-visual-clean"'), "browser ad filter menu hides legacy visual clean mode");
assert(browserTypesSource.includes("type BrowserVisibleAdMode = Exclude<BrowserAdMode, \"visualCleanCompatibility\">"), "browser UI normalizes legacy visual clean state into the three visible modes");
assert(cssSource.includes(".shellx-browser-ad-popover .shellx-browser-menu-row small") && cssSource.includes("white-space: normal"), "browser ad filter descriptions wrap instead of clipping");
assert(browserChromeSource.includes('ShellIcon name="circle-x"'), "browser disposable tab uses a distinct disposable icon");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-lock-tab\""), "browser UI exposes lock tab action");
assert(browserChromeSource.includes("Lock tab for this agent"), "browser lock tab tooltip explains its agent lease purpose");
assert(browserChromeSource.includes('data-debug-id="shellx-browser-personal-lock-toggle"'), "browser UI always exposes Personal Browser Lock action");
assert(browserChromeSource.includes("const personalLockState") && browserChromeSource.includes("data-lock-state={personalLockState}"), "browser Personal Lock action exposes configured/locked state");
assert(
  browserChromeSource.includes("const personalLockLocked = personalLockEnabled && personalLock?.locked === true") &&
    browserChromeSource.includes('onPersonalLockAction(personalLockLocked ? "unlock" : "lockNow", undefined, event)'),
  "browser Personal Lock button reflects the global lock state, not only the active personal tab overlay",
);
assert(
  browserChromeSource.includes("disabled={personalLockEnabled && busy && !personalLockLocked}"),
  "browser Personal Lock button remains available for unlock while the engine is busy",
);
assert(browserChromeSource.includes("shellx-browser-personal-lock-btn") && browserChromeSource.includes("personalLockAttention"), "browser Personal Lock action has state styling and attention focus");
assert(browserChromeSource.includes("Set up Personal Browser Lock"), "browser Personal Lock action opens setup when unconfigured");
assert(uiSource.includes("showPersonalLockBlockedNotice") && uiSource.includes("shellx-browser-personal-lock-notice") && uiSource.includes("Personal Browser Lock is on."), "browser locked personal-tab actions show a structured unlock notice");
assert(uiSource.includes("focusPersonalLockToggle") && uiSource.includes("document.querySelector<HTMLButtonElement>") && uiSource.includes("?.focus()"), "browser locked personal-tab actions focus the lock control");
assert(uiSource.includes("vaultFillError") && uiSource.includes("shellx-browser-vault-fill-unavailable"), "browser Vault fill surfaces locked/unavailable Vault state instead of silently showing no matches");
assert(uiSource.includes("window.setInterval(refreshVaultFillEntries, 8_000)"), "browser Vault fill periodically refreshes saved-secret metadata after Vault unlock");
assert(
  uiSource.includes("pageEmailsForVaultFill") &&
    uiSource.includes("pageContextTokensForVaultFill") &&
    uiSource.includes("providerTokensForVaultFillText") &&
    uiSource.includes("vaultFillAccountScore") &&
    uiSource.includes("entry.resourceFields") &&
    uiSource.includes("emailAddressesForVaultFill"),
  "browser Vault fill matches saved email/password credentials by page account metadata, provider fields, page provider hints, and host hints",
);
assert(
  uiSource.includes('part !== "www" && /[a-z]/.test(part)'),
  "browser Vault fill ignores numeric host parts so localhost fixtures do not block provider-context password suggestions",
);
assert(
  uiSource.includes("vaultFillPasswordFallbackAllowed") &&
    uiSource.includes("Possible Vault password") &&
    uiSource.includes("fallbackCandidates") &&
    uiSource.includes("candidates.length > 0 ? candidates : fallbackCandidates"),
  "browser Vault fill falls back to generic non-token secrets for direct user password fills when metadata is sparse",
);
assert(browserChromeSource.includes("shellx-browser-handoff-tab"), "browser UI exposes handoff-to-agent action");
assert(browserChromeSource.includes("shellx-browser-take-back-tab"), "browser UI exposes takeback action for delegated tabs");
assert(browserMenusSource.includes("shellx-browser-personal-lock-sleep"), "browser options expose lock-after-sleep control");
assert(browserMenusSource.includes("shellx-browser-personal-lock-minimize"), "browser options expose lock-on-minimize control");
assert(uiSource.includes("isMinimized()"), "browser personal lock can react to minimized desktop windows");
assert(uiSource.includes("driftMs < 120_000"), "browser personal lock can react to resume-after-sleep timer drift");
assert(browserChromeSource.includes("shellx-browser-close-tab-"), "browser UI exposes per-tab close actions");
assert(browserChromeSource.includes("className=\"shellx-browser-tab-close\""), "browser UI has a dedicated tab close hit target");
assert(browserChromeSource.includes("shellx-browser-tab-profile-marker"), "browser tabs carry compact profile markers");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-trust-chip\""), "browser UI exposes a compact trust chip");
assert(browserChromeSource.includes("browserTrustLabel(activeSecurityState)"), "browser trust chip renders the active security label");
assert(
  browserShieldsPanelSource.includes('data-debug-id="shellx-browser-shields-panel"') &&
    uiSource.includes("<BrowserShieldsPanel"),
  "browser UI exposes the Shields panel",
);
assert(
  browserChromeSource.includes('const shieldsPanel = headerMenu === "shields" ? chromeMenuPanel : null;') &&
    browserChromeSource.includes('const dockedChromeMenuPanel = headerMenu === "shields" ? null : chromeMenuPanel;') &&
    browserChromeSource.includes("{shieldsPanel}") &&
    !browserShieldsPanelSource.includes("shellx-browser-docked-popover"),
  "browser Shields panel is anchored to the trust chip instead of the shared chrome dock",
);
assert(
  browserShieldsPanelSource.includes('data-debug-id="shellx-browser-site-shields-save"') &&
    uiSource.includes("onSaveSite={saveSiteShields}"),
  "browser UI can save per-site Shields",
);
assert(
  browserShieldsPanelSource.includes('data-debug-id="shellx-browser-shields-panel"') &&
    browserShieldsPanelSource.includes('data-debug-id="shellx-browser-shields-global-enabled"') &&
    browserShieldsPanelSource.includes('data-debug-id="shellx-browser-site-shields-ad-trackers"') &&
    browserShieldsPanelSource.includes('data-debug-id="shellx-browser-site-shields-script-blocking"') &&
    browserShieldsPanelSource.includes('data-debug-id="shellx-browser-site-shields-save"') &&
    browserShieldsPanelSource.includes('data-debug-id="shellx-browser-site-shields-reset"') &&
    uiSource.includes("<BrowserShieldsPanel"),
  "browser Shields panel is extracted behind a stable component boundary",
);
assert(
  browserMenusSource.includes("BrowserOptionsMenu") &&
    browserMenusSource.includes("BrowserPageSaveMenu") &&
    browserMenusSource.includes("BrowserAdFilterMenu") &&
    uiSource.includes("<BrowserOptionsMenu") &&
    uiSource.includes("<BrowserPageSaveMenu") &&
    uiSource.includes("<BrowserAdFilterMenu"),
  "browser header menus are extracted behind stable component boundaries",
);
assert(
  browserMenusSource.includes('data-debug-id="shellx-browser-color-mode"') &&
    browserMenusSource.includes('data-debug-id="shellx-browser-homepage"') &&
    browserHistorySidecarSource.includes('data-debug-id="shellx-browser-history-user"') &&
    browserHistorySidecarSource.includes('data-debug-id="shellx-browser-history-agent"'),
  "browser extracted header menus keep debug ids stable",
);
assert(
  browserHistorySidecarSource.includes("BrowserHistorySidecar") &&
    browserHistorySidecarSource.includes('data-debug-id="shellx-browser-history-sidecar"') &&
    browserHistorySidecarSource.includes('data-debug-id="shellx-browser-history-search"') &&
    browserHistorySidecarSource.includes('data-debug-id="shellx-browser-history-date-filter"') &&
    browserHistorySidecarSource.includes('data-debug-id="shellx-browser-history-list"') &&
    uiSource.includes("<BrowserHistorySidecar"),
  "browser history opens as a searchable left sidecar instead of a narrow header menu",
);
assert(
  bookmarkSidecarSource.includes("BookmarkSidecar") &&
    bookmarkSidecarSource.includes("BookmarkToolbar") &&
    bookmarkSidecarSource.includes('data-debug-id="shellx-browser-bookmark-toolbar"') &&
    bookmarkSidecarSource.includes("shellx-browser-bookmark-sidecar") &&
    bookmarkSidecarSource.includes("shellx-browser-bookmark-drag-") &&
    uiSource.includes("<BookmarkSidecar") &&
    uiSource.includes("<BookmarkToolbar"),
  "browser bookmarks are extracted behind sidecar and toolbar component boundaries",
);
assert(
  bookmarkSidecarSource.includes('data-bookmark-folder-target-id={bookmark.kind === "folder" ? bookmark.bookmarkId : undefined}') &&
    bookmarkSidecarSource.includes("onPointerDown") &&
    bookmarkSidecarSource.includes("onDragStart"),
  "browser extracted bookmarks keep drag/drop targets and pointer sorting",
);
assert(
  browserChromeSource.includes("BrowserChrome") &&
    browserChromeSource.includes('ShellIcon name="browser-orbit" size={18}') &&
    browserChromeSource.includes('data-debug-id="shellx-browser-tab-strip"') &&
    browserChromeSource.includes('data-debug-id="shellx-browser-address"') &&
    browserChromeSource.includes('data-debug-id="shellx-browser-trust-chip"') &&
    browserChromeSource.includes('data-debug-id="shellx-browser-new-tab"') &&
    browserChromeSource.includes('data-debug-id="shellx-browser-options"') &&
    uiSource.includes("<BrowserChrome"),
  "browser chrome is extracted behind a stable component boundary",
);
assert(
  nativeEngineSyncSource.includes("useNativeEngineSync") &&
    nativeEngineSyncSource.includes("ResizeObserver") &&
    nativeEngineSyncSource.includes("syncBrowserEngine") &&
    nativeEngineSyncSource.includes("retry sync shortly") &&
    uiSource.includes("useNativeEngineSync"),
  "browser native engine sync is isolated in a hook",
);
assert(
  browserEngineRuntimeSource.includes("SetAreDefaultContextMenusEnabled(false)") &&
    browserEngineRuntimeSource.includes("NewWindowRequestedEventHandler") &&
    browserEngineRuntimeSource.includes("open_tab(") &&
    browserEngineRuntimeSource.includes("BrowserTabOpenRequest") &&
    browserEngineRuntimeSource.includes("browser_page_context_menu_initialization_script"),
  "Browser native page context menu uses ShellX tab semantics instead of unsupported new-window behavior",
);
assert(
  browserEngineRuntimeSource.includes("Open link in new tab") &&
    browserEngineRuntimeSource.includes("data-shellx-browser-context-menu") &&
    !browserEngineRuntimeSource.includes("Open link in new window"),
  "Browser injected page context menu offers Open link in new tab and avoids new-window wording",
);
assert(
  browserStateHookSource.includes("useBrowserState") &&
    browserStateHookSource.includes("browserApiGet<BrowserState>") &&
    browserStateHookSource.includes("browserDebugApiBase") &&
    browserStateHookSource.includes("getBrowserDebugToken") &&
    browserStateHookSource.includes("debug-ui-state-patch") &&
    uiSource.includes("useBrowserState"),
  "browser state polling and debug event hydration are isolated in a hook",
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
    agentSidebarSource.includes('data-debug-id="shellx-browser-autonomy"') &&
    agentSidebarSource.includes('data-debug-id="shellx-browser-goal"') &&
    agentSidebarSource.includes('data-debug-id="shellx-browser-agent-pause"') &&
    agentSidebarSource.includes('data-debug-id="shellx-browser-agent-resume"') &&
    agentSidebarSource.includes('data-debug-id="shellx-browser-agent-abort"') &&
    agentSidebarSource.includes('data-debug-id="shellx-browser-agent-takeover"') &&
    uiSource.includes("<AgentSidebar"),
  "browser Agent sidebar is extracted behind a stable component boundary",
);
assert(rustBrowserModel.includes("BrowserTaskAutonomyUpdateRequest"), "Browser models active task autonomy updates");
assert(browserTasksSource.includes("update_task_autonomy") && browserTasksSource.includes("browserTaskAutonomyUpdated"), "Browser backend updates active task autonomy with a receipt");
assert(debugApiBrowserStateSource.includes("/browser/task/autonomy"), "Debug API exposes Browser task autonomy updates");
assert(browserApiSource.includes("shellx_browser_update_task_autonomy") && uiSource.includes("updateBrowserTaskAutonomy"), "Browser UI calls the active task autonomy update command");
assert(uiSource.includes("const displayedAutonomy = activeTask?.autonomy ?? autonomy") && uiSource.includes("onAutonomyChange={setTaskAutonomy}"), "Browser autonomy selector reflects and mutates the active task when present");
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
assert(bookmarkSidecarSource.includes("data-debug-id=\"shellx-browser-bookmark-toolbar\""), "Browser renders a bookmark toolbar");
assert(bookmarkSidecarSource.includes("data-debug-id=\"shellx-browser-bookmark-manager\""), "Browser exposes a bookmark manager");
assert(bookmarkSidecarSource.includes("shellx-browser-bookmark-manager-dock"), "Browser bookmark manager lives outside native page overlay");
assert(bookmarkSidecarSource.includes("shellx-browser-bookmark-folder-menu"), "Browser toolbar folders open as menus");
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
assert(uiSource.includes('parentId: bookmarkDraftParentId || null') && !uiSource.includes('kind: "folder",\n        toolbarPinned: true'), "browser new folders follow the selected location and do not auto-pin to the toolbar");
assert(!uiSource.includes("toolbarPinned: !bookmarkDraftParentId"), "browser new links do not auto-pin to the toolbar");
assert(bookmarkSidecarSource.includes("shellx-browser-bookmark-icon-action"), "browser bookmark manager uses compact icon actions");
assert(bookmarkSidecarSource.includes("data-debug-id={`shellx-browser-bookmark-drag-${bookmark.bookmarkId}`}"), "browser bookmark manager exposes a dedicated drag handle per row");
assert(uiSource.includes("startBookmarkPointerDrag"), "browser bookmark manager supports pointer drag sorting from the visible handle");
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
assert(browserMenusSource.includes("data-debug-id=\"shellx-browser-engine-mode\""), "browser UI exposes engine mode option");
assert(browserMenusSource.includes("data-debug-id=\"shellx-browser-parallel-agents\""), "browser UI exposes parallel agent capacity option");
assert(browserHistorySidecarSource.includes("data-debug-id=\"shellx-browser-clear-history\""), "browser UI exposes clear-history action");
assert(uiSource.includes("shellx-browser-color-mode"), "browser UI stores local color mode preference");
assert(
  browserApiSource.includes("shellx_browser_clear_history") &&
    uiSource.includes("clearBrowserHistoryCommand"),
  "browser UI can call the local clear-history command",
);
assert(browserMenusSource.includes("data-debug-id=\"shellx-browser-toggle-right-sidebar\""), "browser UI can hide the right sidebar");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-toggle-right-sidebar-button\""), "browser UI exposes visible right sidebar toggle");
assert(uiSource.includes("historySidecarOpen") && cssSource.includes(".shellx-browser-left-sidecar"), "browser UI supports a left sidecar surface for long lists");
assert(agentSidebarSource.includes("className=\"shellx-browser-panel-toggle shellx-browser-panel-toggle-right\""), "right sidebar hide control lives on the right panel edge");
assert(
  agentSidebarSource.indexOf("data-debug-id=\"shellx-browser-toggle-right-sidebar-button\"") <
    agentSidebarSource.indexOf("data-debug-id=\"shellx-browser-autonomy\"") &&
    agentSidebarSource.indexOf("data-debug-id=\"shellx-browser-autonomy\"") < agentSidebarSource.indexOf("className=\"shellx-browser-right-tabs\""),
  "browser autonomy control sits after the right-panel collapse button before panel tabs",
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
assert(agentSidebarSource.includes("className=\"shellx-browser-sidebar-autonomy\""), "browser autonomy control lives in the sidebar chrome");
assert(agentSidebarSource.indexOf("data-debug-id=\"shellx-browser-autonomy\"") < agentSidebarSource.indexOf("className=\"shellx-browser-agent-compose\""), "browser Agent autonomy control is not inside the message composer");
assert(uiSource.includes('const [profileId, setProfileId] = useState(USER_DEFAULT_PROFILE_ID)'), "browser user-opened tabs default to the personal profile");
assert(uiSource.includes('const USER_DEFAULT_PROFILE_ID = "personal"'), "browser normal navigation has an explicit user-default profile");
assert(uiSource.includes('const taskProfileId = profileId === USER_DEFAULT_PROFILE_ID ? AGENT_DEFAULT_PROFILE_ID : profileId'), "browser chat tasks switch personal selection to the agent profile");
assert(
  browserTaskIntentSource.includes("inferBrowserTaskStartUrl") &&
    browserTaskIntentSource.includes("https://www.google.com/search") &&
    uiSource.includes("inferBrowserTaskStartUrl(taskGoal, address.trim())") &&
    !uiSource.includes("startUrl: address.trim() || null"),
  "browser chat infers explicit open/search intents instead of cloning the current address",
);
assert(uiSource.includes('const newTab = (nextProfileId = USER_DEFAULT_PROFILE_ID)'), "browser normal new tabs default to user profile");
assert(
  uiSource.includes('const newTabUrl = homeUrl.trim() || DEFAULT_HOME_URL') &&
    uiSource.includes("url: newTabUrl") &&
    !uiSource.includes("url: address.trim() || null"),
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
assert(uiSource.includes("function safeBrowserStatusUrl"), "browser UI has a safe URL formatter for agent-facing status text");
assert(uiSource.includes("parsed.search = \"\"") && uiSource.includes("parsed.hash = \"\""), "browser UI strips query and fragment before rendering agent-facing status URLs");
assert(uiSource.includes("safeBrowserStatusUrl(activeTask.currentUrl ?? state?.engine?.url ?? activeBrowserTab?.url ?? address.trim())"), "browser Agent chat uses safe current-page URLs");
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
assert(browserMenusSource.includes("shellx-browser-explain-page"), "browser page save menu includes page explain action");
assert(browserMenusSource.includes("shellx-browser-save-media"), "browser page save menu includes media save");
assert(browserMenusSource.includes("shellx-browser-save-code"), "browser page save menu includes code save");
assert(browserMenusSource.includes("shellx-browser-save-site"), "browser page save menu includes whole-site save intent");
assert(downloadSidecarSource.includes("data-debug-id=\"shellx-browser-download-sidecar\""), "browser Downloads manager opens as a left sidecar");
assert(downloadSidecarSource.includes("data-debug-id=\"shellx-browser-download-folder\""), "browser Downloads manager exposes default folder setting");
assert(downloadSidecarSource.includes("data-debug-id=\"shellx-browser-download-list\""), "browser Downloads manager shows transfer rows");
assert(downloadSidecarSource.includes("transferStatusLabel") && downloadSidecarSource.includes("\"Queued\"") && downloadSidecarSource.includes("\"Saved\""), "browser Downloads manager uses user-facing status labels");
assert(settingsSource.includes("browserDownloadFolder") && generalTabSource.includes("settings-browser-download-folder"), "global Settings expose Browser default download folder");
assert(generalTabSource.includes("onInput={(event) => patchBrowserDownloadFolder(event.currentTarget.value)}"), "global Settings Browser download folder works with debug input events");
assert(debugApi.includes("\"browserDownloadFolder\""), "Debug API settings persist Browser default download folder");
assert(uiSource.includes("readSettingsLocal") && uiSource.includes("persistSettings(next)") && uiSource.includes("browserDownloadFolder"), "browser Downloads sidecar uses the shared Settings download folder");
assert(uiSource.includes("destinationDir: defaultDownloadFolder.trim()"), "browser page save carries the configured download folder");
assert(uiSource.includes("grantBrowserTransfer") && uiSource.includes("/browser/downloads/complete"), "browser user-initiated local page saves complete download rows");
assert(uiSource.includes("writeBrowserTextArtifact") && uiSource.includes("copyBrowserLocalArtifact"), "browser local page saves write artifacts through operator-owned Tauri commands");
assert(
  uiSource.includes("browserExplainGoal") &&
    uiSource.includes("boundedBrowserExplainExcerpt") &&
    uiSource.includes("requestExplainPage") &&
    uiSource.includes("safeStartUrl.startsWith(\"about:\")") &&
    uiSource.includes("setRightPanelTab(\"chat\")"),
  "browser explain action starts a bounded sanitized Browser task in the chat panel",
);
assert(browserApiSource.includes("shellx_browser_write_text_artifact") && browserApiSource.includes("shellx_browser_copy_local_artifact"), "browser API exposes local artifact write/copy commands");
assert(rustLib.includes("shellx_browser_transfers::shellx_browser_write_text_artifact"), "browser text artifact command is registered with Tauri");
assert(rustLib.includes("shellx_browser_transfers::shellx_browser_copy_local_artifact"), "browser local artifact copy command is registered with Tauri");
assert(rustBrowserTransfers.includes("sanitized_download_file_name") && rustBrowserTransfers.includes("unique_destination_path"), "browser local artifact writes sanitize filenames and avoid collisions");
assert(rustBrowserTransfers.includes("enforce_home_containment") && rustBrowserTransfers.includes("browser_download_destination"), "browser local artifact destinations use the shared host filesystem containment policy");
assert(rustBrowserTransfers.includes("ensure_browser_local_artifact_source_allowed") && rustBrowserTransfers.includes("shellx-browser-screenshots"), "browser local artifact copy is limited to ShellX Browser generated artifact roots");
assert(hostMcp.includes("/.shellx/browser-settings.json") && hostMcp.includes("/.grok/shellx-browser-screenshots/"), "host MCP fs denylist protects Browser settings and screenshot artifacts");
assert(browserActionResultsSource.includes("record_taskless_engine_observation_locked") && browserActionResultsSource.includes("record_taskless_screenshot_result_locked"), "browser local save actions work from taskless user tabs");
assert(cssSource.includes(".shellx-browser-download-icon-status.pending .shellx-browser-download-badge"), "browser Downloads badge has explicit visible pending colors");
assert(uiSource.includes("setHeaderMenu(\"downloads\")"), "browser page save opens the Downloads manager after saving or queuing");
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
assert(uiSource.includes("inTauri()"), "browser UI gates native engine sync when rendered in web-only visual QA");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-chrome-menu-dock\""), "browser small menus render in a docked chrome layer above the native WebView");
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
assert(cssSource.includes(".shellx-browser-trust-chip"), "browser trust chip has CSS");
assert(cssSource.includes(".shellx-browser-trust-chip.insecureHttp"), "browser trust chip has an insecure HTTP state");
assert(cssSource.includes(".shellx-browser-shields-panel"), "browser Shields panel has CSS");
assert(cssSource.includes(".shellx-browser-bookmark-toolbar"), "browser bookmark toolbar has CSS");
assert(cssSource.includes(".shellx-browser-bookmark-manager"), "browser bookmark manager has CSS");
assert(cssSource.includes(".shellx-browser-bookmark-manager-dock"), "browser bookmark manager shell has CSS");
assert(cssSource.includes(".shellx-browser-bookmark-sidecar"), "browser bookmark manager sidecar has CSS");
assert(cssSource.includes(".shellx-browser-bookmark-folder-menu"), "browser bookmark folders have dropdown CSS");
assert(uiSource.includes("openToolbarFolderId"), "browser toolbar folders are click-toggled instead of hover-only");
assert(bookmarkSidecarSource.includes("data-debug-id={`shellx-browser-bookmark-folder-menu-${openToolbarFolder.bookmarkId}`}"), "browser toolbar folder menus expose debug ids");
assert(bookmarkSidecarSource.includes("data-debug-id={`shellx-browser-bookmark-folder-child-${child.bookmarkId}`}"), "browser toolbar folder child rows expose debug ids");
assert(cssSource.includes(".shellx-browser-header-popover"), "browser compact header menus have CSS");
assert(cssSource.includes(".shellx-browser-right-tabs"), "browser right panel tabs have CSS");
assert(cssSource.includes("grid-template-columns: repeat(4") && cssSource.includes(".shellx-browser-tab-badge") && cssSource.includes(".shellx-browser-requests-panel"), "browser Requests tab has badge and panel CSS");
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
assert(cssSource.includes(".shellx-browser-sidebar-autonomy"), "browser sidebar autonomy control has CSS");
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
assert(moduleReadme.includes("Only three modes are user-facing") && !moduleReadme.includes("Visual Clean Compatibility"), "Browser README documents the three user-facing ad modes");
assert(moduleReadme.includes("does not run browser-owned ads"), "Browser README documents no browser-owned ads");
assert(moduleReadme.includes("URL affiliate rewriting"), "Browser README documents no affiliate rewriting");
assert(moduleReadme.includes("stepSummary"), "Browser README documents compact Browser step summaries");
assert(moduleReadme.includes("task-scoped"), "Browser README documents task-scoped extraction");
assert(moduleReadme.includes("Magika"), "Browser README records Magika classifier role");
assert(moduleReadme.includes("MarkItDown"), "Browser README records MarkItDown converter role");
assert(moduleReadme.includes("Maxun"), "Browser README records Maxun inspiration role");
assert(packageJson.includes("test-shellx-browser.ts"), "pnpm test includes shellx browser checks");
const releaseVersion = packageData.version;
assert(/^\d+\.\d+\.\d+$/.test(releaseVersion), "package version is release semver");
assert(cargoToml.includes(`version = "${releaseVersion}"`), "Cargo version matches package version");
assert(tauriConf.version === releaseVersion, "Tauri version matches package version");
assert(changelog.includes(`## [${releaseVersion}]`), "changelog has current release section");
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
    uiDebugSmokeSource.includes("Native Browser engine yields to collapsed-sidebar save chrome dock") &&
    uiDebugSmokeSource.includes("Native Browser engine sits to the right of the collapsed-sidebar bookmark sidecar"),
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
assert(rustBrowser.includes("fillProfileCardGrant"), "Browser backend exposes mediated profile-card fill action");
assert(rustBrowser.includes("readEmailCodeGrant"), "Browser backend exposes mediated email-code read action");
assert(rustBrowser.includes("useAgentWalletGrant"), "Browser backend exposes mediated agent-wallet checkout action");
assert(rustBrowserVault.includes("browserProfileCardFilled"), "Browser backend receipts include profile-card fills");
assert(rustBrowserVault.includes("browserEmailCodeRead"), "Browser backend receipts include email-code reads");
assert(rustBrowserVault.includes("browserAgentWalletCheckoutPrepared"), "Browser backend receipts include prepared agent-wallet checkout");
assert(rustBrowserVault.includes("browserAgentWalletCheckoutBlocked"), "Browser backend receipts include blocked agent-wallet checkout");
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
    browserActionResultsSource.includes("selector_for_observation_ref") &&
    browserActionsSource.includes("request.browser_tab_id.clone()") &&
    browserTabsSource.includes("state.tab_observations.remove(&tab.browser_tab_id)"),
  "taskless user-tab observe caches selectors so refId Browser actions work without an active agent task",
);
assert(liveSmokeSource.includes("/browser/tabs/lock"), "live smoke covers Browser tab lock route");
assert(liveSmokeSource.includes("tabLocked"), "live smoke covers Browser tab lock denial");
assert(liveSmokeSource.includes("/browser/task/control"), "live smoke covers Browser task operator control route");
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
assert(debugApi.includes("publish_shellxagent_descriptor"), "Debug API publishes shellxagent.json discovery descriptor");
assert(debugApi.includes("\"browserAction\"") && debugApi.includes("/browser/action"), "shellxagent.json advertises the gated Browser action route");
assert(debugApi.includes("\"rawCdpExposed\"") && debugApi.includes("false"), "shellxagent.json declares raw CDP unavailable");
assert(debugApi.includes("rawCdpEndpoint") && debugApi.includes("serde_json::Value::Null"), "Debug API tests protect against raw CDP descriptor exposure");
assert(debugApi.includes("write_private_text_file") && debugApi.includes(".mode(0o600)"), "shellxagent.json is written as a private local descriptor on Unix");
assert(apiDocs.includes("shellxagent.json") && apiDocs.includes("rawCdpExposed: false"), "API docs describe shellxagent.json without raw CDP");
assert(packageData.scripts?.["shellx-browser"] === "tsx scripts/shellx-browser-cli.ts", "package exposes ShellX Browser CLI wrapper");
assert(browserCliSource.includes("readDebugApiConnection"), "Browser CLI reads Debug API port/token from local ShellX files");
assert(browserCliSource.includes("shellxagent.token"), "Browser CLI uses the installed-app Debug API token");
assert(browserCliSource.includes("/browser/action"), "Browser CLI wraps Browser action route");
assert(browserCliSource.includes("/browser/tabs"), "Browser CLI wraps Browser tabs route");
assert(browserCliSource.includes("\"navigate\""), "Browser CLI exposes native Browser navigation");
assert(browserCliSource.includes("fill-from-vault"), "Browser CLI exposes Vault-mediated credential fill");
assert(browserCliSource.includes("lockLeaseId"), "Browser CLI can pass tab lock leases to Browser actions");
assert(browserCliSource.includes("/browser/trace/export"), "Browser CLI wraps Browser trace export route");
for (const tool of [
  "browser_state",
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
  "browser_trace_open",
]) {
  assert(hostMcp.includes(`"name": "${tool}"`), `Host MCP exposes ${tool}`);
}
assert(hostMcp.includes("tool_browser_action"), "Host MCP Browser action tools share one Debug API action wrapper");
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
assert(hostMcp.includes("Do not write raw observation dumps to the current working directory or user folders"), "Browser observe tool description points agents to trace artifacts instead of raw dumps");
assert(hostMcp.includes("Do not copy the trace or raw Browser state into the current working directory or user folders"), "Browser trace tool description keeps diagnostics in ShellX trace storage by default");
assert(pluginsModalSource.includes("Native Browser") && pluginsModalSource.includes("Vault Request Center"), "Plugins modal shellx-host row must mention Browser and Vault Request Center");
assert(!pluginsModalSource.includes("Workflow skills"), "Plugins modal must not advertise retired workflow skills");
assert(hostMcp.includes("Agent tool description must teach subagent Browser flow"), "Host MCP tests protect Agent Browser guidance");
assert(subagentSource.includes("native ShellX Browser"), "subagent runtime guard tells spawned agents the native Browser exists");
assert(subagentSource.includes("browser_navigate"), "subagent runtime guard teaches Browser navigation");
assert(subagentSource.includes("browser_observe"), "subagent runtime guard teaches Browser observation");
assert(subagentSource.includes("browser_resolve_dialog"), "subagent runtime guard teaches task-owned Browser dialog resolution");
assert(subagentSource.includes("Do not write raw Browser state or observe JSON into the current working directory or user folders"), "subagent runtime guard prevents raw Browser JSON dumps in cwd/user folders");
assert(shellxHostSkill.includes("Native ShellX Browser for agent web work"), "ShellX host skill documents native Browser existence");
assert(shellxHostSkill.includes("browser_navigate"), "ShellX host skill teaches Browser navigation tool flow");
assert(shellxHostSkill.includes("browser_resolve_dialog"), "ShellX host skill teaches task-owned beforeunload resolution");
assert(shellxHostSkill.includes("MCP observe output is compact"), "ShellX host skill teaches compact Browser observe defaults");
assert(shellxHostSkill.includes("response message or receipt"), "ShellX host skill teaches direct beforeunload dialogId recovery");
assert(shellxHostSkill.includes("Do not write raw `browser_state` or `browser_observe` JSON dumps into"), "ShellX host skill prevents raw Browser JSON dumps in cwd/user folders");
assert(shellxHostSkill.includes("browser_capture_secret_to_vault"), "ShellX host skill teaches direct page-secret Vault capture");
assert(shellxHostSkill.includes("browser_read_email_code"), "ShellX host skill teaches email-code grants");
assert(shellxHostSkill.includes("browser_use_agent_wallet"), "ShellX host skill teaches agent-wallet grants");
for (const command of [
  "snapshot",
  "navigate",
  "observe",
  "click-ref",
  "fill-ref",
  "wait-for",
  "extract",
  "verify",
  "screenshot",
  "tabs",
  "locks",
  "trace-open",
]) {
  assert(browserCliSource.includes(`"${command}"`), `Browser CLI exposes ${command}`);
}

if (failures > 0) {
  console.error(`\n${failures} ShellX Browser check(s) failed.`);
  process.exit(1);
}

console.log("ShellX Browser checks passed");
