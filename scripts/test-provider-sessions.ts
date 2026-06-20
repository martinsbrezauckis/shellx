// @ts-nocheck
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isProviderSessionFrame,
  providerAbortRequestBody,
  providerAdaptersStatePath,
  providerPermissionModeLabel,
  providerPermissionModeOptions,
  providerRunDetail,
  providerRunPhaseLabel,
  providerSessionStatePath,
  providerStartRequestBody,
  providerSessionDisplayText,
  providerSessionGroupShape,
  providerSessionLabel,
  providerSessionToolStatus,
} from "../src/lib/provider-sessions.ts";
import { groupEvents } from "../src/lib/grouping.ts";
import type { RawEventFrame } from "../src/types/acp";

const textEvent: RawEventFrame = {
  t: 1000,
  kind: "provider-session-event",
  payload: {
    tabId: "tab-a",
    runId: "run-1",
    providerId: "codex-cli",
    kind: "textDelta",
    text: "hello",
  },
};

assert.equal(isProviderSessionFrame(textEvent), true);
assert.equal(providerSessionDisplayText(textEvent.payload), "hello");

const commandEvent: RawEventFrame = {
  t: 1001,
  kind: "provider-session-event",
  payload: {
    tabId: "tab-a",
    runId: "run-1",
    providerId: "claude-code",
    kind: "command",
    text: "Bash",
  },
};

assert.equal(providerSessionLabel(commandEvent.payload), "Claude Code command");
assert.equal(providerSessionToolStatus(commandEvent.payload), "running");

const codexCommandDoneEvent: RawEventFrame = {
  t: 1001.5,
  kind: "provider-session-event",
  payload: {
    tabId: "tab-a",
    runId: "run-1",
    providerId: "codex-cli",
    kind: "command",
    text: "cargo test",
    rawType: "item.completed/command_execution",
  },
};

assert.equal(providerSessionToolStatus(codexCommandDoneEvent.payload), "success");

const completedEvent: RawEventFrame = {
  t: 1002,
  kind: "provider-session-event",
  payload: {
    tabId: "tab-a",
    runId: "run-1",
    providerId: "codex-cli",
    kind: "completed",
    exitCode: 0,
  },
};

const textShape = providerSessionGroupShape(textEvent.payload);
assert.deepEqual(textShape, { kind: "message", text: "hello" });
const providerGroups = groupEvents([textEvent]);
assert.equal(providerGroups[0]?.kind, "message");
assert.equal((providerGroups[0] as any)?.speakerLabel, "Codex CLI");

const claudeDeltaAcrossHiddenToolGroups = groupEvents([
  {
    t: 1000,
    kind: "provider-session-event",
    payload: {
      tabId: "tab-a",
      runId: "run-delta",
      providerId: "claude-code",
      kind: "textDelta",
      text: "I'll load schemas first.",
    },
  },
  {
    t: 1001,
    kind: "provider-session-event",
    payload: {
      tabId: "tab-a",
      runId: "run-delta",
      providerId: "claude-code",
      kind: "tool",
      text: "ToolSearch",
      rawType: "stream_event/content_block_start",
    },
  },
  {
    t: 1002,
    kind: "provider-session-event",
    payload: {
      tabId: "tab-a",
      runId: "run-other",
      providerId: "codex-cli",
      kind: "text",
      text: "Interleaved Codex message.",
    },
  },
  {
    t: 1003,
    kind: "provider-session-event",
    payload: {
      tabId: "tab-a",
      runId: "run-delta",
      providerId: "claude-code",
      kind: "textDelta",
      text: "Sch",
    },
  },
  {
    t: 1004,
    kind: "provider-session-event",
    payload: {
      tabId: "tab-a",
      runId: "run-delta",
      providerId: "claude-code",
      kind: "textDelta",
      text: "emas loaded.",
    },
  },
]);
const claudeDeltaMessages = claudeDeltaAcrossHiddenToolGroups.filter(
  (group) => group.kind === "message" && (group as any).speakerLabel === "Claude Code",
) as Array<{ text: string }>;
assert.equal(
  claudeDeltaMessages.length,
  2,
  "hidden provider tools create a visible Claude text boundary",
);
assert.equal(
  claudeDeltaMessages[1]?.text,
  "Schemas loaded.",
  "Claude textDelta chunks stay contiguous across interleaved provider events",
);

