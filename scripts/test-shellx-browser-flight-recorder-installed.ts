import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { cleanupOwnedBrowserLifecycle, type BrowserLifecycleCleanupResult } from "./shellx-browser-test-cleanup";
import { debugApiConnectionCandidates, shellxHomeCandidates } from "./shellx-debug-paths";

type JsonObject = Record<string, unknown>;

interface DebugContext {
  base: string;
  token: string;
  source: string;
}

interface McpContext {
  base: string;
  token: string;
  tabId: string;
  source: string;
}

interface McpToolResult {
  isError?: boolean;
  structuredContent?: JsonObject;
  content?: Array<{ type?: string; text?: string }>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: JsonObject | McpToolResult;
  error?: { code: number; message: string };
}

interface Fixture {
  url: string;
  close: () => Promise<void>;
}

const TIMEOUT_MS = Math.max(5_000, Math.min(Number(process.env.SHELLX_FLIGHT_RECORDER_TIMEOUT_MS ?? 30_000), 120_000));
const CONFIGURED_TAB_ID = process.env.SHELLX_FLIGHT_RECORDER_TAB_ID?.trim() || null;
const CALLER_HEADER = "x-shellx-mcp-caller-id";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function stringValue(value: JsonObject, key: string, label: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result.trim()) throw new Error(`${label}.${key} must be a non-empty string`);
  return result;
}

function numberValue(value: JsonObject, key: string, label: string): number {
  const result = value[key];
  if (typeof result !== "number" || !Number.isFinite(result) || result < 0) {
    throw new Error(`${label}.${key} must be a non-negative number`);
  }
  return result;
}

