import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ShellxDebugApiConnection } from "../shellx-debug-paths";
import { cleanupOwnedBrowserLifecycle } from "../shellx-browser-test-cleanup";
import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverOutcome,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  HOST_MCP_VAULT_CLEANUP_ID,
  HOST_MCP_VAULT_FIXTURE_ID,
  HOST_MCP_VAULT_LIFECYCLE_TOOLS,
  HOST_MCP_CAPTURE_FIXTURE_VALUE,
  cleanupHostMcpVaultLifecycle,
  createHostMcpVaultLifecycle,
  exerciseHostMcpWalletUnavailable,
  hostMcpVaultArguments,
  prepareHostMcpVaultLifecycle,
  verifyHostMcpVaultResult,
  type HostMcpVaultLifecycleState,
} from "./host-mcp-vault-lifecycle";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "host-mcp-tool-installed",
  kind: "host-mcp-tool",
  runtimeBinding: "attested-process",
  invocationTransport: "process-cli",
  controllerFiles: ["scripts/release-drivers/host-mcp-vault-lifecycle.ts"],
  supportedFixtures: [
    "host-mcp:installed-read-fixture",
    "host-mcp:installed-mutation-fixture",
    "host-mcp:installed-browser-mutation-fixture",
    "host-mcp:installed-browser-hidden-renderer-fixture",
    "host-mcp:installed-preview-lifecycle-fixture",
    HOST_MCP_VAULT_FIXTURE_ID,
  ],
  supportedCleanups: [
    "host-mcp:delete-owned-read-fixture",
    "host-mcp:delete-owned-mutation-fixture-and-restore-autonomy",
    "host-mcp:delete-generated-vault-item-and-owned-mutation-fixture-and-restore-autonomy",
    "host-mcp:close-owned-browser-task-and-restore-autonomy",
    "host-mcp:close-owned-browser-server",
    "host-mcp:stop-owned-preview-and-delete-project",
    HOST_MCP_VAULT_CLEANUP_ID,
  ],
  supportedOracles: [
    "host-mcp:Agent_metrics:installed-read-effect",
    "host-mcp:Agent_output:installed-read-effect",
    "host-mcp:Agent_poll_all:installed-read-effect",
    "host-mcp:Agent_status:installed-read-effect",
    "host-mcp:capabilities_summary:installed-read-effect",
    "host-mcp:cut_read:installed-read-effect",
    "host-mcp:browser_locks:installed-read-effect",
    "host-mcp:browser_check:installed-read-effect",
    "host-mcp:browser_downloads:installed-read-effect",
    "host-mcp:browser_evidence:installed-read-effect",
    "host-mcp:browser_extract:installed-read-effect",
    "host-mcp:browser_observe:installed-read-effect",
    "host-mcp:browser_read:installed-read-effect",
    "host-mcp:browser_rendered_check:installed-read-effect",
    "host-mcp:browser_state:installed-read-effect",
    "host-mcp:browser_tabs:installed-read-effect",
    "host-mcp:browser_workflows:installed-read-effect",
    "host-mcp:browser_verify:installed-read-effect",
    "host-mcp:browser_wait_for:installed-read-effect",
    "host-mcp:build_receipts:installed-read-effect",
    "host-mcp:build_state:installed-read-effect",
    "host-mcp:clock_now:installed-read-effect",
    "host-mcp:environment:installed-read-effect",
    "host-mcp:event_log:installed-read-effect",
    "host-mcp:fs_exists:installed-read-effect",
    "host-mcp:fs_grep:installed-read-effect",
    "host-mcp:fs_list_dir:installed-read-effect",
    "host-mcp:fs_read:installed-read-effect",
    "host-mcp:fs_read_binary:installed-read-effect",
    "host-mcp:fs_stat:installed-read-effect",
    "host-mcp:fs_unwatch:installed-read-effect",
    "host-mcp:grok_environment:installed-read-effect",
    "host-mcp:get_session_info:installed-read-effect",
    "host-mcp:host_read:installed-read-effect",
    "host-mcp:mem_get:installed-read-effect",
    "host-mcp:mem_list:installed-read-effect",
    "host-mcp:model_instruction_cards:installed-read-effect",
    "host-mcp:preview_diagnose:installed-read-effect",
    "host-mcp:preview_logs:installed-read-effect",
    "host-mcp:preview_state:installed-read-effect",
    "host-mcp:process_attach_stdout:installed-read-effect",
    "host-mcp:process_list:installed-read-effect",
    "host-mcp:process_stats:installed-read-effect",
    "host-mcp:provider_adapters:installed-read-effect",
    "host-mcp:provider_sessions:installed-read-effect",
    "host-mcp:search_tool:installed-read-effect",
    "host-mcp:session_environment:installed-read-effect",
    "host-mcp:session_tooling:installed-read-effect",
    "host-mcp:shellx_health:installed-read-effect",
    "host-mcp:sleep_ms:installed-read-effect",
    "host-mcp:secret_get:installed-read-effect",
    "host-mcp:vault_deposit:installed-read-effect",
    "host-mcp:vault_list:installed-read-effect",
    "host-mcp:vault_list_grants:installed-read-effect",
    "host-mcp:Agent_kill:installed-mutation-effect",
    "host-mcp:Agent:installed-mutation-effect",
    "host-mcp:browser_click_at:installed-mutation-effect",
    "host-mcp:browser_clear_site_data:installed-mutation-effect",
    "host-mcp:browser_evaluation_write:installed-mutation-effect",
    "host-mcp:browser_flight_recorder_export:installed-mutation-effect",
    "host-mcp:browser_click_ref:installed-mutation-effect",
    "host-mcp:browser_fill_ref:installed-mutation-effect",
    "host-mcp:browser_navigate:installed-mutation-effect",
    "host-mcp:browser_resolve_dialog:installed-mutation-effect",
    "host-mcp:browser_run_steps:installed-mutation-effect",
    "host-mcp:browser_save_page:installed-mutation-effect",
    "host-mcp:browser_screenshot:installed-mutation-effect",
    "host-mcp:browser_type_text:installed-mutation-effect",
    "host-mcp:browser_trace_open:installed-mutation-effect",
    "host-mcp:browser_workflow_replay:installed-mutation-effect",
    "host-mcp:browser_workflow_save:installed-mutation-effect",
    "host-mcp:fs_append:installed-mutation-effect",
    "host-mcp:fs_copy:installed-mutation-effect",
    "host-mcp:fs_delete:installed-mutation-effect",
    "host-mcp:fs_ensure_dir:installed-mutation-effect",
    "host-mcp:fs_write:installed-mutation-effect",
    "host-mcp:fs_watch:installed-mutation-effect",
    "host-mcp:host_act:installed-mutation-effect",
    "host-mcp:cut_act:installed-mutation-effect",
    "host-mcp:mem_delete:installed-mutation-effect",
    "host-mcp:mem_set:installed-mutation-effect",
    "host-mcp:browser_act:installed-mutation-effect",
    "host-mcp:build_checkpoint:installed-mutation-effect",
    "host-mcp:build_complete:installed-mutation-effect",
    "host-mcp:build_receipt:installed-mutation-effect",
    "host-mcp:goal_complete:installed-mutation-effect",
    "host-mcp:net_fetch:installed-mutation-effect",
    "host-mcp:process_signal:installed-mutation-effect",
    "host-mcp:secret_delete:installed-mutation-effect",
    "host-mcp:secret_set:installed-mutation-effect",
    "host-mcp:security_scan:installed-mutation-effect",
    "host-mcp:send_prompt_to_provider:installed-mutation-effect",
    "host-mcp:send_prompt_to_session:installed-mutation-effect",
    "host-mcp:vault_agent_request:installed-mutation-effect",
    "host-mcp:vault_generate:installed-mutation-effect",
    "host-mcp:vault_request_grant:installed-mutation-effect",
    "host-mcp:vision_describe:installed-mutation-effect",
    "host-mcp:vision_describe_v2:installed-mutation-effect",
    "host-mcp:voice_stt_v2:installed-mutation-effect",
    "host-mcp:voice_tts:installed-mutation-effect",
    "host-mcp:x_search:installed-mutation-effect",
    "host-mcp:preview_start:installed-mutation-effect",
    "host-mcp:browser_capture_secret_to_vault:installed-mutation-effect",
    "host-mcp:browser_read_email_code:installed-mutation-effect",
    "host-mcp:browser_use_agent_wallet:installed-mutation-effect",
  ],
};

const SUPPORTED_TOOLS = new Set(manifest.supportedOracles.map((oracle) => (
  oracle.replace(/^host-mcp:/, "").replace(/:installed-(?:read|mutation)-effect$/, "")
)));
const TEXT_FIXTURE = "ShellX Host MCP release fixture\nneedle-release-035\n";
const BINARY_FIXTURE = Buffer.from([0, 1, 2, 3, 0xfe, 0xff]);

interface McpConnection {
  base: string;
  baseToken: string;
  mutationToken?: string;
  tabId: string;
}

interface FixturePaths {
  platform: ReleaseSurfaceDriverRequest["platform"];
  nodeRoot: string;
  launchRoot: string;
  textNodePath: string;
  textLaunchPath: string;
  binaryNodePath: string;
  binaryLaunchPath: string;
  appendNodePath: string;
  appendLaunchPath: string;
  copyNodePath: string;
  copyLaunchPath: string;
  deleteNodePath: string;
  deleteLaunchPath: string;
  ensureDirNodePath: string;
  ensureDirLaunchPath: string;
  writeNodePath: string;
  writeLaunchPath: string;
  gatewayNodePath: string;
  gatewayLaunchPath: string;
  previewEntryNodePath: string;
  previewEntryLaunchPath: string;
  previewTabId: string;
  memoryNamespace: string;
  memoryDeleteKey: string;
  memoryMissingKey: string;
  memoryListPrefix: string;
  memorySetKey: string;
  vaultGeneratedItemId: string;
  vaultGenerateCommitted: boolean;
  watchId: string | null;
  artifactNodePaths: Set<string>;
}

interface AutonomyLease {
  debugBase: string;
  debugToken: string;
  tabId: string;
  previousMode: string;
  seededRendererBaseline: boolean;
}

interface BrowserMutationFixture {
  taskId: string | null;
  targetUrl: string;
  server: Server;
  sockets: Set<Socket>;
}

