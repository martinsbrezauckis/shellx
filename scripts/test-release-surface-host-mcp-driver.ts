import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA,
  releaseSurfaceDriverReportPassed,
  validateReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "./lib/release-surface-driver-protocol";
import { releaseSurfaceControllerBindingFixture, releaseSurfaceFixtureSourceCommit, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import {
  HOST_MCP_CAPTURE_FIXTURE_VALUE,
  HOST_MCP_EMAIL_CODE_FIXTURE,
  HOST_MCP_WALLET_FIXTURE_MARKER,
} from "./release-drivers/host-mcp-vault-lifecycle";

const root = resolve(import.meta.dirname, "..");
const tempParent = mkdtempSync(join(tmpdir(), "shellx-host-mcp-driver-test-"));
const runId = "a".repeat(16);
const profileRoot = join(tempParent, `shellx-final-webdriver-${runId}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(tempParent, "fixture-state.json");
const debugTokenPath = join(shellxHome, "shellxagent.token");
const mcpTokenPath = join(shellxHome, "mcp.token");
const requestPath = join(tempParent, "request.json");
const reportPath = join(tempParent, "report.json");
const debugToken = "fixture-debug-token-host-mcp-0001";
const mcpToken = "fixture-host-mcp-token-0000000001";
const instanceId = "fixture-host-mcp-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const toolNames = [
  "Agent",
  "Agent_metrics",
  "Agent_output",
  "Agent_poll_all",
  "Agent_status",
  "Agent_kill",
  "capabilities_summary",
  "browser_act",
  "browser_check",
  "browser_capture_secret_to_vault",
  "browser_clear_site_data",
  "browser_click_at",
  "browser_click_ref",
  "browser_downloads",
  "browser_evidence",
  "browser_evaluation_write",
  "browser_flight_recorder_export",
  "browser_extract",
  "browser_fill_ref",
  "browser_locks",
  "browser_navigate",
  "browser_observe",
  "browser_read",
  "browser_resolve_dialog",
  "browser_rendered_check",
  "browser_read_email_code",
  "browser_run_steps",
  "browser_save_page",
  "browser_screenshot",
  "browser_state",
  "browser_tabs",
  "browser_type_text",
  "browser_trace_open",
  "browser_verify",
  "browser_wait_for",
  "browser_workflows",
  "browser_workflow_replay",
  "browser_workflow_save",
  "browser_use_agent_wallet",
  "build_receipts",
  "build_state",
  "build_checkpoint",
  "build_complete",
  "build_receipt",
  "clock_now",
  "event_log",
  "environment",
  "fs_exists",
  "fs_grep",
  "fs_list_dir",
  "fs_read",
  "fs_read_binary",
  "fs_stat",
  "fs_unwatch",
  "fs_watch",
  "get_session_info",
  "goal_complete",
  "grok_environment",
  "host_read",
  "mem_delete",
  "mem_get",
  "mem_list",
  "mem_set",
  "model_instruction_cards",
  "preview_diagnose",
  "preview_logs",
  "preview_state",
  "preview_start",
  "process_attach_stdout",
  "process_list",
  "process_signal",
  "process_stats",
  "provider_adapters",
  "provider_sessions",
  "search_tool",
  "session_environment",
  "session_tooling",
  "shellx_health",
  "sleep_ms",
  "secret_delete",
  "secret_get",
  "secret_set",
  "security_scan",
  "send_prompt_to_provider",
  "send_prompt_to_session",
  "vault_agent_request",
  "vault_deposit",
  "vault_generate",
  "vault_list",
  "vault_list_grants",
  "vault_request_grant",
  "vision_describe",
  "vision_describe_v2",
  "voice_stt_v2",
  "voice_tts",
  "x_search",
  "net_fetch",
  "fs_append",
  "fs_copy",
  "fs_delete",
  "fs_ensure_dir",
  "fs_write",
  "host_act",
];
const mutationTools = new Set([
  "Agent", "Agent_kill", "browser_act", "browser_clear_site_data", "browser_click_at", "browser_click_ref", "browser_evaluation_write", "browser_fill_ref", "browser_flight_recorder_export", "browser_navigate", "browser_resolve_dialog",
  "browser_run_steps", "browser_save_page", "browser_screenshot", "browser_trace_open", "browser_type_text", "browser_workflow_replay", "browser_workflow_save", "build_checkpoint", "build_complete", "build_receipt", "fs_append", "fs_copy",
  "fs_delete", "fs_ensure_dir", "fs_watch", "fs_write", "goal_complete", "host_act", "mem_delete", "mem_set", "net_fetch",
  "process_signal", "secret_delete", "secret_set", "security_scan", "send_prompt_to_provider", "send_prompt_to_session",
  "preview_start",
  "vault_agent_request", "vault_generate", "vault_request_grant", "vision_describe", "vision_describe_v2", "voice_stt_v2", "voice_tts", "x_search",
  "browser_capture_secret_to_vault", "browser_read_email_code", "browser_use_agent_wallet",
]);
const browserTaskTools = new Set([
  "browser_act", "browser_clear_site_data", "browser_click_at", "browser_click_ref", "browser_extract", "browser_fill_ref",
  "browser_flight_recorder_export", "browser_navigate", "browser_observe", "browser_run_steps", "browser_save_page", "browser_screenshot", "browser_trace_open", "browser_type_text", "browser_verify", "browser_wait_for",
  "browser_capture_secret_to_vault", "browser_read_email_code", "browser_use_agent_wallet",
]);
let fixture: ChildProcess | null = null;

try {
  mkdirSync(shellxHome, { recursive: true, mode: 0o700 });
  writeFileSync(debugTokenPath, debugToken, { encoding: "utf8", mode: 0o600 });
  writeFileSync(mcpTokenPath, mcpToken, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-host-mcp-server-fixture.ts"),
    "--state-out", statePath,
    "--debug-token", debugToken,
    "--mcp-token", mcpToken,
    "--instance-id", instanceId,
    "--process-id", "4321",
    "--version", releaseSurfaceFixtureVersion,
    "--source-commit", sourceCommit,
    "--profile-root", profileRoot,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, fixture);
  const request: ReleaseSurfaceDriverRequest = {
    schema: RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA,
    mode: "final-frozen-candidate",
    driverId: "host-mcp-tool-installed",
    driverKind: "host-mcp-tool",
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: "a".repeat(64),
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture(
      "scripts/release-drivers/host-mcp-tool-installed.ts",
      ["scripts/release-drivers/host-mcp-vault-lifecycle.ts"],
    ),
    runtime: {
      processId: 4321,
      instanceId,
      debugBase: `http://127.0.0.1:${ports.debugPort}`,
      debugTokenPath,
      mcpBase: `http://127.0.0.1:${ports.mcpPort}`,
      mcpTokenPath,
      executableSha256: "d".repeat(64),
      installedPayloadPath: "/tmp/fixture/shellx",
      installedManifestSha256: "e".repeat(64),
      posixNative: releaseSurfacePosixNativeBindingFixture({
        processId: 4321,
        port: ports.debugPort,
        imagePath: "/tmp/fixture/shellx",
        imageSha256: "d".repeat(64),
      }),
    },
    assignments: toolNames.map((name) => ({
      surface: {
        id: `host-mcp-tool:${name}`,
        kind: "host-mcp-tool",
        name,
        source: "src-tauri/src/host_mcp/tool_specs_core.rs",
        platforms: ["windows-installed", "macos-installed", "linux-installed"],
        delivery: "installed-app",
      },
      fixtureId: ["browser_capture_secret_to_vault", "browser_read_email_code", "browser_use_agent_wallet"].includes(name)
        ? "host-mcp:installed-vault-e2e-browser-lifecycle"
        : name === "browser_rendered_check"
        ? "host-mcp:installed-browser-hidden-renderer-fixture"
        : name === "preview_start"
          ? "host-mcp:installed-preview-lifecycle-fixture"
        : browserTaskTools.has(name)
        ? "host-mcp:installed-browser-mutation-fixture"
        : mutationTools.has(name)
          ? "host-mcp:installed-mutation-fixture"
          : "host-mcp:installed-read-fixture",
      expectedEffect: mutationTools.has(name)
        ? `${name} performs its exact permission-gated installed mutation`
        : `${name} returns its exact bounded installed read contract`,
      oracleId: `host-mcp:${name}:installed-${mutationTools.has(name) ? "mutation" : "read"}-effect`,
      cleanupId: ["browser_capture_secret_to_vault", "browser_read_email_code", "browser_use_agent_wallet"].includes(name)
        ? "host-mcp:reset-isolated-vault-close-owned-browser-task-and-restore-autonomy"
        : name === "browser_rendered_check"
        ? "host-mcp:close-owned-browser-server"
        : name === "preview_start"
          ? "host-mcp:stop-owned-preview-and-delete-project"
        : browserTaskTools.has(name)
        ? "host-mcp:close-owned-browser-task-and-restore-autonomy"
        : name === "vault_generate"
          ? "host-mcp:delete-generated-vault-item-and-owned-mutation-fixture-and-restore-autonomy"
        : mutationTools.has(name)
          ? "host-mcp:delete-owned-mutation-fixture-and-restore-autonomy"
          : "host-mcp:delete-owned-read-fixture",
    })),
  };
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/host-mcp-tool-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(
    run.status,
    0,
    [run.stderr, run.stdout, existsSync(reportPath) ? readFileSync(reportPath, "utf8") : ""]
      .filter(Boolean)
      .join("\n"),
  );
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.deepEqual(validateReleaseSurfaceDriverReport(request, report), []);
  assert.equal(releaseSurfaceDriverReportPassed(report), true);
  assert.equal(report.outcomes.length, toolNames.length);
  assert(report.outcomes.every((outcome) => outcome.present === "pass"
    && outcome.invoke === "pass" && outcome.effect === "pass" && outcome.cleanup === "pass"));
  assert.equal(existsSync(join(profileRoot, "host-mcp-release-fixture")), false, "driver must remove its exact fixture root");
  const driverSource = readFileSync(
    resolve(root, "scripts/release-drivers/host-mcp-tool-installed.ts"),
    "utf8",
  );
  assert(
    driverSource.includes('writeFileSync(join(nodeRoot, ".git"), "gitdir: .shellx-release-missing-gitdir\\n", {'),
    "Host MCP release fixture must stop Git discovery at its exact owned boundary",
  );
  for (const name of ["flight-recorder.json", "screenshot.png", "trace.json"]) {
    assert.equal(
      existsSync(join(shellxHome, "browser-artifacts", "release-driver", name)),
      false,
      `driver must delete exact owned artifact ${name}`,
    );
  }

  const reportText = JSON.stringify(report);
  for (const forbidden of [
    "needle-release-035",
    "fixture-private-version",
    "fixture-private-task",
    "fixture-private-command",
    "fixture-private-card",
    "fixture-private-browser-tab",
    "fixture-browser-act-task-private",
    "fixture-browser-act-tab-private",
    "ShellX installed MCP write fixture",
    "append-effect",
    "ShellX compact host_act fixture",
    "ShellX bounded Host MCP memory fixture",
    "SHELLX_RELEASE_OWNED_STATIC_PREVIEW_035",
    "shellx-release-missing-agent",
    "fixture-private-tooling-row",
    "fixture-private-vault-key",
    "fixture-private-vault-request",
    "fixture-private-vault-resource",
    "fixture-private-redacted-result",
    "fixture-private-grant",
    "fixture-private-secret-ref",
    "fixture-private-page-text",
    "fixture-private-verification",
    "fixture-private-step",
    "fixture-private-active-task",
    "fixture-private-evidence",
    HOST_MCP_CAPTURE_FIXTURE_VALUE,
    HOST_MCP_EMAIL_CODE_FIXTURE,
    HOST_MCP_WALLET_FIXTURE_MARKER,
    "fixture-owned-vault-grant-1",
    "fixture-owned-vault-grant-2",
    "/fixture/private/download",
    "/fixture/private/evidence",
    "https://fixture.invalid/private",
    "/fixture/private/cwd",
    "/private/bin/codex",
    Buffer.from([0, 1, 2, 3, 0xfe, 0xff]).toString("base64"),
    mcpToken,
    debugToken,
  ]) {
    assert.equal(reportText.includes(forbidden), false, `release evidence retained forbidden Host MCP data: ${forbidden}`);
  }
  const listResponse = await fetch(`${request.runtime.mcpBase}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mcpToken}`,
      "Content-Type": "application/json",
      "MCP-Tab-Id": "fixture-list-check",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "fixture-list-check", method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(listResponse.status, 200);
  const listEnvelope = await listResponse.json() as {
    result: { tools: Array<{ name: string }> };
  };
  assert.deepEqual(
    listEnvelope.result.tools.map((tool) => tool.name).sort(),
    ["browser_act", "browser_read", "capabilities_summary", "host_act", "host_read", "search_tool"],
    "promoted hidden coverage must not re-expand the optimized always-advertised schema",
  );
  const auditResponse = await fetch(`${request.runtime.debugBase}/audit`, {
    headers: { Authorization: `Bearer ${debugToken}` },
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    calls: Array<{ name: string }>;
    autonomy: string;
    rendererTabOpen: boolean;
    browserTaskStatus: string | null;
    browserTabOpen: boolean;
    browserTaskStarts: number;
    memoryCount: number;
    previewStatus: string | null;
    previewUrl: string | null;
    vaultResourceCount: number;
    vaultGrantCount: number;
    vaultResetCount: number;
    browserReceiptKinds: string[];
  };
  assert.equal(audit.autonomy, "default", "driver must restore the exact pre-run autonomy mode");
  assert.equal(audit.rendererTabOpen, true, "driver must establish one real renderer baseline tab when the serial run has none");
  assert.equal(audit.browserTaskStatus, "aborted", "driver must terminalize its exact owned Browser task");
  assert.equal(audit.browserTabOpen, false, "driver must close its exact owned Browser tab");
  assert.equal(audit.browserTaskStarts, 1, "full Host MCP cohort must start exactly one owned Browser task");
  assert.equal(audit.memoryCount, 0, "driver must delete every exact owned memory key");
  assert.equal(audit.previewStatus, "stopped", "driver must stop its exact owned Work Preview");
  assert.equal(audit.previewUrl, null, "driver must clear the owned Work Preview loopback URL");
  assert.equal(audit.vaultResourceCount, 0, "driver must reset every exact disposable Vault resource");
  assert.equal(audit.vaultGrantCount, 0, "driver must reset every exact disposable Vault grant");
  assert.equal(audit.vaultResetCount, 2, "driver must establish and clean exactly one isolated Vault E2E lifecycle");
  assert.deepEqual(
    audit.browserReceiptKinds.filter((kind) => [
      "browserVaultDepositCreated",
      "browserEmailCodeRead",
      "browserAgentWalletCheckoutUnavailable",
    ].includes(kind)),
    ["browserVaultDepositCreated", "browserEmailCodeRead", "browserAgentWalletCheckoutUnavailable"],
    "Host MCP Vault lifecycle must record capture, email-code, and typed wallet-unavailable receipts",
  );
  const called = new Set(audit.calls.map((call) => call.name));
  for (const name of toolNames) assert(called.has(name), `driver did not invoke exact Host MCP tool ${name}`);
  assert.equal(
    audit.calls.filter((call) => call.name === "search_tool").length,
    toolNames.length - 5,
    "every hidden direct tool must be discovered through the optimized catalog before its exact call",
  );

  const hiddenRendererRequest = structuredClone(request);
  hiddenRendererRequest.assignments = request.assignments.filter((assignment) => (
    assignment.surface.name === "browser_rendered_check"
  ));
  const hiddenRendererRequestPath = join(tempParent, "hidden-renderer-request.json");
  const hiddenRendererReportPath = join(tempParent, "hidden-renderer-report.json");
  writeFileSync(hiddenRendererRequestPath, `${JSON.stringify(hiddenRendererRequest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const hiddenRendererRun = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/host-mcp-tool-installed.ts"),
    "--request", hiddenRendererRequestPath,
    "--out", hiddenRendererReportPath,
  ], { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(hiddenRendererRun.status, 0, hiddenRendererRun.stderr || hiddenRendererRun.stdout);
  const hiddenRendererReport = JSON.parse(readFileSync(hiddenRendererReportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.deepEqual(validateReleaseSurfaceDriverReport(hiddenRendererRequest, hiddenRendererReport), []);
  assert.equal(releaseSurfaceDriverReportPassed(hiddenRendererReport), true);
  const postHiddenAuditResponse = await fetch(`${request.runtime.debugBase}/audit`, {
    headers: { Authorization: `Bearer ${debugToken}` },
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(postHiddenAuditResponse.status, 200);
  const postHiddenAudit = await postHiddenAuditResponse.json() as { autonomy: string; browserTaskStarts: number };
  assert.equal(postHiddenAudit.autonomy, "default", "hidden-renderer-only proof must not change autonomy");
  assert.equal(postHiddenAudit.browserTaskStarts, 1, "hidden-renderer-only proof must not create a visible Browser task");

  const unsafeRequest = structuredClone(request);
  unsafeRequest.runtime.mcpTokenPath = join(tempParent, "outside-profile-mcp.token");
  writeFileSync(unsafeRequest.runtime.mcpTokenPath, mcpToken, { encoding: "utf8", mode: 0o600 });
  const unsafeRequestPath = join(tempParent, "unsafe-request.json");
  const unsafeReportPath = join(tempParent, "unsafe-report.json");
  writeFileSync(unsafeRequestPath, `${JSON.stringify(unsafeRequest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const unsafeRun = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/host-mcp-tool-installed.ts"),
    "--request", unsafeRequestPath,
    "--out", unsafeReportPath,
  ], { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.notEqual(unsafeRun.status, 0, "Host MCP driver must reject fixture roots outside the exact final profile");
  assert.match(unsafeRun.stderr, /exact disposable final-run profile token path/);
  assert.equal(existsSync(unsafeReportPath), false);
  assert.equal(existsSync(join(tempParent, "host-mcp-release-fixture")), false);
} finally {
  if (fixture && fixture.exitCode === null) {
    fixture.kill("SIGTERM");
    await new Promise<void>((resolveExit) => fixture!.once("exit", () => resolveExit()));
  }
  rmSync(tempParent, { recursive: true, force: true });
}

console.log(`Release surface Host MCP driver tests passed (${toolNames.length} exact read/mutation tools)`);

async function waitForPorts(
  path: string,
  child: ChildProcess,
): Promise<{ debugPort: number; mcpPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (Number.isSafeInteger(value.debugPort) && Number(value.debugPort) > 0
        && Number.isSafeInteger(value.mcpPort) && Number(value.mcpPort) > 0) {
        return { debugPort: Number(value.debugPort), mcpPort: Number(value.mcpPort) };
      }
    }
    if (child.exitCode !== null) {
      const stderr = await readStream(child.stderr);
      throw new Error(`Host MCP fixture exited early with ${child.exitCode}: ${stderr}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Host MCP fixture did not publish both ports");
}

async function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
