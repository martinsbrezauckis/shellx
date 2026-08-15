import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const evidence = read("src-tauri/src/task_result_evidence.rs");
const receipts = read("src-tauri/src/task_receipts.rs");
const runtime = read("src-tauri/src/task_runtime_app.rs");
const projection = read("src-tauri/src/task_state_projection.rs");
const providerDispatch = read("src-tauri/src/task_provider_dispatch.rs");
const contract = read("src/lib/task-manager-contract.ts");
const adapter = read("src/lib/task-manager-tauri-adapter.ts");
const history = read("src/lib/task-manager-history-projection.ts");
const api = read("docs/public/API.md");
const architecture = read("docs/public/ARCHITECTURE.md");
const hostSkill = read("skills/shellx-host/SKILL.md");

for (const token of [
  "task_summaries_for_agent_session(&owner_session_id)",
  "export_flight_recorder_for_agent_session(",
  "receipts_for_agent_session(&owner_session_id",
  "runtime_owner_session_id(&occurrence, &revision, &attempt.attempt_id)",
  "source_terminal_receipt_hash",
  "validate_store_result_evidence",
  "pending_browser_result_evidence_occurrences",
  "result_evidence_receipts",
]) {
  assert(evidence.includes(token), `Task result evidence must retain exact binding: ${token}`);
}
assert(providerDispatch.includes("pub(crate) fn task_runtime_tab_id("));
assert(receipts.includes("OccurrenceResultEvidence"));
assert(receipts.includes("pub result_evidence: Option<TaskResultEvidenceReceipt>"));
const notifyBody = runtime.slice(runtime.indexOf("fn notify(&self"), runtime.indexOf("fn record_result_evidence"));
assert(notifyBody.indexOf("self.record_result_evidence") < notifyBody.indexOf("task_terminal_notification_body("),
  "terminal result evidence must be attempted before the optional desktop notification");
assert(runtime.includes("retry_missing_result_evidence"),
  "startup and foreground polls must recover the post-terminal pre-evidence crash window");

const identityStruct = evidence.slice(
  evidence.indexOf("pub(crate) struct TaskResultEvidenceIdentity"),
  evidence.indexOf("pub(crate) struct TaskResultEvidenceReceipt"),
);
assert(!/pub\s+\w*path\s*:/.test(identityStruct), "durable evidence identities must not expose paths");
for (const forbidden of ["url:", "provider_output", "prompt:", "credential:"]) {
  assert(!identityStruct.includes(forbidden), `durable evidence identity must omit ${forbidden}`);
}

for (const source of [projection, contract, adapter, history]) {
  assert(source.includes("resultEvidence") || source.includes("result_evidence"),
    "Task state and UI projections must retain result-evidence identity");
}
assert(contract.includes('"browserFlightRecorder" | "browserEvaluation"'));
assert(adapter.includes('receipt.kind === "occurrenceResultEvidence"'));
assert(history.includes("Path-free Browser artifact identities are bound to this occurrence."));

for (const source of [api, architecture, hostSkill]) {
  assert(source.includes("path-free") || source.includes("Path-free"),
    "public Task documentation must explain that result identities are path-free");
  assert(source.includes("Flight Recorder"),
    "public Task documentation must retain the Browser Flight Recorder result boundary");
}

console.log("Task result evidence passed: deterministic owner join, scoped Browser reads, terminal receipt binding, path-free projection, and synchronized public contracts.");