const MUTATION_TOOLS = new Set([
  "Agent",
  "Agent_kill",
  "browser_act",
  "cut_act",
  "browser_clear_site_data",
  "browser_evaluation_write",
  "browser_flight_recorder_export",
  "browser_click_at",
  "browser_click_ref",
  "browser_fill_ref",
  "browser_navigate",
  "browser_resolve_dialog",
  "browser_run_steps",
  "browser_save_page",
  "browser_screenshot",
  "browser_type_text",
  "browser_trace_open",
  "browser_workflow_replay",
  "browser_workflow_save",
  "build_checkpoint",
  "build_complete",
  "build_receipt",
  "fs_append",
  "fs_copy",
  "fs_delete",
  "fs_ensure_dir",
  "fs_watch",
  "fs_write",
  "host_act",
  "goal_complete",
  "mem_delete",
  "mem_set",
  "net_fetch",
  "process_signal",
  "preview_start",
  "secret_delete",
  "secret_set",
  "security_scan",
  "send_prompt_to_provider",
  "send_prompt_to_session",
  "vault_agent_request",
  "vault_generate",
  "vault_request_grant",
  "vision_describe",
  "vision_describe_v2",
  "voice_stt_v2",
  "voice_tts",
  "x_search",
  "browser_capture_secret_to_vault",
  "browser_read_email_code",
  "browser_use_agent_wallet",
]);
const BROWSER_OWNED_FIXTURE_TOOLS = new Set([
  "browser_act",
  "browser_clear_site_data",
  "browser_click_at",
  "browser_click_ref",
  "browser_extract",
  "browser_flight_recorder_export",
  "browser_fill_ref",
  "browser_navigate",
  "browser_observe",
  "browser_run_steps",
  "browser_save_page",
  "browser_screenshot",
  "browser_type_text",
  "browser_trace_open",
  "browser_verify",
  "browser_wait_for",
  "browser_capture_secret_to_vault",
  "browser_read_email_code",
  "browser_use_agent_wallet",
]);
const WRITE_CONTENT = "ShellX installed MCP write fixture\n";
const APPEND_BASE = "append-base\n";
const APPEND_CONTENT = "append-effect\n";
const GATEWAY_CONTENT = "ShellX compact host_act fixture\n";
const MEMORY_CONTENT = "ShellX bounded Host MCP memory fixture\n";
const MISSING_AGENT_ID = "shellx-release-missing-agent";
const MISSING_PROCESS_TASK_ID = "shellx-release-missing-process";
const EXPECTED_TOOL_ERRORS = new Map<string, string>([
  ["Agent", "Agent: missing 'subagent_type'"],
  ["Agent_kill", "Agent_kill: bad subagent_id"],
  ["Agent_output", "Agent_output: bad subagent_id"],
  ["Agent_status", "Agent_status: bad subagent_id"],
  ["browser_evaluation_write", "browser_evaluation_write: missing taskId"],
  ["browser_resolve_dialog", "browser_resolve_dialog: missing dialogId"],
  ["browser_workflow_replay", "browser_workflow_replay requires recipePath or bookmarkId with recipePath"],
  ["browser_workflow_save", "browser_workflow_save requires label"],
  ["build_checkpoint", "git repository"],
  ["build_complete", "no active"],
  ["build_receipt", "build_receipt: no active /build run for this tab"],
  ["goal_complete", "no /goal active for this tab"],
  ["process_attach_stdout", "unknown taskId:"],
  ["process_signal", "unknown taskId:"],
  ["process_stats", "unknown taskId:"],
  ["secret_delete", "secret_delete: removing pass-store entries"],
  ["secret_set", "secret_set: writing to the pass-store"],
  ["send_prompt_to_provider", "send_prompt_to_provider requires userApproved=true"],
  ["send_prompt_to_session", "send_prompt_to_session requires userApproved=true"],
  ["vault_request_grant", "vault_request_grant refuses rawReveal"],
  ["vision_describe", "vision_describe: empty path"],
  ["vision_describe_v2", "vision_describe: empty path"],
  ["voice_stt_v2", "voice_stt_v2: missing 'audio_path'"],
  ["voice_tts", "voice_tts: text is empty"],
  ["x_search", "x_search: query is empty"],
]);
const COMPATIBILITY_ALIAS_OF = new Map<string, string>([
  ["session_environment", "environment"],
  ["vision_describe_v2", "vision_describe"],
]);

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const debugConnection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const connection = readMcpConnection(request);
  const fixtures = createFixtures(request);
  const outcomes: ReleaseSurfaceDriverOutcome[] = [];
  const memoryMutationRequested = request.assignments.some((assignment) => (
    assignment.surface.name === "mem_delete" || assignment.surface.name === "mem_set"
  ));
  let autonomyLease: AutonomyLease | null = null;
  let browserFixture: BrowserMutationFixture | null = null;
  let vaultLifecycle: HostMcpVaultLifecycleState | null = null;
  try {
    if (request.assignments.some((assignment) => (
      MUTATION_TOOLS.has(assignment.surface.name) || BROWSER_OWNED_FIXTURE_TOOLS.has(assignment.surface.name)
    ))) {
      autonomyLease = await acquireMutationAutonomy(debugConnection.base, debugConnection.token, connection);
    }
    const needsOwnedBrowserTask = request.assignments.some((assignment) => (
      BROWSER_OWNED_FIXTURE_TOOLS.has(assignment.surface.name)
    ));
    const needsBrowserServer = needsOwnedBrowserTask || request.assignments.some((assignment) => (
      assignment.surface.name === "browser_rendered_check"
    ));
    if (needsOwnedBrowserTask) {
      if (!autonomyLease) throw new Error("Browser Host MCP fixture requires a tab-scoped autonomy lease");
    }
    if (needsBrowserServer) {
      browserFixture = await startBrowserMutationFixture(
        debugConnection,
        autonomyLease?.tabId ?? connection.tabId,
        needsOwnedBrowserTask,
      );
    }
    if (request.assignments.some((assignment) => HOST_MCP_VAULT_LIFECYCLE_TOOLS.has(assignment.surface.name))) {
      vaultLifecycle = createHostMcpVaultLifecycle(request.runtime.instanceId);
      await prepareHostMcpVaultLifecycle(
        vaultLifecycle,
        (path, body, headers, timeoutMs) => debugJson(
          debugConnection.base,
          debugConnection.token,
          path,
          body,
          headers,
          timeoutMs,
        ),
        new URL(requiredString(browserFixture?.targetUrl, "Host MCP Vault browser fixture URL")).origin,
      );
    }
    const advertised = await advertisedToolNames(connection);
    for (const assignment of request.assignments) {
      outcomes.push(await exerciseTool(
        debugConnection,
        connection,
        fixtures,
        browserFixture,
        vaultLifecycle,
        request,
        assignment,
        advertised,
      ));
    }
  } finally {
    const cleanupErrors = [
      vaultLifecycle
        ? await cleanupHostMcpVaultLifecycle(
          vaultLifecycle,
          (path, body, headers, timeoutMs) => debugJson(
            debugConnection.base,
            debugConnection.token,
            path,
            body,
            headers,
            timeoutMs,
          ),
        )
        : null,
      browserFixture
        ? await cleanupBrowserMutationFixture(
          debugConnection,
          browserFixture,
          autonomyLease?.tabId ?? connection.tabId,
        )
        : null,
      memoryMutationRequested && autonomyLease
        ? await cleanupMemoryFixtures(connection, fixtures)
        : null,
      fixtures.watchId ? await cleanupWatchFixture(connection, fixtures) : null,
      request.assignments.some((assignment) => assignment.surface.name === "preview_start")
        ? await cleanupHostPreviewFixture(debugConnection, fixtures)
        : null,
      fixtures.vaultGenerateCommitted ? await cleanupGeneratedVaultItem(connection, fixtures) : null,
      cleanupArtifactFixtures(fixtures),
      cleanupFixtures(fixtures),
      autonomyLease ? await restoreMutationAutonomy(autonomyLease) : null,
    ].filter((value): value is string => Boolean(value));
    const cleanupError = cleanupErrors.length > 0 ? cleanupErrors.join("; ") : null;
    for (const outcome of outcomes) {
      if (!cleanupError) {
        outcome.cleanup = "pass";
      } else {
        outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
      }
    }
  }
  return {
    schema: RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
    mode: request.mode,
    driverId: request.driverId,
    driverKind: request.driverKind,
    platform: request.platform,
    sourceCommit: request.sourceCommit,
    version: request.version,
    inventoryDigest: request.inventoryDigest,
    artifactSha256: request.artifact.sha256,
    controller: request.controller,
    runtime: request.runtime,
    startedAt,
    completedAt: completionTimestamp(startedAt),
    outcomes,
  };
}

async function exerciseTool(
  debugConnection: ShellxDebugApiConnection,
  connection: McpConnection,
  fixtures: FixturePaths,
  browserFixture: BrowserMutationFixture | null,
  vaultLifecycle: HostMcpVaultLifecycleState | null,
  request: ReleaseSurfaceDriverRequest,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
  advertised: Set<string>,
): Promise<ReleaseSurfaceDriverOutcome> {
  const name = assignment.surface.name;
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No installed Host MCP result was observed.",
  };
  try {
    if (!SUPPORTED_TOOLS.has(name)) throw new Error(`installed Host MCP read fixture does not support ${name}`);
    if (advertised.has(name)) {
      outcome.present = "pass";
    } else {
      const searchableName = COMPATIBILITY_ALIAS_OF.get(name) ?? name;
      const discovery = await callTool(connection, "search_tool", { query: searchableName, limit: 5 });
      const tools = requireArray(discovery, "tools", "search_tool discovery");
      if (!tools.some((tool) => isRecord(tool) && tool.name === searchableName && isRecord(tool.inputSchema))) {
        throw new Error(`${name} was absent from the searchable Host MCP catalog`);
      }
      outcome.present = "pass";
    }
    if (name === "mem_delete") {
      await callTool(connection, "mem_set", {
        namespace: fixtures.memoryNamespace,
        key: fixtures.memoryDeleteKey,
        value: MEMORY_CONTENT,
      }, true);
    }
    if (name === "browser_clear_site_data") {
      if (!browserFixture?.taskId) throw new Error("browser_clear_site_data is missing its owned Browser task fixture");
      const navigated = await callTool(connection, "browser_navigate", {
        taskId: browserFixture.taskId,
        url: browserFixture.targetUrl,
        timeoutMs: 30_000,
      }, true);
      if (navigated.ok !== true || navigated.taskId !== browserFixture.taskId
        || navigated.currentUrl !== browserFixture.targetUrl) {
        throw new Error("browser_clear_site_data could not prepare its exact owned loopback origin");
      }
    }
    if (name === "browser_click_at" || name === "browser_type_text") {
      if (!browserFixture?.taskId) throw new Error(`${name} is missing its owned Browser task fixture`);
      const navigated = await callTool(connection, "browser_navigate", {
        taskId: browserFixture.taskId,
        url: browserFixture.targetUrl,
        timeoutMs: 30_000,
      }, true);
      if (navigated.ok !== true || navigated.taskId !== browserFixture.taskId
        || navigated.currentUrl !== browserFixture.targetUrl) {
        throw new Error(`${name} could not reset its exact owned coordinate fixture`);
      }
    }
    if (HOST_MCP_VAULT_LIFECYCLE_TOOLS.has(name)) {
      if (!vaultLifecycle || !browserFixture?.taskId) {
        throw new Error(`${name} is missing its isolated Vault E2E and owned Browser fixtures`);
      }
      const vaultDebugJson = (path: string, body?: Record<string, unknown>) => debugJson(
        debugConnection.base,
        debugConnection.token,
        path,
        body,
      );
      if (name === "browser_use_agent_wallet") {
        outcome.observedEffect = await exerciseHostMcpWalletUnavailable(
          vaultLifecycle,
          browserFixture.taskId,
          (tool, args, expectedSubstring, mutation) => callToolExpectingError(
            connection,
            tool,
            args,
            expectedSubstring,
            mutation,
          ),
          vaultDebugJson,
        );
      } else {
        const vaultArgs = hostMcpVaultArguments(name, vaultLifecycle, browserFixture.taskId);
        if (name === "browser_capture_secret_to_vault") {
          await callTool(connection, "browser_observe", {
            taskId: browserFixture.taskId,
            fullObservation: true,
          });
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
          const observed = await callTool(connection, "browser_observe", {
            taskId: browserFixture.taskId,
            fullObservation: true,
          });
          const observation = isRecord(observed.observation) ? observed.observation : null;
          const refs = observation && Array.isArray(observation.refs) ? observation.refs : [];
          const secretRef = refs.filter(isRecord).find((entry) => (
            entry.action === "capturePageSecretToVault" && entry.selector === "#capturable-secret"
          ));
          if (!secretRef || typeof secretRef.refId !== "string" || !secretRef.refId) {
            throw new Error("browser_capture_secret_to_vault did not discover its redacted owned ref");
          }
          delete vaultArgs.selector;
          vaultArgs.refId = secretRef.refId;
          await callTool(connection, "browser_wait_for", {
            taskId: browserFixture.taskId,
            selector: "#capturable-secret",
            timeoutMs: 5_000,
          });
        }
        const result = await callTool(
          connection,
          name,
          vaultArgs,
          true,
        );
        outcome.observedEffect = await verifyHostMcpVaultResult(
          name,
          result,
          vaultLifecycle,
          browserFixture.taskId,
          vaultDebugJson,
        );
      }
      outcome.invoke = "pass";
      outcome.effect = "pass";
      return outcome;
    }
    const expectedError = EXPECTED_TOOL_ERRORS.get(name);
    if (expectedError) {
      await callToolExpectingError(
        connection,
        name,
        argumentsFor(name, fixtures, browserFixture),
        expectedError,
        MUTATION_TOOLS.has(name),
      );
      outcome.invoke = "pass";
      outcome.observedEffect = expectedSafetyEffect(name);
      outcome.effect = "pass";
      return outcome;
    }
    if (name === "preview_diagnose") {
      const beforePreview = await callTool(connection, "preview_state", {});
      const beforeBuild = await callTool(connection, "build_state", {});
      const result = await callToolExpectingStructuredFailure(
        connection,
        name,
        argumentsFor(name, fixtures, browserFixture),
      );
      outcome.invoke = "pass";
      outcome.observedEffect = await verifyEffect(name, result, fixtures, browserFixture, request, connection);
      const afterPreview = await callTool(connection, "preview_state", {});
      const afterBuild = await callTool(connection, "build_state", {});
      if (stableHostMcpPreviewState(beforePreview, connection.tabId)
        !== stableHostMcpPreviewState(afterPreview, connection.tabId)) {
        throw new Error("preview_diagnose changed the unique disposable tab's idle Preview state");
      }
      requireExactKeys(beforeBuild, ["state", "tabId"], "preview_diagnose Build baseline");
      requireExactKeys(afterBuild, ["state", "tabId"], "preview_diagnose Build readback");
      if (JSON.stringify(beforeBuild) !== JSON.stringify(afterBuild)
        || beforeBuild.tabId !== connection.tabId || beforeBuild.state !== null) {
        throw new Error("preview_diagnose created or changed Build state for the unique disposable tab");
      }
      outcome.effect = "pass";
      return outcome;
    }
    if (name === "cut_read" || name === "cut_act") {
      const mutation = name === "cut_act";
      const result = await mcpRequest(
        connection,
        "tools/call",
        { name, arguments: argumentsFor(name, fixtures, browserFixture) },
        mutation,
      );
      const structured = isRecord(result.structuredContent) ? result.structuredContent : null;
      const text = requireArray(result, "content", `${name} result`)
        .filter(isRecord)
        .map((entry) => entry.text)
        .find((value): value is string => typeof value === "string") ?? "";
      if (result.isError === true) {
        const honestUnavailable = text.includes("ShellX Cut is not installed")
          || text.includes("ShellX Cut MCP")
          || text.includes("cutd");
        const typedCutFailure = structured?.ok === false
          && (typeof structured.error === "string" || isRecord(structured.error));
        if (!honestUnavailable && !typedCutFailure) {
          throw new Error(`${name} returned an unclassified ShellX Cut failure`);
        }
        outcome.observedEffect = mutation
          ? "Host MCP permission-gated cut_act and returned the exact installed/running Cut availability result without changing a video project."
          : "Host MCP returned the exact installed/running ShellX Cut availability result without starting an editor or changing a video project.";
      } else {
        if (!structured || structured.ok !== true) {
          throw new Error(`${name} successful Cut result omitted the typed Cut envelope`);
        }
        outcome.observedEffect = mutation
          ? "Host MCP permission-gated cut_act and reached system.doctor through the running Cut MCP engine without changing a video project."
          : "Host MCP cut_read reached system.doctor through the running Cut MCP engine without changing a video project.";
      }
      outcome.invoke = "pass";
      outcome.effect = "pass";
      return outcome;
    }
    if (name === "preview_start") {
      const result = await callTool(
        connection,
        name,
        argumentsFor(name, fixtures, browserFixture),
        true,
      );
      outcome.invoke = "pass";
      outcome.observedEffect = await verifyEffect(
        name,
        result,
        fixtures,
        browserFixture,
        request,
        connection,
      );
      const readback = await debugJson(
        debugConnection.base,
        debugConnection.token,
        `/preview/work/state?tabId=${encodeURIComponent(fixtures.previewTabId)}`,
      );
      const resultUrl = verifyHostMcpRunningPreviewState(result, fixtures, "preview_start result");
      const readbackUrl = verifyHostMcpRunningPreviewState(readback, fixtures, "preview_start Debug readback");
      if (resultUrl !== readbackUrl) throw new Error("preview_start result and Debug state named different loopback endpoints");
      await verifyHostMcpPreviewPage(resultUrl);
      outcome.effect = "pass";
      return outcome;
    }
    if (name === "vault_generate") {
      const args = argumentsFor(name, fixtures, browserFixture);
      let result: Record<string, unknown>;
      try {
        result = await callTool(connection, name, args, true);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.includes("Vault is not configured") || detail.includes("Vault is locked")) {
          outcome.invoke = "pass";
          outcome.observedEffect = "Host MCP permission-gated vault_generate and returned its exact pre-write Vault availability refusal without generating, storing, or exposing a secret.";
          outcome.effect = "pass";
          return outcome;
        }
        throw error;
      }
      outcome.invoke = "pass";
      outcome.observedEffect = await verifyEffect(
        name,
        result,
        fixtures,
        browserFixture,
        request,
        connection,
      );
      const refused = await callTool(connection, name, args, true);
      if (refused.ok !== false || refused.status !== "refused"
        || refused.code !== "VAULT_GENERATE_ITEM_EXISTS"
        || refused.itemId !== fixtures.vaultGeneratedItemId
        || refused.secretExposed !== false || refused.isError !== true
        || "value" in refused || "password" in refused) {
        throw new Error("vault_generate repeat did not prove exact create-only overwrite refusal");
      }
      outcome.observedEffect += " A repeated request was refused without replacing or exposing the stored item.";
      outcome.effect = "pass";
      return outcome;
    }
    const result = await callTool(connection, name, argumentsFor(name, fixtures, browserFixture), MUTATION_TOOLS.has(name));
    outcome.invoke = "pass";
    outcome.observedEffect = await verifyEffect(name, result, fixtures, browserFixture, request, connection);
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}

