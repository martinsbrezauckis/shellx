import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readRustModuleFamily } from "./read-rust-module-family";

import {
  DEBUG_UI_CONNECT_TIMEOUT_MS,
  DEBUG_UI_RETRY_MAX_MS,
  DEBUG_UI_DISCONNECTED_POLL_MS,
  DEBUG_UI_POLL_MS,
  debugUiPollDelay,
  debugUiPollingEnabled,
  debugUiRetryDelay,
} from "../src/lib/debug-ui-connection";

assert.equal(debugUiRetryDelay(0, () => 0), 800);
assert.equal(DEBUG_UI_CONNECT_TIMEOUT_MS, 5_000);
assert.equal(debugUiRetryDelay(0, () => 0.5), 1_000);
assert.equal(debugUiRetryDelay(1, () => 0.5), 2_000);
assert.equal(debugUiRetryDelay(4, () => 0.5), 16_000);
assert.equal(debugUiRetryDelay(30, () => 1), DEBUG_UI_RETRY_MAX_MS);
assert.equal(debugUiRetryDelay(Number.NaN, () => Number.NaN), 1_000);
assert(debugUiRetryDelay(3, () => 0) < debugUiRetryDelay(3, () => 1));
assert.equal(debugUiPollingEnabled("connected"), true);
assert.equal(debugUiPollingEnabled("connecting"), false);
assert.equal(debugUiPollingEnabled("disconnected"), true);
assert.equal(debugUiPollDelay("connected"), DEBUG_UI_POLL_MS);
assert.equal(debugUiPollDelay("disconnected"), DEBUG_UI_DISCONNECTED_POLL_MS);
assert(DEBUG_UI_DISCONNECTED_POLL_MS > DEBUG_UI_POLL_MS);

