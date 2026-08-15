import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(root, "src-tauri/src/debug_api_tasks.rs"), "utf8");
const router = readFileSync(resolve(root, "src-tauri/src/debug_api.rs"), "utf8");
const catalogue = readFileSync(resolve(root, "src-tauri/src/task_provider_catalog.rs"), "utf8");
const apiDocs = readFileSync(resolve(root, "docs/public/API.md"), "utf8");
const normalizedApiDocs = apiDocs.replace(/\s+/g, " ");

for (const route of [
  '"/tasks"',
  '"/tasks/states"',
  '"/tasks/provider-catalog"',
  '"/tasks/:task_id"',
  '"/tasks/:task_id/revise"',
  '"/tasks/:task_id/pause"',
  '"/tasks/:task_id/resume"',
  '"/tasks/:task_id/receipts"',
  '"/tasks/:task_id/state"',
  '"/tasks/:task_id/attention"',
  '"/tasks/:task_id/run"',
  '"/tasks/runs/:occurrence_id/cancel"',
  '"/tasks/:task_id/attention/:attention_id/resolve"',
  '"/tasks/:task_id/attention/overflow/resolve"',
]) {
  assert(source.includes(route), `Task Debug API route must remain declared: ${route}`);
}
assert(router.includes(".merge(tasks_http::task_routes())"), "Task routes must remain inside the authenticated Debug API router");
assert(router.includes("router.layer(middleware::from_fn(require_auth))"), "Task routes must inherit the Debug API bearer, loopback, and origin gate");
assert(source.includes("DefaultBodyLimit::max(TASKS_BODY_LIMIT_BYTES)"), "Task bodies require a dedicated transport cap");
assert(source.includes("TASKS_BODY_LIMIT_BYTES: usize = 4 * 1024 * 1024"), "Task body cap must remain bounded at 4 MiB");
assert(source.includes("JsonRejection"), "Task JSON parse failures must stay on the redacted Task error path");
assert(source.includes("fn parse_task_json"), "Task JSON parsing must not forward extractor diagnostics");
assert(source.includes("QueryRejection"), "Task receipt query failures must stay on the redacted Task error path");
assert(source.includes("fn parse_receipt_query"), "Task receipt queries must not forward extractor diagnostics");
assert(source.includes("validate_task_path_id"), "Task path identities must stay bounded before store access");
assert(source.includes("validate_receipt_limit"), "Task receipt reads must stay bounded");
assert(source.includes("validate_attention_limit"), "Task attention reads must stay bounded");
assert(source.includes("queue_manual_run("), "Task run API must reuse the receipt-first UI queue boundary");
assert(source.includes("cancellation().request"), "Task cancellation must bind to one exact active attempt");
assert(source.includes("TaskAttentionResolvePrecondition"), "Task attention acknowledgement must be CAS-bound");
assert(source.includes("task_revision_conflict"), "Task CAS conflicts must retain a stable public code");
assert(source.includes("task_attempt_not_active"), "stale Task cancellation must retain a stable conflict code");
assert(source.includes("task_attention_conflict"), "stale Task acknowledgement must retain a stable conflict code");
assert(source.includes("task_store_unavailable"), "Unknown storage failures must retain a redacted public code");
assert(source.includes("parse_connections_provider_scan_body"), "Task provider catalogues must reuse exact ConnectionPreset parsing");
assert(!source.includes("start_provider_session"), "Task Debug API must not bypass the foreground runtime with direct provider dispatch");
assert(!source.includes("host_mcp"), "Task Debug API must not create Host MCP tools");
assert(!source.includes('"/tasks/attachments"'), "durable attachment import must remain an operator-only Tauri action");

assert(catalogue.includes("safe_semantic_version_token"), "Task catalogue must reduce provider output to a safe semantic version token");
assert(catalogue.includes("public_availability_detail"), "Task catalogue must derive safe availability detail from typed status");
assert(!catalogue.includes("detail: provider.detail.clone"), "Task catalogue must not forward raw provider diagnostics");
assert(catalogue.includes("codex-cli 0.136.0"), "Task catalogue must retain a strict positive semantic-version fixture");
assert(catalogue.includes("token=secret"), "Task catalogue must retain a raw version refusal fixture");

for (const text of [
  "### First-class Tasks and provider catalogue",
  "`POST /tasks/provider-catalog`",
  "`/tasks/:task_id/run`",
  "`/tasks/runs/:occurrence_id/cancel`",
  "Tasks are not added to Host MCP",
  "A queued response proves durable acceptance only",
  "exactly one isolated ASCII semantic-version token",
  "binary paths, binary hashes and sizes, raw probe diagnostics",
  "`tasks_persist_attachments`",
  "`tasks_reclaim_attachments`",
  "`tasks_maintain_attachments`",
  "There is no Debug API or Host MCP equivalent",
]) {
  assert(normalizedApiDocs.includes(text), `Public API docs must state Task Debug API boundary: ${text}`);
}

console.log("Tasks Debug API source passed: authenticated definitions/state, receipt-first exact-revision queueing, exact-attempt cancellation, bounded attention acknowledgement, and no direct provider or Host MCP bypass.");