function argumentsFor(
  name: string,
  fixtures: FixturePaths,
  browserFixture: BrowserMutationFixture | null,
): Record<string, unknown> {
  switch (name) {
    case "Agent_kill":
    case "Agent_output":
    case "Agent_status": return { subagent_id: MISSING_AGENT_ID };
    case "Agent":
    case "browser_evaluation_write":
    case "browser_resolve_dialog":
    case "browser_workflow_replay":
    case "browser_workflow_save": return {};
    case "environment":
    case "grok_environment":
    case "session_environment": return { force: false };
    case "Agent_poll_all": return { subagent_ids: [MISSING_AGENT_ID] };
    case "browser_workflows": return { limit: 3 };
    case "browser_check": return { timeoutMs: 0 };
    case "browser_downloads": return {};
    case "browser_evidence": return { limit: 3 };
    case "browser_rendered_check": {
      if (!browserFixture) throw new Error("browser_rendered_check is missing its owned loopback server fixture");
      return {
        url: browserFixture.targetUrl,
        expectText: "Action target ready",
        titleIncludes: "ShellX Host MCP Browser fixture",
        selector: "#advance",
        expectedDomains: ["127.0.0.1"],
        timeoutMs: 30_000,
      };
    }
    case "clock_now": return { tz: "utc" };
    case "event_log": return { limit: 3 };
    case "preview_diagnose": return { browserEvents: [] };
    case "preview_start": return {
      tabId: fixtures.previewTabId,
      cwd: fixtures.launchRoot,
      kind: "static",
      entry: "release-preview.html",
    };
    case "fs_exists":
    case "fs_stat": return { path: fixtures.textLaunchPath };
    case "fs_read": return { path: fixtures.textLaunchPath, max_bytes: 4_096 };
    case "fs_read_binary": return { path: fixtures.binaryLaunchPath, max_bytes: 4_096 };
    case "fs_list_dir": return { path: fixtures.launchRoot, max_entries: 10 };
    case "fs_grep": return { path: fixtures.launchRoot, pattern: "needle-release-035", glob: "fixture.txt", max_matches: 5 };
    case "fs_unwatch": return { watchId: `${fixtures.memoryNamespace}-missing-watch` };
    case "fs_watch": return { path: fixtures.launchRoot, recursive: false, debounce_ms: 50 };
    case "host_read": return { action: "fs_read", params: { path: fixtures.textLaunchPath, max_bytes: 4_096 } };
    case "host_act": return { action: "fs_write", params: { path: fixtures.gatewayLaunchPath, content: GATEWAY_CONTENT } };
    case "cut_read": return { action: "status", timeoutMs: 30_000 };
    case "cut_act": return { verb: "system_doctor", arguments: {}, timeoutMs: 30_000 };
    case "mem_delete": return { namespace: fixtures.memoryNamespace, key: fixtures.memoryDeleteKey };
    case "mem_get": return { namespace: fixtures.memoryNamespace, key: fixtures.memoryMissingKey };
    case "mem_list": return { namespace: fixtures.memoryNamespace, prefix: fixtures.memoryListPrefix };
    case "mem_set": return { namespace: fixtures.memoryNamespace, key: fixtures.memorySetKey, value: MEMORY_CONTENT };
    case "net_fetch": return { url: "http://169.254.169.254/shellx-release-denied", method: "GET" };
    case "process_attach_stdout": return { taskId: MISSING_PROCESS_TASK_ID, tail_lines: 3 };
    case "process_signal": return { taskId: MISSING_PROCESS_TASK_ID, signal: "SIGTERM" };
    case "process_stats": return { taskId: MISSING_PROCESS_TASK_ID };
    case "secret_delete": return { key: "pass:shellx-release-refused" };
    case "secret_get": return { path: "vault:shellx-release-never-reveal" };
    case "secret_set": return { key: "pass:shellx-release-refused", value: "non-secret-release-fixture" };
    case "security_scan": return {
      path: fixtures.launchRoot,
      allow_outside_cwd: true,
      run_audits: false,
      max_depth: 1,
      max_manifests: 5,
    };
    case "send_prompt_to_provider": return {
      providerId: "codex-cli",
      prompt: "ShellX release safety refusal fixture",
      userApproved: false,
    };
    case "send_prompt_to_session": return {
      prompt: "ShellX release safety refusal fixture",
      userApproved: false,
    };
    case "vault_agent_request": return { action: "list" };
    case "vault_deposit": return { label: "ShellX release deposit plan" };
    case "vault_generate": return {
      origin: "https://release.shellx.invalid",
      itemId: fixtures.vaultGeneratedItemId,
      length: 24,
    };
    case "vault_list": return { prefix: `${fixtures.memoryNamespace}-missing-vault-prefix` };
    case "vault_list_grants": return { secretRef: `vault:${fixtures.memoryNamespace}-missing-grant` };
    case "vault_request_grant": return {
      secretRef: "vault:shellx-release-never-reveal",
      operation: "rawReveal",
    };
    case "vision_describe":
    case "vision_describe_v2": return { path: "" };
    case "voice_stt_v2": return {};
    case "voice_tts": return { text: "" };
    case "x_search": return { query: "" };
    case "build_checkpoint": return { cwd: fixtures.launchRoot, label: "release safety refusal" };
    case "build_complete": return { summary: "Release safety refusal fixture" };
    case "build_receipt": return { kind: "reviewCompleted", summary: "Release safety refusal fixture" };
    case "goal_complete": return { summary: "Release safety refusal fixture" };
    case "browser_read": return { action: "tabs" };
    case "browser_act": {
      if (!browserFixture?.taskId) throw new Error("browser_act is missing its owned Browser task fixture");
      return { action: "navigate", taskId: browserFixture.taskId, url: browserFixture.targetUrl, timeoutMs: 30_000 };
    }
    case "browser_navigate": {
      if (!browserFixture?.taskId) throw new Error("browser_navigate is missing its owned Browser task fixture");
      return { taskId: browserFixture.taskId, url: browserFixture.targetUrl, timeoutMs: 30_000 };
    }
    case "browser_clear_site_data": {
      if (!browserFixture?.taskId) throw new Error("browser_clear_site_data is missing its owned Browser task fixture");
      return { taskId: browserFixture.taskId, timeoutMs: 30_000 };
    }
    case "browser_observe": {
      if (!browserFixture?.taskId) throw new Error("browser_observe is missing its owned Browser task fixture");
      return { taskId: browserFixture.taskId, maxPayloadBytes: 3_000 };
    }
    case "browser_click_at": {
      if (!browserFixture?.taskId) throw new Error("browser_click_at is missing its owned Browser task fixture");
      return { taskId: browserFixture.taskId, x: 100, y: 62 };
    }
    case "browser_click_ref": {
      if (!browserFixture?.taskId) throw new Error("browser_click_ref is missing its owned Browser task fixture");
      return { taskId: browserFixture.taskId, selector: "#advance" };
    }
    case "browser_fill_ref": {
      if (!browserFixture?.taskId) throw new Error("browser_fill_ref is missing its owned Browser task fixture");
      return { taskId: browserFixture.taskId, selector: "#name", value: "Release input" };
    }
    case "browser_type_text": {
      if (!browserFixture?.taskId) throw new Error("browser_type_text is missing its owned Browser task fixture");
      return { taskId: browserFixture.taskId, x: 100, y: 140, value: "Coordinate input value" };
    }
    case "browser_extract": {
      if (!browserFixture?.taskId) throw new Error("browser_extract is missing its owned Browser task fixture");
      return { taskId: browserFixture.taskId, format: "text", selector: "main" };
    }
    case "browser_flight_recorder_export": {
      if (!browserFixture?.taskId) throw new Error("browser_flight_recorder_export is missing its owned Browser task fixture");
      return {
        taskId: browserFixture.taskId,
        suiteId: `release-host-mcp-${fixtures.memoryNamespace}`,
        group: "candidate",
        attemptIndex: 0,
        reason: "Final surface owned Host MCP Flight Recorder proof",
      };
    }
    case "browser_save_page": {
      if (!browserFixture?.taskId) throw new Error("browser_save_page is missing its owned Browser task fixture");
      return {
        taskId: browserFixture.taskId,
        format: "text",
        destinationDir: fixtures.launchRoot,
        fileName: "owned-host-mcp-page.txt",
      };
    }
    case "browser_screenshot": {
      if (!browserFixture?.taskId) throw new Error("browser_screenshot is missing its owned Browser task fixture");
      return { taskId: browserFixture.taskId, fullPage: false };
    }
    case "browser_trace_open": {
      if (!browserFixture?.taskId) throw new Error("browser_trace_open is missing its owned Browser task fixture");
      return { taskId: browserFixture.taskId, reason: "Final surface owned Host MCP trace proof" };
    }
    case "browser_wait_for": {
      if (!browserFixture?.taskId) throw new Error("browser_wait_for is missing its owned Browser task fixture");
      return { taskId: browserFixture.taskId, key: "text", value: "Action target ready" };
    }
    case "browser_verify": {
      if (!browserFixture?.taskId) throw new Error("browser_verify is missing its owned Browser task fixture");
      return { taskId: browserFixture.taskId, key: "text", value: "Action target ready" };
    }
    case "browser_run_steps": {
      if (!browserFixture?.taskId) throw new Error("browser_run_steps is missing its owned Browser task fixture");
      return {
        taskId: browserFixture.taskId,
        steps: [
          { action: "waitFor", key: "text", value: "Action target ready" },
          { action: "verify", key: "text", value: "Action target ready" },
        ],
      };
    }
    case "fs_append": return { path: fixtures.appendLaunchPath, content: APPEND_CONTENT };
    case "fs_copy": return { src: fixtures.textLaunchPath, dst: fixtures.copyLaunchPath };
    case "fs_delete": return { path: fixtures.deleteLaunchPath };
    case "fs_ensure_dir": return { path: fixtures.ensureDirLaunchPath };
    case "fs_write": return { path: fixtures.writeLaunchPath, content: WRITE_CONTENT };
    case "provider_adapters": return { transport: "local" };
    case "provider_sessions": return { transport: "local" };
    case "search_tool": return { query: "fs_read", limit: 2 };
    case "sleep_ms": return { ms: 5 };
    default: return {};
  }
}