const codexCompletedTextGroups = groupEvents([
  {
    t: 1000,
    kind: "provider-session-event",
    payload: {
      tabId: "tab-a",
      runId: "run-text",
      providerId: "codex-cli",
      kind: "text",
      text: "First completed message.",
    },
  },
  {
    t: 1001,
    kind: "provider-session-event",
    payload: {
      tabId: "tab-a",
      runId: "run-text",
      providerId: "codex-cli",
      kind: "command",
      text: "/bin/bash -lc \"sed -n '1,220p' /home/user/.codex/plugins/cache/openai-curated/superpowers/2abb1c44/skills/using-superpowers/SKILL.md\"",
      rawType: "item.started/command_execution",
    },
  },
  {
    t: 1002,
    kind: "provider-session-event",
    payload: {
      tabId: "tab-a",
      runId: "run-text",
      providerId: "codex-cli",
      kind: "text",
      text: "Second completed message.",
    },
  },
]);
assert.equal(
  codexCompletedTextGroups.filter((group) => group.kind === "message").length,
  2,
  "Codex completed text items remain separate visible messages",
);

const toolShape = providerSessionGroupShape(commandEvent.payload);
assert.deepEqual(toolShape, {
  kind: "tool",
  label: "Claude Code command",
  detail: "Bash",
  status: "running",
});

const rawEvent: RawEventFrame = {
  t: 1002,
  kind: "provider-session-event",
  payload: {
    tabId: "tab-a",
    runId: "run-1",
    providerId: "codex-cli",
    kind: "raw",
    rawType: "stderr",
    text: "Reading additional input from stdin...",
  },
};

assert.equal(providerSessionGroupShape(rawEvent.payload), null, "raw provider events stay out of chat grouping");

assert.equal(
  groupEvents([
    {
      t: 1002,
      kind: "provider-adapter-run-completed",
      payload: { ok: true, providerId: "codex-cli", stdout: "{\"type\":\"turn.completed\"}" },
    },
  ]).length,
  0,
  "provider adapter diagnostic runs stay out of visible chat grouping",
);

const codexContextToolEvent: RawEventFrame = {
  t: 1003,
  kind: "provider-session-event",
  payload: {
    tabId: "tab-a",
    runId: "run-1",
    providerId: "codex-cli",
    kind: "mcpTool",
    text: "session_tooling",
  },
};

assert.equal(
  providerSessionGroupShape(codexContextToolEvent.payload),
  null,
  "routine ShellX context MCP probes stay out of visible provider chat",
);

const claudeContextToolEvent: RawEventFrame = {
  t: 1004,
  kind: "provider-session-event",
  payload: {
    tabId: "tab-a",
    runId: "run-1",
    providerId: "claude-code",
    kind: "mcpTool",
    text: "mcp__shellx-host-http__get_session_info",
  },
};

assert.equal(
  providerSessionGroupShape(claudeContextToolEvent.payload),
  null,
  "Claude namespaced ShellX context MCP probes stay out of visible provider chat",
);

for (const toolName of [
  "mcp__shellx-host-http__shellx_health",
  "mcp__shellx-host-http__provider_sessions",
  "mcp__shellx-host-http__event_log",
  "mcp__shellx-host-http__process_list",
  "mcp__shellx-host-http__process_stats",
  "shellx-host-http/capabilities-summary",
  "shellx-host-http/tool-search",
  "mcp__shellx-host-http__tool_search",
  "{\"server\":\"shellx-host-http\",\"tool_name\":\"model_instruction_cards\"}",
  "server=shellx-host-http tool=provider_adapters",
  "ToolSearch",
]) {
  assert.equal(
    providerSessionGroupShape({
      tabId: "tab-a",
      runId: "run-1",
      providerId: "codex-cli",
      kind: "mcpTool",
      text: toolName,
    }),
    null,
    `${toolName} stays out of visible provider chat`,
  );
}

assert.equal(
  providerSessionGroupShape({
    tabId: "tab-a",
    runId: "run-1",
    providerId: "codex-cli",
    kind: "mcpTool",
    text: "mcp__shellx-host-http__send_prompt_to_session",
  })?.kind,
  "tool",
  "user-approved cross-session handoff tool stays visible in provider chat",
);

const providerSearchToolEvent: RawEventFrame = {
  t: 1005,
  kind: "provider-session-event",
  payload: {
    tabId: "tab-a",
    runId: "run-1",
    providerId: "claude-code",
    kind: "mcpTool",
    text: "mcp__shellx-host-http__x_search",
  },
};

assert.deepEqual(providerSessionGroupShape(providerSearchToolEvent.payload), {
  kind: "tool",
  label: "Claude Code MCP tool",
  detail: "mcp__shellx-host-http__x_search",
  status: "running",
});

