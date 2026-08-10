import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const stateOut = requiredArg(args, "--state-out");
const token = requiredArg(args, "--token");
const instanceId = requiredArg(args, "--instance-id");
const processId = Number(requiredArg(args, "--process-id"));
const version = requiredArg(args, "--version");
const sourceCommit = requiredArg(args, "--source-commit");
const artifactRoot = requiredArg(args, "--artifact-root");
const fixturePlatform = requiredArg(args, "--platform");
if (!["windows", "macos", "linux"].includes(fixturePlatform)) {
  throw new Error(`unsupported fixture platform: ${fixturePlatform}`);
}
const requests: string[] = [];
const settleTaskId = `release-browser-settle-task-${sourceCommit.slice(0, 16)}`;
const settleTabId = `release-browser-settle-tab-${sourceCommit.slice(0, 16)}`;
let browserTaskIndex = 0;
let browserTabIndex = 0;
const browserTasks = new Map<string, string>();
const browserTaskCallerSessions = new Map<string, string | null>();
const browserTabs = new Map<string, string>();
const browserTaskUrls = new Map<string, string>();
const browserTabLocks = new Map<string, Record<string, unknown>>();
let activeBrowserTabId: string | null = null;
let bookmarkReceiptIndex = 0;
const bookmarks: Array<Record<string, unknown>> = [
  { bookmarkId: "fixture-bookmark-private", url: "https://fixture-private.invalid/" },
];
const vaultEntries: Array<Record<string, unknown>> = [
  { key: "fixture-key-private", resourceKind: "secret" },
];
const enginePool = {
  engines: [],
  limits: {
    configuredParallelAgents: "auto",
    effectiveBackgroundEngines: 4,
    maxBackgroundEngines: 4,
    idleEngineTimeoutMinutes: 10,
    disposableProfileCleanupMinutes: 5,
    lowMemoryFallback: "waitlist",
  },
  resourcePressure: {
    status: "normal",
    detectedRamGb: 32,
    freeRamMb: 8192,
    cpuPressure: null,
    batterySaver: null,
  },
  waiting: [],
  parkedTabs: [],
  windowState: "foreground",
  automationMode: "normal",
};
let panels = {
  horizontal: [18, 56, 26],
  vertical: [72, 28],
};
let previewTarget: Record<string, unknown> | null = null;
let settings = {
  browserDownloadFolder: "",
  chatFontPx: 15,
  density: "default",
  githubGhBinary: "gh",
  theme: "black",
};
let connectionReceiptIndex = 0;
const connections: Array<Record<string, unknown>> = [{
  id: "conn-fixture-private",
  label: "Fixture private connection",
  transport: { kind: "local" },
  createdMs: 1,
  lastUsedMs: 0,
}];
let outsideConnectorReceiptIndex = 0;
const outsideConnectors: Array<Record<string, unknown>> = [{
  id: "oconn-fixture-private",
  label: "Fixture private connector",
  enabled: false,
  provider: { kind: "telegram", botTokenVaultKey: "fixture/private/token-ref", allowedChatIds: [] },
  target: { mode: "activeTab" },
  dispatchMode: "inbox",
  requireApproval: true,
  createdMs: 1,
  updatedMs: 1,
  lastTestMs: null,
  lastError: null,
}];
let uiBottomTab = "Chat";
let uiOpenModal: string | null = null;
let uiDebugHighlights: Array<Record<string, unknown>> = [];
let uiDebugHighlightResultsBySurface: Record<string, Array<Record<string, unknown>>> = {};
let uiRevision = 1;
let lastUiPatchMs: number | null = null;
let lastUiPatchSource: string | null = null;
let vaultE2eReceiptIndex = 0;
let vaultOwnedGrantIndex = 0;
let vaultSetupIndex = 0;
let pendingVaultConfirmationId: string | null = null;
let vaultSetupStatus = vaultBaselineStatus();
const vaultE2eSecrets = new Set<string>();
const vaultE2eGrants = new Map<string, {
  grantId: string;
  secretRef: string;
  origin: string;
  approved: boolean;
  revoked: boolean;
  expired: boolean;
}>();
let vaultE2eAudit: Array<Record<string, unknown>> = [];
let vaultAgentRequestIndex = 0;
const vaultAgentRequests: Array<Record<string, unknown>> = [
  { requestId: "fixture-request-private", actorId: "fixture-actor-private", status: "pending" },
];
const vaultAgentResources: Array<Record<string, unknown>> = [
  { id: "fixture-resource-private" },
];
let previewGeneration = 0;
const previewStates = new Map<string, Record<string, unknown>>();
let browserArtifactIndex = 0;
const browserRecipeArtifacts = new Set<string>();
let browserMonotonicIndex = 0;
const browserConsoleLogs: Array<Record<string, unknown>> = [];
const browserMonotonicReceipts: Array<Record<string, unknown>> = [];
const browserDownloads: Array<Record<string, unknown>> = [];
const browserUploads: Array<Record<string, unknown>> = [];
const browserRobots: Array<Record<string, unknown>> = [];
const browserDialogs: Array<Record<string, unknown>> = [];
const browserPermissions: Array<Record<string, unknown>> = [];
const browserPopups: Array<Record<string, unknown>> = [];
const browserSessionGrants: Array<Record<string, unknown>> = [];
let browserWindowOpen = false;
let browserPendingStartUrl: string | null = null;
const goalStates = new Map<string, Record<string, unknown>>();
const goalLastClears = new Map<string, Record<string, unknown>>();
const grokProviderTabs = new Map<string, { cwd: string }>();
const providerLifecycleRuns = new Map<string, Record<string, unknown>>();
const providerLifecycleEvents: Array<Record<string, unknown>> = [];
let providerAdapterRunIndex = 0;
let fsWatchIndex = 0;
const fsWatchers = new Map<string, {
  watchId: string;
  watching: string;
  recursive: boolean;
  debounceMs: number;
  startedAtMs: number;
}>();
let releaseRelayIndex = 0;
let releaseClipboardLeaseId: string | null = null;
let releaseNativePickerLease: { kind: "file" | "directory"; pathSha256: string } | null = null;
const releaseRelayStates = new Map<string, {
  nonce: string;
  command: string;
  args: Record<string, unknown> | null;
  status: "pending" | "claimed" | "passed";
  value?: unknown;
}>();

