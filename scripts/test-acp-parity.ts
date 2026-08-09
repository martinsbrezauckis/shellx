import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { classifyComposerSubmission } from "../src/lib/acp-interjection";

console.log("\n=== ACP parity ===");

assert.deepEqual(classifyComposerSubmission({
  isSending: false,
  selectedAgent: null,
  status: "Idle",
  text: "Start work",
  attachmentCount: 0,
}), { mode: "prompt" }, "idle composer keeps the normal prompt path");

assert.deepEqual(classifyComposerSubmission({
  isSending: true,
  selectedAgent: "grok",
  status: "Connected",
  text: "Check the failing test first.",
  attachmentCount: 0,
}), { mode: "interject" }, "running Grok turn accepts text steering");

assert.deepEqual(classifyComposerSubmission({
  isSending: true,
  selectedAgent: "grok",
  status: "Connected",
  text: "/stop",
  attachmentCount: 0,
}), { mode: "prompt" }, "running-turn local controls are not swallowed as interjections");

assert.equal(classifyComposerSubmission({
  isSending: true,
  selectedAgent: "grok",
  status: "Connected",
  text: "/build replace the current turn",
  attachmentCount: 0,
}).mode, "blocked", "a second build cannot start inside a running turn");

assert.equal(classifyComposerSubmission({
  isSending: true,
  selectedAgent: "codex",
  status: "Connected",
  text: "Steer",
  attachmentCount: 0,
}).mode, "blocked", "provider sessions do not receive an unsupported Grok extension");

assert.equal(classifyComposerSubmission({
  isSending: true,
  selectedAgent: "grok",
  status: "Connected",
  text: "Steer with context",
  attachmentCount: 1,
}).mode, "blocked", "interjection attachments fail closed until their wire path is implemented");

const requestSource = readFileSync(new URL("../src-tauri/src/acp_requests.rs", import.meta.url), "utf8");
assert.match(requestSource, /GROK_INTERJECT_METHOD: &str = "_x\.ai\/interject"/);
assert.match(requestSource, /GROK_INTERJECT_TIMEOUT: Duration = Duration::from_secs\(15\)/);
assert.match(requestSource, /pending_responses\.lock\(\)\.await\.remove\(&id\)/);

const lifecycleSource = readFileSync(
  new URL("../src-tauri/src/debug_api_session_lifecycle.rs", import.meta.url),
  "utf8",
);
assert.match(lifecycleSource, /registry\.begin_session_start\(&tab_key\)/);
assert.match(lifecycleSource, /run_cancellable_session_start/);
assert.match(lifecycleSource, /StatusCode::ACCEPTED/);
assert.match(lifecycleSource, /"connectCancellationRequested": true/);
assert.match(lifecycleSource, /"registryRemovalPending": true/);
assert.match(lifecycleSource, /"error": "connect_cancelled"/);

console.log("PASS ACP parity tests");
