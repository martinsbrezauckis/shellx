import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readRustModuleFamily } from "./read-rust-module-family";

const files = {
  rightRail: readFileSync("src/components/RightRail.tsx", "utf8"),
  tasksPanel: readFileSync("src/components/TasksPanel.tsx", "utf8"),
  agentRunsMonitor: readFileSync("src/components/AgentRunsMonitor.tsx", "utf8"),
  providerSessions: readFileSync("src/lib/provider-sessions.ts", "utf8"),
  providerSessionApi: readFileSync("src/lib/provider-session-api.ts", "utf8"),
  debugApi: readRustModuleFamily("src-tauri/src/debug_api.rs"),
  apiDocs: readFileSync("docs/public/API.md", "utf8"),
  changelog: readFileSync("CHANGELOG.md", "utf8"),
  testSuiteManifest: readFileSync("scripts/test-suite-manifest.mjs", "utf8"),
};

assert(
  files.debugApi.includes('.route("/state/agent_runs", get(state_agent_runs))'),
  "debug API must wire GET /state/agent_runs",
);
assert(
  files.debugApi.includes("debug_agent_runs_report_from_parts") &&
    files.debugApi.includes('"provider-native-subagent"') &&
    files.debugApi.includes('"shellx-host-subagent"') &&
    files.debugApi.includes('"nativeVisibility"') &&
    files.debugApi.includes('event_kind == "subagent"') &&
    files.debugApi.includes('"parentSubagentId"') &&
    files.debugApi.includes("debug_provider_run_metrics_by_run") &&
    files.debugApi.includes('"timeToFirstResponseMs"') &&
    files.debugApi.includes('"cacheReadTokens"'),
  "debug API must aggregate tab sessions, provider runs, ShellX subagents, and observed native subagents",
);
assert(
    files.providerSessions.includes("AgentRunManagerState") &&
    files.providerSessions.includes("agentRunsStatePath") &&
    files.providerSessionApi.includes("getAgentRunsState") &&
    files.providerSessions.includes("timeToFirstSuccessfulActionMs") &&
    files.providerSessions.includes("cacheWriteTokens"),
  "frontend API helper must expose the agent run manager state",
);
assert(
  !files.rightRail.includes("<AgentRunsMonitor") &&
    !files.rightRail.includes("AgentRunsCard") &&
    files.tasksPanel.includes("<AgentRunsMonitor") &&
    files.agentRunsMonitor.includes("Agent runs") &&
    files.agentRunsMonitor.includes("first response") &&
    files.agentRunsMonitor.includes("actions completed") &&
    files.agentRunsMonitor.includes("parentSubagentId") &&
    files.agentRunsMonitor.includes('data-debug-id="tasks-agent-runs-refresh"') &&
    files.agentRunsMonitor.includes("manualRefreshReceipt") &&
    files.agentRunsMonitor.includes("Provider-native subagents are shown only when the provider exposes them"),
  "Agent runs monitoring must live inside Background Tasks, not the Agent CLIs/Tools card",
);
assert(
  files.apiDocs.includes("GET /state/agent_runs") &&
    files.apiDocs.includes("Provider-run metrics are derived from normalized event metadata"),
  "docs must include the global agent run manager endpoint",
);
assert(
  files.changelog.includes("Agent runs") &&
    files.changelog.includes("provider-native subagents"),
  "changelog must mention the user-visible Agent runs feature under Added",
);
assert(
  files.testSuiteManifest.includes('["tsx","scripts/test-agent-run-manager.ts"]'),
  "canonical test-suite manifest must run the agent run manager regression test",
);
