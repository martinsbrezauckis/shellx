import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const stateOut = requiredArg("--state-out");
const token = requiredArg("--token");
const instanceId = requiredArg("--instance-id");
const processId = Number(requiredArg("--process-id"));
const version = requiredArg("--version");
const sourceCommit = requiredArg("--source-commit");
const profileRoot = requiredArg("--profile-root");
const fixturePlatform = requiredArg("--platform");
if (!["windows", "macos", "linux"].includes(fixturePlatform)) {
  throw new Error(`unsupported fixture platform: ${fixturePlatform}`);
}
const profileMarkerText = `${JSON.stringify({
  schema: "shellx/release-surface-run-profile@1",
  platform: `${fixturePlatform}-installed`,
  runId: "1".repeat(16),
  nodePath: profileRoot,
  launchPath: profileRoot,
}, null, 2)}\n`;
const gitSegment = sourceCommit.slice(0, 16);
const gitFixturePath = join(profileRoot, ".shellx", `release-surface-git-${gitSegment}`);
const gitTrackedName = `tracked-${gitSegment}.txt`;
const gitUntrackedName = `untracked-${gitSegment}.txt`;
const gitMarker = `SHELLX_RELEASE_GIT_DIFF_${gitSegment}`;
const gitDiff = `diff --git a/${gitTrackedName} b/${gitTrackedName}\n+${gitMarker}\n`;
const historySegment = sourceCommit.slice(0, 16);
const historyMarker = `SHELLX_RELEASE_SESSION_CANARY_${historySegment}`;
const historyTitle = `Release session history ${historySegment}`;
const historySplitAt = Math.floor(historyMarker.length / 2);
const historyLines = [
  JSON.stringify({ t: 1_000, payload: { params: { update: { sessionUpdate: "session_summary_generated", session_summary: historyTitle } } } }),
  JSON.stringify({ t: 2_000, payload: { params: { update: { sessionUpdate: "agent_message_chunk", content: { text: historyMarker.slice(0, historySplitAt) } } } } }),
  JSON.stringify({ t: 2_001, payload: { params: { update: { sessionUpdate: "agent_message_chunk", content: { text: historyMarker.slice(historySplitAt) } } } } }),
];
const mediaDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const mediaBytes = Buffer.from(mediaDataUrl.slice(mediaDataUrl.indexOf(",") + 1), "base64");
const rotatedToken = createHash("sha256").update(`${token}:${sourceCommit}`).digest("hex").slice(0, 32);
const invoked: Array<{ command: string; args: unknown }> = [];
const rawEvents: Array<Record<string, unknown>> = [];
const activeStates = new Map<string, unknown>();
const activeGrokTabs = new Map<string, string>();
let relaySequence = 0;
let browserEvidenceSequence = 0;
const goalStates = new Map<string, Record<string, unknown>>();
let userData: Record<string, unknown> = {};
let connectionPresets: Record<string, unknown>[] = [{
  id: "fixture-connection-private",
  label: "Fixture connection private",
  transport: { kind: "ssh", host: "fixture-host-private" },
  createdMs: 1,
  lastUsedMs: 2,
}];
let outsideConnectors: Record<string, unknown>[] = [{
  id: "fixture-connector-private",
  label: "Fixture connector private",
  enabled: true,
  provider: { kind: "telegram", botTokenVaultKey: "fixture-vault-reference-private", allowedChatIds: [] },
  target: { kind: "telegram_chat", chatId: "fixture-chat-private" },
  dispatchMode: "inbox",
  requireApproval: true,
  createdMs: 1,
  updatedMs: 2,
  lastTestMs: null,
  lastError: null,
}];
const vaultValues = new Map<string, string>();
const vaultMetadata = new Map<string, Record<string, unknown>>();
let marketplaceInstalled = false;
let vaultPanelOpen = false;
let vaultPanelOpenEvents = 0;
let vaultPanelCloseActions = 0;
let debugHighlightResultsBySurface: Record<string, unknown[]> = { app: [] };
let releaseNativePickerLease: { kind: "file"; path: string; pathSha256: string } | null = null;
const vaultPanelSelector = "[data-debug-id='vault-workspace-modal']";

