import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const route = readFileSync(resolve(root, "src-tauri/src/debug_api_task_agent.rs"), "utf8");
const taskRouter = readFileSync(resolve(root, "src-tauri/src/debug_api_tasks.rs"), "utf8");
const host = readFileSync(resolve(root, "src-tauri/src/host_mcp.rs"), "utf8");
const hostTool = readFileSync(resolve(root, "src-tauri/src/host_mcp/task_tools.rs"), "utf8");
const hostSchema = readFileSync(resolve(root, "src-tauri/src/host_mcp/tool_specs_core.rs"), "utf8");
const hostSummary = readFileSync(resolve(root, "src-tauri/src/host_mcp/host_state_tools.rs"), "utf8");
const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");

for (const required of [
  '.route("/tasks/agent", post(task_agent::tasks_agent_action_http))',
  "optional_browser_mcp_caller_id_or_bad_request",
  "task_agent_caller_required",
  "if !body.user_approved",
  "task_agent_approval_required",
  "explicit user intent in the current conversation",
  "resolve_task_definition_connection_preset",
  "scan_task_provider_catalog",
  "provider.availability.can_run",
  "queue_manual_run(",
  '"createdRunNotQueued"',
  '"tasks-updated"',
]) assert(`${route}\n${taskRouter}`.includes(required), `agent Task route must retain ${required}`);

assert(
  route.indexOf('"tasks-updated"') < route.indexOf("let run = if matches!"),
  "a durably created Task must refresh the review panel even when Run now cannot be queued",
);
assert(route.includes("tab.autonomy.as_deref()") && route.includes("tab.shellx_tool_exposure.as_deref()"), "agent-created Tasks must inherit finite permissions from their exact caller tab");
assert(route.includes("provider.provider_id == *value && provider.availability.can_run"), "an unavailable current agent must fall through to the first freshly ready worker");
assert(route.includes("TaskModelSelection::ProviderDefault"), "conversational creation must not invent unverified model identities");
assert(route.includes("attachment_refs: Vec::new()") && route.includes("vault_requirements: Vec::new()"), "the conversational route must not guess attachment or Vault authority");
assert(!route.includes("start_provider_session"), "the agent route must queue through the durable foreground runtime rather than spawning a provider directly");
for (const forbidden of ["GROK_AUTH_PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "antigravity-auth"]) {
  assert(!route.includes(forbidden), `agent Task creation must not inspect or redirect provider authentication: ${forbidden}`);
}

assert(host.includes('"task_manage"'), "Host MCP must route task_manage");
assert(host.includes('// Natural-language Task creation persists a definition'), "task_manage must remain write-class");
assert(hostTool.includes("mcp_arg_bool(&arguments, \"userApproved\")"), "task_manage must fail closed without current-turn approval");
assert(hostTool.includes('"/tasks/agent"'), "task_manage must use the authenticated agent Task route");
for (const required of [
  '"name": "task_manage"',
  '"enum": ["create", "createAndRun"]',
  '"userApproved"',
  '"workers"',
  '"maxRunMinutes"',
]) assert(hostSchema.includes(required), `task_manage schema must retain ${required}`);
assert(hostSummary.includes('{ "category": "tasks", "tools": ["task_manage"]'), "compact Host capabilities must make conversational Tasks discoverable without a full schema dump");

assert(app.includes("autonomy: t.autonomy ?? autonomy"), "renderer state must project the caller tab's current autonomy");
assert(app.includes("shellxToolExposure: normalizeShellxToolExposure(t.shellxToolExposure)"), "renderer state must project the caller tab's finite ShellX tooling exposure");

console.log("Agent Task management passed: current-conversation approval, exact caller environment and permissions, fresh ordered workers, durable queueing, truthful partial results, and no credential handling.");