async function verifyEffect(
  name: string,
  result: Record<string, unknown>,
  fixtures: FixturePaths,
  browserFixture: BrowserMutationFixture | null,
  request: ReleaseSurfaceDriverRequest,
  connection: McpConnection,
): Promise<string> {
  switch (name) {
    case "Agent_metrics": {
      for (const key of ["running", "completed", "failed", "total"] as const) {
        if (!Number.isSafeInteger(result[key]) || Number(result[key]) < 0) {
          throw new Error(`Agent_metrics returned an invalid ${key} count`);
        }
      }
      if (result.total !== Number(result.running) + Number(result.completed) + Number(result.failed)) {
        throw new Error("Agent_metrics total did not equal its typed status counts");
      }
      return "Host MCP returned internally consistent bounded Agent registry metrics; aggregate values were not retained.";
    }
    case "Agent_poll_all": {
      const snapshots = requireArray(result, "snapshots", name);
      if (snapshots.length !== 1 || !isRecord(snapshots[0])
        || snapshots[0].subagent_id !== MISSING_AGENT_ID || typeof snapshots[0].error !== "string"
        || !Number.isSafeInteger(result.at_unix_ms)) {
        throw new Error("Agent_poll_all did not return the exact bounded missing-agent snapshot");
      }
      return "Host MCP batch-polled exactly one disposable missing Agent id and returned its typed inline result; identity was not retained.";
    }
    case "capabilities_summary": {
      if (result.kind !== "shellx_capabilities_summary" || !Array.isArray(result.hostToolCategories)) {
        throw new Error("capabilities_summary omitted its typed capability categories");
      }
      return `Host MCP returned ${result.hostToolCategories.length} capability categories; category details were not retained.`;
    }
    case "browser_read": {
      const tabs = requireArray(result, "tabs", name);
      for (const tab of tabs) {
        if (!isRecord(tab) || typeof tab.browserTabId !== "string" || !tab.browserTabId) {
          throw new Error("browser_read action=tabs returned an unidentified Browser tab");
        }
      }
      return `Compact browser_read returned ${tabs.length} typed tab row(s); tab identity and page data were not retained.`;
    }
    case "browser_act": {
      if (!browserFixture || result.ok !== true || result.status !== "applied"
        || result.taskId !== browserFixture.taskId || result.currentUrl !== browserFixture.targetUrl) {
        throw new Error("browser_act did not navigate the exact owned Browser task to its local fixture target");
      }
      return "Compact browser_act permission-gated an exact navigation on the owned disposable Browser task; task and URL were not retained.";
    }
    case "browser_state": {
      if (typeof result.browserProtocolVersion !== "string" || !result.browserProtocolVersion
        || typeof result.browserSchemaRevision !== "string" || !result.browserSchemaRevision
        || !isRecord(result.revisions) || !isRecord(result.counts)
        || !Array.isArray(result.pendingRequests)) {
        throw new Error("browser_state omitted its compact versioned summary contract");
      }
      return "Host MCP returned the compact versioned Browser summary; state values were not retained.";
    }
    case "browser_tabs": {
      const tabs = requireArray(result, "tabs", name);
      for (const tab of tabs) {
        if (!isRecord(tab) || typeof tab.browserTabId !== "string" || !tab.browserTabId) {
          throw new Error("browser_tabs returned an unidentified Browser tab");
        }
      }
      return `Host MCP returned ${tabs.length} typed Browser tab row(s); tab data was not retained.`;
    }
    case "browser_locks": {
      const locks = requireArray(result, "locks", name);
      for (const lock of locks) {
        if (!isRecord(lock) || typeof lock.browserTabId !== "string" || !lock.browserTabId) {
          throw new Error("browser_locks returned an unidentified Browser lock");
        }
      }
      return `Host MCP returned ${locks.length} typed Browser lock row(s); lock data was not retained.`;
    }
    case "browser_workflows": {
      const workflows = requireArray(result, "workflows", name);
      if (result.ok !== true || result.count !== workflows.length || workflows.length > 3) {
        throw new Error("browser_workflows violated its exact three-row bounded catalog contract");
      }
      return `Host MCP returned ${workflows.length} bounded Browser workflow summary row(s); workflow data was not retained.`;
    }
    case "browser_check": {
      const effects = isRecord(result.effects) ? result.effects : null;
      const settle = isRecord(result.settle) ? result.settle : null;
      if (result.schema !== "shellx/browser-quiet-check@1" || result.ok !== true
        || result.mode !== "quiet" || !effects || !settle
        || Object.values(effects).some((value) => value !== false)
        || typeof settle.settled !== "boolean") {
        throw new Error("browser_check omitted its exact typed no-effect quiet-check contract");
      }
      return "Host MCP returned a typed bounded Browser quiet check and proved every declared UI/task/engine/receipt effect false; state details were not retained.";
    }
    case "browser_downloads": {
      const downloads = requireArray(result, "downloads", name);
      return `Host MCP returned ${downloads.length} typed Browser download row(s); paths, URLs, hashes, and transfer metadata were not retained.`;
    }
    case "browser_evidence": {
      const recent = requireArray(result, "recent", name);
      if (result.ok !== true || result.count !== recent.length || recent.length > 3
        || result.callerScoped !== true) {
        throw new Error("browser_evidence violated its exact three-row caller-scoped contract");
      }
      return `Host MCP returned ${recent.length} bounded caller-scoped Browser evidence row(s); receipt and artifact data were not retained.`;
    }
    case "browser_rendered_check": {
      const evidence = isRecord(result.evidence) ? result.evidence : null;
      const effects = isRecord(result.effects) ? result.effects : null;
      if (result.schema !== "shellx/browser-rendered-check@1" || result.ok !== true
        || result.status !== "passed" || !evidence || !effects
        || evidence.textMatched !== true || evidence.titleMatched !== true
        || evidence.selectorMatched !== true || evidence.selectorCount !== 1
        || effects.visibleWindowOpened !== false || effects.browserTaskCreated !== false
        || effects.browserTabCreated !== false || effects.receiptEmitted !== false
        || effects.hiddenRendererCreated !== true || effects.hiddenRendererDestroyed !== true
        || effects.profilePersisted !== false) {
        throw new Error("browser_rendered_check omitted its exact passing isolated-renderer contract");
      }
      return "Host MCP matched text, title, and selector in one isolated hidden renderer, destroyed it, and persisted no profile or page evidence.";
    }
    case "browser_navigate": {
      if (!browserFixture || result.ok !== true || result.taskId !== browserFixture.taskId
        || result.currentUrl !== browserFixture.targetUrl) {
        throw new Error("browser_navigate did not reach the exact owned loopback task URL");
      }
      return "Host MCP permission-gated browser_navigate on the exact owned loopback task; task and URL were not retained.";
    }
    case "browser_clear_site_data": {
      if (!browserFixture || result.ok !== true || result.status !== "applied"
        || result.taskId !== browserFixture.taskId || result.currentUrl !== browserFixture.targetUrl
        || typeof result.message !== "string"
        || !result.message.startsWith("site application data recovery applied:")
        || !result.message.includes("origin storage")) {
        throw new Error("browser_clear_site_data did not return the exact owned-origin recovery contract");
      }
      return "Host MCP permission-gated non-cookie site-data cleanup only for the exact owned loopback origin and requested its reload; task, origin, and detail were not retained.";
    }
    case "browser_observe": {
      if (!browserFixture || result.ok !== true || result.taskId !== browserFixture.taskId
        || !isRecord(result.observation)) {
        throw new Error("browser_observe omitted its typed exact-task observation");
      }
      if (Number.isSafeInteger(result.structuredResponseBytes) && Number(result.structuredResponseBytes) > 3_000) {
        throw new Error("browser_observe exceeded its requested structured-response budget");
      }
      return "Host MCP returned a typed token-budgeted observation for the exact owned loopback task; refs and page data were not retained.";
    }
    case "browser_extract": {
      if (!browserFixture || result.ok !== true || result.taskId !== browserFixture.taskId
        || typeof result.extractedText !== "string" || !result.extractedText.includes("Action target ready")) {
        throw new Error("browser_extract omitted the exact owned-page post-action text");
      }
      return "Host MCP extracted the exact expected text from the owned loopback page; task and page text were not retained.";
    }
    case "browser_verify": {
      const verification = isRecord(result.verification) ? result.verification : null;
      if (!browserFixture || result.ok !== true || result.taskId !== browserFixture.taskId
        || !verification || verification.passed !== true) {
        throw new Error("browser_verify omitted its passing exact-task verification");
      }
      return "Host MCP attached passing deterministic verification to the exact owned loopback task; verification details were not retained.";
    }
    case "browser_run_steps": {
      if (!browserFixture || result.ok !== true || result.taskId !== browserFixture.taskId
        || result.stepsPlanned !== 2 || result.stepsRun !== 2
        || result.stepsSucceeded !== 2 || result.stepsFailed !== 0) {
        throw new Error("browser_run_steps did not complete both exact owned-page steps");
      }
      return "Host MCP permission-gated and completed two bounded verification steps on the exact owned loopback task; step data was not retained.";
    }
    case "browser_flight_recorder_export": {
      if (!browserFixture || result.taskId !== browserFixture.taskId
        || !requiredString(result.attemptId, `${name}.attemptId`).startsWith("browser-attempt-")) {
        throw new Error("browser_flight_recorder_export did not bind an attempt to the exact owned Browser task");
      }
      recordOwnedArtifact(result, name, fixtures, request);
      const receipt = requireRecord(result.receipt, `${name}.receipt`);
      if (receipt.kind !== "browserFlightRecorderExported" || result.evidenceComplete !== true) {
        throw new Error("browser_flight_recorder_export omitted its exact complete-evidence receipt");
      }
      return "Host MCP permission-gated one exact owned-task Flight Recorder export, verified its bounded file identity, and scheduled that exact artifact for deletion; task, path, and evidence content were not retained.";
    }
    case "browser_save_page": {
      if (!browserFixture || result.ok !== true || result.status !== "saved" || result.format !== "text") {
        throw new Error("browser_save_page omitted its exact saved-text result");
      }
      const artifact = requireRecord(result.artifact, `${name}.artifact`);
      const nodePath = recordOwnedArtifact(artifact, name, fixtures, request);
      if (!readFileSync(nodePath, "utf8").includes("Action target ready")) {
        throw new Error("browser_save_page artifact omitted the exact owned-page text");
      }
      return "Host MCP permission-gated one exact owned-page text export, verified its bounded file identity and content marker, and scheduled that exact artifact for deletion; task, path, and page content were not retained.";
    }
    case "browser_screenshot": {
      if (!browserFixture || result.ok !== true || result.taskId !== browserFixture.taskId) {
        throw new Error("browser_screenshot omitted its exact owned Browser task result");
      }
      const screenshot = requireRecord(result.screenshot, `${name}.screenshot`);
      recordOwnedArtifact(screenshot, name, fixtures, request);
      if (!Number.isSafeInteger(screenshot.width) || Number(screenshot.width) <= 0
        || !Number.isSafeInteger(screenshot.height) || Number(screenshot.height) <= 0) {
        throw new Error("browser_screenshot omitted positive image dimensions");
      }
      const receipt = requireRecord(result.receipt, `${name}.receipt`);
      if (receipt.kind !== "browserScreenshotCaptured") {
        throw new Error("browser_screenshot omitted its exact receipt kind");
      }
      return "Host MCP captured one bounded screenshot of the exact owned loopback task, verified its file identity and dimensions, and scheduled that exact artifact for deletion; task, path, URL, and image content were not retained.";
    }
    case "browser_trace_open": {
      if (!browserFixture || result.taskId !== browserFixture.taskId
        || !requiredString(result.traceId, `${name}.traceId`).startsWith("browser-trace-")) {
        throw new Error("browser_trace_open did not bind a trace to the exact owned Browser task");
      }
      recordOwnedArtifact(result, name, fixtures, request);
      const receipt = requireRecord(result.receipt, `${name}.receipt`);
      if (receipt.kind !== "browserTraceBundleExported") {
        throw new Error("browser_trace_open omitted its exact receipt kind");
      }
      return "Host MCP permission-gated one bounded redacted trace export for the exact owned task, verified its file identity, and scheduled that exact artifact for deletion; task, path, and trace content were not retained.";
    }
    case "browser_click_at":
    case "browser_click_ref":
    case "browser_fill_ref":
    case "browser_type_text":
    case "browser_wait_for": {
      if (!browserFixture || result.ok !== true || result.taskId !== browserFixture.taskId) {
        throw new Error(`${name} did not return the exact owned Browser task success envelope`);
      }
      if (name === "browser_click_at") {
        const proof = await callTool(connection, "browser_wait_for", {
          taskId: browserFixture.taskId,
          key: "text",
          value: "Coordinate click ready",
        });
        if (proof.ok !== true || proof.taskId !== browserFixture.taskId) {
          throw new Error("browser_click_at did not trigger the exact owned coordinate button");
        }
      }
      if (name === "browser_fill_ref" || name === "browser_type_text") {
        const proof = await callTool(connection, "browser_observe", {
          taskId: browserFixture.taskId,
          fullObservation: true,
        });
        const observation = isRecord(proof.observation) ? proof.observation : null;
        const fields = observation && Array.isArray(observation.formFields) ? observation.formFields : [];
        const value = name === "browser_fill_ref" ? "Release input" : "Coordinate input value";
        const field = fields.filter(isRecord).find((row) => row.value === value);
        if (!field || field.value !== value) throw new Error(`${name} did not update the exact owned input`);
      }
      return `Host MCP ${MUTATION_TOOLS.has(name) ? "permission-gated and " : ""}completed ${name} on the exact owned loopback task; task, locator, coordinates, values, and page data were not retained.`;
    }
    case "build_state": {
      if (result.tabId !== connection.tabId || result.state !== null) {
        throw new Error("build_state did not return the exact empty disposable-tab state");
      }
      return "Host MCP confirmed the disposable tab has no active Build run.";
    }
    case "build_receipts": {
      const receipts = requireArray(result, "receipts", name);
      if (result.ok !== true || result.tabId !== connection.tabId || receipts.length !== 0) {
        throw new Error("build_receipts did not return the exact empty disposable-tab receipt set");
      }
      return "Host MCP confirmed the disposable tab has no Build receipts.";
    }
    case "model_instruction_cards": {
      const cards = requireArray(result, "cards", name);
      if (!isRecord(result.policy) || typeof result.policy.shellxMayAutoRoute !== "boolean") {
        throw new Error("model_instruction_cards omitted its explicit routing policy");
      }
      return `Host MCP returned ${cards.length} model instruction card(s) with an explicit routing policy; card content was not retained.`;
    }
    case "preview_diagnose": {
      requireExactKeys(result, [
        "browserEvents", "command", "cwd", "httpStatus", "issues", "logs", "ok", "responseBytes",
        "screenshotBrowser", "screenshotError", "screenshotHeight", "screenshotPath", "screenshotWidth",
        "state", "status", "summary", "tabId", "title", "url",
      ], name);
      const state = isRecord(result.state) ? result.state : null;
      if (!state) throw new Error("preview_diagnose omitted its idle Preview state");
      stableHostMcpPreviewState(state, connection.tabId);
      const issues = requireArray(result, "issues", name);
      if (result.tabId !== connection.tabId || result.ok !== false || result.status !== "failed"
        || result.summary !== "Preview Doctor found 2 error(s) and 0 warning(s)."
        || result.url !== null || result.cwd !== null || result.command !== null || result.httpStatus !== null
        || result.responseBytes !== null || result.title !== null || result.screenshotPath !== null
        || result.screenshotWidth !== null || result.screenshotHeight !== null || result.screenshotBrowser !== null
        || result.screenshotError !== null || !Array.isArray(result.browserEvents) || result.browserEvents.length !== 0
        || !Array.isArray(result.logs) || result.logs.length !== 0 || issues.length !== 2) {
        throw new Error("preview_diagnose did not return its exact absent-preview diagnostic envelope");
      }
      const expectedMessages = ["preview status is Idle", "preview has no URL to inspect"];
      for (const [index, issue] of issues.entries()) {
        if (!isRecord(issue)) throw new Error(`preview_diagnose issue ${index} was not structured`);
        requireExactKeys(issue, ["message", "severity", "source"], `preview_diagnose issue ${index}`);
        if (issue.severity !== "error" || issue.source !== "preview" || issue.message !== expectedMessages[index]) {
          throw new Error(`preview_diagnose issue ${index} did not match its exact absent-preview failure`);
        }
      }
      return "Host MCP returned the exact failed Preview Doctor diagnostic for the unique idle tab and preserved absent Preview and Build state.";
    }
    case "preview_state": {
      if (result.tabId !== connection.tabId || result.status !== "idle" || !Array.isArray(result.logs)) {
        throw new Error("preview_state did not return the exact idle disposable-tab state");
      }
      return "Host MCP confirmed the disposable tab has an idle Work Preview state.";
    }
    case "preview_logs": {
      const logs = requireArray(result, "logs", name);
      if (result.tabId !== connection.tabId || logs.length !== 0) {
        throw new Error("preview_logs did not return the exact empty disposable-tab log tail");
      }
      return "Host MCP confirmed the disposable tab has an empty Work Preview log tail.";
    }
    case "preview_start": {
      verifyHostMcpRunningPreviewState(result, fixtures, name);
      return "Host MCP permission-gated preview_start, served the exact owned static page through a ShellX-owned loopback endpoint, and exposed its matching running state; project and endpoint identities were not retained.";
    }
    case "provider_adapters": {
      const providers = requireArray(result, "providers", name);
      for (const provider of providers) {
        if (!isRecord(provider) || typeof provider.providerId !== "string" || !provider.providerId) {
          throw new Error("provider_adapters returned an unidentified provider row");
        }
      }
      return `Host MCP returned ${providers.length} typed local provider adapter row(s); versions and executable paths were not retained.`;
    }
    case "provider_sessions": {
      const recentRuns = requireArray(result, "recentRuns", name);
      if (result.tabId !== connection.tabId || result.transport !== "local"
        || typeof result.transportKey !== "string" || !result.transportKey
        || (result.activeRun !== undefined && result.activeRun !== null)
        || recentRuns.length !== 0 || !isRecord(result.storedConversations)) {
        throw new Error("provider_sessions did not return the exact empty local disposable-tab state");
      }
      return "Host MCP returned the exact empty local provider-session state for the disposable tab; identifiers were not retained.";
    }
    case "session_tooling": {
      const desired = requireArray(result, "desired", name);
      const health = requireArray(result, "health", name);
      if (result.tabId !== connection.tabId || !isRecord(result.session)) {
        throw new Error("session_tooling omitted its exact disposable-tab board contract");
      }
      return `Host MCP returned a typed Tooling board with ${desired.length} desired and ${health.length} health row(s); row data was not retained.`;
    }
    case "shellx_health": {
      if (result.processId !== request.runtime.processId || result.instanceId !== request.runtime.instanceId
        || result.appVersion !== request.version || result.buildCommit !== request.sourceCommit) {
        throw new Error("shellx_health did not identify the exact frozen candidate");
      }
      return `Host MCP reached Debug API health for candidate PID ${request.runtime.processId} and the exact frozen source commit.`;
    }
    case "clock_now": {
      if (!Number.isSafeInteger(result.unix_ms) || typeof result.iso8601 !== "string"
        || !Number.isFinite(Date.parse(result.iso8601)) || result.tz_used !== "utc") {
        throw new Error("clock_now returned an invalid UTC time envelope");
      }
      return "Host MCP returned a valid UTC wall-clock envelope.";
    }
    case "event_log": {
      const events = requireArray(result, "events", name);
      if (result.count !== events.length || events.length > 3
        || !(result.earliestT === null || Number.isSafeInteger(result.earliestT))
        || !(result.latestT === null || Number.isSafeInteger(result.latestT))) {
        throw new Error("event_log violated its exact three-event bounded envelope");
      }
      return `Host MCP returned a bounded envelope of ${events.length} event(s); event data was not retained.`;
    }
    case "environment":
    case "grok_environment":
    case "session_environment": {
      if (result.tabId !== connection.tabId || typeof result.status !== "string"
        || !Number.isSafeInteger(result.checkedAtMs) || !isRecord(result.setup)
        || !isRecord(result.readiness) || !isRecord(result.trace)) {
        throw new Error(`${name} omitted its exact tab-scoped diagnostic envelope`);
      }
      return `Host MCP returned the typed ${name} diagnostics for the exact disposable tab; paths, versions, setup checks, and trace data were not retained.`;
    }
    case "fs_exists": {
      if (result.exists !== true || result.kind !== "file") throw new Error("fs_exists did not identify the owned text fixture");
      return "Host MCP confirmed the owned release fixture exists as a file.";
    }
    case "fs_stat": {
      if (result.exists !== true || result.kind !== "file" || result.size_bytes !== Buffer.byteLength(TEXT_FIXTURE)) {
        throw new Error("fs_stat returned the wrong owned fixture identity");
      }
      return `Host MCP returned the exact ${Buffer.byteLength(TEXT_FIXTURE)}-byte fixture size without retaining file content.`;
    }
    case "fs_read": {
      if (result.content !== TEXT_FIXTURE || result.size_bytes !== Buffer.byteLength(TEXT_FIXTURE)
        || result.truncated !== false || result.offset_bytes !== 0) {
        throw new Error("fs_read did not return the exact bounded text fixture");
      }
      return `Host MCP read the exact ${Buffer.byteLength(TEXT_FIXTURE)}-byte text fixture; content was not retained in evidence.`;
    }
    case "host_read": {
      if (result.content !== TEXT_FIXTURE || result.size_bytes !== Buffer.byteLength(TEXT_FIXTURE)
        || result.truncated !== false || result.offset_bytes !== 0) {
        throw new Error("host_read did not route fs_read to the exact bounded text fixture");
      }
      return `Compact host_read routed fs_read and returned the exact ${Buffer.byteLength(TEXT_FIXTURE)}-byte fixture; content was not retained.`;
    }
    case "host_act": {
      if (result.bytes_written !== Buffer.byteLength(GATEWAY_CONTENT)
        || readFileSync(fixtures.gatewayNodePath, "utf8") !== GATEWAY_CONTENT) {
        throw new Error("host_act did not route fs_write to the exact owned fixture");
      }
      return `Compact host_act routed a permission-gated ${Buffer.byteLength(GATEWAY_CONTENT)}-byte atomic write inside the disposable profile.`;
    }
    case "get_session_info": {
      if (result.tabId !== connection.tabId || typeof result.processCwd !== "string" || !result.processCwd
        || !isRecord(result.fileSystems)
        || typeof result.fileSystems.nativeSession !== "string"
        || typeof result.fileSystems.shellxHostMcp !== "string") {
        throw new Error("get_session_info omitted its exact tab and filesystem-boundary contract");
      }
      return "Host MCP identified the exact disposable tab and both filesystem boundaries; paths were not retained.";
    }
    case "mem_get": {
      if (result.found !== false || result.namespace !== fixtures.memoryNamespace
        || result.key !== fixtures.memoryMissingKey || result.mtime_unix_ms !== 0) {
        throw new Error("mem_get did not return the exact missing-key contract in the disposable namespace");
      }
      return "Host MCP confirmed an exact missing key in the disposable memory namespace; namespace and key were not retained.";
    }
    case "mem_list": {
      const entries = requireArray(result, "entries", name);
      if (result.count !== 0 || entries.length !== 0) {
        throw new Error("mem_list did not return the exact empty bounded prefix result");
      }
      return "Host MCP returned the exact empty prefix result from the disposable memory namespace.";
    }
    case "mem_set": {
      if (result.ok !== true || result.namespace !== fixtures.memoryNamespace || result.key !== fixtures.memorySetKey) {
        throw new Error("mem_set did not acknowledge the exact disposable memory key");
      }
      const readback = await callTool(connection, "mem_get", {
        namespace: fixtures.memoryNamespace,
        key: fixtures.memorySetKey,
      });
      if (readback.found !== true || readback.value !== MEMORY_CONTENT) {
        throw new Error("mem_set did not survive an exact read-back");
      }
      return `Host MCP permission-gated and read back an exact ${Buffer.byteLength(MEMORY_CONTENT)}-byte disposable memory value; value was not retained.`;
    }
    case "mem_delete": {
      if (result.deleted !== true) throw new Error("mem_delete did not delete the exact seeded disposable key");
      const readback = await callTool(connection, "mem_get", {
        namespace: fixtures.memoryNamespace,
        key: fixtures.memoryDeleteKey,
      });
      if (readback.found !== false) throw new Error("mem_delete key remained readable after deletion");
      return "Host MCP permission-gated deletion of the exact seeded disposable memory key and proved it absent.";
    }
    case "fs_append": {
      if (result.bytes_appended !== Buffer.byteLength(APPEND_CONTENT)
        || result.new_size !== Buffer.byteLength(APPEND_BASE + APPEND_CONTENT)
        || readFileSync(fixtures.appendNodePath, "utf8") !== APPEND_BASE + APPEND_CONTENT) {
        throw new Error("fs_append did not produce the exact owned append effect");
      }
      return `Host MCP appended exactly ${Buffer.byteLength(APPEND_CONTENT)} bytes inside the disposable profile.`;
    }
    case "fs_copy": {
      if (result.bytes_copied !== Buffer.byteLength(TEXT_FIXTURE)
        || result.overwrite_used !== false
        || readFileSync(fixtures.copyNodePath, "utf8") !== TEXT_FIXTURE) {
        throw new Error("fs_copy did not produce the exact owned copy effect");
      }
      return `Host MCP copied exactly ${Buffer.byteLength(TEXT_FIXTURE)} bytes inside the disposable profile.`;
    }
    case "fs_delete": {
      if (result.removed !== true || result.kind !== "file" || existsSync(fixtures.deleteNodePath)) {
        throw new Error("fs_delete did not remove the exact owned fixture file");
      }
      return "Host MCP removed the exact owned fixture file from the disposable profile.";
    }
    case "fs_ensure_dir": {
      if (result.created !== true || !statSync(fixtures.ensureDirNodePath).isDirectory()) {
        throw new Error("fs_ensure_dir did not create the exact owned fixture directory");
      }
      return "Host MCP created the exact owned directory inside the disposable profile.";
    }
    case "fs_write": {
      if (result.bytes_written !== Buffer.byteLength(WRITE_CONTENT)
        || result.encoding !== "utf8"
        || readFileSync(fixtures.writeNodePath, "utf8") !== WRITE_CONTENT) {
        throw new Error("fs_write did not produce the exact owned atomic write effect");
      }
      return `Host MCP atomically wrote exactly ${Buffer.byteLength(WRITE_CONTENT)} bytes inside the disposable profile.`;
    }
    case "fs_read_binary": {
      if (result.content_base64 !== BINARY_FIXTURE.toString("base64")
        || result.size_bytes !== BINARY_FIXTURE.length || result.truncated !== false) {
        throw new Error("fs_read_binary did not preserve the exact fixture bytes");
      }
      return `Host MCP preserved all ${BINARY_FIXTURE.length} binary fixture bytes; encoded content was not retained in evidence.`;
    }
    case "fs_list_dir": {
      const entries = requireArray(result, "entries", name);
      const names = new Set(entries.filter(isRecord).map((entry) => entry.name));
      if (!names.has("fixture.txt") || !names.has("fixture.bin") || result.truncated !== false) {
        throw new Error("fs_list_dir omitted an owned fixture entry or truncated unexpectedly");
      }
      return `Host MCP listed ${entries.length} owned fixture entries without retaining directory metadata.`;
    }
    case "fs_grep": {
      const matches = requireArray(result, "matches", name);
      if (matches.length !== 1 || !isRecord(matches[0]) || matches[0].text !== "needle-release-035") {
        throw new Error("fs_grep did not find the exact bounded fixture match");
      }
      return "Host MCP found the one expected bounded fixture match; path and line content were not retained.";
    }
    case "fs_unwatch": {
      if (result.ok !== true || result.stopped !== false
        || result.watchId !== `${fixtures.memoryNamespace}-missing-watch`) {
        throw new Error("fs_unwatch did not return the exact idempotent missing-watch contract");
      }
      return "Host MCP proved that unwatching an exact disposable missing watch id is idempotent.";
    }
    case "fs_watch": {
      if (result.ok !== true || !samePortablePath(result.watching, fixtures.launchRoot, request.platform)
        || typeof result.watchId !== "string" || !result.watchId
        || result.watchId !== result.watching || typeof result.alreadyWatching !== "boolean"
        || result.recursive !== false) {
        throw new Error("fs_watch did not start the exact owned non-recursive watch");
      }
      fixtures.watchId = result.watchId;
      const stopped = await callTool(connection, "fs_unwatch", { watchId: fixtures.watchId });
      if (stopped.ok !== true || stopped.stopped !== true || stopped.watchId !== fixtures.watchId) {
        throw new Error("fs_watch cleanup did not stop the exact owned watch");
      }
      fixtures.watchId = null;
      return "Host MCP permission-gated an exact owned filesystem watch and stopped it by returned watch id before fixture deletion.";
    }
    case "net_fetch": {
      if (result.made_request !== false || result.host !== "169.254.169.254"
        || typeof result.error !== "string" || !result.error.includes("restricted IP")) {
        throw new Error("net_fetch did not reject the fixed link-local target before network activity");
      }
      return "Host MCP permission-gated net_fetch and rejected a fixed restricted link-local target before any request; URL and error detail were not retained.";
    }
    case "secret_get": {
      if (result.code !== "RAW_SECRET_REVEAL_DENIED" || result.isError !== true) {
        throw new Error("secret_get did not return the exact structured Vault raw-reveal denial");
      }
      if (Object.hasOwn(result, "value")) throw new Error("secret_get exposed a value field despite raw-reveal denial");
      return "Host MCP returned the structured raw-secret-reveal denial without exposing a value.";
    }
    case "security_scan": {
      const summary = isRecord(result.summary) ? result.summary : null;
      const manifests = requireArray(result, "manifests", name);
      const checks = requireArray(result, "checks", name);
      if (!summary || summary.status !== "pass" || summary.manifestCount !== manifests.length
        || summary.auditsRun !== 0 || checks.length !== 0 || manifests.length !== 1
        || !isRecord(manifests[0]) || manifests[0].fileName !== "package.json") {
        throw new Error("security_scan did not return the exact inventory-only disposable manifest contract");
      }
      return "Host MCP permission-gated an inventory-only scan of one disposable manifest with no audit process or retained path data.";
    }
    case "vault_agent_request": {
      const requests = requireArray(result, "requests", name);
      const resources = requireArray(result, "resources", name);
      if (result.ok !== true || result.secretExposed !== false
        || !Number.isSafeInteger(result.pendingCount) || Number(result.pendingCount) < 0) {
        throw new Error("vault_agent_request omitted its redacted list metadata contract");
      }
      return `Host MCP permission-gated a redacted Vault agent-request listing with ${requests.length} request and ${resources.length} resource row(s); row data was not retained.`;
    }
    case "vault_deposit": {
      if (result.ok !== true || result.action !== "deposit"
        || result.route !== "/browser/vault-deposits" || result.secretExposed !== false
        || !Array.isArray(result.requiredPostFields)
        || !result.requiredPostFields.includes("secretValue")) {
        throw new Error("vault_deposit omitted its exact metadata-only deposit route contract");
      }
      return "Host MCP returned the metadata-only Vault deposit route without accepting or exposing a secret.";
    }
    case "vault_generate": {
      if (result.itemId === fixtures.vaultGeneratedItemId && result.storageCommitted === true) {
        fixtures.vaultGenerateCommitted = true;
      }
      if (result.ok !== true || result.status !== "created" || result.action !== "generateAndStore"
        || result.itemId !== fixtures.vaultGeneratedItemId || result.length !== 24
        || result.storageCommitted !== true || result.secretExposed !== false
        || "value" in result || "password" in result) {
        throw new Error("vault_generate omitted its exact redacted create-and-store contract");
      }
      return "Host MCP generated and committed one create-only Vault item without returning the generated secret.";
    }
    case "vault_list": {
      const entries = requireArray(result, "entries", name);
      if (result.ok !== true || result.count !== entries.length
        || result.secretExposed !== false || result.visibility !== "agentVisibleOnly") {
        throw new Error("vault_list omitted its exact agent-visible metadata-only contract");
      }
      return `Host MCP returned ${entries.length} agent-visible Vault metadata row(s) without retaining row data or exposing secret values.`;
    }
    case "vault_list_grants": {
      const grants = requireArray(result, "grants", name);
      if (result.ok !== true || result.count !== grants.length || result.secretExposed !== false) {
        throw new Error("vault_list_grants omitted its exact metadata-only grant contract");
      }
      return `Host MCP returned ${grants.length} Vault grant metadata row(s) without retaining row data or exposing secret values.`;
    }
    case "search_tool": {
      const tools = requireArray(result, "tools", name);
      if (!tools.some((tool) => isRecord(tool) && tool.name === "fs_read" && isRecord(tool.inputSchema))
        || result.mode !== "ranked") {
        throw new Error("search_tool omitted the exact fs_read schema");
      }
      return `Host MCP returned ${tools.length} ranked schema result(s); schema bodies were not retained.`;
    }
    case "process_list": {
      const processes = requireArray(result, "processes", name);
      return `Host MCP returned a bounded snapshot of ${processes.length} tracked child process(es); process details were not retained.`;
    }
    case "sleep_ms": {
      if (result.slept_ms !== 5) throw new Error("sleep_ms did not acknowledge the exact bounded delay");
      return "Host MCP completed the exact bounded 5 ms async delay.";
    }
    default:
      throw new Error(`missing Host MCP effect oracle for ${name} under ${fixtures.nodeRoot}`);
  }
}