const candidate = createServer(async (request, response) => {
  if (request.url === "/health" && request.method === "GET") {
    return json(response, 200, {
      ok: true,
      processId,
      instanceId,
      appVersion: version,
      buildCommit: sourceCommit,
      debugApiPort: candidateAddress().port,
    });
  }
  if (!authorized(request)) return json(response, 401, { error: "unauthorized" });
  if (request.url === "/release-test/native-picker" && request.method === "POST") {
    const body = await requestJson(request);
    if (releaseNativePickerLease || body.kind !== "file" || typeof body.path !== "string"
      || !existsSync(body.path)) {
      return json(response, 400, { error: "release_native_picker_invalid" });
    }
    releaseNativePickerLease = {
      kind: "file",
      path: body.path,
      pathSha256: createHash("sha256").update(body.path).digest("hex"),
    };
    return json(response, 201, {
      armed: true,
      kind: releaseNativePickerLease.kind,
      pathSha256: releaseNativePickerLease.pathSha256,
    });
  }
  if (request.url === "/release-test/native-picker" && request.method === "GET") {
    return releaseNativePickerLease
      ? json(response, 200, {
        armed: true,
        kind: releaseNativePickerLease.kind,
        pathSha256: releaseNativePickerLease.pathSha256,
      })
      : json(response, 200, { armed: false });
  }
  if (request.url === "/release-test/native-picker" && request.method === "DELETE") {
    const cleared = releaseNativePickerLease !== null;
    releaseNativePickerLease = null;
    return json(response, 200, { cleared });
  }
  if (request.url === "/state/ui" && request.method === "POST") {
    const body = await requestJson(request);
    if (body.openModal === "close" && vaultPanelOpen) {
      vaultPanelOpen = false;
      vaultPanelCloseActions += 1;
    }
    if (Array.isArray(body.debugHighlights)) {
      debugHighlightResultsBySurface = {
        app: body.debugHighlights.map((entry) => {
          const highlight = requireRecord(entry, "debug highlight");
          const resolved = highlight.selector === vaultPanelSelector && vaultPanelOpen;
          return {
            id: highlight.id,
            selector: highlight.selector,
            status: resolved ? "resolved" : "missing",
            ...(resolved ? {
              rect: { left: 40, top: 30, width: 720, height: 560 },
              visibleRect: { left: 40, top: 30, width: 720, height: 560 },
            } : {}),
          };
        }),
      };
    }
    return json(response, 200, { debugHighlightResultsBySurface });
  }
  if (request.url === "/state/ui" && request.method === "GET") {
    return json(response, 200, { debugHighlightResultsBySurface });
  }
  if (request.url === "/state/sessions" && request.method === "GET") {
    return json(response, 200, {
      tabs: [...activeGrokTabs].map(([tabId, cwd]) => ({
        tabId,
        cwd,
        hasActiveChild: true,
        hasSession: true,
        isSsh: false,
        isWsl: false,
      })),
    });
  }
  if (request.url === "/release-test/tauri-invokes" && request.method === "POST") {
    const body = await requestJson(request);
    const command = typeof body.command === "string" ? body.command : "";
    const invokeArgs = requireRecord(body.args, `${command} args`);
    relaySequence += 1;
    const id = `rti-${relaySequence.toString(16).padStart(32, "0")}`;
    invoked.push({ command, args: invokeArgs });
    try {
      activeStates.set(id, { status: "passed", value: commandResult(command, invokeArgs) });
    } catch (error) {
      activeStates.set(id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return json(response, 202, { id, status: "pending" });
  }
  const relayPath = request.url?.match(/^\/release-test\/tauri-invokes\/(rti-[0-9a-f]{32})$/);
  if (relayPath && request.method === "GET") {
    const state = activeStates.get(relayPath[1]!);
    return state === undefined
      ? json(response, 404, { error: "not found" })
      : json(response, 200, state);
  }
  if (relayPath && request.method === "DELETE") {
    return json(response, 200, { removed: activeStates.delete(relayPath[1]!) });
  }
  if (request.url === "/screenshot" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "image/png", "Content-Length": mediaBytes.length });
    response.end(mediaBytes);
    return;
  }
  if (request.url === "/browser/state" && request.method === "GET") {
    return json(response, 200, structuredClone(commandResults.shellx_browser_state));
  }
  if (request.url === "/events/recent?limit=8000" && request.method === "GET") {
    return json(response, 200, structuredClone(rawEvents));
  }
  if (request.url === "/browser/task/start" && request.method === "POST") {
    const body = await requestJson(request);
    const state = requireRecord(commandResults.shellx_browser_state, "Browser fixture state");
    const taskId = "final-surface-history-task";
    const browserTabId = "final-surface-history-tab";
    const engineId = "final-surface-history-engine";
    const startUrl = String(body.startUrl ?? "");
    const engine = browserEngineFixture({ engineId, browserTabId, taskId, url: startUrl });
    state.tasks = [{ taskId, status: "running", profileId: "task-disposable", currentUrl: startUrl }];
    state.tabs = [{ browserTabId, taskId, engineId, profileId: "task-disposable", url: startUrl, lock: null }];
    state.activeTaskId = taskId;
    state.activeBrowserTabId = browserTabId;
    state.engine = structuredClone(engine);
    state.enginePool = { engines: [engine], waiting: [], parkedTabs: [], windowState: "foreground" };
    state.history = [{
      historyId: "final-surface-history-entry",
      taskId,
      profileId: "task-disposable",
      url: startUrl,
      title: "Owned Browser history fixture",
      visitedAtMs: Date.now(),
    }];
    return json(response, 200, { taskId, browserTabId });
  }
  if (request.url?.startsWith("/browser/settle?") && request.method === "GET") {
    const url = new URL(request.url, "http://127.0.0.1");
    const state = requireRecord(commandResults.shellx_browser_state, "Browser fixture state");
    const taskId = url.searchParams.get("taskId");
    const browserTabId = url.searchParams.get("browserTabId");
    const tab = (state.tabs as Array<Record<string, unknown>>).find((row) => row.browserTabId === browserTabId);
    const engine = browserEngineById(state, String(tab?.engineId ?? ""));
    return json(response, 200, {
      settled: true,
      taskId,
      browserTabId,
      taskStatus: "running",
      tabStatus: "ready",
      engineId: engine.engineId,
      engineLoadStatus: engine.loadStatus,
      engineUrl: engine.url,
      revision: `engine-${String(engine.updatedAtMs)}`,
      pendingUrl: engine.pendingUrl,
    });
  }
  if (request.url === "/browser/action" && request.method === "POST") {
    const body = await requestJson(request);
    const state = requireRecord(commandResults.shellx_browser_state, "Browser fixture state");
    const tab = (state.tabs as Array<Record<string, unknown>>).find((row) => row.browserTabId === body.browserTabId);
    if (body.action !== "verify" || body.key !== "text" || body.value !== "Owned Browser settle fixture ready"
      || !tab || tab.taskId !== body.taskId) {
      return json(response, 400, { ok: false, error: "invalid Browser verification fixture" });
    }
    return json(response, 200, {
      ok: true,
      taskId: body.taskId,
      currentUrl: tab.url,
      verification: { passed: true },
      receipt: { kind: "browserVerificationPassed", taskId: body.taskId },
    });
  }
  if (request.url === "/browser/task/finish" && request.method === "POST") {
    const state = requireRecord(commandResults.shellx_browser_state, "Browser fixture state");
    const tasks = state.tasks as Array<Record<string, unknown>>;
    if (tasks[0]) tasks[0].status = "aborted";
    state.activeTaskId = null;
    return json(response, 200, tasks[0] ?? {});
  }
  if (request.url === "/browser/tabs/close" && request.method === "POST") {
    const state = requireRecord(commandResults.shellx_browser_state, "Browser fixture state");
    state.tabs = [];
    state.activeBrowserTabId = null;
    state.engine = {};
    state.enginePool = { engines: [], waiting: [], parkedTabs: [], windowState: "foreground" };
    return json(response, 200, { ok: true });
  }
  if (request.url === "/audit" && request.method === "GET") {
    return json(response, 200, {
      invoked,
      activeStateKeys: [...activeStates.keys()],
      activeGrokTabs: [...activeGrokTabs.entries()],
      vaultPanelOpen,
      vaultPanelOpenEvents,
      vaultPanelCloseActions,
    });
  }
  return json(response, 404, { error: "not found" });
});

