import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const runtime = source("src-tauri/src/shellx_browser_rendered_check.rs");
const evidenceRuntime = source("src-tauri/src/shellx_browser_rendered_check_evidence.rs");
const engineRuntime = source("src-tauri/src/shellx_browser_engine_runtime.rs");
const endpoint = source("src-tauri/src/debug_api_browser_rendered_check.rs");
const routes = source("src-tauri/src/debug_api_browser.rs");
const hostSpecs = source("src-tauri/src/host_mcp/browser_specs.rs");
const hostState = source("src-tauri/src/host_mcp/browser_state.rs");
const cli = source("scripts/shellx-browser-cli.ts");
const liveSmoke = source("scripts/test-shellx-browser-debug-api.ts");
const focusedLiveSmoke = source("scripts/test-shellx-browser-rendered-check-live.ts");
const metadata = source("src-tauri/src/build_metadata.rs");
const docs = source("docs/public/API.md");
const vite = source("vite.config.ts");

assert(runtime.includes("Semaphore::const_new(BROWSER_RENDERED_CHECK_MAX_PARALLEL)"), "rendered checks have a global concurrency cap");
assert(runtime.includes("run_on_main_thread") && runtime.includes("oneshot::channel"), "rendered checks create native windows and webviews on Tauri's main thread");
assert(runtime.includes("WebviewWindowBuilder::new") && runtime.includes("shellx-browser-rendered-check-runtime") && runtime.includes(".incognito(true)"), "rendered checks use an independent InPrivate WebView window without per-request profile buildup");
assert(runtime.includes("WebviewUrl::External(target_url)") && runtime.includes("validate_browser_navigation_target") && runtime.includes("initialization_script_for_all_frames(privacy_script)") && runtime.includes("initialization_script_for_all_frames(restriction_script)"), "rendered checks create the target WebView with navigation policy and document-start protections already attached");
assert(runtime.includes(".position(-32_000.0, -32_000.0)") && runtime.includes(".skip_taskbar(true)"), "rendered checks pin their unfocusable host window offscreen");
assert(runtime.includes("initialization_script_for_all_frames(privacy_script)") && runtime.includes("initialization_script_for_all_frames(restriction_script)"), "rendered-check privacy and network restrictions run as isolated document-start scripts");
assert(engineRuntime.includes("initialization_script_for_all_frames(browser_privacy_initialization_script") && engineRuntime.includes("browser_permission_report_initialization_script()") && engineRuntime.includes("browser_page_context_menu_initialization_script()"), "main Browser initialization concerns run as isolated document-start scripts");
assert(runtime.includes("page_ready") && runtime.includes("set_hidden_renderer_evidence_ready(&evidence_ready, true)"), "rendered checks arm bounded retrying evaluation after the protected child renderer is mounted");
assert(evidenceRuntime.includes("call_browser_engine_cdp_with_timeout") && evidenceRuntime.includes("platform.inner().run_javascript") && evidenceRuntime.includes("eval_with_callback") && evidenceRuntime.includes("evidence_ready.load(Ordering::Acquire)") && runtime.includes("return collect();"), "rendered evidence uses CDP on Windows, native WebKitGTK evaluation on Linux, and callback evaluation on macOS");
assert(runtime.includes(".on_new_window(|_, _| NewWindowResponse::Deny)") && runtime.includes(".on_download(|_, _| false)"), "rendered checks block popups and downloads");
assert(runtime.includes("connect-src 'self'") && runtime.includes("Cross-origin requests are blocked"), "rendered checks restrict page network activity to the rendered origin");
assert(runtime.includes("validate_browser_navigation_target") && runtime.includes("expected_domains"), "rendered checks enforce Browser navigation and private-network scope");
assert(runtime.includes("destroy_hidden_renderer") && runtime.includes("hiddenRendererDestroyed"), "rendered checks verify renderer cleanup");
assert(runtime.includes("webview.close()") && runtime.includes("get_window(parent_label)"), "rendered cleanup releases both Tauri webview and host-window registries");
assert(runtime.includes("Result<HiddenRendererGuard, BrowserRenderedCheckError>") && runtime.includes("Result<HiddenRendererGuard, String>") && runtime.includes("result_sender.send(result)"), "main-thread renderer creation transfers its cleanup guard or closes a late result after receiver timeout");
assert(runtime.includes('url.username = ""') && runtime.includes('url.password = ""'), "rendered checks redact URL user-info credentials");
assert(runtime.includes('"pageTextReturned": false') && runtime.includes('"queryAndFragmentReturned": false') && runtime.includes('"urlCredentialsReturned": false'), "rendered evidence is bounded and redacted");
assert(!runtime.includes("start_task") && !runtime.includes("push_receipt"), "rendered checks do not create Browser tasks or receipts");
assert(endpoint.includes('"/browser/rendered-check"') && routes.includes("browser_rendered_check_routes"), "Debug API registers the rendered-check endpoint");
assert(hostSpecs.includes('"name": "browser_rendered_check"') && hostSpecs.includes("visible native ShellX Browser") && hostSpecs.includes("not a general network sandbox"), "Host MCP advertises the hidden/cowork and network boundaries");
assert(hostState.includes("tool_browser_rendered_check") && hostState.includes('"/browser/rendered-check"'), "Host MCP calls the focused Debug API endpoint");
assert(cli.includes('case "rendered-check"') && cli.includes('"/browser/rendered-check"'), "installed Browser CLI exposes rendered checks");
assert(liveSmoke.includes("hidden rendered check leaves Browser registry revisions unchanged"), "live Debug API smoke proves no Browser registry mutation");
assert(focusedLiveSmoke.includes("Rendered ready") && focusedLiveSmoke.includes("hidden rendered check leaves Browser registry revisions unchanged"), "focused live smoke proves JavaScript rendering and revision invariance");
assert(metadata.includes('BROWSER_PROTOCOL_VERSION: &str = "1.5.0"') && metadata.includes('"hiddenRenderedCheck"'), "Browser protocol advertises rendered-check capability");
assert(docs.includes("browser_rendered_check") && docs.includes("human-cowork"), "Browser API docs explain the efficient hidden and visible cowork modes");
assert(vite.includes('ignored: ["**/src-tauri/target/**"]'), "Tauri dev excludes Cargo output from Vite watchers on Windows");

console.log("ShellX Browser rendered-check contract tests passed");
