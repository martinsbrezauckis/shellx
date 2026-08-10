import type { RawEventFrame } from "../types/acp";

export type ProviderId = "codex-cli" | "claude-code" | "antigravity-cli";

export type ProviderExecutionTransport = "local" | "wsl" | "ssh";
export type SshRemoteRuntime = "posix" | "windows" | "windows_wsl";

export interface ProviderExecutionTargetLabelInput {
  transport: ProviderExecutionTransport;
  wslDistro?: string | null;
  sshHost?: string | null;
  sshRemoteRuntime?: SshRemoteRuntime;
  sshWslDistro?: string | null;
}

export function providerExecutionTargetLabel(
  input: ProviderExecutionTargetLabelInput,
): string {
  if (input.transport === "local") return "Local";
  if (input.transport === "wsl") {
    return `WSL ${input.wslDistro?.trim() || "unknown"}`;
  }
  const host = input.sshHost?.trim() || "unknown";
  if (input.sshRemoteRuntime === "windows") {
    return `native Windows over SSH ${host}`;
  }
  if (input.sshRemoteRuntime === "windows_wsl") {
    return `WSL ${input.sshWslDistro?.trim() || "unknown"} via Windows OpenSSH ${host}`;
  }
  return `SSH ${host}`;
}

export type ProviderPermissionMode =
  | "auto"
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "readOnly";

export type ProviderCodexDriver = "execJson" | "appServer";

export type ProviderShellxToolExposure =
  | "nativeFirst"
  | "hostBridge"
  | "hostFull"
  | "off";

export interface ProviderPermissionModeOption {
  mode: ProviderPermissionMode;
  label: string;
  detail: string;
  native: string;
}

export type ProviderRunPhase =
  | "starting"
  | "streaming"
  | "completed"
  | "failed"
  | "aborted";

export type ProviderSessionEventKind =
  | "started"
  | "text"
  | "textDelta"
  | "tool"
  | "fileChange"
  | "command"
  | "mcpTool"
  | "subagent"
  | "thinking"
  | "completed"
  | "failed"
  | "aborted"
  | "raw";

export interface ProviderRunSnapshot {
  runId: string;
  processTaskId?: string;
  tabId: string;
  providerId: ProviderId;
  cwd: string;
  transport: ProviderExecutionTransport;
  transportKey: string;
  wslDistro?: string;
  sshHost?: string;
  sshPort?: number;
  sshKeyVaultRef?: string;
  sshRemoteRuntime?: SshRemoteRuntime;
  sshWslDistro?: string;
  phase: ProviderRunPhase;
  promptPreview: string;
  startedAtMs: number;
  updatedAtMs: number;
  stdoutLineCount: number;
  stderrLineCount: number;
  lastTextAtMs?: number;
  durationMs?: number;
  exitCode?: number;
  error?: string;
  providerConversationId?: string;
  resumeFromProviderConversationId?: string;
  persistSession: boolean;
  permissionMode: ProviderPermissionMode;
  shellxToolExposure: ProviderShellxToolExposure;
}

export interface ProviderSessionState {
  tabId: string;
  transport: ProviderExecutionTransport;
  transportKey: string;
  wslDistro?: string;
  sshHost?: string;
  sshPort?: number;
  sshKeyVaultRef?: string;
  sshRemoteRuntime?: SshRemoteRuntime;
  sshWslDistro?: string;
  activeRun?: ProviderRunSnapshot;
  recentRuns: ProviderRunSnapshot[];
  storedConversations: Partial<Record<ProviderId, string>>;
}

export type AgentRunKind =
  | "tab-session"
  | "provider-run"
  | "shellx-host-subagent"
  | "provider-native-subagent";

export type AgentRunNativeVisibility =
  | "observed"
  | "notExposed"
  | "notApplicable"
  | "shellxHost";