assert.equal(
  providerSessionGroupShape({
    tabId: "tab-a",
    runId: "run-1",
    providerId: "codex-cli",
    kind: "command",
    text: "/bin/bash -lc \"sed -n '1,220p' /home/user/.codex/plugins/cache/openai-curated/superpowers/2abb1c44/skills/using-superpowers/SKILL.md\"",
    rawType: "item.started/command_execution",
  }),
  null,
  "Codex internal Superpowers bootstrap command stays out of visible provider chat",
);

assert.equal(
  providerSessionGroupShape({
    tabId: "tab-a",
    runId: "run-1",
    providerId: "codex-cli",
    kind: "command",
    text: "/bin/bash -lc \"sed -n '1,200p' /home/user/.codex/skills/.system/superpowers/using-superpowers/SKILL.md\"",
    rawType: "item.completed/command_execution",
  }),
  null,
  "Codex system Superpowers bootstrap command stays out of visible provider chat",
);

assert.equal(
  providerSessionGroupShape({
    tabId: "tab-a",
    runId: "run-1",
    providerId: "codex-cli",
    kind: "command",
    text: "/bin/bash -lc \"sed -n '1,180p' /home/user/.codex/plugins/cache/openai-curated/superpowers/2abb1c44/skills/using-superpowers/SKILL.md\"",
    rawType: "item.started/command_execution",
  }),
  null,
  "Codex Superpowers bootstrap command suppression is range-agnostic",
);

const codexCommandGroups = groupEvents([
  {
    t: 1005,
    kind: "provider-session-event",
    payload: {
      tabId: "tab-a",
      runId: "run-1",
      providerId: "codex-cli",
      kind: "command",
      text: "cargo test",
      rawType: "item.started/command_execution",
    },
  },
  codexCommandDoneEvent,
]);
assert.equal(codexCommandGroups.length, 1, "Codex started/completed command renders as one tool row");
assert.equal((codexCommandGroups[0] as any).status, "success", "Codex completed command row settles");

const claudeCompletedEvent: RawEventFrame = {
  t: 1006,
  kind: "provider-session-event",
  payload: {
    tabId: "tab-a",
    runId: "run-1",
    providerId: "claude-code",
    kind: "completed",
    exitCode: 0,
  },
};
const claudeTerminalSettledGroups = groupEvents([
  providerSearchToolEvent,
  claudeCompletedEvent,
]);
assert.equal(
  claudeTerminalSettledGroups.length,
  2,
  "Claude tool start plus terminal completion renders tool and completion rows",
);
assert.equal(
  (claudeTerminalSettledGroups[0] as any).status,
  "success",
  "Claude tool row settles when the provider run completes",
);

const terminalShape = providerSessionGroupShape(completedEvent.payload);
assert.deepEqual(terminalShape, {
  kind: "system",
  icon: "✓",
  label: "Codex CLI completed",
  detail: "exit 0",
});

assert.equal(providerAdaptersStatePath(), "/provider-adapters/state");
assert.equal(
  providerAdaptersStatePath({ transport: "wsl", wslDistro: "  Ubuntu-24.04  " }),
  "/provider-adapters/state?transport=wsl&wslDistro=Ubuntu-24.04",
);
assert.equal(
  providerAdaptersStatePath({
    transport: "ssh",
    sshHost: " deploy@example.test ",
    sshPort: 2222,
    sshKeyVaultRef: " connections/macmini-key ",
  }),
  "/provider-adapters/state?transport=ssh&sshHost=deploy%40example.test&sshPort=2222&sshKeyVaultRef=connections%2Fmacmini-key",
);
assert.equal(
  providerSessionStatePath("tab A/#1"),
  "/provider-sessions/state?tabId=tab+A%2F%231",
);
assert.equal(
  providerSessionStatePath("tab A/#1", { transport: "wsl", wslDistro: "Ubuntu-24.04" }),
  "/provider-sessions/state?tabId=tab+A%2F%231&transport=wsl&wslDistro=Ubuntu-24.04",
);
assert.equal(
  providerSessionStatePath("tab A/#1", { transport: "ssh", sshHost: "deploy@example.test", sshPort: 2222 }),
  "/provider-sessions/state?tabId=tab+A%2F%231&transport=ssh&sshHost=deploy%40example.test&sshPort=2222",
);
assert.equal(
  providerSessionStatePath("tab A/#1", {
    transport: "ssh",
    sshHost: "deploy@example.test",
    sshPort: 2222,
    sshKeyVaultRef: "connections/macmini-key",
  }),
  "/provider-sessions/state?tabId=tab+A%2F%231&transport=ssh&sshHost=deploy%40example.test&sshPort=2222&sshKeyVaultRef=connections%2Fmacmini-key",
);

