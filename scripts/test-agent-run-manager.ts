import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const files = {
  rightRail: readFileSync("src/components/RightRail.tsx", "utf8"),
  tasksPanel: readFileSync("src/components/TasksPanel.tsx", "utf8"),
  agentRunsMonitor: readFileSync("src/components/AgentRunsMonitor.tsx", "utf8"),
  providerSessions: readFileSync("src/lib/provider-sessions.ts", "utf8"),
  debugApi: readFileSync("src-tauri/src/debug_api.rs", "utf8"),
  apiDocs: readFileSync("docs/API.md", "utf8"),
  changelog: readFileSync("CHANGELOG.md", "utf8"),
  pkg: readFileSync("package.json", "utf8"),
};

assert(
  files.debugApi.includes('.route("/state/agent_runs", get(state_agent_runs))'),
  "debug API must wire GET /state/agent_runs",
);
assert(
  files.debugApi.includes("debug_agent_runs_report_from_parts") &&
    files.debugApi.includes('"provider-native-subagent"') &&
    files.debugApi.includes('"shellx-host-subagent"') &&
    files.debugApi.includes('"nativeVisibility"'),
  "debug API must aggregate tab sessions, provider runs, ShellX subagents, and observed native subagents",
);
assert(
  files.providerSessions.includes("AgentRunManagerState") &&
    files.providerSessions.includes("agentRunsStatePath") &&
    files.providerSessions.includes("getAgentRunsState"),
  "frontend API helper must expose the agent run manager state",
);
assert(
  !files.rightRail.includes("<AgentRunsMonitor") &&
    !files.rightRail.includes("AgentRunsCard") &&
    files.tasksPanel.includes("<AgentRunsMonitor") &&
    files.agentRunsMonitor.includes("Agent runs") &&
    files.agentRunsMonitor.includes("Provider-native subagents are shown only when the provider exposes them"),
  "Agent runs monitoring must live inside Background Tasks, not the Agent CLIs/Tools card",
);
assert(
  files.apiDocs.includes("GET /state/agent_runs"),
  "docs must include the global agent run manager endpoint",
);
assert(
  files.changelog.includes("Agent runs") &&
    files.changelog.includes("provider-native subagents"),
  "changelog must mention the user-visible Agent runs feature under Added",
);
assert(
  files.pkg.includes("tsx scripts/test-agent-run-manager.ts"),
  "package test script must run the agent run manager regression test",
);
