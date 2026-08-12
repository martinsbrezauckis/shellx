import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import { verifyDebugApiBrowserRead } from "./debug-api-browser-read-oracle";
import {
  exerciseDebugApiBrowserLifecycleMutation,
  isDebugApiBrowserLifecycleMutation,
} from "./debug-api-browser-lifecycle-mutation";
import {
  exerciseDebugApiBrowserEvidenceArtifactMutation,
  isDebugApiBrowserEvidenceArtifactMutation,
} from "./debug-api-browser-evidence-artifact-mutation";
import {
  exerciseDebugApiBrowserMonotonicMutation,
  isDebugApiBrowserMonotonicMutation,
} from "./debug-api-browser-monotonic-mutation";
import {
  exerciseDebugApiBrowserWindowMutation,
  isDebugApiBrowserWindowMutation,
} from "./debug-api-browser-window-mutation";
import {
  exerciseDebugApiGoalLifecycleMutation,
  isDebugApiGoalLifecycleMutation,
} from "./debug-api-goal-lifecycle-mutation";
import {
  exerciseDebugApiVaultOpenPanelMutation,
  isDebugApiVaultOpenPanelMutation,
} from "./debug-api-vault-open-panel-mutation";
import {
  exerciseDebugApiProviderLifecycleMutation,
  isDebugApiProviderLifecycleMutation,
} from "./debug-api-provider-lifecycle-mutation";
import {
  exerciseDebugApiBrowserTransferIntentMutation,
  isDebugApiBrowserTransferIntentMutation,
} from "./debug-api-browser-transfer-intent-mutation";
import {
  exerciseDebugApiBrowserRobotMutation,
  isDebugApiBrowserRobotMutation,
} from "./debug-api-browser-robot-mutation";
import {
  exerciseDebugApiBrowserPendingRequestMutation,
  isDebugApiBrowserPendingRequestMutation,
} from "./debug-api-browser-pending-request-mutation";
import { exerciseDebugApiBrowserRenderedCheckMutation } from "./debug-api-browser-rendered-check-mutation";
import {
  exerciseDebugApiPreviewLifecycleMutation,
  isDebugApiPreviewLifecycleMutation,
} from "./debug-api-preview-lifecycle-mutation";
import {
  cleanupDebugApiBrowserSettleFixture,
  debugApiBrowserSettleRequestPath,
  prepareDebugApiBrowserSettleFixture,
  verifyDebugApiBrowserSettleJson,
  type DebugApiBrowserSettleFixture,
} from "./debug-api-browser-settle-fixture";
import {
  apiJson as browserTeachApiJson,
  browserTeachCallerId,
  cleanupBrowserTeachEvidenceFixture,
  prepareBrowserTeachEvidenceFixture,
  teachPrepareRequest,
  teachRevisionRequest,
  verifyBrowserDeveloperModeDenial,
  verifyBrowserTeachListed,
  verifyBrowserTeachPrepared,
  verifyBrowserTeachRevised,
} from "./browser-teach-developer-fixture";
import {
  cleanupDebugApiFilesFixture,
  debugApiFilesRequestPath,
  prepareDebugApiFilesFixture,
  verifyDebugApiFilesJson,
  type DebugApiFilesFixture,
} from "./debug-api-files-fixture";
import {
  cleanupDebugApiGitFixture,
  debugApiGitWorktreePaths,
  debugApiGitRequestPath,
  isDebugApiGitPath,
  prepareDebugApiGitFixture,
  trackDebugApiGitCheckpointPath,
  verifyDebugApiGitJson,
  type DebugApiGitFixture,
} from "./debug-api-git-fixture";
import {
  cleanupDebugApiSessionFixture,
  debugApiSessionRequestPath,
  isDebugApiSessionFixturePath,
  prepareDebugApiSessionFixture,
  verifyDebugApiSessionHistory,
  verifyDebugApiSessionJson,
  type DebugApiSessionFixture,
} from "./debug-api-session-fixture";
import {
  exerciseDebugApiVaultE2eMutation,
  exerciseDebugApiVaultOwnedGrantMutation,
  isDebugApiVaultE2eMutation,
  isDebugApiVaultOwnedGrantMutation,
} from "./debug-api-vault-e2e-mutation";
import {
  exerciseDebugApiVaultSetupMutation,
  isDebugApiVaultSetupMutation,
} from "./debug-api-vault-setup-mutation";
import {
  exerciseDebugApiVaultAgentRequestMutation,
  isDebugApiVaultAgentRequestMutation,
} from "./debug-api-vault-agent-request-mutation";
import {
  exerciseDebugApiFsWatchMutation,
  isDebugApiFsWatchMutation,
} from "./debug-api-fs-watch-mutation";
import {
  exerciseDebugApiTauriInvokeRelayMutation,
  isDebugApiTauriInvokeRelayMutation,
} from "./debug-api-tauri-invoke-relay-mutation";
import {
  exerciseTrustedVaultFillSurface,
  supportsTrustedVaultFillSurface,
} from "./trusted-vault-fill-lifecycle";
import {
  prepareNativePickerFixture,
  removeNativePickerFixture,
} from "./native-picker-lifecycle";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverOutcome,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "debug-api-route-installed",
  kind: "debug-api-route",
  runtimeBinding: "attested-process",
  invocationTransport: "debug-api-direct",
  supportedFixtures: [
    "debug-api:installed-app-identity",
    "debug-api:installed-read-model",
    "debug-api:installed-window-capture",
    "debug-api:isolated-vault-e2e-read",
    "debug-api:isolated-session-history",
    "debug-api:isolated-files-directory",
    "debug-api:isolated-browser-task",
    "debug-api:isolated-browser-evidence-artifacts",
    "debug-api:isolated-browser-monotonic-state",
    "debug-api:isolated-browser-transfer-intent",
    "debug-api:isolated-browser-robot-recipe",
    "debug-api:isolated-browser-pending-request",
    "debug-api:isolated-browser-vault-deposit",
    "debug-api:installed-browser-window",
    "debug-api:isolated-goal-lifecycle",
    "debug-api:installed-vault-panel",
    "debug-api:isolated-local-provider-lifecycle",
    "debug-api:isolated-browser-hidden-renderer",
    "debug-api:isolated-work-preview-lifecycle",
    "debug-api:isolated-git-repository",
    "debug-api:isolated-git-repository-mutation",
    "debug-api:isolated-absent-session",
    "debug-api:isolated-browser-bookmark",
    "debug-api:isolated-browser-teach-agent-task",
    "debug-api:operator-gated-read-only",
    "debug-api:isolated-vault-secret",
    "debug-api:isolated-vault-setup-lifecycle",
    "debug-api:isolated-vault-agent-request",
    "debug-api:isolated-native-temp-fs-watch",
    "debug-api:isolated-browser-engine-pool",
    "debug-api:installed-panel-baseline",
    "debug-api:installed-preview-baseline",
    "debug-api:isolated-settings-profile",
    "debug-api:isolated-connection-preset",
    "debug-api:isolated-disabled-outside-connector",
    "debug-api:installed-ui-baseline",
    "route-driver:isolated-vault-e2e-mutation",
    "debug-api:installed-bounded-post-read",
    "debug-api:guarded-native-clipboard-preflight",
    "debug-api:isolated-native-picker-lease",
    "debug-api:remote-approval-gated-read-only",
    "debug-api:isolated-safe-refusal",
    "debug-api:isolated-tauri-invoke-relay",
    "vault-fill:trusted-https-fixed-child-webview",
  ],
  supportedCleanups: [
    "debug-api:read-only",
    "debug-api:restore-window-state",
    "debug-api:delete-isolated-run-profile",
    "debug-api:delete-owned-session-fixture",
    "debug-api:delete-owned-files-fixture",
    "debug-api:close-owned-browser-task-and-server",
    "debug-api:delete-owned-browser-artifacts-and-close-task",
    "debug-api:close-owned-browser-task-and-candidate-teardown",
    "debug-api:delete-owned-transfer-file-close-task-and-candidate-teardown",
    "debug-api:delete-owned-vault-deposit-close-task-and-candidate-teardown",
    "debug-api:close-browser-window-with-candidate-teardown",
    "debug-api:stop-owned-goal-and-delete-scratchboard",
    "debug-api:close-vault-panel-and-clear-highlight",
    "debug-api:stop-owned-provider-and-delete-project",
    "debug-api:no-provider-process-created",
    "debug-api:delete-owned-browser-robot-recipe-close-task-and-candidate-teardown",
    "debug-api:complete-owned-browser-task-and-candidate-teardown",
    "debug-api:destroy-owned-browser-hidden-renderer",
    "debug-api:stop-owned-preview-and-delete-project",
    "debug-api:delete-owned-git-fixture",
    "debug-api:delete-owned-git-fixture-and-checkpoint",
    "debug-api:delete-owned-browser-bookmark",
    "debug-api:close-owned-browser-teach-task-and-candidate-teardown",
    "debug-api:delete-owned-vault-secret",
    "debug-api:restore-browser-engine-pool",
    "debug-api:restore-panel-baseline",
    "debug-api:restore-preview-baseline",
    "debug-api:restore-settings-baseline",
    "debug-api:delete-owned-connection-preset",
    "debug-api:delete-owned-outside-connector",
    "debug-api:restore-logical-ui-baseline",
    "debug-api:reset-isolated-vault-e2e",
    "debug-api:reset-isolated-vault-e2e-and-agent-state",
    "debug-api:stop-owned-fs-watch-and-delete-native-temp-fixture",
    "debug-api:delete-owned-tauri-invoke",
    "debug-api:release-empty-or-preserve-nonempty-clipboard",
    "debug-api:clear-isolated-native-picker-lease-delete-fixture",
    "vault-fill:close-owned-route-task",
  ],
  supportedOracles: [
    "debug-api:GET-health",
    "debug-api:GET-shellxagent-json",
    "debug-api:GET-well-known-shellxagent-json",
    "debug-api:GET-agent-doc-manifest",
    "debug-api:GET-agent-doc-skills-shellx-host-SKILL-md",
    "debug-api:GET-settings",
    "debug-api:GET-connections",
    "debug-api:GET-browser-summary",
    "debug-api:GET-browser-tabs",
    "debug-api:GET-browser-profiles",
    "debug-api:GET-browser-tasks",
    "debug-api:GET-agent-doc",
    "debug-api:GET-state-header",
    "debug-api:GET-state-footer",
    "debug-api:GET-state-ui",
    "debug-api:GET-panels",
    "debug-api:GET-preview",
    "debug-api:GET-preview-work-state",
    "debug-api:GET-preview-work-logs",
    "debug-api:GET-preview-work-diagnose",
    "debug-api:GET-goal-state",
    "debug-api:GET-build-state",
    "debug-api:GET-vault-status",
    "debug-api:GET-state-sessions",
    "debug-api:GET-state-tabs-report",
    "debug-api:GET-state-agent_runs",
    "debug-api:GET-state-session_assets",
    "debug-api:GET-state-marketplace_health",
    "debug-api:GET-state-session_tooling",
    "debug-api:GET-agent-doc-shellx-host-SKILL-md",
    "debug-api:GET-browser-bookmarks",
    "debug-api:GET-browser-check",
    "debug-api:GET-browser-settle",
    "debug-api:GET-browser-developer-mode",
    "debug-api:GET-browser-dialogs",
    "debug-api:GET-browser-downloads",
    "debug-api:GET-browser-engine-pool",
    "debug-api:GET-browser-evidence",
    "debug-api:GET-browser-history",
    "debug-api:GET-browser-logs",
    "debug-api:GET-browser-network",
    "debug-api:GET-browser-permissions",
    "debug-api:GET-browser-personal-lock",
    "debug-api:GET-browser-popups",
    "debug-api:GET-browser-privacy",
    "debug-api:GET-browser-receipts",
    "debug-api:GET-browser-requests",
    "debug-api:GET-browser-robots",
    "debug-api:GET-browser-shields",
    "debug-api:GET-browser-state",
    "debug-api:GET-browser-storage-state",
    "debug-api:GET-browser-uploads",
    "debug-api:GET-build-receipts",
    "debug-api:GET-events",
    "debug-api:GET-events-recent",
    "debug-api:GET-outside-connectors",
    "debug-api:GET-outside-connectors-capabilities",
    "debug-api:GET-outside-connectors-events",
    "debug-api:GET-provider-adapters-state",
    "debug-api:GET-provider-sessions-state",
    "debug-api:GET-screenshot",
    "debug-api:GET-sessions-:id-snippet",
    "debug-api:GET-sessions-history",
    "debug-api:GET-sessions-history-:id",
    "debug-api:GET-sessions-search",
    "debug-api:GET-state-agent_cli_setup",
    "debug-api:GET-state-environment",
    "debug-api:GET-state-files",
    "debug-api:GET-state-github",
    "debug-api:GET-state-github-items",
    "debug-api:GET-state-session_git",
    "debug-api:GET-state-session_git-diff",
    "debug-api:POST-state-session_git-checkpoint:semantic-effect",
    "debug-api:POST-state-session_git-worktree:semantic-effect",
    "debug-api:POST-browser-vault-deposits:semantic-effect",
    "debug-api:POST-browser-open:semantic-effect",
    "debug-api:POST-goal-start:semantic-effect",
    "debug-api:POST-goal-stop:semantic-effect",
    "debug-api:POST-goal-pause:semantic-effect",
    "debug-api:POST-goal-resume:semantic-effect",
    "debug-api:POST-goal-reject:semantic-effect",
    "debug-api:POST-goal-complete:semantic-effect",
    "debug-api:POST-vault-open-panel:semantic-effect",
    "debug-api:POST-connect:semantic-effect",
    "debug-api:POST-provider-adapters-run:semantic-effect",
    "debug-api:POST-provider-sessions-start:semantic-effect",
    "debug-api:GET-state-model_instruction_cards",
    "debug-api:GET-state-session_activity",
    "debug-api:GET-state-skills",
    "debug-api:GET-state-subagents",
    "debug-api:GET-state-grok_environment",
    "debug-api:GET-vault-agent-requests",
    "debug-api:GET-vault-e2e-audit",
    "debug-api:GET-vault-grants",
    "debug-api:GET-vault-keys",
    "debug-api:GET-vault-resources",
    "debug-api:POST-browser-bookmarks:semantic-effect",
    "debug-api:POST-browser-action:semantic-effect",
    "debug-api:GET-browser-teach-drafts:owned-agent-readback",
    "debug-api:POST-browser-developer-inspect:developer-mode-denial",
    "debug-api:POST-browser-teach-prepare:owned-agent-draft",
    "debug-api:POST-browser-teach-revise:owned-agent-revision",
    "debug-api:POST-browser-cdp-execute:semantic-effect",
    "debug-api:delete-browser-bookmarks-bookmark-id:semantic-effect",
    "debug-api:post-browser-bookmarks-reorder:semantic-effect",
    "debug-api:POST-browser-task-start:semantic-effect",
    "debug-api:POST-browser-task-finish:semantic-effect",
    "debug-api:POST-browser-task-control:semantic-effect",
    "debug-api:POST-browser-tabs-close:semantic-effect",
    "debug-api:POST-browser-tabs-focus:semantic-effect",
    "debug-api:POST-browser-tabs-heartbeat:semantic-effect",
    "debug-api:POST-browser-tabs-lock:semantic-effect",
    "debug-api:POST-browser-tabs-open:semantic-effect",
    "debug-api:POST-browser-tabs-reorder:semantic-effect",
    "debug-api:POST-browser-tabs-unlock:semantic-effect",
    "debug-api:post-browser-evaluations:semantic-effect",
    "debug-api:post-browser-flight-recorder-export:semantic-effect",
    "debug-api:post-browser-har-export:semantic-effect",
    "debug-api:post-browser-performance-export:semantic-effect",
    "debug-api:post-browser-recipes-export:semantic-effect",
    "debug-api:post-browser-recipes-replay:semantic-effect",
    "debug-api:post-browser-storage-state-export:semantic-effect",
    "debug-api:post-browser-trace-export:semantic-effect",
    "debug-api:post-browser-logs:semantic-effect",
    "debug-api:post-browser-popups:semantic-effect",
    "debug-api:post-browser-report:semantic-effect",
    "debug-api:post-browser-downloads-request:semantic-effect",
    "debug-api:post-browser-downloads-complete:semantic-effect",
    "debug-api:post-browser-uploads-request:semantic-effect",
    "debug-api:post-browser-uploads-complete:semantic-effect",
    "debug-api:post-browser-robots-schedule:semantic-effect",
    "debug-api:post-browser-robots-run:semantic-effect",
    "debug-api:post-browser-robots-cancel:semantic-effect",
    "debug-api:post-browser-dialogs:semantic-effect",
    "debug-api:post-browser-permissions:semantic-effect",
    "debug-api:post-browser-session-grants-request:semantic-effect",
    "debug-api:post-browser-session-grants-apply:semantic-effect",
    "debug-api:post-browser-rendered-check:semantic-effect",
    "debug-api:POST-preview-work-start:semantic-effect",
    "debug-api:POST-preview-work-restart:semantic-effect",
    "debug-api:POST-preview-work-stop:semantic-effect",
    "debug-api:POST-browser-privacy:operator-denied",
    "debug-api:POST-browser-personal-lock:operator-denied",
    "debug-api:POST-browser-shields:operator-denied",
    "debug-api:POST-browser-shields-site:operator-denied",
    "debug-api:DELETE-browser-shields-site-host:operator-denied",
    "debug-api:POST-browser-developer-mode:operator-denied",
    "debug-api:POST-browser-developer-mode-approval:operator-denied",
    "debug-api:POST-vault-get:raw-reveal-denied",
    "debug-api:POST-vault-set:semantic-effect",
    "debug-api:POST-vault-delete:semantic-effect",
    "debug-api:post-vault-setup-begin:semantic-effect",
    "debug-api:post-vault-setup-confirm-recovery:semantic-effect",
    "debug-api:post-vault-lock:semantic-effect",
    "debug-api:post-vault-remember-device:semantic-effect",
    "debug-api:post-vault-agent-requests:semantic-effect",
    "debug-api:post-vault-agent-requests-request-id-cancel:semantic-effect",
    "debug-api:POST-tools-fs-watch:semantic-effect",
    "debug-api:DELETE-tools-fs-watch-watchId:semantic-effect",
    "debug-api:POST-release-test-tauri-invokes:semantic-effect",
    "debug-api:GET-release-test-tauri-invokes-id:semantic-effect",
    "debug-api:DELETE-release-test-tauri-invokes-id:semantic-effect",
    "debug-api:POST-release-test-tauri-invokes-id-claim:semantic-effect",
    "debug-api:POST-release-test-tauri-invokes-id-complete:semantic-effect",
    "debug-api:POST-browser-engine-pool:semantic-effect",
    "debug-api:POST-panels:semantic-effect",
    "debug-api:POST-preview:semantic-effect",
    "debug-api:POST-settings:semantic-effect",
    "debug-api:POST-connections:semantic-effect",
    "debug-api:DELETE-connections-id:semantic-effect",
    "debug-api:POST-outside-connectors:semantic-effect",
    "debug-api:DELETE-outside-connectors-id:semantic-effect",
    "debug-api:POST-state-ui:semantic-effect",
    "debug-api:POST-vault-e2e-reset:semantic-effect",
    "debug-api:POST-vault-e2e-seed-secret:semantic-effect",
    "debug-api:POST-vault-e2e-approve-grant:semantic-effect",
    "debug-api:POST-vault-e2e-deny-grant:semantic-effect",
    "debug-api:POST-vault-e2e-revoke-grant:semantic-effect",
    "debug-api:POST-vault-e2e-expire-grant:semantic-effect",
    "debug-api:POST-vault-e2e-probe-use:semantic-effect",
    "debug-api:POST-browser-dialogs-resolve:operator-denied",
    "debug-api:POST-browser-permissions-resolve:operator-denied",
    "debug-api:POST-browser-session-grants-resolve:operator-denied",
    "debug-api:POST-browser-task-autonomy:operator-denied",
    "debug-api:POST-vault-grants:semantic-effect",
    "debug-api:POST-vault-grants-grant-id-revoke:semantic-effect",
    "debug-api:POST-github-pr-create:approval-required",
    "debug-api:POST-diagnostics-auth",
    "debug-api:POST-release-test-clipboard:guarded-preflight-lifecycle",
    "debug-api:POST-release-test-native-picker:lease-lifecycle",
    "debug-api:GET-release-test-native-picker:lease-lifecycle",
    "debug-api:DELETE-release-test-native-picker:lease-lifecycle",
    "vault-fill:release-fixture-route:redacted-form-and-proof",
    "debug-api:POST-abort:safe-refusal",
    "debug-api:POST-agent_cli_setup-install-cancel:safe-refusal",
    "debug-api:POST-agent_cli_setup-install-confirm:safe-refusal",
    "debug-api:POST-agent_cli_setup-install-prepare:safe-refusal",
    "debug-api:POST-agent_cli_setup-recheck:safe-refusal",
    "debug-api:POST-autonomy:safe-refusal",
    "debug-api:POST-build-receipt:safe-refusal",
    "debug-api:POST-build-start:safe-refusal",
    "debug-api:POST-build-approve:safe-refusal",
    "debug-api:POST-build-complete:safe-refusal",
    "debug-api:POST-build-operator_note:safe-refusal",
    "debug-api:POST-build-pause:safe-refusal",
    "debug-api:POST-build-recheck_blocker:safe-refusal",
    "debug-api:POST-build-reject:safe-refusal",
    "debug-api:POST-build-resume:safe-refusal",
    "debug-api:POST-build-stop:safe-refusal",
    "debug-api:POST-browser-vault-fill-receipt:safe-refusal",
    "debug-api:POST-browser-vault-generate-receipt:safe-refusal",
    "debug-api:POST-connections-id-test:safe-refusal",
    "debug-api:POST-connections-provider-scan:safe-refusal",
    "debug-api:POST-disconnect:safe-refusal",
    "debug-api:POST-goal-start:safe-refusal",
    "debug-api:POST-goal-approve:safe-refusal",
    "debug-api:POST-goal-complete:safe-refusal",
    "debug-api:POST-goal-pause:safe-refusal",
    "debug-api:POST-goal-reject:safe-refusal",
    "debug-api:POST-goal-resume:safe-refusal",
    "debug-api:POST-outside-connectors-id-simulate:safe-refusal",
    "debug-api:POST-outside-connectors-id-test:safe-refusal",
    "debug-api:POST-permissions-reqId-respond:safe-refusal",
    "debug-api:POST-plan:safe-refusal",
    "debug-api:POST-preview-work-diagnose:safe-refusal",
    "debug-api:POST-prompt:safe-refusal",
    "debug-api:POST-provider-sessions-abort:safe-refusal",
    "debug-api:POST-sessions-id-archive:safe-refusal",
    "debug-api:POST-tabs-id-archive:safe-refusal",
    "debug-api:POST-state-environment-trace_export:safe-refusal",
    "debug-api:POST-state-grok_environment-trace_export:safe-refusal",
    "debug-api:POST-tools-process_attach_stdout:safe-refusal",
    "debug-api:POST-tools-process_list:safe-refusal",
    "debug-api:POST-tools-process_signal:safe-refusal",
    "debug-api:POST-tools-process_stats:safe-refusal",
    "debug-api:POST-tools-secret_get:safe-refusal",
  ],
};
const SUPPORTED_PATHS = new Set([
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
  "/events",
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
]);
const OPERATOR_GATED_ROUTES: Record<string, {
  requestPath: string;
  statePath: string;
  body?: Record<string, unknown>;
  status?: number;
  responseShape?: "nested" | "flat-error" | "flat-code-error";
  errorCode: string;
  errorMessage: string;
}> = {
  "POST /browser/privacy": {
    requestPath: "/browser/privacy",
    statePath: "/browser/privacy",
    body: { globalAdMode: "strict" },
    errorCode: "browser_privacy_requires_operator",
    errorMessage: "Browser privacy and ad-blocking changes must be performed by the ShellX operator UI",
  },
  "POST /browser/personal-lock": {
    requestPath: "/browser/personal-lock",
    statePath: "/browser/personal-lock",
    body: { enabled: true },
    errorCode: "browser_personal_lock_requires_operator",
    errorMessage: "Personal Browser Lock changes must be performed by the ShellX operator UI",
  },
  "POST /browser/shields": {
    requestPath: "/browser/shields",
    statePath: "/browser/shields",
    body: { enabled: false },
    errorCode: "browser_shields_requires_operator",
    errorMessage: "Browser Shields changes must be performed by the ShellX operator UI",
  },
  "POST /browser/shields/site": {
    requestPath: "/browser/shields/site",
    statePath: "/browser/shields",
    body: { host: "release-surface.invalid", scriptBlockingEnabled: true },
    errorCode: "browser_shields_requires_operator",
    errorMessage: "Browser Shields changes must be performed by the ShellX operator UI",
  },
  "DELETE /browser/shields/site/:host": {
    requestPath: "/browser/shields/site/release-surface.invalid",
    statePath: "/browser/shields",
    errorCode: "browser_shields_requires_operator",
    errorMessage: "Browser Shields changes must be performed by the ShellX operator UI",
  },
  "POST /browser/developer-mode": {
    requestPath: "/browser/developer-mode",
    statePath: "/browser/developer-mode",
    body: { enabled: true },
    errorCode: "developer_mode_requires_operator",
    errorMessage: "Browser Developer Mode changes must be performed by the ShellX operator UI",
  },
  "POST /browser/developer-mode/approval": {
    requestPath: "/browser/developer-mode/approval",
    statePath: "/browser/developer-mode",
    body: { host: "release-surface.invalid", fullCdpAccess: true },
    errorCode: "developer_mode_requires_operator",
    errorMessage: "Browser Developer Mode changes must be performed by the ShellX operator UI",
  },
  "POST /browser/dialogs/resolve": {
    requestPath: "/browser/dialogs/resolve",
    statePath: "/browser/dialogs",
    body: { dialogId: "release-surface-operator-gate", action: "dismiss" },
    status: 400,
    responseShape: "flat-error",
    errorCode: "browser_prompt_resolution_requires_operator",
    errorMessage: "Browser dialog and permission decisions must be performed by the ShellX operator UI",
  },
  "POST /browser/permissions/resolve": {
    requestPath: "/browser/permissions/resolve",
    statePath: "/browser/permissions",
    body: { permissionId: "release-surface-operator-gate", action: "deny" },
    status: 400,
    responseShape: "flat-error",
    errorCode: "browser_prompt_resolution_requires_operator",
    errorMessage: "Browser dialog and permission decisions must be performed by the ShellX operator UI",
  },
  "POST /browser/session-grants/resolve": {
    requestPath: "/browser/session-grants/resolve",
    statePath: "/browser/requests",
    body: { grantId: "release-surface-operator-gate", approved: false },
    responseShape: "flat-code-error",
    errorCode: "browser_session_grant_resolution_requires_operator",
    errorMessage: "Browser session grant decisions must be performed by the ShellX operator UI",
  },
  "POST /browser/task/autonomy": {
    requestPath: "/browser/task/autonomy",
    statePath: "/browser/state",
    body: { taskId: "release-surface-fixed-policy", autonomy: "assistedAutonomous" },
    responseShape: "flat-code-error",
    errorCode: "browser_task_autonomy_policy_fixed",
    errorMessage: "Browser task autonomy is fixed to assistedAutonomous and cannot be changed after task creation",
  },
};

