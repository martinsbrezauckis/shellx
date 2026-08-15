import {
  assert, rustBrowserRoot, rustBrowser, rustBrowserDeveloperMode, rustBrowserModel, browserActionsSource,
  browserBookmarksSource, browserEngineSource, browserEngineRuntimeSource, browserWindowOpenRuntimeSource, browserSecuritySource, browserTabsSource,
  rustBrowserPrompts, rustBrowserSessionGrants, rustBrowserRobots, rustBrowserArtifacts, rustBrowserStorageState, rustBrowserState,
  rustBrowserRecipes, rustBrowserReports, rustBrowserDiagnostics, rustBrowserTransfers, rustBrowserIntegrationTests, rustLib,
  debugApiRoot, debugApi, debugApiBrowser, debugApiBrowserArtifactsSource, debugApiBrowserSecuritySource, debugApiBrowserStateSource,
  debugApiBrowserSettingsSource, mainSource, browserMainSource, browserHtmlSource, appSource, debugUiConnectionSource,
  uiSource, browserTypesSource, browserNativeSecurityNoticeSource, browserPreferencesSource, browserDebugBridgeSource, browserApiSource,
  browserVaultFillCandidateSource, browserShieldsPanelSource, browserMenusSource, browserHistorySidecarSource, bookmarkSidecarSource, bookmarkToolbarSource,
  browserChromeSource, nativeEngineSyncSource, browserStateHookSource, browserPersonalLockSource, browserVaultFillSource, browserVaultFillPanelSource,
  browserShellEffectsSource, agentSidebarSource, cssSource, readme, apiDocs, moduleReadme,
  shellxHostSkill,
} from "./context";

