import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA,
  validateReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "./lib/release-surface-driver-protocol";
import {
  RELEASE_UI_DEBUG_BROWSER_CLEANUP_ID,
  RELEASE_UI_DEBUG_ORACLE_ID,
  RELEASE_UI_DEBUG_VAULT_LIFECYCLE_CLEANUP_ID,
  releaseUiDebugCleanupIdForFixture,
} from "./lib/release-ui-debug-surface-cohorts";
import type { ReleaseSurfaceItem } from "./lib/release-surface-inventory";
import { releaseSurfaceControllerBindingFixture, releaseSurfaceFixtureSourceCommit } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-debug-driver-"));
const tokenPath = join(temp, ".shellx", "shellxagent.token");
const mcpTokenPath = join(temp, "mcp.token");
const statePath = join(temp, "server.json");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "owned-ui-debug-driver-token-value";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
let server: ChildProcess | null = null;

try {
  mkdirSync(join(temp, ".shellx"), { mode: 0o700 });
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  writeFileSync(mcpTokenPath, "owned-ui-debug-mcp-token-value", { encoding: "utf8", mode: 0o600 });
  server = spawn(process.execPath, [
    "--import", "tsx",
    resolve(root, "scripts/fixtures/release-surface-ui-debug-driver-server-fixture.ts"),
    "--token-file", tokenPath,
    "--state-out", statePath,
    "--instance-id", "owned-ui-debug-instance-0001",
    "--process-id", "4321",
    "--version", "0.3.5",
    "--source-commit", sourceCommit,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const port = await waitForPort(statePath, server);
  const request = driverRequest(port);
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");

  const run = spawnSync(process.execPath, [
    "--import", "tsx",
    resolve(root, "scripts/release-drivers/ui-debug-surface-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.equal(report.schema, RELEASE_SURFACE_DRIVER_REPORT_SCHEMA);
  assert.deepEqual(validateReleaseSurfaceDriverReport(request, report), []);
  assert.equal(report.outcomes.length, 150);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && (outcome.cleanup === "pass" || outcome.cleanup === "deferred-candidate-teardown")
    && outcome.observedEffect.includes("no control activation was invoked or claimed")
  )));
  const expectedDeferred = request.assignments.filter((assignment) => (
    assignment.cleanupId === RELEASE_UI_DEBUG_BROWSER_CLEANUP_ID
    || assignment.cleanupId === RELEASE_UI_DEBUG_VAULT_LIFECYCLE_CLEANUP_ID
  ));
  assert.equal(
    report.outcomes.filter((outcome) => outcome.cleanup === "deferred-candidate-teardown").length,
    expectedDeferred.length,
  );
  assert(report.outcomes.filter((outcome) => outcome.cleanup === "deferred-candidate-teardown")
    .every((outcome) => (
      outcome.cleanupEvidence?.cleanupId === RELEASE_UI_DEBUG_BROWSER_CLEANUP_ID
      || outcome.cleanupEvidence?.cleanupId === RELEASE_UI_DEBUG_VAULT_LIFECYCLE_CLEANUP_ID
    )));

  const fixtureState = await getJson<Record<string, unknown>>(
    `http://127.0.0.1:${port}/fixture-state`,
    token,
  );
  assert.equal(fixtureState.browserTaskActive, false, "every owned Browser fixture task must be aborted");
  assert.equal(fixtureState.taskStartCount, 12);
  assert.equal(fixtureState.taskAbortCount, 12);
  assert.equal(fixtureState.browserHistoryEntryCount, 12, "owned Browser tasks leave only candidate-scoped monotonic history");
  assert.equal(fixtureState.openModal, "close");
  assert.equal(fixtureState.buildPlanFixtureActive, false, "the inert Build plan fixture must be exactly cleared");
  assert.equal(fixtureState.shellxagentFixtureActive, false, "the inert ShellX Agent fixture must be exactly cleared");
  assert.equal(fixtureState.appBottomTab, "Chat", "the app bottom-tab state must be restored");
  assert.equal(fixtureState.agentCliSetupFixture, "closed", "the synthetic Agent CLI setup dialog must be exactly unmounted");
  assert.equal(fixtureState.goalPlanReviewFixture, "closed", "the synthetic Goal Plan Review dialog must be exactly unmounted");
  assert.equal(fixtureState.setupGuideDismissed, true, "persistent setup-guide state must be restored");
  assert.equal(fixtureState.appRightTab, "Tasks", "the app right-tab state must be restored");
  assert.equal(fixtureState.tasksPanelOwnedRowActive, false, "the owned TasksPanel row must unmount during cleanup");
  assert.equal(fixtureState.vaultClipboardFixtureActive, false, "the fixed Vault clipboard fixture must unmount during cleanup");
  assert.equal(fixtureState.settingsTab, "data", "the previously selected Settings tab must be restored");
  assert.equal(fixtureState.browserRightTab, "chat");
  assert.equal(fixtureState.browserOverlay, "none", "every opened Browser sidecar must be closed");
  assert.equal(fixtureState.browserWorkflowPreviewVisible, false, "the owned missing-workflow preview must not survive cleanup");
  assert.equal(fixtureState.browserErrorVisible, false, "the owned missing-workflow error must not survive cleanup");
  assert.equal(fixtureState.builtinDocOpen, false, "the opened Builtin Doc modal must be closed");
  assert.equal(fixtureState.activityEvidenceVisible, false, "the Activity Evidence fixture must unmount during cleanup");
  assert.equal(fixtureState.activitySearchValue, "", "the Activity search fixture must unmount and clear its query during cleanup");
  assert.equal(fixtureState.findPopoverOpen, false, "the Find fixture must blur and close its popover");
  assert.equal(fixtureState.findSearchValue, "", "the Find fixture must clear its query during cleanup");
  assert.equal(fixtureState.pastChatVisible, false, "the owned Past chats fixture must delete its exact session row");
  assert.equal(fixtureState.pastChatRenaming, false, "owned Past chat rename state must not survive cleanup");
  assert.equal(fixtureState.cwdPickerMode, "closed", "owned cwd picker state must not survive cleanup");
  assert.equal(fixtureState.ownedGitRepoActive, false, "owned Git cwd must be restored during cleanup");
  assert.equal(fixtureState.ownedFilesPaneActive, false, "owned Files cwd must be restored during cleanup");
  assert.equal(fixtureState.ownedWorkPreviewIssueMounted, false, "owned Work Preview cwd must be restored during cleanup");
  assert.equal(fixtureState.workPreviewIssueStatus, "stopped", "owned Work Preview must be stopped during cleanup");
  assert.equal(fixtureState.workPreviewIssueUrl, null, "owned Work Preview endpoint identity must be cleared");
  assert.equal(fixtureState.branchPickerOpen, false, "owned Branch picker must not survive cleanup");
  assert.equal(fixtureState.connectionPickerOpen, false, "owned Connection picker must not survive cleanup");
  assert.equal(fixtureState.connectionPresetCount, 0, "owned connection preset must be deleted during cleanup");
  assert.equal(fixtureState.ownedConnectionSelected, false, "owned connection selection must be restored during cleanup");
  assert.equal(fixtureState.ownedConnectionEditorOpen, false, "owned Connection editor must not survive cleanup");
  assert.equal(fixtureState.agentPickerOpen, false, "owned Agent picker must not survive cleanup");
  assert.equal(fixtureState.slashPickerOpen, false, "owned slash-command picker must not survive cleanup");
  assert.equal(fixtureState.passwordGeneratorOpen, false, "the local password generator fixture must unmount during cleanup");
  assert.equal(fixtureState.vaultSetupVisible, false, "the unconfigured Vault setup fixture must unmount during cleanup");
  assert.equal(fixtureState.vaultRecoveryKitVisible, false, "the disposable Vault recovery kit must be reset during cleanup");
  assert.equal(fixtureState.vaultRowMode, "none", "the owned Vault row editor must unmount during cleanup");
  assert.equal(fixtureState.vaultRequestCenterOpen, false, "the owned Vault request center must close during cleanup");
  assert.equal(fixtureState.vaultAgentRequestActive, false, "the owned Vault agent request must be cancelled and reset");
  assert.equal(fixtureState.vaultGrantActive, false, "the owned Vault grant must be reset after rendering");
  assert.deepEqual(fixtureState.vaultKeys, [], "the exact owned Vault UI secret must be deleted");
  assert.deepEqual(fixtureState.vaultStatus, {
    mode: "unconfigured",
    unlocked: false,
    recoveryConfirmed: false,
    rememberedDeviceEnabled: true,
  }, "the disposable Vault lifecycle must return to its logical baseline");
  assert.equal(fixtureState.browserSidebarVisible, true, "the Browser right sidebar must be restored after hidden-state proof");
  assert.equal(fixtureState.ownedProjectDraft, false, "every owned project marker must be deleted during cleanup");
  assert.equal(fixtureState.ownedProjectRenaming, false, "owned project rename state must not survive cleanup");
  assert.equal(fixtureState.ownedProjectDeleteDialog, false, "owned project delete state must not survive cleanup");
  assert.equal(fixtureState.openChatContextMenu, false, "owned Open chat context menu must not survive cleanup");
  assert.equal(fixtureState.pastChatContextMenu, false, "owned Past chat context menu must not survive cleanup");
  assert.equal(fixtureState.sessionRenaming, false, "owned session rename state must not survive cleanup");
  assert.equal(fixtureState.sessionPreviewVisible, false, "owned session preview state must not survive cleanup");
  assert.equal(fixtureState.ownedVideoPreviewActive, false, "owned video preview state must not survive cleanup");
  assert.equal(fixtureState.ownedMarkdownPreviewActive, false, "owned Markdown preview state must not survive cleanup");
  assert.equal(fixtureState.ownedPendingAttachmentActive, false, "owned pending attachment state must not survive cleanup");
  assert.equal(fixtureState.ownedRendererEventProjectionActive, false, "owned renderer event projections must not survive cleanup");
  assert.equal(fixtureState.providerActionFixture, "none", "the owned connector action fixture must not survive cleanup");
  assert.equal(fixtureState.debugUiConnectionFixture, "clear", "the disconnected-banner fixture must not survive cleanup");
  assert.equal(fixtureState.hashItemsFixtureActive, false, "owned hash items must not survive cleanup");
  assert.equal(fixtureState.composerPromptValue, "", "the owned hash query must be cleared");
  assert.equal(fixtureState.pluginsFixtureActive, false, "owned Plugins marketplace rows must unmount during cleanup");
  assert.equal(fixtureState.pluginsKeyFormEntryId, null, "owned Plugins key-form state must not survive cleanup");
  assert.equal(fixtureState.sessionDropdownOpen, false, "owned session dropdown state must not survive cleanup");
  assert.equal(fixtureState.sessionDeleteDialogOpen, false, "owned session delete dialog must not survive cleanup");
  assert.deepEqual(fixtureState.bookmarkIds, [], "every exact owned bookmark must be deleted");
  assert.deepEqual(fixtureState.debugHighlightResultsBySurface, { app: [], browser: [] });
  const plan = JSON.parse(readFileSync(resolve(root, "release/surface-driver-plan.json"), "utf8")) as {
    assignments: Array<{
      surfaceId: string;
      driverId: string;
      fixtureId: string;
      expectedEffect: string;
      oracleId: string;
      cleanupId: string;
    }>;
  };
  const workPreviewAssignments = plan.assignments.filter((entry) => (
    entry.surfaceId.includes("WorkPreviewPanel.tsx")
  ));
  assert.equal(workPreviewAssignments.length, 25, "every Work Preview inventory surface must stay classified");
  const workPreviewBlockers = workPreviewAssignments.filter((entry) => (
    entry.driverId === "ui-control-backlog-installed"
  ));
  assert.equal(workPreviewBlockers.length, 0, "every Work Preview surface must now have an exact installed lifecycle or inert owned marker lane");
  assert.equal(
    workPreviewAssignments.filter((entry) => (
      entry.fixtureId === "ui:work-preview-owned-running-project"
      && entry.oracleId === "ui:activation:work-preview-external-handoff"
    )).length,
    2,
    "both Work Preview external actions must use the isolated owned-loopback handoff lifecycle",
  );
  assert.deepEqual(
    workPreviewAssignments.find((entry) => (
      entry.surfaceId === "ui-debug-surface:surface-components-workpreviewpanel-16@src/components/WorkPreviewPanel.tsx#2"
    )),
    {
      surfaceId: "ui-debug-surface:surface-components-workpreviewpanel-16@src/components/WorkPreviewPanel.tsx#2",
      driverId: "ui-debug-surface-installed",
      fixtureId: "ui:owned-work-preview-browser-issue-visible",
      expectedEffect: "surface-components-workpreviewpanel-16 resolves on the attested app renderer after its exact owned fixture state is established; no control activation is claimed.",
      oracleId: "ui:visible-nonempty-rectangle",
      cleanupId: "ui:clear-debug-highlight-and-restore-owned-state",
    },
  );
  console.log("Release UI debug driver fixture tests passed");
} finally {
  server?.kill("SIGTERM");
  rmSync(temp, { recursive: true, force: true });
}

function driverRequest(port: number): ReleaseSurfaceDriverRequest {
  const common: Pick<
    ReleaseSurfaceItem,
    "kind" | "platforms" | "delivery" | "stableSelector" | "selectorStability" | "eventTrust"
  > = {
    kind: "ui-debug-surface" as const,
    platforms: ["windows-installed", "macos-installed", "linux-installed"],
    delivery: "installed-app" as const,
    stableSelector: true,
    selectorStability: "durable" as const,
    eventTrust: "not-applicable" as const,
  };
  return {
    schema: RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA,
    mode: "final-frozen-candidate",
    driverId: "ui-debug-surface-installed",
    driverKind: "ui-debug-surface",
    platform: "linux-installed",
    sourceCommit,
    version: "0.3.5",
    inventoryDigest: "a".repeat(64),
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture("scripts/release-drivers/ui-debug-surface-installed.ts"),
    runtime: {
      processId: 4321,
      instanceId: "owned-ui-debug-instance-0001",
      debugBase: `http://127.0.0.1:${port}`,
      debugTokenPath: tokenPath,
      mcpBase: `http://127.0.0.1:${port + 1}`,
      mcpTokenPath,
      executableSha256: "c".repeat(64),
      installedPayloadPath: "/tmp/shellx-ui-debug-fixture/shellx",
      installedManifestSha256: "d".repeat(64),
      posixNative: releaseSurfacePosixNativeBindingFixture({
        processId: 4321,
        port,
        imagePath: "/tmp/shellx-ui-debug-fixture/shellx",
        imageSha256: "c".repeat(64),
      }),
    },
    assignments: [
      assignment({
        ...common,
        id: "ui-debug-surface:header-theme-toggle@src/components/Header.tsx#3",
        name: "header-theme-toggle",
        source: "src/components/Header.tsx",
        selector: "[data-debug-id=\"header-theme-toggle\"]",
        line: 276,
        occurrence: 3,
        driverFamily: "static-marker",
        dynamicSelector: false,
      }, "ui:app-shell-visible"),
      assignment({
        ...common,
        id: "ui-debug-surface:settings-tab-general@src/components/Settings.tsx#2",
        name: "settings-tab-general",
        source: "src/components/Settings.tsx",
        selector: "[data-debug-id=\"settings-tab-general\"]",
        line: 149,
        occurrence: 2,
        driverFamily: "static-marker",
        dynamicSelector: false,
      }, "ui:settings-tab-strip-visible"),
      assignment({
        ...common,
        id: "ui-debug-surface:shellx-setup-guide@src/components/ShellxSetupGuide.tsx#1",
        name: "shellx-setup-guide",
        source: "src/components/ShellxSetupGuide.tsx",
        selector: "[data-debug-id=\"shellx-setup-guide\"]",
        line: 41,
        occurrence: 1,
        driverFamily: "static-marker",
        dynamicSelector: false,
      }, "ui:setup-guide-visible"),
      assignment({
        ...common,
        id: "ui-debug-surface:about-full-manual-link@src/components/settings/AboutTab.tsx#5",
        name: "about-full-manual-link",
        source: "src/components/settings/AboutTab.tsx",
        selector: "[data-debug-id=\"about-full-manual-link\"]",
        line: 324,
        occurrence: 5,
        driverFamily: "static-marker",
        dynamicSelector: false,
      }, "ui:settings-about-visible"),
      assignment({
        ...common,
        id: "ui-debug-surface:surface-components-builtindocmodal-4@src/components/BuiltinDocModal.tsx#1",
        name: "surface-components-builtindocmodal-4",
        source: "src/components/BuiltinDocModal.tsx",
        selector: "[data-debug-id=\"surface-components-builtindocmodal-4\"]",
        line: 48,
        occurrence: 1,
        driverFamily: "static-marker",
        dynamicSelector: false,
      }, "ui:builtin-doc-visible"),
      assignment({
        ...common,
        id: "ui-debug-surface:shellx-browser-tab-*@src/browser/components/BrowserChrome.tsx#2",
        name: "shellx-browser-tab-*",
        source: "src/browser/components/BrowserChrome.tsx",
        selector: "[data-debug-id^=\"shellx-browser-tab-\"]",
        line: 213,
        occurrence: 2,
        driverFamily: "dynamic-marker",
        dynamicSelector: true,
      }, "ui:browser-chrome-owned-task"),
      assignment({
        ...common,
        id: "ui-debug-surface:shellx-browser-task-*@src/browser/components/AgentSidebar.tsx#26",
        name: "shellx-browser-task-*",
        source: "src/browser/components/AgentSidebar.tsx",
        selector: "[data-debug-id^=\"shellx-browser-task-\"]",
        line: 416,
        occurrence: 26,
        driverFamily: "dynamic-marker",
        dynamicSelector: true,
      }, "ui:browser-actions-owned-task"),
      assignment({
        ...common,
        id: "ui-debug-surface:shellx-browser-options-sidecar@src/browser/components/BrowserMenus.tsx#1",
        name: "shellx-browser-options-sidecar",
        source: "src/browser/components/BrowserMenus.tsx",
        selector: "[data-debug-id=\"shellx-browser-options-sidecar\"]",
        line: 75,
        occurrence: 1,
        driverFamily: "static-marker",
        dynamicSelector: false,
      }, "ui:browser-options-owned-task"),
      assignment({
        ...common,
        id: "ui-debug-surface:shellx-browser-chrome-menu-dock@src/browser/components/BrowserChrome.tsx#30",
        name: "shellx-browser-chrome-menu-dock",
        source: "src/browser/components/BrowserChrome.tsx",
        selector: "[data-debug-id=\"shellx-browser-chrome-menu-dock\"]",
        line: 547,
        occurrence: 30,
        driverFamily: "static-marker",
        dynamicSelector: false,
      }, "ui:browser-options-owned-task"),
      assignment({
        ...common,
        id: "ui-debug-surface:shellx-browser-bookmark-*@src/browser/components/BookmarkSidecar.tsx#1",
        name: "shellx-browser-bookmark-*",
        source: "src/browser/components/BookmarkSidecar.tsx",
        selector: "[data-debug-id^=\"shellx-browser-bookmark-\"]",
        line: 136,
        occurrence: 1,
        driverFamily: "dynamic-marker",
        dynamicSelector: true,
      }, "ui:browser-bookmark-list-link-owned"),
      assignment({
        ...common,
        id: "ui-debug-surface:shellx-browser-bookmark-*@src/browser/components/BookmarkSidecar.tsx#2",
        name: "shellx-browser-bookmark-*",
        source: "src/browser/components/BookmarkSidecar.tsx",
        selector: "[data-debug-id^=\"shellx-browser-bookmark-\"]",
        line: 143,
        occurrence: 2,
        driverFamily: "dynamic-marker",
        dynamicSelector: true,
      }, "ui:browser-bookmark-list-folder-owned"),
      ...newUiDebugCohortAssignments(common),
    ],
  };
}

function newUiDebugCohortAssignments(
  common: Pick<
    ReleaseSurfaceItem,
    "kind" | "platforms" | "delivery" | "stableSelector" | "selectorStability" | "eventTrust"
  >,
): ReleaseSurfaceDriverRequest["assignments"] {
  const rows = [
    ["agent-cli-setup-assistant", "src/components/AgentCliSetupAssistant.tsx", 1, 187, "[data-debug-id=\"agent-cli-setup-assistant\"]", false, "ui:agent-cli-setup-owned-cards-visible"],
    ["surface-components-agentclisetupassistant-5", "src/components/AgentCliSetupAssistant.tsx", 2, 253, "[data-debug-id=\"surface-components-agentclisetupassistant-5\"]", false, "ui:agent-cli-setup-owned-cards-visible"],
    ["agent-cli-setup-confirm", "src/components/AgentCliSetupAssistant.tsx", 3, 272, "[data-debug-id=\"agent-cli-setup-confirm\"]", false, "ui:agent-cli-setup-owned-confirmation-visible"],
    ["surface-components-agentclisetupassistant-9", "src/components/AgentCliSetupAssistant.tsx", 4, 301, "[data-debug-id=\"surface-components-agentclisetupassistant-9\"]", false, "ui:agent-cli-setup-owned-confirmation-visible"],
    ["agent-cli-setup-dialog", "src/components/AgentCliSetupAssistant.tsx", 5, 331, "[data-debug-id=\"agent-cli-setup-dialog\"]", false, "ui:agent-cli-setup-owned-cards-visible"],
    ["surface-components-agentclisetupassistant-11", "src/components/AgentCliSetupAssistant.tsx", 6, 337, "[data-debug-id=\"surface-components-agentclisetupassistant-11\"]", false, "ui:agent-cli-setup-owned-cards-visible"],
    ["agent-cli-setup-open-antigravity-cli", "src/components/AgentCliStatusCard.tsx", 1, 230, "[data-debug-id=\"agent-cli-setup-open-antigravity-cli\"]", false, "ui:agent-cli-status-owned-setup-controls-visible"],
    ["agent-cli-setup-open-claude-code", "src/components/AgentCliStatusCard.tsx", 1, 230, "[data-debug-id=\"agent-cli-setup-open-claude-code\"]", false, "ui:agent-cli-status-owned-setup-controls-visible"],
    ["agent-cli-setup-open-codex-cli", "src/components/AgentCliStatusCard.tsx", 1, 230, "[data-debug-id=\"agent-cli-setup-open-codex-cli\"]", false, "ui:agent-cli-status-owned-setup-controls-visible"],
    ["agent-cli-setup-open-grok", "src/components/AgentCliStatusCard.tsx", 1, 230, "[data-debug-id=\"agent-cli-setup-open-grok\"]", false, "ui:agent-cli-status-owned-setup-controls-visible"],
    ["agent-cli-setup-open-missing", "src/components/AgentCliStatusCard.tsx", 2, 274, "[data-debug-id=\"agent-cli-setup-open-missing\"]", false, "ui:agent-cli-status-owned-setup-controls-visible"],
    ["surface-components-goalplanreviewmodal-1", "src/components/GoalPlanReviewModal.tsx", 1, 286, "[data-debug-id=\"surface-components-goalplanreviewmodal-1\"]", false, "ui:goal-plan-review-owned-visible"],
    ["surface-components-goalplanreviewmodal-4", "src/components/GoalPlanReviewModal.tsx", 2, 368, "[data-debug-id=\"surface-components-goalplanreviewmodal-4\"]", false, "ui:goal-plan-review-owned-editing-visible"],
    ["surface-components-goalplanreviewmodal-7", "src/components/GoalPlanReviewModal.tsx", 3, 397, "[data-debug-id=\"surface-components-goalplanreviewmodal-7\"]", false, "ui:goal-plan-review-owned-visible"],
    ["surface-components-goalplanreviewmodal-9", "src/components/GoalPlanReviewModal.tsx", 4, 413, "[data-debug-id=\"surface-components-goalplanreviewmodal-9\"]", false, "ui:goal-plan-review-owned-visible"],
    ["session-rename-input", "src/components/SessionTabs.tsx", 2, 218, "[data-debug-id=\"session-rename-input\"]", false, "ui:session-rename-visible"],
    ["surface-components-sessiontabs-4", "src/components/SessionTabs.tsx", 3, 239, "[data-debug-id=\"surface-components-sessiontabs-4\"]", false, "ui:session-preview-visible"],
    ["surface-components-sessiontabs-11", "src/components/SessionTabs.tsx", 4, 337, "[data-debug-id=\"surface-components-sessiontabs-11\"]", false, "ui:session-preview-dropdown-visible"],
    ["surface-components-leftrail-24", "src/components/LeftRail.tsx", 13, 1059, "[data-debug-id=\"surface-components-leftrail-24\"]", false, "ui:session-delete-dialog-visible"],
    ["surface-components-leftrail-25", "src/components/LeftRail.tsx", 14, 1063, "[data-debug-id=\"surface-components-leftrail-25\"]", false, "ui:session-delete-dialog-visible"],
    ["surface-components-rowactions-1", "src/components/RowActions.tsx", 1, 52, "[data-debug-id=\"surface-components-rowactions-1\"]", false, "ui:app-shell-visible"],
    ["surface-components-rowactions-2", "src/components/RowActions.tsx", 2, 66, "[data-debug-id=\"surface-components-rowactions-2\"]", false, "ui:app-shell-visible"],
    ["activity-search-clear", "src/components/ActivityBrowserModal.tsx", 8, 457, "[data-debug-id=\"activity-search-clear\"]", false, "ui:activity-search-active-visible"],
    ["activity-evidence-column-resizer", "src/components/ActivityBrowserModal.tsx", 14, 1242, "[data-debug-id=\"activity-evidence-column-resizer\"]", false, "ui:activity-evidence-visible"],
    ["activity-evidence-row-resizer", "src/components/ActivityBrowserModal.tsx", 15, 1264, "[data-debug-id=\"activity-evidence-row-resizer\"]", false, "ui:activity-evidence-visible"],
    ["activity-evidence-section-*-expand", "src/components/ActivityBrowserModal.tsx", 16, 1351, "[data-debug-id^=\"activity-evidence-section-\"][data-debug-id$=\"-expand\"]", true, "ui:activity-evidence-visible"],
    ["surface-components-activitybrowsermodal-14", "src/components/ActivityBrowserModal.tsx", 9, 759, "[data-debug-id=\"surface-components-activitybrowsermodal-14\"]", false, "ui:owned-activity-graph-visible"],
    ["surface-components-activitybrowsermodal-16", "src/components/ActivityBrowserModal.tsx", 10, 826, "[data-debug-id=\"surface-components-activitybrowsermodal-16\"]", false, "ui:owned-activity-graph-selected-visible"],
    ["surface-components-activitybrowsermodal-17", "src/components/ActivityBrowserModal.tsx", 11, 1079, "[data-debug-id=\"surface-components-activitybrowsermodal-17\"]", false, "ui:owned-activity-files-visible"],
    ["surface-components-activitybrowsermodal-18", "src/components/ActivityBrowserModal.tsx", 12, 1091, "[data-debug-id=\"surface-components-activitybrowsermodal-18\"]", false, "ui:owned-activity-files-visible"],
    ["surface-components-activitybrowsermodal-19", "src/components/ActivityBrowserModal.tsx", 13, 1130, "[data-debug-id=\"surface-components-activitybrowsermodal-19\"]", false, "ui:owned-activity-timeline-visible"],
    ["surface-components-activitybrowsermodal-21", "src/components/ActivityBrowserModal.tsx", 17, 1405, "[data-debug-id=\"surface-components-activitybrowsermodal-21\"]", false, "ui:owned-activity-evidence-rows-visible"],
    ["shellx-browser-evidence-empty", "src/browser/components/BrowserEvidencePanel.tsx", 4, 132, "[data-debug-id=\"shellx-browser-evidence-empty\"]", false, "ui:browser-evidence-owned-task"],
    ["shellx-browser-show-right-sidebar-button", "src/browser/components/BrowserChrome.tsx", 10, 316, "[data-debug-id=\"shellx-browser-show-right-sidebar-button\"]", false, "ui:browser-right-sidebar-hidden-owned-task"],
    ["surface-components-rightrail-2", "src/components/RightRail.tsx", 2, 745, "[data-debug-id=\"surface-components-rightrail-2\"]", false, "ui:right-rail-tooling-visible"],
    ["surface-components-rightrail-9", "src/components/RightRail.tsx", 3, 1091, "[data-debug-id=\"surface-components-rightrail-9\"]", false, "ui:right-rail-tooling-visible"],
    ["surface-components-rightrail-11", "src/components/RightRail.tsx", 4, 1767, "[data-debug-id=\"surface-components-rightrail-11\"]", false, "ui:right-rail-owned-connector-action-visible"],
    ["surface-components-taskspanel-8", "src/components/TasksPanel.tsx", 5, 714, "[data-debug-id=\"surface-components-taskspanel-8\"]", false, "ui:owned-tasks-panel-row-visible"],
    ["surface-components-workpreviewpanel-16", "src/components/WorkPreviewPanel.tsx", 2, 627, "[data-debug-id=\"surface-components-workpreviewpanel-16\"]", false, "ui:owned-work-preview-browser-issue-visible"],
    ["surface-components-vaultpasswordgenerator-11", "src/components/VaultPasswordGenerator.tsx", 10, 233, "[data-debug-id=\"surface-components-vaultpasswordgenerator-11\"]", false, "ui:vault-password-generator-visible"],
    ["surface-components-vaultpasswordgenerator-5", "src/components/VaultPasswordGenerator.tsx", 5, 155, "[data-debug-id=\"surface-components-vaultpasswordgenerator-5\"]", false, "ui:vault-password-generator-visible"],
    ["vault-password-generator-close", "src/components/VaultPasswordGenerator.tsx", 2, 117, "[data-debug-id=\"vault-password-generator-close\"]", false, "ui:vault-password-generator-visible"],
    ["vault-password-generator-copy", "src/components/VaultPasswordGenerator.tsx", 4, 147, "[data-debug-id=\"vault-password-generator-copy\"]", false, "ui:vault-password-generator-visible"],
    ["vault-password-generator-length", "src/components/VaultPasswordGenerator.tsx", 6, 170, "[data-debug-id=\"vault-password-generator-length\"]", false, "ui:vault-password-generator-visible"],
    ["vault-password-generator-output", "src/components/VaultPasswordGenerator.tsx", 3, 130, "[data-debug-id=\"vault-password-generator-output\"]", false, "ui:vault-password-generator-visible"],
    ["vault-password-generator-regenerate", "src/components/VaultPasswordGenerator.tsx", 7, 185, "[data-debug-id=\"vault-password-generator-regenerate\"]", false, "ui:vault-password-generator-visible"],
    ["vault-password-generator-save", "src/components/VaultPasswordGenerator.tsx", 9, 206, "[data-debug-id=\"vault-password-generator-save\"]", false, "ui:vault-password-generator-visible"],
    ["vault-password-generator-use", "src/components/VaultPasswordGenerator.tsx", 8, 195, "[data-debug-id=\"vault-password-generator-use\"]", false, "ui:vault-password-generator-visible"],
    ["vault-password-generator", "src/components/VaultPasswordGenerator.tsx", 1, 104, "[data-debug-id=\"vault-password-generator\"]", false, "ui:vault-password-generator-visible"],
    ["shellx-vault-setup", "src/components/settings/VaultSetupPanel.tsx", 1, 184, "[data-debug-id=\"shellx-vault-setup\"]", false, "ui:vault-setup-unconfigured-visible"],
    ["vault-profile-collision", "src/components/settings/VaultSetupPanel.tsx", 2, 249, "[data-debug-id=\"vault-profile-collision\"]", false, "ui:vault-profile-collision-owned"],
    ["shellx-vault-setup-mode", "src/components/settings/VaultSetupPanel.tsx", 6, 285, "[data-debug-id=\"shellx-vault-setup-mode\"]", false, "ui:vault-setup-unconfigured-visible"],
    ["shellx-vault-master-passphrase", "src/components/settings/VaultSetupPanel.tsx", 7, 329, "[data-debug-id=\"shellx-vault-master-passphrase\"]", false, "ui:vault-setup-unconfigured-visible"],
    ["shellx-vault-confirm-passphrase", "src/components/settings/VaultSetupPanel.tsx", 8, 341, "[data-debug-id=\"shellx-vault-confirm-passphrase\"]", false, "ui:vault-setup-unconfigured-visible"],
    ["surface-components-settings-vaultsetuppanel-17", "src/components/settings/VaultSetupPanel.tsx", 10, 360, "[data-debug-id=\"surface-components-settings-vaultsetuppanel-17\"]", false, "ui:vault-setup-unconfigured-visible"],
    ["shellx-vault-recovery-confirm", "src/components/settings/VaultSetupPanel.tsx", 12, 389, "[data-debug-id=\"shellx-vault-recovery-confirm\"]", false, "ui:vault-setup-unconfigured-visible"],
    ["shellx-vault-remember-device-setup", "src/components/settings/VaultSetupPanel.tsx", 13, 400, "[data-debug-id=\"shellx-vault-remember-device-setup\"]", false, "ui:vault-setup-unconfigured-visible"],
    ["shellx-vault-recovery-copy", "src/components/settings/VaultSetupPanel.tsx", 18, 469, "[data-debug-id=\"shellx-vault-recovery-copy\"]", false, "ui:vault-setup-recovery-kit-visible"],
    ["vault-description-inline", "src/components/settings/VaultTab.tsx", 10, 1069, "[data-debug-id=\"vault-description-inline\"]", false, "ui:vault-owned-secret-visible"],
    ["vault-permission-bar", "src/components/settings/VaultTab.tsx", 29, 1679, "[data-debug-id=\"vault-permission-bar\"]", false, "ui:vault-owned-secret-visible"],
    ["vault-permission-visible", "src/components/settings/VaultTab.tsx", 30, 1687, "[data-debug-id=\"vault-permission-visible\"]", false, "ui:vault-owned-secret-visible"],
    ["vault-permission-userOnly", "src/components/settings/VaultTab.tsx", 30, 1687, "[data-debug-id=\"vault-permission-userOnly\"]", false, "ui:vault-owned-secret-visible"],
    ["vault-permission-browserFillAlways", "src/components/settings/VaultTab.tsx", 30, 1687, "[data-debug-id=\"vault-permission-browserFillAlways\"]", false, "ui:vault-owned-secret-visible"],
    ["vault-permission-toolUseAlways", "src/components/settings/VaultTab.tsx", 30, 1687, "[data-debug-id=\"vault-permission-toolUseAlways\"]", false, "ui:vault-owned-secret-visible"],
    ["vault-resource-section-secrets", "src/components/settings/VaultTab.tsx", 7, 879, "[data-debug-id=\"vault-resource-section-secrets\"]", false, "ui:vault-owned-secret-visible"],
    ["vault-resource-section-profile-cards", "src/components/settings/VaultTab.tsx", 8, 886, "[data-debug-id=\"vault-resource-section-profile-cards\"]", false, "ui:vault-owned-secret-visible"],
    ["vault-resource-section-agent-wallets", "src/components/settings/VaultTab.tsx", 9, 893, "[data-debug-id=\"vault-resource-section-agent-wallets\"]", false, "ui:vault-owned-secret-visible"],
    ["vault-description-input", "src/components/settings/VaultTab.tsx", 12, 1216, "[data-debug-id=\"vault-description-input\"]", false, "ui:vault-owned-secret-metadata-visible"],
    ["vault-user-only-toggle", "src/components/settings/VaultTab.tsx", 13, 1229, "[data-debug-id=\"vault-user-only-toggle\"]", false, "ui:vault-owned-secret-metadata-visible"],
    ["vault-request-center-item", "src/components/HeaderVaultRequestCenter.tsx", 6, 201, "[data-debug-id=\"vault-request-center-item\"]", false, "ui:owned-vault-agent-request-visible"],
    ["vault-request-action-*", "src/components/HeaderVaultRequestCenter.tsx", 8, 236, "[data-debug-id^=\"vault-request-action-\"]", true, "ui:owned-vault-agent-request-visible"],
    ["vault-request-action-*", "src/components/HeaderVaultRequestCenter.tsx", 9, 245, "[data-debug-id^=\"vault-request-action-\"]", true, "ui:owned-vault-agent-request-visible"],
    ["shellx-vault-grant-row", "src/components/settings/VaultGrantsPanel.tsx", 2, 54, "[data-debug-id=\"shellx-vault-grant-row\"]", false, "ui:owned-vault-grant-row-visible"],
    ["surface-components-settings-vaulttab-18", "src/components/settings/VaultTab.tsx", 14, 1238, "[data-debug-id=\"surface-components-settings-vaulttab-18\"]", false, "ui:vault-owned-secret-metadata-visible"],
    ["surface-components-settings-vaulttab-22", "src/components/settings/VaultTab.tsx", 15, 1285, "[data-debug-id=\"surface-components-settings-vaulttab-22\"]", false, "ui:vault-owned-secret-replace-visible"],
    ["shellx-vault-configured-summary", "src/components/settings/VaultSetupPanel.tsx", 3, 237, "[data-debug-id=\"shellx-vault-configured-summary\"]", false, "ui:vault-configured-unlocked-visible"],
    ["shellx-vault-remember-passphrase", "src/components/settings/VaultSetupPanel.tsx", 9, 300, "[data-debug-id=\"shellx-vault-remember-passphrase\"]", false, "ui:vault-configured-unlocked-visible"],
    ["shellx-vault-remember-device-enable", "src/components/settings/VaultSetupPanel.tsx", 10, 311, "[data-debug-id=\"shellx-vault-remember-device-enable\"]", false, "ui:vault-configured-unlocked-visible"],
    ["shellx-vault-change-setup", "src/components/settings/VaultSetupPanel.tsx", 11, 324, "[data-debug-id=\"shellx-vault-change-setup\"]", false, "ui:vault-configured-unlocked-visible"],
    ["vault-workspace-lock", "src/components/VaultPanel.tsx", 4, 167, "[data-debug-id=\"vault-workspace-lock\"]", false, "ui:vault-configured-unlocked-visible"],
    ["shellx-vault-unlock-form", "src/components/settings/VaultSetupPanel.tsx", 4, 247, "[data-debug-id=\"shellx-vault-unlock-form\"]", false, "ui:vault-configured-locked-visible"],
    ["shellx-vault-unlock-passphrase", "src/components/settings/VaultSetupPanel.tsx", 5, 256, "[data-debug-id=\"shellx-vault-unlock-passphrase\"]", false, "ui:vault-configured-locked-visible"],
    ["shellx-vault-unlock", "src/components/settings/VaultSetupPanel.tsx", 6, 267, "[data-debug-id=\"shellx-vault-unlock\"]", false, "ui:vault-configured-locked-visible"],
    ["shellx-vault-remember-device-unlock", "src/components/settings/VaultSetupPanel.tsx", 7, 275, "[data-debug-id=\"shellx-vault-remember-device-unlock\"]", false, "ui:vault-configured-locked-visible"],
    ["vault-workspace-quick-unlock", "src/components/VaultPanel.tsx", 5, 179, "[data-debug-id=\"vault-workspace-quick-unlock\"]", false, "ui:vault-configured-locked-visible"],
    ["surface-components-vaultpanel-5", "src/components/VaultPanel.tsx", 6, 194, "[data-debug-id=\"surface-components-vaultpanel-5\"]", false, "ui:vault-configured-locked-visible"],
    ["shellx-vault-forget-device", "src/components/settings/VaultSetupPanel.tsx", 8, 289, "[data-debug-id=\"shellx-vault-forget-device\"]", false, "ui:vault-configured-remembered-visible"],
    ["shellx-browser-clear-history", "src/browser/components/BrowserHistorySidecar.tsx", 8, 137, "[data-debug-id=\"shellx-browser-clear-history\"]", false, "ui:browser-history-owned-task"],
    ["shellx-browser-history-entry-*", "src/browser/components/BrowserHistorySidecar.tsx", 9, 150, "[data-debug-id^=\"shellx-browser-history-entry-\"]", true, "ui:browser-history-owned-task"],
    ["shellx-browser-error", "src/components/ShellxBrowserApp.tsx", 1, 798, "[data-debug-id=\"shellx-browser-error\"]", false, "ui:browser-workflow-preview-error-owned"],
    ["shellx-browser-workflow-preview", "src/browser/components/BookmarkSidecar.tsx", 15, 335, "[data-debug-id=\"shellx-browser-workflow-preview\"]", false, "ui:browser-workflow-preview-error-owned"],
    ["surface-components-findpopover-3", "src/components/FindPopover.tsx", 3, 432, "[data-debug-id=\"surface-components-findpopover-3\"]", false, "ui:find-open-row-visible"],
    ["surface-components-findpopover-4", "src/components/FindPopover.tsx", 4, 452, "[data-debug-id=\"surface-components-findpopover-4\"]", false, "ui:find-disk-row-visible"],
    ["surface-components-filepreviewmodal-1", "src/components/FilePreviewModal.tsx", 1, 127, "[data-debug-id=\"surface-components-filepreviewmodal-1\"]", false, "ui:file-preview-visible"],
    ["surface-components-attachmentmediaboard-9", "src/components/AttachmentMediaBoard.tsx", 2, 153, "[data-debug-id=\"surface-components-attachmentmediaboard-9\"]", false, "ui:owned-pending-attachment-visible"],
    ["surface-components-mediapreview-1", "src/components/MediaPreview.tsx", 1, 87, "[data-debug-id=\"surface-components-mediapreview-1\"]", false, "ui:owned-video-preview-visible"],
    ["surface-lib-markdown-links-1", "src/lib/markdown-links.tsx", 1, 205, "[data-debug-id=\"surface-lib-markdown-links-1\"]", false, "ui:owned-markdown-preview-links-visible"],
    ["surface-lib-markdown-links-2", "src/lib/markdown-links.tsx", 2, 218, "[data-debug-id=\"surface-lib-markdown-links-2\"]", false, "ui:owned-markdown-preview-links-visible"],
    ["left-add-project", "src/components/LeftRail.tsx", 2, 349, "[data-debug-id=\"left-add-project\"]", false, "ui:app-shell-visible"],
    ["left-project-row", "src/components/LeftRail.tsx", 3, 367, "[data-debug-id=\"left-project-row\"]", false, "ui:owned-project-draft-visible"],
    ["surface-components-leftrail-3", "src/components/LeftRail.tsx", 4, 395, "[data-debug-id=\"surface-components-leftrail-3\"]", false, "ui:owned-project-draft-visible"],
    ["left-project-rename-input", "src/components/LeftRail.tsx", 5, 411, "[data-debug-id=\"left-project-rename-input\"]", false, "ui:owned-project-draft-visible"],
    ["left-past-chats-toggle", "src/components/LeftRail.tsx", 6, 733, "[data-debug-id=\"left-past-chats-toggle\"]", false, "ui:owned-past-chat-visible"],
    ["left-past-chat-row", "src/components/LeftRail.tsx", 7, 771, "[data-debug-id=\"left-past-chat-row\"]", false, "ui:owned-past-chat-visible"],
    ["left-chat-rename-input", "src/components/LeftRail.tsx", 8, 796, "[data-debug-id=\"left-chat-rename-input\"]", false, "ui:owned-past-chat-rename-visible"],
    ["remote-cwd-parent", "src/App.tsx", 6, 6403, "[data-debug-id=\"remote-cwd-parent\"]", false, "ui:owned-remote-cwd-empty-visible"],
    ["remote-cwd-parent", "src/App.tsx", 7, 6435, "[data-debug-id=\"remote-cwd-parent\"]", false, "ui:owned-remote-cwd-folder-visible"],
    ["remote-cwd-folder", "src/App.tsx", 8, 6464, "[data-debug-id=\"remote-cwd-folder\"]", false, "ui:owned-remote-cwd-folder-visible"],
    ["surface-components-leftrail-15", "src/components/LeftRail.tsx", 9, 915, "[data-debug-id=\"surface-components-leftrail-15\"]", false, "ui:owned-open-chat-context-menu-visible"],
    ["surface-components-leftrail-17", "src/components/LeftRail.tsx", 10, 968, "[data-debug-id=\"surface-components-leftrail-17\"]", false, "ui:owned-past-chat-context-menu-visible"],
    ["surface-components-branchpicker-1", "src/components/BranchPicker.tsx", 1, 174, "[data-debug-id=\"surface-components-branchpicker-1\"]", false, "ui:owned-branch-picker-row-visible"],
    ["surface-components-connectionpicker-3", "src/components/ConnectionPicker.tsx", 1, 363, "[data-debug-id=\"surface-components-connectionpicker-3\"]", false, "ui:owned-connection-picker-row-visible"],
    ["connection-agent-cli-setup-open", "src/components/ConnectionEditor.tsx", 13, 521, "[data-debug-id=\"connection-agent-cli-setup-open\"]", false, "ui:owned-connection-editor-scanned-visible"],
    ["surface-components-bottompanel-23", "src/components/BottomPanel.tsx", 21, 1841, "[data-debug-id=\"surface-components-bottompanel-23\"]", false, "ui:owned-agent-picker-row-visible"],
    ["surface-components-bottompanel-24", "src/components/BottomPanel.tsx", 22, 1910, "[data-debug-id=\"surface-components-bottompanel-24\"]", false, "ui:owned-slash-command-row-visible"],
    ["surface-components-filespane-7", "src/components/FilesPane.tsx", 2, 213, "[data-debug-id=\"surface-components-filespane-7\"]", false, "ui:owned-files-pane-row-visible"],
    ["surface-components-leftrail-19", "src/components/LeftRail.tsx", 11, 999, "[data-debug-id=\"surface-components-leftrail-19\"]", false, "ui:owned-project-delete-dialog-visible"],
    ["surface-components-leftrail-20", "src/components/LeftRail.tsx", 12, 1003, "[data-debug-id=\"surface-components-leftrail-20\"]", false, "ui:owned-project-delete-dialog-visible"],
    ["surface-components-chatoutput-3", "src/components/ChatOutput.tsx", 2, 533, "[data-debug-id=\"surface-components-chatoutput-3\"]", false, "ui:owned-renderer-event-chat-visible"],
    ["surface-components-chatoutput-4", "src/components/ChatOutput.tsx", 3, 897, "[data-debug-id=\"surface-components-chatoutput-4\"]", false, "ui:owned-renderer-event-chat-visible"],
    ["surface-components-chatoutput-5", "src/components/ChatOutput.tsx", 4, 954, "[data-debug-id=\"surface-components-chatoutput-5\"]", false, "ui:owned-renderer-event-chat-visible"],
    ["surface-components-permissionpill-1", "src/components/PermissionPill.tsx", 1, 153, "[data-debug-id=\"surface-components-permissionpill-1\"]", false, "ui:owned-renderer-event-chat-visible"],
    ["surface-components-permissionpill-3", "src/components/PermissionPill.tsx", 2, 170, "[data-debug-id=\"surface-components-permissionpill-3\"]", false, "ui:owned-renderer-event-chat-visible"],
    ["surface-components-attachmentmediaboard-12", "src/components/AttachmentMediaBoard.tsx", 3, 201, "[data-debug-id=\"surface-components-attachmentmediaboard-12\"]", false, "ui:owned-renderer-event-assets-visible"],
    ["surface-components-attachmentmediaboard-14", "src/components/AttachmentMediaBoard.tsx", 4, 240, "[data-debug-id=\"surface-components-attachmentmediaboard-14\"]", false, "ui:owned-renderer-event-assets-visible"],
    ["surface-components-attachmentmediaboard-18", "src/components/AttachmentMediaBoard.tsx", 5, 300, "[data-debug-id=\"surface-components-attachmentmediaboard-18\"]", false, "ui:owned-renderer-event-assets-visible"],
    ["surface-components-attachmentmediaboard-19", "src/components/AttachmentMediaBoard.tsx", 6, 333, "[data-debug-id=\"surface-components-attachmentmediaboard-19\"]", false, "ui:owned-renderer-event-assets-visible"],
    ["debug-api-disconnected", "src/components/DebugApiConnectionBanner.tsx", 1, 15, "[data-debug-id=\"debug-api-disconnected\"]", false, "ui:debug-api-disconnected-banner-visible"],
    ["debug-api-retry", "src/components/DebugApiConnectionBanner.tsx", 2, 20, "[data-debug-id=\"debug-api-retry\"]", false, "ui:debug-api-disconnected-banner-visible"],
    ["surface-components-hashautocomplete-1", "src/components/HashAutocomplete.tsx", 1, 96, "[data-debug-id=\"surface-components-hashautocomplete-1\"]", false, "ui:owned-hash-autocomplete-row-visible"],
    ["surface-components-bottompanel-9", "src/components/BottomPanel.tsx", 9, 655, "[data-debug-id=\"surface-components-bottompanel-9\"]", false, "ui:owned-renderer-event-image-visible"],
    ["surface-components-buildplanreviewmodal-1", "src/components/BuildPlanReviewModal.tsx", 1, 290, "[data-debug-id=\"surface-components-buildplanreviewmodal-1\"]", false, "ui:build-plan-review-owned-ready-visible"],
    ["surface-components-buildplanreviewmodal-4", "src/components/BuildPlanReviewModal.tsx", 2, 359, "[data-debug-id=\"surface-components-buildplanreviewmodal-4\"]", false, "ui:build-plan-review-owned-ready-visible"],
    ["surface-components-buildplanreviewmodal-5", "src/components/BuildPlanReviewModal.tsx", 3, 367, "[data-debug-id=\"surface-components-buildplanreviewmodal-5\"]", false, "ui:build-plan-review-owned-ready-visible"],
    ["plugins-entry-toggle", "src/components/PluginsModal.tsx", 3, 489, "[data-debug-id=\"plugins-entry-toggle\"]", false, "ui:plugins-owned-marketplace-visible"],
    ["plugins-vault-key-input", "src/components/PluginsModal.tsx", 6, 599, "[data-debug-id=\"plugins-vault-key-input\"]", false, "ui:plugins-owned-key-form-visible"],
    ["surface-components-pluginsmodal-10", "src/components/PluginsModal.tsx", 4, 541, "[data-debug-id=\"surface-components-pluginsmodal-10\"]", false, "ui:plugins-owned-marketplace-visible"],
    ["surface-components-pluginsmodal-11", "src/components/PluginsModal.tsx", 5, 549, "[data-debug-id=\"surface-components-pluginsmodal-11\"]", false, "ui:plugins-owned-marketplace-visible"],
    ["surface-components-pluginsmodal-13", "src/components/PluginsModal.tsx", 7, 617, "[data-debug-id=\"surface-components-pluginsmodal-13\"]", false, "ui:plugins-owned-key-form-visible"],
  ] as const;
  return rows.map(([name, source, occurrence, line, selector, dynamicSelector, fixtureId]) => assignment({
    ...common,
    id: `ui-debug-surface:${name}@${source}#${occurrence}`,
    name,
    source,
    selector,
    line,
    occurrence,
    driverFamily: dynamicSelector ? "dynamic-marker" : "static-marker",
    dynamicSelector,
  }, fixtureId));
}

function assignment(
  surface: ReleaseSurfaceDriverRequest["assignments"][number]["surface"],
  fixtureId: string,
): ReleaseSurfaceDriverRequest["assignments"][number] {
  return {
    surface,
    fixtureId,
    expectedEffect: `${surface.name} resolves visibly without control activation`,
    oracleId: RELEASE_UI_DEBUG_ORACLE_ID,
    cleanupId: releaseUiDebugCleanupIdForFixture(fixtureId),
  };
}

async function waitForPort(path: string, child: ChildProcess): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited ${child.exitCode}`);
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { port?: number };
      if (Number.isSafeInteger(value.port) && Number(value.port) > 0) return Number(value.port);
    } catch {
      // The fixture writes its bound port after listen completes.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("fixture server did not report its port");
}

async function getJson<T>(url: string, authToken: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return await response.json() as T;
}
