import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("src-tauri/src/task_runtime_app.rs", "utf8");
const root = readFileSync("src-tauri/src/lib.rs", "utf8");
const tasks = readFileSync("src-tauri/src/tasks.rs", "utf8");
const occurrences = readFileSync("src-tauri/src/task_store_occurrences.rs", "utf8");

assert.match(app, /state::<Arc<TaskStoreService>>\(\)[\s\S]*\.execution_store\(\)/, "runtime must share the one managed durable Task store");
assert.doesNotMatch(app, /TaskStore::(?:open|open_default)/, "runtime must not open a second Task store");
assert.match(app, /TaskRuntimeAuthority::canonical\(\)/, "runtime must use the canonical fresh connection and provider authority");
assert.match(app, /TaskExternalProviderRuntime::new/, "external Tasks must reuse normalized provider sessions");
assert.match(app, /TaskGrokAcpRuntime::new/, "Grok Tasks must reuse the ACP runtime");
assert.match(app, /set_lifecycle_observer\(Some\(observer\)\)/, "Grok lifecycle observer must be session-owned");
assert(
  app.indexOf("set_lifecycle_observer(Some(observer))") < app.indexOf("start_fresh_task_grok_session"),
  "redacted lifecycle observer must bind before Grok starts",
);
assert.match(app, /cleanup_normal_tab_session/, "Task Grok cleanup must reuse the full normal tab-close lifecycle");
assert.match(app, /TaskForegroundServiceConfig::new/, "runtime must use a bounded owner and lease configuration");
assert.match(app, /TASK_RUNTIME_POLL_INTERVAL/, "polling must remain app-owned and bounded");
assert.match(app, /impl TaskRuntimeProgressObserver[\s\S]*attemptActive/, "cancellable attempts must wake the Task UI without forwarding provider output");
assert.match(app, /\.with_progress_observer\(Arc::new\(AppTaskRuntimeProgressObserver/, "the app runtime must install the output-free progress observer");
assert.match(app, /fn task_terminal_notification_body\([\s\S]*TaskNotificationPolicy::AttentionOnly[\s\S]*TaskNotificationPolicy::EveryTerminalResult/, "desktop notifications must obey the immutable Task policy");
assert.match(app, /complete_occurrence|receipt-backed status/, "desktop notification copy must describe durable receipt-backed state");
assert.match(app, /record_notification_attempt/, "desktop notification delivery must append its exact occurrence receipt");
assert(
  app.indexOf("record_notification_attempt") < app.indexOf(".notification()"),
  "notification-attempt evidence must persist before invoking the OS integration",
);
assert.match(app, /if !notification_attempt\.should_deliver[\s\S]*return;/, "a durable notification receipt must suppress duplicate OS delivery");
assert.doesNotMatch(app, /\.body\([^\n]*(?:draft\.name|instruction|provider_id)/, "desktop notification bodies must not include user or provider content");
assert.doesNotMatch(app, /(?:auth\.json|GROK_AUTH_PATH|CODEX_HOME|ANTHROPIC_API_KEY|login|logout)/, "runtime wiring must not touch provider authentication");

assert.match(root, /task_runtime_app::install_task_runtime\(_app\)/, "Tauri setup must install the foreground Task runtime");
assert.match(root, /TaskRuntimeAppState[\s\S]*task_runtime\.shutdown\(\)\.await/, "main-window teardown must request a durable Task shutdown");
assert.match(root, /cleanup_normal_tab_session\([\s\S]*registry\.drop_tab/, "interactive and Task tabs must share one cleanup implementation");
assert.match(root, /tasks_run_now/, "the exact-revision Run now command must be registered");
assert.match(root, /tasks_cancel_run/, "the exact-attempt cancellation command must be registered");
assert.match(app, /fn queue_manual_run\([\s\S]*create_manual_occurrence\([\s\S]*handoff_pending_occurrence/, "the shared Run now boundary must persist before foreground handoff");
assert.match(tasks, /queue_manual_run\(/, "the Tauri command must use the shared durable Run now boundary");
assert.match(tasks, /revision_id[\s\S]*revision_hash/, "Run now must require immutable revision CAS identity");
assert.match(occurrences, /create_manual_occurrence[\s\S]*self\.transaction/, "manual occurrence creation must be one store transaction");

console.log("Task runtime app wiring contracts passed");