const browserDebugApiRouteInventory = [
  "/browser/summary", "/browser/check",
  "/browser/state",
  "/browser/settle",
  "/browser/tabs",
  "/browser/profiles",
  "/browser/tasks",
  "/browser/history",
  "/browser/requests",
  "/browser/bookmarks",
  "/browser/receipts",
  "/browser/privacy",
  "/browser/personal-lock",
  "/browser/engine-pool",
  "/browser/shields",
  "/browser/shields/site",
  "/browser/shields/site/:host",
  "/browser/developer-mode",
  "/browser/developer-mode/approval",
  "/browser/downloads",
  "/browser/uploads",
  "/browser/logs",
  "/browser/storage-state",
  "/browser/dialogs",
  "/browser/permissions",
  "/browser/popups",
  "/browser/network",
  "/browser/robots",
  "/browser/open",
  "/browser/tabs/open",
  "/browser/tabs/focus",
  "/browser/tabs/reorder",
  "/browser/tabs/close",
  "/browser/tabs/lock",
  "/browser/tabs/heartbeat",
  "/browser/tabs/unlock",
  "/browser/task/start",
  "/browser/task/autonomy",
  "/browser/task/control",
  "/browser/task/finish",
  "/browser/action",
  "/browser/bookmarks/reorder",
  "/browser/bookmarks/:bookmark_id",
  "/browser/downloads/request",
  "/browser/downloads/complete",
  "/browser/uploads/request",
  "/browser/uploads/complete",
  "/browser/cdp/execute",
  "/browser/trace/export",
  "/browser/har/export",
  "/browser/performance/export",
  "/browser/recipes/export",
  "/browser/recipes/replay",
  "/browser/robots/schedule",
  "/browser/robots/run",
  "/browser/robots/cancel",
  "/browser/storage-state/export",
  "/browser/dialogs/resolve",
  "/browser/permissions/resolve",
  "/browser/session-grants/request",
  "/browser/session-grants/resolve",
  "/browser/session-grants/apply",
  "/browser/vault-deposits",
  "/browser/vault/fill-receipt",
  "/browser/vault/generate-receipt",
  "/browser/report",
];
for (const route of browserDebugApiRouteInventory) {
  assert(apiDocs.includes(route), `API docs document Browser Debug API route ${route}`);
  assert(moduleReadme.includes(route), `Browser README documents Browser Debug API route ${route}`);
  assert(shellxHostSkill.includes(route), `shellx-host skill documents Browser Debug API route ${route}`);
}
for (const doc of [
  ["API docs", apiDocs],
  ["Browser README", moduleReadme],
  ["shellx-host skill", shellxHostSkill],
] as const) {
  const [label, source] = doc;
  assert(
    source.includes("HTTP Debug API Browser flow for outside drivers") &&
      source.includes("Authorization: Bearer <token>") &&
      source.includes("browser_navigate -> POST /browser/action") &&
      source.includes('action: "navigate"') &&
      source.includes("browser_fill_from_vault -> POST /browser/action") &&
      source.includes('action: "fillFromVaultGrant"') &&
      source.includes("browser_capture_secret_to_vault -> POST /browser/action") &&
      source.includes('action: "capturePageSecretToVault"') &&
      source.includes("browser_screenshot -> POST /browser/action") &&
      source.includes('action: "captureScreenshot"'),
    `${label} documents raw HTTP Browser Debug API flow and MCP-to-action mapping`,
  );
}
assert(
  readme.includes("Drive ShellX Browser without exposing its bearer credential") && readme.includes("pnpm shellx-browser tabs") &&
    readme.includes("pnpm shellx-browser snapshot") &&
    readme.includes("pnpm shellx-browser run-steps --steps-json") &&
    readme.includes("private process-local integration") &&
    !readme.includes('"profileId":"agent-work"') && !readme.includes("/browser/task/start"),
  "README shellXagent quick-start uses the credential-safe ShellX Browser CLI for outside drivers",
);
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
  !/pub fn upsert_bookmark\(/.test(rustBrowserRoot) &&
    !/pub fn reorder_bookmarks\(/.test(rustBrowserRoot) &&
    !/pub fn delete_bookmark\(/.test(rustBrowserRoot) &&
    !/pub fn clear_history\(/.test(rustBrowserRoot),
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
assert(!/pub fn update_engine_pool\(/.test(rustBrowserRoot), "Browser engine-pool settings mutation is no longer embedded in shellx_browser.rs");
assert(
  browserActionsSource.includes("pub(crate) async fn try_apply_engine_action") &&
    browserActionsSource.includes("pub(crate) async fn observe_browser_page") &&
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
    !/pub fn open_tab\(/.test(rustBrowserRoot) &&
    !/pub fn focus_tab\(/.test(rustBrowserRoot) &&
    !/pub fn lock_tab\(/.test(rustBrowserRoot),
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
    !/fn classify_browser_page_security\(/.test(rustBrowserRoot) &&
    !/fn browser_url_uses_private_network\(/.test(rustBrowserRoot) &&
    !/fn insecure_credential_denial_for_request\(/.test(rustBrowserRoot),
  "Browser page security helpers are no longer embedded in shellx_browser.rs",
);
assert(rustLib.includes("mod shellx_browser_robots;"), "browser robot queue module is registered");
assert(
  rustBrowserRobots.includes("pub fn schedule_robot") &&
    rustBrowserRobots.includes("fn begin_robot_run") && rustBrowserRobots.includes("fn finish_robot_run") &&
    rustBrowserRobots.includes("pub fn cancel_robot") &&
    rustBrowserRobots.includes("browserRobotScheduled") &&
    rustBrowserRobots.includes("browserRobotRunCompleted") &&
    rustBrowserRobots.includes("browserRobotCancelled"),
  "Browser robot queue behavior lives in shellx_browser_robots.rs",
);
assert(
    !rustBrowserRoot.includes("pub fn schedule_robot") &&
    !rustBrowserRoot.includes("fn begin_robot_run") && !rustBrowserRoot.includes("fn finish_robot_run") &&
    !rustBrowserRoot.includes("pub fn cancel_robot"),
  "Browser robot queue methods are no longer embedded in shellx_browser.rs",
);
assert(rustLib.includes("mod shellx_browser_artifacts;"), "browser artifact helper module is registered");
assert(
    rustBrowserArtifacts.includes("pub(crate) fn redact_trace_value") &&
    rustBrowserArtifacts.includes("pub(crate) fn redact_trace_receipt") &&
    rustBrowserArtifacts.includes("pub(crate) fn browser_recipe_step_from_receipt_with_context") &&
    rustBrowserArtifacts.includes("pub(crate) fn write_browser_json_artifact"),
  "Browser artifact redaction and writer helpers live in shellx_browser_artifacts.rs",
);
assert(
  rustBrowserArtifacts.includes("join(\".shellx\")") &&
    rustBrowserArtifacts.includes("join(\"browser-artifacts\")") &&
    rustBrowserArtifacts.includes("browser_legacy_artifact_root"),
  "Browser artifacts write to ShellX-owned storage while preserving legacy read compatibility",
);
assert(
  !rustBrowserRoot.includes("fn redact_trace_value") &&
    !rustBrowserRoot.includes("fn redact_trace_receipt") &&
    !rustBrowserRoot.includes("fn browser_recipe_step_from_receipt") &&
    !rustBrowserRoot.includes("fn write_browser_json_artifact"),
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
  !rustBrowserRoot.includes("pub fn storage_state_manifests") &&
    !rustBrowserRoot.includes("pub fn export_storage_state_manifest") &&
    !rustBrowserRoot.includes("fn browser_storage_state_manifests"),
  "Browser storage-state manifest methods are no longer embedded in shellx_browser.rs",
);
assert(rustLib.includes("mod shellx_browser_recipes;") && rustLib.includes("mod shellx_browser_recipe_analysis;"), "browser recipe and analysis modules are registered");
assert(
  rustBrowserRecipes.includes("pub fn export_recipe") &&
    rustBrowserRecipes.includes("pub fn replay_recipe_record") &&
    rustBrowserRecipes.includes("browserRecipeExported") &&
    rustBrowserRecipes.includes("browserRecipeReplayCompleted"),
  "Browser recipe export and replay behavior lives in shellx_browser_recipes.rs",
);
assert(
  !rustBrowserRoot.includes("pub fn export_recipe") &&
    !rustBrowserRoot.includes("pub fn replay_recipe_record"),
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
  !rustBrowserRoot.includes("pub fn export_har") &&
    !rustBrowserRoot.includes("pub fn export_performance_artifact") &&
    !rustBrowserRoot.includes("pub fn export_trace_bundle"),
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
  !rustBrowserRoot.includes("pub fn request_download_intent") &&
    !rustBrowserRoot.includes("pub fn request_upload_intent") &&
    !rustBrowserRoot.includes("pub fn complete_download") &&
    !rustBrowserRoot.includes("pub fn complete_upload") &&
    !rustBrowserRoot.includes("pub fn grant_transfer_for_user") &&
    !rustBrowserRoot.includes("fn complete_transfer") &&
    !rustBrowserRoot.includes("fn validate_and_consume_transfer_approval") &&
    !rustBrowserRoot.includes("fn classify_transfer_content"),
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
  !rustBrowserRoot.includes("pub fn console_logs") &&
    !rustBrowserRoot.includes("pub fn record_console_log") &&
    !rustBrowserRoot.includes("pub fn write_report") &&
    !rustBrowserRoot.includes("fn normalize_console_level") &&
    !rustBrowserRoot.includes("fn sanitize_console_message") &&
    !rustBrowserRoot.includes("fn sanitize_console_details"),
  "Browser report and console methods/helpers are no longer embedded in shellx_browser.rs",
);
assert(rustLib.includes("mod shellx_browser_state;"), "browser read-only state module is registered");
assert(
  rustBrowserState.includes("pub fn state") &&
    rustBrowserState.includes("pub fn core_state") &&
    rustBrowserState.includes("pub fn summary") &&
    rustBrowserState.includes("pub fn settle_state") &&
    rustBrowserState.includes("pub fn task_summaries") &&
    rustBrowserState.includes("pub fn task_details") &&
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
  "Browser full, core, summary, settle, and list getters live in shellx_browser_state.rs",
);
assert(
  !rustBrowserRoot.includes("pub fn state") &&
    !rustBrowserRoot.includes("pub fn profiles") &&
    !rustBrowserRoot.includes("pub fn tabs") &&
    !rustBrowserRoot.includes("pub fn privacy") &&
    !rustBrowserRoot.includes("pub fn shields") &&
    !rustBrowserRoot.includes("pub fn developer_mode") &&
    !rustBrowserRoot.includes("pub fn downloads") &&
    !rustBrowserRoot.includes("pub fn uploads") &&
    !rustBrowserRoot.includes("pub fn bookmarks") &&
    !rustBrowserRoot.includes("pub fn bookmark_toolbar") &&
    !rustBrowserRoot.includes("pub fn tasks") &&
    !rustBrowserRoot.includes("pub fn receipts") &&
    !rustBrowserRoot.includes("pub fn dialogs") &&
    !rustBrowserRoot.includes("pub fn permissions") &&
    !rustBrowserRoot.includes("pub fn popups") &&
    !rustBrowserRoot.includes("pub fn network_entries") &&
    !rustBrowserRoot.includes("pub fn robots"),
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
  !rustBrowserRoot.includes("pub fn update_developer_mode") &&
    !rustBrowserRoot.includes("pub fn approve_developer_mode_host") &&
    !rustBrowserRoot.includes("pub fn prepare_cdp_execute") &&
    !rustBrowserRoot.includes("pub fn record_cdp_execute_result") &&
    !rustBrowserRoot.includes("fn cdp_access_denial_for_request") &&
    !rustBrowserRoot.includes("fn developer_mode_host_from_request"),
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
    rustBrowserSessionGrants.includes("BROWSER_SESSION_GRANT_APPLICATION_UNAVAILABLE_CODE"),
  "Browser session grant request, resolution, and application behavior lives in shellx_browser_session_grants.rs",
);
assert(
  !rustBrowserRoot.includes("pub fn request_session_grant") &&
    !rustBrowserRoot.includes("pub fn resolve_session_grant") &&
    !rustBrowserRoot.includes("pub fn apply_session_grant"),
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
  !rustBrowserRoot.includes("pub fn record_dialog_event") &&
    !rustBrowserRoot.includes("pub fn resolve_dialog_event") &&
    !rustBrowserRoot.includes("pub fn record_permission_event") &&
    !rustBrowserRoot.includes("pub fn resolve_permission_event") &&
    !rustBrowserRoot.includes("pub fn record_popup_event") &&
    !rustBrowserRoot.includes("pub fn record_network_observed"),
  "Browser dialog, permission, popup, and network event lifecycle methods are no longer embedded in shellx_browser.rs",
);
assert(debugApi.includes("\"browser-event\""), "debug API emits browser-event frames");
assert(debugApi.includes("emit_browser_latest"), "taskless browser grant routes still emit latest receipts");
assert(
  rustLib.includes("mod debug_api_browser") &&
    debugApi.includes("debug_api_browser::") &&
    debugApiBrowserStateSource.includes("/browser/state") &&
    debugApiBrowser.includes("/browser/action") &&
    debugApiBrowserSettingsSource.includes("BROWSER_PRIVACY_OPERATOR_ERROR_CODE") &&
    debugApiBrowserSettingsSource.includes("BROWSER_SHIELDS_OPERATOR_ERROR_CODE") &&
    debugApiBrowserSecuritySource.includes("BROWSER_SESSION_GRANT_OPERATOR_ERROR_CODE"),
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
  !debugApiRoot.includes("pub(crate) async fn browser_state_http") &&
    !debugApiRoot.includes("pub(crate) async fn browser_tab_open_http") &&
    !debugApiRoot.includes("pub(crate) async fn browser_task_start_http"),
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
  !debugApiRoot.includes("pub(crate) async fn browser_bookmarks_http") &&
    !debugApiRoot.includes("pub(crate) async fn browser_shields_post_http") &&
    !debugApiRoot.includes("pub(crate) async fn browser_developer_mode_post_http"),
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
  !debugApiRoot.includes("pub(crate) async fn browser_trace_export_http") &&
    !debugApiRoot.includes("pub(crate) async fn browser_cdp_execute_http") &&
    !debugApiRoot.includes("pub(crate) async fn browser_robot_schedule_http") &&
    !debugApiRoot.includes("pub(crate) async fn browser_download_request_http"),
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
  !debugApiRoot.includes("pub(crate) async fn browser_dialog_resolve_http") &&
    !debugApiRoot.includes("pub(crate) async fn browser_permission_resolve_http") &&
    !debugApiRoot.includes("pub(crate) async fn browser_session_grant_resolve_http") &&
    !debugApiRoot.includes("pub(crate) async fn browser_vault_deposit_http"),
  "Browser Debug API dialog/permission/Vault-grant handlers are no longer embedded in debug_api.rs",
);
assert(
  !mainSource.includes("ShellxBrowserApp") &&
    browserMainSource.includes("ShellxBrowserApp") &&
    browserHtmlSource.includes("/src/shellx-browser-main.tsx") &&
    browserWindowOpenRuntimeSource.includes('WebviewUrl::App("shellx-browser.html".into())'),
  "Browser window uses a dedicated renderer entry instead of loading the main ShellX app",
);
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
  appSource.includes("isRendererDebugUiPatch(payload?.patch)") &&
    appSource.includes("!debugUiStateTargetsBrowser(state)") && debugUiConnectionSource.includes('if (surface === "app") return false') &&
    debugUiConnectionSource.includes('source.includes("browser")'),
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
  browserShellEffectsSource.includes(".shellx-browser-left-sidecar") &&
    browserShellEffectsSource.includes("shellx-browser-header-menu-wrap") &&
    browserShellEffectsSource.includes("setHeaderMenu(null)"),
  "browser left sidecars stay open while users click inside them",
);
assert(browserChromeSource.includes("<span>Agent</span>"), "browser chrome presents the window as Agent");
assert(!browserChromeSource.includes("<span>ShellX Browser</span>"), "browser chrome removes the old ShellX Browser title text");
assert(browserChromeSource.indexOf("className=\"shellx-browser-tab-strip\"") < browserChromeSource.indexOf("className=\"shellx-browser-address-row\""), "browser tabs sit above the active-tab address toolbar");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-address\""), "browser UI address bar has debug id");
assert(
  uiSource.includes("const addressSourceUrl =") &&
    uiSource.includes("state?.engine?.url?.trim()") &&
    browserShellEffectsSource.includes("setAddress(addressSourceUrl)") &&
    browserShellEffectsSource.includes("[addressEditing, addressSourceUrl, setAddress]"),
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
assert(
  browserMenusSource.includes('data-shellx-release-observe="value title"')
    && browserMenusSource.includes("Browser homepage state: storage=")
    && browserMenusSource.includes("Browser color state: applied="),
  "browser preferences expose only bounded value and canonical persistence receipts",
);
assert(
  browserShellEffectsSource.includes("persistBrowserHomeUrl(homeUrl)")
    && browserPreferencesSource.includes("window.localStorage.removeItem(HOME_URL_STORAGE_KEY)")
    && browserPreferencesSource.includes("window.localStorage.setItem(HOME_URL_STORAGE_KEY, normalized)"),
  "browser homepage setting is persisted locally without retaining a redundant default",
);
assert(browserChromeSource.indexOf("data-debug-id=\"shellx-browser-home\"") < browserChromeSource.indexOf("data-debug-id=\"shellx-browser-address\""), "browser homepage button is before the address bar");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-copy-address\""), "browser UI can copy the current address from the address bar");
assert(browserChromeSource.includes("className=\"shellx-browser-address-copy\""), "browser UI styles address copy like an inline code action");
assert(agentSidebarSource.includes("data-debug-id=\"shellx-browser-console\""), "browser UI exposes console log panel");
assert(browserChromeSource.includes("data-debug-id=\"shellx-browser-options\""), "browser UI exposes options panel toggle");
assert(
  browserShellEffectsSource.includes("shellx-browser-header-menu-wrap") &&
    browserShellEffectsSource.includes("shellx-browser-options-wrap") &&
    browserShellEffectsSource.includes("shellx-browser-chrome-menu-dock") &&
    browserShellEffectsSource.includes("shellx-browser-left-sidecar") &&
    browserShellEffectsSource.includes("shellx-browser-shields-wrap"),
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
assert(browserMenusSource.includes('data-debug-id="shellx-browser-ad-mode-default"'), "browser ad filter menu can restore the profile global default");
assert(uiSource.includes("clearProfileAdMode: true"), "browser UI sends an explicit profile ad-mode clear request");
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
assert(browserPersonalLockSource.includes("showBlockedNotice") && uiSource.includes("shellx-browser-personal-lock-notice") && browserPersonalLockSource.includes("Personal Browser Lock is on."), "browser locked personal-tab actions show a structured unlock notice");
assert(browserPersonalLockSource.includes("focusToggle") && browserPersonalLockSource.includes("document.querySelector<HTMLButtonElement>") && browserPersonalLockSource.includes("?.focus()"), "browser locked personal-tab actions focus the lock control");
assert(browserVaultFillSource.includes("setVaultError") && browserVaultFillPanelSource.includes("shellx-browser-vault-fill-unavailable"), "browser Vault fill surfaces locked/unavailable Vault state instead of silently showing no matches");
assert(browserVaultFillSource.includes("window.setInterval(refreshVaultFillEntries, 8_000)"), "browser Vault fill periodically refreshes saved-secret metadata after Vault unlock");
assert(
  browserVaultFillCandidateSource.includes("pageEmailsForVaultFill") &&
    browserVaultFillCandidateSource.includes("browserVaultOriginContext") &&
    browserVaultFillCandidateSource.includes("observedContext.origin !== pageContext.origin") &&
    browserVaultFillCandidateSource.includes("vaultFillOriginScore") &&
    browserVaultFillCandidateSource.includes("if (originScore <= 0) continue") &&
    browserVaultFillCandidateSource.includes("vaultFillAccountScore") &&
    browserVaultFillCandidateSource.includes("entry.resourceFields") &&
    browserVaultFillCandidateSource.includes("emailAddressesForVaultFill") &&
    browserVaultFillSource.includes("buildBrowserVaultFillCandidates"),
  "browser Vault fill binds saved credentials to the current observed origin and Vault metadata",
);
assert(
  browserVaultFillCandidateSource.includes("browserVaultSiteDomain") && browserVaultFillCandidateSource.includes("VAULT_FILL_COMMON_SECOND_LEVEL_SUFFIXES") &&
    browserVaultFillCandidateSource.includes('"ac", "co", "com", "edu", "gov", "mil", "net", "org", "sch"'),
  "browser Vault fill does not treat common compound public suffixes as credential site domains",
);
assert(
  !browserVaultFillCandidateSource.includes("vaultFillPasswordFallbackAllowed") &&
    !browserVaultFillCandidateSource.includes("Possible Vault password") &&
    !browserVaultFillCandidateSource.includes("fallbackCandidates"),
  "browser Vault fill never offers generic password fallbacks when origin metadata is absent",
);
assert(browserChromeSource.includes("shellx-browser-handoff-tab"), "browser UI exposes handoff-to-agent action");
assert(browserChromeSource.includes("shellx-browser-take-back-tab"), "browser UI exposes takeback action for delegated tabs");
assert(browserMenusSource.includes("shellx-browser-personal-lock-sleep"), "browser options expose lock-after-sleep control");
assert(browserMenusSource.includes("shellx-browser-personal-lock-minimize"), "browser options expose lock-on-minimize control");
assert(browserPersonalLockSource.includes("isMinimized()"), "browser personal lock can react to minimized desktop windows");
assert(browserPersonalLockSource.includes("driftMs < 120_000"), "browser personal lock can react to resume-after-sleep timer drift");
assert(browserChromeSource.includes("shellx-browser-close-tab-"), "browser UI exposes per-tab close actions");
assert(browserChromeSource.includes("className=\"shellx-browser-tab-close\""), "browser UI has a dedicated tab close hit target");
assert(browserChromeSource.includes("shellx-browser-tab-profile-marker"), "browser tabs carry compact profile markers");
assert(
  browserChromeSource.includes("data-debug-id=\"shellx-browser-tab-ownership-banner\"") &&
    browserChromeSource.includes("data-owner-kind={activeBrowserTab?.ownerKind ?? \"user\"}") &&
    browserChromeSource.includes("data-profile-id={activeBrowserTab?.profileId ?? \"\"}"),
  "browser chrome exposes active tab ownership from agent-visible tab metadata",
);
assert(
  browserChromeSource.includes("Agent is using this tab") &&
    browserChromeSource.includes("Delegated to agent") &&
    browserChromeSource.includes("Personal tab") &&
    browserChromeSource.includes("Disposable task tab"),
  "browser chrome labels personal, agent, delegated, and disposable tab ownership",
);
assert(
  browserChromeSource.includes("BrowserTabOwnershipStatus | null") &&
    browserChromeSource.includes('tab.profileId === "personal" && !tab.lock') &&
    browserChromeSource.includes("return null;"),
  "browser chrome hides redundant ownership banner for normal unlocked personal tabs",
);
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
    bookmarkToolbarSource.includes("BookmarkToolbar") &&
    bookmarkToolbarSource.includes('data-debug-id="shellx-browser-bookmark-toolbar"') &&
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
  browserEngineRuntimeSource.includes(".on_new_window(move |url, _features|") &&
    browserEngineRuntimeSource.includes("NewWindowResponse::Deny") &&
    browserEngineRuntimeSource.includes("record_popup_event") &&
    browserEngineRuntimeSource.includes("requires_approval: true") &&
    !browserEngineRuntimeSource.includes("fn install_browser_page_tab_behavior") &&
    browserEngineRuntimeSource.includes("browser_page_context_menu_initialization_script"),
  "Browser popups are denied and routed into ShellX approval semantics by the cross-platform native builder while the injected page context menu remains available",
);
assert(
  rustBrowserModel.includes("BrowserNativeSecurityCapabilities") &&
    rustBrowserModel.includes("full_native_protection: windows_native_hooks") &&
    rustBrowserState.includes("BrowserNativeSecurityCapabilities::current()") &&
    browserTypesSource.includes("nativeSecurity?: BrowserNativeSecurityCapabilities") &&
    uiSource.includes("BrowserNativeSecurityNotice") &&
    browserNativeSecurityNoticeSource.includes("shellx-browser-native-security-notice") &&
    browserNativeSecurityNoticeSource.includes("capabilities.fullNativeProtection"),
  "Browser state and UI expose native security-hook degradation instead of treating non-Windows stubs as installed protection",
);
