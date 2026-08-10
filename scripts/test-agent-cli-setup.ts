import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { AGENT_OPTIONS } from "../src/lib/agent-selection";
import { readRustModuleFamily } from "./read-rust-module-family";

const requiredFiles = [
  "src/lib/agent-cli-setup.ts",
  "src/components/AgentCliSetupAssistant.tsx",
  "src/components/AgentCliSetupAssistant.css",
  "src/components/AgentCliSetupDialog.lazy.tsx",
  "src/lib/debug-agent-cli-setup-fixture.ts",
  "src/components/AgentCliStatusCard.tsx",
  "src/components/ConnectionEditor.tsx",
  "src/components/RightRail.tsx",
  "src-tauri/src/agent_cli_setup.rs",
  "src-tauri/src/provider_runtime.rs",
  "src-tauri/src/lib.rs",
  "CHANGELOG.md",
  "package.json",
];

for (const file of requiredFiles) {
  assert(existsSync(file), `${file} must exist`);
}

const frontend = readFileSync("src/lib/agent-cli-setup.ts", "utf8");
const assistant = readFileSync("src/components/AgentCliSetupAssistant.tsx", "utf8");
const assistantCss = readFileSync("src/components/AgentCliSetupAssistant.css", "utf8");
const lazyDialog = readFileSync("src/components/AgentCliSetupDialog.lazy.tsx", "utf8");
const app = readFileSync("src/App.tsx", "utf8");
const bottomPanel = readFileSync("src/components/BottomPanel.tsx", "utf8");
const debugFixture = readFileSync("src/lib/debug-agent-cli-setup-fixture.ts", "utf8");
const agentCliStatusCard = readFileSync("src/components/AgentCliStatusCard.tsx", "utf8");
const connectionEditor = readFileSync("src/components/ConnectionEditor.tsx", "utf8");
assert.match(connectionEditor, /connection-ssh-platform-hint/);
assert.match(connectionEditor, /Windows OpenSSH, run agents in WSL/);
assert.match(connectionEditor, /connection-ssh-runtime-select/);
assert.match(connectionEditor, /connection-ssh-wsl-distro-input/);
const rightRail = readFileSync("src/components/RightRail.tsx", "utf8");
const rust = readFileSync("src-tauri/src/agent_cli_setup.rs", "utf8");
const providerRuntime = readFileSync("src-tauri/src/provider_runtime.rs", "utf8");
const connections = readFileSync("src-tauri/src/connections.rs", "utf8");
const providerAdapters = readFileSync("src-tauri/src/provider_adapters.rs", "utf8");
const acp = readFileSync("src-tauri/src/acp.rs", "utf8");
const terminal = readFileSync("src-tauri/src/terminal.rs", "utf8");
const libRs = readFileSync("src-tauri/src/lib.rs", "utf8");
const debugApi = readRustModuleFamily("src-tauri/src/debug_api.rs");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const apiDocs = readFileSync("docs/public/API.md", "utf8");
const pkg = readFileSync("package.json", "utf8");
const testSuiteManifest = readFileSync("scripts/test-suite-manifest.mjs", "utf8");
const installedStagingProof = readFileSync("scripts/test-agent-cli-staging-installed.ts", "utf8");

const expectedProviders = ["grok", "claude-code", "codex-cli", "antigravity-cli"];
assert.deepEqual(
  AGENT_OPTIONS.map((option) => option.id),
  expectedProviders,
  "live frontend agent registry must cover every setup provider",
);
assert(
  frontend.includes("providerId: AgentId | string"),
  "frontend setup cards must use the live AgentId contract",
);
for (const provider of expectedProviders) {
  assert(rust.includes(provider), `backend setup recipes must mention ${provider}`);
}

for (const command of [
  "https://x.ai/cli/install.sh",
  "https://x.ai/cli/install.ps1",
  "https://claude.ai/install.sh",
  "https://claude.ai/install.ps1",
  "npm install -g @anthropic-ai/claude-code",
  "https://chatgpt.com/codex/install.sh",
  "https://chatgpt.com/codex/install.ps1",
  "https://antigravity.google/cli/install.sh",
  "https://antigravity.google/cli/install.ps1",
]) {
  assert(rust.includes(command), `backend recipe must include official source: ${command}`);
}