const readSource = (path: string): string => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const app = readSource("src/App.tsx");
const banner = readSource("src/components/DebugApiConnectionBanner.tsx");
const errorBoundary = readSource("src/components/ErrorBoundary.tsx");
const rustLib = readSource("src-tauri/src/lib.rs");
const rustDebugApi = readRustModuleFamily("src-tauri/src/debug_api.rs").replaceAll("\r\n", "\n");
const rustScreenshot = readSource("src-tauri/src/debug_api_screenshot.rs");
const rustGithubApi = readSource("src-tauri/src/debug_api_diagnostics_github.rs");
const start = app.indexOf("// DEBUG_UI_CONNECTION_OWNER_START");
const end = app.indexOf("// DEBUG_UI_CONNECTION_OWNER_END");
assert(start >= 0 && end > start, "App must delimit the single Debug UI connection owner");
const owner = app.slice(start, end);
assert(owner.includes("debugUiRetryDelay"), "connection owner must use bounded exponential backoff");
assert(
  owner.includes("nextSocket.readyState !== WebSocket.CONNECTING") &&
    owner.includes("}, DEBUG_UI_CONNECT_TIMEOUT_MS);"),
  "a stalled WebSocket handshake must enter the backed-off HTTP fallback",
);
assert(owner.includes("debugUiPollingEnabled"), "connection owner must gate fallback polling on connection state");
assert(owner.includes("debugUiPollDelay"), "connection owner must slow fallback polling while disconnected");
assert(
  owner.includes('invoke<Record<string, unknown>>("debug_ui_snapshot")') &&
    owner.includes('apiGet<Record<string, unknown>>("/state/ui")'),
  "packaged renderers must read Debug UI state over IPC with an HTTP development fallback",
);
assert(
  owner.includes("const pollNativeUiState = async") &&
    owner.includes("void pollNativeUiState();") &&
    owner.includes("nativeStatePollTimer !== null"),
  "native Debug UI polling must run independently of WebSocket state and clean up its timer",
);
const nativePoll = owner.slice(owner.indexOf("const pollNativeUiState"), owner.indexOf("const scheduleReconnect"));
assert(
  nativePoll.includes("revision !== lastAppliedUiRevision") &&
    nativePoll.includes("applyAuthoritativeUiState(state)"),
  "native snapshot polling must not reapply an already-consumed authoritative revision",
);
assert(
  owner.indexOf("void pollNativeUiState();") < owner.indexOf('listen<{ patch?: unknown; state?: Record<string, unknown> }>("debug-ui-state-patch"'),
  "native snapshot polling must start before fallible event-bridge registration",
);
assert(
  owner.includes("revision === lastAppliedUiRevision") &&
    owner.includes("applyAuthoritativeUiPatch(payload?.patch, payload?.state)"),
  "native and WebSocket delivery must deduplicate transient commands by authoritative revision",
);
assert(
  owner.includes('source: "renderer-native-poll-error"') &&
    owner.includes('action: "nativeStatePoll"') &&
    owner.includes("String(error).slice(0, 500)") &&
    !owner.includes("nativeStatePollErrorReported && inTauri()"),
  "native snapshot rejection must publish one bounded diagnostic receipt",
);
assert(
  owner.includes('publishConnectionStatus("disconnected");\n      startFallbackPolling();'),
  "disconnected WebSockets must retain a backed-off HTTP state fallback",
);
assert(owner.includes('document.addEventListener("visibilitychange"'), "visibility changes must reset recovery immediately");
assert(owner.includes('window.addEventListener("shellx:debug-api-retry"'), "explicit Retry must reach the connection owner");
assert(!owner.includes("setInterval"), "connection owner must use status-gated recursive polls, not unconditional intervals");
assert(!owner.includes("4000)"), "connection owner must not regress to a fixed four-second retry loop");
assert(
  app.includes("<DebugApiConnectionBanner") &&
    app.includes("setDebugUiConnectionFixture(null);") &&
    app.includes('window.dispatchEvent(new Event("shellx:debug-api-retry"))'),
  "App must clear the diagnostic override and dispatch a real reconnect from Retry",
);
assert(
  rustDebugApi.includes('rename = "debugUiWebSocketActive"')
    && rustDebugApi.includes('rename = "debugUiWebSocketGeneration"')
    && rustDebugApi.includes("begin_debug_websocket_connection")
    && rustDebugApi.includes("debug_websocket_metrics"),
  "Debug API health must expose active and monotonic event-stream reconnect telemetry",
);
assert(
  rustScreenshot.includes("capture_window_label_png(&s.app, &label).await")
    && rustScreenshot.includes("title.eq_ignore_ascii_case(\"shellX\")")
    && rustScreenshot.indexOf("capture_window_label_png(&s.app, &label).await")
      < rustScreenshot.indexOf("let windows = xcap::Window::all().unwrap_or_default();"),
  "non-Windows /screenshot must use exact Tauri window identity before generic xcap enumeration",
);
assert(
  !app.includes("running outside Tauri (Vite-only / browser preview)")
    && banner.includes("Desktop services disconnected"),
  "browser-preview diagnostics must use the disconnected banner instead of synthetic chat transcript rows",
);
assert(
  banner.includes('data-debug-id="debug-api-disconnected"') &&
    banner.includes('data-debug-id="debug-api-retry"') &&
    banner.includes('status !== "disconnected"'),
  "disconnected banner must be stable, state-bound, and testable",
);
assert(
  rustLib.includes("fn debug_ui_snapshot") &&
    rustLib.includes("hub.ui_snapshot()") &&
    rustLib.includes("debug_ui_snapshot,"),
  "the Tauri command surface must expose the shared Debug UI snapshot",
);
assert(
  rustDebugApi.includes('state.app.emit("debug-ui-state-patch", payload)') &&
    owner.includes('listen<{ patch?: unknown; state?: Record<string, unknown> }>("debug-ui-state-patch"') &&
    owner.includes("unlistenDebugUiPatch?.();"),
  "accepted external Debug UI patches must reach packaged renderers over a cleaned-up native event",
);
assert(
  rustDebugApi.includes('rename = "refreshPastChats"')
    && owner.includes('p.refreshPastChats === true')
    && owner.includes('"refreshPastChats"'),
  "the stored-session refresh command must remain a transient authenticated renderer relay",
);
assert(
  errorBoundary.includes('invoke("renderer_error"') &&
    rustLib.includes('"renderer-error"') &&
    rustLib.includes("renderer_error,"),
  "top-level renderer failures must reach the authenticated Debug API event ring",
);
assert(
  app.includes('p.releaseTestRendererCrash === true')
    && app.includes('throw new Error("SHELLX_RELEASE_TEST_RENDERER_CRASH_035")')
    && rustDebugApi.includes("release_test_renderer_crash")
    && rustDebugApi.includes("isolated_test_instance_requested")
    && rustDebugApi.includes("release-test renderer crash is unavailable outside an isolated test instance"),
  "ErrorBoundary release proof must use one isolated-only transient renderer crash command",
);
assert(
  app.includes('p.releaseTestVoiceCapture === "recording"')
    && app.includes('p.releaseTestVoiceCapture === "clear"')
    && app.includes('"releaseTestVoiceCapture"')
    && rustDebugApi.includes("release_test_voice_capture")
    && rustDebugApi.includes('matches!(command, "recording" | "clear")')
    && rustDebugApi.includes("release-test voice capture is unavailable outside an isolated test instance"),
  "voice cancel release proof must use one isolated-only transient synthetic capture command",
);
assert(
  app.includes('p.debugUpdateFixture === "owned-check"')
    && app.includes('p.debugUpdateFixture === "owned-available"')
    && rustDebugApi.includes("debug_update_fixture")
    && rustDebugApi.includes('matches!(command, "owned-check" | "owned-available" | "clear")')
    && rustDebugApi.includes("release-test updater fixture is unavailable outside an isolated test instance"),
  "updater release proof must use one isolated-only non-network fixture boundary",
);
assert(
  app.includes('p.releaseTestExternalEffectBoundary === "pr-create"')
    && app.includes('p.releaseTestExternalEffectBoundary === "artifact-archive"')
    && app.includes('releaseTestBoundary={releaseTestExternalEffectBoundary === "pr-create"}')
    && app.includes('releaseTestBoundary={releaseTestExternalEffectBoundary === "artifact-archive"}')
    && rustDebugApi.includes("release_test_external_effect_boundary")
    && rustDebugApi.includes('matches!(command, "pr-create" | "artifact-archive" | "clear")')
    && rustDebugApi.includes("release-test external-effect boundary is unavailable outside an isolated test instance"),
  "external-effect release proof must use one isolated-only transient renderer boundary",
);
const prBoundary = rustGithubApi.indexOf('if let Some(boundary) = body.release_test_boundary.as_deref()');
const prSessionLookup = rustGithubApi.indexOf("let cwd = {");
assert(
  prBoundary >= 0
    && prSessionLookup > prBoundary
    && rustGithubApi.includes('boundary != "stop-before-remote"')
    && rustGithubApi.includes("crate::isolated_test_instance_requested()")
    && rustGithubApi.includes("StatusCode::PRECONDITION_FAILED")
    && rustGithubApi.includes('"release_test_remote_mutation_blocked"'),
  "PR release boundary must validate approval and owned inputs before session lookup, gh resolution, subprocess creation, or GitHub contact",
);

console.log("Debug UI connection backoff checks passed");