const commandResults: Record<string, unknown> = {
  abort_session: "Session aborted",
  cleanup_mcp_children_for_tab: 0,
  agent_cli_setup_state: {
    generatedAtMs: 1,
    target: {
      label: "This Windows machine",
      transport: "local",
      commandRunsOn: "the current Windows desktop",
    },
    providers: [
      providerSetupCard("grok", "Grok Build CLI", true),
      providerSetupCard("codex-cli", "Codex CLI", false),
      providerSetupCard("claude-code", "Claude Code", false),
      providerSetupCard("antigravity-cli", "Antigravity CLI", false),
    ],
  },
  connection_provider_scan: {
    schemaVersion: "shellx.provider-capability-snapshot.v2",
    generatedAtMs: 1,
    freshUntilMs: 60_001,
    target: { key: "local:windows", transport: "local", runtime: "windows", label: "This Windows machine" },
    providers: [
      providerScanRow("grok", true),
      providerScanRow("codex-cli", false),
      providerScanRow("claude-code", false),
      providerScanRow("antigravity-cli", false),
    ],
  },
  connections_list: [{
    id: "fixture-connection-private",
    label: "Fixture connection private",
    transport: { kind: "ssh", host: "fixture-host-private" },
    createdMs: 1,
    lastUsedMs: 2,
  }],
  debug_ui_snapshot: {
    panels: { horizontal: [20, 55, 25], vertical: [70, 30] },
    openTabs: [],
    debugHighlights: [],
    debugHighlightResults: [],
    uiRevision: 7,
  },
  desktop_integration_status: {
    supported: false,
    os: fixturePlatform,
    explorerContextMenuInstalled: false,
    sendToShortcutInstalled: false,
    message: "Fixture status",
  },
  drop_tab_session: true,
  get_build_receipts: [],
  get_build_state: null,
  get_bound_ports: { debugApi: 0, mcpHttp: 5758 },
  get_debug_port: 0,
  get_debug_token: token,
  get_detected_max_tokens: 128_000,
  get_goal_state: null,
  git_branches: {
    branches: [{ name: "release-proof", isCurrent: true, isRemote: false, upstream: null }],
  },
  git_session_diff: {
    ok: true,
    scope: "head",
    repoRoot: gitFixturePath,
    branch: "release-proof",
    diff: gitDiff,
    truncated: false,
    bytes: Buffer.byteLength(gitDiff),
    lastError: null,
  },
  git_session_status: {
    ok: true,
    tabId: `release-git-${gitSegment}`,
    transport: "local",
    cwd: gitFixturePath,
    repoScope: "cwd",
    repoRoot: gitFixturePath,
    head: "abcdef0",
    clean: false,
    staged: 0,
    unstaged: 1,
    untracked: 1,
    conflicts: 0,
    deleted: 0,
    files: [
      { path: gitTrackedName, index: " ", worktree: "M" },
      { path: gitUntrackedName, index: "?", worktree: "?" },
    ],
    lastError: null,
  },
  grok_environment_snapshot: {
    tabId: "final-surface-environment-missing-session",
    status: "idle",
    checkedAtMs: 1,
    transport: "none",
    cwd: null,
    sessionId: null,
    doctor: null,
    inspect: null,
    setup: { summary: { status: "idle", readyCount: 0, attentionCount: 0, totalCount: 0 }, checks: [] },
    readiness: { summary: { status: "idle", readyCount: 0, attentionCount: 0, totalCount: 0 }, checks: [] },
    apiKeyHint: {
      preferredEnv: "XAI_API_KEY",
      legacyEnv: "GROK_CODE_XAI_API_KEY",
      preferredPresent: false,
      legacyPresent: false,
      detail: "fixture-environment-private",
    },
    trace: { available: false, sessionId: null, detail: "fixture-environment-trace-private" },
    error: "No registered tab session yet.",
  },
  get_home_dir: "/home/fixture-private-path",
  host_skill_status: { installed: true, path: "~/.shellx/agent-docs/shellx-host/SKILL.md", body_hash: "a".repeat(64) },
  list_background_tasks: [{
    taskId: "fixture-task",
    origin: "host_mcp",
    commandDisplay: "fixture command must not be retained",
    pid: 4322,
    cpuPct: 0,
    rssMb: 1,
    status: "running",
    startedAtMs: 1,
    recentOutputTail: "fixture output must not be retained",
    tabId: "fixture-tab",
  }],
  list_project_files: [
    { name: "vault-e2e", kind: "dir", size: 0, git_status: null },
    { name: "shellx-final-profile.json", kind: "file", size: profileMarkerText.length, git_status: null },
  ],
  list_stored_sessions: [{
    id: "fixture-session-private",
    title: "Fixture session title private",
    mtimeMs: 1,
    size: 128,
    cwd: "/home/fixture-session-private",
    connectionId: "fixture-connection-private",
    connectionLabel: "Fixture connection private",
    connectionTransport: "ssh",
  }],
  mcp_marketplace_list: [marketplaceEntry("fixture-marketplace-private")],
  outside_connectors_capabilities: [{
    provider: "telegram",
    label: "Telegram bot",
    receiptTier: "platform_accepted",
    supportsThreading: false,
    supportsAttachments: true,
    supportsButtons: false,
    markdownDialect: "telegram_markdown_v2",
    maxMessageBytes: 4096,
  }],
  outside_connectors_events: [{
    id: "fixture-event-private",
    connectorId: "fixture-connector-private",
    connectorLabel: "Fixture connector private",
    provider: "telegram",
    direction: "inbound",
    status: "inbox",
    senderId: "fixture-sender-private",
    conversationId: "fixture-conversation-private",
    guildId: null,
    target: "fixture-target-private",
    dispatchMode: "inbox",
    requireApproval: true,
    textPreview: "fixture message private",
    externalPreview: "fixture external private",
    reason: null,
    createdMs: 1,
  }],
  outside_connectors_list: [{
    id: "fixture-connector-private",
    label: "Fixture connector private",
    enabled: true,
    provider: { kind: "telegram", botTokenVaultKey: "fixture-vault-reference-private", allowedChatIds: [] },
    target: { kind: "telegram_chat", chatId: "fixture-chat-private" },
    dispatchMode: "inbox",
    requireApproval: true,
    createdMs: 1,
    updatedMs: 2,
    lastTestMs: null,
    lastError: null,
  }],
  read_image_as_data_url: mediaDataUrl,
  read_preview_file_as_data_url: mediaDataUrl,
  read_session_activity_source: {
    tabId: "final-surface-activity-missing-session",
    sessionId: null,
    cwd: null,
    transport: "unknown",
    status: "no-session",
    readable: false,
    scratchDir: null,
    hunkRecordsPath: null,
    hunkRecordsJsonl: "",
    updatesPath: null,
    updatesJsonl: "",
    note: "No live agent session is registered for this tab.",
  },
  read_session_jsonl: historyLines,
  read_session_jsonl_tail: { lines: historyLines.slice(-2), omittedLines: 1 },
  read_user_data: {},
  read_text_file_for_path: profileMarkerText,
  read_text_file_if_text: { kind: "text", content: profileMarkerText },
  session_tooling_snapshot: {
    tabId: "final-surface-tooling-fixture",
    session: { transport: "none", cwd: null, hasActiveChild: false },
    desired: [marketplaceEntry("fixture-tooling-private")],
    health: [],
  },
  shellx_browser_state: {
    profiles: [],
    tabs: [],
    bookmarks: [],
    bookmarkToolbar: [],
    history: [],
    tasks: [],
    activeTaskId: null,
    activeBrowserTabId: null,
    windowOpen: false,
    pendingStartUrl: null,
    engine: {},
    enginePool: {},
    engineWaitlist: {},
    privacy: {},
    personalLock: {},
    downloadFolder: null,
    shields: {
      enabled: true,
      adTrackerMode: "balanced",
      cookieMode: "blockThirdParty",
      fingerprintingMode: "compatibility",
      httpsUpgradeEnabled: true,
      scriptBlockingEnabled: false,
      siteOverrides: [],
      updatedAtMs: 1,
    },
    developerMode: {
      enabled: false,
      fullCdpAccess: false,
      policyDisabled: false,
      approvedHosts: [],
      updatedAtMs: 1,
    },
    sessionGrants: [],
    vaultDeposits: [],
    downloads: [],
    uploads: [],
    consoleLogs: [],
    dialogs: [],
    permissions: [],
    popups: [],
    network: [],
    robots: [],
    receipts: [],
  },
  shellx_browser_replay_cowork_prompt_notifications: 0,
  shellx_vault_agent_request_center: {
    pendingCount: 1,
    requests: [{
      requestId: "fixture-vault-request-private",
      requestDigest: "f".repeat(64),
      actorId: "fixture-vault-actor-private",
      actorLabel: "Fixture Vault actor private",
      status: "pending",
      createdAtMs: 1,
      expiresAtMs: 60_001,
      spec: { purpose: "fixture private purpose", program: "fixture-private", bindings: [], timeoutMs: 30_000 },
    }],
    resources: [{
      id: "fixture-vault-resource-private",
      label: "Fixture Vault resource private",
      kind: "secret",
      permission: "visibleAsk",
      fields: ["value"],
      updatedAtMs: 1,
    }],
  },
  shellx_vault_list_grants: [{
    grantId: "fixture-grant-private",
    secretRef: "fixture-secret-private",
    actorScope: "session:fixture",
    operation: "connectorUse",
    createdAtMs: 1,
    expiresAtMs: null,
    revoked: false,
    approved: true,
  }],
  shellxagent_token_read: token,
  resolve_permission_request: false,
  vault_list_keys: ["fixture-key-private"],
  vault_list_keys_with_meta: [{
    key: "fixture-key-meta-private",
    description: "fixture-description-private",
    userOnly: false,
    resourceKind: "secret",
    resourceSummary: null,
    resourceProvider: null,
    resourceFields: [],
    lastModifiedMs: 1,
  }],
  vault_list_resources: [{
    key: "fixture-resource-private",
    description: null,
    userOnly: false,
    resourceKind: "secret",
    resourceSummary: null,
    resourceProvider: null,
    resourceFields: [],
    lastModifiedMs: 1,
  }],
  vault_status: {
    mode: "local",
    unlocked: false,
    recoveryConfirmed: false,
    rememberedDeviceEnabled: false,
    legacyVaultDetected: false,
    activeGrants: 0,
    pendingDeposits: 0,
    syncPending: false,
    lastError: null,
  },
  voice_credential_source: "vault",
  workflow_skill_statuses: [],
};

