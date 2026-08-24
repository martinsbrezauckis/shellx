import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const profiles = readFileSync(resolve(root, "src-tauri/src/shellx_browser_profiles.rs"), "utf8");
const runtime = [
  "src-tauri/src/shellx_browser_engine_runtime.rs",
  "src-tauri/src/shellx_browser_engine_lifecycle.rs",
  "src-tauri/src/shellx_browser_engine_webview_config.rs",
].map((path) => readFileSync(resolve(root, path), "utf8")).join("\n");
const roots = [
  "src-tauri/src/shellx_browser_ephemeral_roots.rs",
  "src-tauri/src/shellx_browser_ephemeral_lifecycle.rs",
].map((path) => readFileSync(resolve(root, path), "utf8")).join("\n");
const rootTests = readFileSync(resolve(root, "src-tauri/src/shellx_browser_ephemeral_roots_tests.rs"), "utf8");
const persistence = readFileSync(resolve(root, "src-tauri/src/shellx_browser_persistence.rs"), "utf8");
const storageState = readFileSync(resolve(root, "src-tauri/src/shellx_browser_storage_state.rs"), "utf8");
const debugState = readFileSync(resolve(root, "src-tauri/src/debug_api_browser_state.rs"), "utf8");

assert.match(
  profiles,
  /profile_id: "task-disposable"[\s\S]*?persistent: false,[\s\S]*?storage_root: None,/,
  "the public disposable profile cannot advertise a deterministic storage path",
);
assert(runtime.includes("disposable_webview_storage_root"), "native Browser mount resolves a task/engine-owned disposable root");
assert(runtime.includes("mark_disposable_webview_mounted"), "native Browser mount records the lease only after creation succeeds");
assert(runtime.includes("cleanup_disposable_root_owner_after_engine_close"), "profile changes close old disposable WebViews before cleanup");
assert(runtime.includes("cleanup_unmounted_disposable_mount_failure"), "failed native child creation releases only an unmounted lease");
assert(runtime.includes("close_and_cleanup_failed_browser_engine_mount"), "initialization and lease-activation failures close before cleanup");
assert(runtime.includes("if close_error.is_none() && release_error.is_none()"), "failed initialization cannot delete storage before close and label release");
assert(runtime.includes("native lease activation rollback"), "failed lease activation rolls back its newly mounted WebView");
assert(runtime.includes("cleanup_unmounted_disposable_root_after_replacement_failure"), "failed engine replacement cleans only its new unmounted owner");
assert(runtime.includes("record_disposable_cleanup_deferred_for_owner"), "failed replacement preserves and records the old live owner lease");
assert(runtime.includes("handle_disposable_engine_recreation_failure"), "all recreation failures use one disposable-owner deferral path");
assert(runtime.includes("if let Some(previous_owner) = active_disposable_root_owner"), "disposable to agent-work recreation records its active owner even without a replacement root");
assert(runtime.includes("if replacement_root_is_new"), "same-root filter recreation defers the active owner without deleting it");
assert(runtime.includes("existing native WebView because close failed"), "close failures take the owner deferral path");
assert(runtime.includes("native WebView label release was not confirmed"), "label-release failures take the owner deferral path");
assert.equal((runtime.match(/handle_disposable_engine_recreation_failure\(/g) ?? []).length, 3, "the shared handler definition plus both close and label-release failure paths cover disposable-to-agent-work and same-root recreation");
assert(roots.includes("EPHEMERAL_ROOT_MARKER"), "cleanup requires a ShellX ownership marker");
assert(roots.includes("reject_symlinks_below"), "cleanup rejects symlinked root trees");
assert(roots.includes("Browser ephemeral cleanup refused a persistent Browser profile root"), "cleanup refuses persistent Browser roots");
assert(roots.includes("scavenge_owned_ephemeral_roots"), "startup retries only owned stale roots");
assert(roots.includes("try_lock_exclusive"), "startup scavenging takes an OS process lock before deletion");
assert(roots.includes("*process_lock = Some(lock)"), "the winning process retains its scavenging lock for its lifetime");
assert(roots.includes("const EPHEMERAL_ROOT_SCHEMA_VERSION: u32 = 2"), "only post-lock marker schema roots are startup-scavenged");
assert(rootTests.includes("startup_scavenging_refuses_and_preserves_prelock_schema_roots"), "pre-lock marker schema regression preserves old roots");
assert(rootTests.includes("startup_scavenging_cross_process_lock_protocol"), "native test executable exercises A hold, B skip, then C cleanup");
assert(rootTests.includes("SHELLX_EPHEMERAL_SCAVENGE_HELPER_MODE"), "cross-process regression uses explicit helper modes rather than a shell");
assert(rootTests.includes("struct OwnedScavengeHelper"), "cross-process helpers are RAII-owned and reaped on parent panic paths");
assert(rootTests.includes("impl Drop for OwnedScavengeHelper"), "cross-process helper drop terminates and waits for active children");
assert(rootTests.includes("startup_scavenging_invalid_lock_path_preserves_owned_root"), "invalid lock acquisition paths preserve owned roots");
assert(persistence.includes("startup_scavenge_owned_ephemeral_roots"), "constructor uses the process-locked startup scavenger rather than raw deletion");
assert(roots.includes("browserEphemeralStorageCleanupDeferred"), "failed deletion is recorded as deferred rather than successful");
assert(roots.includes("record_disposable_cleanup_deferred_for_engine"), "native close/release failure retains the lease and records startup deferral");
assert(roots.includes("cleanup_candidates_for_engine"), "deferred cleanup observes a lease without releasing or deleting it");
assert(roots.includes("task terminal cleanup retained the lease because native WebView close/release failed"), "task completion and abort record deferred cleanup when native close fails");
assert(roots.includes("shellx_browser::close_browser_engine_webview"), "task cleanup uses the Browser module's native WebView close helper before removing a lease");
assert(storageState.includes("if profile.persistent"), "the storage-state manifest withholds the ephemeral absolute root");
assert(debugState.includes("close_disposable_task_webviews_and_cleanup"), "task completion and abort close native WebViews before cleanup");

console.log("ShellX Browser disposable-profile source contract passed");