function expectedSafetyEffect(name: string): string {
  if (name === "Agent") {
    return "Host MCP permission-gated Agent and enforced required spawn arguments before starting any provider process.";
  }
  if (["browser_evaluation_write", "browser_resolve_dialog", "browser_workflow_replay", "browser_workflow_save"].includes(name)) {
    return `Host MCP permission-gated ${name} and enforced its exact pre-effect validation before changing Browser state or writing an artifact.`;
  }
  if (["Agent_kill", "Agent_output", "Agent_status"].includes(name)) {
    return `Host MCP exercised ${name}'s exact invalid-Agent safety boundary without starting, waiting for, reading, or terminating a provider process.`;
  }
  if (["process_attach_stdout", "process_signal", "process_stats"].includes(name)) {
    return `Host MCP exercised ${name}'s exact unknown-task registry boundary without reading or signalling a process.`;
  }
  if (["build_checkpoint", "build_complete", "build_receipt", "goal_complete"].includes(name)) {
    return `Host MCP permission-gated ${name} and returned its exact disposable-state refusal without changing Build, Goal, Git, or remote state.`;
  }
  if (["secret_delete", "secret_set", "vault_request_grant"].includes(name)) {
    return `Host MCP permission-gated ${name} and enforced its exact secret-safety refusal before contacting or mutating a secret backend.`;
  }
  if (["send_prompt_to_provider", "send_prompt_to_session"].includes(name)) {
    return `Host MCP permission-gated ${name} and enforced explicit user approval before starting or messaging any provider session.`;
  }
  if (["vision_describe", "vision_describe_v2", "voice_stt_v2", "voice_tts", "x_search"].includes(name)) {
    return `Host MCP permission-gated ${name} and enforced its exact input-validation refusal before credentials, files, outputs, or external services were touched.`;
  }
  return `Host MCP enforced ${name}'s exact bounded safety refusal without an external or durable effect.`;
}