function commandResult(command: string, invokeArgs: Record<string, unknown>): unknown {
  if (command === "release_test_take_native_picker") {
    if (invokeArgs.kind !== "file") throw new Error("native-picker fixture received the wrong kind");
    const claim = releaseNativePickerLease;
    releaseNativePickerLease = null;
    return claim;
  }
  if (command === "shellx_browser_open_vault_panel") {
    vaultPanelOpen = true;
    vaultPanelOpenEvents += 1;
    for (const delayMs of [250, 1_000, 2_500]) {
      setTimeout(() => {
        vaultPanelOpen = true;
        vaultPanelOpenEvents += 1;
      }, delayMs);
    }
    return null;
  }
  if (command === "shellx_browser_open_window") {
    const state = requireRecord(commandResults.shellx_browser_state, "Browser fixture state");
    const receipt = {
      receiptId: "final-surface-browser-window-opened-receipt",
      kind: "browserWindowOpened",
      taskId: null,
      profileId: null,
      summary: "ShellX Browser window opened",
      t: Date.now(),
      sequence: 1,
      evidence: { windowLabel: "shellx-browser", startUrl: invokeArgs.startUrl ?? null },
    };
    state.windowOpen = true;
    state.pendingStartUrl = invokeArgs.startUrl ?? null;
    state.enginePool = { ...requireRecord(state.enginePool, "Browser fixture engine pool"), windowState: "foreground" };
    (state.receipts as unknown[]).push(receipt);
    return {
      ok: true,
      windowLabel: "shellx-browser",
      startUrl: invokeArgs.startUrl ?? null,
      receipt,
    };
  }
  if (command === "shellx_vault_agent_request_approve" || command === "shellx_vault_agent_request_deny") {
    const directory = join(profileRoot, "vault-e2e");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "agent-state.lock"), "");
    if (command === "shellx_vault_agent_request_approve") {
      writeFileSync(join(directory, "agent-state.json"), "{\"version\":1}\n");
    }
    throw new Error("agent request not found");
  }
  if (command === "start_grok_session") {
    const tabId = `final-surface-start-grok-${sourceCommit.slice(0, 16)}`;
    const expectedKeys = [
      "connectionId",
      "cwd",
      "loadSessionId",
      "mcpServers",
      "tabId",
      "wslDistro",
      "wslGrokPath",
    ];
    if (JSON.stringify(Object.keys(invokeArgs).sort()) !== JSON.stringify(expectedKeys)
      || invokeArgs.cwd !== profileRoot
      || invokeArgs.tabId !== tabId
      || invokeArgs.connectionId !== null
      || invokeArgs.loadSessionId !== null
      || invokeArgs.mcpServers !== null
      || invokeArgs.wslDistro !== null
      || invokeArgs.wslGrokPath !== null) {
      throw new Error("start_grok_session fixture received drifted local lifecycle arguments");
    }
    activeGrokTabs.set(tabId, profileRoot);
    return `Grok session started in ${profileRoot}`;
  }
  if (command === "abort_session" || command === "drop_tab_session") {
    if (typeof invokeArgs.tabId === "string") activeGrokTabs.delete(invokeArgs.tabId);
    return command === "abort_session" ? "Session aborted" : true;
  }
  const rejection = expectedRejection(command, invokeArgs);
  if (rejection) throw new Error(rejection);

  if (command === "agent_cli_setup_recheck") return commandResults.agent_cli_setup_state;
  if (command === "agent_cli_setup_cancel_install") return false;
  if (command === "pty_kill") return null;
  if (command === "reject_build_plan" || command === "pause_build" || command === "halt_build") return false;
  if (command === "set_permission_mode") return "bypassPermissions";

  if (command === "shellxagent_token_regenerate") {
    writeFileSync(join(profileRoot, ".shellx", "shellxagent.token"), rotatedToken, { encoding: "utf8", mode: 0o600 });
    return rotatedToken;
  }
  if (command === "shellxagent_token_read") {
    return readFileSync(join(profileRoot, ".shellx", "shellxagent.token"), "utf8").trim();
  }
  if (command === "capture_app_screenshot_to_file") {
    const directory = join(profileRoot, ".grok", "shellx-screenshots");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "shellx-screenshot-1000.png");
    writeFileSync(path, mediaBytes);
    return path;
  }
  if (command === "shellx_browser_state") {
    return structuredClone(commandResults.shellx_browser_state);
  }
  if (command === "shellx_browser_operator_export_flight_recorder") {
    return createBrowserEvidenceArtifact(invokeArgs);
  }
  if (command === "shellx_browser_operator_evidence_summary") {
    const limit = typeof invokeArgs.limit === "number" && Number.isSafeInteger(invokeArgs.limit)
      ? Math.min(100, Math.max(1, invokeArgs.limit))
      : 20;
    const state = requireRecord(commandResults.shellx_browser_state, "Browser fixture state");
    const receipts = (state.receipts as Array<Record<string, unknown>>)
      .filter((receipt) => receipt.kind === "browserFlightRecorderExported")
      .slice(-limit)
      .reverse()
      .map((receipt) => structuredClone(receipt));
    return {
      ok: true,
      schemas: {
        attempt: "sx.flightRecorder.v1",
        evaluation: "sx.evaluation.v1",
        ratingPolicy: "sx.evaluation-rating.v1",
      },
      routedActions: {
        read: "evidence",
        export: "flightRecorderExport",
        evaluate: "evaluationWrite",
      },
      recent: receipts,
      count: receipts.length,
      callerScoped: false,
      durableRecovered: 0,
      durableScanTruncated: false,
      durableScanFailed: false,
      durableSkipped: 0,
    };
  }
  if (command === "shellx_browser_sync_engine") {
    const request = requireRecord(invokeArgs.request, `${command}.request`);
    const state = requireRecord(commandResults.shellx_browser_state, "Browser fixture state");
    const engine = browserEngineById(state, String(request.engineId ?? ""));
    if (request.browserTabId !== engine.browserTabId || request.profileId !== engine.profileId
      || request.url !== engine.url || request.preserveExistingPage !== true) {
      throw new Error("Browser engine sync fixture received drifted task ownership");
    }
    engine.bounds = structuredClone(requireRecord(request.bounds, `${command}.request.bounds`));
    engine.updatedAtMs = Number(engine.updatedAtMs) + 1;
    state.engine = structuredClone(engine);
    return structuredClone(engine);
  }
  if (command === "shellx_browser_update_developer_mode") {
    const request = requireRecord(invokeArgs.request, `${command}.request`);
    const state = requireRecord(commandResults.shellx_browser_state, "Browser fixture state");
    const current = requireRecord(state.developerMode, "Browser fixture developer mode");
    state.developerMode = {
      ...current,
      enabled: request.enabled,
      fullCdpAccess: request.fullCdpAccess,
      policyDisabled: request.policyDisabled,
      approvedHosts: structuredClone(request.approvedHosts),
      updatedAtMs: Date.now(),
    };
    return { developerMode: structuredClone(state.developerMode) };
  }
  if (command === "shellx_browser_update_download_folder") {
    const request = requireRecord(invokeArgs.request, `${command}.request`);
    const state = requireRecord(commandResults.shellx_browser_state, "Browser fixture state");
    state.downloadFolder = request.downloadFolder ?? null;
    writeBrowserSettingsFixture(state);
    return state.downloadFolder;
  }
  if (command === "shellx_browser_update_shields") {
    const request = requireRecord(invokeArgs.request, `${command}.request`);
    const state = requireRecord(commandResults.shellx_browser_state, "Browser fixture state");
    const current = requireRecord(state.shields, "Browser fixture shields");
    state.shields = {
      ...current,
      enabled: request.enabled,
      adTrackerMode: request.adTrackerMode,
      cookieMode: request.cookieMode,
      fingerprintingMode: request.fingerprintingMode,
      httpsUpgradeEnabled: request.httpsUpgradeEnabled,
      scriptBlockingEnabled: request.scriptBlockingEnabled,
      updatedAtMs: Date.now(),
    };
    writeBrowserSettingsFixture(state);
    return {
      shields: structuredClone(state.shields),
      runtimeApply: { ok: true, result: null },
    };
  }
  if (command === "shellx_browser_clear_history") {
    const state = requireRecord(commandResults.shellx_browser_state, "Browser fixture state");
    const cleared = Array.isArray(state.history) ? state.history.length : 0;
    state.history = [];
    const receipt = {
      receiptId: "final-surface-history-cleared-receipt",
      kind: "browserHistoryCleared",
      taskId: state.activeTaskId,
      profileId: "task-disposable",
      summary: `Cleared ${cleared} Browser history entries`,
      t: Date.now(),
      sequence: 1,
      evidence: { cleared },
    };
    (state.receipts as unknown[]).push(receipt);
    return receipt;
  }
  if (command === "renderer_error") {
    rawEvents.push({
      t: Date.now(),
      kind: "renderer-error",
      payload: {
        message: invokeArgs.message,
        stack: invokeArgs.stack,
        componentStack: invokeArgs.componentStack,
      },
    });
    return null;
  }

  if (command === "mcp_marketplace_install") {
    marketplaceInstalled = true;
    mkdirSync(join(profileRoot, ".shellx"), { recursive: true });
    mkdirSync(join(profileRoot, ".grok"), { recursive: true });
    writeFileSync(join(profileRoot, ".shellx", "mcp-marketplace.json"), JSON.stringify({ entries: { context7: { installed: true, enabled: true } } }));
    writeFileSync(join(profileRoot, ".grok", "config.toml"), "# fixture context7\n");
    return null;
  }
  if (command === "mcp_marketplace_uninstall") {
    marketplaceInstalled = false;
    writeFileSync(join(profileRoot, ".shellx", "mcp-marketplace.json"), JSON.stringify({ entries: { context7: { installed: false, enabled: true } } }));
    writeFileSync(join(profileRoot, ".grok", "config.toml"), "");
    return null;
  }
  if (command === "mcp_marketplace_list") {
    return [marketplaceEntry("context7", marketplaceInstalled), marketplaceEntry("fixture-marketplace-private")];
  }

  if (command === "connections_list") return connectionPresets;
  if (command === "connections_save") {
    const preset = structuredClone(requireRecord(invokeArgs.preset, "connections_save.preset"));
    connectionPresets = [...connectionPresets.filter((row) => row.id !== preset.id), preset];
    return preset;
  }
  if (command === "connections_delete") {
    const id = String(invokeArgs.id ?? "");
    const before = connectionPresets.length;
    connectionPresets = connectionPresets.filter((row) => row.id !== id);
    return connectionPresets.length !== before;
  }
  if (command === "connections_test") {
    return { reachable: false, latencyMs: null, error: "unknown connection id" };
  }

  if (command === "outside_connectors_list") return outsideConnectors;
  if (command === "outside_connectors_save") {
    const connector = structuredClone(requireRecord(invokeArgs.connector, "outside_connectors_save.connector"));
    outsideConnectors = [...outsideConnectors.filter((row) => row.id !== connector.id), connector];
    return connector;
  }
  if (command === "outside_connectors_delete") {
    const id = String(invokeArgs.id ?? "");
    const before = outsideConnectors.length;
    outsideConnectors = outsideConnectors.filter((row) => row.id !== id);
    return outsideConnectors.length !== before;
  }
  if (command === "outside_connectors_test") {
    return { reachable: false, provider: "unknown", latencyMs: null, identity: null, error: "unknown connector id" };
  }

  if (command === "copy_to_scope") {
    const source = String(invokeArgs.src ?? "");
    const destination = join(String(invokeArgs.destDir ?? ""), "source.txt");
    copyFileSync(source, destination);
    return destination;
  }
  if (command === "copy_asset_to_scope") {
    const source = String(invokeArgs.src ?? "");
    const destination = join(String(invokeArgs.destDir ?? ""), ".shellx", "assets");
    mkdirSync(destination, { recursive: true });
    const path = join(destination, "source.txt");
    copyFileSync(source, path);
    return path;
  }
  if (command === "save_dropped_attachment_to_scope") {
    const destination = join(String(invokeArgs.destDir ?? ""), ".shellx", "attachments");
    mkdirSync(destination, { recursive: true });
    const path = join(destination, String(invokeArgs.filename ?? "attachment.bin"));
    writeFileSync(path, Buffer.from(String(invokeArgs.dataBase64 ?? ""), "base64"));
    return path;
  }
  if (command === "shellx_browser_copy_local_artifact") {
    const request = requireRecord(invokeArgs.request, `${command}.request`);
    const source = String(request.sourcePath ?? "");
    const path = join(String(request.destinationDir ?? ""), String(request.fileName ?? "artifact.bin"));
    copyFileSync(source, path);
    return localArtifact(path);
  }
  if (command === "shellx_browser_write_text_artifact") {
    const request = requireRecord(invokeArgs.request, `${command}.request`);
    const path = join(String(request.destinationDir ?? ""), String(request.fileName ?? "artifact.txt"));
    writeFileSync(path, String(request.content ?? ""));
    return localArtifact(path);
  }

  if (command === "write_user_data") {
    userData = requireRecord(invokeArgs.data, "write_user_data.data");
    return null;
  }
  if (command === "read_user_data") return userData;
  if (command === "delete_user_data_section") {
    const key = String(invokeArgs.key ?? "");
    const removed = Object.prototype.hasOwnProperty.call(userData, key);
    if (removed) {
      const next = { ...userData };
      delete next[key];
      userData = next;
    }
    return removed;
  }

  if (command === "append_session_log") {
    const path = sessionFixturePath(invokeArgs);
    appendFileSync(path, `${String(invokeArgs.line ?? "")}\n`, "utf8");
    return null;
  }
  if (command === "rename_past_session") {
    const path = sessionFixturePath(invokeArgs);
    appendFileSync(path, `${JSON.stringify({
      t: 3_001,
      kind: "ui",
      payload: {
        _meta: { kind: "title-override" },
        title: String(invokeArgs.newTitle ?? ""),
      },
    })}\n`, "utf8");
    return null;
  }
  if (command === "delete_session_files") {
    const ids = Array.isArray(invokeArgs.ids) ? invokeArgs.ids.map(String) : [];
    const deleted: string[] = [];
    for (const id of ids) {
      const path = join(profileRoot, ".shellx", "sessions", `${id}.jsonl`);
      if (!existsSync(path)) continue;
      rmSync(path);
      deleted.push(id);
    }
    return deleted;
  }
  if (command === "read_session_jsonl" || command === "read_session_jsonl_tail") {
    const path = sessionFixturePath(invokeArgs);
    const lines = existsSync(path)
      ? readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean)
      : [];
    if (command === "read_session_jsonl") return lines;
    const limit = Math.max(1, Number(invokeArgs.limit ?? 1));
    return {
      lines: lines.slice(-limit),
      omittedLines: Math.max(0, lines.length - limit),
    };
  }

  if (command === "set_goal_mode") {
    const tabId = String(invokeArgs.tabId ?? "");
    if (invokeArgs.on === true) {
      const cwd = String(invokeArgs.cwd ?? "");
      const objective = String(invokeArgs.objective ?? "");
      const scratchboardPath = join(cwd, "goal.md");
      writeFileSync(
        scratchboardPath,
        `# Goal: ${objective}\n\nStatus: AWAITING_APPROVAL\n\n_fixture is drafting the plan…_\n`,
        "utf8",
      );
      goalStates.set(tabId, {
        active: true,
        objective,
        scratchboard_path: scratchboardPath,
        transport_kind: "local",
        last_continuation_at_ms: 0,
        continuations_total: 0,
        started_at_ms: 1,
        paused_by_user: false,
        halted: false,
        halted_reason: null,
        awaiting_approval: true,
        plan_turn_completed: false,
        approved_at_ms: 0,
      });
    } else {
      goalStates.delete(tabId);
    }
    return null;
  }
  if (command === "get_goal_state") return goalStates.get(String(invokeArgs.tabId ?? "")) ?? null;
  if (command === "pause_goal" || command === "resume_goal" || command === "mark_goal_complete") {
    const state = goalStates.get(String(invokeArgs.tabId ?? ""));
    if (state) {
      if (command === "pause_goal") state.paused_by_user = true;
      if (command === "resume_goal") state.paused_by_user = false;
      if (command === "mark_goal_complete") state.active = false;
    }
    return null;
  }
  if (command === "reject_goal_plan") {
    return goalStates.delete(String(invokeArgs.tabId ?? ""));
  }

  if (command === "vault_get") return vaultValues.get(String(invokeArgs.key ?? "")) ?? null;
  if (command === "vault_set" || command === "vault_set_resource") {
    const key = String(invokeArgs.key ?? "");
    vaultValues.set(key, String(invokeArgs.value ?? ""));
    vaultMetadata.set(key, vaultMetaFromArgs(key, invokeArgs));
    return null;
  }
  if (command === "vault_delete") {
    const key = String(invokeArgs.key ?? "");
    vaultValues.delete(key);
    vaultMetadata.delete(key);
    return null;
  }
  if (command === "vault_update_metadata") {
    const key = String(invokeArgs.key ?? "");
    const current = vaultMetadata.get(key);
    if (!current) throw new Error(`vault key not found: ${key}`);
    vaultMetadata.set(key, {
      ...current,
      description: invokeArgs.description ?? null,
      userOnly: invokeArgs.userOnly === true,
    });
    return null;
  }
  if (command === "vault_update_resource_metadata") {
    const key = String(invokeArgs.key ?? "");
    if (!vaultValues.has(key)) throw new Error(`vault key not found: ${key}`);
    vaultMetadata.set(key, vaultMetaFromArgs(key, invokeArgs));
    return null;
  }
  if (command === "vault_list_keys_with_meta") {
    return [...commandResults.vault_list_keys_with_meta as unknown[], ...vaultMetadata.values()];
  }
  if (command === "vault_list_keys") {
    return [...commandResults.vault_list_keys as unknown[], ...vaultValues.keys()].sort();
  }

  if (command === "git_session_create_checkpoint") {
    const path = join(profileRoot, ".shellx", "git-checkpoints", "fixture-repo", "release-git", "1000-final-surface-checkpoint");
    mkdirSync(join(path, "untracked"), { recursive: true });
    writeFileSync(join(path, "checkpoint.json"), "{}\n");
    writeFileSync(join(path, "unstaged.patch"), gitDiff);
    writeFileSync(join(path, "staged.patch"), "");
    writeFileSync(join(path, "untracked.json"), "{}\n");
    writeFileSync(join(path, "status.txt"), "## release-proof\n");
    return {
      ok: true,
      checkpoint: {
        id: "1000-final-surface-checkpoint",
        label: "Final surface checkpoint",
        createdAtMs: 1000,
        branch: "release-proof",
        head: "abcdef0",
        repoRoot: gitFixturePath,
        path,
        staged: 0,
        unstaged: 1,
        untracked: 1,
        conflicts: 0,
        worktreeFingerprint: "f".repeat(64),
        untrackedSnapshot: {},
      },
      lastError: null,
    };
  }
  if (command === "git_session_create_worktree") {
    const path = join(gitFixturePath, ".worktrees", "final-surface-worktree");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, ".git"), "gitdir: fixture\n");
    return {
      ok: true,
      sourceBranch: "release-proof",
      newBranch: "final-surface-worktree",
      worktreePath: path,
      output: "Preparing worktree",
      lastError: null,
    };
  }

  if (!Object.prototype.hasOwnProperty.call(commandResults, command)) {
    throw new Error(`unsupported command ${command}`);
  }
  return commandResults[command];
}

