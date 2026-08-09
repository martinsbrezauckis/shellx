import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import {
  releaseSurfaceProfileLaunchRootFromDebugTokenPath,
  releaseSurfaceProfileMarkerLaunchPath,
} from "../lib/release-surface-run-profile";
import {
  cleanupDebugApiGitFixture,
  prepareDebugApiGitFixture,
  verifyDebugApiGitJson,
  type DebugApiGitFixture,
} from "./debug-api-git-fixture";
import {
  cleanupDebugApiSessionFixture,
  prepareDebugApiSessionFixture,
  verifyTauriSessionJsonl,
  type DebugApiSessionFixture,
} from "./debug-api-session-fixture";
import {
  cleanupTauriCommandMediaFixture,
  prepareTauriCommandMediaFixture,
  type TauriCommandMediaFixture,
} from "./tauri-command-media-fixture";
import {
  cleanupDebugApiBrowserSettleFixture,
  prepareDebugApiBrowserSettleFixture,
  type DebugApiBrowserSettleFixture,
} from "./debug-api-browser-settle-fixture";
import {
  cleanupTauriCommandBrowserEngineSyncFixture,
  prepareTauriCommandBrowserEngineSyncFixture,
  tauriCommandBrowserEngineSyncArgs,
  verifyTauriCommandBrowserEngineSync,
  type TauriCommandBrowserEngineSyncFixture,
} from "./tauri-command-browser-engine-sync-fixture";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverOutcome,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { observeWindowsDesktopIntegration } from "./windows-desktop-integration-lifecycle";
import {
  prepareNativePickerFixture,
  removeNativePickerFixture,
  type NativePickerFixture,
} from "./native-picker-lifecycle";

const COMMANDS = [
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
  "session_tooling_snapshot",
  "set_permission_mode",
  "set_goal_mode",
  "shellx_browser_approve_developer_mode_host",
  "shellx_browser_claim_cowork_prompt",
  "shellx_browser_clear_history",
  "shellx_browser_control_task",
  "shellx_browser_state",
  "shellx_browser_sync_engine",
  "shellx_browser_copy_local_artifact",
  "shellx_browser_delegate_tab_to_agent",
  "shellx_browser_finish_task",
  "shellx_browser_grant_transfer",
  "shellx_browser_open_window",
  "shellx_browser_open_vault_panel",
  "shellx_browser_operator_evidence_summary",
  "shellx_browser_operator_export_flight_recorder",
  "shellx_browser_replay_cowork_prompt_notifications",
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
] as const;

const SHARED_COMMANDS = readFileSync(
  fileURLToPath(new URL("../../src-tauri/src/release_tauri_command_allowlist.txt", import.meta.url)),
  "utf8",
).trim().split(/\r?\n/);
const DEDICATED_RELEASE_COMMANDS = new Set(["shellx_browser_fill_user_vault_secret"]);
const SHARED_GENERIC_COMMANDS = SHARED_COMMANDS.filter((command) => !DEDICATED_RELEASE_COMMANDS.has(command));
if (SHARED_GENERIC_COMMANDS.length !== COMMANDS.length
  || SHARED_GENERIC_COMMANDS.some((command, index) => command !== COMMANDS[index])) {
  throw new Error("Tauri release driver command list drifted from the backend relay allowlist");
}

type SupportedCommand = typeof COMMANDS[number];
type Json = Record<string, unknown>;
type InvokeState = { status: "pending" | "passed" | "failed"; value?: unknown; error?: string };
type TauriCommandTransport = {
  request: ReleaseSurfaceDriverRequest;
  activeRelayInvokeIds: Set<string>;
};
const WINDOWS_DESKTOP_INTEGRATION_COMMANDS = new Set<SupportedCommand>([
  "desktop_integration_install_windows_context_menu",
  "desktop_integration_remove_windows_context_menu",
]);
type GoalFixture = {
  tabId: string;
  cwd: string;
  apiGoalPath: string;
  nodeGoalPath: string;
  objective: string;
};
type FileMutationFixture = {
  command: SupportedCommand;
  platform: ReleaseSurfaceDriverRequest["platform"];
  apiRoot: string;
  nodeRoot: string;
  parentNodeRoot: string | null;
  apiDestination: string;
  nodeDestination: string;
  apiSource: string | null;
  nodeSource: string | null;
  content: string;
  outputNodePath: string | null;
};
type VaultMutationFixture = {
  command: SupportedCommand;
  key: string;
  value: string;
};
type ScreenshotFixture = {
  platform: ReleaseSurfaceDriverRequest["platform"];
  nodeRoot: string;
  parentNodeRoot: string;
  parentExisted: boolean;
  outputNodePath: string | null;
};
type TokenRotationFixture = {
  nodePath: string;
  original: Buffer;
  mode: number;
  generated: string | null;
};
type GitMutationFixture = {
  checkpointRoot: string;
  checkpointRootExisted: boolean;
  checkpointPath: string | null;
  worktreePath: string | null;
};
type MarketplaceMutationFixture = {
  id: string;
  files: Array<{ path: string; existed: boolean; content: Buffer | null; mode: number | null }>;
  removableParents: string[];
};
type VaultAgentStateFixture = {
  directory: string;
  directoryExisted: boolean;
  files: Array<{ path: string; existed: boolean; content: Buffer | null; mode: number | null }>;
};
type BrowserSettingMutationFixture = {
  command: "shellx_browser_update_developer_mode" | "shellx_browser_update_download_folder" | "shellx_browser_update_shields";
  baseline: unknown;
  settingsFile: { path: string; existed: boolean; content: Buffer | null; mode: number | null };
  downloadApiPath: string | null;
  downloadNodePath: string | null;
};

const OWNED_CONNECTION_ID = "final-surface-owned-connection";
const OWNED_OUTSIDE_CONNECTOR_ID = "final-surface-owned-outside-connector";
const VAULT_PANEL_SELECTOR = "[data-debug-id='vault-workspace-modal']";
const VAULT_PANEL_HIGHLIGHT_ID = "final-surface-tauri-vault-panel";
const VAULT_PANEL_RETRY_SETTLE_MS = 2_800;

const SESSION_HISTORY_COMMANDS = new Set<SupportedCommand>([
  "append_session_log",
  "delete_session_files",
  "read_session_jsonl",
  "read_session_jsonl_tail",
  "rename_past_session",
]);
const USER_DATA_MUTATION_COMMANDS = new Set<SupportedCommand>([
  "delete_user_data_section",
  "write_user_data",
]);
const GOAL_COMMANDS = new Set<SupportedCommand>([
  "mark_goal_complete",
  "pause_goal",
  "reject_goal_plan",
  "resume_goal",
  "set_goal_mode",
]);
const CONNECTION_MUTATION_COMMANDS = new Set<SupportedCommand>([
  "connections_delete",
  "connections_save",
]);
const OUTSIDE_CONNECTOR_MUTATION_COMMANDS = new Set<SupportedCommand>([
  "outside_connectors_delete",
  "outside_connectors_save",
]);
const FILE_MUTATION_COMMANDS = new Set<SupportedCommand>([
  "copy_asset_to_scope",
  "copy_to_scope",
  "save_dropped_attachment_to_scope",
  "shellx_browser_copy_local_artifact",
  "shellx_browser_write_text_artifact",
]);
const VAULT_MUTATION_COMMANDS = new Set<SupportedCommand>([
  "vault_delete",
  "vault_get",
  "vault_set",
  "vault_set_resource",
  "vault_update_metadata",
  "vault_update_resource_metadata",
]);
const GIT_MUTATION_COMMANDS = new Set<SupportedCommand>([
  "git_session_create_checkpoint",
  "git_session_create_worktree",
]);
const BROWSER_SETTING_MUTATION_COMMANDS = new Set<SupportedCommand>([
  "shellx_browser_update_developer_mode",
  "shellx_browser_update_download_folder",
  "shellx_browser_update_shields",
]);
const EXPECTED_REJECTIONS = new Map<SupportedCommand, string>([
  ["add_build_operator_note", "operator note is empty"],
  ["agent_cli_setup_confirm_install", "agent_cli_setup.confirm: unknown or expired confirmation id 'final-surface-absent-confirmation'"],
  ["agent_cli_setup_prepare_install", "agent_cli_setup.prepare: providerId is required"],
  ["approve_build_plan", "No live session for this tab; reconnect before approving the build plan."],
  ["approve_goal_plan", "No live session for this tab; reconnect before approving the plan."],
  ["archive_session_artifacts", "archive_session_artifacts: save_path is empty"],
  ["shellx_browser_approve_developer_mode_host", "Developer Mode approval requires a host or current page URL"],
  ["shellx_browser_claim_cowork_prompt", "Browser cowork prompt claim is unknown, expired, or already consumed"],
  ["shellx_browser_control_task", "unknown browser task 'final-surface-absent-browser-task'"],
  ["shellx_browser_delegate_tab_to_agent", "unknown browser tab 'final-surface-absent-browser-tab'"],
  ["shellx_browser_finish_task", "unknown browser task 'final-surface-absent-browser-task'"],
  ["shellx_browser_grant_transfer", "unknown browser download transfer 'final-surface-absent-transfer'"],
  ["shellx_browser_remove_site_shields", "site shield override removal requires a host"],
  ["shellx_browser_resolve_dialog", "unknown browser dialog 'final-surface-absent-dialog'"],
  ["shellx_browser_resolve_permission", "unknown browser permission 'final-surface-absent-browser-permission'"],
  ["shellx_browser_resolve_session_grant", "unknown browser session grant 'final-surface-absent-session-grant'"],
  ["shellx_browser_send_cowork_prompt", "Browser cowork prompt sends is restricted to the 'shellx-browser' window"],
  ["shellx_browser_take_back_tab_from_agent", "unknown browser tab 'final-surface-absent-browser-tab'"],
  ["shellx_browser_update_personal_lock", "Personal Browser Lock PIN must be at least 4 characters"],
  ["shellx_browser_update_privacy", "unknown browser profile 'final-surface-absent-browser-profile'"],
  ["shellx_browser_update_site_shields", "site shield override requires a host"],
  ["shellx_vault_approve_grant", "grantNotFound"],
  ["shellx_vault_agent_request_approve", "agent request not found"],
  ["shellx_vault_agent_request_deny", "agent request not found"],
  ["shellx_vault_begin_setup", "vault passphrase must not be empty"],
  ["shellx_vault_confirm_recovery_saved", "no pending vault setup"],
  ["shellx_vault_create_grant", "grant secretRef cannot be empty"],
  ["shellx_vault_lock", "vault is not configured"],
  ["shellx_vault_revoke_grant", "grantNotFound"],
  ["shellx_vault_set_remembered_device_enabled", "master passphrase is required to remember this device"],
  ["shellx_vault_unlock", "vault passphrase must not be empty"],
  ["start_build_mode", "/build requires an objective"],
  ["grok_trace_export", "no registered tab session"],
  ["interject_prompt", "Empty interjection"],
  ["mcp_marketplace_install", "unknown marketplace id: final-surface-absent-marketplace"],
  ["mcp_marketplace_set_enabled", "unknown marketplace id: final-surface-absent-marketplace"],
  ["open_url_in_browser", "only http(s) URLs are openable, got: file:///final-surface-denied"],
  ["outside_connectors_simulate", "unknown connector id"],
  ["pty_attach", "unknown terminal: TerminalKey { tab_id: \"final-surface-absent-terminal\", terminal_id: \"final-surface-absent-terminal\" }"],
  ["pty_create", "tab_id is required"],
  ["pty_resize", "unknown terminal: TerminalKey { tab_id: \"final-surface-absent-terminal\", terminal_id: \"final-surface-absent-terminal\" }"],
  ["pty_write", "unknown terminal: TerminalKey { tab_id: \"final-surface-absent-terminal\", terminal_id: \"final-surface-absent-terminal\" }"],
  ["recheck_build_blocker", "no build run for this tab"],
  ["request_goal_replan", "Plan feedback is empty."],
  ["resume_build", "Connect this tab before resuming Build Mode."],
  ["send_prompt", "Empty prompt"],
  ["synthesize_voice", "empty text"],
  ["task_kill", "bad task_id: final-surface-invalid-task"],
  ["task_pause", "bad task_id: final-surface-invalid-task"],
  ["task_resume", "bad task_id: final-surface-invalid-task"],
  ["transcribe_audio_blob", "No audio captured (recording was too short)."],
]);

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "tauri-command-installed",
  kind: "tauri-command",
  runtimeBinding: "attested-process",
  invocationTransport: "debug-api-direct",
  controllerFiles: [
    "scripts/release-drivers/windows-desktop-integration-lifecycle.ts",
    "scripts/probe-release-surface-windows-desktop-integration.ps1",
  ],
  supportedFixtures: ["tauri:installed-read-model", "tauri:installed-vault-panel-closed", "tauri:attested-debug-token", "tauri:isolated-profile-marker", "tauri:isolated-session-slot", "tauri:isolated-local-grok-session", "tauri:isolated-absent-session", "tauri:isolated-absent-permission", "tauri:isolated-absent-mcp-children", "tauri:isolated-fail-closed-validation", "tauri:isolated-absent-state", "tauri:isolated-connection-mutation", "tauri:isolated-outside-connector-mutation", "tauri:isolated-file-mutation", "tauri:isolated-git-repository", "tauri:isolated-git-mutation", "tauri:isolated-user-data-store", "tauri:isolated-user-data-mutation", "tauri:isolated-vault-read-model", "tauri:isolated-vault-mutation", "tauri:isolated-vault-agent-state", "tauri:isolated-marketplace-mutation", "tauri:isolated-session-history", "tauri:isolated-session-history-mutation", "tauri:isolated-goal-state", "tauri:isolated-media-file", "tauri:isolated-screenshot-file", "tauri:isolated-token-rotation", "tauri:isolated-browser-setting-mutation", "tauri:isolated-browser-history", "tauri:isolated-browser-evidence", "tauri:isolated-browser-engine-sync", "tauri:isolated-native-picker-lease", "tauri:isolated-monotonic-event", "tauri:windows-desktop-integration-empty-baseline"],
  supportedCleanups: ["tauri:delete-invoke-state", "tauri:close-vault-panel-after-retries", "tauri:preserve-owned-profile-marker", "tauri:drop-owned-session-slot", "tauri:abort-owned-grok-session-and-drop-slot", "tauri:delete-owned-connection", "tauri:delete-owned-outside-connector", "tauri:delete-owned-file-fixture", "tauri:delete-owned-git-fixture", "tauri:delete-owned-git-mutation", "tauri:read-only-user-data", "tauri:restore-empty-user-data", "tauri:delete-owned-session-history", "tauri:clear-owned-goal-state", "tauri:delete-owned-media-file", "tauri:delete-owned-screenshot", "tauri:delete-owned-vault-secret", "tauri:restore-vault-agent-state", "tauri:restore-attested-token", "tauri:restore-marketplace-files", "tauri:restore-browser-setting-state", "tauri:close-owned-browser-history-fixture", "tauri:close-owned-browser-evidence-fixture", "tauri:close-owned-browser-engine-sync", "tauri:clear-native-picker-lease-delete-fixture", "tauri:remove-owned-windows-desktop-integration", "tauri:discard-with-candidate-profile"],
  supportedOracles: COMMANDS.map(commandOracleId),
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  await resolveReleaseSurfaceRuntimeCandidate(request);
  const transport: TauriCommandTransport = {
    request,
    activeRelayInvokeIds: new Set<string>(),
  };
  const outcomes: ReleaseSurfaceDriverOutcome[] = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseCommand(request, transport, assignment));
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