export interface AgentRunRow {
  id: string;
  kind: AgentRunKind | string;
  scope: string;
  tabId?: string | null;
  title?: string | null;
  agentId?: string;
  agentLabel?: string;
  providerId?: ProviderId | string;
  runId?: string;
  subagentId?: string;
  parentSubagentId?: string;
  toolCallId?: string;
  persona?: string;
  label?: string;
  taskPreview?: string;
  status: string;
  phase?: string | null;
  active: boolean;
  focused?: boolean;
  cwd?: string;
  surface?: {
    transport?: ProviderExecutionTransport | string;
    cwd?: string | null;
    wslDistro?: string | null;
    sshHost?: string | null;
    sshPort?: number | null;
    [key: string]: unknown;
  };
  promptPreview?: string;
  startedAtMs?: number;
  updatedAtMs?: number;
  durationMs?: number | null;
  exitCode?: number | null;
  error?: string | null;
  tokens?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    reasoningTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    updatedAtMs?: number;
  } | number | null;
  metrics?: {
    firstResponseAtMs?: number | null;
    firstTextAtMs?: number | null;
    firstActionAtMs?: number | null;
    firstSuccessfulActionAtMs?: number | null;
    timeToFirstResponseMs?: number | null;
    timeToFirstTextMs?: number | null;
    timeToFirstActionMs?: number | null;
    timeToFirstSuccessfulActionMs?: number | null;
    toolCallCount: number;
    toolSuccessCount: number;
    toolFailureCount: number;
    subagentCount: number;
    lineageLinkedEventCount: number;
  };
  nativeVisibility?: AgentRunNativeVisibility | string;
}

export interface AgentRunManagerState {
  generatedAtMs: number;
  activeTabId?: string | null;
  summary: {
    runCount: number;
    runningCount: number;
    tabSessionCount: number;
    providerRunCount: number;
    shellxSubagentCount: number;
    observedNativeSubagentCount: number;
  };
  nativeSubagents: {
    visibility: "observed" | "notExposed" | string;
    observedCount: number;
    note: string;
  };
  runs: AgentRunRow[];
}

export interface ProviderAdapterSummary {
  providerId: ProviderId;
  label: string;
  binaryNames: string[];
  installed: boolean;
  binary?: string;
  version?: string;
  canRun: boolean;
  streamKind: "jsonl" | "stream-json" | "plain-text" | string;
  notes: string[];
  lastRunId?: string;
  lastRunAtMs?: number;
  lastError?: string;
}

export interface ProviderAdapterState {
  providers: ProviderAdapterSummary[];
}

export interface ProviderSessionStartRequest {
  tabId?: string;
  providerId: ProviderId;
  cwd: string;
  prompt: string;
  includeMcpProbe?: boolean;
  includeShellxTooling?: boolean;
  shellxToolExposure?: ProviderShellxToolExposure;
  mcpPath?: string;
  timeoutMs?: number;
  persistSession?: boolean;
  resume?: boolean;
  resumeLast?: boolean;
  providerConversationId?: string;
  permissionMode?: ProviderPermissionMode;
  codexDriver?: ProviderCodexDriver;
  transport?: ProviderExecutionTransport;
  wslDistro?: string;
  sshHost?: string;
  sshPort?: number;
  sshKeyVaultRef?: string;
  sshRemoteRuntime?: SshRemoteRuntime;
  sshWslDistro?: string;
  releaseFixture?: {
    id: "provider-action-lifecycle";
    action: string;
  };
}

export interface ProviderSessionAbortRequest {
  tabId?: string;
  runId?: string;
  transport?: ProviderExecutionTransport;
  wslDistro?: string;
  sshHost?: string;
  sshPort?: number;
  sshKeyVaultRef?: string;
  sshRemoteRuntime?: SshRemoteRuntime;
  sshWslDistro?: string;
}

export interface ProviderSessionStartResponse {
  ok: true;
  run: ProviderRunSnapshot;
}

export interface ProviderSessionAbortResponse {
  ok: boolean;
  tabId: string;
  runId?: string;
  aborted: boolean;
  error?: string;
}

