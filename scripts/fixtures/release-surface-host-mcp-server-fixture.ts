import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import {
  HOST_MCP_CAPTURE_FIXTURE_VALUE,
} from "../release-drivers/host-mcp-vault-lifecycle";

const args = process.argv.slice(2);
const stateOut = requiredArg(args, "--state-out");
const debugToken = requiredArg(args, "--debug-token");
const mcpToken = requiredArg(args, "--mcp-token");
const instanceId = requiredArg(args, "--instance-id");
const processId = Number(requiredArg(args, "--process-id"));
const version = requiredArg(args, "--version");
const sourceCommit = requiredArg(args, "--source-commit");
const profileRoot = requiredArg(args, "--profile-root");
const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
const memory = new Map<string, string>();
const generatedVaultItems = new Set<string>();
const vaultResources = new Map<string, {
  value: string;
  resourceKind: string;
  resourceSummary: string;
  resourceProvider: string;
  resourceFields: string[];
}>();
const vaultGrants = new Map<string, { resourceRef: string; operation: string; origin: string }>();
const vaultAudit: Record<string, unknown>[] = [];
const browserReceipts: Record<string, unknown>[] = [];
let vaultResetCount = 0;
let browserReceiptSequence = 0;
const activeTabId = "fixture-active-tab-035";
let rendererTabOpen = false;
let autonomy = "default";
let browserTask: {
  taskId: string;
  browserTabId: string;
  status: string;
  currentUrl: string;
  ownerSessionId: string;
} | null = null;
let browserTabOpen = false;
let browserTaskStarts = 0;
const browserFormValues = new Map<string, string>();
let browserCoordinateReady = false;
let activeWatchId: string | null = null;
let previewState: Record<string, unknown> | null = null;
const EXPECTED_TOOL_ERRORS = new Map<string, string>([
  ["Agent", "Agent: missing 'subagent_type'"],
  ["Agent_kill", "Agent_kill: bad subagent_id 'shellx-release-missing-agent': invalid UUID"],
  ["Agent_output", "Agent_output: bad subagent_id 'shellx-release-missing-agent': invalid UUID"],
  ["Agent_status", "Agent_status: bad subagent_id 'shellx-release-missing-agent': invalid UUID"],
  ["browser_evaluation_write", "browser_evaluation_write: missing taskId"],
  ["browser_resolve_dialog", "browser_resolve_dialog: missing dialogId"],
  ["browser_workflow_replay", "browser_workflow_replay requires recipePath or bookmarkId with recipePath"],
  ["browser_workflow_save", "browser_workflow_save requires label"],
  ["build_checkpoint", "build_checkpoint: not inside a git repository"],
  ["build_complete", "no active /build run for this tab"],
  ["build_receipt", "build_receipt: no active /build run for this tab"],
  ["goal_complete", "goal_complete: no /goal active for this tab"],
  ["process_attach_stdout", "unknown taskId: shellx-release-missing-process"],
  ["process_signal", "unknown taskId: shellx-release-missing-process"],
  ["process_stats", "unknown taskId: shellx-release-missing-process"],
  ["secret_delete", "secret_delete: removing pass-store entries from an agent context is refused"],
  ["secret_set", "secret_set: writing to the pass-store from an agent context is refused"],
  ["send_prompt_to_provider", "send_prompt_to_provider requires userApproved=true from an explicit user provider handoff request"],
  ["send_prompt_to_session", "send_prompt_to_session requires userApproved=true from an explicit user handoff request"],
  ["vault_request_grant", "vault_request_grant refuses rawReveal; ask the user to handle plaintext directly"],
  ["vision_describe", "vision_describe: empty path"],
  ["vision_describe_v2", "vision_describe: empty path"],
  ["voice_stt_v2", "voice_stt_v2: missing 'audio_path'"],
  ["voice_tts", "voice_tts: text is empty"],
  ["x_search", "x_search: query is empty"],
]);