const SAFE_REFUSAL_ROUTES: Record<string, {
  requestPath: string;
  body: Record<string, unknown>;
  status: number;
  statePaths?: string[];
}> = {
  "POST /abort": {
    requestPath: "/abort?tabId=shellx-release-safe-refusal",
    body: {},
    status: 200,
    statePaths: ["/state/sessions"],
  },
  "POST /agent_cli_setup/install/cancel": {
    requestPath: "/agent_cli_setup/install/cancel",
    body: { confirmationId: "shellx-release-missing-confirmation" },
    status: 200,
  },
  "POST /agent_cli_setup/install/confirm": {
    requestPath: "/agent_cli_setup/install/confirm",
    body: { confirmationId: "shellx-release-missing-confirmation" },
    status: 400,
  },
  "POST /agent_cli_setup/install/prepare": {
    requestPath: "/agent_cli_setup/install/prepare",
    body: { providerId: "shellx-release-invalid-provider" },
    status: 400,
  },
  "POST /agent_cli_setup/recheck": {
    requestPath: "/agent_cli_setup/recheck",
    body: { connectionId: "shellx-release-missing-connection" },
    status: 400,
  },
  "POST /autonomy": {
    requestPath: "/autonomy?tabId=shellx-release-safe-refusal",
    body: { mode: "shellx-release-invalid-mode", tabId: "shellx-release-safe-refusal" },
    status: 400,
    statePaths: ["/state/ui"],
  },
  "POST /build/receipt": {
    requestPath: "/build/receipt?tabId=shellx-release-safe-refusal",
    body: { kind: "reviewCompleted", summary: "" },
    status: 400,
    statePaths: ["/build/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /build/approve": {
    requestPath: "/build/approve?tabId=shellx-release-safe-refusal",
    body: { inject: false },
    status: 200,
    statePaths: ["/build/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /build/complete": {
    requestPath: "/build/complete?tabId=shellx-release-safe-refusal",
    body: { summary: "Release absent-state completion" },
    status: 409,
    statePaths: ["/build/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /build/operator_note": {
    requestPath: "/build/operator_note?tabId=shellx-release-safe-refusal",
    body: { text: "Release absent-state note" },
    status: 409,
    statePaths: ["/build/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /build/pause": {
    requestPath: "/build/pause?tabId=shellx-release-safe-refusal",
    body: {},
    status: 200,
    statePaths: ["/build/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /build/recheck_blocker": {
    requestPath: "/build/recheck_blocker?tabId=shellx-release-safe-refusal",
    body: {},
    status: 500,
    statePaths: ["/build/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /build/reject": {
    requestPath: "/build/reject?tabId=shellx-release-safe-refusal",
    body: {},
    status: 200,
    statePaths: ["/build/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /build/resume": {
    requestPath: "/build/resume?tabId=shellx-release-safe-refusal",
    body: {},
    status: 409,
    statePaths: ["/build/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /build/stop": {
    requestPath: "/build/stop?tabId=shellx-release-safe-refusal",
    body: {},
    status: 200,
    statePaths: ["/build/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /build/start": {
    requestPath: "/build/start?tabId=shellx-release-safe-refusal",
    body: { objective: "" },
    status: 400,
    statePaths: ["/build/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /browser/vault/fill-receipt": {
    requestPath: "/browser/vault/fill-receipt",
    body: {
      taskId: "shellx-release-safe-refusal",
      origin: "https://release-surface.invalid",
      itemId: "shellx-release-caller-authored-item",
      grantId: "shellx-release-caller-authored-grant",
    },
    status: 409,
    statePaths: ["/browser/receipts"],
  },
  "POST /browser/vault/generate-receipt": {
    requestPath: "/browser/vault/generate-receipt",
    body: {
      taskId: "shellx-release-safe-refusal",
      origin: "https://release-surface.invalid",
      itemId: "shellx-release-caller-authored-item",
    },
    status: 409,
    statePaths: ["/browser/receipts"],
  },
  "POST /connections/:id/test": {
    requestPath: "/connections/shellx-release-missing-connection/test",
    body: {},
    status: 200,
    statePaths: ["/connections"],
  },
  "POST /connections/provider-scan": {
    requestPath: "/connections/provider-scan",
    body: {},
    status: 400,
    statePaths: ["/connections"],
  },
  "POST /disconnect": {
    requestPath: "/disconnect?tabId=shellx-release-safe-refusal",
    body: {},
    status: 200,
    statePaths: ["/state/sessions"],
  },
  "POST /goal/start": {
    requestPath: "/goal/start?tabId=shellx-release-safe-refusal",
    body: { objective: "" },
    status: 400,
    statePaths: ["/goal/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /goal/approve": {
    requestPath: "/goal/approve?tabId=shellx-release-safe-refusal",
    body: {},
    status: 200,
    statePaths: ["/goal/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /goal/complete": {
    requestPath: "/goal/complete?tabId=shellx-release-safe-refusal",
    body: {},
    status: 200,
    statePaths: ["/goal/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /goal/pause": {
    requestPath: "/goal/pause?tabId=shellx-release-safe-refusal",
    body: {},
    status: 200,
    statePaths: ["/goal/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /goal/reject": {
    requestPath: "/goal/reject?tabId=shellx-release-safe-refusal",
    body: {},
    status: 200,
    statePaths: ["/goal/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /goal/resume": {
    requestPath: "/goal/resume?tabId=shellx-release-safe-refusal",
    body: {},
    status: 200,
    statePaths: ["/goal/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /outside-connectors/:id/simulate": {
    requestPath: "/outside-connectors/shellx-release-missing-connector/simulate",
    body: { senderId: "release-fixture", text: "bounded missing-connector refusal" },
    status: 400,
    statePaths: ["/outside-connectors", "/outside-connectors/events"],
  },
  "POST /outside-connectors/:id/test": {
    requestPath: "/outside-connectors/shellx-release-missing-connector/test",
    body: {},
    status: 200,
    statePaths: ["/outside-connectors", "/outside-connectors/events"],
  },
  "POST /permissions/:reqId/respond": {
    requestPath: "/permissions/shellx-release-missing-permission/respond",
    body: { outcome: "deny" },
    status: 404,
  },
  "POST /plan": {
    requestPath: "/plan?tabId=shellx-release-safe-refusal",
    body: { tabId: "shellx-release-safe-refusal", text: "Release safe-refusal plan" },
    status: 400,
    statePaths: ["/state/sessions"],
  },
  "POST /preview/work/diagnose": {
    requestPath: "/preview/work/diagnose?tabId=shellx-release-safe-refusal",
    body: { browserEvents: [] },
    status: 200,
    statePaths: [
      "/preview/work/state?tabId=shellx-release-safe-refusal",
      "/build/state?tabId=shellx-release-safe-refusal",
    ],
  },
  "POST /prompt": {
    requestPath: "/prompt?tabId=shellx-release-safe-refusal",
    body: { tabId: "shellx-release-safe-refusal", prompt: "" },
    status: 400,
    statePaths: ["/state/sessions"],
  },
  "POST /provider-sessions/abort": {
    requestPath: "/provider-sessions/abort?tabId=shellx-release-safe-refusal",
    body: {},
    status: 404,
    statePaths: ["/provider-sessions/state?tabId=shellx-release-safe-refusal"],
  },
  "POST /sessions/:id/archive": {
    requestPath: "/sessions/shellx-release-missing-session/archive",
    body: {},
    status: 404,
  },
  "POST /tabs/:id/archive": {
    requestPath: "/tabs/shellx-release-missing-tab/archive",
    body: {},
    status: 404,
    statePaths: ["/state/sessions"],
  },
  "POST /state/environment/trace_export": {
    requestPath: "/state/environment/trace_export",
    body: { tabId: "shellx-release-safe-refusal" },
    status: 400,
  },
  "POST /state/grok_environment/trace_export": {
    requestPath: "/state/grok_environment/trace_export",
    body: { tabId: "shellx-release-safe-refusal" },
    status: 400,
  },
  "POST /tools/process_attach_stdout": {
    requestPath: "/tools/process_attach_stdout",
    body: { taskId: "shellx-release-missing-process", tail_lines: 3 },
    status: 404,
  },
  "POST /tools/process_list": {
    requestPath: "/tools/process_list",
    body: {},
    status: 200,
  },
  "POST /tools/process_signal": {
    requestPath: "/tools/process_signal",
    body: { taskId: "shellx-release-missing-process", signal: "SIGTERM" },
    status: 400,
  },
  "POST /tools/process_stats": {
    requestPath: "/tools/process_stats",
    body: { taskId: "shellx-release-missing-process" },
    status: 404,
  },
  "POST /tools/secret_get": {
    requestPath: "/tools/secret_get",
    body: { path: "vault:shellx-release-never-reveal" },
    status: 403,
  },
};

function routePath(assignment: ReleaseSurfaceDriverRequest["assignments"][number]): string {
  const name = assignment.surface.name;
  const match = /^(GET|POST|DELETE) (\/\S+)$/.exec(name);
  if (!match) throw new Error(`Debug API assignment has an invalid method or path: ${name}`);
  return match[2]!;
}

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const sessionAssignments = request.assignments.filter((assignment) => isDebugApiSessionFixturePath(routePath(assignment)));
  const filesAssignments = request.assignments.filter((assignment) => routePath(assignment) === "/state/files");
  const gitAssignments = request.assignments.filter((assignment) => isDebugApiGitPath(routePath(assignment)));
  let sessionFixture: DebugApiSessionFixture | null = null;
  let filesFixture: DebugApiFilesFixture | null = null;
  let gitFixture: DebugApiGitFixture | null = null;
  const outcomes: ReleaseSurfaceDriverOutcome[] = [];
  let sessionCleanupError: string | null = null;
  let filesCleanupError: string | null = null;
  let gitCleanupError: string | null = null;
  try {
    if (sessionAssignments.length > 0) sessionFixture = prepareDebugApiSessionFixture(request);
    if (filesAssignments.length > 0) filesFixture = prepareDebugApiFilesFixture(request);
    if (gitAssignments.length > 0) gitFixture = prepareDebugApiGitFixture(request);
    for (const assignment of request.assignments) {
      let routeSettleFixture: DebugApiBrowserSettleFixture | null = null;
      let routeSettleCleanupError: string | null = null;
      try {
        if (routePath(assignment) === "/browser/settle") {
          routeSettleFixture = await prepareDebugApiBrowserSettleFixture(connection);
        }
        const outcome = await exerciseRoute(
          connection,
          request,
          assignment,
          sessionFixture,
          filesFixture,
          routeSettleFixture,
          gitFixture,
        );
        outcomes.push(outcome);
      } finally {
        if (routeSettleFixture) {
          routeSettleCleanupError = await cleanupDebugApiBrowserSettleFixture(connection, routeSettleFixture);
          const outcome = outcomes.at(-1);
          if (outcome?.id === assignment.surface.id) {
            if (routeSettleCleanupError) {
              outcome.cleanup = "fail";
              outcome.error = outcome.error
                ? `${outcome.error}; cleanup: ${routeSettleCleanupError}`
                : `cleanup: ${routeSettleCleanupError}`;
            } else {
              outcome.cleanup = "pass";
            }
          }
        }
      }
    }
  } finally {
    if (filesFixture) filesCleanupError = cleanupDebugApiFilesFixture(filesFixture);
    if (gitFixture) gitCleanupError = cleanupDebugApiGitFixture(gitFixture);
    if (sessionFixture) sessionCleanupError = cleanupDebugApiSessionFixture(sessionFixture);
  }
  const sessionOutcomeIds = new Set(sessionAssignments.map((assignment) => assignment.surface.id));
  const filesOutcomeIds = new Set(filesAssignments.map((assignment) => assignment.surface.id));
  const gitOutcomeIds = new Set(gitAssignments.map((assignment) => assignment.surface.id));
  for (const outcome of outcomes) {
    const cleanupError = sessionOutcomeIds.has(outcome.id)
      ? sessionCleanupError
      : filesOutcomeIds.has(outcome.id) ? filesCleanupError
        : gitOutcomeIds.has(outcome.id) ? gitCleanupError : null;
    if (!sessionOutcomeIds.has(outcome.id) && !filesOutcomeIds.has(outcome.id)
      && !gitOutcomeIds.has(outcome.id)) continue;
    if (cleanupError) {
      outcome.cleanup = "fail";
      outcome.error = outcome.error
        ? `${outcome.error}; cleanup: ${cleanupError}`
        : `cleanup: ${cleanupError}`;
    } else {
      outcome.cleanup = "pass";
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

async function exerciseRoute(
  connection: { base: string; token: string },
  request: ReleaseSurfaceDriverRequest,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
  sessionFixture: DebugApiSessionFixture | null,
  filesFixture: DebugApiFilesFixture | null,
  settleFixture: DebugApiBrowserSettleFixture | null,
  gitFixture: DebugApiGitFixture | null,
): Promise<ReleaseSurfaceDriverOutcome> {
  const canonicalPath = routePath(assignment);
  const method = assignment.surface.name.split(" ", 1)[0];
  if ((method === "POST" && canonicalPath === "/browser/bookmarks")
    || (method === "DELETE" && canonicalPath === "/browser/bookmarks/:bookmark_id")) {
    return exerciseBrowserBookmarkMutation(connection, request, assignment, method);
  }
  if (method === "POST" && canonicalPath === "/browser/bookmarks/reorder") {
    return exerciseBrowserBookmarkReorder(connection, request, assignment);
  }
  if (isBrowserTeachDeveloperSurface(assignment.surface.name)) {
    return exerciseBrowserTeachDeveloperSurface(connection, assignment);
  }
  if (isDebugApiBrowserLifecycleMutation(assignment.surface.name)) {
    return exerciseDebugApiBrowserLifecycleMutation(connection, assignment);
  }
  if (isDebugApiBrowserEvidenceArtifactMutation(assignment.surface.name)) {
    return exerciseDebugApiBrowserEvidenceArtifactMutation(connection, request, assignment);
  }
  if (isDebugApiBrowserMonotonicMutation(assignment.surface.name)) {
    return exerciseDebugApiBrowserMonotonicMutation(connection, request, assignment);
  }
  if (isDebugApiBrowserWindowMutation(assignment.surface.name)) {
    return exerciseDebugApiBrowserWindowMutation(connection, assignment);
  }
  if (isDebugApiBrowserTransferIntentMutation(assignment.surface.name)) {
    return exerciseDebugApiBrowserTransferIntentMutation(connection, request, assignment);
  }
  if (isDebugApiBrowserRobotMutation(assignment.surface.name)) {
    return exerciseDebugApiBrowserRobotMutation(connection, request, assignment);
  }
  if (isDebugApiBrowserPendingRequestMutation(assignment.surface.name)) {
    return exerciseDebugApiBrowserPendingRequestMutation(connection, request, assignment);
  }
  if (assignment.surface.name === "POST /browser/rendered-check") {
    return exerciseDebugApiBrowserRenderedCheckMutation(connection, assignment);
  }
  if (isDebugApiPreviewLifecycleMutation(assignment.surface.name)) {
    return exerciseDebugApiPreviewLifecycleMutation(connection, request, assignment);
  }
  if (assignment.surface.name in OPERATOR_GATED_ROUTES) {
    return exerciseOperatorGatedRoute(connection, assignment);
  }
  if (assignment.surface.name === "POST /vault/get") {
    return exerciseVaultRawRevealDenial(connection, assignment);
  }
  if (assignment.surface.name === "POST /browser/vault-deposits") {
    return exerciseDebugApiBrowserVaultDeposit(connection, request, assignment);
  }
  if (isDebugApiGoalLifecycleMutation(assignment.surface.name)) {
    return exerciseDebugApiGoalLifecycleMutation(connection, request, assignment);
  }
  if (isDebugApiVaultOpenPanelMutation(assignment.surface.name)) {
    return exerciseDebugApiVaultOpenPanelMutation(connection, assignment);
  }
  if (isDebugApiProviderLifecycleMutation(assignment.surface.name)) {
    return exerciseDebugApiProviderLifecycleMutation(connection, request, assignment);
  }
  if (assignment.surface.name === "POST /vault/set" || assignment.surface.name === "POST /vault/delete") {
    return exerciseVaultMutation(connection, request, assignment);
  }
  if (isDebugApiVaultSetupMutation(assignment.surface.name)) {
    return exerciseDebugApiVaultSetupMutation(connection, request, assignment);
  }
  if (isDebugApiVaultAgentRequestMutation(assignment.surface.name)) {
    return exerciseDebugApiVaultAgentRequestMutation(connection, request, assignment);
  }
  if (isDebugApiFsWatchMutation(assignment.surface.name)) {
    return exerciseDebugApiFsWatchMutation(connection, request, assignment);
  }
  if (isDebugApiTauriInvokeRelayMutation(assignment.surface.name)) {
    return exerciseDebugApiTauriInvokeRelayMutation(connection, assignment);
  }
  if (supportsTrustedVaultFillSurface(assignment)) {
    return exerciseTrustedVaultFillSurface(connection, request, assignment);
  }
  if (assignment.surface.name === "POST /browser/engine-pool") {
    return exerciseBrowserEnginePoolMutation(connection, assignment);
  }
  if (assignment.surface.name === "POST /panels") {
    return exercisePanelMutation(connection, assignment);
  }
  if (assignment.surface.name === "POST /preview") {
    return exercisePreviewTargetMutation(connection, assignment);
  }
  if (assignment.surface.name === "POST /settings") {
    return exerciseSettingsMutation(connection, assignment);
  }
  if (assignment.surface.name === "POST /connections" || assignment.surface.name === "DELETE /connections/:id") {
    return exerciseConnectionMutation(connection, request, assignment);
  }
  if (assignment.surface.name === "POST /outside-connectors" || assignment.surface.name === "DELETE /outside-connectors/:id") {
    return exerciseOutsideConnectorMutation(connection, request, assignment);
  }
  if (assignment.surface.name === "POST /state/ui") {
    return exerciseUiStateMutation(connection, assignment);
  }
  if (isDebugApiVaultE2eMutation(assignment.surface.name)) {
    return exerciseDebugApiVaultE2eMutation(connection, request, assignment);
  }
  if (isDebugApiVaultOwnedGrantMutation(assignment.surface.name)) {
    return exerciseDebugApiVaultOwnedGrantMutation(connection, request, assignment);
  }
  if (assignment.surface.name === "POST /github/pr/create") {
    return exerciseGithubPrApprovalGate(connection, assignment);
  }
  if (assignment.surface.name === "POST /diagnostics") {
    return exerciseDiagnosticsAuthRead(connection, assignment);
  }
  if (assignment.surface.name === "POST /release-test/clipboard") {
    return exerciseReleaseClipboardLease(connection, assignment);
  }
  if (assignment.surface.name.endsWith(" /release-test/native-picker")) {
    return exerciseReleaseNativePickerLease(connection, request, assignment);
  }
  if (assignment.surface.name === "POST /state/session_git/checkpoint"
    || assignment.surface.name === "POST /state/session_git/worktree") {
    return exerciseDebugApiGitMutation(connection, request, assignment, gitFixture);
  }
  if (assignment.surface.name in SAFE_REFUSAL_ROUTES) {
    return exerciseSafeRefusalRoute(connection, assignment);
  }
  const usesSessionFixture = isDebugApiSessionFixturePath(canonicalPath);
  const usesFilesFixture = canonicalPath === "/state/files";
  const usesSettleFixture = canonicalPath === "/browser/settle";
  const usesGitFixture = isDebugApiGitPath(canonicalPath);
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: usesSessionFixture || usesFilesFixture || usesSettleFixture || usesGitFixture ? "fail" : "pass",
    observedEffect: "No Debug API result was observed.",
  };
  try {
    if (method !== "GET" || !SUPPORTED_PATHS.has(canonicalPath)) throw new Error(`installed identity fixture does not support ${assignment.surface.name}`);
    if (usesSessionFixture && !sessionFixture) throw new Error("session history route requires its owned fixture");
    if (usesFilesFixture && !filesFixture) throw new Error("Files route requires its owned fixture");
    if (usesSettleFixture && !settleFixture) throw new Error("Browser settle route requires its owned task fixture");
    if (usesGitFixture && !gitFixture) throw new Error("session Git route requires its owned repository fixture");
    outcome.present = "pass";
    const sessionPath = debugApiSessionRequestPath(canonicalPath, sessionFixture);
    const filesPath = debugApiFilesRequestPath(sessionPath, filesFixture);
    const settlePath = debugApiBrowserSettleRequestPath(filesPath, settleFixture);
    const gitPath = debugApiGitRequestPath(settlePath, gitFixture);
    const absentTab = canonicalPath === "/state/session_activity"
      ? "final-surface-activity-missing-session"
      : canonicalPath === "/state/environment"
        ? "final-surface-environment-missing-session"
        : canonicalPath === "/state/grok_environment"
          ? "final-surface-grok-environment-missing-session"
          : canonicalPath === "/preview/work/diagnose"
            ? "final-surface-preview-diagnose-missing-session"
          : null;
    const requestPath = absentTab
      ? `${gitPath}?tabId=${encodeURIComponent(absentTab)}`
      : canonicalPath === "/state/subagents" ? `${gitPath}?maxAgeMs=1` : gitPath;
    if (canonicalPath === "/events") {
      const effect = await verifyAuthenticatedEventStream(connection);
      outcome.invoke = "pass";
      outcome.effect = "pass";
      outcome.observedEffect = effect;
      return outcome;
    }
    const response = canonicalPath === "/build/receipts"
      ? await fetchRouteAllowingAbsentBuild(connection, requestPath)
      : await fetchRoute(connection, requestPath);
    outcome.invoke = "pass";
    const effect = canonicalPath === "/screenshot"
      ? await verifyScreenshotBody(response)
      : canonicalPath === "/sessions/history/:id"
        ? verifyDebugApiSessionHistory(await response.text(), sessionFixture)
      : canonicalPath.endsWith("SKILL.md")
        ? verifySkillBody(await response.text())
      : verifyJsonBody(canonicalPath, await response.json(), request, sessionFixture, filesFixture, settleFixture, gitFixture);
    outcome.effect = "pass";
    outcome.observedEffect = effect;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}

function isBrowserTeachDeveloperSurface(surfaceName: string): boolean {
  return new Set([
    "GET /browser/teach/drafts",
    "POST /browser/developer/inspect",
    "POST /browser/teach/prepare",
    "POST /browser/teach/revise",
  ]).has(surfaceName);
}

async function exerciseBrowserTeachDeveloperSurface(
  connection: { base: string; token: string },
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
    observedEffect: "No owned Browser Teach or Developer result was observed.",
  };
  let fixture: Awaited<ReturnType<typeof prepareBrowserTeachEvidenceFixture>> | null = null;
  try {
    const callerSessionId = browserTeachCallerId();
    fixture = await prepareBrowserTeachEvidenceFixture(connection, callerSessionId);
    outcome.present = "pass";
    if (assignment.surface.name === "POST /browser/developer/inspect") {
      const inspection = await browserTeachApiJson(connection, "POST", "/browser/developer/inspect", {
        taskId: fixture.browser.taskId,
        browserTabId: fixture.browser.browserTabId,
      }, callerSessionId);
      outcome.invoke = "pass";
      verifyBrowserDeveloperModeDenial(inspection, fixture);
      outcome.effect = "pass";
      outcome.observedEffect = "POST /browser/developer/inspect returned the fixed Developer Mode denial for one exact agent-owned task without enabling Developer Mode, evaluating arbitrary CDP, or changing Browser task state.";
      return outcome;
    }

    const prepared = await browserTeachApiJson(
      connection,
      "POST",
      "/browser/teach/prepare",
      teachPrepareRequest(fixture),
      callerSessionId,
    );
    const draft = verifyBrowserTeachPrepared(prepared, fixture);
    if (assignment.surface.name === "POST /browser/teach/prepare") {
      outcome.invoke = "pass";
      const listed = await browserTeachApiJson(
        connection,
        "GET",
        `/browser/teach/drafts?taskId=${encodeURIComponent(fixture.browser.taskId)}&limit=1`,
        undefined,
        callerSessionId,
      );
      verifyBrowserTeachListed(listed, fixture, draft);
      outcome.effect = "pass";
      outcome.observedEffect = "POST /browser/teach/prepare derived one immutable draft and revision from exact owned Flight Recorder evidence and confirmed it through the matching agent-scoped draft readback; no approval or recipe replay route was invoked.";
      return outcome;
    }
    if (assignment.surface.name === "GET /browser/teach/drafts") {
      outcome.invoke = "pass";
      const listed = await browserTeachApiJson(
        connection,
        "GET",
        `/browser/teach/drafts?taskId=${encodeURIComponent(fixture.browser.taskId)}&limit=1`,
        undefined,
        callerSessionId,
      );
      verifyBrowserTeachListed(listed, fixture, draft);
      outcome.effect = "pass";
      outcome.observedEffect = "GET /browser/teach/drafts returned exactly the draft owned by the matching MCP task session after fixture preparation; no operator approval or replay authority was exposed.";
      return outcome;
    }
    const revised = await browserTeachApiJson(
      connection,
      "POST",
      "/browser/teach/revise",
      teachRevisionRequest(draft),
      callerSessionId,
    );
    outcome.invoke = "pass";
    const current = verifyBrowserTeachRevised(revised, fixture, draft);
    const listed = await browserTeachApiJson(
      connection,
      "GET",
      `/browser/teach/drafts?taskId=${encodeURIComponent(fixture.browser.taskId)}&limit=1`,
      undefined,
      callerSessionId,
    );
    verifyBrowserTeachListed(listed, fixture, current);
    outcome.effect = "pass";
    outcome.observedEffect = "POST /browser/teach/revise performed one compare-and-swap revision for the exact agent-owned draft and confirmed the new current revision through task-owner readback; approval and application remained unavailable.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (fixture) {
      const cleanupError = await cleanupBrowserTeachEvidenceFixture(connection, fixture);
      if (cleanupError) {
        outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
      } else {
        outcome.cleanup = "pass";
      }
    }
  }
  return outcome;
}

async function exerciseDebugApiGitMutation(
  connection: { base: string; token: string },
  request: ReleaseSurfaceDriverRequest,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
  fixture: DebugApiGitFixture | null,
): Promise<ReleaseSurfaceDriverOutcome> {
  const checkpoint = assignment.surface.name.endsWith("/checkpoint");
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No owned session Git mutation was observed.",
  };
  try {
    if (!fixture) throw new Error("session Git mutation requires its owned repository fixture");
    const baseline = runGitProbe(fixture.localPath, ["status", "--porcelain=v1"]);
    if (!baseline.includes(fixture.trackedName) || !baseline.includes(fixture.untrackedName)) {
      throw new Error("owned session Git mutation fixture omitted its exact dirty baseline");
    }
    outcome.present = "pass";
    const segment = request.sourceCommit.slice(0, 16);
    const label = `ShellX release checkpoint ${segment}`;
    const branch = `release-surface-worktree-${segment}`;
    const response = await fetch(`${connection.base}${checkpoint ? "/state/session_git/checkpoint" : "/state/session_git/worktree"}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(checkpoint
        ? { tabId: fixture.tabId, cwd: fixture.apiPath, label }
        : { tabId: fixture.tabId, cwd: fixture.apiPath, sourceBranch: "release-proof", newBranch: branch }),
    });
    outcome.invoke = "pass";
    if (response.status !== 200) throw new Error(`${assignment.surface.name} returned ${response.status}`);
    const body = requireObject(await response.json(), assignment.surface.name);
    if (checkpoint) {
      requireExactKeys(body, ["checkpoint", "lastError", "ok"], assignment.surface.name);
      if (body.ok !== true || body.lastError !== null) throw new Error("checkpoint response omitted its exact success contract");
      const created = requireObject(body.checkpoint, "checkpoint response.checkpoint");
      requireExactKeys(created, [
        "branch", "conflicts", "createdAtMs", "head", "id", "label", "path", "repoRoot",
        "staged", "unstaged", "untracked", "untrackedSnapshot", "worktreeFingerprint",
      ], "checkpoint response.checkpoint");
      if (typeof created.id !== "string" || !created.id || typeof created.path !== "string") {
        throw new Error("checkpoint response omitted its owned id or path");
      }
      const checkpointPath = trackDebugApiGitCheckpointPath(fixture, created.path, created.id, request);
      if (created.label !== label || created.branch !== "release-proof" || !samePortablePath(created.repoRoot, fixture.apiPath, request.platform)
        || created.staged !== 0 || created.unstaged !== 1 || created.untracked !== 1 || created.conflicts !== 0
        || !Number.isSafeInteger(created.createdAtMs) || typeof created.head !== "string" || !created.head
        || typeof created.worktreeFingerprint !== "string" || !created.worktreeFingerprint) {
        throw new Error("checkpoint response did not describe the exact owned dirty repository");
      }
      const snapshot = requireObject(created.untrackedSnapshot, "checkpoint response.untrackedSnapshot");
      requireExactKeys(snapshot, ["bytes", "captured", "files", "manifestPath", "skipped", "truncated"], "checkpoint response.untrackedSnapshot");
      if (snapshot.files !== 1 || snapshot.captured !== 1 || snapshot.skipped !== 0 || snapshot.truncated !== false
        || !Number.isSafeInteger(snapshot.bytes) || Number(snapshot.bytes) <= 0
        || typeof snapshot.manifestPath !== "string" || !snapshot.manifestPath.endsWith("untracked.json")
        || !existsSync(join(checkpointPath, "untracked.json"))
        || !existsSync(join(checkpointPath, "checkpoint.json"))
        || !existsSync(join(checkpointPath, "unstaged.patch"))
        || !existsSync(join(checkpointPath, "staged.patch"))
        || !existsSync(join(checkpointPath, "status.txt"))) {
        throw new Error("checkpoint response did not materialize its exact bounded snapshot artifacts");
      }
      outcome.observedEffect = "POST /state/session_git/checkpoint materialized one exact metadata, patch, status, and untracked snapshot set for the owned dirty repository; all paths and contents were omitted from the report.";
    } else {
      requireExactKeys(body, ["lastError", "newBranch", "ok", "output", "sourceBranch", "worktreePath"], assignment.surface.name);
      const expected = debugApiGitWorktreePaths(fixture, branch, request);
      if (body.ok !== true || body.lastError !== null || body.sourceBranch !== "release-proof"
        || body.newBranch !== branch || !samePortablePath(body.worktreePath, expected.apiPath, request.platform)
        || typeof body.output !== "string" || !existsSync(expected.localPath)) {
        throw new Error("worktree response omitted its exact owned local worktree transition");
      }
      if (runGitProbe(expected.localPath, ["branch", "--show-current"]).trim() !== branch) {
        throw new Error("worktree response path did not resolve to the exact owned branch");
      }
      outcome.observedEffect = "POST /state/session_git/worktree created one exact local worktree and branch under the owned repository's .worktrees container; path and command output were omitted from the report.";
    }
    const after = runGitProbe(fixture.localPath, ["status", "--porcelain=v1"]);
    const baselineRows = baseline.trimEnd().split("\n");
    const expectedRows = checkpoint ? baselineRows : [...baselineRows, "?? .worktrees/"];
    const afterRows = after.trimEnd().split("\n");
    if (afterRows.length !== expectedRows.length || expectedRows.some((row) => !afterRows.includes(row))) {
      throw new Error("session Git mutation changed the owned primary worktree outside its exact .worktrees addition");
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}

function runGitProbe(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) throw new Error(`owned Git verification failed with status ${result.status ?? "unknown"}`);
  return result.stdout;
}

async function exerciseDebugApiBrowserVaultDeposit(
  connection: { base: string; token: string },
  request: ReleaseSurfaceDriverRequest,
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
    observedEffect: "No write-only Browser Vault deposit was observed.",
  };
  const segment = request.sourceCommit.slice(0, 16);
  const secret = `SHELLX_RELEASE_BROWSER_DEPOSIT_${request.sourceCommit}`;
  const label = `ShellX release Browser deposit ${segment}`;
  let fixture: DebugApiBrowserSettleFixture | null = null;
  let baseline: unknown = null;
  let vaultRef: string | null = null;
  try {
    baseline = await vaultKeyDirectory(connection);
    fixture = await prepareDebugApiBrowserSettleFixture(connection);
    outcome.present = "pass";
    const response = await fetch(`${connection.base}/browser/vault-deposits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        taskId: fixture.taskId,
        label,
        secretValue: secret,
        sourceUrl: fixture.url,
      }),
    });
    outcome.invoke = "pass";
    if (response.status !== 200) throw new Error(`POST /browser/vault-deposits returned ${response.status}`);
    const responseText = await response.text();
    if (responseText.includes(secret)) throw new Error("Browser Vault deposit response echoed secret material");
    const body = requireObject(responseText.trim() ? JSON.parse(responseText) : {}, "POST /browser/vault-deposits");
    requireExactKeys(body, [
      "depositId", "label", "receipt", "secretExposed", "serverReceipt", "sourceUrl",
      "storageCommitHash", "taskId", "vaultRef",
    ], "POST /browser/vault-deposits");
    vaultRef = typeof body.vaultRef === "string" ? body.vaultRef : null;
    const serverReceipt = requireObject(body.serverReceipt, "Browser Vault deposit serverReceipt");
    const receipt = requireObject(body.receipt, "Browser Vault deposit receipt");
    if (typeof body.depositId !== "string" || !body.depositId.startsWith("browser-deposit-")
      || body.label !== label || body.taskId !== fixture.taskId || body.sourceUrl !== fixture.url
      || body.secretExposed !== false || !vaultRef?.startsWith("browser-deposits/")
      || typeof body.storageCommitHash !== "string" || !/^[a-f0-9]{64}$/.test(body.storageCommitHash)
      || serverReceipt.id !== body.depositId || serverReceipt.payloadHash !== body.storageCommitHash
      || typeof serverReceipt.createdMs !== "number" || serverReceipt.fromToken !== "browser-agent-token:shellx-browser"
      || receipt.kind !== "browserVaultDepositCreated" || receipt.taskId !== fixture.taskId) {
      throw new Error("Browser Vault deposit response omitted its exact write-only receipt contract");
    }
    const changed = await vaultKeyDirectory(connection);
    if (!vaultDirectoryHasKey(changed, vaultRef)) throw new Error("Browser Vault deposit did not create its exact Vault metadata entry");
    outcome.effect = "pass";
    outcome.observedEffect = "POST /browser/vault-deposits wrote one synthetic secret into the isolated Vault and returned matching write-only server and Browser receipts without exposing the value; identifiers, URL, label, and hashes were omitted from the report.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    try {
      if (vaultRef) {
        const current = await vaultKeyDirectory(connection);
        if (vaultDirectoryHasKey(current, vaultRef)) {
          await expectVaultMutationResponse(connection, "/vault/delete", { key: vaultRef }, vaultRef);
        }
      }
      const restored = await vaultKeyDirectory(connection);
      if (baseline === null || JSON.stringify(restored) !== JSON.stringify(baseline)) {
        throw new Error("Browser Vault deposit did not restore the isolated Vault directory byte-for-byte");
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (fixture) {
      const browserCleanupError = await cleanupDebugApiBrowserSettleFixture(connection, fixture);
      if (browserCleanupError) cleanupErrors.push(browserCleanupError);
    }
    if (cleanupErrors.length === 0) {
      outcome.cleanup = "pass";
    } else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

async function exerciseVaultRawRevealDenial(
  connection: { base: string; token: string },
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
    observedEffect: "No raw Vault reveal denial was observed.",
  };
  try {
    const baseline = await (await fetchRoute(connection, "/vault/keys")).json();
    outcome.present = "pass";
    const response = await fetch(`${connection.base}/vault/get`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key: "release-surface-vault-key", rawRevealApproved: false }),
    });
    outcome.invoke = "pass";
    if (response.status !== 403) throw new Error(`POST /vault/get returned ${response.status} instead of 403`);
    const body = requireObject(await response.json(), "POST /vault/get");
    requireExactKeys(body, ["code", "isError", "message", "reason"], "POST /vault/get");
    if (body.code !== "RAW_SECRET_REVEAL_DENIED"
      || body.reason !== "raw_secret_reveal_denied"
      || body.message !== "raw Vault secret reveal requires explicit user approval; use mediated Vault fill or injection tools"
      || body.isError !== true
      || "value" in body || "secret" in body) {
      throw new Error("POST /vault/get returned the wrong raw-reveal denial contract");
    }
    const after = await (await fetchRoute(connection, "/vault/keys")).json();
    if (JSON.stringify(after) !== JSON.stringify(baseline)) {
      throw new Error("POST /vault/get changed Vault key metadata despite its raw-reveal denial");
    }
    outcome.effect = "pass";
    outcome.cleanup = "pass";
    outcome.observedEffect = "POST /vault/get returned the exact raw-secret denial without a value field and preserved Vault key metadata byte-for-byte.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}

async function exerciseVaultMutation(
  connection: { base: string; token: string },
  request: ReleaseSurfaceDriverRequest,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const create = assignment.surface.name === "POST /vault/set";
  const segment = request.sourceCommit.slice(0, 16);
  const key = `release-surface-vault-${create ? "set" : "delete"}-${segment}`;
  const secret = `SHELLX_RELEASE_VAULT_SECRET_${request.sourceCommit}`;
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No isolated Vault mutation was observed.",
  };
  let baseline: unknown = null;
  try {
    baseline = await vaultKeyDirectory(connection);
    if (vaultDirectoryHasKey(baseline, key)) throw new Error("owned Vault mutation key already exists");
    outcome.present = "pass";
    if (!create) {
      await expectVaultMutationResponse(connection, "/vault/set", { key, value: secret }, key);
      const seeded = await vaultKeyDirectory(connection);
      if (!vaultDirectoryHasKey(seeded, key)) throw new Error("Vault delete fixture was not seeded");
    }
    await expectVaultMutationResponse(
      connection,
      create ? "/vault/set" : "/vault/delete",
      create ? { key, value: secret } : { key },
      key,
    );
    outcome.invoke = "pass";
    const changed = await vaultKeyDirectory(connection);
    if (vaultDirectoryHasKey(changed, key) !== create) {
      throw new Error(`${assignment.surface.name} did not produce its exact owned key-directory transition`);
    }
    outcome.effect = "pass";
    outcome.observedEffect = create
      ? "POST /vault/set created exactly one owned metadata entry without returning or reading its value."
      : "POST /vault/delete removed exactly its prepared owned metadata entry without returning or reading its value.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      const current = await vaultKeyDirectory(connection);
      if (vaultDirectoryHasKey(current, key)) {
        await expectVaultMutationResponse(connection, "/vault/delete", { key }, key);
      }
      const restored = await vaultKeyDirectory(connection);
      if (baseline === null || JSON.stringify(restored) !== JSON.stringify(baseline)) {
        throw new Error("isolated Vault key directory was not restored byte-for-byte");
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

async function exerciseConnectionMutation(
  connection: { base: string; token: string },
  request: ReleaseSurfaceDriverRequest,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const create = assignment.surface.name === "POST /connections";
  const label = `ShellX release ${create ? "create" : "delete"} ${request.sourceCommit.slice(0, 16)}`;
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No isolated connection-preset mutation was observed.",
  };
  let baseline: unknown = null;
  try {
    baseline = await connectionDirectory(connection);
    if (connectionPresetByLabel(baseline, label)) throw new Error("owned connection fixture already exists");
    outcome.present = "pass";
    const saved = await saveConnectionPreset(connection, label);
    if (create) outcome.invoke = "pass";
    const seeded = await connectionDirectory(connection);
    const observed = connectionPresetByLabel(seeded, label);
    if (!observed || observed.id !== saved.id || !isDeepStrictEqual(observed, saved)) {
      throw new Error("POST /connections did not persist its exact generated preset");
    }
    if (!create) {
      await deleteConnectionPreset(connection, saved.id);
      outcome.invoke = "pass";
      const changed = await connectionDirectory(connection);
      if (connectionPresetByLabel(changed, label)) {
        throw new Error("DELETE /connections/:id did not remove its exact prepared preset");
      }
    }
    outcome.effect = "pass";
    outcome.observedEffect = create
      ? "POST /connections created exactly one inert local preset without contacting a target or retaining its generated identity."
      : "DELETE /connections/:id removed exactly its prepared inert local preset without contacting a target or retaining its generated identity.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      const current = await connectionDirectory(connection);
      const owned = connectionPresetByLabel(current, label);
      if (owned) await deleteConnectionPreset(connection, owned.id);
      const restored = await connectionDirectory(connection);
      if (baseline === null || !isDeepStrictEqual(restored, baseline)) {
        throw new Error("isolated connection directory was not restored byte-for-byte");
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

type PublicConnectionPreset = {
  id: string;
  label: string;
  transport: { kind: string };
  createdMs: number;
  lastUsedMs: number;
  providerScan?: unknown[];
};

async function connectionDirectory(connection: { base: string; token: string }): Promise<unknown> {
  const body = requireObject(await (await fetchRoute(connection, "/connections")).json(), "GET /connections");
  requireExactKeys(body, ["presets"], "GET /connections");
  const presets = requireArray(body, "presets", "GET /connections");
  for (const value of presets) validatePublicConnectionPreset(value, "GET /connections preset");
  return body;
}

function connectionPresetByLabel(value: unknown, label: string): PublicConnectionPreset | null {
  const body = requireObject(value, "connection directory");
  const matches = requireArray(body, "presets", "connection directory")
    .map((entry) => validatePublicConnectionPreset(entry, "connection directory preset"))
    .filter((entry) => entry.label === label);
  if (matches.length > 1) throw new Error("owned connection label matched more than one preset");
  return matches[0] ?? null;
}

function validatePublicConnectionPreset(value: unknown, label: string): PublicConnectionPreset {
  const preset = requireObject(value, label);
  const transport = requireObject(preset.transport, `${label}.transport`);
  if (typeof preset.id !== "string" || !preset.id.startsWith("conn-")
    || typeof preset.label !== "string" || !preset.label
    || transport.kind !== "local" || Object.keys(transport).some((key) => key !== "kind" && key !== "grokPath")
    || !Number.isSafeInteger(preset.createdMs) || Number(preset.createdMs) <= 0
    || !Number.isSafeInteger(preset.lastUsedMs) || Number(preset.lastUsedMs) < 0
    || (preset.providerScan !== undefined && !Array.isArray(preset.providerScan))) {
    throw new Error(`${label} did not match the inert public connection schema`);
  }
  return preset as PublicConnectionPreset;
}

async function saveConnectionPreset(
  connection: { base: string; token: string },
  label: string,
): Promise<PublicConnectionPreset> {
  const response = await fetch(`${connection.base}/connections`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: "",
      label,
      transport: { kind: "local" },
      createdMs: 0,
      lastUsedMs: 0,
      providerScan: [],
    }),
  });
  if (response.status !== 201) throw new Error(`POST /connections returned ${response.status}`);
  return validatePublicConnectionPreset(await response.json(), "POST /connections");
}

async function deleteConnectionPreset(
  connection: { base: string; token: string },
  id: string,
): Promise<void> {
  const response = await fetch(`${connection.base}/connections/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${connection.token}` },
  });
  if (response.status !== 204) {
    throw new Error(`DELETE /connections/:id returned ${response.status}`);
  }
}

async function exerciseOutsideConnectorMutation(
  connection: { base: string; token: string },
  request: ReleaseSurfaceDriverRequest,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const create = assignment.surface.name === "POST /outside-connectors";
  const segment = request.sourceCommit.slice(0, 16);
  const label = `ShellX release outside ${create ? "create" : "delete"} ${segment}`;
  const vaultRef = `release-surface/outside-connector/${create ? "create" : "delete"}/${segment}`;
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No isolated outside-connector mutation was observed.",
  };
  let baseline: unknown = null;
  try {
    baseline = await outsideConnectorDirectory(connection);
    if (outsideConnectorByLabel(baseline, label)) throw new Error("owned outside-connector fixture already exists");
    outcome.present = "pass";
    const saved = await saveOutsideConnector(connection, label, vaultRef);
    if (create) outcome.invoke = "pass";
    const seeded = await outsideConnectorDirectory(connection);
    const observed = outsideConnectorByLabel(seeded, label);
    if (!observed || observed.id !== saved.id || !isDeepStrictEqual(observed, saved)) {
      throw new Error("POST /outside-connectors did not persist its exact disabled connector");
    }
    if (!create) {
      await deleteOutsideConnector(connection, saved.id);
      outcome.invoke = "pass";
      const changed = await outsideConnectorDirectory(connection);
      if (outsideConnectorByLabel(changed, label)) {
        throw new Error("DELETE /outside-connectors/:id did not remove its exact prepared connector");
      }
    }
    outcome.effect = "pass";
    outcome.observedEffect = create
      ? "POST /outside-connectors created exactly one disabled connector reference without contacting a provider or retaining its identity."
      : "DELETE /outside-connectors/:id removed exactly its prepared disabled connector reference without contacting a provider or retaining its identity.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      const current = await outsideConnectorDirectory(connection);
      const owned = outsideConnectorByLabel(current, label);
      if (owned) await deleteOutsideConnector(connection, owned.id);
      const restored = await outsideConnectorDirectory(connection);
      if (baseline === null || !isDeepStrictEqual(restored, baseline)) {
        throw new Error("isolated outside-connector directory was not restored byte-for-byte");
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

type PublicOutsideConnector = {
  id: string;
  label: string;
  enabled: boolean;
  provider: { kind: string; botTokenVaultKey: string; allowedChatIds?: unknown[] };
  target: { mode: string };
  dispatchMode: string;
  requireApproval: boolean;
  createdMs: number;
  updatedMs: number;
  lastTestMs: number | null;
  lastError: string | null;
};

async function outsideConnectorDirectory(connection: { base: string; token: string }): Promise<unknown> {
  const body = requireObject(await (await fetchRoute(connection, "/outside-connectors")).json(), "GET /outside-connectors");
  requireExactKeys(body, ["connectors"], "GET /outside-connectors");
  const connectors = requireArray(body, "connectors", "GET /outside-connectors");
  for (const value of connectors) validatePublicOutsideConnector(value, "GET /outside-connectors connector");
  return body;
}

function outsideConnectorByLabel(value: unknown, label: string): PublicOutsideConnector | null {
  const body = requireObject(value, "outside-connector directory");
  const matches = requireArray(body, "connectors", "outside-connector directory")
    .map((entry) => validatePublicOutsideConnector(entry, "outside-connector directory entry"))
    .filter((entry) => entry.label === label);
  if (matches.length > 1) throw new Error("owned outside-connector label matched more than one entry");
  return matches[0] ?? null;
}

function validatePublicOutsideConnector(value: unknown, label: string): PublicOutsideConnector {
  const connector = requireObject(value, label);
  const provider = requireObject(connector.provider, `${label}.provider`);
  const target = requireObject(connector.target, `${label}.target`);
  if (typeof connector.id !== "string" || !connector.id.startsWith("oconn-")
    || typeof connector.label !== "string" || !connector.label
    || typeof connector.enabled !== "boolean"
    || provider.kind !== "telegram" || typeof provider.botTokenVaultKey !== "string" || !provider.botTokenVaultKey
    || (provider.allowedChatIds !== undefined && !Array.isArray(provider.allowedChatIds))
    || target.mode !== "activeTab" || connector.dispatchMode !== "inbox"
    || typeof connector.requireApproval !== "boolean"
    || !Number.isSafeInteger(connector.createdMs) || Number(connector.createdMs) <= 0
    || !Number.isSafeInteger(connector.updatedMs) || Number(connector.updatedMs) <= 0
    || (connector.lastTestMs !== null && !Number.isSafeInteger(connector.lastTestMs))
    || (connector.lastError !== null && typeof connector.lastError !== "string")) {
    throw new Error(`${label} did not match the public outside-connector schema`);
  }
  return connector as PublicOutsideConnector;
}

async function saveOutsideConnector(
  connection: { base: string; token: string },
  label: string,
  vaultRef: string,
): Promise<PublicOutsideConnector> {
  const response = await fetch(`${connection.base}/outside-connectors`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: "",
      label,
      enabled: false,
      provider: { kind: "telegram", botTokenVaultKey: vaultRef, allowedChatIds: [] },
      target: { mode: "activeTab" },
      dispatchMode: "inbox",
      requireApproval: true,
      createdMs: 0,
      updatedMs: 0,
      lastTestMs: null,
      lastError: null,
    }),
  });
  if (response.status !== 201) throw new Error(`POST /outside-connectors returned ${response.status}`);
  const saved = validatePublicOutsideConnector(await response.json(), "POST /outside-connectors");
  if (saved.enabled || saved.provider.botTokenVaultKey !== vaultRef) {
    throw new Error("POST /outside-connectors did not preserve its disabled reference-only contract");
  }
  return saved;
}

async function deleteOutsideConnector(
  connection: { base: string; token: string },
  id: string,
): Promise<void> {
  const response = await fetch(`${connection.base}/outside-connectors/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${connection.token}` },
  });
  if (response.status !== 204) throw new Error(`DELETE /outside-connectors/:id returned ${response.status}`);
}

async function exerciseUiStateMutation(
  connection: { base: string; token: string },
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
    observedEffect: "No installed UI-state mutation was observed.",
  };
  let baseline: UiStateSnapshot | null = null;
  try {
    baseline = await readUiStateSnapshot(connection);
    requireQuiescentUiCommands(baseline.raw);
    outcome.present = "pass";
    const target = baseline.bottomTab === "Terminal" ? "Chat" : "Terminal";
    const changed = await postUiState(connection, target, "final-surface-state-ui-mutation");
    outcome.invoke = "pass";
    if (changed.bottomTab !== target || changed.uiRevision <= baseline.uiRevision) {
      throw new Error("POST /state/ui returned the wrong bottom-tab transition or revision");
    }
    const observed = await readUiStateSnapshot(connection);
    if (observed.bottomTab !== target || observed.uiRevision < changed.uiRevision) {
      throw new Error("POST /state/ui did not persist its logical bottom-tab transition");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "POST /state/ui changed the installed bottom-tab owner while retaining only its expected monotonic audit metadata.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (!baseline) throw new Error("UI-state baseline was unavailable");
      const restored = await postUiState(connection, baseline.bottomTab, "final-surface-state-ui-restore");
      const confirmed = await readUiStateSnapshot(connection);
      if (restored.bottomTab !== baseline.bottomTab || confirmed.bottomTab !== baseline.bottomTab
        || confirmed.uiRevision < restored.uiRevision
        || JSON.stringify(stripUiAudit(confirmed.raw)) !== JSON.stringify(stripUiAudit(baseline.raw))) {
        throw new Error("logical UI-state baseline was not restored exactly");
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

type UiStateSnapshot = { raw: Record<string, unknown>; bottomTab: string; uiRevision: number };

async function readUiStateSnapshot(connection: { base: string; token: string }): Promise<UiStateSnapshot> {
  return validateUiStateSnapshot(
    await (await fetchRoute(connection, "/state/ui")).json(),
    "GET /state/ui",
  );
}

async function postUiState(
  connection: { base: string; token: string },
  bottomTab: string,
  source: string,
): Promise<UiStateSnapshot> {
  const response = await fetch(`${connection.base}/state/ui`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bottomTab, source }),
  });
  if (response.status !== 200) throw new Error(`POST /state/ui returned ${response.status}`);
  return validateUiStateSnapshot(await response.json(), "POST /state/ui");
}

function validateUiStateSnapshot(value: unknown, label: string): UiStateSnapshot {
  const raw = requireObject(value, label);
  if (!Object.values(BOTTOM_TAB_VALUES).includes(raw.bottomTab as BottomTabValue)
    || !Number.isSafeInteger(raw.uiRevision) || Number(raw.uiRevision) < 0) {
    throw new Error(`${label} omitted its normalized bottom tab or monotonic revision`);
  }
  return { raw, bottomTab: String(raw.bottomTab), uiRevision: Number(raw.uiRevision) };
}

const BOTTOM_TAB_VALUES = {
  chat: "Chat",
  terminal: "Terminal",
  logs: "Logs",
  stderr: "Stderr",
} as const;
type BottomTabValue = typeof BOTTOM_TAB_VALUES[keyof typeof BOTTOM_TAB_VALUES];

function requireQuiescentUiCommands(state: Record<string, unknown>): void {
  for (const key of [
    "composerMenu", "openModal", "vaultRequestCenterOpen", "setupGuideDismissed", "debugClick",
    "debugInput", "debugDrag", "debugSurface", "clickSelector", "cwdPicker",
  ]) {
    if (state[key] !== undefined && state[key] !== null) {
      throw new Error(`UI-state fixture is not quiescent: ${key} is active`);
    }
  }
}

function stripUiAudit(value: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(value);
  delete copy.uiRevision;
  delete copy.lastUiPatchMs;
  delete copy.lastUiPatchSource;
  return copy;
}

type BrowserEnginePoolConfig = {
  configuredParallelAgents: string;
  automationMode: string;
};

async function exerciseBrowserEnginePoolMutation(
  connection: { base: string; token: string },
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
    observedEffect: "No isolated Browser engine-pool mutation was observed.",
  };
  let baseline: BrowserEnginePoolConfig | null = null;
  try {
    baseline = await browserEnginePoolConfig(connection, "GET");
    outcome.present = "pass";
    const target: BrowserEnginePoolConfig = {
      configuredParallelAgents: baseline.configuredParallelAgents === "1" ? "2" : "1",
      automationMode: baseline.automationMode === "backgroundOnly" ? "normal" : "backgroundOnly",
    };
    const changed = await browserEnginePoolConfig(connection, "POST", target);
    outcome.invoke = "pass";
    if (JSON.stringify(changed) !== JSON.stringify(target)) {
      throw new Error("POST /browser/engine-pool returned the wrong logical configuration");
    }
    const observed = await browserEnginePoolConfig(connection, "GET");
    if (JSON.stringify(observed) !== JSON.stringify(target)) {
      throw new Error("POST /browser/engine-pool did not persist its exact logical state transition");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "POST /browser/engine-pool changed both owned logical settings without starting or identifying an engine.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (!baseline) throw new Error("Browser engine-pool baseline was unavailable");
      const restored = await browserEnginePoolConfig(connection, "POST", baseline);
      if (JSON.stringify(restored) !== JSON.stringify(baseline)) {
        throw new Error("Browser engine-pool restore response did not match its logical baseline");
      }
      const confirmed = await browserEnginePoolConfig(connection, "GET");
      if (JSON.stringify(confirmed) !== JSON.stringify(baseline)) {
        throw new Error("Browser engine-pool logical baseline was not restored");
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

type PanelSizes = { horizontal: [number, number, number]; vertical: [number, number] };
type PreviewTarget = {
  kind: string;
  path: string;
  tabId?: string;
  sessionCwd?: string;
  lineRange?: [number, number] | null;
};

async function exercisePreviewTargetMutation(
  connection: { base: string; token: string },
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
    observedEffect: "No installed Preview-target mutation was observed.",
  };
  let baseline: PreviewTarget | null | undefined;
  try {
    baseline = await readPreviewTarget(connection);
    outcome.present = "pass";
    const target: PreviewTarget = {
      kind: "url",
      path: "https://example.invalid/shellx-release-preview-proof",
      tabId: "shellx-release-preview-proof",
      sessionCwd: "/shellx-release-preview-proof",
    };
    const changed = await postPreviewTarget(connection, target);
    outcome.invoke = "pass";
    if (!samePreviewTarget(changed, target)) {
      throw new Error("POST /preview returned the wrong typed target");
    }
    if (!samePreviewTarget(await readPreviewTarget(connection), target)) {
      throw new Error("POST /preview did not persist the exact typed target");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "POST /preview stored and read back one exact typed Preview target without retaining its path in release evidence.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (baseline === undefined) throw new Error("Preview baseline was unavailable");
      const restored = await postPreviewTarget(connection, baseline);
      if (!samePreviewTarget(restored, baseline)
        || !samePreviewTarget(await readPreviewTarget(connection), baseline)) {
        throw new Error("POST /preview did not restore the exact nullable baseline");
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

async function exercisePanelMutation(
  connection: { base: string; token: string },
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
    observedEffect: "No installed panel-size mutation was observed.",
  };
  let baseline: PanelSizes | null = null;
  try {
    baseline = await readPanels(connection);
    outcome.present = "pass";
    const target: PanelSizes = JSON.stringify(baseline.horizontal) === JSON.stringify([20, 55, 25])
      ? { horizontal: [18, 56, 26], vertical: [72, 28] }
      : { horizontal: [20, 55, 25], vertical: [70, 30] };
    const changed = await postPanels(connection, target);
    outcome.invoke = "pass";
    if (JSON.stringify(changed) !== JSON.stringify(target)) {
      throw new Error("POST /panels returned the wrong panel arrays");
    }
    const observed = await readPanels(connection);
    if (JSON.stringify(observed) !== JSON.stringify(target)) {
      throw new Error("POST /panels did not persist both exact panel arrays");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "POST /panels changed both bounded split arrays without retaining layout values in evidence.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (!baseline) throw new Error("panel baseline was unavailable");
      const restored = await postPanels(connection, baseline);
      if (JSON.stringify(restored) !== JSON.stringify(baseline)) {
        throw new Error("POST /panels restore response did not match the exact baseline");
      }
      const confirmed = await readPanels(connection);
      if (JSON.stringify(confirmed) !== JSON.stringify(baseline)) {
        throw new Error("panel baseline was not restored byte-for-byte");
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

type PublicSettings = {
  browserDownloadFolder: string;
  chatFontPx: number;
  density: "compact" | "default" | "comfortable";
  githubGhBinary: "gh" | "gh.exe";
  theme: "black" | "black_warm" | "bright";
};

async function exerciseSettingsMutation(
  connection: { base: string; token: string },
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
    observedEffect: "No isolated Settings mutation was observed.",
  };
  let baseline: PublicSettings | null = null;
  try {
    baseline = await readSettings(connection);
    outcome.present = "pass";
    const target: PublicSettings = {
      browserDownloadFolder: "shellx-release-downloads",
      chatFontPx: baseline.chatFontPx === 17 ? 18 : 17,
      density: baseline.density === "compact" ? "comfortable" : "compact",
      githubGhBinary: baseline.githubGhBinary === "gh" ? "gh.exe" : "gh",
      theme: baseline.theme === "bright" ? "black_warm" : "bright",
    };
    const changed = await postSettings(connection, target);
    outcome.invoke = "pass";
    if (JSON.stringify(changed) !== JSON.stringify(target)) {
      throw new Error("POST /settings returned the wrong normalized settings object");
    }
    const observed = await readSettings(connection);
    if (JSON.stringify(observed) !== JSON.stringify(target)) {
      throw new Error("POST /settings did not persist all six exact public fields");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "POST /settings changed all six normalized public fields without retaining their values in evidence.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (!baseline) throw new Error("Settings baseline was unavailable");
      const restored = await postSettings(connection, baseline);
      if (JSON.stringify(restored) !== JSON.stringify(baseline)) {
        throw new Error("POST /settings restore response did not match the exact baseline");
      }
      const confirmed = await readSettings(connection);
      if (JSON.stringify(confirmed) !== JSON.stringify(baseline)) {
        throw new Error("Settings baseline was not restored byte-for-byte");
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

async function readSettings(connection: { base: string; token: string }): Promise<PublicSettings> {
  const response = await fetchRoute(connection, "/settings");
  if (response.status !== 200) throw new Error(`GET /settings returned ${response.status}`);
  return validatePublicSettings(await response.json(), "GET /settings");
}

async function postSettings(
  connection: { base: string; token: string },
  settings: PublicSettings,
): Promise<PublicSettings> {
  const response = await fetch(`${connection.base}/settings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
  });
  if (response.status !== 200) throw new Error(`POST /settings returned ${response.status}`);
  const body = requireObject(await response.json(), "POST /settings");
  requireExactKeys(body, ["ok", "settings"], "POST /settings");
  if (body.ok !== true) throw new Error("POST /settings omitted ok=true");
  return validatePublicSettings(body.settings, "POST /settings.settings");
}

function validatePublicSettings(value: unknown, label: string): PublicSettings {
  const body = requireObject(value, label);
  requireExactKeys(body, [
    "browserDownloadFolder",
    "chatFontPx",
    "density",
    "githubGhBinary",
    "theme",
  ], label);
  if (typeof body.browserDownloadFolder !== "string" || body.browserDownloadFolder.length > 4096
    || !Number.isSafeInteger(body.chatFontPx) || Number(body.chatFontPx) < 12 || Number(body.chatFontPx) > 26
    || !["compact", "default", "comfortable"].includes(String(body.density))
    || !["gh", "gh.exe"].includes(String(body.githubGhBinary))
    || !["black", "black_warm", "bright"].includes(String(body.theme))) {
    throw new Error(`${label} returned invalid normalized public settings`);
  }
  return body as PublicSettings;
}

async function readPanels(connection: { base: string; token: string }): Promise<PanelSizes> {
  const response = await fetchRoute(connection, "/panels");
  if (response.status !== 200) throw new Error(`GET /panels returned ${response.status}`);
  return validatePanels(await response.json(), "GET /panels");
}

async function readPreviewTarget(
  connection: { base: string; token: string },
): Promise<PreviewTarget | null> {
  const response = await fetchRoute(connection, "/preview");
  if (response.status !== 200) throw new Error(`GET /preview returned ${response.status}`);
  const body = requireObject(await response.json(), "GET /preview");
  requireExactKeys(body, ["preview"], "GET /preview");
  return validatePreviewTarget(body.preview, "GET /preview.preview");
}

async function postPreviewTarget(
  connection: { base: string; token: string },
  target: PreviewTarget | null,
): Promise<PreviewTarget | null> {
  const response = await fetch(`${connection.base}/preview`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(target),
  });
  if (response.status !== 200) throw new Error(`POST /preview returned ${response.status}`);
  const body = requireObject(await response.json(), "POST /preview");
  requireExactKeys(body, ["ok", "preview"], "POST /preview");
  if (body.ok !== true) throw new Error("POST /preview omitted ok=true");
  return validatePreviewTarget(body.preview, "POST /preview.preview");
}

function validatePreviewTarget(value: unknown, label: string): PreviewTarget | null {
  if (value === null) return null;
  const target = requireObject(value, label);
  requireExactKeys(target, ["kind", "lineRange", "path", "sessionCwd", "tabId"].filter((key) => key in target), label);
  if (typeof target.kind !== "string" || !target.kind.trim()
    || typeof target.path !== "string" || !target.path.trim()
    || (target.tabId !== undefined && typeof target.tabId !== "string")
    || (target.sessionCwd !== undefined && typeof target.sessionCwd !== "string")
    || (target.lineRange !== undefined && target.lineRange !== null && (!Array.isArray(target.lineRange)
      || target.lineRange.length !== 2
      || target.lineRange.some((item) => !Number.isSafeInteger(item))))) {
    throw new Error(`${label} returned an invalid typed Preview target`);
  }
  return target as PreviewTarget;
}

function samePreviewTarget(left: PreviewTarget | null, right: PreviewTarget | null): boolean {
  if (left === null || right === null) return left === right;
  const normalize = (value: PreviewTarget) => ({
    ...value,
    lineRange: value.lineRange ?? null,
  });
  return isDeepStrictEqual(normalize(left), normalize(right));
}

function samePortablePath(
  value: unknown,
  expected: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): boolean {
  if (typeof value !== "string") return false;
  const normalize = (path: string) => path
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/")
    .replace(/\/$/, "");
  const left = normalize(value);
  const right = normalize(expected);
  return platform === "windows-installed"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function postPanels(
  connection: { base: string; token: string },
  panels: PanelSizes,
): Promise<PanelSizes> {
  const response = await fetch(`${connection.base}/panels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(panels),
  });
  if (response.status !== 200) throw new Error(`POST /panels returned ${response.status}`);
  const body = requireObject(await response.json(), "POST /panels");
  requireExactKeys(body, ["ok", "panels"], "POST /panels");
  if (body.ok !== true) throw new Error("POST /panels omitted ok=true");
  return validatePanels(body.panels, "POST /panels.panels");
}

function validatePanels(value: unknown, label: string): PanelSizes {
  const body = requireObject(value, label);
  requireExactKeys(body, ["horizontal", "vertical"], label);
  if (!Array.isArray(body.horizontal) || body.horizontal.length !== 3
    || !Array.isArray(body.vertical) || body.vertical.length !== 2
    || [...body.horizontal, ...body.vertical].some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error(`${label} returned invalid panel arrays`);
  }
  return {
    horizontal: [...body.horizontal] as [number, number, number],
    vertical: [...body.vertical] as [number, number],
  };
}

async function browserEnginePoolConfig(
  connection: { base: string; token: string },
  method: "GET" | "POST",
  config?: BrowserEnginePoolConfig,
): Promise<BrowserEnginePoolConfig> {
  const response = method === "GET"
    ? await fetchRoute(connection, "/browser/engine-pool")
    : await fetch(`${connection.base}/browser/engine-pool`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config),
    });
  if (response.status !== 200) throw new Error(`${method} /browser/engine-pool returned ${response.status}`);
  const body = requireObject(await response.json(), `${method} /browser/engine-pool`);
  requireExactKeys(body, ["enginePool"], `${method} /browser/engine-pool`);
  const pool = requireObject(body.enginePool, `${method} /browser/engine-pool.enginePool`);
  const limits = requireObject(pool.limits, `${method} /browser/engine-pool.enginePool.limits`);
  const configuredParallelAgents = requireBoundedString(
    limits.configuredParallelAgents,
    `${method} /browser/engine-pool.configuredParallelAgents`,
  );
  const automationMode = requireBoundedString(pool.automationMode, `${method} /browser/engine-pool.automationMode`);
  if (configuredParallelAgents !== "auto" && !["1", "2", "3", "4"].includes(configuredParallelAgents)) {
    throw new Error(`${method} /browser/engine-pool returned an invalid parallel-agent setting`);
  }
  if (automationMode !== "normal" && automationMode !== "backgroundOnly") {
    throw new Error(`${method} /browser/engine-pool returned an invalid automation mode`);
  }
  requireArray(pool, "engines", `${method} /browser/engine-pool.enginePool`);
  requireArray(pool, "waiting", `${method} /browser/engine-pool.enginePool`);
  requireArray(pool, "parkedTabs", `${method} /browser/engine-pool.enginePool`);
  return { configuredParallelAgents, automationMode };
}

async function vaultKeyDirectory(connection: { base: string; token: string }): Promise<unknown> {
  const response = await fetchRoute(connection, "/vault/keys");
  if (!response.ok) throw new Error(`GET /vault/keys returned ${response.status}`);
  const body = requireObject(await response.json(), "GET /vault/keys");
  const keys = requireArray(body, "keys", "GET /vault/keys");
  const entries = requireArray(body, "entries", "GET /vault/keys");
  if (keys.length !== entries.length || keys.some((key) => typeof key !== "string" || !key)) {
    throw new Error("Vault key directory returned mismatched metadata");
  }
  for (const entry of entries) {
    const row = requireObject(entry, "GET /vault/keys entry");
    if (typeof row.key !== "string" || !row.key || "value" in row || "secret" in row) {
      throw new Error("Vault key directory returned invalid or secret-bearing metadata");
    }
  }
  return body;
}

function vaultDirectoryHasKey(value: unknown, key: string): boolean {
  const body = requireObject(value, "Vault key directory");
  const keys = requireArray(body, "keys", "Vault key directory");
  const entries = requireArray(body, "entries", "Vault key directory");
  return keys.includes(key) && entries.some((entry) => requireObject(entry, "Vault key entry").key === key);
}

async function expectVaultMutationResponse(
  connection: { base: string; token: string },
  path: "/vault/set" | "/vault/delete",
  requestBody: Record<string, unknown>,
  expectedKey: string,
): Promise<void> {
  const response = await fetch(`${connection.base}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  if (response.status !== 200) throw new Error(`POST ${path} returned ${response.status}`);
  const body = requireObject(await response.json(), `POST ${path}`);
  requireExactKeys(body, ["key", "ok"], `POST ${path}`);
  if (body.ok !== true || body.key !== expectedKey || "value" in body || "secret" in body) {
    throw new Error(`POST ${path} returned the wrong no-secret mutation contract`);
  }
}

async function exerciseDiagnosticsAuthRead(
  connection: { base: string; token: string },
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "pass",
    observedEffect: "No bounded authentication diagnostic was observed.",
  };
  try {
    outcome.present = "pass";
    const response = await fetch(`${connection.base}/diagnostics`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ only: ["auth"] }),
    });
    outcome.invoke = "pass";
    if (response.status !== 200) throw new Error(`POST /diagnostics returned ${response.status}`);
    const body = requireObject(await response.json(), "POST /diagnostics");
    requireExactKeys(body, ["checks", "summary"], "POST /diagnostics");
    const summary = requireObject(body.summary, "POST /diagnostics.summary");
    requireExactKeys(summary, ["elapsedMs", "fail", "pass", "version"], "POST /diagnostics.summary");
    const checks = requireArray(body, "checks", "POST /diagnostics");
    if (summary.pass !== 1 || summary.fail !== 0 || summary.version !== "1.0"
      || !Number.isSafeInteger(summary.elapsedMs) || Number(summary.elapsedMs) < 0
      || checks.length !== 1) {
      throw new Error("POST /diagnostics did not return the exact one-check auth summary");
    }
    const auth = requireObject(checks[0], "POST /diagnostics auth check");
    requireExactKeys(auth, ["detail", "name", "status"], "POST /diagnostics auth check");
    if (auth.name !== "auth" || auth.status !== "pass"
      || auth.detail !== "Debug API token authority initialized") {
      throw new Error("POST /diagnostics did not prove the installed process token authority");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "POST /diagnostics ran only the bounded auth check and proved the installed process token authority without retaining token material.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}

async function exerciseReleaseClipboardLease(
  connection: { base: string; token: string },
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
    observedEffect: "No native clipboard preflight contract was observed.",
  };
  let leaseId: string | null = null;
  try {
    outcome.present = "pass";
    const preflightResponse = await postReleaseClipboard(connection, { action: "preflight" });
    outcome.invoke = "pass";
    if (preflightResponse.status === 409) {
      const refusal = preflightResponse.value;
      requireExactKeys(refusal, ["error", "message"], "POST /release-test/clipboard nonempty preflight");
      if (refusal.error !== "release_clipboard_not_empty"
        || refusal.message !== "clipboard preflight refused because native format metadata is nonempty") {
        throw new Error("POST /release-test/clipboard returned the wrong nonempty preservation contract");
      }
      outcome.effect = "pass";
      outcome.cleanup = "pass";
      outcome.observedEffect = "POST /release-test/clipboard safely refused a nonempty native clipboard from metadata alone, created no lease, and neither read nor changed clipboard payload bytes.";
      return outcome;
    }
    if (preflightResponse.status !== 200) {
      throw new Error(`POST /release-test/clipboard returned ${preflightResponse.status} (${String(preflightResponse.value.error ?? "unknown")})`);
    }
    const preflight = preflightResponse.value;
    requireExactKeys(preflight, ["action", "empty", "leaseId", "ok", "platform"], "POST /release-test/clipboard preflight");
    if (preflight.ok !== true || preflight.action !== "preflight" || preflight.empty !== true
      || typeof preflight.leaseId !== "string" || !/^rcb-[a-f0-9]{32}$/.test(preflight.leaseId)
      || typeof preflight.platform !== "string" || preflight.platform.length === 0) {
      throw new Error("POST /release-test/clipboard returned the wrong empty preflight lease");
    }
    leaseId = preflight.leaseId;
    outcome.effect = "pass";
    outcome.observedEffect = "POST /release-test/clipboard acquired one native empty-clipboard lease without reading clipboard payload bytes and released it unused.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (leaseId) {
      try {
        const releaseResponse = await postReleaseClipboard(connection, { action: "releaseEmpty", leaseId });
        if (releaseResponse.status === 409
          && releaseResponse.value.error === "release_clipboard_not_empty") {
          requireExactKeys(
            releaseResponse.value,
            ["error", "message"],
            "POST /release-test/clipboard releaseEmpty nonempty preservation",
          );
          if (releaseResponse.value.message
            !== "an empty clipboard lease cannot be released while native format metadata is nonempty") {
            throw new Error("POST /release-test/clipboard returned the wrong changed-clipboard preservation contract");
          }
          const abandonResponse = await postReleaseClipboard(connection, { action: "abandon", leaseId });
          if (abandonResponse.status !== 200) {
            throw new Error(`POST /release-test/clipboard abandon returned ${abandonResponse.status} (${String(abandonResponse.value.error ?? "unknown")})`);
          }
          const abandoned = abandonResponse.value;
          requireExactKeys(abandoned, ["action", "empty", "ok", "platform"], "POST /release-test/clipboard abandon");
          if (abandoned.ok !== true || abandoned.action !== "abandon" || abandoned.empty !== false
            || typeof abandoned.platform !== "string" || abandoned.platform.length === 0) {
            throw new Error("POST /release-test/clipboard did not abandon the changed-clipboard lease exactly");
          }
          outcome.observedEffect = "POST /release-test/clipboard acquired one native empty-clipboard lease, detected that native clipboard metadata changed before release, preserved its payload without reading it, and abandoned only the lease.";
          outcome.cleanup = "pass";
        } else if (releaseResponse.status !== 200) {
          throw new Error(`POST /release-test/clipboard releaseEmpty returned ${releaseResponse.status} (${String(releaseResponse.value.error ?? "unknown")})`);
        } else {
          const released = releaseResponse.value;
          requireExactKeys(released, ["action", "empty", "ok", "platform"], "POST /release-test/clipboard releaseEmpty");
          if (released.ok !== true || released.action !== "releaseEmpty" || released.empty !== true
            || typeof released.platform !== "string" || released.platform.length === 0) {
            throw new Error("POST /release-test/clipboard did not release the exact unused lease");
          }
          outcome.cleanup = "pass";
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcome.error = outcome.error ? `${outcome.error}; cleanup: ${message}` : `cleanup: ${message}`;
      }
    }
  }
  return outcome;
}

async function postReleaseClipboard(
  connection: { base: string; token: string },
  body: Record<string, unknown>,
): Promise<{ status: number; value: Record<string, unknown> }> {
  const response = await fetch(`${connection.base}/release-test/clipboard`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const value = requireObject(await response.json(), "POST /release-test/clipboard");
  return { status: response.status, value };
}

async function exerciseReleaseNativePickerLease(
  connection: { base: string; token: string },
  request: ReleaseSurfaceDriverRequest,
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
    observedEffect: "No isolated native-picker lease lifecycle was observed.",
  };
  const fixture = prepareNativePickerFixture(request, assignment.surface.id);
  const expectedHash = createHash("sha256").update(fixture.file).digest("hex");
  let armed = false;
  try {
    outcome.present = "pass";
    if (assignment.surface.name === "POST /release-test/native-picker") {
      const result = await requestReleaseNativePicker(connection, "POST", {
        kind: "file",
        path: fixture.file,
      }, 201);
      armed = true;
      verifyReleaseNativePickerArmed(result, expectedHash, "POST /release-test/native-picker");
      outcome.invoke = "pass";
      verifyReleaseNativePickerArmed(
        await requestReleaseNativePicker(connection, "GET", undefined, 200),
        expectedHash,
        "GET /release-test/native-picker after arm",
      );
      outcome.observedEffect = "POST /release-test/native-picker armed one exact receipt-owned file result and exposed only its kind plus path SHA-256.";
    } else {
      verifyReleaseNativePickerArmed(
        await requestReleaseNativePicker(connection, "POST", { kind: "file", path: fixture.file }, 201),
        expectedHash,
        "POST /release-test/native-picker fixture arm",
      );
      armed = true;
      if (assignment.surface.name === "GET /release-test/native-picker") {
        verifyReleaseNativePickerArmed(
          await requestReleaseNativePicker(connection, "GET", undefined, 200),
          expectedHash,
          "GET /release-test/native-picker",
        );
        outcome.observedEffect = "GET /release-test/native-picker reported only the armed kind and exact path SHA-256, without returning path text.";
      } else {
        const cleared = await requestReleaseNativePicker(connection, "DELETE", undefined, 200);
        requireExactKeys(cleared, ["cleared"], "DELETE /release-test/native-picker");
        if (cleared.cleared !== true) throw new Error("DELETE /release-test/native-picker did not clear the armed lease");
        armed = false;
        const status = await requestReleaseNativePicker(connection, "GET", undefined, 200);
        requireExactKeys(status, ["armed"], "GET /release-test/native-picker after clear");
        if (status.armed !== false) throw new Error("native-picker lease remained armed after DELETE");
        outcome.observedEffect = "DELETE /release-test/native-picker cleared the exact unused receipt-owned result and left no armed lease.";
      }
      outcome.invoke = "pass";
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    try {
      const cleared = await requestReleaseNativePicker(connection, "DELETE", undefined, 200);
      requireExactKeys(cleared, ["cleared"], "DELETE /release-test/native-picker cleanup");
      if (cleared.cleared !== armed) {
        throw new Error("native-picker cleanup did not match the exact armed state");
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      removeNativePickerFixture(request, fixture);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (cleanupErrors.length === 0) {
      outcome.cleanup = "pass";
    } else {
      const message = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${message}` : `cleanup: ${message}`;
    }
  }
  return outcome;
}

async function requestReleaseNativePicker(
  connection: { base: string; token: string },
  method: "GET" | "POST" | "DELETE",
  body: Record<string, unknown> | undefined,
  expectedStatus: number,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}/release-test/native-picker`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = requireObject(await response.json(), `${method} /release-test/native-picker`);
  if (response.status !== expectedStatus) {
    throw new Error(`${method} /release-test/native-picker returned ${response.status} (${String(value.error ?? "unknown")})`);
  }
  return value;
}

function verifyReleaseNativePickerArmed(
  value: Record<string, unknown>,
  expectedHash: string,
  label: string,
): void {
  requireExactKeys(value, ["armed", "kind", "pathSha256"], label);
  if (value.armed !== true || value.kind !== "file" || value.pathSha256 !== expectedHash
    || "path" in value || "syntheticText" in value) {
    throw new Error(`${label} did not return the exact redacted armed contract`);
  }
}

async function exerciseGithubPrApprovalGate(
  connection: { base: string; token: string },
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "pass",
    observedEffect: "No remote GitHub approval denial was observed.",
  };
  try {
    outcome.present = "pass";
    const response = await fetch(`${connection.base}/github/pr/create`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        base: "main",
        title: "Release surface approval gate",
        body: "This request must never reach GitHub without explicit approval.",
        confirmRemoteCreate: false,
      }),
    });
    outcome.invoke = "pass";
    if (response.status !== 428) throw new Error(`POST /github/pr/create returned ${response.status} instead of 428`);
    const body = requireObject(await response.json(), "POST /github/pr/create");
    requireExactKeys(body, ["error", "hint"], "POST /github/pr/create");
    if (body.error !== "approval_required"
      || body.hint !== "Creating a GitHub PR mutates remote state. Re-submit with confirmRemoteCreate:true after explicit per-operation approval.") {
      throw new Error("POST /github/pr/create returned the wrong per-operation approval gate");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "POST /github/pr/create rejected a request lacking per-operation approval before resolving a session, invoking gh, or contacting GitHub.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}

async function exerciseSafeRefusalRoute(
  connection: { base: string; token: string },
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = SAFE_REFUSAL_ROUTES[assignment.surface.name];
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "pass",
    observedEffect: "No bounded Debug API safe-refusal contract was observed.",
  };
  try {
    if (!config) throw new Error(`missing safe-refusal config for ${assignment.surface.name}`);
    const baselines = new Map<string, string>();
    for (const statePath of config.statePaths ?? []) {
      baselines.set(statePath, stableSafeRefusalState(statePath, await (await fetchRoute(connection, statePath)).json()));
    }
    outcome.present = "pass";
    const response = await fetch(`${connection.base}${config.requestPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config.body),
    });
    outcome.invoke = "pass";
    if (response.status !== config.status) {
      throw new Error(`${assignment.surface.name} returned ${response.status} instead of ${config.status}`);
    }
    const responseClone = response.clone();
    await verifySafeRefusalResponse(assignment.surface.name, response);
    for (const [statePath, baseline] of baselines) {
      const after = stableSafeRefusalState(statePath, await (await fetchRoute(connection, statePath)).json());
      if (after !== baseline) throw new Error(`${assignment.surface.name} changed ${statePath} despite its safe refusal`);
    }
    outcome.effect = "pass";
    outcome.observedEffect = safeRefusalObservedEffect(assignment.surface.name, responseClone.status);
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}

function stableSafeRefusalState(path: string, value: unknown): string {
  if (!path.startsWith("/preview/work/state")) return JSON.stringify(value);
  const body = { ...requireObject(value, path) };
  delete body.updatedAtMs;
  return JSON.stringify(body);
}

async function verifySafeRefusalResponse(name: string, response: Response): Promise<void> {
  if (name === "POST /prompt") {
    const text = await response.text();
    if (text !== "empty prompt") throw new Error(`${name} returned the wrong empty-prompt refusal`);
    return;
  }
  if (name === "POST /plan") {
    const text = await response.text();
    if (text !== "plan writes require an existing connected session") {
      throw new Error(`${name} crossed its missing-session write boundary`);
    }
    return;
  }
  if (name === "POST /permissions/:reqId/respond") {
    const text = await response.text();
    if (text !== "permission request 'shellx-release-missing-permission' not found or already resolved") {
      throw new Error(`${name} returned the wrong missing-request refusal`);
    }
    return;
  }
  if (["POST /tools/process_attach_stdout", "POST /tools/process_signal", "POST /tools/process_stats"].includes(name)) {
    const text = await response.text();
    if (text !== "unknown taskId: shellx-release-missing-process") {
      throw new Error(`${name} returned the wrong missing-process refusal`);
    }
    return;
  }
  if (name === "POST /build/start" || name === "POST /goal/start") {
    const text = await response.text();
    if (text !== "objective: must be non-empty") throw new Error(`${name} returned the wrong empty-objective refusal`);
    return;
  }
  if (name === "POST /browser/vault/fill-receipt" || name === "POST /browser/vault/generate-receipt") {
    const body = requireObject(await response.json(), name);
    requireExactKeys(body, ["code", "error", "ok", "secretExposed"], name);
    const expectedMessage = name.endsWith("fill-receipt")
      ? "Vault fill receipts are emitted only after an installed Browser engine confirms the mediated fill"
      : "Password generation must run through ShellX Vault; callers cannot self-issue generation receipts";
    if (body.ok !== false || body.secretExposed !== false
      || body.code !== "browser_vault_receipt_requires_verified_operation"
      || body.error !== expectedMessage) {
      throw new Error(`${name} returned the wrong verified-operation denial`);
    }
    return;
  }
  if (name === "POST /build/recheck_blocker") {
    const text = await response.text();
    if (text !== "no build run for this tab") throw new Error(`${name} returned the wrong absent-build refusal`);
    return;
  }
  if (name === "POST /state/environment/trace_export" || name === "POST /state/grok_environment/trace_export") {
    const text = await response.text();
    if (text !== "no registered tab session") throw new Error(`${name} reached beyond its missing-session boundary`);
    return;
  }
  const body = requireObject(await response.json(), name);
  if (name === "POST /abort" || name === "POST /disconnect") {
    requireExactKeys(body, ["abortedTabTasks", "keepSession", "ok", "registryRemoved", "tabId"], name);
    if (body.ok !== true || body.tabId !== "shellx-release-safe-refusal"
      || body.registryRemoved !== true || body.keepSession !== false || body.abortedTabTasks !== 0) {
      throw new Error(`${name} returned the wrong absent-session teardown contract`);
    }
    return;
  }
  if (name === "POST /agent_cli_setup/install/cancel") {
    requireExactKeys(body, ["cleaned", "ok"], name);
    if (body.ok !== true || body.cleaned !== false) throw new Error(`${name} did not return its idempotent absent confirmation contract`);
    return;
  }
  if (["POST /agent_cli_setup/install/confirm", "POST /agent_cli_setup/install/prepare", "POST /agent_cli_setup/recheck"].includes(name)) {
    requireExactKeys(body, ["error"], name);
    const error = requireObject(body.error, `${name}.error`);
    requireExactKeys(error, ["code", "message"], `${name}.error`);
    const message = String(error.message ?? "");
    const expected = name.endsWith("/confirm")
      ? "agent_cli_setup.confirm: unknown or expired confirmation id 'shellx-release-missing-confirmation'"
      : name.endsWith("/prepare")
        ? "agent_cli_setup.prepare: unknown provider 'shellx-release-invalid-provider'"
        : "unknown connectionId 'shellx-release-missing-connection'";
    if (error.code !== "bad_request" || message !== expected) throw new Error(`${name} returned the wrong pre-effect validation contract`);
    return;
  }
  if (name === "POST /autonomy") {
    requireExactKeys(body, ["accepted", "error", "hint", "received"], name);
    if (body.error !== "invalid_mode" || body.received !== "shellx-release-invalid-mode"
      || !Array.isArray(body.accepted) || !body.accepted.includes("default") || !body.accepted.includes("bypassPermissions")
      || typeof body.hint !== "string") throw new Error(`${name} returned the wrong invalid-mode contract`);
    return;
  }
  if (name === "POST /connections/:id/test") {
    requireExactKeys(body, ["error", "latencyMs", "reachable"], name);
    if (body.reachable !== false || body.latencyMs !== null || body.error !== "unknown connection id") {
      throw new Error(`${name} returned the wrong missing-connection contract`);
    }
    return;
  }
  if (name === "POST /build/receipt") {
    requireExactKeys(body, ["message", "ok", "tabId"], name);
    if (body.ok !== false || body.tabId !== "shellx-release-safe-refusal" || body.message !== "summary is required") {
      throw new Error(`${name} returned the wrong empty-summary refusal`);
    }
    return;
  }
  if (name === "POST /build/approve") {
    requireExactKeys(body, ["approved", "injected", "ok", "tabId"], name);
    if (body.ok !== true || body.tabId !== "shellx-release-safe-refusal"
      || body.approved !== false || body.injected !== false) throw new Error(`${name} changed an absent Build plan`);
    return;
  }
  if (name === "POST /build/complete") {
    requireExactKeys(body, ["complete", "message", "ok", "tabId"], name);
    if (body.ok !== false || body.tabId !== "shellx-release-safe-refusal" || body.complete !== false
      || body.message !== "no active build run for this tab") throw new Error(`${name} returned the wrong absent-Build completion refusal`);
    return;
  }
  if (name === "POST /build/operator_note") {
    requireExactKeys(body, ["message", "ok", "tabId"], name);
    if (body.ok !== false || body.tabId !== "shellx-release-safe-refusal"
      || body.message !== "no active /build run for this tab") throw new Error(`${name} queued a note without an active Build run`);
    return;
  }
  if (name === "POST /build/pause") {
    requireExactKeys(body, ["abortedTabTasks", "ok", "paused", "tabId"], name);
    if (body.ok !== true || body.tabId !== "shellx-release-safe-refusal"
      || body.paused !== false || body.abortedTabTasks !== 0) throw new Error(`${name} changed or aborted absent Build state`);
    return;
  }
  if (name === "POST /build/reject") {
    requireExactKeys(body, ["abortedAgentWatchers", "abortedTabTasks", "ok", "rejected", "tabId"], name);
    if (body.ok !== true || body.tabId !== "shellx-release-safe-refusal" || body.rejected !== false
      || body.abortedAgentWatchers !== 0 || body.abortedTabTasks !== 0) throw new Error(`${name} changed absent Build state`);
    return;
  }
  if (name === "POST /build/resume") {
    requireExactKeys(body, ["message", "ok", "tabId"], name);
    if (body.ok !== false || body.tabId !== "shellx-release-safe-refusal"
      || body.message !== "Connect this tab before resuming Build Mode.") throw new Error(`${name} crossed its missing-session boundary`);
    return;
  }
  if (name === "POST /build/stop") {
    requireExactKeys(body, [
      "abortedAgentWatchers", "abortedTabTasks", "active", "agentKillErrors", "killErrors",
      "killedAgentSubagents", "killedHostMcpTasks", "ok", "promptCancelError", "promptCancelled",
      "stopped", "tabId",
    ], name);
    if (body.ok !== true || body.tabId !== "shellx-release-safe-refusal" || body.stopped !== false
      || body.active !== false || body.promptCancelled !== false || body.promptCancelError !== null
      || body.abortedAgentWatchers !== 0 || body.abortedTabTasks !== 0
      || !Array.isArray(body.agentKillErrors) || body.agentKillErrors.length !== 0
      || !Array.isArray(body.killErrors) || body.killErrors.length !== 0
      || !Array.isArray(body.killedAgentSubagents) || body.killedAgentSubagents.length !== 0
      || !Array.isArray(body.killedHostMcpTasks) || body.killedHostMcpTasks.length !== 0) {
      throw new Error(`${name} stopped or signalled state outside its unique absent tab`);
    }
    return;
  }
  if (["POST /goal/pause", "POST /goal/resume", "POST /goal/reject"].includes(name)) {
    const key = name.endsWith("/pause") ? "paused" : name.endsWith("/resume") ? "paused" : "rejected";
    requireExactKeys(body, ["ok", key, "tabId"], name);
    const expected = name.endsWith("/pause");
    if (body.ok !== true || body.tabId !== "shellx-release-safe-refusal" || body[key] !== expected) {
      throw new Error(`${name} returned the wrong absent-Goal no-op contract`);
    }
    return;
  }
  if (name === "POST /goal/complete") {
    requireExactKeys(body, ["active", "ok", "scratchboardError", "scratchboardPatched", "tabId", "wasActive"], name);
    if (body.ok !== true || body.tabId !== "shellx-release-safe-refusal" || body.active !== false
      || body.wasActive !== false || body.scratchboardPatched !== false || body.scratchboardError !== null) {
      throw new Error(`${name} touched scratchboard or tombstone state for an absent Goal`);
    }
    return;
  }
  if (name === "POST /goal/approve") {
    requireExactKeys(body, ["approved", "injected", "ok", "tabId"], name);
    if (body.ok !== true || body.tabId !== "shellx-release-safe-refusal"
      || body.approved !== false || body.injected !== false) {
      throw new Error(`${name} returned the wrong absent-plan no-op`);
    }
    return;
  }
  if (name === "POST /preview/work/diagnose") {
    requireExactKeys(body, [
      "browserEvents", "command", "cwd", "httpStatus", "issues", "logs", "ok", "responseBytes",
      "screenshotBrowser", "screenshotError", "screenshotHeight", "screenshotPath", "screenshotWidth",
      "state", "status", "summary", "tabId", "title", "url",
    ], name);
    const state = requireObject(body.state, `${name}.state`);
    const issues = requireArray(body, "issues", name);
    verifyIdlePreviewState(state, `${name}.state`);
    if (body.tabId !== "shellx-release-safe-refusal" || body.ok !== false || body.status !== "failed"
      || body.summary !== "Preview Doctor found 2 error(s) and 0 warning(s)."
      || body.url !== null || body.cwd !== null || body.command !== null || body.httpStatus !== null
      || body.responseBytes !== null || body.title !== null || body.screenshotPath !== null
      || body.screenshotWidth !== null || body.screenshotHeight !== null || body.screenshotBrowser !== null
      || body.screenshotError !== null || !Array.isArray(body.browserEvents) || body.browserEvents.length !== 0
      || !Array.isArray(body.logs) || body.logs.length !== 0
      || issues.length !== 2
    ) {
      throw new Error(`${name} did not return the exact no-process Preview Doctor contract`);
    }
    const expectedMessages = ["preview status is Idle", "preview has no URL to inspect"];
    for (const [index, issueValue] of issues.entries()) {
      const issue = requireObject(issueValue, `${name}.issue[${index}]`);
      requireExactKeys(issue, ["message", "severity", "source"], `${name}.issue[${index}]`);
      if (issue.severity !== "error" || issue.source !== "preview" || issue.message !== expectedMessages[index]) {
        throw new Error(`${name} returned the wrong issue at index ${index}`);
      }
    }
    return;
  }
  if (name === "POST /provider-sessions/abort") {
    requireExactKeys(body, ["aborted", "error", "ok", "runId", "tabId"], name);
    if (body.ok !== false || body.tabId !== "shellx-release-safe-refusal" || body.runId !== null
      || body.aborted !== false || body.error !== "no matching active provider session") {
      throw new Error(`${name} returned the wrong missing-provider-session refusal`);
    }
    return;
  }
  if (name === "POST /connections/provider-scan") {
    requireExactKeys(body, ["error"], name);
    const error = requireObject(body.error, `${name}.error`);
    requireExactKeys(error, ["code", "message"], `${name}.error`);
    if (error.code !== "bad_request" || typeof error.message !== "string"
      || !error.message.startsWith("invalid connection preset:")) {
      throw new Error(`${name} returned the wrong invalid-preset contract`);
    }
    return;
  }
  if (name === "POST /outside-connectors/:id/test") {
    requireExactKeys(body, ["error", "identity", "latencyMs", "provider", "reachable"], name);
    if (body.reachable !== false || body.provider !== "unknown" || body.latencyMs !== null
      || body.identity !== null || body.error !== "unknown connector id") {
      throw new Error(`${name} returned the wrong missing-connector test contract`);
    }
    return;
  }
  if (name === "POST /outside-connectors/:id/simulate") {
    requireExactKeys(body, ["error"], name);
    const error = requireObject(body.error, `${name}.error`);
    requireExactKeys(error, ["code", "message"], `${name}.error`);
    if (error.code !== "bad_request" || error.message !== "unknown connector id") {
      throw new Error(`${name} returned the wrong missing-connector simulation refusal`);
    }
    return;
  }
  if (name === "POST /sessions/:id/archive") {
    requireExactKeys(body, ["error", "message", "ok"], name);
    if (body.ok !== false || body.error !== "session_not_found" || typeof body.message !== "string"
      || !body.message.includes("shellx-release-missing-session")) {
      throw new Error(`${name} returned the wrong missing-session archive refusal`);
    }
    return;
  }
  if (name === "POST /tabs/:id/archive") {
    requireExactKeys(body, ["error", "message", "ok"], name);
    if (body.ok !== false || body.error !== "tab_not_found"
      || body.message !== "no live session exists for tab 'shellx-release-missing-tab'") {
      throw new Error(`${name} returned the wrong missing-tab archive refusal`);
    }
    return;
  }
  if (name === "POST /tools/process_list") {
    requireExactKeys(body, ["processes"], name);
    const processes = requireArray(body, "processes", name);
    for (const process of processes) {
      const row = requireObject(process, `${name}.process`);
      if (typeof row.taskId !== "string" || !row.taskId || !Number.isSafeInteger(row.pid)) {
        throw new Error(`${name} returned an invalid tracked-process row`);
      }
    }
    return;
  }
  if (name === "POST /tools/secret_get") {
    requireExactKeys(body, ["code", "isError", "message", "reason"], name);
    if (body.code !== "RAW_SECRET_REVEAL_DENIED" || body.reason !== "raw_secret_reveal_denied"
      || body.isError !== true || "value" in body || "secret" in body) {
      throw new Error(`${name} returned the wrong raw-secret refusal`);
    }
    return;
  }
  throw new Error(`missing safe-refusal response oracle for ${name}`);
}

function verifyIdlePreviewState(body: Record<string, unknown>, path: string): void {
  requireExactKeys(body, [
    "command", "cwd", "error", "kind", "logs", "pid", "startedAtMs", "status", "tabId",
    "taskId", "updatedAtMs", "url", "viewportHint",
  ], path);
  if (body.tabId !== "shellx-release-safe-refusal" || body.status !== "idle"
    || body.cwd !== null || body.kind !== null || body.url !== null || body.command !== null
    || body.taskId !== null || body.pid !== null || body.startedAtMs !== null
    || !Number.isSafeInteger(body.updatedAtMs) || body.viewportHint !== null || body.error !== null
    || !Array.isArray(body.logs) || body.logs.length !== 0) {
    throw new Error(`${path} did not preserve the exact idle Preview state`);
  }
}

function safeRefusalObservedEffect(name: string, status: number): string {
  if (name === "POST /tools/process_list") {
    return "POST /tools/process_list returned a typed bounded registry snapshot; process identities and commands were not retained.";
  }
  if (name === "POST /tools/secret_get") {
    return "POST /tools/secret_get returned the structured raw-secret denial without contacting a secret backend or exposing a value.";
  }
  if (name === "POST /browser/vault/fill-receipt" || name === "POST /browser/vault/generate-receipt") {
    return `${name} rejected a caller-authored Vault receipt and preserved the installed Browser receipt ledger byte-for-byte.`;
  }
  return `${name} returned its exact HTTP ${status} absent-state or pre-effect refusal without contacting a provider, process, remote, or external service.`;
}

async function exerciseOperatorGatedRoute(
  connection: { base: string; token: string },
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const config = OPERATOR_GATED_ROUTES[assignment.surface.name];
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No operator-gated Debug API denial was observed.",
  };
  let dialogFixture: DebugApiBrowserSettleFixture | null = null;
  try {
    if (!config) throw new Error(`missing operator-gated route config for ${assignment.surface.name}`);
    let requestBody = config.body;
    if (assignment.surface.name === "POST /browser/dialogs/resolve") {
      dialogFixture = await prepareDebugApiBrowserSettleFixture(connection);
      const recordedResponse = await fetch(`${connection.base}/browser/dialogs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${connection.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          taskId: dialogFixture.taskId,
          browserTabId: dialogFixture.browserTabId,
          dialogType: "confirm",
          text: "ShellX release operator gate",
          url: dialogFixture.url,
          requiresApproval: true,
        }),
      });
      if (recordedResponse.status !== 200) {
        throw new Error(`Browser dialog operator-gate fixture returned ${recordedResponse.status}`);
      }
      const recorded = requireObject(await recordedResponse.json(), "Browser dialog operator-gate fixture");
      if (recorded.status !== "pending" || recorded.taskId !== dialogFixture.taskId
        || recorded.browserTabId !== dialogFixture.browserTabId) {
        throw new Error("Browser dialog operator-gate fixture did not create one exact pending dialog");
      }
      requestBody = {
        dialogId: requireBoundedString(recorded.dialogId, "Browser dialog operator-gate fixture.dialogId"),
        action: "dismiss",
      };
    }
    const baseline = await (await fetchRoute(connection, config.statePath)).json();
    outcome.present = "pass";
    const method = assignment.surface.name.startsWith("DELETE ") ? "DELETE" : "POST";
    const response = await fetch(`${connection.base}${config.requestPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(requestBody ? { "Content-Type": "application/json" } : {}),
      },
      body: requestBody ? JSON.stringify(requestBody) : undefined,
    });
    outcome.invoke = "pass";
    const expectedStatus = config.status ?? 403;
    if (response.status !== expectedStatus) {
      throw new Error(`${assignment.surface.name} returned ${response.status} instead of operator-gated ${expectedStatus}`);
    }
    const body = requireObject(await response.json(), assignment.surface.name);
    const responseShape = config.responseShape ?? "nested";
    let denialMatches = false;
    if (responseShape === "nested") {
      requireExactKeys(body, ["error", "ok"], assignment.surface.name);
      const error = requireObject(body.error, `${assignment.surface.name}.error`);
      requireExactKeys(error, ["code", "message"], `${assignment.surface.name}.error`);
      denialMatches = body.ok === false && error.code === config.errorCode && error.message === config.errorMessage;
    } else if (responseShape === "flat-error") {
      requireExactKeys(body, ["error", "ok"], assignment.surface.name);
      denialMatches = body.ok === false && body.error === `${config.errorCode}: ${config.errorMessage}`;
    } else {
      requireExactKeys(body, ["code", "error", "ok"], assignment.surface.name);
      denialMatches = body.ok === false && body.code === config.errorCode
        && body.error === `${config.errorCode}: ${config.errorMessage}`;
    }
    if (!denialMatches) {
      throw new Error(`${assignment.surface.name} returned the wrong operator-gated denial contract`);
    }
    const after = await (await fetchRoute(connection, config.statePath)).json();
    if (!isDeepStrictEqual(after, baseline)) {
      throw new Error(`${assignment.surface.name} changed Browser state despite its operator-gated denial`);
    }
    outcome.effect = "pass";
    outcome.observedEffect = `${assignment.surface.name} returned its exact operator-only denial and preserved the corresponding Browser state byte-for-byte.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (dialogFixture) {
      const cleanupError = await cleanupDebugApiBrowserSettleFixture(connection, dialogFixture);
      if (cleanupError) {
        outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
      } else {
        outcome.cleanup = "pass";
      }
    } else {
      outcome.cleanup = "pass";
    }
  }
  return outcome;
}

async function exerciseBrowserBookmarkReorder(
  connection: { base: string; token: string },
  request: ReleaseSurfaceDriverRequest,
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
    observedEffect: "No isolated Browser bookmark reorder was observed.",
  };
  const suffix = request.sourceCommit.slice(0, 16);
  const folderId = `release-surface-reorder-folder-${suffix}`;
  const linkId = `release-surface-reorder-link-${suffix}`;
  try {
    const baseline = await readBrowserBookmarks(connection);
    if (baseline.some((bookmark) => bookmark.bookmarkId === folderId || bookmark.bookmarkId === linkId)) {
      throw new Error("isolated Browser bookmark reorder fixture collided with an existing marker");
    }
    verifyBookmarkFolderUpsertResponse(await mutateBrowserBookmark(connection, "POST", "/browser/bookmarks", {
      bookmarkId: folderId,
      label: `Release surface reorder folder ${suffix}`,
      kind: "folder",
      category: "release-surface",
      toolbarPinned: false,
    }), folderId);
    verifyBookmarkUpsertResponse(await mutateBrowserBookmark(connection, "POST", "/browser/bookmarks", {
      bookmarkId: linkId,
      label: `Release surface reorder link ${suffix}`,
      kind: "link",
      url: `https://example.com/shellx-release/reorder/${suffix}`,
      category: "release-surface",
      toolbarPinned: false,
    }), linkId, `Release surface reorder link ${suffix}`, `https://example.com/shellx-release/reorder/${suffix}`);
    outcome.present = "pass";
    const reordered = await mutateBrowserBookmark(connection, "POST", "/browser/bookmarks/reorder", {
      items: [{ bookmarkId: linkId, parentId: folderId, toolbarPinned: false }],
    });
    outcome.invoke = "pass";
    verifyBookmarkReorderResponse(reordered);
    const current = await readBrowserBookmarks(connection);
    const link = current.find((bookmark) => bookmark.bookmarkId === linkId);
    if (!link || link.parentId !== folderId || link.toolbarPinned !== false) {
      throw new Error("POST /browser/bookmarks/reorder did not move its owned link into its owned folder");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "POST /browser/bookmarks/reorder moved exactly one owned link into its owned folder in the isolated release profile.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      let current = await readBrowserBookmarks(connection);
      for (const bookmarkId of [linkId, folderId]) {
        if (!current.some((bookmark) => bookmark.bookmarkId === bookmarkId)) continue;
        verifyBookmarkDeleteResponse(await mutateBrowserBookmark(
          connection,
          "DELETE",
          `/browser/bookmarks/${encodeURIComponent(bookmarkId)}`,
        ));
        current = await readBrowserBookmarks(connection);
      }
      if (current.some((bookmark) => bookmark.bookmarkId === folderId || bookmark.bookmarkId === linkId)) {
        throw new Error("owned Browser bookmark reorder fixtures remained after cleanup");
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

async function exerciseBrowserBookmarkMutation(
  connection: { base: string; token: string },
  request: ReleaseSurfaceDriverRequest,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
  method: string,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No isolated Browser bookmark mutation was observed.",
  };
  const suffix = request.sourceCommit.slice(0, 16);
  const bookmarkId = `release-surface-${method.toLowerCase()}-bookmark-${suffix}`;
  const label = `Release surface ${method.toLowerCase()} bookmark ${suffix}`;
  const url = `https://example.com/shellx-release/${method.toLowerCase()}/${suffix}`;
  try {
    const baseline = await readBrowserBookmarks(connection);
    if (baseline.some((bookmark) => bookmark.bookmarkId === bookmarkId)) {
      throw new Error("isolated Browser bookmark fixture collided with an existing marker");
    }
    if (method === "DELETE") {
      const prepared = await mutateBrowserBookmark(connection, "POST", "/browser/bookmarks", {
        bookmarkId,
        label,
        kind: "link",
        url,
        category: "release-surface",
        toolbarPinned: false,
      });
      verifyBookmarkUpsertResponse(prepared, bookmarkId, label, url);
    }
    outcome.present = "pass";
    if (method === "POST") {
      const created = await mutateBrowserBookmark(connection, "POST", "/browser/bookmarks", {
        bookmarkId,
        label,
        kind: "link",
        url,
        category: "release-surface",
        toolbarPinned: false,
      });
      outcome.invoke = "pass";
      verifyBookmarkUpsertResponse(created, bookmarkId, label, url);
      const current = await readBrowserBookmarks(connection);
      const matches = current.filter((bookmark) => bookmark.bookmarkId === bookmarkId);
      if (matches.length !== 1 || matches[0]!.label !== label || matches[0]!.url !== url) {
        throw new Error("POST /browser/bookmarks did not create exactly its owned bookmark");
      }
      outcome.effect = "pass";
      outcome.observedEffect = "POST /browser/bookmarks created exactly one owned bookmark in the isolated release profile; bookmark contents were not retained.";
    } else {
      const deleted = await mutateBrowserBookmark(
        connection,
        "DELETE",
        `/browser/bookmarks/${encodeURIComponent(bookmarkId)}`,
      );
      outcome.invoke = "pass";
      verifyBookmarkDeleteResponse(deleted);
      if ((await readBrowserBookmarks(connection)).some((bookmark) => bookmark.bookmarkId === bookmarkId)) {
        throw new Error("DELETE /browser/bookmarks/:bookmark_id retained its owned bookmark");
      }
      outcome.effect = "pass";
      outcome.observedEffect = "DELETE /browser/bookmarks/:bookmark_id removed exactly its prepared owned bookmark from the isolated release profile.";
    }
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if ((await readBrowserBookmarks(connection)).some((bookmark) => bookmark.bookmarkId === bookmarkId)) {
        verifyBookmarkDeleteResponse(await mutateBrowserBookmark(
          connection,
          "DELETE",
          `/browser/bookmarks/${encodeURIComponent(bookmarkId)}`,
        ));
      }
      if ((await readBrowserBookmarks(connection)).some((bookmark) => bookmark.bookmarkId === bookmarkId)) {
        throw new Error("owned Browser bookmark remained after cleanup");
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

type BrowserBookmarkRow = {
  bookmarkId: string;
  label?: string;
  url?: string | null;
  parentId?: string | null;
  toolbarPinned?: boolean;
};

async function readBrowserBookmarks(connection: { base: string; token: string }): Promise<BrowserBookmarkRow[]> {
  const body = requireObject(
    await (await fetchRoute(connection, "/browser/bookmarks")).json(),
    "Browser bookmarks fixture",
  );
  requireExactKeys(body, ["bookmarkToolbar", "bookmarks"], "/browser/bookmarks");
  return requireArray(body, "bookmarks", "/browser/bookmarks").map((value) => {
    const bookmark = requireObject(value, "Browser bookmark fixture row");
    if (typeof bookmark.bookmarkId !== "string" || !bookmark.bookmarkId) {
      throw new Error("Browser bookmark fixture row omitted bookmarkId");
    }
    if (bookmark.label !== undefined && typeof bookmark.label !== "string") {
      throw new Error("Browser bookmark fixture row returned invalid label");
    }
    if (bookmark.url !== undefined && bookmark.url !== null && typeof bookmark.url !== "string") {
      throw new Error("Browser bookmark fixture row returned invalid url");
    }
    if (bookmark.parentId !== undefined && bookmark.parentId !== null && typeof bookmark.parentId !== "string") {
      throw new Error("Browser bookmark fixture row returned invalid parentId");
    }
    if (bookmark.toolbarPinned !== undefined && typeof bookmark.toolbarPinned !== "boolean") {
      throw new Error("Browser bookmark fixture row returned invalid toolbarPinned");
    }
    return bookmark as BrowserBookmarkRow;
  });
}

function verifyBookmarkFolderUpsertResponse(body: Record<string, unknown>, bookmarkId: string): void {
  requireExactKeys(body, ["bookmark", "ok", "receipt"], "POST /browser/bookmarks");
  const bookmark = requireObject(body.bookmark, "POST /browser/bookmarks.bookmark");
  const receipt = requireObject(body.receipt, "POST /browser/bookmarks.receipt");
  if (body.ok !== true || bookmark.bookmarkId !== bookmarkId || bookmark.kind !== "folder"
    || bookmark.url !== null || receipt.kind !== "browserBookmarkFolderSaved") {
    throw new Error("POST /browser/bookmarks returned an invalid owned folder response");
  }
}

function verifyBookmarkReorderResponse(body: Record<string, unknown>): void {
  requireExactKeys(body, ["bookmarkToolbar", "ok", "receipt"], "POST /browser/bookmarks/reorder");
  const receipt = requireObject(body.receipt, "POST /browser/bookmarks/reorder.receipt");
  if (body.ok !== true || !Array.isArray(body.bookmarkToolbar)
    || receipt.kind !== "browserBookmarkToolbarChanged"
    || typeof receipt.receiptId !== "string" || !receipt.receiptId) {
    throw new Error("POST /browser/bookmarks/reorder omitted its toolbar-change receipt");
  }
}

async function mutateBrowserBookmark(
  connection: { base: string; token: string },
  method: "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${await response.text()}`);
  return requireObject(await response.json(), `${method} ${path}`);
}

function verifyBookmarkUpsertResponse(
  body: Record<string, unknown>,
  bookmarkId: string,
  label: string,
  url: string,
): void {
  requireExactKeys(body, ["bookmark", "ok", "receipt"], "POST /browser/bookmarks");
  const bookmark = requireObject(body.bookmark, "POST /browser/bookmarks.bookmark");
  if (body.ok !== true || bookmark.bookmarkId !== bookmarkId || bookmark.label !== label || bookmark.url !== url
    || bookmark.kind !== "link" || bookmark.category !== "release-surface" || bookmark.toolbarPinned !== false) {
    throw new Error("POST /browser/bookmarks returned an invalid owned bookmark response");
  }
  const receipt = requireObject(body.receipt, "POST /browser/bookmarks.receipt");
  if (receipt.kind !== "browserBookmarkSaved" || typeof receipt.receiptId !== "string" || !receipt.receiptId) {
    throw new Error("POST /browser/bookmarks omitted its saved-bookmark receipt");
  }
}

function verifyBookmarkDeleteResponse(body: Record<string, unknown>): void {
  requireExactKeys(body, ["ok", "receipt"], "DELETE /browser/bookmarks/:bookmark_id");
  const receipt = requireObject(body.receipt, "DELETE /browser/bookmarks/:bookmark_id.receipt");
  if (body.ok !== true || receipt.kind !== "browserBookmarkDeleted"
    || typeof receipt.receiptId !== "string" || !receipt.receiptId) {
    throw new Error("DELETE /browser/bookmarks/:bookmark_id omitted its deletion receipt");
  }
}

async function verifyAuthenticatedEventStream(connection: { base: string; token: string }): Promise<string> {
  const url = `${connection.base.replace(/^http/, "ws").replace(/\/$/, "")}/events?token=${encodeURIComponent(connection.token)}`;
  const socket = new WebSocket(url);
  let opened = false;
  let typedFrames = 0;
  let invalidFrame = false;
  let lagged = false;
  try {
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error("authenticated event stream did not open")), 10_000);
      socket.onopen = () => {
        opened = true;
        clearTimeout(timer);
        resolveOpen();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        rejectOpen(new Error("authenticated event stream failed to open"));
      };
      socket.onmessage = (event) => {
        if (typedFrames >= 8) return;
        try {
          const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (frame.kind === "debug-api"
            && frame.payload && typeof frame.payload === "object"
            && (frame.payload as Record<string, unknown>).warning === "lagged") {
            lagged = true;
            return;
          }
          if (!Number.isSafeInteger(frame.t) || typeof frame.kind !== "string" || !frame.kind
            || !frame.payload || typeof frame.payload !== "object" || Array.isArray(frame.payload)) {
            invalidFrame = true;
            return;
          }
          typedFrames += 1;
        } catch {
          invalidFrame = true;
        }
      };
    });
    await delay(75);
    if (invalidFrame) throw new Error("authenticated event stream emitted an invalid event frame");
    if (lagged) throw new Error("authenticated event stream reported a backlog gap during its bounded observation");
    return `Authenticated event WebSocket opened and emitted ${typedFrames} bounded typed frame(s); payload content and bearer token were not retained.`;
  } finally {
    if (opened && socket.readyState === WebSocket.OPEN) {
      const closed = new Promise<void>((resolveClose) => {
        const timer = setTimeout(resolveClose, 1_000);
        socket.onclose = () => {
          clearTimeout(timer);
          resolveClose();
        };
      });
      socket.close(1000, "release surface read complete");
      await closed;
    } else if (socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function verifyJsonBody(
  path: string,
  value: unknown,
  request: ReleaseSurfaceDriverRequest,
  sessionFixture: DebugApiSessionFixture | null,
  filesFixture: DebugApiFilesFixture | null,
  settleFixture: DebugApiBrowserSettleFixture | null,
  gitFixture: DebugApiGitFixture | null,
): string {
  if (path === "/events/recent") {
    if (!Array.isArray(value)) throw new Error("recent events did not return its backward-compatible bounded array");
    for (const event of value) {
      if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("recent events contained a non-object row");
      const row = event as Record<string, unknown>;
      if (!Number.isSafeInteger(row.t) || typeof row.kind !== "string" || !row.kind || !row.payload || typeof row.payload !== "object") {
        throw new Error("recent events contained an invalid timestamp, kind, or payload");
      }
    }
    return `Recent events returned ${value.length} bounded event row(s); payload content was not retained.`;
  }
  if (!value || typeof value !== "object") throw new Error(`${path} did not return a JSON object`);
  const body = value as Record<string, unknown>;
  const sessionEffect = verifyDebugApiSessionJson(path, body, sessionFixture);
  if (sessionEffect) return sessionEffect;
  const filesEffect = verifyDebugApiFilesJson(path, body, filesFixture);
  if (filesEffect) return filesEffect;
  const settleEffect = verifyDebugApiBrowserSettleJson(path, body, settleFixture);
  if (settleEffect) return settleEffect;
  const gitEffect = verifyDebugApiGitJson(path, body, gitFixture);
  if (gitEffect) return gitEffect;
  if (path === "/health") {
    if (body.appVersion !== request.version && body.app_version !== request.version) throw new Error("health app version does not match the frozen request");
    if (body.buildCommit !== request.sourceCommit && body.build_commit !== request.sourceCommit) throw new Error("health build commit does not match the frozen request");
    return `Health identified ShellX ${request.version} at source commit ${request.sourceCommit}.`;
  }
  if (path === "/agent-doc/manifest") {
    const raw = JSON.stringify(body);
    if (body.name !== "shellxagent-docs" || !raw.includes("/agent-doc/skills/shellx-host/SKILL.md")
      || !raw.includes("session-scoped; injected only into agents launched by ShellX")) {
      throw new Error("agent documentation manifest omitted the installed session-scoped ShellX host skill");
    }
    return "Agent documentation manifest advertised the installed session-scoped ShellX host skill.";
  }
  if (path === "/agent-doc") {
    const raw = JSON.stringify(body);
    if (body.name !== "shellxagent-docs" || !raw.includes("/agent-doc/skills/shellx-host/SKILL.md")
      || !raw.includes("session-scoped; injected only into agents launched by ShellX")) {
      throw new Error("agent documentation alias omitted the installed session-scoped ShellX host skill");
    }
    return "Agent documentation alias returned the installed session-scoped ShellX host manifest.";
  }
  if (path === "/settings") {
    const expectedKeys = ["browserDownloadFolder", "chatFontPx", "density", "githubGhBinary", "theme"];
    const actualKeys = Object.keys(body).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error(`settings returned unexpected keys: ${actualKeys.join(", ")}`);
    }
    if (!["compact", "default", "comfortable"].includes(String(body.density))
      || !["black", "black_warm", "bright"].includes(String(body.theme))
      || typeof body.chatFontPx !== "number" || body.chatFontPx < 12 || body.chatFontPx > 26
      || typeof body.browserDownloadFolder !== "string"
      || !["gh", "gh.exe"].includes(String(body.githubGhBinary))) {
      throw new Error("settings did not match the normalized public schema");
    }
    return "Settings returned exactly six normalized public fields and no credential field.";
  }
  if (path === "/connections") {
    const presets = requireArray(body, "presets", path);
    for (const preset of presets) {
      if (!preset || typeof preset !== "object") throw new Error("connections contained a non-object preset");
      const item = preset as Record<string, unknown>;
      if (typeof item.id !== "string" || !item.id || typeof item.label !== "string"
        || !item.transport || typeof item.transport !== "object"
        || typeof item.createdMs !== "number" || typeof item.lastUsedMs !== "number") {
        throw new Error("connections contained a preset outside the public reference-only schema");
      }
    }
    return `Connections returned ${presets.length} reference-only preset${presets.length === 1 ? "" : "s"}.`;
  }
  if (path === "/browser/summary") {
    if (typeof body.browserProtocolVersion !== "string" || !body.browserProtocolVersion
      || typeof body.browserSchemaRevision !== "string" || !body.browserSchemaRevision
      || !body.revisions || typeof body.revisions !== "object"
      || !body.counts || typeof body.counts !== "object"
      || !Array.isArray(body.pendingRequests)
      || typeof body.windowOpen !== "boolean"
      || typeof body.personalBrowserLocked !== "boolean") {
      throw new Error("browser summary omitted protocol, revision, count, or state fields");
    }
    const counts = body.counts as Record<string, unknown>;
    for (const key of ["profiles", "tabs", "tasks", "runningTasks", "pendingRequests"]) {
      if (!Number.isInteger(counts[key]) || Number(counts[key]) < 0) throw new Error(`browser summary returned an invalid ${key} count`);
    }
    return `Browser summary used protocol ${body.browserProtocolVersion} with ${counts.tabs} tab(s), ${counts.tasks} task(s), and ${counts.pendingRequests} pending request(s).`;
  }
  if (path === "/browser/tabs") {
    const tabs = requireArray(body, "tabs", path);
    for (const tab of tabs) {
      if (!tab || typeof tab !== "object") throw new Error("browser tabs contained a non-object entry");
      const item = tab as Record<string, unknown>;
      if (typeof item.browserTabId !== "string" || !item.browserTabId
        || typeof item.engineId !== "string" || !item.engineId
        || typeof item.profileId !== "string" || !item.profileId
        || typeof item.status !== "string" || !item.status) {
        throw new Error("browser tabs contained an entry without stable identity and status");
      }
    }
    return `Browser tabs returned ${tabs.length} stable tab snapshot${tabs.length === 1 ? "" : "s"}.`;
  }
  if (path === "/browser/profiles") {
    const profiles = requireArray(body, "profiles", path);
    for (const profile of profiles) {
      if (!profile || typeof profile !== "object") throw new Error("browser profiles contained a non-object entry");
      const item = profile as Record<string, unknown>;
      if (typeof item.profileId !== "string" || !item.profileId
        || typeof item.label !== "string" || !item.label
        || typeof item.agentDefault !== "boolean"
        || typeof item.cookiesEnabled !== "boolean"
        || typeof item.persistent !== "boolean") {
        throw new Error("browser profiles contained an entry outside the public profile schema");
      }
    }
    return `Browser profiles returned ${profiles.length} configured profile${profiles.length === 1 ? "" : "s"}.`;
  }
  if (path === "/browser/tasks") {
    const tasks = requireArray(body, "tasks", path);
    if (body.detail !== "summary" || body.includeObservation !== false || typeof body.revision !== "string") {
      throw new Error("browser tasks did not return the bounded summary view");
    }
    for (const task of tasks) {
      if (!task || typeof task !== "object") throw new Error("browser tasks contained a non-object entry");
      const item = task as Record<string, unknown>;
      if (typeof item.taskId !== "string" || !item.taskId
        || typeof item.profileId !== "string" || !item.profileId
        || typeof item.status !== "string" || !item.status
        || "lastObservation" in item) {
        throw new Error("browser tasks contained an unbounded or unidentified summary");
      }
    }
    return `Browser tasks returned ${tasks.length} summary record${tasks.length === 1 ? "" : "s"} without observations.`;
  }
  if (path === "/state/header") {
    requireExactKeys(body, ["autonomy", "session", "tabId"], path);
    if (!body.session || typeof body.session !== "object" || typeof body.tabId !== "string" || !body.tabId
      || (body.autonomy !== null && typeof body.autonomy !== "string")) {
      throw new Error("state header omitted its tab, session, or nullable autonomy model");
    }
    return `Header state returned the ${body.tabId} session context and nullable autonomy selection.`;
  }
  if (path === "/state/footer") {
    requireExactKeys(body, ["chats", "events", "session", "tabId", "ws"], path);
    if (!Number.isInteger(body.events) || Number(body.events) < 0
      || !Number.isInteger(body.chats) || Number(body.chats) < 0
      || !body.session || typeof body.session !== "object"
      || typeof body.tabId !== "string" || !body.tabId
      || typeof body.ws !== "string" || !/^ws:\/\/127\.0\.0\.1:\d+\/events$/.test(body.ws)) {
      throw new Error("state footer omitted bounded counters, loopback event URL, or session context");
    }
    return `Footer state returned ${body.events} event(s), ${body.chats} chat(s), and a loopback event stream.`;
  }
  if (path === "/state/ui") {
    requirePanelSizes(body.panels, `${path}.panels`);
    for (const key of ["debugHighlights", "debugHighlightResults", "openTabs"]) {
      if (!Array.isArray(body[key])) throw new Error(`${path} did not return a ${key} array`);
    }
    if (!Number.isSafeInteger(body.uiRevision) || Number(body.uiRevision) < 0) {
      throw new Error("state UI omitted its monotonic revision");
    }
    return `UI state returned revision ${body.uiRevision}, panel geometry, and ${(body.openTabs as unknown[]).length} open tab(s).`;
  }
  if (path === "/panels") {
    requireExactKeys(body, ["horizontal", "vertical"], path);
    requirePanelSizes(body, path);
    return "Panel state returned finite three-way horizontal and two-way vertical geometry.";
  }
  if (path === "/preview") {
    requireExactKeys(body, ["preview"], path);
    if (body.preview !== null) {
      if (!body.preview || typeof body.preview !== "object" || Array.isArray(body.preview)) {
        throw new Error("preview returned an invalid target");
      }
      const preview = body.preview as Record<string, unknown>;
      if (typeof preview.kind !== "string" || !preview.kind || typeof preview.path !== "string" || !preview.path) {
        throw new Error("preview target omitted kind or path");
      }
    }
    return body.preview === null ? "Preview state returned an explicit empty target." : "Preview state returned a typed path target.";
  }
  if (path === "/preview/work/state") {
    const statuses = new Set(["idle", "starting", "running", "failed", "stopped"]);
    if (typeof body.tabId !== "string" || !body.tabId || !statuses.has(String(body.status))
      || !Array.isArray(body.logs) || !Number.isSafeInteger(body.updatedAtMs)) {
      throw new Error("work preview state omitted tab identity, status, log ring, or update time");
    }
    return `Work Preview state returned ${body.status} for ${body.tabId} with ${body.logs.length} bounded log line(s).`;
  }
  if (path === "/preview/work/logs") {
    const logs = requireArray(body, "logs", path);
    if (typeof body.tabId !== "string" || !body.tabId) throw new Error("work preview logs omitted tab identity");
    for (const log of logs) {
      if (!log || typeof log !== "object" || Array.isArray(log)) throw new Error("work preview logs contained a non-object entry");
      const item = log as Record<string, unknown>;
      if (!Number.isSafeInteger(item.t) || typeof item.stream !== "string" || typeof item.line !== "string") {
        throw new Error("work preview logs contained an invalid timestamp, stream, or line");
      }
    }
    return `Work Preview logs returned ${logs.length} bounded line${logs.length === 1 ? "" : "s"} for ${body.tabId}.`;
  }
  if (path === "/preview/work/diagnose") {
    requireExactKeys(body, [
      "browserEvents", "command", "cwd", "httpStatus", "issues", "logs", "ok",
      "responseBytes", "screenshotBrowser", "screenshotError", "screenshotHeight",
      "screenshotPath", "screenshotWidth", "state", "status", "summary", "tabId",
      "title", "url",
    ], path);
    if (body.tabId !== "final-surface-preview-diagnose-missing-session"
      || body.ok !== false
      || body.status !== "failed"
      || typeof body.summary !== "string" || !body.summary
      || body.url !== null || body.cwd !== null || body.command !== null
      || body.httpStatus !== null || body.responseBytes !== null || body.title !== null
      || body.screenshotPath !== null || body.screenshotWidth !== null || body.screenshotHeight !== null
      || body.screenshotBrowser !== null || body.screenshotError !== null
      || !Array.isArray(body.issues) || body.issues.length !== 2
      || !Array.isArray(body.browserEvents) || body.browserEvents.length !== 0
      || !Array.isArray(body.logs) || body.logs.length !== 0) {
      throw new Error("work preview diagnostic GET was not an exact read-only absent-session snapshot");
    }
    const issueMessages = body.issues.map((value, index) => {
      const issue = requireObject(value, `${path}.issues[${index}]`);
      if (issue.severity !== "error" || issue.source !== "preview" || typeof issue.message !== "string") {
        throw new Error("work preview diagnostic GET returned an invalid derived issue");
      }
      return issue.message;
    });
    if (!isDeepStrictEqual(issueMessages, ["preview status is Idle", "preview has no URL to inspect"])) {
      throw new Error("work preview diagnostic GET returned the wrong absent-session issues");
    }
    const state = requireObject(body.state, `${path}.state`);
    if (state.tabId !== body.tabId || state.status !== "idle" || state.url !== null
      || !Array.isArray(state.logs) || state.logs.length !== 0 || !Number.isSafeInteger(state.updatedAtMs)) {
      throw new Error("work preview diagnostic GET returned an invalid idle state snapshot");
    }
    return "Work Preview diagnosis returned an exact absent-session snapshot without a live HTTP probe, screenshot capture, or build receipt.";
  }
  if (path === "/goal/state") {
    requireExactKeys(body, ["approvalStatus", "lastClear", "state", "tabId"], path);
    if (typeof body.tabId !== "string" || !body.tabId) throw new Error("goal state omitted tab identity");
    return `Goal state returned an explicit ${body.state === null ? "empty" : "active"} state for ${body.tabId}.`;
  }
  if (path === "/build/state") {
    requireExactKeys(body, ["state", "tabId"], path);
    if (typeof body.tabId !== "string" || !body.tabId) throw new Error("build state omitted tab identity");
    return `Build state returned an explicit ${body.state === null ? "empty" : "active"} state for ${body.tabId}.`;
  }
  if (path === "/vault/status") {
    const expectedKeys = [
      "activeGrants", "lastError", "legacyVaultDetected", "mode", "pendingDeposits",
      "recoveryConfirmed", "rememberedDeviceEnabled", "syncPending", "unlocked",
    ];
    requireExactKeys(body, expectedKeys, path);
    if (!["unconfigured", "local", "external"].includes(String(body.mode))
      || typeof body.unlocked !== "boolean" || typeof body.recoveryConfirmed !== "boolean"
      || typeof body.rememberedDeviceEnabled !== "boolean" || typeof body.legacyVaultDetected !== "boolean"
      || !Number.isSafeInteger(body.activeGrants) || Number(body.activeGrants) < 0
      || !Number.isSafeInteger(body.pendingDeposits) || Number(body.pendingDeposits) < 0
      || typeof body.syncPending !== "boolean"
      || (body.lastError !== null && typeof body.lastError !== "string")) {
      throw new Error("Vault status returned an invalid metadata-only state");
    }
    return `Vault status returned ${body.mode} metadata with ${body.activeGrants} active grant(s) and no secret values.`;
  }
  if (path === "/state/sessions") {
    requireExactKeys(body, ["count", "tabs"], path);
    const tabs = requireCountedArray(body, "tabs", "count", path);
    for (const tab of tabs) {
      if (!tab || typeof tab !== "object" || Array.isArray(tab)
        || typeof (tab as Record<string, unknown>).tabId !== "string"
        || !(tab as Record<string, unknown>).tabId) {
        throw new Error("session state contained a tab without stable identity");
      }
    }
    return `Session state returned ${tabs.length} stable non-materializing tab snapshot${tabs.length === 1 ? "" : "s"}.`;
  }
  if (path === "/state/tabs/report") {
    requireExactKeys(body, [
      "activeTabId", "count", "finishedCount", "generatedAtMs", "needsAttentionCount", "runningCount", "tabs",
    ], path);
    const tabs = requireCountedArray(body, "tabs", "count", path);
    requireNonNegativeIntegers(body, ["generatedAtMs", "runningCount", "finishedCount", "needsAttentionCount"], path);
    if (Number(body.runningCount) + Number(body.finishedCount) + Number(body.needsAttentionCount) > tabs.length) {
      throw new Error("tab report status counters exceed its exact tab count");
    }
    return `Tab report returned ${tabs.length} row(s) with bounded lifecycle counters.`;
  }
  if (path === "/state/agent_runs") {
    requireExactKeys(body, ["activeTabId", "generatedAtMs", "nativeSubagents", "runs", "summary"], path);
    const runs = requireArray(body, "runs", path);
    if (!body.summary || typeof body.summary !== "object" || Array.isArray(body.summary)
      || !body.nativeSubagents || typeof body.nativeSubagents !== "object" || Array.isArray(body.nativeSubagents)) {
      throw new Error("agent runs omitted summary or native-subagent visibility");
    }
    const summary = body.summary as Record<string, unknown>;
    requireNonNegativeIntegers(summary, [
      "runCount", "runningCount", "tabSessionCount", "providerRunCount", "shellxSubagentCount", "observedNativeSubagentCount",
    ], `${path}.summary`);
    if (summary.runCount !== runs.length || Number(summary.runningCount) > runs.length) {
      throw new Error("agent run summary does not match its exact run rows");
    }
    return `Agent runs returned ${runs.length} provider-neutral row(s) with native-subagent visibility.`;
  }
  if (path === "/state/session_assets") {
    requireExactKeys(body, ["assets", "count", "images", "videos"], path);
    const assets = requireCountedArray(body, "assets", "count", path);
    const images = requireArray(body, "images", path);
    const videos = requireArray(body, "videos", path);
    if (images.length + videos.length !== assets.length) throw new Error("session asset type partitions do not match the exact asset count");
    for (const asset of assets) {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) throw new Error("session assets contained a non-object entry");
      const item = asset as Record<string, unknown>;
      if (!['image', 'video'].includes(String(item.kind)) || typeof item.path !== "string" || !item.path
        || typeof item.sourceTabId !== "string" || !item.sourceTabId || !Number.isSafeInteger(item.t)) {
        throw new Error("session assets contained an unidentified or untyped media entry");
      }
    }
    return `Session assets returned ${assets.length} source-scoped media record${assets.length === 1 ? "" : "s"}.`;
  }
  if (path === "/state/marketplace_health") {
    requireExactKeys(body, ["entries", "tabId"], path);
    const entries = requireArray(body, "entries", path);
    if (typeof body.tabId !== "string" || !body.tabId) throw new Error("marketplace health omitted tab identity");
    for (const entry of entries) requireMarketplaceHealthEntry(entry, path);
    return `Marketplace health returned ${entries.length} launcher snapshot${entries.length === 1 ? "" : "s"} for ${body.tabId}.`;
  }
  if (path === "/state/session_tooling") {
    requireExactKeys(body, ["desired", "health", "session", "tabId"], path);
    const desired = requireArray(body, "desired", path);
    const health = requireArray(body, "health", path);
    if (typeof body.tabId !== "string" || !body.tabId || !body.session || typeof body.session !== "object") {
      throw new Error("session tooling omitted tab or session context");
    }
    for (const entry of desired) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("session tooling desired catalog contained a non-object entry");
      const item = entry as Record<string, unknown>;
      if (typeof item.id !== "string" || !item.id || typeof item.enabled !== "boolean") {
        throw new Error("session tooling desired catalog omitted stable identity or enabled state");
      }
    }
    for (const entry of health) requireMarketplaceHealthEntry(entry, path);
    return `Session tooling returned ${desired.length} desired entr${desired.length === 1 ? "y" : "ies"} and ${health.length} health receipt(s).`;
  }
  if (path === "/state/session_activity") {
    requireExactKeys(body, [
      "cwd", "hunkRecordsJsonl", "hunkRecordsPath", "note", "readable", "report",
      "scratchDir", "sessionId", "status", "tabId", "transport", "updatesJsonl", "updatesPath",
    ], path);
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
      throw new Error("session activity did not return the exact non-creating absent-session source");
    }
    const report = requireObject(body.report, `${path}.report`);
    const summary = requireObject(report.summary, `${path}.report.summary`);
    if (report.schemaVersion !== "shellx.sessionActivity.report.v1"
      || !Array.isArray(report.changes)
      || !Array.isArray(report.readsAndSearches)
      || !Array.isArray(report.git)
      || !Array.isArray(report.commands)
      || Object.values(summary).some((value) => value !== 0)) {
      throw new Error("session activity absent-session report was not exactly empty");
    }
    return "Session Activity returned an exact empty derived report for an absent disposable tab without creating a ghost session or activity file.";
  }
  if (path === "/state/environment" || path === "/state/grok_environment") {
    requireExactKeys(body, [
      "apiKeyHint", "checkedAtMs", "cwd", "doctor", "error", "inspect", "readiness",
      "sessionId", "setup", "status", "tabId", "trace", "transport",
    ], path);
    const expectedTab = path === "/state/environment"
      ? "final-surface-environment-missing-session"
      : "final-surface-grok-environment-missing-session";
    if (body.tabId !== expectedTab
      || body.status !== "idle"
      || body.transport !== "none"
      || body.cwd !== null
      || body.sessionId !== null
      || body.doctor !== null
      || body.inspect !== null
      || typeof body.error !== "string"
      || body.error.length === 0
      || !Number.isSafeInteger(body.checkedAtMs)) {
      throw new Error(`${path} did not return the exact absent-session environment identity`);
    }
    for (const section of ["setup", "readiness"] as const) {
      const model = requireObject(body[section], `${path}.${section}`);
      const summary = requireObject(model.summary, `${path}.${section}.summary`);
      const checks = requireArray(model, "checks", `${path}.${section}`);
      for (const key of ["readyCount", "attentionCount", "totalCount"]) {
        if (!Number.isSafeInteger(summary[key]) || Number(summary[key]) < 0) {
          throw new Error(`${path} ${section} summary omitted a non-negative ${key}`);
        }
      }
      if (summary.totalCount !== checks.length) throw new Error(`${path} ${section} count did not match its checks`);
    }
    const apiKeyHint = requireObject(body.apiKeyHint, `${path}.apiKeyHint`);
    requireExactKeys(apiKeyHint, ["detail", "legacyEnv", "legacyPresent", "preferredEnv", "preferredPresent"], `${path}.apiKeyHint`);
    if (typeof apiKeyHint.preferredEnv !== "string" || typeof apiKeyHint.legacyEnv !== "string"
      || typeof apiKeyHint.preferredPresent !== "boolean" || typeof apiKeyHint.legacyPresent !== "boolean"
      || typeof apiKeyHint.detail !== "string") {
      throw new Error(`${path} API-key hint exposed an invalid or non-redacted shape`);
    }
    const trace = requireObject(body.trace, `${path}.trace`);
    if (trace.available !== false || trace.sessionId !== null || typeof trace.detail !== "string") {
      throw new Error(`${path} absent-session trace availability was not safely closed`);
    }
    return `${path} returned an idle absent-session environment with typed setup/readiness checks and credential-presence booleans only; paths and details were not retained.`;
  }
  if (path === "/state/subagents") {
    requireExactKeys(body, ["count", "subagents"], path);
    const rows = requireArray(body, "subagents", path);
    if (!Number.isSafeInteger(body.count) || body.count !== rows.length || rows.length > 64) {
      throw new Error("subagent snapshot count was invalid or exceeded its bounded recent window");
    }
    for (const row of rows) {
      const entry = requireObject(row, `${path}.subagent`);
      if (typeof entry.id !== "string" || !entry.id || typeof entry.status !== "string" || !entry.status
        || typeof entry.persona !== "string" || typeof entry.taskPreview !== "string"
        || !Number.isSafeInteger(entry.startedUnixMs) || typeof entry.killed !== "boolean"
        || !Number.isSafeInteger(entry.stdoutBytes) || !Number.isSafeInteger(entry.stderrTailBytes)) {
        throw new Error("subagent snapshot contained an invalid typed row");
      }
    }
    return `Subagent snapshot returned ${rows.length} typed recent row(s) through a read-only database connection; identities, tasks, and output metadata were not retained.`;
  }
  const browserReadEffect = verifyDebugApiBrowserRead(path, body);
  if (browserReadEffect) return browserReadEffect;
  const integrationReadEffect = verifyIntegrationRead(path, body);
  if (integrationReadEffect) return integrationReadEffect;
  if (body.appVersion !== request.version || body.buildCommit !== request.sourceCommit) throw new Error("descriptor identity does not match the frozen request");
  if (body.token !== null || body.rawCdpExposed !== false || body.rawCdpEndpoint !== null) {
    throw new Error("served descriptor exposed a token or raw CDP surface");
  }
  for (const key of ["url", "browserAction", "browserCheck", "browserSummary", "browserState", "browserTabs", "events", "health"]) {
    if (typeof body[key] !== "string" || !body[key]) throw new Error(`served descriptor omitted ${key}`);
  }
  return `${path} returned the exact app/source identity and only gated Browser endpoints.`;
}

function verifyIntegrationRead(path: string, body: Record<string, unknown>): string | null {
  if (path === "/build/receipts") {
    if (body.ok === false) {
      requireExactKeys(body, ["message", "ok", "tabId"], path);
      if (body.tabId !== "default" || body.message !== "no build run for this tab") {
        throw new Error("absent build receipt directory returned the wrong explicit not-found contract");
      }
      return "Build receipt directory returned its exact explicit no-build snapshot for the default tab.";
    }
    const receipts = requireArray(body, "receipts", path);
    if (body.ok !== true || typeof body.tabId !== "string" || !body.tabId) {
      throw new Error("build receipt directory omitted its success or tab identity");
    }
    for (const receipt of receipts) requireObject(receipt, `${path}.receipt`);
    return `Build receipt directory returned ${receipts.length} typed row(s); receipt contents were not retained.`;
  }
  if (path === "/provider-adapters/state") {
    requireExactKeys(body, ["providers"], path);
    const providers = requireArray(body, "providers", path);
    const expectedProviderIds = ["antigravity-cli", "claude-code", "codex-cli"];
    const providerIds: string[] = [];
    let runnableCount = 0;
    for (const provider of providers) {
      const row = requireObject(provider, `${path}.provider`);
      if (typeof row.providerId !== "string" || !row.providerId
        || typeof row.label !== "string" || !row.label
        || !Array.isArray(row.binaryNames) || row.binaryNames.some((name) => typeof name !== "string" || !name)
        || typeof row.installed !== "boolean" || typeof row.canRun !== "boolean"
        || typeof row.streamKind !== "string" || !row.streamKind
        || !Array.isArray(row.notes) || row.notes.some((note) => typeof note !== "string")
        || (row.binary !== undefined && typeof row.binary !== "string")
        || (row.version !== undefined && typeof row.version !== "string")) {
        throw new Error("provider adapter inventory contained an invalid provider row");
      }
      if (row.canRun && !row.installed) throw new Error("provider adapter claimed runnable without an installed binary");
      providerIds.push(row.providerId);
      if (row.canRun) runnableCount += 1;
    }
    if (JSON.stringify(providerIds.sort()) !== JSON.stringify(expectedProviderIds)) {
      throw new Error("provider adapter inventory did not contain the exact supported provider set");
    }
    return `Provider adapter inventory live-probed ${providers.length} supported CLIs and found ${runnableCount} runnable; binaries, versions, notes, and run identities were not retained.`;
  }
  if (path === "/provider-sessions/state") {
    const recentRuns = requireArray(body, "recentRuns", path);
    const storedConversations = requireObject(body.storedConversations, `${path}.storedConversations`);
    if (typeof body.tabId !== "string" || !body.tabId
      || !["local", "wsl", "ssh"].includes(String(body.transport))
      || typeof body.transportKey !== "string" || !body.transportKey
      || (body.activeRun !== null && body.activeRun !== undefined && (!body.activeRun || typeof body.activeRun !== "object" || Array.isArray(body.activeRun)))) {
      throw new Error("provider session state omitted tab, transport, or active-run state");
    }
    for (const run of recentRuns) {
      const row = requireObject(run, `${path}.run`);
      if (typeof row.runId !== "string" || !row.runId || typeof row.tabId !== "string" || !row.tabId
        || typeof row.providerId !== "string" || !row.providerId || typeof row.phase !== "string" || !row.phase
        || !Number.isSafeInteger(row.stdoutLineCount) || Number(row.stdoutLineCount) < 0
        || !Number.isSafeInteger(row.stderrLineCount) || Number(row.stderrLineCount) < 0) {
        throw new Error("provider session state contained an invalid recent run");
      }
    }
    for (const value of Object.values(storedConversations)) {
      if (typeof value !== "string" || !value) throw new Error("provider session state contained an invalid stored conversation identity");
    }
    return `Provider session state returned ${recentRuns.length} bounded recent run(s) and ${Object.keys(storedConversations).length} stored conversation reference(s); run and conversation content was not retained.`;
  }
  if (path === "/state/agent_cli_setup") {
    const target = requireObject(body.target, `${path}.target`);
    const providers = requireArray(body, "providers", path);
    if (!Number.isSafeInteger(body.generatedAtMs) || Number(body.generatedAtMs) < 0
      || typeof target.label !== "string" || !target.label
      || typeof target.transport !== "string" || !target.transport
      || typeof target.commandRunsOn !== "string" || !target.commandRunsOn) {
      throw new Error("Agent CLI setup state omitted generation or target metadata");
    }
    const providerIds: string[] = [];
    let runnableCount = 0;
    for (const provider of providers) {
      const row = requireObject(provider, `${path}.provider`);
      if (typeof row.providerId !== "string" || !row.providerId
        || typeof row.displayName !== "string" || !row.displayName
        || typeof row.status !== "string" || !row.status
        || typeof row.canRun !== "boolean" || typeof row.installable !== "boolean"
        || !Array.isArray(row.installMethods)
        || typeof row.docsUrl !== "string" || !row.docsUrl
        || typeof row.officialSourceUrl !== "string" || !row.officialSourceUrl
        || typeof row.lastVerifiedAt !== "string" || !row.lastVerifiedAt
        || (row.binary !== undefined && typeof row.binary !== "string")
        || (row.version !== undefined && typeof row.version !== "string")) {
        throw new Error("Agent CLI setup state contained an invalid provider card");
      }
      providerIds.push(row.providerId);
      if (row.canRun) runnableCount += 1;
    }
    if (new Set(providerIds).size !== providers.length || !providerIds.includes("grok")
      || !providerIds.includes("codex-cli") || !providerIds.includes("claude-code")
      || !providerIds.includes("antigravity-cli")) {
      throw new Error("Agent CLI setup state omitted or duplicated a supported provider card");
    }
    return `Agent CLI setup live-probed ${providers.length} provider cards and found ${runnableCount} runnable; versions, binaries, install commands, and target details were not retained.`;
  }
  if (path === "/state/model_instruction_cards") {
    const policy = requireObject(body.policy, `${path}.policy`);
    const cards = requireArray(body, "cards", path);
    if (typeof body.version !== "string" || !body.version
      || typeof body.lastReviewed !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.lastReviewed)
      || policy.shellxMayAutoRoute !== false || policy.defaultRouteMode !== "explicitOnly"
      || typeof policy.defaultToolExposureMode !== "string" || !policy.defaultToolExposureMode
      || cards.length === 0) {
      throw new Error("model instruction cards omitted versioned explicit-only routing policy");
    }
    const cardIds = new Set<string>();
    for (const card of cards) {
      const row = requireObject(card, `${path}.card`);
      const invocation = requireObject(row.invocation, `${path}.card.invocation`);
      const toolExposure = requireObject(row.toolExposure, `${path}.card.toolExposure`);
      if (typeof row.id !== "string" || !row.id || cardIds.has(row.id)
        || typeof row.providerId !== "string" || !row.providerId
        || row.routeMode !== "explicitOnly" || row.shellxMayAutoRoute !== false
        || typeof invocation.surface !== "string" || !invocation.surface
        || typeof toolExposure.defaultMode !== "string" || !toolExposure.defaultMode) {
        throw new Error("model instruction cards contained a duplicated or non-explicit routing card");
      }
      cardIds.add(row.id);
    }
    return `Model instruction registry returned ${cards.length} unique explicit-only cards at one version; detailed recipes were not retained.`;
  }
  if (path === "/state/skills") {
    const skills = requireArray(body, "skills", path);
    for (const skill of skills) requireObject(skill, `${path}.skill`);
    return `Skill inventory returned ${skills.length} bounded command row(s); command content was not retained.`;
  }
  const arrayRoutes: Record<string, string> = {
    "/outside-connectors": "connectors",
    "/outside-connectors/capabilities": "capabilities",
    "/outside-connectors/events": "events",
    "/vault/grants": "grants",
  };
  const arrayKey = arrayRoutes[path];
  if (arrayKey) {
    const rows = requireArray(body, arrayKey, path);
    return `${path} returned ${rows.length} bounded ${arrayKey} row(s); identifiers, targets, and previews were not retained.`;
  }
  if (path === "/vault/agent-requests") {
    const requests = requireArray(body, "requests", path);
    requireArray(body, "resources", path);
    if (!Number.isSafeInteger(body.pendingCount) || Number(body.pendingCount) < 0 || Number(body.pendingCount) > requests.length) {
      throw new Error("Vault request center returned an invalid pending count");
    }
    return `Vault Request Center returned ${requests.length} request row(s) with a bounded pending count; request and resource identities were not retained.`;
  }
  if (path === "/vault/e2e/audit") {
    if (body.ok !== true || body.secretExposed !== false) {
      throw new Error("Vault E2E audit omitted its explicit no-secret contract");
    }
    const audit = requireArray(body, "audit", path);
    if (audit.length > 512) throw new Error("Vault E2E audit exceeded its bounded tail");
    for (const value of audit) {
      const row = requireObject(value, `${path}.audit.row`);
      requireExactKeys(row, [
        "action", "decision", "grantId", "reason", "receiptId", "secretExposed",
        "secretPresent", "secretRef", "t",
      ], `${path}.audit.row`);
      if (typeof row.action !== "string" || !row.action
        || typeof row.receiptId !== "string" || !row.receiptId
        || row.secretExposed !== false || !Number.isSafeInteger(row.t)
        || (row.secretRef !== null && typeof row.secretRef !== "string")
        || (row.grantId !== null && typeof row.grantId !== "string")
        || (row.decision !== null && typeof row.decision !== "string")
        || (row.secretPresent !== null && typeof row.secretPresent !== "boolean")
        || (row.reason !== null && typeof row.reason !== "string")) {
        throw new Error("Vault E2E audit returned invalid redacted receipt metadata");
      }
    }
    return `Vault isolated audit returned ${audit.length} bounded redacted receipt row(s); audit content was not retained.`;
  }
  if (path === "/vault/keys") {
    const keys = requireArray(body, "keys", path);
    const entries = requireArray(body, "entries", path);
    if (keys.length !== entries.length || keys.some((key) => typeof key !== "string" || !key)) {
      throw new Error("Vault key directory did not return matching key and metadata rows");
    }
    for (const entry of entries) {
      const row = requireObject(entry, `${path}.entry`);
      if ("value" in row || "secret" in row) throw new Error("Vault key directory exposed a secret value field");
    }
    return `Vault key directory returned ${entries.length} agent-visible metadata row(s) and no values; identifiers were not retained.`;
  }
  if (path === "/vault/resources") {
    if (body.ok !== true || body.secretExposed !== false || body.visibility !== "agentVisibleOnly") {
      throw new Error("Vault resource directory omitted its agent-visible no-secret contract");
    }
    const resources = requireArray(body, "resources", path);
    requireArray(body, "entries", path);
    for (const resource of resources) {
      const row = requireObject(resource, `${path}.resource`);
      if (row.secretExposed !== false || "value" in row || "secret" in row) {
        throw new Error("Vault resource directory exposed or failed to deny a secret value");
      }
    }
    return `Vault resource directory returned ${resources.length} agent-visible metadata row(s) with explicit no-secret proof; identifiers were not retained.`;
  }
  return null;
}

function requireExactKeys(body: Record<string, unknown>, keys: string[], path: string): void {
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${path} returned unexpected keys: ${actual.join(", ")}`);
  }
}

function requireBoundedString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\0")) {
    throw new Error(`${path} did not return a bounded string`);
  }
  return value;
}

function requirePanelSizes(value: unknown, path: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} did not return panel geometry`);
  const panels = value as Record<string, unknown>;
  const horizontal = panels.horizontal;
  const vertical = panels.vertical;
  if (!Array.isArray(horizontal) || horizontal.length !== 3 || horizontal.some((part) => typeof part !== "number" || !Number.isFinite(part) || part < 0 || part > 100)
    || !Array.isArray(vertical) || vertical.length !== 2 || vertical.some((part) => typeof part !== "number" || !Number.isFinite(part) || part < 0 || part > 100)) {
    throw new Error(`${path} returned invalid horizontal or vertical panel geometry`);
  }
}

function requireArray(body: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new Error(`${path} did not return a ${key} array`);
  return value;
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} did not return an object`);
  return value as Record<string, unknown>;
}

function requireCountedArray(body: Record<string, unknown>, key: string, countKey: string, path: string): unknown[] {
  const rows = requireArray(body, key, path);
  if (!Number.isSafeInteger(body[countKey]) || Number(body[countKey]) !== rows.length) {
    throw new Error(`${path} ${countKey} does not match its ${key} array`);
  }
  return rows;
}

function requireNonNegativeIntegers(body: Record<string, unknown>, keys: string[], path: string): void {
  for (const key of keys) {
    if (!Number.isSafeInteger(body[key]) || Number(body[key]) < 0) throw new Error(`${path} returned an invalid ${key}`);
  }
}

function requireMarketplaceHealthEntry(value: unknown, path: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} contained a non-object health entry`);
  const entry = value as Record<string, unknown>;
  if (typeof entry.entryId !== "string" || !entry.entryId || typeof entry.tabId !== "string" || !entry.tabId
    || typeof entry.transportKey !== "string" || typeof entry.status !== "string" || !entry.status
    || typeof entry.launcher !== "string" || !Number.isSafeInteger(entry.lastCheckMs)) {
    throw new Error(`${path} contained an invalid launcher-health entry`);
  }
}

function verifySkillBody(body: string): string {
  if (body.length < 500 || !body.includes("name: shellx-host") || !body.includes("ShellX")) {
    throw new Error("installed ShellX host skill body is missing or incomplete");
  }
  return `Installed ShellX host skill returned ${Buffer.byteLength(body, "utf8")} bytes.`;
}

async function verifyScreenshotBody(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "image/png") throw new Error(`screenshot returned ${contentType ?? "no content type"} instead of image/png`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 33) throw new Error("screenshot PNG was too small to contain an IHDR chunk");
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((value, index) => bytes[index] !== value)
    || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") {
    throw new Error("screenshot did not return a valid PNG signature and IHDR chunk");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(16) === 0 || view.getUint32(20) === 0) {
    throw new Error("screenshot PNG had zero width or height");
  }
  return "Installed native window returned a non-empty PNG capture with valid dimensions; image bytes were not retained.";
}

async function fetchRoute(connection: { base: string; token: string }, path: string): Promise<Response> {
  const response = await fetch(`${connection.base}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(path === "/browser/evidence"
        ? { "x-shellx-mcp-caller-id": "release-surface-browser-evidence-read" }
        : {}),
    },
  });
  if (!response.ok) throw new Error(`GET ${path} failed ${response.status}: ${await response.text()}`);
  return response;
}

async function fetchRouteAllowingAbsentBuild(
  connection: { base: string; token: string },
  path: string,
): Promise<Response> {
  const response = await fetch(`${connection.base}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${connection.token}` },
  });
  if (response.status !== 200 && response.status !== 404) {
    throw new Error(`GET ${path} failed ${response.status}: ${await response.text()}`);
  }
  return response;
}

runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
