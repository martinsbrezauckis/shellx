import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isTaskRuntimeTabId } from "../../src/lib/task-runtime-tab";

const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../../src-tauri/src/task_runtime_app.rs", import.meta.url), "utf8");
const archive = readFileSync(new URL("../../src-tauri/src/task_conversation.rs", import.meta.url), "utf8");
const adapter = readFileSync(new URL("../../src-tauri/src/task_execution_store_adapter.rs", import.meta.url), "utf8");
const trace = readFileSync(new URL("../../src-tauri/src/task_trace_evidence.rs", import.meta.url), "utf8");
const projection = readFileSync(new URL("../../src-tauri/src/task_state_projection.rs", import.meta.url), "utf8");

assert.equal(isTaskRuntimeTabId("task-run-0123456789abcdef0123456789abcdef"), true);
assert.equal(isTaskRuntimeTabId("provider-session-0123456789abcdef0123456789abcdef"), false);
assert.equal(isTaskRuntimeTabId("task-run-short"), false);

assert.match(app, /if \(isTaskRuntimeTabId\(tabKey\)\) return null;/);
assert.match(app, /if \(tag && !isTaskRuntimeTabId\(tag\)\)/);
assert.match(runtime, /TaskConversationArchive::new\(\)/);
assert.match(runtime, /conversations\.begin\(/);
assert.match(runtime, /conversations\.finish\(/);
assert.match(runtime, /collect_task_trace_evidence\(/);
assert.match(runtime, /retry_missing_trace_evidence\(\)/);
assert.match(archive, /TASK_CONVERSATION_QUEUE_CAPACITY: usize = 1_024/);
assert.match(archive, /task-run-terminal/);
assert.match(archive, /→ prompt:/);
assert.match(adapter, /session_id: session_id_from_evidence/);
assert.match(adapter, /fn session_id_from_evidence/);
assert.match(trace, /shellx\.task-trace-evidence\.v1/);
assert.match(trace, /source_terminal_receipt_hash/);
assert.match(trace, /recovered_after_restart/);
assert.match(trace, /dropped_event_count/);
assert.match(projection, /evidence\.conversation_session_id\.clone\(\)/);
assert.doesNotMatch(projection, /provider_decision[\s\S]{0,180}session_id/);

console.log("task conversation archive contract: ok");