assert.deepEqual(
  providerStartRequestBody({
    tabId: "tab-a",
    providerId: "claude-code",
    cwd: "C:\\Users\\FixtureUser\\project",
    prompt: "  inspect this repo  ",
    persistSession: true,
    resume: true,
    providerConversationId: "  019e4ac1-07ab-7551-8d12-efd0aa2dabfb  ",
    permissionMode: "bypassPermissions",
    transport: "wsl",
    wslDistro: "  Ubuntu-24.04  ",
    shellxToolExposure: "off",
  }),
  {
    tabId: "tab-a",
    providerId: "claude-code",
    cwd: "C:\\Users\\FixtureUser\\project",
    prompt: "inspect this repo",
    persistSession: true,
    resume: true,
    providerConversationId: "019e4ac1-07ab-7551-8d12-efd0aa2dabfb",
    permissionMode: "bypassPermissions",
    transport: "wsl",
    wslDistro: "Ubuntu-24.04",
    shellxToolExposure: "off",
    includeShellxTooling: false,
  },
);
assert.deepEqual(
  providerStartRequestBody({
    tabId: "tab-b",
    providerId: "codex-cli",
    cwd: "/tmp/project",
    prompt: "use normal bridge",
    shellxToolExposure: "nativeFirst",
  }),
  {
    tabId: "tab-b",
    providerId: "codex-cli",
    cwd: "/tmp/project",
    prompt: "use normal bridge",
    shellxToolExposure: "nativeFirst",
    includeShellxTooling: true,
  },
);
assert.deepEqual(
  providerStartRequestBody({
    providerId: "codex-cli",
    cwd: "/tmp/project",
    prompt: "  run autonomously  ",
    permissionMode: "auto",
  }),
  {
    providerId: "codex-cli",
    cwd: "/tmp/project",
    prompt: "run autonomously",
    permissionMode: "auto",
  },
);
assert.equal(providerPermissionModeLabel("auto"), "Auto");

assert.deepEqual(providerAbortRequestBody("tab-a", "run-1"), {
  tabId: "tab-a",
  runId: "run-1",
});
assert.deepEqual(
  providerAbortRequestBody("tab-a", "run-1", { transport: "wsl", wslDistro: "  Ubuntu-24.04  " }),
  {
    tabId: "tab-a",
    runId: "run-1",
    transport: "wsl",
    wslDistro: "Ubuntu-24.04",
  },
);
assert.deepEqual(
  providerAbortRequestBody("tab-a", "run-1", {
    transport: "ssh",
    sshHost: " deploy@example.test ",
    sshPort: 2222,
    sshKeyVaultRef: " connections/macmini-key ",
  }),
  {
    tabId: "tab-a",
    runId: "run-1",
    transport: "ssh",
    sshHost: "deploy@example.test",
    sshPort: 2222,
    sshKeyVaultRef: "connections/macmini-key",
  },
);

assert.equal(providerRunPhaseLabel("streaming"), "streaming");
assert.equal(providerRunPhaseLabel("completed"), "completed");
assert.equal(providerRunDetail({
  runId: "run-1",
  tabId: "tab-a",
  providerId: "codex-cli",
  cwd: "/tmp/project",
  transport: "local",
  transportKey: "local",
  phase: "completed",
  promptPreview: "hi",
  startedAtMs: 100,
  updatedAtMs: 250,
  stdoutLineCount: 2,
  stderrLineCount: 1,
  durationMs: 150,
  exitCode: 0,
}), "completed · 2 stdout · 1 stderr · 150 ms · exit 0");