async function advertisedToolNames(connection: McpConnection): Promise<Set<string>> {
  const result = await mcpRequest(connection, "tools/list", {});
  return new Set(requireArray(result, "tools", "tools/list")
    .filter(isRecord)
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string" && Boolean(name)));
}

async function callTool(
  connection: McpConnection,
  name: string,
  args: Record<string, unknown>,
  mutation = false,
): Promise<Record<string, unknown>> {
  const result = await mcpRequest(connection, "tools/call", { name, arguments: args }, mutation);
  if (result.isError === true) {
    const text = requireArray(result, "content", `${name} error`)
      .filter(isRecord)
      .map((entry) => entry.text)
      .find((value): value is string => typeof value === "string");
    throw new Error(`${name} returned an MCP tool error${text ? `: ${text}` : ""}`);
  }
  const structured = result.structuredContent;
  if (!isRecord(structured)) throw new Error(`${name} omitted structuredContent`);
  return structured;
}

async function callToolExpectingStructuredFailure(
  connection: McpConnection,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await mcpRequest(connection, "tools/call", { name, arguments: args });
  if (result.isError !== true) throw new Error(`${name} unexpectedly passed instead of returning its diagnostic failure`);
  const structured = result.structuredContent;
  if (!isRecord(structured)) throw new Error(`${name} diagnostic failure omitted structuredContent`);
  const text = requireArray(result, "content", `${name} diagnostic failure`)
    .filter(isRecord)
    .map((entry) => entry.text)
    .find((value): value is string => typeof value === "string");
  if (typeof structured.summary !== "string" || text !== structured.summary) {
    throw new Error(`${name} diagnostic failure text did not match its structured summary`);
  }
  return structured;
}

async function callToolExpectingError(
  connection: McpConnection,
  name: string,
  args: Record<string, unknown>,
  expectedSubstring: string,
  mutation = false,
): Promise<void> {
  const result = await mcpRequest(connection, "tools/call", { name, arguments: args }, mutation);
  if (result.isError !== true) throw new Error(`${name} unexpectedly succeeded instead of enforcing its safety boundary`);
  const content = requireArray(result, "content", `${name} error`);
  const text = content
    .filter(isRecord)
    .map((entry) => entry.text)
    .find((value): value is string => typeof value === "string");
  if (!text || !text.includes(expectedSubstring)) {
    throw new Error(`${name} returned the wrong bounded safety refusal`);
  }
  if (Object.hasOwn(result, "structuredContent")) {
    throw new Error(`${name} safety refusal unexpectedly included structured response data`);
  }
}

async function mcpRequest(
  connection: McpConnection,
  method: "tools/list" | "tools/call",
  params: Record<string, unknown>,
  mutation = false,
): Promise<Record<string, unknown>> {
  const id = `shellx-release-${method.replace("/", "-")}`;
  const response = await fetch(`${connection.base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mutation ? requireMutationToken(connection) : connection.baseToken}`,
      "Content-Type": "application/json",
      "MCP-Tab-Id": connection.tabId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(mutation ? 45_000 : 15_000),
  });
  if (!response.ok) throw new Error(`Host MCP ${method} returned HTTP ${response.status}`);
  const envelope = await response.json() as Record<string, unknown>;
  if (envelope.jsonrpc !== "2.0" || envelope.id !== id) throw new Error(`Host MCP ${method} returned an invalid JSON-RPC envelope`);
  if (isRecord(envelope.error)) throw new Error(`Host MCP ${method} returned JSON-RPC error ${String(envelope.error.message)}`);
  if (!isRecord(envelope.result)) throw new Error(`Host MCP ${method} omitted its result object`);
  return envelope.result;
}