export interface ProviderSessionEventPayload {
  schemaVersion?: number;
  eventId?: string;
  sequence?: number;
  occurredAtMs?: number;
  tabId: string;
  runId: string;
  providerId: ProviderId;
  kind: ProviderSessionEventKind;
  status?: ProviderEventStatus;
  turnId?: string;
  itemId?: string;
  parentItemId?: string;
  toolCallId?: string;
  toolName?: string;
  toolArguments?: ProviderEventContentReference;
  toolResult?: ProviderEventContentReference;
  subagentId?: string;
  parentSubagentId?: string;
  model?: string;
  protocol?: string;
  protocolVersion?: string;
  binaryVersion?: string;
  capabilities?: string[];
  target?: ProviderEventTargetSnapshot;
  text?: string;
  rawType?: string;
  exitCode?: number;
  error?: string;
  providerConversationId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  usage?: ProviderEventUsage;
  artifacts?: ProviderEventArtifact[];
  rawReference?: ProviderEventContentReference;
}

export type ProviderEventStatus =
  | "started"
  | "inProgress"
  | "completed"
  | "failed"
  | "aborted"
  | "waitingForApproval";

export interface ProviderEventTargetSnapshot {
  transport: ProviderExecutionTransport;
  transportKey: string;
  wslDistro?: string;
  sshHost?: string;
  sshPort?: number;
  sshRemoteRuntime?: SshRemoteRuntime;
  sshWslDistro?: string;
  providerToolShell?: string;
}

export interface ProviderEventUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ProviderEventContentReference {
  sha256: string;
  byteLength: number;
  redacted: boolean;
  artifactId?: string;
}

export interface ProviderEventArtifact {
  artifactId: string;
  kind: string;
  uri?: string;
  mimeType?: string;
  sha256?: string;
  byteLength?: number;
}

export type ProviderSessionGroupShape =
  | { kind: "message"; text: string }
  | { kind: "tool"; label: string; detail: string; status: string }
  | { kind: "system"; icon: string; label: string; detail?: string };

export function isProviderSessionFrame(
  frame: RawEventFrame,
): frame is RawEventFrame & { payload: ProviderSessionEventPayload } {
  return frame.kind === "provider-session-event" && isProviderSessionPayload(frame.payload);
}

export function isProviderSessionPayload(value: unknown): value is ProviderSessionEventPayload {
  if (value == null || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.tabId === "string" &&
    typeof p.runId === "string" &&
    isProviderId(p.providerId) &&
    isProviderSessionEventKind(p.kind)
  );
}

export function providerSessionDisplayText(payload: unknown): string {
  if (!isProviderSessionPayload(payload)) return "";
  return typeof payload.text === "string" ? payload.text : "";
}

export interface ProviderAdapterStateRequest {
  transport?: ProviderExecutionTransport;
  wslDistro?: string | null;
  sshHost?: string | null;
  sshPort?: number | null;
  sshKeyVaultRef?: string | null;
  sshRemoteRuntime?: SshRemoteRuntime;
  sshWslDistro?: string | null;
}

export interface ProviderSessionStateRequest {
  transport?: ProviderExecutionTransport;
  wslDistro?: string | null;
  sshHost?: string | null;
  sshPort?: number | null;
  sshKeyVaultRef?: string | null;
  sshRemoteRuntime?: SshRemoteRuntime;
  sshWslDistro?: string | null;
}

function appendProviderExecutionParams(
  params: URLSearchParams,
  request: ProviderAdapterStateRequest | ProviderSessionStateRequest,
): void {
  if (request.transport) params.set("transport", request.transport);
  if (request.wslDistro && request.wslDistro.trim()) {
    params.set("wslDistro", request.wslDistro.trim());
  }
  if (request.sshHost && request.sshHost.trim()) {
    params.set("sshHost", request.sshHost.trim());
  }
  if (request.sshPort !== undefined && request.sshPort !== null) {
    params.set("sshPort", String(request.sshPort));
  }
  if (request.sshKeyVaultRef && request.sshKeyVaultRef.trim()) {
    params.set("sshKeyVaultRef", request.sshKeyVaultRef.trim());
  }
  if (request.sshRemoteRuntime) params.set("sshRemoteRuntime", request.sshRemoteRuntime);
  if (request.sshWslDistro && request.sshWslDistro.trim()) {
    params.set("sshWslDistro", request.sshWslDistro.trim());
  }
}