function createBrowserEvidenceArtifact(invokeArgs: Record<string, unknown>): Record<string, unknown> {
  const request = requireRecord(invokeArgs.request, "operator Flight Recorder request");
  const state = requireRecord(commandResults.shellx_browser_state, "Browser fixture state");
  const taskId = String(request.taskId ?? "");
  const browserTabId = String(request.browserTabId ?? "");
  const task = (state.tasks as Array<Record<string, unknown>>).find((entry) => entry.taskId === taskId);
  const tab = (state.tabs as Array<Record<string, unknown>>).find((entry) => (
    entry.browserTabId === browserTabId && entry.taskId === taskId
  ));
  if (!task || !tab) throw new Error("operator Flight Recorder fixture requires one exact owned task and tab");
  browserEvidenceSequence += 1;
  const attemptId = `fixture-operator-attempt-${browserEvidenceSequence}`;
  const directory = join(profileRoot, ".shellx", "browser-artifacts", "shellx-browser-flight-recorder");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${attemptId}.json`);
  const payload = {
    schemaVersion: "sx.flightRecorder.v1",
    attemptId,
    manifest: { taskId, browserTabId },
    events: [],
    receipts: [],
  };
  const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  writeFileSync(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const receipt = {
    receiptId: `fixture-operator-receipt-${browserEvidenceSequence}`,
    kind: "browserFlightRecorderExported",
    taskId,
    profileId: "task-disposable",
    summary: `Recorded Browser attempt ${attemptId}`,
    t: Date.now(),
    sequence: browserEvidenceSequence,
    evidence: {
      attemptId,
      taskId,
      browserTabId,
      path,
      bytes: bytes.length,
      sha256,
      events: 0,
      receipts: 0,
      gapCount: 0,
      evidenceComplete: true,
      source: "shellx-browser-flight-recorder",
    },
  };
  (state.receipts as Array<Record<string, unknown>>).push(receipt);
  return {
    attemptId,
    taskId,
    browserTabId,
    path,
    bytes: bytes.length,
    sha256,
    events: 0,
    receipts: 0,
    droppedEvents: 0,
    droppedReceipts: 0,
    retentionDroppedEvents: 0,
    retentionDroppedReceipts: 0,
    gapCount: 0,
    sanitizerLossCount: 0,
    evidenceComplete: true,
    firstSourceSequence: null,
    lastSourceSequence: null,
    source: "shellx-browser-flight-recorder",
    createdAtMs: Date.now(),
    receipt,
  };
}

function writeBrowserSettingsFixture(state: Record<string, unknown>): void {
  const directory = join(profileRoot, ".shellx");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "browser-settings.json"), `${JSON.stringify({
    version: 1,
    privacy: state.privacy,
    shields: state.shields,
    personalLock: state.personalLock,
    personalLockPinSalt: null,
    personalLockPinHash: null,
    downloadFolder: state.downloadFolder,
  }, null, 2)}\n`);
}

function expectedRejection(command: string, invokeArgs: Record<string, unknown>): string | null {
  const errors: Record<string, string> = {
    add_build_operator_note: "operator note is empty",
    agent_cli_setup_confirm_install: "agent_cli_setup.confirm: unknown or expired confirmation id 'final-surface-absent-confirmation'",
    agent_cli_setup_prepare_install: "agent_cli_setup.prepare: providerId is required",
    approve_build_plan: "No live session for this tab; reconnect before approving the build plan.",
    approve_goal_plan: "No live session for this tab; reconnect before approving the plan.",
    archive_session_artifacts: "archive_session_artifacts: save_path is empty",
    shellx_browser_approve_developer_mode_host: "Developer Mode approval requires a host or current page URL",
    shellx_browser_claim_cowork_prompt: "Browser cowork prompt claim is unknown, expired, or already consumed",
    shellx_browser_control_task: "unknown browser task 'final-surface-absent-browser-task'",
    shellx_browser_delegate_tab_to_agent: "unknown browser tab 'final-surface-absent-browser-tab'",
    shellx_browser_finish_task: "unknown browser task 'final-surface-absent-browser-task'",
    shellx_browser_grant_transfer: "unknown browser download transfer 'final-surface-absent-transfer'",
    shellx_browser_remove_site_shields: "site shield override removal requires a host",
    shellx_browser_resolve_dialog: "unknown browser dialog 'final-surface-absent-dialog'",
    shellx_browser_resolve_permission: "unknown browser permission 'final-surface-absent-browser-permission'",
    shellx_browser_resolve_session_grant: "unknown browser session grant 'final-surface-absent-session-grant'",
    shellx_browser_send_cowork_prompt: "Browser cowork prompt sends is restricted to the 'shellx-browser' window",
    shellx_browser_take_back_tab_from_agent: "unknown browser tab 'final-surface-absent-browser-tab'",
    shellx_browser_update_personal_lock: "Personal Browser Lock PIN must be at least 4 characters",
    shellx_browser_update_privacy: "unknown browser profile 'final-surface-absent-browser-profile'",
    shellx_browser_update_site_shields: "site shield override requires a host",
    shellx_vault_approve_grant: "grantNotFound",
    shellx_vault_begin_setup: "vault passphrase must not be empty",
    shellx_vault_confirm_recovery_saved: "no pending vault setup",
    shellx_vault_create_grant: "grant secretRef cannot be empty",
    shellx_vault_lock: "vault is not configured",
    shellx_vault_revoke_grant: "grantNotFound",
    shellx_vault_set_remembered_device_enabled: "master passphrase is required to remember this device",
    shellx_vault_unlock: "vault passphrase must not be empty",
    start_build_mode: "/build requires an objective",
    grok_trace_export: "no registered tab session",
    interject_prompt: "Empty interjection",
    mcp_marketplace_install: "unknown marketplace id: final-surface-absent-marketplace",
    mcp_marketplace_set_enabled: "unknown marketplace id: final-surface-absent-marketplace",
    open_url_in_browser: "only http(s) URLs are openable, got: file:///final-surface-denied",
    outside_connectors_simulate: "unknown connector id",
    pty_create: "tab_id is required",
    pty_resize: "unknown terminal: TerminalKey { tab_id: \"final-surface-absent-terminal\", terminal_id: \"final-surface-absent-terminal\" }",
    pty_write: "unknown terminal: TerminalKey { tab_id: \"final-surface-absent-terminal\", terminal_id: \"final-surface-absent-terminal\" }",
    recheck_build_blocker: "no build run for this tab",
    request_goal_replan: "Plan feedback is empty.",
    resume_build: "Connect this tab before resuming Build Mode.",
    send_prompt: "Empty prompt",
    synthesize_voice: "empty text",
    task_kill: "bad task_id: final-surface-invalid-task",
    task_pause: "bad task_id: final-surface-invalid-task",
    task_resume: "bad task_id: final-surface-invalid-task",
    transcribe_audio_blob: "No audio captured (recording was too short).",
  };
  if (command === "mcp_marketplace_install" && invokeArgs.id === "context7") return null;
  return errors[command] ?? null;
}

function vaultMetaFromArgs(key: string, invokeArgs: Record<string, unknown>): Record<string, unknown> {
  return {
    key,
    description: invokeArgs.description ?? null,
    userOnly: invokeArgs.userOnly === true,
    resourceKind: invokeArgs.resourceKind ?? "secret",
    resourceSummary: invokeArgs.resourceSummary ?? null,
    resourceProvider: invokeArgs.resourceProvider ?? null,
    resourceFields: Array.isArray(invokeArgs.resourceFields) ? invokeArgs.resourceFields : [],
    lastModifiedMs: 0,
  };
}

function localArtifact(path: string): Record<string, unknown> {
  const bytes = readFileSync(path);
  return {
    finalPath: path,
    displayName: path.split(/[\\/]/).at(-1),
    mimeType: "text/plain",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function sessionFixturePath(invokeArgs: Record<string, unknown>): string {
  const id = String(invokeArgs.sessionId ?? "");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("fixture session id is invalid");
  return join(profileRoot, ".shellx", "sessions", `${id}.jsonl`);
}

candidate.listen(0, "127.0.0.1", () => {
  const port = candidateAddress().port;
  commandResults.get_bound_ports = { debugApi: port, mcpHttp: 5758 };
  commandResults.get_debug_port = port;
  writeFileSync(stateOut, `${JSON.stringify({ candidatePort: port })}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => candidate.close(() => process.exit(0)));
}

