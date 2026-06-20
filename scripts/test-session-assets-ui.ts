import { readFileSync } from "node:fs";

const app = readFileSync("src/App.tsx", "utf8");
const board = readFileSync("src/components/AttachmentMediaBoard.tsx", "utf8");
const css = readFileSync("src/App.css", "utf8");
const rust = readFileSync("src-tauri/src/lib.rs", "utf8");
const debugApi = readFileSync("src-tauri/src/debug_api.rs", "utf8");
const apiDocs = readFileSync("docs/API.md", "utf8");
const tauriConf = readFileSync("src-tauri/tauri.conf.json", "utf8");

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== session assets UI and broker wiring ===");

assert(app.includes("extractSessionAssetRegistry"), "App builds a session asset registry from events and tabs");
assert(app.includes("sessionAssetRegistry.all"), "App passes all reusable assets to the asset board");
assert(app.includes("previewFileContext"), "Preview Center can use source-tab file context");
assert(app.includes("const previewDebugTarget = {"), "Preview Center posts source-tab context to debug API");
assert(app.includes("tabId: previewTabId") && app.includes("sessionCwd: tabCwd"), "Preview debug target includes tab id and session cwd");
assert(app.includes("copy_asset_to_scope"), "App imports provider assets through the backend broker");
assert(app.includes("sourceTabId: asset.sourceTabId"), "asset preview/import uses source tab metadata");
assert(app.includes("targetTabId: targetTab?.tabId"), "asset import passes target tab metadata");

assert(board.includes("Reusable assets"), "Asset board exposes a reusable assets section");
assert(board.includes("onPreviewAsset"), "Asset board has source-aware asset preview action");
assert(board.includes("onAttachAsset"), "Asset board has attach action for imported assets");
assert(board.includes("onImportAsset"), "Asset board has import action");
assert(board.includes("assetSourceLabel"), "Asset board shows source metadata for assets");

assert(css.includes("width: min(94vw, 1280px);"), "Asset board modal is wide enough for the extra column");
assert(css.includes("grid-template-columns: repeat(5, minmax(0, 1fr));"), "Asset board uses five desktop columns");

assert(rust.includes("async fn copy_asset_to_scope"), "Rust backend exposes asset import command");
assert(rust.includes("\"asset import into SSH sessions is not supported yet"), "SSH target import fails explicitly");
assert(rust.includes("join_provider_visible_path"), "asset import returns provider-visible paths");
assert(rust.includes("copy_asset_to_scope,"), "asset import command is registered with Tauri");
assert(rust.includes("copy_asset_to_scope") && rust.includes("provider_registry: State<'_, Arc<provider_sessions::ProviderSessionRegistry>>") && rust.includes("source_tab_id"), "asset import command wires source_tab_id + provider_registry for WSL/SSH provider tab asset handoff and source context lookup");
assert(rust.includes("provider_registry: State<'_, Arc<provider_sessions::ProviderSessionRegistry>>"), "media preview fallback can inspect provider session transport");
assert(rust.includes("preview_session_context(&registry, Some(provider_registry.inner()), &tab_key)"), "media preview fallback uses provider tab context when no Grok session exists");
assert(!tauriConf.includes("\"$HOME/.grok/**\""), "Tauri asset protocol does not expose all ~/.grok");
assert(tauriConf.includes("\"$HOME/.grok/sessions/**\""), "Tauri asset protocol allows Grok session media");
assert(tauriConf.includes("\"$HOME/.grok/shellx-preview-screenshots/**\""), "Tauri asset protocol allows ShellX preview screenshots");

assert(debugApi.includes("\"/state/session_assets\""), "Debug API exposes session asset state");
assert(debugApi.includes("debug_collect_session_assets_for_tabs"), "Debug API derives assets from the event ring");
assert(apiDocs.includes("GET /state/session_assets"), "API docs document the session asset endpoint");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} session assets UI tests`);
process.exit(failures === 0 ? 0 : 1);