assert.deepEqual(
  providerPermissionModeOptions("codex-cli").map((option) => [option.mode, option.native]),
  [
    ["bypassPermissions", "--dangerously-bypass-approvals-and-sandbox"],
    ["acceptEdits", "--sandbox workspace-write -a never"],
    ["default", "--sandbox workspace-write -a untrusted"],
    ["readOnly", "--sandbox read-only -a never"],
  ],
);
assert.deepEqual(
  providerPermissionModeOptions("claude-code").map((option) => [option.mode, option.native]),
  [
    ["bypassPermissions", "--permission-mode bypassPermissions"],
    ["acceptEdits", "--permission-mode acceptEdits"],
    ["default", "--permission-mode default"],
    ["readOnly", "--permission-mode plan"],
  ],
);
assert.deepEqual(
  providerPermissionModeOptions("antigravity-cli").map((option) => [option.mode, option.native]),
  [
    ["bypassPermissions", "--dangerously-skip-permissions"],
    ["default", "--sandbox"],
  ],
);

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
assert(
  appSource.includes("\"provider-session-event\""),
  "App must subscribe to provider-session-event so provider output reaches chat",
);
assert(
  appSource.includes("startProviderSession({"),
  "App composer flow must start provider sessions through the provider-session debug API",
);
assert(
  appSource.includes("async function sendProviderPromptForTab(") &&
    appSource.includes("permissionMode: providerPermissionModeForAutonomy(tab.autonomy)") &&
    appSource.includes("shellxToolExposureForProviderStart(tab.shellxToolExposure)") &&
    appSource.includes("persistSession: true"),
  "App shared provider send flow must map tab autonomy and tab-scoped ShellX tool exposure into provider sessions",
);
{
  const start = appSource.indexOf("async function sendProviderPromptForTab(");
  const end = appSource.indexOf("async function send(): Promise<void>", start);
  const body = appSource.slice(start, end);
  const startCall = body.indexOf("const started = await startProviderSession({");
  assert(
    body.includes("sessionLockPending: true") &&
      startCall >= 0 &&
      body.indexOf("sessionLockPending: true") < startCall &&
      body.indexOf("sessionLockPending: false") > startCall &&
      body.indexOf("firstMessageMs = Date.now()") > startCall,
    "Provider tabs must lock agent/connection during provider start, release on completion/failure, and set firstMessageMs only after start succeeds",
  );
}
assert(
  appSource.includes("abortProviderSession("),
  "App Stop action must abort provider sessions through the provider-session debug API",
);
assert(
  appSource.includes("connectionId={activeTab?.connectionId ?? null}"),
  "App must pass the active connection id into the right rail provider tooling",
);
assert(
  appSource.includes("shellxToolExposure={activeTab?.shellxToolExposure ?? DEFAULT_SHELLX_TOOL_EXPOSURE}") &&
    appSource.includes("onShellxToolExposureChange={handleShellxToolExposureChange}"),
  "App must pass tab-scoped ShellX tool exposure controls into the right rail",
);

const rightRailSource = readFileSync(new URL("../src/components/RightRail.tsx", import.meta.url), "utf8");
assert(
  rightRailSource.includes("ProviderEnvironmentCard") &&
    rightRailSource.includes("Agent CLIs") &&
    rightRailSource.includes("Grok Build CLI"),
  "RightRail Tools tab must expose provider-neutral Agent CLI health",
);
assert(
  rightRailSource.includes("getProviderAdapterState(providerExecution)") &&
    !rightRailSource.includes("getProviderSessionState(activeTabId, providerExecution)") &&
    !rightRailSource.includes("providerRunDetail(recentRun)") &&
    !rightRailSource.includes("providerRunDetail(activeRun)"),
  "Agent CLI health must refresh adapter state for the active transport without mixing in provider run history",
);
assert(
  rightRailSource.includes("providerExecutionForSession") &&
    rightRailSource.includes("agentScanPresetForSession"),
  "Agent CLI health must derive provider execution and scan target from the active ShellX session",
);
assert(
  rightRailSource.includes("agentCwd?: string | null") &&
    rightRailSource.includes("hasSessionContext") &&
    rightRailSource.includes("sessionInfo?.hasProviderContext === true") &&
    rightRailSource.includes("sessionInfo?.transport === \"wsl\" && hasSessionContext"),
  "Agent CLI health must preserve the active WSL session target instead of falling back to host-local state",
);
assert(
  rightRailSource.includes("connections_list") &&
    rightRailSource.includes("connectionPreset?.transport.kind === \"wsl\""),
  "Agent CLI health must resolve saved WSL presets when no live session snapshot exists",
);
assert(
  rightRailSource.includes("connectionPreset?.transport.kind === \"ssh\"") &&
    rightRailSource.includes("getProviderAdapterState(providerExecution)") &&
    rightRailSource.includes("sshHost: connectionPreset.transport.host?.trim() || null") &&
    rightRailSource.includes("sshKeyVaultRef: connectionPreset.transport.keyVaultRef ?? null") &&
    rightRailSource.includes("execution.sshHost") &&
    rightRailSource.includes("execution.sshKeyVaultRef ?? undefined") &&
    rightRailSource.includes("agent CLI checks support local, WSL, and SSH targets"),
  "Agent CLI health must live-probe saved SSH provider targets instead of falling back to local",
);

const rustLibSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
assert(
  rustLibSource.includes("\"sshPort\": run.ssh_port") &&
    rustLibSource.includes("\"sshKeyVaultRef\": run.ssh_key_vault_ref"),
  "session tooling snapshots must preserve SSH port and key ref for provider sessions",
);

console.log("test-provider-sessions ok");
