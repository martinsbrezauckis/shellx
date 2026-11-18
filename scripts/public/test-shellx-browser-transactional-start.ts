import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const tasks = source("src-tauri/src/shellx_browser_tasks.rs");
const runtime = source("src-tauri/src/shellx_browser_window_runtime.rs");
const engineRuntime = source("src-tauri/src/shellx_browser_engine_runtime.rs");
const engineLifecycle = source("src-tauri/src/shellx_browser_engine_lifecycle.rs");
const webviewRuntime = source("src-tauri/src/shellx_browser_webview_runtime.rs");
const debugState = source("src-tauri/src/debug_api_browser_state.rs");
const cowork = source("src-tauri/src/shellx_browser_cowork.rs");
const metadata = source("src-tauri/src/build_metadata.rs");
const docs = source("docs/public/API.md");
const schemaRevision = metadata.match(/BROWSER_SCHEMA_REVISION: &str = "(\d{4}-\d{2}-\d{2})\.(\d+)"/);
const schemaDate = schemaRevision?.[1] ?? "";
const schemaSequence = Number(schemaRevision?.[2] ?? "0");
const rollbackSafeSchema = schemaDate > "2026-07-16"
  || (schemaDate === "2026-07-16" && schemaSequence >= 6);

assert(tasks.includes("rollback_failed_task_start") && tasks.includes("browserTaskStartRolledBack"), "registry owns failed-start rollback and an audit receipt");
assert(tasks.includes("close_tab(BrowserTabCloseRequest") && tasks.includes("set_active_tab(&mut state, previous_tab_id)"), "rollback closes provisional tabs and restores the prior active tab");
assert(tasks.includes("provisional_task_was_active"), "rollback preserves a newer human focus change");
assert(runtime.includes("rollback_failed_task_engine_sync") && runtime.includes("close_browser_engine_webview") && runtime.includes("sync_engine_to_tab_preserving_page"), "runtime rollback closes unused webviews and resyncs the prior engine");
assert(debugState.includes("browser_task_engine_sync_failed") && debugState.includes("rollback_failed_task_engine_sync") && debugState.includes("StatusCode::INTERNAL_SERVER_ERROR"), "Debug API returns structured rollback evidence for engine synchronization failures");
assert(cowork.includes("rollback_failed_task_engine_sync"), "Browser cowork uses the shared rollback-safe start path");
const initializationStart = engineRuntime.indexOf("let initialization: Result<(), String> = async {");
const credentialControls = engineRuntime.indexOf("install_browser_native_credential_controls(&webview).await?", initializationStart);
const permissionGate = engineRuntime.indexOf("install_browser_permission_gate(", credentialControls);
const strictRequestFilter = engineRuntime.indexOf("install_strict_browser_request_filter(", permissionGate);
const protectedNavigation = engineRuntime.indexOf("navigate_browser_webview(&webview, target_url.clone()).await?", strictRequestFilter);
assert(
  engineRuntime.includes('Url::parse("about:blank")')
    && initializationStart >= 0
    && credentialControls > initializationStart
    && permissionGate > credentialControls
    && strictRequestFilter > permissionGate
    && protectedNavigation > strictRequestFilter
    && webviewRuntime.includes('"starting Browser WebView2 navigation"')
    && webviewRuntime.includes("native.Navigate(&HSTRING::from(target_url))"),
  "new native engines remain on a blank page until every protection is installed and native navigation is acknowledged",
);
assert(
  engineRuntime.includes("Browser engine initialization failed")
    && engineRuntime.includes("close_and_cleanup_failed_browser_engine_mount(")
    && engineLifecycle.includes("webview.close()")
    && engineLifecycle.includes("wait_for_browser_engine_label_release(app, engine_label)")
    && engineLifecycle.includes("{context} closed the partial Browser engine"),
  "post-mount initialization failures close the partial engine and observe label release before returning",
);
assert(metadata.includes('"rollbackSafeTaskStart"') && rollbackSafeSchema, "Browser discovery advertises rollback-safe task start without regressing its schema revision");
assert(docs.includes("browser_task_engine_sync_failed") && docs.includes("rollback evidence"), "Browser API docs describe failed-start cleanup semantics");

console.log("ShellX Browser transactional-start contract tests passed");
