import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  candidateTeardownCleanupRequired,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "./lib/release-surface-driver-protocol";
import { validateDebugApiVaultResetResponse } from "./release-drivers/debug-api-vault-e2e-mutation";
import { sameProviderFixtureCwd } from "./release-drivers/debug-api-provider-lifecycle-mutation";
import { releaseSurfaceControllerBindingFixture, releaseSurfaceFixtureSourceCommit, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-debug-api-driver-"));
const profileRoot = join(temp, `shellx-final-webdriver-${"b".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-debug-api-token-0001-bounded-secret";
const instanceId = "fixture-debug-api-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixturePlatform = process.platform === "win32" ? "windows-installed" : "linux-installed";
const fixtureImagePath = fixturePlatform === "windows-installed"
  ? "C:\\Temp\\ShellXReleaseFixture\\shellx.exe"
  : "/tmp/fixture/shellx";

assert.throws(
  () => validateDebugApiVaultResetResponse({
    ok: true,
    receipt: {
      action: "vaultE2eReset",
      decision: null,
      grantId: null,
      reason: "keyring cleanup failed",
      receiptId: "vault-e2e-fixture-warning",
      secretExposed: false,
      secretPresent: null,
      secretRef: null,
      t: 1,
    },
  }),
  /wrong receipt/,
  "Vault cleanup warnings must fail release-surface reset validation",
);
assert.equal(sameProviderFixtureCwd(
  String.raw`\\?\C:\Users\Fixture\release-provider-action-owned`,
  String.raw`C:\Users\Fixture\release-provider-action-owned`,
  "windows-installed",
), true, "Windows provider fixture cwd accepts only the canonical long-path spelling of the same path");
assert.equal(sameProviderFixtureCwd(
  String.raw`C:\Users\Fixture\release-provider-action-other`,
  String.raw`C:\Users\Fixture\release-provider-action-owned`,
  "windows-installed",
), false, "Windows provider fixture cwd rejects a different canonical path");
const paths = [
  "/events",
  "/health",
  "/shellxagent.json",
  "/.well-known/shellxagent.json",
  "/agent-doc/manifest",
  "/agent-doc/skills/shellx-host/SKILL.md",
  "/settings",
  "/connections",
  "/browser/summary",
  "/browser/tabs",
  "/browser/profiles",
  "/browser/tasks",
  "/agent-doc",
  "/state/header",
  "/state/footer",
  "/state/ui",
  "/panels",
  "/preview",
  "/preview/work/state",
  "/preview/work/logs",
  "/preview/work/diagnose",
  "/goal/state",
  "/build/state",
  "/vault/status",
  "/state/sessions",
  "/state/tabs/report",
  "/state/agent_runs",
  "/state/session_assets",
  "/state/marketplace_health",
  "/state/session_tooling",
  "/agent-doc/shellx-host/SKILL.md",
  "/browser/bookmarks",
  "/browser/check",
  "/browser/settle",
  "/browser/developer-mode",
  "/browser/dialogs",
  "/browser/downloads",
  "/browser/engine-pool",
  "/browser/evidence",
  "/browser/history",
  "/browser/logs",
  "/browser/network",
  "/browser/permissions",
  "/browser/personal-lock",
  "/browser/popups",
  "/browser/privacy",
  "/browser/receipts",
  "/browser/requests",
  "/browser/robots",
  "/browser/shields",
  "/browser/state",
  "/browser/storage-state",
  "/browser/uploads",
  "/build/receipts",
  "/events/recent",
  "/outside-connectors",
  "/outside-connectors/capabilities",
  "/outside-connectors/events",
  "/provider-adapters/state",
  "/provider-sessions/state",
  "/screenshot",
  "/sessions/:id/snippet",
  "/sessions/history",
  "/sessions/history/:id",
  "/sessions/search",
  "/state/agent_cli_setup",
  "/state/environment",
  "/state/files",
  "/state/github",
  "/state/github/items",
  "/state/session_git",
  "/state/session_git/diff",
  "/state/model_instruction_cards",
  "/state/session_activity",
  "/state/skills",
  "/state/subagents",
  "/state/grok_environment",
  "/vault/agent-requests",
  "/vault/e2e/audit",
  "/vault/grants",
  "/vault/keys",
  "/vault/resources",
];
const mutations = [
  { method: "POST", path: "/browser/bookmarks" },
  { method: "DELETE", path: "/browser/bookmarks/:bookmark_id" },
  { method: "POST", path: "/browser/bookmarks/reorder" },
] as const;
const gitMutations = [
  "/state/session_git/checkpoint",
  "/state/session_git/worktree",
] as const;
const browserVaultDepositMutations = ["/browser/vault-deposits"] as const;
const browserWindowMutations = ["/browser/open"] as const;
const goalLifecycleMutations = [
  "/goal/start",
  "/goal/stop",
  "/goal/pause",
  "/goal/resume",
  "/goal/reject",
  "/goal/complete",
] as const;
const vaultPanelMutations = ["/vault/open-panel"] as const;
const providerLifecycleMutations = [
  "/connect",
  "/provider-adapters/run",
  "/provider-sessions/start",
] as const;
const browserLifecycleMutations = [
  "/browser/action",
  "/browser/cdp/execute",
  "/browser/task/start",
  "/browser/task/finish",
  "/browser/task/control",
  "/browser/tabs/close",
  "/browser/tabs/focus",
  "/browser/tabs/heartbeat",
  "/browser/tabs/lock",
  "/browser/tabs/open",
  "/browser/tabs/reorder",
  "/browser/tabs/unlock",
] as const;
const browserEvidenceArtifactMutations = [
  "/browser/flight-recorder/export",
  "/browser/evaluations",
  "/browser/har/export",
  "/browser/performance/export",
  "/browser/recipes/export",
  "/browser/recipes/replay",
  "/browser/storage-state/export",
  "/browser/trace/export",
] as const;
const browserMonotonicMutations = [
  "/browser/logs",
  "/browser/popups",
  "/browser/report",
] as const;
const browserTransferIntentMutations = [
  "/browser/downloads/complete",
  "/browser/downloads/request",
  "/browser/uploads/complete",
  "/browser/uploads/request",
] as const;
const browserRobotMutations = [
  "/browser/robots/schedule",
  "/browser/robots/run",
  "/browser/robots/cancel",
] as const;
const browserPendingRequestMutations = [
  "/browser/dialogs",
  "/browser/permissions",
  "/browser/session-grants/apply",
  "/browser/session-grants/request",
] as const;
const browserRenderedCheckMutations = [
  "/browser/rendered-check",
] as const;
const browserTeachDeveloperSurfaces = [
  {
    method: "GET",
    path: "/browser/teach/drafts",
    oracleId: "debug-api:GET-browser-teach-drafts:owned-agent-readback",
  },
  {
    method: "POST",
    path: "/browser/developer/inspect",
    oracleId: "debug-api:POST-browser-developer-inspect:developer-mode-denial",
  },
  {
    method: "POST",
    path: "/browser/teach/prepare",
    oracleId: "debug-api:POST-browser-teach-prepare:owned-agent-draft",
  },
  {
    method: "POST",
    path: "/browser/teach/revise",
    oracleId: "debug-api:POST-browser-teach-revise:owned-agent-revision",
  },
] as const;
const previewLifecycleMutations = [
  "/preview/work/start",
  "/preview/work/restart",
  "/preview/work/stop",
] as const;
const connectionMutations = [
  { method: "POST", path: "/connections" },
  { method: "DELETE", path: "/connections/:id" },
] as const;
const outsideConnectorMutations = [
  { method: "POST", path: "/outside-connectors" },
  { method: "DELETE", path: "/outside-connectors/:id" },
] as const;
const operatorGates = [
  { method: "POST", path: "/browser/privacy", requestPath: "/browser/privacy", statePath: "/browser/privacy" },
  { method: "POST", path: "/browser/personal-lock", requestPath: "/browser/personal-lock", statePath: "/browser/personal-lock" },
  { method: "POST", path: "/browser/shields", requestPath: "/browser/shields", statePath: "/browser/shields" },
  { method: "POST", path: "/browser/shields/site", requestPath: "/browser/shields/site", statePath: "/browser/shields" },
  { method: "DELETE", path: "/browser/shields/site/:host", requestPath: "/browser/shields/site/release-surface.invalid", statePath: "/browser/shields" },
  { method: "POST", path: "/browser/developer-mode", requestPath: "/browser/developer-mode", statePath: "/browser/developer-mode" },
  { method: "POST", path: "/browser/developer-mode/approval", requestPath: "/browser/developer-mode/approval", statePath: "/browser/developer-mode" },
  { method: "POST", path: "/browser/dialogs/resolve", requestPath: "/browser/dialogs/resolve", statePath: "/browser/dialogs" },
  { method: "POST", path: "/browser/permissions/resolve", requestPath: "/browser/permissions/resolve", statePath: "/browser/permissions" },
  { method: "POST", path: "/browser/session-grants/resolve", requestPath: "/browser/session-grants/resolve", statePath: "/browser/requests" },
  { method: "POST", path: "/browser/task/autonomy", requestPath: "/browser/task/autonomy", statePath: "/browser/state" },
] as const;
const vaultE2eMutations = [
  "/vault/e2e/reset",
  "/vault/e2e/seed-secret",
  "/vault/e2e/approve-grant",
  "/vault/e2e/deny-grant",
  "/vault/e2e/revoke-grant",
  "/vault/e2e/expire-grant",
  "/vault/e2e/probe-use",
] as const;
const vaultOwnedGrantMutations = [
  "/vault/grants",
  "/vault/grants/:grant_id/revoke",
] as const;
const vaultSetupMutations = [
  "/vault/setup/begin",
  "/vault/setup/confirm-recovery",
  "/vault/lock",
  "/vault/remember-device",
] as const;
const vaultAgentRequestMutations = [
  "/vault/agent-requests",
  "/vault/agent-requests/:request_id/cancel",
] as const;
const ownedVaultAgentCancelPath = /^\/vault\/agent-requests\/request-\d+-[a-f0-9]{16}\/cancel$/;
const fsWatchMutations = [
  { method: "POST", path: "/tools/fs_watch" },
  { method: "DELETE", path: "/tools/fs_watch/:watchId" },
] as const;
const tauriInvokeRelayMutations = [
  { method: "POST", path: "/release-test/tauri-invokes" },
  { method: "GET", path: "/release-test/tauri-invokes/:id" },
  { method: "DELETE", path: "/release-test/tauri-invokes/:id" },
  { method: "POST", path: "/release-test/tauri-invokes/:id/claim" },
  { method: "POST", path: "/release-test/tauri-invokes/:id/complete" },
] as const;
const nativePickerLifecycles = ["POST", "GET", "DELETE"] as const;
const ownedTauriInvokeRelayPath = /^\/release-test\/tauri-invokes\/rti-[0-9a-f]{32}(?:\/(?:claim|complete))?$/;
const ownedTeachDraftsPath = /^\/browser\/teach\/drafts\?taskId=release-browser-settle-task-[a-f0-9]{16}(?:-\d+)?&limit=1$/;
const ownedFsUnwatchPath = /^\/tools\/fs_watch\/fsw-[0-9a-f-]{36}$/;
const ownedProviderConnectPath = /^\/connect\?tabId=shellx-release-provider-[0-9a-f-]{36}$/;
const ownedProviderAbortPath = /^\/abort\?tabId=shellx-release-provider-[0-9a-f-]{36}$/;
const ownedProviderStatePath = /^\/provider-sessions\/state\?tabId=(?:shellx-release-provider-[0-9a-f-]{36}|release-provider-action-activity-ask-agent)&transport=local$/;
const ownedProviderSessionAbortPath = /^\/provider-sessions\/abort\?tabId=shellx-release-provider-[0-9a-f-]{36}$/;
const vaultMutations = [
  { method: "POST", path: "/vault/set" },
  { method: "POST", path: "/vault/delete" },
] as const;
const safeRefusalRoutes = [
  "/abort",
  "/agent_cli_setup/install/cancel",
  "/agent_cli_setup/install/confirm",
  "/agent_cli_setup/install/prepare",
  "/agent_cli_setup/recheck",
  "/autonomy",
  "/build/receipt",
  "/build/start",
  "/build/approve",
  "/build/complete",
  "/build/operator_note",
  "/build/pause",
  "/build/recheck_blocker",
  "/build/reject",
  "/build/resume",
  "/build/stop",
  "/browser/vault/fill-receipt",
  "/browser/vault/generate-receipt",
  "/connections/:id/test",
  "/connections/provider-scan",
  "/disconnect",
  "/goal/approve",
  "/outside-connectors/:id/simulate",
  "/outside-connectors/:id/test",
  "/permissions/:reqId/respond",
  "/plan",
  "/preview/work/diagnose",
  "/prompt",
  "/provider-sessions/abort",
  "/sessions/:id/archive",
  "/tabs/:id/archive",
  "/state/environment/trace_export",
  "/state/grok_environment/trace_export",
  "/tools/process_attach_stdout",
  "/tools/process_list",
  "/tools/process_signal",
  "/tools/process_stats",
  "/tools/secret_get",
] as const;
let fixture: ChildProcess | null = null;

try {
  mkdirSync(shellxHome, { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  writeFileSync(join(profileRoot, "shellx-final-profile.json"), `${JSON.stringify({
    schema: "shellx/release-surface-run-profile@1",
    platform: fixturePlatform,
    runId: "b".repeat(16),
    nodePath: profileRoot,
    launchPath: profileRoot,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-debug-api-server-fixture.ts"),
    "--state-out", statePath,
    "--token", token,
    "--instance-id", instanceId,
    "--process-id", "4321",
    "--version", releaseSurfaceFixtureVersion,
    "--source-commit", sourceCommit,
    "--artifact-root", profileRoot,
    "--platform", fixturePlatform === "windows-installed" ? "windows" : "linux",
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const port = await waitForPort(statePath, fixture);
  const candidateBase = `http://127.0.0.1:${port}`;
  const request: ReleaseSurfaceDriverRequest = {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "debug-api-route-installed",
    driverKind: "debug-api-route",
    platform: fixturePlatform,
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: "a".repeat(64),
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture("scripts/release-drivers/debug-api-route-installed.ts"),
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
    assignments: [
      ...paths.map((path) => ({
      surface: {
        id: `debug-api-route:GET ${path}`,
        kind: "debug-api-route" as const,
        name: `GET ${path}`,
        source: "src-tauri/src/debug_api.rs",
        platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
        delivery: "installed-app" as const,
      },
      fixtureId: path === "/screenshot"
        ? "debug-api:installed-window-capture"
        : path === "/vault/e2e/audit"
          ? "debug-api:isolated-vault-e2e-read"
          : path.startsWith("/sessions/")
            ? "debug-api:isolated-session-history"
          : path === "/state/files"
            ? "debug-api:isolated-files-directory"
          : path === "/browser/settle"
            ? "debug-api:isolated-browser-task"
          : path === "/state/github" || path === "/state/github/items"
            || path === "/state/session_git" || path === "/state/session_git/diff"
            ? "debug-api:isolated-git-repository"
          : path === "/state/session_activity" || path === "/state/environment" || path === "/state/grok_environment" || path === "/preview/work/diagnose"
            ? "debug-api:isolated-absent-session"
          : path === "/health" || path.includes("shellxagent") || path.startsWith("/agent-doc")
            ? "debug-api:installed-app-identity"
            : "debug-api:installed-read-model",
      expectedEffect: `${path} returns its exact bounded installed read model`,
      oracleId: `debug-api:GET-${path.slice(1).replaceAll("/", "-").replaceAll(".", "-")}`,
      cleanupId: path === "/screenshot"
        ? "debug-api:restore-window-state"
        : path === "/vault/e2e/audit"
          ? "debug-api:delete-isolated-run-profile"
          : path.startsWith("/sessions/")
            ? "debug-api:delete-owned-session-fixture"
          : path === "/state/files"
            ? "debug-api:delete-owned-files-fixture"
          : path === "/browser/settle"
            ? "debug-api:close-owned-browser-task-and-server"
          : path === "/state/github" || path === "/state/github/items"
            || path === "/state/session_git" || path === "/state/session_git/diff"
            ? "debug-api:delete-owned-git-fixture"
          : "debug-api:read-only",
      })),
      ...gitMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_git_activity.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-git-repository-mutation",
        expectedEffect: `${path} performs its exact owned local Git mutation`,
        oracleId: `debug-api:POST-${path.slice(1).replaceAll("/", "-")}:semantic-effect`,
        cleanupId: "debug-api:delete-owned-git-fixture-and-checkpoint",
      })),
      ...browserVaultDepositMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_browser_security.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-browser-vault-deposit",
        expectedEffect: `${path} performs its exact write-only isolated Vault deposit`,
        oracleId: "debug-api:POST-browser-vault-deposits:semantic-effect",
        cleanupId: "debug-api:delete-owned-vault-deposit-close-task-and-candidate-teardown",
      })),
      ...browserWindowMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_browser_state.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:installed-browser-window",
        expectedEffect: `POST ${path} proves its exact installed Browser native-window transition`,
        oracleId: "debug-api:POST-browser-open:semantic-effect",
        cleanupId: "debug-api:close-browser-window-with-candidate-teardown",
      })),
      ...goalLifecycleMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_goals.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-goal-lifecycle",
        expectedEffect: `POST ${path} proves its exact owned Goal lifecycle transition`,
        oracleId: `debug-api:POST-goal-${path.split("/").at(-1)}:semantic-effect`,
        cleanupId: "debug-api:stop-owned-goal-and-delete-scratchboard",
      })),
      ...vaultPanelMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_vault.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:installed-vault-panel",
        expectedEffect: `POST ${path} proves its acknowledged visible installed Vault panel transition`,
        oracleId: "debug-api:POST-vault-open-panel:semantic-effect",
        cleanupId: "debug-api:close-vault-panel-and-clear-highlight",
      })),
      ...providerLifecycleMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: path === "/connect"
            ? "src-tauri/src/debug_api_session_lifecycle.rs"
            : "src-tauri/src/debug_api_providers.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-local-provider-lifecycle",
        expectedEffect: `POST ${path} proves its exact installed local provider lifecycle transition`,
        oracleId: `debug-api:POST-${path.slice(1).replaceAll("/", "-")}:semantic-effect`,
        cleanupId: path === "/provider-adapters/run"
          ? "debug-api:no-provider-process-created"
          : "debug-api:stop-owned-provider-and-delete-project",
      })),
      ...mutations.map(({ method, path }) => ({
        surface: {
          id: `debug-api-route:${method} ${path}`,
          kind: "debug-api-route" as const,
          name: `${method} ${path}`,
          source: "src-tauri/src/debug_api_browser_settings.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-browser-bookmark",
        expectedEffect: `${method} ${path} proves its exact owned Browser bookmark state transition`,
        oracleId: method === "POST"
          ? "debug-api:POST-browser-bookmarks:semantic-effect"
          : "debug-api:delete-browser-bookmarks-bookmark-id:semantic-effect",
        cleanupId: "debug-api:delete-owned-browser-bookmark",
      })),
      ...browserLifecycleMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_browser_state.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-browser-task",
        expectedEffect: `POST ${path} proves its exact owned Browser task/tab transition`,
        oracleId: `debug-api:POST-${path.slice(1).replaceAll("/", "-")}:semantic-effect`,
        cleanupId: "debug-api:close-owned-browser-task-and-server",
      })),
      ...browserEvidenceArtifactMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_browser_artifacts.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-browser-evidence-artifacts",
        expectedEffect: `POST ${path} proves its exact owned Browser evidence artifact effect`,
        oracleId: `debug-api:post-browser-${path.slice("/browser/".length).replaceAll("/", "-")}:semantic-effect`,
        cleanupId: "debug-api:delete-owned-browser-artifacts-and-close-task",
      })),
      ...browserMonotonicMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_browser_artifacts.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-browser-monotonic-state",
        expectedEffect: `POST ${path} proves its exact owned monotonic Browser effect`,
        oracleId: `debug-api:post-browser-${path.slice("/browser/".length)}:semantic-effect`,
        cleanupId: "debug-api:close-owned-browser-task-and-candidate-teardown",
      })),
      ...browserTransferIntentMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_browser_artifacts.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-browser-transfer-intent",
        expectedEffect: `POST ${path} proves its exact owned Browser transfer intent`,
        oracleId: `debug-api:post-browser-${path.slice("/browser/".length).replaceAll("/", "-")}:semantic-effect`,
        cleanupId: "debug-api:delete-owned-transfer-file-close-task-and-candidate-teardown",
      })),
      ...browserRobotMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_browser_artifacts.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-browser-robot-recipe",
        expectedEffect: `POST ${path} proves its exact owned Browser robot lifecycle effect`,
        oracleId: `debug-api:post-browser-robots-${path.split("/").at(-1)}:semantic-effect`,
        cleanupId: "debug-api:delete-owned-browser-robot-recipe-close-task-and-candidate-teardown",
      })),
      ...browserPendingRequestMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_browser_security.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-browser-pending-request",
        expectedEffect: `POST ${path} proves its exact owned Browser pending-request lifecycle`,
        oracleId: `debug-api:post-browser-${path.slice("/browser/".length).replaceAll("/", "-")}:semantic-effect`,
        cleanupId: "debug-api:complete-owned-browser-task-and-candidate-teardown",
      })),
      ...browserRenderedCheckMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_browser_rendered_check.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-browser-hidden-renderer",
        expectedEffect: `POST ${path} proves its exact hidden-renderer effect`,
        oracleId: "debug-api:post-browser-rendered-check:semantic-effect",
        cleanupId: "debug-api:destroy-owned-browser-hidden-renderer",
      })),
      ...browserTeachDeveloperSurfaces.map(({ method, path, oracleId }) => ({
        surface: {
          id: `debug-api-route:${method} ${path}`,
          kind: "debug-api-route" as const,
          name: `${method} ${path}`,
          source: path === "/browser/developer/inspect"
            ? "src-tauri/src/debug_api_browser_developer_inspection.rs"
            : "src-tauri/src/debug_api_browser_teach.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-browser-teach-agent-task",
        expectedEffect: `${method} ${path} proves its exact owned Browser Teach or Developer boundary`,
        oracleId,
        cleanupId: "debug-api:close-owned-browser-teach-task-and-candidate-teardown",
      })),
      ...previewLifecycleMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_preview_tools.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-work-preview-lifecycle",
        expectedEffect: `POST ${path} proves its exact owned static Preview lifecycle transition`,
        oracleId: `debug-api:POST-${path.slice(1).replaceAll("/", "-")}:semantic-effect`,
        cleanupId: "debug-api:stop-owned-preview-and-delete-project",
      })),
      ...connectionMutations.map(({ method, path }) => ({
        surface: {
          id: `debug-api-route:${method} ${path}`,
          kind: "debug-api-route" as const,
          name: `${method} ${path}`,
          source: "src-tauri/src/debug_api_connections.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-connection-preset",
        expectedEffect: `${method} ${path} proves its exact inert local connection transition`,
        oracleId: method === "POST"
          ? "debug-api:POST-connections:semantic-effect"
          : "debug-api:DELETE-connections-id:semantic-effect",
        cleanupId: "debug-api:delete-owned-connection-preset",
      })),
      ...outsideConnectorMutations.map(({ method, path }) => ({
        surface: {
          id: `debug-api-route:${method} ${path}`,
          kind: "debug-api-route" as const,
          name: `${method} ${path}`,
          source: "src-tauri/src/debug_api_connections.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-disabled-outside-connector",
        expectedEffect: `${method} ${path} proves its exact disabled outside-connector transition`,
        oracleId: method === "POST"
          ? "debug-api:POST-outside-connectors:semantic-effect"
          : "debug-api:DELETE-outside-connectors-id:semantic-effect",
        cleanupId: "debug-api:delete-owned-outside-connector",
      })),
      {
        surface: {
          id: "debug-api-route:POST /state/ui",
          kind: "debug-api-route" as const,
          name: "POST /state/ui",
          source: "src-tauri/src/debug_api_session_state.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:installed-ui-baseline",
        expectedEffect: "POST /state/ui proves a reversible logical bottom-tab transition",
        oracleId: "debug-api:POST-state-ui:semantic-effect",
        cleanupId: "debug-api:restore-logical-ui-baseline",
      },
      ...operatorGates.map(({ method, path }) => ({
        surface: {
          id: `debug-api-route:${method} ${path}`,
          kind: "debug-api-route" as const,
          name: `${method} ${path}`,
          source: "src-tauri/src/debug_api_browser_settings.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:operator-gated-read-only",
        expectedEffect: `${method} ${path} returns its exact operator-only denial without changing Browser state`,
        oracleId: `debug-api:${method}-${path.slice(1).replaceAll("/", "-").replace(":host", "host")}:operator-denied`,
        cleanupId: "debug-api:read-only",
      })),
      {
        surface: {
          id: "debug-api-route:POST /release-test/clipboard",
          kind: "debug-api-route" as const,
          name: "POST /release-test/clipboard",
          source: "src-tauri/src/debug_api_release_clipboard.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:guarded-native-clipboard-preflight",
        expectedEffect: "POST /release-test/clipboard proves its exact empty-lease or nonempty-preservation lifecycle",
        oracleId: "debug-api:POST-release-test-clipboard:guarded-preflight-lifecycle",
        cleanupId: "debug-api:release-empty-or-preserve-nonempty-clipboard",
      },
      ...nativePickerLifecycles.map((method) => ({
        surface: {
          id: `debug-api-route:${method} /release-test/native-picker`,
          kind: "debug-api-route" as const,
          name: `${method} /release-test/native-picker`,
          source: "src-tauri/src/debug_api_release_native_picker.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-native-picker-lease",
        expectedEffect: `${method} /release-test/native-picker proves its exact isolated one-shot lease contract`,
        oracleId: `debug-api:${method}-release-test-native-picker:lease-lifecycle`,
        cleanupId: "debug-api:clear-isolated-native-picker-lease-delete-fixture",
      })),
      ...safeRefusalRoutes.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-safe-refusal",
        expectedEffect: `POST ${path} proves its exact bounded absent-state or pre-effect refusal`,
        oracleId: `debug-api:POST-${path.slice(1).replaceAll("/", "-").replaceAll(":", "")}:safe-refusal`,
        cleanupId: "debug-api:read-only",
      })),
      ...vaultE2eMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_vault.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "route-driver:isolated-vault-e2e-mutation",
        expectedEffect: `POST ${path} proves its exact guarded disposable Vault E2E lifecycle effect`,
        oracleId: `debug-api:POST-${path.slice(1).replaceAll("/", "-")}:semantic-effect`,
        cleanupId: "debug-api:reset-isolated-vault-e2e",
      })),
      ...vaultOwnedGrantMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_vault.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "route-driver:isolated-vault-e2e-mutation",
        expectedEffect: `POST ${path} proves its exact guarded disposable Vault grant lifecycle effect`,
        oracleId: `debug-api:POST-${path.slice(1).replaceAll("/", "-").replace(":grant_id", "grant-id")}:semantic-effect`,
        cleanupId: "debug-api:reset-isolated-vault-e2e",
      })),
      ...vaultSetupMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_vault.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-vault-setup-lifecycle",
        expectedEffect: `POST ${path} proves its exact isolated Vault setup lifecycle effect`,
        oracleId: `debug-api:post-vault-${path.slice("/vault/".length).replaceAll("/", "-")}:semantic-effect`,
        cleanupId: "debug-api:reset-isolated-vault-e2e",
      })),
      ...vaultAgentRequestMutations.map((path) => ({
        surface: {
          id: `debug-api-route:POST ${path}`,
          kind: "debug-api-route" as const,
          name: `POST ${path}`,
          source: "src-tauri/src/debug_api_vault.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-vault-agent-request",
        expectedEffect: `POST ${path} proves its exact isolated metadata-only Vault agent-request lifecycle`,
        oracleId: `debug-api:post-vault-${path.slice("/vault/".length).replaceAll("/", "-").replace(":request_id", "request-id")}:semantic-effect`,
        cleanupId: "debug-api:reset-isolated-vault-e2e-and-agent-state",
      })),
      ...fsWatchMutations.map(({ method, path }) => ({
        surface: {
          id: `debug-api-route:${method} ${path}`,
          kind: "debug-api-route" as const,
          name: `${method} ${path}`,
          source: "src-tauri/src/debug_api.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-native-temp-fs-watch",
        expectedEffect: `${method} ${path} proves its exact owned native-temp filesystem-watch lifecycle`,
        oracleId: method === "POST"
          ? "debug-api:POST-tools-fs-watch:semantic-effect"
          : "debug-api:DELETE-tools-fs-watch-watchId:semantic-effect",
        cleanupId: "debug-api:stop-owned-fs-watch-and-delete-native-temp-fixture",
      })),
      ...tauriInvokeRelayMutations.map(({ method, path }) => ({
        surface: {
          id: `debug-api-route:${method} ${path}`,
          kind: "debug-api-route" as const,
          name: `${method} ${path}`,
          source: "src-tauri/src/debug_api_release_relay.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-tauri-invoke-relay",
        expectedEffect: `${method} ${path} proves one exact nonce-bound get_debug_port relay lifecycle`,
        oracleId: `debug-api:${method}-${path.slice(1).replaceAll("/", "-").replaceAll(":", "")}:semantic-effect`,
        cleanupId: "debug-api:delete-owned-tauri-invoke",
      })),
      {
        surface: {
          id: "debug-api-route:POST /diagnostics",
          kind: "debug-api-route" as const,
          name: "POST /diagnostics",
          source: "src-tauri/src/debug_api_diagnostics_github.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:installed-bounded-post-read",
        expectedEffect: "POST /diagnostics proves only the bounded bearer-token auth check",
        oracleId: "debug-api:POST-diagnostics-auth",
        cleanupId: "debug-api:read-only",
      },
      {
        surface: {
          id: "debug-api-route:POST /github/pr/create",
          kind: "debug-api-route" as const,
          name: "POST /github/pr/create",
          source: "src-tauri/src/debug_api_diagnostics_github.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:remote-approval-gated-read-only",
        expectedEffect: "POST /github/pr/create proves the remote mutation approval gate",
        oracleId: "debug-api:POST-github-pr-create:approval-required",
        cleanupId: "debug-api:read-only",
      },
      {
        surface: {
          id: "debug-api-route:POST /vault/get",
          kind: "debug-api-route" as const,
          name: "POST /vault/get",
          source: "src-tauri/src/debug_api_vault.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:operator-gated-read-only",
        expectedEffect: "POST /vault/get returns its exact raw-secret denial without changing Vault metadata",
        oracleId: "debug-api:POST-vault-get:raw-reveal-denied",
        cleanupId: "debug-api:read-only",
      },
      ...vaultMutations.map(({ method, path }) => ({
        surface: {
          id: `debug-api-route:${method} ${path}`,
          kind: "debug-api-route" as const,
          name: `${method} ${path}`,
          source: "src-tauri/src/debug_api_vault.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-vault-secret",
        expectedEffect: `${method} ${path} proves its exact owned no-secret Vault metadata transition`,
        oracleId: `debug-api:POST-vault-${path.endsWith("set") ? "set" : "delete"}:semantic-effect`,
        cleanupId: "debug-api:delete-owned-vault-secret",
      })),
      {
        surface: {
          id: "debug-api-route:POST /browser/engine-pool",
          kind: "debug-api-route" as const,
          name: "POST /browser/engine-pool",
          source: "src-tauri/src/debug_api_browser_settings.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-browser-engine-pool",
        expectedEffect: "POST /browser/engine-pool proves a reversible isolated logical settings transition",
        oracleId: "debug-api:POST-browser-engine-pool:semantic-effect",
        cleanupId: "debug-api:restore-browser-engine-pool",
      },
      {
        surface: {
          id: "debug-api-route:POST /panels",
          kind: "debug-api-route" as const,
          name: "POST /panels",
          source: "src-tauri/src/debug_api_preview_tools.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:installed-panel-baseline",
        expectedEffect: "POST /panels proves a reversible installed panel-size transition",
        oracleId: "debug-api:POST-panels:semantic-effect",
        cleanupId: "debug-api:restore-panel-baseline",
      },
      {
        surface: {
          id: "debug-api-route:POST /preview",
          kind: "debug-api-route" as const,
          name: "POST /preview",
          source: "src-tauri/src/debug_api.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:installed-preview-baseline",
        expectedEffect: "POST /preview proves a reversible nullable Preview-target transition",
        oracleId: "debug-api:POST-preview:semantic-effect",
        cleanupId: "debug-api:restore-preview-baseline",
      },
      {
        surface: {
          id: "debug-api-route:POST /settings",
          kind: "debug-api-route" as const,
          name: "POST /settings",
          source: "src-tauri/src/debug_api_history_settings.rs",
          platforms: ["linux-installed", "windows-installed", "macos-installed"] as Array<"linux-installed" | "windows-installed" | "macos-installed">,
          delivery: "installed-app" as const,
        },
        fixtureId: "debug-api:isolated-settings-profile",
        expectedEffect: "POST /settings proves a reversible normalized settings transition",
        oracleId: "debug-api:POST-settings:semantic-effect",
        cleanupId: "debug-api:restore-settings-baseline",
      },
    ],
  };
  request.assignments.find((entry) => entry.surface.name === "GET /.well-known/shellxagent.json")!.oracleId = "debug-api:GET-well-known-shellxagent-json";
  request.assignments.find((entry) => entry.surface.name === "GET /agent-doc/skills/shellx-host/SKILL.md")!.oracleId = "debug-api:GET-agent-doc-skills-shellx-host-SKILL-md";
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/debug-api-route-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(
    run.status,
    0,
    [run.stderr, run.stdout, summarizeDriverReportFailure(reportPath)]
      .filter(Boolean)
      .join("\n"),
  );
  const reportText = readFileSync(reportPath, "utf8");
  const report = JSON.parse(reportText) as ReleaseSurfaceDriverReport;
  assert.equal(
    report.outcomes.length,
    paths.length + gitMutations.length + browserVaultDepositMutations.length + browserWindowMutations.length
      + goalLifecycleMutations.length
      + vaultPanelMutations.length
      + providerLifecycleMutations.length
      + mutations.length + browserLifecycleMutations.length + previewLifecycleMutations.length
      + browserEvidenceArtifactMutations.length
      + browserMonotonicMutations.length
      + browserTransferIntentMutations.length
      + browserRobotMutations.length
      + browserPendingRequestMutations.length
      + browserRenderedCheckMutations.length
      + browserTeachDeveloperSurfaces.length
      + connectionMutations.length + outsideConnectorMutations.length
      + operatorGates.length + safeRefusalRoutes.length + vaultE2eMutations.length + vaultOwnedGrantMutations.length
      + vaultSetupMutations.length + vaultAgentRequestMutations.length + fsWatchMutations.length
      + tauriInvokeRelayMutations.length + nativePickerLifecycles.length + vaultMutations.length + 9,
  );
  const failedOutcomes = report.outcomes.filter((outcome) => {
    const cleanupId = outcome.cleanupEvidence?.cleanupId ?? "";
    const expectedCleanup = candidateTeardownCleanupRequired(cleanupId)
      ? "deferred-candidate-teardown"
      : "pass";
    return outcome.present !== "pass"
      || outcome.invoke !== "pass"
      || outcome.effect !== "pass"
      || outcome.cleanup !== expectedCleanup
      || outcome.cleanupEvidence?.status !== expectedCleanup;
  });
  assert.deepEqual(
    failedOutcomes,
    [],
    `Debug API driver failed outcomes: ${failedOutcomes.map((outcome) => `${outcome.id}: ${outcome.error ?? outcome.observedEffect}`).join(" | ")}`,
  );
  assert.deepEqual(
    report.outcomes
      .filter((outcome) => outcome.cleanup === "deferred-candidate-teardown")
      .map((outcome) => outcome.cleanupEvidence?.cleanupId)
      .sort(),
    [
      "debug-api:close-owned-browser-task-and-candidate-teardown",
      "debug-api:close-owned-browser-task-and-candidate-teardown",
      "debug-api:close-owned-browser-task-and-candidate-teardown",
      "debug-api:close-browser-window-with-candidate-teardown",
      "debug-api:complete-owned-browser-task-and-candidate-teardown",
      "debug-api:complete-owned-browser-task-and-candidate-teardown",
      "debug-api:complete-owned-browser-task-and-candidate-teardown",
      "debug-api:complete-owned-browser-task-and-candidate-teardown",
      "debug-api:delete-owned-browser-robot-recipe-close-task-and-candidate-teardown",
      "debug-api:delete-owned-browser-robot-recipe-close-task-and-candidate-teardown",
      "debug-api:delete-owned-browser-robot-recipe-close-task-and-candidate-teardown",
      "debug-api:delete-owned-transfer-file-close-task-and-candidate-teardown",
      "debug-api:delete-owned-transfer-file-close-task-and-candidate-teardown",
      "debug-api:delete-owned-transfer-file-close-task-and-candidate-teardown",
      "debug-api:delete-owned-transfer-file-close-task-and-candidate-teardown",
      "debug-api:delete-owned-vault-deposit-close-task-and-candidate-teardown",
      "debug-api:close-owned-browser-teach-task-and-candidate-teardown",
      "debug-api:close-owned-browser-teach-task-and-candidate-teardown",
      "debug-api:close-owned-browser-teach-task-and-candidate-teardown",
      "debug-api:close-owned-browser-teach-task-and-candidate-teardown",
    ].sort(),
  );
  for (const privateValue of [
    "fixture-profile-private",
    "fixture-tab-private",
    "fixture-task-private",
    "fixture-bookmark-private",
    "fixture-private.invalid",
    "fixture-event-payload-private",
    "fixture-websocket-payload-private",
    "fixture-build-tab-private",
    "fixture-build-receipt-private",
    "fixture-build-detail-private",
    "fixture-binary-private",
    "fixture-binary-path-private",
    "fixture-version-private",
    "fixture-provider-note-private",
    "fixture-provider-tab-private",
    "fixture-transport-key-private",
    "fixture-provider-run-private",
    "fixture-conversation-private",
    "fixture-host-private",
    "fixture-setup-binary-private",
    "fixture-setup-version-private",
    "fixture-method-private",
    "fixture-install-command-private",
    "fixture-docs-private.invalid",
    "fixture-source-private.invalid",
    "fixture-auth-hint-private",
    "fixture-card-version-private",
    "fixture-card-private",
    "fixture-surface-private",
    "fixture-skill-private",
    "fixture-skill-detail-private",
    "fixture-vault-audit-private",
    "fixture-vault-audit-detail-private",
    "oconn-fixture-private",
    "fixture/private/token-ref",
    "fixture-preview-private",
    "fixture-grant-private",
    "fixture-secret-ref-private",
    "fixture-request-private",
    "fixture-actor-private",
    "fixture-resource-private",
    "fixture-key-private",
    `release_session_${sourceCommit.slice(0, 16)}`,
    `SHELLX_RELEASE_SESSION_CANARY_${sourceCommit.slice(0, 16)}`,
    `Release session history ${sourceCommit.slice(0, 16)}`,
    `release-directory-${sourceCommit.slice(0, 16)}`,
    `release-file-${sourceCommit.slice(0, 16)}.txt`,
    `.release-hidden-${sourceCommit.slice(0, 16)}`,
    `release-browser-settle-task-${sourceCommit.slice(0, 16)}`,
    `release-browser-settle-tab-${sourceCommit.slice(0, 16)}`,
    "release-browser-settle-engine-private",
    `tracked-${sourceCommit.slice(0, 16)}.txt`,
    `untracked-${sourceCommit.slice(0, 16)}.txt`,
    `SHELLX_RELEASE_GIT_DIFF_${sourceCommit.slice(0, 16)}`,
    `ShellX-Release-Vault-${sourceCommit}`,
    "00000000000000000000000000000001",
    Array.from({ length: 16 }, (_, index) => index.toString(16).padStart(4, "0")).join('\",\"'),
    `release-surface-post-bookmark-${sourceCommit.slice(0, 16)}`,
    `release-surface-delete-bookmark-${sourceCommit.slice(0, 16)}`,
    `Release surface post bookmark ${sourceCommit.slice(0, 16)}`,
    `Release surface delete bookmark ${sourceCommit.slice(0, 16)}`,
    `release-surface-reorder-folder-${sourceCommit.slice(0, 16)}`,
    `release-surface-reorder-link-${sourceCommit.slice(0, 16)}`,
    `Release surface reorder folder ${sourceCommit.slice(0, 16)}`,
    `Release surface reorder link ${sourceCommit.slice(0, 16)}`,
    `https://example.com/shellx-release/reorder/${sourceCommit.slice(0, 16)}`,
    "release-surface-vault-key",
    `release-surface-vault-set-${sourceCommit.slice(0, 16)}`,
    `release-surface-vault-delete-${sourceCommit.slice(0, 16)}`,
    `SHELLX_RELEASE_VAULT_SECRET_${sourceCommit}`,
    `SHELLX_RELEASE_VAULT_E2E_SECRET_${sourceCommit}`,
    "vault-grant-release-",
    "vault-normal-grant-",
    "vault-e2e-fixture-",
    ...vaultE2eMutations.map((path) => `release-surface/e2e/${path.split("/").at(-1)}/${sourceCommit.slice(0, 16)}`),
    `release-surface/e2e/normal-grant-create/${sourceCommit.slice(0, 16)}`,
    `release-surface/e2e/normal-grant-revoke/${sourceCommit.slice(0, 16)}`,
    `ShellX release create ${sourceCommit.slice(0, 16)}`,
    `ShellX release delete ${sourceCommit.slice(0, 16)}`,
    "conn-release-surface-1",
    "conn-release-surface-2",
    `ShellX release outside create ${sourceCommit.slice(0, 16)}`,
    `ShellX release outside delete ${sourceCommit.slice(0, 16)}`,
    `SHELLX_RELEASE_BROWSER_LOG_${sourceCommit.slice(0, 16)}`,
    `SHELLX_RELEASE_POPUP_${sourceCommit.slice(0, 16)}`,
    `ShellX release report ${sourceCommit.slice(0, 16)}`,
    `SHELLX_RELEASE_BROWSER_REPORT_${sourceCommit.slice(0, 16)}`,
    `SHELLX_RELEASE_BROWSER_DEPOSIT_${sourceCommit}`,
    `SHELLX_RELEASE_BROWSER_DIALOG_${sourceCommit.slice(0, 16)}`,
    `SHELLX_RELEASE_BROWSER_SESSION_GRANT_${sourceCommit.slice(0, 16)}`,
    `release-surface/e2e/agent-request/${sourceCommit.slice(0, 16)}`,
    `shellx-release-agent-${sourceCommit.slice(0, 16)}`,
    `ShellX release agent ${sourceCommit.slice(0, 16)}`,
    `Verify exact Vault agent request ${sourceCommit.slice(0, 16)}`,
    `release-surface/outside-connector/create/${sourceCommit.slice(0, 16)}`,
    `release-surface/outside-connector/delete/${sourceCommit.slice(0, 16)}`,
    "oconn-release-surface-1",
    "oconn-release-surface-2",
    "SHELLX_RELEASE_PROVIDER_ROUTE_CANARY_035",
    "fixture-provider-output-private",
    "fixture-provider-prompt-private",
  ]) {
    assert(!reportText.includes(privateValue), `Debug API driver report retained private Browser data: ${privateValue}`);
  }

  const audit = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(audit.status, 200);
  const auditBody = await audit.json() as {
    requests: string[];
    bookmarks: Array<Record<string, unknown>>;
    vaultEntries: Array<Record<string, unknown>>;
    enginePool: {
      limits: { configuredParallelAgents: string };
      automationMode: string;
      engines: unknown[];
      waiting: unknown[];
      parkedTabs: unknown[];
    };
    panels: { horizontal: number[]; vertical: number[] };
    previewTarget: Record<string, unknown> | null;
    settings: Record<string, unknown>;
    connections: Array<Record<string, unknown>>;
    outsideConnectors: Array<Record<string, unknown>>;
    fsWatchIds: string[];
    ui: Record<string, unknown>;
    vaultE2e: {
      secretRefs: string[];
      grantIds: string[];
      audit: Array<Record<string, unknown>>;
    };
  };
  const segment = sourceCommit.slice(0, 16);
  const postBookmarkPath = `/browser/bookmarks/release-surface-post-bookmark-${segment}`;
  const deleteBookmarkPath = `/browser/bookmarks/release-surface-delete-bookmark-${segment}`;
  const reorderLinkPath = `/browser/bookmarks/release-surface-reorder-link-${segment}`;
  const reorderFolderPath = `/browser/bookmarks/release-surface-reorder-folder-${segment}`;
  const vaultAgentCancelRequests = auditBody.requests.filter((path) => ownedVaultAgentCancelPath.test(path));
  assert.equal(vaultAgentCancelRequests.length, 1, "Debug API driver must cancel exactly one owned Vault agent request");
  const fsUnwatchRequests = auditBody.requests.filter((path) => ownedFsUnwatchPath.test(path));
  assert.equal(fsUnwatchRequests.length, 4, "Debug API driver must issue exact stop and absent checks for two owned watchers");
  assert.equal(new Set(fsUnwatchRequests).size, 2, "Debug API driver must use exactly two owned filesystem watch IDs");
  const normalizedRequests = auditBody.requests.map((path) => (
    ownedVaultAgentCancelPath.test(path)
      ? "/vault/agent-requests/:owned_request_id/cancel"
      : ownedFsUnwatchPath.test(path) ? "/tools/fs_watch/:owned_watch_id"
      : ownedProviderConnectPath.test(path) ? "/connect?tabId=:owned_provider_tab"
      : ownedProviderAbortPath.test(path) ? "/abort?tabId=:owned_provider_tab"
      : ownedProviderStatePath.test(path) ? "/provider-sessions/state?tabId=:owned_provider_tab&transport=local"
      : ownedProviderSessionAbortPath.test(path) ? "/provider-sessions/abort?tabId=:owned_provider_tab"
      : ownedTauriInvokeRelayPath.test(path)
        ? path.replace(/rti-[0-9a-f]{32}/, ":owned_invoke_id")
      : ownedTeachDraftsPath.test(path)
        ? "/browser/teach/drafts?taskId=:owned_teach_task&limit=1"
      : path
  ));
  const expectedRequests = [
    "/browser/state",
    ...paths.filter((path) => path !== "/health").flatMap((path) => {
      const route = path === "/events"
        ? "/events?token=[redacted]"
        : expectedRequestPath(path, sourceCommit, tokenPath);
      if (path !== "/browser/settle") return [route];
      return [
        "/browser/task/start",
        "/browser/state",
        "/browser/settle",
        route,
        "/browser/state",
        "/browser/task/finish",
        "/browser/state",
        "/browser/tabs/close",
        "/browser/state",
      ];
    }),
    ...gitMutations,
    "/vault/keys",
    "/browser/task/start",
    "/browser/state",
    "/browser/settle",
    "/browser/vault-deposits",
    "/vault/keys",
    "/vault/keys",
    "/vault/delete",
    "/vault/keys",
    "/browser/state",
    "/browser/task/finish",
    "/browser/state",
    "/browser/tabs/close",
    "/browser/state",
    "/browser/state",
    "/browser/open",
    "/browser/state",
    "/browser/receipts?limit=1000",
    ...goalLifecycleMutations.flatMap((path) => expectedGoalLifecycleRequestPaths(path, segment)),
    "/state/ui",
    "/vault/open-panel",
    "/state/ui",
    "/state/ui",
    "/state/ui",
    "/state/ui",
    ...providerLifecycleMutations.flatMap(expectedProviderLifecycleRequestPaths),
    "/browser/bookmarks",
    "/browser/bookmarks",
    "/browser/bookmarks",
    "/browser/bookmarks",
    postBookmarkPath,
    "/browser/bookmarks",
    "/browser/bookmarks",
    "/browser/bookmarks",
    deleteBookmarkPath,
    "/browser/bookmarks",
    "/browser/bookmarks",
    "/browser/bookmarks",
    "/browser/bookmarks",
    "/browser/bookmarks",
    "/browser/bookmarks",
    "/browser/bookmarks/reorder",
    "/browser/bookmarks",
    "/browser/bookmarks",
    reorderLinkPath,
    "/browser/bookmarks",
    reorderFolderPath,
    "/browser/bookmarks",
    ...browserLifecycleMutations.flatMap(expectedBrowserLifecycleRequestPaths),
    ...browserEvidenceArtifactMutations.flatMap(expectedBrowserEvidenceArtifactRequestPaths),
    ...browserMonotonicMutations.flatMap(expectedBrowserMonotonicRequestPaths),
    ...browserTransferIntentMutations.flatMap(expectedBrowserTransferIntentRequestPaths),
    ...browserRobotMutations.flatMap(expectedBrowserRobotRequestPaths),
    ...browserPendingRequestMutations.flatMap(expectedBrowserPendingRequestPaths),
    "/browser/summary",
    "/browser/rendered-check",
    "/browser/summary",
    ...browserTeachDeveloperSurfaces.flatMap(expectedBrowserTeachDeveloperRequestPaths),
    ...previewLifecycleMutations.flatMap((path) => expectedPreviewLifecycleRequestPaths(path, sourceCommit)),
    "/connections",
    "/connections",
    "/connections",
    "/connections",
    "/connections/conn-release-surface-1",
    "/connections",
    "/connections",
    "/connections",
    "/connections",
    "/connections/conn-release-surface-2",
    "/connections",
    "/connections",
    "/connections",
    "/outside-connectors",
    "/outside-connectors",
    "/outside-connectors",
    "/outside-connectors",
    "/outside-connectors/oconn-release-surface-1",
    "/outside-connectors",
    "/outside-connectors",
    "/outside-connectors",
    "/outside-connectors",
    "/outside-connectors/oconn-release-surface-2",
    "/outside-connectors",
    "/outside-connectors",
    "/outside-connectors",
    "/state/ui",
    "/state/ui",
    "/state/ui",
    "/state/ui",
    "/state/ui",
    ...operatorGates.flatMap(expectedOperatorGateRequestPaths),
    "/release-test/clipboard",
    "/release-test/clipboard",
    "/release-test/clipboard",
    ...nativePickerLifecycles.flatMap((method) => method === "DELETE"
      ? [
        "/release-test/native-picker",
        "/release-test/native-picker",
        "/release-test/native-picker",
        "/release-test/native-picker",
      ]
      : [
        "/release-test/native-picker",
        "/release-test/native-picker",
        "/release-test/native-picker",
      ]),
    ...safeRefusalRoutes.flatMap(expectedSafeRefusalRequestPaths),
    ...vaultE2eMutations.flatMap(expectedVaultE2eRequestPaths),
    ...vaultOwnedGrantMutations.flatMap(expectedVaultOwnedGrantRequestPaths),
    ...vaultSetupMutations.flatMap(expectedVaultSetupRequestPaths),
    ...vaultAgentRequestMutations.flatMap((path) => expectedVaultAgentRequestPaths(path, sourceCommit)),
    ...fsWatchMutations.flatMap(() => [
      "/tools/fs_watch",
      "/tools/fs_watch",
      "/events/recent?limit=1000",
      "/tools/fs_watch/:owned_watch_id",
      "/tools/fs_watch/:owned_watch_id",
    ]),
    ...tauriInvokeRelayMutations.flatMap(() => [
      "/release-test/tauri-invokes",
      "/release-test/tauri-invokes/:owned_invoke_id/claim",
      "/release-test/tauri-invokes/:owned_invoke_id/complete",
      "/release-test/tauri-invokes/:owned_invoke_id",
      "/release-test/tauri-invokes/:owned_invoke_id",
      "/release-test/tauri-invokes/:owned_invoke_id",
    ]),
    "/diagnostics",
    "/github/pr/create",
    "/vault/keys",
    "/vault/get",
    "/vault/keys",
    "/vault/keys",
    "/vault/set",
    "/vault/keys",
    "/vault/keys",
    "/vault/delete",
    "/vault/keys",
    "/vault/keys",
    "/vault/set",
    "/vault/keys",
    "/vault/delete",
    "/vault/keys",
    "/vault/keys",
    "/vault/keys",
    "/browser/engine-pool",
    "/browser/engine-pool",
    "/browser/engine-pool",
    "/browser/engine-pool",
    "/browser/engine-pool",
    "/panels",
    "/panels",
    "/panels",
    "/panels",
    "/panels",
    "/preview",
    "/preview",
    "/preview",
    "/preview",
    "/preview",
    "/settings",
    "/settings",
    "/settings",
    "/settings",
    "/settings",
  ];
  const firstRequestMismatch = Math.max(normalizedRequests.length, expectedRequests.length) === 0
    ? -1
    : Array.from({ length: Math.max(normalizedRequests.length, expectedRequests.length) })
      .findIndex((_, index) => normalizedRequests[index] !== expectedRequests[index]);
  if (firstRequestMismatch >= 0) {
    throw new Error(
      `Debug API driver request audit diverged at index ${firstRequestMismatch}: `
      + `actual=${JSON.stringify(normalizedRequests.slice(firstRequestMismatch, firstRequestMismatch + 8))} `
      + `expected=${JSON.stringify(expectedRequests.slice(firstRequestMismatch, firstRequestMismatch + 8))} `
      + `lengths=${normalizedRequests.length}/${expectedRequests.length}`,
    );
  }
  assert.deepEqual(auditBody.bookmarks, [
    { bookmarkId: "fixture-bookmark-private", url: "https://fixture-private.invalid/" },
  ], "Debug API driver must remove only its exact owned Browser bookmark fixtures");
  assert.deepEqual(
    readdirSync(join(shellxHome, "git-checkpoints")),
    [],
    "Debug API driver must delete its exact receipt-owned checkpoint and prune empty owned parent directories",
  );
  for (const lane of ["start", "restart", "stop"]) {
    assert.equal(
      existsSync(join(profileRoot, `debug-api-preview-${lane}`)),
      false,
      `Debug API driver must delete its exact ${lane} Preview fixture root`,
    );
  }
  assert.deepEqual(auditBody.vaultEntries, [
    { key: "fixture-key-private", resourceKind: "secret" },
  ], "Debug API driver must remove only its exact owned Vault secret fixtures");
  assert.equal(auditBody.enginePool.limits.configuredParallelAgents, "auto");
  assert.equal(auditBody.enginePool.automationMode, "normal");
  assert.deepEqual(auditBody.enginePool.engines, []);
  assert.deepEqual(auditBody.enginePool.waiting, []);
  assert.deepEqual(auditBody.enginePool.parkedTabs, []);
  assert.deepEqual(auditBody.panels, { horizontal: [18, 56, 26], vertical: [72, 28] });
  assert.equal(auditBody.previewTarget, null, "Debug API driver must restore the exact empty Preview baseline");
  assert.deepEqual(auditBody.settings, {
    browserDownloadFolder: "",
    chatFontPx: 15,
    density: "default",
    githubGhBinary: "gh",
    theme: "black",
  });
  assert.deepEqual(auditBody.connections, [{
    id: "conn-fixture-private",
    label: "Fixture private connection",
    transport: { kind: "local" },
    createdMs: 1,
    lastUsedMs: 0,
  }], "Debug API driver must remove only its exact owned connection fixtures");
  assert.deepEqual(auditBody.outsideConnectors, [{
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
  }], "Debug API driver must remove only its exact owned disabled outside-connector fixtures");
  assert.deepEqual(auditBody.fsWatchIds, [], "Debug API driver must stop every exact owned filesystem watcher");
  assert.equal(auditBody.ui.bottomTab, "Chat");
  assert.equal(auditBody.ui.uiRevision, 6);
  assert.equal(auditBody.ui.lastUiPatchSource, "final-surface-state-ui-restore");
  assert.equal(auditBody.ui.openModal, null);
  assert.deepEqual(auditBody.ui.debugHighlights, []);
  assert.deepEqual(auditBody.ui.debugHighlightResultsBySurface, { app: [] });
  assert.deepEqual(auditBody.vaultE2e.secretRefs, []);
  assert.deepEqual(auditBody.vaultE2e.grantIds, []);
  assert.equal(auditBody.vaultE2e.audit.length, 1);
  assert.equal(auditBody.vaultE2e.audit[0]?.action, "vaultE2eReset");
  assert.equal(auditBody.vaultE2e.audit[0]?.secretExposed, false);
  assert.equal(
    existsSync(join(temp, `release-surface-files-${sourceCommit.slice(0, 16)}`)),
    false,
    "Debug API driver must remove its exact owned Files fixture before reporting success",
  );
  assert.equal(
    existsSync(join(temp, `release-surface-git-${sourceCommit.slice(0, 16)}`)),
    false,
    "Debug API driver must remove its exact owned Git repository before reporting success",
  );
  assert.deepEqual(
    readdirSync(profileRoot).filter((name) => name.startsWith("release-provider-route-")),
    [],
    "Debug API driver must delete every exact owned provider project",
  );
  for (const folder of [
    "shellx-browser-flight-recorder",
    "shellx-browser-evaluations",
    "shellx-browser-har",
    "shellx-browser-performance",
    "shellx-browser-recipes",
    "shellx-browser-storage-state",
    "shellx-browser-traces",
  ]) {
    const dir = join(profileRoot, ".shellx", "browser-artifacts", folder);
    assert.equal(
      existsSync(dir) ? readdirSync(dir).length : 0,
      0,
      `Debug API driver must delete every exact owned ${folder} artifact before reporting success`,
    );
  }
  console.log(`Release surface Debug API driver tests passed (${paths.length} exact reads, ${gitMutations.length} exact local Git mutations, ${browserVaultDepositMutations.length} exact Browser Vault deposit, ${browserWindowMutations.length} exact Browser native-window mutation, ${goalLifecycleMutations.length} exact Goal lifecycle mutations, ${vaultPanelMutations.length} exact acknowledged Vault panel mutation, ${providerLifecycleMutations.length} exact installed provider lifecycles, ${mutations.length + 1} exact Browser bookmark/engine mutations, ${browserLifecycleMutations.length} exact Browser lifecycle mutations, ${browserEvidenceArtifactMutations.length} exact Browser evidence artifact mutations, ${browserMonotonicMutations.length} exact Browser monotonic mutations, ${browserTransferIntentMutations.length} exact Browser transfer intents, ${browserRobotMutations.length} exact Browser robot lifecycles, ${browserPendingRequestMutations.length} exact Browser pending-request lifecycles, ${browserRenderedCheckMutations.length} exact Browser hidden-renderer mutation, ${connectionMutations.length} exact connection mutations, ${outsideConnectorMutations.length} exact outside-connector mutations, 3 exact UI mutations, 1 exact Settings mutation, ${vaultMutations.length} exact Vault mutations, ${vaultE2eMutations.length} exact Vault E2E mutations, ${vaultOwnedGrantMutations.length} exact guarded Vault grant mutations, ${vaultSetupMutations.length} exact Vault setup mutations, ${vaultAgentRequestMutations.length} exact Vault agent-request lifecycles, ${fsWatchMutations.length} exact filesystem-watch lifecycles, ${tauriInvokeRelayMutations.length} exact Tauri relay lifecycles, ${nativePickerLifecycles.length} exact native-picker lease lifecycles, ${operatorGates.length} exact operator gates, ${safeRefusalRoutes.length} exact safe refusals, 1 remote approval gate, 1 bounded POST read, 1 raw-reveal denial)`);
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
    fixture.kill("SIGTERM");
    await waitForExit(fixture);
  }
  rmSync(temp, { recursive: true, force: true });
}

function summarizeDriverReportFailure(path: string): string {
  if (!existsSync(path)) return "release driver did not write a report";
  try {
    const report = JSON.parse(readFileSync(path, "utf8")) as ReleaseSurfaceDriverReport;
    const failed = report.outcomes.filter((outcome) => outcome.present !== "pass"
      || outcome.invoke !== "pass"
      || outcome.effect !== "pass"
      || !["pass", "deferred-candidate-teardown"].includes(outcome.cleanup));
    return failed.length > 0
      ? `release driver failures: ${failed.map((outcome) => `${outcome.id}: ${outcome.error ?? outcome.observedEffect}`).join(" | ")}`
      : "release driver returned failure despite a green report";
  } catch (error) {
    return `release driver wrote an unreadable report: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function expectedVaultE2eRequestPaths(path: typeof vaultE2eMutations[number]): string[] {
  const sequence = ["/vault/e2e/reset"];
  if (path === "/vault/e2e/reset") {
    sequence.push("/vault/e2e/seed-secret");
  } else if (path !== "/vault/e2e/seed-secret") {
    sequence.push("/vault/e2e/seed-secret");
    if (["/vault/e2e/revoke-grant", "/vault/e2e/expire-grant", "/vault/e2e/probe-use"].includes(path)) {
      sequence.push("/vault/e2e/approve-grant");
    }
  }
  sequence.push(path, "/vault/e2e/audit", "/vault/e2e/reset", "/vault/e2e/audit");
  return sequence;
}

function expectedProviderLifecycleRequestPaths(path: typeof providerLifecycleMutations[number]): string[] {
  if (path === "/connect") {
    return [
      "/state/sessions",
      "/connect?tabId=:owned_provider_tab",
      "/state/sessions",
      "/abort?tabId=:owned_provider_tab",
      "/state/sessions",
    ];
  }
  if (path === "/provider-adapters/run") {
    return [
      "/events/recent?limit=1000",
      "/provider-adapters/run",
      "/events/recent?limit=1000",
    ];
  }
  return [
    "/provider-sessions/state?tabId=:owned_provider_tab&transport=local",
    "/provider-sessions/start",
    "/provider-sessions/state?tabId=:owned_provider_tab&transport=local",
    "/events/recent?limit=1000",
  ];
}

function expectedVaultSetupRequestPaths(path: typeof vaultSetupMutations[number]): string[] {
  const sequence = [
    "/vault/e2e/reset",
    "/vault/e2e/audit",
    "/vault/status",
    "/vault/setup/begin",
    "/vault/setup/confirm-recovery",
  ];
  if (path === "/vault/lock") sequence.push("/vault/status", "/vault/lock");
  if (path === "/vault/remember-device") {
    sequence.push(
      "/vault/status",
      "/vault/remember-device",
      "/vault/status",
      "/vault/remember-device",
    );
  }
  sequence.push(
    "/vault/status",
    "/vault/e2e/reset",
    "/vault/e2e/audit",
    "/vault/status",
  );
  return sequence;
}

function expectedVaultAgentRequestPaths(
  path: typeof vaultAgentRequestMutations[number],
  commit: string,
): string[] {
  const actorId = `shellx-release-agent-${commit.slice(0, 16)}`;
  return [
    "/vault/e2e/reset",
    "/vault/agent-requests",
    "/vault/e2e/seed-secret",
    "/vault/agent-requests",
    ...(path.endsWith("/:request_id/cancel") ? ["/vault/agent-requests/:owned_request_id/cancel"] : []),
    `/vault/agent-requests?actorId=${actorId}`,
    "/vault/e2e/reset",
    "/vault/agent-requests",
    "/vault/e2e/audit",
  ];
}

function expectedSafeRefusalRequestPaths(path: typeof safeRefusalRoutes[number]): string[] {
  const requestPath: Record<typeof safeRefusalRoutes[number], string> = {
    "/abort": "/abort?tabId=shellx-release-safe-refusal",
    "/agent_cli_setup/install/cancel": "/agent_cli_setup/install/cancel",
    "/agent_cli_setup/install/confirm": "/agent_cli_setup/install/confirm",
    "/agent_cli_setup/install/prepare": "/agent_cli_setup/install/prepare",
    "/agent_cli_setup/recheck": "/agent_cli_setup/recheck",
    "/autonomy": "/autonomy?tabId=shellx-release-safe-refusal",
    "/build/receipt": "/build/receipt?tabId=shellx-release-safe-refusal",
    "/build/start": "/build/start?tabId=shellx-release-safe-refusal",
    "/build/approve": "/build/approve?tabId=shellx-release-safe-refusal",
    "/build/complete": "/build/complete?tabId=shellx-release-safe-refusal",
    "/build/operator_note": "/build/operator_note?tabId=shellx-release-safe-refusal",
    "/build/pause": "/build/pause?tabId=shellx-release-safe-refusal",
    "/build/recheck_blocker": "/build/recheck_blocker?tabId=shellx-release-safe-refusal",
    "/build/reject": "/build/reject?tabId=shellx-release-safe-refusal",
    "/build/resume": "/build/resume?tabId=shellx-release-safe-refusal",
    "/build/stop": "/build/stop?tabId=shellx-release-safe-refusal",
    "/browser/vault/fill-receipt": "/browser/vault/fill-receipt",
    "/browser/vault/generate-receipt": "/browser/vault/generate-receipt",
    "/connections/:id/test": "/connections/shellx-release-missing-connection/test",
    "/connections/provider-scan": "/connections/provider-scan",
    "/disconnect": "/disconnect?tabId=shellx-release-safe-refusal",
    "/goal/approve": "/goal/approve?tabId=shellx-release-safe-refusal",
    "/outside-connectors/:id/simulate": "/outside-connectors/shellx-release-missing-connector/simulate",
    "/outside-connectors/:id/test": "/outside-connectors/shellx-release-missing-connector/test",
    "/permissions/:reqId/respond": "/permissions/shellx-release-missing-permission/respond",
    "/plan": "/plan?tabId=shellx-release-safe-refusal",
    "/preview/work/diagnose": "/preview/work/diagnose?tabId=shellx-release-safe-refusal",
    "/prompt": "/prompt?tabId=shellx-release-safe-refusal",
    "/provider-sessions/abort": "/provider-sessions/abort?tabId=shellx-release-safe-refusal",
    "/sessions/:id/archive": "/sessions/shellx-release-missing-session/archive",
    "/tabs/:id/archive": "/tabs/shellx-release-missing-tab/archive",
    "/state/environment/trace_export": "/state/environment/trace_export",
    "/state/grok_environment/trace_export": "/state/grok_environment/trace_export",
    "/tools/process_attach_stdout": "/tools/process_attach_stdout",
    "/tools/process_list": "/tools/process_list",
    "/tools/process_signal": "/tools/process_signal",
    "/tools/process_stats": "/tools/process_stats",
    "/tools/secret_get": "/tools/secret_get",
  };
  let statePaths: string[] = [];
  if (path === "/autonomy") {
    statePaths = ["/state/ui"];
  } else if (path.startsWith("/build/")) {
    statePaths = ["/build/state?tabId=shellx-release-safe-refusal"];
  } else if (path.startsWith("/goal/")) {
    statePaths = ["/goal/state?tabId=shellx-release-safe-refusal"];
  } else if (path === "/plan" || path === "/prompt" || path === "/tabs/:id/archive") {
    statePaths = ["/state/sessions"];
  } else if (path === "/abort" || path === "/disconnect") {
    statePaths = ["/state/sessions"];
  } else if (path === "/provider-sessions/abort") {
    statePaths = ["/provider-sessions/state?tabId=shellx-release-safe-refusal"];
  } else if (path === "/browser/vault/fill-receipt" || path === "/browser/vault/generate-receipt") {
    statePaths = ["/browser/receipts"];
  } else if (path === "/preview/work/diagnose") {
    statePaths = [
      "/preview/work/state?tabId=shellx-release-safe-refusal",
      "/build/state?tabId=shellx-release-safe-refusal",
    ];
  } else if (path === "/connections/:id/test" || path === "/connections/provider-scan") {
    statePaths = ["/connections"];
  } else if (path === "/outside-connectors/:id/simulate" || path === "/outside-connectors/:id/test") {
    statePaths = ["/outside-connectors", "/outside-connectors/events"];
  }
  return [...statePaths, requestPath[path], ...statePaths];
}

function expectedBrowserLifecycleRequestPaths(
  path: typeof browserLifecycleMutations[number],
): string[] {
  if (path === "/browser/tabs/close") {
    return [
      "/browser/task/start", "/browser/state", "/browser/settle", path,
      "/browser/state", "/browser/state", "/browser/state", "/browser/state",
    ];
  }
  if (path === "/browser/tabs/open") {
    return [
      "/browser/task/start", "/browser/state", "/browser/settle", path, "/browser/state", "/browser/tabs/close",
      "/browser/state", "/browser/task/finish", "/browser/state", "/browser/tabs/close", "/browser/state",
    ];
  }
  if (path === "/browser/tabs/focus" || path === "/browser/tabs/reorder") {
    return [
      "/browser/task/start", "/browser/state", "/browser/settle", "/browser/tabs/open", path, "/browser/state", "/browser/tabs/close",
      "/browser/state", "/browser/task/finish", "/browser/state", "/browser/tabs/close", "/browser/state",
    ];
  }
  if (path === "/browser/tabs/lock") {
    return [
      "/browser/task/start", "/browser/state", "/browser/settle", path, "/browser/state", "/browser/tabs/unlock",
      "/browser/state", "/browser/task/finish", "/browser/state", "/browser/tabs/close", "/browser/state",
    ];
  }
  if (path === "/browser/tabs/heartbeat") {
    return [
      "/browser/task/start", "/browser/state", "/browser/settle", "/browser/tabs/lock", path, "/browser/state", "/browser/tabs/unlock",
      "/browser/state", "/browser/task/finish", "/browser/state", "/browser/tabs/close", "/browser/state",
    ];
  }
  if (path === "/browser/tabs/unlock") {
    return [
      "/browser/task/start", "/browser/state", "/browser/settle", "/browser/tabs/lock", path, "/browser/state",
      "/browser/state", "/browser/task/finish", "/browser/state", "/browser/tabs/close", "/browser/state",
    ];
  }
  const sequence = ["/browser/task/start", "/browser/state", "/browser/settle"];
  if (path !== "/browser/task/start") sequence.push(path);
  sequence.push("/browser/state", "/browser/state");
  if (path !== "/browser/task/finish") sequence.push("/browser/task/finish");
  sequence.push("/browser/state");
  sequence.push("/browser/tabs/close");
  sequence.push("/browser/state");
  return sequence;
}

function expectedBrowserTeachDeveloperRequestPaths(
  surface: typeof browserTeachDeveloperSurfaces[number],
): string[] {
  const setup = [
    "/browser/task/start",
    "/browser/state",
    "/browser/settle",
    "/browser/action",
    "/browser/flight-recorder/export",
    "/browser/task/finish",
  ];
  const cleanup = [
    "/browser/state",
    "/browser/state",
    "/browser/tabs/close",
    "/browser/state",
  ];
  if (surface.path === "/browser/developer/inspect") return [...setup, surface.path, ...cleanup];
  if (surface.path === "/browser/teach/prepare") {
    return [...setup, surface.path, "/browser/teach/drafts?taskId=:owned_teach_task&limit=1", ...cleanup];
  }
  if (surface.path === "/browser/teach/revise") {
    return [...setup, "/browser/teach/prepare", surface.path, "/browser/teach/drafts?taskId=:owned_teach_task&limit=1", ...cleanup];
  }
  return [...setup, "/browser/teach/prepare", "/browser/teach/drafts?taskId=:owned_teach_task&limit=1", ...cleanup];
}

function expectedGoalLifecycleRequestPaths(
  path: typeof goalLifecycleMutations[number],
  commitSegment: string,
): string[] {
  const action = path.split("/").at(-1)!;
  const tabId = `shellx-release-goal-${action}-${commitSegment}`;
  const state = `/goal/state?tabId=${tabId}`;
  const common = [state, "/goal/start", state];
  if (path === "/goal/start") return [...common, state, "/goal/stop", state];
  if (path === "/goal/stop" || path === "/goal/reject") {
    return [...common, path, state, state];
  }
  if (path === "/goal/pause") {
    return [...common, path, state, state, "/goal/stop", state];
  }
  if (path === "/goal/resume") {
    return [...common, "/goal/pause", state, path, state, state, "/goal/stop", state];
  }
  return [...common, path, state, state, "/goal/stop", state];
}

function expectedBrowserEvidenceArtifactRequestPaths(
  path: typeof browserEvidenceArtifactMutations[number],
): string[] {
  return [
    "/browser/task/start",
    "/browser/state",
    "/browser/settle",
    ...(path === "/browser/evaluations"
      ? [
          "/browser/action",
          "/browser/flight-recorder/export",
          "/browser/task/start",
          "/browser/state",
          "/browser/settle",
          "/browser/action",
          "/browser/flight-recorder/export",
          "/browser/evaluations",
        ]
      : path === "/browser/recipes/replay"
        ? ["/browser/action", "/browser/recipes/export", "/browser/recipes/replay"]
      : [path]),
    ...(path === "/browser/evaluations"
      ? [
          "/browser/state", "/browser/task/finish", "/browser/state", "/browser/tabs/close", "/browser/state",
          "/browser/state", "/browser/task/finish", "/browser/state", "/browser/tabs/close", "/browser/state",
        ]
      : [
          "/browser/state", "/browser/task/finish", "/browser/state", "/browser/tabs/close", "/browser/state",
        ]),
  ];
}

function expectedOperatorGateRequestPaths(
  gate: typeof operatorGates[number],
): string[] {
  if (gate.path !== "/browser/dialogs/resolve") {
    return [gate.statePath, gate.requestPath, gate.statePath];
  }
  return [
    "/browser/task/start",
    "/browser/state",
    "/browser/settle",
    "/browser/dialogs",
    gate.statePath,
    gate.requestPath,
    gate.statePath,
    "/browser/state",
    "/browser/task/finish",
    "/browser/state",
    "/browser/tabs/close",
    "/browser/state",
  ];
}

function expectedBrowserMonotonicRequestPaths(
  path: typeof browserMonotonicMutations[number],
): string[] {
  return [
    "/browser/task/start",
    "/browser/state",
    "/browser/settle",
    path,
    ...(path === "/browser/logs"
      ? ["/browser/logs?limit=1000"]
      : path === "/browser/popups" ? ["/browser/popups?limit=1000"] : []),
    "/browser/receipts?limit=1000",
    "/browser/state",
    "/browser/task/finish",
    "/browser/state",
    "/browser/tabs/close",
    "/browser/state",
  ];
}

function expectedBrowserTransferIntentRequestPaths(
  path: typeof browserTransferIntentMutations[number],
): string[] {
  const direction = path.includes("downloads") ? "downloads" : "uploads";
  const completion = path.endsWith("/complete");
  return [
    "/browser/task/start",
    "/browser/state",
    "/browser/settle",
    ...(completion ? [`/browser/${direction}/request`] : [path]),
    `/browser/${direction}`,
    "/browser/receipts?limit=1000",
    ...(completion ? [path, `/browser/${direction}`, "/browser/receipts?limit=1000"] : []),
    "/browser/state",
    "/browser/task/finish",
    "/browser/state",
    "/browser/tabs/close",
    "/browser/state",
  ];
}

function expectedBrowserRobotRequestPaths(
  path: typeof browserRobotMutations[number],
): string[] {
  return [
    "/browser/task/start",
    "/browser/state",
    "/browser/settle",
    "/browser/action",
    "/browser/recipes/export",
    "/browser/robots/schedule",
    ...(path === "/browser/robots/schedule" ? [] : [path]),
    "/browser/robots?limit=1000",
    "/browser/receipts?limit=1000",
    ...(path === "/browser/robots/schedule"
      ? ["/browser/robots/cancel", "/browser/robots?limit=1000"]
      : []),
    "/browser/state",
    "/browser/task/finish",
    "/browser/state",
    "/browser/tabs/close",
    "/browser/state",
  ];
}

function expectedBrowserPendingRequestPaths(
  path: typeof browserPendingRequestMutations[number],
): string[] {
  const listPath = path === "/browser/dialogs"
    ? "/browser/dialogs?limit=1000"
    : path === "/browser/permissions"
      ? "/browser/permissions?limit=1000"
      : "/browser/requests?limit=1000";
  return [
    "/browser/task/start",
    "/browser/state",
    "/browser/settle",
    ...(path === "/browser/session-grants/apply" ? ["/browser/session-grants/request"] : [path]),
    listPath,
    "/browser/receipts?limit=1000",
    ...(path === "/browser/session-grants/apply" ? [path, listPath] : []),
    "/browser/task/finish",
    listPath,
    "/browser/receipts?limit=1000",
    "/browser/state",
    "/browser/state",
    "/browser/tabs/close",
    "/browser/state",
  ];
}

function expectedPreviewLifecycleRequestPaths(
  path: typeof previewLifecycleMutations[number],
  commit: string,
): string[] {
  const lane = path.endsWith("/restart") ? "restart" : path.endsWith("/stop") ? "stop" : "start";
  const tabId = `shellx-release-preview-${lane}-${commit.slice(0, 16)}`;
  const state = `/preview/work/state?tabId=${tabId}`;
  const stop = `/preview/work/stop?tabId=${tabId}`;
  const sequence = [state];
  if (path !== "/preview/work/start") sequence.push(`/preview/work/start?tabId=${tabId}`);
  sequence.push(`${path}?tabId=${tabId}`, state, state, stop);
  return sequence;
}

function expectedVaultOwnedGrantRequestPaths(
  path: typeof vaultOwnedGrantMutations[number],
  index: number,
): string[] {
  const sequence = ["/vault/e2e/reset", "/vault/e2e/seed-secret", "/vault/grants"];
  if (path.endsWith("/revoke")) sequence.push(`/vault/grants/vault-normal-grant-${index + 1}/revoke`);
  sequence.push("/vault/grants", "/vault/e2e/reset", "/vault/e2e/audit");
  return sequence;
}

function expectedRequestPath(path: string, commit: string, debugTokenPath: string): string {
  const segment = commit.slice(0, 16);
  const id = `release_session_${segment}`;
  const marker = `SHELLX_RELEASE_SESSION_CANARY_${segment}`;
  if (path === "/sessions/search") return `${path}?q=${encodeURIComponent(marker)}&limit=1`;
  if (path === "/sessions/history/:id") return `/sessions/history/${id}`;
  if (path === "/sessions/:id/snippet") return `/sessions/${id}/snippet?q=${encodeURIComponent(marker)}&ctxLines=2`;
  if (path === "/state/files") {
    const query = new URLSearchParams({
      tabId: `release-files-${segment}`,
      path: join(debugTokenPath, "..", `release-surface-files-${segment}`),
      includeHidden: "false",
    });
    return `${path}?${query}`;
  }
  if (path === "/browser/settle") {
    return path;
  }
  if (path === "/state/github" || path === "/state/github/items"
    || path === "/state/session_git" || path === "/state/session_git/diff") {
    const query = new URLSearchParams({
      tabId: `release-git-${segment}`,
      cwd: join(debugTokenPath, "..", `release-surface-git-${segment}`),
      ...(path.endsWith("/diff") ? { scope: "head" } : {}),
    });
    return `${path}?${query}`;
  }
  if (path === "/state/session_activity") {
    return `${path}?tabId=${encodeURIComponent("final-surface-activity-missing-session")}`;
  }
  if (path === "/state/environment") {
    return `${path}?tabId=${encodeURIComponent("final-surface-environment-missing-session")}`;
  }
  if (path === "/state/grok_environment") {
    return `${path}?tabId=${encodeURIComponent("final-surface-grok-environment-missing-session")}`;
  }
  if (path === "/preview/work/diagnose") {
    return `${path}?tabId=${encodeURIComponent("final-surface-preview-diagnose-missing-session")}`;
  }
  if (path === "/state/subagents") return `${path}?maxAgeMs=1`;
  return path;
}

async function waitForPort(path: string, child: ChildProcess): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Debug API fixture exited before startup: ${await streamText(child.stderr)}`);
    }
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { port?: number };
      if (Number.isInteger(value.port)) return Number(value.port);
    } catch {
      // Create-only state file is not ready yet.
    }
    await delay(50);
  }
  throw new Error("Debug API fixture did not publish its port");
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