function requiredArg(name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : args.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function authorized(request: IncomingMessage): boolean {
  const current = readFileSync(join(profileRoot, ".shellx", "shellxagent.token"), "utf8").trim();
  return request.headers.authorization === `Bearer ${current}`;
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 384 * 1024) throw new Error("fixture request body is too large");
    chunks.push(value);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("fixture request must be an object");
  return parsed as Record<string, unknown>;
}

function candidateAddress(): { port: number } {
  const address = candidate.address();
  if (!address || typeof address === "string") throw new Error("candidate fixture is not listening");
  return { port: address.port };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function browserEngineFixture(input: {
  engineId: string;
  browserTabId: string;
  taskId: string;
  url: string;
}): Record<string, unknown> {
  return {
    engineId: input.engineId,
    browserTabId: input.browserTabId,
    taskId: input.taskId,
    profileId: "task-disposable",
    mounted: true,
    webviewLabel: `shellx-browser-engine-${input.engineId}`,
    url: input.url,
    pendingUrl: null,
    title: "ShellX release settle",
    loadStatus: "loaded",
    bounds: { x: 20, y: 30, width: 1200, height: 800 },
    updatedAtMs: Date.now(),
  };
}

function browserEngineById(state: Record<string, unknown>, engineId: string): Record<string, unknown> {
  const pool = requireRecord(state.enginePool, "Browser fixture engine pool");
  const engines = Array.isArray(pool.engines) ? pool.engines : [];
  const matches = engines
    .map((engine) => requireRecord(engine, "Browser fixture engine"))
    .filter((engine) => engine.engineId === engineId);
  if (matches.length !== 1) throw new Error("Browser fixture did not contain exactly one requested engine");
  return matches[0]!;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function providerScanRow(providerId: string, ready: boolean): Record<string, unknown> {
  return ready
    ? {
        providerId,
        canRun: true,
        status: "ready",
        binary: "C:\\Users\\Fixture\\.grok\\bin\\grok.exe-private",
        version: "grok fixture-version-private",
        binarySha256: "b".repeat(64),
        binaryBytes: 1024,
        targetKey: "local:windows",
        checkedAtMs: 1,
      }
    : {
        providerId,
        canRun: false,
        status: "missing",
        targetKey: "local:windows",
        detail: "No supported CLI binary resolved on this exact target.",
        checkedAtMs: 1,
      };
}

function providerSetupCard(providerId: string, displayName: string, ready: boolean): Record<string, unknown> {
  return {
    providerId,
    displayName,
    status: ready ? "ready" : "missing",
    canRun: ready,
    ...(ready ? {
      binary: "C:\\Users\\Fixture\\.grok\\bin\\grok.exe-private",
      version: "grok fixture-version-private",
    } : {}),
    installable: true,
    recommendedMethodId: "official",
    installMethods: [],
    docsUrl: "https://example.invalid/docs",
    officialSourceUrl: "https://example.invalid/source",
    lastVerifiedAt: "2026-07-28",
    authHint: "Authenticate after installation.",
  };
}

function marketplaceEntry(id: string, installed = false): Record<string, unknown> {
  return {
    id,
    name: "Fixture marketplace private",
    tier: "S",
    kind: "stdio",
    description: "Fixture marketplace description private",
    category: "fixture",
    vaultKeys: ["fixture-marketplace-vault-private"],
    installed,
    enabled: true,
    keysAvailable: [false],
    allKeysPresent: false,
  };
}