const debugServer = createServer((request, response) => {
  void handleDebug(request, response).catch((error) => {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

async function handleDebug(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.url === "/health" && request.method === "GET") {
    return json(response, 200, {
      ok: true,
      processId,
      instanceId,
      appVersion: version,
      buildCommit: sourceCommit,
      debugApiPort: address(debugServer).port,
    });
  }
  if (url.pathname === "/preview-fixture/release-preview.html" && request.method === "GET") {
    if (previewState?.status !== "running"
      || previewState.url !== `http://127.0.0.1:${address(debugServer).port}${url.pathname}`) {
      return text(response, 404, "preview stopped");
    }
    return text(
      response,
      200,
      "<!doctype html><title>ShellX release Preview</title><main>SHELLX_RELEASE_OWNED_STATIC_PREVIEW_035</main><script data-shellx-preview-doctor></script>\n",
      "text/html; charset=utf-8",
    );
  }
  if (request.headers.authorization !== `Bearer ${debugToken}`) return json(response, 401, { error: "unauthorized" });
  if (url.pathname === "/browser/state" && request.method === "GET") {
    return json(response, 200, {
      ok: true,
      activeTaskId: browserTask?.status === "running" ? browserTask.taskId : null,
      tasks: browserTask ? [{ taskId: browserTask.taskId, status: browserTask.status }] : [],
      tabs: browserTask && browserTabOpen
        ? [{ browserTabId: browserTask.browserTabId, taskId: browserTask.taskId }]
        : [],
      receipts: browserReceipts,
    });
  }
  if (url.pathname === "/browser/task/start" && request.method === "POST") {
    if (request.headers["x-shellx-mcp-caller-id"] !== activeTabId) {
      return json(response, 403, { error: "missing exact Browser caller identity" });
    }
    const body = await readJson(request);
    browserTaskStarts += 1;
    browserTask = {
      taskId: "fixture-browser-act-task-private",
      browserTabId: "fixture-browser-act-tab-private",
      status: "running",
      currentUrl: String(body.startUrl ?? ""),
      ownerSessionId: activeTabId,
    };
    browserTabOpen = true;
    return json(response, 200, {
      taskId: browserTask.taskId,
      profileId: body.profileId,
      status: browserTask.status,
      currentUrl: browserTask.currentUrl,
      ownerSessionId: browserTask.ownerSessionId,
    });
  }
  if (url.pathname === "/browser/settle" && request.method === "GET") {
    const taskId = url.searchParams.get("taskId");
    return json(response, 200, { settled: taskId === browserTask?.taskId, taskId });
  }
  if (url.pathname === "/browser/task/finish" && request.method === "POST") {
    const body = await readJson(request);
    if (!browserTask || body.taskId !== browserTask.taskId) return json(response, 404, { error: "task not found" });
    browserTask.status = String(body.status ?? "aborted");
    return json(response, 200, { taskId: browserTask.taskId, status: browserTask.status });
  }
  if (url.pathname === "/browser/tabs/close" && request.method === "POST") {
    const body = await readJson(request);
    if (!browserTask || body.browserTabId !== browserTask.browserTabId) return json(response, 404, { error: "tab not found" });
    browserTabOpen = false;
    return json(response, 200, { ok: true, tab: { browserTabId: browserTask.browserTabId, status: "closed" } });
  }
  if (url.pathname === "/state/ui" && request.method === "GET") {
    return json(response, 200, {
      releaseTestInstance: true,
      autonomy,
      activeTabId: rendererTabOpen ? activeTabId : null,
      activeTab: rendererTabOpen ? { tabId: activeTabId, autonomy, cwd: "" } : null,
      openTabs: rendererTabOpen ? [{ tabId: activeTabId, title: "Fixture" }] : [],
    });
  }
  if (url.pathname === "/state/ui" && request.method === "POST") {
    const body = await readJson(request);
    if (body.debugClick === "[aria-label='New session']") {
      if (rendererTabOpen) return json(response, 409, { error: "renderer fixture already has an open tab" });
      rendererTabOpen = true;
      return json(response, 200, {
        releaseTestInstance: true,
        autonomy,
        activeTabId,
        activeTab: { tabId: activeTabId, autonomy, cwd: "" },
        openTabs: [{ tabId: activeTabId, title: "Fixture" }],
      });
    }
    return json(response, 400, { error: "unsupported renderer fixture action" });
  }
  if (url.pathname === "/autonomy" && request.method === "POST") {
    const body = await readJson(request);
    const tabId = String(url.searchParams.get("tabId") ?? body.tabId ?? "");
    const mode = String(body.mode ?? "");
    if (tabId !== activeTabId || !["default", "bypassPermissions"].includes(mode)) {
      return json(response, 400, { error: "invalid autonomy fixture request" });
    }
    autonomy = mode;
    return json(response, 200, { ok: true, mode, tabId, appliesAfterReconnect: false });
  }
  if (url.pathname === "/vault/e2e/reset" && request.method === "POST") {
    vaultResources.clear();
    vaultGrants.clear();
    vaultAudit.length = 0;
    vaultResetCount += 1;
    const receipt = vaultAuditReceipt("vaultE2eReset");
    return json(response, 200, { ok: true, receipt });
  }
  if (url.pathname === "/vault/set" && request.method === "POST") {
    const body = await readJson(request);
    const key = String(body.key ?? "");
    const value = String(body.value ?? "");
    if (!key || !value) return json(response, 400, { error: "fixture Vault resource requires key and value" });
    vaultResources.set(key, {
      value,
      resourceKind: String(body.resourceKind ?? "secret"),
      resourceSummary: String(body.resourceSummary ?? ""),
      resourceProvider: String(body.resourceProvider ?? ""),
      resourceFields: Array.isArray(body.resourceFields) ? body.resourceFields.map(String) : [],
    });
    return json(response, 200, { ok: true, key });
  }
  if (url.pathname === "/vault/e2e/approve-grant" && request.method === "POST") {
    const body = await readJson(request);
    const resourceRef = String(body.secretRef ?? "");
    const operation = String(body.operation ?? "");
    const origin = String(body.origin ?? "");
    const expectedOrigin = browserTask ? new URL(browserTask.currentUrl).origin : "";
    if (!vaultResources.has(resourceRef) || !expectedOrigin || origin !== expectedOrigin) {
      return json(response, 400, { error: "fixture resource or browser origin not found" });
    }
    const grantId = `fixture-owned-vault-grant-${vaultGrants.size + 1}`;
    vaultGrants.set(grantId, { resourceRef, operation, origin });
    const receipt = vaultAuditReceipt("vaultE2eGrantApproved", resourceRef, grantId);
    return json(response, 200, {
      ok: true,
      grant: {
        grantId,
        secretRef: resourceRef,
        actorScope: "allShellxAgents",
        operation: operation === "emailCodeRead" ? "EmailCodeRead" : "AgentWalletUse",
        origin,
        createdAtMs: Date.now(),
        expiresAtMs: body.expiresAtMs,
        revoked: false,
        approved: true,
      },
      secretExposed: false,
      receipt,
    });
  }
  if (url.pathname === "/vault/e2e/probe-use" && request.method === "POST") {
    const body = await readJson(request);
    const resourceRef = String(body.secretRef ?? "");
    const grantId = typeof body.grantId === "string" ? body.grantId : null;
    const operation = String(body.operation ?? "");
    const actor = body.actor && typeof body.actor === "object" && !Array.isArray(body.actor)
      ? body.actor as Record<string, unknown> : null;
    const grant = grantId ? vaultGrants.get(grantId) : undefined;
    const allowed = Boolean(grant && grant.resourceRef === resourceRef && grant.operation === operation
      && actor?.origin === grant.origin);
    const receipt = vaultAuditReceipt("vaultE2eSecretUseProbed", resourceRef, grantId);
    return json(response, 200, {
      ok: allowed,
      decision: allowed ? "allowMediated" : "deny",
      reason: allowed ? null : "grantNotFound",
      secretRef: resourceRef,
      operation,
      actor: body.actor ?? {},
      grantId,
      secretPresent: vaultResources.has(resourceRef),
      secretExposed: false,
      receiptId: receipt.receiptId,
    });
  }
  if (url.pathname === "/vault/resources" && request.method === "GET") {
    const prefix = url.searchParams.get("prefix") ?? "";
    const resources = [...vaultResources.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, resource]) => ({
        key,
        resourceKind: resource.resourceKind,
        resourceSummary: resource.resourceSummary,
        resourceProvider: resource.resourceProvider,
        resourceFields: resource.resourceFields,
      }));
    return json(response, 200, { ok: true, resources, count: resources.length, secretExposed: false });
  }
  if (url.pathname === "/vault/e2e/audit" && request.method === "GET") {
    return json(response, 200, { ok: true, secretExposed: false, audit: vaultAudit });
  }
  if (url.pathname === "/preview/work/state" && request.method === "GET") {
    const tabId = String(url.searchParams.get("tabId") ?? "");
    return json(response, 200, previewState?.tabId === tabId ? previewState : idlePreviewState(tabId));
  }
  if (url.pathname === "/preview/work/stop" && request.method === "POST") {
    const body = await readJson(request);
    const tabId = String(url.searchParams.get("tabId") ?? body.tabId ?? "");
    if (!previewState || previewState.tabId !== tabId) return json(response, 200, idlePreviewState(tabId));
    previewState.status = "stopped";
    previewState.url = null;
    previewState.taskId = null;
    previewState.pid = null;
    previewState.error = null;
    previewState.updatedAtMs = Date.now();
    (previewState.logs as Array<Record<string, unknown>>).push({
      t: Date.now(),
      stream: "system",
      line: "preview stopped by shellX",
    });
    return json(response, 200, previewState);
  }
  if (url.pathname === "/audit" && request.method === "GET") {
    return json(response, 200, {
      calls,
      autonomy,
      rendererTabOpen,
      browserTaskStatus: browserTask?.status ?? null,
      browserTabOpen,
      browserTaskStarts,
      memoryCount: memory.size,
      vaultResourceCount: vaultResources.size,
      vaultGrantCount: vaultGrants.size,
      vaultResetCount,
      browserReceiptKinds: browserReceipts.map((receipt) => receipt.kind),
      previewStatus: previewState?.status ?? null,
      previewUrl: previewState?.url ?? null,
    });
  }
  return json(response, 404, { error: "not found" });
}

const mcpServer = createServer((request, response) => {
  void handleMcp(request, response).catch((error) => {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

await listen(debugServer);
await listen(mcpServer);
writeFileSync(stateOut, `${JSON.stringify({
  debugPort: address(debugServer).port,
  mcpPort: address(mcpServer).port,
})}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });

async function handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.url === "/health" && request.method === "GET") {
    return json(response, 200, {
      ok: true,
      processId,
      instanceId,
      appVersion: version,
      buildCommit: sourceCommit,
      mcpPort: address(mcpServer).port,
      mcp_port: address(mcpServer).port,
      tokenSource: "fixture",
    });
  }
  if (request.url !== "/mcp" || request.method !== "POST") return json(response, 404, { error: "not found" });
  const body = await readJson(request);
  const id = body.id;
  if (body.jsonrpc !== "2.0" || typeof id !== "string") return json(response, 400, { error: "invalid JSON-RPC" });
  if (body.method === "tools/list") {
    if (request.headers.authorization !== `Bearer ${mcpToken}`) return json(response, 401, { error: "unauthorized" });
    return json(response, 200, rpcResult(id, {
      tools: ["capabilities_summary", "search_tool", "host_read", "host_act", "browser_read", "browser_act", "cut_read", "cut_act"]
        .map((name) => ({ name, inputSchema: { type: "object", properties: {} } })),
    }));
  }
  if (body.method !== "tools/call" || !isRecord(body.params)) {
    return json(response, 200, rpcError(id, "unsupported method"));
  }
  const name = body.params.name;
  const toolArgs = isRecord(body.params.arguments) ? body.params.arguments : {};
  if (typeof name !== "string") return json(response, 200, rpcError(id, "missing tool name"));
  if (isMutationTool(name)) {
    const tabId = String(request.headers["mcp-tab-id"] ?? "");
    const expectedToken = deriveTabBoundToken(mcpToken, tabId);
    if (tabId !== activeTabId || request.headers.authorization !== `Bearer ${expectedToken}`) {
      return json(response, 401, { error: "write requires exact tab-bound token" });
    }
    if (autonomy !== "bypassPermissions") {
      return json(response, 200, rpcError(id, "write requires Auto autonomy"));
    }
  } else if (request.headers.authorization !== `Bearer ${mcpToken}`) {
    return json(response, 401, { error: "unauthorized" });
  }
  calls.push({ name, arguments: toolArgs });
  const expectedError = name === "secret_delete" && !String(toolArgs.key ?? toolArgs.path ?? "").startsWith("pass:")
    ? undefined
    : EXPECTED_TOOL_ERRORS.get(name);
  if (expectedError) {
    return json(response, 200, rpcResult(id, {
      content: [{ type: "text", text: expectedError }],
      isError: true,
    }));
  }
  const structuredContent = dispatchTool(name, toolArgs, String(request.headers["mcp-tab-id"] ?? ""));
  if (name === "browser_use_agent_wallet") {
    return json(response, 200, rpcResult(id, {
      content: [{
        type: "text",
        text: `debug-api POST /browser/action returned 501 Not Implemented: ${JSON.stringify(structuredContent)}`,
      }],
      isError: true,
    }));
  }
  const structuredFailure = name === "preview_diagnose";
  return json(response, 200, rpcResult(id, {
    content: [{
      type: "text",
      text: structuredFailure ? String(structuredContent.summary ?? "") : `${name} fixture result`,
    }],
    structuredContent,
    isError: structuredFailure,
  }));
}

function dispatchTool(name: string, toolArgs: Record<string, unknown>, callerTabId: string): Record<string, unknown> {
  if (name === "host_read") {
    const action = String(toolArgs.action ?? "");
    const params = isRecord(toolArgs.params) ? toolArgs.params : {};
    return dispatchTool(action, params, callerTabId);
  }
  if (name === "host_act") {
    const action = String(toolArgs.action ?? "");
    const params = isRecord(toolArgs.params) ? toolArgs.params : {};
    return dispatchTool(action, params, callerTabId);
  }
  if (name === "browser_read") {
    if (toolArgs.action !== "tabs") throw new Error("fixture browser_read supports only action=tabs");
    return {
      tabs: [{ browserTabId: "fixture-private-browser-tab", status: "ready" }],
      activeBrowserTabId: "fixture-private-browser-tab",
    };
  }
  if (name === "browser_act") {
    if (toolArgs.action !== "navigate" || !browserTask || toolArgs.taskId !== browserTask.taskId) {
      throw new Error("fixture browser_act requires the exact owned navigation task");
    }
    browserTask.currentUrl = String(toolArgs.url ?? "");
    return {
      ok: true,
      status: "applied",
      taskId: browserTask.taskId,
      currentUrl: browserTask.currentUrl,
      receipt: { kind: "fixtureBrowserNavigated" },
    };
  }
  if (name === "cut_read") {
    if (toolArgs.action !== "status") throw new Error("fixture cut_read supports only action=status");
    return {
      ok: true,
      result: { schema: "shellx-cut/doctor/1", essential_ok: true, cards: [] },
    };
  }
  if (name === "cut_act") {
    if (toolArgs.verb !== "system_doctor") throw new Error("fixture cut_act supports only system_doctor");
    return {
      ok: true,
      result: { schema: "shellx-cut/doctor/1", essential_ok: true, cards: [] },
    };
  }
  if (name === "browser_navigate") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) throw new Error("fixture browser_navigate requires exact task");
    browserTask.currentUrl = String(toolArgs.url ?? "");
    return { ok: true, status: "applied", taskId: browserTask.taskId, currentUrl: browserTask.currentUrl };
  }
  if (name === "browser_clear_site_data") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) throw new Error("fixture browser_clear_site_data requires exact task");
    return {
      ok: true,
      status: "applied",
      taskId: browserTask.taskId,
      currentUrl: browserTask.currentUrl,
      message: "site application data recovery applied: origin storage cleared; cookies preserved; page reload requested",
    };
  }
  if (name === "browser_click_at") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) throw new Error("fixture browser_click_at requires exact task");
    browserCoordinateReady = true;
    return { ok: true, status: "applied", taskId: browserTask.taskId };
  }
  if (name === "browser_click_ref") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId || toolArgs.selector !== "#advance") {
      throw new Error("fixture browser_click_ref requires exact task and selector");
    }
    return { ok: true, status: "applied", taskId: browserTask.taskId };
  }
  if (name === "browser_fill_ref") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) throw new Error("fixture browser_fill_ref requires exact task");
    browserFormValues.set(String(toolArgs.selector ?? ""), String(toolArgs.value ?? ""));
    return { ok: true, status: "applied", taskId: browserTask.taskId };
  }
  if (name === "browser_type_text") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) throw new Error("fixture browser_type_text requires exact task");
    browserFormValues.set("#coordinate-input", String(toolArgs.value ?? ""));
    return { ok: true, status: "applied", taskId: browserTask.taskId };
  }
  if (name === "browser_wait_for") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) throw new Error("fixture browser_wait_for requires exact task");
    const value = String(toolArgs.value ?? "");
    const selector = String(toolArgs.selector ?? "");
    const matched = selector === "#capturable-secret" || value === "Action target ready"
      || (value === "Coordinate click ready" && browserCoordinateReady);
    return { ok: matched, status: matched ? "applied" : "notFound", taskId: browserTask.taskId };
  }
  if (name === "browser_observe") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) throw new Error("fixture browser_observe requires exact task");
    return {
      ok: true,
      taskId: browserTask.taskId,
      structuredResponseBytes: 1_024,
      observation: {
        text: "fixture-private-page-text",
        refs: [{
          refId: "secret-fixture-captured",
          selector: "#capturable-secret",
          action: "capturePageSecretToVault",
        }],
        formFields: [
          { selector: "#name", value: browserFormValues.get("#name") ?? "" },
          { selector: "#coordinate-input", value: browserFormValues.get("#coordinate-input") ?? "" },
        ],
      },
    };
  }
  if (name === "browser_extract") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) throw new Error("fixture browser_extract requires exact task");
    return { ok: true, taskId: browserTask.taskId, extractedText: "Action target ready — fixture-private-page-text" };
  }
  if (name === "browser_flight_recorder_export") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) throw new Error("fixture browser_flight_recorder_export requires exact task");
    const artifact = writeFixtureArtifact("flight-recorder.json", "fixture-owned-flight-recorder\n");
    return {
      attemptId: "browser-attempt-release-fixture",
      taskId: browserTask.taskId,
      path: artifact.path,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      events: 1,
      receipts: 1,
      evidenceComplete: true,
      receipt: { kind: "browserFlightRecorderExported" },
    };
  }
  if (name === "browser_save_page") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) throw new Error("fixture browser_save_page requires exact task");
    const destinationDir = String(toolArgs.destinationDir ?? "");
    const fileName = String(toolArgs.fileName ?? "");
    if (!destinationDir || fileName !== "owned-host-mcp-page.txt") throw new Error("fixture browser_save_page requires exact owned destination");
    mkdirSync(destinationDir, { recursive: true });
    const path = join(destinationDir, fileName);
    const content = "Action target ready — fixture-owned saved page\n";
    writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return {
      ok: true,
      status: "saved",
      format: "text",
      artifact: {
        finalPath: path,
        displayName: fileName,
        mimeType: "text/plain",
        bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
      source: { title: "fixture-private-page-title" },
    };
  }
  if (name === "browser_screenshot") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) throw new Error("fixture browser_screenshot requires exact task");
    const artifact = writeFixtureArtifact("screenshot.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    return {
      ok: true,
      status: "applied",
      taskId: browserTask.taskId,
      screenshot: { ...artifact, width: 1, height: 1, fullPage: false },
      receipt: { kind: "browserScreenshotCaptured" },
    };
  }
  if (name === "browser_trace_open") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) throw new Error("fixture browser_trace_open requires exact task");
    const artifact = writeFixtureArtifact("trace.json", "fixture-owned-redacted-trace\n");
    return {
      traceId: "browser-trace-release-fixture",
      taskId: browserTask.taskId,
      ...artifact,
      receipt: { kind: "browserTraceBundleExported" },
    };
  }
  if (name === "browser_verify") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) throw new Error("fixture browser_verify requires exact task");
    return { ok: true, taskId: browserTask.taskId, verification: { passed: true, detail: "fixture-private-verification" } };
  }
  if (name === "browser_run_steps") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) throw new Error("fixture browser_run_steps requires exact task");
    return {
      ok: true,
      taskId: browserTask.taskId,
      stepsPlanned: 2,
      stepsRun: 2,
      stepsSucceeded: 2,
      stepsFailed: 0,
      results: [{ detail: "fixture-private-step" }],
    };
  }
  if (name === "browser_capture_secret_to_vault") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId || toolArgs.refId !== "secret-fixture-captured") {
      throw new Error("fixture browser_capture_secret_to_vault requires the exact owned task and redacted ref");
    }
    const secretRef = String(toolArgs.secretRef ?? "");
    if (!secretRef) throw new Error("fixture browser_capture_secret_to_vault requires secretRef");
    const depositId = "browser-deposit-owned-vault-fixture";
    const vaultRef = `browser-deposits/shellx-release-${instanceId}-vault-${depositId}`;
    vaultResources.set(vaultRef, {
      value: HOST_MCP_CAPTURE_FIXTURE_VALUE,
      resourceKind: "secret",
      resourceSummary: "Owned captured Browser secret",
      resourceProvider: "browser",
      resourceFields: [],
    });
    const storageCommitHash = createHash("sha256")
      .update(`fixture-capture\0${secretRef}\0${HOST_MCP_CAPTURE_FIXTURE_VALUE}`)
      .digest("hex");
    const receipt = pushBrowserReceipt(
      "browserVaultDepositCreated",
      browserTask.taskId,
      {
        depositId,
        label: secretRef,
        storageCommitHash,
        sourceUrl: browserTask.currentUrl,
        secretExposed: false,
        vaultRef,
        vaultWriteCommitted: true,
        captureMode: "hostMediated",
      },
    );
    return {
      depositId,
      label: secretRef,
      storageCommitHash,
      secretExposed: false,
      taskId: browserTask.taskId,
      sourceUrl: browserTask.currentUrl,
      vaultRef,
      serverReceipt: {
        id: depositId,
        payloadHash: storageCommitHash,
        createdMs: Date.now(),
        fromToken: "browser-agent-token:shellx-browser",
      },
      receipt,
    };
  }
  if (name === "browser_read_email_code") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) {
      throw new Error("fixture browser_read_email_code requires the exact owned task");
    }
    const resourceRef = String(toolArgs.resourceRef ?? "");
    const grantId = String(toolArgs.grantId ?? "");
    requireFixtureGrant(grantId, resourceRef, "emailCodeRead");
    const resource = vaultResources.get(resourceRef);
    const parsed = JSON.parse(resource?.value ?? "{}") as Record<string, unknown>;
    const code = String(parsed.latestCode ?? "");
    if (!code) throw new Error("fixture email resource omitted latestCode");
    const receipt = pushBrowserReceipt(
      "browserEmailCodeRead",
      browserTask.taskId,
      { itemId: resourceRef, origin: browserOrigin(), grantId, action: "emailCodeRead", secretExposed: false },
    );
    return {
      ok: true,
      status: "applied",
      action: "readEmailCodeGrant",
      resourceRef,
      origin: browserOrigin(),
      grantId,
      code,
      codeReturned: true,
      secretExposed: true,
      receiptId: receipt.receiptId,
    };
  }
  if (name === "browser_use_agent_wallet") {
    if (!browserTask || toolArgs.taskId !== browserTask.taskId) {
      throw new Error("fixture browser_use_agent_wallet requires the exact owned task");
    }
    const resourceRef = String(toolArgs.resourceRef ?? "");
    const grantId = String(toolArgs.grantId ?? "");
    requireFixtureGrant(grantId, resourceRef, "agentWalletUse");
    const receipt = pushBrowserReceipt(
      "browserAgentWalletCheckoutUnavailable",
      browserTask.taskId,
      { itemId: resourceRef, origin: browserOrigin(), grantId, action: "agentWalletUnavailable", secretExposed: false },
    );
    return {
      ok: false,
      status: "unavailable",
      code: "browser_agent_wallet_checkout_unavailable",
      error: "Agent-wallet checkout requires a real provider transaction bridge; grant approval alone does not prepare payment",
      resourceRef,
      origin: browserOrigin(),
      grantId,
      secretExposed: false,
      receiptId: receipt.receiptId,
    };
  }
  if (name === "browser_check") {
    return {
      schema: "shellx/browser-quiet-check@1",
      ok: true,
      mode: "quiet",
      effects: {
        uiMutation: false,
        windowOpened: false,
        taskCreated: false,
        engineMounted: false,
        receiptEmitted: false,
      },
      summary: { activeTaskId: "fixture-private-active-task" },
      settle: { settled: true, taskId: "fixture-private-active-task" },
    };
  }
  if (name === "browser_downloads") {
    return { downloads: [{ finalPath: "/fixture/private/download", sourceUrl: "https://fixture.invalid/private" }] };
  }
  if (name === "browser_evidence") {
    return {
      ok: true,
      recent: [{ receiptId: "fixture-private-evidence", evidence: { path: "/fixture/private/evidence" } }],
      count: 1,
      callerScoped: true,
    };
  }
  if (name === "browser_rendered_check") {
    return {
      schema: "shellx/browser-rendered-check@1",
      ok: true,
      status: "passed",
      evidence: { textMatched: true, titleMatched: true, selectorMatched: true, selectorCount: 1 },
      effects: {
        visibleWindowOpened: false,
        browserTaskCreated: false,
        browserTabCreated: false,
        receiptEmitted: false,
        hiddenRendererCreated: true,
        hiddenRendererDestroyed: true,
        profilePersisted: false,
      },
    };
  }
  if (name === "Agent_metrics") {
    return {
      running: 0,
      completed: 0,
      failed: 0,
      total: 0,
      total_elapsed_ms_p50: null,
      total_elapsed_ms_p95: null,
      success_rate: null,
    };
  }
  if (name === "Agent_poll_all") {
    const ids = Array.isArray(toolArgs.subagent_ids) ? toolArgs.subagent_ids : [];
    return {
      snapshots: ids.map((id) => ({ subagent_id: id, error: "fixture missing agent" })),
      at_unix_ms: 1_786_000_000_000,
    };
  }
  if (name === "browser_state") {
    return {
      browserProtocolVersion: "fixture-browser-protocol",
      browserSchemaRevision: "fixture-browser-schema",
      revisions: { state: "0", tasks: "0", tabs: "0", engine: "0", requests: "0", activity: "0" },
      counts: {
        profiles: 0, tabs: 0, tasks: 0, runningTasks: 0, bookmarks: 0, history: 0,
        receipts: 0, consoleLogs: 0, downloads: 0, uploads: 0, pendingRequests: 0, waitingEngines: 0,
      },
      activeTask: null,
      activeTab: null,
      activeEngine: null,
      pendingRequests: [],
      windowOpen: false,
      personalBrowserLocked: false,
      pendingStartUrl: null,
    };
  }
  if (name === "browser_tabs") {
    return {
      tabs: [{ browserTabId: "fixture-private-browser-tab", status: "ready" }],
      activeBrowserTabId: "fixture-private-browser-tab",
    };
  }
  if (name === "browser_locks") return { locks: [] };
  if (name === "browser_workflows") return { ok: true, count: 0, workflows: [] };
  if (["environment", "grok_environment", "session_environment"].includes(name)) {
    return {
      tabId: callerTabId,
      status: "idle",
      checkedAtMs: 1_786_000_000_000,
      setup: { summary: { status: "idle" }, checks: [] },
      readiness: { summary: { status: "idle" }, checks: [] },
      trace: { available: false },
    };
  }
  if (name === "build_state") return { tabId: callerTabId, state: null };
  if (name === "build_receipts") return { ok: true, tabId: callerTabId, receipts: [] };
  if (name === "event_log") {
    return { events: [], count: 0, earliestT: null, latestT: null };
  }
  if (name === "get_session_info") {
    return {
      tabId: callerTabId,
      processCwd: "/fixture/private/cwd",
      fileSystems: {
        nativeSession: "fixture native boundary",
        shellxHostMcp: "fixture host boundary",
      },
    };
  }
  if (name === "preview_state") {
    return previewState?.tabId === callerTabId ? previewState : idlePreviewState(callerTabId);
  }
  if (name === "preview_logs") return { tabId: callerTabId, logs: [] };
  if (name === "preview_diagnose") {
    return {
      tabId: callerTabId,
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
      state: idlePreviewState(callerTabId),
    };
  }
  if (name === "preview_start") {
    const tabId = String(toolArgs.tabId ?? callerTabId);
    const cwd = String(toolArgs.cwd ?? "");
    if (!tabId.startsWith("shellx-release-host-preview-") || !cwd
      || toolArgs.kind !== "static" || toolArgs.entry !== "release-preview.html") {
      throw new Error("invalid preview_start fixture arguments");
    }
    const url = `http://127.0.0.1:${address(debugServer).port}/preview-fixture/release-preview.html`;
    const now = Date.now();
    previewState = {
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
    return previewState;
  }
  if (name === "provider_sessions") {
    return {
      tabId: callerTabId,
      transport: "local",
      transportKey: "local",
      recentRuns: [],
      storedConversations: {},
    };
  }
  if (name === "session_tooling") {
    return {
      tabId: callerTabId,
      session: { transport: "none", hasActiveChild: false },
      desired: [{ id: "fixture-private-tooling-row" }],
      health: [],
    };
  }
  if (name === "sleep_ms") return { slept_ms: Number(toolArgs.ms ?? 0) };
  if (name === "mem_set") {
    const namespace = String(toolArgs.namespace ?? "default");
    const key = String(toolArgs.key ?? "");
    memory.set(`${namespace}\0${key}`, String(toolArgs.value ?? ""));
    return { ok: true, namespace, key };
  }
  if (name === "mem_get") {
    const namespace = String(toolArgs.namespace ?? "default");
    const key = String(toolArgs.key ?? "");
    const value = memory.get(`${namespace}\0${key}`);
    return value === undefined
      ? { found: false, namespace, key, mtime_unix_ms: 0 }
      : { found: true, value, namespace, key, mtime_unix_ms: 1_786_000_000_000 };
  }
  if (name === "mem_list") {
    const namespace = String(toolArgs.namespace ?? "default");
    const prefix = String(toolArgs.prefix ?? "");
    const entries = [...memory.entries()]
      .filter(([compound]) => compound.startsWith(`${namespace}\0${prefix}`))
      .map(([compound, value]) => ({ key: compound.slice(namespace.length + 1), value, mtime_unix_ms: 1_786_000_000_000 }));
    return { entries, count: entries.length };
  }
  if (name === "mem_delete") {
    const namespace = String(toolArgs.namespace ?? "default");
    const key = String(toolArgs.key ?? "");
    return { deleted: memory.delete(`${namespace}\0${key}`) };
  }
  if (name === "fs_unwatch") {
    const watchId = String(toolArgs.watchId ?? "");
    const stopped = activeWatchId === watchId;
    if (stopped) activeWatchId = null;
    return { ok: true, stopped, watchId };
  }
  if (name === "fs_watch") {
    activeWatchId = String(toolArgs.path ?? "");
    return {
      ok: true,
      watching: String(toolArgs.path ?? ""),
      watchId: activeWatchId,
      alreadyWatching: false,
      recursive: toolArgs.recursive === true,
      debounce_ms: Number(toolArgs.debounce_ms ?? 100),
    };
  }
  if (name === "net_fetch") {
    return {
      error: "net_fetch: restricted IP literal 169.254.169.254 (link-local) is not allowed",
      host: "169.254.169.254",
      url: toolArgs.url,
      made_request: false,
    };
  }
  if (name === "secret_get") {
    return {
      code: "RAW_SECRET_REVEAL_DENIED",
      message: "fixture raw Vault secret reveal denied",
      isError: true,
    };
  }
  if (name === "secret_delete") {
    const key = String(toolArgs.key ?? toolArgs.path ?? "").replace(/^vault:/, "");
    const existed = generatedVaultItems.delete(key);
    return { ok: true, key, existed };
  }
  if (name === "security_scan") {
    const root = String(toolArgs.path ?? "");
    return {
      summary: {
        status: "pass",
        manifestCount: 1,
        auditsRun: 0,
        auditsSkipped: 0,
        elapsedMs: 1,
        scannedAtMs: 1_786_000_000_000,
        dataSources: ["local manifest inventory"],
      },
      root,
      manifests: [{ path: join(root, "package.json"), fileName: "package.json", ecosystem: "node", kind: "manifest" }],
      checks: [],
      note: "Inventory only.",
    };
  }
  if (name === "vault_agent_request") {
    return {
      ok: true,
      requests: [{ id: "fixture-private-vault-request", result: "fixture-private-redacted-result" }],
      pendingCount: 0,
      resources: [{ id: "fixture-private-vault-resource" }],
      secretExposed: false,
      executionHost: "shellxDesktop",
    };
  }
  if (name === "vault_deposit") {
    return {
      ok: true,
      action: "deposit",
      label: toolArgs.label,
      route: "/browser/vault-deposits",
      requiredPostFields: ["label", "secretValue"],
      secretExposed: false,
    };
  }
  if (name === "vault_generate") {
    const itemId = String(toolArgs.itemId ?? "");
    if (generatedVaultItems.has(itemId)) {
      return {
        ok: false,
        status: "refused",
        code: "VAULT_GENERATE_ITEM_EXISTS",
        itemId,
        origin: toolArgs.origin,
        secretExposed: false,
        isError: true,
      };
    }
    generatedVaultItems.add(itemId);
    return {
      ok: true,
      status: "created",
      action: "generateAndStore",
      origin: toolArgs.origin,
      itemId,
      length: Number(toolArgs.length ?? 24),
      storageCommitted: true,
      secretExposed: false,
    };
  }
  if (name === "vault_list") {
    const prefix = String(toolArgs.prefix ?? "");
    const entries = [...generatedVaultItems]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, description: "generated fixture item" }));
    if (prefix) {
      return { ok: true, count: entries.length, entries, secretExposed: false, visibility: "agentVisibleOnly" };
    }
    return {
      ok: true,
      count: 1,
      entries: [{ key: "fixture-private-vault-key", description: "fixture private description" }],
      secretExposed: false,
      visibility: "agentVisibleOnly",
    };
  }
  if (name === "vault_list_grants") {
    return {
      ok: true,
      count: 1,
      grants: [{ id: "fixture-private-grant", secretRef: "fixture-private-secret-ref" }],
      secretExposed: false,
    };
  }
  if (name === "search_tool") {
    const query = String(toolArgs.query ?? "");
    return {
      tools: [{ name: query, inputSchema: { type: "object", properties: { fixture: { type: "string" } } } }],
      total_matched: 1,
      total_hidden_tools: 0,
      mode: "ranked",
      query,
      limit: Number(toolArgs.limit ?? 5),
    };
  }
  if (name === "capabilities_summary") {
    return { kind: "shellx_capabilities_summary", hostToolCategories: [{ category: "filesystem" }, { category: "status" }] };
  }
  if (name === "model_instruction_cards") {
    return { cards: [{ id: "fixture-private-card" }], policy: { shellxMayAutoRoute: false } };
  }
  if (name === "provider_adapters") {
    return { providers: [{ providerId: "codex-cli", version: "fixture-private-version", binaryPath: "/private/bin/codex" }] };
  }
  if (name === "shellx_health") {
    return { ok: true, processId, instanceId, appVersion: version, buildCommit: sourceCommit };
  }
  if (name === "clock_now") {
    return { unix_ms: 1_786_000_000_000, iso8601: "2026-07-29T12:00:00.000Z", tz_used: "utc" };
  }
  if (name === "process_list") {
    return { processes: [{ taskId: "fixture-private-task", pid: 9999, cmd: "fixture-private-command" }] };
  }
  const path = String(toolArgs.path ?? "");
  if (name === "fs_ensure_dir") {
    const created = !existsSync(path);
    mkdirSync(path, { recursive: true });
    return { created, path };
  }
  if (name === "fs_write") {
    if (toolArgs.create_dirs === true) mkdirSync(dirname(path), { recursive: true });
    const content = String(toolArgs.content ?? "");
    writeFileSync(path, content, "utf8");
    return { bytes_written: Buffer.byteLength(content), path, encoding: "utf8" };
  }
  if (name === "fs_append") {
    const content = String(toolArgs.content ?? "");
    appendFileSync(path, content, "utf8");
    return { bytes_appended: Buffer.byteLength(content), new_size: statSync(path).size };
  }
  if (name === "fs_copy") {
    const src = String(toolArgs.src ?? "");
    const dst = String(toolArgs.dst ?? "");
    copyFileSync(src, dst);
    return { bytes_copied: statSync(dst).size, src, dst, overwrite_used: false };
  }
  if (name === "fs_delete") {
    const kind = statSync(path).isDirectory() ? "dir" : "file";
    rmSync(path, { recursive: toolArgs.recursive === true });
    return { removed: true, kind, path, recursive: toolArgs.recursive === true };
  }
  if (name === "fs_exists") {
    return { exists: statSync(path).isFile(), kind: "file" };
  }
  if (name === "fs_stat") {
    const stat = statSync(path);
    return { exists: true, kind: "file", size_bytes: stat.size, mtime_unix_ms: stat.mtimeMs };
  }
  if (name === "fs_read") {
    const content = readFileSync(path, "utf8");
    return {
      content,
      size_bytes: Buffer.byteLength(content),
      offset_bytes: 0,
      bytes_returned: Buffer.byteLength(content),
      next_offset_bytes: null,
      truncated: false,
      approx_tokens: Math.ceil(content.length / 4),
    };
  }
  if (name === "fs_read_binary") {
    const contents = readFileSync(path);
    return { content_base64: contents.toString("base64"), size_bytes: contents.length, truncated: false, mime: "application/octet-stream" };
  }
  if (name === "fs_list_dir") {
    return {
      entries: readdirSync(path).map((entry) => ({ name: entry, kind: "file", size_bytes: statSync(join(path, entry)).size, mtime_unix_ms: 1 })),
      truncated: false,
    };
  }
  if (name === "fs_grep") {
    const file = join(path, "fixture.txt");
    const line = readFileSync(file, "utf8").split(/\r?\n/).find((entry) => entry.includes(String(toolArgs.pattern)));
    return {
      matches: line ? [{ path: file, line: 2, text: line }] : [],
      files_scanned: 2,
      truncated: false,
    };
  }
  throw new Error(`unsupported fixture tool ${name} at ${basename(path)}`);
}

function idlePreviewState(tabId: string): Record<string, unknown> {
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

function isMutationTool(name: string): boolean {
  return [
    "Agent", "Agent_kill", "browser_act", "browser_clear_site_data", "browser_click_at", "browser_click_ref", "browser_evaluation_write", "browser_fill_ref",
    "browser_flight_recorder_export", "browser_navigate", "browser_resolve_dialog", "browser_run_steps", "browser_save_page", "browser_screenshot", "browser_trace_open", "browser_type_text", "browser_workflow_replay", "browser_workflow_save", "build_checkpoint", "build_complete", "build_receipt",
    "goal_complete", "host_act", "cut_act", "fs_append", "fs_copy", "fs_delete", "fs_ensure_dir",
    "fs_watch", "fs_write", "mem_delete", "mem_set", "net_fetch", "process_signal", "preview_start", "secret_delete",
    "secret_set", "security_scan", "send_prompt_to_provider", "send_prompt_to_session",
    "vault_agent_request", "vault_generate", "vault_request_grant", "vision_describe", "vision_describe_v2",
    "voice_stt_v2", "voice_tts", "x_search", "browser_capture_secret_to_vault", "browser_read_email_code",
    "browser_use_agent_wallet",
  ].includes(name);
}

function browserOrigin(): string {
  if (!browserTask?.currentUrl) return "unknown";
  return new URL(browserTask.currentUrl).origin;
}

function requireFixtureGrant(grantId: string, resourceRef: string, operation: string): void {
  const grant = vaultGrants.get(grantId);
  if (!grant || grant.resourceRef !== resourceRef || grant.operation !== operation) {
    throw new Error(`fixture ${operation} grant did not authorize the exact resource`);
  }
}

function pushBrowserReceipt(
  kind: string,
  taskId: string,
  evidence: Record<string, unknown>,
): Record<string, unknown> {
  browserReceiptSequence += 1;
  const receipt = {
    receiptId: `browser-receipt-owned-${browserReceiptSequence}`,
    kind,
    taskId,
    profileId: null,
    summary: `${kind} owned release fixture`,
    t: Date.now(),
    sequence: browserReceiptSequence,
    evidence,
  };
  browserReceipts.push(receipt);
  return receipt;
}

function vaultAuditReceipt(
  action: string,
  secretRef: string | null = null,
  grantId: string | null = null,
): Record<string, unknown> {
  const receipt = {
    receiptId: `vault-e2e-owned-${vaultResetCount}-${vaultAudit.length + 1}`,
    action,
    secretRef,
    grantId,
    decision: null,
    reason: null,
    secretPresent: null,
    secretExposed: false,
    t: Date.now(),
  };
  vaultAudit.push(receipt);
  return receipt;
}

function writeFixtureArtifact(fileName: string, content: string | Buffer): { path: string; bytes: number; sha256: string } {
  const root = join(profileRoot, ".shellx", "browser-artifacts", "release-driver");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, fileName);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function deriveTabBoundToken(baseToken: string, tabId: string): string {
  return `sx_tab_${createHash("sha256")
    .update("shellx-mcp-tab-token-v1\0")
    .update(baseToken)
    .update("\0")
    .update(tabId)
    .digest("hex")}`;
}

function rpcResult(id: string, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code: -32601, message } };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("request body must be an object");
  return parsed;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function text(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  if (response.headersSent) return;
  response.writeHead(status, { "Content-Type": contentType });
  response.end(body);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
}

function address(server: Server): { port: number } {
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("fixture server address unavailable");
  return value;
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