function readMcpConnection(request: ReleaseSurfaceDriverRequest): McpConnection {
  const path = nodeReadablePath(request.runtime.mcpTokenPath, request.platform);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Host MCP token must be a regular non-link file");
  const token = readFileSync(path, "utf8").trim();
  if (token.length < 32) throw new Error("Host MCP token file is invalid");
  return {
    base: request.runtime.mcpBase.replace(/\/$/, ""),
    baseToken: token,
    tabId: `shellx-release-${request.runtime.instanceId}`,
  };
}

function createFixtures(request: ReleaseSurfaceDriverRequest): FixturePaths {
  const tokenNodePath = nodeReadablePath(request.runtime.mcpTokenPath, request.platform);
  const nodeProfileRoot = dirname(dirname(tokenNodePath));
  if (basename(tokenNodePath) !== "mcp.token" || basename(dirname(tokenNodePath)) !== ".shellx"
    || !/^shellx-final-webdriver-[a-f0-9]{16,64}$/.test(basename(nodeProfileRoot))) {
    throw new Error("Host MCP fixtures require the exact disposable final-run profile token path");
  }
  const launchProfileRoot = portableParent(portableParent(request.runtime.mcpTokenPath, request.platform), request.platform);
  const nodeRoot = resolve(nodeProfileRoot, "host-mcp-release-fixture");
  const rel = relative(resolve(nodeProfileRoot), nodeRoot);
  if (!rel || rel === "." || rel.startsWith(`..${sep}`) || rel === "..") {
    throw new Error("Host MCP fixture root escaped the disposable run profile");
  }
  if (existsSync(nodeRoot)) throw new Error("Host MCP fixture root must not exist before the driver run");
  mkdirSync(nodeRoot, { mode: 0o700 });
  // The disposable release profile normally lives beneath the canonical
  // ShellX repository. An empty .git directory is ignored by Git, so use an
  // intentionally unresolved gitfile to stop discovery at the owned fixture
  // boundary. This keeps build_checkpoint's refusal proof away from an
  // ancestor checkout on every platform.
  writeFileSync(join(nodeRoot, ".git"), "gitdir: .shellx-release-missing-gitdir\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const textNodePath = join(nodeRoot, "fixture.txt");
  const binaryNodePath = join(nodeRoot, "fixture.bin");
  const appendNodePath = join(nodeRoot, "append.txt");
  const copyNodePath = join(nodeRoot, "copy.txt");
  const deleteNodePath = join(nodeRoot, "delete.txt");
  const ensureDirNodePath = join(nodeRoot, "ensured");
  const writeNodePath = join(nodeRoot, "write.txt");
  const gatewayNodePath = join(nodeRoot, "gateway.txt");
  const previewEntryNodePath = join(nodeRoot, "release-preview.html");
  const memoryNamespace = `shellx-release-${request.runtime.instanceId}`;
  try {
    writeFileSync(textNodePath, TEXT_FIXTURE, { encoding: "utf8", flag: "wx", mode: 0o600 });
    writeFileSync(binaryNodePath, BINARY_FIXTURE, { flag: "wx", mode: 0o600 });
    writeFileSync(join(nodeRoot, "package.json"), '{"name":"shellx-release-security-fixture","private":true}\n', {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(appendNodePath, APPEND_BASE, { encoding: "utf8", flag: "wx", mode: 0o600 });
    writeFileSync(deleteNodePath, "delete-owned\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    writeFileSync(
      previewEntryNodePath,
      "<!doctype html><title>ShellX release Preview</title><main>SHELLX_RELEASE_OWNED_STATIC_PREVIEW_035</main>\n",
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    rmSync(nodeRoot, { recursive: true, force: true });
    throw error;
  }
  const launchRoot = portableJoin(launchProfileRoot, "host-mcp-release-fixture", request.platform);
  return {
    platform: request.platform,
    nodeRoot,
    launchRoot,
    textNodePath,
    textLaunchPath: portableJoin(launchRoot, "fixture.txt", request.platform),
    binaryNodePath,
    binaryLaunchPath: portableJoin(launchRoot, "fixture.bin", request.platform),
    appendNodePath,
    appendLaunchPath: portableJoin(launchRoot, "append.txt", request.platform),
    copyNodePath,
    copyLaunchPath: portableJoin(launchRoot, "copy.txt", request.platform),
    deleteNodePath,
    deleteLaunchPath: portableJoin(launchRoot, "delete.txt", request.platform),
    ensureDirNodePath,
    ensureDirLaunchPath: portableJoin(launchRoot, "ensured", request.platform),
    writeNodePath,
    writeLaunchPath: portableJoin(launchRoot, "write.txt", request.platform),
    gatewayNodePath,
    gatewayLaunchPath: portableJoin(launchRoot, "gateway.txt", request.platform),
    previewEntryNodePath,
    previewEntryLaunchPath: portableJoin(launchRoot, "release-preview.html", request.platform),
    previewTabId: `shellx-release-host-preview-${request.sourceCommit.slice(0, 16)}`,
    memoryNamespace,
    memoryDeleteKey: "delete-owned-key",
    memoryMissingKey: "missing-key",
    memoryListPrefix: "list-owned-",
    memorySetKey: "set-owned-key",
    vaultGeneratedItemId: `agent/${memoryNamespace}-generated-vault-item`,
    vaultGenerateCommitted: false,
    watchId: null,
    artifactNodePaths: new Set<string>(),
  };
}

async function cleanupWatchFixture(connection: McpConnection, fixtures: FixturePaths): Promise<string | null> {
  const watchId = fixtures.watchId;
  if (!watchId) return null;
  try {
    const stopped = await callTool(connection, "fs_unwatch", { watchId });
    if (stopped.ok !== true || stopped.watchId !== watchId) {
      throw new Error("fs_watch cleanup returned the wrong watch id");
    }
    fixtures.watchId = null;
    return null;
  } catch (error) {
    return `fs_watch cleanup: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function cleanupGeneratedVaultItem(
  connection: McpConnection,
  fixtures: FixturePaths,
): Promise<string | null> {
  try {
    const removed = await callTool(
      connection,
      "secret_delete",
      { key: `vault:${fixtures.vaultGeneratedItemId}` },
      true,
    );
    if (removed.ok !== true || removed.existed !== true || removed.key !== fixtures.vaultGeneratedItemId) {
      throw new Error("secret_delete did not remove the exact generated Vault item");
    }
    const readback = await callTool(connection, "vault_list", { prefix: fixtures.vaultGeneratedItemId });
    const entries = requireArray(readback, "entries", "vault_generate cleanup readback");
    if (entries.some((entry) => isRecord(entry) && entry.key === fixtures.vaultGeneratedItemId)) {
      throw new Error("generated Vault item remained after cleanup");
    }
    fixtures.vaultGenerateCommitted = false;
    return null;
  } catch (error) {
    return `vault_generate cleanup: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function cleanupHostPreviewFixture(
  connection: ShellxDebugApiConnection,
  fixtures: FixturePaths,
): Promise<string | null> {
  try {
    const statePath = `/preview/work/state?tabId=${encodeURIComponent(fixtures.previewTabId)}`;
    const before = await debugJson(connection.base, connection.token, statePath);
    const oldUrl = typeof before.url === "string" ? before.url : null;
    const stopped = await debugJson(
      connection.base,
      connection.token,
      `/preview/work/stop?tabId=${encodeURIComponent(fixtures.previewTabId)}`,
      { tabId: fixtures.previewTabId },
    );
    if (stopped.status !== "idle") verifyHostMcpStoppedPreviewState(stopped, fixtures, "preview_start cleanup");
    const readback = await debugJson(connection.base, connection.token, statePath);
    if (readback.status !== "idle") verifyHostMcpStoppedPreviewState(readback, fixtures, "preview_start cleanup readback");
    if (oldUrl) await verifyHostMcpPreviewUrlUnavailable(oldUrl);
    return null;
  } catch (error) {
    return `preview_start cleanup: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function cleanupMemoryFixtures(connection: McpConnection, fixtures: FixturePaths): Promise<string | null> {
  try {
    for (const key of [fixtures.memoryDeleteKey, fixtures.memorySetKey]) {
      await callTool(connection, "mem_delete", { namespace: fixtures.memoryNamespace, key }, true);
      const readback = await callTool(connection, "mem_get", { namespace: fixtures.memoryNamespace, key });
      if (readback.found !== false) throw new Error(`memory key ${key} remained after cleanup`);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function acquireMutationAutonomy(
  debugBase: string,
  debugToken: string,
  connection: McpConnection,
): Promise<AutonomyLease> {
  const initialState = await debugJson(debugBase, debugToken, "/state/ui");
  const baselineTabIds = uiOpenTabIds(initialState);
  let seededRendererBaseline = false;
  let tabId = "";
  let previousMode = "";
  let latestState = initialState;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (!tabId || !previousMode)) {
    const activeTab = isRecord(latestState.activeTab) ? latestState.activeTab : null;
    const reportedTabId = typeof activeTab?.tabId === "string" && activeTab.tabId.trim()
      ? activeTab.tabId.trim()
      : typeof latestState.activeTabId === "string" && latestState.activeTabId.trim()
        ? latestState.activeTabId.trim()
        : "";
    tabId = uiOpenTabIds(latestState).includes(reportedTabId) ? reportedTabId : "";
    previousMode = typeof activeTab?.autonomy === "string" && activeTab.autonomy.trim()
      ? activeTab.autonomy.trim()
      : typeof latestState.autonomy === "string" && latestState.autonomy.trim()
        ? latestState.autonomy.trim()
        : "";
    if (tabId && previousMode) break;
    if (!seededRendererBaseline && uiOpenTabIds(latestState).length === 0) {
      if (latestState.releaseTestInstance !== true) {
        throw new Error("Host MCP mutation fixture refuses to seed a renderer tab outside an isolated release-test instance");
      }
      await debugJson(debugBase, debugToken, "/state/ui", {
        debugClick: "[aria-label='New session']",
        source: "final-surface-host-mcp-baseline",
      });
      seededRendererBaseline = true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    latestState = await debugJson(debugBase, debugToken, "/state/ui");
    const addedTabIds = uiOpenTabIds(latestState).filter((id) => !baselineTabIds.includes(id));
    if (addedTabIds.length > 1) {
      throw new Error("Host MCP mutation fixture created more than one renderer baseline tab");
    }
    if (addedTabIds.length === 1 && typeof latestState.activeTabId === "string"
      && latestState.activeTabId !== addedTabIds[0]) {
      throw new Error("Host MCP mutation fixture did not activate its exact renderer baseline tab");
    }
  }
  if (!tabId || !previousMode) {
    throw new Error("Host MCP mutation fixture could not establish a renderer-owned active tab and autonomy state");
  }
  if (seededRendererBaseline && baselineTabIds.includes(tabId)) {
    throw new Error("Host MCP mutation fixture did not bind to its newly seeded renderer baseline tab");
  }
  const lease = { debugBase, debugToken, tabId, previousMode, seededRendererBaseline };
  try {
    const response = await debugJson(
      debugBase,
      debugToken,
      `/autonomy?tabId=${encodeURIComponent(tabId)}`,
      { mode: "bypassPermissions", tabId },
    );
    if (response.ok !== true || response.mode !== "bypassPermissions" || response.tabId !== tabId) {
      throw new Error("Host MCP mutation fixture could not establish exact tab-scoped Auto autonomy");
    }
  } catch (error) {
    const restoreError = await restoreMutationAutonomy(lease);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}`
      + (restoreError ? `; ${restoreError}` : ""),
    );
  }
  connection.tabId = tabId;
  connection.mutationToken = deriveTabBoundToken(connection.baseToken, tabId);
  return lease;
}

function uiOpenTabIds(state: Record<string, unknown>): string[] {
  if (!Array.isArray(state.openTabs)) return [];
  return state.openTabs.flatMap((value) => {
    if (!isRecord(value) || typeof value.tabId !== "string") return [];
    const tabId = value.tabId.trim();
    return tabId ? [tabId] : [];
  });
}

async function restoreMutationAutonomy(lease: AutonomyLease): Promise<string | null> {
  try {
    const response = await debugJson(
      lease.debugBase,
      lease.debugToken,
      `/autonomy?tabId=${encodeURIComponent(lease.tabId)}`,
      { mode: lease.previousMode, tabId: lease.tabId },
    );
    if (response.ok !== true || response.mode !== lease.previousMode || response.tabId !== lease.tabId) {
      throw new Error("autonomy restore returned the wrong tab or mode");
    }
    return null;
  } catch (error) {
    return `autonomy restore: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function debugJson(
  base: string,
  token: string,
  path: string,
  body?: Record<string, unknown>,
  additionalHeaders: Record<string, string> = {},
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...additionalHeaders,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Debug API ${path} returned HTTP ${response.status}`);
  const value = await response.json() as unknown;
  if (!isRecord(value)) throw new Error(`Debug API ${path} returned a non-object payload`);
  return value;
}

async function startBrowserMutationFixture(
  connection: ShellxDebugApiConnection,
  callerTabId: string,
  startTask: boolean,
): Promise<BrowserMutationFixture> {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method !== "GET" || !["/start", "/target"].includes(pathname)) {
      response.writeHead(404).end();
      return;
    }
    const label = pathname === "/target" ? "Target reached" : "Start page";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><title>ShellX Host MCP Browser fixture</title><style>body{margin:0}main{padding:220px 24px 24px}#coordinate-button{position:absolute;left:40px;top:40px;width:180px;height:44px}#coordinate-input{position:absolute;left:40px;top:120px;width:220px;height:40px}#capturable-secret{position:absolute;left:240px;top:40px;width:220px;height:40px}</style><main><h1>${label}</h1><label>Name <input id="name" /></label><label>API key <input id="capturable-secret" type="password" value="${HOST_MCP_CAPTURE_FIXTURE_VALUE}" /></label><button id="advance" onclick="document.querySelector('#status').textContent='Action target ready — Host MCP candidate ready'">Advance candidate</button><p id="status">Action target ready</p><button id="coordinate-button" onclick="document.querySelector('#coordinate-status').textContent='Coordinate click ready'">Coordinate button</button><input id="coordinate-input" aria-label="Coordinate input" /><p id="coordinate-status">Coordinate idle</p></main>`);
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
  if (!address || typeof address === "string") {
    await closeBrowserFixtureServer(server, sockets);
    throw new Error("browser_act local fixture did not bind");
  }
  const base = `http://127.0.0.1:${address.port}`;
  let taskId: string | null = null;
  try {
    if (!startTask) return { taskId: null, targetUrl: `${base}/target`, server, sockets };
    const task = await debugJson(
      connection.base,
      connection.token,
      "/browser/task/start",
      {
        goal: "Final surface compact browser_act navigation proof",
        startUrl: `${base}/start`,
        profileId: "task-disposable",
        autonomy: "assistedAutonomous",
        expectedDomains: ["127.0.0.1"],
      },
      { "X-ShellX-MCP-Caller-ID": callerTabId },
      30_000,
    );
    taskId = typeof task.taskId === "string" ? task.taskId.trim() : "";
    if (!taskId) throw new Error("browser_act Browser task start returned no taskId");
    const settled = await debugJson(
      connection.base,
      connection.token,
      `/browser/settle?taskId=${encodeURIComponent(taskId)}&timeoutMs=30000`,
      undefined,
      { "X-ShellX-MCP-Caller-ID": callerTabId },
      35_000,
    );
    if (settled.settled !== true) throw new Error("browser_act Browser task did not settle at its owned start page");
    return { taskId, targetUrl: `${base}/target`, server, sockets };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (taskId) {
      const cleanupError = await cleanupBrowserMutationFixture(
        connection,
        { taskId, targetUrl: `${base}/target`, server, sockets },
        callerTabId,
      );
      throw new Error(cleanupError ? `${detail}; ${cleanupError}` : detail);
    }
    await closeBrowserFixtureServer(server, sockets);
    throw new Error(detail);
  }
}

async function cleanupBrowserMutationFixture(
  connection: ShellxDebugApiConnection,
  fixture: BrowserMutationFixture,
  callerTabId: string,
): Promise<string | null> {
  const errors: string[] = [];
  if (fixture.taskId) {
    try {
      const cleanup = await cleanupOwnedBrowserLifecycle(
        (method, path, body) => debugJson(
          connection.base,
          connection.token,
          path,
          method === "POST" ? body : undefined,
          { "X-ShellX-MCP-Caller-ID": callerTabId },
          30_000,
        ),
        { taskIds: [fixture.taskId], label: "final-surface-host-mcp-browser" },
      );
      errors.push(...cleanup.errors);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    await closeBrowserFixtureServer(fixture.server, fixture.sockets);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors.length > 0 ? `browser_act cleanup: ${errors.join(" | ")}` : null;
}

async function closeBrowserFixtureServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

function deriveTabBoundToken(baseToken: string, tabId: string): string {
  const digest = createHash("sha256")
    .update("shellx-mcp-tab-token-v1\0")
    .update(baseToken)
    .update("\0")
    .update(tabId)
    .digest("hex");
  return `sx_tab_${digest}`;
}

function requireMutationToken(connection: McpConnection): string {
  if (!connection.mutationToken) throw new Error("Host MCP mutation token was not established");
  return connection.mutationToken;
}

function cleanupFixtures(fixtures: FixturePaths): string | null {
  try {
    rmSync(fixtures.nodeRoot, { recursive: true });
    if (existsSync(fixtures.nodeRoot)) throw new Error("owned fixture root remained after deletion");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function recordOwnedArtifact(
  artifact: Record<string, unknown>,
  label: string,
  fixtures: FixturePaths,
  request: ReleaseSurfaceDriverRequest,
): string {
  const launchPath = requiredString(artifact.finalPath ?? artifact.path, `${label}.path`);
  const nodePath = resolve(nodeReadablePath(launchPath, request.platform));
  const profileRoot = resolve(dirname(fixtures.nodeRoot));
  const rel = relative(profileRoot, nodePath);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label} artifact escaped the disposable final-run profile`);
  }
  const stat = lstatSync(nodePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024 * 1024) {
    throw new Error(`${label} artifact was not one bounded regular file`);
  }
  const bytes = Number(artifact.bytes);
  const sha256 = requiredString(artifact.sha256, `${label}.sha256`);
  if (!Number.isSafeInteger(bytes) || bytes !== stat.size || !/^[a-f0-9]{64}$/.test(sha256)
    || createHash("sha256").update(readFileSync(nodePath)).digest("hex") !== sha256) {
    throw new Error(`${label} artifact byte or SHA-256 identity did not match the owned file`);
  }
  fixtures.artifactNodePaths.add(nodePath);
  return nodePath;
}

function cleanupArtifactFixtures(fixtures: FixturePaths): string | null {
  const errors: string[] = [];
  for (const path of fixtures.artifactNodePaths) {
    try {
      if (!existsSync(path)) throw new Error("owned artifact disappeared before cleanup");
      rmSync(path);
      if (existsSync(path)) throw new Error("owned artifact remained after deletion");
    } catch (error) {
      errors.push(`${basename(path)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  fixtures.artifactNodePaths.clear();
  return errors.length ? `Browser artifact cleanup: ${errors.join(" | ")}` : null;
}

function nodeReadablePath(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) {
    return resolve(path);
  }
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("unable to map the Host MCP token path");
  return resolve(result.stdout.trim());
}

function portableParent(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed") return dirname(path);
  const normalized = path.replaceAll("/", "\\").replace(/\\+$/, "");
  const index = normalized.lastIndexOf("\\");
  if (index <= 2) throw new Error("Host MCP token path is outside a disposable Windows profile");
  return normalized.slice(0, index);
}

function portableJoin(base: string, child: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  return platform === "windows-installed"
    ? `${base.replace(/[\\/]+$/, "")}\\${child}`
    : join(base, child);
}

function samePortablePath(
  actual: unknown,
  expected: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): boolean {
  if (typeof actual !== "string" || !actual.trim()) return false;
  if (platform !== "windows-installed") {
    try {
      return realpathSync(actual) === realpathSync(expected);
    } catch {
      return resolve(actual) === resolve(expected);
    }
  }
  const normalize = (value: string) => value
    .replaceAll("/", "\\")
    .replace(/^\\\\\?\\/, "")
    .replace(/\\+$/, "")
    .toLowerCase();
  return normalize(actual) === normalize(expected);
}

function stableHostMcpPreviewState(value: Record<string, unknown>, tabId: string): string {
  requireExactKeys(value, [
    "command", "cwd", "error", "kind", "logs", "pid", "startedAtMs", "status", "tabId",
    "taskId", "updatedAtMs", "url", "viewportHint",
  ], "Host MCP Preview state");
  if (value.tabId !== tabId || value.status !== "idle" || value.cwd !== null || value.kind !== null
    || value.url !== null || value.command !== null || value.taskId !== null || value.pid !== null
    || value.startedAtMs !== null || !Number.isSafeInteger(value.updatedAtMs)
    || value.viewportHint !== null || value.error !== null
    || !Array.isArray(value.logs) || value.logs.length !== 0) {
    throw new Error("Host MCP Preview state did not preserve the exact idle disposable-tab contract");
  }
  const stable = { ...value };
  delete stable.updatedAtMs;
  return JSON.stringify(stable);
}

function verifyHostMcpRunningPreviewState(
  value: Record<string, unknown>,
  fixtures: FixturePaths,
  label: string,
): string {
  requireExactKeys(value, [
    "command", "cwd", "error", "kind", "logs", "pid", "startedAtMs", "status", "tabId",
    "taskId", "updatedAtMs", "url", "viewportHint",
  ], label);
  const url = typeof value.url === "string" ? value.url : "";
  if (value.tabId !== fixtures.previewTabId || !samePortablePath(value.cwd, fixtures.launchRoot, fixtures.platform)
    || value.kind !== "staticHtml" || value.status !== "running"
    || !/^http:\/\/127\.0\.0\.1:\d+\//.test(url)
    || value.command !== "shellX static file server" || value.taskId !== null || value.pid !== null
    || !Number.isSafeInteger(value.startedAtMs) || !Number.isSafeInteger(value.updatedAtMs)
    || value.viewportHint !== null || value.error !== null
    || !Array.isArray(value.logs) || value.logs.length < 2) {
    throw new Error(`${label} did not match the exact owned static Preview running state`);
  }
  return url;
}

function verifyHostMcpStoppedPreviewState(
  value: Record<string, unknown>,
  fixtures: FixturePaths,
  label: string,
): void {
  requireExactKeys(value, [
    "command", "cwd", "error", "kind", "logs", "pid", "startedAtMs", "status", "tabId",
    "taskId", "updatedAtMs", "url", "viewportHint",
  ], label);
  if (value.tabId !== fixtures.previewTabId || !samePortablePath(value.cwd, fixtures.launchRoot, fixtures.platform)
    || value.kind !== "staticHtml" || value.status !== "stopped" || value.url !== null
    || value.command !== "shellX static file server" || value.taskId !== null || value.pid !== null
    || !Number.isSafeInteger(value.startedAtMs) || !Number.isSafeInteger(value.updatedAtMs)
    || value.viewportHint !== null || value.error !== null
    || !Array.isArray(value.logs) || value.logs.length < 3) {
    throw new Error(`${label} did not match the exact stopped static Preview state`);
  }
}

async function verifyHostMcpPreviewPage(url: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  const body = await response.text();
  if (!response.ok
    || !body.includes("<main>SHELLX_RELEASE_OWNED_STATIC_PREVIEW_035</main>")
    || !body.includes("data-shellx-preview-doctor")) {
    throw new Error("preview_start did not serve the exact owned static page");
  }
}

async function verifyHostMcpPreviewUrlUnavailable(url: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (!response.ok) return;
    } catch {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("stopped Host MCP Work Preview endpoint remained reachable");
}

function requireExactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} returned unexpected keys: ${actual.join(", ")}`);
  }
}

function requireArray(value: Record<string, unknown>, key: string, label: string): unknown[] {
  const result = value[key];
  if (!Array.isArray(result)) throw new Error(`${label} omitted ${key}`);
  return result;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} was not a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
