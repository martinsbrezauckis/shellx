import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const browserRouter = readFileSync("src-tauri/src/debug_api_browser.rs", "utf8");
const callerParser = readFileSync("src-tauri/src/debug_api_browser_caller.rs", "utf8");
const callerRevisions = readFileSync("src-tauri/src/shellx_browser_caller_revisions.rs", "utf8");
const callerAuthority = readFileSync("src-tauri/src/shellx_browser_caller.rs", "utf8");
const taskControl = readFileSync("src-tauri/src/shellx_browser_task_control.rs", "utf8");
const taskLifecycle = readFileSync("src-tauri/src/shellx_browser_tasks.rs", "utf8");
const browserState = readFileSync("src-tauri/src/shellx_browser_state.rs", "utf8");
const debugState = readFileSync("src-tauri/src/debug_api_browser_state.rs", "utf8");

assert.match(
  browserRouter,
  /pub\(crate\) fn browser_routes\(\) -> Router<ApiState> \{\s*with_browser_caller_header_guard\(/,
  "the complete Browser Debug API router must retain the caller-header guard",
);
assert(browserRouter.includes("optional_browser_mcp_caller_id_or_bad_request"));
assert(callerParser.includes("get_all(SHELLX_MCP_CALLER_ID_HEADER)"));
assert(callerParser.includes("if values.next().is_some()"));
assert(callerAuthority.includes(".zip(caller_session_id)") && !callerAuthority.includes("None => true"));
assert(taskLifecycle.includes("authenticated Browser task creation requires an exact caller session"));
assert(taskLifecycle.includes("start_task_from_debug_operator"));
assert(taskControl.includes("BrowserTaskControlAuthority::Operator") && taskControl.includes("if caller_session_id.is_some()"));
for (const branch of [
  "start_task_from_debug_operator(body)",
  "finish_task_from_operator(body.task_id, body.status, body.reason)",
  "control_task_from_operator(body)",
] as const) {
  assert(debugState.includes(branch), `headerless Browser route must retain explicit operator branch: ${branch}`);
}
assert(browserState.includes("summary_revisions_for_agent_session"));
for (const revision of ["tasks", "activity", "requests"] as const) {
  assert.match(
    debugState,
    new RegExp(`summary_for_agent_session\\(caller\\)[\\s\\S]{0,160}?\\.revisions\\s*\\.${revision}`),
    `caller-scoped ${revision} responses must use caller-local revisions`,
  );
}
assert(callerRevisions.includes("browser_task_belongs_to_agent_session"));
assert(callerRevisions.includes("BrowserSummaryRevisions"));

console.log("ShellX Browser caller-boundary source contract passed");