const server = createServer(async (request, response) => {
  const path = request.url ?? "";
  const requestUrl = new URL(path, "http://127.0.0.1");
  if (path === "/health" && request.method === "GET") {
    return json(response, 200, {
      ok: true,
      processId,
      instanceId,
      appVersion: version,
      buildCommit: sourceCommit,
      debugApiPort: address().port,
    });
  }
  const previewPageMatch = /^\/preview-fixture\/([^/]+)\/(\d+)\/release-preview\.html$/.exec(requestUrl.pathname);
  if (previewPageMatch && request.method === "GET") {
    const tabId = decodeURIComponent(previewPageMatch[1]!);
    const state = previewStates.get(tabId);
    if (state?.status !== "running" || state.url !== `http://127.0.0.1:${address().port}${requestUrl.pathname}`) {
      return text(response, 404, "preview stopped");
    }
    return text(
      response,
      200,
      "<script data-shellx-preview-doctor>window.__shellxPreviewDoctorInstalled=true;</script>"
        + "<!doctype html><title>ShellX release Preview</title><main>SHELLX_RELEASE_OWNED_STATIC_PREVIEW_035</main>\n",
      "text/html; charset=utf-8",
    );
  }
  if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: "unauthorized" });
  if (path === "/audit" && request.method === "GET") return json(response, 200, {
    requests,
    bookmarks,
    vaultEntries,
    enginePool,
    panels,
    previewTarget,
    settings,
    connections,
    outsideConnectors,
    fsWatchIds: [...fsWatchers.values()].map((watcher) => watcher.watchId),
    ui: uiState(),
    vaultE2e: {
      secretRefs: [...vaultE2eSecrets],
      grantIds: [...vaultE2eGrants.keys()],
      audit: vaultE2eAudit,
    },
  });
  requests.push(requestUrl.pathname === "/browser/settle" ? "/browser/settle" : path);
  if (request.method === "POST" && requestUrl.pathname === "/release-test/clipboard") {
    const body = await requestJson(request);
    if (body.action === "preflight") {
      if (releaseClipboardLeaseId) return json(response, 409, { error: "release_clipboard_lease_active" });
      releaseClipboardLeaseId = `rcb-${createHash("sha256").update(`${sourceCommit}:clipboard`).digest("hex").slice(0, 32)}`;
      return json(response, 200, {
        ok: true,
        action: "preflight",
        empty: true,
        leaseId: releaseClipboardLeaseId,
        platform: fixturePlatform,
      });
    }
    if (body.action === "releaseEmpty" && body.leaseId === releaseClipboardLeaseId) {
      return json(response, 409, {
        error: "release_clipboard_not_empty",
        message: "an empty clipboard lease cannot be released while native format metadata is nonempty",
      });
    }
    if (body.action === "abandon" && body.leaseId === releaseClipboardLeaseId) {
      releaseClipboardLeaseId = null;
      return json(response, 200, { ok: true, action: "abandon", empty: false, platform: fixturePlatform });
    }
    return json(response, 404, { error: "release_clipboard_lease_not_found" });
  }
  if (requestUrl.pathname === "/release-test/native-picker") {
    if (request.method === "POST") {
      const body = await requestJson(request);
      if (releaseNativePickerLease || body.kind !== "file" || typeof body.path !== "string"
        || !existsSync(body.path)) {
        return json(response, 400, { error: "release_native_picker_invalid" });
      }
      releaseNativePickerLease = {
        kind: "file",
        pathSha256: createHash("sha256").update(body.path).digest("hex"),
      };
      return json(response, 201, { armed: true, ...releaseNativePickerLease });
    }
    if (request.method === "GET") {
      return releaseNativePickerLease
        ? json(response, 200, { armed: true, ...releaseNativePickerLease })
        : json(response, 200, { armed: false });
    }
    if (request.method === "DELETE") {
      const cleared = releaseNativePickerLease !== null;
      releaseNativePickerLease = null;
      return json(response, 200, { cleared });
    }
  }
  if (request.method === "POST" && requestUrl.pathname === "/release-test/tauri-invokes") {
    const body = await requestJson(request);
    if (body.command !== "get_debug_port" || !isRecord(body.args) || Object.keys(body.args).length !== 0) {
      return json(response, 400, { error: "release_tauri_args_invalid", message: "invalid relay fixture command" });
    }
    releaseRelayIndex += 1;
    const id = `rti-${createHash("sha256").update(`${sourceCommit}:relay:${releaseRelayIndex}`).digest("hex").slice(0, 32)}`;
    const nonce = createHash("sha256").update(`${id}:${sourceCommit}`).digest("hex").slice(0, 32);
    releaseRelayStates.set(id, { nonce, command: "get_debug_port", args: {}, status: "pending" });
    try {
      await simulateReleaseRelayRenderer(id, nonce);
    } catch (error) {
      releaseRelayStates.delete(id);
      return json(response, 500, {
        error: "release_tauri_invoke_emit_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return json(response, 202, { id, status: "pending" });
  }
  const releaseRelayMatch = requestUrl.pathname.match(/^\/release-test\/tauri-invokes\/(rti-[0-9a-f]{32})(?:\/(claim|complete))?$/);
  if (releaseRelayMatch) {
    const id = releaseRelayMatch[1]!;
    const action = releaseRelayMatch[2];
    const state = releaseRelayStates.get(id);
    if (!state) {
      return json(response, 404, {
        error: "release_tauri_invoke_not_found",
        message: "release Tauri invoke is unknown or expired",
      });
    }
    if (request.method === "GET" && !action) {
      return json(response, 200, releaseRelayPoll(id, state));
    }
    if (request.method === "DELETE" && !action) {
      releaseRelayStates.delete(id);
      return json(response, 200, { removed: true });
    }
    if (request.method === "POST" && action === "claim") {
      const body = await requestJson(request);
      if (body.nonce !== state.nonce || state.status !== "pending") {
        return json(response, 404, {
          error: "release_tauri_invoke_not_found",
          message: "release Tauri invoke is unknown or expired",
        });
      }
      state.status = "claimed";
      return json(response, 200, { id, command: state.command, args: state.args });
    }
    if (request.method === "POST" && action === "complete") {
      const body = await requestJson(request);
      if (body.nonce !== state.nonce || state.status !== "claimed" || body.status !== "passed") {
        return json(response, 409, {
          error: "release_tauri_invoke_not_claimed",
          message: "release Tauri invoke is not awaiting completion",
        });
      }
      state.status = "passed";
      state.args = null;
      state.value = body.value;
      return json(response, 200, releaseRelayPoll(id, state));
    }
  }
  if (request.method === "POST" && requestUrl.pathname === "/connect"
    && requestUrl.searchParams.get("tabId")?.startsWith("shellx-release-provider-")) {
    const body = await requestJson(request);
    const tabId = requestUrl.searchParams.get("tabId")!;
    if (body.tabId !== tabId || typeof body.cwd !== "string" || !existsSync(body.cwd)
      || body.permissionMode !== "plan" || !Array.isArray(body.mcpServers)) {
      return json(response, 400, { error: "invalid provider Grok fixture" });
    }
    grokProviderTabs.set(tabId, { cwd: body.cwd });
    return json(response, 200, { ok: true, cwd: body.cwd });
  }
  if (request.method === "POST" && requestUrl.pathname === "/abort"
    && requestUrl.searchParams.get("tabId")?.startsWith("shellx-release-provider-")) {
    await requestJson(request);
    const tabId = requestUrl.searchParams.get("tabId")!;
    grokProviderTabs.delete(tabId);
    return json(response, 200, {
      ok: true,
      tabId,
      registryRemoved: true,
      keepSession: false,
      abortedTabTasks: 0,
    });
  }
  if (request.method === "POST" && path === "/provider-adapters/run") {
    const body = await requestJson(request);
    if (body.providerId !== "claude-code" || body.cwd !== ""
      || typeof body.prompt !== "string" || !body.prompt.includes("SHELLX_RELEASE_PROVIDER_ROUTE_CANARY_035")
      || body.transport !== "local" || body.shellxToolExposure !== "off") {
      return json(response, 400, { ok: false, error: "invalid provider adapter fixture" });
    }
    providerAdapterRunIndex += 1;
    providerLifecycleEvents.push({
      t: 9_000 + providerAdapterRunIndex * 2,
      kind: "provider-adapter-run-started",
      payload: { providerId: "claude-code", cwd: body.cwd, streamKind: "jsonl", transport: "local", wslDistro: null },
    });
    providerLifecycleEvents.push({
      t: 9_001 + providerAdapterRunIndex * 2,
      kind: "provider-adapter-run-failed",
      payload: { providerId: "claude-code", error: "cwd is empty", transport: "local", wslDistro: null },
    });
    return json(response, 400, { ok: false, providerId: "claude-code", error: "cwd is empty" });
  }
  if (request.method === "POST" && path === "/provider-sessions/start") {
    const body = await requestJson(request);
    const releaseFixture = isRecord(body.releaseFixture) ? body.releaseFixture : null;
    if (body.tabId !== "release-provider-action-activity-ask-agent"
      || body.providerId !== "codex-cli" || typeof body.cwd !== "string" || !existsSync(body.cwd)
      || body.transport !== "local" || body.shellxToolExposure !== "off"
      || releaseFixture?.id !== "provider-action-lifecycle"
      || releaseFixture?.action !== "activity-ask-agent") {
      return json(response, 400, { ok: false, error: "invalid provider session fixture" });
    }
    const runId = "provider-session-release-provider-action-activity-ask-agent";
    const promptSha256 = createHash("sha256").update(String(body.prompt)).digest("hex");
    const run = {
      runId,
      tabId: body.tabId,
      providerId: "codex-cli",
      cwd: body.cwd,
      transport: "local",
      transportKey: "local",
      sshRemoteRuntime: "posix",
      phase: "completed",
      promptPreview: "fixture-provider-prompt-private",
      startedAtMs: 10_000,
      updatedAtMs: 10_000,
      stdoutLineCount: 1,
      stderrLineCount: 0,
      persistSession: false,
      permissionMode: "readOnly",
      shellxToolExposure: "off",
    };
    providerLifecycleRuns.set(body.tabId, run);
    providerLifecycleEvents.push({
      t: 10_000,
      kind: "provider-session-event",
      payload: { runId, tabId: body.tabId, providerId: "codex-cli", kind: "started" },
    });
    providerLifecycleEvents.push({
      t: 10_001,
      kind: "provider-session-event",
      payload: {
        runId,
        tabId: body.tabId,
        providerId: "codex-cli",
        kind: "text",
        text: `SHELLX_PROVIDER_ACTION_RECEIPT activity-ask-agent ${promptSha256}`,
      },
    });
    providerLifecycleEvents.push({
      t: 10_002,
      kind: "provider-session-event",
      payload: { runId, tabId: body.tabId, providerId: "codex-cli", kind: "completed" },
    });
    return json(response, 200, { ok: true, run });
  }
  if (request.method === "POST" && requestUrl.pathname === "/provider-sessions/abort"
    && requestUrl.searchParams.get("tabId")?.startsWith("shellx-release-provider-")) {
    const body = await requestJson(request);
    const tabId = requestUrl.searchParams.get("tabId")!;
    const run = providerLifecycleRuns.get(tabId);
    if (!run || run.runId !== body.runId || body.transport !== "local") {
      return json(response, 404, { ok: false, tabId, runId: body.runId ?? null, aborted: false });
    }
    run.phase = "aborted";
    run.updatedAtMs = 10_001;
    providerLifecycleEvents.push({
      t: 10_001,
      kind: "provider-session-event",
      payload: { runId: run.runId, tabId, providerId: "codex-cli", kind: "aborted" },
    });
    return json(response, 200, { ok: true, tabId, runId: run.runId, aborted: true });
  }
  if (path === "/tools/fs_watch" && request.method === "POST") {
    const body = await requestJson(request);
    if (typeof body.path !== "string" || !existsSync(body.path)
      || body.recursive !== false || ![50].includes(Number(body.debounceMs ?? body.debounce_ms))) {
      return json(response, 400, { error: "invalid filesystem-watch fixture" });
    }
    const watching = realpathSync(body.path);
    const existing = fsWatchers.get(watching);
    if (existing) {
      return json(response, 200, {
        ok: true,
        watchId: existing.watchId,
        watching: existing.watching,
        alreadyWatching: true,
        recursive: existing.recursive,
        debounce_ms: existing.debounceMs,
        started_at_ms: existing.startedAtMs,
      });
    }
    fsWatchIndex += 1;
    const watcher = {
      watchId: `fsw-00000000-0000-4000-8000-${String(fsWatchIndex).padStart(12, "0")}`,
      watching,
      recursive: false,
      debounceMs: 50,
      startedAtMs: 7_000 + fsWatchIndex,
    };
    fsWatchers.set(watching, watcher);
    return json(response, 200, {
      ok: true,
      watchId: watcher.watchId,
      watching: watcher.watching,
      alreadyWatching: false,
      recursive: watcher.recursive,
      debounce_ms: watcher.debounceMs,
      started_at_ms: watcher.startedAtMs,
    });
  }
  if (requestUrl.pathname === "/goal/start" && request.method === "POST") {
    const body = await requestJson(request);
    const tabId = typeof body.tabId === "string" ? body.tabId : "default";
    const objective = typeof body.objective === "string" ? body.objective : "";
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    if (!tabId.startsWith("shellx-release-goal-") || !objective.startsWith("Verify ShellX Goal ")
      || !cwd || !existsSync(cwd)) {
      return json(response, 400, { ok: false, error: "invalid Goal fixture" });
    }
    const scratchboardPath = join(cwd, "goal.md");
    writeFileSync(
      scratchboardPath,
      `# Goal: ${objective}\n\nStatus: AWAITING_APPROVAL\n\n_grok is drafting the plan…_\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    goalStates.set(tabId, {
      active: true,
      objective,
      scratchboardPath,
      transportKind: "local",
      lastContinuationAtMs: 0,
      continuationsTotal: 0,
      startedAtMs: Date.now(),
      pausedByUser: false,
      halted: false,
      haltedReason: null,
      lastFingerprint: null,
      noProgressCycles: 0,
      scratchboardReadFailures: 0,
      perTurnTimeoutMs: 1_200_000,
      awaitingApproval: true,
      planTurnCompleted: false,
      approvedAtMs: 0,
    });
    return json(response, 200, { ok: true, tabId, objective, scratchboardPath, cwd });
  }
  if (requestUrl.pathname === "/goal/state" && request.method === "GET") {
    const tabId = requestUrl.searchParams.get("tabId") ?? "default";
    const state = goalStates.get(tabId) ?? null;
    return json(response, 200, {
      tabId,
      state,
      approvalStatus: state
        ? { ready: false, reason: "plan turn is still running" }
        : null,
      lastClear: goalLastClears.get(tabId) ?? null,
    });
  }
  if (["/goal/stop", "/goal/pause", "/goal/resume", "/goal/reject", "/goal/complete"].includes(requestUrl.pathname)
    && request.method === "POST") {
    const body = await requestJson(request);
    const tabId = typeof body.tabId === "string" ? body.tabId : "default";
    const state = goalStates.get(tabId);
    if (requestUrl.pathname === "/goal/pause" || requestUrl.pathname === "/goal/resume") {
      if (state) state.pausedByUser = requestUrl.pathname === "/goal/pause";
      return json(response, 200, {
        ok: true,
        tabId,
        paused: requestUrl.pathname === "/goal/pause",
      });
    }
    if (requestUrl.pathname === "/goal/complete") {
      if (state) {
        state.active = false;
        const scratchboardPath = String(state.scratchboardPath);
        const text = readFileSync(scratchboardPath, "utf8");
        writeFileSync(scratchboardPath, text.replace("Status: AWAITING_APPROVAL", "status: GOAL_COMPLETE"), "utf8");
        goalLastClears.set(tabId, {
          reason: "completed",
          objective: state.objective,
          clearedAtMs: Date.now(),
        });
      }
      return json(response, 200, {
        ok: true,
        tabId,
        active: false,
        wasActive: Boolean(state?.active === false),
        scratchboardPatched: Boolean(state),
        scratchboardError: null,
      });
    }
    const reason = requestUrl.pathname === "/goal/reject" ? "rejected" : "off";
    if (state) {
      goalStates.delete(tabId);
      goalLastClears.set(tabId, {
        reason,
        objective: state.objective,
        clearedAtMs: Date.now(),
      });
    }
    return json(response, 200, requestUrl.pathname === "/goal/reject"
      ? { ok: true, tabId, rejected: Boolean(state) }
      : { ok: true, tabId, active: false });
  }
  const fsUnwatchMatch = /^\/tools\/fs_watch\/(fsw-[0-9a-f-]{36})$/.exec(requestUrl.pathname);
  if (fsUnwatchMatch && request.method === "DELETE") {
    const watchId = fsUnwatchMatch[1]!;
    const entry = [...fsWatchers.entries()].find(([, watcher]) => watcher.watchId === watchId);
    if (!entry) {
      return json(response, 404, {
        ok: false,
        watchId,
        stopped: false,
        message: "filesystem watch not found",
      });
    }
    fsWatchers.delete(entry[0]);
    return json(response, 200, {
      ok: true,
      watchId,
      stopped: true,
      taskOutcome: "cancelled",
    });
  }
  if (path === "/browser/task/start" && request.method === "POST") {
    const body = await requestJson(request);
    browserTaskIndex += 1;
    const taskId = browserTaskIndex === 1 ? settleTaskId : `${settleTaskId}-${browserTaskIndex}`;
    const browserTabId = browserTaskIndex === 1 ? settleTabId : `${settleTabId}-${browserTaskIndex}`;
    browserTasks.set(taskId, "running");
    const callerSessionId = typeof request.headers["x-shellx-mcp-caller-id"] === "string"
      ? request.headers["x-shellx-mcp-caller-id"]!.trim() || null
      : null;
    browserTaskCallerSessions.set(taskId, callerSessionId);
    browserTabs.set(browserTabId, taskId);
    browserTaskUrls.set(taskId, typeof body.startUrl === "string" ? body.startUrl : "");
    activeBrowserTabId = browserTabId;
    return json(response, 200, {
      taskId,
      browserTabId,
      profileId: "task-disposable",
      status: "running",
      ownerSessionId: callerSessionId,
    });
  }
  if (path === "/browser/action" && request.method === "POST") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    if (browserTasks.get(taskId) !== "running" || browserTabs.get(browserTabId) !== taskId
      || body.action !== "verify" || body.key !== "text"
      || body.value !== "Owned Browser settle fixture ready") {
      return json(response, 400, { ok: false, error: "invalid Browser action fixture" });
    }
    browserMonotonicIndex += 1;
    return json(response, 200, {
      ok: true,
      status: "verified",
      taskId,
      currentUrl: browserTaskUrls.get(taskId),
      requiredApproval: null,
      requiresEngine: false,
      message: "Verification passed",
      verification: {
        passed: true,
        key: "text",
        expected: body.value,
        actual: "Owned Browser settle fixture ready",
      },
      receipt: monotonicReceipt("browserVerificationPassed", taskId, { browserTabId, key: "text" }),
    });
  }
  if (path === "/browser/flight-recorder/export" && request.method === "POST") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    const suiteId = typeof body.suiteId === "string" ? body.suiteId : "";
    const group = body.group === "baseline" || body.group === "candidate" ? body.group : "";
    const attemptIndex = Number(body.attemptIndex);
    if (!browserTasks.has(taskId) || browserTabs.get(browserTabId) !== taskId || !suiteId || !group
      || !Number.isSafeInteger(attemptIndex) || attemptIndex < 0) {
      return json(response, 400, { ok: false, error: "invalid Flight Recorder fixture" });
    }
    browserArtifactIndex += 1;
    const attemptId = `release-flight-attempt-${browserArtifactIndex}`;
    const createdAtMs = Date.now();
    const artifact = writeBrowserArtifact("shellx-browser-flight-recorder", attemptId, createdAtMs, {
      schemaVersion: "sx.flightRecorder.v1",
      attemptId,
      manifest: { taskId, browserTabId, suiteId, group, attemptIndex },
      summary: { counts: { evidenceComplete: true } },
      events: [],
      receipts: [],
    });
    return json(response, 200, {
      attemptId,
      taskId,
      browserTabId,
      path: artifact.path,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      events: 0,
      receipts: 0,
      droppedEvents: 0,
      droppedReceipts: 0,
      retentionDroppedEvents: 0,
      retentionDroppedReceipts: 0,
      sanitizerLossCount: 0,
      gapCount: 0,
      evidenceComplete: true,
      firstSourceSequence: 1,
      lastSourceSequence: 1,
      source: "shellx-browser-flight-recorder",
      createdAtMs,
      receipt: browserArtifactReceipt("browserFlightRecorderExported", taskId, {
        attemptId, path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256,
      }),
    });
  }
  if (path === "/browser/evaluations" && request.method === "POST") {
    const body = await requestJson(request);
    const suiteId = typeof body.suiteId === "string" ? body.suiteId : "";
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const evaluatedAtMs = Number(body.evaluatedAtMs);
    const attempts = Array.isArray(body.attempts) ? body.attempts : [];
    if (!suiteId || !browserTasks.has(taskId) || !Number.isSafeInteger(evaluatedAtMs) || evaluatedAtMs <= 0
      || attempts.length !== 2) {
      return json(response, 400, { ok: false, error: "invalid Browser evaluation fixture" });
    }
    const groups = attempts.map((attempt) => (
      attempt && typeof attempt === "object" && !Array.isArray(attempt)
        ? String((attempt as Record<string, unknown>).group ?? "")
        : ""
    ));
    if (!groups.includes("baseline") || !groups.includes("candidate")) {
      return json(response, 400, { ok: false, error: "Browser evaluation fixture requires both groups" });
    }
    const attemptTaskIds = attempts.map((attempt) => (
      attempt && typeof attempt === "object" && !Array.isArray(attempt)
        ? String((attempt as Record<string, unknown>).taskId ?? "")
        : ""
    ));
    if (attemptTaskIds.some((attemptTaskId) => !browserTasks.has(attemptTaskId))
      || new Set(attemptTaskIds).size !== attempts.length
      || !attemptTaskIds.includes(taskId)) {
      return json(response, 400, { ok: false, error: "Browser evaluation fixture requires distinct owned tasks" });
    }
    browserArtifactIndex += 1;
    const reportId = `release-browser-eval-${browserArtifactIndex}`;
    const evidenceDigest = createHash("sha256").update(JSON.stringify({ suiteId, taskId, attempts })).digest("hex");
    const artifact = writeBrowserArtifact("shellx-browser-evaluations", reportId, evaluatedAtMs, {
      schemaVersion: "sx.evaluation.v1",
      reportId,
      evidenceDigest,
      manifest: { suiteId, taskId, source: "shellx-browser-evaluations" },
      attempts,
    });
    return json(response, 200, {
      reportId,
      suiteId,
      taskId,
      path: artifact.path,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      evidenceDigest,
      attempts: 2,
      baselineAttempts: 1,
      candidateAttempts: 1,
      safetyViolationDelta: 0,
      improvementScore: 10,
      improvementRating: "improved",
      evidenceComplete: true,
      source: "shellx-browser-evaluations",
      evaluatedAtMs,
      receipt: browserArtifactReceipt("browserEvaluationReportWritten", taskId, {
        reportId, suiteId, path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256,
      }),
    });
  }
  if ([
    "/browser/har/export",
    "/browser/performance/export",
    "/browser/recipes/export",
    "/browser/storage-state/export",
    "/browser/trace/export",
  ].includes(path) && request.method === "POST") {
    const body = await requestJson(request);
    const storageState = path === "/browser/storage-state/export";
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    if (storageState ? body.profileId !== "task-disposable"
      : !browserTasks.has(taskId) || browserTabs.get(browserTabId) !== taskId) {
      return json(response, 400, { ok: false, error: "invalid adjacent Browser artifact fixture" });
    }
    browserArtifactIndex += 1;
    const createdAtMs = Date.now();
    if (path === "/browser/har/export") {
      const harId = `release-browser-har-${browserArtifactIndex}`;
      const artifact = writeBrowserArtifact("shellx-browser-har", harId, createdAtMs, {
        log: { version: "1.2", entries: [] },
        shellx: { harId, taskId, browserTabId, redactionPolicy: { cookies: false, requestBodies: false } },
      });
      return json(response, 200, {
        harId, taskId, browserTabId, path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256,
        entries: 0, source: "shellx-browser-har", createdAtMs,
        receipt: browserArtifactReceipt("browserHarExported", taskId, { harId, browserTabId }),
      });
    }
    if (path === "/browser/performance/export") {
      const performanceId = `release-browser-performance-${browserArtifactIndex}`;
      const metrics = {
        engineMounted: true,
        captureStatus: "captured",
        currentUrl: browserTaskUrls.get(taskId),
        title: "ShellX release settle",
        timeOrigin: 1,
        navigation: [{ name: browserTaskUrls.get(taskId), type: "navigate", duration: 2 }],
        paint: [],
        resources: [],
        counters: { navigation: 1, resources: 0, paints: 0 },
        redactionPolicy: {
          resourceUrlsSanitized: true,
          queryAndFragmentRetained: false,
          headers: false,
          bodies: false,
          cookies: false,
        },
      };
      const redactionPolicy = {
        resourceUrlsSanitized: true,
        queryAndFragmentRetained: false,
        headers: false,
        bodies: false,
        cookies: false,
      };
      const artifact = writeBrowserArtifact("shellx-browser-performance", performanceId, createdAtMs, {
        performanceId,
        taskId,
        browserTabId,
        createdAtMs,
        reason: body.reason,
        metrics,
        redactionPolicy,
      });
      return json(response, 200, {
        performanceId,
        taskId,
        browserTabId,
        path: artifact.path,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        metrics,
        source: "shellx-browser-performance",
        createdAtMs,
        receipt: browserArtifactReceipt("browserPerformanceExported", taskId, {
          performanceId,
          browserTabId,
          path: artifact.path,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          source: "shellx-browser-performance",
          redactionPolicy,
        }),
      });
    }
    if (path === "/browser/recipes/export") {
      const recipeId = `release-browser-recipe-${browserArtifactIndex}`;
      const artifact = writeBrowserArtifact("shellx-browser-recipes", recipeId, createdAtMs, {
        schemaVersion: 2,
        recipeId,
        createdAtMs,
        taskId,
        browserTabId,
        source: "shellx-browser-recorder",
        steps: [{
          stepId: `release-browser-recipe-step-${browserArtifactIndex}`,
          sourceReceiptId: `release-browser-verification-${browserArtifactIndex}`,
          sourceKind: "browserVerificationPassed",
          recordedAtMs: createdAtMs,
          action: "verify",
          browserTabId,
          expectationType: "text",
          passed: true,
          checkedTextRedacted: true,
        }],
        redactionPolicy: { rawInputValues: false, rawSecrets: false },
      });
      browserRecipeArtifacts.add(artifact.path);
      return json(response, 200, {
        recipeId, taskId, browserTabId, path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256,
        steps: 1, source: "shellx-browser-recipes", createdAtMs,
        receipt: browserArtifactReceipt("browserRecipeExported", taskId, { recipeId, browserTabId }),
      });
    }
    if (path === "/browser/storage-state/export") {
      const exportId = `release-browser-storage-${browserArtifactIndex}`;
      const safeProfile = {
        profileId: "task-disposable",
        storageRoot: null,
        cookiesEnabled: false,
        localStorageEnabled: false,
        persistent: false,
        retentionPolicy: "taskScopedEphemeral",
        sessionGrantStatus: "none",
        cookieValuesExposed: false,
        localStorageValuesExposed: false,
      };
      const artifact = writeBrowserArtifact("shellx-browser-storage-state", exportId, createdAtMs, {
        exportId,
        createdAtMs,
        profiles: [safeProfile],
        redactionPolicy: {
          safeManifestOnly: true,
          cookieValues: false,
          localStorageValues: false,
          sessionStorageValues: false,
        },
      });
      return json(response, 200, {
        exportId, path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256, createdAtMs,
        profiles: [{ ...safeProfile, artifactHash: artifact.sha256 }],
        receipt: browserArtifactReceipt("browserStorageStateManifestExported", "", {
          exportId, profileId: "task-disposable",
        }, "task-disposable"),
      });
    }
    const traceId = `release-browser-trace-${browserArtifactIndex}`;
    const artifact = writeBrowserArtifact("shellx-browser-traces", traceId, createdAtMs, {
      traceId,
      createdAtMs,
      task: { taskId, profileId: "task-disposable" },
      tab: { browserTabId, taskId },
      redactionPolicy: { rawSecrets: false, cookies: false, rawDom: false },
    });
    return json(response, 200, {
      traceId, taskId, browserTabId, path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256,
      source: "shellx-browser-trace-bundle", createdAtMs,
      receipt: browserArtifactReceipt("browserTraceBundleExported", taskId, { traceId, browserTabId }),
    });
  }
  if (path === "/browser/recipes/replay" && request.method === "POST") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    const recipePath = typeof body.recipePath === "string" ? body.recipePath : "";
    if (!browserTasks.has(taskId) || browserTabs.get(browserTabId) !== taskId
      || !browserRecipeArtifacts.has(recipePath) || body.dryRun !== true) {
      return json(response, 400, { ok: false, error: "invalid Browser recipe replay fixture" });
    }
    browserArtifactIndex += 1;
    return json(response, 200, {
      ok: true,
      status: "dryRunCompleted",
      taskId,
      browserTabId,
      stepsPlanned: 1,
      stepsApplied: 0,
      stepsSkipped: 0,
      skippedSteps: [],
      stepResults: [{
        index: 0,
        action: "verify",
        ok: true,
        status: "planned",
      }],
      decisionPoints: [],
      dryRun: true,
      receipt: browserArtifactReceipt("browserRecipeReplayCompleted", taskId, {
        browserTabId,
        recipePath,
        dryRun: true,
        stepsPlanned: 1,
        stepsApplied: 0,
        stepsSkipped: 0,
      }),
    });
  }
  if (path === "/browser/robots/schedule" && request.method === "POST") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    const recipePath = typeof body.recipePath === "string" ? body.recipePath : "";
    if (!browserTasks.has(taskId) || browserTabs.get(browserTabId) !== taskId
      || !browserRecipeArtifacts.has(recipePath) || body.kind !== "recipeReplay"
      || typeof body.reason !== "string" || !body.reason.startsWith("Final release owned Browser robot ")
      || !Number.isSafeInteger(body.runAtMs)) {
      return json(response, 400, { ok: false, error: "invalid Browser robot schedule fixture" });
    }
    browserMonotonicIndex += 1;
    const jobId = `release-browser-robot-${browserMonotonicIndex}`;
    const createdAtMs = Date.now();
    const receipt = monotonicReceipt("browserRobotScheduled", taskId, {
      jobId,
      kind: "recipeReplay",
      browserTabId,
      recipePath,
      runAtMs: body.runAtMs,
      reason: body.reason,
    });
    const job = {
      jobId,
      status: "scheduled",
      kind: "recipeReplay",
      taskId,
      browserTabId,
      recipePath,
      reason: body.reason,
      runAtMs: body.runAtMs,
      createdAtMs,
      updatedAtMs: createdAtMs,
      attempts: 0,
      lastError: null,
      receipt,
    };
    browserRobots.push(job);
    browserMonotonicReceipts.push(receipt);
    return json(response, 200, job);
  }
  if (path === "/browser/robots/run" && request.method === "POST") {
    const body = await requestJson(request);
    const job = browserRobots.find((candidate) => candidate.jobId === body.jobId);
    if (!job || job.status !== "scheduled" || body.dryRun !== true) {
      return json(response, 400, { ok: false, error: "invalid Browser robot run fixture" });
    }
    browserMonotonicIndex += 1;
    job.status = "dryRunCompleted";
    job.updatedAtMs = Date.now();
    job.attempts = 1;
    const receipt = monotonicReceipt("browserRobotRunCompleted", String(job.taskId), {
      jobId: job.jobId,
      kind: job.kind,
      browserTabId: job.browserTabId,
      recipePath: job.recipePath,
      status: job.status,
      dryRun: true,
      attempts: 1,
      stepsPlanned: 1,
      stepsApplied: 0,
      stepsSkipped: 0,
      replayStatus: "dryRunCompleted",
      lastError: null,
    });
    job.receipt = receipt;
    browserMonotonicReceipts.push(receipt);
    return json(response, 200, job);
  }
  if (path === "/browser/robots/cancel" && request.method === "POST") {
    const body = await requestJson(request);
    const job = browserRobots.find((candidate) => candidate.jobId === body.jobId);
    if (!job || job.status !== "scheduled" || typeof body.reason !== "string" || !body.reason) {
      return json(response, 400, { ok: false, error: "invalid Browser robot cancel fixture" });
    }
    browserMonotonicIndex += 1;
    job.status = "cancelled";
    job.updatedAtMs = Date.now();
    const receipt = monotonicReceipt("browserRobotCancelled", String(job.taskId), {
      jobId: job.jobId,
      kind: job.kind,
      browserTabId: job.browserTabId,
      recipePath: job.recipePath,
      reason: body.reason,
    });
    job.receipt = receipt;
    browserMonotonicReceipts.push(receipt);
    return json(response, 200, job);
  }
  if (path === "/browser/dialogs" && request.method === "POST") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    if (!browserTasks.has(taskId) || browserTabs.get(browserTabId) !== taskId
      || body.dialogType !== "confirm" || typeof body.text !== "string" || !body.text
      || typeof body.url !== "string" || body.requiresApproval !== true) {
      return json(response, 400, { ok: false, error: "invalid Browser dialog fixture" });
    }
    browserMonotonicIndex += 1;
    const dialogId = `browser-dialog-release-${browserMonotonicIndex}`;
    const createdAtMs = Date.now();
    const safeUrl = `${new URL(body.url).origin}${new URL(body.url).pathname}`;
    const receipt = monotonicReceipt("browserDialogRecorded", taskId, {
      dialogId,
      browserTabId,
      dialogType: "confirm",
      textBytes: Buffer.byteLength(body.text),
      url: safeUrl,
      status: "pending",
      requiresApproval: true,
    });
    const event = {
      dialogId,
      taskId,
      browserTabId,
      profileId: "task-disposable",
      dialogType: "confirm",
      text: body.text,
      url: safeUrl,
      status: "pending",
      requiresApproval: true,
      promptValueProvided: false,
      createdAtMs,
      resolvedAtMs: null,
      receipt,
    };
    browserDialogs.push(event);
    browserMonotonicReceipts.push(receipt);
    return json(response, 200, event);
  }
  if (path === "/browser/permissions" && request.method === "POST") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    if (!browserTasks.has(taskId) || browserTabs.get(browserTabId) !== taskId
      || body.permissionKind !== "geolocation" || typeof body.url !== "string"
      || body.userInitiated !== true || body.requiresApproval !== true) {
      return json(response, 400, { ok: false, error: "invalid Browser permission fixture" });
    }
    browserMonotonicIndex += 1;
    const permissionId = `browser-permission-release-${browserMonotonicIndex}`;
    const createdAtMs = Date.now();
    const target = new URL(body.url);
    const receipt = monotonicReceipt("browserPermissionRequested", taskId, {
      permissionId,
      browserTabId,
      permissionKind: "geolocation",
      origin: target.origin,
      path: target.pathname,
      queryRetained: false,
      fragmentRetained: false,
      userInitiated: true,
      status: "pending",
      requiresApproval: true,
    });
    const event = {
      permissionId,
      taskId,
      browserTabId,
      profileId: "task-disposable",
      permissionKind: "geolocation",
      origin: target.origin,
      path: target.pathname,
      queryRetained: false,
      fragmentRetained: false,
      userInitiated: true,
      status: "pending",
      requiresApproval: true,
      createdAtMs,
      resolvedAtMs: null,
      receipt,
    };
    browserPermissions.push(event);
    browserMonotonicReceipts.push(receipt);
    return json(response, 200, event);
  }
  if (path === "/browser/popups" && request.method === "POST") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    if (!browserTasks.has(taskId) || browserTabs.get(browserTabId) !== taskId
      || typeof body.openerUrl !== "string" || typeof body.targetUrl !== "string"
      || body.disposition !== "new-tab" || body.requiresApproval !== true) {
      return json(response, 400, { ok: false, error: "invalid Browser popup fixture" });
    }
    browserMonotonicIndex += 1;
    const popupId = `browser-popup-release-${browserMonotonicIndex}`;
    const target = new URL(body.targetUrl);
    const safeTarget = `${target.origin}${target.pathname}`;
    const opener = new URL(body.openerUrl);
    const safeOpener = `${opener.origin}${opener.pathname}`;
    const receipt = monotonicReceipt("browserPopupRecorded", taskId, {
      popupId,
      browserTabId,
      targetUrl: safeTarget,
      queryRetained: false,
      fragmentRetained: false,
      disposition: "new-tab",
      status: "pendingApproval",
      requiresApproval: true,
    });
    const event = {
      popupId,
      taskId,
      browserTabId,
      profileId: "task-disposable",
      openerUrl: safeOpener,
      targetUrl: safeTarget,
      origin: target.origin,
      path: target.pathname,
      queryRetained: false,
      fragmentRetained: false,
      disposition: "new-tab",
      status: "pendingApproval",
      requiresApproval: true,
      createdAtMs: Date.now(),
      receipt,
    };
    browserPopups.push(event);
    browserMonotonicReceipts.push(receipt);
    return json(response, 200, event);
  }
  if (path === "/browser/session-grants/request" && request.method === "POST") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    if (!browserTasks.has(taskId) || body.fromProfileId !== "personal"
      || body.toProfileId !== "task-disposable" || typeof body.reason !== "string" || !body.reason
      || body.ttlSeconds !== 300) {
      return json(response, 400, { ok: false, error: "invalid Browser session grant fixture" });
    }
    browserMonotonicIndex += 1;
    const grantId = `browser-grant-release-${browserMonotonicIndex}`;
    const grant = {
      grantId,
      taskId,
      fromProfileId: "personal",
      toProfileId: "task-disposable",
      reason: body.reason,
      status: "requested",
      ttlSeconds: 300,
      createdAtMs: Date.now(),
      resolvedAtMs: null,
      appliedAtMs: null,
    };
    const receipt = monotonicReceipt("browserSessionGrantRequested", taskId, {
      grantId,
      ttlSeconds: 300,
    });
    browserSessionGrants.push(grant);
    browserMonotonicReceipts.push(receipt);
    return json(response, 200, grant);
  }
  if (path === "/browser/session-grants/apply" && request.method === "POST") {
    const body = await requestJson(request);
    const grant = browserSessionGrants.find((candidate) => candidate.grantId === body.grantId);
    if (!grant || grant.taskId !== body.taskId) {
      return json(response, 400, { ok: false, error: "unknown Browser session grant fixture" });
    }
    if (grant.status !== "granted") {
      return json(response, 400, {
        ok: false,
        error: `browser session grant '${grant.grantId}' is not granted`,
      });
    }
    return json(response, 500, { ok: false, error: "release fixture must not apply a granted Browser session" });
  }
  if (path === "/browser/cdp/execute" && request.method === "POST") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    if (browserTasks.get(taskId) !== "running" || browserTabs.get(browserTabId) !== taskId
      || body.method !== "Runtime.evaluate" || body.expression !== "document.title") {
      return json(response, 400, { ok: false, error: "invalid Browser CDP denial fixture" });
    }
    const receipt = monotonicReceipt("browserCdpAccessRequested", taskId, {
      action: "cdpCommand",
      requiredApproval: "browserDeveloperModeApproval",
      reason: "developerModeDisabled",
      currentUrl: browserTaskUrls.get(taskId),
    });
    browserMonotonicReceipts.push(receipt);
    return json(response, 200, {
      ok: false,
      status: "blocked",
      method: "Runtime.evaluate",
      taskId,
      browserTabId,
      currentUrl: browserTaskUrls.get(taskId),
      requiredApproval: "browserDeveloperModeApproval",
      result: { blocked: true },
      resultRedacted: false,
      durationMs: 0,
      receipt,
    });
  }
  if (path === "/browser/task/finish" && request.method === "POST") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    if (!browserTasks.has(taskId)) return json(response, 400, { ok: false, error: "unknown Browser task fixture" });
    const status = typeof body.status === "string" ? body.status : "completed";
    browserTasks.set(taskId, status);
    const resolvedAtMs = Date.now();
    const cancel = (rows: Array<Record<string, unknown>>, pendingStatus: string): number => {
      let count = 0;
      for (const row of rows) {
        if (row.taskId === taskId && row.status === pendingStatus) {
          row.status = "cancelled";
          row.resolvedAtMs = resolvedAtMs;
          count += 1;
        }
      }
      return count;
    };
    const cancelledGrants = cancel(browserSessionGrants, "requested");
    const cancelledDialogs = cancel(browserDialogs, "pending");
    const cancelledPermissions = cancel(browserPermissions, "pending");
    browserMonotonicIndex += 1;
    browserMonotonicReceipts.push(monotonicReceipt("browserWorkflowCompleted", taskId, {
      status,
      reason: body.reason,
      requestedBy: "agent",
      cancelledGrants,
      cancelledDialogs,
      cancelledPermissions,
    }));
    for (const [kind, countKey, count] of [
      ["browserSessionGrantCancelled", "cancelledGrants", cancelledGrants],
      ["browserDialogCancelled", "cancelledDialogs", cancelledDialogs],
      ["browserPermissionCancelled", "cancelledPermissions", cancelledPermissions],
    ] as const) {
      if (count === 0) continue;
      browserMonotonicIndex += 1;
      browserMonotonicReceipts.push(monotonicReceipt(kind, taskId, {
        status,
        reason: body.reason,
        [countKey]: count,
      }));
    }
    return json(response, 200, { taskId, status });
  }
  if (path === "/browser/task/control" && request.method === "POST") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    if (body.action !== "pause" || browserTasks.get(taskId) !== "running") {
      return json(response, 400, { ok: false, error: "invalid Browser task control fixture" });
    }
    browserTasks.set(taskId, "paused");
    return json(response, 200, {
      ok: true,
      status: "paused",
      action: "pause",
      task: { taskId, status: "paused" },
      receipt: { receiptId: "fixture-task-control", kind: "browserTaskPaused" },
    });
  }
  if (path === "/browser/tabs/close" && request.method === "POST") {
    const body = await requestJson(request);
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    const taskId = browserTabs.get(browserTabId);
    if (!taskId || !browserTabs.delete(browserTabId)) return json(response, 400, { ok: false, error: "unknown Browser tab fixture" });
    if (![...browserTabs.values()].some((candidate) => candidate === taskId)
      && !["completed", "aborted"].includes(browserTasks.get(taskId) ?? "")) {
      browserTasks.set(taskId, "aborted");
    }
    browserTabLocks.delete(browserTabId);
    if (activeBrowserTabId === browserTabId) activeBrowserTabId = [...browserTabs.keys()].at(-1) ?? null;
    return json(response, 200, { ok: true, tab: { browserTabId, taskId, status: "closed" } });
  }
  if (path === "/browser/tabs/open" && request.method === "POST") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    if (!browserTasks.has(taskId) || body.profileId !== "task-disposable") {
      return json(response, 400, { ok: false, error: "invalid Browser tab open fixture" });
    }
    browserTabIndex += 1;
    const browserTabId = `release-browser-extra-tab-${browserTabIndex}`;
    browserTabs.set(browserTabId, taskId);
    activeBrowserTabId = browserTabId;
    return json(response, 200, tabMutationResponse("browserTabOpened", taskId, browserTabId, null, body.url));
  }
  if (path === "/browser/tabs/focus" && request.method === "POST") {
    const body = await requestJson(request);
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    const taskId = browserTabs.get(browserTabId);
    if (!taskId) return json(response, 400, { ok: false, error: "invalid Browser tab focus fixture" });
    activeBrowserTabId = browserTabId;
    return json(response, 200, tabMutationResponse("browserTabFocused", taskId, browserTabId, browserTabLocks.get(browserTabId) ?? null));
  }
  if (path === "/browser/tabs/reorder" && request.method === "POST") {
    const body = await requestJson(request);
    const ids = Array.isArray(body.browserTabIds) ? body.browserTabIds.map(String) : [];
    if (ids.length < 1 || new Set(ids).size !== ids.length || ids.some((id) => !browserTabs.has(id))) {
      return json(response, 400, { ok: false, error: "invalid Browser tab reorder fixture" });
    }
    const reordered = [
      ...ids.map((id) => [id, browserTabs.get(id)!] as const),
      ...[...browserTabs].filter(([id]) => !ids.includes(id)),
    ];
    browserTabs.clear();
    for (const [id, taskId] of reordered) browserTabs.set(id, taskId);
    browserMonotonicIndex += 1;
    return json(response, 200, {
      ok: true,
      tabs: [...browserTabs].map(([id, taskId]) => browserTabState(taskId, id, browserTabLocks.get(id) ?? null)),
      receipt: monotonicReceipt("browserTabsReordered", browserTabs.get(ids[0]!)!, { browserTabIds: ids }),
    });
  }
  if (path === "/browser/tabs/lock" && request.method === "POST") {
    const body = await requestJson(request);
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    const taskId = browserTabs.get(browserTabId);
    if (!taskId || browserTabLocks.has(browserTabId) || typeof body.ownerAgentId !== "string"
      || typeof body.ownerRunId !== "string") {
      return json(response, 400, { ok: false, error: "invalid Browser tab lock fixture" });
    }
    const now = Date.now();
    const ttlSeconds = Math.min(3600, Math.max(10, Number(body.ttlSeconds) || 120));
    const lock = {
      leaseId: `release-browser-tab-lease-${browserTabId}`,
      ownerAgentId: body.ownerAgentId,
      ownerRunId: body.ownerRunId,
      scope: body.scope || "exclusive",
      acquiredAtMs: now,
      heartbeatAtMs: now,
      expiresAtMs: now + ttlSeconds * 1000,
    };
    browserTabLocks.set(browserTabId, lock);
    return json(response, 200, tabMutationResponse("browserTabLocked", taskId, browserTabId, lock));
  }
  if (path === "/browser/tabs/heartbeat" && request.method === "POST") {
    const body = await requestJson(request);
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    const taskId = browserTabs.get(browserTabId);
    const prior = browserTabLocks.get(browserTabId);
    if (!taskId || !prior || body.leaseId !== prior.leaseId
      || body.ownerAgentId !== prior.ownerAgentId || body.ownerRunId !== prior.ownerRunId) {
      return json(response, 400, { ok: false, error: "invalid Browser tab heartbeat fixture" });
    }
    const now = Date.now();
    const ttlSeconds = Math.min(3600, Math.max(10, Number(body.ttlSeconds) || 120));
    const lock = { ...prior, heartbeatAtMs: now, expiresAtMs: now + ttlSeconds * 1000 };
    browserTabLocks.set(browserTabId, lock);
    return json(response, 200, tabMutationResponse("browserTabHeartbeat", taskId, browserTabId, lock));
  }
  if (path === "/browser/tabs/unlock" && request.method === "POST") {
    const body = await requestJson(request);
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    const taskId = browserTabs.get(browserTabId);
    const prior = browserTabLocks.get(browserTabId);
    if (!taskId || !prior || body.force === true || body.leaseId !== prior.leaseId
      || body.ownerAgentId !== prior.ownerAgentId || body.ownerRunId !== prior.ownerRunId) {
      return json(response, 400, { ok: false, error: "invalid Browser tab unlock fixture" });
    }
    browserTabLocks.delete(browserTabId);
    return json(response, 200, tabMutationResponse("browserTabUnlocked", taskId, browserTabId, null));
  }
  if (path === "/browser/bookmarks" && request.method === "POST") {
    const body = await requestJson(request);
    const bookmarkId = typeof body.bookmarkId === "string" ? body.bookmarkId : "";
    const label = typeof body.label === "string" ? body.label : "";
    const url = typeof body.url === "string" ? body.url : "";
    const kind = body.kind === "folder" ? "folder" : body.kind === "link" ? "link" : "";
    if (!bookmarkId || !label || !kind || (kind === "link" && !url)
      || bookmarks.some((bookmark) => bookmark.bookmarkId === bookmarkId)) {
      return json(response, 400, { ok: false, error: "invalid bookmark fixture" });
    }
    const bookmark = {
      bookmarkId,
      label,
      url: kind === "link" ? url : null,
      category: body.category,
      kind,
      parentId: null,
      toolbarPinned: body.toolbarPinned,
      toolbarOrder: null,
      agentWorkflow: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    bookmarks.push(bookmark);
    return json(response, 200, {
      ok: true,
      bookmark,
      receipt: bookmarkReceipt(kind === "folder" ? "browserBookmarkFolderSaved" : "browserBookmarkSaved"),
    });
  }
  if (path === "/browser/bookmarks/reorder" && request.method === "POST") {
    const body = await requestJson(request);
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length !== 1 || !items[0] || typeof items[0] !== "object" || Array.isArray(items[0])) {
      return json(response, 400, { ok: false, error: "invalid bookmark reorder fixture" });
    }
    const item = items[0] as Record<string, unknown>;
    const link = bookmarks.find((bookmark) => bookmark.bookmarkId === item.bookmarkId);
    const folder = bookmarks.find((bookmark) => bookmark.bookmarkId === item.parentId);
    if (!link || link.kind !== "link" || !folder || folder.kind !== "folder" || item.toolbarPinned !== false) {
      return json(response, 400, { ok: false, error: "unknown bookmark reorder fixture" });
    }
    link.parentId = folder.bookmarkId;
    link.toolbarPinned = false;
    return json(response, 200, {
      ok: true,
      bookmarkToolbar: ["fixture-bookmark-private"],
      receipt: bookmarkReceipt("browserBookmarkToolbarChanged"),
    });
  }
  const bookmarkDelete = /^\/browser\/bookmarks\/([^/?]+)$/.exec(path);
  if (bookmarkDelete && request.method === "DELETE") {
    request.resume();
    const bookmarkId = decodeURIComponent(bookmarkDelete[1]!);
    const index = bookmarks.findIndex((bookmark) => bookmark.bookmarkId === bookmarkId);
    if (index < 0) return json(response, 400, { ok: false, error: "unknown bookmark fixture" });
    bookmarks.splice(index, 1);
    return json(response, 200, {
      ok: true,
      receipt: bookmarkReceipt("browserBookmarkDeleted"),
    });
  }
  if (path === "/diagnostics" && request.method === "POST") {
    const body = await requestJson(request);
    if (JSON.stringify(body.only) !== JSON.stringify(["auth"])) {
      return json(response, 400, { error: "fixture diagnostics must select only auth" });
    }
    return json(response, 200, {
      summary: { pass: 1, fail: 0, elapsedMs: 0, version: "1.0" },
      checks: [{ name: "auth", status: "pass", detail: "shellxagent token ok" }],
    });
  }
  if (path === "/github/pr/create" && request.method === "POST") {
    const body = await requestJson(request);
    if (body.confirmRemoteCreate !== false) {
      return json(response, 500, { error: "fixture refused an approved remote mutation" });
    }
    return json(response, 428, {
      error: "approval_required",
      hint: "Creating a GitHub PR mutates remote state. Re-submit with confirmRemoteCreate:true after explicit per-operation approval.",
    });
  }
  if (path === "/vault/e2e/reset" && request.method === "POST") {
    await requestJson(request);
    vaultE2eSecrets.clear();
    vaultE2eGrants.clear();
    vaultE2eAudit = [];
    vaultAgentRequests.splice(0);
    vaultAgentResources.splice(0);
    pendingVaultConfirmationId = null;
    vaultSetupStatus = vaultBaselineStatus();
    const receipt = vaultE2eReceipt("vaultE2eReset");
    return json(response, 200, { ok: true, receipt });
  }
  if (path === "/vault/setup/begin" && request.method === "POST") {
    const body = await requestJson(request);
    if (body.target !== "local" || body.rememberDevice !== false
      || typeof body.passphrase !== "string" || !body.passphrase.startsWith("ShellX-Release-Vault-")) {
      return json(response, 400, { error: { code: "bad_request", message: "invalid Vault setup fixture" } });
    }
    vaultSetupIndex += 1;
    pendingVaultConfirmationId = vaultSetupIndex.toString(16).padStart(32, "0");
    vaultSetupStatus = {
      ...vaultSetupStatus,
      mode: "unconfigured",
      unlocked: false,
      recoveryConfirmed: false,
    };
    return json(response, 200, {
      ok: true,
      recoveryKit: {
        confirmationId: pendingVaultConfirmationId,
        words: Array.from({ length: 16 }, (_, index) => index.toString(16).padStart(4, "0")),
        warning: "Save this recovery kit. ShellX cannot recover the vault without it.",
      },
    });
  }
  if (path === "/vault/setup/confirm-recovery" && request.method === "POST") {
    const body = await requestJson(request);
    if (!pendingVaultConfirmationId || body.confirmationId !== pendingVaultConfirmationId
      || body.importLegacy !== false) {
      return json(response, 400, { error: { code: "bad_request", message: "invalid recovery confirmation fixture" } });
    }
    pendingVaultConfirmationId = null;
    vaultSetupStatus = {
      ...vaultSetupStatus,
      mode: "local",
      unlocked: true,
      recoveryConfirmed: true,
      rememberedDeviceEnabled: false,
    };
    return json(response, 200, {
      ok: true,
      legacyImport: {
        importedKeys: 0,
        skipped: true,
        backupPath: null,
        completedAtMs: Date.now(),
      },
    });
  }
  if (path === "/vault/lock" && request.method === "POST") {
    await requestJson(request);
    if (vaultSetupStatus.mode !== "local" || !vaultSetupStatus.unlocked
      || !vaultSetupStatus.recoveryConfirmed || vaultSetupStatus.rememberedDeviceEnabled) {
      return json(response, 400, { error: { code: "bad_request", message: "invalid Vault lock fixture" } });
    }
    vaultSetupStatus = { ...vaultSetupStatus, unlocked: false };
    return json(response, 200, {
      ok: true,
      unlocked: false,
      rememberedDeviceEnabled: false,
    });
  }
  if (path === "/vault/remember-device" && request.method === "POST") {
    const body = await requestJson(request);
    if (vaultSetupStatus.mode !== "local" || !vaultSetupStatus.unlocked
      || !vaultSetupStatus.recoveryConfirmed || typeof body.enabled !== "boolean"
      || (body.enabled && (typeof body.passphrase !== "string"
        || !body.passphrase.startsWith("ShellX-Release-Vault-")))) {
      return json(response, 400, { error: { code: "bad_request", message: "invalid remembered-device fixture" } });
    }
    vaultSetupStatus = { ...vaultSetupStatus, rememberedDeviceEnabled: body.enabled };
    return json(response, 200, { ok: true, enabled: body.enabled });
  }
  if (path === "/vault/e2e/seed-secret" && request.method === "POST") {
    const body = await requestJson(request);
    if (typeof body.secretRef !== "string" || !body.secretRef.startsWith("release-surface/e2e/")
      || typeof body.value !== "string" || !body.value.startsWith("SHELLX_RELEASE_VAULT_E2E_SECRET_")
      || vaultE2eSecrets.has(body.secretRef)) {
      return json(response, 400, { error: "invalid Vault E2E seed fixture" });
    }
    vaultE2eSecrets.add(body.secretRef);
    const receipt = vaultE2eReceipt("vaultE2eSecretSeeded", { secretRef: body.secretRef, secretPresent: true });
    return json(response, 200, {
      ok: true,
      secretRef: body.secretRef,
      secretPresent: true,
      secretExposed: false,
      receipt,
    });
  }
  if (path === "/vault/agent-requests" && request.method === "POST") {
    const body = await requestJson(request);
    const spec = body.spec && typeof body.spec === "object" && !Array.isArray(body.spec)
      ? body.spec as Record<string, unknown> : null;
    const bindings = Array.isArray(spec?.bindings) ? spec.bindings : [];
    const binding = bindings[0] && typeof bindings[0] === "object" && !Array.isArray(bindings[0])
      ? bindings[0] as Record<string, unknown> : null;
    if (typeof body.actorId !== "string" || !body.actorId.startsWith("shellx-release-agent-")
      || typeof body.actorLabel !== "string" || typeof spec?.purpose !== "string"
      || typeof spec?.program !== "string" || !isFixtureAbsoluteProgram(spec.program)
      || JSON.stringify(spec.args) !== "[]" || spec.cwd !== null || spec.timeoutMs !== 5_000
      || !binding || typeof binding.resourceId !== "string" || !vaultE2eSecrets.has(binding.resourceId)
      || binding.field !== "value" || binding.env !== "SHELLX_RELEASE_VAULT_TOKEN") {
      return json(response, 400, { error: { code: "bad_request", message: "invalid Vault agent request fixture" } });
    }
    vaultAgentRequestIndex += 1;
    const createdAtMs = Date.now();
    const requestId = `request-${createdAtMs}-${vaultAgentRequestIndex.toString(16).padStart(16, "0")}`;
    const requestDigest = createHash("sha256").update(`${requestId}:${body.actorId}`).digest("hex");
    const row = {
      requestId,
      requestDigest,
      actorId: body.actorId,
      actorLabel: body.actorLabel,
      deviceId: `shellx-desktop-${fixturePlatform}`,
      spec,
      grantIds: [`vault-agent-grant-${vaultAgentRequestIndex}`],
      status: "pending",
      createdAtMs,
      expiresAtMs: createdAtMs + 300_000,
      decidedAtMs: null,
      completedAtMs: null,
      decisionReason: null,
      result: null,
    };
    vaultAgentRequests.push(row);
    vaultAgentResources.push({
      id: binding.resourceId,
      label: binding.resourceId,
      kind: "secret",
      permission: "visibleAsk",
      fields: ["value"],
      updatedAtMs: createdAtMs,
    });
    return json(response, 200, {
      ok: true,
      status: "pendingOperatorApproval",
      request: row,
      secretExposed: false,
    });
  }
  const vaultAgentRequestCancel = /^\/vault\/agent-requests\/([^/?]+)\/cancel$/.exec(path);
  if (vaultAgentRequestCancel && request.method === "POST") {
    const body = await requestJson(request);
    const requestId = decodeURIComponent(vaultAgentRequestCancel[1]!);
    const row = vaultAgentRequests.find((candidate) => candidate.requestId === requestId);
    if (!row || row.actorId !== body.actorId || row.status !== "pending") {
      return json(response, 400, { error: { code: "bad_request", message: "invalid Vault agent request cancel fixture" } });
    }
    const completedAtMs = Date.now();
    row.status = "cancelled";
    row.decidedAtMs = completedAtMs;
    row.completedAtMs = completedAtMs;
    row.decisionReason = "cancelled by requesting agent";
    return json(response, 200, { ok: true, request: row, secretExposed: false });
  }
  if (path === "/vault/e2e/approve-grant" && request.method === "POST") {
    const body = await requestJson(request);
    const actorScope = body.actorScope && typeof body.actorScope === "object" && !Array.isArray(body.actorScope)
      ? body.actorScope as Record<string, unknown> : null;
    if (typeof body.secretRef !== "string" || !vaultE2eSecrets.has(body.secretRef)
      || actorScope?.kind !== "allShellxAgents" || body.operation !== "fill"
      || body.origin !== "https://example.com"
      || !Number.isSafeInteger(body.expiresAtMs)) {
      return json(response, 400, { error: "invalid Vault E2E approval fixture" });
    }
    const grantId = `vault-grant-release-${vaultE2eReceiptIndex + 1}`;
    const grant = {
      grantId,
      secretRef: body.secretRef,
      actorScope: "allShellxAgents",
      operation: "Fill",
      origin: body.origin,
      createdAtMs: 1,
      expiresAtMs: body.expiresAtMs,
      revoked: false,
      approved: true,
    };
    vaultE2eGrants.set(grantId, {
      grantId,
      secretRef: body.secretRef,
      origin: String(body.origin),
      approved: true,
      revoked: false,
      expired: false,
    });
    const receipt = vaultE2eReceipt("vaultE2eGrantApproved", { secretRef: body.secretRef, grantId });
    return json(response, 200, { ok: true, grant, secretExposed: false, receipt });
  }
  if (path === "/vault/e2e/deny-grant" && request.method === "POST") {
    const body = await requestJson(request);
    if (typeof body.secretRef !== "string" || !vaultE2eSecrets.has(body.secretRef)
      || body.reason !== "releaseSurfaceDenied") {
      return json(response, 400, { error: "invalid Vault E2E denial fixture" });
    }
    const receipt = vaultE2eReceipt("vaultE2eGrantDenied", { secretRef: body.secretRef });
    return json(response, 200, {
      ok: true,
      grantId: null,
      reason: body.reason,
      secretExposed: false,
      receipt,
    });
  }
  if ((path === "/vault/e2e/revoke-grant" || path === "/vault/e2e/expire-grant") && request.method === "POST") {
    const body = await requestJson(request);
    const grant = typeof body.grantId === "string" ? vaultE2eGrants.get(body.grantId) : undefined;
    if (!grant) return json(response, 400, { error: "unknown Vault E2E grant fixture" });
    const action = path.endsWith("revoke-grant") ? "vaultE2eGrantRevoked" : "vaultE2eGrantExpired";
    if (action === "vaultE2eGrantRevoked") grant.revoked = true;
    else grant.expired = true;
    const receipt = vaultE2eReceipt(action, { grantId: grant.grantId });
    return json(response, 200, {
      ok: true,
      grantId: grant.grantId,
      secretExposed: false,
      receipt,
    });
  }
  if (path === "/vault/e2e/probe-use" && request.method === "POST") {
    const body = await requestJson(request);
    const actor = body.actor && typeof body.actor === "object" && !Array.isArray(body.actor)
      ? body.actor as Record<string, unknown> : null;
    const grant = typeof body.grantId === "string" ? vaultE2eGrants.get(body.grantId) : undefined;
    if (!grant || body.secretRef !== grant.secretRef || body.operation !== "fill"
      || actor?.agentId !== "shellx-release-driver" || actor.origin !== grant.origin
      || grant.revoked || grant.expired) {
      return json(response, 400, { error: "invalid Vault E2E probe fixture" });
    }
    const receipt = vaultE2eReceipt("vaultE2eSecretUseProbed", {
      secretRef: grant.secretRef,
      grantId: grant.grantId,
      decision: "allowMediated",
      secretPresent: true,
    });
    return json(response, 200, {
      ok: true,
      decision: "allowMediated",
      reason: null,
      secretRef: grant.secretRef,
      operation: "Fill",
      actor: { agentId: "shellx-release-driver", providerId: null, workspace: null, origin: grant.origin, connectorId: null },
      grantId: grant.grantId,
      secretPresent: true,
      secretExposed: false,
      receiptId: receipt.receiptId,
    });
  }
  if (path === "/vault/grants" && request.method === "POST") {
    const body = await requestJson(request);
    const actorScope = body.actorScope && typeof body.actorScope === "object" && !Array.isArray(body.actorScope)
      ? body.actorScope as Record<string, unknown> : null;
    if (typeof body.secretRef !== "string" || !vaultE2eSecrets.has(body.secretRef)
      || actorScope?.kind !== "allShellxAgents" || body.operation !== "fill"
      || body.origin !== "https://example.com"
      || !Number.isSafeInteger(body.expiresAtMs)) {
      return json(response, 400, { error: "invalid owned Vault grant fixture" });
    }
    vaultOwnedGrantIndex += 1;
    const grantId = `vault-normal-grant-${vaultOwnedGrantIndex}`;
    const grant = {
      grantId,
      secretRef: body.secretRef,
      actorScope: '{"kind":"allShellxAgents"}',
      operation: "Fill",
      origin: body.origin,
      createdAtMs: 5_000 + vaultOwnedGrantIndex,
      expiresAtMs: body.expiresAtMs,
      revoked: false,
      approved: false,
    };
    vaultE2eGrants.set(grantId, {
      grantId,
      secretRef: body.secretRef,
      origin: String(body.origin),
      approved: false,
      revoked: false,
      expired: false,
    });
    return json(response, 200, { ok: true, grant });
  }
  const ownedGrantRevoke = /^\/vault\/grants\/([^/?]+)\/revoke$/.exec(path);
  if (ownedGrantRevoke && request.method === "POST") {
    await requestJson(request);
    const grantId = decodeURIComponent(ownedGrantRevoke[1]!);
    const grant = vaultE2eGrants.get(grantId);
    if (!grant) return json(response, 400, { error: "unknown owned Vault grant fixture" });
    grant.revoked = true;
    return json(response, 200, { ok: true, grantId });
  }
  if (request.method === "POST" && path === "/agent_cli_setup/install/cancel") {
    await requestJson(request);
    return json(response, 200, { ok: true, cleaned: false });
  }
  if (request.method === "POST" && path === "/agent_cli_setup/install/confirm") {
    await requestJson(request);
    return json(response, 400, { error: { code: "bad_request", message: "agent_cli_setup.confirm: unknown or expired confirmation id 'shellx-release-missing-confirmation'" } });
  }
  if (request.method === "POST" && path === "/agent_cli_setup/install/prepare") {
    await requestJson(request);
    return json(response, 400, { error: { code: "bad_request", message: "agent_cli_setup.prepare: unknown provider 'shellx-release-invalid-provider'" } });
  }
  if (request.method === "POST" && path === "/agent_cli_setup/recheck") {
    await requestJson(request);
    return json(response, 400, { error: { code: "bad_request", message: "unknown connectionId 'shellx-release-missing-connection'" } });
  }
  if (request.method === "POST" && path === "/autonomy?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return json(response, 400, {
      error: "invalid_mode",
      received: "shellx-release-invalid-mode",
      accepted: ["plan", "acceptEdits", "default", "bypassPermissions", "alwaysApprove", "dontAsk", "confirm", "auto"],
      hint: "Use `default` for per-tool gate (alias: `confirm`) or `bypassPermissions` for auto-approve (alias: `auto`).",
    });
  }
  if (request.method === "POST" && (path === "/build/start?tabId=shellx-release-safe-refusal"
    || path === "/goal/start?tabId=shellx-release-safe-refusal")) {
    await requestJson(request);
    return text(response, 400, "objective: must be non-empty");
  }
  if (request.method === "POST" && path === "/build/receipt?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return json(response, 400, { ok: false, tabId: "shellx-release-safe-refusal", message: "summary is required" });
  }
  if (request.method === "POST" && path === "/build/approve?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return json(response, 200, { ok: true, tabId: "shellx-release-safe-refusal", approved: false, injected: false });
  }
  if (request.method === "POST" && path === "/build/complete?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return json(response, 409, { ok: false, tabId: "shellx-release-safe-refusal", complete: false, message: "no active build run for this tab" });
  }
  if (request.method === "POST" && path === "/build/operator_note?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return json(response, 409, { ok: false, tabId: "shellx-release-safe-refusal", message: "no active /build run for this tab" });
  }
  if (request.method === "POST" && path === "/build/pause?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return json(response, 200, { ok: true, tabId: "shellx-release-safe-refusal", paused: false, abortedTabTasks: 0 });
  }
  if (request.method === "POST" && path === "/build/recheck_blocker?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return text(response, 500, "no build run for this tab");
  }
  if (request.method === "POST" && path === "/build/reject?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return json(response, 200, {
      ok: true,
      tabId: "shellx-release-safe-refusal",
      rejected: false,
      abortedAgentWatchers: 0,
      abortedTabTasks: 0,
    });
  }
  if (request.method === "POST" && path === "/build/resume?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return json(response, 409, { ok: false, tabId: "shellx-release-safe-refusal", message: "Connect this tab before resuming Build Mode." });
  }
  if (request.method === "POST" && path === "/build/stop?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return json(response, 200, {
      ok: true,
      tabId: "shellx-release-safe-refusal",
      stopped: false,
      active: false,
      promptCancelled: false,
      promptCancelError: null,
      killedHostMcpTasks: [],
      killErrors: [],
      killedAgentSubagents: [],
      agentKillErrors: [],
      abortedAgentWatchers: 0,
      abortedTabTasks: 0,
    });
  }
  if (request.method === "POST" && (path === "/browser/vault/fill-receipt"
    || path === "/browser/vault/generate-receipt")) {
    await requestJson(request);
    return json(response, 409, {
      ok: false,
      code: "browser_vault_receipt_requires_verified_operation",
      error: path.endsWith("fill-receipt")
        ? "Vault fill receipts are emitted only after an installed Browser engine confirms the mediated fill"
        : "Password generation must run through ShellX Vault; callers cannot self-issue generation receipts",
      secretExposed: false,
    });
  }
  if (request.method === "POST" && path === "/goal/complete?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return json(response, 200, {
      ok: true,
      tabId: "shellx-release-safe-refusal",
      active: false,
      wasActive: false,
      scratchboardPatched: false,
      scratchboardError: null,
    });
  }
  if (request.method === "POST" && path === "/goal/pause?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return json(response, 200, { ok: true, tabId: "shellx-release-safe-refusal", paused: true });
  }
  if (request.method === "POST" && (path === "/abort?tabId=shellx-release-safe-refusal"
    || path === "/disconnect?tabId=shellx-release-safe-refusal")) {
    await requestJson(request);
    return json(response, 200, {
      ok: true,
      tabId: "shellx-release-safe-refusal",
      registryRemoved: true,
      keepSession: false,
      abortedTabTasks: 0,
    });
  }
  if (request.method === "POST" && path === "/goal/reject?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return json(response, 200, { ok: true, tabId: "shellx-release-safe-refusal", rejected: false });
  }
  if (request.method === "POST" && path === "/goal/resume?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return json(response, 200, { ok: true, tabId: "shellx-release-safe-refusal", paused: false });
  }
  if (request.method === "POST" && path === "/goal/approve?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return json(response, 200, {
      ok: true,
      tabId: "shellx-release-safe-refusal",
      approved: false,
      injected: false,
    });
  }
  if (request.method === "POST" && path === "/plan?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return text(response, 400, "plan writes require an existing connected session");
  }
  if (request.method === "POST" && path === "/prompt?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return text(response, 400, "empty prompt");
  }
  if (request.method === "POST" && path === "/provider-sessions/abort?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    return json(response, 404, {
      ok: false,
      tabId: "shellx-release-safe-refusal",
      runId: null,
      aborted: false,
      error: "no matching active provider session",
    });
  }
  if (request.method === "POST" && path === "/tabs/shellx-release-missing-tab/archive") {
    await requestJson(request);
    return json(response, 404, {
      ok: false,
      error: "tab_not_found",
      message: "no live session exists for tab 'shellx-release-missing-tab'",
    });
  }
  if (request.method === "POST" && path === "/preview/work/diagnose?tabId=shellx-release-safe-refusal") {
    await requestJson(request);
    const state = idlePreviewState();
    return json(response, 200, {
      tabId: "shellx-release-safe-refusal",
      ok: false,
      status: "failed",
      summary: "Preview Doctor found 2 error(s) and 0 warning(s).",
      url: null,
      cwd: null,
      command: null,
      httpStatus: null,
      responseBytes: null,
      title: null,
      screenshotPath: null,
      screenshotWidth: null,
      screenshotHeight: null,
      screenshotBrowser: null,
      screenshotError: null,
      issues: [
        { severity: "error", source: "preview", message: "preview status is Idle" },
        { severity: "error", source: "preview", message: "preview has no URL to inspect" },
      ],
      browserEvents: [],
      logs: [],
      state,
    });
  }
  if (request.method === "POST" && ["/preview/work/start", "/preview/work/restart"].includes(requestUrl.pathname)) {
    const body = await requestJson(request);
    const tabId = String(requestUrl.searchParams.get("tabId") ?? body.tabId ?? "");
    const cwd = String(body.cwd ?? "");
    if (!tabId.startsWith("shellx-release-preview-") || !cwd || body.kind !== "static"
      || body.entry !== "release-preview.html") {
      return json(response, 400, { error: "invalid Work Preview lifecycle fixture" });
    }
    previewGeneration += 1;
    const url = `http://127.0.0.1:${address().port}/preview-fixture/${encodeURIComponent(tabId)}/${previewGeneration}/release-preview.html`;
    const now = Date.now();
    const state = {
      tabId,
      cwd,
      kind: "staticHtml",
      status: "running",
      url,
      command: "shellX static file server",
      taskId: null,
      pid: null,
      startedAtMs: now,
      updatedAtMs: now,
      viewportHint: null,
      error: null,
      logs: [
        { t: now, stream: "system", line: "selected static entry release-preview.html" },
        { t: now, stream: "system", line: `serving ${cwd} at ${url}` },
      ],
    };
    previewStates.set(tabId, state);
    return json(response, 200, state);
  }
  if (request.method === "POST" && requestUrl.pathname === "/preview/work/stop") {
    const body = await requestJson(request);
    const tabId = String(requestUrl.searchParams.get("tabId") ?? body.tabId ?? "");
    const state = previewStates.get(tabId);
    if (!state) return json(response, 200, idlePreviewState(tabId));
    state.status = "stopped";
    state.url = null;
    state.taskId = null;
    state.pid = null;
    state.error = null;
    state.updatedAtMs = Date.now();
    (state.logs as Array<Record<string, unknown>>).push({
      t: Date.now(),
      stream: "system",
      line: "preview stopped by shellX",
    });
    return json(response, 200, state);
  }
  if (request.method === "POST" && (path === "/state/environment/trace_export"
    || path === "/state/grok_environment/trace_export")) {
    await requestJson(request);
    return text(response, 400, "no registered tab session");
  }
  if (request.method === "POST" && path === "/connections/shellx-release-missing-connection/test") {
    await requestJson(request);
    return json(response, 200, { reachable: false, latencyMs: null, error: "unknown connection id" });
  }
  if (request.method === "POST" && path === "/connections/provider-scan") {
    await requestJson(request);
    return json(response, 400, { error: { code: "bad_request", message: "invalid connection preset: missing field `id`" } });
  }
  if (request.method === "POST" && path === "/outside-connectors/shellx-release-missing-connector/test") {
    await requestJson(request);
    return json(response, 200, { reachable: false, provider: "unknown", latencyMs: null, identity: null, error: "unknown connector id" });
  }
  if (request.method === "POST" && path === "/outside-connectors/shellx-release-missing-connector/simulate") {
    await requestJson(request);
    return json(response, 400, { error: { code: "bad_request", message: "unknown connector id" } });
  }
  if (request.method === "POST" && path === "/permissions/shellx-release-missing-permission/respond") {
    await requestJson(request);
    return text(response, 404, "permission request 'shellx-release-missing-permission' not found or already resolved");
  }
  if (request.method === "POST" && path === "/sessions/shellx-release-missing-session/archive") {
    await requestJson(request);
    return json(response, 404, {
      ok: false,
      error: "session_not_found",
      message: "no live tab owns session id 'shellx-release-missing-session'. Use POST /tabs/<tabId>/archive to archive by tab id directly.",
    });
  }
  if (request.method === "POST" && path === "/tools/process_list") {
    await requestJson(request);
    return json(response, 200, { processes: [{ taskId: "fixture-private-process", pid: 9999, cmd: "fixture-private-process-command" }] });
  }
  if (request.method === "POST" && ["/tools/process_attach_stdout", "/tools/process_signal", "/tools/process_stats"].includes(path)) {
    await requestJson(request);
    return text(response, path === "/tools/process_signal" ? 400 : 404, "unknown taskId: shellx-release-missing-process");
  }
  if (request.method === "POST" && path === "/tools/secret_get") {
    await requestJson(request);
    return json(response, 403, {
      code: "RAW_SECRET_REVEAL_DENIED",
      reason: "raw_secret_reveal_denied",
      message: "raw Vault secret reveal requires explicit user approval; use mediated Vault fill or injection tools",
      isError: true,
    });
  }
  const operatorGate = operatorGateForRequest(request.method ?? "", path);
  if (operatorGate) {
    request.resume();
    if (operatorGate.shape === "flat-error") {
      return json(response, operatorGate.status, {
        ok: false,
        error: `${operatorGate.code}: ${operatorGate.message}`,
      });
    }
    if (operatorGate.shape === "flat-code-error") {
      return json(response, operatorGate.status, {
        ok: false,
        code: operatorGate.code,
        error: `${operatorGate.code}: ${operatorGate.message}`,
      });
    }
    return json(response, operatorGate.status, {
      ok: false,
      error: { code: operatorGate.code, message: operatorGate.message },
    });
  }
  if (request.method === "POST" && path === "/vault/get") {
    request.resume();
    return json(response, 403, {
      code: "RAW_SECRET_REVEAL_DENIED",
      reason: "raw_secret_reveal_denied",
      message: "raw Vault secret reveal requires explicit user approval; use mediated Vault fill or injection tools",
      isError: true,
    });
  }
  if (request.method === "POST" && path === "/vault/set") {
    const body = await requestJson(request);
    const key = typeof body.key === "string" ? body.key : "";
    const value = typeof body.value === "string" ? body.value : "";
    if (!key || !value || vaultEntries.some((entry) => entry.key === key)) {
      return json(response, 400, { error: { code: "bad_request", message: "invalid Vault fixture" } });
    }
    vaultEntries.push({ key, resourceKind: "secret" });
    return json(response, 200, { ok: true, key });
  }
  if (request.method === "POST" && path === "/browser/vault-deposits") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const label = typeof body.label === "string" ? body.label : "";
    const secretValue = typeof body.secretValue === "string" ? body.secretValue : "";
    const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl : "";
    if (!browserTasks.has(taskId) || !label || !secretValue || !sourceUrl) {
      return json(response, 400, { ok: false, error: "invalid Browser Vault deposit fixture", secretExposed: false });
    }
    browserMonotonicIndex += 1;
    const depositId = `browser-deposit-release-${browserMonotonicIndex}`;
    const storageCommitHash = createHash("sha256").update(secretValue).digest("hex");
    const vaultRef = `browser-deposits/shellx-release-${depositId}`;
    vaultEntries.push({ key: vaultRef, resourceKind: "secret" });
    const receipt = monotonicReceipt("browserVaultDepositCreated", taskId, {
      depositId,
      storageCommitHash,
      vaultRef,
      secretExposed: false,
    });
    return json(response, 200, {
      depositId,
      label,
      storageCommitHash,
      secretExposed: false,
      taskId,
      sourceUrl,
      vaultRef,
      serverReceipt: {
        id: depositId,
        payloadHash: storageCommitHash,
        createdMs: Date.now(),
        fromToken: "browser-agent-token:shellx-browser",
      },
      receipt,
    });
  }
  if (request.method === "POST" && path === "/vault/delete") {
    const body = await requestJson(request);
    const key = typeof body.key === "string" ? body.key : "";
    const index = vaultEntries.findIndex((entry) => entry.key === key);
    if (index < 0) return json(response, 400, { error: { code: "bad_request", message: "unknown Vault fixture" } });
    vaultEntries.splice(index, 1);
    return json(response, 200, { ok: true, key });
  }
  if (request.method === "POST" && path === "/browser/engine-pool") {
    const body = await requestJson(request);
    if (!["auto", "1", "2", "3", "4"].includes(String(body.configuredParallelAgents))
      || !["normal", "backgroundOnly"].includes(String(body.automationMode))) {
      return json(response, 400, { ok: false, error: "invalid engine-pool fixture" });
    }
    enginePool.limits.configuredParallelAgents = String(body.configuredParallelAgents);
    enginePool.limits.effectiveBackgroundEngines = body.configuredParallelAgents === "auto"
      ? 4
      : Number(body.configuredParallelAgents);
    enginePool.automationMode = String(body.automationMode);
    return json(response, 200, { enginePool });
  }
  if (request.method === "POST" && path === "/panels") {
    const body = await requestJson(request);
    if (!Array.isArray(body.horizontal) || body.horizontal.length !== 3
      || !Array.isArray(body.vertical) || body.vertical.length !== 2
      || [...body.horizontal, ...body.vertical].some((item) => typeof item !== "number" || !Number.isFinite(item))) {
      return json(response, 400, { ok: false, error: "invalid panel fixture" });
    }
    panels = {
      horizontal: [...body.horizontal] as number[],
      vertical: [...body.vertical] as number[],
    };
    return json(response, 200, { ok: true, panels });
  }
  if (request.method === "POST" && path === "/preview") {
    const body = await requestJsonValue(request);
    if (body !== null && (!body || typeof body !== "object" || Array.isArray(body)
      || typeof (body as Record<string, unknown>).kind !== "string"
      || typeof (body as Record<string, unknown>).path !== "string")) {
      return json(response, 400, { ok: false, error: "invalid Preview fixture" });
    }
    previewTarget = body === null ? null : structuredClone(body as Record<string, unknown>);
    return json(response, 200, { ok: true, preview: previewTarget });
  }
  if (request.method === "POST" && path === "/settings") {
    const body = await requestJson(request);
    if (typeof body.browserDownloadFolder !== "string"
      || !Number.isSafeInteger(body.chatFontPx) || Number(body.chatFontPx) < 12 || Number(body.chatFontPx) > 26
      || !["compact", "default", "comfortable"].includes(String(body.density))
      || !["gh", "gh.exe"].includes(String(body.githubGhBinary))
      || !["black", "black_warm", "bright"].includes(String(body.theme))) {
      return json(response, 400, { error: "invalid settings fixture" });
    }
    settings = {
      browserDownloadFolder: body.browserDownloadFolder,
      chatFontPx: Number(body.chatFontPx),
      density: String(body.density),
      githubGhBinary: String(body.githubGhBinary),
      theme: String(body.theme),
    };
    return json(response, 200, { ok: true, settings });
  }
  if (request.method === "POST" && path === "/connections") {
    const body = await requestJson(request);
    if (body.id !== "" || typeof body.label !== "string" || !body.label.startsWith("ShellX release ")
      || !body.transport || typeof body.transport !== "object" || Array.isArray(body.transport)
      || (body.transport as Record<string, unknown>).kind !== "local"
      || body.createdMs !== 0 || body.lastUsedMs !== 0 || !Array.isArray(body.providerScan)
      || connections.some((preset) => preset.label === body.label)) {
      return json(response, 400, { error: "invalid connection fixture" });
    }
    connectionReceiptIndex += 1;
    const preset = {
      id: `conn-release-surface-${connectionReceiptIndex}`,
      label: body.label,
      transport: { kind: "local" },
      createdMs: 1000 + connectionReceiptIndex,
      lastUsedMs: 0,
    };
    connections.push(preset);
    return json(response, 201, preset);
  }
  const connectionDelete = /^\/connections\/([^/?]+)$/.exec(path);
  if (request.method === "DELETE" && connectionDelete) {
    request.resume();
    const id = decodeURIComponent(connectionDelete[1]!);
    const index = connections.findIndex((preset) => preset.id === id && String(preset.label).startsWith("ShellX release "));
    if (index < 0) return json(response, 200, { alreadyGone: true });
    connections.splice(index, 1);
    response.writeHead(204);
    return response.end();
  }
  if (request.method === "POST" && path === "/outside-connectors") {
    const body = await requestJson(request);
    const provider = body.provider && typeof body.provider === "object" && !Array.isArray(body.provider)
      ? body.provider as Record<string, unknown> : null;
    const target = body.target && typeof body.target === "object" && !Array.isArray(body.target)
      ? body.target as Record<string, unknown> : null;
    if (body.id !== "" || typeof body.label !== "string" || !body.label.startsWith("ShellX release outside ")
      || body.enabled !== false || provider?.kind !== "telegram"
      || typeof provider.botTokenVaultKey !== "string" || !provider.botTokenVaultKey.startsWith("release-surface/outside-connector/")
      || !Array.isArray(provider.allowedChatIds) || target?.mode !== "activeTab"
      || body.dispatchMode !== "inbox" || body.requireApproval !== true
      || body.createdMs !== 0 || body.updatedMs !== 0 || body.lastTestMs !== null || body.lastError !== null
      || outsideConnectors.some((connector) => connector.label === body.label)) {
      return json(response, 400, { error: "invalid outside-connector fixture" });
    }
    outsideConnectorReceiptIndex += 1;
    const connector = {
      ...body,
      id: `oconn-release-surface-${outsideConnectorReceiptIndex}`,
      createdMs: 2000 + outsideConnectorReceiptIndex,
      updatedMs: 2000 + outsideConnectorReceiptIndex,
    };
    outsideConnectors.push(connector);
    return json(response, 201, connector);
  }
  const outsideConnectorDelete = /^\/outside-connectors\/([^/?]+)$/.exec(path);
  if (request.method === "DELETE" && outsideConnectorDelete) {
    request.resume();
    const id = decodeURIComponent(outsideConnectorDelete[1]!);
    const index = outsideConnectors.findIndex((connector) => connector.id === id && String(connector.label).startsWith("ShellX release outside "));
    if (index < 0) return json(response, 200, { alreadyGone: true });
    outsideConnectors.splice(index, 1);
    response.writeHead(204);
    return response.end();
  }
  if (request.method === "POST" && path === "/state/ui") {
    const body = await requestJson(request);
    if (body.source === "final-surface-vault-open-panel") {
      if (body.openModal === "close") uiOpenModal = null;
      if (Array.isArray(body.debugHighlights)) {
        uiDebugHighlights = body.debugHighlights.map((entry) => structuredClone(entry as Record<string, unknown>));
        uiDebugHighlightResultsBySurface = uiDebugHighlights.length === 0 ? { app: [] } : {
          app: uiDebugHighlights.map((entry) => ({
            id: entry.id,
            selector: entry.selector,
            status: uiOpenModal === "vault" ? "resolved" : "missing",
            rect: uiOpenModal === "vault" ? { x: 180, y: 100, width: 960, height: 720 } : null,
            visibleRect: uiOpenModal === "vault" ? { x: 180, y: 100, width: 960, height: 720 } : null,
            message: uiOpenModal === "vault" ? null : "Vault panel is closed",
          })),
        };
      }
      uiRevision += 1;
      lastUiPatchMs = 3000 + uiRevision;
      lastUiPatchSource = String(body.source);
      return json(response, 200, uiState());
    }
    if (!['Chat', 'Terminal', 'Logs', 'Stderr'].includes(String(body.bottomTab))
      || typeof body.source !== "string" || !body.source.startsWith("final-surface-state-ui-")) {
      return json(response, 400, { error: "invalid UI-state fixture" });
    }
    uiBottomTab = String(body.bottomTab);
    uiRevision += 1;
    lastUiPatchMs = 3000 + uiRevision;
    lastUiPatchSource = String(body.source);
    return json(response, 200, uiState());
  }
  if (request.method === "POST" && path === "/browser/logs") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const callerSessionId = typeof request.headers["x-shellx-mcp-caller-id"] === "string"
      ? request.headers["x-shellx-mcp-caller-id"]!.trim() || null
      : null;
    if (!browserTasks.has(taskId) || typeof body.message !== "string" || !body.message
      || !callerSessionId || browserTaskCallerSessions.get(taskId) !== callerSessionId) {
      return json(response, 400, { error: "invalid Browser log fixture" });
    }
    browserMonotonicIndex += 1;
    const logId = `release-browser-log-${browserMonotonicIndex}`;
    const entry = {
      logId,
      taskId,
      profileId: "task-disposable",
      level: "info",
      source: "agent-reported",
      message: body.message,
      url: body.url,
      line: body.line,
      column: body.column,
      t: Date.now(),
      sequence: browserMonotonicIndex,
      details: body.details,
    };
    browserConsoleLogs.push(entry);
    browserMonotonicReceipts.push(monotonicReceipt("browserConsoleLog", taskId, { logId }));
    return json(response, 200, entry);
  }
  if (request.method === "POST" && path === "/browser/downloads/request") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    if (!browserTasks.has(taskId) || browserTabs.get(browserTabId) !== taskId
      || typeof body.url !== "string" || !body.url.startsWith("http://127.0.0.1:")
      || typeof body.fileName !== "string" || !body.fileName.startsWith("release-owned-download-")
      || typeof body.destinationDir !== "string" || !body.destinationDir
      || body.reason !== "Final release owned Browser download intent proof") {
      return json(response, 400, { error: "invalid Browser download request fixture" });
    }
    browserMonotonicIndex += 1;
    const transferId = `release-browser-download-${browserMonotonicIndex}`;
    const receipt = monotonicReceipt("browserDownloadRequested", taskId, {
      transferId,
      browserTabId,
      url: body.url,
      displayName: body.fileName,
      destination: body.destinationDir,
      status: "requested",
    });
    const entry = transferEntry({
      transferId,
      direction: "download",
      taskId,
      browserTabId,
      url: body.url,
      filePath: null,
      displayName: body.fileName,
      destination: body.destinationDir,
      destinationOrigin: null,
      refId: null,
      reason: body.reason,
      receipt,
    });
    browserDownloads.push(entry);
    browserMonotonicReceipts.push(receipt);
    return json(response, 200, entry);
  }
  if (request.method === "POST" && path === "/browser/downloads/complete") {
    const body = await requestJson(request);
    const transfer = browserDownloads.find((entry) => entry.transferId === body.transferId);
    if (!transfer || body.approvalId !== "shellx-release-ungranted-download-approval") {
      return json(response, 400, { ok: false, error: "invalid Browser download completion fixture" });
    }
    return json(response, 400, {
      ok: false,
      error: "approvalId must reference a host-granted browser transfer approval",
    });
  }
  if (request.method === "POST" && path === "/browser/uploads/request") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const browserTabId = typeof body.browserTabId === "string" ? body.browserTabId : "";
    if (!browserTasks.has(taskId) || browserTabs.get(browserTabId) !== taskId
      || typeof body.filePath !== "string" || !body.filePath
      || typeof body.displayName !== "string" || !body.displayName.startsWith("release-owned-upload-")
      || typeof body.destinationOrigin !== "string" || !body.destinationOrigin.startsWith("http://127.0.0.1:")
      || body.refId !== "release-owned-upload-target"
      || body.reason !== "Final release owned Browser upload intent proof") {
      return json(response, 400, { error: "invalid Browser upload request fixture" });
    }
    browserMonotonicIndex += 1;
    const transferId = `release-browser-upload-${browserMonotonicIndex}`;
    const receipt = monotonicReceipt("browserUploadRequested", taskId, {
      transferId,
      browserTabId,
      displayName: body.displayName,
      destinationOrigin: body.destinationOrigin,
      refId: body.refId,
      status: "requested",
    });
    const entry = transferEntry({
      transferId,
      direction: "upload",
      taskId,
      browserTabId,
      url: null,
      filePath: null,
      displayName: body.displayName,
      destination: null,
      destinationOrigin: body.destinationOrigin,
      refId: body.refId,
      reason: body.reason,
      receipt,
    });
    browserUploads.push(entry);
    browserMonotonicReceipts.push(receipt);
    return json(response, 200, entry);
  }
  if (request.method === "POST" && path === "/browser/uploads/complete") {
    const body = await requestJson(request);
    const transfer = browserUploads.find((entry) => entry.transferId === body.transferId);
    if (!transfer || body.approvalId !== "shellx-release-ungranted-upload-approval") {
      return json(response, 400, { ok: false, error: "invalid Browser upload completion fixture" });
    }
    return json(response, 400, {
      ok: false,
      error: "approvalId must reference a host-granted browser transfer approval",
    });
  }
  if (request.method === "POST" && path === "/browser/report") {
    const body = await requestJson(request);
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    if (!browserTasks.has(taskId) || typeof body.title !== "string" || !body.title
      || typeof body.body !== "string") {
      return json(response, 400, { error: "invalid Browser report fixture" });
    }
    browserMonotonicIndex += 1;
    const reportId = `release-browser-report-${browserMonotonicIndex}`;
    const receipt = monotonicReceipt("browserReportWritten", taskId, {
      reportId,
      title: body.title,
      bodyBytes: Buffer.byteLength(body.body),
    });
    browserMonotonicReceipts.push(receipt);
    return json(response, 200, { reportId, title: body.title, receipt });
  }
  if (request.method === "POST" && path === "/browser/rendered-check") {
    const body = await requestJson(request);
    if (typeof body.url !== "string" || !body.url.startsWith("http://127.0.0.1:")
      || body.expectText !== "ShellX rendered release fixture ready"
      || body.titleIncludes !== "ShellX release rendered check" || body.selector !== "#ready") {
      return json(response, 400, { ok: false, error: "invalid rendered-check fixture" });
    }
    const rendered = await fetch(body.url);
    if (!rendered.ok || !(await rendered.text()).includes("ShellX rendered release fixture ready")) {
      return json(response, 500, { ok: false, error: "owned rendered-check page was unavailable" });
    }
    return json(response, 200, {
      schema: "shellx/browser-rendered-check@1",
      ok: true,
      status: "passed",
      evidence: {
        textMatched: true,
        titleMatched: true,
        selectorMatched: true,
        selectorCount: 1,
        finalOrigin: new URL(body.url).origin,
      },
      effects: {
        visibleWindowOpened: false,
        browserTaskCreated: false,
        browserTabCreated: false,
        receiptEmitted: false,
        hiddenRendererCreated: true,
        hiddenRendererDestroyed: true,
        profilePersisted: false,
      },
    });
  }
  if (request.method === "POST" && path === "/browser/open") {
    const body = await requestJson(request);
    if (body.startUrl !== "about:blank") {
      return json(response, 400, { ok: false, error: "invalid Browser window fixture" });
    }
    browserWindowOpen = true;
    browserPendingStartUrl = "about:blank";
    enginePool.windowState = "foreground";
    browserMonotonicIndex += 1;
    const receipt = {
      receiptId: `release-browser-monotonic-receipt-${browserMonotonicIndex}`,
      kind: "browserWindowOpened",
      taskId: null,
      profileId: null,
      summary: "ShellX Browser window opened",
      t: Date.now(),
      sequence: browserMonotonicIndex,
      evidence: { windowLabel: "shellx-browser", startUrl: "about:blank" },
    };
    browserMonotonicReceipts.push(receipt);
    return json(response, 200, {
      ok: true,
      windowLabel: "shellx-browser",
      startUrl: "about:blank",
      receipt,
    });
  }
  if (request.method === "POST" && path === "/vault/open-panel") {
    await requestJson(request);
    uiOpenModal = "vault";
    return json(response, 200, { ok: true });
  }
  if (request.method === "POST" && path === "/state/session_git/checkpoint") {
    return handleGitCheckpointFixture(request, response);
  }
  if (request.method === "POST" && path === "/state/session_git/worktree") {
    return handleGitWorktreeFixture(request, response);
  }
  if (request.method !== "GET") return json(response, 405, { error: "method not allowed" });
  if (path === "/shellxagent.json" || path === "/.well-known/shellxagent.json") {
    return json(response, 200, descriptor());
  }
  if (path === "/agent-doc" || path === "/agent-doc/manifest") return json(response, 200, agentDoc());
  if (path === "/agent-doc/skills/shellx-host/SKILL.md" || path === "/agent-doc/shellx-host/SKILL.md") {
    response.writeHead(200, { "Content-Type": "text/markdown" });
    return response.end(`---\nname: shellx-host\n---\n# ShellX\n${"Session-scoped ShellX host guidance. ".repeat(24)}`);
  }
  if (path === "/settings") {
    return json(response, 200, settings);
  }
  if (path === "/connections") return json(response, 200, { presets: connections });
  if (path === "/browser/summary") {
    return json(response, 200, {
      browserProtocolVersion: "shellx-browser/1",
      browserSchemaRevision: "fixture-1",
      revisions: {},
      counts: { profiles: 0, tabs: 0, tasks: 0, runningTasks: 0, pendingRequests: 0 },
      pendingRequests: [],
      windowOpen: browserWindowOpen,
      personalBrowserLocked: true,
    });
  }
  if (path === "/browser/tabs") return json(response, 200, { tabs: [] });
  if (path === "/browser/profiles") return json(response, 200, { profiles: [] });
  if (path === "/browser/tasks") {
    return json(response, 200, { tasks: [], detail: "summary", includeObservation: false, revision: "fixture-1" });
  }
  if (path === "/browser/state") {
    return json(response, 200, {
      profiles: [{ profileId: "fixture-profile-private" }],
      tabs: [
        { browserTabId: "fixture-tab-private" },
        ...[...browserTabs].map(([browserTabId, taskId]) => ({
          browserTabId,
          taskId,
          lock: browserTabLocks.get(browserTabId) ?? null,
        })),
      ],
      tasks: [
        { taskId: "fixture-task-private", status: "completed" },
        ...[...browserTasks].map(([taskId, status]) => ({
          taskId,
          status,
          statusReason: status === "aborted" ? "lastTabClosed" : null,
        })),
      ],
      activeTaskId: [...browserTasks].filter(([, status]) => status === "running" || status === "paused").at(-1)?.[0] ?? null,
      activeBrowserTabId,
      windowOpen: browserWindowOpen,
      pendingStartUrl: browserPendingStartUrl,
      enginePool,
      engine: {},
    });
  }
  if (path.startsWith("/browser/settle?")) {
    const requestedTaskId = requestUrl.searchParams.get("taskId") ?? settleTaskId;
    const requestedTabId = requestUrl.searchParams.get("browserTabId") ?? settleTabId;
    return json(response, 200, {
      settled: true,
      taskId: requestedTaskId,
      browserTabId: requestedTabId,
      taskStatus: browserTasks.get(requestedTaskId) ?? "missing",
      tabStatus: "ready",
      engineId: "release-browser-settle-engine-private",
      engineLoadStatus: "loaded",
      engineUrl: browserTaskUrls.get(requestedTaskId) ?? null,
      pendingUrl: null,
      revision: "engine:fixture-private",
    });
  }
  if (requestUrl.pathname === "/events/recent") {
    const watchEvents = [...fsWatchers.values()].flatMap((watcher) => (
      readdirSync(watcher.watching)
        .filter((name) => name.startsWith("release-owned-fs-watch-") && name.endsWith(".txt"))
        .map((name, index) => ({
          t: 8_000 + index,
          kind: "fs-watch",
          payload: {
            watchId: watcher.watchId,
            kind: "created",
            path: join(watcher.watching, name),
            tMs: 8_000 + index,
            t: 8_000 + index,
            watching: watcher.watching,
          },
        }))
    ));
    return json(response, 200, [
      { t: 1, kind: "fixture-private-kind", payload: { text: "fixture-event-payload-private" } },
      ...watchEvents,
      ...providerLifecycleEvents,
    ]);
  }
  if (path === "/build/receipts") {
    return json(response, 404, { ok: false, tabId: "default", message: "no build run for this tab" });
  }
  if (path === "/provider-adapters/state") {
    return json(response, 200, {
      providers: [
        providerAdapter("codex-cli", "Codex CLI", "jsonl"),
        providerAdapter("claude-code", "Claude Code", "stream-json"),
        providerAdapter("antigravity-cli", "Antigravity CLI", "stream-json"),
      ],
    });
  }
  if (requestUrl.pathname === "/provider-sessions/state"
    && (requestUrl.searchParams.get("tabId")?.startsWith("shellx-release-provider-")
      || requestUrl.searchParams.get("tabId")?.startsWith("release-provider-action-"))) {
    const tabId = requestUrl.searchParams.get("tabId")!;
    const run = providerLifecycleRuns.get(tabId);
    const active = run && (run.phase === "starting" || run.phase === "streaming") ? run : null;
    const recent = run && !active ? [run] : [];
    return json(response, 200, {
      tabId,
      transport: "local",
      transportKey: "local",
      sshRemoteRuntime: "posix",
      activeRun: active,
      recentRuns: recent,
      storedConversations: {},
    });
  }
  if (path === "/provider-sessions/state") {
    return json(response, 200, {
      tabId: "fixture-provider-tab-private",
      transport: "local",
      transportKey: "fixture-transport-key-private",
      sshRemoteRuntime: "posix",
      activeRun: null,
      recentRuns: [{
        runId: "fixture-provider-run-private",
        tabId: "fixture-provider-tab-private",
        providerId: "codex-cli",
        phase: "completed",
        stdoutLineCount: 1,
        stderrLineCount: 0,
      }],
      storedConversations: { "codex-cli": "fixture-conversation-private" },
    });
  }
  if (path === "/provider-sessions/state?tabId=shellx-release-safe-refusal") {
    return json(response, 200, {
      tabId: "shellx-release-safe-refusal",
      transport: "local",
      transportKey: "local",
      sshRemoteRuntime: "posix",
      activeRun: null,
      recentRuns: [],
      storedConversations: {},
    });
  }
  if (path === "/state/agent_cli_setup") {
    return json(response, 200, {
      generatedAtMs: 1,
      target: { label: "fixture-target-private", transport: "local-posix", commandRunsOn: "fixture-host-private" },
      providers: [
        agentCliSetupCard("grok", "Grok Build CLI"),
        agentCliSetupCard("codex-cli", "Codex CLI"),
        agentCliSetupCard("claude-code", "Claude Code"),
        agentCliSetupCard("antigravity-cli", "Antigravity CLI"),
      ],
    });
  }
  if (path === "/state/environment?tabId=final-surface-environment-missing-session") {
    return json(response, 200, environmentSnapshot("final-surface-environment-missing-session"));
  }
  if (path === "/state/grok_environment?tabId=final-surface-grok-environment-missing-session") {
    return json(response, 200, environmentSnapshot("final-surface-grok-environment-missing-session"));
  }
  if (path === "/state/model_instruction_cards") {
    return json(response, 200, {
      version: "fixture-card-version-private",
      lastReviewed: "2026-07-29",
      policy: {
        shellxMayAutoRoute: false,
        defaultRouteMode: "explicitOnly",
        defaultToolExposureMode: "nativeFirst",
      },
      cards: [{
        id: "fixture-card-private",
        providerId: "fixture-provider-private",
        routeMode: "explicitOnly",
        shellxMayAutoRoute: false,
        invocation: { surface: "fixture-surface-private" },
        toolExposure: { defaultMode: "nativeFirst" },
      }],
    });
  }
  if (path === "/state/session_activity?tabId=final-surface-activity-missing-session") {
    return json(response, 200, {
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
      report: {
        schemaVersion: "shellx.sessionActivity.report.v1",
        summary: {
          total: 0,
          verified: 0,
          observed: 0,
          inferred: 0,
          changes: 0,
          readsAndSearches: 0,
          git: 0,
          commands: 0,
        },
        changes: [],
        readsAndSearches: [],
        git: [],
        commands: [],
      },
    });
  }
  if (path === "/state/skills") {
    return json(response, 200, { skills: [{ name: "fixture-skill-private", description: "fixture-skill-detail-private" }] });
  }
  if (path === "/state/subagents?maxAgeMs=1") return json(response, 200, { count: 0, subagents: [] });
  if (path === "/screenshot") {
    response.writeHead(200, { "Content-Type": "image/png" });
    return response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  }
  const sessionFixture = sessionFixtureData();
  if (path === "/sessions/history") {
    return json(response, 200, {
      sessions: [{ id: sessionFixture.id, title: sessionFixture.title, tMs: 2_001, sizeBytes: Buffer.byteLength(sessionFixture.body) }],
    });
  }
  if (path.startsWith("/sessions/search?")) {
    const query = new URL(path, "http://127.0.0.1").searchParams.get("q") ?? "";
    return json(response, 200, {
      query,
      results: query === sessionFixture.marker
        ? [{ id: sessionFixture.id, title: sessionFixture.title, mtimeMs: 2_001, matchCount: 1, snippet: sessionFixture.marker }]
        : [],
    });
  }
  if (path === `/sessions/history/${sessionFixture.id}`) {
    response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
    return response.end(sessionFixture.body);
  }
  if (path.startsWith(`/sessions/${sessionFixture.id}/snippet?`)) {
    const query = new URL(path, "http://127.0.0.1").searchParams.get("q") ?? "";
    return json(response, 200, {
      id: sessionFixture.id,
      query,
      hits: query === sessionFixture.marker
        ? [{ tMs: 2_000, around: `<mark>${sessionFixture.marker}</mark>` }]
        : [],
    });
  }
  if (path.startsWith("/state/files?")) {
    const url = new URL(path, "http://127.0.0.1");
    const segment = sourceCommit.slice(0, 16);
    const fileName = `release-file-${segment}.txt`;
    return json(response, 200, {
      tabId: url.searchParams.get("tabId"),
      path: url.searchParams.get("path"),
      connectionId: null,
      includeHidden: false,
      count: 2,
      entries: [
        { name: `release-directory-${segment}`, kind: "dir", size: 0, git_status: null },
        {
          name: fileName,
          kind: "file",
          size: Buffer.byteLength(`ShellX release Files surface ${segment}\n`),
          git_status: null,
        },
      ],
    });
  }
  if (path.startsWith("/state/github?")) {
    return json(response, 200, {
      branch: "release-proof",
      remote: null,
      ahead: null,
      behind: null,
      staged: "",
      cwd: new URL(path, "http://127.0.0.1").searchParams.get("cwd"),
    });
  }
  if (path.startsWith("/state/github/items?")) {
    return json(response, 200, { items: [] });
  }
  if (path.startsWith("/state/session_git/diff?")) {
    const segment = sourceCommit.slice(0, 16);
    const trackedName = `tracked-${segment}.txt`;
    const marker = `SHELLX_RELEASE_GIT_DIFF_${segment}`;
    const diff = `diff --git a/${trackedName} b/${trackedName}\n--- a/${trackedName}\n+++ b/${trackedName}\n@@ -1 +1,2 @@\n ShellX release Git baseline\n+${marker}\n`;
    return json(response, 200, {
      ok: true,
      scope: "head",
      repoRoot: new URL(path, "http://127.0.0.1").searchParams.get("cwd"),
      branch: "release-proof",
      diff,
      truncated: false,
      bytes: Buffer.byteLength(diff),
      lastError: null,
    });
  }
  if (path.startsWith("/state/session_git?")) {
    const url = new URL(path, "http://127.0.0.1");
    const segment = sourceCommit.slice(0, 16);
    const trackedName = `tracked-${segment}.txt`;
    const untrackedName = `untracked-${segment}.txt`;
    return json(response, 200, {
      ok: true,
      tabId: url.searchParams.get("tabId"),
      transport: "local",
      cwd: url.searchParams.get("cwd"),
      repoCwd: url.searchParams.get("cwd"),
      repoScope: "cwd",
      repoCandidates: [],
      repoRoot: url.searchParams.get("cwd"),
      repoName: `release-surface-git-${segment}`,
      branch: "release-proof",
      upstream: null,
      remote: null,
      head: "abcdef0",
      ahead: null,
      behind: null,
      clean: false,
      staged: 0,
      unstaged: 1,
      untracked: 1,
      conflicts: 0,
      deleted: 0,
      files: [
        { path: trackedName, index: " ", worktree: "M" },
        { path: untrackedName, index: "?", worktree: "?" },
      ],
      checkpoints: [],
      worktrees: [],
      lastError: null,
    });
  }
  if (path === "/vault/e2e/audit") {
    return json(response, 200, {
      ok: true,
      secretExposed: false,
      audit: vaultE2eAudit,
    });
  }
  if (path === "/outside-connectors") {
    return json(response, 200, { connectors: outsideConnectors });
  }
  if (path === "/outside-connectors/capabilities") {
    return json(response, 200, { capabilities: [{ provider: "fixture-provider-private" }] });
  }
  if (path === "/outside-connectors/events") {
    return json(response, 200, { events: [{ id: "fixture-connector-event-private", textPreview: "fixture-preview-private" }] });
  }
  if (path === "/vault/grants") {
    return json(response, 200, {
      grants: [
        {
          grantId: "fixture-grant-private",
          secretRef: "fixture-secret-ref-private",
          actorScope: '{"kind":"allShellxAgents"}',
          operation: "Fill",
          origin: "https://example.com",
          createdAtMs: 1,
          expiresAtMs: null,
          revoked: false,
          approved: false,
        },
        ...[...vaultE2eGrants.values()].map((grant) => ({
          grantId: grant.grantId,
          secretRef: grant.secretRef,
          actorScope: '{"kind":"allShellxAgents"}',
          operation: "Fill",
          origin: grant.origin,
          createdAtMs: 5_000,
          expiresAtMs: 9_999_999_999_999,
          revoked: grant.revoked || grant.expired,
          approved: grant.approved,
        })),
      ],
    });
  }
  if (requestUrl.pathname === "/vault/agent-requests") {
    const actorId = requestUrl.searchParams.get("actorId");
    const rows = actorId
      ? vaultAgentRequests.filter((candidate) => candidate.actorId === actorId)
      : vaultAgentRequests;
    return json(response, 200, {
      pendingCount: rows.filter((candidate) => candidate.status === "pending").length,
      requests: [...rows].reverse(),
      resources: [...vaultAgentResources],
    });
  }
  if (path === "/vault/keys") {
    return json(response, 200, {
      keys: vaultEntries.map((entry) => entry.key),
      entries: vaultEntries,
    });
  }
  if (path === "/vault/resources") {
    return json(response, 200, {
      ok: true,
      resources: [{ key: "fixture-resource-private", resourceKind: "secret", secretExposed: false }],
      entries: [{ key: "fixture-resource-private", resourceKind: "secret" }],
      secretExposed: false,
      visibility: "agentVisibleOnly",
      note: "Values are not returned.",
    });
  }
  if (path === "/browser/check") {
    return json(response, 200, {
      schema: "shellx/browser-quiet-check@1",
      ok: true,
      mode: "quiet",
      effects: { uiMutation: false, windowOpened: false, taskCreated: false, engineMounted: false, receiptEmitted: false },
      summary: {},
      settle: { settled: true },
    });
  }
  if (path === "/browser/bookmarks") {
    return json(response, 200, {
      bookmarks,
      bookmarkToolbar: ["fixture-bookmark-private"],
    });
  }
  if (requestUrl.pathname === "/browser/requests") {
    return json(response, 200, {
      revision: "fixture-1",
      sessionGrants: [...browserSessionGrants].reverse().map(reorderFixtureRowKeys),
      vaultDeposits: [],
      dialogs: [...browserDialogs].reverse().map(reorderFixtureRowKeys),
      permissions: [...browserPermissions].reverse().map(reorderFixtureRowKeys),
    });
  }
  if (path === "/browser/evidence") {
    return json(response, 200, {
      ok: true,
      schemas: {},
      routedActions: {},
      recent: [],
      count: 0,
      callerScoped: false,
      durableRecovered: 0,
      durableScanTruncated: false,
      durableScanFailed: false,
      durableSkipped: 0,
    });
  }
  if (requestUrl.pathname === "/browser/logs") {
    return json(response, 200, { logs: [...browserConsoleLogs].reverse().map(reorderFixtureRowKeys) });
  }
  if (requestUrl.pathname === "/browser/receipts") {
    return json(response, 200, { receipts: [...browserMonotonicReceipts].reverse() });
  }
  if (requestUrl.pathname === "/browser/downloads") {
    return json(response, 200, { downloads: [...browserDownloads].reverse().map(reorderFixtureRowKeys) });
  }
  if (requestUrl.pathname === "/browser/uploads") {
    return json(response, 200, { uploads: [...browserUploads].reverse().map(reorderFixtureRowKeys) });
  }
  if (requestUrl.pathname === "/browser/robots") {
    return json(response, 200, { robots: [...browserRobots].reverse().map(reorderFixtureRowKeys) });
  }
  if (requestUrl.pathname === "/browser/dialogs") {
    return json(response, 200, { dialogs: [...browserDialogs].reverse().map(reorderFixtureRowKeys) });
  }
  if (requestUrl.pathname === "/browser/permissions") {
    return json(response, 200, { permissions: [...browserPermissions].reverse().map(reorderFixtureRowKeys) });
  }
  if (requestUrl.pathname === "/browser/popups") {
    return json(response, 200, { popups: [...browserPopups].reverse().map(reorderFixtureRowKeys) });
  }
  const browserArrayKey: Record<string, string> = {
    "/browser/dialogs": "dialogs",
    "/browser/downloads": "downloads",
    "/browser/history": "history",
    "/browser/logs": "logs",
    "/browser/network": "entries",
    "/browser/permissions": "permissions",
    "/browser/popups": "popups",
    "/browser/receipts": "receipts",
    "/browser/robots": "robots",
    "/browser/storage-state": "profiles",
    "/browser/uploads": "uploads",
  };
  if (browserArrayKey[path]) {
    return json(response, 200, {
      [browserArrayKey[path]!]: [],
      ...(path === "/browser/history" ? { revision: "fixture-1" } : {}),
    });
  }
  const browserObjectKey: Record<string, string> = {
    "/browser/developer-mode": "developerMode",
    "/browser/personal-lock": "personalLock",
    "/browser/privacy": "privacy",
    "/browser/shields": "shields",
  };
  if (path === "/browser/engine-pool") return json(response, 200, { enginePool });
  if (browserObjectKey[path]) return json(response, 200, { [browserObjectKey[path]!]: {} });
  if (path === "/state/header") return json(response, 200, { session: {}, autonomy: "default", tabId: "default" });
  if (path === "/state/footer") {
    return json(response, 200, { events: 0, chats: 0, session: {}, ws: `ws://127.0.0.1:${address().port}/events`, tabId: "default" });
  }
  if (path === "/state/ui") {
    return json(response, 200, uiState());
  }
  if (path === "/build/state?tabId=shellx-release-safe-refusal"
  ) {
    return json(response, 200, { tabId: "shellx-release-safe-refusal", state: null });
  }
  if (path === "/goal/state?tabId=shellx-release-safe-refusal") {
    return json(response, 200, {
      tabId: "shellx-release-safe-refusal",
      state: null,
      approvalStatus: null,
      lastClear: null,
    });
  }
  if (requestUrl.pathname === "/preview/work/state" && requestUrl.searchParams.has("tabId")) {
    const tabId = String(requestUrl.searchParams.get("tabId") ?? "");
    const state = previewStates.get(tabId);
    if (state) return json(response, 200, state);
    if (tabId.startsWith("shellx-release-preview-")) return json(response, 200, idlePreviewState(tabId));
  }
  if (path === "/preview/work/state?tabId=shellx-release-safe-refusal") {
    return json(response, 200, idlePreviewState());
  }
  if (path === "/panels") return json(response, 200, panelSizes());
  if (path === "/preview") return json(response, 200, { preview: previewTarget });
  if (path === "/preview/work/state") {
    return json(response, 200, {
      tabId: "default",
      cwd: null,
      kind: null,
      status: "idle",
      url: null,
      command: null,
      taskId: null,
      pid: null,
      startedAtMs: null,
      updatedAtMs: 1,
      viewportHint: null,
      error: null,
      logs: [],
    });
  }
  if (path === "/preview/work/logs") return json(response, 200, { tabId: "default", logs: [] });
  if (path === "/preview/work/diagnose?tabId=final-surface-preview-diagnose-missing-session") {
    const tabId = "final-surface-preview-diagnose-missing-session";
    return json(response, 200, {
      tabId,
      ok: false,
      status: "failed",
      summary: "Preview Doctor found 2 error(s) and 0 warning(s).",
      url: null,
      cwd: null,
      command: null,
      httpStatus: null,
      responseBytes: null,
      title: null,
      screenshotPath: null,
      screenshotWidth: null,
      screenshotHeight: null,
      screenshotBrowser: null,
      screenshotError: null,
      issues: [
        { severity: "error", source: "preview", message: "preview status is Idle" },
        { severity: "error", source: "preview", message: "preview has no URL to inspect" },
      ],
      browserEvents: [],
      logs: [],
      state: {
        tabId,
        cwd: null,
        kind: null,
        status: "idle",
        url: null,
        command: null,
        taskId: null,
        pid: null,
        startedAtMs: null,
        updatedAtMs: 1,
        viewportHint: null,
        error: null,
        logs: [],
      },
    });
  }
  if (path === "/goal/state") {
    return json(response, 200, { tabId: "default", state: null, approvalStatus: null, lastClear: null });
  }
  if (path === "/build/state") return json(response, 200, { tabId: "default", state: null });
  if (path === "/vault/status") {
    return json(response, 200, vaultSetupStatus);
  }
  if (path === "/state/sessions") {
    const tabs = [...grokProviderTabs].map(([tabId, tab]) => ({
      tabId,
      cwd: tab.cwd,
      hasActiveChild: true,
      hasSession: true,
      sessionId: `fixture-grok-session-${tabId}`,
      isSsh: false,
      isWsl: false,
    }));
    return json(response, 200, { count: tabs.length, tabs });
  }
  if (path === "/state/tabs/report") {
    return json(response, 200, {
      generatedAtMs: 1,
      activeTabId: null,
      count: 0,
      runningCount: 0,
      finishedCount: 0,
      needsAttentionCount: 0,
      tabs: [],
    });
  }
  if (path === "/state/agent_runs") {
    return json(response, 200, {
      generatedAtMs: 1,
      activeTabId: null,
      summary: {
        runCount: 0,
        runningCount: 0,
        tabSessionCount: 0,
        providerRunCount: 0,
        shellxSubagentCount: 0,
        observedNativeSubagentCount: 0,
      },
      nativeSubagents: { visibility: "notExposed", observedCount: 0, note: "fixture" },
      runs: [],
    });
  }
  if (path === "/state/session_assets") return json(response, 200, { count: 0, assets: [], images: [], videos: [] });
  if (path === "/state/marketplace_health") return json(response, 200, { tabId: "default", entries: [] });
  if (path === "/state/session_tooling") {
    return json(response, 200, { tabId: "default", session: {}, desired: [], health: [] });
  }
  return json(response, 404, { error: "not found" });
});

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const key = request.headers["sec-websocket-key"];
  if (url.pathname !== "/events" || url.searchParams.get("token") !== token || typeof key !== "string") {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.end();
    return;
  }
  requests.push("/events?token=[redacted]");
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n",
  ].join("\r\n"));
  socket.write(webSocketTextFrame(JSON.stringify({
    t: 1,
    kind: "fixture-private-websocket-kind",
    payload: { text: "fixture-websocket-payload-private" },
  })));
  socket.on("data", (chunk: Buffer) => {
    const first = chunk[0];
    if (first === undefined || (first & 0x0f) !== 0x08) return;
    socket.write(Buffer.from([0x88, 0x00]));
    socket.end();
  });
});