async function exerciseCommand(
  request: ReleaseSurfaceDriverRequest,
  webdriver: TauriCommandTransport,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No installed Tauri IPC result was observed.",
  };
  const command = assignment.surface.name as SupportedCommand;
  let gitFixture: DebugApiGitFixture | null = null;
  let sessionFixture: DebugApiSessionFixture | null = null;
  let mediaFixture: TauriCommandMediaFixture | null = null;
  let goalFixture: GoalFixture | null = null;
  let fileFixture: FileMutationFixture | null = null;
  let vaultFixture: VaultMutationFixture | null = null;
  let screenshotFixture: ScreenshotFixture | null = null;
  let tokenRotationFixture: TokenRotationFixture | null = null;
  let gitMutationFixture: GitMutationFixture | null = null;
  let marketplaceFixture: MarketplaceMutationFixture | null = null;
  let vaultAgentStateFixture: VaultAgentStateFixture | null = null;
  let browserSettingMutationFixture: BrowserSettingMutationFixture | null = null;
  let browserHistoryFixture: DebugApiBrowserSettleFixture | null = null;
  let browserEvidenceFixture: DebugApiBrowserSettleFixture | null = null;
  const browserEvidenceArtifactPaths = new Set<string>();
  let browserEngineSyncFixture: TauriCommandBrowserEngineSyncFixture | null = null;
  let nativePickerFixture: NativePickerFixture | null = null;
  let vaultPanelInvokedAtMs: number | null = null;
  let ownsWindowsDesktopIntegration = false;
  try {
    if (!isSupportedCommand(command)) throw new Error(`installed IPC fixture does not support ${assignment.surface.name}`);
    if (WINDOWS_DESKTOP_INTEGRATION_COMMANDS.has(command)) {
      observeWindowsDesktopIntegration(request, "preflight-absent");
      ownsWindowsDesktopIntegration = true;
      if (command === "desktop_integration_remove_windows_context_menu") {
        const prepared = await invokeTemporaryTauriCommand(
          webdriver,
          "desktop_integration_install_windows_context_menu",
          {},
        );
        verifyDesktopIntegrationStatus(prepared, true, command);
        observeWindowsDesktopIntegration(request, "installed");
      }
    }
    if (new Set(["git_branches", "git_session_diff", "git_session_status"]).has(command)
      || GIT_MUTATION_COMMANDS.has(command)) {
      gitFixture = prepareDebugApiGitFixture(request);
    }
    if (SESSION_HISTORY_COMMANDS.has(command)) {
      const mutationSuffix = new Set<SupportedCommand>([
        "append_session_log",
        "delete_session_files",
        "rename_past_session",
      ]).has(command) ? command : undefined;
      sessionFixture = prepareDebugApiSessionFixture(request, mutationSuffix);
    }
    if (command === "read_image_as_data_url" || command === "read_preview_file_as_data_url") {
      mediaFixture = prepareTauriCommandMediaFixture(request);
    }
    if (GOAL_COMMANDS.has(command)) {
      goalFixture = prepareGoalFixture(command, request);
    }
    if (FILE_MUTATION_COMMANDS.has(command)) {
      fileFixture = prepareFileMutationFixture(command, request);
    }
    if (VAULT_MUTATION_COMMANDS.has(command)) {
      vaultFixture = prepareVaultMutationFixture(command, request);
      await prepareVaultMutation(webdriver, vaultFixture);
    }
    if (command === "capture_app_screenshot_to_file") {
      screenshotFixture = prepareScreenshotFixture(request);
    }
    if (command === "shellxagent_token_regenerate") {
      tokenRotationFixture = prepareTokenRotationFixture(request);
    }
    if (GIT_MUTATION_COMMANDS.has(command)) {
      if (!gitFixture) throw new Error("owned Git mutation repository is unavailable");
      gitMutationFixture = prepareGitMutationFixture(request);
    }
    if (command === "mcp_marketplace_uninstall") {
      marketplaceFixture = prepareMarketplaceMutationFixture(request);
      await prepareMarketplaceUninstall(webdriver, marketplaceFixture);
    }
    if (command === "shellx_vault_agent_request_approve" || command === "shellx_vault_agent_request_deny") {
      vaultAgentStateFixture = prepareVaultAgentStateFixture(request);
    }
    if (command === "shellx_browser_open_vault_panel") {
      await waitForVaultPanelVisibility(webdriver, false);
    }
    if (BROWSER_SETTING_MUTATION_COMMANDS.has(command)) {
      browserSettingMutationFixture = await prepareBrowserSettingMutationFixture(command, request, webdriver);
    }
    if (command === "shellx_browser_clear_history") {
      const state = requireRecord(
        await invokeTemporaryTauriCommand(webdriver, "shellx_browser_state", {}),
        "Browser history baseline",
      );
      if (requireArray(state.history, "Browser history baseline").length !== 0) {
        throw new Error("isolated candidate Browser history was not empty before the owned fixture");
      }
      browserHistoryFixture = await prepareDebugApiBrowserSettleFixture(debugApiConnectionForRequest(request));
    }
    if (command === "shellx_browser_operator_evidence_summary"
      || command === "shellx_browser_operator_export_flight_recorder") {
      browserEvidenceFixture = await prepareDebugApiBrowserSettleFixture(
        debugApiConnectionForRequest(request),
      );
      if (command === "shellx_browser_operator_evidence_summary") {
        const prepared = await invokeTemporaryTauriCommand(
          webdriver,
          "shellx_browser_operator_export_flight_recorder",
          browserEvidenceExportArgs(browserEvidenceFixture),
        );
        browserEvidenceArtifactPaths.add(
          verifyOperatorFlightRecorderArtifact(prepared, request, browserEvidenceFixture).nodePath,
        );
      }
    }
    if (command === "shellx_browser_sync_engine") {
      browserEngineSyncFixture = await prepareTauriCommandBrowserEngineSyncFixture(
        debugApiConnectionForRequest(request),
        (name, args) => invokeTemporaryTauriCommand(webdriver, name, args),
      );
    }
    if (command === "release_test_take_native_picker") {
      nativePickerFixture = prepareNativePickerFixture(request, assignment.surface.id);
      await armNativePickerLease(request, nativePickerFixture.file);
    }
    if (command === "start_grok_session"
      && await sessionHasActiveChild(request, grokSessionTabId(request))) {
      throw new Error("start_grok_session lifecycle refuses to replace an already-active provider child");
    }
    outcome.present = "pass";
    if (command === "drop_tab_session") {
      const prepared = await invokeTemporaryTauriCommand(
        webdriver,
        "get_detected_max_tokens",
        { tabId: "final-surface-context-fixture" },
      );
      if (prepared !== 128_000) throw new Error("drop_tab_session setup did not create the exact fallback context slot");
    }
    if (USER_DATA_MUTATION_COMMANDS.has(command)) {
      await prepareUserDataMutation(webdriver, command);
    }
    if (goalFixture && command !== "set_goal_mode") {
      await prepareGoalState(webdriver, command, goalFixture);
    }
    if (command === "connections_delete") await prepareConnectionDelete(webdriver);
    if (command === "outside_connectors_delete") await prepareOutsideConnectorDelete(webdriver);
    if (command === "shellx_browser_open_vault_panel") vaultPanelInvokedAtMs = Date.now();
    const completed = await invokeTauriCommand(
      webdriver,
      command,
      invocationArgs(
        command,
        request,
        gitFixture,
        sessionFixture,
        mediaFixture,
        goalFixture,
        fileFixture,
        vaultFixture,
        marketplaceFixture,
        browserSettingMutationFixture,
        browserEvidenceFixture,
        browserEngineSyncFixture,
      ),
      EXPECTED_REJECTIONS.has(command),
    );
    outcome.invoke = "pass";
    if (command === "release_test_take_native_picker") {
      const second = await invokeTemporaryTauriCommand(webdriver, command, { kind: "file" });
      if (second !== null) throw new Error("native-picker claim was not single-use");
    }
    if (command === "shellx_browser_operator_export_flight_recorder") {
      if (!browserEvidenceFixture) throw new Error("owned Browser evidence fixture is unavailable");
      browserEvidenceArtifactPaths.add(
        verifyOperatorFlightRecorderArtifact(completed.value, request, browserEvidenceFixture).nodePath,
      );
    }
    outcome.observedEffect = command === "release_test_take_native_picker"
      ? verifyNativePickerClaim(completed.value, nativePickerFixture)
      : EXPECTED_REJECTIONS.has(command)
      ? verifyExpectedRejection(command, completed)
      : await verifyCommandResult(
        command,
        completed.value,
        request,
        webdriver,
        gitFixture,
        sessionFixture,
        mediaFixture,
        goalFixture,
        fileFixture,
        vaultFixture,
        screenshotFixture,
        tokenRotationFixture,
        gitMutationFixture,
        marketplaceFixture,
        browserSettingMutationFixture,
        browserHistoryFixture,
        browserEvidenceFixture,
        browserEngineSyncFixture,
      );
    if (command === "desktop_integration_install_windows_context_menu") {
      observeWindowsDesktopIntegration(request, "installed");
    } else if (command === "desktop_integration_remove_windows_context_menu") {
      observeWindowsDesktopIntegration(request, "absent");
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    try {
      if (command === "get_detected_max_tokens") {
        const removed = await invokeTemporaryTauriCommand(
          webdriver,
          "drop_tab_session",
          { tabId: "final-surface-context-fixture" },
        );
        if (removed !== true) throw new Error("owned context-limit session slot was not removed");
      } else if (command === "drop_tab_session" && outcome.effect !== "pass") {
        const removed = await invokeTemporaryTauriCommand(
          webdriver,
          "drop_tab_session",
          { tabId: "final-surface-context-fixture" },
        );
        if (typeof removed !== "boolean") throw new Error("failed session-drop cleanup returned a non-boolean result");
      } else if (command === "abort_session") {
        const removed = await invokeTemporaryTauriCommand(
          webdriver,
          "drop_tab_session",
          { tabId: "final-surface-abort-session" },
        );
        if (removed !== true) throw new Error("aborted disposable session slot was not removed");
      } else if (command === "start_grok_session") {
        const tabId = grokSessionTabId(request);
        const aborted = await invokeTemporaryTauriCommand(
          webdriver,
          "abort_session",
          { tabId },
        );
        if (aborted !== "Session aborted") throw new Error("owned Grok session was not aborted during cleanup");
        const removed = await invokeTemporaryTauriCommand(
          webdriver,
          "drop_tab_session",
          { tabId },
        );
        if (removed !== true) throw new Error("owned Grok session slot was not removed during cleanup");
        await waitForSessionChild(request, tabId, false, "start_grok_session cleanup");
      } else if (command === "archive_session_artifacts") {
        const removed = await invokeTemporaryTauriCommand(
          webdriver,
          "drop_tab_session",
          { tabId: "final-surface-archive-validation" },
        );
        if (removed !== true) throw new Error("archive validation session slot was not removed");
      } else if (command === "set_permission_mode") {
        const removed = await invokeTemporaryTauriCommand(
          webdriver,
          "drop_tab_session",
          { tabId: "final-surface-permission-mode" },
        );
        if (removed !== true) throw new Error("permission-mode disposable session slot was not removed");
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      await cleanupActiveRelayInvokes(webdriver);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (tokenRotationFixture) {
      const cleanupError = cleanupTokenRotationFixture(tokenRotationFixture);
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (command === "shellx_browser_open_vault_panel" && vaultPanelInvokedAtMs !== null) {
      try {
        await cleanupVaultPanel(webdriver, vaultPanelInvokedAtMs);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (screenshotFixture) {
      const cleanupError = cleanupScreenshotFixture(screenshotFixture);
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (vaultFixture) {
      try {
        await cleanupVaultMutation(webdriver, vaultFixture);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (marketplaceFixture) {
      try {
        await cleanupMarketplaceMutation(webdriver, marketplaceFixture);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (vaultAgentStateFixture) {
      const cleanupError = cleanupVaultAgentStateFixture(vaultAgentStateFixture);
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (browserSettingMutationFixture) {
      try {
        await cleanupBrowserSettingMutationFixture(webdriver, browserSettingMutationFixture);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserHistoryFixture) {
      const cleanupError = await cleanupDebugApiBrowserSettleFixture(
        debugApiConnectionForRequest(request),
        browserHistoryFixture,
      );
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    for (const artifactPath of browserEvidenceArtifactPaths) {
      try {
        if (!existsSync(artifactPath)) throw new Error("owned Browser evidence artifact disappeared before cleanup");
        rmSync(artifactPath);
        if (existsSync(artifactPath)) throw new Error("owned Browser evidence artifact remained after cleanup");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (browserEvidenceFixture) {
      const cleanupError = await cleanupDebugApiBrowserSettleFixture(
        debugApiConnectionForRequest(request),
        browserEvidenceFixture,
      );
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (browserEngineSyncFixture) {
      const cleanupError = await cleanupTauriCommandBrowserEngineSyncFixture(
        debugApiConnectionForRequest(request),
        browserEngineSyncFixture,
      );
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (nativePickerFixture) {
      try {
        await clearNativePickerLease(request);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
      try {
        removeNativePickerFixture(request, nativePickerFixture);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (ownsWindowsDesktopIntegration) {
      try {
        const removed = await invokeTemporaryTauriCommand(
          webdriver,
          "desktop_integration_remove_windows_context_menu",
          {},
        );
        verifyDesktopIntegrationStatus(removed, false, command);
        observeWindowsDesktopIntegration(request, "absent");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (gitMutationFixture) {
      const cleanupError = cleanupGitMutationFixture(gitMutationFixture);
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (gitFixture) {
      const cleanupError = cleanupDebugApiGitFixture(gitFixture);
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (sessionFixture) {
      const cleanupError = cleanupDebugApiSessionFixture(sessionFixture);
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (mediaFixture) {
      const cleanupError = cleanupTauriCommandMediaFixture(mediaFixture);
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (USER_DATA_MUTATION_COMMANDS.has(command)) {
      try {
        await cleanupUserDataMutation(webdriver);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (goalFixture) {
      try {
        await cleanupGoalState(webdriver, goalFixture);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (CONNECTION_MUTATION_COMMANDS.has(command)) {
      try {
        await cleanupConnectionMutation(webdriver);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (OUTSIDE_CONNECTOR_MUTATION_COMMANDS.has(command)) {
      try {
        await cleanupOutsideConnectorMutation(webdriver);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (fileFixture) {
      const cleanupError = cleanupFileMutationFixture(fileFixture);
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length === 0) {
      outcome.cleanup = "pass";
    } else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Tauri command did not satisfy every required verdict";
  }
  return outcome;
}

async function invokeTauriCommand(
  webdriver: TauriCommandTransport,
  command: string,
  args: Json,
  allowFailure = false,
): Promise<InvokeState> {
  const started = requireRecord(
    await debugApiJson(webdriver.request, "POST", "/release-test/tauri-invokes", { command, args }),
    "release Tauri relay start",
  );
  const invokeId = String(started.id ?? "");
  if (!/^rti-[0-9a-f]{32}$/.test(invokeId) || started.status !== "pending") {
    throw new Error("release Tauri relay returned an invalid start receipt");
  }
  webdriver.activeRelayInvokeIds.add(invokeId);
  return waitForInvoke(webdriver, invokeId, command, allowFailure);
}

async function cleanupVaultPanel(
  webdriver: TauriCommandTransport,
  invokedAtMs: number,
): Promise<void> {
  const remainingRetryWindow = VAULT_PANEL_RETRY_SETTLE_MS - (Date.now() - invokedAtMs);
  if (remainingRetryWindow > 0) await delay(remainingRetryWindow);
  await postVaultPanelUi(webdriver, { openModal: "close", debugHighlights: [] });
  await waitForVaultPanelVisibility(webdriver, false);
  await delay(300);
  await waitForVaultPanelVisibility(webdriver, false);
}

async function waitForVaultPanelVisibility(
  webdriver: TauriCommandTransport,
  visible: boolean,
): Promise<void> {
  await postVaultPanelUi(webdriver, {
    debugHighlights: [{
      id: VAULT_PANEL_HIGHLIGHT_ID,
      selector: VAULT_PANEL_SELECTOR,
      label: "Vault workspace",
      color: "cyan",
    }],
  });
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const state = requireRecord(
        await debugApiJson(webdriver.request, "GET", "/state/ui"),
        "Vault workspace UI state",
      );
      const bySurface = requireRecord(
        state.debugHighlightResultsBySurface,
        "Vault workspace highlight surfaces",
      );
      const results = requireArray(bySurface.app ?? [], "Vault workspace app highlights")
        .map((entry) => requireRecord(entry, "Vault workspace highlight"));
      const result = results.find((entry) => entry.id === VAULT_PANEL_HIGHLIGHT_ID);
      if (visible && result?.status === "resolved") {
        const rect = requireRecord(result.visibleRect ?? result.rect, "Vault workspace visible rectangle");
        if (Number(rect.width) > 0 && Number(rect.height) > 0) return;
        throw new Error("Vault workspace resolved without a non-empty visible rectangle");
      }
      if (!visible && result?.status === "missing") return;
      if (result?.status && !new Set(["pending", "resolved", "missing"]).has(String(result.status))) {
        throw new Error(`Vault workspace highlight reported ${String(result.status)}`);
      }
      await delay(100);
    }
    throw new Error(visible
      ? "Vault workspace did not become visibly resolved"
      : "Vault workspace remained visible after cleanup");
  } finally {
    await postVaultPanelUi(webdriver, { debugHighlights: [] });
  }
}

async function postVaultPanelUi(
  webdriver: TauriCommandTransport,
  patch: Json,
): Promise<void> {
  await debugApiJson(webdriver.request, "POST", "/state/ui", {
    debugSurface: "app",
    source: "final-surface-tauri-command",
    ...patch,
  });
}

async function invokeTemporaryTauriCommand(
  webdriver: TauriCommandTransport,
  command: string,
  args: Json,
): Promise<unknown> {
  const existingIds = new Set(webdriver.activeRelayInvokeIds);
  try {
    return (await invokeTauriCommand(webdriver, command, args)).value;
  } finally {
    const temporaryIds = [...webdriver.activeRelayInvokeIds]
      .filter((invokeId) => !existingIds.has(invokeId));
    for (const invokeId of temporaryIds) {
      await cleanupRelayInvoke(webdriver, invokeId);
    }
  }
}

async function waitForInvoke(
  webdriver: TauriCommandTransport,
  invokeId: string,
  command: string,
  allowFailure = false,
): Promise<InvokeState> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = parseInvokeState(await debugApiJson(
      webdriver.request,
      "GET",
      `/release-test/tauri-invokes/${encodeURIComponent(invokeId)}`,
    ));
    if (state.status === "passed") return state;
    if (state.status === "failed") {
      if (allowFailure) return state;
      throw new Error(state.error || `${command} failed without an error`);
    }
    await delay(100);
  }
  throw new Error(`${command} did not complete before the 20 second deadline`);
}

async function cleanupRelayInvoke(webdriver: TauriCommandTransport, invokeId: string): Promise<void> {
  const result = requireRecord(
    await debugApiJson(
      webdriver.request,
      "DELETE",
      `/release-test/tauri-invokes/${encodeURIComponent(invokeId)}`,
    ),
    "release Tauri relay cleanup",
  );
  if (result.removed !== true) throw new Error("temporary release Tauri relay state remained after cleanup");
  webdriver.activeRelayInvokeIds.delete(invokeId);
}

async function cleanupActiveRelayInvokes(webdriver: TauriCommandTransport): Promise<void> {
  const errors: string[] = [];
  for (const invokeId of [...webdriver.activeRelayInvokeIds]) {
    try {
      await cleanupRelayInvoke(webdriver, invokeId);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
}

function parseInvokeState(value: unknown): InvokeState {
  const state = requireRecord(value, "renderer invoke state");
  if (!new Set(["pending", "passed", "failed"]).has(String(state.status))) {
    throw new Error("renderer invoke state used an unsupported status");
  }
  if (state.error !== undefined && typeof state.error !== "string") {
    throw new Error("renderer invoke state returned a non-string error");
  }
  return state as InvokeState;
}

function invocationArgs(
  command: SupportedCommand,
  request: ReleaseSurfaceDriverRequest,
  gitFixture: DebugApiGitFixture | null,
  sessionFixture: DebugApiSessionFixture | null,
  mediaFixture: TauriCommandMediaFixture | null,
  goalFixture: GoalFixture | null,
  fileFixture: FileMutationFixture | null,
  vaultFixture: VaultMutationFixture | null,
  marketplaceFixture: MarketplaceMutationFixture | null,
  browserSettingFixture: BrowserSettingMutationFixture | null,
  browserEvidenceFixture: DebugApiBrowserSettleFixture | null,
  browserEngineSyncFixture: TauriCommandBrowserEngineSyncFixture | null,
): Json {
  if (command === "abort_session") return { tabId: "final-surface-abort-session" };
  if (command === "send_prompt") {
    return { prompt: "", tabId: "final-surface-prompt-validation", embeddedContext: null, voiceReplyExpected: false };
  }
  if (command === "interject_prompt") return { text: "", tabId: "final-surface-interjection-validation" };
  if (command === "open_url_in_browser") return { url: "file:///final-surface-denied" };
  if (command === "archive_session_artifacts") {
    return { tabId: "final-surface-archive-validation", savePath: "" };
  }
  if (command === "grok_trace_export") return { tabId: "final-surface-absent-trace" };
  if (command === "agent_cli_setup_prepare_install") {
    return { preset: localConnectionPreset(""), providerId: "", methodId: null };
  }
  if (command === "agent_cli_setup_confirm_install" || command === "agent_cli_setup_cancel_install") {
    return { confirmationId: "final-surface-absent-confirmation" };
  }
  if (command === "agent_cli_setup_recheck") return { preset: localConnectionPreset("") };
  if (command === "connections_save") return { preset: localConnectionPreset(OWNED_CONNECTION_ID) };
  if (command === "connections_delete" || command === "connections_test") {
    return { id: command === "connections_delete" ? OWNED_CONNECTION_ID : "final-surface-absent-connection" };
  }
  if (command === "outside_connectors_save") return { connector: outsideConnectorFixture() };
  if (command === "outside_connectors_delete" || command === "outside_connectors_test") {
    return { id: command === "outside_connectors_delete" ? OWNED_OUTSIDE_CONNECTOR_ID : "final-surface-absent-connector" };
  }
  if (command === "outside_connectors_simulate") {
    return {
      id: "final-surface-absent-connector",
      input: { senderId: "final-surface-sender", conversationId: null, guildId: null, text: "bounded fixture" },
    };
  }
  if (command === "mcp_marketplace_install" || command === "mcp_marketplace_set_enabled") {
    return {
      id: "final-surface-absent-marketplace",
      ...(command === "mcp_marketplace_set_enabled" ? { enabled: true } : {}),
    };
  }
  if (command === "mcp_marketplace_uninstall") {
    if (!marketplaceFixture) throw new Error("owned marketplace fixture is unavailable");
    return { id: marketplaceFixture.id };
  }
  if (command === "pty_create") return { tabId: "", shell: null, cwd: null, cols: 80, rows: 24 };
  if (command === "pty_write" || command === "pty_attach" || command === "pty_resize" || command === "pty_kill") {
    return {
      tabId: "final-surface-absent-terminal",
      terminalId: "final-surface-absent-terminal",
      ...(command === "pty_write" ? { data: [] } : {}),
      ...(command === "pty_resize" ? { cols: 80, rows: 24 } : {}),
    };
  }
  if (command === "task_pause" || command === "task_resume" || command === "task_kill") {
    return { taskId: "final-surface-invalid-task" };
  }
  if (command === "transcribe_audio_blob") return { audioBytes: [], mimeType: null };
  if (command === "synthesize_voice") return { text: "" };
  if (command === "approve_goal_plan") return { tabId: "final-surface-absent-goal" };
  if (command === "request_goal_replan") return { tabId: "final-surface-absent-goal", comment: "" };
  if (command === "renderer_error") {
    return {
      message: rendererErrorMarker(request),
      stack: "final-surface-renderer-stack",
      componentStack: "final-surface-component-stack",
    };
  }
  if (command === "release_test_take_native_picker") return { kind: "file" };
  if (command === "add_build_operator_note") return { tabId: "final-surface-absent-build", text: "" };
  if (command === "approve_build_plan" || command === "recheck_build_blocker"
    || command === "reject_build_plan" || command === "pause_build" || command === "resume_build") {
    return { tabId: `final-surface-absent-${command.replaceAll("_", "-")}` };
  }
  if (command === "halt_build") {
    return { tabId: "final-surface-absent-halt-build", summary: "bounded fixture" };
  }
  if (command === "start_build_mode") {
    return { tabId: "final-surface-build-validation", objective: "", cwd: profileRootForRequest(request) };
  }
  if (command === "start_grok_session") {
    return {
      cwd: grokSessionCwd(request),
      wslDistro: null,
      wslGrokPath: null,
      mcpServers: null,
      connectionId: null,
      tabId: grokSessionTabId(request),
      loadSessionId: null,
    };
  }
  if (command === "set_permission_mode") {
    return { mode: null, tabId: "final-surface-permission-mode" };
  }
  if (command === "shellx_browser_approve_developer_mode_host") {
    return { request: { host: null, currentUrl: null, taskId: null, fullCdpAccess: null } };
  }
  if (command === "shellx_browser_claim_cowork_prompt") {
    return { requestId: "final-surface-absent-cowork-prompt" };
  }
  if (command === "shellx_browser_control_task") {
    return {
      request: {
        taskId: "final-surface-absent-browser-task",
        action: "pause",
        reason: null,
        requestedBy: "operator",
      },
    };
  }
  if (command === "shellx_browser_finish_task") {
    return { taskId: "final-surface-absent-browser-task", status: "completed", reason: null };
  }
  if (command === "shellx_browser_delegate_tab_to_agent") {
    return {
      request: {
        browserTabId: "final-surface-absent-browser-tab",
        taskId: "final-surface-absent-browser-task",
        grantId: null,
        reason: "release validation",
      },
    };
  }
  if (command === "shellx_browser_take_back_tab_from_agent") {
    return {
      request: { browserTabId: "final-surface-absent-browser-tab", reason: "release validation" },
    };
  }
  if (command === "shellx_browser_grant_transfer") {
    return {
      request: {
        transferId: "final-surface-absent-transfer",
        direction: "download",
        origin: null,
        sha256: null,
        ttlSeconds: 30,
      },
    };
  }
  if (command === "shellx_browser_open_window") return { startUrl: "about:blank" };
  if (command === "shellx_browser_operator_evidence_summary") return { limit: 20 };
  if (command === "shellx_browser_operator_export_flight_recorder") {
    if (!browserEvidenceFixture) throw new Error("owned Browser evidence fixture is unavailable");
    return browserEvidenceExportArgs(browserEvidenceFixture);
  }
  if (command === "shellx_browser_sync_engine") {
    if (!browserEngineSyncFixture) throw new Error("owned Browser engine-sync fixture is unavailable");
    return tauriCommandBrowserEngineSyncArgs(browserEngineSyncFixture);
  }
  if (command === "shellx_browser_remove_site_shields") return { request: { host: "" } };
  if (command === "shellx_browser_resolve_dialog") {
    return {
      request: {
        dialogId: "final-surface-absent-dialog",
        taskId: null,
        action: "dismiss",
        promptValue: null,
        approvalId: null,
      },
    };
  }
  if (command === "shellx_browser_resolve_permission") {
    return {
      request: {
        permissionId: "final-surface-absent-browser-permission",
        action: "deny",
        approvalId: null,
      },
    };
  }
  if (command === "shellx_browser_resolve_session_grant") {
    return { grantId: "final-surface-absent-session-grant", approved: false };
  }
  if (command === "shellx_browser_send_cowork_prompt") {
    return {
      request: {
        taskId: null,
        targetTabId: "final-surface-cowork-target",
        prompt: "bounded release validation",
        startUrl: null,
        profileId: null,
        autonomy: null,
      },
    };
  }
  if (command === "shellx_browser_update_personal_lock") {
    return {
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
    };
  }
  if (command === "shellx_browser_update_privacy") {
    return {
      request: {
        globalAdMode: null,
        profileId: "final-surface-absent-browser-profile",
        profileAdMode: null,
      },
    };
  }
  if (command === "shellx_browser_update_site_shields") {
    return {
      request: {
        host: "",
        adTrackerMode: null,
        cookieMode: null,
        fingerprintingMode: null,
        httpsUpgradeEnabled: null,
        scriptBlockingEnabled: null,
      },
    };
  }
  if (command === "shellx_browser_update_developer_mode") {
    return {
      request: {
        enabled: true,
        fullCdpAccess: true,
        policyDisabled: false,
        approvedHosts: ["release.example.invalid"],
      },
    };
  }
  if (command === "shellx_browser_update_download_folder") {
    if (!browserSettingFixture?.downloadApiPath) throw new Error("owned Browser download-folder fixture is unavailable");
    return { request: { downloadFolder: browserSettingFixture.downloadApiPath } };
  }
  if (command === "shellx_browser_update_shields") {
    return {
      request: {
        enabled: false,
        adTrackerMode: "strict",
        cookieMode: "blockAll",
        fingerprintingMode: "strict",
        httpsUpgradeEnabled: false,
        scriptBlockingEnabled: true,
      },
    };
  }
  if (command === "shellx_vault_begin_setup") {
    return {
      request: {
        target: "local",
        passphrase: "",
        serverUrl: null,
        repo: null,
        token: null,
        keyfileJson: null,
        rememberDevice: null,
      },
    };
  }
  if (command === "shellx_vault_agent_request_approve" || command === "shellx_vault_agent_request_deny") {
    return {
      requestId: "final-surface-absent-agent-request",
      expectedDigest: "0".repeat(64),
    };
  }
  if (command === "shellx_vault_unlock") {
    return { request: { passphrase: "", keyfileJson: null, rememberDevice: null } };
  }
  if (command === "shellx_vault_set_remembered_device_enabled") {
    return { enabled: true, passphrase: null };
  }
  if (command === "shellx_vault_confirm_recovery_saved") {
    return { confirmationId: "final-surface-absent-recovery", importLegacy: false };
  }
  if (command === "shellx_vault_create_grant") {
    return {
      request: {
        secretRef: "",
        actorScope: { kind: "allShellxAgents" },
        operation: "connectorUse",
        expiresAtMs: null,
      },
    };
  }
  if (command === "shellx_vault_approve_grant" || command === "shellx_vault_revoke_grant") {
    return { grantId: "final-surface-absent-vault-grant" };
  }
  if (VAULT_MUTATION_COMMANDS.has(command)) {
    if (!vaultFixture) throw new Error("owned Vault mutation fixture is unavailable");
    return vaultMutationArgs(vaultFixture);
  }
  if (FILE_MUTATION_COMMANDS.has(command)) {
    if (!fileFixture) throw new Error("owned file-mutation fixture is unavailable");
    if (command === "copy_asset_to_scope") {
      return {
        src: fileFixture.apiSource,
        destDir: fileFixture.apiDestination,
        sourceTabId: null,
        targetTabId: null,
        sourceSessionCwd: profileRootForRequest(request),
        targetSessionCwd: profileRootForRequest(request),
      };
    }
    if (command === "copy_to_scope") {
      return { src: fileFixture.apiSource, destDir: fileFixture.apiDestination };
    }
    if (command === "save_dropped_attachment_to_scope") {
      return {
        filename: "final-surface-attachment.txt",
        mimeType: "text/plain",
        dataBase64: Buffer.from(fileFixture.content, "utf8").toString("base64"),
        destDir: fileFixture.apiDestination,
      };
    }
    if (command === "shellx_browser_copy_local_artifact") {
      return {
        request: {
          sourcePath: fileFixture.apiSource,
          destinationDir: fileFixture.apiDestination,
          fileName: "final-surface-browser-copy.txt",
        },
      };
    }
    return {
      request: {
        destinationDir: fileFixture.apiDestination,
        fileName: "final-surface-browser-write.txt",
        content: fileFixture.content,
      },
    };
  }
  if (command === "cleanup_mcp_children_for_tab") return { tabId: "final-surface-absent-mcp-children" };
  if (command === "resolve_permission_request") {
    return {
      requestId: "final-surface-absent-permission-request",
      allow: false,
      decision: "deny",
    };
  }
  if (command === "agent_cli_setup_state" || command === "connection_provider_scan") {
    return { preset: localConnectionPreset("") };
  }
  if (command === "get_build_receipts" || command === "get_build_state" || command === "get_goal_state") {
    return { tabId: "final-surface-read-fixture" };
  }
  if (command === "outside_connectors_events") return { limit: 20 };
  if (command === "session_tooling_snapshot") return { tabId: "final-surface-tooling-fixture" };
  if (command === "read_session_activity_source") {
    return { tabId: "final-surface-activity-missing-session" };
  }
  if (command === "grok_environment_snapshot") {
    return { tabId: "final-surface-environment-missing-session", force: false, cwd: null };
  }
  if (command === "get_detected_max_tokens" || command === "drop_tab_session") {
    return { tabId: "final-surface-context-fixture" };
  }
  if (command === "git_branches" || command === "git_session_status" || command === "git_session_diff") {
    if (!gitFixture) throw new Error("owned Git branch fixture is unavailable");
    return {
      cwd: gitFixture.apiPath,
      tabId: gitFixture.tabId,
      ...(command === "git_session_diff" ? { scope: "head" } : {}),
    };
  }
  if (GIT_MUTATION_COMMANDS.has(command)) {
    if (!gitFixture) throw new Error("owned Git mutation fixture is unavailable");
    return {
      cwd: gitFixture.apiPath,
      tabId: gitFixture.tabId,
      ...(command === "git_session_create_checkpoint"
        ? { label: "Final surface checkpoint" }
        : { sourceBranch: "release-proof", newBranch: "final-surface-worktree" }),
    };
  }
  if (command === "read_session_jsonl" || command === "read_session_jsonl_tail") {
    if (!sessionFixture) throw new Error("owned session history fixture is unavailable");
    return {
      sessionId: sessionFixture.id,
      ...(command === "read_session_jsonl_tail" ? { limit: 2 } : {}),
    };
  }
  if (command === "append_session_log" || command === "rename_past_session" || command === "delete_session_files") {
    if (!sessionFixture) throw new Error("owned session history mutation fixture is unavailable");
    if (command === "append_session_log") {
      return {
        sessionId: sessionFixture.id,
        line: JSON.stringify(sessionAppendRecord(request)),
      };
    }
    if (command === "rename_past_session") {
      return {
        sessionId: sessionFixture.id,
        newTitle: sessionRenameTitle(request),
      };
    }
    return { ids: [sessionFixture.id] };
  }
  if (command === "read_image_as_data_url" || command === "read_preview_file_as_data_url") {
    if (!mediaFixture) throw new Error("owned media fixture is unavailable");
    return {
      path: mediaFixture.apiPath,
      tabId: "final-surface-media-fixture",
      sessionCwd: mediaFixture.sessionCwd,
    };
  }
  const profileRoot = releaseSurfaceProfileLaunchRootFromDebugTokenPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
  const profileMarker = releaseSurfaceProfileMarkerLaunchPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
  if (command === "list_project_files") {
    return {
      path: profileRoot,
      tabId: "final-surface-profile-fixture",
      connectionId: null,
      includeHidden: false,
    };
  }
  if (command === "read_text_file_for_path") {
    return {
      path: profileMarker,
      tabId: "final-surface-profile-fixture",
      sessionCwd: profileRoot,
    };
  }
  if (command === "read_text_file_if_text") return { path: profileMarker, maxBytes: 64 * 1024 };
  if (command === "write_user_data") return { data: userDataWrittenFixture(request) };
  if (command === "delete_user_data_section") return { key: "releaseSurfaceDeleteFixture" };
  if (GOAL_COMMANDS.has(command)) {
    if (!goalFixture) throw new Error("owned goal-state fixture is unavailable");
    if (command === "set_goal_mode") return goalModeArgs(goalFixture, true);
    return { tabId: goalFixture.tabId };
  }
  return command === "vault_list_keys" ? { prefix: null } : {};
}

function browserEvidenceExportArgs(fixture: DebugApiBrowserSettleFixture): Json {
  return {
    request: {
      taskId: fixture.taskId,
      browserTabId: fixture.browserTabId,
      reason: "Final release operator evidence IPC proof",
    },
  };
}

function verifyOperatorFlightRecorderArtifact(
  value: unknown,
  request: ReleaseSurfaceDriverRequest,
  fixture: DebugApiBrowserSettleFixture,
): { nodePath: string; attemptId: string } {
  const artifact = requireRecord(value, "operator Flight Recorder artifact");
  const attemptId = requireStringValue(artifact, "attemptId", "operator Flight Recorder artifact");
  const launchPath = requireStringValue(artifact, "path", "operator Flight Recorder artifact");
  const sha256 = requireStringValue(artifact, "sha256", "operator Flight Recorder artifact");
  requireInteger(artifact, "bytes", "operator Flight Recorder artifact");
  const bytes = Number(artifact.bytes);
  if (artifact.taskId !== fixture.taskId || artifact.browserTabId !== fixture.browserTabId
    || artifact.source !== "shellx-browser-flight-recorder" || artifact.evidenceComplete !== true
    || !/^[a-f0-9]{64}$/.test(sha256) || bytes <= 0 || bytes > 512 * 1024) {
    throw new Error("operator Flight Recorder artifact omitted its exact bounded task identity");
  }
  const nodePath = nodeReadablePath(launchPath, request.platform);
  const stat = lstatSync(nodePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== bytes) {
    throw new Error("operator Flight Recorder artifact was not one matching regular file");
  }
  const content = readFileSync(nodePath);
  if (createHash("sha256").update(content).digest("hex") !== sha256) {
    throw new Error("operator Flight Recorder artifact SHA-256 did not match its bytes");
  }
  const payload = requireRecord(JSON.parse(content.toString("utf8")), "operator Flight Recorder payload");
  const manifest = requireRecord(payload.manifest, "operator Flight Recorder manifest");
  if (payload.schemaVersion !== "sx.flightRecorder.v1" || payload.attemptId !== attemptId
    || manifest.taskId !== fixture.taskId || manifest.browserTabId !== fixture.browserTabId) {
    throw new Error("operator Flight Recorder file did not match its response and owned task");
  }
  return { nodePath, attemptId };
}

function verifyExpectedRejection(command: SupportedCommand, completed: InvokeState): string {
  const expected = EXPECTED_REJECTIONS.get(command);
  if (!expected) throw new Error(`${command} has no declared rejection contract`);
  if (completed.status !== "failed" || completed.error !== expected) {
    throw new Error(`${command} did not return its exact fail-closed rejection`);
  }
  return `Installed IPC invoked ${command} and returned its exact fail-closed validation or absent-state rejection without performing the guarded operation.`;
}

async function verifyCommandResult(
  command: SupportedCommand,
  value: unknown,
  request: ReleaseSurfaceDriverRequest,
  webdriver: TauriCommandTransport,
  gitFixture: DebugApiGitFixture | null,
  sessionFixture: DebugApiSessionFixture | null,
  mediaFixture: TauriCommandMediaFixture | null,
  goalFixture: GoalFixture | null,
  fileFixture: FileMutationFixture | null,
  vaultFixture: VaultMutationFixture | null,
  screenshotFixture: ScreenshotFixture | null,
  tokenRotationFixture: TokenRotationFixture | null,
  gitMutationFixture: GitMutationFixture | null,
  marketplaceFixture: MarketplaceMutationFixture | null,
  browserSettingFixture: BrowserSettingMutationFixture | null,
  browserHistoryFixture: DebugApiBrowserSettleFixture | null,
  browserEvidenceFixture: DebugApiBrowserSettleFixture | null,
  browserEngineSyncFixture: TauriCommandBrowserEngineSyncFixture | null,
): Promise<string> {
  if (command === "get_debug_token" || command === "shellxagent_token_read") {
    const expected = readAttestedDebugToken(request);
    if (value !== expected) throw new Error(`${command} did not return the exact attested candidate token`);
    return `Installed IPC ${command} returned the exact attested candidate token; token material was not retained.`;
  }
  if (command === "abort_session") {
    if (value !== "Session aborted") throw new Error("abort_session did not confirm the disposable session abort");
    return "Installed IPC aborted an owned empty session slot, cleaned its task children, and then dropped the slot.";
  }
  if (command === "start_grok_session") {
    const tabId = grokSessionTabId(request);
    const cwd = grokSessionCwd(request);
    if (value !== `Grok session started in ${cwd}`) {
      throw new Error("start_grok_session did not return its exact owned local-session result");
    }
    const row = await waitForSessionChild(request, tabId, true, "start_grok_session provider child");
    if (normalizePath(String(row.cwd ?? "")) !== normalizePath(cwd)
      || row.isSsh !== false
      || row.isWsl !== false) {
      throw new Error("start_grok_session did not register the exact owned local transport and cwd");
    }
    return "Installed IPC initialized one real local Grok ACP child in the isolated profile without sending a provider prompt; cleanup aborts the child and removes its session slot.";
  }
  if (command === "set_permission_mode") {
    if (value !== "bypassPermissions") throw new Error("set_permission_mode did not return the exact ShellX Full Auto default");
    return "Installed IPC reset an owned disposable session slot to the ShellX Full Auto default and then removed the slot.";
  }
  if (command === "capture_app_screenshot_to_file") {
    if (!screenshotFixture) throw new Error("owned screenshot fixture is unavailable");
    return verifyScreenshotResult(value, screenshotFixture);
  }
  if (command === "shellxagent_token_regenerate") {
    if (!tokenRotationFixture) throw new Error("owned token-rotation fixture is unavailable");
    const observed = verifyTokenRotationResult(value, tokenRotationFixture);
    const readback = await invokeTemporaryTauriCommand(webdriver, "shellxagent_token_read", {});
    if (readback !== value) throw new Error("shellxagent token readback did not observe the rotated token");
    return observed;
  }
  if (VAULT_MUTATION_COMMANDS.has(command)) {
    if (!vaultFixture) throw new Error("owned Vault mutation verifier is unavailable");
    return verifyVaultMutation(command, value, webdriver, vaultFixture);
  }
  if (command === "mcp_marketplace_uninstall") {
    if (!marketplaceFixture) throw new Error("owned marketplace mutation verifier is unavailable");
    requireVoidResult(value, command);
    const rows = verifyMarketplaceRows(
      await invokeTemporaryTauriCommand(webdriver, "mcp_marketplace_list", {}),
      "marketplace uninstall readback",
    );
    const row = rows.map((item) => requireRecord(item, "marketplace uninstall row"))
      .find((item) => item.id === marketplaceFixture.id);
    if (!row || row.installed !== false) throw new Error("marketplace uninstall did not clear the owned entry");
    return "Installed IPC removed one prepared marketplace entry from the isolated profile, read back its absent state, and restored both persisted config files.";
  }
  if (GIT_MUTATION_COMMANDS.has(command)) {
    if (!gitFixture || !gitMutationFixture) throw new Error("owned Git mutation verifier is unavailable");
    return verifyGitMutation(command, value, request, gitFixture, gitMutationFixture);
  }
  if (command === "cleanup_mcp_children_for_tab") {
    if (value !== 0) throw new Error("absent disposable tab unexpectedly owned MCP child processes");
    return "Installed IPC confirmed the disposable absent tab owned zero MCP child processes and changed no process state.";
  }
  if (command === "resolve_permission_request") {
    if (value !== false) throw new Error("absent permission request unexpectedly resolved");
    return "Installed IPC rejected an unregistered disposable permission identifier without resolving any live request.";
  }
  if (command === "shellx_browser_replay_cowork_prompt_notifications") {
    if (value !== 0) throw new Error("isolated candidate unexpectedly held pending Browser cowork prompts");
    return "Installed IPC confirmed the isolated candidate had zero pending Browser cowork notifications to replay.";
  }
  if (command === "shellx_browser_open_vault_panel") {
    requireVoidResult(value, command);
    await waitForVaultPanelVisibility(webdriver, true);
    return "Installed IPC opened the real Vault workspace in the attested renderer; the panel was closed after all bounded notification retries completed.";
  }
  if (command === "shellx_browser_open_window") {
    const body = requireRecord(value, command);
    const receipt = requireRecord(body.receipt, `${command}.receipt`);
    const evidence = requireRecord(receipt.evidence, `${command}.receipt.evidence`);
    if (body.ok !== true
      || body.windowLabel !== "shellx-browser"
      || body.startUrl !== "about:blank"
      || receipt.kind !== "browserWindowOpened"
      || evidence.windowLabel !== "shellx-browser"
      || evidence.startUrl !== "about:blank") {
      throw new Error(`${command} did not return its exact native-window response and receipt`);
    }
    const state = requireRecord(
      await invokeTemporaryTauriCommand(webdriver, "shellx_browser_state", {}),
      `${command} readback`,
    );
    const enginePool = requireRecord(state.enginePool, `${command} readback engine pool`);
    const receipts = requireArray(state.receipts, `${command} readback receipts`)
      .map((entry) => requireRecord(entry, `${command} readback receipt`));
    const matchingReceipts = receipts.filter((entry) => entry.receiptId === receipt.receiptId);
    if (state.windowOpen !== true
      || state.pendingStartUrl !== "about:blank"
      || enginePool.windowState !== "foreground"
      || matchingReceipts.length !== 1
      || matchingReceipts[0]?.kind !== "browserWindowOpened") {
      throw new Error(`${command} did not persist the exact foreground Browser window transition`);
    }
    return "Installed IPC opened or focused the native ShellX Browser at about:blank and proved its exact foreground state plus one matching monotonic receipt; candidate teardown removes both.";
  }
  if (command === "shellx_browser_sync_engine") {
    if (!browserEngineSyncFixture) throw new Error("owned Browser engine-sync verifier is unavailable");
    return verifyTauriCommandBrowserEngineSync(
      value,
      debugApiConnectionForRequest(request),
      (name, args) => invokeTemporaryTauriCommand(webdriver, name, args),
      browserEngineSyncFixture,
    );
  }
  if (command === "shellx_browser_operator_export_flight_recorder") {
    if (!browserEvidenceFixture) throw new Error("owned Browser evidence fixture is unavailable");
    verifyOperatorFlightRecorderArtifact(value, request, browserEvidenceFixture);
    return "Installed operator IPC exported one bounded Flight Recorder artifact for the exact owned Browser task, verified its bytes and SHA-256, then removed the file, task, and tab.";
  }
  if (command === "shellx_browser_operator_evidence_summary") {
    if (!browserEvidenceFixture) throw new Error("owned Browser evidence fixture is unavailable");
    const body = requireRecord(value, command);
    const recent = requireArray(body.recent, `${command}.recent`)
      .map((entry) => requireRecord(entry, `${command}.recent row`));
    const matching = recent.filter((entry) => {
      const evidence = requireRecord(entry.evidence, `${command}.evidence`);
      return entry.kind === "browserFlightRecorderExported"
        && entry.taskId === browserEvidenceFixture.taskId
        && typeof evidence.attemptId === "string";
    });
    if (body.ok !== true || body.callerScoped !== false || body.count !== recent.length
      || recent.length > 20 || matching.length !== 1) {
      throw new Error(`${command} omitted its bounded operator-scoped owned evidence row`);
    }
    return "Installed operator IPC returned one exact owned Flight Recorder row through a bounded summary, then removed its artifact, task, and tab.";
  }
  if (BROWSER_SETTING_MUTATION_COMMANDS.has(command)) {
    if (!browserSettingFixture) throw new Error("owned Browser setting mutation verifier is unavailable");
    return verifyBrowserSettingMutation(command, value, webdriver, browserSettingFixture);
  }
  if (command === "shellx_browser_clear_history") {
    if (!browserHistoryFixture) throw new Error("owned Browser history fixture is unavailable");
    const receipt = requireRecord(value, command);
    const evidence = requireRecord(receipt.evidence, `${command}.evidence`);
    if (receipt.kind !== "browserHistoryCleared" || evidence.cleared !== 1) {
      throw new Error(`${command} did not report exactly one cleared owned history entry`);
    }
    const state = requireRecord(
      await invokeTemporaryTauriCommand(webdriver, "shellx_browser_state", {}),
      `${command} readback`,
    );
    if (requireArray(state.history, `${command} readback history`).length !== 0) {
      throw new Error(`${command} left Browser history entries behind`);
    }
    return "Installed IPC cleared exactly one owned loopback Browser history entry and proved empty readback before task, tab, and candidate teardown.";
  }
  if (command === "renderer_error") {
    requireVoidResult(value, command);
    const marker = rendererErrorMarker(request);
    const events = await debugApiJson(request, "GET", "/events/recent?limit=8000");
    if (!Array.isArray(events)) throw new Error("renderer_error event readback did not return an array");
    const matches = events.filter((event) => {
      const row = requireRecord(event, "renderer_error event");
      const payload = requireRecord(row.payload, "renderer_error event payload");
      return row.kind === "renderer-error" && payload.message === marker;
    });
    if (matches.length !== 1) throw new Error(`renderer_error produced ${matches.length} exact ledger events instead of one`);
    const payload = requireRecord(requireRecord(matches[0], "renderer_error exact event").payload, "renderer_error exact payload");
    if (payload.stack !== "final-surface-renderer-stack" || payload.componentStack !== "final-surface-component-stack") {
      throw new Error("renderer_error omitted its exact bounded stack fields");
    }
    return "Installed IPC recorded one exact bounded renderer-error event in the authenticated candidate ledger; the monotonic event ends with candidate teardown.";
  }
  if (USER_DATA_MUTATION_COMMANDS.has(command)) {
    return verifyUserDataMutation(command, value, request, webdriver);
  }
  if (command === "append_session_log" || command === "rename_past_session" || command === "delete_session_files") {
    return verifySessionHistoryMutation(command, value, request, webdriver, sessionFixture);
  }
  if (GOAL_COMMANDS.has(command)) {
    if (!goalFixture) throw new Error("owned goal-state verifier fixture is unavailable");
    return verifyGoalCommand(command, value, webdriver, goalFixture);
  }
  if (command === "agent_cli_setup_state" || command === "agent_cli_setup_recheck") {
    const body = requireRecord(value, command);
    const target = requireRecord(body.target, `${command}.target`);
    requireString(target, "label", command);
    requireString(target, "transport", command);
    requireString(target, "commandRunsOn", command);
    const providers = requireArray(body.providers, `${command}.providers`);
    requireExactProviderIds(providers, command);
    for (const row of providers) {
      const item = requireRecord(row, `${command} provider`);
      for (const key of ["providerId", "displayName", "status", "docsUrl", "officialSourceUrl", "authHint"]) {
        requireString(item, key, command);
      }
      for (const key of ["canRun", "installable"]) requireBoolean(item, key, command);
      if (!Array.isArray(item.installMethods)) throw new Error(`${command} provider omitted installMethods`);
      if (item.canRun === true && (typeof item.binary !== "string" || typeof item.version !== "string")) {
        throw new Error(`${command} runnable provider omitted its live binary or version`);
      }
    }
    return `Installed IPC returned live setup state for ${providers.length} provider CLI(s); binary paths and versions were not retained.`;
  }
  if (command === "agent_cli_setup_cancel_install") {
    if (value !== false) throw new Error("absent setup confirmation was unexpectedly cancelled");
    return "Installed IPC confirmed that cancelling an absent install confirmation is an idempotent no-op.";
  }
  if (command === "pty_kill") {
    requireVoidResult(value, command);
    return "Installed IPC confirmed that killing an absent disposable terminal is an idempotent no-op.";
  }
  if (command === "reject_build_plan" || command === "pause_build" || command === "halt_build") {
    if (value !== false) throw new Error(`${command} unexpectedly changed absent Build Mode state`);
    return `Installed IPC confirmed that ${command} is an idempotent no-op for an absent disposable Build Mode run.`;
  }
  if (command === "connections_save" || command === "connections_delete") {
    return verifyConnectionMutation(command, value, webdriver);
  }
  if (command === "connections_test") {
    const body = requireRecord(value, command);
    if (body.reachable !== false || body.latencyMs !== null || body.error !== "unknown connection id") {
      throw new Error("connections_test did not return the exact unknown-connection result");
    }
    return "Installed IPC returned the exact network-inert unknown-connection test result.";
  }
  if (command === "outside_connectors_save" || command === "outside_connectors_delete") {
    return verifyOutsideConnectorMutation(command, value, webdriver);
  }
  if (command === "outside_connectors_test") {
    const body = requireRecord(value, command);
    if (body.reachable !== false || body.provider !== "unknown" || body.latencyMs !== null
      || body.identity !== null || body.error !== "unknown connector id") {
      throw new Error("outside_connectors_test did not return the exact unknown-connector result");
    }
    return "Installed IPC returned the exact network-inert unknown-connector test result.";
  }
  if (FILE_MUTATION_COMMANDS.has(command)) {
    if (!fileFixture) throw new Error("owned file-mutation verifier fixture is unavailable");
    return verifyFileMutation(command, value, fileFixture);
  }
  if (command === "connection_provider_scan") {
    const body = requireRecord(value, command);
    if (body.schemaVersion !== "shellx.provider-capability-snapshot.v2"
      || !Number.isSafeInteger(body.generatedAtMs) || !Number.isSafeInteger(body.freshUntilMs)
      || Number(body.freshUntilMs) <= Number(body.generatedAtMs)) {
      throw new Error("provider capability snapshot omitted its current schema or freshness window");
    }
    const target = requireRecord(body.target, `${command}.target`);
    for (const key of ["key", "transport", "runtime", "label"]) requireString(target, key, command);
    const providers = requireArray(body.providers, `${command}.providers`);
    requireExactProviderIds(providers, command);
    const statuses = new Set(["ready", "missing", "versionFailed", "identityFailed", "targetUnavailable", "authNeeded", "canaryFailed"]);
    let ready = 0;
    for (const row of providers) {
      const item = requireRecord(row, `${command} provider`);
      requireString(item, "providerId", command);
      requireBoolean(item, "canRun", command);
      if (!statuses.has(String(item.status)) || item.targetKey !== target.key || !Number.isSafeInteger(item.checkedAtMs)) {
        throw new Error(`${command} provider row omitted live status, target identity, or check time`);
      }
      if (item.status === "ready") {
        ready += 1;
        if (item.canRun !== true || typeof item.binary !== "string" || typeof item.version !== "string"
          || !/^[a-f0-9]{64}$/i.test(String(item.binarySha256))
          || !Number.isSafeInteger(item.binaryBytes) || Number(item.binaryBytes) <= 0) {
          throw new Error(`${command} ready provider omitted exact live version and binary identity`);
        }
      }
    }
    return `Installed IPC freshly scanned ${providers.length} provider CLI(s) and proved exact identity for ${ready} ready row(s); paths and versions were not retained.`;
  }
  if (command === "get_debug_port") {
    const expected = Number(new URL(request.runtime.debugBase).port);
    if (!Number.isSafeInteger(value) || value !== expected) throw new Error("get_debug_port did not match the attested Debug API endpoint");
    return "Installed IPC returned the exact attested Debug API port.";
  }
  if (command === "get_detected_max_tokens") {
    if (value !== 128_000) throw new Error("empty disposable session did not return the exact 128k context fallback");
    return "Installed IPC returned the exact 128k fallback for an owned empty session slot, then removed that slot.";
  }
  if (command === "drop_tab_session") {
    if (value !== true) throw new Error("drop_tab_session did not remove the prepared disposable session slot");
    return "Installed IPC removed the exact owned disposable session slot and reported that a slot existed.";
  }
  if (command === "git_branches") {
    const body = requireRecord(value, command);
    const rows = requireArray(body.branches, `${command}.branches`);
    if (rows.length !== 1) throw new Error("owned Git repository did not return exactly one branch");
    const branch = requireRecord(rows[0], `${command}.branch`);
    if (branch.name !== "release-proof" || branch.isCurrent !== true
      || branch.isRemote !== false || branch.upstream !== null) {
      throw new Error("owned Git repository omitted its exact current local branch state");
    }
    return "Installed IPC returned the exact current local branch from an owned repository; branch and path were not retained, and the repository was removed.";
  }
  if (command === "git_session_status" || command === "git_session_diff") {
    const path = command === "git_session_status" ? "/state/session_git" : "/state/session_git/diff";
    const observed = verifyDebugApiGitJson(path, value, gitFixture);
    if (!observed) throw new Error(`${command} did not run its owned repository verifier`);
    return observed;
  }
  if (command === "get_home_dir") {
    if (typeof value !== "string" || !value.trim() || value.length > 32_768 || value.includes("\0")) {
      throw new Error("get_home_dir did not return a bounded platform path");
    }
    return "Installed IPC returned a non-empty bounded platform home path; the path was not retained.";
  }
  if (command === "workflow_skill_statuses") {
    const rows = requireArray(value, command);
    if (rows.length !== 0) throw new Error("retired workflow skills were unexpectedly advertised");
    return "Installed IPC confirmed that retired global workflow skills are not advertised.";
  }
  if (command === "connections_list") {
    const rows = requireArray(value, command);
    for (const row of rows) {
      const item = requireRecord(row, `${command} row`);
      for (const key of ["id", "label"]) requireString(item, key, command);
      requireRecord(item.transport, `${command}.transport`);
      for (const key of ["createdMs", "lastUsedMs"]) requireInteger(item, key, command);
    }
    return `Installed IPC returned ${rows.length} bounded connection preset row(s); labels and transport targets were not retained.`;
  }
  if (command === "get_build_receipts") {
    const rows = requireArray(value, command);
    if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error("build receipts contained a non-object row");
    }
    return `Installed IPC returned ${rows.length} build receipt row(s) for the disposable tab; receipt content was not retained.`;
  }
  if (command === "get_build_state" || command === "get_goal_state") {
    if (value !== null && (!value || typeof value !== "object" || Array.isArray(value))) {
      throw new Error(`${command} returned neither null nor a state object`);
    }
    return `Installed IPC returned an explicit ${value === null ? "empty" : "active"} ${command === "get_build_state" ? "build" : "goal"} state for the disposable tab.`;
  }
  if (command === "list_stored_sessions") {
    const rows = requireArray(value, command);
    for (const row of rows) {
      const item = requireRecord(row, `${command} row`);
      for (const key of ["id", "title"]) requireString(item, key, command);
      for (const key of ["mtimeMs", "size"]) requireInteger(item, key, command);
      if (item.cwd !== null && item.cwd !== undefined && typeof item.cwd !== "string") {
        throw new Error("stored session row returned an invalid nullable cwd");
      }
    }
    return `Installed IPC returned ${rows.length} stored session row(s); titles, paths, and connection details were not retained.`;
  }
  if (command === "list_project_files") {
    const rows = requireArray(value, command);
    let sawFile = false;
    let previous = "";
    let marker = false;
    for (const row of rows) {
      const item = requireRecord(row, `${command} row`);
      const name = requireStringValue(item, "name", command);
      const kind = requireStringValue(item, "kind", command);
      if (name.startsWith(".") || (kind !== "dir" && kind !== "file")) {
        throw new Error("project file listing exposed a hidden entry or invalid kind");
      }
      requireInteger(item, "size", command);
      if (kind === "file") sawFile = true;
      else if (sawFile) throw new Error("project file listing did not keep directories before files");
      const key = `${kind === "dir" ? "0" : "1"}:${name.toLowerCase()}`;
      if (previous && key.localeCompare(previous) < 0) throw new Error("project file listing was not deterministically sorted");
      previous = key;
      marker ||= name === "shellx-final-profile.json" && kind === "file";
    }
    if (!marker) throw new Error("project file listing omitted the owned release profile marker");
    return `Installed IPC listed ${rows.length} sorted visible profile entry row(s) and the exact owned marker; names and paths were not retained.`;
  }
  if (command === "read_text_file_for_path") {
    verifyProfileMarkerText(value, command, request);
    return "Installed IPC read and validated the exact owned release-profile marker; marker contents and paths were not retained.";
  }
  if (command === "read_text_file_if_text") {
    const body = requireRecord(value, command);
    if (body.kind !== "text") throw new Error("owned JSON profile marker was not classified as text");
    verifyProfileMarkerText(body.content, command, request);
    return "Installed IPC classified the exact owned release-profile marker as bounded text; contents and paths were not retained.";
  }
  if (command === "read_user_data") {
    const body = requireRecord(value, command);
    if (Object.keys(body).length !== 0) {
      throw new Error("isolated release profile unexpectedly contained persisted user data");
    }
    return "Installed IPC confirmed the isolated release profile starts with an empty user-data store; no user data was retained.";
  }
  if (command === "read_session_jsonl" || command === "read_session_jsonl_tail") {
    return verifyTauriSessionJsonl(command, value, sessionFixture);
  }
  if (command === "read_session_activity_source") {
    const body = requireRecord(value, command);
    if (body.tabId !== "final-surface-activity-missing-session"
      || body.sessionId !== null
      || body.cwd !== null
      || body.transport !== "unknown"
      || body.status !== "no-session"
      || body.readable !== false
      || body.scratchDir !== null
      || body.hunkRecordsPath !== null
      || body.hunkRecordsJsonl !== ""
      || body.updatesPath !== null
      || body.updatesJsonl !== ""
      || typeof body.note !== "string"
      || !body.note) {
      throw new Error("read_session_activity_source did not return the exact non-creating absent-session contract");
    }
    return "Installed IPC confirmed that reading Activity Browser state for an absent disposable tab creates no ghost session or activity files.";
  }
  if (command === "grok_environment_snapshot") {
    const body = requireRecord(value, command);
    if (body.tabId !== "final-surface-environment-missing-session"
      || body.status !== "idle" || body.transport !== "none" || body.cwd !== null
      || body.sessionId !== null || body.doctor !== null || body.inspect !== null
      || typeof body.error !== "string" || !body.error
      || !Number.isSafeInteger(body.checkedAtMs)) {
      throw new Error("grok_environment_snapshot did not return the exact absent-session environment identity");
    }
    for (const key of ["setup", "readiness"]) {
      const section = requireRecord(body[key], `${command}.${key}`);
      const summary = requireRecord(section.summary, `${command}.${key}.summary`);
      const checks = requireArray(section.checks, `${command}.${key}.checks`);
      for (const countKey of ["readyCount", "attentionCount", "totalCount"]) requireInteger(summary, countKey, command);
      if (summary.totalCount !== checks.length) throw new Error(`${command} ${key} count did not match its checks`);
    }
    const apiKeyHint = requireRecord(body.apiKeyHint, `${command}.apiKeyHint`);
    if (typeof apiKeyHint.preferredPresent !== "boolean" || typeof apiKeyHint.legacyPresent !== "boolean"
      || typeof apiKeyHint.preferredEnv !== "string" || typeof apiKeyHint.legacyEnv !== "string") {
      throw new Error("grok_environment_snapshot exposed an invalid API-key presence hint");
    }
    return "Installed IPC returned an idle absent-session Grok environment with typed checks and credential-presence booleans only; details were not retained.";
  }
  if (command === "read_image_as_data_url" || command === "read_preview_file_as_data_url") {
    if (!mediaFixture || value !== mediaFixture.expectedDataUrl) {
      throw new Error(`${command} did not return the exact bounded PNG data URL`);
    }
    return `Installed IPC returned the exact owned PNG through ${command}; path and media bytes were not retained, and the file was removed.`;
  }
  if (command === "mcp_marketplace_list") {
    const rows = verifyMarketplaceRows(value, command);
    return `Installed IPC returned ${rows.length} typed MCP marketplace row(s); names, descriptions, and Vault key references were not retained.`;
  }
  if (command === "session_tooling_snapshot") {
    const body = requireRecord(value, command);
    if (body.tabId !== "final-surface-tooling-fixture") throw new Error("session tooling snapshot omitted its exact isolated tab identity");
    requireRecord(body.session, `${command}.session`);
    const desired = verifyMarketplaceRows(body.desired, `${command}.desired`);
    const health = requireArray(body.health, `${command}.health`);
    for (const row of health) {
      const item = requireRecord(row, `${command}.health row`);
      for (const key of ["entryId", "tabId", "status", "launcher"]) requireString(item, key, command);
      requireInteger(item, "lastCheckMs", command);
      if (item.tabId !== "final-surface-tooling-fixture") throw new Error("session tooling health escaped its isolated tab");
    }
    return `Installed IPC returned ${desired.length} desired Tooling row(s) and ${health.length} isolated health receipt(s); session and launcher details were not retained.`;
  }
  if (command === "outside_connectors_list") {
    const rows = requireArray(value, command);
    for (const row of rows) {
      const item = requireRecord(row, `${command} row`);
      for (const key of ["id", "label", "dispatchMode"]) requireString(item, key, command);
      for (const key of ["enabled", "requireApproval"]) requireBoolean(item, key, command);
      requireRecord(item.provider, `${command}.provider`);
      requireRecord(item.target, `${command}.target`);
      for (const key of ["createdMs", "updatedMs"]) requireInteger(item, key, command);
    }
    return `Installed IPC returned ${rows.length} outside connector row(s); labels, targets, and Vault references were not retained.`;
  }
  if (command === "outside_connectors_events") {
    const rows = requireArray(value, command);
    for (const row of rows) {
      const item = requireRecord(row, `${command} row`);
      for (const key of ["id", "connectorId", "provider", "direction", "status"]) requireString(item, key, command);
      requireInteger(item, "createdMs", command);
      if (typeof item.textPreview !== "string" || typeof item.externalPreview !== "string") {
        throw new Error("outside connector event omitted its bounded previews");
      }
    }
    return `Installed IPC returned ${rows.length} bounded outside connector event row(s); message previews and identities were not retained.`;
  }
  if (command === "vault_list_keys_with_meta") {
    const rows = requireArray(value, command);
    for (const row of rows) {
      const item = requireRecord(row, `${command} row`);
      if ("value" in item || "secret" in item) throw new Error("Vault metadata listing exposed a secret value field");
      requireString(item, "key", command);
      requireString(item, "resourceKind", command);
      requireBoolean(item, "userOnly", command);
      requireInteger(item, "lastModifiedMs", command);
      if (!Array.isArray(item.resourceFields)) throw new Error("Vault key metadata omitted resourceFields");
    }
    return `Installed IPC returned ${rows.length} metadata-only Vault key row(s); key names and metadata were not retained.`;
  }
  if (command === "voice_credential_source") {
    const sources = new Set(["oauth", "vault", "env", "pass:xai/api-key", "pass:grok/api-key", "none"]);
    if (typeof value !== "string" || !sources.has(value)) throw new Error("voice credential source returned an unsupported label");
    return "Installed IPC returned a recognized credential-source label without exposing credential material or retaining the source.";
  }
  if (command === "list_background_tasks") {
    const rows = requireArray(value, command);
    for (const row of rows) {
      const item = requireRecord(row, `${command} row`);
      if (typeof item.taskId !== "string" || !item.taskId || typeof item.origin !== "string"
        || typeof item.commandDisplay !== "string" || typeof item.status !== "string"
        || !Number.isSafeInteger(item.startedAtMs) || typeof item.recentOutputTail !== "string"
        || item.recentOutputTail.length > 1_024) {
        throw new Error("background task row omitted its bounded identity, status, or output tail");
      }
    }
    return `Installed IPC returned ${rows.length} bounded background task row(s); command text and output were not retained.`;
  }
  if (command === "outside_connectors_capabilities") {
    const rows = requireArray(value, command);
    if (rows.length === 0) throw new Error("outside connector capabilities returned no providers");
    for (const row of rows) {
      const item = requireRecord(row, `${command} row`);
      for (const key of ["provider", "label", "receiptTier", "markdownDialect"]) requireString(item, key, command);
      for (const key of ["supportsThreading", "supportsAttachments", "supportsButtons"]) requireBoolean(item, key, command);
      if (!Number.isSafeInteger(item.maxMessageBytes) || Number(item.maxMessageBytes) <= 0) {
        throw new Error("outside connector capability omitted its positive message budget");
      }
    }
    return `Installed IPC returned ${rows.length} typed outside-connector capability row(s).`;
  }
  if (command === "shellx_vault_list_grants") {
    const rows = requireArray(value, command);
    for (const row of rows) {
      const item = requireRecord(row, `${command} row`);
      for (const key of ["grantId", "secretRef", "actorScope", "operation"]) requireString(item, key, command);
      for (const key of ["revoked", "approved"]) requireBoolean(item, key, command);
      if (!Number.isSafeInteger(item.createdAtMs)
        || (item.expiresAtMs !== null && item.expiresAtMs !== undefined && !Number.isSafeInteger(item.expiresAtMs))) {
        throw new Error("Vault grant row omitted valid lifecycle timestamps");
      }
    }
    return `Installed IPC returned ${rows.length} redacted Vault grant summary row(s); references were not retained.`;
  }
  if (command === "shellx_vault_agent_request_center") {
    const center = requireRecord(value, command);
    const requests = requireArray(center.requests, `${command}.requests`);
    const resources = requireArray(center.resources, `${command}.resources`);
    if (!Number.isSafeInteger(center.pendingCount) || Number(center.pendingCount) < 0) {
      throw new Error("Vault request center returned an invalid pending count");
    }
    let pending = 0;
    for (const row of requests) {
      const item = requireRecord(row, `${command} request`);
      for (const key of ["requestId", "requestDigest", "actorId", "actorLabel", "status"]) {
        requireString(item, key, command);
      }
      requireInteger(item, "createdAtMs", command);
      requireInteger(item, "expiresAtMs", command);
      requireRecord(item.spec, `${command}.request.spec`);
      if (item.status === "pending") pending += 1;
    }
    for (const row of resources) {
      const item = requireRecord(row, `${command} resource`);
      for (const key of ["id", "label", "kind", "permission"]) requireString(item, key, command);
      if (!Array.isArray(item.fields)) throw new Error("Vault request-center resource omitted fields");
      requireInteger(item, "updatedAtMs", command);
      if ("value" in item || "secret" in item) throw new Error("Vault request center exposed resource secret material");
    }
    if (pending !== center.pendingCount) throw new Error("Vault request-center pending count did not derive from request rows");
    return `Installed IPC returned ${requests.length} typed Vault agent request row(s) and ${resources.length} metadata-only resource row(s); request and resource identities were not retained.`;
  }
  if (command === "vault_list_keys") {
    const rows = requireArray(value, command);
    if (rows.some((row) => typeof row !== "string" || !row || row.length > 512)) {
      throw new Error("Vault key listing contained an invalid identifier");
    }
    return `Installed IPC returned ${rows.length} Vault key identifier(s) and no values; identifiers were not retained.`;
  }
  if (command === "vault_list_resources") {
    const rows = requireArray(value, command);
    for (const row of rows) {
      const item = requireRecord(row, `${command} row`);
      if ("value" in item || "secret" in item) throw new Error("Vault resource listing exposed a secret value field");
      requireString(item, "key", command);
      requireString(item, "resourceKind", command);
      requireBoolean(item, "userOnly", command);
      if (!Array.isArray(item.resourceFields) || !Number.isSafeInteger(item.lastModifiedMs)) {
        throw new Error("Vault resource metadata omitted fields or modification time");
      }
    }
    return `Installed IPC returned ${rows.length} metadata-only Vault resource row(s); identifiers were not retained.`;
  }
  const body = requireRecord(value, command);
  if (command === "debug_ui_snapshot") {
    requireRecord(body.panels, `${command}.panels`);
    for (const key of ["openTabs", "debugHighlights", "debugHighlightResults"]) {
      if (!Array.isArray(body[key])) throw new Error(`${command} omitted ${key}`);
    }
    return "Installed IPC returned renderer UI state with panel and bounded collection schemas.";
  }
  if (command === "desktop_integration_status") {
    for (const key of ["supported", "explorerContextMenuInstalled", "sendToShortcutInstalled"]) requireBoolean(body, key, command);
    requireString(body, "os", command);
    if (typeof body.message !== "string") throw new Error("desktop integration status omitted its message");
    return "Installed IPC returned the platform-specific desktop integration status schema.";
  }
  if (WINDOWS_DESKTOP_INTEGRATION_COMMANDS.has(command)) {
    const installed = command === "desktop_integration_install_windows_context_menu";
    verifyDesktopIntegrationStatus(body, installed, command);
    return installed
      ? "Installed IPC created both exact candidate-owned Explorer verbs and the SendTo shortcut under the receipt-bound disposable Windows user."
      : "Installed IPC removed both prepared candidate-owned Explorer verbs and the SendTo shortcut from the receipt-bound disposable Windows user.";
  }
  if (command === "get_bound_ports") {
    const expected = Number(new URL(request.runtime.debugBase).port);
    if (body.debugApi !== expected || (body.mcpHttp !== null && body.mcpHttp !== undefined && !Number.isSafeInteger(body.mcpHttp))) {
      throw new Error("bound ports did not identify the attested Debug API endpoint and optional MCP port");
    }
    return "Installed IPC returned the exact attested Debug API port and a typed optional MCP port.";
  }
  if (command === "host_skill_status") {
    requireBoolean(body, "installed", command);
    if (typeof body.path !== "string" || !/^[a-f0-9]{64}$/.test(String(body.body_hash))) {
      throw new Error("host skill status omitted its path or bundled body hash");
    }
    return "Installed IPC returned host-skill installation state and bundled hash; the path was not retained.";
  }
  if (command === "shellx_browser_state") {
    for (const key of ["profiles", "tabs", "bookmarks", "history", "tasks", "receipts"]) {
      if (!Array.isArray(body[key])) throw new Error(`Browser state omitted ${key}`);
    }
    requireBoolean(body, "windowOpen", command);
    requireRecord(body.engine, `${command}.engine`);
    return `Installed IPC returned Browser state with ${(body.tabs as unknown[]).length} tab(s), ${(body.tasks as unknown[]).length} task(s), and bounded typed collections.`;
  }
  if (command === "vault_status") {
    requireString(body, "mode", command);
    for (const key of ["unlocked", "recoveryConfirmed", "rememberedDeviceEnabled", "legacyVaultDetected", "syncPending"]) {
      requireBoolean(body, key, command);
    }
    for (const key of ["activeGrants", "pendingDeposits"]) {
      if (!Number.isSafeInteger(body[key]) || Number(body[key]) < 0) throw new Error(`Vault status returned an invalid ${key}`);
    }
    if (body.lastError !== null && body.lastError !== undefined && typeof body.lastError !== "string") {
      throw new Error("Vault status returned an invalid nullable error");
    }
    return "Installed IPC returned the redacted Vault health, lock, recovery, grant, and sync schema.";
  }
  throw new Error(`no result verifier exists for ${command}`);
}

async function prepareBrowserSettingMutationFixture(
  command: SupportedCommand,
  request: ReleaseSurfaceDriverRequest,
  webdriver: TauriCommandTransport,
): Promise<BrowserSettingMutationFixture> {
  if (!BROWSER_SETTING_MUTATION_COMMANDS.has(command)) throw new Error(`${command} is not a Browser setting mutation`);
  const state = requireRecord(
    await invokeTemporaryTauriCommand(webdriver, "shellx_browser_state", {}),
    `${command} Browser settings baseline`,
  );
  const profileRoot = profileRootForRequest(request);
  const settingsPath = nodeReadablePath(
    joinApiPath(profileRoot, [".shellx", "browser-settings.json"], request.platform),
    request.platform,
  );
  const settingsExisted = existsSync(settingsPath);
  const baseline = command === "shellx_browser_update_developer_mode"
    ? browserDeveloperModeValue(state.developerMode, `${command} baseline`)
    : command === "shellx_browser_update_shields"
      ? browserShieldsValue(state.shields, `${command} baseline`)
      : optionalStringValue(state.downloadFolder, `${command} baseline`);
  const settingsFile = {
    path: settingsPath,
    existed: settingsExisted,
    content: settingsExisted ? readFileSync(settingsPath) : null,
    mode: settingsExisted ? statSync(settingsPath).mode & 0o777 : null,
  };
  const downloadApiPath = command === "shellx_browser_update_download_folder"
    ? joinApiPath(profileRoot, ["final-surface-browser-downloads"], request.platform)
    : null;
  const downloadNodePath = downloadApiPath ? nodeReadablePath(downloadApiPath, request.platform) : null;
  if (downloadNodePath) {
    if (existsSync(downloadNodePath)) throw new Error("owned Browser download folder already existed");
    mkdirSync(downloadNodePath, { recursive: false, mode: 0o700 });
  }
  return {
    command: command as BrowserSettingMutationFixture["command"],
    baseline,
    settingsFile,
    downloadApiPath,
    downloadNodePath,
  };
}

async function verifyBrowserSettingMutation(
  command: SupportedCommand,
  value: unknown,
  webdriver: TauriCommandTransport,
  fixture: BrowserSettingMutationFixture,
): Promise<string> {
  const state = requireRecord(
    await invokeTemporaryTauriCommand(webdriver, "shellx_browser_state", {}),
    `${command} Browser state readback`,
  );
  if (command === "shellx_browser_update_developer_mode") {
    const expected = {
      enabled: true,
      fullCdpAccess: true,
      policyDisabled: false,
      approvedHosts: ["release.example.invalid"],
    };
    const body = requireRecord(value, command);
    requireExactJson(browserDeveloperModeValue(body.developerMode, `${command} result`), expected, `${command} result`);
    requireExactJson(browserDeveloperModeValue(state.developerMode, `${command} readback`), expected, `${command} readback`);
    return "Installed IPC changed Browser Developer Mode in the isolated candidate, read back every policy field, and restored the exact logical baseline.";
  }
  if (command === "shellx_browser_update_download_folder") {
    if (!fixture.downloadApiPath || value !== fixture.downloadApiPath || state.downloadFolder !== fixture.downloadApiPath) {
      throw new Error(`${command} did not return and read back the exact owned download folder`);
    }
    const persisted = readBrowserSettingsFixture(fixture.settingsFile.path, command);
    if (persisted.downloadFolder !== fixture.downloadApiPath) {
      throw new Error(`${command} did not persist the exact owned download folder`);
    }
    return "Installed IPC changed and persisted the isolated Browser download folder, read it back from runtime and disk, then restored the exact baseline.";
  }
  if (command === "shellx_browser_update_shields") {
    const expected = {
      enabled: false,
      adTrackerMode: "strict",
      cookieMode: "blockAll",
      fingerprintingMode: "strict",
      httpsUpgradeEnabled: false,
      scriptBlockingEnabled: true,
      siteOverrides: (browserShieldsValue(fixture.baseline, `${command} baseline`) as Json).siteOverrides,
    };
    const body = requireRecord(value, command);
    requireExactJson(browserShieldsValue(body.shields, `${command} result`), expected, `${command} result`);
    requireExactJson(browserShieldsValue(state.shields, `${command} readback`), expected, `${command} readback`);
    const runtimeApply = requireRecord(body.runtimeApply, `${command}.runtimeApply`);
    if (runtimeApply.ok !== true || runtimeApply.result !== null) {
      throw new Error(`${command} did not report its exact engine-idle runtime apply result`);
    }
    const persisted = readBrowserSettingsFixture(fixture.settingsFile.path, command);
    requireExactJson(browserShieldsValue(persisted.shields, `${command} persisted shields`), expected, `${command} persisted shields`);
    return "Installed IPC changed Browser Shields, proved the engine-idle runtime apply result plus runtime and disk readback, then restored the exact baseline.";
  }
  throw new Error(`${command} has no Browser setting mutation verifier`);
}

async function cleanupBrowserSettingMutationFixture(
  webdriver: TauriCommandTransport,
  fixture: BrowserSettingMutationFixture,
): Promise<void> {
  if (fixture.command === "shellx_browser_update_developer_mode") {
    const baseline = browserDeveloperModeValue(fixture.baseline, `${fixture.command} cleanup baseline`) as Json;
    await invokeTemporaryTauriCommand(webdriver, fixture.command, { request: baseline });
  } else if (fixture.command === "shellx_browser_update_download_folder") {
    await invokeTemporaryTauriCommand(webdriver, fixture.command, {
      request: { downloadFolder: fixture.baseline },
    });
  } else {
    const baseline = browserShieldsValue(fixture.baseline, `${fixture.command} cleanup baseline`) as Json;
    await invokeTemporaryTauriCommand(webdriver, fixture.command, { request: baseline });
  }
  const state = requireRecord(
    await invokeTemporaryTauriCommand(webdriver, "shellx_browser_state", {}),
    `${fixture.command} cleanup readback`,
  );
  const restored = fixture.command === "shellx_browser_update_developer_mode"
    ? browserDeveloperModeValue(state.developerMode, `${fixture.command} cleanup readback`)
    : fixture.command === "shellx_browser_update_shields"
      ? browserShieldsValue(state.shields, `${fixture.command} cleanup readback`)
      : optionalStringValue(state.downloadFolder, `${fixture.command} cleanup readback`);
  requireExactJson(restored, fixture.baseline, `${fixture.command} cleanup readback`);

  if (fixture.settingsFile.existed) {
    if (!fixture.settingsFile.content || fixture.settingsFile.mode === null) {
      throw new Error(`${fixture.command} settings snapshot was incomplete`);
    }
    writeFileSync(fixture.settingsFile.path, fixture.settingsFile.content);
    chmodSync(fixture.settingsFile.path, fixture.settingsFile.mode);
  } else if (existsSync(fixture.settingsFile.path)) {
    rmSync(fixture.settingsFile.path);
  }
  if (fixture.settingsFile.existed) {
    if (!existsSync(fixture.settingsFile.path)
      || !readFileSync(fixture.settingsFile.path).equals(fixture.settingsFile.content!)) {
      throw new Error(`${fixture.command} did not restore the exact Browser settings file`);
    }
  } else if (existsSync(fixture.settingsFile.path)) {
    throw new Error(`${fixture.command} left a Browser settings file behind`);
  }
  if (fixture.downloadNodePath && existsSync(fixture.downloadNodePath)) rmdirSync(fixture.downloadNodePath);
  if (fixture.downloadNodePath && existsSync(fixture.downloadNodePath)) {
    throw new Error(`${fixture.command} left its owned download folder behind`);
  }
}

function browserDeveloperModeValue(value: unknown, label: string): Json {
  const body = requireRecord(value, label);
  const approvedHosts = requireArray(body.approvedHosts, `${label}.approvedHosts`);
  if (approvedHosts.some((host) => typeof host !== "string")) throw new Error(`${label} approvedHosts was not a string array`);
  for (const key of ["enabled", "fullCdpAccess", "policyDisabled"]) requireBoolean(body, key, label);
  return {
    enabled: body.enabled,
    fullCdpAccess: body.fullCdpAccess,
    policyDisabled: body.policyDisabled,
    approvedHosts: [...approvedHosts],
  };
}

function browserShieldsValue(value: unknown, label: string): Json {
  const body = requireRecord(value, label);
  for (const key of ["enabled", "httpsUpgradeEnabled", "scriptBlockingEnabled"]) requireBoolean(body, key, label);
  for (const key of ["adTrackerMode", "cookieMode", "fingerprintingMode"]) requireString(body, key, label);
  const siteOverrides = requireArray(body.siteOverrides, `${label}.siteOverrides`);
  return {
    enabled: body.enabled,
    adTrackerMode: body.adTrackerMode,
    cookieMode: body.cookieMode,
    fingerprintingMode: body.fingerprintingMode,
    httpsUpgradeEnabled: body.httpsUpgradeEnabled,
    scriptBlockingEnabled: body.scriptBlockingEnabled,
    siteOverrides,
  };
}

function optionalStringValue(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} was not a nullable non-empty string`);
  return value;
}

function readBrowserSettingsFixture(path: string, label: string): Json {
  if (!existsSync(path)) throw new Error(`${label} did not create the Browser settings file`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return requireRecord(parsed, `${label} Browser settings file`);
}

async function prepareUserDataMutation(
  webdriver: TauriCommandTransport,
  command: SupportedCommand,
): Promise<void> {
  const baseline = requireRecord(
    await invokeTemporaryTauriCommand(webdriver, "read_user_data", {}),
    "isolated user-data baseline",
  );
  if (Object.keys(baseline).length !== 0) {
    throw new Error("isolated release profile did not start with an empty user-data store");
  }
  if (command === "delete_user_data_section") {
    const prepared = await invokeTemporaryTauriCommand(
      webdriver,
      "write_user_data",
      { data: userDataDeleteFixture() },
    );
    requireVoidResult(prepared, "delete_user_data_section setup");
  }
}

function profileRootForRequest(request: ReleaseSurfaceDriverRequest): string {
  return releaseSurfaceProfileLaunchRootFromDebugTokenPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
}

function prepareVaultMutationFixture(
  command: SupportedCommand,
  request: ReleaseSurfaceDriverRequest,
): VaultMutationFixture {
  return {
    command,
    key: `release/surface/${request.sourceCommit.slice(0, 16)}/${command}`,
    value: `SHELLX_RELEASE_VAULT_${request.sourceCommit.slice(0, 16)}_${command}`,
  };
}

async function prepareVaultMutation(
  webdriver: TauriCommandTransport,
  fixture: VaultMutationFixture,
): Promise<void> {
  const baseline = await invokeTemporaryTauriCommand(webdriver, "vault_get", { key: fixture.key });
  if (baseline !== null) throw new Error(`${fixture.command} owned Vault key already existed`);
  if (new Set<SupportedCommand>([
    "vault_delete",
    "vault_get",
    "vault_update_metadata",
    "vault_update_resource_metadata",
  ]).has(fixture.command)) {
    requireVoidResult(await invokeTemporaryTauriCommand(webdriver, "vault_set", {
      key: fixture.key,
      value: fixture.value,
      description: null,
      userOnly: null,
      resourceKind: null,
      resourceSummary: null,
      resourceProvider: null,
      resourceFields: null,
    }), `${fixture.command} Vault setup`);
  }
}

function vaultMutationArgs(fixture: VaultMutationFixture): Json {
  if (fixture.command === "vault_get" || fixture.command === "vault_delete") {
    return { key: fixture.key };
  }
  if (fixture.command === "vault_set") {
    return {
      key: fixture.key,
      value: fixture.value,
      description: null,
      userOnly: null,
      resourceKind: null,
      resourceSummary: null,
      resourceProvider: null,
      resourceFields: null,
    };
  }
  if (fixture.command === "vault_set_resource") {
    return {
      key: fixture.key,
      value: fixture.value,
      description: "Final surface profile resource",
      userOnly: false,
      resourceKind: "profileCard",
      resourceSummary: "Owned release validation profile",
      resourceProvider: "shellx-release",
      resourceFields: ["displayName", "timezone"],
    };
  }
  if (fixture.command === "vault_update_metadata") {
    return {
      key: fixture.key,
      description: "Final surface updated metadata",
      userOnly: true,
    };
  }
  if (fixture.command === "vault_update_resource_metadata") {
    return {
      key: fixture.key,
      description: "Final surface updated resource",
      userOnly: false,
      resourceKind: "profileCard",
      resourceSummary: "Updated owned release profile",
      resourceProvider: "shellx-release-updated",
      resourceFields: ["displayName", "locale"],
    };
  }
  throw new Error(`missing Vault mutation arguments for ${fixture.command}`);
}

async function verifyVaultMutation(
  command: SupportedCommand,
  value: unknown,
  webdriver: TauriCommandTransport,
  fixture: VaultMutationFixture,
): Promise<string> {
  if (command === "vault_get") {
    if (value !== fixture.value) throw new Error("vault_get did not return the exact owned secret");
  } else {
    requireVoidResult(value, command);
  }
  const current = await invokeTemporaryTauriCommand(webdriver, "vault_get", { key: fixture.key });
  if (command === "vault_delete") {
    if (current !== null) throw new Error("vault_delete left the owned secret present");
    return "Installed IPC deleted exactly one prepared secret from the isolated compatibility Vault and read back its absence.";
  }
  if (current !== fixture.value) throw new Error(`${command} did not preserve the exact owned Vault value`);
  const rows = requireArray(
    await invokeTemporaryTauriCommand(webdriver, "vault_list_keys_with_meta", {}),
    `${command} metadata readback`,
  );
  const metadata = rows.map((row) => requireRecord(row, `${command} metadata row`))
    .find((row) => row.key === fixture.key);
  if (!metadata) throw new Error(`${command} omitted the owned Vault metadata row`);
  if (command === "vault_set_resource") {
    requireExactJson(metadata, {
      key: fixture.key,
      description: "Final surface profile resource",
      userOnly: false,
      resourceKind: "profileCard",
      resourceSummary: "Owned release validation profile",
      resourceProvider: "shellx-release",
      resourceFields: ["displayName", "timezone"],
      lastModifiedMs: 0,
    }, `${command} metadata`);
  } else if (command === "vault_update_metadata") {
    if (metadata.description !== "Final surface updated metadata"
      || metadata.userOnly !== true || metadata.resourceKind !== "secret") {
      throw new Error("vault_update_metadata did not apply the exact owned metadata");
    }
  } else if (command === "vault_update_resource_metadata") {
    if (metadata.description !== "Final surface updated resource"
      || metadata.userOnly !== false
      || metadata.resourceKind !== "profileCard"
      || metadata.resourceSummary !== "Updated owned release profile"
      || metadata.resourceProvider !== "shellx-release-updated"
      || stableJson(metadata.resourceFields) !== stableJson(["displayName", "locale"])) {
      throw new Error("vault_update_resource_metadata did not apply the exact owned resource metadata");
    }
  }
  return `Installed IPC ${command} completed its exact owned compatibility-Vault lifecycle and retained no key or value after cleanup.`;
}

async function cleanupVaultMutation(
  webdriver: TauriCommandTransport,
  fixture: VaultMutationFixture,
): Promise<void> {
  requireVoidResult(
    await invokeTemporaryTauriCommand(webdriver, "vault_delete", { key: fixture.key }),
    `${fixture.command} Vault cleanup`,
  );
  if (await invokeTemporaryTauriCommand(webdriver, "vault_get", { key: fixture.key }) !== null) {
    throw new Error(`${fixture.command} owned Vault key remained after cleanup`);
  }
  const rows = requireArray(
    await invokeTemporaryTauriCommand(webdriver, "vault_list_keys_with_meta", {}),
    `${fixture.command} Vault cleanup metadata`,
  );
  if (rows.some((row) => requireRecord(row, "Vault cleanup row").key === fixture.key)) {
    throw new Error(`${fixture.command} owned Vault metadata remained after cleanup`);
  }
}

function prepareVaultAgentStateFixture(request: ReleaseSurfaceDriverRequest): VaultAgentStateFixture {
  const directory = nodeReadablePath(
    joinApiPath(profileRootForRequest(request), ["vault-e2e"], request.platform),
    request.platform,
  );
  const directoryExisted = existsSync(directory);
  const paths = [join(directory, "agent-state.json"), join(directory, "agent-state.lock")];
  return {
    directory,
    directoryExisted,
    files: paths.map((path) => {
      const existed = existsSync(path);
      return {
        path,
        existed,
        content: existed ? readFileSync(path) : null,
        mode: existed ? statSync(path).mode & 0o777 : null,
      };
    }),
  };
}

function cleanupVaultAgentStateFixture(fixture: VaultAgentStateFixture): string | null {
  try {
    for (const file of fixture.files) {
      if (file.existed) {
        if (!file.content || file.mode === null) return "Vault agent-state snapshot was incomplete";
        mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 });
        writeFileSync(file.path, file.content, { flag: "w", mode: file.mode });
        if (process.platform !== "win32") chmodSync(file.path, file.mode);
      } else if (existsSync(file.path)) {
        rmSync(file.path);
      }
    }
    if (!fixture.directoryExisted && existsSync(fixture.directory)) rmdirSync(fixture.directory);
    for (const file of fixture.files) {
      if (file.existed) {
        if (!file.content || !existsSync(file.path) || !readFileSync(file.path).equals(file.content)) {
          return "Vault agent-state file was not restored exactly";
        }
      } else if (existsSync(file.path)) {
        return "Vault agent-state cleanup left a newly created file";
      }
    }
    if (!fixture.directoryExisted && existsSync(fixture.directory)) {
      return "Vault agent-state cleanup left a newly created profile directory";
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function prepareScreenshotFixture(request: ReleaseSurfaceDriverRequest): ScreenshotFixture {
  const profileRoot = profileRootForRequest(request);
  const apiParent = joinApiPath(profileRoot, [".grok"], request.platform);
  const apiRoot = joinApiPath(apiParent, ["shellx-screenshots"], request.platform);
  const parentNodeRoot = nodeReadablePath(apiParent, request.platform);
  const nodeRoot = nodeReadablePath(apiRoot, request.platform);
  if (existsSync(nodeRoot)) throw new Error("owned screenshot directory already existed");
  return {
    platform: request.platform,
    nodeRoot,
    parentNodeRoot,
    parentExisted: existsSync(parentNodeRoot),
    outputNodePath: null,
  };
}

function verifyScreenshotResult(value: unknown, fixture: ScreenshotFixture): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("screenshot capture returned no path");
  const output = nodeReadablePath(value, fixture.platform);
  if (dirname(output) !== resolve(fixture.nodeRoot)
    || !/^shellx-screenshot-[0-9]+\.png$/.test(basename(output))) {
    throw new Error("screenshot capture escaped its owned directory or returned an invalid name");
  }
  const bytes = readFileSync(output);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < signature.length || bytes.length > 16 * 1024 * 1024
    || !bytes.subarray(0, signature.length).equals(signature)) {
    throw new Error("screenshot capture did not write a bounded PNG");
  }
  fixture.outputNodePath = output;
  return "Installed IPC captured the isolated candidate as a bounded PNG, verified its signature, and retained neither its path nor bytes.";
}

function cleanupScreenshotFixture(fixture: ScreenshotFixture): string | null {
  try {
    if (existsSync(fixture.nodeRoot)) rmSync(fixture.nodeRoot, { recursive: true });
    if (!fixture.parentExisted && existsSync(fixture.parentNodeRoot)) rmdirSync(fixture.parentNodeRoot);
    if (existsSync(fixture.nodeRoot) || (fixture.outputNodePath && existsSync(fixture.outputNodePath))) {
      return "owned screenshot fixture remained after cleanup";
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function prepareTokenRotationFixture(request: ReleaseSurfaceDriverRequest): TokenRotationFixture {
  const nodePath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const stat = statSync(nodePath);
  return { nodePath, original: readFileSync(nodePath), mode: stat.mode & 0o777, generated: null };
}

function verifyTokenRotationResult(value: unknown, fixture: TokenRotationFixture): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) {
    throw new Error("shellxagent token regeneration did not return a 128-bit hexadecimal token");
  }
  if (Buffer.from(value).equals(Buffer.from(fixture.original.toString("utf8").trim()))) {
    throw new Error("shellxagent token regeneration did not rotate the original token");
  }
  if (readFileSync(fixture.nodePath, "utf8").trim() !== value) {
    throw new Error("shellxagent token regeneration did not atomically persist its return value");
  }
  fixture.generated = value;
  return "Installed IPC rotated the isolated candidate token to a fresh 128-bit value, proved disk/readback agreement, and restored the original token without retaining either value.";
}

function cleanupTokenRotationFixture(fixture: TokenRotationFixture): string | null {
  try {
    writeFileSync(fixture.nodePath, fixture.original, { flag: "w", mode: fixture.mode });
    if (process.platform !== "win32") chmodSync(fixture.nodePath, fixture.mode);
    if (!readFileSync(fixture.nodePath).equals(fixture.original)) {
      return "original shellxagent token was not restored exactly";
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function prepareGitMutationFixture(request: ReleaseSurfaceDriverRequest): GitMutationFixture {
  const profileRoot = profileRootForRequest(request);
  const checkpointRoot = nodeReadablePath(
    joinApiPath(profileRoot, [".shellx", "git-checkpoints"], request.platform),
    request.platform,
  );
  const checkpointRootExisted = existsSync(checkpointRoot);
  if (checkpointRootExisted) throw new Error("isolated candidate unexpectedly contained Git checkpoints");
  return { checkpointRoot, checkpointRootExisted, checkpointPath: null, worktreePath: null };
}

function verifyGitMutation(
  command: SupportedCommand,
  value: unknown,
  request: ReleaseSurfaceDriverRequest,
  fixture: DebugApiGitFixture,
  mutation: GitMutationFixture,
): string {
  const body = requireRecord(value, command);
  if (body.ok !== true || body.lastError !== null) throw new Error(`${command} did not report exact success`);
  if (command === "git_session_create_checkpoint") {
    const checkpoint = requireRecord(body.checkpoint, `${command}.checkpoint`);
    const path = nodeReadablePath(requireStringValue(checkpoint, "path", command), request.platform);
    if (!resolve(path).startsWith(`${resolve(mutation.checkpointRoot)}${process.platform === "win32" ? "\\" : "/"}`)
      || checkpoint.label !== "Final surface checkpoint"
      || checkpoint.branch !== "release-proof"
      || checkpoint.staged !== 0 || checkpoint.unstaged !== 1 || checkpoint.untracked !== 1
      || !existsSync(join(path, "checkpoint.json"))
      || !existsSync(join(path, "unstaged.patch"))
      || !existsSync(join(path, "untracked.json"))) {
      throw new Error("Git checkpoint omitted its exact owned dirty-repository snapshot");
    }
    mutation.checkpointPath = path;
    return "Installed IPC created and verified one complete checkpoint of an owned dirty repository, then removed the checkpoint and repository.";
  }
  const path = nodeReadablePath(requireStringValue(body, "worktreePath", command), request.platform);
  const expected = resolve(fixture.localPath, ".worktrees", "final-surface-worktree");
  if (resolve(path) !== expected || body.sourceBranch !== "release-proof"
    || body.newBranch !== "final-surface-worktree" || !existsSync(path)) {
    throw new Error("Git worktree creation omitted its exact owned branch or canonical nested path");
  }
  mutation.worktreePath = path;
  return "Installed IPC created one exact nested worktree and branch inside an owned repository, then removed the whole disposable repository.";
}

function cleanupGitMutationFixture(fixture: GitMutationFixture): string | null {
  try {
    if (!fixture.checkpointRootExisted && existsSync(fixture.checkpointRoot)) {
      rmSync(fixture.checkpointRoot, { recursive: true });
    } else if (fixture.checkpointPath && existsSync(fixture.checkpointPath)) {
      rmSync(fixture.checkpointPath, { recursive: true });
    }
    if (!fixture.checkpointRootExisted && existsSync(fixture.checkpointRoot)) {
      return "owned Git checkpoint root remained after cleanup";
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function prepareMarketplaceMutationFixture(request: ReleaseSurfaceDriverRequest): MarketplaceMutationFixture {
  const profileRoot = profileRootForRequest(request);
  const shellxDir = nodeReadablePath(joinApiPath(profileRoot, [".shellx"], request.platform), request.platform);
  const grokDir = nodeReadablePath(joinApiPath(profileRoot, [".grok"], request.platform), request.platform);
  const paths = [join(shellxDir, "mcp-marketplace.json"), join(grokDir, "config.toml")];
  return {
    id: "context7",
    files: paths.map((path) => {
      const existed = existsSync(path);
      return {
        path,
        existed,
        content: existed ? readFileSync(path) : null,
        mode: existed ? statSync(path).mode & 0o777 : null,
      };
    }),
    removableParents: [grokDir],
  };
}

async function prepareMarketplaceUninstall(
  webdriver: TauriCommandTransport,
  fixture: MarketplaceMutationFixture,
): Promise<void> {
  const before = verifyMarketplaceRows(
    await invokeTemporaryTauriCommand(webdriver, "mcp_marketplace_list", {}),
    "marketplace uninstall baseline",
  ).map((row) => requireRecord(row, "marketplace baseline row"))
    .find((row) => row.id === fixture.id);
  if (!before || before.installed !== false) throw new Error("isolated marketplace entry was not initially absent");
  requireVoidResult(
    await invokeTemporaryTauriCommand(webdriver, "mcp_marketplace_install", { id: fixture.id }),
    "marketplace uninstall setup",
  );
  const installed = verifyMarketplaceRows(
    await invokeTemporaryTauriCommand(webdriver, "mcp_marketplace_list", {}),
    "marketplace uninstall setup readback",
  ).map((row) => requireRecord(row, "marketplace setup row"))
    .find((row) => row.id === fixture.id);
  if (!installed || installed.installed !== true) throw new Error("marketplace uninstall setup did not install the owned entry");
}

async function cleanupMarketplaceMutation(
  webdriver: TauriCommandTransport,
  fixture: MarketplaceMutationFixture,
): Promise<void> {
  for (const file of fixture.files) {
    if (file.existed) {
      if (!file.content || file.mode === null) throw new Error("marketplace snapshot was incomplete");
      mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 });
      writeFileSync(file.path, file.content, { flag: "w", mode: file.mode });
      if (process.platform !== "win32") chmodSync(file.path, file.mode);
    } else if (existsSync(file.path)) {
      rmSync(file.path);
    }
  }
  for (const parent of fixture.removableParents) {
    if (existsSync(parent)) {
      try { rmdirSync(parent); } catch { /* The candidate may own other .grok state. */ }
    }
  }
  const restored = verifyMarketplaceRows(
    await invokeTemporaryTauriCommand(webdriver, "mcp_marketplace_list", {}),
    "marketplace restored baseline",
  ).map((row) => requireRecord(row, "marketplace restored row"))
    .find((row) => row.id === fixture.id);
  if (!restored || restored.installed !== false) throw new Error("marketplace baseline was not restored");
  for (const file of fixture.files) {
    if (file.existed) {
      if (!existsSync(file.path) || !file.content || !readFileSync(file.path).equals(file.content)) {
        throw new Error("marketplace persisted file was not restored exactly");
      }
    } else if (existsSync(file.path)) {
      throw new Error("marketplace cleanup left a newly created persisted file");
    }
  }
}

function prepareFileMutationFixture(
  command: SupportedCommand,
  request: ReleaseSurfaceDriverRequest,
): FileMutationFixture {
  const profileRoot = releaseSurfaceProfileLaunchRootFromDebugTokenPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
  const parts = command === "shellx_browser_copy_local_artifact"
    ? [".shellx", "browser-artifacts", "shellx-browser-traces", "final-surface-owned-copy"]
    : ["final-surface-files", command];
  const apiRoot = joinApiPath(profileRoot, parts, request.platform);
  const nodeRoot = nodeReadablePath(apiRoot, request.platform);
  const parentNodeRoot = command === "shellx_browser_copy_local_artifact"
    ? null
    : nodeReadablePath(joinApiPath(profileRoot, ["final-surface-files"], request.platform), request.platform);
  if (existsSync(nodeRoot)) throw new Error(`${command} owned file fixture already exists`);
  const apiDestination = joinApiPath(apiRoot, ["destination"], request.platform);
  const nodeDestination = nodeReadablePath(apiDestination, request.platform);
  mkdirSync(nodeDestination, { recursive: true, mode: 0o700 });
  const needsSource = command === "copy_asset_to_scope"
    || command === "copy_to_scope"
    || command === "shellx_browser_copy_local_artifact";
  const apiSource = needsSource ? joinApiPath(apiRoot, ["source.txt"], request.platform) : null;
  const nodeSource = apiSource ? nodeReadablePath(apiSource, request.platform) : null;
  const content = `SHELLX_RELEASE_FILE_${request.sourceCommit.slice(0, 16)}_${command}`;
  if (nodeSource) writeFileSync(nodeSource, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return {
    command,
    platform: request.platform,
    apiRoot,
    nodeRoot,
    parentNodeRoot,
    apiDestination,
    nodeDestination,
    apiSource,
    nodeSource,
    content,
    outputNodePath: null,
  };
}

function verifyFileMutation(
  command: SupportedCommand,
  value: unknown,
  fixture: FileMutationFixture,
): string {
  let outputPath: string;
  if (command === "copy_asset_to_scope" || command === "copy_to_scope" || command === "save_dropped_attachment_to_scope") {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${command} returned no output path`);
    outputPath = value;
  } else {
    const body = requireRecord(value, command);
    outputPath = requireStringValue(body, "finalPath", command);
    const expectedName = command === "shellx_browser_copy_local_artifact"
      ? "final-surface-browser-copy.txt"
      : "final-surface-browser-write.txt";
    if (body.displayName !== expectedName || body.mimeType !== "text/plain") {
      throw new Error(`${command} returned the wrong bounded artifact identity`);
    }
    const expectedBytes = Buffer.byteLength(fixture.content);
    const expectedSha = createHash("sha256").update(fixture.content).digest("hex");
    if (body.bytes !== expectedBytes || body.sha256 !== expectedSha) {
      throw new Error(`${command} returned the wrong artifact bytes or digest`);
    }
  }
  const nodeOutput = nodeReadablePath(outputPath, fixture.platform);
  if (!resolve(nodeOutput).startsWith(`${resolve(fixture.nodeDestination)}${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`${command} output escaped its exact owned destination`);
  }
  if (readFileSync(nodeOutput, "utf8") !== fixture.content) {
    throw new Error(`${command} output did not preserve the exact owned content`);
  }
  fixture.outputNodePath = nodeOutput;
  return `Installed IPC ${command} wrote the exact owned bytes under the isolated profile, returned its bounded identity, and left no file after cleanup.`;
}

function cleanupFileMutationFixture(fixture: FileMutationFixture): string | null {
  try {
    rmSync(fixture.nodeRoot, { recursive: true, force: true });
    if (fixture.parentNodeRoot && existsSync(fixture.parentNodeRoot)) rmdirSync(fixture.parentNodeRoot);
    if (existsSync(fixture.nodeRoot)) return `${fixture.command} owned file fixture remained after cleanup`;
    if (fixture.outputNodePath && existsSync(fixture.outputNodePath)) {
      return `${fixture.command} output file remained after cleanup`;
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function joinApiPath(rootPath: string, parts: string[], platform: ReleaseSurfaceDriverRequest["platform"]): string {
  const separator = platform === "windows-installed" ? "\\" : "/";
  return `${rootPath.replace(/[\\/]+$/, "")}${separator}${parts.join(separator)}`;
}

function localConnectionPreset(id: string): Json {
  return {
    id,
    label: id ? "Final surface local connection" : "Final local runtime",
    transport: { kind: "local" },
    createdMs: 0,
    lastUsedMs: 0,
    providerScan: [],
  };
}

function outsideConnectorFixture(): Json {
  return {
    id: OWNED_OUTSIDE_CONNECTOR_ID,
    label: "Final surface inert connector",
    enabled: false,
    provider: {
      kind: "telegram",
      botTokenVaultKey: "final-surface-unused-vault-reference",
      allowedChatIds: [],
    },
    target: { mode: "activeTab" },
    dispatchMode: "inbox",
    requireApproval: true,
    createdMs: 0,
    updatedMs: 0,
    lastTestMs: null,
    lastError: null,
  };
}

async function prepareConnectionDelete(
  webdriver: TauriCommandTransport,
): Promise<void> {
  await cleanupConnectionMutation(webdriver);
  const saved = requireRecord(
    await invokeTemporaryTauriCommand(webdriver, "connections_save", { preset: localConnectionPreset(OWNED_CONNECTION_ID) }),
    "connection delete setup",
  );
  if (saved.id !== OWNED_CONNECTION_ID) throw new Error("connection delete setup did not preserve the owned id");
}

async function cleanupConnectionMutation(
  webdriver: TauriCommandTransport,
): Promise<void> {
  const removed = await invokeTemporaryTauriCommand(webdriver, "connections_delete", { id: OWNED_CONNECTION_ID });
  if (typeof removed !== "boolean") throw new Error("connection cleanup returned a non-boolean result");
  const rows = requireArray(await invokeTemporaryTauriCommand(webdriver, "connections_list", {}), "connection cleanup list");
  if (rows.some((row) => requireRecord(row, "connection cleanup row").id === OWNED_CONNECTION_ID)) {
    throw new Error("owned connection remained after cleanup");
  }
}

async function verifyConnectionMutation(
  command: SupportedCommand,
  value: unknown,
  webdriver: TauriCommandTransport,
): Promise<string> {
  if (command === "connections_save") {
    const saved = requireRecord(value, command);
    if (saved.id !== OWNED_CONNECTION_ID || saved.label !== "Final surface local connection") {
      throw new Error("connections_save did not return the exact owned preset identity");
    }
    requireExactJson(saved.transport, { kind: "local" }, command);
    const rows = requireArray(await invokeTemporaryTauriCommand(webdriver, "connections_list", {}), `${command} readback`);
    if (!rows.some((row) => requireRecord(row, `${command} row`).id === OWNED_CONNECTION_ID)) {
      throw new Error("connections_save readback omitted the owned preset");
    }
    return "Installed IPC saved and read back exactly one owned local connection preset before deleting it from the isolated profile.";
  }
  if (value !== true) throw new Error("connections_delete did not remove its prepared owned preset");
  const rows = requireArray(await invokeTemporaryTauriCommand(webdriver, "connections_list", {}), `${command} readback`);
  if (rows.some((row) => requireRecord(row, `${command} row`).id === OWNED_CONNECTION_ID)) {
    throw new Error("connections_delete readback still contained the owned preset");
  }
  return "Installed IPC deleted exactly its prepared owned connection preset and proved it absent from the isolated profile.";
}

async function prepareOutsideConnectorDelete(
  webdriver: TauriCommandTransport,
): Promise<void> {
  await cleanupOutsideConnectorMutation(webdriver);
  const saved = requireRecord(
    await invokeTemporaryTauriCommand(webdriver, "outside_connectors_save", { connector: outsideConnectorFixture() }),
    "outside connector delete setup",
  );
  if (saved.id !== OWNED_OUTSIDE_CONNECTOR_ID || saved.enabled !== false) {
    throw new Error("outside connector delete setup did not preserve the owned inert connector");
  }
}

async function cleanupOutsideConnectorMutation(
  webdriver: TauriCommandTransport,
): Promise<void> {
  const removed = await invokeTemporaryTauriCommand(
    webdriver,
    "outside_connectors_delete",
    { id: OWNED_OUTSIDE_CONNECTOR_ID },
  );
  if (typeof removed !== "boolean") throw new Error("outside connector cleanup returned a non-boolean result");
  const rows = requireArray(
    await invokeTemporaryTauriCommand(webdriver, "outside_connectors_list", {}),
    "outside connector cleanup list",
  );
  if (rows.some((row) => requireRecord(row, "outside connector cleanup row").id === OWNED_OUTSIDE_CONNECTOR_ID)) {
    throw new Error("owned outside connector remained after cleanup");
  }
}

async function verifyOutsideConnectorMutation(
  command: SupportedCommand,
  value: unknown,
  webdriver: TauriCommandTransport,
): Promise<string> {
  if (command === "outside_connectors_save") {
    const saved = requireRecord(value, command);
    if (saved.id !== OWNED_OUTSIDE_CONNECTOR_ID || saved.label !== "Final surface inert connector" || saved.enabled !== false) {
      throw new Error("outside_connectors_save did not return the exact owned inert connector");
    }
    const rows = requireArray(
      await invokeTemporaryTauriCommand(webdriver, "outside_connectors_list", {}),
      `${command} readback`,
    );
    if (!rows.some((row) => requireRecord(row, `${command} row`).id === OWNED_OUTSIDE_CONNECTOR_ID)) {
      throw new Error("outside_connectors_save readback omitted the owned inert connector");
    }
    return "Installed IPC saved and read back exactly one disabled, network-inert outside connector before deleting it from the isolated profile.";
  }
  if (value !== true) throw new Error("outside_connectors_delete did not remove its prepared owned connector");
  const rows = requireArray(
    await invokeTemporaryTauriCommand(webdriver, "outside_connectors_list", {}),
    `${command} readback`,
  );
  if (rows.some((row) => requireRecord(row, `${command} row`).id === OWNED_OUTSIDE_CONNECTOR_ID)) {
    throw new Error("outside_connectors_delete readback still contained the owned connector");
  }
  return "Installed IPC deleted exactly its prepared disabled outside connector and proved it absent from the isolated profile.";
}

async function cleanupUserDataMutation(
  webdriver: TauriCommandTransport,
): Promise<void> {
  requireVoidResult(
    await invokeTemporaryTauriCommand(webdriver, "write_user_data", { data: {} }),
    "user-data cleanup",
  );
  const after = requireRecord(
    await invokeTemporaryTauriCommand(webdriver, "read_user_data", {}),
    "user-data cleanup readback",
  );
  if (Object.keys(after).length !== 0) throw new Error("isolated user-data store was not restored to empty");
}

async function verifyUserDataMutation(
  command: SupportedCommand,
  value: unknown,
  request: ReleaseSurfaceDriverRequest,
  webdriver: TauriCommandTransport,
): Promise<string> {
  if (command === "write_user_data") {
    requireVoidResult(value, command);
    const observed = await invokeTemporaryTauriCommand(webdriver, "read_user_data", {});
    requireExactJson(observed, userDataWrittenFixture(request), command);
    return "Installed IPC wrote and read back the exact owned user-data object before restoring the isolated store to empty; content was not retained.";
  }
  if (command === "delete_user_data_section") {
    if (value !== true) throw new Error("delete_user_data_section did not remove its exact prepared key");
    const observed = await invokeTemporaryTauriCommand(webdriver, "read_user_data", {});
    requireExactJson(observed, { releaseSurfacePreservedFixture: userDataPreservedValue() }, command);
    return "Installed IPC removed exactly one prepared user-data section, preserved its sibling, and then restored the isolated store to empty; content was not retained.";
  }
  throw new Error(`${command} is not a user-data mutation`);
}

async function verifySessionHistoryMutation(
  command: SupportedCommand,
  value: unknown,
  request: ReleaseSurfaceDriverRequest,
  webdriver: TauriCommandTransport,
  fixture: DebugApiSessionFixture | null,
): Promise<string> {
  if (!fixture) throw new Error("owned session-history mutation fixture is unavailable");
  if (command === "delete_session_files") {
    if (!Array.isArray(value) || value.length !== 1 || value[0] !== fixture.id) {
      throw new Error("delete_session_files did not report exactly its prepared session identifier");
    }
    const after = await invokeTemporaryTauriCommand(
      webdriver,
      "read_session_jsonl",
      { sessionId: fixture.id },
    );
    if (!Array.isArray(after) || after.length !== 0) {
      throw new Error("deleted session history remained readable through installed IPC");
    }
    return "Installed IPC deleted exactly one owned session-history file and confirmed it was no longer readable; identity and content were not retained.";
  }

  requireVoidResult(value, command);
  const observed = await invokeTemporaryTauriCommand(
    webdriver,
    "read_session_jsonl",
    { sessionId: fixture.id },
  );
  if (!Array.isArray(observed) || observed.length !== 4 || observed.some((line) => typeof line !== "string")) {
    throw new Error(`${command} did not produce the exact four-record owned history`);
  }
  const last = requireRecord(JSON.parse(String(observed[3])), `${command} appended record`);
  if (command === "append_session_log") {
    requireExactJson(last, sessionAppendRecord(request), command);
    return "Installed IPC appended exactly one owned JSONL record and read back the four-record history before deleting it; content was not retained.";
  }
  if (command === "rename_past_session") {
    const payload = requireRecord(last.payload, `${command}.payload`);
    const meta = requireRecord(payload._meta, `${command}.payload._meta`);
    if (!Number.isSafeInteger(last.t)
      || last.kind !== "ui"
      || meta.kind !== "title-override"
      || payload.title !== sessionRenameTitle(request)) {
      throw new Error("rename_past_session did not append the exact title override record");
    }
    return "Installed IPC appended the exact owned title override to a disposable session and read it back before deletion; title and identity were not retained.";
  }
  throw new Error(`${command} is not a session-history mutation`);
}

function prepareGoalFixture(command: SupportedCommand, request: ReleaseSurfaceDriverRequest): GoalFixture {
  const cwd = releaseSurfaceProfileLaunchRootFromDebugTokenPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
  const apiGoalPath = request.platform === "windows-installed"
    ? `${cwd.replace(/[\\/]+$/, "")}\\goal.md`
    : join(cwd, "goal.md");
  const nodeGoalPath = nodeReadablePath(apiGoalPath, request.platform);
  if (existsSync(nodeGoalPath)) {
    throw new Error("isolated release profile unexpectedly already contained goal.md");
  }
  return {
    tabId: `final-surface-goal-${command.replaceAll("_", "-")}`,
    cwd,
    apiGoalPath,
    nodeGoalPath,
    objective: `Release surface ${command} ${request.sourceCommit.slice(0, 16)}`,
  };
}

async function prepareGoalState(
  webdriver: TauriCommandTransport,
  command: SupportedCommand,
  fixture: GoalFixture,
): Promise<void> {
  requireVoidResult(
    await invokeTemporaryTauriCommand(webdriver, "set_goal_mode", goalModeArgs(fixture, true)),
    `${command} goal setup`,
  );
  if (command === "resume_goal") {
    requireVoidResult(
      await invokeTemporaryTauriCommand(webdriver, "pause_goal", { tabId: fixture.tabId }),
      "resume_goal pause setup",
    );
  }
}

async function cleanupGoalState(
  webdriver: TauriCommandTransport,
  fixture: GoalFixture,
): Promise<void> {
  requireVoidResult(
    await invokeTemporaryTauriCommand(webdriver, "set_goal_mode", goalModeArgs(fixture, false)),
    "goal-state cleanup",
  );
  const after = await invokeTemporaryTauriCommand(
    webdriver,
    "get_goal_state",
    { tabId: fixture.tabId },
  );
  if (after !== null) throw new Error("owned goal-state slot remained after cleanup");
  if (existsSync(fixture.nodeGoalPath)) rmSync(fixture.nodeGoalPath);
  if (existsSync(fixture.nodeGoalPath)) throw new Error("owned goal.md remained after cleanup");
}

async function verifyGoalCommand(
  command: SupportedCommand,
  value: unknown,
  webdriver: TauriCommandTransport,
  fixture: GoalFixture,
): Promise<string> {
  if (command === "reject_goal_plan") {
    if (value !== true) throw new Error("reject_goal_plan did not reject its prepared goal");
  } else {
    requireVoidResult(value, command);
  }
  const observed = await invokeTemporaryTauriCommand(
    webdriver,
    "get_goal_state",
    { tabId: fixture.tabId },
  );
  if (command === "reject_goal_plan") {
    if (observed !== null) throw new Error("rejected goal state remained active");
    return "Installed IPC rejected and cleared the exact owned goal state before deleting its disposable scratchboard.";
  }
  const state = requireRecord(observed, `${command} goal state`);
  const expectedActive = command !== "mark_goal_complete";
  const expectedPaused = command === "pause_goal";
  if (state.active !== expectedActive
    || state.objective !== fixture.objective
    || state.paused_by_user !== expectedPaused
    || state.transport_kind !== "local"
    || state.awaiting_approval !== true
    || normalizePath(String(state.scratchboard_path)) !== normalizePath(fixture.apiGoalPath)) {
    throw new Error(`${command} did not produce the exact owned goal-state transition`);
  }
  if (!existsSync(fixture.nodeGoalPath)) throw new Error(`${command} did not retain its owned goal.md until cleanup`);
  const scratchboard = readFileSync(fixture.nodeGoalPath, "utf8");
  if (!scratchboard.includes(fixture.objective) || !scratchboard.includes("Status: AWAITING_APPROVAL")) {
    throw new Error(`${command} goal.md omitted its exact objective or approval state`);
  }
  const effect = command === "set_goal_mode"
    ? "armed"
    : command === "pause_goal"
      ? "paused"
      : command === "resume_goal"
        ? "resumed"
        : "completed";
  return `Installed IPC ${effect} the exact owned goal state, verified its disposable scratchboard, then cleared both; objective and path were not retained.`;
}

function goalModeArgs(fixture: GoalFixture, on: boolean): Json {
  return {
    tabId: fixture.tabId,
    on,
    objective: on ? fixture.objective : null,
    cwd: fixture.cwd,
  };
}

function sessionAppendRecord(request: ReleaseSurfaceDriverRequest): Json {
  return {
    t: 3_000,
    kind: "ui",
    payload: {
      _meta: { kind: "release-surface-append" },
      text: `SHELLX_RELEASE_SESSION_APPEND_${request.sourceCommit.slice(0, 16)}`,
    },
  };
}

function sessionRenameTitle(request: ReleaseSurfaceDriverRequest): string {
  return `Release renamed session ${request.sourceCommit.slice(0, 16)}`;
}

function userDataWrittenFixture(request: ReleaseSurfaceDriverRequest): Json {
  return {
    releaseSurfaceWriteFixture: {
      schema: "shellx/release-surface-user-data@1",
      marker: `SHELLX_RELEASE_USER_DATA_${request.sourceCommit.slice(0, 16)}`,
    },
  };
}

function userDataPreservedValue(): Json {
  return { marker: "SHELLX_RELEASE_USER_DATA_PRESERVED" };
}

function userDataDeleteFixture(): Json {
  return {
    releaseSurfaceDeleteFixture: { marker: "SHELLX_RELEASE_USER_DATA_DELETE" },
    releaseSurfacePreservedFixture: userDataPreservedValue(),
  };
}

function readAttestedDebugToken(request: ReleaseSurfaceDriverRequest): string {
  const token = readFileSync(
    nodeReadablePath(request.runtime.debugTokenPath, request.platform),
    "utf8",
  ).trim();
  if (!token) throw new Error("attested candidate token file was empty");
  return token;
}

function debugApiConnectionForRequest(request: ReleaseSurfaceDriverRequest): { base: string; token: string } {
  return {
    base: request.runtime.debugBase.replace(/\/$/, ""),
    token: readAttestedDebugToken(request),
  };
}

async function armNativePickerLease(
  request: ReleaseSurfaceDriverRequest,
  pickerPath: string,
): Promise<void> {
  const connection = debugApiConnectionForRequest(request);
  const response = await fetch(`${connection.base}/release-test/native-picker`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ kind: "file", path: pickerPath }),
    signal: AbortSignal.timeout(3_000),
  });
  const body = requireRecord(await response.json(), "native-picker arm");
  const expectedHash = createHash("sha256").update(pickerPath).digest("hex");
  if (response.status !== 201
    || Object.keys(body).sort().join(",") !== "armed,kind,pathSha256"
    || body.armed !== true || body.kind !== "file" || body.pathSha256 !== expectedHash) {
    throw new Error("native-picker arm did not bind the exact receipt-owned file");
  }
}

async function clearNativePickerLease(request: ReleaseSurfaceDriverRequest): Promise<void> {
  const connection = debugApiConnectionForRequest(request);
  const response = await fetch(`${connection.base}/release-test/native-picker`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${connection.token}` },
    signal: AbortSignal.timeout(3_000),
  });
  const body = requireRecord(await response.json(), "native-picker cleanup");
  if (response.status !== 200 || Object.keys(body).join(",") !== "cleared"
    || typeof body.cleared !== "boolean") {
    throw new Error("native-picker cleanup did not return its exact bounded contract");
  }
}

function verifyNativePickerClaim(value: unknown, fixture: NativePickerFixture | null): string {
  if (!fixture) throw new Error("native-picker fixture was unavailable");
  const body = requireRecord(value, "release_test_take_native_picker result");
  const expectedHash = createHash("sha256").update(fixture.file).digest("hex");
  if (Object.keys(body).sort().join(",") !== "kind,path,pathSha256"
    || body.kind !== "file" || body.path !== fixture.file || body.pathSha256 !== expectedHash
    || "syntheticText" in body) {
    throw new Error("release_test_take_native_picker did not return the exact bounded owned claim");
  }
  return "Installed Tauri IPC consumed the exact receipt-owned file result once, returned its bounded identity and SHA-256, and returned null on a second claim.";
}

function grokSessionTabId(request: ReleaseSurfaceDriverRequest): string {
  return `final-surface-start-grok-${request.sourceCommit.slice(0, 16)}`;
}

function grokSessionCwd(request: ReleaseSurfaceDriverRequest): string {
  return releaseSurfaceProfileLaunchRootFromDebugTokenPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
}

async function waitForSessionChild(
  request: ReleaseSurfaceDriverRequest,
  tabId: string,
  expected: boolean,
  label: string,
): Promise<Json> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const observed = await sessionRegistryRow(request, tabId);
    if ((observed?.hasActiveChild ?? false) === expected) return observed ?? {};
    await delay(100);
  }
  throw new Error(`${label} did not reach hasActiveChild=${expected}`);
}

async function sessionHasActiveChild(
  request: ReleaseSurfaceDriverRequest,
  tabId: string,
): Promise<boolean> {
  return (await sessionRegistryRow(request, tabId))?.hasActiveChild === true;
}

async function sessionRegistryRow(
  request: ReleaseSurfaceDriverRequest,
  tabId: string,
): Promise<Json | null> {
  const state = requireRecord(await debugApiJson(request, "GET", "/state/sessions"), "session registry");
  const tabs = requireArray(state.tabs, "session registry tabs");
  const matches = tabs.filter((value) => requireRecord(value, "session registry row").tabId === tabId);
  if (matches.length > 1) throw new Error("session registry returned duplicate tab identities");
  if (matches.length === 0) return null;
  const row = requireRecord(matches[0], "session registry exact row");
  if (typeof row.hasActiveChild !== "boolean") {
    throw new Error("session registry row omitted hasActiveChild");
  }
  return row;
}

async function debugApiJson(
  request: ReleaseSurfaceDriverRequest,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Json,
): Promise<unknown> {
  const connection = debugApiConnectionForRequest(request);
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  return text.trim() ? JSON.parse(text) as unknown : null;
}

function rendererErrorMarker(request: ReleaseSurfaceDriverRequest): string {
  return `SHELLX_RELEASE_RENDERER_ERROR_${request.sourceCommit.slice(0, 16)}`;
}

function nodeReadablePath(
  path: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) {
    return resolve(path);
  }
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("unable to map installed candidate path into the driver host");
  return resolve(result.stdout.trim());
}

function requireVoidResult(value: unknown, label: string): void {
  if (value !== null && value !== undefined) throw new Error(`${label} returned an unexpected non-void result`);
}

function requireExactJson(value: unknown, expected: unknown, label: string): void {
  if (stableJson(value) !== stableJson(expected)) throw new Error(`${label} did not preserve the exact owned JSON value`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "undefined" : encoded;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/$/, "");
}

function isSupportedCommand(value: string): value is SupportedCommand {
  return (COMMANDS as readonly string[]).includes(value);
}

function commandOracleId(command: SupportedCommand): string {
  if (WINDOWS_DESKTOP_INTEGRATION_COMMANDS.has(command)) {
    return `tauri:${command}:native-lifecycle`;
  }
  if (command === "get_debug_token" || command === "shellxagent_token_read") {
    return `tauri:${command}:attested-token`;
  }
  if (command === "shellxagent_token_regenerate") return "tauri:shellxagent_token_regenerate:owned-token-rotation";
  if (command === "capture_app_screenshot_to_file") return "tauri:capture_app_screenshot_to_file:owned-screenshot";
  if (command === "abort_session") return "tauri:abort_session:owned-session-aborted";
  if (command === "start_grok_session") return "tauri:start_grok_session:owned-grok-session-active";
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
  if (BROWSER_SETTING_MUTATION_COMMANDS.has(command)) return `tauri:${command}:owned-browser-setting`;
  if (EXPECTED_REJECTIONS.has(command)) return `tauri:${command}:fail-closed`;
  if (command === "agent_cli_setup_cancel_install" || command === "pty_kill"
    || command === "reject_build_plan" || command === "pause_build" || command === "halt_build") {
    return `tauri:${command}:absent-state`;
  }
  if (command === "connections_save" || command === "connections_delete") {
    return `tauri:${command}:owned-connection`;
  }
  if (command === "connections_test") return "tauri:connections_test:absent-connection";
  if (command === "outside_connectors_save" || command === "outside_connectors_delete") {
    return `tauri:${command}:owned-outside-connector`;
  }
  if (command === "outside_connectors_test") return "tauri:outside_connectors_test:absent-connector";
  if (command === "agent_cli_setup_recheck") return "tauri:agent_cli_setup_recheck:read-schema";
  if (command === "set_permission_mode") return "tauri:set_permission_mode:full-auto-slot-removed";
  if (command === "mcp_marketplace_uninstall") return "tauri:mcp_marketplace_uninstall:owned-marketplace";
  if (VAULT_MUTATION_COMMANDS.has(command)) return `tauri:${command}:owned-vault`;
  if (GIT_MUTATION_COMMANDS.has(command)) return `tauri:${command}:owned-repository-mutation`;
  if (FILE_MUTATION_COMMANDS.has(command)) return `tauri:${command}:owned-file`;
  if (new Set<SupportedCommand>(["append_session_log", "delete_session_files", "rename_past_session"]).has(command)) {
    return `tauri:${command}:owned-history`;
  }
  if (USER_DATA_MUTATION_COMMANDS.has(command)) return `tauri:${command}:owned-user-data`;
  if (GOAL_COMMANDS.has(command)) return `tauri:${command}:owned-goal-state`;
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

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} did not return an array`);
  return value;
}

function requireExactProviderIds(rows: unknown[], label: string): void {
  const expected = ["antigravity-cli", "claude-code", "codex-cli", "grok"];
  const actual = rows.map((row) => String(requireRecord(row, `${label} provider`).providerId)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} returned an unexpected provider set`);
  }
}

function verifyMarketplaceRows(value: unknown, label: string): unknown[] {
  const rows = requireArray(value, label);
  if (rows.length === 0) throw new Error(`${label} returned an empty marketplace catalog`);
  const ids = new Set<string>();
  for (const row of rows) {
    const item = requireRecord(row, `${label} row`);
    for (const key of ["id", "name", "tier", "kind", "description", "category"]) requireString(item, key, label);
    for (const key of ["installed", "enabled", "allKeysPresent"]) requireBoolean(item, key, label);
    if (!Array.isArray(item.vaultKeys) || !Array.isArray(item.keysAvailable)
      || item.vaultKeys.length !== item.keysAvailable.length
      || item.keysAvailable.some((available) => typeof available !== "boolean")
      || ids.has(String(item.id))) {
      throw new Error(`${label} contained duplicated identity or invalid Vault-key availability metadata`);
    }
    ids.add(String(item.id));
  }
  return rows;
}

function requireRecord(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} did not return an object`);
  return value as Json;
}

function requireString(value: Json, key: string, label: string): void {
  if (typeof value[key] !== "string" || !String(value[key])) throw new Error(`${label} omitted ${key}`);
}

function requireStringValue(value: Json, key: string, label: string): string {
  requireString(value, key, label);
  return String(value[key]);
}

function verifyProfileMarkerText(
  value: unknown,
  command: SupportedCommand,
  request: ReleaseSurfaceDriverRequest,
): void {
  if (typeof value !== "string" || value.length > 64 * 1024) {
    throw new Error(`${command} returned a non-string or oversized profile marker`);
  }
  let marker: Json;
  try {
    marker = requireRecord(JSON.parse(value), `${command} profile marker`);
  } catch (error) {
    throw new Error(`${command} returned invalid profile marker JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const expectedRoot = releaseSurfaceProfileLaunchRootFromDebugTokenPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
  if (marker.schema !== "shellx/release-surface-run-profile@1"
    || marker.platform !== request.platform
    || marker.launchPath !== expectedRoot
    || typeof marker.nodePath !== "string"
    || !/^[a-f0-9]{16,64}$/.test(String(marker.runId))) {
    throw new Error(`${command} marker did not identify the exact disposable release profile`);
  }
}

function requireBoolean(value: Json, key: string, label: string): void {
  if (typeof value[key] !== "boolean") throw new Error(`${label} omitted ${key}`);
}

function verifyDesktopIntegrationStatus(
  value: unknown,
  installed: boolean,
  label: string,
): void {
  const body = requireRecord(value, `${label} status`);
  for (const key of ["supported", "explorerContextMenuInstalled", "sendToShortcutInstalled"]) {
    requireBoolean(body, key, label);
  }
  if (body.supported !== true || body.os !== "windows"
    || body.explorerContextMenuInstalled !== installed
    || body.sendToShortcutInstalled !== installed
    || typeof body.message !== "string" || !body.message) {
    throw new Error(`${label} returned a desktop integration status that did not match the exact Windows lifecycle phase`);
  }
}

function requireInteger(value: Json, key: string, label: string): void {
  if (!Number.isSafeInteger(value[key])) throw new Error(`${label} omitted integer ${key}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
