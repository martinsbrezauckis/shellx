import {
  assert, rustBrowserRoot, rustBrowser, rustBrowserDestructiveActions, rustBrowserDeveloperMode, rustBrowserPersonalLock,
  rustBrowserPersistence, rustBrowserModel, browserActionResultsSource, browserActionScriptSource, browserCoordinateInputSource, browserActionsSource,
  browserObservationsSource, browserBookmarksSource, browserCdpRuntimeSource, browserEngineRuntimeSource, permissionHandlerSource, browserRenderedCheckSource,
  browserVaultRuntimeSource, browserWindowOpenRuntimeSource, browserEngineStateSource, browserScriptsSource, browserSecuritySource, browserTabsSource,
  browserProtectedValuesSource, browserProfilesSource, browserTasksSource, rustBrowserPrivacy, rustBrowserPrompts, rustBrowserSessionGrants,
  rustBrowserShields, rustBrowserRobots, rustBrowserArtifacts, rustBrowserStorageState, rustBrowserRecipes, rustBrowserReports,
  rustBrowserDiagnostics, rustBrowserTransfers, rustLib, rustBuildMetadata, debugApi, debugApiBrowserStateSource,
  debugApiBrowserSettingsSource, debugApiBrowserRouteSources, hostMcp, cargoToml, tauriConfSource, tauriCapabilitiesSource,
  uiSource, browserTypesSource, browserApiSource, nativeEngineSyncSource, browserVaultFillSource, browserTasksHookSource,
  apiDocs, moduleReadme, liveSmokeSource, everydayFixtureSource, everydayAppsSmokeSource,
} from "./context";