function readTrim(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function tabBoundMcpToken(baseToken: string, tabId: string): string {
  const digest = createHash("sha256")
    .update("shellx-mcp-tab-token-v1\0")
    .update(baseToken)
    .update("\0")
    .update(tabId)
    .digest("hex");
  return `sx_tab_${digest}`;
}

function mcpCandidates(tabId: string): McpContext[] {
  const explicitBase = process.env.SHELLX_MCP_BASE?.trim();
  const explicitToken = process.env.SHELLX_MCP_TOKEN?.trim();
  const baseToken = process.env.SHELLX_MCP_BASE_TOKEN?.trim() ?? process.env.SHELLX_MCP_SECRET?.trim();
  if (explicitBase) {
    const token = explicitToken ?? (baseToken ? tabBoundMcpToken(baseToken, tabId) : null);
    if (!token) throw new Error("SHELLX_MCP_BASE requires a tab token or MCP base token");
    return [{ base: explicitBase, token, tabId, source: "env:SHELLX_MCP_BASE" }];
  }
  const explicitPort = process.env.SHELLX_MCP_PORT?.trim();
  return shellxHomeCandidates().map((dir) => {
    const port = explicitPort ?? readTrim(join(dir, "mcp-http.port"));
    const pairedBaseToken = baseToken ?? readTrim(join(dir, "mcp.token"));
    const token = explicitToken ?? (pairedBaseToken ? tabBoundMcpToken(pairedBaseToken, tabId) : null);
    if (!port || !token) return null;
    return { base: `http://127.0.0.1:${port}`, token, tabId, source: dir };
  }).filter((candidate): candidate is McpContext => Boolean(candidate));
}

async function requestJson(
  base: string,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<JsonObject> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${text.slice(0, 1_200)}`);
  return objectValue(text.trim() ? JSON.parse(text) : {}, `${method} ${path} response`);
}

function debugRequest(
  ctx: DebugContext,
  method: "GET" | "POST",
  path: string,
  body?: JsonObject,
  headers: Record<string, string> = {},
): Promise<JsonObject> {
  return requestJson(ctx.base, ctx.token, method, path, body, headers);
}

async function firstHealthyDebug(): Promise<DebugContext> {
  const errors: string[] = [];
  for (const candidate of debugApiConnectionCandidates()) {
    try {
      await requestJson(candidate.base, candidate.token, "GET", "/health");
      return candidate;
    } catch (error) {
      errors.push(`${candidate.base} (${candidate.source}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No reachable ShellX Debug API candidate. ${errors.join(" | ")}`);
}

async function firstHealthyMcp(tabId: string): Promise<McpContext> {
  const errors: string[] = [];
  for (const candidate of mcpCandidates(tabId)) {
    try {
      await requestJson(candidate.base, null, "GET", "/health");
      return candidate;
    } catch (error) {
      errors.push(`${candidate.base} (${candidate.source}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No reachable ShellX MCP HTTP candidate. ${errors.join(" | ")}`);
}

async function resolveCallerTabId(debug: DebugContext): Promise<string> {
  if (CONFIGURED_TAB_ID) return CONFIGURED_TAB_ID;
  const ui = await debugRequest(debug, "GET", "/state/ui");
  const activeTabId = ui.activeTabId;
  if (typeof activeTabId !== "string" || !/^[a-zA-Z0-9._:-]{1,256}$/.test(activeTabId)) {
    throw new Error("Installed Flight Recorder gate requires an active bounded renderer tab id");
  }
  return activeTabId;
}

async function mcpRpc(ctx: McpContext, method: string, params: JsonObject = {}): Promise<JsonObject> {
  const response = await requestJson(ctx.base, ctx.token, "POST", "/mcp", {
    jsonrpc: "2.0",
    id: `${method}-${randomUUID()}`,
    method,
    params,
  }, { "MCP-Tab-Id": ctx.tabId }) as unknown as JsonRpcResponse;
  if (response.error) throw new Error(`MCP ${method} failed with ${response.error.code}: ${response.error.message}`);
  return objectValue(response.result ?? {}, `MCP ${method} result`);
}

async function mcpCall(ctx: McpContext, name: string, args: JsonObject): Promise<McpToolResult> {
  const result = await mcpRpc(ctx, "tools/call", { name, arguments: args }) as McpToolResult;
  if (result.isError) {
    const detail = result.content?.map((item) => item.text).filter(Boolean).join("\n") || "unknown tool error";
    throw new Error(`MCP ${name} returned isError: ${detail}`);
  }
  return result;
}

function structured(result: McpToolResult, label: string): JsonObject {
  return objectValue(result.structuredContent, `${label}.structuredContent`);
}

function artifactIdentity(artifact: JsonObject, label: string): JsonObject {
  const sha256 = stringValue(artifact, "sha256", label);
  assert(/^[a-f0-9]{64}$/.test(sha256), `${label} returns a lowercase SHA-256 identity`);
  return {
    attemptId: stringValue(artifact, "attemptId", label),
    taskId: stringValue(artifact, "taskId", label),
    browserTabId: typeof artifact.browserTabId === "string" ? artifact.browserTabId : null,
    path: stringValue(artifact, "path", label),
    bytes: numberValue(artifact, "bytes", label),
    sha256,
    events: numberValue(artifact, "events", label),
    receipts: numberValue(artifact, "receipts", label),
  };
}

function evaluationAttempt(identity: JsonObject, group: "baseline" | "candidate", steps: number): JsonObject {
  return {
    attemptId: stringValue(identity, "attemptId", `${group} identity`),
    group,
    taskId: stringValue(identity, "taskId", `${group} identity`),
    status: "passed",
    durationMs: 1,
    steps,
    safetyViolations: 0,
    artifactPath: stringValue(identity, "path", `${group} identity`),
    artifactBytes: numberValue(identity, "bytes", `${group} identity`),
    artifactSha256: stringValue(identity, "sha256", `${group} identity`),
  };
}

async function startFixture(): Promise<Fixture> {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/flight-recorder") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><title>ShellX Flight Recorder installed gate</title>
      <main><h1>Flight Recorder baseline ready</h1>
      <button id="advance" onclick="document.querySelector('#status').textContent='Flight Recorder candidate ready'">Advance candidate</button>
      <p id="status">Baseline state</p></main>`);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Flight Recorder fixture did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/flight-recorder`,
    close: () => closeServer(server, sockets),
  };
}

function configuredFixture(): Fixture | null {
  const configured = process.env.SHELLX_FLIGHT_RECORDER_FIXTURE_URL?.trim();
  if (!configured) return null;
  const url = new URL(configured);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password
  ) {
    throw new Error("SHELLX_FLIGHT_RECORDER_FIXTURE_URL must be an unauthenticated http://127.0.0.1:<port> URL");
  }
  return { url: url.toString(), close: async () => undefined };
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

function runCli(args: string[], env: NodeJS.ProcessEnv): JsonObject {
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/shellx-browser-cli.ts"), ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  if (result.status !== 0) throw new Error(`ShellX Browser CLI ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  const line = result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).at(-1);
  return objectValue(line ? JSON.parse(line) : {}, `ShellX Browser CLI ${args[0]} output`);
}

function outputPathFromArgs(): string | null {
  const args = process.argv.slice(2);
  const index = args.indexOf("--out");
  return index >= 0 ? args[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  console.log("\n=== ShellX installed Flight Recorder pipeline ===");
  const debug = await firstHealthyDebug();
  const tabId = await resolveCallerTabId(debug);
  const mcp = await firstHealthyMcp(tabId);
  const health = await debugRequest(debug, "GET", "/health");
  const buildCommit = stringValue(health, "buildCommit", "health");
  const expectedCommit = process.env.SHELLX_EXPECT_BUILD_COMMIT?.trim();
  if (expectedCommit) assert(buildCommit === expectedCommit, `installed build commit matches ${expectedCommit}`);

  const toolList = await mcpRpc(mcp, "tools/list");
  const tools = Array.isArray(toolList.tools) ? toolList.tools : [];
  const browserTools = tools.filter((tool) => {
    const name = objectValue(tool, "MCP tool").name;
    return name === "browser_read" || name === "browser_act";
  });
  const browserSchemaBytes = Buffer.byteLength(JSON.stringify(browserTools));
  assert(browserTools.length === 2, "installed MCP advertises exactly two Browser tools");
  assert(browserSchemaBytes === 2_601, "installed Browser schema remains 2,601 serialized bytes");

  const fixture = configuredFixture() ?? await startFixture();
  const taskIds = new Set<string>();
  let cleanup: BrowserLifecycleCleanupResult | null = null;
  let receipt: JsonObject | null = null;
  try {
    await debugRequest(debug, "POST", `/autonomy?tabId=${encodeURIComponent(tabId)}`, { tabId, mode: "bypassPermissions" });
    const task = await debugRequest(debug, "POST", "/browser/task/start", {
      goal: "Installed Flight Recorder exact-identity gate",
      startUrl: fixture.url,
      profileId: "agent-work",
      autonomy: "assistedAutonomous",
      expectedDomains: ["127.0.0.1"],
    }, { [CALLER_HEADER]: tabId });
    const baselineTaskId = stringValue(task, "taskId", "baseline Browser task");
    taskIds.add(baselineTaskId);
    assert(task.ownerSessionId === tabId, "installed Browser task is bound to the MCP caller session");
    const settled = await debugRequest(
      debug,
      "GET",
      `/browser/settle?taskId=${encodeURIComponent(baselineTaskId)}&timeoutMs=${TIMEOUT_MS}`,
    );
    assert(settled.settled === true, "installed Browser task navigation settles before page actions");

    await mcpCall(mcp, "browser_read", { action: "waitFor", taskId: baselineTaskId, key: "text", value: "Flight Recorder baseline ready", timeoutMs: TIMEOUT_MS });
    await mcpCall(mcp, "browser_read", { action: "observe", taskId: baselineTaskId, maxPayloadBytes: 3_000 });
    await mcpCall(mcp, "browser_read", { action: "verify", taskId: baselineTaskId, key: "text", value: "Flight Recorder baseline ready" });
    const suiteId = `installed-flight-${Date.now()}`;
    const baseline = structured(await mcpCall(mcp, "browser_act", {
      action: "flightRecorderExport", taskId: baselineTaskId, suiteId, group: "baseline", attemptIndex: 0,
    }), "baseline export");
    const baselineIdentity = artifactIdentity(baseline, "baseline export");

    const candidateTask = await debugRequest(debug, "POST", "/browser/task/start", {
      goal: "Installed Flight Recorder candidate exact-identity gate",
      startUrl: fixture.url,
      profileId: "agent-work",
      autonomy: "assistedAutonomous",
      expectedDomains: ["127.0.0.1"],
    }, { [CALLER_HEADER]: tabId });
    const candidateTaskId = stringValue(candidateTask, "taskId", "candidate Browser task");
    taskIds.add(candidateTaskId);
    assert(candidateTask.ownerSessionId === tabId, "candidate Browser task is bound to the MCP caller session");
    const candidateSettled = await debugRequest(
      debug,
      "GET",
      `/browser/settle?taskId=${encodeURIComponent(candidateTaskId)}&timeoutMs=${TIMEOUT_MS}`,
    );
    assert(candidateSettled.settled === true, "candidate Browser task navigation settles before page actions");
    await mcpCall(mcp, "browser_act", { action: "clickRef", taskId: candidateTaskId, selector: "#advance", timeoutMs: TIMEOUT_MS });
    await mcpCall(mcp, "browser_read", { action: "waitFor", taskId: candidateTaskId, key: "text", value: "Flight Recorder candidate ready", timeoutMs: TIMEOUT_MS });
    await mcpCall(mcp, "browser_read", { action: "verify", taskId: candidateTaskId, key: "text", value: "Flight Recorder candidate ready" });
    const candidate = structured(await mcpCall(mcp, "browser_act", {
      action: "flightRecorderExport", taskId: candidateTaskId, suiteId, group: "candidate", attemptIndex: 1,
    }), "candidate export");
    const candidateIdentity = artifactIdentity(candidate, "candidate export");

    const evaluatedAtMs = Date.now();
    const attempts = [
      evaluationAttempt(baselineIdentity, "baseline", 2),
      evaluationAttempt(candidateIdentity, "candidate", 3),
    ];
    const report = structured(await mcpCall(mcp, "browser_act", {
      action: "evaluationWrite", taskId: candidateTaskId, suiteId, evaluatedAtMs, attempts,
    }), "evaluation report");
    assert(report.evidenceComplete === true, "installed MCP evaluation is evidence complete");
    assert(numberValue(report, "attempts", "evaluation report") === 2, "installed MCP evaluation binds two exact attempts");

    const evidence = structured(await mcpCall(mcp, "browser_read", { action: "evidence", limit: 8 }), "evidence summary");
    assert(evidence.callerScoped === true, "installed evidence summary is caller scoped");
    assert(numberValue(evidence, "count", "evidence summary") >= 3, "installed evidence summary lists recorder and evaluation receipts");

    const cliEnv = {
      SHELLX_DEBUG_BASE: debug.base,
      SHELLX_DEBUG_SECRET: debug.token,
      SHELLX_HOST_MCP_TAB_ID: tabId,
    };
    const cliExport = runCli(["flight-recorder-export", "--task", candidateTaskId, "--suite", suiteId, "--group", "candidate", "--attempt-index", "2"], cliEnv);
    artifactIdentity(cliExport, "CLI recorder export");
    const tempRoot = mkdtempSync(join(tmpdir(), "shellx-flight-recorder-installed-"));
    try {
      const attemptsPath = join(tempRoot, "attempts.json");
      writeFileSync(attemptsPath, `${JSON.stringify(attempts)}\n`, { mode: 0o600 });
      const cliReport = runCli(["workflow-evaluate", "--suite", suiteId, "--evaluated-at-ms", String(evaluatedAtMs + 1), "--task", candidateTaskId, "--attempts-file", attemptsPath], cliEnv);
      assert(cliReport.evidenceComplete === true, "installed CLI evaluation is evidence complete");
      receipt = {
        schemaVersion: "shellx.flight-recorder-installed.v1",
        testedAt: new Date().toISOString(),
        hostLabel: process.env.SHELLX_TEST_HOST_LABEL?.trim() || "unspecified",
        appVersion: stringValue(health, "appVersion", "health"),
        buildCommit,
        browserCatalog: { tools: browserTools.length, serializedBytes: browserSchemaBytes },
        tasks: {
          baselineTaskId,
          candidateTaskId,
          ownerSessionId: tabId,
          distinct: baselineTaskId !== candidateTaskId,
        },
        attempts: [baselineIdentity, candidateIdentity],
        report: {
          reportId: stringValue(report, "reportId", "evaluation report"),
          path: stringValue(report, "path", "evaluation report"),
          bytes: numberValue(report, "bytes", "evaluation report"),
          sha256: stringValue(report, "sha256", "evaluation report"),
          evidenceDigest: stringValue(report, "evidenceDigest", "evaluation report"),
          improvementRating: stringValue(report, "improvementRating", "evaluation report"),
          evidenceComplete: true,
        },
        cli: {
          exportAttemptId: stringValue(cliExport, "attemptId", "CLI recorder export"),
          reportId: stringValue(cliReport, "reportId", "CLI evaluation report"),
          evidenceComplete: true,
        },
        evidence: { callerScoped: true, count: evidence.count },
      };
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  } finally {
    cleanup = await cleanupOwnedBrowserLifecycle(
      (method, path, body) => debugRequest(debug, method, path, body, { [CALLER_HEADER]: tabId }),
      { taskIds, label: "flight-recorder-installed" },
    );
    await debugRequest(debug, "POST", `/autonomy?tabId=${encodeURIComponent(tabId)}`, { tabId, mode: "bypassPermissions" });
    await fixture.close();
  }

  if (!receipt || !cleanup) throw new Error("Installed Flight Recorder gate did not produce a receipt");
  assert(cleanup.errors.length === 0, "installed Browser lifecycle cleanup completes without owner-control errors");
  receipt.cleanup = cleanup;
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  const outputPath = outputPathFromArgs();
  if (outputPath) writeFileSync(resolve(outputPath), output, { mode: 0o600 });
  console.log(output);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