export function providerAdaptersStatePath(request: ProviderAdapterStateRequest = {}): string {
  const params = new URLSearchParams();
  appendProviderExecutionParams(params, request);
  const query = params.toString();
  return query ? `/provider-adapters/state?${query}` : "/provider-adapters/state";
}

export function providerSessionStatePath(
  tabId: string,
  request: ProviderSessionStateRequest = {},
): string {
  const params = new URLSearchParams();
  params.set("tabId", tabId);
  appendProviderExecutionParams(params, request);
  return `/provider-sessions/state?${params.toString()}`;
}

export function agentRunsStatePath(tabId?: string | null): string {
  if (!tabId || !tabId.trim()) return "/state/agent_runs";
  const params = new URLSearchParams();
  params.set("tabId", tabId.trim());
  return `/state/agent_runs?${params.toString()}`;
}

export function providerSessionsStartPath(): string {
  return "/provider-sessions/start";
}

export function providerSessionsAbortPath(): string {
  return "/provider-sessions/abort";
}

export function providerStartRequestBody(
  request: ProviderSessionStartRequest,
): ProviderSessionStartRequest {
  const body: ProviderSessionStartRequest = {
    providerId: request.providerId,
    cwd: request.cwd,
    prompt: request.prompt.trim(),
  };
  if (request.tabId) body.tabId = request.tabId;
  if (request.includeMcpProbe !== undefined) body.includeMcpProbe = request.includeMcpProbe;
  if (request.shellxToolExposure !== undefined) {
    body.shellxToolExposure = normalizeShellxToolExposure(request.shellxToolExposure);
    body.includeShellxTooling = shellxToolExposureIncludesHostTools(body.shellxToolExposure);
  } else if (request.includeShellxTooling !== undefined) {
    body.includeShellxTooling = request.includeShellxTooling;
  }
  if (request.mcpPath && request.mcpPath.trim()) body.mcpPath = request.mcpPath.trim();
  if (request.timeoutMs !== undefined) body.timeoutMs = request.timeoutMs;
  if (request.persistSession !== undefined) body.persistSession = request.persistSession;
  if (request.resume !== undefined) body.resume = request.resume;
  if (request.resumeLast !== undefined) body.resumeLast = request.resumeLast;
  if (request.providerConversationId && request.providerConversationId.trim()) {
    body.providerConversationId = request.providerConversationId.trim();
  }
  if (request.permissionMode) body.permissionMode = request.permissionMode;
  if (request.codexDriver) body.codexDriver = request.codexDriver;
  if (request.transport) body.transport = request.transport;
  if (request.wslDistro && request.wslDistro.trim()) body.wslDistro = request.wslDistro.trim();
  if (request.sshHost && request.sshHost.trim()) body.sshHost = request.sshHost.trim();
  if (request.sshPort !== undefined) body.sshPort = request.sshPort;
  if (request.sshKeyVaultRef && request.sshKeyVaultRef.trim()) {
    body.sshKeyVaultRef = request.sshKeyVaultRef.trim();
  }
  if (request.sshRemoteRuntime) body.sshRemoteRuntime = request.sshRemoteRuntime;
  if (request.sshWslDistro && request.sshWslDistro.trim()) {
    body.sshWslDistro = request.sshWslDistro.trim();
  }
  if (request.releaseFixture) body.releaseFixture = { ...request.releaseFixture };
  return body;
}

export const DEFAULT_SHELLX_TOOL_EXPOSURE: ProviderShellxToolExposure = "nativeFirst";