server.listen(0, "127.0.0.1", () => {
  writeFileSync(stateOut, `${JSON.stringify({ port: address().port })}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function descriptor(): Record<string, unknown> {
  return {
    appVersion: version,
    buildCommit: sourceCommit,
    token: null,
    rawCdpExposed: false,
    rawCdpEndpoint: null,
    url: "/shellxagent.json",
    browserAction: "/browser/action",
    browserCheck: "/browser/check",
    browserSummary: "/browser/summary",
    browserState: "/browser/state",
    browserTabs: "/browser/tabs",
    events: "/events",
    health: "/health",
  };
}

function agentDoc(): Record<string, unknown> {
  return {
    name: "shellxagent-docs",
    activation: "session-scoped; injected only into agents launched by ShellX",
    resources: ["/agent-doc/skills/shellx-host/SKILL.md"],
  };
}

function panelSizes(): Record<string, unknown> {
  return panels;
}

function environmentSnapshot(tabId: string): Record<string, unknown> {
  return {
    tabId,
    status: "idle",
    checkedAtMs: 1,
    transport: "none",
    cwd: null,
    sessionId: null,
    doctor: null,
    inspect: null,
    setup: {
      summary: { status: "idle", readyCount: 0, attentionCount: 0, totalCount: 0 },
      checks: [],
    },
    readiness: {
      summary: { status: "idle", readyCount: 0, attentionCount: 0, totalCount: 0 },
      checks: [],
    },
    apiKeyHint: {
      preferredEnv: "XAI_API_KEY",
      legacyEnv: "GROK_CODE_XAI_API_KEY",
      preferredPresent: false,
      legacyPresent: false,
      detail: "No API-key environment variable is present.",
    },
    trace: { available: false, sessionId: null, detail: "No active session." },
    error: "No registered tab session yet.",
  };
}

function providerAdapter(providerId: string, label: string, streamKind: string): Record<string, unknown> {
  return {
    providerId,
    label,
    binaryNames: ["fixture-binary-private"],
    installed: true,
    binary: "fixture-binary-path-private",
    version: "fixture-version-private",
    canRun: true,
    streamKind,
    notes: ["fixture-provider-note-private"],
  };
}

function agentCliSetupCard(providerId: string, displayName: string): Record<string, unknown> {
  return {
    providerId,
    displayName,
    status: "ready",
    canRun: true,
    binary: "fixture-setup-binary-private",
    version: "fixture-setup-version-private",
    installable: true,
    recommendedMethodId: "fixture-method-private",
    installMethods: [{ id: "fixture-method-private", command: "fixture-install-command-private" }],
    docsUrl: "https://fixture-docs-private.invalid/",
    officialSourceUrl: "https://fixture-source-private.invalid/",
    lastVerifiedAt: "2026-07-29",
    authHint: "fixture-auth-hint-private",
  };
}

function sessionFixtureData(): { id: string; marker: string; title: string; body: string } {
  const segment = sourceCommit.slice(0, 16);
  const id = `release_session_${segment}`;
  const marker = `SHELLX_RELEASE_SESSION_CANARY_${segment}`;
  const title = `Release session history ${segment}`;
  const splitAt = Math.floor(marker.length / 2);
  const records = [
    { t: 1_000, payload: { params: { update: { sessionUpdate: "session_summary_generated", session_summary: title } } } },
    { t: 2_000, payload: { params: { update: { sessionUpdate: "agent_message_chunk", content: { text: marker.slice(0, splitAt) } } } } },
    { t: 2_001, payload: { params: { update: { sessionUpdate: "agent_message_chunk", content: { text: marker.slice(splitAt) } } } } },
  ];
  return { id, marker, title, body: `${records.map((record) => JSON.stringify(record)).join("\n")}\n` };
}

function writeBrowserArtifact(
  folder: string,
  id: string,
  createdAtMs: number,
  body: Record<string, unknown>,
): { path: string; bytes: number; sha256: string } {
  const dir = join(artifactRoot, ".shellx", "browser-artifacts", folder);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}-${createdAtMs}.json`);
  const bytes = Buffer.from(JSON.stringify(body, null, 2), "utf8");
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  return {
    path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function browserArtifactReceipt(
  kind: string,
  taskId: string,
  evidence: Record<string, unknown>,
  profileId = "task-disposable",
): Record<string, unknown> {
  return {
    receiptId: `release-browser-artifact-receipt-${browserArtifactIndex}`,
    kind,
    taskId: taskId || null,
    profileId,
    summary: "Release Browser artifact fixture",
    t: Date.now(),
    sequence: browserArtifactIndex,
    evidence,
  };
}

function monotonicReceipt(
  kind: string,
  taskId: string,
  evidence: Record<string, unknown>,
): Record<string, unknown> {
  return {
    receiptId: `release-browser-monotonic-receipt-${browserMonotonicIndex}`,
    kind,
    taskId,
    profileId: "task-disposable",
    summary: "Release Browser monotonic fixture",
    t: Date.now(),
    sequence: browserMonotonicIndex,
    evidence,
  };
}

function transferEntry(input: {
  transferId: string;
  direction: "download" | "upload";
  taskId: string;
  browserTabId: string;
  url: unknown;
  filePath: unknown;
  displayName: unknown;
  destination: unknown;
  destinationOrigin: unknown;
  refId: unknown;
  reason: unknown;
  receipt: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    transferId: input.transferId,
    direction: input.direction,
    status: "requested",
    taskId: input.taskId,
    browserTabId: input.browserTabId,
    url: input.url,
    filePath: input.filePath,
    displayName: input.displayName,
    finalPath: null,
    mimeType: null,
    contentKind: null,
    bytes: null,
    sha256: null,
    sourceUrl: null,
    destination: input.destination,
    retentionReason: null,
    approvalId: null,
    destinationOrigin: input.destinationOrigin,
    refId: input.refId,
    reason: input.reason,
    requestedAtMs: Date.now(),
    completedAtMs: null,
    receipt: input.receipt,
  };
}

function tabMutationResponse(
  kind: string,
  taskId: string,
  browserTabId: string,
  lock: Record<string, unknown> | null,
  url?: unknown,
): Record<string, unknown> {
  browserMonotonicIndex += 1;
  return {
    ok: true,
    tab: browserTabState(taskId, browserTabId, lock, url),
    receipt: monotonicReceipt(kind, taskId, {
      browserTabId,
      leaseId: lock?.leaseId ?? null,
    }),
  };
}

function browserTabState(
  taskId: string,
  browserTabId: string,
  lock: Record<string, unknown> | null,
  url?: unknown,
): Record<string, unknown> {
  return {
    browserTabId,
    taskId,
    profileId: "task-disposable",
    status: "ready",
    lock,
    ...(typeof url === "string" ? { url } : {}),
  };
}

function address(): { port: number } {
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("fixture server is not listening");
  return { port: value.port };
}

async function simulateReleaseRelayRenderer(id: string, nonce: string): Promise<void> {
  const base = `http://127.0.0.1:${address().port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const claim = await fetch(`${base}/release-test/tauri-invokes/${id}/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({ nonce }),
  });
  if (!claim.ok) throw new Error(`relay fixture claim failed ${claim.status}`);
  const claimed = await claim.json() as Record<string, unknown>;
  if (claimed.id !== id || claimed.command !== "get_debug_port" || !isRecord(claimed.args)) {
    throw new Error("relay fixture claim drifted from the owned command");
  }
  const complete = await fetch(`${base}/release-test/tauri-invokes/${id}/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ nonce, status: "passed", value: address().port }),
  });
  if (!complete.ok) throw new Error(`relay fixture completion failed ${complete.status}`);
}

function releaseRelayPoll(
  id: string,
  state: { status: "pending" | "claimed" | "passed"; value?: unknown },
): Record<string, unknown> {
  return {
    id,
    status: state.status,
    ...(state.status === "passed" ? { value: state.value ?? null } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function text(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  response.writeHead(status, { "Content-Type": contentType });
  response.end(body);
}

function uiState(): Record<string, unknown> {
  return {
    panels: panelSizes(),
    preview: previewTarget,
    autonomy: null,
    bottomTab: uiBottomTab,
    leftTab: null,
    rightTab: null,
    activeTabId: null,
    activeTab: null,
    openTabs: [],
    debugHighlights: uiDebugHighlights,
    debugHighlightResults: [],
    debugHighlightResultsBySurface: uiDebugHighlightResultsBySurface,
    debugActionResults: [],
    composerMenu: null,
    openModal: uiOpenModal,
    vaultRequestCenterOpen: null,
    setupGuideDismissed: null,
    debugClick: null,
    debugInput: null,
    debugDrag: null,
    debugSurface: null,
    clickSelector: null,
    cwdPicker: null,
    uiRevision,
    lastUiPatchMs,
    lastUiPatchSource,
  };
}

function vaultBaselineStatus(): Record<string, unknown> {
  return {
    mode: "unconfigured",
    unlocked: false,
    recoveryConfirmed: false,
    rememberedDeviceEnabled: true,
    legacyVaultDetected: false,
    activeGrants: 0,
    pendingDeposits: 0,
    syncPending: false,
    lastError: null,
  };
}

function idlePreviewState(tabId = "shellx-release-safe-refusal"): Record<string, unknown> {
  return {
    tabId,
    cwd: null,
    kind: null,
    status: "idle",
    url: null,
    command: null,
    taskId: null,
    pid: null,
    startedAtMs: null,
    updatedAtMs: Date.now(),
    viewportHint: null,
    error: null,
    logs: [],
  };
}

function bookmarkReceipt(kind: string): Record<string, unknown> {
  bookmarkReceiptIndex += 1;
  return {
    receiptId: `fixture-bookmark-receipt-${bookmarkReceiptIndex}`,
    kind,
    taskId: null,
    profileId: null,
    summary: "fixture Browser bookmark mutation",
    t: bookmarkReceiptIndex,
    sequence: bookmarkReceiptIndex,
    evidence: {},
  };
}

function vaultE2eReceipt(
  action: string,
  fields: Partial<Record<"secretRef" | "grantId" | "decision" | "reason" | "secretPresent", unknown>> = {},
): Record<string, unknown> {
  vaultE2eReceiptIndex += 1;
  const receipt = {
    receiptId: `vault-e2e-fixture-${vaultE2eReceiptIndex}`,
    action,
    secretRef: fields.secretRef ?? null,
    grantId: fields.grantId ?? null,
    decision: fields.decision ?? null,
    reason: fields.reason ?? null,
    secretPresent: fields.secretPresent ?? null,
    secretExposed: false,
    t: 4_000 + vaultE2eReceiptIndex,
  };
  vaultE2eAudit.push(receipt);
  return receipt;
}

function operatorGateForRequest(method: string, path: string): {
  code: string;
  message: string;
  shape: "nested" | "flat-error" | "flat-code-error";
  status: number;
} | null {
  if (method === "POST" && path === "/browser/privacy") {
    return {
      code: "browser_privacy_requires_operator",
      message: "Browser privacy and ad-blocking changes must be performed by the ShellX operator UI",
      shape: "nested",
      status: 403,
    };
  }
  if (method === "POST" && path === "/browser/personal-lock") {
    return {
      code: "browser_personal_lock_requires_operator",
      message: "Personal Browser Lock changes must be performed by the ShellX operator UI",
      shape: "nested",
      status: 403,
    };
  }
  if ((method === "POST" && (path === "/browser/shields" || path === "/browser/shields/site"))
    || (method === "DELETE" && path === "/browser/shields/site/release-surface.invalid")) {
    return {
      code: "browser_shields_requires_operator",
      message: "Browser Shields changes must be performed by the ShellX operator UI",
      shape: "nested",
      status: 403,
    };
  }
  if (method === "POST" && (path === "/browser/developer-mode" || path === "/browser/developer-mode/approval")) {
    return {
      code: "developer_mode_requires_operator",
      message: "Browser Developer Mode changes must be performed by the ShellX operator UI",
      shape: "nested",
      status: 403,
    };
  }
  if (method === "POST" && (path === "/browser/dialogs/resolve" || path === "/browser/permissions/resolve")) {
    return {
      code: "browser_prompt_resolution_requires_operator",
      message: "Browser dialog and permission decisions must be performed by the ShellX operator UI",
      shape: "flat-error",
      status: 400,
    };
  }
  if (method === "POST" && path === "/browser/session-grants/resolve") {
    return {
      code: "browser_session_grant_resolution_requires_operator",
      message: "Browser session grant decisions must be performed by the ShellX operator UI",
      shape: "flat-code-error",
      status: 403,
    };
  }
  if (method === "POST" && path === "/browser/task/autonomy") {
    return {
      code: "browser_task_autonomy_policy_fixed",
      message: "Browser task autonomy is fixed to assistedAutonomous and cannot be changed after task creation",
      shape: "flat-code-error",
      status: 403,
    };
  }
  return null;
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const parsed = await requestJsonValue(request);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("fixture request must be an object");
  return parsed as Record<string, unknown>;
}

async function handleGitCheckpointFixture(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await requestJson(request);
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const tabId = typeof body.tabId === "string" ? body.tabId : "";
  const label = typeof body.label === "string" ? body.label : "";
  if (!cwd || !tabId || !label || !existsSync(cwd)) return json(response, 400, { error: "invalid Git checkpoint fixture" });
  const createdAtMs = Date.now();
  const id = `${createdAtMs}-shellx-release-checkpoint-${sourceCommit.slice(0, 16)}`;
  const checkpointPath = join(artifactRoot, ".shellx", "git-checkpoints", "fixture-owned-repo", tabId, id);
  const untrackedDir = join(checkpointPath, "untracked");
  mkdirSync(untrackedDir, { recursive: true, mode: 0o700 });
  const trackedName = `tracked-${sourceCommit.slice(0, 16)}.txt`;
  const untrackedName = `untracked-${sourceCommit.slice(0, 16)}.txt`;
  const untrackedBody = readFileSync(join(cwd, untrackedName));
  writeFileSync(join(untrackedDir, untrackedName), untrackedBody, { mode: 0o600 });
  const manifestPath = join(checkpointPath, "untracked.json");
  writeFileSync(manifestPath, `${JSON.stringify({ entries: [{ path: untrackedName, bytes: untrackedBody.byteLength }] }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(checkpointPath, "unstaged.patch"), `diff --git a/${trackedName} b/${trackedName}\n`, { mode: 0o600 });
  writeFileSync(join(checkpointPath, "staged.patch"), "", { mode: 0o600 });
  writeFileSync(join(checkpointPath, "status.txt"), `## release-proof\n M ${trackedName}\n?? ${untrackedName}\n`, { mode: 0o600 });
  const head = gitFixtureOutput(cwd, ["rev-parse", "HEAD"]).trim();
  const checkpoint = {
    id,
    label,
    createdAtMs,
    branch: "release-proof",
    head,
    repoRoot: cwd,
    path: checkpointPath,
    staged: 0,
    unstaged: 1,
    untracked: 1,
    conflicts: 0,
    worktreeFingerprint: createHash("sha256").update(`${head}:${sourceCommit}`).digest("hex"),
    untrackedSnapshot: {
      files: 1,
      captured: 1,
      skipped: 0,
      bytes: untrackedBody.byteLength,
      truncated: false,
      manifestPath,
    },
  };
  writeFileSync(join(checkpointPath, "checkpoint.json"), `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  json(response, 200, { ok: true, checkpoint, lastError: null });
}

async function handleGitWorktreeFixture(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await requestJson(request);
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const sourceBranch = typeof body.sourceBranch === "string" ? body.sourceBranch : "";
  const newBranch = typeof body.newBranch === "string" ? body.newBranch : "";
  if (!cwd || sourceBranch !== "release-proof" || !newBranch || !existsSync(cwd)) {
    return json(response, 400, { error: "invalid Git worktree fixture" });
  }
  const worktreePath = join(cwd, ".worktrees", newBranch);
  mkdirSync(join(cwd, ".worktrees"), { recursive: true, mode: 0o700 });
  const output = gitFixtureOutput(cwd, ["worktree", "add", "-b", newBranch, worktreePath, sourceBranch]);
  json(response, 200, { ok: true, sourceBranch, newBranch, worktreePath, output, lastError: null });
}

function gitFixtureOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) throw new Error(`fixture Git command failed with status ${result.status ?? "unknown"}`);
  return result.stdout.trim() || result.stderr.trim();
}

function reorderFixtureRowKeys(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right)));
}

async function requestJsonValue(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 64 * 1024) throw new Error("fixture request is too large");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function webSocketTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.allocUnsafe(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  throw new Error("fixture WebSocket payload exceeded its bounded frame size");
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function isFixtureAbsoluteProgram(value: string): boolean {
  return fixturePlatform === "windows" ? /^[A-Za-z]:[\\/]/.test(value) : value.startsWith("/");
}
