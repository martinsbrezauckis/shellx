import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const requiredFiles = [
  "src/lib/agent-cli-setup.ts",
  "src/components/AgentCliSetupAssistant.tsx",
  "src/components/ConnectionEditor.tsx",
  "src/components/RightRail.tsx",
  "src-tauri/src/agent_cli_setup.rs",
  "src-tauri/src/lib.rs",
  "CHANGELOG.md",
  "package.json",
];

for (const file of requiredFiles) {
  assert(existsSync(file), `${file} must exist`);
}

const frontend = readFileSync("src/lib/agent-cli-setup.ts", "utf8");
const assistant = readFileSync("src/components/AgentCliSetupAssistant.tsx", "utf8");
const connectionEditor = readFileSync("src/components/ConnectionEditor.tsx", "utf8");
const rightRail = readFileSync("src/components/RightRail.tsx", "utf8");
const rust = readFileSync("src-tauri/src/agent_cli_setup.rs", "utf8");
const libRs = readFileSync("src-tauri/src/lib.rs", "utf8");
const debugApi = readFileSync("src-tauri/src/debug_api.rs", "utf8");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const apiDocs = readFileSync("docs/API.md", "utf8");
const pkg = readFileSync("package.json", "utf8");

for (const provider of ["grok", "claude-code", "codex-cli", "antigravity-cli"]) {
  assert(frontend.includes(provider), `frontend setup types must mention ${provider}`);
  assert(rust.includes(provider), `backend setup recipes must mention ${provider}`);
}

for (const command of [
  "curl -fsSL https://x.ai/cli/install.sh | bash",
  "irm https://x.ai/cli/install.ps1 | iex",
  "curl -fsSL https://claude.ai/install.sh | bash",
  "irm https://claude.ai/install.ps1 | iex",
  "npm install -g @anthropic-ai/claude-code",
  "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  "irm https://chatgpt.com/codex/install.ps1 | iex",
  "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  "irm https://antigravity.google/cli/install.ps1 | iex",
]) {
  assert(rust.includes(command), `backend recipe must include official command: ${command}`);
}

for (const [nativeCommand, npmCommand] of [
  [
    "irm https://claude.ai/install.ps1 | iex",
    "npm install -g @anthropic-ai/claude-code",
  ],
  [
    "irm https://chatgpt.com/codex/install.ps1 | iex",
    "npm install -g @openai/codex",
  ],
] as const) {
  assert(
    rust.indexOf(nativeCommand) >= 0 &&
      rust.indexOf(npmCommand) >= 0 &&
      rust.indexOf(nativeCommand) < rust.indexOf(npmCommand),
    `${nativeCommand} must be preferred before Node/npm fallback ${npmCommand}`,
  );
}

assert(
  rust.includes("prepare_agent_cli_install") &&
    rust.includes("confirm_agent_cli_install") &&
    rust.includes("AgentCliInstallConfirmation") &&
    rust.includes("requiresConfirmation"),
  "backend must expose prepare/confirm install contract with explicit confirmation",
);
assert(
  libRs.includes("agent_cli_setup_state") &&
    libRs.includes("agent_cli_setup_prepare_install") &&
    libRs.includes("agent_cli_setup_confirm_install") &&
    libRs.includes("agent_cli_setup_recheck"),
  "Tauri command surface must expose setup state, prepare, confirm, and recheck",
);
assert(
  debugApi.includes('"/state/agent_cli_setup"') &&
    debugApi.includes('"/agent_cli_setup/install/prepare"') &&
    debugApi.includes('"/agent_cli_setup/install/confirm"') &&
    debugApi.includes("agent_cli_setup_prepare_http") &&
    debugApi.includes("AgentCliSetupConfirmBody"),
  "debug API must expose setup state plus prepare/confirm install routes",
);
assert(
  assistant.includes("AgentCliSetupAssistant") &&
    assistant.includes("AgentCliSetupDialog") &&
    assistant.includes('invoke("open_url_in_browser"') &&
    assistant.includes("Install") &&
    assistant.includes("Cancel") &&
    assistant.includes("Open docs") &&
    assistant.includes("Copy command") &&
    assistant.includes("This command will run"),
  "assistant UI must render modal setup, install confirmation, docs, copy command, and explicit target copy",
);
assert(
  connectionEditor.includes("AgentCliSetupDialog") &&
    !connectionEditor.includes("<AgentCliSetupAssistant") &&
    connectionEditor.includes("onSetupChanged"),
  "Connections editor must open setup in a wide dialog instead of embedding the full assistant in the narrow form",
);
assert(
  rightRail.includes("Set up") &&
    rightRail.includes("AgentCliSetupDialog") &&
    !rightRail.includes("<AgentCliSetupAssistant"),
  "Agent CLIs card must expose compact Set up action that opens a modal dialog",
);
assert(
  rightRail.includes('data-debug-id="agent-cli-setup-open-missing"') &&
    rightRail.includes("setupMissingProviderId") &&
    rightRail.includes("provider-runner-actions"),
  "Agent CLIs actions must expose setup near Refresh when CLIs are missing",
);
assert(
  rightRail.includes('data-debug-id={`agent-cli-setup-open-${id}`}') &&
    rightRail.includes("setSetupDialogOpen(true)") &&
    rightRail.includes("setSetupProviderId(null)") &&
    rightRail.includes("missingOnly"),
  "Agent CLIs main Set up must open a modal listing all missing CLIs while row actions can still focus one provider",
);
assert(
  !rightRail.includes("provider-runner-run") &&
    !rightRail.includes("providerRunDetail(activeRun)") &&
    !rightRail.includes("providerRunDetail(recentRun)"),
  "Agent CLIs card must stay focused on installed CLI state, not provider run history",
);
assert(
  apiDocs.includes("/state/agent_cli_setup") &&
    apiDocs.includes("/agent_cli_setup/install/prepare") &&
    changelog.includes("Agent CLI Setup Assistant"),
  "public API docs and changelog must describe the user-visible setup assistant",
);
assert(
  !readFileSync("src/App.css", "utf8").includes("var(--surface-0)") &&
    readFileSync("src/App.css", "utf8").includes("agent-cli-setup-dialog") &&
    readFileSync("src/App.css", "utf8").includes("background: var(--surface"),
  "setup dialog CSS must use defined opaque surface tokens, not undefined transparent surface-0",
);
assert(
  pkg.includes("tsx scripts/test-agent-cli-setup.ts"),
  "pnpm test must run the agent CLI setup regression",
);

console.log("test-agent-cli-setup ok");