assert(rustBrowser.includes("ShellxBrowserRegistry"), "Rust browser registry exists");
assert(rustLib.includes("shellx_browser_model"), "browser model module is registered");
assert(rustBrowser.includes("pub use crate::shellx_browser_model"), "browser facade re-exports model types");
assert(
  rustLib.includes("shellx_browser_workflow_taxonomy") &&
    !browserBookmarksSource.includes("fn workflow_slug(") &&
    !hostMcp.includes("fn browser_workflow_filter_task_type("),
  "Browser workflow taxonomy canonicalization lives in a shared module",
);
assert(rustBrowserModel.includes("pub enum BrowserAdMode"), "browser model owns Browser ad mode types");
assert(rustBrowserModel.includes("pub struct BrowserPrivacySettings"), "browser model owns Browser privacy settings");
assert(rustBrowserModel.includes("pub struct BrowserShieldSettings"), "browser model owns Browser Shields settings");
assert(rustBrowserModel.includes("pub struct BrowserDeveloperModeSettings"), "browser model owns Browser Developer Mode settings");
assert(rustBrowserModel.includes("pub struct BrowserClearHistoryRequest"), "browser model owns operator request structs");
assert(cargoToml.includes('"unstable"'), "Tauri unstable webview API is enabled for child Browser engine");
assert(rustBrowser.includes("BROWSER_ENGINE_WEBVIEW_LABEL"), "native Browser engine webview label is modeled");
assert(tauriCapabilitiesSource.includes('"shellx-browser"'), "Browser window has Tauri permissions for debug API and engine commands");
assert(
  rustLib.includes("tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed")
    && rustLib.includes("shellx_browser_registry.record_window_destroyed()"),
  "Browser registry reconciles both requested and completed native window closure",
);
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
  !/fn default_profiles/.test(rustBrowserRoot) &&
    !/fn browser_profile_storage_root/.test(rustBrowserRoot) &&
    !/fn safe_storage_segment/.test(rustBrowserRoot) &&
    !/fn resolve_profile_id/.test(rustBrowserRoot),
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
assert(rustBrowserModel.includes("BrowserBookmarkAgentWorkflow"), "Browser bookmarks model reusable Agent workflow metadata");
assert(rustBrowserModel.includes("agentWorkflow") && rustBrowserModel.includes("siteKey") && rustBrowserModel.includes("taskType"), "Browser workflow bookmarks expose taxonomy for agent discovery");
assert(browserBookmarksSource.includes("normalize_agent_workflow"), "Browser bookmark writes normalize Agent workflow metadata");
assert(rustBrowser.includes("BrowserTabSnapshot"), "Browser tabs are modeled in state");
assert(rustBrowser.includes("BrowserTabLock"), "Browser tab lock leases are modeled");
assert(rustBrowserModel.includes("BrowserTabOwnerKind"), "Browser tabs model user, agent, and delegated ownership");
assert(rustBrowserModel.includes("BrowserPersonalLockSettings"), "Browser Personal Lock state is modeled");
assert(rustBrowserPersonalLock.includes("browser_personal_lock_requires_operator"), "Personal Browser Lock mutations require the ShellX operator path");
assert(rustBrowserPersistence.includes("browser-settings.json"), "Browser privacy, Shields, and Personal Lock settings persist to a dedicated local settings file");
assert(rustBrowserPersistence.includes("SHELLX_BROWSER_SETTINGS_PATH") && rustBrowserPersistence.includes("fn temp_settings_path(label: &str) -> (tempfile::TempDir, PathBuf)") && rustBrowserPersistence.includes(".tempdir()") && !rustBrowserPersistence.includes("std::fs::create_dir_all(&dir).expect(\"create isolated settings directory\")"), "Browser settings support an isolated override and tests retain an owned temporary-directory guard instead of leaking fixtures");
assert(rustBrowserPersistence.includes("persistable_personal_lock") && rustBrowserPersistence.includes("copy.locked = false"), "Personal Browser Lock persistence does not trust runtime locked state from disk");
assert(
  rustBrowserPersistence.includes("personalLockPinHash") &&
    rustBrowserPersistence.includes("json_contains_string_value") &&
    rustBrowserPersistence.includes('assert!(!persisted_personal_lock.contains_key("pin"))') &&
    rustBrowserPersistence.includes('assert!(!persisted_personal_lock.contains_key("newPin"))'),
  "Browser settings persistence stores PIN verifier metadata without raw PINs",
);
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
  !/pub async fn execute_browser_cdp_command\s*\(/.test(rustBrowserRoot) &&
    !/pub async fn export_browser_performance\s*\(/.test(rustBrowserRoot) &&
    !/fn browser_cdp_execution_script\s*\(/.test(rustBrowserRoot) &&
    !/fn browser_performance_capture_script\s*\(/.test(rustBrowserRoot),
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
assert(rustBrowser.includes("BrowserRecipeReplaySkippedStep"), "Browser recipe replay models skipped unsafe or unsupported steps");
assert(rustBrowser.includes("BrowserRecipeReplayStepResult"), "Browser recipe replay models compact per-step results");
assert(rustBrowserModel.includes("decision_points") && rustBrowserModel.includes('rename = "decisionPoints"'), "Browser recipe replay response includes decision points for dry-run recovery");
assert(rustBrowserRecipes.includes('"decisionPoints": decision_points.clone()'), "Browser recipe replay receipts include decision points for trace review");
assert(rustBrowserRecipes.includes('"schemaVersion": 2'), "Browser recipe exports use Action Recipe V2 manifests");
assert(rustBrowserRecipes.includes("variableInputs") && rustBrowserRecipes.includes("decisionPoints") && rustBrowserRecipes.includes("sourceReceipts"), "Browser recipe exports include replay planning sections");
assert(rustBrowserRecipes.includes("fresh-observation-after-redacted-text"), "Browser recipe decision points flag redacted text waits/searches that require fresh observation");
assert(rustBrowserRecipes.includes("browser_recipe_replay_plan"), "Browser recipe replay builds an executable safe-step plan");
assert(rustBrowserRecipes.includes("redactedInputRequiresBinding"), "Browser recipe replay skips redacted input steps until Vault/user bindings exist");
assert(rustBrowserRecipes.includes("redactedTextRequiresFreshObservation"), "Browser recipe replay gives agents explicit recovery reason for redacted text-only wait/search steps");
assert(rustBrowserRecipes.includes("\"clickRef\"") && rustBrowserRecipes.includes("\"waitFor\"") && rustBrowserRecipes.includes("\"select\"") && rustBrowserRecipes.includes("\"verify\""), "Browser recipe replay plans real route interaction steps, not only navigation");
assert(rustBrowserRecipes.includes("liveVaultCaptureRequiresBinding"), "Browser recipe replay leaves Vault capture to live binding instead of replaying raw secrets");
assert(rustBrowserRecipes.includes("browserRecipeExported"), "Browser recipe exports emit receipts");
assert(rustBrowserRecipes.includes("saved browser recipe") && rustBrowserRecipes.includes("does not match its export receipt") && rustBrowserRecipes.includes("MAX_BROWSER_RECIPE_ARTIFACT_BYTES"), "Saved Browser recipe replay is receipt-bound, byte-bounded, and fails closed on artifact drift");
assert(rustBrowserRecipes.includes("browserRecipeReplayCompleted") && rustBrowserRecipes.includes("browserRecipeReplayIncomplete"), "Browser recipe replay emits truthful completion and incomplete receipts");
assert(rustBrowserArtifacts.includes("timeoutMs") && rustBrowserArtifacts.includes("force") && rustBrowserArtifacts.includes("valueRedacted"), "Browser recipe export preserves replay metadata while redacting input values");
assert(rustBrowser.includes("BrowserRobotScheduleRequest"), "Browser robot queue schedule request is modeled");
assert(rustBrowser.includes("BrowserRobotJob"), "Browser robot queue jobs are modeled");
assert(rustBrowserRobots.includes("browserRobotScheduled"), "Browser robot scheduling emits receipts");
assert(rustBrowserRobots.includes("browserRobotRunStarted") && rustBrowserRobots.includes("browserRobotRunCompleted") && rustBrowserRobots.includes("browserRobotRunIncomplete") && rustBrowserRobots.includes("browserRobotRunFailed") && rustBuildMetadata.includes("recipeBackedRobotRuns"), "Browser protocol and robots expose truthful recipe-backed execution lifecycle");
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
    browserEngineRuntimeSource.includes("record_bound_engine_permission_event") &&
    browserEngineRuntimeSource.includes("browser_permission_report_initialization_script") &&
    browserEngineRuntimeSource.includes("__shellxPermissionRequests") &&
    browserActionsSource.includes("record_queued_browser_permission_reports") &&
    browserActionsSource.includes("browser_permission_report_drain_script") &&
    browserActionsSource.includes("record_permission_event") &&
    browserScriptsSource.includes("ensureShellxPermissionReporter"),
  "native WebView and action-drained page permission requests are bridged into Browser permission events",
);
const permissionDenyCallIndex = permissionHandlerSource.indexOf("args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)"); const permissionRecordIndex = permissionHandlerSource.indexOf("record_bound_engine_permission_event");
assert(permissionDenyCallIndex >= 0 && permissionRecordIndex >= 0 && permissionDenyCallIndex < permissionRecordIndex && rustBrowserPrompts.includes("engine_event_bindings") && rustBrowserPrompts.includes("Some(event_binding)") && browserTabsSource.includes("state.engine_event_bindings.remove(&closed_engine_id)"), "native permission evidence is generation-bound and logical tab close retires the old callback identity after preserving DENY");
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
  !/fn browser_should_track_protected_value/.test(rustBrowserRoot) &&
    !/fn redact_browser_observation/.test(rustBrowserRoot) &&
    !/fn redact_engine_control_result/.test(rustBrowserRoot) &&
    !/fn register_browser_protected_value_locked/.test(rustBrowserRoot),
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
assert(rustBrowserModel.includes("formFieldGroups") && rustBrowserModel.includes("BrowserFormFieldGroup"), "Browser observation JSON exposes grouped form intelligence");
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
assert(browserActionScriptSource.includes("__SHELLX_NATIVE_COORDINATE_INPUT__") && browserCoordinateInputSource.includes("viewport click applied through page fallback") && browserCoordinateInputSource.includes("viewport text inserted through page fallback"), "Browser coordinate actions use native Windows input and a checked WebKit page fallback instead of succeeding after a non-Windows no-op");
assert(browserCoordinateInputSource.includes('if (element && !editable) failedChecks.push("editable")') && browserCoordinateInputSource.includes("insertTextAtSelection"), "Browser coordinate text insertion rejects non-editable targets and applies the exact inserted value");
assert(browserActionResultsSource.includes("browserScreenshotCaptured"), "Browser screenshot capture produces a dedicated receipt");
assert(browserActionsSource.includes("capture_window_label_png"), "Browser screenshot capture targets the Browser window label");
assert(browserActionsSource.includes("Page.captureScreenshot"), "Browser full-page screenshot capture uses the native page capture path");
assert(browserActionsSource.includes("captureBeyondViewport"), "Browser full-page screenshot capture can include content beyond the viewport");
assert(browserActionsSource.includes("browser_page_capture_scroll_positions") && browserActionsSource.includes("capture_window_label_png(app, &window_label)") &&
  browserActionsSource.includes("capture_linux_webkit_visible_png(app, engine_label)") && browserActionsSource.includes("snapshot_future(SnapshotRegion::Visible, SnapshotOptions::NONE)") && browserActionsSource.includes("window.scrollTo"),
"Browser full-page screenshots stitch native page snapshots without compositor capture on Linux");
assert(
  browserActionsSource.includes("validate_browser_page_capture_pixels") &&
    browserActionsSource.includes("32_000_000"),
  "Browser full-page screenshot capture bounds non-Windows image allocation",
);
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
assert(browserWindowOpenRuntimeSource.includes("focus_existing_browser_window"), "Browser window lifecycle can focus an existing chrome window before rebuilding it");
assert(
  browserWindowOpenRuntimeSource.includes("open_or_focus_browser_window_bounded") &&
    browserWindowOpenRuntimeSource.includes("run_browser_window_open_operation") &&
    browserWindowOpenRuntimeSource.includes("browser_window_open_timeout") &&
    browserWindowOpenRuntimeSource.includes("try_lock_owned") &&
    browserWindowOpenRuntimeSource.includes("spawn_blocking") &&
    browserWindowOpenRuntimeSource.includes("environmentSpecific"),
  "Browser window creation has a bounded circuit breaker with platform diagnostics",
);
assert(
  browserWindowOpenRuntimeSource.includes("late_created_window_reconciles_before_circuit_breaker_releases") &&
    browserWindowOpenRuntimeSource.includes("late_existing_window_records_presence_without_applying_start_url") &&
    browserWindowOpenRuntimeSource.includes("window_open_failure_resets_provisional_state_and_records_diagnostics"),
  "Browser window watchdog covers late creation, existing-window recovery, state responsiveness, and partial-state reset",
);
assert(
  debugApiBrowserStateSource.includes("StatusCode::GATEWAY_TIMEOUT") &&
    debugApiBrowserStateSource.includes("browser_window_open_in_progress") &&
    debugApiBrowserStateSource.includes("failure.as_json()"),
  "Browser Debug API returns structured timeout and circuit-open failures",
);
assert(
  apiDocs.includes("browser_window_open_timeout") &&
    apiDocs.includes("browser_window_open_in_progress") &&
    moduleReadme.includes("bounded circuit breaker") &&
    moduleReadme.includes("WSL/WSLg"),
  "Browser docs describe bounded native window startup and environment classification",
);
assert(
  browserEngineRuntimeSource.includes("ensure_browser_window_for_engine") &&
    browserWindowOpenRuntimeSource.includes("ensure_browser_window_for_engine"),
  "Browser engine sync has a non-focusing window ensure path",
);
assert(
  browserWindowOpenRuntimeSource.includes("fn ensure_browser_window_for_engine(") &&
    browserWindowOpenRuntimeSource.includes("restore_visible_geometry: bool"),
  "Browser engine sync can request non-focusing geometry restoration for visible tabs",
);
assert(
  browserEngineRuntimeSource.includes("ensure_browser_window_for_engine(app, !browser_engine_bounds_are_background(request.bounds))?"),
  "Browser engine sync restores visible parked chrome without focusing background tabs",
);
assert(
  browserWindowOpenRuntimeSource.includes("if restore_visible_geometry") &&
    browserWindowOpenRuntimeSource.includes("restore_browser_window_geometry(&window)"),
  "Browser engine ensure path restores existing minimized/offscreen Browser windows",
);
assert(rustBrowser.includes("engine_sync_lock"), "Browser engine sync serializes concurrent native webview mounts");
assert(browserEngineRuntimeSource.includes("_engine_sync_guard"), "Browser engine sync holds the mount lock while touching native webviews");
assert(browserEngineRuntimeSource.includes("async fn wait_for_browser_engine_label_release") && browserEngineRuntimeSource.includes("BROWSER_ENGINE_WEBVIEW2_RELEASE_QUIESCENCE") && browserEngineRuntimeSource.includes("tokio::time::sleep(BROWSER_ENGINE_WEBVIEW2_RELEASE_QUIESCENCE).await") && browserEngineRuntimeSource.includes("tokio::time::sleep(Duration::from_millis(25)).await") && !browserEngineRuntimeSource.includes("std::thread::sleep"), "Browser engine sync waits asynchronously for stale labels and Windows WebView2 profile-runtime quiescence before remounting");
assert(debugApi.includes("wait_for_engine_action_slot"), "debug API routes engine-backed browser actions through the waitlist");
assert(rustBrowser.includes("browser_engine_webview_label"), "Browser engine webview labels are derived from engine ids");
assert(browserCdpRuntimeSource.includes("eval_browser_engine_json(app, &engine_label"), "Browser engine eval routes through the target engine label");
assert(uiSource.includes("activeBrowserTabId: activeBrowserTab?.browserTabId ?? null"), "Browser UI sends active tab id during native engine sync");
assert(browserWindowOpenRuntimeSource.includes("restore_browser_window_geometry"), "Browser window lifecycle restores minimized/offscreen existing windows");
assert(browserWindowOpenRuntimeSource.includes("window.unminimize"), "Browser window restore path unminimizes parked windows");
assert(browserWindowOpenRuntimeSource.includes("outer_position"), "Browser window restore path inspects existing window position");
assert(browserWindowOpenRuntimeSource.includes("set_position(Position::Logical(LogicalPosition::new(160.0, 120.0)))"), "Browser window restore path has a visible-position fallback");
assert(
  browserWindowOpenRuntimeSource.includes("pub async fn open_or_focus_browser_window_bounded") &&
    browserEngineRuntimeSource.includes("pub(crate) async fn sync_native_browser_engine") &&
    browserEngineRuntimeSource.includes("async fn install_strict_browser_request_filter") &&
    browserEngineRuntimeSource.includes("fn park_inactive_browser_engine_webviews") &&
    browserEngineRuntimeSource.includes("fn wait_for_browser_engine_label_release") &&
    browserEngineRuntimeSource.includes("fn engine_bounds_rect") &&
    rustLib.includes("mod shellx_browser_engine_runtime;") &&
    rustLib.includes("mod shellx_browser_window_open_runtime;"),
  "Browser chrome lifecycle and native engine runtime live in focused modules",
);
assert(
  !/pub fn open_or_focus_browser_window\s*\(/.test(rustBrowserRoot) &&
    !/fn ensure_browser_window_for_engine\s*\(/.test(rustBrowserRoot) &&
    !/(?:async )?fn sync_native_browser_engine\s*\(/.test(rustBrowserRoot) &&
    !/(?:async )?fn install_strict_browser_request_filter\s*\(/.test(rustBrowserRoot) &&
    !/fn park_inactive_browser_engine_webviews\s*\(/.test(rustBrowserRoot) &&
    !/fn wait_for_browser_engine_label_release\s*\(/.test(rustBrowserRoot) &&
    !/fn engine_bounds_rect\s*\(/.test(rustBrowserRoot),
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
  !/pub fn record_engine_sync\s*\(/.test(rustBrowserRoot) &&
    !/pub fn record_engine_load_for_engine\s*\(/.test(rustBrowserRoot) &&
    !/pub fn record_engine_title_for_engine\s*\(/.test(rustBrowserRoot) &&
    !/pub fn record_engine_beforeunload_blocker\s*\(/.test(rustBrowserRoot),
  "Browser engine state lifecycle methods are no longer embedded in shellx_browser.rs",
);
assert(browserEngineRuntimeSource.includes("WebviewBuilder::new"), "Browser engine creates a native child webview");
assert(browserEngineRuntimeSource.includes("add_child"), "Browser engine mounts inside the Browser chrome window");
assert(browserEngineRuntimeSource.includes("set_bounds"), "Browser engine can resize to the viewport");
const windowsWebviewArgs = "--disable-features=msWebOOUI,msPdfOOUI --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding";
assert(
  [browserEngineRuntimeSource, browserWindowOpenRuntimeSource, browserRenderedCheckSource, browserVaultRuntimeSource].every((source) => source.includes("SHELLX_BROWSER_WEBVIEW2_ADDITIONAL_ARGS")) &&
    browserEngineRuntimeSource.includes("additional_browser_args(SHELLX_BROWSER_WEBVIEW2_ADDITIONAL_ARGS)") && tauriConfSource.includes(`"additionalBrowserArgs": "${windowsWebviewArgs}"`) &&
    windowsWebviewArgs.split(" ").every((argument) => browserEngineRuntimeSource.includes(argument)),
  "every ShellX-owned Windows WebView uses one compatible WebView2 option set without process-environment inheritance",
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
assert(debugApi.includes("sync_engine_to_tab(app, registry, &tab)") && debugApi.includes(".await") && debugApi.includes(".map(|_| ())"), "debug API navigate sync remains non-preserving so explicit navigation drives the WebView");
assert(browserActionResultsSource.includes("browserEngineObserved"), "engine-backed page observations produce receipts");
assert(browserApiSource.includes("preserveExistingPage?: boolean"), "Browser engine sync API can mark layout syncs as page-preserving");
assert(rustBrowserModel.includes("preserve_existing_page"), "Browser engine sync model carries page-preservation intent");
assert(nativeEngineSyncSource.includes("preserveExistingPage: true"), "Browser UI focus and resize syncs preserve the live page");
assert(
  browserEngineRuntimeSource.includes("request.preserve_existing_page && same_browser_tab") &&
    browserEngineRuntimeSource.includes("browser_webview_should_navigate(") &&
    browserEngineRuntimeSource.includes("current_engine_url.as_deref()") &&
    browserEngineRuntimeSource.includes("engine.url.clone()") &&
    !browserEngineRuntimeSource.includes("webview.url()") &&
    browserEngineRuntimeSource.includes("engine.pending_url.as_deref()"),
  "Browser native engine does not replay stale or already-pending URLs and avoids the racy macOS native URL getter during same-tab preserving sync",
);
assert(
  ["native.Navigate(&HSTRING::from(target_url))", "async fn with_windows_browser_webview", ".run_on_main_thread(move ||", "tokio::time::timeout(Duration::from_secs(15), result_rx)", "drop(result_tx)", '"starting Browser WebView2 navigation"', '"applying Browser credential controls"'].every((marker) => browserEngineRuntimeSource.includes(marker)),
  "Windows Browser initialization acknowledges native credential controls and navigation instead of treating queued dispatch as completion",
);
assert(
  browserEngineStateSource.includes("let preserve_existing_page = request.preserve_existing_page") &&
    browserEngineStateSource.includes("let navigation_requested = !preserve_existing_page") &&
    browserEngineStateSource.includes("engine.url = Some(current_url)"),
  "Browser engine state commits live URLs without false navigation records during same-tab preserving sync",
);
assert(
  browserVaultFillSource.includes("const rawUrl = engineUrl ?? activeBrowserTab.url ?? \"\""),
  "browser Vault fill observation prefers the active engine URL when tab metadata is stale",
);
assert(rustBrowser.includes("selector"), "engine observations expose selectors for deterministic controls");
assert(rustBrowserModel.includes("raw_selector"), "engine observations preserve internal raw selectors for ref replay");
assert(
  browserObservationsSource.includes("preserve_raw_observation_selectors") &&
    browserObservationsSource.includes("reference.raw_selector = reference.selector.clone()"),
  "Browser redacts visible selectors without breaking ref replay",
);
assert(browserScriptsSource.includes("BROWSER_ENGINE_CONTROL_SCRIPT"), "Browser engine has a deterministic control script");
assert(
    browserScriptsSource.includes("BROWSER_ENGINE_OBSERVE_SCRIPT") &&
    browserScriptsSource.includes("BROWSER_ENGINE_CONTROL_SCRIPT") &&
    browserScriptsSource.includes("shellxPrimarySelectorFor") &&
    browserScriptsSource.includes("shellxRootXpathMatches") &&
    browserScriptsSource.includes("root.evaluate(selector, root") &&
    browserScriptsSource.includes("shellxResolveDomLocator") &&
    browserScriptsSource.includes('current !== root &&') &&
    browserScriptsSource.includes('`/${parts.join("/")}`') &&
    browserScriptsSource.includes("summary,output,[aria-live]") &&
    browserScriptsSource.includes("InputEvent(\"beforeinput\"") &&
    browserScriptsSource.includes("execCommand(\"insertText\"") &&
    rustLib.includes("mod shellx_browser_scripts;"),
  "Browser native engine scripts live in focused modules and resolve scoped CSS or XPath locators",
);
assert(
  !/const BROWSER_ENGINE_OBSERVE_SCRIPT/.test(rustBrowserRoot) &&
    !/const BROWSER_ENGINE_CONTROL_SCRIPT/.test(rustBrowserRoot),
  "Browser native engine scripts are no longer embedded in shellx_browser.rs",
);
assert(
  browserActionResultsSource.includes("pub fn record_engine_observation") &&
    browserActionResultsSource.includes("pub(crate) fn record_engine_control_result") &&
    browserActionResultsSource.includes("pub(crate) fn record_screenshot_result") &&
    browserObservationsSource.includes("browser_observation_refs_with_synthetic") &&
    rustLib.includes("mod shellx_browser_action_results;") &&
    rustLib.includes("mod shellx_browser_observations;"),
  "Browser engine action result lifecycle lives in a focused module",
);
assert(
  !/pub fn record_engine_observation\s*\(/.test(rustBrowserRoot) &&
    !/fn record_engine_control_result\s*\(/.test(rustBrowserRoot) &&
    !/fn record_screenshot_result\s*\(/.test(rustBrowserRoot) &&
    !/pub fn resolve_engine_selector\s*\(/.test(rustBrowserRoot) &&
    !/fn browser_observation_refs_with_synthetic\s*\(/.test(rustBrowserRoot),
  "Browser engine action result lifecycle methods are no longer embedded in shellx_browser.rs",
);
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
assert(
  rustBrowserSessionGrants.includes("browser_session_grant_application_unavailable")
    && !rustBrowserSessionGrants.includes("browserSessionGrantApplied"),
  "Browser session grant application fails closed until real profile-state copying exists",
);
assert(rustBrowserPrompts.includes("browserDialogRecorded"), "Browser dialog record receipts are modeled");
assert(rustBrowserPrompts.includes("browserDialogResolved"), "Browser dialog resolve receipts are modeled");
assert(rustBrowserPrompts.includes("browserPermissionRequested"), "Browser page permission request receipts are modeled");
assert(rustBrowserPrompts.includes("browserPermissionResolved"), "Browser page permission resolve receipts are modeled");
assert(
  permissionHandlerSource.includes("args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;") &&
    browserEngineRuntimeSource.includes("requires_approval: true"),
  "native page permissions fail closed until ShellX operator approval is available",
);
assert(rustBrowserPrompts.includes("browserPopupRecorded"), "Browser popup record receipts are modeled");
assert(rustBrowser.includes("browserNetworkObserved"), "Browser network metadata receipts are modeled");
assert(rustBrowser.includes("findText"), "Browser engine can search text inside the current page");
assert(browserScriptsSource.includes("summary,output,[aria-live]"), "Browser find-in-page can scroll common app status/output elements");
assert(browserScriptsSource.includes("notActionable"), "Browser engine can return honest notActionable outcomes");
assert(browserScriptsSource.includes("fieldIntentFor") && browserScriptsSource.includes("formFieldGroups"), "Browser engine classifies and groups form fields for agent planning");
assert(browserScriptsSource.includes("dispatchEvent(new view.Event(\"input\""), "engine-backed fill/type dispatches input events in the target realm");
assert(browserScriptsSource.includes("InputEvent(\"beforeinput\""), "engine-backed fill/type dispatches beforeinput events for rich editors");
assert(browserScriptsSource.includes("execCommand(\"insertText\""), "engine-backed fill/type uses browser text insertion for contenteditable editors");
assert(rustBrowser.includes("extractTable"), "Browser engine can extract table data deterministically");
assert(liveSmokeSource.includes("domSummary"), "live Browser smoke checks DOM summary observations");
assert(liveSmokeSource.includes("formFields"), "live Browser smoke checks form field observations");
assert(liveSmokeSource.includes("formFieldGroups"), "live Browser smoke checks grouped form observations");
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
assert(liveSmokeSource.includes("isShellxBrowserArtifactPath"), "live Browser smoke checks ShellX-owned Browser artifact roots");
assert(tauriConfSource.includes("\"$HOME/.shellx/browser-artifacts/shellx-browser-screenshots/**\""), "Tauri asset protocol allows Browser screenshot artifacts");
assert(tauriConfSource.includes("\"$HOME/.shellx/browser-artifacts/shellx-browser-traces/**\""), "Tauri asset protocol allows Browser trace artifacts");
assert(rustBrowser.includes("browserBookmarkSaved"), "Browser can save the current page as a bookmark");
assert(browserBookmarksSource.includes("browserHistoryCleared"), "Browser can clear local history from the user UI");
assert(rustBrowser.includes("BrowserClearHistoryRequest"), "Browser clear-history operator request is modeled");
assert(browserBookmarksSource.includes("shellx_browser_destructive_actions::browser_destructive_action_requires_operator"), "Browser clear-history registry mutation is operator-gated");
assert(rustBrowserDestructiveActions.includes("BROWSER_DESTRUCTIVE_ACTION_OPERATOR_ERROR_CODE"), "Browser destructive action module defines the operator-gate error code");
assert(rustBrowserModel.includes("pub clear_profile_ad_mode: bool"), "Browser privacy updates can explicitly restore a profile to the global ad mode");
assert(
  rustBrowserPrivacy.includes("request.clear_profile_ad_mode && request.profile_ad_mode.is_some()") &&
    rustBrowserPrivacy.includes("retain(|item| item.profile_id != profile_id)"),
  "Browser privacy rejects conflicting profile-mode updates and clears only the requested profile override",
);
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
  !rustBrowserRoot.includes("fn browser_ad_decision_for_url") &&
    !rustBrowserRoot.includes("fn browser_privacy_initialization_script") &&
    !rustBrowserRoot.includes("fn refresh_browser_tab_shields"),
  "Browser Shields/ad-filter decisions are no longer embedded in shellx_browser.rs",
);
assert(rustBrowserShields.includes("__shellxPrivacyStats"), "Browser ad filter exposes local privacy stats for UI and tests");
assert(rustBrowser.includes("reapply_browser_privacy_to_active_engine"), "Browser reapplies ad filtering when privacy or shields settings change");
assert(browserEngineRuntimeSource.includes("install_strict_browser_request_filter"), "Browser strict ad mode installs native request filtering");
assert(browserEngineRuntimeSource.includes("AddWebResourceRequestedFilter") && browserEngineRuntimeSource.includes("WebResourceRequestedEventHandler") && browserEngineRuntimeSource.includes("record_bound_strict_request_blocked") && rustBrowser.includes("record_bound_strict_request_blocked") && rustBrowser.includes("Some(event_binding)"), "Browser strict ad mode hooks WebView2 request interception");
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
assert(browserTasksSource.includes("BROWSER_TASK_OPERATOR_CONTROL_REQUIRED"), "Browser task takeover has a stable operator-required error code");
assert(browserTasksSource.includes("BROWSER_TASK_OWNER_CONTROL_REQUIRED") && browserTasksSource.includes("ensure_browser_task_control_authority"), "Browser task mutations enforce the authenticated task owner principal");
assert(rustBrowserModel.includes('rename = "ownerActorId"') && rustBrowserModel.includes('rename = "ownerSurface"'), "Browser task snapshots expose immutable owner principal metadata");
assert(browserTypesSource.includes("ownerActorId: string") && browserTypesSource.includes("ownerSurface: string") && browserTypesSource.includes("ownerSessionId?: string | null"), "Browser frontend types carry task owner principal metadata");
assert(browserTasksSource.includes("BrowserTaskControlAuthority::Agent") && browserTasksSource.includes("BrowserTaskControlAuthority::Operator"), "Browser task mutations derive authority from their authenticated surface");
assert(browserTasksSource.includes('Self::Agent => "shellxDebugApiAgent"') && browserTasksSource.includes('Self::Operator => "shellxBrowserOperator"'), "Browser task receipts use fixed surface actor IDs");
assert(debugApiBrowserStateSource.includes("StatusCode::FORBIDDEN") && debugApiBrowserStateSource.includes("browser_task_mutation_error_response"), "Debug API returns a machine-readable forbidden response for operator-only task controls");
assert(rustLib.includes("shellx_browser_control_task") && rustLib.includes("shellx_browser_finish_task"), "Browser operator task commands are registered with Tauri");
assert(browserApiSource.includes("controlBrowserTaskFromOperator") && browserApiSource.includes("finishBrowserTaskFromOperator"), "Browser frontend exposes task mutations through the Tauri operator path");
assert(browserTasksHookSource.includes("isTrustedShellxUserEvent(event)") && browserTasksHookSource.includes("controlBrowserTaskFromOperator") && browserTasksHookSource.includes("finishBrowserTaskFromOperator"), "Browser task operator controls require trusted user events before Tauri invocation");
assert(
  browserTasksSource.includes("transition_task_status_locked") &&
    browserTasksSource.includes("repair_browser_task_invariants_locked") &&
    browserTasksSource.includes("BROWSER_TASK_TERMINAL_HISTORY_LIMIT") &&
    browserTasksSource.includes("browserTaskHistoryPruned") &&
    browserTabsSource.includes("lastTabClosed") &&
    browserTypesSource.includes("statusReason"),
  "Browser tasks centralize transitions, abort on final tab close, expose reasons, and bound terminal history",
);
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
  !/pub fn start_task\s*\(/.test(rustBrowserRoot) &&
    !/pub fn finish_task\s*\(/.test(rustBrowserRoot) &&
    !/pub fn control_task\s*\(/.test(rustBrowserRoot) &&
    !/pub fn task_control_block_for_action\s*\(/.test(rustBrowserRoot) &&
    !/fn task_control_blocked_response\s*\(/.test(rustBrowserRoot) &&
    !/pub\(crate\) fn resolve_task_id\s*\(/.test(rustBrowserRoot) &&
    !/pub\(crate\) fn find_task_index\s*\(/.test(rustBrowserRoot) &&
    !/pub\(crate\) fn browser_agent_step_summary_for_task\s*\(/.test(rustBrowserRoot),
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
assert(rustLib.includes("shellx_browser_shield_settings::shellx_browser_update_shields"), "browser Shields global operator command is registered with Tauri");
assert(rustLib.includes("shellx_browser_shield_settings::shellx_browser_update_site_shields"), "browser Shields site operator command is registered with Tauri");
assert(rustLib.includes("shellx_browser_shield_settings::shellx_browser_remove_site_shields"), "browser Shields remove operator command is registered with Tauri");
assert(rustBrowserPrivacy.includes("browser_privacy_update_requires_operator"), "browser privacy registry updates are operator-gated");
assert(rustBrowserPrivacy.includes("browser_privacy_requires_operator"), "browser privacy module defines the operator-gate error code");
assert(
  rustBrowserPrivacy.includes("impl ShellxBrowserRegistry") &&
    rustBrowserPrivacy.includes("pub fn update_privacy"),
  "Browser privacy registry mutation lives in shellx_browser_privacy.rs",
);
assert(!/pub fn update_privacy\(/.test(rustBrowserRoot), "Browser privacy registry mutation is no longer embedded in shellx_browser.rs");
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
  !/pub fn update_shields\(/.test(rustBrowserRoot) &&
    !/pub fn update_site_shields\(/.test(rustBrowserRoot) &&
    !/pub fn remove_site_shields\(/.test(rustBrowserRoot),
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
  "/browser/summary", "/browser/check",
  "/browser/state",
  "/browser/settle",
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
  "/browser/history",
  "/browser/requests",
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