for (const [providerId, nativeCommand, npmCommand] of [
  [
    "claude-code",
    "https://claude.ai/install.ps1",
    "npm install -g @anthropic-ai/claude-code",
  ],
  [
    "codex-cli",
    "https://chatgpt.com/codex/install.ps1",
    "npm install -g @openai/codex",
  ],
] as const) {
  const recipeStart = rust.indexOf(`provider_id: "${providerId}"`);
  const nextRecipeStart = rust.indexOf("provider_id:", recipeStart + 1);
  const recipe = rust.slice(recipeStart, nextRecipeStart >= 0 ? nextRecipeStart : undefined);
  assert(
    recipeStart >= 0 &&
      recipe.indexOf(nativeCommand) >= 0 &&
      recipe.indexOf(npmCommand) >= 0 &&
      recipe.indexOf(nativeCommand) < recipe.indexOf(npmCommand),
    `${nativeCommand} must be preferred before Node/npm fallback ${npmCommand}`,
  );
}
assert(!rust.includes("install.sh | bash"), "vendor POSIX installers must never pipe network content to bash");
assert(!rust.includes("install.sh | sh"), "vendor POSIX installers must never pipe network content to sh");
assert(!rust.includes("| iex"), "vendor PowerShell installers must never use Invoke-Expression");
assert(
  rust.includes("stage_vendor_installer") &&
    rust.includes("validate_installer_source_url") &&
    rust.includes("artifact_sha256") &&
    rust.includes("digest changed after confirmation") &&
    rust.includes("cancel_agent_cli_install"),
  "backend must stage, allowlist, digest-bind, and clean up vendor installers",
);

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
    libRs.includes("agent_cli_setup_cancel_install") &&
    libRs.includes("agent_cli_setup_recheck"),
  "Tauri command surface must expose setup state, prepare, confirm, cancel, and recheck",
);
assert(
  debugApi.includes('"/state/agent_cli_setup"') &&
    debugApi.includes('"/agent_cli_setup/install/prepare"') &&
    debugApi.includes('"/agent_cli_setup/install/confirm"') &&
    debugApi.includes('"/agent_cli_setup/install/cancel"') &&
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
    assistant.includes("artifactSha256") &&
    assistant.includes("Verification") &&
    assistant.includes("cancelPreparedInstall"),
  "assistant UI must render staged artifact identity, verification, and explicit cleanup-backed cancel",
);
assert(
  assistant.includes("export interface AgentCliSetupFixture")
    && assistant.includes("if (fixture) {")
    && assistant.includes("setState(fixture.state)")
    && assistant.includes("fixture?.confirmation?.confirmationId === confirmationId")
    && (assistant.match(/disabled=\{Boolean\(fixture\)/g)?.length ?? 0) >= 3
    && assistant.includes("fixture?.allowOwnedInstall !== true")
    && assistant.includes("disabled={loading || Boolean(fixture) || !inTauri()}"),
  "synthetic Agent CLI setup state must bypass discovery and confirmation cleanup while disabling every external, clipboard, provider, and installer action",
);
assert(
  app.includes("normalizeDebugAgentCliSetupFixtureMode")
    && app.includes("setAgentCliSetupFixtureMode(agentCliSetupFixturePatch)")
    && app.includes('setAgentCliSetupFixtureMode("closed")')
    && app.includes("debugAgentCliSetupFixture(agentCliSetupFixtureMode)")
    && debugFixture.includes('| "live-status"')
    && debugFixture.includes('| "live-setup"')
    && debugFixture.includes('| "install-lifecycle"')
    && app.includes('agentCliStatusLive={agentCliSetupFixtureMode === "live-status"}')
    && app.includes('agentCliSetupFixtureMode === "live-setup"')
    && app.includes('agentCliSetupFixtureMode === "install-lifecycle"')
    && debugFixture.includes("fixture-command-is-never-executed")
    && debugFixture.includes("Every external and provider action is disabled."),
  "authenticated Debug UI modes must retain inert synthetic setup state, expose isolated live-scan modes, and restore the exact closed state",
);
assert(
  connectionEditor.includes("AgentCliSetupDialog") &&
    !connectionEditor.includes("<AgentCliSetupAssistant") &&
    connectionEditor.includes("onSetupChanged"),
  "Connections editor must open setup in a wide dialog instead of embedding the full assistant in the narrow form",
);
assert(
  agentCliStatusCard.includes("Set up") &&
    agentCliStatusCard.includes("AgentCliSetupDialog") &&
    !agentCliStatusCard.includes("<AgentCliSetupAssistant"),
  "Agent CLIs card must expose compact Set up action that opens a modal dialog",
);
assert(
  app.includes('lazy(() => import("./components/AgentCliSetupDialog.lazy"))') &&
    connectionEditor.includes('lazy(() => import("./AgentCliSetupDialog.lazy"))') &&
    agentCliStatusCard.includes('lazy(() => import("./AgentCliSetupDialog.lazy"))') &&
    app.includes('label="Agent CLI Setup Assistant"') &&
    connectionEditor.includes('label="Agent CLI Setup Assistant"') &&
    agentCliStatusCard.includes('label="Agent CLI Setup Assistant"'),
  "every Agent CLI setup entry point must retain the shared recoverable lazy boundary",
);
assert(
  providerRuntime.includes("WINDOWS_PROVIDER_SHELL_PRELUDE") &&
    providerRuntime.includes(".grok\\\\bin") &&
    providerRuntime.includes(".claude\\\\bin") &&
    providerRuntime.includes(".bun\\\\bin") &&
    providerRuntime.includes(".cargo\\\\bin") &&
    providerRuntime.includes("APPDATA 'npm'") &&
    connections.includes("provider_runtime::resolve_local_binary") &&
    providerAdapters.includes("provider_runtime::local_binary_candidates") &&
    acp.includes("provider_runtime::WINDOWS_PROVIDER_SHELL_PRELUDE") &&
    terminal.includes("provider_runtime::windows_user_bin_paths"),
  "inventory, launch, terminal, and native Windows OpenSSH paths must share one provider runtime resolver",
);
assert(
  agentCliStatusCard.includes("connectionProviderScanRequestKey") &&
    agentCliStatusCard.includes("waitingForSavedPreset") &&
    agentCliStatusCard.includes('window.addEventListener("focus"') &&
    agentCliStatusCard.includes('document.addEventListener("visibilitychange"') &&
    !agentCliStatusCard.includes("setInterval("),
  "Agent CLI status must revalidate stale inventory on resume without unbounded polling",
);
const statusFunction = agentCliStatusCard.slice(
  agentCliStatusCard.indexOf("function agentCliStatus("),
  agentCliStatusCard.indexOf("function agentCliDetail("),
);
const detailFunction = agentCliStatusCard.slice(
  agentCliStatusCard.indexOf("function agentCliDetail("),
  agentCliStatusCard.length,
);
assert(
  statusFunction.indexOf("if (loading)") >= 0 &&
    statusFunction.indexOf("if (loading)") < statusFunction.indexOf("providerScanStatus(scan)") &&
    detailFunction.indexOf('if (loading) return "checking live version"') >= 0 &&
    detailFunction.indexOf("if (loading)") < detailFunction.indexOf("if (scan)") &&
    agentCliStatusCard.includes("useState<AgentCliLiveInventory | null>(null)") &&
    !agentCliStatusCard.includes("connectionPreset?.providerScan ?? []") &&
    agentCliStatusCard.includes("!loading && !message && setupPreset"),
  "Agent CLI rows must hide persisted versions and setup actions until the live target scan finishes",
);
assert(
  agentCliStatusCard.includes("scanConnectionProviderCapabilities(preset)") &&
    agentCliStatusCard.includes("inventory?.requestKey === scanRequestKey") &&
    agentCliStatusCard.includes("setInventory({ requestKey, providers: snapshot.providers, capability: snapshot })") &&
    agentCliStatusCard.includes("providerScanStatus(scan)") &&
    agentCliStatusCard.includes('providerScanStatus(scanned) === "missing"') &&
    !statusFunction.includes("adapter.canRun"),
  "Agent CLI readiness must come from a fresh target-keyed capability snapshot, not cached adapter state",
);
assert(
  app.includes("activeProviderScanOverride.freshUntilMs > Date.now()")
    && app.includes("completedAutoScanKeys.current.get(requestKey)")
    && app.includes("completedAutoScanKeys.current.set(requestKey, snapshot.freshUntilMs)")
    && app.includes("scanConnectionProvidersForPreset(preset)")
    && !app.includes("return activeConnectionPreset?.providerScan ?? []")
    && app.includes('providerScanStatus(provider) === "ready"')
    && bottomPanel.includes('providerScanStatus(scan) === "ready"')
    && bottomPanel.includes("Fresh scan:"),
  "active-tab selection and setup readiness must use only fresh exact-target ready scans, never persisted last-launch capability state",
);
assert(
  frontend.includes("export type AgentCliSetupStatus = ConnectionProviderScanStatus")
    && frontend.includes("status: provider.status")
    && frontend.includes("binarySha256: provider.binarySha256")
    && frontend.includes("binaryBytes: provider.binaryBytes")
    && frontend.includes("targetKey: provider.targetKey")
    && frontend.includes("checkedAtMs: provider.checkedAtMs")
    && rust.includes("setup_scan_status(scan_status)")
    && rust.includes("binary_sha256")
    && rust.includes("checked_at_ms"),
  "setup Recheck must preserve the exact scan status, target identity, binary identity, and check time",
);
assert(
  agentCliStatusCard.includes('data-debug-id="agent-cli-setup-open-missing"') &&
    agentCliStatusCard.includes("setupMissingProviderId") &&
    agentCliStatusCard.includes("provider-runner-actions"),
  "Agent CLIs actions must expose setup near Refresh when CLIs are missing",
);
assert(
  agentCliStatusCard.includes('data-debug-id={`agent-cli-setup-open-${id}`}') &&
    agentCliStatusCard.includes("setSetupDialogOpen(true)") &&
    agentCliStatusCard.includes("setSetupProviderId(null)") &&
    agentCliStatusCard.includes("missingOnly"),
  "Agent CLIs main Set up must open a modal listing all missing CLIs while row actions can still focus one provider",
);
assert(
  !agentCliStatusCard.includes("provider-runner-run") &&
    !agentCliStatusCard.includes("providerRunDetail(activeRun)") &&
    !agentCliStatusCard.includes("providerRunDetail(recentRun)"),
  "Agent CLIs card must stay focused on installed CLI state, not provider run history",
);
assert(
  rightRail.includes("AgentCliStatusCard") &&
    !rightRail.includes("AgentCliSetupDialog") &&
    !rightRail.includes('data-debug-id={`agent-cli-setup-open-${id}`}'),
  "RightRail must delegate Agent CLI setup rendering to a focused status card",
);
assert(
  apiDocs.includes("/state/agent_cli_setup") &&
    apiDocs.includes("/agent_cli_setup/install/prepare") &&
    changelog.includes("Agent CLI Setup Assistant"),
  "public API docs and changelog must describe the user-visible setup assistant",
);
assert(
  lazyDialog.includes('import "./AgentCliSetupAssistant.css"') &&
    lazyDialog.includes("AgentCliSetupDialog as default") &&
    !assistantCss.includes("var(--surface-0)") &&
    assistantCss.includes("agent-cli-setup-dialog") &&
    assistantCss.includes("background: var(--surface"),
  "setup dialog CSS must use defined opaque surface tokens, not undefined transparent surface-0",
);
assert(
  assistant.includes('import { inTauri } from "../lib/tauri-bridge"') &&
    assistant.includes('"Agent CLI discovery is available in the ShellX desktop app."') &&
    assistant.includes("!inTauri()"),
  "plain-browser setup previews must disclose the desktop boundary without exposing raw IPC errors",
);
assert(
  testSuiteManifest.includes('["tsx","scripts/test-agent-cli-setup.ts"]'),
  "canonical test-suite manifest must run the agent CLI setup regression",
);
assert(
  pkg.includes('"test:agent-cli-staging-installed"') &&
    pkg.includes('"test:release-ui-control-agent-cli-setup-lifecycle"') &&
    installedStagingProof.includes("validateHarnessState") &&
    installedStagingProof.includes("/agent_cli_setup/install/prepare") &&
    installedStagingProof.includes("/agent_cli_setup/install/cancel") &&
    installedStagingProof.includes("stagedPathAbsent"),
  "package must expose an artifact-bound installed staging and cleanup proof",
);

console.log("test-agent-cli-setup ok");