export function normalizeShellxToolExposure(
  exposure: ProviderShellxToolExposure | string | null | undefined,
): ProviderShellxToolExposure {
  switch (exposure) {
    case "nativeFirst":
    case "hostBridge":
    case "hostFull":
    case "off":
      return exposure;
    default:
      return DEFAULT_SHELLX_TOOL_EXPOSURE;
  }
}

export function shellxToolExposureIncludesHostTools(
  exposure: ProviderShellxToolExposure | string | null | undefined,
): boolean {
  return normalizeShellxToolExposure(exposure) !== "off";
}

export function shellxToolExposureForProviderStart(
  exposure: ProviderShellxToolExposure | string | null | undefined,
): Pick<ProviderSessionStartRequest, "shellxToolExposure" | "includeShellxTooling"> {
  const shellxToolExposure = normalizeShellxToolExposure(exposure);
  return {
    shellxToolExposure,
    includeShellxTooling: shellxToolExposureIncludesHostTools(shellxToolExposure),
  };
}

export function providerAbortRequestBody(
  tabId: string,
  runId?: string,
  request: ProviderSessionStateRequest = {},
): ProviderSessionAbortRequest {
  const body: ProviderSessionAbortRequest = { tabId };
  if (runId) body.runId = runId;
  if (request.transport) body.transport = request.transport;
  if (request.wslDistro && request.wslDistro.trim()) {
    body.wslDistro = request.wslDistro.trim();
  }
  if (request.sshHost && request.sshHost.trim()) {
    body.sshHost = request.sshHost.trim();
  }
  if (request.sshPort !== undefined && request.sshPort !== null) {
    body.sshPort = request.sshPort;
  }
  if (request.sshKeyVaultRef && request.sshKeyVaultRef.trim()) {
    body.sshKeyVaultRef = request.sshKeyVaultRef.trim();
  }
  if (request.sshRemoteRuntime) body.sshRemoteRuntime = request.sshRemoteRuntime;
  if (request.sshWslDistro && request.sshWslDistro.trim()) {
    body.sshWslDistro = request.sshWslDistro.trim();
  }
  return body;
}

export function providerSessionLabel(payload: unknown): string {
  if (!isProviderSessionPayload(payload)) return "Provider session";
  const provider = providerDisplayName(payload.providerId);
  switch (payload.kind) {
    case "command":
      return `${provider} command`;
    case "fileChange":
      return `${provider} file change`;
    case "mcpTool":
      return `${provider} MCP tool`;
    case "tool":
      return `${provider} tool`;
    case "subagent":
      return `${provider} subagent`;
    case "thinking":
      return `${provider} thinking`;
    case "started":
      return `${provider} started`;
    case "completed":
      return `${provider} completed`;
    case "failed":
      return `${provider} failed`;
    case "aborted":
      return `${provider} aborted`;
    case "raw":
      return `${provider} event`;
    case "text":
    case "textDelta":
      return provider;
  }
}

export function providerSessionToolStatus(payload: unknown): string {
  if (!isProviderSessionPayload(payload)) return "?";
  switch (payload.status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "aborted":
      return "aborted";
    case "waitingForApproval":
      return "waiting";
    case "started":
    case "inProgress":
      return "running";
  }
  if (payload.rawType?.startsWith("item.completed/")) return "success";
  switch (payload.kind) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "aborted":
      return "aborted";
    default:
      return "running";
  }
}

export function providerRunPhaseLabel(phase: ProviderRunPhase): string {
  switch (phase) {
    case "starting":
      return "starting";
    case "streaming":
      return "streaming";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
      return "aborted";
  }
}

