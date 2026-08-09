import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  candidateTeardownCleanupRequired,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "./lib/release-surface-driver-protocol";
import { releaseSurfaceControllerBindingFixture, releaseSurfaceFixtureSourceCommit } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";

const root = resolve(import.meta.dirname, "..");
const tempContainer = mkdtempSync(join(tmpdir(), "shellx-tauri-command-webdriver-"));
const runId = "b".repeat(16);
const temp = join(tempContainer, `shellx-final-webdriver-${runId}`);
const statePath = join(tempContainer, "fixture-state.json");
const tokenPath = join(temp, ".shellx", "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-tauri-command-webdriver-token-0001";
const instanceId = "fixture-tauri-command-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixturePlatform = process.platform === "win32" ? "windows-installed" : "linux-installed";
const fixtureImagePath = fixturePlatform === "windows-installed"
  ? "C:\\Temp\\ShellXReleaseFixture\\shellx.exe"
  : "/tmp/fixture/shellx";
const commands = [
  "abort_session",
  "append_session_log",
  "add_build_operator_note",
  "agent_cli_setup_cancel_install",
  "agent_cli_setup_confirm_install",
  "agent_cli_setup_prepare_install",
  "agent_cli_setup_recheck",
  "agent_cli_setup_state",
  "approve_build_plan",
  "approve_goal_plan",
  "archive_session_artifacts",
  "capture_app_screenshot_to_file",
  "cleanup_mcp_children_for_tab",
  "copy_asset_to_scope",
  "copy_to_scope",
  "connection_provider_scan",
  "connections_delete",
  "connections_list",
  "connections_save",
  "connections_test",
  "debug_ui_snapshot",
  "delete_session_files",
  "delete_user_data_section",
  "desktop_integration_status",
  "desktop_integration_install_windows_context_menu",
  "desktop_integration_remove_windows_context_menu",
  "drop_tab_session",
  "get_build_receipts",
  "get_build_state",
  "get_bound_ports",
  "get_debug_port",
  "get_debug_token",
  "get_detected_max_tokens",
  "get_goal_state",
  "git_branches",
  "git_session_create_checkpoint",
  "git_session_create_worktree",
  "git_session_diff",
  "git_session_status",
  "grok_environment_snapshot",
  "grok_trace_export",
  "get_home_dir",
  "halt_build",
  "host_skill_status",
  "interject_prompt",
  "list_background_tasks",
  "list_project_files",
  "list_stored_sessions",
  "mark_goal_complete",
  "mcp_marketplace_install",
  "mcp_marketplace_list",
  "mcp_marketplace_set_enabled",
  "mcp_marketplace_uninstall",
  "open_url_in_browser",
  "outside_connectors_capabilities",
  "outside_connectors_delete",
  "outside_connectors_events",
  "outside_connectors_list",
  "outside_connectors_save",
  "outside_connectors_simulate",
  "outside_connectors_test",
  "pause_build",
  "pause_goal",
  "pty_attach",
  "pty_create",
  "pty_kill",
  "pty_resize",
  "pty_write",
  "read_image_as_data_url",
  "read_preview_file_as_data_url",
  "read_session_activity_source",
  "read_session_jsonl",
  "read_session_jsonl_tail",
  "read_user_data",
  "read_text_file_for_path",
  "read_text_file_if_text",
  "release_test_take_native_picker",
  "recheck_build_blocker",
  "reject_build_plan",
  "reject_goal_plan",
  "rename_past_session",
  "renderer_error",
  "request_goal_replan",
  "resolve_permission_request",
  "resume_build",
  "resume_goal",
  "save_dropped_attachment_to_scope",
  "send_prompt",
  "shellx_browser_copy_local_artifact",
  "session_tooling_snapshot",
  "set_permission_mode",
  "set_goal_mode",
  "shellx_browser_approve_developer_mode_host",
  "shellx_browser_claim_cowork_prompt",
  "shellx_browser_clear_history",
  "shellx_browser_control_task",
  "shellx_browser_state",
  "shellx_browser_sync_engine",
  "shellx_browser_replay_cowork_prompt_notifications",
  "shellx_browser_delegate_tab_to_agent",
  "shellx_browser_finish_task",
  "shellx_browser_grant_transfer",
  "shellx_browser_open_window",
  "shellx_browser_open_vault_panel",
  "shellx_browser_operator_evidence_summary",
  "shellx_browser_operator_export_flight_recorder",
  "shellx_browser_remove_site_shields",
  "shellx_browser_resolve_dialog",
  "shellx_browser_resolve_permission",
  "shellx_browser_resolve_session_grant",
  "shellx_browser_send_cowork_prompt",
  "shellx_browser_take_back_tab_from_agent",
  "shellx_browser_update_developer_mode",
  "shellx_browser_update_download_folder",
  "shellx_browser_update_personal_lock",
  "shellx_browser_update_privacy",
  "shellx_browser_update_shields",
  "shellx_browser_update_site_shields",
  "shellx_browser_write_text_artifact",
  "shellx_vault_approve_grant",
  "shellx_vault_agent_request_approve",
  "shellx_vault_agent_request_center",
  "shellx_vault_agent_request_deny",
  "shellx_vault_begin_setup",
  "shellx_vault_confirm_recovery_saved",
  "shellx_vault_create_grant",
  "shellx_vault_list_grants",
  "shellx_vault_lock",
  "shellx_vault_revoke_grant",
  "shellx_vault_set_remembered_device_enabled",
  "shellx_vault_unlock",
  "shellxagent_token_regenerate",
  "shellxagent_token_read",
  "start_build_mode",
  "start_grok_session",
  "synthesize_voice",
  "task_kill",
  "task_pause",
  "task_resume",
  "transcribe_audio_blob",
  "vault_delete",
  "vault_get",
  "vault_list_keys",
  "vault_list_keys_with_meta",
  "vault_list_resources",
  "vault_set",
  "vault_set_resource",
  "vault_status",
  "vault_update_metadata",
  "vault_update_resource_metadata",
  "voice_credential_source",
  "workflow_skill_statuses",
  "write_user_data",
];
const fixtureCommands = commands.filter((command) => (
  command !== "desktop_integration_install_windows_context_menu"
  && command !== "desktop_integration_remove_windows_context_menu"
));
assert.deepEqual(
  [...commands, "shellx_browser_fill_user_vault_secret"].sort(),
  readFileSync(resolve(root, "src-tauri/src/release_tauri_command_allowlist.txt"), "utf8")
    .trim()
    .split(/\r?\n/)
    .sort(),
  "generic plus trusted-Vault-fill driver fixtures must match the backend relay allowlist exactly",
);
let fixture: ChildProcess | null = null;
const terminateOwnedFixture = (): void => {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  rmSync(tempContainer, { recursive: true, force: true });
};
const onTerminationSignal = (): never => {
  terminateOwnedFixture();
  process.exit(143);
};
process.once("SIGINT", onTerminationSignal);
process.once("SIGTERM", onTerminationSignal);

try {
  mkdirSync(join(temp, ".shellx"), { recursive: true });
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  writeFileSync(join(temp, "shellx-final-profile.json"), `${JSON.stringify({
    schema: "shellx/release-surface-run-profile@1",
    platform: fixturePlatform,
    runId,
    nodePath: temp,
    launchPath: temp,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-tauri-command-webdriver-server-fixture.ts"),
    "--state-out", statePath,
    "--token", token,
    "--instance-id", instanceId,
    "--process-id", "4321",
    "--version", "0.3.5",
    "--source-commit", sourceCommit,
    "--profile-root", temp,
    "--platform", fixturePlatform === "windows-installed" ? "windows" : "linux",
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, fixture);
  const candidateBase = `http://127.0.0.1:${ports.candidatePort}`;
  const request: ReleaseSurfaceDriverRequest = {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "tauri-command-installed",
    driverKind: "tauri-command",
    platform: fixturePlatform,
    sourceCommit,
    version: "0.3.5",
    inventoryDigest: "a".repeat(64),
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: {
      ...releaseSurfaceControllerBindingFixture("scripts/release-drivers/tauri-command-installed.ts"),
      auxiliaryFiles: [
        "scripts/probe-release-surface-windows-desktop-integration.ps1",
        "scripts/release-drivers/windows-desktop-integration-lifecycle.ts",
      ].map((relativePath) => {
        const bytes = readFileSync(resolve(root, relativePath));
        return {
          relativePath,
          basename: relativePath.split("/").at(-1)!,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        };
      }),
    },
    runtime: {
      processId: 4321,
      instanceId,
      debugBase: candidateBase,
      debugTokenPath: tokenPath,
      mcpBase: "http://127.0.0.1:9",
      mcpTokenPath: tokenPath,
      executableSha256: "d".repeat(64),
      installedPayloadPath: fixtureImagePath,
      installedManifestSha256: "e".repeat(64),
      ...(fixturePlatform === "windows-installed" ? {
        windowsNative: {
          schema: "shellx/release-surface-windows-native-binding@1" as const,
          process: {
            pid: 4321,
            startId: "2026-07-28T17:59:00.000Z",
            imagePath: fixtureImagePath,
            imageSha256: "d".repeat(64),
            imageBytes: 1024,
            imageFileId: `abcd1234:0x${"1".repeat(32)}`,
          },
          listener: {
            address: "127.0.0.1" as const,
            port: Number(new URL(candidateBase).port),
            owningPid: 4321,
          },
        },
      } : {
        posixNative: releaseSurfacePosixNativeBindingFixture({
          processId: 4321,
          port: Number(new URL(candidateBase).port),
          imagePath: fixtureImagePath,
          imageSha256: "d".repeat(64),
        }),
      }),
    },
    assignments: fixtureCommands.map((command) => ({
      surface: {
        id: `tauri-command:${command}`,
        kind: "tauri-command",
        name: command,
        source: "src-tauri/src/lib.rs",
        platforms: ["linux-installed", "windows-installed", "macos-installed"],
        delivery: "installed-app",
      },
      fixtureId: testFixtureId(command),
      expectedEffect: command === "start_grok_session"
        ? "Installed Tauri IPC initializes one real local Grok ACP child without sending a prompt, then aborts and removes the slot."
        : `${command} returns its exact safe read-only schema through installed Tauri IPC.`,
      oracleId: testOracleId(command),
      cleanupId: testCleanupId(command),
    })),
  };
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const driverPath = resolve(root, "scripts/release-drivers/tauri-command-installed.ts");
  const described = spawnSync(process.execPath, ["--import", "tsx", driverPath, "--describe"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    invocationTransport?: string;
    supportedFixtures?: string[];
    supportedCleanups?: string[];
    supportedOracles?: string[];
  };
  assert.equal(manifest.invocationTransport, "debug-api-direct");
  assert(manifest.supportedFixtures?.includes("tauri:isolated-local-grok-session"));
  assert(manifest.supportedCleanups?.includes("tauri:abort-owned-grok-session-and-drop-slot"));
  assert(manifest.supportedCleanups?.includes("tauri:close-vault-panel-after-retries"));
  assert(manifest.supportedCleanups?.includes("tauri:restore-browser-setting-state"));
  assert(manifest.supportedCleanups?.includes("tauri:close-owned-browser-history-fixture"));
  assert(manifest.supportedCleanups?.includes("tauri:close-owned-browser-evidence-fixture"));
  assert(manifest.supportedCleanups?.includes("tauri:close-owned-browser-engine-sync"));
  assert(manifest.supportedCleanups?.includes("tauri:discard-with-candidate-profile"));
  assert(manifest.supportedOracles?.includes("tauri:shellx_browser_open_vault_panel:visible-vault-workspace"));
  assert(manifest.supportedOracles?.includes("tauri:shellx_browser_update_shields:owned-browser-setting"));
  assert(manifest.supportedOracles?.includes("tauri:shellx_browser_sync_engine:owned-engine-preserved"));
  assert(manifest.supportedOracles?.includes("tauri:shellx_browser_operator_evidence_summary:owned-evidence-row"));
  assert(manifest.supportedOracles?.includes("tauri:shellx_browser_operator_export_flight_recorder:owned-artifact"));
  assert.equal(manifest.supportedOracles?.length, commands.length);

  const run = spawnSync(process.execPath, [
    "--import", "tsx", driverPath,
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 30_000 });
  const reportOnFailure = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "no report created";
  const failedOutcomes = existsSync(reportPath)
    ? (JSON.parse(reportOnFailure) as ReleaseSurfaceDriverReport).outcomes.filter((outcome) => {
      const cleanupId = outcome.cleanupEvidence?.cleanupId ?? "";
      const expectedCleanup = candidateTeardownCleanupRequired(cleanupId)
        ? "deferred-candidate-teardown"
        : "pass";
      return outcome.present !== "pass"
        || outcome.invoke !== "pass"
        || outcome.effect !== "pass"
        || outcome.cleanup !== expectedCleanup
        || outcome.cleanupEvidence?.status !== expectedCleanup;
    })
    : [];
  assert.equal(run.status, 0, `${run.stderr || run.stdout}\n${JSON.stringify(failedOutcomes, null, 2)}`);
  const reportText = readFileSync(reportPath, "utf8");
  const report = JSON.parse(reportText) as ReleaseSurfaceDriverReport;
  assert.equal(report.outcomes.length, fixtureCommands.length);
  assert.deepEqual(
    report.outcomes
      .filter((outcome) => outcome.cleanup === "deferred-candidate-teardown")
      .map((outcome) => outcome.cleanupEvidence?.cleanupId),
    ["tauri:discard-with-candidate-profile", "tauri:discard-with-candidate-profile"],
  );
  assert.equal(failedOutcomes.length, 0);
  for (const privateValue of [
    "/home/fixture-private-path",
    "fixture-key-private",
    "fixture-resource-private",
    "fixture-grant-private",
    "fixture-secret-private",
    "fixture command must not be retained",
    "fixture output must not be retained",
    "grok.exe-private",
    "fixture-version-private",
    "fixture-environment-private",
    "fixture-environment-trace-private",
    "fixture-connection-private",
    "fixture-host-private",
    "fixture-session-private",
    "Fixture session title private",
    "fixture-connector-private",
    "fixture message private",
    "fixture-vault-reference-private",
    "fixture-key-meta-private",
    "fixture-description-private",
    "fixture-marketplace-private",
    "fixture-tooling-private",
    "Fixture marketplace private",
    "Fixture marketplace description private",
    "fixture-marketplace-vault-private",
    "fixture-vault-request-private",
    "fixture-vault-actor-private",
    "Fixture Vault actor private",
    "fixture private purpose",
    "fixture-vault-resource-private",
    "Fixture Vault resource private",
    "Final surface local connection",
    "Final surface inert connector",
    "final-surface-unused-vault-reference",
    `SHELLX_RELEASE_GIT_DIFF_${sourceCommit.slice(0, 16)}`,
    `SHELLX_RELEASE_SESSION_CANARY_${sourceCommit.slice(0, 16)}`,
    `Release session history ${sourceCommit.slice(0, 16)}`,
    ...[
      "copy_asset_to_scope",
      "copy_to_scope",
      "save_dropped_attachment_to_scope",
      "shellx_browser_copy_local_artifact",
      "shellx_browser_write_text_artifact",
    ].map((command) => `SHELLX_RELEASE_FILE_${sourceCommit.slice(0, 16)}_${command}`),
    ...[
      "vault_delete",
      "vault_get",
      "vault_set",
      "vault_set_resource",
      "vault_update_metadata",
      "vault_update_resource_metadata",
    ].map((command) => `SHELLX_RELEASE_VAULT_${sourceCommit.slice(0, 16)}_${command}`),
    "Final surface profile resource",
    "Final surface updated metadata",
    "Final surface updated resource",
    "Owned release validation profile",
    "Updated owned release profile",
    createHash("sha256").update(`${token}:${sourceCommit}`).digest("hex").slice(0, 32),
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC",
    token,
    `SHELLX_RELEASE_SESSION_APPEND_${sourceCommit.slice(0, 16)}`,
    `Release renamed session ${sourceCommit.slice(0, 16)}`,
    `SHELLX_RELEASE_USER_DATA_${sourceCommit.slice(0, 16)}`,
    `SHELLX_RELEASE_RENDERER_ERROR_${sourceCommit.slice(0, 16)}`,
    "final-surface-renderer-stack",
    "final-surface-component-stack",
    "SHELLX_RELEASE_USER_DATA_DELETE",
    "SHELLX_RELEASE_USER_DATA_PRESERVED",
    ...["mark_goal_complete", "pause_goal", "reject_goal_plan", "resume_goal", "set_goal_mode"]
      .map((command) => `Release surface ${command} ${sourceCommit.slice(0, 16)}`),
  ]) {
    assert(!reportText.includes(privateValue), `driver report retained private command data: ${privateValue}`);
  }

  const audit = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(audit.status, 200);
  const auditBody = await audit.json() as {
    invoked: Array<{ command: string; args: unknown }>;
    activeStateKeys: string[];
    activeGrokTabs: Array<[string, string]>;
    vaultPanelOpen: boolean;
    vaultPanelOpenEvents: number;
    vaultPanelCloseActions: number;
  };
  assert.deepEqual(
    auditBody.invoked.map((entry) => entry.command),
    fixtureCommands.flatMap(expectedInvocationSequence),
  );
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "vault_list_keys")?.args, { prefix: null });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "outside_connectors_events")?.args, { limit: 20 });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "session_tooling_snapshot")?.args, {
    tabId: "final-surface-tooling-fixture",
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "read_session_activity_source")?.args, {
    tabId: "final-surface-activity-missing-session",
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "grok_environment_snapshot")?.args, {
    tabId: "final-surface-environment-missing-session",
    force: false,
    cwd: null,
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "list_project_files")?.args, {
    path: temp,
    tabId: "final-surface-profile-fixture",
    connectionId: null,
    includeHidden: false,
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "read_text_file_for_path")?.args, {
    path: join(temp, "shellx-final-profile.json"),
    tabId: "final-surface-profile-fixture",
    sessionCwd: temp,
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "read_text_file_if_text")?.args, {
    path: join(temp, "shellx-final-profile.json"),
    maxBytes: 64 * 1024,
  });
  const contextSlotInvocations = auditBody.invoked.filter((entry) => (
    (entry.command === "get_detected_max_tokens" || entry.command === "drop_tab_session")
    && JSON.stringify(entry.args) === JSON.stringify({ tabId: "final-surface-context-fixture" })
  ));
  assert.equal(contextSlotInvocations.length, 4, "both context-slot assignments must prepare and remove their exact slot");
  const gitSegment = sourceCommit.slice(0, 16);
  const gitFixturePath = join(temp, ".shellx", `release-surface-git-${gitSegment}`);
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "git_branches")?.args, {
    cwd: gitFixturePath,
    tabId: `release-git-${gitSegment}`,
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "git_session_status")?.args, {
    cwd: gitFixturePath,
    tabId: `release-git-${gitSegment}`,
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "git_session_diff")?.args, {
    cwd: gitFixturePath,
    tabId: `release-git-${gitSegment}`,
    scope: "head",
  });
  const historySessionId = `release_session_${sourceCommit.slice(0, 16)}`;
  assert.deepEqual(auditBody.invoked.find((entry) => (
    entry.command === "read_session_jsonl"
    && (entry.args as { sessionId?: unknown }).sessionId === historySessionId
  ))?.args, {
    sessionId: historySessionId,
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "read_session_jsonl_tail")?.args, {
    sessionId: historySessionId,
    limit: 2,
  });
  assert.equal(
    existsSync(join(temp, ".shellx", "sessions", `${historySessionId}.jsonl`)),
    false,
    "owned Tauri session history fixture must be removed",
  );
  const mediaPath = join(temp, "shellx-final-media.png");
  for (const mediaCommand of ["read_image_as_data_url", "read_preview_file_as_data_url"]) {
    assert.deepEqual(auditBody.invoked.find((entry) => entry.command === mediaCommand)?.args, {
      path: mediaPath,
      tabId: "final-surface-media-fixture",
      sessionCwd: temp,
    });
  }
  assert.equal(existsSync(mediaPath), false, "owned Tauri media fixture must be removed");
  assert.equal(existsSync(gitFixturePath), false, "owned Tauri Git fixture must be removed");
  for (const stateCommand of ["get_build_receipts", "get_build_state", "get_goal_state"]) {
    assert.deepEqual(auditBody.invoked.find((entry) => (
      entry.command === stateCommand
      && (entry.args as { tabId?: unknown }).tabId === "final-surface-read-fixture"
    ))?.args, {
      tabId: "final-surface-read-fixture",
    });
  }
  for (const providerCommand of ["agent_cli_setup_state", "connection_provider_scan"]) {
    assert.deepEqual(
      (auditBody.invoked.find((entry) => entry.command === providerCommand)?.args as { preset?: unknown })?.preset,
      {
        id: "",
        label: "Final local runtime",
        transport: { kind: "local" },
        createdMs: 0,
        lastUsedMs: 0,
        providerScan: [],
      },
    );
  }
  const localPreset = {
    id: "",
    label: "Final local runtime",
    transport: { kind: "local" },
    createdMs: 0,
    lastUsedMs: 0,
    providerScan: [],
  };
  const exactNewArgs: Record<string, unknown> = {
    add_build_operator_note: { tabId: "final-surface-absent-build", text: "" },
    agent_cli_setup_cancel_install: { confirmationId: "final-surface-absent-confirmation" },
    agent_cli_setup_confirm_install: { confirmationId: "final-surface-absent-confirmation" },
    agent_cli_setup_prepare_install: { preset: localPreset, providerId: "", methodId: null },
    agent_cli_setup_recheck: { preset: localPreset },
    approve_build_plan: { tabId: "final-surface-absent-approve-build-plan" },
    approve_goal_plan: { tabId: "final-surface-absent-goal" },
    archive_session_artifacts: { tabId: "final-surface-archive-validation", savePath: "" },
    connections_test: { id: "final-surface-absent-connection" },
    grok_trace_export: { tabId: "final-surface-absent-trace" },
    halt_build: { tabId: "final-surface-absent-halt-build", summary: "bounded fixture" },
    interject_prompt: { text: "", tabId: "final-surface-interjection-validation" },
    mcp_marketplace_install: { id: "final-surface-absent-marketplace" },
    mcp_marketplace_set_enabled: { id: "final-surface-absent-marketplace", enabled: true },
    mcp_marketplace_uninstall: { id: "context7" },
    open_url_in_browser: { url: "file:///final-surface-denied" },
    outside_connectors_simulate: {
      id: "final-surface-absent-connector",
      input: { senderId: "final-surface-sender", conversationId: null, guildId: null, text: "bounded fixture" },
    },
    outside_connectors_test: { id: "final-surface-absent-connector" },
    pause_build: { tabId: "final-surface-absent-pause-build" },
    pty_attach: { tabId: "final-surface-absent-terminal", terminalId: "final-surface-absent-terminal" },
    pty_create: { tabId: "", shell: null, cwd: null, cols: 80, rows: 24 },
    pty_kill: { tabId: "final-surface-absent-terminal", terminalId: "final-surface-absent-terminal" },
    pty_resize: { tabId: "final-surface-absent-terminal", terminalId: "final-surface-absent-terminal", cols: 80, rows: 24 },
    pty_write: { tabId: "final-surface-absent-terminal", terminalId: "final-surface-absent-terminal", data: [] },
    recheck_build_blocker: { tabId: "final-surface-absent-recheck-build-blocker" },
    reject_build_plan: { tabId: "final-surface-absent-reject-build-plan" },
    request_goal_replan: { tabId: "final-surface-absent-goal", comment: "" },
    renderer_error: {
      message: `SHELLX_RELEASE_RENDERER_ERROR_${sourceCommit.slice(0, 16)}`,
      stack: "final-surface-renderer-stack",
      componentStack: "final-surface-component-stack",
    },
    resume_build: { tabId: "final-surface-absent-resume-build" },
    send_prompt: { prompt: "", tabId: "final-surface-prompt-validation", embeddedContext: null, voiceReplyExpected: false },
    set_permission_mode: { mode: null, tabId: "final-surface-permission-mode" },
    shellx_browser_approve_developer_mode_host: {
      request: { host: null, currentUrl: null, taskId: null, fullCdpAccess: null },
    },
    shellx_browser_claim_cowork_prompt: { requestId: "final-surface-absent-cowork-prompt" },
    shellx_browser_control_task: {
      request: {
        taskId: "final-surface-absent-browser-task",
        action: "pause",
        reason: null,
        requestedBy: "operator",
      },
    },
    shellx_browser_delegate_tab_to_agent: {
      request: {
        browserTabId: "final-surface-absent-browser-tab",
        taskId: "final-surface-absent-browser-task",
        grantId: null,
        reason: "release validation",
      },
    },
    shellx_browser_finish_task: {
      taskId: "final-surface-absent-browser-task",
      status: "completed",
      reason: null,
    },
    shellx_browser_grant_transfer: {
      request: {
        transferId: "final-surface-absent-transfer",
        direction: "download",
        origin: null,
        sha256: null,
        ttlSeconds: 30,
      },
    },
    shellx_browser_open_window: { startUrl: "about:blank" },
    shellx_browser_operator_evidence_summary: { limit: 20 },
    shellx_browser_operator_export_flight_recorder: {
      request: {
        taskId: "final-surface-history-task",
        browserTabId: "final-surface-history-tab",
        reason: "Final release operator evidence IPC proof",
      },
    },
    shellx_browser_remove_site_shields: { request: { host: "" } },
    shellx_browser_resolve_dialog: {
      request: {
        dialogId: "final-surface-absent-dialog",
        taskId: null,
        action: "dismiss",
        promptValue: null,
        approvalId: null,
      },
    },
    shellx_browser_resolve_permission: {
      request: {
        permissionId: "final-surface-absent-browser-permission",
        action: "deny",
        approvalId: null,
      },
    },
    shellx_browser_resolve_session_grant: {
      grantId: "final-surface-absent-session-grant",
      approved: false,
    },
    shellx_browser_send_cowork_prompt: {
      request: {
        taskId: null,
        targetTabId: "final-surface-cowork-target",
        prompt: "bounded release validation",
        startUrl: null,
        profileId: null,
        autonomy: null,
      },
    },
    shellx_browser_take_back_tab_from_agent: {
      request: { browserTabId: "final-surface-absent-browser-tab", reason: "release validation" },
    },
    shellx_browser_update_developer_mode: {
      request: {
        enabled: true,
        fullCdpAccess: true,
        policyDisabled: false,
        approvedHosts: ["release.example.invalid"],
      },
    },
    shellx_browser_update_download_folder: {
      request: { downloadFolder: join(temp, "final-surface-browser-downloads") },
    },
    shellx_browser_update_personal_lock: {
      request: {
        enabled: null,
        timeoutMinutes: null,
        authMode: null,
        blurLockedTabs: null,
        pauseDelegatedTabsWhenLocked: null,
        lockOnSleep: null,
        lockOnMinimize: null,
        action: null,
        pin: null,
        newPin: "x",
        trustedUserActivity: null,
      },
    },
    shellx_browser_update_privacy: {
      request: {
        globalAdMode: null,
        profileId: "final-surface-absent-browser-profile",
        profileAdMode: null,
      },
    },
    shellx_browser_update_shields: {
      request: {
        enabled: false,
        adTrackerMode: "strict",
        cookieMode: "blockAll",
        fingerprintingMode: "strict",
        httpsUpgradeEnabled: false,
        scriptBlockingEnabled: true,
      },
    },
    shellx_browser_update_site_shields: {
      request: {
        host: "",
        adTrackerMode: null,
        cookieMode: null,
        fingerprintingMode: null,
        httpsUpgradeEnabled: null,
        scriptBlockingEnabled: null,
      },
    },
    shellx_vault_approve_grant: { grantId: "final-surface-absent-vault-grant" },
    shellx_vault_agent_request_approve: {
      requestId: "final-surface-absent-agent-request",
      expectedDigest: "0".repeat(64),
    },
    shellx_vault_agent_request_deny: {
      requestId: "final-surface-absent-agent-request",
      expectedDigest: "0".repeat(64),
    },
    shellx_vault_begin_setup: {
      request: {
        target: "local",
        passphrase: "",
        serverUrl: null,
        repo: null,
        token: null,
        keyfileJson: null,
        rememberDevice: null,
      },
    },
    shellx_vault_confirm_recovery_saved: {
      confirmationId: "final-surface-absent-recovery",
      importLegacy: false,
    },
    shellx_vault_create_grant: {
      request: {
        secretRef: "",
        actorScope: { kind: "allShellxAgents" },
        operation: "connectorUse",
        expiresAtMs: null,
      },
    },
    shellx_vault_revoke_grant: { grantId: "final-surface-absent-vault-grant" },
    shellx_vault_set_remembered_device_enabled: { enabled: true, passphrase: null },
    shellx_vault_unlock: { request: { passphrase: "", keyfileJson: null, rememberDevice: null } },
    start_build_mode: { tabId: "final-surface-build-validation", objective: "", cwd: temp },
    start_grok_session: {
      cwd: temp,
      wslDistro: null,
      wslGrokPath: null,
      mcpServers: null,
      connectionId: null,
      tabId: `final-surface-start-grok-${sourceCommit.slice(0, 16)}`,
      loadSessionId: null,
    },
    synthesize_voice: { text: "" },
    task_kill: { taskId: "final-surface-invalid-task" },
    task_pause: { taskId: "final-surface-invalid-task" },
    task_resume: { taskId: "final-surface-invalid-task" },
    transcribe_audio_blob: { audioBytes: [], mimeType: null },
  };
  for (const [command, expectedArgs] of Object.entries(exactNewArgs)) {
    assert.deepEqual(
      auditBody.invoked.find((entry) => entry.command === command)?.args,
      expectedArgs,
      `${command} must receive its exact bounded fixture arguments`,
    );
  }
  const fileContent = (command: string) => `SHELLX_RELEASE_FILE_${sourceCommit.slice(0, 16)}_${command}`;
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "copy_to_scope")?.args, {
    src: join(temp, "final-surface-files", "copy_to_scope", "source.txt"),
    destDir: join(temp, "final-surface-files", "copy_to_scope", "destination"),
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "copy_asset_to_scope")?.args, {
    src: join(temp, "final-surface-files", "copy_asset_to_scope", "source.txt"),
    destDir: join(temp, "final-surface-files", "copy_asset_to_scope", "destination"),
    sourceTabId: null,
    targetTabId: null,
    sourceSessionCwd: temp,
    targetSessionCwd: temp,
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "save_dropped_attachment_to_scope")?.args, {
    filename: "final-surface-attachment.txt",
    mimeType: "text/plain",
    dataBase64: Buffer.from(fileContent("save_dropped_attachment_to_scope"), "utf8").toString("base64"),
    destDir: join(temp, "final-surface-files", "save_dropped_attachment_to_scope", "destination"),
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "shellx_browser_copy_local_artifact")?.args, {
    request: {
      sourcePath: join(temp, ".shellx", "browser-artifacts", "shellx-browser-traces", "final-surface-owned-copy", "source.txt"),
      destinationDir: join(temp, ".shellx", "browser-artifacts", "shellx-browser-traces", "final-surface-owned-copy", "destination"),
      fileName: "final-surface-browser-copy.txt",
    },
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "shellx_browser_write_text_artifact")?.args, {
    request: {
      destinationDir: join(temp, "final-surface-files", "shellx_browser_write_text_artifact", "destination"),
      fileName: "final-surface-browser-write.txt",
      content: fileContent("shellx_browser_write_text_artifact"),
    },
  });
  const engineSyncArgs = auditBody.invoked.find((entry) => entry.command === "shellx_browser_sync_engine")?.args as {
    request?: Record<string, unknown>;
  } | undefined;
  assert.equal(engineSyncArgs?.request?.engineId, "final-surface-history-engine");
  assert.equal(engineSyncArgs?.request?.browserTabId, "final-surface-history-tab");
  assert.equal(engineSyncArgs?.request?.profileId, "task-disposable");
  assert.equal(engineSyncArgs?.request?.preserveExistingPage, true);
  assert.deepEqual(engineSyncArgs?.request?.bounds, { x: 21, y: 31, width: 1199, height: 799 });
  assert.match(String(engineSyncArgs?.request?.url ?? ""), /^http:\/\/127\.0\.0\.1:\d+\/settle$/);
  assert.equal(existsSync(join(temp, "final-surface-files")), false, "owned Tauri file fixtures must be removed");
  assert.equal(
    existsSync(join(temp, ".shellx", "browser-artifacts", "shellx-browser-traces", "final-surface-owned-copy")),
    false,
    "owned Browser copy fixture must be removed",
  );
  assert.equal(
    existsSync(join(temp, ".grok", "shellx-screenshots")),
    false,
    "owned screenshot fixture must be removed",
  );
  assert.equal(readFileSync(tokenPath, "utf8"), token, "token rotation must restore the exact original token");
  assert.equal(existsSync(join(temp, ".shellx", "mcp-marketplace.json")), false, "marketplace state must restore absence");
  assert.equal(existsSync(join(temp, ".grok", "config.toml")), false, "Grok marketplace config must restore absence");
  assert.equal(existsSync(join(temp, "vault-e2e")), false, "Vault agent-state fixture must restore profile-directory absence");
  assert.equal(existsSync(join(temp, "final-surface-browser-downloads")), false, "Browser download fixture must be removed");
  assert.equal(existsSync(join(temp, ".shellx", "browser-settings.json")), false, "Browser settings file must restore absence");
  const vaultCommands = [
    "vault_delete",
    "vault_get",
    "vault_set",
    "vault_set_resource",
    "vault_update_metadata",
    "vault_update_resource_metadata",
  ];
  for (const vaultCommand of vaultCommands) {
    const key = `release/surface/${sourceCommit.slice(0, 16)}/${vaultCommand}`;
    const target = auditBody.invoked.find((entry) => (
      entry.command === vaultCommand && (entry.args as { key?: unknown }).key === key
    ));
    assert(target, `${vaultCommand} target invocation must use its exact owned key`);
  }
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "git_session_create_checkpoint")?.args, {
    cwd: gitFixturePath,
    tabId: `release-git-${gitSegment}`,
    label: "Final surface checkpoint",
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "git_session_create_worktree")?.args, {
    cwd: gitFixturePath,
    tabId: `release-git-${gitSegment}`,
    sourceBranch: "release-proof",
    newBranch: "final-surface-worktree",
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "abort_session")?.args, {
    tabId: "final-surface-abort-session",
  });
  assert(auditBody.invoked.some((entry) => (
    entry.command === "drop_tab_session"
    && JSON.stringify(entry.args) === JSON.stringify({ tabId: "final-surface-abort-session" })
  )), "abort_session cleanup must drop its exact owned slot");
  const grokTabId = `final-surface-start-grok-${sourceCommit.slice(0, 16)}`;
  assert(auditBody.invoked.some((entry) => (
    entry.command === "abort_session"
      && JSON.stringify(entry.args) === JSON.stringify({ tabId: grokTabId })
  )), "start_grok_session cleanup must abort its exact owned child");
  assert(auditBody.invoked.some((entry) => (
    entry.command === "drop_tab_session"
      && JSON.stringify(entry.args) === JSON.stringify({ tabId: grokTabId })
  )), "start_grok_session cleanup must drop its exact owned slot");
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "cleanup_mcp_children_for_tab")?.args, {
    tabId: "final-surface-absent-mcp-children",
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "resolve_permission_request")?.args, {
    requestId: "final-surface-absent-permission-request",
    allow: false,
    decision: "deny",
  });
  assert.equal(auditBody.vaultPanelOpenEvents, 4, "Vault panel command and all three bounded retries must be observed");
  assert.equal(auditBody.vaultPanelCloseActions, 1, "Vault panel cleanup must use one exact Debug UI close after retries");
  assert.equal(auditBody.vaultPanelOpen, false, "Vault panel must remain closed after retry settlement");
  const mutationSessionIds = {
    append_session_log: `${historySessionId}_append_session_log`,
    delete_session_files: `${historySessionId}_delete_session_files`,
    rename_past_session: `${historySessionId}_rename_past_session`,
  };
  assert.equal(
    (auditBody.invoked.find((entry) => entry.command === "append_session_log")?.args as { sessionId?: unknown })?.sessionId,
    mutationSessionIds.append_session_log,
  );
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "delete_session_files")?.args, {
    ids: [mutationSessionIds.delete_session_files],
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "rename_past_session")?.args, {
    sessionId: mutationSessionIds.rename_past_session,
    newTitle: `Release renamed session ${sourceCommit.slice(0, 16)}`,
  });
  assert.deepEqual(auditBody.invoked.find((entry) => entry.command === "delete_user_data_section")?.args, {
    key: "releaseSurfaceDeleteFixture",
  });
  for (const goalCommand of ["mark_goal_complete", "pause_goal", "reject_goal_plan", "resume_goal", "set_goal_mode"]) {
    const tabId = `final-surface-goal-${goalCommand.replaceAll("_", "-")}`;
    const target = auditBody.invoked.find((entry, index) => (
      entry.command === goalCommand
      && (entry.args as { tabId?: unknown }).tabId === tabId
      && (goalCommand !== "set_goal_mode" || (entry.args as { on?: unknown }).on === true)
      && index >= 0
    ));
    assert(target, `${goalCommand} target invocation was not recorded`);
  }
  const emptyArgumentCommands = new Set([
    "capture_app_screenshot_to_file",
    "connections_list",
    "debug_ui_snapshot",
    "desktop_integration_status",
    "get_bound_ports",
    "get_debug_port",
    "get_debug_token",
    "get_home_dir",
    "host_skill_status",
    "list_background_tasks",
    "list_stored_sessions",
    "mcp_marketplace_list",
    "outside_connectors_capabilities",
    "outside_connectors_list",
    "read_user_data",
    "shellx_browser_state",
    "shellx_browser_open_vault_panel",
    "shellx_browser_replay_cowork_prompt_notifications",
    "shellx_vault_agent_request_center",
    "shellx_vault_list_grants",
    "shellx_vault_lock",
    "shellxagent_token_regenerate",
    "shellxagent_token_read",
    "vault_list_keys_with_meta",
    "vault_list_resources",
    "vault_status",
    "voice_credential_source",
    "workflow_skill_statuses",
  ]);
  assert(auditBody.invoked.filter((entry) => emptyArgumentCommands.has(entry.command)).every((entry) => (
    entry.args && typeof entry.args === "object" && !Array.isArray(entry.args) && Object.keys(entry.args).length === 0
  )));
  assert.deepEqual(auditBody.activeStateKeys, [], "every temporary relay invoke state must be deleted");
  assert.deepEqual(auditBody.activeGrokTabs, [], "the owned Grok child and session slot must be absent after cleanup");
  assert.doesNotMatch(
    readFileSync(driverPath, "utf8"),
    /__TAURI_INTERNALS__|executeReleaseSurfaceWebDriverScript/,
    "the installed command driver must not execute arbitrary renderer scripts",
  );
  const browserState = await fetch(`${candidateBase}/browser/state`, { headers: { Authorization: `Bearer ${token}` } });
  const browserStateBody = await browserState.json() as { tabs?: unknown[]; enginePool?: { engines?: unknown[] } };
  assert.deepEqual(browserStateBody.tabs, [], "Browser engine sync cleanup must remove the exact owned tab");
  assert.deepEqual(browserStateBody.enginePool?.engines, [], "Browser engine sync cleanup must remove the exact owned engine");
  await import("./test-release-surface-windows-desktop-integration");
  console.log("Release surface installed Tauri command relay tests passed");
} finally {
  process.off("SIGINT", onTerminationSignal);
  process.off("SIGTERM", onTerminationSignal);
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
    fixture.kill("SIGTERM");
    await waitForExit(fixture);
  }
  rmSync(tempContainer, { recursive: true, force: true });
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Tauri command fixture exited before startup: ${await streamText(child.stderr)}`);
    }
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { candidatePort?: number };
      if (Number.isInteger(value.candidatePort)) {
        return { candidatePort: Number(value.candidatePort) };
      }
    } catch {
      // The create-only state file is not ready yet.
    }
    await delay(50);
  }
  throw new Error("Tauri command fixture did not publish its ports");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    delay(2_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function streamText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function expectedInvocationSequence(command: string): string[] {
  if (command === "release_test_take_native_picker") return [command, command];
  if (command === "abort_session") return [command, "drop_tab_session"];
  if (command === "start_grok_session") return [command, "abort_session", "drop_tab_session"];
  if (command === "archive_session_artifacts") return [command, "drop_tab_session"];
  if (command === "set_permission_mode") return [command, "drop_tab_session"];
  if (command === "shellxagent_token_regenerate") return [command, "shellxagent_token_read"];
  if (command === "shellx_browser_clear_history") {
    return ["shellx_browser_state", command, "shellx_browser_state"];
  }
  if (command === "shellx_browser_open_window") return [command, "shellx_browser_state"];
  if (command === "shellx_browser_operator_evidence_summary") {
    return ["shellx_browser_operator_export_flight_recorder", command];
  }
  if (command === "shellx_browser_sync_engine") return ["shellx_browser_state", command, "shellx_browser_state"];
  if (["shellx_browser_update_developer_mode", "shellx_browser_update_download_folder", "shellx_browser_update_shields"].includes(command)) {
    return ["shellx_browser_state", command, "shellx_browser_state", command, "shellx_browser_state"];
  }
  if (command === "mcp_marketplace_uninstall") {
    return ["mcp_marketplace_list", "mcp_marketplace_install", "mcp_marketplace_list", command, "mcp_marketplace_list", "mcp_marketplace_list"];
  }
  if (command === "connections_save") return [command, "connections_list", "connections_delete", "connections_list"];
  if (command === "connections_delete") {
    return ["connections_delete", "connections_list", "connections_save", command, "connections_list", "connections_delete", "connections_list"];
  }
  if (command === "outside_connectors_save") {
    return [command, "outside_connectors_list", "outside_connectors_delete", "outside_connectors_list"];
  }
  if (command === "outside_connectors_delete") {
    return ["outside_connectors_delete", "outside_connectors_list", "outside_connectors_save", command, "outside_connectors_list", "outside_connectors_delete", "outside_connectors_list"];
  }
  if (command === "append_session_log" || command === "delete_session_files" || command === "rename_past_session") {
    return [command, "read_session_jsonl"];
  }
  if (command === "delete_user_data_section") {
    return ["read_user_data", "write_user_data", command, "read_user_data", "write_user_data", "read_user_data"];
  }
  if (command === "write_user_data") {
    return ["read_user_data", command, "read_user_data", "write_user_data", "read_user_data"];
  }
  if (["vault_delete", "vault_get", "vault_set", "vault_set_resource", "vault_update_metadata", "vault_update_resource_metadata"].includes(command)) {
    const prepared = ["vault_delete", "vault_get", "vault_update_metadata", "vault_update_resource_metadata"].includes(command);
    return [
      "vault_get",
      ...(prepared ? ["vault_set"] : []),
      command,
      "vault_get",
      ...(command === "vault_delete" ? [] : ["vault_list_keys_with_meta"]),
      "vault_delete",
      "vault_get",
      "vault_list_keys_with_meta",
    ];
  }
  if (command === "drop_tab_session" || command === "get_detected_max_tokens") {
    return ["get_detected_max_tokens", "drop_tab_session"];
  }
  if (command === "set_goal_mode") return [command, "get_goal_state", "set_goal_mode", "get_goal_state"];
  if (command === "resume_goal") {
    return ["set_goal_mode", "pause_goal", command, "get_goal_state", "set_goal_mode", "get_goal_state"];
  }
  if (["mark_goal_complete", "pause_goal", "reject_goal_plan"].includes(command)) {
    return ["set_goal_mode", command, "get_goal_state", "set_goal_mode", "get_goal_state"];
  }
  return [command];
}

function testOracleId(command: string): string {
  if (command === "get_debug_token" || command === "shellxagent_token_read") return `tauri:${command}:attested-token`;
  if (command === "abort_session") return "tauri:abort_session:owned-session-aborted";
  if (command === "start_grok_session") return "tauri:start_grok_session:owned-grok-session-active";
  if (command === "capture_app_screenshot_to_file") return "tauri:capture_app_screenshot_to_file:owned-screenshot";
  if (command === "shellxagent_token_regenerate") return "tauri:shellxagent_token_regenerate:owned-token-rotation";
  if (command === "cleanup_mcp_children_for_tab") return "tauri:cleanup_mcp_children_for_tab:absent-tab";
  if (command === "resolve_permission_request") return "tauri:resolve_permission_request:absent-request";
  if (command === "shellx_browser_replay_cowork_prompt_notifications") {
    return "tauri:shellx_browser_replay_cowork_prompt_notifications:empty-replay";
  }
  if (command === "shellx_browser_open_vault_panel") {
    return "tauri:shellx_browser_open_vault_panel:visible-vault-workspace";
  }
  if (command === "shellx_browser_open_window") {
    return "tauri:shellx_browser_open_window:native-window-opened";
  }
  if (command === "shellx_browser_operator_evidence_summary") {
    return "tauri:shellx_browser_operator_evidence_summary:owned-evidence-row";
  }
  if (command === "shellx_browser_operator_export_flight_recorder") {
    return "tauri:shellx_browser_operator_export_flight_recorder:owned-artifact";
  }
  if (command === "shellx_browser_sync_engine") {
    return "tauri:shellx_browser_sync_engine:owned-engine-preserved";
  }
  if (command === "shellx_browser_clear_history") return "tauri:shellx_browser_clear_history:owned-history-cleared";
  if (command === "renderer_error") return "tauri:renderer_error:owned-ledger-event";
  if (command === "release_test_take_native_picker") {
    return "tauri:release_test_take_native_picker:single-use";
  }
  if (["shellx_browser_update_developer_mode", "shellx_browser_update_download_folder", "shellx_browser_update_shields"].includes(command)) {
    return `tauri:${command}:owned-browser-setting`;
  }
  if ([
    "add_build_operator_note",
    "agent_cli_setup_confirm_install",
    "agent_cli_setup_prepare_install",
    "approve_build_plan",
    "approve_goal_plan",
    "archive_session_artifacts",
    "grok_trace_export",
    "interject_prompt",
    "mcp_marketplace_install",
    "mcp_marketplace_set_enabled",
    "open_url_in_browser",
    "outside_connectors_simulate",
    "pty_attach",
    "pty_create",
    "pty_resize",
    "pty_write",
    "recheck_build_blocker",
    "request_goal_replan",
    "resume_build",
    "send_prompt",
    "synthesize_voice",
    "task_kill",
    "task_pause",
    "task_resume",
    "transcribe_audio_blob",
    "shellx_browser_approve_developer_mode_host",
    "shellx_browser_claim_cowork_prompt",
    "shellx_browser_control_task",
    "shellx_browser_delegate_tab_to_agent",
    "shellx_browser_finish_task",
    "shellx_browser_grant_transfer",
    "shellx_browser_remove_site_shields",
    "shellx_browser_resolve_dialog",
    "shellx_browser_resolve_permission",
    "shellx_browser_resolve_session_grant",
    "shellx_browser_send_cowork_prompt",
    "shellx_browser_take_back_tab_from_agent",
    "shellx_browser_update_personal_lock",
    "shellx_browser_update_privacy",
    "shellx_browser_update_site_shields",
    "shellx_vault_approve_grant",
    "shellx_vault_agent_request_approve",
    "shellx_vault_agent_request_deny",
    "shellx_vault_begin_setup",
    "shellx_vault_confirm_recovery_saved",
    "shellx_vault_create_grant",
    "shellx_vault_lock",
    "shellx_vault_revoke_grant",
    "shellx_vault_set_remembered_device_enabled",
    "shellx_vault_unlock",
    "start_build_mode",
  ].includes(command)) return `tauri:${command}:fail-closed`;
  if (["agent_cli_setup_cancel_install", "halt_build", "pause_build", "pty_kill", "reject_build_plan"].includes(command)) {
    return `tauri:${command}:absent-state`;
  }
  if (command === "connections_save" || command === "connections_delete") {
    return `tauri:${command}:owned-connection`;
  }
  if (command === "connections_test") return "tauri:connections_test:absent-connection";
  if (command === "set_permission_mode") return "tauri:set_permission_mode:full-auto-slot-removed";
  if (command === "mcp_marketplace_uninstall") return "tauri:mcp_marketplace_uninstall:owned-marketplace";
  if (["vault_delete", "vault_get", "vault_set", "vault_set_resource", "vault_update_metadata", "vault_update_resource_metadata"].includes(command)) {
    return `tauri:${command}:owned-vault`;
  }
  if (["git_session_create_checkpoint", "git_session_create_worktree"].includes(command)) {
    return `tauri:${command}:owned-repository-mutation`;
  }
  if (command === "outside_connectors_save" || command === "outside_connectors_delete") {
    return `tauri:${command}:owned-outside-connector`;
  }
  if (command === "outside_connectors_test") return "tauri:outside_connectors_test:absent-connector";
  if ([
    "copy_to_scope",
    "copy_asset_to_scope",
    "save_dropped_attachment_to_scope",
    "shellx_browser_copy_local_artifact",
    "shellx_browser_write_text_artifact",
  ].includes(command)) return `tauri:${command}:owned-file`;
  if (["append_session_log", "delete_session_files", "rename_past_session"].includes(command)) {
    return `tauri:${command}:owned-history`;
  }
  if (["delete_user_data_section", "write_user_data"].includes(command)) return `tauri:${command}:owned-user-data`;
  if (["mark_goal_complete", "pause_goal", "reject_goal_plan", "resume_goal", "set_goal_mode"].includes(command)) {
    return `tauri:${command}:owned-goal-state`;
  }
  if (command === "drop_tab_session") return "tauri:drop_tab_session:slot-removed";
  if (command === "get_detected_max_tokens") return "tauri:get_detected_max_tokens:context-fallback";
  if (command === "git_branches") return "tauri:git_branches:owned-repository";
  if (command === "git_session_status") return "tauri:git_session_status:owned-repository";
  if (command === "git_session_diff") return "tauri:git_session_diff:owned-repository";
  if (command === "read_session_jsonl") return "tauri:read_session_jsonl:owned-history";
  if (command === "read_session_jsonl_tail") return "tauri:read_session_jsonl_tail:owned-history";
  if (command === "read_image_as_data_url") return "tauri:read_image_as_data_url:owned-media";
  if (command === "read_preview_file_as_data_url") return "tauri:read_preview_file_as_data_url:owned-media";
  return `tauri:${command}:read-schema`;
}

function testFixtureId(command: string): string {
  if (command === "release_test_take_native_picker") return "tauri:isolated-native-picker-lease";
  return command === "start_grok_session"
    ? "tauri:isolated-local-grok-session"
    : "tauri:installed-read-model";
}

function testCleanupId(command: string): string {
  if (command === "start_grok_session") return "tauri:abort-owned-grok-session-and-drop-slot";
  if (command === "release_test_take_native_picker") {
    return "tauri:clear-native-picker-lease-delete-fixture";
  }
  if (command === "renderer_error" || command === "shellx_browser_open_window") {
    return "tauri:discard-with-candidate-profile";
  }
  return "tauri:delete-invoke-state";
}