export function providerRunDetail(run: ProviderRunSnapshot): string {
  const parts = [
    providerRunPhaseLabel(run.phase),
    `${run.stdoutLineCount} stdout`,
    `${run.stderrLineCount} stderr`,
  ];
  if (typeof run.durationMs === "number") {
    parts.push(`${run.durationMs} ms`);
  }
  if (typeof run.exitCode === "number") {
    parts.push(`exit ${run.exitCode}`);
  }
  if (run.providerConversationId) {
    parts.push(`session ${shortProviderConversationId(run.providerConversationId)}`);
  }
  if (run.error) {
    parts.push(run.error);
  }
  return parts.join(" · ");
}

export function providerPermissionModeLabel(mode: ProviderPermissionMode): string {
  switch (mode) {
    case "default":
      return "Provider default";
    case "acceptEdits":
      return "Accept edits";
    case "auto":
    case "bypassPermissions":
      return "Auto";
    case "readOnly":
      return "Read-only";
  }
}

export function providerPermissionModeOptions(
  providerId: ProviderId,
): ProviderPermissionModeOption[] {
  if (providerId === "codex-cli") {
    return [
      {
        mode: "bypassPermissions",
        label: "Auto",
        detail: "Codex bypasses approvals and sandbox for fully automated runs.",
        native: "--dangerously-bypass-approvals-and-sandbox",
      },
      {
        mode: "acceptEdits",
        label: "Accept edits",
        detail: "Codex can write in the workspace without approval prompts.",
        native: "--sandbox workspace-write -a never",
      },
      {
        mode: "default",
        label: "Provider default",
        detail: "Codex uses workspace-write with native untrusted approval behavior.",
        native: "--sandbox workspace-write -a untrusted",
      },
      {
        mode: "readOnly",
        label: "Read-only",
        detail: "Runs in read-only sandbox mode.",
        native: "--sandbox read-only -a never",
      },
    ];
  }
  if (providerId === "claude-code") {
    return [
      {
        mode: "bypassPermissions",
        label: "Auto",
        detail: "Claude Code runs with bypassPermissions.",
        native: "--permission-mode bypassPermissions",
      },
      {
        mode: "acceptEdits",
        label: "Accept edits",
        detail: "Claude Code auto-accepts edit operations but keeps its native mode semantics.",
        native: "--permission-mode acceptEdits",
      },
      {
        mode: "default",
        label: "Provider default",
        detail: "Claude Code uses its default permission prompts.",
        native: "--permission-mode default",
      },
      {
        mode: "readOnly",
        label: "Plan",
        detail: "Claude Code uses plan mode for read-only planning.",
        native: "--permission-mode plan",
      },
    ];
  }
  return [
    {
      mode: "bypassPermissions",
      label: "Auto",
      detail: "Antigravity skips native permissions for automated runs.",
      native: "--dangerously-skip-permissions",
    },
    {
      mode: "default",
      label: "Sandbox",
      detail: "Antigravity runs with its native sandbox flag.",
      native: "--sandbox",
    },
  ];
}

export function shortProviderConversationId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

export function providerSessionGroupShape(payload: unknown): ProviderSessionGroupShape | null {
  if (!isProviderSessionPayload(payload)) return null;
  if (payload.kind === "raw" || payload.kind === "thinking") return null;
  if (isLowSignalProviderToolPayload(payload)) return null;
  if (isLowSignalProviderCommandPayload(payload)) return null;

  if ((payload.kind === "text" || payload.kind === "textDelta") && payload.text) {
    return { kind: "message", text: payload.text };
  }

  if (
    payload.kind === "command" ||
    payload.kind === "fileChange" ||
    payload.kind === "mcpTool" ||
    payload.kind === "tool" ||
    payload.kind === "subagent"
  ) {
    return {
      kind: "tool",
      label: providerSessionLabel(payload),
      detail: payload.text ?? payload.toolName ?? payload.rawType ?? "",
      status: providerSessionToolStatus(payload),
    };
  }

  return {
    kind: "system",
    icon: providerSessionSystemIcon(payload.kind),
    label: providerSessionLabel(payload),
    detail: providerSessionTerminalDetail(payload),
  };
}

function isLowSignalProviderToolPayload(payload: ProviderSessionEventPayload): boolean {
  if (payload.kind !== "mcpTool" && payload.kind !== "tool") return false;
  const candidates = normalizeProviderToolTextCandidates(payload.text ?? payload.rawType ?? "");
  return candidates.some((candidate) => LOW_SIGNAL_PROVIDER_TOOLS.has(candidate));
}

function isLowSignalProviderCommandPayload(payload: ProviderSessionEventPayload): boolean {
  if (payload.kind !== "command" || payload.providerId !== "codex-cli") return false;
  if (!payload.rawType?.includes("command_execution")) return false;
  const text = payload.text ?? "";
  return /\bsed\s+-n\s+['"]?1,\d+p['"]?\s+/.test(text) &&
    /(?:^|[\\/])\.codex[\\/](?:skills|plugins[\\/]cache)[\\/].*[\\/]using-superpowers[\\/]SKILL\.md\b/.test(text);
}

const LOW_SIGNAL_PROVIDER_TOOLS = new Set([
  "capabilities_summary",
  "environment",
  "event_log",
  "get_session_info",
  "grok_environment",
  "model_instruction_cards",
  "process_list",
  "process_stats",
  "provider_adapters",
  "provider_sessions",
  "search_tool",
  "session_tooling",
  "shellx_health",
  "health",
  "session_info",
  "capabilities",
  "capability",
  "tool_search",
  "toolsearch",
]);

function normalizeProviderToolTextCandidates(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const candidates = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = normalizeProviderToolName(value);
    if (normalized) candidates.add(normalized);
  };
  add(trimmed);
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      for (const key of ["tool", "tool_name", "toolName", "name", "command", "path"]) {
        add(parsed[key]);
      }
    }
  } catch {
    // Plain provider summaries are expected; JSON is only a defensive path.
  }
  const shellxTool = /(?:mcp__)?shellx[-_]host[-_]http(?:__|[./:>\s-]+)([A-Za-z0-9_-]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = shellxTool.exec(trimmed)) !== null) add(match[1]);
  for (const token of trimmed.split(/[^A-Za-z0-9_-]+/)) add(token);
  return [...candidates];
}

function normalizeProviderToolName(text: string): string {
  const trimmed = text.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!trimmed) return "";
  const withoutNamespace = trimmed
    .replace(/^mcp__shellx[-_]host[-_]http__/, "")
    .replace(/^shellx[-_]host[-_]http__/, "");
  return withoutNamespace.replace(/-/g, "_").toLowerCase();
}

export function providerDisplayName(providerId: ProviderId): string {
  switch (providerId) {
    case "codex-cli":
      return "Codex CLI";
    case "claude-code":
      return "Claude Code";
    case "antigravity-cli":
      return "Antigravity";
  }
}

function providerSessionTerminalDetail(payload: ProviderSessionEventPayload): string | undefined {
  if (payload.error) return payload.error;
  if (typeof payload.exitCode === "number") return `exit ${payload.exitCode}`;
  if (payload.text && payload.kind !== "started") return payload.text;
  return undefined;
}

function providerSessionSystemIcon(kind: ProviderSessionEventKind): string {
  switch (kind) {
    case "completed":
      return "✓";
    case "failed":
      return "⚠";
    case "aborted":
      return "⏹";
    case "started":
      return "⊞";
    default:
      return "≡";
  }
}

function isProviderId(value: unknown): value is ProviderId {
  return value === "codex-cli" || value === "claude-code" || value === "antigravity-cli";
}

function isProviderSessionEventKind(value: unknown): value is ProviderSessionEventKind {
  return (
    value === "started" ||
    value === "text" ||
    value === "textDelta" ||
    value === "tool" ||
    value === "fileChange" ||
    value === "command" ||
    value === "mcpTool" ||
    value === "subagent" ||
    value === "thinking" ||
    value === "completed" ||
    value === "failed" ||
    value === "aborted" ||
    value === "raw"
  );
}
